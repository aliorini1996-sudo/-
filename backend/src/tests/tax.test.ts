// اختبارات محرّك الضريبة — الحساب الموثوق للفواتير (حصري/شامل/معفى + خانات العملة)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLine, computeInvoice } from '../lib/tax';

test('حصري (الافتراضي): 2×100 بضريبة 15% → صافي 200، ضريبة 30، إجمالي 230', () => {
  const r = computeLine({ qty: 2, unitPrice: 100 }, { defaultTaxPct: 15 });
  assert.equal(r.net, 200);
  assert.equal(r.tax, 30);
  assert.equal(r.gross, 230);
  assert.equal(r.taxPct, 15);
});

test('شامل الضريبة: 115 شاملة 15% → صافي 100، ضريبة 15', () => {
  const r = computeLine({ qty: 1, unitPrice: 115 }, { defaultTaxPct: 15, pricesIncludeTax: true });
  assert.equal(r.net, 100);
  assert.equal(r.tax, 15);
  assert.equal(r.gross, 115);
});

test('معفى: الضريبة صفر مهما كانت ضريبة الدولة', () => {
  const r = computeLine({ qty: 3, unitPrice: 50, exempt: true }, { defaultTaxPct: 15 });
  assert.equal(r.tax, 0);
  assert.equal(r.taxPct, 0);
  assert.equal(r.gross, 150);
});

test('ضريبة البند تتقدّم على ضريبة الدولة', () => {
  const r = computeLine({ qty: 1, unitPrice: 100, taxPct: 5 }, { defaultTaxPct: 15 });
  assert.equal(r.tax, 5);
});

test('الخصم يُطرح من الأساس ولا يهبط تحت الصفر', () => {
  const r = computeLine({ qty: 1, unitPrice: 100, discount: 20 }, { defaultTaxPct: 15 });
  assert.equal(r.net, 80);
  assert.equal(r.tax, 12);
  const zero = computeLine({ qty: 1, unitPrice: 10, discount: 999 }, { defaultTaxPct: 15 });
  assert.equal(zero.net, 0);
  assert.equal(zero.gross, 0);
});

test('ثلاث خانات عشرية (KWD/BHD): التقريب على 3 خانات', () => {
  const r = computeLine({ qty: 1, unitPrice: 0.1, taxPct: 10 }, { defaultTaxPct: 0, decimals: 3 });
  assert.equal(r.net, 0.1);
  assert.equal(r.tax, 0.01);
  assert.equal(r.gross, 0.11);
});

test('computeInvoice: يجمع البنود ويوحّد الإجماليات', () => {
  const t = computeInvoice(
    [
      { qty: 2, unitPrice: 100 },              // صافي 200 + 30 ضريبة
      { qty: 1, unitPrice: 50, exempt: true }, // صافي 50 بلا ضريبة
      { qty: 1, unitPrice: 100, discount: 10 } // صافي 90 + 13.5 ضريبة
    ],
    { defaultTaxPct: 15 }
  );
  assert.equal(t.subtotal, 340);
  assert.equal(t.totalTax, 43.5);
  assert.equal(t.totalDiscount, 10);
  assert.equal(t.total, 383.5);
  assert.equal(t.lines.length, 3);
});
