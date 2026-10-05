/**
 * الربط الداخلي وكتل المحتوى المشتركة بين التصيير المسبق (scripts/prerender.mjs) ومكوّنات React (P4 وP7).
 *
 * لماذا ملف واحد يقرؤه الطرفان: كل نصّ يُكتب مرّتين (سكربت التصيير ومكوّن الصفحة) ينحرف صامتاً،
 * والزاحف يقرأ الأول والزائر يرى الثاني. هنا ما يجب أن يتطابق فيهما:
 *   - عناقيد المقالات اليدوية وكتلة «اقرأ أيضاً» (prerender وBlogPostPage).
 *   - لاحقة عناوين المقالات (prerender وBlogPostPage).
 *   - روابط صفحات القطاعات (prerender الآن، وSectorPage حين يُوصل).
 *   - الأدوات المجانية بصيغها وأسئلتها (prerender وFreeToolsPage).
 *   - كتل «عن المنصة» (prerender وInfoPage)، وتطبيق المندوب (prerender وRepAppPage)، وأقسام الأسعار
 *     ووصفها (prerender وPricingPage).
 *
 * الملف نقيّ بلا fs ولا شبكة ولا أنماط بنظرة خلفية: يُحمَّل في المتصفح (Safari قبل 16.4 يرفض النظرة
 * الخلفية فيُسقط الحزمة كلها) وفي node وقت البناء.
 *
 * ⚠️ قواعد الصدق في كل نصّ هنا (scripts/claims-rules.mjs):
 *   - صيغة الربط الوحيدة «ندعم ربط المرحلة الثانية مع منصة فاتورة»، للسعودية وحدها، بلا «معتمد» ولا شراكة،
 *     وفي فقرة لا يقع ضمن 80 حرفاً قبلها أو 120 بعدها سنةٌ أو مهلة أو «N شركة/عميل/فاتورة».
 *     وعبارة «ربط المرحلة الثانية» نفسها لا توضع حيث يجاورها نصّ لا نملكه (نصّ مقال CMS أو عناوينه).
 *   - للشركات المفعّل لها الربط تحتاج الفواتير (القياسية والمبسطة) والمرتجعات اتصالاً لحظة الإصدار؛
 *     فكل وعد «دون اتصال» هنا مقيَّد بذلك.
 *   - لا سعر مكتوب يدوياً: كل سعر من باقات CMS الممرَّرة (plans)، ولا سعر سنوي. ولا «ر.س» ولا «ريال»
 *     ولا «SAR» بعد رقم ليس سعراً حيّاً (verify-pricing يحجبه).
 *   - لا اسم منافس، ولا رقم عملاء أو فواتير.
 */
import { buildCatalog } from './seo/catalog.mjs';
import { consolidatedTarget } from './consolidate.mjs';
import { FEATURES } from '../content/features.mjs';

/* ─── ١) عناقيد المقالات اليدوية وكتلة «اقرأ أيضاً» ─────────────────────────────
 *
 * قِيس (4 أكتوبر 2026): نحو 142 مقالاً عربياً يدوياً لا يصلها إلا رابط فهرس المدوّنة، لأن جسم المقال
 * المُصيَّر بلا روابط ذات صلة. لكل مقال يدوي الآن كتلة بعد </article>:
 *   - صفحة هبوط عنقوده بمرساة حرفية (الاستعلام الرابح نفسه)،
 *   - وصفحة ميزة مناسبة (للعربية وحدها: لا رابط من سياق إنجليزي إلى صفحات /مزايا/ العربية)،
 *   - ومقالان من العنقود نفسه: جاراه في ترتيب ثابت (الأحدث أولاً) كحلقة، فيصل كلَّ مقال رابطان
 *     من أخويه لا رابط الفهرس وحده.
 * المدموجة (consolidate.mjs) لا تُربط ولا تأخذ كتلة تُحسب في الحلقة، ومقالات الكتالوج لها روابطها.
 * وكل هدف لا يصله من هذه الكتل أكثر من RELATED_CAP رابطاً (المرساة الحرفية نفسها من مئة صفحة إفراط):
 * تُعطى الأحدث أولاً، والمقال الذي فاته رابط الهبوط يأخذ أخاً ثالثاً بدله.
 */

/** سقف الروابط الواصلة من كتل «اقرأ أيضاً» إلى الصفحة الواحدة. 30 لا 40: صفحات القطاعات والرئيسية
 * تربط بعض الأهداف نفسها (نظام إدارة المناديب من القطاعات السبعة)، فيبقى المجموع دون الأربعين. */
export const RELATED_CAP = 30;

/** مقالات لا تُروَّج من كتلنا: اسم منافس في الرابط والعنوان (قرار المالك ٢٩ يوليو ٢٠٢٦، بانتظار قراره فيه) */
const NO_LINK = new Set(['repzo-alternative-field-reps']);
/**
 * عنوان يموضعنا في «المرحلة الأولى» (مقالات CMS قبل تفعيل الربط، docs/owner-actions.md §٨) لا يُقترح أخاً:
 * الكتلة كانت ستنشر العنوان القديم في صفحات أخرى. يبقى المقال نفسه بكتلته ورابط الفهرس حتى يُحرَّر.
 */
const STALE_TITLE = /(?:ال|لل)?مرحل[ةه]\s*ال[أا]ول[ىي]|مرحل[ةه]\s*[أا]ول[ىي]|Phase[\s-]*(?:1|one)\b/i;

export const featureHref = (slug) => `/مزايا/${slug}/`;
export const PHASE2_FEATURE_HREF = featureHref('ربط-المرحلة-الثانية');
export const PHASE2_ANCHOR = 'ربط المرحلة الثانية مع منصة فاتورة';
export const COLLECTION_FEATURE_HREF = featureHref('تحصيل-المناديب');
export const REPS_LANDING = { href: '/blog/sales-reps-management-system/', anchor: 'نظام إدارة المناديب' };

/**
 * العناقيد: لكل لغة صفحة هبوط بمرساة حرفية، وللعربية صفحة ميزة.
 * - هدف عنقود التحصيل صفحة الكتالوج السعودية لا «دورة الطلب حتى التحصيل»: ذلك المقال في CMS ما زال
 *   ينفي الربط (تصحيح الناقد 13) — يُعاد النظر بعد تنظيف CMS (docs/owner-actions.md §٨).
 * - الإنجليزية إلى صفحات كتالوج سعودية قانونية قابلة للفهرسة، لا إلى مقالات إنجليزية يدوية تقول
 *   «Phase 2 not built» (van-sales-software-saudi وأخواتها) حتى تُصحَّح.
 */
export const CLUSTERS = {
  cashvan: {
    ar: {
      landing: { href: '/blog/cash-van-software-guide/', anchor: 'برنامج كاش فان' },
      feature: { href: featureHref('عهدة-سيارة-المندوب'), anchor: 'برنامج عهدة سيارة المندوب' },
    },
    en: { landing: { href: '/en/blog/van-sales-app-sa/', anchor: 'Van sales app for Saudi Arabia' } },
  },
  reps: {
    ar: {
      landing: REPS_LANDING,
      feature: { href: '/rep-app/', anchor: 'تطبيق مندوب المبيعات' },
    },
    en: { landing: { href: '/en/blog/sales-rep-management-sa/', anchor: 'Sales rep management in Saudi Arabia' } },
  },
  distributors: {
    ar: {
      landing: { href: '/blog/distributor-network-management-software/', anchor: 'برنامج إدارة الموزعين' },
      feature: { href: COLLECTION_FEATURE_HREF, anchor: 'برنامج تحصيل المناديب وسندات القبض' },
    },
    en: { landing: { href: '/en/blog/distribution-management-system-sa/', anchor: 'Distributor management system (DMS) for Saudi Arabia' } },
  },
  distribution: {
    ar: {
      landing: { href: '/blog/distribution-companies-management-system/', anchor: 'نظام إدارة شركات التوزيع' },
      feature: { href: featureHref('فوترة-بدون-إنترنت'), anchor: 'برنامج فواتير يعمل بدون إنترنت' },
    },
    en: { landing: { href: '/en/blog/distribution-management-system/', anchor: 'Distribution management system for Arab markets' } },
  },
  invoicing: {
    ar: {
      // لا «ربط المرحلة الثانية» حرفياً هنا: الكتلة تلي آخر سطر في مقال CMS، وكثير منها يُختم بـ«خلال دقائق»
      // أو بسنة، فتقع العبارة ضمن نافذة قاعدة zatca-phase2-dated (80 حرفاً قبلها) ويفشل البناء بنصّ لا نملكه
      // (حدث في zatca-einvoicing-distribution). المرساة تصف الصفحة نفسها بلا مصطلح المرحلة.
      landing: { href: PHASE2_FEATURE_HREF, anchor: 'الربط مع منصة فاتورة لفواتير المناديب' },
      feature: { href: featureHref('طباعة-فاتورة-من-الجوال'), anchor: 'برنامج فواتير بطباعة حرارية من الجوال' },
    },
    en: { landing: { href: '/en/blog/einvoicing-compliance-sa/', anchor: 'E-invoicing and tax compliance in Saudi Arabia' } },
  },
  collection: {
    ar: {
      landing: { href: '/blog/collection-receivables-sa/', anchor: 'تحصيل الذمم والمديونيات في السعودية' },
      feature: { href: COLLECTION_FEATURE_HREF, anchor: 'برنامج تحصيل المناديب وسندات القبض' },
    },
    en: { landing: { href: '/en/blog/collection-receivables-sa/', anchor: 'Collection and receivables in Saudi Arabia' } },
  },
  field: {
    ar: {
      landing: { href: '/blog/field-sales-system-for-companies/', anchor: 'نظام مبيعات ميدانية للشركات' },
      feature: { href: featureHref('إثبات-زيارة-المندوب'), anchor: 'برنامج إثبات زيارة المندوب' },
    },
    en: { landing: { href: '/en/blog/field-sales-software-sa/', anchor: 'Field sales management software for Saudi Arabia' } },
  },
};

/**
 * إسناد المقال إلى عنقود بكلمات في slug — أول قاعدة تطابق تفوز، وما لا يطابق يذهب إلى «مناديب».
 * «ميدان» قُسم من «مناديب» لأن الافتراضي وحده كان سيجمع خمسة وخمسين مقالاً على هدف واحد.
 */
const CLUSTER_RULES = [
  ['invoicing', /invoic|zatca|tax|print|eta-|qr|barcode/],
  ['collection', /collection|receivable|credit|dso|cheque|receipt|order-to-cash/],
  ['cashvan', /van|cash|custody|stock|loading|inventory|returns|damaged|expiry|presales/],
  ['distributors', /distributor|dms/],
  ['field', /visit|gps|geofenc|tracking|territor|merchandis|planogram|secondary|primary|coverage|route|last-mile|onboarding|competitor|field-sales-(?:system|software)|market-report|segmentation/],
  ['reps', /(?:^|-)reps?(?:-|$)|sales-rep|rep-|commission|incentive|target|training|turnover|routine|objection|upsell|kpi|fraud|manipulation|permission|force/],
  ['distribution', /distribution/],
];
export const clusterOf = (slug) => (CLUSTER_RULES.find(([, re]) => re.test(String(slug))) || ['reps'])[0];

/** أسماء القطاعات السبعة كما في src/content/sectors.ts (وscripts/sectors-data.mjs المولَّد منه) */
export const SECTOR_NAMES = {
  'مواد-غذائية': 'المواد الغذائية',
  'ألبان': 'الألبان والأجبان',
  'مياه-ومشروبات': 'المياه والمشروبات',
  'مخابز': 'المخابز والحلويات',
  'مستلزمات-طبية': 'المستلزمات الطبية',
  'مواد-بناء': 'مواد البناء',
  'قطع-غيار': 'قطع الغيار',
};
export const sectorHref = (slug) => `/قطاعات/${slug}/`;
/** مقال قطاع (ألبان، مخابز…) يأخذ صفحة قطاعه بدل ميزة عنقوده: أقرب إلى نيّة قارئه */
const SECTOR_RULES = [
  [/dairy/, 'ألبان'],
  [/bakery|snack|confection/, 'مخابز'],
  [/beverage|water/, 'مياه-ومشروبات'],
  [/perishable|cold-chain|food/, 'مواد-غذائية'],
  [/pharma|medical/, 'مستلزمات-طبية'],
  [/building/, 'مواد-بناء'],
  [/spare-parts|auto-parts/, 'قطع-غيار'],
];
const sectorOf = (slug) => (SECTOR_RULES.find(([re]) => re.test(String(slug))) || [])[1] || null;

const FEATURE_SLUGS = new Set(FEATURES.map((f) => f.slug));
const isFeaturePath = (href) => href.startsWith('/مزايا/');
/** هدف غير مقالي معروف: صفحة ميزة موجودة، أو قطاع، أو صفحة ثابتة */
function staticTargetOk(href) {
  if (isFeaturePath(href)) return FEATURE_SLUGS.has(href.replace(/^\/مزايا\//, '').replace(/\/$/, ''));
  if (href.startsWith('/قطاعات/')) return Object.prototype.hasOwnProperty.call(SECTOR_NAMES, href.replace(/^\/قطاعات\//, '').replace(/\/$/, ''));
  return href === '/rep-app/';
}
/** رابط مقال: موجود بلغته وغير مدموج (exists من consolidate.existsWith يغطي الكتالوج واليدوي) */
function blogTargetOk(href, exists) {
  const m = href.match(/^\/(?:(en|fr)\/)?blog\/([^/]+)\/$/);
  if (!m) return false;
  const L = m[1] || 'ar';
  return typeof exists === 'function' ? !!exists(m[2], L) : true;
}
const targetOk = (link, exists) => !!link && (link.href.includes('/blog/') ? blogTargetOk(link.href, exists) : staticTargetOk(link.href));

let CATALOG_SLUGS = null;
const catalogSlugs = () => CATALOG_SLUGS || (CATALOG_SLUGS = new Set(buildCatalog().map((x) => x.slug)));

export const postHref = (slug, L) => `${L === 'en' ? '/en' : ''}/blog/${slug}/`;
const titleIn = (p, L) => (L === 'en' ? (p.en && p.en.title) || '' : p.title || '');
const hasEn = (p) => !!(p && p.en && p.en.title);

/**
 * خطة الكتل للغة واحدة: slug ← [{href, anchor}].
 * posts: اتحاد المقالات اليدوية (effectivePosts) — تُستبعد منه مقالات الكتالوج والمدموجة وNO_LINK.
 * exists: consolidate.existsWith(posts) — لفحص الدمج ووجود هدف الهبوط بلغته.
 * الترتيب حتمي (التاريخ الأحدث ثم slug)، فالخطة نفسها في prerender وBlogPostPage.
 * @param {Array<{slug: string, date?: string, title?: string, en?: {title?: string}}>} posts
 * @param {(slug: string, L: string) => boolean} exists
 * @param {'ar'|'en'} L
 * @returns {Map<string, Array<{href: string, anchor: string}>>}
 */
export function relatedPlan(posts, exists, L) {
  const cat = catalogSlugs();
  const members = (Array.isArray(posts) ? posts : [])
    .filter((p) => p && p.slug && p.title && !cat.has(p.slug) && !NO_LINK.has(p.slug)
      && (L === 'ar' || hasEn(p)) && !consolidatedTarget(p.slug, L, exists))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.slug.localeCompare(b.slug));
  const groups = new Map();
  for (const p of members) {
    const c = clusterOf(p.slug);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(p);
  }
  const used = new Map();
  const take = (link) => {
    const n = used.get(link.href) || 0;
    if (n >= RELATED_CAP) return null;
    used.set(link.href, n + 1);
    return link;
  };
  const out = new Map();
  for (const p of members) {
    const cid = clusterOf(p.slug);
    const def = (CLUSTERS[cid] && CLUSTERS[cid][L]) || {};
    const self = postHref(p.slug, L);
    const links = [];
    const landing = def.landing && def.landing.href !== self && targetOk(def.landing, exists) ? take(def.landing) : null;
    if (landing) links.push(landing);
    if (L === 'ar') {
      const sec = sectorOf(p.slug);
      const feat = sec ? { href: sectorHref(sec), anchor: `إدارة مناديب شركات ${SECTOR_NAMES[sec]}` } : def.feature;
      if (feat && feat.href !== self && targetOk(feat, exists)) {
        const f = take(feat);
        if (f) links.push(f);
      }
    }
    const want = landing ? 2 : 3;
    const taken = new Set(links.map((l) => l.href).concat(self));
    const sib = [];
    const push = (q) => {
      if (!q || q === p || sib.includes(q) || taken.has(postHref(q.slug, L)) || STALE_TITLE.test(titleIn(q, L))) return;
      sib.push(q);
    };
    const g = groups.get(cid);
    const i = g.indexOf(p);
    const n = g.length;
    // جارا المقال في عنقوده كحلقة (الأحدث منه والأقدم)، ثم الأبعد إن نقص، ثم من القائمة كلها إن صغر العنقود
    for (let k = 1; sib.length < want && k < n; k++) {
      push(g[(i - k + n) % n]);
      if (sib.length < want) push(g[(i + k) % n]);
    }
    const gi = members.indexOf(p);
    for (let k = 1; sib.length < want && k < members.length; k++) push(members[(gi + k) % members.length]);
    for (const q of sib.slice(0, want)) links.push({ href: postHref(q.slug, L), anchor: titleIn(q, L) });
    out.set(p.slug, links);
  }
  return out;
}

/** كتلة مقال واحد — [] إن لم يكن له كتلة (مدموج أو كتالوج أو غائب) */
export function relatedFor(slug, L, posts, exists) {
  return relatedPlan(posts, exists, L === 'en' ? 'en' : 'ar').get(slug) || [];
}

export const RELATED_TITLE = { ar: 'اقرأ أيضاً', en: 'Related reading' };

/* ─── ٢) لاحقة عناوين المقالات ─────────────────────────────────────────────────
 * «| مدوّنة FieldSales» كانت تضيف 19 حرفاً لكل مقال، و214 عنواناً تجاوزت 70 حرفاً فقصّها جوجل من
 * آخرها. اللاحقة الآن «| FieldSales»، وتُسقط كلها إن جاوز العنوان بها 70 حرفاً: عنوان المقال نفسه
 * لا يتغيّر، والعلامة في نتائج البحث يضيفها جوجل من اسم الموقع على أي حال.
 */
export const TITLE_MAX = 70;
export const blogTitle = (title) => {
  const t = String(title == null ? '' : title).trim();
  const withBrand = `${t} | FieldSales`;
  return withBrand.length <= TITLE_MAX ? withBrand : t;
};

/* ─── ٣) روابط صفحات القطاعات ──────────────────────────────────────────────────
 * لكل قطاع: ميزتان تخدمان ألمه اليومي، و«نظام إدارة المناديب»، وقطاعان قريبان.
 * مواد البناء تبيع لمنشآت تطلب فاتورة ضريبية قياسية، فميزتها الثانية ربط المرحلة الثانية.
 */
export const SECTOR_RELATED = {
  'مواد-غذائية': { features: ['عهدة-سيارة-المندوب', 'فوترة-بدون-إنترنت'], near: ['ألبان', 'مياه-ومشروبات'] },
  'ألبان': { features: ['عهدة-سيارة-المندوب', 'طباعة-فاتورة-من-الجوال'], near: ['مواد-غذائية', 'مخابز'] },
  'مياه-ومشروبات': { features: ['عهدة-سيارة-المندوب', 'تحصيل-المناديب'], near: ['مواد-غذائية', 'ألبان'] },
  'مخابز': { features: ['عهدة-سيارة-المندوب', 'طباعة-فاتورة-من-الجوال'], near: ['ألبان', 'مواد-غذائية'] },
  'مستلزمات-طبية': { features: ['إثبات-زيارة-المندوب', 'تحصيل-المناديب'], near: ['قطع-غيار', 'مواد-بناء'] },
  'مواد-بناء': { features: ['تحصيل-المناديب', 'ربط-المرحلة-الثانية'], near: ['قطع-غيار', 'مستلزمات-طبية'] },
  'قطع-غيار': { features: ['عهدة-سيارة-المندوب', 'تحصيل-المناديب'], near: ['مواد-بناء', 'مستلزمات-طبية'] },
};
/** روابط القطاع جاهزة: [{href, anchor}] بلا ميزة غائبة */
export function sectorRelatedLinks(slug) {
  const r = SECTOR_RELATED[slug];
  if (!r) return [];
  const feats = r.features
    .map((s) => FEATURES.find((f) => f.slug === s))
    .filter(Boolean)
    .map((f) => ({ href: featureHref(f.slug), anchor: f.name }));
  const near = r.near.filter((s) => SECTOR_NAMES[s]).map((s) => ({ href: sectorHref(s), anchor: SECTOR_NAMES[s] }));
  return [...feats, REPS_LANDING, ...near];
}

/* ─── ٤) التسعير: سطر الأسعار ووصف الصفحة وأقسامها ────────────────────────────── */

const toLatinDigits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
/** حدّ المناديب من نصّ حدّ الباقة — نظير repsCap في scripts/pricing-source.mjs وPricingPage */
export const capOf = (limit) => {
  const m = toLatinDigits(limit).match(/\d+/);
  return m ? Number(m[0]) : null;
};
/** الباقات الرقمية مرتّبة بالسعر: [{price, cap, name, features}] */
export function planTiers(plans) {
  return (Array.isArray(plans) ? plans : [])
    .filter((p) => p && /^\d+$/.test(String(p.price == null ? '' : p.price).trim()))
    .map((p) => ({ price: String(p.price).trim(), cap: capOf(p.limit), name: p.name || '', features: Array.isArray(p.features) ? p.features.filter(Boolean) : [] }))
    .sort((a, b) => Number(a.price) - Number(b.price));
}
/** «مناديب» للأعداد من ٣ إلى ١٠، و«مندوباً» لما فوقها */
const repsWordAr = (n) => (n >= 3 && n <= 10 ? 'مناديب' : 'مندوباً');
const joinAr = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(' و')} و${xs[xs.length - 1]}`);
const joinWith = (xs, and) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);

/** سطر الأسعار الإنجليزي: «299 SAR a month for up to 5 reps, … (VAT included)» */
export function enPriceLine(plans) {
  const t = planTiers(plans).filter((p) => p.cap);
  if (!t.length) return '';
  const parts = t.map((p, i) => (i === 0 ? `${p.price} SAR a month for up to ${p.cap} reps` : `${p.price} SAR for up to ${p.cap} reps`));
  return `${joinWith(parts, 'and')} (VAT included)`;
}
export function frPriceLine(plans) {
  const t = planTiers(plans).filter((p) => p.cap);
  if (!t.length) return '';
  const parts = t.map((p, i) => (i === 0 ? `${p.price} SAR par mois jusqu’à ${p.cap} commerciaux` : `${p.price} SAR jusqu’à ${p.cap} commerciaux`));
  return `${joinWith(parts, 'et')} (TVA incluse)`;
}

/** عنوان صفحة الأسعار بلغتها — مصدر واحد لـprerender وPricingPage (كانا يختلفان بعلامة استفهام وشَرطة) */
export const pricingTitle = (lang) => ({
  en: 'Field Sales pricing — published, no hidden fees',
  fr: 'Tarifs Field Sales — publiés, sans frais cachés',
}[lang] || 'كم سعر برنامج مندوبين المبيعات؟ | Field Sales');

/**
 * وصف صفحة الأسعار (150 حرفاً أو أقل) بأرقام CMS كلها — مصدر واحد لـprerender وPricingPage.
 * كان 234 حرفاً يقصّه جوجل قبل الأرقام.
 */
export function pricingDescription(lang, plans) {
  const t = planTiers(plans);
  const prices = t.map((p) => p.price);
  const caps = t.map((p) => p.cap).filter(Boolean);
  if (!prices.length) {
    return { ar: 'أسعار Field Sales معلنة لكل شركة لا لكل مستخدم، بلا رسوم تأسيس، وتجربة ١٠ أيام بلا بطاقة.', en: 'Field Sales pricing is published, per company not per user. No setup fees, 10-day free trial without a card.', fr: 'Tarifs Field Sales publiés, par entreprise et non par utilisateur. Sans frais de mise en service, essai de 10 jours.' }[lang] || '';
  }
  if (lang === 'en') return `Field Sales pricing: ${joinWith(prices, 'and')} SAR a month per company for up to ${joinWith(caps.map(String), 'and')} reps, VAT included. 10-day free trial.`;
  if (lang === 'fr') return `Tarifs Field Sales : ${joinWith(prices, 'et')} SAR par mois et par entreprise, jusqu’à ${joinWith(caps.map(String), 'et')} commerciaux, TVA incluse. Essai de 10 jours.`;
  return `أسعار Field Sales: ${joinAr(prices)} ر.س شهرياً لكل شركة حتى ${joinAr(caps.map(String))} مناديب، شاملة الضريبة، وتجربة ١٠ أيام بلا بطاقة.`;
}

/**
 * أقسام صفحة الأسعار: كم تدفع الشركة شهرياً بحسب عدد مناديبها، ولماذا السعر لكل شركة، وما المشمول.
 * شهري فقط (تصحيح الناقد 4): لا سعر سنوي في CMS، فلا رقم سنوي هنا.
 * «ما المشمول» من مزايا الباقات في CMS نفسها، بلا ذكر أن الربط مشمول (قرار المالك معلّق).
 * كل بند سعري ينتهي بنقطة: verify-pricing يقرن عدد المناديب بأقرب سعر في الجملة نفسها.
 * @returns {Array<{h2: string, paras?: string[], items?: string[]}>}
 */
export function pricingSections(lang, plans) {
  const t = planTiers(plans);
  const priced = t.filter((p) => p.cap);
  const withFeatures = t.filter((p) => p.features.length);
  const out = [];
  if (lang === 'en' || lang === 'fr') {
    const en = lang === 'en';
    const nameOf = (p) => ({ 299: en ? 'Starter' : 'Débutant', 399: en ? 'Growth' : 'Croissance', 599: en ? 'Professional' : 'Professionnel' })[p.price] || p.name;
    if (priced.length) {
      out.push({
        h2: en ? 'What a company pays per month, by number of reps' : 'Ce que paie une entreprise par mois selon le nombre de commerciaux',
        items: priced.map((p) => (en
          ? `A company with up to ${p.cap} reps pays ${p.price} SAR a month for the whole team (${nameOf(p)} plan).`
          : `Une entreprise jusqu’à ${p.cap} commerciaux paie ${p.price} SAR par mois pour toute l’équipe (offre ${nameOf(p)}).`)),
        paras: [en ? 'Prices include VAT. Monthly subscription, no setup fees.' : 'Prix TVA incluse. Abonnement mensuel, sans frais de mise en service.'],
      });
    }
    out.push({
      h2: en ? 'Per company, not per user' : 'Par entreprise, pas par utilisateur',
      paras: [en
        ? 'One subscription covers the company’s reps and admin accounts within the plan limit. Adding a rep does not change your bill while you stay within your plan; once you pass its limit you move to the next plan. Per-user pricing, by contrast, grows with every rep you add.'
        : 'Un seul abonnement couvre les commerciaux et les comptes administrateurs de l’entreprise dans la limite de l’offre. Ajouter un commercial ne change pas la facture tant que vous restez dans la limite ; au-delà, vous passez à l’offre suivante. La tarification par utilisateur augmente au contraire à chaque commercial ajouté.'],
    });
    return out;
  }
  if (priced.length) {
    out.push({
      h2: 'كم تدفع شركتك شهرياً بحسب عدد مناديبها؟',
      items: priced.map((p) => `شركة حتى ${p.cap} ${repsWordAr(p.cap)}: ${p.price} ر.س شهرياً للفريق كله${p.name ? ` (${p.name})` : ''}.`),
      paras: ['الأسعار شاملة ضريبة القيمة المضافة، والاشتراك شهري بلا رسوم تأسيس.'],
    });
  }
  out.push({
    h2: 'لكل شركة لا لكل مستخدم',
    paras: ['تدفع الشركة اشتراكاً واحداً يشمل مناديبها وحسابات إدارتها ضمن حدّ الباقة. إضافة مندوب لا تغيّر فاتورتك ما دام العدد ضمن حدّ باقتك، وحين يتجاوزه تنتقل إلى الباقة التالية. أما التسعير لكل مستخدم فيرتفع مع كل مندوب تضيفه.'],
  });
  if (withFeatures.length) {
    out.push({
      h2: 'ما المشمول في كل باقة',
      items: withFeatures.map((p) => `${p.name}: ${p.features.join('، ')}.`),
    });
  }
  return out;
}

/** رابط صفحة الربط بلغة صفحة الأسعار: العربية إلى صفحة الميزة، وغيرها إلى صفحة الكتالوج السعودية بلغتها */
export const phase2LinkFor = (lang) => (lang === 'en'
  ? { href: '/en/blog/einvoicing-compliance-sa/', label: 'How Phase 2 integration works in Saudi Arabia' }
  : lang === 'fr'
    ? { href: '/fr/blog/einvoicing-compliance-sa/', label: 'Facturation électronique en Arabie saoudite' }
    : { href: PHASE2_FEATURE_HREF, label: 'كيف يعمل ربط المرحلة الثانية وما حدوده' });

/* ─── ٥) الأدوات المجانية ─────────────────────────────────────────────────────
 * المصدر الواحد لـprerender وFreeToolsPage (كانت القائمة مكتوبة في الموضعين بنصّين مختلفين).
 * الصيغ مطابقة لمحرّكات src/free/engines.ts حرفياً — صاحب الشركة يبني قراراً على الرقم.
 * ولا «ر.س» بعد رقم مثالٍ في الأسئلة: verify-pricing يعدّه سعراً غريباً.
 */
export const FREE_TOOLS = [
  {
    id: 'commission',
    title: 'حاسبة عمولة المبيعات للمناديب',
    desc: 'شرائح عمولة بأرضية وسقف وخصم المرتجعات لمناديب التوزيع، بدل جداول Excel الهشّة.',
    feat: ['/blog/distribution-reps-commissions/', 'دليل عمولات مناديب التوزيع: النماذج والنِّسَب'],
    formula: 'العمولة = المبيعات الصافية بعد المرتجعات × النسبة. وفي الشرائح المتدرّجة تُحسب كل نسبة على الجزء الواقع في شريحتها فقط، ثم تُطبَّق الأرضية والسقف إن وُجدا.',
    use: 'لمدير المبيعات الذي يصرف عمولة شهرية بنظام شرائح: جرّب أثر رفع نسبة الشريحة العليا أو إضافة سقف قبل أن تعلنه للمناديب، وانظر تفصيل كل شريحة في جدول النتيجة.',
    limits: 'تحسب الأداة العمولة على المبيعات الصافية وحدها: لا تحسبها على التحصيل، ولا تعطي كل صنف نسبة مختلفة. إن كانت سياستك كذلك فاحسب كل جزء منها على حدة ثم اجمع.',
    faq: [
      { q: 'هل تُحسب العمولة قبل المرتجعات أم بعدها؟', a: 'بعدها. تخصم الأداة المرتجعات من المبيعات أولاً، فلا يأخذ المندوب عمولة على بضاعة عادت إليك، ولا ينزل الأساس تحت الصفر مهما كبرت المرتجعات.' },
      { q: 'كيف تُحسب العمولة المتدرّجة؟', a: 'كل نسبة على الجزء الواقع في شريحتها فقط. مبيعات صافية قدرها 120 ألفاً بشرائح 1% حتى 50 ألفاً و2% حتى 100 ألف و3% فوقها تعطي 500 + 1000 + 600 = 2100. أما النسبة الواحدة على الإجمالي فتقفز بالعمولة كلها عند حدّ الشريحة.' },
      { q: 'ما فائدة الأرضية والسقف؟', a: 'الأرضية حدّ أدنى يُصرف للمندوب مهما قلّت مبيعاته، والسقف حدّ أعلى لا تتجاوزه العمولة. اتركهما صفراً إن لم تعتمدهما، وتُظهر الأداة العمولة المحسوبة قبل التعديل إن غيّرها أحدهما.' },
    ],
  },
  {
    id: 'van',
    title: 'تسوية عهدة سيارة المندوب',
    desc: 'طابق حمولة السيارة آخر اليوم واكشف العجز بالصنف وقيمته.',
    feat: ['/blog/rep-van-custody-management/', 'نظام عهدة بضاعة سيارة المندوب: الدورة كاملة'],
    formula: 'المتوقع في السيارة = رصيد أول اليوم + المحمّل − المباع + المرتجع − التالف. والفرق = الجرد الفعلي − المتوقع: السالب عجز، والموجب زيادة.',
    use: 'لمشرف المستودع آخر اليوم: أدخل لكل صنف ما حُمِّل وما بيع وما رجع وما تلف ثم العدّ الفعلي، فيظهر الصنف الذي فيه العجز يوم حدوثه لا آخر الشهر.',
    limits: 'لا تقرأ الأداة فواتيرك ولا حركات التحميل، فكل رقم فيها تُدخله بيدك، ولا تحفظ تسوية الأمس لتقارنها باليوم. هي مطابقة ليوم واحد لسيارة واحدة.',
    faq: [
      { q: 'لماذا يُضاف المرتجع ويُطرح التالف؟', a: 'المرتجع الصالح عاد إلى السيارة فيُضاف إلى المتوقع، والتالف خرج من البضاعة القابلة للبيع فيُطرح منه. خلطهما في رقم واحد يُخفي العجز الحقيقي.' },
      { q: 'هل تحفظ الأداة بياناتي؟', a: 'لا. الحساب يجري في متصفحك ولا يُرسل أي رقم إلى خوادمنا، وتختفي الأرقام حين تغلق الصفحة.' },
      { q: 'ما الفرق بين هذه التسوية وعهدة السيارة في Field Sales؟', a: 'الأداة تسوّي يوماً واحداً بأرقام تُدخلها بيدك. في Field Sales يُحسب المتبقي لكل صنف في كل سيارة لحظياً من فواتير المندوب وحركات التحميل والتنزيل، ويبقى الجرد الفعلي عندك لتقارنه بالمحسوب.' },
    ],
  },
  {
    id: 'reps',
    title: 'حاسبة عدد مناديب المبيعات',
    desc: 'كم مندوباً تحتاج؟ حجّم فريقك الميداني قبل التوظيف أو الشراء، بحساسية ±٢٠٪.',
    feat: ['/blog/sales-reps-management-system/', 'نظام إدارة المناديب: الصلاحيات والمتابعة والفوترة'],
    formula: 'عدد المناديب = (عدد المنافذ × زيارات العميل شهرياً) ÷ (زيارات المندوب يومياً × أيام العمل شهرياً)، مقرّباً لأعلى.',
    use: 'قبل التوظيف أو قبل الاشتراك في نظام لعدد معيّن من المناديب: حجّم الفريق من عدد عملائك وتكرار زيارتهم بدل التقدير، وانظر النطاق بين الإنتاجية العالية والمنخفضة.',
    limits: 'تفترض الأداة إنتاجية يومية واحدة لكل المناديب، فلا تحسب المسافات بين المنافذ ولا وقت الانتظار عند العميل ولا الإجازات. لذلك تعرض نطاقاً لا رقماً واحداً.',
    faq: [
      { q: 'لماذا تعرض الأداة نطاقاً لا رقماً واحداً؟', a: 'لأن إنتاجية المندوب تتغيّر بالزحام والمسافات. تحسب الأداة العدد مرة بإنتاجية أعلى بـ٢٠٪ ومرة بأقل بـ٢٠٪، فترى أفضل الحالات وأسوأها.' },
      { q: 'كم زيارة يُنجز المندوب يومياً؟', a: 'يختلف بكثافة المنطقة ونوع البيع: البيع من السيارة في حي مزدحم غير زيارة بيع مسبق لعميل جملة. القيم الظاهرة في الأداة أمثلة تعدّلها، فأدخل متوسط فريقك الفعلي من سجلّ الزيارات.' },
      { q: 'مثال: كم مندوباً أحتاج لثلاثمئة منفذ؟', a: 'ثلاثمئة منفذ يُزار كلٌّ منها 4 مرات شهرياً تحتاج 1200 زيارة. ومندوب يُنجز 22 زيارة يومياً في 24 يوم عمل يغطي 528 زيارة. فالحاجة 1200 ÷ 528 = 2.27، أي ثلاثة مناديب بعد التقريب لأعلى.' },
    ],
  },
  {
    id: 'aging',
    title: 'حاسبة أعمار الديون وحدود الائتمان',
    desc: 'وزّع ذممك على شرائح ٣٠/٦٠/٩٠ يوماً واقترح حدّ ائتمان لكل عميل.',
    feat: ['/blog/field-collection-overdue-receivables/', 'تحصيل الذمم المتعثرة عبر المناديب: 7 خطوات'],
    formula: 'تُوزَّع الفواتير المستحقة على شرائح: غير مستحقة، ومن يوم إلى 30 يوماً، ومن 31 إلى 60، ومن 61 إلى 90، وأكثر من 90 يوماً. وحدّ الائتمان المقترح = متوسط مبيعات العميل الشهرية × مدة السداد بالأيام ÷ 30.',
    use: 'للمحاسب أو مسؤول التحصيل: يرى أين تتركّز المديونية المتأخرة قبل أن تصير ديناً معدوماً، ويضع لكل عميل حدّاً يتّسق مع مشترياته ومدة سداده.',
    limits: 'تحسب الأداة الشرائح من أيام التأخير التي تُدخلها لا من تواريخ فواتيرك، والحدّ المقترح لا يعرف تاريخ سداد العميل معك ولا ضماناته، فعدّله بحكمك.',
    faq: [
      { q: 'لماذا شرائح 30 و60 و90 يوماً؟', a: 'لأن احتمال التحصيل يقلّ كلما طال التأخير، فالشرائح تفصل المتأخر حديثاً عن المتعثّر. وما تجاوز 90 يوماً يحتاج متابعة خاصة لا زيارة روتينية.' },
      { q: 'كيف يُحسب حدّ الائتمان المقترح؟', a: 'متوسط مبيعات العميل الشهرية × مدة السداد ÷ 30. عميل يشتري بثلاثين ألفاً شهرياً بمدة سداد 30 يوماً يُقترح له حدّ بثلاثين ألفاً. هو نقطة بداية تعدّلها بحسب تاريخ العميل معك.' },
      { q: 'هل في Field Sales تقرير أعمار ديون؟', a: 'ليس بعد بشرائح زمنية. يرى المندوب رصيد العميل وحدّه وفترة سداده وفواتيره المفتوحة بتواريخها، وتعرض التقارير الأرصدة ومن تجاوز حدّه، ولحساب الشرائح هذه الأداة.' },
    ],
  },
];
export const FREE_INDEX = {
  title: 'أدوات مجانية لشركات التوزيع | Field Sales',
  description: 'أدوات حساب مجانية: عمولة المندوب المتدرّجة، تسوية عهدة السيارة، تحجيم الفريق الميداني، أعمار الدين وحدّ الائتمان — بلا تسجيل.',
  h1: 'أدوات مجانية لشركات التوزيع',
  intro: 'تعمل في متصفّحك بالكامل: لا تسجيل، ولا يُرسل أي رقم تُدخله إلى خوادمنا.',
};
export const freeToolMeta = (t) => ({
  title: `${t.title} — أداة مجانية | Field Sales`,
  description: `${t.desc} تعمل في متصفّحك بلا تسجيل ولا إرسال بيانات.`,
});
/** بيانات الأداة المنظّمة: البرنامج المجاني وأسئلته الظاهرة في الصفحة */
export const freeToolJsonLd = (t, canonical) => ({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication', name: t.title, description: t.desc,
      applicationCategory: 'BusinessApplication', operatingSystem: 'Web',
      inLanguage: 'ar', url: canonical, isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'SAR' },
    },
    { '@type': 'FAQPage', mainEntity: t.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
  ],
});

/* ─── ٦) عن المنصة ──────────────────────────────────────────────────────────────
 * الحقائق من كيان Organization في index.html (المدينة وسنة التأسيس والمؤسس وsameAs)، والأسعار من CMS.
 * لا اسم كيان قانوني ولا رقم سجل ولا رقم ضريبي هنا حتى يؤكّدها المالك.
 * سنة التأسيس في أول الصفحة وجملة الربط في قسم بعيد عنها (تصحيح الناقد 8).
 */
export const OFFICIAL_LINKS = [
  { href: 'https://x.com/fieldsa_net', label: 'X' },
  { href: 'https://www.linkedin.com/company/fieldsa/', label: 'LinkedIn' },
  { href: 'https://www.facebook.com/profile.php?id=61591189934757', label: 'Facebook' },
  { href: 'https://www.g2.com/products/fieldsales/reviews', label: 'G2' },
  { href: 'https://www.saashub.com/fieldsales', label: 'SaaSHub' },
  { href: 'https://play.google.com/store/apps/details?id=net.fieldsa.twa', label: 'Google Play' },
  { href: 'https://apps.apple.com/sa/app/id6797991968', label: 'App Store' },
];

/**
 * @param {'ar'|'en'|'fr'|string} lang
 * @param {{ priceLine?: string }} [opts] سطر الأسعار بلغة الصفحة من CMS (arSummary أو enPriceLine…)
 * @returns {null | { title: string, description: string, sections: Array<{h2: string, paras?: string[], items?: string[], links?: Array<{href: string, label: string}>}> }}
 */
export function aboutContent(lang, { priceLine = '' } = {}) {
  if (lang === 'ar') {
    return {
      title: 'عن فيلد سيلز – نظام إدارة المناديب | FieldSales',
      description: 'فيلد سيلز منصة سعودية من الرياض لإدارة مناديب التوزيع: فواتير وتحصيل وعهدة سيارة وزيارات موثّقة، بأسعار معلنة لكل شركة في الدول العربية.',
      sections: [
        { h2: 'فيلد سيلز في سطور', items: ['المقر: الرياض، المملكة العربية السعودية.', 'سنة التأسيس: 2026.', 'المؤسس: Ali Aloraini.', 'البريد: info@fieldsa.net'] },
        {
          h2: 'ماذا تفعل المنصة',
          paras: [
            'يُصدر المندوب من جواله الفاتورة وسند القبض برمز QR ويطبعهما على طابعة حرارية أمام العميل، ويرى عهدة سيارته، ويسجّل زيارته بموقعها وصورها. وترى الإدارة على لوحة واحدة المبيعات والتحصيل وذمم العملاء وحدود ائتمانهم، ومخزون كل سيارة، وخط سير كل مندوب.',
            'ونكتب عن السوق كما نراه: تقرير سوق برامج إدارة المناديب يجمع ما وجدناه في مسح موردي هذه البرامج وأسعارهم المعلنة.',
          ],
          links: [{ href: '/مزايا/', label: 'كيف تعمل المزايا وما حدودها' }, { href: '/blog/field-sales-software-market-report-2026/', label: 'تقرير سوق برامج إدارة المناديب' }],
        },
        {
          h2: 'التسعير',
          paras: [priceLine
            ? `الاشتراك شهري لكل شركة لا لكل مستخدم: ${priceLine}. وتجربة مجانية عشرة أيام بلا بطاقة ائتمان.`
            : 'الاشتراك شهري لكل شركة لا لكل مستخدم، والأسعار معلنة. وتجربة مجانية عشرة أيام بلا بطاقة ائتمان.'],
          links: [{ href: '/pricing/', label: 'تفاصيل الأسعار' }],
        },
        {
          h2: 'اللغات والأسواق',
          paras: ['الواجهة عربية أصلاً ومعها الإنجليزية والفرنسية، وللموقع صفحات تعريفية بالتركية والصينية. نخدم شركات التوزيع في الدول العربية، والمبالغ تتبع عملة الشركة وخاناتها.'],
        },
        {
          h2: 'الفوترة الإلكترونية في السعودية',
          paras: ['ندعم ربط المرحلة الثانية مع منصة فاتورة.', 'يُفتح الربط لكل شركة سعودية بطلبها، ويُجري مدير الشركة خطواته بنفسه من إعداداتها.'],
          links: [{ href: PHASE2_FEATURE_HREF, label: 'كيف يعمل الربط وما حدوده' }],
        },
        {
          h2: 'ما لا ندّعيه',
          items: [
            'هيئة الزكاة والضريبة والجمارك لا تعتمد ولا تصادق مزوّدي البرمجيات، فلا ندّعي اعتماداً منها ولا شراكة رسمية معها.',
            'للشركات المفعّل لها الربط تحتاج الفواتير (القياسية والمبسطة) والمرتجعات اتصالاً لحظة الإصدار، ويبقى سند القبض وتسجيل الزيارة متاحين دون اتصال.',
            'ليست لدينا شهادات SOC2 أو ISO.',
          ],
        },
        { h2: 'حساباتنا الرسمية', links: OFFICIAL_LINKS },
      ],
    };
  }
  if (lang === 'en') {
    return {
      title: 'About FieldSales – Sales Rep Management System',
      description: 'Riyadh-based FieldSales manages distribution sales reps: invoices, collection, van stock and verified visits, with published per-company pricing.',
      sections: [
        { h2: 'FieldSales at a glance', items: ['Head office: Riyadh, Saudi Arabia.', 'Founded: 2026.', 'Founder: Ali Aloraini.', 'Email: info@fieldsa.net'] },
        {
          h2: 'What the platform does',
          paras: ['Reps issue invoices and receipts with a QR code from their phones and print them on a thermal printer in front of the customer, see their van stock, and log each visit with its location and photos. Managers see sales, collections, customer balances and credit limits, every van’s stock and every rep’s route on one dashboard.'],
          links: [{ href: '/en/blog/', label: 'FieldSales blog' }],
        },
        {
          h2: 'Pricing',
          paras: [priceLine
            ? `Priced per company, not per user: ${priceLine}. A 10-day free trial needs no credit card.`
            : 'Priced per company, not per user, with published prices. A 10-day free trial needs no credit card.'],
          links: [{ href: '/en/pricing/', label: 'Pricing details' }],
        },
        {
          h2: 'Languages and markets',
          paras: ['Arabic-first interface with English and French, plus introductory pages in Turkish and Chinese. We serve distribution companies across the Arab world, and amounts follow each company’s currency and decimals.'],
        },
        {
          h2: 'E-invoicing in Saudi Arabia',
          paras: ['FieldSales supports Phase 2 integration with ZATCA’s Fatoora platform.', 'The integration is opened for each Saudi company on request, and the company admin completes the steps from its own settings.'],
          links: [{ href: '/en/blog/einvoicing-compliance-sa/', label: 'E-invoicing and tax compliance in Saudi Arabia' }],
        },
        {
          h2: 'What we do not claim',
          items: [
            'ZATCA does not certify or approve software vendors, so we claim no certification and no official partnership.',
            'For companies with the integration enabled, invoices (standard and simplified) and returns need a connection at the moment of issuance; receipts and visit logging still work offline.',
            'We hold no SOC2 or ISO certification.',
          ],
        },
        { h2: 'Official accounts', links: OFFICIAL_LINKS },
      ],
    };
  }
  if (lang === 'fr') {
    return {
      title: 'À propos de FieldSales – gestion des commerciaux terrain',
      description: 'FieldSales, plateforme basée à Riyad pour gérer les commerciaux de distribution : factures, encaissement, stock du véhicule et visites vérifiées.',
      sections: [
        { h2: 'FieldSales en bref', items: ['Siège : Riyad, Arabie saoudite.', 'Fondée en 2026.', 'Fondateur : Ali Aloraini.', 'E-mail : info@fieldsa.net'] },
        {
          h2: 'Ce que fait la plateforme',
          paras: ['Les commerciaux émettent depuis leur téléphone factures et reçus à code QR, les impriment sur une imprimante thermique devant le client, suivent le stock de leur véhicule et enregistrent chaque visite avec sa position et ses photos. Les gérants voient sur un seul tableau de bord les ventes, l’encaissement, les soldes clients, le stock de chaque véhicule et la tournée de chaque commercial.'],
        },
        {
          h2: 'Tarifs',
          paras: [priceLine
            ? `Abonnement par entreprise et non par utilisateur : ${priceLine}. Essai gratuit de 10 jours sans carte bancaire.`
            : 'Abonnement par entreprise et non par utilisateur, prix publiés. Essai gratuit de 10 jours sans carte bancaire.'],
          links: [{ href: '/fr/pricing/', label: 'Détail des tarifs' }],
        },
        {
          h2: 'Langues et marchés',
          paras: ['Interface d’abord en arabe, avec l’anglais et le français, et des pages de présentation en turc et en chinois. Nous servons les entreprises de distribution du monde arabe ; les montants suivent la devise de chaque entreprise.'],
        },
        {
          h2: 'Facturation électronique en Arabie saoudite',
          paras: ['Nous prenons en charge l’intégration phase 2 avec la plateforme Fatoora de la ZATCA.', 'L’intégration est ouverte pour chaque entreprise saoudienne sur demande, et son administrateur en mène les étapes dans ses paramètres.'],
        },
        {
          h2: 'Ce que nous ne revendiquons pas',
          items: [
            'La ZATCA ne certifie aucun éditeur de logiciels : nous ne revendiquons ni homologation ni partenariat officiel.',
            'Pour les entreprises où l’intégration est activée, les factures (standard et simplifiées) et les retours exigent une connexion au moment de l’émission ; les reçus et les visites restent possibles hors ligne.',
          ],
        },
        { h2: 'Comptes officiels', links: OFFICIAL_LINKS },
      ],
    };
  }
  return null;
}

/* ─── ٧) تطبيق المندوب ─────────────────────────────────────────────────────────
 * الأقسام تُستمدّ من features.mjs (كيف تعمل كل ميزة، مكتوبة من الكود) لا من نصّ تسويقي ثالث.
 * وصف «يعمل بلا إنترنت» القديم («البيع والتحصيل يستمران في المناطق المقطوعة») صار مقيَّداً:
 * RepApp.tsx يمنع الفاتورة (القياسية والمبسطة) والمرتجع دون اتصال للشركات المفعّل لها الربط.
 */
export const REP_APP_STORES = {
  play: 'https://play.google.com/store/apps/details?id=net.fieldsa.twa',
  apple: 'https://apps.apple.com/sa/app/id6797991968',
};
export const REP_APP = {
  title: 'تطبيق مندوب مبيعات: فواتير وتحصيل ومخزون سيارة | Field Sales',
  description: 'تطبيق المندوب من Field Sales: فاتورة برمز QR وسند قبض وطباعة حرارية وعهدة السيارة وزيارات موثّقة بالموقع، والتحصيل والزيارات تعمل بلا إنترنت.',
  h1: 'تطبيق مندوب مبيعات: فواتير وتحصيل ومخزون سيارة من الجوال',
  intro: 'تطبيق المندوب من Field Sales يحمل يوم البيع كله في جوال المندوب: يُصدر الفاتورة وسند القبض ويطبعهما أمام العميل، ويرى عهدة سيارته، ويسجّل زيارته بموقعها وصورها، وتصل بياناته إلى لوحة الإدارة.',
  offline: 'التحصيل والزيارات تستمر بلا إنترنت، أما الفواتير (القياسية والمبسطة) والمرتجعات فتحتاج اتصالاً لحظة الإصدار للشركات المفعّل لها ربط المرحلة الثانية.',
  cards: [
    { key: 'invoice', title: 'فواتير وسندات من الجوال', desc: 'فاتورة برمز QR وسند قبض يصدران ويُطبعان أمام العميل.' },
    { key: 'offline', title: 'التحصيل والزيارات بلا إنترنت', desc: 'سند القبض وتسجيل الزيارة يعملان في المناطق المقطوعة ويُرفعان تلقائياً عند عودة الشبكة. والفواتير والمرتجعات تحتاج اتصالاً لحظة الإصدار للشركات المفعّل لها الربط.' },
    { key: 'scan', title: 'مسح الباركود بالكاميرا', desc: 'أضف الأصناف بمسح سريع متتابع بلا جهاز إضافي.' },
    { key: 'visit', title: 'زيارات موثّقة بالموقع', desc: 'سجّل الزيارة بصورة وملاحظة وإحداثيات، فيظهر خط سيرك على خريطة الإدارة.' },
    { key: 'print', title: 'طباعة حرارية', desc: 'اطبع الفاتورة على طابعة بلوتوث حرارية مباشرة من الجهاز.' },
    { key: 'stock', title: 'مخزون سيارتك بين يديك', desc: 'اعرف المتبقّي من كل صنف لحظياً ولا تبع ما ليس في السيارة.' },
  ],
  faq: [
    { q: 'هل يعمل تطبيق المندوب على أي جوال؟', a: 'نعم. يعمل من متصفح أي جوال ذكي بلا تنزيل ويمكن تثبيته على الشاشة الرئيسية، وله تطبيق على Google Play وApp Store. ويدخل المندوب بحساب ينشئه له مدير الشركة من لوحة الإدارة.' },
    // لا ذكر لأسواق «المقاصّة اللحظية» هنا: RepApp.tsx يمنع الإصدار دون اتصال بشرط phase===2 وحده، ولا قيد بالدولة فيه
    { q: 'هل يعمل تطبيق المندوب دون إنترنت؟', a: 'نعم بحدود واضحة. سند القبض وتسجيل الزيارة وإضافة العميل تعمل دون اتصال وتُرفع تلقائياً عند عودة الشبكة بلا تكرار، وكذلك الفواتير في الشركات غير المفعّل لها الربط. أما الشركات السعودية المفعّل لها ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفواتير (القياسية والمبسطة) والمرتجعات اتصالاً لحظة الإصدار.' },
    { q: 'هل يحتاج المندوب طابعة؟', a: 'الطابعة اختيارية. من يريد إيصالاً ورقياً للعميل يكفيه طابعة حرارية ٥٨ مم تقترن بالجوال عبر بلوتوث ويتعرّف عليها نظام الطباعة في الجهاز، ولا نلزمك بطراز معيّن ولا نبيع أجهزة.' },
  ],
};
/** أقسام الصفحة: [ميزة، عنوان، أي بنود how تُعرض] — المحتوى نفسه من features.mjs */
const REP_APP_SECTIONS = [
  ['thermal-printing', 'الفاتورة والطباعة أمام العميل', [0, 2]],
  ['rep-collection', 'التحصيل وسند القبض', [0, 1]],
  ['van-stock', 'عهدة السيارة', [1, 2]],
  ['visit-tracking', 'الزيارات وخط السير', [0, 1]],
  ['offline-invoicing', 'العمل دون اتصال', [2, 3]],
  ['zatca-phase2', PHASE2_ANCHOR, [3]],
];
/**
 * @returns {Array<{h2: string, paras?: string[], sub: Array<{h3: string, p: string}>, link: {href: string, label: string}}>}
 */
export function repAppSections() {
  const out = [];
  for (const [id, h2, pick] of REP_APP_SECTIONS) {
    const ft = FEATURES.find((f) => f.id === id);
    if (!ft) continue;
    const sub = pick.map((i) => ft.how[i]).filter(Boolean).map((h) => ({ h3: h.title, p: h.body }));
    if (!sub.length) continue;
    const isPhase2 = id === 'zatca-phase2';
    out.push({
      h2,
      // جملة الربط في فقرة مستقلة أول القسم، والقسم بلا سنة ولا مهلة (تصحيح الناقد 8)
      paras: isPhase2 ? ['ندعم ربط المرحلة الثانية مع منصة فاتورة للشركات السعودية.'] : [],
      sub,
      link: { href: featureHref(ft.slug), label: isPhase2 ? 'كيف يعمل الربط وما حدوده' : `تفاصيل ${ft.name} وحدودها` },
    });
  }
  return out;
}
export const repAppJsonLd = (canonical) => ({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'FAQPage', mainEntity: REP_APP.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'الرئيسية', item: 'https://fieldsa.net/' },
      { '@type': 'ListItem', position: 2, name: 'تطبيق المندوب', item: canonical },
    ] },
  ],
});
