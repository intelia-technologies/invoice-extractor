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

## Invoice hosts in agent mode (`download.allowedHosts`)

Agent mode (CLI `run`, MCP server) supports `chrome-download` and `debugger-print` by opening
each invoice URL in a new page of the signed-in browser. Before opening it, the URL must be
`https` (plain `http` only on `localhost` test fixtures) and its host must be the `billingUrl`
host, an `auth.loginDomains` entry, or a `download.allowedHosts` entry (each with subdomains).
Otherwise that invoice is refused with an error and the run continues. The same check applies to
the page the URL redirects to before `postLoadClick` clicks or `debugger-print` prints, and to
the URL the downloaded file finally comes from (after redirects; a `blob:` URL counts as its
page's origin) before it is saved. List the provider's file host too if its PDFs are served from
another host (Stripe hosted invoices download from `pay.stripe.com`). With `IE_DEBUG=1`, agent
mode prints a `debug_download_host` line on stderr for every saved invoice.

Declare `allowedHosts` when invoices live on a third-party host such as Stripe-hosted invoices,
and keep it as narrow as the URLs the recipe extracts:

```json
"download": {
  "method": "chrome-download",
  "allowedHosts": ["invoice.stripe.com"]
}
```

Same entry format as `auth.loginDomains`: plain lowercase host with at least one dot, no scheme,
port, path or wildcard. The extension ignores this field.

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

## Sign-in domains (`auth.loginDomains`)

Vault autofill (extension, CLI and MCP) only types a username, password or code into a page that
is on an allowed host, and fails closed otherwise (nothing is typed, the user sees "sign-in page
<host> does not match the saved login for <provider>; nothing was typed"). Allowed hosts are:

- the **exact host** of every URL saved on the vault item (1Password `urls`, Bitwarden
  `login.uris`), plus its subdomains — `https://app.holded.com` allows `app.holded.com` and
  `*.app.holded.com`, **not** `holded.com` or `www.holded.com`;
- the **exact host** of the recipe's `billingUrl`, plus its subdomains (a host containing a
  `{{config.*}}` placeholder contributes nothing, so user config can never add a host);
- each entry in `auth.loginDomains`, plus its subdomains.

Nothing is widened automatically: there is no guessing of a "registrable domain" from a public
suffix list (a partial list turns `alice.uk.com` into `uk.com`). The only way to allow a parent
domain is a human-reviewed `loginDomains` entry.

The page must be `https` (plain `http` only on `localhost` test fixtures), and when the form is
inside an iframe, that frame and every parent frame must be allowed. An explicit item reference
(`_onepasswordItem`, `auth.item`) picks the item but does not skip this check.

Add `loginDomains` whenever the sign-in form is not on the `billingUrl` host or one of its
subdomains — a sibling subdomain (billing on `platform.openai.com`, sign-in on `auth.openai.com`)
or an SSO / OAuth identity provider. Prefer the provider's own domain:

```json
"auth": { "loginDomains": ["openai.com"] }
```

Each entry must be a plain lowercase host name containing at least one dot: no scheme, port,
path or wildcard, and never a bare public suffix (`com`, `co.uk`, `uk.com`, `amazonaws.com`,
`github.io`…). The schema rejects malformed entries and the runtime ignores them.

The same allowed hosts apply when agent mode (CLI `run --wait-for-code`, MCP
`invoice_extractor_submit_code`) types a one-time verification code: the code is only typed
on a page of the provider, and refused otherwise.

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
