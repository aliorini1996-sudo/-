import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeWarehouse } from '../services/warehouseStock';
import { netUnitCost, lineCost, entryTotalCost, weightedAvgCost, stockValue } from '../services/warehouseCost';

const P = [
  { id: 'a', name: 'صنف أ', code: 'A', unit: 'كرتون' },
  { id: 'b', name: 'صنف ب', code: 'B', unit: 'كرتون' },
];
const byId = (rows: ReturnType<typeof composeWarehouse>, id: string) => rows.find((r) => r.productId === id)!;

test('الرصيد = الوارد − المحمل للسيارات + العائد منها (الارتباط الأساسي)', () => {
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

test('تسوية المستودع تدخل الرصيد (+/−)، وتسوية السيارة لا تمسه', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 50, type: 'RECEIVE' }, { productId: 'a', qty: -4, type: 'ADJUST' }],
    [{ productId: 'a', qty: 999, type: 'ADJUST' }], // تسوية سيارة — يجب تجاهلها هنا
  );
  const a = byId(rows, 'a');
  assert.equal(a.adjusted, -4);
  assert.equal(a.loadedToVans, 0);
  assert.equal(a.onHand, 50 - 4); // 46 — تسوية السيارة لم تؤثر
});

test('كل المنتجات تظهر ولو بلا حركة (المستودع مرجع كامل)', () => {
  const rows = composeWarehouse(P, [], []);
  assert.equal(rows.length, 2);
  assert.equal(byId(rows, 'b').onHand, 0);
});

test('الرصيد قد يكون سالبا حين يحمل أكثر من الوارد (مؤشر نقص)', () => {
  const rows = composeWarehouse(P, [{ productId: 'a', qty: 10, type: 'RECEIVE' }], [{ productId: 'a', qty: 25, type: 'LOAD' }]);
  assert.equal(byId(rows, 'a').onHand, -15);
});

test('الترتيب تنازلي بالرصيد', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 5, type: 'RECEIVE' }, { productId: 'b', qty: 40, type: 'RECEIVE' }],
    [],
  );
  assert.equal(rows[0].productId, 'b'); // الأكبر أولا
});


// ════════════════════════════════════════════════════════════════════════════
// تقييم المخزون بتكلفة الشراء
// ════════════════════════════════════════════════════════════════════════════

test('السعر الشامل يرد الى صافيه قبل الحفظ — عمود بمعنى واحد', () => {
  assert.equal(netUnitCost(115, 15, true), 100);   // فاتورة المورد شاملة
  assert.equal(netUnitCost(100, 15, false), 100);  // مكتوب صافيا اصلا
  assert.equal(netUnitCost(50, 0, true), 50);      // صنف معفى: لا شيء يستخرج
});

test('تكلفة الوحدة تحفظ باربع خانات — التقريب لخانتين يضيع فلسا في كل مئة وحدة', () => {
  // شراء 3 حبات بريال واحد
  assert.equal(netUnitCost(1 / 3, 0, false), 0.3333);
});

test('قيمة السطر = الكمية × التكلفة، والاجمالي مجموع الاسطر المقربة لا الخام', () => {
  assert.equal(lineCost(10, 2.5), 25);
  assert.equal(lineCost(10, null), 0, 'سطر بلا سعر قيمته صفر لا NaN');
  // ثلاثة اسطر كل منها 0.3333×1 = 0.33 ⇒ 0.99 (لا 1.00) — الاجمالي يطابق ما تجمعه العين
  assert.equal(entryTotalCost([{ qty: 1, unitCost: 0.3333 }, { qty: 1, unitCost: 0.3333 }, { qty: 1, unitCost: 0.3333 }]), 0.99);
});

test('المتوسط مرجح بالكمية لا حسابي — شراء صغير شاذ لا يقلب التقييم', () => {
  const b = weightedAvgCost([{ qty: 1000, unitCost: 1 }, { qty: 10, unitCost: 2 }]);
  assert.equal(b.avgCost, 1.0099);       // لا 1.5
  assert.equal(b.costedQty, 1010);
  assert.equal(b.uncostedQty, 0);
});

test('السطر بلا سعر يستبعد من البسط والمقام — ولا يهبط المتوسط الى الصفر', () => {
  const b = weightedAvgCost([{ qty: 100, unitCost: 5 }, { qty: 100, unitCost: null }]);
  assert.equal(b.avgCost, 5, 'الاستلام قبل وصول الفاتورة لا يجعل المخزون ارخص مما كلف');
  assert.equal(b.uncostedQty, 100, 'وتعلن كميته صراحة بدل ان تخفى في رقم واثق');
});

test('قيمة الرصيد = الرصيد × المتوسط، والرصيد السالب يقيم سالبا', () => {
  assert.equal(stockValue(75, 2), 150);
  assert.equal(stockValue(-15, 2), -30, 'رقم احمر اصدق من صفر يخفي تجاوز التحميل');
  assert.equal(stockValue(75, 0), 0, 'بلا متوسط لا تخمين');
});

test('التقييم يمر عبر حساب الرصيد كاملا: وارد مسعر ثم تحميل', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 3 }],
    [{ productId: 'a', qty: 30, type: 'LOAD' }],
  );
  const a = byId(rows, 'a');
  assert.equal(a.onHand, 70);
  assert.equal(a.avgCost, 3);
  assert.equal(a.stockValue, 210); // 70 × 3
});

test('التسوية لا تدخل المتوسط لكن كميتها تقيم به — جرد لا شراء', () => {
  const rows = composeWarehouse(
    P,
    [{ productId: 'a', qty: 100, type: 'RECEIVE', unitCost: 4 }, { productId: 'a', qty: 10, type: 'ADJUST' }],
    [],
  );
  const a = byId(rows, 'a');
  assert.equal(a.avgCost, 4, 'التسوية بلا ثمن لم تخفض المتوسط');
  assert.equal(a.onHand, 110);
  assert.equal(a.stockValue, 440); // 110 × 4
});

test('صنف بلا وارد مسعر: قيمته صفر لا تخمين', () => {
  const rows = composeWarehouse(P, [{ productId: 'b', qty: 20, type: 'RECEIVE' }], []);
  const b = byId(rows, 'b');
  assert.equal(b.onHand, 20);
  assert.equal(b.avgCost, 0);
  assert.equal(b.stockValue, 0);
  assert.equal(b.uncostedQty, 20);
});
