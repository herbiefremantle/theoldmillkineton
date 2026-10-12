// Deliberately does no caching. Its only job is to exist with a fetch handler, which Chrome requires before
// it will offer "Install app" / "Add to Home Screen" - so a deploy is never masked by a stale cached page or a
// stuck old worker. skipWaiting/clients.claim make a changed sw.js take over immediately.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Only the site's own requests pass through here; fonts and other sites load as normal.
self.addEventListener('fetch', event => {
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});
