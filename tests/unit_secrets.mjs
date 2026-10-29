import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
process.env.CAMOUFOX_AGENT_HOME = home;
const s = await import("../dist/secrets.js");

assert.throws(() => s.getSecret("nada"), /Secret "nada" not found/);
s.setSecret("mi-clave", "desde-archivo");
assert.equal(fs.statSync(path.join(home, "secrets.json")).mode & 0o777, 0o600);
assert.equal(s.getSecret("mi-clave"), "desde-archivo");
assert.deepEqual(s.listSecretNames(), ["mi-clave"]);

process.env.CAMOUFOX_SECRET_MI_CLAVE = "desde-env";
assert.equal(s.getSecret("mi-clave"), "desde-env");
delete process.env.CAMOUFOX_SECRET_MI_CLAVE;

fs.chmodSync(path.join(home, "secrets.json"), 0o644);
assert.throws(() => s.getSecret("mi-clave"), /chmod 600/);
fs.rmSync(home, { recursive: true });
console.log("unit_secrets ok");
