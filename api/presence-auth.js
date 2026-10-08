// POST /api/presence-auth
// Verifies a valid school user and issues a narrowly scoped presence token.
// The token can report activity; it cannot edit school records or read the
// active-user list unless the verified user is the owner.
const crypto = require('crypto');
const XLSX = require('xlsx');
const { sign } = require('./_presence-token');

const GH = { owner: 'fielalbert2026', repo: 'school_record_management_system', branch: 'main', path: 'Subject_Scheduler.xlsx' };
const AUTH_SALT = 'SRMS-Santino67-67-v1';
const GUEST_ENC_SALT = 'SRMS-Santino67-67-v1-name';
const PBKDF2_ITER = 300000;
const PRESENCE_SESSION_MS = 24 * 60 * 60 * 1000;
const OWNER_SCHOOL_ID = '24050009';

function hashId(id) {
  return crypto.createHash('sha256').update(AUTH_SALT + String(id).trim()).digest('hex');
}

function decryptNameGuest(id, ivB64, ciphertextB64) {
  const key = crypto.createHash('sha256').update(String(id).trim() + GUEST_ENC_SALT).digest();
  const iv = Buffer.from(ivB64, 'base64');
  const withTag = Buffer.from(ciphertextB64, 'base64');
  if (withTag.length < 16) throw new Error('Invalid encrypted name.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(withTag.subarray(withTag.length - 16));
  return Buffer.concat([
    decipher.update(withTag.subarray(0, withTag.length - 16)),
    decipher.final()
  ]).toString('utf8');
}

function decryptNameMaster(id, passphrase, saltB64, ivB64, ciphertextB64, verifier) {
  const salt = Buffer.from(saltB64, 'base64');
  const verifierBytes = crypto.pbkdf2Sync(`${id}:${passphrase}:verify`, salt, PBKDF2_ITER, 32, 'sha256');
  const expected = Buffer.from(String(verifier || '').trim(), 'hex');
  if (expected.length !== verifierBytes.length || !crypto.timingSafeEqual(verifierBytes, expected)) {
    throw new Error('Invalid credentials.');
  }
  const key = crypto.pbkdf2Sync(`${id}:${passphrase}:enc`, salt, PBKDF2_ITER, 32, 'sha256');
  const iv = Buffer.from(ivB64, 'base64');
  const withTag = Buffer.from(ciphertextB64, 'base64');
  if (withTag.length < 16) throw new Error('Invalid encrypted name.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(withTag.subarray(withTag.length - 16));
  return Buffer.concat([
    decipher.update(withTag.subarray(0, withTag.length - 16)),
    decipher.final()
  ]).toString('utf8');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const githubToken = process.env.GITHUB_TOKEN;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!githubToken || !sessionSecret) {
    res.status(500).json({ error: 'Presence service is missing GITHUB_TOKEN or SESSION_SECRET.' });
    return;
  }

  try {
    const { id, passphrase = '' } = req.body || {};
    if (typeof id !== 'string' || !id.trim() || id.length > 100 || typeof passphrase !== 'string' || passphrase.length > 500) {
      res.status(400).json({ error: 'Enter a valid school ID and passphrase.' });
      return;
    }

    const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${encodeURIComponent(GH.path)}?ref=${GH.branch}`;
    const githubResponse = await fetch(url, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (!githubResponse.ok) {
      res.status(502).json({ error: 'Could not verify this account with the school user list.' });
      return;
    }
    const file = await githubResponse.json();
    if (!file.content) throw new Error('The school user workbook could not be read.');
    const workbook = XLSX.read(Buffer.from(file.content, 'base64'), { type: 'buffer' });
    if (!workbook.SheetNames.includes('Valid_Users')) {
      res.status(503).json({ error: 'The school user list is unavailable.' });
      return;
    }

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Valid_Users, { header: 1, defval: '' });
    const headerIndex = rows.findIndex(row => row[0] === 'Unique_Identifier');
    const userHash = hashId(id);
    const match = headerIndex < 0 ? null : rows.slice(headerIndex + 1)
      .find(row => String(row[0]).trim().toLowerCase() === userHash);
    if (!match) {
      res.status(401).json({ error: 'Presence could not verify this sign-in. Please sign in again.' });
      return;
    }

    const role = String(match[3] || 'Guest');
    let name;
    try {
      name = role === 'Master'
        ? decryptNameMaster(id, passphrase, match[4], match[1], match[2], match[5])
        : decryptNameGuest(id, match[1], match[2]);
    } catch (e) {
      res.status(401).json({ error: 'Presence could not verify this sign-in. Please sign in again.' });
      return;
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    const token = sign({
      type: 'presence',
      name,
      role,
      userKey: userHash,
      sessionId,
      isOwner: role === 'Master' && id.trim() === OWNER_SCHOOL_ID,
      exp: Date.now() + PRESENCE_SESSION_MS
    }, sessionSecret);
    res.status(200).json({ token, sessionId });
  } catch (e) {
    res.status(500).json({ error: 'Could not initialize presence tracking.' });
  }
};
