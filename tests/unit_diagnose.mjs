import assert from "node:assert/strict";
import { summarizeNetwork } from "../dist/diagnose/collector.js";

const s = summarizeNetwork([
  { url: "https://a/x.js", method: "GET", resourceType: "script", status: 200, transferBytes: 5000, durationMs: 300, headers: {} },
  { url: "https://a/y.css", method: "GET", resourceType: "stylesheet", status: 200, transferBytes: 800, durationMs: 50, headers: { "cache-control": "max-age=1", "content-encoding": "br" } },
  { url: "https://a/z.png", method: "GET", resourceType: "image", status: 404, transferBytes: 100, durationMs: 20 },
  { url: "https://a/w", method: "GET", resourceType: "fetch", failed: true, errorText: "NS_ERROR" },
]);
assert.equal(s.requests, 4);
assert.equal(s.totalBytes, 5900);
assert.equal(s.byType.script.count, 1);
assert.equal(s.failed.length, 1);
assert.equal(s.httpErrors.length, 1);
assert.equal(s.slowest[0].url, "https://a/x.js");
assert.equal(s.largest[0].url, "https://a/x.js");
assert.equal(s.uncompressed.length, 1);
assert.equal(s.noCacheHeaders.length, 1);
console.log("unit_diagnose ok");
