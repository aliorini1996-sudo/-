// تدقيق SEO آلي للموقع — يفحص العناوين/الوصف/canonical/hreflang/الخريطة/البيانات المنظّمة/تغطية الصفحات.
// يُشغَّل يدوياً (npm run seo:audit) وضمن الصيانة المجدولة. يُنهي بكود 1 عند وجود أخطاء (لاستخدام CI).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0, warns = 0, fails = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const warn = (m) => { warns++; console.log('  ⚠️  ' + m); };
const fail = (m) => { fails++; console.log('  ❌ ' + m); };
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

  // تبادل hreflang: كل href بديل يجب أن يظهر كـ<loc>
  const altHrefs = [...sm.matchAll(/hreflang="(?:ar|en)"\s+href="([^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(altHrefs)].filter((h) => !locs.includes(h));
  missing.length ? fail(`روابط hreflang غير موجودة كـ<loc>: ${missing.join(', ')}`) : ok('تبادل hreflang سليم (ar↔en)');
  sm.includes('xmlns:xhtml') ? ok('مساحة أسماء xhtml معرّفة') : warn('لا توجد مساحة xhtml لـhreflang');

  // تغطية مقالات المدوّنة من posts.ts
  const postsSrc = read('src/blog/posts.ts');
  const slugs = [...postsSrc.matchAll(/slug:\s*'([^']+)'/g)].map((m) => m[1]);
  const notInSitemap = slugs.filter((s) => !sm.includes(`/blog/${s}`));
  notInSitemap.length ? warn(`مقالات غير مدرجة في الخريطة: ${notInSitemap.join(', ')}`) : ok(`كل مقالات المدوّنة (${slugs.length}) مدرجة`);
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
if (fails > 0) { console.log('يوجد أخطاء SEO تحتاج إصلاحاً.'); process.exit(1); }
console.log('SEO سليم ✅');
