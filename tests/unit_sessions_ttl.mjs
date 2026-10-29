import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function ttl(value) {
  const env = { ...process.env };
  delete env.CAMOUFOX_MCP_SESSION_TTL_MS;
  if (value !== undefined) env.CAMOUFOX_MCP_SESSION_TTL_MS = value;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'import { SESSION_TTL_MS } from "./dist/config.js"; console.log(SESSION_TTL_MS)'], { env, encoding: "utf8" });
  return Number(r.stdout.trim());
}

assert.equal(ttl(undefined), 0);
assert.equal(ttl("5000"), 5000);
console.log("unit_sessions_ttl ok");
