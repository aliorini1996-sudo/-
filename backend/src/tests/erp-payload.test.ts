// تكامل ERP — حمولة المزامنة وقراءة ردّ المستقبِل وتشفير مفاتيح الربط (services/erpPayload.ts، services/erpSecrets.ts).
// صرفٌ بلا قاعدة ولا شبكة. والاختبار الحيّ على Odoo حقيقي في .github/workflows/odoo-connector.yml يبني حمولته من الدوالّ نفسها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  centsUp, companyTimeZone, erpEnvelope, erpUrlProblem, invoicePayloadRow, localDateIn, parseErpResponse,
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
  assert.equal(incl.payloadVersion, 3);

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

// —— الوحدات المتعددة (payloadVersion 3): البند بوحدة الأساس، والمطبوع في lineUnit ——

/** موصل Odoo المثبَّت كما هو (mapping.py map_invoice_line + تقريب Odoo لخانتين في السعر والخصم): مبلغ البند في Odoo */
function odooLineAmount(it: Record<string, unknown>, inclusive: boolean): { quantity: number; amount: number } {
  const qty = Number(it.qty);
  const discountFrom = (amount: number, q: number, price: number) => { const g = q * price; return g <= 0 ? 0 : Math.max(0, Math.min(100, (1 - amount / g) * 100)); };
  const price = inclusive ? Number(it.unitPrice) : Number(it.unitPriceNet);
  const disc = discountFrom(inclusive ? Number(it.lineTotal) : Number(it.netAmount), qty, price);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { quantity: qty, amount: r2(qty * r2(price) * (1 - r2(disc) / 100)) };
}

test('Odoo بالأساس: كرتونان (٢٤ حبة) يصلان ٤٨ حبة بسعر الحبة، والمطبوع في lineUnit — والمبلغ كما هو', () => {
  const row = invoicePayloadRow(invoice({
    pricesIncludeTax: false, total: 276, taxAmt: 36,
    items: [{ qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, unitCode: 'CT', unitPrice: 120, unitCost: 48, taxPct: 15, taxAmt: 36, lineTotal: 276,
      product: { id: 'p1', unit: 'حبة', unitCode: 'PCE' } }],
  }), RIYADH);
  const it = (row.items as Record<string, unknown>[])[0];
  assert.equal(it.qty, 48, 'الكمية بوحدة الصنف (الأساس) — كما يقرؤها الموصل المثبَّت');
  assert.equal(it.baseQty, 48);
  assert.equal(it.unitFactor, 1, 'اللقطة تصف الأساس مع الكمية — لا يُضرب المعامل مرتين');
  assert.equal(it.unitName, 'حبة');
  assert.equal(it.unitCode, 'PCE', 'رمز الأساس لا رمز الكرتون');
  assert.equal(it.unitPrice, 5);
  assert.equal(it.unitPriceNet, 5);
  assert.equal(it.unitCost, 2, 'تكلفة الكرتون ÷ المعامل');
  assert.equal(it.lineTotal, 276, 'المبالغ لا تتغيّر');
  assert.equal(it.netAmount, 240);
  assert.deepEqual(it.lineUnit, { name: 'كرتون', factor: 24, qty: 2, unitPrice: 120, unitPriceNet: 120, unitCode: 'CT' });
  assert.deepEqual(odooLineAmount(it, false), { quantity: 48, amount: 240 });
});

test('Odoo بالأساس: سعرٌ لا ينقسم (١٠ ÷ ٢٤) يُرفع لخانتين فيمتصّ الخصمُ المشتقّ الفرق — لا ٨ ريالات زائدة في ١٠٠ كرتون', () => {
  for (const [qty, unitPrice, incl] of [[100, 10, false], [1, 10, false], [37, 45, true], [250, 17.25, true], [3, 0.5, false]] as [number, number, boolean][]) {
    const taxPct = 15;
    const lineTotal = Math.round(qty * unitPrice * 100) / 100;
    const taxAmt = incl ? Math.round((lineTotal - lineTotal / 1.15) * 100) / 100 : Math.round(lineTotal * 0.15 * 100) / 100;
    const total = incl ? lineTotal : lineTotal + taxAmt;
    const row = invoicePayloadRow(invoice({
      pricesIncludeTax: incl, total, taxAmt,
      items: [{ qty, unitName: 'كرتون', unitFactor: 24, baseQty: qty * 24, unitPrice, taxPct, taxAmt, lineTotal: incl ? lineTotal : total, product: { id: 'p1', unit: 'حبة' } }],
    }), RIYADH);
    const it = (row.items as Record<string, unknown>[])[0];
    assert.equal(it.qty, qty * 24);
    const price = Number(incl ? it.unitPrice : it.unitPriceNet);
    assert.equal(Math.round(price * 100), price * 100, `سعر الأساس بخانتين (${price})`);
    const want = incl ? lineTotal : Number(it.netAmount);
    const got = odooLineAmount(it, incl).amount;
    // ما يبقى من تقريب Odoo للخصم لخانتين (≤ ٠٫٠٠٥٪ من الإجمالي) يسوّيه سطر «فرق تقريب» (حتى ريال) — والمهمّ ألّا
    // يكبر الفرق بحجم الكمية كما يكبر بسعرٍ يقرّبه Odoo بعد اشتقاق الخصم
    const residual = Number(it.qty) * price * 0.00005 + 0.01;
    assert.ok(Math.abs(got - want) <= residual && Math.abs(got - want) <= 1, `${qty}×${unitPrice}${incl ? ' شامل' : ''}: Odoo ${got} مقابل ${want}`);
    // والسعر غير المرفوع (٠٫٤١٦٧ يقرّبه Odoo ٠٫٤٢) يزيد البند بحجم الكمية
    if (qty === 100 && unitPrice === 10) {
      const naive = odooLineAmount({ ...it, unitPriceNet: Math.round((unitPrice / 24) * 1e4) / 1e4 }, incl).amount;
      assert.ok(naive - want > 5, `السعر الدقيق يزيد ${naive - want}`);
    }
  }
  assert.equal(centsUp(10 / 24), 0.42);
  assert.equal(centsUp(240 / 24), 10, 'لا هللة كاذبة من غبار العائمة');
  assert.equal(centsUp(1.875), 1.88);
  assert.equal(centsUp(0), 0);
});

test('Odoo: بندٌ بوحدة الأساس (معامل ١ — كل بندٍ قبل الميزة) يصل حرفياً كما كان، ومعه baseQty وlineUnit فقط', () => {
  const before = { qty: 5, unitName: null, unitFactor: 1, baseQty: null, unitCode: 'PCE', unitPrice: 11.5, unitCost: 0, taxPct: 15, taxAmt: 6.64, lineTotal: 50.9, product: { id: 'p1', unit: 'حبة' } };
  const it = (invoicePayloadRow(invoice({ items: [before] }), RIYADH).items as Record<string, unknown>[])[0];
  const { baseQty, lineUnit, ...rest } = it;
  const { baseQty: _stored, ...beforeRest } = before;
  void _stored;
  assert.deepEqual(rest, { ...beforeRest, unitPriceNet: 10, netAmount: 44.26 }, 'كل حقلٍ كما في الإصدار الثاني');
  assert.equal(it.qty, 5);
  assert.equal(it.unitPrice, 11.5, 'السعر كما هو بلا تقريب لأعلى');
  assert.equal(baseQty, 5, 'صفٌّ لم يملأه الترحيل يُحسب من لقطته');
  assert.deepEqual(lineUnit, { name: 'حبة', factor: 1, qty: 5, unitPrice: 11.5, unitPriceNet: 10, unitCode: 'PCE' });
});

test('Odoo: المنتج يحمل وحداته كما هي (سعر الأساس basePrice) — ولا صورة', () => {
  const units = [{ id: 'u1', name: 'كرتون', factor: 24, price: 110, unitCode: 'CT', isActive: true, sortOrder: 0 }];
  assert.deepEqual(productPayloadRow({ id: 'p', unit: 'حبة', basePrice: 5, units, image: 'data:...' }), { id: 'p', unit: 'حبة', basePrice: 5, units });
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
