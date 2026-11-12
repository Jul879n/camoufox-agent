import { createHmac } from "node:crypto";
import { describeError, redactUrl } from "./utils.js";

const NOTIFY_URL = process.env.CAMOUFOX_AGENT_NOTIFY_URL;
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

/** Fire-and-forget webhook when a session starts waiting for a human. No-op without CAMOUFOX_AGENT_NOTIFY_URL; never throws. */
export function notifyHuman(notice: HumanNotice): void {
  if (!NOTIFY_URL) return;
  const url = notice.url ? redactUrl(notice.url) : undefined;
  // The live link never carries the token: the user keeps it in their own bookmark.
  const liveUrl = PUBLIC_URL ? `${PUBLIC_URL.replace(/\/$/, "")}/live` : undefined;
  const message = `camoufox necesita ayuda${notice.flow ? ` en el flow «${notice.flow}»` : ""}: ${notice.reason}. Sesión ${notice.sessionId}`
    + `${url ? ` en ${url}` : ""}`
    + `${liveUrl ? `. Ábrala en ${liveUrl} (su marcador con token) y pulse «Listo»; espera máx. 10 min.` : "."}`;
  const body = JSON.stringify({ ...notice, url, liveUrl, message });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (NOTIFY_SECRET) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["X-Webhook-Timestamp"] = ts;
    headers["X-Webhook-Signature-V2"] = createHmac("sha256", NOTIFY_SECRET).update(`${ts}.${body}`).digest("hex");
  }
  void fetch(NOTIFY_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) })
    .then((res) => { if (res.status >= 400) console.error(`[Camoufox] notify failed: HTTP ${res.status}`); })
    .catch((error: unknown) => console.error(`[Camoufox] notify failed: ${describeError(error)}`));
}
