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

// Path under <filesRoot>/exports for a new file; never overwrites (adds a timestamp suffix).
export function uniqueExportPath(name: string): string {
  const dir = ensureDir(path.join(filesRoot(), "exports"));
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  return path.join(dir, `${path.basename(name, ext)}-${Date.now()}${ext}`);
}
