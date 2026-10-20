# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Freelancers and small businesses** who have to collect the month's SaaS invoices (hosting, domains,
  email, APIs) for their accountant or tax filing. Today they open each billing page, log in, find the
  PDF and rename it, provider by provider. They use the Chrome extension.
- **AI agents** working on someone's behalf, through the bundled CLI, MCP server and Skill. They read the
  same provider recipes and the same vault credentials and report results as text.

## Product Purpose

Download every invoice from every SaaS billing page in one run, named and filed, without the user doing
the monkey work. Success: a full month collected in one press of "Start", with nothing left to download
by hand and nothing sensitive leaving the user's machine.

## Positioning

- Runs inside the user's own Chrome, on sessions they already have, or signs in with the password manager
  they already use (1Password or Bitwarden). It does not store passwords and needs no cloud account.
- Providers are public, declarative JSON recipes in an open-source (MIT) repository: anyone can add or fix one.
- The same recipes serve a person (extension) and an agent (CLI/MCP).

## Operating Context

- A monthly or quarterly chore, usually at closing time for the accountant.
- The extension runs as a toolbar popup or a floating window next to the billing tabs it drives.
  Logins, 2FA prompts and download progress happen in view.
- Profiles group providers and their account settings (for example, one per company); they can be synced
  optionally through a self-hostable service.
- Distribution today is a zip from GitHub Releases plus "Load unpacked"; the website guides that install.

## Capabilities and Constraints

- 20 built-in providers; download methods range from direct links to printing receipt pages to PDF.
- Chrome extension, Manifest V3. No remote fonts or scripts in the extension; everything ships bundled.
- Interface languages: English and Spanish, following the browser language (informal "tú" in Spanish).
  Provider names and some engine error reasons stay in English.
- Website: static pages at `/` (English) and `/es/` (Spanish), plus privacy pages.
- Open: Chrome Web Store listing (not published yet).

## Brand Commitments

- Own product brand, with a discreet "by Intelia".
- Mascot **Bonobot**, a robot bonobo. Line: "Monkey work is Bonobot's job" / «El trabajo de mono, para el mono».
  The joke is about the task, never the user. Bonobot speaks only on success and empty states, never on
  security, credential or error screens. Its face is the app icon.
- Voice: reliable and sober, with a touch of administrative humor. Error and security copy is neutral:
  what happened and how to fix it, no apologies.
- The final Bonobot illustration is delivered (MIT) and in use: the vector kit lives in
  `design/brand/bonobot/`, the full kit (3D model, renders, animation) on its download page.

## Evidence on Hand

- Real product: extension, CLI and provider recipes in this repository; release v1.1.0 on GitHub.
- Live website at invoice-extractor.noscomelaia.com.
- No testimonials, user counts, customer logos or benchmarks exist. Do not invent them.

## Product Principles

1. Nothing sensitive leaves the machine; say plainly what is stored and where.
2. One run should finish the job; when a human is needed (login, 2FA), say exactly what to do.
3. Generic engine, declarative providers: no provider-specific code paths.
4. People and agents are equal users of the same capabilities.

## Accessibility & Inclusion

WCAG 2.2 AA in both light and dark modes (contrast pairs are checked in CI). Status is never color alone:
color, icon and text. Respect `prefers-reduced-motion`. Hit targets of at least 32 px in the extension.
