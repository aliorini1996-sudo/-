import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILE_FIELDS, PROFILE_DEFAULTS, PROFILE_SECTIONS,
  mergeProfile, sectionOn, showKey, splitLines, splitPairs,
} from './profileContent';

/**
 * حرّاس صفحة البروفايل.
 *
 * الصفحة **صفحة ويب حقيقية** نصّها من CMS يعدّله المالك من لوحته — لا صور
 * شرائح. والخطر هنا صامتٌ لا يُسقط بناءً: حقلٌ يظهر في المحرّر ولا تقرؤه
 * الصفحة (يعدّله المالك فلا يتغيّر شيء)، أو حقلٌ تقرؤه الصفحة ولا يظهر في
 * المحرّر (لا سبيل لتعديله). فيُفحص الطرفان معاً.
 */

const SRC = path.join(process.cwd(), 'src');
const page = fs.readFileSync(path.join(SRC, 'pages', 'ProfilePage.tsx'), 'utf8');
const panel = fs.readFileSync(path.join(SRC, 'components', 'ProfileEditorPanel.tsx'), 'utf8');

test('كل حقل في المحرّر تقرؤه الصفحة — وإلا عدّله المالك بلا أثر', () => {
  const missing = PROFILE_FIELDS.map(f => f.key).filter(k => !page.includes(`t.${k}`));
  assert.deepEqual(missing, [], `حقول لا تقرؤها الصفحة: ${missing.join(', ')}`);
});

test('كل حقل تقرؤه الصفحة موجود في المحرّر — وإلا تعذّر تعديله', () => {
  const used = [...page.matchAll(/\bt\.([a-z0-9_]+)/g)].map(m => m[1]);
  const known = new Set(PROFILE_FIELDS.map(f => f.key));
  const orphans = [...new Set(used)].filter(k => !known.has(k));
  assert.deepEqual(orphans, [], `حقول تقرؤها الصفحة ولا تظهر في المحرّر: ${orphans.join(', ')}`);
});

test('لكل حقل قيمة افتراضية باللغتين — الحقل الفارغ يترك فجوةً في الصفحة', () => {
  for (const f of PROFILE_FIELDS) {
    assert.ok((PROFILE_DEFAULTS.ar[f.key] || '').trim(), `العربية بلا افتراضي: ${f.key}`);
    assert.ok((PROFILE_DEFAULTS.en[f.key] || '').trim(), `الإنجليزية بلا افتراضي: ${f.key}`);
  }
});

/**
 * الحقول متعدّدة الأسطر تُعرَض بنداً لكل سطر، فاختلاف عددها بين اللغتين يعني
 * قارئاً يرى ثلاثة بنود وقارئاً آخر يرى أربعة من المحتوى نفسه.
 */
test('عدد أسطر الحقول متعدّدة الأسطر متطابق بين اللغتين', () => {
  for (const f of PROFILE_FIELDS.filter(x => x.multiline)) {
    const ar = splitLines(PROFILE_DEFAULTS.ar[f.key]).length;
    const en = splitLines(PROFILE_DEFAULTS.en[f.key]).length;
    assert.equal(en, ar, `${f.key}: العربية ${ar} سطراً والإنجليزية ${en}`);
  }
});

/** حقول «قيمة | وصف»: الفاصل شرطٌ لظهور الرقم منفصلاً عن شرحه */
test('محطات الرحلة وأرقام الإنجاز بصيغة «قيمة | وصف» في اللغتين', () => {
  for (const key of ['journey_stations', 'numbers_items']) {
    for (const lang of ['ar', 'en'] as const) {
      const pairs = splitPairs(PROFILE_DEFAULTS[lang][key]);
      assert.ok(pairs.length >= 3, `${key}/${lang}: بنود قليلة`);
      for (const p of pairs) {
        assert.ok(p.a && p.b, `${key}/${lang}: بند بلا فاصل «|» ⇒ «${p.b}»`);
      }
    }
  }
});

/** أقسام المحرّر هي أقسام الصفحة — وإلا أخفى المالك قسماً لا وجود له */
test('كل قسم قابل للإخفاء موجود فعلاً في الصفحة', () => {
  for (const s of PROFILE_SECTIONS) {
    assert.ok(page.includes(`data-sec="${s.key}"`), `قسم في المحرّر بلا مقابل في الصفحة: ${s.key}`);
    assert.ok(page.includes(`on('${s.key}')`), `قسم لا يُفحص إظهاره في الصفحة: ${s.key}`);
  }
});

/** الإظهار شأن واحد للغتين — وإلا رأى قارئ الإنجليزية قسماً أخفاه المالك */
test('إخفاء القسم يسري على اللغتين معاً', () => {
  const hidden = mergeProfile({ ar: { [showKey('numbers')]: '0' } });
  assert.equal(sectionOn(hidden, 'numbers'), false, 'الإخفاء لا يعمل');
  assert.equal(sectionOn(hidden, 'problem'), true, 'أخفى قسماً لم يُطلب إخفاؤه');
  assert.equal(sectionOn(mergeProfile(null), 'numbers'), true, 'الغياب يجب أن يعني الظهور');
});

test('ما يحفظه المالك يفوز على الافتراضي، والغائب يبقى افتراضياً', () => {
  const m = mergeProfile({ ar: { cover_title: 'عنوان المالك' } });
  assert.equal(m.ar.cover_title, 'عنوان المالك');
  assert.equal(m.ar.problem_title, PROFILE_DEFAULTS.ar.problem_title);
  assert.equal(m.en.cover_title, PROFILE_DEFAULTS.en.cover_title, 'تسرّبت العربية إلى الإنجليزية');
});

/**
 * زرّ الـPDF يخدم ما يرفعه المالك ويسقط للمدمَج — فلا يبقى يخدم نسخةً قديمة
 * بعد أن يحدّث بروفايله، ولا يتعطّل إن لم يرفع شيئاً بعد.
 */
test('زرّ التنزيل يخدم ملفّ المالك ويسقط للمدمَج', () => {
  assert.match(page, /profileDeckApi\.get\(\)/, 'الصفحة لا تسأل عن الملفّ المرفوع');
  assert.match(page, /deck\?\.file \? `\/api\/profile-deck\/file\?v=\$\{deck\.file\.v\}` : BUILTIN_PDF/,
    'لا سقوط للملفّ المدمَج');
  assert.ok(fs.existsSync(path.join(process.cwd(), 'public', 'fieldsales-profile.pdf')),
    'الملفّ المدمَج مفقود من public');
});

test('رفع الملفّ متاح من محرّر البروفايل نفسه — لا لوحة ثانية', () => {
  assert.match(panel, /profileDeckApi\.putFile/, 'المحرّر لا يرفع الملفّ');
  assert.match(panel, /accept="application\/pdf,\.pdf"/, 'لا حقل اختيار ملف');
  assert.ok(!fs.existsSync(path.join(SRC, 'components', 'ProfileDeckPanel.tsx')),
    'بقيت لوحة ثانية للبروفايل — شيءٌ واحد بلوحتين يُربك');
});

/** الصفحة نصّ لا صور: هذا هو الفرق الذي طُلب صراحةً */
test('الصفحة تُصيَّر نصاً حقيقياً لا صور شرائح', () => {
  assert.ok(!page.includes('profile-deck/slide'), 'الصفحة ما زالت تعرض صور شرائح');
  assert.match(page, /<h1/, 'لا عنوان رئيسي — صفحة بلا بنية نصّية');
  assert.match(page, /setLang/, 'مبدّل اللغة مفقود');
});
