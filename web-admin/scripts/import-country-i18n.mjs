/**
 * مستورد صفحات الدول للطبقة متعددة اللغات (نوع «country») — يدويّ فقط، كـimport-i18n.mjs (Render لا يرى قرص المصنع).
 *
 *   node scripts/import-country-i18n.mjs --from D:/claude-work [--dry-run]
 *
 * 1) ينسخ **حرفياً** (بايتاً ببايت، بلا تحرير) لكل دولة في COUNTRY_TARGETS:
 *      <from>/country-facts/<CC>.json ⇒ src/content/country-facts/<CC>.json   إن اكتمل تدقيقها (audit)
 *      <from>/country-pages/<CC>.json ⇒ src/content/country-pages/<CC>.json   إن أجازتها المراجعة (publish | publish-with-notes)
 *    ونسخةٌ في المستودع لم يعد مصدرها صالحاً تُحذف (تعديل في الشجرة يُلتزم، لا أمر git).
 * 2) يشتقّ الفهرس من نسخ المستودع (deriveCountryIndex في country-i18n.mjs — الحارس يعيد الاشتقاق نفسه) ويكتب
 *    src/i18n/registry/country-pages.json، ويطبع ما نُشر وما استُثني وسببه.
 * بعده: npm run seo:sitemap — ثم تُلتزم المخرجات معاً بمسارات صريحة.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withCountryPages, i18nPages } from '../src/i18n/i18nRoutes.mjs';
import {
  COUNTRY_TARGETS, COUNTRY_PAGES_DIR, COUNTRY_FACTS_DIR, COUNTRY_INDEX_FILE, COUNTRY_QUALITY_OK,
  deriveCountryIndex, factsAudited, reviewQuality,
} from './country-i18n.mjs';
import { loadPricing } from './pricing-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : null);
const DRY = argv.includes('--dry-run');
const FROM = argOf('--from');
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
if (!FROM) die('يلزم --from <مجلد فيه country-facts وcountry-pages> (مثال: --from D:/claude-work)');
const SRC = path.resolve(FROM);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tryJson = (f) => { try { return fs.existsSync(f) ? readJson(f) : null; } catch { return null; } };

const copies = [];
const removals = [];
for (const cc of Object.keys(COUNTRY_TARGETS)) {
  const pairs = [
    { from: path.join(SRC, 'country-facts', `${cc}.json`), to: path.join(ROOT, COUNTRY_FACTS_DIR, `${cc}.json`), ok: (j) => factsAudited(j), why: 'التدقيق لم يكتمل (audit)' },
    { from: path.join(SRC, 'country-pages', `${cc}.json`), to: path.join(ROOT, COUNTRY_PAGES_DIR, `${cc}.json`), ok: (j) => COUNTRY_QUALITY_OK.includes(reviewQuality(j)), why: 'المراجعة لم تُجزه' },
  ];
  for (const p of pairs) {
    const j = tryJson(p.from);
    if (j && p.ok(j)) {
      const same = fs.existsSync(p.to) && Buffer.compare(fs.readFileSync(p.to), fs.readFileSync(p.from)) === 0;
      if (!same) copies.push(p);
    } else if (fs.existsSync(p.to)) {
      removals.push({ ...p, why: j ? p.why : 'المصدر غائب أو تالف' });
    }
  }
}

if (!DRY) {
  for (const p of copies) { fs.mkdirSync(path.dirname(p.to), { recursive: true }); fs.copyFileSync(p.from, p.to); }
  for (const p of removals) fs.unlinkSync(p.to);
}

const published = readJson(path.join(ROOT, 'src/i18n/registry/published.json'));
const registry = readJson(path.join(ROOT, 'src/i18n/registry/locales.json'));
const pricing = await loadPricing();
const livePrices = pricing.plans.map((p) => String(p.price)).filter((p) => /^\d+$/.test(p));
const index = DRY && copies.length + removals.length
  ? null
  : deriveCountryIndex({ root: ROOT, published, registry, livePrices });

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
console.log(`استيراد صفحات الدول من ${SRC.split(path.sep).join('/')}:`);
for (const p of copies) console.log(`  نسخ حرفي ← ${rel(p.to)}`);
for (const p of removals) console.log(`  حذف ${rel(p.to)} (${p.why})`);
if (!index) {
  console.log('\n(تشغيل جاف — لم يُكتب شيء؛ الفهرس يُشتق بعد النسخ)');
  process.exit(0);
}
const reg = withCountryPages(published, index);
for (const e of index.pages) {
  const page = i18nPages(reg).find((p) => p.pageKey === `country:${e.cc}` && p.code === e.code);
  console.log(`  ✓ ${e.cc} (${e.code}) ← ${page ? page.path : `/${e.code}/${e.slug}/ (غير مُدرجة: لغتها بلا صفحة دول)`}`);
}
for (const x of index.excluded) console.log(`  ✗ ${x.cc} (${x.code}) مستثناة: ${x.reasons.slice(0, 6).join(' | ')}${x.reasons.length > 6 ? ` | …(+${x.reasons.length - 6})` : ''}`);
if (DRY) { console.log('\n(تشغيل جاف — لم يُكتب شيء)'); process.exit(0); }
const out = path.join(ROOT, COUNTRY_INDEX_FILE);
const text = JSON.stringify(index, null, 1) + '\n';
if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) {
  fs.writeFileSync(out, text);
  console.log(`\n  ✓ كُتب ${COUNTRY_INDEX_FILE}`);
} else {
  console.log(`\n  ${COUNTRY_INDEX_FILE}: لا تغيير`);
}
console.log('  التالي: npm run seo:sitemap ثم البناء — وتُلتزم المخرجات معاً بمسارات صريحة.');
