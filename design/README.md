# Calco — Invoice Extractor design system

"Calco" is Spanish for carbon copy, the paper that made the duplicate of every invoice.
The product does the same job: it makes a copy of each invoice and files it.

- **Brand accent:** the ultramarine of carbon-copy paper (`--ie-accent`).
- **Signature:** the *copy shadow*, a solid offset behind the primary action (`--ie-shadow-copy`).
- **Mascot:** **Bonobot**, a robot bonobo. "Monkey work is Bonobot's job." The final art kit lives in
  `brand/bonobot/` (SVG masters, palette, stamp animation); see its README for where each piece is used.
- **Specimen:** open `design/specimen.html` in a browser to see every token and component in light and dark.

## Files

| File | What it is |
|---|---|
| `tokens.json` | **Single source of truth**, W3C Design Tokens format. Primitives (by hue) and semantics (by use, per mode). |
| `tokens.css` | Generated. CSS custom properties `--ie-*`, light by default, dark via `prefers-color-scheme` or `[data-theme="dark"]`. |
| `fonts.css` | Generated. `@font-face` for the bundled OFL fonts in `/fonts`. |
| `brand/` | `bonobot/`: the final Bonobot vector kit (masters). The loose SVGs next to it are copies the specimen uses. |
| `specimen.html` | Living reference of the whole system. |

After editing `tokens.json`, run `npm run design:build`. `npm test` fails when a generated file is stale
(`build-design-tokens.mjs --check`) or when a text/background pair misses WCAG AA in either mode
(`check-contrast.mjs`, pairs listed in `tokens.json → contrastPairs`). Icons in `icons/`, the art in
`icons/brand/` and `site/assets/`, and the store images are built from `brand/bonobot/` with
`node scripts/render-store-assets.mjs`.

## Naming

- `primitive.color.calco.600` → `--ie-calco-600` (palette; only used to build semantics).
- `primitive.space.4` → `--ie-space-4`, `primitive.fs.sm` → `--ie-fs-sm`, `primitive.ease.stamp` → `--ie-ease-stamp`.
- `semantic.light.text-2` / `semantic.dark.text-2` → `--ie-text-2` (what components use).

## Foundations

- **Color:** components use semantic tokens only: `bg, surface, surface-2, border, border-strong, text, text-2,
  text-3, accent, accent-hover, accent-text, accent-soft, on-accent, copy, focus, success, warning, danger, info`
  (each status with a `-soft` background) and `logo-plate`.
- **Type:** Bricolage Grotesque (display, numbers, wordmark), Atkinson Hyperlegible Next (UI and text; 0/O and
  1/l/I are distinct), JetBrains Mono (amounts, IDs, commands). Extension base 14 px (`--ie-fs-sm`); nothing under 11 px.
  `xl` and larger are fluid from 320 to 1440 px.
- **Space:** 4 px grid (`--ie-space-1` = 4 px … `--ie-space-24` = 96 px). Radii 4/6/10/16 px and pill.
- **Motion:** 80/140/220/360 ms plus the 520 ms stamp. Signature: the copy slides out from under the original
  (`ie-copy-in`) and the stamp lands when a batch finishes (`ie-stamp`). `prefers-reduced-motion` cuts all motion.
- **Icons:** Lucide style (ISC license), 24 grid, 2 px stroke, round caps, `currentColor`, at 16/20/24 px. No emoji in UI.

## Rules

Do:
- Use the accent for actions, links, focus and selection.
- Show every status as color + icon + text (✓ ! ✕).
- Give only the main action of each screen the copy shadow.
- Set amounts, IDs and dates in mono with tabular figures.
- Put third-party logos inside the neutral `logo-plate` capsule; use initials on `surface-2` when there is no logo.
- Keep hit targets at 32 px or more in the extension.

Don't:
- Fill a status (error, warning, success) with the accent.
- Write hex colors in `popup.css` or `site/styles.css`; add a token instead.
- Use gradients, glows or "AI sparkle" imagery.
- Show Bonobot on password, credential or error screens.
- Load remote fonts or scripts in the extension.

## Voice

Reliable, sober, with a touch of administrative humor. Bonobot speaks in the first person only on success and
empty states; the joke is about the task, never about the user. Security and error copy is neutral: what happened
and how to fix it, no apologies. The extension follows the browser language (English or Spanish, informal "tú");
the website has `/` and `/es/`.

## CLI output

`✓` green (done), `→` accent (in progress), `!` yellow (needs action), `✗` red (error, followed by the fix),
dim for paths and hints. Names padded to 18 columns, numbers right-aligned. No color when `NO_COLOR` is set
or output is not a TTY; symbols stay.
