import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  buildAllowedLoginDomains,
  checkLoginLocation,
  describeLoginBlock,
  guardedAutoLogin,
  hostMatchesDomains,
  registrableDomain,
  templateHost,
} from '../login-domains.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('registrable domain handles plain, multi-part and shared-hosting suffixes', () => {
  assert.equal(registrableDomain('dashboard.stripe.com'), 'stripe.com');
  assert.equal(registrableDomain('https://omega.naturgy.es/login'), 'naturgy.es');
  assert.equal(registrableDomain('billing.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('a.b.tienda.com.es'), 'tienda.com.es');
  assert.equal(registrableDomain('shop.example.com.au'), 'example.com.au');
  assert.equal(registrableDomain('acme.github.io'), 'acme.github.io');
  assert.equal(registrableDomain('co.uk'), '', 'a bare public suffix is not registrable');
  assert.equal(registrableDomain('com'), 'com');
  assert.equal(registrableDomain('localhost:8080'), 'localhost');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
});

test('host matching accepts the domain and its subdomains, never look-alikes', () => {
  const allowed = ['stripe.com', 'example.co.uk'];
  assert.equal(hostMatchesDomains('stripe.com', allowed), true);
  assert.equal(hostMatchesDomains('dashboard.stripe.com', allowed), true);
  assert.equal(hostMatchesDomains('login.example.co.uk', allowed), true);
  assert.equal(hostMatchesDomains('evilstripe.com', allowed), false);
  assert.equal(hostMatchesDomains('stripe.com.evil.io', allowed), false);
  assert.equal(hostMatchesDomains('other.co.uk', allowed), false);
  assert.equal(hostMatchesDomains('stripe.co', allowed), false);
});

test('allowed sign-in domains come from vault item URLs plus the recipe, never user config', () => {
  const stripe = {
    billingUrl: 'https://dashboard.stripe.com/{{config.accountId}}/settings/plans-and-fees/invoice-history',
  };
  assert.deepEqual(
    buildAllowedLoginDomains({ itemUrls: [{ href: 'https://www.stripe.com/login' }, 'https://billing.acme.co.uk'], provider: stripe }),
    ['acme.co.uk', 'stripe.com']
  );

  // Item without URLs falls back to the recipe's own domains.
  assert.deepEqual(
    buildAllowedLoginDomains({ itemUrls: [], provider: { billingUrl: 'https://app.coderabbit.ai/x', auth: { loginDomains: ['github.com'] } } }),
    ['coderabbit.ai', 'github.com']
  );

  // A config placeholder in the host is dropped, so a typed value can never become an allowed domain.
  assert.equal(templateHost('https://{{config.workspace}}.webflow.com/billing'), 'webflow.com');
  assert.equal(templateHost('https://{{config.host}}/billing'), '');
  assert.deepEqual(buildAllowedLoginDomains({ provider: { billingUrl: 'https://{{config.host}}/billing' } }), []);

  // App URIs and bare public suffixes never widen the list.
  assert.deepEqual(
    buildAllowedLoginDomains({
      itemUrls: [{ uri: 'androidapp://com.stripe.android' }, { href: 'https://dashboard.stripe.com' }],
      provider: { auth: { loginDomains: ['co.uk', 'accounts.google.com'] } },
    }),
    ['accounts.google.com', 'stripe.com']
  );
});

test('sign-in location check: https on an allowed domain only, iframe ancestors included', () => {
  const allowed = ['stripe.com'];
  assert.deepEqual(checkLoginLocation({ url: 'https://dashboard.stripe.com/login' }, allowed), { ok: true, host: 'dashboard.stripe.com' });
  assert.equal(checkLoginLocation({ url: 'https://stripe.com.evil.io/login' }, allowed).reason, 'domain-mismatch');
  assert.equal(checkLoginLocation({ url: 'http://dashboard.stripe.com/login' }, allowed).reason, 'insecure');
  assert.equal(checkLoginLocation({ url: 'about:srcdoc' }, allowed).reason, 'insecure');
  assert.equal(checkLoginLocation({ url: 'https://dashboard.stripe.com/login' }, []).reason, 'no-allowed-domains');

  // http is only tolerated on localhost test fixtures, and they still need to be allowed.
  assert.equal(checkLoginLocation({ url: 'http://localhost:4100/login' }, ['localhost']).ok, true);
  assert.equal(checkLoginLocation({ url: 'http://localhost:4100/login' }, allowed).reason, 'domain-mismatch');

  // Login form inside an iframe: the frame and every parent must be allowed.
  assert.equal(
    checkLoginLocation({ url: 'https://login.stripe.com/frame', ancestorOrigins: ['https://dashboard.stripe.com'] }, allowed).ok,
    true
  );
  const phishingTop = checkLoginLocation(
    { url: 'https://login.stripe.com/frame', ancestorOrigins: ['https://stripe-billing.example'] },
    allowed
  );
  assert.deepEqual(phishingTop, { ok: false, reason: 'domain-mismatch', host: 'stripe-billing.example' });
  const phishingFrame = checkLoginLocation(
    { url: 'https://evil.example/fake-login', ancestorOrigins: ['https://dashboard.stripe.com'] },
    allowed
  );
  assert.equal(phishingFrame.host, 'evil.example');

  assert.equal(
    describeLoginBlock({ host: 'evil.example', reason: 'domain-mismatch', providerName: 'Stripe' }),
    'sign-in page evil.example does not match the saved login for Stripe; nothing was typed'
  );
});

test('explicit item reference still chooses the item, but its login is bound to its domains', async () => {
  const { handleHostRequest } = await import('../scripts/onepassword-host.mjs');
  const items = {
    'op-stripe': {
      id: 'op-stripe',
      title: 'Stripe Acme',
      vault: { name: 'AI' },
      urls: [{ href: 'https://dashboard.stripe.com/login' }],
      fields: [
        { purpose: 'USERNAME', value: 'billing@acme.example' },
        { purpose: 'PASSWORD', value: 'stripe-pass' },
      ],
    },
    'op-github': {
      id: 'op-github',
      title: 'GitHub Acme',
      vault: { name: 'AI' },
      urls: [],
      fields: [
        { purpose: 'USERNAME', value: 'acme-bot' },
        { purpose: 'PASSWORD', value: 'gh-pass' },
      ],
    },
  };
  const runOp = async args => {
    if (args[0] === 'item' && args[1] === 'list') {
      return JSON.stringify(Object.values(items).map(({ fields, ...summary }) => summary));
    }
    if (args[0] === 'item' && args[1] === 'get' && items[args[2]]) return JSON.stringify(items[args[2]]);
    throw new Error(`Unexpected op call: ${args.join(' ')}`);
  };
  const deps = { tokens: { OP_SERVICE_ACCOUNT_TOKEN_INTELIA: 'ops_test' }, runOp };

  const creds = await handleHostRequest(
    {
      action: 'resolveProvider',
      provider: { id: 'stripe', name: 'Stripe', billingUrl: 'https://dashboard.stripe.com/{{config.accountId}}/invoices' },
      billingUrl: 'https://dashboard.stripe.com/acct_1/invoices',
      itemOverride: 'op://AI/Stripe Acme',
    },
    deps
  );
  assert.equal(creds.title, 'Stripe Acme');
  assert.deepEqual(creds.allowedLoginDomains, ['stripe.com']);
  assert.equal(checkLoginLocation({ url: 'https://stripe.com.evil.io/login' }, creds.allowedLoginDomains).ok, false);
  assert.equal(checkLoginLocation({ url: 'https://dashboard.stripe.com/login' }, creds.allowedLoginDomains).ok, true);

  // Item without URLs: only the recipe's domains (billingUrl + loginDomains) are allowed.
  const noUrlCreds = await handleHostRequest(
    {
      action: 'resolveProvider',
      provider: { id: 'coderabbit', name: 'CodeRabbit', billingUrl: 'https://app.coderabbit.ai/settings/billing', auth: { loginDomains: ['github.com'] } },
      itemOverride: 'GitHub Acme',
    },
    deps
  );
  assert.deepEqual(noUrlCreds.allowedLoginDomains, ['coderabbit.ai', 'github.com']);
  assert.equal(checkLoginLocation({ url: 'https://github.com/login' }, noUrlCreds.allowedLoginDomains).ok, true);
  assert.equal(checkLoginLocation({ url: 'https://gitlab.com/users/sign_in' }, noUrlCreds.allowedLoginDomains).ok, false);
});

test('Bitwarden login.uris feed the allowed sign-in domains like 1Password urls', async () => {
  const { normalizeBitwardenItem, extractCredentialsFromOpItem } = await import('../onepassword.mjs');
  const { withAllowedLoginDomains } = await import('../login-domains.mjs');
  const item = normalizeBitwardenItem({
    id: 'bw-1',
    name: 'Hetzner',
    login: { username: 'ops', password: 'pw', uris: [{ uri: 'https://accounts.hetzner.com/login' }, { uri: 'androidapp://com.hetzner' }] },
  });
  const creds = withAllowedLoginDomains(extractCredentialsFromOpItem(item), { billingUrl: 'https://accounts.hetzner.com/invoice' });
  assert.deepEqual(creds.allowedLoginDomains, ['hetzner.com']);
});

test('extension bridge adds sign-in domains even when an older native host omits them', async () => {
  const { createOnePasswordBridge } = await import('../onepassword.mjs');
  const bridge = createOnePasswordBridge({
    sendNativeMessage: async () => ({ ok: true, data: { username: 'u', password: 'p', urls: ['https://my.vultr.com'] } }),
  });
  const creds = await bridge.dispatch('resolveProvider', { provider: { id: 'vultr', billingUrl: 'https://my.vultr.com/billing/' } });
  assert.deepEqual(creds.allowedLoginDomains, ['vultr.com']);
});

// Playwright-like frame stub: url()/parentFrame() as the browser reports them.
function fakeFrame(url, parent = null) {
  const calls = [];
  return {
    calls,
    url: () => url,
    parentFrame: () => parent,
    evaluate: async (fn, args) => { calls.push(args); return { attempted: true }; },
  };
}

test('CLI guard refuses before the credentials reach a page on the wrong domain', async () => {
  const creds = { username: 'u', password: 'p', allowedLoginDomains: ['stripe.com'] };

  const evil = fakeFrame('https://stripe.com.evil.io/login');
  const blocked = await guardedAutoLogin(evil, creds, {});
  assert.deepEqual(blocked, { attempted: false, blocked: true, reason: 'domain-mismatch', host: 'stripe.com.evil.io' });
  assert.equal(evil.calls.length, 0, 'engine must not be called, credentials never enter the page');

  const http = fakeFrame('http://dashboard.stripe.com/login');
  assert.equal((await guardedAutoLogin(http, creds, {})).reason, 'insecure');
  assert.equal(http.calls.length, 0);

  const framed = fakeFrame('https://login.stripe.com/embed', fakeFrame('https://phish.example/'));
  assert.equal((await guardedAutoLogin(framed, creds, {})).host, 'phish.example');
  assert.equal(framed.calls.length, 0);

  const legit = fakeFrame('https://dashboard.stripe.com/login');
  assert.deepEqual(await guardedAutoLogin(legit, creds, { submitSelector: '#go' }), { attempted: true });
  assert.equal(legit.calls.length, 1);

  const noDomains = fakeFrame('https://dashboard.stripe.com/login');
  assert.equal((await guardedAutoLogin(noDomains, { username: 'u', password: 'p' }, {})).reason, 'no-allowed-domains');
  assert.equal(noDomains.calls.length, 0);
});

// --- engine.js in-page check (runs the real engine in a minimal fake DOM) ---

class FakeInput {
  constructor(kind) {
    this.kind = kind;
    this._value = '';
    this.disabled = false;
    this.readOnly = false;
    this.form = null;
    this.parentElement = { querySelectorAll: () => [] };
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  focus() {}
  blur() {}
  dispatchEvent() { return true; }
  closest() { return null; }
}

function loadEngine({ href, ancestorOrigins = [], framed = false }) {
  const user = new FakeInput('user');
  const pass = new FakeInput('pass');
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('type="password"')) return [pass];
      if (selector.includes('autocomplete="username"')) return [user];
      return [];
    },
  };
  const url = new URL(href);
  const window = {
    __invoiceUtils: {
      isElementVisible: () => true,
      textMatches: () => false,
      simulateRealClick: () => {},
    },
  };
  window.top = framed ? {} : window;
  const context = vm.createContext({
    window,
    document,
    location: { href, hostname: url.hostname, protocol: url.protocol, ancestorOrigins },
    URL,
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    HTMLInputElement: FakeInput,
    setTimeout,
    console: { log() {}, warn() {} },
  });
  vm.runInContext(readFileSync(join(ROOT, 'engine.js'), 'utf8'), context);
  return { engine: window.__invoiceEngine, user, pass };
}

const SECRET = { username: 'billing@acme.example', password: 'vault-secret' };

test('engine types the login on an allowed https page', async () => {
  const { engine, user, pass } = loadEngine({ href: 'https://dashboard.stripe.com/login' });
  const res = await engine.attemptAutoLogin({ ...SECRET, allowedLoginDomains: ['stripe.com'] }, {});
  assert.equal(res.filledUsername && res.filledPassword, true);
  assert.equal(user.value, SECRET.username);
  assert.equal(pass.value, SECRET.password);
});

test('engine types nothing on a mismatched, insecure, unbound or phishing-framed page', async () => {
  const cases = [
    [{ href: 'https://stripe.com.evil.io/login' }, ['stripe.com'], 'domain-mismatch'],
    [{ href: 'http://dashboard.stripe.com/login' }, ['stripe.com'], 'insecure'],
    [{ href: 'https://dashboard.stripe.com/login' }, undefined, 'no-allowed-domains'],
    [{ href: 'https://login.stripe.com/frame', ancestorOrigins: ['https://phish.example'], framed: true }, ['stripe.com'], 'domain-mismatch'],
  ];
  for (const [page, allowedLoginDomains, reason] of cases) {
    const { engine, user, pass } = loadEngine(page);
    const res = await engine.attemptAutoLogin({ ...SECRET, allowedLoginDomains }, {});
    assert.equal(res.blocked, true, `${page.href} must be blocked`);
    assert.equal(res.reason, reason);
    assert.equal(user.value, '', `${page.href}: username must not be typed`);
    assert.equal(pass.value, '', `${page.href}: password must not be typed`);
  }

  // Login iframe on the provider's domain inside the provider's own page is fine.
  const { engine, pass } = loadEngine({
    href: 'https://login.stripe.com/frame',
    ancestorOrigins: ['https://dashboard.stripe.com'],
    framed: true,
  });
  const ok = await engine.attemptAutoLogin({ ...SECRET, allowedLoginDomains: ['stripe.com'] }, {});
  assert.equal(ok.filledPassword, true);
  assert.equal(pass.value, SECRET.password);

  // http allowed only for localhost fixtures.
  const local = loadEngine({ href: 'http://localhost:4100/login' });
  const localRes = await local.engine.attemptAutoLogin({ ...SECRET, allowedLoginDomains: ['localhost'] }, {});
  assert.equal(localRes.filledPassword, true);
});

test('every provider recipe yields at least one allowed sign-in domain', () => {
  const ids = JSON.parse(readFileSync(join(ROOT, 'providers', 'index.json'), 'utf8'));
  for (const id of ids) {
    const provider = JSON.parse(readFileSync(join(ROOT, 'providers', `${id}.json`), 'utf8'));
    const domains = buildAllowedLoginDomains({ provider });
    assert.ok(domains.length > 0, `${id} has no sign-in domain from its recipe`);
  }
});
