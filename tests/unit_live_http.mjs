import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// End to end over HTTP: live_link -> prefetch does not burn it -> redeem once -> scoped session token.
const port = 39000 + (process.pid % 900);
const base = `http://127.0.0.1:${port}`;
const master = "master-test-token";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-live-"));
const server = spawn(process.execPath, ["dist/cli.js", "serve", "--host", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, CAMOUFOX_AGENT_TOKEN: master, CAMOUFOX_AGENT_HOME: home, CAMOUFOX_AGENT_PUBLIC_URL: "https://x.test" },
  stdio: "ignore",
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}
const call = (url, init = {}) => fetch(`${base}${url}`, init);
const auth = (t) => ({ authorization: `Bearer ${t}` });

try {
  await waitUp();

  // live_link needs the master token
  assert.equal((await call("/api/tools/live_link", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const made = await call("/api/tools/live_link", { method: "POST", headers: { ...auth(master), "content-type": "application/json" }, body: "{}" });
  assert.equal(made.status, 200);
  const payload = await made.json();
  const link = payload.structuredContent?.url ?? payload.url;
  const code = new URL(link).searchParams.get("ott");
  assert.match(link, /^https:\/\/x\.test\/live\?ott=/);

  // a link preview (GET) shows the page and does not consume the code
  for (let i = 0; i < 3; i++) {
    const page = await call(`/live?ott=${code}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Abrir vista en vivo/);
  }

  // first redeem works, second fails
  const post = (c) => call("/api/live-links/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) });
  const first = await post(code);
  assert.equal(first.status, 200);
  const { token } = await first.json();
  assert.equal((await post(code)).status, 404, "one-time code must not redeem twice");

  // the session token opens only the live routes
  assert.equal((await call("/api/human", { headers: auth(token) })).status, 200);
  assert.equal((await call("/api/sessions", { headers: auth(token) })).status, 200);
  assert.equal((await call(`/live?token=${token}`)).status, 200);
  assert.equal((await call("/api/tools", { headers: auth(token) })).status, 401);
  assert.equal((await call("/api/tools/live_link", { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await call("/mcp", { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: "{}" })).status, 401);

  // no token at all, and a wrong code
  assert.equal((await call("/live")).status, 401);
  assert.equal((await post("nope")).status, 404);
  console.log("unit_live_http ok");
} finally {
  server.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
