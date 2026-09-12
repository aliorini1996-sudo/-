import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس على عيوبٍ كشفتها المراجعة العدائية وأُصلحت — كي لا تعود.
 *
 * كلٌّ منها كان يمرّ من فحص الأنواع والاختبارات معاً، ولا يظهر إلا بعد أن
 * يستعمله إنسان: تقريرٌ يعلق أبداً، وقيمةٌ تُحفظ فارغة ويُقال «تمّ»، وتبويبٌ
 * يظهر لمن يمنعه الخادم.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};
const routes = () => read('..', 'backend', 'src', 'routes', 'dailyReports.ts');

test('المهمّة تُغلَق بمعرّف العقدة لا برقمها', () => {
  // الرقم يتبدّل بحذف عقدةٍ أو إدراج أخرى، فمهمّةٌ مفتوحة تحمل رقماً مجمَّداً
  // بينما العقدة صارت برقمٍ آخر: يفشل الإغلاق، ويصطدم إنشاءُ التالية بالقيد،
  // فيعلق التقرير أبداً برسالة «السجل موجود مسبقا» التي لا تدلّ على شيء.
  const s = routes();
  assert.match(s, /where: \{ reportId: report\.id, levelId: perm\.levelId!, round: report\.round, state: 'PENDING' \}/,
    'الإغلاق يجب أن يكون بـlevelId');
  assert.doesNotMatch(s, /where: \{ reportId: report\.id, levelSeq: perm\.levelSeq!/,
    'الإغلاق بالرقم يعود بالعيب');
  const schema = read('..', 'backend', 'prisma', 'schema.prisma');
  // القيد على الرقم هو سبب العطل، ولا يُستبدل بقيدٍ آخر لأن **إضافة** قيدٍ
  // فريد تُفشل db push بلا --accept-data-loss، وذلك العلم غائبٌ من preDeploy
  // عمداً. فالإحكام في الكود، ووجود القيد القديم وحده هو ما يُحرَس ضدّه.
  assert.doesNotMatch(schema, /@@unique\(\[reportId, levelSeq, round\]\)/, 'القيد بالرقم يعود بالعيب القاتل');
});

test('إعادة الترقيم تُزامن كل ما يشير إلى الرقم', () => {
  const s = routes();
  assert.match(s, /async function renumberLevels/, 'دالّة إعادة الترقيم مفقودة');
  // ثلاثة يشيرون إلى الرقم: المهامّ الواقفة · خانات النموذج · مؤشّر التقرير
  const i = s.indexOf('async function renumberLevels');
  /* الجسم كلّه لا شريحةٌ بعدد أحرف: شريحةٌ ثابتة يُعطّلها تعليقٌ يُضاف داخل
   * الدالّة فيدفع السطر المحروس خارجها — حارسٌ يصمت بلا أن يكسر شيئاً. */
  const end = s.indexOf('\n}', i);
  assert.ok(end > i, 'تعذّر تحديد نهاية الدالّة');
  const body = s.slice(i, end);
  assert.match(body, /dailyReportTask\.updateMany/, 'المهامّ لا تُزامَن');
  assert.match(body, /dailyReportField\.updateMany/, 'خانات النموذج لا تُزامَن');
  assert.match(body, /dailyReport\.updateMany/, 'مؤشّر التقرير لا يُزامَن');
  // وقيم التقارير سجلٌّ تاريخيّ لا يُمَسّ
  assert.doesNotMatch(body, /dailyReportValue\.updateMany/, 'قيم التقارير سجلٌّ تاريخيّ — إعادة كتابته تزوير');
});

test('الجوال يرسل num/text لا declaredNum/declaredText — ورقماً لا NaN', () => {
  // z.object يُسقط المفاتيح المجهولة صامتاً، فكانت القيمة تُحفظ null ويُقال «تمّ»
  const s = read('src', 'm', 'MDailyReports.tsx');
  assert.match(s, /\{ fieldId: f\.id, num: toNum\(mine\[f\.id\]\), text: null \}/, 'الجوال يرسل مفاتيح خاطئة');
  assert.doesNotMatch(s, /declaredNum: Number\(mine/, 'المفاتيح القديمة تعود بالعيب');
  /* كان هذا الحارس يُثبِّت `num: Number(mine[f.id])` حرفاً بحرف، فحرس المفتاح
   * الصحيح وحرس معه **العيب نفسه** من بابٍ آخر: الحقل نصٌّ حرّ و`Number('١٢٥')`
   * NaN، وJSON يحوّلها null — فتعود القيمة الفارغة «المحفوظة» التي وُضع هذا
   * الاختبار أصلاً ليمنعها. المحروس الآن هو المعنى: مطبِّعٌ يقرأ ما كتبه
   * الإنسان، ولا Number() خاماً على مدخل الشاشة. */
  assert.doesNotMatch(s, /num: Number\(mine\[/, 'Number الخام يحوّل «١٢٥» إلى NaN ثمّ null');
  assert.match(s, /function toNum\(raw: string\): number \| null/, 'مطبِّع المدخل الرقميّ مفقود');
  // وحارسٌ على الخادم يرفض جسماً بلا num ولا text
  assert.match(routes(), /refine\(v => 'num' in v \|\| 'text' in v/, 'الخادم يقبل جسماً فارغاً صامتاً');
});

test('الصلاحية الجديدة تصل الواجهة', () => {
  // بدونها يبقى تبويب «الإعداد» ظاهراً لمن يمنعه الخادم فيرى صفحةً فارغة
  const s = read('..', 'backend', 'src', 'routes', 'auth.ts');
  assert.match(s, /canManageDailyReport: true,/, 'الصلاحية غائبة عن استجابة الدخول');
});

test('حصيلة اليوم: عدّاداتها حيّة، ونطاق المستخدم محترَم', () => {
  const s = routes();
  // التقارير تُعدّ حيّةً من نفس الصفوف التي يبنيها الجدول — لا من الصفّ المجمَّد
  assert.match(s, /reportCount: reports\.length,/, 'عدّاد التقارير ما زال مجمَّداً');
  // وعدّاد المناديب يتبع **نطاق القارئ** لا الشركة كلّها: مقامٌ غير مقيَّد فوق
  // بسطٍ مقيَّد كان يُعلن غائبين لم يغيبوا
  assert.match(s, /const repCountEff = scoped/, 'عدّاد المناديب يجب أن يتبع نطاق القارئ');
  assert.match(s, /scopedRepRecordWhere\(req\)/, 'الحصيلة تتجاوز عزل نطاق المستخدم');
  assert.match(s, /hadData: seen\.has\(f\.id\)/, 'خانةٌ بلا بيانات ذلك اليوم يجب أن تُعرض شرطةً لا صفراً');
  // و«بلا بيانات» = بلا رقمٍ ولا نصّ، لا «بلا صفّ»: تطبيق المندوب يرسل الخانات
  // الفارغة بـnull فيُنشأ صفّ، فكان الإجمالي يُطبع «٠» على خانةٍ لم يملأها أحد
  assert.match(s, /if \(v\.declaredNum === null && !String\(v\.declaredText \|\| ''\)\.trim\(\)\) continue;\s*\n\s*seen\.add/,
    'hadData يجب أن تعني «كُتب فيها شيء» لا «وُجد لها صفّ»');
});

test('اللوحة: التخطيط يمضي يميناً ← يساراً ولا تتراكب البطاقات', () => {
  const s = read('src', 'pages', 'DailyReportCanvas.tsx');
  assert.match(s, /const defaultXFor = \(repX: number, i: number\) => repX - \(i \+ 1\) \* STEP;/,
    'التخطيط يجب أن ينقص x مع الترتيب كاتّجاه القراءة العربية');
  assert.doesNotMatch(s, /REP_X \+ \(i \+ 1\) \* \(NODE_W \+ 76\)/, 'التخطيط القديم يعاكس الوصلات');
});

test('اللوحة: النقر يُميَّز عن السحب فلا يُحفظ موضعٌ لم يتغيّر', () => {
  const s = read('src', 'pages', 'DailyReportCanvas.tsx');
  assert.match(s, /movedRef\.current = true;/, 'لا أثر لتتبّع الحركة');
  assert.match(s, /if \(d && movedRef\.current\) onMove/, 'كل نقرة تُرسل طلب تعديل وتكتب سطراً كاذباً في السجلّ');
  assert.match(s, /onClick=\{\(\) => \{ if \(!movedRef\.current\)/, 'حارس فتح المحرّر أثناء السحب ما زال ميّتاً');
  assert.doesNotMatch(s, /onClick=\{\(\) => \{ if \(!drag\)/, 'الحارس القديم يُقرأ بعد تصفير drag فلا يمنع شيئاً');
});

test('صفحة الحصائل تميّز الفشل عن عدم الإسناد ولا تنهار', () => {
  const s = read('src', 'pages', 'DailyReportDigests.tsx');
  assert.match(s, /if \(q\.isError\) \{/, 'الفشل يُعرض «غير مسند لك» — بيانٌ كاذب');
  assert.match(s, /if \(q\.isError \|\| !q\.data\) \{/, 'عرض الحصيلة ينهار على 403 أو 404');
});

test('تاريخ التسليم يُقرأ بأجزائه لا بمنطقة القارئ', () => {
  // منتصف ليل UTC يُعرض بتوقيت المتصفّح فينزلق يوماً غرب غرينتش
  const f = read('src', 'utils', 'format.ts');
  assert.match(f, /export function formatDayOnly/, 'دالّة اليوم الخالص مفقودة');
  for (const [file, dir] of [['InvoicesPage.tsx', 'pages'], ['MDocList.tsx', 'm'], ['RepApp.tsx', 'rep']] as const) {
    const s = read('src', dir, file);
    assert.match(s, /formatDayOnly\(/, `${file} ما زال يعرض الموعد بمنطقة القارئ`);
  }
});
