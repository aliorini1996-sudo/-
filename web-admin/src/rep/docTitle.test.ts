import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * عنوان المستند وتصنيف ZATCA.
 *
 * «فاتورة ضريبية مبسطة» و«فاتورة ضريبية» تصنيفٌ تفرضه هيئة الزكاة والضريبة
 * السعودية. طباعتُه على مستند شركةٍ لبنانية أو مصرية توهم بامتثالٍ لنظامٍ
 * لا يخصّها — وهو ادّعاءٌ على وثيقة تجارية لا مجرّد نصّ في واجهة.
 *
 * الاختبار ثابتٌ على المصدر لأن المكوّن يعتمد React وqrcode ولا يُحمَّل
 * في node:test بلا DOM. وما يحرسه ليس شكل الجملة بل وجود الشرط في
 * **الموضعين** معاً: مستند الشاشة والطباعة الحرارية.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('الدولة تصل المستند — countryCode في نوع الشركة', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  assert.match(s, /countryCode\?: string \| null;/, 'نوع Company بلا countryCode فلا سبيل لمعرفة الدولة');
});

test('غياب الدولة يُعامَل سعوديّةً — مطابقةً لافتراض العمود في المخطّط', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  assert.match(s, /company\?\.countryCode \?\? 'SA'/, "الغياب يجب أن يسقط إلى 'SA' لا إلى غيرها");
  // مقارنة غير حسّاسة لحالة الأحرف: قيمة 'sa' من بيانات قديمة يجب ألّا تُعدّ أجنبية
  assert.match(s, /toUpperCase\(\) === 'SA'/, 'المقارنة يجب أن تكون غير حسّاسة لحالة الأحرف');
});

/*
 * موضع القاعدة تغيّر في Z5.6b ولم تتغيّر القاعدة: عنوان المرحلة الأولى صار في دالّة نقيّة واحدة
 * (`lib/zatca/docPrint.ts: phase1Title`) يستدعيها السطحان معاً عبر `zatcaPrintDecision` — ونصّها مثبَّت
 * بالقيمة في `docPrint.test.ts` لا بالمطابقة النصّية. فالحارس هنا يثبت أمرين: أنّ الدالّة ما زالت تفحص
 * الدولة قبل التصنيف، وأنّ السطحين ما زالا يمرّان بها بدل أن يعيد أحدهما كتابة العنوان لنفسه.
 */

test('تصنيف ZATCA مشروط بالسعودية في الدالّة الواحدة التي تبني العنوان', () => {
  const s = read('src', 'lib', 'zatca', 'docPrint.ts');
  const i = s.indexOf('export function phase1Title');
  assert.ok(i > 0, 'phase1Title غير موجودة — عنوان المرحلة الأولى بلا مصدر واحد');
  const block = s.slice(i, i + 420);
  assert.match(block, /f\.saudi === false/, 'العنوان لا يفحص الدولة');
  // الشرط يجب أن يسبق تصنيف مبسّطة/ضريبية وإلا طُبع قبل أن يُفحص
  assert.ok(block.indexOf('saudi') < block.indexOf('مبسطة'), 'فحص الدولة يجب أن يسبق التصنيف');
});

test('مستند الشاشة يأخذ عنوانه من القرار ويمرّر له الدولة', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  assert.match(s, /saudi: isSaudiDoc\(doc\.company\)/, 'القالب لا يمرّر الدولة إلى قرار الطباعة');
  assert.match(s, /const docTitle = tr\(zDecision\.title\)/, 'العنوان يُكتب في القالب بدل أن يأتي من القرار');
});

test('الطباعة الحرارية تحمل الشرط نفسه — لا يكفي إصلاح الشاشة', () => {
  const s = read('src', 'rep', 'thermal.ts');
  assert.match(s, /saudi: isSaudiDoc\(doc\.company\)/, 'الطباعة الحرارية تطبع التصنيف بلا فحص الدولة');
  assert.match(s, /const title = d\.title;/, 'عنوان الشريط يُكتب فيه بدل أن يأتي من القرار');
});

test('المرتجع يبقى «إشعار دائن مرتجع» في كل الدول', () => {
  const s = read('src', 'lib', 'zatca', 'docPrint.ts');
  const i = s.indexOf('export function phase1Title');
  const block = s.slice(i, i + 420);
  assert.match(block, /إشعار دائن مرتجع/, 'عنوان المرتجع مفقود');
  // المرتجع يسبق فحص الدولة: عنوانه واحدٌ في كل الأسواق
  assert.ok(block.indexOf('إشعار دائن مرتجع') < block.indexOf('saudi'), 'المرتجع صار مشروطاً بالدولة');
});
