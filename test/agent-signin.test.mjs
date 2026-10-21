/**
 * Agent mode: multi-step sign-in (email page, then password page on another host) and a run
 * that survives one provider failing.
 *
 * Part 1 runs everywhere. Part 2 drives real Chromium against synthetic pages served through
 * request interception (no network, no real provider); it is skipped when the Playwright
 * browser is not installed.
 *
 * Run:  node --test test/agent-signin.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAllowedLoginDomains } from '../login-domains.mjs';
import { isNavigationError, runAgentExtraction, withNavigationTolerance } from '../bin/invoice-extractor.mjs';

// ─── Part 1 ───────────────────────────────────────────────────────────────────────────────

test('navigation errors are "the page moved", anything else still throws', async () => {
  assert.ok(isNavigationError(new Error('frame.evaluate: Execution context was destroyed, most likely because of a navigation.')));
  assert.ok(isNavigationError(new Error('Protocol error: Cannot find context with specified id')));
  assert.equal(isNavigationError(new Error('Target page, context or browser has been closed')), false);
  assert.deepEqual(await withNavigationTolerance(async () => 7), { value: 7, navigated: false });
  assert.deepEqual(
    await withNavigationTolerance(async () => { throw new Error('Execution context was destroyed'); }),
    { value: null, navigated: true }
  );
  await assert.rejects(withNavigationTolerance(async () => { throw new Error('boom'); }), /boom/);
});

// ─── Part 2: real browser against synthetic pages (no network) ────────────────────────────

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
  if (!existsSync(chromium.executablePath())) chromium = null;
} catch {
  chromium = null;
}
const browserSkip = chromium ? false : 'Playwright Chromium is not installed';

const PDF = '%PDF-1.4 synthetic invoice';
const PASSWORD = 'correct horse';

// Billing on billing.acme.test; sign-in on login.acme.test in two pages (like OpenAI:
// platform.openai.com -> auth.openai.com email page -> password page).
const ACME = {
  id: 'acme',
  name: 'Acme',
  billingUrl: 'https://billing.acme.test/invoices',
  readySelector: '#invoices',
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
  download: { method: 'fetch-blob', filenameTemplate: 'Acme_Invoice_{{date}}.pdf' },
};

// Ready page, but an invalid row selector makes the in-page extraction throw.
const BROKEN = {
  ...ACME,
  id: 'broken',
  name: 'Broken',
  billingUrl: 'https://billing.broken.test/invoices',
  auth: undefined,
  extract: { ...ACME.extract, rows: 'tr[[[' },
};

const html = body => ({ contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });

function fakeSite() {
  const site = { signedIn: false, passwordPosts: 0, emailPosts: 0 };
  site.handle = route => {
    const req = route.request();
    const url = req.url().split('#')[0];
    const { origin, pathname } = new URL(url);
    if (url === 'https://billing.broken.test/invoices') {
      return route.fulfill(html('<table id="invoices"><tr class="inv"><td class="date">2026-09-01</td></tr></table>'));
    }
    if (origin === 'https://billing.acme.test') {
      if (pathname.endsWith('.pdf')) return route.fulfill({ contentType: 'application/pdf', body: PDF });
      if (!site.signedIn) return route.fulfill(html(`<p>Redirecting</p><script>location.replace('https://login.acme.test/email')</script>`));
      return route.fulfill(html(`<table id="invoices">
        <tr class="inv"><td class="date">2026-09-01</td><td><a href="/inv-1.pdf">PDF</a></td></tr></table>`));
    }
    if (url === 'https://login.acme.test/email') {
      // Submitting navigates at once: the engine's in-page wait for a password field is cut off.
      return route.fulfill(html(`<form method="post" action="/password">
        <label>Email</label><input type="email" name="email"><button type="submit">Continue</button></form>`));
    }
    if (url === 'https://login.acme.test/password') {
      if (req.method() === 'POST') site.emailPosts += 1;
      return route.fulfill(html(`<form method="post" action="/session">
        <input type="password" name="password"><button type="submit">Log in</button></form>`));
    }
    if (url === 'https://login.acme.test/session' && req.method() === 'POST') {
      site.passwordPosts += 1;
      const ok = new URLSearchParams(req.postData() || '').get('password') === PASSWORD;
      if (!ok) return route.fulfill(html(`<p>Wrong password</p><form method="post" action="/session">
        <input type="password" name="password"><button type="submit">Log in</button></form>`));
      site.signedIn = true;
      return route.fulfill(html(`<script>location.replace('https://billing.acme.test/invoices')</script>`));
    }
    return route.fulfill({ status: 404, body: '' });
  };
  return site;
}

async function runWith({ providers, providerIds, password = PASSWORD }) {
  const work = mkdtempSync(path.join(tmpdir(), 'ie-signin-'));
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  const site = fakeSite();
  await context.route('**/*', site.handle);
  try {
    const manifest = await runAgentExtraction(
      {
        providerIds,
        outDir: path.join(work, 'out'),
        userDataDir: path.join(work, 'profile'),
        contextProvider: { acquire: async () => context, release: async () => {}, headed: false },
      },
      {
        providers,
        statePath: path.join(work, 'state.json'),
        resolveCredentials: async ({ provider }) =>
          provider.id === 'acme'
            ? {
                itemId: 'item-1',
                username: 'billing@acme.test',
                password,
                allowedLoginDomains: buildAllowedLoginDomains({ provider }),
              }
            : null,
      }
    );
    return { manifest, site, work };
  } finally {
    await browser.close();
  }
}

test('two-step sign-in: email page navigates mid-fill, password page, then billing', { skip: browserSkip, timeout: 90000 }, async () => {
  const { manifest, site, work } = await runWith({ providers: [ACME], providerIds: ['acme'] });
  try {
    assert.deepEqual(manifest.errors, []);
    assert.equal(site.emailPosts, 1, 'email submitted once');
    assert.equal(site.passwordPosts, 1, 'password submitted once');
    assert.equal(manifest.downloadedFiles.length, 1);
    assert.equal(readFileSync(manifest.downloadedFiles[0].path, 'utf8'), PDF);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a refused password is never submitted twice', { skip: browserSkip, timeout: 90000 }, async () => {
  const { manifest, site, work } = await runWith({ providers: [ACME], providerIds: ['acme'], password: 'wrong' });
  try {
    assert.equal(site.passwordPosts, 1);
    assert.equal(manifest.downloadedFiles.length, 0);
    assert.equal(manifest.errors.length, 1);
    assert.match(manifest.errors[0].error, /readySelector not reached/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a provider throwing is recorded and the run continues with the next one', { skip: browserSkip, timeout: 90000 }, async () => {
  const { manifest, work } = await runWith({ providers: [BROKEN, ACME], providerIds: ['broken', 'acme'] });
  try {
    const broken = manifest.errors.filter(e => e.providerId === 'broken');
    assert.equal(broken.length, 1);
    assert.match(broken[0].error, /Broken failed unexpectedly and was skipped/);
    assert.deepEqual(manifest.errors.filter(e => e.providerId === 'acme'), []);
    assert.equal(manifest.downloadedFiles.length, 1, 'the next provider still downloaded');
    assert.ok(manifest.completedAt);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
