import { randomUUID } from "node:crypto";
import type { SequenceAction } from "./schemas.js";
import type { SequenceActionResult } from "./types.js";
import type { Page } from "playwright-core";
import { resolveLocator } from "./sequence.js";
import { isHttpActive } from "./http-state.js";

export interface PendingHuman {
  id: string;
  sessionId: string;
  kind: "human" | "code";
  reason: string;
  label?: string;
  createdAt: string;
}

interface PendingEntry extends PendingHuman {
  resolve: (value: { code?: string }) => void;
}

const pending = new Map<string, PendingEntry>();

export function listPending(): PendingHuman[] {
  return [...pending.values()].map((p) => ({ id: p.id, sessionId: p.sessionId, kind: p.kind, reason: p.reason, label: p.label, createdAt: p.createdAt }));
}

export function resolvePending(id: string, value: { code?: string } = {}): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(value);
  return true;
}

function requestHuman(sessionId: string, kind: "human" | "code", reason: string, label: string | undefined, timeoutMs: number) {
  const id = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{ code?: string }>((resolve, reject) => {
    pending.set(id, { id, sessionId, kind, reason, label, createdAt: new Date().toISOString(), resolve });
    timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for human"));
    }, timeoutMs);
  });
  const settled = promise.finally(() => clearTimeout(timer));
  return { id, promise: settled, cancel: () => { pending.delete(id); clearTimeout(timer); } };
}

export function isHumanAction(action: SequenceAction): action is Extract<SequenceAction, { type: "waitForHuman" | "promptCode" }> {
  return action.type === "waitForHuman" || action.type === "promptCode";
}

export async function runHumanAction(
  session: { id: string; page: Page; secrets: string[] },
  action: Extract<SequenceAction, { type: "waitForHuman" | "promptCode" }>,
): Promise<SequenceActionResult> {
  const started = Date.now();
  const reason = action.type === "waitForHuman" ? action.reason : `Verification code needed: ${action.label}`;
  const label = action.type === "promptCode" ? action.label : undefined;

  if (!isHttpActive()) {
    // Same contract as the captcha pause: the agent asks the user and continues with browse_session_resume / fill.
    return { index: 0, type: action.type, status: "paused", reason, label, durationMs: Date.now() - started };
  }

  const timeout = action.timeout ?? 600000;
  const request = requestHuman(session.id, action.type === "promptCode" ? "code" : "human", reason, label, timeout);
  try {
    if (action.type === "waitForHuman") {
      const until = action.until
        ? session.page.waitForSelector(action.until, { state: "visible", timeout }).then(() => ({}), () => new Promise<never>(() => undefined))
        : new Promise<never>(() => undefined);
      await Promise.race([request.promise, until]);
    } else {
      const { code } = await request.promise;
      if (!code) throw new Error("No code provided");
      session.secrets.push(code);
      await resolveLocator(session.page, action.selector, action.frame).fill(code, { timeout: 10000 });
    }
  } finally {
    request.cancel();
  }
  return { index: 0, type: action.type, status: "ok", durationMs: Date.now() - started };
}
