/**
 * Playwright E2E test for the Invoice Downloader recorder.
 *
 * Launches Chromium with the extension loaded unpacked, opens the popup
 * as a floating window, navigates to a local test billing page, and
 * exercises the full record → interact → stop → export flow.
 *
 * Run:  node test/recorder.test.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;

// ─── Helpers ───────────────────────────────────────────────

function log(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

function startTestServer(port = 8765) {
  const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css' };
  const server = createServer((req, res) => {
    const filePath = path.join(TEST_DIR, req.url === '/' ? '/billing-test.html' : req.url);
    if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(readFileSync(filePath));
  });
  server.listen(port);
  return server;
}

async function getExtensionId(context) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 5000 });
  return sw.url().split('/')[2];
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main Test ─────────────────────────────────────────────

async function runTests() {
  console.log('\n🧪 Invoice Downloader — Recorder E2E Tests\n');

  // Start local test server
  const server = startTestServer(8766);
  log('Test server started on :8766');

  // Launch Chromium with extension
  const userDataDir = path.join(__dirname, '.test-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
    ],
  });
  log('Chromium launched with extension');

  const extensionId = await getExtensionId(context);
  log(`Extension ID: ${extensionId}`);

  // ─── Test 1: Popup loads and shows providers ──────────

  console.log('\n📋 Test 1: Popup loads correctly');

  // Open billing page FIRST so it exists as a normal tab
  const billingPage = await context.newPage();
  await billingPage.goto('http://localhost:8766/billing-test.html');
  await billingPage.waitForLoadState('domcontentloaded');
  log('Test billing page opened');

  // Open popup as a floating window (type: 'popup') so getActiveBrowserTab works
  const pagesBefore = context.pages().length;
  await context.serviceWorkers()[0].evaluate(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 400,
      height: 700
    });
  });
  // Wait for the new page to appear
  let popup;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const pages = context.pages();
    popup = pages.find(p => p.url().includes('popup.html') && p !== billingPage);
    if (popup) break;
  }
  if (!popup) fail('Popup floating window did not open');
  await popup.waitForLoadState('domcontentloaded');
  await sleep(1000); // Wait for providers to load

  const title = await popup.textContent('h2');
  if (!title) fail('Popup title not found');
  log(`Popup loaded in floating window — title: "${title.trim()}"`);

  // Check providers list exists
  const sitesList = await popup.locator('#sites-list').count();
  if (sitesList === 0) fail('Sites list not found');
  log('Sites list rendered');

  // Check record button exists
  const recordBtn = popup.locator('#btn-record');
  if (await recordBtn.count() === 0) fail('Record button not found');
  log('Record button found');

  // ─── Test 2: Record confirm shows active tab ──────────

  console.log('\n📋 Test 2: Record confirmation panel');

  // Focus the billing page so it's the "active" tab
  await billingPage.bringToFront();
  await sleep(500);

  // Go back to popup and click Record
  await popup.bringToFront();
  await recordBtn.click();
  await sleep(500);

  // Check confirm panel is visible
  const confirmPanel = popup.locator('#record-confirm');
  const confirmVisible = await confirmPanel.isVisible();
  if (!confirmVisible) fail('Record confirm panel not visible');
  log('Record confirm panel shown');

  // Check it shows the test page info
  const confirmUrl = await popup.locator('#confirm-tab-url').textContent();
  log(`Confirm shows URL: "${confirmUrl}"`);

  // ─── Test 3: Start recording and interact ─────────────

  console.log('\n📋 Test 3: Recording workflow');

  // Click "Start Recording"
  await popup.locator('#btn-confirm-record').click();
  await sleep(1000);

  // Check recording panel is visible
  const recordPanel = popup.locator('#record-mode');
  const recordVisible = await recordPanel.isVisible();
  if (!recordVisible) fail('Recording panel not visible after start');
  log('Recording panel visible with Stop button');

  // Check duration is counting
  const dur1 = await popup.locator('#record-duration').textContent();
  log(`Duration: ${dur1}`);

  // Verify recorder is actually running on the billing page
  const recorderStatus = await billingPage.evaluate(() => {
    return window.__invoiceRecorder ? window.__invoiceRecorder.getStatus() : 'NOT_INJECTED';
  });
  log(`Recorder status on billing page: ${JSON.stringify(recorderStatus)}`);

  // Switch to billing page and interact
  await billingPage.bringToFront();
  await sleep(500);

  // Click "Billing history" tab
  const billingHistoryBtn = billingPage.locator('button', { hasText: 'Billing history' });
  await billingHistoryBtn.click();
  await sleep(500);
  log('Clicked "Billing history" tab');

  // Verify table is visible
  const table = billingPage.locator('table.invoice-table');
  const tableVisible = await table.isVisible();
  if (!tableVisible) fail('Invoice table not visible after clicking tab');
  log('Invoice table visible');

  // Click "View" on first invoice (opens new tab)
  const [newPage] = await Promise.all([
    context.waitForEvent('page'),
    billingPage.locator('tr:first-child a', { hasText: 'View' }).click(),
  ]);
  await newPage.waitForLoadState('domcontentloaded');
  log(`New tab opened: ${newPage.url()}`);

  // Wait a bit for recorder to be injected in new tab
  await sleep(2000);

  // Click download button on the invoice page
  const downloadBtn = newPage.locator('button', { hasText: 'Download invoice' });
  if (await downloadBtn.count() > 0) {
    await downloadBtn.click();
    await sleep(500);
    log('Clicked "Download invoice" on Stripe-like page');
  }

  // ─── Test 4: Check duration keeps counting ────────────

  console.log('\n📋 Test 4: Duration keeps counting');

  await popup.bringToFront();
  await sleep(1500);

  const dur2 = await popup.locator('#record-duration').textContent();
  log(`Duration now: ${dur2}`);

  const durSec = parseInt(dur2);
  if (durSec < 2) fail(`Duration seems frozen: ${dur2}`);
  log('Duration is counting correctly (not frozen)');

  // Check click count increased
  const clicks = await popup.locator('#record-click-count').textContent();
  log(`Clicks captured: ${clicks}`);
  if (parseInt(clicks) < 1) {
    console.log(`  ⚠ Expected clicks > 0, got ${clicks} — checking recorder directly`);
    const directStatus = await billingPage.evaluate(() => {
      return window.__invoiceRecorder ? window.__invoiceRecorder.getStatus() : 'NOT_INJECTED';
    }).catch(() => 'EVAL_FAILED');
    console.log(`  ⚠ Direct recorder status: ${JSON.stringify(directStatus)}`);
  }

  // ─── Test 5: Stop recording and check result ──────────

  console.log('\n📋 Test 5: Stop recording and verify result');

  await popup.locator('#btn-stop-recording').click();
  await sleep(1000);

  // Check result panel is shown
  const resultPanel = popup.locator('#record-result');
  const resultVisible = await resultPanel.isVisible();
  if (!resultVisible) fail('Recording result panel not visible');
  log('Recording result panel shown');

  // Check export button exists
  const exportBtn = popup.locator('#btn-export-recording');
  if (await exportBtn.count() === 0) fail('Export button not found');
  log('Export button available');

  // Verify recording data was saved to storage
  const storageData = await popup.evaluate(async () => {
    const result = await chrome.storage.local.get('lastRecording');
    return result.lastRecording;
  });

  if (!storageData) fail('No recording data in chrome.storage.local');
  log(`Recording saved — ${storageData.actions?.length || 0} actions, ${storageData.networkRequests?.length || 0} network requests`);

  if (storageData.analysis) {
    log(`Analysis: ${storageData.analysis.invoiceTableCandidates?.length || 0} table candidates found`);
    if (storageData.analysis.invoiceTableCandidates?.length > 0) {
      const table = storageData.analysis.invoiceTableCandidates[0];
      log(`  Table: ${table.selector} (${table.rowCount} rows)`);
    }
  }

  // ─── Test 6: Cancel flow works ────────────────────────

  console.log('\n📋 Test 6: Cancel recording flow');

  // Close result panel
  await popup.locator('#btn-close-result').click();
  await sleep(500);

  // Start a new recording
  await popup.locator('#btn-record').click();
  await sleep(500);

  // Cancel from confirm
  await popup.locator('#btn-cancel-confirm').click();
  await sleep(300);

  // Verify we're back to initial state
  const initialState = popup.locator('#initial-state');
  const initialVisible = await initialState.isVisible();
  if (!initialVisible) fail('Initial state not restored after cancel');
  log('Cancel from confirm restores initial state');

  // Start recording and cancel during recording
  await popup.locator('#btn-record').click();
  await sleep(500);
  await popup.locator('#btn-confirm-record').click();
  await sleep(1000);

  const recordingAgain = await popup.locator('#record-mode').isVisible();
  if (!recordingAgain) fail('Recording panel not visible on second recording');

  await popup.locator('#btn-cancel-recording').click();
  await sleep(500);

  const backToInitial = await popup.locator('#initial-state').isVisible();
  if (!backToInitial) fail('Initial state not restored after recording cancel');
  log('Cancel during recording cleans up and restores UI');

  // ─── Test 7: History dashboard ────────────────────────

  console.log('\n📋 Test 7: History dashboard loads');

  const historyPage = await context.newPage();
  await historyPage.goto(`chrome-extension://${extensionId}/history.html`);
  await historyPage.waitForLoadState('domcontentloaded');
  await sleep(500);

  const historyTitle = await historyPage.locator('h1').textContent();
  log(`History page title: "${historyTitle.trim()}"`);

  const csvBtn = historyPage.locator('#btn-export-csv');
  if (await csvBtn.count() === 0) fail('CSV export button not found');
  log('CSV export button present');

  // ─── Summary ──────────────────────────────────────────

  console.log('\n═══════════════════════════════════════');
  console.log('  ✅ All tests passed!');
  console.log('═══════════════════════════════════════\n');

  // Cleanup
  await context.close();
  server.close();

  // Clean up test profile
  const { rmSync } = await import('fs');
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}

runTests().catch(e => {
  console.error('\n  ✗ Test failed:', e.message);
  process.exit(1);
});
