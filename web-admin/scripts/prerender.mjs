// تصيير مسبق (Prerender) بلا متصفّح — يولّد HTML ثابتاً لكل مقال وصفحة مدوّنة من مولّد المقالات.
// النتيجة: dist/blog/{slug}/index.html (+ /en, /fr) تحوي الوسوم الصحيحة (title/description/OG/hreflang/JSON-LD)
// والمحتوى الكامل — فيراها Google وكاشطو التواصل (فيسبوك/واتساب) بلا حاجة لتشغيل JavaScript.
// يعمل كـ postbuild (بعد vite build) — سريع (ثوانٍ) وحتمي، فلا يُبطئ بناء Vercel.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCatalog, getArticle, listArticles, COUNTRIES } from '../src/blog/seo/catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const ORIGIN = 'https://fieldsa.net';
const LANGS = ['ar', 'en', 'fr'];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const template = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

// يستبدل وسوم <head> الافتراضية بقيم الصفحة، ويحقن hreflang + JSON-LD + المحتوى
function buildPage({ lang, title, description, keywords, canonical, image, ogType = 'website', hreflang = '', jsonLd = null, bodyHtml = '' }) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const ogLocale = lang === 'en' ? 'en_US' : lang === 'fr' ? 'fr_FR' : 'ar_SA';
  let h = template;
  h = h.replace(/<html[^>]*>/, `<html lang="${lang}" dir="${dir}">`);
  h = h.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  h = h.replace(/(<meta name="description" content=")[\s\S]*?("\s*\/>)/, `$1${esc(description)}$2`);
  if (keywords) h = h.replace(/(<meta name="keywords" content=")[\s\S]*?("\s*\/>)/, `$1${esc(keywords)}$2`);
  h = h.replace(/(<link rel="canonical" href=")[^"]*("\s*\/>)/, `$1${canonical}$2`);
  h = h.replace(/(<meta property="og:type" content=")[^"]*("\s*\/>)/, `$1${ogType}$2`);
  h = h.replace(/(<meta property="og:title" content=")[\s\S]*?("\s*\/>)/, `$1${esc(title)}$2`);
  h = h.replace(/(<meta property="og:description" content=")[\s\S]*?("\s*\/>)/, `$1${esc(description)}$2`);
  h = h.replace(/(<meta property="og:url" content=")[^"]*("\s*\/>)/, `$1${canonical}$2`);
  h = h.replace(/(<meta property="og:image" content=")[^"]*("\s*\/>)/, `$1${image}$2`);
  h = h.replace(/(<meta property="og:locale" content=")[^"]*("\s*\/>)/, `$1${ogLocale}$2`);
  h = h.replace(/(<meta name="twitter:title" content=")[\s\S]*?("\s*\/>)/, `$1${esc(title)}$2`);
  h = h.replace(/(<meta name="twitter:description" content=")[\s\S]*?("\s*\/>)/, `$1${esc(description)}$2`);
  h = h.replace(/(<meta name="twitter:image" content=")[^"]*("\s*\/>)/, `$1${image}$2`);
  const extra = hreflang + (jsonLd ? `\n    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '');
  h = h.replace('</head>', `${extra}\n  </head>`);
  if (bodyHtml) h = h.replace(/<div id="root">\s*<\/div>/, `<div id="root">${bodyHtml}</div>`);
  return h;
}

function writeRoute(routePath, html) {
  const dir = path.join(DIST, routePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}

const trilingualHreflang = (blogPath) => LANGS
  .map((L) => `\n    <link rel="alternate" hreflang="${L}" href="${ORIGIN}${L === 'ar' ? '' : '/' + L}${blogPath}"/>`)
  .join('') + `\n    <link rel="alternate" hreflang="x-default" href="${ORIGIN}${blogPath}"/>`;

const tr = (L, ar, en, fr) => (L === 'ar' ? ar : L === 'en' ? en : fr);

function articleJsonLd(a, lang, canonical) {
  const prefix = lang === 'ar' ? '' : `/${lang}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Article', headline: a.title, description: a.description, inLanguage: lang, datePublished: a.date, dateModified: a.date, image: a.image, author: { '@type': 'Organization', name: 'FieldSales' }, publisher: { '@type': 'Organization', name: 'FieldSales', logo: { '@type': 'ImageObject', url: `${ORIGIN}/icons/icon-512.png` } }, mainEntityOfPage: canonical },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: tr(lang, 'الرئيسية', 'Home', 'Accueil'), item: `${ORIGIN}${prefix || ''}` },
        { '@type': 'ListItem', position: 2, name: tr(lang, 'المدوّنة', 'Blog', 'Blog'), item: `${ORIGIN}${prefix}/blog` },
        { '@type': 'ListItem', position: 3, name: a.title, item: canonical },
      ] },
      ...(a.faq && a.faq.length ? [{ '@type': 'FAQPage', mainEntity: a.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
    ],
  };
}

function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('لا يوجد dist/index.html — شغّل vite build أولاً'); process.exit(0); }
  let n = 0;

  // 1) المقالات (900) — محتوى كامل + وسوم + JSON-LD
  for (const { slug } of buildCatalog()) {
    for (const L of LANGS) {
      const a = getArticle(slug, L);
      if (!a) continue;
      const prefix = L === 'ar' ? '' : `/${L}`;
      const canonical = `${ORIGIN}${prefix}/blog/${slug}`;
      const brand = tr(L, 'مدوّنة FieldSales', 'FieldSales Blog', 'Blog FieldSales');
      const body = `<main><article><h1>${esc(a.title)}</h1><img src="${a.imagePath}" alt="${esc(a.title)}" width="1200" height="630"/>${a.contentHtml}</article></main>`;
      const html = buildPage({
        lang: L, title: `${a.title} | ${brand}`, description: a.description, keywords: a.keywords,
        canonical, image: a.image, ogType: 'article',
        hreflang: trilingualHreflang(`/blog/${slug}`), jsonLd: articleJsonLd(a, L, canonical), bodyHtml: body,
      });
      writeRoute(`${prefix}/blog/${slug}`, html);
      n++;
    }
  }

  // 2) فهارس المدوّنة (ع/إ/فر) — وسوم + قائمة روابط للمقالات (زحف داخلي)
  for (const L of LANGS) {
    const prefix = L === 'ar' ? '' : `/${L}`;
    const canonical = `${ORIGIN}${prefix}/blog`;
    const title = tr(L, 'المدوّنة | FieldSales — مقالات المبيعات الميدانية والتوزيع في الدول العربية',
      'Blog | FieldSales — Field Sales & Distribution Articles across Arab Countries',
      'Blog | FieldSales — Articles sur la vente terrain et la distribution dans les pays arabes');
    const desc = tr(L, 'مئات المقالات والدلائل في إدارة المبيعات الميدانية والفوترة الإلكترونية والتوزيع لكل الدول العربية.',
      'Hundreds of guides on field sales, e-invoicing and distribution for every Arab country.',
      'Des centaines de guides sur la vente terrain, la facturation électronique et la distribution pour chaque pays arabe.');
    const links = listArticles(L).slice(0, 80).map((x) => `<li><a href="${prefix}/blog/${x.slug}">${esc(x.title)}</a></li>`).join('');
    const chips = COUNTRIES.map((c) => `<a href="${prefix}/blog/field-sales-software-${c.code.toLowerCase()}">${esc(c[L])}</a>`).join(' ');
    const body = `<main><h1>${esc(tr(L, 'مدوّنة FieldSales', 'FieldSales Blog', 'Blog FieldSales'))}</h1><nav>${chips}</nav><ul>${links}</ul></main>`;
    const html = buildPage({ lang: L, title, description: desc, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang('/blog'), bodyHtml: body });
    writeRoute(`${prefix}/blog`, html);
    n++;
  }

  // 3) الصفحة الرئيسية بالإنجليزية والفرنسية — وسوم صحيحة (العربية أصلاً في dist/index.html)
  const homeMeta = {
    en: { title: 'FieldSales | Field Sales & Distribution Management Software for Arab Markets', desc: 'Arabic-first field sales system for distributors across Saudi Arabia, Egypt and the Arab world: tax invoices, collection, van stock and rep tracking. Free 10-day trial.' },
    fr: { title: 'FieldSales | Logiciel de gestion des ventes terrain et distribution', desc: 'Système de vente terrain pour les distributeurs en Arabie saoudite, en Égypte et dans le monde arabe : factures, encaissement, stock et suivi. Essai gratuit 10 jours.' },
  };
  for (const L of ['en', 'fr']) {
    const canonical = `${ORIGIN}/${L}`;
    const html = buildPage({ lang: L, title: homeMeta[L].title, description: homeMeta[L].desc, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang('/') });
    writeRoute(`/${L}`, html);
    n++;
  }

  console.log(`✅ prerender: ${n} صفحة ثابتة (900 مقال × لا، بل ${buildCatalog().length}×3 + فهارس + رئيسية en/fr) في dist/`);
}

main();
