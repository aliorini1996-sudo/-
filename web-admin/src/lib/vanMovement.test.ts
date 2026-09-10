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
