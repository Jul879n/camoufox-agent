import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateBrowserRequestUrl } from "../policy.js";
import { findChrome } from "./chrome-path.js";
import type { RenderResult } from "./core.js";
import { CHROME_ARGS, HIDE_WEBDRIVER, acceptLanguage, humanizePage, systemLocale } from "./human.js";
import { isChallengeRender } from "./http.js";

/** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket: no Playwright, no dependencies. */
class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>, sessionId?: string) => void>>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (entry) msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {}, msg.sessionId);
      }
    });
    ws.addEventListener("close", () => {
      for (const entry of this.pending.values()) entry.reject(new Error("Chrome connection closed"));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect to Chrome DevTools")), { once: true });
    });
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, fn: (params: Record<string, unknown>, sessionId?: string) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} timed out`);
    await sleep(40);
  }
}

interface Launched { child: ChildProcess; profile: string; cdp: Cdp }

async function launch(chrome: string, timeoutMs: number): Promise<Launched> {
  const profile = path.join(process.env.CAMOUFOX_AGENT_CACHE_DIR ?? path.join(os.homedir(), ".cache", "camoufox-agent"), `chrome-${process.pid}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const child = spawn(chrome, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-extensions", "--mute-audio", ...CHROME_ARGS, "about:blank",
  ], { stdio: "ignore" });
  child.unref();
  try {
    const endpoint = await waitFor(() => {
      try {
        const [port, wsPath] = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
        return port && wsPath ? `ws://127.0.0.1:${port}${wsPath}` : undefined;
      } catch {
        return undefined;
      }
    }, Math.min(timeoutMs, 15000), "Chrome start");
    return { child, profile, cdp: await Cdp.connect(endpoint) };
  } catch (error) {
    child.kill("SIGKILL");
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* harmless */ }
    throw error;
  }
}

const VIEWPORTS = [[1920, 1080], [1536, 864], [1440, 900], [1366, 768]];

/** Render a URL in the user's Chrome driven over raw CDP. Same contract as the Playwright-based renderer. */
export async function renderViaCdp(url: string, timeoutMs: number, options: { fast?: boolean } = {}): Promise<RenderResult> {
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chromium browser found; set CAMOUFOX_AGENT_CHROME");
  const { child, profile, cdp } = await launch(chrome, timeoutMs);
  try {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const call = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);

    let blockedError: string | undefined;
    let status: number | null = null;
    let mainRequestId: string | undefined;
    let loaded = false;
    let fullLoad = false;
    let idle = false;
    cdp.on("Page.lifecycleEvent", (p, s) => {
      if (s !== sessionId) return;
      if (p.name === "load" || p.name === "DOMContentLoaded") loaded = true;
      if (p.name === "load") fullLoad = true;
      if (p.name === "networkIdle") idle = true;
    });
    cdp.on("Network.responseReceived", (p, s) => {
      if (s !== sessionId || p.type !== "Document") return;
      mainRequestId ??= String(p.requestId);
      if (p.requestId === mainRequestId) status = Number((p.response as { status: number }).status);
    });
    // Same SSRF policy as the Playwright path: every request is validated before it leaves the browser.
    cdp.on("Fetch.requestPaused", (p, s) => {
      if (s !== sessionId) return;
      const requestId = String(p.requestId);
      const requestUrl = String((p.request as { url: string }).url);
      validateBrowserRequestUrl(requestUrl).then(
        () => call("Fetch.continueRequest", { requestId }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!/Could not resolve URL host|did not resolve to an address/.test(message)) blockedError ??= `Blocked unsafe browser request. ${message}`;
          return call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
        },
      ).catch(() => undefined);
    });

    const version = await cdp.send<{ userAgent: string }>("Browser.getVersion");
    const [width, height] = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    await Promise.all([
      call("Page.enable"), call("Network.enable"), call("Runtime.enable"),
      call("Page.setLifecycleEventsEnabled", { enabled: true }),
      call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
      call("Emulation.setUserAgentOverride", { userAgent: version.userAgent.replace("HeadlessChrome", "Chrome"), acceptLanguage: acceptLanguage() }),
      call("Emulation.setLocaleOverride", { locale: systemLocale() }).catch(() => undefined),
      call("Emulation.setTimezoneOverride", { timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => undefined),
      call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: process.platform === "darwin" ? 2 : 1, mobile: false }),
      call("Page.addScriptToEvaluateOnNewDocument", { source: HIDE_WEBDRIVER }),
    ]);

    // Lifecycle events replayed from the initial about:blank must not count as the target page loading.
    loaded = false; fullLoad = false; idle = false;
    const navigation = await call<{ errorText?: string }>("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`navigation failed: ${navigation.errorText}`);
    await waitFor(() => (loaded ? true : undefined), timeoutMs, "page load");

    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await call<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true });
      return r.result.value;
    };
    const page = {
      viewportSize: () => ({ width, height }),
      mouse: {
        move: async (x: number, y: number) => { await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); },
        wheel: async (dx: number, dy: number) => { await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: dx, deltaY: dy }); },
      },
      evaluate: <T>(fn: () => T) => evaluate<T>(`(${fn.toString()})()`),
    };
    // fast: the load event plus a short DOM settle instead of the 500 ms network-quiet window.
    const settle = options.fast
      ? waitFor(() => (fullLoad ? true : undefined), 1500, "load").catch(() => undefined).then(() => sleep(150))
      : waitFor(() => (idle ? true : undefined), 3000, "network idle").catch(() => undefined);
    await Promise.all([options.fast ? undefined : humanizePage(page), settle]);

    let html = await evaluate<string>("document.documentElement.outerHTML");
    let finalStatus = status as number | null;
    if (isChallengeRender(finalStatus, html)) {
      // Interstitials such as Cloudflare's "Just a moment" can clear by themselves; headless Chrome rarely recovers, so wait briefly.
      const until = Date.now() + Math.min(6000, Math.max(3000, timeoutMs - 5000));
      while (Date.now() < until) {
        await sleep(300);
        const title = await evaluate<string>("document.title");
        if (!/just a moment|un momento|attention required|verifying you are human/i.test(title)) {
          await sleep(300);
          html = await evaluate<string>("document.documentElement.outerHTML");
          finalStatus = 200;
          break;
        }
      }
    }
    if (blockedError) throw new Error(blockedError);
    const finalUrl = await evaluate<string>("location.href");
    await validateBrowserRequestUrl(finalUrl);
    const blocked = isChallengeRender(finalStatus, html);
    return { status: finalStatus, html, finalUrl, blocked, captcha: blocked };
  } finally {
    await shutdown(child, cdp, profile);
  }
}

/** Ask Chrome to quit, force it after a short grace, then remove its profile (Chrome keeps writing until it exits). */
async function shutdown(child: ChildProcess, cdp: Cdp, profile: string): Promise<void> {
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); if (child.exitCode !== null) resolve(); });
  await cdp.send("Browser.close").catch(() => undefined);
  cdp.close();
  await Promise.race([exited, sleep(500)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(500)]);
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // a stray profile directory is harmless; never fail a finished scrape over it
  }
}
