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

test('تصنيف ZATCA مشروط بالسعودية في مستند الشاشة', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  const i = s.indexOf('const docTitle');
  assert.ok(i > 0, 'docTitle غير موجود');
  const block = s.slice(i, i + 420);
  assert.match(block, /!isSaudiDoc\(doc\.company\)/, 'العنوان لا يفحص الدولة');
  // الشرط يجب أن يسبق تصنيف مبسّطة/ضريبية وإلا طُبع قبل أن يُفحص
  assert.ok(block.indexOf('isSaudiDoc') < block.indexOf('مبسطة'), 'فحص الدولة يجب أن يسبق التصنيف');
});

test('الطباعة الحرارية تحمل الشرط نفسه — لا يكفي إصلاح الشاشة', () => {
  const s = read('src', 'rep', 'thermal.ts');
  assert.match(s, /isSaudiDoc/, 'الطباعة الحرارية تطبع التصنيف بلا فحص الدولة');
  const i = s.indexOf('const title');
  const block = s.slice(i, i + 320);
  assert.ok(block.indexOf('isSaudiDoc') < block.indexOf('مبسطة'), 'فحص الدولة يجب أن يسبق التصنيف');
});

test('المرتجع يبقى «إشعار دائن مرتجع» في كل الدول', () => {
  for (const [f, g] of [['RepDocuments.tsx', 'src/rep'], ['thermal.ts', 'src/rep']] as const) {
    const s = read(...g.split('/'), f);
    assert.match(s, /إشعار دائن مرتجع/, `${f} فقد عنوان المرتجع`);
  }
});
