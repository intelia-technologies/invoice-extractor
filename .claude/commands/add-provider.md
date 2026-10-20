# Add Provider from Recording

Generate a provider JSON from a recording file exported by the Invoice Extractor extension.

## Arguments

$ARGUMENTS — path to the recording JSON file (e.g., ~/Downloads/recording_example_com_2026-03-10.json)

## Recording Instructions for the User

Start recording from the **login page** (or the landing page right after login). Then navigate to the billing/invoices page and download 1-2 invoices.

The recording captures the full flow: login → landing page → navigation → invoice table → downloads. This gives us everything needed to build the provider automatically.

**Good recording:** Login page → Dashboard (post-login landing) → Settings → Documents → download 2 invoices
**Also OK:** Already logged in on Dashboard → Settings → Documents → download 2 invoices

**Multiple accounts:** If the provider has multiple billing accounts (e.g., Google Cloud), recording with **one account is enough**. The extension supports multi-value config fields — the user can add more account IDs from the provider settings later.

## Workflow

### 1. Read the Recording

Read the recording JSON file. It contains:
- `billingUrl` — the URL where recording started
- `favIconUrl` — the favicon URL of the recorded tab (used to generate provider icon)
- `actions` — user clicks with CSS selectors, timestamps, element text
- `domSnapshots` — full HTML snapshots of the page at key moments
- `networkRequests` — all HTTP requests (URLs, methods, content types)
- `downloads` — detected file download attempts
- `analysis.invoiceTableCandidates` — auto-detected table structures, each with:
  - `interactiveElements` — all buttons, links, and clickable elements found in and around each row, with their text, classes, aria-labels, visibility, and location (`inside` row vs `sibling` panel)
- `analysis.paginationCandidates` — auto-detected pagination elements:
  - `type: "select-filter"` — native `<select>` with year/period options (selector, options list, hasYears, hasPeriods)
  - `type: "dropdown-filter"` — custom dropdown buttons with date/period text
  - `type: "page-nav"` — next/previous page links (containerSelector, nextSelector, items)
- `iframes` — (optional) array of cross-origin iframe recordings. Each entry has:
  - `frameUrl` — the iframe's URL (e.g., `https://payments.google.com/payments/u/1/documentcenter`)
  - `actions`, `domSnapshots`, `networkRequests`, `downloads`, `analysis` — same structure as top-level, but captured from inside the iframe

**Important:** If `iframes` is present, the invoice table is likely inside the iframe. Use the iframe's `analysis.invoiceTableCandidates` and `domSnapshots` for selectors, and add an `"iframe": { "urlPattern": "<hostname/path>" }` field to the provider JSON. The `urlPattern` should be a substring that matches the iframe URL (e.g., `"payments.google.com/payments"`).

### 2. Analyze Navigation Flow

**This is the most critical step.** Reconstruct the user's journey from the recording:

1. Check `domSnapshots[0].url` — this is the **starting page** (could be login page, dashboard, or billing page)
2. Look at `actions` in order — identify which are **login actions**, **navigation actions**, and **download actions**
3. Determine the **post-login landing page** — the first stable page after authentication. Identify it by:
   - URL change from a login/auth domain to the app's main domain
   - Actions on `input[type="password"]`, `input[type="email"]`, or buttons with login/sign-in text → these are login actions, **ignore them all**
   - The first action on the app's main UI (not a login form) marks the post-login landing page
   - If no login actions exist, `domSnapshots[0].url` is already the post-login landing page

From this flow, determine:

1. **billingUrl** — Do NOT blindly use `recording.billingUrl`. Determine the best **entry point** for the extension:
   - If the user navigated through multiple pages to reach the invoice table, set `billingUrl` to the **first post-login page from which navigation to invoices is possible** (e.g., settings page, not the final documents sub-page)
   - If the user landed directly on the billing page (no navigation needed), use that URL
   - Use `href`-based selectors for navigation links (e.g., `a[href$='/settings/documents']`) — these are stable across locales and obfuscated CSS
   - If the URL contains user/account-specific IDs (e.g., `acct_XXX`), extract them into a `config` field and use `{{config.fieldName}}` in the URL. Set `"multi": true` on account/workspace ID fields so users can add multiple accounts from the provider settings
2. **readySelector** — CSS selector for an element that confirms the **billingUrl page** loaded (NOT the final table — that may require preSteps first). If preSteps navigate to a sub-page, the readySelector should match something on the intermediate page (e.g., the navigation link itself). Must be stable (use classes/attributes/href, avoid dynamic IDs)
3. **preSteps** — From the non-login, non-download actions, determine what clicks are needed to get from `billingUrl` to the invoice table. Distinguish:
   - **Navigation clicks** (action href goes to a different page path) → the user navigated to a sub-page. Add as preSteps with a `waitFor` step after for the table
   - **UI interaction clicks** (tab switches, dropdown opens on same page) → add as preSteps normally
   - **Login actions** (typing credentials, clicking sign-in) → **skip entirely**, the extension assumes the user is already logged in
   - Always add a `waitFor` step after navigation preSteps to ensure the target page/table has loaded
4. **rows** — CSS selector that matches each invoice row. Look at `analysis.invoiceTableCandidates` and DOM snapshots for `<tr>`, `<li>`, or repeating `<div>` elements containing invoice data
5. **fields** — for each row, determine selectors for:
   - `date` — date of the invoice
   - `amount` — invoice amount
   - `downloadUrl` — link to download/view the invoice (look for `<a>` tags with PDF/receipt URLs)
   - `id` — invoice ID (optional, for dedup)
   - Field selectors must be **relative to the row element**
6. **dateFormat** — detect from the date text (e.g., "Mar 09, 2026" → `MMM DD, YYYY`)
7. **download method** — determine from the download URLs and `interactiveElements`:
   - Same-site PDF links → `direct-link`
   - Same-site needing auth → `fetch-blob`
   - Stripe/external invoice pages → `chrome-download` with `urlSuffix: "/pdf"` if applicable
   - Receipt pages needing print → `print-page`
   - External URLs for manual download → `open-tabs`
   - **No direct download links but buttons trigger downloads** → `click-download`. Use `interactiveElements` to find the button sequence. Look for:
     - Buttons with `ariaHaspopup` (menu triggers) → first step (scope: row)
     - Buttons in `location: "sibling"` with download-related text → second step (scope: document, visible: true)
8. **dedup** — field to deduplicate by (usually `downloadUrl` or `id`)
9. **pagination** — **Always check `analysis.paginationCandidates`** in the recording. The recorder auto-detects:
   - `select-filter` — native `<select>` with year/period options
   - `dropdown-filter` — custom dropdown buttons with date text
   - `page-nav` — next/previous page links with `nextSelector`

   If `paginationCandidates` is empty, **inspect the live page** using Chrome automation tools to find pagination elements.

   Two pagination types:
   - **`type: "select"`** — for dropdowns that update content **without full page reload** (AJAX). The engine clicks through options internally.
     - `openSelector` — CSS selector for the dropdown trigger
     - `optionSelector` — CSS selector for all option elements
     - `wait` — ms to wait after selecting an option (typically 2000)
   - **`type: "url-page"`** — for "next page" links that cause **full page navigation**. Popup.js handles navigation and re-runs the engine on each page.
     - `nextSelector` — CSS selector for the "next page" link (e.g., `.a-pagination .a-last a`)
     - `wait` — ms to wait after navigation (typically 3000)
   - **`type: "click-next"`** — for "next page" buttons that update the list via **AJAX** with no `href`. The engine clicks the button and the popup re-extracts each page.
     - `nextSelector` — CSS selector for the button; `nextText` (optional) text filter; `pick: "last"` when prev/next share a selector
     - `wait` — ms to wait after clicking (typically 3000)

### 3. Read Existing Providers for Reference

Read 2-3 existing provider JSONs from `providers/` to match the established patterns:
```
providers/openai.json
providers/webflow.json
providers/shortcut.json
```

### 4. Generate the Provider JSON

Create the provider JSON following the schema in `.claude/rules/provider-schema.md`. Write it to `providers/<id>.json`.

### 5. Download Provider Icon

If the recording contains a `favIconUrl`:
1. Download the favicon image using `curl -sL <favIconUrl> -o /tmp/provider_favicon.png`
2. Check the image dimensions with `sips -g pixelWidth -g pixelHeight`
3. If the image is not 64x64, resize it: `sips -z 64 64 /tmp/provider_favicon.png --out icons/providers/<id>.png`
4. If the favicon is an SVG or ICO, convert it appropriately (use `rsvg-convert` for SVG, or extract the largest size from ICO)
5. Verify the icon looks good by reading the PNG file

If there is no `favIconUrl` in the recording, try to fetch the site's favicon from `https://<domain>/favicon.ico` or check the site's HTML for `<link rel="icon">` tags. As a last resort, create a simple icon with the provider's initial letter.

All provider icons must be 64x64 PNG files saved to `icons/providers/<id>.png`.

### 6. Register the Provider

Read `providers/index.json` and add the new provider ID to the array.

### 7. Verify

- Validate the JSON is well-formed
- Check all CSS selectors look reasonable (no overly dynamic class names)
- Confirm the file was added to `providers/index.json`
- Verify the icon exists at `icons/providers/<id>.png` and is 64x64

### 8. Summary

Present:
- The generated provider JSON
- Key decisions made (download method, selectors chosen, etc.)
- Any uncertainties or things the user should verify manually
- Instruction: "Reload the extension in chrome://extensions and test with the real billing page"
- If the provider has `config` fields with `multi: true`: remind the user they can add more accounts/IDs from the provider settings page in the extension

## Important Rules

- CSS selectors should be **stable** — prefer semantic classes, data attributes, tag structure over dynamically-generated class names
- Field selectors are **relative to the row**, not the document
- If the recording shows the user clicking a link that opens a new tab (e.g., Stripe invoice), the download method is likely `chrome-download` or `open-tabs`
- When in doubt about a selector, prefer a more general one that might match extra rows (the date filter and dedup will handle filtering) over a brittle specific one
- Always check `networkRequests` for PDF download URLs — they reveal the actual download mechanism
