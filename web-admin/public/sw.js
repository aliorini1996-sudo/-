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

// طلبات القياس الإعلاني (وسم Google Ads): نطاقات الوسم ومسارات التحويل على www.google.com.
// لا تُخزَّن إطلاقاً — روابطها فريدة في كل تحميل وتحمل رابط الهبوط بمعرّف النقر (gclid)،
// فكانت تتراكم استجابات opaque بلا انتهاء في حصّة النطاق نفسها التي يستخدمها صندوق
// فواتير المندوب الأوف-لاين، وتبقى بعد «إيقاف القياس».
// ⚠️ القاعدة نفسها في web-admin/src/lib/attribution.ts (isAdMeasurementUrl) —
// adsTracking.test.ts يشغّل هذا الملف ويفرض تطابق الطرفين.
const AD_MEASUREMENT_HOST = /(^|\.)(googletagmanager\.com|googleadservices\.com|doubleclick\.net|google-analytics\.com)$/i;
const isAdMeasurement = (url) =>
  AD_MEASUREMENT_HOST.test(url.hostname) ||
  (url.hostname === 'www.google.com' && /^\/(pagead|ccm|rmkt)/.test(url.pathname));

// يمحو ما خُزّن من طلبات القياس قبل هذا الإصدار — بلا رفع اسم الكاش، فالقوقعة والأصول
// المخزّنة للعمل دون اتصال تبقى كما هي.
// ⚠️ يُطلق من activate **خارج** waitUntil: يمرّ على كل مدخلات dsd-rep-v3 (أصول كل نشر سابق
// وبلاطات الخرائط والخطوط)، وطلبات الصفحات المفتوحة تنتظر انتهاء وعد التفعيل بحسب المواصفة
// (skipWaiting يفعّل العامل والصفحات مفتوحة) ⇒ لو انتُظر لتأخّرت الملاحة والأصول بعد النشر.
// تكراره لا يضرّ، و«إيقاف القياس» (optOut) يعيد تنظيف ما قد يبقى.
const purgeAdMeasurement = () =>
  caches.open(CACHE)
    .then((c) => c.keys().then((reqs) => Promise.all(
      reqs.filter((r) => { try { return isAdMeasurement(new URL(r.url)); } catch { return false; } })
        .map((r) => c.delete(r)),
    )))
    .catch(() => {});

self.addEventListener('activate', (event) => {
  // حذف الكاشات القديمة وحده يُنتظر: عدد أسمائها صغير ولا يمرّ على المدخلات
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
  purgeAdMeasurement();
});

// تحديث فوري عند نشر نسخة جديدة (يُرسله العميل بعد اكتشاف تحديث)
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

const isAsset = (path) => /\/assets\/.+\.(js|css|woff2?|ttf|png|jpg|jpeg|svg|webp)$/i.test(path);

// قوقعة أي مسار: تطبيق المندوب، تطبيق الإدارة، أو لا شيء (صفحات الموقع).
// الفصل ضروريّ كي لا يسمّم تطبيقٌ قوقعةَ الآخر ولا تسمّمهما صفحةُ تسويق.
const shellFor = (path) => {
  if (path === '/rep' || path.startsWith('/rep/')) return '/rep';
  if (path === '/m' || path.startsWith('/m/')) return '/m';
  return null;
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // القياس الإعلاني يمرّ إلى الشبكة مباشرةً بلا تخزين (انظر isAdMeasurement أعلاه)
  if (isAdMeasurement(url)) return;

  // طلبات API لا تُخزَّن إطلاقاً — الأوف-لاين لها عبر IndexedDB لا SW
  if (url.pathname.startsWith('/api/')) return;

  // الوسائط الضخمة (فيديو الدليل ونحوه): تمرّ للمتصفح مباشرةً — تخزينُها يفجّر
  // كاش الزائر، واعتراضُ SW يكسر طلبات Range فيتعطّل التقديم في المشغّل.
  if (url.pathname.startsWith('/media/')) return;

  // ملاحة الصفحات: الشبكة أولاً (نسخة حديثة)، وعند الانقطاع القوقعة المخزّنة.
  //
  // ⚠️ القوقعة تُخزَّن **فقط من مسار التطبيق نفسه**. كان يُخزَّن كل تنقّل تحت
  // المفتاح '/rep'، والموقع يخدم أكثر من ألف صفحة ثابتة حقيقية (تسويق/مدوّنة)،
  // فزيارةٌ واحدة لصفحة تسويقية كانت تستبدل قوقعة المندوب الأوف‑لاين بها —
  // فيُقلع التطبيق بلا شبكة على صفحة تسويق بدل شاشة العمل.
  if (request.mode === 'navigate') {
    const shell = shellFor(url.pathname); // '/rep' أو '/m' أو null لغير التطبيقات
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (shell) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(shell, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || (shell ? caches.match(shell) : undefined))),
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
