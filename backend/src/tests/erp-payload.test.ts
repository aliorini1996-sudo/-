// تكامل ERP — حمولة المزامنة وقراءة ردّ المستقبِل وتشفير مفاتيح الربط (services/erpPayload.ts، services/erpSecrets.ts).
// صرفٌ بلا قاعدة ولا شبكة. والاختبار الحيّ على Odoo حقيقي في .github/workflows/odoo-connector.yml يبني حمولته من الدوالّ نفسها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  companyTimeZone, erpEnvelope, erpUrlProblem, invoicePayloadRow, localDateIn, parseErpResponse,
  productPayloadRow, receiptPayloadRow, summarizeErpRun,
} from '../services/erpPayload';
import { openErpSecret, sealErpSecret } from '../services/erpSecrets';

const RIYADH = 'Asia/Riyadh';

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1', number: 'INV-0001', type: 'CASH', status: 'ACTIVE',
    invoiceDate: '2026-10-07T22:30:00.000Z', // ١:٣٠ فجر ٨ أكتوبر بتوقيت الرياض
    pricesIncludeTax: true, total: 50.9, taxAmt: 6.64,
    einvoiceSnapshot: { big: 'x'.repeat(1000) }, einvoiceQr: 'QR...',
    originalInvoice: null,
    items: [
      { unitPrice: 11.5, taxPct: 15, taxAmt: 6.64, lineTotal: 50.9, qty: 5, product: { id: 'p1', code: 'P1', image: 'data:image/png;base64,AAAA' } },
    ],
    ...over,
  };
}

test('الفاتورة: السعر الصافي قبل الضريبة حين تُخزَّن الأسعار شاملة، وكما هو حين تُخزَّن صافية', () => {
  const incl = invoicePayloadRow(invoice(), RIYADH);
  const it = (incl.items as Record<string, unknown>[])[0];
  assert.equal(it.unitPriceNet, 10, '١١٫٥ شاملة ١٥٪ = ١٠ صافية');
  assert.equal(it.netAmount, 44.26, 'صافي البند = الإجمالي − الضريبة');
  assert.equal(incl.taxableBase, 44.26);
  assert.equal(incl.payloadVersion, 2);

  const excl = invoicePayloadRow(invoice({ pricesIncludeTax: false }), RIYADH);
  assert.equal((excl.items as Record<string, unknown>[])[0].unitPriceNet, 11.5);
});

test('الفاتورة: بلا لقطة الفوترة ولا رمز QR ولا صورة منتج البند — والبند بلا صنف يبقى بلا صنف', () => {
  const row = invoicePayloadRow(invoice({
    items: [
      { unitPrice: 10, taxPct: 15, taxAmt: 1.5, lineTotal: 11.5, product: { id: 'p1', image: 'data:...' } },
      { unitPrice: 5, taxPct: 15, taxAmt: 0.75, lineTotal: 5.75, product: null },
    ],
  }), RIYADH);
  assert.ok(!('einvoiceSnapshot' in row) && !('einvoiceQr' in row) && !('originalInvoice' in row));
  const items = row.items as Record<string, unknown>[];
  assert.deepEqual(items[0].product, { id: 'p1' });
  assert.equal(items[1].product, null);
  assert.ok(JSON.stringify(row).length < 1000, 'الحمولة لا تحمل الثقيل');
});

test('الفاتورة: التاريخ المحلي بمنطقة الشركة (اقتطاع UTC يُرجعها يوماً) ورقم الأصل للإشعار', () => {
  const row = invoicePayloadRow(invoice({ originalInvoice: { number: 'INV-0009' } }), RIYADH);
  assert.equal(row.invoiceDateLocal, '2026-10-08');
  assert.equal(row.originalInvoiceNumber, 'INV-0009');
  assert.equal(localDateIn('2026-10-07T22:30:00.000Z', 'Africa/Cairo'), '2026-10-08');
  assert.equal(localDateIn('2026-10-07T20:30:00.000Z', 'Africa/Cairo'), '2026-10-07');
  assert.equal(localDateIn(null, RIYADH), null);
  assert.equal(localDateIn('ليس تاريخاً', RIYADH), null);
});

test('منطقة الشركة: إعدادات الدفاتر أولاً ثم البلد ثم الرياض', () => {
  assert.equal(companyTimeZone('Asia/Dubai', 'SA'), 'Asia/Dubai');
  assert.equal(companyTimeZone(null, 'eg'), 'Africa/Cairo');
  assert.equal(companyTimeZone(undefined, 'XX'), RIYADH);
});

test('المنتج بلا صورته والسند بفواتيره (allocations) بأرقامها لا بكائناتها', () => {
  assert.deepEqual(productPayloadRow({ id: 'p', name: 'شاي', image: 'data:...' }), { id: 'p', name: 'شاي' });
  const r = receiptPayloadRow({
    id: 'r1', number: 'RC-1', amount: 60, receiptDate: '2026-10-07T21:10:00.000Z',
    invoiceItems: [
      { invoiceId: 'inv-1', amount: 50.9, invoice: { number: 'INV-0001', items: [1, 2, 3] } as unknown as { number: string } },
      { invoiceId: 'inv-2', amount: 9.1, invoice: null },
    ],
  }, RIYADH);
  assert.equal(r.receiptDateLocal, '2026-10-08');
  assert.deepEqual(r.allocations, [
    { invoiceId: 'inv-1', invoiceNumber: 'INV-0001', amount: 50.9 },
    { invoiceId: 'inv-2', invoiceNumber: null, amount: 9.1 },
  ]);
  assert.deepEqual(r.invoiceItems, [
    { invoiceId: 'inv-1', amount: 50.9, invoice: { number: 'INV-0001' } },
    { invoiceId: 'inv-2', amount: 9.1, invoice: null },
  ]);
});

test('الغلاف: المصدر والمورد والعدد', () => {
  const env = erpEnvelope('customers', [{ id: 1 }, { id: 2 }], new Date('2026-10-10T00:00:00Z'));
  assert.deepEqual(env, { source: 'field-sales', resource: 'customers', exportedAt: '2026-10-10T00:00:00.000Z', count: 2, data: [{ id: 1 }, { id: 2 }] });
});

test('ردّ المستقبِل: الفشل والرفض وأخطاء الصفوف لا تُقرأ نجاحاً', () => {
  const e500 = parseErpResponse(500, JSON.stringify({ ok: false, error: 'فشل الترحيل' }));
  assert.equal(e500.ok, false);
  assert.match(e500.message, /500 - فشل الترحيل/);

  assert.equal(parseErpResponse(401, 'Unauthorized').ok, false);
  assert.equal(parseErpResponse(200, JSON.stringify({ ok: false, error: 'x' })).ok, false);

  const partial = parseErpResponse(200, JSON.stringify({
    ok: true, created: 2, updated: 1, errors: 1, error_details: [{ id: 'inv-7', error: 'العميل غير مُزامَن بعد' }],
  }));
  assert.deepEqual([partial.ok, partial.created, partial.updated, partial.errors], [true, 2, 1, 1]);
  assert.deepEqual(partial.errorDetails, [{ id: 'inv-7', error: 'العميل غير مُزامَن بعد' }]);

  const posted = parseErpResponse(200, JSON.stringify({ ok: true, created: 0, updated: 1, unchanged: 4, errors: 0, error_details: [] }));
  assert.deepEqual([posted.ok, posted.unchanged, posted.errors], [true, 4, 0], 'فاتورة مُرحَّلة لم تتغيّر ليست خطأ');
  assert.equal(summarizeErpRun({ sent: 5, created: 0, updated: 1, unchanged: 4, errors: 0, errorDetails: [], failed: null }).message,
    'تمت المزامنة: أُرسل 5، أُنشئ 0، حُدّث 1، بلا تغيير 4');

  const generic = parseErpResponse(204, '');
  assert.deepEqual([generic.ok, generic.errors], [true, 0], 'ERP عام بلا جسم JSON = نجاح بلا تفاصيل');
});

test('حالة التشغيل: فشل النقل FAILED، وأخطاء الصفوف PARTIAL، وإلا SUCCESS', () => {
  const base = { sent: 10, created: 7, updated: 2, errors: 0, errorDetails: [], failed: null };
  assert.equal(summarizeErpRun(base).status, 'SUCCESS');
  assert.equal(summarizeErpRun({ ...base, sent: 0 }).message, 'لا جديد منذ آخر مزامنة');
  const p = summarizeErpRun({ ...base, errors: 1, errorDetails: [{ id: 'abcdef123456', error: 'مُرحَّلة' }] });
  assert.equal(p.status, 'PARTIAL');
  assert.match(p.message, /abcdef12: مُرحَّلة/);
  const f = summarizeErpRun({ ...base, failed: 'انتهت المهلة' });
  assert.equal(f.status, 'FAILED');
  assert.match(f.message, /قبل الفشل/);
});

test('رابط ERP: https وحده، وبلا بيانات دخول فيه، ولا شبكة داخلية', () => {
  assert.equal(erpUrlProblem('https://erp.example.com/fieldsales/sync'), null);
  assert.ok(erpUrlProblem(''));
  assert.ok(erpUrlProblem('ليس رابطاً'));
  assert.match(String(erpUrlProblem('http://erp.example.com/fieldsales/sync')), /https/);
  assert.ok(erpUrlProblem('https://user:pass@erp.example.com/'));
  for (const h of ['localhost', 'odoo.localhost', 'erp.local', 'db.internal']) assert.ok(erpUrlProblem(`https://${h}/`), h);
});

test('مفاتيح الربط: تُشفَّر بمفتاح الخادم وتُفكّ لشركتها وحدها، والقديم الصريح يُقرأ كما هو', () => {
  const saved = process.env.ZATCA_SECRETS_KEY;
  try {
    process.env.ZATCA_SECRETS_KEY = crypto.randomBytes(32).toString('hex');
    const sealed = sealErpSecret('tenant-a', 'odoo-key-123');
    assert.notEqual(sealed, 'odoo-key-123');
    assert.match(sealed, /^v1:/);
    assert.equal(openErpSecret('tenant-a', sealed), 'odoo-key-123');
    assert.throws(() => openErpSecret('tenant-b', sealed), 'مفتاح شركة لا يُفكّ لشركة أخرى');
    assert.equal(openErpSecret('tenant-a', 'legacy-plain'), 'legacy-plain');
    assert.equal(openErpSecret('tenant-a', null), '');

    delete process.env.ZATCA_SECRETS_KEY;
    assert.equal(sealErpSecret('tenant-a', 'dev-key'), 'dev-key', 'بيئة تطوير بلا مفتاح تحفظ صريحاً');
    assert.throws(() => openErpSecret('tenant-a', sealed), /غير مضبوط/);
  } finally {
    if (saved === undefined) delete process.env.ZATCA_SECRETS_KEY; else process.env.ZATCA_SECRETS_KEY = saved;
  }
});
