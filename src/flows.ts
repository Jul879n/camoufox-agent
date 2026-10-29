import fs from "node:fs";
import path from "node:path";
import { agentHome, ensureDir } from "./home.js";
import { PROFILE_NAME } from "./profiles.js";
import { flowSchema, type FlowDefinition } from "./schema/tools.js";
import { handleSessionAction, handleSessionClose, handleSessionNavigate, handleSessionStart, peekSession } from "./sessions.js";
import { handleExtract } from "./extract-tool.js";
import type { ExtractToolInput } from "./schema/tools.js";
import type { SessionActionToolInput, SessionNavigateToolInput, SessionStartToolInput } from "./schemas.js";
import { describeError, redactDeep, redactUrl } from "./utils.js";

export type FlowTrigger = "cli" | "tool" | "cron" | "http";

export interface FlowStep {
  index: number;
  type: string;
  ok: boolean;
  status: "passed" | "failed" | "error";
  error?: string;
  message?: string;
  expected?: string;
  actual?: string;
}

export interface FlowFailure {
  url?: string;
  title?: string;
  screenshot?: string;
  screenshotError?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export interface FlowRun {
  name: string;
  ok: boolean;
  trigger: FlowTrigger;
  startedAt: string;
  durationMs: number;
  steps: FlowStep[];
  extract?: unknown;
  error?: string;
  sessionId?: string;
  failure?: FlowFailure;
}

const MAX_RUNS_PER_FLOW = 100;

function assertName(name: string): void {
  if (!PROFILE_NAME.test(name)) throw new Error("Invalid flow name");
}

function flowFile(name: string): string {
  assertName(name);
  return agentHome("flows", `${name}.json`);
}

export function loadFlow(name: string): FlowDefinition {
  let raw: string;
  try {
    raw = fs.readFileSync(flowFile(name), "utf8");
  } catch {
    throw new Error(`Flow "${name}" not found`);
  }
  return flowSchema.parse(JSON.parse(raw));
}

export function saveFlow(name: string, flow: unknown): FlowDefinition {
  const parsed = flowSchema.parse(flow);
  const file = flowFile(name);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  return parsed;
}

export function listFlowNames(): string[] {
  try {
    return fs.readdirSync(agentHome("flows")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((n) => PROFILE_NAME.test(n)).sort();
  } catch {
    return [];
  }
}

export function listRuns(name: string, limit = 20): FlowRun[] {
  assertName(name);
  const dir = agentHome("runs", name);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
  } catch {
    return [];
  }
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as FlowRun);
}

export function listFlows(): Array<{ name: string; schedule?: string; lastRun: { ok: boolean; startedAt: string; trigger: string } | null }> {
  return listFlowNames().map((name) => {
    let schedule: string | undefined;
    try {
      schedule = loadFlow(name).schedule;
    } catch {
      schedule = undefined;
    }
    const last = listRuns(name, 1)[0];
    return { name, ...(schedule ? { schedule } : {}), lastRun: last ? { ok: last.ok, startedAt: last.startedAt, trigger: last.trigger } : null };
  });
}

function writeRun(run: FlowRun): void {
  const dir = ensureDir(agentHome("runs", run.name));
  fs.writeFileSync(path.join(dir, `${run.startedAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(run, null, 2));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - MAX_RUNS_PER_FLOW))) {
    fs.rmSync(path.join(dir, old), { force: true });
    fs.rmSync(path.join(dir, old.replace(/\.json$/, "-fail.png")), { force: true });
  }
}

interface ToolResult { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }

function errorText(result: ToolResult): string {
  return result.content?.find((c) => c.type === "text")?.text ?? "unknown error";
}

async function captureFailure(sessionId: string, run: FlowRun): Promise<void> {
  const session = peekSession(sessionId);
  if (!session) return;
  const data = session.rich?.data();
  const failure: FlowFailure = {
    consoleErrors: (data?.console ?? []).filter((e) => e.type === "error").slice(0, 20).map((e) => e.text),
    pageErrors: (data?.pageErrors ?? []).slice(0, 10).map((e) => e.message),
    failedRequests: (data?.network ?? []).filter((e) => e.failed || (e.status ?? 0) >= 400).slice(0, 20).map((e) => `${e.status ?? "failed"} ${e.method} ${e.url}`),
  };
  try {
    failure.url = redactUrl(session.page.url());
    failure.title = await session.page.title();
    const dir = ensureDir(agentHome("runs", run.name));
    const file = path.join(dir, `${run.startedAt.replace(/[:.]/g, "-")}-fail.png`);
    fs.writeFileSync(file, await session.page.screenshot({ fullPage: true }));
    failure.screenshot = file;
  } catch (error) {
    failure.screenshotError = describeError(error);
  }
  run.failure = redactDeep(failure, session.secrets);
}

export async function runFlow(name: string, options: { trigger: FlowTrigger }): Promise<FlowRun> {
  const started = Date.now();
  const run: FlowRun = { name, ok: false, trigger: options.trigger, startedAt: new Date(started).toISOString(), durationMs: 0, steps: [] };
  let sessionId: string | undefined;
  let keepOpen = false;

  try {
    const flow = loadFlow(name);
    const start = await handleSessionStart({ profile: flow.profile, headless: flow.headless } as unknown as SessionStartToolInput) as ToolResult;
    if (start.isError) throw new Error(errorText(start));
    sessionId = start.structuredContent?.sessionId as string;
    run.sessionId = sessionId;

    const nav = await handleSessionNavigate({ sessionId, url: flow.startUrl } as SessionNavigateToolInput) as ToolResult;
    if (nav.isError) throw new Error(errorText(nav));

    for (const [index, action] of flow.actions.entries()) {
      const result = await handleSessionAction({ sessionId, action } as SessionActionToolInput) as ToolResult;
      if (result.isError) {
        run.steps.push({ index, type: action.type, ok: false, status: "error", error: errorText(result) });
        throw new Error(`Step ${index} (${action.type}) failed: ${errorText(result)}`);
      }
      const outcome = result.structuredContent?.action as { status?: string; message?: string; expected?: string; actual?: string } | undefined;
      const paused = outcome?.status === "paused";
      if (outcome?.status === "failed") {
        run.steps.push({ index, type: action.type, ok: false, status: "failed", message: outcome.message, expected: outcome.expected, actual: outcome.actual });
        continue;
      }
      run.steps.push({ index, type: action.type, ok: !paused, status: paused ? "error" : "passed", ...(paused ? { error: "needs_human" } : {}) });
      if (paused) {
        // Non-interactive run: leave the session open (it has no TTL) so a human can take over from the live view.
        keepOpen = true;
        throw new Error("needs_human");
      }
    }

    if (flow.extract) {
      const result = await handleExtract({ sessionId, ...flow.extract } as unknown as ExtractToolInput) as ToolResult;
      if (result.isError) throw new Error(errorText(result));
      run.extract = result.structuredContent;
    }
    run.ok = run.steps.every((step) => step.status === "passed");
  } catch (error) {
    run.error = describeError(error);
  } finally {
    if (sessionId && !run.ok) await captureFailure(sessionId, run);
    if (sessionId && !keepOpen) await handleSessionClose({ sessionId });
    run.durationMs = Date.now() - started;
    try {
      writeRun(run);
    } catch (writeError) {
      console.error(`[Camoufox] Failed to write run record: ${describeError(writeError)}`);
    }
  }
  return run;
}
