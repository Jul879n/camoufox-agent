import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import chalk from "chalk";
import { SERVER_VERSION, assertNetworkSandboxPolicy } from "./config.js";
import { TOOL_REGISTRY, createMcpServer } from "./register-tools.js";
import { sanitizeErrorMessage, describeError } from "./utils.js";
import { addShutdownHook } from "./index.js";
import { handleLiveRoute } from "./live-routes.js";
import { setHttpActive } from "./http-state.js";
import { startScheduler, stopScheduler } from "./scheduler.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HttpServerOptions { host?: string; port?: number }

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(req: http.IncomingMessage, url: URL, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const candidate = bearer || (url.pathname === "/live" ? (url.searchParams.get("token") ?? "") : "");
  return timingSafeEqual(digest(candidate), digest(token));
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse, origins: Set<string>): void {
  const origin = req.headers.origin;
  if (!origin || !origins.has(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

async function callTool(name: string, body: unknown, res: http.ServerResponse): Promise<void> {
  const tool = TOOL_REGISTRY.get(name);
  if (!tool) return sendJson(res, 404, { error: "unknown_tool" });
  const parsed = z.object(tool.shape).safeParse(body ?? {});
  if (!parsed.success) return sendJson(res, 400, { error: "invalid_input", issues: parsed.error.issues });
  const result = await (tool.handler as (input: unknown) => Promise<CallToolResult>)(parsed.data);
  const payload = result.structuredContent ?? { content: result.content };
  sendJson(res, result.isError ? 422 : 200, result.isError ? { ...payload, content: result.content } : payload);
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<http.Server> {
  const host = options.host ?? process.env.CAMOUFOX_AGENT_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.CAMOUFOX_AGENT_PORT ?? 9420);
  const token = process.env.CAMOUFOX_AGENT_TOKEN || undefined;
  const origins = new Set((process.env.CAMOUFOX_AGENT_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean));

  if (!LOOPBACK.has(host) && !token) {
    throw new Error("CAMOUFOX_AGENT_TOKEN is required when binding to a non-loopback host");
  }
  assertNetworkSandboxPolicy();
  createMcpServer(); // fills TOOL_REGISTRY

  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? mcpSessions.get(sessionId) : undefined;
    if (!transport) {
      if (req.method !== "POST" || sessionId) return sendJson(res, 404, { error: "unknown_mcp_session" });
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => { mcpSessions.set(id, created); },
      });
      created.onclose = () => { if (created.sessionId) mcpSessions.delete(created.sessionId); };
      await createMcpServer().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        applyCors(req, res, origins);
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (url.pathname === "/health") return sendJson(res, 200, { ok: true, version: SERVER_VERSION });
        if (!authorized(req, url, token)) return sendJson(res, 401, { error: "unauthorized" });

        if (url.pathname === "/mcp") return await handleMcp(req, res);
        if (req.method === "GET" && url.pathname === "/api/tools") {
          return sendJson(res, 200, [...TOOL_REGISTRY].map(([name, tool]) => ({ name, description: tool.description })));
        }
        const toolMatch = /^\/api\/tools\/([A-Za-z0-9_]+)$/.exec(url.pathname);
        if (req.method === "POST" && toolMatch) return await callTool(toolMatch[1], await readBody(req), res);
        if (await handleLiveRoute(req, res, url, () => readBody(req))) return;
        sendJson(res, 404, { error: "not_found" });
      } catch (error) {
        if (error instanceof HttpError) return sendJson(res, error.status, { error: error.code });
        console.error(chalk.red(`[Camoufox] HTTP error: ${describeError(error)}`));
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error", message: sanitizeErrorMessage(describeError(error), [], []) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  setHttpActive(true);
  startScheduler();
  addShutdownHook(async () => {
    setHttpActive(false);
    stopScheduler();
    for (const transport of mcpSessions.values()) await transport.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  console.error(chalk.yellow(`Camoufox Agent HTTP server listening on http://${host}:${port}${token ? "" : " (no token)"}`));
  return server;
}
