/* ==========================================================================
   shared/api-fallback.js — AI drafter for the Card Drafter page.
   Detection chain (simplified — universal key on the server):
     1. Probe /api/draft-cards. If 200, use the server's universal Gemini key.
     2. If 404 / 500 / network error, drafting is not available; the UI shows
        a banner telling the user to type cards in by hand. The user-key
        paste path has been removed — there is no longer a per-user key to
        fall back to. The server holds one key for everyone.

   The wire format is the Anthropic-normalized shape
   { content: [{ type: 'text', text }] } so the existing drafter parser
   is unchanged regardless of which path was used.
   ========================================================================== */
(function () {
  'use strict';

  var PATH_CACHE = 'srms_draft_path'; // sessionStorage cache of the resolved path

  function getCachedPath() {
    try { return sessionStorage.getItem(PATH_CACHE) || ''; } catch (e) { return ''; }
  }
  function setCachedPath(p) {
    try { sessionStorage.setItem(PATH_CACHE, p); } catch (e) {}
  }

  function expandFallback(reason) {
    var status = document.getElementById('genStatus') || document.getElementById('drafterStatus');
    if (status) {
      status.className = 'status-banner warn';
      var reasonText = reason === 'not-deployed'
        ? 'AI drafting isn\'t deployed on this server.'
        : reason === 'not-configured'
          ? 'AI drafting isn\'t configured on this server.'
          : 'Couldn\'t reach the AI server.';
      status.textContent = reasonText + ' Type cards in by hand using the "Add card" panel below.';
    }
    var draftBtn = document.getElementById('generateBtn');
    if (draftBtn) {
      draftBtn.disabled = true;
      draftBtn.title = 'AI drafting isn\'t available right now. Type cards in by hand using the "Add card" panel below.';
    }
  }

  // Main entry. Returns Anthropic-normalized { content: [...] } on success.
  // Throws an Error whose message === 'NOT_CONFIGURED' when the server is
  // unreachable or not configured, so the caller can show the manual-mode hint.
  async function draftCards(opts) {
    opts = opts || {};
    var body = {
      system: opts.system || '',
      messages: opts.messages || [],
      max_tokens: opts.max_tokens || 2048,
      temperature: opts.temperature != null ? opts.temperature : 0.2
    };

    // Probe the server.
    var probeRes;
    try {
      probeRes = await fetch('/api/draft-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probe: true })
      });
    } catch (e) {
      setCachedPath('none');
      expandFallback('network');
      var err = new Error('NOT_CONFIGURED');
      err.reason = 'network';
      throw err;
    }

    if (probeRes.status === 404) {
      setCachedPath('none');
      expandFallback('not-deployed');
      var err2 = new Error('NOT_CONFIGURED');
      err2.reason = 'not-deployed';
      throw err2;
    }
    if (probeRes.status === 500) {
      var j = {};
      try { j = await probeRes.json(); } catch (e) {}
      if (/missing GEMINI_API_KEY/i.test(j.error || '')) {
        setCachedPath('none');
        expandFallback('not-configured');
        var err3 = new Error('NOT_CONFIGURED');
        err3.reason = 'not-configured';
        throw err3;
      }
      throw new Error(j.error || ('Server error ' + probeRes.status));
    }
    if (!probeRes.ok) {
      setCachedPath('none');
      expandFallback('not-configured');
      var err4 = new Error('NOT_CONFIGURED');
      err4.reason = 'not-configured';
      throw err4;
    }

    // Server is up. Make the real call (uses the server's universal key).
    setCachedPath('server');
    var real = await fetch('/api/draft-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!real.ok) {
      var jj = {};
      try { jj = await real.json(); } catch (e) {}
      throw new Error(jj.error || ('Server ' + real.status));
    }
    return real.json();
  }

  // Lightweight server-presence probe, used on page load to set the
  // status badge in the drafter header.
  async function probeServer() {
    var cached = getCachedPath();
    if (cached) return cached;
    try {
      var r = await fetch('/api/draft-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probe: true })
      });
      if (r.ok) { setCachedPath('server'); return 'server'; }
      if (r.status === 404) { setCachedPath('none'); return 'none'; }
      if (r.status === 500) {
        var j = {};
        try { j = await r.json(); } catch (e) {}
        if (/missing GEMINI_API_KEY/i.test(j.error || '')) { setCachedPath('none'); return 'none'; }
      }
      setCachedPath('none'); return 'none';
    } catch (e) {
      setCachedPath('none'); return 'none';
    }
  }

  // Backwards-compat shims. The user-key flow has been removed; these
  // exist only so older call sites that still reference them don't throw.
  function getGeminiKey() { return ''; }
  function setGeminiKey() { /* no-op */ }
  function clearGeminiKey() { /* no-op */ }

  window.SRMS = window.SRMS || {};
  window.SRMS.draftCards = draftCards;
  window.SRMS.probeServer = probeServer;
  window.SRMS.getGeminiKey = getGeminiKey;
  window.SRMS.setGeminiKey = setGeminiKey;
  window.SRMS.clearGeminiKey = clearGeminiKey;
  window.SRMS.getDraftPath = function () { return getCachedPath() || 'none'; };
})();
