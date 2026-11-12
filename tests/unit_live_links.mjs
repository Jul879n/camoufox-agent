import assert from "node:assert/strict";
import {
  LIVE_CODE_TTL_MS, LIVE_SESSION_TTL_MS, createLiveCode, isLivePath, isLiveSessionToken, liveLinkUrl, redeemLiveCode,
} from "../dist/live-links.js";

const t0 = 1_000_000;
const { code, expiresAt } = createLiveCode(t0);
assert.equal(expiresAt, t0 + LIVE_CODE_TTL_MS);
assert.match(code, /^[A-Za-z0-9_-]{32}$/);

// single use
const token = redeemLiveCode(code, t0 + 1);
assert.ok(token && isLiveSessionToken(token, t0 + 2));
assert.equal(redeemLiveCode(code, t0 + 2), undefined, "second redeem must fail");

// expiry of the code
const late = createLiveCode(t0);
assert.equal(redeemLiveCode(late.code, t0 + LIVE_CODE_TTL_MS), undefined, "expired code must fail");

// unknown code, and the session token is not a code
assert.equal(redeemLiveCode("nope", t0), undefined);
assert.equal(redeemLiveCode(token, t0), undefined);

// session token expiry
const fresh = createLiveCode(t0);
const tok2 = redeemLiveCode(fresh.code, t0);
assert.ok(isLiveSessionToken(tok2, t0 + LIVE_SESSION_TTL_MS - 1));
assert.equal(isLiveSessionToken(tok2, t0 + LIVE_SESSION_TTL_MS), false);
assert.equal(isLiveSessionToken("x", t0), false);

// scope: only the live routes
for (const ok of ["/live", "/api/human", "/api/human/18188d02-45b1-4b0f-b06d-8c65e63fc665", "/api/sessions", "/api/sessions/sess_1/frame.jpg", "/api/sessions/sess_1/input"]) {
  assert.equal(isLivePath(ok), true, ok);
}
for (const bad of ["/mcp", "/api/tools", "/api/tools/flow_run", "/api/flows/x/runs", "/health", "/api/sessions/sess_1", "/api/human/ZZZ"]) {
  assert.equal(isLivePath(bad), false, bad);
}

// url building
assert.equal(liveLinkUrl("abc", "https://x.test/"), "https://x.test/live?ott=abc");
assert.equal(liveLinkUrl("abc", undefined), "/live?ott=abc");
console.log("unit_live_links ok");
