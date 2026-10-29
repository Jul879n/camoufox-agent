import fs from "node:fs";
import { agentHome, ensureDir } from "./home.js";

export const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function secretsFile(): string {
  return agentHome("secrets.json");
}

function readFile(): Record<string, string> {
  const file = secretsFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return {};
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("secrets.json must be chmod 600");
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
}

export function getSecret(name: string): string {
  const env = process.env[`CAMOUFOX_SECRET_${name.toUpperCase().replace(/-/g, "_")}`];
  if (env !== undefined) return env;
  const value = readFile()[name];
  if (typeof value !== "string") throw new Error(`Secret "${name}" not found`);
  return value;
}

export function setSecret(name: string, value: string): void {
  if (!SECRET_NAME.test(name)) throw new Error("Invalid secret name");
  const current = readFile();
  current[name] = value;
  ensureDir(agentHome());
  fs.writeFileSync(secretsFile(), JSON.stringify(current, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(secretsFile(), 0o600);
}

export function listSecretNames(): string[] {
  return Object.keys(readFile()).sort();
}
