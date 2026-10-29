import type { BrowserContext, Request } from "playwright-core";
import { redactUrl, sanitizeDiagnosticText } from "../utils.js";

const MAX_CONSOLE = 500;
const MAX_NETWORK = 1000;
const TEXT_TYPES = new Set(["document", "script", "stylesheet", "fetch", "xhr"]);

// Page-side observers, installed before any page script runs. Firefox only exposes
// the entry types listed in `supported`; the rest are reported as unsupported.
export const VITALS_SCRIPT = `(() => {
  if (window.__cfx) return;
  const s = window.__cfx = { lcp: null, cls: 0, longTasks: [], inp: null, supported: (PerformanceObserver.supportedEntryTypes || []).slice() };
  const watch = (type, cb, extra) => {
    try { new PerformanceObserver((list) => list.getEntries().forEach(cb)).observe(Object.assign({ type, buffered: true }, extra || {})); } catch (e) {}
  };
  watch("largest-contentful-paint", (e) => { s.lcp = { timeMs: Math.round(e.startTime), size: e.size, element: e.element ? e.element.tagName.toLowerCase() : null, url: e.url || null }; });
  watch("layout-shift", (e) => { if (!e.hadRecentInput) s.cls += e.value; });
  watch("longtask", (e) => { if (s.longTasks.length < 100) s.longTasks.push({ startMs: Math.round(e.startTime), durationMs: Math.round(e.duration) }); });
  watch("event", (e) => { if (e.interactionId) s.inp = Math.max(s.inp || 0, Math.round(e.duration)); }, { durationThreshold: 16 });
})();`;

export interface ConsoleEntry { type: string; text: string; url?: string; line?: number; column?: number; at: number }
export interface PageErrorEntry { message: string; stack?: string; at: number }
export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failed?: boolean;
  errorText?: string;
  fromServiceWorker?: boolean;
  redirectedFrom?: string;
  durationMs?: number;
  ttfbMs?: number;
  transferBytes?: number;
  headers?: Record<string, string>;
  isNavigation?: boolean;
}

export interface Redactor { rawUrls: string[]; secrets: string[] }

export interface RichCollector {
  data(): { console: ConsoleEntry[]; pageErrors: PageErrorEntry[]; network: NetworkEntry[]; truncated: { console: boolean; network: boolean } };
  mainResponseHeaders(): Record<string, string>;
  reset(): void;
}

const KEPT_HEADERS = ["cache-control", "content-encoding", "content-length", "server", "age", "etag", "expires", "vary", "content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "set-cookie"];

export async function attachCollector(context: BrowserContext, redactor: () => Redactor): Promise<RichCollector> {
  await context.addInitScript(VITALS_SCRIPT);

  let consoleLog: ConsoleEntry[] = [];
  let pageErrors: PageErrorEntry[] = [];
  let network: NetworkEntry[] = [];
  let byRequest = new WeakMap<Request, NetworkEntry>();
  let truncated = { console: false, network: false };
  let mainHeaders: Record<string, string> = {};
  const clean = (text: string): string => {
    const { rawUrls, secrets } = redactor();
    return sanitizeDiagnosticText(text, rawUrls, secrets);
  };

  context.on("console", (message) => {
    if (consoleLog.length >= MAX_CONSOLE) { truncated.console = true; return; }
    const location = message.location();
    consoleLog.push({
      type: message.type(),
      text: clean(message.text()),
      url: location.url ? redactUrl(location.url) : undefined,
      line: location.lineNumber,
      column: location.columnNumber,
      at: Date.now(),
    });
  });
  context.on("weberror", (webError) => {
    if (pageErrors.length >= MAX_CONSOLE) return;
    const error = webError.error();
    pageErrors.push({ message: clean(error.message), stack: error.stack ? clean(error.stack) : undefined, at: Date.now() });
  });

  context.on("request", (request) => {
    if (network.length >= MAX_NETWORK) { truncated.network = true; return; }
    const entry: NetworkEntry = {
      url: redactUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      isNavigation: request.isNavigationRequest() || undefined,
      redirectedFrom: request.redirectedFrom() ? redactUrl(request.redirectedFrom()?.url() ?? "") : undefined,
    };
    network.push(entry);
    byRequest.set(request, entry);
  });
  context.on("response", (response) => {
    const entry = byRequest.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    entry.statusText = response.statusText();
    entry.fromServiceWorker = response.fromServiceWorker() || undefined;
    const headers = response.headers();
    entry.mimeType = headers["content-type"];
    entry.headers = Object.fromEntries(KEPT_HEADERS.filter((name) => name in headers && name !== "set-cookie").map((name) => [name, headers[name]]));
    if (entry.isNavigation && response.request().frame().parentFrame() === null) mainHeaders = headers;
  });
  context.on("requestfinished", (request) => {
    const entry = byRequest.get(request);
    if (!entry) return;
    const timing = request.timing();
    if (timing.responseEnd >= 0) entry.durationMs = Math.round(timing.responseEnd);
    if (timing.responseStart >= 0 && timing.requestStart >= 0) entry.ttfbMs = Math.round(timing.responseStart - timing.requestStart);
    void request.sizes().then((sizes) => { entry.transferBytes = sizes.responseBodySize + sizes.responseHeadersSize; }, () => undefined);
  });
  context.on("requestfailed", (request) => {
    const entry = byRequest.get(request);
    if (!entry) return;
    entry.failed = true;
    entry.errorText = clean(request.failure()?.errorText ?? "request failed");
  });

  return {
    data: () => ({ console: consoleLog, pageErrors, network, truncated }),
    mainResponseHeaders: () => mainHeaders,
    reset() {
      consoleLog = [];
      pageErrors = [];
      network = [];
      byRequest = new WeakMap();
      truncated = { console: false, network: false };
      mainHeaders = {};
    },
  };
}

export function summarizeNetwork(entries: NetworkEntry[]) {
  const byType: Record<string, { count: number; bytes: number }> = {};
  let totalBytes = 0;
  for (const entry of entries) {
    const bucket = (byType[entry.resourceType] ??= { count: 0, bytes: 0 });
    bucket.count += 1;
    bucket.bytes += entry.transferBytes ?? 0;
    totalBytes += entry.transferBytes ?? 0;
  }
  const completed = entries.filter((entry) => entry.durationMs !== undefined);
  return {
    requests: entries.length,
    totalBytes,
    byType,
    failed: entries.filter((entry) => entry.failed),
    httpErrors: entries.filter((entry) => (entry.status ?? 0) >= 400),
    redirects: entries.filter((entry) => entry.redirectedFrom),
    slowest: [...completed].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 10),
    largest: [...entries].sort((a, b) => (b.transferBytes ?? 0) - (a.transferBytes ?? 0)).slice(0, 10),
    uncompressed: entries.filter((entry) => TEXT_TYPES.has(entry.resourceType) && (entry.transferBytes ?? 0) > 1024 && !entry.headers?.["content-encoding"] && entry.status === 200),
    noCacheHeaders: entries.filter((entry) => entry.status === 200 && ["script", "stylesheet", "image", "font"].includes(entry.resourceType) && !entry.headers?.["cache-control"] && !entry.headers?.expires),
  };
}
