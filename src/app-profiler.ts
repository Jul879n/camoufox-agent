import type { Page } from "playwright-core";
import { runSequenceAction } from "./sequence.js";
import { buildSuccessContent, buildToolError } from "./responses.js";
import { getSession, runSessionExclusive, sessionSanitizedError } from "./sessions.js";
import type { ProfileAppToolInput } from "./schema/tools.js";
import type { SessionRecord } from "./types.js";
import { redactDeep, redactUrl } from "./utils.js";

const safeHref = (href: string): string => (/^https?:/i.test(href) ? redactUrl(href) : href);

// Installed on demand (not with every session) because wrapping addEventListener/setTimeout
// is a script-visible change. It counts what is added from now on, which is all growth needs.
const COUNTERS_SCRIPT = `(() => {
  const s = window.__cfx = window.__cfx || {};
  if (s.counters) return;
  s.counters = true; s.listeners = 0; s.intervals = 0; s.timeouts = 0;
  const intervals = new Set(), timeouts = new Set();
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) { if (listener) s.listeners++; return add.call(this, type, listener, options); };
  EventTarget.prototype.removeEventListener = function (type, listener, options) { if (listener && s.listeners > 0) s.listeners--; return remove.call(this, type, listener, options); };
  const setI = window.setInterval, clearI = window.clearInterval, setT = window.setTimeout, clearT = window.clearTimeout;
  window.setInterval = function (...args) { const id = setI.apply(this, args); intervals.add(id); s.intervals = intervals.size; return id; };
  window.clearInterval = function (id) { intervals.delete(id); s.intervals = intervals.size; return clearI.call(this, id); };
  window.setTimeout = function (fn, ...rest) {
    let id;
    const wrapped = typeof fn === "function" ? function (...a) { timeouts.delete(id); s.timeouts = timeouts.size; return fn.apply(this, a); } : fn;
    id = setT.call(this, wrapped, ...rest); timeouts.add(id); s.timeouts = timeouts.size; return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); s.timeouts = timeouts.size; return clearT.call(this, id); };
})()`;

const READ_COUNTERS = `(() => ({ domNodes: document.getElementsByTagName("*").length, listeners: (window.__cfx || {}).listeners || 0, intervals: (window.__cfx || {}).intervals || 0, timeouts: (window.__cfx || {}).timeouts || 0 }))()`;

type Sample = { domNodes: number; listeners: number; intervals: number; timeouts: number };

const slope = (values: number[]): number => {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => { num += (x - meanX) * (y - meanY); den += (x - meanX) ** 2; });
  return den === 0 ? 0 : Math.round((num / den) * 1000) / 1000;
};

async function runActions(session: SessionRecord, actions: NonNullable<ProfileAppToolInput["actions"]>): Promise<void> {
  for (const [index, action] of actions.entries()) {
    await runSequenceAction(session.page, action, index, session.rawUrls, session.secrets, session.rich);
  }
}

async function profileLeaks(session: SessionRecord, input: ProfileAppToolInput) {
  const page = session.page;
  await session.context.addInitScript(COUNTERS_SCRIPT);
  await page.evaluate(COUNTERS_SCRIPT);
  const samples: Sample[] = [await page.evaluate(READ_COUNTERS) as Sample];
  for (let i = 0; i < (input.iterations ?? 5); i += 1) {
    await runActions(session, input.actions ?? []);
    await page.waitForTimeout(50);
    samples.push(await page.evaluate(READ_COUNTERS) as Sample);
  }
  const growthPerIteration = {
    domNodes: slope(samples.map((sample) => sample.domNodes)),
    listeners: slope(samples.map((sample) => sample.listeners)),
    intervals: slope(samples.map((sample) => sample.intervals)),
    timeouts: slope(samples.map((sample) => sample.timeouts)),
  };
  return {
    mode: "leaks",
    samples,
    growthPerIteration,
    suspectedLeak: growthPerIteration.domNodes > 0.5 || growthPerIteration.listeners > 0.5 || growthPerIteration.intervals > 0.1,
    note: "Firefox does not expose the JS heap; leaks are inferred from DOM nodes, listeners and timers added since profiling started.",
  };
}

interface RuleReading { key: string; selector: string; used: boolean }
interface SheetReading { href: string; inaccessible: boolean; rules: RuleReading[] }

const READ_CSS = `(() => {
  const strip = (selector) => selector.replace(/::?(?:hover|focus|focus-within|focus-visible|active|visited|target|before|after|first-line|first-letter|placeholder|selection|-[a-z-]+)(?:\\([^)]*\\))?/gi, "");
  const matches = (selectorText) => selectorText.split(",").some((part) => {
    const cleaned = strip(part).trim();
    if (!cleaned) return true;
    try { return document.querySelector(cleaned) !== null; } catch (e) { return true; }
  });
  const walk = (rules, prefix, out) => Array.from(rules).forEach((rule, i) => {
    if (rule.selectorText !== undefined) out.push({ key: prefix + i, selector: rule.selectorText, used: matches(rule.selectorText) });
    else if (rule.cssRules) walk(rule.cssRules, prefix + i + ".", out);
  });
  return Array.from(document.styleSheets).map((sheet, index) => {
    const href = sheet.href || "inline#" + index;
    try { const rules = []; walk(sheet.cssRules, index + ":", rules); return { href, inaccessible: false, rules }; }
    catch (e) { return { href, inaccessible: true, rules: [] }; }
  });
})()`;

async function profileCssCoverage(session: SessionRecord, input: ProfileAppToolInput) {
  const page: Page = session.page;
  const merged = new Map<string, { href: string; rules: Map<string, RuleReading> }>();
  const inaccessible = new Set<string>();
  const iterations = input.actions?.length ? (input.iterations ?? 5) : 1;
  for (let i = 0; i < iterations; i += 1) {
    await runActions(session, input.actions ?? []);
    for (const sheet of await page.evaluate(READ_CSS) as SheetReading[]) {
      if (sheet.inaccessible) { inaccessible.add(safeHref(sheet.href)); continue; }
      const entry = merged.get(sheet.href) ?? { href: sheet.href, rules: new Map() };
      merged.set(sheet.href, entry);
      for (const rule of sheet.rules) {
        const previous = entry.rules.get(rule.key);
        entry.rules.set(rule.key, { ...rule, used: rule.used || previous?.used === true });
      }
    }
  }
  const sheets = [...merged.values()].map((sheet) => {
    const rules = [...sheet.rules.values()];
    const used = rules.filter((rule) => rule.used).length;
    return {
      href: safeHref(sheet.href),
      totalRules: rules.length,
      usedRules: used,
      unusedPct: rules.length ? Math.round((1000 * (rules.length - used)) / rules.length) / 10 : 0,
      unusedSelectors: rules.filter((rule) => !rule.used).slice(0, 20).map((rule) => rule.selector),
    };
  });
  return { mode: "cssCoverage", sheets, inaccessible: [...inaccessible], note: "Rules with only pseudo-state selectors (:hover, :focus...) are treated as used." };
}

export async function handleProfileApp(input: ProfileAppToolInput) {
  let session: SessionRecord | undefined;
  try {
    session = await getSession(input.sessionId);
    const current = session;
    return await runSessionExclusive(current, async () => {
      const result = input.mode === "leaks" ? await profileLeaks(current, input) : await profileCssCoverage(current, input);
      return buildSuccessContent(redactDeep({ sessionId: current.id, ...result }, current.secrets));
    });
  } catch (error) {
    return buildToolError(`Failed to profile app. Error: ${sessionSanitizedError(error, session)}`);
  }
}
