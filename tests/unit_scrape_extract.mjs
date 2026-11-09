import assert from "node:assert/strict";
import { extractPage } from "../dist/scrape/extract.js";

const HTML = `<html><head><title> T </title>
<meta property="og:title" content="OG">
<script>var secreto = 1;</script></head>
<body><img src="/a.png" alt="A"><img src="/a.png" alt="A">
<a href="/x#f">X</a><a href="https://otro.cl/">O</a><a href="mailto:a@b">M</a>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
</body></html>`;

const d = extractPage(HTML, "https://www.sitio.cl/p", 200, "http");
assert.equal(d.success, true);
assert.equal(d.status_code, 200);
assert.equal(d.engine, "http");
assert.equal(d.metadata.title, "T");
assert.equal(d.metadata["og:title"], "OG");
assert.deepEqual(d.images, [{ src: "https://www.sitio.cl/a.png", alt: "A" }]);
assert.deepEqual(d.links.internal, [{ href: "https://www.sitio.cl/x", text: "X" }]);
assert.equal(d.links.external.length, 1);
assert.deepEqual(d.tables, [{ headers: ["A", "B"], rows: [["1", "2"]] }]);
assert.ok(!d.markdown.includes("secreto"));
assert.ok(!("html" in d));
assert.deepEqual(Object.keys(d), ["url", "status_code", "success", "engine", "error_message", "metadata", "markdown", "images", "links", "tables"]);

assert.equal(extractPage(HTML, "https://www.sitio.cl/p", 200, "http", true).html, HTML);

for (const empty of ["", "   \n"]) {
  const e = extractPage(empty, "https://x.cl", 200, "http");
  assert.equal(e.success, false);
  assert.equal(e.error_message, "empty document");
}
console.log("unit_scrape_extract ok");
