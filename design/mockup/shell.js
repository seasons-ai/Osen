(function () {
  'use strict';

  var NAV = [
    { key: 'new', label: 'Новое', href: 'index.html', icon: 'i-plus' },
    { key: 'history', label: 'История', href: 'history.html', icon: 'i-history' },
    { key: 'settings', label: 'Настройки', href: 'settings.html', icon: 'i-settings' },
    { key: 'styleguide', label: 'Образец', href: 'styleguide.html', icon: 'i-doc', service: true }
  ];

  var ICONS = {
    'i-plus': '<path d="M12 5v14M5 12h14"/>',
    'i-history': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    'i-settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    'i-check': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    'i-x': '<path d="M6 6l12 12M18 6L6 18"/>',
    'i-alert': '<path d="M12 3L2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/>',
    'i-question': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17v.5"/>',
    'i-reply': '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
    'i-stop': '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    'i-play': '<path d="M7 4.5v15l12-7.5-12-7.5z"/>',
    'i-copy': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    'i-download': '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    'i-chevron-right': '<path d="M9 5l7 7-7 7"/>',
    'i-chevron-left': '<path d="M15 5l-7 7 7 7"/>',
    'i-chevron-down': '<path d="M5 9l7 7 7-7"/>',
    'i-arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
    'i-arrow-down': '<path d="M12 5v14M5 12l7 7 7-7"/>',
    'i-user-off': '<circle cx="10" cy="8" r="4"/><path d="M3 20a7 7 0 0 1 11-5.7M17 15l5 5M22 15l-5 5"/>',
    'i-terminal': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    'i-cloud': '<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 10a4 4 0 0 1-.5 8H7z"/>',
    'i-key': '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    'i-edit': '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13 7l4 4"/>',
    'i-spark': '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z"/>',
    'i-clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'i-users': '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6"/>',
    'i-refresh': '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
    'i-trash': '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    'i-doc': '<path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    'i-search': '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>',
    'i-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    'i-coins': '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7M15 10.5c3 .2 6 1.2 6 2.5v4c0 1.7-2.7 3-6 3-1.8 0-3.4-.4-4.5-1"/>',
    'i-pin': '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z"/><path d="M12 14v7"/>',
    'i-loop': '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>'
  };

  var body = document.body;

  // 1. icons
  var sprite = Object.keys(ICONS).map(function (id) {
    return '<symbol id="' + id + '" viewBox="0 0 24 24">' + ICONS[id] + '</symbol>';
  }).join('');
  var holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML = '<svg width="0" height="0">' + sprite + '</svg>';
  body.insertBefore(holder, body.firstChild);

  // 2. rail
  var rail = document.querySelector('[data-rail]');
  if (rail) {
    var cur = body.dataset.nav;
    var html = '<div class="rail__brand" aria-hidden="true"><img src="../mockup-osen/brand/svg/osen-mark-small.svg" alt="" width="32" height="32"></div>';
    NAV.forEach(function (n) {
      if (n.service) html += '<div class="rail__spacer"></div>';
      html += '<a class="rail__item' + (n.service ? ' rail__item--service' : '') + '" href="' + n.href + '"' +
        (n.key === cur ? ' aria-current="page"' : '') + '>' +
        '<svg class="icon"><use href="#' + n.icon + '"></use></svg><span>' + n.label + '</span></a>';
    });
    rail.innerHTML = html;
  }

  // 3. variants
  var variants = (body.dataset.variants || '').split(';').map(function (s) {
    var i = s.indexOf(':');
    return i > 0 ? { key: s.slice(0, i).trim(), label: s.slice(i + 1).trim() } : null;
  }).filter(Boolean);
  var bar = document.querySelector('[data-mock-bar]');

  function applyVariant() {
    if (!variants.length) return;
    var h = location.hash.replace(/^#/, '');
    var key = variants.some(function (v) { return v.key === h; }) ? h : variants[0].key;
    body.dataset.variant = key;
    Array.prototype.forEach.call(document.querySelectorAll('[data-variant]'), function (el) {
      el.hidden = el.dataset.variant.split(/\s+/).indexOf(key) < 0;
    });
    if (bar) {
      Array.prototype.forEach.call(bar.querySelectorAll('.mock-bar__link'), function (a) {
        if (a.getAttribute('href') === '#' + key) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    }
  }

  if (bar) {
    if (variants.length > 1) {
      bar.innerHTML = '<span>Макет · состояния:</span>' + variants.map(function (v) {
        return '<a class="mock-bar__link" href="#' + v.key + '">' + v.label + '</a>';
      }).join('');
    } else {
      bar.hidden = true;
    }
  }
  applyVariant();
  window.addEventListener('hashchange', applyVariant);

  // 4. tabs
  function selectTab(tab) {
    var box = tab.closest('[data-tabs]');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('[data-tab]'), function (t) {
      t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-panel]'), function (p) {
      p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-tab][aria-selected="true"]'), selectTab);

  document.addEventListener('click', function (e) {
    var tab = e.target.closest && e.target.closest('[data-tab]');
    if (tab) selectTab(tab);

    // 5. stepper
    var btn = e.target.closest && e.target.closest('.stepper [data-step]');
    if (btn) {
      var st = btn.closest('.stepper');
      var val = st.querySelector('.stepper__value');
      if (!val) return;
      var min = st.dataset.min !== undefined ? Number(st.dataset.min) : -Infinity;
      var max = st.dataset.max !== undefined ? Number(st.dataset.max) : Infinity;
      var n = Number(val.textContent) + Number(btn.dataset.step);
      val.textContent = Math.min(max, Math.max(min, n));
    }
  });

  // 6. decision version comparison (mockup only): switch, v1 locks it
  var sol = document.querySelector('[data-tabs]');
  var cb = sol && sol.querySelector('.solution-tools input');
  function syncDiff(reset) {
    if (!cb) return;
    var v1 = sol.querySelector('[data-tab][aria-selected="true"]').dataset.tab === 'v1';
    if (reset) cb.checked = body.dataset.variant === 'diff';
    if (v1) cb.checked = false;
    cb.disabled = v1;
    sol.querySelector('.solution-tools__hint').hidden = !v1;
    sol.dataset.diff = cb.checked ? 'on' : 'off';
  }
  if (cb) {
    syncDiff(true);
    cb.addEventListener('change', function () { syncDiff(); });
    window.addEventListener('hashchange', function () { syncDiff(true); });
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-tab]')) syncDiff(); });
  }
})();
