import type { FlowRun } from "./flows.js";

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const seconds = (ms: number): string => (ms / 1000).toFixed(3);

export function toJunit(runs: FlowRun[]): string {
  const suites = runs.map((run) => {
    const failures = run.steps.filter((step) => step.status === "failed").length;
    const errors = run.steps.filter((step) => step.status === "error").length + (run.steps.length === 0 && run.error ? 1 : 0);
    const cases = run.steps.map((step) => {
      const name = escapeXml(`${step.index} ${step.type}`);
      if (step.status === "failed") return `    <testcase name="${name}" time="0"><failure message="${escapeXml(step.message ?? "failed")}"/></testcase>`;
      if (step.status === "error") return `    <testcase name="${name}" time="0"><error message="${escapeXml(step.error ?? run.error ?? "error")}"/></testcase>`;
      return `    <testcase name="${name}" time="0"/>`;
    });
    if (run.steps.length === 0 && run.error) cases.push(`    <testcase name="setup" time="0"><error message="${escapeXml(run.error)}"/></testcase>`);
    return `  <testsuite name="${escapeXml(run.name)}" tests="${cases.length}" failures="${failures}" errors="${errors}" time="${seconds(run.durationMs)}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join("\n")}\n</testsuites>\n`;
}
