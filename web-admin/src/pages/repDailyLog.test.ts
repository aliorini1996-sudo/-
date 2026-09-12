import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس سجلّ التقارير اليومية لكل مندوب — الويب والجوال معاً.
 *
 * الخلل الذي وُلد معه: خريطة الحالات كُتبت بـ`PENDING`، و«PENDING» حالةُ
 * **مهمّة** في السلسلة (DailyReportTask.state) لا حالةُ تقرير. والحالات التي
 * يكتبها الخادم أربع: SUBMITTED · IN_REVIEW · RETURNED · APPROVED. وأثر الخطأ
 * لا يُرى في أيّ اختبار سلوك: يسقط كلّ تقريرٍ حيٍّ إلى الفرع الافتراضي فيقرأ
 * المستخدم العربيّ «SUBMITTED» إنجليزيّةً، ويبقى عدّاد «قيد المراجعة» صفراً.
 *
 * ولماذا يُقاس اللفظ لا الوجود فقط: الحالة الواحدة يجب أن تُقرأ بلفظٍ واحد في
 * المنصّة كلّها — «أعيد للتصحيح» في شاشة التقارير و«معاد للتصحيح» في السجلّ
 * حالتان في عين المستخدم لا حالة.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

/** الحالات الأربع كما يكتبها محرّك السلسلة في الخادم */
const SERVER_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED'];

/** اللفظ المعتمَد لكل حالة — مصدره شاشة التقارير اليومية القائمة */
const CANON: Record<string, string> = {
  SUBMITTED: 'مرفوع',
  IN_REVIEW: 'قيد المراجعة',
  RETURNED: 'أعيد للتصحيح',
  APPROVED: 'معتمد',
};

test('الحالات الأربع هي ما يكتبه الخادم فعلاً — لا لائحة متخيَّلة', () => {
  const chain = read('..', 'backend', 'src', 'services', 'dailyReportChain.ts');
  const written = new Set((chain.match(/status: '([A-Z_]+)'/g) || []).map(m => m.slice(9, -1)));
  for (const st of SERVER_STATUSES) {
    assert.ok(written.has(st), `الحالة ${st} لم تعد تُكتب في المحرّك — راجع خرائط الواجهة`);
  }
});

test('خريطة حالات السجلّ في الويب تغطّي الأربع بلفظ الشاشات القائمة', () => {
  const s = read('src', 'pages', 'SalesRepsPage.tsx');
  const i = s.indexOf('const DR_STATUS');
  assert.ok(i > 0, 'خريطة حالات سجلّ التقارير مفقودة من صفحة المناديب');
  const map = s.slice(i, s.indexOf('};', i));
  assert.doesNotMatch(map, /\bPENDING\b/, 'PENDING حالةُ مهمّة لا حالةُ تقرير — وجودها يعني أن الحيّ يسقط للفرع الافتراضي');
  for (const st of SERVER_STATUSES) {
    assert.match(map, new RegExp(`${st}:`), `الحالة ${st} غير معالَجة`);
    assert.ok(map.includes(CANON[st]), `لفظ ${st} يجب أن يكون «${CANON[st]}» كبقيّة الشاشات`);
  }
});

test('خريطة حالات السجلّ في تطبيق الإدارة تغطّي الأربع باللفظ نفسه', () => {
  const s = read('src', 'm', 'MRepDailyLog.tsx');
  const i = s.indexOf('const STATUS');
  assert.ok(i > 0, 'خريطة الحالات مفقودة من شاشة السجلّ');
  const map = s.slice(i, s.indexOf('};', i));
  assert.doesNotMatch(map, /\bPENDING\b/, 'PENDING ليست حالةَ تقرير');
  for (const st of SERVER_STATUSES) {
    assert.match(map, new RegExp(`${st}:`), `الحالة ${st} غير معالَجة`);
    assert.ok(map.includes(CANON[st]), `لفظ ${st} يجب أن يكون «${CANON[st]}» كبقيّة الشاشات`);
  }
});

test('عدّاد «قيد المراجعة» يُقاس بالحالتين الحيّتين لا بحالةٍ لا وجود لها', () => {
  const s = read('..', 'backend', 'src', 'routes', 'dailyReports.ts');
  const i = s.indexOf("router.get('/rep/:salesRepId'");
  assert.ok(i > 0, 'مسار سجلّ المندوب مفقود');
  const body = s.slice(i, s.indexOf('\n});', i));
  assert.doesNotMatch(body, /status === 'PENDING'/, 'قياس التقرير بـPENDING يعطي صفراً أبداً ويُخفي «عند أيّ مستوى»');
  assert.match(body, /SUBMITTED[\s\S]{0,60}IN_REVIEW/, '«في الطريق» = SUBMITTED أو IN_REVIEW');
});

/* ═══ التقرير قد يأتي بلا صاحب — وشاشتا التفصيل تقرآن اسمه ═══ */

test('شاشتا تفصيل التقرير تحتملان مندوباً محذوفاً — التصيير يُفرِّغ الشجرة كلّها', () => {
  /* لا ErrorBoundary في اللوحة، فـ`TypeError` أثناء التصيير يُفرّغ شجرة React
   * بأسرها: صفحةٌ بيضاء تحتاج إعادة تحميل، لا رسالةٌ في مكان الشاشة. */
  for (const [file, where] of [
    [['src', 'pages', 'DailyReportsPage.tsx'], 'اللوحة'],
    [['src', 'm', 'MDailyReports.tsx'], 'تطبيق الإدارة'],
  ] as [string[], string][]) {
    const s = read(...file);
    // السطر كلّه لا ما قبل أوّل فاصلة منقوطة: النوع نفسه يحمل فواصل منقوطة
    // داخل قوسيه (`{ id: string; name: string }`) فتقطعه `[^;]` قبل `| null`
    assert.match(s, /salesRep: [^\n]*\| null/, `النوع في ${where} يجب أن يعلن أنّ الصاحب قد يغيب`);
    assert.doesNotMatch(s, /\bd\.salesRep\.name/, `قراءة غير محروسة في ${where} — حذف المندوب يُفرّغ الشاشة`);
    assert.match(s, /d\.salesRep\?\.name/, `القراءة المحروسة مفقودة من ${where}`);
  }
});

/* ═══ «اليوم» نصٌّ لا لحظة ═══ */

test('تاريخ التقرير يُعرض بدالّة اليوم لا بدالّة اللحظة', () => {
  /* `reportDate` نصّ `YYYY-MM-DD` (اقرأ تعليقه في المخطّط). و`formatDate`
   * تقرؤه منتصف ليلٍ عالميّاً ثمّ تعرضه بمنطقة الجهاز، فينزلق يوماً للوراء عند
   * كلّ منطقةٍ سالبة — يقرأ المستخدم في الأمريكتين تقرير الأحد بتاريخ السبت. */
  for (const file of [['src', 'pages', 'SalesRepsPage.tsx'], ['src', 'm', 'MRepDailyLog.tsx']] as string[][]) {
    const s = read(...file);
    assert.doesNotMatch(s, /formatDate\(r\.reportDate\)/, `${file.join('/')}: اليوم يُعرض بدالّة لحظة فينزلق`);
    assert.match(s, /formatDayOnly\(r\.reportDate\)/, `${file.join('/')}: دالّة اليوم مفقودة`);
  }
});

test('ألفاظ خريطة الحالات في القاموس كذلك — النداء بمتغيّر لا يراه الحارس العامّ', () => {
  const dict = read('src', 'i18n', 'strings.ts');
  for (const [file, anchor] of [
    [['src', 'm', 'MRepDailyLog.tsx'], 'const STATUS'],
    [['src', 'pages', 'SalesRepsPage.tsx'], 'const DR_STATUS'],
  ] as [string[], string][]) {
    const s = read(...file);
    const i = s.indexOf(anchor);
    const map = s.slice(i, s.indexOf('};', i));
    const labels = [...map.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    assert.equal(labels.length, 4, `${file.join('/')}: عدد الألفاظ ${labels.length}`);
    for (const l of labels) {
      assert.ok(dict.includes(`'${l}':`), `${file.join('/')}: اللفظ «${l}» ليس في القاموس`);
    }
  }
});
