import type { Download as PwDownload, Locator, Page, Request as PwRequest, Response as PwResponse } from "playwright-core";
import chalk from "chalk";
import { ALLOW_EVALUATE, DEFAULT_ACTION_TIMEOUT_MS, SEQUENCE_TIMEOUT_MS } from "./config.js";
import type { SequenceAction } from "./schemas.js";
import type { ClickMode, RequestGuard, SequenceActionResult } from "./types.js";
import { describeError, redactUrl, serializeBounded, withTimeout } from "./utils.js";
import { settleAndAssertSafe } from "./browser-runtime.js";
import fs from "node:fs";
import path from "node:path";
import { validateBrowserRequestUrl, validateTargetUrl } from "./policy.js";
import { getSecret } from "./secrets.js";
import { filesRoot, insideRoot } from "./files.js";
import type { RichCollector } from "./diagnose/collector.js";
import { runExpect } from "./expect.js";

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120000;

export function actionTimeout(action: { type?: string; timeout?: number }): number {
  return action.timeout ?? (action.type === "download" ? DEFAULT_DOWNLOAD_TIMEOUT_MS : DEFAULT_ACTION_TIMEOUT_MS);
}

export function sequenceTimeoutBudget(actions: SequenceAction[]): number {
  return actions.reduce((total, action) => total + actionTimeout(action), 0);
}

export function isLocalOperationTimeout(error: unknown): boolean {
  return describeError(error).endsWith(" timed out.");
}

const DOWNLOAD_START_TIMEOUT_MS = 30000;

// Runs `trigger` and waits for the download, failing fast on anything that shows it will not come:
// an error response or network failure on a navigation, a page instead of a file, or no download
// starting within DOWNLOAD_START_TIMEOUT_MS. Only the transfer itself gets the full `timeout`.
async function runDownload(source: Page, trigger: () => Promise<void>, target: string, timeout: number): Promise<void> {
  const context = source.context();
  const startMs = Math.min(timeout, DOWNLOAD_START_TIMEOUT_MS);
  let stopWatching = (): void => undefined;
  // Only requests issued during this call count; late events of an earlier navigation must not leak in.
  const mine = new WeakSet<PwRequest>();
  const failure = new Promise<never>((_, reject) => {
    // Top-level frames only: an iframe or tracker navigation that errors must not fail the download.
    const onRequest = (request: PwRequest): void => {
      try {
        if (request.frame().parentFrame() === null) mine.add(request);
      } catch {
        // A popup's first navigation request has no frame yet (Playwright throws): it is top-level.
        mine.add(request);
      }
    };
    const onResponse = (response: PwResponse): void => {
      if (mine.has(response.request()) && response.request().isNavigationRequest() && response.status() >= 400) {
        reject(new Error(`Download failed with HTTP ${response.status()} at ${redactUrl(response.url())}.`));
      }
    };
    const onFailed = (request: PwRequest): void => {
      const reason = request.failure()?.errorText ?? "unknown error";
      // A navigation that turns into a download is reported as aborted; that is not a failure.
      if (mine.has(request) && request.isNavigationRequest() && !/abort/i.test(reason)) reject(new Error(`Download request failed: ${reason}.`));
    };
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfailed", onFailed);
    stopWatching = () => { context.off("request", onRequest); context.off("response", onResponse); context.off("requestfailed", onFailed); };
  });
  failure.catch(() => undefined);
  let onDownload: (download: PwDownload) => void = () => undefined;
  const started = new Promise<PwDownload>((resolve) => { onDownload = resolve; source.once("download", onDownload); });
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  // The start deadline only runs once the trigger (element wait + click) is done.
  const startedInTime = (): Promise<PwDownload> => Promise.race([
    started,
    new Promise<never>((_, reject) => {
      startTimer = setTimeout(() => reject(new Error(`Download did not start within ${Math.round(startMs / 1000)}s: no download event and no error response from the site.`)), startMs);
    }),
  ]);

  let download: PwDownload;
  try {
    download = await Promise.race([(async () => { await trigger(); return startedInTime(); })(), failure]);
  } finally {
    clearTimeout(startTimer);
    source.off("download", onDownload);
    stopWatching();
  }

  // Save to a private temp name, then link into place: never overwrites a file another call just wrote.
  const partial = `${target}.part-${process.pid}-${Date.now()}`;
  try {
    // Not a bare " timed out." message: that wording makes the session layer close the whole session.
    await withTimeout(download.saveAs(partial), timeout, "Download transfer").catch((error: unknown) => {
      if (isLocalOperationTimeout(error)) throw new Error(`Download transfer exceeded ${Math.round(timeout / 1000)}s; partial file discarded.`, { cause: error });
      throw error;
    });
    const reason = await download.failure();
    if (reason) throw new Error(`Download failed: ${reason}.`);
    try {
      fs.linkSync(partial, target);
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`File already exists: ${path.basename(target)}`, { cause: linkError });
      throw linkError;
    }
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

// Opens the URL in a throwaway tab so the browser itself fetches it (its TLS, headers and
// cookies); servers that reject non-browser clients still serve it. No click or pointer input.
async function navigateDownload(page: Page, url: URL, target: string, timeout: number): Promise<void> {
  const tab = await page.context().newPage();
  try {
    await runDownload(tab, async () => {
      // goto rejects with "Download is starting" for attachments; the download event is the result.
      // If it resolves, the URL rendered a page instead of a file.
      const response = await tab.goto(url.toString(), { timeout, waitUntil: "commit" }).catch(() => null);
      if (response) throw new Error(response.ok() ? "URL did not trigger a download (the server returned a page)." : `Download failed with HTTP ${response.status()}.`);
    }, target, timeout);
  } finally {
    await tab.close().catch(() => undefined);
  }
}

export function resolveLocator(page: Page, selector: string, frame?: string): Locator {
  if (frame) return page.frameLocator(frame).locator(selector).first();
  return page.locator(selector).first();
}

export async function pointerClick(locator: Locator, timeout: number): Promise<void> {
  await locator.click({ timeout });
}

export async function domClick(locator: Locator, timeout: number): Promise<void> {
  // Camoufox's virtual display can hang during low-level mouse clicks in CI.
  // Keep this as DOM activation, without Playwright's stability-gated scroll
  // or pointer hit-testing, until mouse actions are stable under Xvfb.
  await withTimeout(
    locator.evaluate((element: HTMLElement) => {
      const clickable = element as HTMLElement & { click?: () => void };
      if (typeof clickable.click === "function") {
        clickable.click();
        return;
      }

      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    }),
    timeout,
    "Click action",
  );
}

export async function activateElement(page: Page, selector: string, timeout: number, frame?: string, clickMode: ClickMode = "dom"): Promise<void> {
  const locator = resolveLocator(page, selector, frame);
  await locator.waitFor({ state: "visible", timeout });
  if (!await locator.isEnabled({ timeout })) {
    throw new Error(`Click selector is disabled: ${selector}`);
  }

  if (clickMode === "pointer") {
    await pointerClick(locator, timeout);
    return;
  }

  if (clickMode === "auto") {
    try {
      await pointerClick(locator, timeout);
      return;
    } catch (error) {
      console.error(chalk.yellow(`[Camoufox] Pointer click failed, falling back to DOM click: ${describeError(error)}`));
    }
  }

  await domClick(locator, timeout);
}

export async function runSequenceAction(
  page: Page,
  action: SequenceAction,
  index: number,
  rawUrls: string[],
  secrets: string[],
  collector?: RichCollector,
): Promise<SequenceActionResult> {
  const started = Date.now();
  const timeout = actionTimeout(action);

  switch (action.type) {
    case "click":
      await activateElement(page, action.selector, timeout, action.frame, action.clickMode);
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "drag":
      // Low-level mouse drags hang under Camoufox's virtual display (same as clicks), so dispatch the HTML5 drag events directly.
      await resolveLocator(page, action.selector, action.frame).waitFor({ state: "visible", timeout });
      await withTimeout(resolveLocator(page, action.selector, action.frame).evaluate(async (source: HTMLElement, targetSelector: string) => {
        const root = source.ownerDocument;
        const target = root.querySelector(targetSelector);
        if (!target) throw new Error(`Drag target not found: ${targetSelector}`);
        const transfer = new DataTransfer();
        const fire = (element: Element, type: string) => element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        fire(source, "dragstart");
        fire(target, "dragenter");
        fire(target, "dragover");
        fire(target, "drop");
        fire(source, "dragend");
      }, action.target), timeout, "Drag action");
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "hover":
      await resolveLocator(page, action.selector, action.frame).hover({ timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "fill":
      await resolveLocator(page, action.selector, action.frame).fill(action.value, { timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "waitForHuman":
    case "promptCode":
      throw new Error(`Action ${action.type} requires a browser session (browse_session_action).`);

    case "goto": {
      const target = await validateTargetUrl(action.url);
      rawUrls.push(action.url);
      await page.goto(target.toString(), { waitUntil: action.waitStrategy ?? "domcontentloaded", timeout: action.timeout ?? DEFAULT_ACTION_TIMEOUT_MS * 6 });
      return { index, type: action.type, status: "ok", durationMs: Date.now() - started };
    }

    case "fillSecret": {
      const value = getSecret(action.secret);
      secrets.push(value);
      await resolveLocator(page, action.selector, action.frame).fill(value, { timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", result: `secret: ${action.secret}`, durationMs: Date.now() - started };
    }

    case "type":
      await resolveLocator(page, action.selector, action.frame).pressSequentially(action.text, {
        delay: action.delay,
        timeout,
      });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "select":
      await resolveLocator(page, action.selector, action.frame).selectOption(action.value, { timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "press":
      if (action.selector) {
        await resolveLocator(page, action.selector, action.frame).press(action.key, { timeout });
      } else {
        await withTimeout(page.keyboard.press(action.key), timeout, "Press action");
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "waitFor":
      if (action.selector) {
        if (action.frame) {
          await resolveLocator(page, action.selector, action.frame).waitFor({ state: action.state, timeout });
        } else {
          await page.waitForSelector(action.selector, { state: action.state, timeout });
        }
      } else {
        await page.waitForLoadState(action.loadState ?? "load", { timeout });
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "scroll":
      if (action.selector) {
        const locator = resolveLocator(page, action.selector, action.frame);
        await locator.waitFor({ state: "attached", timeout });
        await withTimeout(
          locator.evaluate(async (element: HTMLElement, { deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
            const target = element as HTMLElement;
            const beforeLeft = target.scrollLeft;
            const beforeTop = target.scrollTop;
            let scrollEventFired = false;
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(() => resolve(), 100);
              target.addEventListener("scroll", () => {
                scrollEventFired = true;
                window.clearTimeout(timer);
                resolve();
              }, { once: true });
              target.scrollBy(deltaX, deltaY);
              if (target.scrollLeft === beforeLeft && target.scrollTop === beforeTop) {
                window.clearTimeout(timer);
                resolve();
              }
            });
            if (!scrollEventFired && (target.scrollLeft !== beforeLeft || target.scrollTop !== beforeTop)) {
              target.dispatchEvent(new Event("scroll", { bubbles: true }));
            }
          }, { deltaX: action.deltaX, deltaY: action.deltaY }),
          timeout,
          "Scroll action",
        );
      } else {
        await page.mouse.wheel(action.deltaX, action.deltaY);
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "upload": {
      const root = filesRoot();
      const files = action.files.map((file) => insideRoot(root, file));
      const locator = resolveLocator(page, action.selector, action.frame);
      const isFileInput = await locator.evaluate((el) => el instanceof HTMLInputElement && el.type === "file", undefined, { timeout });
      if (isFileInput) {
        await locator.setInputFiles(files, { timeout });
      } else {
        const chooser = page.waitForEvent("filechooser", { timeout });
        chooser.catch(() => undefined);
        await Promise.race([domClick(locator, timeout), chooser]);
        await (await chooser).setFiles(files);
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "download": {
      const dir = path.join(filesRoot(), "descargas");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, action.filename);
      if (fs.existsSync(target)) throw new Error(`File already exists: descargas/${action.filename}`);
      if (action.url) {
        const url = await validateBrowserRequestUrl(action.url);
        rawUrls.push(action.url);
        await navigateDownload(page, url, target, timeout);
        return { index, type: action.type, status: "ok", result: `descargas/${action.filename}`, durationMs: Date.now() - started };
      }
      if (!action.selector) throw new Error("download requires selector or url");
      const locator = resolveLocator(page, action.selector, action.frame);
      const startMs = Math.min(timeout, DOWNLOAD_START_TIMEOUT_MS);
      await runDownload(page, async () => {
        // Playwright's own wait reports "Timeout Nms exceeded", which keeps the session alive (a bare
        // " timed out." from domClick on a missing element would close it).
        await locator.waitFor({ state: "attached", timeout: startMs });
        await domClick(locator, startMs);
      }, target, timeout);
      return { index, type: action.type, selector: action.selector, status: "ok", result: `descargas/${action.filename}`, durationMs: Date.now() - started };
    }

    case "dialog":
      throw new Error("dialog requires a browser session");

    case "expect":
      return runExpect(page, action, collector, index);

    case "clearDiagnostics":
      if (!collector) throw new Error("clearDiagnostics requires a browser session");
      collector.reset();
      return { index, type: action.type, status: "ok", durationMs: Date.now() - started };

    case "evaluate": {
      if (!ALLOW_EVALUATE) {
        throw new Error("Evaluate action is disabled by server policy. Set CAMOUFOX_MCP_ALLOW_EVALUATE=1 to enable it.");
      }

      const result = await withTimeout(
        page.evaluate((expression) => globalThis.eval(expression), action.expression),
        timeout,
        "Evaluate action",
      );
      const serialized = serializeBounded(result, action.maxChars, rawUrls, secrets);
      return {
        index,
        type: action.type,
        status: "ok",
        result: serialized.value,
        resultTruncated: serialized.truncated,
        durationMs: Date.now() - started,
      };
    }
  }
}

export async function runSequenceActionsWithBudget(
  page: Page,
  requestGuard: RequestGuard,
  actionsInput: SequenceAction[],
  rawUrls: string[],
  secrets: string[],
): Promise<SequenceActionResult[]> {
  const actions: SequenceActionResult[] = [];

  try {
    await withTimeout((async () => {
      for (let index = 0; index < actionsInput.length; index += 1) {
        const result = await runSequenceAction(page, actionsInput[index], index, rawUrls, secrets);
        actions.push(result);
        await settleAndAssertSafe(page, requestGuard);
      }
    })(), SEQUENCE_TIMEOUT_MS, "Browse sequence");
  } catch (actionError) {
    // Network rejection can fail an action before its post-action guard check.
    requestGuard.assertAllowed();
    throw actionError;
  }

  return actions;
}
