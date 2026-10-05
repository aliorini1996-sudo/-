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
 * ووُسّع (أكتوبر 2026) لأن التكرار ليس العطل الدلاليّ الوحيد: زحفٌ حيّ وجد FAQPage القالب العربية
 * بأسئلتها الأربعة على 205 صفحات لا يظهر فيها أيّ من تلك الأسئلة، منها 59 صفحة إنجليزية،
 * وSoftwareApplication بوصف عربي و`inLanguage: "ar"` على /en/ و/fr/. إرشادات جوجل تشترط أن تصف
 * البيانات المنظّمة محتوى ظاهراً في الصفحة نفسها، وكان الحارس أخضر كل يوم لأنه يفحص التكرار وحده.
 *
 * يفشل هذا الفحص إذا:
 *   1) كتلة ld+json غير صالحة JSON (خطأ نحويّ صريح).
 *   2) تكرّر نوع «فريد لكل صفحة» عبر كتل الصفحة الواحدة.
 *   3) كتلة صفحة بلا data-seo-page (عقد الاستبدال مع useSeo).
 *   4) سؤال في FAQPage لا يظهر نصّه في جسم الصفحة المُصيَّر (بعد تطبيع الفراغ والكيانات).
 *   5) صفحة غير عربية (lang ≠ ar) تحمل FAQPage أسئلته عربية (أكثر من 30٪ من حروفها عربية).
 *   6) صفحة غير عربية تحمل SoftwareApplication (أو WebApplication/MobileApplication) عربياً:
 *      inLanguage يبدأ بـar أو وصفه عربي في أغلبه.
 *
 * التشغيل: node scripts/verify-schema.mjs [--dist <مجلد>] [--verbose]   (بعد البناء، ضمن postbuild)
 * وضع التحذير المؤقت للقواعد 4–6 وحدها: SEO_SCHEMA_WARN=1 — لدمج إصلاح القالب (FAQPage وSoftwareApplication
 * في buildPage) بالتدريج فقط. القواعد 1–3 حاجبة دائماً.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const distArg = argv.indexOf('--dist') >= 0 ? argv[argv.indexOf('--dist') + 1] : null;
const DIST = path.resolve(distArg || path.join(__dirname, '../dist'));
const WARN_ONLY = process.env.SEO_SCHEMA_WARN === '1';
/** --verbose يطبع كل الصفحات المخالفة لا أول ستّ من كل فئة */
const VERBOSE = argv.includes('--verbose');

/**
 * أنواع تصف **الصفحة نفسها** فلا يصحّ تكرارها فيها.
 * BreadcrumbList مستثناة عمداً: جوجل يسمح بأكثر من مسار تنقّل للصفحة الواحدة.
 */
const UNIQUE_TYPES = new Set(['FAQPage', 'Article', 'BlogPosting', 'NewsArticle', 'WebSite', 'Organization', 'SoftwareApplication']);
/** أنواع البرنامج نفسه — لا يصحّ وصفها بالعربية على صفحة بلغة أخرى */
const APP_TYPES = new Set(['SoftwareApplication', 'WebApplication', 'MobileApplication']);
/** نسبة الحروف العربية التي تجعل النصّ «عربياً» (أرقام وعلامات وأسماء لاتينية لا تُحسب) */
const AR_RATIO = 0.3;

function collect(dir, out = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out, depth + 1);
    else if (/\.html$/i.test(e.name)) out.push(p);
  }
  return out;
}

const decodeEntities = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
/** تطبيع المقارنة: الكيانات والوسوم داخل السؤال والفراغ (ومنه NBSP) والمحارف الخفية والتشكيل */
const normText = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' '))
  .normalize('NFC')
  .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
  .replace(/[ً-ْٰـ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
/** نصّ جسم الصفحة المرئي: بلا سكربت ولا أنماط ولا قوالب ولا تعليقات */
const bodyText = (html) => {
  const i = html.search(/<body\b/i);
  const body = i >= 0 ? html.slice(i) : html;
  return normText(body
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' '));
};
const arabicRatio = (s) => {
  const letters = String(s).match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  return letters.filter((c) => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(c)).length / letters.length;
};
const typesOf = (n) => {
  const t = n && n['@type'];
  return typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((x) => typeof x === 'string') : [];
};
const textOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v['@value'] === 'string' ? v['@value'] : '');

if (!fs.existsSync(DIST)) {
  console.error('✗ لا يوجد dist/ — شغّل npm run build أولاً');
  process.exit(1);
}

const files = collect(DIST);
const broken = [];   // كتل JSON فاسدة
const dupes = new Map(); // نوع مكرَّر → أمثلة ملفات
const unmarked = []; // كتل صفحة بلا data-seo-page (تكسر عقد الاستبدال مع useSeo)
// القواعد الجديدة: فئة → {title, count, items}
const semantic = new Map();
const flag = (key, title, item) => {
  if (!semantic.has(key)) semantic.set(key, { title, count: 0, items: [] });
  const e = semantic.get(key);
  e.count++;
  if (VERBOSE || e.items.length < 6) e.items.push(item);
};
/** مسار العرض: النسخ المرمَّزة (%D9…) توائم المجلدات العربية — تُعرض مفكوكة وتُعدّ مرة واحدة */
const shown = (f) => {
  const r = path.relative(DIST, f).split(path.sep).join('/');
  try { return decodeURIComponent(r); } catch { return r; }
};
const seenPage = new Set();
let faqPages = 0;
let faqQuestions = 0;

for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const blocks = [...raw.matchAll(/<script type="application\/ld\+json"([^>]*)>([\s\S]*?)<\/script>/g)]
    .map((m) => [m[0], m[2], m[1]]);
  if (!blocks.length) continue;

  /**
   * عقد `data-seo-page`: كتلة **الصفحة** (لا كتلة القالب العامّة التي تحمل Organization)
   * يجب أن تكون موسومة، لأن `useSeo` يحذف الموسوم ثم يضيف نسخته عند إقلاع React.
   * إن سقط الوسم عادت المضاعفة **في DOM المُصيَّر وحده** — وهي غير مرئية لأي فحص HTML
   * ثابت، فهذا الشرط هو الحارس الوحيد الممكن عليها من هنا.
   */
  for (const [, body, attrs] of blocks) {
    let p; try { p = JSON.parse(body); } catch { continue; }
    const nodes = Array.isArray(p['@graph']) ? p['@graph'] : [p];
    const isTemplate = nodes.some((n) => n && n['@type'] === 'Organization');
    if (!isTemplate && !/data-seo-page/.test(attrs) && unmarked.length < 4) {
      unmarked.push(path.relative(DIST, f));
    }
  }

  const types = [];
  const allNodes = [];
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
      types.push(...typesOf(n));
      if (n && typeof n === 'object') allNodes.push(n);
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

  // ── القواعد الدلالية: الظهور واللغة (مرة لكل صفحة — النسخة المرمَّزة توأم مطابق) ──
  const where = shown(f);
  if (seenPage.has(where)) continue;
  seenPage.add(where);
  const lang = ((raw.match(/<html\b[^>]*\blang="([^"]*)"/i) || [])[1] || 'ar').toLowerCase();
  const nonArabic = !lang.startsWith('ar');
  let text = null;

  for (const n of allNodes) {
    const ts = typesOf(n);
    if (ts.includes('FAQPage')) {
      faqPages++;
      const qs = (Array.isArray(n.mainEntity) ? n.mainEntity : n.mainEntity ? [n.mainEntity] : [])
        .map((q) => normText(textOf(q && q.name)))
        .filter(Boolean);
      faqQuestions += qs.length;
      // المقارنة بلا فراغ أصلاً: الوسوم السطرية داخل السؤال («What is <em>X</em>?») تصير فراغاً زائداً
      if (text == null) text = bodyText(raw).replace(/\s+/g, '');
      const hidden = qs.filter((q) => !text.includes(q.replace(/\s+/g, '')));
      if (hidden.length) {
        flag('faq-hidden', 'FAQPage بأسئلة لا تظهر في نصّ الصفحة (إرشادات جوجل: البيانات المنظّمة تصف محتوى ظاهراً)',
          `${where} — ${hidden.length}/${qs.length}: «${hidden[0].slice(0, 70)}»`);
      }
      if (nonArabic) {
        const arQs = qs.filter((q) => arabicRatio(q) > AR_RATIO);
        if (arQs.length) {
          flag('faq-lang', `FAQPage بأسئلة عربية على صفحة غير عربية`,
            `${where} (lang=${lang}) — ${arQs.length}/${qs.length}: «${arQs[0].slice(0, 70)}»`);
        }
      }
    }
    if (nonArabic && ts.some((t) => APP_TYPES.has(t))) {
      const inLang = String(textOf(n.inLanguage) || '').toLowerCase();
      const desc = textOf(n.description);
      if (inLang.startsWith('ar') || arabicRatio(desc) > AR_RATIO) {
        flag('app-lang', `${ts.find((t) => APP_TYPES.has(t))} عربي على صفحة غير عربية (inLanguage أو الوصف)`,
          `${where} (lang=${lang}) — inLanguage=${inLang || '—'}${desc ? ` · «${desc.slice(0, 50)}»` : ''}`);
      }
    }
  }
}

console.log(`فحص البيانات المنظّمة على ${files.length} ملف مُصيَّر (${faqPages} صفحة FAQPage · ${faqQuestions} سؤالاً).`);

const semanticCount = [...semantic.values()].reduce((s, e) => s + e.count, 0);
if (!broken.length && !dupes.size && !unmarked.length && !semanticCount) {
  console.log('  ✓ كل كتل ld+json صالحة ولا كيان فريد مكرَّر، وعقد data-seo-page سليم، وأسئلة FAQPage ظاهرة بلغة صفحتها.');
  process.exit(0);
}

const hardFail = broken.length || dupes.size || unmarked.length;
const semLevel = WARN_ONLY ? '⚠' : '✗';
const semLog = WARN_ONLY ? console.warn : console.error;
for (const e of semantic.values()) {
  semLog(`  ${semLevel} [${e.title}] — ${e.count} صفحة. أمثلة:`);
  for (const it of e.items) semLog(`      ${it}`);
}
for (const b of broken) console.error(`  ✗ [json غير صالح] ${b.file} — ${b.msg}`);
if (unmarked.length) {
  console.error('  ✗ [عقد data-seo-page مكسور] كتلة سكيما صفحة بلا وسم — سيضاعفها useSeo في DOM بعد إقلاع React:');
  for (const f of unmarked) console.error(`      ${f}`);
}
for (const [t, list] of dupes) {
  console.error(`  ✗ [كيان فريد مكرَّر] «${t}» يتكرّر في صفحة واحدة — أمثلة:`);
  for (const f of list) console.error(`      ${f}`);
}

if (!hardFail && WARN_ONLY) {
  console.warn(`\n⚠ وضع التحذير (SEO_SCHEMA_WARN=1): ${semanticCount} خلل دلاليّ لم يُفشل البناء — أعِد الحارس حاجباً بعد دمج إصلاح القالب.`);
  process.exit(0);
}
console.error('\n✗ فحص البيانات المنظّمة فشل. (FAQPage وSoftwareApplication الموروثان من القالب يُحذفان أو يُوطَّنان في buildPage بـprerender.mjs)'
  + (semanticCount && !WARN_ONLY ? ' (المؤقت للقواعد الدلالية فقط: SEO_SCHEMA_WARN=1)' : ''));
process.exit(1);
