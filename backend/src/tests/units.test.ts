import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBase, fromBase, baseQtyOf, sumBase, factorOf, unitPriceOf,
  refundPerBase, refundAmount, formatQty, unitProblem, assertFactor, unitFields, QTY_EPS,
} from '../services/units';

/**
 * الوحدات المتعددة — قلب الحساب. القيم من حالة المالك: كرتون = ٢٤ حبة.
 * الخلل الذي تحرسه هذه الملفّات أنّ رقماً بوحدةٍ يُجمع أو يُسعَّر كأنّه بالأساس.
 */
const carton = { unitName: 'كرتون', unitFactor: 24 };
const piece = { unitName: 'حبة', unitFactor: 1 };

test('الكمية بالأساس: كرتونان = ٤٨ حبة', () => {
  assert.equal(toBase(2, carton), 48);
  assert.equal(toBase(5, piece), 5);
});

test('غياب الوحدة أو فسادها ⇒ معامل ١ (سلوك ما قبل الميزة)', () => {
  assert.equal(factorOf(null), 1);
  assert.equal(factorOf({ unitFactor: 0 }), 1);
  assert.equal(factorOf({ unitFactor: -3 }), 1);
  assert.equal(factorOf({ unitFactor: NaN }), 1);
  assert.equal(toBase(7), 7);
});

test('baseQtyOf: العمود المخزَّن يسبق الحساب من اللقطة', () => {
  assert.equal(baseQtyOf({ qty: 2, unitFactor: 24, baseQty: 48 }), 48);
  // عمودٌ غائب (صفٌّ قديم) ⇒ يُحسب من اللقطة
  assert.equal(baseQtyOf({ qty: 2, unitFactor: 24 }), 48);
  // عمودٌ صفر صريح يُحترَم (ليس غياباً)
  assert.equal(baseQtyOf({ qty: 2, unitFactor: 24, baseQty: 0 }), 0);
});

/**
 * الحارس الأهمّ: صفٌّ سبق الميزة (baseQty = null بعد النشر وقبل الترحيل) يُقرأ
 * بكميته الحقيقية. كان `Number(null)` = 0 «رقماً صالحاً» فيتصفّر مخزون الشركات
 * كلّه وتاريخ مبيعاتها لحظة النشر.
 */
test('صفٌّ قديم baseQty = null ⇒ كميته الحقيقية لا صفر', () => {
  assert.equal(baseQtyOf({ qty: 5, baseQty: null }), 5);
  assert.equal(baseQtyOf({ qty: 5, unitFactor: 1, baseQty: null }), 5);
  assert.equal(baseQtyOf({ qty: 3, unitFactor: 24, baseQty: null }), 72);
  assert.equal(sumBase([{ qty: 5, baseQty: null }, { qty: 2, unitFactor: 24, baseQty: 48 }]), 53);
});

test('جمع كمياتٍ بوحداتٍ مختلفة بالأساس: كرتون + ١٠ حبات = ٣٤', () => {
  assert.equal(sumBase([{ qty: 1, ...carton }, { qty: 10, ...piece }]), 34);
});

test('حارس المخزون: كرتونان (٤٨) يتجاوزان رصيد ٣٠ حبة', () => {
  const need = sumBase([{ qty: 2, ...carton }]);
  assert.equal(need, 48);
  assert.ok(need > 30, 'لو جُمع الخام (٢) لمرّ على رصيد ٣٠');
});

test('سعر الوحدة: المحدَّد لها، وإلّا سعر الأساس × المعامل', () => {
  assert.equal(unitPriceOf({ name: 'كرتون', factor: 24 }, 0.5), 12);      // مشتقّ
  assert.equal(unitPriceOf({ name: 'كرتون', factor: 24, price: 11 }, 0.5), 11); // محدَّد (جملة)
  assert.equal(unitPriceOf({ name: 'حبة', factor: 1 }, 0.5), 0.5);
});

/**
 * null/الفراغ ⇒ يُشتقّ لا صفر. الخلل الحرج الذي كشفته المراجعة: `Number(null)` = 0
 * «سعرٌ صالح»، فيصير مرجع الحارس السعريّ صفراً — يُرفض بيع الكرتون لمن لا يملك
 * تغيير السعر، وتسقط أرضيته لمن يملكه.
 */
test('سعر الوحدة: price = null أو فراغ ⇒ يُشتقّ لا صفر', () => {
  assert.equal(unitPriceOf({ name: 'كرتون', factor: 24, price: null }, 1), 24);
  assert.equal(unitPriceOf({ name: 'كرتون', factor: 24, price: undefined }, 1), 24);
  assert.equal(unitPriceOf({ name: 'كرتون', factor: 24, price: '' as unknown as number }, 1), 24);
  // صفرٌ صريح يُحترَم (مجّانيّ مقصود) — ليس غياباً
  assert.equal(unitPriceOf({ name: 'كرتون', factor: 24, price: 0 }, 1), 0);
});

test('سعر المرتجع من البند المباع لا من سعر اليوم', () => {
  // كرتون بِيع بـ١٠ (بعد خصم)، فيه ٢٤ حبة ⇒ الحبة تُردّ بـ٠٫٤١٦٦٧
  const line = { lineTotal: 10, qty: 1, ...carton };
  assert.ok(Math.abs(refundPerBase(line) - 10 / 24) < 1e-9);
});

test('مرتجع ٢٤ حبة فرادى = قيمة البند تماماً لا ١٠٫٠٨', () => {
  const line = { lineTotal: 10, qty: 1, ...carton }; // ٢٤ حبة بالأساس
  let paid = 0, done = 0;
  for (let i = 0; i < 24; i++) { paid += refundAmount(line, 1, done); done += 1; }
  assert.equal(Math.round(paid * 100) / 100, 10.00, 'الباقي يذهب لآخر حبة');
});

test('مرتجع جزئي بالكرتون كاملاً = قيمة البند', () => {
  const line = { lineTotal: 240, qty: 10, ...carton }; // ٢٤٠ حبة
  assert.equal(refundAmount(line, 24, 0), 24); // كرتون واحد من عشرة
  assert.equal(refundAmount(line, 240, 0), 240); // الكل
});

test('عرض الكمية بوحداتها: ٥١ حبة = ٢ كرتون و٣ حبة', () => {
  const units = [{ name: 'كرتون', factor: 24 }];
  assert.equal(formatQty(51, units, 'حبة'), '2 كرتون و3 حبة');
  assert.equal(formatQty(48, units, 'حبة'), '2 كرتون');
  assert.equal(formatQty(5, units, 'حبة'), '5 حبة');
  assert.equal(formatQty(0, units, 'حبة'), '0 حبة');
  assert.equal(formatQty(-24, units, 'حبة'), '-1 كرتون');
});

test('عرض الكمية: الكسر يُعرض على الأساس', () => {
  assert.equal(formatQty(0.5, [{ name: 'كرتون', factor: 24 }], 'حبة'), '0.5 حبة');
});

test('رفض الوحدة: اسم فارغ، معامل غير صحيح، تكرار', () => {
  assert.match(unitProblem({ name: '', factor: 24 }) || '', /اسم/);
  assert.match(unitProblem({ name: 'كرتون', factor: 0 }) || '', /أكبر من صفر/);
  assert.match(unitProblem({ name: 'كرتون', factor: 1.5 }) || '', /صحيح/);
  assert.match(unitProblem({ name: 'كرتون', factor: 24, price: -1 }) || '', /موجب/);
  assert.match(unitProblem({ name: 'كرتون', factor: 24 }, [{ name: 'كرتون', factor: 12 }]) || '', /مكرر/);
  assert.match(unitProblem({ name: 'علبة', factor: 24 }, [{ name: 'كرتون', factor: 24 }]) || '', /المعامل نفسه/);
  assert.equal(unitProblem({ name: 'كرتون', factor: 24 }, [{ name: 'ربطة', factor: 6 }]), null);
});

test('assertFactor يرفض غير الصالح ويقبل الصحيح', () => {
  assert.equal(assertFactor(24), 24);
  assert.throws(() => assertFactor(0));
  assert.throws(() => assertFactor(-1));
  assert.throws(() => assertFactor('x'));
});

test('unitFields: لقطةٌ كاملة، والغياب ⇒ معامل ١', () => {
  assert.deepEqual(unitFields(2, { name: 'كرتون', factor: 24 }), { qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48 });
  assert.deepEqual(unitFields(5, null), { qty: 5, unitName: null, unitFactor: 1, baseQty: 5 });
});

test('fromBase: من الأساس إلى وحدة (٤٨ حبة = ٢ كرتون)', () => {
  assert.equal(fromBase(48, 24), 2);
  assert.equal(fromBase(50, 24), roundTo(50 / 24));
  assert.equal(fromBase(5, 0), 0); // معامل فاسد
});
function roundTo(n: number) { return Math.round(n * 1e6) / 1e6; }

test('QTY_EPS أصغر من أصغر كسرٍ ذي معنى', () => {
  assert.ok(QTY_EPS < 1 / 100000);
});
