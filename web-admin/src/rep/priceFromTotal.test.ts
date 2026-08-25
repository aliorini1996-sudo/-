import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoiceTotals, priceFromLineTotal } from './invoiceCalc';

/**
 * حارس الاشتقاق العكسي (تعديل إجمالي البند يدوياً):
 * الجولة الكاملة إجمالي ← سعر ← محرك ← إجمالي يجب أن تعيد الرقم المكتوب نفسه
 * بعد التقريب — وإلا افترقت الورقة عن السجل بهللات صامتة.
 */

const roundTrip = (total: number, qty: number, d: number, t: number, inclusive: boolean) => {
  const p = priceFromLineTotal(total, qty, d, t, inclusive);
  assert.ok(p !== null, 'السعر المشتق null');
  const calc = computeInvoiceTotals(
    [{ qty, unitPrice: p!, discountPct: d, taxPct: t }],
    { companyVat: t, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: inclusive },
  );
  return calc.items[0].lineTotal;
};

test('الوضع الحصري (الأدمن): إجمالي الصورة 6500.38 يعود حرفياً', () => {
  assert.equal(roundTrip(6500.38, 50, 0, 15, false), 6500.38);
});

test('الوضع الحصري: مع خصم بند', () => {
  assert.equal(roundTrip(1234.56, 7, 12.5, 15, false), 1234.56);
});

test('الوضع الشامل (المندوب): الإجمالي المكتوب يعود حرفياً', () => {
  assert.equal(roundTrip(999.99, 3, 0, 15, true), 999.99);
  assert.equal(roundTrip(6500.38, 50, 5, 15, true), 6500.38);
});

test('مدخلات تكسر القسمة تعيد null لا NaN', () => {
  assert.equal(priceFromLineTotal(100, 0, 0, 15, false), null);   // كمية صفر
  assert.equal(priceFromLineTotal(100, 5, 100, 15, false), null); // خصم 100%
  assert.equal(priceFromLineTotal(-5, 5, 0, 15, false), null);    // إجمالي سالب
});
