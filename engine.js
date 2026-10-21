// engine.js — Step-based provider execution engine
// Injected into tab's MAIN world AFTER utils.js
// Available as window.__invoiceEngine
// Uses window.__invoiceUtils for DOM helpers
(function() {
  'use strict';

  const utils = window.__invoiceUtils;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // =====================================================
  // DATE PARSING
  // =====================================================
  const ES_MONTH_INDEX = {
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
    'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
  };
  const ES_MONTH_EN = {
    'enero': 'January', 'febrero': 'February', 'marzo': 'March', 'abril': 'April',
    'mayo': 'May', 'junio': 'June', 'julio': 'July', 'agosto': 'August',
    'septiembre': 'September', 'octubre': 'October', 'noviembre': 'November', 'diciembre': 'December'
  };
  const ES_MONTH_ABBR_EN = {
    ene: 'Jan', feb: 'Feb', mar: 'Mar', abr: 'Apr', may: 'May', jun: 'Jun',
    jul: 'Jul', ago: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dic: 'Dec'
  };

  // "junio de 2026" → "June 1, 2026" (also passes through English "June 2026")
  function monthYearToDate(text) {
    let norm = text.replace(/\bde\b/gi, ' ').replace(/\s+/g, ' ').trim();
    for (const [es, en] of Object.entries(ES_MONTH_EN)) {
      norm = norm.replace(new RegExp(`\\b${es}\\b`, 'gi'), en);
    }
    const d = new Date(norm.replace(/(\w+)\s+(\d{4})/, '$1 1, $2'));
    return isNaN(d) ? null : d;
  }

  function parseDate(text, format) {
    if (!text) return null;
    text = text.trim();

    switch (format) {
      case 'M/D/YYYY':
      case 'MMM DD, YYYY':
      case 'Month D, YYYY':
      case 'YYYY-MM-DD': {
        const d = new Date(text);
        return isNaN(d) ? null : d;
      }
      case 'Month YYYY': {
        return monthYearToDate(text);
      }
      case 'range': {
        const parts = text.split('–');
        let endPart = (parts[1] || parts[0]).trim();
        for (const [es, en] of Object.entries(ES_MONTH_ABBR_EN)) {
          endPart = endPart.replace(new RegExp(`\\b${es}\\b`, 'i'), en);
        }
        const d = new Date(endPart);
        return isNaN(d) ? null : d;
      }
      case 'D/M/YY': {
        const partsShort = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
        if (partsShort) {
          let year = parseInt(partsShort[3]);
          if (year < 100) year += 2000;
          return new Date(year, parseInt(partsShort[2]) - 1, parseInt(partsShort[1]));
        }
        return null;
      }
      case 'DD/MM/YYYY': {
        const parts = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (parts) {
          return new Date(parseInt(parts[3]), parseInt(parts[2]) - 1, parseInt(parts[1]));
        }
        return null;
      }
      case 'D de MMMM de YYYY': {
        const m = text.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/);
        if (m) {
          const monthIdx = ES_MONTH_INDEX[m[2].toLowerCase()];
          if (monthIdx != null) return new Date(parseInt(m[3]), monthIdx, parseInt(m[1]));
        }
        return null;
      }
      case 'auto':
      default: {
        const esMatch = text.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/);
        if (esMatch) {
          const monthIdx = ES_MONTH_INDEX[esMatch[2].toLowerCase()];
          if (monthIdx != null) return new Date(parseInt(esMatch[3]), monthIdx, parseInt(esMatch[1]));
        }
        const d = new Date(text);
        if (!isNaN(d)) return d;
        // Fallback: month-year strings, incl. Spanish ("junio de 2026")
        return monthYearToDate(text);
      }
    }
  }

  // =====================================================
  // FIELD EXTRACTION
  // =====================================================
  function extractField(row, fieldDef) {
    if (fieldDef.template) return null;

    const el = fieldDef.selector ? row.querySelector(fieldDef.selector) : row;
    if (!el) return null;

    let value;
    if (fieldDef.attr === 'href') {
      value = el.getAttribute('href');
    } else if (fieldDef.attr === 'innerText') {
      value = el.innerText.trim();
    } else if (fieldDef.attr) {
      value = el.getAttribute(fieldDef.attr);
    } else {
      value = el.textContent.trim();
    }

    if (value && fieldDef.regex) {
      const match = value.match(new RegExp(fieldDef.regex));
      if (match) {
        const group = fieldDef.regexGroup ?? 0;
        value = match[group] || match[0];
      } else {
        return null;
      }
    }

    if (value && fieldDef.resolve) {
      try {
        value = new URL(value, location.href).toString();
      } catch (e) { /* keep original value */ }
    }

    return value;
  }

  // =====================================================
  // FILENAME TEMPLATE
  // =====================================================
  function buildFilename(template, invoice, providerName) {
    let name = template;
    name = name.replace(/\{\{name\}\}/g, providerName);
    for (const [key, val] of Object.entries(invoice)) {
      if (typeof val === 'string' || typeof val === 'number') {
        let clean = String(val);
        if (key === 'amount') {
          clean = clean.replace(/[^0-9.,]/g, '').replace(/,/g, '');
        }
        const safe = clean.replace(/[^a-zA-Z0-9.-]/g, '-');
        name = name.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), safe);
      }
    }
    name = name.replace(/\{\{[^}]+\}\}/g, '');
    name = name.replace(/-{2,}/g, '-').replace(/-\./g, '.');
    return name;
  }

  // =====================================================
  // STEP API: extractRows
  // =====================================================
  // Extract invoice rows from current page state. NO download logic.
  // Returns structured result for popup.js to act on.
  const DEFAULT_MAX_INVOICES = 999;
  function extractRows(provider, config) {
    const maxInvoices = config.maxInvoices || DEFAULT_MAX_INVOICES;
    let sinceDate = null;
    if (config.sinceDate) {
      const [y, m, d] = config.sinceDate.split('-').map(Number);
      sinceDate = new Date(y, m - 1, d);
    }
    const previousDownloads = new Set(config.previousDownloads || []);
    const seen = new Set(config.seen || []);

    // Query rows (with fallback selector)
    let rows = Array.from(document.querySelectorAll(provider.extract.rows));
    if (rows.length === 0 && provider.extract.fallbackRows) {
      rows = Array.from(document.querySelectorAll(provider.extract.fallbackRows));
    }

    if (rows.length === 0) {
      console.log(`${provider.name}: No rows found with selector "${provider.extract.rows}"`);
      const tables = document.querySelectorAll('table');
      console.log(`${provider.name}: Debug — ${tables.length} table(s) on page:`,
        Array.from(tables).map(t => ({ tag: t.tagName, class: t.className, rows: t.querySelectorAll('tr').length })));
      return { rowsFound: 0, rowsFilteredByDate: 0, rowsDeduped: 0, invoices: [], debug: 'no-rows' };
    }

    console.log(`${provider.name}: Found ${rows.length} row(s)`);
    if (rows.length > 0) {
      console.log(`${provider.name}: First row text: "${rows[0].textContent.trim().substring(0, 80)}"`, rows[0].className);
    }

    const invoices = [];
    let rowsFilteredByDate = 0;
    let rowsDeduped = 0;
    const filenameTemplate = provider.download.filenameTemplate || '{{name}}_Invoice_{{date}}.pdf';

    for (const row of rows) {
      if (invoices.length >= maxInvoices) break;

      // Extract all direct fields
      const invoice = {};
      invoice.__rowIndex = rows.indexOf(row);
      for (const [fieldName, fieldDef] of Object.entries(provider.extract.fields)) {
        invoice[fieldName] = extractField(row, fieldDef);
      }

      // Resolve template fields
      for (const [fieldName, fieldDef] of Object.entries(provider.extract.fields)) {
        if (fieldDef.template) {
          let val = fieldDef.template;
          for (const [k, v] of Object.entries(invoice)) {
            if (v != null) val = val.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
          }
          if (fieldDef.resolve) {
            try { val = new URL(val, location.href).toString(); } catch (e) {}
          }
          invoice[fieldName] = val;
        }
      }

      // Auto-resolve downloadUrl to absolute (chrome.downloads needs absolute URLs)
      if (invoice.downloadUrl && !/^(https?:|blob:)/.test(invoice.downloadUrl)) {
        try { invoice.downloadUrl = new URL(invoice.downloadUrl, location.href).toString(); } catch (e) {}
      }

      const { __rowIndex: _omit, ...logData } = invoice;
      console.log(`${provider.name}: Row extracted:`, JSON.stringify(logData));

      // Date filtering
      if (invoice.date && sinceDate) {
        const parsed = parseDate(invoice.date, provider.extract.dateFormat);
        console.log(`${provider.name}: Row date="${invoice.date}" parsed=${parsed} sinceDate=${sinceDate} pass=${!parsed || parsed >= sinceDate}`);
        if (parsed && parsed < sinceDate) {
          rowsFilteredByDate++;
          continue;
        }
      }

      // Deduplication
      if (provider.extract.dedup) {
        const dedupVal = invoice[provider.extract.dedup];
        if (dedupVal && seen.has(dedupVal)) { rowsDeduped++; continue; }
        if (dedupVal) seen.add(dedupVal);
      }

      // Resolve download URL from template if needed
      let url = invoice.downloadUrl;
      if (provider.download.urlTemplate) {
        url = provider.download.urlTemplate;
        for (const [k, v] of Object.entries(invoice)) {
          if (v != null) url = url.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
        }
        try { url = new URL(url, location.href).toString(); } catch (e) {}
        invoice.downloadUrl = url;
      }

      // Build filename
      invoice.filename = buildFilename(filenameTemplate, invoice, provider.name);

      // Handle multiple download links per row (e.g., Elastic)
      if (provider.extract.downloadLinks) {
        const dl = provider.extract.downloadLinks;
        const links = Array.from(row.querySelectorAll(dl.selector));
        for (const link of links) {
          if (invoices.length >= maxInvoices) break;
          const href = link.getAttribute('href');
          let resolvedUrl = href;
          try { resolvedUrl = new URL(href, location.href).toString(); } catch (e) {}
          if (previousDownloads.has(resolvedUrl)) { rowsDeduped++; continue; }
          const label = link.innerText.trim();
          const multiInv = { ...invoice, downloadUrl: resolvedUrl, label };
          multiInv.filename = buildFilename(filenameTemplate, multiInv, provider.name);
          invoices.push(multiInv);
        }
      } else {
        // Single download per row
        const allowMissingUrl = provider.extract.allowMissingUrl;
        if (!invoice.downloadUrl && !allowMissingUrl) continue;

        const effectiveUrl = invoice.downloadUrl
          || (allowMissingUrl && provider.extract.dedup ? invoice[provider.extract.dedup] : null);
        if (effectiveUrl && previousDownloads.has(effectiveUrl)) { rowsDeduped++; continue; }
        invoices.push(invoice);
      }
    }

    // If ALL rows on this page were filtered by date, signal to stop pagination
    const stoppedByDate = rows.length > 0 && rowsFilteredByDate === rows.length;

    console.log(`${provider.name}: ${invoices.length} invoice(s) ready for download`);

    return {
      rowsFound: rows.length,
      rowsFilteredByDate,
      rowsDeduped,
      stoppedByDate,
      invoices,
      // Return updated seen set so popup can pass it back for pagination
      seen: Array.from(seen)
    };
  }

  // =====================================================
  // STEP API: executeStep
  // =====================================================
  // Execute a single preStep action (click, clickAll, waitFor).
  // Returns structured result.
  async function executeStep(step) {
    console.log(`Step: ${step.action} "${step.selector}"${step.text ? ` text="${step.text}"` : ''}`);

    switch (step.action) {
      case 'click':
      case 'clickAll': {
        const stopAfterFirst = step.action === 'click';
        const elements = document.querySelectorAll(step.selector);
        let count = 0;
        for (const el of elements) {
          if (step.text && !utils.textMatches(el.textContent, step.text)) continue;
          utils.simulateRealClick(el);
          count++;
          if (stopAfterFirst) break;
        }
        if (count > 0 && step.wait) await sleep(step.wait);
        return { success: count > 0, elementsFound: elements.length, elementsClicked: count };
      }

      case 'waitFor': {
        const timeout = step.timeout || 5000;
        const el = await utils.waitForElement(step.selector, timeout);
        return { success: !!el, elementsFound: el ? 1 : 0, elementsClicked: 0 };
      }

      default:
        return { success: false, elementsFound: 0, elementsClicked: 0 };
    }
  }

  // =====================================================
  // STEP API: clickInRow
  // =====================================================
  // Execute click steps within the scope of a specific row.
  // Re-queries rows from DOM (handles re-renders).
  // Sets up window.open interception for URL capture.
  // Returns { success, capturedUrl }.
  async function clickInRow(rowSelector, rowIndex, steps) {
    const rows = Array.from(document.querySelectorAll(rowSelector));
    const row = rows[rowIndex];
    if (!row) {
      console.log(`clickInRow: Row ${rowIndex} not found (${rows.length} rows total)`);
      return { success: false, capturedUrl: null };
    }

    // Override window.open to capture download URLs
    let capturedUrl = null;
    const originalOpen = window.open;
    window.open = function(url) {
      if (url) {
        try {
          capturedUrl = new URL(url, location.href).toString();
          console.log(`clickInRow: captured URL from window.open: ${capturedUrl.substring(0, 80)}...`);
        } catch (e) {
          return originalOpen.call(window, url);
        }
      }
      return null;
    };

    try {
      for (const step of steps) {
        if (step.action === 'waitFor') {
          const timeout = step.timeout || 5000;
          await utils.waitForElement(step.selector, timeout);
          continue;
        }

        // Special "self" selector — click the row element itself
        if (step.selector === 'self') {
          console.log(`clickInRow step: clicking row element itself`);
          utils.simulateRealClick(row);
          if (step.wait) await sleep(step.wait);
          continue;
        }

        // Resolve search scope
        const scope = step.scope === 'document' ? document
          : step.scope === 'row-parent' ? (row.parentElement || row)
          : row;

        // Poll for element if step has pollTimeout
        let target = null;
        const pollTimeout = step.pollTimeout || 0;
        const pollStart = Date.now();
        do {
          const elements = Array.from(scope.querySelectorAll(step.selector));
          let candidates = step.scope === 'document' ? elements.reverse() : elements;

          if (step.visible) {
            candidates = candidates.filter(el => utils.isElementVisible(el));
          }

          for (const el of candidates) {
            if (step.text) {
              if (utils.textMatches(el.textContent, step.text)) { target = el; break; }
            } else {
              target = el; break;
            }
          }

          if (target || pollTimeout === 0) break;
          await sleep(300);
        } while (Date.now() - pollStart < pollTimeout);

        if (target) {
          console.log(`clickInRow step: clicking "${target.getAttribute('aria-label') || target.textContent.trim().substring(0, 30)}"`);

          if (target.tagName === 'A' && target.href) {
            target.setAttribute('download', '');
          }

          utils.simulateRealClick(target);
          if (step.wait) await sleep(step.wait);
        } else {
          console.log(`clickInRow step: no element found for "${step.selector}"${pollTimeout ? ` (polled ${pollTimeout}ms)` : ''}`);
        }
      }
    } finally {
      window.open = originalOpen;
    }

    return { success: true, capturedUrl };
  }

  // =====================================================
  // STEP API: queryElement
  // =====================================================
  // Query a single element. Returns info about it (for readiness checks, orgCheck, etc.)
  // For href/src, opts.resolveUrls returns the absolute URL (the IDL property) instead
  // of the raw attribute string.
  function queryElement(selector, opts = {}) {
    const el = document.querySelector(selector);
    if (!el) return { found: false, text: null, visible: false, attrs: {} };

    const result = {
      found: true,
      text: el.textContent.trim(),
      visible: utils.isElementVisible(el),
      attrs: {}
    };

    if (opts.attrs) {
      for (const attr of opts.attrs) {
        if (opts.resolveUrls && (attr === 'href' || attr === 'src') && el[attr]) {
          result.attrs[attr] = el[attr];
        } else {
          result.attrs[attr] = el.getAttribute(attr);
        }
      }
    }

    return result;
  }

  // =====================================================
  // STEP API: getPaginationOptions
  // =====================================================
  // Returns the list of pagination dropdown options and which one is active.
  function getPaginationOptions(paginationConfig) {
    const { optionSelector } = paginationConfig;
    const options = Array.from(document.querySelectorAll(optionSelector));

    let activeIndex = 0;
    for (let i = 0; i < options.length; i++) {
      const el = options[i];
      if (el.classList.contains('is-active') ||
          el.classList.contains('is-selected') ||
          el.getAttribute('aria-selected') === 'true') {
        activeIndex = i;
        break;
      }
    }

    return {
      options: options.map((el, i) => ({
        text: el.textContent.trim(),
        index: i,
        isActive: i === activeIndex
      })),
      activeIndex
    };
  }

  // =====================================================
  // STEP API: selectPaginationOption
  // =====================================================
  // Opens dropdown and clicks the option at the given index.
  async function selectPaginationOption(paginationConfig, index) {
    const { openSelector, optionSelector, wait: paginationWait = 2000 } = paginationConfig;

    const openEl = document.querySelector(openSelector);
    if (!openEl) {
      console.log(`selectPaginationOption: dropdown opener not found ("${openSelector}")`);
      return { success: false };
    }

    utils.simulateRealClick(openEl);
    await sleep(500);

    const options = Array.from(document.querySelectorAll(optionSelector));
    if (index >= options.length) {
      console.log(`selectPaginationOption: index ${index} out of range (${options.length} options)`);
      return { success: false };
    }

    console.log(`selectPaginationOption: clicking option ${index + 1}/${options.length}: "${options[index].textContent.trim()}"`);
    utils.simulateRealClick(options[index]);
    await sleep(paginationWait);

    return { success: true };
  }

  // =====================================================
  // STEP API: clickNext
  // =====================================================
  // Click an in-page "next page" button that updates the list via AJAX.
  // `nextText` filters candidates by text; `pick: "last"` takes the last match
  // (paginators usually render "prev" before "next" with no stable selector).
  // Returns { clicked } — false when the button is missing, hidden or disabled,
  // which is how the caller detects the last page.
  async function clickNext(paginationConfig) {
    const { nextSelector, nextText, pick, wait: paginationWait = 2000 } = paginationConfig;

    let candidates = Array.from(document.querySelectorAll(nextSelector));
    if (nextText) candidates = candidates.filter(el => utils.textMatches(el.textContent, nextText));
    const el = pick === 'last' ? candidates[candidates.length - 1] : candidates[0];

    if (!el) {
      console.log(`clickNext: next button not found ("${nextSelector}")`);
      return { clicked: false };
    }
    if (el.getAttribute('aria-disabled') === 'true' || el.disabled || !utils.isElementVisible(el)) {
      console.log('clickNext: next button disabled — last page reached');
      return { clicked: false };
    }

    utils.simulateRealClick(el);
    await sleep(paginationWait);
    return { clicked: true };
  }

  // =====================================================
  // STEP API: detectLoginForm & attemptAutoLogin (1Password)
  // =====================================================
  const DEFAULT_USERNAME_SELECTOR = [
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
    'input[name="email" i]',
    'input[name="username" i]',
    'input[name="user" i]',
    'input[name="login" i]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[id*="login" i]',
    'input[type="text"][placeholder*="email" i]',
    'input[type="text"][placeholder*="correo" i]',
    'input[type="text"][placeholder*="user" i]',
  ].join(', ');

  const DEFAULT_PASSWORD_SELECTOR = [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ].join(', ');

  const DEFAULT_OTP_SELECTOR = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="2fa" i]',
    'input[name*="code" i]',
    'input[id*="otp" i]',
    'input[id*="totp" i]',
    'input[id*="code" i]',
    'input[inputmode="numeric"][maxlength="6"]',
  ].join(', ');

  const DEFAULT_SUBMIT_SELECTOR = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[data-testid*="submit" i]',
    'button[data-testid*="login" i]',
    'button[data-testid*="signin" i]',
    'button[id*="submit" i]',
    'button[id*="login" i]',
  ].join(', ');

  function findVisibleInput(selector) {
    if (!selector) return null;
    const candidates = Array.from(document.querySelectorAll(selector));
    return candidates.find(el => !el.disabled && !el.readOnly && utils.isElementVisible(el)) || null;
  }

  function findSubmitButton(scope, customSelector, buttonTexts) {
    if (customSelector) {
      const custom = findVisibleInput(customSelector);
      if (custom) return custom;
    }
    const roots = [scope, document].filter(Boolean);
    for (const root of roots) {
      const buttons = Array.from(
        root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
      ).filter(el => !el.disabled && utils.isElementVisible(el));
      for (const targetText of buttonTexts) {
        const matched = buttons.filter(btn => {
          const label = (btn.value || btn.textContent || btn.getAttribute('aria-label') || '').trim();
          return utils.textMatches(label, targetText);
        });
        if (matched.length > 0) {
          return matched[matched.length - 1];
        }
      }

      const submitCandidates = Array.from(root.querySelectorAll(DEFAULT_SUBMIT_SELECTOR))
        .filter(el => !el.disabled && utils.isElementVisible(el));
      if (submitCandidates.length > 0) return submitCandidates[submitCandidates.length - 1];
    }
    return null;
  }

  function setNativeInputValue(input, value) {
    if (!input || value == null) return false;
    input.focus();
    const proto = Object.getPrototypeOf(input);
    const descriptor =
      Object.getOwnPropertyDescriptor(proto, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(input, String(value));
    } else {
      input.value = String(value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return true;
  }

  function detectLoginForm(authConfig = {}) {
    const userEl = findVisibleInput(authConfig.usernameSelector || DEFAULT_USERNAME_SELECTOR);
    const passEl = findVisibleInput(authConfig.passwordSelector || DEFAULT_PASSWORD_SELECTOR);
    const otpEl = findVisibleInput(authConfig.otpSelector || DEFAULT_OTP_SELECTOR);
    return {
      hasLoginForm: Boolean(userEl || passEl || otpEl),
      hasUsername: Boolean(userEl),
      hasPassword: Boolean(passEl),
      hasOtp: Boolean(otpEl),
    };
  }

  // Sign-in domain binding (see login-domains.mjs). `allowedLoginDomains` is a list of
  // domain suffixes computed outside the page from the vault item URLs and the recipe. This
  // frame and every ancestor frame must be https (http only on localhost) and sit on one of
  // them, otherwise nothing is typed. Callers also check before handing credentials over;
  // this repeats the check at the moment of typing.
  function isLocalLoginHost(host) {
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  }

  function checkLoginFrame(allowedDomains) {
    const domains = (Array.isArray(allowedDomains) ? allowedDomains : [])
      .map(d => String(d || '').toLowerCase().replace(/^\.+|\.+$/g, ''))
      .filter(Boolean);
    const frameHost = String(location.hostname || '').toLowerCase();
    if (domains.length === 0) return { ok: false, reason: 'no-allowed-domains', host: frameHost };

    const chain = [location.href];
    const ancestors = location.ancestorOrigins;
    if (ancestors) {
      for (let i = 0; i < ancestors.length; i++) chain.push(ancestors[i]);
    } else if (window.top !== window) {
      try {
        chain.push(window.top.location.href);
      } catch {
        return { ok: false, reason: 'unknown-top-frame', host: frameHost };
      }
    }

    for (const entry of chain) {
      let parsed;
      try { parsed = new URL(entry); } catch { return { ok: false, reason: 'invalid-url', host: String(entry || '') }; }
      const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
      const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalLoginHost(host));
      if (!secure) return { ok: false, reason: 'insecure', host: host || parsed.protocol };
      if (!domains.some(d => host === d || host.endsWith(`.${d}`))) {
        return { ok: false, reason: 'domain-mismatch', host };
      }
    }
    return { ok: true, host: frameHost };
  }

  function loginBlocked(check) {
    console.warn(`attemptAutoLogin: refused on ${check.host} (${check.reason}); nothing was typed`);
    return { attempted: false, blocked: true, reason: check.reason, host: check.host };
  }

  // =====================================================
  // STEP API: verification-code step (a code sent by email/SMS after the password)
  // =====================================================
  const CODE_HINT_PATTERN = /code|c[oó]digo|sent|enviad|e-?mail|correo|verif|sms|d[ií]git/i;
  const CODE_SUBMIT_TEXTS = [
    'Verify', 'Confirm', 'Continue', 'Submit', 'Sign in', 'Log in',
    'Verificar', 'Confirmar', 'Continuar', 'Enviar', 'Acceder', 'Entrar',
  ];

  // One box per character: 4–10 visible single-character inputs sharing a container.
  function findSplitCodeInputs() {
    const singles = Array.from(document.querySelectorAll('input')).filter(el =>
      ['text', 'tel', 'number'].includes(el.type) &&
      el.maxLength === 1 && !el.disabled && !el.readOnly && utils.isElementVisible(el)
    );
    if (singles.length < 4) return null;
    let scope = singles[0].parentElement;
    while (scope && singles.filter(el => scope.contains(el)).length < 4) scope = scope.parentElement;
    const group = scope ? singles.filter(el => scope.contains(el)) : [];
    return group.length >= 4 && group.length <= 10 ? group : null;
  }

  function findCodeInputs(authConfig = {}) {
    const split = findSplitCodeInputs();
    if (split) return split;
    const single = findVisibleInput(authConfig.otpSelector || DEFAULT_OTP_SELECTOR);
    return single ? [single] : [];
  }

  // Visible text explaining where the code went ("we sent a code to p***@x.com"). Input values
  // are not part of innerText, so a typed code can never end up here.
  function verificationHint(anchor) {
    const pick = scope => String(scope?.innerText || '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line && CODE_HINT_PATTERN.test(line));
    let scope = anchor ? (anchor.closest('form') || anchor.parentElement) : null;
    for (let depth = 0; scope && depth < 5; depth++, scope = scope.parentElement) {
      const lines = pick(scope);
      if (lines.length) return lines.join(' · ').slice(0, 300);
    }
    return pick(document.body).join(' · ').slice(0, 300);
  }

  // Shared with popup.js: is the provider waiting for a code the user receives (email/SMS)?
  // A code field is a verification step wherever it lives (/login, /login/verify, ...); without
  // one, only a form that vanished while staying on the sign-in address counts.
  // context: { url, loginStartUrl, hasOtpCredential, detectSplitInputs }
  function detectVerificationStep(authConfig = {}, context = {}) {
    const form = detectLoginForm(authConfig);
    const url = context.url || location.href;
    const split = context.detectSplitInputs ? findSplitCodeInputs() : null;
    const hasCodeField = form.hasOtp || Boolean(split);
    const awaiting = hasCodeField
      ? !context.hasOtpCredential
      : url === context.loginStartUrl && !form.hasUsername && !form.hasPassword;
    const anchor = split ? split[0] : findVisibleInput(authConfig.otpSelector || DEFAULT_OTP_SELECTOR);
    return {
      ...form,
      awaiting,
      hasCodeField,
      codeLength: split ? split.length : null,
      hint: awaiting ? verificationHint(anchor) : '',
    };
  }

  // Types a one-time code into the code field(s) of THIS document and submits, in one call:
  // the inputs are held as element references, never re-resolved by selector, so a navigation
  // cannot retarget the code (the call simply dies with its document). The sign-in domain is
  // checked again right before typing, like attemptAutoLogin does for passwords.
  async function fillVerificationCode(code, authConfig = {}, allowedLoginDomains = []) {
    const domainCheck = checkLoginFrame(allowedLoginDomains);
    if (!domainCheck.ok) return { typed: false, blocked: true, reason: domainCheck.reason, host: domainCheck.host };
    const value = typeof code === 'string' ? code : '';
    const inputs = findCodeInputs(authConfig);
    const single = inputs.length === 1 ? inputs[0] : null;
    const shape = {
      count: inputs.length,
      split: inputs.length > 1,
      maxLength: single && single.maxLength > 0 ? single.maxLength : null,
    };
    if (!shape.count) return { typed: false, reason: 'no-code-field', ...shape };
    if (shape.split && shape.count !== value.length) return { typed: false, reason: 'length', ...shape };
    if (!shape.split && shape.maxLength && shape.maxLength < value.length) return { typed: false, reason: 'length', ...shape };

    if (shape.split) {
      for (let i = 0; i < inputs.length; i++) setNativeInputValue(inputs[i], value[i]);
    } else {
      setNativeInputValue(single, value);
    }
    await sleep(150); // let the page's framework take the new values before submitting
    if (!checkLoginFrame(allowedLoginDomains).ok) return { typed: true, submitted: false, ...shape };

    const last = inputs[inputs.length - 1];
    // The boxes are gone: the page submitted by itself after the last character.
    if (!last.isConnected || !utils.isElementVisible(last)) return { typed: true, submitted: true, via: 'auto', ...shape };
    const scope = last.closest('form') || last.parentElement?.parentElement || last.parentElement;
    const button = findSubmitButton(scope, authConfig.submitSelector, CODE_SUBMIT_TEXTS);
    if (button) {
      utils.simulateRealClick(button);
      return { typed: true, submitted: true, via: 'button', ...shape };
    }
    if (last.form) {
      last.form.requestSubmit ? last.form.requestSubmit() : last.form.submit();
      return { typed: true, submitted: true, via: 'form', ...shape };
    }
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { typed: true, submitted: true, via: 'enter', ...shape };
  }

  async function attemptAutoLogin(credentials = {}, authConfig = {}) {
    const { username = '', password = '', otp = '', allowedLoginDomains = [] } = credentials;
    const domainCheck = checkLoginFrame(allowedLoginDomains);
    if (!domainCheck.ok) return loginBlocked(domainCheck);
    // Re-checked before every secret: a same-document flow could have changed frames' state.
    const stillAllowed = () => checkLoginFrame(allowedLoginDomains).ok;

    let filledUsername = false;
    let filledPassword = false;
    let filledOtp = false;
    let submitted = false;

    const userSelector = authConfig.usernameSelector || DEFAULT_USERNAME_SELECTOR;
    const passSelector = authConfig.passwordSelector || DEFAULT_PASSWORD_SELECTOR;
    const otpSelector = authConfig.otpSelector || DEFAULT_OTP_SELECTOR;

    let userEl = findVisibleInput(userSelector);
    let passEl = findVisibleInput(passSelector);
    let otpEl = findVisibleInput(otpSelector);

    if (!userEl && !passEl && !otpEl) {
      return {
        attempted: false,
        reason: 'No visible login or OTP input fields found on the current page',
      };
    }

    // Step 1: Fill username if present
    if (userEl && username) {
      if (!stillAllowed()) return loginBlocked(checkLoginFrame(allowedLoginDomains));
      setNativeInputValue(userEl, username);
      filledUsername = true;
      await sleep(150);
    }

    // Two-step login flow: username is visible, password is not yet visible
    if (filledUsername && !passEl && password) {
      const formScope = userEl.closest('form') || userEl.parentElement;
      const nextBtn = findSubmitButton(
        formScope,
        authConfig.nextSelector || authConfig.submitSelector,
        ['Continue', 'Next', 'Sign in', 'Log in', 'Siguiente', 'Continuar', 'Entrar']
      );
      if (nextBtn) {
        utils.simulateRealClick(nextBtn);
        submitted = true;
      } else {
        userEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        submitted = true;
      }

      // Poll up to 4s for password field to appear in the same page (SPA 2-step login)
      const waitStart = Date.now();
      while (Date.now() - waitStart < 4000) {
        await sleep(250);
        passEl = findVisibleInput(passSelector);
        if (passEl) break;
      }
    }

    // Step 2: Fill password if present
    if (passEl && password) {
      if (!stillAllowed()) return loginBlocked(checkLoginFrame(allowedLoginDomains));
      setNativeInputValue(passEl, password);
      filledPassword = true;
      await sleep(150);
      const formScope = passEl.closest('form') || passEl.parentElement;
      const submitBtn = findSubmitButton(
        formScope,
        authConfig.submitSelector,
        ['Sign in', 'Log in', 'Submit', 'Continue', 'Entrar', 'Iniciar sesión', 'Acceder']
      );
      if (submitBtn) {
        utils.simulateRealClick(submitBtn);
        submitted = true;
      } else if (passEl.form) {
        passEl.form.requestSubmit ? passEl.form.requestSubmit() : passEl.form.submit();
        submitted = true;
      } else {
        passEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        submitted = true;
      }

      // If we also have an OTP code, wait briefly in case an inline 2FA step appears
      if (otp) {
        const otpWaitStart = Date.now();
        while (Date.now() - otpWaitStart < 3500) {
          await sleep(250);
          otpEl = findVisibleInput(otpSelector);
          if (otpEl) break;
        }
      }
    }

    // Step 3: Fill OTP / 2FA code if present
    if (otpEl && otp) {
      if (!stillAllowed()) return loginBlocked(checkLoginFrame(allowedLoginDomains));
      setNativeInputValue(otpEl, otp);
      filledOtp = true;
      await sleep(150);
      const formScope = otpEl.closest('form') || otpEl.parentElement;
      const otpSubmitBtn = findSubmitButton(
        formScope,
        authConfig.submitSelector,
        ['Verify', 'Continue', 'Submit', 'Sign in', 'Verificar', 'Continuar', 'Confirm']
      );
      if (otpSubmitBtn) {
        utils.simulateRealClick(otpSubmitBtn);
        submitted = true;
      }
    }

    return {
      attempted: filledUsername || filledPassword || filledOtp,
      filledUsername,
      filledPassword,
      filledOtp,
      submitted,
    };
  }

  function verifyLoggedInIdentity(expectedIdentity = {}, authConfig = {}) {
    const expectedUser = String(expectedIdentity.username || '').trim().toLowerCase();
    const prevUser = String(expectedIdentity.previousUsername || '').trim().toLowerCase();

    let storageDump = '';
    try {
      const parts = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        parts.push(String(window.localStorage.getItem(k) || ''));
      }
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        parts.push(String(window.sessionStorage.getItem(k) || ''));
      }
      storageDump = parts.join(' ').toLowerCase();
    } catch {}

    const bodyText = String(document.body?.innerText || '').toLowerCase();
    let hintText = '';
    if (authConfig.accountHintSelector) {
      try {
        hintText = Array.from(document.querySelectorAll(authConfig.accountHintSelector))
          .map(el => (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim())
          .join(' ')
          .toLowerCase();
      } catch {}
    }

    const combinedText = `${hintText} ${bodyText} ${storageDump}`;
    const foundExpected = Boolean(expectedUser && combinedText.includes(expectedUser));
    const foundPreviousUser = Boolean(
      prevUser && prevUser !== expectedUser && combinedText.includes(prevUser)
    );

    let hintEmailMismatch = false;
    if (hintText && expectedUser.includes('@')) {
      const emailsInHint = hintText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
      if (emailsInHint.length > 0 && !emailsInHint.includes(expectedUser)) {
        hintEmailMismatch = true;
      }
    }

    const mismatchDetected = (foundPreviousUser && !foundExpected) || hintEmailMismatch;
    return {
      matchesExpected: !mismatchDetected,
      mismatchDetected,
      foundExpected,
      foundPreviousUser,
      hintEmailMismatch,
    };
  }

  async function clearPageSessionData() {
    try { window.localStorage.clear(); } catch {}
    try { window.sessionStorage.clear(); } catch {}
    try {
      const cookies = (document.cookie || '').split(';');
      const hostParts = window.location.hostname.split('.');
      const rootDomain = hostParts.length >= 2 ? `.${hostParts.slice(-2).join('.')}` : window.location.hostname;
      for (const raw of cookies) {
        const eqIdx = raw.indexOf('=');
        const name = (eqIdx > -1 ? raw.slice(0, eqIdx) : raw).trim();
        if (!name) continue;
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${window.location.hostname}`;
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${rootDomain}`;
      }
    } catch {}
    try {
      if (window.indexedDB?.databases) {
        const dbs = await window.indexedDB.databases();
        for (const db of dbs || []) {
          if (db?.name) {
            try { window.indexedDB.deleteDatabase(db.name); } catch {}
          }
        }
      }
    } catch {}
    return { cleared: true };
  }

  // Expose step API to window for popup.js
  window.__invoiceEngine = {
    extractRows,
    executeStep,
    clickInRow,
    queryElement,
    getPaginationOptions,
    selectPaginationOption,
    clickNext,
    detectLoginForm,
    detectVerificationStep,
    fillVerificationCode,
    attemptAutoLogin,
    verifyLoggedInIdentity,
    clearPageSessionData,
  };
})();
