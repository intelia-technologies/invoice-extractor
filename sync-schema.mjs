// Only saved profile presets cross devices. Live settings, sessions and downloads stay local.
export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const EMPTY_DOCUMENT = { schemaVersion: 1, profiles: [] };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'prototype', 'constructor'].includes(key);
const keysAre = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const configValue = value => typeof value === 'string' ? value.length <= 8192
  : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

export function validateDocument(document) {
  if (!object(document) || !keysAre(document, ['schemaVersion', 'profiles']) || document.schemaVersion !== 1 ||
      !Array.isArray(document.profiles) || document.profiles.length > 100) {
    throw new Error('Invalid profile document.');
  }
  const ids = new Set();
  for (const profile of document.profiles) {
    if (!object(profile) || !keysAre(profile, ['id', 'name', 'snapshot']) || !text(profile.id, 200) ||
        !safeKey(profile.id) || !text(profile.name, 200) || ids.has(profile.id)) {
      throw new Error('Invalid or duplicate profile.');
    }
    ids.add(profile.id);
    if (profile.snapshot === null) continue;
    const snapshot = profile.snapshot;
    if (!object(snapshot) || !keysAre(snapshot, ['activeProviders', 'configs']) ||
        !Array.isArray(snapshot.activeProviders) || snapshot.activeProviders.length > 500 ||
        snapshot.activeProviders.some(id => !text(id, 200) || !safeKey(id)) ||
        !object(snapshot.configs) || Object.keys(snapshot.configs).length > 500) {
      throw new Error('Invalid profile settings.');
    }
    for (const [id, config] of Object.entries(snapshot.configs)) {
      if (!text(id, 200) || !safeKey(id) || !object(config) || Object.keys(config).length > 100) {
        throw new Error('Invalid provider configuration.');
      }
      for (const [key, value] of Object.entries(config)) {
        if (!text(key, 200) || !safeKey(key) || !(configValue(value) ||
            (Array.isArray(value) && value.length <= 100 && value.every(configValue)))) {
          throw new Error('Invalid configuration value.');
        }
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error('Profile document exceeds 256 KiB.');
  }
  return document;
}

// Object key ordering must not make unchanged settings look modified.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
