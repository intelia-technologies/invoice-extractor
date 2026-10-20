#!/usr/bin/env node
// Chrome Native Messaging Host for 1Password Service Account access.
// Reads 1Password Service Account tokens from environment or ~/.zshrc.local
// and invokes the `op` CLI non-interactively (zero Touch ID prompts).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_VAULTS,
  discoverProfilesFromOpItems,
  extractCredentialsFromOpItem,
  matchOpItemForProvider,
  normalizeBitwardenItem,
  parseOpReference,
} from '../onepassword.mjs';

const execFileAsync = promisify(execFile);

const OP_CANDIDATES = [
  process.env.OP_BIN,
  '/opt/homebrew/bin/op',
  '/usr/local/bin/op',
  '/usr/bin/op',
  '/snap/bin/op',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'op.exe') : null,
  'C:\\Program Files\\1Password CLI\\op.exe',
  process.platform === 'win32' ? 'op.exe' : 'op',
].filter(Boolean);

const BW_CANDIDATES = [
  process.env.BW_BIN,
  '/opt/homebrew/bin/bw',
  '/usr/local/bin/bw',
  '/usr/bin/bw',
  '/snap/bin/bw',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'bw.exe') : null,
  'C:\\Program Files\\Bitwarden CLI\\bw.exe',
  process.platform === 'win32' ? 'bw.exe' : 'bw',
].filter(Boolean);

export const COMMON_VAULT_PRESETS = [
  { alias: 'intelia', vault: 'AI', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN_INTELIA' },
  { alias: 'lana', vault: 'AI bots', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN_LANA' },
  { alias: 'personal', vault: 'Personal', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN' },
  { alias: 'private', vault: 'Private', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN' },
  { alias: 'shared', vault: 'Shared', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN' },
  { alias: 'employee', vault: 'Employee', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN' },
  { alias: 'finance', vault: 'Finance', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN' },
  { alias: 'facturas', vault: 'Facturas', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN' },
];

export function resolveOpBinary() {
  for (const candidate of OP_CANDIDATES) {
    if (candidate === 'op' || candidate === 'op.exe' || existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'op.exe' : 'op';
}

export function resolveBwBinary() {
  for (const candidate of BW_CANDIDATES) {
    if (candidate === 'bw' || candidate === 'bw.exe' || existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'bw.exe' : 'bw';
}

export function loadServiceAccountTokens({
  env = process.env,
  zshrcPath = join(homedir(), '.zshrc.local'),
  credentialsEnvPath = join(homedir(), '.config', 'invoice-extractor', 'credentials.env'),
} = {}) {
  const tokens = {};
  for (const v of DEFAULT_VAULTS) {
    if (env[v.tokenEnv]) {
      tokens[v.tokenEnv] = String(env[v.tokenEnv]).trim();
    }
  }
  if (env.OP_SERVICE_ACCOUNT_TOKEN) {
    tokens.OP_SERVICE_ACCOUNT_TOKEN = String(env.OP_SERVICE_ACCOUNT_TOKEN).trim();
  }
  if (env.BW_SESSION) {
    tokens.BW_SESSION = String(env.BW_SESSION).trim();
  }

  for (const rcFile of [zshrcPath, credentialsEnvPath, join(homedir(), '.bashrc')]) {
    if (rcFile && existsSync(rcFile)) {
      try {
        const content = readFileSync(rcFile, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const match = line.match(/^\s*(?:export\s+)?(OP_SERVICE_ACCOUNT_TOKEN(?:_[A-Z0-9_]+)?|BW_SESSION)\s*=\s*(.+?)\s*$/);
          if (!match) continue;
          const [, key, rawVal] = match;
          if (tokens[key]) continue;
          const cleaned = rawVal.replace(/^['"]|['"]$/g, '').trim();
          if (cleaned) tokens[key] = cleaned;
        }
      } catch {
        // Ignore unreadable rc file
      }
    }
  }
  return tokens;
}

export function resolveVaultConfigs(tokens, vaultHint = '', customVaults = []) {
  const configs = [];
  const allDefs = [...DEFAULT_VAULTS, ...(Array.isArray(customVaults) ? customVaults : [])];
  const seenVaults = new Set();

  for (const def of allDefs) {
    if (!def?.vault || seenVaults.has(def.vault.toLowerCase())) continue;
    const token = (def.tokenEnv && tokens[def.tokenEnv]) || tokens.OP_SERVICE_ACCOUNT_TOKEN || '';
    if (token) {
      seenVaults.add(def.vault.toLowerCase());
      configs.push({ ...def, token });
    } else if (def.desktopBiometrics) {
      seenVaults.add(def.vault.toLowerCase());
      configs.push({ ...def, token: '' });
    }
  }

  if (!vaultHint) return configs;
  const hint = vaultHint.trim().toLowerCase();
  const prioritized = [...configs].sort((a, b) => {
    const aMatch = (a.alias || '').toLowerCase() === hint || a.vault.toLowerCase() === hint ? -1 : 0;
    const bMatch = (b.alias || '').toLowerCase() === hint || b.vault.toLowerCase() === hint ? -1 : 0;
    return aMatch - bMatch;
  });
  return prioritized;
}

function ensureIsolatedOpDirs() {
  const isolatedHome = join(tmpdir(), 'invoice-extractor-op-home');
  const configDir = join(isolatedHome, '.config', 'op');
  const cacheDir = join(isolatedHome, '.cache');
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  } catch {
    // Directory already exists
  }
  return { isolatedHome, configDir, cacheDir };
}

async function defaultRunOp(args, token) {
  const opBin = resolveOpBinary();
  // Mode 1: Service Account Token -> isolate HOME so `op` on macOS never probes
  // ~/Library/Group Containers/2BUA8C4S2C.com.1password (zero TCC popups, zero Touch ID).
  // Mode 2: Desktop App Biometrics (no Service Account token) -> use normal HOME with
  // OP_BIOMETRIC_UNLOCK_ENABLED=true so non-technical 1Password Desktop users unlock with Touch ID / Windows Hello.
  if (token) {
    const { isolatedHome, configDir, cacheDir } = ensureIsolatedOpDirs();
    const childEnv = {
      ...process.env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      XDG_CACHE_HOME: cacheDir,
      OP_CONFIG_DIR: configDir,
      OP_BIOMETRIC_UNLOCK_ENABLED: 'false',
      OP_SERVICE_ACCOUNT_TOKEN: token,
    };
    const finalArgs = args.includes('--config') ? args : ['--config', configDir, ...args];
    const { stdout } = await execFileAsync(opBin, finalArgs, {
      env: childEnv,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }

  const { stdout } = await execFileAsync(opBin, args, {
    env: {
      ...process.env,
      OP_BIOMETRIC_UNLOCK_ENABLED: 'true',
    },
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function defaultRunBw(args, bwSession = '') {
  const bwBin = resolveBwBinary();
  const finalArgs = [...args];
  if (bwSession && !finalArgs.includes('--session')) {
    finalArgs.push('--session', bwSession);
  }
  if (!finalArgs.includes('--nointeraction')) {
    finalArgs.push('--nointeraction');
  }
  const { stdout } = await execFileAsync(bwBin, finalArgs, {
    env: {
      ...process.env,
      ...(bwSession ? { BW_SESSION: bwSession } : {}),
    },
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export function resolveStatePath(deps = {}) {
  return (
    deps.statePath ||
    process.env.INVOICE_EXTRACTOR_STATE_PATH ||
    join(homedir(), '.config', 'invoice-extractor', 'state.json')
  );
}

export function readLocalState(deps = {}) {
  const statePath = resolveStatePath(deps);
  const empty = {
    profiles: [],
    providerConfigs: {},
    activeProviderIds: [],
    loadedProfileId: null,
    history: [],
    sessionOwners: {},
    vaults: [],
    authMode: null,
    passwordManager: null,
    updatedAt: null,
  };
  if (!existsSync(statePath)) return { ...empty, statePath };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      providerConfigs: parsed.providerConfigs && typeof parsed.providerConfigs === 'object' ? parsed.providerConfigs : {},
      activeProviderIds: Array.isArray(parsed.activeProviderIds) ? parsed.activeProviderIds : [],
      loadedProfileId: parsed.loadedProfileId || null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      sessionOwners: parsed.sessionOwners && typeof parsed.sessionOwners === 'object' ? parsed.sessionOwners : {},
      vaults: Array.isArray(parsed.vaults) ? parsed.vaults : [],
      authMode: parsed.authMode || null,
      passwordManager: parsed.passwordManager || null,
      updatedAt: parsed.updatedAt || null,
      statePath,
    };
  } catch {
    return { ...empty, statePath };
  }
}

export function writeLocalState(patch = {}, { merge = true } = {}, deps = {}) {
  const statePath = resolveStatePath(deps);
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const current = merge ? readLocalState(deps) : {
    profiles: [],
    providerConfigs: {},
    activeProviderIds: [],
    loadedProfileId: null,
    history: [],
    sessionOwners: {},
    vaults: [],
    authMode: null,
    passwordManager: null,
  };

  // Merge profiles by id when merge=true
  let nextProfiles = current.profiles;
  if (Array.isArray(patch.profiles)) {
    if (!merge) {
      nextProfiles = patch.profiles;
    } else {
      const byId = new Map(current.profiles.map(p => [p.id, p]));
      for (const incoming of patch.profiles) {
        if (!incoming?.id) continue;
        const existing = byId.get(incoming.id);
        if (!existing) {
          byId.set(incoming.id, incoming);
        } else {
          const mergedActive = Array.from(new Set([...(existing.activeProviders || []), ...(incoming.activeProviders || [])]));
          const mergedConfigs = { ...(existing.configs || {}) };
          for (const [provId, cfg] of Object.entries(incoming.configs || {})) {
            mergedConfigs[provId] = { ...(mergedConfigs[provId] || {}), ...cfg };
          }
          byId.set(incoming.id, {
            ...existing,
            ...incoming,
            activeProviders: mergedActive,
            configs: mergedConfigs,
          });
        }
      }
      nextProfiles = Array.from(byId.values());
    }
  }

  // Merge providerConfigs
  let nextProviderConfigs = current.providerConfigs;
  if (patch.providerConfigs && typeof patch.providerConfigs === 'object') {
    if (!merge) {
      nextProviderConfigs = patch.providerConfigs;
    } else {
      nextProviderConfigs = { ...current.providerConfigs };
      for (const [provId, cfg] of Object.entries(patch.providerConfigs)) {
        nextProviderConfigs[provId] = { ...(nextProviderConfigs[provId] || {}), ...(cfg || {}) };
      }
    }
  }

  // Merge history (unique strings or objects)
  let nextHistory = current.history;
  if (Array.isArray(patch.history)) {
    if (!merge) {
      nextHistory = patch.history;
    } else {
      const set = new Set([...current.history, ...patch.history].filter(Boolean));
      nextHistory = Array.from(set);
    }
  }

  // Merge custom vaults
  let nextVaults = current.vaults || [];
  if (Array.isArray(patch.vaults)) {
    if (!merge) {
      nextVaults = patch.vaults;
    } else {
      const byVault = new Map(nextVaults.map(v => [String(v.vault || '').toLowerCase(), v]));
      for (const v of patch.vaults) {
        if (v?.vault) byVault.set(String(v.vault).toLowerCase(), v);
      }
      nextVaults = Array.from(byVault.values());
    }
  }

  const nextState = {
    profiles: nextProfiles,
    providerConfigs: nextProviderConfigs,
    activeProviderIds: Array.isArray(patch.activeProviderIds) ? patch.activeProviderIds : current.activeProviderIds,
    loadedProfileId: patch.loadedProfileId !== undefined ? patch.loadedProfileId : current.loadedProfileId,
    history: nextHistory,
    sessionOwners: patch.sessionOwners
      ? (merge ? { ...current.sessionOwners, ...patch.sessionOwners } : patch.sessionOwners)
      : current.sessionOwners,
    vaults: nextVaults,
    authMode: patch.authMode !== undefined ? patch.authMode : current.authMode,
    passwordManager: patch.passwordManager !== undefined ? patch.passwordManager : current.passwordManager,
    updatedAt: new Date().toISOString(),
  };

  writeFileSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`, { mode: 0o600 });
  return { ...nextState, statePath };
}

export async function handleHostRequest(request, deps = {}) {
  const tokens = deps.tokens || loadServiceAccountTokens(deps);
  const runOp = deps.runOp || defaultRunOp;
  const runBw = deps.runBw || defaultRunBw;
  const action = request?.action;

  if (action === 'readLocalState') {
    return readLocalState(deps);
  }

  if (action === 'writeLocalState') {
    return writeLocalState(request?.state || {}, { merge: request?.merge !== false }, deps);
  }

  const localState = readLocalState(deps);
  const vaultConfigs = resolveVaultConfigs(tokens, request?.vaultHint || '', localState.vaults || []);
  const hasBitwarden = Boolean(
    tokens.BW_SESSION ||
    deps.runBw ||
    localState.passwordManager === 'bitwarden' ||
    String(request?.vaultHint || '').toLowerCase() === 'bitwarden'
  );

  if (action === 'listVaults') {
    const vaults = [];
    if (vaultConfigs.length > 0 || !hasBitwarden) {
      const firstToken = vaultConfigs[0]?.token || '';
      const raw = await runOp(['vault', 'list', '--format', 'json'], firstToken);
      const parsed = JSON.parse(raw || '[]');
      for (const v of parsed) vaults.push({ id: v.id, name: v.name, manager: '1password' });
    }
    if (hasBitwarden) {
      const rawFolders = await runBw(['list', 'folders'], tokens.BW_SESSION || '');
      const folders = JSON.parse(rawFolders || '[]');
      for (const f of folders) {
        if (f?.name) vaults.push({ id: f.id || 'bitwarden', name: f.name, manager: 'bitwarden' });
      }
    }
    return { vaults };
  }

  if (action === 'status') {
    const allVaultDefs = [...DEFAULT_VAULTS, ...(localState.vaults || [])];
    return {
      available: vaultConfigs.length > 0 || hasBitwarden,
      passwordManager: localState.passwordManager || (hasBitwarden && vaultConfigs.length === 0 ? 'bitwarden' : '1password'),
      authMode: localState.authMode || (hasBitwarden ? 'bitwarden-session' : Object.keys(tokens).length > 0 ? 'service-account' : 'unconfigured'),
      statePath: localState.statePath,
      bitwarden: {
        configured: hasBitwarden,
      },
      vaults: allVaultDefs.map(v => ({
        alias: v.alias || v.vault.toLowerCase(),
        vault: v.vault,
        configured: Boolean(
          (v.tokenEnv && tokens[v.tokenEnv]) ||
          tokens.OP_SERVICE_ACCOUNT_TOKEN ||
          v.desktopBiometrics
        ),
      })),
    };
  }

  if (vaultConfigs.length === 0 && !hasBitwarden) {
    throw new Error(
      'No 1Password or Bitwarden credentials found. Configure 1Password (OP_SERVICE_ACCOUNT_TOKEN / Desktop Biometrics) or Bitwarden (BW_SESSION).'
    );
  }

  async function listAllItems() {
    const all = [];
    const errors = [];
    for (const vc of vaultConfigs) {
      try {
        const raw = await runOp(['item', 'list', '--vault', vc.vault, '--format', 'json'], vc.token);
        const parsed = JSON.parse(raw || '[]');
        for (const it of parsed) {
          all.push({
            ...it,
            vault: it.vault || { name: vc.vault },
            _vaultConfig: vc,
            _source: '1password',
          });
        }
      } catch (err) {
        errors.push(`${vc.vault}: ${err.message}`);
      }
    }

    if (hasBitwarden) {
      try {
        let folderMap = {};
        try {
          const rawFolders = await runBw(['list', 'folders'], tokens.BW_SESSION || '');
          for (const f of JSON.parse(rawFolders || '[]')) {
            if (f?.id && f?.name) folderMap[f.id] = f.name;
          }
        } catch {
          // Folder listing is optional
        }
        const rawItems = await runBw(['list', 'items'], tokens.BW_SESSION || '');
        const bwItems = JSON.parse(rawItems || '[]');
        for (const bwItem of bwItems) {
          // Skip non-login items if type is present and not 1 (1 = Login in Bitwarden)
          if (bwItem.type && bwItem.type !== 1) continue;
          all.push(normalizeBitwardenItem(bwItem, folderMap));
        }
      } catch (err) {
        errors.push(`Bitwarden: ${err.message}`);
      }
    }

    if (all.length === 0 && errors.length > 0) {
      throw new Error(`Failed to list password manager items (${errors.join('; ')})`);
    }
    return all;
  }

  if (action === 'listItems') {
    const items = await listAllItems();
    return {
      items: items.map(it => ({
        id: it.id,
        title: it.title,
        vault: it.vault?.name || it._vaultConfig?.vault || '',
        tags: Array.isArray(it.tags) ? it.tags : [],
        additional_information: it.additional_information || '',
        urls: (it.urls || []).map(u => u.href).filter(Boolean),
        source: it._source || '1password',
      })),
    };
  }

  if (action === 'discoverProfiles') {
    const items = await listAllItems();
    const discovered = discoverProfilesFromOpItems(items, request.providers || []);
    return {
      profiles: discovered,
      totalItems: items.length,
    };
  }

  async function hydrateCredentials(matchedItem, fieldOverrides = {}) {
    if (matchedItem._source === 'bitwarden') {
      const creds = extractCredentialsFromOpItem(matchedItem, fieldOverrides);
      if (!creds.otp && creds.hasOtpField) {
        try {
          const otpOut = await runBw(['get', 'totp', matchedItem.id], tokens.BW_SESSION || '');
          const trimmedOtp = String(otpOut || '').trim();
          if (/^\d{6,8}$/.test(trimmedOtp)) {
            creds.otp = trimmedOtp;
          }
        } catch {
          // Ignore TOTP error if Bitwarden item has no valid seed or premium TOTP is inactive
        }
      }
      return creds;
    }

    const vc = matchedItem._vaultConfig || vaultConfigs[0];
    const vaultName = matchedItem.vault?.name || vc.vault;
    const rawItem = await runOp(
      ['item', 'get', matchedItem.id, '--vault', vaultName, '--format', 'json'],
      vc.token
    );
    const fullItem = JSON.parse(rawItem);
    const creds = extractCredentialsFromOpItem(fullItem, fieldOverrides);

    if (!creds.otp && creds.hasOtpField) {
      try {
        const otpOut = await runOp(
          ['item', 'get', matchedItem.id, '--vault', vaultName, '--otp'],
          vc.token
        );
        const trimmedOtp = String(otpOut || '').trim();
        if (/^\d{6,8}$/.test(trimmedOtp)) {
          creds.otp = trimmedOtp;
        }
      } catch {
        // Ignore OTP CLI error if item does not have a valid TOTP seed
      }
    }

    return creds;
  }

  if (action === 'resolveProvider') {
    const provider = request.provider || {};
    const billingUrl = request.billingUrl || provider.billingUrl || '';
    const itemOverride = request.itemOverride || '';
    const authConfig = provider.auth || {};

    // Support direct op:// references for usernameRef & passwordRef
    if (authConfig.usernameRef && authConfig.passwordRef && !itemOverride) {
      const uRef = parseOpReference(authConfig.usernameRef);
      const pRef = parseOpReference(authConfig.passwordRef);
      const targetVault = uRef?.vault || pRef?.vault || authConfig.vault || '';
      const vc = resolveVaultConfigs(tokens, targetVault)[0] || vaultConfigs[0];
      const username = String(await runOp(['read', authConfig.usernameRef], vc.token)).trim();
      const password = String(await runOp(['read', authConfig.passwordRef], vc.token)).trim();
      let otp = '';
      if (authConfig.otpRef) {
        otp = String(await runOp(['read', authConfig.otpRef], vc.token)).trim();
      }
      return {
        itemId: uRef?.item || provider.id,
        title: uRef?.item || provider.name || provider.id,
        vault: targetVault || vc.vault,
        username,
        password,
        otp,
        hasOtpField: Boolean(otp),
        urls: [billingUrl].filter(Boolean),
      };
    }

    const items = await listAllItems();
    const matched = matchOpItemForProvider(items, provider, {
      itemOverride,
      billingUrl,
      profileName: request.profileName || '',
      providerConfig: request.providerConfig || {},
    });
    if (!matched) {
      const vaultNames = [
        ...vaultConfigs.map(v => v.vault),
        ...(hasBitwarden ? ['Bitwarden'] : []),
      ];
      throw new Error(
        `No item found for "${itemOverride || provider.name || provider.id}" in vaults (${vaultNames.join(', ')}).`
      );
    }

    return hydrateCredentials(matched, {
      usernameField: authConfig.usernameField,
      passwordField: authConfig.passwordField,
      otpField: authConfig.otpField,
    });
  }

  if (action === 'resolveProfileSync') {
    const items = await listAllItems();
    const endpoint = request.endpoint || '';
    const itemOverride = request.itemOverride || '';

    const pseudoProvider = {
      id: 'profile-sync',
      name: 'Profile Sync',
      billingUrl: endpoint,
      auth: itemOverride ? { item: itemOverride } : undefined,
    };

    let matched = matchOpItemForProvider(items, pseudoProvider, { itemOverride, billingUrl: endpoint });
    if (!matched) {
      matched = items.find(it =>
        /profile.?sync|invoice.?extractor|invoice.?downloader/i.test(String(it.title || ''))
      );
    }
    if (!matched) {
      throw new Error(
        `No item found for Profile Sync in vaults (${vaultConfigs.map(v => v.vault).join(', ')}). Create an item titled "Profile Sync" or "Invoice Extractor" in 1Password or Bitwarden.`
      );
    }

    return hydrateCredentials(matched);
  }

  if (action === 'upsertOpItem') {
    const title = String(request.title || '').trim();
    if (!title) {
      throw new Error('upsertOpItem requires a title.');
    }
    const url = String(request.url || '').trim();
    const username = String(request.username || '').trim();
    const password = String(request.password || '').trim();
    const notes = String(request.notes || '').trim();
    const tags = Array.isArray(request.tags)
      ? request.tags.map(t => String(t || '').trim()).filter(Boolean)
      : String(request.tags || '')
          .split(',')
          .map(t => t.trim())
          .filter(Boolean);

    const targetIsBitwarden =
      String(request.vaultHint || '').toLowerCase() === 'bitwarden' ||
      String(request.manager || '').toLowerCase() === 'bitwarden' ||
      (hasBitwarden && vaultConfigs.length === 0);

    if (targetIsBitwarden) {
      const rawItems = await runBw(['list', 'items'], tokens.BW_SESSION || '');
      const bwItems = JSON.parse(rawItems || '[]');
      const existing = bwItems.find(
        it => String(it.name || '').trim().toLowerCase() === title.toLowerCase()
      );
      const tagLine = tags.length > 0 ? tags.map(t => `#${t}`).join(' ') : '';
      const mergedNotes = [notes, tagLine].filter(Boolean).join('\n');

      const payload = existing
        ? {
            ...existing,
            name: title,
            notes: mergedNotes || existing.notes || null,
            login: {
              ...(existing.login || {}),
              username: username || existing.login?.username || null,
              password: password || existing.login?.password || null,
              uris: url ? [{ match: null, uri: url }] : existing.login?.uris || [],
            },
            fields: [
              ...(Array.isArray(existing.fields)
                ? existing.fields.filter(f => f?.name?.toLowerCase() !== 'profile')
                : []),
              ...tags.map(t => ({ name: 'profile', value: t, type: 0 })),
            ],
          }
        : {
            organizationId: null,
            folderId: null,
            type: 1,
            name: title,
            notes: mergedNotes || null,
            favorite: false,
            fields: tags.map(t => ({ name: 'profile', value: t, type: 0 })),
            login: {
              uris: url ? [{ match: null, uri: url }] : [],
              username: username || null,
              password: password || null,
              totp: null,
            },
            secureNote: null,
            card: null,
            identity: null,
          };

      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      const rawSaved = existing
        ? await runBw(['edit', 'item', existing.id, encoded], tokens.BW_SESSION || '')
        : await runBw(['create', 'item', encoded], tokens.BW_SESSION || '');
      const saved = JSON.parse(rawSaved || '{}');
      return {
        created: !existing,
        updated: Boolean(existing),
        id: saved.id || existing?.id || null,
        title: saved.name || title,
        vault: 'Bitwarden',
        tags,
        itemRef: `bw://Bitwarden/${saved.id || existing?.id || title}`,
      };
    }

    const vc = vaultConfigs[0];
    // Check if an item with the same title already exists in the target vault
    const rawList = await runOp(['item', 'list', '--vault', vc.vault, '--format', 'json'], vc.token);
    const vaultItems = JSON.parse(rawList || '[]');
    const existing = vaultItems.find(
      it => String(it.title || '').trim().toLowerCase() === title.toLowerCase()
    );

    const assignments = [];
    if (username) assignments.push(`username=${username}`);
    if (password) assignments.push(`password=${password}`);
    if (notes) assignments.push(`notesPlain=${notes}`);

    let rawResult;
    if (existing) {
      const editArgs = ['item', 'edit', existing.id, '--vault', vc.vault, '--format', 'json'];
      if (url) editArgs.push('--url', url);
      if (tags.length > 0) {
        const mergedTags = Array.from(new Set([...(existing.tags || []), ...tags]));
        editArgs.push('--tags', mergedTags.join(','));
      }
      editArgs.push(...assignments);
      rawResult = await runOp(editArgs, vc.token);
    } else {
      const createArgs = [
        'item',
        'create',
        '--category',
        'login',
        '--vault',
        vc.vault,
        '--title',
        title,
        '--format',
        'json',
      ];
      if (url) createArgs.push('--url', url);
      if (tags.length > 0) createArgs.push('--tags', tags.join(','));
      createArgs.push(...assignments);
      rawResult = await runOp(createArgs, vc.token);
    }

    const saved = JSON.parse(rawResult || '{}');
    return {
      created: !existing,
      updated: Boolean(existing),
      id: saved.id || existing?.id || null,
      title: saved.title || title,
      vault: vc.vault,
      tags: saved.tags || tags,
      itemRef: `op://${vc.vault}/${saved.id || existing?.id || title}`,
    };
  }

  throw new Error(`Unsupported host action: ${action}`);
}

// Chrome Native Messaging framing over stdin / stdout (32-bit little-endian length prefix)
function writeNativeMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function startNativeMessagingLoop() {
  let buffer = Buffer.alloc(0);
  let processing = Promise.resolve();

  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const msgLength = buffer.readUInt32LE(0);
      if (msgLength > 1024 * 1024) {
        writeNativeMessage({ ok: false, error: 'Native message exceeds 1 MiB limit.' });
        process.exit(1);
      }
      if (buffer.length < 4 + msgLength) break;
      const rawJson = buffer.subarray(4, 4 + msgLength).toString('utf8');
      buffer = buffer.subarray(4 + msgLength);

      processing = processing.then(async () => {
        try {
          const request = JSON.parse(rawJson);
          const data = await handleHostRequest(request);
          writeNativeMessage({ ok: true, data });
        } catch (error) {
          // Ensure tokens never leak in error messages
          const safeMessage = String(error?.message || error).replace(/ops_[A-Za-z0-9_-]+/g, '[REDACTED]');
          writeNativeMessage({ ok: false, error: safeMessage });
        }
      });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startNativeMessagingLoop();
}
