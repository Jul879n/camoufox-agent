// Bundled into dist/scrape/vendor.js by scripts/bundle-vendor.mjs so the published package ships ~300 KB
// instead of turndown + domino (domino alone is 8.6 MB installed, mostly its own tests).
import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export function parseHtml(html) {
  return domino.createDocument(html);
}

export function createMarkdownService() {
  return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" }).use(gfm);
}
