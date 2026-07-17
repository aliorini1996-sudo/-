// تصيير مسبق (Prerender) بلا متصفّح — يولّد HTML ثابتاً لكل مقال وصفحة مدوّنة من مولّد المقالات.
// النتيجة: dist/blog/{slug}/index.html (+ /en, /fr) تحوي الوسوم الصحيحة (title/description/OG/hreflang/JSON-LD)
// والمحتوى الكامل — فيراها Google وكاشطو التواصل (فيسبوك/واتساب) بلا حاجة لتشغيل JavaScript.
// يعمل كـ postbuild (بعد vite build) — سريع (ثوانٍ) وحتمي، فلا يُبطئ بناء Vercel.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { transformSync } from 'esbuild';
import { buildCatalog, getArticle, listArticles, COUNTRIES, modifiedOf } from '../src/blog/seo/catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const ORIGIN = 'https://fieldsa.net';
const LANGS = ['ar', 'en', 'fr'];
const CMS_API = 'https://api.fieldsa.net/api/site-content';

// يحمّل المقالات اليدوية من src/blog/posts.ts (بلا استيرادات — يُحوَّل TS→ESM عبر esbuild ويُستورد)،
// مع محاولة جلب مقالات الـCMS الحيّة أولاً (نفس ما يراه الزائر، كسلوك gen-sitemap) والعودة للافتراضية.
async function loadManualPosts() {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/blog/posts.ts'), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  const tmp = path.join(DIST, '_posts_tmp.mjs');
  fs.writeFileSync(tmp, code);
  const mod = await import(pathToFileURL(tmp).href);
  fs.unlinkSync(tmp);

  let cmsBlog = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(CMS_API, { signal: ctrl.signal });
    clearTimeout(t);
    cmsBlog = (await r.json())?.data?.blog ?? null;
    if (Array.isArray(cmsBlog) && cmsBlog.length) console.log(`  مقالات يدوية: CMS الحيّ (${cmsBlog.length})`);
  } catch { /* الافتراضية من posts.ts */ }

  return mod.effectivePosts(cmsBlog).map((p) => ({
    ...p,
    contentHtml: mod.normalizeContent(p.contentHtml),
    en: p.en && p.en.title ? { ...p.en, contentHtml: mod.normalizeContent(p.en.contentHtml) } : undefined,
  }));
}

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
  if (bodyHtml) h = h.replace(/<div id="root">\s*<\/div>/, `<div id="root"><div data-ssr>${bodyHtml}</div></div>`);
  return h;
}

function writeRoute(routePath, html) {
  const dir = path.join(DIST, routePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
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

const trilingualHreflang = (blogPath) => LANGS
  .map((L) => `\n    <link rel="alternate" hreflang="${L}" href="${canon(`${ORIGIN}${L === 'ar' ? '' : '/' + L}${blogPath}`)}"/>`)
  .join('') + `\n    <link rel="alternate" hreflang="x-default" href="${canon(ORIGIN + blogPath)}"/>`;

const tr = (L, ar, en, fr) => (L === 'ar' ? ar : L === 'en' ? en : fr);

function articleJsonLd(a, lang, canonical) {
  const prefix = lang === 'ar' ? '' : `/${lang}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Article', headline: a.title, description: a.description, inLanguage: lang, datePublished: a.date, dateModified: a.modified || a.date, image: a.image, author: { '@type': 'Organization', name: 'FieldSales' }, publisher: { '@type': 'Organization', name: 'FieldSales', logo: { '@type': 'ImageObject', url: `${ORIGIN}/icons/icon-512.png` } }, mainEntityOfPage: canonical },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: tr(lang, 'الرئيسية', 'Home', 'Accueil'), item: canon(`${ORIGIN}${prefix || ''}`) },
        { '@type': 'ListItem', position: 2, name: tr(lang, 'المدوّنة', 'Blog', 'Blog'), item: canon(`${ORIGIN}${prefix}/blog`) },
        { '@type': 'ListItem', position: 3, name: a.title, item: canonical },
      ] },
      ...(a.faq && a.faq.length ? [{ '@type': 'FAQPage', mainEntity: a.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : []),
      ...(a.howto && a.howto.length ? [{
        '@type': 'HowTo',
        name: tr(lang, `كيف تبدأ مع ${a.title}`, `How to get started with ${a.title}`, `Comment démarrer avec ${a.title}`),
        step: a.howto.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text })),
      }] : []),
    ],
  };
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('لا يوجد dist/index.html — شغّل vite build أولاً'); process.exit(0); }
  let n = 0;

  // المقالات اليدوية (posts.ts / CMS) — تُحمَّل مبكراً لتُستخدم في التصيير وفهرس المدوّنة
  const catalogSlugs = new Set(buildCatalog().map((x) => x.slug));
  const manual = (await loadManualPosts().catch((e) => {
    console.log('⚠️  تعذّر تحميل المقالات اليدوية (غير مانع): ' + e.message);
    return [];
  })).filter((p) => !catalogSlugs.has(p.slug)); // المولَّدة لها تصييرها الأغنى — لا تُدهس

  // 1) المقالات المولَّدة (~966) — محتوى كامل + وسوم + JSON-LD
  for (const { slug } of buildCatalog()) {
    for (const L of LANGS) {
      const a = getArticle(slug, L);
      if (!a) continue;
      const prefix = L === 'ar' ? '' : `/${L}`;
      const canonical = canon(`${ORIGIN}${prefix}/blog/${slug}`);
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

  // 1ب) المقالات اليدوية (posts.ts / CMS) — عربية دائماً + إنجليزية للثنائية، بمحتوى كامل
  //     (كانت قوقعة SPA فارغة لزواحف AI وكاشطي التواصل رغم وجودها في sitemap)
  const manualHreflang = (slug, bilingual) =>
    `\n    <link rel="alternate" hreflang="ar" href="${canon(`${ORIGIN}/blog/${slug}`)}"/>` +
    (bilingual ? `\n    <link rel="alternate" hreflang="en" href="${canon(`${ORIGIN}/en/blog/${slug}`)}"/>` : '') +
    `\n    <link rel="alternate" hreflang="x-default" href="${canon(`${ORIGIN}/blog/${slug}`)}"/>`;
  for (const p of manual) {
    for (const L of p.en ? ['ar', 'en'] : ['ar']) {
      const v = L === 'en' ? p.en : p;
      const prefix = L === 'ar' ? '' : '/en';
      const canonical = canon(`${ORIGIN}${prefix}/blog/${p.slug}`);
      const brand = L === 'ar' ? 'مدوّنة FieldSales' : 'FieldSales Blog';
      const image = `${ORIGIN}/og-image.png`;
      const body = `<main><article><h1>${esc(v.title)}</h1>${v.contentHtml}</article></main>`;
      const html = buildPage({
        lang: L, title: `${v.title} | ${brand}`, description: v.description, keywords: v.keywords,
        canonical, image, ogType: 'article',
        hreflang: manualHreflang(p.slug, !!p.en),
        jsonLd: articleJsonLd({ title: v.title, description: v.description, date: p.date, modified: modifiedOf(p.date), image }, L, canonical),
        bodyHtml: body,
      });
      writeRoute(`${prefix}/blog/${p.slug}`, html);
      n++;
    }
  }

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
    const manualLinks = L === 'fr' ? [] : manual
      .filter((p) => L === 'ar' || p.en)
      .map((p) => { const v = L === 'en' && p.en ? p.en : p; return `<li><a href="${prefix}/blog/${p.slug}/">${esc(v.title)}</a></li>`; });
    const links = [...manualLinks, ...listArticles(L).slice(0, 80).map((x) => `<li><a href="${prefix}/blog/${x.slug}/">${esc(x.title)}</a></li>`)].join('');
    const chips = COUNTRIES.map((c) => `<a href="${prefix}/blog/field-sales-software-${c.code.toLowerCase()}/">${esc(c[L])}</a>`).join(' ');
    const body = `<main><h1>${esc(tr(L, 'مدوّنة FieldSales', 'FieldSales Blog', 'Blog FieldSales'))}</h1><nav>${chips}</nav><ul>${links}</ul></main>`;
    const html = buildPage({ lang: L, title, description: desc, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang('/blog'), bodyHtml: body });
    writeRoute(`${prefix}/blog`, html);
    n++;
  }

  // 3) الصفحة الرئيسية بالإنجليزية والفرنسية — وسوم + محتوى دلالي مختصر (زواحف AI لا تُشغّل JavaScript)
  const homeMeta = {
    en: {
      title: 'FieldSales | Field Sales & Distribution Management Software for Arab Markets',
      desc: 'Arabic-first field sales system for distributors across Saudi Arabia, Egypt and the Arab world: tax invoices, collection, van stock and rep tracking. Free 10-day trial.',
      body: `<main><h1>FieldSales — field sales &amp; distribution management for Arab markets</h1>
<p>FieldSales is a SaaS platform for distribution companies: sales reps issue structured tax invoices (ZATCA-compliant QR in Saudi Arabia), collect payments, and manage van stock from a mobile app, while managers get live dashboards, GPS tracking and reports. Available in Arabic, English and French across all 22 Arab countries.</p>
<ul><li>Field tax invoicing with QR code and thermal printing</li><li>Collection, receivables and customer statements with credit limits</li><li>Van stock per rep with live variance detection</li><li>GPS rep tracking and route planning</li><li>Product catalog, price tiers and ERP integration</li></ul>
<h2>Contact &amp; subscription requests</h2>
<p>Official email: <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · Head office: Saudi Arabia · <a href="/en/subscribe-request">Submit a subscription request</a> or <a href="/signup">start the free trial</a> directly.</p>
<p><a href="/signup">Start your free 10-day trial</a> — no credit card required. <a href="/en/blog">Read the blog</a> · <a href="/en/about">About</a> · <a href="/en/contact">Contact</a></p></main>`,
    },
    fr: {
      title: 'FieldSales | Logiciel de gestion des ventes terrain et distribution',
      desc: 'Système de vente terrain pour les distributeurs en Arabie saoudite, en Égypte et dans le monde arabe : factures, encaissement, stock et suivi. Essai gratuit 10 jours.',
      body: `<main><h1>FieldSales — gestion des ventes terrain et de la distribution pour les marchés arabes</h1>
<p>FieldSales est une plateforme SaaS pour les entreprises de distribution : les commerciaux émettent des factures structurées à code QR, encaissent les paiements et gèrent le stock du véhicule depuis une application mobile, tandis que les gérants disposent de tableaux de bord en direct, du suivi GPS et de rapports. Disponible en arabe, anglais et français dans les 22 pays arabes.</p>
<ul><li>Facturation terrain avec code QR et impression thermique</li><li>Encaissement, créances et relevés clients avec limites de crédit</li><li>Stock du véhicule par commercial avec détection des écarts</li><li>Suivi GPS et planification des tournées</li><li>Catalogue produits, grilles tarifaires et intégration ERP</li></ul>
<h2>Contact et demandes d'abonnement</h2>
<p>E-mail officiel : <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · Siège social : Arabie saoudite · <a href="/fr/subscribe-request">Envoyez une demande d'abonnement</a> ou <a href="/signup">commencez l'essai gratuit</a>.</p>
<p><a href="/signup">Essai gratuit de 10 jours</a> — sans carte bancaire. <a href="/fr/blog">Blog</a> · <a href="/fr/about">À propos</a> · <a href="/fr/contact">Contact</a></p></main>`,
    },
  };
  for (const L of ['en', 'fr']) {
    const canonical = canon(`${ORIGIN}/${L}`);
    const html = buildPage({ lang: L, title: homeMeta[L].title, description: homeMeta[L].desc, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang('/'), bodyHtml: homeMeta[L].body });
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
  const INVGEN_FAQ = {
    ar: [
      { q: 'كيف أعمل فاتورة ضريبية برمز QR مجاناً؟', a: 'أدخل بيانات شركتك وعميلك وبنود الفاتورة في مولّد FieldSales المجاني، فيبني فوراً فاتورة ضريبية احترافية ثنائية اللغة برمز QR متوافق مع هيئة الزكاة والضريبة والجمارك ZATCA، وتحمّلها PDF أو تطبعها بلا تسجيل.' },
      { q: 'ما الفرق بين الفاتورة الضريبية والمبسطة؟', a: 'الفاتورة الضريبية المبسطة تُصدر للمستهلك (B2C) بلا رقم ضريبي للمشتري، والفاتورة الضريبية العادية (B2B) تتضمن الرقم الضريبي للمشتري — والمولّد يبدّل بينهما تلقائياً.' },
      { q: 'ما الدول المدعومة؟', a: 'نِسب الضريبة والعملات جاهزة لـ12 دولة عربية: السعودية 15%، مصر 14%، الإمارات 5%، البحرين 10%، عُمان 5%، الأردن 16%، المغرب 20%، الجزائر وتونس 19% وغيرها — وكلها قابلة للتعديل.' },
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
  const INFO = {
    about: {
      ar: { t: 'عن المنصّة | FieldSales', d: 'تعرّف على منصّة FieldSales لإدارة المبيعات الميدانية والتوزيع في الأسواق العربية.',
        b: '<h1>عن منصّة FieldSales</h1><p>FieldSales منصّة سحابية عربية لإدارة المبيعات الميدانية والتوزيع: فواتير ضريبية منظّمة من الميدان، تحصيل وكشوف حساب، مخزون سيارة المندوب، تتبّع GPS، وتقارير لحظية — لشركات التوزيع في كل الدول العربية بواجهة عربية أصلية ودعم للإنجليزية والفرنسية. تواصل معنا: info@fieldsa.net</p>' },
      en: { t: 'About | FieldSales', d: 'Learn about FieldSales, the field sales and distribution management platform for Arab markets.',
        b: '<h1>About FieldSales</h1><p>FieldSales is an Arabic-first SaaS platform for field sales and distribution: structured tax invoices from the field, collection and statements, van stock, GPS tracking and live reports — serving distributors across all Arab countries in Arabic, English and French. Contact: info@fieldsa.net</p>' },
      fr: { t: 'À propos | FieldSales', d: 'Découvrez FieldSales, la plateforme de gestion des ventes terrain et de la distribution pour les marchés arabes.',
        b: '<h1>À propos de FieldSales</h1><p>FieldSales est une plateforme SaaS pour la vente terrain et la distribution : factures structurées, encaissement et relevés, stock du véhicule, suivi GPS et rapports en direct — au service des distributeurs de tous les pays arabes, en arabe, anglais et français. Contact : info@fieldsa.net</p>' },
    },
    contact: {
      ar: { t: 'تواصل معنا | FieldSales', d: 'تواصل مع فريق FieldSales للاستفسارات والمبيعات والدعم الفني.',
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
      ar: { t: 'مولّد فاتورة ضريبية مجاني برمز QR — نموذج جاهز | FieldSales', d: 'أنشئ فاتورة ضريبية احترافية مجاناً برمز QR متوافق مع ZATCA وحمّلها PDF خلال ثوانٍ — بلا تسجيل.',
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
      ar: { t: 'سياسة الخصوصية | FieldSales', d: 'كيف تجمع منصّة FieldSales بياناتك وتحميها وتستخدمها.', b: '<h1>سياسة الخصوصية</h1><p>توضّح هذه السياسة كيف تجمع منصّة FieldSales البيانات وتحميها وتستخدمها — النص الكامل متاح في هذه الصفحة داخل التطبيق. للاستفسار: info@fieldsa.net</p>' },
      en: { t: 'Privacy Policy | FieldSales', d: 'How FieldSales collects, protects and uses your data.', b: '<h1>Privacy Policy</h1><p>This policy explains how FieldSales collects, protects and uses data — the full text is available on this page in the app. Questions: info@fieldsa.net</p>' },
      fr: { t: 'Politique de confidentialité | FieldSales', d: 'Comment FieldSales collecte, protège et utilise vos données.', b: '<h1>Politique de confidentialité</h1><p>Cette politique explique comment FieldSales collecte, protège et utilise les données — texte complet disponible sur cette page. Questions : info@fieldsa.net</p>' },
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

  // 5) الصفحة الرئيسية العربية (الجذر dist/index.html) — تحقن محتوى دلالياً في #root الفارغ.
  //    هذه أهم صفحة، وكانت قوقعة SPA فارغة لغير مشغّلي JavaScript (زواحف AI وBing جزئياً).
  //    React يستبدلها عند التحميل (createRoot يمسح ويعيد الرسم) — المحتوى للزواحف فقط.
  const homeAr = `<main>
<h1>FieldSales — نظام إدارة المبيعات الميدانية والتوزيع للأسواق العربية</h1>
<p><strong>FieldSales</strong> منصّة سحابية عربية متكاملة لشركات التوزيع والمبيعات الميدانية. يُصدر المندوب من هاتفه فاتورة ضريبية منظّمة برمز QR (متوافقة مع ZATCA في السعودية) وطباعة حرارية فورية، ويسجّل التحصيل، ويدير مخزون سيارته — بينما تحصل الإدارة على صورة حيّة كاملة: مبيعات اليوم، التحصيل والذمم، حدود ائتمان العملاء مع تنبيهات التجاوز، مخزون كل سيارة، ومواقع المناديب وخطوط سيرهم عبر GPS.</p>
<p>بواجهة عربية أصلية (RTL) ودعم للإنجليزية والفرنسية، تخدم FieldSales موزّعي المواد الغذائية والمشروبات والسلع الاستهلاكية في كل الدول العربية.</p>
<h2>أبرز المزايا</h2>
<ul>
<li>فوترة ضريبية من الميدان برمز QR وطباعة حرارية 58مم</li>
<li>التحصيل وإدارة الذمم وكشوف الحساب مع حدود ائتمان وتنبيهات</li>
<li>إدارة مخزون سيارة المندوب مع كشف الفروقات لحظياً</li>
<li>تتبّع المناديب عبر GPS وتخطيط خطوط السير</li>
<li>كتالوج المنتجات وشرائح الأسعار وإدارة العملاء</li>
<li>صلاحيات دقيقة للفريق وتكامل مع أنظمة ERP</li>
<li>تقارير وتحليلات لحظية على لوحة واحدة</li>
</ul>
<h2>الأسعار</h2>
<p>تبدأ باقات FieldSales من <strong>125 ﷼ شهرياً لكل حساب</strong>، مع <strong>تجربة مجانية 10 أيام</strong> تبدأ خلال دقائق دون بطاقة ائتمان. <a href="/signup">ابدأ تجربتك المجانية الآن</a>.</p>
<h2>أسئلة شائعة</h2>
<p><strong>هل النظام يصدر فواتير ضريبية متوافقة؟</strong> نعم، يُصدر فاتورة ضريبية منظّمة برمز QR وطباعة حرارية، متوافقة مع ZATCA في السعودية وقابلة للتكيّف مع متطلبات الدول العربية الأخرى.</p>
<p><strong>هل يحتاج المندوب إلى جهاز خاص؟</strong> لا، يكفي هاتف ذكي وطابعة حرارية اختيارية للفوترة في الميدان.</p>
<p><strong>هل توجد تجربة مجانية؟</strong> نعم، تجربة مجانية 10 أيام تبدأ خلال دقائق دون بطاقة ائتمان.</p>
<h2>للتواصل وطلبات الاشتراك</h2>
<p>البريد الرسمي: <a href="mailto:info@fieldsa.net">info@fieldsa.net</a> · مقر الشركة: المملكة العربية السعودية · <a href="/subscribe-request">سجّل طلب اشتراك جديد</a> أو <a href="/signup">ابدأ التجربة المجانية</a> مباشرةً.</p>
<h2>روابط مفيدة</h2>
<p><a href="/blog/">المدوّنة</a> · <a href="/calculator/">حاسبة تسريب الإيرادات</a> · <a href="/invoice-generator/">مولّد الفاتورة الضريبية المجاني</a> · <a href="/about/">عن المنصّة</a> · <a href="/contact/">تواصل معنا</a> · <a href="/en/">English</a> · <a href="/fr/">Français</a></p>
<p>أدلّة الدول: ${COUNTRIES.slice(0, 12).map((c) => `<a href="/blog/field-sales-software-${c.code.toLowerCase()}/">${esc(c.ar)}</a>`).join(' · ')}</p>
</main>`;
  const rootHtml = template.replace(/<div id="root">\s*<\/div>/, `<div id="root"><div data-ssr>${homeAr}</div></div>`);
  fs.writeFileSync(path.join(DIST, 'index.html'), rootHtml);
  n++;

  console.log(`✅ prerender: ${n} صفحة ثابتة (${buildCatalog().length} مقال مولَّد ×3 + ${manual.length} مقال يدوي + فهارس + رئيسية ع/إ/فر + ${Object.keys(INFO).length} صفحة تعريفية ×3) في dist/`);
}

await main();
