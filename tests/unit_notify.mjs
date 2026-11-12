import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const SNIPPET = 'import {notifyHuman} from "./dist/notify.js"; notifyHuman({event:"human_pending",sessionId:"s1",reason:"captcha",kind:"human",flow:"demo",url:"https://example.com/a?token=abc"}); setTimeout(()=>{},1500)';

function runChild(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", SNIPPET], { env, stdio: "ignore" });
    child.on("exit", resolve);
  });
}

const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200).end("ok");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const base = { ...process.env };
delete base.CAMOUFOX_AGENT_NOTIFY_URL;
delete base.CAMOUFOX_AGENT_NOTIFY_SECRET;
delete base.CAMOUFOX_AGENT_PUBLIC_URL;

await runChild({
  ...base,
  CAMOUFOX_AGENT_NOTIFY_URL: `http://127.0.0.1:${port}/webhooks/camoufox`,
  CAMOUFOX_AGENT_NOTIFY_SECRET: "s3cret",
  CAMOUFOX_AGENT_PUBLIC_URL: "https://x.test/",
});
assert.equal(received.length, 1, "one webhook expected");
const { headers, body } = received[0];
const payload = JSON.parse(body);
assert.match(payload.liveUrl, /^https:\/\/x\.test\/live\?ott=[A-Za-z0-9_-]{32}$/);
assert.ok(payload.message.includes(payload.liveUrl) && !payload.message.includes("s3cret"));
assert.ok(payload.message.includes("«demo»") && payload.message.includes("s1"));
assert.ok(!body.includes("abc"), "url must be redacted");
const ts = headers["x-webhook-timestamp"];
assert.ok(/^\d+$/.test(ts));
assert.equal(headers["x-webhook-signature-v2"], createHmac("sha256", "s3cret").update(`${ts}.${body}`).digest("hex"));

await runChild(base);
assert.equal(received.length, 1, "no request without CAMOUFOX_AGENT_NOTIFY_URL");

// two targets -> two webhooks, each with its own one-time link
await runChild({
  ...base,
  CAMOUFOX_AGENT_NOTIFY_URL: `http://127.0.0.1:${port}/a, http://127.0.0.1:${port}/b`,
  CAMOUFOX_AGENT_PUBLIC_URL: "https://x.test",
});
assert.equal(received.length, 3, "two more webhooks expected");
const [l1, l2] = received.slice(1).map((r) => JSON.parse(r.body).liveUrl);
assert.ok(l1 && l2 && l1 !== l2, "each target must get a distinct link");

server.close();
console.log("unit_notify ok");
