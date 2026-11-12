import assert from "node:assert/strict";
import { snapshotElementOutputSchema } from "../dist/schema/output.js";

// Elements inside an iframe carry `frame`, links carry `href` (SnapshotElement in payload-types.ts).
// A strict MCP client rejects the whole result if the output schema omits them.
const shape = Object.keys(snapshotElementOutputSchema.shape);
for (const key of ["tag", "selector", "href", "frame", "role", "name", "text", "bounds"]) {
  assert.ok(shape.includes(key), `snapshot element output schema must declare "${key}"`);
}
const parsed = snapshotElementOutputSchema.parse({ tag: "div", selector: "#recaptcha-anchor", frame: "iframe[src*='recaptcha']", href: "https://x.test/" });
assert.equal(parsed.frame, "iframe[src*='recaptcha']");
assert.equal(parsed.href, "https://x.test/");
console.log("unit_output_schema ok");
