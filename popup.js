// =====================================================
// PROFILES — saved presets of (activeProviders + configs)
// =====================================================
// Profiles are snapshots you explicitly load/save.
// Live state uses plain storage keys — profiles don't namespace anything.
let profiles = [];       // [{ id, name, snapshot: { activeProviders, configs } }]
let loadedProfileId = null; // Which profile was last loaded (display only)
let profileStorageSnapshot = '[]';

async function loadProfiles() {
  const result = await chrome.storage.local.get('profiles');
  profiles = [];
  if (result.profiles) {
    // Handle migration from old namespace-based format
    if (result.profiles.active !== undefined && !result.profiles[0]?.snapshot) {
      // Old format: { active, list: [{ id, name }] } — convert to new format
      profiles = (result.profiles.list || []).map(p => ({ ...p, snapshot: null }));
      loadedProfileId = result.profiles.active;
      // Migrate namespaced data back to plain keys
      await migrateFromNamespacedProfiles(result.profiles);
    } else {
      profiles = result.profiles;
      // Restore loadedProfileId from storage
      const meta = await chrome.storage.local.get('loadedProfileId');
      loadedProfileId = meta.loadedProfileId || null;
    }
  }
  profileStorageSnapshot = JSON.stringify(profiles);
}

async function migrateFromNamespacedProfiles(oldProfiles) {
  const activeId = oldProfiles.active || 'default';
  const allData = await chrome.storage.local.get(null);

  // Restore active profile's namespaced data to plain keys
  const prefix = `profile_${activeId}_`;
  const toSet = {};
  const toRemove = [];

  for (const [key, value] of Object.entries(allData)) {
    if (key.startsWith(prefix)) {
      const plainKey = key.slice(prefix.length);
      toSet[plainKey] = value;
      toRemove.push(key);
    }
    // Also clean up other profile namespaced keys
    if (key.startsWith('profile_') && !key.startsWith(prefix)) {
      toRemove.push(key);
    }
  }

  // Save profiles in new format + plain keys
  toSet.profiles = profiles;
  toSet.loadedProfileId = loadedProfileId;
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

async function mirrorStateToDisk(extra = {}) {
  if (typeof chrome.runtime?.sendNativeMessage !== 'function') return;
  try {
    const normalizedProfiles = profiles.map(p => ({
      id: p.id,
      name: p.name,
      activeProviders: p.snapshot?.activeProviders || [],
      configs: p.snapshot?.configs || {},
    }));
    await chrome.runtime.sendNativeMessage('com.intelia.invoice_extractor.op', {
      action: 'writeLocalState',
      merge: true,
      state: {
        profiles: normalizedProfiles,
        providerConfigs,
        activeProviderIds: [...activeProviderIds],
        loadedProfileId,
        ...extra,
      },
    });
  } catch {}
}

async function saveProfiles() {
  try {
    await syncRequest('save', { profiles, loadedProfileId, expected: profileStorageSnapshot });
    profileStorageSnapshot = JSON.stringify(profiles);
    await mirrorStateToDisk();
  } catch (error) {
    await loadProfiles();
    await renderHome();
    await renderProfiles();
    alert(localizeSyncText(error.message));
    throw error;
  }
}

async function applyProfile(id) {
  const profile = profiles.find(p => p.id === id);
  if (!profile || !profile.snapshot) return;

  // Overwrite live state with profile snapshot
  await chrome.storage.local.set({ activeProviders: profile.snapshot.activeProviders });
  activeProviderIds = new Set(profile.snapshot.activeProviders);

  // Overwrite provider configs
  const allData = await chrome.storage.local.get(null);
  const oldConfigKeys = Object.keys(allData).filter(k => k.startsWith('providerConfig_'));
  if (oldConfigKeys.length) await chrome.storage.local.remove(oldConfigKeys);

  const toSet = {};
  for (const [providerId, config] of Object.entries(profile.snapshot.configs || {})) {
    toSet[`providerConfig_${providerId}`] = config;
  }
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  providerConfigs = await loadProviderConfigs();

  loadedProfileId = id;
  await chrome.storage.local.set({ loadedProfileId });
  await mirrorStateToDisk();
}

async function saveCurrentToProfile(id) {
  const profile = profiles.find(p => p.id === id);
  if (!profile) return;

  // Snapshot current live state — use in-memory configs (includes defaults)
  const configs = {};
  for (const p of providers) {
    const live = providerConfigs[p.id];
    if (!live) continue;
    if (p.config || live._onepasswordItem) {
      configs[p.id] = { ...live };
    }
  }

  profile.snapshot = {
    activeProviders: [...activeProviderIds],
    configs
  };

  loadedProfileId = id;
  await saveProfiles();
}

async function createProfile(name, saveCurrentState = true) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `profile-${Date.now()}`;
  let uniqueId = id;
  let counter = 1;
  while (profiles.some(p => p.id === uniqueId)) {
    uniqueId = `${id}-${counter++}`;
  }

  const newProfile = { id: uniqueId, name, snapshot: null };
  profiles.push(newProfile);

  if (saveCurrentState) {
    await saveCurrentToProfile(uniqueId);
  } else {
    await saveProfiles();
  }
  return uniqueId;
}

async function deleteProfile(id) {
  profiles = profiles.filter(p => p.id !== id);
  if (loadedProfileId === id) loadedProfileId = null;
  await saveProfiles();
}

async function renameProfile(id, newName) {
  const profile = profiles.find(p => p.id === id);
  if (profile) {
    profile.name = newName;
    await saveProfiles();
  }
}

const _opResolveCache = new Map();
const OP_RESOLVE_CACHE_TTL_MS = 30000;

async function callOnePassword(action, input = {}) {
  let cacheKey = null;
  if (action === 'resolveProvider' && input?.provider?.id) {
    cacheKey = JSON.stringify({
      providerId: input.provider.id,
      itemOverride: input.itemOverride || '',
      profileName: input.profileName || '',
      billingUrl: input.billingUrl || '',
    });
    const cached = _opResolveCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < OP_RESOLVE_CACHE_TTL_MS) {
      return cached.response;
    }
  }

  // 1. Prefer direct Native Messaging from popup.html so it always spawns the latest
  // scripts/onepassword-host.sh from disk without depending on a cached Service Worker.
  if (typeof chrome.runtime?.sendNativeMessage === 'function') {
    try {
      const nativeRes = await chrome.runtime.sendNativeMessage(
        'com.intelia.invoice_extractor.op',
        { action, ...input }
      );
      if (nativeRes && typeof nativeRes === 'object') {
        if (cacheKey && nativeRes.ok) {
          _opResolveCache.set(cacheKey, { ts: Date.now(), response: nativeRes });
        }
        return nativeRes;
      }
    } catch (nativeErr) {
      return { ok: false, error: nativeErr?.message || String(nativeErr) };
    }
  }

  // 2. Fallback to background service worker message handler (used in tests or older contexts)
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'onepassword',
      action,
      input,
    });
  } catch (err) {
    response = { ok: false, error: err?.message || String(err) };
  }

  if (!response && typeof chrome.runtime?.sendNativeMessage !== 'function') {
    // The extension manifest in Chrome has not been reloaded since nativeMessaging was added.
    setTimeout(() => {
      try { chrome.runtime.reload(); } catch {}
    }, 800);
    return {
      ok: false,
      error: t('opReloadingExtension'),
    };
  }

  if (cacheKey && response?.ok) {
    _opResolveCache.set(cacheKey, { ts: Date.now(), response });
  }
  return response || { ok: false, error: t('opWorkerNoResponse') };
}

// Whether a password-manager bridge (the 1Password / Bitwarden native host) is installed and
// configured. Presentation only: it decides whether vault sign-in buttons are offered at all,
// using the host's read-only `status` action. Unknown until the probe answers (buttons hidden).
let credentialBridge = { checked: false, available: false, manager: '1password' };
let _credentialBridgeProbe = null;

function probeCredentialBridge() {
  if (!_credentialBridgeProbe) {
    _credentialBridgeProbe = callOnePassword('status')
      .then(res => {
        credentialBridge = {
          checked: true,
          available: !!(res?.ok && res.data?.available),
          manager: res?.data?.passwordManager === 'bitwarden' ? 'bitwarden' : '1password',
        };
      })
      .catch(() => { credentialBridge = { checked: true, available: false, manager: '1password' }; })
      .then(() => { applyCredentialBridgeUi(); return credentialBridge; });
  }
  return _credentialBridgeProbe;
}

function applyCredentialBridgeUi() {
  const signInBtn = document.getElementById('btn-1password-login');
  if (signInBtn) signInBtn.textContent = t(credentialBridge.manager === 'bitwarden' ? 'commonSignInBw' : 'commonSignInOp');
  const homeOpBtn = document.getElementById('btn-sync-op-profiles');
  if (homeOpBtn) homeOpBtn.hidden = !(credentialBridge.available && credentialBridge.manager === '1password');
  if (_lastButtons) showButtons(..._lastButtons);
}

async function syncProfilesFrom1Password() {
  const quickBtn = document.getElementById('btn-sync-op-profiles');
  const fullBtn = document.getElementById('btn-discover-op-profiles');
  const statusEl = document.getElementById('op-profiles-status');
  const setStatus = (msg, isError = false) => {
    if (statusEl) {
      statusEl.hidden = !msg;
      statusEl.classList.toggle('is-error', !!isError);
      statusEl.textContent = msg;
    }
  };

  if (quickBtn) {
    quickBtn.disabled = true;
    (quickBtn.querySelector('.op-sync-label') || quickBtn).textContent = t('commonBusy');
  }
  if (fullBtn) {
    fullBtn.disabled = true;
    fullBtn.textContent = t('profilesOpScanning');
  }
  setStatus(t('profilesOpScanningDetail'));

  try {
    _opResolveCache.clear();
    const response = await callOnePassword('discoverProfiles', {
      providers: providers.map(p => ({
        id: p.id,
        name: p.name,
        billingUrl: p.billingUrl,
        config: p.config || null,
        auth: p.auth || null,
      })),
    });

    if (!response?.ok || !response.data) {
      throw new Error(response?.error || t('opQueryFailed'));
    }

    const discovered = response.data.profiles || [];
    if (discovered.length === 0) {
      const msg = t('profilesOpNoMatches', [response.data.totalItems || 0]);
      setStatus(msg, true);
      if (!statusEl || statusEl.offsetParent === null) alert(msg);
      return;
    }

    let createdCount = 0;
    let updatedCount = 0;
    let firstTouchedId = null;

    for (const d of discovered) {
      let existing = profiles.find(
        p => p.id === d.id || p.name.trim().toLowerCase() === d.name.trim().toLowerCase()
      );
      if (!existing) {
        existing = {
          id: d.id,
          name: d.name,
          snapshot: {
            activeProviders: [...d.activeProviders],
            configs: { ...d.configs },
          },
        };
        profiles.push(existing);
        createdCount++;
      } else {
        const prevActive = existing.snapshot?.activeProviders || [];
        const mergedActive = Array.from(new Set([...prevActive, ...d.activeProviders]));
        const prevConfigs = existing.snapshot?.configs || {};
        const mergedConfigs = { ...prevConfigs };
        for (const [provId, provCfg] of Object.entries(d.configs || {})) {
          mergedConfigs[provId] = {
            ...(prevConfigs[provId] || {}),
            ...provCfg,
            _onepasswordItem: provCfg._onepasswordItem || prevConfigs[provId]?._onepasswordItem,
          };
        }
        existing.snapshot = {
          activeProviders: mergedActive,
          configs: mergedConfigs,
        };
        updatedCount++;
      }
      if (!firstTouchedId) firstTouchedId = existing.id;
    }

    await saveProfiles();

    const targetProfileId =
      loadedProfileId && profiles.some(p => p.id === loadedProfileId && dMatches(discovered, p))
        ? loadedProfileId
        : firstTouchedId;

    if (targetProfileId) {
      await applyProfile(targetProfileId);
    }

    await renderHome();
    await renderProfiles();

    const summary = discovered
      .map(d => `${d.name} (${tp('commonProvidersCount', d.activeProviders.length)})`)
      .join(', ');
    const msg = t('profilesOpSynced', [summary]);
    setStatus(msg, false);
  } catch (err) {
    setStatus(t('profilesOpSyncFailed', [err.message]), true);
    if (!statusEl || statusEl.offsetParent === null) {
      alert(t('profilesOpSyncFailed', [err.message]));
    }
  } finally {
    if (quickBtn) {
      quickBtn.disabled = false;
      (quickBtn.querySelector('.op-sync-label') || quickBtn).textContent = t('homeOpSyncLabel');
    }
    if (fullBtn) {
      fullBtn.disabled = false;
      fullBtn.textContent = t('profilesOpSyncButton');
    }
  }
}

function dMatches(discovered, profile) {
  return discovered.some(
    d => d.id === profile.id || d.name.trim().toLowerCase() === profile.name.trim().toLowerCase()
  );
}

function isProfileDirty() {
  if (!loadedProfileId) return false;
  const profile = profiles.find(p => p.id === loadedProfileId);
  if (!profile || !profile.snapshot) return false;

  // Compare active providers
  const snapshotSet = new Set(profile.snapshot.activeProviders || []);
  if (snapshotSet.size !== activeProviderIds.size) return true;
  for (const id of activeProviderIds) {
    if (!snapshotSet.has(id)) return true;
  }

  // Compare configs
  const snapshotConfigs = profile.snapshot.configs || {};
  for (const p of providers) {
    const liveConfig = providerConfigs[p.id] || {};
    const savedConfig = snapshotConfigs[p.id] || {};
    if ((liveConfig._onepasswordItem || '') !== (savedConfig._onepasswordItem || '')) {
      return true;
    }
    if (!p.config) continue;
    for (const field of Object.keys(p.config)) {
      const liveVal = JSON.stringify(liveConfig[field] ?? '');
      const savedVal = JSON.stringify(savedConfig[field] ?? '');
      if (liveVal !== savedVal) return true;
    }
  }

  return false;
}

function updateProfileDirtyIndicator() {
  const dirty = isProfileDirty();
  const dirtyBadge = document.getElementById('profile-dirty-badge');
  const saveQuickBtn = document.getElementById('btn-save-profile-quick');
  const profileBar = document.getElementById('profile-bar');
  if (dirtyBadge) dirtyBadge.hidden = !dirty;
  if (saveQuickBtn) saveQuickBtn.hidden = !(dirty && loadedProfileId);
  if (profileBar) {
    profileBar.classList.toggle('has-profile', !!loadedProfileId);
    profileBar.classList.toggle('is-dirty', dirty);
  }
}

// =====================================================
// PROVIDER LOADING
// =====================================================
let providers = [];
let activeProviderIds = new Set();
let workflowProviders = [];
let currentProviderTabId = null; // Track the tab opened for the current provider
let lastProviderError = null;   // Track last error for skip reason

async function loadProviders() {
  try {
    const indexUrl = chrome.runtime.getURL('providers/index.json');
    const index = await fetch(indexUrl).then(r => r.json());
    providers = await Promise.all(
      index.map(async id => {
        const url = chrome.runtime.getURL(`providers/${id}.json`);
        return fetch(url).then(r => r.json());
      })
    );
  } catch (e) {
    console.error('Failed to load providers:', e);
    providers = [];
  }
  return providers;
}

// =====================================================
// ACTIVE PROVIDER SELECTION
// =====================================================
async function loadActiveProviders() {
  const result = await chrome.storage.local.get('activeProviders');
  if (result.activeProviders) {
    activeProviderIds = new Set(result.activeProviders);
    // Remove IDs that no longer exist
    const validIds = new Set(providers.map(p => p.id));
    for (const id of activeProviderIds) {
      if (!validIds.has(id)) activeProviderIds.delete(id);
    }
  } else {
    activeProviderIds = new Set(providers.map(p => p.id));
  }
}

async function saveActiveProviders() {
  await chrome.storage.local.set({ activeProviders: [...activeProviderIds] });
  // Dirty indicator is updated by callers or renderHome
}

// =====================================================
// STATE
// =====================================================
// Effective "no user-set limit" — used as both default and cap. The engine
// stops extracting once this many invoices are collected.
const DEFAULT_MAX_INVOICES = 999;

let state = {
  currentIndex: -1,
  completed: [],
  skipped: [],
  isRunning: false,
  maxInvoices: DEFAULT_MAX_INVOICES,
  sinceDate: null
};

async function saveState() {
  await chrome.storage.local.set({ invoiceDownloaderState: state });
}

async function loadState() {
  const result = await chrome.storage.local.get('invoiceDownloaderState');
  if (result.invoiceDownloaderState) {
    state = result.invoiceDownloaderState;
    // Clean duplicates and validate IDs
    state.completed = [...new Set(state.completed || [])];
    const validIds = providers.map(p => p.id);
    state.completed = state.completed.filter(id => validIds.includes(id));
    // Migrate old string-based skipped to { key, reason } format
    state.skipped = (state.skipped || []).map(s =>
      typeof s === 'string' ? { key: s, reason: t('workflowSkipped') } : s
    );
    state.skipped = state.skipped.filter(s => validIds.includes(s.key));
    return true;
  }
  return false;
}

async function clearState() {
  state = {
    currentIndex: 0,
    completed: [],
    skipped: [],
    isRunning: false,
    maxInvoices: DEFAULT_MAX_INVOICES,
    sinceDate: null
  };
  await chrome.storage.local.remove('invoiceDownloaderState');
}

function workflowKey(provider) {
  return provider._multiLabel ? `${provider.id}:${provider._multiLabel}` : provider.id;
}

function addToCompleted(key) {
  if (!state.completed.includes(key)) state.completed.push(key);
}

function addToSkipped(key, reason = t('workflowSkippedByUser')) {
  if (!state.skipped.some(s => (typeof s === 'string' ? s : s.key) === key)) {
    state.skipped.push({ key, reason });
  }
}

function isSkipped(key) {
  return state.skipped.some(s => (typeof s === 'string' ? s : s.key) === key);
}

function getSkipReason(key) {
  const entry = state.skipped.find(s => (typeof s === 'string' ? s : s.key) === key);
  if (!entry) return null;
  return typeof entry === 'string' ? t('workflowSkipped') : entry.reason;
}

// =====================================================
// PROVIDER CONFIG
// =====================================================
let providerConfigs = {};

async function loadProviderConfigs() {
  const keys = providers.map(p => `providerConfig_${p.id}`);
  const stored = keys.length ? await chrome.storage.local.get(keys) : {};
  const configs = {};
  for (const p of providers) {
    const saved = stored[`providerConfig_${p.id}`] || {};
    if (!p.config && Object.keys(saved).length === 0) continue;
    configs[p.id] = { ...saved };
    if (p.config) {
      for (const [field, def] of Object.entries(p.config)) {
        if (configs[p.id][field] === undefined) {
          configs[p.id][field] = def.default || '';
        }
      }
    }
  }
  return configs;
}

async function saveProviderConfig(providerId, field, value) {
  const key = `providerConfig_${providerId}`;
  const result = await chrome.storage.local.get(key);
  const config = result[key] || {};
  config[field] = value;
  await chrome.storage.local.set({ [key]: config });
  providerConfigs[providerId] = { ...providerConfigs[providerId], [field]: value };
  updateProfileDirtyIndicator();
}

function normalizeConfigEntry(value, fieldDef) {
  const raw = String(value).trim();
  if (!raw) return '';
  const captured = fieldDef.capture ? raw.match(new RegExp(fieldDef.capture.urlPattern))?.[1] : null;
  const normalized = captured || raw;
  if (fieldDef.pattern && !new RegExp(fieldDef.pattern).test(normalized)) {
    throw new Error(fieldDef.validationMessage || t('providerConfigInvalid', [fieldDef.title]));
  }
  return normalized;
}

function providerConfigError(provider) {
  const config = { ...(providerConfigs[provider.id] || {}), ...(provider._configOverrides || {}) };
  for (const [key, def] of Object.entries(provider.config || {})) {
    const raw = config[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values.filter(v => v != null && v !== '')) {
      try { normalizeConfigEntry(value, def); } catch (error) { return error.message; }
    }
  }
  return null;
}

async function captureConfigCandidates(tabId, fieldDef) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: ({ origin, urlPattern, selector }) => {
      if (location.origin !== origin) return [];
      const pattern = new RegExp(urlPattern);
      const current = location.href.match(pattern)?.[1];
      if (current) return [{ value: current, label: current }];
      const candidates = new Map();
      for (const link of document.querySelectorAll(selector)) {
        const href = link.getAttribute('href');
        if (!href) continue;
        const value = new URL(href, location.href).href.match(pattern)?.[1];
        if (value && !candidates.has(value)) {
          candidates.set(value, { value, label: link.textContent.trim() || value });
        }
      }
      return [...candidates.values()];
    },
    args: [fieldDef.capture]
  });
  return results[0]?.result || [];
}

function appendConfigCapture(container, fieldDef, onUse) {
  if (!fieldDef.capture) return;
  const controls = document.createElement('div');
  controls.className = 'config-capture';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary config-capture-button';
  button.textContent = fieldDef.capture.buttonLabel;
  const message = document.createElement('div');
  message.className = 'config-hint';
  message.setAttribute('role', 'status');
  const choices = document.createElement('div');
  controls.append(button, message, choices);
  container.appendChild(controls);
  const use = async candidate => {
    await onUse(normalizeConfigEntry(candidate.value, fieldDef));
    choices.replaceChildren();
    message.textContent = t('providerCaptureSaved', [candidate.value]);
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    choices.replaceChildren();
    message.textContent = t('providerCaptureReading');
    try {
      const tab = await getActiveBrowserTab();
      const candidates = tab ? await captureConfigCandidates(tab.id, fieldDef) : [];
      if (!candidates.length) {
        message.textContent = t('providerCaptureNone');
      } else if (candidates.length === 1) {
        await use(candidates[0]);
      } else {
        message.textContent = t('providerCaptureMultiple');
        const select = document.createElement('select');
        select.className = 'config-input config-capture-select';
        select.setAttribute('aria-label', t('providerCaptureChooseAria', [fieldDef.title]));
        select.append(new Option(t('providerCaptureChoosePlaceholder'), ''));
        candidates.forEach((candidate, index) => {
          const label = candidate.label === candidate.value ? candidate.value : `${candidate.label} — ${candidate.value}`;
          select.append(new Option(label, String(index)));
        });
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'btn-secondary';
        confirm.textContent = t('providerCaptureUse');
        confirm.disabled = true;
        select.addEventListener('change', () => { confirm.disabled = select.value === ''; });
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          try { await use(candidates[Number(select.value)]); }
          catch (error) { message.textContent = error.message; confirm.disabled = false; }
        });
        choices.append(select, confirm);
      }
    } catch (error) {
      message.textContent = t('providerCaptureFailed', [error.message]);
    } finally {
      button.disabled = false;
    }
  });
}

// Read one config value for a provider as a scalar string. `multi` fields are
// stored as arrays; unexpanded entries would otherwise leak an array here.
function configValue(provider, key) {
  const config = { ...(providerConfigs[provider.id] || {}), ...(provider._configOverrides || {}) };
  const raw = config[key];
  const value = Array.isArray(raw) ? raw.filter(Boolean)[0] : raw;
  if (value == null || value === '') return '';
  const def = provider.config?.[key] || {};
  if (!def.pattern && !def.capture) return String(value);
  try { return normalizeConfigEntry(value, def); }
  catch { return String(value); } // Invalid entries are reported before starting a workflow.
}

// All stored values for a config field (multi fields keep every entry). Used to map an
// identifier found on the page back to the human-readable label the user typed next to it.
function configValues(provider, key) {
  const raw = (providerConfigs[provider.id] || {})[key];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  return raw == null || raw === '' ? [] : [String(raw)];
}

// Substitute {{config.X}} placeholders in a template string using the provider's
// stored config (plus any _configOverrides from multi-config expansion).
function resolveConfigTemplate(template, provider) {
  if (!template || !provider.config) return template;
  let out = template;
  for (const [key, def] of Object.entries(provider.config)) {
    const value = configValue(provider, key) || def.default || '';
    out = out.replace(new RegExp(`\\{\\{config\\.${key}\\}\\}`, 'g'), value);
  }
  return out;
}

function resolveBillingUrl(provider) {
  const raw = resolveConfigTemplate(provider.billingUrl, provider);
  return typeof raw === 'string' ? raw.replace(/([^:]\/)\/+/g, '$1') : raw;
}

// Config values may carry a pasted URL next to a human name — show only the name in the UI.
// With no name, fall back to the URL's last path segment (usually the account id).
function shortenConfigLabel(value) {
  const raw = String(value);
  const short = raw.replace(/https?:\/\/\S+/gi, ' ').replace(/[|\-–—:,]+\s*$/, ' ')
    .replace(/\s+/g, ' ').trim();
  if (short) return short;
  const url = raw.match(/https?:\/\/\S+/i)?.[0];
  if (url) {
    try { return new URL(url).pathname.split('/').filter(Boolean).pop() || raw; } catch (e) {}
  }
  return raw;
}

// Expand providers with multi-value config fields into separate workflow entries.
// When multiple fields are multi, values are paired by index (zip).
// Shorter arrays are padded by repeating their last value.
function expandMultiConfigProviders(providerList) {
  const expanded = [];
  for (const p of providerList) {
    if (!p.config) { expanded.push(p); continue; }
    const multiFields = Object.entries(p.config).filter(([, def]) => def.multi);
    if (multiFields.length === 0) { expanded.push(p); continue; }

    // Get values for all multi fields
    const fieldValues = multiFields.map(([fieldName]) => {
      const rawValue = providerConfigs[p.id]?.[fieldName] || '';
      const values = Array.isArray(rawValue)
        ? rawValue.filter(Boolean)
        : rawValue.split(',').map(v => v.trim()).filter(Boolean);
      return { fieldName, values };
    });

    const maxLen = Math.max(...fieldValues.map(f => f.values.length));

    // Single value per field: no fan-out, but still normalize the array-shaped
    // stored value into a scalar override so consumers can treat it as a string.
    if (maxLen === 1) {
      const overrides = {};
      for (const { fieldName, values } of fieldValues) {
        if (values.length) overrides[fieldName] = values[0];
      }
      expanded.push({ ...p, _configOverrides: overrides });
      continue;
    }
    if (maxLen < 1) { expanded.push(p); continue; }

    // Create entries by zipping values (pad shorter arrays with last value)
    for (let i = 0; i < maxLen; i++) {
      const overrides = {};
      const labelParts = [];
      for (const { fieldName, values } of fieldValues) {
        if (!values.length) continue; // field left empty — nothing to pin or label
        const val = values[Math.min(i, values.length - 1)];
        overrides[fieldName] = val;
        labelParts.push(shortenConfigLabel(val));
      }
      expanded.push({
        ...p,
        _configOverrides: overrides,
        _multiLabel: labelParts.join(' · ')
      });
    }
  }
  return expanded;
}

// =====================================================
// DOWNLOAD HISTORY
// =====================================================
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function historyEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const prov = entry.providerId || entry.providerName || '';
  const uniquePart =
    entry.downloadUrl ||
    entry.id ||
    entry.invoiceId ||
    entry.invoiceNumber ||
    entry.filename ||
    `${entry.date || ''}:${entry.amount || ''}`;
  return `${prov}::${uniquePart}`;
}

async function loadDownloadHistory() {
  const result = await chrome.storage.local.get('downloadHistory');
  return result.downloadHistory || [];
}

async function saveDownloadHistory(newEntries) {
  const history = await loadDownloadHistory();
  const existingKeys = new Set(history.map(h => historyEntryKey(h)));
  for (const entry of newEntries) {
    const key = historyEntryKey(entry);
    if (!existingKeys.has(key)) {
      history.push(entry);
      existingKeys.add(key);
    }
  }
  await chrome.storage.local.set({ downloadHistory: history });
  await mirrorStateToDisk({ history: history.map(h => historyEntryKey(h)).filter(Boolean) });

  // Try to resolve file paths for entries that don't already have a downloadId
  const unresolved = newEntries.filter(e => !e.downloadId);
  if (unresolved.length > 0) {
    resolveDownloadPaths(unresolved);
  }
}

async function resolveDownloadPaths(entries) {
  // Wait for downloads to complete, then search for file paths
  await new Promise(r => setTimeout(r, 3000));
  const history = await loadDownloadHistory();
  let updated = false;

  for (const entry of entries) {
    const entryKey = historyEntryKey(entry);
    const idx = history.findIndex(h => historyEntryKey(h) === entryKey && !h.downloadId);
    if (idx === -1) continue;

    const dlItem = await findDownloadItem(entry.filename, entry.downloadUrl);
    if (dlItem) {
      history[idx].filePath = dlItem.filename;
      history[idx].downloadId = dlItem.id;
      updated = true;
    }
  }

  if (updated) {
    await chrome.storage.local.set({ downloadHistory: history });
  }
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Search chrome.downloads for a file by filename or URL
async function findDownloadItem(filename, url) {
  // Strategy 1: exact filename match
  if (filename) {
    try {
      const results = await chrome.downloads.search({
        filenameRegex: escapeRegex(filename),
        limit: 1,
        orderBy: ['-startTime']
      });
      if (results.length > 0 && results[0].filename) return results[0];
    } catch (e) {}
  }

  // Strategy 2: filename with (N) suffix (Chrome renames duplicates)
  if (filename) {
    try {
      const base = filename.replace(/\.[^.]+$/, ''); // strip extension
      const ext = filename.match(/\.[^.]+$/)?.[0] || '';
      const results = await chrome.downloads.search({
        filenameRegex: `${escapeRegex(base)}(\\s*\\(\\d+\\))?${escapeRegex(ext)}`,
        limit: 1,
        orderBy: ['-startTime']
      });
      if (results.length > 0 && results[0].filename) return results[0];
    } catch (e) {}
  }

  // Strategy 3: search by download URL
  if (url) {
    try {
      const results = await chrome.downloads.search({
        url: url,
        limit: 1,
        orderBy: ['-startTime']
      });
      if (results.length > 0 && results[0].filename) return results[0];
    } catch (e) {}
  }

  // Strategy 4: keyword search — extract provider name + date from filename
  if (filename) {
    try {
      // Extract meaningful parts: e.g., "Vultr_Invoice_2026-03-01_8.47.pdf" → "Vultr.*2026-03-01"
      const parts = filename.replace(/\.[^.]+$/, '').split(/[_\-\s]+/);
      const keywords = parts.filter(p => p.length > 2);
      if (keywords.length >= 2) {
        const provider = escapeRegex(keywords[0]);
        const datePart = keywords.find(k => /\d{4}/.test(k));
        const pattern = datePart ? `${provider}.*${escapeRegex(datePart)}` : provider;
        const results = await chrome.downloads.search({
          filenameRegex: pattern,
          limit: 5,
          orderBy: ['-startTime']
        });
        if (results.length > 0 && results[0].filename) return results[0];
      }
    } catch (e) {}
  }

  return null;
}

async function showFileInFolder(downloadId) {
  try {
    await chrome.downloads.show(downloadId);
  } catch (e) {
    console.error('Cannot show file:', e);
    try { await chrome.downloads.showDefaultFolder(); } catch (ex) {}
  }
}

// =====================================================
// TAB MANAGEMENT
// =====================================================
async function getActiveBrowserTab() {
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.type === 'popup') {
    // Floating window — find the most recently used tab in normal browser windows.
    const allTabs = await chrome.tabs.query({ active: true });
    const normalTabs = [];
    for (const tab of allTabs) {
      if (tab.windowId === currentWindow.id) continue;
      try {
        const win = await chrome.windows.get(tab.windowId);
        if (win.type === 'normal') normalTabs.push(tab);
      } catch (e) { /* window gone */ }
    }
    normalTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return normalTabs[0] || null;
  }
  // Normal popup
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function createTabInBrowser(url) {
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.type === 'popup') {
    // Create tab in a normal browser window, not in our popup
    const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (normalWindows.length > 0) {
      const targetWindow = normalWindows.find(w => w.focused) || normalWindows[0];
      const tab = await chrome.tabs.create({ url, active: true, windowId: targetWindow.id });
      await chrome.windows.update(targetWindow.id, { focused: true });
      refocusPopup();
      return tab;
    }
  }
  return await chrome.tabs.create({ url, active: true });
}

// =====================================================
// SITE DETECTION & SELECTOR POLLING
// =====================================================
function detectProvider(url) {
  let tabUrl;
  try { tabUrl = new URL(url); } catch { return null; }
  let fallback = null;
  let match = null;
  let matchLength = -1;
  for (const provider of providers) {
    const cleanUrl = provider.billingUrl.replace(/\{\{config\.\w+\}\}/g, '__invoice_config__');
    try {
      const billingUrl = new URL(cleanUrl);
      if (tabUrl.hostname !== billingUrl.hostname) continue;
      fallback ||= provider;
      const prefix = billingUrl.pathname.split('__invoice_config__')[0];
      if (tabUrl.pathname.startsWith(prefix) && prefix.length > matchLength) {
        match = provider;
        matchLength = prefix.length;
      }
    } catch (e) { /* skip invalid URLs */ }
  }
  return match || fallback;
}

async function findProviderTab(providerId, billingUrl = null) {
  const allTabs = await chrome.tabs.query({});
  for (const tab of allTabs) {
    if (tab.url && detectProvider(tab.url)?.id === providerId &&
        (!billingUrl || sameBillingLocation(tab.url, billingUrl))) return tab;
  }
  return null;
}

// SPAs that route on the hash (Holded: /home#settings:/subscription/invoices) need the hash
// compared too — otherwise any tab on the same path looks like the billing page.
function sameBillingLocation(tabUrl, billingUrl) {
  try {
    const a = new URL(tabUrl), b = new URL(billingUrl);
    if (a.hostname !== b.hostname || !a.pathname.includes(b.pathname)) return false;
    return b.hash ? a.hash === b.hash : true;
  } catch (e) { return false; }
}

// A hash-only change is a same-document navigation: Chrome does not reload, so the SPA never
// re-routes. Callers must force a reload after such an update.
function isHashOnlyChange(fromUrl, toUrl) {
  try {
    const a = new URL(fromUrl), b = new URL(toUrl);
    return a.origin === b.origin && a.pathname === b.pathname &&
           a.search === b.search && a.hash !== b.hash;
  } catch (e) { return false; }
}

// Same-document hash navigation (either changing the hash OR updating to the exact same URL
// when a hash is present): Chrome does not perform a full document reload unless forced.
function isSameDocumentHashNavigation(fromUrl, toUrl) {
  try {
    const a = new URL(fromUrl), b = new URL(toUrl);
    return a.origin === b.origin && a.pathname === b.pathname &&
           a.search === b.search && Boolean(a.hash || b.hash);
  } catch (e) { return false; }
}

async function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    let settled = false;
    let pollTimer = null;
    let timeoutTimer = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onComplete);
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(val);
    };
    const onComplete = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        finish(true);
      }
    };
    chrome.tabs.onUpdated.addListener(onComplete);
    // Allow 200ms for a just-issued navigation to transition tab.status to 'loading',
    // then poll chrome.tabs.get so already-complete tabs don't hang for the full timeoutMs.
    setTimeout(() => {
      if (settled) return;
      pollTimer = setInterval(async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab?.status === 'complete') finish(true);
        } catch {
          // Tab may be mocked or closed
        }
      }, 300);
    }, 200);
    timeoutTimer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function selectorExists(tabId, selector, frameId = null) {
  const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
  const results = await chrome.scripting.executeScript({
    target,
    func: (sel) => !!document.querySelector(sel),
    args: [selector],
    world: 'MAIN'
  });
  return !!results[0]?.result;
}

async function waitForSelector(tabId, selector, maxWaitSeconds = 60, onProgress = null, frameId = null) {
  for (let attempt = 1; attempt <= maxWaitSeconds; attempt++) {
    try {
      // A URL pattern is resolved on every attempt: iframe IDs change after navigation.
      const resolvedFrameId = typeof frameId === 'string' ? await findIframeId(tabId, frameId) : frameId;
      if ((typeof frameId !== 'string' || resolvedFrameId != null) &&
          await selectorExists(tabId, selector, resolvedFrameId)) return { success: true, attempts: attempt };
      if (onProgress) onProgress(attempt, maxWaitSeconds);
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      if (e.message?.includes('No tab') || e.message?.includes('cannot access')) {
        return { success: false, error: t('workflowErrorTabClosed') };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { success: false, error: t('workflowErrorTimeout', [maxWaitSeconds]) };
}

// Combined tab ready check: waits for tab load + optional readySelector
async function waitForTabReady(tabId, readySelector = null, frameId = null, timeoutMs = 15000) {
  await waitForTabLoad(tabId, timeoutMs);
  // Brief pause for SPA rendering after load event
  await new Promise(r => setTimeout(r, 500));
  if (readySelector) {
    const maxSeconds = Math.max(5, Math.ceil((timeoutMs - 500) / 1000));
    await waitForSelector(tabId, readySelector, maxSeconds, null, frameId);
  }
}

// =====================================================
// ENGINE EXECUTION — Step-driven orchestration
// =====================================================

// Find the frame ID matching a provider's iframe.urlPattern
async function findIframeId(tabId, urlPattern) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames) return null;
  for (const frame of frames) {
    if (frame.frameId !== 0 && frame.url && frame.url.includes(urlPattern)) {
      return frame.frameId;
    }
  }
  return null;
}

// Find iframe with retry — waits for iframe to appear after page/frame reloads
async function findIframeIdWithRetry(tabId, urlPattern, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const fid = await findIframeId(tabId, urlPattern);
    if (fid != null) return fid;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// Inject utils.js + engine.js into the target frame (MAIN world)
async function injectEngine(tabId, frameId) {
  const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
  await chrome.scripting.executeScript({ target, files: ['utils.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target, files: ['engine.js'], world: 'MAIN' });
}

// Call an engine function and return its result
async function callEngine(tabId, funcName, args = [], frameId) {
  const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
  const results = await chrome.scripting.executeScript({
    target,
    func: async (fn, a) => {
      const engine = window.__invoiceEngine;
      if (!engine || !engine[fn]) throw new Error(`Engine function "${fn}" not found`);
      return await engine[fn](...a);
    },
    args: [funcName, args],
    world: 'MAIN'
  });
  return results[0]?.result;
}

// Sign-in domain binding (see login-domains.mjs). `domains` is creds.allowedLoginDomains:
// suffixes built from the vault item URLs and the provider recipe. https only (http on localhost).
function checkLoginUrl(rawUrl, domains) {
  const list = (Array.isArray(domains) ? domains : [])
    .map(d => String(d || '').toLowerCase().replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, reason: 'invalid-url', host: '' }; }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (list.length === 0) return { ok: false, reason: 'no-allowed-domains', host };
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local))) {
    return { ok: false, reason: 'insecure', host };
  }
  if (!list.some(d => host === d || host.endsWith(`.${d}`))) return { ok: false, reason: 'domain-mismatch', host };
  return { ok: true, host };
}

// Autofill entry point. The address is the one Chrome reports for the tab's top frame (page
// scripts cannot fake it), and the engine call is pinned to that exact document, so a
// navigation in between cannot carry the credentials to another site. engine.js re-checks
// at the moment of typing.
async function callEngineForLogin(tabId, creds, authConfig) {
  let frame = null;
  try { frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }); } catch {}
  let url = frame?.url || '';
  if (!url) {
    try { url = (await chrome.tabs.get(tabId))?.url || ''; } catch {}
  }
  const check = checkLoginUrl(url, creds?.allowedLoginDomains);
  if (!check.ok) return { attempted: false, blocked: true, reason: check.reason, host: check.host };

  const target = frame?.documentId ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [0] };
  const results = await chrome.scripting.executeScript({
    target,
    func: async (c, a) => {
      const engine = window.__invoiceEngine;
      if (!engine || !engine.attemptAutoLogin) throw new Error('Engine function "attemptAutoLogin" not found');
      return await engine.attemptAutoLogin(c, a);
    },
    args: [creds, authConfig],
    world: 'MAIN'
  });
  return results[0]?.result;
}

function loginBlockedMessage(loginRes, provider) {
  const key = loginRes?.reason === 'insecure' ? 'workflowLoginInsecure' : 'workflowLoginDomainMismatch';
  return t(key, [loginRes?.host || '?', provider.name]);
}

// Run preSteps via engine. For iframe providers, re-finds frame after each step.
async function runPreSteps(tabId, provider, frameId) {
  const steps = provider.extract.preSteps;
  if (!steps || !steps.length) return;

  const isIframe = provider.iframe?.urlPattern;

  for (const step of steps) {
    if (step.action === 'diagnose') {
      // Debug-only diagnostic — run directly, not through engine API
      const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
      const results = await chrome.scripting.executeScript({
        target,
        func: () => {
          const keywords = ['periodo', 'este mes', 'mes anterior', 'últimos', 'desde siempre', 'año anterior', 'este año', 'todas las transacciones', 'personalizado'];
          const found = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const el = walker.currentNode;
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.length > 200) continue;
            if (keywords.some(k => text.includes(k))) {
              found.push({
                tag: el.tagName.toLowerCase(),
                text: text.substring(0, 100),
                classes: el.className?.toString().substring(0, 150) || '',
                role: el.getAttribute('role'),
                ariaHaspopup: el.getAttribute('aria-haspopup'),
                id: el.id || null,
                visible: el.offsetWidth > 0 && el.offsetHeight > 0,
                children: el.children.length
              });
            }
          }
          return found.slice(0, 40);
        },
        world: 'MAIN'
      });
      console.log(`PreStep diagnose:`, JSON.stringify(results[0]?.result, null, 2));
      continue;
    }

    try {
      const result = await callEngine(tabId, 'executeStep', [step], frameId);
      console.log(`PreStep ${step.action}: ${result?.elementsClicked || 0} click(s)`);
    } catch (e) {
      console.warn(`PreStep ${step.action} failed: ${e.message}`);
      // Frame may have been destroyed — will retry finding it below
    }

    // For iframe providers, re-find frame after each step (frame may reload)
    if (isIframe) {
      const newFrameId = await findIframeIdWithRetry(tabId, provider.iframe.urlPattern, 8000);
      if (newFrameId != null) {
        frameId = newFrameId;
        await injectEngine(tabId, frameId);
      }
    }
  }

  return frameId;
}

// Extract invoices from the current page via engine
async function extractInvoices(tabId, provider, frameId, paginationState) {
  const config = {
    maxInvoices: state.maxInvoices || DEFAULT_MAX_INVOICES,
    sinceDate: state.sinceDate || null,
    previousDownloads: paginationState?.previousDownloads || [],
    seen: paginationState?.seen || []
  };

  const result = await callEngine(tabId, 'extractRows', [provider, config], frameId);
  return result;
}

// Unified per-invoice download. Returns { success, error? }
async function downloadInvoice(tabId, invoice, provider, frameId) {
  const method = provider.download.method;
  const filename = invoice.filename || undefined;

  switch (method) {
    case 'direct-link': {
      const url = invoice.downloadUrl;
      if (!url) return { success: false, error: t('downloadErrorNoUrl') };
      const dlId = await chrome.downloads.download({ url, filename });
      if (dlId) invoice._downloadId = dlId;
      return { success: true };
    }

    case 'fetch-blob': {
      const url = invoice.downloadUrl;
      if (!url) return { success: false, error: t('downloadErrorNoUrl') };
      try {
        const target = frameId != null ? { tabId, frameIds: [frameId] } : { tabId };
        const results = await chrome.scripting.executeScript({
          target,
          world: 'MAIN',
          func: async (fetchUrl, htmlPageError) => {
            try {
              const res = await fetch(fetchUrl, { credentials: 'include' });
              if (!res.ok) {
                return { ok: false, error: `HTTP ${res.status}` };
              }
              const contentType = (res.headers.get('content-type') || '').toLowerCase();
              if (contentType.includes('text/html')) {
                return { ok: false, error: htmlPageError };
              }
              const blob = await res.blob();
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('Failed to read blob'));
                reader.readAsDataURL(blob);
              });
              return { ok: true, dataUrl };
            } catch (err) {
              return { ok: false, fallback: true, error: err.message };
            }
          },
          args: [url, t('downloadErrorHtmlPage')],
        });
        const fetchRes = results?.[0]?.result;
        if (fetchRes?.ok && fetchRes.dataUrl) {
          const dlId = await chrome.downloads.download({ url: fetchRes.dataUrl, filename });
          if (dlId) invoice._downloadId = dlId;
          return { success: true };
        }
        if (fetchRes && !fetchRes.fallback) {
          return { success: false, error: fetchRes.error || t('downloadErrorFetchFailed') };
        }
      } catch {
        // Fall back to direct chrome.downloads if cross-origin script execution fails
      }
      const dlId = await chrome.downloads.download({ url, filename });
      if (dlId) invoice._downloadId = dlId;
      return { success: true };
    }

    case 'chrome-download': {
      let url = invoice.downloadUrl;
      if (!url) return { success: false, error: t('downloadErrorNoUrl') };
      if (provider.download.urlSuffix) {
        url = url.replace(/\/?$/, '') + provider.download.urlSuffix;
      }

      let resolveDownload;
      let timeoutId;
      let dlTab;
      const downloadPromise = new Promise(resolve => { resolveDownload = resolve; });
      const onCreated = (downloadItem) => {
        let matchesInvoice = downloadItem.url === url || downloadItem.finalUrl === url;
        if (!matchesInvoice && downloadItem.referrer) {
          try {
            matchesInvoice = new URL(downloadItem.referrer).origin === new URL(url).origin;
          } catch { /* ignore malformed referrers */ }
        }
        if (!matchesInvoice) return;
        invoice._downloadId = downloadItem.id;
        chrome.downloads.onCreated.removeListener(onCreated);
        resolveDownload(true);
      };
      // The download can start during navigation or before executeScript returns.
      chrome.downloads.onCreated.addListener(onCreated);

      try {
        dlTab = await chrome.tabs.create({ url, active: false });
        await waitForTabLoad(dlTab.id, 12000);

        if (provider.download.postLoadClick) {
          await new Promise(r => setTimeout(r, provider.download.postLoadClick.wait || 2000));
          const clickCfg = provider.download.postLoadClick;
          let clickResults;
          try {
            clickResults = await chrome.scripting.executeScript({
              target: { tabId: dlTab.id },
              func: (selector, matchText) => {
                const els = document.querySelectorAll(selector);
                for (const el of els) {
                  if (!matchText || el.textContent.trim().toLowerCase().includes(matchText.toLowerCase())) {
                    el.click();
                    return true;
                  }
                }
                return false;
              },
              args: [clickCfg.selector, clickCfg.text || null],
              world: 'MAIN'
            });
          } catch (clickErr) {
            return { success: false, error: t('downloadErrorClickFailed', [clickErr.message]) };
          }
          if (!clickResults.some(result => result.result)) {
            return { success: false, error: t('downloadErrorButtonNotFound') };
          }
        }

        const downloadStarted = await Promise.race([
          downloadPromise,
          new Promise(resolve => { timeoutId = setTimeout(() => resolve(false), 15000); })
        ]);

        if (!downloadStarted) {
          // A hosted invoice page is HTML, not a fallback PDF download.
          if (provider.download.postLoadClick) {
            return { success: false, error: t('downloadErrorNoDownload') };
          }
          try {
            const fallbackId = await chrome.downloads.download({ url, filename });
            if (fallbackId) invoice._downloadId = fallbackId;
            return { success: true };
          } catch (e2) {
            return { success: false, error: t('downloadErrorNoDownload') };
          }
        }
        return { success: true };
      } finally {
        clearTimeout(timeoutId);
        chrome.downloads.onCreated.removeListener(onCreated);
        if (dlTab) {
          try { await chrome.tabs.remove(dlTab.id); } catch (e) {}
        }
      }
    }

    case 'debugger-print': {
      const url = invoice.downloadUrl;
      if (!url) return { success: false, error: t('downloadErrorNoUrl') };

      const dlTab = await chrome.tabs.create({ url, active: false });

      // Wait for page to load
      await new Promise(resolve => {
        const onComplete = (id, info) => {
          if (id === dlTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onComplete);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onComplete);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(onComplete); resolve(); }, 10000);
      });
      await new Promise(r => setTimeout(r, 2000));

      const target = { tabId: dlTab.id };
      try {
        await chrome.debugger.attach(target, '1.3');
        try {
          const pdfResult = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
            printBackground: true,
            preferCSSPageSize: true,
            marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4
          });

          if (pdfResult?.data) {
            const byteChars = atob(pdfResult.data);
            const byteArray = new Uint8Array(byteChars.length);
            for (let j = 0; j < byteChars.length; j++) byteArray[j] = byteChars.charCodeAt(j);
            const blob = new Blob([byteArray], { type: 'application/pdf' });
            const blobUrl = URL.createObjectURL(blob);
            const dlId = await chrome.downloads.download({
              url: blobUrl,
              filename: filename || `${provider.name}_Receipt.pdf`
            });
            if (dlId) invoice._downloadId = dlId;
            setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
          } else {
            return { success: false, error: t('downloadErrorPdfEmpty') };
          }
        } finally {
          try { await chrome.debugger.detach(target); } catch (e) {}
        }
      } finally {
        try { await chrome.tabs.remove(dlTab.id); } catch (e) {}
      }
      return { success: true };
    }

    case 'click-download': {
      // Re-find iframe before each download (frame may have reloaded between downloads)
      let dlFrameId = frameId;
      if (provider.iframe?.urlPattern) {
        const freshId = await findIframeIdWithRetry(tabId, provider.iframe.urlPattern, 5000);
        if (freshId != null) {
          dlFrameId = freshId;
          await injectEngine(tabId, dlFrameId);
        }
      }

      // Check if download steps include main-frame scoped steps (cross-frame)
      const hasMainFrameSteps = provider.iframe?.urlPattern &&
        provider.download?.steps?.some(s => s.scope === 'main-frame');

      if (hasMainFrameSteps) {
        return await executeClickDownloadCrossFrame(tabId, invoice, provider, dlFrameId);
      }

      // Standard click-download: drive steps via engine's clickInRow
      const result = await callEngine(tabId, 'clickInRow',
        [provider.extract.rows, invoice.__rowIndex, provider.download.steps], dlFrameId);

      if (result?.capturedUrl) {
        try {
          const dlId = await chrome.downloads.download({ url: result.capturedUrl, filename });
          if (dlId) invoice._downloadId = dlId;
          return { success: true };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      // No captured URL — download may have been triggered by the click itself (e.g., <a download>)
      return { success: true };
    }

    case 'open-tabs': {
      const url = invoice.downloadUrl;
      if (!url) return { success: false, error: t('downloadErrorNoUrl') };
      await chrome.tabs.create({ url });
      return { success: true };
    }

    default:
      return { success: false, error: t('downloadErrorUnknownMethod', [method]) };
  }
}

// Cross-frame click-download steps (for iframe providers with main-frame scoped steps)
async function executeClickDownloadCrossFrame(tabId, invoice, provider, frameId) {
  const urlPattern = provider.iframe?.urlPattern;
  const steps = provider.download?.steps || [];
  const rowIndex = invoice.__rowIndex;

  // Helper: click an element in a specific frame target.
  // Self-contained — inline simClick/textMatches/isVis to keep this resilient
  // when utils.js can't be injected into the target frame (cross-origin iframe
  // edge cases). Plain el.click() doesn't fire React/Google webcomponent handlers.
  const clickInFrame = async (target, selector, textSpec, onlyVisible) => {
    try {
      const results = await chrome.scripting.executeScript({
        target,
        func: (sel, text, visOnly) => {
          function textMatches(c, spec) {
            if (!spec) return true;
            const l = c.toLowerCase();
            return (Array.isArray(spec) ? spec : [spec]).some(t => l.includes(t.toLowerCase()));
          }
          function isVis(el) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
          }
          function simClick(el) {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
            el.dispatchEvent(new PointerEvent('pointerdown', o));
            el.dispatchEvent(new MouseEvent('mousedown', o));
            el.dispatchEvent(new PointerEvent('pointerup', o));
            el.dispatchEvent(new MouseEvent('mouseup', o));
            el.dispatchEvent(new MouseEvent('click', o));
          }
          const els = Array.from(document.querySelectorAll(sel));
          const cands = visOnly ? els.filter(isVis) : els;
          for (const el of cands) {
            if (textMatches(el.textContent, text)) { simClick(el); return true; }
          }
          return false;
        },
        args: [selector, textSpec, onlyVisible],
        world: 'MAIN'
      });
      return results[0]?.result || false;
    } catch (e) { return false; }
  };

  // Dismiss any leftover error/modal dialogs before starting (provider-declared)
  const dismissSelectors = provider.download?.dismissSelectors || [];
  if (urlPattern && dismissSelectors.length) {
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
    for (const f of (allFrames || [])) {
      if (f.frameId === 0 || !f.url?.includes(urlPattern)) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [f.frameId] },
          func: (selectors) => {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null) el.click();
            }
          },
          args: [dismissSelectors],
          world: 'MAIN'
        });
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 300));
  }

  for (const step of steps) {
    const pollTimeout = step.pollTimeout || 0;
    const pollStart = Date.now();
    let clicked = false;

    if (step.scope === 'row') {
      // Click within the specific row via the iframe — inline simClick for
      // the same reason as clickInFrame above (React/webcomponent handlers).
      const fid = await findIframeId(tabId, urlPattern);
      if (fid != null) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [fid] },
            func: (rowSelector, rowIdx, selector) => {
              function simClick(el) {
                const r = el.getBoundingClientRect();
                const x = r.left + r.width / 2, y = r.top + r.height / 2;
                const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
                el.dispatchEvent(new PointerEvent('pointerdown', o));
                el.dispatchEvent(new MouseEvent('mousedown', o));
                el.dispatchEvent(new PointerEvent('pointerup', o));
                el.dispatchEvent(new MouseEvent('mouseup', o));
                el.dispatchEvent(new MouseEvent('click', o));
              }
              const row = document.querySelectorAll(rowSelector)[rowIdx];
              if (!row) return false;
              const el = row.querySelector(selector);
              if (!el) return false;
              simClick(el);
              return true;
            },
            args: [provider.extract.rows, rowIndex, step.selector],
            world: 'MAIN'
          });
          clicked = results[0]?.result || false;
        } catch (e) { /* frame gone */ }
      }

    } else if (step.scope === 'main-frame') {
      // Search ALL frames (main + iframes) for the button
      do {
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        const targets = [{ tabId }];
        if (urlPattern && frames) {
          for (const f of frames) {
            if (f.frameId !== 0 && f.url?.includes(urlPattern)) {
              targets.push({ tabId, frameIds: [f.frameId] });
            }
          }
        }
        for (const t of targets) {
          clicked = await clickInFrame(t, step.selector, step.text || null, step.visible || false);
          if (clicked) break;
        }
        if (clicked || pollTimeout === 0) break;
        await new Promise(r => setTimeout(r, 200));
      } while (Date.now() - pollStart < pollTimeout);

    } else {
      // document scope — search in the engine's iframe
      const fid = await findIframeId(tabId, urlPattern);
      if (fid != null) {
        clicked = await clickInFrame({ tabId, frameIds: [fid] }, step.selector, step.text || null, step.visible || false);
      }
    }

    // Wait for dialog to close after clicking
    if (clicked && step.waitForDialogClose) {
      const closeStart = Date.now();
      while (Date.now() - closeStart < 10000) {
        let dialogOpen = false;
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        for (const f of (frames || [])) {
          if (!f.url?.includes(urlPattern)) continue;
          try {
            const res = await chrome.scripting.executeScript({
              target: { tabId, frameIds: [f.frameId] },
              func: () => {
                const d = document.querySelector('.modal-dialog, [role="dialog"]');
                return d && getComputedStyle(d).display !== 'none' && d.offsetWidth > 0;
              },
              world: 'MAIN'
            });
            if (res[0]?.result) { dialogOpen = true; break; }
          } catch (e) {}
        }
        if (!dialogOpen) break;
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (step.wait) await new Promise(r => setTimeout(r, step.wait));
  }

  return { success: true };
}


// =====================================================
// NAVIGATION
// =====================================================
const nav = {
  stack: ['home'],
  data: {},
  show(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById('view-' + viewId);
    if (el) {
      el.classList.add('active');
      el.classList.add('fade-in');
    }
  },
  push(viewId, data = {}) {
    this.data = data;
    this.stack.push(viewId);
    this.show(viewId);
  },
  pop() {
    if (this.stack.length > 1) this.stack.pop();
    this.show(this.stack[this.stack.length - 1]);
  },
  home() {
    this.stack = ['home'];
    this.data = {};
    this.show('home');
    renderHome();
  }
};

// =====================================================
// UI HELPERS (presentation only)
// =====================================================
// Lucide-style paths (ISC), 24 grid, 2px stroke, currentColor. No emoji in UI.
const ICON_PATHS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  skip: '<path d="m5 4 10 8-10 8V4z"/><path d="M19 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  fileCheck: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

function icon(name, size = 16) {
  return `<svg class="ie-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}

function setHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.hidden = !!hidden;
}

function initialsFor(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function providerLogoUrl(providerId) {
  return chrome.runtime.getURL(`icons/providers/${providerId}.png`);
}

// Logos are decorative (the provider name is always next to them), so alt="".
function logoImgHtml(providerId, name, className) {
  return `<img class="${className}" src="${escapeHtml(providerLogoUrl(providerId))}" alt="" data-logo-name="${escapeHtml(name || providerId || '')}">`;
}

function logoFallbackFor(img, name) {
  const span = document.createElement('span');
  span.className = `${img.className} logo-fallback`;
  span.setAttribute('aria-hidden', 'true');
  span.textContent = initialsFor(name);
  return span;
}

// MV3 extension pages block inline onerror="" handlers, so missing logos are swapped for
// initials here, after the markup is in the DOM.
function wireLogoFallbacks(root) {
  root.querySelectorAll('img[data-logo-name]').forEach(img => {
    const swap = () => img.replaceWith(logoFallbackFor(img, img.dataset.logoName));
    if (img.complete && img.naturalWidth === 0) swap();
    else img.addEventListener('error', swap, { once: true });
  });
}

// For the fixed logo slots (provider detail, current workflow provider) that are reused.
function setStaticLogo(img, providerId, name) {
  if (!img) return;
  const next = img.nextElementSibling;
  if (next?.classList.contains('logo-fallback')) next.remove();
  img.hidden = false;
  img.onerror = () => { img.hidden = true; img.after(logoFallbackFor(img, name)); };
  img.src = providerLogoUrl(providerId);
}

// Local YYYY-MM-DD (toISOString would shift the day in timezones east of UTC).
function localIsoDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Stored invoice dates are kept as scraped; only unambiguous ISO dates are re-rendered
// in the interface language. CSV and storage keep the raw value.
function displayInvoiceDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return raw || '\u2014';
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(date.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(uiLanguage(), { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  } catch {
    return raw;
  }
}

// =====================================================
// HOME VIEW
// =====================================================
function selectedProvidersLabel(readyCount, setupCount) {
  if (readyCount + setupCount === 0) return t('homeEmptySelection');
  const parts = [tp('homeReadyCount', readyCount)];
  if (setupCount > 0) parts.push(tp('homeNeedsSetupCount', setupCount));
  return parts.join(' \u00b7 ');
}

// Same rule the run applies before opening a provider: a field the billing URL or the
// pre-navigation needs is empty (no value, no default), or a saved value is invalid.
// Such a provider is skipped by Download All, so Home counts it as "needs setup".
function providerNeedsSetup(provider) {
  if (!provider.config) return false;
  const config = { ...(providerConfigs[provider.id] || {}), ...(provider._configOverrides || {}) };
  return missingRequiredConfig(provider, config) || !!providerConfigError(provider);
}

function updateDownloadAllSubtitle() {
  const active = providers.filter(p => activeProviderIds.has(p.id));
  const setup = active.filter(providerNeedsSetup).length;
  document.getElementById('download-all-subtitle').textContent = selectedProvidersLabel(active.length - setup, setup);
}

// Icon-only buttons carry their name in both the tooltip and the accessible label.
function setButtonLabel(button, label) {
  button.title = label;
  button.setAttribute('aria-label', label);
}

function providerCardSubtitle(provider, isActive, providerHistory) {
  const off = isActive ? '' : `<span class="provider-state-off">${escapeHtml(t('homeProviderOff'))}</span>`;
  if (providerNeedsSetup(provider)) return `${off}<span class="status status-warn">${escapeHtml(t('homeProviderNeedsConfig'))}</span>`;
  if (providerHistory.length > 0) return `${off}<span class="status status-ok">${escapeHtml(tp('homeProviderDownloaded', providerHistory.length))}</span>`;
  return `${off}${escapeHtml(t('homeProviderNoDownloads'))}`;
}

// One card = a button that opens the provider plus a separate include toggle
// (no interactive element nested inside another).
function renderProviderCard(provider, history) {
  const isActive = activeProviderIds.has(provider.id);
  const providerHistory = history.filter(h => h.providerId === provider.id);
  const card = document.createElement('div');
  card.className = `card provider-card${isActive ? '' : ' inactive'}`;
  card.innerHTML = `
    <button type="button" class="provider-card-main">
      ${logoImgHtml(provider.id, provider.name, 'provider-logo')}
      <span class="provider-info">
        <span class="provider-name">${escapeHtml(provider.name)}</span>
        <span class="provider-subtitle"></span>
      </span>
      <span class="provider-chevron">${icon('chevronRight')}</span>
    </button>
    <div class="provider-card-toggle">
      <label class="toggle-switch" title="${escapeHtml(t('homeProviderInclude', [provider.name]))}">
        <input type="checkbox" ${isActive ? 'checked' : ''} data-provider-id="${escapeHtml(provider.id)}" aria-label="${escapeHtml(t('homeProviderInclude', [provider.name]))}">
        <span class="toggle-slider"></span>
      </label>
    </div>
  `;
  const subtitle = card.querySelector('.provider-subtitle');
  subtitle.innerHTML = providerCardSubtitle(provider, isActive, providerHistory);
  const toggle = card.querySelector('input[type="checkbox"]');
  toggle.addEventListener('change', async () => {
    if (toggle.checked) activeProviderIds.add(provider.id);
    else activeProviderIds.delete(provider.id);
    await saveActiveProviders();
    card.classList.toggle('inactive', !toggle.checked);
    subtitle.innerHTML = providerCardSubtitle(provider, toggle.checked, providerHistory);
    updateDownloadAllSubtitle();
    updateProfileDirtyIndicator();
  });
  card.querySelector('.provider-card-main').addEventListener('click', () => {
    nav.push('provider', { providerId: provider.id });
    renderProviderDetail(provider.id);
  });
  return card;
}

async function renderHome() {
  // Profile bar
  const profileSelect = document.getElementById('profile-select');
  if (profileSelect) {
    profileSelect.innerHTML = '';
    profileSelect.append(new Option(t('homeNoProfile'), ''));
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === loadedProfileId) opt.selected = true;
      profileSelect.appendChild(opt);
    }
  }

  // Dirty state indicator
  const dirty = isProfileDirty();
  const dirtyBadge = document.getElementById('profile-dirty-badge');
  const saveQuickBtn = document.getElementById('btn-save-profile-quick');
  const profileBar = document.getElementById('profile-bar');
  if (dirtyBadge) dirtyBadge.hidden = !dirty;
  if (saveQuickBtn) saveQuickBtn.hidden = !(dirty && loadedProfileId);
  if (profileBar) {
    profileBar.classList.toggle('has-profile', !!loadedProfileId);
    profileBar.classList.toggle('is-dirty', dirty);
  }

  // Stats bar
  const history = await loadDownloadHistory();
  document.getElementById('home-stats').textContent =
    `${tp('commonInvoicesCount', history.length)} \u00b7 ${tp('commonProvidersCount', providers.length)}`;

  // Download All subtitle: what will actually run vs what will be skipped for missing setup
  updateDownloadAllSubtitle();

  // Provider cards, grouped: Ready, Needs setup, Off. A card stays in its group until the
  // next render, so toggling never moves the row from under the pointer.
  const container = document.getElementById('provider-cards');
  container.innerHTML = '';
  const groups = { ready: [], setup: [], off: [] };
  for (const provider of providers) {
    if (!activeProviderIds.has(provider.id)) groups.off.push(provider);
    else if (providerNeedsSetup(provider)) groups.setup.push(provider);
    else groups.ready.push(provider);
  }
  const groupTitles = { ready: 'homeGroupReady', setup: 'homeGroupNeedsSetup', off: 'homeGroupOff' };
  for (const [groupKey, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const heading = document.createElement('h3');
    heading.className = 'provider-group-title';
    heading.innerHTML = `<span>${escapeHtml(t(groupTitles[groupKey]))}</span><span class="provider-group-count">${list.length}</span>`;
    container.appendChild(heading);
    for (const provider of list) container.appendChild(renderProviderCard(provider, history));
  }
  wireLogoFallbacks(container);

  // Select all / Deselect all button
  const btnSelectAll = document.getElementById('btn-select-all');
  if (btnSelectAll) {
    const allSelected = providers.every(p => activeProviderIds.has(p.id));
    btnSelectAll.textContent = t(allSelected ? 'homeDeselectAll' : 'homeSelectAll');
    btnSelectAll.onclick = async () => {
      if (allSelected) {
        activeProviderIds.clear();
      } else {
        for (const p of providers) activeProviderIds.add(p.id);
      }
      await saveActiveProviders();
      renderHome();
    };
  }

  // History badge
  const badge = document.getElementById('history-card-badge');
  if (badge) {
    badge.textContent = history.length > 0 ? history.length : '';
  }
}

// =====================================================
// PROVIDER DETAIL VIEW
// =====================================================
async function renderProviderDetail(providerId) {
  const provider = providers.find(p => p.id === providerId);
  if (!provider) return;

  // Logo
  setStaticLogo(document.getElementById('provider-detail-logo'), provider.id, provider.name);

  // Name & domain
  document.getElementById('provider-detail-name').textContent = provider.name;
  try {
    const domain = new URL(provider.billingUrl.replace(/\{\{config\.\w+\}\}/g, 'x')).hostname;
    document.getElementById('provider-detail-domain').textContent = domain;
  } catch { document.getElementById('provider-detail-domain').textContent = ''; }

  // Toggle
  const toggle = document.getElementById('provider-toggle');
  toggle.checked = activeProviderIds.has(provider.id);
  toggle.onchange = async () => {
    if (toggle.checked) activeProviderIds.add(provider.id);
    else activeProviderIds.delete(provider.id);
    await saveActiveProviders();
  };

  // Config section (provider fields + optional 1Password item override)
  const configSection = document.getElementById('provider-config-section');
  const configFields = document.getElementById('provider-config-fields');
  configSection.hidden = false;
  configFields.innerHTML = '';

  const hintHtmlFor = fieldDef => fieldDef.hint
    ? `<div class="config-hint">${escapeHtml(fieldDef.hint)}${fieldDef.hintUrl ? ` <button type="button" class="config-hint-link" data-url="${escapeHtml(fieldDef.hintUrl)}">${escapeHtml(t('providerHintOpenPage'))}</button>` : ''}</div>`
    : '';
  if (provider.config && Object.keys(provider.config).length > 0) {
    for (const [fieldName, fieldDef] of Object.entries(provider.config)) {
      const rawValue = providerConfigs[provider.id]?.[fieldName];
      const inputId = `cfg-${provider.id}-${fieldName}`.replace(/[^\w-]/g, '_');

      if (fieldDef.multi) {
        // Multi-value config field — show list with add/remove
        const values = Array.isArray(rawValue) ? rawValue.filter(Boolean)
          : (rawValue ? [rawValue] : []);

        const div = document.createElement('div');
        div.className = 'config-field';
        div.innerHTML = `<label class="config-label" for="${inputId}">${escapeHtml(fieldDef.title || fieldName)}</label>${hintHtmlFor(fieldDef)}`;

        const errorEl = document.createElement('div');
        errorEl.className = 'config-error';
        errorEl.setAttribute('role', 'alert');
        div.appendChild(errorEl);
        const listEl = document.createElement('div');
        listEl.className = 'config-multi-list';

        function renderMultiValues() {
          listEl.innerHTML = '';
          values.forEach((val, idx) => {
            const row = document.createElement('div');
            row.className = 'config-multi-item';
            row.innerHTML = `
              <span class="config-multi-value"></span>
              <button type="button" class="config-multi-remove" data-idx="${idx}" title="${escapeHtml(t('commonRemove'))}" aria-label="${escapeHtml(t('commonRemoveValue', [String(val)]))}">${icon('x', 14)}</button>
            `;
            row.querySelector('.config-multi-value').textContent = String(val);
            try { normalizeConfigEntry(val, fieldDef); }
            catch (error) { row.classList.add('config-invalid'); row.title = error.message; }
            row.querySelector('.config-multi-remove').addEventListener('click', async () => {
              values.splice(idx, 1);
              await saveProviderConfig(provider.id, fieldName, [...values]);
              renderMultiValues();
            });
            listEl.appendChild(row);
          });
          const invalid = values.some(value => {
            try { normalizeConfigEntry(value, fieldDef); return false; } catch { return true; }
          });
          errorEl.textContent = invalid
            ? t('providerConfigRemoveInvalid', [fieldDef.validationMessage || t('providerConfigInvalidGeneric')])
            : '';
          document.getElementById('btn-download-single').disabled = !!providerConfigError(provider);
        }
        renderMultiValues();
        div.appendChild(listEl);

        // Add new value input
        const addRow = document.createElement('div');
        addRow.className = 'config-multi-add';
        addRow.innerHTML = `
          <input class="config-input config-multi-input" id="${inputId}" type="${escapeHtml(fieldDef.type || 'text')}"
                 placeholder="${escapeHtml(fieldDef.placeholder || fieldDef.default || t('providerConfigAddPlaceholder'))}">
          <button type="button" class="config-multi-add-btn" title="${escapeHtml(t('commonAdd'))}" aria-label="${escapeHtml(t('commonAdd'))}">${icon('plus')}</button>
        `;
        const addInput = addRow.querySelector('input');
        const addBtn = addRow.querySelector('button');
        const addValue = async raw => {
          const v = normalizeConfigEntry(raw, fieldDef);
          if (!v || values.includes(v)) return;
          await saveProviderConfig(provider.id, fieldName, [...values, v]);
          values.push(v);
          addInput.value = '';
          renderMultiValues();
        };
        const doAdd = async () => {
          try { await addValue(addInput.value); }
          catch (error) { errorEl.textContent = error.message; }
        };
        addBtn.addEventListener('click', doAdd);
        addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
        div.appendChild(addRow);
        appendConfigCapture(div, fieldDef, addValue);

        configFields.appendChild(div);
      } else {
        // Single-value config field
        const value = rawValue || '';
        const div = document.createElement('div');
        div.className = 'config-field';
        div.innerHTML = `
          <label class="config-label" for="${inputId}">${escapeHtml(fieldDef.title || fieldName)}</label>
          ${hintHtmlFor(fieldDef)}
          <input class="config-input" id="${inputId}" type="${escapeHtml(fieldDef.type || 'text')}"
                 data-provider="${escapeHtml(provider.id)}" data-field="${escapeHtml(fieldName)}"
                 placeholder="${escapeHtml(fieldDef.placeholder || fieldDef.default || '')}">
        `;
        const input = div.querySelector('input');
        input.value = value;
        const errorEl = document.createElement('div');
        errorEl.className = 'config-error';
        errorEl.setAttribute('role', 'alert');
        div.appendChild(errorEl);
        const saveValue = async raw => {
          const normalized = normalizeConfigEntry(raw, fieldDef);
          await saveProviderConfig(provider.id, fieldName, normalized);
          input.value = normalized;
          errorEl.textContent = '';
          document.getElementById('btn-download-single').disabled = !!providerConfigError(provider);
        };
        input.addEventListener('change', async () => {
          try { await saveValue(input.value); }
          catch (error) { errorEl.textContent = error.message; }
        });
        try { normalizeConfigEntry(value, fieldDef); }
        catch (error) { errorEl.textContent = error.message; }
        appendConfigCapture(div, fieldDef, saveValue);
        configFields.appendChild(div);
      }
    }
    // Attach click handlers for hint links (open URL in new tab)
    configFields.querySelectorAll('.config-hint-link').forEach(link => {
      link.addEventListener('click', () => {
        chrome.tabs.create({ url: link.dataset.url });
      });
    });
  }

  // Optional 1Password item override field for auto-login
  const opDiv = document.createElement('div');
  opDiv.className = 'config-field';
  const opInputId = `cfg-${provider.id}-onepassword`.replace(/[^\w-]/g, '_');
  opDiv.innerHTML = `
    <label class="config-label" for="${opInputId}">${escapeHtml(t('providerOpItemLabel'))}</label>
    <div class="config-hint">${escapeHtml(t('providerOpItemHint'))}</div>
    <input class="config-input" id="${opInputId}" type="text"
           data-provider="${escapeHtml(provider.id)}" data-field="_onepasswordItem"
           placeholder="${escapeHtml(provider.auth?.item || provider.name)}">
  `;
  const opInput = opDiv.querySelector('input');
  opInput.value = providerConfigs[provider.id]?._onepasswordItem || '';
  opInput.addEventListener('change', async () => {
    const trimmed = opInput.value.trim();
    await saveProviderConfig(provider.id, '_onepasswordItem', trimmed);
    opInput.value = trimmed;
  });
  configFields.appendChild(opDiv);

  document.getElementById('btn-download-single').disabled = !!providerConfigError(provider);

  // Per-provider history
  const history = await loadDownloadHistory();
  const provHistory = history.filter(h => h.providerId === provider.id)
    .sort((a, b) => (b.downloadedAt || '').localeCompare(a.downloadedAt || ''));
  const histContainer = document.getElementById('provider-history');
  if (provHistory.length === 0) {
    histContainer.innerHTML = `<div class="empty-state empty-state-compact"><p>${escapeHtml(t('providerHistoryEmpty'))}</p></div>`;
  } else {
    let html = '<div class="provider-history-list">';
    for (const entry of provHistory.slice(0, 20)) {
      const hasFile = entry.downloadId;
      const tag = hasFile ? 'button' : 'div';
      const label = hasFile ? ` type="button" aria-label="${escapeHtml(t('historyOpenRowLabel', [provider.name, entry.date || '\u2014']))}"` : '';
      html += `<${tag} class="provider-history-item${hasFile ? ' has-file' : ''}"${label} ${hasFile ? `data-download-id="${escapeHtml(entry.downloadId)}"` : ''}>
        <span class="provider-history-date">${escapeHtml(displayInvoiceDate(entry.date))}</span>
        <span class="provider-history-amount">${escapeHtml(entry.amount || '\u2014')}</span>
        ${hasFile ? `<span class="provider-history-open">${icon('folder', 14)}</span>` : ''}
      </${tag}>`;
    }
    html += '</div>';
    histContainer.innerHTML = html;

    // Click to open file
    histContainer.querySelectorAll('.provider-history-item.has-file').forEach(item => {
      item.addEventListener('click', async () => {
        const dlId = parseInt(item.dataset.downloadId);
        if (dlId) await showFileInFolder(dlId);
      });
    });
  }
}

// =====================================================
// BATCH CONFIG VIEW
// =====================================================
function renderBatchConfig(providerList) {
  const list = document.getElementById('batch-provider-list');
  const title = document.getElementById('batch-providers-title');
  title.textContent = tp('commonProvidersCount', providerList.length);

  list.innerHTML = '';
  for (const p of providerList) {
    const div = document.createElement('div');
    div.className = 'site-item';
    div.innerHTML = `
      ${logoImgHtml(p.id, p.name, 'icon')}
      <span class="name">${escapeHtml(p.name)}</span>
      ${providerNeedsSetup(p) ? `<span class="status status-warn site-setup-note">${escapeHtml(t('batchWillSkip'))}</span>` : ''}
    `;
    list.appendChild(div);
  }
  wireLogoFallbacks(list);

  // Restore saved settings
  document.getElementById('config-since-date').value = state.sinceDate || '';
  const maxEl = document.getElementById('config-max-invoices');
  if (state.maxInvoices && state.maxInvoices < DEFAULT_MAX_INVOICES) {
    maxEl.value = state.maxInvoices;
  } else {
    maxEl.value = '';
  }

  // Default date: first of current month if no date set
  const dateInput = document.getElementById('config-since-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = sinceDatePreset('this-month');
  }
  syncPresetButtons();
}

// Quick ranges only write the same "since" date field the user can also type.
function sinceDatePreset(preset) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (preset === 'last-month') return localIsoDate(new Date(y, m - 1, 1));
  if (preset === 'this-quarter') return localIsoDate(new Date(y, m - (m % 3), 1));
  return localIsoDate(new Date(y, m, 1));
}

function syncPresetButtons() {
  const value = document.getElementById('config-since-date')?.value;
  document.querySelectorAll('.preset-row [data-preset]').forEach(button => {
    button.setAttribute('aria-pressed', String(value === sinceDatePreset(button.dataset.preset)));
  });
}

// =====================================================
// WORKFLOW UI
// =====================================================
function showCurrentSiteUI(provider) {
  setStaticLogo(document.getElementById('workflow-current-logo'), provider.id, provider.name);
  const displayName = provider._multiLabel ? `${provider.name} (${provider._multiLabel})` : provider.name;
  document.getElementById('workflow-current-name').textContent = displayName;
  const step1 = document.getElementById('login-step-1');
  if (step1) step1.textContent = t('workflowLoginStep1', [displayName]);
}

function showStatus(message) {
  document.getElementById('workflow-current-status').textContent = message;
}

// Last arguments, so the controls can be re-applied when the vault probe answers.
let _lastButtons = null;

function showButtons(login, downloading, next, skip, stop = false, retry = false, gotoBilling = false) {
  _lastButtons = [login, downloading, next, skip, stop, retry, gotoBilling];
  // Vault sign-in is offered only when a password-manager bridge is installed and configured.
  const vault = login && credentialBridge.available;
  setHidden('btn-logged-in', !login);
  setHidden('btn-1password-login', !vault);
  setHidden('btn-switch-account', !vault);
  setHidden('btn-show-tab', !login);
  setHidden('btn-downloading', !downloading);
  setHidden('btn-next', !next);
  setHidden('btn-skip', !skip);
  setHidden('btn-stop', !stop);
  setHidden('btn-retry', !retry);
  setHidden('btn-goto-billing', !gotoBilling);
  // One main action: Retry leads after an error, "I'm signed in — continue" leads a sign-in prompt.
  const loggedIn = document.getElementById('btn-logged-in');
  const retryBtn = document.getElementById('btn-retry');
  loggedIn.classList.toggle('btn-primary', !retry);
  loggedIn.classList.toggle('btn-secondary', !!retry);
  retryBtn.classList.toggle('btn-primary', !!retry);
  retryBtn.classList.toggle('btn-secondary', !retry);
  // The numbered sign-in steps belong to a sign-in prompt, not to an error with Retry.
  setHidden('login-steps', !(login && !retry));
}

function updateProgress() {
  const total = workflowProviders.length;
  const done = state.completed.length + state.skipped.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-bar')?.setAttribute('aria-valuenow', String(pct));
  const skipped = state.skipped.length;
  const completed = state.completed.length;
  document.getElementById('progress-text').textContent = [
    t('workflowProgressDownloaded', [completed]),
    ...(skipped > 0 ? [t('workflowProgressSkipped', [skipped])] : []),
    t('workflowProgressRemaining', [total - done]),
  ].join(' \u00b7 ');
}

// Rows already shown as filed, so the stamp lands only once, when a provider finishes.
let _filedKeys = null;

const SITE_STATUS = {
  done: { icon: 'check', label: 'workflowSiteFiled' },
  current: { icon: 'arrowRight', label: 'workflowSiteNow' },
  skipped: { icon: 'skip', label: 'workflowSiteSkipped' },
  waiting: { icon: 'clock', label: 'workflowSiteWaiting' },
};

function updateSitesList() {
  const container = document.getElementById('workflow-sites-container');
  container.innerHTML = '';
  const firstRender = _filedKeys === null;
  if (firstRender) _filedKeys = new Set();
  for (const p of workflowProviders) {
    const key = workflowKey(p);
    const isCurrent = state.currentIndex >= 0 && workflowProviders[state.currentIndex] === p;
    const status = state.completed.includes(key) ? 'done' :
                   isSkipped(key) ? 'skipped' :
                   isCurrent ? 'current' : 'waiting';
    const skipReason = status === 'skipped' ? getSkipReason(key) : null;
    const justFiled = status === 'done' && !_filedKeys.has(key) && !firstRender;
    if (status === 'done') _filedKeys.add(key);
    const meta = SITE_STATUS[status];
    const li = document.createElement('li');
    li.className = `site-item ${status}${justFiled ? ' just-filed' : ''}`;
    if (isCurrent) li.setAttribute('aria-current', 'step');
    const displayName = p._multiLabel ? `${p.name} (${p._multiLabel})` : p.name;
    li.innerHTML = `
      ${logoImgHtml(p.id, p.name, 'icon')}
      <span class="name">${escapeHtml(displayName)}${skipReason ? `<span class="skip-reason">${escapeHtml(skipReason)}</span>` : ''}</span>
      <span class="site-status">${icon(meta.icon, 12)}<span>${escapeHtml(t(meta.label))}</span></span>
    `;
    container.appendChild(li);
  }
  wireLogoFallbacks(container);
}

// A skip that needs no action: everything on the page was already filed or is older than
// the chosen date. Every other skip (missing setup, sign-in, errors) needs the person.
function isUpToDateSkip(reason) {
  if (!reason) return false;
  if (reason === t('workflowSkipAllDownloaded')) return true;
  const [before, after] = t('workflowSkipAllBeforeDate', ['\u0000', '\u0001']).split(/\u0000.*\u0001/s);
  return before !== undefined && after !== undefined && reason.startsWith(before) && reason.endsWith(after);
}

function showCompletion() {
  state.isRunning = false;
  saveState();
  const done = state.completed.length;
  const skippedList = state.skipped;
  const attention = skippedList.filter(s => !isUpToDateSkip(s.reason));
  const filed = runInvoiceCount;
  const clean = attention.length === 0;

  // Headline follows the outcome: Bonobot only for a clean run, and the stamp only when something was
  // filed. A clean run with nothing new shows the "nothing new this month" scene instead.
  const completion = document.getElementById('completion');
  completion.classList.toggle('needs-attention', !clean);
  setHidden('completion-art', !clean);
  document.getElementById('completion-scene').src = filed > 0
    ? 'icons/brand/scene-success.svg' : 'icons/brand/empty-nothing-new.svg';
  completion.classList.toggle('nothing-new', clean && filed === 0);
  setHidden('completion-stamp', !(clean && filed > 0));
  setHidden('completion-quip', !clean);
  setHidden('completion-help', clean);
  document.getElementById('completion-title').textContent = clean
    ? (filed > 0 ? tp('completionClean', filed) : t('completionCleanNone'))
    : `${tp('completionFiled', filed)}, ${tp('completionNeedYou', attention.length)}`;

  let summary = tp('completionSummary', done);
  if (skippedList.length > 0) {
    summary += ` \u00b7 ${tp('completionSkipped', skippedList.length)}`;
  }
  document.getElementById('completion-summary').textContent = summary;

  // What was skipped and why; the ones that need the person first.
  const detailEl = document.getElementById('completion-skipped');
  if (detailEl) {
    const ordered = [...attention, ...skippedList.filter(s => !attention.includes(s))];
    detailEl.innerHTML = ordered.map(s => {
      const p = providers.find(pr => pr.id === s.key) || workflowProviders.find(pr => workflowKey(pr) === s.key);
      const name = p ? p.name : s.key;
      const needsYou = attention.includes(s);
      return `<li class="skip-detail-item${needsYou ? ' needs-you' : ''}">
        ${p ? logoImgHtml(p.id, p.name, 'skip-detail-logo') : ''}
        <span class="skip-detail-text">
          <span class="skip-detail-name">${escapeHtml(name)}${needsYou ? `<span class="status status-warn">${escapeHtml(t('completionNeedsYouLabel'))}</span>` : `<span class="status status-ok">${escapeHtml(t('completionUpToDateLabel'))}</span>`}</span>
          <span class="skip-detail-reason">${escapeHtml(s.reason)}</span>
        </span>
      </li>`;
    }).join('');
    detailEl.hidden = ordered.length === 0;
    wireLogoFallbacks(detailEl);
  }
  nav.push('completion');
}

// =====================================================
// WORKFLOW
// =====================================================
// Track providers that have already performed an automatic 1Password account switch
// during the current workflow run so we never enter a logout -> login -> logout loop.
const _switchedProviderKeys = new Set();

function isConfigFieldRequiredForNavigation(provider, key) {
  // Stripe routes /settings/plans-and-fees/invoice-history to the active account when
  // accountId is omitted, so 1Password-synced Stripe profiles work without a manual acct_ ID.
  if (provider.id === 'stripe' && key === 'accountId') return false;
  const token = `{{config.${key}}}`;
  if (String(provider.billingUrl || '').includes(token)) return true;
  if (String(provider.preNavigation?.url || '').includes(token)) return true;
  return false;
}

// True when a config field the navigation needs has no value and no default.
function missingRequiredConfig(provider, config) {
  return Object.entries(provider.config || {}).some(([key, def]) => {
    if (!isConfigFieldRequiredForNavigation(provider, key)) return false;
    const val = config[key];
    // For multi fields, check if there's at least one value
    if (def.multi) {
      return !val || (Array.isArray(val) ? val.filter(Boolean).length === 0 : !val.toString().trim());
    }
    // Field is configured if user set a value OR there's a default
    const effective = val?.toString().trim() || def.default?.toString().trim();
    return !effective;
  });
}

function shouldRunPreNavigation(provider) {
  const preNav = provider.preNavigation;
  if (!preNav) return false;
  const templates = [
    preNav.url || '',
    ...(preNav.steps || []).map(step => step.text || ''),
  ];
  for (const tpl of templates) {
    const matches = String(tpl).matchAll(/\{\{config\.(\w+)\}\}/g);
    for (const m of matches) {
      const key = m[1];
      const val = configValue(provider, key) || provider.config?.[key]?.default || '';
      if (!String(val).trim()) return false;
    }
  }
  return true;
}

async function startWorkflow() {
  // Reload configs in case they were changed
  providerConfigs = await loadProviderConfigs();
  _switchedProviderKeys.clear();

  // Expand multi-config providers (e.g., Google Cloud with multiple billing accounts)
  workflowProviders = expandMultiConfigProviders(workflowProviders);

  if (workflowProviders.length === 0) return;

  await clearState();
  clearDownloadFeed();
  state.maxInvoices = parseInt(document.getElementById('config-max-invoices').value, 10) || DEFAULT_MAX_INVOICES;
  state.sinceDate = document.getElementById('config-since-date').value || null;
  state.isRunning = true;
  state.currentIndex = 0;
  state.workflowProviderIds = workflowProviders.map(p => p.id);
  // Save multi labels for resume
  state.workflowMultiLabels = workflowProviders.map(p => p._multiLabel || null);
  state.workflowConfigOverrides = workflowProviders.map(p => p._configOverrides || null);
  await saveState();

  updateSitesList();
  updateProgress();
  await processCurrentSite();
}

async function resumeWorkflow() {
  // Rebuild workflowProviders from saved state, including multi-config expansions
  workflowProviders = state.workflowProviderIds.map((id, i) => {
    const base = providers.find(p => p.id === id);
    if (!base) return null;
    const overrides = state.workflowConfigOverrides?.[i];
    const label = state.workflowMultiLabels?.[i];
    if (overrides) return { ...base, _configOverrides: overrides, _multiLabel: label };
    return base;
  }).filter(Boolean);
  nav.push('workflow');
  updateSitesList();
  updateProgress();
  await processCurrentSite();
}

async function processCurrentSite() {
  if (state.currentIndex >= workflowProviders.length) {
    state.isRunning = false;
    await saveState();
    showCompletion();
    return;
  }

  const provider = workflowProviders[state.currentIndex];
  lastProviderError = null;
  const provNum = state.currentIndex + 1;
  const provTotal = workflowProviders.length;
  updateProgress();
  updateSitesList();
  showCurrentSiteUI(provider);

  // Skip providers that need URL/preNavigation configuration but aren't configured.
  // Optional orgCheck-only fields (like Holded accountId or OpenAI org, where hint says
  // "Leave empty to skip the check") do not block launching when left empty.
  if (provider.config) {
    const config = { ...(providerConfigs[provider.id] || {}), ...(provider._configOverrides || {}) };
    const unconfigured = missingRequiredConfig(provider, config);
    const configError = providerConfigError(provider);
    if (unconfigured || configError) {
      showStatus(t('workflowStatusSkippedConfig', [provider.name, configError || t('workflowNeedsConfig')]));
      addToSkipped(workflowKey(provider), configError || t('workflowSkipNotConfigured'));
      updateProgress();
      updateSitesList();
      await new Promise(r => setTimeout(r, 1000));
      await processNextSite();
      return;
    }
  }

  showStatus(t('workflowStatusOpeningNth', [provNum, provTotal, provider.name]));
  showButtons(false, false, false, true);

  // Pre-navigation: navigate to a preparatory URL first (e.g., to switch org/account)
  if (shouldRunPreNavigation(provider)) {
    const preNav = provider.preNavigation;
    const preNavUrl = resolveConfigTemplate(preNav.url, provider);
    showStatus(t('workflowStatusPreparingAccount', [provider.name]));
    const preNavTab = await createTabInBrowser(preNavUrl);
    await waitForTabReady(preNavTab.id, preNav.readySelector);

    if (preNav.steps?.length) {
      const resolvedSteps = preNav.steps.map(step => {
        if (!step.text) return step;
        return { ...step, text: resolveConfigTemplate(step.text, provider) };
      });

      // Inject engine into preNav tab and run steps via step API
      await injectEngine(preNavTab.id);
      for (const step of resolvedSteps) {
        await callEngine(preNavTab.id, 'executeStep', [step]);
      }

    }

    // Navigate the same tab to the billing URL
    const billingUrl = resolveBillingUrl(provider);
    await chrome.tabs.update(preNavTab.id, { url: billingUrl });
    await waitForTabReady(preNavTab.id, provider.readySelector);

    currentProviderTabId = preNavTab.id;

    showStatus(t('workflowStatusWaitingData', [provider.name]));
    const result = await waitForSelector(preNavTab.id, provider.readySelector, 30,
      (attempt) => showStatus(t('workflowStatusDetecting', [provider.name, attempt]))
    );
    if (result.success) {
      showStatus(t('workflowStatusLoadedStarting', [provider.name]));
      showButtons(false, true, false, false, true);
      await executeDownload(preNavTab.id, provider);
    } else {
      lastProviderError = t('workflowErrorPreNavNotReady');
      showStatus(t('workflowStatusPreNavNotReady', [provider.name]));
      showButtons(true, false, false, true, false, false, true);
      startLoginPolling(preNavTab.id, provider);
    }
    return;
  }

  // Find or open the billing page tab
  // 1. Check if any open tab already matches this provider
  const billingUrl = resolveBillingUrl(provider);
  let targetTab = await findProviderTab(provider.id, billingUrl) || await findProviderTab(provider.id);

  // 2. If not found, open the billing URL; if found, navigate only if on wrong page
  let needsWaitForLoad = false;
  if (!targetTab) {
    showStatus(t('workflowStatusOpening', [provider.name]));
    targetTab = await createTabInBrowser(billingUrl);
    needsWaitForLoad = true;
  } else {
    // Found a tab on this provider's domain — check if it's already on the billing page
    const tabUrl = targetTab.url || '';

    if (sameBillingLocation(tabUrl, billingUrl)) {
      // Already on the right page — just focus
      await chrome.tabs.update(targetTab.id, { active: true });
      await chrome.windows.update(targetTab.windowId, { focused: true });
      refocusPopup();
    } else {
      // On wrong page of same domain — navigate to billing URL
      const hashOnly = isHashOnlyChange(tabUrl, billingUrl);
      await chrome.tabs.update(targetTab.id, { active: true, url: billingUrl });
      if (hashOnly) await chrome.tabs.reload(targetTab.id);
      await chrome.windows.update(targetTab.windowId, { focused: true });
      refocusPopup();
      needsWaitForLoad = true;
    }
  }

  if (!targetTab) {
    lastProviderError = t('workflowErrorOpenTab');
    showStatus(t('workflowStatusCouldNotOpen', [provider.name]));
    showButtons(true, false, false, true);
    return;
  }

  // Track the tab for "Show tab" button
  currentProviderTabId = targetTab.id;

  // 3. Wait for tab to finish loading (prevents stale DOM detection)
  if (needsWaitForLoad) {
    showStatus(t('workflowStatusLoadingPage', [provider.name]));
    await waitForTabReady(targetTab.id);
  }

  // 4. If provider uses an iframe, wait for it to appear — but break early if a login
  //    form appears on the main page (e.g. Holded redirects /home to /login when logged out).
  let iframeId = null;
  if (provider.iframe?.urlPattern) {
    showStatus(t('workflowStatusWaitingIframe', [provider.name]));
    for (let i = 0; i < 15; i++) {
      iframeId = await findIframeId(targetTab.id, provider.iframe.urlPattern);
      if (iframeId != null) break;
      if (i >= 1) {
        try {
          await injectEngine(targetTab.id);
          const det = await callEngine(targetTab.id, 'detectLoginForm', [provider.auth || {}]);
          if (det?.hasLoginForm) break;
        } catch {}
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 5. Auto-detect: poll for readySelector (login detection)
  showStatus(t('workflowStatusWaitingData', [provider.name]));
  showButtons(false, false, false, true); // only skip visible while waiting

  let result = (!provider.iframe?.urlPattern || iframeId != null)
    ? await waitForSelector(
        targetTab.id,
        provider.readySelector,
        8, // initial 8s check before attempting 1Password auto-login if login form is visible
        (attempt) => showStatus(t('workflowStatusDetecting', [provider.name, attempt])),
        iframeId
      )
    : { success: false };

  if (!result.success) {
    // Check if a login form is present or try 1Password auto-login
    const autoLogged = await attemptProvider1PasswordLogin(targetTab.id, provider, { manual: false });
    if (autoLogged.ready) {
      result = { success: true };
    } else if (autoLogged.needsCode) {
      await handOverVerificationStep(targetTab.id, provider, iframeId);
      await saveState();
      return;
    } else if (autoLogged.blocked) {
      // Sign-in page is not the provider's own domain: keep the refusal on screen and let
      // the user sign in by hand (or skip) instead of overwriting it with progress messages.
      lastProviderError = autoLogged.error;
      showButtons(true, false, false, true, false, false, true);
      startLoginPolling(targetTab.id, provider, iframeId);
      await saveState();
      return;
    } else if (!autoLogged.attempted) {
      if (provider.iframe?.urlPattern && iframeId == null) {
        iframeId = await findIframeIdWithRetry(targetTab.id, provider.iframe.urlPattern, 10000);
      }
      if (!provider.iframe?.urlPattern || iframeId != null) {
        // No login form / no 1Password match: finish remaining wait for slow-loading billing pages
        result = await waitForSelector(
          targetTab.id,
          provider.readySelector,
          20,
          (attempt) => showStatus(t('workflowStatusDetecting', [provider.name, attempt + 8])),
          iframeId
        );
      }
    }
  }

  if (result.success) {
    // Org/account verification lives inside executeDownload — every download path
    // (auto, login polling, manual "Ready", retry) must go through the same guard.
    // Page loaded with billing data visible — auto-download
    showStatus(t('workflowStatusLoadedStarting', [provider.name]));
    showButtons(false, true, false, false, true);
    await executeDownload(targetTab.id, provider);
  } else {
    // readySelector not found — probably needs login or wrong page
    // Show manual button as fallback, but keep polling in background
    lastProviderError = t('workflowErrorLoginRequired');
    showStatus(t('workflowStatusLoginPrompt', [provider.name]));
    showButtons(true, false, false, true, false, false, true);
    startLoginPolling(targetTab.id, provider, iframeId);
  }

  await saveState();
}

async function getProviderSessionOwner(providerId) {
  try {
    const res = await chrome.storage.local.get('providerSessionOwners');
    return res?.providerSessionOwners?.[providerId] || null;
  } catch {
    return null;
  }
}

async function setProviderSessionOwner(providerId, creds = {}) {
  try {
    const res = await chrome.storage.local.get('providerSessionOwners');
    const owners = res?.providerSessionOwners && typeof res.providerSessionOwners === 'object'
      ? { ...res.providerSessionOwners }
      : {};
    const activeProfileName = profiles.find(p => p.id === loadedProfileId)?.name || '';
    owners[providerId] = {
      profileId: loadedProfileId || '',
      profileName: activeProfileName,
      itemId: String(creds.itemId || ''),
      username: String(creds.username || '').trim().toLowerCase(),
      updatedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ providerSessionOwners: owners });
  } catch {}
}

async function clearProviderSessionOwner(providerId) {
  try {
    const res = await chrome.storage.local.get('providerSessionOwners');
    if (res?.providerSessionOwners?.[providerId]) {
      const owners = { ...res.providerSessionOwners };
      delete owners[providerId];
      await chrome.storage.local.set({ providerSessionOwners: owners });
    }
  } catch {}
}

function getRootDomain(urlOrHost) {
  try {
    const hostname = new URL(urlOrHost).hostname.toLowerCase();
    const parts = hostname.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
  } catch {
    return '';
  }
}

async function purgeDomainCookies(urls = []) {
  if (!chrome.cookies?.getAll || !chrome.cookies?.remove) return 0;
  const rootDomains = new Set(urls.map(getRootDomain).filter(Boolean));
  if (rootDomains.size === 0) return 0;

  let removed = 0;
  try {
    const allCookies = await chrome.cookies.getAll({});
    for (const c of allCookies || []) {
      const cDom = String(c.domain || '').replace(/^\./, '').toLowerCase();
      const matches = [...rootDomains].some(rd => cDom === rd || cDom.endsWith(`.${rd}`));
      if (!matches) continue;
      const protocol = c.secure ? 'https:' : 'http:';
      const cookieUrl = `${protocol}//${cDom}${c.path || '/'}`;
      try {
        await chrome.cookies.remove({
          url: cookieUrl,
          name: c.name,
          storeId: c.storeId,
        });
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

async function performProviderLogout(tabId, provider, creds = null) {
  showStatus(t('workflowStatusLoggingOut', [provider.name]));

  // 1. Optional declarative UI logout steps
  if (provider.auth?.logoutSteps?.length) {
    try {
      await injectEngine(tabId);
      for (const step of provider.auth.logoutSteps) {
        await callEngine(tabId, 'executeStep', [step]);
      }
    } catch {}
  }

  // 2. Clear in-page localStorage, sessionStorage, non-HttpOnly cookies, and indexedDB
  try {
    await injectEngine(tabId);
    await callEngine(tabId, 'clearPageSessionData', []);
  } catch {}
  if (provider.iframe?.urlPattern) {
    try {
      const ifrId = await findIframeId(tabId, provider.iframe.urlPattern);
      if (ifrId != null) {
        await injectEngine(tabId, ifrId);
        await callEngine(tabId, 'clearPageSessionData', [], ifrId);
      }
    } catch {}
  }

  // 3. Purge browser cookies across the provider's billing domain, current tab domain, and 1Password item URLs
  const urlsToPurge = [resolveBillingUrl(provider), ...(creds?.urls || [])];
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) urlsToPurge.push(tab.url);
  } catch {}
  if (provider.auth?.logoutUrl) {
    urlsToPurge.push(resolveConfigTemplate(provider.auth.logoutUrl, provider));
  }
  await purgeDomainCookies(urlsToPurge);
  await clearProviderSessionOwner(provider.id);

  // 4. Optional logout URL navigation
  if (provider.auth?.logoutUrl) {
    const logoutUrl = resolveConfigTemplate(provider.auth.logoutUrl, provider);
    try {
      await chrome.tabs.update(tabId, { url: logoutUrl });
      await waitForTabReady(tabId, null, null, 8000);
      await purgeDomainCookies(urlsToPurge);
    } catch {}
  }

  // 5. Navigate back to billing URL so the clean login screen loads.
  // Force a reload if the tab is already on the same document with a hash (e.g. Holded /home#settings:...).
  const billingUrl = resolveBillingUrl(provider);
  let beforeUrl = '';
  try {
    const t = await chrome.tabs.get(tabId);
    beforeUrl = t?.url || '';
  } catch {}
  const needsReload = isSameDocumentHashNavigation(beforeUrl, billingUrl) || beforeUrl === billingUrl;
  await chrome.tabs.update(tabId, { url: billingUrl });
  if (needsReload) {
    try { await chrome.tabs.reload(tabId); } catch {}
  }
  await waitForTabReady(tabId, null, null, 10000);
}

async function attemptProvider1PasswordLogin(
  tabId,
  provider,
  { manual = false, preResolvedCreds = null } = {}
) {
  try {
    let detection = null;
    const maxFormPolls = manual ? 15 : 4;
    for (let poll = 0; poll < maxFormPolls; poll++) {
      try {
        await injectEngine(tabId);
        detection = await callEngine(tabId, 'detectLoginForm', [provider.auth || {}]);
        if (detection?.hasLoginForm) break;
      } catch {}
      if (poll < maxFormPolls - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
    if (!manual && !detection?.hasLoginForm) {
      return { attempted: false, ready: false };
    }

    let creds = preResolvedCreds;
    if (!creds) {
      showStatus(t('workflowStatusFetchingCreds', [provider.name]));
      const liveProviderConfig = providerConfigs[provider.id] || {};
      const itemOverride = liveProviderConfig._onepasswordItem || '';
      const activeProfileName = profiles.find(p => p.id === loadedProfileId)?.name || '';
      const response = await callOnePassword('resolveProvider', {
        provider,
        billingUrl: resolveBillingUrl(provider),
        itemOverride,
        profileName: activeProfileName,
        providerConfig: liveProviderConfig,
      });

      if (!response?.ok || !response.data) {
        if (manual) {
          showStatus(t('workflowStatusProviderMessage', [provider.name, response?.error || t('workflowOpCredsNotFound')]));
        }
        return { attempted: false, ready: false, error: response?.error };
      }
      creds = response.data;
    }

    showStatus(t('workflowStatusSigningIn', [provider.name, creds.title || provider.name]));
    let loginTabBefore;
    try { loginTabBefore = await chrome.tabs.get(tabId); } catch {}
    const loginStartUrl = loginTabBefore?.url || '';

    await injectEngine(tabId);
    const loginRes = await callEngineForLogin(tabId, creds, provider.auth || {});
    if (loginRes?.blocked) {
      // Always shown, also on the automatic path: the user must know why nothing was filled.
      const message = loginBlockedMessage(loginRes, provider);
      showStatus(message);
      return { attempted: false, ready: false, blocked: true, error: message };
    }
    if (!loginRes?.attempted) {
      if (manual) {
        showStatus(t('workflowStatusProviderMessage', [provider.name, loginRes?.reason || t('workflowNoLoginFields')]));
      }
      return { attempted: false, ready: false, error: loginRes?.reason };
    }

    await setProviderSessionOwner(provider.id, creds);

    // Wait for post-login redirect/navigation (e.g. Holded /login -> /home)
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const curTab = await chrome.tabs.get(tabId);
        if (curTab?.status === 'complete' && curTab.url && curTab.url !== loginStartUrl) {
          break;
        }
      } catch {}
    }
    await waitForTabLoad(tabId, 8000);

    // Still on the sign-in address but the form is gone: the provider is asking for a step
    // we can't do (a code sent by email, a captcha, picking an account). Navigating to the
    // billing page now would throw that screen away, so hand it over to the user.
    if (await awaitingVerificationStep(tabId, provider, loginStartUrl, creds)) {
      return { attempted: true, ready: false, needsCode: true, creds };
    }

    // If login redirected to a general dashboard (e.g. Holded /home) instead of billingUrl
    // (/home#settings:/subscription/invoices), navigate immediately and reload if hash-only.
    const billingUrl = resolveBillingUrl(provider);
    let postLoginTab;
    try { postLoginTab = await chrome.tabs.get(tabId); } catch {}

    if (postLoginTab?.url && !sameBillingLocation(postLoginTab.url, billingUrl)) {
      const needsHashReload = isSameDocumentHashNavigation(postLoginTab.url, billingUrl);
      await chrome.tabs.update(tabId, { url: billingUrl });
      if (needsHashReload) {
        try { await chrome.tabs.reload(tabId); } catch {}
      }
      await waitForTabReady(tabId, null, null, 10000);
    }

    const iframeId = provider.iframe?.urlPattern
      ? await findIframeIdWithRetry(tabId, provider.iframe.urlPattern, 12000)
      : null;

    let readyRes = await waitForSelector(
      tabId,
      provider.readySelector,
      15,
      (attempt) => showStatus(t('workflowStatusVerifying', [provider.name, attempt])),
      iframeId
    );

    if (!readyRes.success) {
      let curTab;
      try { curTab = await chrome.tabs.get(tabId); } catch {}
      if (curTab?.url && !sameBillingLocation(curTab.url, billingUrl)) {
        const needsHashReload = isSameDocumentHashNavigation(curTab.url, billingUrl);
        await chrome.tabs.update(tabId, { url: billingUrl });
        if (needsHashReload) {
          try { await chrome.tabs.reload(tabId); } catch {}
        }
        await waitForTabReady(tabId, null, null, 10000);
        const refreshedIframeId = provider.iframe?.urlPattern
          ? await findIframeIdWithRetry(tabId, provider.iframe.urlPattern, 10000)
          : null;
        readyRes = await waitForSelector(
          tabId,
          provider.readySelector,
          15,
          (attempt) => showStatus(t('workflowStatusLoadingBilling', [provider.name, attempt])),
          refreshedIframeId
        );
      }
    }

    return { attempted: true, ready: readyRes.success, creds };
  } catch (err) {
    if (manual) {
      showStatus(t('workflowStatusOpSignInFailed', [provider.name, err.message]));
    }
    return { attempted: false, ready: false, error: err.message };
  }
}

async function awaitingVerificationStep(tabId, provider, loginStartUrl, creds) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return false; }
  const url = tab?.url || '';
  if (!url || sameBillingLocation(url, resolveBillingUrl(provider))) return false;
  let form;
  try {
    await injectEngine(tabId);
    form = await callEngine(tabId, 'detectLoginForm', [provider.auth || {}]);
  } catch { return false; }
  // A code field is a verification step wherever it lives (/login, /login/verify, ...).
  if (form?.hasOtp) return !creds?.otp;
  // Without one, only a form that vanished while staying on the sign-in address counts.
  return url === loginStartUrl && !form?.hasUsername && !form?.hasPassword;
}

// The provider is waiting for a code the user has to type. Keep the tab where it is and,
// once the sign-in page is left behind, take the user to the billing page ourselves.
async function handOverVerificationStep(tabId, provider, iframeId = null) {
  let signInUrl = null;
  try { signInUrl = (await chrome.tabs.get(tabId))?.url || null; } catch {}
  lastProviderError = t('workflowErrorCodeNeeded', [provider.name]);
  showStatus(t('workflowStatusCodeNeeded', [provider.name]));
  showButtons(true, false, false, true, false, false, true);
  // Already past the password: signing in again would only send another code.
  setHidden('btn-1password-login', true);
  setHidden('btn-switch-account', true);
  setHidden('login-steps', true);
  startLoginPolling(tabId, provider, iframeId, { reopenBillingAfterSignIn: true, signInUrl });
}

async function signInWith1Password() {
  stopLoginPolling();
  const provider = workflowProviders[state.currentIndex];
  if (!provider) return;

  let targetTab = currentProviderTabId ? await chrome.tabs.get(currentProviderTabId).catch(() => null) : null;
  if (!targetTab) {
    targetTab = await findProviderTab(provider.id, resolveBillingUrl(provider)) || await findProviderTab(provider.id);
  }
  if (!targetTab) {
    targetTab = await createTabInBrowser(resolveBillingUrl(provider));
    await waitForTabReady(targetTab.id);
  }
  currentProviderTabId = targetTab.id;

  showButtons(false, false, false, true);
  const res = await attemptProvider1PasswordLogin(targetTab.id, provider, { manual: true });
  if (res.needsCode) {
    await handOverVerificationStep(targetTab.id, provider);
  } else if (res.ready) {
    showStatus(t('workflowStatusSignedIn', [provider.name]));
    showButtons(false, true, false, false, true);
    await executeDownload(targetTab.id, provider);
  } else {
    const iframeId = provider.iframe?.urlPattern ? await findIframeId(targetTab.id, provider.iframe.urlPattern) : null;
    showButtons(true, false, false, true, false, false, true);
    startLoginPolling(targetTab.id, provider, iframeId);
  }
}

async function switchAccountWith1Password() {
  stopLoginPolling();
  const provider = workflowProviders[state.currentIndex];
  if (!provider) return;

  let targetTab = currentProviderTabId ? await chrome.tabs.get(currentProviderTabId).catch(() => null) : null;
  if (!targetTab) {
    targetTab = await findProviderTab(provider.id, resolveBillingUrl(provider)) || await findProviderTab(provider.id);
  }
  if (!targetTab) {
    targetTab = await createTabInBrowser(resolveBillingUrl(provider));
    await waitForTabReady(targetTab.id);
  }
  currentProviderTabId = targetTab.id;

  showButtons(false, false, false, true);
  await performProviderLogout(targetTab.id, provider);
  const res = await attemptProvider1PasswordLogin(targetTab.id, provider, { manual: true });
  if (res.needsCode) {
    await handOverVerificationStep(targetTab.id, provider);
  } else if (res.ready) {
    showStatus(t('workflowStatusSwitched', [provider.name]));
    showButtons(false, true, false, false, true);
    await executeDownload(targetTab.id, provider, { _afterAccountSwitch: true });
  } else {
    const iframeId = provider.iframe?.urlPattern ? await findIframeId(targetTab.id, provider.iframe.urlPattern) : null;
    showButtons(true, false, false, true, false, false, true);
    startLoginPolling(targetTab.id, provider, iframeId);
  }
}

// Poll for readySelector after showing login prompt — auto-continue when user logs in
let loginPollInterval = null;

function stopLoginPolling() {
  if (loginPollInterval) {
    clearInterval(loginPollInterval);
    loginPollInterval = null;
  }
}

function startLoginPolling(tabId, provider, iframeId, { reopenBillingAfterSignIn = false, signInUrl = null } = {}) {
  stopLoginPolling(); // Clear any previous polling
  let reopenedBilling = false;

  loginPollInterval = setInterval(async () => {
    // Stop if we moved to a different provider or workflow ended
    if (!state.isRunning || workflowProviders[state.currentIndex]?.id !== provider.id) {
      stopLoginPolling();
      return;
    }

    try {
      const frameId = iframeId != null ? iframeId :
        (provider.iframe?.urlPattern ? await findIframeId(tabId, provider.iframe.urlPattern) : null);

      if (await selectorExists(tabId, provider.readySelector, frameId)) {
        // readySelector found — user logged in, auto-continue
        stopLoginPolling();
        showStatus(t('workflowStatusDetected', [provider.name]));
        showButtons(false, true, false, false, true);
        await executeDownload(tabId, provider);
        await saveState();
      } else if (reopenBillingAfterSignIn && !reopenedBilling) {
        // After a verification step the provider lands on its own dashboard, not on billing.
        const tab = await chrome.tabs.get(tabId);
        const url = tab?.url || '';
        const billingUrl = resolveBillingUrl(provider);
        if (tab?.status === 'complete' && url && url !== signInUrl && !sameBillingLocation(url, billingUrl)) {
          await injectEngine(tabId);
          const form = await callEngine(tabId, 'detectLoginForm', [provider.auth || {}]);
          if (!form?.hasLoginForm) {
            reopenedBilling = true;
            showStatus(t('workflowStatusLoadingBilling', [provider.name, 1]));
            await chrome.tabs.update(tabId, { url: billingUrl });
            if (isSameDocumentHashNavigation(url, billingUrl)) await chrome.tabs.reload(tabId);
          }
        }
      }
    } catch (e) {
      // Tab may have navigated or closed — ignore and keep polling
    }
  }, 2000);
}

// Invoices that dropped into the feed during this popup session (completion headline).
let runInvoiceCount = 0;

function addToDownloadFeed(provider, invoice) {
  const feed = document.getElementById('download-feed');
  if (!feed) return;
  runInvoiceCount++;
  setHidden('download-feed-title', false);
  const label = invoice.filename || invoice.date || provider.name;
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'download-feed-item';
  item.setAttribute('aria-label', t('commonShowFileInFolder', [label]));
  item.innerHTML = `
    <span class="feed-check">${icon('fileCheck', 14)}</span>
    ${logoImgHtml(provider.id, provider.name, 'feed-logo')}
    <span class="feed-name">${escapeHtml(label)}</span>
    ${invoice.amount ? `<span class="feed-amount">${escapeHtml(invoice.amount)}</span>` : ''}
  `;
  wireLogoFallbacks(item);
  // Click to open file — resolve downloadId async
  item.addEventListener('click', async () => {
    // Search for this file in recent downloads
    if (invoice.filename) {
      try {
        const results = await chrome.downloads.search({
          filenameRegex: escapeRegex(invoice.filename),
          limit: 1,
          orderBy: ['-startTime']
        });
        if (results.length > 0 && results[0].id) {
          await chrome.downloads.show(results[0].id);
          return;
        }
      } catch (e) {}
    }
    // Fallback: open downloads folder
    try { await chrome.downloads.showDefaultFolder(); } catch (e) {}
  });
  feed.prepend(item);
  // Keep max 20 items
  while (feed.children.length > 20) feed.removeChild(feed.lastChild);
}

function clearDownloadFeed() {
  const feed = document.getElementById('download-feed');
  if (feed) feed.innerHTML = '';
  setHidden('download-feed-title', true);
  runInvoiceCount = 0;
  _filedKeys = null;
}

// Download ID capture — collect chrome download IDs during engine/popup downloads
let _capturedDownloadIds = [];
let _downloadCaptureListener = null;

function startCapturingDownloads() {
  _capturedDownloadIds = [];
  if (_downloadCaptureListener) chrome.downloads.onCreated.removeListener(_downloadCaptureListener);
  _downloadCaptureListener = (item) => { _capturedDownloadIds.push(item.id); };
  chrome.downloads.onCreated.addListener(_downloadCaptureListener);
}

function stopCapturingDownloads() {
  if (_downloadCaptureListener) {
    chrome.downloads.onCreated.removeListener(_downloadCaptureListener);
    _downloadCaptureListener = null;
  }
  return [..._capturedDownloadIds];
}

// Turn a stored config entry into something a human recognises: everything the user typed
// around the identifier (a company name), or the bare identifier when they typed nothing.
function describeConfigEntry(entry, token) {
  const label = entry
    .replace(/https?:\/\/\S+/gi, ' ')  // pasted URL
    .replace(new RegExp(token, 'ig'), ' ')
    .replace(/[|\-–—:,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return label || token;
}

// Read the org/account identity from the page and compare it to the configured value.
// Returns { ok, expected, found }. Storage-backed ID checks fail closed when unreadable;
// legacy DOM checks retain their existing behavior when the page cannot be read.
async function verifyOrg(tabId, provider) {
  const field = provider.orgCheck?.configField;
  if (!field || !provider.config?.[field]) return { ok: true };

  const expected = configValue(provider, field).trim();
  if (!expected) return { ok: true };

  const storage = provider.orgCheck.storage;
  const useStorage = storage && new RegExp(storage.configPattern).test(expected);

  let found;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, storageKey) => {
        if (storageKey) {
          const raw = localStorage.getItem(storageKey);
          if (!raw) return '';
          let value;
          try { value = JSON.parse(raw); } catch { value = raw; }
          return typeof value === 'string' ? value.trim() : '';
        }
        if (sel === 'location.hostname') return location.hostname.toLowerCase();
        if (sel === 'location.href') return location.href.toLowerCase();
        const els = Array.from(document.querySelectorAll(sel));
        return els.map(el => {
          const text = (el.value || el.textContent || '').trim();
          // Elements with no text (avatars, logos, links) still identify the account
          // through their raw src/href — read the attribute, not the resolved URL.
          return (text || el.getAttribute('src') || el.getAttribute('href') || '').trim().toLowerCase();
        }).filter(Boolean).join(' ');
      },
      args: [provider.orgCheck.selector, useStorage ? storage.key : null],
      world: 'MAIN'
    });
    found = results[0]?.result;
  } catch (e) {
    return useStorage ? { ok: false, expected, found: t('workflowAccountIdUnavailable') } : { ok: true };
  }

  if (useStorage) {
    return { ok: found === expected, expected, found: found || t('workflowAccountIdUnavailable') };
  }

  if (!found) return { ok: true };

  // Optional regex: pull the identifying token out of both sides so the user can paste a
  // whole URL (e.g. a copied avatar image address) instead of a bare id. Opaque ids are
  // then translated back to the label the user typed alongside them.
  const re = provider.orgCheck.extract ? new RegExp(provider.orgCheck.extract, 'i') : null;
  if (re) {
    const want = expected.match(re)?.[0]?.toLowerCase();
    const got = found.match(re)?.[0]?.toLowerCase();
    if (want && got) {
      const labels = new Map();
      for (const entry of configValues(provider, field)) {
        const token = entry.match(re)?.[0]?.toLowerCase();
        if (token) labels.set(token, describeConfigEntry(entry, token));
      }
      return {
        ok: want === got,
        expected: labels.get(want) || want,
        found: labels.get(got) || got
      };
    }
  }

  return { ok: found.includes(expected.toLowerCase()), expected, found };
}

async function ensureCorrectProviderAccount(tabId, provider, { orgOk = true } = {}) {
  const stepKey = workflowKey(provider);
  if (_switchedProviderKeys.has(stepKey)) {
    return { switched: false };
  }

  const liveProviderConfig = providerConfigs[provider.id] || {};
  const itemOverride = liveProviderConfig._onepasswordItem || '';
  const activeProfileName = profiles.find(p => p.id === loadedProfileId)?.name || '';
  const previousOwner = await getProviderSessionOwner(provider.id);

  const has1PasswordContext = Boolean(
    loadedProfileId ||
    itemOverride ||
    provider.auth?.item ||
    provider.auth?.usernameRef ||
    previousOwner
  );
  if (!has1PasswordContext) {
    return { switched: false };
  }

  let creds = null;
  try {
    const response = await callOnePassword('resolveProvider', {
      provider,
      billingUrl: resolveBillingUrl(provider),
      itemOverride,
      profileName: activeProfileName,
      providerConfig: liveProviderConfig,
    });
    if (response?.ok && response.data) {
      creds = response.data;
    }
  } catch {}

  if (!creds) {
    return { switched: false };
  }

  const expectedUser = String(creds.username || '').trim().toLowerCase();
  const expectedItemId = String(creds.itemId || '');

  const ownerProfileMismatch = Boolean(
    previousOwner &&
    loadedProfileId &&
    previousOwner.profileId &&
    previousOwner.profileId !== loadedProfileId
  );
  const ownerItemMismatch = Boolean(
    previousOwner &&
    expectedItemId &&
    previousOwner.itemId &&
    previousOwner.itemId !== expectedItemId
  );
  const ownerUserMismatch = Boolean(
    previousOwner &&
    expectedUser &&
    previousOwner.username &&
    previousOwner.username !== expectedUser
  );

  let domMismatch = false;
  try {
    await injectEngine(tabId);
    const identityRes = await callEngine(tabId, 'verifyLoggedInIdentity', [
      {
        username: expectedUser,
        previousUsername: previousOwner?.username || '',
      },
      provider.auth || {},
    ]);
    domMismatch = Boolean(identityRes?.mismatchDetected);
  } catch {}

  const alreadySignedInWithExpectedCreds = Boolean(
    previousOwner &&
    !ownerProfileMismatch &&
    !ownerItemMismatch &&
    !ownerUserMismatch &&
    !domMismatch &&
    ((expectedItemId && previousOwner.itemId === expectedItemId) ||
      (expectedUser && previousOwner.username === expectedUser))
  );

  const shouldSwitch =
    ownerProfileMismatch ||
    ownerItemMismatch ||
    ownerUserMismatch ||
    domMismatch ||
    (!orgOk && !alreadySignedInWithExpectedCreds);

  if (!shouldSwitch) {
    await setProviderSessionOwner(provider.id, creds);
    return { switched: false };
  }

  _switchedProviderKeys.add(stepKey);
  showStatus(
    t('workflowStatusWrongAccountSwitching', [provider.name, creds.title || activeProfileName || expectedUser])
  );
  await performProviderLogout(tabId, provider, creds);
  const loginRes = await attemptProvider1PasswordLogin(tabId, provider, {
    manual: true,
    preResolvedCreds: creds,
  });
  return { switched: true, ready: Boolean(loginRes?.ready), needsCode: Boolean(loginRes?.needsCode) };
}

async function executeDownload(tabId, provider, { skipDedup = false, _afterAccountSwitch = false } = {}) {
  try {
    lastProviderError = null;

    // Hard guard: never download from the wrong org/account. Applies to every entry
    // point (auto, login polling, manual "Ready", retry).
    const org = await verifyOrg(tabId, provider);

    if (!_afterAccountSwitch && !_switchedProviderKeys.has(workflowKey(provider))) {
      const switchRes = await ensureCorrectProviderAccount(tabId, provider, { orgOk: org.ok });
      if (switchRes.switched) {
        if (switchRes.ready) {
          return await executeDownload(tabId, provider, { skipDedup, _afterAccountSwitch: true });
        }
        if (switchRes.needsCode) {
          await handOverVerificationStep(tabId, provider);
          return;
        }
        const iframeId = provider.iframe?.urlPattern ? await findIframeId(tabId, provider.iframe.urlPattern) : null;
        lastProviderError = t('workflowErrorSwitchNeedsLogin');
        showButtons(true, false, false, true, false, false, true);
        startLoginPolling(tabId, provider, iframeId);
        return;
      }
    }

    if (!org.ok) {
      lastProviderError = t('workflowErrorWrongAccount', [org.expected, org.found]);
      showStatus(t('workflowStatusWrongAccount', [provider.name, org.expected, org.found]));
      showButtons(true, false, false, true, false, false, true);
      // Keep watching: when the user switches account the poll retries this guard.
      startLoginPolling(tabId, provider);
      return;
    }

    showStatus(t('workflowStatusScanning', [provider.name]));

    // Provider-level skipDedup overrides the parameter
    if (provider.skipDedup) skipDedup = true;

    // Build dedup set from prior downloads of this provider, unless caller opted out.
    // For click-download providers, downloadUrl is absent — fall back to the dedup
    // field value (same key the engine uses to compute effectiveUrl).
    // providerName fallback covers legacy entries saved before providerId was persisted.
    let previousDownloads = [];
    if (!skipDedup) {
      const history = await loadDownloadHistory();
      const dedupField = provider.extract.dedup;
      const matchesProvider = h =>
        h.providerId === provider.id ||
        (!h.providerId && h.providerName === provider.name);
      previousDownloads = history
        .filter(matchesProvider)
        .map(h => h.downloadUrl || (dedupField ? h[dedupField] : null))
        .filter(Boolean);
    }

    // Start capturing download IDs
    startCapturingDownloads();

    // 1. Find iframe (with retry) and inject engine
    let frameId = null;
    if (provider.iframe?.urlPattern) {
      frameId = await findIframeIdWithRetry(tabId, provider.iframe.urlPattern, 15000);
      if (frameId == null) {
        console.warn(`Iframe matching "${provider.iframe.urlPattern}" not found, falling back to main frame`);
      }
    }
    await injectEngine(tabId, frameId);

    // 2. Run preSteps (always from popup to handle iframe frame detachment)
    if (provider.extract.preSteps?.length) {
      frameId = await runPreSteps(tabId, provider, frameId) || frameId;
      // Always re-find frame after preSteps (with retry — frame may still be loading)
      if (provider.iframe?.urlPattern) {
        const newFrameId = await findIframeIdWithRetry(tabId, provider.iframe.urlPattern, 10000);
        if (newFrameId != null) {
          frameId = newFrameId;
          await injectEngine(tabId, frameId);
        }
      }
    }

    // 3. Extract and download — for click-download + pagination, must download per-page
    //    because row indices become invalid after navigating to the next page.
    const isClickDownload = provider.download.method === 'click-download';
    const pagination = provider.extract.pagination;
    const paginationState = { seen: [], previousDownloads };
    let allInvoices = [];
    let downloadedInvoices = [];
    let dlSuccess = 0;
    let dlErrors = [];
    let result;

    // Helper: download a batch of invoices from the current page
    async function downloadPageInvoices(invoices, currentFrameId) {
      for (const inv of invoices) {
        const idx = allInvoices.length + dlSuccess + dlErrors.length;
        showStatus(t('workflowStatusDownloadingN', [provider.name, idx + 1]));
        try {
          const dlResult = await downloadInvoice(tabId, inv, provider, currentFrameId);
          if (dlResult.success) {
            dlSuccess++;
            downloadedInvoices.push(inv);
            addToDownloadFeed(provider, inv);
          } else {
            dlErrors.push(t('workflowInvoiceError', [dlResult.error]));
          }
        } catch (e) {
          dlErrors.push(t('workflowInvoiceError', [e.message]));
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Extract first page
    result = await extractInvoices(tabId, provider, frameId, paginationState);
    let pageInvoices = result?.invoices || [];
    paginationState.seen = result?.seen || [];

    // For click-download: download this page's invoices NOW (before pagination changes DOM)
    if (isClickDownload && pageInvoices.length > 0) {
      await downloadPageInvoices(pageInvoices, frameId);
    } else {
      allInvoices.push(...pageInvoices);
    }

    // 4. Handle pagination
    if (pagination?.type === 'select' && !result?.stoppedByDate && pageInvoices.length > 0) {
      const pagOptions = await callEngine(tabId, 'getPaginationOptions', [pagination], frameId);
      let currentIndex = pagOptions?.activeIndex || 0;
      const maxInvoices = state.maxInvoices || DEFAULT_MAX_INVOICES;

      while ((allInvoices.length + dlSuccess) < maxInvoices && currentIndex + 1 < (pagOptions?.options?.length || 0)) {
        currentIndex++;
        await callEngine(tabId, 'selectPaginationOption', [pagination, currentIndex], frameId);
        const pageResult = await extractInvoices(tabId, provider, frameId, paginationState);
        if (!pageResult?.invoices?.length || pageResult.stoppedByDate) break;
        paginationState.seen = pageResult.seen || paginationState.seen;

        if (isClickDownload) {
          await downloadPageInvoices(pageResult.invoices, frameId);
        } else {
          allInvoices.push(...pageResult.invoices);
        }
      }
    } else if (pagination?.type === 'click-next' && !result?.stoppedByDate && pageInvoices.length > 0) {
      let pageNum = 1;
      const maxInvoices = state.maxInvoices || DEFAULT_MAX_INVOICES;

      while ((allInvoices.length + dlSuccess) < maxInvoices) {
        const nextResult = await callEngine(tabId, 'clickNext', [pagination], frameId);
        if (!nextResult?.clicked) break;

        pageNum++;
        showStatus(t('workflowStatusPageScanning', [provider.name, pageNum]));

        const pageResult = await extractInvoices(tabId, provider, frameId, paginationState);
        if (!pageResult?.invoices?.length || pageResult.stoppedByDate) break;
        paginationState.seen = pageResult.seen || paginationState.seen;

        if (isClickDownload) {
          await downloadPageInvoices(pageResult.invoices, frameId);
        } else {
          allInvoices.push(...pageResult.invoices);
        }
      }
    } else if (pagination?.type === 'url-page' && pageInvoices.length > 0) {
      let pageNum = 1;
      const maxInvoices = state.maxInvoices || DEFAULT_MAX_INVOICES;

      while ((allInvoices.length + dlSuccess) < maxInvoices) {
        const nextEl = await callEngine(tabId, 'queryElement', [pagination.nextSelector, { attrs: ['href'], resolveUrls: true }]);
        const nextUrl = nextEl?.found ? nextEl.attrs?.href : null;
        if (!nextUrl) break;

        pageNum++;
        showStatus(t('workflowStatusPageLoading', [provider.name, pageNum]));
        await chrome.tabs.update(tabId, { url: nextUrl });
        await new Promise(r => setTimeout(r, pagination.wait || 3000));

        const ifrId = provider.iframe?.urlPattern ? await findIframeId(tabId, provider.iframe.urlPattern) : null;
        await waitForSelector(tabId, provider.readySelector, 30, null, ifrId);

        await injectEngine(tabId, ifrId);
        if (provider.extract.preSteps?.length) {
          await runPreSteps(tabId, provider, ifrId);
          if (provider.iframe?.urlPattern) {
            const newFid = await findIframeId(tabId, provider.iframe.urlPattern);
            if (newFid != null) await injectEngine(tabId, newFid);
          }
        }

        showStatus(t('workflowStatusPageScanning', [provider.name, pageNum]));
        const pageResult = await extractInvoices(tabId, provider, ifrId, paginationState);
        if (!pageResult?.invoices?.length || pageResult.stoppedByDate) break;
        paginationState.seen = pageResult.seen || paginationState.seen;

        if (isClickDownload) {
          await downloadPageInvoices(pageResult.invoices, ifrId);
        } else {
          allInvoices.push(...pageResult.invoices);
        }
      }
    }

    // 5. Check if we have anything to download
    // For click-download, dlSuccess already has the count; allInvoices has non-click-download invoices
    const totalInvoices = allInvoices.length + dlSuccess + dlErrors.length;

    if (totalInvoices === 0) {
      stopCapturingDownloads();

      let skipReason;
      let showRetry = false;
      if (result?.rowsFound === 0) {
        skipReason = t('workflowSkipNoInvoices');
      } else if (result?.rowsFilteredByDate > 0 && result?.rowsDeduped === 0) {
        const since = state.sinceDate
          ? new Date(`${state.sinceDate}T00:00:00`).toLocaleDateString(uiLanguage())
          : t('workflowDateFilter');
        skipReason = t('workflowSkipAllBeforeDate', [result.rowsFound, since]);
      } else if (result?.rowsDeduped > 0) {
        skipReason = t('workflowSkipAllDownloaded');
        showRetry = true;
      } else {
        skipReason = t('workflowSkipNoMatch');
      }

      showStatus(t('workflowStatusProviderMessage', [provider.name, skipReason.toLowerCase()]));
      addToSkipped(workflowKey(provider), skipReason);
      showButtons(false, false, true, false, false, showRetry);
      updateProgress();
      updateSitesList();
      if (!showRetry) {
        await new Promise(r => setTimeout(r, 1500));
        await processNextSite();
      }
      return;
    }

    addToCompleted(workflowKey(provider));
    await saveState();

    // 6. Download remaining non-click-download invoices (click-download already done per-page)
    if (allInvoices.length > 0) {
      showStatus(tp('workflowStatusFound', allInvoices.length, [provider.name, allInvoices.length]));

      for (let i = 0; i < allInvoices.length; i++) {
        const inv = allInvoices[i];
        showStatus(t('workflowStatusDownloadingOf', [provider.name, i + 1, allInvoices.length]));

        try {
          const dlResult = await downloadInvoice(tabId, inv, provider, frameId);
          if (dlResult.success) {
            dlSuccess++;
            downloadedInvoices.push(inv);
            addToDownloadFeed(provider, inv);
          } else {
            dlErrors.push(t('workflowInvoiceErrorN', [i + 1, dlResult.error]));
          }
        } catch (e) {
          dlErrors.push(t('workflowInvoiceErrorN', [i + 1, e.message]));
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 7. Final status
    if (dlErrors.length > 0) {
      showStatus(t('workflowStatusPartial', [provider.name, dlSuccess, totalInvoices, dlErrors.length]));
    } else {
      showStatus(tp('workflowStatusDone', dlSuccess, [provider.name, dlSuccess]));
    }

    // Stop capturing and collect download IDs
    const capturedIds = stopCapturingDownloads();

    // Store successfully downloaded invoices (both click-download and direct/blob/chrome-download) in history
    if (downloadedInvoices.length > 0) {
      let capturedIdx = 0;
      const entries = downloadedInvoices.map(inv => {
        let downloadId = inv._downloadId || null;
        if (!downloadId && capturedIdx < capturedIds.length) {
          downloadId = capturedIds[capturedIdx++];
        }
        const { _downloadId, __rowIndex, ...rest } = inv;
        return {
          ...rest,
          providerId: provider.id,
          providerName: provider.name,
          providerIcon: provider.icon,
          downloadedAt: new Date().toISOString(),
          downloadId: downloadId
        };
      });
      await saveDownloadHistory(entries);
    }

    showButtons(false, false, true, false, false, false);
    updateProgress();
    updateSitesList();
    await new Promise(r => setTimeout(r, 2000));
    await processNextSite();
  } catch (error) {
    stopCapturingDownloads();
    lastProviderError = error.message;
    console.error('Error executing script:', error);
    showStatus(t('commonErrorPrefix', [error.message]));
    showButtons(true, false, false, true, false, true);
  }
}

async function gotoBillingPage() {
  const provider = workflowProviders[state.currentIndex];
  if (!provider) return;

  const billingUrl = resolveBillingUrl(provider);
  showStatus(t('workflowStatusNavigating', [provider.name]));
  showButtons(false, false, false, true);

  // Find existing provider tab or create one
  let targetTab = await findProviderTab(provider.id, billingUrl) || await findProviderTab(provider.id);

  if (targetTab) {
    const hashOnly = isHashOnlyChange(targetTab.url || '', billingUrl);
    await chrome.tabs.update(targetTab.id, { active: true, url: billingUrl });
    if (hashOnly) await chrome.tabs.reload(targetTab.id);
    await chrome.windows.update(targetTab.windowId, { focused: true });
  } else {
    targetTab = await createTabInBrowser(billingUrl);
  }
  refocusPopup();

  if (!targetTab) {
    showStatus(t('workflowStatusCouldNotOpen', [provider.name]));
    showButtons(true, false, false, true, false, false, true);
    return;
  }

  currentProviderTabId = targetTab.id;

  // Wait for tab to finish loading before polling readySelector
  showStatus(t('workflowStatusLoadingPage', [provider.name]));
  await waitForTabLoad(targetTab.id, 15000);
  await new Promise(r => setTimeout(r, 2000));

  // Wait for readySelector
  showStatus(t('workflowStatusWaitingData', [provider.name]));
  const result = await waitForSelector(
    targetTab.id,
    provider.readySelector,
    30,
    (attempt, max) => showStatus(t('workflowStatusDetecting', [provider.name, attempt])),
    provider.iframe?.urlPattern || null
  );

  if (result.success) {
    showStatus(t('workflowStatusLoadedStarting', [provider.name]));
    showButtons(false, true, false, false, true);
    await executeDownload(targetTab.id, provider);
  } else {
    showStatus(t('workflowStatusNotDetected', [provider.name]));
    showButtons(true, false, false, true, false, false, true);
  }
}

async function handleLoggedIn() {
  stopLoginPolling();
  const provider = workflowProviders[state.currentIndex];
  if (!provider) return;

  // Search ALL tabs for the provider's billing page
  let targetTab = await findProviderTab(provider.id, resolveBillingUrl(provider));

  if (!targetTab) {
    showStatus(t('workflowStatusNoTab', [provider.name]));
    const billingUrl = resolveBillingUrl(provider);
    await createTabInBrowser(billingUrl);
    showStatus(t('workflowStatusLogInReady', [provider.name]));
    showButtons(true, false, false, true);
    return;
  }

  // Focus and track the configured account's billing tab.
  currentProviderTabId = targetTab.id;
  await chrome.tabs.update(targetTab.id, { active: true });
  await chrome.windows.update(targetTab.windowId, { focused: true });
  refocusPopup();

  showStatus(t('workflowStatusWaitingLoad', [provider.name]));
  showButtons(false, false, false, false, false, false);

  const result = await waitForSelector(
    targetTab.id,
    provider.readySelector,
    60,
    (attempt, max) => showStatus(t('workflowStatusWaitingLoadProgress', [provider.name, attempt, max])),
    provider.iframe?.urlPattern || null
  );

  if (result.success) {
    showStatus(t('workflowStatusDownloadingFrom', [provider.name]));
    showButtons(false, true, false, false, true);
    await executeDownload(targetTab.id, provider);
  } else {
    showStatus(t('workflowStatusSelectorError', [result.error]));
    showButtons(true, false, false, true, false, true);
  }
}

async function retryDownload() {
  const provider = workflowProviders[state.currentIndex];
  if (!provider) return;

  // Search ALL tabs for the provider's billing page (not just the active one)
  let targetTab = await findProviderTab(provider.id, resolveBillingUrl(provider));

  if (!targetTab) {
    showStatus(t('workflowStatusNoTab', [provider.name]));
    const billingUrl = resolveBillingUrl(provider);
    await createTabInBrowser(billingUrl);
    showStatus(t('workflowStatusLogInRetry', [provider.name]));
    showButtons(false, false, false, true, false, true);
    return;
  }


  // Focus and track the configured account's billing tab.
  currentProviderTabId = targetTab.id;
  await chrome.tabs.update(targetTab.id, { active: true });
  await chrome.windows.update(targetTab.windowId, { focused: true });
  refocusPopup();

  showStatus(t('workflowStatusWaitingLoad', [provider.name]));
  showButtons(false, false, false, false, false, false);

  const result = await waitForSelector(
    targetTab.id,
    provider.readySelector,
    60,
    (attempt, max) => showStatus(t('workflowStatusWaitingLoadProgress', [provider.name, attempt, max])),
    provider.iframe?.urlPattern || null
  );

  if (result.success) {
    showStatus(t('workflowStatusRetrying', [provider.name]));
    showButtons(false, true, false, false, true);
    await executeDownload(targetTab.id, provider, { skipDedup: true });
  } else {
    showStatus(t('workflowStatusSelectorError', [result.error]));
    showButtons(false, false, false, true, false, true);
  }
}

async function stopAndNext() {
  stopLoginPolling();
  const provider = workflowProviders[state.currentIndex];
  if (provider && !state.completed.includes(workflowKey(provider))) {
    addToCompleted(workflowKey(provider));
  }
  state.currentIndex++;
  await saveState();
  await processCurrentSite();
}

async function skipCurrent() {
  stopLoginPolling();
  const provider = workflowProviders[state.currentIndex];
  if (provider) {
    const reason = lastProviderError
      ? t('commonErrorPrefix', [lastProviderError])
      : t('workflowSkippedByUser');
    addToSkipped(workflowKey(provider), reason);
    lastProviderError = null;
  }
  state.currentIndex++;
  await saveState();
  updateProgress();
  updateSitesList();
  await processCurrentSite();
}

async function processNextSite() {
  stopLoginPolling();
  state.currentIndex++;
  await saveState();
  await processCurrentSite();
}

// =====================================================
// HISTORY VIEW
// =====================================================
let historySort = { column: 'downloadedAt', asc: false };

const CURRENCY_CODES = { '€': 'EUR', '$': 'USD', '£': 'GBP' };

function formatAmountTotal(symbol, value) {
  const code = CURRENCY_CODES[symbol];
  if (code) {
    return new Intl.NumberFormat(uiLanguage(), { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).format(value);
  }
  return `${symbol}${new Intl.NumberFormat(uiLanguage(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

async function renderHistory(filterProviderId = null) {
  const history = await loadDownloadHistory();

  // Populate provider filter
  const select = document.getElementById('hist-filter-provider');
  const currentVal = select.value;
  const providerMap = new Map();
  for (const h of history) {
    if (!providerMap.has(h.providerId)) providerMap.set(h.providerId, h.providerName || h.providerId);
  }
  select.innerHTML = '';
  select.append(new Option(t('historyAllProviders'), ''));
  for (const [id, name] of providerMap) {
    select.append(new Option(name, id));
  }
  select.value = filterProviderId || currentVal || '';

  // Filter
  const provFilter = select.value;
  const fromFilter = document.getElementById('hist-filter-from').value;
  const toFilter = document.getElementById('hist-filter-to').value;
  let filtered = history.filter(e => {
    if (provFilter && e.providerId !== provFilter) return false;
    if (fromFilter && e.downloadedAt < fromFilter) return false;
    if (toFilter && e.downloadedAt > toFilter + 'T23:59:59') return false;
    return true;
  });

  // Stats
  document.getElementById('hist-stat-total').textContent = filtered.length;
  document.getElementById('hist-stat-providers').textContent = new Set(filtered.map(e => e.providerId)).size;
  // Parse amounts respecting European (comma decimal) and US (dot decimal) formats
  function parseAmount(raw) {
    if (!raw) return { value: NaN, currency: '' };
    const str = raw.trim();
    // Detect currency symbol
    let currency = '';
    if (str.includes('€')) currency = '€';
    else if (str.includes('$')) currency = '$';
    else if (str.includes('£')) currency = '£';
    // Strip currency symbols and whitespace
    let num = str.replace(/[€$£\s]/g, '');
    // Determine decimal separator:
    // "1.234,56" or "76,99" → comma is decimal (European)
    // "1,234.56" or "29.96" → dot is decimal (US)
    const lastComma = num.lastIndexOf(',');
    const lastDot = num.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Comma is the decimal separator (European): remove dots (thousands), replace comma with dot
      num = num.replace(/\./g, '').replace(',', '.');
    } else {
      // Dot is the decimal separator (US): remove commas (thousands)
      num = num.replace(/,/g, '');
    }
    return { value: parseFloat(num), currency };
  }

  // Group totals by currency
  const totals = {};
  for (const e of filtered) {
    const { value, currency } = parseAmount(e.amount);
    if (isNaN(value)) continue;
    const key = currency || '?';
    totals[key] = (totals[key] || 0) + value;
  }
  const parts = Object.entries(totals).map(([cur, val]) => formatAmountTotal(cur, val));
  document.getElementById('hist-stat-amount').textContent = parts.length > 0 ? parts.join(' + ') : '\u2014';

  // Sort
  filtered.sort((a, b) => {
    let va = a[historySort.column] || '';
    let vb = b[historySort.column] || '';
    if (va < vb) return historySort.asc ? -1 : 1;
    if (va > vb) return historySort.asc ? 1 : -1;
    return 0;
  });

  // Destructive actions only when there is something to act on
  document.getElementById('btn-delete-filtered').disabled = filtered.length === 0;
  document.getElementById('btn-clear-history').disabled = history.length === 0;
  document.getElementById('btn-export-csv').disabled = history.length === 0;

  // Render table
  const container = document.getElementById('history-table-container');
  if (filtered.length === 0) {
    // Bonobot only when nothing was ever filed; a filter with no matches is plain text.
    container.innerHTML = history.length === 0
      ? `<div class="empty-state"><img class="empty-art" src="icons/brand/empty-empty-history.svg" alt="" width="120" height="120" aria-hidden="true"><p>${escapeHtml(t('historyEmpty'))}</p></div>`
      : `<div class="empty-state empty-state-compact"><p>${escapeHtml(t('historyNoMatches'))}</p></div>`;
    return;
  }

  const sortAttr = column => historySort.column === column
    ? ` aria-sort="${historySort.asc ? 'ascending' : 'descending'}"` : '';
  const sortHeader = (column, key) => `<th scope="col"${sortAttr(column)}><button type="button" class="sort-button" data-sort="${column}">${escapeHtml(t(key))}<svg class="ie-icon sort-indicator" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS.chevronUp}</svg></button></th>`;
  let html = `<table class="history-table"><thead><tr>
    <th scope="col"><span class="visually-hidden">${escapeHtml(t('historyColLogo'))}</span></th>
    ${sortHeader('providerName', 'historyColProvider')}
    ${sortHeader('date', 'historyColDate')}
    ${sortHeader('amount', 'historyColAmount')}
    <th scope="col"><span class="visually-hidden">${escapeHtml(t('commonDelete'))}</span></th>
  </tr></thead><tbody>`;
  for (let idx = 0; idx < filtered.length; idx++) {
    const e = filtered[idx];
    const name = e.providerName || e.providerId || '';
    const dateText = e.date || '\u2014';
    html += `<tr class="clickable-row" data-idx="${idx}">
      <td class="logo-cell">${e.providerId ? logoImgHtml(e.providerId, name, 'history-logo') : ''}</td>
      <td><button type="button" class="history-open" aria-label="${escapeHtml(t('historyOpenRowLabel', [name, dateText]))}">${escapeHtml(name)}</button></td>
      <td class="date-cell">${escapeHtml(displayInvoiceDate(e.date))}</td>
      <td class="amount-cell">${escapeHtml(e.amount || '\u2014')}</td>
      <td class="delete-cell"><button type="button" class="btn-delete-row" data-idx="${idx}" title="${escapeHtml(t('commonDelete'))}" aria-label="${escapeHtml(t('historyDeleteRowLabel', [name, dateText]))}">${icon('x', 14)}</button></td>
    </tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
  wireLogoFallbacks(container);

  // Delete individual row
  container.querySelectorAll('.btn-delete-row').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entry = filtered[parseInt(btn.dataset.idx)];
      if (!entry) return;

      // Remove from history
      const history = await loadDownloadHistory();
      const targetKey = historyEntryKey(entry);
      const hIdx = history.findIndex(h => historyEntryKey(h) === targetKey);
      if (hIdx !== -1) {
        // Optionally delete file from disk
        if (history[hIdx].downloadId) {
          try { await chrome.downloads.removeFile(history[hIdx].downloadId); } catch (ex) { /* file may be gone */ }
        }
        history.splice(hIdx, 1);
        await chrome.storage.local.set({ downloadHistory: history });
      }
      renderHistory();
    });
  });

  // Row click — open file in Finder (resolves downloadId on-demand if needed)
  container.querySelectorAll('tr.clickable-row').forEach(row => {
    row.addEventListener('click', async () => {
      const entry = filtered[parseInt(row.dataset.idx)];
      if (!entry) return;

      // If we already have a downloadId, use it directly
      if (entry.downloadId) {
        await showFileInFolder(entry.downloadId);
        return;
      }

      // Try to find the download on-demand
      row.setAttribute('aria-busy', 'true');
      const dlItem = await findDownloadItem(entry.filename, entry.downloadUrl);
      row.removeAttribute('aria-busy');

      if (dlItem) {
        // Save resolved ID to history for future clicks
        const history = await loadDownloadHistory();
        const targetKey = historyEntryKey(entry);
        const hIdx = history.findIndex(h => historyEntryKey(h) === targetKey);
        if (hIdx !== -1) {
          history[hIdx].downloadId = dlItem.id;
          history[hIdx].filePath = dlItem.filename;
          await chrome.storage.local.set({ downloadHistory: history });
        }
        await showFileInFolder(dlItem.id);
      } else {
        // Fallback: open downloads folder
        try { await chrome.downloads.showDefaultFolder(); } catch (ex) {}
      }
    });
  });

  // Sort handlers
  container.querySelectorAll('.sort-button[data-sort]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (historySort.column === btn.dataset.sort) historySort.asc = !historySort.asc;
      else { historySort.column = btn.dataset.sort; historySort.asc = true; }
      await renderHistory();
      container.querySelector(`.sort-button[data-sort="${btn.dataset.sort}"]`)?.focus();
    });
  });
}

async function exportCSV() {
  const history = await loadDownloadHistory();
  // Apply current filters
  const provFilter = document.getElementById('hist-filter-provider').value;
  const fromFilter = document.getElementById('hist-filter-from').value;
  const toFilter = document.getElementById('hist-filter-to').value;
  let filtered = history;
  if (provFilter) filtered = filtered.filter(e => e.providerId === provFilter);
  if (fromFilter) filtered = filtered.filter(e => e.downloadedAt >= fromFilter);
  if (toFilter) filtered = filtered.filter(e => e.downloadedAt <= toFilter + 'T23:59:59');

  if (filtered.length === 0) return;
  const headers = ['Provider', 'Invoice Date', 'Amount', 'Filename', 'Download URL', 'Downloaded At'];
  const rows = filtered.map(e => [
    e.providerName || e.providerId, e.date || '', e.amount || '',
    e.filename || '', e.downloadUrl || '', e.downloadedAt || ''
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `invoice_history_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// =====================================================
// RECORD MODE
// =====================================================
let recordState = {
  isRecording: false,
  tabId: null,
  tabIds: new Set(),       // all tabs being recorded (main + child tabs)
  iframeIds: new Set(),    // frameIds where recorder has been injected
  iframeUrls: new Map(),   // frameId key → URL, detect iframe navigations
  dialogScanResults: [],   // dialog buttons found by scanning frames
  iframePollInterval: null,
  startTime: null,
  durationInterval: null,
  pendingTab: null,
  navigationListener: null,
  tabCreatedListener: null,
  downloadsListener: null, // chrome.downloads.onCreated listener
  capturedDownloads: []    // downloads captured via chrome.downloads API
};

async function saveRecordState() {
  await chrome.storage.local.set({
    recordingState: {
      isRecording: recordState.isRecording,
      tabId: recordState.tabId,
      startTime: recordState.startTime,
      tabUrl: recordState.tabUrl,
      tabTitle: recordState.tabTitle
    }
  });
}

async function clearRecordState() {
  await chrome.storage.local.remove('recordingState');
}

function showRecordStep(step) {
  // step: 'confirm', 'recording', 'result'
  setHidden('record-step-confirm', step !== 'confirm');
  setHidden('record-step-recording', step !== 'recording');
  setHidden('record-step-result', step !== 'result');

  // Update back button text
  const backBtn = document.getElementById('record-back');
  if (backBtn) {
    if (step === 'recording') {
      backBtn.textContent = t('commonCancelBack');
    } else if (step === 'result') {
      backBtn.textContent = t('commonDoneBack');
    } else {
      backBtn.textContent = t('commonBack');
    }
  }
}

async function startRecording() {
  const tab = recordState.pendingTab || await getActiveBrowserTab();
  if (!tab) return;

  recordState.pendingTab = null;
  recordState.isRecording = true;
  recordState.tabId = tab.id;
  recordState.startTime = Date.now();
  recordState.tabUrl = tab.url;
  recordState.tabTitle = tab.title;
  recordState.favIconUrl = tab.favIconUrl || null;

  // Show recording step
  showRecordStep('recording');

  // Set recording info in UI
  const urlEl = document.getElementById('record-url');
  if (urlEl) {
    try { urlEl.textContent = new URL(tab.url).hostname; }
    catch (e) { urlEl.textContent = tab.url; }
  }
  const tabEl = document.getElementById('record-tab-title');
  if (tabEl) tabEl.textContent = tab.title || '';

  // Reset counters in UI
  const clickEl = document.getElementById('record-click-count');
  const networkEl = document.getElementById('record-network-count');
  const durationEl = document.getElementById('record-duration');
  if (clickEl) clickEl.textContent = '0';
  if (networkEl) networkEl.textContent = '0';
  if (durationEl) durationEl.textContent = t('recordDurationValue', [0]);
  await saveRecordState();

  recordState.tabIds = new Set([tab.id]);

  // Inject recorder into main frame
  await injectRecorder(tab.id);

  // Dialog button scanner: instead of trying to capture clicks inside OOPIF iframes
  // (which is impossible with content scripts), we scan ALL frames every second for
  // visible dialog buttons. When found, we record the dialog structure with selectors.
  // This gives add-provider enough info to generate the correct download steps.
  recordState.dialogScanResults = [];

  // Re-inject recorder on ANY frame navigation (main frame or iframe).
  // When an iframe navigates the recorder inside it is lost — this re-injects immediately.
  const frameInjector = (details) => {
    if (!recordState.isRecording) return;
    if (!recordState.tabIds.has(details.tabId)) return;
    if (details.url?.startsWith('chrome')) return;
    if (details.frameId === 0) {
      injectRecorder(details.tabId);
    } else {
      injectRecorderInFrame(details.tabId, details.frameId);
    }
  };
  recordState.navigationListener = frameInjector;
  chrome.webNavigation?.onCommitted?.addListener(frameInjector);

  // Track new tabs opened from the recording tab (e.g., Stripe invoice)
  if (chrome.tabs?.onCreated) {
    recordState.tabCreatedListener = (newTab) => {
      if (!recordState.isRecording) return;
      if (newTab.openerTabId && recordState.tabIds.has(newTab.openerTabId)) {
        recordState.tabIds.add(newTab.id);
        // Inject after a short delay so the page has loaded
        setTimeout(() => injectRecorder(newTab.id), 1500);
      }
    };
    chrome.tabs.onCreated.addListener(recordState.tabCreatedListener);
  }

  // Poll for iframes (including dynamically created ones for dialogs) and inject recorder
  recordState.iframeIds = new Set();
  recordState.iframeUrls = new Map(); // key → url, detect navigations within iframes
  recordState.iframePollInterval = setInterval(() => pollAndInjectIframes(), 500);
  // Run once immediately after a short delay (let page load)
  setTimeout(() => pollAndInjectIframes(), 1000);

  // Listen for actual file downloads via chrome.downloads API
  // This captures downloads triggered from OOPIFs (e.g., Google Payments dialog)
  // that the content script can't intercept
  recordState.capturedDownloads = [];
  if (chrome.downloads?.onCreated) {
    recordState.downloadsListener = (downloadItem) => {
      if (!recordState.isRecording) return;
      recordState.capturedDownloads.push({
        timestamp: Date.now() - recordState.startTime,
        method: 'chrome-download-event',
        url: downloadItem.url || null,
        finalUrl: downloadItem.finalUrl || null,
        filename: downloadItem.filename || null,
        fileSize: downloadItem.fileSize || 0,
        mime: downloadItem.mime || null,
        startTime: downloadItem.startTime || null
      });
    };
    chrome.downloads.onCreated.addListener(recordState.downloadsListener);
  }

  // Start polling for status updates
  recordState.durationInterval = setInterval(() => updateRecordStatus(), 300);
}

async function injectRecorder(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['recorder.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__invoiceRecorder.start(),
      world: 'MAIN'
    });
  } catch (e) {
    console.error(`Failed to inject recorder in tab ${tabId}:`, e);
  }
}

async function injectRecorderInFrame(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['recorder.js'], world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => window.__invoiceRecorder.start(), world: 'MAIN'
    });
    recordState.iframeIds.add(`${tabId}-${frameId}`);
  } catch (e) { /* frame may not be injectable */ }
}

async function pollAndInjectIframes() {
  if (!recordState.isRecording) return;
  for (const tabId of recordState.tabIds) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (!frames) continue;
      for (const frame of frames) {
        if (frame.frameId === 0) continue;
        if (frame.url?.startsWith('chrome')) continue;
        const key = `${tabId}-${frame.frameId}`;
        // Re-inject if frame is new OR its URL changed (iframe navigated)
        const knownUrl = recordState.iframeUrls?.get(key);
        if (knownUrl && knownUrl === frame.url) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            files: ['recorder.js'], world: 'MAIN'
          });
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            func: () => window.__invoiceRecorder.start(), world: 'MAIN'
          });
          recordState.iframeIds.add(key);
          recordState.iframeUrls?.set(key, frame.url);
        } catch (e) { /* some frames block injection */ }
      }
    } catch (e) { /* tab may be gone */ }
  }
}

async function updateRecordStatus() {
  if (!recordState.isRecording) return;

  // Duration always from popup.js startTime — never freezes
  const durationEl = document.getElementById('record-duration');
  if (durationEl && recordState.startTime) {
    durationEl.textContent = t('recordDurationValue', [Math.floor((Date.now() - recordState.startTime) / 1000)]);
  }

  // Aggregate click/network counts from ALL frames (main + iframes) in one call
  let totalClicks = 0;
  let totalNetwork = 0;
  for (const tabId of recordState.tabIds) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => window.__invoiceRecorder?.getStatus(),
        world: 'MAIN'
      });
      for (const r of results) {
        const status = r?.result;
        if (status) {
          totalClicks += status.clickCount || 0;
          totalNetwork += status.networkCount || 0;
        }
      }
    } catch (e) {
      // Tab navigated or closed — recorder will be re-injected by listener
    }
  }
  // Add downloads captured via chrome.downloads API (OOPIF-triggered)
  totalNetwork += recordState.capturedDownloads?.length || 0;
  // Scan ALL frames in PARALLEL for visible dialogs/modals.
  // Captures interactive elements generically. Catches OOPIF dialog iframes.
  for (const tabId of recordState.tabIds) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (!frames) continue;

      const dialogFunc = () => {
        // Find ALL visible interactive elements in this frame.
        // Don't require a dialog container — just find what's clickable.
        const interactive = Array.from(document.querySelectorAll(
          'button, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], a[href], input, select, textarea, summary, [tabindex="0"], [onclick], [data-action]'
        )).filter(el => el.offsetParent !== null && el.offsetWidth > 0);
        if (!interactive.length) return null;

        // Check if there's a dialog/modal container (optional context)
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');

        return [{
          dialogTag: dialog?.tagName?.toLowerCase() || null,
          dialogClass: (dialog?.className || '').toString().slice(0, 200),
          dialogRole: dialog?.getAttribute('role') || null,
          dialogText: (document.body?.textContent || '').trim().slice(0, 500),
          frameOrigin: location.origin,
          framePath: location.pathname.slice(0, 80),
          elements: interactive.map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().slice(0, 80),
            className: (el.className || '').toString().slice(0, 200),
            role: el.getAttribute('role'),
            type: el.type || null, href: el.href || null
          }))
        }];
      };

      // Fire all frame scans in parallel
      const results = await Promise.allSettled(
        frames.map(frame =>
          chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            func: dialogFunc, world: 'MAIN'
          }).then(r => ({ frameId: frame.frameId, data: r[0]?.result }))
        )
      );

      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value?.data) continue;
        for (const info of r.value.data) {
          if (!info.elements?.length) continue;
          // Only capture frames with overlay/popup semantics
          const overlayRoles = ['dialog', 'alertdialog', 'tooltip', 'menu', 'listbox', 'tree', 'banner', 'alert', 'status', 'log'];
          if (!info.dialogRole || !overlayRoles.includes(info.dialogRole)) continue;
          const key = info.frameOrigin + ':' + (info.dialogClass || '').slice(0, 50) + ':' + info.elements.map(e => e.text).join('|');
          if (!recordState.dialogScanResults.some(d => d._key === key)) {
            info._key = key;
            info.type = 'dialog-with-buttons';
            info.timestamp = Date.now() - recordState.startTime;
            info.source = 'frame-scan';
            recordState.dialogScanResults.push(info);
          }
        }
      }
    } catch (e) {}
  }

  // Track high-water mark — counter should never decrease
  if (!recordState.peakClicks) recordState.peakClicks = 0;
  if (!recordState.peakNetwork) recordState.peakNetwork = 0;
  recordState.peakClicks = Math.max(recordState.peakClicks, totalClicks);
  recordState.peakNetwork = Math.max(recordState.peakNetwork, totalNetwork);

  const clickEl = document.getElementById('record-click-count');
  const networkEl = document.getElementById('record-network-count');
  if (clickEl) clickEl.textContent = recordState.peakClicks;
  if (networkEl) networkEl.textContent = recordState.peakNetwork;
}

async function stopRecording() {
  if (!recordState.isRecording) return;
  clearInterval(recordState.durationInterval);
  cleanupRecordListeners();

  // Collect recording data from all tracked tabs (main frames)
  let mergedData = null;
  for (const tabId of recordState.tabIds) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__invoiceRecorder?.stop(),
        world: 'MAIN'
      });
      const result = results[0]?.result;
      if (result?.success && result.data) {
        if (!mergedData) {
          mergedData = result.data;
        } else {
          // Merge child tab data into main recording
          mergedData.actions.push(...(result.data.actions || []));
          mergedData.networkRequests.push(...(result.data.networkRequests || []));
          mergedData.downloads.push(...(result.data.downloads || []));
          mergedData.domSnapshots.push(...(result.data.domSnapshots || []));
        }
      }
    } catch (e) {
      console.error(`Error stopping recorder in tab ${tabId}:`, e);
    }
  }

  // Collect recording data from ALL iframes (not just tracked ones).
  // This catches transient frames (e.g., Google's dialog iframes) that may
  // have been injected by polling but not tracked in iframeIds.
  const iframeRecordings = [];
  const collectedFrameIds = new Set();
  for (const tabId of recordState.tabIds) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (!frames) continue;
      for (const frame of frames) {
        if (frame.frameId === 0) continue;
        if (frame.url?.startsWith('chrome')) continue;
        if (collectedFrameIds.has(frame.frameId)) continue;
        collectedFrameIds.add(frame.frameId);
        try {
          // Try to stop recorder if running, or just get data
          const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frame.frameId] },
            func: () => window.__invoiceRecorder?.stop(),
            world: 'MAIN'
          });
          const result = results[0]?.result;
          if (result?.success && result.data) {
            iframeRecordings.push({ data: result.data, frameUrl: frame.url });
          }
        } catch (e) { /* frame may block access */ }
      }
    } catch (e) {}
  }
  // Also collect from tracked iframes that may no longer be in getAllFrames
  for (const key of recordState.iframeIds) {
    const [tabIdStr, frameIdStr] = key.split('-');
    const frameId = parseInt(frameIdStr);
    if (collectedFrameIds.has(frameId)) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: parseInt(tabIdStr), frameIds: [frameId] },
        func: () => window.__invoiceRecorder?.stop(),
        world: 'MAIN'
      });
      const result = results[0]?.result;
      if (result?.success && result.data) {
        iframeRecordings.push({ data: result.data, frameUrl: null });
      }
    } catch (e) { /* frame gone */ }
  }

  if (mergedData) {
    // Merge iframe data into main recording, tagged with source
    if (iframeRecordings.length > 0) {
      mergedData.iframes = [];
      for (const { data, frameUrl } of iframeRecordings) {
        // Tag each iframe's data separately so add-provider knows the source
        mergedData.iframes.push({
          frameUrl,
          actions: data.actions || [],
          domSnapshots: data.domSnapshots || [],
          networkRequests: data.networkRequests || [],
          downloads: data.downloads || [],
          analysis: data.analysis || {}
        });
        // Also merge into top-level arrays for backward compatibility
        mergedData.actions.push(...(data.actions || []));
        mergedData.networkRequests.push(...(data.networkRequests || []));
        mergedData.downloads.push(...(data.downloads || []));
        mergedData.domSnapshots.push(...(data.domSnapshots || []));
        // Merge analysis candidates
        if (data.analysis?.invoiceTableCandidates?.length) {
          mergedData.analysis = mergedData.analysis || {};
          mergedData.analysis.invoiceTableCandidates = [
            ...(mergedData.analysis.invoiceTableCandidates || []),
            ...data.analysis.invoiceTableCandidates
          ];
        }
      }
    }

    // Merge dialog scan results (buttons found in OOPIF dialog iframes)
    if (recordState.dialogScanResults?.length > 0) {
      for (const d of recordState.dialogScanResults) {
        const { _key, ...clean } = d;
        mergedData.actions.push(clean);
      }
      console.log(`Merged ${recordState.dialogScanResults.length} dialog scan result(s)`);
    }

    // Merge downloads captured via chrome.downloads API (catches OOPIF-triggered downloads)
    if (recordState.capturedDownloads?.length > 0) {
      mergedData.downloads.push(...recordState.capturedDownloads);
      // Also store separately so add-provider can distinguish the source
      mergedData.chromeDownloads = recordState.capturedDownloads;
      console.log(`Merged ${recordState.capturedDownloads.length} chrome.downloads event(s)`);
    }

    // Include favicon URL from the recorded tab
    if (recordState.favIconUrl) {
      mergedData.favIconUrl = recordState.favIconUrl;
    }
    await chrome.storage.local.set({ lastRecording: mergedData });
  }

  recordState.isRecording = false;
  recordState.tabId = null;
  recordState.tabIds = new Set();
  recordState.iframeIds = new Set();
  recordState.iframeUrls = new Map();
  recordState.startTime = null;
  recordState.capturedDownloads = [];
  await clearRecordState();

  // Show result step and populate fields
  const stored = await chrome.storage.local.get('lastRecording');
  if (stored.lastRecording) {
    const data = stored.lastRecording;
    const urlEl = document.getElementById('result-url');
    const actionsEl = document.getElementById('result-actions');
    const networkEl = document.getElementById('result-network');
    const downloadsEl = document.getElementById('result-downloads');
    const durationEl = document.getElementById('result-duration');

    if (urlEl) {
      try { urlEl.textContent = new URL(data.billingUrl).hostname; }
      catch (e) { urlEl.textContent = data.billingUrl; }
    }
    if (actionsEl) actionsEl.textContent = data.actions?.length || 0;
    if (networkEl) networkEl.textContent = data.networkRequests?.length || 0;
    if (downloadsEl) downloadsEl.textContent = data.downloads?.length || 0;
    if (durationEl) durationEl.textContent = t('recordDurationValue', [Math.floor((data.duration || 0) / 1000)]);
  }
  showRecordStep('result');
}

async function cancelRecording() {
  clearInterval(recordState.durationInterval);
  cleanupRecordListeners();
  // Stop the recorder in all tracked tabs
  for (const tabId of recordState.tabIds) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__invoiceRecorder?.stop(),
        world: 'MAIN'
      });
    } catch (e) { /* tab may be gone */ }
  }
  // Stop recorder in iframes
  for (const key of recordState.iframeIds) {
    const [tabIdStr, frameIdStr] = key.split('-');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: parseInt(tabIdStr), frameIds: [parseInt(frameIdStr)] },
        func: () => window.__invoiceRecorder?.stop(),
        world: 'MAIN'
      });
    } catch (e) { /* iframe may be gone */ }
  }
  recordState.isRecording = false;
  recordState.tabId = null;
  recordState.tabIds = new Set();
  recordState.iframeIds = new Set();
  recordState.iframeUrls = new Map();
  recordState.startTime = null;
  recordState.capturedDownloads = [];
  await clearRecordState();
}

function cleanupRecordListeners() {
  if (recordState.navigationListener) {
    chrome.webNavigation?.onCommitted?.removeListener(recordState.navigationListener);
    recordState.navigationListener = null;
  }
  // Unregister auto-inject content scripts
  try { chrome.scripting.unregisterContentScripts({ ids: ['recorder-all-frames'] }); } catch (e) {}
  recordState.dialogScanResults = [];
  if (recordState.tabCreatedListener) {
    chrome.tabs?.onCreated?.removeListener(recordState.tabCreatedListener);
    recordState.tabCreatedListener = null;
  }
  if (recordState.iframePollInterval) {
    clearInterval(recordState.iframePollInterval);
    recordState.iframePollInterval = null;
  }
  if (recordState.downloadsListener) {
    chrome.downloads?.onCreated?.removeListener(recordState.downloadsListener);
    recordState.downloadsListener = null;
  }
}

async function exportRecording() {
  const result = await chrome.storage.local.get('lastRecording');
  const data = result.lastRecording;
  if (!data) return;

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const hostname = (() => {
    try { return new URL(data.billingUrl).hostname.replace(/\./g, '_'); }
    catch (e) { return 'recording'; }
  })();
  const filename = `recording_${hostname}_${new Date().toISOString().slice(0, 10)}.json`;

  await chrome.downloads.download({ url, filename, saveAs: true });
  URL.revokeObjectURL(url);
}

// =====================================================
// FLOATING WINDOW
// =====================================================
let popupWindowId = null;

async function initPopupWindowId() {
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.type === 'popup') {
    popupWindowId = currentWindow.id;
  }
}

async function refocusPopup(delayMs = 600) {
  if (!popupWindowId) return;
  setTimeout(async () => {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
    } catch (e) { /* window may be gone */ }
  }, delayMs);
}

async function toggleFloating() {
  const currentWindow = await chrome.windows.getCurrent();
  const isFloating = currentWindow.type === 'popup';
  if (isFloating) {
    await chrome.storage.local.set({ floatingMode: false });
    await chrome.storage.local.remove('floatingWindowId');
    window.close();
  } else {
    await chrome.storage.local.set({ floatingMode: true });
    const w = await chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 440, height: 780 });
    await chrome.storage.local.set({ floatingWindowId: w.id });
    window.close();
  }
}

// =====================================================
// EVENT LISTENERS
// =====================================================
// =====================================================
// PROFILES VIEW
// =====================================================
async function renderProfiles() {
  const container = document.getElementById('profiles-list');
  if (!container) return;
  container.innerHTML = '';

  if (profiles.length === 0) {
    container.innerHTML = `<div class="empty-state"><img class="empty-art" src="icons/brand/empty-no-providers.svg" alt="" width="120" height="120" aria-hidden="true"><p>${escapeHtml(t('profilesEmpty'))}</p></div>`;
    return;
  }

  for (const p of profiles) {
    const isLoaded = p.id === loadedProfileId;
    const hasSaved = !!p.snapshot;
    const provCount = hasSaved ? p.snapshot.activeProviders.length : 0;
    const div = document.createElement('div');
    div.className = `profile-item${isLoaded ? ' active' : ''}`;
    const metaText = hasSaved
      ? tp('commonProvidersCount', provCount)
      : t('profilesPending');
    div.innerHTML = `
      <div class="profile-item-main">
        <span class="profile-item-name"></span>
        <div class="profile-item-meta">${escapeHtml(metaText)}</div>
      </div>
      ${isLoaded ? `<span class="profile-item-badge">${escapeHtml(t('profilesLoaded'))}</span>` : ''}
      <div class="profile-item-actions">
        ${hasSaved ? `<button type="button" class="btn-load-profile" title="${escapeHtml(t('profilesLoadTitle'))}">${escapeHtml(t('profilesLoad'))}</button>` : ''}
        <button type="button" class="btn-save-profile" title="${escapeHtml(t('homeProfileSaveTitle'))}">${escapeHtml(t('commonSave'))}</button>
        <button type="button" class="btn-rename-profile" title="${escapeHtml(t('profilesRename'))}" aria-label="${escapeHtml(t('profilesRenameLabel', [p.name]))}">${icon('pencil', 14)}</button>
        <button type="button" class="btn-delete-profile" title="${escapeHtml(t('commonDelete'))}" aria-label="${escapeHtml(t('profilesDeleteLabel', [p.name]))}">${icon('x', 14)}</button>
      </div>
    `;
    div.querySelector('.profile-item-name').textContent = p.name;
    div.querySelectorAll('button').forEach(button => { button.dataset.id = p.id; });
    container.appendChild(div);
  }

  // Load handlers
  container.querySelectorAll('.btn-load-profile').forEach(btn => {
    btn.addEventListener('click', async () => {
      await applyProfile(btn.dataset.id);
      renderProfiles();
      renderHome();
    });
  });

  // Save handlers
  container.querySelectorAll('.btn-save-profile').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const profile = profiles.find(p => p.id === id);
      if (profile?.snapshot && !confirm(t('profilesConfirmOverwrite', [profile.name]))) return;
      await saveCurrentToProfile(id);
      renderProfiles();
      renderHome();
    });
  });

  // Rename handlers
  container.querySelectorAll('.btn-rename-profile').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const current = profiles.find(p => p.id === id);
      const newName = prompt(t('profilesPromptRename'), current?.name || '');
      if (newName && newName.trim()) {
        await renameProfile(id, newName.trim());
        renderProfiles();
        renderHome();
      }
    });
  });

  // Delete handlers
  container.querySelectorAll('.btn-delete-profile').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const profile = profiles.find(p => p.id === id);
      if (!confirm(t('profilesConfirmDelete', [profile?.name]))) return;
      await deleteProfile(id);
      renderProfiles();
      renderHome();
    });
  });
}

function setupEventListeners() {
  document.getElementById('btn-open-sync').addEventListener('click', () => {
    nav.push('profiles');
    renderProfiles();
    const disclosure = document.getElementById('sync-disclosure');
    if (disclosure) disclosure.open = true;
  });
  // A sync conflict needs a decision: never leave it folded away.
  const syncConflict = document.getElementById('sync-conflict');
  if (syncConflict) {
    new MutationObserver(() => {
      if (!syncConflict.hidden) document.getElementById('sync-disclosure').open = true;
    }).observe(syncConflict, { attributes: true, attributeFilter: ['hidden'] });
  }
  // Profile selector — loading a profile applies its saved settings
  document.getElementById('profile-select').addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) {
      // "No profile" — just unload
      loadedProfileId = null;
      await chrome.storage.local.set({ loadedProfileId: null });
      await renderHome();
      return;
    }
    const profile = profiles.find(p => p.id === id);
    if (!profile?.snapshot) {
      alert(t('homeProfileNoSnapshot', [profile?.name]));
      e.target.value = loadedProfileId || '';
      return;
    }
    // Warn about unsaved changes
    if (isProfileDirty()) {
      const currentProfile = profiles.find(p => p.id === loadedProfileId);
      const currentName = currentProfile?.name || t('homeCurrentProfile');
      if (!confirm(t('homeConfirmDiscard', [currentName, profile.name]))) {
        e.target.value = loadedProfileId || '';
        return;
      }
    }
    await applyProfile(id);
    await renderHome();
  });

  // Quick save button in profile bar
  document.getElementById('btn-save-profile-quick').addEventListener('click', async () => {
    if (!loadedProfileId) return;
    const profile = profiles.find(p => p.id === loadedProfileId);
    if (!profile) return;
    await saveCurrentToProfile(loadedProfileId);
    await renderHome();
  });

  document.getElementById('btn-sync-op-profiles')?.addEventListener('click', () => {
    syncProfilesFrom1Password();
  });

  document.getElementById('btn-discover-op-profiles')?.addEventListener('click', () => {
    syncProfilesFrom1Password();
  });

  document.getElementById('btn-manage-profiles').addEventListener('click', () => {
    nav.push('profiles');
    renderProfiles();
  });

  document.getElementById('btn-new-profile-quick').addEventListener('click', async () => {
    const name = prompt(t('profilesPromptNew'));
    if (!name || !name.trim()) return;
    await createProfile(name.trim(), false);
    renderProfiles();
    renderHome();
  });

  document.getElementById('profiles-back').addEventListener('click', () => {
    nav.pop();
    renderHome();
  });

  document.getElementById('btn-create-profile').addEventListener('click', async () => {
    const input = document.getElementById('profile-new-name');
    const name = input.value.trim();
    if (!name) return;
    await createProfile(name, false); // start empty — user configures from scratch
    input.value = '';
    renderProfiles();
    renderHome();
  });

  // Home
  document.getElementById('card-download-all').addEventListener('click', () => {
    const activeProviders = providers.filter(p => activeProviderIds.has(p.id));
    if (activeProviders.length === 0) return;
    workflowProviders = activeProviders;
    nav.push('batch-config');
    renderBatchConfig(activeProviders);
  });

  document.getElementById('card-record').addEventListener('click', async () => {
    nav.push('record');
    showRecordStep('confirm');
    const tab = await getActiveBrowserTab();
    if (tab) {
      recordState.pendingTab = tab;
      document.getElementById('confirm-tab-title').textContent = tab.title || t('recordUnknownTab');
      document.getElementById('confirm-tab-url').textContent = tab.url || '';
    }
  });

  document.getElementById('card-history').addEventListener('click', () => {
    nav.push('history');
    renderHistory();
  });

  // Provider detail
  document.getElementById('provider-back').addEventListener('click', () => {
    nav.pop();
    renderHome();
  });
  document.getElementById('btn-download-single').addEventListener('click', () => {
    const providerId = nav.data.providerId;
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return;
    workflowProviders = [provider];
    nav.push('batch-config');
    renderBatchConfig([provider]);
  });

  // Batch config
  document.getElementById('batch-config-back').addEventListener('click', () => nav.pop());
  document.querySelectorAll('.preset-row [data-preset]').forEach(button => {
    button.addEventListener('click', () => {
      document.getElementById('config-since-date').value = sinceDatePreset(button.dataset.preset);
      syncPresetButtons();
    });
  });
  document.getElementById('config-since-date').addEventListener('input', syncPresetButtons);
  document.getElementById('btn-start-batch').addEventListener('click', async () => {
    state.maxInvoices = parseInt(document.getElementById('config-max-invoices').value) || DEFAULT_MAX_INVOICES;
    state.sinceDate = document.getElementById('config-since-date').value || null;
    nav.push('workflow');
    await startWorkflow();
  });

  // Workflow
  document.getElementById('workflow-back').addEventListener('click', () => {
    if (state.isRunning) {
      if (!confirm(t('workflowConfirmStop'))) return;
      state.isRunning = false;
    }
    nav.home();
  });
  document.getElementById('btn-logged-in').addEventListener('click', handleLoggedIn);
  document.getElementById('btn-1password-login')?.addEventListener('click', signInWith1Password);
  document.getElementById('btn-switch-account')?.addEventListener('click', switchAccountWith1Password);
  document.getElementById('btn-show-tab').addEventListener('click', async () => {
    if (currentProviderTabId) {
      try {
        const tab = await chrome.tabs.get(currentProviderTabId);
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        // Tab may have been closed — try to find it by provider domain
        const provider = workflowProviders[state.currentIndex];
        if (provider) {
          const t = await findProviderTab(provider.id, resolveBillingUrl(provider));
          if (t) {
            currentProviderTabId = t.id;
            await chrome.tabs.update(t.id, { active: true });
            await chrome.windows.update(t.windowId, { focused: true });
            return;
          }
        }
      }
    }
  });
  document.getElementById('btn-goto-billing').addEventListener('click', gotoBillingPage);
  document.getElementById('btn-stop').addEventListener('click', () => stopAndNext());
  document.getElementById('btn-skip').addEventListener('click', () => skipCurrent());
  document.getElementById('btn-next').addEventListener('click', () => processNextSite());
  document.getElementById('btn-retry').addEventListener('click', () => retryDownload());
  document.getElementById('btn-restart-workflow').addEventListener('click', async () => {
    await clearState();
    state.isRunning = false;
    nav.home();
  });

  // Completion
  document.getElementById('btn-completion-home').addEventListener('click', () => nav.home());
  document.getElementById('btn-open-downloads').addEventListener('click', async () => {
    try { await chrome.downloads.showDefaultFolder(); } catch (e) {}
  });

  // History
  document.getElementById('history-back').addEventListener('click', () => {
    nav.pop();
    renderHome();
  });
  document.getElementById('hist-filter-provider').addEventListener('change', () => renderHistory());
  document.getElementById('hist-filter-from').addEventListener('change', () => renderHistory());
  document.getElementById('hist-filter-to').addEventListener('change', () => renderHistory());
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

  // Delete filtered — removes only invoices matching current provider/date filters
  document.getElementById('btn-delete-filtered').addEventListener('click', async () => {
    const provFilter = document.getElementById('hist-filter-provider').value;
    const fromFilter = document.getElementById('hist-filter-from').value;
    const toFilter = document.getElementById('hist-filter-to').value;

    const history = await loadDownloadHistory();
    const toDelete = history.filter(e => {
      if (provFilter && e.providerId !== provFilter) return false;
      if (fromFilter && e.downloadedAt < fromFilter) return false;
      if (toFilter && e.downloadedAt > toFilter + 'T23:59:59') return false;
      return true;
    });

    if (toDelete.length === 0) return;

    const label = provFilter
      ? t('historyConfirmDeleteProvider', [toDelete.length, provFilter])
      : t('historyConfirmDeleteFiltered', [toDelete.length]);
    if (!confirm(label)) return;

    // Delete files from disk
    const filesWithId = toDelete.filter(e => e.downloadId);
    if (filesWithId.length > 0) {
      const deleteFiles = confirm(t('historyConfirmDeleteFiles', [filesWithId.length]));
      if (deleteFiles) {
        for (const entry of filesWithId) {
          try { await chrome.downloads.removeFile(entry.downloadId); } catch (e) {}
        }
      }
    }

    // Remove matching entries from history
    const deleteKeys = new Set(toDelete.map(e => historyEntryKey(e)));
    const remaining = history.filter(e => !deleteKeys.has(historyEntryKey(e)));
    await chrome.storage.local.set({ downloadHistory: remaining });
    renderHistory();
  });

  // Clear all history
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (!confirm(t('historyConfirmClear'))) return;

    const history = await loadDownloadHistory();
    const filesWithId = history.filter(e => e.downloadId);

    if (filesWithId.length > 0) {
      const deleteFiles = confirm(t('historyConfirmDeleteDownloadedFiles', [filesWithId.length]));
      if (deleteFiles) {
        for (const entry of filesWithId) {
          try { await chrome.downloads.removeFile(entry.downloadId); } catch (e) {}
        }
      }
    }

    await chrome.storage.local.remove('downloadHistory');
    renderHistory();
  });

  // Record
  document.getElementById('record-back').addEventListener('click', () => {
    if (recordState.isRecording) {
      cancelRecording();
    }
    nav.pop();
    renderHome();
  });
  document.getElementById('btn-confirm-record').addEventListener('click', () => startRecording());
  document.getElementById('btn-stop-recording').addEventListener('click', () => stopRecording());
  document.getElementById('btn-export-recording').addEventListener('click', () => exportRecording());
  document.getElementById('btn-record-done').addEventListener('click', () => nav.home());

  // Resume
  document.getElementById('btn-resume-workflow').addEventListener('click', async () => {
    setHidden('resume-banner', true);
    await resumeWorkflow();
  });
  document.getElementById('btn-dismiss-resume').addEventListener('click', async () => {
    await clearState();
    setHidden('resume-banner', true);
  });

  // Float toggle
  document.getElementById('btn-toggle-float').addEventListener('click', toggleFloating);

  // Tab changes — update record confirm panel live
  chrome.tabs.onActivated?.addListener(async () => {
    if (nav.stack[nav.stack.length - 1] === 'record') {
      const tab = await getActiveBrowserTab();
      if (tab) {
        recordState.pendingTab = tab;
        document.getElementById('confirm-tab-title').textContent = tab.title || '';
        document.getElementById('confirm-tab-url').textContent = tab.url || '';
      }
    }
  });

  chrome.windows.onFocusChanged?.addListener(async () => {
    if (nav.stack[nav.stack.length - 1] === 'record' && !recordState.isRecording) {
      const tab = await getActiveBrowserTab();
      if (tab) {
        recordState.pendingTab = tab;
        document.getElementById('confirm-tab-title').textContent = tab.title || '';
        document.getElementById('confirm-tab-url').textContent = tab.url || '';
      }
    }
  });
}

// =====================================================
// INIT
// =====================================================

// Lucide-style icons for the floating-window toggle (no emoji in UI)
const ICON_SVG_OPEN = '<svg class="ie-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const ICON_PIN = `${ICON_SVG_OPEN}<path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"/></svg>`;
const ICON_WINDOW = `${ICON_SVG_OPEN}<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/></svg>`;

async function init() {
  // Floating window logic (keep existing auto-float behavior)
  const currentWindow = await chrome.windows.getCurrent();
  const isFloating = currentWindow.type === 'popup';
  const floatBtn = document.getElementById('btn-toggle-float');

  if (isFloating) {
    if (floatBtn) { floatBtn.innerHTML = ICON_PIN; setButtonLabel(floatBtn, t('homeFloatToPopup')); }
    // Save this window ID so future clicks can refocus it
    await chrome.storage.local.set({ floatingWindowId: currentWindow.id });
  } else {
    const prefs = await chrome.storage.local.get(['floatingMode', 'floatingWindowId']);
    const floatingMode = prefs.floatingMode !== false;
    if (floatingMode) {
      // Check if an existing floating window is already open
      if (prefs.floatingWindowId) {
        try {
          const existing = await chrome.windows.get(prefs.floatingWindowId);
          if (existing) {
            // Floating window exists — just focus it
            await chrome.windows.update(existing.id, { focused: true });
            window.close();
            return;
          }
        } catch (e) {
          // Window no longer exists — clear stale ID and create new one
          await chrome.storage.local.remove('floatingWindowId');
        }
      }
      const w = await chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 440, height: 780 });
      await chrome.storage.local.set({ floatingWindowId: w.id });
      window.close();
      return;
    }
    if (floatBtn) { floatBtn.innerHTML = ICON_WINDOW; setButtonLabel(floatBtn, t('homeFloatOpen')); }
  }

  // Store popup window ID for refocusing
  await initPopupWindowId();

  // Load data
  await loadProviders();
  await loadProfiles();
  await loadActiveProviders();
  providerConfigs = await loadProviderConfigs();
  const hasState = await loadState();

  // Check for interrupted workflow
  if (hasState && state.isRunning && state.workflowProviderIds && state.currentIndex >= 0) {
    const totalSites = state.workflowProviderIds.length;
    const doneSites = (state.completed?.length || 0) + (state.skipped?.length || 0);

    if (state.currentIndex < totalSites) {
      // Show resume banner
      document.getElementById('resume-progress').textContent = `${doneSites}/${totalSites}`;
      setHidden('resume-banner', false);
    } else {
      // Workflow was already completed — just clear state
      await clearState();
    }
  } else if (hasState && !state.maxInvoices) {
    await clearState();
  }

  // Restore recording state if recording was in progress
  const savedRecording = await chrome.storage.local.get('recordingState');
  if (savedRecording.recordingState?.isRecording && savedRecording.recordingState?.tabId) {
    const rs = savedRecording.recordingState;
    // Verify the tab still exists
    try {
      const tab = await chrome.tabs.get(rs.tabId);
      recordState.isRecording = true;
      recordState.tabId = rs.tabId;
      recordState.startTime = rs.startTime;
      recordState.tabUrl = rs.tabUrl;
      recordState.tabTitle = rs.tabTitle;
      recordState.tabIds = new Set([rs.tabId]);

      // Navigate to record view and show recording step
      nav.push('record');
      showRecordStep('recording');

      const urlEl = document.getElementById('record-url');
      if (urlEl) {
        try { urlEl.textContent = new URL(rs.tabUrl || tab.url).hostname; }
        catch (e) { urlEl.textContent = rs.tabUrl || tab.url; }
      }
      const tabEl = document.getElementById('record-tab-title');
      if (tabEl) tabEl.textContent = rs.tabTitle || tab.title || '';

      recordState.durationInterval = setInterval(() => updateRecordStatus(), 300);
    } catch (e) {
      // Tab was closed — clean up
      await clearRecordState();
    }
  }

  // Render home
  await renderHome();

  // Event listeners
  setupEventListeners();
  probeCredentialBridge();
  setupProfileSyncUi(async () => {
    await loadProfiles();
    await renderHome();
    await renderProfiles();
  });
}

document.addEventListener('DOMContentLoaded', init);
