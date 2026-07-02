// اختبارات منسّق الفاتورة الممتثلة — دولة الشركة تحدّد العملة والضريبة والمحوّل
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompliantInvoice } from '../compliance/build-invoice';

const seller = { name: 'شركة الاختبار', taxNumber: '310123456789003' };

test('السعودية: ضريبة 15% + QR زاتكا حقيقي بحالة generated', async () => {
  const b = await buildCompliantInvoice({ countryCode: 'SA', seller, lines: [{ qty: 1, unitPrice: 100 }] });
  assert.equal(b.country, 'SA');
  assert.equal(b.currency, 'SAR');
  assert.equal(b.totals.total, 115);
  assert.equal(b.compliance.ok, true);
  assert.equal(b.compliance.status, 'generated');
  assert.ok(b.compliance.qr && b.compliance.qr.length > 0);
});

test('الكويت: بلا ضريبة، عملة KWD بثلاث خانات، بلا حمولة حكومية', async () => {
  const b = await buildCompliantInvoice({ countryCode: 'KW', seller, lines: [{ qty: 3, unitPrice: 1.5 }] });
  assert.equal(b.currency, 'KWD');
  assert.equal(b.totals.totalTax, 0);
  assert.equal(b.totals.total, 4.5);
  assert.equal(b.compliance.provider, 'none');
  assert.equal(b.compliance.ok, true);
});

test('مصر: نقطة امتداد ETA تعلن not_implemented بصدق (لا تظاهر زائف)', async () => {
  const b = await buildCompliantInvoice({ countryCode: 'EG', seller, lines: [{ qty: 1, unitPrice: 100 }] });
  assert.equal(b.currency, 'EGP');
  assert.equal(b.totals.totalTax, 14); // ضريبة مصر 14%
  assert.equal(b.compliance.status, 'not_implemented');
  assert.equal(b.compliance.ok, false);
});

test('رمز دولة غير معروف → يعود للسعودية بأمان', async () => {
  const b = await buildCompliantInvoice({ countryCode: 'ZZ', seller, lines: [{ qty: 1, unitPrice: 100 }] });
  assert.equal(b.country, 'SA');
  assert.equal(b.currency, 'SAR');
});
