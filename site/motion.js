// Calco motion scenes (designer delivery of 2026-10-20), adapted to this page. The HTML holds each
// scene's final state; the head script adds `mo` to <html> only when motion is allowed, and motion.js
// then plays each scene once, when it enters view. Turning on reduced motion mid-visit stops every
// scene on its final state. Plain ES5, no dependencies, no network.
(function () {
  var root = document.documentElement;
  if (!root.classList.contains('mo')) return;
  window.ieMotion = true;

  var timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  // Step times in ms from the trigger, from the designer's timing sheets. Step n turns on every
  // [data-at] <= n inside the scene; `end` is when the scene settles on its final frame.
  var SCENES = {
    hero: { steps: [320, 500, 680, 860, 1040, 1220, 1400, 1980, 2160], end: 2800 },
    security: { steps: [0, 400, 1000, 1000, 1660, 2040, 2180], end: 2600 },
    chat: { steps: [1200, 2000, 2500, 2940], end: 3400, type: 1200 },
    diy: { steps: [500, 900], end: 1400, press: 120 }
  };

  // Lists that light item by item as they are read: [selector, stagger ms, visible share].
  var GROUPS = [['.run > .beat', 450, 0.5], ['.providers > li', 45, 0.25], ['.howto > li', 300, 0.6]];

  function waitText(scene, waiting) {
    each(scene.querySelectorAll('[data-mo-wait]'), function (el) {
      if (!el.hasAttribute('data-mo-final')) el.setAttribute('data-mo-final', el.textContent);
      el.textContent = el.getAttribute(waiting ? 'data-mo-wait' : 'data-mo-final');
    });
  }
  function setCount(scene, n) {
    var c = scene.querySelector('[data-mo-count]');
    if (!c) return;
    if (!c.hasAttribute('data-mo-final')) c.setAttribute('data-mo-final', c.textContent);
    c.textContent = n === null ? c.getAttribute('data-mo-final') : String(n);
  }

  function setStep(scene, name, n) {
    each(scene.querySelectorAll('[data-at]'), function (el) {
      if (Number(el.getAttribute('data-at')) <= n) el.classList.add('is-on');
    });
    if (name === 'hero') setCount(scene, Math.min(n, scene.querySelectorAll('.tape li').length));
    if (name === 'chat' && n >= 2) waitText(scene, false);
  }

  function play(scene) {
    var name = scene.getAttribute('data-mo');
    var cfg = SCENES[name];
    scene.classList.add('mo-run');
    if (cfg.type) {
      var text = scene.querySelector('.mo-type-real').textContent;
      var out = scene.querySelector('.mo-type');
      for (var i = 1; i <= text.length; i++) {
        (function (k) { later(function () { out.textContent = text.slice(0, k); }, k * cfg.type / text.length); })(i);
      }
    }
    if (cfg.press) {
      var button = scene.querySelector('.ui-button');
      later(function () { button.classList.add('mo-press'); }, cfg.press);
      later(function () { button.classList.remove('mo-press'); }, cfg.press + 280);
    }
    cfg.steps.forEach(function (ms, i) { later(function () { setStep(scene, name, i + 1); }, ms); });
    later(function () { scene.classList.remove('mo-run'); scene.classList.add('mo-done'); }, cfg.end);
  }

  // Stage every scene on its first frame, then play it the first time a quarter of it is in view.
  var scenes = document.querySelectorAll('[data-mo]');
  each(scenes, function (scene) {
    var name = scene.getAttribute('data-mo');
    if (name === 'hero') setCount(scene, 0);
    if (name === 'chat') waitText(scene, true);
  });
  var sceneSeen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      sceneSeen.unobserve(e.target);
      play(e.target);
    });
  }, { threshold: 0.24 });
  each(scenes, function (scene) { sceneSeen.observe(scene); });

  var groupObservers = GROUPS.map(function (g) {
    var io = new IntersectionObserver(function (entries) {
      var k = 0;
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        var el = e.target;
        later(function () {
          el.classList.add('is-on', 'mo-play');
          later(function () { el.classList.remove('mo-play'); }, 700);
        }, g[1] * k++);
      });
    }, { threshold: g[2] });
    each(document.querySelectorAll(g[0]), function (el) { io.observe(el); });
    return io;
  });

  // Language switch: the pill slides to the other language before the page changes.
  var lang = document.querySelector('.topbar .lang');
  var cur = lang && lang.querySelector('[aria-current]');
  var next = lang && lang.querySelector('a[data-lang]');
  function placePill() {
    lang.style.setProperty('--mo-pill-l', cur.offsetLeft + 'px');
    lang.style.setProperty('--mo-pill-t', cur.offsetTop + 'px');
    lang.style.setProperty('--mo-pill-w', cur.offsetWidth + 'px');
    lang.style.setProperty('--mo-pill-h', cur.offsetHeight + 'px');
  }
  if (cur && next) {
    lang.classList.add('mo-lang-ready'); // positions .lang first, so offsets are measured inside it
    placePill();
    next.addEventListener('click', function (e) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !root.classList.contains('mo')) return;
      e.preventDefault();
      placePill();
      lang.style.setProperty('--mo-pill-x', (next.offsetLeft - cur.offsetLeft) + 'px');
      lang.classList.add('mo-lang-go');
      setTimeout(function () { location.href = next.href; }, 220);
    });
    // Coming back through the history cache shows the page as it was left: put the pill back.
    window.addEventListener('pageshow', function () { lang.classList.remove('mo-lang-go'); lang.style.removeProperty('--mo-pill-x'); });
  }

  // Reduced motion switched on mid-visit: stop everything and show every final state.
  var media = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  function stop() {
    if (!media.matches) return;
    timers.forEach(clearTimeout);
    sceneSeen.disconnect();
    groupObservers.forEach(function (io) { io.disconnect(); });
    each(scenes, function (scene) { waitText(scene, false); setCount(scene, null); });
    root.classList.remove('mo');
  }
  if (media) {
    if (media.addEventListener) media.addEventListener('change', stop);
    else if (media.addListener) media.addListener(stop);
  }
})();
