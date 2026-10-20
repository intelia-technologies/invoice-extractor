# Invoice Downloader — Chrome Extension

🌐 **Website & installers:** https://invoice-extractor.noscomelaia.com · [Latest release](https://github.com/intelia-technologies/invoice-extractor/releases/latest)


Automatically download invoices from SaaS billing pages. Providers are defined declaratively in JSON files — the engine interprets them generically.

**Key advantage:** Downloads use the provider sessions already open in Chrome. Optional profile synchronization has its own independent login; it never transfers provider sessions.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this directory
4. Pin the extension to your toolbar

After editing files, click the refresh icon on the extension card in `chrome://extensions`.

## Usage

1. Click the extension icon (or open floating window)
2. Set the date range and max invoices per site
3. Click **Start Download**
4. The extension navigates to each provider's billing page, automatically signs in via 1Password if a login form is detected (or waits for manual login), then downloads invoices

## 1Password Service Account Integration (Zero-Touch Auto-Login)

The extension can fetch credentials (username, password, and 6-digit TOTP codes) directly from 1Password Service Account vaults (`AI` via `OP_SERVICE_ACCOUNT_TOKEN_INTELIA` and `AI bots` via `OP_SERVICE_ACCOUNT_TOKEN_LANA` in `~/.zshrc.local`) without Touch ID prompts or storing secrets in browser storage.

1. Register the Chrome Native Messaging host (`com.intelia.invoice_extractor.op`):
   ```bash
   npm run install:1password
   ```
2. Reload the extension in `chrome://extensions`.
3. **SaaS Billing Auto-Login:** When a provider tab lands on a login screen, the extension matches the provider against 1Password items by URL domain, provider name, or the optional `1Password Item` override in the provider's settings, and fills username, password, and 2FA OTP automatically (1-step or 2-step flows). You can also click **🔑 Sign in with 1Password** in the workflow panel at any time.
4. **Profile Sync Auto-Login:** In **Profiles**, click **🔑 Sign in with 1Password** to authenticate against the synchronization service using an item titled `Profile Sync` or `Invoice Extractor` (or matching the sync service URL).

## Optional profile synchronization

The extension works without an account. Open **Profiles** (or **Sync: local only**) to
connect to a trusted synchronization service using your own username and password.
Create an account on that service, then sign in with the same account on each computer.
Save your current settings into a profile first: unsaved live settings are not uploaded.

Only saved profile names, active provider selections and provider configuration are
synchronized. Workspace URLs and team/account IDs may be personal information: only
connect to a service you trust. Cookies, provider logins, invoices, download history,
workflow progress and the selected profile remain local. Receiving updated profiles
does not change your live settings; explicitly **Load** a profile to apply them.

Saved changes synchronize in the background while Chrome is running, on interface
opening, and approximately every minute (Chrome may delay background alarms).
Offline changes remain on the device and retry later. After an expired or revoked
session, disconnect and sign in again. Disconnect removes local login tokens, attempts
to revoke that session, and keeps both the local and remote saved profiles.

If local and cloud copies both changed, synchronization stops and presents a choice:
**Keep this device** or **Use cloud profiles**. This replaces the entire saved profile
list, not just one profile. A newer cloud revision requires reviewing the choice again.
The replaced copy is retained as one local replacement backup, available through
**Export replacement backup**. Later imports or conflict choices overwrite that backup;
routine cloud updates do not. Export it first if you need to keep it.
**Export profiles** and **Import profiles** also work
without an account. Import replaces saved profiles and, when connected, synchronizes
that change. Documents are limited to 100 profiles and 256 KiB.

### Self-hosting or using the managed sync service

Cloud synchronization is **optional**. Without it, the extension, the agent CLI, the MCP
server and the Skill work fully in local mode: profiles live in
`~/.config/invoice-extractor/state.json` and can always be rebuilt from your
1Password or Bitwarden items (`invoice-extractor profiles --sync-1p`).

The extension only contains the sync **client**. It talks to any server that implements
the profile-sync HTTP contract (`/config`, `/auth/register`, `/auth/login`,
`/auth/logout`, `/profiles`) defined by `profile-sync.mjs` and `sync-schema.mjs`.
The managed backend operated by Intelia is maintained in a separate private repository.

### Verification

`npm test` validates providers and runs the JavaScript synchronization/client tests.

## Supported Providers

| Provider | Download Method | Date Format |
|----------|-----------------|-------------|
| Amazon | `click-download` | `D de MMMM de YYYY` |
| CodeRabbit | `click-download` | `auto` |
| Elastic Cloud | `direct-link` | `range` |
| GitHub | `fetch-blob` | `YYYY-MM-DD` |
| GitHub Enterprise | `fetch-blob` | `YYYY-MM-DD` |
| Google Cloud | `click-download` | `auto` |
| Google Workspace | `click-download` | `D/M/YY` |
| Hetzner | `direct-link` | `MMM DD, YYYY` |
| Holded | `fetch-blob` | `DD/MM/YYYY` |
| Hover | `debugger-print` | `MMM DD, YYYY` |
| Lowi | `click-download` | `Month YYYY` |
| Naturgy | `click-download` | `DD/MM/YYYY` |
| OpenAI | `chrome-download` | `auto` |
| Shortcut | `chrome-download` | `M/D/YYYY` |
| Stripe | `click-download` | `Month YYYY` |
| Twilio | `click-download` | `Month YYYY` |
| Vonage/TokBox | `fetch-blob` | `M/D/YYYY` |
| Vultr | `fetch-blob` | `YYYY-MM-DD` |
| Webflow | `direct-link` | `Month D, YYYY` |
| ZeroSSL | `direct-link` | `Month YYYY` |

## Adding a New Provider

1. Navigate to the provider's billing page in Chrome
2. Open DevTools, inspect the invoice table/list (or use the built-in **Record** mode to capture the flow)
3. Create a JSON file in `providers/` following the schema below
4. Add the provider ID to `providers/index.json`
5. Run `npm run validate` — it must pass before the provider is accepted
6. Reload the extension — the provider appears automatically

Every provider must declare `"schemaVersion": 1`. Add a `$schema` reference pointing at
`providers/schema.json` so your editor gives you autocomplete and inline validation while you
write the file. `npm run validate` (also wired to `npm test`) checks every provider against that
schema, and CI runs it on every pull request — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the
full workflow and selector-resilience guidelines.

### Provider JSON Schema

```json
{
  "$schema": "./schema.json",
  "schemaVersion": 1,
  "id": "my-provider",
  "name": "My Provider",
  "icon": "🏢",
  "billingUrl": "https://example.com/billing",
  "readySelector": "CSS selector that indicates page is loaded",
  "extract": {
    "rows": "CSS selector for invoice rows",
    "fields": {
      "date": { "selector": "CSS relative to row" },
      "downloadUrl": { "selector": "CSS", "attr": "href", "resolve": true }
    },
    "dateFormat": "auto",
    "dedup": "downloadUrl"
  },
  "download": {
    "method": "direct-link",
    "filenameTemplate": "{{name}}_Invoice_{{date}}.pdf"
  }
}
```

### Download Methods

- **`direct-link`** — Creates `<a download>` and clicks it (for direct PDF URLs)
- **`fetch-blob`** — `fetch()` with credentials + blob download (for same-origin PDFs)
- **`open-tabs`** — Opens URLs in new tabs for manual download (e.g., Stripe receipts)
- **`print-page`** — Opens the receipt page + triggers the print dialog (save as PDF)
- **`chrome-download`** — Opens the URL in a background tab and waits for a browser-initiated download; handles redirects, cookies, and JS triggers. Supports `postLoadClick` to press a button after load (e.g., Stripe's "Download invoice")
- **`debugger-print`** — Uses `chrome.debugger` + `Page.printToPDF` to generate a PDF fully automatically, no print dialog (for receipt pages with no PDF link)
- **`click-download`** — Drives a sequence of in-row click steps (via the engine) to trigger the browser's own download, for providers with no extractable URL (e.g., open a popover, then click the download link)

### Date Formats

`auto`, `M/D/YYYY`, `D/M/YY`, `DD/MM/YYYY`, `MMM DD, YYYY`, `Month D, YYYY`, `YYYY-MM-DD`, `Month YYYY`, `D de MMMM de YYYY`, `range`

### Advanced Features

- **`preSteps`** — Click tabs or wait for elements before extraction
- **`config`** — Per-user settings (workspace URLs, team IDs) stored in `chrome.storage.local`
- **`resolve: true`** — Resolve relative URLs to absolute
- **`regex`** — Extract values from text using regex patterns
- **`downloadLinks`** — Multiple download links per row (e.g., Elastic)
- **`urlTemplate`** — Construct download URLs from extracted fields (e.g., Vultr)
- **`fallbackRows`** — Alternative row selector if primary finds nothing

## Architecture

```
popup.js  →  loads providers/*.json  →  injects engine.js into tab  →  downloads
   ↓                                           ↓
popup.html                              provider JSON + config
(UI + workflow)                         (declarative definition)
```

Three layers:
1. **Provider JSON** — declarative definition of how to extract invoices
2. **Engine** (`engine.js`) — generic runtime injected into billing pages
3. **UI/Workflow** (`popup.js`) — popup interface, floating window, state persistence

## Contributing

Contributions are welcome — especially new providers and fixes for providers that have broken
because a billing page changed its markup. Please read **[CONTRIBUTING.md](CONTRIBUTING.md)**
before opening a pull request: it covers how to add a provider, the selector-resilience
guidelines that keep providers from rotting, the validation requirements (`npm run validate`),
and the security rules for the provider catalog.

Found a provider that stopped working? Open an issue using the
**[🔧 Broken provider](.github/ISSUE_TEMPLATE/provider-broken.yml)** template. Want a new provider
supported? Use the **[✨ New provider request](.github/ISSUE_TEMPLATE/new-provider.yml)** template.

## License

Released under the [MIT License](LICENSE).
