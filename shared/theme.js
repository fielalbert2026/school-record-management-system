/* ==========================================================================
   shared/theme.js — Theme toggle for the SRMS project.
   Replaces the 600-char inline style on the theme button + the per-page
   script that set/loaded the theme. All pages link this with `defer`.

   Usage:
     <button class="theme-toggle" id="themeToggleBtn" type="button"
             aria-label="Toggle color theme">🌙</button>
     <script src="shared/theme.js" defer></script>

   Reads localStorage 'srms_theme' (light | dark). Falls back to
   prefers-color-scheme on first load. The pre-paint script in each page's
   <head> sets data-theme before styles render to avoid flash.
   ========================================================================== */
(function () {
  'use strict';
  var KEY = 'srms_theme';

  function getSystemPref() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }
  function read() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === 'light' || v === 'dark') return v;
    } catch (e) {}
    return getSystemPref();
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }
  function apply(v) {
    document.documentElement.setAttribute('data-theme', v);
    var btn = document.getElementById('themeToggleBtn');
    if (btn) {
      btn.innerHTML = v === 'dark'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.7 13A8.8 8.8 0 1 1 11 3.3 7 7 0 0 0 20.7 13Z"></path></svg>';
      btn.setAttribute('aria-label', v === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.title = v === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }
  function toggle() {
    var next = (document.documentElement.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
    apply(next);
    write(next);
  }

  // Apply on load (the head's pre-paint script already set data-theme once;
  // this updates the button label and the localStorage value if needed).
  apply(read());

  // Wire the button when the DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      var btn = document.getElementById('themeToggleBtn');
      if (btn) btn.addEventListener('click', toggle);
    });
  } else {
    var btn = document.getElementById('themeToggleBtn');
    if (btn) btn.addEventListener('click', toggle);
  }

  // Expose for any custom callers (e.g. the drafter settings cog).
  window.SRMS = window.SRMS || {};
  window.SRMS.theme = { get: read, set: write, apply: apply, toggle: toggle };
})();
