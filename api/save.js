// POST /api/save
// Body: { editToken, contentB64, sha, message }
// Verifies the signed session issued by /api/verify-master, then commits
// the new file content to GitHub using the server's own GITHUB_TOKEN. This
// is the ONLY place that GitHub write credential is ever used — no Master
// needs their own GitHub account, token, or repo-collaborator access.
const crypto = require('crypto');

const GH = { owner: 'fielalbert2026', repo: 'school_record_management_system', branch: 'main', path: 'Subject_Scheduler.xlsx' };

function verifySession(tokenStr, secret) {
  const parts = String(tokenStr || '').split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  // Constant-time compare to avoid a timing side-channel on the signature check.
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  if (payload.role !== 'Master') return null;
  return payload;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const SESSION_SECRET = process.env.SESSION_SECRET;
  if (!GITHUB_TOKEN || !SESSION_SECRET) {
    res.status(500).json({ error: 'Server is missing GITHUB_TOKEN or SESSION_SECRET — set them in Vercel project settings.' });
    return;
  }

  try {
    const { editToken, contentB64, sha, message } = req.body || {};
    if (!contentB64) { res.status(400).json({ error: 'Missing content.' }); return; }

    const session = verifySession(editToken, SESSION_SECRET);
    if (!session) {
      res.status(401).json({ error: 'Your editing session expired — click "Enable editing" and confirm your passphrase again.' });
      return;
    }

    const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${encodeURIComponent(GH.path)}`;
    const ghRes = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `${message || 'Update'} — by ${session.name}`,
        content: contentB64,
        sha,
        branch: GH.branch
      })
    });
    const ghJson = await ghRes.json();
    if (!ghRes.ok) {
      // Surface GitHub's own status (409 = someone else saved first) so the
      // client's existing conflict-handling logic keeps working unchanged.
      res.status(ghRes.status).json({ error: ghJson.message || `GitHub responded with ${ghRes.status}` });
      return;
    }
    res.status(200).json({ sha: ghJson.content.sha });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
};
