const crypto = require('crypto');
const XLSX = require('xlsx');
const { verify } = require('./_presence-token');
const guestPasswords = require('./_guest-passwords');

const GH = {
  owner: 'fielalbert2026',
  repo: 'school_record_management_system',
  branch: 'main',
  path: 'Subject_Scheduler.xlsx'
};
const AUTH_SALT = 'SRMS-Santino67-67-v1';
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;

function hashId(id) {
  return crypto.createHash('sha256').update(AUTH_SALT + String(id).trim()).digest('hex');
}

function githubHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function findUser(githubToken, userKey) {
  const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}?ref=${GH.branch}`;
  const response = await fetch(url, { headers: githubHeaders(githubToken), cache: 'no-store' });
  if (!response.ok) throw new Error('Could not verify this account with the school user list.');
  const file = await response.json();
  if (!file.content) throw new Error('The school user workbook could not be read.');
  const workbook = XLSX.read(Buffer.from(file.content, 'base64'), { type: 'buffer' });
  if (!workbook.SheetNames.includes('Valid_Users')) throw new Error('The school user list is unavailable.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Valid_Users, { header: 1, defval: '' });
  const headerIndex = rows.findIndex(row => row[0] === 'Unique_Identifier');
  return headerIndex < 0
    ? null
    : rows.slice(headerIndex + 1).find(row => String(row[0]).trim().toLowerCase() === userKey) || null;
}

function validatePassword(password) {
  return typeof password === 'string' &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const secret = process.env.SESSION_SECRET;
  if (!githubToken || !secret) {
    res.status(500).json({ error: 'Account password service is missing GITHUB_TOKEN or SESSION_SECRET.' });
    return;
  }

  try {
    const { action, id, password, currentPassword } = req.body || {};
    if (action !== 'setup' && action !== 'change') {
      res.status(400).json({ error: 'Unsupported password action.' });
      return;
    }
    if (!validatePassword(password)) {
      res.status(400).json({ error: `Choose a password between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.` });
      return;
    }

    let userKey;
    if (action === 'setup') {
      if (typeof id !== 'string' || !id.trim() || id.length > 100) {
        res.status(400).json({ error: 'Enter a valid school ID.' });
        return;
      }
      userKey = hashId(id);
    } else {
      const authorization = req.headers.authorization || '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const identity = verify(token, secret);
      if (!identity || identity.role === 'Master' || !identity.userKey || identity.guestPasswordVersion !== 1) {
        res.status(401).json({ error: 'Sign in again before changing your password.' });
        return;
      }
      if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > MAX_PASSWORD_LENGTH) {
        res.status(400).json({ error: 'Enter your current password.' });
        return;
      }
      userKey = identity.userKey;
    }

    const user = await findUser(githubToken, userKey);
    if (!user || String(user[3] || 'Guest') === 'Master') {
      res.status(401).json({ error: 'ID not recognized. Check with the system owner if this seems wrong.' });
      return;
    }

    await guestPasswords.update(githubToken, secret, action, credentials => {
      const existing = credentials[userKey];
      if (action === 'setup') {
        if (existing) {
          if (guestPasswords.verifyPassword(password, existing)) return { write: false, value: { ok: true } };
          const error = new Error('A password is already set for this account. Sign in with it or contact the system owner.');
          error.status = 409;
          throw error;
        }
      } else if (!guestPasswords.verifyPassword(currentPassword, existing)) {
        const error = new Error('Your current password is incorrect.');
        error.status = 401;
        throw error;
      }
      credentials[userKey] = guestPasswords.createCredential(password);
      return { write: true };
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status ? error.message : 'Could not update the account password.'
    });
  }
};
