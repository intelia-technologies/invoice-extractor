// Shared behaviour for every page of the site: language choice, OS-aware download, install tabs,
// logo fallback. Plain ES5 so it runs anywhere without a build step.
(function () {
  var es = document.documentElement.lang === 'es';

  // Remember an explicit language choice so the root page stops auto-redirecting.
  document.querySelectorAll('[data-lang]').forEach(function (a) {
    a.addEventListener('click', function () {
      try { localStorage.setItem('ie-lang', a.dataset.lang); } catch (e) { /* storage blocked */ }
    });
  });

  // Provider logos: a missing image becomes an initials capsule.
  document.querySelectorAll('.logo img').forEach(function (img) {
    function fallback() {
      var cap = img.parentNode;
      var name = img.dataset.name || img.alt || '';
      cap.classList.add('initials');
      cap.textContent = name.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
    }
    if (img.complete && img.naturalWidth === 0) fallback();
    else img.addEventListener('error', fallback);
  });

  // OS detection for the download button and the install tabs.
  var ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
  var os = /win/i.test(ua) ? 'win' : /linux|x11/i.test(ua) && !/android/i.test(ua) ? 'linux' : 'mac';
  // There is one zip for every OS, so the button only changes on phones and tablets, where the
  // download is useless until you are back at a computer.
  var mobile = (navigator.userAgentData && navigator.userAgentData.mobile) ||
    /android|iphone|ipad|ipod|mobi/i.test(navigator.userAgent || '') ||
    (/mac/i.test(ua) && navigator.maxTouchPoints > 1);
  if (mobile) {
    document.querySelectorAll('[data-download-sub]').forEach(function (sub) {
      sub.textContent = es ? 'Para Chrome en tu ordenador' : 'For Chrome on your computer';
    });
  }

  // Bonobot's stamp-and-wave clip: plays once (5 s) the first time it scrolls into view. With reduced
  // motion, or without IntersectionObserver, it never plays and the poster frame stays.
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && 'IntersectionObserver' in window) {
    document.querySelectorAll('video[data-play-once]').forEach(function (video) {
      var seen = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        seen.disconnect();
        video.muted = true;
        var played = video.play();
        if (played && played.catch) played.catch(function () { /* autoplay refused: the poster stays */ });
      }, { threshold: 0.6 });
      seen.observe(video);
    });
  }

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  if (!tabs.length) return;
  function select(target, focus) {
    tabs.forEach(function (t) {
      var on = t.dataset.os === target;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.dataset.panel !== target; });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t.dataset.os); });
    t.addEventListener('keydown', function (e) {
      var step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      select(tabs[(i + step + tabs.length) % tabs.length].dataset.os, true);
    });
  });
  select(os);
})();
