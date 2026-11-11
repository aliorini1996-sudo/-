/**
 * حارس الطبقة متعددة اللغات (spec-b §١١) — آخر خطوة في postbuild.
 *
 * يفحص ما يخرج فعلاً (dist والخرائط وrobots) مقابل السجل الملتزم (src/i18n/registry) وملفات المحتوى
 * (src/i18n/marketing)، فلا تُنشر صفحة بلغة جديدة ناقصة أو بلغة غير لغتها أو بادّعاء ممنوع أو بلا تبادل
 * hreflang أو خارج الخريطة، ولا يُلتزم محتوى مُحاكى بالخطأ.
 *
 * الفحوص (كلها تُفشل البناء إلا ما وُصف تحذيراً):
 *   G0 السجل · G-codes تصادم الرموز · G1 الاكتمال · G2 المسارات = المُصيَّر = الخريطة ·
 *   G3 hreflang متبادل وcanonical ذاتي · G4 لغة النص · G5 الادّعاءات والأسعار · G6 الصدق · G7 robots · G9 أحجام الخرائط ·
 *   G-assets حزم المتصفح بلا محتوى غير منشور
 *
 * صفحات الدول (نوع «country:<CC>»، فهرسها src/i18n/registry/country-pages.json، ونسخها الحرفية src/content/country-pages،
 * وما يُصيَّر ويصل إلى المتصفح منها ملفاتها المشتقة المجرّدة src/i18n/registry/country-content/<CC>.<code>.json)
 * داخلةٌ في كل فحص: G0 يعيد اشتقاق الفهرس والملفات المجرّدة (scripts/country-i18n.mjs) ويقارن · G-codes slug لا يصادم ·
 * G1 الشكل · G2 مُصيَّرة وفي خريطة لغتها ومربوطة من صفّها في جدول /<lang>/countries/ ومن قائمة صفحات لغتها · G3 canonical
 * ذاتي وhreflang ذاتي + x-default ذاتي · G5 السنة أو التاريخ محجوب في كل جملة عن FieldSales نفسها في الصفحة كلها
 * ومسموح في جمل حقائق الدولة وعناوين المصادر (وH1 بلا سنة، وختم «آخر تحقق» بسنة التحقق وحدها)، ورقم+عملة وادّعاء
 * الربط الحكومي حاجبان في كل الصفحة · G6 أسئلة FAQPage = الظاهرة، والأقسام الخمسة، والأزرار، وختم التحقق = تاريخ
 * الحقائق · G-assets لا notes ولا review ولا تدقيق حقائق ولا محتوى دولة مستثناة في
 * dist/assets. منطق فحوص dist لصفحة الدولة في country-i18n.mjs (countryPageDistProblems · countryLinkProblems) ويختبره
 * countryPages.test.ts على HTML مصيَّر من المثبّت.
 *
 * التشغيل: node scripts/verify-i18n.mjs [--dist dist] [--verbose]
 *   I18N_WARN=1             مؤقت: يطبع ولا يُفشل
 *   I18N_ALLOW_SIMULATED=1  محلياً فقط مع import-i18n --simulate
 *
 * المرجع الإنجليزي هو marketing/en.json (مصنع المحتوى غير متاح في البناء). القواعد المشتركة مع المستورد:
 * scripts/claims-i18n.mjs؛ والقواعد العامة: scripts/claims-rules.mjs (كما يطبّقها verify-claims).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { transformSync } from 'esbuild';
import {
  ORIGIN, LEGACY, i18nPages, clusterAlternates, checkLocaleCode, normalizeSlug, requiredKeys, canon,
  withCountryPages, isCountryPageKey, countryOfPageKey, countrySlug,
} from '../src/i18n/i18nRoutes.mjs';
import {
  findI18nViolations, checkMarketingStrings, scriptProblems, contentHashOf, publishedEntry, certRuleFor, NO_CERT_RULE,
  livePriceRe, toAsciiDigits, I18N_RULE_WHY, englishCopies,
} from './claims-i18n.mjs';
import {
  deriveCountryIndex, countryShapeProblems, countryContentRel, countryContentFilesProblems, countryLeakFingerprints, assetLeaks,
  countryPageDistProblems, countryLinkProblems, COUNTRY_INDEX_FILE, COUNTRY_PAGES_DIR,
} from './country-i18n.mjs';
import { RULES, findViolation } from './claims-rules.mjs';
import {
  decode, headOf, tagsOf, metaContent, titleOf, canonicalOf, alternatesOf, htmlAttrs, mainOf, removeElements, stripTags, ldBlocks,
  RE_LANGS_NAV, RE_COUNTRIES, RE_LINKS,
} from './html-scan.mjs';
import { loadPricing } from './pricing-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const distArg = argv.indexOf('--dist') >= 0 ? argv[argv.indexOf('--dist') + 1] : null;
const DIST = path.resolve(distArg || path.join(ROOT, 'dist'));
const VERBOSE = argv.includes('--verbose');
const WARN_ONLY = process.env.I18N_WARN === '1';
const ALLOW_SIM = process.env.I18N_ALLOW_SIMULATED === '1';

const REG_DIR = path.join(ROOT, 'src/i18n/registry');
const MKT_DIR = path.join(ROOT, 'src/i18n/marketing');
const PUBLIC = path.join(ROOT, 'public');
const WORLD_COUNT = 249;
const MAX_URLS = 50000;
const MAX_BYTES = 50 * 1024 * 1024;
/** أسماء robots الإلزامية (G7) */
const ROBOTS_REQUIRED = [
  'meta-webindexer', 'MistralAI-Index', 'MistralAI-User', 'OAI-SearchBot', 'ChatGPT-User', 'GPTBot',
  'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended',
  'Bytespider', 'Baiduspider', 'YandexBot', 'PetalBot', 'Amazonbot', 'DuckAssistBot', 'cohere-ai', 'YouBot',
];

// ─── التقرير ────────────────────────────────────────────────────────────────────────────
const CHECKS = ['G0', 'G-codes', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G9', 'G-assets'];
const TITLES = {
  G0: 'السجل', 'G-codes': 'تصادم الرموز', G1: 'الاكتمال', G2: 'المسارات = المُصيَّر = الخريطة',
  G3: 'hreflang متبادل وcanonical ذاتي', G4: 'لغة النص', G5: 'الادّعاءات والأسعار', G6: 'الصدق', G7: 'robots', G9: 'أحجام الخرائط',
  'G-assets': 'حزم المتصفح بلا محتوى غير منشور',
};
const report = Object.fromEntries(CHECKS.map((c) => [c, { errors: [], warnings: [] }]));
const err = (g, m) => report[g].errors.push(m);
const warn = (g, m) => report[g].warnings.push(m);

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = (f) => fs.existsSync(f);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

// ─── أدوات HTML (scripts/html-scan.mjs — مشتركة مع فحوص dist لصفحات الدول واختباراتها) ─────────────────
/** النص كما يفحصه verify-claims (المرئي + JSON-LD + أوصاف meta) — لقواعد claims-rules */
const claimsText = (h) => {
  const ld = ldBlocks(h).map((s) => s.replace(/["{}[\],]/g, ' ')).join(' ');
  const metas = tagsOf(h, 'meta').filter((a) => /^(?:description|og:description|twitter:description|og:title|twitter:title)$/i.test(a.name || a.property || ''))
    .map((a) => a.content || '').join(' . ');
  return `${stripTags(h)} . ${ld} . ${metas}`.replace(/\s+/g, ' ');
};
const fileForPath = (p) => {
  let d = String(p);
  try { d = decodeURIComponent(d); } catch { /* يبقى */ }
  return path.join(DIST, ...d.split('/').filter(Boolean), 'index.html');
};
const pathOfHref = (href) => String(href).replace(ORIGIN, '') || '/';

// ─── المدخلات ───────────────────────────────────────────────────────────────────────────
const need = [path.join(REG_DIR, 'published.json'), path.join(REG_DIR, 'locales.json'), path.join(ROOT, 'src/i18n/world-countries.json')];
const missingInputs = need.filter((f) => !exists(f));
if (missingInputs.length) {
  console.error(`✗ verify-i18n: مدخلات غائبة: ${missingInputs.map(rel).join('، ')} — شغّل npm run i18n:countries ثم npm run i18n:import`);
  process.exit(WARN_ONLY ? 0 : 1);
}
const published = readJson(path.join(REG_DIR, 'published.json'));
const registry = readJson(path.join(REG_DIR, 'locales.json'));
// فهرس صفحات الدول: غيابه = لا صفحات دول (خطأ G0 إن وُجد محتوى دولة صالح يُنشر)
const countryIndex = exists(path.join(ROOT, COUNTRY_INDEX_FILE)) ? readJson(path.join(ROOT, COUNTRY_INDEX_FILE)) : { pages: [], excluded: [] };
/** السجل المنشور ومعه صفحات الدول — مصدر الصفحات والعناقيد (published وحده لمقارنة اللغات في G0) */
const REG = withCountryPages(published, countryIndex);
/** الملف المشتق المجرّد لصفحة دولة منشورة (src/i18n/registry/country-content/<CC>.<code>.json) — ما صُيِّرت منه */
const countryFiles = new Map();
const countryFileOf = (cc, code) => {
  const key = `${cc}.${code}`;
  if (!countryFiles.has(key)) {
    const fp = path.join(ROOT, countryContentRel(cc, code));
    countryFiles.set(key, exists(fp) ? readJson(fp) : null);
  }
  return countryFiles.get(key);
};
const world = readJson(path.join(ROOT, 'src/i18n/world-countries.json'));
const regByCode = new Map(registry.locales.map((l) => [l.code, l]));
const pubCodes = published.locales.map((l) => l.code);
const pubSet = new Set(pubCodes);
const files = new Map();
for (const f of exists(MKT_DIR) ? fs.readdirSync(MKT_DIR).filter((x) => x.endsWith('.json')) : []) {
  try { files.set(f.slice(0, -5), readJson(path.join(MKT_DIR, f))); } catch (e) { err('G0', `marketing/${f} ليس JSON صالحاً: ${e.message}`); }
}
const enFile = files.get('en');
const EN_KEYS = enFile ? Object.keys(enFile.strings) : [];

let pages = [];
try { pages = i18nPages(REG); } catch (e) { err('G2', `i18nPages: ${e.message}`); }
const E = pages.map((p) => p.path);
const ESet = new Set(E);
const distOk = exists(DIST);
if (!distOk) err('G2', `لا يوجد ${DIST} — الحارس يعمل بعد البناء (postbuild)`);

const pricing = await loadPricing();
const LIVE_PRICES = pricing.plans.map((p) => String(p.price)).filter((p) => /^\d+$/.test(p));

let COUNTRIES_REG = {};
try {
  const src = fs.readFileSync(path.join(ROOT, 'src/i18n/countries.ts'), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  const tmp = path.join(os.tmpdir(), `_verify_i18n_countries_${process.pid}.mjs`);
  fs.writeFileSync(tmp, code);
  try { COUNTRIES_REG = (await import(pathToFileURL(tmp).href)).COUNTRIES || {}; } finally { fs.unlinkSync(tmp); }
} catch (e) {
  warn('G6', `تعذّر تحميل countries.ts (${e.message}) — لا فحص لخانات الضريبة`);
}
// خريطة عمود الضريبة كما يرسمها القالب نفسه (سجل الدول + تصحيحات الصفحة) — فحص الخانات بها وحدها
const { vatMapFrom } = await import('../src/i18n/marketingTemplate.mjs');
const PAGE_VAT = Object.keys(COUNTRIES_REG).length ? vatMapFrom(COUNTRIES_REG) : null;

// ─── G0: السجل ──────────────────────────────────────────────────────────────────────────
{
  const derived = registry.locales.filter((l) => l.published)
    .map((l) => publishedEntry(l, files.get(l.code)?.strings?.['tierB.home.cta.whatsapp']));
  const actual = published.locales.map((l) => publishedEntry(l, l.waLabel));
  if (JSON.stringify(derived) !== JSON.stringify(actual)) {
    const a = derived.map((x) => x.code).join(','); const b = actual.map((x) => x.code).join(',');
    err('G0', a === b
      ? 'published.json لا يطابق ما يُشتق من locales.json (حقل مختلف أو waLabel لا يطابق ملف المحتوى) — أعِد المستورد ولا تحرّر يدوياً'
      : `المنشورة في published.json [${b}] ≠ المنشورة في locales.json [${a}]`);
  }
  if (published.waveMax !== registry.meta?.waveMax) err('G0', `waveMax في published.json (${published.waveMax}) ≠ locales.json (${registry.meta?.waveMax})`);
  for (const code of pubCodes) if (!files.has(code)) err('G0', `لا ملف marketing/${code}.json للغة منشورة`);
  for (const code of files.keys()) if (!pubSet.has(code)) err('G0', `marketing/${code}.json موجود ولغته غير منشورة — أعِد المستورد`);
  if (pubSet.has('ar') || regByCode.get('ar')?.published) err('G0', 'العربية منشورة في الطبقة — لا صفحات عربية جديدة (تكرّر صفحات مفهرسة)');
  if (files.has('ar')) err('G0', 'marketing/ar.json موجود — لا يُكتب أبداً');
  if (distOk && exists(path.join(DIST, 'ar'))) err('G0', 'dist/ar/ موجود — لا صفحات عربية تحت /ar/');
  const sims = [
    published.simulated && 'published.json', registry.meta?.simulated && 'locales.json',
    ...[...files].filter(([, f]) => f?._meta?.simulated).map(([c]) => `marketing/${c}.json`),
  ].filter(Boolean);
  if (sims.length) {
    if (ALLOW_SIM) warn('G0', `محتوى مُحاكى (مسموح محلياً بـI18N_ALLOW_SIMULATED=1): ${sims.join('، ')} — لا يُلتزم`);
    else err('G0', `محتوى مُحاكى: ${sims.join('، ')} — أعِد المستورد بلا --simulate (أو I18N_ALLOW_SIMULATED=1 محلياً وحده)`);
  }
  if (!(registry.meta?.worldCountries === world.countries.length && world.countries.length === WORLD_COUNT)) {
    err('G0', `عدد الدول: meta.worldCountries=${registry.meta?.worldCountries} وworld-countries.json=${world.countries.length} والمتوقع ${WORLD_COUNT}`);
  }
  if (!enFile || !pubSet.has('en')) err('G0', 'الإنجليزية غير منشورة أو بلا marketing/en.json — مرجع الحارس ومصدر /languages/');

  // صفحات الدول: الفهرس الملتزم = ما يُشتق من نسخ المستودع (الحقائق المدقّقة والمحتوى المراجَع وقواعد الحارس نفسها)
  if (!exists(path.join(ROOT, COUNTRY_INDEX_FILE))) err('G0', `${COUNTRY_INDEX_FILE} غائب — شغّل scripts/import-country-i18n.mjs`);
  const derivedCountries = deriveCountryIndex({ root: ROOT, published, registry, livePrices: LIVE_PRICES });
  const strip = (x) => JSON.stringify({ pages: x.pages || [], excluded: (x.excluded || []).map((e) => ({ cc: e.cc, code: e.code })) });
  if (strip(derivedCountries) !== strip(countryIndex)) {
    const a = (derivedCountries.pages || []).map((p) => `${p.cc}:${p.code}/${p.slug}`).join(',') || '—';
    const b = (countryIndex.pages || []).map((p) => `${p.cc}:${p.code}/${p.slug}`).join(',') || '—';
    err('G0', `${COUNTRY_INDEX_FILE} لا يطابق ما يُشتق من src/content (المشتق [${a}] · الملتزم [${b}]) — أعِد scripts/import-country-i18n.mjs ولا تحرّر يدوياً`);
  }
  for (const x of derivedCountries.excluded) warn('G0', `صفحة الدولة ${x.cc} (${x.code}) مستثناة: ${x.reasons.slice(0, 3).join(' | ')}${x.reasons.length > 3 ? ` | …(+${x.reasons.length - 3})` : ''}`);
  for (const e of countryIndex.pages || []) {
    if (!exists(path.join(ROOT, COUNTRY_PAGES_DIR, `${e.cc}.json`))) err('G0', `صفحة الدولة ${e.cc} في الفهرس بلا ${COUNTRY_PAGES_DIR}/${e.cc}.json`);
    if (!countryFileOf(e.cc, e.code)) err('G0', `صفحة الدولة ${e.cc} في الفهرس بلا ملفها المشتق ${countryContentRel(e.cc, e.code)}`);
    if (!pubSet.has(e.code)) err('G0', `صفحة الدولة ${e.cc} بلغة غير منشورة ${e.code}`);
  }
  // الملفات المشتقة المجرّدة (ما تحمله حزمة المتصفح): واحد لكل صفحة منشورة = اشتقاقه من src/content، ولا زائد
  for (const p of countryContentFilesProblems({ root: ROOT, index: derivedCountries })) {
    err('G0', `${p} — أعِد scripts/import-country-i18n.mjs ولا تحرّر يدوياً`);
  }
}

// ─── G-codes: تصادم الرموز ─────────────────────────────────────────────────────────────
{
  for (const l of published.locales) {
    const issue = checkLocaleCode(l.code);
    if (issue) err('G-codes', issue);
    if (l.slug !== normalizeSlug(l.slug)) err('G-codes', `slug ${l.code} «${l.slug}» لا يساوي تطبيعه — مقطع محجوز داخل اللغة أو صيغة غير صالحة`);
  }
  for (const e of countryIndex.pages || []) {
    if (countrySlug(e.slug) !== e.slug) err('G-codes', `slug صفحة الدولة ${e.cc} «${e.slug}» لا يساوي تطبيعه (محجوز أو غير صالح)`);
    const loc = published.locales.find((l) => l.code === e.code);
    if (loc && e.slug === loc.slug) err('G-codes', `slug صفحة الدولة ${e.cc} يساوي slug فئة اللغة ${e.code}`);
  }
  const appSrc = exists(path.join(ROOT, 'src/App.tsx')) ? fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8') : '';
  const appSegs = new Set([...appSrc.matchAll(/path="\/([^/"?#]+)/g)].map((m) => m[1]));
  const publicNames = new Set(exists(PUBLIC) ? fs.readdirSync(PUBLIC) : []);
  const distDirs = new Set(distOk ? fs.readdirSync(DIST, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => !pubSet.has(n)) : []);
  const legacyOk = (c) => c !== 'ar' && LEGACY.includes(c);
  for (const l of registry.locales) {
    if (legacyOk(l.code)) continue;
    const where = [appSegs.has(l.code) && 'App.tsx', publicNames.has(l.code) && 'public/', distDirs.has(l.code) && 'dist/'].filter(Boolean);
    if (!where.length) continue;
    if (pubSet.has(l.code)) err('G-codes', `الرمز ${l.code} يصادم مساراً قائماً في ${where.join(' و')}`);
    else warn('G-codes', `الرمز ${l.code} (غير منشور) سيصادم ${where.join(' و')} عند نشره`);
  }
}

// ─── G1: الاكتمال ───────────────────────────────────────────────────────────────────────
const worldCodes = world.countries.map((r) => r.code);
for (const l of published.locales) {
  const f = files.get(l.code);
  if (!f) continue;
  const S = f.strings || {};
  for (const pageKey of l.pages) {
    for (const k of requiredKeys(pageKey, EN_KEYS)) {
      if (typeof S[k] !== 'string' || !S[k].trim()) err('G1', `${l.code}/${pageKey}: المفتاح ${k} غائب أو فارغ`);
    }
  }
  const copies = new Set(l.code !== 'en' && enFile ? englishCopies(l.code, S, enFile.strings) : []);
  for (const [k, v] of Object.entries(S)) {
    if (/\{[A-Za-z0-9_]+\}/.test(v)) err('G1', `${l.code}: عنصر نائب متبقٍّ في ${k}`);
    if (/[<>]/.test(v)) err('G1', `${l.code}: وسم HTML في ${k}`);
    if (copies.has(k)) err('G1', `${l.code}: ${k} يساوي الإنجليزية حرفياً`);
  }
  if (f._meta?.contentHash !== contentHashOf(S)) warn('G1', `${l.code}: _meta.contentHash لا يطابق strings — تعديل يدوي؟ أعِد المستورد`);
  const d = f._derived || {};
  const order = d.countryOrder || [];
  if (order.length !== WORLD_COUNT || new Set(order).size !== order.length || order.some((c) => !worldCodes.includes(c))) {
    err('G1', `${l.code}: _derived.countryOrder لا يحوي رموز الدول الـ${WORLD_COUNT} بلا تكرار (${order.length})`);
  }
  const missingNames = worldCodes.filter((c) => !d.countryNames?.[c]);
  if (missingNames.length) err('G1', `${l.code}: أسماء دول غائبة: ${missingNames.slice(0, 5).join(' ')}`);
  const missingCur = [...new Set(world.countries.flatMap((r) => r.currencies))].filter((c) => !d.currencyNames?.[c]);
  if (missingCur.length) err('G1', `${l.code}: أسماء عملات غائبة: ${missingCur.slice(0, 5).join(' ')}`);
}

// G1: شكل محتوى صفحات الدول المنشورة (ما يحتاجه القالب)
for (const e of countryIndex.pages || []) {
  const cf = countryFileOf(e.cc, e.code);
  if (!cf) continue;
  const c = cf.content && cf.content[e.code];
  for (const p of countryShapeProblems(c)) err('G1', `صفحة الدولة ${e.cc} (${e.code}): ${p}`);
  if (c && c.h1 !== e.h1) err('G1', `صفحة الدولة ${e.cc}: h1 الفهرس لا يطابق ملفها — أعِد import-country-i18n`);
  if (c && contentHashOf(c) !== e.contentHash) warn('G1', `صفحة الدولة ${e.cc}: contentHash لا يطابق المحتوى — أعِد import-country-i18n`);
}

// ─── قراءة صفحات dist مرة واحدة ──────────────────────────────────────────────────────────
const htmlCache = new Map();
const htmlAt = (file) => {
  if (!htmlCache.has(file)) htmlCache.set(file, exists(file) ? fs.readFileSync(file, 'utf8') : null);
  return htmlCache.get(file);
};
const locOf = (code) => published.locales.find((l) => l.code === code);
const scriptOf = (code) => regByCode.get(code)?.script || (code === 'en' ? 'Latn' : null);

// ─── G2: المسارات = المُصيَّر = الخريطة ────────────────────────────────────────────────
const SITEMAP_DIR = distOk && fs.readdirSync(DIST).some((n) => /^sitemap.*\.xml$/.test(n)) ? DIST : PUBLIC;
const locsOf = (xml) => [...xml.matchAll(/<url>\s*<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => decode(m[1]));
const sitemapFiles = exists(SITEMAP_DIR) ? fs.readdirSync(SITEMAP_DIR).filter((n) => /^sitemap.*\.xml$/.test(n)) : [];
const readSm = (n) => fs.readFileSync(path.join(SITEMAP_DIR, n), 'utf8');
if (distOk) {
  for (const p of E) if (!exists(fileForPath(p))) err('G2', `صفحة غير مُصيَّرة: ${p} (لا ${rel(fileForPath(p))})`);
  const langMaps = sitemapFiles.filter((n) => /^sitemap-(.+)\.xml$/.test(n) && n !== 'sitemap-legacy.xml');
  const union = new Set();
  for (const n of langMaps) for (const loc of locsOf(readSm(n))) union.add(pathOfHref(loc));
  for (const p of E) if (!union.has(p)) err('G2', `${p} ليس في خرائط اللغات (sitemap-{code}.xml)`);
  for (const p of union) if (!ESet.has(p)) err('G2', `${p} في خرائط اللغات وليس صفحة منشورة في السجل`);
  if (sitemapFiles.includes('sitemap-legacy.xml')) {
    const newCodes = pubCodes.filter((c) => !LEGACY.includes(c));
    for (const loc of locsOf(readSm('sitemap-legacy.xml'))) {
      const p = pathOfHref(loc);
      if (ESet.has(p)) err('G2', `${p} في sitemap-legacy.xml وهو صفحة من الطبقة (مكانه sitemap-{code}.xml)`);
      const seg = p.split('/')[1];
      if (newCodes.includes(seg)) err('G2', `${p} في sitemap-legacy.xml تحت رمز لغة جديدة ${seg}`);
    }
  } else {
    err('G2', `لا sitemap-legacy.xml في ${rel(SITEMAP_DIR)}`);
  }
  for (const code of pubCodes.filter((c) => !LEGACY.includes(c))) {
    const dir = path.join(DIST, code);
    if (!exists(dir)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        const relp = `/${path.relative(DIST, full).split(path.sep).join('/')}`;
        if (relp === `/${code}/llms.txt`) continue;
        if (e.name === 'index.html' && ESet.has(relp.replace(/index\.html$/, ''))) continue;
        err('G2', `ملف في dist/${code}/ ليس صفحة منشورة: ${relp}`);
      }
    };
    walk(dir);
  }
}
// G2: صفحة الدولة مربوطة من صفّها في جدول /<lang>/countries/ ومن قائمة صفحات كل صفحة أخرى للغتها
if (distOk) {
  // المنطق في country-i18n.mjs (countryLinkProblems) — والاختبار يشغّله على HTML مصيَّر من المثبّت
  for (const cp of pages.filter((p) => isCountryPageKey(p.pageKey))) {
    const others = pages.filter((p) => p.code === cp.code && p.path !== cp.path && p.pageKey !== 'languages')
      .map((p) => ({ path: p.path, pageKey: p.pageKey, html: htmlAt(fileForPath(p.path)) }));
    for (const x of countryLinkProblems({ cp, others })) err(x.g, x.msg);
  }
}
{
  const app = exists(path.join(ROOT, 'src/App.tsx')) ? fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8') : '';
  if (!app.includes('I18N_PAGES.map(')) err('G2', 'App.tsx لا يحوي I18N_PAGES.map( — مسارات الطبقة تأتي من السجل لا تُكتب يدوياً');
}

// ─── G3: hreflang متبادل وcanonical ذاتي ───────────────────────────────────────────────
const altKey = (a) => `${a.hreflang}|${canon(a.href)}`;
/** بدائل رأس ملف مُصيَّر مجموعةً (مخزّنة: الرئيسيات أعضاء في عشرات العناقيد) */
const altCache = new Map();
const altSetAt = (file) => {
  if (!altCache.has(file)) {
    const h = htmlAt(file);
    altCache.set(file, h ? new Set(alternatesOf(headOf(h)).map(altKey)) : null);
  }
  return altCache.get(file);
};
if (distOk) {
  for (const page of pages) {
    const html = htmlAt(fileForPath(page.path));
    if (!html) continue;
    const head = headOf(html);
    const want = canon(ORIGIN + page.path);
    const got = canonicalOf(head);
    if (got !== want) err('G3', `${page.path}: canonical «${got}» ≠ ${want}`);
    // صفحة الدولة: العنقود الذاتي (hreflang لغتها + x-default إليها) يفحصه countryPageDistProblems في حلقة G5 أدناه
    const cluster = page.clusterKey ? clusterAlternates(page.clusterKey, REG) : [];
    const have = new Set(alternatesOf(head).map(altKey));
    const need2 = new Set(cluster.map(altKey));
    const missing = [...need2].filter((k) => !have.has(k));
    const extra = [...have].filter((k) => !need2.has(k));
    if (missing.length) err('G3', `${page.path}: بدائل غائبة من الرأس: ${missing.slice(0, 4).join(' · ')}${missing.length > 4 ? ` (+${missing.length - 4})` : ''}`);
    if (extra.length) err('G3', `${page.path}: بدائل زائدة في الرأس: ${extra.slice(0, 4).join(' · ')}`);
    // التبادل: كل عضو يُعلن هذه الصفحة
    for (const m of cluster) {
      if (m.hreflang === 'x-default') continue;
      const mp = pathOfHref(m.href);
      const back = altSetAt(mp === '/' ? path.join(DIST, 'index.html') : fileForPath(mp));
      if (!back) { err('G3', `${page.path}: العضو ${m.href} غير مُصيَّر`); continue; }
      if (!back.has(`${page.hreflang}|${want}`)) err('G3', `${m.href} لا يُعلن ${want} (${page.hreflang}) — العلاقة غير متبادلة`);
    }
    const robots = metaContent(head, 'name', 'robots') || '';
    if (/noindex/i.test(robots)) err('G3', `${page.path}: noindex في صفحة منشورة`);
  }
  // الصفحات القديمة الأحد عشر: رؤوسها تحوي العنقود الممدَّد كله
  const LEGACY_PAGES = [
    ['/', 'home'], ['/en/', 'home'], ['/fr/', 'home'], ['/tr/', 'home'], ['/zh/', 'home'],
    ['/about/', 'about'], ['/en/about/', 'about'], ['/fr/about/', 'about'],
    ['/contact/', 'contact'], ['/en/contact/', 'contact'], ['/fr/contact/', 'contact'],
  ];
  for (const [p, key] of LEGACY_PAGES) {
    const file = p === '/' ? path.join(DIST, 'index.html') : fileForPath(p);
    const html = htmlAt(file);
    if (!html) { err('G3', `الصفحة القديمة ${p} غير موجودة في dist`); continue; }
    const have = new Set(alternatesOf(headOf(html)).map(altKey));
    const cluster = clusterAlternates(key, REG).map(altKey);
    const missing = cluster.filter((k) => !have.has(k));
    if (missing.length) err('G3', `${p}: العنقود الممدَّد ناقص في الرأس: ${missing.slice(0, 4).join(' · ')}${missing.length > 4 ? ` (+${missing.length - 4})` : ''}`);
    const extra = [...have].filter((k) => !cluster.includes(k));
    if (extra.length) warn('G3', `${p}: بدائل خارج العنقود: ${extra.slice(0, 3).join(' · ')}`);
  }
}

// ─── G4 + G5 + G6 على كل صفحة منشورة ──────────────────────────────────────────────────
const priceRe = livePriceRe(LIVE_PRICES);
const certWarned = new Set();
if (distOk) {
  for (const page of pages) {
    const file = fileForPath(page.path);
    const html = htmlAt(file);
    if (!html) continue;
    const head = headOf(html);
    const loc = locOf(page.code);
    const script = scriptOf(page.code);
    const title = titleOf(head);
    const desc = metaContent(head, 'name', 'description') || '';
    const ogTitle = metaContent(head, 'property', 'og:title') || '';
    const ogDesc = metaContent(head, 'property', 'og:description') || '';
    const main = mainOf(html);
    const h1 = stripTags((main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');

    // G1 في dist
    if (!title) err('G1', `${page.path}: <title> فارغ`);
    if (!desc.trim()) err('G1', `${page.path}: وصف meta فارغ`);
    if (!h1) err('G1', `${page.path}: <h1> فارغ`);
    if ([...title].length > 70) warn('G1', `${page.path}: العنوان ${[...title].length} حرفاً (> 70)`);
    const dl = [...desc].length;
    if (desc && (dl < 50 || dl > 170)) warn('G1', `${page.path}: الوصف ${dl} حرفاً (خارج 50–170)`);

    // G4: لغة النص وسمات الوسم
    const visible = stripTags(removeElements(removeElements(main, RE_LANGS_NAV), RE_COUNTRIES).replace(RE_LINKS, ' '));
    const corpus = [visible, title, desc, ogTitle, ogDesc].join(' \n ');
    for (const p of scriptProblems(corpus, { script, code: page.code, hreflang: page.hreflang })) err('G4', `${page.path}: ${p}`);
    const ha = htmlAttrs(html);
    if (ha.lang !== page.hreflang) err('G4', `${page.path}: <html lang="${ha.lang}"> ≠ ${page.hreflang}`);
    if (ha.dir !== page.dir) err('G4', `${page.path}: <html dir="${ha.dir}"> ≠ ${page.dir}`);

    // G5: القواعد العامة كما يطبّقها verify-claims (نصوص المستودع ⇒ كلها حاجبة هنا)
    const relp = path.relative(DIST, file);
    const text = claimsText(html);
    const headScope = [title, desc, h1].join(' ');
    for (const rule of RULES) {
      if (rule.paths && !rule.paths.test(relp)) continue;
      if (rule.exceptPaths && rule.exceptPaths.test(relp)) continue;
      const v = findViolation(rule, rule.scope === 'head' ? headScope : rule.scope === 'raw' ? html : text);
      if (v) err('G5', `${page.path}: [${rule.id}] «${v.match.slice(0, 50)}» — ${rule.why}`);
    }
    // G5: قواعد الطبقة على النص الظاهر (بلا جدول الدول للرقم الملاصق للعملة)
    const isCountry = isCountryPageKey(page.pageKey);
    if (isCountry) {
      // صفحة الدولة (G3 · G5 · G6 الخاصة بها) — المنطق في country-i18n.mjs (countryPageDistProblems)، والاختبار
      // يشغّله على HTML مصيَّر من المثبّت ثم مكسور عمداً: السنة أو التاريخ محجوب في جملة عن FieldSales (أيّ قسم)،
      // وH1 بلا سنة، والختم بسنة التحقق، وادّعاء الربط الحكومي، والعنقود الذاتي، وFAQPage، والأزرار، والمصادر،
      // والأقسام، ومثال الفاتورة
      const cc = countryOfPageKey(page.pageKey);
      for (const x of countryPageDistProblems({ html, page, reg: REG, country: countryFileOf(cc, page.code), livePrices: LIVE_PRICES })) {
        err(x.g, `${page.path}: ${x.msg}`);
      }
    } else {
      const nonTable = stripTags(removeElements(main, RE_COUNTRIES));
      for (const v of findI18nViolations([nonTable, title, desc, ogTitle, ogDesc].join(' \n '), {
        code: page.code, livePrices: LIVE_PRICES, allowYear: page.pageKey === 'about',
      })) err('G5', `${page.path}: [${v.id}] «${v.match}» — ${v.why}`);
    }
    // G5: JSON-LD بلا عروض ولا أسعار
    const ld = ldBlocks(html).join('\n');
    if (/"@type"\s*:\s*"(?:Aggregate)?Offer"|"(?:price|lowPrice|highPrice|priceCurrency)"\s*:/.test(ld)) err('G5', `${page.path}: Offer أو price في JSON-LD`);
    if (priceRe && priceRe.test(toAsciiDigits(ld))) err('G5', `${page.path}: سعر باقة حيّ في JSON-LD`);
    if (!certRuleFor(page.code) && page.code !== 'en' && !certWarned.has(page.code)) {
      certWarned.add(page.code);
      warn('G5', `لا قاعدة اعتماد للغة ${page.code}${NO_CERT_RULE.includes(page.code) ? ' — تُكمَل قبل رفع WAVE_MAX إلى 2' : ''}`);
    }

    // G6: الصدق — ملاحظة لغات الواجهة ظاهرة
    const ui = stripTags((main.match(/<p\b[^>]*data-i18n-ui[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '');
    if (!ui) err('G6', `${page.path}: لا [data-i18n-ui] غير فارغ — ملاحظة لغات الواجهة الصادقة غائبة`);
    else if (page.pageKey !== 'languages') {
      const note = files.get(page.code)?.strings?.['tierB.home.uiLanguagesNote'];
      if (note && ui !== note.replace(/\s+/g, ' ').trim()) err('G6', `${page.path}: نص [data-i18n-ui] لا يطابق tierB.home.uiLanguagesNote`);
    } else if (!/Arabic, English, French, Turkish and Chinese/.test(ui)) {
      err('G6', '/languages/: لا تذكر لغات الواجهة الخمس بالإنجليزية');
    }
    if (page.pageKey === 'home' && !page.legacy) {
      if (!html.includes('/subscribe-request/?type=quote')) err('G6', `${page.path}: رابط «طلب عرض سعر» غائب`);
      if (!html.includes('go/wa')) err('G6', `${page.path}: رابط واتساب (go/wa) غائب`);
    }
    // G6: عمود الفوترة الإلكترونية ثابت بالرمز (السعودية «حيّ» وحدها) وجدول الدول كامل
    if (page.pageKey === 'countries') {
      const f = files.get(page.code);
      const tbl = (main.match(RE_COUNTRIES) || [''])[0];
      const rows = [...tbl.matchAll(/<tr>\s*<th\b[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/gi)]
        .map((m) => ({ name: stripTags(m[1]), cells: [...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1])) }));
      if (rows.length !== WORLD_COUNT) err('G6', `${page.path}: جدول الدول ${rows.length} صفاً لا ${WORLD_COUNT}`);
      if (f) {
        const order = f._derived?.countryOrder || [];
        const live = f.strings['tierB.countries.einvoicingLive'];
        const onReq = f.strings['tierB.countries.einvoicingOnRequest'];
        rows.forEach((r, i) => {
          const c = order[i];
          if (!c) return;
          if (r.name !== String(f._derived.countryNames[c]).replace(/\s+/g, ' ').trim()) { err('G6', `${page.path}: الصف ${i + 1} «${r.name}» ليس ${c} بترتيب countryOrder`); return; }
          const einv = r.cells[2];
          if (c === 'SA' ? einv !== live : einv !== onReq) err('G6', `${page.path}: ${c} عمود الفوترة «${einv}» — السعودية وحدها «حيّ» وغيرها «عند الطلب»`);
          if (PAGE_VAT && PAGE_VAT[c] != null && r.cells[1] === '—') err('G6', `${page.path}: ${c} بلا نسبة ضريبة وهي في خريطة الصفحة (${PAGE_VAT[c]})`);
          if (PAGE_VAT && PAGE_VAT[c] == null && r.cells[1] !== '—') err('G6', `${page.path}: ${c} نسبة «${r.cells[1]}» ليست في خريطة الصفحة (يجب «—»)`);
        });
      }
    }
  }
}
// G4/G5 على llms.txt لكل لغة جديدة
for (const l of published.locales.filter((x) => !LEGACY.includes(x.code))) {
  const f = path.join(DIST, l.code, 'llms.txt');
  if (!distOk) break;
  if (!exists(f)) { warn('G4', `/${l.code}/llms.txt غير موجود (gen-llms-i18n)`); continue; }
  const raw = fs.readFileSync(f, 'utf8');
  const text = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ');
  for (const p of scriptProblems(text, { script: scriptOf(l.code), code: l.code, hreflang: l.hreflang })) err('G4', `/${l.code}/llms.txt: ${p}`);
  for (const rule of RULES) {
    if (rule.scope === 'head' || rule.paths) continue;
    const v = findViolation(rule, raw);
    if (v) err('G5', `/${l.code}/llms.txt: [${rule.id}] «${v.match.slice(0, 50)}»`);
  }
  for (const v of findI18nViolations(text, { code: l.code, livePrices: LIVE_PRICES })) err('G5', `/${l.code}/llms.txt: [${v.id}] «${v.match}»`);
}
// G5 على نصوص ملفات المحتوى نفسها (سنة التأسيس مسموحة في مفتاحيها)
for (const l of published.locales) {
  const f = files.get(l.code);
  if (!f) continue;
  for (const v of checkMarketingStrings(f.strings, { code: l.code, livePrices: LIVE_PRICES })) {
    err('G5', `marketing/${l.code}.json ${v.key}: [${v.id}] «${v.match}» — ${I18N_RULE_WHY[v.id]}`);
  }
}
// G6: قائمة لغات الواجهة المحسوبة تظهر في الملاحظة المستبدلة
for (const l of published.locales) {
  const f = files.get(l.code);
  if (!f) continue;
  const ui = f._derived?.uiLanguages;
  const note = f.strings?.['tierB.home.uiLanguagesNote'] || '';
  if (!ui || !note.includes(ui)) err('G6', `${l.code}: _derived.uiLanguages «${ui}» لا يظهر في tierB.home.uiLanguagesNote`);
}

// ─── G7: robots ─────────────────────────────────────────────────────────────────────────
{
  // dist/robots.txt (نسخة public التي ينسخها Vite) أولاً — فيُفحص ما يُخدم فعلاً، ويُختبر الحارس على نسخة dist مؤقتة
  const rf = distOk && exists(path.join(DIST, 'robots.txt')) ? path.join(DIST, 'robots.txt') : path.join(PUBLIC, 'robots.txt');
  if (!exists(rf)) err('G7', 'robots.txt غير موجود (لا في dist ولا في public)');
  else {
    const lines = fs.readFileSync(rf, 'utf8').split(/\r?\n/).map((s) => s.replace(/#.*$/, '').trim()).filter(Boolean);
    const field = (s) => { const i = s.indexOf(':'); return i < 0 ? [s.toLowerCase(), ''] : [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()]; };
    const parsed = lines.map(field);
    const groupLines = parsed.filter(([k]) => k !== 'sitemap');
    let groups = 0;
    let prevUa = false;
    const agents = [];
    for (const [k, v] of groupLines) {
      if (k === 'user-agent') { if (!prevUa) groups++; prevUa = true; agents.push(v); } else prevUa = false;
    }
    if (groups !== 1) err('G7', `robots.txt فيه ${groups} مجموعة — المطلوب مجموعة واحدة (كل زاحف مسمّى يقرأ القواعد نفسها)`);
    if (!groupLines.length || groupLines[0][0] !== 'user-agent' || groupLines[0][1] !== '*') err('G7', 'robots.txt لا يبدأ بـUser-agent: *');
    const lower = new Set(agents.map((a) => a.toLowerCase()));
    const missing = ROBOTS_REQUIRED.filter((n) => !lower.has(n.toLowerCase()));
    if (missing.length) err('G7', `أسماء إلزامية غائبة من robots.txt: ${missing.join('، ')}`);
    if (!parsed.some(([k, v]) => k === 'sitemap' && v === `${ORIGIN}/sitemap.xml`)) err('G7', `السطر Sitemap: ${ORIGIN}/sitemap.xml غائب`);
    // مطابقة robots (أطول قاعدة تحكم، والتعادل للسماح) على كل صفحة منشورة
    const rules = parsed.filter(([k, v]) => (k === 'allow' || k === 'disallow') && v).map(([k, v]) => ({
      allow: k === 'allow', len: v.length,
      re: new RegExp(`^${v.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$')}`),
    }));
    const blocked = (p) => {
      let best = null;
      for (const r of rules) {
        if (!r.re.test(p)) continue;
        if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
      }
      return best && !best.allow;
    };
    for (const code of pubCodes) if (blocked(`/${code}/`)) err('G7', `robots.txt يحجب /${code}/ — لغة منشورة`);
    for (const p of E) if (blocked(p)) err('G7', `robots.txt يحجب ${p}`);
  }
}

// ─── G9: أحجام الخرائط ─────────────────────────────────────────────────────────────────
{
  if (!sitemapFiles.includes('sitemap.xml')) err('G9', `لا sitemap.xml في ${rel(SITEMAP_DIR)}`);
  else {
    const idx = readSm('sitemap.xml');
    if (!/<sitemapindex\b/.test(idx)) err('G9', 'sitemap.xml ليس فهرس خرائط (sitemapindex)');
    else {
      const kids = [...idx.matchAll(/<sitemap>\s*<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => decode(m[1]));
      if (kids.length > MAX_URLS) err('G9', `الفهرس ${kids.length} ابناً (> ${MAX_URLS})`);
      const names = kids.map((k) => k.split('/').pop());
      for (const n of names) if (!sitemapFiles.includes(n)) err('G9', `الفهرس يشير إلى ${n} وهو غير موجود`);
      for (const n of sitemapFiles.filter((x) => x !== 'sitemap.xml')) if (!names.includes(n)) err('G9', `${n} موجود ولا يشير إليه الفهرس`);
      for (const n of names.filter((x) => sitemapFiles.includes(x))) {
        const xml = readSm(n);
        const count = locsOf(xml).length;
        const bytes = Buffer.byteLength(xml);
        if (!count) err('G9', `${n} فارغ`);
        if (count > MAX_URLS) err('G9', `${n}: ${count} رابطاً (> ${MAX_URLS})`);
        if (bytes > MAX_BYTES) err('G9', `${n}: ${(bytes / 1048576).toFixed(1)}MB (> 50MB)`);
      }
      const pageCodes = [...new Set(pages.map((p) => p.code))];
      for (const c of pageCodes) {
        const own = names.filter((n) => n === `sitemap-${c}.xml`).length;
        if (own !== 1) err('G9', `اللغة ${c} لها ${own} خريطة (المطلوب sitemap-${c}.xml واحدة)`);
      }
    }
  }
}

// ─── G-assets: حزم المتصفح بلا محتوى غير منشور ─────────────────────────────────────────────
// ما يُخدم علناً في dist/assets لا يحمل ملاحظات التحرير والمراجعة (notes · review) ولا تدقيق الحقائق (audit ·
// honesty · uncertain) ولا محتوى دولة مستثناة أو لغة غير منشورة — ببصمات من src/content نفسها (country-i18n.mjs).
// لا يُبحث عن أسماء المفاتيح (reviewedAt · notes): التطبيق نفسه يستعملها في شاشاته.
if (distOk) {
  const ASSETS = path.join(DIST, 'assets');
  const assetFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(?:m?js|css|json|map|txt|html?)$/i.test(e.name)) assetFiles.push(full);
    }
  };
  if (exists(ASSETS)) walk(ASSETS);
  else err('G-assets', `لا ${rel(ASSETS)}`);
  const fps = countryLeakFingerprints({ root: ROOT, index: countryIndex });
  const leaks = assetLeaks(assetFiles.map((f) => ({ name: rel(f), text: fs.readFileSync(f, 'utf8') })), fps);
  for (const l of leaks) err('G-assets', `${l.name}: ${l.cc} ${l.kind} — «${l.fp}»`);
  if (VERBOSE) console.log(`  G-assets: ${assetFiles.length} ملف · ${fps.length} بصمة`);
}

// ─── الخلاصة ────────────────────────────────────────────────────────────────────────────
const totalErr = CHECKS.reduce((n, c) => n + report[c].errors.length, 0);
const totalWarn = CHECKS.reduce((n, c) => n + report[c].warnings.length, 0);
const LIMIT = VERBOSE ? Infinity : 8;
console.log(`فحص الطبقة متعددة اللغات: ${published.locales.length} لغة منشورة · ${E.length} صفحة · dist: ${rel(DIST) || DIST}${published.simulated ? ' · ⚠️ محاكاة' : ''}`);
for (const c of CHECKS) {
  const { errors, warnings } = report[c];
  const mark = errors.length ? '✗' : warnings.length ? '⚠' : '✓';
  console.log(`  ${mark} ${c} ${TITLES[c]}: ${errors.length} خطأ · ${warnings.length} تحذير`);
  for (const m of errors.slice(0, LIMIT)) console.error(`      ✗ ${m}`);
  if (errors.length > LIMIT) console.error(`      … و${errors.length - LIMIT} خطأ آخر (--verbose للكل)`);
  for (const m of warnings.slice(0, LIMIT)) console.warn(`      ⚠ ${m}`);
  if (warnings.length > LIMIT) console.warn(`      … و${warnings.length - LIMIT} تحذير آخر (--verbose للكل)`);
}
if (!totalErr) {
  console.log(`  ✓ الطبقة سليمة${totalWarn ? ` (${totalWarn} تحذير غير حاجب)` : ''}.`);
  process.exit(0);
}
if (WARN_ONLY) {
  console.warn(`\n⚠ verify-i18n: ${totalErr} خطأ — I18N_WARN=1 فلا يُفشل البناء (مؤقت).`);
  process.exit(0);
}
console.error(`\n✗ verify-i18n فشل: ${totalErr} خطأ في ${CHECKS.filter((c) => report[c].errors.length).join('، ')}.`);
process.exit(1);
