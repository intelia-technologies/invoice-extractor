#!/usr/bin/env node
// Builds every shipped brand file from the Bonobot kit in design/brand/bonobot/ (the masters stay untouched):
//   1. SVG copies for the extension (icons/brand/), the website (site/assets/) and the specimen (design/brand/).
//      A page's CSS variables never reach an SVG loaded as <img>, so each copy that draws a ground shadow gets
//      its own dark-mode value for it (otherwise a light grey bar shows under Bonobot on dark backgrounds).
//   2. App icon PNGs (icons/, site/assets/) from the dedicated small-size masters, rendered at 1x.
//   3. GitHub social image, the website's link previews (EN/ES) and the Chrome Web Store promo tile, from
//      design/store/social.html.
// Run: node scripts/render-store-assets.mjs   (Playwright is a dev dependency)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './design-tokens-lib.mjs';

const KIT = 'design/brand/bonobot/svg';
const SVG_COPIES = {
  'icons/brand': ['scene-success', 'success-stamp', 'empty-no-providers', 'empty-empty-history', 'empty-nothing-new',
    'mode-recording', 'bonobot', 'bonobot-waiting'],
  'site/assets': ['app-icon', 'app-icon-32', 'bonobot', 'bonobot-waiting', 'scene-hero', 'scene-hero-mobile'],
  'design/brand': ['app-icon', 'app-icon-16', 'bonobot', 'bonobot-waiting'],
};
// Ground shadow on dark backgrounds (value proposed by the kit's palette.css for dark mode).
const DARK_STYLE = '@media (prefers-color-scheme: dark){svg{--ie-bonobot-soft:#2b2d32}}';

const ICONS = [
  ['app-icon-16', 16, 'icons/icon16.png'],
  ['app-icon-32', 32, 'icons/icon32.png'],
  ['app-icon-48', 48, 'icons/icon48.png'],
  ['app-icon-128', 128, 'icons/icon128.png'],
  ['app-icon-32', 32, 'site/assets/favicon.png'],
  ['app-icon-128', 128, 'site/assets/icon128.png'],
  // iOS masks the corners itself and paints transparency black: fill them with the plate colour.
  ['app-icon-180', 180, 'site/assets/apple-touch-icon.png', '#3d3fd8'],
  ['app-icon-512', 512, 'site/assets/icon512.png'],
];
const CARDS = [
  ['#social', 'design/store/github-social-1280x640.png'],
  ['#social', 'site/assets/og-en.png'],
  ['#social-es', 'site/assets/og-es.png'],
  ['#promo', 'design/store/cws-promo-440x280.png'],
];

for (const [dir, names] of Object.entries(SVG_COPIES)) {
  for (const name of names) {
    let svg = readFileSync(join(root, KIT, `${name}.svg`), 'utf8');
    if (svg.includes('class="soft"')) svg = svg.replace('</style>', `${DARK_STYLE}\n</style>`);
    writeFileSync(join(root, dir, `${name}.svg`), svg);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, out, background = 'transparent'] of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  const markup = readFileSync(join(root, KIT, `${name}.svg`), 'utf8')
    .replace(/<svg ([^>]*?)width="\d+" height="\d+"/, `<svg $1width="${size}" height="${size}"`);
  await page.setContent(`<body style="margin:0;background:${background}">${markup}</body>`);
  await page.screenshot({ path: join(root, out), omitBackground: background === 'transparent', clip: { x: 0, y: 0, width: size, height: size } });
}
await page.setViewportSize({ width: 1280, height: 1000 });
await page.goto(pathToFileURL(join(root, 'design/store/social.html')).href);
await page.evaluate(() => document.fonts.ready);
for (const [selector, out] of CARDS) await page.locator(selector).screenshot({ path: join(root, out) });
await browser.close();
console.log('Built brand SVG copies, icons and store assets');
