import type { Browser } from "playwright-core";

type Engine = "chrome" | "camoufox";

let active = false;
const spares = new Map<Engine, Promise<unknown>>();
const pool = new Map<Engine, { browser: Promise<Browser>; timer?: NodeJS.Timeout }>();

export function enableWarmPool(): void { active = true; }
export function warmPoolActive(): boolean { return active; }

const idleMs = (): number => Number(process.env.CAMOUFOX_AGENT_WARM_IDLE_MS ?? 300000);

function arm(engine: Engine): void {
  const entry = pool.get(engine);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pool.delete(engine);
    spares.delete(engine);
    void entry.browser.then((b) => b.close()).catch(() => undefined);
  }, idleMs());
  entry.timer.unref();
}

/** Live shared browser inside `serve`; undefined elsewhere. `launch` runs lazily and restarts a dead browser. */
export async function getWarmBrowser(engine: Engine, launch: () => Promise<Browser>): Promise<Browser | undefined> {
  if (!active) return undefined;
  let entry = pool.get(engine);
  if (entry) {
    const existing = await entry.browser.catch(() => undefined);
    if (!existing?.isConnected()) {
      pool.delete(engine);
      spares.delete(engine);
      entry = undefined;
    }
  }
  if (!entry) {
    const browser = launch();
    entry = { browser };
    pool.set(engine, entry);
    browser.catch(() => pool.delete(engine));
  }
  const browser = await entry.browser;
  arm(engine);
  return browser;
}


/** Returns a ready context+page prepared in the background by the previous call, then prepares the next one. */
export async function takeSpare<T>(engine: Engine, make: () => Promise<T>): Promise<T> {
  const ready = spares.get(engine) as Promise<T> | undefined;
  const refill = (): void => {
    const next = make();
    next.catch(() => spares.delete(engine));
    spares.set(engine, next);
  };
  let value: T;
  if (ready) {
    spares.delete(engine);
    value = await ready.catch(() => make());
  } else {
    value = await make();
  }
  refill();
  return value;
}
