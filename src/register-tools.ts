import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ALLOWED_PRIVATE_HOSTS, ALLOW_EVALUATE, ALLOW_UNSAFE_OPTIONS, CAPTCHA_AUTONOMOUS, DEFAULT_STEALTH_PROFILE, DEFAULT_WAIT_STRATEGY, SERVER_VERSION } from "./config.js";
import { anyOutputSchema, browseOutputSchema, browseToolShape, consoleOutputSchema, consoleToolShape, findOutputSchema, findToolShape, formsOutputSchema, formsToolShape, linksOutputSchema, linksToolShape, networkSummaryOutputSchema, networkSummaryToolShape, outlineOutputSchema, outlineToolShape, screenshotOutputSchema, screenshotToolShape, sequenceOutputSchema, sequenceToolShape, sessionActionOutputSchema, sessionActionToolShape, sessionCloseOutputSchema, sessionCloseToolShape, sessionNavigateOutputSchema, sessionNavigateToolShape, sessionResumeOutputSchema, sessionResumeToolShape, sessionSnapshotOutputSchema, sessionSnapshotToolShape, sessionStartOutputSchema, sessionStartToolShape, snapshotOutputSchema, snapshotToolShape, statusOutputSchema, type BrowseToolInput, type ConsoleToolInput, type FindToolInput, type FormsToolInput, type LinksToolInput, type NetworkSummaryToolInput, type OutlineToolInput, type ScreenshotToolInput, type SequenceToolInput, type SessionActionToolInput, type SessionCloseToolInput, type SessionNavigateToolInput, type SessionResumeToolInput, type SessionSnapshotToolInput, type SessionStartToolInput, type SnapshotToolInput } from "./schemas.js";
import { profileDeleteToolShape, profilesListToolShape } from "./schema/tools.js";
import { profileDeleteOutputSchema, profilesListOutputSchema } from "./schema/output.js";
import { extractToolShape, type ExtractToolInput } from "./schema/tools.js";
import { extractOutputSchema } from "./schema/output.js";
import { handleExtract } from "./extract-tool.js";
import { flowListToolShape, flowRunToolShape, flowSaveToolShape, type FlowDefinition } from "./schema/tools.js";
import { flowListOutputSchema, flowRunOutputSchema, flowSaveOutputSchema } from "./schema/output.js";
import { handleFlowList, handleFlowRun, handleFlowSave } from "./flow-tools.js";
import { handleProfileDelete, handleProfilesList } from "./profile-tools.js";
import { handleBrowse, handleConsole, handleFind, handleForms, handleLinks, handleNetworkSummary, handleOutline, handleScreenshot, handleSequence, handleSnapshot, handleStatus } from "./tool-handlers.js";
import { handleSessionAction, handleSessionClose, handleSessionNavigate, handleSessionResume, handleSessionSnapshot, handleSessionStart } from "./sessions.js";

export type ToolHandler = (input: never) => Promise<CallToolResult>;
export const TOOL_REGISTRY = new Map<string, { description: string; shape: z.ZodRawShape; handler: ToolHandler }>();

let server: McpServer;

const readOnlyOpenWorld: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const nonReadOnlyOpenWorld: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// Register a JSON tool with a raw-shape input schema and an optional output
// schema. The MCP SDK's registerTool accepts both raw shapes (ZodRawShapeCompat)
// and constructed schemas (AnySchema, e.g. z.object(...)) for inputSchema and
// outputSchema, so there's no need to redeclare its signature through `unknown`.
// The wrapper keeps its own InputArgs generic; the callback is narrowed to the
// SDK's ToolCallback<InputArgs> at the boundary (the SDK has already validated
// the args against inputSchema before invoking it).
function registerJsonTool<InputArgs extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: InputArgs,
  annotations: ToolAnnotations,
  handler: (input: z.infer<z.ZodObject<InputArgs>>) => Promise<CallToolResult>,
  outputSchema: z.ZodTypeAny = anyOutputSchema,
): void {
  const callback: ToolCallback<InputArgs> = ((input: unknown) =>
    handler(input as z.infer<z.ZodObject<InputArgs>>)) as ToolCallback<InputArgs>;
  TOOL_REGISTRY.set(name, { description, shape: inputSchema, handler: handler as ToolHandler });
  server.registerTool(
    name,
    { description, inputSchema, outputSchema, annotations },
    callback,
  );
}

function registerAll(): void {
  registerJsonTool("camoufox_status", "Return server, browser, queue, session, and policy status without launching a page.", {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => handleStatus(), statusOutputSchema);

  registerJsonTool("browse", "Navigate once and return bounded page content.", browseToolShape, readOnlyOpenWorld, async (input) => handleBrowse(input as BrowseToolInput), browseOutputSchema);
  registerJsonTool("browse_snapshot", "Navigate once and return visible text, ARIA snapshot, and interactive metadata.", snapshotToolShape, readOnlyOpenWorld, async (input) => handleSnapshot(input as SnapshotToolInput), snapshotOutputSchema);
  registerJsonTool("browse_sequence", "Navigate once, run bounded selector actions, then return final state.", sequenceToolShape, nonReadOnlyOpenWorld, async (input) => handleSequence(input as SequenceToolInput), sequenceOutputSchema);
  registerJsonTool("browse_links", "Navigate once and return only visible navigable links.", linksToolShape, readOnlyOpenWorld, async (input) => handleLinks(input as LinksToolInput), linksOutputSchema);
  registerJsonTool("browse_forms", "Navigate once and return form fields and submit controls.", formsToolShape, readOnlyOpenWorld, async (input) => handleForms(input as FormsToolInput), formsOutputSchema);
  registerJsonTool("browse_outline", "Navigate once and return page headings and landmarks.", outlineToolShape, readOnlyOpenWorld, async (input) => handleOutline(input as OutlineToolInput), outlineOutputSchema);
  registerJsonTool("browse_find", "Navigate once, search visible text, and return bounded context matches.", findToolShape, readOnlyOpenWorld, async (input) => handleFind(input as FindToolInput), findOutputSchema);
  registerJsonTool("browse_screenshot", "Navigate once and capture a bounded screenshot.", screenshotToolShape, readOnlyOpenWorld, async (input) => handleScreenshot(input as ScreenshotToolInput), screenshotOutputSchema);
  registerJsonTool("browse_console", "Navigate once and return bounded console diagnostics.", consoleToolShape, readOnlyOpenWorld, async (input) => handleConsole(input as ConsoleToolInput), consoleOutputSchema);
  registerJsonTool("browse_network_summary", "Navigate once and return a bounded network diagnostic summary.", networkSummaryToolShape, readOnlyOpenWorld, async (input) => handleNetworkSummary(input as NetworkSummaryToolInput), networkSummaryOutputSchema);
  registerJsonTool("browse_session_start", "Start an isolated short-lived browser session.", sessionStartToolShape, nonReadOnlyOpenWorld, async (input) => handleSessionStart(input as SessionStartToolInput), sessionStartOutputSchema);
  registerJsonTool("browse_session_navigate", "Navigate an existing browser session.", sessionNavigateToolShape, nonReadOnlyOpenWorld, async (input) => handleSessionNavigate(input as SessionNavigateToolInput), sessionNavigateOutputSchema);
  registerJsonTool("browse_session_action", "Run one bounded action in an existing browser session.", sessionActionToolShape, nonReadOnlyOpenWorld, async (input) => handleSessionAction(input as SessionActionToolInput), sessionActionOutputSchema);
  registerJsonTool("browse_session_snapshot", "Read the current state of an existing browser session.", sessionSnapshotToolShape, readOnlyOpenWorld, async (input) => handleSessionSnapshot(input as SessionSnapshotToolInput), sessionSnapshotOutputSchema);
  registerJsonTool("browse_session_resume", "Resume a paused session after human action and return current state.", sessionResumeToolShape, nonReadOnlyOpenWorld, async (input) => handleSessionResume(input as SessionResumeToolInput), sessionResumeOutputSchema);
  registerJsonTool("browse_session_close", "Close an existing browser session.", sessionCloseToolShape, nonReadOnlyOpenWorld, async (input) => handleSessionClose(input as SessionCloseToolInput), sessionCloseOutputSchema);

  registerJsonTool("browse_extract", "Extract repeated items (rows/cards) into structured JSON, optionally paginating and saving to JSON/CSV under CAMOUFOX_MCP_FILES_DIR/exports. Use url (one-shot) or sessionId.", extractToolShape, nonReadOnlyOpenWorld, async (input) => handleExtract(input as ExtractToolInput), extractOutputSchema);
  registerJsonTool("flow_list", "List saved flows (scripted login/automation) with their schedule and last run.", flowListToolShape, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => handleFlowList(), flowListOutputSchema);
  registerJsonTool("flow_save", "Create or overwrite a saved flow: optional profile, startUrl, bounded actions, optional extract and cron schedule.", flowSaveToolShape, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async (input) => handleFlowSave(input as { name: string; flow: FlowDefinition }), flowSaveOutputSchema);
  registerJsonTool("flow_run", "Run a saved flow now and return its result (also stored under runs/).", flowRunToolShape, nonReadOnlyOpenWorld, async (input) => handleFlowRun(input), flowRunOutputSchema);
  registerJsonTool("browse_profiles_list", "List named persistent browser profiles.", profilesListToolShape, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, async () => handleProfilesList(), profilesListOutputSchema);
  registerJsonTool("browse_profile_delete", "Delete a named browser profile and its saved logins.", profileDeleteToolShape, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, async (input) => handleProfileDelete(input), profileDeleteOutputSchema);
}

export function createMcpServer(): McpServer {
  server = new McpServer(
    { name: "camoufox-agent", version: SERVER_VERSION },
    {
      capabilities: {
        extensions: {
          "camoufox-mcp": {
            policy: {
              unsafeOptionsAllowed: ALLOW_UNSAFE_OPTIONS,
              evaluateAllowed: ALLOW_EVALUATE,
              captchaAutonomous: CAPTCHA_AUTONOMOUS,
              allowedPrivateHosts: [...ALLOWED_PRIVATE_HOSTS],
              defaultWaitStrategy: DEFAULT_WAIT_STRATEGY,
              defaultStealthProfile: DEFAULT_STEALTH_PROFILE,
            },
            tools: {
              browseSessionNavigateWaitStrategy: true,
            },
          },
        },
      },
    },
  );

  registerAll();
  return server;
}
