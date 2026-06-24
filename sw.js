// SW v14 — cache-bust via query string + auto-reload
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.matchAll({includeUncontrolled: true, type: 'window'}))
      .then(clients => clients.forEach(c => c.postMessage({type: 'SW_UPDATED'})))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Navegações: adiciona ?_cb=timestamp para burlar CDN do GitHub Pages
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    const url = new URL(e.request.url);
    url.searchParams.set('_cb', Date.now());
    e.respondWith(
      fetch(url.toString(), {cache: 'no-store', headers: {'Cache-Control': 'no-cache'}})
        .catch(() => fetch(e.request))
    );
  }
});
