import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riyadhParts, riyadhDateTime, isIsoDate, isIsoTime } from './time';

test('حدّ منتصف الليل: 20:59:59Z ما زال أمس في الرياض و21:00:00Z بداية اليوم التالي', () => {
  assert.deepEqual(riyadhParts(new Date('2026-09-13T20:59:59Z')), { date: '2026-09-13', time: '23:59:59' });
  assert.deepEqual(riyadhParts(new Date('2026-09-13T21:00:00Z')), { date: '2026-09-14', time: '00:00:00' });
});

test('حدّ الشهر والسنة: تاريخ UTC في الشهر السابق يصير الشهر التالي بتوقيت الرياض', () => {
  assert.deepEqual(riyadhParts(new Date('2026-01-31T21:30:00Z')), { date: '2026-02-01', time: '00:30:00' });
  assert.deepEqual(riyadhParts(new Date('2026-12-31T21:00:00Z')), { date: '2027-01-01', time: '00:00:00' });
  // عكسياً: منتصف ليل UTC في أول الشهر = 03:00 من نفس اليوم في الرياض (لا يرجع للشهر السابق)
  assert.deepEqual(riyadhParts(new Date('2026-03-01T00:00:00Z')), { date: '2026-03-01', time: '03:00:00' });
});

test('يوم كبيس: 28 فبراير 2028 21:00Z = 29 فبراير في الرياض', () => {
  assert.equal(riyadhParts(new Date('2028-02-28T21:00:00Z')).date, '2028-02-29');
  assert.equal(riyadhParts(new Date('2027-02-28T21:00:00Z')).date, '2027-03-01');
});

test('الكسور تحت الثانية تُقصّ ولا تُقرَّب (لا قفز ليوم تالٍ)', () => {
  assert.deepEqual(riyadhParts(new Date('2026-09-13T20:59:59.999Z')), { date: '2026-09-13', time: '23:59:59' });
});

test('مستقلّ عن منطقة الخادم الزمنية (TZ)', () => {
  const d = new Date('2026-09-13T21:30:05Z');
  const saved = process.env.TZ;
  try {
    const seen = new Set<string>();
    const localHours = new Set<number>();
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Riyadh', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      localHours.add(d.getHours());
      seen.add(JSON.stringify(riyadhParts(d)));
    }
    assert.ok(localHours.size > 1, 'تبديل TZ يجب أن يغيّر الساعة المحلية فعلاً وإلا فالاختبار بلا معنى');
    assert.deepEqual([...seen], [JSON.stringify({ date: '2026-09-14', time: '00:30:05' })]);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('riyadhDateTime بلا Z وبلا كسور', () => {
  assert.equal(riyadhDateTime(new Date('2026-09-14T07:15:30.250Z')), '2026-09-14T10:15:30');
});

test('تاريخ غير صالح يُرفض', () => {
  assert.throws(() => riyadhParts(new Date('not a date')), RangeError);
});

test('isIsoDate يرفض تواريخ غير تقويمية وصيغاً أخرى', () => {
  assert.equal(isIsoDate('2026-09-14'), true);
  assert.equal(isIsoDate('2028-02-29'), true);
  assert.equal(isIsoDate('2027-02-29'), false);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('2026-9-14'), false);
  assert.equal(isIsoDate('2026-09-14T00:00:00Z'), false);
  assert.equal(isIsoTime('23:59:59'), true);
  assert.equal(isIsoTime('24:00:00'), false);
  assert.equal(isIsoTime('10:15:30Z'), false);
});
