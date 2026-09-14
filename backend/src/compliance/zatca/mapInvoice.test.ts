import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapInvoiceToUbl, buildSnapshot, classifySubtype, paymentMeansCodeFor, resolveVatCategory, preflightKindOf, InvoiceSource,
} from './mapInvoice';
import { computeUblAmounts } from './amounts';
import { ZatcaInputError } from './model';
import { preflightIssues } from './preflight';
import { serializeUnsigned } from './ubl';
import {
  SELLER, BUSINESS_BUYER, WALK_IN_BUYER, SIMPLIFIED_INVOICE, STANDARD_INVOICE, STANDARD_CREDIT_NOTE, SIMPLIFIED_DEBIT_NOTE, chainFor,
} from './__fixtures__/z1-sources';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('النوع الفرعي: نوع المشتري أولاً، ثم الرقم الضريبي/السجل التجاري ما دام غير مصنَّف', () => {
  assert.equal(classifySubtype({ buyerType: 'BUSINESS' }), '01');
  assert.equal(classifySubtype({ buyerType: 'government' }), '01');
  assert.equal(classifySubtype({ buyerType: 'INDIVIDUAL', taxNumber: '311111111111113' }), '02', 'الفرد يبقى مبسطاً ولو أدخل رقماً');
  assert.equal(classifySubtype({ buyerType: null, taxNumber: '311111111111113' }), '01');
  assert.equal(classifySubtype({ buyerType: null, commercialReg: '2050012345' }), '01');
  assert.equal(classifySubtype({ buyerType: null, taxNumber: '   ', commercialReg: '' }), '02');
  assert.equal(classifySubtype({ buyerType: 'UNKNOWN_VALUE' }), '02');
});

test('النوع الفرعي المجمَّد يغلب الاستنتاج (الإشعار يرث نوع أصله)', () => {
  const src = clone(SIMPLIFIED_DEBIT_NOTE);
  src.buyer = BUSINESS_BUYER; // مشترٍ منشأة، لكن الأصل مبسط
  const doc = mapInvoiceToUbl(src, chainFor(9));
  assert.equal(doc.typeName, '0200000');
  assert.equal(preflightKindOf(doc), 'simplified');
  assert.deepEqual(Object.keys(doc.customer), ['registrationName'], 'طرف المبسطة: الاسم فقط');
});

test('رمز النوع والتصنيف لكل نوع مستند', () => {
  const kinds: Array<[InvoiceSource, string, string]> = [
    [SIMPLIFIED_INVOICE, '388', '0200000'], [STANDARD_INVOICE, '388', '0100000'],
    [STANDARD_CREDIT_NOTE, '381', '0100000'], [SIMPLIFIED_DEBIT_NOTE, '383', '0200000'],
  ];
  for (const [src, code, name] of kinds) {
    const doc = mapInvoiceToUbl(src, chainFor(1));
    assert.equal(doc.typeCode, code);
    assert.equal(doc.typeName, name);
    assert.equal(doc.typeName.length, 7);
  }
});

test('IssueDate/IssueTime من وقت الخادم بتوقيت الرياض، وقيم السلسلة تُنسخ كما هي', () => {
  const doc = mapInvoiceToUbl(SIMPLIFIED_INVOICE, { icv: 42, pih: 'abc=', uuid: 'u-1', issuedAt: new Date('2026-09-13T21:30:00Z') });
  assert.equal(doc.issueDate, '2026-09-14');
  assert.equal(doc.issueTime, '00:30:00');
  assert.equal(doc.supplyDate, '2026-09-14', 'بلا تاريخ توريد ⇒ تاريخ الإصدار (الرياض)');
  assert.deepEqual([doc.icv, doc.pih, doc.uuid], [42, 'abc=', 'u-1']);
});

test('تاريخ التوريد: نص تاريخ فقط يُكتب حرفياً، وDate/ISO يُحوَّل لتاريخ الرياض، والتالف يُرفض', () => {
  const at = (supplyDate: InvoiceSource['supplyDate']) => mapInvoiceToUbl({ ...STANDARD_INVOICE, supplyDate }, chainFor(2)).supplyDate;
  assert.equal(at('2026-09-01'), '2026-09-01');
  assert.equal(at(new Date('2026-08-31T22:00:00Z')), '2026-09-01');
  assert.equal(at('2026-08-31T22:00:00.000Z'), '2026-09-01');
  assert.equal(at(null), '2026-09-14');
  assert.throws(() => at('01/09/2026'), (e: unknown) => e instanceof ZatcaInputError && e.issues[0].rule === 'BR-KSA-F-01');
  assert.throws(() => at('2026-02-30'), ZatcaInputError);
});

test('تاريخ التوريد بتاريخ ووقت: الإزاحة الصريحة شرط (بلا إزاحة يتغيّر اليوم بمنطقة الخادم)، والنتيجة ثابتة عبر TZ', () => {
  const at = (supplyDate: InvoiceSource['supplyDate']) => mapInvoiceToUbl({ ...STANDARD_INVOICE, supplyDate }, chainFor(2)).supplyDate;
  const saved = process.env.TZ;
  try {
    const seen = new Set<string>();
    const localParse = new Set<number>();
    for (const tz of ['UTC', 'Asia/Riyadh', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      localParse.add(Date.parse('2026-09-13T23:30:00'));
      assert.throws(() => at('2026-09-13T23:30:00'), (e: unknown) => e instanceof ZatcaInputError && e.issues[0].rule === 'BR-KSA-F-01', tz);
      seen.add([at('2026-09-13T23:30:00+03:00'), at('2026-09-13T20:30:00Z'), at('2026-09-13T21:30:00.000Z'), at('2026-09-13T23:30+03:00')].join(' '));
    }
    assert.ok(localParse.size > 1, 'تبديل TZ يغيّر تفسير النص بلا إزاحة فعلاً — وإلا فالاختبار بلا معنى');
    assert.deepEqual([...seen], ['2026-09-13 2026-09-13 2026-09-14 2026-09-13']);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
  assert.throws(() => at('2026-02-30T10:00:00Z'), ZatcaInputError, 'Date.parse يقلبه إلى مارس بصمت');
  assert.throws(() => at('2026-09-13T10:00:00+0300'), ZatcaInputError);
});

test('المبسطة: المعرّف الآخر يُكتب فقط إن أُدخل صريحاً بنوعه وقيمته — بلا عنوان ولا رقم ضريبي ولا CRN مستنتج', () => {
  const nat = mapInvoiceToUbl({ ...SIMPLIFIED_INVOICE, buyer: { ...WALK_IN_BUYER, buyerIdScheme: 'nat', buyerIdValue: ' 1012345678 ' } }, chainFor(1));
  assert.deepEqual(nat.customer, { registrationName: 'محمد عبدالله', otherId: { scheme: 'NAT', value: '1012345678' } });
  const xml = serializeUnsigned(nat);
  const block = xml.slice(xml.indexOf('<cac:AccountingCustomerParty>'), xml.indexOf('</cac:AccountingCustomerParty>'));
  assert.ok(block.includes('<cac:PartyIdentification>') && block.includes('<cbc:ID schemeID="NAT">1012345678</cbc:ID>'));
  assert.ok(block.indexOf('PartyIdentification') < block.indexOf('PartyLegalEntity'));
  assert.equal(block.includes('PostalAddress'), false);
  const inferred = mapInvoiceToUbl({ ...SIMPLIFIED_INVOICE, buyer: { ...WALK_IN_BUYER, commercialReg: '2050012345', taxNumber: '311111111111113', buyerIdScheme: 'NAT' } }, chainFor(1));
  assert.deepEqual(inferred.customer, { registrationName: 'محمد عبدالله' }, 'نوع بلا قيمة، وسجل تجاري بلا نوع صريح: لا معرّف');
});

test('النصوص تُطبَّع عند البناء: النموذج واللقطة والـXML تحمل النص نفسه (بلا محارف تحكّم وبأسطر LF)', () => {
  const C1 = String.fromCharCode(1), CRLF = String.fromCharCode(13, 10), LF = String.fromCharCode(10);
  const doc = mapInvoiceToUbl({
    ...SIMPLIFIED_INVOICE,
    seller: { ...SELLER, legalName: `شركة${CRLF}التوزيع${C1}` },
    items: SIMPLIFIED_INVOICE.items.map((it, i) => (i === 0 ? { ...it, itemName: ` مياه${C1} ` } : it)),
  }, chainFor(1));
  assert.equal(doc.supplier.registrationName, `شركة${LF}التوزيع`);
  assert.equal(doc.lines[0].name, 'مياه');
  assert.equal(buildSnapshot(doc).supplier.registrationName, doc.supplier.registrationName, 'اللقطة = النموذج');
  const xml = serializeUnsigned(doc);
  assert.ok(xml.includes(`<cbc:RegistrationName>${doc.supplier.registrationName}</cbc:RegistrationName>`), 'الـXML = النموذج');
  assert.ok(xml.includes('<cbc:Name>مياه</cbc:Name>'));
  assert.deepEqual(preflightIssues(doc, 'simplified'), []);
  assert.throws(() => mapInvoiceToUbl({ ...SIMPLIFIED_INVOICE, items: [{ ...SIMPLIFIED_INVOICE.items[0], taxPct: 0, vatCategory: C1 }] }, chainFor(1)),
    (e: unknown) => e instanceof ZatcaInputError && /غير محددة/.test(e.issues[0].messageAr), 'فئة من محرف تحكّم فقط = غير محددة');
});

test('طريقة الدفع: CASH ⇒ 10 ، CREDIT/INSTALLMENT ⇒ 30 ، وغير المعروف لا يُكتب', () => {
  assert.equal(paymentMeansCodeFor('CASH'), '10');
  assert.equal(paymentMeansCodeFor('credit'), '30');
  assert.equal(paymentMeansCodeFor('INSTALLMENT'), '30');
  assert.equal(paymentMeansCodeFor(null), undefined);
  assert.equal(paymentMeansCodeFor('RETURN'), undefined);
  assert.equal('paymentMeansCode' in mapInvoiceToUbl({ ...SIMPLIFIED_INVOICE, paymentType: null }, chainFor(1)), false);
});

test('الإشعار يحمل المراجع والسبب منظّفة؛ الفاتورة تتجاهلهما', () => {
  const note = mapInvoiceToUbl({ ...STANDARD_CREDIT_NOTE, billingReferences: [' INV-1 ', '', '  ', 'INV-2'], noteReason: '  تالف  ' }, chainFor(3));
  assert.deepEqual(note.billingReferences, ['INV-1', 'INV-2']);
  assert.equal(note.instructionNote, 'تالف');
  const inv = mapInvoiceToUbl({ ...STANDARD_INVOICE, billingReferences: ['INV-9'], noteReason: 'لا يخصّ الفاتورة' }, chainFor(2));
  assert.equal(inv.billingReferences, undefined);
  assert.equal(inv.instructionNote, undefined);
});

test('البنود: ترقيم 1..n بترتيب الإرسال، unitCode الافتراضي PCE، والاسم منظّف', () => {
  const src = clone(SIMPLIFIED_INVOICE);
  src.items = [
    { itemName: '  ج  ', unitCode: '', qty: 1, unitPrice: 3, discountPct: 0, taxPct: 15 },
    { itemName: 'أ', unitCode: 'KGM', qty: 1, unitPrice: 1, discountPct: 0, taxPct: 15 },
    { itemName: 'ب', qty: 1, unitPrice: 2, discountPct: 0, taxPct: 15 },
  ];
  const doc = mapInvoiceToUbl(src, chainFor(1));
  assert.deepEqual(doc.lines.map(l => [l.id, l.name, l.unitCode]), [[1, 'ج', 'PCE'], [2, 'أ', 'KGM'], [3, 'ب', 'PCE']]);
});

test('البائع: المعرّف الافتراضي CRN من السجل التجاري، والمخطط الصريح يغلب، ولا بديل للاسم القانوني الناقص', () => {
  const doc = mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2));
  assert.deepEqual(doc.supplier.otherId, { scheme: 'CRN', value: '1010010000' });
  assert.deepEqual(doc.supplier.address, {
    street: 'طريق الأمير سلطان', buildingNumber: '2322', district: 'المحمدية', city: 'الرياض', postalZone: '12345', country: 'SA', additionalNumber: '1234',
  });
  const mom = mapInvoiceToUbl({ ...STANDARD_INVOICE, seller: { ...SELLER, sellerIdScheme: 'mom', sellerIdValue: '7001234567' } }, chainFor(2));
  assert.deepEqual(mom.supplier.otherId, { scheme: 'MOM', value: '7001234567' });
  const noLegal = mapInvoiceToUbl({ ...STANDARD_INVOICE, seller: { ...SELLER, legalName: '  ' } }, chainFor(2));
  assert.equal(noLegal.supplier.registrationName, undefined, 'الاسم التجاري لا يُنتحل اسماً قانونياً');
});

test('المشتري في الضريبية: اسم المنشأة أولاً، والسجل التجاري CRN، والمخطط الصريح (NAT) يغلب، والعنوان من الحيّ والمدينة', () => {
  const doc = mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2));
  assert.equal(doc.customer.registrationName, 'مؤسسة البقالة الحديثة للتجارة');
  assert.equal(doc.customer.vatNumber, '311111111111113');
  assert.deepEqual(doc.customer.otherId, { scheme: 'CRN', value: '2050012345' });
  assert.equal(doc.customer.address?.district, 'الروضة');
  assert.equal(doc.customer.address?.postalZone, '31952');
  const nat = mapInvoiceToUbl({ ...STANDARD_INVOICE, buyer: { ...BUSINESS_BUYER, taxNumber: null, buyerIdScheme: 'NAT', buyerIdValue: '1012345678' } }, chainFor(2));
  assert.deepEqual(nat.customer.otherId, { scheme: 'NAT', value: '1012345678' });
  assert.equal(nat.customer.vatNumber, undefined);
  const simp = mapInvoiceToUbl({ ...SIMPLIFIED_INVOICE, buyer: { ...WALK_IN_BUYER, businessName: '' } }, chainFor(1));
  assert.deepEqual(simp.customer, { registrationName: 'محمد عبدالله' });
});

test('الفئة الضريبية: الفارغة مع نسبة > 0 ⇒ S، والصغيرة تُكبَّر، والفارغة مع 0% ترمي BR-KSA-18 باسم الصنف', () => {
  assert.equal(resolveVatCategory(null, 15), 'S');
  assert.equal(resolveVatCategory(' z ', 0), 'Z');
  assert.equal(resolveVatCategory(null, 0), null);
  assert.equal(resolveVatCategory('X', 15), null);
  const src = clone(SIMPLIFIED_INVOICE);
  src.items.push({ itemName: 'خبز', qty: 1, unitPrice: 1, discountPct: 0, taxPct: 0 });
  src.items.push({ itemName: 'حليب', qty: 1, unitPrice: 1, discountPct: 0, taxPct: 0, vatCategory: 'Q' });
  assert.throws(() => mapInvoiceToUbl(src, chainFor(1)), (e: unknown) => {
    assert.ok(e instanceof ZatcaInputError);
    assert.deepEqual(e.issues.map(i => [i.rule, i.field]), [['BR-KSA-18', 'items[2].vatCategory'], ['BR-KSA-18', 'items[3].vatCategory']]);
    assert.match(e.issues[0].messageAr, /خبز/);
    assert.match(e.issues[0].messageAr, /غير محددة/);
    assert.match(e.issues[1].messageAr, /غير صالحة/);
    return true;
  });
});

test('رمز الإعفاء: يُحذف من بنود S، ويُنقل من أول بند صفري إلى تفصيل الفئة', () => {
  const src = clone(STANDARD_INVOICE);
  src.items[0].vatExemptionCode = 'VATEX-SA-35'; // بند S بخطأ بيانات قديم
  const doc = mapInvoiceToUbl(src, chainFor(2));
  assert.equal(doc.lines[0].vat.exemptionCode, undefined);
  assert.deepEqual(doc.lines[2].vat, { category: 'Z', percent: '0.00', exemptionCode: 'VATEX-SA-35', exemptionReason: 'Medicines and medical equipment | الأدوية والمعدات الطبية' });
  const z = doc.subtotals.find(s => s.category === 'Z')!;
  assert.equal(z.exemptionCode, 'VATEX-SA-35');
  assert.equal(doc.subtotals.find(s => s.category === 'S')!.exemptionCode, undefined);
});

test('المبالغ في المستند هي ناتج computeUblAmounts نفسه، والعملة مُطبَّعة', () => {
  const doc = mapInvoiceToUbl({ ...STANDARD_INVOICE, currency: ' sar ' }, chainFor(2));
  const amounts = computeUblAmounts({
    pricesIncludeTax: false, invoiceDiscountPct: 5,
    lines: STANDARD_INVOICE.items.map(i => ({ qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct ?? 0, vatPct: i.taxPct, category: (i.vatCategory as 'Z') ?? 'S' })),
  });
  assert.equal(doc.currency, 'SAR');
  assert.deepEqual(doc.totals, amounts.totals);
  assert.deepEqual(doc.docAllowances, amounts.docAllowances);
  assert.deepEqual(doc.lines.map(l => l.lineExtension), amounts.lines.map(l => l.lineExtension));
});

test('خصم فاتورة على أسعار شاملة يمرّ خطأً صريحاً من المحوّل', () => {
  assert.throws(() => mapInvoiceToUbl({ ...SIMPLIFIED_INVOICE, invoiceDiscountPct: 3 }, chainFor(1)),
    (e: unknown) => e instanceof ZatcaInputError && e.code === 'INCLUSIVE_HEAD_DISCOUNT');
});

test('اللقطة: نسخة JSON عميقة بلا قيم السلسلة، ثابتة عبر محاولات الإصدار، وتحفظ ما كُتب في الـXML', () => {
  const a = mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2));
  const b = mapInvoiceToUbl(STANDARD_INVOICE, { ...chainFor(7, 'Hss2gNFjBY5OJn/5CEVZSSNUMrSf4QlCMxwsioPN6fA='), uuid: 'another-uuid' });
  const snap = buildSnapshot(a);
  assert.deepEqual(snap, buildSnapshot(b), 'uuid/icv/pih لا تدخل اللقطة');
  assert.equal(snap.v, 1);
  assert.equal(snap.currency, 'SAR');
  assert.equal(snap.subtype, '01');
  for (const k of ['uuid', 'icv', 'pih']) assert.equal(k in snap, false, k);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  assert.equal(snap.totals.payable, a.totals.payable);
  assert.deepEqual(snap.customer, a.customer);
  snap.lines[0].name = 'تعديل';
  assert.notEqual(a.lines[0].name, 'تعديل', 'اللقطة لا تشارك المراجع مع المستند');
  assert.deepEqual(Object.keys(snap).slice(0, 4), ['v', 'currency', 'id', 'issueDate'], 'ترتيب مفاتيح ثابت');
});
