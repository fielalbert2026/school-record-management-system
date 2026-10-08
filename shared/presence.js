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
        body: JSON.stringify({ action: action, page: page })
      });
      var result = {};
      try { result = await response.json(); } catch (e) {}
      if (!response.ok) throw new Error(result.error || 'Presence could not be updated (' + response.status + ').');
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
    if (!response.ok) throw new Error(result.error || 'Could not load presence (' + response.status + ').');
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
    start: start,
    STALE_MS: STALE_MS
  };
})();
