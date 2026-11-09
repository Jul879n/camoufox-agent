import { scrapeCore, type BrowserTiers, type ScrapeOptions } from "./core.js";
import type { ScrapeResult } from "./extract.js";

export type { ScrapeEngine, ScrapeResult } from "./extract.js";
export type { ScrapeOptions } from "./core.js";

const MISSING_CHROME = "no Chromium browser found; set CAMOUFOX_AGENT_CHROME";

async function loadFullTiers(): Promise<BrowserTiers> {
  const { renderWith, findChrome } = await import("./browsers.js");
  return {
    available: (tier) => (tier === "chrome" && !findChrome() ? MISSING_CHROME : undefined),
    render: (tier, url, timeoutMs, options) => renderWith(tier, url, timeoutMs, options),
  };
}

export function scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
  return scrapeCore(url, opts, loadFullTiers);
}
