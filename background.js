import { createProfileSync, SYNC_ALARM } from './profile-sync.mjs';
import { createOnePasswordBridge } from './onepassword.mjs';

const sync = createProfileSync({ storage: chrome.storage.local });
const onepassword = createOnePasswordBridge();
// Login tokens and private profiles must not be exposed to content scripts.
const storageReady = chrome.storage?.local?.setAccessLevel
  ? chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})
  : Promise.resolve();
const synchronize = () => storageReady.then(() => sync.dispatch('sync')).catch(() => {});
const ensureAlarm = () => {
  try {
    chrome.alarms?.create?.(SYNC_ALARM, { periodInMinutes: 1 });
  } catch {}
};

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); synchronize(); });
ensureAlarm();

chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name === SYNC_ALARM) synchronize();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.profiles &&
      JSON.stringify(changes.profiles.oldValue) !== JSON.stringify(changes.profiles.newValue)) {
    synchronize();
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'profile-sync' && message?.type !== 'onepassword') return;
  // Accept only our extension UI, never a provider tab or another extension.
  const popupUrl = chrome.runtime.getURL('popup.html');
  if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(popupUrl)) {
    sendResponse({ ok: false, error: 'Action is only available from the extension interface.' });
    return;
  }
  const handler = message.type === 'onepassword'
    ? onepassword.dispatch(message.action, message.input)
    : storageReady.then(() => sync.dispatch(message.action, message.input));
  handler.then(
    data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error.message }),
  );
  return true;
});
