#!/usr/bin/env node
/**
 * Provider coverage table: our providers vs woob (modules with the bill/document
 * capability) vs Cozy konnectors (non-archived `cozy-konnector-*` repos).
 *
 * Only names, URLs and metadata are read from the upstream projects. No upstream
 * source code is fetched into the output: woob is LGPL and Cozy konnectors are AGPL,
 * which is incompatible with this MIT project. Do not paste their code.
 *
 * Usage:
 *   node scripts/coverage-diff.mjs                       # writes docs/provider-coverage.md
 *   node scripts/coverage-diff.mjs --out <file.md>       # custom output path
 *
 * Optional auth for GitHub (anonymous access is limited to 60 requests/hour):
 *   GITHUB_TOKEN or GH_TOKEN, or a logged-in `gh` CLI (its token is used, never printed).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WOOB_TREE_API = 'https://gitlab.com/api/v4/projects/woob%2Fwoob/repository/tree?path=modules&per_page=100&page=';
const WOOB_RAW = 'https://gitlab.com/woob/woob/-/raw/master/modules';
const GH_ORG = 'konnectors';
const CONCURRENCY = 8;

// Repo/module name prefixes that are not part of the provider identity.
const PREFIXES = ['cozy-konnector-', 'konnector-', 'cozy-', 'woob-', 'weboob-'];

// Known alternative names for the same provider in upstream projects.
// Keys are our provider ids (normalized).
const ALIASES = {
  elastic: ['elasticcloud'],
  vonage: ['tokbox'],
  'google-workspace': ['gsuite', 'googleapps'],
};

const CC_TLD = {
  es: 'Spain', fr: 'France', de: 'Germany', it: 'Italy', pt: 'Portugal',
  uk: 'United Kingdom', gb: 'United Kingdom', nl: 'Netherlands', be: 'Belgium',
  ch: 'Switzerland', at: 'Austria', ie: 'Ireland', lu: 'Luxembourg',
};
const GENERIC_TLD = new Set(['com', 'net', 'org', 'io', 'ai', 'dev', 'app', 'cloud', 'co', 'eu', 'info', 'tech']);
const COUNTRY_KEYWORDS = [
  [/\bfrench\b|\bfrance\b/i, 'France'],
  [/\bspanish\b|\bspain\b|espa(ñ|n)a/i, 'Spain'],
  [/\bgerman\b|\bgermany\b|deutsch/i, 'Germany'],
  [/\bitalian\b|\bitaly\b/i, 'Italy'],
  [/\bportuguese\b|\bportugal\b/i, 'Portugal'],
  [/\bbelgian\b|\bbelgium\b/i, 'Belgium'],
];

/** Lowercase, drop known prefixes, keep only a-z0-9. */
export function normalizeKey(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  for (const p of PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }
  return s.replace(/[^a-z0-9]/g, '');
}

/** Hostname of a URL, ignoring {{config.*}} placeholders. Empty string if unparseable. */
export function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(String(url).replace(/\{\{[^}]*\}\}/g, 'x')).hostname;
  } catch {
    return '';
  }
}

/** Returns "CapDocument", "CapBill" or both joined by "+" when a module class declares them; null otherwise. */
export function capsOf(src) {
  const caps = new Set();
  for (const cls of src.matchAll(/^class\s+\w+\s*\(([^)]*)\)\s*:/gms)) {
    for (const c of cls[1].matchAll(/\bCap(Document|Bill)\b/g)) caps.add(`Cap${c[1]}`);
  }
  return caps.size ? [...caps].sort().join('+') : null;
}

/** Reads a simple `NAME = "value"` class attribute from a Python module. */
function pyAttr(src, name) {
  const m = src.match(new RegExp(`^\\s*${name}\\s*=\\s*u?(['"])(.*?)\\1`, 'm'));
  return m ? m[2] : '';
}

/**
 * Best-effort country guess. Order: ccTLD of the provider's own host, then a
 * nationality keyword in the description, then "Global" for generic TLDs.
 * The result is a guess and is labelled as such in the output.
 */
export function countryGuess(hosts, text = '') {
  for (const h of hosts) {
    const tld = h.split('.').pop();
    if (CC_TLD[tld]) return `${CC_TLD[tld]} (TLD .${tld})`;
  }
  for (const [re, country] of COUNTRY_KEYWORDS) {
    if (re.test(text)) return `${country} (description)`;
  }
  for (const h of hosts) {
    const tld = h.split('.').pop();
    if (GENERIC_TLD.has(tld)) return `Global (.${tld} host)`;
  }
  return 'Unknown';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getText(url, headers = {}, attempt = 1) {
  const res = await fetch(url, { headers: { 'user-agent': 'invoice-extractor-coverage-diff', ...headers } });
  if (res.status === 404) return null;
  const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
  if ((rateLimited || res.status >= 500) && attempt < 4) {
    await sleep(1000 * attempt * attempt);
    return getText(url, headers, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function ghHeaders(token, raw = false) {
  const h = { accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Ours: providers/index.json plus each providers/<id>.json. */
export function loadOurs(root = ROOT) {
  const ids = JSON.parse(readFileSync(join(root, 'providers', 'index.json'), 'utf8'));
  return ids.map((id) => {
    const p = JSON.parse(readFileSync(join(root, 'providers', `${id}.json`), 'utf8'));
    const keys = new Set([normalizeKey(id), normalizeKey(p.name)]);
    for (const part of String(p.name).split(/[\/,]/)) keys.add(normalizeKey(part));
    for (const alias of ALIASES[id] ?? []) keys.add(normalizeKey(alias));
    keys.delete('');
    return { id, name: p.name, host: hostOf(p.billingUrl), keys };
  });
}

/** woob: modules/<name>/module.py whose class declares CapDocument or CapBill. */
export async function loadWoob() {
  const dirs = [];
  for (let page = 1; ; page++) {
    const items = JSON.parse(await getText(WOOB_TREE_API + page));
    dirs.push(...items.filter((i) => i.type === 'tree' && !i.name.startsWith('.')).map((i) => i.name));
    if (items.length < 100) break;
  }
  const found = await mapLimit(dirs, CONCURRENCY, async (dir) => {
    const src = await getText(`${WOOB_RAW}/${dir}/module.py`);
    if (!src) return null;
    const caps = capsOf(src);
    if (!caps) return null;
    return {
      name: dir,
      cap: caps,
      description: pyAttr(src, 'DESCRIPTION'),
      license: pyAttr(src, 'LICENSE') || 'LGPL (woob default)',
    };
  });
  return found.filter(Boolean);
}

/** Cozy: non-archived cozy-konnector-* repos, with cozy-clisk detection from package.json. */
export async function loadCozy(token) {
  const repos = [];
  for (let page = 1; ; page++) {
    const arr = parseJson(await getText(`https://api.github.com/orgs/${GH_ORG}/repos?per_page=100&type=public&page=${page}`, ghHeaders(token)));
    const list = Array.isArray(arr) ? arr : [];
    repos.push(...list);
    if (list.length < 100) break;
  }
  const selected = repos.filter(
    (r) => r.name.startsWith('cozy-konnector-') && !r.archived && r.name !== 'cozy-konnector-template',
  );
  return mapLimit(selected, CONCURRENCY, async (r) => {
    const base = `https://api.github.com/repos/${GH_ORG}/${r.name}/contents`;
    const pkg = parseJson((await getText(`${base}/package.json`, ghHeaders(token, true))) ?? '{}');
    const man = parseJson((await getText(`${base}/manifest.konnector`, ghHeaders(token, true))) ?? '{}');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return {
      repo: r.name,
      name: man.name || r.name,
      description: r.description || '',
      vendorHost: hostOf(man.vendor_link),
      license: pkg.license || r.license?.spdx_id || 'unknown',
      clisk: Boolean(deps['cozy-clisk']),
    };
  });
}

/**
 * Joins the three sources into one row per provider. Ours is the anchor: an upstream
 * entry joins one of our providers when its normalized name matches one of our keys.
 * Upstream entries that match nothing of ours become external rows, merged by key.
 */
export function buildRows(ours, woob, cozy) {
  const oursById = new Map(ours.map((o) => [o.id, o]));
  const oursByKey = new Map();
  for (const o of ours) for (const k of o.keys) if (!oursByKey.has(k)) oursByKey.set(k, o.id);

  const rows = new Map();
  for (const o of ours) {
    rows.set(`ours:${o.id}`, { ours: o, woob: null, cozy: null, hosts: [o.host], texts: [] });
  }
  const rowFor = (key) => {
    const oid = oursByKey.get(key);
    const rowKey = oid ? `ours:${oid}` : `ext:${key}`;
    if (!rows.has(rowKey)) rows.set(rowKey, { ours: null, woob: null, cozy: null, hosts: [], texts: [] });
    return rows.get(rowKey);
  };

  for (const m of woob) {
    const row = rowFor(normalizeKey(m.name));
    row.woob = m;
    row.texts.push(m.description);
  }
  for (const c of cozy) {
    const row = rowFor(normalizeKey(c.repo));
    row.cozy = c;
    row.hosts.push(c.vendorHost);
    row.texts.push(c.description, c.name);
  }

  return [...rows.values()].map((row) => {
    const label = row.ours?.name ?? row.cozy?.name ?? row.woob?.name ?? '';
    const licenses = [];
    if (row.ours) licenses.push('MIT (ours)');
    if (row.woob) licenses.push(`woob: ${row.woob.license}`);
    if (row.cozy) licenses.push(`Cozy: ${row.cozy.license}`);
    return {
      label,
      ours: Boolean(row.ours),
      oursId: row.ours?.id ?? '',
      woob: row.woob?.name ?? '',
      cozy: row.cozy ? row.cozy.repo.replace(/^cozy-konnector-/, '') : '',
      clisk: row.cozy ? row.cozy.clisk : null,
      country: countryGuess([row.ours?.host, ...row.hosts].filter(Boolean), [row.woob?.description, ...row.texts].filter(Boolean).join(' ')),
      licenses: licenses.join('; ') || '-',
      sources: (row.woob ? 1 : 0) + (row.cozy ? 1 : 0),
    };
  });
}

function cell(v) {
  return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function sortRows(a, b) {
  if (a.ours !== b.ours) return a.ours ? -1 : 1;
  if (a.sources !== b.sources) return b.sources - a.sources;
  if (a.clisk !== b.clisk) return a.clisk === true ? -1 : b.clisk === true ? 1 : 0;
  return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
}

/** Renders the Markdown document. */
export function renderMarkdown(rows, counts, date) {
  const sorted = [...rows].sort(sortRows);
  const yn = (v) => (v === null ? '-' : v ? 'yes' : 'no');
  const lines = [];
  lines.push('# Provider coverage: ours vs woob and Cozy konnectors', '');
  lines.push(`Generated ${date} by \`scripts/coverage-diff.mjs\`. Re-run the script to refresh it.`, '');
  lines.push(
    'Sources: our `providers/*.json`; woob modules under `modules/` in gitlab.com/woob/woob that declare `CapDocument` or `CapBill`; ' +
      'non-archived `cozy-konnector-*` repos in the `konnectors` GitHub org (template excluded).',
    '',
  );
  lines.push(
    'Only names, URLs and metadata are read from upstream. No upstream code is copied here: woob is LGPL and Cozy konnectors are AGPL, ' +
      'which cannot be combined with this MIT project. The country column is a guess from the provider host TLD, then from nationality words in the description.',
    '',
  );

  lines.push('## Summary', '');
  lines.push(`- Our providers: **${counts.ours}**`);
  lines.push(`- woob modules with CapDocument/CapBill: **${counts.woob}**`);
  lines.push(`- Cozy konnectors (non-archived, excluding template): **${counts.cozy}**, of which use cozy-clisk: **${counts.clisk}**`);
  lines.push(`- Ours also in woob: **${counts.oursInWoob}**; also in Cozy: **${counts.oursInCozy}**; also in cozy-clisk: **${counts.oursInClisk}**`);
  lines.push(`- Ours with no match in woob or Cozy: **${counts.oursNone}**`);
  lines.push(
    `- Providers in woob or Cozy but not ours: **${counts.external}** (woob only: ${counts.woobOnly}, Cozy only: ${counts.cozyOnly}, both: ${counts.both})`,
    '',
  );

  lines.push('### Ours with no match upstream', '');
  const noMatch = sorted.filter((r) => r.ours && !r.woob && !r.cozy).map((r) => r.label);
  lines.push(noMatch.length ? noMatch.map((n) => `- ${n}`).join('\n') : '- none', '');

  lines.push('### Present upstream but not ours', '');
  const external = sorted.filter((r) => !r.ours);
  lines.push(
    external.length
      ? external.map((r) => `- ${r.label} (${[r.woob && 'woob', r.cozy && 'Cozy'].filter(Boolean).join(' + ')}${r.clisk ? ', cozy-clisk' : ''})`).join('\n')
      : '- none',
    '',
  );

  lines.push('## Table', '');
  lines.push('| Provider | Ours | woob | Cozy | cozy-clisk | Country (guess) | Source license |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of sorted) {
    lines.push(
      `| ${cell(r.label)} | ${r.ours ? 'yes' : '-'} | ${r.woob ? `\`${cell(r.woob)}\`` : '-'} | ${r.cozy ? `\`${cell(r.cozy)}\`` : '-'} | ${yn(r.clisk)} | ${cell(r.country)} | ${cell(r.licenses)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(ROOT, 'docs', 'provider-coverage.md');

  const token = githubToken();
  if (!token) console.error('warning: no GitHub token found; anonymous GitHub API access is limited to 60 requests/hour');

  const ours = loadOurs();
  console.error(`ours: ${ours.length} providers`);
  const woob = await loadWoob();
  console.error(`woob: ${woob.length} modules with CapDocument/CapBill`);
  const cozy = await loadCozy(token);
  console.error(`cozy: ${cozy.length} konnectors (${cozy.filter((c) => c.clisk).length} with cozy-clisk)`);

  const rows = buildRows(ours, woob, cozy);
  const external = rows.filter((r) => !r.ours);
  const counts = {
    ours: ours.length,
    woob: woob.length,
    cozy: cozy.length,
    clisk: cozy.filter((c) => c.clisk).length,
    oursInWoob: rows.filter((r) => r.ours && r.woob).length,
    oursInCozy: rows.filter((r) => r.ours && r.cozy).length,
    oursInClisk: rows.filter((r) => r.ours && r.clisk).length,
    oursNone: rows.filter((r) => r.ours && !r.woob && !r.cozy).length,
    external: external.length,
    woobOnly: external.filter((r) => r.woob && !r.cozy).length,
    cozyOnly: external.filter((r) => r.cozy && !r.woob).length,
    both: external.filter((r) => r.woob && r.cozy).length,
  };

  const md = renderMarkdown(rows, counts, new Date().toISOString().slice(0, 10));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md);
  console.error(`wrote ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
