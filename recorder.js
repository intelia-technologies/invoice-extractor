// =====================================================
// INVOICE RECORDER — Content script for record mode
// Captures user interactions for provider JSON generation
// =====================================================
(function() {
  'use strict';

  // Avoid double-injection
  if (window.__invoiceRecorder) return;

  const MAX_SNAPSHOT_LENGTH = 50000; // 50KB per snapshot
  const SENSITIVE_PARAM_PATTERNS = /^(token|key|session|auth|sig|signature|secret|password|pwd|api_key|apikey|access_token|refresh_token|csrf|nonce|code)$/i;
  const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const SENSITIVE_DATA_ATTR_PATTERNS = /token|session|auth|key|secret|csrf|nonce/i;

  const recordingData = {
    actions: [],
    domSnapshots: [],
    networkRequests: [],
    downloads: []
  };

  let isRecording = false;
  let startTime = null;
  let clickListener = null;
  let performanceObserver = null;
  let originalWindowOpen = null;
  let originalCreateObjectURL = null;

  function ts() {
    return startTime ? Date.now() - startTime : 0;
  }

  // =====================================================
  // CSS SELECTOR GENERATOR
  // =====================================================
  function generateSelector(el) {
    if (!el || el === document.documentElement || el === document.body) return null;

    // 1. ID (if unique)
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return `#${CSS.escape(el.id)}`;
    }

    // 2. data-test-id or data-testid
    for (const attr of ['data-test-id', 'data-testid', 'data-automation-id']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${CSS.escape(val)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 3. Build a path from the element up to an identifiable ancestor
    const parts = [];
    let current = el;
    for (let depth = 0; depth < 8 && current && current !== document.body; depth++) {
      const part = selectorPart(current);
      parts.unshift(part);

      // Check if the path so far is unique
      const candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) { /* invalid selector, keep building */ }

      current = current.parentElement;
    }

    // 4. Fallback: full nth-child path
    return nthChildPath(el);
  }

  function selectorPart(el) {
    const tag = el.tagName.toLowerCase();

    // Try ID
    if (el.id) return `${tag}#${CSS.escape(el.id)}`;

    // Try meaningful classes (skip utility/generated classes)
    const classes = Array.from(el.classList)
      .filter(c => c.length > 2 && c.length < 40 && !/^[a-z]{1,2}-/.test(c) && !/^\d/.test(c))
      .slice(0, 3);
    if (classes.length > 0) {
      return `${tag}.${classes.map(c => CSS.escape(c)).join('.')}`;
    }

    // Try tag + nth-child
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName);
      if (siblings.length === 1) return tag;
      const index = siblings.indexOf(el) + 1;
      return `${tag}:nth-child(${index})`;
    }

    return tag;
  }

  function nthChildPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 10) {
      const parent = current.parentElement;
      if (!parent) break;
      const index = Array.from(parent.children).indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      current = parent;
    }
    return parts.join(' > ');
  }

  // =====================================================
  // SANITIZATION
  // =====================================================
  function sanitizeUrl(url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      // Strip sensitive query params
      const paramsToRemove = [];
      for (const [key] of u.searchParams) {
        if (SENSITIVE_PARAM_PATTERNS.test(key)) {
          paramsToRemove.push(key);
        }
      }
      for (const key of paramsToRemove) {
        u.searchParams.set(key, '[REDACTED]');
      }
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function sanitizeText(text) {
    if (!text) return text;
    return text.replace(EMAIL_PATTERN, '[EMAIL]');
  }

  function sanitizeHtml(html) {
    if (!html) return html;
    // Remove data-* attributes that might contain tokens
    let cleaned = html.replace(/\s+data-[\w-]+="[^"]*"/g, (match) => {
      const attrName = match.match(/data-[\w-]+/)?.[0] || '';
      if (SENSITIVE_DATA_ATTR_PATTERNS.test(attrName)) return '';
      // Keep non-sensitive data attributes (data-test-id, etc.)
      return match;
    });
    // Remove inline styles with URLs (potential tracking pixels)
    cleaned = cleaned.replace(/style="[^"]*url\([^)]*\)[^"]*"/gi, 'style=""');
    // Redact emails
    cleaned = sanitizeText(cleaned);
    return cleaned;
  }

  // =====================================================
  // CLICK CAPTURE
  // =====================================================
  function startClickCapture() {
    clickListener = (e) => {
      if (!isRecording) return;

      const el = e.target;
      const selector = generateSelector(el);
      const closestLink = el.closest('a');

      // Detect if click is inside a modal/dialog
      const closestDialog = el.closest('[role="dialog"], .modal-dialog, .b3-modal-dialog');

      const action = {
        type: 'click',
        timestamp: ts(),
        tag: el.tagName.toLowerCase(),
        text: sanitizeText((el.textContent || '').trim().slice(0, 200)),
        selector: selector,
        href: closestLink ? sanitizeUrl(closestLink.href) : null,
        // Tag the frame context so we know where this click happened
        frameOrigin: location.origin,
        framePath: location.pathname.slice(0, 80),
        inDialog: !!closestDialog,
        dialogClass: closestDialog ? closestDialog.className.slice(0, 100) : null
      };

      // Detect download-related clicks
      if (closestLink) {
        if (closestLink.hasAttribute('download')) {
          action.isDownload = true;
          action.downloadAttr = closestLink.getAttribute('download');
          recordingData.downloads.push({
            timestamp: ts(),
            method: 'direct-link',
            url: sanitizeUrl(closestLink.href),
            filename: closestLink.getAttribute('download') || null,
            selector: generateSelector(closestLink)
          });
        } else if (closestLink.href && /\.(pdf|csv|xlsx?)$/i.test(closestLink.href)) {
          action.isDownload = true;
          recordingData.downloads.push({
            timestamp: ts(),
            method: 'direct-link',
            url: sanitizeUrl(closestLink.href),
            filename: closestLink.href.split('/').pop().split('?')[0],
            selector: generateSelector(closestLink)
          });
        }
      }

      recordingData.actions.push(action);

      // Capture DOM snapshot around the clicked element
      captureDomAroundClick(el);
    };
    document.addEventListener('click', clickListener, true);
  }

  function stopClickCapture() {
    if (clickListener) {
      document.removeEventListener('click', clickListener, true);
      clickListener = null;
    }
  }

  // =====================================================
  // DOM SNAPSHOT CAPTURE
  // =====================================================
  function captureInitialSnapshot() {
    // Find the main content area
    const mainContent = document.querySelector('main, [role="main"], .main-content, #content, #app, .app')
      || document.body;

    // Capture all tables and list structures
    const tables = Array.from(document.querySelectorAll('table')).map(t => ({
      selector: generateSelector(t),
      rowCount: t.querySelectorAll('tr').length,
      sample: sanitizeHtml(t.outerHTML.slice(0, 2000))
    }));

    recordingData.domSnapshots.push({
      timestamp: 0,
      type: 'initial',
      title: document.title,
      url: sanitizeUrl(location.href),
      tables: tables
    });
  }

  function captureDomAroundClick(el) {
    // Find the closest meaningful container
    const container = el.closest('table, ul, ol, [role="list"], [role="grid"], section, .list, .table, .grid')
      || el.parentElement;
    if (!container) return;

    let html = container.outerHTML;
    // Truncate if too large
    if (html.length > MAX_SNAPSHOT_LENGTH) {
      html = html.slice(0, MAX_SNAPSHOT_LENGTH) + '<!-- truncated -->';
    }

    recordingData.domSnapshots.push({
      timestamp: ts(),
      type: 'click-context',
      selector: generateSelector(container),
      html: sanitizeHtml(html)
    });
  }

  // =====================================================
  // NETWORK CAPTURE
  // =====================================================
  function startNetworkCapture() {
    try {
      performanceObserver = new PerformanceObserver((list) => {
        if (!isRecording) return;
        for (const entry of list.getEntries()) {
          const url = sanitizeUrl(entry.name);
          const isPdf = /\.(pdf)(\?|$)/i.test(entry.name) || false;
          const isDocument = /\.(pdf|doc|docx|csv|xlsx?)(\?|$)/i.test(entry.name) || false;

          recordingData.networkRequests.push({
            timestamp: ts(),
            url: url,
            initiatorType: entry.initiatorType,
            duration: Math.round(entry.duration),
            transferSize: entry.transferSize || 0,
            isPdf: isPdf,
            isDocument: isDocument
          });

          // Auto-detect fetch-blob downloads
          if ((isPdf || isDocument) && entry.initiatorType === 'fetch') {
            recordingData.downloads.push({
              timestamp: ts(),
              method: 'fetch-blob',
              url: url,
              filename: url.split('/').pop().split('?')[0]
            });
          }
        }
      });
      performanceObserver.observe({ type: 'resource', buffered: false });
    } catch (e) {
      console.warn('[Recorder] PerformanceObserver not available:', e);
    }
  }

  function stopNetworkCapture() {
    if (performanceObserver) {
      performanceObserver.disconnect();
      performanceObserver = null;
    }
  }

  // =====================================================
  // DOWNLOAD DETECTION — window.open & blob URLs
  // =====================================================
  function startDownloadDetection() {
    // Intercept window.open
    originalWindowOpen = window.open;
    window.open = function(url, ...args) {
      if (isRecording && url) {
        recordingData.downloads.push({
          timestamp: ts(),
          method: 'open-tabs',
          url: sanitizeUrl(url),
          filename: null
        });
        recordingData.actions.push({
          type: 'window-open',
          timestamp: ts(),
          url: sanitizeUrl(url)
        });
      }
      return originalWindowOpen.call(this, url, ...args);
    };

    // Intercept URL.createObjectURL for blob detection
    originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
      const blobUrl = originalCreateObjectURL.call(this, blob);
      if (isRecording && blob) {
        recordingData.downloads.push({
          timestamp: ts(),
          method: 'fetch-blob',
          url: '[blob]',
          blobType: blob.type || 'unknown',
          blobSize: blob.size || 0
        });
      }
      return blobUrl;
    };
  }

  function stopDownloadDetection() {
    if (originalWindowOpen) {
      window.open = originalWindowOpen;
      originalWindowOpen = null;
    }
    if (originalCreateObjectURL) {
      URL.createObjectURL = originalCreateObjectURL;
      originalCreateObjectURL = null;
    }
  }

  // =====================================================
  // DIALOG / MODAL OBSERVER — detect dynamically added dialogs
  // =====================================================
  let dialogObserver = null;

  function startDialogObserver() {
    dialogObserver = new MutationObserver((mutations) => {
      if (!isRecording) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node;
          // Check if this is a dialog/modal being added
          const isDialog = el.matches?.('[role="dialog"], .modal-dialog, .b3-modal-dialog') ||
            el.querySelector?.('[role="dialog"], .modal-dialog, .b3-modal-dialog');
          if (isDialog) {
            const dialog = el.matches?.('[role="dialog"], .modal-dialog') ? el :
              el.querySelector('[role="dialog"], .modal-dialog');
            if (dialog) {
              const dialogText = (dialog.textContent || '').trim();
              const buttons = Array.from(dialog.querySelectorAll('[role="button"], button, .jfk-button')).map(b => ({
                tag: b.tagName.toLowerCase(),
                text: sanitizeText((b.textContent || '').trim().slice(0, 60)),
                class: b.className?.slice(0, 100) || '',
                selector: generateSelector(b)
              }));

              // Detect OOPIF dialogs: container exists but has no visible text/buttons
              // because the content is rendered in a child cross-origin iframe
              const childIframes = dialog.querySelectorAll('iframe');
              const oopifInfo = Array.from(childIframes).map(f => ({
                id: f.id || null,
                src: (f.getAttribute('src') || '').slice(0, 80),
                width: f.offsetWidth,
                height: f.offsetHeight,
                visible: f.offsetWidth > 0 && f.offsetHeight > 0,
                parentClass: f.parentElement?.className?.slice(0, 100) || ''
              })).filter(f => f.visible);

              const dialogEntry = {
                type: 'dialog-appeared',
                timestamp: ts(),
                frameOrigin: location.origin,
                framePath: location.pathname.slice(0, 80),
                dialogClass: dialog.className?.slice(0, 150) || '',
                dialogText: sanitizeText(dialogText.slice(0, 300)),
                isOopif: dialogText.length === 0 && oopifInfo.length > 0,
                oopifIframes: oopifInfo.length > 0 ? oopifInfo : undefined,
                buttons: buttons
              };
              recordingData.actions.push(dialogEntry);

              // Re-check after delay — OOPIF iframes are often added after the
              // dialog container, so the initial scan misses them
              if (dialogText.length === 0 && oopifInfo.length === 0) {
                setTimeout(() => {
                  if (!isRecording) return;
                  const laterIframes = dialog.querySelectorAll('iframe');
                  const laterInfo = Array.from(laterIframes).map(f => ({
                    id: f.id || null,
                    src: (f.getAttribute('src') || '').slice(0, 80),
                    width: f.offsetWidth,
                    height: f.offsetHeight,
                    visible: f.offsetWidth > 0 && f.offsetHeight > 0,
                    parentClass: f.parentElement?.className?.slice(0, 100) || ''
                  })).filter(f => f.visible);
                  if (laterInfo.length > 0) {
                    dialogEntry.isOopif = true;
                    dialogEntry.oopifIframes = laterInfo;
                  }
                  // Also re-check buttons (they may be inside the now-loaded iframe)
                  const laterButtons = Array.from(dialog.querySelectorAll('[role="button"], button, .jfk-button')).map(b => ({
                    tag: b.tagName.toLowerCase(),
                    text: sanitizeText((b.textContent || '').trim().slice(0, 60)),
                    class: b.className?.slice(0, 100) || '',
                    selector: generateSelector(b)
                  }));
                  if (laterButtons.length > dialogEntry.buttons.length) {
                    dialogEntry.buttons = laterButtons;
                  }
                  const laterText = (dialog.textContent || '').trim();
                  if (laterText.length > 0 && dialogEntry.dialogText.length === 0) {
                    dialogEntry.dialogText = sanitizeText(laterText.slice(0, 300));
                  }
                }, 500);
              }
            }
          }
        }
      }
    });
    dialogObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function stopDialogObserver() {
    if (dialogObserver) {
      dialogObserver.disconnect();
      dialogObserver = null;
    }
  }

  // =====================================================
  // SMART ANALYSIS — pre-identify patterns for the LLM
  // =====================================================
  const DATE_PATTERNS = [
    { format: 'M/D/YYYY', regex: /\b\d{1,2}\/\d{1,2}\/\d{4}\b/ },
    { format: 'YYYY-MM-DD', regex: /\b\d{4}-\d{2}-\d{2}\b/ },
    { format: 'MMM DD, YYYY', regex: /\b[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}\b/ },
    { format: 'Month D, YYYY', regex: /\b[A-Z][a-z]+\s+\d{1,2},?\s+\d{4}\b/ },
    { format: 'Month YYYY', regex: /\b[A-Z][a-z]+\s+\d{4}\b/ },
    { format: 'range', regex: /\b[A-Z][a-z]{2}\s+\d{1,2}\s*[–—-]\s*[A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4}\b/ }
  ];

  function analyzeRecording() {
    const analysis = {
      invoiceTableCandidates: [],
      dateFormatDetected: null,
      downloadMethodDetected: null,
      readySelectorCandidates: []
    };

    // 1. Auto-detect invoice table
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      if (rows.length >= 2) { // At least header + 1 row
        const selector = generateSelector(table);
        const rowSelector = `${selector} tbody tr`;
        const bodyRows = table.querySelectorAll('tbody tr');
        const sampleRow = bodyRows[0] || rows[1];
        analysis.invoiceTableCandidates.push({
          selector: selector,
          rowSelector: rowSelector,
          rowCount: bodyRows.length || rows.length - 1,
          sample: sanitizeText(sampleRow?.textContent?.trim().slice(0, 200) || ''),
          interactiveElements: sampleRow ? scanInteractiveElements(sampleRow) : []
        });
      }
    }

    // Also check for list-like structures
    const listContainers = document.querySelectorAll('[class*="invoice"], [class*="billing"], [class*="payment"], [class*="receipt"]');
    for (const container of listContainers) {
      const repeatedChildren = findRepeatedChildren(container);
      if (repeatedChildren.length >= 2) {
        analysis.invoiceTableCandidates.push({
          selector: generateSelector(container),
          rowSelector: generateSelector(repeatedChildren[0]),
          rowCount: repeatedChildren.length,
          sample: sanitizeText(repeatedChildren[0].textContent?.trim().slice(0, 200) || ''),
          interactiveElements: scanInteractiveElements(repeatedChildren[0])
        });
      }
    }

    // Sort by row count (most rows first — likely the invoice table)
    analysis.invoiceTableCandidates.sort((a, b) => b.rowCount - a.rowCount);
    analysis.invoiceTableCandidates = analysis.invoiceTableCandidates.slice(0, 5);

    // 2. Auto-detect date format
    const allText = document.body.textContent || '';
    for (const { format, regex } of DATE_PATTERNS) {
      if (regex.test(allText)) {
        analysis.dateFormatDetected = format;
        break; // First match wins (patterns ordered by specificity)
      }
    }

    // 3. Auto-detect download method
    if (recordingData.downloads.length > 0) {
      const methods = recordingData.downloads.map(d => d.method);
      // Most common method
      const counts = {};
      for (const m of methods) counts[m] = (counts[m] || 0) + 1;
      analysis.downloadMethodDetected = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    }

    // 4. Auto-detect readySelector
    // Find the most specific, stable selector for a visible element
    const candidates = [];

    // Tables with data-* attributes
    for (const table of tables) {
      for (const attr of ['data-automation-id', 'data-test-id', 'data-testid', 'id']) {
        if (table.getAttribute(attr)) {
          candidates.push(generateSelector(table));
          break;
        }
      }
    }

    // Containers with billing/invoice classes
    for (const el of listContainers) {
      const sel = generateSelector(el);
      if (sel) candidates.push(sel);
    }

    // Fallback: first h1/h2 on the page
    const heading = document.querySelector('h1, h2');
    if (heading) candidates.push(generateSelector(heading));

    analysis.readySelectorCandidates = [...new Set(candidates)].slice(0, 5);

    // 5. Row pattern detection — when user clicked inside a table/list
    analysis.rowPattern = null;
    const clickedRows = new Set();
    for (const action of recordingData.actions) {
      if (action.type !== 'click' || !action.selector) continue;
      try {
        const clickedEl = document.querySelector(action.selector);
        if (!clickedEl) continue;
        // Find the closest row-like container
        const row = clickedEl.closest('tr, li, [class*="row"], [class*="item"], [role="row"]');
        if (row) clickedRows.add(row);
      } catch (e) {}
    }
    if (clickedRows.size > 0) {
      // Pick the first clicked row and find all siblings matching same pattern
      const sampleRow = clickedRows.values().next().value;
      const parent = sampleRow.parentElement;
      if (parent) {
        const tag = sampleRow.tagName;
        const cls = Array.from(sampleRow.classList).sort().join('.');
        const siblings = Array.from(parent.children).filter(ch => {
          return ch.tagName === tag && Array.from(ch.classList).sort().join('.') === cls;
        });
        if (siblings.length >= 2) {
          const rowSelector = generateSelector(siblings[0]);
          // Try to generalize: replace nth-child with a class-based selector
          let generalSelector = rowSelector;
          if (cls) {
            const classSelector = `${tag.toLowerCase()}.${cls.split('.').map(c => CSS.escape(c)).join('.')}`;
            try {
              if (document.querySelectorAll(classSelector).length === siblings.length) {
                generalSelector = classSelector;
              }
            } catch (e) {}
          }

          // Capture sample HTML (2-3 rows, truncated)
          const sampleHtml = siblings.slice(0, 3).map(r => sanitizeHtml(r.outerHTML.slice(0, 3000)));

          // Field role classification
          const fields = [];
          const AMOUNT_PATTERN = /[$€£¥]\s*[\d,.]+|[\d,.]+\s*[$€£¥]|[\d]+[.,]\d{2}\b/;
          for (const sample of siblings.slice(0, 2)) {
            // Scan text nodes for date and amount patterns
            const cells = sample.querySelectorAll('td, span, div, p, a, time');
            for (const cell of cells) {
              const text = (cell.textContent || '').trim();
              if (!text || text.length > 200) continue;
              const cellSelector = generateSelector(cell);
              // Date detection
              for (const { format, regex } of DATE_PATTERNS) {
                if (regex.test(text)) {
                  if (!fields.find(f => f.role === 'date')) {
                    fields.push({ selector: cellSelector, role: 'date', sampleValue: sanitizeText(text.slice(0, 60)), format });
                  }
                  break;
                }
              }
              // Amount detection
              if (AMOUNT_PATTERN.test(text)) {
                if (!fields.find(f => f.role === 'amount')) {
                  fields.push({ selector: cellSelector, role: 'amount', sampleValue: sanitizeText(text.slice(0, 40)) });
                }
              }
            }
            // Link detection
            const links = sample.querySelectorAll('a[href]');
            for (const link of links) {
              const href = link.getAttribute('href') || '';
              if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                fields.push({
                  selector: generateSelector(link),
                  role: link.hasAttribute('download') || /\.(pdf|csv|xlsx?)(\?|$)/i.test(href) ? 'download-link' : 'link',
                  sampleValue: sanitizeUrl(href).slice(0, 80)
                });
              }
            }
          }

          analysis.rowPattern = {
            selector: generalSelector,
            sampleCount: siblings.length,
            sampleHtml,
            fields
          };
        }
      }
    }

    // 6. Download flow grouping — group sequential clicks within 5s into flows
    analysis.downloadFlows = [];
    let currentFlow = null;
    for (const action of recordingData.actions) {
      if (action.type === 'click' || action.type === 'window-open') {
        if (!currentFlow || action.timestamp - currentFlow.lastTimestamp > 5000) {
          currentFlow = { steps: [], resultType: null, lastTimestamp: action.timestamp };
          analysis.downloadFlows.push(currentFlow);
        }
        currentFlow.steps.push({
          action: action.type === 'window-open' ? 'window-open' : 'click',
          selector: action.selector || null,
          text: action.text ? sanitizeText(action.text.slice(0, 60)) : null,
          scope: action.inDialog ? 'dialog' : 'document',
          timestamp: action.timestamp
        });
        currentFlow.lastTimestamp = action.timestamp;
      } else if (action.type === 'dialog-appeared' && currentFlow) {
        currentFlow.steps.push({
          action: 'dialog-appeared',
          dialogClass: action.dialogClass || null,
          timestamp: action.timestamp
        });
        currentFlow.lastTimestamp = action.timestamp;
      }
    }
    // Classify flow result types
    for (const flow of analysis.downloadFlows) {
      const hasWindowOpen = flow.steps.some(s => s.action === 'window-open');
      const hasDialog = flow.steps.some(s => s.action === 'dialog-appeared');
      if (hasWindowOpen) flow.resultType = 'window-open';
      else if (hasDialog) flow.resultType = 'dialog';
      else if (recordingData.downloads.some(d => d.method === 'fetch-blob' && Math.abs(d.timestamp - flow.lastTimestamp) < 3000)) flow.resultType = 'fetch';
      else if (recordingData.downloads.some(d => d.method === 'direct-link' && Math.abs(d.timestamp - flow.lastTimestamp) < 3000)) flow.resultType = 'direct-link';
      delete flow.lastTimestamp;
    }
    // Only keep flows with 2+ steps (single clicks aren't download flows)
    analysis.downloadFlows = analysis.downloadFlows.filter(f => f.steps.length >= 2);

    // 7. Step trace — ordered step entries mapping to provider JSON download.steps[] format
    analysis.stepTrace = recordingData.actions
      .filter(a => a.type === 'click' || a.type === 'dialog-appeared')
      .map((a, i, arr) => ({
        action: a.type === 'dialog-appeared' ? 'waitFor' : 'click',
        selector: a.selector || a.dialogClass || null,
        scope: a.inDialog ? 'dialog' : (a.frameOrigin !== location.origin ? 'main-frame' : 'document'),
        text: a.text ? sanitizeText(a.text.slice(0, 60)) : null,
        timing: i > 0 ? a.timestamp - arr[i - 1].timestamp : 0,
        result: a.isDownload ? 'download' : a.type === 'dialog-appeared' ? 'dialog' : null
      }));

    // 8. Auto-detect pagination elements
    analysis.paginationCandidates = [];

    // 5a. Native <select> elements with year/period options (e.g., Amazon year filter)
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const options = Array.from(sel.options);
      if (options.length < 2) continue;
      const texts = options.map(o => o.text.trim());
      const hasYears = options.some(o => /^(19|20)\d{2}$/.test(o.text.trim()));
      const hasPeriods = options.some(o => /month|mes|day|día|semana|week|quarter|trimestre|last|últim/i.test(o.text));
      if (hasYears || hasPeriods) {
        analysis.paginationCandidates.push({
          type: 'select-filter',
          selector: sel.id ? `#${sel.id}` : generateSelector(sel),
          options: texts.slice(0, 10),
          hasYears,
          hasPeriods
        });
      }
    }

    // 5b. Custom dropdown buttons with year/period text
    const dropdownBtns = document.querySelectorAll('.a-button-dropdown, [role="combobox"], [aria-haspopup="listbox"], button[class*="dropdown"], [class*="dropdown-trigger"]');
    for (const btn of dropdownBtns) {
      const text = btn.textContent.trim();
      if (/\d{4}|month|mes|year|año|period|últim|last/i.test(text)) {
        analysis.paginationCandidates.push({
          type: 'dropdown-filter',
          selector: btn.id ? `#${btn.id}` : generateSelector(btn),
          text: sanitizeText(text.substring(0, 60))
        });
      }
    }

    // 5c. Next/Previous page links
    const paginationContainers = document.querySelectorAll('.a-pagination, [class*="pagination"], [role="navigation"], nav[aria-label*="pag"], .pager, .page-nav');
    for (const nav of paginationContainers) {
      const links = Array.from(nav.querySelectorAll('a')).slice(0, 10);
      const items = links.map(a => ({ text: sanitizeText(a.textContent.trim().substring(0, 30)), selector: generateSelector(a) }));
      // Find the "next" link
      const nextLink = links.find(a => /next|siguiente|›|»|→/i.test(a.textContent));
      analysis.paginationCandidates.push({
        type: 'page-nav',
        containerSelector: generateSelector(nav),
        nextSelector: nextLink ? generateSelector(nextLink) : null,
        items
      });
    }

    return analysis;
  }

  // Scan interactive elements (buttons, links) within and around a row
  function scanInteractiveElements(row) {
    const elements = [];
    const interactive = 'a[href], button, [role="button"], [role="menuitem"], input[type="submit"]';

    // 1. Elements WITHIN the row
    for (const el of row.querySelectorAll(interactive)) {
      elements.push(describeElement(el, row, 'inside'));
    }

    // 2. Elements in SIBLING containers (MUI action panels render as siblings)
    const parent = row.parentElement;
    if (parent) {
      for (const sibling of parent.children) {
        if (sibling === row) continue;
        // Only scan siblings that have interactive elements
        for (const el of sibling.querySelectorAll(interactive)) {
          elements.push(describeElement(el, parent, 'sibling'));
        }
      }
    }

    return elements;
  }

  function describeElement(el, scopeRoot, location) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';

    return {
      tag: el.tagName.toLowerCase(),
      text: sanitizeText((el.textContent || '').trim().slice(0, 100)),
      classes: Array.from(el.classList).filter(c => c.length > 2 && c.length < 50).slice(0, 5),
      ariaLabel: el.getAttribute('aria-label') || null,
      ariaControls: el.getAttribute('aria-controls') || null,
      ariaHaspopup: el.getAttribute('aria-haspopup') || null,
      role: el.getAttribute('role') || null,
      href: el.tagName === 'A' ? sanitizeUrl(el.getAttribute('href')) : null,
      hasDownloadAttr: el.hasAttribute('download'),
      visible: visible,
      location: location // 'inside' = within row, 'sibling' = in sibling panel
    };
  }

  function findRepeatedChildren(container) {
    // Find children that share the same tag + class pattern (repeated rows/items)
    const children = Array.from(container.children);
    if (children.length < 2) return [];

    const groups = {};
    for (const child of children) {
      const key = `${child.tagName}.${Array.from(child.classList).sort().join('.')}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(child);
    }

    // Return the largest group
    const largest = Object.values(groups).sort((a, b) => b.length - a.length)[0];
    return (largest && largest.length >= 2) ? largest : [];
  }

  // =====================================================
  // RECORDING CONTROL
  // =====================================================
  function start() {
    // If already recording, don't reset — just ensure listeners are active
    if (isRecording) return { success: true, alreadyRecording: true };

    isRecording = true;
    startTime = Date.now();

    // Reset data
    recordingData.actions = [];
    recordingData.domSnapshots = [];
    recordingData.networkRequests = [];
    recordingData.downloads = [];

    captureInitialSnapshot();
    startClickCapture();
    startNetworkCapture();
    startDownloadDetection();
    startDialogObserver();

    return { success: true };
  }

  function stop() {
    if (!isRecording) return { success: false, error: 'Not recording' };
    isRecording = false;

    stopClickCapture();
    stopNetworkCapture();
    stopDownloadDetection();
    stopDialogObserver();

    // Run smart analysis before packaging
    const analysis = analyzeRecording();

    return {
      success: true,
      data: {
        version: '1.0',
        timestamp: new Date().toISOString(),
        billingUrl: sanitizeUrl(location.href),
        pageTitle: document.title,
        duration: ts(),
        actions: recordingData.actions,
        domSnapshots: recordingData.domSnapshots,
        networkRequests: recordingData.networkRequests,
        downloads: recordingData.downloads,
        analysis: analysis
      }
    };
  }

  function getStatus() {
    return {
      isRecording,
      clickCount: recordingData.actions.filter(a => a.type === 'click').length,
      networkCount: recordingData.networkRequests.length,
      downloadCount: recordingData.downloads.length,
      duration: ts()
    };
  }

  // Expose API
  window.__invoiceRecorder = { start, stop, getStatus, analyzeRecording };
})();
