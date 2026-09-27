// عرض لحظة بيومها: ساعة أمسِ لا تُقرأ وقتاً قادماً (بلاغ المالك: «آخر ظهور ١٠:٤٧ م» صباحاً، و«في العمل منذ ١٠:٥٤ ص» لنوبة أمس)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLabel, formatMoment } from './format';

test('اليوم: الساعة وحدها؛ أمس: «أمس» قبلها؛ الأقدم: التاريخ', () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 22, 47);
  const older = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 10, 54);
  assert.equal(dayLabel(today), '');
  assert.equal(dayLabel(yesterday), 'أمس');
  assert.notEqual(dayLabel(older), '');
  assert.match(formatMoment(yesterday), /^أمس /);
  assert.doesNotMatch(formatMoment(today), /أمس/);
  assert.equal(formatMoment('غير صالح'), '-');
});
