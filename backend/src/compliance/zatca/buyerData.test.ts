// فوترة ZATCA (Z5.1a، D2) — منطق بيانات المشتري الصرف: تطابق buyerParty.ts مع mapInvoice.ts (الوحدة الحيّة)، «مكتمل» = فحص
// الإصدار نفسه، التطبيع (الأرقام العربية)، قواعد الحفظ للمتغيّر وحده، التصنيف (Q2) والاقتراح، وقيود المندوب (نقد الخطة 21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySubtype, mapBuyerParty, BuyerSource } from './mapInvoice';
import { buyerIssues } from './validators';
import { classifyBuyerSubtype, mapBuyerPartyLike } from './buyerParty';
import {
  BUSINESS_ID_SCHEMES, BUYER_BILLING_FIELDS, BUYER_REP_COMPLETE_FIELDS, BuyerRowLike, buyerDowngrade, buyerFieldValue, buyerSourceFromCustomer,
  changedBuyerFields, clearedBuyerFields, customerBuyerStatus, latinDigits, missingBuyerFormFields, normalizeBuyerFields, repCompleteOnlyDenied,
  validateBuyerChanges, bodyTouchesBuyerGate,
} from './buyerData';
import { BUYER_ID_SCHEMES } from './validators';
import { BUSINESS_BUYER, WALK_IN_BUYER } from './__fixtures__/z1-sources';
import { COMPLIANCE_STANDARD_BUYER, COMPLIANCE_WALK_IN_BUYER } from './complianceSamples';

const AR = (s: string) => s.replace(/[0-9]/g, d => String.fromCharCode(0x0660 + Number(d)));
const FA = (s: string) => s.replace(/[0-9]/g, d => String.fromCharCode(0x06f0 + Number(d)));

/** توليد حتمي لتركيبات بيانات المشتري (قيم فارغة، مسافات، محارف تحكّم، أحرف صغيرة، صيغ خاطئة). */
function* buyerCombos(n: number): Generator<BuyerSource> {
  let seed = 20260917;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const text = [null, undefined, '', '   ', '', ' قيمة ', 'Value'];
  for (let i = 0; i < n; i++) {
    yield {
      name: pick([null, '', 'عميل', ' أبو خالد ']),
      businessName: pick([null, '', '  ', 'مؤسسة', '']),
      taxNumber: pick([null, '', ' ', '311111111111113', '123', ' 300000000000003 ']),
      commercialReg: pick([null, '', '2050012345', 'CR-1', ' 1010 ']),
      buyerType: pick([null, '', 'business', 'BUSINESS', 'INDIVIDUAL', 'government', 'x']),
      buyerIdScheme: pick([null, '', 'crn', 'NAT', 'IQA', 'ZZZ', ' 700 ']),
      buyerIdValue: pick([null, '', '1234567890', 'A B', ' 7000000001 ']),
      addrStreet: pick(text),
      addrBuildingNo: pick([null, '', '1234', '12', ' 7788 ']),
      addrAdditionalNo: pick([null, '', '1111', 'x']),
      addrPostalCode: pick([null, '', '12345', '1234']),
      district: pick(text),
      city: pick(text),
      countryCode: pick([null, '', 'SA', 'sa', 'AE', 'KSA']),
    } as BuyerSource;
  }
}

test('buyerParty.ts يطابق mapInvoice.ts (الوحدة الحيّة) سلوكاً: التصنيف والطرف 01/02 على التجهيزات وألف تركيبة', () => {
  const fixtures: BuyerSource[] = [BUSINESS_BUYER, WALK_IN_BUYER, COMPLIANCE_STANDARD_BUYER, COMPLIANCE_WALK_IN_BUYER, {}, ...buyerCombos(1000)];
  for (const b of fixtures) {
    assert.equal(classifyBuyerSubtype(b), classifySubtype(b), JSON.stringify(b));
    for (const s of ['01', '02'] as const) assert.deepEqual(mapBuyerPartyLike(b, s), mapBuyerParty(b, s), `${s} ${JSON.stringify(b)}`);
  }
});

test('«مكتمل» = فحص الإصدار نفسه: issues === buyerIssues(standard, mapBuyerParty(src, 01)) — والأرقام العربية تُحكم كاللاتينية', () => {
  const rows: BuyerRowLike[] = [BUSINESS_BUYER, WALK_IN_BUYER, COMPLIANCE_STANDARD_BUYER, COMPLIANCE_WALK_IN_BUYER, ...buyerCombos(400)]
    .map(b => ({ ...b }) as BuyerRowLike);
  for (const row of rows) {
    const st = customerBuyerStatus(row);
    assert.deepEqual(st.issues, buyerIssues('standard', mapBuyerParty(buyerSourceFromCustomer(row), '01')));
    assert.equal(st.complete, !st.issues.some(i => i.severity === 'error'));
    assert.equal(st.subtypeIfIssuedNow, classifySubtype(buyerSourceFromCustomer(row)));
  }
  assert.equal(customerBuyerStatus({ ...COMPLIANCE_STANDARD_BUYER }).complete, true);
  assert.equal(customerBuyerStatus({ ...BUSINESS_BUYER }).complete, true);
  const arabic: BuyerRowLike = {
    ...BUSINESS_BUYER, taxNumber: AR('311111111111113'), commercialReg: FA('2050012345'), addrBuildingNo: AR('7788'), addrPostalCode: FA('31952'),
  };
  const st = customerBuyerStatus(arabic);
  assert.equal(st.complete, true, 'أرقام عربية/فارسية لعميل مكتمل');
  assert.deepEqual(st, customerBuyerStatus({ ...BUSINESS_BUYER }));
  assert.equal(latinDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹'), '0123456789 0123456789');
});

test('التطبيع: قصّ، أرقام لاتينية في الحقول الرقمية، أحرف كبيرة للنوع والمخطط والدولة، \'\' ⇒ null، غياب = بلا تغيير', () => {
  const { patch, errors } = normalizeBuyerFields({
    buyerType: ' business ', buyerIdScheme: 'nat', buyerIdValue: AR('1234567890'), addrStreet: '  شارع الملك  ', addrBuildingNo: AR('1234'),
    addrAdditionalNo: FA('5678'), addrPostalCode: ' ١٢٣٤٥ ', countryCode: 'sa', taxNumber: AR('300000000000003'), commercialReg: '', city: null,
    district: undefined, name: 'لا يُلتقط', creditLimit: 99,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(patch, {
    buyerType: 'BUSINESS', buyerIdScheme: 'NAT', buyerIdValue: '1234567890', addrStreet: 'شارع الملك', addrBuildingNo: '1234', addrAdditionalNo: '5678',
    addrPostalCode: '12345', countryCode: 'SA', taxNumber: '300000000000003', commercialReg: null, city: null,
  });
  assert.equal(buyerFieldValue('businessName', ' ١٢٣ '), '١٢٣', 'النصوص الحرّة لا تُحوَّل أرقامها');
  const bad = normalizeBuyerFields({ buyerType: 5, addrBuildingNo: ['1'] });
  assert.deepEqual(bad.patch, {});
  assert.deepEqual(bad.errors.map(e => e.field), ['buyerType', 'addrBuildingNo']);
  assert.deepEqual(normalizeBuyerFields(null), { patch: {}, errors: [] });
  assert.deepEqual([...BUYER_BILLING_FIELDS].sort(), ['addrAdditionalNo', 'addrBuildingNo', 'addrPostalCode', 'addrStreet', 'businessName', 'buyerIdScheme', 'buyerIdValue', 'buyerType', 'city', 'commercialReg', 'countryCode', 'district', 'taxNumber'].sort());
  assert.equal(bodyTouchesBuyerGate({ name: 'x', phone: '0500000000', city: 'الرياض' }), false, 'المدينة وحدها لا تستدعي البوابة');
  assert.equal(bodyTouchesBuyerGate({ taxNumber: null }), true);
  assert.equal(bodyTouchesBuyerGate({ buyerType: undefined }), false);
});

const fields = (xs: { field: string }[]) => xs.map(x => x.field).sort();

test('الحفظ: الرقم الضريبي 15 رقماً يبدأ وينتهي بـ3 (السعودية/بلا دولة)، وخارجها تحذير — ويُفحص المتغيّر وحده', () => {
  assert.deepEqual(fields(validateBuyerChanges({ taxNumber: '123' }, null).errors), ['taxNumber']);
  assert.deepEqual(validateBuyerChanges({ taxNumber: '300000000000003' }, null).errors, []);
  assert.deepEqual(fields(validateBuyerChanges({ taxNumber: '300000000000004' }, { countryCode: 'SA' }).errors), ['taxNumber']);
  const foreign = validateBuyerChanges({ taxNumber: '100200300', countryCode: 'AE' }, null);
  assert.deepEqual(foreign.errors, []);
  assert.deepEqual(fields(foreign.warnings), ['taxNumber']);
  // بيانات قديمة خاطئة لم تتغيّر لا تمنع حفظ غيرها (وبأرقام عربية مطابقة بعد التطبيع)
  const stored: BuyerRowLike = { taxNumber: AR('123'), commercialReg: 'CR 1', city: 'الرياض' };
  const same = validateBuyerChanges(normalizeBuyerFields({ taxNumber: AR('123'), commercialReg: 'CR 1', addrBuildingNo: '1234' }).patch, stored);
  assert.deepEqual(same.errors, []);
  assert.deepEqual(same.changed, ['addrBuildingNo']);
  assert.deepEqual(changedBuyerFields(stored, { taxNumber: '123' }), []);
});

test('الحفظ: السجل التجاري أبجدي رقمي (خطأ) و10 أرقام (تحذير)، نوع المعرّف من القائمة، وقيمته أبجدية رقمية ≤ 64', () => {
  assert.deepEqual(fields(validateBuyerChanges({ commercialReg: '10-10' }, null).errors), ['commercialReg']);
  const short = validateBuyerChanges({ commercialReg: '12345' }, null);
  assert.deepEqual(short.errors, []);
  assert.deepEqual(fields(short.warnings), ['commercialReg']);
  assert.deepEqual(fields(validateBuyerChanges({ buyerIdScheme: 'XYZ', buyerIdValue: '1' }, null).errors), ['buyerIdScheme']);
  assert.deepEqual(fields(validateBuyerChanges({ buyerIdScheme: 'OTH', buyerIdValue: 'A B' }, null).errors), ['buyerIdValue']);
  assert.deepEqual(fields(validateBuyerChanges({ buyerIdScheme: 'OTH', buyerIdValue: 'A'.repeat(65) }, null).errors), ['buyerIdValue']);
  assert.deepEqual(fields(validateBuyerChanges({ buyerType: 'COMPANY' }, null).errors), ['buyerType']);
});

test('الحفظ: زوج نوع المعرّف وقيمته على الصفّ المدمج — CRN بلا قيمة مقبول مع سجل تجاري، والصيغ الخاصة تحذيرات', () => {
  assert.deepEqual(fields(validateBuyerChanges({ buyerIdScheme: 'NAT' }, null).errors), ['buyerIdValue']);
  assert.deepEqual(fields(validateBuyerChanges({ buyerIdValue: '1234567890' }, null).errors), ['buyerIdScheme']);
  assert.deepEqual(validateBuyerChanges({ buyerIdScheme: 'CRN' }, { commercialReg: '2050012345' }).errors, []);
  // مسح السجل التجاري يُسقط قيمة CRN الضمنية ⇒ خطأ (لا تُحذف الهوية بصمت)
  assert.deepEqual(fields(validateBuyerChanges({ commercialReg: null }, { commercialReg: '2050012345', buyerIdScheme: 'CRN' }).errors), ['buyerIdValue']);
  // بقايا قديمة غير متّسقة لا تمنع حفظ حقل آخر
  assert.deepEqual(validateBuyerChanges({ addrStreet: 'شارع' }, { buyerIdScheme: 'NAT', buyerIdValue: null }).errors, []);
  for (const [scheme, good, bad] of [['NAT', '1234567890', '2234567890'], ['IQA', '2234567890', '1234567890'], ['700', '7000000001', '1000000001'], ['CRN', '1010101010', 'ABC123'], ['TIN', '1234567890', '123']] as const) {
    // منشأة صريحة: تنبيهات الصيغة وحدها (غير المصنّف بمعرّف منشأة يُنبَّه أيضاً على نوعه — اختبار مؤشر المعرّف أدناه)
    assert.deepEqual(validateBuyerChanges({ buyerIdScheme: scheme, buyerIdValue: good }, { buyerType: 'BUSINESS' }).warnings, [], scheme);
    const w = validateBuyerChanges({ buyerIdScheme: scheme, buyerIdValue: bad }, { buyerType: 'BUSINESS' });
    assert.deepEqual(w.errors, [], scheme);
    assert.deepEqual(fields(w.warnings), ['buyerIdValue'], scheme);
  }
});

test('الحفظ: العنوان الوطني — المبنى 4 أرقام والرمز البريدي 5 للسعودية، الإضافي تحذير، الدولة حرفان، والنصوص بلا محارف تحكّم', () => {
  assert.deepEqual(fields(validateBuyerChanges({ addrBuildingNo: '123', addrPostalCode: '1234' }, null).errors), ['addrBuildingNo', 'addrPostalCode']);
  assert.deepEqual(validateBuyerChanges({ addrBuildingNo: '1234', addrPostalCode: '12345' }, { countryCode: null }).errors, []);
  assert.deepEqual(validateBuyerChanges({ addrBuildingNo: 'B-12', addrPostalCode: 'SW1A1AA', countryCode: 'GB' }, null).errors, []);
  const extra = validateBuyerChanges({ addrAdditionalNo: '12' }, null);
  assert.deepEqual(extra.errors, []);
  assert.deepEqual(fields(extra.warnings), ['addrAdditionalNo']);
  assert.deepEqual(fields(validateBuyerChanges({ addrAdditionalNo: '1'.repeat(17) }, null).errors), ['addrAdditionalNo']);
  assert.deepEqual(fields(validateBuyerChanges({ countryCode: 'KSA' }, null).errors), ['countryCode']);
  assert.deepEqual(fields(validateBuyerChanges({ addrStreet: 'شارع', city: 'م'.repeat(201), businessName: 'x'.repeat(1001) }, null).errors), ['addrStreet', 'businessName', 'city']);
  // تغيير الدولة إلى السعودية يعيد فحص المبنى المحفوظ
  assert.deepEqual(fields(validateBuyerChanges({ countryCode: 'SA' }, { countryCode: 'GB', addrBuildingNo: 'B-12' }).errors), ['addrBuildingNo']);
});

test('الحفظ: فرد صراحةً وله رقم ضريبي صحيح أو سجل ⇒ تحذير «هل هو منشأة؟» لا خطأ', () => {
  const v = validateBuyerChanges({ buyerType: 'INDIVIDUAL' }, { taxNumber: '300000000000003' });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(fields(v.warnings), ['buyerType']);
  assert.deepEqual(validateBuyerChanges({ buyerType: 'INDIVIDUAL' }, { taxNumber: null, commercialReg: null }).warnings, []);
});

test('التصنيف (Q2): الصريح أولاً؛ رقم ضريبي أو سجل ⇒ منشأة تلقائياً؛ قناة تجارية أو اسم منشأة وحدهما ⇒ غير مصنّف؛ وإلا فرد', () => {
  const cases: Array<[BuyerRowLike, string, string | null, string | null, string | null]> = [
    [{ ...COMPLIANCE_STANDARD_BUYER }, 'business', 'complete', 'BUSINESS', 'explicit'],
    [{ name: 'x', taxNumber: '300000000000003' }, 'business', 'incomplete', 'BUSINESS', 'vat'],
    [{ name: 'x', taxNumber: '123' }, 'business', 'incomplete', 'BUSINESS', 'vat-invalid'],
    [{ name: 'x', commercialReg: '2050012345' }, 'business', 'incomplete', 'BUSINESS', 'cr'],
    [{ name: 'x', channel: 'WHOLESALE' }, 'unclassified', 'unclassified', 'BUSINESS', 'channel'],
    [{ name: 'x', businessName: 'بقالة' }, 'unclassified', 'unclassified', 'BUSINESS', 'businessName'],
    [{ name: 'x', channel: 'CASH_VAN' }, 'individual', null, null, null],
    [{ name: 'x' }, 'individual', null, null, null],
    [{ name: 'x', buyerType: 'INDIVIDUAL', taxNumber: '300000000000003', channel: 'MT' }, 'individual', null, 'INDIVIDUAL', 'explicit'],
    [{ name: 'x', buyerType: 'GOVERNMENT' }, 'government', 'incomplete', 'GOVERNMENT', 'explicit'],
    [{ name: 'x', buyerType: 'business', channel: 'TT' }, 'business', 'incomplete', 'BUSINESS', 'explicit'],
    [{ name: 'x', businessName: '   ', channel: '' }, 'individual', null, null, null],
  ];
  for (const [row, classification, bucket, suggestedType, source] of cases) {
    const st = customerBuyerStatus(row);
    assert.deepEqual([st.classification, st.bucket, st.suggestedType, st.suggestionSource], [classification, bucket, suggestedType, source], JSON.stringify(row));
  }
  const miss = missingBuyerFormFields(customerBuyerStatus({ name: 'x', taxNumber: '300000000000003' }));
  assert.deepEqual(miss, ['addrStreet', 'city', 'addrBuildingNo', 'district', 'addrPostalCode']);
  assert.deepEqual(missingBuyerFormFields(customerBuyerStatus({ buyerType: 'BUSINESS' })), ['businessName', 'buyerIdValue', 'addrStreet', 'city', 'addrBuildingNo', 'district', 'addrPostalCode']);
});

test('نقد الخطة 21: التخفيض (01 ⇒ 02) يُكشف، والمسح يُكشف — والإكمال ليس أيهما', () => {
  const b2b: BuyerRowLike = { name: 'x', taxNumber: '300000000000003', city: 'الرياض' };
  assert.equal(buyerDowngrade(b2b, { taxNumber: null }), true);
  assert.equal(buyerDowngrade(b2b, { buyerType: 'INDIVIDUAL' }), true);
  assert.equal(buyerDowngrade(b2b, { taxNumber: null, commercialReg: '2050012345' }), false, 'بقي سجل ⇒ ضريبية');
  assert.equal(buyerDowngrade(b2b, { addrBuildingNo: '1234', buyerType: 'BUSINESS' }), false);
  assert.equal(buyerDowngrade({ name: 'x', channel: 'MT' }, { buyerType: 'INDIVIDUAL' }), false, 'غير مصنّف ⇒ فرد: جواب «منشأة أم فرد؟» لا تخفيض');
  assert.equal(buyerDowngrade({ buyerType: 'GOVERNMENT' }, { buyerType: 'BUSINESS' }), false);
  assert.deepEqual(clearedBuyerFields(b2b, { city: null, district: null, taxNumber: '300000000000003' }), ['city']);
  assert.deepEqual(clearedBuyerFields({ city: '  ' }, { city: null }), [], 'فراغ محفوظ ليس قيمة');
});

test('الدولة null = السعودية: اختيار «السعودية» لعميل بلا دولة (أو العكس) ليس تغييراً — لا يُعيد فحص رقم ضريبي قديم خاطئ ولا يُعدّ مسحاً', () => {
  const stale: BuyerRowLike = { name: 'x', taxNumber: '300-000-000', addrBuildingNo: '12', countryCode: null };
  const v = validateBuyerChanges(normalizeBuyerFields({ countryCode: 'SA', taxNumber: '300-000-000' }).patch, stale);
  assert.deepEqual([v.errors, v.changed], [[], []]);
  const back = validateBuyerChanges(normalizeBuyerFields({ countryCode: '' }).patch, { ...stale, countryCode: 'sa' });
  assert.deepEqual([back.errors, back.changed], [[], []]);
  assert.deepEqual(clearedBuyerFields({ countryCode: 'SA' }, { countryCode: null }), []);
  assert.deepEqual(clearedBuyerFields({ countryCode: 'AE' }, { countryCode: null }), ['countryCode']);
  // تغيير فعلي للدولة يبقى تغييراً ويُعيد الفحص
  assert.deepEqual(changedBuyerFields({ countryCode: null }, { countryCode: 'AE' }), ['countryCode']);
  assert.deepEqual(fields(validateBuyerChanges({ countryCode: 'SA' }, { countryCode: 'AE', taxNumber: '123' }).errors), ['taxNumber']);
  assert.deepEqual(fields(validateBuyerChanges({ countryCode: null }, { countryCode: 'GB', addrBuildingNo: 'B-12' }).errors), ['addrBuildingNo']);
});

test('معرّف منشأة في حقلَي المعرّف (CRN، 700، MOM، MLS، SAG، TIN) بقيمته ⇒ مؤشر منشأة: «غير مصنّف» في القائمة، واقتراح منشأة، وتنبيه عند الحفظ', () => {
  assert.ok(BUSINESS_ID_SCHEMES.every(s => (BUYER_ID_SCHEMES as readonly string[]).includes(s)));
  const address = { addrStreet: 's', addrBuildingNo: '1234', district: 'd', city: 'c', addrPostalCode: '12345' };
  for (const scheme of BUSINESS_ID_SCHEMES) {
    const row: BuyerRowLike = { name: 'مؤسسة', buyerIdScheme: scheme, buyerIdValue: '1010101010', ...address };
    const st = customerBuyerStatus(row);
    assert.deepEqual([st.classification, st.bucket, st.suggestedType, st.suggestionSource, st.subtypeIfIssuedNow], ['unclassified', 'unclassified', 'BUSINESS', 'businessId', '02'], scheme);
    assert.equal(customerBuyerStatus({ ...row, buyerType: 'BUSINESS' }).bucket, 'complete', scheme);
    const w = validateBuyerChanges({ buyerIdScheme: scheme, buyerIdValue: '1010101010' }, { name: 'مؤسسة' });
    assert.deepEqual(w.errors, [], scheme);
    assert.ok(w.warnings.some(x => x.field === 'buyerType'), `${scheme}: تنبيه غير المصنّف`);
  }
  const cases: Array<[BuyerRowLike, string, string | null, string | null, string | null]> = [
    [{ name: 'x', buyerIdScheme: 'crn', buyerIdValue: ' ١٠١٠١٠١٠١٠ ' }, 'unclassified', 'unclassified', 'BUSINESS', 'businessId'],
    [{ name: 'x', buyerIdScheme: 'CRN', buyerIdValue: '1010101010', channel: 'MT' }, 'unclassified', 'unclassified', 'BUSINESS', 'businessId'],
    [{ name: 'x', buyerIdScheme: 'CRN', buyerIdValue: '  ' }, 'individual', null, null, null],
    [{ name: 'x', buyerIdScheme: 'NAT', buyerIdValue: '1000000001' }, 'individual', null, null, null],
    [{ name: 'x', buyerIdScheme: 'IQA', buyerIdValue: '2000000001', businessName: 'بقالة' }, 'unclassified', 'unclassified', 'BUSINESS', 'businessName'],
    [{ name: 'x', buyerType: 'INDIVIDUAL', buyerIdScheme: '700', buyerIdValue: '7000000001' }, 'individual', null, 'INDIVIDUAL', 'explicit'],
    [{ name: 'x', commercialReg: '2050012345', buyerIdScheme: '700', buyerIdValue: '7000000001' }, 'business', 'incomplete', 'BUSINESS', 'cr'],
  ];
  for (const [row, classification, bucket, suggestedType, source] of cases) {
    const st = customerBuyerStatus(row);
    assert.deepEqual([st.classification, st.bucket, st.suggestedType, st.suggestionSource], [classification, bucket, suggestedType, source], JSON.stringify(row));
  }
  // التنبيه: للمتغيّر وحده، ولا تنبيه للمنشأة الصريحة ولا لمن له رقم ضريبي/سجل ولا لمعرّف فرد
  assert.deepEqual(validateBuyerChanges({ buyerIdScheme: 'CRN', buyerIdValue: '1010101010', buyerType: 'BUSINESS' }, null).warnings, []);
  assert.deepEqual(validateBuyerChanges({ buyerIdScheme: 'MOM', buyerIdValue: 'A1' }, { taxNumber: '300000000000003' }).warnings, []);
  assert.deepEqual(validateBuyerChanges({ buyerIdScheme: 'NAT', buyerIdValue: '1000000001' }, null).warnings, []);
  assert.deepEqual(validateBuyerChanges({ addrStreet: 'شارع' }, { buyerIdScheme: 'CRN', buyerIdValue: '1010101010' }).warnings, [], 'قديم لم يتغيّر');
  const ind = validateBuyerChanges({ buyerType: 'INDIVIDUAL' }, { buyerIdScheme: '700', buyerIdValue: '7000000001' });
  assert.deepEqual([ind.errors, fields(ind.warnings)], [[], ['buyerType']]);
});

test('Q3 — المندوب بلا صلاحية تعديل العملاء: يُكمل الفارغ من نوع العميل والمعرّف والعنوان الوطني والدولة وحده', () => {
  assert.deepEqual([...BUYER_REP_COMPLETE_FIELDS].sort(), ['addrAdditionalNo', 'addrBuildingNo', 'addrPostalCode', 'addrStreet', 'buyerIdScheme', 'buyerIdValue', 'buyerType', 'city', 'countryCode', 'district']);
  const stored: BuyerRowLike = { name: 'x', businessName: 'قديم', city: 'الرياض', addrStreet: '  ', countryCode: null };
  assert.deepEqual(repCompleteOnlyDenied(stored, { businessName: 'جديد', taxNumber: '300000000000003', commercialReg: '1010101010' }), ['businessName', 'taxNumber', 'commercialReg']);
  assert.deepEqual(repCompleteOnlyDenied(stored, { city: 'جدة', district: null }), ['city']);
  assert.deepEqual(repCompleteOnlyDenied(stored, { city: null }), ['city'], 'مسح محفوظ');
  assert.deepEqual(repCompleteOnlyDenied(stored, { addrStreet: 'شارع', buyerType: 'BUSINESS', buyerIdScheme: 'CRN', buyerIdValue: '1', countryCode: 'SA' }), [], 'فراغ محفوظ يُكمل');
  assert.deepEqual(repCompleteOnlyDenied(stored, { city: 'الرياض', businessName: 'قديم', taxNumber: null }), [], 'المرسل المطابق ليس تعديلاً');
  assert.deepEqual(repCompleteOnlyDenied({ ...stored, countryCode: 'SA' }, { countryCode: 'AE' }), ['countryCode']);
  // كل حقل خارج القائمة ممنوع ولو فارغاً، وكل حقل فيها مسموح حين يكون فارغاً
  for (const f of BUYER_BILLING_FIELDS) {
    const got = repCompleteOnlyDenied({}, { [f]: f === 'countryCode' ? 'AE' : 'V1' });
    assert.deepEqual(got, (BUYER_REP_COMPLETE_FIELDS as readonly string[]).includes(f) ? [] : [f], f);
  }
});
