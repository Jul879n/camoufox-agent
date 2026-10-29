import "./sqlite-compat.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import chalk from "chalk";
import { assertNetworkSandboxPolicy } from "./config.js";
import { closeActiveSessions } from "./sessions.js";
import { closeActiveBrowsers, rejectPendingBrowses, setBrowserShuttingDown } from "./browser-runtime.js";
import { describeError } from "./utils.js";
import { createMcpServer } from "./register-tools.js";

let handlersInstalled = false;

export function installProcessHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("uncaughtException", (error) => {
    console.error(chalk.red("[Camoufox] Uncaught exception:", error));
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason, promise) => {
    console.error(chalk.red("[Camoufox] Unhandled rejection at:", promise, "reason:", reason));
    void shutdown("unhandledRejection", 1);
  });
}

export async function runStdio(): Promise<void> {
  installProcessHandlers();
  try {
    assertNetworkSandboxPolicy();
    const transport = new StdioServerTransport();
    await createMcpServer().connect(transport);
    console.error(chalk.yellow("Camoufox MCP Server is running on stdio..."));
  } catch (error) {
    console.error(chalk.red("Fatal error during server initialization:", error));
    process.exit(1);
  }
}

const shutdownHooks: Array<() => Promise<void> | void> = [];
export function addShutdownHook(hook: () => Promise<void> | void): void { shutdownHooks.push(hook); }

let shuttingDown = false;

export async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    if (exitCode !== 0) { process.exit(exitCode); }
    return;
  }

  shuttingDown = true;
  setBrowserShuttingDown(true);
  console.error(chalk.yellow("\n[Camoufox] Shutting down server after " + signal + "..."));
  rejectPendingBrowses("Server is shutting down.");
  try {
    for (const hook of shutdownHooks) await hook();
    await closeActiveSessions();
    await closeActiveBrowsers();
  } catch (shutdownError) {
    console.error(chalk.red("[Camoufox] Shutdown cleanup failed: " + describeError(shutdownError)));
  } finally {
    process.exit(exitCode);
  }
}
