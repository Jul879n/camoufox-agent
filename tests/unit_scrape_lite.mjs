import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { scrape } from "../dist/lite.js";

const bundle = readFileSync(new URL("../dist/lite.js", import.meta.url), "utf8");
assert.ok(statSync(new URL("../dist/lite.js", import.meta.url)).size < 400 * 1024, "lite bundle must stay under 400 KB");
assert.doesNotMatch(bundle, /from\s*["'](playwright-core|camoufox-js|chalk|@modelcontextprotocol)/, "lite bundle must not import heavy packages");
const blocked = await scrape("http://127.0.0.1/", { engine: "http", useServer: false });
assert.equal(blocked.success, false);
assert.match(blocked.error_message ?? "", /private|loopback|local/i);
console.log("unit_scrape_lite ok");
