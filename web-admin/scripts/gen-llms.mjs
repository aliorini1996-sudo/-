// يولّد public/llms.txt (دليل مُنسّق لمحرّكات الذكاء، معيار llmstxt.org) وpublic/llms-full.txt (فهرس كامل).
//
// المصادر، كلٌّ من موضعه الواحد:
//  - المقالات المولّدة: src/blog/seo/catalog.mjs.
//  - المقالات اليدوية: effectivePosts في src/blog/posts.ts فوق CMS الحيّ، الدالة نفسها التي يراها الزائر وتبني الخريطة.
//  - صفحات المنتج: FEATURES والقطاعات والنماذج والأدوات المجانية من ملفاتها، والأسعار من CMS وقت التوليد.
//  - الأجوبة وجملة التعريف: src/content/answers.mjs.
//
// القواعد (بند L1 وتصحيح الناقد 14):
//  - روابط قانونية فقط، كما في الخريطة: مقال الكتالوج يُدرج إن كان canonical لنفسه وقابلاً للفهرسة بلغته،
//    والمقال اليدوي المدموج (src/blog/consolidate.mjs) لا يُدرج بلغته المدموجة، والتركية والصينية للرئيسية وحدها.
//  - نصّ CMS لا يُنشر هنا إن أدانته قواعد الحارس (scripts/claims-rules.mjs) أو وعد «دون اتصال» بلا قيد الربط
//    أو ذكر سعراً: الوصف يسقط، والعنوان المُدان يُسقط المدخل كله.
//  - صفحات CMS المُبرَزة في llms.txt (أدلة المشتري السعودي، والمختارات، وتقرير السوق) تُفحص بنصّها الكامل:
//    الصفحة التي ما زال نصّها ينفي الربط أو يَعِد بالعمل دون اتصال بلا قيد لا تُبرَز حتى تُصحَّح في CMS
//    (docs/owner-actions.md §٨)، وتحلّ محلها صفحة الكتالوج المقابلة. بعد التصحيح تظهر وحدها بلا تعديل هنا.
//  - المخرج كله يمرّ بقواعد الحارس قبل الكتابة كما يمرّ بها verify-claims في dist: ما أدانته قاعدة بسبب
//    جوار نصّ CMS يتنازل عنه نصّ CMS، وما أدانته في نصّ المستودع يوقف التوليد (exit 1).
//  - التاريخ = أحدث تاريخ محتوى (CONTENT_VERSION وتعديل الكتالوج ونصوص answers.mjs ومقالات CMS)، لا اليوم.
//
// يُشغَّل في prebuild بعد gen-sitemap وفي الصيانة المجدولة — لا اتصال مباشر بقاعدة البيانات.
// التشغيل: node scripts/gen-llms.mjs [--out <مجلد>]   (الافتراضي public/)
// SEO_ALLOW_OFFLINE=1 للتشغيل المحلي بلا شبكة فقط (مقالات المستودع والأسعار الاحتياطية).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transformSync } from 'esbuild';
import { buildCatalog, listArticles, shortAnswer, isIndexable, CONTENT_VERSION, COUNTRIES } from '../src/blog/seo/catalog.mjs';
import { existsWith, consolidatedFor } from '../src/blog/consolidate.mjs';
import { textOf, faqProblemWith } from '../src/blog/extractFaq.mjs';
import { FREE_TOOLS, FREE_INDEX, OFFICIAL_LINKS } from '../src/blog/clusters.mjs';
import { FEATURES } from '../src/content/features.mjs';
import { answersFor, WHAT_IS, TEXT_VERSION } from '../src/content/answers.mjs';
import { SECTORS } from './sectors-data.mjs';
import { TEMPLATES } from './templates-data.mjs';
import { loadPricing, repsCap } from './pricing-source.mjs';
import { RULES, findViolation, findViolations, norm, PHASE1, PHASE2 } from './claims-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://fieldsa.net';
const API = 'https://api.fieldsa.net/api/site-content';

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : null;
const OUT_DIR = outArg ? path.resolve(outArg) : path.join(ROOT, 'public');

// الشرطة الأخيرة إلزامية: Render يخدم المجلّد المُصيَّر فقط عند /x/، أما /x فتعيد قوقعة الرئيسية. انظر prerender.mjs.
const abs = (p) => `${ORIGIN}${p.endsWith('/') ? p : `${p}/`}`;
const blogUrl = (slug, L) => abs(`${L === 'ar' ? '' : `/${L}`}/blog/${slug}/`);

/* ─── الجلب ──────────────────────────────────────────────────────────────────── */

/**
 * محتوى CMS بمحاولات حتى نحو 90 ثانية، كما في gen-sitemap (تصحيح الناقد 16). الفشل الكلّي يوقف التوليد
 * فيبقى الملفان الملتزمان كما هما، بدل فهرس بلا مقالات CMS أو بأسعار احتياطية يُنشر صامتاً.
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
    console.log(`  ⚠️ CMS غير متاح (${last}) — SEO_ALLOW_OFFLINE=1: مقالات المستودع وأسعار احتياطية (تشغيل محلي فقط)`);
    return null;
  }
  console.error(`✗ تعذّر جلب CMS بعد ${attempt} محاولات (${last}). أُوقف التوليد وبقي llms.txt الحالي كما هو.`);
  process.exit(1);
}

/** src/blog/posts.ts (بلا استيرادات) كوحدة ESM في الذاكرة — كما يحمّلها gen-sitemap */
async function loadPostsModule() {
  const src = fs.readFileSync(path.join(ROOT, 'src/blog/posts.ts'), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/* ─── فحص النصوص ─────────────────────────────────────────────────────────────── */

const TEXT_RULES = RULES.filter((r) => r.scope !== 'head'); // ما يطبّقه verify-claims على ملفات .txt
// مصنِّف أسئلة المقالات نفسه (P2): نفي قديم أو وعد «دون اتصال» بلا قيد الربط
const p2Problem = faqProblemWith({ RULES, findViolation, norm, PHASE2 });
/** رقم يليه «ر.س» أو «ريال» أو SAR: الأسعار في هذا الملف من CMS وحده، فوصف مقال فيه سعر لا يُنقل */
const PRICED = /[\d٠-٩][\d٠-٩,.٬]*\s*(?:ر\.?\s?س|﷼|ريال|SAR\b)|\bSAR\s*[\d٠-٩]/i;

/**
 * مشكلات نصّ من CMS: قواعد الحارس، والنفي القديم، والوعد «دون اتصال» غير المقيَّد.
 * العنوان يُفحص بالقواعد وحدها (offline: false): عنوان قصير لا يتّسع لقيد الربط، وقيده في متن الصفحة.
 */
function problemsOf(raw, { offline = true } = {}) {
  const t = textOf(raw);
  if (!t) return [];
  const ids = TEXT_RULES.filter((r) => findViolation(r, t)).map((r) => r.id);
  const p = p2Problem({ q: '', a: t });
  if (p && !ids.includes(p) && (offline || p !== 'offline-unqualified')) ids.push(p);
  return ids;
}
/**
 * وصف مقال CMS يُذكر فيه «المرحلة الأولى» دون الثانية لا يُنقل ولو لم تُدِنه القاعدة: في هذه المقالات هو
 * تأطير المنتج القديم بالمرحلة الأولى («Saudi distribution runs on … Phase-1 e-invoicing»)، والوصف أول ما يُقتبس.
 */
const PHASE1_ONLY = (t) => new RegExp(PHASE1, 'i').test(t) && !new RegExp(PHASE2, 'i').test(t);
const cleanText = (s) => {
  const t = s ? norm(textOf(s)) : '';
  return !!t && !PRICED.test(t) && !PHASE1_ONLY(t) && !problemsOf(s).length;
};

/* ─── الكتل والحارس ───────────────────────────────────────────────────────────── */

/** نصّ مستودع ثابت */
const fixed = (text) => ({ variants: [text], i: 0, cms: false });
/** نصّ من CMS ببدائله من الأغنى إلى الأفقر، وآخرها الحذف: يتنازل خطوةً كلما أدانه الحارس بجواره */
const fromCms = (label, ...variants) => ({ variants: [...variants.filter(Boolean), ''], i: 0, cms: true, label });

/** كل مطابقة يدينها الحارس في النصّ، بنافذتها (مدى الجوار في قاعدة الموعد) */
function violationsIn(text) {
  const out = [];
  for (const r of TEXT_RULES) {
    const w = r.requireNear;
    for (const v of findViolations(r, text)) {
      out.push({ id: r.id, match: v.match, from: v.index - (w ? w.before : 0), to: v.index + v.match.length + (w ? w.after : 0) });
    }
  }
  return out;
}

/**
 * يركّب الكتل ويمرّرها بالحارس: مطابقة تمسّ نافذتُها نصّ CMS يتنازل عنها ذلك النصّ (وصف ← عنوان ← حذف)،
 * ومطابقة في نصّ المستودع وحده توقف التوليد. المواضع على النصّ المطبَّع (norm يحذف التشكيل حرفاً حرفاً،
 * فطول الكتل المطبَّعة يُجمع) لأن findViolations تعيد مواضعها عليه.
 */
function guarded(name, blocks) {
  for (let round = 0; round < 100; round++) {
    const text = blocks.map((b) => b.variants[b.i]).join('');
    let at = 0;
    const spans = blocks.map((b) => {
      const len = norm(b.variants[b.i]).length;
      const s = { b, from: at, to: at + len };
      at += len;
      return s;
    });
    const hits = violationsIn(text);
    if (!hits.length) return text;
    const demote = new Set();
    const repo = [];
    for (const h of hits) {
      const near = spans.filter((s) => s.b.cms && s.b.i < s.b.variants.length - 1 && s.from < h.to && s.to > h.from);
      if (near.length) near.forEach((s) => demote.add(s.b));
      else repo.push(h);
    }
    if (repo.length) {
      console.error(`✗ ${name}: نصّ المستودع يدينه حارس الادّعاءات — صحّحه في مصدره (answers.mjs أو هذا الملف أو catalog.mjs):`);
      for (const h of repo.slice(0, 10)) console.error(`    [${h.id}] «${h.match.slice(0, 90)}»`);
      process.exit(1);
    }
    for (const b of demote) {
      b.i++;
      console.log(`  ↓ ${name}: نصّ CMS تنازل بجوار مطابقة للحارس (${b.label})`);
    }
  }
  console.error(`✗ ${name}: لم يستقرّ فحص الحارس`);
  process.exit(1);
}

/* ─── الرئيسي ────────────────────────────────────────────────────────────────── */

async function main() {
  console.log('توليد llms.txt + llms-full.txt ...');
  const cms = await fetchCms();
  const mod = await loadPostsModule();

  // ── الكتالوج: القانوني وحده، بلغة قابلة للفهرسة (كما في الخريطة) ──
  const CATALOG = buildCatalog();
  const CAT = new Map(CATALOG.map((e) => [e.slug, e]));
  const listed = (slug, L) => { const e = CAT.get(slug); return !!e && e.isCanonical && isIndexable(e.cc, L); };
  const articles = (L) => listArticles(L).filter((a) => listed(a.slug, L));
  const ar = articles('ar');
  const en = articles('en');
  const fr = articles('fr');

  // ── المقالات اليدوية: كما في الخريطة (مقال بـslug مقال مولَّد لا يُصيَّر، والمدموج يخرج بلغته) ──
  const posts = mod.effectivePosts(cms?.blog).filter((p) => !CAT.has(p.slug));
  const POST = new Map(posts.map((p) => [p.slug, p]));
  const exists = existsWith(posts);
  const merged = { ar: consolidatedFor('ar', exists), en: consolidatedFor('en', exists) };
  const viewOf = (p, L) => (L === 'en' ? (p.en && p.en.title ? p.en : null) : p);
  const manualListed = (slug, L) => { const p = POST.get(slug); return !!p && !!viewOf(p, L) && !merged[L].has(slug); };
  console.log(`  المقالات: ${CATALOG.filter((e) => e.isCanonical).length} مولَّدة قانونية من ${CATALOG.length}، و${posts.length} يدوية${cms ? ' (CMS الحيّ)' : ' (المستودع)'} — المدموج خارج الفهرس: ${merged.ar.size} عربي و${merged.en.size} إنجليزي`);

  // ── التسعير من CMS نفسه (الاحتياطي في pricing-source.mjs عند التشغيل بلا شبكة وحده) ──
  let plans = Array.isArray(cms?.pricing?.plans) && cms.pricing.plans.length ? cms.pricing.plans : null;
  if (!plans) {
    const p = await loadPricing();
    plans = p.plans;
    console.log(`  التسعير: ${p.live ? 'CMS الحيّ' : 'احتياطي pricing-source'}`);
  }
  const tiers = plans
    .filter((p) => /^\d+$/.test(String(p.price ?? '').trim()))
    .map((p) => ({ price: String(p.price).trim(), reps: repsCap(p.limit) }))
    .sort((a, b) => Number(a.price) - Number(b.price));
  const topReps = tiers.length ? tiers[tiers.length - 1].reps : null;
  const PRICING_LINE = tiers.length
    ? `Per company, not per user: ${tiers.map((t) => `${t.price} SAR/month (${t.reps ? `up to ${t.reps} reps` : 'see plan limits'})`).join(', ')}. All prices include VAT.${topReps ? ` Above ${topReps} reps the price is set in a conversation.` : ''}`
    : 'Per company, not per user, with monthly plans published on the pricing page (VAT included).';
  console.log(`  التسعير: ${tiers.map((t) => `${t.price}/${t.reps ?? '?'}`).join(' · ') || 'بلا باقات رقمية'}`);

  // ── التاريخ: أحدث تاريخ محتوى، لا اليوم ──
  const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const UPDATED = [CONTENT_VERSION, TEXT_VERSION, ...CATALOG.map((e) => e.modified), ...posts.map((p) => mod.lastModifiedOf(p))]
    .filter(isDay).sort().pop();

  // ── الروابط المعروفة (قانونية): كل رابط في المخرج يجب أن يكون منها ──
  const KNOWN = new Set();
  const known = (u) => { KNOWN.add(u); return u; };
  for (const p of ['/', '/en/', '/fr/', '/tr/', '/zh/', '/about/', '/en/about/', '/fr/about/', '/contact/', '/en/contact/', '/fr/contact/',
    '/calculator/', '/en/calculator/', '/fr/calculator/', '/invoice-generator/', '/en/invoice-generator/', '/fr/invoice-generator/',
    '/pricing/', '/en/pricing/', '/fr/pricing/', '/blog/', '/en/blog/', '/fr/blog/', '/rep-app/', '/free/', '/مزايا/', '/قطاعات/', '/نماذج/']) known(abs(p));
  const featureUrl = (ft) => known(abs(`/مزايا/${ft.slug}/`));
  const sectorUrl = (s) => known(abs(`/قطاعات/${s.slug}/`));
  const templateUrl = (t) => known(abs(`/نماذج/${t.slug}/`));
  const toolUrl = (t) => known(abs(`/free/${t.id}/`));
  FEATURES.forEach(featureUrl); SECTORS.forEach(sectorUrl); TEMPLATES.forEach(templateUrl); FREE_TOOLS.forEach(toolUrl);
  for (const L of ['ar', 'en', 'fr']) for (const a of articles(L)) known(blogUrl(a.slug, L));
  for (const p of posts) for (const L of ['ar', 'en']) if (manualListed(p.slug, L)) known(blogUrl(p.slug, L));
  // روابط ليست صفحات محتوى: نموذج التسجيل والملفات
  const NON_PAGE = new Set([`${ORIGIN}/signup/`, `${ORIGIN}/llms.txt`, `${ORIGIN}/llms-full.txt`, `${ORIGIN}/sitemap.xml`]);

  // ── أوصاف ──
  const sentences = (s) => String(s || '').split(/(?<=[.!?؟])\s+/).filter(Boolean);
  const words = (s) => String(s).split(/\s+/).filter(Boolean).length;
  const MAX_WORDS = 45;
  /**
   * أول جملة (أو آخرها) من الإجابة المختصرة. الجملة الطويلة تُقصر على ما قبل نقطتيها إن كان جملة تامة،
   * وإلا فوصف الصفحة بلا عنوانها في أوله (النثر العربي في الكتالوج بلا ترقيم فجملته الأولى هي الجواب كله).
   */
  const catalogDesc = (a, L, pick = 'first') => {
    const ss = sentences(shortAnswer(a.slug, L));
    let s = pick === 'last' ? ss[ss.length - 1] : ss[0];
    if (s && words(s) > MAX_WORDS) {
      const c = s.indexOf(': ');
      s = c > 0 && words(s.slice(0, c)) >= 6 ? `${s.slice(0, c)}.` : '';
    }
    if (s) return s;
    const d = String(a.description || '');
    return d.startsWith(a.title) ? d.slice(a.title.length).replace(/^[\s:،,.—-]+/, '') : d;
  };
  const catalogLine = (a, L, pick) => `- [${a.title}](${blogUrl(a.slug, L)}): ${catalogDesc(a, L, pick)}\n`;
  /** وصف مقال يدوي: أول نصّ نظيف بين description وexcerpt، أو لا شيء */
  const manualDesc = (v) => [v.description, v.excerpt].find(cleanText) || '';
  /** مشكلات صفحة CMS مُبرَزة: عنوانها ونصّها الكامل (الوصف يُختار نظيفاً على حدة) */
  const pageProblems = (slug, L) => {
    const p = POST.get(slug);
    const v = p && viewOf(p, L);
    if (!v || !manualListed(slug, L)) return ['غير موجود أو مدموج'];
    return [...new Set([...problemsOf(v.title, { offline: false }), ...problemsOf(v.contentHtml || '')])];
  };
  const held = [];
  const featured = (slug, L) => {
    const why = pageProblems(slug, L);
    if (why.length) { held.push(`${L === 'ar' ? '' : `${L}/`}${slug} (${why.join('، ')})`); return false; }
    return true;
  };

  // ── أقسام llms.txt ──
  const B = [];
  const add = (s) => B.push(fixed(s));

  add(`# FieldSales (فيلد سيلز)

> ${WHAT_IS.en}
>
> ${WHAT_IS.ar}

Last updated: ${UPDATED}

Key facts:
- Also known as: فيلد سيلز, Field Sales (fieldsa.net). Other products share the generic name “Field Sales”; this file describes only FieldSales at fieldsa.net.
- Product type: field sales, van sales (DSD) and sales rep management software (SaaS, multi-tenant).
- Core features: tax invoices with a QR code and returns from the rep’s phone, receipt vouchers linked to the invoices they settle, customer balances and statements, van stock per item, visit proof with location and photos, routes drawn on roads, thermal printing, team permissions, product catalog and price tiers, ERP integration.
- Markets: all ${COUNTRIES.length} Arab League countries, with country guides (currency, VAT rate, tax authority).
- Languages: website in Arabic, English and French, plus Turkish and Chinese home pages. The apps are Arabic-first (right to left) and also run in English and French.
- Pricing: ${PRICING_LINE} No setup fees. Free 10-day trial, no credit card; sign-up form: ${ORIGIN}/signup/
- Rep app: runs in any smartphone browser and is on Google Play and the App Store; a thermal printer is optional.
- Saudi e-invoicing: We support Phase 2 integration with ZATCA’s Fatoora platform, for companies in Saudi Arabia. ZATCA does not certify software vendors, so FieldSales claims no certification.
- Working offline: receipts, visits and new customers work without a connection and sync automatically without duplicates, and companies without the integration also issue invoices offline. Saudi companies with Phase 2 integration enabled need a connection at the moment of issue for invoices (standard and simplified) and returns.

## Product & pricing

- [Pricing (Arabic)](${abs('/pricing/')}): the monthly plans above with what each includes. English: ${abs('/en/pricing/')} · French: ${abs('/fr/pricing/')}
- [Rep app](${abs('/rep-app/')}): the sales rep app on Android, iOS and the browser, what it does offline and with a printer (Arabic page).
- [مزايا فيلد سيلز](${abs('/مزايا/')}): feature pages (Arabic), each with how it works, its limits and questions.
`);
  for (const ft of FEATURES) add(`- [${ft.name}](${featureUrl(ft)}): ${ft.title || ft.h1}\n`);
  add(`- [قطاعات](${abs('/قطاعات/')}): sector pages (Arabic) for distributors by product category.\n`);
  for (const s of SECTORS) add(`- [برنامج مناديب لموزعي ${s.name}](${sectorUrl(s)})\n`);

  // أدلة المشتري السعودي: صفحات الاستعلامات الرابحة. صفحة CMS تُبرَز إن صحّ نصّها كله، وصفحة الكتالوج
  // السعودية المقابلة تُدرج دائماً (قانونية ونصّها من المستودع).
  const BUYER_GUIDES = [
    { query: 'برنامج كاش فان', L: 'ar', manual: 'cash-van-software-guide', catalog: 'van-sales-app-sa' },
    { query: 'نظام إدارة المناديب', L: 'ar', manual: 'sales-reps-management-system', catalog: 'sales-rep-management-sa' },
    { query: 'برنامج إدارة الموزعين', L: 'ar', manual: 'distributor-network-management-software', catalog: 'distribution-management-system-sa' },
    { query: 'نظام إدارة شركات التوزيع', L: 'ar', manual: 'distribution-companies-management-system', catalog: 'distribution-management-system-sa' },
    { query: 'نظام مبيعات ميدانية للشركات', L: 'ar', manual: 'field-sales-system-for-companies', catalog: 'field-sales-software-sa' },
    { query: 'van sales software Saudi Arabia', L: 'en', manual: 'van-sales-software-saudi', catalog: 'van-sales-app-sa' },
    { query: 'sales rep tracking Saudi Arabia', L: 'en', manual: 'sales-rep-tracking-saudi', catalog: 'gps-rep-tracking-sa' },
    { query: 'DMS Saudi Arabia', L: 'en', manual: 'dms-saudi-arabia', catalog: 'distribution-management-system-sa' },
  ];
  add(`
## Saudi buyer guides

`);
  const seenGuide = new Set();
  for (const g of BUYER_GUIDES) {
    if (featured(g.manual, g.L)) {
      const v = viewOf(POST.get(g.manual), g.L);
      const u = blogUrl(g.manual, g.L);
      if (!seenGuide.has(u)) {
        seenGuide.add(u);
        const d = manualDesc(v);
        B.push(fromCms(`${g.L}/${g.manual}`, `- [${v.title}](${u}): answers «${g.query}».${d ? ` ${d}` : ''}\n`, `- [${v.title}](${u}): answers «${g.query}».\n`));
      }
    }
    const a = (g.L === 'ar' ? ar : en).find((x) => x.slug === g.catalog);
    const u = a && blogUrl(a.slug, g.L);
    if (a && !seenGuide.has(u)) {
      seenGuide.add(u);
      add(`- [${a.title}](${u}): answers «${g.query}». ${catalogDesc(a, g.L)}\n`);
    }
  }
  const sa = (L, slug) => (L === 'ar' ? ar : en).find((x) => x.slug === slug);
  for (const [L, slug] of [['ar', 'collection-receivables-sa'], ['en', 'einvoicing-compliance-sa']]) {
    const a = sa(L, slug);
    if (a) add(`- [${a.title}](${blogUrl(a.slug, L)}): ${catalogDesc(a, L)}\n`);
  }

  add(`
## Free tools and templates (no signup)

- [Free tax invoice generator](${abs('/invoice-generator/')}): builds a bilingual Arabic and English tax or simplified invoice with a QR code in the browser, downloadable as PDF or printable, with VAT rates and currencies preset for every Arab country. English: ${abs('/en/invoice-generator/')} · French: ${abs('/fr/invoice-generator/')}
- [Revenue leak calculator](${abs('/calculator/')}): estimates what a distribution company may lose each month to lost invoices, undocumented cash collection, van stock shrinkage and manual data entry. An educational estimate, free and shareable. English: ${abs('/en/calculator/')} · French: ${abs('/fr/calculator/')}
- [${FREE_INDEX.h1}](${abs('/free/')}): ${FREE_INDEX.intro}
`);
  for (const t of FREE_TOOLS) add(`- [${t.title}](${toolUrl(t)}): ${t.desc}\n`);
  add(`- [نماذج Excel للمناديب](${abs('/نماذج/')}): free Excel templates (Arabic) for daily distribution paperwork.\n`);
  for (const t of TEMPLATES) add(`- [${t.title}](${templateUrl(t)}): ${t.purpose}\n`);

  const cc = (a) => CAT.get(a.slug)?.cc ?? null;
  const pillarsEn = en.filter((a) => !cc(a) && !a.slug.startsWith('best-'));
  const hubsEn = en.filter((a) => a.slug.startsWith('field-sales-software-'));
  const hubsAr = ar.filter((a) => a.slug.startsWith('field-sales-software-'));
  const bestEn = en.filter((a) => a.slug.startsWith('best-field-sales-software'));
  add(`
## Guides (pillar articles)

${pillarsEn.map((a) => catalogLine(a, 'en')).join('')}
## Country guides (English)

${hubsEn.map((a) => catalogLine(a, 'en', 'last')).join('')}
## أدلة الدول بالعربية

${hubsAr.map((a) => catalogLine(a, 'ar', 'last')).join('')}
## Best / comparison guides (buyer intent)

${bestEn.map((a, i) => (i === 0 ? catalogLine(a, 'en') : `- [${a.title}](${blogUrl(a.slug, 'en')})\n`)).join('')}`);

  // روابط الأجوبة لا تُضاف إلى KNOWN: الفحص الأخير يتحقق أنها صفحات قانونية معروفة (خطأ مسار في answers.mjs يوقف التوليد)
  const answerLine = (x) => `- **${x.q}** ${x.a}${x.href ? ` [${x.label || x.href}](${abs(x.href)})` : ''}\n`;
  add(`
## أسئلة شائعة بالعربية (إجابات قابلة للاقتباس)

${answersFor('ar', { tiers }).map(answerLine).join('')}
## Common questions (quotable answers)

${answersFor('en', { tiers }).map(answerLine).join('')}
## Main pages

- [Home (Arabic)](${abs('/')}): product overview, features, pricing and FAQ.
- [Home (English)](${abs('/en/')}) · [French](${abs('/fr/')}) · [Turkish](${abs('/tr/')}) · [Chinese](${abs('/zh/')})
- [About](${abs('/about/')}): who is behind FieldSales. English: ${abs('/en/about/')}
- [Contact](${abs('/contact/')}): sales and support. English: ${abs('/en/contact/')}
- [Blog (Arabic)](${abs('/blog/')}): guides for distributors in Arab markets. English: ${abs('/en/blog/')} · French: ${abs('/fr/blog/')}

## Company

- Name: فيلد سيلز / FieldSales (also written Field Sales), website fieldsa.net. One brand for the company and the product.
- Headquarters: Riyadh, Saudi Arabia. Founded: 2026. Founder: Ali Aloraini.
- Contact: info@fieldsa.net (sales), help@fieldsa.net (support), phone +966590633827${cms?.contact?.whatsapp ? `, WhatsApp ${cms.contact.whatsapp}` : ''}.
- Official profiles: ${OFFICIAL_LINKS.map((l) => `${l.label} ${l.href}`).join(' · ')}
`);

  // مختارات المدوّنة: قائمة ثابتة مختارة (لا ترتيب CMS)، وكل مقال يُبرَز فقط إن صحّ نصّه كله
  const HIGHLIGHTS = [
    'how-to-create-free-tax-invoice-qr', 'how-much-distribution-companies-lose', 'field-collection-overdue-receivables',
    'prevent-fake-visits-gps-spoofing', 'sales-reps-permissions', 'distribution-reps-commissions', 'rep-manipulation-patterns',
    'simplified-vs-tax-invoice', 'cashvan-vs-presales', 'distributor-management-system', 'erp-accounting-integration',
    'multitenant-data-security',
  ];
  const highlights = [];
  for (const slug of HIGHLIGHTS) {
    if (!featured(slug, 'ar')) continue;
    const p = POST.get(slug);
    const d = manualDesc(p);
    const head = `- [${p.title}](${blogUrl(slug, 'ar')})`;
    const enLine = manualListed(slug, 'en') && featured(slug, 'en') ? `  English: [${p.en.title}](${blogUrl(slug, 'en')})\n` : '';
    // كتلة واحدة للنسختين: إن تنازلت العربية لا يبقى سطر الإنجليزية معلّقاً تحت مقال غيره
    highlights.push(fromCms(`ar/${slug}`, ...new Set([`${head}${d ? `: ${d}` : ''}\n${enLine}`, `${head}\n${enLine}`, `${head}\n`])));
  }
  if (highlights.length) {
    add(`
## Blog highlights

`);
    B.push(...highlights);
  }

  // بحث أصلي: تقرير السوق بلا أرقامه (حسبته في CMS تنتظر التصحيح)، ويُبرَز إن صحّ نصّه كله
  const REPORT = 'field-sales-software-market-report-2026';
  if (featured(REPORT, 'ar')) {
    B.push(fromCms(`ar/${REPORT}`, `
## Original research

- [${POST.get(REPORT).title}](${blogUrl(REPORT, 'ar')}): Arabic market survey of field sales software vendors: how many publish prices, per-company versus per-user pricing, e-invoicing readiness and the survey method.
`));
  }

  add(`
## Optional

- [Full index](${ORIGIN}/llms-full.txt): every canonical guide in Arabic, English and French with its direct answer (${ar.length + en.length + fr.length} pages), plus every blog post.
- [Sitemap](${ORIGIN}/sitemap.xml)
`);

  const llms = guarded('llms.txt', B);

  // ── llms-full.txt ──
  // كل مدخل كتالوج يحمل إجابته المختصرة لا رابطه فقط: محرّك التوليد يقرأ هذا الملف ثم يجيب، فإن لم يجد
  // نصّاً قابلاً للاقتباس لم يتبع الرابط غالباً. والمقال اليدوي بوصفه النظيف من CMS ورابطه الإنجليزي إن وُجد.
  const F = [];
  const addF = (s) => F.push(fixed(s));
  addF(`# FieldSales (فيلد سيلز): full index of canonical pages (updated ${UPDATED})

> Every canonical page on fieldsa.net for distribution companies in Arab markets: product pages, generated guides in Arabic, English and French with a direct answer each, and blog posts. Curated overview: ${ORIGIN}/llms.txt

Pricing: ${PRICING_LINE}

## Product pages

- [Pricing](${abs('/pricing/')}) · [English](${abs('/en/pricing/')}) · [French](${abs('/fr/pricing/')})
- [Rep app](${abs('/rep-app/')})
${FEATURES.map((ft) => `- [${ft.name}](${featureUrl(ft)}): ${ft.title || ft.h1}`).join('\n')}
${SECTORS.map((s) => `- [برنامج مناديب لموزعي ${s.name}](${sectorUrl(s)})`).join('\n')}
${FREE_TOOLS.map((t) => `- [${t.title}](${toolUrl(t)}): ${t.desc}`).join('\n')}
${TEMPLATES.map((t) => `- [${t.title}](${templateUrl(t)}): ${t.purpose}`).join('\n')}
- [Free tax invoice generator](${abs('/invoice-generator/')}) · [Revenue leak calculator](${abs('/calculator/')})
`);
  const section = (label, list, L) => {
    addF(`\n## ${label}\n\n`);
    for (const a of list) {
      const ans = shortAnswer(a.slug, L);
      addF(`- [${a.title}](${blogUrl(a.slug, L)})${ans ? `\n  ${ans}` : ''}\n`);
    }
  };
  section('Articles (العربية)', ar, 'ar');
  section('Articles (English)', en, 'en');
  section('Articles (Français)', fr, 'fr');

  const byNewest = [...posts].sort((x, y) => (mod.lastModifiedOf(y) || '').localeCompare(mod.lastModifiedOf(x) || ''));
  const skipped = [];
  for (const [L, label] of [['ar', 'Blog posts (العربية)'], ['en', 'Blog posts (English)']]) {
    addF(`\n## ${label}\n\n`);
    for (const p of byNewest) {
      if (!manualListed(p.slug, L)) continue;
      const v = viewOf(p, L);
      const bad = problemsOf(v.title, { offline: false });
      if (bad.length) { skipped.push(`${L}/${p.slug} (${bad.join('، ')})`); continue; }
      const u = blogUrl(p.slug, L);
      const d = manualDesc(v);
      F.push(fromCms(`${L}/${p.slug}`, `- [${v.title}](${u})${d ? `\n  ${d}` : ''}\n`, `- [${v.title}](${u})\n`));
    }
  }
  const full = guarded('llms-full.txt', F);

  // ── كل رابط إلى الموقع في المخرجين صفحة قانونية معروفة ──
  for (const [name, text] of [['llms.txt', llms], ['llms-full.txt', full]]) {
    const urls = [...text.matchAll(/https:\/\/fieldsa\.net[^\s)\]»"'<>·,]*/g)].map((m) => m[0].replace(/[.:;]+$/, ''));
    const strays = [...new Set(urls.filter((u) => !KNOWN.has(u) && !NON_PAGE.has(u)))];
    if (strays.length) {
      console.error(`✗ ${name}: روابط ليست صفحات قانونية معروفة:`);
      for (const u of strays.slice(0, 10)) console.error(`    ${u}`);
      process.exit(1);
    }
  }

  if (held.length) console.log(`  صفحات CMS لم تُبرَز حتى تُصحَّح (docs/owner-actions.md §٨): ${[...new Set(held)].join(' · ')}`);
  if (skipped.length) console.log(`  مقالات CMS خارج الفهرس الكامل لعنوانها: ${skipped.join(' · ')}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'llms.txt'), llms, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'llms-full.txt'), full, 'utf8');
  const kb = (s) => `${(Buffer.byteLength(s, 'utf8') / 1024).toFixed(1)}KB/${s.length} حرفاً`;
  console.log(`  ✅ llms.txt (${kb(llms)}) + llms-full.txt (${kb(full)}) — ${ar.length}/${en.length}/${fr.length} مقالاً مولَّداً قانونياً، محدَّث ${UPDATED} ← ${path.relative(ROOT, OUT_DIR) || OUT_DIR}`);
}

main().catch((e) => { console.error('✗ تعذّر توليد llms.txt:', e?.stack || e); process.exit(1); });
