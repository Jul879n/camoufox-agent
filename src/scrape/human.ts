import { readFileSync } from "node:fs";

function firefoxMajor(): string {
  try {
    const builds = JSON.parse(readFileSync(new URL("../../browser-builds.json", import.meta.url), "utf8")) as {
      default: { version: string };
      compatibility: { version: string };
    };
    const build = process.env.CAMOUFOX_MCP_BROWSER_COMPATIBILITY === "1" ? builds.compatibility : builds.default;
    return build.version.split(".")[0];
  } catch {
    return "135";
  }
}

export function systemLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
}

export function acceptLanguage(): string {
  const locale = systemLocale();
  const lang = locale.split("-")[0];
  const parts = [locale];
  if (lang !== locale) parts.push(`${lang};q=0.8`);
  if (locale !== "en-US") parts.push("en-US;q=0.5", "en;q=0.3");
  return parts.join(",");
}

function platformToken(): string {
  switch (process.platform) {
    case "darwin": return "Macintosh; Intel Mac OS X 10.15";
    case "win32": return "Windows NT 10.0; Win64; x64";
    default: return "X11; Linux x86_64";
  }
}

/** Header set of a real Firefox navigation, same major as the pinned Camoufox. */
export function humanHeaders(referer?: string, sameOrigin = false): Record<string, string> {
  const v = firefoxMajor();
  const headers: Record<string, string> = {
    "User-Agent": `Mozilla/5.0 (${platformToken()}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": acceptLanguage(),
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer && sameOrigin ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    Priority: "u=0, i",
  };
  if (referer) headers.Referer = referer;
  return headers;
}

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

export function chromeContextOptions(browserVersion: string): {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  extraHTTPHeaders: Record<string, string>;
} {
  const opts = Intl.DateTimeFormat().resolvedOptions();
  const major = browserVersion.split(".")[0];
  const platform = platformToken();
  return {
    userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    locale: systemLocale(),
    timezoneId: opts.timeZone,
    viewport: VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)],
    deviceScaleFactor: process.platform === "darwin" ? 2 : 1,
    extraHTTPHeaders: { "Accept-Language": acceptLanguage() },
  };
}

export const CHROME_ARGS = ["--disable-blink-features=AutomationControlled"];
export const HIDE_WEBDRIVER = "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });";

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface PageLike {
  viewportSize(): { width: number; height: number } | null;
  mouse: { move(x: number, y: number, o?: { steps?: number }): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  evaluate<T>(fn: () => T): Promise<T>;
}

/** Brief mouse movement and scroll, bounded by budgetMs. Also triggers lazy-load. */
export async function humanizePage(page: PageLike, budgetMs = 900): Promise<void> {
  const deadline = Date.now() + budgetMs;
  // Camoufox's own humanized cursor can make a single move arbitrarily slow, so the whole routine is hard-capped.
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs + 400); });
  try {
    await Promise.race([humanizeSteps(page, deadline), cap]);
  } finally {
    clearTimeout(timer);
  }
}

async function humanizeSteps(page: PageLike, deadline: number): Promise<void> {
  try {
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const moves = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < moves && Date.now() < deadline; i++) {
      await page.mouse.move(rand(40, vp.width - 40), rand(40, vp.height - 40), { steps: 8 + Math.floor(Math.random() * 13) });
    }
    while (Date.now() < deadline) {
      await page.mouse.wheel(0, rand(300, 700));
      await sleep(Math.min(rand(60, 180), Math.max(0, deadline - Date.now())));
      const atEnd = await page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2);
      if (atEnd) break;
    }
  } catch {
    // best effort
  }
}
