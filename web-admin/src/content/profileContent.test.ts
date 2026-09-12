import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROFILE_FIELDS, PROFILE_DEFAULTS, PROFILE_SECTIONS,
  mergeProfile, sectionOn, showKey, splitLines, splitPairs, PROFILE_CMS_KEY,
  readPartners, PROFILE_PARTNERS_KEY,
  PROFILE_LANGS, PROFILE_LANG_LABEL,
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

test('لكل حقل قيمة افتراضية في اللغات الخمس — الفارغ يترك فجوةً في الصفحة', () => {
  for (const f of PROFILE_FIELDS) {
    for (const l of PROFILE_LANGS) {
      assert.ok((PROFILE_DEFAULTS[l][f.key] || '').trim(),
        `${PROFILE_LANG_LABEL[l]} بلا افتراضي: ${f.key}`);
    }
  }
});

/**
 * الحقول متعدّدة الأسطر تُعرَض بنداً لكل سطر، فاختلاف عددها بين اللغتين يعني
 * قارئاً يرى ثلاثة بنود وقارئاً آخر يرى أربعة من المحتوى نفسه.
 */
test('عدد أسطر الحقول متعدّدة الأسطر متطابق في اللغات الخمس', () => {
  for (const f of PROFILE_FIELDS.filter(x => x.multiline)) {
    const ar = splitLines(PROFILE_DEFAULTS.ar[f.key]).length;
    for (const l of PROFILE_LANGS) {
      const n = splitLines(PROFILE_DEFAULTS[l][f.key]).length;
      assert.equal(n, ar, `${f.key}: العربية ${ar} سطراً و${PROFILE_LANG_LABEL[l]} ${n}`);
    }
  }
});

/** حقول «قيمة | وصف»: الفاصل شرطٌ لظهور الرقم منفصلاً عن شرحه */
test('محطات الرحلة والأرقام بصيغة «قيمة | وصف» في اللغات الخمس', () => {
  for (const key of ['journey_stations', 'numbers_items']) {
    for (const lang of PROFILE_LANGS) {
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
  assert.equal(m.zh.cover_title, PROFILE_DEFAULTS.zh.cover_title, 'تسرّبت العربية إلى الصينية');
});

/**
 * زرّ الـPDF يخدم ما يرفعه المالك ويسقط للمدمَج — فلا يبقى يخدم نسخةً قديمة
 * بعد أن يحدّث بروفايله، ولا يتعطّل إن لم يرفع شيئاً بعد.
 */
/**
 * السلوك القديم كان: اخدم ملفّ المالك المرفوع، وإلا فالملفّ المدمَج في `public`.
 * سقط الاثنان لسببٍ واحد: **ملفٌّ واحد لا يطابق خمس لغات** ولا يتبع نصّاً
 * يعدّله المالك من لوحته. الاختبار الآن يحرس العقد الجديد لا القديم.
 */
test('التصدير مصدره الصفحة نفسها لا ملفٌّ منفصل', () => {
  assert.ok(!page.includes('BUILTIN_PDF'), 'ما زال ثابت الملفّ المدمَج قائماً');
  assert.ok(page.includes('exportPdf'), 'لا دالّة تصدير');
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

/**
 * ═══ فضاء اسم المحتوى ═══
 *
 * العطل الذي حدث فعلاً: بُدّلت مجموعة المحتوى كلّها وبقي مفتاح CMS هو نفسه،
 * فبقيت ٢٧ قيمة محفوظة من البروفايل القديم تفوز على النصوص الجديدة بصمت —
 * والزائر يرى عناوين قديمة داخل تصميم جديد، والكود سليمٌ ظاهراً.
 *
 * القاعدة المحروسة: **الصفحة والمحرّر يقرآن ويكتبان المفتاح نفسه، وهو ليس
 * `profile` القديم.**
 */
test('الصفحة والمحرّر على مفتاح CMS واحد، وليس مفتاح المحتوى القديم', () => {
  assert.notEqual(PROFILE_CMS_KEY, 'profile',
    'مفتاح CMS هو القديم — قيم البروفايل السابق ستفوز على النصوص الجديدة');
  for (const [name, src] of [['الصفحة', page], ['المحرّر', panel]] as const) {
    assert.match(src, /PROFILE_CMS_KEY/, `${name}: لا يستعمل ثابت المفتاح`);
    assert.doesNotMatch(src, /cms\?\.profile\b/, `${name}: ما زال يقرأ المفتاح القديم`);
  }
  assert.doesNotMatch(panel, /,\s*profile:\s*content/, 'المحرّر ما زال يكتب في المفتاح القديم');
});

/**
 * ═══ ارتفاع سطر العناوين ═══
 *
 * أصناف الحجم في تايلويند (`text-3xl` و`text-5xl` …) تحمل معها `line-height: 1`،
 * وتغلب `leading-*` حسب ترتيب الورقة. ونسبةُ ١٫٠ تكفي اللاتينية ولا تكفي
 * العربية: قِيس على الصفحة الحيّة أن سطرَي عنوان بحجم ٤٨ بكسل **يتداخلان ٤٤
 * بكسل** — تصعد ألفات السطر الثاني في نزول السطر الأول فتشتبك الحروف.
 *
 * فكل عنوان بحجم عرض يجب أن يحمل `lineHeight` صريحاً في `style` — وهو يفوز
 * على أي صنف مهما كان ترتيب الورقة.
 */
test('كل عنوان كبير يحمل ارتفاع سطر صريحاً — وإلا تداخلت أسطره بالعربية', () => {
  const heads = [...page.matchAll(/<(h1|h2|p)([^>]*?)className="([^"]*text-(?:2xl|3xl|4xl|5xl)[^"]*)"([^>]*?)>/g)];
  assert.ok(heads.length >= 5, `لم تُرصد العناوين الكبيرة (${heads.length})`);
  for (const m of heads) {
    const tag = m[0];
    assert.match(tag, /lineHeight:\s*1\.\d/,
      `عنوان بلا ارتفاع سطر صريح ⇒ يتداخل بالعربية: ${m[3].slice(0, 40)}`);
  }
});

/** ولا يُترك الأمر لأصناف leading التي تغلبها أصناف الحجم */
test('العناوين لا تعتمد على leading-* وحدها', () => {
  assert.doesNotMatch(page, /text-3xl sm:text-5xl font-bold leading-/, 'عنوان يعتمد leading- وتغلبه فئة الحجم');
});

/**
 * مبدّل اللغة ونصوص الواجهة: اللغة التي لا زرّ لها لا يصلها الزائر، والمفتاح
 * الناقص من قاموس الواجهة يعرض للزائر التركيّ سطراً إنجليزياً وسط صفحته.
 *
 * الفحص بمسحٍ نصّيّ بلا هروبٍ نمطيّ: مولّد هذا الملف يبتلع الشرطة المائلة،
 * فكتابتها هنا تُنتج سطراً حقيقياً يكسر السلسلة — وقد كسرها مرّة.
 */
test('اللغات الخمس كلها في مبدّل الصفحة وفي محرّر المالك', () => {
  assert.equal(PROFILE_LANGS.length, 5, 'عدد اللغات تغيّر');
  for (const l of PROFILE_LANGS) {
    assert.ok(PROFILE_LANG_LABEL[l]?.trim(), `اللغة ${l} بلا اسم معروض`);
  }
  const HARDCODED = "['ar', 'en'] as ProfileLang";
  for (const [name, src] of [['الصفحة', page], ['المحرّر', panel]] as const) {
    assert.ok(src.includes('PROFILE_LANGS.map'), `${name}: المبدّل لا يمرّ على كل اللغات`);
    assert.ok(!src.includes(HARDCODED), `${name}: بقيت لغتان مكتوبتان بأيديهما`);
  }
});

test('كل مفتاح في قاموس واجهة الصفحة يحمل اللغات الخمس', () => {
  const start = page.indexOf('const UI: Record<string, Record<ProfileLang, string>>');
  assert.ok(start > 0, 'قاموس نصوص الواجهة غير موجود');
  const END = String.fromCharCode(10) + '};';
  const block = page.slice(start, page.indexOf(END, start));
  // كل مدخلة تنتهي بـ«},» — القسمة عليها تعطي مدخلةً لكل مفتاح، سطراً كانت
  // أو أسطراً. (العدّ بالأسطر وحده أسقط المدخلات المكتوبة في سطر واحد.)
  const entries = block.split('},').filter(e => e.includes(': {'));
  assert.ok(entries.length >= 15, `مفاتيح الواجهة قليلة: ${entries.length}`);
  for (const e of entries) {
    const name = e.slice(0, e.indexOf(': {')).trim().split(String.fromCharCode(10)).pop();
    for (const l of PROFILE_LANGS) {
      assert.ok(e.includes(l + ':'), `مفتاح الواجهة «${name}» بلا ${PROFILE_LANG_LABEL[l]}`);
    }
  }
});

/** النسخة تسويقية لا استثمارية: بقاء لغة الجولة والهوامش يناقض غرض الصفحة */
test('لا لغة استثمارية في النصّ التسويقي', () => {
  const banned = ['جولتنا الاستثمارية', 'هامشنا', 'investment round', 'gross margin', 'ARPU'];
  for (const l of PROFILE_LANGS) {
    const all = Object.values(PROFILE_DEFAULTS[l]).join(' ');
    for (const b of banned) {
      assert.ok(!all.includes(b), `${PROFILE_LANG_LABEL[l]}: بقيت عبارة استثمارية «${b}»`);
    }
  }
});

/**
 * تصدير PDF: المصدر واحد أو لا يكون.
 *
 * كان الزرّ يخدم ملفاً ثابتاً في `public`، فيقرأ الزائر التركيّ صفحةً بالتركية
 * ثم ينزّل ملفاً عربياً بمحتوى ما قبل آخر تعديل. ملفٌّ واحد لا يطابق خمس لغات
 * ولا يتبع نصّاً يعدّله المالك — فصار التصدير طباعةً للصفحة نفسها.
 */
test('تصدير PDF يطبع الصفحة ولا يخدم ملفاً ثابتاً', () => {
  // حوار الطباعة يجعل المخرج رهينةَ إعدادات الزائر: «الرؤوس والتذييلات» يفرض
  // هوامش فتظهر أطراف بيضاء ويُطبع الرابط والتاريخ على وثيقة تسويقية.
  //
  // ويُفحص **الكود دون التعليقات**: أول صياغة للحارس سقطت على شرح العيب نفسه
  // في تعليق الدالّة — حارسٌ يقرأ النثر يمنع توثيق ما يحرسه.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!code.includes('window.print()'), 'عاد التصدير إلى حوار الطباعة');
  assert.ok(page.includes("import('jspdf')"), 'لا مولّد PDF');
  assert.ok(page.includes('pdf-capture'), 'لا وضع التقاط بمقاس الورقة');
  // من الحافة إلى الحافة: الصورة تملأ الورقة كاملةً بلا هامش
  // `[^)]*` كان يقف عند قوس `toDataURL(...)` الداخلي فيفشل على كود سليم
  assert.ok(/addImage\([\s\S]*?0,\s*0,\s*pageW,\s*pageH\)/.test(code), 'الصفحة لا تُملأ حافةً لحافة');
  assert.ok(!page.includes('fieldsales-profile.pdf'), 'ما زال يخدم ملفاً ثابتاً منفصلاً');
  assert.ok(!page.includes('profileDeckApi'), 'ما زال يقرأ ملفاً مرفوعاً لا يتبع اللغة');
  // اسم الملف المحفوظ يتبع اللغة المعروضة
  assert.ok(page.includes('UI.pdfName[lang]'), 'اسم الملفّ لا يتبع لغة العرض');
  // والصور تُنتظر قبل الحوار وإلا خرجت الورقة بخانات بيضاء
  assert.ok(page.includes('PHOTOS.map'), 'لا انتظار للصور قبل الطباعة');
});

/**
 * عنوان الاشتراك يعدّ الباقات، والبنود تسردها.
 *
 * وقع فعلاً: أُضيفت باقة ثالثة (٣٩٩) إلى البنود في اللغات الخمس وبقي العنوان
 * «باقتان» في الخمس كلّها — فالزائر يقرأ عدداً ويرى غيره. العدد في نصّين
 * يفترقان صامتين، فيُحرَس.
 */
test('عدد الباقات في العنوان يطابق عددها في البنود', () => {
  const WORD: Record<string, RegExp> = {
    ar: /باقتان|ثلاث باقات|أربع باقات/,
    en: /\b(Two|Three|Four) plans\b/i,
    fr: /\b(Deux|Trois|Quatre) formules\b/i,
    // بلا `\b` قبل «üç»: حدّ الكلمة في JS مبنيّ على \w اللاتينيّة فيفشل أمام ü
    tr: /(iki|üç|dört)\s+paket/i,
    zh: /[两三四]种套餐/,
  };
  const COUNT: Record<string, number> = {
    'باقتان': 2, 'ثلاث باقات': 3, 'أربع باقات': 4,
    two: 2, three: 3, four: 4,
    deux: 2, trois: 3, quatre: 4,
    iki: 2, 'üç': 3, 'dört': 4,
    '两': 2, '三': 3, '四': 4,
  };
  for (const l of PROFILE_LANGS) {
    const title = PROFILE_DEFAULTS[l].model_title || '';
    const m = title.match(WORD[l]);
    assert.ok(m, `${PROFILE_LANG_LABEL[l]}: عنوان الاشتراك لا يذكر عدد الباقات — «${title}»`);
    const key = m[0].replace(/\s*(plans|formules|paket|种套餐)\s*/i, '').trim().toLowerCase();
    const said = COUNT[key] ?? COUNT[m[0]];
    assert.ok(said, `${PROFILE_LANG_LABEL[l]}: تعذّر قراءة العدد من «${m[0]}»`);
    // الباقة سطرٌ فيه سعر. والعدّ بـ«الأسطر ناقص واحد» كان يفترض أن الزائد سطرُ
    // التجربة وحده — فأي سطر آخر (كسطر «وما زاد فبالتفاوض») كان يُحسب باقةً.
    const paid = splitLines(PROFILE_DEFAULTS[l].model_items)
      .filter(line => /(299|399|599|٢٩٩|٣٩٩|٥٩٩)/.test(line)).length;
    assert.ok(paid >= 2, `${PROFILE_LANG_LABEL[l]}: لم تُرصد أسطر الباقات`);
    assert.equal(said, paid,
      `${PROFILE_LANG_LABEL[l]}: العنوان يقول ${said} والبنود المسعَّرة ${paid}`);
  }
});

/**
 * شركاء النجاح: الاسم والشعار خارج خريطة اللغات عمداً.
 *
 * لو دخلا فيها لوجب رفع كل شعار **خمس مرّات**، ولتضاعف حجم الـbase64 خمسةً في
 * حمولة تُجلب مع كل زيارة لكل صفحة. الحارس يمنع عودتهما إليها.
 */
test('الشركاء مفتاحٌ مستقلّ لا حقلٌ لكل لغة', () => {
  assert.equal(PROFILE_PARTNERS_KEY, 'profileV3Partners');
  const perLang = PROFILE_FIELDS.map(f => f.key).filter(k => /^partner/.test(k) && k !== 'partners_title');
  assert.deepEqual(perLang, [], `حقول شركاء تسرّبت إلى خريطة اللغات: ${perLang.join(', ')}`);
  // والعنوان وحده يُترجَم، فله افتراضيٌّ في كل لغة
  for (const l of PROFILE_LANGS) {
    assert.ok((PROFILE_DEFAULTS[l].partners_title || '').trim(), `${PROFILE_LANG_LABEL[l]}: بلا عنوان للشركاء`);
  }
  // والقسم يُخفى كبقيّة الأقسام
  assert.ok(PROFILE_SECTIONS.some(s => s.key === 'partners'), 'القسم غير قابل للإخفاء');
});

test('قارئ الشركاء يصمد على محتوى مشوَّه', () => {
  assert.deepEqual(readPartners(null), []);
  assert.deepEqual(readPartners({}), []);
  assert.deepEqual(readPartners({ [PROFILE_PARTNERS_KEY]: 'نصّ لا مصفوفة' }), []);
  // صفٌّ فارغ تماماً يسقط فلا تظهر بطاقة بيضاء
  assert.deepEqual(
    readPartners({ [PROFILE_PARTNERS_KEY]: [{ name: '  ', logo: '' }, { name: 'شريك', logo: '' }] }),
    [{ name: 'شريك', logo: '' }],
  );
});

/** قاعدة طباعة تخاطب قسماً غير موجود تمرّ بلا أثر — تنسيقٌ يبدو مضبوطاً وغائب عن الورق */
test('كل قاعدة طباعة تخاطب قسماً موجوداً في الصفحة', () => {
  const cssEnd = page.indexOf('`;', page.indexOf('const PRINT_CSS'));
  const css = page.slice(0, cssEnd);
  const body = page.slice(cssEnd);
  const secsIn = (src: string) => new Set(
    [...src.matchAll(/data-sec="([a-z]+)"/g)].map(m => m[1]),
  );
  const orphans = [...secsIn(css)].filter(x => !secsIn(body).has(x));
  assert.deepEqual(orphans, [], `قواعد طباعة لأقسام غير موجودة: ${orphans.join(', ')}`);
});
