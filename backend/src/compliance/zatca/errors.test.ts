// اختبارات Z5.0 لكتالوج الأخطاء (errors.ts): كل مجموعة رموز ختم، وكل رمز ZatcaInputError من مصادره الحقيقية (mapInvoiceToUbl
// والفحص المسبق)، وP2002 على مفاتيح السلسلة وحدها (نقد الخطة 26)، وP2028 وSecretsError وFatooraInputError، والرسائل العربية
// والجسم بلا تفاصيل داخلية.
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FatooraInputError } from './api';
import { mapInvoiceToUbl, preflightKindOf, type InvoiceSource } from './mapInvoice';
import { ZatcaInputError } from './model';
import { preflightIssues } from './preflight';
import { SecretsError } from './secrets';
import { StampError, type StampErrorCode } from './stamp';
import {
  STAMP_ERROR_GROUPS, UNIT_UNAVAILABLE_MESSAGES, ZATCA_ERROR_CATALOGUE, ZatcaHttpError, buyerIncompleteError, isChainUniqueViolation,
  issuesSummaryAr, preflightHttpError, rejectedError, toZatcaHttpError, unitUnavailableError,
} from './errors';
import { REGIME_BLOCKED_REASONS } from './regime';
import { BUSINESS_BUYER, SIMPLIFIED_INVOICE, STANDARD_INVOICE, chainFor } from './__fixtures__/z1-sources';

const ARABIC = /[؀-ۿ]/;

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  assert.fail('لم يُرمَ خطأ');
}

test('الكتالوج: كل رمز برسالة عربية وحالة HTTP متوقَّعة', () => {
  const statuses: Record<string, number> = {
    ZATCA_PREFLIGHT: 422, ZATCA_BUYER_INCOMPLETE: 422, ZATCA_INCLUSIVE_HEAD_DISCOUNT: 422, ZATCA_ZERO_VALUE_LINE: 422, ZATCA_AMOUNTS: 422,
    ZATCA_CURRENCY: 422, ZATCA_SETTINGS_LOCKED: 409, ZATCA_UNIT_UNAVAILABLE: 503, ZATCA_UNIT_BUSY: 503, ZATCA_STAMP_FAILED: 503,
    ZATCA_CHAIN_CONFLICT: 503, ZATCA_CLEARANCE_PENDING: 202, ZATCA_REJECTED: 422, ZATCA_USE_CREDIT_NOTE: 409, ZATCA_RETURN_NEEDS_ORIGINAL: 422,
    ZATCA_ORIGINAL_NOT_CLEARED: 409, ZATCA_CREDIT_QTY_EXCEEDED: 422, ZATCA_NOTHING_TO_CREDIT: 409, ZATCA_CLIENT_UPDATE_REQUIRED: 426,
    ZATCA_CUTOVER_REVIEW: 409, CUSTOMER_ZATCA_INVALID: 400, TENANT_HAS_EINVOICE_ARCHIVE: 409,
  };
  for (const [code, status] of Object.entries(statuses)) {
    const e = (ZATCA_ERROR_CATALOGUE as Record<string, { status: number; messageAr: string }>)[code];
    assert.ok(e, code);
    assert.equal(e.status, status, code);
    assert.match(e.messageAr, ARABIC, code);
  }
  assert.equal(ZATCA_ERROR_CATALOGUE.ZATCA_STAMP_FAILED.alert, true);
  assert.equal(ZATCA_ERROR_CATALOGUE.ZATCA_CHAIN_CONFLICT.alert, true);
  assert.equal(ZATCA_ERROR_CATALOGUE.ZATCA_PREFLIGHT.alert, false);
  for (const r of REGIME_BLOCKED_REASONS) assert.match(UNIT_UNAVAILABLE_MESSAGES[r], ARABIC, r);
  assert.equal(UNIT_UNAVAILABLE_MESSAGES.RENEWING, 'يجري تجديد شهادة الفوترة — أعد المحاولة بعد دقائق');
  assert.equal(UNIT_UNAVAILABLE_MESSAGES.AUTH_FAILED, 'توقّف إصدار الفواتير الضريبية — راجع مدير الشركة');
  assert.equal(UNIT_UNAVAILABLE_MESSAGES.EXPIRED, 'انتهت صلاحية شهادة الفوترة — يلزم التجديد');
});

test('ZatcaInputError من مصادره: INCLUSIVE_HEAD_DISCOUNT وAMOUNT_INPUT وMAPPING_INPUT وENGINE_ROUNDING_CONFLICT', () => {
  const map = (src: InvoiceSource) => thrown(() => mapInvoiceToUbl(src, chainFor(1)));
  const head = map({ ...SIMPLIFIED_INVOICE, invoiceDiscountPct: 5 });
  assert.ok(head instanceof ZatcaInputError && head.code === 'INCLUSIVE_HEAD_DISCOUNT');
  const h = toZatcaHttpError(head)!;
  assert.equal(h.code, 'ZATCA_INCLUSIVE_HEAD_DISCOUNT');
  assert.equal(h.status, 422);
  assert.equal(h.messageAr, ZATCA_ERROR_CATALOGUE.ZATCA_INCLUSIVE_HEAD_DISCOUNT.messageAr);

  const amount = map({ ...SIMPLIFIED_INVOICE, items: [{ ...SIMPLIFIED_INVOICE.items[0], qty: -1 }] });
  assert.ok(amount instanceof ZatcaInputError && amount.code === 'AMOUNT_INPUT', String(amount));
  const a = toZatcaHttpError(amount)!;
  assert.equal(a.code, 'ZATCA_AMOUNTS');
  assert.equal(a.subcode, 'AMOUNT_INPUT');
  assert.ok((a.issues ?? []).length > 0);

  const mapping = map({ ...STANDARD_INVOICE, items: [{ ...STANDARD_INVOICE.items[0], taxPct: 0 }] });
  assert.ok(mapping instanceof ZatcaInputError && mapping.code === 'MAPPING_INPUT', String(mapping));
  const m = toZatcaHttpError(mapping)!;
  assert.equal(m.code, 'ZATCA_PREFLIGHT');
  assert.match(m.messageAr, /^بيانات ناقصة أو غير صحيحة لإصدار فاتورة ضريبية: /);
  assert.equal(m.logDetail?.code, 'MAPPING_INPUT');

  const conflict = new ZatcaInputError('ENGINE_ROUNDING_CONFLICT', [{ rule: 'BR-CO-17', field: 'taxTotal', messageAr: 'تعارض', severity: 'error' }]);
  const c = toZatcaHttpError(conflict)!;
  assert.equal(c.code, 'ZATCA_AMOUNTS');
  assert.equal(c.subcode, 'ENGINE_ROUNDING_CONFLICT');
});

test('الفحص المسبق: العملة ⇒ ZATCA_CURRENCY؛ أصناف صفرية وحدها ⇒ ZATCA_ZERO_VALUE_LINE؛ غير ذلك ZATCA_PREFLIGHT بالقائمة', () => {
  const doc = (src: InvoiceSource) => {
    const d = mapInvoiceToUbl(src, chainFor(1));
    return preflightIssues(d, preflightKindOf(d));
  };
  assert.equal(preflightHttpError(doc(SIMPLIFIED_INVOICE)), null, 'مصدر سليم بلا مخالفات مانعة');
  const usd = preflightHttpError(doc({ ...SIMPLIFIED_INVOICE, currency: 'USD' }))!;
  assert.equal(usd.code, 'ZATCA_CURRENCY');
  assert.equal(usd.status, 422);
  const zero = preflightHttpError(doc({ ...SIMPLIFIED_INVOICE, items: [{ ...SIMPLIFIED_INVOICE.items[0], unitPrice: 0 }] }))!;
  assert.equal(zero.code, 'ZATCA_ZERO_VALUE_LINE', JSON.stringify(zero.issues));
  const buyer = preflightHttpError(doc({ ...STANDARD_INVOICE, buyer: { ...BUSINESS_BUYER, addrBuildingNo: null, district: null } }))!;
  assert.equal(buyer.code, 'ZATCA_PREFLIGHT');
  assert.ok(buyer.messageAr.includes('؛') || buyer.messageAr.split(': ')[1]?.length > 0, buyer.messageAr);
  // تحذيرات وحدها لا تمنع
  assert.equal(preflightHttpError([{ rule: 'W', field: 'x', messageAr: 'تحذير', severity: 'warning' }]), null);
});

test('issuesSummaryAr: بلا تكرار، ستّ أولاً ثم «و n أخرى»، والتحذيرات خارجها', () => {
  const issues = Array.from({ length: 9 }, (_, i) => ({ rule: `R${i}`, field: 'f', messageAr: `رسالة ${i}`, severity: 'error' as const }));
  issues.push({ rule: 'dup', field: 'f', messageAr: 'رسالة 0', severity: 'error' }, { rule: 'w', field: 'f', messageAr: 'تحذير', severity: 'warning' as never });
  const s = issuesSummaryAr(issues);
  assert.equal(s, 'رسالة 0؛ رسالة 1؛ رسالة 2؛ رسالة 3؛ رسالة 4؛ رسالة 5؛ و3 أخرى');
  assert.equal(issuesSummaryAr([]), '');
});

test('StampError: كل رمز بمجموعته — بيانات بحقل ⇒ 422، بيانات بلا حقل وداخلي ⇒ 503 STAMP_FAILED بتنبيه، إعداد الوحدة ⇒ 503 UNIT_UNAVAILABLE', () => {
  const codes = Object.keys(STAMP_ERROR_GROUPS) as StampErrorCode[];
  assert.equal(codes.length, 17);
  for (const code of codes) {
    const group = STAMP_ERROR_GROUPS[code];
    for (const field of [undefined, 'supplier.registrationName']) {
      const h = toZatcaHttpError(new StampError(code, 'تفصيل داخلي بقيمة سرّية 399999999900003', field ? { field } : {}))!;
      assert.ok(h instanceof ZatcaHttpError, code);
      assert.equal(h.logDetail?.source, 'StampError');
      assert.equal(h.logDetail?.code, code);
      assert.doesNotMatch(JSON.stringify(h.body()), /399999999900003|تفصيل داخلي/, `${code}: الرسالة الداخلية تسرّبت`);
      if (group === 'data' && field) {
        assert.equal(h.code, 'ZATCA_PREFLIGHT', code);
        assert.equal(h.status, 422);
        assert.equal(h.alert, false);
        assert.equal(h.issues?.[0].field, field);
      } else if (group === 'unit') {
        assert.equal(h.code, 'ZATCA_UNIT_UNAVAILABLE', code);
        assert.equal(h.status, 503);
        assert.equal(h.reason, code === 'CERT_NOT_VALID' ? 'EXPIRED' : 'UNIT_CONFIG');
      } else {
        assert.equal(h.code, 'ZATCA_STAMP_FAILED', `${code}/${field}`);
        assert.equal(h.status, 503);
        assert.equal(h.alert, true);
      }
    }
  }
  const qr = toZatcaHttpError(new StampError('QR_TOO_LONG', 'x', { field: 'supplier.registrationName' }))!;
  assert.match(qr.messageAr, /اختصر اسم المنشأة/);
});

test('P2002: مفاتيح zatca_documents وحدها تعارض سلسلة؛ clientRef والرقم وغيرهما ليست لنا (null)', () => {
  const p = (meta: unknown) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta });
  const chain = [
    { modelName: 'ZatcaDocument', target: ['egsUnitId', 'icv'] }, { modelName: 'ZatcaDocument', target: ['uuid'] },
    { modelName: 'ZatcaDocument', target: ['invoiceId', 'attemptNo'] }, { target: ['egsUnitId', 'icv'] }, { target: ['uuid'] },
    { target: ['invoiceId', 'attemptNo'] }, { target: 'zatca_documents_uuid_key' }, { target: 'zatca_documents_egsUnitId_icv_key' },
  ];
  for (const meta of chain) {
    assert.equal(isChainUniqueViolation(p(meta)), true, JSON.stringify(meta));
    const h = toZatcaHttpError(p(meta))!;
    assert.equal(h.code, 'ZATCA_CHAIN_CONFLICT');
    assert.equal(h.status, 503);
    assert.equal(h.alert, true);
  }
  const notOurs = [
    { modelName: 'Invoice', target: ['tenantId', 'clientRef'] }, { modelName: 'Invoice', target: ['tenantId', 'number'] },
    { target: ['tenantId', 'clientRef'] }, { target: ['tenantId', 'number'] }, { target: 'invoices_tenantId_clientRef_key' },
    { modelName: 'InvoiceItem', target: ['invoiceId', 'seq'] }, { target: ['invoiceId', 'seq'] }, undefined, {},
  ];
  for (const meta of notOurs) {
    assert.equal(isChainUniqueViolation(p(meta)), false, JSON.stringify(meta));
    assert.equal(toZatcaHttpError(p(meta)), null, JSON.stringify(meta));
  }
});

test('P2028 ⇒ ZATCA_UNIT_BUSY؛ SecretsError ⇒ UNIT_UNAVAILABLE(SECRETS) بتنبيه؛ FatooraInputError ⇒ ZATCA_INTERNAL؛ غيرها null', () => {
  const busy = toZatcaHttpError(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))!;
  assert.equal(busy.code, 'ZATCA_UNIT_BUSY');
  assert.equal(busy.status, 503);
  const sec = toZatcaHttpError(new SecretsError('KEY_MISSING', 'ZATCA_SECRETS_KEY مفقود'))!;
  assert.equal(sec.code, 'ZATCA_UNIT_UNAVAILABLE');
  assert.equal(sec.reason, 'SECRETS');
  assert.equal(sec.alert, true);
  assert.equal(sec.logDetail?.code, 'KEY_MISSING');
  const fin = toZatcaHttpError(new FatooraInputError('body.uuid', 'صيغة'))!;
  assert.equal(fin.code, 'ZATCA_INTERNAL');
  assert.equal(fin.status, 500);
  assert.equal(fin.alert, true);
  for (const other of [new Error('x'), Object.assign(new Error('x'), { code: 'P2025' }), null, undefined, 'نص', 42]) {
    assert.equal(toZatcaHttpError(other), null, String(other));
  }
  const own = new ZatcaHttpError('ZATCA_USE_CREDIT_NOTE');
  assert.equal(toZatcaHttpError(own), own);
});

test('البُناة والجسم: لا logDetail في الردّ، والحقول الاختيارية حين توجد فقط', () => {
  const issues = [{ rule: 'BR-KSA-63', field: 'customer.address.buildingNumber', messageAr: 'رقم المبنى مطلوب', severity: 'error' as const }];
  const b = buyerIncompleteError('cust-1', issues);
  assert.equal(b.status, 422);
  assert.equal(b.messageAr, 'بيانات العميل (منشأة) ناقصة للفاتورة الضريبية: رقم المبنى مطلوب. أكملها ثم أعد الإصدار');
  assert.deepEqual(b.body(), { success: false, code: 'ZATCA_BUYER_INCOMPLETE', message: b.messageAr, issues, customerId: 'cust-1' });
  const u = unitUnavailableError('RENEWING', { source: 'regime', code: null });
  assert.deepEqual(u.body(), { success: false, code: 'ZATCA_UNIT_UNAVAILABLE', message: UNIT_UNAVAILABLE_MESSAGES.RENEWING, reason: 'RENEWING' });
  assert.equal(u.alert, false);
  assert.equal(unitUnavailableError('AUTH_FAILED').alert, true);
  const pending = new ZatcaHttpError('ZATCA_CLEARANCE_PENDING', { data: { id: 'inv' } });
  assert.deepEqual(pending.body(), { success: true, code: 'ZATCA_CLEARANCE_PENDING', message: ZATCA_ERROR_CATALOGUE.ZATCA_CLEARANCE_PENDING.messageAr, data: { id: 'inv' } });
  const rej = rejectedError([{ code: 'BR-KSA-37', message: 'رقم المبنى غير صحيح' }, { code: 'X', message: null }]);
  assert.equal(rej.messageAr, 'رفضت الهيئة الفاتورة وأُبطلت تلقائياً: رقم المبنى غير صحيح. صحّح البيانات وأصدر فاتورة جديدة');
  assert.equal(rej.errors?.length, 2);
  assert.equal(rejectedError([]).messageAr, 'رفضت الهيئة الفاتورة وأُبطلت تلقائياً. صحّح البيانات وأصدر فاتورة جديدة');
});
