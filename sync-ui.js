// Messages produced in English by the sync service worker (profile-sync.mjs, sync-schema.mjs).
const SYNC_TEXT_KEYS = {
  'Both copies differ. Export a backup or choose which saved profiles to keep. Live settings are not replaced.': 'syncMsgConflict',
  'Saved profiles are synchronized. Load a profile to apply its settings on this device.': 'syncMsgSynced',
  'Checking saved profiles…': 'syncMsgChecking',
  'Changes saved on this device. Waiting to synchronize.': 'syncMsgPending',
  'Disconnected. Local and remote profiles were not deleted.': 'syncMsgDisconnected',
  'Enter an HTTPS service origin, without a path (localhost HTTP is allowed for development).': 'syncErrOrigin',
  'Cannot reach the sync or login service. Saved profiles remain on this device; retry when online.': 'syncErrUnreachable',
  'The service returned an invalid response.': 'syncErrInvalidResponse',
  'Invalid login session. Sign in again.': 'syncErrSession',
  'Invalid remote revision.': 'syncErrRevision',
  'No replacement backup is available on this device.': 'syncErrNoBackup',
  'Profiles changed while this window was open. Reload them before saving again.': 'syncErrStale',
  'Disconnect before connecting a different account or service.': 'syncErrDisconnectFirst',
  'Use a username of 3–64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit.': 'syncErrUsername',
  'Use a password of 12–128 characters.': 'syncErrPassword',
  'This service does not support own-account password login.': 'syncErrNoPasswordLogin',
  'There is no conflict to resolve.': 'syncErrNoConflict',
  'Choose this device or the cloud copy.': 'syncErrChoose',
  'Unknown sync action.': 'syncErrUnknownAction',
  'Invalid profile document.': 'syncErrDocument',
  'Invalid or duplicate profile.': 'syncErrProfile',
  'Invalid profile settings.': 'syncErrSettings',
  'Invalid provider configuration.': 'syncErrProviderConfig',
  'Invalid configuration value.': 'syncErrConfigValue',
  'Profile document exceeds 256 KiB.': 'syncErrDocumentSize',
};
const SYNC_STATE_KEYS = {
  disconnected: 'syncStateDisconnected', synced: 'syncStateSynced', syncing: 'syncStateSyncing',
  pending: 'syncStatePending', conflict: 'syncStateConflict',
};

function localizeSyncText(text) {
  const key = SYNC_TEXT_KEYS[text];
  return key ? t(key) : text;
}

async function syncRequest(action, input = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'profile-sync', action, input });
  if (!response?.ok) throw new Error(response?.error || t('syncErrorWorker'));
  return response.data;
}

async function opRequest(action, input = {}) {
  if (typeof chrome.runtime?.sendNativeMessage === 'function') {
    const res = await chrome.runtime.sendNativeMessage(
      'com.intelia.invoice_extractor.op',
      { action, ...input }
    );
    if (!res?.ok) throw new Error(res?.error || t('opUnavailable'));
    return res.data;
  }
  const response = await chrome.runtime.sendMessage({ type: 'onepassword', action, input });
  if (!response?.ok) throw new Error(response?.error || t('opUnavailableReload'));
  return response.data;
}

function setupProfileSyncUi(onProfilesChanged) {
  const element = id => document.getElementById(id);
  let busy = false;
  let refreshQueue = Promise.resolve();

  function show(state) {
    element('sync-status').textContent = state.message ? localizeSyncText(state.message) : t('syncNotConnected');
    element('sync-login').hidden = state.connected;
    element('sync-connected').hidden = !state.connected;
    element('sync-conflict').hidden = !state.conflict;
    if (state.endpoint && document.activeElement !== element('sync-endpoint')) element('sync-endpoint').value = state.endpoint;
    if (state.username && document.activeElement !== element('sync-username')) element('sync-username').value = state.username;
    element('sync-account').textContent = `${state.username} · ${state.endpoint}${state.lastSynced ? ` · ${t('syncLastSync', [new Date(state.lastSynced).toLocaleString(uiLanguage())])}` : ''}`;
    const syncState = state.connected ? (SYNC_STATE_KEYS[state.status] ? t(SYNC_STATE_KEYS[state.status]) : state.status) : t('syncStateLocalOnly');
    element('btn-open-sync').textContent = t('syncHomeButton', [syncState]);
    if (state.conflict) {
      element('sync-conflict-summary').textContent = t('syncConflictSummary', [
        state.conflict.localNames.join(', ') || t('syncConflictEmpty'),
        state.conflict.remoteNames.join(', ') || t('syncConflictEmpty'),
      ]);
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
    catch (error) { element('sync-status').textContent = localizeSyncText(error.message); }
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
    element('sync-status').textContent = t('syncOpFetching');
    const currentEndpoint = element('sync-endpoint').value.trim();
    const creds = await opRequest('resolveProfileSync', { endpoint: currentEndpoint });
    const endpoint = currentEndpoint || creds.endpoint || '';
    const username = element('sync-username').value.trim() || creds.username || '';
    if (!endpoint) throw new Error(t('syncOpNeedEndpoint'));
    if (!username || !creds.password) throw new Error(t('syncOpMissingCreds', [creds.title]));
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
      if (!confirm(t(choice === 'local' ? 'syncConfirmKeepLocal' : 'syncConfirmUseRemote'))) return;
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
    if (file.size > 256 * 1024) throw new Error(t('syncImportTooLarge'));
    const document = JSON.parse(await file.text());
    if (!confirm(t('syncConfirmImport'))) return;
    await syncRequest('import', { document });
    await onProfilesChanged();
    await refresh();
  }));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.profileSync && !changes.profiles)) return;
    refreshQueue = refreshQueue.then(async () => {
      if (changes.profiles) await onProfilesChanged();
      await refresh();
    }).catch(error => { element('sync-status').textContent = localizeSyncText(error.message); });
  });
  window.addEventListener('online', () => run(async () => show(await syncRequest('sync'))));
  refresh().catch(error => { element('sync-status').textContent = localizeSyncText(error.message); });
  // Also checks remote changes whenever the interface is opened.
  run(async () => { show(await syncRequest('sync')); await onProfilesChanged(); });
}
