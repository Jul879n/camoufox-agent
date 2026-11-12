import { randomBytes } from "node:crypto";
import { buildSuccessContent } from "./responses.js";

// One-time links for /live. A code is created per request, redeemed once for a short-lived
// session token that only opens the live routes (never /mcp, /api/tools or /api/flows).
export const LIVE_CODE_TTL_MS = 15 * 60_000;
export const LIVE_SESSION_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 500;

const codes = new Map<string, number>();
const sessionTokens = new Map<string, number>();

function newSecret(): string {
  return randomBytes(24).toString("base64url");
}

function prune(store: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of store) {
    if (expiresAt <= now) store.delete(key);
  }
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function createLiveCode(now = Date.now()): { code: string; expiresAt: number } {
  prune(codes, now);
  const code = newSecret();
  const expiresAt = now + LIVE_CODE_TTL_MS;
  codes.set(code, expiresAt);
  return { code, expiresAt };
}

/** Consumes the code (single use). Returns a live session token, or undefined if unknown, used or expired. */
export function redeemLiveCode(code: string, now = Date.now()): string | undefined {
  const expiresAt = codes.get(code);
  codes.delete(code);
  if (expiresAt === undefined || expiresAt <= now) return undefined;
  prune(sessionTokens, now);
  const token = newSecret();
  sessionTokens.set(token, now + LIVE_SESSION_TTL_MS);
  return token;
}

export function isLiveSessionToken(token: string, now = Date.now()): boolean {
  const expiresAt = sessionTokens.get(token);
  return expiresAt !== undefined && expiresAt > now;
}

/** Routes a live session token may open. */
export function isLivePath(pathname: string): boolean {
  return pathname === "/live" || pathname === "/api/human" || pathname === "/api/sessions"
    || /^\/api\/human\/[0-9a-f-]+$/.test(pathname)
    || /^\/api\/sessions\/[^/]+\/(frame\.jpg|input)$/.test(pathname);
}

export function liveLinkUrl(code: string, publicUrl = process.env.CAMOUFOX_AGENT_PUBLIC_URL): string {
  const path = `/live?ott=${code}`;
  return publicUrl ? `${publicUrl.replace(/\/$/, "")}${path}` : path;
}

export async function handleLiveLink() {
  const { code, expiresAt } = createLiveCode();
  return buildSuccessContent({
    url: liveLinkUrl(code),
    expiresAt: new Date(expiresAt).toISOString(),
    singleUse: true,
    note: "Open once in a browser and press the button; the link is dead after that or after 15 minutes.",
  });
}
