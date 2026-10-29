import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitVanMovement } from './vanMovement';

test('السالب يخرج بقيمته المطلقة — تمريره سالبا يقلب رصيد السيارة', () => {
  const { out, back } = splitVanMovement([{ productId: 'p', qty: -30 }]);
  assert.equal(out.length, 0);
  assert.deepEqual(back, [{ productId: 'p', qty: 30 }]);
});

test('الموجب تحميل والسالب تنزيل — والمختلطة وثيقتان', () => {
  const { out, back } = splitVanMovement([
    { productId: 'a', qty: 10 },
    { productId: 'b', qty: -4 },
    { productId: 'c', qty: 7 },
  ]);
  assert.deepEqual(out.map(i => i.productId), ['a', 'c']);
  assert.deepEqual(back, [{ productId: 'b', qty: 4 }]);
});

test('المرتجع يتجرد من المقترح والتنبؤ — لا يلوث قياس دقة الاقتراح', () => {
  const { back } = splitVanMovement([{ productId: 'p', qty: -5, suggestedQty: 40, expectedQty: 33 }]);
  assert.deepEqual(back, [{ productId: 'p', qty: 5 }]);
  assert.ok(!('suggestedQty' in back[0]), 'المقترح قرار تحميل لا يخص المرتجع');
});

test('التحميل يحتفظ بالمقترح والتنبؤ — بهما وحدهما تقاس جودة الاقتراح', () => {
  const { out } = splitVanMovement([{ productId: 'p', qty: 40, suggestedQty: 40, expectedQty: 33 }]);
  assert.equal(out[0].suggestedQty, 40);
  assert.equal(out[0].expectedQty, 33);
});

test('الاصفار وغير الارقام تسقط — سطر فارغ ليس حركة', () => {
  const { out, back } = splitVanMovement([
    { productId: 'a', qty: 0 },
    { productId: 'b', qty: Number.NaN },
    { productId: 'c', qty: 5 },
  ]);
  assert.deepEqual(out.map(i => i.productId), ['c']);
  assert.equal(back.length, 0);
});

test('حركة كلها سالبة لا تنشئ وثيقة تحميل فارغة', () => {
  const { out, back } = splitVanMovement([{ productId: 'a', qty: -1 }, { productId: 'b', qty: -2 }]);
  assert.equal(out.length, 0, 'وثيقة بلا بنود يرفضها الخادم بـ400');
  assert.equal(back.length, 2);
});

// ——— الوحدات المتعددة: الوحدة تمرّ في الاتجاهين ———

test('تنزيل الكرتون يبقى كرتونا — الوحدة تمر في بند التنزيل', () => {
  const { back } = splitVanMovement([{ productId: 'p', qty: -2, unitId: 'u-ctn' }]);
  assert.deepEqual(back, [{ productId: 'p', qty: 2, unitId: 'u-ctn' }], 'بلا unitId يدخل المستودع حبتين بصمت');
});

test('التحميل يحمل وحدته ومقترحه ومتنبأه بالأساس معا', () => {
  const { out } = splitVanMovement([{ productId: 'p', qty: 3, unitId: 'u-ctn', suggestedQty: 72, expectedQty: 60 }]);
  assert.equal(out[0].unitId, 'u-ctn');
  assert.equal(out[0].qty, 3, 'الكمية بوحدة السطر لا تحول');
  assert.equal(out[0].suggestedQty, 72, 'المقترح بالأساس كما اخرجه المحرك');
});

test('بند الأساس بلا حقل وحدة — جسم صنف بلا وحدات كما كان حرفيا', () => {
  const { out, back } = splitVanMovement([
    { productId: 'a', qty: 4, unitId: null },
    { productId: 'b', qty: -1 },
    { productId: 'c', qty: -6, unitId: null },
  ]);
  assert.ok(!('unitId' in out[0]), 'null = الأساس لا يرسل');
  assert.deepEqual(back, [{ productId: 'b', qty: 1 }, { productId: 'c', qty: 6 }]);
});

test('الصنف بوحدتين في حركة واحدة: لكل سطر وحدته في وثيقته', () => {
  const { out, back } = splitVanMovement([
    { productId: 'p', qty: 5, unitId: 'u-ctn' },
    { productId: 'p', qty: -3 },
  ]);
  assert.deepEqual(out.map(i => [i.productId, i.qty, i.unitId]), [['p', 5, 'u-ctn']]);
  assert.deepEqual(back, [{ productId: 'p', qty: 3 }]);
});

// «تتبّع اللوط»: صفوف التشغيلات تتبع إشارة سطرها
test('تشغيلات التحميل تمر كما هي مع سطرها', () => {
  const lots = [{ lotId: 'l1', qty: 6 }, { lotId: null, qty: 4 }];
  const { out } = splitVanMovement([{ productId: 'p', qty: 10, lots }]);
  assert.deepEqual(out[0].lots, lots);
});

test('تشغيلات التنزيل تقلب الى قيمتها المطلقة مع سطرها — UNLOAD يطرح الموجب', () => {
  const { back } = splitVanMovement([{ productId: 'p', qty: -5, lots: [{ lotId: 'l1', qty: -3 }, { lotId: null, qty: -2 }] }]);
  assert.deepEqual(back, [{ productId: 'p', qty: 5, lots: [{ lotId: 'l1', qty: 3 }, { lotId: null, qty: 2 }] }]);
  // ومن كتبها موجبة على سطر سالب تبقى موجبة: الاتجاه من نوع الوثيقة لا من إشارة الصف
  const { back: b2 } = splitVanMovement([{ productId: 'p', qty: -5, lots: [{ lotId: 'l1', qty: 5 }] }]);
  assert.deepEqual(b2[0].lots, [{ lotId: 'l1', qty: 5 }]);
});

test('تنزيل بلا تشغيلات او بمصفوفة فارغة لا يحمل lots — الخادم يختار المصدر الوحيد', () => {
  const { back } = splitVanMovement([{ productId: 'a', qty: -2 }, { productId: 'b', qty: -3, lots: [] }]);
  assert.deepEqual(back, [{ productId: 'a', qty: 2 }, { productId: 'b', qty: 3 }]);
  assert.ok(!('lots' in back[1]));
});

test('حقول السطر الاضافية تمر مع التحميل — نوع العنصر محفوظ', () => {
  const { out, back } = splitVanMovement([{ productId: 'p', qty: 4, lotNumber: 'A1' }, { productId: 'q', qty: -1, lotNumber: 'B2' }]);
  assert.equal(out[0].lotNumber, 'A1');
  assert.ok(!('lotNumber' in back[0]), 'التنزيل لا ينشئ تشغيلة');
});

test('الوحدة والتشغيلات معا: السطر بالكرتون وصفوف التشغيلات بالاساس لا تضرب في المعامل (D19)', () => {
  const { out, back } = splitVanMovement([
    { productId: 'p', qty: 2, unitId: 'u-ctn', lots: [{ lotId: 'l1', qty: 24 }] },
    { productId: 'p', qty: -1, unitId: 'u-ctn', lots: [{ lotId: 'l1', qty: -12 }] },
  ]);
  assert.equal(out[0].unitId, 'u-ctn');
  assert.deepEqual(out[0].lots, [{ lotId: 'l1', qty: 24 }]);
  assert.deepEqual(back, [{ productId: 'p', qty: 1, unitId: 'u-ctn', lots: [{ lotId: 'l1', qty: 12 }] }]);
});
