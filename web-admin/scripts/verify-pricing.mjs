/**
 * حارس اتساق السعر — يفحص **مخرجات dist/** لا الشيفرة المصدرية.
 *
 * السبب: كل نصّ عام مكتوب مرّتين (سكربتات التصيير + مكوّن React)، وجوجل ومحرّكات
 * الذكاء تقرأ الأول. وقد عاش سعر «125 ر.س لكل حساب» منشوراً في JSON-LD وllms.txt
 * والنصّ المُصيَّر بينما الأسعار الحيّة 299/599 — بلا أن يفشل أي بناء.
 *
 * يفشل هذا الفحص إذا:
 *   1) ظهر أي سعر لا يطابق الـCMS في المخرجات (كشف الانزياح).
 *   2) غاب السعر الحيّ عن الصفحة الرئيسية المُصيَّرة.
 *   3) غاب رابط واتساب عن الصفحة الرئيسية المُصيَّرة.
 *
 * التشغيل: node scripts/verify-pricing.mjs   (بعد البناء)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPricing, waDigits } from './pricing-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');

/** كل ملفات HTML/txt المُصيَّرة (بحد معقول للسرعة) */
function collect(dir, out = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out, depth + 1);
    else if (/\.(html|txt)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const fail = [];
const ok = [];

const pricing = await loadPricing();
const livePrices = pricing.plans.map((p) => String(p.price)).filter((p) => /^\d+$/.test(p));
console.log(`الأسعار الحيّة (${pricing.live ? 'CMS' : 'احتياطي'}): ${livePrices.join(' / ')}`);

if (!fs.existsSync(DIST)) {
  console.error('✗ لا يوجد dist/ — شغّل npm run build أولاً');
  process.exit(1);
}

// 1) أسعار غريبة في المخرجات: أي رقم بصيغة سعرية لا يطابق الـCMS
//    النمط يلتقط «NNN ر.س» و«NNN ﷼» و«NNN SAR» و«"price": "NNN"» فقط — لا أي رقم عابر.
const PRICE_PATTERNS = [
  /(\d{2,4})\s*(?:ر\.?\s?س|﷼|ريال)/g,
  /(\d{2,4})\s*SAR/gi,
  /"(?:price|lowPrice|highPrice)"\s*:\s*"?(\d{2,4})"?/g,
];

const files = collect(DIST);
const strays = new Map(); // سعر → ملفات

for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const re of PRICE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(txt))) {
      const v = m[1];
      if (!livePrices.includes(v)) {
        if (!strays.has(v)) strays.set(v, []);
        const list = strays.get(v);
        if (list.length < 4 && !list.includes(f)) list.push(f);
      }
    }
  }
}

if (strays.size) {
  for (const [v, fl] of strays) {
    fail.push(`سعر لا يطابق الـCMS: «${v}» في ${fl.length} ملف — مثال: ${path.relative(DIST, fl[0])}`);
  }
} else {
  ok.push(`لا سعر غريب في ${files.length} ملف مُصيَّر`);
}

// 2 و3) الصفحة الرئيسية: السعر الحيّ + رابط واتساب حاضران
const home = path.join(DIST, 'index.html');
if (fs.existsSync(home)) {
  const h = fs.readFileSync(home, 'utf8');
  for (const p of livePrices) {
    if (h.includes(p)) ok.push(`السعر ${p} حاضر في الصفحة الرئيسية المُصيَّرة`);
    else fail.push(`السعر الحيّ ${p} غائب عن dist/index.html`);
  }
  const wa = waDigits(pricing.whatsapp);
  if (wa && h.includes(wa)) ok.push('رابط واتساب حاضر في الصفحة الرئيسية المُصيَّرة');
  else fail.push(`رابط واتساب (${wa}) غائب عن dist/index.html — الزواحف لا ترى قناة التحويل`);
} else {
  fail.push('dist/index.html غير موجود');
}

for (const o of ok) console.log('  ✓ ' + o);
for (const f of fail) console.error('  ✗ ' + f);

if (fail.length) {
  console.error(`\n✗ فحص اتساق السعر فشل (${fail.length}).`);
  process.exit(1);
}
console.log('\n✓ اتساق السعر ورابط واتساب سليمان في المخرجات.');
