/* ==========================================================================
   shared/presence.js — Lightweight presence for the Active Users module.

   The app has no real-time backend, so true cross-user presence isn't
   possible without standing up a websocket. Instead, this module uses the
   same GitHub-backed xlsx file as the rest of the app, with a dedicated
   "Active_Sessions" sheet that every signed-in page writes a heartbeat to.

   Flow:
     1. On page load (when signed in), the page calls SRMS.presence.heartbeat()
        which writes a row to the Active_Sessions sheet via /api/save. The
        write is best-effort: if a save is already in flight, or if the user
        is read-only (Guest with no edit token), the heartbeat is skipped
        rather than block the page.
     2. setInterval fires every 2 minutes and re-issues a heartbeat if the
        page is visible.
     3. The Active Users page (owner-only) reads the Active_Sessions sheet,
        filters to rows whose LastSeen is within the last 5 minutes, and
        shows them.

   Why a separate sheet instead of the Audit_Log: Audit_Log is the historical
   record (piggybacked on Master saves, never reaped), while Active_Sessions
   is a transient "right now" view that's pruned at every write. Mixing them
   would either bloat the audit log or break the audit log's append-only
   contract.
   ========================================================================== */
(function () {
  'use strict';

  var GH = { owner:'fielalbert2026', repo:'school_record_management_system', branch:'main', path:'Subject_Scheduler.xlsx' };
  var SHEET = 'Active_Sessions';
  var HEARTBEAT_MS = 2 * 60 * 1000;       // 2 min between writes
  var STALE_MS = 5 * 60 * 1000;           // considered offline after 5 min
  var SAVE_TIMEOUT_MS = 8000;             // give up on a heartbeat if the save takes too long
  var PENDING_KEY = 'srms_pending_presence';
  var MAX_AGE_HOURS = 24;                 // drop rows older than this when writing

  var state = {
    lastBeat: 0,
    inFlight: null,
    intervalId: null,
    enabled: false
  };

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem('srms_session') || 'null'); } catch (e) { return null; }
  }

  // ---- Time helpers (mirror the audit-log's PHT stamp, second precision) ----
  function phTimestamp() {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date()).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' +
           parts.hour + ':' + parts.minute + ':' + parts.second + '+08:00';
  }

  // ---- Edit token (used to authorize the heartbeat save) ----
  function getEditToken() {
    try { return localStorage.getItem('gh_pat_school_scheduler') || ''; } catch (e) { return ''; }
  }
  function hasMasterToken() {
    return !!getEditToken();
  }

  // ---- xlsx round-trip (b64) ----
  function b64ToArrayBuffer(b64) {
    var bin = atob(b64.replace(/\n/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function arrayBufferToB64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = ''; var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }

  // ---- Build / parse the Active_Sessions sheet ----
  function parseActiveSheet(wb) {
    if (!wb.SheetNames || !wb.SheetNames.includes(SHEET)) return [];
    var aoa = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: '' });
    var hIdx = aoa.findIndex(function (r) { return r[0] === 'Name'; });
    if (hIdx === -1) return [];
    return aoa.slice(hIdx + 1)
      .filter(function (r) { return r.some(function (c) { return c !== undefined && c !== ''; }); })
      .map(function (r) { return {
        name: r[0] || '', role: r[1] || '', schoolId: r[2] || '',
        lastSeen: r[3] || '', page: r[4] || '', isOwner: (r[5] || '').toString().toLowerCase() === 'true'
      }; });
  }
  function buildActiveSheet(rows) {
    var headers = ['Name', 'Role', 'SchoolId', 'LastSeen', 'Page', 'IsOwner'];
    var aoa = [
      ['Active Sessions — Personalized School Record Management System'],
      ['Transient presence list. Rows older than 24h are pruned on every write. Visible to the account owner only.'],
      [], headers
    ].concat(rows.map(function (r) {
      return [r.name, r.role, r.schoolId, r.lastSeen, r.page, r.isOwner ? 'TRUE' : 'FALSE'];
    }));
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [22, 12, 14, 24, 38, 9].map(function (w) { return { wch: w }; });
    return ws;
  }

  // Drop rows older than MAX_AGE_HOURS so the sheet doesn't grow forever.
  function pruneRows(rows) {
    var cutoffMs = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
    return rows.filter(function (r) {
      var t = Date.parse(r.lastSeen);
      return isFinite(t) && t >= cutoffMs;
    });
  }

  // Insert or update the row for this session. Identity key is (schoolId, name).
  function upsertRow(rows, entry) {
    var out = rows.slice();
    var idx = out.findIndex(function (r) {
      return r.schoolId === entry.schoolId && r.name === entry.name;
    });
    if (idx === -1) out.push(entry); else out[idx] = entry;
    return out;
  }

  // ---- /api/save call (same shape as every other module) ----
  async function saveViaProxy(contentB64, sha) {
    var res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editToken: getEditToken(), contentB64: contentB64, sha: sha, message: 'Active Sessions: heartbeat' })
    });
    var json = {};
    try { json = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(json.error || ('Save failed (' + res.status + ')'));
    return json.sha;
  }

  // ---- Public: write a heartbeat for the current session ----
  async function heartbeat(opts) {
    opts = opts || {};
    var session = getSession();
    if (!session) return { skipped: 'no-session' };
    if (!hasMasterToken()) return { skipped: 'no-edit-token' }; // guests can't write
    if (state.inFlight) return state.inFlight;                    // de-dupe concurrent calls

    var now = Date.now();
    if (!opts.force && now - state.lastBeat < 30000) return { skipped: 'too-soon' };

    var p = (async function () {
      try {
        // 1. Fetch the current file.
        var url = 'https://api.github.com/repos/' + GH.owner + '/' + GH.repo +
                  '/contents/' + encodeURIComponent(GH.path) + '?ref=' + GH.branch;
        var res = await fetch(url);
        if (!res.ok) throw new Error('Fetch failed (' + res.status + ')');
        var json = await res.json();
        var wb = XLSX.read(b64ToArrayBuffer(json.content), { type: 'array' });
        // Snapshot existing sheets so we don't accidentally drop one (same
        // safety guard as the per-page save routines).
        var known = wb.SheetNames.slice();
        var rows = pruneRows(parseActiveSheet(wb));
        var entry = {
          name: session.name, role: session.role, schoolId: session.schoolId || '',
          lastSeen: phTimestamp(), page: location.pathname.split('/').pop() || 'index.html',
          isOwner: !!session.isOwner
        };
        rows = upsertRow(rows, entry);
        // Replace the sheet.
        wb.Sheets[SHEET] = buildActiveSheet(rows);
        if (!wb.SheetNames.includes(SHEET)) wb.SheetNames.push(SHEET);
        // Guard: any sheet that existed at fetch time must still be in the outgoing wb.
        var missing = known.filter(function (n) { return !wb.SheetNames.includes(n); });
        if (missing.length) throw new Error('Refusing to write — would drop sheets: ' + missing.join(', '));
        var wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        var newSha = await saveViaProxy(arrayBufferToB64(wbout), json.sha);
        state.lastBeat = Date.now();
        return { ok: true, sha: newSha };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    })();
    state.inFlight = p;
    try { return await Promise.race([p, new Promise(function (r) { setTimeout(function () { r({ skipped: 'timeout' }); }, SAVE_TIMEOUT_MS); })]); }
    finally { state.inFlight = null; }
  }

  // ---- Public: read the active list (owner-only enforcement happens on the page) ----
  async function readActive() {
    var url = 'https://api.github.com/repos/' + GH.owner + '/' + GH.repo +
              '/contents/' + encodeURIComponent(GH.path) + '?ref=' + GH.branch;
    var res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed (' + res.status + ')');
    var json = await res.json();
    var wb = XLSX.read(b64ToArrayBuffer(json.content), { type: 'array' });
    var rows = parseActiveSheet(wb);
    var now = Date.now();
    return {
      online: rows.filter(function (r) {
        var t = Date.parse(r.lastSeen);
        return isFinite(t) && (now - t) <= STALE_MS;
      }).sort(function (a, b) { return (b.lastSeen || '').localeCompare(a.lastSeen || ''); }),
      recentlyOffline: rows.filter(function (r) {
        var t = Date.parse(r.lastSeen);
        return isFinite(t) && (now - t) > STALE_MS && (now - t) <= MAX_AGE_HOURS * 3600 * 1000;
      }).sort(function (a, b) { return (b.lastSeen || '').localeCompare(a.lastSeen || ''); }),
      fetchedAt: phTimestamp()
    };
  }

  // ---- Auto-start: heartbeat on load + every HEARTBEAT_MS, paused when hidden ----
  function start() {
    var session = getSession();
    if (!session) return;
    if (!hasMasterToken()) return; // read-only — don't write
    if (state.intervalId) return;   // already running
    state.enabled = true;
    // First heartbeat ASAP (fire and forget).
    heartbeat({ force: true });
    state.intervalId = setInterval(function () {
      if (document.visibilityState === 'visible') heartbeat();
    }, HEARTBEAT_MS);
    // Also re-issue on visibility change (returning to a tab).
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') heartbeat();
    });
  }

  window.SRMS = window.SRMS || {};
  window.SRMS.presence = { heartbeat: heartbeat, readActive: readActive, start: start, STALE_MS: STALE_MS };
})();
