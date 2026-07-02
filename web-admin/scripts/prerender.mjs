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

  // 3) الصفحة الرئيسية بالإنجليزية والفرنسية — وسوم + محتوى دلالي مختصر (زواحف AI لا تُشغّل JavaScript)
  const homeMeta = {
    en: {
      title: 'FieldSales | Field Sales & Distribution Management Software for Arab Markets',
      desc: 'Arabic-first field sales system for distributors across Saudi Arabia, Egypt and the Arab world: tax invoices, collection, van stock and rep tracking. Free 10-day trial.',
      body: `<main><h1>FieldSales — field sales &amp; distribution management for Arab markets</h1>
<p>FieldSales is a SaaS platform for distribution companies: sales reps issue structured tax invoices (ZATCA-compliant QR in Saudi Arabia), collect payments, and manage van stock from a mobile app, while managers get live dashboards, GPS tracking and reports. Available in Arabic, English and French across all 22 Arab countries.</p>
<ul><li>Field tax invoicing with QR code and thermal printing</li><li>Collection, receivables and customer statements with credit limits</li><li>Van stock per rep with live variance detection</li><li>GPS rep tracking and route planning</li><li>Product catalog, price tiers and ERP integration</li></ul>
<p><a href="/signup">Start your free 10-day trial</a> — no credit card required. <a href="/en/blog">Read the blog</a> · <a href="/en/about">About</a> · <a href="/en/contact">Contact</a></p></main>`,
    },
    fr: {
      title: 'FieldSales | Logiciel de gestion des ventes terrain et distribution',
      desc: 'Système de vente terrain pour les distributeurs en Arabie saoudite, en Égypte et dans le monde arabe : factures, encaissement, stock et suivi. Essai gratuit 10 jours.',
      body: `<main><h1>FieldSales — gestion des ventes terrain et de la distribution pour les marchés arabes</h1>
<p>FieldSales est une plateforme SaaS pour les entreprises de distribution : les commerciaux émettent des factures structurées à code QR, encaissent les paiements et gèrent le stock du véhicule depuis une application mobile, tandis que les gérants disposent de tableaux de bord en direct, du suivi GPS et de rapports. Disponible en arabe, anglais et français dans les 22 pays arabes.</p>
<ul><li>Facturation terrain avec code QR et impression thermique</li><li>Encaissement, créances et relevés clients avec limites de crédit</li><li>Stock du véhicule par commercial avec détection des écarts</li><li>Suivi GPS et planification des tournées</li><li>Catalogue produits, grilles tarifaires et intégration ERP</li></ul>
<p><a href="/signup">Essai gratuit de 10 jours</a> — sans carte bancaire. <a href="/fr/blog">Blog</a> · <a href="/fr/about">À propos</a> · <a href="/fr/contact">Contact</a></p></main>`,
    },
  };
  for (const L of ['en', 'fr']) {
    const canonical = `${ORIGIN}/${L}`;
    const html = buildPage({ lang: L, title: homeMeta[L].title, description: homeMeta[L].desc, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang('/'), bodyHtml: homeMeta[L].body });
    writeRoute(`/${L}`, html);
    n++;
  }

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
      const canonical = `${ORIGIN}${prefix}/${route}`;
      const html = buildPage({ lang: L, title: m.t, description: m.d, canonical, image: `${ORIGIN}/og-image.png`, ogType: 'website', hreflang: trilingualHreflang(`/${route}`), bodyHtml: `<main>${m.b}</main>` });
      writeRoute(`${prefix}/${route}`, html);
      n++;
    }
  }

  console.log(`✅ prerender: ${n} صفحة ثابتة (${buildCatalog().length} مقال ×3 + فهارس + رئيسية en/fr + ${Object.keys(INFO).length} صفحة تعريفية ×3) في dist/`);
}

main();
