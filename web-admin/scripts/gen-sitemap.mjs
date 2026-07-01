// يولّد public/sitemap.xml آلياً من المسارات + روابط hreflang (عربي/إنجليزي) + مقالات المدوّنة.
// مصادر المقالات: محتوى الـCMS الحيّ (إن وُجد) وإلا الافتراضية من src/blog/posts.ts.
// يُشغَّل عند كل بناء (prebuild) وفي الصيانة المجدولة. لا اتصال مباشر بقاعدة البيانات — يستخدم الـAPI العام فقط.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'https://fieldsa.net';
const API = 'https://api.fieldsa.net/api/site-content';
const today = new Date().toISOString().slice(0, 10);

// صفحات تسويقية لها نسختان (عربي + /en) مع hreflang
const I18N_ROUTES = [
  { p: '/', priority: '1.0', freq: 'weekly' },
  { p: '/about', priority: '0.7', freq: 'monthly' },
  { p: '/contact', priority: '0.7', freq: 'monthly' },
  { p: '/terms', priority: '0.3', freq: 'yearly' },
  { p: '/privacy', priority: '0.3', freq: 'yearly' },
  { p: '/service-agreement', priority: '0.3', freq: 'yearly' },
];

// يقرأ مقالات المدوّنة الافتراضية (slug + date + ثنائي اللغة) من posts.ts
function staticPosts() {
  const src = fs.readFileSync(path.join(ROOT, 'src/blog/posts.ts'), 'utf8');
  const start = src.indexOf('export const POSTS');
  const body = start >= 0 ? src.slice(start) : src;
  const out = [];
  // محايد للأقواس (مفردة أو مزدوجة) — يدعم المقالات المكتوبة يدوياً والمولَّدة تلقائياً
  for (const ch of body.split(/slug:\s*['"]/).slice(1)) {
    const q = ch.search(/['"]/);
    const slug = q >= 0 ? ch.slice(0, q) : '';
    const dm = ch.match(/date:\s*['"]([^'"]+)['"]/);
    if (slug) out.push({ slug, date: dm ? dm[1] : today, bilingual: /\n\s*en:\s*\{/.test(ch) });
  }
  return out;
}

// يحاول جلب مقالات الـCMS الحيّة (نفس ما يراه الزائر)؛ يعود للافتراضية عند الفشل
async function effectivePosts() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(API, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    const blog = j?.data?.blog;
    if (Array.isArray(blog) && blog.length) {
      const valid = blog.filter((p) => p && p.slug && p.title)
        .map((p) => ({ slug: p.slug, date: p.date || today, bilingual: !!(p.en && p.en.title) }));
      if (valid.length) { console.log(`  مصدر المقالات: CMS الحيّ (${valid.length})`); return valid; }
    }
  } catch (e) {
    console.log('  تعذّر جلب CMS (' + e.message + ') — استخدام الافتراضية');
  }
  const s = staticPosts();
  console.log(`  مصدر المقالات: الافتراضية من posts.ts (${s.length})`);
  return s;
}

// روابط hreflang لمسار مدوّنة (عربي + /en)
const blogAlt = (p) => [
  `    <xhtml:link rel="alternate" hreflang="ar" href="${ORIGIN}${p}"/>`,
  `    <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}/en${p}"/>`,
  `    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${p}"/>`,
].join('\n');

const alt = (arPath) => {
  const suffix = arPath === '/' ? '' : arPath;
  const ar = ORIGIN + (arPath === '/' ? '/' : arPath);
  const en = ORIGIN + '/en' + suffix;
  return [
    `    <xhtml:link rel="alternate" hreflang="ar" href="${ar}"/>`,
    `    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>`,
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${ar}"/>`,
  ].join('\n');
};

const urlEntry = (loc, { lastmod = today, freq = 'monthly', priority = '0.6', alternates = '' } = {}) =>
  `  <url>\n    <loc>${loc}</loc>\n${alternates ? alternates + '\n' : ''}    <lastmod>${lastmod}</lastmod>\n    <changefreq>${freq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

async function main() {
  const posts = await effectivePosts();
  const urls = [];

  // الصفحات التسويقية: نسخة عربية + نسخة /en، كلٌّ يحمل كل بدائل hreflang
  for (const r of I18N_ROUTES) {
    const alternates = alt(r.p);
    urls.push(urlEntry(ORIGIN + (r.p === '/' ? '/' : r.p), { freq: r.freq, priority: r.priority, alternates }));
    urls.push(urlEntry(ORIGIN + '/en' + (r.p === '/' ? '' : r.p), { freq: r.freq, priority: r.priority, alternates }));
  }

  // فهرس المدوّنة (عربي + /en مع hreflang)
  const idxAlt = blogAlt('/blog');
  urls.push(urlEntry(ORIGIN + '/blog', { freq: 'weekly', priority: '0.8', alternates: idxAlt }));
  urls.push(urlEntry(ORIGIN + '/en/blog', { freq: 'weekly', priority: '0.8', alternates: idxAlt }));

  // المقالات: ثنائية اللغة تُنشر بنسختين مع hreflang؛ والعربية فقط بنسخة واحدة
  for (const p of posts) {
    const arLoc = `/blog/${p.slug}`;
    if (p.bilingual) {
      const a = blogAlt(arLoc);
      urls.push(urlEntry(ORIGIN + arLoc, { lastmod: p.date, freq: 'monthly', priority: '0.7', alternates: a }));
      urls.push(urlEntry(ORIGIN + '/en' + arLoc, { lastmod: p.date, freq: 'monthly', priority: '0.7', alternates: a }));
    } else {
      urls.push(urlEntry(ORIGIN + arLoc, { lastmod: p.date, freq: 'monthly', priority: '0.7' }));
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, 'public/sitemap.xml'), xml);
  console.log(`✅ sitemap.xml: ${urls.length} رابط (${I18N_ROUTES.length * 2} تسويقية + 1 فهرس مدوّنة + ${posts.length} مقال)`);
}

// لا يُفشل البناء أبداً — عند أي خطأ يبقى sitemap.xml الحالي كما هو
main().catch((e) => { console.error('تعذّر توليد sitemap (غير قاتل):', e.message); process.exit(0); });
