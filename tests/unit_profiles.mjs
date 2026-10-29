import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CAMOUFOX_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-"));
const p = await import("../dist/profiles.js");

assert.throws(() => p.loadProfile("../x"), /Invalid profile name/);
assert.throws(() => p.loadProfile("UPPER"), /Invalid profile name/);

p.acquireProfileLock("demo");
assert.throws(() => p.acquireProfileLock("demo"), /is in use by pid/);
assert.equal(p.listProfiles()[0].inUse, true);
assert.throws(() => p.deleteProfile("demo"), /is in use/);
p.releaseProfileLock("demo");
p.acquireProfileLock("demo");
p.releaseProfileLock("demo");

// Lock with dead pid is taken over.
fs.writeFileSync(path.join(process.env.CAMOUFOX_AGENT_HOME, "profiles", "demo", "lock"), "999999");
p.acquireProfileLock("demo");
p.releaseProfileLock("demo");

p.saveProfileSettings("demo", { os: "linux", createdAt: new Date().toISOString() });
assert.equal(p.loadProfile("demo").settings.os, "linux");
assert.equal(p.deleteProfile("demo"), true);
assert.equal(p.deleteProfile("demo"), false);
fs.rmSync(process.env.CAMOUFOX_AGENT_HOME, { recursive: true });
console.log("unit_profiles ok");
