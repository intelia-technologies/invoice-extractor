/**
 * Agent mode: chrome-download (OpenAI, Shortcut) and debugger-print (Hover) without the extension.
 *
 * Part 1 runs everywhere (URL checks, no browser). Part 2 drives real Chromium against synthetic
 * pages served through request interception (no network, no real provider); it is skipped when
 * the Playwright browser is not installed (CI only installs the npm package).
 *
 * Run:  node --test test/agent-downloads.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowedDownloadHosts,
  checkInvoiceUrl,
  chromeDownloadInvoice,
  chromeDownloadUrl,
  printInvoiceToPdf,
} from '../scripts/agent-downloads.mjs';
import { resumeAfterVerification } from '../bin/invoice-extractor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipe = id => JSON.parse(readFileSync(path.join(ROOT, 'providers', `${id}.json`), 'utf8'));

const ACME = {
  id: 'acme',
  name: 'Acme',
  billingUrl: 'https://billing.acme.test/invoices',
  readySelector: '#invoices',
  extract: {
    rows: 'tr.inv',
    fields: {
      date: { selector: 'td.date' },
      downloadUrl: { selector: 'a', attr: 'href', resolve: true },
    },
    dateFormat: 'YYYY-MM-DD',
    dedup: 'downloadUrl',
  },
  download: {
    method: 'chrome-download',
    allowedHosts: ['invoice.stripe.test'],
    filenameTemplate: '{{name}}_Invoice_{{date}}.pdf',
  },
};
const withDownload = download => ({ ...ACME, download: { ...ACME.download, ...download } });

// ─── Part 1: which URLs agent mode may open ───────────────────────────────────────────────

test('real recipes: Stripe hosts are allowed only where declared, billing host always', () => {
  const openai = recipe('openai');
  assert.ok(checkInvoiceUrl('https://invoice.stripe.com/i/acct_1/live_abc', openai).ok);
  assert.ok(checkInvoiceUrl('https://platform.openai.com/receipt/1', openai).ok);
  assert.equal(checkInvoiceUrl('https://pay.stripe.com/receipts/x', openai).ok, false, 'OpenAI only extracts invoice.stripe.com');

  const shortcut = recipe('shortcut');
  assert.ok(checkInvoiceUrl('https://pay.stripe.com/receipts/acct_1/ch_2', shortcut).ok);
  assert.ok(checkInvoiceUrl('https://invoice.stripe.com/i/acct_1/x', shortcut).ok);
  assert.equal(checkInvoiceUrl('https://dashboard.stripe.com/x', shortcut).ok, false);

  const hover = recipe('hover');
  assert.ok(checkInvoiceUrl('https://www.hover.com/control_panel/settings/receipts/123', hover).ok);
  assert.equal(checkInvoiceUrl('https://evil.test/www.hover.com/receipts/1', hover).ok, false);
});

test('checkInvoiceUrl refuses plain http, look-alike hosts and malformed allowedHosts entries', () => {
  const insecure = checkInvoiceUrl('http://invoice.stripe.test/i/1', ACME);
  assert.equal(insecure.ok, false);
  assert.equal(insecure.reason, 'insecure');
  assert.match(insecure.error, /not https/);

  const lookalike = checkInvoiceUrl('https://invoice.stripe.test.evil.test/i/1', ACME);
  assert.equal(lookalike.reason, 'domain-mismatch');
  assert.match(lookalike.error, /invoice\.stripe\.test\.evil\.test/);

  assert.equal(checkInvoiceUrl('javascript:alert(1)', ACME).ok, false);
  assert.equal(checkInvoiceUrl('', ACME).ok, false);
  const sloppy = withDownload({ allowedHosts: ['*.stripe.test', 'https://x.test', 'test'] });
  assert.deepEqual(allowedDownloadHosts(sloppy), ['billing.acme.test']);
});

test('chromeDownloadUrl appends urlSuffix once, like the extension', () => {
  assert.equal(chromeDownloadUrl('https://a.test/i/1/', { urlSuffix: '/pdf' }), 'https://a.test/i/1/pdf');
  assert.equal(chromeDownloadUrl('https://a.test/i/1', { urlSuffix: '/pdf' }), 'https://a.test/i/1/pdf');
  assert.equal(chromeDownloadUrl('https://a.test/i/1', {}), 'https://a.test/i/1');
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
const html = body => ({ contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });
const attachment = name => ({
  status: 200,
  headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` },
  body: PDF,
});

const ROUTES = {
  // The URL itself answers with an attachment (navigation turns into a download).
  'https://invoice.stripe.test/i/direct': () => attachment('direct.pdf'),
  // A redirect to the attachment. (Playwright cannot fulfill an intercepted request with a 3xx
  // that the browser follows, so the redirect is client-side; a server redirect reaches the
  // browser the same way: a navigation whose response is an attachment.)
  'https://invoice.stripe.test/i/redirect': () => html(`<script>location.replace('/files/r.pdf')</script>`),
  'https://invoice.stripe.test/files/r.pdf': () => attachment('r.pdf'),
  // A JS-triggered download some time after load. (An <a download> click is fetched by the
  // download manager outside request interception, so the fixture navigates instead.)
  'https://invoice.stripe.test/i/js': () => html(`<p>Preparing</p><script>
    setTimeout(() => { location.href = '/files/js.pdf'; }, 300);
  </script>`),
  'https://invoice.stripe.test/files/js.pdf': () => attachment('js.pdf'),
  // Hosted invoice page: the PDF only comes from the "Download invoice" button.
  'https://invoice.stripe.test/i/hosted': () => html(`<table class="InvoiceDetails-table"><tr><td>
    <button id="receipt" onclick="document.title='wrong button'">Download receipt</button>
    <button id="invoice" onclick="location.href='/files/hosted.pdf'">Download invoice</button></td></tr></table>`),
  'https://invoice.stripe.test/files/hosted.pdf': () => attachment('hosted.pdf'),
  // Link opening in a new tab.
  'https://invoice.stripe.test/i/blank': () => html(`<a target="_blank" href="/files/blank.pdf">Download invoice</a>`),
  'https://invoice.stripe.test/files/blank.pdf': () => attachment('blank.pdf'),
  // Plain HTML, never a download.
  'https://invoice.stripe.test/i/nothing': () => html('<p>Nothing to see</p>'),
  // A redirect off the allowed hosts before the click.
  'https://invoice.stripe.test/i/away': () => html(`<script>location.replace('https://login.other.test/sign-in')</script>`),
  'https://login.other.test/sign-in': () => html('<button>Download invoice</button>'),
  // Receipt page for debugger-print.
  'https://billing.acme.test/receipts/7': () => html(`<h1 style="background:#eef">Receipt #7</h1><p>Total: $12.00</p>`),
  // Billing page for the end-to-end run.
  'https://billing.acme.test/invoices': () => html(`<table id="invoices">
    <tr class="inv"><td class="date">2026-09-01</td><td><a href="https://invoice.stripe.test/i/hosted">View</a></td></tr>
    <tr class="inv"><td class="date">2026-08-01</td><td><a href="https://elsewhere.test/i/hosted">View</a></td></tr></table>`),
  'https://billing.acme.test/receipts': () => html(`<table id="invoices">
    <tr class="inv"><td class="date">2026-09-01</td><td><a href="/receipts/7">View</a></td></tr></table>`),
};

async function withContext(fn, { onRequest } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', route => {
    const url = route.request().url().split('#')[0];
    onRequest?.(url);
    const make = ROUTES[url];
    return make ? route.fulfill(make()) : route.fulfill({ status: 404, body: '' });
  });
  const out = mkdtempSync(path.join(tmpdir(), 'ie-agent-dl-'));
  try {
    return await fn(context, out);
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
}

const isPdf = file => readFileSync(file).subarray(0, 5).toString('latin1') === '%PDF-';

test('chrome-download saves a download started by the navigation, a redirect or page JS', { skip: browserSkip }, async () => {
  await withContext(async (context, out) => {
    for (const name of ['direct', 'redirect', 'js']) {
      const dest = path.join(out, `${name}.pdf`);
      const res = await chromeDownloadInvoice(context, ACME, `https://invoice.stripe.test/i/${name}`, dest, { timeoutMs: 8000 });
      assert.deepEqual(res, { success: true }, name);
      assert.equal(readFileSync(dest, 'utf8'), PDF, name);
    }
    assert.equal(context.pages().length, 0, 'every page it opened is closed');
  });
});

test('chrome-download with postLoadClick clicks the button whose text matches, then saves', { skip: browserSkip }, async () => {
  await withContext(async (context, out) => {
    const provider = withDownload({ postLoadClick: { selector: 'table.InvoiceDetails-table button', text: 'download invoice', wait: 200 } });
    const dest = path.join(out, 'hosted.pdf');
    const res = await chromeDownloadInvoice(context, provider, 'https://invoice.stripe.test/i/hosted', dest, { timeoutMs: 8000 });
    assert.deepEqual(res, { success: true });
    assert.ok(isPdf(dest));

    // A target=_blank link: the download happens in the new tab, which is closed afterwards.
    const blank = withDownload({ postLoadClick: { selector: 'a', text: ['descargar', 'download'], wait: 100 } });
    const dest2 = path.join(out, 'blank.pdf');
    assert.deepEqual(await chromeDownloadInvoice(context, blank, 'https://invoice.stripe.test/i/blank', dest2, { timeoutMs: 8000 }), { success: true });
    assert.ok(isPdf(dest2));

    // No element's text matches: the first match is clicked (documented fallback).
    const fallback = withDownload({ postLoadClick: { selector: 'a', text: 'no such label', wait: 50 } });
    const dest3 = path.join(out, 'fallback.pdf');
    assert.deepEqual(await chromeDownloadInvoice(context, fallback, 'https://invoice.stripe.test/i/blank', dest3, { timeoutMs: 8000 }), { success: true });
    assert.ok(isPdf(dest3));
    assert.equal(context.pages().length, 0);
  });
});

test('chrome-download reports a missing button, no download, and a redirect off the allowed hosts', { skip: browserSkip }, async () => {
  await withContext(async (context, out) => {
    const missing = withDownload({ postLoadClick: { selector: 'button.nope', wait: 50 } });
    const r1 = await chromeDownloadInvoice(context, missing, 'https://invoice.stripe.test/i/hosted', path.join(out, 'a.pdf'), { timeoutMs: 5000 });
    assert.equal(r1.success, false);
    assert.match(r1.error, /button not found/);

    const r2 = await chromeDownloadInvoice(context, ACME, 'https://invoice.stripe.test/i/nothing', path.join(out, 'b.pdf'), { timeoutMs: 1500 });
    assert.equal(r2.success, false);
    assert.match(r2.error, /did not return a PDF/);

    const clicky = withDownload({ postLoadClick: { selector: 'button', wait: 50 } });
    const r3 = await chromeDownloadInvoice(context, clicky, 'https://invoice.stripe.test/i/away', path.join(out, 'c.pdf'), { timeoutMs: 5000 });
    assert.equal(r3.success, false);
    assert.match(r3.error, /login\.other\.test/);
    assert.ok(!existsSync(path.join(out, 'c.pdf')));
    assert.equal(context.pages().length, 0);
  });
});

test('a URL on a disallowed host is refused before any request is made', { skip: browserSkip }, async () => {
  const requested = [];
  await withContext(async (context, out) => {
    const r = await chromeDownloadInvoice(context, ACME, 'https://evil.test/i/direct', path.join(out, 'x.pdf'));
    assert.equal(r.success, false);
    assert.match(r.error, /Refused to open invoice URL on evil\.test/);
    const p = await printInvoiceToPdf(context, { ...ACME, download: { method: 'debugger-print' } }, 'https://invoice.stripe.test/receipts/1', path.join(out, 'y.pdf'));
    assert.equal(p.success, false, 'allowedHosts of another recipe do not apply');
    assert.equal(context.pages().length, 0, 'no page was opened');
  }, { onRequest: url => requested.push(url) });
  assert.deepEqual(requested, []);
});

test('debugger-print prints the receipt page to a real PDF over CDP', { skip: browserSkip }, async () => {
  await withContext(async (context, out) => {
    const provider = { ...ACME, download: { method: 'debugger-print', filenameTemplate: 'x.pdf' } };
    const dest = path.join(out, 'receipt.pdf');
    const res = await printInvoiceToPdf(context, provider, 'https://billing.acme.test/receipts/7', dest, { settleMs: 100 });
    assert.deepEqual(res, { success: true });
    assert.ok(isPdf(dest), 'file starts with %PDF-');
    assert.ok(readFileSync(dest).length > 500);
    assert.equal(context.pages().length, 0);
  });
});

// End to end through extractProviderInvoices (resumeAfterVerification resumes a run on an open
// billing page): manifest, history and per-invoice errors as for the other methods.
test('agent run: chrome-download and debugger-print land in the manifest and history', { skip: browserSkip }, async () => {
  await withContext(async (context, out) => {
    const statePath = path.join(out, 'state.json');
    const run = async (provider, billingUrl) => {
      const page = await context.newPage();
      await page.goto(billingUrl);
      return resumeAfterVerification(
        { page, provider, billingUrl, runOptions: { outDir: out, maxInvoices: 5 }, deps: { statePath } },
        { code: null, waitMs: 0 }
      );
    };

    const hosted = withDownload({
      postLoadClick: { selector: 'button', text: 'download invoice', wait: 100 },
      filenameTemplate: 'Acme_Invoice_{{date}}.pdf',
    });
    const m1 = await run(hosted, 'https://billing.acme.test/invoices');
    assert.equal(m1.downloadedFiles.length, 1);
    assert.equal(m1.downloadedFiles[0].filename, 'Acme_Invoice_2026-09-01.pdf');
    assert.ok(isPdf(m1.downloadedFiles[0].path));
    assert.equal(m1.errors.length, 1, 'the row on elsewhere.test is refused, not downloaded');
    assert.match(m1.errors[0].error, /elsewhere\.test/);

    const printed = {
      ...ACME,
      billingUrl: 'https://billing.acme.test/receipts',
      download: { method: 'debugger-print', filenameTemplate: 'Acme_Receipt_{{date}}.pdf' },
    };
    const m2 = await run(printed, 'https://billing.acme.test/receipts');
    assert.deepEqual(m2.errors, []);
    assert.equal(m2.downloadedFiles[0].filename, 'Acme_Receipt_2026-09-01.pdf');
    assert.ok(isPdf(m2.downloadedFiles[0].path));

    const history = JSON.parse(readFileSync(statePath, 'utf8')).history;
    assert.ok(history.includes('acme::https://invoice.stripe.test/i/hosted'));
    assert.ok(history.includes('acme::https://billing.acme.test/receipts/7'));
  });
});
