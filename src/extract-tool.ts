import { DEFAULT_WAIT_STRATEGY } from "./config.js";
import { runBrowserOperation } from "./browser-runtime.js";
import { runStructuredExtract, type ExtractSpec } from "./extractors/structured.js";
import type { ExtractToolInput } from "./schema/tools.js";
import { buildSuccessContent, buildToolError, buildToolFailure } from "./responses.js";
import { getSession, runSessionExclusive, sessionSanitizedError } from "./sessions.js";
import type { SessionRecord } from "./types.js";
import { redactUrl } from "./utils.js";

export function extractSpecFrom(input: ExtractToolInput | ExtractSpec): ExtractSpec {
  return {
    itemSelector: input.itemSelector,
    fields: input.fields,
    nextSelector: input.nextSelector,
    maxPages: input.maxPages ?? 1,
    maxItems: input.maxItems ?? 500,
    saveAs: input.saveAs,
    maxChars: input.maxChars ?? 30000,
  };
}

export async function handleExtract(input: ExtractToolInput) {
  if (Boolean(input.url) === Boolean(input.sessionId)) {
    return buildToolError("Provide exactly one of url or sessionId");
  }
  const spec = extractSpecFrom(input);

  if (input.sessionId) {
    let session: SessionRecord | undefined;
    try {
      session = await getSession(input.sessionId);
      const current = session;
      return await runSessionExclusive(current, async () => {
        const result = await runStructuredExtract(current.page, spec, current.waitStrategy, current.requestGuard);
        return buildSuccessContent({ sessionId: current.id, ...result });
      });
    } catch (error) {
      return buildToolError(`Failed to extract from session. Error: ${sessionSanitizedError(error, session)}`);
    }
  }

  const url = input.url as string;
  const safeUrl = redactUrl(url);
  try {
    return await runBrowserOperation("browse extract", { ...input, url }, async ({ page, requestGuard }) => {
      const result = await runStructuredExtract(page, spec, input.waitStrategy ?? DEFAULT_WAIT_STRATEGY, requestGuard);
      requestGuard.assertAllowed();
      return buildSuccessContent(result);
    });
  } catch (error) {
    return buildToolFailure("browse extract", safeUrl, error, { ...input, url });
  }
}
