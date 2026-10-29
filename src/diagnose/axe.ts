import { createRequire } from "node:module";
import fs from "node:fs";
import type { Page } from "playwright-core";

let axeSource: string | undefined;
const loadAxe = (): string => (axeSource ??= fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8"));

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: Array<{ target: string; html: string }>;
}

export interface AxeResult { violations: AxeViolation[]; incomplete: number; passedRules: number }

async function inject(page: Page): Promise<void> {
  if (await page.evaluate(() => "axe" in window).catch(() => false)) return;
  try {
    await page.addScriptTag({ content: loadAxe() });
  } catch {
    // An inline <script> can be refused by the page CSP; evaluation through the protocol is not subject to it.
    await page.evaluate(loadAxe()).catch(() => {
      throw new Error("axe blocked by CSP");
    });
  }
  if (!await page.evaluate(() => "axe" in window)) throw new Error("axe blocked by CSP");
}

export async function runAxe(page: Page): Promise<AxeResult> {
  await inject(page);
  return page.evaluate(async () => {
    type Raw = { id: string; impact: string | null; help: string; helpUrl: string; nodes: Array<{ target: unknown[]; html: string }> };
    const axe = (window as unknown as { axe: { run(context: Document, options: unknown): Promise<{ violations: Raw[]; incomplete: Raw[]; passes: Raw[] }> } }).axe;
    const result = await axe.run(document, { resultTypes: ["violations", "incomplete"] });
    return {
      violations: result.violations.map((violation) => ({
        id: violation.id, impact: violation.impact, help: violation.help, helpUrl: violation.helpUrl,
        nodes: violation.nodes.slice(0, 5).map((node) => ({ target: node.target.join(" "), html: node.html.slice(0, 200) })),
      })),
      incomplete: result.incomplete.length,
      passedRules: result.passes.length,
    };
  });
}
