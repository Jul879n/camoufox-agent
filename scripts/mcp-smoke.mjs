#!/usr/bin/env node
// Escenarios E2E contra el servidor stdio: node scripts/mcp-smoke.mjs <escenario>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { startFixtureSite } from "../tests/fixtures/site.mjs";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = await startFixtureSite();
const HEROKU = site.url;

const scenarios = {
  async upload(call) {
    const r = await call("browse_sequence", {
      url: `${HEROKU}/upload`,
      actions: [
        { type: "upload", selector: "#file-upload", files: [path.join(ROOT, "tests/fixtures/files/sample.txt")] },
        { type: "click", selector: "#file-submit" },
        { type: "waitFor", selector: "#uploaded-files" },
      ],
    });
    return { result: r, expect: "File Uploaded!" };
  },

  async profile(call) {
    const login = async (fill) => {
      const start = await call("browse_session_start", { profile: "smoke-profile" });
      if (start.expiresAt !== null) throw new Error("expiresAt debe ser null");
      const sessionId = start.sessionId;
      await call("browse_session_navigate", { sessionId, url: `${HEROKU}/login` });
      for (const action of fill) await call("browse_session_action", { sessionId, action });
      return sessionId;
    };
    const s1 = await login([
      { type: "fill", selector: "#username", value: "tomsmith" },
      { type: "fill", selector: "#password", value: "SuperSecretPassword!" },
      { type: "click", selector: "button[type=submit]" },
      { type: "waitFor", selector: "h2" },
    ]);
    await call("browse_session_close", { sessionId: s1 });
    const start = await call("browse_session_start", { profile: "smoke-profile" });
    const nav = await call("browse_session_navigate", { sessionId: start.sessionId, url: `${HEROKU}/secure` });
    await call("browse_session_close", { sessionId: start.sessionId });
    await call("browse_profile_delete", { name: "smoke-profile" });
    return { result: nav, expect: "Secure Area" };
  },

  async secret(call) {
    const start = await call("browse_session_start", {});
    const sessionId = start.sessionId;
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/login` });
    const outs = [];
    for (const action of [
      { type: "fill", selector: "#username", value: "tomsmith" },
      { type: "fillSecret", selector: "#password", secret: "heroku-pass" },
      { type: "click", selector: "button[type=submit]" },
      { type: "waitFor", selector: "h2" },
    ]) outs.push(await call("browse_session_action", { sessionId, action }));
    await call("browse_session_close", { sessionId });
    return { result: outs, expect: "Secure Area", forbid: "SuperSecretPassword" };
  },

  async extract(call) {
    const filesDir = env.CAMOUFOX_MCP_FILES_DIR;
    const target = path.join(filesDir, "exports", "quotes.csv");
    fs.rmSync(target, { force: true });
    const r = await call("browse_extract", {
      url: `${HEROKU}/quotes`,
      itemSelector: ".quote",
      fields: { text: { selector: ".text" }, author: { selector: ".author" }, tags: { selector: ".tag", all: true } },
      nextSelector: "li.next a",
      maxPages: 3,
      saveAs: "quotes.csv",
    });
    const lines = fs.readFileSync(r.savedPath, "utf8").trimEnd().split("\r\n").length;
    if (r.count !== 30 || r.pages !== 3 || lines !== 31) throw new Error(`count=${r.count} pages=${r.pages} lines=${lines}`);
    return { result: { count: r.count, pages: r.pages, lines, savedPath: r.savedPath }, expect: '"count":30' };
  },

  async flow(call) {
    const flow = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/flows/heroku-login.json"), "utf8"));
    flow.startUrl = `${HEROKU}/login`;
    await call("flow_save", { name: "heroku-login", flow });
    const run = await call("flow_run", { name: "heroku-login" });
    const runs = fs.readdirSync(path.join(env.CAMOUFOX_AGENT_HOME, "runs", "heroku-login"));
    if (!run.ok || runs.length < 1) throw new Error("flow_run falló");
    await call("browse_profile_delete", { name: "herokuapp" });
    return { result: run, expect: "Secure Area" };
  },
};

const name = process.argv[2];
if (name === "http") {
  // Requiere `serve` corriendo: CAMOUFOX_AGENT_TOKEN=t node dist/cli.js serve
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const token = process.env.CAMOUFOX_AGENT_TOKEN ?? "t";
  const http = new Client({ name: "smoke-http", version: "0" });
  await http.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:9420/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const names = (await http.listTools()).tools.map((t) => t.name);
  console.log(names.join("\n"));
  await http.close();
  await site.close();
  const missing = ["browse_extract", "flow_run"].filter((n) => !names.includes(n));
  if (missing.length) { console.error(`FALTAN: ${missing}`); process.exit(1); }
  process.exit(0);
}
if (!scenarios[name]) {
  await site.close();
  console.error(`Escenarios: ${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}

const env = { ...process.env, CAMOUFOX_MCP_ALLOWED_PRIVATE_HOSTS: "localhost" };
env.CAMOUFOX_AGENT_HOME ??= path.join(ROOT, ".e2e-home");
env.CAMOUFOX_MCP_FILES_DIR ??= path.join(ROOT, "tests/fixtures/files");
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(ROOT, "dist/cli.js")], env, stderr: "ignore" }));

let failed = false;
async function call(tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const out = res.structuredContent ?? res.content;
  if (res.isError) { failed = true; console.error(JSON.stringify(out, null, 2)); }
  return out;
}
try {
  const { result, expect, forbid } = await scenarios[name](call, client);
  const text = JSON.stringify(result);
  console.log(JSON.stringify(result, null, 2).slice(0, 20000));
  if (expect && !text.includes(expect)) { console.error(`FALTA: ${expect}`); failed = true; }
  if (forbid && text.includes(forbid)) { console.error(`FILTRADO: ${forbid}`); failed = true; }
} catch (e) { console.error(e); failed = true; }
await client.close();
await site.close();
process.exit(failed ? 1 : 0);
