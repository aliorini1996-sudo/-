import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buyerBadge, buyerCreatePayload, buyerFormCheck, buyerFormValues, buyerRelaxSimplified, buyerRelaxWarnings, buyerUpdatePayload, liveBuyerRow,
  liveBuyerStatus, repCompleteLocked, BUYER_ID_SCHEME_LABELS_AR,
} from './buyerForm';
import { BUYER_BILLING_FIELDS, BUYER_PHASE2_FIELDS, customerBuyerStatus, repCompleteOnlyDenied } from './buyerData';
import { buyerRelaxOn, zatcaCollectOn } from '../zatcaRegime';
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

// ─── طلب المالك ٣١ أكتوبر ٢٠٢٦: فكّ قيد الرقم الضريبي والعنوان الوطني ───

/** منشأة صريحة بعنوان كامل — ناقصها ما يُعدَّل في كل حالة. */
const B2B = {
  name: 'مؤسسة النور', buyerType: 'BUSINESS', taxNumber: '300000000000003', addrStreet: 'شارع الملك فهد', addrBuildingNo: '1234',
  addrPostalCode: '12345', city: 'الرياض', district: 'الملز', countryCode: 'SA',
};
/** صفوف تغطي القوائم: فرد، غير مصنّف، منشأة مكتملة، منشأة ناقصة (عنوان/رقم ضريبي خاطئ)، جهة حكومية، أجنبي، أرقام عربية. */
const ROWS = [
  STORED,
  { name: 'x' },
  { name: 'x', businessName: 'مؤسسة' },
  { name: 'x', channel: 'MT' },
  B2B,
  { ...B2B, addrBuildingNo: '12' },
  { ...B2B, taxNumber: '3123' },
  { ...B2B, taxNumber: null, buyerIdScheme: 'CRN', buyerIdValue: '1010123456' },
  { ...B2B, buyerType: 'GOVERNMENT', addrStreet: null },
  { ...B2B, countryCode: 'AE', taxNumber: '100000000000003' },
  { ...B2B, addrPostalCode: '١٢٣٤٥', addrBuildingNo: '١٢٣٤' },
  { name: 'فرد', buyerType: 'INDIVIDUAL', taxNumber: '300000000000003' },
];

test('فكّ القيد: صيغة الرقم الضريبي ورقم المبنى والرمز البريدي تنبيه لا يمنع الحفظ — وبلا الخيار خطأ كما اليوم', () => {
  for (const [field, bad] of [['taxNumber', '123'], ['addrBuildingNo', '12'], ['addrPostalCode', '1']] as const) {
    const today = buyerFormCheck({ [field]: bad }, null, BUYER_BILLING_FIELDS);
    assert.equal(today.ok, false, `${field}: اليوم خطأ`);
    assert.ok(today.errors[field]);
    const relaxed = buyerFormCheck({ [field]: bad }, null, BUYER_BILLING_FIELDS, { relaxed: true });
    assert.equal(relaxed.ok, true, `${field}: فكّ القيد لا يمنع`);
    assert.equal(relaxed.errors[field], undefined);
    assert.ok(relaxed.warnings.some(w => w.field === field && w.messageAr.startsWith('تنبيه:')), field);
    assert.equal(relaxed.patch[field], bad, 'القيمة تُرسل كما أُدخلت');
  }
  // المحارف غير المسموحة والطول تبقى أخطاء — والدولة والمعرّف لا يمسّها فكّ القيد
  for (const v of [{ taxNumber: '3000\u0001' }, { taxNumber: '3'.repeat(65) }, { addrBuildingNo: '1'.repeat(17) }, { countryCode: 'KSA' }, { buyerIdScheme: 'XYZ' }]) {
    assert.equal(buyerFormCheck(v, null, BUYER_BILLING_FIELDS, { relaxed: true }).ok, false, JSON.stringify(v));
  }
});

test('فكّ القيد — التطابق: بلا خيار و{} و{ relaxed: false } نتيجةٌ واحدة لكل حالة', () => {
  const cases: Array<[Record<string, string>, Record<string, string | null> | null]> = [
    [{ taxNumber: '123' }, null], [{ addrBuildingNo: '12', addrPostalCode: '1' }, STORED], [buyerFormValues(STORED), STORED],
    [{ ...buyerFormValues(STORED), countryCode: 'AE' }, STORED], [{ buyerIdScheme: 'NAT', buyerIdValue: '2123' }, null], [{ city: '' }, STORED],
    [{ buyerType: 'INDIVIDUAL', taxNumber: '300000000000003' }, null], [{ addrStreet: 'a\u0001' }, null],
  ];
  for (const [values, stored] of cases) {
    const base = buyerFormCheck(values, stored, BUYER_BILLING_FIELDS);
    assert.deepEqual(buyerFormCheck(values, stored, BUYER_BILLING_FIELDS, {}), base);
    assert.deepEqual(buyerFormCheck(values, stored, BUYER_BILLING_FIELDS, { relaxed: false }), base);
  }
});

test('فكّ القيد — الشارة: الناقص الذي تصدر له مبسطة «simplified»، وبلا الخيار أو false كما اليوم لكل صفّ', () => {
  const incomplete = { ...B2B, addrBuildingNo: '12' };
  assert.equal(buyerBadge(incomplete), 'incomplete');
  assert.equal(buyerBadge(incomplete, true), 'simplified');
  assert.equal(buyerBadge({ ...B2B, taxNumber: '3123' }, true), 'simplified', 'رقم ضريبي خاطئ');
  assert.equal(buyerBadge(B2B, true), null, 'المكتملة بلا شارة');
  assert.equal(buyerBadge({ name: 'x', businessName: 'مؤسسة' }, true), 'unclassified', 'غير المصنّف كما هو');
  // اسمٌ لا يصلح حتى للمبسطة (أطول من 1000) ⇒ يبقى «ناقصة» لأن الإصدار يحجبه
  assert.equal(buyerBadge({ ...incomplete, name: 'ن'.repeat(1001), businessName: null }, true), 'incomplete');
  for (const row of ROWS) {
    const today = customerBuyerStatus(row).bucket;
    const expected = today === 'incomplete' || today === 'unclassified' ? today : null;
    assert.equal(buyerBadge(row), expected, JSON.stringify(row));
    assert.equal(buyerBadge(row, false), expected, JSON.stringify(row));
    const relaxed = buyerBadge(row, true);
    assert.equal(relaxed === 'simplified' ? 'incomplete' : relaxed, expected, 'فكّ القيد يغيّر الصياغة لا الظهور');
  }
});

test('فكّ القيد — التنبيهات الحيّة والقرار: صيغ الحقول الثلاثة وحدها، والقرار هو قرار الإصدار', () => {
  const w = buyerRelaxWarnings({ ...buyerFormValues(B2B), taxNumber: '3123', addrPostalCode: '1', buyerType: 'INDIVIDUAL' }, B2B);
  assert.deepEqual(w.map(x => x.field).sort(), ['addrPostalCode', 'taxNumber'], 'تنبيه التصنيف القائم اليوم لا يُضاف');
  assert.deepEqual(buyerRelaxWarnings(buyerFormValues(B2B), B2B), [], 'بلا تغيير بلا تنبيه');
  const live = liveBuyerRow(B2B, { addrBuildingNo: '12', name: 'مؤسسة النور' });
  assert.equal(live.addrBuildingNo, '12');
  assert.deepEqual(customerBuyerStatus(live), liveBuyerStatus(B2B, { addrBuildingNo: '12', name: 'مؤسسة النور' }));
  assert.equal(buyerRelaxSimplified(live), true);
  assert.equal(buyerRelaxSimplified(B2B), false, 'المكتملة ضريبية');
  assert.equal(buyerRelaxSimplified({ name: 'x' }), false, 'الفرد مبسطة أصلاً لا بفكّ القيد');
});

test('buyerRelaxOn: الجمع (العلم أو التفعيل مع SA) والإعداد === true معاً — وغيرها القيد قائم', () => {
  const cases: Array<[Parameters<typeof buyerRelaxOn>[0], boolean]> = [
    [{ zatcaPhase2Enabled: true, countryCode: 'SA', buyerVatAddressRelaxed: true }, true],
    [{ zatcaPhase2StartedAt: '2026-11-20T06:00:00.000Z', countryCode: 'SA', buyerVatAddressRelaxed: true }, true],
    [{ zatcaPhase2Enabled: true, countryCode: 'SA', buyerVatAddressRelaxed: false }, false],
    [{ zatcaPhase2Enabled: true, countryCode: 'SA', buyerVatAddressRelaxed: null }, false],
    [{ zatcaPhase2Enabled: true, countryCode: 'SA' }, false],
    [{ zatcaPhase2Enabled: false, countryCode: 'SA', buyerVatAddressRelaxed: true }, false],
    [{ zatcaPhase2Enabled: true, countryCode: 'AE', buyerVatAddressRelaxed: true }, false],
    [{ zatcaPhase2Enabled: true, countryCode: 'SA', buyerVatAddressRelaxed: 'true' as unknown as boolean }, false],
    [null, false],
    [undefined, false],
  ];
  for (const [c, want] of cases) {
    assert.equal(buyerRelaxOn(c), want, JSON.stringify(c));
    if (want) assert.equal(zatcaCollectOn(c), true);
  }
});
