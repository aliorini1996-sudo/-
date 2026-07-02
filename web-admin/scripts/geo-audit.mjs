// تدقيق GEO آلي (تحسين الظهور في محركات الذكاء الاصطناعي) — يفحص llms.txt وترحيب robots.txt
// بزواحف AI والتصيير المسبق وبيانات FAQ المنظّمة واتساق الفهرس مع الكتالوج.
// يُشغَّل يدوياً (npm run geo:audit) وضمن الصيانة المجدولة. يُنهي بكود 1 عند وجود أخطاء (لاستخدام CI).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listArticles } from '../src/blog/seo/catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0, warns = 0, fails = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const warn = (m) => { warns++; console.log('  ⚠️  ' + m); };
const fail = (m) => { fails++; console.log('  ❌ ' + m); };
const section = (t) => console.log('\n▶ ' + t);

// ===== 1) llms.txt (دليل الموقع لنماذج الذكاء الاصطناعي) =====
section('llms.txt — معيار llmstxt.org');
if (!exists('public/llms.txt')) fail('لا يوجد public/llms.txt — شغّل: npm run geo:llms');
else {
  const t = read('public/llms.txt');
  t.startsWith('# ') ? ok('يبدأ بعنوان H1') : fail('لا يبدأ بعنوان H1 (# اسم الموقع)');
  /^> /m.test(t) ? ok('فيه ملخّص blockquote') : fail('لا يوجد ملخّص (> ...)');
  const links = (t.match(/\]\(https:\/\/fieldsa\.net/g) || []).length;
  links >= 30 ? ok(`روابط مُنسّقة كافية (${links})`) : fail(`روابط قليلة (${links}) — يُتوقّع ≥ 30`);
  t.includes('/signup') ? ok('يذكر رابط التسجيل (CTA)') : warn('لا يذكر /signup');
  t.includes('llms-full.txt') ? ok('يشير إلى الفهرس الكامل') : warn('لا يشير إلى llms-full.txt');
  t.length < 40_000 ? ok(`حجم مناسب (${(t.length / 1024).toFixed(1)}KB)`) : warn('كبير جداً — يُفضّل إبقاءه مُنسّقاً مختصراً');
}

// ===== 2) llms-full.txt (الفهرس الكامل) =====
section('llms-full.txt — الفهرس الكامل');
if (!exists('public/llms-full.txt')) fail('لا يوجد public/llms-full.txt');
else {
  const t = read('public/llms-full.txt');
  const links = (t.match(/\]\(https:\/\/fieldsa\.net/g) || []).length;
  const expected = listArticles('ar').length * 3; // ثلاث لغات
  links >= expected ? ok(`يغطّي كل المقالات (${links} رابط ≥ ${expected})`) : fail(`ناقص: ${links} رابط والمتوقّع ≥ ${expected} — شغّل: npm run geo:llms`);
  // عيّنة اتساق مع الكتالوج (يكشف فهرساً قديماً بعد إضافة مقالات)
  const sample = listArticles('en').slice(0, 3);
  const missing = sample.filter((a) => !t.includes(`/en/blog/${a.slug})`));
  missing.length === 0 ? ok('متسق مع الكتالوج (عيّنة)') : fail(`مقالات غائبة عن الفهرس: ${missing.map((a) => a.slug).join(', ')}`);
}

// ===== 3) robots.txt — الترحيب بزواحف الذكاء الاصطناعي =====
section('robots.txt — زواحف الذكاء الاصطناعي');
if (!exists('public/robots.txt')) fail('لا يوجد robots.txt');
else {
  const r = read('public/robots.txt');
  // الزواحف الأساسية (غيابها يُفشل) ثم الثانوية (تحذير فقط)
  const core = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot'];
  const extra = ['ChatGPT-User', 'Claude-User', 'Claude-SearchBot', 'Perplexity-User', 'Applebot-Extended', 'meta-externalagent', 'Amazonbot', 'DuckAssistBot', 'CCBot'];
  for (const b of core) r.includes(`User-agent: ${b}`) ? ok(`${b} مذكور صراحةً`) : fail(`${b} غير مذكور`);
  const missingExtra = extra.filter((b) => !r.includes(`User-agent: ${b}`));
  missingExtra.length === 0 ? ok(`كل الزواحف الثانوية مذكورة (${extra.length})`) : warn(`زواحف ثانوية غير مذكورة: ${missingExtra.join(', ')}`);
  /Disallow:\s*\/\s*$/m.test(r) ? fail('يحجب الموقع كاملاً (Disallow: /)') : ok('لا يحجب الموقع كاملاً');
  r.includes('llms.txt') ? ok('يشير إلى llms.txt') : warn('لا يشير إلى llms.txt');
}

// ===== 4) التصيير المسبق — زواحف AI لا تُشغّل JavaScript =====
section('التصيير المسبق (prerender) — أساس قابلية الاقتباس');
exists('scripts/prerender.mjs') ? ok('سكربت prerender موجود') : fail('لا يوجد scripts/prerender.mjs');
const pkg = JSON.parse(read('package.json'));
(pkg.scripts?.postbuild || '').includes('prerender') ? ok('prerender مربوط في postbuild') : fail('prerender غير مربوط في postbuild');
(pkg.scripts?.prebuild || '').includes('gen-llms') ? ok('توليد llms.txt مربوط في prebuild') : fail('gen-llms غير مربوط في prebuild');

// ===== 5) بيانات FAQ المنظّمة — أكثر ما تقتبسه محركات الإجابة =====
section('بيانات FAQ المنظّمة');
const catalogSrc = read('src/blog/seo/catalog.mjs');
catalogSrc.includes('faqData') ? ok('faqData موجودة في الكتالوج (لكل مقال)') : fail('لا توجد faqData في الكتالوج');
const blogPage = exists('src/pages/BlogPostPage.tsx') ? read('src/pages/BlogPostPage.tsx') : '';
blogPage.includes('FAQPage') ? ok('FAQPage schema تُصدر من صفحة المقال') : warn('FAQPage غير ظاهرة في BlogPostPage');

// ===== النتيجة =====
console.log(`\n${'='.repeat(50)}\nالنتيجة: ✅ ${pass} ناجح · ⚠️ ${warns} تحذير · ❌ ${fails} فشل`);
if (fails > 0) { console.log('يوجد أخطاء GEO يجب إصلاحها.'); process.exit(1); }
console.log('تدقيق GEO سليم.');
