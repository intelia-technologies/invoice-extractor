import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileSync, serviceOrigin } from '../profile-sync.mjs';
import { validateDocument, canonical, MAX_DOCUMENT_BYTES } from '../sync-schema.mjs';

const profile = name => ({ id: 'personal', name, snapshot: { activeProviders: ['webflow'], configs: { webflow: { workspace: 'https://example.com/workspace', teams: ['one', 'two'] } } } });
const document = name => ({ schemaVersion: 1, profiles: [profile(name)] });
const password = 'test-password-long-enough';
const session = { accessToken: 'access', expiresAt: Date.now() + 30 * 86400000, user: { id: 'user-one', username: 'test.user' } };

function storage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}
function cloud() {
  let remote = { document: { schemaVersion: 1, profiles: [] }, revision: null };
  let version = 0;
  let offline = false;
  let rejectNextPut = false;
  const calls = [];
  return {
    calls,
    get remote() { return structuredClone(remote); },
    set remote(value) { remote = structuredClone(value); },
    set offline(value) { offline = value; },
    set rejectNextPut(value) { rejectNextPut = value; },
    async fetcher(url, options = {}) {
      calls.push({ url, ...options });
      if (offline) throw new Error('offline');
      const json = (body, status = 200) => Response.json(body, { status });
      if (url.endsWith('/config')) return json({ auth: 'password', schemaVersion: 1 });
      if (url.endsWith('/auth/register') || url.endsWith('/auth/login')) return json(session);
      if (url.endsWith('/auth/logout')) return json({ ok: true });
      assert.equal(options.headers.Authorization, 'Bearer access');
      if (options.method === 'GET') return json(remote);
      const body = JSON.parse(options.body);
      if (rejectNextPut || body.revision !== remote.revision) {
        rejectNextPut = false;
        return json({ error: 'conflict' }, 409);
      }
      remote = { document: body.document, revision: `revision-${++version}` };
      return json({ revision: remote.revision });
    },
  };
}
function device(server, profiles = []) {
  const store = storage({ profiles, loadedProfileId: 'personal', providerConfig_webflow: { workspace: 'local-live' }, downloadHistory: [{ filename: 'local.pdf' }] });
  const sync = createProfileSync({ storage: store, fetcher: server.fetcher, now: () => 100000 });
  return { store, sync };
}
async function login(sync) {
  return sync.dispatch('login', { endpoint: 'https://sync.example', username: 'test.user', password });
}
async function save(device, name) {
  await device.sync.dispatch('save', { profiles: document(name).profiles, expected: JSON.stringify(device.store.data.profiles), loadedProfileId: 'personal' });
}

test('two devices synchronize saved presets without applying live settings or sharing downloads', async () => {
  const server = cloud();
  const first = device(server, document('Home').profiles);
  const second = device(server);
  assert.equal((await login(first.sync)).status, 'synced');
  assert.equal((await login(second.sync)).status, 'synced');
  assert.deepEqual(second.store.data.profiles, document('Home').profiles);
  await save(first, 'Travel');
  await first.sync.dispatch('sync');
  await second.sync.dispatch('sync');
  assert.equal(second.store.data.profiles[0].name, 'Travel');
  assert.deepEqual(second.store.data.providerConfig_webflow, { workspace: 'local-live' });
  assert.equal(second.store.data.loadedProfileId, 'personal');
  assert.deepEqual(second.store.data.downloadHistory, [{ filename: 'local.pdf' }]);
  const upload = server.calls.find(call => call.method === 'PUT');
  assert.deepEqual(Object.keys(JSON.parse(upload.body)), ['document', 'revision']);
  assert.ok(!upload.body.includes('local.pdf'));
  assert.ok(!upload.body.includes('local-live'));
});

test('first login does not silently overwrite either populated copy', async () => {
  const server = cloud();
  server.remote = { document: document('Cloud'), revision: 'existing' };
  const local = device(server, document('Local').profiles);
  assert.equal((await login(local.sync)).status, 'conflict');
  assert.equal(local.store.data.profiles[0].name, 'Local');
  assert.equal(server.remote.document.profiles[0].name, 'Cloud');
  await local.sync.dispatch('resolve', { choice: 'remote' });
  assert.equal(local.store.data.profiles[0].name, 'Cloud');
  assert.equal(local.store.data.profileSyncBackup.document.profiles[0].name, 'Local');
});

test('divergent edits survive conflict and explicit local resolution', async () => {
  const server = cloud();
  const first = device(server, document('Original').profiles);
  const second = device(server);
  await login(first.sync);
  await login(second.sync);
  await save(first, 'First edit');
  await save(second, 'Second edit');
  await first.sync.dispatch('sync');
  assert.equal((await second.sync.dispatch('sync')).status, 'conflict');
  await second.sync.dispatch('sync');
  assert.equal(server.remote.document.profiles[0].name, 'First edit');
  assert.equal(second.store.data.profiles[0].name, 'Second edit');
  await second.sync.dispatch('resolve', { choice: 'local' });
  assert.equal(server.remote.document.profiles[0].name, 'Second edit');
  assert.equal(second.store.data.profileSyncBackup.document.profiles[0].name, 'First edit');
});

test('resolution cannot overwrite a newer unseen cloud revision', async () => {
  const server = cloud();
  server.remote = { document: document('Remote'), revision: 'r1' };
  const local = device(server, document('Local').profiles);
  await login(local.sync);
  server.remote = { document: document('New remote'), revision: 'r2' };
  assert.equal((await local.sync.dispatch('resolve', { choice: 'local' })).status, 'conflict');
  assert.equal(server.remote.document.profiles[0].name, 'New remote');
  assert.deepEqual((await local.sync.dispatch('status')).conflict.remoteNames, ['New remote']);
});

test('atomic upload conflicts preserve local changes', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  await login(local.sync);
  await save(local, 'Changed');
  server.rejectNextPut = true;
  assert.equal((await local.sync.dispatch('sync')).status, 'conflict');
  assert.equal(local.store.data.profiles[0].name, 'Changed');
});

test('pending offline writes recover across service-worker restarts', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  await login(local.sync);
  await save(local, 'Offline edit');
  server.offline = true;
  await assert.rejects(local.sync.dispatch('sync'), /Cannot reach/);
  assert.equal((await local.sync.dispatch('status')).status, 'pending');
  server.offline = false;
  const restarted = createProfileSync({ storage: local.store, fetcher: server.fetcher });
  assert.equal((await restarted.dispatch('sync')).status, 'synced');
  assert.equal(server.remote.document.profiles[0].name, 'Offline edit');
});

test('stale popup saves are rejected instead of undoing remote updates', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  const old = JSON.stringify(local.store.data.profiles);
  await local.sync.dispatch('import', { document: document('Imported') });
  await assert.rejects(local.sync.dispatch('save', { profiles: document('Stale').profiles, expected: old }), /Reload/);
  assert.equal(local.store.data.profiles[0].name, 'Imported');
});

test('disconnect clears secrets and base even offline, keeping both saved copies', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  await login(local.sync);
  const publicState = await local.sync.dispatch('status');
  assert.ok(!JSON.stringify(publicState).includes('accessToken'));
  assert.ok(!JSON.stringify(publicState).includes('refreshToken'));
  server.offline = true;
  const state = await local.sync.dispatch('disconnect');
  assert.equal(state.connected, false);
  assert.equal(local.store.data.profileSync.session, undefined);
  assert.equal(local.store.data.profileSync.base, undefined);
  assert.equal(local.store.data.profiles[0].name, 'Original');
});

test('empty local list still propagates a saved deletion', async () => {
  const server = cloud();
  const first = device(server, document('Original').profiles);
  const second = device(server);
  await login(first.sync);
  await login(second.sync);
  await first.sync.dispatch('save', { profiles: [], expected: JSON.stringify(first.store.data.profiles) });
  await first.sync.dispatch('sync');
  await second.sync.dispatch('sync');
  assert.deepEqual(second.store.data.profiles, []);
});

test('schema rejects unrelated fields, duplicates, prototype keys and oversized data', () => {
  assert.throws(() => validateDocument({ ...document('Valid'), sessions: [] }));
  assert.throws(() => validateDocument({ schemaVersion: 1, profiles: [profile('One'), profile('Two')] }));
  const dangerous = document('Valid');
  dangerous.profiles[0].snapshot.configs = JSON.parse('{"__proto__":{}}');
  assert.throws(() => validateDocument(dangerous));
  const oversized = document('Valid');
  oversized.profiles[0].snapshot.configs.webflow.teams = Array(100).fill('x'.repeat(8192));
  assert.throws(() => validateDocument(oversized), /256 KiB/);
  assert.equal(MAX_DOCUMENT_BYTES, 256 * 1024);
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});

test('only HTTPS service origins and local HTTP are accepted', () => {
  assert.equal(serviceOrigin('https://sync.example'), 'https://sync.example');
  assert.equal(serviceOrigin('http://localhost:8787'), 'http://localhost:8787');
  for (const input of ['http://sync.example', 'https://user:pass@sync.example', 'https://sync.example/path', 'https://sync.example?token=secret', 'file:///tmp/test']) {
    assert.throws(() => serviceOrigin(input));
  }
});

test('save comparison tolerates key ordering from Chrome storage', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  const expected = JSON.stringify(local.store.data.profiles);
  local.store.data.profiles = JSON.parse(canonical(local.store.data.profiles));
  await local.sync.dispatch('save', { profiles: document('Renamed').profiles, expected });
  assert.equal(local.store.data.profiles[0].name, 'Renamed');
});

test('missing cloud object raises a conflict instead of clearing synchronized devices', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  await login(local.sync);
  server.remote = { document: { schemaVersion: 1, profiles: [] }, revision: null };
  assert.equal((await local.sync.dispatch('sync')).status, 'conflict');
  assert.equal(local.store.data.profiles[0].name, 'Original');
  await local.sync.dispatch('resolve', { choice: 'local' });
  assert.equal(server.remote.document.profiles[0].name, 'Original');
});

test('routine remote updates do not evict the last discarded conflict backup', async () => {
  const server = cloud();
  server.remote = { document: document('Cloud'), revision: 'existing' };
  const local = device(server, document('Discarded local').profiles);
  await login(local.sync);
  await local.sync.dispatch('resolve', { choice: 'remote' });
  server.remote = { document: document('Later remote update'), revision: 'new-revision' };
  await local.sync.dispatch('sync');
  assert.equal(local.store.data.profiles[0].name, 'Later remote update');
  assert.equal(local.store.data.profileSyncBackup.document.profiles[0].name, 'Discarded local');
});

test('native register and login send only normalized username/password after config, never persisting passwords', async () => {
  for (const action of ['register', 'login']) {
    const server = cloud();
    const local = device(server);
    await local.sync.dispatch(action, { endpoint: 'https://sync.example', username: ' TEST.User ', password, email: 'ignored@example.com' });
    assert.equal(server.calls[0].url, 'https://sync.example/config');
    assert.equal(server.calls[1].url, `https://sync.example/auth/${action}`);
    assert.deepEqual(JSON.parse(server.calls[1].body), { username: 'test.user', password });
    assert.deepEqual(server.calls[1].headers, { 'Content-Type': 'application/json' });
    assert.equal(server.calls[1].credentials, 'omit');
    assert.equal(local.store.data.profileSync.authType, 'password');
    assert.equal(local.store.data.profileSync.session.expiresAt, session.expiresAt);
    assert.ok(!JSON.stringify(local.store.data).includes(password));
    assert.ok(!JSON.stringify(await local.sync.dispatch('status')).includes('access'));
  }
});

test('legacy credentials and sync ancestry are cleared before any request, without losing local profiles or backup', async () => {
  const server = cloud();
  const backup = { document: document('Backup'), savedAt: 1 };
  const store = storage({ profiles: document('Local').profiles, profileSyncBackup: backup, profileSync: {
    endpoint: 'https://sync.example', authUrl: 'https://old.example', publicKey: 'old-key', email: 'old@example.com',
    session: { accessToken: 'legacy-access', refreshToken: 'legacy-refresh' },
    base: document('Old'), revision: 'old', conflict: { document: document('Old'), localNames: [] },
  } });
  const sync = createProfileSync({ storage: store, fetcher: server.fetcher });
  assert.equal((await sync.dispatch('sync')).connected, false);
  await sync.dispatch('disconnect');
  assert.equal(server.calls.length, 0);
  assert.deepEqual(store.data.profiles, document('Local').profiles);
  assert.deepEqual(store.data.profileSyncBackup, backup);
  assert.equal(store.data.profileSync.endpoint, 'https://sync.example');
  for (const key of ['authUrl', 'publicKey', 'email', 'session', 'base', 'revision', 'conflict']) {
    assert.equal(store.data.profileSync[key], undefined);
  }
  await login(sync);
  assert.equal(store.data.profiles[0].name, 'Local');
});

test('unsupported auth config blocks credentials from leaving the extension', async () => {
  const calls = [];
  const store = storage({ profiles: [] });
  const sync = createProfileSync({ storage: store, fetcher: async url => {
    calls.push(url);
    return Response.json({ auth: 'external', schemaVersion: 1 });
  } });
  await assert.rejects(login(sync), /does not support/);
  assert.deepEqual(calls, ['https://sync.example/config']);
  assert.ok(!JSON.stringify(store.data).includes(password));
});

test('invalid username and password boundaries fail before network access', async () => {
  const server = cloud();
  const local = device(server);
  for (const username of ['ab', '_abc', 'a@b', 'ñname', 'x'.repeat(65)]) {
    await assert.rejects(local.sync.dispatch('register', { endpoint: 'https://sync.example', username, password }), /username/);
  }
  for (const invalid of ['', 'x'.repeat(11), 'x'.repeat(129), null]) {
    await assert.rejects(local.sync.dispatch('login', { endpoint: 'https://sync.example', username: 'valid', password: invalid }), /password/);
  }
  assert.equal(server.calls.length, 0);
});

test('expired session requires new login without refresh or discarding pending profiles', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  await login(local.sync);
  await save(local, 'Pending edit');
  local.store.data.profileSync.session.expiresAt = 100000;
  server.calls.length = 0;
  await assert.rejects(local.sync.dispatch('sync'), /Session expired/);
  assert.equal(server.calls.length, 0);
  assert.equal((await local.sync.dispatch('status')).connected, false);
  assert.equal(local.store.data.profiles[0].name, 'Pending edit');
  await login(local.sync);
  assert.equal((await local.sync.dispatch('status')).status, 'conflict');
});

test('revoked session disconnects locally, preserves saved profiles, and never echoes server credentials', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  await login(local.sync);
  const sync = createProfileSync({ storage: local.store, fetcher: async () => Response.json({ error: password }, { status: 401 }) });
  await assert.rejects(sync.dispatch('sync'), /Session expired/);
  assert.equal((await sync.dispatch('status')).connected, false);
  assert.equal(local.store.data.profileSync.session, undefined);
  assert.equal(local.store.data.profiles[0].name, 'Original');
  assert.ok(!JSON.stringify(local.store.data).includes(password));
});

test('online disconnect revokes only its Bearer session at the native endpoint', async () => {
  const server = cloud();
  const local = device(server, document('Original').profiles);
  await login(local.sync);
  await local.sync.dispatch('disconnect');
  const logout = server.calls.at(-1);
  assert.equal(logout.url, 'https://sync.example/auth/logout');
  assert.equal(logout.method, 'POST');
  assert.deepEqual(logout.headers, { Authorization: 'Bearer access' });
  assert.equal(logout.credentials, 'omit');
  assert.equal(local.store.data.profileSync.session, undefined);
});

test('password whitespace and Unicode are sent exactly, with Python-compatible character boundaries', async () => {
  for (const exact of ['  password with spaces  ', '\u{1D11E}'.repeat(12), '\u{1D11E}'.repeat(128)]) {
    const server = cloud();
    const local = device(server);
    await local.sync.dispatch('register', { endpoint: 'https://sync.example', username: 'test.user', password: exact });
    assert.equal(JSON.parse(server.calls[1].body).password, exact);
    assert.ok(!JSON.stringify(local.store.data).includes(exact));
  }
  const server = cloud();
  const local = device(server);
  for (const invalid of ['\u{1D11E}'.repeat(11), '\u{1D11E}'.repeat(129)]) {
    await assert.rejects(local.sync.dispatch('login', { endpoint: 'https://sync.example', username: 'test.user', password: invalid }), /12–128/);
  }
  assert.equal(server.calls.length, 0);
});

test('1Password item matching resolves by explicit op:// ref, domain URL, or provider name', async () => {
  const {
    normalizeHostname,
    parseOpReference,
    matchOpItemForProvider,
    extractCredentialsFromOpItem,
  } = await import('../onepassword.mjs');

  assert.deepEqual(normalizeHostname('https://dashboard.stripe.com/settings/billing/history'), {
    host: 'dashboard.stripe.com',
    root: 'stripe.com',
  });
  assert.deepEqual(parseOpReference('op://AI/Stripe Billing/password'), {
    scheme: 'op',
    vault: 'AI',
    item: 'Stripe Billing',
    field: 'password',
  });

  const sampleItems = [
    {
      id: 'item-stripe-ai',
      title: 'Stripe Corporate',
      vault: { name: 'AI' },
      urls: [{ href: 'https://dashboard.stripe.com/login' }],
    },
    {
      id: 'item-anthropic',
      title: 'Anthropic Console',
      vault: { name: 'AI bots' },
      urls: [{ href: 'https://console.anthropic.com' }],
    },
    {
      id: 'item-custom',
      title: 'Custom Override Item',
      vault: { name: 'AI' },
      urls: [],
    },
  ];

  // Match by URL domain
  const matchedStripe = matchOpItemForProvider(sampleItems, {
    id: 'stripe',
    name: 'Stripe',
    billingUrl: 'https://dashboard.stripe.com/settings/billing/history',
  });
  assert.equal(matchedStripe?.id, 'item-stripe-ai');

  // Disambiguate multiple items with the same domain automatically via profileName or providerConfig
  const multiTeamItems = [
    {
      id: 'item-stripe-intelia',
      title: 'Stripe',
      additional_information: 'billing@intelia.io',
      vault: { name: 'AI' },
      urls: [{ href: 'https://dashboard.stripe.com/login' }],
    },
    {
      id: 'item-stripe-lana',
      title: 'Stripe',
      additional_information: 'billing@globex.example',
      vault: { name: 'AI bots' },
      urls: [{ href: 'https://dashboard.stripe.com/login' }],
    },
  ];
  const matchedForLanaProfile = matchOpItemForProvider(
    multiTeamItems,
    { id: 'stripe', name: 'Stripe', billingUrl: 'https://dashboard.stripe.com/settings/billing' },
    { profileName: 'Lana' }
  );
  assert.equal(matchedForLanaProfile?.id, 'item-stripe-lana');

  const matchedByConfigEmail = matchOpItemForProvider(
    multiTeamItems,
    { id: 'stripe', name: 'Stripe', billingUrl: 'https://dashboard.stripe.com/settings/billing' },
    { providerConfig: { authuser: 'billing@globex.example' } }
  );
  assert.equal(matchedByConfigEmail?.id, 'item-stripe-lana');

  // Match by explicit itemOverride
  const matchedOverride = matchOpItemForProvider(
    sampleItems,
    { id: 'stripe', name: 'Stripe', billingUrl: 'https://dashboard.stripe.com' },
    { itemOverride: 'op://AI/Custom Override Item' }
  );
  assert.equal(matchedOverride?.id, 'item-custom');

  // Extract credentials + OTP from op item get payload
  const creds = extractCredentialsFromOpItem({
    id: 'item-stripe-ai',
    title: 'Stripe Corporate',
    vault: { name: 'AI' },
    urls: [{ href: 'https://dashboard.stripe.com' }],
    fields: [
      { id: 'username', label: 'username', purpose: 'USERNAME', value: 'billing@intelia.com' },
      { id: 'password', label: 'password', purpose: 'PASSWORD', type: 'CONCEALED', value: 'super-secret-pass' },
      { id: 'one-time-password', label: 'one-time password', type: 'OTP', totp: '482910' },
    ],
  });
  assert.equal(creds.username, 'billing@intelia.com');
  assert.equal(creds.password, 'super-secret-pass');
  assert.equal(creds.otp, '482910');
  assert.equal(creds.vault, 'AI');
});

test('1Password Native Messaging host resolves provider and profile-sync credentials via op CLI without leaking tokens', async () => {
  const { handleHostRequest } = await import('../scripts/onepassword-host.mjs');
  const calls = [];
  const fakeTokens = {
    OP_SERVICE_ACCOUNT_TOKEN_INTELIA: 'ops_secret_intelia_token',
    OP_SERVICE_ACCOUNT_TOKEN_LANA: 'ops_secret_lana_token',
  };

  const fakeRunOp = async (args, token) => {
    calls.push({ args, token });
    if (args[0] === 'item' && args[1] === 'list') {
      const vault = args[3];
      if (vault === 'AI') {
        return JSON.stringify([
          {
            id: 'op-cr-1',
            title: 'CodeRabbit',
            vault: { name: 'AI' },
            urls: [{ href: 'https://app.coderabbit.ai' }],
          },
          {
            id: 'op-sync-1',
            title: 'Invoice Extractor Profile Sync',
            vault: { name: 'AI' },
            urls: [{ href: 'https://sync.intelia.example' }],
          },
        ]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'item' && args[1] === 'get' && args.includes('--otp')) {
      return '918273\n';
    }
    if (args[0] === 'item' && args[1] === 'get') {
      const id = args[2];
      if (id === 'op-cr-1') {
        return JSON.stringify({
          id: 'op-cr-1',
          title: 'CodeRabbit',
          vault: { name: 'AI' },
          urls: [{ href: 'https://app.coderabbit.ai' }],
          fields: [
            { purpose: 'USERNAME', value: 'admin@intelia.com' },
            { purpose: 'PASSWORD', value: 'cr-vault-password-123' },
            { type: 'OTP', label: 'one-time password' },
          ],
        });
      }
      if (id === 'op-sync-1') {
        return JSON.stringify({
          id: 'op-sync-1',
          title: 'Invoice Extractor Profile Sync',
          vault: { name: 'AI' },
          urls: [{ href: 'https://sync.intelia.example' }],
          fields: [
            { purpose: 'USERNAME', value: 'demo.sync' },
            { purpose: 'PASSWORD', value: 'sync-vault-password-12345' },
          ],
        });
      }
    }
    throw new Error(`Unexpected op call: ${args.join(' ')}`);
  };

  const status = await handleHostRequest({ action: 'status' }, { tokens: fakeTokens, runOp: fakeRunOp });
  assert.equal(status.available, true);
  assert.equal(JSON.stringify(status).includes('ops_secret'), false);

  const crCreds = await handleHostRequest(
    {
      action: 'resolveProvider',
      provider: { id: 'coderabbit', name: 'CodeRabbit', billingUrl: 'https://app.coderabbit.ai/settings/billing' },
    },
    { tokens: fakeTokens, runOp: fakeRunOp }
  );
  assert.equal(crCreds.username, 'admin@intelia.com');
  assert.equal(crCreds.password, 'cr-vault-password-123');
  assert.equal(crCreds.otp, '918273');

  const syncCreds = await handleHostRequest(
    { action: 'resolveProfileSync', endpoint: 'https://sync.intelia.example' },
    { tokens: fakeTokens, runOp: fakeRunOp }
  );
  assert.equal(syncCreds.username, 'demo.sync');
  assert.equal(syncCreds.password, 'sync-vault-password-12345');
  assert.equal(syncCreds.endpoint, 'https://sync.intelia.example');
});

test('discoverProfilesFromOpItems groups 1Password items by client tags and maps active providers by domain', async () => {
  const { discoverProfilesFromOpItems } = await import('../onepassword.mjs');

  const providers = [
    { id: 'stripe', name: 'Stripe', billingUrl: 'https://dashboard.stripe.com/settings/billing' },
    { id: 'hetzner', name: 'Hetzner', billingUrl: 'https://accounts.hetzner.com/invoice' },
    {
      id: 'google-workspace',
      name: 'Google Workspace',
      billingUrl: 'https://admin.google.com/ac/billing',
      config: { authuser: { label: 'Google Account Email' } },
    },
  ];

  const items = [
    {
      id: 'op-1',
      title: 'Stripe Initech',
      vault: { name: 'AI' },
      tags: ['initech', 'billing'],
      urls: [{ href: 'https://dashboard.stripe.com/login' }],
    },
    {
      id: 'op-2',
      title: 'Hetzner Cloud',
      vault: { name: 'AI' },
      tags: ['initech'],
      urls: [{ href: 'https://accounts.hetzner.com/login' }],
    },
    {
      id: 'op-3',
      title: 'Google Admin Umbrella Foods',
      vault: { name: 'AI' },
      tags: ['umbrella-foods'],
      additional_information: 'admin@umbrella.example',
      urls: [{ href: 'https://admin.google.com' }],
    },
  ];

  const discovered = discoverProfilesFromOpItems(items, providers);
  assert.equal(discovered.length, 2);

  const astro = discovered.find(d => d.id === 'initech');
  assert.ok(astro);
  assert.equal(astro.name, 'Initech');
  assert.deepEqual(astro.activeProviders, ['stripe', 'hetzner']);
  assert.equal(astro.configs.stripe._onepasswordItem, 'op://AI/op-1');
  assert.equal(astro.configs.hetzner._onepasswordItem, 'op://AI/op-2');

  const umbrella = discovered.find(d => d.id === 'umbrella-foods');
  assert.ok(umbrella);
  assert.equal(umbrella.name, 'Umbrella Foods');
  assert.deepEqual(umbrella.activeProviders, ['google-workspace']);
  assert.equal(umbrella.configs['google-workspace']._onepasswordItem, 'op://AI/op-3');
  assert.equal(umbrella.configs['google-workspace'].authuser, 'admin@umbrella.example');
});

test('extractConfigFromUrls extracts URL parameters from 1Password item URLs and agent CLI persists shared state and upserts 1Password items', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { extractConfigFromUrls } = await import('../onepassword.mjs');
  const { handleHostRequest, readLocalState } = await import('../scripts/onepassword-host.mjs');
  const { setProfileOrProviderConfig } = await import('../bin/invoice-extractor.mjs');

  const stripeProvider = {
    id: 'stripe',
    name: 'Stripe',
    billingUrl: 'https://dashboard.stripe.com/{{config.accountId}}/settings/plans-and-fees/invoice-history',
    config: { accountId: { title: 'Account ID' } },
  };
  const ghProvider = {
    id: 'github',
    name: 'GitHub',
    billingUrl: 'https://github.com/organizations/{{config.org}}/billing/history',
    config: { org: { title: 'Org', multi: true } },
  };

  assert.deepEqual(
    extractConfigFromUrls(['https://dashboard.stripe.com/acct_1N9ABC/settings/billing'], stripeProvider),
    { accountId: 'acct_1N9ABC' }
  );
  assert.deepEqual(
    extractConfigFromUrls(['https://dashboard.stripe.com/settings/billing'], stripeProvider),
    {}
  );
  assert.deepEqual(
    extractConfigFromUrls(['https://github.com/organizations/acme/billing/history'], ghProvider),
    { org: ['acme'] }
  );

  // Shared local state persistence
  const tmpDir = mkdtempSync(join(tmpdir(), 'ie-agent-state-'));
  const statePath = join(tmpDir, 'state.json');
  try {
    const res = setProfileOrProviderConfig(
      {
        profileName: 'Acme',
        providerId: 'stripe',
        key: 'accountId',
        value: 'acct_ACME99',
        opItem: 'op://AI/stripe-acme',
      },
      { statePath }
    );
    assert.equal(res.updatedProfile, 'Acme');
    assert.equal(res.config.accountId, 'acct_ACME99');

    const loaded = readLocalState({ statePath });
    assert.equal(loaded.profiles.length, 1);
    assert.equal(loaded.profiles[0].id, 'acme');
    assert.equal(loaded.profiles[0].configs.stripe.accountId, 'acct_ACME99');

    // Test upsertOpItem via handleHostRequest (create + edit)
    const calls = [];
    const fakeRunOp = async (args) => {
      calls.push(args);
      if (args.includes('list')) return JSON.stringify([]);
      if (args.includes('create')) {
        return JSON.stringify({ id: 'new-op-id', title: 'Notion Lana', tags: ['Lana'] });
      }
      return '{}';
    };

    const upsertRes = await handleHostRequest(
      {
        action: 'upsertOpItem',
        vaultHint: 'lana',
        title: 'Notion Lana',
        url: 'https://www.notion.so/billing',
        username: 'billing@lana.xyz',
        password: 'super-secret-password',
        tags: ['Lana'],
      },
      {
        statePath,
        tokens: { OP_SERVICE_ACCOUNT_TOKEN_LANA: 'ops_fake_lana' },
        runOp: fakeRunOp,
      }
    );
    assert.equal(upsertRes.created, true);
    assert.equal(upsertRes.vault, 'AI bots');
    assert.equal(upsertRes.itemRef, 'op://AI bots/new-op-id');
    assert.ok(calls.some(a => a.includes('create') && a.includes('--vault') && a.includes('AI bots')));

    // Test standard user vaults (Personal / Shared / Employee) in desktop-biometrics mode + Claude Desktop MCP config
    const { writeLocalState, resolveVaultConfigs } = await import('../scripts/onepassword-host.mjs');
    const { registerClaudeDesktopMcp } = await import('../bin/invoice-extractor.mjs');
    const { readFileSync } = await import('node:fs');

    writeLocalState(
      {
        vaults: [
          { alias: 'personal', vault: 'Personal', desktopBiometrics: true },
          { alias: 'shared', vault: 'Shared', desktopBiometrics: true },
        ],
        authMode: 'desktop-biometrics',
      },
      { merge: true },
      { statePath }
    );
    const updatedState = readLocalState({ statePath });
    const desktopConfigs = resolveVaultConfigs({}, 'shared', updatedState.vaults);
    assert.equal(desktopConfigs[0].vault, 'Shared');
    assert.equal(desktopConfigs[0].desktopBiometrics, true);

    const claudeCfgPath = join(tmpDir, 'claude_desktop_config.json');
    registerClaudeDesktopMcp({ configPath: claudeCfgPath });
    const parsedClaudeCfg = JSON.parse(readFileSync(claudeCfgPath, 'utf8'));
    assert.ok(parsedClaudeCfg.mcpServers['invoice-extractor']);
    assert.ok(parsedClaudeCfg.mcpServers['invoice-extractor'].args[0].endsWith('invoice-extractor-mcp.mjs'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Bitwarden (bw CLI) support: normalizes items, discovers client profiles from folders/tags, resolves live TOTP, and upserts items', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { normalizeBitwardenItem, parseOpReference } = await import('../onepassword.mjs');
  const { handleHostRequest } = await import('../scripts/onepassword-host.mjs');

  assert.deepEqual(parseOpReference('bw://Acme/bw-stripe-1'), {
    scheme: 'bw',
    vault: 'Acme',
    item: 'bw-stripe-1',
    field: null,
  });

  const sampleBwItems = [
    {
      id: 'bw-stripe-1',
      type: 1,
      folderId: 'folder-acme',
      name: 'Stripe Acme',
      notes: 'Account for Acme #Acme',
      login: {
        username: 'billing@acme.example',
        password: 'bw-stripe-password',
        totp: 'JBSWY3DPEHPK3PXP',
        uris: [{ uri: 'https://dashboard.stripe.com/acct_BW123/settings/billing' }],
      },
      fields: [],
    },
    {
      id: 'bw-holded-2',
      type: 1,
      folderId: null,
      name: 'Holded Initech',
      notes: '',
      login: {
        username: 'admin@initech.example',
        password: 'bw-holded-password',
        totp: null,
        uris: [{ uri: 'https://app.holded.com/login' }],
      },
      fields: [{ name: 'profile', value: 'Initech', type: 0 }],
    },
  ];

  const normalized = normalizeBitwardenItem(sampleBwItems[0], { 'folder-acme': 'Acme' });
  assert.equal(normalized._source, 'bitwarden');
  assert.equal(normalized.vault.name, 'Acme');
  assert.ok(normalized.tags.includes('Acme'));

  const tmpDir = mkdtempSync(join(tmpdir(), 'ie-bw-state-'));
  const statePath = join(tmpDir, 'state.json');
  const bwCalls = [];

  const fakeRunBw = async (args) => {
    bwCalls.push(args);
    if (args[0] === 'list' && args[1] === 'folders') {
      return JSON.stringify([{ id: 'folder-acme', name: 'Acme' }]);
    }
    if (args[0] === 'list' && args[1] === 'items') {
      return JSON.stringify(sampleBwItems);
    }
    if (args[0] === 'get' && args[1] === 'totp' && args[2] === 'bw-stripe-1') {
      return '654321\n';
    }
    if (args[0] === 'create' && args[1] === 'item') {
      const decoded = JSON.parse(Buffer.from(args[2], 'base64').toString('utf8'));
      return JSON.stringify({ id: 'bw-created-99', name: decoded.name });
    }
    return '{}';
  };

  try {
    const discovered = await handleHostRequest(
      {
        action: 'discoverProfiles',
        providers: [
          {
            id: 'stripe',
            name: 'Stripe',
            billingUrl: 'https://dashboard.stripe.com/{{config.accountId}}/settings/plans-and-fees/invoice-history',
            config: { accountId: { title: 'Account ID' } },
          },
          {
            id: 'holded',
            name: 'Holded',
            billingUrl: 'https://app.holded.com/billing',
          },
        ],
      },
      {
        statePath,
        tokens: { BW_SESSION: 'bw_fake_session_token' },
        runBw: fakeRunBw,
      }
    );

    assert.equal(discovered.profiles.length, 2);
    const acme = discovered.profiles.find(p => p.name === 'Acme');
    assert.ok(acme);
    assert.equal(acme.configs.stripe._onepasswordItem, 'bw://Acme/bw-stripe-1');
    assert.equal(acme.configs.stripe.accountId, 'acct_BW123');

    const initech = discovered.profiles.find(p => p.name === 'Initech');
    assert.ok(initech);
    assert.equal(initech.configs.holded._onepasswordItem, 'bw://Bitwarden/bw-holded-2');

    // Resolve credentials + live TOTP from Bitwarden
    const resolvedCreds = await handleHostRequest(
      {
        action: 'resolveProvider',
        provider: {
          id: 'stripe',
          name: 'Stripe',
          billingUrl: 'https://dashboard.stripe.com/settings/billing',
        },
        profileName: 'Acme',
      },
      {
        statePath,
        tokens: { BW_SESSION: 'bw_fake_session_token' },
        runBw: fakeRunBw,
      }
    );
    assert.equal(resolvedCreds.username, 'billing@acme.example');
    assert.equal(resolvedCreds.password, 'bw-stripe-password');
    assert.equal(resolvedCreds.otp, '654321');

    // Upsert item in Bitwarden
    const upsertedBw = await handleHostRequest(
      {
        action: 'upsertOpItem',
        manager: 'bitwarden',
        title: 'OpenAI Acme',
        url: 'https://platform.openai.com/settings/organization/billing/history',
        username: 'ai@acme.example',
        password: 'openai-bw-password',
        tags: ['Acme'],
      },
      {
        statePath,
        tokens: { BW_SESSION: 'bw_fake_session_token' },
        runBw: fakeRunBw,
      }
    );
    assert.equal(upsertedBw.created, true);
    assert.equal(upsertedBw.vault, 'Bitwarden');
    assert.equal(upsertedBw.itemRef, 'bw://Bitwarden/bw-created-99');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});



