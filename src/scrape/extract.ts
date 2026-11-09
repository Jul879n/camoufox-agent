import { createMarkdownService, parseHtml } from "./vendor.js";

export type ScrapeEngine = "http" | "chrome" | "camoufox";

export interface LinkItem { href: string; text: string }

export interface ScrapeResult {
  url: string;
  status_code: number | null;
  success: boolean;
  engine: ScrapeEngine;
  error_message: string | null;
  metadata: Record<string, string>;
  markdown: string;
  images: { src: string; alt: string }[];
  links: { internal: LinkItem[]; external: LinkItem[] };
  tables: { headers: string[]; rows: string[][] }[];
  html?: string;
}

type Doc = Document;

const SKIP_PREFIXES = ["#", "javascript:", "mailto:", "tel:"];
export const JUNK_SELECTOR = "script, style, noscript, svg";

function abs(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

function metadataOf(doc: Doc, url: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const title = (doc.querySelector("title")?.textContent ?? "").trim();
  if (title) meta.title = title;
  const description = doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim();
  if (description) meta.description = description;
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim();
  if (canonical) meta.canonical = abs(canonical, url) ?? canonical;
  for (const m of Array.from(doc.querySelectorAll('meta[property^="og:"]'))) {
    const content = (m.getAttribute("content") ?? "").trim();
    const property = m.getAttribute("property");
    if (content && property) meta[property] = content;
  }
  return meta;
}

function imagesOf(doc: Doc, url: string): ScrapeResult["images"] {
  const seen = new Set<string>();
  const out: ScrapeResult["images"] = [];
  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const raw = (img.getAttribute("src") ?? "").trim();
    if (!raw || raw.startsWith("data:")) continue;
    const src = abs(raw, url);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt: img.getAttribute("alt") ?? "" });
  }
  return out;
}

function linksOf(doc: Doc, url: string): ScrapeResult["links"] {
  const internal: LinkItem[] = [];
  const external: LinkItem[] = [];
  const seen = new Set<string>();
  const base = hostOf(url);
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const raw = (a.getAttribute("href") ?? "").trim();
    if (!raw || SKIP_PREFIXES.some((p) => raw.toLowerCase().startsWith(p))) continue;
    const resolved = abs(raw, url);
    if (!resolved) continue;
    const parsed = new URL(resolved);
    parsed.hash = "";
    const href = parsed.href;
    if (seen.has(href)) continue;
    seen.add(href);
    (hostOf(href) === base ? internal : external).push({ href, text: (a.textContent ?? "").trim() });
  }
  return { internal, external };
}

function cellsOf(tr: Element, tag: "TH" | "TD"): string[] {
  return Array.from(tr.children).filter((c) => c.tagName === tag).map((c) => (c.textContent ?? "").trim());
}

function tablesOf(doc: Doc): ScrapeResult["tables"] {
  return Array.from(doc.querySelectorAll("table")).map((table) => {
    const trs = Array.from(table.querySelectorAll("tr"));
    const headerRow = trs.find((tr) => cellsOf(tr, "TH").length > 0);
    return {
      headers: headerRow ? cellsOf(headerRow, "TH") : [],
      rows: trs.filter((tr) => cellsOf(tr, "TD").length > 0).map((tr) => cellsOf(tr, "TD")),
    };
  });
}

let turndown: ReturnType<typeof createMarkdownService> | undefined;

function absolutize(doc: Doc, url: string): void {
  for (const [selector, attr] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      const raw = (el.getAttribute(attr) ?? "").trim();
      if (!raw || raw.startsWith("#") || /^(?:data|javascript|mailto|tel):/i.test(raw)) continue;
      const resolved = abs(raw, url);
      if (resolved) el.setAttribute(attr, resolved);
    }
  }
}

function markdownOf(doc: Doc, url: string): string {
  turndown ??= createMarkdownService();
  for (const el of Array.from(doc.querySelectorAll(JUNK_SELECTOR))) el.parentNode?.removeChild(el);
  absolutize(doc, url);
  const root = doc.body ?? doc.documentElement;
  if (!root) return "";
  try {
    return turndown.turndown(root.innerHTML).trim();
  } catch {
    // Malformed markup can trip the converter; plain text still beats failing the scrape.
    return (root.textContent ?? "").split(/\s+/).filter(Boolean).join(" ");
  }
}

export function extractPage(html: string, url: string, status: number | null, engine: ScrapeEngine, full = false): ScrapeResult {
  const result: ScrapeResult = {
    url,
    status_code: status,
    success: true,
    engine,
    error_message: null,
    metadata: {},
    markdown: "",
    images: [],
    links: { internal: [], external: [] },
    tables: [],
  };
  if (!html || !html.trim()) {
    result.success = false;
    result.error_message = "empty document";
    return result;
  }
  const doc = parseHtml(html);
  result.metadata = metadataOf(doc, url);
  result.images = imagesOf(doc, url);
  result.links = linksOf(doc, url);
  result.tables = tablesOf(doc);
  if (full) result.html = html;
  result.markdown = markdownOf(doc, url);
  return result;
}
