import type { BrowserContext, Page } from "playwright-core";
import { redactUrl } from "../utils.js";
import type { NetworkEntry } from "./collector.js";

interface Finding { severity: "error" | "warning" | "info"; code: string; message: string }

const READ_PAGE = `(() => {
  const meta = (n) => (document.querySelector('meta[name="' + n + '"]') || {}).content || null;
  const imgs = Array.from(document.images);
  const heads = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => Number(h.tagName[1]));
  return {
    title: document.title, lang: document.documentElement.lang || null,
    description: meta("description"), viewport: meta("viewport"), robots: meta("robots"),
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
    ogTitle: (document.querySelector('meta[property="og:title"]') || {}).content || null,
    h1Count: heads.filter((l) => l === 1).length,
    headingSkips: heads.some((l, i) => i > 0 && l - heads[i - 1] > 1),
    imagesWithoutAlt: imgs.filter((i) => !i.hasAttribute("alt")).length,
    imagesWithoutSize: imgs.filter((i) => !(i.getAttribute("width") && i.getAttribute("height"))).length,
    imagesTotal: imgs.length,
    inputsWithoutLabel: Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea")).filter((el) => !el.labels || el.labels.length === 0).filter((el) => !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")).length,
    linksWithoutText: Array.from(document.querySelectorAll("a[href]")).filter((a) => !(a.textContent || "").trim() && !a.getAttribute("aria-label") && !a.querySelector("img[alt]")).length,
    buttonsWithoutText: Array.from(document.querySelectorAll("button")).filter((b) => !(b.textContent || "").trim() && !b.getAttribute("aria-label")).length,
    target_blank_without_noopener: Array.from(document.querySelectorAll('a[target="_blank"]')).filter((a) => !/noopener|noreferrer/.test(a.rel)).length,
    deprecated: ["center", "font", "marquee", "frame"].filter((t) => document.querySelector(t)),
    domNodes: document.getElementsByTagName("*").length,
  };
})()`;

export async function runAudit(page: Page, context: BrowserContext, network: NetworkEntry[], mainHeaders: Record<string, string>) {
  const info = await page.evaluate(READ_PAGE) as {
    title: string; lang: string | null; description: string | null; viewport: string | null; canonical: string | null;
    h1Count: number; headingSkips: boolean; imagesWithoutAlt: number; imagesWithoutSize: number; imagesTotal: number;
    inputsWithoutLabel: number; linksWithoutText: number; buttonsWithoutText: number; target_blank_without_noopener: number;
    deprecated: string[]; domNodes: number;
  };
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], code: string, message: string) => findings.push({ severity, code, message });
  const url = page.url();
  const https = url.startsWith("https://");

  if (!info.title) add("error", "seo.title", "Missing <title>.");
  else if (info.title.length > 65) add("info", "seo.title-length", `Title is ${info.title.length} chars (>65 may be truncated).`);
  if (!info.description) add("warning", "seo.description", "Missing meta description.");
  if (info.h1Count !== 1) add("warning", "seo.h1", `Expected one <h1>, found ${info.h1Count}.`);
  if (!info.lang) add("warning", "a11y.lang", "<html> has no lang attribute.");
  if (!info.viewport) add("warning", "mobile.viewport", "Missing meta viewport.");
  if (!info.canonical) add("info", "seo.canonical", "No canonical link.");
  if (info.headingSkips) add("info", "a11y.heading-order", "Heading levels skip (e.g. h2 -> h4).");
  if (info.imagesWithoutAlt) add("warning", "a11y.img-alt", `${info.imagesWithoutAlt} image(s) without alt.`);
  if (info.imagesWithoutSize) add("info", "perf.img-size", `${info.imagesWithoutSize} image(s) without width/height (layout shift).`);
  if (info.inputsWithoutLabel) add("warning", "a11y.label", `${info.inputsWithoutLabel} form control(s) without label.`);
  if (info.linksWithoutText) add("warning", "a11y.link-text", `${info.linksWithoutText} link(s) without accessible text.`);
  if (info.buttonsWithoutText) add("warning", "a11y.button-text", `${info.buttonsWithoutText} button(s) without accessible text.`);
  if (info.target_blank_without_noopener) add("info", "security.noopener", `${info.target_blank_without_noopener} target=_blank link(s) without rel=noopener.`);
  if (info.deprecated.length) add("info", "html.deprecated", `Deprecated tags: ${info.deprecated.join(", ")}.`);
  if (info.domNodes > 1500) add("warning", "perf.dom-size", `Large DOM: ${info.domNodes} nodes.`);

  const securityHeaders: Array<[string, Finding["severity"]]> = [["content-security-policy", "warning"], ["x-content-type-options", "info"], ["referrer-policy", "info"], ["permissions-policy", "info"]];
  if (https) securityHeaders.push(["strict-transport-security", "warning"]);
  for (const [header, severity] of securityHeaders) {
    if (!mainHeaders[header]) add(severity, `security.${header}`, `Main document has no ${header} header.`);
  }
  if (!mainHeaders["x-frame-options"] && !/frame-ancestors/.test(mainHeaders["content-security-policy"] ?? "")) {
    add("info", "security.clickjacking", "No X-Frame-Options or CSP frame-ancestors.");
  }

  if (https) {
    const mixed = network.filter((entry) => entry.url.startsWith("http://"));
    if (mixed.length) add("error", "security.mixed-content", `${mixed.length} request(s) over http on an https page: ${mixed.slice(0, 3).map((m) => m.url).join(", ")}`);
  }

  const cookies = (await context.cookies(url).catch(() => [])).map((cookie) => ({
    name: cookie.name, domain: cookie.domain, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, session: cookie.expires === -1,
  }));
  for (const cookie of cookies) {
    if (https && !cookie.secure) add("warning", "security.cookie-secure", `Cookie "${cookie.name}" lacks Secure.`);
    if (!cookie.httpOnly) add("info", "security.cookie-httponly", `Cookie "${cookie.name}" is readable by scripts (no HttpOnly).`);
    if (cookie.sameSite === "None" && !cookie.secure) add("warning", "security.cookie-samesite", `Cookie "${cookie.name}" is SameSite=None without Secure.`);
  }

  const bad = network.filter((entry) => entry.failed || (entry.status ?? 0) >= 400);
  for (const entry of bad.slice(0, 20)) add("error", "network.broken-resource", `${entry.status ?? entry.errorText} ${entry.method} ${entry.url}`);

  const order = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    url: redactUrl(url),
    summary: { errors: findings.filter((f) => f.severity === "error").length, warnings: findings.filter((f) => f.severity === "warning").length, info: findings.filter((f) => f.severity === "info").length },
    findings,
    page: { title: info.title, lang: info.lang, description: info.description, canonical: info.canonical, h1Count: info.h1Count, imagesTotal: info.imagesTotal, domNodes: info.domNodes },
    securityHeaders: Object.fromEntries(securityHeaders.map(([header]) => [header, mainHeaders[header] ?? null])),
    cookies,
  };
}
