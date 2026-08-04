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

test('ذهبي: خصم بند 10% — الخصم يخفّض الإجمالي لا الضريبة وحدها', () => {
  const r = computeInvoiceTotals(
    [{ qty: 3, unitPrice: 100, discountPct: 10 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 },
  );
  // lineBase=300، خصم=30، بعد الخصم=270، ضريبة=40.5، صافي البند=310.5
  assert.equal(r.items[0].taxPct, 15);
  assert.equal(r.items[0].discountAmt, 30);
  assert.equal(r.items[0].taxAmt, 40.5);
  assert.equal(r.items[0].lineTotal, 310.5);
  assert.equal(r.subtotal, 300);
  assert.equal(r.discountAmt, 30, 'خصم البند يدخل خصم الفاتورة المُعلَن');
  // كان 340.5 — أي أعلى من الورقة المطبوعة بمبلغ الخصم كاملاً.
  assert.equal(r.total, 310.5, 'الإجمالي = مجموع صافي البنود');
});

test('ذهبي: خصم فاتورة كلّي 5% — الضريبة على الوعاء بعد الخصم', () => {
  const r = computeInvoiceTotals(
    [{ qty: 1, unitPrice: 1000, discountPct: 0, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 5 },
  );
  // subtotal=1000، خصم=50، الوعاء=950، ضريبة=142.5 (15% من 950)، الإجمالي=1092.5
  assert.equal(r.subtotal, 1000);
  assert.equal(r.discountAmt, 50);
  assert.equal(r.taxAmt, 142.5, 'كانت 150 — ضريبة على مبلغ لم يُبَع به');
  assert.equal(r.total, 1092.5);
});

// ═══ الثوابت التي يجب ألّا تنكسر مهما تغيّرت الصيغة ═══
// كسرُ أيٍّ منها يعني ورقةً مطبوعة تخالف السجلّ، أو رمز ZATCA بأرقام لا تتّسق.

test('ثابت: الإجمالي = مجموع صافي البنود دائماً', () => {
  for (const [ld, id] of [[0, 0], [10, 0], [0, 5], [12.5, 7.5], [100, 0], [0, 100]]) {
    const r = computeInvoiceTotals(
      [{ qty: 3, unitPrice: 100, discountPct: ld }, { qty: 2, unitPrice: 55.5, discountPct: 0, taxPct: 5 }],
      { companyVat: 15, decimals: 2, invoiceDiscountPct: id },
    );
    const sum = roundDecimal(r.items.reduce((s, i) => s + i.lineTotal, 0), 2);
    assert.equal(r.total, sum, `خصم بند ${ld}% وفاتورة ${id}%`);
  }
});

test('ثابت: الضريبة = نسبتها من الوعاء الخاضع (رمز ZATCA يحمل الرقمين)', () => {
  for (const id of [0, 5, 20, 50]) {
    const r = computeInvoiceTotals(
      [{ qty: 4, unitPrice: 250, discountPct: 10, taxPct: 15 }],
      { companyVat: 15, decimals: 2, invoiceDiscountPct: id },
    );
    const taxable = roundDecimal(r.subtotal - r.discountAmt, 2);
    assert.equal(r.taxAmt, roundDecimal(taxable * 0.15, 2), `خصم فاتورة ${id}%`);
    assert.equal(r.total, roundDecimal(taxable + r.taxAmt, 2));
  }
});

test('ثابت: خصم 100% ⇒ إجمالي صفر لا ضريبة على العدم', () => {
  const r = computeInvoiceTotals(
    [{ qty: 2, unitPrice: 300, discountPct: 100 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 0 },
  );
  assert.equal(r.taxAmt, 0);
  assert.equal(r.total, 0);
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
