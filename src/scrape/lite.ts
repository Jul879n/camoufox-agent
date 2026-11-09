import { renderViaCdp } from "./cdp.js";
import { findChrome } from "./chrome-path.js";
import { scrapeCore, type BrowserTiers, type ScrapeOptions } from "./core.js";
import type { ScrapeResult } from "./extract.js";

export type { ScrapeEngine, ScrapeResult } from "./extract.js";
export type { ScrapeOptions } from "./core.js";

// Dependency-free build: HTTP tier plus the user's own Chrome over raw CDP. No Playwright, no Camoufox.
// Anti-bot walls that need Camoufox are delegated to a running `camoufox-agent serve` when there is one.
const tiers: BrowserTiers = {
  available: (tier) => {
    if (tier === "camoufox") return "the Camoufox tier needs camoufox-agent serve (use useServer) or the full camoufox-agent package";
    return findChrome() ? undefined : "no Chromium browser found; set CAMOUFOX_AGENT_CHROME";
  },
  render: (tier, url, timeoutMs, options) => {
    if (tier !== "chrome") return Promise.reject(new Error("camoufox tier unavailable in the lite build"));
    return renderViaCdp(url, timeoutMs, options);
  },
};

export function scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  return scrapeCore(url, opts, async () => tiers);
}
