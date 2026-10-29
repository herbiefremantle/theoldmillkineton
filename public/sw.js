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

// Phone notifications for the landlord (new requests from the website).
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'The Old Mill', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: d.tag || 'oldmill-enquiry', renotify: true, data: { url: d.url || '/landlord' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/landlord';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    return open ? open.navigate(url).then(c => c && c.focus()) : self.clients.openWindow(url);
  }));
});
