/**
 * حارس الادّعاءات — يفحص **مخرجات dist/** لا الشيفرة المصدرية.
 *
 * الادّعاء الكاذب في هذا السوق ليس خطأ تسويقياً بل تعرّض تنظيمي وقانوني:
 * هيئة الزكاة والضريبة والجمارك تنصّ صراحةً أنها **لا تعتمد ولا تصادق** مزوّدي
 * البرمجيات؛ فادّعاء الاعتماد أو ادّعاء مرحلة امتثال غير مبنية يُقاس على
 * المنافسة غير المشروعة. والمراجعة البشرية تنسى؛ الحارس لا ينسى.
 *
 * كل قاعدة هنا مبرَّرة بحقيقة عن المنتج وقت الكتابة:
 *  - المبنيّ فعلاً: الفوترة الإلكترونية **المرحلة الأولى** (TLV/QR).
 *  - غير المبنيّ: المرحلة الثانية (الربط والتكامل) · ETA مصر (stub).
 *  - لا عملاء مرجعيون ولا SOC2/ISO ⇒ لا رقم ولا شهادة تُذكر.
 *  - تطبيق Play في الاختبار المغلق ويُرجع 404 ⇒ لا رابط متجر.
 *  - لا اشتراك ذاتي داخل المنتج ⇒ لا نداء «اشترك الآن».
 *
 * التشغيل: node scripts/verify-claims.mjs   (بعد البناء)
 * التجاوز المؤقّت لملف مُراجَع: أضِف مساره إلى ALLOW أدناه بسبب مكتوب.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');

/** ملفات مستثناة بسبب موثّق (لا استثناء بلا سبب) */
const ALLOW = [
  // صفحة المطاعم: ادّعاء ZATCA م٢/ETA معلّق بقرار المالك (يُعالَج خارج هذا المسار)
  { match: /[\\/]restaurant[\\/]/i, why: 'عمودية المطاعم — بقرار المالك' },
];

/**
 * القواعد. كل قاعدة: نمط + سبب + استثناء اختياري يمنع الإنذار الكاذب.
 * ⚠️ الأنماط تُطبَّق على النصّ المرئي المستخرج لا على HTML الخام قدر الإمكان،
 *    لتفادي مطابقة أسماء أصناف CSS أو مسارات ملفات.
 */
/**
 * ⚠️ الفارق الحاكم: **ادّعاء دعم** ممنوع، و**الذكر التعليمي** مشروع بل مطلوب.
 * مقال يشرح لائحة المرحلة الثانية أو نظام ETA المصري محتوى نافع؛ أمّا «ندعم
 * المرحلة الثانية» فادّعاء كاذب. لذا تُطابَق أفعال الدعم بالعربية والإنجليزية
 * على مقربة من المصطلح، لا المصطلح وحده — وإلا صرخ الحارس على محتوانا الصحيح
 * فعُطّل، وهو أسوأ من غيابه.
 */
const SUPPORT_VERB = '(?:ندعم|يدعم|تدعم|مدعوم|متوافق|متوافقة|نوفّر|يوفّر|جاهز(?:ون)?\\s*لـ?|نلتزم|مُفعّل|we\\s+support|supports?|compliant\\s+with|ready\\s+for|enabled)';
const near = (term) => new RegExp(`(${SUPPORT_VERB}[^.،؛\\n]{0,60}${term})|(${term}[^.،؛\\n]{0,60}${SUPPORT_VERB})`, 'i');

const RULES = [
  {
    id: 'zatca-approved',
    re: /(معتمد|مُعتمد|مصادق|مُصادق|مرخّص|مرخص)\s*(من)?\s*(هيئة\s*)?(الزكاة|ZATCA)/i,
    unless: /(لا\s*تعتمد|لا\s*تصادق|does\s*not\s*(certify|approve)|لا\s*ندّعي)/i,
    why: 'ZATCA تنصّ صراحةً أنها لا تعتمد ولا تصادق مزوّدي البرمجيات',
  },
  {
    id: 'zatca-phase2-claim',
    re: near('(?:المرحلة\\s*الثانية|Phase\\s*2)'),
    unless: /(غير\s*(مبني|متاح|مبنيّة|متاحة)|not\s*built|لم\s*(نبنِها|تُبنَ)|لا\s*ندعم|do\s*not\s*support)/i,
    why: 'ادّعاء دعم المرحلة الثانية — غير مبنية لدينا (الذكر التعليمي مسموح)',
  },
  {
    id: 'eta-egypt-claim',
    re: near('(?:\\bETA\\b|منظومة\\s*الفاتورة\\s*الإلكترونية\\s*المصرية)'),
    unless: /(غير\s*(مبني|متاح|مدعوم)|not\s*(built|implemented|supported))/i,
    why: 'ادّعاء دعم ETA مصر — stub not_implemented (شرح اللائحة مسموح)',
  },
  {
    id: 'fake-certification',
    re: /\b(SOC\s*2|SOC2|ISO\s*27001|ISO\s*9001)\b/i,
    // النفي الصريح مشروع: «ليست لدينا شهادات SOC2 أو ISO» جزء من صندوق الإنصاف
    unless: /(ليست?\s*لدينا|لا\s*نملك|بلا\s*شهاد|we\s*(hold|have)\s*no|no\s*SOC|not\s*certified)/i,
    why: 'ادّعاء شهادة لا نملكها',
  },
  {
    id: 'subscribe-now',
    re: /(اشترك\s*الآن|اشتراك\s*فوري|ادفع\s*الآن|Subscribe\s*now|Buy\s*now)/i,
    why: 'لا اشتراك ذاتي ولا بوابة دفع — كل نداء فعل ينتهي بمحادثة أو تجربة',
  },
  {
    id: 'play-store-link',
    re: /play\.google\.com\/store\/apps/i,
    scope: 'raw', // الرابط يعيش في href لا في النصّ المرئي — كشفه اختبار سلبي
    why: 'التطبيق في الاختبار المغلق ويُرجع 404 — الربط به يرسل الزائر لصفحة معطّلة',
  },
  {
    id: 'dead-keyword-targeting',
    // القيد على **الاستهداف** لا على ذكر المصطلح في المتن: مقال يشرح الفرق بين
    // «كاش فان» و«بري سيلز» محتوى صناعي مشروع؛ أمّا بناء عنوان/وصف صفحة على
    // صياغة نتائجها ملوّثة (van seals · كاش باك · دفتر الفيزياء) فإهدار زحف.
    re: /(فان\s*سيلز|بديل\s*دفترة)/i,
    scope: 'head', // العنوان والوصف فقط
    why: 'صياغة ميتة/ملوّثة في عنوان أو وصف الصفحة — نتائج البحث عليها لغير مجالنا',
  },
  {
    id: 'unverified-social-proof',
    // «أكثر من N شركة/عميل يثقون» — لا عملاء مرجعيين بعد
    re: /(أكثر\s*من\s*[\d٠-٩,،]+\s*(شركة|عميل|مستخدم)\s*(يثق|تثق|يستخدم))/i,
    why: 'لا عملاء مرجعيون — أي رقم ثقة غير مملوك',
  },
];

const stripHtml = (h) => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
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
    const m = haystack.match(rule.re);
    if (!m) continue;
    // نافذة السياق: هل يوجد نفي صريح قريب يجعل الذكر مشروعاً؟
    if (rule.unless) {
      const i = haystack.indexOf(m[0]);
      const window = haystack.slice(Math.max(0, i - 220), i + 220);
      if (rule.unless.test(window)) continue;
    }
    if (!hits.has(rule.id)) hits.set(rule.id, []);
    const list = hits.get(rule.id);
    if (list.length < 3) list.push({ file: rel, sample: m[0].slice(0, 60) });
  }
}

console.log(`فحص الادّعاءات على ${files.length} ملف مُصيَّر (مستثنى: ${skipped}).`);

if (!hits.size) {
  console.log('  ✓ لا ادّعاء محظور في المخرجات.');
  process.exit(0);
}

for (const [id, list] of hits) {
  const rule = RULES.find((r) => r.id === id);
  console.error(`\n  ✗ [${id}] ${rule.why}`);
  for (const h of list) console.error(`      ${h.file} — «${h.sample}»`);
}
console.error(`\n✗ فحص الادّعاءات فشل (${hits.size} قاعدة).`);
process.exit(1);
