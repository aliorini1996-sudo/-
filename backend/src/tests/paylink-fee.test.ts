import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePaylinkFee } from '../services/paylinkFee';

/**
 * حرّاس مال «الدفع الإلكتروني».
 *
 * الخطأ الذي تحرسه هذه الملفّات ليس خطأ حساب بل خطأ **دلالة**: أن يُسجَّل سند
 * العميل بالصافي بعد العمولة. عندها تبقى الفاتورة ناقصةً إلى الأبد ويُطارَد
 * عميلٌ سدّد. لذلك أول ثابت هنا: المحصَّل = ما دفعه العميل، لا ما وصلنا.
 */

const VAT = 15;

test('المثال الحاكم: ١٠٠٠ ريال بعمولة ٤٪ + ١ شاملة الضريبة', () => {
  const f = computePaylinkFee(1000, 4, 1, VAT);
  assert.equal(f.collected, 1000);   // سند العميل بالكامل
  assert.equal(f.feeGross, 41);      // ٤٠ + ١
  assert.equal(f.feeNet, 35.65);     // ٤١ ÷ ١٫١٥
  assert.equal(f.feeVat, 5.35);      // مستخرَجة لا مضافة
  assert.equal(f.payable, 959);      // ما ندين به للشركة
});

test('الثابت الأول: العمولة صافيها وضريبتها تساويان إجماليها بلا انحراف', () => {
  for (const amount of [1, 7.35, 99.99, 250, 1000, 1234.56, 87654.32]) {
    const f = computePaylinkFee(amount, 4, 1, VAT);
    assert.equal(f.feeNet + f.feeVat, f.feeGross, `انحراف ضريبي عند ${amount}`);
  }
});

test('الثابت الثاني: ما ندين به + عمولتنا = ما دفعه العميل بالضبط', () => {
  // المقارنة بالهللات الصحيحة: جمع العوائم يولد غبارا (2.20+1.13=3.32999…)
  // فيكذب حارس يقارن عوائم مباشرة — والدلالة المطلوبة عشرية لا ثنائية
  const halalas = (n: number) => Math.round(n * 100);
  for (const amount of [1, 3.33, 19.99, 100, 575.25, 9999.99, 100000]) {
    const f = computePaylinkFee(amount, 4, 1, VAT);
    assert.equal(halalas(f.payable) + halalas(f.feeGross), halalas(f.collected), `المال ضاع أو نبت عند ${amount}`);
  }
});

test('الثابت الثالث: ما ندين به لا يكون سالبا مهما صغرت الدفعة', () => {
  for (const amount of [0.5, 0.9, 1, 1.04, 1.5]) {
    const f = computePaylinkFee(amount, 4, 1, VAT);
    assert.ok(f.payable >= 0, `دين سالب على الشركة عند ${amount}`);
    assert.ok(f.feeGross <= f.collected, `عمولة تتجاوز المحصل عند ${amount}`);
  }
});

test('دفعة أصغر من الريال الثابت: العمولة تُحدّ بالمحصل ولا تبتلع أكثر منه', () => {
  const f = computePaylinkFee(0.5, 4, 1, VAT);
  assert.equal(f.feeGross, 0.5);
  assert.equal(f.payable, 0);
});

test('نسبة الشركة قابلة للاختلاف — كل شركة على حدة', () => {
  const a = computePaylinkFee(1000, 4, 1, VAT);
  const b = computePaylinkFee(1000, 2.5, 0, VAT);
  assert.equal(a.feeGross, 41);
  assert.equal(b.feeGross, 25);
  assert.equal(b.payable, 975);
});

test('نصف الهللة يقرَّب نصفا-لأعلى كبقية المنصة', () => {
  // ٢٦٫٢٥ × ٤٪ = ١٫٠٥ ثم + ١ = ٢٫٠٥ بالضبط
  const f = computePaylinkFee(26.25, 4, 1, VAT);
  assert.equal(f.feeGross, 2.05);
  assert.equal(f.payable, 24.2);
});

test('المبلغ غير الصالح يُرفض ولا يمر صامتا', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => computePaylinkFee(bad as number, 4, 1, VAT), /غير صالح/);
  }
});

test('عمولة صفرية جائزة — شركة معفاة تأخذ كل المحصل', () => {
  const f = computePaylinkFee(500, 0, 0, VAT);
  assert.equal(f.feeGross, 0);
  assert.equal(f.feeVat, 0);
  assert.equal(f.payable, 500);
});
