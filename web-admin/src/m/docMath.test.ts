import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal, invoiceTotals, type Line } from './docMath';

/**
 * حارس **الفخّ الحاكم**: مسار الأدمن يتوقّع سعراً قبل الضريبة.
 *
 * لو نُسخ منطق تطبيق المندوب (سعر شامل يُشتقّ منه ما قبله) لأنتجت الشاشة
 * فواتير بمبالغ خاطئة **تمرّ بلا خطأ ولا تحذير** — والخطأ الصامت في المال
 * أسوأ من الانهيار. هذه الاختبارات ترصده بأرقام يدوية.
 */

const line = (o: Partial<Line> = {}): Line => ({
  productId: 'p1', name: 'صنف', unit: 'حبة',
  qty: 1, unitPrice: 100, discountPct: 0, taxPct: 15, ...o,
});

test('السعر قبل الضريبة: 100 بضريبة 15% ⇒ البند 115', () => {
  assert.equal(lineTotal(line()), 115,
    'لو عُومل 100 كسعر شامل لخرج 100 — وهذا هو الخطأ الصامت');
});

test('الكمية تضاعف الأساس قبل الضريبة', () => {
  assert.equal(lineTotal(line({ qty: 3 })), 345); // 300 + 45
});

test('خصم البند يسبق الضريبة (الضريبة على المخصوم لا على الأصل)', () => {
  // 100 − 10% = 90 ، ثم 15% = 13.5 ⇒ 103.5
  assert.equal(lineTotal(line({ discountPct: 10 })), 103.5);
});

test('صنف معفى (ضريبة صفر) لا تُضاف له ضريبة', () => {
  assert.equal(lineTotal(line({ taxPct: 0 })), 100);
});

test('الكسور تُقرّب لخانتين — لا سنتات شاردة', () => {
  assert.equal(lineTotal(line({ unitPrice: 33.33, qty: 3, taxPct: 15 })), 114.99);
});

test('ملخّص الفاتورة: أساس وخصم وضريبة وإجمالي', () => {
  const t = invoiceTotals([line({ qty: 2 }), line({ unitPrice: 50, taxPct: 15 })], 0);
  // الأساس 200 + 50 = 250 ، الضريبة 30 + 7.5 = 37.5
  assert.deepEqual(t, { subtotal: 250, discount: 0, tax: 37.5, total: 287.5 });
});

test('خصم الفاتورة يُخصم من الإجمالي', () => {
  const t = invoiceTotals([line()], 10); // 100 أساس ، خصم 10 ، ضريبة 15
  assert.equal(t.discount, 10);
  assert.equal(t.total, 105);
});

test('خصم البند وخصم الفاتورة يجتمعان', () => {
  const t = invoiceTotals([line({ discountPct: 20 })], 10);
  assert.equal(t.discount, 30, 'خصم بند 20 + خصم فاتورة 10 على أساس 100');
  // الضريبة على 80 (بعد خصم البند) = 12
  assert.equal(t.tax, 12);
  assert.equal(t.total, 82); // 100 − 30 + 12
});

test('فاتورة فارغة ⇒ أصفار لا NaN', () => {
  assert.deepEqual(invoiceTotals([], 0), { subtotal: 0, discount: 0, tax: 0, total: 0 });
});
