import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import {
  renderI18nPage, vatMapFrom, escapeHtml, TEMPLATE_VERSION,
  type MarketingFile, type WorldCountries, type Rendered,
} from './marketingTemplate.mjs';
import { i18nPages, clusterAlternates, newClusterMembers, canon, type PublishedRegistry, type PublishedLocale, type I18nPage } from './i18nRoutes.mjs';
import { PUBLISHED, I18N_PAGES } from './i18nPublished';
import { seoUrls } from './locale';
import { COUNTRIES } from './countries';
import WhatsAppFab from '../components/WhatsAppFab';

/**
 * حرّاس القالب المشترك للطبقة متعددة اللغات (spec-b §٥ و§٦، اختبار I2).
 *
 * القالب مصدر واحد لما يقرؤه الزاحف (prerender) وما يرسمه React بعد الإقلاع؛ فخلل فيه يظهر في الطرفين معاً
 * بصمت: عمود فوترة يُشتق من حقل خاطئ فيدّعي ربطاً غير مبني، أو نصّ عربي يتسرّب إلى صفحة بلغة أخرى، أو
 * عنقود hreflang يعيده React إلى خمس لغات بعد أن أعلن prerender سبعاً. يقرأ الملفات المولّدة الملتزمة
 * (السجل المنشور وmarketing/en.json وworld-countries.json) ومعها مثبّت أردي مصغّر مكتوب هنا.
 */

const root = process.cwd();
const readJson = <T>(...p: string[]): T => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f} — شغّل scripts/import-i18n.mjs`);
  return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
};
const EN = readJson<MarketingFile>('src', 'i18n', 'marketing', 'en.json');
const WORLD = readJson<WorldCountries>('src', 'i18n', 'world-countries.json');
const VAT = vatMapFrom(COUNTRIES);

/** حروف الكتابة العربية (تشمل الأردية والفارسية) */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
/** الفاصلة والفاصلة المنقوطة وعلامة الاستفهام العربية (، ؛ ؟) ترقيمُ خط ثانا المالديفي نفسه (Script_Extensions في يونيكود) */
const SHARED_ARABIC_PUNCT = /[،؛؟]/g;
const PUNCT_SHARING_SCRIPTS = new Set(['Thaa']);
const AR_NAME = 'فيلد سيلز'; // الاسم العربي للعلامة — مسموح مرة في نبذة «من نحن»
const withoutLangsNav = (html: string) => html.replace(/<nav data-i18n-langs[\s\S]*?<\/nav>/g, '');

const enPage = (pageKey: I18nPage['pageKey']): I18nPage => {
  const p = I18N_PAGES.find((x) => x.code === 'en' && x.pageKey === pageKey);
  assert.ok(p, `صفحة en «${pageKey}» غير منشورة في السجل`);
  return p!;
};
const renderEn = (pageKey: I18nPage['pageKey']): Rendered => renderI18nPage({
  page: enPage(pageKey), reg: PUBLISHED, file: EN,
  world: pageKey === 'countries' ? WORLD : undefined, vatByCode: VAT,
});

/** كل أنواع @type وكل المفاتيح في كائن JSON-LD (بعمق) */
function ldScan(o: unknown, types: string[] = [], keys: string[] = []): { types: string[]; keys: string[] } {
  if (Array.isArray(o)) { o.forEach((x) => ldScan(x, types, keys)); return { types, keys }; }
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      keys.push(k);
      if (k === '@type') (Array.isArray(v) ? v : [v]).forEach((t) => types.push(String(t)));
      ldScan(v, types, keys);
    }
  }
  return { types, keys };
}

test('الإنجليزية: صفحتا الفئة والدول بعنوان ووصف وh1، وأسئلة ظاهرة، وJSON-LD بلا Organization ولا سعر', () => {
  assert.equal(typeof TEMPLATE_VERSION, 'number');
  for (const key of ['category', 'countries'] as const) {
    const r = renderEn(key);
    assert.ok(r.title.trim() && r.description.trim() && r.h1.trim(), `${key}: عنوان أو وصف أو h1 فارغ`);
    assert.ok(r.html.includes(`<h1>${escapeHtml(r.h1)}</h1>`), `${key}: h1 غير ظاهر`);
    for (const f of r.faq) {
      assert.ok(r.html.includes(`<h3>${escapeHtml(f.q)}</h3><p>${escapeHtml(f.a)}</p>`), `${key}: سؤال غير ظاهر «${f.q}»`);
    }
    if (key === 'category') assert.equal(r.faq.length, 4);
    else assert.equal(r.faq.length, 0);
    const { types, keys } = ldScan(r.jsonld);
    assert.ok(!types.includes('Organization'), `${key}: كيان Organization ثانٍ (نوعه فريد في القالب)`);
    assert.ok(!types.some((t) => /Offer/.test(t)), `${key}: Offer في JSON-LD`);
    assert.ok(!keys.some((k) => /price/i.test(k)), `${key}: سعر في JSON-LD`);
    assert.ok(types.includes('WebPage') && types.includes('BreadcrumbList'));
    assert.equal(types.includes('FAQPage'), r.faq.length > 0);
    assert.equal(r.canonical, canon(`https://fieldsa.net${enPage(key).path}`));
    assert.equal(r.lang, 'en');
    assert.equal(r.dir, 'ltr');
    assert.equal(r.ogLocale, 'en_US');
    assert.deepEqual(r.alternates, clusterAlternates(key, PUBLISHED));
    // لا عربية مكتوبة في الصفحة الإنجليزية خارج مبدّل اللغات (ولا تسمية واتساب عربية موروثة)
    assert.doesNotMatch(withoutLangsNav(r.html).split(AR_NAME).join(''), ARABIC_SCRIPT, `${key}: حرف عربي خارج مبدّل اللغات`);
    // صدق لغات الواجهة: الملاحظة ظاهرة، وأزرار النماذج القديمة وواتساب عبر المحوّل
    assert.match(r.html, /<p data-i18n-ui>[^<]+<\/p>/);
    assert.ok(r.html.includes('href="/en/subscribe-request/?type=quote"'));
    assert.ok(r.html.includes('href="/en/meeting/"'));
    assert.ok(r.html.includes('https://api.fieldsa.net/api/analytics/go/wa?'));
    // لا شريط ولا لافتة فوق h1: الترويسة رابط الاسم وحده
    assert.match(r.html, /<header><a href="\/en\/" lang="en">FieldSales<\/a><\/header>\n<main>\n<h1>/);
  }
});

test('جدول الدول: 249 صفاً، والسعودية وحدها «حيّ» ومصر «عند الطلب» رغم einvoice=eta، وAQ بلا عملة، وكل نسبة بصيغتها', () => {
  const r = renderEn('countries');
  const S = EN.strings;
  const D = EN._derived;
  const rows = r.html.match(/<tr><th scope="row">/g) || [];
  assert.equal(WORLD.countries.length, 249);
  assert.equal(rows.length, 249, 'عدد صفوف الجدول');
  const rowOf = (code: string) => {
    const head = `<tr><th scope="row">${escapeHtml(D.countryNames[code])}</th>`;
    const i = r.html.indexOf(head);
    assert.ok(i >= 0, `لا صف للدولة ${code}`);
    return r.html.slice(i, r.html.indexOf('</tr>', i) + 5);
  };
  const live = escapeHtml(S['tierB.countries.einvoicingLive']);
  const onReq = escapeHtml(S['tierB.countries.einvoicingOnRequest']);
  assert.ok(rowOf('SA').includes(`<td>${live}</td>`), 'صف السعودية بلا «حيّ»');
  assert.equal(COUNTRIES.EG.einvoice, 'eta', 'المثبّت يفترض einvoice=eta لمصر');
  assert.ok(rowOf('EG').includes(`<td>${onReq}</td>`), 'مصر يجب أن تكون «عند الطلب» (الربط هناك غير مبني)');
  assert.ok(!rowOf('EG').includes(live));
  assert.ok(rowOf('AE').includes(`<td>${onReq}</td>`), 'الإمارات (peppol) «عند الطلب»');
  // «حيّ» مرة واحدة فقط في الجدول
  assert.equal(r.html.split(`<td>${live}</td>`).length - 1, 1);
  assert.match(rowOf('AQ'), /<th scope="row">[^<]+<\/th><td>—<\/td>/, 'أنتاركتيكا بلا عملة ⇒ «—»');
  assert.ok(rowOf('PA').includes('PAB · ') && rowOf('PA').includes(' / USD · '), 'بنما بعملتين بترتيب CLDR');
  const pc = D.percent;
  for (const [code, v] of Object.entries(VAT)) {
    if (!D.countryNames[code]) continue; // دولة في السجل خارج ISO (لا يوجد اليوم)
    const want = escapeHtml(`${pc.before}${String(v).replace('.', pc.decimal)}${pc.after}`);
    assert.ok(rowOf(code).includes(`<td>${want}</td>`), `نسبة ${code} (${v}) لا تظهر بصيغتها «${want}»`);
  }
  assert.ok(!('XX' in VAT), 'vatMapFrom يُسقط «دولة أخرى» XX');
  // عمود الضريبة خاصّ بالصفحة: الولايات المتحدة «—» (ضريبة مبيعات بالولاية لا نسبة وطنية)، ونسب عامة لدول خارج countries.ts
  assert.equal(COUNTRIES.US.defaultVatPct, 0, 'المثبّت يفترض 0 للولايات المتحدة في إعداد التطبيق');
  assert.ok(!('US' in VAT), 'الولايات المتحدة لا تُعرض 0٪');
  assert.match(rowOf('US'), /<td>—<\/td><td>[^<]+<\/td><\/tr>$/, 'خانة ضريبة الولايات المتحدة «—»');
  for (const [code, v] of [['EE', 24], ['IL', 18], ['BA', 17], ['ME', 21], ['MK', 18], ['KZ', 16]]) assert.equal(VAT[code], v, `نسبة ${code}`);
  assert.ok(r.html.includes(escapeHtml(S['tierB.countries.taxNote'])) && S['tierB.countries.taxNote'].includes('—'), 'taxNote يشرح «—»');
  // ترتيب الصفوف = _derived.countryOrder
  const names = [...r.html.matchAll(/<tr><th scope="row">([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(names, D.countryOrder.map((c) => escapeHtml(D.countryNames[c])));
});

test('عمود الفوترة الإلكترونية لا يُقرأ من حقل einvoice في countries.ts إطلاقاً', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'i18n', 'marketingTemplate.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /einvoice\b/, 'القالب يقرأ einvoice — العمود ثابت بالرمز: SA «حيّ» وغيرها «عند الطلب»');
  assert.match(code, /c === 'SA' \? live : onRequest/);
});

/* ─── مثبّت أردي مصغّر: كتابة عربية واتجاه rtl ─────────────────────────────── */

const UR_STRINGS: Record<string, string> = {
  'tierB.about.title': 'FieldSales کے بارے میں',
  'tierB.about.description': 'FieldSales فیلڈ سیلز ٹیم رکھنے والی ڈسٹری بیوشن کمپنیوں کے لیے کلاؤڈ سافٹ ویئر بناتی ہے۔ 2026 میں ریاض، سعودی عرب میں قائم ہوئی۔',
  'tierB.about.h1': 'FieldSales کے بارے میں',
  'tierB.about.body.0': 'FieldSales (عربی نام فيلد سيلز) ڈسٹری بیوشن کمپنیوں کے لیے کلاؤڈ پلیٹ فارم ہے۔',
  'tierB.about.body.1': 'سیلز مین ایپ اینڈرائیڈ اور آئی فون پر چلتی ہے اور انٹرنیٹ کے بغیر بھی کام کرتی ہے۔',
  'tierB.about.body.2': 'ایپ کا انٹرفیس عربی، انگریزی، فرانسیسی، ترکی اور چینی میں دستیاب ہے۔',
  'tierB.home.h1': 'اپنے سیلز مین اور وین سیلز کو پہلے وزٹ سے آخری وصولی تک سنبھالیں',
  'tierB.category.h1': 'ڈسٹری بیوٹرز اور ہول سیلرز کے لیے وین سیلز سافٹ ویئر',
  'tierB.countries.h1': 'FieldSales 249 ممالک میں',
  'tierB.contact.title': 'FieldSales سے رابطہ کریں',
  'tierB.contact.description': 'FieldSales ٹیم سے بات کریں: کوٹیشن طلب کریں، میٹنگ بُک کریں یا واٹس ایپ پر بات کریں۔',
  'tierB.contact.h1': 'FieldSales سے رابطہ کریں',
  'tierB.contact.intro': 'ہمیں بتائیں کہ آپ کے سیلز مین آج کیسے بیچتے ہیں۔',
  'tierB.contact.meetingIntro': 'ہماری ٹیم کے ساتھ آن لائن میٹنگ بُک کریں۔',
  'tierB.home.cta.quote': 'کوٹیشن طلب کریں',
  'tierB.home.cta.meeting': 'میٹنگ بُک کریں',
  'tierB.home.cta.whatsapp': 'واٹس ایپ پر بات کریں',
  'tierB.home.uiLanguagesNote': 'FieldSales ایپ کا انٹرفیس عربی، انگریزی، فرانسیسی، ترکی، اور چینی میں دستیاب ہے؛ اردو میں نہیں۔',
};
const urFile = (strings: Record<string, string> = UR_STRINGS): MarketingFile => ({
  _meta: { code: 'ur', hreflang: 'ur', dir: 'rtl', quality: 'publish', contentDate: '2026-11-08', contentHash: 'test', simulated: true },
  _derived: {
    uiLanguages: 'عربی، انگریزی، فرانسیسی، ترکی، اور چینی', countriesCount: '249', foundingYear: '2026',
    countryNames: {}, currencyNames: {}, countryOrder: [], percent: { before: '', after: '%', decimal: '.' }, namesFallback: null,
  },
  strings,
});
const UR_LOCALE: PublishedLocale = {
  code: 'ur', hreflang: 'ur', name: 'Urdu', nativeName: 'اردو', dir: 'rtl', legacy: false, tier: 'B',
  ogLocale: 'ur_PK', intlLocale: 'ur', slug: 'van-sales-software',
  pages: ['home', 'category', 'countries', 'about', 'contact'], waLabel: 'واٹس ایپ پر بات کریں', contentDate: '2026-11-08',
};
/** القديمة وحدها من السجل الحقيقي (en/fr/tr/zh) — أساس ثابت للمثبّتات أياً كانت اللغات المنشورة اليوم */
const LEGACY_LOCALES = PUBLISHED.locales.filter((l) => l.legacy);
const withLocales = (...extra: PublishedLocale[]): PublishedRegistry => ({ ...PUBLISHED, locales: [...LEGACY_LOCALES, ...extra] });
const pageIn = (reg: PublishedRegistry, code: string, pageKey: I18nPage['pageKey']): I18nPage => {
  const p = i18nPages(reg).find((x) => x.code === code && x.pageKey === pageKey);
  assert.ok(p, `لا صفحة ${code}/${pageKey}`);
  return p!;
};

test('مثبّت أردي: rtl ولغة ur، والقالب لا يضيف نصّاً بالكتابة العربية من عنده خارج مبدّل اللغات', () => {
  const reg = withLocales(UR_LOCALE);
  for (const key of ['about', 'contact'] as const) {
    const page = pageIn(reg, 'ur', key);
    const r = renderI18nPage({ page, reg, file: urFile() });
    assert.equal(r.dir, 'rtl');
    assert.equal(r.lang, 'ur');
    assert.equal(r.ogLocale, 'ur_PK');
    assert.ok(r.html.startsWith(`<div class="i18n" data-i18n-page="${key}" lang="ur" dir="rtl">`), 'حاوية الصفحة بلا dir صريح (index.css يفرض rtl على body)');
    // كل حرف بالكتابة العربية خارج المبدّل يجب أن يأتي من نصوص المحتوى نفسها — لا تسمية واتساب عربية ولا «العربية»
    let rest = withoutLangsNav(r.html);
    for (const v of Object.values(UR_STRINGS).sort((a, b) => b.length - a.length)) rest = rest.split(escapeHtml(v)).join('');
    assert.doesNotMatch(rest.split(AR_NAME).join(''), ARABIC_SCRIPT, `${key}: القالب أضاف نصّاً بالكتابة العربية`);
    assert.ok(!r.html.includes('تحدث معنا') && !r.html.includes('تحدّث معنا'), 'تسمية واتساب العربية تسرّبت');
    // المبدّل: القدامى الخمس أولاً ثم الأردية بعلامة الحالية
    const nav = (r.html.match(/<nav data-i18n-langs[\s\S]*?<\/nav>/) || [''])[0];
    const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs.slice(0, 5), ['/', '/en/', '/fr/', '/tr/', '/zh/']);
    assert.ok(hrefs.includes('/ur/'));
    assert.match(nav, /<a href="\/ur\/" hreflang="ur" lang="ur" aria-current="true">اردو<\/a>/);
    // روابط صفحات اللغة نفسها بلا الصفحة الحالية، ومن مصدر المسارات
    const pagesNav = (r.html.match(/<nav data-i18n-pages>[\s\S]*?<\/nav>/) || [''])[0];
    const own = i18nPages(reg).filter((p) => p.code === 'ur' && p.pageKey !== key).map((p) => p.path);
    assert.deepEqual([...pagesNav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), own);
    // عنقود hreflang من clusterAlternates نفسه: القدامى ثم الأردية ثم x-default الإنجليزية
    assert.deepEqual(r.alternates, clusterAlternates(key, reg));
    assert.ok(r.alternates.some((a) => a.hreflang === 'ur' && a.href === `https://fieldsa.net/ur/${key}/`));
    assert.equal(r.alternates[r.alternates.length - 1]?.href, `https://fieldsa.net/en/${key}/`);
    const { types } = ldScan(r.jsonld);
    assert.ok(types.includes(key === 'about' ? 'AboutPage' : 'ContactPage'));
    assert.ok(!types.includes('Organization'));
  }
});

test('الهروب: & و" و< في القيم تخرج مهروبة، والعنوان الخام يبقى للرأس (buildPage يهرّبه)', () => {
  const reg = withLocales(UR_LOCALE);
  const strings = { ...UR_STRINGS, 'tierB.about.body.1': 'A & B "x" <y>', 'tierB.about.title': 'Tom & "Jerry"' };
  const r = renderI18nPage({ page: pageIn(reg, 'ur', 'about'), reg, file: urFile(strings) });
  assert.ok(r.html.includes('<p>A &amp; B &quot;x&quot; &lt;y&gt;</p>'));
  assert.ok(!r.html.includes('"x"') && !r.html.includes('<y>'));
  assert.equal(r.title, 'Tom & "Jerry"');
  assert.equal(escapeHtml('a&b"c<d>'), 'a&amp;b&quot;c&lt;d&gt;');
});

test('مفتاح ناقص أو فارغ يُسقط التصيير بخطأ صريح، وكذلك ملف لغة أخرى أو دولٌ بلا بيانات', () => {
  const reg = withLocales(UR_LOCALE);
  const page = pageIn(reg, 'ur', 'about');
  const missing = { ...UR_STRINGS };
  delete missing['tierB.about.body.2'];
  assert.throws(() => renderI18nPage({ page, reg, file: urFile(missing) }), /tierB\.about\.body\.2/);
  assert.throws(() => renderI18nPage({ page, reg, file: urFile({ ...UR_STRINGS, 'tierB.about.h1': '  ' }) }), /tierB\.about\.h1/);
  assert.throws(() => renderI18nPage({ page, reg }), /ur/);
  assert.throws(() => renderI18nPage({ page: enPage('countries'), reg: PUBLISHED, file: EN }), /world/);
  assert.throws(() => renderI18nPage({ page, reg, file: EN }), /en/);
});

test('صفحة /languages/: إنجليزية بلا ملف محتوى، تسرد القديمة الخمس والمنشورة، وتقول لغات الواجهة بصدق', () => {
  const reg = withLocales(UR_LOCALE);
  const page = i18nPages(reg).find((p) => p.pageKey === 'languages')!;
  const r = renderI18nPage({ page, reg });
  assert.equal(r.canonical, 'https://fieldsa.net/languages/');
  assert.deepEqual(r.alternates, []);
  assert.equal(r.lang, 'en');
  assert.equal(r.ogLocale, 'en_US');
  assert.equal(r.title, 'FieldSales in Other Languages');
  assert.match(r.html, /<p data-i18n-ui>[^<]*Arabic, English, French, Turkish and Chinese only[^<]*<\/p>/);
  for (const href of ['/', '/en/', '/fr/', '/tr/', '/zh/', '/ur/']) assert.ok(r.html.includes(`<a href="${href}"`), `لا رابط ${href}`);
  assert.ok(r.html.includes('اردو</a> — Urdu'));
  assert.ok(r.description.includes('6 languages'));
  assert.ok(r.html.includes('>Request a quote</a>') && r.html.includes('>Book a meeting</a>') && r.html.includes('>Chat on WhatsApp</a>'));
  assert.deepEqual(r.faq, []);
  assert.ok(!ldScan(r.jsonld).types.includes('BreadcrumbList'));
});

test('المسارات: I18N_PAGES = i18nPages(PUBLISHED)، وApp.tsx يولّدها من السجل لا يدوياً', () => {
  assert.deepEqual(I18N_PAGES.map((p) => p.path), i18nPages(PUBLISHED).map((p) => p.path));
  assert.ok(I18N_PAGES.some((p) => p.path === '/languages/'));
  assert.ok(I18N_PAGES.every((p) => p.path.startsWith('/') && p.path.endsWith('/')));
  const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
  assert.ok(app.includes('I18N_PAGES.map('), 'App.tsx لا يسجّل مسارات الطبقة من I18N_PAGES');
  assert.doesNotMatch(app, /<Route\s+path="\/languages"/, 'مسار /languages مكتوب يدوياً');
  // لا تُستدعى صفحة الطبقة إلا من مسارات I18N_PAGES
  assert.equal((app.match(/<I18nMarketingPage \/>/g) || []).length, 1);
});

/* ─── seoUrls: عناقيد الصفحات القديمة الثلاث في React = prerender ─────────── */

/** يستبدل لغات السجل المنشور مؤقتاً (seoUrls تقرأ PUBLISHED نفسه) ثم يعيدها */
function withPublished<T>(locales: PublishedLocale[], fn: () => T): T {
  const saved = PUBLISHED.locales;
  PUBLISHED.locales = locales;
  try { return fn(); } finally { PUBLISHED.locales = saved; }
}
const ES: PublishedLocale = {
  code: 'es', hreflang: 'es', name: 'Spanish', nativeName: 'Español', dir: 'ltr', legacy: false, tier: 'A',
  ogLocale: 'es_MX', intlLocale: 'es', slug: 'software-preventa-autoventa',
  pages: ['home', 'category', 'countries', 'about', 'contact', 'features', 'feature:offlineInvoicing', 'feature:vanStock', 'feature:routesVisits', 'apps', 'quote'],
  waLabel: 'Escribir por WhatsApp', contentDate: '2026-11-08',
};
const xd = (s: { alternates: { hreflang: string; href: string }[] }) => s.alternates.find((a) => a.hreflang === 'x-default')?.href;

test('seoUrls بلا لغة جديدة منشورة: كما كانت حرفياً', () => {
  withPublished(LEGACY_LOCALES, () => {
    const home = seoUrls('/', 'ar');
    assert.deepEqual(home.alternates, [
      { hreflang: 'ar', href: 'https://fieldsa.net/' },
      { hreflang: 'en', href: 'https://fieldsa.net/en' },
      { hreflang: 'fr', href: 'https://fieldsa.net/fr' },
      { hreflang: 'tr', href: 'https://fieldsa.net/tr' },
      { hreflang: 'zh-Hans', href: 'https://fieldsa.net/zh' },
      { hreflang: 'x-default', href: 'https://fieldsa.net/en' },
    ]);
    assert.deepEqual(seoUrls('/about', 'fr').alternates.map((a) => a.hreflang), ['ar', 'en', 'fr', 'x-default']);
  });
});

test('seoUrls بسجل مُحاكى فيه es وur: الرئيسية وabout وcontact تتمدّد بترتيب clusterAlternates، وx-default الإنجليزية', () => {
  withPublished([...LEGACY_LOCALES, ES, UR_LOCALE], () => {
    const reg = PUBLISHED;
    const home = seoUrls('/', 'ar');
    assert.ok(home.alternates.some((a) => a.href === 'https://fieldsa.net/es/'), 'رئيسية es غائبة عن عنقود الرئيسية');
    assert.equal(xd(home), 'https://fieldsa.net/en');
    assert.equal(home.alternates[home.alternates.length - 1]?.hreflang, 'x-default');
    // React (بعد canon في useSeo) = prerender والخريطة (clusterAlternates) — العدد والترتيب والروابط
    for (const [arPath, key] of [['/', 'home'], ['/about', 'about'], ['/contact', 'contact']] as const) {
      for (const L of ['ar', 'en', 'fr'] as const) {
        const got = seoUrls(arPath, L).alternates.map((a) => ({ hreflang: a.hreflang, href: canon(a.href) }));
        assert.deepEqual(got, clusterAlternates(key, reg), `${arPath} (${L})`);
      }
      assert.deepEqual(newClusterMembers(key, reg).map((a) => a.hreflang), ['es', 'ur']);
    }
    // المدوّنة تمرّر لغاتها صراحةً فلا تتمدّد، و/meeting خارج العناقيد الممدّدة، والصفحات الثلاثية الأخرى كذلك
    assert.deepEqual(seoUrls('/blog/x', 'ar', ['ar', 'en']).alternates, [
      { hreflang: 'ar', href: 'https://fieldsa.net/blog/x' },
      { hreflang: 'en', href: 'https://fieldsa.net/en/blog/x' },
      { hreflang: 'x-default', href: 'https://fieldsa.net/en/blog/x' },
    ]);
    assert.ok(!seoUrls('/meeting', 'ar').alternates.some((a) => /\/(es|ur)\//.test(a.href)));
    assert.ok(!seoUrls('/pricing', 'ar').alternates.some((a) => /\/(es|ur)\//.test(a.href)));
    // صريحة حتى للرئيسية: لا تمديد
    assert.equal(seoUrls('/', 'ar', ['ar', 'en', 'fr', 'tr', 'zh']).alternates.length, 6);
  });
});

/* ─── الزرّ العائم على صفحات الطبقة ─────────────────────────────────────── */

function renderFabAt(pathname: string): string {
  const g = globalThis as unknown as Record<string, unknown>;
  const store = new Map<string, string>();
  const values: Record<string, unknown> = {
    window: {}, navigator: {},
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
  };
  const saved = Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const k of Object.keys(values)) Object.defineProperty(g, k, { value: values[k], configurable: true, writable: true });
  try {
    return renderToStaticMarkup(createElement(StaticRouter, { location: pathname }, createElement(WhatsAppFab)));
  } finally {
    for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  }
}

test('الزرّ العائم على /languages/ وصفحات en الجديدة: إنجليزي بلغة الصفحة (لا عربية ساقطة)', () => {
  for (const p of ['/languages/', enPage('countries').path]) {
    const html = renderFabAt(p);
    assert.match(html, /class="wa-fab"/);
    assert.match(html, /aria-label="Chat with us on WhatsApp"/, `${p}: تسمية غير إنجليزية`);
    assert.match(html, /[?&;]l=en(&|")/, `${p}: لغة المحوّل ليست en`);
  }
});

/* ─── حرّاس نصية لمواضع الدمج في React ─────────────────────────────────── */

test('تذييل الهبوط: رابط واحد إلى /languages/ يُحقن في سطر الحقوق بعد تطبيع الشرطات، والقالب يحوي السطر مرة واحدة', async () => {
  const land = fs.readFileSync(path.join(root, 'src', 'pages', 'LandingPage.tsx'), 'utf8');
  const slash = land.indexOf('html = slashInternalLinks(html);');
  const link = land.indexOf('html = injectLanguagesLink(html, lang);');
  assert.ok(slash > 0 && link > slash, 'injectLanguagesLink يجب أن يأتي بعد slashInternalLinks');
  const m = land.match(/html\.replace\((\/\(<span[^\n]*?<\\\/span>\)\/), /);
  assert.ok(m, 'تعبير سطر الحقوق في injectLanguagesLink غير موجود');
  const re = new RegExp(m![1].slice(1, -1));
  const { LANDING_TEMPLATE } = await import('../landing/landingTemplate');
  assert.equal((LANDING_TEMPLATE.match(new RegExp(re.source, 'g')) || []).length, 1, 'سطر الحقوق في قالب الهبوط تغيّر — الرابط لن يظهر');
  for (const label of ['لغات أخرى', 'Other languages', 'Autres langues', 'Diğer diller', '其他语言']) assert.ok(land.includes(`'${label}'`));
});

test('صفحة الطبقة في React: useSeo في Done وحده (لا يحذف hreflang المُصيَّر أثناء التحميل)، والمحتوى من القالب حرفياً', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'pages', 'I18nMarketingPage.tsx'), 'utf8');
  assert.equal((src.match(/\buseSeo\(/g) || []).length, 1);
  const done = src.slice(src.indexOf('function Done('), src.indexOf('export default function I18nMarketingPage'));
  assert.match(done, /useSeo\(/);
  assert.match(done, /dangerouslySetInnerHTML=\{\{ __html: r\.html \}\}/);
  assert.match(src, /renderI18nPage\(\{ page, reg: PUBLISHED/);
});

/* ─── السجل المنشور الحقيقي كما هو اليوم ──────────────────────────────────── */

interface RegistryRow { code: string; script: string }
const SCRIPTS = new Map(readJson<{ locales: RegistryRow[] }>('src', 'i18n', 'registry', 'locales.json').locales.map((l) => [l.code, l.script]));

test('كل صفحة منشورة تُصيَّر بلا خطأ: عنوان ووصف وh1، ولغة واتجاه السجل، وملاحظة لغات الواجهة، ولا عربية في غير الكتابة العربية', () => {
  const files = new Map<string, MarketingFile>();
  const fileOf = (code: string) => {
    if (!files.has(code)) files.set(code, readJson<MarketingFile>('src', 'i18n', 'marketing', `${code}.json`));
    return files.get(code)!;
  };
  const byCode = new Map(PUBLISHED.locales.map((l) => [l.code, l]));
  for (const page of I18N_PAGES) {
    const r = renderI18nPage({
      page, reg: PUBLISHED, file: page.pageKey === 'languages' ? undefined : fileOf(page.code),
      world: page.pageKey === 'countries' ? WORLD : undefined, vatByCode: VAT,
    });
    const where = page.path;
    assert.ok(r.title.trim() && r.description.trim() && r.h1.trim(), `${where}: عنوان أو وصف أو h1 فارغ`);
    assert.equal(r.lang, page.hreflang, `${where}: lang`);
    assert.equal(r.dir, page.pageKey === 'languages' ? 'ltr' : byCode.get(page.code)!.dir, `${where}: dir`);
    assert.equal(r.canonical, canon(`https://fieldsa.net${page.path}`));
    assert.deepEqual(r.alternates, page.clusterKey ? clusterAlternates(page.clusterKey, PUBLISHED) : []);
    assert.match(r.html, /<p data-i18n-ui>[^<]+<\/p>/, `${where}: بلا ملاحظة لغات الواجهة`);
    assert.doesNotMatch(r.html, /\{(uiLanguages|countriesCount|year)\}/, `${where}: عنصر نائب متبقٍّ`);
    const { types, keys } = ldScan(r.jsonld);
    assert.ok(!types.includes('Organization') && !types.some((t) => /Offer/.test(t)) && !keys.some((k) => /price/i.test(k)), `${where}: JSON-LD`);
    if (page.pageKey !== 'languages' && SCRIPTS.get(page.code) !== 'Arab') {
      let text = withoutLangsNav(r.html).split(AR_NAME).join('');
      if (PUNCT_SHARING_SCRIPTS.has(SCRIPTS.get(page.code)!)) text = text.replace(SHARED_ARABIC_PUNCT, '');
      assert.doesNotMatch(text, ARABIC_SCRIPT, `${where}: حرف عربي خارج مبدّل اللغات`);
    }
    if (page.pageKey === 'countries') assert.equal((r.html.match(/<tr><th scope="row">/g) || []).length, 249, `${where}: صفوف الجدول`);
  }
});

test('السجل الحقيقي: عناقيد الرئيسية وabout وcontact في React (seoUrls بعد canon) = prerender والخريطة (clusterAlternates)', () => {
  for (const [arPath, key] of [['/', 'home'], ['/about', 'about'], ['/contact', 'contact']] as const) {
    const got = seoUrls(arPath, 'en').alternates.map((a) => ({ hreflang: a.hreflang, href: canon(a.href) }));
    assert.deepEqual(got, clusterAlternates(key, PUBLISHED), arPath);
  }
});
