// معاينة الصلاحية في اللوحة تطابق قاعدة الخادم (backend/src/tests/shelf-life.test.ts) في الحالات نفسها
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShelfLife, previewExpiry, returnRuleValueProblem } from './shelfLife';

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

test('المعاينة بأساس الشراء: التاريخ المكتوب + المدة، وبلا تاريخ لا معاينة', () => {
  const p = { shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: 'MONTH', shelfLifeBasis: 'PURCHASE' };
  assert.equal(previewExpiry({ ...p, shelfLifeFromDate: '2026-08-31' }, '2026-10-15'), '2027-02-28');
  assert.equal(previewExpiry({ ...p, shelfLifeFromDate: '' }, '2026-10-15'), null);
  // البيع وتحميل السيارة: ما يحدث اليوم
  assert.equal(previewExpiry({ ...p, shelfLifeBasis: 'VAN_LOAD' }, '2026-10-15'), '2027-04-15');
});

test('قيد المرتجع: حدّ صحيح قبل الحفظ، والنسبة لا تتجاوز ١٠٠ (الخادم يتحقّق ثانيةً)', () => {
  assert.equal(returnRuleValueProblem('DAYS', 10), null);
  assert.equal(returnRuleValueProblem('PERCENT', 100), null);
  assert.match(String(returnRuleValueProblem('DAYS', 0)), /أكبر من صفر/);
  assert.match(String(returnRuleValueProblem('DAYS', null)), /أكبر من صفر/);
  assert.match(String(returnRuleValueProblem('DAYS', 2.5)), /أكبر من صفر/);
  assert.match(String(returnRuleValueProblem('PERCENT', 101)), /١٠٠٪/);
});
