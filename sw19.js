// SW v19 — sem auto-reload, atualiza silenciosamente
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch('https://rafawelterpoa.github.io/PCM/index.html', {cache: 'reload'})
        .catch(() => fetch(e.request))
    );
  }
});
