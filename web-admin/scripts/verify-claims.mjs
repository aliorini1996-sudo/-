/**
 * حارس الادّعاءات — يفحص **مخرجات dist/** لا الشيفرة المصدرية.
 *
 * الادّعاء الكاذب في هذا السوق ليس خطأ تسويقياً بل تعرّض تنظيمي وقانوني:
 * هيئة الزكاة والضريبة والجمارك تنصّ صراحةً أنها **لا تعتمد ولا تصادق** مزوّدي
 * البرمجيات؛ فادّعاء الاعتماد أو ادّعاء مرحلة امتثال غير مبنية يُقاس على
 * المنافسة غير المشروعة. والمراجعة البشرية تنسى؛ الحارس لا ينسى.
 *
 * كل قاعدة هنا مبرَّرة بحقيقة عن المنتج وقت الكتابة:
 *  - المبنيّ فعلاً: الفوترة الإلكترونية المرحلة الأولى (TLV/QR) + ربط المرحلة الثانية مع منصة فاتورة (مفعّل بعد اكتمال التفعيل الفعلي بقرار المالك).
 *  - غير المبنيّ: ETA مصر (stub).
 *  - الممنوع ولو بعد التفعيل: «معتمد/مصادق/مرخّص من الهيئة» · «شريك رسمي للهيئة» · أي موعد أو رقم مقرون بالمرحلة الثانية.
 *  - لا عملاء مرجعيون ولا SOC2/ISO ⇒ لا رقم ولا شهادة تُذكر.
 *  - تطبيق Play في الاختبار المغلق ويُرجع 404 ⇒ لا رابط متجر.
 *  - لا اشتراك ذاتي داخل المنتج ⇒ لا نداء «اشترك الآن».
 *
 * القواعد نفسها في scripts/claims-rules.mjs ويختبرها src/content/claimsGuard.test.ts.
 *
 * التشغيل: node scripts/verify-claims.mjs   (بعد البناء)
 * التجاوز المؤقّت لملف مُراجَع: أضِف مساره إلى ALLOW أدناه بسبب مكتوب.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RULES, findViolation, findViolations, PHASE2_CMS_CLEANED, cmsCorpus, fromCms } from './claims-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const CMS_API = 'https://api.fieldsa.net/api/site-content';
const STALE_ID = 'zatca-phase2-stale-denial';

/**
 * ملفات مستثناة بسبب موثّق (لا استثناء بلا سبب).
 * ⚠️ رُفع استثناء /restaurant/: وحدة المطاعم أُزيلت من المنصة كاملةً (317260f) فلا صفحة تحته،
 * وكان يُعفي كل القواعد — فأي صفحة تعود تحته كانت ستمرّ بادّعاء ETA مصر (stub غير مبني) أو اعتماد دون فحص.
 */
const ALLOW = [];

// القواعد وأسبابها واستثناءاتها: scripts/claims-rules.mjs
// ⚠️ الأنماط تُطبَّق على النصّ المرئي المستخرج لا على HTML الخام قدر الإمكان،
//    لتفادي مطابقة أسماء أصناف CSS أو مسارات ملفات.

// ⚠️ ثغرة مُكتشفة (4 أغسطس 2026): تجريد <script> كان يُخفي JSON-LD عن قواعد النصّ،
// فعاش ادّعاء «Phase 2» الكاذب في FAQPage بـindex.html غير مكشوف — وهو ما يقرؤه جوجل
// تحديداً. الحلّ: نصّ JSON-LD يُستخرَج ويُلحَق بالنصّ المرئي قبل الفحص.
// ⚠️ وسوم JSON-LD تحمل سمات إضافية (`data-seo-page="1"` في صفحات prerender)، فالنمط الحرفي
// `<script type="application/ld+json">` كان يُفوّت وصف المقال في كتلة Article.
const ldJsonText = (h) => [...h.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1].replace(/["{}\[\],]/g, ' '))
  .join(' ');
const decodeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// ⚠️ تجريد الوسوم يحذف سمات content، فوصف meta وog/twitter — أول ما يظهر في نتائج البحث
// وبطاقة المشاركة — لم يكن يمرّ بقاعدتي الاعتماد والموعد. يُلحَق نصّه بالنصّ المرئي.
const metaText = (h) => [...h.matchAll(/<meta\b[^>]*>/gi)]
  .map((m) => m[0])
  .filter((tag) => /\b(?:name|property)="(?:description|og:description|twitter:description|og:title|twitter:title)"/i.test(tag))
  .map((tag) => decodeAttr((tag.match(/\bcontent="([^"]*)"/i) || [])[1] || ''))
  .join(' . ');
const stripHtml = (h) => (h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ') + ' . ' + ldJsonText(h) + ' . ' + metaText(h))
  .replace(/\s+/g, ' ');

function collect(dir, out = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out, depth + 1);
    else if (/\.(html|txt)$/i.test(e.name)) out.push(p);
  }
  return out;
}

if (!fs.existsSync(DIST)) {
  console.error('✗ لا يوجد dist/ — شغّل npm run build أولاً');
  process.exit(1);
}

// إسناد النفي القديم لمصدره (claims-rules.mjs: cmsCorpus/fromCms): نصوص CMS الحيّة تُجلب هنا كما جلبها
// prerender وgen-llms قبل ثوانٍ. تعذّر الجلب ⇒ لا إسناد، فيبقى النفي كله تحذيراً في هذا البناء وحده
// (ومصادر المستودع يحرسها claimsGuard.test.ts في web-ci على أي حال) — لا يُفشَل بناءٌ لعطل شبكة.
let corpus = null;
if (!PHASE2_CMS_CLEANED) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(CMS_API, { signal: ctrl.signal });
    clearTimeout(t);
    const data = (await r.json())?.data;
    if (data && typeof data === 'object') corpus = cmsCorpus(data);
  } catch { /* لا إسناد — انظر أعلاه */ }
}

const files = collect(DIST);
const hits = new Map(); // `${level}:${ruleId}` → [{file, sample}]
const counts = new Map(); // `${level}:${ruleId}` → عدد الملفات
let skipped = 0;
const record = (level, id, file, v) => {
  const key = `${level}:${id}`;
  if (!hits.has(key)) hits.set(key, []);
  counts.set(key, (counts.get(key) || 0) + 1);
  const list = hits.get(key);
  if (list.length < 3) list.push({ file, sample: v.match.slice(0, 60) });
};

for (const f of files) {
  const rel = path.relative(DIST, f);
  if (ALLOW.some((a) => a.match.test(rel))) { skipped++; continue; }
  const raw = fs.readFileSync(f, 'utf8');
  const text = /\.html$/i.test(f) ? stripHtml(raw) : raw;
  // نطاق «الرأس»: العنوان والوصف وH1 — ما يُبنى عليه الاستهداف فعلاً
  const head = [
    (raw.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '',
    (raw.match(/<meta name="description" content="([^"]*)"/i) || [])[1] || '',
    (raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '',
  ].join(' ').replace(/<[^>]+>/g, ' ');

  for (const rule of RULES) {
    const haystack = rule.scope === 'head' ? head : rule.scope === 'raw' ? raw : text;
    if (rule.id === STALE_ID && rule.severity === 'warn') {
      // قبل قلب العلم: مطابقة يوجد نصّها في CMS ⇒ تحذير (بند §٨ عند المالك)، وغيرها ⇒ حاجب (نصّ مستودع)
      const all = findViolations(rule, haystack);
      const repo = corpus ? all.find((v) => !fromCms(v.match, corpus)) : null;
      const cms = all.find((v) => !corpus || fromCms(v.match, corpus));
      if (repo) record('block', rule.id, rel, repo);
      if (cms) record('warn', rule.id, rel, cms);
      continue;
    }
    // كل المطابقات تُفحص (لا الأولى وحدها) مع نافذة النفي/الموعد — انظر findViolation
    const v = findViolation(rule, haystack);
    if (v) record(rule.severity === 'warn' ? 'warn' : 'block', rule.id, rel, v);
  }
}

console.log(`فحص الادّعاءات على ${files.length} ملف مُصيَّر (مستثنى: ${skipped}).`);
if (!PHASE2_CMS_CLEANED) {
  console.log(corpus
    ? `  إسناد النفي القديم: CMS الحيّ مجلوب — نصوص المستودع حاجبة، ونصوص CMS تحذير حتى PHASE2_CMS_CLEANED.`
    : `  ⚠ تعذّر جلب CMS: لا إسناد في هذا البناء — النفي القديم كله تحذير (مصادر المستودع يحرسها claimsGuard.test.ts).`);
}

const keysOf = (level) => [...hits.keys()].filter((k) => k.startsWith(`${level}:`));
const blocking = keysOf('block');
const warnings = keysOf('warn');
const label = (key) => {
  const id = key.slice(key.indexOf(':') + 1);
  const src = id === STALE_ID && !PHASE2_CMS_CLEANED ? (key.startsWith('warn:') ? (corpus ? ' (نصّ CMS)' : ' (بلا إسناد)') : ' (نصّ المستودع)') : '';
  return { id, src, why: RULES.find((r) => r.id === id).why };
};

for (const key of warnings) {
  const { id, src, why } = label(key);
  console.warn(`\n  ⚠ تحذير غير حاجب [${id}]${src} ${why} — ${counts.get(key)} ملف`);
  for (const h of hits.get(key)) console.warn(`      ${h.file} — «${h.sample}»`);
}

if (!blocking.length) {
  console.log(warnings.length ? '  ✓ لا ادّعاء محظوراً حاجباً في المخرجات (راجع التحذيرات أعلاه).' : '  ✓ لا ادّعاء محظور في المخرجات.');
  process.exit(0);
}

for (const key of blocking) {
  const { id, src, why } = label(key);
  console.error(`\n  ✗ [${id}]${src} ${why} — ${counts.get(key)} ملف`);
  for (const h of hits.get(key)) console.error(`      ${h.file} — «${h.sample}»`);
}
console.error(`\n✗ فحص الادّعاءات فشل (${blocking.length} قاعدة).`);
process.exit(1);
