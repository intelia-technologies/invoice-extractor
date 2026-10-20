# Invoice Extractor — Chrome Extension

## Project Overview

Chrome extension that automatically downloads invoices from SaaS billing pages. Providers are defined declaratively in JSON files — the engine interprets them generically.

**Key advantage over alternatives:** The user is already logged into Chrome. No auth management needed.

## Architecture

```
invoice-extractor/
├── manifest.json              # Chrome extension manifest (MV3)
├── popup.html                 # UI: config panel + workflow progress
├── popup.js                   # Workflow orchestration, downloads, state
├── utils.js                   # Shared DOM helpers (MAIN world)
├── engine.js                  # Step-based provider engine (MAIN world)
├── recorder.js                # Recording mode for provider creation
├── providers/                 # One JSON file per provider
│   ├── webflow.json
│   ├── shortcut.json
│   ├── elastic.json
│   ├── zerossl.json
│   ├── vultr.json
│   ├── vonage.json
│   └── hover.json
├── icons/
└── .claude/
```

### Four layers

1. **Provider JSON** — declarative definition of how to extract invoices from a billing page
2. **Utils** (`utils.js`) — shared DOM helpers: `simulateRealClick`, `textMatches`, `isElementVisible`, `waitForElement`. Injected into MAIN world as `window.__invoiceUtils`
3. **Engine** (`engine.js`) — step-based API: `extractRows`, `executeStep`, `clickInRow`, `queryElement`, pagination. Injected into MAIN world as `window.__invoiceEngine`. No download logic — reads DOM only
4. **Orchestrator** (`popup.js`) — drives engine step-by-step, handles ALL downloads via `chrome.downloads`/`chrome.debugger`/`chrome.tabs`, manages workflow state and UI

## Provider JSON Schema

Each provider is a JSON file in `providers/` with this structure:

```json
{
  "id": "unique-slug",
  "name": "Display Name",
  "icon": "emoji",
  "billingUrl": "https://example.com/billing",
  "readySelector": "CSS selector that indicates page is loaded",
  "config": {
    "fieldName": { "title": "Label", "type": "string", "default": "" }
  },
  "extract": {
    "preSteps": [
      { "action": "click", "selector": "CSS", "wait": 2000 }
    ],
    "rows": "CSS selector for invoice rows",
    "fields": {
      "date": { "selector": "CSS", "attr": "textContent" },
      "amount": { "selector": "CSS" },
      "downloadUrl": { "selector": "CSS", "attr": "href", "resolve": true }
    },
    "dateFormat": "auto | M/D/YYYY | MMM DD, YYYY | YYYY-MM-DD | Month YYYY | range",
    "dedup": "downloadUrl"
  },
  "download": {
    "method": "direct-link | fetch-blob | open-tabs | print-page | debugger-print",
    "filenameTemplate": "{{name}}_Invoice_{{date}}.pdf"
  }
}
```

### Download methods

- `direct-link` — `<a download>` click (Webflow, Elastic, ZeroSSL)
- `fetch-blob` — `fetch()` with credentials + blob download (Vultr, Vonage)
- `open-tabs` — Opens URLs in new tabs for manual download (Shortcut)
- `print-page` — Opens receipt page + triggers print dialog
- `debugger-print` — Uses `chrome.debugger` + `Page.printToPDF` for automatic PDF generation (Hover)
- `chrome-download` — Opens URL in a background tab, waits for the browser-initiated download (OpenAI, Shortcut)
- `click-download` — Drives in-row clicks (open row menu → click download) for rows with no extractable URL (Stripe, Amazon, Twilio, Naturgy)

### Adding a new provider

1. Navigate to the provider's billing page in Chrome
2. Open DevTools, inspect the invoice table/list
3. Create a JSON file in `providers/` following the schema
4. Reload extension — the provider appears automatically

## Key Commands

- Load extension: `chrome://extensions` → Load unpacked → select this directory
- After editing: click the refresh icon on the extension card in `chrome://extensions`

## Slash Commands

- `/commit` - Commit task-related changes
- `/pr` - Create a pull request
- `/spec` - Interview to build a project specification
- `/split` - Split a long function into smaller functions
- `/backlog` - Convert a plan into plan.md with checkboxes
- `/triage` - Interactively triage and prioritize findings

## Workflows

- `/workflows:brainstorm` - Explore WHAT to build (collaborative dialogue)
- `/workflows:plan` - Plan HOW to build (structured implementation plan)
- `/workflows:work` - Execute a plan (incremental commits + verification)
- `/workflows:compound` - Capture what was learned (persist learnings)
- `/workflows:review` - Code review (schema compliance + engine correctness)

See `.claude/commands/workflows/README.md` for the full pipeline documentation.

## Skills

- **add-provider** - Add a new invoice provider via Chrome DOM inspection
- **implement** - Execute implementation work from a plan file

## Development Guidelines

- **No hardcoded provider logic** — all provider-specific behavior lives in JSON files
- **Engine stays generic** — if a new provider needs a new pattern, extend the engine schema rather than adding provider-specific code
- **Quality over quantity** — make each provider work perfectly before adding more
- **Test with real pages** — always verify against the actual billing page, not assumptions about DOM structure

## Chrome Extension Specifics

- **Manifest V3** — service workers, not background pages
- **`chrome.scripting.executeScript`** — engine runs in the target tab's MAIN world
- **`chrome.storage.local`** — state persistence (workflow progress, provider configs)
- **Floating window** — `chrome.windows.create({ type: 'popup' })` for persistent UI
- **Tab queries from floating window** — must use `chrome.windows.getAll({ windowTypes: ['normal'] })` to find browser tabs, not `currentWindow`

## Provider DOM Reference

Captured via Chrome automation (2026-03-09):

| Provider | Date format | Date selector | Download method |
|----------|------------|---------------|-----------------|
| Shortcut | `M/D/YYYY` | `tr.invoice td:nth-child(2)` | Stripe receipt tabs |
| Hover | `MMM DD, YYYY` | `.table-row .col.date` | Print receipt page |
| Webflow | `Month D, YYYY` | invoices-table `td:nth-child(1)` | Direct PDF link |
| Elastic | `MMM DD – MMM DD, YYYY` | `[data-test-id^="billing-period"]` | Direct PDF links |
| ZeroSSL | `Month YYYY` | `li.paid .date` | AJAX download |
| Vultr | `YYYY-MM-DD` | `tr td:nth-child(2)` | Fetch blob PDF |
| Vonage | `M/D/YYYY` | `tr.ac-invoice td:nth-child(2)` | Fetch blob PDF |

## Plans & Context

- **Design notes, brainstorms and plans:** kept outside this public repository (`thoughts/` is gitignored; Intelia's copies live in the private `invoice-extractor-cloud` repo).
- **Cloud sync backend:** not part of this repository. The extension only ships the sync client (`profile-sync.mjs`, `sync-schema.mjs`, `sync-ui.js`).
- **Origin:** Refactored from `~/Downloads/invoice-downloader-extension 2/` (hardcoded v1)
