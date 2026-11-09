import { extractPage, type ScrapeEngine, type ScrapeResult } from "./extract.js";
import { readHint, writeHint } from "./tier-cache.js";
import { fetchHttp, isBlocked, isChallengeRender, needsBrowser } from "./http.js";

export type { ScrapeEngine, ScrapeResult } from "./extract.js";

export interface ScrapeOptions {
  engine?: "auto" | ScrapeEngine;
  full?: boolean;
  timeoutMs?: number;
  useServer?: boolean;
  fast?: boolean;
  /** Skip the HTTP tier (used when the caller already ran it, e.g. delegation to `serve`). */
  browserOnly?: boolean;
}

function markBlocked(result: ScrapeResult, status: number | null, html: string): ScrapeResult {
  if (status !== null && isBlocked(status, html)) {
    result.success = false;
    result.error_message = result.error_message ?? "blocked by anti-bot challenge; use browse_session_* to hand over to a human";
  }
  return result;
}

function failure(url: string, engine: ScrapeEngine, message: string): ScrapeResult {
  const result = extractPage("", url, null, engine);
  result.error_message = message;
  return result;
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function delegate(url: string, engine: string, opts: Required<Pick<ScrapeOptions, "full" | "timeoutMs" | "fast">>): Promise<ScrapeResult | undefined> {
  const base = `http://127.0.0.1:${process.env.CAMOUFOX_AGENT_PORT ?? 9420}`;
  const token = process.env.CAMOUFOX_AGENT_TOKEN;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) });
    if (!health.ok) return undefined;
    const response = await fetch(`${base}/api/tools/browse_scrape`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ url, engine, full: opts.full, timeoutMs: opts.timeoutMs, fast: opts.fast, browserOnly: true }),
      signal: AbortSignal.timeout(opts.timeoutMs + 5000),
    });
    if (response.status !== 200) return undefined;
    return (await response.json()) as ScrapeResult;
  } catch {
    return undefined;
  }
}

export interface RenderResult { status: number | null; html: string; finalUrl: string; blocked: boolean; captcha: boolean }

/** Browser tiers a build can offer. The full package uses Playwright/Camoufox; the lite build speaks CDP to the user's Chrome. */
export interface BrowserTiers {
  available(tier: "chrome" | "camoufox"): string | undefined;
  render(tier: "chrome" | "camoufox", url: string, timeoutMs: number, options: { fast?: boolean }): Promise<RenderResult>;
}

export async function scrapeCore(url: string, opts: ScrapeOptions, loadTiers: () => Promise<BrowserTiers>): Promise<ScrapeResult> {
  const engine = opts.engine ?? "auto";
  const full = opts.full ?? false;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const fast = opts.fast ?? false;
  const useServer = opts.useServer ?? true;

  const hint = engine === "auto" ? readHint(url) : undefined;
  let http: { status: number; html: string; finalUrl: string } | undefined;
  let httpError: string | undefined;
  if (!opts.browserOnly && !hint && (engine === "auto" || engine === "http")) {
    try {
      http = await fetchHttp(url, timeoutMs);
    } catch (error) {
      httpError = describe(error);
    }
    if (engine === "http") {
      return http ? markBlocked(extractPage(http.html, http.finalUrl, http.status, "http", full), http.status, http.html) : failure(url, "http", httpError ?? "request failed");
    }
    if (http && !needsBrowser(http.status, http.html)) {
      if (engine === "auto" && http.status < 400) writeHint(url, undefined);
      return extractPage(http.html, http.finalUrl, http.status, "http", full);
    }
  }

  const target = http?.finalUrl ?? url;
  const fallback = (message: string): ScrapeResult => {
    if (http) {
      const result = extractPage(http.html, http.finalUrl, http.status, "http", full);
      result.error_message = message;
      return result;
    }
    return failure(url, "http", `${httpError ? `${httpError}; ` : ""}${message}`);
  };

  if (useServer) {
    const remote = await delegate(target, engine, { full, timeoutMs, fast });
    if (remote) return remote;
  }

  const tiersApi = await loadTiers();
  const tiers: ("chrome" | "camoufox")[] = engine === "chrome" ? ["chrome"] : engine === "camoufox" ? ["camoufox"] : hint === "camoufox" ? ["camoufox"] : ["chrome", "camoufox"];
  let lastError: string | undefined;
  let best: ScrapeResult | undefined;
  for (const tier of tiers) {
    const unavailable = tiersApi.available(tier);
    if (unavailable) {
      lastError = unavailable;
      continue;
    }
    try {
      const rendered = await withDeadline(tiersApi.render(tier, target, timeoutMs, { fast }), timeoutMs + 15000, `${tier} render`);
      const result = extractPage(rendered.html, rendered.finalUrl, rendered.status, tier, full);
      const hardBlock = isChallengeRender(rendered.status, rendered.html);
      if (engine === "auto" && tier === "chrome" && rendered.blocked) {
        best = result;
        continue;
      }
      if (hardBlock) {
        result.success = false;
        result.error_message = "blocked by anti-bot challenge; use browse_session_* to hand over to a human";
      } else if (rendered.captcha) {
        result.error_message = "challenge detected on page";
      }
      if (engine === "auto" && result.success) writeHint(url, tier);
      return result;
    } catch (error) {
      lastError = `${tier} failed: ${describe(error)}`;
      if (tier === "camoufox" && /camoufox.*(not|missing)|browser binary/i.test(String(error))) lastError = describe(error);
    }
  }
  if (best) return best;
  return fallback(lastError ?? "browser tier not available");
}
