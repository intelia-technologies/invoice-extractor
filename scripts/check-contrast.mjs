#!/usr/bin/env node
// Fails when a text/background pair listed in design/tokens.json misses WCAG AA in light or dark.
import { loadTokens, resolve } from './design-tokens-lib.mjs';

const tokens = loadTokens();
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

let failures = 0;
for (const mode of ['light', 'dark']) {
  for (const [fg, bg, min = 4.5] of tokens.contrastPairs.$value) {
    const value = (name) => resolve(tokens, tokens.semantic[mode][name].$value, mode);
    const r = ratio(value(fg), value(bg));
    if (r < min) {
      failures++;
      console.error(`✗ ${mode}: --ie-${fg} on --ie-${bg} = ${r.toFixed(2)} (needs ${min})`);
    }
  }
}
if (failures) process.exit(1);
console.log(`✓ Contrast AA: ${tokens.contrastPairs.$value.length * 2} pairs pass in light and dark`);
