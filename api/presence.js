// GET /api/presence — owner-only active sessions and sign-in/sign-out history.
// POST /api/presence — record a verified user's heartbeat or session event.
// Store data in a separate encrypted JSON file so presence cannot alter the
// school workbook or expose names/session details from the public repository.
const crypto = require('crypto');
const { verify } = require('./_presence-token');

const GH = { owner: 'fielalbert2026', repo: 'school_record_management_system', branch: 'main', path: 'data/presence.json' };
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 2000;
const WRITE_ATTEMPTS = 4;

function timestamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function getSession(req, secret) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verify(token, secret);
}

function storeKey(secret) {
  return crypto.createHash('sha256').update(`srms-presence-v1:${secret}`).digest();
}

function encryptStore(data, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', storeKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    ciphertext: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')
  });
}

function decryptStore(encoded, secret) {
  const envelope = JSON.parse(encoded);
  if (envelope.version !== 1 || !envelope.iv || !envelope.ciphertext) return { sessions: [], events: [] };
  const withTag = Buffer.from(envelope.ciphertext, 'base64');
  if (withTag.length < 16) throw new Error('Presence data is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', storeKey(secret), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(withTag.subarray(withTag.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(withTag.subarray(0, withTag.length - 16)),
    decipher.final()
  ]).toString('utf8');
  const data = JSON.parse(plaintext);
  if (!Array.isArray(data.sessions) || !Array.isArray(data.events)) throw new Error('Presence data is invalid.');
  return data;
}

function githubHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
}

function contentUrl() {
  const path = GH.path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${path}`;
}

async function readStore(githubToken, secret) {
  const url = `${contentUrl()}?ref=${GH.branch}&_=${Date.now()}`;
  const response = await fetch(url, { headers: githubHeaders(githubToken), cache: 'no-store' });
  if (response.status === 404) return { data: { sessions: [], events: [] }, sha: null };
  const json = await response.json();
  if (!response.ok) throw new Error(json.message || `Could not load presence data (${response.status}).`);
  if (!json.content) throw new Error('Presence data file could not be read.');
  return { data: decryptStore(Buffer.from(json.content, 'base64').toString('utf8'), secret), sha: json.sha };
}

async function writeStore(data, sha, githubToken, action) {
  const body = {
    message: `Presence: ${action}`,
    content: Buffer.from(encryptStore(data, process.env.SESSION_SECRET), 'utf8').toString('base64'),
    branch: GH.branch
  };
  if (sha) body.sha = sha;
  const response = await fetch(contentUrl(), {
    method: 'PUT',
    headers: { ...githubHeaders(githubToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) {
    const error = new Error(json.message || `Could not save presence data (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return json.content.sha;
}

function prune(data) {
  const now = Date.now();
  data.sessions = data.sessions.filter(session => {
    const seen = Date.parse(session.lastSeen);
    return Number.isFinite(seen) && now - seen <= SESSION_RETENTION_MS;
  });
  data.events = data.events.filter(event => {
    const time = Date.parse(event.timestamp);
    return Number.isFinite(time) && now - time <= EVENT_RETENTION_MS;
  }).slice(-MAX_EVENTS);
}

function safePage(page) {
  return typeof page === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(page) ? page : 'unknown';
}

function applyAction(data, identity, action, page) {
  const now = timestamp();
  const idx = data.sessions.findIndex(session => session.sessionId === identity.sessionId);
  if (action === 'signout') {
    if (idx !== -1) data.sessions.splice(idx, 1);
  } else {
    const previous = idx === -1 ? null : data.sessions[idx];
    const entry = {
      sessionId: identity.sessionId,
      userKey: identity.userKey,
      name: identity.name,
      role: identity.role,
      isOwner: identity.isOwner,
      signedInAt: previous ? previous.signedInAt : now,
      lastSeen: now,
      page
    };
    if (idx === -1) data.sessions.push(entry);
    else data.sessions[idx] = entry;
  }

  if (action === 'signin' || action === 'signout') {
    const eventKey = `${identity.sessionId}:${action}`;
    if (!data.events.some(event => event.eventKey === eventKey)) {
      data.events.push({
        eventKey,
        timestamp: now,
        name: identity.name,
        role: identity.role,
        event: action === 'signin' ? 'Sign in' : 'Sign out',
        page,
        sessionId: identity.sessionId
      });
    }
  }
  prune(data);
}

async function mutate(action, identity, page, githubToken, secret) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const current = await readStore(githubToken, secret);
    applyAction(current.data, identity, action, page);
    try {
      await writeStore(current.data, current.sha, githubToken, action);
      return;
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      if (attempt === WRITE_ATTEMPTS - 1) throw new Error('Presence data changed repeatedly. Please retry.');
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const githubToken = process.env.GITHUB_TOKEN;
  const secret = process.env.SESSION_SECRET;
  if (!githubToken || !secret) {
    res.status(500).json({ error: 'Presence service is missing GITHUB_TOKEN or SESSION_SECRET.' });
    return;
  }

  const identity = getSession(req, secret);
  if (!identity || !identity.sessionId || !identity.userKey) {
    res.status(401).json({ error: 'Presence session expired. Please sign in again.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      if (!identity.isOwner || identity.role !== 'Master') {
        res.status(403).json({ error: 'Only the verified account owner can view active users.' });
        return;
      }
      const { data } = await readStore(githubToken, secret);
      prune(data);
      const now = Date.now();
      const online = data.sessions.filter(session => {
        const seen = Date.parse(session.lastSeen);
        return Number.isFinite(seen) && now - seen <= ACTIVE_WINDOW_MS;
      }).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
      const recentlyOffline = data.sessions.filter(session => {
        const seen = Date.parse(session.lastSeen);
        return Number.isFinite(seen) && now - seen > ACTIVE_WINDOW_MS;
      }).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
      res.status(200).json({
        online,
        recentlyOffline,
        activity: data.events.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
        fetchedAt: timestamp()
      });
      return;
    }

    const { action, page } = req.body || {};
    if (!['signin', 'heartbeat', 'signout'].includes(action)) {
      res.status(400).json({ error: 'Unsupported presence action.' });
      return;
    }
    await mutate(action, identity, safePage(page), githubToken, secret);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Presence update failed.' });
  }
};
