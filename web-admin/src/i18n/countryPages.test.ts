import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderI18nPage, vatMapFrom, escapeHtml, COUNTRY_SECTION_IDS,
  type MarketingFile, type WorldCountries, type CountryPageFile, type CountryPageContent, type Rendered,
} from './marketingTemplate.mjs';
import {
  i18nPages, i18nPageForPath, pagePath, clusterOf, clusterAlternates, countrySlug, countryPageKey, countryOfPageKey,
  withCountryPages, requiredKeys, DEFAULT_CATEGORY_SLUG,
  type PublishedRegistry, type CountryPageEntry, type CountryPagesIndex, type I18nPage,
} from './i18nRoutes.mjs';
import { PUBLISHED, I18N_PAGES } from './i18nPublished';
import { COUNTRIES } from './countries';
import {
  checkCountryContent, stampProblem, selfYearViolations, govLinkViolations, COUNTRY_YEAR_SECTION,
} from '../../scripts/claims-i18n.mjs';
import {
  strippedCountryFile, countryContentRel, countryContentFilesProblems, countryLeakFingerprints, assetLeaks,
  countryPageDistProblems, countryLinkProblems, deriveCountryContentFiles, COUNTRY_CONTENT_DIR,
} from '../../scripts/country-i18n.mjs';

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

/** قسم einvoicing من المثبّت مع جملة مُلحقة */
const withEinv = (extra: string, base = content()): CountryPageContent => ({
  ...base,
  sections: base.sections.map((s) => (s.id === 'einvoicing' ? { ...s, body: `${s.body}\n${extra}` } : s)),
});
const ids = (c: CountryPageContent, code = 'es') => checkCountryContent(c, { code, livePrices: [], verifiedAt: '2026-11-11' }).map((v) => `${v.id}@${v.path}`);

test('السنة داخل einvoicing محجوبة في كل جملة عن FieldSales نفسها (الاسم أو المتكلم) — الحقيقة الحكومية بتاريخها تمرّ', () => {
  // حالة المراجِع حرفياً: موعد بجوار FieldSales داخل القسم المسموح كان يمرّ من الحارسين
  assert.deepEqual(ids(withEinv('FieldSales integrará la factura electrónica de la DIAN en 2027.')), ['i18n-year-self@sections.einvoicing.body']);
  for (const s of [
    'Integraremos la factura electrónica de la DIAN en 2027.', // المتكلم بلا اسم ولا ضمير (صيغة المستقبل)
    'Nuestro equipo conectará la DIAN en 2027.',
    'Desde 2027, nosotros emitiremos la factura.',
  ]) assert.ok(ids(withEinv(s)).includes('i18n-year-self@sections.einvoicing.body'), s);
  assert.equal(selfYearViolations('O FieldSales vai se conectar à SEFAZ em 2027.', 'pt').length, 1);
  assert.equal(selfYearViolations('Kami akan terhubung ke DJP pada 2027.', 'id').length, 1);
  // الحقيقة الحكومية بتاريخها مسموحة، ولو تلتها مباشرة جملة الإفصاح عن FieldSales (النافذة كانت ستحجبها، الجملة لا)
  assert.deepEqual(ids(withEinv('La DIAN exige la factura electrónica desde 2019. FieldSales no transmite facturas a la DIAN.')), []);
  assert.equal(selfYearViolations('A NF-e é obrigatória desde 2008 para o atacado.', 'pt').length, 0);
  // خارج einvoicing السنة محجوبة أصلاً (i18n-year) لا بهذه القاعدة
  assert.ok(ids(content({ intro: 'FieldSales llegará a Colombia en 2027.' })).includes('i18n-year@intro'));
});

test('ادّعاء ربط حكومي لـFieldSales خارج السعودية محجوب في كل الصفحة؛ والنفي و«عند الطلب» والسعودية والسؤال تمرّ', () => {
  for (const [code, s] of [
    ['es', 'FieldSales está conectado directamente con la DIAN y transmite tus facturas electrónicas'],
    ['es', 'FieldSales es proveedor tecnológico habilitado por la DIAN'],
    ['es', 'Transmitimos tus CFDI al SAT en tiempo real.'],
    ['pt', 'O FieldSales é integrado com a SEFAZ e transmite as NF-e.'],
    ['pt', 'O FieldSales é credenciado pela Receita Federal.'],
    ['id', 'FieldSales terhubung langsung ke Coretax DJP.'],
    ['id', 'FieldSales adalah PJAP resmi DJP.'],
  ] as const) assert.equal(govLinkViolations(s, code).length, 1, `${code}: ${s}`);
  for (const [code, s] of [
    ['es', 'FieldSales no está conectado con la DIAN.'],
    ['es', 'La conexión de FieldSales con la DIAN está disponible bajo solicitud, sin fecha.'],
    ['es', 'FieldSales está conectado con la ZATCA en Arabia Saudita.'],
    ['es', '¿FieldSales se conecta con la DIAN?'],
    ['es', 'El vendedor sigue trabajando sin estar conectado a internet y FieldSales sincroniza al volver la señal.'],
    ['pt', 'O FieldSales não tem conexão direta com a SEFAZ.'],
    ['id', 'FieldSales tidak terhubung ke DJP.'],
  ] as const) assert.equal(govLinkViolations(s, code).length, 0, `${code}: ${s}`);
  // في المقدمة وفي einvoicing كليهما (لا استثناء لقسم)
  assert.ok(ids(content({ intro: 'FieldSales está conectado directamente con la DIAN y transmite tus facturas electrónicas.' })).includes('i18n-gov-link@intro'));
  assert.ok(ids(withEinv('FieldSales es proveedor tecnológico habilitado por la DIAN.')).includes('i18n-gov-link@sections.einvoicing.body'));
  // لغة بلا قاعدة جملة ⇒ لا تُنشر صفحة دولة بها
  assert.ok(ids(content(), 'it').includes('i18n-gov-link@(lang)'));
});

test('الملف المشتق المجرّد: content[code] بحقول القالب وحدها — لا notes ولا review ولا لغة أخرى ولا حقل مجهول', () => {
  const raw = {
    ...countryFile(),
    languages: ['es', 'pt'],
    notes: 'ملاحظة داخلية: تعذّر فتح موقع SAT',
    review: { reviewedAt: '2026-11-11', quality: 'publish', issues: ['تجنّبت عمداً ذكر certificado del CSD'] },
    content: {
      es: { ...content(), internalNote: 'لا يُنشر', sources: [{ url: 'https://www.sat.gob.mx', title: 'SAT', note: 'تعذّر فتحه' }] },
      pt: content({ h1: 'Outra língua' }),
    },
  } as unknown as CountryPageFile;
  const d = strippedCountryFile(raw, 'es');
  assert.deepEqual(Object.keys(d).sort(), ['basedOnFactsVerifiedAt', 'code', 'content']);
  assert.deepEqual(Object.keys(d.content), ['es']);
  const text = JSON.stringify(d);
  for (const bad of ['notes', 'review', 'reviewedAt', 'internalNote', 'تعذّر', 'Outra língua', 'CSD']) assert.ok(!text.includes(bad), bad);
  // ويُصيَّر مثل الأصل حرفاً بحرف
  const page = pageOf(REG, 'es', 'country:MX');
  assert.equal(renderI18nPage({ page, reg: REG, file: ES, country: d }).html, renderI18nPage({ page, reg: REG, file: ES, country: raw }).html);
  // حزمة المتصفح تجمع المجلد المشتق وحده — لا src/content
  const tsx = fs.readFileSync(path.join(root, 'src', 'pages', 'I18nMarketingPage.tsx'), 'utf8');
  const globs = [...tsx.matchAll(/import\.meta\.glob[^(]*\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(globs.includes(`../${COUNTRY_CONTENT_DIR.replace(/^src\//, '')}/*.json`), `glob المجلد المشتق: ${globs.join(' · ')}`);
  assert.ok(!globs.some((g) => /content\/country-(?:pages|facts)/.test(g)), 'لا glob على src/content');
  assert.ok(!/['"`][^'"`]*content\/country-(?:pages|facts)\//.test(tsx), 'لا استيراد من src/content');
});

/** مستند HTML من ناتج القالب بالبنية التي يكتبها prerender (buildPage): title وmeta وcanonical وhreflang وJSON-LD ثم #root */
const docOf = (r: Rendered) => `<!doctype html><html lang="${r.lang}" dir="${r.dir}"><head><title>${escapeHtml(r.title)}</title>`
  + `<meta name="description" content="${escapeHtml(r.description)}" />`
  + `<meta property="og:title" content="${escapeHtml(r.title)}" /><meta property="og:description" content="${escapeHtml(r.description)}" />`
  + `<link rel="canonical" href="${r.canonical}" />`
  + r.alternates.map((a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`).join('')
  + `<script type="application/ld+json">${JSON.stringify(r.jsonld)}</script></head><body><div id="root">${r.html}</div></body></html>`;

test('فحوص dist لصفحة الدولة (G3 · G5 · G6) على HTML مصيَّر من المثبّت: سليمة، ثم كل كسر يُلتقط ببوابته', () => {
  const page = pageOf(REG, 'es', 'country:MX');
  const country = strippedCountryFile(countryFile(), 'es');
  const run = (html: string, c: CountryPageFile = country) => countryPageDistProblems({ html, page, reg: REG, country: c, livePrices: ['299'] });
  const good = docOf(renderI18nPage({ page, reg: REG, file: ES, country }));
  assert.deepEqual(run(good), [], 'الصفحة المصيَّرة من المثبّت سليمة');
  const gates = (html: string, c?: CountryPageFile) => [...new Set(run(html, c).map((x) => x.g))].sort();
  const self = `https://fieldsa.net/es/${SLUG}/`;
  // G3: canonical غير ذاتي · x-default إلى غيرها · بديل زائد
  assert.deepEqual(gates(good.replace(`<link rel="canonical" href="${self}" />`, '<link rel="canonical" href="https://fieldsa.net/es/" />')), ['G3']);
  assert.deepEqual(gates(good.replace(`hreflang="x-default" href="${self}"`, 'hreflang="x-default" href="https://fieldsa.net/en/"')), ['G3']);
  assert.deepEqual(gates(good.replace('</head>', '<link rel="alternate" hreflang="pt" href="https://fieldsa.net/pt/" /></head>')), ['G3']);
  // G5: سنة خارج einvoicing في الصفحة · سنة قرب FieldSales داخل einvoicing · ادّعاء ربط · ختم بسنة أخرى · رقم+عملة · عنوان بسنة
  const html = (c: CountryPageContent) => docOf(renderI18nPage({ page, reg: REG, file: ES, country: strippedCountryFile(countryFile(c), 'es') }));
  const g5 = (c: CountryPageContent) => run(html(c), strippedCountryFile(countryFile(c), 'es')).filter((x) => x.g === 'G5').map((x) => x.msg).join('\n');
  assert.match(g5(content({ sections: content().sections.map((s) => (s.id === 'tax' ? { ...s, body: 'La tasa general es 16% desde 2010.' } : s)) })), /\[i18n-year\] «2010»/);
  assert.match(g5(withEinv('FieldSales integrará la factura electrónica de la DIAN en 2027.')), /\[i18n-year-self\]/);
  assert.match(g5(content({ intro: 'FieldSales está conectado directamente con la DIAN y transmite tus facturas electrónicas.' })), /\[i18n-gov-link\]/);
  assert.match(g5(content({ lastVerifiedLabel: 'Última verificación: noviembre de 2025' })), /2025/);
  assert.match(g5(withEinv('Multa de MXN 1500.')), /\[i18n-currency-number\]/);
  assert.match(g5(content({ title: 'Software 2027 | FieldSales' })), /\[i18n-year\] «2027»/);
  // ولو اختلف HTML عن الملف (dist قديم أو محرَّر): السنة الملصقة في dist نفسه تُلتقط
  assert.match(run(good.replace('Texto de la sección tax sin fechas.', 'Texto de la sección tax desde 2010.')).map((x) => x.msg).join('\n'), /\[i18n-year\] «2010»/);
  assert.match(run(good.replace('FieldSales no emite CFDI.', 'FieldSales emitirá CFDI desde 2027.')).map((x) => x.msg).join('\n'), /\[i18n-year-self\]/);
  // G6: FAQPage غائب · سؤال ظاهر زائد · ختم بتاريخ آخر · زرّ الاجتماع غائب · لا مصدر https · لا مثال فاتورة
  const noFaqLd = good.replace(/"@type":"FAQPage"/, '"@type":"Thing"');
  assert.ok(run(noFaqLd).some((x) => x.g === 'G6' && /FAQPage/.test(x.msg)));
  assert.ok(run(good.replace('<section data-country-faq>', '<section data-country-faq><h3>¿Extra?</h3><p>x</p>')).some((x) => x.g === 'G6' && /FAQPage/.test(x.msg)));
  assert.ok(run(good.replace('datetime="2026-11-11"', 'datetime="2026-01-01"')).some((x) => x.g === 'G6' && /ختم/.test(x.msg)));
  assert.ok(run(good.replace(/href="\/en\/meeting\/"/g, 'href="/es/"')).some((x) => x.g === 'G6' && /اجتماع/.test(x.msg)));
  assert.ok(run(good.replace(/(<section data-country-sources>[\s\S]*?)href="https:/, '$1href="http:')).some((x) => x.g === 'G6' && /https/.test(x.msg)));
  assert.ok(run(good.replace('data-country-sample-fields', 'data-x')).some((x) => x.g === 'G6' && /مثال/.test(x.msg)));
  // وصفحة دولة ليست في الفهرس
  assert.ok(countryPageDistProblems({ html: good, page, reg: BASE, country }).some((x) => x.g === 'G5' && /فهرس/.test(x.msg)));
});

test('فحص الربط (G2) على صفحات /es/ المصيَّرة: صفّ المكسيك وقوائم الصفحات تربطها، وكسر أيّها يُلتقط', () => {
  const cp = pageOf(REG, 'es', 'country:MX');
  const others = i18nPages(REG).filter((p) => p.code === 'es' && p.path !== cp.path)
    .map((p) => ({ path: p.path, pageKey: p.pageKey, html: docOf(renderI18nPage({ page: p, reg: REG, file: ES, world: WORLD, vatByCode: VAT })) }));
  assert.ok(others.some((o) => o.pageKey === 'countries'));
  assert.deepEqual(countryLinkProblems({ cp, others }), []);
  const broken = others.map((o) => (o.pageKey === 'countries' ? { ...o, html: o.html.replace(`data-country-link="MX"`, 'data-country-link="XX"') } : o));
  assert.ok(countryLinkProblems({ cp, others: broken }).some((x) => x.g === 'G2' && /صفّ MX/.test(x.msg)));
  const noNav = others.map((o) => (o.pageKey === 'home' ? { ...o, html: o.html.replace(`href="/es/${SLUG}/"`, 'href="/es/x/"') } : o));
  assert.ok(countryLinkProblems({ cp, others: noNav }).some((x) => x.g === 'G2' && /data-i18n-pages/.test(x.msg)));
});

test('G-assets: بصمات notes وreview وتدقيق الحقائق والدولة المستثناة تُلتقط في حزمة (ولو بهروب \\uXXXX)، ولا تُلتقط في حزمة سليمة', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'country-leak-'));
  try {
    const put = (rel: string, v: unknown) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), JSON.stringify(v)); };
    const notes = 'كُتب على الحقائق بعد التدقيق وتعذّر فتح موقع SAT فيُستحسن المطابقة قبل النشر';
    const issue = 'تجنّبت عمداً ذكر certificado del CSD وProveedor Autorizado de Certificación';
    put('src/content/country-pages/MX.json', { ...countryFile(), notes, review: { reviewedAt: '2026-11-11', quality: 'publish', issues: [issue] } });
    put('src/content/country-facts/MX.json', { code: 'MX', verifiedAt: '2026-11-11', audit: { corrections: [{ after: 'حُذف المثال غير الموثّق وأُحيلت تفاصيل الاستثناءات' }] } });
    const none = { pages: [], excluded: [{ cc: 'MX', code: 'es', reasons: ['x'] }] } as CountryPagesIndex;
    const fps = countryLeakFingerprints({ root: tmp, index: none, targets: { MX: 'es' } });
    const kinds = [...new Set(fps.map((f) => f.kind))].sort();
    assert.deepEqual(kinds, ['content.es (دولة غير منشورة)', 'facts.audit', 'notes', 'review']);
    const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const leaked = assetLeaks([
      { name: 'MX-a.js', text: `const e="MX",n=${JSON.stringify(notes)};` },
      { name: 'MX-b.js', text: `JSON.parse("${esc(JSON.stringify({ i: [issue] })).replace(/"/g, '\\"')}")` },
      { name: 'MX-c.js', text: `const h=${JSON.stringify(content().intro)};` },
      { name: 'clean.js', text: 'const notes="x",reviewedAt=1;' },
    ], fps);
    assert.deepEqual([...new Set(leaked.map((l) => `${l.name}:${l.kind}`))].sort(), ['MX-a.js:notes', 'MX-b.js:review', 'MX-c.js:content.es (دولة غير منشورة)']);
    // جملة تسويقية منشورة في es.json تكرّرها مقدمة الدولة ليست تسريباً (حزمة es.json العامة لا تُحجب) — كان إيجابياً كاذباً في البناء
    const marketingEs = { strings: { 'tierB.home.intro': `${content().intro} Y mucho más.` } };
    const esBundle = [{ name: 'es-x.js', text: `const s=${JSON.stringify(marketingEs)};` }];
    assert.ok(assetLeaks(esBundle, fps).length > 0, 'بلا ملف اللغة العام: البصمة تصيب حزمته');
    put('src/i18n/marketing/es.json', marketingEs);
    const fpsPublic = countryLeakFingerprints({ root: tmp, index: none, targets: { MX: 'es' } });
    assert.deepEqual(assetLeaks(esBundle, fpsPublic), [], 'النصّ العامّ لا يُتّخذ بصمة');
    assert.ok(fpsPublic.some((f) => f.kind === 'notes') && fpsPublic.some((f) => f.kind.startsWith('content.')), 'وبقية البصمات باقية');
    // منشورة: محتواها المجرّد مشروع في الحزمة (لا بصمة له)، والملاحظات تبقى محجوبة
    const pub = { pages: [ENTRY], excluded: [] } as CountryPagesIndex;
    const derived = deriveCountryContentFiles({ root: tmp, index: pub });
    assert.deepEqual([...derived.keys()], [countryContentRel('MX', 'es')]);
    for (const [rel, body] of derived) { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), body); }
    assert.deepEqual(countryContentFilesProblems({ root: tmp, index: pub }), []);
    const fps2 = countryLeakFingerprints({ root: tmp, index: pub, targets: { MX: 'es' } });
    assert.ok(!fps2.some((f) => f.kind.startsWith('content.')));
    assert.deepEqual(assetLeaks([{ name: 'MX.es.js', text: [...derived.values()][0] }], fps2), [], 'الملف المشتق نفسه بلا ملاحظات');
    // ملف مشتق زائد أو محرَّر يدوياً يُلتقط (G0)
    fs.writeFileSync(path.join(tmp, countryContentRel('CO', 'es')), '{}');
    fs.appendFileSync(path.join(tmp, countryContentRel('MX', 'es')), ' ');
    assert.equal(countryContentFilesProblems({ root: tmp, index: pub }).length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  // الملفات المشتقة المجرّدة = صفحات الفهرس المنشورة وحدها، مطابقةً لاشتقاقها من src/content
  assert.deepEqual(countryContentFilesProblems({ root, index }), []);
  for (const e of index.pages) {
    assert.equal(e.code, targets[e.cc], `${e.cc}: لغة السوق`);
    const file = readJson<CountryPageFile>(...countryContentRel(e.cc, e.code).split('/'));
    assert.deepEqual(Object.keys(file).sort(), ['basedOnFactsVerifiedAt', 'code', 'content'], `${e.cc}: الملف المشتق مجرّد`);
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
