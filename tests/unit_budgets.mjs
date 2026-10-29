import assert from "node:assert/strict";
import { evaluateBudgets } from "../dist/diagnose-tool.js";

const report = {
  perf: { navigation: { loadMs: 250, ttfbMs: 20 }, vitals: { fcpMs: 100, lcp: null }, tbtApproxMs: 0, dom: { nodes: 10 } },
  network: { requests: 3, totalBytes: 100, failed: [], httpErrors: [{}] },
  console: { counts: { error: 1 }, uncaughtErrors: [] },
};
const res = evaluateBudgets(report, { maxLoadMs: 100, maxLcpMs: 2500, maxFcpMs: 500, maxFailedRequests: 1, maxConsoleErrors: 0 });
const by = Object.fromEntries(res.results.map((r) => [r.metric, r]));
assert.equal(by.maxLoadMs.ok, false);
assert.equal(by.maxLoadMs.actual, 250);
assert.equal(by.maxLcpMs.ok, null);
assert.equal(by.maxFcpMs.ok, true);
assert.equal(by.maxFailedRequests.ok, true);
assert.equal(by.maxConsoleErrors.ok, false);
assert.equal(res.passed, false);
assert.equal(evaluateBudgets(report, { maxLcpMs: 1 }).passed, true);
console.log("unit_budgets ok");
