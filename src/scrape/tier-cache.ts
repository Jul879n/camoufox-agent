import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type TierHint = "chrome" | "camoufox";

const TTL_MS = 24 * 60 * 60 * 1000;
const file = (): string => path.join(process.env.CAMOUFOX_AGENT_CACHE_DIR ?? path.join(os.homedir(), ".cache", "camoufox-agent"), "tiers.json");

/** host + first path segment: `quotes.toscrape.com/js` is JS-only while `quotes.toscrape.com/` is static. */
export function tierKey(url: string): string {
  const u = new URL(url);
  return `${u.hostname}/${u.pathname.split("/")[1] ?? ""}`;
}

function load(): Record<string, { tier: TierHint; at: number }> {
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

export function readHint(url: string): TierHint | undefined {
  if (process.env.CAMOUFOX_AGENT_NO_TIER_CACHE === "1") return undefined;
  try {
    const entry = load()[tierKey(url)];
    return entry && Date.now() - entry.at < TTL_MS ? entry.tier : undefined;
  } catch {
    return undefined;
  }
}

/** Remember which tier worked (undefined forgets the host). Best effort. */
export function writeHint(url: string, tier: TierHint | undefined): void {
  if (process.env.CAMOUFOX_AGENT_NO_TIER_CACHE === "1") return;
  try {
    const data = load();
    const key = tierKey(url);
    if (tier) data[key] = { tier, at: Date.now() };
    else if (key in data) delete data[key];
    else return;
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(data));
  } catch {
    // cache is an optimization only
  }
}
