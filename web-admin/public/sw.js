// Service Worker لتطبيق المندوب (PWA) — قوقعة أوف-لاين (M1 من مشروع العمل دون اتصال).
//
// الهدف: بعد أول زيارة أونلاين لـ /rep، يعمل التطبيق (يُقلع ويُعرض) بلا شبكة طوال اليوم.
// الاستراتيجية:
//   - الملاحة (فتح /rep): الشبكة أولاً، وعند الانقطاع القوقعة المخزّنة (index.html).
//   - الأصول المُجزّأة (/assets/*.js|css — أسماؤها مبصومة بالمحتوى فلا تتغيّر): الكاش أولاً.
//   - /api/*: الشبكة فقط، لا تُخزَّن هنا (بيانات الأوف-لاين في IndexedDB — M2).
// ملاحظة: الإقلاع البارد أوف-لاين (بلا أي زيارة أونلاين سابقة) غير ممكن — يلزم دخول أونلاين مرّة.

const CACHE = 'dsd-rep-v3';
const SHELL = ['/rep', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// تحديث فوري عند نشر نسخة جديدة (يُرسله العميل بعد اكتشاف تحديث)
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

const isAsset = (path) => /\/assets\/.+\.(js|css|woff2?|ttf|png|jpg|jpeg|svg|webp)$/i.test(path);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // طلبات API لا تُخزَّن إطلاقاً — الأوف-لاين لها عبر IndexedDB لا SW
  if (url.pathname.startsWith('/api/')) return;

  // ملاحة الصفحات: الشبكة أولاً (نسخة حديثة)، وعند الانقطاع القوقعة المخزّنة
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/rep', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/rep'))),
    );
    return;
  }

  // الأصول المبصومة: الكاش أولاً (ثابتة بمحتواها) — أسرع وأصمد أوف-لاين
  if (isAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        });
      }),
    );
    return;
  }

  // بقية الأصول: الشبكة أولاً ثم الكاش
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match('/rep'))),
  );
});
