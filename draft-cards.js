// api/draft-cards.js
//
// Server-side proxy to the Anthropic Messages API, used only by
// card_drafter.html. A browser cannot call api.anthropic.com directly —
// there's no API key on the page and Anthropic's API doesn't accept
// arbitrary browser CORS requests, so a direct client-side fetch fails
// (that's the "Failed to fetch" error). This function holds the one
// server-side credential and forwards the already-built prompt.
//
// This endpoint never touches Subject_Scheduler.xlsx and needs no signed
// edit session — drafting produces suggestions only, nothing is saved
// anywhere until a Master approves and the app calls /api/save separately.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Card drafting is not configured on this server yet (missing ANTHROPIC_API_KEY).' });
    return;
  }

  const { system, messages, model, max_tokens, temperature } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Missing messages.' });
    return;
  }

  // Basic size guard so a stray/abusive request can't run up an unbounded bill.
  const approxLen = (system ? system.length : 0) + JSON.stringify(messages).length;
  if (approxLen > 60000) {
    res.status(400).json({ error: 'That chunk of source text is too large for one drafting request.' });
    return;
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: Math.min(max_tokens || 2048, 4096),
        temperature: temperature != null ? temperature : 0.2,
        system: system || undefined,
        messages
      })
    });

    const json = await anthropicRes.json();
    if (!anthropicRes.ok) {
      res.status(anthropicRes.status).json({ error: (json.error && json.error.message) || 'Anthropic API error.' });
      return;
    }
    res.status(200).json(json);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Anthropic: ' + (err && err.message ? err.message : String(err)) });
  }
};
