import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeWarehouse } from '../services/warehouseStock';

const P = [
  { id: 'a', name: 'صنف أ', code: 'A', unit: 'كرتون' },
  { id: 'b', name: 'صنف ب', code: 'B', unit: 'كرتون' },
];
const byId = (rows: ReturnType<typeof composeWarehouse>, id: string) => rows.find((r) => r.productId === id)!;

test('الرصيد = الوارد − المحمّل للسيارات + العائد منها (الارتباط الأساسيّ)', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 100, type: 'RECEIVE' }],
    [
      { productId: 'a', qty: 30, type: 'LOAD' },   // خرج للسيارة
      { productId: 'a', qty: 5, type: 'UNLOAD' },   // عاد للمستودع
    ],
  );
  const a = byId(rows, 'a');
  assert.equal(a.received, 100);
  assert.equal(a.loadedToVans, 30);
  assert.equal(a.returnedFromVans, 5);
  assert.equal(a.onHand, 100 - 30 + 5); // 75
});

test('تسوية المستودع تدخل الرصيد (+/−)، وتسوية السيارة لا تمسّه', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 50, type: 'RECEIVE' }, { productId: 'a', qty: -4, type: 'ADJUST' }],
    [{ productId: 'a', qty: 999, type: 'ADJUST' }], // تسوية سيارة — يجب تجاهلها هنا
  );
  const a = byId(rows, 'a');
  assert.equal(a.adjusted, -4);
  assert.equal(a.loadedToVans, 0);
  assert.equal(a.onHand, 50 - 4); // 46 — تسوية السيارة لم تؤثّر
});

test('كل المنتجات تظهر ولو بلا حركة (المستودع مرجع كامل)', () => {
  const rows = composeWarehouse(P, [], []);
  assert.equal(rows.length, 2);
  assert.equal(byId(rows, 'b').onHand, 0);
});

test('الرصيد قد يكون سالباً حين يُحمَّل أكثر من الوارد (مؤشّر نقص)', () => {
  const rows = composeWarehouse(P, [{ productId: 'a', qty: 10, type: 'RECEIVE' }], [{ productId: 'a', qty: 25, type: 'LOAD' }]);
  assert.equal(byId(rows, 'a').onHand, -15);
});

test('الترتيب تنازليّ بالرصيد', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 5, type: 'RECEIVE' }, { productId: 'b', qty: 40, type: 'RECEIVE' }],
    [],
  );
  assert.equal(rows[0].productId, 'b'); // الأكبر أولاً
});
