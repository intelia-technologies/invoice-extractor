#!/usr/bin/env node
// Renders popup.html outside Chrome with stubbed extension APIs and saves a screenshot.
//
//   node test/popup-preview.mjs [en|es] [light|dark] [view] [--out file.png] [--empty] [--width 420]
//
// view: home (default), provider, batch-config, workflow, completion, history, profiles, record.
// --empty: start with no download history (shows the empty states).
// Default output directory: $PREVIEW_OUT_DIR, else the session scratchpad below.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = process.env.PREVIEW_OUT_DIR ||
  '/private/tmp/claude-501/-Users-pablomunizmunoz-vscode-projects-invoice-extractor/4b056163-a3fe-480c-991b-d70c8f799814/scratchpad/i18n';
const ORIGIN = 'http://popup.preview';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
const out = flag('--out');
const width = Number(flag('--width') || 420);
const empty = args.includes('--empty') && args.splice(args.indexOf('--empty'), 1);
const [lang = 'en', theme = 'light', rawView = 'home'] = args;
const view = rawView.replace(/^view-/, '');
const outPath = resolve(out || join(DEFAULT_OUT_DIR, `popup-${lang}-${theme}-${view}.png`));

const messages = JSON.parse(readFileSync(join(ROOT, '_locales', lang, 'messages.json'), 'utf8'));
const now = Date.now();
const history = empty ? [] : [
  { providerId: 'vultr', providerName: 'Vultr', date: '2026-10-01', amount: '$8.47', filename: 'Vultr_Invoice_2026-10-01.pdf', downloadedAt: new Date(now - 864e5).toISOString() },
  { providerId: 'webflow', providerName: 'Webflow', date: 'September 3, 2026', amount: '€23,00', filename: 'Webflow_Invoice_2026-09-03.pdf', downloadedAt: new Date(now - 2 * 864e5).toISOString() },
  { providerId: 'hover', providerName: 'Hover', date: 'Aug 14, 2026', amount: '$18.99', filename: 'Hover_Invoice_2026-08-14.pdf', downloadedAt: new Date(now - 3 * 864e5).toISOString() },
];

// Runs in the page before any script: a minimal chrome.* surface that keeps popup.js alive.
function installChromeStub({ messages, lang, origin, storage }) {
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const store = { ...storage };
  const pick = keys => {
    if (keys == null) return { ...store };
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list.filter(k => k in store).map(k => [k, structuredClone(store[k])]));
  };
  const getMessage = (key, subs) => {
    const entry = messages[key];
    if (!entry) return '';
    const values = subs == null ? [] : [].concat(subs).map(String);
    let text = entry.message;
    for (const [name, { content }] of Object.entries(entry.placeholders || {})) {
      const value = content.replace(/\$(\d)/g, (_, n) => values[n - 1] ?? '');
      text = text.replace(new RegExp(`\\$${name}\\$`, 'gi'), () => value);
    }
    return text.replace(/\$\$/g, '$');
  };
  const tab = { id: 1, windowId: 1, url: 'https://my.vultr.com/billing/', title: 'Vultr · Billing', active: true, status: 'complete' };
  window.chrome = {
    i18n: { getMessage, getUILanguage: () => lang },
    runtime: {
      getURL: path => `${origin}/${path}`,
      sendMessage: async message => message?.type === 'profile-sync'
        ? { ok: true, data: { connected: false, status: 'disconnected', message: '' } }
        : { ok: false, error: 'Preview: no service worker.' },
      onMessage: event(),
      reload() {},
    },
    storage: {
      local: {
        get: async keys => pick(keys),
        set: async values => { Object.assign(store, structuredClone(values)); },
        remove: async keys => { for (const k of [].concat(keys)) delete store[k]; },
      },
      onChanged: event(),
    },
    tabs: {
      query: async () => [tab], get: async () => tab, create: async info => ({ ...tab, ...info }),
      update: async () => tab, reload: async () => {}, remove: async () => {},
      onUpdated: event(), onActivated: event(), onCreated: event(),
    },
    windows: {
      // A floating window keeps init() from trying to reopen itself and close the page.
      getCurrent: async () => ({ id: 1, type: 'popup' }), get: async () => ({ id: 1, type: 'normal' }),
      getAll: async () => [], create: async () => ({ id: 2 }), update: async () => ({}),
      onFocusChanged: event(),
    },
    downloads: { search: async () => [], download: async () => 1, show() {}, showDefaultFolder() {}, removeFile: async () => {}, onCreated: event() },
    scripting: { executeScript: async () => [], unregisterContentScripts: async () => {} },
    webNavigation: { getAllFrames: async () => [], onCommitted: event() },
    cookies: { getAll: async () => [], remove: async () => {} },
  };
}

// Puts the requested view on screen with representative content, reusing popup.js renderers.
async function showView(view) {
  if (!providers.length) {
    providers = [
      { id: 'vultr', name: 'Vultr', icon: '☁️', billingUrl: 'https://my.vultr.com/billing/', extract: {}, download: {} },
      { id: 'webflow', name: 'Webflow', icon: '🌐', billingUrl: 'https://webflow.com/dashboard/account/billing', extract: {}, download: {} },
      { id: 'hover', name: 'Hover', icon: '🌍', billingUrl: 'https://www.hover.com/control_panel/account', extract: {}, download: {} },
    ];
    activeProviderIds = new Set(providers.map(p => p.id));
    await renderHome();
  }
  const sample = providers.slice(0, 4);
  switch (view) {
    case 'provider': nav.push('provider', { providerId: sample[0].id }); await renderProviderDetail(sample[0].id); break;
    case 'batch-config': workflowProviders = sample; nav.push('batch-config'); renderBatchConfig(sample); break;
    case 'workflow': {
      workflowProviders = sample;
      state = { ...state, isRunning: true, currentIndex: 1, completed: [workflowKey(sample[0])], skipped: [] };
      nav.push('workflow');
      showCurrentSiteUI(sample[1]);
      showStatus(t('workflowStatusDetecting', [sample[1].name, 4]));
      showButtons(true, false, false, true, false, false, true);
      updateProgress();
      updateSitesList();
      break;
    }
    case 'completion':
      workflowProviders = sample;
      state = { ...state, completed: sample.slice(1).map(workflowKey), skipped: [{ key: sample[0].id, reason: t('workflowSkipAllDownloaded') }] };
      showCompletion();
      break;
    case 'history': nav.push('history'); await renderHistory(); break;
    case 'profiles': nav.push('profiles'); await renderProfiles(); break;
    case 'record': nav.push('record'); showRecordStep('confirm'); break;
    case 'home': break;
    default: nav.show(view);
  }
}

const { chromium } = await import(join(ROOT, 'node_modules/playwright/index.mjs'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 2, colorScheme: theme === 'dark' ? 'dark' : 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '') || 'popup.html';
    try {
      await route.fulfill({ body: readFileSync(join(ROOT, path)), contentType: TYPES[extname(path)] || 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  await page.addInitScript(installChromeStub, { messages, lang, origin: ORIGIN, storage: { downloadHistory: history, floatingMode: true } });
  await page.goto(`${ORIGIN}/popup.html`);
  await page.waitForFunction(() => document.getElementById('home-stats')?.textContent.trim());
  await page.evaluate(`(${showView})(${JSON.stringify(view)})`);
  await page.waitForTimeout(300);
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true });
  if (errors.length) console.warn('Page errors:\n' + errors.join('\n'));
  console.log(outPath);
} finally {
  await browser.close();
}
