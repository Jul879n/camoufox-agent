import type { Page } from "playwright-core";

// Runs inside the page: navigation timing, paint, vitals gathered by VITALS_SCRIPT and DOM statistics.
const READ_PERF = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const fcpEntry = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
  const cfx = window.__cfx || {};
  const supported = cfx.supported || [];
  let nodes = 0, maxDepth = 0;
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  const depthOf = (el) => { let d = 0; while (el.parentElement) { d++; el = el.parentElement; } return d; };
  while (walker.nextNode()) { nodes++; if (nodes % 25 === 0) maxDepth = Math.max(maxDepth, depthOf(walker.currentNode)); }
  const round = (n) => (typeof n === "number" ? Math.round(n) : null);
  return {
    navigation: nav ? {
      type: nav.type, protocol: nav.nextHopProtocol,
      dnsMs: round(nav.domainLookupEnd - nav.domainLookupStart), connectMs: round(nav.connectEnd - nav.connectStart),
      tlsMs: nav.secureConnectionStart > 0 ? round(nav.connectEnd - nav.secureConnectionStart) : 0,
      ttfbMs: round(nav.responseStart), responseMs: round(nav.responseEnd - nav.responseStart),
      domInteractiveMs: round(nav.domInteractive), domContentLoadedMs: round(nav.domContentLoadedEventEnd), loadMs: round(nav.loadEventEnd),
      transferBytes: nav.transferSize, encodedBytes: nav.encodedBodySize, decodedBytes: nav.decodedBodySize, redirects: nav.redirectCount,
    } : null,
    vitals: {
      fcpMs: fcpEntry ? round(fcpEntry.startTime) : null,
      lcp: cfx.lcp || null,
      cls: supported.includes("layout-shift") ? Math.round(cfx.cls * 1000) / 1000 : null,
      inpMs: supported.includes("event") ? (cfx.inp ?? null) : null,
      longTasks: supported.includes("longtask") ? { count: (cfx.longTasks || []).length, totalMs: (cfx.longTasks || []).reduce((a, t) => a + t.durationMs, 0), worst: (cfx.longTasks || []).slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 5) } : null,
      unsupportedInThisBrowser: ["largest-contentful-paint", "layout-shift", "longtask", "event"].filter((t) => !supported.includes(t)),
    },
    dom: {
      nodes, approxMaxDepth: maxDepth,
      scripts: document.scripts.length, stylesheets: document.styleSheets.length,
      images: document.images.length, iframes: document.querySelectorAll("iframe").length,
      inlineScriptBytes: Array.from(document.scripts).filter((s) => !s.src).reduce((a, s) => a + s.text.length, 0),
    },
  };
})()`;

export async function readPerf(page: Page): Promise<unknown> {
  return page.evaluate(READ_PERF);
}
