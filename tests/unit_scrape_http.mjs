import assert from "node:assert/strict";
import { fetchHttp, isBlocked, needsBrowser } from "../dist/scrape/http.js";

assert.equal(needsBrowser(403, "<html>ok</html>"), true);
assert.equal(needsBrowser(200, "<title>Just a moment...</title>"), true);
assert.equal(needsBrowser(200, "<body><div id=app></div><script src=a.js></script></body>"), true);
assert.equal(needsBrowser(200, "<body><p>" + "texto ".repeat(100) + "</p></body>"), false);
assert.equal(isBlocked(200, "<body><div id=app></div><script></script></body>"), false);
assert.equal(isBlocked(429, ""), true);
await assert.rejects(() => fetchHttp("http://127.0.0.1/", 5000), /private|loopback|127\.0\.0\.1/i);
console.log("unit_scrape_http ok");
