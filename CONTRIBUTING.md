# Contributing

Thanks for helping make Invoice Extractor better. The most valuable contributions are **new
providers** and **fixes for providers that broke** when a billing page changed its markup.

The whole extension is driven by declarative JSON in `providers/` — a generic engine interprets
those files at runtime. You almost never need to touch `engine.js` or `popup.js` to add a
provider; you describe the page and the engine does the rest.

- [Adding a provider](#adding-a-provider)
- [Selector resilience](#selector-resilience) — the single most important section
- [Validation requirements](#validation-requirements)
- [Security rules for the catalog](#security-rules-for-the-catalog)
- [Pull request checklist](#pull-request-checklist)
- [Reporting a broken provider](#reporting-a-broken-provider)

## Adding a provider

### Manual flow (DevTools)

This is the reliable path and the one you should understand even if you use the recorder.

1. **Log in and open the billing page** in Chrome so you're looking at the real invoice list.
2. **Inspect the DOM** with DevTools. Find:
   - a `readySelector` — an element that only exists once the invoice list has loaded;
   - a `rows` selector — one match per invoice (a table row, a card, a list item);
   - field selectors **relative to a row** for `date`, `amount`, and a download hook
     (`downloadUrl` or the click target for `click-download`).
3. **Write the JSON** in `providers/<id>.json`. Start from the schema block in the
   [README](README.md#provider-json-schema) and the rules in
   [`.claude/rules/provider-schema.md`](.claude/rules/provider-schema.md). Include:
   - `"$schema": "./schema.json"` so your editor gives you autocomplete and inline errors;
   - `"schemaVersion": 1` (required — see [validation](#validation-requirements));
   - a sensible `download.filenameTemplate`, e.g. `{{name}}_Invoice_{{date}}.pdf`.
4. **Register the id** in `providers/index.json`.
5. **Validate**: `npm run validate` must pass (see below).
6. **Test against the real page**: reload the extension (`chrome://extensions` → refresh icon),
   run a download for the new provider, and confirm the files land with correct names and dates.
   Do not submit a provider you haven't actually run.

### Assisted flow (Record mode)

The extension ships with a built-in **recorder** to bootstrap a provider without hand-writing
every selector. In the popup, click **Record**, then walk through downloading one invoice on the
billing page. The recorder captures your clicks, the surrounding DOM, and the resulting downloads
(scrubbing obvious secrets and emails) and proposes a starting provider JSON.

Treat the recorder's output as a **draft**: recorded selectors are often more fragile than what a
human would choose, so review them against the [selector-resilience](#selector-resilience) rules,
tighten them, then validate and test exactly as in the manual flow.

## Selector resilience

Billing pages change constantly, and the number-one reason a provider stops working is
**selector rot** — a selector that matched last month no longer matches after a redesign or a CSS
refactor. Choosing durable selectors is the most important thing you do when adding a provider.

**Prefer, in roughly this order:**

1. **Accessibility attributes** — `[aria-label="Download invoice"]`, `[role="row"]`,
   `[aria-current]`. These are tied to meaning and rarely change on a style refactor.
2. **Test/data hooks** — `[data-testid="invoice-row"]`, `[data-test-id^="billing-period"]`,
   other `data-*` attributes the app author put there deliberately.
3. **Semantic, stable ids and element structure** — a real `id`, a `<time datetime>` element,
   `<a download href$=".pdf">`, an anchor whose `href` matches an invoice URL pattern.

**Avoid:**

- **CSS utility classes.** Class chains like `.border-collapse.text-left` or
  `.mt-4.flex.items-center` come from a styling system (Tailwind, CSS modules, hashed class
  names) and break the instant anyone touches the styles. Never anchor a provider on them.
- **Deep `nth-child` chains** when an attribute selector exists. `tr td:nth-child(2)` is
  acceptable as a last resort for a stable table, but `div > div:nth-child(3) > span:nth-child(2)`
  will not survive the next layout tweak — reach for an `aria-*`/`data-*` hook instead.
- **Text that only exists in one language** where a structural selector would do (unless the field
  genuinely is the text, e.g. matching a localized "Download" button by `text`).

**When only fragile selectors are available** — some pages simply don't expose good hooks — use the
best you can, and **say so explicitly in your pull request** ("the only stable handle on the amount
is `nth-child`; there are no data attributes"). That tells reviewers where the provider is likely
to break first and is far better than hiding it.

## Validation requirements

Every provider is validated against a JSON Schema (`providers/schema.json`, draft-07).

- Run **`npm run validate`** locally before you push. It is also wired to **`npm test`**.
- **CI runs the same validation on every pull request** (`.github/workflows/validate.yml`); a PR
  that fails validation will not be merged.
- The **`"schemaVersion": 1`** field is **required** on every provider file. Validation fails
  without it.
- Keep the `$schema` reference in the file so contributors get the same checks in their editor
  that CI runs on the server.

If you legitimately need a capability the schema doesn't allow yet, extend the engine and the
schema together (see below) — don't work around validation.

## Security rules for the catalog

The provider catalog is a security boundary. Anyone can install this extension and it runs on
billing pages while you're logged in, so the rules are strict and non-negotiable:

- **Providers are strictly declarative JSON. No executable code, ever.** No `eval`, no inline
  scripts, no function strings, no "just run this snippet" fields. A pull request that tries to
  smuggle executable behavior into a provider will be rejected outright.
- **New behavior lives in the engine, not in a provider.** If a provider needs a pattern the
  engine doesn't support, propose an **engine schema extension** — a new declarative field the
  generic engine interprets for everyone — rather than a one-off. This is the project's
  **"Engine stays generic"** principle: provider-specific logic never belongs in code, and
  never-declarative logic never belongs in a provider.
- **Provider URLs and selectors must relate only to the provider's own domains.** A provider for
  `example.com` may navigate to and read from `example.com` (and its documented billing/receipt
  hosts). It must not point `billingUrl`, download targets, or `postLoadClick` at unrelated
  third-party domains.
- **Don't capture secrets.** Selectors and templates should target invoice metadata and download
  links, not auth tokens, cookies, or session identifiers. Scrub any sample DOM you attach to a
  PR or issue.
- **Upstream projects are reference only.** woob (LGPL) and Cozy konnectors (AGPL) may be consulted
  to learn how a portal works (endpoints, date formats, click order), but pasting their code into
  this repository is not allowed: those licenses are incompatible with this project's MIT license.
  Write every recipe from your own observation of the real page.

## Pull request checklist

Before opening a PR, confirm:

- [ ] `npm run validate` passes locally (and `"schemaVersion": 1` is present).
- [ ] The provider id is registered in `providers/index.json`.
- [ ] You **tested against the real billing page** and invoices downloaded correctly.
- [ ] Selectors follow the [resilience guidelines](#selector-resilience); any unavoidably fragile
      selector is called out in the PR description.
- [ ] `download.filenameTemplate` produces sensible, collision-free filenames.
- [ ] The provider only touches its own domains and contains no executable code.
- [ ] You included **screenshots or a short note of the flow you tested** (which page, how many
      invoices, what the downloaded files looked like).

## Reporting a broken provider

If a provider stopped working, please open an issue with the
**[🔧 Broken provider](.github/ISSUE_TEMPLATE/provider-broken.yml)** template. Include the failing
step, any console output, and a **sanitized** DOM snippet of the relevant area (remove personal
data, account numbers, and tokens first). To request support for a provider we don't have yet, use
the **[✨ New provider request](.github/ISSUE_TEMPLATE/new-provider.yml)** template.
