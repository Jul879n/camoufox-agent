#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: camoufox-agent [command]

  (none)                      MCP server over stdio
  serve [--host H] [--port P] HTTP server: REST, MCP over HTTP, live view, cron
  scrape <url> [--engine auto|http|chrome|camoufox] [--full] [--fast] [--timeout <s>] [--no-server]
                              Tiered scrape (HTTP -> Chrome -> Camoufox) to JSON
  call <tool> [json|-]        Call any MCP tool directly (JSON args or stdin) and print its JSON
  run <flow|file.json>                  Run a saved flow once and print its JSON result
  test <flow...> | --all      Run flows as tests [--junit <file>]; exit 1 if any fails
  secret set <name>           Store a secret (value read from stdin, no echo)
  secret list                 List secret names
  fetch                       Download the pinned Camoufox browser
  doctor                      Check the installation
`;

async function runTarget(target: string): Promise<import("./flows.js").FlowRun> {
  const { runFlow, runFlowDefinition } = await import("./flows.js");
  const fs = await import("node:fs");
  if (target.endsWith(".json") && fs.existsSync(target)) {
    const { flowSchema } = await import("./schema/tools.js");
    const flow = flowSchema.parse(JSON.parse(fs.readFileSync(target, "utf8")));
    return runFlowDefinition(path.basename(target, ".json"), flow, { trigger: "cli" });
  }
  return runFlow(target, { trigger: "cli" });
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runScript(script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", script)], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** process.exit() right after console.log truncates piped output above the pipe buffer (~64 KB). */
function exitAfterWrite(text: string, code: number): Promise<never> {
  return new Promise(() => { process.stdout.write(`${text}\n`, () => process.exit(code)); });
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readSecretValue(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const mutable = rl as unknown as { _writeToOutput: (text: string) => void };
  process.stderr.write("Value: ");
  mutable._writeToOutput = () => undefined;
  const value = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stderr.write("\n");
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === undefined || command.startsWith("-")) {
    const { runStdio } = await import("./index.js");
    return runStdio();
  }

  switch (command) {
    case "serve": {
      const { installProcessHandlers } = await import("./index.js");
      const { startHttpServer } = await import("./http-server.js");
      installProcessHandlers();
      try {
        await startHttpServer({
          host: flag(args, "--host"),
          port: flag(args, "--port") ? Number(flag(args, "--port")) : undefined,
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      return;
    }
    case "scrape": {
      const url = args.find((a, i) => !a.startsWith("--") && !["--engine", "--timeout"].includes(args[i - 1] ?? ""));
      if (!url) { console.error(USAGE); process.exit(2); }
      const { scrape } = await import("./scrape/index.js");
      const engine = (flag(args, "--engine") ?? "auto") as "auto" | "http" | "chrome" | "camoufox";
      if (!["auto", "http", "chrome", "camoufox"].includes(engine)) { console.error(USAGE); process.exit(2); }
      const timeout = flag(args, "--timeout");
      const result = await scrape(url, {
        engine,
        full: args.includes("--full"),
        fast: args.includes("--fast"),
        useServer: !args.includes("--no-server"),
        ...(timeout ? { timeoutMs: Number(timeout) * 1000 } : {}),
      });
      await exitAfterWrite(JSON.stringify(result, null, 2), result.success ? 0 : 1);
      return;
    }
    case "call": {
      if (!args[0]) { console.error(USAGE); process.exit(2); }
      await import("./sqlite-compat.js");
      const { createMcpServer, invokeTool } = await import("./register-tools.js");
      const { closeActiveBrowsers } = await import("./browser-runtime.js");
      let raw = args[1];
      if (raw === "-" || (raw === undefined && !process.stdin.isTTY)) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        raw = Buffer.concat(chunks).toString("utf8");
      }
      let input: unknown = {};
      try {
        input = raw?.trim() ? JSON.parse(raw) : {};
      } catch {
        console.error("Invalid JSON arguments");
        process.exit(2);
      }
      createMcpServer();
      const { status, payload } = await invokeTool(args[0], input);
      await closeActiveBrowsers();
      await exitAfterWrite(JSON.stringify(payload, null, 2), status === 200 ? 0 : 1);
      return;
    }
    case "run": {
      if (!args[0]) { console.error(USAGE); process.exit(2); }
      await import("./sqlite-compat.js");
      const { closeActiveBrowsers } = await import("./browser-runtime.js");
      const run = await runTarget(args[0]);
      console.log(JSON.stringify(run, null, 2));
      await closeActiveBrowsers();
      process.exit(run.ok ? 0 : 1);
      return;
    }
    case "test": {
      const all = args.includes("--all");
      const junitFile = flag(args, "--junit");
      await import("./sqlite-compat.js");
      const { listFlowNames } = await import("./flows.js");
      const { toJunit } = await import("./junit.js");
      const { closeActiveBrowsers } = await import("./browser-runtime.js");
      const skip = new Set(junitFile ? ["--junit", junitFile] : []);
      const names = all ? listFlowNames() : args.filter((arg) => !arg.startsWith("--") && !skip.has(arg));
      if (names.length === 0) { console.error(USAGE); process.exit(2); }
      const runs = [];
      for (const name of names) {
        const run = await runTarget(name);
        runs.push(run);
        const failed = run.steps.filter((step) => step.status !== "passed").length;
        console.error(`${run.ok ? "✓" : "✗"} ${name} (${run.durationMs}ms) ${run.steps.length} steps, ${failed} failed`);
      }
      console.log(JSON.stringify(runs, null, 2));
      if (junitFile) (await import("node:fs")).writeFileSync(junitFile, toJunit(runs));
      await closeActiveBrowsers();
      process.exit(runs.every((run) => run.ok) ? 0 : 1);
      return;
    }
    case "secret": {
      const { setSecret, listSecretNames } = await import("./secrets.js");
      if (args[0] === "list") {
        for (const name of listSecretNames()) console.log(name);
        return;
      }
      if (args[0] === "set" && args[1]) {
        setSecret(args[1], await readSecretValue());
        console.error(`Secret "${args[1]}" saved.`);
        return;
      }
      console.error(USAGE);
      process.exit(2);
      return;
    }
    case "fetch":
      process.exit(await runScript("fetch-browser.mjs"));
      return;
    case "doctor":
      process.exit(await runScript("doctor.mjs"));
      return;
    default:
      console.error(`Unknown command: ${command}\n${USAGE}`);
      process.exit(2);
  }
}

void main();
