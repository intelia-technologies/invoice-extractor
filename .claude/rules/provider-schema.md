# Provider JSON Rules

## Required fields

Every provider JSON must have: `id`, `name`, `icon`, `billingUrl`, `readySelector`, `extract`, `download`.

## Extract section

- `rows` is a CSS selector that matches each invoice row/item
- `fields` defines how to extract data from each row. Field selectors are **relative to the row element**
- `dateFormat` must be one of: `auto`, `M/D/YYYY`, `DD/MM/YYYY`, `MMM DD, YYYY`, `Month D, YYYY`, `YYYY-MM-DD`, `Month YYYY`, `D de MMMM de YYYY`, `range`
- If `selector` is omitted or null, the field value is extracted from the **row element itself** (useful for reading `data-*` attributes on the row)
- `dedup` is optional — specify a field name to deduplicate by (e.g., `downloadUrl` or `id`)
- `skipDedup` (top-level, optional) — set to `true` to always re-download all invoices, ignoring download history. Useful for providers where the download mechanism is unreliable or the page structure makes dedup keys unstable

## Download methods

- `direct-link` — for direct PDF URLs. Creates `<a download>` and clicks it.
- `fetch-blob` — for same-origin PDFs that need credentials. Uses `fetch()` + blob.
- `open-tabs` — for external URLs (e.g., Stripe receipts). Opens in new tabs.
- `print-page` — for pages that need print-to-PDF. Opens URL + triggers `window.print()`.
- `chrome-download` — opens URL in a background tab, waits for browser-initiated download (handles redirects, JS triggers, cookies). Supports `urlSuffix` to append to URLs and `postLoadClick` to click a button after page load (e.g., "Download invoice" on Stripe).
- `debugger-print` — for receipt pages without PDF download. Uses `chrome.debugger` + `Page.printToPDF` to programmatically generate PDF. Fully automated, no print dialog.

## Post-load click (chrome-download)

Use `postLoadClick` with `chrome-download` when the download URL opens a page that requires clicking a button to trigger the actual PDF download (e.g., Stripe hosted invoice pages).

```json
"download": {
  "method": "chrome-download",
  "postLoadClick": {
    "selector": "table.InvoiceDetails-table button",
    "text": "download invoice",
    "wait": 3000
  }
}
```

- `selector` — CSS selector for the button to click. First match wins.
- `text` — optional text filter (case-insensitive substring match on textContent). If no match, clicks first element from selector as fallback.
- `wait` — ms to wait after page load before clicking (default: 2000).

## URL resolution

Set `"resolve": true` on a field to resolve relative URLs to absolute using `new URL(href, location.href)`.

## PreSteps

Use `preSteps` when the billing page needs interaction before the invoice list is visible (e.g., clicking a tab). Each step has `action` (`click` or `waitFor`), `selector`, and optional `wait` (ms).

## Iframe

Use `iframe` when the invoice table lives inside a cross-origin iframe. The engine will find the matching frame and inject scripts into it instead of the main frame.

```json
"iframe": { "urlPattern": "payments.google.com/payments" }
```

- `urlPattern` — substring to match against iframe src URLs. Uses `chrome.webNavigation.getAllFrames()` to find the frame.

## Config

Use `config` for per-user settings (workspace URLs, team IDs). Values are stored in `chrome.storage.local` per provider. Templates in `billingUrl` and field selectors can reference `{{config.fieldName}}`.

Set `"multi": true` on a config field to allow multiple values (e.g., multiple billing accounts). During workflow execution, the provider is expanded into one entry per value, each processed independently.

## Pagination

Two pagination types are supported:

### `select` (engine-level, same page)
For dropdowns that update content without full page reload (AJAX). The engine clicks through options.
```json
"pagination": { "type": "select", "openSelector": "...", "optionSelector": "...", "wait": 2000 }
```

### `url-page` (popup-level, full navigation)
For "next page" links that cause full page navigation. Popup.js navigates and re-runs the engine on each page.
```json
"pagination": { "type": "url-page", "nextSelector": ".pagination .next a", "wait": 3000 }
```

### `click-next` (engine-level, same page)
For "next page" buttons that update the list via AJAX and expose no `href`. The engine clicks the
button and the popup re-extracts, until the button is missing, hidden or `aria-disabled="true"`.
```json
"pagination": {
  "type": "click-next",
  "nextSelector": "a[role='button']:not(.row-actions-trigger)",
  "nextText": "next",
  "pick": "last",
  "wait": 3000
}
```
`nextText` (optional) filters by text; `pick: "last"` takes the last match — useful when prev/next
share the same selector and render in that order.

## Pre-navigation

Use `preNavigation` when the provider requires setup on a different page before navigating to the billing page (e.g., switching organization/account). Popup.js opens the preNavigation URL first, runs the steps, then navigates to the billingUrl.

```json
"preNavigation": {
  "url": "https://example.com/settings",
  "readySelector": "button[aria-haspopup='dialog']",
  "steps": [
    { "action": "click", "selector": "button[aria-haspopup='dialog']", "wait": 1000 },
    { "action": "click", "selector": "span", "text": "{{config.org}}", "wait": 3000 }
  ]
}
```

- `url` — the preparatory page URL (supports `{{config.*}}` placeholders)
- `readySelector` — wait for this element before running steps
- `steps` — array of click/waitFor actions (same syntax as preSteps, with `{{config.*}}` resolved in `text` fields)

## Org check

Use `orgCheck` as a safety net when the provider supports multiple organizations/accounts. The
check runs inside `executeDownload`, so it guards **every** download path (auto, login polling,
manual "Ready", retry). On mismatch nothing is downloaded and polling retries the check, so the
run resumes by itself once the user switches account.

```json
"orgCheck": {
  "selector": "img.MuiAvatar-img",
  "configField": "accountId",
  "extract": "[0-9a-f]{24}"
}
```

- `selector` — CSS selector for the element identifying the current org/account. Text is read
  first; elements without text fall back to their raw `src`/`href` attribute (avatars, logos).
  `location.hostname` and `location.href` are special-cased — only useful when the host really is
  account-specific (a wildcard host echoes our own navigation and identifies nothing).
- `configField` — config field to compare against (case-insensitive substring match)
- `extract` — optional regex applied to both sides before comparing (equality on the matched
  token). Lets the user paste a whole URL instead of a bare id. With `extract`, anything the
  user typed around the id (a company name) becomes the label shown in messages and in the
  workflow UI, and ids found on the page are translated back to that label when known.
- An empty config value disables the check — make such fields optional, never blocking.

## Naming

- Provider ID: lowercase kebab-case (`elastic-cloud`, `zero-ssl`)
- Filename: `providers/<id>.json`
- Filename template: `{{name}}_Invoice_{{date}}.pdf` (name comes from provider, date from extracted field)
