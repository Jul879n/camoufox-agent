import { z } from "zod";
import {
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ELEMENTS,
  DEFAULT_WAIT_STRATEGY,
  MAX_MAX_CHARS,
  MAX_MAX_ELEMENTS,
  MAX_SEQUENCE_ACTIONS,
} from "../config.js";
import type { WindowSize } from "../types.js";
import { PROFILE_NAME } from "../profiles.js";
import { captchaPolicySchema, screenshotOptionsSchema, stealthProfileSchema, viewportSchema, windowSchema, proxySchema } from "./primitives.js";

export const emulationSchema = z.object({
  colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
  reducedMotion: z.enum(["reduce", "no-preference"]).optional(),
  timezoneId: z.string().max(100).optional().describe("IANA timezone, e.g. America/Santiago."),
  geolocation: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).optional(),
  offline: z.boolean().optional().describe("Start with the network off (test offline behaviour)."),
  device: z.enum(["iphone-15", "pixel-8", "ipad", "laptop-720p", "desktop-1080p"]).optional().describe("Viewport, pixel ratio and touch preset. Does not change the user agent (that would break the fingerprint)."),
  hasTouch: z.boolean().optional().describe("Enable touch events (overrides the device preset)."),
  forcedColors: z.enum(["active", "none"]).optional(),
  contrast: z.enum(["more", "no-preference"]).optional(),
  javaScriptEnabled: z.boolean().optional().describe("false disables JavaScript in the page."),
  httpCredentials: z.object({ username: z.string().max(200), password: z.string().max(500) }).optional().describe("Basic-auth credentials; the password is redacted from outputs."),
}).optional().describe("Context emulation for diagnosing how the page behaves under other conditions.");

export const networkControlSchema = z.object({
  latencyMs: z.number().int().min(0).max(10000).describe("Delay added to every request."),
  blockUrls: z.array(z.string().max(2000)).max(50).describe("URL globs to abort (e.g. **/analytics/**)."),
  mocks: z.array(z.object({
    url: z.string().max(2000).describe("URL glob to answer locally."),
    method: z.string().max(10).optional(),
    status: z.number().int().min(100).max(599).optional().default(200),
    body: z.string().max(200000).optional(),
    json: z.any().optional().describe("Serialized as the body with content-type application/json."),
    contentType: z.string().max(200).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    delayMs: z.number().int().min(0).max(30000).optional(),
    abort: z.boolean().optional().describe("Fail the request instead of answering it."),
  })).max(20),
  extraHeaders: z.record(z.string(), z.string()),
  offline: z.boolean(),
}).partial().describe("Network control: latency, blocked URLs, mocked responses, extra headers, offline. Replaces the previous control on sessions.");

export const commonBrowserOptionShape = {
  emulation: emulationSchema,
  network: networkControlSchema.optional(),
  os: z.enum(["windows", "macos", "linux"]).optional().describe("Optional OS to spoof. Can be 'windows', 'macos', or 'linux'. If not specified, will rotate between all OS types."),
  waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT_STRATEGY).describe("Wait strategy for page load. Defaults to 'domcontentloaded'. 'load' waits for all resources, 'networkidle' waits for network activity to finish."),
  timeout: z.number().min(5000).max(300000).optional().default(60000).describe("Timeout in milliseconds for page load (5-300 seconds)."),
  humanize: z.boolean().optional().describe("Enable realistic cursor movements and human-like behavior for better stealth and anti-detection."),
  locale: z.string().optional().describe("Browser locale (e.g., 'en-US', 'fr-FR')."),
  viewport: viewportSchema,
  block_webrtc: z.boolean().optional().describe("Block WebRTC entirely for enhanced privacy and stealth."),
  proxy: proxySchema,
  enable_cache: z.boolean().optional().describe("Cache pages, requests, etc. Uses more memory but improves performance when revisiting pages."),
  firefox_user_prefs: z.record(z.string(), z.any()).optional().describe("Custom Firefox user preferences to set. Rejected unless CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1; denied prefs are always rejected."),
  exclude_addons: z.array(z.string()).optional().describe("List of default addons to exclude (e.g., ['ublock_origin']). Rejected unless CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1."),
  window: windowSchema,
  args: z.array(z.string()).optional().describe("Additional browser command-line arguments to pass to the browser. Rejected unless CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1; denied args are always rejected."),
  block_images: z.boolean().optional().describe("Block all images for faster loading, reduced bandwidth, and lightweight browsing."),
  block_webgl: z.boolean().optional().describe("Block WebGL to prevent fingerprinting and tracking."),
  disable_coop: z.boolean().optional().describe("Disable Cross-Origin-Opener-Policy for sites that require it."),
  geoip: z.boolean().optional().describe("Automatically detect geolocation based on IP address."),
  headless: z.boolean().optional().describe("Run browser in headless mode. Auto-detects best mode for environment if not specified."),
  includeConsole: z.boolean().optional().describe("Include bounded page console diagnostics in the JSON response."),
  includeNetwork: z.boolean().optional().describe("Include bounded network diagnostics in the JSON response."),
  stealthProfile: stealthProfileSchema,
  captchaPolicy: captchaPolicySchema,
};

export const commonBrowserToolShape = {
  url: z.string().describe("The URL to navigate to. Must be a fully qualified http or https URL."),
  ...commonBrowserOptionShape,
};

export const browseToolShape = {
  ...commonBrowserToolShape,
  url: z.string().describe("The URL to navigate to and retrieve content from. Use this tool when users ask to visit, check, search, navigate, browse, fetch, or scrape websites. Must be a fully qualified URL (e.g., 'https://example.com')."),
  outputMode: z.enum(["text", "html", "metadata"]).optional().default("text").describe("Response content mode. Defaults to visible text. Use 'html' only when raw HTML is explicitly needed."),
  maxChars: z.number().int().min(1000).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum text or HTML characters to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit extraction to one matching element."),
  screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image of the page after loading."),
  screenshotOptions: screenshotOptionsSchema,
};

export const snapshotToolShape = {
  ...commonBrowserToolShape,
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum visible text and ARIA snapshot characters to return."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum interactive elements to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit snapshot extraction to one matching element."),
};

export const actionTimeoutSchema = z.number().min(100).max(60000).optional();
export const humanTimeoutSchema = z.number().min(1000).max(3600000).optional().describe("Max ms to wait for a human (default 600000).");
export const frameSchema = z.string().max(2000).optional()
  .describe("CSS selector of an iframe. The action's selector is resolved inside this iframe.");

export const sequenceActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    selector: z.string().max(2000),
    frame: frameSchema,
    clickMode: z.enum(["dom", "pointer", "auto"]).optional().default("dom")
      .describe("Click implementation. 'dom' uses DOM activation for CI stability. 'pointer' uses Playwright pointer input. 'auto' tries pointer first and falls back to DOM activation."),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("drag"),
    selector: z.string().max(2000).describe("Element to drag."),
    target: z.string().max(2000).describe("Element to drop onto."),
    frame: frameSchema,
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("hover"),
    selector: z.string().max(2000),
    frame: frameSchema,
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("fill"),
    selector: z.string().max(2000),
    frame: frameSchema,
    value: z.string().max(MAX_MAX_CHARS),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("type"),
    selector: z.string().max(2000),
    frame: frameSchema,
    text: z.string().max(MAX_MAX_CHARS),
    delay: z.number().min(0).max(1000).optional().default(0),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("select"),
    selector: z.string().max(2000),
    frame: frameSchema,
    value: z.union([z.string(), z.array(z.string())]),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("press"),
    selector: z.string().max(2000).optional(),
    frame: frameSchema,
    key: z.string().min(1).max(100),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("waitFor"),
    selector: z.string().max(2000).optional(),
    frame: frameSchema,
    state: z.enum(["attached", "detached", "visible", "hidden"]).optional().default("visible"),
    loadState: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("scroll"),
    selector: z.string().max(2000).optional(),
    frame: frameSchema,
    deltaX: z.number().min(-10000).max(10000).optional().default(0),
    deltaY: z.number().min(-10000).max(10000).optional().default(600),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("upload"),
    selector: z.string().max(2000).describe("File input, or element that opens the native file chooser when clicked."),
    frame: frameSchema,
    files: z.array(z.string().max(1000)).min(1).max(10).describe("Absolute paths inside CAMOUFOX_MCP_FILES_DIR."),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("download"),
    selector: z.string().max(2000).describe("Element that triggers a download when clicked."),
    frame: frameSchema,
    filename: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/).describe("File name saved under CAMOUFOX_MCP_FILES_DIR/descargas."),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("fillSecret"),
    selector: z.string().max(2000),
    frame: frameSchema,
    secret: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe("Name of a stored secret (CAMOUFOX_SECRET_<NAME> or secrets.json). The value is never returned."),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("goto"),
    url: z.string().describe("Fully qualified http or https URL. Subject to the same URL policy as the initial navigation."),
    waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
    timeout: z.number().min(5000).max(300000).optional(),
  }),
  z.object({
    type: z.literal("waitForHuman"),
    reason: z.string().min(1).max(500).describe("What the human must do (solve a captcha, approve a login...)."),
    until: z.string().max(2000).optional().describe("CSS selector that, once visible, continues without waiting for the human to press Done."),
    timeout: humanTimeoutSchema,
  }),
  z.object({
    type: z.literal("promptCode"),
    selector: z.string().max(2000),
    frame: frameSchema,
    label: z.string().min(1).max(200).describe("What code is needed (e.g. 'SMS code')."),
    timeout: humanTimeoutSchema,
  }),
  z.object({
    type: z.literal("expect"),
    check: z.enum(["visible", "hidden", "text", "textContains", "value", "attribute", "count", "enabled", "disabled", "checked", "url", "urlContains", "title", "titleContains", "noConsoleErrors", "noFailedRequests", "noHttpErrors"]),
    selector: z.string().max(2000).optional(),
    frame: frameSchema,
    attribute: z.string().max(100).optional(),
    equals: z.union([z.string(), z.number()]).optional(),
    soft: z.boolean().optional().default(false).describe("Record the failure and continue instead of throwing."),
    timeout: actionTimeoutSchema.describe("Retry window in ms (default 5000)."),
  }),
  z.object({ type: z.literal("clearDiagnostics"), timeout: actionTimeoutSchema }),
  z.object({
    type: z.literal("dialog"),
    accept: z.boolean().describe("How to answer alert/confirm/prompt dialogs from now on (default policy: dismiss)."),
    promptText: z.string().max(1000).optional(),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("evaluate"),
    expression: z.string().max(4000),
    timeout: actionTimeoutSchema,
    maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS),
  }),
]);

export const sequenceToolShape = {
  ...commonBrowserToolShape,
  actions: z.array(sequenceActionSchema).max(MAX_SEQUENCE_ACTIONS).describe("Bounded action sequence to run after navigation."),
  outputMode: z.enum(["text", "html", "metadata"]).optional().default("text").describe("Final response content mode."),
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum final text, HTML, snapshot, or evaluate-result characters to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit final content extraction to one matching element."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum final snapshot elements to return."),
  screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image after all actions finish."),
  screenshotOptions: screenshotOptionsSchema,
};

export const selectorLimitShape = {
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit extraction to one matching element."),
};

export const linksToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  maxLinks: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum links to return."),
};

export const formsToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  maxForms: z.number().int().min(1).max(100).optional().default(20).describe("Maximum forms to return."),
  maxFields: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum fields to return across all forms."),
};

export const outlineToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  maxItems: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum headings and landmarks to return."),
};

export const findToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  query: z.string().min(1).max(500).describe("Visible text to search for on the page."),
  maxMatches: z.number().int().min(1).max(50).optional().default(5).describe("Maximum matches to return."),
  contextChars: z.number().int().min(50).max(2000).optional().default(300).describe("Characters of surrounding visible text to return per match."),
};

export const screenshotToolShape = {
  ...commonBrowserToolShape,
  selector: z.string().max(2000).optional().describe("Optional CSS selector for element-only screenshots."),
  fullPage: z.boolean().optional().default(false).describe("Capture the full page instead of only the viewport."),
  type: z.enum(["png", "jpeg"]).optional().default("png").describe("Screenshot image type."),
  quality: z.number().int().min(1).max(100).optional().describe("JPEG quality from 1-100. Ignored for PNG."),
};

export const consoleToolShape = {
  ...commonBrowserToolShape,
  // browse_console exists to surface console diagnostics, so default to
  // collecting them. includeNetwork stays caller-controlled (defaults off) and
  // is honored rather than silently overridden by the handler.
  includeConsole: z.boolean().optional().default(true).describe("Include bounded page console diagnostics in the JSON response."),
};

export const networkSummaryToolShape = {
  ...commonBrowserToolShape,
  // browse_network_summary exists to surface network diagnostics, so default to
  // collecting them. includeConsole stays caller-controlled (defaults off).
  includeNetwork: z.boolean().optional().default(true).describe("Include bounded network diagnostics in the JSON response."),
  maxFailures: z.number().int().min(0).max(50).optional().default(10).describe("Maximum failed requests to include in the summary."),
};

export const sessionStartToolShape = {
  ...commonBrowserOptionShape,
  recordHar: z.string().regex(/^[A-Za-z0-9._-]+\.har$/).optional().describe("Record all network traffic to CAMOUFOX_MCP_FILES_DIR/exports/<name>.har, written when the session closes."),
  profile: z.string().regex(PROFILE_NAME).optional().describe("Named persistent profile (cookies, localStorage, IndexedDB). Keeps logins between sessions; its os/locale/proxy/window/fingerprint override the input."),
};

export const sessionIdShape = {
  sessionId: z.string().min(1).max(200).describe("Session ID returned by browse_session_start."),
};

export const sessionNavigateToolShape = {
  ...sessionIdShape,
  url: z.string().describe("The URL to navigate to. Must be a fully qualified http or https URL."),
  waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().describe("Optional wait strategy override for this navigation."),
  timeout: z.number().min(5000).max(300000).optional().describe("Optional timeout override for this navigation."),
  outputMode: z.enum(["text", "html", "metadata"]).optional().default("text").describe("Response content mode."),
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum text or HTML characters to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit extraction."),
  captchaPolicy: captchaPolicySchema,
};

export const sessionActionToolShape = {
  ...sessionIdShape,
  action: sequenceActionSchema.describe("One bounded action to run in the existing session."),
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum final visible text characters to return in snapshot."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum final snapshot elements to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit final snapshot."),
  captchaPolicy: captchaPolicySchema,
};

export const sessionSnapshotToolShape = {
  ...sessionIdShape,
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum visible text and ARIA snapshot characters to return."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum interactive elements to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit snapshot extraction."),
  captchaPolicy: captchaPolicySchema,
};

export const sessionResumeToolShape = {
  ...sessionSnapshotToolShape,
  waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().describe("Optional load state to wait for before reading the session."),
  timeout: z.number().min(100).max(60000).optional().default(DEFAULT_ACTION_TIMEOUT_MS).describe("Timeout in milliseconds for the resume wait."),
};

export const sessionCloseToolShape = {
  ...sessionIdShape,
};

export type WithWindowSize<T> = Omit<T, "window"> & { window?: WindowSize };
export type BrowseToolInput = WithWindowSize<z.infer<z.ZodObject<typeof browseToolShape>>>;
export type SnapshotToolInput = WithWindowSize<z.infer<z.ZodObject<typeof snapshotToolShape>>>;
export type SequenceToolInput = WithWindowSize<z.infer<z.ZodObject<typeof sequenceToolShape>>>;
export type SequenceAction = z.infer<typeof sequenceActionSchema>;
export type LinksToolInput = WithWindowSize<z.infer<z.ZodObject<typeof linksToolShape>>>;
export type FormsToolInput = WithWindowSize<z.infer<z.ZodObject<typeof formsToolShape>>>;
export type OutlineToolInput = WithWindowSize<z.infer<z.ZodObject<typeof outlineToolShape>>>;
export type FindToolInput = WithWindowSize<z.infer<z.ZodObject<typeof findToolShape>>>;
export type ScreenshotToolInput = WithWindowSize<z.infer<z.ZodObject<typeof screenshotToolShape>>>;
export type ConsoleToolInput = WithWindowSize<z.infer<z.ZodObject<typeof consoleToolShape>>>;
export type NetworkSummaryToolInput = WithWindowSize<z.infer<z.ZodObject<typeof networkSummaryToolShape>>>;
export type SessionStartToolInput = WithWindowSize<z.infer<z.ZodObject<typeof sessionStartToolShape>>>;
export type SessionNavigateToolInput = z.infer<z.ZodObject<typeof sessionNavigateToolShape>>;
export type SessionActionToolInput = z.infer<z.ZodObject<typeof sessionActionToolShape>>;
export type SessionSnapshotToolInput = z.infer<z.ZodObject<typeof sessionSnapshotToolShape>>;
export type SessionResumeToolInput = z.infer<z.ZodObject<typeof sessionResumeToolShape>>;
export type SessionCloseToolInput = z.infer<z.ZodObject<typeof sessionCloseToolShape>>;

export const profilesListToolShape = {};
export const profileDeleteToolShape = {
  name: z.string().regex(PROFILE_NAME).describe("Profile name to delete (must not be in use)."),
};

export const extractFieldSchema = z.object({
  selector: z.string().max(2000).optional().describe("CSS selector relative to the item. Omit to use the item itself."),
  attr: z.string().max(100).optional().describe("Attribute to read. href/src return absolute URLs. Omit for visible text."),
  all: z.boolean().optional().describe("Return an array with every match instead of the first."),
});

export const extractSpecShape = {
  itemSelector: z.string().max(2000).describe("CSS selector of each repeated item (row/card)."),
  fields: z.record(z.string().min(1).max(100), extractFieldSchema).describe("Output columns: name -> how to read it from each item."),
  nextSelector: z.string().max(2000).optional().describe("CSS selector of the 'next page' control; clicked until maxPages."),
  maxPages: z.number().int().min(1).max(50).optional().default(1),
  maxItems: z.number().int().min(1).max(10000).optional().default(500),
  saveAs: z.string().regex(/^[A-Za-z0-9._-]+\.(json|csv)$/).optional().describe("Save all rows to CAMOUFOX_MCP_FILES_DIR/exports/<saveAs> (.json or .csv)."),
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum JSON characters of rows returned inline (when not saving)."),
};

export const extractToolShape = {
  ...commonBrowserToolShape,
  url: z.string().optional().describe("URL to extract from (one-shot). Provide exactly one of url or sessionId."),
  sessionId: z.string().min(1).max(200).optional().describe("Existing session to extract from, at its current page. Provide exactly one of url or sessionId."),
  ...extractSpecShape,
};

export type ExtractToolInput = WithWindowSize<z.infer<z.ZodObject<typeof extractToolShape>>>;

export const flowSchema = z.object({
  profile: z.string().regex(PROFILE_NAME).optional().describe("Named profile whose saved login the flow reuses."),
  startUrl: z.string().refine((value) => /^https?:\/\//i.test(value), "startUrl must be http(s)"),
  actions: z.array(sequenceActionSchema).max(MAX_SEQUENCE_ACTIONS),
  extract: z.object(extractSpecShape).optional().describe("Structured extraction run after the actions."),
  schedule: z.string().max(100).optional().describe("Cron expression (5 fields) used by `camoufox-agent serve`."),
  timezone: z.string().max(100).optional(),
  headless: z.union([z.boolean(), z.literal("virtual")]).optional(),
});

export type FlowDefinition = z.infer<typeof flowSchema>;

export const flowNameShape = {
  name: z.string().regex(PROFILE_NAME).describe("Flow name (lowercase letters, digits, - and _)."),
};
export const flowListToolShape = {};
export const flowSaveToolShape = {
  ...flowNameShape,
  flow: flowSchema,
};
export const flowRunToolShape = flowNameShape;

const diagnoseSectionSchema = z.enum(["console", "network", "perf", "audit"]);

export const diagnoseToolShape = {
  ...commonBrowserToolShape,
  url: z.string().optional().describe("URL to diagnose (one-shot). Provide exactly one of url or sessionId."),
  sessionId: z.string().min(1).max(200).optional().describe("Existing session. Data covers everything since the session started (or since the last reload:true)."),
  sections: z.array(diagnoseSectionSchema).min(1).optional().describe("Defaults to all: console (logs + uncaught errors), network (timings, sizes, failures), perf (navigation timing, Web Vitals, DOM stats), audit (SEO, a11y, security headers, cookies, mixed content)."),
  settleMs: z.number().int().min(0).max(30000).optional().default(1500).describe("Extra time after load for vitals and late requests."),
  reload: z.boolean().optional().default(false).describe("Sessions only: clear collected data and reload the page first for a clean measurement."),
  maxEntries: z.number().int().min(1).max(1000).optional().default(100).describe("Max console/network entries returned per list."),
  budgets: z.object({
    maxLoadMs: z.number().int().min(0), maxFcpMs: z.number().int().min(0), maxLcpMs: z.number().int().min(0), maxTtfbMs: z.number().int().min(0),
    maxTbtMs: z.number().int().min(0), maxDomNodes: z.number().int().min(0), maxRequests: z.number().int().min(0), maxTotalBytes: z.number().int().min(0),
    maxConsoleErrors: z.number().int().min(0), maxFailedRequests: z.number().int().min(0),
  }).partial().optional().describe("Performance budgets; the report gains budgets.passed and per-metric results. Metrics from omitted sections enable that section."),
  saveAs: z.string().regex(/^[A-Za-z0-9._-]+\.json$/).optional().describe("Also save the full report to CAMOUFOX_MCP_FILES_DIR/exports/<saveAs>."),
};
export type DiagnoseToolInput = WithWindowSize<z.infer<z.ZodObject<typeof diagnoseToolShape>>>;

export const auditToolShape = {
  ...commonBrowserToolShape,
  url: z.string().optional().describe("URL to audit (one-shot). Provide exactly one of url or sessionId."),
  sessionId: z.string().min(1).max(200).optional().describe("Existing session, audited at its current page."),
  categories: z.array(z.enum(["performance", "accessibility", "best-practices", "seo", "security"])).min(1).optional().describe("Defaults to all five."),
  formFactor: z.enum(["mobile", "desktop"]).optional().default("desktop").describe("mobile uses the pixel-8 viewport/touch preset and Lighthouse's mobile control points."),
  settleMs: z.number().int().min(0).max(30000).optional().default(1500),
  saveAs: z.string().regex(/^[A-Za-z0-9._-]+\.(json|html)$/).optional().describe("Save the report under exports/. .html gives a self-contained page."),
};
export type AuditToolInput = WithWindowSize<z.infer<z.ZodObject<typeof auditToolShape>>>;

export const inspectToolShape = {
  ...commonBrowserToolShape,
  url: z.string().optional().describe("URL to inspect (one-shot). Provide exactly one of url or sessionId."),
  sessionId: z.string().min(1).max(200).optional().describe("Existing session, inspected at its current page."),
  selector: z.string().min(1).max(2000).describe("CSS selector of the element to inspect (first match)."),
  frame: frameSchema,
  properties: z.array(z.string().max(100)).max(100).optional().describe("Computed style properties to return. Defaults to a layout/typography set."),
  maxRules: z.number().int().min(0).max(200).optional().default(30).describe("Max matched CSS rules to return."),
};
export type InspectToolInput = WithWindowSize<z.infer<z.ZodObject<typeof inspectToolShape>>>;

export const sessionTraceToolShape = {
  ...sessionIdShape,
  action: z.enum(["start", "stop"]).describe("start: begin a Playwright trace (screenshots, DOM snapshots, network). stop: write it to exports/<saveAs>."),
  saveAs: z.string().regex(/^[A-Za-z0-9._-]+\.zip$/).optional().describe("Required on stop. View with `npx playwright show-trace`."),
};
export type SessionTraceToolInput = z.infer<z.ZodObject<typeof sessionTraceToolShape>>;

export const sessionTabsToolShape = {
  ...sessionIdShape,
  action: z.enum(["list", "new", "select", "close"]),
  index: z.number().int().min(0).optional().describe("Tab index for select/close."),
  url: z.string().max(4000).optional().describe("URL to open for action=new."),
};
export type SessionTabsToolInput = z.infer<z.ZodObject<typeof sessionTabsToolShape>>;

export const sessionNetworkToolShape = {
  ...sessionIdShape,
  network: networkControlSchema.describe("New network control. Send {} to clear it."),
};
export type SessionNetworkToolInput = z.infer<z.ZodObject<typeof sessionNetworkToolShape>>;

export const networkRequestToolShape = {
  ...sessionIdShape,
  id: z.number().int().min(1).describe("Request id from browse_diagnose network.entries."),
  includeBody: z.boolean().optional().default(true),
  maxBodyBytes: z.number().int().min(1).max(1000000).optional().default(100000),
};
export type NetworkRequestToolInput = z.infer<z.ZodObject<typeof networkRequestToolShape>>;

export const storageToolShape = {
  ...sessionIdShape,
  kinds: z.array(z.enum(["cookies", "localStorage", "sessionStorage", "indexedDB", "serviceWorkers"])).min(1).optional().describe("Defaults to all kinds."),
  includeValues: z.boolean().optional().default(false).describe("Include values (truncated to 200 chars). Hidden by default so tokens do not reach the model."),
};
export type StorageToolInput = z.infer<z.ZodObject<typeof storageToolShape>>;

export const profileAppToolShape = {
  ...sessionIdShape,
  mode: z.enum(["leaks", "cssCoverage"]).describe("leaks: repeat actions and measure DOM nodes, event listeners and timers growth. cssCoverage: report CSS rules that never matched an element."),
  actions: z.array(sequenceActionSchema).max(20).optional().describe("Actions run on every iteration (e.g. open and close a modal)."),
  iterations: z.number().int().min(2).max(50).optional().default(5),
};
export type ProfileAppToolInput = z.infer<z.ZodObject<typeof profileAppToolShape>>;

export const visualDiffToolShape = {
  ...sessionIdShape,
  name: z.string().regex(/^[a-z0-9-]{1,60}$/).describe("Baseline name (stored under the agent home, reused across runs)."),
  selector: z.string().max(2000).optional().describe("Capture only this element."),
  fullPage: z.boolean().optional().default(true),
  threshold: z.number().min(0).max(1).optional().default(0.1).describe("Per-pixel colour distance (0-1) above which a pixel counts as different."),
  maxDiffPct: z.number().min(0).max(100).optional().default(0.5).describe("Fail when more than this percentage of pixels differ."),
  update: z.boolean().optional().default(false).describe("Overwrite the baseline with the current capture."),
};
export type VisualDiffToolInput = z.infer<z.ZodObject<typeof visualDiffToolShape>>;
