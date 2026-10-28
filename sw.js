// Service Worker
// 策略：**页面与代码网络优先**，断网才回落到缓存。
// 之前是"缓存优先"，导致每次发版手机上都要手动清缓存 —— 2026-10-28 改。
const CACHE = 'zenus-shell-v6';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 网络优先：拿到就用网络（顺手更新缓存），拿不到用缓存
async function networkFirst(req, fallbackUrl) {
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  } catch (err) {
    const hit = (await caches.match(req)) || (fallbackUrl ? await caches.match(fallbackUrl) : null);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 外部（AI 接口）不拦
  if (url.origin !== self.location.origin) return;

  // 页面导航：网络优先，离线回外壳
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, './index.html'));
    return;
  }

  // 代码 / 内容包 / 清单：网络优先，保证改版与内容立刻生效
  if (/\.(js|json|webmanifest)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req));
    return;
  }

  // 图标等静态资源：缓存优先
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }))
  );
});
