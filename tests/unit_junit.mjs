import assert from "node:assert/strict";
import { toJunit } from "../dist/junit.js";

const xml = toJunit([
  { name: "a", ok: true, trigger: "cli", startedAt: "x", durationMs: 1500, steps: [{ index: 0, type: "click", ok: true, status: "passed" }] },
  { name: "b", ok: false, trigger: "cli", startedAt: "x", durationMs: 10, steps: [{ index: 0, type: "expect", ok: false, status: "failed", message: 'got "x" & <y>' }] },
]);
assert.match(xml, /<testsuite name="b" tests="1" failures="1"/);
assert.match(xml, /<testsuite name="a" tests="1" failures="0"/);
assert.ok(xml.includes('message="got &quot;x&quot; &amp; &lt;y&gt;"'));
console.log("unit_junit ok");
