// يولّد public/sitemap.xml آلياً من المسارات + روابط hreflang + مقالات المدوّنة.
// مصادر المقالات: اتحاد محتوى الـCMS الحيّ ومقالات src/blog/posts.ts — بالدالة نفسها التي يراها الزائر
// (effectivePosts)، لا نسخة موازية. يُشغَّل عند كل بناء (prebuild) وفي الصيانة المجدولة.
// لا اتصال مباشر بقاعدة البيانات — يستخدم الـAPI العام فقط.
//
// التشغيل: node scripts/gen-sitemap.mjs [--out <ملف>]   (الافتراضي public/sitemap.xml)
// SEO_ALLOW_OFFLINE=1 للتشغيل المحلي بلا شبكة فقط (مقالات المستودع وحدها).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transformSync } from 'esbuild';
import { buildCatalog, isIndexable, CONTENT_VERSION } from '../src/blog/seo/catalog.mjs';
import { existsWith, consolidatedTarget, consolidationReport } from '../src/blog/consolidate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://fieldsa.net';
import { SECTORS } from './sectors-data.mjs';
import { FEATURES } from '../src/content/features.mjs';
import { TEMPLATES } from './templates-data.mjs';
const API = 'https://api.fieldsa.net/api/site-content';

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : null;
const OUT = outArg ? path.resolve(outArg) : path.join(ROOT, 'public/sitemap.xml');

/**
 * الصفحات التسويقية المُصيَّرة. الرئيسية وحدها بخمس لغات؛ والبقية بثلاث (ع/إ/فر) لأن prerender
 * لا يصيّر لها نسخة تركية ولا صينية — كانت الخريطة تعلن /tr/about و/zh/pricing وأخواتها (16 رابطاً)
 * فيتسلّم الزاحف قوقعة الرئيسية بـcanonical «/». مطابقة لـavailableLangs في src/i18n/locale.ts.
 */
const I18N_ROUTES = [
  { p: '/', priority: '1.0', freq: 'weekly' },
  { p: '/about', priority: '0.7', freq: 'monthly' },
  { p: '/contact', priority: '0.7', freq: 'monthly' },
  { p: '/calculator', priority: '0.9', freq: 'weekly' },
  { p: '/invoice-generator', priority: '0.9', freq: 'weekly' },
  { p: '/pricing', priority: '0.9', freq: 'monthly' },
  { p: '/terms', priority: '0.3', freq: 'yearly' },
  { p: '/privacy', priority: '0.3', freq: 'yearly' },
  { p: '/service-agreement', priority: '0.3', freq: 'yearly' },
];
const langsFor = (arPath) => (arPath === '/' ? ['ar', 'en', 'fr', 'tr', 'zh'] : ['ar', 'en', 'fr']);

/**
 * يجلب محتوى الـCMS بمحاولات متكرّرة حتى نحو 90 ثانية (تصحيح الناقد 16: نشر الخادم قد يتزامن مع
 * بناء الموقع، و2+4+8 ثوانٍ لا تكفي). الفشل الكلّي يُسقط البناء (exit 1) فيبقى نشر Render السابق
 * حيّاً — بدل خريطة منكمشة بلا ~108 مقالات تُنشر صامتة. لا حدّ أدنى لعدد المقالات: ردّ صالح يكفي.
 */
async function fetchCms() {
  const DEADLINE = 90_000;
  const started = Date.now();
  let wait = 2000;
  let attempt = 0;
  let last = '';
  for (;;) {
    attempt++;
    const left = DEADLINE - (Date.now() - started);
    try {
      const r = await fetch(API, { signal: AbortSignal.timeout(Math.max(5000, Math.min(20000, left))) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json())?.data;
      if (!data || typeof data !== 'object') throw new Error('ردّ بلا data');
      if (attempt > 1) console.log(`  نجح جلب CMS في المحاولة ${attempt}`);
      return data;
    } catch (e) {
      last = e?.message || String(e);
    }
    if (Date.now() - started + wait >= DEADLINE) break;
    console.log(`  تعذّر جلب CMS (محاولة ${attempt}: ${last}) — إعادة بعد ${wait / 1000} ث`);
    await new Promise((res) => setTimeout(res, wait));
    wait = Math.min(wait * 2, 30_000);
  }
  if (process.env.SEO_ALLOW_OFFLINE === '1') {
    console.log(`  ⚠️ CMS غير متاح (${last}) — SEO_ALLOW_OFFLINE=1: مقالات المستودع وحدها (تشغيل محلي فقط)`);
    return null;
  }
  console.error(`✗ تعذّر جلب CMS بعد ${attempt} محاولات خلال ${Math.round((Date.now() - started) / 1000)} ث (${last}).`);
  console.error('  أُوقف البناء عمداً: خريطة بلا مقالات CMS أسوأ من إبقاء النشر السابق. للتشغيل المحلي بلا شبكة: SEO_ALLOW_OFFLINE=1');
  process.exit(1);
}

/** يحمّل src/blog/posts.ts (بلا استيرادات) كوحدة ESM في الذاكرة — المصدر نفسه الذي يقرؤه الزائر وprerender */
async function loadPostsModule() {
  const src = fs.readFileSync(path.join(ROOT, 'src/blog/posts.ts'), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/**
 * الشرطة المائلة في آخر الرابط **إلزامية** — ليست تجميلاً.
 *
 * الصفحات مُصيَّرة مسبقاً في مجلّدات: dist/blog/x/index.html. وRender يخدم مجلّداً فقط
 * إذا انتهى الطلب بشرطة (/blog/x/). أما /blog/x فلا يجد له ملفاً فتبتلعه قاعدة
 * `/* → /index.html` ويُعيد قوقعة SPA فارغة — لا محتوى ولا JSON-LD.
 *
 * أي أن جوجل كان يزور 1132 صفحة فارغة بينما الحقيقية على بُعد شرطة واحدة.
 * (جُرّبت قواعد rewrite في Render فأنتجت حلقة إعادة توجيه لا نهائية — الحلّ هنا.)
 */
const canon = (url) => {
  const m = String(url).match(/^(https?:\/\/[^/]+)(\/[^#?]*)?([#?].*)?$/);
  if (!m) return url;
  const [, origin, p = '/', rest = ''] = m;
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return url;   // ملف بامتداد (.xml/.txt) — لا شرطة
  return p.endsWith('/') ? origin + p + rest : origin + p + '/' + rest;
};

/** روابط اللغات الخمس لمسار عربي (الرئيسية «/» بلا لاحقة) */
const urlsOf = (arPath) => {
  const suffix = arPath === '/' ? '' : arPath;
  return {
    ar: canon(ORIGIN + (arPath === '/' ? '/' : arPath)),
    en: canon(ORIGIN + '/en' + suffix),
    fr: canon(ORIGIN + '/fr' + suffix),
    tr: canon(ORIGIN + '/tr' + suffix),
    zh: canon(ORIGIN + '/zh' + suffix),
  };
};

/**
 * عنقود hreflang للغات الموجودة فقط (langs) + x-default إلى العربية.
 * لغة واحدة ⇒ لا عنقود (صفحة بلا نسخ لغوية لا تحتاج hreflang، كما في HTML المُصيَّر).
 */
const alt = (arPath, langs = langsFor(arPath)) => {
  if (langs.length < 2) return '';
  const u = urlsOf(arPath);
  const line = {
    ar: `    <xhtml:link rel="alternate" hreflang="ar" href="${u.ar}"/>`,
    en: `    <xhtml:link rel="alternate" hreflang="en" href="${u.en}"/>`,
    fr: `    <xhtml:link rel="alternate" hreflang="fr" href="${u.fr}"/>`,
    tr: `    <xhtml:link rel="alternate" hreflang="tr" href="${u.tr}"/>`,
    zh: `    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${u.zh}"/>`,
  };
  return [...langs.map((L) => line[L]), `    <xhtml:link rel="alternate" hreflang="x-default" href="${langs.includes('ar') ? u.ar : u[langs[0]]}"/>`].join('\n');
};

const imageBlock = (img) => (img ? `    <image:image>\n      <image:loc>${img}</image:loc>\n    </image:image>\n` : '');

// كل رابط يمرّ عبر canon هنا — نقطة واحدة تضمن ألّا يُفلت رابط بلا شرطة
// lastmod الافتراضي = CONTENT_VERSION (تاريخ ثابت لآخر تحديث محتوى) لا اليوم — وإلّا تجدّدت
// تواريخ كل الصفحات التسويقية كل بناء فيرفض جوجل الوثوق بها كلّها. وحُذف changefreq/priority
// (يتجاهلهما جوجل رسمياً 2026)؛ يبقى freq/priority في التوقيع لعدم كسر المنادين، بلا إخراج.
const urlEntry = (loc, { lastmod = CONTENT_VERSION, freq = 'monthly', priority = '0.6', alternates = '', image = '' } = {}) =>
  `  <url>\n    <loc>${canon(loc)}</loc>\n${alternates ? alternates + '\n' : ''}${imageBlock(image)}    <lastmod>${lastmod}</lastmod>\n  </url>`;

async function main() {
  const cms = await fetchCms();
  const mod = await loadPostsModule();
  const catalog = buildCatalog();
  const catalogSlugs = new Set(catalog.map((a) => a.slug));
  // كـprerender: مقال يدوي بـslug مقال مولَّد لا يُصيَّر (المولَّد أغنى) فلا يُعلن مرّتين
  const all = mod.effectivePosts(cms?.blog);
  const posts = all.filter((p) => !catalogSlugs.has(p.slug));
  const fromCms = Array.isArray(cms?.blog) ? new Set(cms.blog.filter((p) => p && p.slug && p.title).map((p) => p.slug)) : new Set();
  console.log(`  مصدر المقالات: ${posts.length} يدوي (${posts.filter((p) => fromCms.has(p.slug)).length} من CMS + ${posts.filter((p) => !fromCms.has(p.slug)).length} من المستودع وحده)`);

  // الدمج (P3): المقال الرقيق المدموج يخرج من الخريطة ومن بدائل غيره
  const exists = existsWith(posts);
  const has = (slug, L) => { const p = posts.find((x) => x.slug === slug); return !!p && (L === 'ar' || !!(p.en && p.en.title)); };
  const report = consolidationReport(exists, has);
  for (const s of report.skipped) console.log(`  دمج متجاهَل: ${s.lang} ${s.slug} ← ${s.target} (${s.why})`);

  const urls = [];

  // الصفحات التسويقية: الرئيسية بخمس لغات، والبقية بثلاث — كلٌّ يحمل بدائل لغاته الموجودة وحدها
  for (const r of I18N_ROUTES) {
    const langs = langsFor(r.p);
    const alternates = alt(r.p, langs);
    const u = urlsOf(r.p);
    for (const L of langs) urls.push(urlEntry(u[L], { freq: r.freq, priority: r.priority, alternates }));
  }

  // فهرس المدوّنة (عربي + /en + /fr مع hreflang)
  const idxAlt = alt('/blog', ['ar', 'en', 'fr']);
  // صفحة تنزيل التطبيق (عربية فقط — لا نسخة /en لها في الراوتر)
  urls.push(urlEntry(ORIGIN + '/rep-app', { freq: 'monthly', priority: '0.8' }));
  urls.push(urlEntry(ORIGIN + '/free', { freq: 'monthly', priority: '0.9' }));
  for (const id of ['commission', 'van', 'reps', 'aging']) {
    urls.push(urlEntry(ORIGIN + '/free/' + id, { freq: 'monthly', priority: '0.8' }));
  }
  // النماذج والمزايا والقطاعات عربية فقط — لا نسخة en/fr لها بعد، فلا hreflang كاذب
  urls.push(urlEntry(ORIGIN + '/نماذج', { freq: 'monthly', priority: '0.8' }));
  for (const t of TEMPLATES) {
    urls.push(urlEntry(ORIGIN + '/نماذج/' + t.slug, { freq: 'monthly', priority: '0.7' }));
  }
  urls.push(urlEntry(ORIGIN + '/مزايا', { freq: 'monthly', priority: '0.7' }));
  for (const ft of FEATURES) {
    urls.push(urlEntry(ORIGIN + '/مزايا/' + ft.slug, { freq: 'monthly', priority: '0.8' }));
  }
  urls.push(urlEntry(ORIGIN + '/قطاعات', { freq: 'monthly', priority: '0.7' }));
  for (const sec of SECTORS) {
    urls.push(urlEntry(ORIGIN + '/قطاعات/' + sec.slug, { freq: 'monthly', priority: '0.8' }));
  }

  urls.push(urlEntry(ORIGIN + '/blog', { freq: 'weekly', priority: '0.8', alternates: idxAlt }));
  urls.push(urlEntry(ORIGIN + '/en/blog', { freq: 'weekly', priority: '0.8', alternates: idxAlt }));
  urls.push(urlEntry(ORIGIN + '/fr/blog', { freq: 'weekly', priority: '0.8', alternates: idxAlt }));

  // المقالات اليدوية: عربية دائماً + إنجليزية للثنائية، عدا النسخ المدموجة (P3).
  // lastmod = تاريخ المقال نفسه (updatedAt/modified/date — lastModifiedOf في posts.ts)، لا CONTENT_VERSION
  // ولا اليوم: نسخة المقال في CMS لا تتغيّر بتغيّر قالب الكتالوج.
  let consolidatedOut = 0;
  for (const p of posts) {
    const arLoc = `/blog/${p.slug}`;
    const lastmod = mod.lastModifiedOf(p) || CONTENT_VERSION;
    const langs = (p.en && p.en.title ? ['ar', 'en'] : ['ar']).filter((L) => {
      if (consolidatedTarget(p.slug, L, exists)) { consolidatedOut++; return false; }
      return true;
    });
    const a = alt(arLoc, langs);
    const u = urlsOf(arLoc);
    for (const L of langs) urls.push(urlEntry(u[L], { lastmod, freq: 'monthly', priority: '0.7', alternates: a }));
  }

  // مقالات SEO المولَّدة برمجياً (ثلاثية اللغة) — تستهدف كل الدول العربية.
  // لكل مقال: رابط <loc> لكل لغة من الثلاث (ع/إ/فر) — ليتطابق مع بدائل hreflang،
  // مع صورة البطاقة المُوطّنة لكل لغة في خريطة صور Google.
  let seoUrlCount = 0;
  for (const a of catalog) {
    const p = `/blog/${a.slug}`;
    // الدمج: الصفحة غير الأساسية (canonical يشير لصفحتها الجامعة) تُحذف من الخريطة —
    // إدراج صفحة مدموجة في الخريطة إشارة متناقضة تُبقي المنافسة الداخلية قائمة.
    if (!a.isCanonical) continue;
    // تقليم الفهرسة: الإنجليزية لأسواق بلا طلب إنجليزي مُعلَّمة noindex في التصيير ⇒
    // تُحذف من الخريطة ومن عنقود hreflang معاً (رابط noindex داخل خريطة = إشارة متناقضة).
    const langs = isIndexable(a.cc, 'en') ? ['ar', 'en', 'fr'] : ['ar', 'fr'];
    const seoAlt = alt(p, langs);
    const u = urlsOf(p);
    for (const L of langs) {
      urls.push(urlEntry(u[L], { lastmod: a.modified, freq: 'monthly', priority: '0.6', alternates: seoAlt, image: `${ORIGIN}/og/${a.slug}-${L}.jpg` }));
      seoUrlCount++;
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>\n`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, xml);
  const marketing = I18N_ROUTES.reduce((n, r) => n + langsFor(r.p).length, 0);
  console.log(`✅ sitemap.xml: ${urls.length} رابط (${marketing} تسويقية + فهرس مدوّنة ع/إ/فر + ${posts.length} مقال يدوي بلا ${consolidatedOut} نسخة مدموجة + ${seoUrlCount} رابط مقالات SEO مولَّدة لِـ${catalog.length} مقال) ← ${path.relative(ROOT, OUT) || OUT}`);
}

// خطأ غير الشبكة لا يُفشل البناء — يبقى sitemap.xml الحالي كما هو. (تعذّر CMS يُفشله عمداً داخل fetchCms)
main().catch((e) => { console.error('تعذّر توليد sitemap (غير قاتل):', e.message); process.exit(0); });
