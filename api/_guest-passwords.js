const crypto = require('crypto');

const GH = {
  owner: 'fielalbert2026',
  repo: 'school_record_management_system',
  branch: 'main',
  path: 'data/guest-passwords.json'
};
const ITERATIONS = 300000;
const WRITE_ATTEMPTS = 4;

function githubHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function contentUrl() {
  return `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path.split('/').map(encodeURIComponent).join('/')}`;
}

function encryptionKey(secret) {
  return crypto.createHash('sha256').update(`srms-guest-passwords-v1:${secret}`).digest();
}

function encrypt(credentials, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    ciphertext: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')
  });
}

function decrypt(encoded, secret) {
  const envelope = JSON.parse(encoded);
  if (envelope.version !== 1 || !envelope.iv || !envelope.ciphertext) {
    throw new Error('Guest password data is invalid.');
  }
  const withTag = Buffer.from(envelope.ciphertext, 'base64');
  if (withTag.length < 16) throw new Error('Guest password data is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(withTag.subarray(withTag.length - 16));
  const credentials = JSON.parse(Buffer.concat([
    decipher.update(withTag.subarray(0, withTag.length - 16)),
    decipher.final()
  ]).toString('utf8'));
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new Error('Guest password data is invalid.');
  }
  return credentials;
}

async function read(githubToken, secret) {
  const response = await fetch(`${contentUrl()}?ref=${GH.branch}&_=${Date.now()}`, {
    headers: githubHeaders(githubToken),
    cache: 'no-store'
  });
  if (response.status === 404) return { credentials: {}, sha: null };
  const json = await response.json();
  if (!response.ok) throw new Error('Could not load account password data.');
  if (!json.content) throw new Error('Account password data could not be read.');
  return {
    credentials: decrypt(Buffer.from(json.content, 'base64').toString('utf8'), secret),
    sha: json.sha
  };
}

async function write(credentials, sha, githubToken, secret, action) {
  const body = {
    message: `Guest password: ${action}`,
    content: Buffer.from(encrypt(credentials, secret), 'utf8').toString('base64'),
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
    const error = new Error('Could not save the account password. Please try again.');
    error.status = response.status;
    throw error;
  }
}

async function update(githubToken, secret, action, updateCredentials) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const current = await read(githubToken, secret);
    const result = updateCredentials(current.credentials);
    if (!result.write) return result.value;
    try {
      await write(current.credentials, current.sha, githubToken, secret, action);
      return result.value;
    } catch (error) {
      if (error.status !== 409 && error.status !== 422) throw error;
      if (attempt === WRITE_ATTEMPTS - 1) {
        throw new Error('Account data changed repeatedly. Please try again.');
      }
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw new Error('Could not update the account password. Please try again.');
}

function createCredential(password) {
  const salt = crypto.randomBytes(16);
  const verifier = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  return { salt: salt.toString('base64'), verifier: verifier.toString('hex') };
}

function verifyPassword(password, credential) {
  if (typeof password !== 'string' || !credential ||
      typeof credential.salt !== 'string' || typeof credential.verifier !== 'string') return false;
  const expected = Buffer.from(credential.verifier, 'hex');
  if (expected.length !== 32) return false;
  const actual = crypto.pbkdf2Sync(password, Buffer.from(credential.salt, 'base64'), ITERATIONS, 32, 'sha256');
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { read, update, createCredential, verifyPassword };
