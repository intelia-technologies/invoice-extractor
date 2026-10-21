/**
 * Agent mode: a provider asks for a one-time verification code after the password.
 *
 * Part 1 runs everywhere (fake pages, no browser). Part 2 drives real Chromium against
 * synthetic pages served through request interception (no network, no real provider); it is
 * skipped when the Playwright browser is not installed (CI only installs the npm package).
 *
 * Run:  node --test test/verification-code.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNextStep,
  createCodeMailbox,
  createVerificationRegistry,
  detectCodeStep,
  handOverCode,
  normalizeVerificationCode,
  redactCode,
  sameBillingLocation,
  typeVerificationCode,
  VerificationCodeError,
} from '../scripts/verification-code.mjs';
import { buildAllowedLoginDomains } from '../login-domains.mjs';
import { parseWaitForCode, resumeAfterVerification, waitForCodeFromCli } from '../bin/invoice-extractor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOLDED = JSON.parse(readFileSync(path.join(ROOT, 'providers', 'holded.json'), 'utf8'));
const HOLDED_BILLING = HOLDED.billingUrl;
// As resolved for a vault item saved with https://app.holded.com (see login-domains.mjs).
const HOLDED_DOMAINS = buildAllowedLoginDomains({ itemUrls: ['https://app.holded.com/login'], provider: HOLDED });
const CODE = '482913';

// ─── Fake page: the engine calls run against a scripted in-memory engine ──────────────────

function fakePage({ url = 'https://app.holded.com/login', slots = { count: 6, split: true }, step = {}, failFill = null } = {}) {
  const fills = [];
  const engineCalls = [];
  const engine = {
    detectVerificationStep(authCfg, context) {
      engineCalls.push(['detectVerificationStep', context]);
      return { awaiting: true, hasCodeField: true, hint: 'We sent a code to p***@intelia.test', ...step };
    },
    markCodeInputs() {
      engineCalls.push(['markCodeInputs']);
      return slots;
    },
    submitVerificationCode() {
      engineCalls.push(['submitVerificationCode']);
      return { submitted: true, via: 'button' };
    },
  };
  const frame = {
    url: () => url,
    parentFrame: () => null,
    async evaluate(fn, arg) {
      const previous = globalThis.window;
      globalThis.window = { __invoiceEngine: engine };
      try {
        return await fn(arg);
      } finally {
        globalThis.window = previous;
      }
    },
    async fill(selector, value) {
      if (failFill) throw new Error(failFill(value));
      fills.push([selector, value]);
    },
    async press() {},
  };
  return {
    fills,
    engineCalls,
    url: () => url,
    mainFrame: () => frame,
    isClosed: () => false,
  };
}

const noInject = async () => {};

test('normalizeVerificationCode trims spaces and dashes and validates the format', () => {
  assert.equal(normalizeVerificationCode(' 482 913 '), '482913');
  assert.equal(normalizeVerificationCode('482-913'), '482913');
  assert.equal(normalizeVerificationCode('ab12cd'), 'ab12cd');
  for (const bad of ['123', '12345678901', '12$456', '', null]) {
    assert.throws(() => normalizeVerificationCode(bad), err => {
      assert.ok(err instanceof VerificationCodeError);
      assert.ok(!err.message.includes(String(bad)) || !bad, 'error must not echo the input');
      return true;
    });
  }
});

test('codes are only typed on the provider sign-in hosts from login-domains.mjs (no suffix guessing)', async () => {
  const tenant = { id: 'pages', name: 'Pages', billingUrl: 'https://tenant.github.io/billing' };
  const domains = buildAllowedLoginDomains({ provider: tenant });
  await typeVerificationCode(fakePage({ url: 'https://tenant.github.io/verify' }), tenant, CODE, {
    allowedLoginDomains: domains,
    inject: noInject,
  });
  for (const url of ['https://evil.github.io/verify', 'https://github.io/verify', 'http://tenant.github.io/verify']) {
    const page = fakePage({ url });
    await assert.rejects(
      typeVerificationCode(page, tenant, CODE, { allowedLoginDomains: domains, inject: noInject }),
      /Refusing to type the code/
    );
    assert.equal(page.fills.length, 0);
  }
  // A sibling sign-in host is only allowed through a human-declared auth.loginDomains entry.
  const sibling = { ...tenant, billingUrl: 'https://platform.example.com/billing' };
  const page = fakePage({ url: 'https://auth.example.com/otp' });
  await assert.rejects(
    typeVerificationCode(page, sibling, CODE, { allowedLoginDomains: buildAllowedLoginDomains({ provider: sibling }), inject: noInject }),
    /Refusing/
  );
  const declared = { ...sibling, auth: { loginDomains: ['example.com'] } };
  await typeVerificationCode(page, declared, CODE, {
    allowedLoginDomains: buildAllowedLoginDomains({ provider: declared }),
    inject: noInject,
  });
  assert.equal(page.fills.length, 6);
});

test('a root billingUrl (Naturgy) does not make every page of the host the billing page', async () => {
  const root = 'https://omega.naturgy.es/';
  assert.equal(sameBillingLocation('https://omega.naturgy.es/', root), true);
  assert.equal(sameBillingLocation('https://omega.naturgy.es/login', root), false);
  assert.equal(sameBillingLocation('https://dashboard.stripe.com/acct_1/settings/billing', 'https://dashboard.stripe.com/settings/billing'), true);
  assert.equal(sameBillingLocation('https://x.test/billing-old', 'https://x.test/billing'), false);
  assert.equal(sameBillingLocation('https://x.test/billing/invoices', 'https://x.test/billing'), true);

  const naturgy = JSON.parse(readFileSync(path.join(ROOT, 'providers', 'naturgy.json'), 'utf8'));
  const page = fakePage({ url: 'https://omega.naturgy.es/login' });
  const step = await detectCodeStep(page, naturgy, { billingUrl: naturgy.billingUrl, loginStartUrl: 'x' }, { inject: noInject });
  assert.equal(step.awaiting, true, 'the code step on the sign-in page is detected');
  assert.equal(page.engineCalls.length, 1);
});

test('typeVerificationCode types one character per box on split inputs and submits', async () => {
  const page = fakePage();
  await typeVerificationCode(page, HOLDED, '482 913', { allowedLoginDomains: HOLDED_DOMAINS, inject: noInject });
  assert.deepEqual(
    page.fills,
    [...CODE].map((ch, i) => [`[data-invoice-code-slot="${i}"]`, ch])
  );
  assert.deepEqual(page.engineCalls.map(c => c[0]), ['markCodeInputs', 'submitVerificationCode']);
});

test('typeVerificationCode fills a single code field in one go', async () => {
  const page = fakePage({ slots: { count: 1, split: false, maxLength: 6 } });
  await typeVerificationCode(page, HOLDED, CODE, { allowedLoginDomains: HOLDED_DOMAINS, inject: noInject });
  assert.deepEqual(page.fills, [['[data-invoice-code-slot="0"]', CODE]]);
});

test('typeVerificationCode refuses a page that is not the provider and never touches it', async () => {
  const page = fakePage({ url: 'https://phishing.example/login' });
  await assert.rejects(
    typeVerificationCode(page, HOLDED, CODE, { allowedLoginDomains: HOLDED_DOMAINS, inject: noInject }),
    err => err instanceof VerificationCodeError && /not a Holded sign-in page/.test(err.message) && !err.message.includes(CODE)
  );
  assert.equal(page.fills.length, 0);
  assert.equal(page.engineCalls.length, 0);
});

test('typeVerificationCode reports a length mismatch as retryable and redacts browser errors', async () => {
  const short = fakePage({ slots: { count: 4, split: true } });
  await assert.rejects(
    typeVerificationCode(short, HOLDED, CODE, { allowedLoginDomains: HOLDED_DOMAINS, inject: noInject }),
    err => err.retryable && /4-character/.test(err.message)
  );
  const leaky = fakePage({ failFill: value => `fill failed for value "${value}"`, slots: { count: 1, split: false } });
  await assert.rejects(
    typeVerificationCode(leaky, HOLDED, CODE, { allowedLoginDomains: HOLDED_DOMAINS, inject: noInject }),
    err => err.retryable && !err.message.includes(CODE) && err.message.includes('***')
  );
});

test('detectCodeStep never reports the billing page itself and truncates the hint', async () => {
  const onBilling = fakePage({ url: HOLDED_BILLING });
  assert.equal((await detectCodeStep(onBilling, HOLDED, { billingUrl: HOLDED_BILLING }, { inject: noInject })).awaiting, false);
  assert.equal(onBilling.engineCalls.length, 0);

  const long = fakePage({ step: { hint: 'x'.repeat(500) } });
  const step = await detectCodeStep(long, HOLDED, { billingUrl: HOLDED_BILLING, loginStartUrl: 'a' }, { inject: noInject });
  assert.equal(step.awaiting, true);
  assert.ok(step.hint.length <= 160);
  assert.equal(long.engineCalls[0][1].detectSplitInputs, true);
});

test('redactCode removes every occurrence of the code', () => {
  assert.equal(redactCode('a 482913 b 482913', CODE), 'a *** b ***');
  assert.equal(redactCode('nothing here', ''), 'nothing here');
});

test('parseWaitForCode: flag alone means 10 minutes, a value sets minutes, absent fails fast', () => {
  assert.deepEqual(parseWaitForCode(undefined), { verificationMode: 'fail' });
  assert.deepEqual(parseWaitForCode(true), { verificationMode: 'wait', waitForCodeMs: 600000 });
  assert.deepEqual(parseWaitForCode('3'), { verificationMode: 'wait', waitForCodeMs: 180000 });
  assert.throws(() => parseWaitForCode('soon'));
});

test('buildNextStep states the rule: read the email if possible, otherwise ask the user', () => {
  const entry = {
    verificationId: 'id-1',
    providerName: 'Holded',
    pageHost: 'app.holded.com',
    hint: 'We sent a code',
    requestedAt: '2026-10-21T10:00:00.000Z',
    expiresAt: '2026-10-21T10:10:00.000Z',
    browserVisible: false,
  };
  const text = buildNextStep([entry]);
  assert.match(text, /If you can read the user's email/);
  assert.match(text, /newest message from each provider received after its requestedAt/);
  assert.match(text, /ask the user/);
  assert.match(text, /id-1/);
  assert.match(text, /browser window is hidden/);
  assert.match(buildNextStep([{ ...entry, browserVisible: true }]), /type it in the open browser window/);
  assert.equal(buildNextStep([]), null);
});

// ─── Registry (MCP server) ────────────────────────────────────────────────────────────────

function fakeContext() {
  return { closed: false, async close() { this.closed = true; } };
}

function pendingFor(page) {
  return {
    page,
    providerId: 'holded',
    providerName: 'Holded',
    pageHost: 'app.holded.com',
    hint: 'We sent a code to p***@intelia.test',
    requestedAt: new Date().toISOString(),
    headed: false,
  };
}

test('registry: wrong code is retryable, right code completes, page and browser are closed', async () => {
  const calls = [];
  const resume = async (pending, { code }) => {
    calls.push(code);
    if (code !== CODE) throw new VerificationCodeError('Holded did not accept the code.', { retryable: true });
    return { downloadedFiles: [{ providerId: 'holded', filename: 'Holded_Invoice_1.pdf' }], errors: [] };
  };
  const registry = createVerificationRegistry({ resume, watchIntervalMs: 0 });
  const context = fakeContext();
  await registry.contextProvider.acquire(async () => context);
  const page = { closed: false, async close() { this.closed = true; } };
  const view = registry.add(pendingFor(page));
  await registry.contextProvider.release(); // the run finished; the pending page keeps the browser
  assert.equal(context.closed, false);
  assert.ok(view.verificationId && view.expiresAt);
  assert.equal(view.page, undefined);

  await assert.rejects(registry.submit(view.verificationId, '000000'), err => err.retryable);
  assert.equal(page.closed, false);
  await assert.rejects(registry.submit(view.verificationId, '12'), err => err.retryable);
  assert.deepEqual(calls, ['000000']); // the malformed code never reached the page

  const outcome = await registry.submit(view.verificationId, CODE);
  assert.equal(outcome.completedBy, 'code');
  assert.equal(outcome.result.downloadedFiles.length, 1);
  assert.ok(!JSON.stringify(outcome).includes(CODE), 'the code must not be echoed in the result');
  assert.equal(page.closed, true);
  assert.equal(context.closed, true);
  assert.deepEqual(registry.list(), []);
});

test('registry: the user typing the code in the window is picked up automatically', async () => {
  let userDone = false;
  const resume = async (pending, { code }) => {
    assert.equal(code, undefined);
    return userDone ? { downloadedFiles: [{ filename: 'a.pdf' }], errors: [] } : null;
  };
  const registry = createVerificationRegistry({ resume, watchIntervalMs: 20 });
  await registry.contextProvider.acquire(async () => fakeContext());
  const page = { async close() {} };
  const view = registry.add(pendingFor(page));
  await registry.contextProvider.release();

  const waiting = await registry.submit(view.verificationId, null);
  assert.equal(waiting.status, 'waiting');
  userDone = true;
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(registry.list(), []);
  const outcome = await registry.submit(view.verificationId, null);
  assert.equal(outcome.completedBy, 'user');
  assert.equal(outcome.result.downloadedFiles[0].filename, 'a.pdf');
});

test('registry: entries expire, close the page and reject later submissions', async () => {
  const registry = createVerificationRegistry({ resume: async () => null, ttlMs: 30, watchIntervalMs: 0 });
  const context = fakeContext();
  await registry.contextProvider.acquire(async () => context);
  const page = { closed: false, async close() { this.closed = true; } };
  const view = registry.add(pendingFor(page));
  await registry.contextProvider.release();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(page.closed, true);
  assert.equal(context.closed, true);
  await assert.rejects(registry.submit(view.verificationId, CODE), /expired/);
  await assert.rejects(registry.submit('unknown', CODE), /Unknown verificationId/);
});

test('registry: concurrent runs share one browser launch and hold accounting stays correct', async () => {
  const registry = createVerificationRegistry({ resume: async () => null, watchIntervalMs: 0 });
  let launches = 0;
  const context = fakeContext();
  const launch = async () => {
    launches += 1;
    await new Promise(r => setTimeout(r, 30));
    return context;
  };
  const [a, b, c] = await Promise.all([
    registry.contextProvider.acquire(launch),
    registry.contextProvider.acquire(launch),
    registry.contextProvider.acquire(launch),
  ]);
  assert.equal(launches, 1);
  assert.ok(a === context && b === context && c === context);
  await registry.contextProvider.release();
  await registry.contextProvider.release();
  assert.equal(context.closed, false, 'one run still holds the browser');
  await registry.contextProvider.release();
  assert.equal(context.closed, true);

  // A failed launch does not wedge later runs.
  const flaky = createVerificationRegistry({ resume: async () => null, watchIntervalMs: 0 });
  const results = await Promise.allSettled([
    flaky.contextProvider.acquire(async () => { throw new Error('no browser'); }),
    flaky.contextProvider.acquire(async () => fakeContext()),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
});

// ─── CLI hand-over through the state directory ────────────────────────────────────────────

test('submit-code hands the code over in a 0600 file that is deleted right after reading', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ie-verif-'));
  try {
    const mailbox = createCodeMailbox(stateDir, {
      providerId: 'holded',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const dir = path.join(stateDir, 'verification');
    const marker = readFileSync(path.join(dir, `${mailbox.id}.pending.json`), 'utf8');
    assert.ok(!marker.includes(CODE));

    const handing = handOverCode(stateDir, mailbox.id, '482-913', { intervalMs: 10 });
    let taken = null;
    for (let i = 0; i < 100 && taken == null; i++) {
      const codeFile = path.join(dir, `${mailbox.id}.code`);
      if (existsSync(codeFile)) {
        if (process.platform !== 'win32') assert.equal(statSync(codeFile).mode & 0o777, 0o600);
        taken = mailbox.take();
      } else {
        await new Promise(r => setTimeout(r, 10));
      }
    }
    assert.equal(taken, CODE);
    assert.ok(!existsSync(path.join(dir, `${mailbox.id}.code`)), 'code file deleted after reading');
    mailbox.reply({ accepted: true, message: 'Holded accepted the code; downloading invoices.' });
    const result = await handing;
    assert.equal(result.accepted, true);
    assert.equal(result.providerId, 'holded');
    mailbox.close();
    assert.deepEqual(readdirSync(dir), [], 'nothing left on disk');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('submit-code refuses unknown, expired or malformed verification ids', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ie-verif-'));
  try {
    await assert.rejects(handOverCode(stateDir, '../../etc/passwd', CODE), /--id/);
    await assert.rejects(handOverCode(stateDir, '00000000-0000-4000-8000-000000000000', CODE), /No run is waiting/);
    const expired = createCodeMailbox(stateDir, { providerId: 'holded', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(handOverCode(stateDir, expired.id, CODE), /No run is waiting/);
    const live = createCodeMailbox(stateDir, { providerId: 'holded', expiresAt: new Date(Date.now() + 60000).toISOString() });
    await assert.rejects(handOverCode(stateDir, live.id, CODE, { timeoutMs: 50, intervalMs: 10 }), /did not pick up/);
    assert.ok(!existsSync(path.join(stateDir, 'verification', `${live.id}.code`)), 'unclaimed code is deleted');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ─── Real browser against synthetic pages (no network) ────────────────────────────────────

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
  if (!existsSync(chromium.executablePath())) chromium = null;
} catch {
  chromium = null;
}
const browserSkip = chromium ? false : 'Playwright Chromium is not installed';

const ACME = {
  id: 'acme',
  name: 'Acme',
  billingUrl: 'https://billing.acme.test/invoices',
  readySelector: '#invoices',
  // Sign-in lives on a sibling host (login.acme.test): declared, as recipes must.
  auth: { loginDomains: ['acme.test'] },
  extract: {
    rows: 'tr.inv',
    fields: {
      date: { selector: 'td.date' },
      downloadUrl: { selector: 'a', attr: 'href', resolve: true },
    },
    dateFormat: 'YYYY-MM-DD',
    dedup: 'downloadUrl',
  },
  download: { method: 'fetch-blob', filenameTemplate: '{{name}}_Invoice_{{date}}.pdf' },
};

const SPLIT_PAGE = `<!doctype html><html><body>
<h1>Check your email</h1>
<form id="f"><p>We sent a 6-digit code to p***@acme.test</p>
<div class="boxes">${'<input type="text" inputmode="numeric" maxlength="1" style="width:2em">'.repeat(6)}</div>
<p id="err" hidden>That code is not valid</p>
<button type="submit">Verify</button></form>
<script>
document.getElementById('f').addEventListener('submit', e => {
  e.preventDefault();
  const code = [...document.querySelectorAll('.boxes input')].map(i => i.value).join('');
  if (code === '${CODE}') { location.href = 'https://billing.acme.test/invoices'; return; }
  document.getElementById('err').hidden = false;
  document.querySelectorAll('.boxes input').forEach(i => { i.value = ''; });
});
</script></body></html>`;

const PAGES = {
  'https://login.acme.test/verify': SPLIT_PAGE,
  'https://login.evil.test/verify': SPLIT_PAGE,
  'https://login.acme.test/otp': `<!doctype html><html><body><form>
    <label>Enter the code we emailed you</label><input name="otp" autocomplete="one-time-code">
    <button type="submit">Continue</button></form></body></html>`,
  'https://login.acme.test/login': `<!doctype html><html><body><form>
    <input type="email" name="email"><input type="password" name="password"><button>Sign in</button></form></body></html>`,
  'https://login.acme.test/waiting': `<!doctype html><html><body><p>Open the link we sent to your email</p></body></html>`,
  'https://billing.acme.test/invoices': `<!doctype html><html><body><table id="invoices">
    <tr class="inv"><td class="date">2026-09-01</td><td><a href="/inv-1.pdf">PDF</a></td></tr></table></body></html>`,
};

async function withBrowser(fn) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.endsWith('.pdf')) return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4 synthetic' });
    const body = PAGES[url.split('#')[0]];
    return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404, body: '' });
  });
  try {
    return await fn(await context.newPage());
  } finally {
    await browser.close();
  }
}

async function injectEngine(frame) {
  for (const file of ['utils.js', 'engine.js']) {
    await frame.evaluate(code => (0, eval)(code), readFileSync(path.join(ROOT, file), 'utf8'));
  }
}

test('engine detects split, single and vanished-form code steps, not plain sign-in forms', { skip: browserSkip }, async () => {
  await withBrowser(async page => {
    const detect = async (url, loginStartUrl = 'https://login.acme.test/login') => {
      await page.goto(url);
      return detectCodeStep(page, ACME, { billingUrl: ACME.billingUrl, loginStartUrl }, { inject: injectEngine });
    };
    const split = await detect('https://login.acme.test/verify');
    assert.equal(split.awaiting, true);
    assert.equal(split.codeLength, 6);
    assert.match(split.hint, /6-digit code to p\*\*\*@acme\.test/);

    const single = await detect('https://login.acme.test/otp');
    assert.equal(single.awaiting, true);
    assert.match(single.hint, /code we emailed/);

    const vanished = await detect('https://login.acme.test/waiting', 'https://login.acme.test/waiting');
    assert.equal(vanished.awaiting, true);

    assert.equal((await detect('https://login.acme.test/login')).awaiting, false);
    assert.equal((await detect('https://billing.acme.test/invoices')).awaiting, false);
  });
});

test('submit code on split inputs: wrong code is retryable, right code downloads, code never leaks', { skip: browserSkip }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'ie-verif-run-'));
  const statePath = path.join(work, 'state.json');
  try {
    await withBrowser(async page => {
      await page.goto('https://login.acme.test/verify');
      const pending = {
        page,
        provider: ACME,
        provConfig: {},
        billingUrl: ACME.billingUrl,
        loginStartUrl: 'https://login.acme.test/login',
        hasOtpCredential: false,
        owner: { itemId: 'item-1', username: 'billing@acme.test' },
        acceptTimeoutMs: 3000,
        runOptions: { outDir: work, maxInvoices: 5 },
        deps: { statePath },
      };

      await assert.rejects(
        resumeAfterVerification(pending, { code: '111111' }),
        err => err instanceof VerificationCodeError && err.retryable && !err.message.includes('111111')
      );
      assert.equal(page.url(), 'https://login.acme.test/verify');

      const manifest = await resumeAfterVerification(pending, { code: `${CODE.slice(0, 3)} ${CODE.slice(3)}` });
      assert.deepEqual(manifest.errors, []);
      assert.equal(manifest.downloadedFiles.length, 1);
      assert.equal(readFileSync(manifest.downloadedFiles[0].path, 'utf8'), '%PDF-1.4 synthetic');
      assert.ok(!JSON.stringify(manifest).includes(CODE), 'manifest must not contain the code');
      assert.ok(!readFileSync(statePath, 'utf8').includes(CODE), 'state must not contain the code');
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('submit code is refused on a page outside the provider domain', { skip: browserSkip }, async () => {
  await withBrowser(async page => {
    await page.goto('https://login.evil.test/verify');
    await assert.rejects(
      resumeAfterVerification({ page, provider: ACME, billingUrl: ACME.billingUrl, deps: {} }, { code: CODE }),
      /not a Acme sign-in page/
    );
    const values = await page.$$eval('.boxes input', inputs => inputs.map(i => i.value).join(''));
    assert.equal(values, '');
  });
});

test('a code typed by the user in the window is detected and the run continues', { skip: browserSkip }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'ie-verif-run-'));
  try {
    await withBrowser(async page => {
      await page.goto('https://login.acme.test/verify');
      const pending = {
        page,
        provider: ACME,
        provConfig: {},
        billingUrl: ACME.billingUrl,
        loginStartUrl: 'https://login.acme.test/login',
        owner: {},
        runOptions: { outDir: work },
        deps: { statePath: path.join(work, 'state.json') },
      };
      assert.equal(await resumeAfterVerification(pending, { waitMs: 0 }), null);
      const boxes = page.locator('.boxes input');
      for (let i = 0; i < CODE.length; i++) await boxes.nth(i).fill(CODE[i]);
      await page.click('button[type=submit]');
      const manifest = await resumeAfterVerification(pending, { waitMs: 5000 });
      assert.equal(manifest.downloadedFiles.length, 1);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('CLI --wait-for-code: submit-code hands the code to the waiting run; a wrong one can be retried', { skip: browserSkip }, async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'ie-verif-cli-'));
  const stateDir = path.join(work, 'state');
  const deps = { statePath: path.join(stateDir, 'state.json') };
  try {
    await withBrowser(async page => {
      await page.goto('https://login.acme.test/verify');
      const ctx = {
        billingUrl: ACME.billingUrl,
        loginStartUrl: 'https://login.acme.test/login',
        requestedAt: new Date().toISOString(),
        allowedLoginDomains: buildAllowedLoginDomains({ provider: ACME }),
      };
      const events = [];
      let announce;
      const announced = new Promise(r => (announce = r));
      const onEvent = e => {
        events.push(e);
        if (e.event === 'verification_code_required') announce(e);
      };
      const waiting = waitForCodeFromCli(
        page,
        ACME,
        ctx,
        { hint: 'We sent a 6-digit code' },
        { waitForCodeMs: 30000, acceptTimeoutMs: 2000, onEvent },
        deps
      );
      const { verificationId } = await announced;

      const wrong = await handOverCode(stateDir, verificationId, '111111', { intervalMs: 50 });
      assert.equal(wrong.accepted, false);
      const right = await handOverCode(stateDir, verificationId, CODE, { intervalMs: 50 });
      assert.equal(right.accepted, true);
      assert.equal(await waiting, true);

      assert.deepEqual(events.map(e => e.event), ['verification_code_required', 'verification_code_rejected']);
      assert.equal(events[0].providerId, 'acme');
      assert.match(events[0].submitWith, /submit-code --id/);
      const printed = JSON.stringify(events);
      assert.ok(!printed.includes(CODE) && !printed.includes('111111'), 'events never carry the code');
      assert.deepEqual(readdirSync(path.join(stateDir, 'verification')), [], 'exchange files removed');
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
