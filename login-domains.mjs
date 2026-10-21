// Sign-in domain binding for credential autofill.
//
// A vault login may only be typed into a page whose host belongs to an allowed domain:
//   - the registrable domain (eTLD+1) of every URL saved on the vault item, and
//   - the registrable domain of the recipe's own billingUrl, plus any `auth.loginDomains`
//     the recipe declares for SSO / identity hosts (kept as declared: that host and its
//     subdomains only).
// The resulting list is a set of domain suffixes, so the in-page check (engine.js) and the
// popup pre-check only need `host === d || host.endsWith('.' + d)` — no suffix list in the page.
//
// No network fetch of the Public Suffix List: a short vendored list plus a ccTLD heuristic
// (`<generic label>.<2-letter TLD>`, e.g. co.uk, com.es) is enough to keep `evil.co.uk` from
// matching `good.co.uk`. Unknown cases err on the strict side (exact host match).

// Multi-part public suffixes not covered by the ccTLD heuristic below.
const EXTRA_PUBLIC_SUFFIXES = new Set([
  'me.uk', 'gv.at', 'priv.at', 'asso.fr', 'gouv.fr', 'k12.ca.us',
]);

// Shared-hosting suffixes (PSL private section) where every subdomain is a different owner.
const PRIVATE_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'bitbucket.io', 'github.dev', 'pages.dev', 'workers.dev', 'r2.dev',
  'vercel.app', 'netlify.app', 'web.app', 'firebaseapp.com', 'appspot.com', 'run.app',
  'cloudfunctions.net', 'herokuapp.com', 'azurewebsites.net', 'azurestaticapps.net',
  'cloudfront.net', 's3.amazonaws.com', 'amplifyapp.com', 'onrender.com', 'fly.dev',
  'railway.app', 'deno.dev', 'glitch.me', 'repl.co', 'ngrok.io', 'ngrok-free.app',
  'trycloudflare.com', 'surge.sh', 'blogspot.com', 'wordpress.com', 'wixsite.com',
  'myshopify.com', 'webflow.io', 'framer.app',
]);

// Second-level labels that ccTLD registries use as public suffixes (co.uk, com.es, ne.jp...).
const GENERIC_SECOND_LEVEL = new Set([
  'ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'ltd', 'mil', 'ne', 'net', 'nic', 'nom', 'or',
  'org', 'plc', 'sch',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function normalizeHost(value) {
  if (!value || typeof value !== 'string') return '';
  let raw = value.trim().toLowerCase();
  if (!raw) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    raw = raw.replace(/^\/+/, '');
    if ((raw.match(/:/g) || []).length > 1 && !raw.startsWith('[')) raw = `[${raw}]`; // bare IPv6
    raw = `https://${raw}`;
  }
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    return '';
  }
  return host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

export function isLocalHost(host) {
  const h = normalizeHost(host);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function isIpAddress(host) {
  return IPV4.test(host) || host.includes(':');
}

export function publicSuffixOf(host) {
  const h = normalizeHost(host);
  if (!h || isIpAddress(h) || !h.includes('.')) return '';
  const labels = h.split('.');
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (PRIVATE_SUFFIXES.has(candidate) || EXTRA_PUBLIC_SUFFIXES.has(candidate)) return candidate;
  }
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (labels.length >= 2 && tld.length === 2 && GENERIC_SECOND_LEVEL.has(sld)) return `${sld}.${tld}`;
  return tld;
}

// eTLD+1 of a host; the host itself for IPs / single-label hosts; '' for a bare public suffix.
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h) return '';
  if (isIpAddress(h) || !h.includes('.')) return h;
  const suffix = publicSuffixOf(h);
  if (!suffix || h === suffix) return '';
  const rest = h.slice(0, h.length - suffix.length - 1).split('.');
  return `${rest[rest.length - 1]}.${suffix}`;
}

export function hostMatchesDomains(host, domains = []) {
  const h = normalizeHost(host);
  if (!h) return false;
  return (Array.isArray(domains) ? domains : []).some(d => {
    const domain = String(d || '').toLowerCase().replace(/^\.+|\.+$/g, '');
    return Boolean(domain) && (h === domain || h.endsWith(`.${domain}`));
  });
}

// Host of a recipe URL template. Leading labels that are `{{config.*}}` placeholders are dropped
// (`https://{{config.ws}}.example.com` → `example.com`): the allowed domain comes from the
// recipe author, never from a user-typed config value.
export function templateHost(template) {
  const m = String(template || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (!m) return '';
  const authority = m[1]
    .replace(/\{\{[^}]*\}\}/g, '*') // placeholders may contain dots ({{config.ws}})
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  const labels = authority.split('.');
  while (labels.length && labels[0].includes('*')) labels.shift();
  if (labels.some(l => l.includes('*') || l.includes('{') || l.includes('}'))) return '';
  return normalizeHost(labels.join('.'));
}

export function buildAllowedLoginDomains({ itemUrls = [], provider = {} } = {}) {
  const allowed = new Set();
  const add = domain => { if (domain) allowed.add(domain); };

  for (const u of Array.isArray(itemUrls) ? itemUrls : []) {
    const href = String((typeof u === 'string' ? u : u?.href || u?.uri) || '').trim();
    // Only web addresses count (Bitwarden also stores androidapp:// and iosapp:// URIs).
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:\/\//i.test(href)) continue;
    add(registrableDomain(normalizeHost(href)));
  }

  add(registrableDomain(templateHost(provider?.billingUrl)));

  for (const entry of Array.isArray(provider?.auth?.loginDomains) ? provider.auth.loginDomains : []) {
    const host = normalizeHost(String(entry || ''));
    // A bare public suffix ("com", "co.uk") would allow every site: ignore it.
    if (host && registrableDomain(host)) add(host);
  }

  return Array.from(allowed).sort();
}

// Decides whether the frame at `url` (and every ancestor origin) may receive a login.
export function checkLoginLocation({ url = '', ancestorOrigins = [] } = {}, allowedDomains = []) {
  const domains = Array.isArray(allowedDomains) ? allowedDomains.filter(Boolean) : [];
  const chain = [url, ...(Array.isArray(ancestorOrigins) ? ancestorOrigins : [])];
  let frameHost = '';
  try { frameHost = new URL(url).hostname; } catch {}
  if (domains.length === 0) return { ok: false, reason: 'no-allowed-domains', host: frameHost };

  for (const entry of chain) {
    let parsed;
    try { parsed = new URL(entry); } catch { return { ok: false, reason: 'invalid-url', host: String(entry || '') }; }
    const host = normalizeHost(parsed.hostname);
    const secure = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalHost(host));
    if (!secure) return { ok: false, reason: 'insecure', host: host || parsed.protocol };
    if (!hostMatchesDomains(host, domains)) return { ok: false, reason: 'domain-mismatch', host };
  }
  return { ok: true, host: frameHost };
}

// Human message for CLI/MCP output when autofill was refused.
export function describeLoginBlock({ host = '', reason = '', providerName = '' } = {}) {
  const who = providerName || 'this provider';
  const where = host || 'unknown';
  if (reason === 'insecure') {
    return `sign-in page ${where} is not served over HTTPS; nothing was typed for ${who}`;
  }
  return `sign-in page ${where} does not match the saved login for ${who}; nothing was typed`;
}

// Adds `allowedLoginDomains` to a resolved credential payload for `provider`.
export function withAllowedLoginDomains(creds, provider = {}) {
  if (!creds || typeof creds !== 'object') return creds;
  return {
    ...creds,
    allowedLoginDomains: buildAllowedLoginDomains({ itemUrls: creds.urls || [], provider }),
  };
}

// Where a Playwright frame is, as the browser reports it (not page JavaScript): its URL plus
// the URL of every parent frame up to the top.
export function playwrightFrameLocation(frame) {
  const ancestorOrigins = [];
  for (let parent = frame?.parentFrame?.(); parent; parent = parent.parentFrame()) {
    ancestorOrigins.push(parent.url());
  }
  return { url: frame?.url?.() || '', ancestorOrigins };
}

// CLI / MCP autofill: checks the frame before the credentials enter the page at all, then
// lets engine.js check again at the moment of typing.
export async function guardedAutoLogin(frame, creds, authConfig = {}) {
  const check = checkLoginLocation(playwrightFrameLocation(frame), creds?.allowedLoginDomains);
  if (!check.ok) return { attempted: false, blocked: true, reason: check.reason, host: check.host };
  return frame.evaluate(
    ([c, authCfg]) => window.__invoiceEngine.attemptAutoLogin(c, authCfg),
    [creds, authConfig]
  );
}
