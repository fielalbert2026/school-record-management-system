// api/draft-cards.js
//
// Server-side proxy for Card Drafter's question drafting. Uses Google's
// Gemini API (Google AI Studio), which has a genuinely free tier — no
// credit card required — unlike the Anthropic API. A browser can't call
// either provider directly (no key on the page, and neither API allows
// arbitrary browser CORS), so this function holds the one server-side key
// and forwards the already-built prompt, same pattern as verify-master/save.
//
// This endpoint never touches Subject_Scheduler.xlsx and needs no signed
// edit session — drafting produces suggestions only, nothing is saved
// anywhere until a Master approves and the app calls /api/save separately.
//
// Get a free key (no credit card): https://aistudio.google.com/apikey
// Model naming moves fairly often on Google's side — GEMINI_MODEL defaults
// to gemini-3.5-flash-lite, the current free-tier low-cost model as of
// September 2026. Set GEMINI_MODEL=gemini-3.6-flash for higher-quality
// drafts (smaller free daily allowance) if Lite's drafts aren't good
// enough. If drafting ever errors with "model ... no longer available",
// that error names the current replacement — put it in GEMINI_MODEL.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Cheap presence probe — the client calls this on page load to decide
  // which drafting path to use. Returns {ok:true} without hitting Gemini.
  if (req.body && req.body.probe === true) {
    res.status(200).json({ ok: true });
    return;
  }

  // A user-supplied API key (forwarded from the browser) takes precedence
  // over the server env var. This lets a student supply their own free
  // Gemini key to a server they trust, instead of calling Google directly
  // from the browser. Falls back to the env var when not provided.
  const apiKey = (req.body && req.body.userApiKey) || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Card drafting is not configured on this server yet (missing GEMINI_API_KEY).' });
    return;
  }

  const { system, messages, max_tokens, temperature } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Missing messages.' });
    return;
  }

  // Basic size guard so a stray/abusive request can't blow through the free quota in one call.
  const userText = messages.map(m => (m && m.content) || '').join('\n\n');
  const approxLen = (system ? system.length : 0) + userText.length;
  if (approxLen > 60000) {
    res.status(400).json({ error: 'That chunk of source text is too large for one drafting request.' });
    return;
  }

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const geminiBody = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens: Math.min(max_tokens || 2048, 4096),
      temperature: temperature != null ? temperature : 0.2
    }
  };
  if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };

  // Free-tier rate limits are tight enough that a burst of chunk requests
  // (Card Drafter can fire several in a row) may hit 429s — retry those
  // with backoff instead of surfacing a spurious "nothing came back".
  async function callGemini(attempt){
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(geminiBody)
    });
    if (r.status === 429 && attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
      return callGemini(attempt + 1);
    }
    return r;
  }

  try {
    const geminiRes = await callGemini(0);
    const json = await geminiRes.json();
    if (!geminiRes.ok) {
      res.status(geminiRes.status).json({ error: (json.error && json.error.message) || 'Gemini API error.' });
      return;
    }
    const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text || '').join('');
    // Normalize to the same {content:[{text}]} shape the client already parses,
    // so card_drafter.html doesn't need to know which provider is behind this.
    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Gemini: ' + (err && err.message ? err.message : String(err)) });
  }
};
