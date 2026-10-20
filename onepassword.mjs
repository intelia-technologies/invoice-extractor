// 1Password credential resolution & Native Messaging bridge.
// Service Account tokens remain in ~/.zshrc.local inside the local Native Messaging
// host process and are never exposed to the browser or stored in chrome.storage.

export const NATIVE_HOST_NAME = 'com.intelia.invoice_extractor.op';

export const DEFAULT_VAULTS = [
  { alias: 'intelia', vault: 'AI', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN_INTELIA' },
  { alias: 'lana', vault: 'AI bots', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN_LANA' },
];

const SUBDOMAIN_PREFIXES = /^(www|billing|dashboard|console|admin|app|my|accounts|account|auth|login|cloud|portal|secure|pay|invoices)\./i;

export function normalizeHostname(urlOrHost) {
  if (!urlOrHost || typeof urlOrHost !== 'string') return { host: '', root: '' };
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (/^https?:\/\//i.test(host)) {
      host = new URL(host).hostname.toLowerCase();
    } else {
      host = new URL(`https://${host.replace(/^\/*/, '')}`).hostname.toLowerCase();
    }
  } catch {
    host = host.split('/')[0].split(':')[0].toLowerCase();
  }
  host = host.replace(/\.$/, '');
  const stripped = host.replace(SUBDOMAIN_PREFIXES, '');
  const parts = stripped.split('.');
  const root = parts.length >= 2 ? parts.slice(-2).join('.') : stripped;
  return { host, root };
}

export function parseOpReference(ref) {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  const match = trimmed.match(/^(op|bw):\/\/([^/]+)\/([^/]+)(?:\/(.+))?$/i);
  if (!match) return null;
  return {
    scheme: match[1].toLowerCase(),
    vault: match[2].trim(),
    item: match[3].trim(),
    field: match[4] ? match[4].trim() : null,
  };
}

export function normalizeBitwardenItem(bwItem, folderMap = {}) {
  if (!bwItem || typeof bwItem !== 'object') return null;
  const login = bwItem.login || {};
  const folderName = (bwItem.folderId && folderMap[bwItem.folderId]) || '';

  const tags = [];
  if (folderName && !/^(no folder|sin carpeta|default)$/i.test(folderName)) {
    tags.push(folderName);
  }

  // Extract tags from custom fields named tag/tags/client/cliente/profile
  const customFields = Array.isArray(bwItem.fields) ? bwItem.fields : [];
  for (const cf of customFields) {
    const fName = String(cf?.name || '').trim().toLowerCase();
    if (/^(tag|tags|client|cliente|profile|empresa)$/i.test(fName) && cf.value) {
      for (const part of String(cf.value).split(',')) {
        const clean = part.trim();
        if (clean) tags.push(clean);
      }
    }
  }

  // Also extract #hashtag or [Tag] tokens from notes or item name
  const textToScan = `${bwItem.name || ''} ${bwItem.notes || ''}`;
  for (const m of textToScan.matchAll(/(?:^|\s)#([A-Za-z0-9_-]{2,})|\[([A-Za-z0-9 _-]{2,})\]/g)) {
    const tag = (m[1] || m[2] || '').trim();
    if (tag) tags.push(tag);
  }

  const urls = (Array.isArray(login.uris) ? login.uris : [])
    .map(u => ({ href: typeof u === 'string' ? u : u?.uri }))
    .filter(u => u.href);

  const fields = [
    { id: 'username', label: 'username', purpose: 'USERNAME', value: login.username || '' },
    { id: 'password', label: 'password', purpose: 'PASSWORD', type: 'CONCEALED', value: login.password || '' },
  ];
  if (login.totp) {
    fields.push({
      id: 'totp',
      label: 'one-time password',
      type: 'OTP',
      totp: /^\d{6,8}$/.test(String(login.totp).trim()) ? String(login.totp).trim() : '',
      value: String(login.totp),
    });
  }
  for (const cf of customFields) {
    if (cf?.name) {
      fields.push({ id: cf.name, label: cf.name, value: cf.value || '' });
    }
  }

  return {
    id: bwItem.id,
    title: bwItem.name || '',
    vault: { name: folderName || 'Bitwarden' },
    tags: Array.from(new Set(tags)),
    additional_information: login.username || '',
    username: login.username || '',
    urls,
    fields,
    _source: 'bitwarden',
  };
}

export function matchOpItemForProvider(
  items,
  provider,
  { itemOverride = '', billingUrl = '', profileName = '', providerConfig = {} } = {}
) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const explicitRef = (itemOverride || provider?.auth?.item || '').trim();
  const explicitVault = (provider?.auth?.vault || '').trim().toLowerCase();

  const filterByVault = (list, vaultName) => {
    if (!vaultName) return list;
    const vLower = vaultName.toLowerCase();
    const matched = list.filter(it => {
      const itemVault = (it.vault?.name || it.vault?.id || '').toLowerCase();
      return (
        itemVault === vLower ||
        (vLower.includes('intelia') && itemVault === 'ai') ||
        (vLower.includes('lana') && itemVault === 'ai bots')
      );
    });
    return matched.length > 0 ? matched : list;
  };

  // Context tokens from active profile name + provider config (e.g. authuser, orgName, billingAccount)
  const contextTokens = [
    profileName,
    ...Object.entries(providerConfig || {})
      .filter(([k, v]) => !k.startsWith('_') && typeof v === 'string' && v.trim())
      .map(([, v]) => v.trim()),
  ]
    .map(t => String(t || '').trim().toLowerCase())
    .filter(t => t.length >= 2);

  const contextBonus = (item) => {
    if (contextTokens.length === 0) return 0;
    let bonus = 0;
    const title = String(item.title || '').toLowerCase();
    const info = String(item.additional_information || item.username || '').toLowerCase();
    const tags = Array.isArray(item.tags) ? item.tags.map(t => String(t).toLowerCase()).join(' ') : '';
    const vaultName = String(item.vault?.name || item._vaultConfig?.vault || '').toLowerCase();
    const vaultAlias = String(item._vaultConfig?.alias || '').toLowerCase();
    const urlsText = (Array.isArray(item.urls) ? item.urls : [])
      .map(u => String(typeof u === 'string' ? u : u?.href || '').toLowerCase())
      .join(' ');

    for (const token of contextTokens) {
      if (info && (info === token || info.includes(token) || token.includes(info))) bonus += 5;
      if (title.includes(token)) bonus += 4;
      if (tags.includes(token)) bonus += 4;
      if (urlsText.includes(token)) bonus += 3;
      if (
        vaultName === token ||
        vaultAlias === token ||
        (token.includes('intelia') && vaultName === 'ai') ||
        (token.includes('lana') && vaultName === 'ai bots')
      ) {
        bonus += 3;
      }
    }
    return bonus;
  };

  // 1. Explicit item reference or title/ID override
  if (explicitRef) {
    const parsed = parseOpReference(explicitRef);
    const targetName = (parsed ? parsed.item : explicitRef).toLowerCase();
    const targetVault = parsed ? parsed.vault : explicitVault;
    const pool = filterByVault(items, targetVault);

    const exactMatches = pool.filter(it =>
      String(it.id || '').toLowerCase() === targetName ||
      String(it.title || '').trim().toLowerCase() === targetName
    );
    if (exactMatches.length > 0) {
      return exactMatches.sort((a, b) => contextBonus(b) - contextBonus(a))[0];
    }

    const partialMatches = pool.filter(it =>
      String(it.title || '').toLowerCase().includes(targetName)
    );
    if (partialMatches.length > 0) {
      return partialMatches.sort((a, b) => contextBonus(b) - contextBonus(a))[0];
    }
  }

  const candidatePool = filterByVault(items, explicitVault);

  // 2. Match by billingUrl / provider domain against item URLs
  const targetUrl = (billingUrl || provider?.billingUrl || '').replace(/\{\{config\.\w+\}\}/g, 'app');
  const { host: targetHost, root: targetRoot } = normalizeHostname(targetUrl);

  if (targetHost) {
    const scoredUrlMatches = [];

    for (const item of candidatePool) {
      const urls = Array.isArray(item.urls) ? item.urls : [];
      let urlScore = 0;
      for (const u of urls) {
        const href = typeof u === 'string' ? u : u?.href;
        const { host: itemHost, root: itemRoot } = normalizeHostname(href);
        if (!itemHost) continue;
        if (itemHost === targetHost && urlScore < 30) {
          urlScore = 30;
        } else if (itemRoot && targetRoot && itemRoot === targetRoot && urlScore < 20) {
          urlScore = 20;
        }
      }
      if (urlScore > 0) {
        scoredUrlMatches.push({ item, score: urlScore + contextBonus(item) });
      }
    }

    if (scoredUrlMatches.length > 0) {
      scoredUrlMatches.sort((a, b) => b.score - a.score);
      return scoredUrlMatches[0].item;
    }
  }

  // 3. Match by provider name or id against item title
  const provName = String(provider?.name || '').trim().toLowerCase();
  const provId = String(provider?.id || '').trim().toLowerCase();
  const normalizedId = provId.replace(/-/g, ' ');

  if (provName || provId) {
    const scoredTitleMatches = [];
    const wordBoundary = (title, needle) => {
      if (!needle || needle.length < 3) return false;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\b|\\s|-|_)${escaped}(?:$|\\b|\\s|-|_)`, 'i').test(title);
    };

    for (const item of candidatePool) {
      const title = String(item.title || '').trim().toLowerCase();
      if (!title) continue;
      let titleScore = 0;
      if (title === provName || title === provId || title === normalizedId) {
        titleScore = 25;
      } else if (
        wordBoundary(title, provName) ||
        wordBoundary(title, provId) ||
        wordBoundary(title, normalizedId)
      ) {
        titleScore = 15;
      }
      if (titleScore > 0) {
        scoredTitleMatches.push({ item, score: titleScore + contextBonus(item) });
      }
    }

    if (scoredTitleMatches.length > 0) {
      scoredTitleMatches.sort((a, b) => b.score - a.score);
      return scoredTitleMatches[0].item;
    }
  }

  return null;
}

export function extractCredentialsFromOpItem(item, fieldOverrides = {}) {
  if (!item || typeof item !== 'object') {
    throw new Error('Invalid 1Password item payload.');
  }

  const fields = Array.isArray(item.fields) ? item.fields : [];
  const findByLabelOrId = (name) => {
    if (!name) return null;
    const lower = name.toLowerCase();
    return fields.find(f =>
      String(f.id || '').toLowerCase() === lower ||
      String(f.label || '').trim().toLowerCase() === lower
    );
  };

  // Username resolution
  let usernameField =
    findByLabelOrId(fieldOverrides.usernameField) ||
    fields.find(f => f.purpose === 'USERNAME' && f.value) ||
    fields.find(f => /^(username|user|email|correo|login|account)$/i.test(String(f.label || f.id || '').trim()) && f.value) ||
    fields.find(f => f.purpose === 'USERNAME');

  // Password resolution
  let passwordField =
    findByLabelOrId(fieldOverrides.passwordField) ||
    fields.find(f => f.purpose === 'PASSWORD' && f.value) ||
    fields.find(f => f.type === 'CONCEALED' && /^(password|contraseña|pass|secret|token|api.?key)$/i.test(String(f.label || f.id || '').trim()) && f.value) ||
    fields.find(f => f.type === 'CONCEALED' && f.value) ||
    fields.find(f => f.purpose === 'PASSWORD');

  // OTP / 2FA resolution
  let otpField =
    findByLabelOrId(fieldOverrides.otpField) ||
    fields.find(f => f.type === 'OTP' || f.totp || /^(otp|totp|2fa|two-factor|one-time password)$/i.test(String(f.label || f.id || '').trim()));

  // Endpoint / URL resolution (helpful for profile-sync)
  let endpointField =
    findByLabelOrId(fieldOverrides.endpointField) ||
    fields.find(f => /^(endpoint|url|server|sync.?url|service.?url)$/i.test(String(f.label || f.id || '').trim()) && f.value);

  const urls = (Array.isArray(item.urls) ? item.urls : [])
    .map(u => (typeof u === 'string' ? u : u?.href))
    .filter(Boolean);

  return {
    itemId: item.id || null,
    title: item.title || '',
    vault: item.vault?.name || item.vault?.id || '',
    username: usernameField?.value ? String(usernameField.value) : '',
    password: passwordField?.value ? String(passwordField.value) : '',
    otp: otpField?.totp ? String(otpField.totp) : (otpField?.value && /^\d{6,8}$/.test(String(otpField.value).trim()) ? String(otpField.value).trim() : ''),
    hasOtpField: Boolean(otpField),
    endpoint: endpointField?.value ? String(endpointField.value).trim() : (urls[0] || ''),
    urls,
  };
}

export function extractConfigFromUrls(urls = [], provider = {}) {
  const extracted = {};
  if (!Array.isArray(urls) || urls.length === 0 || !provider?.config) return extracted;

  const cleanUrls = urls
    .map(u => String(typeof u === 'string' ? u : u?.href || '').trim())
    .filter(Boolean);

  for (const [key, def] of Object.entries(provider.config)) {
    for (const rawUrl of cleanUrls) {
      // 1. Check explicit capture.urlPattern if defined on the config field
      if (def?.capture?.urlPattern) {
        try {
          const m = rawUrl.match(new RegExp(def.capture.urlPattern, 'i'));
          if (m?.[1]) {
            extracted[key] = def.multi ? [m[1]] : m[1];
            break;
          }
        } catch {}
      }

      // 2. Match against billingUrl template prefix up to {{config.<key>}}
      const token = `{{config.${key}}}`;
      const template = String(provider.billingUrl || '');
      const idx = template.indexOf(token);
      if (idx !== -1) {
        const prefix = template
          .slice(0, idx)
          .replace(/\{\{config\.\w+\}\}/g, '[^/?#]+')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\\\[\\\^\/\\\?\\#\\\]\\\+/g, '[^/?#]+');
        try {
          const re = new RegExp(`^${prefix}([^/?#]+)`, 'i');
          const m = rawUrl.match(re);
          if (m?.[1]) {
            const candidate = decodeURIComponent(m[1]);
            // Avoid capturing generic static words like "settings", "login", "dashboard", "billing"
            if (/^(settings|login|signin|dashboard|billing|home|orgs|organizations|enterprises|u)$/i.test(candidate)) {
              continue;
            }
            if (def.pattern && !new RegExp(def.pattern).test(candidate)) {
              continue;
            }
            extracted[key] = def.multi ? [candidate] : candidate;
            break;
          }
        } catch {}
      }
    }
  }
  return extracted;
}

export function discoverProfilesFromOpItems(items, providers = []) {
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(providers) || providers.length === 0) {
    return [];
  }

  const IGNORED_TAGS = new Set([
    'login', 'password', '2fa', 'otp', 'totp', 'billing', 'invoice', 'invoices',
    'facturas', 'factura', 'ai', '1password', 'saas', 'shared', 'admin', 'bot', 'bots',
  ]);

  const toSlug = (str) =>
    String(str || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const toDisplayName = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    // Keep original casing if it already has uppercase letters
    if (/[A-Z]/.test(trimmed)) return trimmed;
    return trimmed
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  };

  // Group items by client tag (or fallback to vault team alias/name when untagged)
  const groups = new Map();
  const addGroupItem = (rawKey, item) => {
    const id = toSlug(rawKey);
    if (!id || IGNORED_TAGS.has(id)) return;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        name: toDisplayName(rawKey),
        items: [],
      });
    }
    groups.get(id).items.push(item);
  };

  for (const item of items) {
    const rawTags = Array.isArray(item.tags) ? item.tags : [];
    const clientTags = rawTags
      .map(t => String(t || '').trim())
      .filter(t => t && !IGNORED_TAGS.has(toSlug(t)));

    if (clientTags.length > 0) {
      for (const tag of clientTags) {
        addGroupItem(tag, item);
      }
    } else {
      const vaultName = String(item.vault?.name || item.vault || item._vaultConfig?.vault || '').trim();
      const vaultLower = vaultName.toLowerCase();
      if (vaultLower === 'ai' || item._vaultConfig?.alias === 'intelia') {
        addGroupItem('Intelia', item);
      } else if (vaultLower === 'ai bots' || item._vaultConfig?.alias === 'lana') {
        addGroupItem('Lana', item);
      } else if (vaultName) {
        addGroupItem(vaultName, item);
      }
    }
  }

  const discovered = [];
  for (const group of groups.values()) {
    const activeProviders = [];
    const configs = {};

    for (const provider of providers) {
      const matched = matchOpItemForProvider(group.items, provider, {
        profileName: group.name,
      });
      if (!matched) continue;

      activeProviders.push(provider.id);
      const vaultName = matched.vault?.name || matched.vault || matched._vaultConfig?.vault || 'AI';
      const scheme = matched._source === 'bitwarden' ? 'bw' : 'op';
      const itemRef = `${scheme}://${vaultName}/${matched.id || matched.title}`;
      const provConfig = {
        _onepasswordItem: itemRef,
        ...extractConfigFromUrls(matched.urls || [], provider),
      };

      // Pre-fill authuser if the provider uses it and 1Password item summary includes an email
      const info = String(matched.additional_information || matched.username || '').trim();
      if (provider.config?.authuser && info.includes('@')) {
        provConfig.authuser = info;
      }

      configs[provider.id] = provConfig;
    }

    if (activeProviders.length > 0) {
      discovered.push({
        id: group.id,
        name: group.name,
        activeProviders,
        configs,
      });
    }
  }

  return discovered;
}

export function createOnePasswordBridge({ sendNativeMessage } = {}) {
  const send = sendNativeMessage || ((host, msg) => chrome.runtime.sendNativeMessage(host, msg));

  async function callHost(payload) {
    let response;
    try {
      response = await send(NATIVE_HOST_NAME, payload);
    } catch (error) {
      const msg = error?.message || String(error);
      if (/Specified native messaging host not found|Access to the specified native messaging host is forbidden/i.test(msg)) {
        throw new Error(
          '1Password Native Host is not registered for this browser profile. Run: npm run install:1password'
        );
      }
      throw new Error(`1Password host error: ${msg}`);
    }
    if (!response?.ok) {
      throw new Error(response?.error || '1Password lookup failed.');
    }
    return response.data;
  }

  return {
    async dispatch(action, input = {}) {
      switch (action) {
        case 'status':
          return callHost({ action: 'status' });
        case 'listItems':
          return callHost({
            action: 'listItems',
            vaultHint: input.vaultHint || '',
          });
        case 'discoverProfiles':
          return callHost({
            action: 'discoverProfiles',
            providers: input.providers || [],
            vaultHint: input.vaultHint || '',
          });
        case 'resolveProvider':
          return callHost({
            action: 'resolveProvider',
            provider: input.provider || {},
            billingUrl: input.billingUrl || '',
            itemOverride: input.itemOverride || '',
            vaultHint: input.vaultHint || '',
            profileName: input.profileName || '',
            providerConfig: input.providerConfig || {},
          });
        case 'resolveProfileSync':
          return callHost({
            action: 'resolveProfileSync',
            endpoint: input.endpoint || '',
            itemOverride: input.itemOverride || '',
            vaultHint: input.vaultHint || '',
          });
        case 'readLocalState':
          return callHost({ action: 'readLocalState' });
        case 'writeLocalState':
          return callHost({
            action: 'writeLocalState',
            state: input.state || {},
            merge: input.merge !== false,
          });
        case 'upsertOpItem':
          return callHost({
            action: 'upsertOpItem',
            vaultHint: input.vaultHint || '',
            title: input.title || '',
            url: input.url || '',
            username: input.username || '',
            password: input.password || '',
            tags: input.tags || [],
            notes: input.notes || '',
          });
        default:
          throw new Error(`Unknown 1Password action: ${action}`);
      }
    },
  };
}
