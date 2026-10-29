import type { Locator, Page } from "playwright-core";
import chalk from "chalk";
import { ALLOW_EVALUATE, DEFAULT_ACTION_TIMEOUT_MS, SEQUENCE_TIMEOUT_MS } from "./config.js";
import type { SequenceAction } from "./schemas.js";
import type { ClickMode, RequestGuard, SequenceActionResult } from "./types.js";
import { describeError, serializeBounded, withTimeout } from "./utils.js";
import { settleAndAssertSafe } from "./browser-runtime.js";
import fs from "node:fs";
import path from "node:path";
import { validateTargetUrl } from "./policy.js";
import { getSecret } from "./secrets.js";
import { filesRoot, insideRoot } from "./files.js";
import type { RichCollector } from "./diagnose/collector.js";
import { runExpect } from "./expect.js";

export function actionTimeout(action: { timeout?: number }): number {
  return action.timeout ?? DEFAULT_ACTION_TIMEOUT_MS;
}

export function sequenceTimeoutBudget(actions: SequenceAction[]): number {
  return actions.reduce((total, action) => total + actionTimeout(action), 0);
}

export function isLocalOperationTimeout(error: unknown): boolean {
  return describeError(error).endsWith(" timed out.");
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
        await locator.click({ timeout });
        await (await chooser).setFiles(files);
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "download": {
      const dir = path.join(filesRoot(), "descargas");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, action.filename);
      if (fs.existsSync(target)) throw new Error(`File already exists: descargas/${action.filename}`);
      const download = page.waitForEvent("download", { timeout });
      await resolveLocator(page, action.selector, action.frame).click({ timeout });
      await (await download).saveAs(target);
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
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
