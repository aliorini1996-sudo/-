/**
 * دليل محرّكات الذكاء لكل لغة جديدة منشورة: dist/<code>/llms.txt (spec-b §٩.٢) — في postbuild بعد prerender.
 *
 * لماذا في dist لا في public: محتواه من ملفات المستودع وحدها (src/i18n/marketing/<code>.json والسجل المنشور)،
 * فيُولَّد في كل بناء مطابقاً للصفحات المُصيَّرة، ولا يحتاج التزاماً ولا توسيع قائمة ملفات وركفلو الصيانة.
 * llms.txt الجذري (الإنجليزي) يبقى في public من gen-llms.mjs، ويشير إلى هذه الأدلة في قسم «Languages».
 * en وfr وtr وzh بلا ملف هنا: الجذري دليل الإنجليزية، والبقية خارج النطاق.
 *
 * المحتوى بلغة الصفحة حرفياً من ملف المحتوى (نصوص الرئيسية بعد استبدال العناصر النائبة عند الاستيراد)، والروابط
 * من مصادرها الواحدة: مسارات i18nPages، وعنوان كل صفحة H1 كما يصيّره القالب (renderI18nPage)، وquoteHref وmeetingHref.
 *
 * يتوقّف (exit 1) قبل كتابة أي ملف إن:
 *   - رابطٌ فيه لا صفحة مُصيَّرة له في dist (dist/<path>/index.html) — عدا نموذج «طلب عرض سعر» (quoteHref):
 *     /xx/subscribe-request/ مسار تطبيق لا يُصيَّر، كـ/signup/ في llms.txt الجذري؛
 *   - أدانته قواعد claims-rules.mjs (ما يطبّقه verify-claims على ملفات .txt: كل القواعد عدا نطاق head)؛
 *   - أو قواعد الطبقة في claims-i18n.mjs (اعتماد وشهادة بلغة الصفحة، سنة، سعر باقة حيّ، رقم ملاصق لعملة).
 * verify-claims وverify-i18n يفحصان الملفات نفسها بعدُ في dist.
 *
 * التشغيل: node scripts/gen-llms-i18n.mjs [--dist <مجلد>]   (الافتراضي dist/)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transformSync } from 'esbuild';
import { ORIGIN, i18nPages, canon, quoteHref, meetingHref, withCountryPages, countryOfPageKey } from '../src/i18n/i18nRoutes.mjs';
import { renderI18nPage, vatMapFrom } from '../src/i18n/marketingTemplate.mjs';
import { RULES, findViolation } from './claims-rules.mjs';
import { findI18nViolations, NO_CERT_RULE, I18N_RULE_WHY } from './claims-i18n.mjs';
import { loadPricing } from './pricing-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const distArg = argv.indexOf('--dist') >= 0 ? argv[argv.indexOf('--dist') + 1] : null;
const DIST = path.resolve(distArg || path.join(ROOT, 'dist'));

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
/** ما يطبّقه verify-claims على ملفات .txt (نطاق head للعنوان والوصف وH1 في HTML وحده) — كـTEXT_RULES في gen-llms */
const TEXT_RULES = RULES.filter((r) => r.scope !== 'head');

/** نصّ سطر واحد (لا أسطر داخل قيمة تكسر بنية Markdown) */
const line = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** نصّ رابط Markdown: أقواس مربعة مهروبة كي لا تكسر [النص](الرابط) */
const linkText = (s) => line(s).replace(/([[\]])/g, '\\$1');

/** ملف TS بلا استيرادات (countries.ts) كوحدة ESM في الذاكرة — كما في gen-llms */
async function loadTsModule(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const { code } = transformSync(src, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** ملف الصفحة المُصيَّرة لمسار مطلق بشرطة أخيرة */
const pageFile = (p) => path.join(DIST, ...p.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean), 'index.html');

async function main() {
  // ومعه صفحات الدول (country-pages.json) — روابطها في دليل لغتها كبقية صفحاتها
  const I18N = withCountryPages(readJson('src/i18n/registry/published.json'), readJson('src/i18n/registry/country-pages.json'));
  const pages = i18nPages(I18N);
  const targets = (I18N.locales || []).filter((l) => !l.legacy && pages.some((p) => p.code === l.code));
  if (!targets.length) {
    console.log('gen-llms-i18n: لا لغة جديدة منشورة — لا دليل لغة يُكتب (llms.txt الجذري وحده).');
    return;
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`✗ gen-llms-i18n: لا يوجد ${path.join(DIST, 'index.html')} — شغّله بعد vite build وprerender`);
    process.exit(1);
  }

  const world = readJson('src/i18n/world-countries.json');
  const vatByCode = vatMapFrom((await loadTsModule('src/i18n/countries.ts')).COUNTRIES);
  const pricing = await loadPricing();
  const livePrices = pricing.plans.map((p) => String(p.price ?? '').trim()).filter((p) => /^\d+$/.test(p));

  const out = [];
  const errors = [];
  for (const loc of targets) {
    const file = readJson(`src/i18n/marketing/${loc.code}.json`);
    const S = (k) => {
      const v = file.strings && file.strings[k];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`gen-llms-i18n: المفتاح «${k}» ناقص في محتوى ${loc.code}`);
      return line(v);
    };
    const own = pages.filter((p) => p.code === loc.code);
    // H1 كل صفحة كما يصيّره القالب نفسه (لا جدول مفاتيح ثانٍ هنا)
    const h1Of = (page) => {
      const cc = countryOfPageKey(page.pageKey);
      return renderI18nPage({
        page, reg: I18N, file, world: page.pageKey === 'countries' ? world : undefined, vatByCode,
        country: cc ? readJson(`src/content/country-pages/${cc}.json`) : undefined,
      }).h1;
    };

    const links = own.map((p) => ({ label: h1Of(p), href: canon(ORIGIN + p.path), path: p.path, form: false }));
    const quote = quoteHref(loc.code);
    const meeting = meetingHref(loc.code);
    links.push({ label: S('tierB.home.cta.quote'), href: `${ORIGIN}${quote}`, path: quote.split('?')[0], form: true });
    links.push({ label: S('tierB.home.cta.meeting'), href: `${ORIGIN}${meeting}`, path: meeting, form: false });

    const text = [
      '# FieldSales',
      '',
      `> ${S('tierB.home.definition')}`,
      '',
      S('tierB.home.uiLanguagesNote'),
      '',
      `## ${S('tierB.home.h1')}`,
      '',
      ...[0, 1, 2, 3, 4, 5].map((i) => `- ${S(`tierB.home.capabilities.${i}.title`)}: ${S(`tierB.home.capabilities.${i}.line`)}`),
      '',
      ...[0, 1, 2, 3, 4, 5].flatMap((i) => [`## ${S(`tierB.home.faq.${i}.q`)}`, '', S(`tierB.home.faq.${i}.a`), '']),
      '## fieldsa.net',
      '',
      ...links.map((l) => `- [${linkText(l.label)}](${l.href})`),
      '',
    ].join('\n');

    // كل رابط صفحة مُصيَّرة — عدا نموذج طلب العرض (مسار تطبيق، انظر رأس الملف)
    for (const l of links) {
      if (!l.form && !fs.existsSync(pageFile(l.path))) errors.push(`${loc.code}: رابط بلا صفحة مُصيَّرة في dist — ${l.path}`);
    }
    // حارس الادّعاءات العامّ كما يطبّقه verify-claims على هذا الملف نفسه في dist: نطاق المسار (paths/exceptPaths)،
    // والقاعدة التحذيرية تحذير. نصّ الدليل كله من المستودع، فلا إسناد إلى CMS (cmsWarn حاجبة هنا).
    const rel = `${loc.code}/llms.txt`;
    for (const r of TEXT_RULES) {
      if (r.paths && !r.paths.test(rel)) continue;
      if (r.exceptPaths && r.exceptPaths.test(rel)) continue;
      const v = findViolation(r, text);
      if (!v) continue;
      if (r.severity === 'warn') console.warn(`  ⚠ ${rel}: [${r.id}] «${v.match.slice(0, 80)}» (تحذير غير حاجب)`);
      else errors.push(`${loc.code}: [${r.id}] «${v.match.slice(0, 80)}»`);
    }
    for (const v of findI18nViolations(text, { code: loc.code, livePrices })) {
      errors.push(`${loc.code}: [${v.id}] «${v.match}» — ${v.why || I18N_RULE_WHY[v.id] || ''}`);
    }
    if (NO_CERT_RULE.includes(loc.code)) console.warn(`  ⚠ لا قاعدة اعتماد للغة ${loc.code} — تُكمَل في claims-i18n.mjs قبل رفع WAVE_MAX إلى 2`);
    out.push({ code: loc.code, text, links: links.length });
  }

  if (errors.length) {
    console.error(`✗ gen-llms-i18n: ${errors.length} خلل — لم يُكتب أي دليل لغة:`);
    for (const e of errors.slice(0, 30)) console.error(`    ${e}`);
    process.exit(1);
  }
  for (const o of out) {
    fs.mkdirSync(path.join(DIST, o.code), { recursive: true });
    fs.writeFileSync(path.join(DIST, o.code, 'llms.txt'), o.text, 'utf8');
  }
  console.log(`✅ gen-llms-i18n: ${out.length} دليل لغة في dist (${out.map((o) => `${o.code}/llms.txt`).join('، ')})${I18N.simulated ? ' — ⚠️ سجل محاكاة: لا يُلتزم' : ''}`);
}

main().catch((e) => { console.error('✗ gen-llms-i18n:', e?.stack || e); process.exit(1); });
