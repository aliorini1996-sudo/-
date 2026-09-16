// M1 — تواريخ الدفاتر (DESIGN.md §2.5، §10.1 M1): التاريخ المحلي، السنة المالية، الأسبوع، وموعد الإقرار.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TIMEZONE, localDate, todayLocal, zonedStartOfDay, timeZoneOffsetMs, isValidTimeZone,
  isLocalDate, parseLocalDate, formatLocalDate, toDbDate, fromDbDate, addDays, diffDays, addMonths,
  compareLocalDate, maxLocalDate, minLocalDate, startOfMonth, endOfMonth, daysInMonth, isLeapYear,
  dayOfWeek, monthKey, yearKey, closingPeriodKey, weekStart, weekKey, fiscalYearOf, fiscalYearStart,
  fiscalYearEnd, taxDueDate,
} from '../services/gl/dates';

test('منتصف الليل: UTC مقابل الرياض', () => {
  assert.equal(DEFAULT_TIMEZONE, 'Asia/Riyadh');
  // 23:59:59 بالرياض = 20:59:59Z — اليوم نفسه
  assert.equal(localDate('2027-02-28T20:59:59Z'), '2027-02-28');
  // 00:00 بالرياض = 21:00Z — اليوم التالي محلياً بينما UTC ما زال في السابق
  assert.equal(localDate('2027-02-28T21:00:00Z'), '2027-03-01');
  assert.equal(localDate('2027-02-28T21:00:00Z', 'UTC'), '2027-02-28');
  // الافتراضي الرياض لا منطقة الخادم
  assert.equal(localDate(new Date('2026-12-31T21:30:00Z')), '2027-01-01');
  assert.equal(localDate(Date.parse('2026-12-31T21:30:00Z'), 'UTC'), '2026-12-31');
  assert.equal(todayLocal(new Date('2026-09-15T22:00:00Z'), 'Asia/Riyadh'), '2026-09-16');
  // منطقة غرب UTC
  assert.equal(localDate('2026-01-01T03:00:00Z', 'America/New_York'), '2025-12-31');
  assert.throws(() => localDate('not a date'), RangeError);
});

test('zonedStartOfDay: أول لحظة من اليوم المحلي', () => {
  assert.equal(zonedStartOfDay('2027-03-01', 'Asia/Riyadh').toISOString(), '2027-02-28T21:00:00.000Z');
  assert.equal(zonedStartOfDay('2027-03-01', 'UTC').toISOString(), '2027-03-01T00:00:00.000Z');
  // حد lockSyncBlockers: أثر 23:59 يوم الإقفال بالرياض داخل الحد، و00:00 من اليوم التالي خارجه
  const bound = zonedStartOfDay(addDays('2027-03-31', 1), 'Asia/Riyadh');
  assert.ok(new Date('2027-03-31T20:59:00Z') < bound);
  assert.ok(!(new Date('2027-03-31T21:00:00Z') < bound));
  // نيويورك: يوم بدء التوقيت الصيفي (القفزة 02:00) — منتصف الليل ما زال بتوقيت الشتاء
  assert.equal(zonedStartOfDay('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(zonedStartOfDay('2026-07-01', 'America/New_York').toISOString(), '2026-07-01T04:00:00.000Z');
  // ساو باولو 2018-11-04: القفزة عند منتصف الليل (00:00 غير موجودة) ⇒ أول لحظة 01:00 محلياً
  assert.equal(zonedStartOfDay('2018-11-04', 'America/Sao_Paulo').toISOString(), '2018-11-04T03:00:00.000Z');
  assert.equal(localDate(zonedStartOfDay('2018-11-04', 'America/Sao_Paulo'), 'America/Sao_Paulo'), '2018-11-04');
  assert.equal(timeZoneOffsetMs('2027-01-01T00:00:00Z', 'Asia/Riyadh'), 3 * 3_600_000);
  assert.equal(isValidTimeZone('Asia/Riyadh'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

test('التحقق والتحويل من/إلى @db.Date', () => {
  assert.equal(isLocalDate('2028-02-29'), true);
  assert.equal(isLocalDate('2027-02-29'), false);
  assert.equal(isLocalDate('2027-13-01'), false);
  assert.equal(isLocalDate('2027-1-01'), false);
  assert.equal(isLocalDate(20270101), false);
  assert.deepEqual(parseLocalDate('2027-04-30'), { y: 2027, m: 4, d: 30 });
  assert.throws(() => parseLocalDate('2027-04-31'), RangeError);
  assert.equal(formatLocalDate(2027, 1, 5), '2027-01-05');
  assert.equal(toDbDate('2027-03-01').toISOString(), '2027-03-01T00:00:00.000Z');
  assert.equal(fromDbDate(new Date('2027-03-01T00:00:00.000Z')), '2027-03-01');
  assert.equal(fromDbDate(toDbDate('2028-02-29')), '2028-02-29');
});

test('الحساب التقويمي', () => {
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(diffDays('2027-01-31', '2027-03-02'), 30);
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2027-11-15', 3), '2028-02-15');
  assert.equal(addMonths('2027-01-15', -2), '2026-11-15');
  assert.equal(compareLocalDate('2027-01-02', '2027-01-10'), -1);
  assert.equal(maxLocalDate('2027-01-02', '2027-03-01', '2026-12-31'), '2027-03-01');
  assert.equal(minLocalDate('2027-01-02', '2027-03-01', '2026-12-31'), '2026-12-31');
  assert.equal(startOfMonth('2027-02-17'), '2027-02-01');
  assert.equal(endOfMonth('2027-02-17'), '2027-02-28');
  assert.equal(endOfMonth('2028-02-01'), '2028-02-29');
  assert.equal(daysInMonth(2100, 2), 28);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(2100), false);
});

test('مفاتيح الشهر والسنة والإقفال والأسبوع', () => {
  assert.equal(monthKey('2026-09-16'), '2026-09');
  assert.equal(yearKey('2026-09-16'), '2026');
  assert.equal(closingPeriodKey('2027-03-31'), '2027-CL');
  // 2026-09-16 أربعاء
  assert.equal(dayOfWeek('2026-09-16'), 3);
  assert.equal(weekStart('2026-09-16', 0), '2026-09-13'); // الأحد
  assert.equal(weekStart('2026-09-16', 6), '2026-09-12'); // السبت
  assert.equal(weekStart('2026-09-16', 1), '2026-09-14'); // الاثنين
  assert.equal(weekStart('2026-09-13', 0), '2026-09-13');
  assert.equal(weekKey('2027-01-01', 0), '2026-12-27'); // يعبر حد السنة
  assert.throws(() => weekStart('2026-09-16', 7), RangeError);
});

test('السنة المالية: تقويمية وغير تقويمية', () => {
  assert.deepEqual(fiscalYearOf('2026-09-16'), { start: '2026-01-01', end: '2026-12-31' });
  assert.deepEqual(fiscalYearOf('2026-12-31', 12, 31), { start: '2026-01-01', end: '2026-12-31' });
  // تنتهي 31 مارس
  assert.deepEqual(fiscalYearOf('2026-05-01', 3, 31), { start: '2026-04-01', end: '2027-03-31' });
  assert.deepEqual(fiscalYearOf('2026-03-31', 3, 31), { start: '2025-04-01', end: '2026-03-31' });
  assert.deepEqual(fiscalYearOf('2026-04-01', 3, 31), { start: '2026-04-01', end: '2027-03-31' });
  assert.deepEqual(fiscalYearOf('2027-01-15', 3, 31), { start: '2026-04-01', end: '2027-03-31' });
  // تنتهي 30 يونيو
  assert.equal(fiscalYearStart('2026-07-01', 6, 30), '2026-07-01');
  assert.equal(fiscalYearEnd('2026-06-30', 6, 30), '2026-06-30');
  // تنتهي آخر فبراير (29 تُقصّ في غير الكبيسة)
  assert.deepEqual(fiscalYearOf('2027-02-28', 2, 29), { start: '2026-03-01', end: '2027-02-28' });
  assert.deepEqual(fiscalYearOf('2028-02-29', 2, 29), { start: '2027-03-01', end: '2028-02-29' });
  assert.deepEqual(fiscalYearOf('2027-03-01', 2, 29), { start: '2027-03-01', end: '2028-02-29' });
  assert.throws(() => fiscalYearOf('2026-01-01', 13, 1), RangeError);
  assert.throws(() => fiscalYearOf('2026-01-01', 12, 0), RangeError);
});

test('taxDueDate بقاعدة END_OF_NEXT_MONTH: متجهات §10.1 M1', () => {
  assert.equal(taxDueDate('2027-01-31', 'END_OF_NEXT_MONTH'), '2027-02-28');
  assert.equal(taxDueDate('2028-01-31', 'END_OF_NEXT_MONTH'), '2028-02-29'); // كبيسة
  assert.equal(taxDueDate('2027-03-31', 'END_OF_NEXT_MONTH'), '2027-04-30'); // نهاية ربع
  // لا periodEnd + 30
  assert.notEqual(taxDueDate('2027-01-31', 'END_OF_NEXT_MONTH'), addDays('2027-01-31', 30));
  assert.equal(taxDueDate('2026-12-31', 'END_OF_NEXT_MONTH'), '2027-01-31'); // عبر السنة
  assert.equal(taxDueDate('2027-06-30', 'END_OF_NEXT_MONTH', null), '2027-07-31');
});

test('taxDueDate بقاعدة DAYS_AFTER = periodEnd + taxDeadlineDays', () => {
  assert.equal(taxDueDate('2027-01-31', 'DAYS_AFTER', 30), '2027-03-02');
  assert.equal(taxDueDate('2028-01-31', 'DAYS_AFTER', 30), '2028-03-01');
  assert.equal(taxDueDate('2027-03-31', 'DAYS_AFTER', 28), '2027-04-28');
  assert.equal(taxDueDate('2027-12-31', 'DAYS_AFTER', 0), '2027-12-31');
  for (const d of ['2027-01-31', '2027-03-31', '2028-02-29', '2026-12-31']) {
    for (const n of [1, 15, 30, 45, 60]) assert.equal(taxDueDate(d, 'DAYS_AFTER', n), addDays(d, n));
  }
  assert.throws(() => taxDueDate('2027-01-31', 'DAYS_AFTER'), RangeError);
  assert.throws(() => taxDueDate('2027-01-31', 'DAYS_AFTER', null), RangeError);
  assert.throws(() => taxDueDate('2027-01-31', 'DAYS_AFTER', -1), RangeError);
  assert.throws(() => taxDueDate('2027-01-31', 'DAYS_AFTER', 2.5), RangeError);
  assert.throws(() => taxDueDate('2027-01-31', 'WHENEVER' as never), RangeError);
});

test('dates.ts صرف: لا prisma ولا دوال Date المحلية', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'gl', 'dates.ts'), 'utf8');
  assert.doesNotMatch(src, /prisma|@prisma\/client|node:fs|from ['"]fs['"]/);
  assert.doesNotMatch(src, /\.(getDate|getMonth|getFullYear|getHours|getDay|getTimezoneOffset|setDate|setHours)\(/);
});
