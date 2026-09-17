import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buyerBadge, buyerCreatePayload, buyerFormCheck, buyerFormValues, buyerUpdatePayload, liveBuyerStatus, repCompleteLocked, BUYER_ID_SCHEME_LABELS_AR,
} from './buyerForm';
import { BUYER_BILLING_FIELDS, BUYER_PHASE2_FIELDS, repCompleteOnlyDenied } from './buyerData';
import { BUYER_ID_SCHEMES } from './validators';
import { productVatPayload, vatexCodesFor, VATEX_LABELS_AR } from './productVatForm';
import { VATEX_CATEGORY } from './validators';

/**
 * فوترة ZATCA (Z5.1a، D2) — أدوات نماذج بيانات المشتري والفئة الضريبية في الواجهة: الحمولة (الإنشاء: غير الفارغ؛ التعديل:
 * المتغيّر وحده والمُفرَّغ null — إصلاح «لا يمكن مسح حقل» في /m للحقول الجديدة وحدها)، الفحص قبل الإرسال، والحالة الحيّة.
 */

const STORED = { name: 'بقالة', taxNumber: '300000000000003', addrStreet: 'شارع', addrBuildingNo: '1234', city: 'الرياض', buyerType: null };

test('القيم: null ⇒ \'\' لكل حقول الفوترة', () => {
  const v = buyerFormValues(STORED);
  assert.deepEqual(Object.keys(v).sort(), [...BUYER_BILLING_FIELDS].sort());
  assert.equal(v.addrBuildingNo, '1234');
  assert.equal(v.buyerType, '');
  assert.equal(buyerFormValues(null).taxNumber, '');
});

test('حمولة الإنشاء: غير الفارغ من حقول المرحلة الثانية وحدها', () => {
  assert.deepEqual(buyerCreatePayload({ buyerType: 'BUSINESS', addrStreet: '  ', addrPostalCode: ' 12345 ', taxNumber: '300000000000003' }), { buyerType: 'BUSINESS', addrPostalCode: '12345' });
  assert.deepEqual(buyerCreatePayload({}), {});
});

test('حمولة التعديل: المتغيّر بعد التطبيع وحده، والمُفرَّغ من قيمة محفوظة null — والمطابق بأرقام عربية لا يُرسل', () => {
  const values = { ...buyerFormValues(STORED), addrBuildingNo: '١٢٣٤', addrStreet: '', addrPostalCode: '12345', buyerType: 'business' };
  assert.deepEqual(buyerUpdatePayload(values, STORED), { addrStreet: null, addrPostalCode: '12345', buyerType: 'business' });
  assert.deepEqual(buyerUpdatePayload(buyerFormValues(STORED), STORED, BUYER_BILLING_FIELDS), {});
  assert.deepEqual(buyerUpdatePayload({ city: '' }, STORED, BUYER_BILLING_FIELDS), { city: null });
  assert.deepEqual(buyerUpdatePayload({}, STORED), {}, 'غياب المفتاح = بلا تغيير');
});

test('الفحص قبل الإرسال: أخطاء الصيغ للمتغيّر وحده، والمسح يُرصد، والنقص لا يمنع', () => {
  const bad = buyerFormCheck({ ...buyerFormValues(STORED), addrPostalCode: '123', buyerIdScheme: 'NAT' }, STORED, BUYER_BILLING_FIELDS);
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['addrPostalCode', 'buyerIdValue']);
  const cleared = buyerFormCheck({ ...buyerFormValues(STORED), city: '' }, STORED, BUYER_BILLING_FIELDS);
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.cleared, ['city']);
  assert.equal(buyerFormCheck({ buyerType: 'BUSINESS' }, null, BUYER_PHASE2_FIELDS).ok, true, 'منشأة بلا عنوان تُحفظ (النقص لا يمنع)');
});

test('الحالة الحيّة والشارة', () => {
  assert.equal(liveBuyerStatus(STORED, {}).bucket, 'incomplete');
  assert.equal(liveBuyerStatus(STORED, { district: 'الملز', addrPostalCode: '12345' }).complete, true);
  assert.equal(liveBuyerStatus(null, { name: 'x', channel: 'MT' }).classification, 'unclassified');
  assert.equal(buyerBadge(STORED), 'incomplete');
  assert.equal(buyerBadge({ name: 'x', businessName: 'مؤسسة' }), 'unclassified');
  assert.equal(buyerBadge({ name: 'x' }), null);
  assert.deepEqual(Object.keys(BUYER_ID_SCHEME_LABELS_AR).sort(), [...BUYER_ID_SCHEMES].sort());
});

test('Q3 في نموذج المندوب: الحقل المقفل = ما يرفضه الخادم لمن يُكمل فقط (خارج Q3 أو له قيمة محفوظة)', () => {
  const stored = { ...STORED, countryCode: null, addrAdditionalNo: '  ' };
  for (const f of BUYER_BILLING_FIELDS) {
    const next = f === 'countryCode' ? 'AE' : 'V9';
    assert.equal(repCompleteLocked(stored, f), repCompleteOnlyDenied(stored, { [f]: next }).length > 0, f);
  }
  assert.deepEqual(BUYER_BILLING_FIELDS.filter(f => !repCompleteLocked(stored, f)).sort(),
    ['addrAdditionalNo', 'addrPostalCode', 'buyerIdScheme', 'buyerIdValue', 'buyerType', 'countryCode', 'district']);
  assert.equal(repCompleteLocked(null, 'addrStreet'), false);
  assert.equal(repCompleteLocked(null, 'taxNumber'), true);
});

test('الفئة الضريبية: الرموز لكل فئة، وأسماء كل الرموز، والحمولة تُسقط الرمز والسبب للقياسية والتلقائية', () => {
  assert.deepEqual(Object.keys(VATEX_LABELS_AR).sort(), Object.keys(VATEX_CATEGORY).sort());
  assert.deepEqual(vatexCodesFor('O'), ['VATEX-SA-OOS']);
  assert.ok(vatexCodesFor('Z').includes('VATEX-SA-32'));
  assert.deepEqual(vatexCodesFor(null), []);
  assert.deepEqual(productVatPayload({ vatCategory: '', vatExemptionCode: 'VATEX-SA-32', vatExemptionReason: 'x' }), { vatCategory: null, vatExemptionCode: null, vatExemptionReason: null });
  assert.deepEqual(productVatPayload({ vatCategory: 'S', vatExemptionCode: 'VATEX-SA-32' }), { vatCategory: 'S', vatExemptionCode: null, vatExemptionReason: null });
  assert.deepEqual(productVatPayload({ vatCategory: 'z', vatExemptionCode: ' VATEX-SA-32 ', vatExemptionReason: ' صادرات ' }), { vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-32', vatExemptionReason: 'صادرات' });
});
