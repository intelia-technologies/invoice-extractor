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
import { buildAllowedLoginDomains, checkLoginLocation, isValidLoginDomain } from '../login-domains.mjs';

export const DOWNLOAD_TIMEOUT_MS = 25000;
const LOAD_TIMEOUT_MS = 12000;
const PRINT_LOAD_TIMEOUT_MS = 10000;
const PRINT_SETTLE_MS = 2000;
const DEFAULT_POST_LOAD_WAIT_MS = 2000;

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

// Resolves with the first download started by `page` or by any page it (or the context) opens
// afterwards (target=_blank links, window.open). Popups are collected so the caller closes them.
function watchDownloads(context, page) {
  const popups = [];
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const onDownload = d => resolve(d);
  const onPage = p => { popups.push(p); p.on('download', onDownload); };
  page.on('download', onDownload);
  context.on('page', onPage);
  return {
    promise,
    popups,
    stop() {
      page.off('download', onDownload);
      context.off('page', onPage);
      for (const p of popups) p.off('download', onDownload);
    },
  };
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
  const watch = watchDownloads(context, page);
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
      return await fetchPdfFallback(context, url, destPath, deadline);
    }

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

async function fetchPdfFallback(context, url, destPath, deadline) {
  try {
    const res = await context.request.get(url, { timeout: Math.max(1000, deadline - Date.now()) });
    const body = res.ok() ? await res.body() : null;
    if (body && body.subarray(0, 5).toString('latin1') === '%PDF-') {
      writeFileSync(destPath, body);
      return { success: true };
    }
  } catch {}
  return { success: false, error: 'No download started and the URL did not return a PDF.' };
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
    // Like the extension: wait for load up to 10 s, then 2 s more for late rendering.
    await page.goto(receiptUrl, { waitUntil: 'load', timeout: loadTimeoutMs }).catch(() => {});
    await sleep(settleMs);
    const landed = checkInvoiceUrl(page.url(), provider);
    if (!landed.ok) return { success: false, error: landed.error };

    const cdp = await context.newCDPSession(page);
    try {
      const { data } = await cdp.send('Page.printToPDF', { ...PRINT_TO_PDF_OPTIONS });
      const pdf = data ? Buffer.from(data, 'base64') : null;
      if (!pdf || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return { success: false, error: 'Printing the receipt produced an empty PDF.' };
      }
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
