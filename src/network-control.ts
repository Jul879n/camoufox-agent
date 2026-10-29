import type { BrowserContext, Route } from "playwright-core";
import type { NetworkControl } from "./types.js";

type Handler = (route: Route) => Promise<void>;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface NetworkController {
  set(next: NetworkControl): Promise<void>;
  current(): NetworkControl;
}

// Routes are registered after installRequestGuard, so they run first (Playwright
// runs the most recently registered route first) and hand off with route.fallback().
// Execution order: latency -> blockUrls -> mocks -> request guard.
export async function applyNetworkControl(context: BrowserContext, initial: NetworkControl = {}): Promise<NetworkController> {
  let installed: Array<{ url: string; handler: Handler }> = [];
  let state: NetworkControl = {};

  const undo = async () => {
    for (const { url, handler } of installed) await context.unroute(url, handler).catch(() => undefined);
    installed = [];
  };
  const add = async (url: string, handler: Handler) => {
    await context.route(url, handler as Parameters<BrowserContext["route"]>[1]);
    installed.push({ url, handler });
  };

  const set = async (next: NetworkControl): Promise<void> => {
    await undo();
    state = next;
    for (const mock of next.mocks ?? []) {
      await add(mock.url, async (route) => {
        if (mock.method && route.request().method().toUpperCase() !== mock.method.toUpperCase()) return route.fallback();
        if (mock.delayMs) await sleep(mock.delayMs);
        if (mock.abort) return route.abort();
        const hasJson = mock.json !== undefined;
        await route.fulfill({
          status: mock.status ?? 200,
          headers: mock.headers,
          contentType: mock.contentType ?? (hasJson ? "application/json" : undefined),
          body: hasJson ? JSON.stringify(mock.json) : mock.body ?? "",
        });
      });
    }
    for (const pattern of next.blockUrls ?? []) await add(pattern, (route) => route.abort("blockedbyclient"));
    if (next.latencyMs) {
      const latency = next.latencyMs;
      await add("**/*", async (route) => {
        await sleep(latency);
        await route.fallback();
      });
    }
    await context.setExtraHTTPHeaders(next.extraHeaders ?? {});
    await context.setOffline(next.offline ?? false);
  };

  if (Object.keys(initial).length > 0) await set(initial);
  return { set, current: () => state };
}
