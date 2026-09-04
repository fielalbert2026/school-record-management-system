/* ==========================================================================
   flashcard-modes.js — Multiple-choice, Type, Match, and Speed round modes
   for the Flashcards reviewer.

   Loaded BEFORE the inline <script> in flashcards.html. Exposes
   window.SRMS.modes.* and expects the following globals from that script:
     - cards (array), queue (array of card IDs), stats (object),
       reviewDeck (string), currentView ('decks'|'review'),
       renderReview (function), escapeHtml (function),
       CLOZE_MARKER ('_____').

   The dispatcher in flashcards.html's renderReview() will call into
   window.SRMS.modes.renderMode() which switches on the current mode and
   delegates to the per-mode render function. The gradeCurrent() function
   in flashcards.html also dispatches by mode for "reveal then grade" UX.

   Important: the data layer (cards array, Flashcards sheet) is unchanged.
   Modes are a property of the review session, not of the card. Cloze cards
   get their answer from c.back (the hidden word); basic cards get it from
   c.back (the back side). All modes work with the same data.
   ========================================================================== */
(function () {
  'use strict';

  // ---------------- Helpers ----------------

  // Fisher-Yates in place.
  function fisherYates(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function shuffleCopy(arr) { return fisherYates(arr.slice()); }

  // Levenshtein distance, used for fuzzy-matching typed answers.
  function levenshtein(a, b) {
    a = a || ''; b = b || '';
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var v0 = new Array(b.length + 1);
    var v1 = new Array(b.length + 1);
    for (var i = 0; i <= b.length; i++) v0[i] = i;
    for (i = 0; i < a.length; i++) {
      v1[0] = i + 1;
      for (var j = 0; j < b.length; j++) {
        var cost = a.charAt(i) === b.charAt(j) ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (var k = 0; k <= b.length; k++) v0[k] = v1[k];
    }
    return v1[b.length];
  }

  // Pick N distractor strings for a Multiple Choice question.
  // Prefers other cards from the same deck, falls back to all cards.
  function pickDistractors(correct, deckName, n) {
    n = n || 3;
    var pool = deckName && deckName !== '__all__'
      ? cards.filter(function (c) { return c.deck === deckName; })
      : cards.slice();
    pool = pool.filter(function (c) { return c.back !== correct; });
    if (pool.length < n) {
      // Top up from all cards.
      var extra = cards.filter(function (c) {
        return c.back !== correct && !pool.some(function (p) { return p.id === c.id; });
      });
      pool = pool.concat(extra);
    }
    fisherYates(pool);
    var out = [];
    var seen = {};
    seen[correct.toLowerCase()] = true;
    for (var i = 0; i < pool.length && out.length < n; i++) {
      var b = (pool[i].back || '').trim();
      if (!b) continue;
      var k = b.toLowerCase();
      if (seen[k]) continue;
      seen[k] = true;
      out.push(b);
    }
    return out;
  }

  // Check a typed answer against the correct one.
  // Returns { ok: 'got' | 'almost' | 'missed', message: string }.
  function checkTyped(input, correct) {
    var i = (input || '').trim().toLowerCase();
    var c = (correct || '').trim().toLowerCase();
    if (!i) return { ok: 'missed', message: 'No answer typed.' };
    if (i === c) return { ok: 'got', message: 'Got it.' };
    // "Almost": first 3 chars match and overall similarity is high enough.
    if (c.length >= 3 && i.length >= 3 && c.slice(0, 3) === i.slice(0, 3)) {
      var dist = levenshtein(i, c);
      var ratio = 1 - (dist / Math.max(i.length, c.length));
      if (ratio >= 0.7) {
        return { ok: 'almost', message: 'Almost — the answer was "' + correct + '".' };
      }
    }
    return { ok: 'missed', message: 'Missed — the answer was "' + correct + '".' };
  }

  // Render the session-stats strip (N remaining · ... stats) for the current mode.
  function renderStatsStrip() {
    var pos = document.getElementById('reviewPos');
    if (!pos) return;
    var mode = state.mode;
    var rem = state.mode === 'match' ? state.matchRoundsLeft : queue.length;
    var parts = [rem + ' remaining'];
    if (mode === 'flashcards') {
      parts.push('Again ' + stats.again, 'Hard ' + stats.hard, 'Snoozed ' + stats.snoozed);
    } else if (mode === 'multiple-choice') {
      parts.push('Correct ' + stats.correct, 'Wrong ' + stats.wrong);
    } else if (mode === 'type') {
      parts.push('Got it ' + stats.got, 'Almost ' + stats.almost, 'Missed ' + stats.missed);
    } else if (mode === 'match') {
      parts.push('Matched ' + stats.matched);
    } else if (mode === 'speed') {
      parts.push('Score ' + (state.speedCorrect || 0) + ' / ' + (state.speedTotal || 0));
    }
    pos.textContent = parts.join(' · ');
  }

  // Set the visible mode chip and persist.
  function setModeChip(mode) {
    document.querySelectorAll('.mode-chip').forEach(function (chip) {
      chip.setAttribute('aria-pressed', chip.dataset.mode === mode ? 'true' : 'false');
    });
  }

  // Disable chips that don't have enough cards to work.
  function syncModeAvailability() {
    var n = cards.filter(function (c) { return state.mode === 'match' || reviewDeck === '__all__' || c.deck === reviewDeck; }).length;
    document.querySelectorAll('.mode-chip').forEach(function (chip) {
      var m = chip.dataset.mode;
      var req = (m === 'multiple-choice' || m === 'type' || m === 'speed') ? 4
              : m === 'match' ? 4
              : 1;
      var ok = n >= req;
      chip.disabled = !ok;
      chip.title = ok ? '' : ('Need at least ' + req + ' cards in this deck');
    });
  }

  // ---------------- Per-mode renderers ----------------
  // Each takes the current card (or null) and updates #reviewArea and
  // #reviewControls in the same way renderReview() does for flashcards.

  function renderFlashcard(c) {
    // Delegate to the original renderReview for the default mode so we
    // never fork the well-tested path.
    return null; // signal: caller should call the original renderReview
  }

  function renderMultipleChoice(c) {
    var area = document.getElementById('reviewArea');
    var controls = document.getElementById('reviewControls');
    if (!c) {
      area.innerHTML = '<div class="empty">No cards in this deck yet.</div>';
      controls.innerHTML = '';
      return;
    }
    if (!state.mcOptions) {
      var distractors = pickDistractors(c.back, reviewDeck, 3);
      var opts = shuffleCopy([c.back].concat(distractors));
      state.mcOptions = opts;
      state.mcRevealed = false;
      state.mcCorrect = opts.indexOf(c.back);
    }
    var opts = state.mcOptions;
    var optsHtml = opts.map(function (opt, i) {
      var cls = 'mc-opt';
      if (state.mcRevealed) {
        if (i === state.mcCorrect) cls += ' mc-correct';
        else if (i === state.mcPicked) cls += ' mc-wrong';
      }
      return '<button type="button" class="' + cls + '" data-idx="' + i + '">' +
        escapeHtml(opt).replace(/\n/g, '<br>') + '</button>';
    }).join('');
    area.innerHTML = '<div class="review-face"><div class="mc-stack">' +
      '<div class="review-text">' + escapeHtml(c.front).replace(/\n/g, '<br>') + '</div>' +
      '<div class="mc-options">' + optsHtml + '</div>' +
      '<div class="mc-feedback">' + (state.mcRevealed ? escapeHtml(state.mcFeedback || '') : '') + '</div>' +
    '</div></div>';
    if (state.mcRevealed) {
      controls.innerHTML = '<button class="btn-primary" id="mcNextBtn">Next</button>';
      document.getElementById('mcNextBtn').addEventListener('click', function () {
        state.mcOptions = null; state.mcPicked = null; state.mcRevealed = false;
        if (state.mode === 'speed') { recordSpeedAdvance(); return; }
        // Pop the current card (it's been answered).
        queue.shift();
        renderReview();
      });
    } else {
      controls.innerHTML = '';
      area.querySelectorAll('.mc-opt').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (state.mcRevealed) return;
          state.mcPicked = Number(btn.dataset.idx);
          state.mcRevealed = true;
          stats.seen++;
          if (state.mcPicked === state.mcCorrect) {
            state.mcFeedback = 'Correct!';
            stats.correct = (stats.correct || 0) + 1;
            state.speedCorrect = (state.speedCorrect || 0) + 1;
            if (state.mode === 'speed') {
              // Speed auto-advances after a brief flash.
              renderReview();
              setTimeout(function () {
                if (state.mode !== 'speed') return;
                state.mcOptions = null; state.mcPicked = null; state.mcRevealed = false;
                queue.shift();
                recordSpeedAdvance();
              }, 700);
              return;
            }
          } else {
            state.mcFeedback = 'Not quite — the correct answer is highlighted.';
            stats.wrong = (stats.wrong || 0) + 1;
          }
          renderReview();
        });
      });
    }
  }

  function renderTypeAnswer(c) {
    var area = document.getElementById('reviewArea');
    var controls = document.getElementById('reviewControls');
    if (!c) {
      area.innerHTML = '<div class="empty">No cards in this deck yet.</div>';
      controls.innerHTML = '';
      return;
    }
    var shownFront = c.type === 'cloze'
      ? c.front.replace(CLOZE_MARKER, '<span class="blank">' + CLOZE_MARKER + '</span>')
      : c.front;
    var feedbackHtml = '';
    if (state.typeRevealed) {
      feedbackHtml = '<div class="type-feedback type-' + state.typeResult + '">' +
        escapeHtml(state.typeFeedback || '') + '</div>';
    }
    area.innerHTML = '<div class="review-face"><div class="type-stack">' +
      '<div class="review-text">' + shownFront.replace(/\n/g, '<br>') + '</div>' +
      '<input type="text" id="typeInput" class="type-input" autocomplete="off" placeholder="Type the answer" ' +
        (state.typeRevealed ? 'disabled' : '') + ' />' +
      feedbackHtml +
    '</div></div>';
    if (state.typeRevealed) {
      controls.innerHTML = '<button class="btn-primary" id="typeNextBtn">Next</button>';
      document.getElementById('typeNextBtn').addEventListener('click', function () {
        state.typeRevealed = false; state.typeResult = null; state.typeFeedback = null;
        if (state.mode === 'speed') { recordSpeedAdvance(); return; }
        queue.shift();
        renderReview();
      });
    } else {
      controls.innerHTML = '<button class="btn-primary" id="typeCheckBtn">Check</button>';
      var input = document.getElementById('typeInput');
      if (input) {
        input.focus();
        var submit = function () {
          if (state.typeRevealed) return;
          var v = input.value;
          var r = checkTyped(v, c.back);
          state.typeRevealed = true;
          state.typeResult = r.ok;
          state.typeFeedback = r.message;
          stats.seen++;
          if (r.ok === 'got') stats.got = (stats.got || 0) + 1;
          else if (r.ok === 'almost') stats.almost = (stats.almost || 0) + 1;
          else stats.missed = (stats.missed || 0) + 1;
          if (r.ok === 'got') state.speedCorrect = (state.speedCorrect || 0) + 1;
          if (state.mode === 'speed' && r.ok === 'got') {
            renderReview();
            setTimeout(function () {
              if (state.mode !== 'speed') return;
              state.typeRevealed = false; state.typeResult = null; state.typeFeedback = null;
              queue.shift();
              recordSpeedAdvance();
            }, 700);
            return;
          }
          renderReview();
        };
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
        document.getElementById('typeCheckBtn').addEventListener('click', submit);
      }
    }
  }

  // Match the pairs: 8 cards in a round, 2 columns, click-to-pair.
  function startMatchRound() {
    var pool = reviewDeck === '__all__' ? cards.slice() : cards.filter(function (c) { return c.deck === reviewDeck; });
    var n = Math.min(pool.length >= 12 ? 12 : 8, pool.length);
    if (n < 2) {
      state.matchRound = []; state.matchSelected = null; state.matchMatched = []; state.matchRoundsLeft = 0;
      return;
    }
    fisherYates(pool);
    var round = pool.slice(0, n);
    var rights = shuffleCopy(round.map(function (c) { return c.id; }));
    state.matchRound = round; // [{id, front, back, deck}]
    state.matchRights = rights; // shuffled [id, id, ...]
    state.matchSelected = null; // {termIdx, defIdx}
    state.matchMatched = []; // [id, id, ...] for cards already matched
    state.matchRoundsLeft = Math.ceil(pool.length / n);
  }

  function renderMatchPairs() {
    var area = document.getElementById('reviewArea');
    var controls = document.getElementById('reviewControls');
    if (!state.matchRound || state.matchRound.length === 0) {
      startMatchRound();
    }
    if (!state.matchRound || state.matchRound.length === 0) {
      area.innerHTML = '<div class="empty">Not enough cards for Match mode.</div>';
      controls.innerHTML = '';
      return;
    }
    // If all matched in this round, auto-advance.
    if (state.matchMatched.length === state.matchRound.length) {
      stats.matched = (stats.matched || 0) + 1;
      if (state.matchRoundsLeft > 1) {
        state.matchRoundsLeft--;
        startMatchRound();
      } else {
        // Out of rounds.
        area.innerHTML = '<div class="empty">All matches complete for this session.</div>';
        controls.innerHTML = '<button class="btn-primary" id="matchDoneBtn">Back to deck</button>';
        document.getElementById('matchDoneBtn').addEventListener('click', function () {
          // Treat each round as a "card" removed from the queue.
          for (var i = 0; i < state.matchRound.length; i++) {
            var idx = queue.indexOf(state.matchRound[i].id);
            if (idx !== -1) queue.splice(idx, 1);
          }
          renderReview();
        });
        return;
      }
    }
    var lefts = state.matchRound;
    var rights = state.matchRights;
    var leftsHtml = lefts.map(function (c, i) {
      var matched = state.matchMatched.indexOf(c.id) !== -1;
      var selected = state.matchSelected && state.matchSelected.termIdx === i;
      var cls = 'match-cell match-left' + (matched ? ' matched' : '') + (selected ? ' selected' : '');
      return '<button type="button" class="' + cls + '" data-idx="' + i + '"' + (matched ? ' disabled' : '') + '>' +
        escapeHtml(c.front).replace(/\n/g, '<br>') + '</button>';
    }).join('');
    var rightsHtml = rights.map(function (id, i) {
      var c = lefts.find(function (x) { return x.id === id; });
      var matched = state.matchMatched.indexOf(id) !== -1;
      var selected = state.matchSelected && state.matchSelected.defIdx === i;
      var cls = 'match-cell match-right' + (matched ? ' matched' : '') + (selected ? ' selected' : '');
      return '<button type="button" class="' + cls + '" data-idx="' + i + '"' + (matched ? ' disabled' : '') + '>' +
        escapeHtml(c ? c.back : '').replace(/\n/g, '<br>') + '</button>';
    }).join('');
    area.innerHTML = '<div class="match-grid">' +
      '<div class="match-col">' + leftsHtml + '</div>' +
      '<div class="match-col">' + rightsHtml + '</div>' +
    '</div>';
    controls.innerHTML = '';
    area.querySelectorAll('.match-cell:not(.matched)').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = Number(btn.dataset.idx);
        if (!state.matchSelected) {
          state.matchSelected = { termIdx: -1, defIdx: -1 };
        }
        if (btn.classList.contains('match-left')) {
          // Clear any other left selection; toggle if same clicked.
          if (state.matchSelected.termIdx === i) {
            state.matchSelected.termIdx = -1;
          } else {
            state.matchSelected.termIdx = i;
          }
        } else {
          if (state.matchSelected.defIdx === i) {
            state.matchSelected.defIdx = -1;
          } else {
            state.matchSelected.defIdx = i;
          }
        }
        // If both picked, evaluate.
        if (state.matchSelected.termIdx >= 0 && state.matchSelected.defIdx >= 0) {
          var termId = lefts[state.matchSelected.termIdx].id;
          var defId = rights[state.matchSelected.defIdx];
          if (termId === defId) {
            // Correct.
            state.matchMatched.push(termId);
            stats.seen++;
            state.matchSelected = null;
            renderReview();
          } else {
            // Wrong — flash red on both, then reset.
            var leftBtn = area.querySelector('.match-left[data-idx="' + state.matchSelected.termIdx + '"]');
            var rightBtn = area.querySelector('.match-right[data-idx="' + state.matchSelected.defIdx + '"]');
            if (leftBtn) leftBtn.classList.add('mc-wrong');
            if (rightBtn) rightBtn.classList.add('mc-wrong');
            setTimeout(function () { state.matchSelected = null; renderReview(); }, 600);
          }
        } else {
          renderReview();
        }
      });
    });
  }

  // Speed round: timer + delegate rendering to a sub-mode.
  function startSpeedRound(sub) {
    state.mode = 'speed';
    state.speedSub = sub || 'type';
    state.speedStart = Date.now();
    state.speedDuration = 60;
    state.speedCorrect = 0;
    state.speedTotal = 0;
    setModeChip('speed');
    state.speedTimer = setInterval(updateSpeedClock, 250);
    updateSpeedClock();
    saveMode();
    renderReview();
  }
  function updateSpeedClock() {
    var pill = document.getElementById('speedTimer');
    if (!pill) return;
    if (state.mode !== 'speed') {
      pill.classList.remove('active'); return;
    }
    var remaining = Math.max(0, state.speedDuration - Math.floor((Date.now() - state.speedStart) / 1000));
    var mm = Math.floor(remaining / 60);
    var ss = remaining % 60;
    pill.classList.add('active');
    pill.classList.toggle('warn', remaining <= 15 && remaining > 5);
    pill.classList.toggle('danger', remaining <= 5);
    pill.textContent = '⏱ ' + mm + ':' + (ss < 10 ? '0' : '') + ss + ' · ' + (state.speedCorrect || 0) + '/' + (state.speedTotal || 0);
    if (remaining === 0) endSpeedRound();
  }
  function endSpeedRound() {
    if (state.speedTimer) { clearInterval(state.speedTimer); state.speedTimer = null; }
    var area = document.getElementById('reviewArea');
    var controls = document.getElementById('reviewControls');
    area.innerHTML = '<div class="empty"><div class="speed-summary">' +
      '<div class="speed-summary-num">' + (state.speedCorrect || 0) + ' / ' + (state.speedTotal || 0) + '</div>' +
      '<div class="speed-summary-label">correct in 60 seconds</div></div></div>';
    controls.innerHTML =
      '<button class="btn-primary" id="speedRestartBtn">Restart</button>' +
      '<button class="btn-ghost" id="speedExitBtn">Exit Speed</button>';
    var pill = document.getElementById('speedTimer');
    if (pill) pill.classList.remove('active');
    document.getElementById('speedRestartBtn').addEventListener('click', function () {
      startSpeedRound(state.speedSub);
    });
    document.getElementById('speedExitBtn').addEventListener('click', function () {
      setMode('flashcards');
      startReview(true);
    });
  }
  function recordSpeedAdvance() {
    state.speedTotal = (state.speedTotal || 0) + 1;
    if (queue.length === 0) {
      // Refill with the same deck so speed can keep going.
      var pool = reviewDeck === '__all__' ? cards.slice() : cards.filter(function (c) { return c.deck === reviewDeck; });
      queue = pool.map(function (c) { return c.id; });
      fisherYates(queue);
    }
    updateSpeedClock();
    renderReview();
  }

  // ---------------- Public dispatch ----------------

  function renderMode() {
    syncModeAvailability();
    var c = queue[0] ? cards.find(function (x) { return x.id === queue[0]; }) : null;
    var typeLbl = document.getElementById('reviewType');
    if (typeLbl) {
      var label = state.mode === 'flashcards' ? (c && c.type === 'cloze' ? 'Fill in the blank' : 'Front / Back')
                : state.mode === 'multiple-choice' ? 'Multiple Choice'
                : state.mode === 'type' ? 'Type the answer'
                : state.mode === 'match' ? 'Match the pairs'
                : 'Speed 60s';
      typeLbl.textContent = label;
    }
    if (state.mode === 'flashcards') {
      return false; // caller falls back to original renderReview
    }
    renderStatsStrip();
    if (state.mode === 'multiple-choice') renderMultipleChoice(c);
    else if (state.mode === 'type') renderTypeAnswer(c);
    else if (state.mode === 'match') renderMatchPairs();
    else if (state.mode === 'speed') {
      // Delegate to the sub-mode's renderer.
      if (state.speedSub === 'multiple-choice') renderMultipleChoice(c);
      else renderTypeAnswer(c);
    }
    return true;
  }

  // gradeCurrent(action) is called from the existing flashcards.html
  // gradeCurrent. For modes other than flashcards, the per-mode renderer
  // handles its own grade/next flow (no button click here). This is a
  // fallback for any keyboard shortcut etc.
  function gradeFromShortcut(action) {
    if (state.mode === 'flashcards') return false; // original code handles
    if (state.mode === 'multiple-choice' || state.mode === 'type') {
      // Space/Enter = Next if a feedback is showing; else = first option.
      if (action === 'next') {
        if (state.mode === 'multiple-choice' && state.mcRevealed) {
          state.mcOptions = null; state.mcPicked = null; state.mcRevealed = false;
          queue.shift();
        } else if (state.mode === 'type' && state.typeRevealed) {
          state.typeRevealed = false; state.typeResult = null; state.typeFeedback = null;
          queue.shift();
        }
        renderReview();
      }
    }
    return true;
  }

  function setMode(mode) {
    if (state.speedTimer) { clearInterval(state.speedTimer); state.speedTimer = null; }
    var pill = document.getElementById('speedTimer');
    if (pill) pill.classList.remove('active');
    state.mode = mode;
    setModeChip(mode);
    // Reset per-mode state.
    state.mcOptions = null; state.mcPicked = null; state.mcRevealed = false; state.mcFeedback = null; state.mcCorrect = null;
    state.typeRevealed = false; state.typeResult = null; state.typeFeedback = null;
    state.matchRound = null; state.matchSelected = null; state.matchMatched = []; state.matchRoundsLeft = 0;
    if (mode === 'match') startMatchRound();
    saveMode();
    renderReview();
  }

  // Wire the chips on page load. Called from flashcards.html's boot block.
  function wireModeChips() {
    document.querySelectorAll('.mode-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        if (chip.disabled) return;
        var m = chip.dataset.mode;
        if (m === 'speed') {
          // Default sub-mode = type. Could prompt; the UI chip says "Type" by default.
          startSpeedRound('type');
        } else {
          setMode(m);
        }
      });
    });
  }

  // Persisted mode preference.
  function loadMode() {
    try {
      var m = localStorage.getItem('srms_review_mode');
      if (m && ['flashcards', 'multiple-choice', 'type', 'match', 'speed'].indexOf(m) !== -1) {
        return m;
      }
    } catch (e) {}
    return 'flashcards';
  }
  function saveMode() {
    try { localStorage.setItem('srms_review_mode', state.mode); } catch (e) {}
  }

  window.SRMS = window.SRMS || {};
  window.SRMS.modes = {
    fisherYates: fisherYates,
    shuffleCopy: shuffleCopy,
    levenshtein: levenshtein,
    pickDistractors: pickDistractors,
    checkTyped: checkTyped,
    renderMode: renderMode,
    renderMultipleChoice: renderMultipleChoice,
    renderTypeAnswer: renderTypeAnswer,
    renderMatchPairs: renderMatchPairs,
    startSpeedRound: startSpeedRound,
    endSpeedRound: endSpeedRound,
    updateSpeedClock: updateSpeedClock,
    setMode: setMode,
    loadMode: loadMode,
    saveMode: saveMode,
    wireModeChips: wireModeChips,
    renderStatsStrip: renderStatsStrip,
    syncModeAvailability: syncModeAvailability,
    gradeFromShortcut: gradeFromShortcut
  };
})();
