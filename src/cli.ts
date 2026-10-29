#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: camoufox-agent [command]

  (none)                      MCP server over stdio
  serve [--host H] [--port P] HTTP server: REST, MCP over HTTP, live view, cron
  run <flow>                  Run a saved flow once and print its JSON result
  secret set <name>           Store a secret (value read from stdin, no echo)
  secret list                 List secret names
  fetch                       Download the pinned Camoufox browser
  doctor                      Check the installation
`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runScript(script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", script)], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
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
    case "run": {
      if (!args[0]) { console.error(USAGE); process.exit(2); }
      await import("./sqlite-compat.js");
      const { runFlow } = await import("./flows.js");
      const { closeActiveBrowsers } = await import("./browser-runtime.js");
      const run = await runFlow(args[0], { trigger: "cli" });
      console.log(JSON.stringify(run, null, 2));
      await closeActiveBrowsers();
      process.exit(run.ok ? 0 : 1);
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
