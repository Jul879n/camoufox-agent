// Performance scoring follows Lighthouse 13.6.0: log-normal curve per metric with the
// p10/median control points from core/audits/metrics/*.js, weighted as in core/config/default-config.js.
// getLogNormalScore is adapted from lighthouse/shared/statistics.js (Apache-2.0, Google LLC).

export type FormFactor = "mobile" | "desktop";
export type PerfMetric = "fcp" | "lcp" | "tbt" | "si";

export const LIGHTHOUSE_CONTROL_POINTS: Record<FormFactor, Record<PerfMetric, { p10: number; median: number }>> = {
  mobile: {
    fcp: { p10: 1800, median: 3000 },
    lcp: { p10: 2500, median: 4000 },
    tbt: { p10: 200, median: 600 },
    si: { p10: 3387, median: 5800 },
  },
  desktop: {
    fcp: { p10: 934, median: 1600 },
    lcp: { p10: 1200, median: 2400 },
    tbt: { p10: 150, median: 350 },
    si: { p10: 1311, median: 2300 },
  },
};

// CLS (weight 25) is not measurable in Firefox, so it is left out and the rest is renormalized.
export const LIGHTHOUSE_WEIGHTS: Record<PerfMetric, number> = { fcp: 10, lcp: 25, tbt: 30, si: 10 };

const MIN_PASSING_SCORE = 0.9000000000000000222;
const MAX_AVERAGE_SCORE = 0.8999999999999999112;
const MIN_AVERAGE_SCORE = 0.5;
const MAX_FAILING_SCORE = 0.4999999999999999445;

function erf(x: number): number {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - y * Math.exp(-ax * ax));
}

export function getLogNormalScore({ median, p10 }: { median: number; p10: number }, value: number): number {
  if (median <= 0 || p10 <= 0 || p10 >= median) throw new Error("invalid control points");
  if (value <= 0) return 1;
  const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
  const xLogRatio = Math.log(Math.max(Number.MIN_VALUE, value / median));
  const p10LogRatio = -Math.log(Math.max(Number.MIN_VALUE, p10 / median));
  const complementaryPercentile = (1 - erf(xLogRatio * INVERSE_ERFC_ONE_FIFTH / p10LogRatio)) / 2;
  if (value <= p10) return Math.max(MIN_PASSING_SCORE, Math.min(1, complementaryPercentile));
  if (value <= median) return Math.max(MIN_AVERAGE_SCORE, Math.min(MAX_AVERAGE_SCORE, complementaryPercentile));
  return Math.max(0, Math.min(MAX_FAILING_SCORE, complementaryPercentile));
}

export function normalizedWeights(available: PerfMetric[]): Record<string, number> {
  const total = available.reduce((sum, metric) => sum + LIGHTHOUSE_WEIGHTS[metric], 0);
  return Object.fromEntries(available.map((metric) => [metric, total ? LIGHTHOUSE_WEIGHTS[metric] / total : 0]));
}

export function performanceScore(values: Partial<Record<PerfMetric, number | null>>, formFactor: FormFactor) {
  const available = (Object.keys(LIGHTHOUSE_WEIGHTS) as PerfMetric[]).filter((metric) => typeof values[metric] === "number");
  if (available.length === 0) return { score: null, metrics: {} as Record<string, { value: number; score: number; weight: number }> };
  const weights = normalizedWeights(available);
  const metrics: Record<string, { value: number; score: number; weight: number }> = {};
  let total = 0;
  for (const metric of available) {
    const value = values[metric] as number;
    const score = getLogNormalScore(LIGHTHOUSE_CONTROL_POINTS[formFactor][metric], value);
    metrics[metric] = { value, score: Math.round(score * 100), weight: Math.round(weights[metric] * 1000) / 1000 };
    total += score * weights[metric];
  }
  return { score: Math.round(total * 100), metrics };
}

const IMPACT_WEIGHT: Record<string, number> = { critical: 10, serious: 7, moderate: 3, minor: 1 };
const PASSED_RULE_WEIGHT = 3; // axe reports no impact for passed rules; they weigh like a "moderate" one.

export function accessibilityScore(violations: Array<{ impact: string | null }>, passedRules: number): number {
  const failed = violations.reduce((sum, violation) => sum + (IMPACT_WEIGHT[violation.impact ?? "minor"] ?? 1), 0);
  const evaluated = failed + passedRules * PASSED_RULE_WEIGHT;
  return evaluated === 0 ? 100 : Math.max(0, Math.round(100 * (1 - failed / evaluated)));
}

export function findingsScore(findings: Array<{ severity: string }>): number {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  return Math.max(0, 100 - 15 * errors - 5 * warnings);
}
