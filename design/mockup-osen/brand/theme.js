/*
 * Osen mockup — theme switcher.
 * Load in <head> right after brand/tokens.css: it sets data-theme on <html> before the first paint.
 *
 * The choice is two settings, kept in localStorage under "osen-appearance":
 *   mode    — "dark" | "light" | "system"
 *   variant — the light theme: "tuman" | "len" | "inei" | "pergament"
 * A page opened as page.html#theme=len switches to that theme and remembers it.
 * In settings.html, elements with data-mode / data-variant act as the picker.
 */
(function () {
  var KEY = 'osen-appearance';
  var LIGHT = { tuman: 1, len: 1, inei: 1, pergament: 1 };
  var NAMES = { osen: 'Осень', tuman: 'Туман', len: 'Лён', inei: 'Иней', pergament: 'Пергамент' };
  var HINTS = {
    dark: 'Тёмная тема «Осень». Если выбрать светлую тему ниже, режим переключится сам.',
    light: 'Светлая тема — та, что выбрана ниже.',
    system: 'Следует настройке macOS: днём светлая тема ниже, вечером «Осень».'
  };

  var state = { mode: 'dark', variant: 'tuman' };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (saved.mode === 'dark' || saved.mode === 'light' || saved.mode === 'system') state.mode = saved.mode;
    if (LIGHT[saved.variant]) state.variant = saved.variant;
  } catch (e) {}

  var hash = location.hash.match(/theme=(\w+)/);
  if (hash) {
    if (hash[1] === 'osen') state.mode = 'dark';
    else if (LIGHT[hash[1]]) { state.mode = 'light'; state.variant = hash[1]; }
    save();
  }

  var systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function resolve() {
    if (state.mode === 'dark') return 'osen';
    if (state.mode === 'light') return state.variant;
    return systemDark && systemDark.matches ? 'osen' : state.variant;
  }

  function apply() {
    var theme = resolve();
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme === 'osen' ? 'dark' : 'light';
    if (!document.body) return;
    document.querySelectorAll('[data-mode]').forEach(function (el) {
      el.setAttribute('aria-checked', String(el.getAttribute('data-mode') === state.mode));
    });
    document.querySelectorAll('[data-variant]').forEach(function (el) {
      el.setAttribute('aria-checked', String(el.getAttribute('data-variant') === state.variant));
    });
    var current = document.querySelector('[data-current-theme]');
    if (current) current.textContent = NAMES[theme];
    var hint = document.querySelector('[data-mode-hint]');
    if (hint) hint.textContent = HINTS[state.mode];
  }

  apply();
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-mode], [data-variant]');
    if (!el) return;
    if (el.hasAttribute('data-mode')) {
      state.mode = el.getAttribute('data-mode');
    } else {
      state.variant = el.getAttribute('data-variant');
      // Picking a light theme while in dark mode switches to light,
      // otherwise the click looks like it did nothing.
      if (state.mode === 'dark') state.mode = 'light';
    }
    save();
    apply();
  });
  if (systemDark && systemDark.addEventListener) systemDark.addEventListener('change', apply);
})();
