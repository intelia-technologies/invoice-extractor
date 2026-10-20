async function syncRequest(action, input = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'profile-sync', action, input });
  if (!response?.ok) throw new Error(response?.error || 'The sync service worker is unavailable. Reload the extension.');
  return response.data;
}

async function opRequest(action, input = {}) {
  if (typeof chrome.runtime?.sendNativeMessage === 'function') {
    const res = await chrome.runtime.sendNativeMessage(
      'com.intelia.invoice_extractor.op',
      { action, ...input }
    );
    if (!res?.ok) throw new Error(res?.error || '1Password integration is unavailable.');
    return res.data;
  }
  const response = await chrome.runtime.sendMessage({ type: 'onepassword', action, input });
  if (!response?.ok) throw new Error(response?.error || '1Password integration is unavailable. Reload the extension in chrome://extensions.');
  return response.data;
}

function setupProfileSyncUi(onProfilesChanged) {
  const element = id => document.getElementById(id);
  let busy = false;
  let refreshQueue = Promise.resolve();

  function show(state) {
    element('sync-status').textContent = state.message || 'Not connected. Profiles are stored only on this device.';
    element('sync-login').hidden = state.connected;
    element('sync-connected').hidden = !state.connected;
    element('sync-conflict').hidden = !state.conflict;
    if (state.endpoint && document.activeElement !== element('sync-endpoint')) element('sync-endpoint').value = state.endpoint;
    if (state.username && document.activeElement !== element('sync-username')) element('sync-username').value = state.username;
    element('sync-account').textContent = `${state.username} · ${state.endpoint}${state.lastSynced ? ` · Last sync: ${new Date(state.lastSynced).toLocaleString()}` : ''}`;
    element('btn-open-sync').textContent = `Sync: ${state.connected ? state.status : 'local only'}`;
    if (state.conflict) {
      element('sync-conflict-summary').textContent = `This device: ${state.conflict.localNames.join(', ') || '(empty)'}. Cloud: ${state.conflict.remoteNames.join(', ') || '(empty)'}.`;
    }
  }
  async function refresh() {
    show(await syncRequest('status'));
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('.sync-panel button').forEach(button => { button.disabled = true; });
    try { await operation(); }
    catch (error) { element('sync-status').textContent = error.message; }
    finally {
      busy = false;
      document.querySelectorAll('.sync-panel button').forEach(button => { button.disabled = false; });
    }
  }
  const bind = (id, operation) => element(id)?.addEventListener('click', () => run(operation));
  for (const action of ['register', 'login']) {
    bind(`btn-sync-${action}`, async () => {
      const password = element('sync-password').value;
      // Clear immediately: no password remains in the UI during or after the request.
      element('sync-password').value = '';
      try {
        show(await syncRequest(action, {
          endpoint: element('sync-endpoint').value.trim(),
          username: element('sync-username').value.trim(), password,
        }));
        await onProfilesChanged();
      } finally {
        element('sync-password').value = '';
      }
    });
  }
  bind('btn-sync-1password', async () => {
    element('sync-status').textContent = 'Fetching credentials from 1Password...';
    const currentEndpoint = element('sync-endpoint').value.trim();
    const creds = await opRequest('resolveProfileSync', { endpoint: currentEndpoint });
    const endpoint = currentEndpoint || creds.endpoint || '';
    const username = element('sync-username').value.trim() || creds.username || '';
    if (!endpoint) throw new Error('Enter the Sync service URL (or add a URL field to the 1Password item).');
    if (!username || !creds.password) throw new Error(`1Password item "${creds.title}" is missing username or password.`);
    element('sync-endpoint').value = endpoint;
    element('sync-username').value = username;
    element('sync-password').value = '';
    show(await syncRequest('login', { endpoint, username, password: creds.password }));
    await onProfilesChanged();
  });
  bind('btn-sync-now', async () => { show(await syncRequest('sync')); await onProfilesChanged(); });
  bind('btn-sync-disconnect', async () => show(await syncRequest('disconnect')));
  for (const choice of ['local', 'remote']) {
    bind(`btn-sync-${choice}`, async () => {
      if (!confirm(choice === 'local'
        ? 'Replace the cloud saved profile list with this device’s list? Other devices will receive this change.'
        : 'Replace this device’s saved profile list with the cloud list? Live settings stay unchanged.')) return;
      show(await syncRequest('resolve', { choice }));
      await onProfilesChanged();
    });
  }
  async function exportProfiles(action, name) {
    const document = await syncRequest(action);
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  bind('btn-profiles-export', () => exportProfiles('export', 'invoice-extractor-profiles.json'));
  bind('btn-profiles-backup', () => exportProfiles('backup', 'invoice-extractor-profiles-backup.json'));
  bind('btn-profiles-import', async () => element('profiles-import-file').click());
  element('profiles-import-file').addEventListener('change', () => run(async () => {
    const input = element('profiles-import-file');
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > 256 * 1024) throw new Error('Profile file exceeds 256 KiB.');
    const document = JSON.parse(await file.text());
    if (!confirm('Replace your saved profile list with this file? If connected, this change will synchronize. Live settings stay unchanged.')) return;
    await syncRequest('import', { document });
    await onProfilesChanged();
    await refresh();
  }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.profileSync && !changes.profiles)) return;
    refreshQueue = refreshQueue.then(async () => {
      if (changes.profiles) await onProfilesChanged();
      await refresh();
    }).catch(error => { element('sync-status').textContent = error.message; });
  });
  window.addEventListener('online', () => run(async () => show(await syncRequest('sync'))));
  refresh().catch(error => { element('sync-status').textContent = error.message; });
  // Also checks remote changes whenever the interface is opened.
  run(async () => { show(await syncRequest('sync')); await onProfilesChanged(); });
}
