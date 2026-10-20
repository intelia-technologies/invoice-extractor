/**
 * Playwright behavioral regression tests for provider billing extraction.
 *
 * Exercises real loaded extension popup global functions and engine/utils
 * on synthetic billing DOM pages served via local HTTP server.
 *
 * Run:  node test/provider-billing.test.mjs
 */

import { chromium } from 'playwright';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..');

// --- Test Helpers ------------------------------------------

let totalChecks = 0;

function log(msg) {
  totalChecks++;
  console.log(`  ok - ${msg}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// --- Synthetic Server --------------------------------------

function startTestServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/utils.js') {
        const file = readFileSync(path.join(EXTENSION_PATH, 'utils.js'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(file);
        return;
      }

      if (pathname === '/engine.js') {
        const file = readFileSync(path.join(EXTENSION_PATH, 'engine.js'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(file);
        return;
      }

      if (pathname === '/enterprise-billing') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>GitHub Enterprise Billing</title>
</head>
<body>
  <payment-history>
    <ul class="Box">
      <li class="Box-row box-row">
        <span class="date"><time datetime="2026-08-15">2026-08-15</time></span>
        <span class="amount">$250.00</span>
        <invoice-download data-url="/enterprises/octocorp/invoices/inv-aug-2026.pdf"></invoice-download>
      </li>
      <li class="Box-row box-row">
        <span class="date"><time datetime="2026-07-15">2026-07-15</time></span>
        <span class="amount">$210.00</span>
        <invoice-download data-url="/enterprises/octocorp/invoices/inv-jul-2026.pdf"></invoice-download>
      </li>
    </ul>
  </payment-history>
  <script src="/utils.js"></script>
  <script src="/engine.js"></script>
</body>
</html>`);
        return;
      }

      if (pathname === '/twilio-billing') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Twilio Billing</title>
</head>
<body>
  <table class="border-collapse text-left">
    <thead>
      <tr>
        <th>Date</th>
        <th>Description</th>
        <th>Type</th>
        <th>Status</th>
        <th>Qty</th>
        <th>Amount</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>September 2026</td>
        <td>Twilio Voice Usage</td>
        <td>Usage Charges</td>
        <td>Completed</td>
        <td>1</td>
        <td>$6.65</td>
        <td><button aria-label="Open menu">Actions</button></td>
      </tr>
      <tr>
        <td>August 2026</td>
        <td>Twilio Voice Usage</td>
        <td>Usage Charges</td>
        <td>Completed</td>
        <td>1</td>
        <td>$12.30</td>
        <td><button aria-label="Open menu">Actions</button></td>
      </tr>
    </tbody>
  </table>
  <script src="/utils.js"></script>
  <script src="/engine.js"></script>
</body>
</html>`);
        return;
      }

      if (pathname === '/coderabbit-billing') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CodeRabbit Billing</title>
</head>
<body>
  <table class="caption-bottom">
    <thead>
      <tr>
        <th>Invoice</th>
        <th>Date</th>
        <th>Status</th>
        <th>Plan</th>
        <th>Seats</th>
        <th>Amount</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>INV-CR-2026-001</td>
        <td>2026-09-15</td>
        <td>Paid</td>
        <td>Team Plan</td>
        <td>5</td>
        <td>$49.00</td>
        <td><button aria-label="Download invoice" title="Download invoice">Download</button></td>
      </tr>
      <tr>
        <td>INV-CR-2026-PENDING</td>
        <td>2026-09-20</td>
        <td>Processing</td>
        <td>Team Plan</td>
        <td>5</td>
        <td>$49.00</td>
        <td><span>Processing</span></td>
      </tr>
      <tr>
        <td>INV-CR-2026-000</td>
        <td>2026-08-15</td>
        <td>Paid</td>
        <td>Team Plan</td>
        <td>5</td>
        <td>$49.00</td>
        <td><button aria-label="Download invoice" title="Download invoice">Download</button></td>
      </tr>
    </tbody>
  </table>
  <script src="/utils.js"></script>
  <script src="/engine.js"></script>
</body>
</html>`);
        return;
      }

      if (pathname === '/openai-billing') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OpenAI Billing</title>
</head>
<body>
  <table class="tbl billing-history-table tbl-compact">
    <tbody id="invoice-rows">
      <tr>
        <td>inv-oai-001</td>
        <td>Paid</td>
        <td>$15.00</td>
        <td>2026-09-01</td>
        <td><a href="https://invoice.stripe.com/inv-oai-001">View</a></td>
      </tr>
      <tr>
        <td>inv-oai-002</td>
        <td>Paid</td>
        <td>$20.00</td>
        <td>2026-09-02</td>
        <td><a href="https://invoice.stripe.com/inv-oai-002">View</a></td>
      </tr>
    </tbody>
  </table>
  <div class="pagination">
    <button id="btn-next" aria-label="Next invoices page">Next page</button>
    <button id="btn-next-alt" aria-label="Next page">Next page</button>
  </div>
  <script>
    let currentPage = 1;
    const btn = document.getElementById('btn-next');
    const btnAlt = document.getElementById('btn-next-alt');
    const tbody = document.getElementById('invoice-rows');
    function advancePage() {
      if (currentPage === 1) {
        currentPage = 2;
        tbody.innerHTML = \`
          <tr>
            <td>inv-oai-003</td>
            <td>Paid</td>
            <td>$35.00</td>
            <td>2026-09-03</td>
            <td><a href="https://invoice.stripe.com/inv-oai-003">View</a></td>
          </tr>
        \`;
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        btnAlt.disabled = true;
        btnAlt.setAttribute('aria-disabled', 'true');
      }
    }
    btn.addEventListener('click', advancePage);
    btnAlt.addEventListener('click', advancePage);
  </script>
  <script src="/utils.js"></script>
  <script src="/engine.js"></script>
</body>
</html>`);
        return;
      }

      if (pathname === '/google-cloud-billing') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google Cloud Billing</title>
</head>
<body>
  <table class="b3id-widget-table b3-widget-table">
    <tbody>
      <tr class="b3id-widget-table-data-row clickable">
        <td><div class="jfk-checkbox b3id-checkbox"></div></td>
        <td>30 de septiembre de 2026</td>
        <td>Factura</td>
        <td>5714599192</td>
        <td>EUR 24.89</td>
      </tr>
      <tr class="b3id-widget-table-data-row">
        <td colspan="5">Filas por pagina: 1-10 de 10</td>
      </tr>
    </tbody>
  </table>
  <script src="/utils.js"></script>
  <script src="/engine.js"></script>
</body>
</html>`);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

// --- Main Test Runner --------------------------------------

async function runTests() {
  console.log('\nInvoice Downloader - Provider Billing Regression Tests\n');

  let context;
  let server;
  let tmpDir;

  try {
    // 1. Start local synthetic server
    server = await startTestServer();
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`  Synthetic test server running on ${baseUrl}`);

    // 2. Launch Chromium with persistent context in temporary directory
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pw-billing-test-'));
    const headless = process.env.HEADLESS === 'true' || process.env.CI === 'true';
    const args = [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-default-apps',
    ];
    if (headless) {
      args.push('--headless=new');
    }

    context = await chromium.launchPersistentContext(tmpDir, {
      headless: false,
      args,
    });

    // 3. Obtain extension service worker & extension ID
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    }
    const extensionId = sw.url().split('/')[2];
    assert(extensionId, 'Extension ID should be defined from service worker');

    // 4. Open extension popup window
    await sw.evaluate(() => {
      chrome.windows.create({
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 440,
        height: 780,
      });
    });

    let popup;
    const popupTimeout = Date.now() + 10000;
    while (!popup && Date.now() < popupTimeout) {
      popup = context.pages().find(p => p.url().includes('popup.html'));
      if (popup) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert(popup, 'Popup floating window failed to open within timeout');

    await popup.waitForLoadState('domcontentloaded');

    // Wait for popup.js init() to finish loading providers
    await popup.waitForFunction(() => {
      return typeof detectProvider === 'function' && Array.isArray(providers) && providers.length > 0;
    }, { timeout: 10000 });

    // --- Test Group 1: Organization vs Enterprise Detection & URL Validation ---
    console.log('\nGroup 1: Organization vs Enterprise Detection & URL Validation\n');

    // 1a: GitHub Organization detection
    const orgResult = await popup.evaluate(() => detectProvider('https://github.com/organizations/octocorp/billing/history'));
    assert(orgResult?.id === 'github', `Expected detectProvider to return 'github', got: '${orgResult?.id}'`);
    log('GitHub organization detected from /organizations/... URL');

    // 1b: GitHub Enterprise detection
    const entResult = await popup.evaluate(() => detectProvider('https://github.com/enterprises/octo-enterprise/billing/payment_history'));
    assert(entResult?.id === 'github-enterprise', `Expected detectProvider to return 'github-enterprise', got: '${entResult?.id}'`);
    log('GitHub Enterprise detected from /enterprises/... URL');

    // 1c: Distinguish org vs enterprise (no cross-matching)
    assert(orgResult?.id !== 'github-enterprise', 'Organization URL must not match enterprise');
    assert(entResult?.id !== 'github', 'Enterprise URL must not match organization');
    log('Distinguishes GitHub organization from enterprise without cross-matching');

    // 1d: Lookalike host rejection
    const lookalikes = [
      'https://github.com.evil.com/organizations/octocorp/billing/history',
      'https://fakegithub.com/organizations/octocorp/billing/history',
      'https://github.com.attacker.org/enterprises/octo-enterprise/billing/payment_history',
      'https://not-github.com/enterprises/octo-enterprise/billing/payment_history',
      'https://attacker-github.com/billing'
    ];
    for (const fakeUrl of lookalikes) {
      const res = await popup.evaluate((u) => detectProvider(u), fakeUrl);
      assert(res === null, `Expected lookalike host ${fakeUrl} to be rejected (null), got: ${res?.id}`);
    }
    log('Rejects lookalike hosts (github.com.evil.com, fakegithub.com, attacker subdomains)');

    // 1e: Malformed URL handling
    const malformedUrls = ['not-a-valid-url', '', 'http://', '://invalid-scheme', null, undefined];
    for (const badUrl of malformedUrls) {
      const res = await popup.evaluate((u) => detectProvider(u), badUrl);
      assert(res === null, `Expected malformed URL ${JSON.stringify(badUrl)} to return null, got: ${res?.id}`);
    }
    log('Handles malformed URLs gracefully without throwing exceptions');

    // 1f: Unrelated host rejection
    const unrelatedRes = await popup.evaluate(() => detectProvider('https://example.com/billing'));
    assert(unrelatedRes === null, `Expected unrelated host to return null, got: ${unrelatedRes?.id}`);
    log('Rejects unrelated hosts (e.g. example.com)');

    // --- Test Group 2: Enterprise Row Extraction & Filtering ---
    console.log('\nGroup 2: GitHub Enterprise Invoice Extraction & Filtering\n');

    const ghEnterpriseProvider = await popup.evaluate(() => providers.find(p => p.id === 'github-enterprise'));
    assert(ghEnterpriseProvider, 'github-enterprise provider must be loaded in extension');

    const billingPage = await context.newPage();
    await billingPage.goto(`${baseUrl}/enterprise-billing`);
    await billingPage.waitForFunction(() => window.__invoiceEngine != null);

    // 2a: Unfiltered extraction - absolute URL, date, amount, filename
    const basicExtract = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, {});
    }, ghEnterpriseProvider);

    assert(basicExtract.rowsFound === 2, `Expected 2 rows found, got ${basicExtract.rowsFound}`);
    assert(basicExtract.invoices.length === 2, `Expected 2 invoices extracted, got ${basicExtract.invoices.length}`);

    const inv1 = basicExtract.invoices[0];
    assert(inv1.date === '2026-08-15', `Expected date '2026-08-15', got '${inv1.date}'`);
    assert(inv1.amount === '$250.00', `Expected amount '$250.00', got '${inv1.amount}'`);
    assert(
      inv1.downloadUrl.startsWith('http://') || inv1.downloadUrl.startsWith('https://'),
      `Download URL must be absolute, got: ${inv1.downloadUrl}`
    );
    assert(
      !inv1.downloadUrl.startsWith('/enterprises/'),
      `Download URL must not remain relative, got: ${inv1.downloadUrl}`
    );
    assert(
      inv1.downloadUrl.endsWith('/enterprises/octocorp/invoices/inv-aug-2026.pdf'),
      `Download URL path must match source href, got: ${inv1.downloadUrl}`
    );
    assert(
      inv1.filename === 'GitHubEnterprise_Invoice_2026-08-15.pdf',
      `Filename must match template, got: ${inv1.filename}`
    );
    log('Extracts Enterprise rows with absolute URL, date (2026-08-15), amount ($250.00), and filename');

    // 2b: Date filtering respects sinceDate
    const dateFiltered = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, { sinceDate: '2026-08-01' });
    }, ghEnterpriseProvider);

    assert(dateFiltered.rowsFilteredByDate === 1, `Expected 1 row filtered by date, got ${dateFiltered.rowsFilteredByDate}`);
    assert(dateFiltered.invoices.length === 1, `Expected 1 invoice remaining, got ${dateFiltered.invoices.length}`);
    assert(dateFiltered.invoices[0].date === '2026-08-15', `Expected remaining invoice to be August, got '${dateFiltered.invoices[0]?.date}'`);
    log('Respects date filter (sinceDate: 2026-08-01 excludes older July invoice)');

    // 2c: previousDownloads deduplication
    const dedupExtract = await billingPage.evaluate(({ prov, downloadedUrl }) => {
      return window.__invoiceEngine.extractRows(prov, { previousDownloads: [downloadedUrl] });
    }, { prov: ghEnterpriseProvider, downloadedUrl: inv1.downloadUrl });

    assert(dedupExtract.rowsDeduped === 1, `Expected 1 row deduped, got ${dedupExtract.rowsDeduped}`);
    assert(dedupExtract.invoices.length === 1, `Expected 1 invoice remaining, got ${dedupExtract.invoices.length}`);
    assert(dedupExtract.invoices[0].date === '2026-07-15', `Expected remaining invoice to be July, got '${dedupExtract.invoices[0]?.date}'`);
    log('Respects previousDownloads (skips already downloaded invoice URL)');

    // --- Test Group 3: Twilio Extraction ---
    console.log('\nGroup 3: Twilio Extraction (September 2026 and $6.65, not amount-as-date)\n');

    const twilioProvider = await popup.evaluate(() => providers.find(p => p.id === 'twilio'));
    assert(twilioProvider, 'twilio provider must be loaded in extension');

    await billingPage.goto(`${baseUrl}/twilio-billing`);
    await billingPage.waitForFunction(() => window.__invoiceEngine != null);

    const twilioExtract = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, {});
    }, twilioProvider);

    assert(twilioExtract.invoices.length >= 1, `Expected at least 1 Twilio invoice, got ${twilioExtract.invoices.length}`);
    const twInv = twilioExtract.invoices[0];

    assert(twInv.date === 'September 2026', `Expected date 'September 2026', got '${twInv.date}'`);
    assert(twInv.amount === '$6.65', `Expected amount '$6.65', got '${twInv.amount}'`);

    // Explicit check against amount-as-date bug
    assert(!twInv.date.includes('$'), `Date must not be an amount ($), got: '${twInv.date}'`);
    assert(!twInv.date.includes('6.65'), `Date must not contain amount value 6.65, got: '${twInv.date}'`);
    assert(twInv.date !== twInv.amount, `Date must not equal amount ('${twInv.date}' vs '${twInv.amount}')`);
    log('Twilio extracts September 2026 from td:nth-child(1) and $6.65 from td:nth-child(6), avoiding amount-as-date');

    // Date filtering with "Month YYYY" format
    const twilioFiltered = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, { sinceDate: '2026-09-01' });
    }, twilioProvider);

    assert(twilioFiltered.rowsFilteredByDate === 1, `Expected 1 Twilio row filtered, got ${twilioFiltered.rowsFilteredByDate}`);
    assert(twilioFiltered.invoices.length === 1, `Expected 1 Twilio invoice retained, got ${twilioFiltered.invoices.length}`);
    assert(twilioFiltered.invoices[0].date === 'September 2026', 'September 2026 retained after filtering August');
    log('Twilio date filtering correctly parses Month YYYY format');

    // --- Test Group 4: CodeRabbit Semantic Download Row & Button Extraction ---
    console.log('\nGroup 4: CodeRabbit Semantic Download Row & Button Extraction\n');

    const crProvider = await popup.evaluate(() => providers.find(p => p.id === 'coderabbit'));
    assert(crProvider, 'coderabbit provider must be loaded in extension');

    await billingPage.goto(`${baseUrl}/coderabbit-billing`);
    await billingPage.waitForFunction(() => window.__invoiceEngine != null);

    const crExtract = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, {});
    }, crProvider);

    assert(crExtract.invoices.length >= 1, `Expected CodeRabbit invoices, got ${crExtract.invoices.length}`);
    const crInv = crExtract.invoices[0];

    assert(crInv.id === 'INV-CR-2026-001', `Expected invoice id 'INV-CR-2026-001', got '${crInv.id}'`);
    assert(crInv.date === '2026-09-15', `Expected date '2026-09-15', got '${crInv.date}'`);
    assert(crInv.amount === '$49.00', `Expected amount '$49.00', got '${crInv.amount}'`);
    log('CodeRabbit extracts proper invoice id, date, and amount');

    // Verify non-downloadable rows (e.g. pending without download button) are excluded
    const hasPending = crExtract.invoices.some(inv => inv.id === 'INV-CR-2026-PENDING');
    assert(!hasPending, 'Pending row without Download Invoice button must not be extracted');
    log('Rows lacking semantic Download Invoice button are excluded');

    // Verify semantic download button exists in the row and has proper aria-label
    const btnInfo = await billingPage.evaluate((prov) => {
      const row = document.querySelector(prov.extract.rows);
      const btn = row?.querySelector("button[aria-label='Download invoice' i], button[aria-label='Download Invoice']");
      return {
        exists: !!btn,
        ariaLabel: btn?.getAttribute('aria-label')
      };
    }, crProvider);
    assert(btnInfo.exists, 'Download button with semantic aria-label must exist in row');
    assert(/download invoice/i.test(btnInfo.ariaLabel), `Button aria-label must match 'Download invoice', got: '${btnInfo.ariaLabel}'`);
    log('Semantic download button with aria-label="Download invoice" located in row');

    // Verify billingUrl contract
    assert(
      crProvider.billingUrl.includes('/settings/billing?tab=invoices'),
      `CodeRabbit billingUrl must point to /settings/billing?tab=invoices, got: ${crProvider.billingUrl}`
    );
    log('CodeRabbit billingUrl matches /settings/billing?tab=invoices');

    // --- Test Group 5: OpenAI Configured Click-Next Pagination ---
    console.log('\nGroup 5: OpenAI Configured Click-Next Pagination\n');

    const openaiProvider = await popup.evaluate(() => providers.find(p => p.id === 'openai'));
    assert(openaiProvider, 'openai provider must be loaded in extension');

    await billingPage.goto(`${baseUrl}/openai-billing`);
    await billingPage.waitForFunction(() => window.__invoiceEngine != null);

    const paginationConfig = {
      ...(openaiProvider.extract?.pagination || {
        type: 'click-next',
        nextSelector: "button[aria-label='Next invoices page'], button[aria-label='Next page']"
      }),
      wait: 50 // Keep test execution fast
    };

    assert(paginationConfig.type === 'click-next', `Expected pagination type 'click-next', got '${paginationConfig.type}'`);
    assert(
      paginationConfig.nextSelector.includes("button[aria-label='Next page']") ||
      paginationConfig.nextSelector.includes("button[aria-label='Next invoices page']"),
      `Expected nextSelector to target next button, got '${paginationConfig.nextSelector}'`
    );

    // 5a: Page 1 rows
    const oaiPage1 = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, {});
    }, openaiProvider);
    assert(oaiPage1.invoices.length === 2, `Expected 2 invoices on page 1, got ${oaiPage1.invoices.length}`);
    assert(oaiPage1.invoices[0].id === 'inv-oai-001', `Expected inv-oai-001, got ${oaiPage1.invoices[0].id}`);
    assert(oaiPage1.invoices[1].id === 'inv-oai-002', `Expected inv-oai-002, got ${oaiPage1.invoices[1].id}`);
    log('Initial page 1 rows extracted correctly (inv-oai-001, inv-oai-002)');

    // 5b: Click next advances rows
    const clickNextResult = await billingPage.evaluate((cfg) => {
      return window.__invoiceEngine.clickNext(cfg);
    }, paginationConfig);
    assert(clickNextResult.clicked === true, `Expected clickNext to return { clicked: true }, got: ${JSON.stringify(clickNextResult)}`);

    const oaiPage2 = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, {});
    }, openaiProvider);
    assert(oaiPage2.invoices.length === 1, `Expected 1 invoice on page 2, got ${oaiPage2.invoices.length}`);
    assert(oaiPage2.invoices[0].id === 'inv-oai-003', `Expected inv-oai-003 on page 2, got ${oaiPage2.invoices[0].id}`);
    log('Configured click-next advances rows to page 2 (inv-oai-003)');

    // 5c: Disabled next does not advance
    const clickDisabledResult = await billingPage.evaluate((cfg) => {
      return window.__invoiceEngine.clickNext(cfg);
    }, paginationConfig);
    assert(
      clickDisabledResult.clicked === false,
      `Expected clickNext on disabled button to return { clicked: false }, got: ${JSON.stringify(clickDisabledResult)}`
    );

    const oaiPage2Repeat = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, {});
    }, openaiProvider);
    assert(oaiPage2Repeat.invoices.length === 1, 'Rows did not advance after disabled click');
    assert(oaiPage2Repeat.invoices[0].id === 'inv-oai-003', 'Page content remains unchanged on last page');
    log('Disabled next button does not advance (clicked: false, rows preserved)');

    // --- Test Group 6: Google Workspace URL & Authuser Routing ---
    console.log('\nGroup 6: Google Workspace URL & Authuser Routing\n');

    const workspaceProvider = await popup.evaluate(() => providers.find(p => p.id === 'google-workspace'));
    assert(workspaceProvider, 'google-workspace provider must be loaded in extension');

    const resolvedWorkspaceUrl = await popup.evaluate((prov) => {
      const origConfig = providerConfigs[prov.id];
      try {
        providerConfigs[prov.id] = {
          email: 'admin@company.com',
          accountId: '012345-6789AB-CDEF01'
        };
        return resolveBillingUrl(prov);
      } finally {
        if (origConfig !== undefined) {
          providerConfigs[prov.id] = origConfig;
        } else {
          delete providerConfigs[prov.id];
        }
      }
    }, workspaceProvider);

    const parsedWorkspaceUrl = new URL(resolvedWorkspaceUrl);
    assert(
      parsedWorkspaceUrl.pathname === '/ac/billing/accounts/012345-6789AB-CDEF01/transactions',
      `Expected pathname '/ac/billing/accounts/012345-6789AB-CDEF01/transactions', got '${parsedWorkspaceUrl.pathname}'`
    );
    assert(
      parsedWorkspaceUrl.searchParams.get('authuser') === 'admin@company.com',
      `Expected authuser query param 'admin@company.com', got '${parsedWorkspaceUrl.searchParams.get('authuser')}'`
    );
    assert(
      !parsedWorkspaceUrl.pathname.includes('/u/1') && !parsedWorkspaceUrl.pathname.includes('/u/0'),
      'Resolved pathname must not hardcode /u/1 or /u/0'
    );
    log('Google Workspace billingUrl resolves via resolveBillingUrl with configured accountId and authuser email');

    // --- Test Group 7: Google Cloud Invoice Extraction & Paginator Exclusion ---
    console.log('\nGroup 7: Google Cloud Invoice Extraction & Paginator Exclusion\n');

    const gcProvider = await popup.evaluate(() => providers.find(p => p.id === 'google-cloud'));
    assert(gcProvider, 'google-cloud provider must be loaded in extension');

    await billingPage.goto(`${baseUrl}/google-cloud-billing`);
    await billingPage.waitForFunction(() => window.__invoiceEngine != null);

    const gcExtract = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, {});
    }, gcProvider);

    assert(gcExtract.invoices.length === 1, `Expected exactly 1 invoice (excluding footer row), got: ${gcExtract.invoices.length}`);
    const gcInv = gcExtract.invoices[0];

    assert(gcInv.date === '30 de septiembre de 2026', `Expected date '30 de septiembre de 2026', got: '${gcInv.date}'`);
    assert(gcInv.type === 'Factura', `Expected type 'Factura', got: '${gcInv.type}'`);
    assert(gcInv.id === '5714599192', `Expected id '5714599192', got: '${gcInv.id}'`);
    assert(gcInv.amount === 'EUR 24.89', `Expected amount 'EUR 24.89', got: '${gcInv.amount}'`);
    log('Google Cloud extracts clickable invoice (date: 30 de septiembre de 2026, type: Factura, id: 5714599192, amount: EUR 24.89)');

    // Verify footer row (Filas por pagina...) without .clickable is excluded
    assert(gcExtract.rowsFound === 1, `Expected 1 clickable row found, got ${gcExtract.rowsFound}`);
    log('Google Cloud excludes non-clickable footer/paginator row from extraction');

    // Date filtering with Spanish date '30 de septiembre de 2026'
    const gcFiltered = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, { sinceDate: '2026-09-01' });
    }, gcProvider);
    assert(gcFiltered.invoices.length === 1, 'Invoice on 30 de septiembre de 2026 passes sinceDate: 2026-09-01');

    const gcFilteredOut = await billingPage.evaluate((prov) => {
      return window.__invoiceEngine.extractRows(prov, { sinceDate: '2026-10-01' });
    }, gcProvider);
    assert(gcFilteredOut.invoices.length === 0, 'Invoice filtered out when sinceDate is 2026-10-01');
    assert(gcFilteredOut.rowsFilteredByDate === 1, 'Expected 1 row filtered by date');
    log('Google Cloud date filtering correctly parses Spanish date "30 de septiembre de 2026"');

    // --- Test Group 8: Chrome-Download Lifecycle & Mocked Behavioral Tests ---
    console.log('\nGroup 8: Chrome-Download Lifecycle & Mocked Behavioral Tests\n');

    await popup.evaluate(async () => {
      // Save originals
      const origTabsCreate = chrome.tabs.create;
      const origTabsRemove = chrome.tabs.remove;
      const origScriptingExecuteScript = chrome.scripting?.executeScript;
      const origDownloadsAddListener = chrome.downloads?.onCreated?.addListener;
      const origDownloadsRemoveListener = chrome.downloads?.onCreated?.removeListener;
      const origDownloadsDownload = chrome.downloads?.download;
      const origWaitForTabLoad = window.waitForTabLoad;

      function assertInPopup(cond, msg) {
        if (!cond) throw new Error(msg);
      }

      try {
        // -------------------------------------------------------------
        // 8a: Early download event during postLoadClick execution
        //     - First emits unrelated download item (must be ignored, not set _downloadId)
        //     - Then emits matching item with url === invoice.downloadUrl (accepted, sets _downloadId)
        //     - Avoids direct-download fallback, cleans listener and closes tab
        // -------------------------------------------------------------
        {
          const listeners = new Set();
          const closedTabs = [];
          let fallbackDownloadCalled = false;

          chrome.downloads = chrome.downloads || {};
          chrome.downloads.onCreated = chrome.downloads.onCreated || {};
          chrome.downloads.onCreated.addListener = (fn) => listeners.add(fn);
          chrome.downloads.onCreated.removeListener = (fn) => listeners.delete(fn);
          chrome.downloads.download = async () => {
            fallbackDownloadCalled = true;
            return 999;
          };

          chrome.tabs.create = async () => ({ id: 501 });
          chrome.tabs.remove = async (tabId) => { closedTabs.push(tabId); };
          window.waitForTabLoad = async () => {};

          const invoice = {
            id: 'early-dl-001',
            downloadUrl: 'https://invoice.stripe.com/inv-early-001.pdf',
            filename: 'Mock_Invoice_early-dl-001.pdf'
          };

          // Mock executeScript: emits unrelated download first, then matching download BEFORE resolving
          chrome.scripting = chrome.scripting || {};
          chrome.scripting.executeScript = async () => {
            // 1. Emit unrelated download (different URL and different referrer)
            for (const fn of Array.from(listeners)) {
              fn({
                id: 111,
                url: 'https://completely-unrelated-domain.com/asset.zip',
                referrer: 'https://completely-unrelated-domain.com/',
                filename: 'asset.zip'
              });
            }

            // Verify unrelated event did NOT set _downloadId prematurely
            assertInPopup(invoice._downloadId !== 111, 'Unrelated download must not set invoice._downloadId');

            // 2. Emit matching download item with url === invoice.downloadUrl
            for (const fn of Array.from(listeners)) {
              fn({
                id: 777,
                url: invoice.downloadUrl,
                referrer: 'https://invoice.stripe.com/',
                filename: 'invoice.pdf'
              });
            }
            return [{ result: true }];
          };

          const provider = {
            name: 'MockChromeDlEarlyEvent',
            download: {
              method: 'chrome-download',
              postLoadClick: { selector: 'button.download', wait: 0 },
              filenameTemplate: 'Mock_Invoice_{{id}}.pdf'
            }
          };

          const result = await downloadInvoice(1, invoice, provider);

          assertInPopup(result?.success === true, `Expected success: true, got: ${JSON.stringify(result)}`);
          assertInPopup(invoice._downloadId === 777, `Expected _downloadId: 777, got: ${invoice._downloadId}`);
          assertInPopup(fallbackDownloadCalled === false, 'Direct download fallback must not be called when early event caught');
          assertInPopup(listeners.size === 0, `Expected onCreated listener to be cleaned up, remaining: ${listeners.size}`);
          assertInPopup(closedTabs.includes(501), 'Created tab 501 must be closed in finally');
        }

        // -------------------------------------------------------------
        // 8b: Missing button result false must fail and clean listener/tab
        //     (not download raw hosted HTML as PDF)
        // -------------------------------------------------------------
        {
          const listeners = new Set();
          const closedTabs = [];
          let fallbackDownloadCalled = false;

          chrome.downloads.onCreated.addListener = (fn) => listeners.add(fn);
          chrome.downloads.onCreated.removeListener = (fn) => listeners.delete(fn);
          chrome.downloads.download = async () => {
            fallbackDownloadCalled = true;
            return 999;
          };

          chrome.tabs.create = async () => ({ id: 502 });
          chrome.tabs.remove = async (tabId) => { closedTabs.push(tabId); };
          window.waitForTabLoad = async () => {};

          // Missing button: returns [{ result: false }] without emitting download event
          chrome.scripting.executeScript = async () => {
            return [{ result: false }];
          };

          const provider = {
            name: 'MockChromeDlMissingButton',
            download: {
              method: 'chrome-download',
              postLoadClick: { selector: 'button.nonexistent-btn', wait: 0 },
              filenameTemplate: 'Mock_Invoice_{{id}}.pdf'
            }
          };

          const invoice = {
            id: 'missing-btn-002',
            downloadUrl: 'https://example.com/invoices/missing-002',
            filename: 'Mock_Invoice_missing-btn-002.pdf'
          };

          const result = await downloadInvoice(1, invoice, provider);

          assertInPopup(result?.success === false, `Expected failure when postLoadClick button missing, got: ${JSON.stringify(result)}`);
          assertInPopup(fallbackDownloadCalled === false, 'Must not fallback to downloading hosted HTML as PDF when postLoadClick button missing');
          assertInPopup(invoice._downloadId == null, `_downloadId should not be set on failure, got: ${invoice._downloadId}`);
          assertInPopup(listeners.size === 0, `Expected onCreated listener to be cleaned up, remaining: ${listeners.size}`);
          assertInPopup(closedTabs.includes(502), 'Created tab 502 must be closed in finally');
        }

        // -------------------------------------------------------------
        // 8c: Created-tab exception must clean listener and close tab
        // -------------------------------------------------------------
        {
          const listeners = new Set();
          const closedTabs = [];

          chrome.downloads.onCreated.addListener = (fn) => listeners.add(fn);
          chrome.downloads.onCreated.removeListener = (fn) => listeners.delete(fn);
          chrome.downloads.download = async () => 999;

          chrome.tabs.create = async () => ({ id: 503 });
          chrome.tabs.remove = async (tabId) => { closedTabs.push(tabId); };

          // Tab load throws exception (e.g. navigation aborted or crash)
          window.waitForTabLoad = async () => {
            throw new Error('Tab navigation error');
          };

          chrome.scripting.executeScript = async () => [{ result: true }];

          const provider = {
            name: 'MockChromeDlTabError',
            download: {
              method: 'chrome-download',
              postLoadClick: { selector: 'button.download', wait: 0 },
              filenameTemplate: 'Mock_Invoice_{{id}}.pdf'
            }
          };

          const invoice = {
            id: 'tab-err-003',
            downloadUrl: 'https://example.com/invoices/err-003',
            filename: 'Mock_Invoice_tab-err-003.pdf'
          };

          let threw = false;
          let result;
          try {
            result = await downloadInvoice(1, invoice, provider);
          } catch (err) {
            threw = true;
          }

          assertInPopup(threw || result?.success === false, 'Tab exception must result in failure or throw');
          assertInPopup(listeners.size === 0, `Expected onCreated listener to be cleaned up after exception, remaining: ${listeners.size}`);
          assertInPopup(closedTabs.includes(503), 'Created tab 503 must be closed in finally despite exception');
        }
      } finally {
        // Restore all mocked functions
        chrome.tabs.create = origTabsCreate;
        chrome.tabs.remove = origTabsRemove;
        if (origScriptingExecuteScript) {
          chrome.scripting.executeScript = origScriptingExecuteScript;
        }
        if (origDownloadsAddListener) {
          chrome.downloads.onCreated.addListener = origDownloadsAddListener;
        }
        if (origDownloadsRemoveListener) {
          chrome.downloads.onCreated.removeListener = origDownloadsRemoveListener;
        }
        if (origDownloadsDownload) {
          chrome.downloads.download = origDownloadsDownload;
        }
        window.waitForTabLoad = origWaitForTabLoad;
      }
    });

    log('chrome-download: ignores unrelated downloads and captures matching early event during executeScript');
    log('chrome-download: missing button result false fails and cleans up listener/tab without downloading HTML');
    log('chrome-download: created-tab exception cleans up listener and closes tab in finally');

    // --- Test Group 9: OpenAI Organization ID Guard ---
    console.log('\nGroup 9: OpenAI Organization ID Guard\n');

    const orgPage = await context.newPage();
    await orgPage.goto(`${baseUrl}/openai-org-check`);
    await orgPage.setContent('<button aria-haspopup="menu">Intelia Technologies SL Organization</button>');
    const orgTabId = await popup.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(tab => tab.url === url)?.id;
    }, orgPage.url());
    assert(orgTabId != null, 'Organization fixture must have a Chrome tab ID');

    const expectedOrg = 'org-Ie6toKlBIpSMu4XATB0EfQY3';
    const checkOrg = (expected = expectedOrg) => popup.evaluate(async ({ tabId, expected }) => {
      const provider = providers.find(p => p.id === 'openai');
      return verifyOrg(tabId, { ...provider, _configOverrides: { org: expected } });
    }, { tabId: orgTabId, expected });
    const setOrg = value => orgPage.evaluate(value => {
      if (value == null) localStorage.removeItem('oai/activeOrg');
      else localStorage.setItem('oai/activeOrg', value);
    }, value);

    await setOrg(JSON.stringify(expectedOrg));
    assert((await checkOrg()).ok, 'Matching Organization ID must pass despite a different display name');
    log('OpenAI ID configuration accepts the actual active ID rather than comparing the display name');

    await setOrg(JSON.stringify('org-anotherAccount'));
    const wrongOrg = await checkOrg();
    assert(!wrongOrg.ok && wrongOrg.found === 'org-anotherAccount', 'Different ID must block even with the same display name');
    log('OpenAI ID guard rejects another account with an unchanged display name');

    await setOrg(JSON.stringify(expectedOrg));
    assert((await checkOrg()).ok, 'Rechecking after an account switch must use the new active ID');
    assert(!(await checkOrg(expectedOrg.slice(0, -1))).ok, 'A prefix of the ID must not match');
    assert(!(await checkOrg(expectedOrg.toLowerCase())).ok, 'Opaque IDs must be compared case-sensitively');
    log('OpenAI ID guard rereads account switches and requires the entire exact ID');

    await setOrg(expectedOrg);
    assert((await checkOrg()).ok, 'Raw string storage must also identify the active account');
    log('OpenAI ID guard accepts both JSON-encoded and raw storage strings');

    for (const value of [null, 'null', '{}', '123', '" "', '{invalid']) {
      await setOrg(value);
      assert(!(await checkOrg()).ok, `Unavailable or invalid storage ${value} must block downloads`);
    }
    log('OpenAI ID guard fails closed on missing, non-string, empty, or malformed identity');

    assert((await checkOrg('Intelia Technologies SL')).ok, 'Name configuration must retain DOM comparison');
    assert(!(await checkOrg('Another company')).ok, 'Wrong configured name must still be rejected');
    assert((await checkOrg('')).ok, 'An empty configuration must leave the optional check disabled');
    log('OpenAI name configuration remains supported without requiring an ID in storage');

    await orgPage.close();
    assert(!(await checkOrg()).ok, 'An unreadable tab must not allow an ID-configured download');
    log('OpenAI ID guard fails closed if the account cannot be read');

    // --- Test Group 10: Configured Account Tabs and Iframe Readiness ---
    console.log('\nGroup 10: Google Cloud Account Tabs and Iframe Readiness\n');

    const cloudAccounts = ['111111-AAAAAA-BBBBBB', '222222-CCCCCC-DDDDDD'];
    const cloudPages = [];
    for (const account of cloudAccounts) {
      const url = `https://console.cloud.google.com/billing/${account}/invoices`;
      const frameUrl = `https://payments.google.com/payments/readiness-fixture-${account}`;
      await context.route(`${url}*`, route => route.fulfill({
        contentType: 'text/html',
        body: `<iframe src="${frameUrl}"></iframe>`
      }));
      await context.route(frameUrl, route => route.fulfill({
        contentType: 'text/html',
        body: '<table class="b3id-widget-table b3-widget-table"><tbody><tr><td>Invoice</td></tr></tbody></table>'
      }));
      const page = await context.newPage();
      await page.goto(url);
      await page.frameLocator('iframe').locator(gcProvider.readySelector).waitFor();
      cloudPages.push(page);
    }

    const readinessResult = await popup.evaluate(async ({ accounts, fixtureUrl }) => {
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const provider = {
        ...providers.find(p => p.id === 'google-cloud'),
        _configOverrides: { accountId: accounts[1], email: 'admin@company.com' }
      };
      const billingUrl = resolveBillingUrl(provider);
      const wantedTab = await findProviderTab(provider.id, billingUrl);
      check(wantedTab?.url.includes(accounts[1]), 'Configured second account must win over the first domain match');
      const genericTab = await findProviderTab(provider.id);
      check(genericTab?.url.includes(accounts[0]), 'Fixture must expose the original first-tab selection bug');
      check(await findProviderTab(provider.id, billingUrl.replace(accounts[1], '333333-EEEEEE-FFFFFF')) === null,
        'Missing configured account must not fall back to another billing account');
      check(!(await selectorExists(wantedTab.id, provider.readySelector)), 'Table must exist only inside the iframe');

      const ready = await waitForSelector(wantedTab.id, provider.readySelector, 3, null, provider.iframe.urlPattern);
      check(ready.success, 'Readiness must detect the payments iframe table');

      const fixtureTab = (await chrome.tabs.query({})).find(tab => tab.url === fixtureUrl);
      check(await selectorExists(fixtureTab.id, provider.readySelector), 'Missing-frame fixture must have a table in its main frame');
      const missing = await waitForSelector(fixtureTab.id, provider.readySelector, 1, null, provider.iframe.urlPattern);
      check(!missing.success, 'Missing payments iframe must not fall back to a main-frame table');

      const original = { workflowProviders, index: state.currentIndex, tabId: currentProviderTabId, executeDownload };
      const attempts = [];
      try {
        workflowProviders = [provider];
        state.currentIndex = 0;
        window.executeDownload = async (tabId, selectedProvider, options) => {
          attempts.push({ tabId, account: selectedProvider._configOverrides.accountId, skipDedup: options?.skipDedup });
        };
        await handleLoggedIn();
        await retryDownload();
        check(attempts.length === 2, 'Ready and Retry must both reach download orchestration without timing out');
        check(attempts.every(attempt => attempt.tabId === wantedTab.id && attempt.account === accounts[1]),
          'Ready and Retry must download only from the configured second account');
        check(attempts[1].skipDedup === true, 'Retry must retain its skip-dedup behavior');
        check(currentProviderTabId === wantedTab.id, 'Show tab must track the selected billing account');
      } finally {
        workflowProviders = original.workflowProviders;
        state.currentIndex = original.index;
        currentProviderTabId = original.tabId;
        window.executeDownload = original.executeDownload;
      }
      return { accountMatched: true, iframeReady: ready.success, missingFrameBlocked: !missing.success, handlers: attempts.length };
    }, { accounts: cloudAccounts, fixtureUrl: `${baseUrl}/google-cloud-billing` });

    assert(readinessResult.accountMatched, 'Account-specific selection must succeed');
    log('Tab selection prefers the configured billing account and never silently selects a different one');
    assert(readinessResult.iframeReady && readinessResult.missingFrameBlocked, 'Iframe readiness must stay frame-scoped');
    log('Readiness detects a cross-origin payments iframe and refuses a main-frame fallback when the iframe is absent');
    assert(readinessResult.handlers === 2, 'Ready and Retry must both proceed');
    log('Ready and Retry reach download orchestration for the correct account and preserve retry options');
    for (const page of cloudPages) await page.close();

    // --- Test Group 11: Enterprise Configuration Capture ---
    console.log('\nGroup 11: Enterprise Configuration Capture\n');

    const enterpriseSettingsUrl = 'https://github.com/settings/enterprises';
    await context.route(enterpriseSettingsUrl, route => route.fulfill({
      contentType: 'text/html',
      body: '<a href="/enterprises/intelia-technologies-sl">Intelia Technologies SL</a><a href="/enterprises/intelia-technologies-sl/settings">Settings</a>'
    }));
    const capturePage = await context.newPage();
    await capturePage.goto(enterpriseSettingsUrl);
    const captureTabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, enterpriseSettingsUrl);
    const fieldSelector = '#provider-config-fields';
    const setEnterpriseConfig = async values => {
      await popup.evaluate(async values => {
        await saveProviderConfig('github-enterprise', 'enterprise', values);
        nav.push('provider', { providerId: 'github-enterprise' });
        await renderProviderDetail('github-enterprise');
      }, values);
    };
    const readEnterpriseConfig = () => popup.evaluate(() => providerConfigs['github-enterprise'].enterprise);
    const captureFromPage = async () => {
      await capturePage.bringToFront();
      await popup.bringToFront();
      await popup.locator(`${fieldSelector} .config-capture-button`).click();
      await popup.waitForFunction(() => !document.querySelector('.config-capture-button').disabled);
    };

    await setEnterpriseConfig([]);
    await captureFromPage();
    assert(JSON.stringify(await readEnterpriseConfig()) === '["intelia-technologies-sl"]',
      'Single enterprise link must capture the URL slug, not the display name');
    await captureFromPage();
    assert((await readEnterpriseConfig()).length === 1, 'Repeated capture must not duplicate a saved enterprise');
    log('Capture saves the unique enterprise slug from GitHub links and deduplicates repeated links and captures');

    await capturePage.setContent('<a href="/enterprises/intelia-technologies-sl">Intelia Technologies SL</a><a href="/enterprises/second-enterprise">Second company</a>');
    await setEnterpriseConfig([]);
    await captureFromPage();
    assert((await readEnterpriseConfig()).length === 0, 'Multiple enterprises must not save the first one automatically');
    await popup.locator('.config-capture-select').selectOption('1');
    await popup.getByRole('button', { name: 'Use selection', exact: true }).click();
    await popup.waitForFunction(() => providerConfigs['github-enterprise'].enterprise[0] === 'second-enterprise');
    log('Multiple enterprises require explicit selection before changing saved configuration');

    const enterprisePageUrl = 'https://github.com/enterprises/current-enterprise/billing/payment_history';
    await context.route(enterprisePageUrl, route => route.fulfill({
      contentType: 'text/html',
      body: '<a href="/enterprises/another-enterprise">Another enterprise</a>'
    }));
    await capturePage.goto(enterprisePageUrl);
    await setEnterpriseConfig([]);
    await captureFromPage();
    assert(JSON.stringify(await readEnterpriseConfig()) === '["current-enterprise"]',
      'An enterprise page URL must identify the current enterprise without picking an unrelated link');
    log('Capture prefers the current enterprise URL over other enterprise links on that page');

    await setEnterpriseConfig([]);
    await popup.locator(`${fieldSelector} .config-multi-input`).fill('https://github.com/enterprises/intelia-technologies-sl/billing/payment_history?tab=invoices');
    await popup.locator(`${fieldSelector} .config-multi-add-btn`).click();
    await popup.waitForFunction(() => providerConfigs['github-enterprise'].enterprise[0] === 'intelia-technologies-sl');
    const resolvedEnterpriseUrl = await popup.evaluate(() => resolveBillingUrl(providers.find(p => p.id === 'github-enterprise')));
    assert(resolvedEnterpriseUrl === 'https://github.com/enterprises/intelia-technologies-sl/billing/payment_history',
      'Pasted enterprise URL must normalize to the slug used for billing navigation');
    await popup.locator(`${fieldSelector} .config-multi-input`).fill('Intelia Technologies SL');
    await popup.locator(`${fieldSelector} .config-multi-add-btn`).click();
    await popup.locator(`${fieldSelector} .config-error`).filter({ hasText: 'not the display name' }).waitFor();
    assert(JSON.stringify(await readEnterpriseConfig()) === '["intelia-technologies-sl"]',
      'Invalid display name must not be saved');
    log('Full URLs normalize to billing slugs; entering the display name shows an error without saving it');

    await setEnterpriseConfig(['Intelia Technologies SL']);
    assert(await popup.locator('#btn-download-single').isDisabled(), 'Invalid saved values must block provider launch');
    await captureFromPage();
    assert(JSON.stringify(await readEnterpriseConfig()) === '["Intelia Technologies SL","current-enterprise"]',
      'Capture must preserve existing values rather than silently replacing them');
    await popup.locator(`${fieldSelector} .config-invalid .config-multi-remove`).click();
    await popup.waitForFunction(() => !document.getElementById('btn-download-single').disabled);
    assert(JSON.stringify(await readEnterpriseConfig()) === '["current-enterprise"]',
      'Removing the invalid saved value must leave the captured enterprise usable');
    log('Invalid saved names are marked and block launch until explicitly removed; capture preserves existing entries');

    const originChecks = await popup.evaluate(async ({ tabId, fixtureUrl }) => {
      const def = providers.find(p => p.id === 'github-enterprise').config.enterprise;
      const fixtureTab = (await chrome.tabs.query({})).find(tab => tab.url === fixtureUrl);
      const unrelated = await captureConfigCandidates(fixtureTab.id, def);
      const direct = await captureConfigCandidates(tabId, def);
      const invalidUrls = [
        'https://github.com.evil.example/enterprises/fake',
        'https://evil.example/enterprises/fake',
        'https://github.com/organizations/not-an-enterprise',
        'http://github.com/enterprises/insecure'
      ];
      const rejected = invalidUrls.every(url => {
        try { normalizeConfigEntry(url, def); return false; } catch { return true; }
      });
      return { unrelated, direct, rejected };
    }, { tabId: captureTabId, fixtureUrl: `${baseUrl}/google-cloud-billing` });
    assert(originChecks.unrelated.length === 0 && originChecks.rejected, 'Unrelated origins and wrong URL formats must not supply enterprise identifiers');
    assert(originChecks.direct[0]?.value === 'current-enterprise', 'Current GitHub enterprise must still be capturable');
    log('Capture is restricted to GitHub and URL input rejects lookalike hosts and organization URLs');

    // --- Test Group 12: Click-Download History Persistence, Fetch-Blob & 1Password Auto-Login ---
    console.log('\nGroup 12: Click-Download History Persistence, Fetch-Blob & 1Password Auto-Login\n');

    // 12a: Verify click-download entries without downloadUrl persist uniquely in downloadHistory
    const historyCheck = await popup.evaluate(async () => {
      await chrome.storage.local.remove('downloadHistory');
      await saveDownloadHistory([
        { providerId: 'coderabbit', providerName: 'CodeRabbit', id: 'INV-CR-2026-001', date: '2026-09-15', amount: '$49.00', filename: 'CodeRabbit_2026-09-15.pdf' },
        { providerId: 'coderabbit', providerName: 'CodeRabbit', id: 'INV-CR-2026-002', date: '2026-08-15', amount: '$49.00', filename: 'CodeRabbit_2026-08-15.pdf' },
        { providerId: 'coderabbit', providerName: 'CodeRabbit', id: 'INV-CR-2026-001', date: '2026-09-15', amount: '$49.00', filename: 'CodeRabbit_2026-09-15.pdf' },
      ]);
      const saved = await loadDownloadHistory();
      return saved;
    });
    assert(historyCheck.length === 2, `Expected 2 unique click-download history entries without downloadUrl, got ${historyCheck.length}`);
    log('click-download entries without downloadUrl persist uniquely in downloadHistory via historyEntryKey');

    // 12b: Verify fetch-blob rejects HTML error pages and downloads valid PDF blobs via Data URL
    const fetchBlobPage = await context.newPage();
    await context.route(`${baseUrl}/invoice-html-error`, route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html><body>Login expired</body></html>',
    }));
    await context.route(`${baseUrl}/invoice-valid.pdf`, route => route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: '%PDF-1.4 mock invoice',
    }));
    await fetchBlobPage.goto(`${baseUrl}/coderabbit-billing`);
    const fetchBlobTabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, `${baseUrl}/coderabbit-billing`);

    const fetchBlobCheck = await popup.evaluate(async ({ tabId, base }) => {
      const origDownload = chrome.downloads.download;
      const downloadedUrls = [];
      chrome.downloads.download = async (opts) => {
        downloadedUrls.push(opts.url);
        return 777;
      };
      try {
        const mockProvider = { id: 'mock-blob', name: 'MockBlob', download: { method: 'fetch-blob' } };
        const htmlRes = await downloadInvoice(tabId, { downloadUrl: `${base}/invoice-html-error`, filename: 'err.pdf' }, mockProvider);
        const pdfRes = await downloadInvoice(tabId, { downloadUrl: `${base}/invoice-valid.pdf`, filename: 'ok.pdf' }, mockProvider);
        return { htmlRes, pdfRes, downloadedUrls };
      } finally {
        chrome.downloads.download = origDownload;
      }
    }, { tabId: fetchBlobTabId, base: baseUrl });

    assert(fetchBlobCheck.htmlRes.success === false, 'fetch-blob must reject text/html responses instead of saving HTML as PDF');
    assert(fetchBlobCheck.pdfRes.success === true && fetchBlobCheck.downloadedUrls[0]?.startsWith('data:application/pdf;base64,'),
      'fetch-blob must convert credentialed in-tab PDF response into a data: URL for chrome.downloads');
    log('fetch-blob executes credentialed in-tab fetch, blocks HTML error pages, and passes PDF data URL to chrome.downloads');

    // 12c: Verify engine.js detectLoginForm and attemptAutoLogin (2-step login + OTP)
    await fetchBlobPage.setContent(`
      <form id="login-form">
        <input id="user-email" type="email" autocomplete="username" />
        <button id="btn-continue" type="button">Continue</button>
      </form>
      <script>
        document.getElementById('btn-continue').addEventListener('click', () => {
          const passInput = document.createElement('input');
          passInput.id = 'user-pass';
          passInput.type = 'password';
          document.getElementById('login-form').appendChild(passInput);

          const submitBtn = document.createElement('button');
          submitBtn.id = 'btn-submit';
          submitBtn.type = 'button';
          submitBtn.textContent = 'Sign in';
          submitBtn.addEventListener('click', () => {
            const otpInput = document.createElement('input');
            otpInput.id = 'user-otp';
            otpInput.setAttribute('autocomplete', 'one-time-code');
            document.getElementById('login-form').appendChild(otpInput);

            const verifyBtn = document.createElement('button');
            verifyBtn.id = 'btn-verify';
            verifyBtn.type = 'button';
            verifyBtn.textContent = 'Verify';
            verifyBtn.addEventListener('click', () => {
              window.__loginCompleted = {
                user: document.getElementById('user-email').value,
                pass: document.getElementById('user-pass').value,
                otp: document.getElementById('user-otp').value,
              };
            });
            document.getElementById('login-form').appendChild(verifyBtn);
          });
          document.getElementById('login-form').appendChild(submitBtn);
        });
      </script>
    `);
    await popup.evaluate(async (tabId) => { await injectEngine(tabId); }, fetchBlobTabId);
    const loginTestResult = await fetchBlobPage.evaluate(async () => {
      const detected = window.__invoiceEngine.detectLoginForm({});
      const res = await window.__invoiceEngine.attemptAutoLogin(
        { username: 'finance@intelia.com', password: 'vault-password-99', otp: '654321' },
        {}
      );
      return { detected, res, completed: window.__loginCompleted };
    });

    assert(loginTestResult.detected.hasLoginForm === true, 'detectLoginForm must detect visible username input');
    assert(loginTestResult.res.filledUsername && loginTestResult.res.filledPassword && loginTestResult.res.filledOtp,
      `attemptAutoLogin must fill username, password, and OTP in 2-step flow, got: ${JSON.stringify(loginTestResult.res)}`);
    assert(
      loginTestResult.completed?.user === 'finance@intelia.com' &&
      loginTestResult.completed?.pass === 'vault-password-99' &&
      loginTestResult.completed?.otp === '654321',
      `Login form must receive exact 1Password credentials, got: ${JSON.stringify(loginTestResult.completed)}`
    );
    log('engine.js detectLoginForm and attemptAutoLogin complete 2-step username -> password -> 2FA OTP login');

    // 12d: verifyLoggedInIdentity detects wrong active account and clearPageSessionData purges session state
    const identityCheckResult = await fetchBlobPage.evaluate(async () => {
      window.localStorage.setItem('current_user_email', 'finance@intelia.com');
      document.cookie = 'session_token=intelia_active;path=/';
      const mismatch = window.__invoiceEngine.verifyLoggedInIdentity(
        { username: 'billing@acme.example', previousUsername: 'finance@intelia.com' },
        {}
      );
      await window.__invoiceEngine.clearPageSessionData();
      const afterClear = window.__invoiceEngine.verifyLoggedInIdentity(
        { username: 'billing@acme.example', previousUsername: 'finance@intelia.com' },
        {}
      );
      return {
        mismatch,
        storageAfter: window.localStorage.getItem('current_user_email'),
        cookieAfter: document.cookie,
        afterClear,
      };
    });
    assert(identityCheckResult.mismatch.mismatchDetected === true, 'verifyLoggedInIdentity must detect previous account still active');
    assert(identityCheckResult.storageAfter === null, 'clearPageSessionData must wipe localStorage');
    assert(!identityCheckResult.cookieAfter.includes('intelia_active'), 'clearPageSessionData must expire accessible cookies');
    assert(identityCheckResult.afterClear.mismatchDetected === false, 'After clearing session data, stale user is no longer present');
    log('engine.js verifyLoggedInIdentity and clearPageSessionData detect wrong account and purge session');

    // 12e: Holded hash navigation reload detection & account-switch loop prevention
    const holdedLoopCheck = await popup.evaluate(async () => {
      const holded = providers.find(p => p.id === 'holded');
      const stripe = providers.find(p => p.id === 'stripe');
      const sameDocFromDashboard = isSameDocumentHashNavigation(
        'https://app.holded.com/home',
        'https://app.holded.com/home#settings:/subscription/invoices'
      );
      const sameDocIdenticalHash = isSameDocumentHashNavigation(
        'https://app.holded.com/home#settings:/subscription/invoices',
        'https://app.holded.com/home#settings:/subscription/invoices'
      );
      const diffPath = isSameDocumentHashNavigation(
        'https://app.holded.com/login',
        'https://app.holded.com/home#settings:/subscription/invoices'
      );
      const github = providers.find(p => p.id === 'github');
      const holdedAccountIdRequired = isConfigFieldRequiredForNavigation(holded, 'accountId');
      const stripeAccountIdRequired = isConfigFieldRequiredForNavigation(stripe, 'accountId');
      const stripeCollapsedUrl = resolveBillingUrl(stripe);
      const githubOrgRequired = isConfigFieldRequiredForNavigation(github, 'org');

      _switchedProviderKeys.clear();
      _switchedProviderKeys.add(workflowKey(holded));
      const secondSwitch = await ensureCorrectProviderAccount(1, holded, { orgOk: false });
      _switchedProviderKeys.clear();

      return {
        sameDocFromDashboard,
        sameDocIdenticalHash,
        diffPath,
        holdedAccountIdRequired,
        stripeAccountIdRequired,
        stripeCollapsedUrl,
        githubOrgRequired,
        secondSwitch,
      };
    });
    assert(holdedLoopCheck.sameDocFromDashboard === true, 'Holded /home -> /home#settings:... must be detected as same-document hash navigation');
    assert(holdedLoopCheck.sameDocIdenticalHash === true, 'Holded identical hash URL must be detected as same-document hash navigation');
    assert(holdedLoopCheck.diffPath === false, 'Holded /login -> /home#settings:... is a full path navigation');
    assert(holdedLoopCheck.holdedAccountIdRequired === false, 'Holded accountId (optional orgCheck) must not block 1Password launch when empty');
    assert(holdedLoopCheck.stripeAccountIdRequired === false, 'Stripe accountId must not block 1Password launch when empty');
    assert(holdedLoopCheck.stripeCollapsedUrl === 'https://dashboard.stripe.com/settings/plans-and-fees/invoice-history', 'Stripe billingUrl with empty accountId must collapse double slashes');
    assert(holdedLoopCheck.githubOrgRequired === true, 'GitHub org (used in billingUrl) must remain required');
    assert(holdedLoopCheck.secondSwitch.switched === false, 'ensureCorrectProviderAccount must never loop a second time on the same provider step');
    log('Holded hash navigation forces document reload and _switchedProviderKeys blocks infinite logout/login loops');
    await fetchBlobPage.close();

    // 12e: inspectBillingPage injects recorder.js and returns invoiceTableCandidates for one-shot provider creation
    const { inspectBillingPage } = await import('../bin/invoice-extractor.mjs');
    const inspectDir = mkdtempSync(path.join(os.tmpdir(), 'ie-inspect-profile-'));
    try {
      const inspection = await inspectBillingPage({
        url: `${baseUrl}/openai-billing`,
        waitMs: 300,
        headed: false,
        userDataDir: inspectDir,
      });
      assert(
        Array.isArray(inspection.analysis?.invoiceTableCandidates) &&
          inspection.analysis.invoiceTableCandidates.length > 0,
        'inspectBillingPage must detect invoiceTableCandidates via recorder.js'
      );
      assert(
        inspection.analysis.invoiceTableCandidates[0].rowCount === 2,
        `Expected 2 detected invoice rows, got ${inspection.analysis.invoiceTableCandidates[0].rowCount}`
      );
      log('inspectBillingPage injects recorder.js via Playwright and returns invoiceTableCandidates for zero-touch provider creation');
    } finally {
      try { rmSync(inspectDir, { recursive: true, force: true }); } catch {}
    }

    // --- Summary ---
    console.log('\n=======================================');
    console.log(`  All provider billing regression tests passed! (${totalChecks} checks)`);
    console.log('=======================================\n');
  } finally {
    if (context) {
      try { await context.close(); } catch (e) {}
    }
    if (server) {
      try { server.close(); } catch (e) {}
    }
    if (tmpDir && existsSync(tmpDir)) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

runTests().catch(e => {
  console.error('\n  FAIL:', e.message);
  process.exit(1);
});
