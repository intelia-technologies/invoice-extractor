import { validateDocument, canonical } from './sync-schema.mjs';

export const SYNC_KEY = 'profileSync';
export const SYNC_ALARM = 'profile-sync';

export function serviceOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter an HTTPS service origin, without a path (localhost HTTP is allowed for development).');
  }
  return url.origin;
}

export function createProfileSync({ storage, fetcher = fetch, now = Date.now }) {
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const readState = async () => {
    const stored = (await storage.get(SYNC_KEY))[SYNC_KEY] || {};
    if (stored.authType === 'password') return stored;
    // Never send credentials or retain a sync base from the obsolete auth provider.
    const state = { authType: 'password', endpoint: stored.endpoint || '', status: 'disconnected' };
    await storage.set({ [SYNC_KEY]: state });
    return state;
  };
  const writeState = state => storage.set({ [SYNC_KEY]: state });
  const localDocument = async () => validateDocument({ schemaVersion: 1, profiles: (await storage.get('profiles')).profiles || [] });
  const same = (a, b) => canonical(a) === canonical(b);
  const view = state => ({
    endpoint: state.endpoint || '', username: state.username || '', connected: !!state.session,
    status: state.status || 'disconnected',
    message: state.message || '', lastSynced: state.lastSynced || null,
    conflict: state.conflict ? {
      remoteNames: state.conflict.document.profiles.map(p => p.name),
      localNames: state.conflict.localNames,
    } : null,
  });

  async function request(url, options = {}) {
    let response;
    try {
      response = await fetcher(url, { ...options, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch {
      throw new Error('Cannot reach the sync or login service. Saved profiles remain on this device; retry when online.');
    }
    let body;
    try { body = await response.json(); } catch { throw new Error('The service returned an invalid response.'); }
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403
        ? 'Session expired or access denied. Disconnect and sign in again.'
        : response.status === 409 ? 'The account is unavailable or profiles changed on another device.'
        : response.status === 429 ? 'Too many requests. Wait before trying again.'
        : response.status >= 500 ? 'Service temporarily unavailable. Your changes are saved locally.'
        : 'The service rejected the request. Check your input or service configuration.');
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function sessionFrom(data) {
    if (typeof data.accessToken !== 'string' || !data.accessToken ||
        typeof data.user?.id !== 'string' || !data.user.id ||
        typeof data.user.username !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(data.user.username) ||
        !Number.isFinite(data.expiresAt) || data.expiresAt <= now()) {
      throw new Error('Invalid login session. Sign in again.');
    }
    return { accessToken: data.accessToken, expiresAt: data.expiresAt, userId: data.user.id };
  }
  function token(state) {
    if (!state.session || state.session.expiresAt <= now()) {
      const error = new Error('Session expired. Sign in again; your saved profiles remain on this device.');
      error.status = 401;
      throw error;
    }
    return state.session.accessToken;
  }
  async function api(state, method, body) {
    const accessToken = token(state);
    return request(`${state.endpoint}/profiles`, {
      method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  function remoteDocument(remote) {
    validateDocument(remote.document);
    if (!(remote.revision === null || (typeof remote.revision === 'string' && remote.revision.length > 0))) {
      throw new Error('Invalid remote revision.');
    }
    return remote;
  }
  async function conflict(state, local, remote) {
    state.conflict = { ...remote, localNames: local.profiles.map(p => p.name) };
    state.status = 'conflict';
    state.message = 'Both copies differ. Export a backup or choose which saved profiles to keep. Live settings are not replaced.';
    await writeState(state);
    return view(state);
  }
  async function accept(state, document, revision, replaceLocal = false) {
    if (replaceLocal) {
      const current = await localDocument();
      const backup = state.conflict || !state.base || !same(current, state.base)
        ? { profileSyncBackup: { document: current, savedAt: now() } } : {};
      await storage.set({ ...backup, profiles: document.profiles });
    }
    state.base = document;
    state.revision = revision;
    delete state.conflict;
    state.status = 'synced';
    state.message = 'Saved profiles are synchronized. Load a profile to apply its settings on this device.';
    state.lastSynced = now();
    await writeState(state);
    return view(state);
  }
  async function upload(state, local, revision) {
    try {
      const result = await api(state, 'PUT', { document: local, revision });
      if (typeof result.revision !== 'string' || !result.revision) throw new Error('Invalid remote revision.');
      return await accept(state, local, result.revision);
    } catch (error) {
      if (error.status !== 409) throw error;
      return conflict(state, local, remoteDocument(await api(state, 'GET')));
    }
  }
  async function synchronize(state) {
    if (!state.session || state.conflict) return view(state);
    state.status = 'syncing';
    state.message = 'Checking saved profiles…';
    await writeState(state);
    const local = await localDocument();
    const remote = remoteDocument(await api(state, 'GET'));
    // A missing object is storage loss, not a profile deletion (deletions store an empty document).
    if (state.base && remote.revision === null && local.profiles.length) {
      return conflict(state, local, remote);
    }
    if (same(local, remote.document)) return accept(state, local, remote.revision);
    if (!state.base) {
      if (local.profiles.length === 0) return accept(state, remote.document, remote.revision, true);
      if (remote.revision === null) return upload(state, local, null);
      return conflict(state, local, remote);
    }
    const localChanged = !same(local, state.base);
    const remoteChanged = !same(remote.document, state.base);
    if (localChanged && remoteChanged) return conflict(state, local, remote);
    if (localChanged) return upload(state, local, remote.revision);
    return accept(state, remote.document, remote.revision, true);
  }

  async function markPending(state, document) {
    if (!state.session) return;
    if (state.conflict) state.conflict.localNames = document.profiles.map(p => p.name);
    else {
      state.status = 'pending';
      state.message = 'Changes saved on this device. Waiting to synchronize.';
    }
    await writeState(state);
  }

  async function execute(action, input = {}) {
    let state = await readState();
    try {
      switch (action) {
        case 'status': return view(state);
        case 'export': return localDocument();
        case 'backup': {
          const backup = (await storage.get('profileSyncBackup')).profileSyncBackup;
          if (!backup) throw new Error('No replacement backup is available on this device.');
          return validateDocument(backup.document);
        }
        case 'save': {
          const document = validateDocument({ schemaVersion: 1, profiles: input.profiles });
          const current = await localDocument();
          const expected = validateDocument({ schemaVersion: 1, profiles: JSON.parse(input.expected) });
          if (!same(expected, current)) {
            throw new Error('Profiles changed while this window was open. Reload them before saving again.');
          }
          await storage.set({ profiles: document.profiles, loadedProfileId: input.loadedProfileId || null });
          await markPending(state, document);
          return view(state);
        }
        case 'import': {
          const document = validateDocument(input.document);
          await storage.set({ profileSyncBackup: { document: await localDocument(), savedAt: now() }, profiles: document.profiles });
          await markPending(state, document);
          return view(state);
        }
        case 'register':
        case 'login': {
          if (state.session) throw new Error('Disconnect before connecting a different account or service.');
          const endpoint = serviceOrigin(input.endpoint);
          const username = String(input.username || '').trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) {
            throw new Error('Use a username of 3–64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit.');
          }
          if (typeof input.password !== 'string' || Array.from(input.password).length < 12 || Array.from(input.password).length > 128) {
            throw new Error('Use a password of 12–128 characters.');
          }
          const config = await request(`${endpoint}/config`);
          if (config.auth !== 'password' || config.schemaVersion !== 1) {
            throw new Error('This service does not support own-account password login.');
          }
          const data = await request(`${endpoint}/auth/${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: input.password }),
          });
          state = { authType: 'password', endpoint, username: data.user?.username,
            session: sessionFrom(data), base: null, revision: null };
          await writeState(state);
          return await synchronize(state);
        }
        case 'disconnect': {
          // Local sign-out always succeeds, including offline; revoke just this session when reachable.
          if (state.session) {
            try {
              await fetcher(`${state.endpoint}/auth/logout`, {
                method: 'POST', headers: { Authorization: `Bearer ${state.session.accessToken}` },
                credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(3000),
              });
            } catch { /* Offline revocation is impossible; clear all local tokens regardless. */ }
          }
          state = { authType: 'password', endpoint: state.endpoint, status: 'disconnected', message: 'Disconnected. Local and remote profiles were not deleted.' };
          await writeState(state);
          return view(state);
        }
        case 'sync': return await synchronize(state);
        case 'resolve': {
          if (!state.session || !state.conflict) throw new Error('There is no conflict to resolve.');
          const remote = remoteDocument(await api(state, 'GET'));
          const local = await localDocument();
          if (remote.revision !== state.conflict.revision) return conflict(state, local, remote);
          if (input.choice === 'remote') return accept(state, remote.document, remote.revision, true);
          if (input.choice !== 'local') throw new Error('Choose this device or the cloud copy.');
          await storage.set({ profileSyncBackup: { document: remote.document, savedAt: now() } });
          return upload(state, local, remote.revision);
        }
        default: throw new Error('Unknown sync action.');
      }
    } catch (error) {
      // Never lose a pending local edit on network, auth or validation failures.
      state = await readState();
      if (error.status === 401) {
        state = { authType: 'password', endpoint: state.endpoint, username: state.username, status: 'disconnected' };
      }
      state.status = state.conflict ? 'conflict' : state.session ? 'pending' : state.status || 'disconnected';
      state.message = error.message;
      await writeState(state);
      throw error;
    }
  }
  return { dispatch: (action, input) => serial(() => execute(action, input)) };
}
