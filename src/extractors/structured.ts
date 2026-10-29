import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import type { RequestGuard, WaitStrategy } from "../types.js";
import { activateElement } from "../sequence.js";
import { settleAndAssertSafe } from "../browser-runtime.js";
import { ensureDir } from "../home.js";
import { filesRoot } from "../files.js";

export interface ExtractField {
  selector?: string;
  attr?: string;
  all?: boolean;
}

export interface ExtractSpec {
  itemSelector: string;
  fields: Record<string, ExtractField>;
  nextSelector?: string;
  maxPages: number;
  maxItems: number;
  saveAs?: string;
  maxChars: number;
}

export type ExtractRow = Record<string, string | string[] | null>;

export interface ExtractResult {
  url: string;
  count: number;
  pages: number;
  rows: ExtractRow[];
  rowsTruncated: boolean;
  savedPath?: string;
}

const URL_ATTRS = new Set(["href", "src"]);

async function extractPageRows(page: Page, spec: ExtractSpec): Promise<ExtractRow[]> {
  return page.$$eval(spec.itemSelector, (items, args) => {
    const { fields, urlAttrs } = args;
    const read = (el: Element, attr?: string): string => {
      if (!attr) return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
      if (urlAttrs.includes(attr)) return String((el as unknown as Record<string, unknown>)[attr] ?? el.getAttribute(attr) ?? "");
      return el.getAttribute(attr) ?? "";
    };
    return items.map((item) => {
      const row: Record<string, string | string[] | null> = {};
      for (const [name, field] of Object.entries(fields)) {
        if (field.all) {
          const els = field.selector ? Array.from(item.querySelectorAll(field.selector)) : [item];
          row[name] = els.map((el) => read(el, field.attr));
        } else {
          const el = field.selector ? item.querySelector(field.selector) : item;
          row[name] = el ? read(el, field.attr) : null;
        }
      }
      return row;
    });
  }, { fields: spec.fields, urlAttrs: [...URL_ATTRS] });
}

async function pageSignature(page: Page, spec: ExtractSpec): Promise<string> {
  const first = await page.$eval(spec.itemSelector, (el) => (el as HTMLElement).innerText ?? "").catch(() => "");
  return `${page.url()}|${first}`;
}

export async function runStructuredExtract(
  page: Page,
  spec: ExtractSpec,
  waitStrategy: WaitStrategy,
  requestGuard?: RequestGuard,
): Promise<ExtractResult> {
  const rows: ExtractRow[] = [];
  let pages = 0;

  while (true) {
    pages += 1;
    rows.push(...await extractPageRows(page, spec));
    if (rows.length >= spec.maxItems || pages >= spec.maxPages || !spec.nextSelector) break;
    if (!await page.$(spec.nextSelector)) break;

    const before = await pageSignature(page, spec);
    await activateElement(page, spec.nextSelector, 10000);
    await page.waitForLoadState(waitStrategy).catch(() => undefined);
    const deadline = Date.now() + 15000;
    while (await pageSignature(page, spec) === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (requestGuard) await settleAndAssertSafe(page, requestGuard);
  }

  const limited = rows.slice(0, spec.maxItems);
  const result: ExtractResult = { url: page.url(), count: limited.length, pages, rows: limited, rowsTruncated: false };

  if (spec.saveAs) {
    result.savedPath = saveRows(limited, spec);
    result.rows = limited.slice(0, 50);
    result.rowsTruncated = limited.length > 50;
  } else {
    const kept: ExtractRow[] = [];
    let size = 0;
    for (const row of limited) {
      size += JSON.stringify(row).length;
      if (size > spec.maxChars) break;
      kept.push(row);
    }
    result.rows = kept;
    result.rowsTruncated = kept.length < limited.length;
  }
  return result;
}

function csvCell(value: string | string[] | null): string {
  const text = value === null ? "" : Array.isArray(value) ? value.join(" | ") : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: ExtractRow[], columns: string[]): string {
  const lines = [columns.map((column) => csvCell(column)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column] ?? null)).join(","));
  return lines.join("\r\n") + "\r\n";
}

function saveRows(rows: ExtractRow[], spec: ExtractSpec): string {
  const dir = ensureDir(path.join(filesRoot(), "exports"));
  const saveAs = spec.saveAs as string;
  let target = path.join(dir, saveAs);
  if (fs.existsSync(target)) {
    const ext = path.extname(saveAs);
    target = path.join(dir, `${path.basename(saveAs, ext)}-${Date.now()}${ext}`);
  }
  const content = saveAs.endsWith(".csv")
    ? toCsv(rows, Object.keys(spec.fields))
    : JSON.stringify(rows, null, 2);
  fs.writeFileSync(target, content);
  return target;
}
