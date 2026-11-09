import "./sqlite-compat.js";
import { TOOL_REGISTRY, createMcpServer, invokeTool } from "./register-tools.js";

export { scrape } from "./scrape/index.js";
export type { ScrapeResult, ScrapeOptions, ScrapeEngine } from "./scrape/index.js";
export { runFlow, runFlowDefinition, saveFlow, listFlows } from "./flows.js";
export {
  handleSessionStart as startSession,
  handleSessionNavigate as navigateSession,
  handleSessionAction as sessionAction,
  handleSessionClose as closeSession,
} from "./sessions.js";
export { closeActiveBrowsers as close } from "./browser-runtime.js";
export { startHttpServer } from "./http-server.js";

/** Call any MCP tool by name with JSON arguments; returns the HTTP-style status and JSON payload. */
export function callTool(name: string, body?: unknown): ReturnType<typeof invokeTool> {
  if (TOOL_REGISTRY.size === 0) createMcpServer();
  return invokeTool(name, body);
}
