import fs from "node:fs";
import path from "node:path";
import { agentHome, ensureDir } from "./home.js";

export function filesRoot(): string {
  const dir = process.env.CAMOUFOX_MCP_FILES_DIR || agentHome("files");
  return fs.realpathSync(ensureDir(dir));
}

export function insideRoot(root: string, file: string): string {
  const real = fs.realpathSync(file);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error("File is outside CAMOUFOX_MCP_FILES_DIR.");
  }
  return real;
}
