// المشاهد في منطقة غير منطقة الشركة: لندن مقابل الرياض (فرق ٣ ساعات يقلب اليوم عند منتصف الليل)
process.env.TZ = 'Europe/London';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatDate, formatDayOnly } from './format';

/**
 * البند 22: كشف الحساب يُرشَّح على الخادم بأيام الشركة، فحركة ١ يناير بتوقيت الرياض تُخزَّن
 * 2025-12-31T21:00:00Z. عرضها بمنطقة المتصفّح يكتب «٣١ ديسمبر» في رأس كشف يناير.
 */
test('البند 22: formatDate بمنطقة الشركة يعرض يوم الشركة لا يوم المتصفّح', () => {
  const instant = '2025-12-31T21:00:00.000Z'; // ١ يناير ٢٠٢٦ بالرياض · ٣١ ديسمبر ٢٠٢٥ بلندن
  const riyadh = formatDate(instant, 'Asia/Riyadh');
  // اليوم نفسه الذي تعطيه لحظةُ ظهرِ أول يناير بالرياض (مقارنة لا تفترض تقويماً ولا صياغة)
  assert.equal(riyadh, formatDate('2026-01-01T09:00:00.000Z', 'Asia/Riyadh'));
  // وبلا منطقة (منطقة المتصفّح): اليوم السابق — وهو عين الخلل
  assert.equal(formatDate(instant), formatDate('2025-12-31T12:00:00.000Z'));
  assert.notEqual(riyadh, formatDate(instant));
  // منطقة غير صالحة لا تُسقط الشاشة: ارتداد إلى منطقة المتصفّح
  assert.equal(formatDate(instant, 'Not/AZone'), formatDate(instant));
  // ويومٌ خالص من <input type="date"> يُقرأ بأجزائه بلا إزاحة
  assert.equal(formatDayOnly('2026-01-01'), formatDayOnly('2026-01-01T23:30:00'));
  assert.equal(formatDate('غير تاريخ', 'Asia/Riyadh'), '-');
});

/**
 * البند 22 (نصف الإصلاح): الخادم يعيد `timezone: string | null` — و`null` حالٌ حقيقيّة
 * (شركة بلا منطقة مضبوطة) لا خطأ. فلو رفضها توقيع `formatDate` لاضطرّت كلّ شاشة إلى
 * تحويلها بنفسها أو لكسر `tsc`، ولو عاملها كمنطقةٍ صالحة لسقط العرض.
 */
test('البند 22: null و undefined منطقتان غائبتان لا كاسرتان — ارتداد إلى المتصفّح', () => {
  const instant = '2025-12-31T21:00:00.000Z';
  const browser = formatDate(instant);
  assert.equal(formatDate(instant, null), browser, '`null` يجب أن يرتدّ إلى منطقة المتصفّح');
  assert.equal(formatDate(instant, undefined), browser);
  assert.equal(formatDate(instant, ''), browser, 'منطقة فارغة كالغائبة');
  // والمنطقة الصريحة تبقى مقدَّمة على الارتداد
  assert.notEqual(formatDate(instant, 'Asia/Riyadh'), browser);
  // التوقيع نفسه يقبل الثلاثة — حارسٌ نصّيّ كي لا يضيق ثانيةً فيكسر الشاشات
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src', 'utils', 'format.ts'), 'utf8');
  assert.match(src, /export function formatDate\(date: string \| Date, timeZone\?: string \| null\)/,
    'توقيع formatDate لا يقبل null فتكسر كلّ شاشةٍ تمرّر ما يعيده الخادم');
});

test('البند 22: نافذة كشف الحساب تمرّر منطقة الشركة إلى كل تاريخ حركة', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'forms', 'CustomerStatementModal.tsx'), 'utf8');
  // نوع الاستجابة كما يعيده الخادم حرفاً بحرف: منطقةٌ أو لا منطقة
  assert.match(src, /timezone\?: string \| null/, 'نوع الاستجابة يضيّق null التي يعيدها الخادم');
  assert.match(src, /const tz = statementZone\(data\?\.timezone\);/, 'الشاشة لا تستعمل قاعدة المنطقة المشتركة');
  // كلّ تاريخ حركة — على الشاشة وفي ملف Excel — بمنطقة الشركة
  assert.equal((src.match(/formatDate\(e\.entryDate, tz\)/g) || []).length, 2,
    'موضعا تاريخ الحركة (الجدول وتصدير Excel) يجب أن يمرّا بمنطقة الشركة');
  assert.doesNotMatch(src, /formatDate\(e\.entryDate\)/, 'تاريخ حركة بلا منطقة الشركة');
  // وحدّا الفترة يومان خالصان: لا منطقة تُزيحهما، لا على الشاشة ولا في الملف
  assert.equal((src.match(/formatDayOnly\(from\)/g) || []).length, 2,
    'صفّ «رصيد مرحل» على الشاشة وفي Excel يجب أن يقرأ اليوم بأجزائه');
  assert.doesNotMatch(src, /formatDate\(from\)/);
  // والخادم يعيد المنطقة فعلاً في كشف الحساب
  const route = fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', 'routes', 'customers.ts'), 'utf8');
  assert.match(route, /timezone/, 'مسار كشف الحساب في الخادم بلا timezone');
});
