const crypto = require('crypto');

const PRESENCE_PATH = 'data/presence.json';
const REPOSITORY = 'fielalbert2026/school_record_management_system';
const BRANCH = 'main';

function sign(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;

  const [encoded, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.type !== 'presence' || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

async function isSessionActive(sessionId, githubToken, secret) {
  const path = PRESENCE_PATH.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${REPOSITORY}/contents/${path}?ref=${BRANCH}&_=${Date.now()}`;
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + githubToken, Accept: 'application/vnd.github+json' },
    cache: 'no-store'
  });
  if (response.status === 404) return true;
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || `Could not check presence session (${response.status}).`);
  if (!result.content) throw new Error('Presence data file could not be read.');

  const envelope = JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
  if (envelope.version !== 1 || !envelope.iv || !envelope.ciphertext) {
    throw new Error('Presence data is invalid.');
  }
  const withTag = Buffer.from(envelope.ciphertext, 'base64');
  if (withTag.length < 16) throw new Error('Presence data is invalid.');
  const key = crypto.createHash('sha256').update(`srms-presence-v1:${secret}`).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(withTag.subarray(withTag.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(withTag.subarray(0, withTag.length - 16)),
    decipher.final()
  ]).toString('utf8');
  const data = JSON.parse(plaintext);
  if (!Array.isArray(data.sessions) || !Array.isArray(data.events)) throw new Error('Presence data is invalid.');
  const revoked = Array.isArray(data.revokedSessions) &&
    data.revokedSessions.some(session => session.sessionId === sessionId && session.revokedUntil > Date.now());
  return !revoked;
}

module.exports = { sign, verify, isSessionActive };
