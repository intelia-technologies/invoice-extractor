#!/usr/bin/env node
// Renders the brand PNGs from their SVG/HTML sources with Playwright (dev dependency):
// app icons (icons/, site/assets/), GitHub social image and Chrome Web Store promo tile (design/store/).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './design-tokens-lib.mjs';

const ICONS = [
  ['design/brand/app-icon-16.svg', 16, 'icons/icon16.png'],
  ['design/brand/app-icon-16.svg', 32, 'icons/icon32.png'],
  ['design/brand/app-icon.svg', 48, 'icons/icon48.png'],
  ['design/brand/app-icon.svg', 128, 'icons/icon128.png'],
  ['design/brand/app-icon-16.svg', 32, 'site/assets/favicon.png'],
  ['design/brand/app-icon.svg', 128, 'site/assets/icon128.png'],
  ['design/brand/app-icon.svg', 180, 'site/assets/apple-touch-icon.png'],
  ['design/brand/app-icon.svg', 512, 'site/assets/icon512.png'],
];
const CARDS = [['#social', 'design/store/github-social-1280x640.png'], ['#promo', 'design/store/cws-promo-440x280.png']];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [svg, size, out] of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  const markup = readFileSync(join(root, svg), 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(`<body style="margin:0">${markup}</body>`);
  await page.screenshot({ path: join(root, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await page.setViewportSize({ width: 1280, height: 1000 });
await page.goto(pathToFileURL(join(root, 'design/store/social.html')).href);
await page.evaluate(() => document.fonts.ready);
for (const [selector, out] of CARDS) await page.locator(selector).screenshot({ path: join(root, out) });
await browser.close();
console.log('Rendered icons and store assets');
