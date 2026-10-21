import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Ajv from 'ajv';
import {
  buildAllowedLoginDomains,
  checkLoginLocation,
  describeLoginBlock,
  guardedAutoLogin,
  hostMatchesDomains,
  isValidLoginDomain,
  loginInPage,
  templateHost,
} from '../login-domains.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowedFor = (itemUrls, provider = {}) => buildAllowedLoginDomains({ itemUrls, provider });
const allows = (domains, url) => checkLoginLocation({ url }, domains).ok;

test('host matching accepts the host and its subdomains, never look-alikes', () => {
  const allowed = ['stripe.com'];
  assert.equal(hostMatchesDomains('stripe.com', allowed), true);
  assert.equal(hostMatchesDomains('dashboard.stripe.com', allowed), true);
  assert.equal(hostMatchesDomains('evilstripe.com', allowed), false);
  assert.equal(hostMatchesDomains('stripe.com.evil.io', allowed), false);
  assert.equal(hostMatchesDomains('stripe.co', allowed), false);
});

test('vault item and billingUrl hosts are never widened to a guessed parent domain', () => {
  // Exact host + subdomains only: app.holded.com does not allow holded.com or a sibling.
  const holded = allowedFor(['https://app.holded.com/login'], {});
  assert.deepEqual(holded, ['app.holded.com']);
  assert.equal(allows(holded, 'https://app.holded.com/login'), true);
  assert.equal(allows(holded, 'https://eu.app.holded.com/login'), true);
  assert.equal(allows(holded, 'https://holded.com/login'), false);
  assert.equal(allows(holded, 'https://www.holded.com/login'), false);

  // Shared namespaces stay per tenant: no "uk.com" or "amazonaws.com" from a partial suffix list.
  const ukCom = allowedFor(['https://alice.uk.com/login'], {});
  assert.deepEqual(ukCom, ['alice.uk.com']);
  assert.equal(allows(ukCom, 'https://bob.uk.com/login'), false);
  const apiGateway = allowedFor(['https://abc123.execute-api.eu-west-1.amazonaws.com/prod/login'], {});
  assert.deepEqual(apiGateway, ['abc123.execute-api.eu-west-1.amazonaws.com']);
  assert.equal(allows(apiGateway, 'https://evil.execute-api.eu-west-1.amazonaws.com/login'), false);
  assert.equal(allows(apiGateway, 'https://s3.amazonaws.com/login'), false);
  assert.equal(allows(allowedFor(['https://acme.github.io']), 'https://evil.github.io/'), false);

  // billingUrl: exact host; a host with a config placeholder contributes nothing.
  assert.equal(templateHost('https://dashboard.stripe.com/{{config.accountId}}/invoices'), 'dashboard.stripe.com');
  assert.equal(templateHost('https://{{config.workspace}}.webflow.com/billing'), '');
  assert.equal(templateHost('https://{{config.host}}/billing'), '');
  assert.deepEqual(allowedFor([], { billingUrl: 'https://{{config.ws}}.example.com/billing' }), []);

  // App URIs never count.
  assert.deepEqual(allowedFor([{ uri: 'androidapp://com.stripe.android' }, { href: 'https://dashboard.stripe.com' }]), ['dashboard.stripe.com']);
});

test('sibling sign-in subdomain is refused without loginDomains and allowed with it', () => {
  const bare = { billingUrl: 'https://platform.openai.com/settings/organization/billing/history' };
  assert.equal(allows(allowedFor([], bare), 'https://auth.openai.com/log-in'), false);
  assert.equal(allows(allowedFor([], bare), 'https://platform.openai.com/login'), true);

  const declared = { ...bare, auth: { loginDomains: ['openai.com'] } };
  assert.deepEqual(allowedFor([], declared), ['openai.com', 'platform.openai.com']);
  assert.equal(allows(allowedFor([], declared), 'https://auth.openai.com/log-in'), true);
  assert.equal(allows(allowedFor([], declared), 'https://openai.com.evil.io/log-in'), false);

  // Item without URLs falls back to the recipe's own hosts (billingUrl + loginDomains).
  assert.deepEqual(
    allowedFor([], { billingUrl: 'https://app.coderabbit.ai/x', auth: { loginDomains: ['github.com'] } }),
    ['app.coderabbit.ai', 'github.com']
  );
});

test('invalid loginDomains entries are rejected by the code and by the schema', () => {
  const invalid = ['com', 'uk', 'localhost', '*.stripe.com', 'https://stripe.com', 'stripe.com/login', 'stripe.com:443', 'Stripe.com', '.stripe.com', '', 42];
  for (const entry of invalid) {
    assert.equal(isValidLoginDomain(entry), false, `${JSON.stringify(entry)} must be rejected`);
  }
  assert.deepEqual(allowedFor([], { auth: { loginDomains: invalid } }), [], 'invalid entries never reach the allowed list');
  for (const entry of ['stripe.com', 'accounts.google.com', 'naturgy.es']) assert.equal(isValidLoginDomain(entry), true);

  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(readFileSync(join(ROOT, 'providers', 'schema.json'), 'utf8'));
  const validate = ajv.compile(schema);
  const base = JSON.parse(readFileSync(join(ROOT, 'providers', 'openai.json'), 'utf8'));
  const withDomains = loginDomains => ({ ...base, auth: { ...base.auth, loginDomains } });
  assert.equal(validate(withDomains(['openai.com'])), true, JSON.stringify(validate.errors));
  for (const entry of ['com', '*.openai.com', 'https://openai.com', 'openai.com/login', 'OpenAI.com']) {
    assert.equal(validate(withDomains([entry])), false, `schema must reject ${entry}`);
  }
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
  assert.deepEqual(creds.allowedLoginDomains, ['dashboard.stripe.com']);
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
  assert.deepEqual(noUrlCreds.allowedLoginDomains, ['app.coderabbit.ai', 'github.com']);
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
  assert.deepEqual(creds.allowedLoginDomains, ['accounts.hetzner.com']);
});

test('extension bridge adds sign-in domains even when an older native host omits them', async () => {
  const { createOnePasswordBridge } = await import('../onepassword.mjs');
  const bridge = createOnePasswordBridge({
    sendNativeMessage: async () => ({ ok: true, data: { username: 'u', password: 'p', urls: ['https://my.vultr.com'] } }),
  });
  const creds = await bridge.dispatch('resolveProvider', { provider: { id: 'vultr', billingUrl: 'https://my.vultr.com/billing/' } });
  assert.deepEqual(creds.allowedLoginDomains, ['my.vultr.com']);
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

// A page document for loginInPage: its own location, a page-defined (possibly hostile)
// __invoiceEngine, and optionally tampered built-ins.
function pageDocument(href, { ancestorOrigins = [], tamper = false } = {}) {
  const url = new URL(href);
  const received = [];
  const window = {
    __invoiceEngine: { attemptAutoLogin: (c, a) => { received.push(c); return { attempted: true, filledPassword: true }; } },
  };
  window.top = window;
  const context = vm.createContext({
    window,
    location: { href, hostname: url.hostname, protocol: url.protocol, ancestorOrigins },
  });
  if (tamper) {
    // A hostile page replacing built-ins to observe or bypass the check.
    vm.runInContext(`
      String.prototype.endsWith = function () { throw new Error('tampered endsWith'); };
      String.prototype.slice = function () { throw new Error('tampered slice'); };
      Array.prototype.some = function () { return true; };
      globalThis.URL = function () { throw new Error('tampered URL'); };
    `, context);
  }
  const run = vm.runInContext(`(${loginInPage.toString()})`, context);
  return { run, received };
}

test('CLI in-page re-check: a navigation after the URL check never hands credentials to the new page', async () => {
  const creds = { username: 'u', password: 'vault-secret', allowedLoginDomains: ['dashboard.stripe.com'] };

  // The frame passes the check, then navigates before evaluate runs: the hostile document
  // defines its own __invoiceEngine to catch the credentials.
  const hostile = pageDocument('https://stripe-login.evil.example/', { tamper: true });
  const racingFrame = {
    url: () => 'https://dashboard.stripe.com/login',
    parentFrame: () => null,
    evaluate: async (fn, args) => {
      assert.equal(fn, loginInPage, 'evaluate must run the self-contained in-page guard');
      return hostile.run(args);
    },
  };
  const res = await guardedAutoLogin(racingFrame, creds, {});
  assert.deepEqual({ ...res }, { attempted: false, blocked: true, reason: 'domain-mismatch', host: 'stripe-login.evil.example' });
  assert.equal(hostile.received.length, 0, 'the new page must never receive the credentials');

  // Same document but plain http, or a hostile parent frame: refused.
  const http = pageDocument('http://dashboard.stripe.com/login');
  assert.equal(http.run([creds, {}]).reason, 'insecure');
  const framed = pageDocument('https://dashboard.stripe.com/login', { ancestorOrigins: ['https://phish.example:8443'] });
  assert.equal(framed.run([creds, {}]).host, 'phish.example');
  assert.equal(http.received.length + framed.received.length, 0);

  // The allowed page still signs in, even with tampered built-ins (the guard uses none of them).
  const legit = pageDocument('https://dashboard.stripe.com/login', { tamper: true, ancestorOrigins: ['https://dashboard.stripe.com'] });
  assert.equal(legit.run([creds, {}]).filledPassword, true);
  assert.equal(legit.received.length, 1);
  const subdomain = pageDocument('https://eu.dashboard.stripe.com/login', { tamper: true });
  assert.equal(subdomain.run([creds, {}]).attempted, true);
  const lookalike = pageDocument('https://xdashboard.stripe.com/login', { tamper: true });
  assert.equal(lookalike.run([creds, {}]).reason, 'domain-mismatch');
  const local = pageDocument('http://127.0.0.1:4100/login');
  assert.equal(local.run([{ ...creds, allowedLoginDomains: ['127.0.0.1'] }, {}]).attempted, true);
  const noDomains = pageDocument('https://dashboard.stripe.com/login');
  assert.equal(noDomains.run([{ username: 'u', password: 'p' }, {}]).reason, 'no-allowed-domains');
  assert.equal(noDomains.received.length, 0);
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
