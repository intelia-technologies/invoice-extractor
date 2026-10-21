/**
 * Agent-mode (CLI + MCP) equivalents of the extension's tab-based download methods.
 *
 * The extension implements `chrome-download` and `debugger-print` in popup.js with
 * chrome.tabs / chrome.downloads / chrome.debugger. Agent mode drives a Playwright persistent
 * Chromium instead, so the same behaviour is rebuilt here on Playwright pages:
 *
 * - `chrome-download`: open the invoice URL (plus `urlSuffix`) in a new page of the same context
 *   and save whatever download the browser starts (redirect, JS trigger or `postLoadClick`).
 * - `debugger-print`: open the receipt URL in a new page and print it to PDF through a CDP
 *   session (`Page.printToPDF`, same options as the extension). Works headed and headless,
 *   unlike `page.pdf()`.
 *
 * Both open URLs extracted from the billing page in the signed-in browser, so every URL is
 * checked first: https only (http only on localhost fixtures) and a host the recipe vouches for
 * (billingUrl host, `auth.loginDomains`, or `download.allowedHosts`, each with subdomains).
 */

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildAllowedLoginDomains, checkLoginLocation, isValidLoginDomain } from '../login-domains.mjs';

export const DOWNLOAD_TIMEOUT_MS = 25000;
const LOAD_TIMEOUT_MS = 12000;
const PRINT_LOAD_TIMEOUT_MS = 10000;
const PRINT_SETTLE_MS = 2000;
const DEFAULT_POST_LOAD_WAIT_MS = 2000;
const MAX_FALLBACK_REDIRECTS = 5;

// Same options popup.js passes to chrome.debugger 'Page.printToPDF'.
export const PRINT_TO_PDF_OPTIONS = Object.freeze({
  printBackground: true,
  preferCSSPageSize: true,
  marginTop: 0.4,
  marginBottom: 0.4,
  marginLeft: 0.4,
  marginRight: 0.4,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// `promise`'s value, or null after `ms` (the timer is cleared so it never holds the process open).
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(r => { timer = setTimeout(() => r(null), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hosts (each with subdomains) whose pages agent mode may open to download an invoice. */
export function allowedDownloadHosts(provider = {}) {
  const hosts = new Set(buildAllowedLoginDomains({ provider }));
  for (const entry of Array.isArray(provider?.download?.allowedHosts) ? provider.download.allowedHosts : []) {
    // Same shape as auth.loginDomains; malformed entries are ignored, never interpreted.
    if (isValidLoginDomain(entry)) hosts.add(entry);
  }
  return Array.from(hosts).sort();
}

/** { ok, url, reason?, host? } — the URL agent mode would open for this invoice, or why not. */
export function checkInvoiceUrl(url, provider = {}) {
  const check = checkLoginLocation({ url: String(url || '') }, allowedDownloadHosts(provider));
  if (check.ok) return { ok: true, url };
  const where = check.host || 'unknown';
  const why = check.reason === 'insecure'
    ? `is not https`
    : `is not a ${provider.name || provider.id || 'provider'} host (allowed: billingUrl host, auth.loginDomains, download.allowedHosts)`;
  return { ok: false, url, reason: check.reason, host: check.host, error: `Refused to open invoice URL on ${where}: it ${why}.` };
}

/** The URL the extension opens for chrome-download (urlSuffix appended once, trailing slash dropped). */
export function chromeDownloadUrl(url, downloadCfg = {}) {
  if (!url) return '';
  return downloadCfg.urlSuffix ? String(url).replace(/\/?$/, '') + downloadCfg.urlSuffix : String(url);
}

// Resolves with the first download started by `page` or by a popup it opens (target=_blank
// links, window.open), at any depth. Only this page's own popups are watched, never the shared
// context's pages, so concurrent helpers in one browser (MCP) cannot take each other's downloads.
// Popups are collected so the caller closes them.
function watchDownloads(page) {
  const popups = [];
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const onDownload = d => resolve(d);
  const onPopup = p => {
    popups.push(p);
    p.on('download', onDownload);
    p.on('popup', onPopup);
  };
  page.on('download', onDownload);
  page.on('popup', onPopup);
  return {
    promise,
    popups,
    stop() {
      for (const p of [page, ...popups]) {
        p.off('download', onDownload);
        p.off('popup', onPopup);
      }
    },
  };
}

// The URL a browser download really came from. A blob: URL carries the origin of the page that
// built it; a data: URL has none, so it is attributed to the page that started it.
export function downloadSourceUrl(download) {
  const url = String(download?.url?.() || '');
  if (url.startsWith('blob:')) return url.slice(5);
  if (url.startsWith('data:')) return download.page?.()?.url?.() || '';
  return url;
}

function refusedSource(check, provider) {
  const host = check.host || 'an unknown host';
  return `Refused to save a download from ${host}: it ${check.reason === 'insecure' ? 'is not https' : `is not a ${provider.name || provider.id} host`}. ` +
    'If this is the provider\'s own file host, add it to download.allowedHosts in the recipe.';
}

// IE_DEBUG=1: one JSON line on stderr per saved invoice with the host its bytes came from.
function debugDownloadHost(provider, destPath, url, source) {
  if (!process.env.IE_DEBUG) return;
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  process.stderr.write(`${JSON.stringify({
    event: 'debug_download_host',
    providerId: provider.id,
    filename: basename(destPath),
    method: provider.download?.method,
    source,
    host,
    url: String(url).split(/[?#]/)[0],
  })}\n`);
}

// Same click as the extension's postLoadClick (in the page, `el.click()`), plus the documented
// fallback: when no element's text contains `text` (a string or alternatives), the first match
// is clicked.
function clickInPage([selector, texts]) {
  const els = Array.from(document.querySelectorAll(selector));
  if (!els.length) return { clicked: false };
  const wanted = (texts || []).map(t => String(t).toLowerCase()).filter(Boolean);
  const matches = el => {
    const content = (el.textContent || '').trim().toLowerCase();
    return wanted.some(t => content.includes(t));
  };
  const hit = (wanted.length && els.find(matches)) || els[0];
  hit.click();
  return { clicked: true, fallback: wanted.length > 0 && !matches(hit) };
}

/**
 * chrome-download: open `invoiceUrl` in a new page and save the download it starts to destPath.
 * Returns { success: true } or { success: false, error }.
 */
export async function chromeDownloadInvoice(context, provider, invoiceUrl, destPath, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const cfg = provider.download || {};
  const url = chromeDownloadUrl(invoiceUrl, cfg);
  if (!url) return { success: false, error: 'No download URL for this invoice.' };
  const check = checkInvoiceUrl(url, provider);
  if (!check.ok) return { success: false, error: check.error };

  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  const page = await context.newPage();
  const watch = watchDownloads(page);
  try {
    // A download triggered by the navigation itself aborts goto ("Download is starting").
    const nav = page.goto(url, { waitUntil: 'load', timeout: Math.min(LOAD_TIMEOUT_MS, left()) })
      .then(() => 'loaded', err => (/download is starting/i.test(err.message) ? 'download' : 'load-failed'));
    let download = await Promise.race([watch.promise, nav.then(() => null)]);

    if (!download && cfg.postLoadClick) {
      const navResult = await nav;
      if (navResult === 'download') download = await within(watch.promise, Math.min(3000, left()));
      if (!download) {
        // The page may have redirected: only click on a page of the provider.
        const landed = checkInvoiceUrl(page.url(), provider);
        if (!landed.ok) return { success: false, error: landed.error };
        download = await within(watch.promise, Math.min(cfg.postLoadClick.wait ?? DEFAULT_POST_LOAD_WAIT_MS, left()));
      }
      if (!download) {
        let clicked;
        try {
          const text = cfg.postLoadClick.text;
          clicked = await page.evaluate(clickInPage, [cfg.postLoadClick.selector, Array.isArray(text) ? text : text ? [text] : []]);
        } catch (err) {
          return { success: false, error: `Download button click failed: ${err.message}` };
        }
        if (!clicked?.clicked) return { success: false, error: `Download button not found (${cfg.postLoadClick.selector}).` };
      }
    }

    if (!download) download = await within(watch.promise, left());
    if (!download) {
      if (cfg.postLoadClick) return { success: false, error: `No download started within ${Math.round(timeoutMs / 1000)} s.` };
      // Extension fallback: download the URL itself. Only accepted when it really is a PDF
      // (a hosted invoice page is HTML, not the invoice).
      return await fetchPdfFallback(context.request, provider, url, destPath, deadline);
    }

    // Where the bytes really come from (after redirects), checked before anything is saved.
    const source = downloadSourceUrl(download);
    const sourceCheck = checkInvoiceUrl(source, provider);
    if (!sourceCheck.ok) {
      await download.cancel().catch(() => {});
      return { success: false, error: refusedSource(sourceCheck, provider) };
    }
    debugDownloadHost(provider, destPath, source, 'download-event');
    await download.saveAs(destPath);
    const failure = await download.failure();
    if (failure) return { success: false, error: `Download failed: ${failure}` };
    return { success: true };
  } finally {
    watch.stop();
    for (const p of watch.popups) await p.close().catch(() => {});
    await page.close().catch(() => {});
  }
}

// Extension fallback without a browser download: fetch the URL with the browser's cookies.
// Redirects are followed one hop at a time and each hop is checked first, so cookies and the
// request never reach a host the recipe does not vouch for. `request` is an APIRequestContext.
export async function fetchPdfFallback(request, provider, url, destPath, deadline = Date.now() + DOWNLOAD_TIMEOUT_MS) {
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_FALLBACK_REDIRECTS; hop++) {
      const check = checkInvoiceUrl(current, provider);
      if (!check.ok) return { success: false, error: refusedSource(check, provider) };
      const res = await request.get(current, { timeout: Math.max(1000, deadline - Date.now()), maxRedirects: 0 });
      const status = res.status();
      if (status >= 300 && status < 400) {
        const location = res.headers().location;
        if (!location) break;
        current = new URL(location, current).href;
        continue;
      }
      const body = res.ok() ? await res.body() : null;
      if (body && body.subarray(0, 5).toString('latin1') === '%PDF-') {
        debugDownloadHost(provider, destPath, current, 'request-fallback');
        writeFileSync(destPath, body);
        return { success: true };
      }
      break;
    }
  } catch {}
  return { success: false, error: 'No download started and the URL did not return a PDF.' };
}

// A sign-in page instead of the receipt: a login-looking path, or a visible password field.
const SIGN_IN_PATH = /(^|\/)(log-?in|sign-?in|sign_in|log_in|signin|auth|sso|session\/new)(\/|$)/i;
async function looksLikeSignIn(page) {
  let path = '';
  try { path = new URL(page.url()).pathname; } catch {}
  if (SIGN_IN_PATH.test(path)) return true;
  return page.evaluate(() => Array.from(document.querySelectorAll('input[type="password"]')).some(el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  })).catch(() => false);
}

/**
 * debugger-print: open the receipt page and print it to PDF over CDP (Page.printToPDF).
 * Returns { success: true } or { success: false, error }.
 */
export async function printInvoiceToPdf(
  context,
  provider,
  receiptUrl,
  destPath,
  { loadTimeoutMs = PRINT_LOAD_TIMEOUT_MS, settleMs = PRINT_SETTLE_MS } = {}
) {
  if (!receiptUrl) return { success: false, error: 'No receipt URL for this invoice.' };
  const check = checkInvoiceUrl(receiptUrl, provider);
  if (!check.ok) return { success: false, error: check.error };

  const page = await context.newPage();
  try {
    // Like the extension: wait for load up to 10 s, then 2 s more for late rendering. Unlike a
    // blind print, a receipt that did not load is an error, never a "downloaded" PDF.
    let response = null;
    try {
      response = await page.goto(receiptUrl, { waitUntil: 'domcontentloaded', timeout: loadTimeoutMs });
    } catch (err) {
      return { success: false, error: `Receipt page did not load: ${err.message.split('\n')[0]}` };
    }
    if (!response) return { success: false, error: 'Receipt page did not load (no response).' };
    if (response.status() >= 400) return { success: false, error: `Receipt page returned HTTP ${response.status()}.` };
    await page.waitForLoadState('load', { timeout: loadTimeoutMs }).catch(() => {});
    await sleep(settleMs);
    const landed = checkInvoiceUrl(page.url(), provider);
    if (!landed.ok) return { success: false, error: landed.error };
    if (await looksLikeSignIn(page)) {
      return { success: false, error: `Receipt page redirected to a sign-in page (${new URL(page.url()).pathname}); the session may have expired.` };
    }
    const readySelector = provider.download?.readySelector;
    if (readySelector) {
      const ready = await page.waitForSelector(readySelector, { state: 'attached', timeout: loadTimeoutMs }).then(() => true, () => false);
      if (!ready) return { success: false, error: `Receipt page is not a receipt (download.readySelector ${readySelector} not found).` };
    }

    const cdp = await context.newCDPSession(page);
    try {
      const { data } = await cdp.send('Page.printToPDF', { ...PRINT_TO_PDF_OPTIONS });
      const pdf = data ? Buffer.from(data, 'base64') : null;
      if (!pdf || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return { success: false, error: 'Printing the receipt produced an empty PDF.' };
      }
      debugDownloadHost(provider, destPath, page.url(), 'print');
      writeFileSync(destPath, pdf);
      return { success: true };
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch (err) {
    return { success: false, error: `Printing the receipt failed: ${err.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}
