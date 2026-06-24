// SW v9 — limpa todos os caches anteriores e não faz mais cache
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.matchAll({includeUncontrolled: true}))
      .then(clients => clients.forEach(c => c.postMessage({type: 'SW_UPDATED'})))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Sem cache — tudo vai direto pra rede
