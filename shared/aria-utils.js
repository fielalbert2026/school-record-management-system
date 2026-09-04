/* ==========================================================================
   shared/aria-utils.js — Tiny helpers for ARIA live regions.

   Usage:
     <div id="myError" aria-live="polite" class="error-banner"></div>
     <script>SRMS.announce(document.getElementById('myError'), 'Could not save.');</script>

   The announce() function sets textContent, then clears it after a short
   delay so the same message can be re-announced later (screen readers
   don't re-announce identical textContent).
   ========================================================================== */
(function () {
  'use strict';

  function announce(el, msg) {
    if (!el) return;
    el.textContent = msg || '';
    // Clear after a short delay so a subsequent identical message fires again.
    clearTimeout(el._srmsClearTimer);
    el._srmsClearTimer = setTimeout(function () {
      // Setting to a single space is the standard trick to force a re-render
      // without leaving stray text. The element visually stays empty.
      if (el.textContent === (msg || '')) el.textContent = ' ';
    }, 1200);
  }

  function bindLiveRegion(el) {
    if (!el) return;
    el.setAttribute('aria-live', el.getAttribute('aria-live') || 'polite');
    el.setAttribute('role', el.getAttribute('role') || 'status');
  }

  window.SRMS = window.SRMS || {};
  window.SRMS.announce = announce;
  window.SRMS.bindLiveRegion = bindLiveRegion;
})();
