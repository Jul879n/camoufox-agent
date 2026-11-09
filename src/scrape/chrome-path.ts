import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
  "Chromium.app/Contents/MacOS/Chromium",
  "Vivaldi.app/Contents/MacOS/Vivaldi",
];
const PATH_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WIN_BINS = ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe"];

export function exists(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChrome(): string | undefined {
  const env = process.env.CAMOUFOX_AGENT_CHROME;
  if (env && exists(env)) return env;
  for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) {
    for (const app of MAC_APPS) if (exists(path.join(root, app))) return path.join(root, app);
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of PATH_BINS) if (exists(path.join(dir, name))) return path.join(dir, name);
  }
  for (const variable of ["PROGRAMFILES", "PROGRAMFILES(X86)"]) {
    const base = process.env[variable];
    if (!base) continue;
    for (const rel of WIN_BINS) if (exists(path.join(base, rel))) return path.join(base, rel);
  }
  return undefined;
}
