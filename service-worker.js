self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter(name => name.startsWith('srms-app-shell-') || name.startsWith('srms-offline-'))
      .map(name => caches.delete(name)));
    await self.registration.unregister();
  })());
});
