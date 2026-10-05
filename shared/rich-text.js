/* ==========================================================================
   shared/rich-text.js — Text formatting, multi-blank cloze and Anki import
   for the Study Hub (flashcards.html) and Card Drafter (card_drafter.html).

   HOW FORMATTED TEXT IS STORED (no new columns, old cards keep working)
   - A card field with no formatting is stored exactly as before: plain text.
   - A field with formatting is stored as  <!--rt-->  followed by a small,
     sanitised HTML subset (bold, italic, underline, strike, colour,
     highlight, font, size, sub/superscript, line breaks, lists).
   - Everything is re-sanitised (allow-list, DOM based) before it is ever
     shown, so a hand-edited spreadsheet cell can't inject script or styles.

   CLOZE WITH SEVERAL BLANKS
   - front keeps one  _____  per blank; back holds the answers joined by  ‖
     (U+2016), e.g.  front "The _____ is the _____ of the cell."
                     back  "mitochondria ‖ powerhouse".
   - A single-blank card is stored exactly as before (back = the answer).
   ========================================================================== */
(function () {
  'use strict';

  var MARK = '<!--rt-->';
  var SEP = '\u2016';
  var BLANK = '_____';

  /* ---------------------------------------------------------------- helpers */
  function escText(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function isRich(s) { return typeof s === 'string' && s.indexOf(MARK) === 0; }

  /* ------------------------------------------------------- sanitiser tables */
  var FONT_CLASS = {
    'georgia': 'serif', 'serif': 'serif', 'times new roman': 'serif', 'merriweather': 'serif',
    'ibm plex mono': 'mono', 'monospace': 'mono', 'courier new': 'mono', 'consolas': 'mono',
    'comic sans ms': 'hand', 'cursive': 'hand', 'brush script mt': 'hand'
  };
  var FONT_CSS = {
    serif: "Georgia, 'Times New Roman', serif",
    mono: "'IBM Plex Mono', 'Courier New', monospace",
    hand: "'Comic Sans MS', 'Segoe Print', cursive"
  };
  var SIZE_CSS = { small: '0.85em', large: '1.2em', xl: '1.5em', xxl: '2em' };
  var DROP_WITH_CONTENT = { script: 1, style: 1, noscript: 1, iframe: 1, object: 1, embed: 1, template: 1, head: 1, title: 1, svg: 1, math: 1, textarea: 1, select: 1, button: 1 };
  var BLOCK = { div: 1, p: 1, blockquote: 1, pre: 1, section: 1, article: 1, table: 1, tr: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
  var INLINE_STYLED = { span: 1, font: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, ins: 1, s: 1, strike: 1, del: 1, mark: 1, a: 1, code: 1, small: 1, big: 1 };

  function hex2(n) { n = Math.max(0, Math.min(255, n | 0)); return (n < 16 ? '0' : '') + n.toString(16); }
  function parseColor(v) {
    v = String(v || '').trim().toLowerCase();
    var m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      return '#' + h.slice(0, 6);
    }
    m = v.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      if (m[4] !== undefined) { var a = parseFloat(m[4]); if (m[4].slice(-1) === '%') a /= 100; if (a === 0) return null; }
      return '#' + hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3]);
    }
    if (/^[a-z]{3,20}$/.test(v) && !/^(inherit|initial|unset|revert|transparent|currentcolor|none|auto|windowtext|canvastext)$/.test(v)) return v;
    return null;
  }
  function parseFont(v) {
    var first = String(v || '').toLowerCase().split(',')[0].replace(/["']/g, '').trim();
    return FONT_CLASS[first] || null;
  }
  function parseSize(v) {
    v = String(v || '').trim().toLowerCase().replace('-webkit-', '');
    if (v === 'x-small' || v === 'xx-small' || v === 'small' || v === 'smaller') return 'small';
    if (v === 'large' || v === 'larger') return 'large';
    if (v === 'x-large') return 'xl';
    if (v === 'xx-large' || v === 'xxx-large') return 'xxl';
    var m = v.match(/^([\d.]+)em$/);
    if (m) { var n = parseFloat(m[1]); if (n <= 0.95) return 'small'; if (n < 1.05) return null; if (n < 1.4) return 'large'; if (n < 1.8) return 'xl'; return 'xxl'; }
    return null;
  }
  function parseStyleAttr(el) {
    var o = {};
    var st = (el.getAttribute && el.getAttribute('style')) || '';
    st.split(';').forEach(function (d) {
      var i = d.indexOf(':'); if (i < 0) return;
      var p = d.slice(0, i).trim().toLowerCase();
      var v = d.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, '');
      if (/url\(|expression|javascript:|@import|\\/.test(v)) return;
      if (p === 'color') { var c = parseColor(v); if (c) o.color = c; }
      else if (p === 'background-color' || p === 'background') { var b = parseColor(v); if (b) o.bg = b; }
      else if (p === 'font-family') { var f = parseFont(v); if (f) o.font = f; }
      else if (p === 'font-size') { var z = parseSize(v); if (z) o.size = z; }
      else if (p === 'font-weight') { if (v === 'bold' || v === 'bolder' || +v >= 600) o.bold = true; }
      else if (p === 'font-style') { if (v === 'italic' || v === 'oblique') o.italic = true; }
      else if (p === 'text-decoration' || p === 'text-decoration-line') {
        if (v.indexOf('underline') >= 0) o.underline = true;
        if (v.indexOf('line-through') >= 0) o.strike = true;
      }
    });
    return o;
  }
  var FONT_SIZE_ATTR = { 1: 'small', 2: 'small', 3: null, 4: 'large', 5: 'xl', 6: 'xxl', 7: 'xxl' };

  function wrapStyled(inner, o) {
    if (!inner) return '';
    var opens = [], closes = [];
    var color = o.color, bg = o.bg;
    if (bg && !color) color = '#0f172a';          // highlighted text must stay readable in dark mode
    var css = [];
    if (color) css.push('color:' + color);
    if (bg) css.push('background-color:' + bg);
    if (o.font) css.push('font-family:' + FONT_CSS[o.font]);
    if (o.size) css.push('font-size:' + SIZE_CSS[o.size]);
    if (css.length) { opens.push('<span style="' + css.join(';') + '">'); closes.unshift('</span>'); }
    if (o.bold) { opens.push('<b>'); closes.unshift('</b>'); }
    if (o.italic) { opens.push('<i>'); closes.unshift('</i>'); }
    if (o.underline) { opens.push('<u>'); closes.unshift('</u>'); }
    if (o.strike) { opens.push('<s>'); closes.unshift('</s>'); }
    return opens.join('') + inner + closes.join('');
  }

  function walk(node) {
    var out = '';
    for (var n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { out += escText(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      var tag = n.tagName.toLowerCase();
      if (DROP_WITH_CONTENT[tag]) continue;
      if (tag === 'br') { out += '<br>'; continue; }
      var inner = walk(n);
      if (tag === 'sub' || tag === 'sup') { out += inner ? '<' + tag + '>' + inner + '</' + tag + '>' : ''; continue; }
      if (tag === 'ul' || tag === 'ol') { out += inner ? '<' + tag + '>' + inner + '</' + tag + '>' : ''; continue; }
      if (tag === 'li') { out += inner ? '<li>' + inner + '</li>' : ''; continue; }
      if (tag === 'td' || tag === 'th') { out += inner + ' '; continue; }
      if (BLOCK[tag]) {
        if (/^h[1-6]$/.test(tag)) inner = inner ? '<b>' + inner + '</b>' : '';
        out += inner ? '<div>' + inner + '</div>' : '';
        continue;
      }
      var o = INLINE_STYLED[tag] ? parseStyleAttr(n) : {};
      if (tag === 'b' || tag === 'strong') o.bold = true;
      else if (tag === 'i' || tag === 'em') o.italic = true;
      else if (tag === 'u' || tag === 'ins') o.underline = true;
      else if (tag === 's' || tag === 'strike' || tag === 'del') o.strike = true;
      else if (tag === 'mark') { if (!o.bg) o.bg = '#fde047'; }
      else if (tag === 'code') { if (!o.font) o.font = 'mono'; }
      else if (tag === 'small') { if (!o.size) o.size = 'small'; }
      else if (tag === 'big') { if (!o.size) o.size = 'large'; }
      else if (tag === 'font') {
        var c = parseColor(n.getAttribute('color')); if (c && !o.color) o.color = c;
        var f = parseFont(n.getAttribute('face')); if (f && !o.font) o.font = f;
        var z = FONT_SIZE_ATTR[parseInt(n.getAttribute('size'), 10)]; if (z && !o.size) o.size = z;
      }
      out += wrapStyled(inner, o);   // unknown tags (a, img, …) simply unwrap to their text
    }
    return out;
  }

  /* Allow-list sanitiser: returns a normalised HTML string. Idempotent. */
  function sanitize(html) {
    html = String(html == null ? '' : html);
    if (!html) return '';
    var doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
    return walk(doc.body);
  }

  /* ----------------------------------------------------------- plain / html */
  var BLOCKY = { div: 1, ul: 1, ol: 1, li: 1 };
  function plainFromHtml(html) {
    var doc = new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html');
    var out = '';
    (function w(node) {
      for (var n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { out += n.nodeValue; continue; }
        if (n.nodeType !== 1) continue;
        var t = n.tagName.toLowerCase();
        if (t === 'br') { out += '\n'; continue; }
        var blk = BLOCKY[t];
        if (blk && out && out.slice(-1) !== '\n') out += '\n';
        if (t === 'li') out += '- ';
        w(n);
        if (blk && out.slice(-1) !== '\n') out += '\n';
      }
    })(doc.body);
    return out.replace(/\u00A0/g, ' ').replace(/\n+$/, '').replace(/^\n+/, '');
  }
  function toPlain(stored) {
    stored = String(stored == null ? '' : stored);
    if (!isRich(stored)) return stored;
    return plainFromHtml(sanitize(stored.slice(MARK.length)));
  }
  var htmlMemo = {}, htmlMemoN = 0;
  function html(stored) {
    stored = String(stored == null ? '' : stored);
    if (htmlMemo[stored] !== undefined) return htmlMemo[stored];
    var out = isRich(stored) ? sanitize(stored.slice(MARK.length)) : escText(stored).replace(/\r?\n/g, '<br>');
    if (htmlMemoN > 800) { htmlMemo = {}; htmlMemoN = 0; }
    htmlMemo[stored] = out; htmlMemoN++;
    return out;
  }
  function htmlLabel(stored) { return html(stored).split(SEP).join(' · '); }
  function fromStored(stored) {
    stored = String(stored == null ? '' : stored);
    return isRich(stored) ? sanitize(stored.slice(MARK.length)) : escText(stored).replace(/\r?\n/g, '<br>');
  }
  function trimHtml(h) {
    var lead = /^(?:\s|&nbsp;|\u00A0|<br>|<div>(?:\s|<br>)*<\/div>)+/;
    var trail = /(?:\s|&nbsp;|\u00A0|<br>|<div>(?:\s|<br>)*<\/div>)+$/;
    var prev;
    do { prev = h; h = h.replace(lead, '').replace(trail, ''); } while (h !== prev);
    return h;
  }
  var FORMAT_RE = /<(?:b|i|u|s|span|sub|sup|ul|ol|li)\b/;
  function hasFormatting(sanitizedHtml) { return FORMAT_RE.test(sanitizedHtml); }

  /* Editor HTML -> stored string (plain when nothing is formatted). */
  function serialize(editorHtml) {
    var h = trimHtml(sanitize(editorHtml));
    if (!h) return '';
    if (hasFormatting(h)) return MARK + h;
    var p = plainFromHtml(h).trim();
    if (p.indexOf(MARK) === 0) return MARK + h;     // plain text that happens to start with the marker
    return p;
  }

  /* ------------------------------------------------------------------ cloze */
  function countBlanks(front) { return (String(front == null ? '' : front).match(/_____/g) || []).length; }
  function answerParts(card) {
    var back = card.back == null ? '' : String(card.back);
    var n = countBlanks(card.front);
    var rich = isRich(back);
    var body = rich ? back.slice(MARK.length) : back;
    var parts = n > 1 ? body.split(SEP) : [body];
    parts = parts.map(function (s) { return s.trim(); });
    if (n > 1) {
      if (parts.length > n) parts = parts.slice(0, n - 1).concat([parts.slice(n - 1).join(' ')]);
      while (parts.length < n) parts.push('');
    }
    return { rich: rich, parts: parts };
  }
  function answersHtml(card) {
    var a = answerParts(card);
    return a.parts.map(function (p) { return a.rich ? sanitize(p) : escText(p).replace(/\r?\n/g, '<br>'); });
  }
  function answersPlain(card) {
    var a = answerParts(card);
    return a.parts.map(function (p) { return a.rich ? plainFromHtml(sanitize(p)) : p; });
  }
  function clozeDisplay(card, revealed) {
    var ans = answersHtml(card), k = 0;
    return html(card.front).replace(/_____/g, function () {
      var a = ans[k++];
      return revealed ? '<span class="blank revealed">' + (a || '') + '</span>' : '<span class="blank">' + BLANK + '</span>';
    });
  }
  /* "The [[a]] is the [[b]]" (editor HTML) -> {front, back, count} stored strings, or {error}. */
  function clozeFromSentence(editorHtml) {
    var h = sanitize(editorHtml);
    var answers = [];
    var bad = false;
    var front = h.replace(/\[\[([\s\S]*?)\]\]/g, function (m, inner) {
      var a = trimHtml(sanitize(inner));
      if (!plainFromHtml(a).trim()) { bad = true; return m; }
      answers.push(a);
      return BLANK;
    });
    if (bad) return { error: 'A [[blank]] is empty — put the answer between the brackets.' };
    if (!answers.length) return { error: 'Mark each hidden answer with double brackets, e.g. The [[mitochondria]] is the powerhouse.' };
    var frontStored = serialize(front);
    var anyFmt = answers.some(hasFormatting);
    var backStored;
    if (anyFmt) backStored = MARK + answers.join(' ' + SEP + ' ');
    else backStored = answers.map(function (a) { return plainFromHtml(a).trim(); }).join(' ' + SEP + ' ');
    return { front: frontStored, back: backStored, count: answers.length };
  }
  function sentenceFromCloze(card) {
    var h = fromStored(card.front);
    var ans = answersHtml(card), k = 0;
    return h.replace(/_____/g, function () { var a = ans[k++]; return a === undefined ? BLANK : '[[' + a + ']]'; });
  }

  /* --------------------------------------------------------------- Anki I/O */
  function parseDelimited(text, sep) {
    var rows = [], row = [], f = '', i = 0, n = text.length, inQ = false, wasQ = false;
    while (i < n) {
      var ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') { if (text.charAt(i + 1) === '"') { f += '"'; i += 2; continue; } inQ = false; i++; continue; }
        f += ch; i++; continue;
      }
      if (ch === '"' && f === '' && !wasQ) { inQ = true; wasQ = true; i++; continue; }
      if (ch === sep) { row.push(f); f = ''; wasQ = false; i++; continue; }
      if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; wasQ = false; i++; continue; }
      f += ch; i++;
    }
    if (f !== '' || row.length || wasQ) { row.push(f); rows.push(row); }
    return rows;
  }
  function splitAnkiHeader(text) {
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    var lines = text.split('\n'), meta = {}, i = 0;
    while (i < lines.length && lines[i].charAt(0) === '#') {
      var m = lines[i].match(/^#([^:]+):(.*)$/);
      if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
      i++;
    }
    return { meta: meta, body: lines.slice(i).join('\n'), hasHeader: i > 0 && Object.keys(meta).length > 0 };
  }
  var SEP_NAMES = { tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':' };
  function looksLikeAnki(text) {
    var h = splitAnkiHeader(text);
    if (h.hasHeader && (h.meta.separator !== undefined || h.meta.html !== undefined || h.meta['tags column'] !== undefined ||
        h.meta['notetype column'] !== undefined || h.meta['deck column'] !== undefined || h.meta['guid column'] !== undefined)) return true;
    // Header-less tab-separated export: every record needs at least two columns.
    if (!h.body || h.body.indexOf('\t') < 0) return false;
    var rows = parseDelimited(h.body, '\t').filter(function (r) { return r.join('').trim(); });
    return rows.length >= 3 && rows.every(function (r) { return r.length >= 2 && r[0].trim(); });
  }

  /* *word* -> italic, **word** -> bold, applied to text only (never inside tags). */
  function markdownEmphasis(h, counter) {
    return h.split(/(<[^>]+>)/).map(function (seg, i) {
      if (i % 2) return seg;
      seg = seg.replace(/(^|[^\w*])\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*(?![\w*])/g, function (m, a, b) { counter.n++; return a + '<b>' + b + '</b>'; });
      seg = seg.replace(/(^|[^\w*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\w*])/g, function (m, a, b) { counter.n++; return a + '<i>' + b + '</i>'; });
      return seg;
    }).join('');
  }
  /* A) … C) … / B) … D) … (two columns pasted as rows)  ->  A, B, C, D one per line. */
  function normalizeOptions(h) {
    var re = /(^|>|\s)([A-E])([.)])\s+/g, marks = [], m;
    while ((m = re.exec(h))) marks.push({ letter: m[2], punc: m[3], start: m.index + m[1].length, end: m.index + m[0].length });
    if (marks.length < 3 || marks.length > 5) return null;
    var letters = marks.map(function (x) { return x.letter; }).sort().join('');
    if (letters !== 'ABCDE'.slice(0, marks.length)) return null;
    var stem = trimHtml(h.slice(0, marks[0].start));
    var opts = [];
    for (var i = 0; i < marks.length; i++) {
      var t = trimHtml(h.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : h.length));
      if (!t) return null;
      opts.push({ letter: marks[i].letter, text: t });
    }
    opts.sort(function (a, b) { return a.letter < b.letter ? -1 : 1; });
    var punc = marks.filter(function (x) { return x.letter === 'A'; })[0].punc;
    var rebuilt = (stem ? stem + '<br><br>' : '') + opts.map(function (o) { return o.letter + punc + ' ' + o.text; }).join('<br>');
    return rebuilt;
  }
  function ankiToHtml(f, o, isFront, counters) {
    var s = String(f == null ? '' : f).replace(/\r\n?/g, '\n').replace(/\n+/g, ' ');   // bare newlines are soft wraps in HTML
    s = sanitize(s).replace(/\u00A0/g, ' ').replace(/ {2,}/g, ' ').replace(/ ?<br> ?/g, '<br>');
    var one = s.match(/^<div>([\s\S]*)<\/div>$/);
    if (one && one[1].indexOf('<div') < 0) s = one[1];
    if (o.markdown) s = markdownEmphasis(s, counters.md);
    if (isFront && o.normalizeOptions) { var r = normalizeOptions(s); if (r && r !== s) { s = r; counters.opts++; } }
    return trimHtml(s);
  }
  function plainToHtml(f) { return escText(String(f == null ? '' : f).replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>'); }

  /* Parse an Anki / AnkiDroid "Notes in Plain Text" export. */
  function parseAnki(text, opts) {
    opts = opts || {};
    var o = { markdown: opts.markdown !== false, normalizeOptions: opts.normalizeOptions !== false };
    var h = splitAnkiHeader(text);
    var meta = h.meta;
    var sepName = (meta.separator || 'tab').toLowerCase();
    var sep = SEP_NAMES[sepName] || (meta.separator && meta.separator.length === 1 ? meta.separator : '\t');
    var htmlMode = String(meta.html || (h.hasHeader ? 'false' : 'true')).toLowerCase() !== 'false';
    var rows = parseDelimited(h.body, sep).filter(function (r) { return r.join('').trim() !== ''; });
    var metaIdx = {};
    ['tags', 'deck', 'notetype', 'guid'].forEach(function (k) { var v = parseInt(meta[k + ' column'], 10); if (v > 0) metaIdx[k] = v - 1; });
    var maxCols = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var used = {}; Object.keys(metaIdx).forEach(function (k) { used[metaIdx[k]] = 1; });
    var fieldIdx = [];
    for (var c = 0; c < maxCols; c++) if (!used[c]) fieldIdx.push(c);

    var cards = [], warnings = [], notes = [];
    var counters = { md: { n: 0 }, opts: 0 };
    var skippedEmpty = 0, clozeExtraDropped = 0, hintsDropped = 0, tagsSeen = 0, deckNames = {};
    rows.forEach(function (row) {
      var f1 = row[fieldIdx[0]] || '', f2 = fieldIdx.length > 1 ? (row[fieldIdx[1]] || '') : '';
      var nt = metaIdx.notetype !== undefined ? (row[metaIdx.notetype] || '') : '';
      if (metaIdx.tags !== undefined && (row[metaIdx.tags] || '').trim()) tagsSeen++;
      if (metaIdx.deck !== undefined && (row[metaIdx.deck] || '').trim()) deckNames[row[metaIdx.deck].trim()] = 1;
      var conv = function (f, front) { return htmlMode ? ankiToHtml(f, o, front, counters) : plainToHtml(f); };
      var isCloze = /\{\{c\d+::/.test(f1) || /cloze/i.test(nt);
      if (isCloze) {
        var sentence = conv(f1, false);
        var nums = {}; sentence.replace(/\{\{c(\d+)::/g, function (m, d) { nums[d] = 1; return m; });
        var keys = Object.keys(nums).sort(function (a, b) { return a - b; });
        if (!keys.length) { skippedEmpty++; return; }
        if (f2.trim()) clozeExtraDropped++;
        keys.forEach(function (num) {
          var s = sentence.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, function (m, d, ans, hint) {
            if (hint && d === num) hintsDropped++;
            return d === num ? '[[' + ans + ']]' : ans;
          });
          var res = clozeFromSentence(s);
          if (res.error) { skippedEmpty++; return; }
          cards.push({ type: 'cloze', front: res.front, back: res.back });
        });
        return;
      }
      var fh = conv(f1, true), bh = conv(f2, false);
      var front = serialize(fh), back = serialize(bh);
      if (!front || !back) { skippedEmpty++; return; }
      cards.push({ type: 'basic', front: front, back: back });
    });
    var nb = cards.filter(function (c) { return c.type === 'basic'; }).length;
    notes.push('Anki export detected (' + (sepName === 'tab' ? 'tab' : sepName) + '-separated, ' + (htmlMode ? 'HTML on' : 'plain text') + '): ' + rows.length + ' note' + (rows.length === 1 ? '' : 's') + '.');
    if (counters.opts) notes.push('Answer choices on ' + counters.opts + ' question' + (counters.opts === 1 ? '' : 's') + ' were put on separate lines in A, B, C, D order.');
    if (counters.md.n) notes.push(counters.md.n + ' *emphasis* mark' + (counters.md.n === 1 ? '' : 's') + ' converted to italic/bold.');
    if (Object.keys(deckNames).length) notes.push('The file lists its own deck names; every card goes into the deck you choose below.');
    if (tagsSeen) notes.push('Tags in the file are not kept (cards have no tags).');
    if (skippedEmpty) warnings.push(skippedEmpty + ' note' + (skippedEmpty === 1 ? ' was' : 's were') + ' skipped (empty front/back or an empty blank).');
    if (clozeExtraDropped) warnings.push('Extra text on ' + clozeExtraDropped + ' cloze note' + (clozeExtraDropped === 1 ? '' : 's') + ' (the "Back Extra" field) is not kept.');
    if (hintsDropped) warnings.push(hintsDropped + ' cloze hint' + (hintsDropped === 1 ? '' : 's') + ' dropped (cards have no hint field).');
    return { cards: cards, warnings: warnings, notes: notes, ignored: 0, source: 'anki', stats: { notes: rows.length, basic: nb, cloze: cards.length - nb } };
  }

  /* --------------------------------------------------------------- editor UI */
  var PALETTE_TEXT = [
    ['Red', '#dc2626'], ['Orange', '#ea580c'], ['Green', '#16a34a'], ['Teal', '#0d9488'], ['Blue', '#2563eb'],
    ['Purple', '#9333ea'], ['Pink', '#db2777'], ['Gray', '#6b7280']
  ];
  var PALETTE_HILITE = [
    ['Yellow', '#fde047'], ['Green', '#86efac'], ['Blue', '#93c5fd'], ['Pink', '#f9a8d4'], ['Orange', '#fdba74'], ['Purple', '#d8b4fe']
  ];
  var FONT_ITEMS = [
    ['Default', 'default', ''], ['Serif', 'serif', FONT_CSS.serif], ['Monospace', 'mono', FONT_CSS.mono], ['Handwriting', 'hand', FONT_CSS.hand]
  ];
  var SIZE_ITEMS = [['Small', '2'], ['Normal', '3'], ['Large', '4'], ['Larger', '5'], ['Huge', '6']];

  function mk(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function createEditor(host, opts) {
    opts = opts || {};
    host.innerHTML = '';
    var wrap = mk('div', 'rt-wrap');
    var bar = mk('div', 'rt-toolbar', { role: 'toolbar', 'aria-label': opts.toolbarLabel || 'Text formatting' });
    var area = mk('div', 'rt-area', { role: 'textbox', 'aria-multiline': 'true', 'data-placeholder': opts.placeholder || '' });
    area.contentEditable = 'true';
    if (opts.labelledBy) area.setAttribute('aria-labelledby', opts.labelledBy); else area.setAttribute('aria-label', opts.label || 'Text');
    if (opts.minHeight) area.style.minHeight = opts.minHeight;
    var listeners = [];
    var saved = null;
    var openPop = null;

    function inArea(node) { return node && area.contains(node.nodeType === 3 ? node.parentNode : node); }
    function save() {
      var s = window.getSelection();
      if (s && s.rangeCount && inArea(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
    }
    function restore() {
      area.focus({ preventScroll: true });
      if (saved) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); }
    }
    function changed() { listeners.forEach(function (fn) { fn(api); }); }
    function closePop() { if (openPop) { openPop.pop.hidden = true; openPop.btn.setAttribute('aria-expanded', 'false'); openPop = null; } }

    var toggles = [];
    function btn(label, title, cls) {
      var b = mk('button', 'rt-btn' + (cls ? ' ' + cls : ''), { type: 'button', 'aria-label': title, title: title });
      b.innerHTML = label;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      bar.appendChild(b);
      return b;
    }
    function exec(cmd, val) {
      restore();
      try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
      document.execCommand(cmd, false, val == null ? null : val);
      save(); changed(); refresh();
    }
    function toggle(label, title, cmd, cls) {
      var b = btn(label, title, cls);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { closePop(); exec(cmd); });
      toggles.push({ b: b, cmd: cmd });
      return b;
    }
    function popoverButton(label, title, build, cls) {
      var b = btn(label, title, cls);
      b.setAttribute('aria-haspopup', 'true'); b.setAttribute('aria-expanded', 'false');
      var pop = mk('div', 'rt-pop'); pop.hidden = true;
      build(pop);
      pop.addEventListener('mousedown', function (e) { e.preventDefault(); });
      wrap.appendChild(pop);
      b.addEventListener('click', function () {
        var wasOpen = openPop && openPop.pop === pop;
        closePop();
        if (wasOpen) return;
        pop.hidden = false; b.setAttribute('aria-expanded', 'true'); openPop = { pop: pop, btn: b };
        var left = b.offsetLeft; var maxLeft = wrap.clientWidth - pop.offsetWidth - 4;
        pop.style.left = Math.max(4, Math.min(left, maxLeft)) + 'px';
        pop.style.top = (bar.offsetTop + bar.offsetHeight + 2) + 'px';
      });
      return { b: b, pop: pop };
    }
    function swatchGrid(pop, items, cmd, noneLabel, noneValue) {
      var grid = mk('div', 'rt-swatches');
      items.forEach(function (it) {
        var s = mk('button', 'rt-swatch', { type: 'button', 'aria-label': it[0], title: it[0] });
        s.style.background = it[1];
        s.addEventListener('click', function () { closePop(); exec(cmd, it[1]); });
        grid.appendChild(s);
      });
      pop.appendChild(grid);
      var none = mk('button', 'rt-pop-item', { type: 'button' });
      none.textContent = noneLabel;
      none.addEventListener('click', function () { closePop(); exec(cmd, noneValue); });
      pop.appendChild(none);
    }

    toggle('<b>B</b>', 'Bold (Ctrl+B)', 'bold');
    toggle('<i>I</i>', 'Italic (Ctrl+I)', 'italic');
    toggle('<u>U</u>', 'Underline (Ctrl+U)', 'underline');
    toggle('<s>S</s>', 'Strikethrough', 'strikeThrough');
    popoverButton('<span class="rt-ico-a">A</span>', 'Text color', function (pop) { swatchGrid(pop, PALETTE_TEXT, 'foreColor', 'Default color', 'inherit'); }, 'rt-color');
    popoverButton('<span class="rt-ico-hl">ab</span>', 'Highlight', function (pop) { swatchGrid(pop, PALETTE_HILITE, 'hiliteColor', 'No highlight', 'transparent'); }, 'rt-hl');
    popoverButton('Font', 'Font', function (pop) {
      FONT_ITEMS.forEach(function (it) {
        var i = mk('button', 'rt-pop-item', { type: 'button' });
        i.textContent = it[0]; if (it[2]) i.style.fontFamily = it[2];
        i.addEventListener('click', function () { closePop(); exec('fontName', it[1] === 'default' ? 'inherit' : it[2].split(',')[0].replace(/['"]/g, '')); });
        pop.appendChild(i);
      });
    }, 'rt-wide');
    popoverButton('Size', 'Text size', function (pop) {
      SIZE_ITEMS.forEach(function (it) {
        var i = mk('button', 'rt-pop-item', { type: 'button' });
        i.textContent = it[0];
        i.addEventListener('click', function () { closePop(); exec('fontSize', it[1]); });
        pop.appendChild(i);
      });
    }, 'rt-wide');
    var clear = btn('Clear', 'Clear formatting', 'rt-wide');
    clear.addEventListener('click', function () { closePop(); exec('removeFormat'); });
    if (opts.cloze) {
      var bl = btn('[[&nbsp;]] Blank', 'Turn the selected text into a blank (adds double brackets)', 'rt-wide rt-blank');
      bl.addEventListener('click', function () { closePop(); insertBlank(); });
    }

    function insertBlank() {
      restore();
      var sel = window.getSelection();
      if (!sel.rangeCount || !inArea(sel.anchorNode)) return;
      var r = sel.getRangeAt(0).cloneRange();
      var collapsed = r.collapsed;
      var endR = r.cloneRange(); endR.collapse(false);
      var closeNode = document.createTextNode(']]'); endR.insertNode(closeNode);
      var startR = r.cloneRange(); startR.collapse(true);
      var openNode = document.createTextNode('[['); startR.insertNode(openNode);
      var nr = document.createRange();
      if (collapsed) { nr.setStart(closeNode, 0); nr.collapse(true); }
      else { nr.setStartAfter(openNode); nr.setEndBefore(closeNode); }
      sel.removeAllRanges(); sel.addRange(nr);
      save(); changed(); refresh();
    }

    function refresh() {
      toggles.forEach(function (t) {
        var on = false;
        try { on = document.activeElement === area && document.queryCommandState(t.cmd); } catch (e) {}
        t.b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    function onSel() {
      if (!document.body.contains(area)) { document.removeEventListener('selectionchange', onSel); return; }
      if (document.activeElement === area) { save(); refresh(); }
    }
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('mousedown', function outside(e) {
      if (!document.body.contains(area)) { document.removeEventListener('mousedown', outside); return; }
      if (openPop && !openPop.pop.contains(e.target) && !openPop.btn.contains(e.target)) closePop();
    });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openPop) { var b = openPop.btn; closePop(); b.focus(); e.stopPropagation(); }
    });

    area.addEventListener('input', function () {
      var h = area.innerHTML;
      if (h === '<br>' || h === '<div><br></div>') area.innerHTML = '';
      changed();
    });
    area.addEventListener('paste', function (e) {
      e.preventDefault();
      var t = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
      document.execCommand('insertText', false, t.replace(/\r\n?/g, '\n'));
    });
    area.addEventListener('drop', function (e) { e.preventDefault(); });
    area.addEventListener('keyup', save);
    area.addEventListener('mouseup', save);
    area.addEventListener('focus', function () { refresh(); });
    area.addEventListener('blur', function () { refresh(); });

    wrap.appendChild(bar); wrap.appendChild(area);
    host.appendChild(wrap);

    var api = {
      el: area,
      getHtml: function () { return sanitize(area.innerHTML); },
      getStored: function () { return serialize(area.innerHTML); },
      setStored: function (s) { area.innerHTML = fromStored(s); saved = null; },
      setHtml: function (h) { area.innerHTML = sanitize(h); saved = null; },
      isEmpty: function () { return !plainFromHtml(sanitize(area.innerHTML)).trim(); },
      clear: function () { area.innerHTML = ''; saved = null; },
      focus: function () { area.focus(); },
      onChange: function (fn) { listeners.push(fn); }
    };
    return api;
  }

  window.SRMS = window.SRMS || {};
  window.SRMS.rt = {
    MARK: MARK, SEP: SEP, BLANK: BLANK,
    isRich: isRich, sanitize: sanitize, toPlain: toPlain, html: html, htmlLabel: htmlLabel,
    fromStored: fromStored, serialize: serialize, hasFormatting: hasFormatting,
    countBlanks: countBlanks, answersHtml: answersHtml, answersPlain: answersPlain,
    clozeDisplay: clozeDisplay, clozeFromSentence: clozeFromSentence, sentenceFromCloze: sentenceFromCloze,
    looksLikeAnki: looksLikeAnki, parseAnki: parseAnki, parseDelimited: parseDelimited,
    editor: createEditor
  };
})();
