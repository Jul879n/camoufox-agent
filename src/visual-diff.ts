import fs from "node:fs";
import path from "node:path";
import { uniqueExportPath } from "./files.js";
import { agentHome, ensureDir } from "./home.js";
import { buildSuccessContent, buildToolError } from "./responses.js";
import { getSession, runSessionExclusive, sessionSanitizedError } from "./sessions.js";
import type { VisualDiffToolInput } from "./schema/tools.js";
import type { SessionRecord } from "./types.js";

interface Comparison { sizeMismatch?: { baseline: { w: number; h: number }; current: { w: number; h: number } }; diffPixels: number; totalPixels: number; diffPng: string }

// Runs in the page. Images are decoded from raw bytes with createImageBitmap, so the page CSP
// (img-src) cannot block them, and compared pixel by pixel on canvases.
const COMPARE = `async ({ baseline, current, threshold }) => {
  const decode = async (b64) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
    return { w: bitmap.width, h: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height) };
  };
  const a = await decode(baseline), b = await decode(current);
  if (a.w !== b.w || a.h !== b.h) return { sizeMismatch: { baseline: { w: a.w, h: a.h }, current: { w: b.w, h: b.h } }, diffPixels: 0, totalPixels: 0, diffPng: "" };
  const out = new ImageData(a.w, a.h);
  let diffPixels = 0;
  for (let i = 0; i < a.data.data.length; i += 4) {
    const dr = a.data.data[i] - b.data.data[i], dg = a.data.data[i + 1] - b.data.data[i + 1], db = a.data.data[i + 2] - b.data.data[i + 2];
    const distance = Math.sqrt((dr * dr + dg * dg + db * db) / 3) / 255;
    if (distance > threshold) { diffPixels++; out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255; }
    else { const gray = (b.data.data[i] + b.data.data[i + 1] + b.data.data[i + 2]) / 3; out.data[i] = out.data[i + 1] = out.data[i + 2] = 255 - (255 - gray) * 0.3; out.data[i + 3] = 255; }
  }
  const canvas = document.createElement("canvas"); canvas.width = a.w; canvas.height = a.h;
  canvas.getContext("2d").putImageData(out, 0, 0);
  return { diffPixels, totalPixels: a.w * a.h, diffPng: canvas.toDataURL("image/png").split(",")[1] };
}`;

export async function handleVisualDiff(input: VisualDiffToolInput) {
  let session: SessionRecord | undefined;
  try {
    session = await getSession(input.sessionId);
    const current = session;
    return await runSessionExclusive(current, async () => {
      const { page } = current;
      const png = input.selector
        ? await page.locator(input.selector).first().screenshot({ timeout: 10000 })
        : await page.screenshot({ fullPage: input.fullPage ?? true });
      const baselineFile = path.join(ensureDir(agentHome("baselines")), `${input.name}.png`);
      if (input.update || !fs.existsSync(baselineFile)) {
        fs.writeFileSync(baselineFile, png);
        return buildSuccessContent({ sessionId: current.id, status: "baseline-created", baselinePath: baselineFile });
      }
      const args = { baseline: fs.readFileSync(baselineFile).toString("base64"), current: png.toString("base64"), threshold: input.threshold ?? 0.1 };
      const result = await page.evaluate(`(${COMPARE})(${JSON.stringify(args)})`) as Comparison;
      if (result.sizeMismatch) {
        return buildSuccessContent({ sessionId: current.id, status: "size-mismatch", ...result.sizeMismatch, baselinePath: baselineFile });
      }
      const diffPct = Math.round((10000 * result.diffPixels) / result.totalPixels) / 100;
      const diffPath = uniqueExportPath(`${input.name}-diff.png`);
      fs.writeFileSync(diffPath, Buffer.from(result.diffPng, "base64"));
      return buildSuccessContent({
        sessionId: current.id,
        status: diffPct > (input.maxDiffPct ?? 0.5) ? "failed" : "passed",
        diffPct,
        diffPixels: result.diffPixels,
        totalPixels: result.totalPixels,
        diffPath,
        baselinePath: baselineFile,
      });
    });
  } catch (error) {
    return buildToolError(`Failed to compare screenshot. Error: ${sessionSanitizedError(error, session)}`);
  }
}
