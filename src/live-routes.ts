import type http from "node:http";
import { z } from "zod";
import { LIVE_HTML } from "./live-page.js";
import { listPending, resolvePending } from "./human.js";
import { listSessions, peekSession } from "./sessions.js";
import { listRuns } from "./flows.js";
import { sendJson } from "./http-server.js";

const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().min(0).max(10000), y: z.number().min(0).max(10000) }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(50) }),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(5000) }),
  z.object({ type: z.literal("scroll"), deltaY: z.number().min(-10000).max(10000) }),
]);

// Live view and human-in-the-loop endpoints. The frame/input routes act on the page
// directly (no per-session lock) so they keep working while an action waits for a human.
export async function handleLiveRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  body: () => Promise<unknown>,
): Promise<boolean> {
  const path = url.pathname;

  if (req.method === "GET" && path === "/live") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(LIVE_HTML);
    return true;
  }
  if (req.method === "GET" && path === "/api/human") {
    sendJson(res, 200, listPending());
    return true;
  }
  const human = /^\/api\/human\/([0-9a-f-]+)$/.exec(path);
  if (req.method === "POST" && human) {
    const parsed = z.object({ code: z.string().max(200).optional() }).safeParse((await body()) ?? {});
    if (!parsed.success) { sendJson(res, 400, { error: "invalid_input", issues: parsed.error.issues }); return true; }
    if (resolvePending(human[1], parsed.data)) sendJson(res, 200, { ok: true });
    else sendJson(res, 404, { error: "not_found" });
    return true;
  }
  if (req.method === "GET" && path === "/api/sessions") {
    sendJson(res, 200, listSessions());
    return true;
  }
  const frame = /^\/api\/sessions\/([^/]+)\/frame\.jpg$/.exec(path);
  if (req.method === "GET" && frame) {
    const session = peekSession(decodeURIComponent(frame[1]));
    if (!session || session.closed) { sendJson(res, 404, { error: "not_found" }); return true; }
    const jpeg = await session.page.screenshot({ type: "jpeg", quality: 60 });
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
    res.end(jpeg);
    return true;
  }
  const inputRoute = /^\/api\/sessions\/([^/]+)\/input$/.exec(path);
  if (req.method === "POST" && inputRoute) {
    const session = peekSession(decodeURIComponent(inputRoute[1]));
    if (!session || session.closed) { sendJson(res, 404, { error: "not_found" }); return true; }
    const parsed = inputSchema.safeParse(await body());
    if (!parsed.success) { sendJson(res, 400, { error: "invalid_input", issues: parsed.error.issues }); return true; }
    const event = parsed.data;
    if (event.type === "click") await session.page.mouse.click(event.x, event.y);
    else if (event.type === "key") await session.page.keyboard.press(event.key);
    else if (event.type === "type") await session.page.keyboard.type(event.text);
    else await session.page.mouse.wheel(0, event.deltaY);
    sendJson(res, 200, { ok: true });
    return true;
  }
  const runs = /^\/api\/flows\/([a-z0-9_-]+)\/runs$/.exec(path);
  if (req.method === "GET" && runs) {
    sendJson(res, 200, listRuns(runs[1], Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20))));
    return true;
  }
  return false;
}
