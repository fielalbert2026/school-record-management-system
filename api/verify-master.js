// POST /api/verify-master
// Body: { id, passphrase }
// Re-implements the exact same lookup-hash + PBKDF2 + AES-GCM scheme used
// client-side in index.html, so a row that verifies in the browser verifies
// here identically. On success, issues a short-lived signed "edit session"
// token — NOT a GitHub credential — that /api/save accepts as proof this
// browser belongs to a real Master. The actual GitHub write credential
// (GITHUB_TOKEN) never leaves this function.
const XLSX = require('xlsx');
const crypto = require('crypto');

const GH = { owner: 'fielalbert2026', repo: 'school_record_management_system', branch: 'main', path: 'Subject_Scheduler.xlsx' };
const AUTH_SALT = 'SRMS-Santino67-67-v1'; // must match index.html exactly
const PBKDF2_ITER = 300000;               // must match index.html exactly
const EDIT_SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

function hashId(id) {
  return crypto.createHash('sha256').update(AUTH_SALT + String(id).trim()).digest('hex');
}
function pbkdf2Buf(payload, saltBuf, iterations) {
  return crypto.pbkdf2Sync(payload, saltBuf, iterations, 32, 'sha256');
}
function aesGcmDecrypt(keyBuf, ivBuf, ctWithTagBuf) {
  // Web Crypto's AES-GCM output is ciphertext with the 16-byte auth tag
  // appended — Node's crypto module wants them split apart via setAuthTag.
  const tag = ctWithTagBuf.subarray(ctWithTagBuf.length - 16);
  const ct = ctWithTagBuf.subarray(0, ctWithTagBuf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
function signSession(payloadObj, secret) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
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
    const { id, passphrase } = req.body || {};
    if (!id || !passphrase) { res.status(400).json({ error: 'Missing ID or passphrase.' }); return; }

    const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${encodeURIComponent(GH.path)}?ref=${GH.branch}`;
    const ghRes = await fetch(url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
    if (!ghRes.ok) { res.status(502).json({ error: 'Could not reach GitHub to verify.' }); return; }
    const ghJson = await ghRes.json();
    const buf = Buffer.from(ghJson.content, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });

    if (!wb.SheetNames.includes('Valid_Users')) {
      res.status(401).json({ error: 'ID not recognized.' });
      return;
    }
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets['Valid_Users'], { header: 1, defval: '' });
    const hIdx = aoa.findIndex(r => r[0] === 'Unique_Identifier');
    const rows = hIdx === -1 ? [] : aoa.slice(hIdx + 1);

    const hash = hashId(id);
    const match = rows.find(r => String(r[0]).trim().toLowerCase() === hash);

    // Timing note: a real production system would equalize timing between
    // the "no match" and "match but wrong passphrase" paths the same way
    // index.html does for its own login check. This endpoint is only
    // reachable by someone who already has SOME way to guess valid IDs
    // (the sheet itself is public), and a network round-trip per guess is
    // already a much higher bar than the offline attack the client-side
    // timing-equalization defends against — so that extra complexity was
    // left out here to keep this function easy to audit and maintain.
    if (!match || match[3] !== 'Master') {
      res.status(401).json({ error: 'ID not recognized.' });
      return;
    }

    const salt = Buffer.from(match[4], 'base64');
    const verifierHex = pbkdf2Buf(`${id}:${passphrase}:verify`, salt, PBKDF2_ITER).toString('hex');
    if (verifierHex !== String(match[5]).trim().toLowerCase()) {
      res.status(401).json({ error: 'ID not recognized.' });
      return;
    }

    const encKey = pbkdf2Buf(`${id}:${passphrase}:enc`, salt, PBKDF2_ITER);
    const iv = Buffer.from(match[1], 'base64');
    const ct = Buffer.from(match[2], 'base64');
    const name = aesGcmDecrypt(encKey, iv, ct).toString('utf8');

    const editToken = signSession({ name, role: 'Master', exp: Date.now() + EDIT_SESSION_MS }, SESSION_SECRET);
    res.status(200).json({ editToken, name });
  } catch (e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
};
