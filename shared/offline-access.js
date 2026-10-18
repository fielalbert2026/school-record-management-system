(function(){
  'use strict';

  const GH = { owner:'fielalbert2026', repo:'school_record_management_system', branch:'main', root:'resources' };
  const META_CACHE = 'srms-offline-meta-v1';
  const META_URL = '/__offline-data/active.json';
  const RESOURCE_LIST_URL = '/__offline-data/resources.json';
  const WORKBOOK_URL = '/__offline-data/Subject_Scheduler.xlsx';
  const MANIFEST_URL = '/__offline-data/manifest.json';
  const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const OFFLINE_SESSION_KEY = 'srms_offline_session';
  const HIDDEN_FILE = /^(readme(\.\w+)?|thumbs\.db|desktop\.ini|\.ds_store)$/i;

  function cacheUrl(path) {
    return new URL(path, location.origin).href;
  }

  async function currentBundle() {
    const metaCache = await caches.open(META_CACHE);
    const response = await metaCache.match(cacheUrl(META_URL));
    if (!response) return null;
    const metadata = await response.json();
    if (!metadata.cacheName) return null;
    const cache = await caches.open(metadata.cacheName);
    if (!await cache.match(cacheUrl(MANIFEST_URL))) return null;
    return { cache, metadata };
  }

  async function fetchResourceList() {
    const url = `https://api.github.com/repos/${GH.owner}/${GH.repo}/git/trees/${encodeURIComponent(GH.branch)}?recursive=1`;
    const response = await fetch(url, { cache:'no-store' });
    if (!response.ok) throw new Error(`Could not list resources (${response.status}).`);
    const json = await response.json();
    const prefix = GH.root + '/';
    return (json.tree || [])
      .filter(node => node.type === 'blob' && node.path.startsWith(prefix))
      .filter(node => {
        const parts = node.path.split('/').slice(prefix.split('/').length - 1);
        return parts.length > 0 && !parts.some(part => part.startsWith('.')) && !HIDDEN_FILE.test(parts[parts.length - 1]);
      })
      .map(node => ({ path:node.path, size:node.size || 0 }));
  }

  async function fetchXlsxLibrary() {
    const request = new Request(XLSX_URL, { mode:'no-cors' });
    const response = await fetch(request);
    if (response.type !== 'opaque' && !response.ok) {
      throw new Error(`Could not prepare the offline spreadsheet reader (${response.status}).`);
    }
    const cache = await caches.open('srms-offline-vendor-v1');
    await cache.put(request, response);
  }

  async function prepare(options) {
    options = options || {};
    const session = options.session;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : function(){};
    if (!session || !session.presenceToken) {
      throw new Error('Sign in on the live site before preparing offline access.');
    }
    if (!('serviceWorker' in navigator) || !('caches' in window)) {
      throw new Error('This browser does not support offline site storage.');
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      throw new Error('Offline access requires the secure, deployed site.');
    }

    const registration = await navigator.serviceWorker.register('/service-worker.js');
    await navigator.serviceWorker.ready;

    onProgress({ phase:'listing', complete:0, total:0 });
    const files = await fetchResourceList();
    const resourceBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const free = (estimate.quota || 0) - (estimate.usage || 0);
      const required = resourceBytes + 10 * 1024 * 1024;
      if (Number.isFinite(estimate.quota) && free < required) {
        throw new Error(`This device has about ${Math.floor(free / 1048576)} MB free; offline access needs about ${Math.ceil(required / 1048576)} MB.`);
      }
    }

    const cacheName = `srms-offline-data-${Date.now()}`;
    const cache = await caches.open(cacheName);
    try {
      onProgress({ phase:'workbook', complete:0, total:files.length });
      const workbookResponse = await fetch('/api/offline-pack', {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Authorization':'Bearer ' + session.presenceToken
        },
        body:JSON.stringify({ accepted:true })
      });
      if (!workbookResponse.ok) {
        let result = {};
        try { result = await workbookResponse.json(); } catch (error) {}
        throw new Error(result.error || `Could not prepare offline workbook (${workbookResponse.status}).`);
      }
      await cache.put(cacheUrl(WORKBOOK_URL), workbookResponse);

      await fetchXlsxLibrary();
      let complete = 0;
      for (const file of files) {
        const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
        const fileUrl = cacheUrl('/' + encodedPath);
        const response = await fetch(fileUrl, { cache:'no-store' });
        if (!response.ok) throw new Error(`Could not cache ${file.path} (${response.status}).`);
        await cache.put(fileUrl, response);
        complete += 1;
        onProgress({ phase:'resources', complete, total:files.length, path:file.path });
      }

      const preparedAt = new Date().toISOString();
      const manifest = {
        version:1,
        preparedAt,
        source:`https://github.com/${GH.owner}/${GH.repo}`,
        resourceCount:files.length,
        resourceBytes,
        workbookSheets:['Subject_Scheduler', 'Flashcards', 'Decks'],
        omittedSheets:['Valid_Users', 'Audit_Log', 'and other non-study sheets'],
        useNotice:'Personal school study only. Do not redistribute, alter attribution, or use these materials to misrepresent authorship. Offline copies cannot be remotely revoked.'
      };
      await cache.put(cacheUrl(RESOURCE_LIST_URL), new Response(JSON.stringify(files), {
        headers:{'Content-Type':'application/json'}
      }));
      await cache.put(cacheUrl(MANIFEST_URL), new Response(JSON.stringify(manifest), {
        headers:{'Content-Type':'application/json'}
      }));

      const metaCache = await caches.open(META_CACHE);
      let previousPointer = null;
      let previousGrant = null;
      try{
        previousPointer = await metaCache.match(cacheUrl(META_URL));
        previousGrant = localStorage.getItem(OFFLINE_SESSION_KEY);
        localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify({
          name:'Offline learner', role:'Guest', isOwner:false, isOfflineGrant:true
        }));
        await metaCache.put(cacheUrl(META_URL), new Response(JSON.stringify({ cacheName, preparedAt }), {
          headers:{'Content-Type':'application/json'}
        }));
      }catch(error){
        if(previousPointer) await metaCache.put(cacheUrl(META_URL), previousPointer);
        else await metaCache.delete(cacheUrl(META_URL));
        if(previousGrant === null) localStorage.removeItem(OFFLINE_SESSION_KEY);
        else localStorage.setItem(OFFLINE_SESSION_KEY, previousGrant);
        throw new Error('Offline storage could not be activated. Check browser storage permissions and try again.');
      }

      const names = await caches.keys();
      await Promise.all(names
        .filter(name => name.startsWith('srms-offline-data-') && name !== cacheName)
        .map(name => caches.delete(name)));

      if (registration.active) registration.active.postMessage({ type:'OFFLINE_ACCESS_READY' });
      onProgress({ phase:'complete', complete:files.length, total:files.length });
      return manifest;
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
  }

  async function readWorkbook() {
    const bundle = await currentBundle();
    if (!bundle) return null;
    const response = await bundle.cache.match(cacheUrl(WORKBOOK_URL));
    return response ? response.arrayBuffer() : null;
  }

  async function readResourceList() {
    const bundle = await currentBundle();
    if (!bundle) return null;
    const response = await bundle.cache.match(cacheUrl(RESOURCE_LIST_URL));
    return response ? response.json() : null;
  }

  async function clear() {
    const metaCache = await caches.open(META_CACHE);
    localStorage.removeItem(OFFLINE_SESSION_KEY);
    await metaCache.delete(cacheUrl(META_URL));
    const names = await caches.keys();
    const bundleNames = names.filter(name => name.startsWith('srms-offline-data-'));
    await Promise.all(bundleNames.map(name => caches.delete(name)));
    return bundleNames.length > 0;
  }

  function restoreSession() {
    try {
      const session = JSON.parse(localStorage.getItem(OFFLINE_SESSION_KEY) || 'null');
      return session && session.isOfflineGrant === true
        ? { name:'Offline learner', role:'Guest', isOwner:false, isOfflineGrant:true }
        : null;
    } catch (error) {
      return null;
    }
  }

  function clearGrant() {
    try { localStorage.removeItem(OFFLINE_SESSION_KEY); }
    catch (error) { console.error('Could not clear the local offline profile:', error.message || error); }
  }

  const SRMS = (window.SRMS = window.SRMS || {});
  SRMS.offline = { prepare, readWorkbook, readResourceList, currentBundle, clear, restoreSession, clearGrant };
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/service-worker.js').catch(error => {
      console.warn('Offline app shell could not be installed:', error.message || error);
    });
  }
})();
