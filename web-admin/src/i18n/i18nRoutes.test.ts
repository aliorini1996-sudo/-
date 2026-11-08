import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeSlug, checkLocaleCode, pagePath, i18nPages, clusterOf, clusterAlternates, newClusterMembers, legacyClusterKey,
  i18nPageForPath, uiLangFor, quoteHref, meetingHref, waRedirectHref, requiredKeys, canon, xDefaultOf,
  DEFAULT_CATEGORY_SLUG, BASE_PAGES, TIER_A_PAGES,
  type PublishedRegistry, type PublishedLocale, type PageKey,
} from './i18nRoutes.mjs';
import { certRuleFor, CERT_ALL, NO_CERT_RULE } from '../../scripts/claims-i18n.mjs';

/**
 * حرّاس وحدة المسارات والعناقيد (spec-b §٣) — العقد المشترك بين prerender والخرائط وReact.
 * أهمّها: ثبات عناقيد الصفحات القديمة حين لا تُنشر لغة جديدة (لا تتغيّر صفحة قائمة)، وتطابق الأنماط
 * المنسوخة مع مصادرها (رمز لغة لا يقع داخل مسار تطبيق ولا يفقد زرّ واتساب).
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};
const readJson = <T>(...p: string[]): T => JSON.parse(read(...p)) as T;

const loc = (code: string, over: Partial<PublishedLocale> = {}): PublishedLocale => ({
  code, hreflang: code, name: code, nativeName: code, dir: 'ltr', legacy: false, tier: 'B',
  ogLocale: `${code}_XX`, intlLocale: code, slug: DEFAULT_CATEGORY_SLUG, pages: [...BASE_PAGES],
  waLabel: 'WhatsApp', contentDate: '2026-11-08', ...over,
});
const LEGACY_EN = loc('en', { legacy: true, tier: 'A', pages: ['category', 'countries'], ogLocale: 'en_US' });
const regOf = (...locales: PublishedLocale[]): PublishedRegistry => ({ waveMax: 1, generatedAt: '2026-11-08', simulated: false, locales });

// نسخة حرفية من hreflangFor/trilingualHreflang في scripts/prerender.mjs (قبل الطبقة) — مرجع الثبات
const ORIGIN = 'https://fieldsa.net';
const HREFLANG_CODE: Record<string, string> = { zh: 'zh-Hans' };
const langUrl = (L: string, p: string) => canon(`${ORIGIN}${L === 'ar' ? '' : '/' + L}${p}`);
const xDefaultLegacy = (langs: string[]) => (langs.includes('en') ? 'en' : langs.includes('ar') ? 'ar' : langs[0]);
const legacyCluster = (p: string, langs: string[]) => [
  ...langs.map((L) => ({ hreflang: HREFLANG_CODE[L] || L, href: langUrl(L, p) })),
  { hreflang: 'x-default', href: langUrl(xDefaultLegacy(langs), p) },
];

test('normalizeSlug: التطبيع والسقوط إلى الافتراضي', () => {
  assert.equal(normalizeSlug('logiciel-vente-en-tournée'), 'logiciel-vente-en-tournee');
  assert.equal(normalizeSlug('نرم-افزار-پخش-گرم'), DEFAULT_CATEGORY_SLUG, 'slug الفارسية بلا حرف لاتيني');
  assert.equal(normalizeSlug('Software  Preventa__Autoventa!'), 'software-preventa-autoventa');
  assert.equal(normalizeSlug('Łódź-sprzedaż'), 'odz-sprzedaz', 'Ł لا تتفكّك بـNFKD فتُحذف، والعلامات تسقط');
  assert.equal(normalizeSlug('ab'), DEFAULT_CATEGORY_SLUG, 'أقصر من 3');
  assert.equal(normalizeSlug('123-456'), DEFAULT_CATEGORY_SLUG, 'بلا حرف لاتيني');
  assert.equal(normalizeSlug('countries'), DEFAULT_CATEGORY_SLUG, 'مقطع محجوز داخل اللغة');
  assert.equal(normalizeSlug('Subscribe Request'), DEFAULT_CATEGORY_SLUG, 'يصادم /subscribe-request/');
  assert.equal(normalizeSlug(undefined), DEFAULT_CATEGORY_SLUG);
  const long = normalizeSlug('a'.repeat(59) + '-bbbb');
  assert.ok(long.length <= 60 && !long.endsWith('-'), 'القصر على 60 بلا شرطة طرفية');
});

test('checkLocaleCode: يرفض المقاطع المحجوزة ومسارات التطبيق ويقبل رموز اللغات', () => {
  for (const c of ['m', 'c', 'app', 'pay', 'meeting', 'blog', 'rep', 'pos', 'kds', 'hx', 'ax', 'e', 'og', 'Es', 'es_MX', '']) {
    assert.ok(checkLocaleCode(c), `الرمز «${c}» يجب أن يُرفض`);
  }
  for (const c of ['es', 'zh-hant', 'no', 'pcm', 'en', 'fr', 'tr', 'zh']) {
    assert.equal(checkLocaleCode(c), null, `الرمز «${c}» يجب أن يُقبل`);
  }
  assert.ok(checkLocaleCode('xy', ['xy']), 'extraReserved');
});

test('الأنماط المنسوخة في i18nRoutes.mjs مطابقة نصياً لمصادرها', () => {
  const mine = read('src', 'i18n', 'i18nRoutes.mjs');
  const copy = (name: string) => {
    const m = mine.match(new RegExp(`const ${name} = (\\/.+\\/);`));
    assert.ok(m, `النسخة ${name} غائبة عن i18nRoutes.mjs`);
    return m[1];
  };
  // isAppRoute في lang.ts: البديلان بالترتيب
  const lang = read('src', 'i18n', 'lang.ts');
  const app = lang.match(/return (\/\^\\\/\(app[^\n]*?\/)\.test\(p\) \|\| (\/\^\\\/\(m[^\n]*?\/)\.test\(p\);/);
  assert.ok(app, 'isAppRoute في lang.ts لم يعد بالصيغة المتوقعة — حدّث النسخة في i18nRoutes.mjs والاختبار');
  assert.equal(copy('APP_ROUTE_A'), app[1], 'APP_ROUTE_A ≠ isAppRoute (البديل الأول)');
  assert.equal(copy('APP_ROUTE_B'), app[2], 'APP_ROUTE_B ≠ isAppRoute (البديل الثاني)');
  // HIDDEN_ON في WhatsAppFab.tsx
  const fab = read('src', 'components', 'WhatsAppFab.tsx').match(/const HIDDEN_ON = (\/.+\/);/);
  assert.ok(fab, 'HIDDEN_ON غائب عن WhatsAppFab.tsx');
  assert.equal(copy('WA_HIDDEN_ON'), fab[1], 'WA_HIDDEN_ON ≠ HIDDEN_ON');
  // استثناءات VisitTracker في App.tsx
  const vt = read('src', 'App.tsx').match(/function VisitTracker\(\)[\s\S]*?if \((\/\^[^\n]*?\/)\.test\(pathname\)\) return;/);
  assert.ok(vt, 'نمط VisitTracker غائب عن App.tsx');
  assert.equal(copy('VISIT_TRACKER_SKIP'), vt[1], 'VISIT_TRACKER_SKIP ≠ VisitTracker');
});

test('pagePath وclusterOf', () => {
  assert.equal(pagePath('es', 'home', 'x'), '/es/');
  assert.equal(pagePath('es', 'category', 'software-preventa-autoventa'), '/es/software-preventa-autoventa/');
  assert.equal(pagePath('es', 'feature:vanStock', 'x'), '/es/features/van-stock/');
  assert.equal(pagePath('de', 'languages', 'x'), '/languages/');
  assert.equal(clusterOf('home'), 'home');
  assert.equal(clusterOf('feature:offlineInvoicing'), 'tierA:feature:offlineInvoicing');
  assert.equal(clusterOf('languages'), null);
});

test('i18nPages بلا تكرار ومعها /languages/ — على السجل المنشور الملتزم وعلى سجل مُحاكى', () => {
  const published = readJson<PublishedRegistry>('src', 'i18n', 'registry', 'published.json');
  for (const reg of [published, regOf(LEGACY_EN, loc('es', { tier: 'A', pages: [...BASE_PAGES, ...TIER_A_PAGES] }), loc('ur', { dir: 'rtl' }))]) {
    const pages = i18nPages(reg);
    const paths = pages.map((p) => p.path);
    assert.equal(new Set(paths).size, paths.length, 'مسار مكرّر');
    assert.ok(paths.includes('/languages/'), '/languages/ غائبة');
    for (const p of paths) assert.match(p, /^\/[a-z0-9-]+\/(?:[a-z0-9-]+\/)*$/, `مسار غير ASCII أو بلا شرطة: ${p}`);
    assert.ok(!paths.some((p) => p.startsWith('/ar/')), 'لا صفحات عربية جديدة');
  }
  assert.throws(() => i18nPages(regOf(loc('es'), loc('es'))), /مكرّر/);
});

test('ثبات العناقيد القديمة: بلا لغة جديدة منشورة تطابق hreflangFor اليوم حرفياً', () => {
  const legacyOnly = regOf(LEGACY_EN,
    loc('fr', { legacy: true, tier: 'A', pages: ['category', 'countries'] }),
    loc('tr', { legacy: true, tier: 'A', pages: ['category', 'countries'] }),
    loc('zh', { legacy: true, tier: 'A', hreflang: 'zh-Hans', pages: ['category', 'countries'] }));
  assert.deepEqual(clusterAlternates('home', legacyOnly), legacyCluster('/', ['ar', 'en', 'fr', 'tr', 'zh']));
  assert.deepEqual(clusterAlternates('about', legacyOnly), legacyCluster('/about', ['ar', 'en', 'fr']));
  assert.deepEqual(clusterAlternates('contact', legacyOnly), legacyCluster('/contact', ['ar', 'en', 'fr']));
  for (const k of ['home', 'about', 'contact'] as const) assert.deepEqual(newClusterMembers(k, legacyOnly), []);
  // الفئة: en وحدها ⇒ عضو واحد ⇒ لا عنقود
  assert.deepEqual(clusterAlternates('category', regOf(LEGACY_EN)), []);
});

test('لغة جديدة: تدخل العناقيد بعد القدامى، وx-default يبقى الإنجليزية', () => {
  const reg = regOf(LEGACY_EN, loc('es', { slug: 'software-preventa-autoventa' }));
  const home = clusterAlternates('home', reg);
  assert.deepEqual(home.slice(0, 5).map((a) => a.hreflang), ['ar', 'en', 'fr', 'tr', 'zh-Hans']);
  assert.deepEqual(home[5], { hreflang: 'es', href: 'https://fieldsa.net/es/' });
  assert.deepEqual(home[6], { hreflang: 'x-default', href: 'https://fieldsa.net/en/' });
  assert.deepEqual(newClusterMembers('home', reg), [{ hreflang: 'es', href: 'https://fieldsa.net/es/' }]);
  const cat = clusterAlternates('category', reg);
  assert.deepEqual(cat, [
    { hreflang: 'en', href: 'https://fieldsa.net/en/van-sales-software/' },
    { hreflang: 'es', href: 'https://fieldsa.net/es/software-preventa-autoventa/' },
    { hreflang: 'x-default', href: 'https://fieldsa.net/en/van-sales-software/' },
  ]);
});

test('x-default لعنقود الطبقة A هو أول عضو بترتيب السجل', () => {
  const A = [...BASE_PAGES, ...TIER_A_PAGES] as PageKey[];
  const reg = regOf(LEGACY_EN, loc('es', { tier: 'A', pages: A }), loc('de', { tier: 'A', pages: A }));
  for (const key of TIER_A_PAGES) {
    const c = clusterAlternates(`tierA:${key}`, reg);
    assert.equal(c.length, 3, `tierA:${key}`);
    assert.equal(c[2].hreflang, 'x-default');
    assert.equal(c[2].href, c[0].href, 'x-default = أول عضو (es)');
    assert.equal(c[0].hreflang, 'es');
  }
  assert.equal(xDefaultOf([{ hreflang: 'de', href: 'd' }, { hreflang: 'ar', href: 'a' }], ['en', 'ar'])?.href, 'a');
  assert.equal(xDefaultOf([], ['en']), undefined);
});

test('legacyClusterKey وi18nPageForPath وuiLangFor', () => {
  assert.equal(legacyClusterKey('/'), 'home');
  assert.equal(legacyClusterKey('/about/'), 'about');
  assert.equal(legacyClusterKey('/contact'), 'contact');
  assert.equal(legacyClusterKey('/meeting'), null, '/meeting لا يتمدّد');
  const reg = regOf(LEGACY_EN, loc('es'), loc('zh-hant', { hreflang: 'zh-Hant' }));
  assert.equal(i18nPageForPath('/es', reg)?.pageKey, 'home');
  assert.equal(i18nPageForPath('/es/about', reg)?.pageKey, 'about');
  assert.equal(i18nPageForPath('/zh-hant/countries/', reg)?.hreflang, 'zh-Hant');
  assert.equal(i18nPageForPath('/languages', reg)?.pageKey, 'languages');
  assert.equal(i18nPageForPath('/en/', reg), null, 'رئيسية en القديمة ليست من الطبقة');
  assert.equal(i18nPageForPath('/%D9%85%D8%B2%D8%A7%D9%8A%D8%A7/', reg), null);
  assert.equal(uiLangFor('es'), 'en');
  assert.equal(uiLangFor('fr'), 'fr');
  assert.equal(uiLangFor('zh-hant'), 'en');
});

test('روابط الأزرار: النماذج القديمة وحدها (الخادم يقبل لغاته الخمس)', () => {
  assert.equal(quoteHref('fr'), '/fr/subscribe-request/?type=quote');
  assert.equal(quoteHref('es'), '/en/subscribe-request/?type=quote');
  assert.equal(meetingHref('tr'), '/tr/meeting/');
  assert.equal(meetingHref('zh'), '/zh/meeting/');
  assert.equal(meetingHref('de'), '/en/meeting/');
  const page = i18nPages(regOf(LEGACY_EN, loc('es')))[2]; // /es/
  assert.equal(page.path, '/es/');
  const href = waRedirectHref(page);
  assert.ok(href.startsWith('https://api.fieldsa.net/api/analytics/go/wa?'), href);
  const q = new URL(href).searchParams;
  assert.equal(q.get('ref'), 'es');
  assert.equal(q.get('p'), '/es/');
  assert.equal(q.get('l'), 'es');
  assert.equal(new URL(waRedirectHref({ ...page, path: '/es/features/van-stock/' })).searchParams.get('ref'), 'es-features-van-stock');
});

test('requiredKeys يغطي كل مفاتيح المحتوى الإنجليزي مرة على الأقل', () => {
  const en = readJson<{ strings: Record<string, string> }>('src', 'i18n', 'marketing', 'en.json');
  const keys = Object.keys(en.strings);
  assert.equal(keys.length, 145, 'المصدر الإنجليزي 145 مفتاحاً (85 للطبقة B و60 للطبقة A)');
  const covered = new Set<string>();
  for (const pk of [...BASE_PAGES, ...TIER_A_PAGES]) for (const k of requiredKeys(pk, keys)) covered.add(k);
  assert.deepEqual(keys.filter((k) => !covered.has(k)), []);
  for (const pk of [...BASE_PAGES, ...TIER_A_PAGES]) {
    const r = requiredKeys(pk, keys);
    assert.ok(r.includes('tierB.home.uiLanguagesNote') && r.includes('tierB.home.cta.whatsapp'), `${pk}: المفاتيح المشتركة`);
    assert.equal(new Set(r).size, r.length, `${pk}: مفتاح مكرّر`);
  }
  assert.deepEqual(requiredKeys('languages', keys), []);
});

test('canon نسخة من prerender: شرطة أخيرة إلا للملفات', () => {
  assert.equal(canon('https://fieldsa.net/es'), 'https://fieldsa.net/es/');
  assert.equal(canon('https://fieldsa.net'), 'https://fieldsa.net/');
  assert.equal(canon('https://fieldsa.net/es/llms.txt'), 'https://fieldsa.net/es/llms.txt');
  assert.equal(canon('https://fieldsa.net/x?y=1'), 'https://fieldsa.net/x/?y=1');
});

test('السجل الملتزم: المنشور مطابق للسجل، ولا عربية، ولا محاكاة، و249 دولة', () => {
  const reg = readJson<{ meta: { simulated: boolean; worldCountries: number }; locales: { code: string; wave: number; published: boolean }[] }>('src', 'i18n', 'registry', 'locales.json');
  const pub = readJson<PublishedRegistry>('src', 'i18n', 'registry', 'published.json');
  const world = readJson<{ countries: unknown[] }>('src', 'i18n', 'world-countries.json');
  assert.equal(world.countries.length, 249);
  assert.equal(reg.meta.worldCountries, 249);
  assert.equal(reg.locales.length, 153, 'كل لغات المصنع');
  assert.deepEqual(pub.locales.map((l) => l.code), reg.locales.filter((l) => l.published).map((l) => l.code));
  assert.ok(!pub.locales.some((l) => l.code === 'ar'), 'لا عربية في الطبقة');
  assert.ok(pub.locales.some((l) => l.code === 'en'), 'الإنجليزية منشورة دائماً');
  assert.equal(pub.simulated, false, 'محتوى مُحاكى ملتزم — أعِد المستورد بلا --simulate');
  assert.equal(reg.meta.simulated, false);
  for (const l of pub.locales) {
    assert.equal(checkLocaleCode(l.code), null, l.code);
    assert.ok(fs.existsSync(path.join(root, 'src', 'i18n', 'marketing', `${l.code}.json`)), `marketing/${l.code}.json`);
  }
  assert.ok(!fs.existsSync(path.join(root, 'src', 'i18n', 'marketing', 'ar.json')), 'لا ar.json');
});

test('claims-i18n: لكل لغة في الموجة 1 قاعدة اعتماد غير فارغة', () => {
  const reg = readJson<{ locales: { code: string; wave: number }[] }>('src', 'i18n', 'registry', 'locales.json');
  const wave1 = reg.locales.filter((l) => l.wave === 1 && l.code !== 'ar' && l.code !== 'en').map((l) => l.code);
  assert.ok(wave1.length >= 40, `الموجة 1: ${wave1.length}`);
  const missing = wave1.filter((c) => !certRuleFor(c));
  assert.deepEqual(missing, [], `لغات في الموجة 1 بلا قاعدة اعتماد: ${missing.join(' ')}`);
  for (const c of NO_CERT_RULE) assert.ok(!wave1.includes(c), `${c} بلا قاعدة وهي في الموجة 1`);
  assert.ok(CERT_ALL.test('ZATCA certified'), 'القاعدة الشاملة');
  assert.ok(certRuleFor('es')?.test('certificado por ZATCA'));
  assert.ok(certRuleFor('fa')?.test('تأیید‌شده'), 'الفارسية بنصف مسافة (ZWNJ)');
  assert.ok(certRuleFor('sr')?.test('сертификован') && certRuleFor('sr')?.test('сертифицирован'), 'sr في مجموعتين');
});
