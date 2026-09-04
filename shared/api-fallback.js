/* ==========================================================================
   shared/api-fallback.js — Hybrid AI drafter for the Card Drafter page.
   Detection chain:
     1. If localStorage 'srms_gemini_key' is set, call Google directly.
     2. Otherwise, POST /api/draft-cards with { probe: true } to detect the
        server. If 200, use the server (Anthropic-normalized response).
     3. If 404 or 500-with-missing-key, expand the fallback <details> and
        return NOT_CONFIGURED so the caller can prompt the user.
     4. On network error, also fall back to the key prompt.
   The wire format is the Anthropic-normalized shape
   { content: [{ type: 'text', text }] } so the existing drafter parser
   is unchanged regardless of which path was used.
   ========================================================================== */
(function () {
  'use strict';

  var KEY_STORAGE = 'srms_gemini_key';
  var PATH_CACHE = 'srms_draft_path'; // sessionStorage cache of the resolved path
  var DEFAULT_MODEL = 'gemini-1.5-flash';

  function getKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function setKey(k) {
    try { localStorage.setItem(KEY_STORAGE, k || ''); } catch (e) {}
  }
  function clearKey() {
    try { localStorage.removeItem(KEY_STORAGE); } catch (e) {}
  }
  function getCachedPath() {
    try { return sessionStorage.getItem(PATH_CACHE) || ''; } catch (e) { return ''; }
  }
  function setCachedPath(p) {
    try { sessionStorage.setItem(PATH_CACHE, p); } catch (e) {}
  }

  // Map Gemini wire format → Anthropic-normalized shape.
  function mapGeminiToAnthropic(json) {
    var parts = (json && json.candidates && json.candidates[0]
                 && json.candidates[0].content && json.candidates[0].content.parts) || [];
    var text = parts.map(function (p) { return p.text || ''; }).join('');
    return { content: [{ type: 'text', text: text }] };
  }

  // Call Google directly with the user's free Gemini key. CORS is supported
  // on the public endpoint, so this works straight from the browser.
  async function callGeminiDirect(userKey, body) {
    var sysText = body.system || '';
    var contents = (body.messages || []).map(function (m) {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '' }]
      };
    });
    var payload = {
      systemInstruction: { parts: [{ text: sysText }] },
      contents: contents,
      generationConfig: {
        maxOutputTokens: Math.min(body.max_tokens || 2048, 4096),
        temperature: body.temperature != null ? body.temperature : 0.2
      }
    };
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + DEFAULT_MODEL + ':generateContent';
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': userKey
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      var errJson = {};
      try { errJson = await res.json(); } catch (e) {}
      var msg = (errJson.error && errJson.error.message) || ('Gemini ' + res.status);
      throw new Error(msg);
    }
    var json = await res.json();
    return mapGeminiToAnthropic(json);
  }

  // The fallback UI element (the <details class="drafter-fallback"> on the page).
  // Best-effort: silently no-op if it's not on this page.
  function expandFallback(reason) {
    var el = document.getElementById('drafterFallback');
    if (el && typeof el.open !== 'undefined') el.open = true;
    var draftBtn = document.getElementById('generateBtn');
    if (draftBtn) {
      draftBtn.disabled = true;
      draftBtn.title = 'AI drafting isn\'t configured. Paste a free Google Gemini key in the settings panel below.';
    }
    var status = document.getElementById('genStatus') || document.getElementById('drafterStatus');
    if (status) {
      status.className = 'status-banner warn';
      var reasonText = reason === 'not-deployed'
        ? 'AI drafting isn\'t deployed on this server.'
        : reason === 'not-configured'
          ? 'AI drafting isn\'t configured on this server.'
          : 'Couldn\'t reach the AI server.';
      status.textContent = reasonText + ' Paste a free Google Gemini key below, or type cards in by hand.';
    }
  }

  // Main entry. Returns Anthropic-normalized { content: [...] } on success.
  // Throws an Error whose message === 'NOT_CONFIGURED' when neither path
  // is available, so the caller can show the manual-mode hint.
  async function draftCards(opts) {
    opts = opts || {};
    var body = {
      system: opts.system || '',
      messages: opts.messages || [],
      max_tokens: opts.max_tokens || 2048,
      temperature: opts.temperature != null ? opts.temperature : 0.2
    };

    // 1. User-pasted key — direct to Google.
    var userKey = getKey();
    if (userKey) {
      setCachedPath('user-key');
      return callGeminiDirect(userKey, body);
    }

    // 2. Probe the server.
    var probeRes;
    try {
      probeRes = await fetch('/api/draft-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ probe: true })
      });
    } catch (e) {
      // Network error — fall back to the key prompt.
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
      // Some other 500 — surface it.
      throw new Error(j.error || 'Server error ' + probeRes.status);
    }
    if (!probeRes.ok) {
      // 4xx other than 404/500 — likely a permanent misconfiguration.
      setCachedPath('none');
      expandFallback('not-configured');
      var err4 = new Error('NOT_CONFIGURED');
      err4.reason = 'not-configured';
      throw err4;
    }

    // 3. Server is up. Make the real call.
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
    var userKey = getKey();
    if (userKey) return 'user-key';
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

  window.SRMS = window.SRMS || {};
  window.SRMS.draftCards = draftCards;
  window.SRMS.probeServer = probeServer;
  window.SRMS.getGeminiKey = getKey;
  window.SRMS.setGeminiKey = setKey;
  window.SRMS.clearGeminiKey = clearKey;
  window.SRMS.getDraftPath = function () { return getCachedPath() || (getKey() ? 'user-key' : 'none'); };
})();
