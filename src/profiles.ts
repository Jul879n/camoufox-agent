import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { agentHome, ensureDir } from "./home.js";
import type { ProxyConfig, SupportedOs } from "./types.js";

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ProfileSettings {
  os: SupportedOs;
  locale?: string;
  proxy?: ProxyConfig;
  window?: unknown;
  viewport?: { width: number; height: number };
  fingerprint?: Record<string, unknown>;
  createdAt: string;
  lastSavedAt?: string;
}

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) throw new Error("Invalid profile name");
}

function profileDir(name: string): string {
  assertProfileName(name);
  return agentHome("profiles", name);
}

export function loadProfile(name: string): { settings: ProfileSettings | null; statePath?: string } {
  const dir = profileDir(name);
  let settings: ProfileSettings | null;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8")) as ProfileSettings;
  } catch {
    settings = null;
  }
  const statePath = path.join(dir, "state.json");
  return { settings, statePath: fs.existsSync(statePath) ? statePath : undefined };
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function saveProfileSettings(name: string, settings: ProfileSettings): void {
  writeJsonAtomic(path.join(ensureDir(profileDir(name)), "profile.json"), settings);
}

let indexedDbWarned = false;

export async function saveProfileState(name: string, context: BrowserContext): Promise<void> {
  const dir = ensureDir(profileDir(name));
  const tmp = path.join(dir, `state.json.${process.pid}.tmp`);
  try {
    await context.storageState({ path: tmp, indexedDB: true });
  } catch (error) {
    if (!indexedDbWarned) {
      indexedDbWarned = true;
      console.error(`[Camoufox] storageState with indexedDB failed, saving without it: ${error instanceof Error ? error.message : String(error)}`);
    }
    await context.storageState({ path: tmp });
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, path.join(dir, "state.json"));
  const { settings } = loadProfile(name);
  if (settings) saveProfileSettings(name, { ...settings, lastSavedAt: new Date().toISOString() });
}

function lockPath(name: string): string {
  return path.join(profileDir(name), "lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockOwner(name: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath(name), "utf8"), 10);
    return Number.isFinite(pid) && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function tryCreateLock(file: string): boolean {
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

export function acquireProfileLock(name: string): void {
  ensureDir(profileDir(name));
  const file = lockPath(name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreateLock(file)) return;
    const owner = lockOwner(name);
    if (owner !== null) throw new Error(`Profile "${name}" is in use by pid ${owner}`);
    fs.rmSync(file, { force: true });
  }
  throw new Error(`Profile "${name}" could not be locked`);
}

export function releaseProfileLock(name: string): void {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath(name), "utf8"), 10);
    if (pid === process.pid) fs.rmSync(lockPath(name), { force: true });
  } catch {
    // no lock
  }
}

export function listProfiles(): Array<{ name: string; createdAt: string | null; lastSavedAt: string | null; inUse: boolean }> {
  let names: string[];
  try {
    names = fs.readdirSync(agentHome("profiles")).filter((n) => PROFILE_NAME.test(n));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const { settings } = loadProfile(name);
    return { name, createdAt: settings?.createdAt ?? null, lastSavedAt: settings?.lastSavedAt ?? null, inUse: lockOwner(name) !== null };
  });
}

export function deleteProfile(name: string): boolean {
  const dir = profileDir(name);
  if (!fs.existsSync(dir)) return false;
  const owner = lockOwner(name);
  if (owner !== null) throw new Error(`Profile "${name}" is in use by pid ${owner}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
