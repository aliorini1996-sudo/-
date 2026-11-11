import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  renderI18nPage, vatMapFrom, COUNTRY_SECTION_IDS,
  type MarketingFile, type WorldCountries, type CountryPageFile, type CountryPageContent,
} from './marketingTemplate.mjs';
import {
  i18nPages, i18nPageForPath, pagePath, clusterOf, clusterAlternates, countrySlug, countryPageKey, countryOfPageKey,
  withCountryPages, requiredKeys, DEFAULT_CATEGORY_SLUG,
  type PublishedRegistry, type CountryPageEntry, type CountryPagesIndex, type I18nPage,
} from './i18nRoutes.mjs';
import { PUBLISHED, I18N_PAGES } from './i18nPublished';
import { COUNTRIES } from './countries';
import { checkCountryContent, stampProblem, COUNTRY_YEAR_SECTION } from '../../scripts/claims-i18n.mjs';

/**
 * صفحات الدول في الطبقة متعددة اللغات (نوع «country:<CC>»): المكسيك وكولومبيا بالإسبانية، والبرازيل بالبرتغالية،
 * وإندونيسيا بالإندونيسية، على /<lang>/<slug>/ من slugHint ملف الدولة.
 *
 * مثبّت دولة مصغّر مكتوب هنا (لا يتبع ما نشره المصنع اليوم) فوق السجل الحقيقي وملف es.json الحقيقي:
 * المسار، والربط من صفّ الدولة في جدول /es/countries/ ومن قائمة صفحات اللغة، وFAQPage، وx-default الذاتي،
 * وقاعدة السنة (مسموحة في قسم einvoicing وحده، وختم «آخر تحقق» بسنة التحقق وحدها، ورقم+عملة حاجب في كل مكان).
 * ثم الفهرس الملتزم نفسه: كل صفحة فيه تُصيَّر من ملفها، وكل مستثناة بسبب مكتوب.
 */

const root = process.cwd();
const readJson = <T>(...p: string[]): T => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8')) as T;
const ES = readJson<MarketingFile>('src', 'i18n', 'marketing', 'es.json');
const WORLD = readJson<WorldCountries>('src', 'i18n', 'world-countries.json');
const VAT = vatMapFrom(COUNTRIES);
const BASE = { ...PUBLISHED, countryPages: [] } as PublishedRegistry;

const SLUG = 'software-preventa-mexico-prueba';
const content = (over: Partial<CountryPageContent> = {}): CountryPageContent => ({
  slugHint: 'Software preventa México prueba',
  title: 'Software de preventa en México | FieldSales',
  description: 'Preventa, venta en ruta y cobranza para distribuidoras en México: notas de venta desde el celular y modo sin conexión.',
  h1: 'FieldSales para distribuidoras en México',
  intro: 'FieldSales es una plataforma para distribuidoras con vendedores de ruta.',
  sections: COUNTRY_SECTION_IDS.map((id) => ({
    id,
    title: `Sección ${id}`,
    body: id === 'einvoicing'
      ? 'La factura electrónica es obligatoria desde 2014 y la versión 4.0 es la única válida desde 2023.\nFieldSales no emite CFDI.'
      : `Texto de la sección ${id} sin fechas.`,
  })),
  faq: [
    { q: '¿FieldSales emite CFDI?', a: 'No. Tu empresa lo emite con su PAC.' },
    { q: '¿Funciona sin conexión?', a: 'Sí, y sincroniza al volver la señal.' },
  ],
  sampleInvoice: {
    title: 'Estructura de referencia',
    note: 'Ejemplo de estructura, sin importes.',
    fields: [{ label: 'Emisor', example: 'RFC y razón social' }, { label: 'Moneda', example: 'MXN' }],
  },
  sources: [{ title: 'Servicio de Administración Tributaria (SAT)', url: 'https://www.sat.gob.mx' }],
  lastVerifiedLabel: 'Última verificación: noviembre de 2026',
  ...over,
});
const countryFile = (c: CountryPageContent = content()): CountryPageFile => ({
  code: 'MX', languages: ['es'], basedOnFactsVerifiedAt: '2026-11-11', content: { es: c }, review: { quality: 'publish' },
});
const ENTRY: CountryPageEntry = { cc: 'MX', code: 'es', slug: SLUG, h1: content().h1, contentDate: '2026-11-11', contentHash: 'x' };
const REG = withCountryPages(BASE, { pages: [ENTRY] });
const pageOf = (reg: PublishedRegistry, code: string, pageKey: I18nPage['pageKey']): I18nPage => {
  const p = i18nPages(reg).find((x) => x.code === code && x.pageKey === pageKey);
  assert.ok(p, `لا صفحة ${code}/${pageKey}`);
  return p!;
};
const renderMx = (c?: CountryPageContent) => renderI18nPage({ page: pageOf(REG, 'es', 'country:MX'), reg: REG, file: ES, country: countryFile(c) });

test('المسار: /es/<slug>/ من slugHint، بعد صفحات اللغة، ومفتاحه country:MX وعنقوده ذاتي', () => {
  assert.equal(countrySlug('Software preventa México prueba'), SLUG);
  assert.equal(countrySlug('features'), null, 'مقطع محجوز داخل اللغة');
  assert.equal(countrySlug('countries'), null);
  assert.equal(countrySlug(DEFAULT_CATEGORY_SLUG), null, 'slug الفئة الافتراضي يصادمها');
  assert.equal(countrySlug('مكسيك'), null, 'بلا حرف لاتيني — لا رجوع إلى slug افتراضي');
  assert.equal(countrySlug(null), null);
  assert.equal(countryPageKey('mx'), 'country:MX');
  assert.equal(countryOfPageKey('country:MX'), 'MX');
  assert.equal(countryOfPageKey('countries'), null);
  assert.equal(pagePath('es', 'country:MX', SLUG), `/es/${SLUG}/`);
  assert.throws(() => pagePath('es', 'country:MX', 'features'), /slug/);
  assert.equal(clusterOf('country:MX'), 'country:MX');

  const pages = i18nPages(REG);
  const es = pages.filter((p) => p.code === 'es');
  const mx = es.find((p) => p.pageKey === 'country:MX')!;
  assert.equal(mx.path, `/es/${SLUG}/`);
  assert.equal(mx.hreflang, 'es');
  assert.equal(es[es.length - 1].pageKey, 'country:MX', 'صفحة الدولة بعد صفحات لغتها');
  assert.equal(i18nPageForPath(`/es/${SLUG}`, REG)?.pageKey, 'country:MX');
  assert.equal(new Set(pages.map((p) => p.path)).size, pages.length, 'لا تصادم مع أي مسار للطبقة');
  // slug يساوي slug فئة اللغة ⇒ المسار مكرّر فيرمي (لا صفحة تبتلع أخرى بصمت)
  const esSlug = PUBLISHED.locales.find((l) => l.code === 'es')!.slug;
  assert.throws(() => i18nPages(withCountryPages(BASE, { pages: [{ ...ENTRY, slug: esSlug }] })), /مكرّر/);
  // لغة بلا صفحة دول ⇒ لا صفحة دولة (لا صفّ يربطها)
  const noCountries = { ...BASE, locales: BASE.locales.map((l) => (l.code === 'es' ? { ...l, pages: l.pages.filter((k) => k !== 'countries') } : l)) };
  assert.ok(!i18nPages(withCountryPages(noCountries, { pages: [ENTRY] })).some((p) => p.pageKey === 'country:MX'));
  assert.deepEqual(requiredKeys('country:MX', Object.keys(ES.strings)).sort(), [
    'tierB.countries.h1', 'tierB.home.cta.meeting', 'tierB.home.cta.quote', 'tierB.home.cta.whatsapp', 'tierB.home.uiLanguagesNote',
  ]);
});

test('الربط: صفّ المكسيك في /es/countries/ يربط صفحتها باسمها، وقائمة صفحات كل صفحة إسبانية تحمل رابطها بعنوانها', () => {
  const r = renderI18nPage({ page: pageOf(REG, 'es', 'countries'), reg: REG, file: ES, world: WORLD, vatByCode: VAT });
  const row = (r.html.match(/<tr><th scope="row"><a href="[^"]+" data-country-link="MX">[^<]+<\/a><\/th>/) || [''])[0];
  assert.ok(row.includes(`href="/es/${SLUG}/"`), 'صفّ MX لا يربط الصفحة');
  assert.ok(row.includes(`>${ES._derived.countryNames.MX}</a>`), 'نصّ الرابط اسم الدولة نفسه (G6 يطابقه)');
  assert.equal((r.html.match(/data-country-link=/g) || []).length, 1, 'دولة واحدة لها صفحة بالإسبانية في المثبّت');
  // بلا فهرس: لا رابط في الجدول (السجل الحقيقي يبقى كما كان)
  const plain = renderI18nPage({ page: pageOf(BASE, 'es', 'countries'), reg: BASE, file: ES, world: WORLD, vatByCode: VAT });
  assert.ok(!plain.html.includes('data-country-link'));
  for (const key of ['home', 'category', 'about'] as const) {
    const h = renderI18nPage({ page: pageOf(REG, 'es', key), reg: REG, file: ES, world: WORLD, vatByCode: VAT }).html;
    const nav = (h.match(/<nav data-i18n-pages>[\s\S]*?<\/nav>/) || [''])[0];
    assert.ok(nav.includes(`<a href="/es/${SLUG}/">${ENTRY.h1}</a>`), `${key}: قائمة الصفحات بلا رابط صفحة الدولة`);
  }
  // ولا تظهر في لغة أخرى
  const ptHome = renderI18nPage({ page: pageOf(REG, 'pt', 'home'), reg: REG, file: readJson<MarketingFile>('src', 'i18n', 'marketing', 'pt.json') }).html;
  assert.ok(!ptHome.includes(SLUG));
});

test('صفحة الدولة: الأقسام بترتيبها، ومثال الفاتورة، والمصادر، وختم آخر تحقق، والأزرار وملاحظة لغات الواجهة', () => {
  const r = renderMx();
  assert.equal(r.title, content().title);
  assert.equal(r.h1, content().h1);
  assert.equal(r.lang, 'es');
  assert.equal(r.canonical, `https://fieldsa.net/es/${SLUG}/`);
  assert.ok(r.html.startsWith('<div class="i18n" data-i18n-page="country:MX" lang="es" dir="ltr">'));
  assert.deepEqual([...r.html.matchAll(/data-country-section="([^"]+)"/g)].map((m) => m[1]), [...COUNTRY_SECTION_IDS]);
  assert.match(r.html, /<table data-country-sample-fields><tbody><tr><th scope="row">Emisor<\/th><td>RFC y razón social<\/td><\/tr>/);
  assert.match(r.html, /<section data-country-sources><h2>[^<]+<\/h2><ul><li><a href="https:\/\/www\.sat\.gob\.mx" rel="noopener">/);
  assert.match(r.html, /<p data-country-verified><time datetime="2026-11-11">Última verificación: noviembre de 2026<\/time><\/p>/);
  assert.ok(r.html.includes('/en/subscribe-request/?type=quote') && r.html.includes('/en/meeting/') && r.html.includes('go/wa'), 'الأزرار');
  assert.ok(r.html.includes(`<p data-i18n-ui>${ES.strings['tierB.home.uiLanguagesNote']}</p>`), 'ملاحظة لغات الواجهة الصادقة');
  // أسطر قسم einvoicing فقرتان
  assert.match(r.html, /data-country-section="einvoicing"><h2>[^<]+<\/h2><p>[^<]+<\/p><p>FieldSales no emite CFDI\.<\/p><\/section>/);
});

test('FAQPage = الأسئلة الظاهرة، وBreadcrumb عبر صفحة الدول، وdateModified تاريخ التحقق', () => {
  const r = renderMx();
  const graph = (r.jsonld as { '@graph': Record<string, unknown>[] })['@graph'];
  const faq = graph.find((n) => n['@type'] === 'FAQPage') as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
  assert.ok(faq, 'لا FAQPage');
  assert.deepEqual(faq.mainEntity.map((q) => q.name), content().faq.map((f) => f.q));
  assert.deepEqual(faq.mainEntity.map((q) => q.acceptedAnswer.text), content().faq.map((f) => f.a));
  const shown = [...r.html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(shown, content().faq.map((f) => f.q.replace(/&/g, '&amp;')));
  assert.equal(r.faq.length, 2);
  const web = graph.find((n) => n['@type'] === 'WebPage') as Record<string, unknown>;
  assert.equal(web.dateModified, '2026-11-11');
  assert.equal(web.inLanguage, 'es');
  const crumbs = (graph.find((n) => n['@type'] === 'BreadcrumbList') as { itemListElement: { position: number; item: string }[] }).itemListElement;
  assert.deepEqual(crumbs.map((c) => c.item), ['https://fieldsa.net/es/', 'https://fieldsa.net/es/countries/', `https://fieldsa.net/es/${SLUG}/`]);
  assert.deepEqual(crumbs.map((c) => c.position), [1, 2, 3]);
  const ld = JSON.stringify(r.jsonld);
  assert.ok(!/"(?:Aggregate)?Offer"|"price"/.test(ld), 'لا عروض ولا أسعار');
});

test('x-default ذاتي: canonical = hreflang es = x-default (لا نظير بلغة أخرى)', () => {
  const r = renderMx();
  const self = `https://fieldsa.net/es/${SLUG}/`;
  assert.deepEqual(r.alternates, [{ hreflang: 'es', href: self }, { hreflang: 'x-default', href: self }]);
  assert.deepEqual(clusterAlternates('country:MX', REG), r.alternates);
  assert.deepEqual(clusterAlternates('country:CO', REG), [], 'دولة بلا صفحة ⇒ لا عنقود');
  // العناقيد القائمة لا تتغيّر بإضافة صفحة الدولة
  for (const key of ['home', 'category', 'countries', 'about', 'contact'] as const) {
    assert.deepEqual(clusterAlternates(key, REG), clusterAlternates(key, BASE), key);
  }
});

test('قاعدة السنة: مسموحة في قسم einvoicing وحده؛ وحاجبة في بقية الصفحة؛ ورقم+عملة حاجب حتى في einvoicing', () => {
  const opts = { code: 'es', livePrices: [] as string[], verifiedAt: '2026-11-11' };
  assert.equal(COUNTRY_YEAR_SECTION, 'einvoicing');
  assert.deepEqual(checkCountryContent(content(), opts), [], 'المثبّت: سنوات في einvoicing وحده + ختم بسنة التحقق');
  const withTaxYear = content({
    sections: content().sections.map((s) => (s.id === 'tax' ? { ...s, body: 'La tasa general es 16% desde 2010.' } : s)),
  });
  const v1 = checkCountryContent(withTaxYear, opts);
  assert.deepEqual(v1.map((v) => [v.id, v.path, v.match]), [['i18n-year', 'sections.tax.body', '2010']]);
  for (const [field, over] of [
    ['title', { title: 'Software 2027 | FieldSales' }],
    ['faq.0.a', { faq: [{ q: '¿CFDI?', a: 'Llegará en 2027.' }] }],
    ['sampleInvoice.fields.0.example', { sampleInvoice: { title: 'x', fields: [{ label: 'Fecha', example: '11/11/2026' }] } }],
    ['sources.0.title', { sources: [{ title: 'Decreto 358 de 2020', url: 'https://www.dian.gov.co' }] }],
  ] as const) {
    const v = checkCountryContent(content(over as Partial<CountryPageContent>), opts);
    assert.ok(v.some((x) => x.id === 'i18n-year' && x.path === field), `${field}: السنة يجب أن تُحجب خارج einvoicing`);
  }
  const money = content({
    sections: content().sections.map((s) => (s.id === 'einvoicing' ? { ...s, body: 'Multa de MXN 1500 desde 2014.' } : s)),
  });
  assert.ok(checkCountryContent(money, opts).some((v) => v.id === 'i18n-currency-number' && v.path === 'sections.einvoicing.body'), 'رقم+عملة حاجب في einvoicing');
  assert.ok(checkCountryContent(content({ sampleInvoice: { title: 'x', fields: [{ label: 'Total', example: '$ 100' }] } }), opts)
    .some((v) => v.id === 'i18n-currency-number'), 'مثال الفاتورة بلا مبالغ');
  assert.ok(checkCountryContent(content({ intro: 'FieldSales está certificado por el SAT.' }), opts).some((v) => v.id === 'i18n-certification'));
  // ختم «آخر تحقق»: سنة التحقق وحدها
  assert.equal(stampProblem('Última verificación: noviembre de 2026', '2026-11-11'), null);
  assert.equal(stampProblem('Verificado el 11/11/2026', '2026-11-11'), null);
  assert.match(String(stampProblem('Última verificación: noviembre de 2025', '2026-11-11')), /2025/);
  assert.ok(checkCountryContent(content({ lastVerifiedLabel: 'Actualizado en 2025' }), opts).some((v) => v.path === 'lastVerifiedLabel'));
});

test('مدخلات ناقصة تُسقط التصيير بخطأ صريح (لا صفحة ناقصة بصمت)', () => {
  const page = pageOf(REG, 'es', 'country:MX');
  assert.throws(() => renderI18nPage({ page, reg: REG, file: ES }), /ملف الدولة/);
  assert.throws(() => renderI18nPage({ page, reg: REG, file: ES, country: { ...countryFile(), code: 'CO' } }), /CO/);
  assert.throws(() => renderMx(content({ sections: content().sections.slice(1) })), /أقسام/);
  assert.throws(() => renderMx(content({ sources: [{ url: 'http://x.example' }] })), /https/);
  assert.throws(() => renderMx(content({ faq: [] })), /faq/);
  assert.throws(() => renderMx(content({ h1: ' ' })), /h1/);
});

test('الفهرس الملتزم: كل صفحة فيه تُصيَّر من ملفها بلغة سوقها، وكل مستثناة بسبب، وI18N_PAGES يحمل صفحاته', () => {
  const index = readJson<CountryPagesIndex>('src', 'i18n', 'registry', 'country-pages.json');
  const targets: Record<string, string> = { MX: 'es', CO: 'es', BR: 'pt', ID: 'id' };
  const seen = [...index.pages.map((p) => p.cc), ...index.excluded.map((x) => x.cc)].sort();
  assert.deepEqual(seen, Object.keys(targets).sort(), 'كل دولة مستهدفة إما منشورة أو مستثناة');
  for (const x of index.excluded) assert.ok(x.reasons.length > 0, `${x.cc}: استثناء بلا سبب`);
  for (const e of index.pages) {
    assert.equal(e.code, targets[e.cc], `${e.cc}: لغة السوق`);
    const file = readJson<CountryPageFile>('src', 'content', 'country-pages', `${e.cc}.json`);
    const c = file.content[e.code];
    assert.equal(countrySlug(c.slugHint), e.slug, `${e.cc}: slug من slugHint`);
    assert.equal(c.h1, e.h1);
    assert.equal(e.contentDate, file.basedOnFactsVerifiedAt);
    assert.ok(fs.existsSync(path.join(root, 'src', 'content', 'country-facts', `${e.cc}.json`)), `${e.cc}: الحقائق المدقّقة`);
    const page = I18N_PAGES.find((p) => p.pageKey === `country:${e.cc}`);
    assert.ok(page, `${e.cc}: ليست في I18N_PAGES`);
    const r = renderI18nPage({ page: page!, reg: PUBLISHED, file: readJson<MarketingFile>('src', 'i18n', 'marketing', `${e.code}.json`), country: file });
    assert.equal(r.canonical, `https://fieldsa.net${page!.path}`);
    assert.equal(r.alternates.length, 2);
    assert.deepEqual(checkCountryContent(c, { code: e.code, livePrices: [], verifiedAt: file.basedOnFactsVerifiedAt }), [], `${e.cc}: مخالفة منشورة`);
  }
});
