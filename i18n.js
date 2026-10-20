// Localization helpers on top of chrome.i18n (language = the browser UI language).
// Messages live in _locales/<lang>/messages.json; placeholders are positional ($1, $2…).

function t(key, substitutions) {
  const subs = substitutions == null ? undefined
    : (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
  let message = '';
  try { message = chrome.i18n.getMessage(key, subs); } catch {}
  return message || key;
}

// Plural keys come in pairs: `${base}One` and `${base}Other`. `substitutions` defaults to [count].
function tp(base, count, substitutions = [count]) {
  return t(`${base}${Number(count) === 1 ? 'One' : 'Other'}`, substitutions);
}

function uiLanguage() {
  try { return chrome.i18n.getUILanguage() || 'en'; } catch { return 'en'; }
}

// Fills elements marked with data-i18n (text) and data-i18n-title / -placeholder / -aria-label.
// A data-i18n element that contains child elements keeps them: each child stands for one
// placeholder of the message, in document order.
function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    const children = [...el.children];
    if (!children.length) {
      el.textContent = t(key);
      continue;
    }
    const parts = t(key, children.map((_, i) => `${i}`)).split(/(\d+)/);
    if (parts.length === 1) continue; // Missing message: leave the original markup untouched.
    el.replaceChildren(...parts.map((part, i) => i % 2 ? children[Number(part)] : document.createTextNode(part)));
  }
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
    }
  }
}

document.documentElement.lang = uiLanguage();
applyI18n();
