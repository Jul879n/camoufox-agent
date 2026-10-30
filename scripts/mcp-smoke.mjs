#!/usr/bin/env node
// Escenarios E2E contra el servidor stdio: node scripts/mcp-smoke.mjs <escenario>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BIG_SIZE, startFixtureSite } from "../tests/fixtures/site.mjs";
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

  async diagnose(call) {
    const report = await call("browse_diagnose", { url: `${HEROKU}/broken`, settleMs: 800, emulation: { colorScheme: "dark" } });
    const inspect = await call("browse_inspect", { url: `${HEROKU}/broken`, selector: "#box", properties: ["width", "color"] });
    const checks = [
      report.console?.uncaughtErrors?.some((e) => e.message.includes("fallo async")),
      report.console?.entries?.some((e) => e.type === "error" && e.text.includes("boom")),
      report.network?.httpErrors?.some((e) => e.url.endsWith("/missing.png")),
      report.audit?.findings?.some((f) => f.code === "seo.h1"),
      report.audit?.findings?.some((f) => f.code === "a11y.img-alt"),
      report.perf?.navigation?.loadMs >= 0,
      inspect.styles?.width === "120px" || inspect.styles?.width === "144px",
      inspect.matchedRules?.some((r) => r.selector === ".box"),
    ];
    if (checks.some((c) => !c)) throw new Error(`checks: ${JSON.stringify(checks)}`);
    return { result: { vitals: report.perf.vitals, audit: report.audit.summary, box: inspect.box }, expect: '"errors"' };
  },

  async expect(call, client) {
    const start = await call("browse_session_start", {});
    const sessionId = start.sessionId;
    const act = (action) => call("browse_session_action", { sessionId, action });
    const raw = (action) => client.callTool({ name: "browse_session_action", arguments: { sessionId, action } });
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    await act({ type: "click", selector: "#inc" });
    await act({ type: "expect", check: "text", selector: "#count", equals: "1" });
    const hard = await raw({ type: "expect", check: "text", selector: "#count", equals: "9", timeout: 300 });
    if (!hard.isError || !JSON.stringify(hard.content).includes("expected 9, got 1")) throw new Error("expect duro debía fallar con expected 9, got 1");
    const soft = await act({ type: "expect", check: "text", selector: "#count", equals: "9", timeout: 300, soft: true });
    if (soft.action?.status !== "failed") throw new Error("soft debía dar status failed");
    await act({ type: "click", selector: "#bad" });
    const bad = await raw({ type: "expect", check: "noConsoleErrors", timeout: 300 });
    if (!bad.isError) throw new Error("noConsoleErrors debía fallar");
    await act({ type: "clearDiagnostics" });
    await act({ type: "expect", check: "noConsoleErrors", timeout: 300 });
    await call("browse_session_close", { sessionId });
    return { result: { soft: soft.action }, expect: '"failed"' };
  },

  async "flow-test"(call) {
    await call("flow_save", { name: "app-test", flow: { startUrl: `${HEROKU}/app`, actions: [
      { type: "click", selector: "#inc" },
      { type: "expect", check: "text", selector: "#count", equals: "1" },
      { type: "expect", check: "text", selector: "#count", equals: "9", soft: true, timeout: 300 },
      { type: "expect", check: "text", selector: "#title", equals: "Demo" },
    ] } });
    const run = await call("flow_run", { name: "app-test" });
    if (run.ok !== false || run.steps[2]?.status !== "failed" || run.steps[3]?.status !== "passed") throw new Error(`pasos inesperados: ${JSON.stringify(run.steps)}`);
    if (!run.failure?.screenshot || !fs.existsSync(run.failure.screenshot)) throw new Error("falta screenshot de falla");
    return { result: run, expect: '"failed"' };
  },

  async "tabs-dialogs"(call) {
    const { sessionId } = await call("browse_session_start", {});
    const act = (action) => call("browse_session_action", { sessionId, action });
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    await act({ type: "click", selector: "#pop" });
    await new Promise((r) => setTimeout(r, 1000));
    let tabs = await call("browse_session_tabs", { sessionId, action: "list" });
    if (tabs.tabs.length !== 2) throw new Error(`esperaba 2 pestañas: ${JSON.stringify(tabs)}`);
    await call("browse_session_tabs", { sessionId, action: "select", index: 1 });
    tabs = await call("browse_session_tabs", { sessionId, action: "close", index: 1 });
    if (tabs.tabs.length !== 1 || !tabs.tabs[0].active) throw new Error(`esperaba 1 pestaña activa: ${JSON.stringify(tabs)}`);
    await act({ type: "dialog", accept: true });
    await act({ type: "click", selector: "#ask" });
    await act({ type: "expect", check: "text", selector: "#out", equals: "si" });
    await act({ type: "dialog", accept: false });
    await act({ type: "click", selector: "#ask" });
    await act({ type: "expect", check: "text", selector: "#out", equals: "no" });
    const report = await call("browse_diagnose", { sessionId, sections: ["console"] });
    if (report.console?.dialogs?.length !== 2) throw new Error(`esperaba 2 diálogos: ${JSON.stringify(report.console?.dialogs)}`);
    await call("browse_session_close", { sessionId });
    return { result: report.console.dialogs, expect: "Seguro" };
  },

  async drag(call) {
    const { sessionId } = await call("browse_session_start", {});
    const act = (action) => call("browse_session_action", { sessionId, action });
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    await act({ type: "drag", selector: "#src", target: "#dst" });
    await act({ type: "expect", check: "text", selector: "#out", equals: "dropped" });
    const closed = await call("browse_session_close", { sessionId });
    return { result: closed, expect: '"closed":true' };
  },

  async network(call, client) {
    const { sessionId } = await call("browse_session_start", {});
    const act = (action) => call("browse_session_action", { sessionId, action });
    const raw = (action) => client.callTool({ name: "browse_session_action", arguments: { sessionId, action } });
    const go = () => call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    await go();
    // petición real y su detalle
    await act({ type: "click", selector: "#load" });
    await act({ type: "expect", check: "text", selector: "#out", equals: '{"items":[1,2,3]}' });
    const diag = await call("browse_diagnose", { sessionId, sections: ["network"], settleMs: 200 });
    const real = diag.network.entries.find((e) => e.url.endsWith("/api/data"));
    const detail = await call("browse_network_request", { sessionId, id: real.id });
    if (detail.body !== '{"items":[1,2,3]}') throw new Error(`body real: ${JSON.stringify(detail)}`);
    // mock
    await call("browse_session_network", { sessionId, network: { mocks: [{ url: "**/api/data", json: { items: ["mock"] } }] } });
    await act({ type: "click", selector: "#load" });
    await act({ type: "expect", check: "text", selector: "#out", equals: '{"items":["mock"]}' });
    // bloqueo
    await call("browse_session_network", { sessionId, network: { blockUrls: ["**/api/data"] } });
    await act({ type: "clearDiagnostics" });
    await act({ type: "click", selector: "#load" });
    const blocked = await raw({ type: "expect", check: "noFailedRequests", timeout: 1500 });
    if (!blocked.isError) throw new Error("noFailedRequests debía fallar con la URL bloqueada");
    // latencia
    await call("browse_session_network", { sessionId, network: { latencyMs: 600 } });
    const t0 = Date.now();
    await go();
    const took = Date.now() - t0;
    if (took < 600) throw new Error(`latencia ${took}ms < 600`);
    // websocket
    await call("browse_session_network", { sessionId, network: {} });
    await act({ type: "click", selector: "#ws" });
    await act({ type: "expect", check: "text", selector: "#out", equals: "pong:ping" });
    const ws = await call("browse_diagnose", { sessionId, sections: ["network"], settleMs: 200 });
    if (ws.network.websockets?.[0]?.frames?.length !== 2) throw new Error(`frames ws: ${JSON.stringify(ws.network.websockets)}`);
    await call("browse_session_close", { sessionId });
    return { result: { took, websockets: ws.network.websockets }, expect: "pong:ping" };
  },

  async emulation(call, client) {
    const start = async (emulation) => {
      const { sessionId } = await call("browse_session_start", { emulation });
      const act = (action) => call("browse_session_action", { sessionId, action });
      await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
      return { sessionId, act };
    };
    let { sessionId, act } = await start({ device: "iphone-15" });
    const zero = await client.callTool({ name: "browse_session_action", arguments: { sessionId, action: { type: "expect", check: "text", selector: "#touch", equals: "0", timeout: 300 } } });
    if (!zero.isError) throw new Error("maxTouchPoints es 0 con device iphone-15");
    await call("browse_session_close", { sessionId });
    ({ sessionId, act } = await start({ javaScriptEnabled: false }));
    await act({ type: "click", selector: "#inc" }).catch(() => undefined);
    await act({ type: "expect", check: "text", selector: "#count", equals: "0" });
    await call("browse_session_close", { sessionId });
    return { result: { ok: true }, expect: '"ok":true' };
  },

  async storage(call) {
    const { sessionId } = await call("browse_session_start", {});
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    const hidden = await call("browse_storage", { sessionId });
    const entry = hidden.localStorage.entries.find((e) => e.key === "token");
    if (entry?.valueLength !== 6 || "value" in entry) throw new Error(`token oculto: ${JSON.stringify(entry)}`);
    const shown = await call("browse_storage", { sessionId, kinds: ["localStorage"], includeValues: true });
    if (shown.localStorage.entries.find((e) => e.key === "token")?.value !== "abc123") throw new Error("falta value con includeValues");
    await call("browse_session_close", { sessionId });
    return { result: hidden, expect: '"valueLength":6' };
  },

  async perf(call) {
    const { sessionId } = await call("browse_session_start", {});
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    await call("browse_session_action", { sessionId, action: { type: "click", selector: "#jank" } });
    await new Promise((r) => setTimeout(r, 500));
    const report = await call("browse_diagnose", { sessionId, sections: ["perf"], settleMs: 500, budgets: { maxTbtMs: 100, maxDomNodes: 1000 } });
    if (!(report.perf.tbtApproxMs >= 200)) throw new Error(`tbtApproxMs ${report.perf.tbtApproxMs}`);
    if (!report.perf.waterfall.length) throw new Error("waterfall vacío");
    if (report.budgets.passed !== false) throw new Error(`budgets: ${JSON.stringify(report.budgets)}`);
    await call("browse_session_close", { sessionId });
    return { result: { tbt: report.perf.tbtApproxMs, longFrames: report.perf.longFrames, budgets: report.budgets }, expect: "tbt" };
  },

  async audit(call) {
    const out = path.join(env.CAMOUFOX_MCP_FILES_DIR, "exports", "audit.html");
    fs.rmSync(out, { force: true });
    const r = await call("browse_audit", { url: `${HEROKU}/broken`, saveAs: "audit.html", settleMs: 500 });
    if (!(r.scores.accessibility < 100)) throw new Error(`accessibility ${r.scores.accessibility} ${r.accessibility.axeError ?? ""}`);
    if (!r.accessibility.violations.some((v) => v.id === "image-alt")) throw new Error("falta image-alt");
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw new Error("falta audit.html");
    return { result: { scores: r.scores, method: r.method }, expect: "lighthouse-formula" };
  },

  async "profile-app"(call) {
    const { sessionId } = await call("browse_session_start", {});
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    const leak = await call("browse_profile_app", { sessionId, mode: "leaks", actions: [{ type: "click", selector: "#leak" }], iterations: 5 });
    if (leak.suspectedLeak !== true) throw new Error(`leak debía sospecharse: ${JSON.stringify(leak.growthPerIteration)}`);
    const clean = await call("browse_profile_app", { sessionId, mode: "leaks", actions: [{ type: "click", selector: "#inc" }], iterations: 5 });
    if (clean.suspectedLeak !== false) throw new Error(`inc no debía ser fuga: ${JSON.stringify(clean.growthPerIteration)}`);
    const css = await call("browse_profile_app", { sessionId, mode: "cssCoverage" });
    if (!css.sheets.some((sheet) => sheet.unusedSelectors.includes(".unused"))) throw new Error(`falta .unused: ${JSON.stringify(css)}`);
    await call("browse_session_close", { sessionId });
    return { result: { leak: leak.growthPerIteration, clean: clean.growthPerIteration, css: css.sheets }, expect: ".unused" };
  },

  async visual(call) {
    fs.rmSync(path.join(env.CAMOUFOX_AGENT_HOME, "baselines", "count.png"), { force: true });
    const { sessionId } = await call("browse_session_start", {});
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    const diff = () => call("browse_visual_diff", { sessionId, name: "count", selector: "#count" });
    const first = await diff();
    if (first.status !== "baseline-created") throw new Error(`primera: ${JSON.stringify(first)}`);
    const same = await diff();
    if (same.status !== "passed" || same.diffPct !== 0) throw new Error(`igual: ${JSON.stringify(same)}`);
    await call("browse_session_action", { sessionId, action: { type: "click", selector: "#inc" } });
    const changed = await diff();
    if (changed.status !== "failed" || !fs.existsSync(changed.diffPath)) throw new Error(`cambio: ${JSON.stringify(changed)}`);
    await call("browse_session_close", { sessionId });
    return { result: changed, expect: '"failed"' };
  },

  async "diagnose-session"(call) {
    const exportsDir = path.join(env.CAMOUFOX_MCP_FILES_DIR, "exports");
    for (const f of ["smoke.har", "smoke-trace.zip", "smoke-report.json"]) fs.rmSync(path.join(exportsDir, f), { force: true });
    const start = await call("browse_session_start", { recordHar: "smoke.har", emulation: { timezoneId: "Asia/Tokyo" } });
    const sessionId = start.sessionId;
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/broken` });
    await call("browse_session_trace", { sessionId, action: "start" });
    const report = await call("browse_diagnose", { sessionId, reload: true, settleMs: 500, saveAs: "smoke-report.json" });
    await call("browse_session_trace", { sessionId, action: "stop", saveAs: "smoke-trace.zip" });
    await call("browse_session_close", { sessionId });
    const files = ["smoke.har", "smoke-trace.zip", "smoke-report.json"].map((f) => fs.existsSync(path.join(exportsDir, f)) && fs.statSync(path.join(exportsDir, f)).size > 0);
    if (files.includes(false) || !report.console?.uncaughtErrors?.length) throw new Error(`files=${files} errors=${report.console?.uncaughtErrors?.length}`);
    return { result: { files, savedPath: report.savedPath }, expect: "smoke-report.json" };
  },
};

const scenariosExtra = {
  async download(call, client) {
    const dir = path.join(process.env.CAMOUFOX_MCP_FILES_DIR ?? path.join(ROOT, "tests/fixtures/files"), "descargas");
    const files = ["smoke-sel.bin", "smoke-url.bin"].map((f) => path.join(dir, f));
    for (const f of files) fs.rmSync(f, { force: true });
    const start = await call("browse_session_start", {});
    const sessionId = start.sessionId;
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    await call("browse_session_action", { sessionId, action: { type: "download", selector: "#dl", filename: "smoke-sel.bin" } });
    await call("browse_session_action", { sessionId, action: { type: "download", url: `${HEROKU}/big.bin`, filename: "smoke-url.bin" } });
    const sizes = files.map((f) => fs.existsSync(f) ? fs.statSync(f).size : -1);
    if (sizes.some((n) => n !== BIG_SIZE)) throw new Error(`tamaños=${sizes} esperado=${BIG_SIZE}`);
    // Selector inexistente: debe fallar sin tumbar el servidor ni la sesión.
    const bad = await client.callTool({ name: "browse_session_action", arguments: { sessionId, action: { type: "download", selector: "#nope", filename: "smoke-bad.bin", timeout: 1000 } } });
    if (!bad.isError) throw new Error("se esperaba error en download inexistente");
    // url que no descarga (página 200 o error HTTP): debe fallar de inmediato, no al vencer el timeout.
    for (const bad of ["/api/data", "/gone"]) {
      const t0 = Date.now();
      const r = await client.callTool({ name: "browse_session_action", arguments: { sessionId, action: { type: "download", url: `${HEROKU}${bad}`, filename: "smoke-bad2.bin", timeout: 60000 } } });
      if (!r.isError || Date.now() - t0 > 15000) throw new Error(`download ${bad}: isError=${r.isError} ms=${Date.now() - t0}`);
    }
    // Por selector: enlace a un error HTTP, y clic que no inicia ninguna descarga.
    for (const [selector, want] of [["#dlbad", "HTTP 404"], ["#inc", "did not start"]]) {
      const t0 = Date.now();
      const r = await client.callTool({ name: "browse_session_action", arguments: { sessionId, action: { type: "download", selector, filename: "smoke-bad3.bin", timeout: 3000 } } });
      const msg = JSON.stringify(r.content ?? r.structuredContent);
      if (!r.isError || !msg.includes(want) || Date.now() - t0 > 10000) throw new Error(`download ${selector}: isError=${r.isError} ms=${Date.now() - t0} msg=${msg.slice(0, 200)}`);
    }
    const snap = await call("browse_session_snapshot", { sessionId });
    if (snap.sessionId !== sessionId) throw new Error("la sesión no sobrevivió a los errores de download");
    await call("browse_session_close", { sessionId });
    for (const f of files) fs.rmSync(f, { force: true });
    return { result: { sizes, sessionAlive: snap.sessionId ?? sessionId }, expect: sessionId };
  },

  async "download-kinds"(call, client) {
    const dir = path.join(process.env.CAMOUFOX_MCP_FILES_DIR ?? path.join(ROOT, "tests/fixtures/files"), "descargas");
    const start = await call("browse_session_start", {});
    const sessionId = start.sessionId;
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/downloads` });
    const results = {};
    const cases = [
      ["#d-redirect", {}], ["#d-blank", {}], ["#d-js", {}], ["#d-blob", {}], ["#d-post", {}], ["#d-frame", { frame: "#fr" }],
    ];
    for (const [selector, extra] of cases) {
      const filename = `kind-${selector.slice(3)}.bin`;
      fs.rmSync(path.join(dir, filename), { force: true });
      const r = await client.callTool({ name: "browse_session_action", arguments: { sessionId, action: { type: "download", selector, filename, timeout: 30000, ...extra } } });
      const file = path.join(dir, filename);
      results[selector] = r.isError ? JSON.stringify(r.content).slice(0, 150) : (fs.existsSync(file) ? fs.statSync(file).size : "sin archivo");
      fs.rmSync(file, { force: true });
      // tras una navegación por JS la página puede haber cambiado: volver al origen
      await call("browse_session_navigate", { sessionId, url: `${HEROKU}/downloads` });
    }
    const redirectUrl = await client.callTool({ name: "browse_session_action", arguments: { sessionId, action: { type: "download", url: `${HEROKU}/redirect-file`, filename: "kind-url-redirect.bin", timeout: 30000 } } });
    results["url+redirect"] = redirectUrl.isError ? JSON.stringify(redirectUrl.content).slice(0, 150) : fs.statSync(path.join(dir, "kind-url-redirect.bin")).size;
    fs.rmSync(path.join(dir, "kind-url-redirect.bin"), { force: true });
    await call("browse_session_close", { sessionId });
    const bad = Object.entries(results).filter(([, v]) => typeof v !== "number" || v <= 0);
    if (bad.length) throw new Error(`fallaron: ${JSON.stringify(bad)}`);
    return { result: results, expect: "#d-blob" };
  },

  async "many-requests"(call) {
    const start = await call("browse_session_start", {});
    const sessionId = start.sessionId;
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/many` });
    await call("browse_session_action", { sessionId, action: { type: "waitFor", selector: "html", timeout: 100 } });
    let title = "";
    for (let i = 0; i < 60 && title !== "many-1300"; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      title = (await call("browse_session_snapshot", { sessionId, maxElements: 1 })).title;
    }
    await call("browse_session_close", { sessionId });
    if (title !== "many-1300") throw new Error(`más de 1024 peticiones no completaron: ${title}`);
    return { result: { title }, expect: "many-1300" };
  },

  async elements(call) {
    const start = await call("browse_session_start", {});
    const sessionId = start.sessionId;
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/frames` });
    const snap = await call("browse_session_snapshot", { sessionId });
    const find = (pred) => snap.elements.find(pred);
    const shadow = find((e) => e.name === "shadow" || e.text === "shadow");
    const inner = find((e) => e.text === "inner");
    const sum = find((e) => e.tag === "summary");
    const oc = find((e) => e.text === "oc");
    if (!shadow || !inner || !sum || !oc) throw new Error(`faltan: shadow=${!!shadow} inner=${!!inner} summary=${!!sum} onclick=${!!oc}`);
    const titles = [];
    for (const [el, want] of [[shadow, "shadow"], [inner, "inner"], [oc, "oc"]]) {
      await call("browse_session_action", { sessionId, action: { type: "click", selector: el.selector, ...(el.frame ? { frame: el.frame } : {}) } });
      const t = await call("browse_session_snapshot", { sessionId });
      titles.push(t.title);
      if (t.title !== want) throw new Error(`clic en ${want}: título=${t.title}`);
    }
    await call("browse_session_close", { sessionId });
    return { result: { titles, shadow, inner }, expect: "inner" };
  },

  async "screenshot-session"(call) {
    const start = await call("browse_session_start", {});
    const sessionId = start.sessionId;
    await call("browse_session_navigate", { sessionId, url: `${HEROKU}/app` });
    const shot = await call("browse_screenshot", { sessionId });
    await call("browse_session_close", { sessionId });
    return { result: shot, expect: "\"included\":true" };
  },
};
Object.assign(scenarios, scenariosExtra);

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
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(ROOT, "dist/cli.js")], env, stderr: process.env.SMOKE_STDERR ? "inherit" : "ignore" }));

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
