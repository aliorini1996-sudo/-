// خادم الإنتاج بتوقيت UTC: الخلل يظهر فيه تحديداً (setHours ومنتصف ليل UTC)
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { statementEntryDateFilter } from '../services/statementRange';
import { importedEntryInstant } from '../services/importTimezoneRebase';
import { explicitTimezone, importTimezone, localDateToInstant } from '../services/importLedger';

/**
 * البند 22 (مراجعة الاستيراد 2026-09-17): كشف حساب العميل بفترة كان يرشّح بمنتصف ليل UTC،
 * والحركة المستوردة بتاريخ 2026-01-01 مخزّنة 2025-12-31T21:00Z (بداية يوم الرياض)،
 * فسقطت من كشف يناير ودخلت المرحَّل وكشف ديسمبر.
 */

const RIYADH = 'Asia/Riyadh';
const imported = localDateToInstant(RIYADH, '2026-01-01');

type F = ReturnType<typeof statementEntryDateFilter>;
function inRange(f: F, d: Date): boolean {
  const e = f.entryDate ?? {};
  if (e.gte && !(d >= e.gte)) return false;
  if (e.lt && !(d < e.lt)) return false;
  if (e.lte && !(d <= e.lte)) return false;
  return true;
}

test('الحركة المستوردة مخزّنة بأول لحظة من يوم الرياض', () => {
  assert.equal(imported.toISOString(), '2025-12-31T21:00:00.000Z');
});

test('كشف يناير يشمل حركة 1 يناير المستوردة ولا يرحّلها', () => {
  const f = statementEntryDateFilter('2026-01-01', '2026-01-31', RIYADH);
  assert.equal(f.zoned, true);
  assert.equal(inRange(f, imported), true);
  assert.ok(f.openingBefore);
  assert.equal(imported < f.openingBefore!, false, 'ليست في الرصيد المرحّل');
  assert.equal(f.entryDate?.gte?.toISOString(), '2025-12-31T21:00:00.000Z');
  assert.equal(f.entryDate?.lt?.toISOString(), '2026-01-31T21:00:00.000Z');
  assert.equal(f.entryDate?.lte, undefined);
  // آخر لحظة من 31 يناير بتوقيت الرياض داخل الفترة، وأول لحظة من فبراير خارجها
  assert.equal(inRange(f, new Date('2026-01-31T20:59:59.999Z')), true);
  assert.equal(inRange(f, localDateToInstant(RIYADH, '2026-02-01')), false);
});

test('كشف ديسمبر لا يضم حركة 1 يناير المستوردة', () => {
  const f = statementEntryDateFilter('2025-12-01', '2025-12-31', RIYADH);
  assert.equal(inRange(f, imported), false);
  const toOnly = statementEntryDateFilter(undefined, '2025-12-31', RIYADH);
  assert.equal(inRange(toOnly, imported), false);
  assert.equal(toOnly.openingBefore, undefined);
});

test('إعادة إنتاج الخلل: الفلتر القديم (غير الصيغة) يُسقطها من يناير ويضمها لديسمبر', () => {
  const jan = { entryDate: { gte: new Date('2026-01-01'), lte: new Date(new Date('2026-01-31').setHours(23, 59, 59, 999)) }, zoned: false };
  assert.equal(inRange(jan as F, imported), false);
  const dec = { entryDate: { lte: new Date(new Date('2025-12-31').setHours(23, 59, 59, 999)) }, zoned: false };
  assert.equal(inRange(dec as F, imported), true);
});

test('غير YYYY-MM-DD ⇒ السلوك القديم حرفياً، وبلا طرفين ⇒ لا فلتر', () => {
  const f = statementEntryDateFilter('2026-01-01T00:00:00Z', '2026-01-31', RIYADH);
  assert.equal(f.zoned, false);
  assert.equal(f.entryDate?.gte?.toISOString(), new Date('2026-01-01T00:00:00Z').toISOString());
  assert.equal(f.entryDate?.lte?.toISOString(), new Date(new Date('2026-01-31').setHours(23, 59, 59, 999)).toISOString());
  assert.equal(f.openingBefore?.toISOString(), new Date('2026-01-01T00:00:00Z').toISOString());
  assert.deepEqual(statementEntryDateFilter(undefined, undefined, RIYADH), { zoned: false });
  assert.deepEqual(statementEntryDateFilter(undefined, undefined, null), { zoned: false });
  assert.equal(statementEntryDateFilter('2026-02-30', undefined, RIYADH).zoned, false);
});

// البند 22 (متابعة): importTimezone تفترض Asia/Riyadh حين لا إعدادات دفاتر (وهي اختيارية ومطفأة للجميع)، فكانت
// حدود كشف شركة مصرية أو تركية تنزاح إلى +3: فاتورة 31 يناير 23:30 بالقاهرة (21:30Z) تسقط من يناير إلى فبراير.
test('شركة بلا إعدادات دفاتر: explicitTimezone تعيد null والحدود بمنتصف ليل UTC', () => {
  assert.equal(explicitTimezone(null), null);
  assert.equal(explicitTimezone(undefined), null);
  assert.equal(explicitTimezone({ activatedAt: null, timezone: null }), null);
  assert.equal(explicitTimezone({ activatedAt: null, timezone: '' }), null);
  assert.equal(explicitTimezone({ activatedAt: null, timezone: 'لا-منطقة' }), null);
  // importTimezone بقيت للعرض وحدود «اليوم» وحدهما (تسمية الدفعة، تاريخ البدء) لا لكتابة لحظة قيد — البند 22
  assert.equal(importTimezone(null), 'Asia/Riyadh');
  // التوقيت المضبوط فعلاً — أو مسودة الخطوة 1 قبل التفعيل
  assert.equal(explicitTimezone({ activatedAt: null, timezone: 'Asia/Riyadh' }), 'Asia/Riyadh');
  assert.equal(explicitTimezone({ activatedAt: null, timezone: null, setupDraft: { step1: { timezone: 'Africa/Cairo' } } }), 'Africa/Cairo');
  assert.equal(explicitTimezone({ activatedAt: new Date(), timezone: 'Europe/Istanbul', setupDraft: { step1: { timezone: 'Africa/Cairo' } } }), 'Europe/Istanbul');

  const f = statementEntryDateFilter('2026-01-01', '2026-01-31', null);
  assert.equal(f.zoned, false);
  assert.equal(f.entryDate?.gte?.toISOString(), '2026-01-01T00:00:00.000Z');
  // الحدّ الأعلى صار أول لحظة من اليوم التالي بـUTC صراحةً: setHours كانت تتبع منطقة الخادم لا الشركة
  assert.equal(f.entryDate?.lt?.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(f.entryDate?.lte, undefined);
  assert.equal(f.openingBefore?.toISOString(), '2026-01-01T00:00:00.000Z');
  // فاتورة القاهرة 2026-01-31 23:30 محلياً: تبقى في يناير لشركة بلا توقيت مضبوط
  const cairoLate = new Date('2026-01-31T21:30:00.000Z');
  assert.equal(inRange(f, cairoLate), true);
  // ولشركة ضبطت الرياض: الحدّ بتوقيتها (خارج يناير) — إصلاح البند 22 قائم لمن ضبط توقيته
  assert.equal(inRange(statementEntryDateFilter('2026-01-01', '2026-01-31', RIYADH), cairoLate), false);
});

// البند 22 (البقيّة): الكاتب كان يفترض Asia/Riyadh حين لا إعدادات دفاتر بينما القارئ صار UTC للشركة نفسها،
// فتُكتب حركة 1 فبراير عند 2026-01-31T21:00Z وتُعرض في كشف يناير. المصدر الواحد يُلزم الطرفين بلحظة واحدة.
test('مصدر واحد للحقيقة: importedEntryInstant تكتب ما يقرؤه فلتر الكشف بالضبط', () => {
  // منطقة مضبوطة ⇒ اللحظة نفسها التي يكتبها الاستيراد اليوم (localDateToInstant)
  assert.equal(importedEntryInstant('2026-01-01', RIYADH).getTime(), localDateToInstant(RIYADH, '2026-01-01').getTime());
  // بلا منطقة ⇒ منتصف ليل UTC لا بداية يوم الرياض
  assert.equal(importedEntryInstant('2026-02-01', null).toISOString(), '2026-02-01T00:00:00.000Z');
  assert.throws(() => importedEntryInstant('2026-02-30', null), RangeError);

  const jan = statementEntryDateFilter('2026-01-01', '2026-01-31', null);
  // إعادة إنتاج الخلل: ما كُتب بافتراض الرياض يظهر في كشف يناير رغم أن تاريخه 1 فبراير
  assert.equal(inRange(jan, localDateToInstant(RIYADH, '2026-02-01')), true);
  // بعد توحيد المصدر: كل يوم في شهره
  assert.equal(inRange(jan, importedEntryInstant('2026-02-01', null)), false);
  assert.equal(inRange(jan, importedEntryInstant('2026-01-01', null)), true);
  assert.equal(inRange(jan, importedEntryInstant('2026-01-31', null)), true);
  assert.equal(inRange(jan, importedEntryInstant('2025-12-31', null)), false);
  assert.equal(importedEntryInstant('2026-01-01', null) < jan.openingBefore!, false, 'ليست في الرصيد المرحّل');
  // ومع منطقة مضبوطة: الطرفان على المنطقة نفسها
  const janR = statementEntryDateFilter('2026-01-01', '2026-01-31', RIYADH);
  assert.equal(inRange(janR, importedEntryInstant('2026-01-01', RIYADH)), true);
  assert.equal(inRange(janR, importedEntryInstant('2026-02-01', RIYADH)), false);
});

// البند 22 (الإغلاقة): الكاتب كان يفترض الرياض والقارئ صار بلا افتراض، فلكلٍّ لحظة. الآن `localDateToInstant`
// تقبل null وتنادي `importedEntryInstant` نفسها — فاختبار حركة قرب منتصف الليل يثبت التطابق في الطرفين.
test('تطابق الكاتب والقارئ: حركة 1 فبراير لا تدخل كشف يناير — بلا إعدادات دفاتر وبمنطقة صريحة (+03)', () => {
  for (const tz of [null, RIYADH] as const) {
    const label = tz ?? 'بلا إعدادات';
    // ما يكتبه الاستيراد (localDateToInstant) هو عين ما يقرأ به الفلتر حدوده (importedEntryInstant)
    const written = localDateToInstant(tz, '2026-02-01');
    assert.equal(written.getTime(), importedEntryInstant('2026-02-01', tz).getTime(), label);
    const jan = statementEntryDateFilter('2026-01-01', '2026-01-31', tz);
    const feb = statementEntryDateFilter('2026-02-01', '2026-02-28', tz);
    assert.equal(inRange(jan, written), false, `${label}: حركة 1 فبراير داخل كشف يناير`);
    assert.equal(inRange(feb, written), true, label);
    assert.equal(written < jan.openingBefore!, false, `${label}: حركة فبراير في مرحَّل يناير`);
    // وآخر يوم من يناير يبقى في يناير عند الطرفين
    const lastJan = localDateToInstant(tz, '2026-01-31');
    assert.equal(inRange(jan, lastJan), true, label);
    assert.equal(inRange(feb, lastJan), false, label);
  }
  // الفرق بين الحالتين محسوس: بالرياض (+03) اللحظة 21:00Z من 31 يناير، وبلا إعدادات منتصف ليل 1 فبراير
  assert.equal(localDateToInstant(RIYADH, '2026-02-01').toISOString(), '2026-01-31T21:00:00.000Z');
  assert.equal(localDateToInstant(null, '2026-02-01').toISOString(), '2026-02-01T00:00:00.000Z');
  // إعادة إنتاج الخلل: الكاتب القديم (افتراض الرياض) مع قارئ شركة بلا إعدادات ⇒ فبراير داخل كشف يناير
  assert.equal(inRange(statementEntryDateFilter('2026-01-01', '2026-01-31', null), localDateToInstant(RIYADH, '2026-02-01')), true);
});

test('حارس ثابت: كاتب الاستيراد يبني لحظته بـimportedEntryInstant ويقبل null (لا افتراض منطقة)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'importLedger.ts'), 'utf8');
  assert.ok(src.includes('export function localDateToInstant(tz: string | null, ymd: string): Date {'), 'الكاتب لا يقبل «بلا منطقة»');
  assert.ok(src.includes('return importedEntryInstant(ymd, tz && isValidTimeZone(tz) ? tz : null);'), 'الكاتب على مصدر ثانٍ للحقيقة');
  assert.ok(!src.includes('zonedStartOfDay('), 'لحظة القيد من دالّة المنطقة مباشرة لا من المصدر الواحد');
});

test('حارس ثابت: statementRange يبني حدوده بـimportedEntryInstant للطرفين بلا افتراض منطقة', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'statementRange.ts'), 'utf8');
  assert.match(src, /import \{ importedEntryInstant \} from '\.\/importTimezoneRebase'/);
  assert.match(src, /const start = given\(from\) \? importedEntryInstant\(from, tz\) : undefined/);
  assert.match(src, /lt: importedEntryInstant\(addDays\(to, 1\), tz\)/);
  assert.doesNotMatch(src, /zonedStartOfDay/, 'الحدود من المصدر الواحد لا من دالّة المنطقة مباشرة');
});

test('حارس ثابت: مسار الكشف يستعمل statementEntryDateFilter في where وفي aggregate المرحّل ويعيد timezone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'customers.ts'), 'utf8');
  const start = src.indexOf("router.get('/:id/statement'");
  assert.ok(start >= 0);
  const end = src.indexOf('router.', start + 10);
  const body = src.slice(start, end);
  assert.match(body, /statementEntryDateFilter\(/);
  assert.match(body, /explicitTimezone\(/);
  assert.doesNotMatch(body, /importTimezone\(/, 'افتراض الرياض لشركة بلا إعدادات دفاتر');
  assert.match(body, /entryDate: range\.entryDate/);
  assert.match(body, /aggregate\(\{[\s\S]*?entryDate: \{ lt: range\.openingBefore \}/);
  assert.doesNotMatch(body, /new Date\(from as string\)/);
  assert.doesNotMatch(body, /setHours\(/);
  assert.match(body, /closingBalance, timezone \}/);
});
