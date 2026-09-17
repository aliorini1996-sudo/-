import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaymentStatus as cls } from './importStatus';

test('classifyPaymentStatus: النفي قبل «مدفوع» (البند 2)', () => {
  for (const s of ['غير مدفوعة', 'غير مدفوع', 'Not Paid', 'not_paid', 'unpaid', 'UNPAID', 'لم تُسدد', 'no']) assert.equal(cls(s), 'unpaid', s);
});

test('classifyPaymentStatus: الجزئي والمسودة والإلغاء بقيم محددة', () => {
  for (const s of ['Partially Paid', 'partial', 'جزئي', 'مدفوعة جزئياً', 'مسدد جزئيا']) assert.equal(cls(s), 'partial', s);
  for (const s of ['مسودة', 'Draft']) assert.equal(cls(s), 'draft', s);
  for (const s of ['ملغاة', 'ملغى', 'ملغي', 'إلغاء', 'cancel', 'Cancelled', 'void', 'reversed']) assert.equal(cls(s), 'cancelled', s);
  // «مبلغ» لا يُلتقط إلغاءً
  assert.equal(cls('مبلغ مستحق'), 'unknown');
  assert.equal(cls('بانتظار المبلغ'), 'unknown');
});

test('classifyPaymentStatus: المدفوع وغير المدفوع الصريح والفارغ وغير المعروف', () => {
  for (const s of ['paid', 'Paid', 'in_payment', 'In Payment', 'مدفوعة', 'مسدد', 'تم السداد', 'خالص', 'settled', 'fully paid']) assert.equal(cls(s), 'paid', s);
  for (const s of ['open', 'posted', 'overdue', 'مستحق', 'متأخر', 'مرحلة']) assert.equal(cls(s), 'unpaid', s);
  assert.equal(cls(''), 'none');
  assert.equal(cls(null), 'none');
  assert.equal(cls('معلّق'), 'unknown');
});

test('classifyPaymentStatus: صيغ شائعة للمدفوع والجزئي والمعكوس، والنفي كلمةً كاملة (مراجعة ثانية للبند 2)', () => {
  for (const s of ['مدفوعة بالكامل', 'مدفوع بالكامل', 'مسددة بالكامل', 'Paid in full', 'تم الدفع', 'خالصة', 'مدفوعة كلياً', 'قيد الدفع', 'قيد السداد']) {
    assert.equal(cls(s), 'paid', s);
  }
  for (const s of ['partly paid', 'Paid Partially', 'Partial Payment', 'مدفوعة جزئيا']) assert.equal(cls(s), 'partial', s);
  for (const s of ['معكوس', 'معكوسة']) assert.equal(cls(s), 'cancelled', s);
  for (const s of ['unknown', 'normal', 'none', 'Unknown']) assert.equal(cls(s), 'unknown', s);
  for (const s of ['not_paid', 'non-paid', 'لا']) assert.equal(cls(s), 'unpaid', s);
});

test('classifyPaymentStatus: كلمات الاكتمال والترقيم (الدفعة 2 للبند 2)', () => {
  for (const s of ['تم السداد بالكامل', 'تم الدفع بالكامل', 'مدفوعة كاملة', 'مدفوع كامل', 'مدفوعة.', 'Paid.', 'مدفوع بالكامل.', 'Paid (Full)',
    'مدفوعة (كاملة)', 'Paid - Full', 'Payment in progress', 'reconciled', 'PAID!', 'مسددة كاملاً']) {
    assert.equal(cls(s), 'paid', s);
  }
  // النفي والجزئي قبل الاكتمال، وكلمة الاكتمال وحدها ليست حالة
  for (const s of ['غير مدفوعة بالكامل', 'Not paid (full)', 'Not Paid.']) assert.equal(cls(s), 'unpaid', s);
  for (const s of ['Partially Paid.', '(جزئي)']) assert.equal(cls(s), 'partial', s);
  for (const s of ['ملغاة.', 'Cancelled!']) assert.equal(cls(s), 'cancelled', s);
  for (const s of ['Full', 'بالكامل', 'complete']) assert.equal(cls(s), 'unknown', s);
});
