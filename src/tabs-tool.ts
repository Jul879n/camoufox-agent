import type { Page } from "playwright-core";
import { validateBrowserRequestUrl } from "./policy.js";
import { buildSuccessContent, buildToolError } from "./responses.js";
import { getSession, runSessionExclusive, sessionSanitizedError } from "./sessions.js";
import type { SessionTabsToolInput } from "./schema/tools.js";
import { trackNavigationResponses } from "./navigation-response.js";
import type { SessionRecord } from "./types.js";
import { redactUrl } from "./utils.js";

// Hooks every page of a session (the first one and any popup/new tab): request
// guard, dialog policy and navigation tracking. The active tab is session.page.
export function wireSessionPage(session: SessionRecord, page: Page): void {
  session.requestGuard.watchPage(page);
  trackNavigationResponses(page, (response) => {
    if (session.page === page) session.lastNavigationResponse = response;
  });
  page.on("dialog", (dialog) => {
    const policy = session.dialogPolicy ?? { accept: false };
    session.rich?.recordDialog({ type: dialog.type(), message: dialog.message(), accepted: policy.accept, at: Date.now() });
    const handled = policy.accept ? dialog.accept(dialog.type() === "prompt" ? policy.promptText : undefined) : dialog.dismiss();
    void handled.catch(() => undefined);
  });
  page.on("close", () => {
    if (session.closed || session.page !== page) return;
    const remaining = session.context.pages();
    if (remaining.length) session.page = remaining[remaining.length - 1];
  });
}

async function describeTabs(session: SessionRecord) {
  const pages = session.context.pages();
  return Promise.all(pages.map(async (page, index) => ({
    index,
    url: redactUrl(page.url()),
    title: await page.title().catch(() => ""),
    active: page === session.page,
  })));
}

export async function handleSessionTabs(input: SessionTabsToolInput) {
  let session: SessionRecord | undefined;
  try {
    session = await getSession(input.sessionId);
    const current = session;
    return await runSessionExclusive(current, async () => {
      const pages = () => current.context.pages();
      const pick = (): Page => {
        if (input.index === undefined || !pages()[input.index]) throw new Error(`Tab ${input.index} does not exist`);
        return pages()[input.index];
      };
      if (input.action === "new") {
        const target = input.url ? await validateBrowserRequestUrl(input.url) : undefined;
        const page = await current.context.newPage();
        current.page = page;
        if (target) await page.goto(target.toString(), { waitUntil: current.waitStrategy });
      } else if (input.action === "select") {
        current.page = pick();
        await current.page.bringToFront();
      } else if (input.action === "close") {
        const page = pick();
        if (pages().length === 1) throw new Error("Cannot close the last tab; use browse_session_close");
        await page.close();
      }
      return buildSuccessContent({ sessionId: current.id, tabs: await describeTabs(current) });
    });
  } catch (error) {
    return buildToolError(`Failed to run tab action. Error: ${sessionSanitizedError(error, session)}`);
  }
}
