// Scripts and styles are network-first so a release cannot silently keep old UI code.
// APIs and Socket.IO are never cached. Offline mode only restores the shell.
const CACHE = 'werewolf-hardening-v4';
const SHELL = ['/', '/css/style.css', '/css/base.css', '/css/theme.css', '/css/roles.css', '/css/rooms.css', '/css/experience.css',
  '/css/tokens.css', '/images/moonlit-forest.svg', '/manifest.json'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.allSettled(SHELL.map(path => cache.add(path)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('werewolf-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/(api|socket\.io)\//.test(url.pathname)) return;
  if (request.mode === 'navigate' || /^\/(js|css)\//.test(url.pathname) || url.pathname === '/manifest.json') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch (_) {
        return (await cache.match(request)) || (request.mode === 'navigate' && await cache.match('/')) || new Response('网络已断开，请恢复连接后刷新', { status: 503 });
      }
    })());
  } else if (/^\/(images|icons)\//.test(url.pathname)) {
    const refresh = caches.open(CACHE).then(async cache => {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    });
    event.waitUntil(refresh.catch(() => {}));
    event.respondWith(caches.match(request).then(hit => hit || refresh));
  }
});
