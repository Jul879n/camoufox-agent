import assert from "node:assert/strict";
import { accessibilityScore, findingsScore, getLogNormalScore, LIGHTHOUSE_CONTROL_POINTS, normalizedWeights, performanceScore } from "../dist/diagnose/scoring.js";

const fcp = LIGHTHOUSE_CONTROL_POINTS.mobile.fcp;
assert.ok(getLogNormalScore(fcp, fcp.p10 / 2) >= 0.99);
assert.ok(Math.abs(getLogNormalScore(fcp, fcp.median) - 0.5) < 1e-9);
assert.ok(Math.abs(getLogNormalScore(fcp, fcp.p10) - 0.9) < 1e-9);
assert.ok(getLogNormalScore(fcp, fcp.median * 20) < 0.01);

const weights = normalizedWeights(["fcp", "lcp", "tbt", "si"]);
assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
const partial = normalizedWeights(["fcp", "tbt"]);
assert.ok(Math.abs(partial.fcp + partial.tbt - 1) < 1e-9);

assert.equal(performanceScore({ fcp: 100, lcp: null, tbt: 0, si: 100 }, "desktop").score, 100);
assert.equal(performanceScore({}, "desktop").score, null);
assert.ok(accessibilityScore([{ impact: "critical" }], 30) < 100);
assert.equal(accessibilityScore([], 30), 100);
assert.equal(findingsScore([{ severity: "error" }, { severity: "warning" }, { severity: "info" }]), 80);
assert.equal(findingsScore(Array(10).fill({ severity: "error" })), 0);
console.log("unit_scoring ok");
