/**
 * مستورد الطبقة متعددة اللغات (spec-b §٤) — من مصنع المحتوى إلى ملفات المستودع الملتزمة.
 *
 * يُشغَّل **يدوياً فقط** (npm run i18n:import -- --from <مجلد المصنع>)، ولا يدخل prebuild ولا postbuild:
 * Render لا يرى قرص المصنع. ما يكتبه يُلتزم، والبناء يقرأ الملتزم وحده.
 *
 * المخرجات:
 *  - src/i18n/registry/locales.json — كل لغات المصنع الـ153 بحالة كل منها وأسباب عدم نشرها.
 *  - src/i18n/registry/published.json — المنشورة وحدها مضغوطة (تقرؤه حزمة المتصفح).
 *  - src/i18n/marketing/<code>.json — للمنشورة وحدها: النصوص بعد الاستبدال وما يُشتق من Intl.
 *    الإنجليزية من source/en.json دائماً. لا يُكتب ar.json أبداً (لا صفحات عربية جديدة).
 *
 * لماذا يُشتق Intl هنا لا عند التصيير: ICU في Node على Render يختلف عن ICU في متصفح الزائر، فتختلف أسماء
 * الدول وترتيبها أحياناً — فيرى الزاحف نصاً غير ما يرسمه React. هنا يُحسب مرة ويُلتزم، والقالب بلا Intl.
 *
 * لا ينشر لغة إلا بمراجعة (review/<code>.json بجودة publish أو publish-with-notes) — قرار المالك: المراجعة
 * بالذكاء الاصطناعي وحدها كافية، لكنها شرط. وكل خرق في المحتوى يُسجَّل سبباً ويمنع النشر، ومنه ما يرفضه
 * الحارس verify-i18n على المحتوى نفسه (القواعد المشتركة في claims-i18n.mjs)، فلا ينشر المستورد ما يُفشل البناء.
 *
 * التشغيل:
 *   node scripts/import-i18n.mjs --from D:/claude-work/global-i18n [--wave-max N] [--dry-run] [--simulate es,ur,zh-hant,de]
 *   --dry-run   يطبع جدول اللغات وعدد الصفحات ولا يكتب شيئاً.
 *   --simulate  للاختبار المحلي وحده: يعامل جودة تلك اللغات «publish» ويكتب simulated:true —
 *               verify-i18n يفشل على أي محتوى مُحاكى ما لم يُضبط I18N_ALLOW_SIMULATED=1، فلا يُلتزم بالخطأ.
 * بعده: npm run seo:sitemap && npm run geo:llms، وتُلتزم المخرجات معاً بمسارات صريحة.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeSlug, checkLocaleCode, i18nPages, requiredKeys, BASE_PAGES, TIER_A_PAGES, LEGACY, DEFAULT_CATEGORY_SLUG,
} from '../src/i18n/i18nRoutes.mjs';
import {
  checkMarketingStrings, scriptProblems, contentHashOf, placeholdersOf, publishedEntry, NO_CERT_RULE, certRuleFor,
} from './claims-i18n.mjs';
import { RULES, findViolation } from './claims-rules.mjs';
import { loadPricing } from './pricing-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REG_DIR = path.join(ROOT, 'src/i18n/registry');
const MKT_DIR = path.join(ROOT, 'src/i18n/marketing');
const LOCALES_FILE = path.join(REG_DIR, 'locales.json');
const PUBLISHED_FILE = path.join(REG_DIR, 'published.json');
const WORLD_FILE = path.join(ROOT, 'src/i18n/world-countries.json');
const INDEX_HTML = path.join(ROOT, 'index.html');

const argv = process.argv.slice(2);
const argOf = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
const DRY = argv.includes('--dry-run');
const FROM = argOf('--from');
const SIMULATE = (argOf('--simulate') || '').split(',').map((s) => s.trim()).filter(Boolean);
const WAVE_ARG = argOf('--wave-max');

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

if (!FROM) die('يلزم --from <مجلد مصنع المحتوى> (مثال: --from D:/claude-work/global-i18n). المستورد لا يخمّن مكانه.');
const FACTORY = path.resolve(FROM);
if (!fs.existsSync(path.join(FACTORY, 'source/languages.json'))) die(`لا يوجد ${FACTORY}/source/languages.json — هل المسار صحيح؟`);
if (!fs.existsSync(WORLD_FILE)) die('لا يوجد src/i18n/world-countries.json — شغّل أولاً: npm run i18n:countries (build-world-countries.mjs)');
if (WAVE_ARG != null && !/^\d+$/.test(WAVE_ARG)) die(`--wave-max يجب أن يكون عدداً صحيحاً (وصل «${WAVE_ARG}»)`);

// ─── المدخلات ───────────────────────────────────────────────────────────────────────────
const languages = readJson(path.join(FACTORY, 'source/languages.json'));
const en = readJson(path.join(FACTORY, 'source/en.json'));
const EN_KEYS = Object.keys(en);
const world = readJson(WORLD_FILE);
const prevReg = fs.existsSync(LOCALES_FILE) ? readJson(LOCALES_FILE) : null;
const prevByCode = new Map((prevReg?.locales || []).map((l) => [l.code, l]));
const WAVE_MAX = WAVE_ARG != null ? Number(WAVE_ARG) : (prevReg?.meta?.waveMax ?? 1);

const founding = fs.readFileSync(INDEX_HTML, 'utf8').match(/"foundingDate"\s*:\s*"(\d{4})"/);
if (!founding) die('لم يُعثر على "foundingDate": "YYYY" في index.html — {year} لا يُملأ بلا مصدره');
const FOUNDING_YEAR = founding[1];

const dirFiles = (sub) => {
  const d = path.join(FACTORY, sub);
  if (!fs.existsSync(d)) return new Map();
  return new Map(fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => [f.slice(0, -5), path.join(d, f)]));
};
const contentFiles = dirFiles('content');
const reviewFiles = dirFiles('review');
const glossaryFiles = dirFiles('glossary');

const unknownSim = SIMULATE.filter((c) => !languages.some((l) => l.code === c));
if (unknownSim.length) die(`--simulate برموز ليست في languages.json: ${unknownSim.join(', ')}`);

// الأسعار الحيّة لقاعدة «لا سعر» — تعذّر الشبكة ⇒ الاحتياطي (مطابق CMS وقت كتابته)
const pricing = await loadPricing();
const LIVE_PRICES = pricing.plans.map((p) => String(p.price)).filter((p) => /^\d+$/.test(p));

// ─── قواعد الحقول (spec-b §٢.٢) ────────────────────────────────────────────────────────
const waveOf = (l) => (l.tier === 'A' || l.feasibility === 'high' ? 1 : l.feasibility === 'medium' ? 2 : 3);
const OG_EXCEPTIONS = { 'zh-hant': 'zh_TW', no: 'nb_NO', en: 'en_US', fr: 'fr_FR', tr: 'tr_TR', zh: 'zh_CN' };
const ogLocaleOf = (l) => {
  if (OG_EXCEPTIONS[l.code]) return OG_EXCEPTIONS[l.code];
  const lang = String(l.hreflang).split('-')[0];
  const market = String(l.markets || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return market ? `${lang}_${market}` : lang;
};
const isLegacy = (code) => LEGACY.includes(code);
const QUALITY_OK = new Set(['publish', 'publish-with-notes']);

/** صحة ملف المحتوى بنداً بنداً — كل خرق سبب يمنع النشر */
function validateContent(content) {
  const reasons = [];
  for (const [k, v] of Object.entries(content)) {
    if (!(k in en)) { reasons.push(`unknown key: ${k}`); continue; }
    if (typeof v !== 'string' || !v.trim()) { reasons.push(`empty: ${k}`); continue; }
    if (/[<>]/.test(v)) reasons.push(`html in: ${k}`);
    if (placeholdersOf(v).join(',') !== placeholdersOf(en[k]).join(',')) reasons.push(`placeholders differ: ${k}`);
  }
  // جدول الدول يعرض «—» حيث لا نسبة عامة؛ جملة taxNote تشرحها — نصّ بلا الشرطة نسخة قديمة من المصدر
  const note = content['tierB.countries.taxNote'];
  if (typeof note === 'string' && note.trim() && !note.includes('—')) reasons.push('stale: tierB.countries.taxNote lacks dash (—) explanation');
  return reasons;
}

/** اكتمال مجموعة (tierB. أو tierA.): كل مفاتيح en موجودة وغير فارغة وبالعناصر النائبة نفسها */
function completeGroup(content, prefix) {
  const keys = EN_KEYS.filter((k) => k.startsWith(prefix));
  const missing = keys.filter((k) => typeof content[k] !== 'string' || !content[k].trim()
    || placeholdersOf(content[k]).join(',') !== placeholdersOf(en[k]).join(','));
  return { ok: missing.length === 0, missing };
}

// ─── اشتقاقات Intl (spec-b §٢.٤) ──────────────────────────────────────────────────────
const supports = (Ctor, loc) => { try { return Ctor.supportedLocalesOf([loc]).length > 0; } catch { return false; } };
const EN_UI_LANGS = 'Arabic, English, French, Turkish and Chinese';

function uiLanguagesFor(code, intl) {
  if (code === 'en') return EN_UI_LANGS;
  const gf = glossaryFiles.get(code);
  if (gf) {
    const fp = readJson(gf)?.fixedPhrases || {};
    if (typeof fp.uiLanguagesFill === 'string' && fp.uiLanguagesFill.trim()) return fp.uiLanguagesFill.trim();
    // بعض القواميس سمّت الحقل نفسه uiLanguagesValue — يُقبل ما دام قائمة لا جملة بعنصر نائب
    if (typeof fp.uiLanguagesValue === 'string' && fp.uiLanguagesValue.trim() && !fp.uiLanguagesValue.includes('{')) return fp.uiLanguagesValue.trim();
  }
  if (supports(Intl.ListFormat, intl) && supports(Intl.DisplayNames, intl)) {
    try {
      const dn = new Intl.DisplayNames([intl], { type: 'language' });
      const names = ['ar', 'en', 'fr', 'tr', 'zh'].map((c) => dn.of(c));
      if (names.every((n) => n && !['ar', 'en', 'fr', 'tr', 'zh'].includes(n))) {
        return new Intl.ListFormat(intl, { type: 'conjunction' }).format(names);
      }
    } catch { /* يسقط إلى الإنجليزية */ }
  }
  return EN_UI_LANGS;
}

function derivedFor(code, intl) {
  const namesLoc = supports(Intl.DisplayNames, intl) ? intl : 'en';
  const namesFallback = namesLoc === intl ? null : 'en';
  const regionDn = new Intl.DisplayNames([namesLoc], { type: 'region' });
  const regionEn = new Intl.DisplayNames(['en'], { type: 'region' });
  const curDn = new Intl.DisplayNames([namesLoc], { type: 'currency' });
  const curEn = new Intl.DisplayNames(['en'], { type: 'currency' });
  const nameOr = (dn, dnEn, c) => {
    let n = null;
    try { n = dn.of(c); } catch { /* رمز لا يعرفه ICU */ }
    if (!n || n === c) { try { n = dnEn.of(c); } catch { n = null; } }
    return n && n !== '' ? n : c;
  };
  const countryNames = {};
  for (const r of world.countries) countryNames[r.code] = nameOr(regionDn, regionEn, r.code);
  const currencies = [...new Set(world.countries.flatMap((r) => r.currencies))].sort();
  const currencyNames = {};
  for (const c of currencies) currencyNames[c] = nameOr(curDn, curEn, c);
  const collator = new Intl.Collator(supports(Intl.Collator, intl) ? intl : 'en');
  const countryOrder = world.countries.map((r) => r.code)
    .sort((a, b) => collator.compare(countryNames[a], countryNames[b]) || (a < b ? -1 : a > b ? 1 : 0));
  const numLoc = supports(Intl.NumberFormat, intl) ? intl : 'en';
  const parts = new Intl.NumberFormat(numLoc, { style: 'percent', maximumFractionDigits: 2 }).formatToParts(0.155);
  const numeric = (p) => p.type === 'integer' || p.type === 'fraction' || p.type === 'decimal' || p.type === 'group';
  const first = parts.findIndex(numeric);
  let last = -1;
  parts.forEach((p, i) => { if (numeric(p)) last = i; });
  const percent = {
    before: parts.slice(0, first).map((p) => p.value).join(''),
    after: parts.slice(last + 1).map((p) => p.value).join(''),
    decimal: (parts.find((p) => p.type === 'decimal') || { value: '.' }).value,
  };
  return {
    uiLanguages: uiLanguagesFor(code, intl),
    countriesCount: new Intl.NumberFormat(numLoc).format(world.countries.length),
    foundingYear: FOUNDING_YEAR,
    countryNames,
    currencyNames,
    countryOrder,
    percent,
    namesFallback,
  };
}

const fill = (s, d) => String(s)
  .replace(/\{uiLanguages\}/g, d.uiLanguages)
  .replace(/\{countriesCount\}/g, d.countriesCount)
  .replace(/\{year\}/g, d.foundingYear);

/** نصوص الصفحة مجمّعة كما تُرسم تقريباً — لقواعد claims-rules قبل النشر (verify-claims يعيدها على dist) */
function pageCorpus(strings, pageKey) {
  const keys = requiredKeys(pageKey, EN_KEYS).filter((k) => k in strings && k !== 'tierB.category.slugHint');
  const headKeys = keys.filter((k) => /\.(title|description|h1)$/.test(k) && !/\.(?:capabilities|howItWorks|sections|points)\./.test(k));
  return { all: keys.map((k) => strings[k]).join(' . '), head: headKeys.map((k) => strings[k]).join(' ') };
}

// ─── حساب السجل ─────────────────────────────────────────────────────────────────────────
const locales = [];
const files = new Map(); // code ⇒ ملف marketing
const warnings = [];

for (const l of languages) {
  const code = l.code;
  const wave = waveOf(l);
  const legacy = isLegacy(code);
  const reasons = [];
  const content = code === 'en' ? en : (contentFiles.has(code) ? readJson(contentFiles.get(code)) : null);
  let quality = null;
  if (reviewFiles.has(code)) {
    const rv = readJson(reviewFiles.get(code));
    quality = rv?.quality ?? null;
    if (rv?.code && rv.code !== code) reasons.push(`review code mismatch: ${rv.code}`);
  }
  const simulated = SIMULATE.includes(code);
  const effQuality = simulated ? 'publish' : quality;

  let complete = { base: false, tierA: false };
  if (!content) {
    reasons.push('content missing');
  } else {
    reasons.push(...validateContent(content));
    const b = completeGroup(content, 'tierB.');
    const a = completeGroup(content, 'tierA.');
    complete = { base: b.ok, tierA: a.ok };
    if (!b.ok) reasons.push(`tierB incomplete (${b.missing.length} missing)`);
  }
  if (wave > WAVE_MAX) reasons.push(`wave ${wave} > waveMax ${WAVE_MAX}`);
  if (code === 'ar') reasons.push('ar: no new Arabic pages');
  const codeIssue = checkLocaleCode(code);
  if (codeIssue) reasons.push(`code: ${codeIssue}`);
  if (code !== 'en') {
    if (effQuality == null) reasons.push('review missing');
    else if (!QUALITY_OK.has(effQuality)) reasons.push(`quality ${effQuality}`);
  }
  const slug = code === 'en' ? DEFAULT_CATEGORY_SLUG : normalizeSlug(content?.['tierB.category.slugHint']);

  // نشر مبدئي قبل فحص المحتوى المستبدل (الذي يحتاج اشتقاقات Intl — تُحسب للمرشّحة وحدها)
  const candidate = code === 'en' || (wave <= WAVE_MAX && code !== 'ar' && !codeIssue && complete.base
    && QUALITY_OK.has(effQuality) && reasons.length === 0);

  let pages = [];
  let contentHash = null;
  let contentDate = null;
  let published = false;
  if (candidate) {
    pages = legacy ? ['category', 'countries']
      : [...BASE_PAGES, ...(l.tier === 'A' && complete.tierA ? TIER_A_PAGES : [])];
    const derived = derivedFor(code, l.hreflang);
    const groups = ['tierB.', ...(complete.tierA ? ['tierA.'] : [])];
    const strings = {};
    for (const k of EN_KEYS) if (groups.some((g) => k.startsWith(g))) strings[k] = fill(content[k], derived);

    // قواعد المحتوى نفسها التي يطبّقها الحارس — مخالفة ⇒ لا نشر (عدا en: منشورة دائماً، فيُطبع تحذير صاخب)
    const contentReasons = [];
    if (code !== 'en') {
      for (const k of Object.keys(strings)) {
        if (k !== 'tierB.category.slugHint' && strings[k] === fill(en[k], derived)) contentReasons.push(`equals English: ${k}`);
      }
    }
    for (const v of checkMarketingStrings(strings, { code, livePrices: LIVE_PRICES })) {
      contentReasons.push(`${v.id}: ${v.key} «${v.match}»`);
    }
    for (const pk of pages) {
      const { all, head } = pageCorpus(strings, pk);
      for (const rule of RULES) {
        if (rule.paths && !rule.paths.test(`${code}/x`)) continue;
        if (rule.severity === 'warn' && rule.id !== 'zatca-phase2-stale-denial') continue;
        const v = findViolation(rule, rule.scope === 'head' ? head : all);
        if (v) contentReasons.push(`claims ${rule.id} (${pk}): «${v.match.slice(0, 50)}»`);
      }
    }
    const textAll = Object.entries(strings).filter(([k]) => k !== 'tierB.category.slugHint').map(([, v]) => v).join(' \n ');
    for (const p of scriptProblems(textAll, { script: l.script, code, hreflang: l.hreflang })) contentReasons.push(`script: ${p}`);
    if (!certRuleFor(code) && code !== 'en' && code !== 'ar') {
      warnings.push(`لا قاعدة اعتماد للغة ${code}${NO_CERT_RULE.includes(code) ? ' (مذكورة في المواصفة: تُكمَل قبل رفع WAVE_MAX إلى 2)' : ''}`);
    }
    const uniq = [...new Set(contentReasons)];
    if (code === 'en') {
      for (const r of uniq) warnings.push(`en (منشورة دائماً من المصدر) تخالف: ${r}`);
    } else {
      reasons.push(...uniq);
    }

    if (code === 'en' || uniq.length === 0) {
      published = true;
      contentHash = contentHashOf(strings);
      const prev = prevByCode.get(code);
      contentDate = prev && prev.contentHash === contentHash && prev.contentDate ? prev.contentDate : today;
      files.set(code, {
        _meta: { code, hreflang: l.hreflang, dir: l.dir, quality: code === 'en' ? null : quality, contentDate, contentHash, simulated },
        _derived: derived,
        strings,
      });
    } else {
      pages = [];
    }
  }

  locales.push({
    code, hreflang: l.hreflang, name: l.name, nativeName: l.nativeName, script: l.script, dir: l.dir,
    tier: l.tier, feasibility: l.feasibility, wave, legacy, markets: l.markets,
    ogLocale: ogLocaleOf(l), intlLocale: l.hreflang, slug,
    quality, complete, published, pages, reasons: [...new Set(reasons)], contentDate, contentHash,
  });
}

const anySimulated = SIMULATE.length > 0;
const factoryPath = FACTORY.split(path.sep).join('/');
const metaOf = (generatedAt) => ({
  waveMax: WAVE_MAX, foundingYear: FOUNDING_YEAR, generatedAt, factory: factoryPath,
  worldCountries: world.countries.length, simulated: anySimulated,
});
// generatedAt لا يتجدّد إن لم يتغيّر شيء غيره — لا فرق في الشجرة بلا سبب
const sameAsPrev = prevReg && JSON.stringify({ ...prevReg, meta: { ...prevReg.meta, generatedAt: '' } })
  === JSON.stringify({ meta: metaOf(''), locales });
const generatedAt = sameAsPrev ? prevReg.meta.generatedAt : today;
const registry = { meta: metaOf(generatedAt), locales };

const publishedReg = {
  waveMax: WAVE_MAX, generatedAt, simulated: anySimulated,
  locales: locales.filter((l) => l.published).map((l) => publishedEntry(l, files.get(l.code).strings['tierB.home.cta.whatsapp'])),
};
const pageCount = i18nPages(publishedReg).length;

// ─── الطباعة ────────────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
if (DRY || argv.includes('--verbose')) {
  console.log(`${pad('code', 9)}${pad('wave', 5)}${pad('quality', 20)}${pad('base/A', 8)}${pad('pub', 5)}reasons`);
  for (const l of locales) {
    console.log(`${pad(l.code, 9)}${pad(l.wave, 5)}${pad(l.quality ?? '—', 20)}${pad(`${l.complete.base ? '✓' : '✗'}/${l.complete.tierA ? '✓' : '✗'}`, 8)}${pad(l.published ? '✓' : '·', 5)}${l.reasons.slice(0, 3).join(' | ')}${l.reasons.length > 3 ? ` | …(+${l.reasons.length - 3})` : ''}`);
  }
}
const pub = locales.filter((l) => l.published);
const w1 = locales.filter((l) => l.wave <= WAVE_MAX && l.code !== 'ar');
console.log(`\nاستيراد الطبقة متعددة اللغات من ${factoryPath} (waveMax=${WAVE_MAX}${WAVE_ARG == null ? (prevReg?.meta?.waveMax != null ? ' موروثة من السجل الحالي — غيّرها بـ--wave-max' : ' افتراضية') : ''}${anySimulated ? `، ⚠️ محاكاة: ${SIMULATE.join(',')}` : ''}):`);
console.log(`  ${languages.length} لغة في المصنع · ${w1.length} في الموجات حتى ${WAVE_MAX} · منشورة ${pub.length}: ${pub.map((l) => l.code).join(' ') || '—'}`);
console.log(`  الصفحات المتوقعة: ${pageCount} (منها /languages/)`);
const held = w1.filter((l) => !l.published);
const byReason = new Map();
for (const l of held) {
  const r = (l.reasons[0] || '?').replace(/:.*$/, '');
  byReason.set(r, [...(byReason.get(r) || []), l.code]);
}
for (const [r, codes] of byReason) console.log(`  غير منشورة — ${r}: ${codes.join(' ')}`);
for (const l of held.filter((x) => x.reasons.some((r) => !/^review missing$|^wave /.test(r)))) {
  console.log(`    ${l.code}: ${l.reasons.slice(0, 6).join(' | ')}${l.reasons.length > 6 ? ` | …(+${l.reasons.length - 6})` : ''}`);
}
const faSlug = locales.find((l) => l.code === 'fa');
if (faSlug) console.log(`  slug الفارسية: ${faSlug.slug}`);
for (const w of [...new Set(warnings)]) console.warn(`  ⚠ ${w}`);

if (DRY) {
  console.log('\n(تشغيل جاف — لم يُكتب شيء)');
  process.exit(0);
}

// ─── الكتابة ────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(REG_DIR, { recursive: true });
fs.mkdirSync(MKT_DIR, { recursive: true });
const writeIfChanged = (f, obj) => {
  const s = JSON.stringify(obj, null, 1) + '\n';
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === s) return false;
  fs.writeFileSync(f, s);
  return true;
};
const changed = [];
if (writeIfChanged(LOCALES_FILE, registry)) changed.push('registry/locales.json');
if (writeIfChanged(PUBLISHED_FILE, publishedReg)) changed.push('registry/published.json');
for (const [code, file] of files) {
  if (code === 'ar') continue; // حارس إضافي: لا ملف عربي أبداً
  if (writeIfChanged(path.join(MKT_DIR, `${code}.json`), file)) changed.push(`marketing/${code}.json`);
}
// حذف ملفات اللغات التي لم تعد منشورة — تعديل في الشجرة يُلتزم لاحقاً، لا أمر git
const removed = [];
for (const f of fs.readdirSync(MKT_DIR).filter((x) => x.endsWith('.json'))) {
  const code = f.slice(0, -5);
  if (!files.has(code) || code === 'ar') { fs.unlinkSync(path.join(MKT_DIR, f)); removed.push(code); }
}

console.log(`\n  ✓ كُتب: ${changed.length ? changed.join('، ') : 'لا تغيير'}${removed.length ? ` · حُذف: ${removed.map((c) => `marketing/${c}.json`).join('، ')}` : ''}`);
if (anySimulated) console.log('  ⚠️ محاكاة — لا تُلتزم هذه المخرجات. أعِد المستورد بلا --simulate قبل أي التزام.');
console.log('  التالي: npm run seo:sitemap && npm run geo:llms — ثم تُلتزم المخرجات معاً بمسارات صريحة (src/i18n/registry وsrc/i18n/marketing والخرائط وllms).');
