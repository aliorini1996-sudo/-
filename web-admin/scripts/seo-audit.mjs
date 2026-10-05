// تدقيق SEO آلي للموقع — يفحص العناوين/الوصف/canonical/hreflang/الخريطة/البيانات المنظّمة/تغطية الصفحات.
// يُشغَّل يدوياً (npm run seo:audit) وضمن الصيانة المجدولة. يُنهي بكود 1 عند وجود أخطاء (لاستخدام CI).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CMS_API = 'https://api.fieldsa.net/api/site-content';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0, warns = 0, fails = 0;
const notes = []; // التحذيرات والأخطاء لملخص وركفلو الصيانة (GITHUB_STEP_SUMMARY)
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const warn = (m) => { warns++; notes.push('⚠️ ' + m); console.log('  ⚠️  ' + m); };
const fail = (m) => { fails++; notes.push('❌ ' + m); console.log('  ❌ ' + m); };
const section = (t) => console.log('\n▶ ' + t);

// ===== 1) index.html =====
section('index.html — الوسوم الأساسية');
const html = read('index.html');
const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
title ? ok(`عنوان موجود (${title.length} حرف)`) : fail('لا يوجد <title>');
if (title.length > 65) warn(`العنوان طويل (${title.length}) — يُفضّل ≤ 60`);
const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
if (!desc) fail('لا يوجد meta description');
else if (desc.length < 50 || desc.length > 165) warn(`طول الوصف ${desc.length} — يُفضّل 50–160`);
else ok(`وصف موجود (${desc.length} حرف)`);
html.includes('rel="canonical"') ? ok('canonical موجود') : fail('لا يوجد canonical');
html.includes('property="og:image"') ? ok('Open Graph image موجود') : warn('لا يوجد og:image');
html.includes('name="twitter:card"') ? ok('Twitter Card موجود') : warn('لا يوجد twitter:card');
html.includes('name="viewport"') ? ok('viewport موجود') : fail('لا يوجد viewport');
html.includes('name="keywords"') ? ok('keywords موجودة') : warn('لا يوجد meta keywords');
html.includes('rel="icon"') ? ok('أيقونة (favicon) مربوطة') : fail('لا يوجد rel="icon"');

// JSON-LD صالح + featureList
section('البيانات المنظّمة (JSON-LD)');
const ld = (html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
if (!ld) fail('لا يوجد JSON-LD');
else try {
  const j = JSON.parse(ld);
  const graph = j['@graph'] || [j];
  ok(`JSON-LD صالح (${graph.length} عناصر)`);
  const sw = graph.find((n) => n['@type'] === 'SoftwareApplication');
  if (sw?.featureList?.length) ok(`featureList فيه ${sw.featureList.length} خدمة`);
  else warn('SoftwareApplication بلا featureList');
  graph.find((n) => n['@type'] === 'Organization') ? ok('Organization موجود') : warn('لا يوجد Organization');
} catch (e) { fail('JSON-LD غير صالح: ' + e.message); }

// ===== 2) robots.txt =====
section('robots.txt');
if (!exists('public/robots.txt')) fail('لا يوجد robots.txt');
else {
  const r = read('public/robots.txt');
  r.includes('Sitemap:') ? ok('يشير إلى sitemap') : fail('لا يشير إلى Sitemap');
  /Disallow:\s*\/\s*$/m.test(r) ? fail('يحجب الموقع كاملاً (Disallow: /)') : ok('لا يحجب الموقع كاملاً');
}

// ===== 3) sitemap.xml =====
section('sitemap.xml — التغطية و hreflang');
if (!exists('public/sitemap.xml')) fail('لا يوجد sitemap.xml');
else {
  const sm = read('public/sitemap.xml');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(`عدد الروابط: ${locs.length}`);
  locs.some((l) => l.includes('localhost')) ? fail('يحتوي روابط localhost') : ok('كل الروابط مطلقة (لا localhost)');
  locs.every((l) => l.startsWith('https://')) ? ok('كل الروابط https') : fail('توجد روابط غير https');

  // تبادل hreflang لكل اللغات المعلنة (لا ar↔en وحدها — كانت بدائل fr/tr/zh-Hans تمرّ بلا فحص):
  // كل href بديل يجب أن يظهر كـ<loc>، وكل رابط في عنقود يذكر نفسه فيه (شرط جوجل للعنقود).
  const norm = (u) => { try { return new URL(u).href; } catch { return u; } };
  const locSet = new Set(locs.map(norm));
  const blocks = [...sm.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const altPairs = blocks.flatMap((b) => [...b.matchAll(/<xhtml:link\b[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const langs = [...new Set(altPairs.map(([l]) => l))].sort();
  const missing = [...new Set(altPairs.map(([, h]) => h))].filter((h) => !locSet.has(norm(h)));
  missing.length
    ? fail(`روابط hreflang غير موجودة كـ<loc> (${missing.length}): ${missing.slice(0, 8).map(decodeURI).join(', ')}`)
    : ok(`تبادل hreflang سليم لكل اللغات المعلنة (${langs.join('، ') || '—'})`);
  const noSelf = blocks.filter((b) => /<xhtml:link\b/.test(b)).map((b) => {
    const loc = (b.match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1];
    const hrefs = [...b.matchAll(/<xhtml:link\b[^>]*href="([^"]+)"/g)].map((m) => norm(m[1]));
    return loc && !hrefs.includes(norm(loc)) ? loc : null;
  }).filter(Boolean);
  noSelf.length
    ? fail(`روابط بعنقود hreflang لا يذكرها (${noSelf.length}): ${noSelf.slice(0, 5).map(decodeURI).join(', ')}`)
    : ok('كل رابط في عنقود hreflang يذكر نفسه فيه');
  sm.includes('xmlns:xhtml') ? ok('مساحة أسماء xhtml معرّفة') : warn('لا توجد مساحة xhtml لـhreflang');

  // تغطية مقالات المدوّنة: من CMS الحيّ (المصدر الذي يراه الزائر — 122 مقالاً في أكتوبر 2026) لا من posts.ts
  // (احتياطي فيه 14 مقالاً فقط، فكان الفحص يطمئن على أقل من ثُمن المدوّنة). المدموجة في غيرها
  // (src/blog/consolidate.mjs) تخرج من الخريطة عمداً فلا تُعدّ غائبة.
  let posts = null;
  let source = 'CMS الحيّ';
  try {
    const r = await fetch(CMS_API, { signal: AbortSignal.timeout(10000) });
    const blog = (await r.json())?.data?.blog;
    if (Array.isArray(blog) && blog.length) {
      posts = blog.filter((p) => p && p.slug && p.title).map((p) => ({ slug: p.slug, en: !!(p.en && p.en.title) }));
    }
  } catch { /* الاحتياطي أدناه */ }
  if (!posts) {
    source = 'posts.ts (تعذّر جلب CMS)';
    const postsSrc = read('src/blog/posts.ts');
    posts = [...postsSrc.matchAll(/slug:\s*'([^']+)'/g)].map((m) => ({ slug: m[1], en: false }));
    warn('تعذّر جلب مقالات CMS — فُحصت تغطية الاحتياطي posts.ts وحده');
  }
  let isConsolidated = () => false;
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/blog/consolidate.mjs')).href);
    if (typeof mod.isConsolidated === 'function') isConsolidated = mod.isConsolidated;
  } catch { /* لا دمج بعد */ }
  const has = (p) => locSet.has(norm(`https://fieldsa.net${p}/`));
  const absent = [];
  let merged = 0;
  for (const p of posts) {
    for (const L of p.en ? ['ar', 'en'] : ['ar']) {
      if (isConsolidated(p.slug, L)) { merged++; continue; }
      const loc = `${L === 'ar' ? '' : '/en'}/blog/${p.slug}`;
      if (!has(loc)) absent.push(loc);
    }
  }
  absent.length
    ? warn(`مقالات غير مدرجة في الخريطة (${absent.length} من ${source}): ${absent.slice(0, 10).join(', ')}`)
    : ok(`كل مقالات المدوّنة (${posts.length} من ${source}) مدرجة${merged ? ` — عدا ${merged} مدموجة عمداً` : ''}`);
}

// ===== 4) تغطية useSeo للصفحات العامة =====
section('تغطية SEO لكل صفحة عامّة (useSeo)');
const publicPages = ['LandingPage', 'InfoPage', 'ContactPage', 'BlogIndexPage', 'BlogPostPage'];
for (const pg of publicPages) {
  const f = `src/pages/${pg}.tsx`;
  if (!exists(f)) { warn(`${pg} غير موجود`); continue; }
  read(f).includes('useSeo') ? ok(`${pg} يضبط SEO`) : fail(`${pg} لا يستدعي useSeo`);
}

// ===== 5) أصول SEO =====
section('أصول SEO');
exists('public/og-image.png') ? ok('og-image.png موجود') : warn('لا يوجد og-image.png');
exists('public/favicon.ico') ? ok('favicon.ico موجود') : fail('لا يوجد favicon.ico');

// ===== الخلاصة =====
console.log(`\n══════════════════════════════\nالنتيجة: ✅ ${pass} ناجح · ⚠️ ${warns} تحذير · ❌ ${fails} خطأ\n══════════════════════════════`);
// في GitHub Actions: الخلاصة وبنودها في صفحة التشغيل نفسها — كانت التحذيرات تُطبع في سجلّ لا يفتحه أحد
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### تدقيق SEO\n\n✅ ${pass} ناجح · ⚠️ ${warns} تحذير · ❌ ${fails} خطأ\n\n${notes.map((n) => `- ${n}`).join('\n')}\n\n`);
  } catch { /* الملخص اختياري */ }
}
if (fails > 0) { console.log('يوجد أخطاء SEO تحتاج إصلاحاً.'); process.exit(1); }
console.log('SEO سليم ✅');
