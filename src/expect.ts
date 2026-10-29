import type { Page } from "playwright-core";
import type { RichCollector } from "./diagnose/collector.js";
import { resolveLocator } from "./sequence.js";
import type { SequenceAction } from "./schemas.js";
import type { SequenceActionResult } from "./types.js";

type ExpectAction = Extract<SequenceAction, { type: "expect" }>;

const DEFAULT_EXPECT_TIMEOUT_MS = 5000;
const POLL_MS = 100;
const NEEDS_EQUALS = new Set(["text", "textContains", "value", "attribute", "count", "url", "urlContains", "title", "titleContains"]);
const ELEMENT_CHECKS = new Set(["visible", "hidden", "text", "textContains", "value", "attribute", "count", "enabled", "disabled", "checked"]);

interface Evaluation { ok: boolean; actual: unknown; expected: unknown }

async function evaluate(page: Page, action: ExpectAction, collector?: RichCollector): Promise<Evaluation> {
  const equals = action.equals;
  const text = (value: string | null | undefined) => (value ?? "").trim();
  if (ELEMENT_CHECKS.has(action.check)) {
    const locator = resolveLocator(page, action.selector as string, action.frame);
    const quick = { timeout: 250 };
    switch (action.check) {
      case "visible": { const v = await locator.isVisible(); return { ok: v, actual: v ? "visible" : "not visible", expected: "visible" }; }
      case "hidden": { const v = await locator.isVisible(); return { ok: !v, actual: v ? "visible" : "hidden", expected: "hidden" }; }
      case "enabled": { const v = await locator.isEnabled(quick).catch(() => false); return { ok: v, actual: v ? "enabled" : "disabled", expected: "enabled" }; }
      case "disabled": { const v = await locator.isDisabled(quick).catch(() => false); return { ok: v, actual: v ? "disabled" : "enabled", expected: "disabled" }; }
      case "checked": { const v = await locator.isChecked(quick).catch(() => false); return { ok: v, actual: v ? "checked" : "unchecked", expected: "checked" }; }
      case "count": {
        const n = await (action.frame ? page.frameLocator(action.frame).locator(action.selector as string) : page.locator(action.selector as string)).count();
        return { ok: n === Number(equals), actual: n, expected: equals };
      }
      case "text": { const v = text(await locator.textContent(quick).catch(() => null)); return { ok: v === String(equals), actual: v, expected: equals }; }
      case "textContains": { const v = text(await locator.textContent(quick).catch(() => null)); return { ok: v.includes(String(equals)), actual: v, expected: equals }; }
      case "value": { const v = await locator.inputValue(quick).catch(() => null); return { ok: v === String(equals), actual: v, expected: equals }; }
      case "attribute": { const v = await locator.getAttribute(action.attribute as string, quick).catch(() => null); return { ok: v === String(equals), actual: v, expected: equals }; }
    }
  }
  switch (action.check) {
    case "url": return { ok: page.url() === String(equals), actual: page.url(), expected: equals };
    case "urlContains": return { ok: page.url().includes(String(equals)), actual: page.url(), expected: equals };
    case "title": { const t = await page.title(); return { ok: t === String(equals), actual: t, expected: equals }; }
    case "titleContains": { const t = await page.title(); return { ok: t.includes(String(equals)), actual: t, expected: equals }; }
  }
  const data = collector!.data();
  const list = action.check === "noConsoleErrors"
    ? [...data.console.filter((entry) => entry.type === "error").map((entry) => entry.text), ...data.pageErrors.map((entry) => entry.message)]
    : action.check === "noFailedRequests"
      ? data.network.filter((entry) => entry.failed).map((entry) => `${entry.method} ${entry.url}`)
      : data.network.filter((entry) => (entry.status ?? 0) >= 400).map((entry) => `${entry.status} ${entry.url}`);
  return { ok: list.length === 0, actual: list.length ? list.slice(0, 5).join(" | ") : "none", expected: "none" };
}

export async function runExpect(page: Page, action: ExpectAction, collector?: RichCollector, index = 0): Promise<SequenceActionResult> {
  const started = Date.now();
  const { check } = action;
  if (ELEMENT_CHECKS.has(check) && !action.selector) throw new Error(`expect ${check} requires selector`);
  if (NEEDS_EQUALS.has(check) && action.equals === undefined) throw new Error(`expect ${check} requires equals`);
  if (check === "attribute" && !action.attribute) throw new Error(`expect ${check} requires attribute`);
  if (check.startsWith("no") && !collector) throw new Error(`expect ${check} requires a browser session`);

  const deadline = started + (action.timeout ?? DEFAULT_EXPECT_TIMEOUT_MS);
  let last: Evaluation;
  for (;;) {
    last = await evaluate(page, action, collector).catch((error) => ({ ok: false, actual: error instanceof Error ? error.message : String(error), expected: action.equals }));
    if (last.ok || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const base = { index, type: "expect", selector: action.selector, durationMs: Date.now() - started };
  if (last.ok) return { ...base, status: "ok" };
  const message = `Expect ${check} failed: expected ${last.expected}, got ${last.actual}`;
  if (!action.soft) throw new Error(message);
  return { ...base, status: "failed", message, expected: String(last.expected), actual: String(last.actual) };
}
