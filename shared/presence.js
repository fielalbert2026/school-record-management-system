/* shared/presence.js — server-backed presence for every signed-in role.
 *
 * A narrowly scoped token is issued after the server verifies a user's
 * school ID. Guests can report their own activity but cannot read the list
 * or write school data. Only the verified owner can read presence history.
 */
(function () {
  'use strict';

  var HEARTBEAT_MS = 2 * 60 * 1000;
  var STALE_MS = 5 * 60 * 1000;
  var state = { lastBeat: 0, intervalId: null, visibilityHandler: null, writeQueue: Promise.resolve() };

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem('srms_session') || 'null'); } catch (e) { return null; }
  }

  function clientInfo() {
    var ua = navigator.userAgent || '';
    var lower = ua.toLowerCase();
    var browser = /edg\//i.test(ua) ? 'Edge'
      : /opr\//i.test(ua) ? 'Opera'
      : /firefox\//i.test(ua) ? 'Firefox'
      : /samsungbrowser\//i.test(ua) ? 'Samsung Internet'
      : /(?:chrome|crios)\//i.test(ua) ? 'Chrome'
      : /safari\//i.test(ua) ? 'Safari'
      : 'Other browser';
    var device = /ipad|tablet|kindle|silk/i.test(ua) ? 'Tablet'
      : /mobile|iphone|ipod|android/i.test(lower) ? 'Phone'
      : 'Desktop';
    return { device: device, browser: browser };
  }

  function forceLogout() {
    try {
      sessionStorage.setItem('srms_session_notice', 'Your session was ended by the account owner. Please sign in again.');
      sessionStorage.removeItem('srms_session');
    } catch (e) {}
    try { localStorage.removeItem('gh_pat_school_scheduler'); } catch (e) {}
    window.location.replace('index.html?session=terminated');
  }

  function checkResponse(response, result, fallback) {
    if (result && result.code === 'SESSION_TERMINATED') {
      forceLogout();
      throw new Error(result.error || 'This session was ended by the account owner.');
    }
    if (!response.ok) throw new Error((result && result.error) || fallback);
  }

  function request(action, token) {
    var session = getSession();
    var authToken = token || (session && session.presenceToken);
    if (!authToken) return Promise.reject(new Error('Presence is unavailable for this sign-in. Please sign in again on the deployed site.'));

    var page = location.pathname.split('/').pop() || 'index.html';
    var requestPromise = state.writeQueue.catch(function () {}).then(async function () {
      var response = await fetch('/api/presence', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken
        },
        body: JSON.stringify({ action: action, page: page, client: clientInfo() })
      });
      var result = {};
      try { result = await response.json(); } catch (e) {}
      checkResponse(response, result, 'Presence could not be updated (' + response.status + ').');
      state.lastBeat = Date.now();
      return result;
    });
    state.writeQueue = requestPromise;
    return requestPromise;
  }

  function heartbeat(opts) {
    opts = opts || {};
    var session = getSession();
    if (!session) return Promise.resolve({ skipped: 'no-session' });
    if (!session.presenceToken) return Promise.resolve({ skipped: 'no-presence-token' });
    if (!opts.force && Date.now() - state.lastBeat < 30000) return Promise.resolve({ skipped: 'too-soon' });
    return request('heartbeat');
  }

  function record(action) {
    if (action !== 'signin' && action !== 'signout') {
      return Promise.reject(new Error('Unsupported presence event.'));
    }
    if (action === 'signout' && state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
      if (state.visibilityHandler) {
        document.removeEventListener('visibilitychange', state.visibilityHandler);
        state.visibilityHandler = null;
      }
    }
    if (action === 'signout') {
      try { localStorage.removeItem('gh_pat_school_scheduler'); } catch (e) {}
    }
    return request(action);
  }

  async function readActive() {
    var session = getSession();
    if (!session || !session.presenceToken) {
      throw new Error('Presence is unavailable for this sign-in. Log out and sign in again on the deployed site.');
    }
    var response = await fetch('/api/presence', {
      headers: { 'Authorization': 'Bearer ' + session.presenceToken },
      cache: 'no-store'
    });
    var result = {};
    try { result = await response.json(); } catch (e) {}
    checkResponse(response, result, 'Could not load presence (' + response.status + ').');
    return result;
  }

  async function terminateSession(targetSessionId) {
    if (!/^[a-f0-9]{32}$/.test(String(targetSessionId || ''))) {
      throw new Error('Choose a valid session to end.');
    }
    var session = getSession();
    if (!session || !session.presenceToken || !session.isOwner) {
      throw new Error('Only the signed-in account owner can end sessions.');
    }
    var response = await fetch('/api/presence', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.presenceToken
      },
      body: JSON.stringify({ action: 'terminate', targetSessionId: targetSessionId })
    });
    var result = {};
    try { result = await response.json(); } catch (e) {}
    checkResponse(response, result, 'Could not end that session (' + response.status + ').');
    return result;
  }

  function start() {
    var session = getSession();
    if (!session || !session.presenceToken || state.intervalId) return;
    heartbeat({ force: true }).catch(function (e) {
      console.error('Could not start presence heartbeat:', e.message || e);
    });
    state.intervalId = setInterval(function () {
      if (document.visibilityState === 'visible') {
        heartbeat().catch(function (e) {
          console.error('Could not refresh presence heartbeat:', e.message || e);
        });
      }
    }, HEARTBEAT_MS);
    state.visibilityHandler = function () {
      if (document.visibilityState === 'visible') {
        heartbeat({ force: true }).catch(function (e) {
          console.error('Could not refresh presence after returning to the page:', e.message || e);
        });
      }
    };
    document.addEventListener('visibilitychange', state.visibilityHandler);
  }

  window.SRMS = window.SRMS || {};
  window.SRMS.presence = {
    heartbeat: heartbeat,
    record: record,
    readActive: readActive,
    terminateSession: terminateSession,
    start: start,
    STALE_MS: STALE_MS
  };
})();
