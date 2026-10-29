import fs from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import { DEFAULT_WAIT_STRATEGY } from "./config.js";
import { runBrowserOperation } from "./browser-runtime.js";
import { attachCollector, summarizeNetwork, type RichCollector } from "./diagnose/collector.js";
import { readPerf } from "./diagnose/perf.js";
import { runAudit } from "./diagnose/audit.js";
import { inspectElement } from "./diagnose/inspect.js";
import { uniqueExportPath } from "./files.js";
import type { DiagnoseToolInput, InspectToolInput, SessionTraceToolInput } from "./schema/tools.js";
import { buildSuccessContent, buildToolError, buildToolFailure } from "./responses.js";
import { getSession, runSessionExclusive, sessionSanitizedError } from "./sessions.js";
import type { SessionRecord } from "./types.js";
import { redactUrl } from "./utils.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ALL_SECTIONS = ["console", "network", "perf", "audit"] as const;

async function buildReport(page: Page, context: BrowserContext, collector: RichCollector, input: DiagnoseToolInput) {
  const sections = new Set(input.sections ?? ALL_SECTIONS);
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
      truncated: data.truncated.network,
    };
  }
  if (sections.has("perf")) report.perf = await readPerf(page);
  if (sections.has("audit")) report.audit = await runAudit(page, context, data.network, collector.mainResponseHeaders());
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
