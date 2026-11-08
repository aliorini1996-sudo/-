/**
 * القالب المشترك لصفحات الطبقة التسويقية متعددة اللغات (spec-b §٥).
 *
 * مصدر واحد لـHTML الصفحة يقرؤه طرفان:
 *  - prerender.mjs يحقن `html` في #root، فيقرؤه الزاحف قبل JavaScript؛
 *  - I18nMarketingPage.tsx يرسمه حرفياً بعد الإقلاع، فلا يختلف ما يراه الزائر عمّا قرأه الزاحف.
 *
 * لذلك الوحدة **نقية وحتمية**: بلا Intl ولا fs ولا React ولا Date. كل ما يختلف بين Node والمتصفح
 * (أسماء الدول والعملات وترتيبها، وصيغة النسبة، وقائمة لغات الواجهة) حسبه المستورد مرة واحدة وحفظه في
 * `_derived` داخل ملف المحتوى؛ والمسارات والعناقيد والروابط من i18nRoutes.mjs وحدها (لا يُحسب هنا مسار).
 *
 * الأنواع: marketingTemplate.d.mts.
 */
import {
  ORIGIN, LEGACY_HREFLANG, canon, clusterAlternates, i18nPages, pagePath, quoteHref, meetingHref, waRedirectHref,
} from './i18nRoutes.mjs';

/** يُرفع عند تغيير بنية HTML أو JSON-LD — مرجع للمقارنة بين بناءين */
export const TEMPLATE_VERSION = 1;

/** المنظّمة معرَّفة في كتلة القالب (index.html) ونوعها فريد عند verify-schema — فالصفحة تشير إليها بمعرّفها فقط */
const ORG_REF = Object.freeze({ '@id': `${ORIGIN}/#organization` });

/**
 * لغات الموقع القائمة في «مبدّل» الصفحات الجديدة (قائمة data-i18n-langs): رئيسياتها القديمة بأسمائها الأصلية،
 * والعربية `/`. الاسم الإنجليزي لصفحة /languages/ وحدها.
 */
const LEGACY_LANGS = Object.freeze([
  { code: 'ar', nativeName: 'العربية', name: 'Arabic', home: '/' },
  { code: 'en', nativeName: 'English', name: 'English', home: '/en/' },
  { code: 'fr', nativeName: 'Français', name: 'French', home: '/fr/' },
  { code: 'tr', nativeName: 'Türkçe', name: 'Turkish', home: '/tr/' },
  { code: 'zh', nativeName: '简体中文', name: 'Chinese (Simplified)', home: '/zh/' },
]);

/** صفحة /languages/ إنجليزية بنصّ مكتوب هنا (لا ملف محتوى لها) — صدق لغات الواجهة بالإنجليزية */
const LANGUAGES_PAGE = Object.freeze({
  title: 'FieldSales in Other Languages',
  description: (n) => `Pages about FieldSales in ${n} languages. The FieldSales app interface itself is available in Arabic, English, French, Turkish and Chinese.`,
  h1: 'FieldSales in other languages',
  intro: 'Choose a language to read about FieldSales. The app interface is available in Arabic, English, French, Turkish and Chinese only; pages in other languages describe the product for information.',
  cta: { quote: 'Request a quote', meeting: 'Book a meeting', whatsapp: 'Chat on WhatsApp' },
  ogLocale: 'en_US',
});

/** بادئة مفاتيح المحتوى لكل صفحة — h1 كل صفحة في `${prefix}.h1` */
function prefixOf(pageKey) {
  switch (pageKey) {
    case 'home': return 'tierB.home';
    case 'category': return 'tierB.category';
    case 'countries': return 'tierB.countries';
    case 'about': return 'tierB.about';
    case 'contact': return 'tierB.contact';
    case 'features': return 'tierA.features';
    case 'apps': return 'tierA.apps';
    case 'quote': return 'tierA.quote';
    default:
      if (String(pageKey).startsWith('feature:')) return `tierA.featurePages.${String(pageKey).slice('feature:'.length)}`;
      throw new Error(`renderI18nPage: مفتاح صفحة بلا محتوى «${pageKey}»`);
  }
}

const FEATURE_PAGES = ['feature:offlineInvoicing', 'feature:vanStock', 'feature:routesVisits'];
const range = (n) => Array.from({ length: n }, (_, i) => i);

/** هروب HTML للنصّ والسمات (السمات كلها بعلامات تنصيص مزدوجة) — كـesc في prerender.mjs */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const e = escapeHtml;

/**
 * عمود الضريبة في صفحة الدول — خاصّ بالصفحة العامة ولا يمسّ إعدادات التطبيق (countries.ts):
 * - PAGE_TAX_HIDDEN: دول قيمة defaultVatPct فيها إعداد تطبيق لا «نسبة معتادة» (الولايات المتحدة 0 بينما
 *   ضريبة المبيعات تفرضها الولايات بنسب مختلفة) ⇒ «—».
 * - PAGE_TAX_EXTRA: النسبة القياسية العامة لدول ليست في countries.ts (منها أسواق لغات منشورة: EE وIL وBA)،
 *   بما هو ثابت وموثّق وحده؛ ما لم يُتيقَّن منه يبقى «—» وتشرحه جملة taxNote.
 * - PAGE_TAX_OVERRIDE: نسبة تغيّرت عن القيمة الافتراضية في التطبيق (كازاخستان 16٪ منذ ١ يناير ٢٠٢٦).
 */
const PAGE_TAX_HIDDEN = new Set(['US']);
const PAGE_TAX_EXTRA = {
  AD: 4.5, AG: 17, BA: 17, BB: 17.5, BI: 18, BS: 10, BW: 14, BZ: 12.5, CV: 15, DM: 15, EE: 24, FO: 25,
  GD: 15, GM: 15, GP: 8.5, GY: 14, IL: 18, IM: 20, JE: 5, JM: 15, KN: 17, LC: 12.5, LI: 8.1, LS: 15,
  MC: 20, ME: 21, MK: 18, MQ: 8.5, MU: 15, MV: 8, MW: 16.5, NA: 15, NI: 15, PG: 10, RE: 8.5, SC: 15,
  SL: 15, SR: 10, SV: 13, SZ: 15, TO: 15, TT: 12.5, VC: 16, WS: 15,
};
const PAGE_TAX_OVERRIDE = { KZ: 16 };

/** نسب الضريبة المعروضة في صفحة الدول: سجل الدول (countries.ts) بلا «دولة أخرى» XX، مع تصحيحات الصفحة أعلاه */
export function vatMapFrom(countries) {
  const out = {};
  for (const c of Object.values(countries || {})) {
    if (!c || typeof c.code !== 'string' || c.code === 'XX') continue;
    if (typeof c.defaultVatPct !== 'number' || !Number.isFinite(c.defaultVatPct)) continue;
    out[c.code] = c.defaultVatPct;
  }
  for (const [code, v] of Object.entries(PAGE_TAX_EXTRA)) if (out[code] == null) out[code] = v;
  Object.assign(out, PAGE_TAX_OVERRIDE);
  for (const code of PAGE_TAX_HIDDEN) delete out[code];
  return out;
}

/** قارئ نصوص المحتوى: يرمي إن غاب مفتاح تقرؤه الصفحة أو كان فارغاً — فلا تُصيَّر صفحة ناقصة بصمت */
function stringsReader(file, code) {
  const strings = (file && file.strings) || {};
  return (key) => {
    const v = strings[key];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`renderI18nPage: المفتاح «${key}» ناقص أو فارغ في محتوى اللغة «${code}»`);
    }
    return v;
  };
}

/** النسبة المئوية بصيغة اللغة المحسوبة عند الاستيراد، والرقم بأرقام لاتينية */
function formatPercent(n, pc) {
  const p = pc || { before: '', after: '%', decimal: '.' };
  return `${p.before}${String(n).replace('.', p.decimal || '.')}${p.after}`;
}

/** قائمة اللغات (المبدّل): القديمة الخمس ثم كل منشورة لها رئيسية بترتيب السجل. withNames لصفحة /languages/ */
function langsNav(reg, currentCode, withNames) {
  const items = LEGACY_LANGS.map((l) => ({ code: l.code, hreflang: LEGACY_HREFLANG[l.code], href: l.home, nativeName: l.nativeName, name: l.name }));
  const byCode = new Map(((reg && reg.locales) || []).map((l) => [l.code, l]));
  for (const p of i18nPages(reg)) {
    if (p.pageKey !== 'home') continue;
    const loc = byCode.get(p.code);
    if (!loc || items.some((x) => x.code === p.code)) continue;
    items.push({ code: p.code, hreflang: p.hreflang, href: p.path, nativeName: loc.nativeName, name: loc.name });
  }
  const li = items.map((x) => {
    const cur = x.code === currentCode ? ' aria-current="true"' : '';
    const name = withNames && x.name && x.name !== x.nativeName ? ` — ${e(x.name)}` : '';
    return `<li><a href="${e(x.href)}" hreflang="${e(x.hreflang)}" lang="${e(x.hreflang)}"${cur}>${e(x.nativeName)}</a>${name}</li>`;
  }).join('');
  // المبدّل في ذيل الصفحات سطرٌ ملتفّ لا عمود طويل (قرابة خمسين لغة عند اكتمال الموجة)؛ وصفحة /languages/ قائمة بأسمائها
  const ul = withNames ? '<ul>' : '<ul style="display:flex;flex-wrap:wrap;gap:4px 16px;list-style:none;padding:0">';
  return { html: `<nav data-i18n-langs aria-label="Languages">${ul}${li}</ul></nav>`, count: items.length };
}

/** سطر الأزرار المشترك: طلب عرض سعر · احجز اجتماعاً · واتساب — النماذج القديمة لأن الخادم يقبل لغاتها الخمس وحدها */
function ctaLine(page, labels) {
  return `<p data-i18n-cta><a href="${e(quoteHref(page.code))}">${e(labels.quote)}</a> · `
    + `<a href="${e(meetingHref(page.code))}">${e(labels.meeting)}</a> · `
    + `<a href="${e(waRedirectHref(page))}" rel="nofollow noopener">${e(labels.whatsapp)}</a></p>`;
}

const faqHtml = (faq) => faq.map((f) => `<h3>${e(f.q)}</h3><p>${e(f.a)}</p>`).join('\n');

/** جسم كل صفحة من مفاتيح المحتوى (§٥.٢) — يعيد الأجزاء وأسئلة FAQPage الظاهرة فيها */
function pageBody(page, S, file, input, samePages) {
  const k = page.pageKey;
  const P = prefixOf(k);
  const parts = [];
  let faq = [];
  const qa = (base, n) => range(n).map((i) => ({ q: S(`${base}.${i}.q`), a: S(`${base}.${i}.a`) }));

  if (k === 'home') {
    parts.push(`<p>${e(S('tierB.home.definition'))}</p>`);
    parts.push(`<ul>${range(6).map((i) => `<li><strong>${e(S(`tierB.home.capabilities.${i}.title`))}</strong> ${e(S(`tierB.home.capabilities.${i}.line`))}</li>`).join('')}</ul>`);
    // الترقيم صريح: تنسيق [data-ssr] في index.html يجعل ol نقطية
    parts.push(`<ol style="list-style:decimal">${range(4).map((i) => `<li><strong>${e(S(`tierB.home.howItWorks.${i}.title`))}</strong> ${e(S(`tierB.home.howItWorks.${i}.line`))}</li>`).join('')}</ol>`);
    faq = qa('tierB.home.faq', 6);
    parts.push(faqHtml(faq));
  } else if (k === 'category') {
    parts.push(`<p>${e(S('tierB.category.intro'))}</p>`);
    for (const i of range(5)) parts.push(`<h2>${e(S(`tierB.category.sections.${i}.title`))}</h2><p>${e(S(`tierB.category.sections.${i}.body`))}</p>`);
    faq = qa('tierB.category.faq', 4);
    parts.push(faqHtml(faq));
  } else if (k === 'countries') {
    parts.push(`<p>${e(S('tierB.countries.intro'))}</p>`);
    parts.push(countriesTable(S, file, input));
    parts.push(`<p>${e(S('tierB.countries.taxNote'))}</p>`);
  } else if (k === 'about') {
    for (const i of range(3)) parts.push(`<p>${e(S(`tierB.about.body.${i}`))}</p>`);
  } else if (k === 'contact') {
    parts.push(`<p>${e(S('tierB.contact.intro'))}</p><p>${e(S('tierB.contact.meetingIntro'))}</p>`);
  } else if (k === 'features') {
    parts.push(`<p>${e(S('tierA.features.intro'))}</p>`);
    const links = FEATURE_PAGES
      .map((fk) => samePages.find((p) => p.pageKey === fk))
      .filter(Boolean)
      .map((p) => `<li><a href="${e(p.path)}">${e(S(`${prefixOf(p.pageKey)}.h1`))}</a></li>`);
    if (links.length) parts.push(`<ul>${links.join('')}</ul>`);
  } else if (k.startsWith('feature:')) {
    parts.push(`<p>${e(S(`${P}.intro`))}</p>`);
    for (const i of range(4)) parts.push(`<h2>${e(S(`${P}.points.${i}.title`))}</h2><p>${e(S(`${P}.points.${i}.body`))}</p>`);
    faq = qa(`${P}.faq`, 2);
    parts.push(faqHtml(faq));
  } else if (k === 'apps' || k === 'quote') {
    // صفحة الطلب: النصّ نفسه يقول إن الأسعار غير منشورة — لا رقم ولا سعر في القالب
    parts.push(`<p>${e(S(`${P}.body`))}</p>`);
  } else {
    throw new Error(`renderI18nPage: لا جسم لصفحة «${k}»`);
  }
  return { parts, faq };
}

/**
 * جدول الدول (249 صفاً بترتيب `_derived.countryOrder`).
 *
 * ⚠️ عمود الفوترة الإلكترونية **ثابت بالرمز** ولا يُقرأ من حقل `einvoice` في countries.ts أبداً:
 * السعودية وحدها «حيّ» (ندعم ربط المرحلة الثانية مع منصة فاتورة)، وكل دولة أخرى «عند الطلب».
 * الحقل يقول `eta` لمصر بينما الربط هناك غير مبني، فاشتقاق العمود منه ادّعاء كاذب.
 * (marketingTemplate.test.ts يفرض صف مصر «عند الطلب».)
 */
function countriesTable(S, file, input) {
  const world = input.world;
  const vat = input.vatByCode;
  if (!world || !Array.isArray(world.countries)) throw new Error('renderI18nPage: صفحة الدول تحتاج world (world-countries.json)');
  if (!vat || typeof vat !== 'object') throw new Error('renderI18nPage: صفحة الدول تحتاج vatByCode (vatMapFrom(COUNTRIES))');
  const d = file._derived || {};
  const names = d.countryNames || {};
  const curNames = d.currencyNames || {};
  const order = Array.isArray(d.countryOrder) ? d.countryOrder : [];
  const byCode = new Map(world.countries.map((c) => [c.code, c]));
  if (order.length !== byCode.size || order.some((c) => !byCode.has(c)) || new Set(order).size !== order.length) {
    throw new Error(`renderI18nPage: _derived.countryOrder (${order.length}) لا يطابق world-countries (${byCode.size})`);
  }
  const live = S('tierB.countries.einvoicingLive');
  const onRequest = S('tierB.countries.einvoicingOnRequest');
  const rows = order.map((c) => {
    const name = names[c];
    if (typeof name !== 'string' || !name) throw new Error(`renderI18nPage: لا اسم للدولة ${c} في _derived.countryNames`);
    const cur = (byCode.get(c).currencies || []).map((x) => (curNames[x] ? `${x} · ${curNames[x]}` : x)).join(' / ') || '—';
    const tax = vat[c] != null ? formatPercent(vat[c], d.percent) : '—';
    const einv = c === 'SA' ? live : onRequest; // ثابت بالرمز — انظر التعليق أعلاه
    return `<tr><th scope="row">${e(name)}</th><td>${e(cur)}</td><td>${e(tax)}</td><td>${e(einv)}</td></tr>`;
  });
  const th = (key) => `<th scope="col">${e(S(`tierB.countries.columns.${key}`))}</th>`;
  // الحاوية تمنع التمرير الأفقي للصفحة على الجوال: الجدول وحده يتمرّر إن ضاق عرضه
  return `<div style="overflow-x:auto"><table data-i18n-countries><thead><tr>${th('country')}${th('currency')}${th('tax')}${th('einvoicing')}</tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table></div>`;
}

/** JSON-LD الصفحة: WebPage/AboutPage/ContactPage + FAQPage (إن وُجدت أسئلة) + BreadcrumbList — بلا Organization ولا عروض أسعار */
function pageJsonLd({ page, title, description, h1, canonical, homeAbs, faq }) {
  const T = page.pageKey === 'about' ? 'AboutPage' : page.pageKey === 'contact' ? 'ContactPage' : 'WebPage';
  const graph = [{
    '@type': T, '@id': `${canonical}#webpage`, url: canonical, name: title, description,
    inLanguage: page.hreflang, publisher: ORG_REF,
  }];
  if (faq.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    });
  }
  if (page.pageKey !== 'home' && page.pageKey !== 'languages') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'FieldSales', item: homeAbs },
        { '@type': 'ListItem', position: 2, name: h1, item: canonical },
      ],
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** غلاف الصفحة المشترك (§٥.١): الترويسة، ثم main (h1 والجسم والأزرار وملاحظة لغات الواجهة)، ثم روابط الصفحات واللغات */
function wrap(page, { homeHref, h1, bodyParts, cta, uiNote, pagesNav, langs }) {
  const out = [
    `<div class="i18n" data-i18n-page="${e(page.pageKey)}" lang="${e(page.hreflang)}" dir="${e(page.dir)}">`,
    `<header><a href="${e(homeHref)}" lang="${e(page.hreflang)}">FieldSales</a></header>`,
    '<main>',
    `<h1>${e(h1)}</h1>`,
    ...bodyParts,
    cta,
  ];
  if (uiNote != null) out.push(`<p data-i18n-ui>${e(uiNote)}</p>`);
  out.push('</main>');
  if (pagesNav) out.push(pagesNav);
  if (langs) out.push(langs);
  out.push('</div>');
  return out.join('\n');
}

/** صفحة /languages/: إنجليزية من نصّ القالب، تسرد كل اللغات برابط رئيسيتها (الأصلي ثم الإنجليزي) */
function renderLanguagesPage(page, reg) {
  const canonical = canon(ORIGIN + page.path);
  const nav = langsNav(reg, null, true);
  const L = LANGUAGES_PAGE;
  const description = L.description(nav.count);
  const html = wrap(page, {
    homeHref: '/en/',
    h1: L.h1,
    bodyParts: [`<p data-i18n-ui>${e(L.intro)}</p>`, nav.html],
    cta: ctaLine(page, L.cta),
    uiNote: null, // ملاحظة لغات الواجهة هي الفقرة الأولى أعلاه (data-i18n-ui)
    pagesNav: '',
    langs: '',
  });
  return {
    title: L.title, description, h1: L.h1, html, faq: [],
    jsonld: pageJsonLd({ page, title: L.title, description, h1: L.h1, canonical, homeAbs: canon(`${ORIGIN}/en/`), faq: [] }),
    lang: page.hreflang, dir: page.dir, ogLocale: L.ogLocale, canonical, alternates: [],
  };
}

/**
 * يصيّر صفحة من الطبقة. يرمي إن نقص مفتاح تقرؤه الصفحة، أو غاب file لغير /languages/، أو world/vatByCode لصفحة الدول.
 * الناتج نفسه في Node والمتصفح: `html` يُحقن في #root ويُرسم في React حرفياً.
 */
export function renderI18nPage(input) {
  const { page, reg } = input || {};
  if (!page || !reg) throw new Error('renderI18nPage: page وreg مطلوبان');
  if (page.pageKey === 'languages') return renderLanguagesPage(page, reg);

  const file = input.file;
  if (!file || !file.strings) throw new Error(`renderI18nPage: لا ملف محتوى للغة «${page.code}» (${page.path})`);
  if (file._meta && file._meta.code && file._meta.code !== page.code) {
    throw new Error(`renderI18nPage: ملف المحتوى للغة «${file._meta.code}» لا «${page.code}»`);
  }
  const loc = ((reg.locales) || []).find((l) => l.code === page.code);
  if (!loc) throw new Error(`renderI18nPage: اللغة «${page.code}» غير منشورة في السجل`);

  const S = stringsReader(file, page.code);
  const P = prefixOf(page.pageKey);
  const title = S(`${P}.title`);
  const description = S(`${P}.description`);
  const h1 = S(`${P}.h1`);
  const canonical = canon(ORIGIN + page.path);
  const homeHref = pagePath(page.code, 'home', loc.slug);
  const homeAbs = canon(ORIGIN + homeHref);

  // صفحات اللغة نفسها من مصدر المسارات الواحد (i18nPages) — لا يُحسب مسار هنا
  const samePages = i18nPages(reg).filter((p) => p.code === page.code && p.pageKey !== 'languages');
  const { parts, faq } = pageBody(page, S, file, input, samePages);

  const others = samePages.filter((p) => p.pageKey !== page.pageKey);
  const pagesNav = others.length
    ? `<nav data-i18n-pages><ul>${others.map((p) => `<li><a href="${e(p.path)}">${e(S(`${prefixOf(p.pageKey)}.h1`))}</a></li>`).join('')}</ul></nav>`
    : '';

  const html = wrap(page, {
    homeHref,
    h1,
    bodyParts: parts,
    cta: ctaLine(page, { quote: S('tierB.home.cta.quote'), meeting: S('tierB.home.cta.meeting'), whatsapp: S('tierB.home.cta.whatsapp') }),
    uiNote: S('tierB.home.uiLanguagesNote'),
    pagesNav,
    langs: langsNav(reg, page.code, false).html,
  });

  return {
    title, description, h1, html, faq,
    jsonld: pageJsonLd({ page, title, description, h1, canonical, homeAbs, faq }),
    lang: page.hreflang,
    dir: page.dir,
    ogLocale: loc.ogLocale,
    canonical,
    alternates: page.clusterKey ? clusterAlternates(page.clusterKey, reg) : [],
  };
}
