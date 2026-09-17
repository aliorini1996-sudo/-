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
import { RULES, findViolation } from './claims-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');

/** ملفات مستثناة بسبب موثّق (لا استثناء بلا سبب) */
const ALLOW = [
  // صفحة المطاعم: ادّعاء ZATCA م٢/ETA معلّق بقرار المالك (يُعالَج خارج هذا المسار)
  { match: /[\/]restaurant[\/]/i, why: 'عمودية المطاعم — بقرار المالك' },
];

// القواعد وأسبابها واستثناءاتها: scripts/claims-rules.mjs
// ⚠️ الأنماط تُطبَّق على النصّ المرئي المستخرج لا على HTML الخام قدر الإمكان،
//    لتفادي مطابقة أسماء أصناف CSS أو مسارات ملفات.

// ⚠️ ثغرة مُكتشفة (4 أغسطس 2026): تجريد <script> كان يُخفي JSON-LD عن قواعد النصّ،
// فعاش ادّعاء «Phase 2» الكاذب في FAQPage بـindex.html غير مكشوف — وهو ما يقرؤه جوجل
// تحديداً. الحلّ: نصّ JSON-LD يُستخرَج ويُلحَق بالنصّ المرئي قبل الفحص.
const ldJsonText = (h) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1].replace(/["{}\[\],]/g, ' '))
  .join(' ');
const stripHtml = (h) => (h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ') + ' ' + ldJsonText(h))
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

const files = collect(DIST);
const hits = new Map(); // ruleId → [{file, sample}]
const counts = new Map(); // ruleId → عدد الملفات
let skipped = 0;

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
    // كل المطابقات تُفحص (لا الأولى وحدها) مع نافذة النفي/الموعد — انظر findViolation
    const v = findViolation(rule, haystack);
    if (!v) continue;
    if (!hits.has(rule.id)) hits.set(rule.id, []);
    counts.set(rule.id, (counts.get(rule.id) || 0) + 1);
    const list = hits.get(rule.id);
    if (list.length < 3) list.push({ file: rel, sample: v.match.slice(0, 60) });
  }
}

console.log(`فحص الادّعاءات على ${files.length} ملف مُصيَّر (مستثنى: ${skipped}).`);

const blocking = [...hits.keys()].filter((id) => RULES.find((r) => r.id === id).severity !== 'warn');
const warnings = [...hits.keys()].filter((id) => RULES.find((r) => r.id === id).severity === 'warn');

for (const id of warnings) {
  const rule = RULES.find((r) => r.id === id);
  console.warn(`\n  ⚠ تحذير غير حاجب [${id}] ${rule.why} — ${counts.get(id)} ملف`);
  for (const h of hits.get(id)) console.warn(`      ${h.file} — «${h.sample}»`);
}

if (!blocking.length) {
  console.log(warnings.length ? '  ✓ لا ادّعاء محظوراً حاجباً في المخرجات (راجع التحذيرات أعلاه).' : '  ✓ لا ادّعاء محظور في المخرجات.');
  process.exit(0);
}

for (const id of blocking) {
  const rule = RULES.find((r) => r.id === id);
  console.error(`\n  ✗ [${id}] ${rule.why}`);
  for (const h of hits.get(id)) console.error(`      ${h.file} — «${h.sample}»`);
}
console.error(`\n✗ فحص الادّعاءات فشل (${blocking.length} قاعدة).`);
process.exit(1);
