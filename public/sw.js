// Service Worker —— 仅在外壳层面做缓存。
//
// 说清楚它值多少：本应用所有对局状态都走 Socket.IO 实时推送，**离线时几乎无用**，
// 断网只能看到外壳和「连接已断开」。SW 的实际收益是让 Chromium 愿意弹出安装提示，
// 以及 PWA 冷启动快一点。不要把它当成「离线可玩」的实现。
//
// 局域网 http://192.168.x.x:3000 是不安全源，SW 根本无法注册——这是预期行为，
// 客户端已用 isSecureContext 守卫，静默跳过，不影响任何功能。

const CACHE = 'werewolf-v1';

// 只预缓存外壳。JS 模块不逐个列出——没有打包器，手工维护清单必然会漏，
// 一旦漏了就出现「新外壳 + 旧模块」的错配，比不缓存更糟。
// 模块由下面的 stale-while-revalidate 在首次访问时自然填充。
const SHELL = [
  '/',
  '/css/tokens.css',
  '/css/style.css',
  '/icons/icon-192.png',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 用 allSettled：个别资源取不到也不该让整个安装失败
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // 只处理同源 GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Socket.IO 与 API 一律直连，绝不缓存。
  // Socket.IO 的握手是 HTTP 轮询（一个 GET），缓存住它会让连接以极难排查的方式坏掉。
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) return;

  // 页面导航：网络优先，断网时回落到缓存的外壳
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // 静态资源：stale-while-revalidate —— 先用缓存立即响应，后台拉新版本。
  // 零构建项目不能给 JS 设长缓存，否则部署后必然出现新旧模块错配；
  // SWR 让每次加载都顺手刷新缓存，新版本下一次进入即生效。
  if (/^\/(js|css|icons)\//.test(url.pathname) || url.pathname === '/manifest.json') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })());
  }
});
