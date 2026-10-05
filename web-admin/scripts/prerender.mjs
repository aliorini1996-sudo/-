// تصيير مسبق (Prerender) بلا متصفّح — يولّد HTML ثابتاً لكل مقال وصفحة مدوّنة من مولّد المقالات.
// النتيجة: dist/blog/{slug}/index.html (+ /en, /fr) تحوي الوسوم الصحيحة (title/description/OG/hreflang/JSON-LD)
// والمحتوى الكامل — فيراها Google وكاشطو التواصل (فيسبوك/واتساب) بلا حاجة لتشغيل JavaScript.
// يعمل كـ postbuild (بعد vite build) — سريع (ثوانٍ) وحتمي، فلا يُبطئ بناء Vercel.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { transformSync } from 'esbuild';
import { buildCatalog, getArticle, listArticles, COUNTRIES, isIndexable, canonicalSlug } from '../src/blog/seo/catalog.mjs';
import { loadPricing, repsCap } from './pricing-source.mjs';
import { SECTORS } from './sectors-data.mjs';
import { FEATURES } from '../src/content/features.mjs';
import { TEMPLATES } from './templates-data.mjs';
import { existsWith, consolidatedTarget, consolidatedUrl, consolidationReport } from '../src/blog/consolidate.mjs';
import { extractFaqDetailed, publishableFaq, faqPageNode, faqProblemWith, pricingFaq, pricingJsonLd } from '../src/blog/extractFaq.mjs';
import {
  relatedPlan, RELATED_TITLE, RELATED_CAP, blogTitle, sectorRelatedLinks, pricingTitle, pricingDescription, pricingSections, phase2LinkFor,
  enPriceLine, frPriceLine, FREE_TOOLS, FREE_INDEX, freeToolMeta, freeToolJsonLd, aboutContent, REP_APP, REP_APP_STORES, repAppSections,
  repAppJsonLd, PHASE2_FEATURE_HREF, PHASE2_ANCHOR,
} from '../src/blog/clusters.mjs';
import * as claimsRules from './claims-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const ORIGIN = 'https://fieldsa.net';
const LANGS = ['ar', 'en', 'fr'];
const CMS_API = 'https://api.fieldsa.net/api/site-content';
/** مصنِّف أسئلة FAQPage بقواعد حارس الادّعاءات نفسها (نفي قديم للمرحلة الثانية، وعد «دون اتصال» غير مقيَّد) */
const faqProblem = faqProblemWith(claimsRules);
/** مرجع المنظّمة المعرَّفة في كتلة القالب (index.html) — كاتب المقالات وناشرها كيان واحد بمعرّف ثابت */
const ORG_REF = { '@id': `${ORIGIN}/#organization` };

/**
 * يجلب محتوى الـCMS بمحاولات متكرّرة حتى نحو 90 ثانية (تصحيح الناقد 16). الفشل الكلّي يُسقط البناء
 * (exit 1) فيبقى نشر Render السابق حيّاً: كان التعثّر يُبتلع بصمت فتُخدَم ~108 مقالة قوقعةَ الرئيسية
 * حتى النشر التالي. لا حدّ أدنى لعدد المقالات: ردّ صالح يكفي. مطابق لـfetchCms في gen-sitemap.mjs.
 * SEO_ALLOW_OFFLINE=1 للتشغيل المحلي بلا شبكة فقط (مقالات المستودع وأسئلة الرئيسية الافتراضية).
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
      const r = await fetch(CMS_API, { signal: AbortSignal.timeout(Math.max(5000, Math.min(20000, left))) });
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
    console.log(`  ⚠️ CMS غير متاح (${last}) — SEO_ALLOW_OFFLINE=1: محتوى المستودع وحده (تشغيل محلي فقط)`);
    return null;
  }
  console.error(`✗ تعذّر جلب CMS بعد ${attempt} محاولات خلال ${Math.round((Date.now() - started) / 1000)} ث (${last}).`);
  console.error('  أُوقف البناء عمداً: موقع بلا مقالات CMS أسوأ من إبقاء النشر السابق. للتشغيل المحلي بلا شبكة: SEO_ALLOW_OFFLINE=1');
  process.exit(1);
}

/** يحوّل ملف TS بلا استيرادات إلى ESM عبر esbuild ويستورده (ملف مؤقت داخل dist يُحذف فوراً) */
async function loadTs(rel, exportName) {
  const src = fs.readFileSync(path.resolve(__dirname, `../src/${rel}`), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  const tmp = path.join(DIST, `_${path.basename(rel).replace(/\W+/g, '_')}_tmp.mjs`);
  fs.writeFileSync(tmp, code);
  try {
    const mod = await import(pathToFileURL(tmp).href);
    return exportName ? mod[exportName] : mod;
  } finally { fs.unlinkSync(tmp); }
}

// المقالات اليدوية: اتحاد CMS الحيّ ومقالات src/blog/posts.ts بالدالة نفسها التي يراها الزائر (effectivePosts)
function manualPostsFrom(mod, cmsBlog) {
  return mod.effectivePosts(cmsBlog).map((p) => ({
    ...p,
    contentHtml: mod.normalizeContent(p.contentHtml),
    en: p.en && p.en.title ? { ...p.en, contentHtml: mod.normalizeContent(p.en.contentHtml) } : undefined,
  }));
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * أسئلة الرئيسية العربية كما يرسمها React (LandingPage): mergeContent(defaultContent, CMS) يدمج
 * المصفوفة **بالموضع وبطول الافتراضية** — كل حقل من CMS ما لم يكن فارغاً، وإلا الافتراضي.
 * فالجسم المُصيَّر وFAQPage يأتيان من المصدر الذي يراه الزائر، لا من نسخة ثالثة في index.html.
 */
function homeFaqFrom(defaults, cms) {
  const d = defaults?.faq || {};
  const c = cms?.faq && typeof cms.faq === 'object' ? cms.faq : {};
  const pick = (saved, base) => (saved == null || saved === '' ? base : saved);
  const saved = Array.isArray(c.items) ? c.items : [];
  // بلا افتراضية (تعذّر تحميلها) تُؤخذ عناصر CMS كما هي — أفضل من رئيسية بلا أسئلة
  const base = Array.isArray(d.items) && d.items.length ? d.items : saved;
  const items = base.map((it, i) => {
    const s = saved[i] && typeof saved[i] === 'object' ? saved[i] : {};
    return { q: pick(s.q, it && it.q), a: pick(s.a, it && it.a) };
  });
  return { title: pick(c.title, d.title) || 'أسئلة شائعة', items };
}

// سياسة الخصوصية للزاحف ومراجع الإعلانات — **من المصدر نفسه الذي يعرضه InfoPage للزائر** لا نسخة ثالثة:
// defaultContent*.ts لكل لغة، **والعربية من الكود دائماً لا من CMS** (القاعدة ذاتها في InfoPage.tsx):
// السياسة تصف سلوك الكود، ونصّ CMS القديم يَعِد بـ«لا أغراض إعلانية» — لو طال لعاد إلى HTML الزاحف.
// لولا ذلك لقرأ الزاحف ملخّصاً عامّاً بينما يرى الزائر سياسة القياس الإعلاني الكاملة (فخّ المصدر المزدوج).
async function loadPrivacyHtml() {
  const bodies = {
    ar: (await loadTs('landing/defaultContent.ts', 'defaultContent')).pages.privacy.body,
    en: (await loadTs('landing/defaultContentEn.ts', 'defaultContentEn')).pages.privacy.body,
    fr: (await loadTs('landing/defaultContentFr.ts', 'defaultContentFr')).pages.privacy.body,
  };
  // فقرة تبدأ برقم قسم ⇒ عنوانه h2، والأسطر الباقية فقرة واحدة بفواصل أسطر
  const toHtml = (body) => String(body).trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const head = lines.length > 1 && /^[0-9٠-٩]+\.?\s/.test(lines[0]) ? `<h2>${esc(lines.shift())}</h2>` : '';
    return `${head}<p>${lines.map(esc).join('<br/>')}</p>`;
  }).join('');
  return { ar: toHtml(bodies.ar), en: toHtml(bodies.en), fr: toHtml(bodies.fr) };
}

let template = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

// يستبدل وسوم <head> الافتراضية بقيم الصفحة، ويحقن hreflang + JSON-LD + المحتوى
/**
 * templateLd: عُقد تُضاف إلى كتلة القالب نفسها لا إلى كتلة الصفحة (data-seo-page) — لما يجب أن يبقى بعد
 * إقلاع React: LandingPage يستبدل كتلة الصفحة بكتلة Organization، فـFAQPage الرئيسية الإنجليزية الظاهرة
 * أسئلتها كانت ستختفي من السكيما بعد الإقلاع لو وُضعت هناك (كالرئيسية العربية أدناه).
 */
function buildPage({ lang, title, description, keywords, canonical, image, ogType = 'website', hreflang = '', jsonLd = null, bodyHtml = '', robots = '', templateLd = [] }) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const ogLocale = { en: 'en_US', fr: 'fr_FR', tr: 'tr_TR', zh: 'zh_CN' }[lang] || 'ar_SA';
  let h = template;
  h = h.replace(/<html[^>]*>/, `<html lang="${lang}" dir="${dir}">`);
  h = h.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  h = h.replace(/(<meta name="description" content=")[\s\S]*?("\s*\/>)/, `$1${esc(description)}$2`);
  if (keywords) h = h.replace(/(<meta name="keywords" content=")[\s\S]*?("\s*\/>)/, `$1${esc(keywords)}$2`);
  h = h.replace(/(<link rel="canonical" href=")[^"]*("\s*\/>)/, `$1${canonical}$2`);
  // تقليم الفهرسة: يستبدل وسم robots الافتراضي (index,follow) لا يُضيف وسماً ثانياً متناقضاً
  if (robots) h = h.replace(/(<meta name="robots" content=")[^"]*("\s*\/>)/, `$1${robots}$2`);
  h = h.replace(/(<meta property="og:type" content=")[^"]*("\s*\/>)/, `$1${ogType}$2`);
  h = h.replace(/(<meta property="og:title" content=")[\s\S]*?("\s*\/>)/, `$1${esc(title)}$2`);
  h = h.replace(/(<meta property="og:description" content=")[\s\S]*?("\s*\/>)/, `$1${esc(description)}$2`);
  h = h.replace(/(<meta property="og:url" content=")[^"]*("\s*\/>)/, `$1${canonical}$2`);
  h = h.replace(/(<meta property="og:image" content=")[^"]*("\s*\/>)/, `$1${image}$2`);
  h = h.replace(/(<meta property="og:locale" content=")[^"]*("\s*\/>)/, `$1${ogLocale}$2`);
  h = h.replace(/(<meta name="twitter:title" content=")[\s\S]*?("\s*\/>)/, `$1${esc(title)}$2`);
  h = h.replace(/(<meta name="twitter:description" content=")[\s\S]*?("\s*\/>)/, `$1${esc(description)}$2`);
  h = h.replace(/(<meta name="twitter:image" content=")[^"]*("\s*\/>)/, `$1${image}$2`);
  // التكبير مسموح في الصفحات التسويقية (E1): القالب يمنعه (maximum-scale=1 وuser-scalable=no) لأن
  // dist/index.html قوقعة تطبيق المندوب و/m أيضاً، وحقولهما بخط ١٤ بكسل — رفع المنع هناك يجعل iOS
  // يكبّر الشاشة عند لمس كل حقل. هذه الصفحات وحدها تُكتب هنا، فيُرفع المنع عنها دون مسّ القوقعة.
  h = h.replace(/(<meta name="viewport" content=")[^"]*(")/, '$1width=device-width, initial-scale=1.0, viewport-fit=cover$2');
  // 🔴 منع «الكيان الفريد المكرَّر» (اكتُشف 5 أغسطس 2026 من Search Console):
  // كل صفحة داخلية ترث ld+json قالبِ الرئيسية ثم تضيف كتلتها، فيتكرّر النوع نفسه مرّتين في الصفحة:
  //   · مقالات الكتالوج → FAQPage ×2   · صفحات /free → SoftwareApplication ×2
  // (تقرير «البيانات المنظّمة غير قابلة للتحليل»: 108 صفحة منذ مطلع يوليو).
  // ⚠️ الكتلتان **صالحتان JSON كلٌّ على حدة** — العطل دلاليّ لا نحويّ فلا يكشفه parse.
  // تُحذف من القالب:
  //   · الأنواع التي تُصدرها الصفحة نفسها (لا تكرار).
  //   · FAQPage دائماً (P2): أسئلة الرئيسية لا تظهر في أي صفحة غيرها — كانت تُحقن في أكثر من مئتي
  //     صفحة، منها إنجليزية بأسئلة عربية. الرئيسية العربية لا تمرّ بـbuildPage، وتُبنى أسئلتها من CMS.
  //   · SoftwareApplication في الصفحات غير العربية (تصحيح الناقد 19): وصفه عربي وinLanguage ar.
  const ownTypes = new Set(['FAQPage', ...(lang === 'ar' ? [] : ['SoftwareApplication'])]);
  if (jsonLd) {
    for (const n of (Array.isArray(jsonLd['@graph']) ? jsonLd['@graph'] : [jsonLd])) {
      const t = n && n['@type'];
      if (typeof t === 'string') ownTypes.add(t);
      else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && ownTypes.add(x));
    }
  }
  h = h.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, (m, body) => {
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j['@graph'])) {
        const g = j['@graph'].filter((n) => !(n && typeof n['@type'] === 'string' && ownTypes.has(n['@type'])));
        if (g.length !== j['@graph'].length || templateLd.length) {
          return `<script type="application/ld+json">${JSON.stringify({ ...j, '@graph': [...g, ...templateLd] })}</script>`;
        }
      }
    } catch { /* قالب غير متوقّع — يُترك كما هو بدل كسره */ }
    return m;
  });
  // `data-seo-page` يجعل كتلة الصفحة قابلة للتمييز عن كتلة القالب العامّة، فيستبدلها
  // useSeo عند إقلاع React بدل أن يضيف نسخة ثانية (وإلا تكرّر Article وBreadcrumbList
  // في الصفحة المُصيَّرة بعد التصيير — وهو ما لا يراه أي فحص للـHTML الثابت).
  const extra = hreflang + (jsonLd ? `\n    <script type="application/ld+json" data-seo-page="1">${JSON.stringify(jsonLd)}</script>` : '');
  h = h.replace('</head>', `${extra}\n  </head>`);
  // رابط المحادثة يُحقَن **مركزياً** لا في كل صفحة على حدة.
  //
  // زرّ واتساب العائم مكوّن React، فلا وجود له في HTML المُصيَّر: الزائر يراه
  // بعد إقلاع الجافاسكربت، أمّا الزاحف ومعاينة المشاركة وقارئ بلا JS فلا.
  // قِيس على الإنتاج: /about و/free و/نماذج خرجت بلا أي رابط محادثة رغم أنها
  // صفحات تسويقية. الحقن هنا يجعل النسيان مستحيلاً لأي صفحة تُضاف لاحقاً.
  //
  // وموضعه **داخل `#root`** لا قبل `</body>`: أوّل تصيير لـcreateRoot يمحو
  // أبناء الحاوية، فيختفي الرابط للزائر ويبقى الزرّ العائم وحده. حين جُرّب
  // خارجها ظهر رابط نصّي شارد بارتفاع ٩٦ بكسل أسفل كل صفحة من الـ١١٦١.
  const ssr = [];
  if (bodyHtml) ssr.push(bodyHtml);
  if (WA_LINK) {
    const label = lang === 'en' ? 'Chat with us on WhatsApp'
      : lang === 'fr' ? 'Discutez avec nous sur WhatsApp'
      : lang === 'tr' ? 'WhatsApp üzerinden bize yazın'
      : lang === 'zh' ? '通过 WhatsApp 联系我们' : 'تحدّث معنا على واتساب';
    ssr.push(`<a href="${WA_LINK}" rel="noopener" data-wa-static>${label}</a>`);
  }
  if (ssr.length) h = h.replace(/<div id="root">\s*<\/div>/, `<div id="root"><div data-ssr>${ssr.join('\n')}</div></div>`);
  return h;
}

/** رابط واتساب المتاح لـbuildPage — يُضبط مرّة عند تحميل التسعير من الـCMS */
let WA_LINK = '';
export function setWaLink(v) { WA_LINK = v || ''; }

/**
 * مسار الصفحة على <html data-ssr-path> (E2 وتصحيح الناقد 1): سكربت الرأس في index.html يُظهر المحتوى
 * المُصيَّر فوراً **فقط** إن طابق location.pathname هذا المسار. dist/index.html قوقعة كل مسار غير
 * مُصيَّر (/m و/rep و/login و/c و/pay و/platform…) ومسارها «/»، فلا يظهر نصّ الرئيسية على التطبيق.
 * القيمة بالشرطة الأخيرة وبالعربية الخام (السكربت يفكّ ترميز المسار قبل المقارنة).
 */
function withSsrPath(html, routePath) {
  const p = `/${String(routePath).replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  return html.replace(/<html\b([^>]*)>/i, (m, attrs) => `<html${attrs.replace(/\sdata-ssr-path="[^"]*"/i, '')} data-ssr-path="${esc(p)}">`);
}

function writeRoute(routePath, rawHtml) {
  const html = withSsrPath(rawHtml, routePath);
  const dir = path.join(DIST, routePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  // 🔴 إصلاح المسارات العربية على Render (اكتُشف 5 أغسطس 2026): خادم Render الثابت يبحث
  // بالمسار المُرمَّز (%D9%86…) كما يصله دون فكّ الترميز، فلا يطابق مجلداً باسم عربي خام —
  // فتسقط /نماذج/ و/قطاعات/ كلها إلى قوقعة SPA (قِيس حيّاً: عنوان الرئيسية على 17 صفحة).
  // العلاج: نكتب نسخة ثانية من الصفحة تحت الاسم المُرمَّز لكل مقطع غير-ASCII، فيجدها
  // البحث الخام. (النسخة العربية الخام تبقى لأي خادم يفكّ الترميز — التكلفة مجلدات مكررة فقط.)
  if (/[^\x00-\x7F]/.test(routePath)) {
    const encoded = routePath.split('/').map((seg) => (/[^\x00-\x7F]/.test(seg) ? encodeURIComponent(seg) : seg)).join('/');
    const encDir = path.join(DIST, encoded);
    fs.mkdirSync(encDir, { recursive: true });
    fs.writeFileSync(path.join(encDir, 'index.html'), html);
  }
}

/**
 * الشرطة المائلة في آخر الرابط **إلزامية** — ليست تجميلاً.
 *
 * نكتب الصفحات في مجلّدات: dist/blog/x/index.html. وRender يخدم المجلّد فقط إذا انتهى
 * الطلب بشرطة (/blog/x/)؛ أما /blog/x فلا يجد له ملفاً فتبتلعه قاعدة `/* → /index.html`
 * ويُعيد قوقعة SPA فارغة بلا محتوى ولا JSON-LD.
 *
 * فإن أشار الـcanonical إلى /blog/x فنحن نُرشد جوجل بأيدينا إلى النسخة الفارغة
 * بينما الصفحة الحقيقية على بُعد شرطة واحدة. (جُرّبت قواعد rewrite في Render
 * فأنتجت حلقة إعادة توجيه لا نهائية — لذا الحلّ هنا في المصدر.)
 */
const canon = (url) => {
  const m = String(url).match(/^(https?:\/\/[^/]+)(\/[^#?]*)?([#?].*)?$/);
  if (!m) return url;
  const [, origin, p = '/', rest = ''] = m;
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return url;   // ملف بامتداد (.xml/.txt) — لا شرطة
  return p.endsWith('/') ? origin + p + rest : origin + p + '/' + rest;
};

// عنقود hreflang للغات المُمرَّرة فقط — تُستثنى منه لغةٌ مقلَّمة (noindex) أو مدموجة حتى لا يتناقض العنقود.
// لغة واحدة ⇒ لا عنقود (كما في الخريطة وseoUrls). وكل وسم يحمل data-seo-alt: useSeo يحذف الموسوم
// ويكتب بدائل seoUrls مكانه عند إقلاع React — بلا الوسم كان يُضيف عنقوداً ثانياً فوق هذا (P1).
const HREFLANG_CODE = { zh: 'zh-Hans' }; // المحتوى بالمبسّطة تحديداً؛ بقيّة اللغات رمزها اسمها
const hreflangFor = (blogPath, langs = LANGS) => (langs.length < 2 ? '' : langs
  .map((L) => `\n    <link rel="alternate" hreflang="${HREFLANG_CODE[L] || L}" href="${canon(`${ORIGIN}${L === 'ar' ? '' : '/' + L}${blogPath}`)}" data-seo-alt="1"/>`)
  .join('') + `\n    <link rel="alternate" hreflang="x-default" href="${canon(ORIGIN + blogPath)}" data-seo-alt="1"/>`);
const trilingualHreflang = (blogPath) => hreflangFor(blogPath, LANGS);

const tr = (L, ar, en, fr) => (L === 'ar' ? ar : L === 'en' ? en : fr);

function articleJsonLd(a, lang, canonical) {
  const prefix = lang === 'ar' ? '' : `/${lang}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      // الكاتب والناشر مرجع إلى المنظّمة المعرَّفة في كتلة القالب بالصفحة نفسها (اسمها وشعارها هناك)،
      // لا كائن Organization ثانٍ بلا معرّف يتصادم مع منتجات أخرى اسمها «Field Sales» (E1/P2).
      { '@type': 'Article', headline: a.title, description: a.description, inLanguage: lang, datePublished: a.date, dateModified: a.modified || a.date, image: a.image, author: ORG_REF, publisher: ORG_REF, mainEntityOfPage: canonical },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: tr(lang, 'الرئيسية', 'Home', 'Accueil'), item: canon(`${ORIGIN}${prefix || ''}`) },
        { '@type': 'ListItem', position: 2, name: tr(lang, 'المدوّنة', 'Blog', 'Blog'), item: canon(`${ORIGIN}${prefix}/blog`) },
        { '@type': 'ListItem', position: 3, name: a.title, item: canonical },
      ] },
      ...(a.faq && a.faq.length ? [{ '@type': 'FAQPage', mainEntity: a.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
      // HowTo حُذف عمداً (أغسطس 2026): نتائجه الغنية ميّتة في SERP منذ سبتمبر 2023 — بايتات ميتة في كل صفحة.
      // بيانات howToData تبقى في catalog.mjs (يستهلكها llms-full.txt لمحرّكات AI) لكنها لا تُبثّ JSON-LD.
    ],
  };
}

async function main() {
  // محتوى CMS أولاً وبمحاولات متكرّرة: تعذّره الكلّي يوقف البناء قبل أن يُكتب شيء في dist
  const cms = await fetchCms();
  // التسعير من مصدره الحيّ (CMS) لا من رقم مكتوب هنا — الأسعار تُحرَّر من لوحة المالك،
  // فأي رقم يدوي في هذا الملف ينزاح صامتاً عن الحقيقة ويصل جوجل ومحرّكات الذكاء وحده.
  const pricing = await loadPricing();
  console.log(`  التسعير: ${pricing.live ? 'CMS الحيّ' : 'احتياطي'} — ${pricing.arSummary}`);
  const waHref = pricing.waLink;
  setWaLink(waHref); // يتيح لـbuildPage حقن الرابط في كل صفحة بلا استثناء

  // قوقعة index.html تحمل كتلة AggregateOffer ثابتة تُنسَخ حرفياً إلى كل صفحة مُصيَّرة —
  // أكثر من ألف ملف. فلمّا صارت الباقات ثلاثاً بقي وصف عالم الباقتين منشوراً فيها كلّها،
  // ومرّ حارسُ السعر لأنه يفحص حقول JSON الرقمية لا النثر الذي يقرؤه الزاحف فعلاً.
  // فتُعاد كتابة الكتلة هنا من نفس مصدر الزائر قبل أوّل بناء صفحة.
  const numericCount = pricing.plans.filter((p) => /^\d+$/.test(String(p.price))).length;
  template = template
    .replace(/("lowPrice"\s*:\s*")[^"]*(")/, `$1${pricing.low}$2`)
    .replace(/("highPrice"\s*:\s*")[^"]*(")/, `$1${pricing.high}$2`)
    .replace(/("offerCount"\s*:\s*)\d+/, `$1${numericCount}`)
    .replace(
      /("description"\s*:\s*")تجربة مجانية[^"]*(")/,
      `$1تجربة مجانية 10 أيام بلا بطاقة ائتمان. الاشتراك شهري لكل شركة لا لكل مستخدم: ${pricing.arSummary}.$2`,
    );
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('لا يوجد dist/index.html — شغّل vite build أولاً'); process.exit(0); }
  let n = 0;

  // المقالات اليدوية (posts.ts ∪ CMS) — تُحمَّل مبكراً لتُستخدم في التصيير وفهرس المدوّنة
  const catalogSlugs = new Set(buildCatalog().map((x) => x.slug));
  const postsMod = await loadTs('blog/posts.ts');
  const manual = manualPostsFrom(postsMod, cms?.blog)
    .filter((p) => !catalogSlugs.has(p.slug)); // المولَّدة لها تصييرها الأغنى — لا تُدهس
  console.log(`  مقالات يدوية: ${manual.length} (اتحاد CMS ${Array.isArray(cms?.blog) ? cms.blog.length : 0} ومقالات المستودع)`);

  // الدمج (P3): المقال الرقيق المكرَّر يبقى حيّاً بمحتواه، وcanonical فيه يشير إلى المقال الغني
  const exists = existsWith(manual);
  const consolidation = consolidationReport(exists, (slug, L) => manual.some((p) => p.slug === slug && (L === 'ar' || !!p.en)));
  console.log(`  الدمج: ${consolidation.applied.length} نسخة مدموجة canonical إلى مقالها الغني`);
  for (const s of consolidation.skipped) console.log(`  دمج متجاهَل: ${s.lang} ${s.slug} ← ${s.target} (${s.why})`);

  // 1) المقالات المولَّدة (~966) — محتوى كامل + وسوم + JSON-LD
  for (const { slug, cc, canonical: canonSlug, isCanonical } of buildCatalog()) {
    for (const L of LANGS) {
      const a = getArticle(slug, L);
      if (!a) continue;
      const prefix = L === 'ar' ? '' : `/${L}`;
      // الدمج: صفحة دولة غير ذات أولوية تُشير إلى صفحتها الجامعة لتجميع إشارات الترتيب
      const canonical = canon(`${ORIGIN}${prefix}/blog/${canonSlug}`);
      const body = `<main><article><h1>${esc(a.title)}</h1><img src="${a.imagePath}" alt="${esc(a.title)}" width="1200" height="630"/>${a.contentHtml}</article></main>`;
      // تقليم الفهرسة: الإنجليزية لأسواق بلا طلب إنجليزي تبقى حيّة للزائر لكن noindex،
      // وتُستثنى من عنقود hreflang (صفحة noindex داخل عنقود = إشارة متناقضة لجوجل).
      const indexable = isIndexable(cc, L);
      const langs = isIndexable(cc, 'en') ? LANGS : LANGS.filter((x) => x !== 'en');
      const html = buildPage({
        // «| FieldSales» بدل «| مدوّنة FieldSales»، وتسقط إن جاوز العنوان بها 70 حرفاً (clusters.mjs، ومثله BlogPostPage)
        lang: L, title: blogTitle(a.title), description: a.description, keywords: a.keywords,
        canonical, image: a.image, ogType: 'article',
        // hreflang يُصدَر للصفحة الأساسية فقط — عنقود على صفحة مدموجة/noindex إشارة متناقضة
        hreflang: indexable && isCanonical ? hreflangFor(`/blog/${slug}`, langs) : '',
        robots: indexable ? '' : 'noindex, follow',
        jsonLd: articleJsonLd(a, L, canonical), bodyHtml: body,
      });
      writeRoute(`${prefix}/blog/${slug}`, html);
      n++;
    }
  }

  // 1ب) المقالات اليدوية (posts.ts / CMS) — عربية دائماً + إنجليزية للثنائية، بمحتوى كامل
  //     (كانت قوقعة SPA فارغة لزواحف AI وكاشطي التواصل رغم وجودها في sitemap)
  let faqPages = 0;
  let faqDropped = 0;
  // «اقرأ أيضاً» (P4): الخطة نفسها التي يحسبها BlogPostPage من الاتحاد نفسه — هبوط العنقود بمرساته الحرفية
  // وميزته، وأخوان من العنقود. المدموجة والكتالوج بلا كتلة.
  const related = { ar: relatedPlan(manual, exists, 'ar'), en: relatedPlan(manual, exists, 'en') };
  {
    const hits = new Map();
    for (const plan of Object.values(related)) for (const links of plan.values()) for (const l of links) hits.set(l.href, (hits.get(l.href) || 0) + 1);
    const top = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h, c]) => `${decodeURI(h)} ×${c}`).join('، ');
    console.log(`  «اقرأ أيضاً»: ${related.ar.size} مقالاً عربياً و${related.en.size} إنجليزياً (سقف ${RELATED_CAP} لكل هدف) — الأكثر: ${top}`);
  }
  const relatedHtml = (slug, L) => {
    const links = related[L === 'en' ? 'en' : 'ar'].get(slug) || [];
    if (!links.length) return '';
    return `<nav aria-label="${esc(RELATED_TITLE[L === 'en' ? 'en' : 'ar'])}"><h2>${esc(RELATED_TITLE[L === 'en' ? 'en' : 'ar'])}</h2><ul>`
      + links.map((l) => `<li><a href="${l.href}">${esc(l.anchor)}</a></li>`).join('') + '</ul></nav>';
  };
  for (const p of manual) {
    const langsOf = p.en ? ['ar', 'en'] : ['ar'];
    // عنقود hreflang بين النسخ غير المدموجة وحدها (مطابق للخريطة)؛ لغة واحدة ⇒ لا عنقود
    const live = langsOf.filter((L) => !consolidatedTarget(p.slug, L, exists));
    // dateModified = تاريخ المقال نفسه (updatedAt/modified/date) — المصدر نفسه لـlastmod في الخريطة
    const modified = postsMod.lastModifiedOf(p) || p.date;
    for (const L of langsOf) {
      const v = L === 'en' ? p.en : p;
      const prefix = L === 'ar' ? '' : '/en';
      const target = consolidatedTarget(p.slug, L, exists);
      // المدموج: canonical إلى الهدف بشرطة، وrobots يبقى index,follow، والمحتوى كما هو
      const canonical = target ? consolidatedUrl(target, L) : canon(`${ORIGIN}${prefix}/blog/${p.slug}`);
      const image = `${ORIGIN}/og-image.png`;
      const body = `<main><article><h1>${esc(v.title)}</h1>${v.contentHtml}</article>${relatedHtml(p.slug, L)}</main>`;
      // الأسئلة الظاهرة في المقال ← FAQPage، بلا نفي قديم ولا وعد «دون اتصال» غير مقيَّد (extractFaq.mjs)
      const faq = extractFaqDetailed(v.contentHtml, { problem: faqProblem });
      if (faq.kept.length) faqPages++;
      faqDropped += faq.dropped.length;
      const html = buildPage({
        lang: L, title: blogTitle(v.title), description: v.description, keywords: v.keywords,
        canonical, image, ogType: 'article',
        hreflang: target ? '' : hreflangFor(`/blog/${p.slug}`, live),
        jsonLd: articleJsonLd({ title: v.title, description: v.description, date: p.date, modified, image, faq: faq.kept }, L, canonical),
        bodyHtml: body,
      });
      writeRoute(`${prefix}/blog/${p.slug}`, html);
      n++;
    }
  }
  console.log(`  FAQPage في ${faqPages} صفحة مقال يدوي (أُسقط ${faqDropped} زوجاً: نفي قديم أو وعد «دون اتصال» غير مقيَّد)`);

  // 2) فهارس المدوّنة (ع/إ/فر) — وسوم + قائمة روابط للمقالات (زحف داخلي)
  for (const L of LANGS) {
    const prefix = L === 'ar' ? '' : `/${L}`;
    const canonical = canon(`${ORIGIN}${prefix}/blog`);
    const title = tr(L, 'المدوّنة | FieldSales — مقالات المبيعات الميدانية والتوزيع في الدول العربية',
      'Blog | FieldSales — Field Sales & Distribution Articles across Arab Countries',
      'Blog | FieldSales — Articles sur la vente terrain et la distribution dans les pays arabes');
    const desc = tr(L, 'مئات المقالات والدلائل في إدارة المبيعات الميدانية والفوترة الإلكترونية والتوزيع لكل الدول العربية.',
      'Hundreds of guides on field sales, e-invoicing and distribution for every Arab country.',
      'Des centaines de guides sur la vente terrain, la facturation électronique et la distribution pour chaque pays arabe.');
    // المدموجة (P3) لا تُربط من الفهرس — كالصفحات غير القانونية من الكتالوج أدناه
    const manualLinks = L === 'fr' ? [] : manual
      .filter((p) => (L === 'ar' || p.en) && !consolidatedTarget(p.slug, L, exists))
      .map((p) => { const v = L === 'en' && p.en ? p.en : p; return `<li><a href="${prefix}/blog/${p.slug}/">${esc(v.title)}</a></li>`; });
    // كل مقال قانونيّ (يدخل الخريطة) يجب أن يُربَط من المحور مباشرةً — إزالة سقف 80 الذي كان
    // يترك 96 صفحة قانونية بلا رابط من الفهرس (يتيمة ⇒ تعلق في «اكتُشفت — لم تُفهرَس بعد»).
    // نربط القانونيّة فقط (لا نضخّم الصفحات المدموجة)، وبترتيب الأحدث الذي يوفّره listArticles.
    const canonSet = new Set(buildCatalog().filter((a) => a.isCanonical && isIndexable(a.cc, L)).map((a) => a.slug));
    const seoLinks = listArticles(L).filter((x) => canonSet.has(x.slug)).map((x) => `<li><a href="${prefix}/blog/${x.slug}/">${esc(x.title)}</a></li>`);
    const links = [...manualLinks, ...seoLinks].join('');
    const chips = COUNTRIES.map((c) => `<a href="${prefix}/blog/field-sales-software-${c.code.toLowerCase()}/">${esc(c[L])}</a>`).join(' ');
    const body = `<main><h1>${esc(tr(L, 'مدوّنة FieldSales', 'FieldSales Blog', 'Blog FieldSales'))}</h1><nav>${chips}</nav><ul>${links}</ul></main>`;
    const html = buildPage({ lang: L, title, description: desc, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang('/blog'), bodyHtml: body });
    writeRoute(`${prefix}/blog`, html);
    n++;
  }

  // 3) الرئيسيات المترجمة (إنجليزي/فرنسي/تركي/صيني) — وسوم + محتوى دلالي (زواحف AI لا تُشغّل JavaScript)
  //
  // الإنجليزية (P7): كانت 202 كلمة بلا أسعار ولا ربط ولا حدود العمل دون اتصال. الأسئلة من المصدر الذي
  // يعرضه LandingPage على /en/ (defaultContentEn.faq) مصفّاةً بالقواعد نفسها، وFAQPage لها في كتلة القالب
  // (templateLd) كي لا تختفي بعد الإقلاع. وسطر الأسعار من باقات CMS (enPriceLine).
  // أدلّة السعودية من صفحات الكتالوج القانونية: مقالات CMS الإنجليزية (sales-rep-tracking-saudi وvan-sales-software-saudi
  // وdms-saudi-arabia وorder-to-cash-cycle) ما زالت تقول «Phase 2 not built»، والصفحة نفسها تعلن الربط. تعود بعد تنظيف CMS.
  const homeEnDefaults = await loadTs('landing/defaultContentEn.ts', 'defaultContentEn').catch((e) => {
    console.log('⚠️  تعذّر تحميل محتوى الرئيسية الإنجليزية (غير مانع): ' + e.message);
    return null;
  });
  const enFaq = publishableFaq(homeEnDefaults?.faq?.items || [], { problem: faqProblem });
  for (const d of enFaq.dropped) console.log(`  ⚠️ سؤال في أسئلة الرئيسية الإنجليزية خارج FAQPage [${d.why}]: ${d.q}`);
  const enFaqHtml = enFaq.kept.length
    ? `<h2>${esc(homeEnDefaults?.faq?.title || 'Frequently asked questions')}</h2>\n` + enFaq.kept.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('\n')
    : '';
  const enLine = enPriceLine(pricing.plans);
  const homeMeta = {
    en: {
      title: 'FieldSales | Field Sales & Distribution Management Software for Arab Markets',
      desc: 'Arabic-first field sales system for distributors across Saudi Arabia, Egypt and the Arab world: tax invoices, collection, van stock and rep tracking. Free 10-day trial.',
      templateLd: enFaq.kept.length ? [faqPageNode(enFaq.kept)] : [],
      body: `<main><h1>FieldSales — field sales &amp; distribution management for Arab markets</h1>
<p>FieldSales is a cloud platform for distribution companies that sell through field reps. Reps issue invoices and receipts with a QR code from their phones, print them on a thermal printer, collect payments and manage their van stock, while managers see sales, collections, receivables and every rep’s route on one dashboard.</p>
<p>It is built Arabic-first, with English and French interfaces, for distributors of food, beverages and consumer goods across the Arab world.</p>
<ul><li>Field invoicing with QR code and thermal printing</li><li>Collection, receivables and customer statements with credit limits</li><li>Van stock per rep with live variance detection</li><li>GPS rep tracking and route planning</li><li>Product catalog, price tiers and ERP integration</li></ul>
<h2>E-invoicing in Saudi Arabia</h2>
<p>FieldSales supports Phase 2 integration with ZATCA’s Fatoora platform.</p>
<p>For Saudi companies with the integration enabled, invoices (standard and simplified) and returns need a connection at the moment of issuance, while receipts and visit logging still work offline. <a href="/en/blog/einvoicing-compliance-sa/">E-invoicing and tax compliance in Saudi Arabia</a></p>
<h2>Pricing</h2>
<p>Priced per company, not per user${enLine ? `: ${esc(enLine)}` : ''}. No setup fees, and a free trial without a credit card. <a href="/en/pricing/">See pricing details</a></p>
${enFaqHtml}
<h2>Contact &amp; subscription requests</h2>
<p>Official email: <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · Head office: Riyadh, Saudi Arabia · <a href="/en/subscribe-request/">Submit a subscription request</a> or <a href="/signup">start the free trial</a> directly.</p>
<p><a href="/signup">Start your free 10-day trial</a> — no credit card required. <a href="/en/blog">Read the blog</a> · <a href="/en/pricing/">Pricing</a> · <a href="/en/about">About</a> · <a href="/en/contact">Contact</a> · <a href="/en/terms/">Terms</a> · <a href="/en/privacy/">Privacy</a> · <a href="/en/service-agreement/">Service agreement</a></p>
<p>Guides for Saudi distribution: <a href="/en/blog/sales-rep-management-sa/">Sales rep management in Saudi Arabia</a> · <a href="/en/blog/van-sales-app-sa/">Van sales app for Saudi Arabia</a> · <a href="/en/blog/distribution-management-system-sa/">Distributor management system (DMS) in Saudi Arabia</a> · <a href="/en/blog/field-sales-software-sa/">Field sales management software for Saudi Arabia</a> · <a href="/en/blog/collection-receivables-sa/">Collection and receivables in Saudi Arabia</a></p>
<p>By topic: <a href="/en/blog/mobile-field-invoicing/">offline field sales app</a> · <a href="/en/blog/fmcg-distribution/">trade marketing and distribution</a> · <a href="/en/blog/wholesale-food-distributors/">dairy distribution</a> · <a href="/en/blog/van-sales-app/">van sales app</a> · <a href="/en/blog/collection-receivables/">collection and receivables</a></p></main>`,
    },
    fr: {
      title: 'FieldSales | Logiciel de gestion des ventes terrain et distribution',
      desc: 'Système de vente terrain pour les distributeurs en Arabie saoudite, en Égypte et dans le monde arabe : factures, encaissement, stock et suivi. Essai gratuit 10 jours.',
      body: `<main><h1>FieldSales — gestion des ventes terrain et de la distribution pour les marchés arabes</h1>
<p>FieldSales est une plateforme SaaS pour les entreprises de distribution : les commerciaux émettent des factures structurées à code QR, encaissent les paiements et gèrent le stock du véhicule depuis une application mobile, tandis que les gérants disposent de tableaux de bord en direct, du suivi GPS et de rapports. Disponible en arabe, anglais et français dans les 22 pays arabes.</p>
<ul><li>Facturation terrain avec code QR et impression thermique</li><li>Encaissement, créances et relevés clients avec limites de crédit</li><li>Stock du véhicule par commercial avec détection des écarts</li><li>Suivi GPS et planification des tournées</li><li>Catalogue produits, grilles tarifaires et intégration ERP</li></ul>
<h2>Contact et demandes d'abonnement</h2>
<p>E-mail officiel : <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · Siège social : Arabie saoudite · <a href="/fr/subscribe-request/">Envoyez une demande d'abonnement</a> ou <a href="/signup">commencez l'essai gratuit</a>.</p>
<p><a href="/signup">Essai gratuit de 10 jours</a> — sans carte bancaire. <a href="/fr/blog">Blog</a> · <a href="/fr/pricing/">Tarifs</a> · <a href="/fr/invoice-generator/">Générateur de factures gratuit</a> · <a href="/fr/about">À propos</a> · <a href="/fr/contact">Contact</a> · <a href="/fr/terms/">Conditions</a> · <a href="/fr/privacy/">Confidentialité</a> · <a href="/fr/service-agreement/">Accord de service</a></p>
<p>Par thème : <a href="/fr/blog/collection-receivables/">recouvrement de créances</a> · <a href="/fr/blog/collection-receivables-eg/">recouvrement de créances en Égypte</a> · <a href="/fr/blog/van-sales-app/">application van sales</a> · <a href="/fr/blog/collection-receivables-sa/">recouvrement de créances en Arabie saoudite</a> · <a href="/fr/blog/distribution-management-system/">système de gestion de la distribution</a></p></main>`,
    },
    tr: {
      title: 'FieldSales | Saha Satış ve Dağıtım Yönetim Yazılımı',
      desc: 'Suudi Arabistan Mısır ve Arap dünyasındaki dağıtımcılar için saha satış sistemi: vergi faturaları tahsilat araç stoku ve GPS takibi. 10 gün ücretsiz deneme.',
      body: `<main><h1>FieldSales — Arap pazarları için saha satış ve dağıtım yönetimi</h1>
<p>FieldSales dağıtım şirketleri için bir SaaS platformudur: saha temsilcileri mobil uygulamadan QR kodlu yapılandırılmış vergi faturaları keser, tahsilat yapar ve araç stokunu yönetir; yöneticiler canlı panolar, GPS takibi ve raporlar alır. Arapça, İngilizce, Fransızca ve Türkçe olarak 22 Arap ülkesinde kullanılabilir.</p>
<ul><li>QR kodlu saha faturalama ve termal yazdırma</li><li>Tahsilat, cari hesap ve kredi limitli müşteri ekstreleri</li><li>Temsilci başına araç stoku ve canlı fark tespiti</li><li>GPS temsilci takibi ve rota planlama</li><li>Ürün kataloğu, fiyat listeleri ve ERP entegrasyonu</li></ul>
<h2>İletişim ve abonelik talepleri</h2>
<p>Resmi e-posta: <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · Merkez: Suudi Arabistan · <a href="/tr/subscribe-request/">Abonelik talebi gönderin</a> veya <a href="/signup">ücretsiz denemeyi başlatın</a>.</p>
<p><a href="/signup">10 günlük ücretsiz deneme</a> — kredi kartı gerekmez. <a href="/en/blog">Blog (İngilizce)</a> · <a href="/en/about/">Hakkında (İngilizce)</a> · <a href="/en/contact/">İletişim (İngilizce)</a></p></main>`,
    },
    zh: {
      title: 'FieldSales | 外勤销售与分销管理软件',
      desc: '面向沙特、埃及及阿拉伯世界分销商的外勤销售系统：增值税发票、收款、车载库存与业务员 GPS 追踪。免费试用 10 天。',
      body: `<main><h1>FieldSales — 面向阿拉伯市场的外勤销售与分销管理</h1>
<p>FieldSales 是一套面向分销企业的 SaaS 平台：业务员通过手机应用开具带二维码的结构化增值税发票、完成收款并管理车载库存；管理者则获得实时看板、GPS 追踪与报表。支持阿拉伯语、英语、法语、土耳其语和中文，覆盖 22 个阿拉伯国家。</p>
<ul><li>带二维码的外勤开票与热敏打印</li><li>收款、应收账款与带信用额度的客户对账单</li><li>按业务员划分的车载库存与实时差异检测</li><li>业务员 GPS 追踪与路线规划</li><li>产品目录、价格体系与 ERP 集成</li></ul>
<h2>联系我们与订阅申请</h2>
<p>官方邮箱：<a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · 总部：沙特阿拉伯 · <a href="/zh/subscribe-request/">提交订阅申请</a>或直接<a href="/signup">开始免费试用</a>。</p>
<p><a href="/signup">立即开始 10 天免费试用</a> — 无需信用卡。<a href="/en/blog">博客（英文）</a> · <a href="/en/about/">关于我们（英文）</a> · <a href="/en/contact/">联系我们（英文）</a></p></main>`,
    },
  };
  // الرئيسية المترجمة: hreflang خماسي (ع/إ/فر/تر/صيني) — للتسويق فقط، والمدونة تبقى ثلاثية
  const marketingHreflang = hreflangFor('/', [...LANGS, 'tr', 'zh']);
  for (const L of ['en', 'fr', 'tr', 'zh']) {
    const canonical = canon(`${ORIGIN}/${L}`);
    const html = buildPage({ lang: L, title: homeMeta[L].title, description: homeMeta[L].desc, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: marketingHreflang, bodyHtml: homeMeta[L].body, templateLd: homeMeta[L].templateLd || [] });
    writeRoute(`/${L}`, html);
    n++;
  }

  // بيانات منظّمة للأدوات المجانية (WebApplication + FAQPage) — تُحقن في صفحتيهما الثابتتين لنتائج غنية وGEO
  const toolJsonLd = (L, name, url, faq) => ({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebApplication', name, url, applicationCategory: 'BusinessApplication', operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@type': 'Organization', name: 'FieldSales', url: ORIGIN }, inLanguage: L },
      { '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    ],
  });
  const faqHtml = (title, faq) => `<h2>${title}</h2>` + faq.map((f) => `<h3>${f.q}</h3><p>${f.a}</p>`).join('');
  const CALC_FAQ = {
    ar: [
      { q: 'كم تخسر شركات التوزيع بالإدارة الورقية؟', a: 'الشركات التي تدير مناديبها بالورق أو الواتساب تسرّب عادةً 3-6% من إيراداتها بين فواتير مفقودة وأخطاء تسعير وتحصيل نقدي غير موثّق وعجز مخزون سيارات المناديب ووقت ضائع في الإدخال اليدوي.' },
      { q: 'هل حاسبة تسريب الإيرادات مجانية؟', a: 'نعم — مجانية بالكامل وتعمل في المتصفح بلا تسجيل، ويمكن مشاركة النتيجة عبر واتساب.' },
    ],
    en: [
      { q: 'How much revenue do distributors lose with paper-based management?', a: 'Companies running field reps on paper or WhatsApp typically leak 3-6% of revenue through lost invoices, pricing errors, undocumented cash collections, van stock shrinkage and manual-entry time.' },
      { q: 'Is the revenue leak calculator free?', a: 'Yes — completely free, in-browser, no signup, and the result can be shared on WhatsApp.' },
    ],
    fr: [
      { q: 'Combien perdent les distributeurs avec une gestion papier ?', a: 'Les entreprises gérant leurs commerciaux sur papier ou WhatsApp perdent généralement 3 à 6 % du chiffre d’affaires (factures perdues, encaissements non documentés, écarts de stock).' },
      { q: 'Le calculateur est-il gratuit ?', a: 'Oui — entièrement gratuit, dans le navigateur, sans inscription.' },
    ],
  };
  /**
   * ⚠️ مصدر مزدوج — انتبه: عناوين/أوصاف/أسئلة الصفحات التعريفية والأدوات مكتوبة **هنا** أيضاً،
   * منفصلةً عن مكوّنات React (مثل src/pages/InvoiceGeneratorPage.tsx وحاسبة التسريب).
   * **جوجل وكاشطو التواصل يقرؤون نسخة هذا الملف** (HTML الثابت)، لا نسخة المكوّن التي تظهر بعد إقلاع React.
   * ⇒ أي تعديل SEO على صفحة أداة/تعريف يجب تطبيقه في **الموضعين**، وإلا ظلّ غير مرئي لمحركات البحث.
   * (اكتُشف 2026-07-25: تعديل عنوان المولّد في المكوّن وحده لم يصل لجوجل إطلاقاً.)
   */
  const INVGEN_FAQ = {
    ar: [
      { q: 'كيف أعمل فاتورة ضريبية برمز QR مجاناً؟', a: 'أدخل بيانات شركتك وعميلك وبنود الفاتورة في مولّد FieldSales المجاني، فيبني فوراً فاتورة ضريبية احترافية ثنائية اللغة برمز QR متوافق مع هيئة الزكاة والضريبة والجمارك ZATCA، وتحمّلها PDF أو تطبعها بلا تسجيل.' },
      { q: 'ما الفرق بين الفاتورة الضريبية والمبسطة؟', a: 'الفاتورة الضريبية المبسطة تُصدر للمستهلك (B2C) بلا رقم ضريبي للمشتري، والفاتورة الضريبية العادية (B2B) تتضمن الرقم الضريبي للمشتري — والمولّد يبدّل بينهما تلقائياً.' },
      { q: 'ما الدول المدعومة؟', a: 'نِسب الضريبة والعملات جاهزة لـ12 دولة عربية: السعودية 15%، مصر 14%، الإمارات 5%، البحرين 10%، عُمان 5%، الأردن 16%، المغرب 20%، الجزائر وتونس 19% وغيرها — وكلها قابلة للتعديل.' },
      { q: 'هل هذا برنامج محاسبة مجاني؟', a: 'هذه أداة فوترة مجانية بالكامل وبلا تسجيل: تُنشئ فاتورة ضريبية نظامية برمز QR وتحمّلها PDF. لكنها ليست برنامج محاسبة كاملاً — لا تتضمّن دفتر أستاذ ولا قوائم مالية ولا إقرارات ضريبية. إن كان ما تحتاجه إصدار فواتير نظامية فقط فهذه الأداة تكفيك مجاناً بلا اشتراك؛ وإن كنت تبحث عن محاسبة كاملة فستحتاج برنامج محاسبة متخصّصاً.' },
      { q: 'هل أحتاج اشتراكاً أو بطاقة لاستخدام المولّد؟', a: 'لا. المولّد مجاني بالكامل بلا تسجيل ولا بطاقة ولا حدّ لعدد الفواتير. أما منصّة FieldSales لإدارة مناديب التوزيع (فواتير من الميدان، تحصيل، مخزون سيارة، تتبّع) فهي منتج مدفوع بتجربة مجانية 10 أيام دون بطاقة.' },
    ],
    en: [
      { q: 'How do I create a tax invoice with a QR code for free?', a: 'Enter your company, customer and items in the free FieldSales generator — it instantly builds a professional bilingual tax invoice with a ZATCA-compliant QR code, downloadable as PDF, no signup.' },
      { q: 'What is the difference between a tax invoice and a simplified tax invoice?', a: 'A simplified tax invoice (B2C) omits the buyer’s VAT number; a standard tax invoice (B2B) includes it. The generator switches automatically.' },
      { q: 'Which countries are supported?', a: 'VAT rates and currencies for 12 Arab countries are preset (Saudi 15%, Egypt 14%, UAE 5%, Bahrain 10%, Jordan 16%, Morocco 20%...) and fully editable.' },
    ],
    fr: [
      { q: 'Comment créer gratuitement une facture fiscale avec code QR ?', a: 'Saisissez votre entreprise, votre client et les lignes dans le générateur gratuit FieldSales — il crée une facture fiscale bilingue avec code QR conforme ZATCA, téléchargeable en PDF, sans inscription.' },
      { q: 'Quels pays sont pris en charge ?', a: 'Les taux de TVA et devises de 12 pays arabes sont préconfigurés et modifiables.' },
    ],
  };

  // 4) الصفحات التعريفية (about/contact/قانونية) × 3 لغات — وسوم + ملخّص دلالي يقرؤه الزاحف،
  //    وReact يستبدله بالنص الكامل عند التحميل. (الرئيسية العربية تبقى dist/index.html — هي fallback الـSPA)
  // صفحة التسعير — مُصيَّرة بأسعار الـCMS الحيّة وبسكيما Product+Offer+FAQPage.
  // بلا تصيير تفقد الصفحة سبب وجودها: استعلامات «كم سعر…» يجيبها الزاحف لا المتصفّح.
  // الأسئلة والسكيما من src/blog/extractFaq.mjs — المصدر نفسه الذي يعرضه PricingPage بعد الإقلاع،
  // فلا تبقى في FAQPage أسئلة تختفي من الصفحة بعد تحميل React. Product بمعرّف واحد للغات الثلاث.
  const pricingLd = (L) => pricingJsonLd(L, pricing.plans, canon(`${ORIGIN}${L === 'ar' ? '' : '/' + L}/pricing`));
  const pricingFaqHtml = (L) => {
    const faq = pricingFaq(L, pricing.plans);
    if (!faq.length) return '';
    return `<h2>${esc(tr(L, 'أسئلة عن التسعير', 'Pricing questions', 'Questions sur les tarifs'))}</h2>`
      + faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('');
  };

  /**
   * جدول الباقات بلغة الصفحة.
   *
   * العطل الذي يُصلحه: أسماء الباقات وحدودها تعيش في الـCMS بالعربية وحدها، وكان
   * الجدول نفسه يُحقن في الصفحات الثلاث — فقرأ الزاحفُ الإنجليزيّ «المبتدئة … حتى ٥
   * مناديب» داخل صفحة إنجليزية، وهي أوّل ما يقرؤه عن تسعيرنا. الحلّ الجذري حقول
   * en/fr للباقات في الـCMS؛ وحتى تُضاف نترجم الاسم بمفتاح السعر ونشتقّ الحدّ رقماً.
   * أي باقة بسعر غير معروف تسقط إلى اسم الـCMS كما هو — أفضل من إخفائها.
   */
  const PLAN_I18N = {
    '299': { en: 'Starter', fr: 'Débutant' },
    '399': { en: 'Growth', fr: 'Croissance' },
    '599': { en: 'Professional', fr: 'Professionnel' },
  };
  const planRowsFor = (lang) =>
    pricing.plans
      .map((p) => {
        const isNum = /^\d+$/.test(String(p.price));
        const name = lang === 'ar' ? p.name : PLAN_I18N[String(p.price)]?.[lang] || p.name;
        const price = `${esc(p.price)}${isNum ? (lang === 'ar' ? ' ر.س' : ' SAR') : ''}`;
        const cap = repsCap(p.limit);
        const limit =
          lang === 'ar' || !cap
            ? esc(p.limit || '')
            : lang === 'fr'
              ? `Jusqu'à ${cap} commerciaux`
              : `Up to ${cap} reps`;
        return `<tr><td>${esc(name)}</td><td>${price}</td><td>${limit}</td></tr>`;
      })
      .join('');

  // النصّ الكامل لسياسة الخصوصية (انظر loadPrivacyHtml) — تعذّر التحميل ⇒ الملخّص القصير أدناه
  const privacyHtml = await loadPrivacyHtml().catch((e) => {
    console.log('⚠️  تعذّر تحميل نصّ سياسة الخصوصية (غير مانع): ' + e.message);
    return null;
  });

  // أقسام مشتركة مع React (clusters.mjs): {h2, paras, items, sub:[{h3,p}], links, link} ⇒ HTML
  const sectionsHtml = (sections) => (sections || []).map((s) => `<h2>${esc(s.h2)}</h2>`
    + (s.paras || []).map((p) => `<p>${esc(p)}</p>`).join('')
    + (s.items && s.items.length ? `<ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '')
    + (s.sub || []).map((x) => `<h3>${esc(x.h3)}</h3><p>${esc(x.p)}</p>`).join('')
    + (s.links && s.links.length
      ? `<p>${s.links.map((l) => `<a href="${esc(l.href)}"${/^https?:/.test(l.href) ? ' rel="noopener"' : ''}>${esc(l.label)}</a>`).join(' · ')}</p>`
      : '')
    + (s.link ? `<p><a href="${esc(s.link.href)}">${esc(s.link.label)}</a></p>` : '')).join('\n');

  // حدّ أعلى باقة رقمية من CMS — كان «فوق ${high === 599 ? '٢٠' : high}»: لو تغيّر أعلى سعر لكُتب السعر عدداً للمناديب
  const topCap = (() => {
    const numeric = pricing.plans.filter((p) => /^\d+$/.test(String(p.price))).sort((a, b) => Number(a.price) - Number(b.price));
    return numeric.length ? repsCap(numeric[numeric.length - 1].limit) : null;
  })();
  const phase2Html = (L) => { const l = phase2LinkFor(L); return `<p><a href="${l.href}">${esc(l.label)}</a></p>`; };

  // عن المنصة (P7): الحقائق من كيان Organization والأسعار من CMS، والمصدر نفسه يعرضه InfoPage تحت نصّ الصفحة.
  // سنة التأسيس أول الصفحة وجملة الربط في قسم بعيد عنها (تصحيح الناقد 8).
  const about = {
    ar: aboutContent('ar', { priceLine: pricing.arSummary }),
    en: aboutContent('en', { priceLine: enLine }),
    fr: aboutContent('fr', { priceLine: frPriceLine(pricing.plans) }),
  };

  const INFO = {
    pricing: {
      ar: {
        t: pricingTitle('ar'),
        // ١٥٠ حرفاً أو أقل بالأرقام الثلاثة من CMS — كان ٢٣٤ حرفاً يقصّه جوجل (مطابق لـPricingPage)
        d: pricingDescription('ar', pricing.plans),
        j: pricingLd('ar'),
        b: `<h1>أسعار Field Sales — معلنة وبلا رسوم خفية</h1>
<p>السعر <strong>لكل شركة لا لكل مستخدم</strong>: إضافة مندوب ضمن حدّ باقتك لا تزيد فاتورتك الشهرية. بلا رسوم تأسيس، وبلا التزام سنوي، وتجربة عشرة أيام دون بطاقة ائتمان.</p>
<table><caption>باقات Field Sales</caption><thead><tr><th>الباقة</th><th>السعر شهرياً</th><th>الحدّ</th></tr></thead><tbody>${planRowsFor('ar')}</tbody></table>
<p>${topCap ? `فوق ${topCap} مندوباً نحدّد السعر بالمحادثة حسب حجمك` : 'للفرق الأكبر نحدّد السعر بالمحادثة حسب حجمك'} — <a href="${waHref}" rel="noopener">تحدّث معنا على واتساب</a> أو <a href="/signup">ابدأ التجربة المجانية</a>.</p>
${sectionsHtml(pricingSections('ar', pricing.plans))}
<h2>ما نملكه وما لا نملكه — بصراحة</h2>
<p>ندعم الفاتورة الإلكترونية برمز QR، وندعم <strong>ربط المرحلة الثانية</strong> مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات فلا ندّعي اعتماداً منها، وليست لدينا شهادات SOC2 أو ISO.</p>
${phase2Html('ar')}
${pricingFaqHtml('ar')}`,
      },
      en: {
        t: pricingTitle('en'),
        d: pricingDescription('en', pricing.plans),
        j: pricingLd('en'),
        b: `<h1>Field Sales pricing — published, with no hidden fees</h1>
<p>Priced <strong>per company, not per user</strong>: ${pricing.enSummary} per month. No setup fees, no annual lock-in, and a 10-day trial without a credit card.</p>
<table><caption>Field Sales plans</caption><thead><tr><th>Plan</th><th>Monthly</th><th>Limit</th></tr></thead><tbody>${planRowsFor('en')}</tbody></table>
<p>${topCap ? `Above ${topCap} reps we price in conversation` : 'For larger teams we price in conversation'} — <a href="${waHref}" rel="noopener">talk to us on WhatsApp</a> or <a href="/signup">start the free trial</a>.</p>
${sectionsHtml(pricingSections('en', pricing.plans))}
<h2>What we have and do not have — plainly</h2>
<p>We support <strong>Phase 2 integration</strong> with ZATCA’s Fatoora platform. ZATCA does not certify software vendors, so we claim no approval. We hold no SOC2 or ISO certification.</p>
${phase2Html('en')}
${pricingFaqHtml('en')}`,
      },
      fr: {
        t: pricingTitle('fr'),
        d: pricingDescription('fr', pricing.plans),
        j: pricingLd('fr'),
        b: `<h1>Tarifs Field Sales — publiés, sans frais cachés</h1>
<p>Facturation <strong>par entreprise, pas par utilisateur</strong> : ${pricing.enSummary} par mois. Sans frais de mise en service ni engagement annuel, avec un essai de 10 jours sans carte bancaire.</p>
<table><caption>Offres Field Sales</caption><thead><tr><th>Offre</th><th>Par mois</th><th>Limite</th></tr></thead><tbody>${planRowsFor('fr')}</tbody></table>
<p>${topCap ? `Au-delà de ${topCap} commerciaux, le prix se définit en conversation` : 'Pour les équipes plus grandes, le prix se définit en conversation'} — <a href="${waHref}" rel="noopener">discutez avec nous</a>.</p>
${sectionsHtml(pricingSections('fr', pricing.plans))}
<h2>Ce que nous avons et n’avons pas — clairement</h2>
<p>Nous prenons en charge <strong>l’intégration phase 2</strong> avec la plateforme Fatoora de la ZATCA. La ZATCA ne certifie aucun éditeur ; nous ne revendiquons aucune homologation.</p>
${phase2Html('fr')}
${pricingFaqHtml('fr')}`,
      },
    },
    about: {
      ar: { t: about.ar.title, d: about.ar.description,
        b: `<h1>عن منصّة FieldSales</h1><p>FieldSales منصّة سحابية عربية لإدارة المبيعات الميدانية والتوزيع: فواتير ضريبية منظّمة من الميدان، تحصيل وكشوف حساب، مخزون سيارة المندوب، تتبّع GPS، وتقارير لحظية — لشركات التوزيع في الدول العربية بواجهة عربية أصلية ودعم للإنجليزية والفرنسية.</p>\n${sectionsHtml(about.ar.sections)}` },
      en: { t: about.en.title, d: about.en.description,
        b: `<h1>About FieldSales</h1><p>FieldSales is an Arabic-first SaaS platform for field sales and distribution: structured tax invoices from the field, collection and statements, van stock, GPS tracking and live reports — serving distributors across the Arab world in Arabic, English and French.</p>\n${sectionsHtml(about.en.sections)}` },
      fr: { t: about.fr.title, d: about.fr.description,
        b: `<h1>À propos de FieldSales</h1><p>FieldSales est une plateforme SaaS pour la vente terrain et la distribution : factures structurées, encaissement et relevés, stock du véhicule, suivi GPS et rapports en direct — au service des distributeurs du monde arabe, en arabe, anglais et français.</p>\n${sectionsHtml(about.fr.sections)}` },
    },
    contact: {
      ar: { t: 'تواصل مع فيلد سيلز – نظام إدارة المناديب | FieldSales', d: 'تواصل مع فريق FieldSales للاستفسارات والمبيعات والدعم الفني.',
        b: '<h1>تواصل معنا</h1><p>للاستفسارات والمبيعات: <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · للدعم الفني: <a href="mailto:help@fieldsa.net">help@fieldsa.net</a> · أو ابدأ <a href="/signup">تجربتك المجانية 10 أيام</a> مباشرةً.</p>' },
      en: { t: 'Contact | FieldSales', d: 'Contact the FieldSales team for sales, questions and technical support.',
        b: '<h1>Contact us</h1><p>Sales and questions: <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · Support: <a href="mailto:help@fieldsa.net">help@fieldsa.net</a> · or start your <a href="/signup">free 10-day trial</a> directly.</p>' },
      fr: { t: 'Contact | FieldSales', d: 'Contactez l\'équipe FieldSales pour les ventes, les questions et le support.',
        b: '<h1>Contactez-nous</h1><p>Ventes et questions : <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · Support : <a href="mailto:help@fieldsa.net">help@fieldsa.net</a> · ou commencez votre <a href="/signup">essai gratuit de 10 jours</a>.</p>' },
    },
    calculator: {
      ar: { t: 'حاسبة تسريب الإيرادات لشركات التوزيع | FieldSales', d: 'أداة مجانية: احسب كم تخسر شركة التوزيع شهرياً من فواتير مفقودة وتحصيل غير موثّق وعجز مخزون سيارات المناديب.',
        b: '<h1>حاسبة تسريب الإيرادات</h1><p>أداة مجانية لشركات التوزيع: أدخل عدد مناديبك وفواتيرك اليومية ونسبة البيع النقدي، واحصل فوراً على تقدير لما تخسره شهرياً وسنوياً بسبب الفواتير المفقودة وأخطاء التسعير، والتحصيل النقدي غير الموثّق، وعجز مخزون سيارات المناديب، والوقت الضائع في الإدخال اليدوي. الشركات التي تدير مناديبها بالورق والواتساب تسرّب عادةً 3-6% من إيراداتها. <a href="/calculator">جرّب الحاسبة الآن</a> أو <a href="/signup">ابدأ تجربة FieldSales المجانية</a>.</p>' + faqHtml('أسئلة شائعة', CALC_FAQ.ar), j: toolJsonLd('ar', 'حاسبة تسريب الإيرادات', ORIGIN + '/calculator', CALC_FAQ.ar) },
      en: { t: 'Revenue Leak Calculator for Distributors | FieldSales', d: 'Free tool: calculate how much your distribution company loses monthly to lost invoices, undocumented collections and van stock shrinkage.',
        b: '<h1>Revenue Leak Calculator</h1><p>A free tool for distribution companies: enter your reps, daily invoices and cash share to instantly estimate what you lose monthly and yearly to lost invoices, pricing errors, undocumented cash collections, van stock shrinkage and manual-entry time. Paper-and-WhatsApp operations typically leak 3-6% of revenue. <a href="/en/calculator">Try the calculator</a> or <a href="/signup">start your free FieldSales trial</a>.</p>' + faqHtml('FAQ', CALC_FAQ.en), j: toolJsonLd('en', 'Revenue Leak Calculator', ORIGIN + '/en/calculator', CALC_FAQ.en) },
      fr: { t: 'Calculateur de fuite de revenus pour distributeurs | FieldSales', d: 'Outil gratuit : calculez ce que votre entreprise de distribution perd chaque mois (factures perdues, encaissements non documentés, écarts de stock).',
        b: '<h1>Calculateur de fuite de revenus</h1><p>Un outil gratuit pour les entreprises de distribution : saisissez vos commerciaux, factures quotidiennes et part d’espèces pour estimer instantanément vos pertes mensuelles et annuelles (factures perdues, erreurs de prix, encaissements non documentés, écarts de stock, temps de saisie). Les opérations papier/WhatsApp fuient généralement 3 à 6 % du chiffre d’affaires. <a href="/fr/calculator">Essayez le calculateur</a> ou <a href="/signup">commencez votre essai gratuit</a>.</p>' + faqHtml('FAQ', CALC_FAQ.fr), j: toolJsonLd('fr', 'Calculateur de fuite de revenus', ORIGIN + '/fr/calculator', CALC_FAQ.fr) },
    },
    'invoice-generator': {
      ar: { t: 'برنامج فواتير مجاني بلا تسجيل — مولّد فاتورة ضريبية برمز QR | FieldSales', d: 'برنامج فواتير مجاني بالكامل وبلا تسجيل: أنشئ فاتورة ضريبية احترافية برمز QR متوافق مع ZATCA وحمّلها PDF خلال ثوانٍ.',
        b: '<h1>مولّد الفاتورة الضريبية المجاني</h1><p>أداة مجانية بالكامل تعمل في متصفحك: أدخل بيانات شركتك وعميلك وبنود الفاتورة، فتحصل فوراً على فاتورة ضريبية (أو مبسطة) احترافية ثنائية اللغة برمز QR متوافق مع متطلبات هيئة الزكاة والضريبة والجمارك ZATCA، وحمّلها PDF أو اطبعها — بلا تسجيل وبلا حدود. تدعم ضرائب وعملات 12 دولة عربية. <a href="/invoice-generator">أنشئ فاتورتك الآن</a>، وجرّب أيضاً <a href="/calculator">حاسبة تسريب الإيرادات</a> أو <a href="/signup">أصدرها تلقائياً من جوال مندوبك مع FieldSales</a>.</p>' + faqHtml('أسئلة شائعة', INVGEN_FAQ.ar), j: toolJsonLd('ar', 'مولّد الفاتورة الضريبية المجاني', ORIGIN + '/invoice-generator', INVGEN_FAQ.ar) },
      en: { t: 'Free Tax Invoice Generator with QR Code | FieldSales', d: 'Create a professional tax invoice free with a ZATCA-compliant QR code and download it as PDF in seconds — no signup.',
        b: '<h1>Free Tax Invoice Generator</h1><p>A fully free in-browser tool: enter your company, customer and line items to instantly get a professional bilingual tax (or simplified) invoice with a ZATCA-compliant QR code, then download it as PDF or print it — no signup, no limits. Supports VAT rates and currencies of 12 Arab countries. <a href="/en/invoice-generator">Create your invoice now</a>, also try the <a href="/en/calculator">Revenue Leak Calculator</a> or <a href="/signup">issue them automatically from your rep’s phone with FieldSales</a>.</p>' + faqHtml('FAQ', INVGEN_FAQ.en), j: toolJsonLd('en', 'Free Tax Invoice Generator', ORIGIN + '/en/invoice-generator', INVGEN_FAQ.en) },
      fr: { t: 'Générateur gratuit de factures fiscales avec code QR | FieldSales', d: 'Créez gratuitement une facture fiscale professionnelle avec code QR conforme ZATCA et téléchargez-la en PDF — sans inscription.',
        b: '<h1>Générateur gratuit de factures fiscales</h1><p>Un outil entièrement gratuit dans votre navigateur : saisissez votre entreprise, votre client et les lignes pour obtenir instantanément une facture fiscale bilingue professionnelle avec code QR conforme ZATCA, puis téléchargez-la en PDF ou imprimez-la — sans inscription. Prend en charge la TVA et les devises de 12 pays arabes. <a href="/fr/invoice-generator">Créez votre facture</a>, essayez aussi le <a href="/fr/calculator">calculateur de fuite de revenus</a> ou <a href="/signup">émettez-les automatiquement avec FieldSales</a>.</p>' + faqHtml('FAQ', INVGEN_FAQ.fr), j: toolJsonLd('fr', 'Générateur gratuit de factures fiscales', ORIGIN + '/fr/invoice-generator', INVGEN_FAQ.fr) },
    },
    terms: {
      ar: { t: 'الشروط والأحكام | FieldSales', d: 'الشروط والأحكام العامة لاستخدام منصّة FieldSales.', b: '<h1>الشروط والأحكام</h1><p>الشروط والأحكام العامة لاستخدام منصّة FieldSales لإدارة المبيعات الميدانية — النص الكامل متاح في هذه الصفحة داخل التطبيق.</p>' },
      en: { t: 'Terms & Conditions | FieldSales', d: 'General terms and conditions for using the FieldSales platform.', b: '<h1>Terms &amp; Conditions</h1><p>The general terms for using the FieldSales field sales platform — the full text is available on this page in the app.</p>' },
      fr: { t: 'Conditions générales | FieldSales', d: 'Conditions générales d\'utilisation de la plateforme FieldSales.', b: '<h1>Conditions générales</h1><p>Les conditions générales d\'utilisation de la plateforme FieldSales — le texte complet est disponible sur cette page.</p>' },
    },
    privacy: {
      ar: { t: 'سياسة الخصوصية | FieldSales', d: 'كيف تجمع منصّة FieldSales بياناتك وتحميها وتستخدمها.', b: '<h1>سياسة الخصوصية</h1>' + (privacyHtml ? privacyHtml.ar : '<p>توضّح هذه السياسة كيف تجمع منصّة FieldSales البيانات وتحميها وتستخدمها — النص الكامل متاح في هذه الصفحة داخل التطبيق. للاستفسار: info@fieldsa.net</p>') },
      en: { t: 'Privacy Policy | FieldSales', d: 'How FieldSales collects, protects and uses your data.', b: '<h1>Privacy Policy</h1>' + (privacyHtml ? privacyHtml.en : '<p>This policy explains how FieldSales collects, protects and uses data — the full text is available on this page in the app. Questions: info@fieldsa.net</p>') },
      fr: { t: 'Politique de confidentialité | FieldSales', d: 'Comment FieldSales collecte, protège et utilise vos données.', b: '<h1>Politique de confidentialité</h1>' + (privacyHtml ? privacyHtml.fr : '<p>Cette politique explique comment FieldSales collecte, protège et utilise les données — texte complet disponible sur cette page. Questions : info@fieldsa.net</p>') },
    },
    'service-agreement': {
      ar: { t: 'اتفاقية الخدمة | FieldSales', d: 'اتفاقية مستوى الخدمة والاشتراك في منصّة FieldSales.', b: '<h1>اتفاقية الخدمة</h1><p>اتفاقية مستوى الخدمة والاشتراك في منصّة FieldSales — النص الكامل متاح في هذه الصفحة داخل التطبيق.</p>' },
      en: { t: 'Service Agreement | FieldSales', d: 'The service and subscription agreement for the FieldSales platform.', b: '<h1>Service Agreement</h1><p>The service and subscription agreement for FieldSales — the full text is available on this page in the app.</p>' },
      fr: { t: 'Accord de service | FieldSales', d: 'L\'accord de service et d\'abonnement de la plateforme FieldSales.', b: '<h1>Accord de service</h1><p>L\'accord de service et d\'abonnement FieldSales — texte complet disponible sur cette page.</p>' },
    },
  };
  for (const [route, langs] of Object.entries(INFO)) {
    for (const L of LANGS) {
      const m = langs[L];
      const prefix = L === 'ar' ? '' : `/${L}`;
      const canonical = canon(`${ORIGIN}${prefix}/${route}`);
      const html = buildPage({ lang: L, title: m.t, description: m.d, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang(`/${route}`), jsonLd: m.j || null, bodyHtml: `<main>${m.b}</main>` });
      writeRoute(`${prefix}/${route}`, html);
      n++;
    }
  }

  const PRICING_HTML = `<p>اشتراك FieldSales <strong>لكل شركة لا لكل مستخدم</strong>: `
    + `<strong>${pricing.arSummary}</strong>`
    + (pricing.hasCustomTier ? `، وباقة ${esc(pricing.customTierName)} لعدد غير محدود من المناديب حسب الطلب` : '')
    + `. مع <strong>تجربة مجانية 10 أيام</strong> تبدأ خلال دقائق دون بطاقة ائتمان.</p>`
    + `<p><a href="/signup">ابدأ تجربتك المجانية</a> أو <a href="${waHref}" rel="noopener">تحدّث معنا على واتساب</a> ${topCap ? `لتسعير أكثر من ${topCap} مندوباً` : 'لتسعير الفرق الأكبر'}.</p>`;

  // 4.5) صفحات القطاعات السبعة — محتوى مكتوب لكل قطاع (لا استنساخ)
  for (const sec of SECTORS) {
    const canonical = canon(`${ORIGIN}/قطاعات/${sec.slug}`);
    const faqHtml = sec.faq.map((f) => `<h2>${esc(f.q)}</h2><p>${esc(f.a)}</p>`).join('');
    const featHtml = sec.features.map((f) => `<li><strong>${esc(f.title)}</strong> — ${esc(f.body)}</li>`).join('');
    const deepHtml = (sec.deep || []).map((d) => `<h2>${esc(d.title)}</h2><p>${esc(d.body)}</p>`).join('');
    // روابط ذات صلة (P4): ميزتان تخدمان ألم القطاع، و«نظام إدارة المناديب»، وقطاعان قريبان (clusters.mjs)
    const rel = sectorRelatedLinks(sec.slug);
    const relHtml = rel.length ? `<h2>روابط ذات صلة</h2><ul>${rel.map((l) => `<li><a href="${l.href}">${esc(l.anchor)}</a></li>`).join('')}</ul>` : '';
    const body = `<main>
<h1>برنامج إدارة مناديب التوزيع لشركات ${esc(sec.name)}</h1>
<p>${esc(sec.pain)}</p>
<h2>يومك الميداني</h2><p>${esc(sec.scene)}</p>
<h2>ما يخدم هذا القطاع تحديداً</h2><ul>${featHtml}</ul>
${deepHtml}
${faqHtml}
<h2>ما نملكه وما لا نملكه — بصراحة</h2>
<p>ندعم الفاتورة الإلكترونية برمز QR، وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات فلا ندّعي اعتماداً منها.</p>
${relHtml}
<p><a href="/pricing">شاهد الأسعار</a> أو <a href="${waHref}" rel="noopener">تحدّث معنا على واتساب</a>.</p>
</main>`;
    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage', mainEntity: sec.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'الرئيسية', item: canon(ORIGIN) },
          { '@type': 'ListItem', position: 2, name: 'القطاعات', item: canon(`${ORIGIN}/قطاعات`) },
          { '@type': 'ListItem', position: 3, name: sec.name, item: canonical },
        ] },
      ],
    };
    writeRoute(`/قطاعات/${sec.slug}`, buildPage({
      lang: 'ar',
      title: `${sec.name} — برنامج إدارة مناديب التوزيع | Field Sales`,
      // وعد «دون إنترنت» مقيَّد: التحصيل والزيارات تعمل دون اتصال دائماً، أما الفواتير فتحتاجه للمفعّل لهم الربط
      description: `${sec.pain} يدير مخزون سيارة المندوب والمرتجعات المصنّفة لشركات ${sec.name}، والتحصيل والزيارات تعمل بلا إنترنت.`,
      canonical, image: `${ORIGIN}/og-image.png`, jsonLd, bodyHtml: body,
    }));
    n++;
  }
  // فهرس القطاعات
  writeRoute('/قطاعات', buildPage({
    lang: 'ar', title: 'القطاعات التي يخدمها Field Sales في التوزيع الميداني',
    description: 'سبعة قطاعات توزيع: مواد غذائية، ألبان، مياه ومشروبات، مخابز، مستلزمات طبية، مواد بناء، قطع غيار — لكل قطاع ألمه اليومي المختلف.',
    canonical: canon(`${ORIGIN}/قطاعات`), image: `${ORIGIN}/og-image.png`,
    bodyHtml: `<main><h1>القطاعات التي نخدمها</h1><ul>${SECTORS.map((s2) => `<li><a href="/قطاعات/${s2.slug}">${esc(s2.name)}</a> — ${esc(s2.pain)}</li>`).join('')}</ul></main>`,
  }));
  n++;

  // 4.4b) صفحة تنزيل تطبيق المندوب — كانت **محجوبة ثلاث مرّات**: قاعدة `Disallow: /rep`
  // بادئة فتبتلع /rep-app، ولا هي في الخريطة، ولا مُصيَّرة فتُقدَّم قوقعة SPA بعنوان
  // الرئيسية — وهذا بالضبط ما يجعل جوجل يعدّها «نسخة طبق الأصل» من الرئيسية.
  // التطبيق منشور علناً على Google Play، فالصفحة تستحقّ الزحف.
  //
  // P7: كانت بين 135 و175 كلمة وتَعِد «البيع والتحصيل يستمران في المناطق المقطوعة» بينما RepApp.tsx يمنع
  // الفاتورة (القياسية والمبسطة) والمرتجع دون اتصال للشركات المفعّل لها الربط. المحتوى الآن من clusters.mjs
  // (REP_APP وrepAppSections المستمدّة من features.mjs) — المصدر نفسه الذي يعرضه RepAppPage.
  {
    const canonical = canon(`${ORIGIN}/rep-app`);
    const body = `<main>
<h1>${esc(REP_APP.h1)}</h1>
<p>${esc(REP_APP.intro)}</p>
<p>${esc(REP_APP.offline)}</p>
<h2>حمّل التطبيق</h2>
<p><a href="${REP_APP_STORES.play}" rel="noopener">Google Play</a> · <a href="${REP_APP_STORES.apple}" rel="noopener">App Store</a> · أو افتحه من متصفح الجوال بلا تنزيل.</p>
<p>يعمل على أي هاتف ذكي، والطابعة الحرارية اختيارية. <a href="/signup">ابدأ تجربة مجانية ١٠ أيام</a> بلا بطاقة، أو <a href="/">تعرّف على المنصّة</a>.</p>
<h2>ماذا يفعل المندوب من جواله</h2>
<ul>${REP_APP.cards.map((c) => `<li><strong>${esc(c.title)}</strong> — ${esc(c.desc)}</li>`).join('')}</ul>
${sectionsHtml(repAppSections())}
<h2>أسئلة شائعة</h2>
${REP_APP.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('\n')}
<h2>بيانات الدخول من مدير الشركة</h2>
<p>التطبيق للمناديب المسجّلين فقط: ينشئ مدير الشركة حساب المندوب من لوحة الإدارة ويسلّمه اسم المستخدم وكلمة المرور، ولا يوجد تسجيل ذاتي. <a href="/signup">شركتك ليست مشتركة بعد؟ ابدأ مجاناً</a></p>
</main>`;
    writeRoute('/rep-app', buildPage({
      lang: 'ar',
      title: REP_APP.title,
      description: REP_APP.description,
      canonical, image: `${ORIGIN}/og-image.png`, jsonLd: repAppJsonLd(canonical), bodyHtml: body,
    }));
    n++;
  }

  // 4.5b) صفحات الميزات المفردة — «كيف تفعلونها أنتم؟» بتفصيل لا يملكه إلا من بناها.
  // قسم «ما لا تفعله» ظاهر عمداً: الحدّ المسكوت عنه يصير وعداً ضمنياً، والتفصيل
  // الصادق هو ما يفرّق صفحة منتج عن صفحة تسويق فيجعلها تستحقّ الترتيب.
  for (const ft of FEATURES) {
    const canonical = canon(`${ORIGIN}/مزايا/${ft.slug}`);
    const howHtml = ft.how.map((h) => `<h3>${esc(h.title)}</h3><p>${esc(h.body)}</p>`).join('');
    const limHtml = ft.limits.map((l) => `<li>${esc(l)}</li>`).join('');
    const faqHtml = ft.faq.map((f) => `<h2>${esc(f.q)}</h2><p>${esc(f.a)}</p>`).join('');
    const alsoHtml = [
      ft.pairSlug ? `<li><a href="/blog/${ft.pairSlug}/">دليل شامل ${esc(ft.name)}</a></li>` : '',
      ft.templateSlug ? `<li><a href="/نماذج/${ft.templateSlug}">نموذج Excel جاهز ${esc(ft.name)}</a></li>` : '',
    ].join('');
    // جدول المقارنة (C1): ظاهر بنصّه — صفّه الأول عنوان الصف
    const cmp = ft.compare;
    const compareHtml = cmp
      ? `<table><caption>${esc(cmp.caption)}</caption><thead><tr>${cmp.head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${cmp.rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table>`
      : '';
    const otherHtml = FEATURES.filter((o) => o.id !== ft.id)
      .map((o) => `<li><a href="/مزايا/${o.slug}/">${esc(o.name)}</a></li>`).join('');
    const body = `<main>
<h1>${esc(ft.h1)}</h1>
<p>${esc(ft.pain)}</p>
<h2>المشهد الذي تعالجه</h2><p>${esc(ft.scene)}</p>
<h2>كيف تعمل عندنا</h2>${howHtml}
${compareHtml}
<h2>ما لا تفعله هذه الميزة</h2><ul>${limHtml}</ul>
${faqHtml}
${alsoHtml ? `<h2>اقرأ أيضاً</h2><ul>${alsoHtml}</ul>` : ''}
<h2>مزايا أخرى</h2><ul>${otherHtml}</ul>
<p><a href="/pricing">شاهد الأسعار</a> أو <a href="${waHref}" rel="noopener">تحدّث معنا على واتساب</a>.</p>
</main>`;
    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage', mainEntity: ft.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
        { '@type': 'BreadcrumbList', itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'الرئيسية', item: canon(ORIGIN) },
          { '@type': 'ListItem', position: 2, name: 'المزايا', item: canon(`${ORIGIN}/مزايا`) },
          { '@type': 'ListItem', position: 3, name: ft.name, item: canonical },
        ] },
      ],
    };
    writeRoute(`/مزايا/${ft.slug}`, buildPage({
      lang: 'ar',
      // العنوان والوصف بالصيغة نفسها في FeaturePage.tsx (لا مصدر مزدوج)؛ ft.title حين يطول H1
      title: `${ft.title || ft.h1} | Field Sales`,
      description: `${ft.pain} ${ft.name} في Field Sales: التفاصيل والحدود بصراحة.`,
      canonical, image: `${ORIGIN}/og-image.png`, jsonLd, bodyHtml: body,
    }));
    n++;
  }
  // فهرس المزايا
  writeRoute('/مزايا', buildPage({
    lang: 'ar', title: 'مزايا Field Sales للتوزيع الميداني وكيف تعمل فعلاً',
    description: 'الفوترة بدون إنترنت، عهدة سيارة المندوب، الطباعة الحرارية ٥٨ مم، إثبات زيارة المندوب — كل ميزة وكيف تعمل وما لا تفعله بصراحة.',
    canonical: canon(`${ORIGIN}/مزايا`), image: `${ORIGIN}/og-image.png`,
    bodyHtml: `<main><h1>مزايا المنصّة</h1><ul>${FEATURES.map((f2) => `<li><a href="/مزايا/${f2.slug}/">${esc(f2.name)}</a> — ${esc(f2.pain)}</li>`).join('')}</ul></main>`,
  }));
  n++;

  // 4.6) بنك النماذج — رفّ فارغ بلا منافس؛ تنزيل بلا بوابة بريد
  // كل نموذج يرتبط بصفحة الميزة التي تُغني عنه رقمياً — يقوّي العنقود ويحوّل باحث النموذج لمشترٍ محتمل.
  const TEMPLATE_FEATURE = {
    'سند-قبض': ['/blog/mobile-receipt-vouchers/', 'سند القبض الفوري من جوال المندوب'],
    'كشف-حساب-عميل': ['/blog/field-collection-overdue-receivables/', 'تحصيل الذمم المتعثرة عبر المناديب'],
    'عهدة-سيارة-المندوب': ['/blog/rep-van-custody-management/', 'نظام عهدة بضاعة سيارة المندوب'],
    'خطة-خط-سير-أسبوعية': ['/blog/rep-visit-tracking-gps/', 'متابعة زيارات المناديب بإثبات GPS'],
    'مرتجع-بضاعة': ['/blog/field-sales-returns-management/', 'إدارة مرتجعات المبيعات الميدانية'],
    'تسوية-التحصيل-اليومية': ['/blog/mobile-receipt-vouchers/', 'سند القبض الفوري من جوال المندوب'],
    'قائمة-أسعار-متدرجة': ['/blog/sales-reps-permissions/', 'صلاحيات الأسعار والخصومات للمناديب'],
    'تقرير-زيارة-ميدانية': ['/blog/rep-visit-tracking-gps/', 'متابعة زيارات المناديب بإثبات GPS'],
  };
  for (const t of TEMPLATES) {
    const canonical = canon(`${ORIGIN}/نماذج/${t.slug}`);
    const cols = t.columns.map((c) => `<li>${esc(c)}</li>`).join('');
    const notes = t.notes.map((x) => `<li>${esc(x)}</li>`).join('');
    const feat = TEMPLATE_FEATURE[t.slug];
    const featLine = feat ? `<p>وحين تجهز للاستغناء عن الورق: اقرأ عن <a href="${feat[0]}">${feat[1]}</a> — الدورة نفسها رقمياً من جوال المندوب.</p>` : '';
    writeRoute(`/نماذج/${t.slug}`, buildPage({
      lang: 'ar',
      title: `${t.title} — تحميل مجاني Excel | Field Sales`,
      description: `${t.purpose} حمّله بصيغة Excel مجاناً وبلا تسجيل.`,
      canonical, image: `${ORIGIN}/og-image.png`,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CreativeWork',
        name: t.title, description: t.purpose,
        inLanguage: 'ar', isAccessibleForFree: true,
        encodingFormat: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        url: canonical,
        publisher: { '@type': 'Organization', name: 'Field Sales', url: ORIGIN },
      },
      bodyHtml: `<main><h1>${esc(t.title)}</h1><p>${esc(t.purpose)}</p>
<p>التحميل بصيغة Excel مجاناً وبلا تسجيل ولا بريد.</p>
<h2>أعمدة النموذج</h2><ul>${cols}</ul>
<h2>كيف تستعمله</h2><ul>${notes}</ul>
${featLine}
<p><a href="/pricing">شاهد أسعار Field Sales</a> أو <a href="${waHref}" rel="noopener">تحدّث معنا على واتساب</a>.</p></main>`,
    }));
    n++;
  }
  writeRoute('/نماذج', buildPage({
    lang: 'ar', title: 'نماذج Excel مجانية لشركات التوزيع | Field Sales',
    description: 'نماذج جاهزة: سند قبض، كشف حساب عميل، عهدة سيارة المندوب، خطة خط سير، مرتجعات مصنّفة، تسوية تحصيل، أسعار متدرّجة، تقرير زيارة — بلا تسجيل.',
    canonical: canon(`${ORIGIN}/نماذج`), image: `${ORIGIN}/og-image.png`,
    jsonLd: { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: TEMPLATES.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.title, url: canon(`${ORIGIN}/نماذج/${t.slug}`) })) },
    bodyHtml: `<main><h1>نماذج مجانية لشركات التوزيع</h1><p>نماذج Excel جاهزة تستعملها كما هي أو تعدّلها — بلا تسجيل وبلا بريد.</p><ul>${TEMPLATES.map((t) => `<li><a href="/نماذج/${t.slug}">${esc(t.title)}</a> — ${esc(t.purpose)}</li>`).join('')}</ul></main>`,
  }));
  n++;

  // 4.7) الأدوات المجانية — تُحسب في المتصفّح، والصفحة تُصيَّر ليراها الزاحف
  // العناوين بالاستعلام-أولاً (ترقية أغسطس 2026): «حاسبة عمولة المبيعات» هي الصيغة التي تربح
  // بها حاسبات المنافسين في SERP — والوصف يحمل ذيل «مناديب التوزيع».
  // P7: البيانات من مصدر واحد (clusters.mjs: FREE_TOOLS) يستورده FreeToolsPage أيضاً، ولكل أداة صيغة
  // حسابها كما في src/free/engines.ts وثلاثة أسئلة ظاهرة (H3+P) تبني FAQPage — كانت بين 54 و57 كلمة.
  for (const t of FREE_TOOLS) {
    const canonical = canon(`${ORIGIN}/free/${t.id}`);
    const meta = freeToolMeta(t);
    writeRoute(`/free/${t.id}`, buildPage({
      lang: 'ar',
      title: meta.title,
      description: meta.description,
      canonical, image: `${ORIGIN}/og-image.png`,
      jsonLd: freeToolJsonLd(t, canonical),
      bodyHtml: `<main><h1>${esc(t.title)}</h1><p>${esc(t.desc)}</p>
<p>الأداة مجانية وتعمل في متصفّحك بالكامل: لا تسجيل، ولا يُرسل أي رقم تُدخله إلى خوادمنا.</p>
<h2>طريقة الحساب</h2><p>${esc(t.formula)}</p>
<h2>متى تستعملها</h2><p>${esc(t.use)}</p>
<h2>ما لا تحسبه الأداة</h2><p>${esc(t.limits)}</p>
<h2>أسئلة شائعة</h2>
${t.faq.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('\n')}
${t.feat ? `<p>وللفهم الأعمق قبل الحساب: <a href="${t.feat[0]}">${esc(t.feat[1])}</a>.</p>` : ''}
<p>أدوات أخرى: ${FREE_TOOLS.filter((o) => o.id !== t.id).map((o) => `<a href="/free/${o.id}/">${esc(o.title)}</a>`).join(' · ')}</p>
<p><a href="/pricing">شاهد أسعار Field Sales</a> أو <a href="${waHref}" rel="noopener">تحدّث معنا على واتساب</a>.</p></main>`,
    }));
    n++;
  }
  writeRoute('/free', buildPage({
    lang: 'ar', title: FREE_INDEX.title,
    description: FREE_INDEX.description,
    canonical: canon(`${ORIGIN}/free`), image: `${ORIGIN}/og-image.png`,
    jsonLd: { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: FREE_TOOLS.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.title, url: canon(`${ORIGIN}/free/${t.id}`) })) },
    bodyHtml: `<main><h1>${esc(FREE_INDEX.h1)}</h1><p>${esc(FREE_INDEX.intro)}</p><ul>${FREE_TOOLS.map((t) => `<li><a href="/free/${t.id}/">${esc(t.title)}</a> — ${esc(t.desc)}</li>`).join('')}</ul></main>`,
  }));
  n++;

  // 5) الصفحة الرئيسية العربية (الجذر dist/index.html) — تحقن محتوى دلالياً في #root الفارغ.
  //    هذه أهم صفحة، وكانت قوقعة SPA فارغة لغير مشغّلي JavaScript (زواحف AI وBing جزئياً).
  //    React يستبدلها عند التحميل (createRoot يمسح ويعيد الرسم).
  //    ⚠️ الملف نفسه قوقعة كل مسارات التطبيق (/rep و/m و/login و/c و/pay و/platform…): المحتوى المُصيَّر
  //    هنا مخفيّ ([data-ssr]) إلا على «/» نفسها — <html data-ssr-path="/"> وسكربت الرأس في index.html يُظهره
  //    حين يطابق المسار وحده (E2 وتصحيح الناقد 1). فمستخدم التطبيق يرى شاشة الإقلاع لا نصّاً تسويقياً.
  //
  //    الأسئلة الشائعة (P2): كان للرئيسية ثلاث نسخ مختلفة — JSON-LD في index.html، ونصّ مكتوب هنا،
  //    وما يرسمه React من CMS. الآن نسخة واحدة: أسئلة CMS مدموجة بالافتراضية كما يدمجها React،
  //    تُعرض هنا بـh3/p وتُبنى منها FAQPage. وما يُسقطه extractFaq.mjs (نفي قديم أو وعد «دون اتصال»
  //    غير مقيَّد) يبقى في الصفحة كما يرسمه React لكنه لا يُضخَّم في البيانات المنظّمة ولا في نصّ الزاحف.
  const homeDefaults = await loadTs('landing/defaultContent.ts', 'defaultContent').catch((e) => {
    console.log('⚠️  تعذّر تحميل المحتوى الافتراضي للرئيسية (غير مانع): ' + e.message);
    return null;
  });
  const homeFaqSrc = homeFaqFrom(homeDefaults, cms);
  const homeFaq = publishableFaq(homeFaqSrc.items, { problem: faqProblem });
  for (const d of homeFaq.dropped) console.log(`  ⚠️ سؤال في أسئلة الرئيسية (CMS) خارج FAQPage [${d.why}]: ${d.q} — يُصحَّح نصّه من لوحة المالك`);
  const homeFaqHtml = homeFaq.kept.length
    ? `<h2>${esc(homeFaqSrc.title)}</h2>\n` + homeFaq.kept.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('\n')
    : '';
  // صفوف روابط الرئيسية (P4) — يصلها ما لم يصله رابط: القطاعات والنماذج وتطبيق المندوب والتركية والصينية.
  // - أدلّة الدول: القانونية وحدها (canonicalSlug(s) === s) — كانت أول اثنتي عشرة دولة بلا تصفية، فذهبت
  //   روابط الرئيسية إلى صفحات ‎-ma و‎-dz المدموجة في صفحتها الجامعة؛ وتلك الدول كلها وراء «بقية الدول العربية».
  // - المراسي: صيغة «برنامج…» لروابط /مزايا/ وحدها، والمقالات بمراسٍ معلوماتية — كانت مرساة «برنامج فواتير
  //   يعمل بدون إنترنت» واحدة لرابطين مختلفين.
  // - التحصيل إلى collection-receivables-sa لا order-to-cash-cycle (تصحيح الناقد 13): ذلك المقال في CMS ما زال
  //   ينفي الربط، فلا يُروَّج من أقوى صفحة حتى يُنظَّف (docs/owner-actions.md §٨).
  // - جملة الربط (صفحات المنصّة) بعيدة عن «2026» في سطر الأدلّة المتخصّصة: آخر سطر في الصفحة عمداً.
  const homeCountries = COUNTRIES
    .filter((c) => { const s = `field-sales-software-${c.code.toLowerCase()}`; return canonicalSlug(s) === s && getArticle(s, 'ar'); })
    .slice(0, 12);
  const homeFeatures = FEATURES.filter((ft) => `/مزايا/${ft.slug}/` !== PHASE2_FEATURE_HREF);
  const HOME_FEATURE_ANCHOR = {
    'offline-invoicing': 'برنامج فواتير يعمل بدون إنترنت',
    'van-stock': 'برنامج عهدة سيارة المندوب',
    'thermal-printing': 'طباعة فاتورة من الجوال',
    'visit-tracking': 'إثبات زيارة المندوب',
    'rep-collection': 'برنامج تحصيل المناديب',
  };
  const homeAr = `<main>
<h1>FieldSales — نظام إدارة مناديب المبيعات والتوزيع الميداني للأسواق العربية</h1>
<p><strong>FieldSales</strong> منصّة سحابية عربية متكاملة لشركات التوزيع والمبيعات الميدانية. يُصدر المندوب من هاتفه فاتورة ضريبية منظّمة برمز QR (متوافقة مع ZATCA في السعودية) وطباعة حرارية فورية، ويسجّل التحصيل، ويدير مخزون سيارته — بينما تحصل الإدارة على صورة حيّة كاملة: مبيعات اليوم، التحصيل والذمم، حدود ائتمان العملاء مع تنبيهات التجاوز، مخزون كل سيارة، ومواقع المناديب وخطوط سيرهم عبر GPS.</p>
<p>بواجهة عربية أصلية (RTL) ودعم للإنجليزية والفرنسية، تخدم FieldSales موزّعي المواد الغذائية والمشروبات والسلع الاستهلاكية في كل الدول العربية.</p>
<h2>أبرز المزايا</h2>
<ul>
<li>فوترة ضريبية من الميدان برمز QR وطباعة حرارية 58مم</li>
<li>ندعم ربط المرحلة الثانية مع منصة فاتورة في السعودية</li>
<li>التحصيل وإدارة الذمم وكشوف الحساب مع حدود ائتمان وتنبيهات</li>
<li>إدارة مخزون سيارة المندوب مع كشف الفروقات لحظياً</li>
<li>تتبّع المناديب عبر GPS وتخطيط خطوط السير</li>
<li>كتالوج المنتجات وشرائح الأسعار وإدارة العملاء</li>
<li>صلاحيات دقيقة للفريق وتكامل مع أنظمة ERP</li>
<li>تقارير وتحليلات لحظية على لوحة واحدة</li>
</ul>
<h2>الأسعار</h2>
${PRICING_HTML}
${homeFaqHtml}
<h2>للتواصل وطلبات الاشتراك</h2>
<p>البريد الرسمي: <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · مقر الشركة: المملكة العربية السعودية · <a href="/subscribe-request/">سجّل طلب اشتراك جديد</a> أو <a href="/signup">ابدأ التجربة المجانية</a> مباشرةً.</p>
<h2>روابط مفيدة</h2>
<p><a href="/blog/">المدوّنة</a> · <a href="/calculator/">حاسبة تسريب الإيرادات</a> · <a href="/invoice-generator/">مولّد الفاتورة الضريبية المجاني</a> · <a href="/blog/distribution-terms-glossary/">قاموس مصطلحات التوزيع</a> · <a href="/blog/distribution-owners-questions/">أسئلة أصحاب شركات التوزيع</a> · <a href="/about/">عن المنصّة</a> · <a href="/contact/">تواصل معنا</a> · <a href="/en/">English</a> · <a href="/fr/">Français</a></p>
<p>الشروط والسياسات: <a href="/terms/">الشروط والأحكام</a> · <a href="/privacy/">سياسة الخصوصية</a> · <a href="/service-agreement/">اتفاقية الخدمة</a></p>
<p>صفحات المنصّة: <a href="/pricing/">الأسعار</a> · <a href="/rep-app/">تطبيق المندوب</a> · <a href="/نماذج/">نماذج Excel مجانية</a> · <a href="/free/">أدوات مجانية</a> · <a href="${PHASE2_FEATURE_HREF}">${esc(PHASE2_ANCHOR)}</a> · <a href="/tr/">Türkçe</a> · <a href="/zh/">中文</a></p>
<p>القطاعات: ${SECTORS.map((sec) => `<a href="/قطاعات/${sec.slug}/">${esc(sec.name)}</a>`).join(' · ')} · <a href="/قطاعات/">كل القطاعات</a></p>
<p>أدلّة الدول: ${homeCountries.map((c) => `<a href="/blog/field-sales-software-${c.code.toLowerCase()}/">${esc(c.ar)}</a>`).join(' · ')} · <a href="/blog/field-sales-software/">بقية الدول العربية</a></p>
<p>كيف تعمل مزايانا: ${homeFeatures.map((ft) => `<a href="/مزايا/${ft.slug}/">${esc(HOME_FEATURE_ANCHOR[ft.id] || ft.name)}</a>`).join(' · ')} · <a href="/مزايا/">كل المزايا</a></p>
<p>دلائل عملية: <a href="/blog/offline-invoicing-for-reps/">كيف تعمل الفوترة بدون إنترنت ومتى تحتاج اتصالاً</a> · <a href="/blog/rep-van-custody-management/">دورة عهدة السيارة اليومية: تحميل وبيع ومطابقة</a> · <a href="/blog/thermal-printing-field-invoices/">الطباعة الحرارية: أي طابعة وأي مقاس</a> · <a href="/blog/prevent-fake-visits-gps-spoofing/">كيف تكشف الزيارة الوهمية</a> · <a href="/blog/rep-visit-tracking-gps/">متابعة زيارات المناديب بالموقع والصور</a> · <a href="/blog/collection-receivables-sa/">تحصيل الذمم والمديونيات في السعودية</a> · <a href="/blog/mobile-receipt-vouchers/">سند قبض من الجوال</a> · <a href="/blog/field-sales-returns-management/">مرتجعات المبيعات الميدانية</a> · <a href="/blog/barcode-scanning-invoices/">مسح الباركود بالكاميرا</a> · <a href="/blog/sales-reps-permissions/">صلاحيات مناديب المبيعات</a> · <a href="/blog/distribution-reps-commissions/">عمولات مناديب التوزيع</a></p>
<p>أدلّة متخصّصة: <a href="/blog/distributor-network-management-software/">برنامج إدارة الموزعين</a> · <a href="/blog/cash-van-software-guide/">برنامج كاش فان</a> · <a href="/blog/sales-reps-management-system/">نظام إدارة المناديب</a> · <a href="/blog/distribution-companies-management-system/">نظام إدارة شركات التوزيع</a> · <a href="/blog/field-sales-system-for-companies/">نظام مبيعات ميدانية للشركات</a> · <a href="/blog/field-sales-software-om/">برنامج مناديب التوزيع سلطنة عمان</a> · <a href="/blog/field-sales-software-market-report-2026/">تقرير سوق برامج المناديب 2026</a></p>
</main>`;
  let rootHtml = template.replace(/<div id="root">\s*<\/div>/, `<div id="root"><div data-ssr>${homeAr}</div></div>`);
  // FAQPage الرئيسية داخل كتلة القالب (لا كتلة data-seo-page): LandingPage يستبدل كتلة الصفحة
  // بكتلة Organization عند الإقلاع، فلو وُضعت هناك لاختفت بعده بينما الأسئلة ظاهرة.
  rootHtml = rootHtml.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, (m, body) => {
    try {
      const j = JSON.parse(body);
      if (!Array.isArray(j['@graph'])) return m;
      const g = j['@graph'].filter((x) => !(x && x['@type'] === 'FAQPage'));
      if (homeFaq.kept.length) g.push(faqPageNode(homeFaq.kept));
      return `<script type="application/ld+json">${JSON.stringify({ ...j, '@graph': g })}</script>`;
    } catch { return m; }
  });
  // عنقود hreflang الرئيسية الخماسي — مطابق للخريطة، وموسوم data-seo-alt فيستبدله LandingPage لا يضاعفه.
  // على مسارات التطبيق التي تخدمها القوقعة نفسها بلا أثر: canonical فيها «/» فلا يُعتدّ ببدائلها.
  rootHtml = rootHtml.replace('</head>', `${marketingHreflang}\n  </head>`);
  rootHtml = withSsrPath(rootHtml, '/');
  fs.writeFileSync(path.join(DIST, 'index.html'), rootHtml);
  console.log(`  الرئيسية العربية: FAQPage بـ${homeFaq.kept.length} سؤالاً من CMS (أُسقط ${homeFaq.dropped.length})`);
  n++;

  // ── تطبيع الشرطة الأخيرة في الروابط الداخلية ───────────────────────────
  //
  // Render يخدم مجلّداً فقط حين ينتهي الطلب بشرطة. فرابطٌ إلى /pricing بلا شرطة لا
  // يجد ملفاً، فتبتلعه قاعدة `/* → /index.html` ويردّ **قوقعة الرئيسية بالرمز 200** —
  // لا 301 ولا 404. أي أن الزاحف يتسلّم نسخة مكرَّرة من الرئيسية تحت عنوان الصفحة،
  // وهذا بعينه ما يملأ دلو «مكرّرة — اختار جوجل صفحة أساسية مختلفة» في Search Console.
  //
  // قِيس فوُجد 37 مساراً كذلك، منها /pricing في 42 ملفاً وصفحات المزايا الأربع في 9.
  // ولأن الروابط مكتوبة يدوياً في عشرات القوالب هنا، لا يُصلحها رشُّ شرطات يدويّ يسهو
  // عن التالي: تُطبَّع مرّة واحدة على المخرَج النهائي بشرطٍ لا يخطئ — تُضاف الشرطة
  // إن وُجد لهذا المسار مجلّد مُصيَّر فعلاً، ولا شيء غيره. فأي رابط جديد يُكتب لاحقاً
  // يُصحَّح تلقائياً، وأي مسار لا صفحة له (‏/signup مثلاً) يبقى كما هو للراوتر.
  const routes = new Set();
  (function collectRoutes(dir, rel = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'assets') continue;
      const sub = `${rel}/${e.name}`;
      if (fs.existsSync(path.join(dir, e.name, 'index.html'))) {
        routes.add(sub);
        try { routes.add(decodeURIComponent(sub)); } catch { /* ترميز سيّئ — يكفي الأصل */ }
      }
      collectRoutes(path.join(dir, e.name), sub);
    }
  })(DIST);

  let patched = 0;
  let links = 0;
  (function normalize(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'assets') normalize(p); continue; }
      if (!e.name.endsWith('.html')) continue;
      const src = fs.readFileSync(p, 'utf8');
      const out = src.replace(/href="(\/[^"#?]*[^/"])"/g, (m, href) => {
        let plain = href;
        try { plain = decodeURIComponent(href); } catch { /* يبقى كما هو */ }
        if (!routes.has(href) && !routes.has(plain)) return m;
        links++;
        return `href="${href}/"`;
      });
      if (out !== src) { fs.writeFileSync(p, out); patched++; }
    }
  })(DIST);
  console.log(`  تطبيع الشرطة الأخيرة: ${links} رابطاً في ${patched} ملف`);

  console.log(`✅ prerender: ${n} صفحة ثابتة (${buildCatalog().length} مقال مولَّد ×3 + ${manual.length} مقال يدوي + فهارس + رئيسية ع/إ/فر/تر/صيني + ${Object.keys(INFO).length} صفحة تعريفية ×3) في dist/`);
}

await main();
