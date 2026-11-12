import { createHmac } from "node:crypto";
import { createLiveCode, liveLinkUrl } from "./live-links.js";
import { describeError, redactUrl } from "./utils.js";

// Comma-separated list: each target gets its own one-time link, so one channel cannot burn another's.
const NOTIFY_URLS = (process.env.CAMOUFOX_AGENT_NOTIFY_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
const NOTIFY_SECRET = process.env.CAMOUFOX_AGENT_NOTIFY_SECRET;
const PUBLIC_URL = process.env.CAMOUFOX_AGENT_PUBLIC_URL;

export interface HumanNotice {
  event: "human_pending";
  sessionId: string;
  reason: string;
  kind: "human" | "code";
  url?: string;
  flow?: string;
}

function send(target: string, notice: HumanNotice, url: string | undefined): void {
  // One-time link per request; the master token never leaves the server.
  const liveUrl = PUBLIC_URL ? liveLinkUrl(createLiveCode().code, PUBLIC_URL) : undefined;
  const message = `camoufox necesita ayuda${notice.flow ? ` en el flow «${notice.flow}»` : ""}: ${notice.reason}. Sesión ${notice.sessionId}`
    + `${url ? ` en ${url}` : ""}`
    + `${liveUrl ? `. Ábrala en ${liveUrl} (un solo uso, vence en 15 min), pulse «Abrir vista en vivo» y luego «Listo»; el flujo espera máx. 10 min.` : "."}`;
  const body = JSON.stringify({ ...notice, url, liveUrl, message });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (NOTIFY_SECRET) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["X-Webhook-Timestamp"] = ts;
    headers["X-Webhook-Signature-V2"] = createHmac("sha256", NOTIFY_SECRET).update(`${ts}.${body}`).digest("hex");
  }
  void fetch(target, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) })
    .then((res) => { if (res.status >= 400) console.error(`[Camoufox] notify failed: HTTP ${res.status}`); })
    .catch((error: unknown) => console.error(`[Camoufox] notify failed: ${describeError(error)}`));
}

/** Fire-and-forget webhook when a session starts waiting for a human. No-op without CAMOUFOX_AGENT_NOTIFY_URL; never throws. */
export function notifyHuman(notice: HumanNotice): void {
  if (NOTIFY_URLS.length === 0) return;
  const url = notice.url ? redactUrl(notice.url) : undefined;
  for (const target of NOTIFY_URLS) send(target, notice, url);
}
