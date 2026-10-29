import fs from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import { DEFAULT_WAIT_STRATEGY } from "./config.js";
import { runBrowserOperation } from "./browser-runtime.js";
import { attachCollector, summarizeNetwork, type RichCollector } from "./diagnose/collector.js";
import { readPerf, type PerfReport } from "./diagnose/perf.js";
import { runAudit } from "./diagnose/audit.js";
import { inspectElement } from "./diagnose/inspect.js";
import { uniqueExportPath } from "./files.js";
import type { DiagnoseToolInput, InspectToolInput, NetworkRequestToolInput, SessionNetworkToolInput, StorageToolInput, SessionTraceToolInput } from "./schema/tools.js";
import { buildSuccessContent, buildToolError, buildToolFailure } from "./responses.js";
import { getSession, runSessionExclusive, sessionSanitizedError } from "./sessions.js";
import type { NetworkControl, SessionRecord } from "./types.js";
import { redactDeep, redactUrl } from "./utils.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ALL_SECTIONS = ["console", "network", "perf", "audit"] as const;

const BUDGET_SECTIONS: Record<string, (typeof ALL_SECTIONS)[number]> = {
  maxLoadMs: "perf", maxFcpMs: "perf", maxLcpMs: "perf", maxTtfbMs: "perf", maxTbtMs: "perf", maxDomNodes: "perf",
  maxRequests: "network", maxTotalBytes: "network", maxFailedRequests: "network", maxConsoleErrors: "console",
};

type Budgets = NonNullable<DiagnoseToolInput["budgets"]>;
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

interface BudgetReport {
  perf?: PerfReport;
  network?: { requests?: number; totalBytes?: number; failed?: unknown[]; httpErrors?: unknown[] };
  console?: { counts?: Record<string, number>; uncaughtErrors?: unknown[] };
}

export function evaluateBudgets(report: BudgetReport, budgets: Budgets) {
  const perf = report.perf;
  const network = report.network;
  const consoleReport = report.console;
  const actuals: Record<keyof Budgets, number | null> = {
    maxLoadMs: num(perf?.navigation?.loadMs),
    maxFcpMs: num(perf?.vitals?.fcpMs),
    maxLcpMs: num(perf?.vitals?.lcp?.timeMs),
    maxTtfbMs: num(perf?.navigation?.ttfbMs),
    maxTbtMs: num(perf?.tbtApproxMs),
    maxDomNodes: num(perf?.dom?.nodes),
    maxRequests: num(network?.requests),
    maxTotalBytes: num(network?.totalBytes),
    maxConsoleErrors: consoleReport ? (consoleReport.counts?.error ?? 0) + (consoleReport.uncaughtErrors?.length ?? 0) : null,
    maxFailedRequests: network ? (network.failed?.length ?? 0) + (network.httpErrors?.length ?? 0) : null,
  };
  const results = (Object.keys(budgets) as Array<keyof Budgets>).filter((metric) => budgets[metric] !== undefined).map((metric) => {
    const limit = budgets[metric] as number;
    const actual = actuals[metric];
    return { metric, limit, actual, ok: actual === null ? null : actual <= limit };
  });
  return { passed: results.every((result) => result.ok !== false), results };
}

export async function buildReport(page: Page, context: BrowserContext, collector: RichCollector, input: Pick<DiagnoseToolInput, "sections" | "maxEntries" | "budgets">) {
  const sections = new Set<string>(input.sections ?? ALL_SECTIONS);
  if (input.sections) for (const metric of Object.keys(input.budgets ?? {})) if (BUDGET_SECTIONS[metric]) sections.add(BUDGET_SECTIONS[metric]);
  const max = input.maxEntries ?? 100;
  const data = collector.data();
  const report: Record<string, unknown> = { url: redactUrl(page.url()), title: await page.title().catch(() => undefined) };

  if (sections.has("console")) {
    const counts: Record<string, number> = {};
    for (const entry of data.console) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    report.console = {
      counts,
      uncaughtErrors: data.pageErrors.slice(0, max),
      entries: data.console.filter((entry) => entry.type !== "log" && entry.type !== "debug").slice(0, max),
      logs: data.console.filter((entry) => entry.type === "log" || entry.type === "debug").slice(0, Math.min(max, 30)),
      dialogs: data.dialogs,
      truncated: data.truncated.console,
    };
  }
  if (sections.has("network")) {
    const summary = summarizeNetwork(data.network);
    report.network = {
      requests: summary.requests,
      totalBytes: summary.totalBytes,
      byType: summary.byType,
      failed: summary.failed.slice(0, max),
      httpErrors: summary.httpErrors.slice(0, max),
      redirects: summary.redirects.slice(0, max),
      slowest: summary.slowest,
      largest: summary.largest,
      uncompressedText: summary.uncompressed.slice(0, 20),
      missingCacheHeaders: summary.noCacheHeaders.slice(0, 20),
      entries: data.network.slice(0, max),
      websockets: data.websockets,
      truncated: data.truncated.network,
    };
  }
  if (sections.has("perf")) report.perf = await readPerf(page, max);
  if (sections.has("audit")) report.audit = await runAudit(page, context, data.network, collector.mainResponseHeaders());
  if (input.budgets) report.budgets = evaluateBudgets(report, input.budgets);
  return report;
}

function finish(report: Record<string, unknown>, saveAs?: string) {
  if (saveAs) {
    const file = uniqueExportPath(saveAs);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    report.savedPath = file;
  }
  return buildSuccessContent(report);
}

export async function handleDiagnose(input: DiagnoseToolInput) {
  if (Boolean(input.url) === Boolean(input.sessionId)) return buildToolError("Provide exactly one of url or sessionId");
  const settle = input.settleMs ?? 1500;

  if (input.sessionId) {
    let session: SessionRecord | undefined;
    try {
      session = await getSession(input.sessionId);
      const current = session;
      return await runSessionExclusive(current, async () => {
        const collector = current.rich;
        if (!collector) throw new Error("Session has no diagnostics collector");
        if (input.reload) {
          collector.reset();
          await current.page.reload({ waitUntil: current.waitStrategy });
        }
        await current.page.waitForLoadState("load").catch(() => undefined);
        await sleep(settle);
        return finish({ sessionId: current.id, ...await buildReport(current.page, current.context, collector, input) }, input.saveAs);
      });
    } catch (error) {
      return buildToolError(`Failed to diagnose session. Error: ${sessionSanitizedError(error, session)}`);
    }
  }

  const url = input.url as string;
  let collector: RichCollector | undefined;
  try {
    return await runBrowserOperation("browse diagnose", {
      ...input,
      url,
      setup: async (context) => { collector = await attachCollector(context, () => ({ rawUrls: [url], secrets: [] })); },
    }, async ({ page, requestGuard }) => {
      await page.waitForLoadState(input.waitStrategy ?? DEFAULT_WAIT_STRATEGY).catch(() => undefined);
      await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
      await sleep(settle);
      requestGuard.assertAllowed();
      return finish(await buildReport(page, page.context(), collector as RichCollector, input), input.saveAs);
    });
  } catch (error) {
    return buildToolFailure("browse diagnose", redactUrl(url), error, { ...input, url });
  }
}

export async function handleInspect(input: InspectToolInput) {
  if (Boolean(input.url) === Boolean(input.sessionId)) return buildToolError("Provide exactly one of url or sessionId");
  const options = { frame: input.frame, properties: input.properties, maxRules: input.maxRules ?? 30, timeout: 10000 };

  if (input.sessionId) {
    let session: SessionRecord | undefined;
    try {
      session = await getSession(input.sessionId);
      const current = session;
      return await runSessionExclusive(current, async () => buildSuccessContent(await inspectElement(current.page, input.selector, options)));
    } catch (error) {
      return buildToolError(`Failed to inspect in session. Error: ${sessionSanitizedError(error, session)}`);
    }
  }

  const url = input.url as string;
  try {
    return await runBrowserOperation("browse inspect", { ...input, url }, async ({ page, requestGuard }) => {
      const result = await inspectElement(page, input.selector, options);
      requestGuard.assertAllowed();
      return buildSuccessContent(result);
    });
  } catch (error) {
    return buildToolFailure("browse inspect", redactUrl(url), error, { ...input, url });
  }
}

export async function handleSessionTrace(input: SessionTraceToolInput) {
  let session: SessionRecord | undefined;
  try {
    session = await getSession(input.sessionId);
    const current = session;
    return await runSessionExclusive(current, async () => {
      if (input.action === "start") {
        if (current.tracing) throw new Error("Trace already running");
        await current.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        current.tracing = true;
        return buildSuccessContent({ sessionId: current.id, tracing: true });
      }
      if (!current.tracing) throw new Error("No trace running");
      if (!input.saveAs) throw new Error("saveAs (.zip) is required on stop");
      const file = uniqueExportPath(input.saveAs);
      await current.context.tracing.stop({ path: file });
      current.tracing = false;
      return buildSuccessContent({ sessionId: current.id, tracing: false, savedPath: file });
    });
  } catch (error) {
    return buildToolError(`Failed to run trace action. Error: ${sessionSanitizedError(error, session)}`);
  }
}

const TEXT_BODY = /^(text\/|application\/(json|javascript|x-javascript|xml|xhtml\+xml)|.*\+(json|xml))/i;
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
const maskHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value]));

export async function handleNetworkRequest(input: NetworkRequestToolInput) {
  let session: SessionRecord | undefined;
  try {
    session = await getSession(input.sessionId);
    const current = session;
    return await runSessionExclusive(current, async () => {
      const request = current.rich?.requestById(input.id);
      if (!request) throw new Error(`Request ${input.id} not found (only the last 200 are kept)`);
      const response = await request.response().catch(() => null);
      const timing = request.timing();
      const payload: Record<string, unknown> = {
        id: input.id,
        request: {
          method: request.method(),
          url: redactUrl(request.url()),
          resourceType: request.resourceType(),
          headers: maskHeaders(await request.allHeaders()),
          postData: request.postData() ?? undefined,
        },
        response: null,
        timing,
      };
      if (!response) {
        payload.failure = request.failure()?.errorText ?? "no response";
      } else {
        const headers = await response.allHeaders();
        payload.response = { status: response.status(), statusText: response.statusText(), headers: maskHeaders(headers) };
        if (input.includeBody) {
          const body = await response.body().catch((bodyError) => { payload.bodyError = String(bodyError?.message ?? bodyError); return null; });
          if (body) {
            const max = input.maxBodyBytes ?? 100000;
            const slice = body.subarray(0, max);
            payload.truncated = body.length > max;
            if (TEXT_BODY.test(headers["content-type"] ?? "")) payload.body = slice.toString("utf8");
            else payload.bodyBase64 = slice.toString("base64");
          }
        }
      }
      return buildSuccessContent(redactDeep(payload, current.secrets));
    });
  } catch (error) {
    return buildToolError(`Failed to read request. Error: ${sessionSanitizedError(error, session)}`);
  }
}

export async function handleSessionNetwork(input: SessionNetworkToolInput) {
  let session: SessionRecord | undefined;
  try {
    session = await getSession(input.sessionId);
    const current = session;
    return await runSessionExclusive(current, async () => {
      if (!current.network) throw new Error("Session has no network control");
      await current.network.set(input.network as NetworkControl);
      return buildSuccessContent({ sessionId: current.id, network: current.network.current() });
    });
  } catch (error) {
    return buildToolError(`Failed to set network control. Error: ${sessionSanitizedError(error, session)}`);
  }
}

const MAX_VALUE_CHARS = 200;
const ALL_STORAGE = ["cookies", "localStorage", "sessionStorage", "indexedDB", "serviceWorkers"] as const;

export async function handleStorage(input: StorageToolInput) {
  let session: SessionRecord | undefined;
  try {
    session = await getSession(input.sessionId);
    const current = session;
    return await runSessionExclusive(current, async () => {
      const { page, context } = current;
      const withValues = input.includeValues ?? false;
      const shown = (value: string) => (withValues ? { value: value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value } : {});
      const result: Record<string, unknown> = { sessionId: current.id, url: redactUrl(page.url()) };
      const unsupported = (kind: string, error: unknown) => ({ kind, unsupported: error instanceof Error ? error.message : String(error) });

      for (const kind of input.kinds ?? ALL_STORAGE) {
        try {
          if (kind === "cookies") {
            result.cookies = (await context.cookies()).map((c) => ({
              name: c.name, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expires, valueLength: c.value.length, ...shown(c.value),
            }));
          } else if (kind === "localStorage" || kind === "sessionStorage") {
            const entries = await page.evaluate((store) => {
              const area = store === "localStorage" ? window.localStorage : window.sessionStorage;
              return Object.keys(area).map((key) => ({ key, value: area.getItem(key) ?? "" }));
            }, kind);
            result[kind] = { origin: new URL(page.url()).origin, entries: entries.map((e) => ({ key: e.key, valueLength: e.value.length, ...shown(e.value) })) };
          } else if (kind === "indexedDB") {
            result.indexedDB = await page.evaluate(async () => (await indexedDB.databases()).map((db) => ({ name: db.name, version: db.version })));
          } else {
            const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, active: r.active?.state ?? null })));
            result.serviceWorkers = { registrations, workers: page.workers().map((w) => ({ url: redactUrl(w.url()) })) };
          }
        } catch (error) {
          result[kind] = unsupported(kind, error);
        }
      }
      return buildSuccessContent(redactDeep(result, current.secrets));
    });
  } catch (error) {
    return buildToolError(`Failed to read storage. Error: ${sessionSanitizedError(error, session)}`);
  }
}
