// اختبارات Z5.5 لنواة الإشعارات (notes.ts): مطابقة بايتات مع عيّنة Z1 الذهبية للإشعار الدائن، إشعار كامل على فاتورة شاملة الضريبة
// يطابق مبالغها حرفاً بحرف، إشعار جزئي على فاتورة حصرية بخصم كلّي، وراثة النوع الفرعي، طريقة الدفع (BR-49)، حرّاس الكمية والقيمة
// (لكل بند ولكل فاتورة ومع إشعارات سابقة)، رفض الإشعار على فاتورة مرفوضة/مُبطلة (D4 وQ1) وعلى إشعار وعلى فاتورة شركة أخرى،
// أصل من المرحلة الأولى (تصنيف حيّ + حجب D2)، اتّصال السلسلة مع إشعارين متوازيين، وأعمدة الصفّ وأثر F1 على المتبقّي.
// لا قاعدة بيانات ولا شبكة (z3-netguard يمنعها).
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseCsidToken } from './cert';
import { INITIAL_PIH } from './crypto';
import { gunzipXml } from './documentStore';
import { ZatcaHttpError } from './errors';
import { prepareIssuance, signedInvoiceMirror, snapshotOf, type IssuedInvoiceRecord } from './issue';
import { runIssuance } from './issueTx';
import { mapBuyerParty, mapInvoiceToUbl } from './mapInvoice';
import {
  assertCreditAmount, buyerIdentityDrift, creditAmountTolerance, creditNoteLegacyColumns, creditableLines, creditedTotalOf,
  debitNoteLegacyColumns, hasCreditableQty, isNoteKind, noteEligibility, noteInvoiceColumns, noteItemColumns, noteNumberPrefix,
  noteRefusalError, prepareCreditNote, prepareDebitNote, remainingAfterCreditNote, resolveCreditLines, resolveReturnToStock,
  stampNoteInTx, taxBucketCount, effectiveCreditScope,
  type NoteEligible, type NoteOriginalInvoice, type PrepareCreditNoteInput, type PriorNote,
} from './notes';
import { verifyStampedXml } from './stamp';
import { serializeUnsigned } from './ubl';
import { KeyedAsyncMutex } from './unitMutex';
import { BUSINESS_BUYER } from './__fixtures__/z1-sources';
import { chainFor } from './__fixtures__/z1-sources';
import { createHarness } from './__fixtures__/z5-issuance';
import { ORIGINAL_Z1_STANDARD, engineFor, originalInvoice, priorNote } from './__fixtures__/z5-notes';
import {
  COMPANY_VAT, CUSTOMERS, PRODUCTS, REQ_SIMPLIFIED_Z1, REQ_STANDARD_Z1, Z1_ISSUED_AT, Z5_TENANT, Z5_VAT, engineOf, sellerSettings,
} from './__fixtures__/z5-sources';

const fixtureXml = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'z1', `${name}.xml`), 'utf8').replace(/\r\n/g, '\n');

function httpError(fn: () => unknown): ZatcaHttpError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ZatcaHttpError, `ليس ZatcaHttpError: ${String(e)}`);
    return e;
  }
  assert.fail('لم يُرمَ خطأ');
}

function eligible(original: NoteOriginalInvoice, customer = CUSTOMERS.b2bComplete): NoteEligible {
  const e = noteEligibility({ tenantId: Z5_TENANT, original, customer });
  assert.ok(e.ok, `الأصل غير مؤهَّل: ${e.ok ? '' : e.refusal}`);
  return e;
}

type CreditOver = Partial<PrepareCreditNoteInput> & { original: NoteOriginalInvoice };

function credit(over: CreditOver) {
  const customer = over.customer ?? CUSTOMERS.b2bComplete;
  return prepareCreditNote({
    settings: sellerSettings(),
    customer,
    original: over.original,
    priorNotes: over.priorNotes ?? [],
    request: over.request ?? 'FULL',
    reason: over.reason ?? 'إرجاع بضاعة تالفة',
    eligibility: over.eligibility ?? eligible(over.original, customer),
    companyVat: over.companyVat ?? COMPANY_VAT,
    now: over.now ?? Z1_ISSUED_AT,
    ...(over.legacyReturns !== undefined ? { legacyReturns: over.legacyReturns } : {}),
    ...(over.originalBuyer !== undefined ? { originalBuyer: over.originalBuyer } : {}),
  });
}

const SIMPLIFIED_ORIGINAL = () => originalInvoice({
  request: REQ_SIMPLIFIED_Z1, subtype: '02', customerId: 'c-walkin', einvoiceStatus: 'reported', number: 'INV-2609-000123',
});

// ─── التحويل (مطابقة البايتات والمبالغ) ───

test('مطابقة بايتات: إشعار دائن جزئي على عيّنة Z1 القياسية ⇒ عين مستند Z1 الذهبي للإشعار', () => {
  const p = credit({ original: ORIGINAL_Z1_STANDARD, request: [{ invoiceItemId: 'it-1', qty: 2 }] });
  const doc = mapInvoiceToUbl({ ...p.prepared.src, number: 'RET-2609-000045' }, chainFor(3));
  assert.equal(serializeUnsigned(doc), fixtureXml('standard-credit-note'));
  assert.equal(doc.typeCode, '381');
  assert.equal(doc.typeName, '0100000');
  assert.deepEqual(doc.billingReferences, ['INV-2609-000124']);
  assert.equal(doc.instructionNote, 'إرجاع بضاعة تالفة');
  assert.equal(doc.paymentMeansCode, '30', 'BR-49: طريقة دفع الأصل');
  assert.equal(doc.supplyDate, doc.issueDate, 'تاريخ توريد الإشعار = تاريخ إصداره');
  assert.equal(p.prepared.kind, 'CREDIT_NOTE');
  assert.equal(p.link.billingReference, 'INV-2609-000124');
  assert.equal(p.link.originalInvoiceId, ORIGINAL_Z1_STANDARD.id);
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0].creditQty, 2);
  assert.equal(p.lines[0].invoiceItemId, 'it-1');
});

test('إشعار كامل على فاتورة شاملة الضريبة ⇒ مبالغه المخزَّنة = مبالغ الفاتورة حرفاً بحرف (فرق التقريب نفسه)', () => {
  const original = SIMPLIFIED_ORIGINAL();
  const note = credit({ original, customer: CUSTOMERS.individual, request: 'FULL' });
  const invoice = prepareIssuance({
    settings: sellerSettings(), customer: CUSTOMERS.individual, products: PRODUCTS, request: REQ_SIMPLIFIED_Z1,
    companyVat: COMPANY_VAT, engine: engineOf(REQ_SIMPLIFIED_Z1), now: Z1_ISSUED_AT,
  });
  assert.deepEqual(note.prepared.amounts, invoice.amounts, 'الإشعار الكامل يعكس الفاتورة بالضبط');
  assert.equal(note.prepared.subtype, '02');
  assert.equal(note.prepared.typeCode, '381');
  assert.equal(note.prepared.stampKind, 'simplified');
  assert.ok(note.prepared.amounts.payableRounding >= 0);
  // البنود بترتيب المستند الأصلي وبكامل كمياتها
  assert.deepEqual(note.lines.map(l => [l.seq, l.creditQty]), [[1, 2], [2, 3]]);
});

test('إشعار جزئي على فاتورة حصرية بخصم فاتورة كلّي: الخصم يُورَث ويُوزَّع، وإشعارا النصفين يساويان الأصل ضمن سماح التقريب', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  const half = credit({ original, request: [{ invoiceItemId: 'it-1', qty: 5 }, { invoiceItemId: 'it-2', qty: 6.25 }, { invoiceItemId: 'it-3', qty: 2 }] });
  assert.equal(half.prepared.src.invoiceDiscountPct, 5, 'خصم الفاتورة الكلّي يُورَث');
  const doc = mapInvoiceToUbl(half.prepared.src, chainFor(5));
  assert.ok(doc.docAllowances.length > 0, 'الخصم الكلّي يظهر خصماً على مستوى المستند');
  assert.equal(half.prepared.amounts.total, half.engine.total);
  const rest = credit({
    original,
    priorNotes: [priorNote({ total: half.engine.total, items: half.lines.map(l => ({ creditedItemId: l.invoiceItemId, qty: l.creditQty })) })],
    request: 'FULL',
  });
  assert.deepEqual(rest.lines.map(l => [l.invoiceItemId, l.creditQty]), [['it-1', 5], ['it-2', 6.25], ['it-3', 2]]);
  const drift = Math.abs(half.engine.total + rest.engine.total - original.total);
  assert.ok(drift <= 0.02, `انحراف التقريب ${drift}`);
});

test('النوع الفرعي يُورَث من الأصل لا من تصنيف العميل اليوم، والقياسية على عميل صارت بطاقته ناقصة ⇒ 422 حجب D2', () => {
  // أصل مبسّط لعميل صار مصنّفاً منشأةً اليوم ⇒ الإشعار يبقى 02
  const simplified = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', einvoiceStatus: 'reported' });
  const note = credit({ original: simplified, request: 'FULL' });
  assert.equal(note.prepared.subtype, '02');
  assert.equal(note.prepared.typeName, '0200000');
  assert.equal(note.prepared.typeCode, '381');
  // أصل قياسيّ لعميل بيانات بطاقته ناقصة اليوم ⇒ يُكمل المدير البيانات قبل الإشعار
  const standard = originalInvoice({ request: REQ_STANDARD_Z1, subtype: '01', customerId: CUSTOMERS.b2bIncomplete.id });
  const e = httpError(() => credit({ original: standard, customer: CUSTOMERS.b2bIncomplete, request: 'FULL' }));
  assert.equal(e.code, 'ZATCA_BUYER_INCOMPLETE');
  assert.equal(e.status, 422);
  assert.equal(e.customerId, CUSTOMERS.b2bIncomplete.id);
});

test('BR-49: الإشعار يحمل طريقة دفع الأصل — نقدية ⇒ 10، آجلة ⇒ 30، وخطة أقساط ⇒ INSTALLMENT (30)', () => {
  const cash = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', customerId: 'c-walkin' });
  assert.equal(eligible(cash, CUSTOMERS.individual).paymentType, 'CASH');
  assert.equal(mapInvoiceToUbl(credit({ original: cash, customer: CUSTOMERS.individual }).prepared.src, chainFor(2)).paymentMeansCode, '10');
  const credited = originalInvoice({ request: REQ_STANDARD_Z1 });
  assert.equal(mapInvoiceToUbl(credit({ original: credited }).prepared.src, chainFor(2)).paymentMeansCode, '30');
  const inst = originalInvoice({ request: REQ_STANDARD_Z1, paymentPlan: 'INSTALLMENT' });
  const e = eligible(inst);
  assert.equal(e.paymentType, 'INSTALLMENT');
  assert.equal(mapInvoiceToUbl(credit({ original: inst, eligibility: e }).prepared.src, chainFor(2)).paymentMeansCode, '30');
});

// ─── حرّاس الكمية ───

test('المتاح للإرجاع = المُباع − مجموع إشعارات ملتزَمة سابقة؛ الملغى والمدين لا ينقصان شيئاً', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  const notes: PriorNote[] = [
    priorNote({ id: 'n1', total: 100, items: [{ creditedItemId: 'it-1', qty: 3 }] }),
    priorNote({ id: 'n2', total: 50, items: [{ creditedItemId: 'it-1', qty: 2 }, { creditedItemId: 'it-2', qty: 0.5 }] }),
    priorNote({ id: 'n3', status: 'CANCELLED', total: 999, items: [{ creditedItemId: 'it-1', qty: 5 }] }),
    priorNote({ id: 'n4', documentKind: 'DEBIT_NOTE', total: 20, items: [{ creditedItemId: null, qty: 7 }] }),
  ];
  const lines = creditableLines(original, notes);
  assert.deepEqual(lines.map(l => [l.invoiceItemId, l.qty, l.credited, l.returnable]), [
    ['it-1', 10, 5, 5], ['it-2', 12.5, 0.5, 12], ['it-3', 4, 0, 4],
  ]);
  assert.equal(hasCreditableQty(lines), true);
  assert.equal(creditedTotalOf(notes), 150, 'الملغى والمدين خارج مجموع القيمة');
  // ترتيب المستند مهما كان ترتيب الطلب
  assert.deepEqual(resolveCreditLines(lines, [{ invoiceItemId: 'it-3', qty: 1 }, { invoiceItemId: 'it-1', qty: 1 }]).map(l => l.invoiceItemId), ['it-1', 'it-3']);
});

test('تجاوز الكمية لكل بند ⇒ 422 بأسماء الأصناف والمتاح (كل المخالفات معاً)، والحدّ نفسه يمرّ', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  const notes = [priorNote({ total: 100, items: [{ creditedItemId: 'it-1', qty: 3 }] })];
  const e = httpError(() => credit({ original, priorNotes: notes, request: [{ invoiceItemId: 'it-1', qty: 8 }, { invoiceItemId: 'it-3', qty: 5 }] }));
  assert.equal(e.code, 'ZATCA_CREDIT_QTY_EXCEEDED');
  assert.equal(e.status, 422);
  assert.equal(e.issues?.length, 2);
  assert.ok(e.messageAr.includes('أرز بسمتي 5 كجم'), e.messageAr);
  assert.ok(e.messageAr.includes('7'), 'المتاح بعد الإشعار السابق');
  // الحدّ تماماً يمرّ
  const ok = credit({ original, priorNotes: notes, request: [{ invoiceItemId: 'it-1', qty: 7 }] });
  assert.equal(ok.lines[0].creditQty, 7);
});

test('بنود الطلب: بندٌ ليس من الأصل، أو مكرَّر، أو كمية غير موجبة، أو قائمة فارغة ⇒ 422 ZATCA_NOTE_LINES_INVALID', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  for (const request of [
    [{ invoiceItemId: 'it-9', qty: 1 }],
    [{ invoiceItemId: 'it-1', qty: 1 }, { invoiceItemId: 'it-1', qty: 1 }],
    [{ invoiceItemId: 'it-1', qty: 0 }],
    [{ invoiceItemId: 'it-1', qty: -2 }],
    [] as { invoiceItemId: string; qty: number }[],
  ]) {
    const e = httpError(() => credit({ original, request }));
    assert.equal(e.code, 'ZATCA_NOTE_LINES_INVALID', JSON.stringify(request));
    assert.equal(e.status, 422);
  }
});

test('كل الكميات مُرتجعة سابقاً ⇒ 409 ZATCA_NOTHING_TO_CREDIT (وFULL لا تُصدر إشعاراً فارغاً)', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  const notes = [priorNote({
    total: original.total,
    items: [{ creditedItemId: 'it-1', qty: 10 }, { creditedItemId: 'it-2', qty: 12.5 }, { creditedItemId: 'it-3', qty: 4 }],
  })];
  for (const request of ['FULL' as const, [{ invoiceItemId: 'it-1', qty: 1 }]]) {
    const e = httpError(() => credit({ original, priorNotes: notes, request }));
    assert.ok(['ZATCA_NOTHING_TO_CREDIT', 'ZATCA_CREDIT_QTY_EXCEEDED'].includes(e.code), e.code);
  }
  assert.equal(httpError(() => credit({ original, priorNotes: notes, request: 'FULL' })).status, 409);
});

test('حارس القيمة على مستوى الفاتورة: مجموع الإشعارات لا يتجاوز الأصل إلا بسماح التقريب المعلوم', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  assert.equal(taxBucketCount([{ taxPct: 15 }, { taxPct: 15 }, { taxPct: 0 }]), 2);
  assert.equal(creditAmountTolerance(2, 1), 0.02);
  assert.equal(creditAmountTolerance(1, 3), 0.03);
  // إشعار سابق بقيمة الفاتورة كلّها (بكمية رمزية) ⇒ أي إشعار بعده يتجاوز القيمة
  const inflated = [priorNote({ total: original.total, items: [{ creditedItemId: 'it-1', qty: 0.01 }] })];
  const e = httpError(() => credit({ original, priorNotes: inflated, request: [{ invoiceItemId: 'it-2', qty: 5 }] }));
  assert.equal(e.code, 'ZATCA_CREDIT_AMOUNT_EXCEEDED');
  assert.equal(e.status, 422);
  // داخل السماح: هللة واحدة فوق المتاح تمرّ (انحراف تقريب لا خلل)
  assert.doesNotThrow(() => assertCreditAmount({ original: { total: 100 }, priorNotes: [priorNote({ total: 90, items: [] })], noteTotal: 10.01, bucketCount: 1 }));
  assert.throws(() => assertCreditAmount({ original: { total: 100 }, priorNotes: [priorNote({ total: 90, items: [] })], noteTotal: 10.05, bucketCount: 1 }), /ZATCA_CREDIT_AMOUNT_EXCEEDED/);
});

// ─── الأهليّة ───

test('D4/Q1: فاتورة رفضتها الهيئة (أو سُحبت) أُبطلت ⇒ لا إشعار عليها، والرسالة تقول إنّ المحصَّل بقي رصيداً دائناً', () => {
  for (const mirror of ['rejected', 'withdrawn']) {
    const voided = originalInvoice({ request: REQ_STANDARD_Z1, type: 'CASH', status: 'CANCELLED', einvoiceStatus: mirror });
    const d = noteEligibility({ tenantId: Z5_TENANT, original: voided, customer: CUSTOMERS.b2bComplete });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.refusal, 'ORIGINAL_VOIDED');
    const e = noteRefusalError('ORIGINAL_VOIDED')!;
    assert.equal(e.code, 'ZATCA_ORIGINAL_NOT_CLEARED');
    assert.equal(e.status, 409);
    assert.ok(e.messageAr.includes('رصيداً دائناً'), 'Q1: الرصيد الدائن لا يُمنح مرّتين');
  }
});

test('حالات الأصل: قياسية معلّقة أو محجوبة ⇒ 409 بانتظار الاعتماد، ومعتمدة بلا نسخة ⇒ رسالتها، والمبسّطة بأي حالة عدا المُبطلة تمرّ', () => {
  const pending = ['clearance_pending', 'clearance_blocked'];
  for (const m of pending) {
    const d = noteEligibility({ tenantId: Z5_TENANT, original: originalInvoice({ request: REQ_STANDARD_Z1, einvoiceStatus: m }), customer: CUSTOMERS.b2bComplete });
    assert.equal(d.ok === false && d.refusal, 'ORIGINAL_PENDING', m);
  }
  const noXml = noteEligibility({ tenantId: Z5_TENANT, original: originalInvoice({ request: REQ_STANDARD_Z1, einvoiceStatus: 'cleared_no_xml' }), customer: CUSTOMERS.b2bComplete });
  assert.equal(noXml.ok === false && noXml.refusal, 'ORIGINAL_NO_XML');
  for (const m of ['cleared', 'cleared_warn', 'reported', 'reported_warn']) {
    assert.equal(noteEligibility({ tenantId: Z5_TENANT, original: originalInvoice({ request: REQ_STANDARD_Z1, einvoiceStatus: m }), customer: CUSTOMERS.b2bComplete }).ok, true, m);
  }
  for (const m of ['signed', 'report_blocked', 'reported']) {
    const o = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', customerId: 'c-walkin', einvoiceStatus: m });
    assert.equal(noteEligibility({ tenantId: Z5_TENANT, original: o, customer: CUSTOMERS.individual }).ok, true, m);
  }
  // مبسّطة مرفوضة: تُصحَّح بإعادة إصدار لا بإشعار
  const rejected = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', customerId: 'c-walkin', einvoiceStatus: 'rejected' });
  assert.equal(noteEligibility({ tenantId: Z5_TENANT, original: rejected, customer: CUSTOMERS.individual }).ok, false);
});

test('لا إشعار على إشعار ولا على مرتجع ولا على فاتورة ملغاة أو شركة أخرى أو عميل آخر', () => {
  const base = { request: REQ_STANDARD_Z1 } as const;
  const cases: Array<[NoteOriginalInvoice, string]> = [
    [originalInvoice({ ...base, documentKind: 'CREDIT_NOTE' }), 'NOT_AN_INVOICE'],
    [originalInvoice({ ...base, documentKind: 'DEBIT_NOTE' }), 'NOT_AN_INVOICE'],
    [originalInvoice({ ...base, type: 'RETURN' }), 'WRONG_TYPE'],
    [originalInvoice({ ...base, status: 'CANCELLED', einvoiceStatus: 'cleared' }), 'NOT_CONFIRMED'],
    [originalInvoice({ ...base, tenantId: 'tenant-other' }), 'TENANT_MISMATCH'],
    [originalInvoice({ ...base, customerId: 'c-other' }), 'CUSTOMER_MISMATCH'],
    [originalInvoice({ ...base, number: '  ' }), 'NO_REFERENCE'],
    [originalInvoice({ ...base, subtype: null }), 'NO_SUBTYPE'],
  ];
  for (const [original, refusal] of cases) {
    const d = noteEligibility({ tenantId: Z5_TENANT, original, customer: CUSTOMERS.b2bComplete });
    assert.equal(d.ok === false && d.refusal, refusal);
  }
  assert.equal(noteEligibility({ tenantId: Z5_TENANT, original: null, customer: CUSTOMERS.b2bComplete }).ok, false);
  // ما لا يُكشف: 404 بلا رمز
  for (const r of ['NOT_FOUND', 'TENANT_MISMATCH', 'CUSTOMER_MISMATCH'] as const) assert.equal(noteRefusalError(r), null);
  assert.equal(noteRefusalError('NOT_AN_INVOICE')!.code, 'ZATCA_NOTE_ON_NOTE');
  assert.equal(noteRefusalError('NOT_AN_INVOICE')!.status, 409);
  assert.equal(noteRefusalError('NOTHING_TO_CREDIT')!.code, 'ZATCA_NOTHING_TO_CREDIT');
});

test('أصل من المرحلة الأولى: مسموح برقمه مرجعاً وبنوع فرعيّ من التصنيف الحيّ، وحجب D2 يسري عليه', () => {
  const p1 = originalInvoice({ request: REQ_STANDARD_Z1, phase: 1, number: 'INV-2509-000900' });
  const e = eligible(p1);
  assert.equal(e.originalPhase, 1);
  assert.equal(e.subtypeSource, 'classified');
  assert.equal(e.subtype, '01');
  assert.equal(e.billingReference, 'INV-2509-000900');
  const note = credit({ original: p1, eligibility: e, request: [{ invoiceItemId: 'it-1', qty: 1 }] });
  assert.equal(note.prepared.typeName, '0100000');
  assert.equal(note.prepared.src.billingReferences?.[0], 'INV-2509-000900');
  // بند بلا لقطة: الاسم من بطاقة الصنف الذي يمرّره المسار، والوحدة PCE، والفئة تُستنتج S
  assert.equal(note.lines[0].unitCode, 'PCE');
  assert.equal(mapInvoiceToUbl(note.prepared.src, chainFor(2)).lines[0].vat.category, 'S');
  // عميل فرد ⇒ الإشعار مبسّط
  const p1b = originalInvoice({ request: REQ_SIMPLIFIED_Z1, phase: 1, customerId: 'c-walkin' });
  assert.equal(eligible(p1b, CUSTOMERS.individual).subtype, '02');
  // عميل غير مكتمل يصنَّف منشأةً ⇒ 422 حتى تُكمل بطاقته
  const p1c = originalInvoice({ request: REQ_STANDARD_Z1, phase: 1, customerId: CUSTOMERS.crOnlyIncomplete.id });
  const err = httpError(() => credit({ original: p1c, customer: CUSTOMERS.crOnlyIncomplete, request: 'FULL' }));
  assert.equal(err.code, 'ZATCA_BUYER_INCOMPLETE');
});

test('سبب الإشعار (KSA-10) إلزاميّ 3..1000 حرفاً', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  for (const reason of ['', '  ', 'اب', 'x'.repeat(1001)]) {
    assert.equal(httpError(() => credit({ original, reason })).code, 'ZATCA_NOTE_LINES_INVALID', JSON.stringify(reason.slice(0, 8)));
  }
  assert.equal(credit({ original, reason: '  إرجاع  ' }).link.noteReason, 'إرجاع');
});

test('هوية المشتري لا تنحرف عن الأصل: تغيّر الرقم الضريبي بعد البيع ⇒ 422، وإضافته أو غيابه لا يمنع', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  const before = mapBuyerParty({ ...BUSINESS_BUYER, taxNumber: '399999999900003' }, '01');
  const e = httpError(() => credit({ original, originalBuyer: before, request: 'FULL' }));
  assert.equal(e.code, 'ZATCA_PREFLIGHT');
  assert.ok(e.messageAr.includes('الرقم الضريبي'), e.messageAr);
  assert.doesNotThrow(() => credit({ original, originalBuyer: mapBuyerParty(BUSINESS_BUYER, '01'), request: 'FULL' }));
  assert.doesNotThrow(() => credit({ original, originalBuyer: null, request: 'FULL' }));
  assert.deepEqual(buyerIdentityDrift(mapBuyerParty({ name: 'x' }, '01'), mapBuyerParty(BUSINESS_BUYER, '01')), []);
  assert.deepEqual(buyerIdentityDrift(null, mapBuyerParty(BUSINESS_BUYER, '01')), []);
});

// ─── الإشعار المدين ───

test('الإشعار المدين (383): بنود حرّة بلا صنف ولا خصم فاتورة، بمرجع الأصل وسببه وطريقة دفعه', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  const note = prepareDebitNote({
    settings: sellerSettings(), customer: CUSTOMERS.b2bComplete, original, eligibility: eligible(original),
    reason: 'فرق سعر على الفاتورة', companyVat: COMPANY_VAT, now: Z1_ISSUED_AT,
    lines: [{ description: 'فرق سعر أرز', qty: 1, unitPrice: 25, taxPct: 15 }],
  });
  const doc = mapInvoiceToUbl(note.prepared.src, chainFor(4));
  assert.equal(doc.typeCode, '383');
  assert.equal(doc.typeName, '0100000');
  assert.equal(doc.lines[0].name, 'فرق سعر أرز');
  assert.equal(doc.paymentMeansCode, '30');
  assert.deepEqual(doc.billingReferences, [original.number]);
  assert.equal(note.prepared.src.invoiceDiscountPct, 0, 'المدين لا يرث خصم الفاتورة');
  assert.equal(note.prepared.kind, 'DEBIT_NOTE');
  assert.equal(note.engine.total, 28.75);
  for (const lines of [
    [] as { description: string; qty: number; unitPrice: number; taxPct: number }[],
    [{ description: '', qty: 1, unitPrice: 10, taxPct: 15 }],
    [{ description: 'x', qty: 0, unitPrice: 10, taxPct: 15 }],
    [{ description: 'x', qty: 1, unitPrice: 0, taxPct: 15 }],
  ]) {
    const e = httpError(() => prepareDebitNote({
      settings: sellerSettings(), customer: CUSTOMERS.b2bComplete, original, eligibility: eligible(original),
      reason: 'فرق سعر على الفاتورة', companyVat: COMPANY_VAT, now: Z1_ISSUED_AT, lines,
    }));
    assert.equal(e.code, 'ZATCA_NOTE_LINES_INVALID');
  }
});

// ─── الختم على السلسلة نفسها ───

test('سلسلة واحدة: فاتورة ثمّ إشعاران متوازيان ⇒ ICV 1..3 متّصلة وPIH متسلسلة وأرقام RET بلا فجوة', async () => {
  const hs = createHarness({ stepMs: 200 });
  const mutex = new KeyedAsyncMutex({ waitTimeoutMs: 60_000, maxWaiters: 10 });
  const signing = await hs.signing();
  await hs.issue({ prepared: hs.prepare({ customer: CUSTOMERS.individual, request: REQ_SIMPLIFIED_Z1 }), signing, mutex });

  const original = SIMPLIFIED_ORIGINAL();
  const notes = [
    credit({ original, customer: CUSTOMERS.individual, request: [{ invoiceItemId: 'it-1', qty: 1 }] }),
    credit({ original, customer: CUSTOMERS.individual, request: [{ invoiceItemId: 'it-2', qty: 1 }] }),
  ];
  const issueNote = (prepared: typeof notes[number]['prepared']) => runIssuance({
    unitId: signing.unitId,
    mutex,
    transaction: () => hs.sim.transaction(tx => stampNoteInTx(tx, hs.deps(), {
      tenantId: Z5_TENANT,
      prepared,
      signing,
      sellerVat: Z5_VAT,
      hooks: {
        ...hs.hooks(),
        allocateNumber: (t, at) => hs.sim.nextNumber(t, Z5_TENANT, noteNumberPrefix('CREDIT_NOTE', at)),
      },
    })),
  });
  const results = await Promise.all(notes.map(n => issueNote(n.prepared)));

  const docs = [...hs.sim.documents.values()].sort((a, b) => a.icv - b.icv);
  assert.deepEqual(docs.map(d => d.icv), [1, 2, 3]);
  assert.deepEqual(docs.map(d => d.typeCode), ['388', '381', '381']);
  let prev = INITIAL_PIH;
  for (const d of docs) {
    assert.equal(d.pih, prev, `PIH للحلقة ${d.icv}`);
    prev = d.invoiceHash;
  }
  assert.equal(hs.sim.units.get(signing.unitId)!.lastIcv, 3);
  assert.equal(hs.sim.units.get(signing.unitId)!.lastInvoiceHash, prev);
  const numbers = results.map(r => r.number).sort();
  assert.ok(numbers.every(n => n.startsWith('RET-')), numbers.join(','));
  assert.equal(new Set(numbers).size, 2, 'رقمان مختلفان لإشعارين');
  assert.equal(new Set(results.map(r => r.uuid)).size, 2);
  for (const r of results) {
    assert.equal(r.typeCode, '381');
    assert.equal(r.flow, 'REPORTING');
    assert.ok(r.reportDeadline instanceof Date, 'مهلة إبلاغ 24 ساعة للمبسّط');
    assert.equal(r.mirror.einvoiceStatus, 'signed');
  }
});

test('إشعار قياسيّ (01) مختوم: بايتاته تُتحقَّق بالشهادة، وتدفّقه اعتماد بلا مهلة إبلاغ ومرآته «بانتظار الاعتماد» بلا رمز', async () => {
  const hs = createHarness();
  const signing = await hs.signing();
  const note = credit({ original: ORIGINAL_Z1_STANDARD, request: [{ invoiceItemId: 'it-1', qty: 2 }] });
  const r = await hs.sim.transaction(tx => stampNoteInTx(tx, hs.deps(), {
    tenantId: Z5_TENANT,
    prepared: note.prepared,
    signing,
    sellerVat: Z5_VAT,
    hooks: { ...hs.hooks(), allocateNumber: (t, at) => hs.sim.nextNumber(t, Z5_TENANT, noteNumberPrefix('CREDIT_NOTE', at)) },
  }));
  assert.equal(r.typeCode, '381');
  assert.equal(r.typeName, '0100000');
  assert.equal(r.flow, 'CLEARANCE');
  assert.equal(r.reportDeadline, null, 'القياسية بلا مهلة إبلاغ حتى يوقف الاعتماد');
  assert.equal(r.mirror.einvoiceStatus, 'clearance_pending');
  assert.equal(r.mirror.einvoiceQr, null, 'لا يُكشف رمز إشعار قياسيّ لم تعتمده الهيئة');
  assert.ok(r.number.startsWith('RET-'));
  assert.equal(r.icv, 1);
  assert.equal(r.pih, INITIAL_PIH);
  const stored = [...hs.sim.documents.values()][0];
  const xml = gunzipXml(stored.xmlGz);
  const v = verifyStampedXml(xml, parseCsidToken(hs.keys.token), 'standard', { invoiceHash: r.invoiceHash, qr: r.qr });
  assert.equal(v.invoiceHash, r.invoiceHash);
  assert.ok(xml.includes('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>'));
  assert.ok(xml.includes('<cbc:ID>INV-2609-000124</cbc:ID>'), 'مرجع الفاتورة الأصلية داخل البايتات');
});

test('stampNoteInTx يرفض ما ليس إشعاراً وما بلا مرجع أو سبب قبل استهلاك ICV', async () => {
  const hs = createHarness();
  const signing = await hs.signing();
  const invoice = hs.prepare({ customer: CUSTOMERS.individual, request: REQ_SIMPLIFIED_Z1 });
  const note = credit({ original: SIMPLIFIED_ORIGINAL(), customer: CUSTOMERS.individual, request: 'FULL' }).prepared;
  const run = (prepared: typeof invoice) => hs.sim.transaction(tx => stampNoteInTx(tx, hs.deps(), {
    tenantId: Z5_TENANT, prepared, signing, sellerVat: Z5_VAT, hooks: hs.hooks(),
  }));
  await assert.rejects(() => run(invoice), (e: unknown) => e instanceof ZatcaHttpError && e.code === 'ZATCA_INTERNAL');
  await assert.rejects(
    () => run({ ...note, src: { ...note.src, billingReferences: [] } }),
    (e: unknown) => e instanceof ZatcaHttpError && e.code === 'ZATCA_ORIGINAL_NOT_CLEARED',
  );
  await assert.rejects(
    () => run({ ...note, src: { ...note.src, noteReason: '  ' } }),
    (e: unknown) => e instanceof ZatcaHttpError && e.code === 'ZATCA_NOTE_LINES_INVALID',
  );
  assert.equal(hs.sim.units.get(signing.unitId)!.lastIcv, 0, 'لا ICV مستهلك');
  assert.equal(hs.sim.documents.size, 0);
  assert.equal(isNoteKind('CREDIT_NOTE'), true);
  assert.equal(isNoteKind('INVOICE'), false);
});

// ─── أعمدة الصفّ وأثر المتبقّي ───

test('أعمدة صفّ الإشعار: رابط الأصل والمرجع والسبب فوق أعمدة المرحلة الثانية، وربط البند بأصله', () => {
  const p = credit({ original: ORIGINAL_Z1_STANDARD, request: [{ invoiceItemId: 'it-1', qty: 2 }] });
  const doc = mapInvoiceToUbl({ ...p.prepared.src, number: 'RET-2612-000001' }, chainFor(3));
  const record: IssuedInvoiceRecord = {
    tenantId: Z5_TENANT, number: 'RET-2612-000001', issuedAt: Z1_ISSUED_AT, kind: 'CREDIT_NOTE', subtype: '01',
    typeName: doc.typeName, snapshot: snapshotOf(doc), amounts: p.prepared.amounts, items: p.prepared.items,
    mirror: signedInvoiceMirror({ subtype: '01', uuid: doc.uuid, invoiceHash: 'h'.repeat(43) + '=', pih: INITIAL_PIH, icv: 3, qr: 'QR' }),
  };
  const cols = noteInvoiceColumns(record, p.link);
  assert.equal(cols.zatcaPhase, 2);
  assert.equal(cols.documentKind, 'CREDIT_NOTE');
  assert.equal(cols.invoiceSubtype, '01');
  assert.equal(cols.originalInvoiceId, ORIGINAL_Z1_STANDARD.id);
  assert.equal(cols.billingReference, 'INV-2609-000124');
  assert.equal(cols.noteReason, 'إرجاع بضاعة تالفة');
  assert.equal(cols.total, p.prepared.amounts.total);
  assert.equal(cols.invoiceDate, Z1_ISSUED_AT);
  assert.equal(cols.einvoiceQr, null, 'قياسيّ لم يُعتمد ⇒ لا رمز');
  const item = noteItemColumns(p.prepared.items[0], p.lines[0].invoiceItemId);
  assert.equal(item.creditedItemId, 'it-1');
  assert.equal(item.seq, 1);
  assert.equal(item.itemName, 'أرز بسمتي 5 كجم');
  assert.deepEqual(creditNoteLegacyColumns({ reasonCode: 'DAMAGED', returnToStock: false }), {
    type: 'RETURN', returnReason: 'DAMAGED', returnToStock: false, paidAmt: 0, remainingAmt: 0,
  });
  assert.deepEqual(creditNoteLegacyColumns({ reasonCode: null, returnToStock: true }), {
    type: 'RETURN', returnReason: 'NORMAL', returnToStock: true, paidAmt: 0, remainingAmt: 0,
  });
  assert.deepEqual(debitNoteLegacyColumns(28.75), { type: 'CREDIT', paidAmt: 0, remainingAmt: 28.75 });
  assert.equal(noteNumberPrefix('CREDIT_NOTE', new Date('2026-12-01T09:00:00Z')), 'RET-2612-');
  assert.equal(noteNumberPrefix('DEBIT_NOTE', new Date('2026-12-01T09:00:00Z')), 'INV-2612-');
});

test('عودة المرتجع للمخزون: الصريح يغلب، والتالف يعود فقط إن سمحت كل أصنافه', () => {
  const allow = [{ damagedReturnToStock: true }, { damagedReturnToStock: true }];
  const mixed = [{ damagedReturnToStock: true }, { damagedReturnToStock: false }];
  assert.equal(resolveReturnToStock(false, 'NORMAL', allow), false);
  assert.equal(resolveReturnToStock(true, 'DAMAGED', mixed), true);
  assert.equal(resolveReturnToStock(null, 'NORMAL', mixed), true);
  assert.equal(resolveReturnToStock(undefined, 'DAMAGED', allow), true);
  assert.equal(resolveReturnToStock(undefined, 'DAMAGED', mixed), false);
  assert.equal(resolveReturnToStock(undefined, 'DAMAGED', []), false);
});

test('F1: الإشعار يُطفئ متبقّي الأصل بقدره ولا ينزل تحت الصفر، وما فاض رصيد دائن — والنقدية كلّها رصيد مرّةً واحدة', () => {
  assert.deepEqual(remainingAfterCreditNote({ remainingAmt: 100 }, 30), { decrement: 30, customerCredit: 0, remainingAfter: 70 });
  assert.deepEqual(remainingAfterCreditNote({ remainingAmt: 100 }, 150), { decrement: 100, customerCredit: 50, remainingAfter: 0 });
  assert.deepEqual(remainingAfterCreditNote({ remainingAmt: 0 }, 94.19), { decrement: 0, customerCredit: 94.19, remainingAfter: 0 });
  assert.deepEqual(remainingAfterCreditNote({ remainingAmt: -5 }, 10), { decrement: 0, customerCredit: 10, remainingAfter: 0 });
  // الفاتورة النقدية: متبقّيها صفر ⇒ الإشعار كلّه رصيد دائن (وQ1 محروس بمنع الإشعار على مُبطلة)
  const cash = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', customerId: 'c-walkin', type: 'CASH' });
  const note = credit({ original: cash, customer: CUSTOMERS.individual, request: 'FULL' });
  const adj = remainingAfterCreditNote(cash, note.engine.total);
  assert.equal(adj.decrement, 0);
  assert.equal(adj.customerCredit, engineFor(REQ_SIMPLIFIED_Z1).total);
});


// ─── مراجعة Z5.5: مرتجعات ما قبل الربط، ونطاق Q5 بالأثر، والمبسّطة المرفوضة ───

test('مرتجعٌ قديم بلا رابط يُخصم من المتاح لأصلٍ من المرحلة الأولى — ولا يُرجَع المباع مرّتين', () => {
  const p1 = originalInvoice({ request: REQ_STANDARD_Z1, phase: 1, number: 'INV-2509-000900' });
  const pid = p1.items[0].productId;
  const sold = p1.items[0].qty;
  const bare = creditableLines(p1, []);
  assert.equal(bare[0].returnable, sold, 'بلا مرتجعات قديمة يتغيّر المتاح');
  assert.equal(bare[0].legacyCredited, 0);

  // أُرجع نصف الكمية قبل التفعيل بمستند مرتجعٍ قديم (بلا originalInvoiceId ولا creditedItemId)
  const half = sold / 2;
  const legacyReturns = [{ productId: pid, qty: half }];
  const lines = creditableLines(p1, [], legacyReturns);
  assert.equal(lines[0].credited, 0, 'المرتجع القديم ليس إشعاراً');
  assert.equal(lines[0].legacyCredited, half);
  assert.equal(lines[0].returnable, sold - half);
  // الكامل يقتصر على ما بقي فعلاً (كان يُعيد الكمية كلّها فيُقيَّد الائتمان مرّتين وتعود البضاعة مرّتين للسيارة)
  assert.equal(resolveCreditLines(lines, 'FULL').find(l => l.invoiceItemId === 'it-1')!.creditQty, sold - half);

  // وحارس الكمية يرفض ما فوقه — بالرسالة التي تسمّي الصنف والمتاح
  const over = httpError(() => credit({
    original: p1, eligibility: eligible(p1), legacyReturns, request: [{ invoiceItemId: 'it-1', qty: sold }],
  }));
  assert.equal(over.code, 'ZATCA_CREDIT_QTY_EXCEEDED');
  // وما دونه يمرّ ويحمل الكمّية المطلوبة
  const note = credit({ original: p1, eligibility: eligible(p1), legacyReturns, request: [{ invoiceItemId: 'it-1', qty: sold - half }] });
  assert.equal(note.lines[0].creditQty, sold - half);
});

test('بركة المرتجع القديم تُستهلك مرّةً واحدة ولا تتجاوز المُباع', () => {
  const p1 = originalInvoice({ request: REQ_STANDARD_Z1, phase: 1 });
  const pid = p1.items[0].productId;
  const sold = p1.items[0].qty;
  // مرتجعٌ قديم أكبر من كمية البند: الخصم يقف عند المُباع ولا يصير سالباً ولا يتعدّى إلى بندٍ آخر
  const capped = creditableLines(p1, [], [{ productId: pid, qty: 999 }]);
  assert.equal(capped[0].legacyCredited, sold);
  assert.equal(capped[0].returnable, 0);
  assert.equal(capped[1].legacyCredited, 0, 'الخصم تسرّب إلى صنفٍ آخر');
  assert.equal(capped[1].returnable, p1.items[1].qty);
  // ومع إشعارٍ سابق: لا يُخصم البند مرّتين عن الكمية نفسها
  const prior: PriorNote[] = [priorNote({ total: 10, items: [{ creditedItemId: 'it-1', qty: 2 }] })];
  const both = creditableLines(p1, prior, [{ productId: pid, qty: 999 }]);
  assert.equal(both[0].credited, 2);
  assert.equal(both[0].legacyCredited, sold - 2, 'الخصمان تراكبا على الكمية نفسها');
  assert.equal(both[0].returnable, 0);
  // بند بلا صنف لا يستهلك من البركة
  assert.equal(creditableLines(p1, [], [{ productId: null, qty: 5 }])[0].legacyCredited, 0);
  // والمربوط لا يمرّر مرتجعات قديمة أصلاً (المسار لا يقرؤها له) — المتاح كما هو
  const p2 = originalInvoice({ request: REQ_STANDARD_Z1 });
  assert.equal(creditableLines(p2, [])[0].returnable, sold);
});

test('Q5 بالأثر: قائمةٌ تعدّ كل البنود بكامل المتاح = كاملٌ، وإتمامُ فاتورةٍ أُرجع بعضها = جزئيّ', () => {
  const original = originalInvoice({ request: REQ_STANDARD_Z1 });
  const lines = creditableLines(original, []);
  const full = credit({ original, request: 'FULL' });
  assert.equal(effectiveCreditScope(lines, full.lines), 'FULL');

  // التعداد اليدويّ لكل بند بكامل المتاح ⇒ النطاق نفسه (لا التفافَ على صلاحية الإلغاء)
  const enumerated = credit({ original, request: lines.map(l => ({ invoiceItemId: l.invoiceItemId, qty: l.returnable })) });
  assert.equal(effectiveCreditScope(lines, enumerated.lines), 'FULL');

  // بقي شيء ⇒ جزئيّ
  const partial = credit({ original, request: [{ invoiceItemId: 'it-1', qty: 1 }] });
  assert.equal(effectiveCreditScope(lines, partial.lines), 'PARTIAL');

  // أُرجع بعضها سابقاً ⇒ إتمام الباقي ليس إلغاءً لبيعٍ قائم
  const prior: PriorNote[] = [priorNote({ total: 10, items: [{ creditedItemId: 'it-1', qty: 1 }] })];
  const after = creditableLines(original, prior);
  const rest = credit({ original, priorNotes: prior, request: 'FULL' });
  assert.equal(effectiveCreditScope(after, rest.lines), 'PARTIAL');
});

test('المبسّطة التي رفضتها الهيئة لم تُبطل: رفضٌ خاصّ يقول الحقيقة بلا وعدٍ برصيد دائن', () => {
  const simplified = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', customerId: 'c-walkin', einvoiceStatus: 'rejected' });
  const e = noteEligibility({ tenantId: Z5_TENANT, original: simplified, customer: CUSTOMERS.individual });
  assert.equal(e.ok, false);
  assert.equal(e.ok ? '' : e.refusal, 'SIMPLIFIED_REJECTED');
  const err = noteRefusalError('SIMPLIFIED_REJECTED')!;
  assert.equal(err.status, 409);
  assert.match(err.messageAr, /أعد إصدارها/);
  assert.doesNotMatch(err.messageAr, /رصيداً دائناً/, 'وعدٌ برصيدٍ دائن لا وجود له في المبسّطة');
  // والقياسية المرفوضة تبقى «أُبطلت» كما هي (D4/Q1)
  const standard = originalInvoice({ request: REQ_STANDARD_Z1, subtype: '01', einvoiceStatus: 'rejected', status: 'CANCELLED' });
  const es = noteEligibility({ tenantId: Z5_TENANT, original: standard, customer: CUSTOMERS.b2bComplete });
  assert.equal(es.ok ? '' : es.refusal, 'ORIGINAL_VOIDED');
});
