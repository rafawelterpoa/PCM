// SW v13 — HTML sempre da rede + auto-reload ao atualizar
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

// Navegações HTML sempre da rede, sem cache HTTP
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'}).catch(() => fetch(e.request))
    );
  }
});
