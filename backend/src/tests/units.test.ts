import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBase, fromBase, baseQtyOf, sumBase, factorOf, unitPriceOf,
  refundPerBase, refundAmount, formatQty, unitProblem, assertFactor, unitFields, QTY_EPS,
  MAX_UNIT_FACTOR, primaryUnitOf, productQtyText, primaryPriceOf, derivedBasePrice, baseNameKey,
} from '../services/units';
import { roundHalfUp } from '../lib/money';
import { roundDecimal } from '../utils/helpers';

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

// ═══════════════ «الوحدة الرئيسية» (القاعدة ١٢، §2.1 و§8): قارورةٌ أساسٌ وكرتون ٢٤ رئيسيّ، وطبلية ١٢٠٠ أكبر منه ═══════════════
const ctn = { id: 'u-ctn', name: 'كرتون', factor: 24, price: 48 as number | null, isActive: true };
const pal = { id: 'u-pal', name: 'طبلية', factor: 1200, price: null, isActive: true };
const bottle = { unit: 'قارورة', basePrice: 2, units: [ctn, pal], primaryUnitId: 'u-ctn' as string | null };

test('formatQty بلا رئيسية: المعامل الرابع غائباً وnull وundefined يعطي الناتج القائم حرفياً (I1)', () => {
  const units = [{ name: 'كرتون', factor: 24 }, { name: 'طبلية', factor: 1200 }, { name: 'صندوق', factor: 48, isActive: false }];
  for (const q of [0, 5, 24, 51, 1250, 2400, -26, -24, 0.5, 24.5, 1e-7, Number.NaN]) {
    const before = formatQty(q, units, 'حبة');
    assert.equal(formatQty(q, units, 'حبة', null), before, `null: ${q}`);
    assert.equal(formatQty(q, units, 'حبة', undefined), before, `undefined: ${q}`);
  }
  // رئيسيةٌ موقوفة أو بمعامل ١ أو تالف تُمرَّر مباشرة ⇒ الجسم القائم أيضاً
  for (const bad of [{ ...ctn, isActive: false }, { ...ctn, factor: 1 }, { ...ctn, factor: Number.NaN }]) {
    assert.equal(formatQty(1250, units, 'حبة', bad), formatQty(1250, units, 'حبة'));
  }
});

test('formatQty مع الرئيسية يقف عندها (D4): «52 كرتون و2 قارورة» لا «1 طبلية و…»، والصفر «0 كرتون»', () => {
  const units = [ctn, pal];
  assert.equal(formatQty(1250, units, 'قارورة'), '1 طبلية و50 قارورة', 'القائم بلا رئيسية: الأكبر أولاً');
  assert.equal(formatQty(1250, units, 'قارورة', ctn), '52 كرتون و2 قارورة');
  assert.equal(formatQty(0, units, 'قارورة', ctn), '0 كرتون');
  assert.equal(formatQty(5, units, 'قارورة', ctn), '5 قارورة');
  assert.equal(formatQty(48, units, 'قارورة', ctn), '2 كرتون');
  assert.equal(formatQty(-26, units, 'قارورة', ctn), '-1 كرتون و2 قارورة');
  assert.equal(formatQty(-24, units, 'قارورة', ctn), '-1 كرتون');
  assert.equal(formatQty(24.5, units, 'قارورة', ctn), '1 كرتون و0.5 قارورة');
  assert.equal(formatQty(0.5, units, 'قارورة', ctn), '0.5 قارورة');
  assert.equal(formatQty(0.1 + 0.2, units, 'قارورة', ctn), '0.3 قارورة', 'غبار العائمة محجوب');
});

test('primaryUnitOf: الرئيسية الصالحة وحدها، وكل حالٍ تالف ⇒ null (I5)', () => {
  assert.equal(primaryUnitOf(bottle), ctn);
  assert.equal(primaryUnitOf(null), null);
  assert.equal(primaryUnitOf(undefined), null);
  assert.equal(primaryUnitOf({ units: [ctn] }), null, 'معرّف غائب');
  assert.equal(primaryUnitOf({ primaryUnitId: null, units: [ctn] }), null, 'معرّف null');
  assert.equal(primaryUnitOf({ primaryUnitId: '', units: [ctn] }), null, 'معرّف فارغ');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-gone', units: [ctn] }), null, 'لا يطابق وحدة (كاش قديم، وحدة حُذفت، صنف آخر)');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: null }), null, 'بلا وحدات');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn' }), null, 'وحدات غائبة');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [{ ...ctn, isActive: false }] }), null, 'موقوفة');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [{ ...ctn, factor: 1 }] }), null, 'معامل < ٢');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [{ ...ctn, factor: 0 }] }), null, 'معامل صفر');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [{ ...ctn, factor: 2.5 }] }), null, 'معامل غير صحيح');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [{ ...ctn, factor: Number.NaN }] }), null, 'معامل ليس رقماً');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [{ ...ctn, factor: MAX_UNIT_FACTOR + 1 }] }), null, 'معامل > MAX_UNIT_FACTOR');
  const two = { ...ctn, factor: 2 };
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [two] }), two, 'المعامل ٢ صالح');
  const max = { ...ctn, factor: MAX_UNIT_FACTOR };
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [max] }), max, 'MAX_UNIT_FACTOR صالح');
  assert.equal(primaryUnitOf({ primaryUnitId: 'u-ctn', units: [{ ...ctn, isActive: undefined }] })?.id, 'u-ctn', 'isActive غائب = نشطة');
});

test('productQtyText: formatQty بوحدات الصنف ورئيسيّه — وبلا رئيسية صالحة الناتج القائم حرفياً', () => {
  assert.equal(productQtyText(1250, bottle), '52 كرتون و2 قارورة');
  assert.equal(productQtyText(0, bottle), '0 كرتون');
  assert.equal(productQtyText(1250, { ...bottle, primaryUnitId: null }), formatQty(1250, [ctn, pal], 'قارورة'));
  assert.equal(productQtyText(1250, { ...bottle, primaryUnitId: 'u-gone' }), '1 طبلية و50 قارورة', 'معرّف تالف ⇒ سلوك اليوم');
  assert.equal(productQtyText(51, { unit: 'حبة', units: [{ name: 'كرتون', factor: 24 }] }), '2 كرتون و3 حبة');
  assert.equal(productQtyText(7, null), formatQty(7, [], ''));
  assert.equal(productQtyText(7, { unit: 'حبة' }), '7 حبة');
});

test('primaryPriceOf: سعر الرئيسية المحدَّد، وإلّا الأساس × المعامل، وnull بلا رئيسية', () => {
  assert.equal(primaryPriceOf(bottle), 48);
  assert.equal(primaryPriceOf({ ...bottle, units: [{ ...ctn, price: null }, pal] }), 48, 'مشتقّ: ٢ × ٢٤');
  assert.equal(primaryPriceOf({ ...bottle, basePrice: '0.5', units: [{ ...ctn, price: null }] }), 12);
  assert.equal(primaryPriceOf({ ...bottle, units: [{ ...ctn, price: 0 }] }), 0, 'الصفر الصريح يُحترَم');
  assert.equal(primaryPriceOf({ ...bottle, primaryUnitId: null }), null);
  assert.equal(primaryPriceOf({ ...bottle, primaryUnitId: 'u-gone' }), null);
});

test('derivedBasePrice = roundHalfUp(p ÷ f, 4): قيم المواصفة، ومنها ما يخطئ فيه التقريب الساذج', () => {
  assert.equal(derivedBasePrice(50, 24), 2.0833);
  assert.equal(derivedBasePrice(48, 24), 2);
  assert.equal(derivedBasePrice(16.33, 8), 2.0413, 'الساذج يعطي 2.0412');
  assert.equal(derivedBasePrice(16.83, 8), 2.1038, 'الساذج يعطي 2.1037');
  assert.equal(derivedBasePrice(17.33, 8), 2.1663, 'الساذج يعطي 2.1662');
  assert.equal(derivedBasePrice(0, 24), 0);
  assert.equal(derivedBasePrice(48, 0), 0, 'معامل صفر');
  assert.equal(derivedBasePrice(48, -2), 0, 'معامل سالب');
  assert.equal(derivedBasePrice(Number.NaN, 24), 0);
  assert.equal(derivedBasePrice(48, Number.NaN), 0);
});

test('derivedBasePrice يطابق roundHalfUp في lib/money.ts وroundDecimal في خطوة convert-base الخامسة (عيّنة ثابتة البذرة)', () => {
  let seed = 20261031;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };   // MINSTD — صحيحٌ بلا فقد دقّة
  for (let i = 0; i < 5000; i++) {
    const p = Math.round(rnd() * 100000) / 100;          // 0.00 – 1000.00
    const f = 2 + Math.floor(rnd() * 500);                // 2 – 501
    const want = roundHalfUp(p / f, 4);
    assert.equal(derivedBasePrice(p, f), want, `${p} ÷ ${f}`);
    assert.equal(roundDecimal(p / f, 4), want, `roundDecimal ${p} ÷ ${f}`);
  }
});

test('baseNameKey (D20-أ): قصّ الأطراف ثم أول ٦٤ حرفاً، والغياب نصٌّ فارغ', () => {
  assert.equal(baseNameKey('  قارورة '), 'قارورة');
  assert.equal(baseNameKey('قارورة'), baseNameKey('قارورة  '));
  assert.equal(baseNameKey(null), '');
  assert.equal(baseNameKey(undefined), '');
  assert.equal(baseNameKey(''), '');
  const long = 'ح'.repeat(80);
  assert.equal(baseNameKey(long).length, 64);
  assert.equal(baseNameKey(long), baseNameKey(long.slice(0, 64)), 'اسمٌ أطول من ٦٤ يطابق ما قُصّ منه في المخطّط');
  assert.equal(baseNameKey(`  ${long}`), long.slice(0, 64), 'القصّ قبل الحدّ');
});
