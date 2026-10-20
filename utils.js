// utils.js — Shared DOM helpers for invoice-extractor
// Injected into tab's MAIN world before engine.js
// Available as window.__invoiceUtils
(function() {
  'use strict';

  // Simulate full mouse event sequence — needed for React/MUI components
  function simulateRealClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // Text matching: supports string or array of strings (for multi-language)
  function textMatches(content, textSpec) {
    if (!textSpec) return true;
    const lower = content.toLowerCase();
    const texts = Array.isArray(textSpec) ? textSpec : [textSpec];
    return texts.some(t => lower.includes(t.toLowerCase()));
  }

  // Check if element is visible (has dimensions and not hidden via CSS)
  function isElementVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  // Poll for an element matching selector, returns element or null on timeout
  function waitForElement(selector, timeout = 5000) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const start = Date.now();
      const interval = setInterval(() => {
        const found = document.querySelector(selector);
        if (found || Date.now() - start >= timeout) {
          clearInterval(interval);
          resolve(found || null);
        }
      }, 200);
    });
  }

  // Poll arbitrary condition function, returns result or null on timeout
  function waitForCondition(fn, timeout = 5000, interval = 200) {
    return new Promise(resolve => {
      const result = fn();
      if (result) return resolve(result);
      const start = Date.now();
      const timer = setInterval(() => {
        const r = fn();
        if (r || Date.now() - start >= timeout) {
          clearInterval(timer);
          resolve(r || null);
        }
      }, interval);
    });
  }

  window.__invoiceUtils = {
    simulateRealClick,
    textMatches,
    isElementVisible,
    waitForElement,
    waitForCondition
  };
})();
