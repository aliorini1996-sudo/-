import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSaudiVat, isBuildingNo, isPostalCode, isAlphanumericId, isCountryCode, sellerIssues, buyerIssues, utf8ByteLength,
  sanitizeText, charLength, PartyLike,
} from './validators';

const GOOD_SELLER: PartyLike = {
  registrationName: 'شركة تجريبية',
  vatNumber: '399999999900003',
  otherId: { scheme: 'CRN', value: '1010010000' },
  address: { street: 'طريق الملك', buildingNumber: '2322', district: 'العليا', city: 'الرياض', postalZone: '12345', country: 'SA' },
};

const GOOD_BUYER: PartyLike = {
  registrationName: 'مؤسسة البقالة',
  vatNumber: '311111111111113',
  address: { street: 'شارع فهد', buildingNumber: '7788', district: 'الروضة', city: 'الدمام', postalZone: '31952', country: 'SA' },
};

const rules = (xs: Array<{ rule: string }>) => xs.map(x => x.rule).sort();

test('isSaudiVat: 15 رقماً يبدأ وينتهي بـ 3 فقط', () => {
  assert.equal(isSaudiVat('399999999900003'), true);
  assert.equal(isSaudiVat('300000000000003'), true);
  assert.equal(isSaudiVat('399999999900004'), false, 'لا ينتهي بـ 3');
  assert.equal(isSaudiVat('299999999900003'), false, 'لا يبدأ بـ 3');
  assert.equal(isSaudiVat('39999999990003'), false, '14 رقماً');
  assert.equal(isSaudiVat('3999999999000033'), false, '16 رقماً');
  assert.equal(isSaudiVat('3999999999O0003'), false, 'حرف O لا صفر');
  assert.equal(isSaudiVat('٣٩٩٩٩٩٩٩٩٩٠٠٠٠٣'), false, 'أرقام عربية-هندية مرفوضة');
  assert.equal(isSaudiVat(' 399999999900003'), false, 'مسافة');
  assert.equal(isSaudiVat(undefined), false);
});

test('isBuildingNo (4 أرقام) وisPostalCode (5 أرقام)', () => {
  assert.equal(isBuildingNo('2322'), true);
  assert.equal(isBuildingNo('232'), false);
  assert.equal(isBuildingNo('23222'), false);
  assert.equal(isBuildingNo('23a2'), false);
  assert.equal(isPostalCode('12345'), true);
  assert.equal(isPostalCode('1234'), false);
  assert.equal(isPostalCode('123456'), false);
  assert.equal(isPostalCode('١٢٣٤٥'), false);
  assert.equal(isAlphanumericId('1010010000'), true);
  assert.equal(isAlphanumericId('1010 010000'), false);
  assert.equal(isAlphanumericId('10-10'), false);
});

test('utf8ByteLength يطابق Buffer.byteLength للعربية والرموز والبدائل', () => {
  for (const s of ['abc', 'شركة', 'مؤسسة 🚚 للتجارة', 'é', '\uD83D', '']) {
    assert.equal(utf8ByteLength(s), Buffer.byteLength(s, 'utf8'), s);
  }
});

test('sellerIssues: بائع مكتمل بلا مخالفات', () => {
  assert.deepEqual(sellerIssues(GOOD_SELLER), []);
});

test('sellerIssues: كل حقل ناقص يُسمّى بقاعدته ورسالة عربية تذكره', () => {
  const issues = sellerIssues({});
  const byField = new Map(issues.map(i => [i.field, i]));
  assert.equal(byField.get('supplier.registrationName')?.rule, 'BR-06');
  assert.equal(byField.get('supplier.vatNumber')?.rule, 'BR-KSA-39');
  assert.equal(byField.get('supplier.otherId.value')?.rule, 'BR-KSA-08');
  assert.match(byField.get('supplier.address.buildingNumber')!.messageAr, /رقم المبنى/);
  assert.match(byField.get('supplier.address.postalZone')!.messageAr, /الرمز البريدي/);
  assert.match(byField.get('supplier.address.district')!.messageAr, /الحي/);
  assert.ok(issues.every(i => i.severity === 'error'));
  assert.ok(issues.every(i => /[\u0600-\u06FF]/.test(i.messageAr)), 'الرسائل بالعربية');
});

test('sellerIssues: صيغ خاطئة ⇒ BR-KSA-40/37/66 ومخطط معرّف غير مسموح', () => {
  const issues = sellerIssues({
    ...GOOD_SELLER,
    vatNumber: '123456789012345',
    otherId: { scheme: 'NAT', value: '10100 10000' },
    address: { ...GOOD_SELLER.address, buildingNumber: '23', postalZone: '1234' },
  });
  assert.deepEqual(rules(issues), ['BR-KSA-08', 'BR-KSA-08', 'BR-KSA-37', 'BR-KSA-40', 'BR-KSA-66']);
});

test('sellerIssues: اسم أطول من 127 بايت تحذير، وأطول من 255 بايت خطأ (وسم QR 1)', () => {
  const name128 = 'ش'.repeat(64);  // 128 بايت
  const warnOnly = sellerIssues({ ...GOOD_SELLER, registrationName: name128 });
  assert.deepEqual(warnOnly.map(i => [i.rule, i.severity]), [['QR-TAG1-LENGTH', 'warning']]);
  assert.deepEqual(sellerIssues({ ...GOOD_SELLER, registrationName: 'ش'.repeat(63) + 'a' }), [], '127 بايت بلا تحذير');
  const tooLong = sellerIssues({ ...GOOD_SELLER, registrationName: 'ش'.repeat(128) }); // 256 بايت
  assert.deepEqual(tooLong.map(i => [i.rule, i.severity]), [['QR-TAG1-LENGTH', 'error']]);
});

test('buyerIssues(standard): مشترٍ مكتمل بلا مخالفات، وبلا رقم ضريبي يكفيه سجل تجاري', () => {
  assert.deepEqual(buyerIssues('standard', GOOD_BUYER), []);
  assert.deepEqual(buyerIssues('standard', { ...GOOD_BUYER, vatNumber: undefined, otherId: { scheme: 'CRN', value: '2050012345' } }), []);
});

test('buyerIssues(standard): بلا رقم ضريبي ولا معرّف ⇒ BR-KSA-81، وبلا اسم ⇒ BR-KSA-42', () => {
  const issues = buyerIssues('standard', { ...GOOD_BUYER, vatNumber: undefined, registrationName: '  ' });
  assert.deepEqual(rules(issues), ['BR-KSA-42', 'BR-KSA-81']);
  assert.match(issues.find(i => i.rule === 'BR-KSA-81')!.messageAr, /السجل التجاري/);
});

test('buyerIssues(standard): عنوان سعودي ناقص ⇒ BR-KSA-10/63/67 بأسماء الحقول', () => {
  const issues = buyerIssues('standard', { ...GOOD_BUYER, address: { country: 'SA', city: 'الدمام', postalZone: '319' } });
  const fields = issues.map(i => `${i.rule}:${i.field}`).sort();
  assert.deepEqual(fields, [
    'BR-KSA-10:customer.address.street',
    'BR-KSA-63:customer.address.buildingNumber',
    'BR-KSA-63:customer.address.district',
    'BR-KSA-67:customer.address.postalZone',
  ]);
});

test('buyerIssues(standard): عنوان خارج السعودية لا يُطالب برقم المبنى والرمز البريدي', () => {
  const issues = buyerIssues('standard', { registrationName: 'Gulf Co', otherId: { scheme: 'OTH', value: 'X123' }, address: { street: 'Main', city: 'Dubai', country: 'AE' } });
  assert.deepEqual(issues, []);
});

test('buyerIssues(simplified): الاسم وحده يكفي؛ الطرف الفارغ تماماً يُمنع؛ الرقم الضريبي الخاطئ يُمنع', () => {
  assert.deepEqual(buyerIssues('simplified', { registrationName: 'محمد' }), []);
  assert.deepEqual(rules(buyerIssues('simplified', {})), ['BR-KSA-F-03']);
  assert.deepEqual(rules(buyerIssues('simplified', { registrationName: 'محمد', vatNumber: '12' })), ['BR-KSA-44']);
  assert.deepEqual(rules(buyerIssues('simplified', { registrationName: 'محمد', otherId: { scheme: 'XYZ', value: '1' } })), ['BR-KSA-14']);
});

test('رمز الدولة (BR-CL-14): KSA أو اسم الدولة يُرفض بدل تخطّي قواعد العنوان السعودي بصمت؛ والبائع SA وحده', () => {
  assert.equal(isCountryCode('SA'), true);
  assert.equal(isCountryCode('AE'), true);
  for (const bad of ['KSA', 'sa', 'Saudi', 'السعودية', 'S', '', undefined]) assert.equal(isCountryCode(bad), false, String(bad));
  const ksa = buyerIssues('standard', { ...GOOD_BUYER, address: { street: 'شارع فهد', city: 'الدمام', country: 'KSA' } });
  assert.deepEqual(ksa.map(i => `${i.rule}:${i.field}`), ['BR-CL-14:customer.address.country']);
  assert.match(ksa[0].messageAr, /KSA/);
  assert.deepEqual(rules(buyerIssues('simplified', { registrationName: 'محمد', address: { country: 'Saudi' } })), ['BR-CL-14']);
  const sellerKsa = sellerIssues({ ...GOOD_SELLER, address: { ...GOOD_SELLER.address, country: 'KSA' } });
  assert.deepEqual(sellerKsa.map(i => `${i.rule}:${i.field}`), ['BR-CL-14:supplier.address.country']);
  const sellerAe = sellerIssues({ ...GOOD_SELLER, address: { ...GOOD_SELLER.address, country: 'AE' } });
  assert.deepEqual(sellerAe.map(i => `${i.rule}:${i.field}`), ['ZATCA_SELLER_COUNTRY:supplier.address.country']);
  assert.match(sellerAe[0].messageAr, /SA/);
});

test('sanitizeText وcharLength: محارف التحكّم تُحذف والأسطر LF والطول بنقاط يونيكود؛ ونصّ من محارف تحكّم فقط فارغ', () => {
  const C1 = String.fromCharCode(1), CRLF = String.fromCharCode(13, 10), LF = String.fromCharCode(10);
  assert.equal(sanitizeText(`أ${C1}${CRLF}ب`), `أ${LF}ب`);
  assert.equal(charLength('🚚ش'), 2);
  assert.equal(charLength(String.fromCharCode(0xd800)), 1, 'البديل المنفرد محرف واحد');
  assert.equal(charLength('ش'.repeat(1000)), 1000);
  assert.deepEqual(rules(sellerIssues({ ...GOOD_SELLER, registrationName: C1 })), ['BR-06']);
  assert.deepEqual(rules(buyerIssues('standard', { ...GOOD_BUYER, registrationName: `${C1} ` })), ['BR-KSA-42']);
  assert.deepEqual(rules(buyerIssues('simplified', { registrationName: C1 })), ['BR-KSA-F-03']);
});

test('اسم العميل حتى 1000 حرف في النوعين (BR-KSA-F-06)', () => {
  assert.deepEqual(buyerIssues('standard', { ...GOOD_BUYER, registrationName: 'ش'.repeat(1000) }), []);
  const long = buyerIssues('standard', { ...GOOD_BUYER, registrationName: 'ش'.repeat(1001) });
  assert.deepEqual(long.map(i => `${i.rule}:${i.field}`), ['BR-KSA-F-06:customer.registrationName']);
  assert.deepEqual(rules(buyerIssues('simplified', { registrationName: 'ش'.repeat(1001) })), ['BR-KSA-F-06']);
});
