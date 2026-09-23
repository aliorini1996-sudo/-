// اختبارات Z5.2 لنواة الإصدار النقيّة (issue.ts): تحويل فاتورة المنصّة إلى مصدر Z1 (مطابقة بايتات لعيّنتي Z1)، طرق الدفع وترتيب البنود
// وفئة الصنف، النوع الفرعي (D2/Q2)، حجب المشتري الناقص، العملة (D9)، الخصم الكلّي على الأسعار الشاملة، البند الصفري، بيانات البائع،
// قاعدة تاريخ التوريد (نقد 24)، المبالغ المخزَّنة (§2.4/D6) بخاصية شاملة G = 0.01..1000.00 وشبكة نسبتين ومتجهات دقة الكسور،
// أعمدة الصفّ والمرآة، بادئة الترقيم بشهر الرياض، وتصنيف P2002 (نقد 26). لا قاعدة بيانات ولا شبكة.
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { computeInvoiceTotals } from '../../lib/invoiceCalc';
import { computeUblAmountsDetailed } from './amounts';
import { customerBuyerStatus } from './buyerData';
import { INITIAL_PIH } from './crypto';
import { parseAmount } from './decimal';
import { DocumentBytesError } from './documentStore';
import { ZatcaHttpError, toZatcaHttpError } from './errors';
import {
  PHASE2_UNIT_CODE, PLACEHOLDER_INVOICE_NUMBER, amountsFingerprintOf, buildInvoiceSource, classifyIssuanceUniqueViolation, currencyAllowed, effectiveIssuanceCurrency,
  issuanceHttpError, issuanceSubtype, mapAndCheck, nextNumberAfter, phase2InvoiceColumns, phase2ItemColumns, phase2NumberPrefix, prepareIssuance,
  signedInvoiceMirror, snapshotOf, storedAmounts, supplyDateIssues, supplyDateLowerBound, type EngineTotals, type IssuanceCustomer, type IssuanceRequest,
  type PrepareIssuanceInput,
} from './issue';
import { mapInvoiceToUbl } from './mapInvoice';
import { serializeUnsigned } from './ubl';
import { SIMPLIFIED_INVOICE, STANDARD_INVOICE, chainFor } from './__fixtures__/z1-sources';
import {
  COMPANY_VAT, CUSTOMERS, PRODUCTS, REQ_INCLUSIVE_2580, REQ_INCLUSIVE_2595, REQ_INCLUSIVE_R0, REQ_SIMPLIFIED_Z1, REQ_STANDARD_Z1, REQ_TWO_BUCKETS_002,
  Z1_ISSUED_AT, engineOf, inclusiveOne, sellerSettings,
} from './__fixtures__/z5-sources';

const fixtureXml = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'z1', `${name}.xml`), 'utf8').replace(/\r\n/g, '\n');

function input(over: Partial<PrepareIssuanceInput> = {}): PrepareIssuanceInput {
  const request = over.request ?? REQ_SIMPLIFIED_Z1;
  return {
    settings: sellerSettings(), customer: CUSTOMERS.individual, products: PRODUCTS, request, companyVat: COMPANY_VAT, engine: engineOf(request),
    now: Z1_ISSUED_AT, ...over,
  };
}

function httpError(fn: () => unknown): ZatcaHttpError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ZatcaHttpError, `ليس ZatcaHttpError: ${String(e)}`);
    return e;
  }
  assert.fail('لم يُرمَ خطأ');
}

const h = (s: string) => Number(parseAmount(s));

// ─── التحويل ───

test('مطابقة بايتات: طلب المندوب لعيّنة Z1 المبسّطة ⇒ الـXML غير الموقَّع نفسه حرفياً (نفس الرقم والسلسلة واللحظة)', () => {
  const src = buildInvoiceSource({ ...input(), number: 'INV-2609-000123' });
  assert.equal(serializeUnsigned(mapInvoiceToUbl(src, chainFor(1))), fixtureXml('simplified-invoice'));
  assert.equal(serializeUnsigned(mapInvoiceToUbl(src, chainFor(1))), serializeUnsigned(mapInvoiceToUbl(SIMPLIFIED_INVOICE, chainFor(1))));
  assert.equal(src.subtype, '02');
  assert.equal(src.paymentType, 'CASH');
  assert.equal(src.supplyDate, null);
  assert.equal(src.currency, 'SAR');
  assert.deepEqual(src.items.map(i => i.unitCode), [PHASE2_UNIT_CODE, PHASE2_UNIT_CODE]);
});

test('مطابقة بايتات: طلب المدير لعيّنة Z1 القياسية ⇒ الـXML نفسه عدا وحدة القياس (PCE في v1 بدل KGM/BX)', () => {
  const src = buildInvoiceSource({ ...input({ request: REQ_STANDARD_Z1, customer: CUSTOMERS.b2bComplete }), number: 'INV-2609-000124' });
  const expected = fixtureXml('standard-invoice').replace(/unitCode="(KGM|BX)"/g, 'unitCode="PCE"');
  assert.notEqual(expected, fixtureXml('standard-invoice'));
  assert.equal(serializeUnsigned(mapInvoiceToUbl(src, chainFor(2))), expected);
  assert.equal(serializeUnsigned(mapInvoiceToUbl({ ...STANDARD_INVOICE, items: STANDARD_INVOICE.items.map(i => ({ ...i, unitCode: 'PCE' })) }, chainFor(2))), expected);
  assert.equal(src.subtype, '01');
  assert.equal(src.paymentType, 'CREDIT');
  assert.equal(src.supplyDate, '2026-09-13');
});

test('طرق الدفع: CASH ⇒ 10، CREDIT ⇒ 30، خطة أقساط ⇒ INSTALLMENT (30)؛ RETURN ⇒ 422 يلزم الأصل؛ الإشعار بطريقة دفع أصله', () => {
  const pm = (request: IssuanceRequest) => mapInvoiceToUbl(buildInvoiceSource({ ...input({ request }) }), chainFor(1));
  assert.equal(pm({ ...REQ_SIMPLIFIED_Z1, type: 'CASH' }).paymentMeansCode, '10');
  assert.equal(pm({ ...REQ_SIMPLIFIED_Z1, type: 'CREDIT' }).paymentMeansCode, '30');
  const inst = buildInvoiceSource(input({ request: { ...REQ_SIMPLIFIED_Z1, type: 'CREDIT', paymentPlan: 'INSTALLMENT' } }));
  assert.equal(inst.paymentType, 'INSTALLMENT');
  assert.equal(mapInvoiceToUbl(inst, chainFor(1)).paymentMeansCode, '30');
  assert.equal(buildInvoiceSource(input({ request: { ...REQ_SIMPLIFIED_Z1, type: 'CREDIT', paymentPlan: 'IMMEDIATE' } })).paymentType, 'CREDIT');
  for (const fn of [() => buildInvoiceSource(input({ request: { ...REQ_SIMPLIFIED_Z1, type: 'RETURN' } })), () => prepareIssuance(input({ request: { ...REQ_SIMPLIFIED_Z1, type: 'RETURN' } }))]) {
    const e = httpError(fn);
    assert.equal(e.code, 'ZATCA_RETURN_NEEDS_ORIGINAL');
    assert.equal(e.status, 422);
  }
  const note = buildInvoiceSource({
    ...input({ request: { ...REQ_SIMPLIFIED_Z1, type: 'RETURN' }, customer: CUSTOMERS.b2bComplete }), kind: 'CREDIT_NOTE',
    note: { originalNumber: 'INV-2612-000001', originalSubtype: '02', originalPaymentType: 'CREDIT', reason: 'إرجاع بضاعة تالفة' },
  });
  assert.equal(note.subtype, '02', 'الإشعار يرث نوع أصله لا تصنيف العميل الحالي');
  assert.equal(note.paymentType, 'CREDIT');
  assert.deepEqual(note.billingReferences, ['INV-2612-000001']);
  assert.equal(note.noteReason, 'إرجاع بضاعة تالفة');
  assert.equal(mapInvoiceToUbl(note, chainFor(1)).paymentMeansCode, '30');
});

test('البنود بترتيب الطلب (seq 1..n): اسم الصنف وفئته وإعفاؤه من بطاقة المنتج، وtaxPct = البند ?? ضريبة الشركة، ووحدة PCE', () => {
  const request: IssuanceRequest = {
    type: 'CASH', pricesIncludeTax: false, discountPct: 0, items: [
      { productId: 'p-mask', qty: 1, unitPrice: 10, taxPct: 0 },
      { productId: 'p-water', qty: 2, unitPrice: 3 },
      { productId: 'p-gov-fee', qty: 1, unitPrice: 50, taxPct: 0 },
      { productId: 'p-water', qty: 1, unitPrice: 4, taxPct: 15 },
    ],
  };
  const src = buildInvoiceSource(input({ request, companyVat: 15 }));
  assert.deepEqual(src.items.map(i => [i.itemName, i.taxPct, i.vatCategory, i.vatExemptionCode]), [
    ['كمامات طبية', 0, 'Z', 'VATEX-SA-35'], ['مياه معدنية 330 مل × 40', 15, null, null], ['رسوم حكومية مستردّة', 0, 'O', 'VATEX-SA-OOS'], ['مياه معدنية 330 مل × 40', 15, null, null],
  ]);
  const doc = mapInvoiceToUbl(src, chainFor(1));
  assert.deepEqual(doc.lines.map(l => [l.id, l.vat.category, l.unitCode]), [[1, 'Z', 'PCE'], [2, 'S', 'PCE'], [3, 'O', 'PCE'], [4, 'S', 'PCE']]);
  // ضريبة الشركة 5% حين يغيب taxPct
  assert.equal(buildInvoiceSource(input({ request, companyVat: 5 })).items[1].taxPct, 5);
  // صنف غير موجود ⇒ 422 ZATCA_PREFLIGHT باسم البند
  const e = httpError(() => prepareIssuance(input({ request: { ...request, items: [{ productId: 'p-missing', qty: 1, unitPrice: 1 }] } })));
  assert.equal(e.code, 'ZATCA_PREFLIGHT');
  assert.equal(e.issues?.[0].field, 'items[0].productId');
});

test('النوع الفرعي (D2/Q2): منشأة/حكومية/رقم ضريبي/سجل ⇒ 01؛ فرد صريح وغير المصنّف (قناة، اسم منشأة، معرّف منشأة وحده) ⇒ 02 — مطابق لـcustomerBuyerStatus', () => {
  const expected: Record<keyof typeof CUSTOMERS, '01' | '02'> = {
    b2bComplete: '01', b2bArabicDigits: '01', b2bIncomplete: '01', crOnlyIncomplete: '01', government: '01',
    individual: '02', individualWithVat: '02', unclassifiedChannel: '02', unclassifiedBusinessId: '02',
  };
  for (const [k, c] of Object.entries(CUSTOMERS) as Array<[keyof typeof CUSTOMERS, IssuanceCustomer]>) {
    assert.equal(issuanceSubtype(c), expected[k], k);
    assert.equal(customerBuyerStatus(c).subtypeIfIssuedNow, expected[k], `${k}: قاعدة واحدة مع قائمة D2`);
  }
  assert.equal(customerBuyerStatus(CUSTOMERS.unclassifiedChannel).classification, 'unclassified');
  assert.equal(customerBuyerStatus(CUSTOMERS.unclassifiedBusinessId).classification, 'unclassified');
});

test('حجب D2: قياسية لمنشأة بيانات ناقصة ⇒ 422 ZATCA_BUYER_INCOMPLETE بمعرّف العميل والحقول قبل أي قفل؛ الأرقام الهندية تُطبَّع فتكتمل؛ المبسّطة لا تُحجب أبداً', () => {
  for (const c of [CUSTOMERS.b2bIncomplete, CUSTOMERS.crOnlyIncomplete]) {
    const e = httpError(() => prepareIssuance(input({ customer: c })));
    assert.equal(e.code, 'ZATCA_BUYER_INCOMPLETE');
    assert.equal(e.status, 422);
    assert.equal(e.customerId, c.id);
    assert.ok(e.issues && e.issues.length > 0 && e.issues.every(i => i.severity === 'error'));
    assert.match(e.messageAr, /^بيانات العميل \(منشأة\) ناقصة للفاتورة الضريبية: .+\. أكملها ثم أعد الإصدار$/);
    const body = e.body();
    assert.equal(body.customerId, c.id);
    assert.equal(body.success, false);
  }
  const inc = httpError(() => prepareIssuance(input({ customer: CUSTOMERS.b2bIncomplete })));
  assert.deepEqual(new Set(inc.issues!.map(i => i.field)), new Set(['customer.address.street', 'customer.address.buildingNumber', 'customer.address.district', 'customer.address.postalZone']));
  assert.deepEqual(inc.data, { fields: ['addrStreet', 'addrBuildingNo', 'district', 'addrPostalCode'] });
  assert.deepEqual(inc.body().data, inc.data);
  const ar = prepareIssuance(input({ customer: CUSTOMERS.b2bArabicDigits }));
  assert.equal(ar.subtype, '01');
  assert.equal(ar.src.buyer.taxNumber, '311111111111113');
  assert.equal(ar.src.buyer.addrBuildingNo, '7788');
  for (const c of [CUSTOMERS.individual, CUSTOMERS.individualWithVat, CUSTOMERS.unclassifiedChannel, CUSTOMERS.unclassifiedBusinessId]) {
    const p = prepareIssuance(input({ customer: c }));
    assert.equal(p.subtype, '02');
    assert.equal(p.stampKind, 'simplified');
    assert.equal(p.typeName, '0200000');
  }
  const gov = prepareIssuance(input({ customer: CUSTOMERS.government, request: REQ_STANDARD_Z1 }));
  assert.equal(gov.typeName, '0100000');
});

test('D9: عملة غير SAR أو تجاوز عملة غير SAR ⇒ 422 ZATCA_CURRENCY؛ التجاوز الفارغ أو SAR مسموح', () => {
  assert.equal(currencyAllowed({ currency: 'SAR', currencyOverride: null }), true);
  assert.equal(currencyAllowed({ currency: 'sar', currencyOverride: '' }), true);
  assert.equal(currencyAllowed({ currency: 'SAR', currencyOverride: 'SAR' }), true);
  assert.equal(effectiveIssuanceCurrency({ currency: 'SAR', currencyOverride: 'usd' }), 'USD');
  for (const over of [{ currency: 'USD' }, { currencyOverride: 'USD' }, { currencyOverride: 'EUR' }, { currency: 'AED', currencyOverride: 'SAR' }]) {
    const e = httpError(() => prepareIssuance(input({ settings: sellerSettings(over) })));
    assert.equal(e.code, 'ZATCA_CURRENCY', JSON.stringify(over));
    assert.equal(e.status, 422);
    assert.equal(e.messageAr, 'الريال السعودي فقط للشركات المربوطة بالمرحلة الثانية');
  }
});

test('الخصم الكلّي على أسعار شاملة ⇒ 422 ZATCA_INCLUSIVE_HEAD_DISCOUNT؛ مسموح على الأسعار الصافية', () => {
  const request = { ...REQ_SIMPLIFIED_Z1, discountPct: 5 };
  const e = httpError(() => prepareIssuance(input({ request })));
  assert.equal(e.code, 'ZATCA_INCLUSIVE_HEAD_DISCOUNT');
  assert.equal(e.status, 422);
  assert.equal(e.messageAr, 'الخصم على إجمالي الفاتورة غير مسموح مع الأسعار الشاملة للضريبة — ضع الخصم على الأصناف');
  const ok = prepareIssuance(input({ request: { ...REQ_STANDARD_Z1, supplyDate: null }, customer: CUSTOMERS.individual }));
  assert.equal(ok.amounts.discountAmt > 0, true);
});

test('بند بقيمة صفرية (سعر 0 أو خصم 100%) ⇒ 422 ZATCA_ZERO_VALUE_LINE (U5: هدايا البضاعة لم تُحسم)', () => {
  for (const it of [{ productId: 'p-water', qty: 1, unitPrice: 0, discountPct: 0 }, { productId: 'p-water', qty: 2, unitPrice: 4, discountPct: 100 }]) {
    const request: IssuanceRequest = { ...REQ_SIMPLIFIED_Z1, items: [REQ_SIMPLIFIED_Z1.items[0], it] };
    const e = httpError(() => prepareIssuance(input({ request })));
    assert.equal(e.code, 'ZATCA_ZERO_VALUE_LINE', JSON.stringify(it));
    assert.equal(e.messageAr, 'لا يمكن إصدار صنف بسعر صفر في فاتورة ضريبية');
  }
});

test('فئة الصنف: 0% بلا فئة ⇒ 422 ZATCA_PREFLIGHT (BR-KSA-18)؛ فئة Z بنسبة 15% ⇒ BR-Z-05؛ Z/E/O صحيحة تُصدر', () => {
  const one = (productId: string, taxPct: number) => ({ ...REQ_SIMPLIFIED_Z1, items: [{ productId, qty: 1, unitPrice: 10, discountPct: 0, taxPct }] });
  let e = httpError(() => prepareIssuance(input({ request: one('p-zero-uncat', 0) })));
  assert.equal(e.code, 'ZATCA_PREFLIGHT');
  assert.equal(e.issues?.[0].rule, 'BR-KSA-18');
  assert.match(e.messageAr, /^بيانات ناقصة أو غير صحيحة لإصدار فاتورة ضريبية: فئة الضريبة للصنف «صنف بنسبة صفر بلا فئة» غير محددة/);
  e = httpError(() => prepareIssuance(input({ request: one('p-mask', 15) })));
  assert.equal(e.code, 'ZATCA_PREFLIGHT');
  assert.ok(e.issues?.some(i => i.rule === 'BR-Z-05'));
  for (const p of ['p-mask', 'p-fin', 'p-gov-fee']) {
    const ok = prepareIssuance(input({ request: one(p, 0) }));
    assert.equal(ok.amounts.taxAmt, 0, p);
    assert.equal(ok.items[0].vatExemptionCode !== null, true, p);
  }
});

test('بيانات البائع الناقصة ⇒ 503 ZATCA_UNIT_UNAVAILABLE (SELLER_NOT_READY) بالقائمة — لا 422 على المندوب (نقد 12)', () => {
  for (const over of [{ addrBuildingNo: null }, { legalName: null }, { taxNumber: '123' }]) {
    const e = httpError(() => prepareIssuance(input({ settings: sellerSettings(over) })));
    assert.equal(e.code, 'ZATCA_UNIT_UNAVAILABLE', JSON.stringify(over));
    assert.equal(e.status, 503);
    assert.equal(e.reason, 'SELLER_NOT_READY');
    assert.equal(e.messageAr, 'بيانات المنشأة ناقصة لإصدار فاتورة ضريبية — راجع مدير الشركة');
    assert.ok(e.issues?.some(i => i.field.startsWith('supplier.')));
  }
});

test('تاريخ التوريد (نقد 24): القياسية تقبل الماضي حتى أول الشهر السابق (إصدار ≤ 15) أو الجاري (> 15)، وترفض المستقبل؛ المبسّطة تتجاهله', () => {
  assert.equal(supplyDateLowerBound('2026-12-15'), '2026-11-01');
  assert.equal(supplyDateLowerBound('2026-12-16'), '2026-12-01');
  assert.equal(supplyDateLowerBound('2027-01-10'), '2026-12-01');
  assert.equal(supplyDateLowerBound('2027-01-31'), '2027-01-01');
  const std = (supplyDate: string | null, at: string) => prepareIssuance(input({ request: { ...REQ_STANDARD_Z1, supplyDate }, customer: CUSTOMERS.b2bComplete, now: new Date(at) }));
  // 2026-12-15 12:00 الرياض
  assert.equal(std('2026-11-01', '2026-12-15T09:00:00Z').src.supplyDate, '2026-11-01');
  assert.equal(std(null, '2026-12-15T09:00:00Z').src.supplyDate, null);
  assert.equal(std('2026-12-15', '2026-12-15T09:00:00Z').src.supplyDate, '2026-12-15');
  for (const [s, at, needle] of [
    ['2026-10-31', '2026-12-15T09:00:00Z', 'أقدم'], ['2026-11-30', '2026-12-16T09:00:00Z', 'أقدم'], ['2026-12-16', '2026-12-15T09:00:00Z', 'مستقبلي'],
  ] as const) {
    const e = httpError(() => std(s, at));
    assert.equal(e.code, 'ZATCA_PREFLIGHT', s);
    assert.equal(e.issues?.[0].rule, 'KSA-VATIR-53');
    assert.ok(e.issues?.[0].messageAr.includes(needle), e.issues?.[0].messageAr);
  }
  // بتوقيت الرياض: 21:30Z يوم 14 = 00:30 يوم 15 ⇒ تاريخ الإصدار 15 فالشهر السابق مقبول
  assert.equal(std('2026-11-02', '2026-12-14T21:30:00Z').src.supplyDate, '2026-11-02');
  // صيغة غير صالحة ⇒ BR-KSA-F-01
  const bad = httpError(() => std('15/12/2026', '2026-12-15T09:00:00Z'));
  assert.equal(bad.code, 'ZATCA_PREFLIGHT');
  assert.equal(bad.issues?.[0].rule, 'BR-KSA-F-01');
  // المبسّطة: تاريخ المدير يُهمل (التوريد = الإصدار)
  const simp = prepareIssuance(input({ request: { ...REQ_SIMPLIFIED_Z1, supplyDate: '2025-01-01' }, now: new Date('2026-12-15T09:00:00Z') }));
  assert.equal(simp.src.supplyDate, null);
  assert.deepEqual(supplyDateIssues({ typeName: '0200000', issueDate: '2026-12-15', supplyDate: '2020-01-01' }), []);
});

// ─── المبالغ المخزَّنة (§2.4 / D6) ───

function assertStoredInvariants(engine: EngineTotals, doc: Parameters<typeof storedAmounts>[1], inclusive: boolean, label: string) {
  const a = storedAmounts(engine, doc, { pricesIncludeTax: inclusive });
  const t = doc.totals;
  assert.equal(a.total, engine.total, `${label}: total = السعر المعلن`);
  assert.equal(Math.round(a.total * 100), h(t.payable), `${label}: total = PayableAmount`);
  assert.equal(Math.round(a.taxAmt * 100), h(t.taxTotal), `${label}: taxAmt = TaxTotal`);
  assert.equal(a.items.reduce((s, i) => s + Math.round(i.taxAmt * 100), 0), h(t.taxTotal), `${label}: Σ ضريبة البنود = الترويسة`);
  a.items.forEach((it, i) => assert.equal(Math.round(it.taxAmt * 100), h(doc.lines[i].taxAmount), `${label}: بند ${i}`));
  assert.equal(Math.round(a.subtotal * 100) - Math.round(a.discountAmt * 100), h(t.taxExclusive), `${label}: subtotal − discountAmt = TaxExclusive`);
  const rounding = Math.round(a.total * 100) - Math.round(a.subtotal * 100) + Math.round(a.discountAmt * 100) - Math.round(a.taxAmt * 100);
  assert.equal(rounding, Math.round(a.payableRounding * 100), `${label}: الهوية`);
  assert.equal(rounding, t.payableRounding === undefined ? 0 : h(t.payableRounding), `${label}: = BT-114`);
  assert.ok(Math.abs(a.subtotalAdjustmentHalalas) <= doc.subtotals.length, `${label}: فرق subtotal ${a.subtotalAdjustmentHalalas}`);
  if (!inclusive) {
    assert.equal(a.subtotal, engine.subtotal, `${label}: الحصري = المحرّك`);
    assert.equal(a.discountAmt, engine.discountAmt, label);
    assert.equal(a.taxAmt, engine.taxAmt, label);
    assert.equal(a.payableRounding, 0, label);
  }
  return a;
}

test('D6: بقية 0 و0.01 (G = 25.80 و25.95) و0.02 (نسبتان) — الإجمالي هو السعر المعلن والضريبة ضريبة الـXML و«فرق التقريب» مخزَّن', () => {
  const cases: Array<[IssuanceRequest, number, number]> = [
    [REQ_INCLUSIVE_R0, 11.5, 0], [REQ_INCLUSIVE_2580, 25.8, 0.01], [REQ_INCLUSIVE_2595, 25.95, 0.01], [REQ_TWO_BUCKETS_002, 25.9, 0.02], [REQ_SIMPLIFIED_Z1, 41.05, 0.01],
  ];
  for (const [request, total, rounding] of cases) {
    const p = prepareIssuance(input({ request }));
    assert.equal(p.amounts.total, total, JSON.stringify(request.items));
    assert.equal(p.amounts.payableRounding, rounding, JSON.stringify(request.items));
    const doc = mapInvoiceToUbl(p.src, chainFor(1));
    assert.equal(doc.totals.payableRounding, rounding === 0 ? undefined : rounding.toFixed(2));
    assertStoredInvariants(engineOf(request), doc, true, String(total));
    // الـXML نفسه يحمل الضريبة المخزَّنة
    const xml = serializeUnsigned(doc);
    assert.ok(xml.includes(`<cbc:TaxAmount currencyID="SAR">${p.amounts.taxAmt.toFixed(2)}</cbc:TaxAmount>`), `${total}: TaxAmount في الـXML`);
    assert.deepEqual(p.items.map(i => i.taxAmt), p.amounts.items.map(i => i.taxAmt));
  }
  const g2580 = prepareIssuance(input({ request: REQ_INCLUSIVE_2580 })).amounts;
  assert.deepEqual([g2580.subtotal, g2580.discountAmt, g2580.taxAmt, g2580.total], [22.43, 0, 3.36, 25.8]);
  // المحرّك وحده كان سيخزّن ضريبة 3.37 (25.80×15/115) — اختلافها عن الـXML هو ما يصحّحه §2.4
  assert.equal(engineOf(REQ_INCLUSIVE_2580).taxAmt, 3.37);
});

test('خاصية §2.4: كل G من 0.01 إلى 1000.00 شاملة 15% — البقية ∈ {0، 0.01}، taxAmt = TaxTotal، Σ البنود = الترويسة، الإجمالي = G', () => {
  const seen = new Set<number>();
  for (let g = 1; g <= 100_000; g++) {
    const price = g / 100;
    const items = [{ qty: 1, unitPrice: price, discountPct: 0, taxPct: 15 }];
    const engine = computeInvoiceTotals(items, { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
    const { result } = computeUblAmountsDetailed({ pricesIncludeTax: true, invoiceDiscountPct: 0, lines: [{ ...items[0], vatPct: 15, category: 'S' }] });
    const a = storedAmounts(engine, result, { pricesIncludeTax: true });
    const r = Math.round(a.payableRounding * 100);
    seen.add(r);
    if (Math.round(a.total * 100) !== g || (r !== 0 && r !== 1) || Math.round(a.taxAmt * 100) !== h(result.totals.taxTotal)
      || Math.round(a.items[0].taxAmt * 100) !== h(result.totals.taxTotal)
      || Math.round(a.subtotal * 100) - Math.round(a.discountAmt * 100) + Math.round(a.taxAmt * 100) + r !== g
      || Math.abs(a.subtotalAdjustmentHalalas) > 1) {
      assert.fail(`G=${price}: ${JSON.stringify(a)}`);
    }
  }
  assert.deepEqual([...seen].sort(), [0, 1]);
  // عيّنة عبر المسار الكامل (تحويل + تسلسل): TaxAmount في الـXML = taxAmt المخزَّن
  for (let g = 7; g <= 100_000; g += 997) {
    const p = prepareIssuance(input({ request: inclusiveOne(g / 100) }));
    const xml = serializeUnsigned(mapInvoiceToUbl(p.src, chainFor(1)));
    const tax = /<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="SAR">([0-9.]+)<\/cbc:TaxAmount>/.exec(xml)![1];
    assert.equal(Number(tax), p.amounts.taxAmt, `G=${g / 100}`);
  }
});

test('خاصية §2.4 بنسبتين (15% و5%): البقية ∈ {0، 0.01، 0.02} وتظهر الثلاث، والثوابت كلها', () => {
  const seen = new Set<number>();
  for (let a = 1; a <= 1000; a++) {
    for (let b = 1; b <= 63; b++) {
      const items = [{ qty: 1, unitPrice: a / 100, discountPct: 0, taxPct: 15 }, { qty: 1, unitPrice: b / 100, discountPct: 0, taxPct: 5 }];
      const engine = computeInvoiceTotals(items, { companyVat: 15, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
      const { result } = computeUblAmountsDetailed({ pricesIncludeTax: true, invoiceDiscountPct: 0, lines: items.map(i => ({ ...i, vatPct: i.taxPct, category: 'S' as const })) });
      const s = storedAmounts(engine, result, { pricesIncludeTax: true });
      const r = Math.round(s.payableRounding * 100);
      seen.add(r);
      if (Math.round(s.total * 100) !== a + b || r < 0 || r > 2 || s.items.reduce((x, i) => x + Math.round(i.taxAmt * 100), 0) !== h(result.totals.taxTotal)
        || Math.abs(s.subtotalAdjustmentHalalas) > 2) {
        assert.fail(`${a / 100}+${b / 100}: ${JSON.stringify(s)}`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

test('متجهات دقة الكسور (money-precision): الشامل والحصري وسلة 100 بند وخصم الفاتورة الموزَّع — الحصري يطابق المحرّك حرفياً', () => {
  const R = (items: IssuanceRequest['items'], pricesIncludeTax: boolean, discountPct = 0): IssuanceRequest => ({ type: 'CASH', pricesIncludeTax, discountPct, items });
  const vectors: Array<[string, IssuanceRequest, number]> = [
    ['10.00 شامل', R([{ productId: 'p-water', qty: 1, unitPrice: 10, taxPct: 15 }], true), 10],
    ['100 × 10 شامل', R([{ productId: 'p-water', qty: 100, unitPrice: 10, taxPct: 15 }], true), 1000],
    ['100 × 0.02 شامل', R([{ productId: 'p-water', qty: 100, unitPrice: 0.02, taxPct: 15 }], true), 2],
    ['أربعة بنود مختلطة شاملة', R([
      { productId: 'p-water', qty: 3, unitPrice: 0.1, discountPct: 0, taxPct: 15 }, { productId: 'p-juice', qty: 7, unitPrice: 6.7, discountPct: 10, taxPct: 15 },
      { productId: 'p-mask', qty: 1, unitPrice: 0.09, discountPct: 0, taxPct: 0 }, { productId: 'p-sugar', qty: 2.5, unitPrice: 1.999, discountPct: 33.33, taxPct: 15 },
    ], true), 0],
    ['أربعة بنود مختلطة حصرية بخصم 5%', R([
      { productId: 'p-water', qty: 3, unitPrice: 0.1, discountPct: 0, taxPct: 15 }, { productId: 'p-juice', qty: 7, unitPrice: 6.7, discountPct: 10, taxPct: 15 },
      { productId: 'p-mask', qty: 1, unitPrice: 0.09, discountPct: 0, taxPct: 0 }, { productId: 'p-sugar', qty: 2.5, unitPrice: 1.999, discountPct: 33.33, taxPct: 15 },
    ], false, 5), 0],
    ['100 × 1.03 حصري', R(Array.from({ length: 100 }, () => ({ productId: 'p-water', qty: 1, unitPrice: 1.03, taxPct: 15 })), false), 118.45],
    ['10 × 1.09 بخصم فاتورة 5% حصري', R(Array.from({ length: 10 }, () => ({ productId: 'p-water', qty: 1, unitPrice: 1.09, taxPct: 15 })), false, 5), 0],
  ];
  for (const [label, request, total] of vectors) {
    const engine = engineOf(request);
    const p = prepareIssuance(input({ request }));
    if (total) assert.equal(p.amounts.total, total, label);
    assert.equal(p.amounts.total, engine.total, label);
    assertStoredInvariants(engine, mapInvoiceToUbl(p.src, chainFor(1)), request.pricesIncludeTax, label);
  }
  // 100 × 1.03: ضريبة السلة 15.45 (لا 15.00)
  const basket = prepareIssuance(input({ request: vectors[5][1] }));
  assert.equal(basket.amounts.taxAmt, 15.45);
  assert.equal(basket.items.length, 100);
  assert.deepEqual(basket.items.map(i => i.seq), Array.from({ length: 100 }, (_, i) => i + 1));
});

test('تعارض المحرّك والمستند ⇒ 422 ZATCA_AMOUNTS (ENGINE_ROUNDING_CONFLICT) قبل أي قفل — إجمالي مختلف، بنود ناقصة، أو قيمة بأكثر من خانتين', () => {
  const request = REQ_INCLUSIVE_2580;
  const doc = mapInvoiceToUbl(buildInvoiceSource(input({ request })), chainFor(1));
  const engine = engineOf(request);
  for (const bad of [{ ...engine, total: 25.81 }, { ...engine, items: [] }, { ...engine, discountAmt: 0.001 }, { ...engine, total: Number.NaN }]) {
    const e = toZatcaHttpError((() => { try { storedAmounts(bad, doc, { pricesIncludeTax: true }); } catch (x) { return x; } return null; })());
    assert.ok(e, JSON.stringify(bad));
    assert.equal(e!.code, 'ZATCA_AMOUNTS');
    assert.equal(e!.subcode, 'ENGINE_ROUNDING_CONFLICT');
  }
  const e = httpError(() => prepareIssuance(input({ request, engine: { ...engine, total: 25.79 } })));
  assert.equal(e.code, 'ZATCA_AMOUNTS');
  assert.equal(e.status, 422);
  // الحصري: أي فرق عن المحرّك خلل
  const std = mapInvoiceToUbl(buildInvoiceSource(input({ request: REQ_STANDARD_Z1, customer: CUSTOMERS.b2bComplete })), chainFor(2));
  const se = engineOf(REQ_STANDARD_Z1);
  assert.throws(() => storedAmounts({ ...se, taxAmt: se.taxAmt + 0.01 }, std, { pricesIncludeTax: false }), /ENGINE_ROUNDING_CONFLICT/);
});

test('prepareIssuance: الرقم مؤقت، والبصمة لا تعتمد على السلسلة، والبنود لقطات الـXML، والتحذيرات غير المانعة تُعاد', () => {
  const p = prepareIssuance(input({ request: REQ_STANDARD_Z1, customer: CUSTOMERS.b2bComplete }));
  assert.equal(p.src.number, PLACEHOLDER_INVOICE_NUMBER);
  assert.equal(p.stampKind, 'standard');
  assert.equal(p.typeCode, '388');
  assert.equal(p.customerId, 'c-b2b');
  assert.deepEqual(p.items.map(i => [i.seq, i.unitCode, i.vatCategory, i.vatExemptionCode]), [[1, 'PCE', 'S', null], [2, 'PCE', 'S', null], [3, 'PCE', 'Z', 'VATEX-SA-35']]);
  const a = mapAndCheck({ ...p.src, number: 'INV-2612-000009' }, { icv: 77, pih: INITIAL_PIH, uuid: '0e2f6f52-8a4f-4d5b-9a51-0c2b5c3f7a11', issuedAt: new Date('2026-09-14T11:00:00Z') });
  assert.equal(amountsFingerprintOf(a.doc), p.amountsFingerprint);
  assert.ok(Array.isArray(p.warnings) && p.warnings.every(w => w.severity === 'warning'));
});

// ─── صفّ الفاتورة والمرآة والترقيم ───

test('المرآة عند التوقيع: المبسّطة signed بختمنا؛ القياسية clearance_pending بلا QR؛ وأعمدة الصفّ zatcaPhase=2 وinvoiceDate = issuedAt', () => {
  const base = { uuid: 'u-1', invoiceHash: 'h', pih: INITIAL_PIH, icv: 3, qr: 'QRDATA' };
  assert.deepEqual(signedInvoiceMirror({ ...base, subtype: '02' }), {
    einvoiceProvider: 'zatca', einvoiceStatus: 'signed', einvoiceUuid: 'u-1', einvoiceHash: 'h', einvoicePih: INITIAL_PIH, einvoiceIcv: 3, einvoiceQr: 'QRDATA', einvoiceWarnings: null,
  });
  const std = signedInvoiceMirror({ ...base, subtype: '01' });
  assert.equal(std.einvoiceStatus, 'clearance_pending');
  assert.equal(std.einvoiceQr, null);
  const p = prepareIssuance(input({ request: REQ_INCLUSIVE_2580 }));
  const issuedAt = new Date('2026-12-01T09:00:00Z');
  const doc = mapInvoiceToUbl({ ...p.src, number: 'INV-2612-000001' }, { icv: 3, pih: INITIAL_PIH, uuid: 'u-1', issuedAt });
  const cols = phase2InvoiceColumns({
    tenantId: 't', number: 'INV-2612-000001', issuedAt, kind: 'INVOICE', subtype: '02', typeName: '0200000', snapshot: snapshotOf(doc), amounts: p.amounts,
    items: p.items, mirror: signedInvoiceMirror({ ...base, subtype: '02' }),
  });
  assert.equal(cols.zatcaPhase, 2);
  assert.equal(cols.documentKind, 'INVOICE');
  assert.equal(cols.invoiceSubtype, '02');
  assert.equal(cols.invoiceDate, issuedAt);
  assert.equal(cols.issuedAt, issuedAt);
  assert.deepEqual([cols.subtotal, cols.discountAmt, cols.taxAmt, cols.total], [22.43, 0, 3.36, 25.8]);
  assert.equal(cols.einvoiceSnapshot.totals.payableRounding, '0.01', 'اللقطة تحمل فرق التقريب للطباعة');
  assert.equal('uuid' in cols.einvoiceSnapshot, false, 'اللقطة بلا قيم السلسلة');
  assert.deepEqual(phase2ItemColumns(p.items[0]), { seq: 1, itemName: 'مياه معدنية 330 مل × 40', unitCode: 'PCE', vatCategory: 'S', vatExemptionCode: null, vatExemptionReason: null, taxAmt: 3.36 });
});

test('بادئة رقم المرحلة الثانية بشهر الرياض (F17)، والرقم التالي بستّ خانات كالمسار القديم', () => {
  assert.equal(phase2NumberPrefix('INV', new Date('2026-09-30T20:59:59Z')), 'INV-2609-');
  assert.equal(phase2NumberPrefix('INV', new Date('2026-09-30T21:00:00Z')), 'INV-2610-', '00:00 الرياض أول أكتوبر');
  assert.equal(phase2NumberPrefix('RET', new Date('2026-12-31T21:30:00Z')), 'RET-2701-');
  assert.equal(nextNumberAfter('INV-2610-', null), 'INV-2610-000001');
  assert.equal(nextNumberAfter('INV-2610-', 'INV-2610-000041'), 'INV-2610-000042');
  assert.equal(nextNumberAfter('INV-2610-', 'INV-2610-abc'), 'INV-2610-000001');
});

test('تصنيف P2002 (نقد 26): السلسلة ⇒ ZATCA_CHAIN_CONFLICT بتنبيه؛ clientRef ⇒ null (الفاتورة القائمة)؛ number ⇒ يُعاد (وبعد الاستنفاد UNIT_BUSY)', () => {
  const e = (meta: Record<string, unknown>) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ modelName: 'ZatcaDocument', target: ['egsUnitId', 'icv'] }, 'chain'],
    [{ modelName: 'ZatcaDocument', target: ['uuid'] }, 'chain'],
    [{ modelName: 'ZatcaDocument', target: ['invoiceId', 'attemptNo'] }, 'chain'],
    [{ target: 'zatca_documents_egsUnitId_icv_key' }, 'chain'],
    [{ target: ['egsUnitId', 'icv'] }, 'chain'],
    [{ modelName: 'Invoice', target: ['tenantId', 'clientRef'] }, 'clientRef'],
    [{ target: 'invoices_tenantId_clientRef_key' }, 'clientRef'],
    [{ modelName: 'Invoice', target: ['tenantId', 'number'] }, 'number'],
    [{ target: 'invoices_tenantId_number_key' }, 'number'],
    [{ modelName: 'Customer', target: ['tenantId', 'clientRef'] }, 'other'],
    [{ modelName: 'Invoice', target: ['id'] }, 'other'],
  ];
  for (const [meta, want] of cases) {
    assert.equal(classifyIssuanceUniqueViolation(e(meta)), want, JSON.stringify(meta));
    const http = issuanceHttpError(e(meta));
    if (want === 'chain') { assert.equal(http?.code, 'ZATCA_CHAIN_CONFLICT'); assert.equal(http?.alert, true); assert.equal(http?.status, 503); }
    if (want === 'clientRef') assert.equal(http, null);
    if (want === 'number') { assert.equal(http?.code, 'ZATCA_UNIT_BUSY'); assert.equal(http?.alert, false); }
    if (want === 'other') assert.equal(http, null);
  }
  assert.equal(classifyIssuanceUniqueViolation(Object.assign(new Error('x'), { code: 'P2028' })), null);
  assert.equal(issuanceHttpError(Object.assign(new Error('x'), { code: 'P2028' }))?.code, 'ZATCA_UNIT_BUSY');
  assert.equal(issuanceHttpError(new DocumentBytesError('TOO_LARGE', 'x'))?.code, 'ZATCA_STAMP_FAILED');
  assert.equal(issuanceHttpError(new Error('عادي')), null);
  const passthrough = new ZatcaHttpError('ZATCA_CURRENCY');
  assert.equal(issuanceHttpError(passthrough), passthrough);
});

test('وحدات Z5.2 نقيّة: لا قاعدة بيانات وقت التشغيل ولا شبكة ولا process.env ولا services/gl ولا ملفات', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const f of ['issue.ts', 'issueChain.ts', 'issueSigner.ts', 'issueTx.ts', 'unitMutex.ts', 'issueStore.prisma.ts']) {
    const src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    assert.doesNotMatch(src, /config\/database|services\/gl|process\.env|fetch\(|from ['"]fs['"]|require\(['"]fs['"]|FatooraClient|\.report\(|\.clear\(/, f);
    assert.doesNotMatch(src, /^import (?!type )[^;]*from '@prisma\/client'/m, `${f}: @prisma/client يُستورد نوعياً فقط`);
  }
});
