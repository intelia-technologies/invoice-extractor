// Shared helpers for design/tokens.json (W3C Design Tokens): load, resolve aliases, flatten.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadTokens() {
  return JSON.parse(readFileSync(join(root, 'design', 'tokens.json'), 'utf8'));
}

const isToken = (node) => node && typeof node === 'object' && '$value' in node;

export function lookup(tokens, path) {
  const node = path.split('.').reduce((n, key) => n?.[key], tokens);
  if (!isToken(node)) throw new Error(`Unknown token reference {${path}}`);
  return node;
}

// Resolves "{a.b.c}" to its final literal value. Semantic aliases are resolved within a mode.
export function resolve(tokens, value, mode) {
  if (typeof value !== 'string') return value;
  const match = value.match(/^\{(.+)\}$/);
  if (!match) return value;
  let path = match[1];
  if (path.startsWith('semantic.') && mode && !path.startsWith(`semantic.${mode}.`)) {
    path = path.replace(/^semantic\./, `semantic.${mode}.`);
  }
  return resolve(tokens, lookup(tokens, path).$value, mode);
}

// Walks a group, yielding [pathSegments, token] for every leaf token.
export function* walk(node, path = []) {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    if (isToken(child)) yield [[...path, key], child];
    else if (child && typeof child === 'object') yield* walk(child, [...path, key]);
  }
}
