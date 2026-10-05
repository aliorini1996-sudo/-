/**
 * دمج المقالات الرقيقة المكرّرة في مقالاتها الغنية (بند P3).
 *
 * لماذا: كل كلمة رابحة كانت تتنافس عليها ثلاث صفحات أو أكثر. مقالات CMS رقيقة (نحو مئة كلمة)
 * نُشرت يومياً بين أبريل ويونيو 2026، ولكلٍّ منها توأم في الكتالوج يغطي الموضوع نفسه بعمق
 * (سبعمئة كلمة فأكثر). الزوجان يتقاسمان إشارات الترتيب، فيضعفان معاً.
 *
 * العلاج بلا حذف: المقال الرقيق يبقى حيّاً للزائر بمحتواه كما هو، لكن canonical فيه يشير إلى
 * المقال الغني، ويخرج من الخريطة ومن عنقود hreflang ومن فهرس المدوّنة. فيتجمّع الوزن في صفحة واحدة.
 *
 * القائمة محافظة: الأزواج الأربعة عشر التي أكّدتها مراجعة أكتوبر 2026 (الموضوع واحد، والفرق
 * في العمق كبير، والهدف صفحة كتالوج قائمة canonical لنفسها). لا تُوسَّع قبل أن يُظهر Search Console
 * أن جوجل احترم canonical هنا (تقرير «Duplicate, Google chose different canonical»): canonical مع
 * محتوى مختلف إشارة يجوز لجوجل تجاهلها.
 *
 * الملف نقيّ بلا fs ولا شبكة: يستورده BlogPostPage وBlogIndexPage في المتصفح، وprerender وgen-sitemap
 * وقت البناء، وgen-llms (isConsolidated / consolidatedFor). فالقرار نفسه يصل الزاحف والزائر والخريطة.
 *
 * القاعدة: لا يُطبَّق إدخال للغة إلا إن كان الهدف موجوداً بتلك اللغة (exists أدناه).
 */
import { buildCatalog, isIndexable } from './seo/catalog.mjs';

export const ORIGIN = 'https://fieldsa.net';

/**
 * slug المقال الرقيق ← هدفه لكل لغة.
 * en مذكورة فقط حيث للمقال الرقيق نسخة إنجليزية فعلاً (قِيس على CMS الحيّ في 4 أكتوبر 2026).
 * @type {Record<string, { ar?: string, en?: string }>}
 */
export const CONSOLIDATE = {
  'choose-field-sales-system': { ar: 'how-to-choose-field-sales-system' },
  'collection-receivables-distribution': { ar: 'collection-receivables' },
  'gps-tracking-sales-reps': { ar: 'gps-rep-tracking' },
  'what-is-field-sales-management-software': { ar: 'what-is-field-sales-management', en: 'what-is-field-sales-management' },
  'van-stock-management': { ar: 'van-stock-inventory', en: 'van-stock-inventory' },
  'route-planning-sales-reps': { ar: 'route-planning-sales', en: 'route-planning-sales' },
  'distribution-digital-transformation-ksa': { ar: 'digital-transformation-distribution', en: 'digital-transformation-distribution' },
  'field-order-management-best-practices': { ar: 'van-sales-best-practices', en: 'van-sales-best-practices' },
  'daily-van-inventory-count': { ar: 'van-stock-inventory' },
  'thermal-printing-58mm-invoices': { ar: 'thermal-printing-invoices' },
  'reduce-dso-receivables': { ar: 'reduce-overdue-receivables' },
  'offline-mode-field-app': { ar: 'offline-field-sales-app', en: 'offline-field-sales-app' },
  'distribution-analytics': { ar: 'sales-reports-analytics', en: 'sales-reports-analytics' },
  'field-sales-roi': { ar: 'field-sales-system-roi' },
};

/**
 * هدف الدمج للمقال slug بلغة L، أو null إن لم يُدمج.
 * exists(target, L) اختياري: إن مُرِّر لا يُطبَّق الإدخال إلا إن كان الهدف موجوداً بتلك اللغة.
 * @param {string} slug
 * @param {string} L
 * @param {(slug: string, L: string) => boolean} [exists]
 * @returns {string | null}
 */
export function consolidatedTarget(slug, L, exists) {
  const entry = Object.prototype.hasOwnProperty.call(CONSOLIDATE, slug) ? CONSOLIDATE[slug] : null;
  const target = entry ? entry[L] : null;
  if (!target || target === slug) return null;
  if (typeof exists === 'function' && !exists(target, L)) return null;
  return target;
}

/** هل المقال slug بلغة L مدموج في غيره؟ (لـgen-llms والفهارس) */
export const isConsolidated = (slug, L, exists) => consolidatedTarget(slug, L, exists) !== null;

/** رابط canonical للهدف بلغة L — بشرطة أخيرة (Render يخدم المجلد فقط حين ينتهي الطلب بشرطة) */
export const consolidatedUrl = (target, L) => `${ORIGIN}${L === 'ar' ? '' : `/${L}`}/blog/${target}/`;

/** كل الإدخالات مسطّحة: [{ slug, lang, target }] — للسجل والاختبار */
export function consolidationEntries() {
  const out = [];
  for (const [slug, langs] of Object.entries(CONSOLIDATE)) {
    for (const [lang, target] of Object.entries(langs)) out.push({ slug, lang, target });
  }
  return out;
}

/**
 * يبني فحص وجود الهدف من بيانات الكتالوج والمقالات اليدوية — المنطق نفسه في البناء والمتصفح.
 * - مقال كتالوج: موجود إن كان canonical لنفسه وقابلاً للفهرسة بتلك اللغة (isIndexable إن مُرِّر).
 * - مقال يدوي: العربية دائماً، والإنجليزية إن كان له نسخة en (أو bilingual في الخريطة).
 * - الهدف المدموج هو نفسه لا يُقبل (لا سلاسل دمج).
 * @param {{ catalog?: Array<{slug: string, cc?: string|null, isCanonical?: boolean}>,
 *           isIndexable?: (cc: string|null, L: string) => boolean,
 *           manual?: Array<{slug: string, en?: {title?: string}, bilingual?: boolean}> }} src
 * @returns {(slug: string, L: string) => boolean}
 */
export function targetExistsFrom({ catalog = [], isIndexable: indexable, manual = [] } = {}) {
  const cat = new Map(catalog.map((e) => [e.slug, e]));
  const man = new Map(manual.map((p) => [p.slug, p]));
  return (slug, L) => {
    if (Object.prototype.hasOwnProperty.call(CONSOLIDATE, slug)) return false;
    const c = cat.get(slug);
    if (c) {
      if (c.isCanonical === false) return false;
      if (L !== 'ar' && L !== 'en' && L !== 'fr') return false;
      return typeof indexable === 'function' ? !!indexable(c.cc ?? null, L) : true;
    }
    const m = man.get(slug);
    if (m) return L === 'ar' || (L === 'en' && !!((m.en && m.en.title) || m.bilingual));
    return false;
  };
}

// الكتالوج حتميّ (مولَّد من الشيفرة) فيُبنى مرّة واحدة لكل عملية/صفحة
let CATALOG_CACHE = null;
const catalogEntries = () => CATALOG_CACHE || (CATALOG_CACHE = buildCatalog());

/**
 * فحص الوجود الجاهز: الكتالوج الحالي + المقالات اليدوية الممرّرة (CMS ومستودع).
 * هو ما يستعمله الجميع (prerender وgen-sitemap وBlogPostPage وBlogIndexPage وgen-llms) فلا ينحرف أحدهم.
 * @param {Array<{slug: string, en?: {title?: string}, bilingual?: boolean}>} [manual]
 */
export const existsWith = (manual = []) => targetExistsFrom({ catalog: catalogEntries(), isIndexable, manual });

/**
 * slugs المقالات المدموجة بلغة L — لـgen-llms (تصحيح الناقد 14): لا يُروَّج في llms.txt رابط
 * canonical فيه يشير إلى غيره.
 * @param {string} L
 * @param {(slug: string, L: string) => boolean} [exists]
 * @returns {Set<string>}
 */
export function consolidatedFor(L, exists) {
  const out = new Set();
  for (const slug of Object.keys(CONSOLIDATE)) if (consolidatedTarget(slug, L, exists)) out.add(slug);
  return out;
}

/**
 * تقرير الدمج للسجل: ما طُبِّق وما تُجوهل ولماذا.
 * has(slug, L): هل المقال الرقيق نفسه موجود بتلك اللغة؟ (إدخال لمقال غائب لا يُعدّ خطأ)
 */
export function consolidationReport(exists, has) {
  const applied = [];
  const skipped = [];
  for (const e of consolidationEntries()) {
    if (typeof has === 'function' && !has(e.slug, e.lang)) { skipped.push({ ...e, why: 'المقال الرقيق غير موجود بهذه اللغة' }); continue; }
    if (typeof exists === 'function' && !exists(e.target, e.lang)) { skipped.push({ ...e, why: 'الهدف غير موجود أو غير قابل للفهرسة بهذه اللغة' }); continue; }
    applied.push(e);
  }
  return { applied, skipped };
}
