import type { Browser, BrowserContext, Page, Response } from "playwright-core";
import type { NetworkController } from "./network-control.js";
import type { RichCollector } from "./diagnose/collector.js";
import type { CaptchaPolicy, DiagnosticsPayload, ScreenshotMetadata } from "./payload-types.js";

export type BrowserInstance = Browser;
export type SupportedOs = "windows" | "macos" | "linux";
export type HeadlessMode = boolean | "virtual";
export type WaitStrategy = "domcontentloaded" | "load" | "networkidle";
export type ClickMode = "dom" | "pointer" | "auto";
export type StealthProfile = "normal" | "privacy" | "human_assisted" | "fast" | "debug";
export type WindowSize = [number, number];
export type SlotRelease = () => void;
export type ProxyConfig = string | { server: string; username?: string; password?: string };

export interface RequestGuard {
  assertAllowed(): void;
  watchPage(page: Page): void;
  // Reset the per-navigation request budget. Long-lived sessions reuse one
  // context across navigations; without a reset the lifetime budget is
  // exhausted after a handful of heavy pages and every request is blocked.
  resetBudget(): void;
}

export interface SessionRecord {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  requestGuard: RequestGuard;
  diagnostics: DiagnosticsCollector;
  selectedOS: SupportedOs;
  waitStrategy: WaitStrategy;
  // CAPTCHA policy persisted at session start so the documented "pause" default
  // drives detection on every subsequent navigate/action/snapshot/resume without
  // the caller re-passing captchaPolicy on each call.
  captchaPolicy: CaptchaPolicy;
  releaseSlot: SlotRelease;
  rawUrls: string[];
  secrets: string[];
  createdAt: number;
  rich?: RichCollector;
  network?: NetworkController;
  dialogPolicy?: { accept: boolean; promptText?: string };
  harPath?: string;
  tracing?: boolean;
  profile?: string;
  lastProfileSaveAt?: number;
  expiresAt: number | null;
  timer?: ReturnType<typeof setTimeout>;
  lastNavigationResponse: Response | null;
  op: Promise<void>;
  closing: boolean;
  closed: boolean;
}

export interface CamoufoxOptions {
  os?: SupportedOs[];
  headless?: HeadlessMode;
  humanize?: boolean;
  geoip?: boolean;
  ublock?: boolean;
  block_webgl?: boolean;
  block_images?: boolean;
  block_webrtc?: boolean;
  disable_coop?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
  proxy?: ProxyConfig;
  enable_cache?: boolean;
  firefox_user_prefs?: Record<string, unknown>;
  exclude_addons?: string[];
  window?: WindowSize;
  args?: string[];
  fingerprint?: Record<string, unknown>;
  i_know_what_im_doing?: boolean;
}

export interface NetworkMock {
  url: string;
  method?: string;
  status?: number;
  body?: string;
  json?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  abort?: boolean;
}

export interface NetworkControl {
  latencyMs?: number;
  blockUrls?: string[];
  mocks?: NetworkMock[];
  extraHeaders?: Record<string, string>;
  offline?: boolean;
}

export interface BrowserLaunchInput {
  os?: SupportedOs;
  waitStrategy?: WaitStrategy;
  timeout?: number;
  humanize?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
  block_webrtc?: boolean;
  proxy?: ProxyConfig;
  enable_cache?: boolean;
  firefox_user_prefs?: Record<string, unknown>;
  exclude_addons?: string[];
  window?: WindowSize;
  args?: string[];
  block_images?: boolean;
  block_webgl?: boolean;
  disable_coop?: boolean;
  geoip?: boolean;
  headless?: boolean;
  includeConsole?: boolean;
  includeNetwork?: boolean;
  stealthProfile?: StealthProfile;
  captchaPolicy?: CaptchaPolicy;
  network?: NetworkControl;
  // Internal: create the context with the page CSP bypassed (used by browse_audit to inject axe).
  bypassCSP?: boolean;
  emulation?: {
    colorScheme?: "light" | "dark" | "no-preference";
    reducedMotion?: "reduce" | "no-preference";
    timezoneId?: string;
    geolocation?: { latitude: number; longitude: number };
    offline?: boolean;
    device?: "iphone-15" | "pixel-8" | "ipad" | "laptop-720p" | "desktop-1080p";
    hasTouch?: boolean;
    forcedColors?: "active" | "none";
    contrast?: "more" | "no-preference";
    javaScriptEnabled?: boolean;
    httpCredentials?: { username: string; password: string };
  };
  // Internal: runs on the fresh context before any page exists (used by diagnostics).
  setup?: (context: BrowserContext) => Promise<void> | void;
}

export interface ExtractedContent {
  value: string;
  truncated: boolean;
  found: boolean;
}

export interface ScreenshotResult {
  screenshotMetadata: ScreenshotMetadata;
  mimeType: string;
  base64?: string;
}

export interface CommonBrowserInput extends BrowserLaunchInput {
  url: string;
}

export interface BrowserOperationContext {
  page: Page;
  response: Response | null;
  requestGuard: RequestGuard;
  diagnostics: DiagnosticsCollector;
  selectedOS: SupportedOs;
  waitStrategy: WaitStrategy;
  getLastNavigationResponse: () => Response | null;
}

export interface DiagnosticsCollector {
  payload(): DiagnosticsPayload | undefined;
}
