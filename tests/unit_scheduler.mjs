import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
process.env.CAMOUFOX_AGENT_HOME = home;
const flows = await import("../dist/flows.js");
const sched = await import("../dist/scheduler.js");

const base = { startUrl: "https://example.com", actions: [] };
flows.saveFlow("bueno", { ...base, schedule: "*/1 * * * *" });
flows.saveFlow("malo", { ...base, schedule: "malo" });
flows.saveFlow("sin-cron", base);

const originalError = console.error;
console.error = () => {};
sched.startScheduler();
console.error = originalError;
assert.equal(sched.scheduledJobCount(), 1);
sched.stopScheduler();
assert.equal(sched.scheduledJobCount(), 0);
fs.rmSync(home, { recursive: true });
console.log("unit_scheduler ok");
