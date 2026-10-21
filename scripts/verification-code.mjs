/**
 * Verification-code step for agent mode (CLI + MCP server).
 *
 * Some providers (Holded, ...) email a one-time code after the password. The password never
 * leaves the password manager; the one-time code only reaches this process when an AI reads it
 * from the user's email, or when the user hands it over (typed in the browser window, told to
 * the AI, or passed to `invoice-extractor submit-code`).
 *
 * The code is never logged, persisted or echoed: callers must only pass it to
 * `typeVerificationCode`, and every error message that could carry it goes through `redactCode`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLoginLocation, playwrightFrameLocation } from '../login-domains.mjs';

export const CODE_STEP_TTL_MS = 10 * 60 * 1000;
const HINT_MAX_LENGTH = 160;
const CODE_PATTERN = /^[A-Za-z0-9]{4,10}$/;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class VerificationCodeError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'VerificationCodeError';
    this.retryable = retryable;
  }
}

/** Trims spaces/dashes; accepts 4–10 letters or digits. Never includes the input in errors. */
export function normalizeVerificationCode(raw) {
  const code = String(raw ?? '').replace(/[\s\-‐-―]/g, '');
  if (!CODE_PATTERN.test(code)) {
    throw new VerificationCodeError('Invalid code format: expected 4 to 10 letters or digits.', { retryable: true });
  }
  return code;
}

export function redactCode(text, ...codes) {
  let out = String(text ?? '');
  for (const code of codes) {
    const value = String(code ?? '').trim();
    if (value.length >= 3) out = out.split(value).join('***');
  }
  return out;
}

export function truncateHint(text, max = HINT_MAX_LENGTH) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function isVerificationId(id) {
  return ID_PATTERN.test(String(id || ''));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Path containment on whole segments: "/billing" matches "/acct_1/billing/invoices" but not
// "/billing-old". A root billingUrl ("/", e.g. Naturgy) only matches the root itself, otherwise
// every page of the host (the sign-in page included) would count as the billing page.
function pathContains(pagePath, billingPath) {
  const segments = path => String(path || '').split('/').filter(Boolean);
  const want = segments(billingPath);
  const have = segments(pagePath);
  if (want.length === 0) return have.length === 0;
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((seg, j) => have[i + j] === seg)) return true;
  }
  return false;
}

export function sameBillingLocation(pageUrl, billingUrl) {
  try {
    const a = new URL(pageUrl);
    const b = new URL(billingUrl);
    if (a.hostname !== b.hostname || !pathContains(a.pathname, b.pathname)) return false;
    return b.hash ? a.hash === b.hash : true;
  } catch {
    return false;
  }
}

/**
 * Is the page waiting for a code the user receives? `inject(frame)` loads utils.js + engine.js.
 * ctx: { billingUrl, loginStartUrl, hasOtpCredential }
 */
export async function detectCodeStep(page, provider, ctx, { inject }) {
  const url = page.url();
  if (!url || sameBillingLocation(url, ctx.billingUrl)) return { awaiting: false };
  try {
    const frame = page.mainFrame();
    await inject(frame);
    const step = await frame.evaluate(
      ([authCfg, context]) => window.__invoiceEngine.detectVerificationStep(authCfg, context),
      [
        provider.auth || {},
        {
          url,
          loginStartUrl: ctx.loginStartUrl || '',
          hasOtpCredential: Boolean(ctx.hasOtpCredential),
          detectSplitInputs: true,
        },
      ]
    );
    return { ...step, awaiting: Boolean(step?.awaiting), hint: truncateHint(step?.hint) };
  } catch {
    // Page navigating or closed: we cannot tell. Never read this as "the step is done".
    return { awaiting: false, unknown: true };
  }
}

/** Polls until the page is no longer on the code step (code accepted, or typed by the user). */
export async function waitForCodeStepExit(page, provider, ctx, { inject, timeoutMs = 20000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (page.isClosed?.()) return false;
    const step = await detectCodeStep(page, provider, ctx, { inject });
    if (!step.awaiting && !step.unknown) return true;
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return false;
}

/**
 * Types the code into the detected field(s) and submits. Refuses when the open page is not on
 * the provider's allowed sign-in hosts (`allowedLoginDomains` from login-domains.mjs: the vault
 * item's hosts, the billingUrl host and `auth.loginDomains`, each with subdomains), so the code
 * is never handed to another site. The fields are tagged in the checked document; if the frame
 * navigated afterwards the tags are gone and nothing is typed.
 */
export async function typeVerificationCode(page, provider, rawCode, { allowedLoginDomains, inject }) {
  const code = normalizeVerificationCode(rawCode);
  const frame = page.mainFrame();
  const check = checkLoginLocation(playwrightFrameLocation(frame), allowedLoginDomains);
  if (!check.ok) {
    throw new VerificationCodeError(
      `Refusing to type the code: the open page (${check.host || hostOf(page.url()) || 'unknown host'}) is not a ${provider.name} sign-in page (${check.reason}).`
    );
  }
  try {
    await inject(frame);
    const slots = await frame.evaluate(authCfg => window.__invoiceEngine.markCodeInputs(authCfg), provider.auth || {});
    if (!slots?.count) {
      throw new VerificationCodeError(`${provider.name} is no longer showing a code field.`);
    }
    if (slots.split && slots.count !== code.length) {
      throw new VerificationCodeError(
        `${provider.name} expects a ${slots.count}-character code; the one given has ${code.length}.`,
        { retryable: true }
      );
    }
    if (!slots.split && slots.maxLength && slots.maxLength < code.length) {
      throw new VerificationCodeError(
        `${provider.name} expects at most ${slots.maxLength} characters; the code given has ${code.length}.`,
        { retryable: true }
      );
    }
    const slot = i => `[data-invoice-code-slot="${i}"]`;
    if (slots.split) {
      for (let i = 0; i < code.length; i++) await frame.fill(slot(i), code[i], { timeout: 5000 });
    } else {
      await frame.fill(slot(0), code, { timeout: 5000 });
    }
    const submit = await frame
      .evaluate(authCfg => window.__invoiceEngine.submitVerificationCode(authCfg), provider.auth || {})
      .catch(() => ({ submitted: true }));
    if (!submit?.submitted) {
      await frame.press(slot(slots.count - 1), 'Enter', { timeout: 2000 }).catch(() => {});
    }
  } catch (err) {
    if (err instanceof VerificationCodeError) throw err;
    throw new VerificationCodeError(redactCode(`Could not type the code: ${err.message}`, code, rawCode), {
      retryable: true,
    });
  }
}

/**
 * Keeps provider pages waiting for a code alive (MCP server) and owns the shared browser
 * context: it closes once no run and no pending code step uses it.
 *
 * `resume(pending, { code })` signs in and extracts; it returns `null` when the page is still on
 * the code step (only possible without a code) and throws VerificationCodeError on a wrong code.
 */
export function createVerificationRegistry({
  resume,
  ttlMs = CODE_STEP_TTL_MS,
  watchIntervalMs = 3000,
  now = Date.now,
} = {}) {
  const entries = new Map();
  const finished = new Map();
  let shared = null;
  let launching = null;

  async function releaseContext() {
    if (!shared) return;
    shared.holds -= 1;
    if (shared.holds <= 0) {
      const { context } = shared;
      shared = null;
      await context.close().catch(() => {});
    }
  }

  const contextProvider = {
    async acquire(launch, { headed = false } = {}) {
      // Concurrent runs share one in-flight launch: a persistent profile cannot be opened twice.
      while (!shared && launching) await launching.catch(() => {});
      if (shared) {
        shared.holds += 1;
        return shared.context;
      }
      launching = (async () => {
        const context = await launch();
        shared = { context, holds: 0, headed: Boolean(headed) };
      })();
      try {
        await launching;
      } finally {
        launching = null;
      }
      shared.holds += 1;
      return shared.context;
    },
    release: releaseContext,
    /** Whether the shared browser window is visible (a reused browser keeps its first mode). */
    get headed() {
      return shared ? shared.headed : undefined;
    },
  };

  function publicView(entry) {
    return {
      verificationId: entry.id,
      providerId: entry.pending.providerId,
      providerName: entry.pending.providerName,
      pageHost: entry.pending.pageHost,
      hint: entry.pending.hint,
      browserVisible: Boolean(entry.pending.headed),
      requestedAt: entry.pending.requestedAt,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  async function close(id, outcome) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    clearTimeout(entry.expiryTimer);
    clearInterval(entry.watchTimer);
    finished.set(id, { ...outcome, expiresAt: entry.expiresAt });
    await entry.pending.page?.close().catch(() => {});
    await releaseContext();
  }

  // Serializes work on one entry (background watcher vs. submit_code).
  function exclusive(entry, task) {
    const run = entry.queue.then(task, task);
    entry.queue = run.catch(() => {});
    return run;
  }

  async function settle(entry, code, waitMs = 0) {
    if (!entries.has(entry.id)) return finished.get(entry.id) || null;
    const result = await resume(entry.pending, code == null ? { waitMs } : { code });
    if (!result) return null;
    const outcome = { status: 'completed', completedBy: code == null ? 'user' : 'code', result };
    await close(entry.id, outcome);
    return outcome;
  }

  return {
    contextProvider,

    add(pending) {
      for (const [doneId, done] of finished) {
        if (now() > done.expiresAt + ttlMs) finished.delete(doneId);
      }
      const id = randomUUID();
      const expiresAt = now() + ttlMs;
      const entry = { id, pending, expiresAt, queue: Promise.resolve() };
      entries.set(id, entry);
      // The provider page holds the shared context open until it expires or completes.
      if (shared) shared.holds += 1;
      entry.expiryTimer = setTimeout(() => {
        exclusive(entry, () => close(id, { status: 'expired' }));
      }, ttlMs);
      entry.expiryTimer.unref?.();
      if (watchIntervalMs > 0) {
        // The user may type the code in the headed window themselves: continue automatically.
        entry.watchTimer = setInterval(() => {
          exclusive(entry, () => settle(entry, null)).catch(() => {});
        }, watchIntervalMs);
        entry.watchTimer.unref?.();
      }
      return publicView(entry);
    },

    list() {
      return [...entries.values()].map(publicView);
    },

    /** Without a code: waits up to `waitMs` for the user to finish the step in the browser window. */
    async submit(id, code, { waitMs = 0 } = {}) {
      const entry = entries.get(id);
      if (!entry) {
        const done = finished.get(id);
        if (done?.status === 'completed') return done;
        if (done?.status === 'expired' || (done && now() > done.expiresAt)) {
          throw new VerificationCodeError(
            'This verification expired and the browser page was closed. Run invoice_extractor_run again for that provider.'
          );
        }
        throw new VerificationCodeError('Unknown verificationId. Run invoice_extractor_run again for that provider.');
      }
      if (code != null) normalizeVerificationCode(code);
      return exclusive(entry, async () => {
        const outcome = await settle(entry, code, waitMs);
        if (outcome) return outcome;
        return { status: 'waiting', ...publicView(entry) };
      });
    },

    async closeAll() {
      for (const id of [...entries.keys()]) await close(id, { status: 'expired' });
      if (shared) {
        const { context } = shared;
        shared = null;
        await context.close().catch(() => {});
      }
    },
  };
}

/** Instruction for the AI after a run left providers waiting for a code (MCP server). */
export function buildNextStep(pendingVerification) {
  if (!pendingVerification?.length) return null;
  const headed = pendingVerification.some(p => p.browserVisible);
  const lines = pendingVerification.map(
    p =>
      `- ${p.providerName} (verificationId ${p.verificationId}): code requested at ${p.requestedAt}, ` +
      `page ${p.pageHost}${p.hint ? `, page says: "${p.hint}"` : ''}. Expires at ${p.expiresAt}.`
  );
  const userPath = headed
    ? 'they can type it in the open browser window themselves (then call invoice_extractor_submit_code with only the verificationId to collect the invoices), or tell you the code and you call invoice_extractor_submit_code with it.'
    : 'the browser window is hidden, so they tell you the code and you call invoice_extractor_submit_code with it (or run invoice_extractor_run again with headed: true so they can type it themselves).';
  return [
    'These providers sent the user a one-time verification code and are waiting for it:',
    ...lines,
    'If you can read the user\'s email (Gmail/Outlook tools, etc.), find the newest message from each provider received after its requestedAt, extract the code and call invoice_extractor_submit_code({ verificationId, code }).',
    `If you cannot read their email, ask the user: ${userPath}`,
    'Never ask the user for their password: it stays in their password manager. If the provider rejects the code, the tool says so and you can retry until expiresAt; after that, run invoice_extractor_run again for that provider.',
  ].join('\n');
}

// ─── CLI hand-over: `invoice-extractor submit-code` → waiting `run --wait-for-code` ─────────

function exchangeDir(stateDir) {
  const dir = join(stateDir, 'verification');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writePrivateFile(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {}
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Waiting side (the `run` process). The marker never contains the code. */
export function createCodeMailbox(stateDir, { id = randomUUID(), providerId, expiresAt }) {
  const dir = exchangeDir(stateDir);
  const marker = join(dir, `${id}.pending.json`);
  const codeFile = join(dir, `${id}.code`);
  const resultFile = join(dir, `${id}.result.json`);
  writePrivateFile(marker, JSON.stringify({ providerId, expiresAt, pid: process.pid }));
  return {
    id,
    /** Reads and deletes a handed-over code, if any. */
    take() {
      if (!existsSync(codeFile)) return null;
      let code = null;
      try {
        code = readFileSync(codeFile, 'utf8');
      } catch {}
      removeQuietly(codeFile);
      return code;
    },
    reply(result) {
      removeQuietly(resultFile);
      writePrivateFile(resultFile, JSON.stringify(result));
    },
    close() {
      removeQuietly(marker);
      removeQuietly(codeFile);
    },
  };
}

/** Handing side (`submit-code`). Waits for the run to report whether the code was accepted. */
export async function handOverCode(stateDir, id, rawCode, { timeoutMs = 45000, intervalMs = 500, now = Date.now } = {}) {
  if (!isVerificationId(id)) throw new VerificationCodeError('--id must be the verificationId printed by `run --wait-for-code`.');
  const code = normalizeVerificationCode(rawCode);
  const dir = exchangeDir(stateDir);
  const pending = readJson(join(dir, `${id}.pending.json`));
  if (!pending || now() > Date.parse(pending.expiresAt)) {
    throw new VerificationCodeError('No run is waiting for that verificationId (finished or expired).');
  }
  const codeFile = join(dir, `${id}.code`);
  const resultFile = join(dir, `${id}.result.json`);
  removeQuietly(resultFile);
  try {
    writePrivateFile(codeFile, code);
  } catch {
    throw new VerificationCodeError('A code for this verification is already waiting to be used.', { retryable: true });
  }
  const deadline = now() + timeoutMs;
  try {
    while (now() < deadline) {
      await sleep(intervalMs);
      const result = readJson(resultFile);
      if (result) {
        removeQuietly(resultFile);
        return { providerId: pending.providerId, ...result };
      }
    }
  } finally {
    // Never leave the code on disk, even if the run never picked it up.
    removeQuietly(codeFile);
  }
  throw new VerificationCodeError('The waiting run did not pick up the code in time. Is it still running?', {
    retryable: true,
  });
}
