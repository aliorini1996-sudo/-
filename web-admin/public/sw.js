// Service Worker لتطبيق المندوب (PWA) — يجعله قابلاً للتثبيت ويُسرّع التحميل
const CACHE = 'dsd-rep-v1';
const ASSETS = ['/rep', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // طلبات الـ API دائماً من الشبكة (لا تُخزَّن)
  if (request.url.includes('/api/')) return;
  // الأصول: الشبكة أولاً ثم الكاش عند انقطاع الاتصال
  event.respondWith(
    fetch(request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then(r => r || caches.match('/rep')))
  );
});
