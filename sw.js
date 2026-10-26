// The authenticated dashboard must be checked by the server on every visit.
// Clear caches left by the previous public demo worker and unregister offline access.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(name => caches.delete(name)));
    await self.clients.claim();
    await self.registration.unregister();
  })());
});
