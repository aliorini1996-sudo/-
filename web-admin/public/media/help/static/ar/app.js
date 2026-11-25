(function () {
  'use strict';
  var T = {"lang": "ar", "themeLight": "الوضع الفاتح", "themeDark": "الوضع الداكن", "noResults": "لا توجد نتائج مطابقة", "trackLabel": "العربية", "zoom": "تكبير الصورة", "count": {"zero": "لا توجد شروحات", "one": "شرح واحد", "two": "شرحان", "few": "{n} شروحات", "many": "{n} شرحاً"}};
  var root = document.documentElement;
  var body = document.body;
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
  function $(s, c) { return (c || document).querySelector(s); }
  function $all(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }

  /* dark mode */
  var themeBtn = $('#themeBtn');
  function applyTheme(t) {
    if (t === 'dark') { root.setAttribute('data-theme', 'dark'); } else { root.removeAttribute('data-theme'); }
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
      themeBtn.setAttribute('title', t === 'dark' ? T.themeLight : T.themeDark);
    }
  }
  applyTheme(lsGet('fs-hc-theme') === 'dark' ? 'dark' : 'light');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var t = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(t); lsSet('fs-hc-theme', t);
    });
  }

  /* grid/list view */
  var viewBtns = $all('[data-set-view]');
  function applyView(v) {
    if (v === 'list') { root.setAttribute('data-view', 'list'); } else { root.removeAttribute('data-view'); }
    viewBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-set-view') === v ? 'true' : 'false'); });
  }
  if (viewBtns.length) {
    applyView(lsGet('fs-hc-view') === 'list' ? 'list' : 'grid');
    viewBtns.forEach(function (b) {
      b.addEventListener('click', function () { var v = b.getAttribute('data-set-view'); applyView(v); lsSet('fs-hc-view', v); });
    });
  }

  /* search: strips Arabic diacritics/tatweel and unifies alef, taa marbuta and alef maqsura */
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[ً-ٰٟـ]/g, '')
      .replace(/[آأإٱ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/[^0-9a-zء-ي٠-٩]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function tokens(q) { return norm(q).split(' ').filter(Boolean); }
  function countLabel(n) {
    var c = T.count || {}, k;
    if (n === 0) { k = 'zero'; }
    else if (n === 1) { k = 'one'; }
    else if (T.lang === 'ar') { k = n === 2 ? 'two' : (n <= 10 ? 'few' : 'many'); }
    else { k = 'other'; }
    return String(c[k] || c.other || '{n}').replace('{n}', n);
  }
  var input = $('#q');
  var listing = $('#listing');
  if (input && listing) {
    var cards = $all('[data-card]', listing);
    var groups = $all('[data-group]', listing);
    var empty = $('#empty');
    var count = $('#count');
    cards.forEach(function (c) { c._t = norm(c.getAttribute('data-text') || c.textContent); });
    var filter = function () {
      var tk = tokens(input.value), shown = 0;
      cards.forEach(function (c) {
        var ok = tk.every(function (t) { return c._t.indexOf(t) > -1; });
        c.hidden = !ok; if (ok) { shown++; }
      });
      groups.forEach(function (g) { g.hidden = !$('[data-card]:not([hidden])', g); });
      if (empty) { empty.hidden = shown > 0 || !cards.length; }
      if (count) { count.textContent = countLabel(shown); }
    };
    input.addEventListener('input', filter);
    input.addEventListener('search', filter);
    try {
      var m = /[?&]q=([^&]*)/.exec(window.location.search);
      if (m) { input.value = decodeURIComponent(m[1].replace(/\+/g, ' ')); }
    } catch (e) { /* ignore */ }
    filter();
  } else if (input) {
    var res = $('#qres');
    var idx = window.HC_INDEX || [];
    var base = body.getAttribute('data-art') || '';
    var home = body.getAttribute('data-home') || 'index.html';
    idx.forEach(function (a) { a._t = norm(a.t + ' ' + a.s + ' ' + a.c); });
    var render = function () {
      if (!res) { return; }
      var tk = tokens(input.value);
      res.textContent = '';
      if (!tk.length) { res.hidden = true; return; }
      var hits = idx.filter(function (a) { return tk.every(function (t) { return a._t.indexOf(t) > -1; }); }).slice(0, 7);
      if (!hits.length) {
        var d = document.createElement('div'); d.className = 'none'; d.textContent = T.noResults; res.appendChild(d);
      }
      hits.forEach(function (a) {
        var l = document.createElement('a'); l.href = base + a.id + '.html'; l.textContent = a.t;
        var sm = document.createElement('small'); sm.textContent = a.c; l.appendChild(sm); res.appendChild(l);
      });
      res.hidden = false;
    };
    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && norm(input.value)) { window.location.href = home + '?q=' + encodeURIComponent(input.value.trim()); }
      if (e.key === 'Escape' && res) { res.hidden = true; }
    });
    document.addEventListener('click', function (e) { if (res && !e.target.closest('.search')) { res.hidden = true; } });
  }

  /* video: captions (injected from the embedded data when the .vtt cannot load) and jump-to-step */
  var video = $('video[data-tutorial]');
  if (video) {
    var cuesEl = $('#vtt-cues');
    var trackEl = $('track', video);
    var injected = false;
    var inject = function (show) {
      if (injected || !cuesEl || !window.VTTCue || !video.addTextTrack) { return; }
      injected = true;
      try {
        var cues = JSON.parse(cuesEl.textContent || '[]');
        if (trackEl && trackEl.parentNode) { trackEl.parentNode.removeChild(trackEl); }
        var tt = video.addTextTrack('subtitles', T.trackLabel, T.lang);
        cues.forEach(function (c) { tt.addCue(new window.VTTCue(c[0], c[1], c[2])); });
        if (show) { tt.mode = 'showing'; }
      } catch (e) { /* captions stay optional */ }
    };
    if (window.location.protocol === 'file:') { inject(false); }
    else if (trackEl) { trackEl.addEventListener('error', function () { inject(true); }); }
    $all('[data-seek]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = parseFloat(b.getAttribute('data-seek')) || 0;
        try { video.currentTime = t; var p = video.play(); if (p && p.catch) { p.catch(function () {}); } } catch (e) { /* ignore */ }
        video.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    });
  }

  /* screenshot lightbox */
  var lb = null;
  function closeLb() { if (lb) { lb.parentNode.removeChild(lb); lb = null; } }
  document.addEventListener('click', function (e) {
    if (lb) { closeLb(); return; }
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-zoom')) {
      lb = document.createElement('div'); lb.className = 'lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-label', T.zoom);
      var im = document.createElement('img'); im.src = t.currentSrc || t.src; im.alt = t.alt || ''; lb.appendChild(im);
      document.body.appendChild(lb);
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeLb(); } });
})();
