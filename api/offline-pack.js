// POST /api/offline-pack — build and log a study-safe workbook snapshot.
const XLSX = require('xlsx');
const { verify } = require('./_presence-token');
const presence = require('./presence');

const GH = {
  owner: 'fielalbert2026',
  repo: 'school_record_management_system',
  branch: 'main',
  path: 'Subject_Scheduler.xlsx'
};
const SAFE_SHEETS = [
  'Subject_Scheduler',
  'Flashcards',
  'Decks'
];
const ALLOWED_SHEETS = new Set(SAFE_SHEETS);

function githubHeaders(token, accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function contentUrl() {
  return `https://api.github.com/repos/${GH.owner}/${GH.repo}/contents/${GH.path}`;
}

function retainColumns(workbook, sheetName, columns, headerName, required) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    if (required) throw new Error(`The ${sheetName} sheet is missing from the offline workbook.`);
    return;
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerIndex = rows.findIndex(row => row[0] === headerName);
  if (headerIndex < 0) throw new Error(`The ${sheetName} sheet has an unexpected layout.`);

  const header = rows[headerIndex];
  const indexes = columns.map(column => header.indexOf(column));
  if (indexes.some(index => index < 0)) {
    throw new Error(`The ${sheetName} sheet is missing fields needed for offline use.`);
  }
  const safeRows = [
    ...rows.slice(0, headerIndex),
    columns,
    ...rows.slice(headerIndex + 1).map(row => indexes.map(index => index < 0 ? '' : row[index]))
  ];
  workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(safeRows);
}

async function readWorkbook(token) {
  const url = `${contentUrl()}?ref=${GH.branch}`;
  const response = await fetch(url, {
    headers: githubHeaders(token),
    cache: 'no-store'
  });
  const json = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) throw new Error(json?.message || `Could not read the study workbook (${response.status}).`);

  let bytes;
  if (json?.content && json.encoding === 'base64') {
    bytes = Buffer.from(json.content, 'base64');
  } else {
    const raw = await fetch(url, {
      headers: githubHeaders(token, 'application/vnd.github.raw'),
      cache: 'no-store'
    });
    if (!raw.ok) throw new Error(`Could not download the study workbook (${raw.status}).`);
    bytes = Buffer.from(await raw.arrayBuffer());
  }
  return XLSX.read(bytes, { type: 'buffer' });
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
    res.status(500).json({ error: 'Offline access requires GITHUB_TOKEN and SESSION_SECRET.' });
    return;
  }

  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const identity = verify(token, secret);
  if (!identity || !identity.sessionId || !identity.userKey) {
    res.status(401).json({ error: 'Sign in again on the live site before preparing offline access.' });
    return;
  }
  if (identity.role !== 'Guest' && identity.role !== 'Master') {
    res.status(403).json({ error: 'This account role is not allowed to prepare offline access.' });
    return;
  }
  if (req.body?.accepted !== true) {
    res.status(400).json({ error: 'Accept the offline-use terms before preparing this copy.' });
    return;
  }

  try {
    const workbook = await readWorkbook(githubToken);
    if (!workbook.SheetNames.includes('Flashcards')) {
      res.status(503).json({ error: 'The flashcard data is not available for offline use.' });
      return;
    }

    retainColumns(workbook, 'Subject_Scheduler', [
      'Subject Code', 'Subject Name', 'Professor', 'Day', 'Start Time', 'End Time',
      'Room / Platform', 'Google Classroom Link', 'Google Meet Link', 'SY',
      'Term / Semester', 'Notes'
    ], 'Subject Code', true);
    retainColumns(workbook, 'Flashcards', ['ID', 'Deck', 'Type', 'Front', 'Back'], 'ID', true);
    retainColumns(workbook, 'Decks', ['Path'], 'Path', false);
    workbook.SheetNames = workbook.SheetNames.filter(name => ALLOWED_SHEETS.has(name));
    for (const name of Object.keys(workbook.Sheets)) {
      if (!ALLOWED_SHEETS.has(name)) delete workbook.Sheets[name];
    }
    workbook.Props = {
      Title: 'School Record Management System Offline Study Snapshot',
      Subject: 'Guest-facing schedule and study material',
      Author: 'School Record Management System'
    };
    workbook.Custprops = {};
    if (workbook.Workbook) {
      workbook.Workbook.Names = [];
      workbook.Workbook.Sheets = workbook.SheetNames.map(name => ({ name, Hidden: 0 }));
    }

    const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    await presence.recordOfflineDownload(identity);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="srms-offline-study.xlsx"');
    res.status(200).send(output);
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not prepare the offline workbook.' });
  }
};
