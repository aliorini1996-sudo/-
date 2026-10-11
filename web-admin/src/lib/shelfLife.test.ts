// معاينة الصلاحية في اللوحة تطابق قاعدة الخادم (backend/src/tests/shelf-life.test.ts) في الحالات نفسها
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShelfLife, previewExpiry } from './shelfLife';

test('الحالات نفسها في الخادم: أيام وأشهر تُقصّ وسنوات كبيسة', () => {
  assert.equal(addShelfLife('2026-10-11', 30, 'DAY'), '2026-11-10');
  assert.equal(addShelfLife('2026-01-31', 1, 'MONTH'), '2026-02-28');
  assert.equal(addShelfLife('2027-12-31', 2, 'MONTH'), '2028-02-29');
  assert.equal(addShelfLife('2028-02-29', 1, 'YEAR'), '2029-02-28');
  assert.equal(addShelfLife('2026-10-11', 18, 'MONTH'), '2028-04-11');
});

test('المعاينة: المطفأة أو الناقصة بلا تاريخ', () => {
  assert.equal(previewExpiry({ shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }, '2026-10-11'), '2027-04-11');
  assert.equal(previewExpiry({ shelfLifeEnabled: false, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }, '2026-10-11'), null);
  assert.equal(previewExpiry({ shelfLifeEnabled: true, shelfLifeValue: null, shelfLifeUnit: 'MONTH' }, '2026-10-11'), null);
  assert.equal(previewExpiry({ shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: null }, '2026-10-11'), null);
});
