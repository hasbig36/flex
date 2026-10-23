/* Flex service worker: makes the app installable and shows a friendly page when offline.
   Video, live TV and the API always go straight to the network; nothing is cached but the offline page. */
const OFFLINE = '/offline.html';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('flex-v1').then((c) => c.add(new Request(OFFLINE, { cache: 'reload' }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== 'flex-v1').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
