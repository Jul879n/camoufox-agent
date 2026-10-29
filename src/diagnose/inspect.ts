import type { Page } from "playwright-core";
import { resolveLocator } from "../sequence.js";

export const DEFAULT_STYLE_PROPERTIES = [
  "display", "position", "top", "left", "width", "height", "min-width", "max-width", "margin", "padding", "border", "box-sizing",
  "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "text-align", "z-index", "overflow",
  "opacity", "visibility", "flex-direction", "justify-content", "align-items", "gap", "grid-template-columns", "transform", "cursor",
];

const INSPECT_BODY = `{
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const describe = (n) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.classList.length ? "." + Array.from(n.classList).slice(0, 3).join(".") : "");
  const chain = []; for (let n = el.parentElement; n && chain.length < 6; n = n.parentElement) chain.push(describe(n));
  const rules = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list; try { list = sheet.cssRules; } catch (e) { continue; }
    for (const rule of Array.from(list)) {
      if (rule.selectorText && rules.length < args.maxRules) {
        let hit = false; try { hit = el.matches(rule.selectorText); } catch (e) {}
        if (hit) rules.push({ selector: rule.selectorText, css: rule.style.cssText.slice(0, 400), source: sheet.href || "inline" });
      }
    }
  }
  const pick = (names) => Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n)]));
  const px = (n) => parseFloat(cs.getPropertyValue(n)) || 0;
  return {
    element: describe(el), parents: chain,
    attributes: Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value.slice(0, 300)])),
    text: (el.innerText || el.textContent || "").trim().slice(0, 200),
    children: el.children.length,
    box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
      margin: [px("margin-top"), px("margin-right"), px("margin-bottom"), px("margin-left")],
      padding: [px("padding-top"), px("padding-right"), px("padding-bottom"), px("padding-left")],
      border: [px("border-top-width"), px("border-right-width"), px("border-bottom-width"), px("border-left-width")] },
    visibility: { displayed: cs.display !== "none", visible: cs.visibility !== "hidden" && Number(cs.opacity) > 0, inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth, zeroSize: rect.width === 0 || rect.height === 0 },
    overflow: { horizontal: el.scrollWidth > el.clientWidth, vertical: el.scrollHeight > el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
    styles: pick(args.properties),
    matchedRules: rules,
    focusable: el.tabIndex >= 0,
  };
}`;

// Built with new Function so Playwright serializes it as a real function (a plain string would be evaluated as an expression).
const inspectFn = new Function("el", "args", `return (() => ${INSPECT_BODY})()`) as (el: Element, args: unknown) => unknown;

export async function inspectElement(page: Page, selector: string, options: { frame?: string; properties?: string[]; maxRules: number; timeout: number }) {
  const locator = resolveLocator(page, selector, options.frame);
  await locator.waitFor({ state: "attached", timeout: options.timeout });
  const data = await locator.evaluate(inspectFn, {
    properties: options.properties?.length ? options.properties : DEFAULT_STYLE_PROPERTIES,
    maxRules: options.maxRules,
  }, { timeout: options.timeout });
  const aria = await locator.ariaSnapshot({ timeout: options.timeout }).catch(() => undefined);
  return { selector, ...(data as object), accessibility: aria };
}
