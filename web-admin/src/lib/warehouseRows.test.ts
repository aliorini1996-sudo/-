import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowState, isDormant, splitDormant, lowStockCount, normalizeProductName, duplicateNames, isDuplicateName,
  valueBreakdown, costKindOf, rowUnitCost, RATIO_MIN_QTY, signedQty, isZeroQty,
} from './warehouseRows';

/**
 * «مراجعة المخزون» (نوفمبر ٢٠٢٦) — جدول مخزون الشركة للعرض: الموقوف والمحذوف موسومان في الذيل (S1)، والعجز يُقال تحت القيمة
 * (S7)، وتكلفة الكبرى من قيمة الصف (S8)، وعلاماتٌ لا تختلط (S10)، ولا إشارة على الصفر (S9). عرضٌ كلّه.
 */

const row = (o: Partial<{ productId: string; name: string; onHand: number; status: string; archived: boolean }>) => ({
  productId: 'p', name: 'صنف', onHand: 0, ...o,
});

test('S1: حال الصنف — المحذوف يغلب الموقوف، وغياب الحقلين (خادمٌ أقدم) بلا وسم', () => {
  assert.equal(rowState({ archived: true, status: 'ACTIVE' }), 'ARCHIVED', 'صنفٌ أُعيد نشطاً بعد حذفه يبقى محذوفاً');
  assert.equal(rowState({ archived: true, status: 'INACTIVE' }), 'ARCHIVED');
  assert.equal(rowState({ status: 'INACTIVE' }), 'INACTIVE');
  assert.equal(rowState({ status: 'inactive' }), 'INACTIVE');
  assert.equal(rowState({ status: 'ACTIVE', archived: false }), null);
  assert.equal(rowState({}), null);
  assert.equal(rowState(null), null);
  assert.equal(isDormant({ archived: true }), true);
  assert.equal(isDormant({}), false);
});

test('S1: النشط أولاً ثم الموقوف والمحذوف، وكلٌّ بترتيبه كما جاء من الخادم', () => {
  const rows = [
    row({ productId: 'm-new', onHand: 9000 }),
    row({ productId: 'm-old', onHand: -25, archived: true }),
    row({ productId: 'xl', onHand: 0 }),
    row({ productId: 'sp6-old', onHand: -1, status: 'INACTIVE' }),
  ];
  const { active, dormant } = splitDormant(rows);
  assert.deepEqual(active.map(r => r.productId), ['m-new', 'xl']);
  assert.deepEqual(dormant.map(r => r.productId), ['m-old', 'sp6-old']);
  // عدّاد «يحتاج استلام»: XL وحده — القديمان (السالبان) خارجه
  assert.equal(lowStockCount(rows), 1);
  assert.equal(lowStockCount([row({ onHand: -3 }), row({ onHand: 0 }), row({ onHand: 4 })]), 2, 'خادمٌ أقدم بلا حالة ⇒ كما كان');
});

test('S1: الاسم المكرّر بمفتاح الخادم — المسافات والحالة لا تُخفي التوأم، والعربية كما كُتبت (الوسم حيث حذّر الإنشاء)', () => {
  assert.equal(normalizeProductName('كرتون  بيض M '), normalizeProductName('كرتون بيض m'));
  // UX4: بلا تطبيعٍ للعربية — كخادم التحذير (services/productNames.ts) ومخزون السيارات
  assert.notEqual(normalizeProductName('أرز'), normalizeProductName('ارز'));
  assert.notEqual(normalizeProductName('بيضة كبيرة'), normalizeProductName('بيضه كبيره'));
  assert.equal(normalizeProductName(''), '');
  const rows = [{ name: 'كرتون بيض M' }, { name: 'كرتون بيض m ' }, { name: 'كرتون بيض L2' }, { name: '' }, { name: '' }];
  const dup = duplicateNames(rows);
  assert.equal(isDuplicateName(rows[0], dup), true);
  assert.equal(isDuplicateName(rows[1], dup), true);
  assert.equal(isDuplicateName(rows[2], dup), false);
  assert.equal(isDuplicateName(rows[3], dup), false, 'الاسم الفارغ ليس تكراراً');
});

test('S7: تفكيك القيمة الصافية — الموجب والعجز وعدد صفوفه، ولا عجز ⇒ null', () => {
  const b = valueBreakdown([{ stockValue: 2608.7 }, { stockValue: 1485.31 }, { stockValue: 552.08 }, { stockValue: -2543.48 }, { stockValue: -1485.31 }, { stockValue: -104.26 }]);
  assert.ok(b);
  assert.equal(Math.round(b.positive * 100) / 100, 4646.09);
  assert.equal(Math.round(b.deficit * 100) / 100, -4133.05);
  assert.equal(b.deficitCount, 3);
  // المجموع الصافي كما هو (لا يُحذف السالب): الموجب + العجز
  assert.equal(Math.round((b.positive + b.deficit) * 100) / 100, 513.04);
  assert.equal(valueBreakdown([{ stockValue: 5 }, { stockValue: 0 }]), null);
  assert.equal(valueBreakdown([]), null);
});

const cost = (o: Partial<{ onHand: number; avgCost: number; costedQty: number; stockValue: number; uncostedQty: number }>) => ({
  onHand: 0, avgCost: 0, costedQty: 0, stockValue: 0, uncostedQty: 0, ...o,
});

test('S10: معنى خلية التكلفة — مقيَّم، وعجزٌ له قيمة، وعجزٌ قبل أي سعر، وبلا تكلفة، ولا رصيد', () => {
  assert.equal(costKindOf(cost({ onHand: 9000, costedQty: 9000, stockValue: 2608.7, avgCost: 0.2899 })), 'costed');
  assert.equal(costKindOf(cost({ onHand: -25, costedQty: -25, stockValue: -2543.48 })), 'deficit');
  assert.equal(costKindOf(cost({ onHand: -14, costedQty: -14, stockValue: 0 })), 'deficitUncosted', 'عجزٌ قيمته صفر لا «0.00»');
  assert.equal(costKindOf(cost({ onHand: -3 })), 'deficitUncosted', 'رصيدٌ سالب بلا كميةٍ مقيَّمة');
  assert.equal(costKindOf(cost({ onHand: 33, uncostedQty: 33 })), 'uncosted');
  assert.equal(costKindOf(cost({})), 'none');
});

test('S8: تكلفة الكرتون من قيمة الصف — الكمية × التكلفة = قيمة الصف المعروضة', () => {
  // 25 كرتون (9000 بيضة، الكرتون 360) قيمتها 2,608.70 ومتوسّط البيضة المقرَّب 0.2899 (×360 = 104.364، خطأ)
  const m = cost({ onHand: 9000, costedQty: 9000, stockValue: 2608.7, avgCost: 0.2899 });
  const ctn = rowUnitCost(m, 360)!;
  assert.equal(Math.round(ctn * 1000) / 1000, 104.348);
  assert.equal(Math.round(ctn * 25 * 100) / 100, 2608.7);
  // للأساس متوسّط الخادم كما هو
  assert.equal(rowUnitCost(m, 1), 0.2899);
  // كميةٌ مقيَّمة صغيرة: قيمةٌ مقرَّبة بخانتين أقلّ دقّة من المتوسّط ⇒ المتوسّط × المعامل كما كان
  const one = cost({ onHand: 1, costedQty: 1, stockValue: 0.31, avgCost: 0.3068 });
  assert.ok(1 < RATIO_MIN_QTY);
  assert.equal(rowUnitCost(one, 360), 0.3068 * 360);
  // لا تكلفة ⇒ null
  assert.equal(rowUnitCost(cost({ onHand: 33, uncostedQty: 33 }), 360), null);
  assert.equal(rowUnitCost(cost({}), 1), null);
});

test('S10: «تكلفة العجز» = قيمة العجز ÷ كميته (متوسّط الخادم له صفر) — موجبة، وبأي معامل', () => {
  const old = cost({ onHand: -25, costedQty: -25, stockValue: -2543.48, avgCost: 0 });
  assert.equal(Math.round(rowUnitCost(old, 1)! * 100) / 100, 101.74);
  const egg = cost({ onHand: -36, costedQty: -36, stockValue: -10.44, avgCost: 0 });
  assert.equal(Math.round(rowUnitCost(egg, 360)! * 100) / 100, 104.4, 'بالمعامل ولو كانت الكمية دون الحدّ');
  assert.equal(rowUnitCost(cost({ onHand: -14, costedQty: -14, stockValue: 0 }), 1), null, 'عجزٌ بلا قيمة لا تكلفة له');
});

test('S9: لا إشارة على الصفر — «0 كرتون» لا «−0 كرتون»، وغبار العائمة صفر', () => {
  assert.equal(signedQty(0, '−', '0 كرتون'), '0 كرتون');
  assert.equal(signedQty(1e-9, '+', '0 كرتون'), '0 كرتون');
  assert.equal(signedQty(12, '−', '12 كرتون'), '−12 كرتون');
  assert.equal(signedQty(0.004, '+', '0.004'), '+0.004', 'بقيةٌ حقيقية تُطبع بإشارتها');
  assert.equal(isZeroQty(0), true);
  assert.equal(isZeroQty(-0), true);
  assert.equal(isZeroQty(0.1 + 0.2 - 0.3), true);
  assert.equal(isZeroQty(0.0001), false);
});
