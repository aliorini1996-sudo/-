import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupCollectionsByRep, collectionTotals, NO_REP, CollReceiptLike } from './collectionsByRep';

const rc = (over: Partial<CollReceiptLike> & { amount: number | string }): CollReceiptLike => ({
  id: Math.abs(Number(over.amount)) + ':' + (over.salesRep?.id || 'x') + ':' + (over.paymentMethod || 'CASH'),
  receiptNumber: 'R-1', paymentMethod: 'CASH', receiptDate: '2026-09-20T08:00:00.000Z',
  customer: { id: 'c1', name: 'عميل' }, salesRep: null, ...over,
});
const REP_A = { id: 'a', name: 'أحمد' };
const REP_B = { id: 'b', name: 'حسام' };

test('التجميع: مندوبان بمجاميعهما وعدد سنداتهما', () => {
  const rows = groupCollectionsByRep([
    rc({ amount: 1000, salesRep: REP_A }),
    rc({ amount: 500, salesRep: REP_A, paymentMethod: 'POS' }),
    rc({ amount: 700, salesRep: REP_B }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.name, r.count, r.total]), [['أحمد', 2, 1500], ['حسام', 1, 700]]);
  assert.deepEqual(rows[0].byMethod, { CASH: 1000, POS: 500 });
});

test('الترتيب تنازليّ بالإجمالي', () => {
  const rows = groupCollectionsByRep([rc({ amount: 10, salesRep: REP_A }), rc({ amount: 90, salesRep: REP_B })]);
  assert.deepEqual(rows.map(r => r.name), ['حسام', 'أحمد']);
});

/** سندٌ من اللوحة، أو سندُ مندوبٍ حُذف (onDelete: SetNull). */
test('سند بلا مندوب: لا يسقط من التقرير ولا من المجموع', () => {
  const rows = groupCollectionsByRep([rc({ amount: 1000, salesRep: REP_A }), rc({ amount: 250, salesRep: null })]);
  assert.equal(rows.length, 2);
  assert.equal(collectionTotals(rows).total, 1250, 'إسقاطه يعني اختفاء مال محصل');
  const none = rows.find(r => r.id === NO_REP)!;
  assert.equal(none.total, 250);
  assert.equal(none.name, '', 'الاسم فارغ هنا وتترجمه الواجهة');
});

test('دلو بلا مندوب آخر الجدول ولو كان الأكبر', () => {
  const rows = groupCollectionsByRep([rc({ amount: 5, salesRep: REP_A }), rc({ amount: 9999, salesRep: null })]);
  assert.deepEqual(rows.map(r => r.id), ['a', NO_REP]);
});

test('مبلغ نصّي من JSON يُجمع رقماً', () => {
  const rows = groupCollectionsByRep([rc({ amount: '1200.50', salesRep: REP_A })]);
  assert.equal(rows[0].total, 1200.5);
});

test('مبلغ تالف لا يسمّم المجموع بـNaN', () => {
  const rows = groupCollectionsByRep([rc({ amount: 'x' as unknown as number, salesRep: REP_A }), rc({ amount: 300, salesRep: REP_A })]);
  assert.equal(rows[0].total, 300);
  assert.equal(rows[0].count, 2, 'السند يبقى معدودا فلا يختفي من السجل');
});

test('لا سندات أو مدخل غير مصفوفة: قائمة فارغة لا انهيار', () => {
  for (const bad of [undefined, null, [] as CollReceiptLike[]]) {
    assert.deepEqual(groupCollectionsByRep(bad), []);
  }
  assert.deepEqual(collectionTotals([]), { total: 0, count: 0 });
});

test('غبار العائمة لا يظهر في المجموع', () => {
  const rows = groupCollectionsByRep([rc({ amount: 0.1, salesRep: REP_A }), rc({ amount: 0.2, salesRep: REP_B })]);
  assert.equal(collectionTotals(rows).total, 0.3); // لا 0.30000000000000004
});

test('المجموع يطابق مجموع السندات كائناً ما كان توزيعها', () => {
  const amounts = [1234.56, 78.9, 0.01, 4321, 99.99];
  const rows = groupCollectionsByRep(amounts.map((a, i) => rc({ amount: a, salesRep: i % 3 === 0 ? null : (i % 2 ? REP_A : REP_B) })));
  const expected = Math.round(amounts.reduce((s, a) => s + a, 0) * 1e6) / 1e6;
  assert.equal(collectionTotals(rows).total, expected);
  assert.equal(collectionTotals(rows).count, amounts.length);
});

/** حارس نصّ: الشاشة تقرأ من هذه الوحدة لا من نسخةٍ ثانية من الحساب. */
test('حارس ثابت: صفحة التقارير تستعمل هذه الوحدة', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ReportsPage.tsx'), 'utf8');
  assert.match(s, /from '\.\.\/lib\/collectionsByRep'/, 'نسختان من حساب المال تنحرفان بصمت');
  assert.match(s, /groupCollectionsByRep\(/);
  assert.match(s, /collectionTotals\(/);
});
