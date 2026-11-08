/**
 * قائمة دول العالم لصفحة «الدول» في الطبقة متعددة اللغات — src/i18n/world-countries.json (spec-b §٢.١).
 *
 * يُشغَّل **يدوياً** (npm run i18n:countries) ويحتاج شبكة إلى jsDelivr، ويُلتزم ناتجه. لا يدخل البناء:
 * Render لا يجلب شيئاً أثناء البناء لهذه الصفحة، والقائمة ثابتة بين الإصدارات.
 *
 * المصدر: Unicode CLDR بإصدار **مثبت** (cldr-core@48.2.0) — 47 ما زال يقول عملة بلغاريا BGN، و48.2 يعرف
 * EUR منذ 2026-01-01، فتطابق عملاته سجلّ الدول (src/i18n/countries.ts) في دوله كلها.
 *
 * قائمة ISO 3166-1 تُشتق آلياً ثم يُتحقّق منها:
 *  1) الرموز الحرفية الثنائية في codeMappings التي لها _numeric أقل من 900؛
 *  2) بلا المحجوزة للمستخدم: AA وQM–QZ وXA–XZ وZZ؛
 *  3) بلا الملغاة: AN BU CS DD FX NT SU TP YD YU ZR؛
 *  4) الناتج 249 بالضبط وإلا يتوقف السكربت؛
 *  5) لكل رمز اسم إنجليزي من Intl.DisplayNames غير الرمز نفسه.
 * كوسوفو (XK) ليست رمز ISO فهي خارجها — سؤال مفتوح للمالك؛ إضافتها: EXTRA أدناه.
 *
 * العملة: كل عملة في currencyData.region[code] شرطها _from ≤ AS_OF، وغياب _to أو _to > AS_OF،
 * و_tender !== "false"؛ بترتيب CLDR (PA ⇒ ["PAB","USD"] · AQ ⇒ []). AS_OF تاريخ التوليد.
 *
 * التشغيل: node scripts/build-world-countries.mjs [--as-of YYYY-MM-DD] [--cldr-dir <مجلد فيه الملفان>] [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src/i18n/world-countries.json');

const CLDR_VERSION = '48.2.0';
const BASE = `https://cdn.jsdelivr.net/npm/cldr-core@${CLDR_VERSION}/supplemental`;
const EXPECTED = 249;
const DEPRECATED = ['AN', 'BU', 'CS', 'DD', 'FX', 'NT', 'SU', 'TP', 'YD', 'YU', 'ZR'];
/** رموز تُضاف خارج ISO بقرار المالك (مثل 'XK' لكوسوفو) — فارغة اليوم */
const EXTRA = [];

const argv = process.argv.slice(2);
const arg = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
const AS_OF = arg('--as-of') || new Date().toISOString().slice(0, 10);
const CLDR_DIR = arg('--cldr-dir');
const DRY = argv.includes('--dry-run');

if (!/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) {
  console.error(`✗ --as-of يجب أن يكون YYYY-MM-DD (وصل «${AS_OF}»)`);
  process.exit(1);
}

async function load(name) {
  if (CLDR_DIR) return JSON.parse(fs.readFileSync(path.resolve(CLDR_DIR, name), 'utf8'));
  const url = `${BASE}/${name}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url} ⇒ HTTP ${r.status}`);
  return r.json();
}

const isUserAssigned = (c) => c === 'AA' || c === 'ZZ' || /^Q[M-Z]$/.test(c) || /^X[A-Z]$/.test(c);

let codeMappings;
let currencyData;
try {
  codeMappings = (await load('codeMappings.json')).supplemental.codeMappings;
  currencyData = (await load('currencyData.json')).supplemental.currencyData;
} catch (e) {
  console.error(`✗ تعذّر جلب CLDR ${CLDR_VERSION}: ${e.message}`);
  console.error('  السكربت يحتاج شبكة إلى cdn.jsdelivr.net، أو --cldr-dir بنسختين محلّيتين من الملفين.');
  process.exit(1);
}

const codes = Object.keys(codeMappings)
  .filter((c) => /^[A-Z]{2}$/.test(c))
  .filter((c) => codeMappings[c]._numeric && Number(codeMappings[c]._numeric) < 900)
  .filter((c) => !isUserAssigned(c))
  .filter((c) => !DEPRECATED.includes(c))
  .sort();

const errors = [];
if (codes.length !== EXPECTED) errors.push(`عدد الدول ${codes.length} لا ${EXPECTED} — راجع قاعدة الاشتقاق قبل أي التزام`);

const allCodes = [...codes, ...EXTRA.filter((c) => !codes.includes(c))].sort();
const enNames = new Intl.DisplayNames(['en'], { type: 'region' });
for (const c of allCodes) {
  const n = enNames.of(c);
  if (!n || n === c) errors.push(`لا اسم إنجليزياً للرمز ${c} في Intl.DisplayNames`);
}

const currenciesOf = (code) => {
  const list = currencyData.region[code] || [];
  const out = [];
  for (const entry of list) {
    for (const [cur, info] of Object.entries(entry)) {
      if (info._tender === 'false') continue;
      if (info._from && info._from > AS_OF) continue;
      if (info._to && !(info._to > AS_OF)) continue;
      if (!out.includes(cur)) out.push(cur);
    }
  }
  return out;
};

const countries = allCodes.map((c) => ({
  code: c,
  alpha3: codeMappings[c]?._alpha3 || '',
  numeric: codeMappings[c]?._numeric || '',
  currencies: currenciesOf(c),
}));

// مقارنة بسجلّ الدول في المنصة (تحذير لا يوقف): عملة كل دولة مسجّلة يجب أن تكون بين عملات CLDR الحيّة
const regWarnings = [];
try {
  const { transformSync } = await import('esbuild');
  const src = fs.readFileSync(path.join(ROOT, 'src/i18n/countries.ts'), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || ROOT;
  const tmp = path.join(tmpDir, `_world_countries_reg_${process.pid}.mjs`);
  fs.writeFileSync(tmp, code);
  try {
    const { COUNTRIES } = await import(pathToFileURL(tmp).href);
    for (const [k, v] of Object.entries(COUNTRIES)) {
      if (k === 'XX') continue;
      const row = countries.find((r) => r.code === k);
      if (!row) regWarnings.push(`${k} في السجل وليس في القائمة`);
      else if (!row.currencies.includes(v.currency)) regWarnings.push(`${k}: السجل ${v.currency} وCLDR ${row.currencies.join('/') || '—'}`);
    }
  } finally { fs.unlinkSync(tmp); }
} catch (e) {
  regWarnings.push(`تعذّرت مقارنة السجل: ${e.message}`);
}

if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`✗ لم يُكتب ${path.relative(ROOT, OUT)}.`);
  process.exit(1);
}

const out = {
  meta: {
    source: `unicode-org/cldr-json cldr-core@${CLDR_VERSION} (codeMappings, currencyData)`,
    asOf: AS_OF,
    count: countries.length,
    excludedDeprecated: DEPRECATED,
    ...(EXTRA.length ? { extra: EXTRA } : {}),
  },
  countries,
};

console.log(`قائمة الدول: ${countries.length} دولة من CLDR ${CLDR_VERSION} بتاريخ ${AS_OF}.`);
console.log(`  بلا عملة سارية: ${countries.filter((r) => !r.currencies.length).map((r) => r.code).join(' ') || '—'}`);
console.log(`  بأكثر من عملة: ${countries.filter((r) => r.currencies.length > 1).length}`);
if (regWarnings.length) for (const w of regWarnings) console.warn(`  ⚠ ${w}`);
else console.log('  ✓ عملات سجل الدول (countries.ts) كلها بين عملات CLDR السارية.');

if (DRY) {
  console.log('  (تشغيل جاف — لم يُكتب شيء)');
} else {
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`  ✓ كُتب ${path.relative(ROOT, OUT)}`);
}
