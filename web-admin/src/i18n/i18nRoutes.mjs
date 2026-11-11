/**
 * وحدة المسارات والعناقيد للطبقة التسويقية متعددة اللغات — العقد المشترك (spec-b §٣).
 *
 * وحدة نقية: بلا fs ولا JSON ولا Intl ولا Date. البيانات تُمرَّر إليها معاملاتٍ دائماً، فيستوردها
 * من Node كلٌّ من prerender وgen-sitemap وgen-llms وverify-i18n، ومن المتصفح locale.ts وlang.ts وApp.tsx،
 * وتعطي الناتج نفسه حرفاً بحرف في الحالتين.
 *
 * مصدر الحقيقة الواحد:
 *  - المسارات: i18nPages() — لا تحسب أي وحدة أخرى مساراً بنفسها (ومنها صفحات الدول «country:<CC>» من reg.countryPages).
 *  - hreflang: clusterAlternates() — لا يكتب أحد عنقوداً بنفسه.
 *  - روابط الأزرار: quoteHref وmeetingHref وwaRedirectHref.
 *
 * الأنواع: i18nRoutes.d.mts (التوقيعات فيه هي العقد بين المجموعات، فلا تُغيَّر من طرف واحد).
 */

export const ORIGIN = 'https://fieldsa.net';

/** لغات الموقع القائمة قبل الطبقة — صفحاتها لا تتغيّر، والعربية وحدها RTL */
export const LEGACY = Object.freeze(['ar', 'en', 'fr', 'tr', 'zh']);

/** رموز hreflang للغات القديمة — الصينية مبسّطة تحديداً (HREFLANG_CODE في prerender وlib/seo.ts) */
export const LEGACY_HREFLANG = Object.freeze({ ar: 'ar', en: 'en', fr: 'fr', tr: 'tr', zh: 'zh-Hans' });

/** slug صفحة الفئة الافتراضي (الإنجليزية، ولأي slugHint لا يصلح رابطاً) */
export const DEFAULT_CATEGORY_SLUG = 'van-sales-software';

/**
 * المقاطع الأولى المحجوزة في الموقع: أول مقطع لكل مسار في App.tsx، وما يحجزه public وdist.
 * رمز لغة يساويها يصادم صفحة أو ملفاً قائماً، فيُرفض (checkLocaleCode). verify-i18n (G-codes) يعيد
 * الفحص ديناميكياً على App.tsx وpublic وdist، فلا تكفي هذه القائمة وحدها ولا تُعدّ نهائية.
 */
export const RESERVED_SEGMENTS = Object.freeze([
  'about', 'activate', 'app', 'app-r', 'assets', 'ax', 'blog', 'c', 'calculator', 'cities', 'contact', 'countries',
  'data', 'delete-account', 'e', 'email', 'free', 'hookb', 'hx', 'icons', 'invoice-generator', 'kds', 'languages',
  'login', 'm', 'media', 'meeting', 'og', 'owner', 'pay', 'payment', 'platform', 'pos', 'pricing', 'privacy',
  'profile', 'q-fs7k2m', 'rep', 'rep-app', 'restaurant', 'service-agreement', 'signup', 'staff', 'subscribe-request',
  'terms', 'tutorial', 'verify-email', 'llms.txt', 'llms-full.txt', 'sitemap.xml', 'robots.txt',
  'manifest.webmanifest', 'sw.js', 'قطاعات', 'مزايا', 'نماذج',
]);

/** صفحات كل لغة جديدة منشورة */
export const BASE_PAGES = Object.freeze(['home', 'category', 'countries', 'about', 'contact']);
/** صفحات الطبقة A — تُضاف حين tier==='A' ومحتواها مكتمل */
export const TIER_A_PAGES = Object.freeze([
  'features', 'feature:offlineInvoicing', 'feature:vanStock', 'feature:routesVisits', 'apps', 'quote',
]);

/** مقاطع محجوزة **داخل** اللغة: slug الفئة لا يساويها (يصادم صفحة أخرى للغة نفسها أو مساراً قديماً تحت en/fr) */
const SLUG_RESERVED = new Set([
  'countries', 'about', 'contact', 'features', 'apps', 'quote', 'meeting', 'blog', 'pricing', 'subscribe-request', 'llms.txt',
]);

/**
 * أنماط مسارات منسوخة **حرفياً** من مصادرها — رمز لغة يطابق `/${code}/` أحدها يقع داخل مسار تطبيق
 * أو يفقد زرّ واتساب وتتبّع الزيارة. اختبار i18nRoutes.test.ts يقارن كل نسخة بمصدرها نصياً،
 * فإن تغيّر المصدر فشل الاختبار حتى تُحدَّث النسخة هنا.
 */
// المصدر: isAppRoute في src/i18n/lang.ts (البديلان بالترتيب)
const APP_ROUTE_A = /^\/(app|rep|pos|kds|platform|owner|login|signup|verify)/;
const APP_ROUTE_B = /^\/(m|ax|activate|staff)(\/|$)/;
// المصدر: HIDDEN_ON في src/components/WhatsAppFab.tsx
const WA_HIDDEN_ON = /^\/(app|platform|owner|staff|login|verify-email|activate|rep|m|q-fs7k2m|hx|c|pay|e|ax)(\/|$)/;
// المصدر: استثناءات VisitTracker في src/App.tsx
const VISIT_TRACKER_SKIP = /^\/(app|platform|owner|staff|login|verify-email|activate|rep|m|q-fs7k2m|hx|c|pay|e|ax)(\/|$)/;

const CODE_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

// ─── صفحات الدول (نوع «country») ────────────────────────────────────────────────────────────
// صفحة دولة واحدة بلغة سوقها (المكسيك وكولومبيا بالإسبانية، والبرازيل بالبرتغالية، وإندونيسيا بالإندونيسية)،
// محتواها src/content/country-pages/<CC>.json وفهرسها المولَّد src/i18n/registry/country-pages.json
// (scripts/import-country-i18n.mjs). مفتاحها «country:<CC>» ومسارها /<lang>/<slug>/، وعنقودها ذاتي: لا نظير لها
// بلغة أخرى، فبدائلها نفسها وx-default نفسها.

/** مفتاح صفحة الدولة */
export const countryPageKey = (cc) => `country:${String(cc).toUpperCase()}`;
/** رمز الدولة من مفتاح الصفحة، أو null لغير صفحات الدول */
export function countryOfPageKey(pageKey) {
  const m = String(pageKey ?? '').match(/^country:([A-Z]{2})$/);
  return m ? m[1] : null;
}
/** هل المفتاح صفحة دولة */
export const isCountryPageKey = (pageKey) => countryOfPageKey(pageKey) !== null;

/**
 * slug صفحة الدولة من slugHint بالتطبيع نفسه لـnormalizeSlug، لكن **بلا رجوع** إلى slug افتراضي:
 * slug الفئة الافتراضي يصادم صفحة الفئة، فالناتج null (تُستثنى الدولة ويُذكر السبب) إن قصر عن 3 أحرف،
 * أو خلا من حرف لاتيني، أو ساوى مقطعاً محجوزاً داخل اللغة أو مقطع صفحة من صفحاتها (features …).
 */
export function countrySlug(hint) {
  if (hint == null || typeof hint !== 'string') return null;
  const s = hint
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (s.length < 3 || !/[a-z]/.test(s) || SLUG_RESERVED.has(s) || s === DEFAULT_CATEGORY_SLUG) return null;
  return s;
}

/** السجل مع فهرس صفحات الدول (country-pages.json) — كل مستهلك يقرأ الملفين ويدمجهما بهذه وحدها */
export function withCountryPages(reg, index) {
  const pages = index && Array.isArray(index.pages) ? index.pages : [];
  return { ...(reg || {}), countryPages: pages };
}

/** مدخل الفهرس لصفحة دولة منشورة (أو null) */
export function countryEntryOf(reg, code, pageKey) {
  const cc = countryOfPageKey(pageKey);
  if (!cc) return null;
  return ((reg && reg.countryPages) || []).find((x) => x && x.cc === cc && x.code === code) || null;
}

/**
 * slug صفحة الفئة من slugHint المترجم: NFKD ← حذف العلامات ← أحرف صغيرة ← كل ما ليس [a-z0-9] شرطة ←
 * ضغط الشرطات وقصّ الطرفين ← القصر على 60 (ثم قصّ شرطة طرفية إن خلّفها القصر).
 * يعود إلى DEFAULT_CATEGORY_SLUG إن قصر الناتج عن 3 أحرف، أو خلا من حرف لاتيني، أو ساوى مقطعاً محجوزاً
 * داخل اللغة. مثال: «نرم-افزار-پخش-گرم» ⇒ van-sales-software · «logiciel-vente-en-tournée» ⇒ logiciel-vente-en-tournee.
 */
export function normalizeSlug(hint) {
  let s = String(hint ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (s.length < 3 || !/[a-z]/.test(s) || SLUG_RESERVED.has(s)) s = DEFAULT_CATEGORY_SLUG;
  return s;
}

/** null = الرمز سليم مقطعاً أول لمسارات اللغة؛ وإلا سبب الرفض بالعربية */
export function checkLocaleCode(code, extraReserved = []) {
  const c = String(code ?? '');
  if (!CODE_RE.test(c)) return `الرمز «${c}» لا يطابق /^[a-z]{2,3}(-[a-z]{2,4})?$/`;
  // en/fr/tr/zh مقبولة: مسجّلة أصلاً بمساراتها القديمة (فتظهر في App.tsx وdist، وذلك ليس تصادماً)
  if (c !== 'ar' && LEGACY.includes(c)) return null;
  if (RESERVED_SEGMENTS.includes(c)) return `الرمز «${c}» مقطع محجوز في الموقع (RESERVED_SEGMENTS)`;
  if ((extraReserved || []).includes(c)) return `الرمز «${c}» يصادم مساراً قائماً (${c})`;
  const p = `/${c}/`;
  if (APP_ROUTE_A.test(p) || APP_ROUTE_B.test(p)) return `المسار ${p} يطابق isAppRoute (lang.ts) فيُعامل مسارَ تطبيق`;
  if (WA_HIDDEN_ON.test(p)) return `المسار ${p} يطابق HIDDEN_ON (WhatsAppFab.tsx) فيختفي زرّ واتساب`;
  if (VISIT_TRACKER_SKIP.test(p)) return `المسار ${p} يطابق استثناءات VisitTracker (App.tsx) فلا تُقاس زياراته`;
  return null;
}

/** المسار المطلق بشرطة أخيرة لصفحة من صفحات لغة */
export function pagePath(code, pageKey, slug) {
  switch (pageKey) {
    case 'home': return `/${code}/`;
    case 'category': return `/${code}/${slug || DEFAULT_CATEGORY_SLUG}/`;
    case 'countries': return `/${code}/countries/`;
    case 'about': return `/${code}/about/`;
    case 'contact': return `/${code}/contact/`;
    case 'features': return `/${code}/features/`;
    case 'feature:offlineInvoicing': return `/${code}/features/offline-invoicing/`;
    case 'feature:vanStock': return `/${code}/features/van-stock/`;
    case 'feature:routesVisits': return `/${code}/features/routes-visits/`;
    case 'apps': return `/${code}/apps/`;
    case 'quote': return `/${code}/quote/`;
    case 'languages': return '/languages/';
    default:
      if (isCountryPageKey(pageKey)) {
        if (!slug || countrySlug(slug) !== slug) throw new Error(`pagePath: slug صفحة الدولة «${slug}» غير صالح (${pageKey})`);
        return `/${code}/${slug}/`;
      }
      throw new Error(`pagePath: مفتاح صفحة غير معروف «${pageKey}»`);
  }
}

const PAGE_ORDER = [...BASE_PAGES, ...TIER_A_PAGES];

/**
 * كل صفحات الطبقة المنشورة بترتيب السجل، ثم صفحة /languages/ — يرمي إن تكرّر مسار.
 * صفحات الدول (reg.countryPages) تلي صفحات لغتها بترتيب الفهرس، ولا تُضاف إلا للغة منشورة لها صفحة الدول
 * (/<lang>/countries/ هي التي تربطها من صفّ الدولة).
 */
export function i18nPages(reg) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (seen.has(p.path)) throw new Error(`i18nPages: المسار ${p.path} مكرّر (${p.code}/${p.pageKey})`);
    seen.add(p.path);
    out.push(p);
  };
  for (const loc of (reg && reg.locales) || []) {
    const pages = new Set(loc.pages || []);
    for (const pageKey of PAGE_ORDER) {
      if (!pages.has(pageKey)) continue;
      push({
        code: loc.code, pageKey, path: pagePath(loc.code, pageKey, loc.slug),
        clusterKey: clusterOf(pageKey), hreflang: loc.hreflang, dir: loc.dir, legacy: !!loc.legacy,
      });
    }
    if (!pages.has('countries')) continue;
    for (const c of (reg && reg.countryPages) || []) {
      if (!c || c.code !== loc.code) continue;
      const pageKey = countryPageKey(c.cc);
      push({
        code: loc.code, pageKey, path: pagePath(loc.code, pageKey, c.slug),
        clusterKey: clusterOf(pageKey), hreflang: loc.hreflang, dir: loc.dir, legacy: false,
      });
    }
  }
  push({ code: 'en', pageKey: 'languages', path: '/languages/', clusterKey: null, hreflang: 'en', dir: 'ltr', legacy: true });
  return out;
}

/** مفتاح عنقود hreflang للصفحة — صفحة اللغات خارج كل عنقود */
export function clusterOf(pageKey) {
  if (isCountryPageKey(pageKey)) return pageKey;
  if (BASE_PAGES.includes(pageKey)) return pageKey;
  if (TIER_A_PAGES.includes(pageKey)) return `tierA:${pageKey}`;
  return null;
}

const pageKeyOfCluster = (key) => (String(key).startsWith('tierA:') ? String(key).slice('tierA:'.length) : key);

/**
 * الأعضاء القدامى الثابتون — بالصيغة نفسها التي يكتبها hreflangFor اليوم في prerender
 * (الجذر العربي ثم /en /fr /tr /zh، والصينية zh-Hans)؛ وabout/contact بثلاث لغات (trilingualHreflang).
 */
function legacyMembers(key) {
  if (key === 'home') {
    return [
      { hreflang: 'ar', href: canon(`${ORIGIN}/`) },
      ...['en', 'fr', 'tr', 'zh'].map((L) => ({ hreflang: LEGACY_HREFLANG[L], href: canon(`${ORIGIN}/${L}/`) })),
    ];
  }
  if (key === 'about' || key === 'contact') {
    return [
      { hreflang: 'ar', href: canon(`${ORIGIN}/${key}/`) },
      ...['en', 'fr'].map((L) => ({ hreflang: LEGACY_HREFLANG[L], href: canon(`${ORIGIN}/${L}/${key}/`) })),
    ];
  }
  return [];
}
const LEGACY_FIXED_CODES = { home: ['ar', 'en', 'fr', 'tr', 'zh'], about: ['ar', 'en', 'fr'], contact: ['ar', 'en', 'fr'] };

/** الأعضاء الجدد بترتيب السجل: كل لغة منشورة في pages عندها صفحة العنقود ولم تُضَف بعد */
function newMembers(key, reg, skipCodes) {
  const pageKey = pageKeyOfCluster(key);
  const out = [];
  const taken = new Set(skipCodes);
  for (const loc of (reg && reg.locales) || []) {
    if (taken.has(loc.code)) continue;
    if (!(loc.pages || []).includes(pageKey)) continue;
    taken.add(loc.code);
    out.push({ hreflang: loc.hreflang, href: canon(ORIGIN + pagePath(loc.code, pageKey, loc.slug)) });
  }
  return out;
}

/**
 * عنقود hreflang كاملاً: القدامى أولاً (ar,en,fr,tr,zh)، ثم الجدد بترتيب السجل، ثم x-default
 * (en إن وُجدت، وإلا ar، وإلا الأول). أقل من عضوين ⇒ [].
 * شرط الثبات: بلا لغة جديدة منشورة، ناتج home وabout وcontact مطابق حرفياً لما يكتبه
 * hreflangFor('/', خمس لغات) وtrilingualHreflang('/about'|'/contact') اليوم.
 */
export function clusterAlternates(key, reg) {
  if (isCountryPageKey(key)) {
    // عنقود ذاتي: كل صفحة منشورة بهذا المفتاح (واحدة اليوم — لا نظير لها بلغة أخرى)، وx-default بالقاعدة نفسها
    // (en ثم ar ثم الأول) ⇒ الصفحة نفسها. عضو واحد يكفي هنا: الإعلان الذاتي مقصود (canonical وhreflang متطابقان).
    const own = i18nPages(reg).filter((p) => p.pageKey === key).map((p) => ({ hreflang: p.hreflang, href: canon(ORIGIN + p.path) }));
    if (!own.length) return [];
    return [...own, { hreflang: 'x-default', href: xDefaultOf(own, ['en', 'ar']).href }];
  }
  const members = [...legacyMembers(key), ...newMembers(key, reg, LEGACY_FIXED_CODES[key] || [])];
  if (members.length < 2) return [];
  const xd = xDefaultOf(members, ['en', 'ar']);
  return [...members, { hreflang: 'x-default', href: xd.href }];
}

/** الأعضاء الجدد وحدهم (بلا القدامى الثابتين ولا x-default) — تستعملها seoUrls في locale.ts */
export function newClusterMembers(key, reg) {
  return newMembers(key, reg, LEGACY_FIXED_CODES[key] || []);
}

/** مفتاح عنقود الصفحات القديمة الممدَّدة: '/' ⇒ home · '/about' ⇒ about · '/contact' ⇒ contact */
export function legacyClusterKey(arPath) {
  const p = String(arPath ?? '').replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  if (p === '/about') return 'about';
  if (p === '/contact') return 'contact';
  return null;
}

/** ذاكرة مؤقتة لكل سجل: المسار ⇒ الصفحة (السجل كائن ثابت في المتصفح وفي البناء) */
const byPathCache = new WeakMap();

/** صفحة الطبقة لمسار (مُرمَّز أو مفكوك، بشرطة أخيرة أو بدونها)، أو null */
export function i18nPageForPath(pathname, reg) {
  if (!reg || typeof reg !== 'object') return null;
  let map = byPathCache.get(reg);
  if (!map) {
    map = new Map(i18nPages(reg).map((p) => [p.path, p]));
    byPathCache.set(reg, map);
  }
  let p = String(pathname ?? '').split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { /* ترميز تالف — يبقى كما هو */ }
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p += '/';
  return map.get(p) || null;
}

/** لغة واجهة التطبيق لصفحة من الطبقة: الرمز نفسه إن كان من الخمس، وإلا الإنجليزية */
export function uiLangFor(code) {
  return LEGACY.includes(code) ? code : 'en';
}

/**
 * زرّ «طلب عرض سعر»: نموذج الفرنسية للفرنسية، والإنجليزية لغيرها — الخادم يقبل لغات الموقع الخمس وحدها
 * في نماذجه، فلا نموذج بلغة جديدة ولا تعديل على backend.
 */
export function quoteHref(code) {
  return code === 'fr' ? '/fr/subscribe-request/?type=quote' : '/en/subscribe-request/?type=quote';
}

/** زرّ «احجز اجتماعاً»: صفحات الاجتماع القائمة بالفرنسية والتركية والصينية، والإنجليزية لغيرها */
export function meetingHref(code) {
  return code === 'fr' || code === 'tr' || code === 'zh' ? `/${code}/meeting/` : '/en/meeting/';
}

/** نسخة من refFromPath في src/components/WhatsAppFab.tsx (المنطق نفسه: فكّ ← قصّ الشرطات ← / إلى - ← 48 حرفاً) */
function refFromPath(path) {
  let p = (path || '/').split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* ترميز تالف — نُبقيه كما هو */ }
  p = p.replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  return p.replace(/^\/+/, '').replace(/\//g, '-').slice(0, 48) || 'home';
}

/**
 * رابط واتساب **ثابت** في صفحات الطبقة: المحوّل نفسه الذي يستعمله الزرّ العائم، لا رقم CMS —
 * React لا يملك رقم CMS قبل جلبه، فيختلف المُصيَّر عن المرسوم لو أُخذ منه. بلا معرّف زائر (a):
 * الرابط جزء من HTML ثابت يراه الزاحف.
 */
export function waRedirectHref(page) {
  const params = new URLSearchParams({ ref: refFromPath(page.path), p: page.path, l: page.code });
  return `https://api.fieldsa.net/api/analytics/go/wa?${params.toString()}`;
}

/** المفاتيح المشتركة في كل صفحة (سطر الأزرار وملاحظة لغات الواجهة) */
const COMMON_KEYS = ['tierB.home.cta.quote', 'tierB.home.cta.meeting', 'tierB.home.cta.whatsapp', 'tierB.home.uiLanguagesNote'];

function prefixOf(pageKey) {
  if (isCountryPageKey(pageKey)) return 'tierB.countries.h1'; // صفحة الدولة: محتواها من ملف الدولة، ومن ملف اللغة الأزرار وملاحظة الواجهة وعنوان صفحة الدول (مسار التنقّل)
  switch (pageKey) {
    case 'home': return 'tierB.home.';
    case 'category': return 'tierB.category.';
    case 'countries': return 'tierB.countries.';
    case 'about': return 'tierB.about.';
    case 'contact': return 'tierB.contact.';
    case 'features': return 'tierA.features.';
    case 'apps': return 'tierA.apps.';
    case 'quote': return 'tierA.quote.';
    default:
      if (String(pageKey).startsWith('feature:')) return `tierA.featurePages.${String(pageKey).slice('feature:'.length)}.`;
      return null; // languages: نصّ مكتوب في القالب، بلا مفاتيح محتوى
  }
}

/** مفاتيح المحتوى التي تحتاجها صفحة: مفاتيح en ببادئة الصفحة + المفاتيح المشتركة (بترتيب en، بلا تكرار) */
export function requiredKeys(pageKey, enKeys) {
  const prefix = prefixOf(pageKey);
  if (!prefix) return [];
  const out = [];
  const seen = new Set();
  for (const k of enKeys || []) {
    if ((k.startsWith(prefix) || COMMON_KEYS.includes(k)) && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  for (const k of COMMON_KEYS) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

/**
 * نسخة مطابقة لـcanon في prerender.mjs وgen-sitemap.mjs: شرطة أخيرة لكل رابط إلا الملفات ذات الامتداد.
 * (Render يخدم المجلّد بشرطة فقط؛ بدونها تبتلع قاعدة SPA الطلب وتعيد قوقعة فارغة.)
 */
export function canon(url) {
  const m = String(url).match(/^(https?:\/\/[^/]+)(\/[^#?]*)?([#?].*)?$/);
  if (!m) return url;
  const [, origin, p = '/', rest = ''] = m;
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return url;
  return p.endsWith('/') ? origin + p + rest : origin + p + '/' + rest;
}

/**
 * عضو x-default: أول عضو يطابق hreflang من قائمة التفضيل بالترتيب (['en','ar'] في كل الموقع)، وإلا الأول.
 * القاعدة نفسها في xDefaultOf بـprerender وgen-sitemap وxDefaultLang في locale.ts.
 */
export function xDefaultOf(members, hreflangs) {
  const list = (members || []).filter((m) => m && m.hreflang !== 'x-default');
  for (const h of hreflangs || []) {
    const hit = list.find((m) => m.hreflang === h);
    if (hit) return hit;
  }
  return list[0];
}
