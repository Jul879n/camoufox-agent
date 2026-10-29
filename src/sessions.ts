import { randomUUID } from "node:crypto";
import path from "node:path";
import { attachCollector } from "./diagnose/collector.js";
import { filesRoot } from "./files.js";
import { ensureDir } from "./home.js";
import type { Browser, Response } from "playwright-core";
import chalk from "chalk";
import { normalizeHostname, validateTargetUrl } from "./policy.js";
import { ALLOWED_PRIVATE_HOSTS, DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_MAX_CHARS, DEFAULT_MAX_ELEMENTS, DEFAULT_WAIT_STRATEGY, MAX_SESSIONS, SESSION_CLOSE_GRACE_MS, SESSION_OP_TIMEOUT_MS, SESSION_TTL_MS } from "./config.js";
import type { CaptchaPolicy, SessionRecord, SlotRelease, WaitStrategy } from "./types.js";
import type { SessionActionToolInput, SessionCloseToolInput, SessionNavigateToolInput, SessionResumeToolInput, SessionSnapshotToolInput, SessionStartToolInput } from "./schemas.js";
import { acquireBrowserSlot, browserContextOptions, buildCamoufoxOptions, closeBrowser, installRequestGuard, launchCamoufoxBrowser, runGuardedPageRead, settleAndAssertSafe, trackBrowser, validateBrowserOptionsInput } from "./browser-runtime.js";
import { createDiagnosticsCollector } from "./diagnostics.js";
import { applyNetworkControl } from "./network-control.js";
import { wireSessionPage } from "./tabs-tool.js";
import { navigateWithDocumentUrlCorrection } from "./navigation.js";
import { buildBrowsePayload, buildSnapshotPayload } from "./extractors.js";
import { maybeDetectCaptcha } from "./captcha.js";
import { buildSuccessContent, buildToolError } from "./responses.js";
import { isHumanAction, runHumanAction } from "./human.js";
import { isLocalOperationTimeout, runSequenceAction } from "./sequence.js";
import { acquireProfileLock, loadProfile, releaseProfileLock, saveProfileSettings, saveProfileState, type ProfileSettings } from "./profiles.js";
import { generateFingerprint } from "camoufox-js/dist/fingerprints.js";
import { withTimeout, redactDeep, applyStealthProfile, defaultHeadlessMode, describeError, getProxySecrets, getProxyServer, redactUrl, sanitizeErrorMessage, selectOperatingSystem } from "./utils.js";

let reservedSessions = 0;
const sessions = new Map<string, SessionRecord>();

export function activeSessionCount(): number { return sessions.size; }

export function listSessions(): Array<{ id: string; profile: string | null; url: string; createdAt: string }> {
  return [...sessions.values()].map((s) => ({ id: s.id, profile: s.profile ?? null, url: redactUrl(s.page.url()), createdAt: new Date(s.createdAt).toISOString() }));
}

export function peekSession(sessionId: string): SessionRecord | undefined { return sessions.get(sessionId); }

export function sessionExpiresAt(session: SessionRecord): string | null {
  return session.expiresAt === null ? null : new Date(session.expiresAt).toISOString();
}

// SESSION_TTL_MS === 0 means the session never expires.
export function scheduleExpiry(session: SessionRecord): void {
  clearTimeout(session.timer);
  if (SESSION_TTL_MS === 0) {
    session.timer = undefined;
    session.expiresAt = null;
    return;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  session.timer = setTimeout(() => {
    void closeSession(session.id, "expired");
  }, SESSION_TTL_MS);
}

export function resetSessionTtl(session: SessionRecord): void {
  scheduleExpiry(session);
}

export function reserveSessionSlot(): boolean {
  if (reservedSessions >= MAX_SESSIONS) {
    return false;
  }

  reservedSessions += 1;
  return true;
}

export function releaseSessionSlot(): void {
  reservedSessions = Math.max(0, reservedSessions - 1);
}

export async function closeSessionNow(session: SessionRecord, reason: string): Promise<boolean> {
  if (session.closed) {
    return false;
  }

  session.closing = true;
  session.closed = true;
  sessions.delete(session.id);
  clearTimeout(session.timer);
  console.error(chalk.blue(`[Camoufox] Closing session ${session.id} (${reason}).`));
  try {
    if (session.profile) {
      try {
        await saveProfileState(session.profile, session.context);
      } catch (saveError) {
        console.error(chalk.red(`[Camoufox] Failed to save profile ${session.profile}: ${describeError(saveError)}`));
      }
    }
    if (session.harPath) await session.context.close().catch(() => undefined);
    await closeBrowser(session.browser);
  } finally {
    if (session.profile) releaseProfileLock(session.profile);
    session.releaseSlot();
    releaseSessionSlot();
  }
  return true;
}

const PROFILE_AUTOSAVE_MS = 30000;

export async function autosaveProfile(session: SessionRecord): Promise<void> {
  if (!session.profile || session.closed || Date.now() - (session.lastProfileSaveAt ?? 0) < PROFILE_AUTOSAVE_MS) return;
  session.lastProfileSaveAt = Date.now();
  try {
    await saveProfileState(session.profile, session.context);
  } catch (saveError) {
    console.error(chalk.red(`[Camoufox] Failed to save profile ${session.profile}: ${describeError(saveError)}`));
  }
}

export async function closeSession(sessionId: string, reason: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.closing = true;
  sessions.delete(sessionId);
  clearTimeout(session.timer);
  await waitForSessionOperationCloseGrace(session);
  return closeSessionNow(session, reason);
}

export async function waitForSessionOperationCloseGrace(session: SessionRecord): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.op.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_CLOSE_GRACE_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function closeActiveSessions(): Promise<void> {
  const ids = Array.from(sessions.keys());
  await Promise.all(ids.map((id) => closeSession(id, "shutdown")));
}

export async function getSession(sessionId: string): Promise<SessionRecord> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown or closed session: ${sessionId}`);
  }

  if (session.expiresAt !== null && Date.now() > session.expiresAt) {
    await closeSession(sessionId, "expired");
    throw new Error(`Session expired: ${sessionId}`);
  }

  resetSessionTtl(session);
  return session;
}

export async function runSessionExclusive<T>(
  session: SessionRecord,
  operation: () => Promise<T>,
  timeoutMs = SESSION_OP_TIMEOUT_MS,
): Promise<T> {
  const run = session.op.catch(() => undefined).then(async () => {
    if (session.closing || session.closed) {
      throw new Error(`Session is closing or closed: ${session.id}`);
    }

    try {
      return await withTimeout(operation(), timeoutMs, "Session operation");
    } catch (error) {
      if (isLocalOperationTimeout(error)) {
        await closeSessionNow(session, "operation-timeout");
      }
      throw error;
    }
  });

  session.op = run.then(() => undefined, () => undefined);
  return run;
}

export async function navigateSession(
  session: SessionRecord,
  url: string,
  waitStrategy?: WaitStrategy,
  timeout?: number,
): Promise<Response | null> {
  const safeUrl = redactUrl(url);
  const targetUrl = await validateTargetUrl(url);
  session.rawUrls.push(url);

  // Reset the request budget for this navigation. Sessions reuse one context,
  // so without a reset the lifetime budget is exhausted after a few heavy pages.
  session.requestGuard.resetBudget();

  try {
    const response = await navigateWithDocumentUrlCorrection(session.page, targetUrl, {
      waitUntil: waitStrategy ?? session.waitStrategy,
      timeout: timeout ?? DEFAULT_ACTION_TIMEOUT_MS * 6,
    }, () => settleAndAssertSafe(session.page, session.requestGuard));
    return response;
  } catch (navigationError) {
    session.requestGuard.assertAllowed();
    const navigationErrorMessage = describeError(navigationError).toLowerCase();
    if (!ALLOWED_PRIVATE_HOSTS.includes(normalizeHostname(targetUrl.hostname))
      && /\b(?:127\.0\.0\.1|localhost|ip6-localhost|ip6-loopback|::1)\b/.test(navigationErrorMessage)) {
      throw new Error(`Blocked unsafe browser request to ${safeUrl}.`, { cause: navigationError });
    }

    throw navigationError;
  }
}

export async function handleSessionStart(input: SessionStartToolInput) {
  const captchaPolicy = input.captchaPolicy ?? "pause";
  const effectiveInput = applyStealthProfile({
    ...input,
    captchaPolicy,
  });

  if (!reserveSessionSlot()) {
    return buildToolError(`Too many active sessions. Maximum is ${MAX_SESSIONS}.`);
  }

  let release: SlotRelease | undefined;
  let browser: Browser | undefined;
  let lockedProfile: string | undefined;
  try {
    if (input.profile) {
      acquireProfileLock(input.profile);
      lockedProfile = input.profile;
    }
    const stored = input.profile ? loadProfile(input.profile) : undefined;
    const profileSettings = stored?.settings ?? undefined;
    // A stored profile keeps a stable identity: its settings win over the input.
    const launchInput = profileSettings ? {
      ...effectiveInput,
      os: profileSettings.os,
      locale: profileSettings.locale ?? effectiveInput.locale,
      proxy: profileSettings.proxy ?? effectiveInput.proxy,
      window: (profileSettings.window ?? effectiveInput.window) as typeof effectiveInput.window,
      viewport: profileSettings.viewport ?? effectiveInput.viewport,
    } : effectiveInput;
    await validateBrowserOptionsInput(launchInput);
    release = await acquireBrowserSlot();
    const selectedOS = selectOperatingSystem(launchInput.os);
    const waitStrategy = launchInput.waitStrategy ?? DEFAULT_WAIT_STRATEGY;
    const headlessMode = defaultHeadlessMode(launchInput.headless);

    let fingerprint = profileSettings?.fingerprint;
    if (input.profile && !profileSettings) {
      fingerprint = generateFingerprint(undefined, { operatingSystems: [selectedOS] }) as unknown as Record<string, unknown>;
      const created: ProfileSettings = {
        os: selectedOS,
        locale: launchInput.locale,
        proxy: launchInput.proxy,
        window: launchInput.window,
        viewport: launchInput.viewport,
        fingerprint,
        createdAt: new Date().toISOString(),
      };
      saveProfileSettings(input.profile, created);
    }

    browser = await launchCamoufoxBrowser({ ...buildCamoufoxOptions(launchInput, selectedOS, headlessMode), ...(fingerprint ? { fingerprint, i_know_what_im_doing: true } : {}) });
    trackBrowser(browser);
    const harPath = input.recordHar ? path.join(ensureDir(path.join(filesRoot(), "exports")), input.recordHar) : undefined;
    const context = await browser.newContext(browserContextOptions(launchInput, stored?.statePath, harPath));
    const requestGuard = await installRequestGuard(context);
    const network = await applyNetworkControl(context, launchInput.network);
    const page = await context.newPage();

    const id = `sess_${randomUUID()}`;
    const rawUrls = [getProxyServer(effectiveInput.proxy)].filter((rawUrl): rawUrl is string => Boolean(rawUrl));
    const secrets = [...getProxySecrets(effectiveInput.proxy), ...(effectiveInput.emulation?.httpCredentials ? [effectiveInput.emulation.httpCredentials.password] : [])];
    const now = Date.now();
    const session: SessionRecord = {
      id,
      browser,
      context,
      page,
      requestGuard,
      network,
      diagnostics: createDiagnosticsCollector(page, effectiveInput, rawUrls, secrets),
      selectedOS,
      waitStrategy,
      captchaPolicy,
      releaseSlot: release,
      rawUrls,
      secrets,
      createdAt: now,
      profile: input.profile,
      harPath,
      lastProfileSaveAt: Date.now(),
      expiresAt: null,
      lastNavigationResponse: null,
      op: Promise.resolve(),
      closing: false,
      closed: false,
    };

    wireSessionPage(session, page);
    context.on("page", (popup) => wireSessionPage(session, popup));

    session.rich = await attachCollector(context, () => ({ rawUrls: session.rawUrls, secrets: session.secrets }));
    scheduleExpiry(session);
    sessions.set(id, session);
    browser = undefined;
    release = undefined;
    lockedProfile = undefined;

    return buildSuccessContent({
      sessionId: id,
      expiresAt: sessionExpiresAt(session),
      browser: "camoufox",
      selectedOS,
      headlessMode,
      stealthProfile: effectiveInput.stealthProfile,
      captchaPolicy,
    });
  } catch (error) {
    if (browser) {
      await closeBrowser(browser);
    }
    if (release) {
      release();
    }
    if (lockedProfile) releaseProfileLock(lockedProfile);
    releaseSessionSlot();
    const errorMessage = sanitizeErrorMessage(
      describeError(error),
      [getProxyServer(effectiveInput.proxy)].filter((rawUrl): rawUrl is string => Boolean(rawUrl)),
      getProxySecrets(effectiveInput.proxy),
    );
    return buildToolError(`Failed to start browser session. Error: ${errorMessage}`);
  }
}

export function sessionSanitizedError(error: unknown, session?: SessionRecord, extraRawUrls: string[] = []): string {
  const rawUrls = session ? [...session.rawUrls, ...extraRawUrls] : extraRawUrls;
  const secrets = session?.secrets ?? [];
  return sanitizeErrorMessage(describeError(error), rawUrls, secrets);
}

// Resolve the CAPTCHA policy for a session operation: a per-call override wins,
// otherwise fall back to the policy persisted at session start. Without this,
// starting a session with the documented "pause" default performed no detection
// on subsequent calls unless the caller re-passed captchaPolicy each time.
export function effectiveCaptchaPolicy(
  session: SessionRecord,
  input: { captchaPolicy?: CaptchaPolicy },
): CaptchaPolicy {
  return input.captchaPolicy ?? session.captchaPolicy;
}

export async function buildSessionSnapshotResult(
  session: SessionRecord,
  input: SessionSnapshotToolInput,
) {
  const snapshot = await runGuardedPageRead(
    session.page,
    session.requestGuard,
    () => buildSnapshotPayload(
      session.page,
      session.lastNavigationResponse,
      input.maxChars ?? DEFAULT_MAX_CHARS,
      input.maxElements ?? DEFAULT_MAX_ELEMENTS,
      input.selector,
      () => session.lastNavigationResponse,
    ),
  );
  // Surface the diagnostics collector that was created at session start but
  // previously never read. Snapshot/resume are the read-state operations, so
  // bounded console/network diagnostics belong here.
  const diagnostics = session.diagnostics.payload();
  const basePayload = { sessionId: session.id, expiresAt: sessionExpiresAt(session), ...snapshot, ...(diagnostics ? { diagnostics } : {}) };
  const captchaPolicy = effectiveCaptchaPolicy(session, input);
  const { mergedPayload, captchaScreenshot } = await maybeDetectCaptcha(
    session.page,
    session.lastNavigationResponse,
    basePayload,
    captchaPolicy,
    redactUrl(session.page.url()),
  );
  return buildSuccessContent(redactDeep(mergedPayload, session.secrets), captchaScreenshot);
}

export async function handleSessionNavigate(input: SessionNavigateToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => {
      const response = await navigateSession(currentSession, input.url, input.waitStrategy, input.timeout);
      const mode = input.outputMode ?? "text";
      const charLimit = input.maxChars ?? DEFAULT_MAX_CHARS;
      const payload = await runGuardedPageRead(
        currentSession.page,
        currentSession.requestGuard,
        () => buildBrowsePayload(currentSession.page, response, mode, charLimit, input.selector),
      );
      const basePayload = { sessionId: currentSession.id, expiresAt: sessionExpiresAt(currentSession), ...payload };
      const captchaPolicy = effectiveCaptchaPolicy(currentSession, input);
      const { mergedPayload, captchaScreenshot } = await maybeDetectCaptcha(currentSession.page, response, basePayload, captchaPolicy, redactUrl(input.url));
      await autosaveProfile(currentSession);
      return buildSuccessContent(redactDeep(mergedPayload, currentSession.secrets), captchaScreenshot);
    });
  } catch (error) {
    return buildToolError(`Failed to navigate session. Error: ${sessionSanitizedError(error, session, [input.url])}`);
  }
}

export async function handleSessionAction(input: SessionActionToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => {
      let actionResult;
      if (input.action.type === "goto") {
        const gotoStarted = Date.now();
        await navigateSession(currentSession, input.action.url, input.action.waitStrategy, input.action.timeout);
        actionResult = { index: 0, type: "goto", status: "ok" as const, durationMs: Date.now() - gotoStarted };
      } else if (input.action.type === "dialog") {
        const dialogStarted = Date.now();
        currentSession.dialogPolicy = { accept: input.action.accept, promptText: input.action.promptText };
        actionResult = { index: 0, type: "dialog", status: "ok" as const, durationMs: Date.now() - dialogStarted };
      } else if (isHumanAction(input.action)) {
        actionResult = await runHumanAction(currentSession, input.action);
      } else {
        actionResult = await runSequenceAction(currentSession.page, input.action, 0, currentSession.rawUrls, currentSession.secrets, currentSession.rich);
      }
      await settleAndAssertSafe(currentSession.page, currentSession.requestGuard);
      const snapshot = await runGuardedPageRead(
        currentSession.page,
        currentSession.requestGuard,
        () => buildSnapshotPayload(
          currentSession.page,
          currentSession.lastNavigationResponse,
          input.maxChars ?? DEFAULT_MAX_CHARS,
          input.maxElements ?? DEFAULT_MAX_ELEMENTS,
          input.selector,
          () => currentSession.lastNavigationResponse,
        ),
      );
      const paused = actionResult.status === "paused" ? { requiresUserAction: true, message: actionResult.reason } : {};
      const basePayload = { sessionId: currentSession.id, expiresAt: sessionExpiresAt(currentSession), action: actionResult, snapshot, ...paused };
      const captchaPolicy = effectiveCaptchaPolicy(currentSession, input);
      const { mergedPayload, captchaScreenshot } = await maybeDetectCaptcha(currentSession.page, currentSession.lastNavigationResponse, basePayload, captchaPolicy, redactUrl(currentSession.page.url()));
      await autosaveProfile(currentSession);
      return buildSuccessContent(redactDeep(mergedPayload, currentSession.secrets), captchaScreenshot);
    }, isHumanAction(input.action) ? (input.action.timeout ?? 600000) + 30000 : SESSION_OP_TIMEOUT_MS);
  } catch (error) {
    // Failed actions skip the success-path guard check. Read its recorded
    // denial after runSessionExclusive has completed any timeout cleanup.
    let actionError = error;
    try {
      session?.requestGuard.assertAllowed();
    } catch (blockedRequestError) {
      actionError = blockedRequestError;
    }
    return buildToolError(`Failed to run session action. Error: ${sessionSanitizedError(actionError, session)}`);
  }
}

export async function handleSessionSnapshot(input: SessionSnapshotToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => buildSessionSnapshotResult(currentSession, input));
  } catch (error) {
    return buildToolError(`Failed to snapshot session. Error: ${sessionSanitizedError(error, session)}`);
  }
}

export async function handleSessionResume(input: SessionResumeToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => {
      if (input.waitStrategy) {
        await currentSession.page.waitForLoadState(input.waitStrategy, { timeout: input.timeout ?? DEFAULT_ACTION_TIMEOUT_MS });
        await settleAndAssertSafe(currentSession.page, currentSession.requestGuard);
      }
      return buildSessionSnapshotResult(currentSession, input);
    });
  } catch (error) {
    return buildToolError(`Failed to resume session. Error: ${sessionSanitizedError(error, session)}`);
  }
}

export async function handleSessionClose(input: SessionCloseToolInput) {
  const closed = await closeSession(input.sessionId, "requested");
  return buildSuccessContent({
    sessionId: input.sessionId,
    closed,
  });
}
