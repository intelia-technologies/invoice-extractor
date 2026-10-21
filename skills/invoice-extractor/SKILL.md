---
name: invoice-extractor
description: Downloads SaaS invoices for client profiles using 1Password (`op` CLI — Service Account or Desktop Biometrics) or Bitwarden (`bw` CLI) and Playwright across macOS, Windows, and Linux, saves new credentials or learned billing account IDs back to 1Password/Bitwarden and shared state, and authors new declarative provider recipes. Use when the user asks to "bajar facturas", "descargar facturas de proveedores", "sincronizar perfiles de 1Password o Bitwarden", "guardar acceso de facturación", or automate SaaS invoice extraction.
---

# Invoice Extractor Skill (OMP · Claude Code · Antigravity)

CLI entry point: `bin/invoice-extractor.mjs` (or global `invoice-extractor` if linked via `npm link`)
Shared state file (synced with Chrome extension): `~/.config/invoice-extractor/state.json`

## Core Capabilities for Agents

0. **Bootstrap, Dependency Auto-Install & Permission Protocol (`doctor --fix` / `setup`):**
   On a fresh machine or whenever a command reports a missing dependency, run:
   ```bash
   node bin/invoice-extractor.mjs doctor --fix
   # Or for Bitwarden users:
   node bin/invoice-extractor.mjs doctor --fix --manager bitwarden
   ```
   - **What the agent installs automatically without asking (macOS, Windows, Linux):**
     - `node_modules` (`npm install`)
     - Playwright Chromium browser (`npx playwright install chromium`)
     - Password Manager CLI:
       - 1Password CLI (`brew install --cask 1password-cli` / `winget install AgileBits.1Password.CLI` / `snap install 1password-cli`)
       - Bitwarden CLI (`brew install bitwarden-cli` / `winget install Bitwarden.CLI` / `snap install bw`)
     - Chrome Native Messaging Host (`npm run install:1password`) + Claude Desktop MCP server
   - **What permissions/inputs the agent asks the human for (and how):**
     1. **1Password Desktop Biometrics (Touch ID / Windows Hello) OR Service Account Token (`ops_...`) OR Bitwarden Session (`BW_SESSION`):**
        NEVER ask the user to paste a secret token in the chat. Instead:
        - For **1Password Desktop** (`Personal`, `Private`, `Shared`, `Employee`, `Finance`, `Facturas`):
          ```bash
          node bin/invoice-extractor.mjs setup --manager 1password --mode desktop --vault "Personal"
          ```
        - For **1Password Service Account** (`AI` / `AI bots`):
          ```bash
          node bin/invoice-extractor.mjs setup --manager 1password --vault "AI" --prompt-token
          ```
        - For **Bitwarden**:
          ```bash
          node bin/invoice-extractor.mjs setup --manager bitwarden --prompt-token
          ```
     2. **One-time verification code (SMS / email code not in 1Password/Bitwarden TOTP):**
        Some providers (Holded, ...) email or text a code after the password. **Rule: if you can read the user's email, read the provider's code there and use it. If you cannot, the user does it.** See "Verification codes" below. For a Captcha, run with `--headed` and ask the user to solve it in the opened browser window.

1. **Check vaults & synced profiles (`status` / `profiles --sync-1p`):**
   ```bash
   node bin/invoice-extractor.mjs status
   node bin/invoice-extractor.mjs profiles --sync-1p
   ```
   - Scans configured 1Password vaults or Bitwarden folders.
   - Groups items by client tag or folder (e.g. `Acme`, `Globex`), matches domains against the 20 providers in `providers/*.json`, and extracts URL path IDs (`acct_...`, `org`, `enterprise`, `workspace`) when present in the item URL.

2. **Download invoices for a client profile (`run`):**
   ```bash
   node bin/invoice-extractor.mjs run \
     --profile Acme \
     --providers holded,stripe,openai \
     --since 2026-09-01 \
     --out ./downloads/acme
   ```
   - Add `--headed` if a provider requires visual inspection or an interactive SMS/Captcha challenge.
   - Add `--wait-for-code[=minutes]` (default 10) when a provider may ask for a one-time verification code (see below). Without it, such a provider fails with "provider asked for a verification code; rerun with --wait-for-code or use the extension".
   - Add `--skip-dedup` to re-download invoices even if they already appear in `~/.config/invoice-extractor/state.json`.
   - Returns a structured JSON manifest with `downloadedFiles` (exact paths on disk, date, amount, invoiceNumber), `learnedConfigs`, `skippedProviders`, and `errors`.

   **Verification codes (email/SMS code after the password).** The password never reaches you: it goes from the password manager straight into the provider's page. The one-time code only reaches you if you read it from the user's email or the user tells it to you.
   - **CLI:** with `--wait-for-code`, when a provider shows its code step the run prints one JSON line on **stderr**: `{"event":"verification_code_required","verificationId":"…","providerId":"holded","providerName":"Holded","pageHost":"app.holded.com","hint":"We sent a code to p***@…","requestedAt":"…","expiresAt":"…"}` and keeps that page open.
     - If you can read the user's email (Gmail/Outlook tools, `gwsx`, …): find the newest message from that provider received after `requestedAt`, extract the code and hand it over: `echo <code> | node bin/invoice-extractor.mjs submit-code --id <verificationId>` (stdin keeps the code out of shell history; `--code <code>` also works). It answers `{"ok":true,"accepted":true}`, or `accepted:false` for a wrong code: retry with a newer code until `expiresAt`.
     - If you cannot: ask the user. They can type the code in the browser window (headed runs; the run notices and continues by itself) or tell you the code so you run `submit-code`.
   - **MCP server:** `invoice_extractor_run` does not wait. It finishes the other providers and returns `pendingVerification: [{ verificationId, providerId, providerName, pageHost, hint, requestedAt, expiresAt, browserVisible }]` plus a `nextStep` instruction. Follow the same rule and call `invoice_extractor_submit_code({ verificationId, code })`; it signs in, downloads that provider's invoices and returns them like a run. If the user typed the code in the open window, call it with only `verificationId`. Pages stay open for 10 minutes, then expire (run again). Runs share one browser session, so they run one at a time, and while a code is pending a run for a **different** client profile is refused: submit the code first, or release it with `invoice_extractor_cancel_verification({ verificationId })`.
   - Never ask the user for a password, and never write the code into files, notes, commit messages or memory.

3. **Save or update credentials & client tags in 1Password or Bitwarden (`op-save`):**
   When the user gives you a login or billing URL for a client, persist it directly to the password manager and sync the profile state:
   ```bash
   node bin/invoice-extractor.mjs op-save \
     --vault Personal \
     --title "Stripe Acme" \
     --url "https://dashboard.stripe.com/acct_12345/settings/plans-and-fees/invoice-history" \
     --username "billing@acme.com" \
     --tags "Acme"
   ```

4. **Save learned provider configuration (`config set`):**
   Persist an `accountId`, `org`, `enterprise`, or `workspace` for a client profile so both the CLI and the Chrome extension use it:
   ```bash
   node bin/invoice-extractor.mjs config set \
     --profile Acme \
     --provider stripe \
     --key accountId \
     --value acct_12345
   ```

5. **Onboard, verify, repair, or create a provider "del tirón" (`onboard`):**
   When the user says *"añádeme este proveedor"* or wants to verify/create a provider for a client:
   ```bash
   node bin/invoice-extractor.mjs onboard \
     --provider <nameOrId> \
     --profile Acme \
     --url "https://app.example.com/settings/billing"
   ```
   `onboard` executes the complete decision tree automatically:
   - **If the provider already exists in `providers/*.json`:** it tests it live with the client's credentials (`--max 1`).
     - If a PDF downloads cleanly, it returns `status: "verified_existing"`, persists any learned `accountId` / `org` in `~/.config/invoice-extractor/state.json`, and is done.
     - If it fails, it automatically runs `inspect` (`recorder.js` DOM & iframe analysis) and returns `status: "needs_repair"` with `inspection` so you can update `providers/<id>.json`, run `npm test`, and re-run `onboard` to confirm.
   - **If the provider does NOT exist in `providers/*.json`:** it looks up the item's URL in 1Password/Bitwarden (or uses `--url`), logs in, injects `recorder.js`, and returns `status: "needs_creation"` with `inspection` (`invoiceTableCandidates`, `paginationCandidates`, `favIconUrl`, `iframes`). You then write `providers/<id>.json` + `icons/providers/<id>.png`, add `<id>` to `providers/index.json`, run `npm test`, and re-run `onboard` to verify the 1-invoice download.
