import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeWarehouse } from '../services/warehouseStock';
import { netUnitCost, lineCost, entryTotalCost, valueStock } from '../services/warehouseCost';

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
//
// نسختان سابقتان من هذا الحساب شُحنتا وكانتا خاطئتين، ومرّتا من اختبارات
// «خضراء» لأنها غطّت الطرفين ولم تغطِّ المزيج: صنفا كل وارده مسعّر، وصنفا لا
// وارد مسعّر له إطلاقا — ولا صنفا نصفه مسعّر، ولا سعرين بينهما استهلاك.
// فالاختبارات هنا مكتوبة على المزيج قصدا.
// ════════════════════════════════════════════════════════════════════════════

test('السعر الشامل يرد الى صافيه قبل الحفظ — عمود بمعنى واحد', () => {
  assert.equal(netUnitCost(115, 15, true), 100);
  assert.equal(netUnitCost(100, 15, false), 100);
  assert.equal(netUnitCost(50, 0, true), 50);
});

test('تكلفة الوحدة تحفظ باربع خانات — التقريب لخانتين يضيع فلسا في كل مئة وحدة', () => {
  assert.equal(netUnitCost(1 / 3, 0, false), 0.3333);
});

test('قيمة السطر = الكمية × التكلفة، والاجمالي مجموع الاسطر المقربة لا الخام', () => {
  assert.equal(lineCost(10, 2.5), 25);
  assert.equal(lineCost(10, null), 0, 'سطر بلا سعر قيمته صفر لا NaN');
  assert.equal(entryTotalCost([{ qty: 1, unitCost: 0.3333 }, { qty: 1, unitCost: 0.3333 }, { qty: 1, unitCost: 0.3333 }]), 0.99);
});

// ═══ العيب الاول الذي شُحن: الكمية بلا تكلفة كانت تقيَّم بمتوسط غيرها ═══

test('الكمية بلا تكلفة خارج القيمة فعلا — لا تقيَّم بمتوسط الكمية المسعرة', () => {
  // ١٠٬٠٠٠ وارد قديم بلا سعر + ١٠ بـ١٢. كان الناتج ١٢٠٬١٢٠ والصواب ١٢٠
  const v = valueStock([
    { qty: 10000, kind: 'RECEIVE' },
    { qty: 10, kind: 'RECEIVE', unitCost: 12 },
  ]);
  assert.equal(v.stockValue, 120, 'الفي ضعف: الرصيد كله كان يضرب في متوسط المسعر');
  assert.equal(v.avgCost, 12);
  assert.equal(v.costedQty, 10);
  assert.equal(v.uncostedQty, 10000, 'وتعلن كميتها صراحة بدل ان تخفى في رقم واثق');
});

test('صنف كل رصيده بلا تكلفة: قيمته صفر ولا متوسط له', () => {
  const v = valueStock([{ qty: 20, kind: 'RECEIVE' }]);
  assert.equal(v.stockValue, 0);
  assert.equal(v.avgCost, 0);
  assert.equal(v.costedQty, 0);
  assert.equal(v.uncostedQty, 20);
});

// ═══ العيب الثاني الذي شُحن: بضاعة استُهلكت كانت تجر المتوسط ابدا ═══

test('الطبقة المستهلكة تخرج من المتوسط — التقييم على الباقي لا على تاريخ الشراء', () => {
  // يناير ١٠٠٠ بعشرة بيعت كلها، فبراير ١٠٠٠ بعشرين هي الباقية.
  // كان الناتج متوسط ١٥ وقيمة ١٥٬٠٠٠؛ والصواب ٢٠ و٢٠٬٠٠٠
  const v = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 10 },
    { qty: -1000, kind: 'OTHER' },              // حُملت للسيارات
    { qty: 1000, kind: 'RECEIVE', unitCost: 20 },
  ]);
  assert.equal(v.avgCost, 20);
  assert.equal(v.stockValue, 20000);
});

test('الترتيب الزمني جزء من الصحة: نفس الحركات بترتيب مقلوب تعطي رقما اخر', () => {
  const ordered = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 10 },
    { qty: -1000, kind: 'OTHER' },
    { qty: 1000, kind: 'RECEIVE', unitCost: 20 },
  ]);
  const jumbled = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 10 },
    { qty: 1000, kind: 'RECEIVE', unitCost: 20 },
    { qty: -1000, kind: 'OTHER' },
  ]);
  assert.equal(ordered.stockValue, 20000);
  assert.equal(jumbled.stockValue, 15000, 'ولذلك يُفرز زمنيا في composeWarehouse قبل الاستدعاء');
});

test('المتوسط مرجح بالكمية لا حسابي — شراء صغير شاذ لا يقلب التقييم', () => {
  const v = valueStock([
    { qty: 1000, kind: 'RECEIVE', unitCost: 1 },
    { qty: 10, kind: 'RECEIVE', unitCost: 2 },
  ]);
  assert.equal(v.avgCost, 1.0099); // لا ١٫٥٠
});

test('الصرف ينقص الدلوين بنسبتهما — لا يستنزف المسعر وحده فيتضخم الباقي', () => {
  // ١٠٠ بلا سعر + ١٠٠ بعشرة، ثم خرج ١٠٠ ⇒ يبقى ٥٠ و٥٠
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE' },
    { qty: 100, kind: 'RECEIVE', unitCost: 10 },
    { qty: -100, kind: 'OTHER' },
  ]);
  assert.equal(v.costedQty, 50);
  assert.equal(v.uncostedQty, 50);
  assert.equal(v.stockValue, 500);
  assert.equal(v.avgCost, 10, 'الصرف بالمتوسط لا يغير المتوسط');
});

test('العائد من السيارة يقيَّم بمتوسط اللحظة', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 4 },
    { qty: -30, kind: 'OTHER' },  // حُمل
    { qty: 10, kind: 'OTHER' },   // عاد
  ]);
  assert.equal(v.costedQty, 80);
  assert.equal(v.stockValue, 320);
  assert.equal(v.avgCost, 4);
});

test('التسوية بلا ثمن لا تغير المتوسط لكن كميتها تقيَّم به — جرد لا شراء', () => {
  const v = valueStock([
    { qty: 100, kind: 'RECEIVE', unitCost: 4 },
    { qty: 10, kind: 'OTHER' },
  ]);
  assert.equal(v.avgCost, 4);
  assert.equal(v.stockValue, 440);
});

test('الرصيد السالب يقيَّم سالبا — رقم احمر اصدق من صفر يخفي تجاوز التحميل', () => {
  const v = valueStock([
    { qty: 10, kind: 'RECEIVE', unitCost: 2 },
    { qty: -25, kind: 'OTHER' },
  ]);
  assert.equal(v.costedQty, -15);
  assert.equal(v.stockValue, -30);
});

// ═══ التقييم عبر حساب الرصيد كاملا (لا الدالة النقية وحدها) ═══

test('التقييم يمر عبر composeWarehouse مرتبا زمنيا لا بترتيب المصفوفة', () => {
  const rows = composeWarehouse(
    P,
    [
      // مسجَّلان بترتيب معكوس عمدا: الاحدث اولا كما ترده قاعدة البيانات احيانا
      { productId: 'a', qty: 1000, type: 'RECEIVE', unitCost: 20, at: '2026-02-01' },
      { productId: 'a', qty: 1000, type: 'RECEIVE', unitCost: 10, at: '2026-01-01' },
    ],
    [{ productId: 'a', qty: 1000, type: 'LOAD', at: '2026-01-15' }],
  );
  const a = byId(rows, 'a');
  assert.equal(a.onHand, 1000);
  assert.equal(a.avgCost, 20, 'دفعة يناير خرجت قبل شراء فبراير');
  assert.equal(a.stockValue, 20000);
});

test('صنف نصفه مسعر عبر المسار الكامل — الفجوة التي فاتت النسخة المشحونة', () => {
  const rows = composeWarehouse(
    P,
    [
      { productId: 'a', qty: 10000, type: 'RECEIVE', at: '2026-01-01' },
      { productId: 'a', qty: 10, type: 'RECEIVE', unitCost: 12, at: '2026-01-02' },
    ],
    [],
  );
  const a = byId(rows, 'a');
  assert.equal(a.onHand, 10010);
  assert.equal(a.stockValue, 120);
  assert.notEqual(a.stockValue, a.onHand * a.avgCost, 'القيمة ليست الرصيد كله × المتوسط');
  assert.equal(a.uncostedQty, 10000);
});
