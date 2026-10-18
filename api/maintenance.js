// GET /api/maintenance — current public maintenance status.
// POST /api/maintenance — toggle maintenance, restricted to the verified owner.
const { verify } = require('./_presence-token');

const GH = { owner: 'fielalbert2026', repo: 'school_record_management_system', branch: 'main', path: 'maintenance.json' };
const WRITE_ATTEMPTS = 3;

function githubHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
}

function contentUrl() {
  return `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`;
}

function publicConfig(config) {
  return {
    enabled: config.enabled === true,
    title: typeof config.title === 'string' ? config.title : '',
    message: typeof config.message === 'string' ? config.message : '',
    eta: typeof config.eta === 'string' ? config.eta : '',
    image: typeof config.image === 'string' ? config.image : '',
    imageAlt: typeof config.imageAlt === 'string' ? config.imageAlt : '',
    captions: Array.isArray(config.captions) ? config.captions.filter(value => typeof value === 'string') : []
  };
}

async function readConfig(token) {
  const response = await fetch(`${contentUrl()}?ref=${GH.branch}&_=${Date.now()}`, {
    headers: githubHeaders(token),
    cache: 'no-store'
  });
  const json = await response.json();
  if (!response.ok) {
    const error = new Error(json.message || `Could not read maintenance status (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!json.content || !json.sha) throw new Error('Maintenance configuration could not be read.');
  return { config: JSON.parse(Buffer.from(json.content, 'base64').toString('utf8')), sha: json.sha };
}

async function saveConfig(token, sha, config) {
  const response = await fetch(contentUrl(), {
    method: 'PUT',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Toggle site maintenance',
      content: Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf8').toString('base64'),
      branch: GH.branch,
      sha
    })
  });
  const json = await response.json();
  if (!response.ok) {
    const error = new Error(json.message || `Could not update maintenance status (${response.status}).`);
    error.status = response.status;
    throw error;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const secret = process.env.SESSION_SECRET;
  if (!githubToken || !secret) {
    res.status(500).json({ error: 'Maintenance control requires GITHUB_TOKEN and SESSION_SECRET.' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const { config } = await readConfig(githubToken);
      res.status(200).json(publicConfig(config));
    } catch (error) {
      res.status(502).json({ error: 'Could not load the current maintenance status.' });
    }
    return;
  }

  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const identity = verify(token, secret);
  if (!identity || identity.role !== 'Master' || identity.isOwner !== true) {
    res.status(403).json({ error: 'Only the verified owner account can change maintenance status.' });
    return;
  }
  if (!req.body || typeof req.body.enabled !== 'boolean') {
    res.status(400).json({ error: 'A boolean enabled value is required.' });
    return;
  }

  try {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const { config, sha } = await readConfig(githubToken);
      config.enabled = req.body.enabled;
      delete config.bypassKey;
      try {
        await saveConfig(githubToken, sha, config);
        res.status(200).json(publicConfig(config));
        return;
      } catch (error) {
        if (error.status !== 409 && error.status !== 422) throw error;
        if (attempt === WRITE_ATTEMPTS - 1) throw new Error('Maintenance settings changed repeatedly. Please retry.');
      }
    }
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not update maintenance status.' });
  }
};
