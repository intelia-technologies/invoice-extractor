# Bonobot — final art kit (vector)

The final illustration of Bonobot, the robot bonobo, delivered 2026-10-20 from the commissioned brief
(`docs/design-system-brief.md`). This folder holds the vector part of the kit, which is what the
product uses. MIT licensed (`LICENSE.txt`).

**Full kit** (Blender model and scene sources, 3D renders, presentation PDF, the stamp-and-wave
animation and its storyboard): https://bonobot-descargas-2026.troskiev.chatgpt.site/ — kept out of
this repository on purpose to keep it small.

## Contents

| Path | What it is |
|---|---|
| `svg/*.svg` | 39 SVG masters: character, expressions, app icons, product scenes, store backgrounds, stickers and proof sheets. Sizes and purpose of each one in `manifest.json`. |
| `palette.css` | The kit's colour variables (`--ie-bonobot-*` plus the Calco accent, surface and success it uses). |
| `success-animation.css` | Reference for the 520 ms stamp bounce (scene + separate stamp). |
| `manifest.json` | File, logical size, category and description (in Spanish) of every master. |

The masters stay as delivered. Do not edit them in place; change the copies (below) or regenerate
them from the masters.

## Where each piece is used

`node scripts/render-store-assets.mjs` builds every shipped file from these masters:

| Master | Shipped as | Where |
|---|---|---|
| `app-icon-16/32/48/128` | `icons/icon16/32/48/128.png` | Extension icon (manifest, toolbar) |
| `app-icon-32/128/180/512`, `app-icon` | `site/assets/favicon.png`, `icon128.png`, `apple-touch-icon.png`, `icon512.png`, `app-icon-32.svg`, `app-icon.svg` | Website favicons and wordmark |
| `scene-success` + `success-stamp` | `icons/brand/` | Popup, clean completion with invoices filed |
| `empty-nothing-new` | `icons/brand/` | Popup, clean completion with nothing new |
| `empty-empty-history` | `icons/brand/` | Popup, empty download history |
| `empty-no-providers` | `icons/brand/` | Popup, empty profile list ("create the first one") |
| `mode-recording` | `icons/brand/` | Popup, recorder while recording |
| `bonobot` | `site/assets/`, `icons/brand/` | Website hero (on the run sheet) |
| `scene-hero`, `scene-hero-mobile` | `site/assets/` | Website, Providers section (`<picture>`: the mobile one has its own composition) |
| `github-social-1280x640`, `chrome-promo-440x280` | `design/store/*.png`, `site/assets/og-en.png`, `og-es.png` | GitHub social image, link previews, Chrome Web Store tile (copy added in `design/store/social.html`) |

## Rules that come with the art

- Bonobot appears only on success and empty states (and on the website and store), never on
  security, credential, error or session screens. See `PRODUCT.md`.
- A page's CSS variables do **not** reach an SVG loaded as `<img>`: it uses the fallback colours inside
  the file. The copies above add a dark-mode value for the ground shadow (`--ie-bonobot-soft`) so it
  does not show as a light bar on dark backgrounds. To recolour, inline the SVG or change the fallbacks.
- `scene-success.svg` (180 px) leaves its bottom-right 56 × 56 px corner free for `success-stamp.svg`.
- Keep the `bonobot-edge` outline: it separates the dark fur from dark backgrounds.
- Images are decorative (`alt=""`, `aria-hidden`); the text next to them carries the meaning.
- The SVG titles and labels are in Spanish, as delivered. They are not exposed when used as `<img>`.

The 3D renders and the animation have a solid light background (`#f3f4f1`, the Calco page colour) and
no alpha channel. The website uses a 480 px, 5 s cut of the animation (`site/assets/bonobot-stamp.mp4`)
with its poster frame.
