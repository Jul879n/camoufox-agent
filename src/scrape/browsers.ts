import type { Browser, BrowserContext, Page } from "playwright-core";
import type { CommonBrowserInput } from "../types.js";
import { CHROME_ARGS, HIDE_WEBDRIVER, chromeContextOptions, humanizePage } from "./human.js";
import { getWarmBrowser, takeSpare } from "./warm-pool.js";
import type { RequestGuard } from "../types.js";

import { findChrome } from "./chrome-path.js";

export { findChrome };

import type { RenderResult } from "./core.js";

export type { RenderResult };
export interface RenderOptions { fast?: boolean }

async function launchChrome(): Promise<Browser> {
  const executablePath = findChrome();
  if (!executablePath) throw new Error("no Chromium browser found; set CAMOUFOX_AGENT_CHROME");
  const { chromium } = await import("playwright-core");
  return chromium.launch({ executablePath, headless: true, args: CHROME_ARGS });
}

async function launchCamoufox(fast: boolean): Promise<Browser> {
  // camoufox-js needs the node:sqlite shim in place before it loads.
  await import("../sqlite-compat.js");
  const { launchCamoufoxBrowser, buildCamoufoxOptions } = await import("../browser-runtime.js");
  const { applyStealthProfile, defaultHeadlessMode, selectOperatingSystem } = await import("../utils.js");
  const base: CommonBrowserInput = { url: "about:blank", ...(fast ? { stealthProfile: "fast" as const } : {}) };
  const input = applyStealthProfile(base);
  return launchCamoufoxBrowser(buildCamoufoxOptions(input, selectOperatingSystem(input.os), defaultHeadlessMode(input.headless)));
}

interface Prepared { context: BrowserContext; page: Page; guard: RequestGuard }
type Runtime = typeof import("../browser-runtime.js");

async function prepare(engine: "chrome" | "camoufox", browser: Browser, runtime: Runtime): Promise<Prepared> {
  const contextOptions = engine === "chrome"
    ? { ...chromeContextOptions(browser.version()), serviceWorkers: "block" as const }
    : runtime.browserContextOptions({});
  const context = await browser.newContext(contextOptions);
  try {
    if (engine === "chrome") await context.addInitScript(HIDE_WEBDRIVER);
    const guard = await runtime.installRequestGuard(context);
    const page = await context.newPage();
    return { context, page, guard };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export async function renderWith(engine: "chrome" | "camoufox", url: string, timeoutMs: number, options: RenderOptions = {}): Promise<RenderResult> {
  const runtime = await import("../browser-runtime.js");
  const launch = engine === "chrome" ? launchChrome : () => launchCamoufox(Boolean(options.fast));
  const warm = await getWarmBrowser(engine, async () => {
    const browser = await launch();
    runtime.trackBrowser(browser);
    return browser;
  });
  const browser = warm ?? await launch();
  if (!warm) runtime.trackBrowser(browser);
  let prepared: Prepared | undefined;
  try {
    prepared = warm
      ? await takeSpare(engine, () => prepare(engine, warm, runtime))
      : await prepare(engine, browser, runtime);
    const { context, page, guard } = prepared;
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      // fast trades the 500 ms network-quiet window for the load event plus a short DOM settle.
      const settle = options.fast
        ? page.waitForLoadState("load", { timeout: 1500 }).then(() => page.waitForTimeout(150)).catch(() => undefined)
        : page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
      await Promise.all([options.fast ? undefined : humanizePage(page), settle]);
      try {
        guard.assertAllowed();
      } catch (blocked) {
        // Challenge pages request throwaway hosts that may not resolve; only real policy violations abort.
        if (!/Could not resolve URL host/.test(String(blocked))) throw blocked;
      }
      await runtime.assertPageLocationSafe(page);
      const { isChallengeRender } = await import("./http.js");
      let html = await page.content();
      let status = response?.status() ?? null;
      if (isChallengeRender(status, html)) {
        // Interstitials such as Cloudflare's "Just a moment" clear by themselves within seconds for a believable browser.
        // Headless Chrome that is going to be flagged rarely recovers, so it gives up early and Camoufox takes over.
        const waitMs = Math.min(engine === "chrome" ? 6000 : 40000, Math.max(3000, timeoutMs - 8000));
        const cleared = await page.waitForFunction(
          () => !/just a moment|un momento|attention required|verifying you are human/i.test(document.title),
          undefined,
          { timeout: waitMs },
        ).then(() => true, () => false);
        if (cleared) {
          await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
          await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
          html = await page.content();
          status = 200;
        }
      }
      const blocked = isChallengeRender(status, html);
      const { detectChallenge } = await import("../captcha.js");
      const captcha = blocked || (await detectChallenge(page, response).catch(() => ({ captchaDetected: false }))).captchaDetected;
      return { status, html, finalUrl: page.url(), blocked, captcha };
    } finally {
      // A private browser dies with its contexts; only a shared one needs the explicit close.
      if (warm) await context.close().catch(() => undefined);
    }
  } finally {
    // Not awaited: the process (or Playwright's exit hook) reaps it, saving ~0.3 s per one-shot scrape.
    if (!warm) void runtime.closeBrowser(browser);
  }
}
