/* resources.js — directory-driven Resources browser for the Study Hub.
 *
 * Reads the repo's file tree from GitHub (one request, cached for 5 minutes) and renders
 * everything under  resources/  as collapsed folders:
 *
 *   resources/
 *     SY2026+/              <- school year (any name; add SY2027+ later and it just appears)
 *       Mathematics/        <- subject (any name, any nesting depth)
 *         Week1_Notes.pdf   <- files (any type)
 *
 * No manifest to maintain: push files into the folder and they show up.
 * Usage:  SRMS.resources.init({ owner, repo, branch })   // optional: root:'resources'
 */
(function(){
  const SRMS = (window.SRMS = window.SRMS || {});

  const CACHE_KEY = 'srms_res_cache_v1';
  const OPEN_KEY  = 'srms_res_open_v1';
  const TTL_MS    = 5 * 60 * 1000;
  const HIDDEN_FILES = /^(readme(\.\w+)?|thumbs\.db|desktop\.ini|\.ds_store)$/i;
  const collator = new Intl.Collator(undefined, { numeric:true, sensitivity:'base' });

  let cfg = null;
  let files = [];            // [{path, size}] — only files under the root
  let openSet = loadOpen();  // folder paths the user expanded (everything starts closed)
  let query = '';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function loadOpen(){
    try{ return new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY) || '[]')); }catch(e){ return new Set(); }
  }
  function saveOpen(){
    try{ sessionStorage.setItem(OPEN_KEY, JSON.stringify([...openSet])); }catch(e){}
  }

  /* ---------- data ---------- */
  async function fetchFiles(force){
    if(!force){
      try{
        const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
        if(c && Date.now() - c.t < TTL_MS && c.root === cfg.root) return c.files;
      }catch(e){}
    }
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`;
    const res = await fetch(url, { cache:'no-store' });
    if(!res.ok){
      if(res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests right now. Try again in a few minutes.');
      throw new Error(`Couldn't load resources (${res.status}).`);
    }
    const json = await res.json();
    const prefix = cfg.root + '/';
    const out = (json.tree || [])
      .filter(n => n.type === 'blob' && n.path.startsWith(prefix))
      .map(n => ({ path:n.path, size:n.size || 0 }));
    try{ sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t:Date.now(), root:cfg.root, files:out })); }catch(e){}
    return out;
  }

  function buildTree(list){
    const root = { name:'', path:'', dirs:new Map(), files:[] };
    const skip = cfg.root.split('/').length;
    for(const f of list){
      const segs = f.path.split('/').slice(skip);
      if(!segs.length) continue;
      if(segs.some(s => s.startsWith('.'))) continue;             // .gitkeep, .DS_Store, hidden folders
      if(HIDDEN_FILES.test(segs[segs.length - 1])) continue;       // README, Thumbs.db…
      let n = root;
      for(let i = 0; i < segs.length - 1; i++){
        const s = segs[i];
        if(!n.dirs.has(s)) n.dirs.set(s, { name:s, path:n.path + s + '/', dirs:new Map(), files:[] });
        n = n.dirs.get(s);
      }
      n.files.push({ name:segs[segs.length - 1], path:f.path, size:f.size });
    }
    return root;
  }

  const countFiles = (n) => n.files.length + [...n.dirs.values()].reduce((a, d) => a + countFiles(d), 0);

  /* ---------- display helpers ---------- */
  const prettyName = (s) => s.replace(/_/g, ' ');
  const fmtSize = (b) => !b ? '' : b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(name); return m ? m[1].toUpperCase().slice(0, 4) : 'FILE'; };
  const hrefFor = (path) => path.split('/').map(encodeURIComponent).join('/');

  /* ---------- render ---------- */
  function fileHtml(f){
    return `<a class="res-file" href="${esc(hrefFor(f.path))}" target="_blank" rel="noopener">
      <span class="res-ext">${esc(extOf(f.name))}</span>
      <span class="res-name">${esc(f.name)}</span>
      <span class="dn-meta">${esc(fmtSize(f.size))}</span>
    </a>`;
  }

  // Returns '' when a node has nothing matching the current filter.
  function nodeHtml(n, depth, q){
    const match = (f) => !q || (f.path.toLowerCase().includes(q));
    const dirs = [...n.dirs.values()].sort((a, b) => depth === 0 ? collator.compare(b.name, a.name) : collator.compare(a.name, b.name));
    const kids = dirs.map(d => nodeHtml(d, depth + 1, q)).join('');
    const fl = n.files.filter(match).sort((a, b) => collator.compare(a.name, b.name));
    if(!kids && !fl.length) return '';
    const total = q ? fl.length + (kids.match(/class="res-file"/g) || []).length : countFiles(n);
    const open = q ? true : openSet.has(n.path);
    return `<details class="dnode res-node d${Math.min(depth, 3)}" data-path="${esc(n.path)}" ${open ? 'open' : ''}>
      <summary><span class="dn-name">${esc(prettyName(n.name))}</span><span class="dn-meta">${total} file${total === 1 ? '' : 's'}</span></summary>
      <div class="dn-body">${kids}${fl.length ? `<div class="card-list res-files">${fl.map(fileHtml).join('')}</div>` : ''}</div>
    </details>`;
  }

  function render(){
    const wrap = $('resBrowser');
    const tree = buildTree(files);
    const total = countFiles(tree);
    $('resSummary').textContent = total ? `${tree.dirs.size} folder${tree.dirs.size === 1 ? '' : 's'} · ${total} file${total === 1 ? '' : 's'}` : '';
    $('resFilterRow').style.display = total > 8 ? 'flex' : 'none';

    if(!total){
      wrap.innerHTML = '<div class="db-empty-hint">No resources yet. Files placed in the <code>' + esc(cfg.root) + '/</code> folder will appear here.</div>';
      return;
    }
    const q = query.trim().toLowerCase();
    let html = [...tree.dirs.values()].sort((a, b) => collator.compare(b.name, a.name)).map(d => nodeHtml(d, 0, q)).join('');
    const loose = tree.files.filter(f => !q || f.path.toLowerCase().includes(q)).sort((a, b) => collator.compare(a.name, b.name));
    if(loose.length) html += `<div class="card-list res-files res-loose">${loose.map(fileHtml).join('')}</div>`;
    wrap.innerHTML = html || '<div class="db-empty-hint">No files match your filter.</div>';

    wrap.querySelectorAll('details.res-node').forEach(el => {
      el.addEventListener('toggle', () => {
        if(query.trim()) return;                                    // filtering forces open; don't record it
        if(el.open) openSet.add(el.dataset.path); else openSet.delete(el.dataset.path);
        saveOpen();
      });
    });
  }

  /* ---------- lifecycle ---------- */
  async function load(force){
    const wrap = $('resBrowser');
    wrap.innerHTML = '<div class="db-empty-hint">Loading resources…</div>';
    try{
      files = await fetchFiles(force);
      render();
    }catch(e){
      wrap.innerHTML = '<div class="db-empty-hint">' + esc(e.message) + ' <button type="button" class="btn-text" id="resRetryBtn">Retry</button></div>';
      const r = $('resRetryBtn'); if(r) r.addEventListener('click', () => load(true));
    }
  }

  SRMS.resources = {
    init(opts){
      cfg = { owner:opts.owner, repo:opts.repo, branch:opts.branch || 'main', root:(opts.root || 'resources').replace(/^\/|\/$/g, '') };
      $('resFilterInput').addEventListener('input', (e) => { query = e.target.value; render(); });
      $('resRefreshBtn').addEventListener('click', () => load(true));
      load(false);
    },
    setVisible(show){ const w = $('resourcesWrap'); if(w) w.style.display = show ? '' : 'none'; }
  };
})();
