const SHELL_CACHE = 'srms-app-shell-v1';
const VENDOR_CACHE = 'srms-offline-vendor-v1';
const META_CACHE = 'srms-offline-meta-v1';
const META_URL = '/__offline-data/active.json';
const OFFLINE_PAGE = '/offline.html';
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/flashcards.html',
  '/subject_scheduler_dashboard.html',
  '/manifest.webmanifest',
  '/app-icon.svg',
  '/maintenance-guard.js',
  '/maintenance.json',
  '/flashcard-modes.js',
  '/resources.js',
  '/shared/design-tokens.css',
  '/shared/components.css',
  '/shared/rich-text.css',
  '/shared/theme.js',
  '/shared/aria-utils.js',
  '/shared/presence.js',
  '/shared/rich-text.js',
  '/shared/offline-access.js',
  OFFLINE_PAGE
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('srms-app-shell-') && name !== SHELL_CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function activeBundleCache() {
  const meta = await caches.open(META_CACHE);
  const response = await meta.match(META_URL);
  if (!response) return null;
  const value = await response.json();
  if (!value.cacheName) return null;
  return caches.open(value.cacheName);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (request.url === XLSX_URL) {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch (error) {
        const cache = await caches.open(VENDOR_CACHE);
        const saved = await cache.match(request);
        if (saved) return saved;
        throw error;
      }
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__offline-data/')) {
    event.respondWith((async () => {
      const bundle = await activeBundleCache();
      const saved = bundle && await bundle.match(request);
      return saved || fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.status === 200 && url.pathname.startsWith('/resources/')) {
        const bundle = await activeBundleCache();
        if (bundle) await bundle.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const bundle = await activeBundleCache();
      const saved = bundle && await bundle.match(request);
      if (saved) return saved;

      const shell = await caches.open(SHELL_CACHE);
      const shellResponse = await shell.match(request, { ignoreSearch: true });
      if (shellResponse) return shellResponse;
      if (request.mode === 'navigate') {
        const offlinePage = await shell.match(OFFLINE_PAGE);
        if (offlinePage) return offlinePage;
      }
      throw error;
    }
  })());
});
