import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function agentHome(...parts: string[]): string {
  const base = process.env.CAMOUFOX_AGENT_HOME || path.join(os.homedir(), ".camoufox-agent");
  return path.join(base, ...parts);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
