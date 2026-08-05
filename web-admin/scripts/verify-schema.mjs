/**
 * حارس البيانات المنظّمة — يفحص **مخرجات dist/** لا الشيفرة المصدرية.
 *
 * لماذا وُجد (5 أغسطس 2026): Search Console أبلغ عن **108 صفحة** في تقرير «البيانات
 * المنظّمة غير قابلة للتحليل» بسبب «كيان فريد مكرّر» — كل صفحة داخلية ترث ld+json
 * قالبِ الرئيسية (Organization + SoftwareApplication + FAQPage) ثم تضيف كتلتها، فصار
 * على مقالات الكتالوج **FAQPage مرّتين**.
 *
 * الدرس الذي يبرّر الحارس: **الكتلتان صالحتان JSON كلٌّ على حدة** — العطل دلاليّ
 * (كيان يجب أن يكون فريداً تكرّر عبر كتلتين) لا نحويّ، فلا يكشفه أي فحص `JSON.parse`
 * لكتلة واحدة، ولا تراه العين في مراجعة الكود لأن مصدر الكتلتين ملفّان مختلفان.
 *
 * يفشل هذا الفحص إذا:
 *   1) كتلة ld+json غير صالحة JSON (خطأ نحويّ صريح).
 *   2) تكرّر نوع «فريد لكل صفحة» عبر كتل الصفحة الواحدة.
 *
 * التشغيل: node scripts/verify-schema.mjs   (بعد البناء، ضمن postbuild)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');

/**
 * أنواع تصف **الصفحة نفسها** فلا يصحّ تكرارها فيها.
 * BreadcrumbList مستثناة عمداً: جوجل يسمح بأكثر من مسار تنقّل للصفحة الواحدة.
 */
const UNIQUE_TYPES = new Set(['FAQPage', 'Article', 'BlogPosting', 'NewsArticle', 'WebSite', 'Organization', 'SoftwareApplication']);

function collect(dir, out = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out, depth + 1);
    else if (/\.html$/i.test(e.name)) out.push(p);
  }
  return out;
}

if (!fs.existsSync(DIST)) {
  console.error('✗ لا يوجد dist/ — شغّل npm run build أولاً');
  process.exit(1);
}

const files = collect(DIST);
const broken = [];   // كتل JSON فاسدة
const dupes = new Map(); // نوع مكرَّر → أمثلة ملفات

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const blocks = [...raw.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!blocks.length) continue;

  const types = [];
  for (const [, body] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      if (broken.length < 5) broken.push({ file: path.relative(DIST, f), msg: e.message.slice(0, 90) });
      continue;
    }
    const nodes = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
    for (const n of nodes) {
      const t = n && n['@type'];
      if (typeof t === 'string') types.push(t);
      else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.push(x));
    }
  }

  const count = {};
  for (const t of types) count[t] = (count[t] || 0) + 1;
  for (const [t, n] of Object.entries(count)) {
    if (n > 1 && UNIQUE_TYPES.has(t)) {
      if (!dupes.has(t)) dupes.set(t, []);
      const list = dupes.get(t);
      if (list.length < 4) list.push(path.relative(DIST, f));
      else list.count = (list.count || 4) + 1;
    }
  }
}

console.log(`فحص البيانات المنظّمة على ${files.length} ملف مُصيَّر.`);

if (!broken.length && !dupes.size) {
  console.log('  ✓ كل كتل ld+json صالحة ولا كيان فريد مكرَّر.');
  process.exit(0);
}

for (const b of broken) console.error(`  ✗ [json غير صالح] ${b.file} — ${b.msg}`);
for (const [t, list] of dupes) {
  console.error(`  ✗ [كيان فريد مكرَّر] «${t}» يتكرّر في صفحة واحدة — أمثلة:`);
  for (const f of list) console.error(`      ${f}`);
}
console.error('\n✗ فحص البيانات المنظّمة فشل. (راجع إزالة FAQPage الموروثة في buildPage بـprerender.mjs)');
process.exit(1);
