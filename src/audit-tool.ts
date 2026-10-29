import fs from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import { DEFAULT_WAIT_STRATEGY } from "./config.js";
import { runBrowserOperation } from "./browser-runtime.js";
import { buildReport } from "./diagnose-tool.js";
import { attachCollector, type RichCollector } from "./diagnose/collector.js";
import { runAxe, type AxeResult, type AxeViolation } from "./diagnose/axe.js";
import { accessibilityScore, findingsScore, performanceScore, type FormFactor } from "./diagnose/scoring.js";
import { DEVICES } from "./browser-options.js";
import { uniqueExportPath } from "./files.js";
import type { AuditToolInput } from "./schema/tools.js";
import { buildSuccessContent, buildToolError, buildToolFailure } from "./responses.js";
import { getSession, runSessionExclusive, sessionSanitizedError } from "./sessions.js";
import type { SessionRecord } from "./types.js";
import { redactUrl } from "./utils.js";

type Category = "performance" | "accessibility" | "best-practices" | "seo" | "security";
const ALL: Category[] = ["performance", "accessibility", "best-practices", "seo", "security"];
const METHOD = "lighthouse-formula, Firefox metrics, CLS excluded";
const BEST_PRACTICES_CODE = /mixed|deprecated|img-size|cookie|broken-resource/;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Finding { severity: "error" | "warning" | "info"; code: string; message: string }
interface AuditReport {
  console?: { counts?: Record<string, number>; uncaughtErrors?: unknown[] };
  perf?: { vitals: { fcpMs: number | null; lcp: { timeMs: number } | null }; tbtApproxMs: number; navigation: unknown; dom: unknown };
  network?: { requests: number; totalBytes: number };
  audit?: { findings: Finding[] };
}

const IMPACT_SEVERITY: Record<string, Finding["severity"]> = { critical: "error", serious: "error", moderate: "warning", minor: "info" };

export function scoreAudit(report: AuditReport, axe: AxeResult | null, axeError: string | undefined, categories: Category[], formFactor: FormFactor) {
  const findings = report.audit?.findings ?? [];
  const consoleErrors = (report.console?.counts?.error ?? 0) + (report.console?.uncaughtErrors?.length ?? 0);
  const bestPractices: Finding[] = [
    ...findings.filter((finding) => BEST_PRACTICES_CODE.test(finding.code)),
    ...(consoleErrors ? [{ severity: "warning" as const, code: "console.errors", message: `${consoleErrors} console/uncaught error(s).` }] : []),
  ];
  const groups: Record<Exclude<Category, "performance" | "accessibility">, Finding[]> = {
    seo: findings.filter((finding) => finding.code.startsWith("seo.") || finding.code.startsWith("mobile.")),
    "best-practices": bestPractices,
    security: findings.filter((finding) => finding.code.startsWith("security.") && !BEST_PRACTICES_CODE.test(finding.code)),
  };
  const perf = report.perf;
  const metrics = {
    fcpMs: perf?.vitals.fcpMs ?? null,
    lcpMs: perf?.vitals.lcp?.timeMs ?? null,
    tbtApproxMs: perf?.tbtApproxMs ?? null,
    speedIndexApproxMs: perf?.vitals.fcpMs ?? null, // Speed Index needs a video filmstrip; FCP stands in for it.
  };
  const scores: Record<string, number | null> = {};
  let performanceDetail: unknown;
  for (const category of categories) {
    if (category === "performance") {
      const result = performanceScore({ fcp: metrics.fcpMs, lcp: metrics.lcpMs, tbt: metrics.tbtApproxMs, si: metrics.speedIndexApproxMs }, formFactor);
      scores.performance = result.score;
      performanceDetail = result.metrics;
    } else if (category === "accessibility") {
      scores.accessibility = axe ? accessibilityScore(axe.violations, axe.passedRules) : null;
    } else {
      scores[category] = findingsScore(groups[category]);
    }
  }
  const opportunities: Finding[] = [
    ...findings,
    ...(axe?.violations ?? []).map((violation: AxeViolation) => ({ severity: IMPACT_SEVERITY[violation.impact ?? "minor"] ?? "info", code: `axe.${violation.id}`, message: violation.help })),
  ].sort((a, b) => ({ error: 0, warning: 1, info: 2 })[a.severity] - ({ error: 0, warning: 1, info: 2 })[b.severity]).slice(0, 10);
  return {
    scores,
    metrics,
    performanceDetail,
    opportunities,
    accessibility: axe ? { violations: axe.violations, incomplete: axe.incomplete } : { violations: [], axeError },
    method: METHOD,
  };
}

const esc = (text: unknown): string => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

function renderHtml(result: Record<string, unknown>): string {
  const scores = result.scores as Record<string, number | null>;
  const opportunities = result.opportunities as Finding[];
  const violations = (result.accessibility as { violations: AxeViolation[] }).violations;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Audit ${esc(result.url)}</title>
<style>body{font:14px system-ui;margin:2rem auto;max-width:56rem;padding:0 1rem}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:.3rem .6rem;text-align:left}.error{color:#b00020}.warning{color:#8a5a00}</style></head><body>
<h1>Audit</h1><p>${esc(result.url)} · ${esc(result.formFactor)} · ${esc(result.method)}</p>
<table><tr><th>Category</th><th>Score</th></tr>${Object.entries(scores).map(([name, score]) => `<tr><td>${esc(name)}</td><td>${score ?? "n/a"}</td></tr>`).join("")}</table>
<h2>Metrics</h2><pre>${esc(JSON.stringify(result.metrics, null, 2))}</pre>
<h2>Opportunities</h2><ul>${opportunities.map((o) => `<li class="${esc(o.severity)}"><b>${esc(o.code)}</b> ${esc(o.message)}</li>`).join("")}</ul>
<h2>Accessibility violations</h2><ul>${violations.map((v) => `<li><b>${esc(v.id)}</b> (${esc(v.impact)}) ${esc(v.help)}<ul>${v.nodes.map((n) => `<li><code>${esc(n.target)}</code></li>`).join("")}</ul></li>`).join("") || "<li>none</li>"}</ul>
</body></html>`;
}

function finish(result: Record<string, unknown>, saveAs?: string) {
  if (saveAs) {
    const file = uniqueExportPath(saveAs);
    fs.writeFileSync(file, saveAs.endsWith(".html") ? renderHtml(result) : JSON.stringify(result, null, 2));
    result.savedPath = file;
  }
  return buildSuccessContent(result);
}

async function measure(page: Page, context: BrowserContext, collector: RichCollector, input: AuditToolInput) {
  const categories = (input.categories ?? ALL) as Category[];
  const formFactor = input.formFactor ?? "desktop";
  const report = await buildReport(page, context, collector, { sections: ["console", "network", "perf", "audit"], maxEntries: 50 }) as unknown as AuditReport & { url: string };
  let axe: AxeResult | null = null;
  let axeError: string | undefined;
  if (categories.includes("accessibility")) {
    try {
      axe = await runAxe(page);
    } catch (error) {
      axeError = error instanceof Error ? error.message : String(error);
    }
  }
  return { url: report.url, formFactor, ...scoreAudit(report, axe, axeError, categories, formFactor) };
}

export async function handleAudit(input: AuditToolInput) {
  if (Boolean(input.url) === Boolean(input.sessionId)) return buildToolError("Provide exactly one of url or sessionId");
  const settle = input.settleMs ?? 1500;
  const mobile = input.formFactor === "mobile";

  if (input.sessionId) {
    let session: SessionRecord | undefined;
    try {
      session = await getSession(input.sessionId);
      const current = session;
      return await runSessionExclusive(current, async () => {
        if (!current.rich) throw new Error("Session has no diagnostics collector");
        const previous = current.page.viewportSize();
        if (mobile) await current.page.setViewportSize({ width: DEVICES["pixel-8"].width, height: DEVICES["pixel-8"].height });
        try {
          await current.page.waitForLoadState("load").catch(() => undefined);
          await sleep(settle);
          return finish({ sessionId: current.id, ...await measure(current.page, current.context, current.rich, input) }, input.saveAs);
        } finally {
          if (mobile && previous) await current.page.setViewportSize(previous).catch(() => undefined);
        }
      });
    } catch (error) {
      return buildToolError(`Failed to audit session. Error: ${sessionSanitizedError(error, session)}`);
    }
  }

  const url = input.url as string;
  let collector: RichCollector | undefined;
  try {
    return await runBrowserOperation("browse audit", {
      ...input,
      url,
      bypassCSP: true,
      emulation: mobile ? { ...input.emulation, device: "pixel-8" } : input.emulation,
      setup: async (context) => { collector = await attachCollector(context, () => ({ rawUrls: [url], secrets: [] })); },
    }, async ({ page, requestGuard }) => {
      await page.waitForLoadState(input.waitStrategy ?? DEFAULT_WAIT_STRATEGY).catch(() => undefined);
      await page.waitForLoadState("load", { timeout: 10000 }).catch(() => undefined);
      await sleep(settle);
      requestGuard.assertAllowed();
      return finish(await measure(page, page.context(), collector as RichCollector, input), input.saveAs);
    });
  } catch (error) {
    return buildToolFailure("browse audit", redactUrl(url), error, { ...input, url });
  }
}
