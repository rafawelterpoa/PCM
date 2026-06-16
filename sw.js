const CACHE = 'mills-pcm-v2';
const STATIC = ['/PCM/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Firebase e APIs externas: sempre network
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('emailjs')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{}', {headers: {'Content-Type': 'application/json'}})));
    return;
  }

  // index.html: sempre network-first (garante versão mais recente)
  if (url.pathname === '/PCM/' || url.pathname === '/PCM/index.html') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Demais recursos: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match('/PCM/index.html')))
  );
});
