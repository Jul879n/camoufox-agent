import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseHtml } from "./vendor.js";
import { validateTargetUrl } from "../policy.js";
import { humanHeaders } from "./human.js";
import { JUNK_SELECTOR } from "./extract.js";

const MAX_BODY = 20 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export interface HttpResult { status: number; html: string; finalUrl: string }

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findCurlImpersonate(): string | undefined {
  const env = process.env.CAMOUFOX_AGENT_CURL_IMPERSONATE;
  if (env && isExecutable(env)) return env;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const prefix of ["curl_ff", "curl_chrome"]) {
    const found: string[] = [];
    for (const dir of dirs) {
      try {
        for (const name of readdirSync(dir)) {
          if (name.startsWith(prefix) && !name.endsWith(".sh") && isExecutable(path.join(dir, name))) found.push(path.join(dir, name));
        }
      } catch {
        // unreadable PATH entry
      }
    }
    found.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
    if (found[0]) return found[0];
  }
  return undefined;
}

interface Hop { status: number; headers: Map<string, string[]>; body: Buffer }

function decode(body: Buffer, contentType: string | undefined): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return body.toString("utf8");
  }
}

async function hopFetch(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Hop> {
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const out = new Map<string, string[]>();
  response.headers.forEach((value, key) => out.set(key.toLowerCase(), [value]));
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length) out.set("set-cookie", setCookie);
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { status: response.status, headers: out, body: Buffer.concat(chunks) };
}

function hopCurl(bin: string, url: string, extra: Record<string, string>, timeoutMs: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-D", "-", "--compressed", "--max-time", String(timeoutMs / 1000)];
    for (const [k, v] of Object.entries(extra)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY + 65536) {
        child.kill();
        reject(new Error("response too large"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", () => {
      let buf = Buffer.concat(chunks);
      let status = 0;
      const headers = new Map<string, string[]>();
      // `-D -` prints one header block per response (e.g. 100-continue, proxy) before the body.
      while (buf.subarray(0, 5).toString("latin1") === "HTTP/") {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) break;
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
        status = Number(lines[0].split(" ")[1]);
        headers.clear();
        for (const line of lines.slice(1)) {
          const i = line.indexOf(":");
          if (i < 0) continue;
          const key = line.slice(0, i).toLowerCase();
          headers.set(key, [...(headers.get(key) ?? []), line.slice(i + 1).trim()]);
        }
        buf = buf.subarray(end + 4);
      }
      if (!status) return reject(new Error("curl-impersonate returned no response"));
      if (buf.length > MAX_BODY) return reject(new Error("response too large"));
      resolve({ status, headers, body: buf });
    });
  });
}

export async function fetchHttp(url: string, timeoutMs: number): Promise<HttpResult> {
  const curl = findCurlImpersonate();
  const jar = new Map<string, string>();
  let current = url;
  let referer: string | undefined;
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await validateTargetUrl(current);
    const remaining = Math.max(1000, deadline - Date.now());
    const sameOrigin = referer ? new URL(referer).host === new URL(current).host : false;
    const extra: Record<string, string> = {};
    if (referer) extra.Referer = referer;
    if (jar.size) extra.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const result = curl
      ? await hopCurl(curl, current, extra, remaining)
      : await hopFetch(current, { ...humanHeaders(referer, sameOrigin), ...extra }, remaining);
    for (const cookie of result.headers.get("set-cookie") ?? []) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const location = result.headers.get("location")?.[0];
    if (result.status >= 300 && result.status < 400 && location) {
      referer = current;
      current = new URL(location, current).href;
      continue;
    }
    return { status: result.status, html: decode(result.body, result.headers.get("content-type")?.[0]), finalUrl: current };
  }
  throw new Error("too many redirects");
}

const BLOCK_STATUS = new Set([403, 429, 503]);
const CHALLENGE_MARKERS = ["cf-chl", "challenge-platform", "<title>Just a moment"];

/** Block page (status or challenge markers), as opposed to a page that merely needs JS. */
export function isBlocked(status: number, html: string): boolean {
  return BLOCK_STATUS.has(status) || CHALLENGE_MARKERS.some((m) => html.includes(m));
}

const CHALLENGE_TITLE = /<title[^>]*>\s*(?:just a moment|un momento|attention required|access denied|verifying you are human)/i;

/** For rendered pages: a challenge interstitial, judged by status and title (solved pages keep the challenge-platform script). */
export function isChallengeRender(status: number | null, html: string): boolean {
  return (status !== null && BLOCK_STATUS.has(status)) || CHALLENGE_TITLE.test(html);
}

export function needsBrowser(status: number, html: string): boolean {
  if (isBlocked(status, html)) return true;
  if (!html.includes("<script")) return false;
  const doc = parseHtml(html);
  for (const el of Array.from(doc.querySelectorAll(JUNK_SELECTOR))) el.parentNode?.removeChild(el);
  const text = (doc.body?.textContent ?? "").split(/\s+/).filter(Boolean).join(" ");
  return text.length < 200;
}
