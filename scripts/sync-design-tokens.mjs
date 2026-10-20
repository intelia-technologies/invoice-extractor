#!/usr/bin/env node
// Copies the canonical design tokens (design/tokens.css) to the website (site/tokens.css).
// The extension imports design/tokens.css directly. Run with --check to fail if they diverge.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'design', 'tokens.css');
const target = join(root, 'site', 'tokens.css');
const canonical = readFileSync(source, 'utf8');

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch {}
  if (current !== canonical) {
    console.error('site/tokens.css is out of sync with design/tokens.css. Run: node scripts/sync-design-tokens.mjs');
    process.exit(1);
  }
  console.log('Design tokens in sync');
} else {
  writeFileSync(target, canonical);
  console.log('Synced design/tokens.css -> site/tokens.css');
}
