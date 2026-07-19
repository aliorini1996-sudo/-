// اختبار محرّك حساب الفاتورة المشترك (lib/invoiceCalc.ts) — متجهات ذهبية.
//
// ⚠️ هذه المتجهات **عقد** بين الخادم والعميل: النسخة الأمامية web-admin/src/rep/invoiceCalc.ts
// يجب أن تُنتج نفس هذه القيم بالضبط. أي تعديل على الصيغة يكسر هذا الاختبار عمداً — عندها
// عدّل النسختين معاً وحدّث القيم هنا. اختلاف كسر واحد = ورقة مطبوعة تخالف سجلّ الخادم.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoiceTotals, roundDecimal } from '../lib/invoiceCalc';

test('ذهبي: بندان بضريبة 15%، بلا خصم — خانتان', () => {
  const r = computeInvoiceTotals(
    [{ qty: 2, unitPrice: 100, discountPct: 0 }, { qty: 1, unitPrice: 50, discountPct: 0 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 },
  );
  assert.equal(r.subtotal, 250);
  assert.equal(r.taxAmt, 37.5);
  assert.equal(r.total, 287.5);
  assert.equal(r.items[0].lineTotal, 230);
  assert.equal(r.items[1].lineTotal, 57.5);
});

test('ذهبي: خصم بند 10% + وراثة ضريبة الشركة (taxPct غائب)', () => {
  const r = computeInvoiceTotals(
    [{ qty: 3, unitPrice: 100, discountPct: 10 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 },
  );
  // lineBase=300، خصم=30، بعد الخصم=270، ضريبة=40.5، صافي البند=310.5
  assert.equal(r.items[0].taxPct, 15);
  assert.equal(r.items[0].discountAmt, 30);
  assert.equal(r.items[0].taxAmt, 40.5);
  assert.equal(r.items[0].lineTotal, 310.5);
  // ⚠️ سلوك تاريخي مثبّت عمداً (لا نُصلحه هنا كي يطابق العميلُ الخادمَ): subtotal يجمع الأساس
  // قبل خصم البند، فالإجمالي = 300 - 0 + 40.5 = 340.5 ≠ مجموع صافي البنود (310.5).
  // أي أن خصم البند يخفّض الضريبة لا أصل الإجمالي. خللٌ ماليّ قائم مرفوع لمراجعة منفصلة.
  assert.equal(r.total, 340.5);
});

test('ذهبي: خصم فاتورة كلّي 5% (السلوك التاريخي: الضريبة تُحسب قبل خصم الفاتورة)', () => {
  const r = computeInvoiceTotals(
    [{ qty: 1, unitPrice: 1000, discountPct: 0, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 5 },
  );
  // subtotal=1000، خصم الفاتورة=50، الخاضع=950، ضريبة البند=150 (على 1000)، الإجمالي=1100
  assert.equal(r.subtotal, 1000);
  assert.equal(r.discountAmt, 50);
  assert.equal(r.taxAmt, 150);
  assert.equal(r.total, 1100);
});

test('ذهبي: عملة بثلاث خانات (KWD) — تقريب مختلف', () => {
  const r = computeInvoiceTotals(
    [{ qty: 3, unitPrice: 1.333, discountPct: 0, taxPct: 0 }],
    { companyVat: 0, decimals: 3, invoiceDiscountPct: 0 },
  );
  assert.equal(r.subtotal, 3.999);
  assert.equal(r.total, 3.999);
});

test('roundDecimal: خانتان وثلاث', () => {
  assert.equal(roundDecimal(2.005, 2), 2.01);   // 200.5 → 201
  assert.equal(roundDecimal(1.2345, 3), 1.235); // 1234.5 → 1235 (نصف لأعلى)
  assert.equal(roundDecimal(3.999, 3), 3.999);
});
