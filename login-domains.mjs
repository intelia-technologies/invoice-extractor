// Sign-in domain binding for credential autofill.
//
// A vault login may only be typed into a page whose host is on the allowed list:
//   - the exact host of every URL saved on the vault item (plus its subdomains),
//   - the exact host of the recipe's own billingUrl (plus its subdomains), and
//   - each `auth.loginDomains` entry the recipe declares (plus its subdomains).
// Nothing is ever widened algorithmically (no "registrable domain" guess from a partial public
// suffix list: that turns `alice.uk.com` into `uk.com`). Widening to a parent domain such as
// `openai.com` only happens through a human-reviewed `auth.loginDomains` entry in the recipe.
// The list is a set of domain suffixes, so every check is `host === d || host.endsWith('.' + d)`.

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

// A recipe `auth.loginDomains` entry: a plain lowercase host name with at least one dot. No
// scheme, port, path or wildcard, and never a single label ("com"). Mirrors the schema pattern.
const LOGIN_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function isValidLoginDomain(entry) {
  return typeof entry === 'string' && LOGIN_DOMAIN_PATTERN.test(entry);
}

export function hostMatchesDomains(host, domains = []) {
  const h = normalizeHost(host);
  if (!h) return false;
  return (Array.isArray(domains) ? domains : []).some(d => {
    const domain = String(d || '').toLowerCase().replace(/^\.+|\.+$/g, '');
    return Boolean(domain) && (h === domain || h.endsWith(`.${domain}`));
  });
}

// Exact host of a recipe URL template. A host containing a `{{config.*}}` placeholder yields
// nothing: an allowed domain never comes from a user-typed config value.
export function templateHost(template) {
  const m = String(template || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (!m || /[{}]/.test(m[1])) return '';
  return normalizeHost(m[0]);
}

export function buildAllowedLoginDomains({ itemUrls = [], provider = {} } = {}) {
  const allowed = new Set();
  const add = host => { if (host) allowed.add(host); };

  for (const u of Array.isArray(itemUrls) ? itemUrls : []) {
    const href = String((typeof u === 'string' ? u : u?.href || u?.uri) || '').trim();
    // Only web addresses count (Bitwarden also stores androidapp:// and iosapp:// URIs).
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:\/\//i.test(href)) continue;
    add(normalizeHost(href));
  }

  add(templateHost(provider?.billingUrl));

  for (const entry of Array.isArray(provider?.auth?.loginDomains) ? provider.auth.loginDomains : []) {
    // Invalid entries (single label, wildcard, scheme, path) are ignored, never interpreted.
    if (isValidLoginDomain(entry)) add(entry);
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

// Runs inside the page (Playwright serializes its source, so it must stay self-contained).
// Playwright cannot pin an evaluate to one document: if the frame navigated after the check in
// guardedAutoLogin, this runs in the new document. So it re-checks the document it actually runs
// in before handing the credentials to the engine, reading only the browser's unforgeable
// `location` and using only operators and indexing, never a String/Array/URL method a page
// script could have replaced to observe the credentials.
export function loginInPage([c, authCfg]) {
  const blocked = (reason, host) => ({ attempted: false, blocked: true, reason, host });
  const domains = c ? c.allowedLoginDomains : null;
  const count = domains && typeof domains.length === 'number' ? domains.length : 0;
  const endsOnLabel = (host, domain) => {
    if (typeof host !== 'string' || typeof domain !== 'string' || domain.length === 0) return false;
    if (host.length < domain.length) return false;
    for (let i = 1; i <= domain.length; i++) {
      if (host[host.length - i] !== domain[domain.length - i]) return false;
    }
    return host.length === domain.length || host[host.length - domain.length - 1] === '.';
  };
  const isAllowedHost = host => {
    for (let i = 0; i < count; i++) if (endsOnLabel(host, domains[i])) return true;
    return false;
  };
  const isLoopbackIp = host => {
    if (!(host[0] === '1' && host[1] === '2' && host[2] === '7' && host[3] === '.')) return false;
    for (let i = 4; i < host.length; i++) {
      const ch = host[i];
      if (ch !== '.' && (ch < '0' || ch > '9')) return false;
    }
    return true;
  };
  const isLocal = host => host === 'localhost' || endsOnLabel(host, 'localhost') || host === '[::1]' || isLoopbackIp(host);
  const problem = (scheme, host) => {
    if (!(scheme === 'https:' || (scheme === 'http:' && isLocal(host)))) return 'insecure';
    return isAllowedHost(host) ? '' : 'domain-mismatch';
  };
  // "https://host:port" -> { scheme: 'https:', host: 'host' }
  const parseOrigin = origin => {
    let scheme = '';
    let i = 0;
    const text = typeof origin === 'string' ? origin : '';
    while (i < text.length && text[i] !== ':') scheme += text[i++];
    scheme += ':';
    i += 3; // skip "://"
    let host = '';
    if (text[i] === '[') {
      while (i < text.length && text[i] !== ']') host += text[i++];
      if (i < text.length) host += text[i++];
    } else {
      while (i < text.length && text[i] !== ':' && text[i] !== '/') host += text[i++];
    }
    return { scheme, host };
  };

  const frameHost = location.hostname;
  if (count === 0) return blocked('no-allowed-domains', frameHost);
  let reason = problem(location.protocol, frameHost);
  if (reason) return blocked(reason, frameHost);
  const ancestors = location.ancestorOrigins;
  if (ancestors) {
    for (let i = 0; i < ancestors.length; i++) {
      const parent = parseOrigin(ancestors[i]);
      reason = problem(parent.scheme, parent.host);
      if (reason) return blocked(reason, parent.host);
    }
  } else if (window.top !== window) {
    return blocked('unknown-top-frame', frameHost);
  }
  return window.__invoiceEngine.attemptAutoLogin(c, authCfg);
}

// CLI / MCP autofill. The URL check and the evaluate target the same Playwright frame. The check
// runs before the credentials enter the page at all; loginInPage re-checks inside the document
// that actually receives them, and engine.js checks again at the moment of typing.
export async function guardedAutoLogin(frame, creds, authConfig = {}) {
  const check = checkLoginLocation(playwrightFrameLocation(frame), creds?.allowedLoginDomains);
  if (!check.ok) return { attempted: false, blocked: true, reason: check.reason, host: check.host };
  return frame.evaluate(loginInPage, [creds, authConfig]);
}
