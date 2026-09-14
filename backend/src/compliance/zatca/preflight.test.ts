import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightIssues, hasBlockingIssues } from './preflight';
import { mapInvoiceToUbl, preflightKindOf, InvoiceSource } from './mapInvoice';
import { UblDocument } from './model';
import {
  SELLER, BUSINESS_BUYER, WALK_IN_BUYER, SIMPLIFIED_INVOICE, STANDARD_INVOICE, STANDARD_CREDIT_NOTE, SIMPLIFIED_DEBIT_NOTE, chainFor,
} from './__fixtures__/z1-sources';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const build = (src: InvoiceSource, icv = 1) => mapInvoiceToUbl(src, chainFor(icv));
const run = (doc: UblDocument) => preflightIssues(doc, preflightKindOf(doc));
const errors = (doc: UblDocument) => run(doc).filter(i => i.severity === 'error');
const errRules = (doc: UblDocument) => [...new Set(errors(doc).map(i => i.rule))].sort();

/** يطبّق تعديلاً على نسخة ويتحقق أن المخالفات الجديدة هي بالضبط المتوقعة. */
function expectOnly(doc: UblDocument, mutate: (d: UblDocument) => void, rules: string[], fieldRe?: RegExp) {
  const d = clone(doc);
  mutate(d);
  const issues = errors(d);
  assert.deepEqual([...new Set(issues.map(i => i.rule))].sort(), [...rules].sort(), JSON.stringify(issues, null, 1));
  if (fieldRe) assert.ok(issues.some(i => fieldRe.test(i.field)), `حقل متوقع ${fieldRe}: ${issues.map(i => i.field)}`);
  assert.ok(issues.every(i => /[\u0600-\u06FF]/.test(i.messageAr)), 'رسائل عربية');
  return issues;
}

const STD = build(STANDARD_INVOICE, 2);
const SIMP = build(SIMPLIFIED_INVOICE, 1);
const CN = build(STANDARD_CREDIT_NOTE, 3);
const DN = build(SIMPLIFIED_DEBIT_NOTE, 4);

test('المستندات المرجعية الأربعة بلا أي مخالفة ولا تحذير', () => {
  for (const doc of [STD, SIMP, CN, DN]) assert.deepEqual(run(doc), [], doc.id);
});

test('البائع: رقم المبنى والرمز البريدي والرقم الضريبي والحيّ (BR-KSA-37/66/40/09)', () => {
  expectOnly(STD, d => { d.supplier.address!.buildingNumber = '23'; }, ['BR-KSA-37'], /supplier\.address\.buildingNumber/);
  expectOnly(STD, d => { d.supplier.address!.postalZone = '1234'; }, ['BR-KSA-66']);
  expectOnly(SIMP, d => { d.supplier.vatNumber = '399999999900004'; }, ['BR-KSA-40'], /supplier\.vatNumber/);
  const i = expectOnly(SIMP, d => { d.supplier.address!.district = ''; }, ['BR-KSA-09']);
  assert.match(i[0].messageAr, /الحي/);
});

test('المشتري في الضريبية: BR-KSA-81 بلا رقم ولا معرّف، BR-KSA-63/67 للعنوان، BR-KSA-44 للصيغة', () => {
  const noId = expectOnly(STD, d => { delete d.customer.vatNumber; delete d.customer.otherId; }, ['BR-KSA-81']);
  assert.match(noId[0].messageAr, /السجل التجاري/);
  expectOnly(STD, d => { d.customer.address!.postalZone = '3195'; }, ['BR-KSA-67']);
  expectOnly(STD, d => { d.customer.address!.buildingNumber = ''; }, ['BR-KSA-63'], /customer\.address\.buildingNumber/);
  expectOnly(STD, d => { d.customer.vatNumber = '31111111111111'; }, ['BR-KSA-44']);
  expectOnly(STD, d => { d.customer.registrationName = ''; }, ['BR-KSA-42']);
});

test('رمز دولة غير صالح (KSA) عبر المحوّل: BR-CL-14 بدل تخطّي BR-KSA-63 بصمت؛ ودولة أجنبية صالحة بلا قواعد سعودية', () => {
  const noSaudiParts = { ...BUSINESS_BUYER, addrBuildingNo: null, addrPostalCode: null, district: null };
  const ksa = errors(build({ ...STANDARD_INVOICE, buyer: { ...noSaudiParts, countryCode: 'KSA' } }, 2));
  assert.deepEqual(ksa.map(i => [i.rule, i.field]), [['BR-CL-14', 'customer.address.country']]);
  assert.deepEqual(errRules(build({ ...STANDARD_INVOICE, buyer: { ...noSaudiParts, countryCode: 'SA' } }, 2)), ['BR-KSA-63']);
  assert.deepEqual(errRules(build({ ...STANDARD_INVOICE, buyer: { ...noSaudiParts, countryCode: 'ae' } }, 2)), []);
  assert.deepEqual(errRules(build({ ...STANDARD_INVOICE, seller: { ...SELLER, countryCode: 'KSA' } }, 2)), ['BR-CL-14']);
});

test('المشتري نفسه على فاتورة مبسطة لا يُطالَب بالعنوان (الاسم يكفي)', () => {
  const src = clone(SIMPLIFIED_INVOICE);
  src.buyer = { ...BUSINESS_BUYER, buyerType: 'INDIVIDUAL', addrBuildingNo: null, addrPostalCode: null };
  assert.deepEqual(errors(build(src)), []);
  expectOnly(SIMP, d => { d.customer = {}; }, ['BR-KSA-F-03']);
});

test('الإشعارات: BR-KSA-56 بلا مرجع الفاتورة الأصلية، BR-KSA-17 بلا سبب، BR-49 بلا طريقة دفع', () => {
  expectOnly(CN, d => { d.billingReferences = []; }, ['BR-KSA-56']);
  expectOnly(DN, d => { d.billingReferences = ['  ']; }, ['BR-KSA-56']);
  expectOnly(CN, d => { delete d.instructionNote; }, ['BR-KSA-17'], /instructionNote/);
  expectOnly(DN, d => { delete d.paymentMeansCode; }, ['BR-49']);
  // عبر المحوّل: إشعار بلا مراجع ولا سبب
  assert.deepEqual(errRules(build({ ...STANDARD_CREDIT_NOTE, billingReferences: null, noteReason: null }, 3)), ['BR-KSA-17', 'BR-KSA-56']);
});

test('تاريخ التوريد إلزامي في 388 الضريبية فقط (BR-KSA-15)', () => {
  expectOnly(STD, d => { delete d.supplyDate; }, ['BR-KSA-15']);
  const s = clone(SIMP); delete s.supplyDate;
  assert.deepEqual(errors(s), []);
  const c = clone(CN); delete c.supplyDate;
  assert.deepEqual(errors(c), [], 'الإشعار الدائن ليس 388');
  expectOnly(STD, d => { d.supplyDate = '2026-13-01'; }, ['BR-KSA-F-01']);
});

test('الفئات والنِّسب والإعفاء: BR-KSA-18/84/23/24/CL-04 وBR-S-10 وBR-Z-05', () => {
  // البند يخرج من سلة S فتختلّ أيضاً مطابقة وعائها لبنودها (BR-S-08) ولا تفصيل لفئته (BR-CO-18)
  expectOnly(SIMP, d => { d.lines[0].vat.category = 'X' as 'S'; }, ['BR-KSA-18', 'BR-CO-18', 'BR-S-08'], /lines\[0\]\.vat\.category/);
  const r84 = clone(SIMP);
  r84.lines.forEach(l => { l.vat.percent = '7.00'; });
  r84.subtotals[0].percent = '7.00';
  r84.subtotals[0].tax = '2.50';           // 35.69 × 7% = 2.4983 ⇒ 2.50 (تبقى BR-CO-17 سليمة)
  r84.totals.taxTotal = '2.50';
  r84.totals.taxInclusive = '38.19';
  r84.totals.payable = '38.20';
  assert.deepEqual(errRules(r84), ['BR-KSA-84']);
  expectOnly(STD, d => { d.lines[2].vat.exemptionCode = undefined; }, ['BR-KSA-23'], /lines\[2\]\.vat\.exemptionCode/);
  expectOnly(STD, d => { d.subtotals[1].exemptionReason = undefined; }, ['BR-KSA-24'], /subtotals\[1\]/);
  expectOnly(STD, d => { d.lines[2].vat.exemptionCode = 'VATEX-SA-29'; }, ['BR-KSA-CL-04', 'BR-KSA-23'], /lines\[2\]/); // رمز E على بند Z + يخالف رمز التفصيل
  expectOnly(STD, d => { d.lines[0].vat.exemptionCode = 'VATEX-SA-35'; }, ['BR-S-10']);
  expectOnly(STD, d => { d.lines[2].vat.percent = '5.00'; }, ['BR-Z-05', 'BR-CO-18']);
  expectOnly(STD, d => { d.lines[2].vat.exemptionCode = 'VATEX-SA-ROYALDECREE'; }, ['BR-KSA-CL-04', 'BR-KSA-23']);
});

test('رموز إعفاء مختلفة داخل فئة واحدة تُمنع، وإعفاء التعليم/الصحة يتطلب هوية وطنية (BR-KSA-49)', () => {
  const src = clone(STANDARD_INVOICE);
  src.items.push({ itemName: 'كتب مدرسية', qty: 1, unitPrice: 10, discountPct: 0, taxPct: 0, vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-EDU', vatExemptionReason: 'Private education to citizen' });
  const issues = errors(build(src, 2));
  assert.ok(issues.some(i => i.rule === 'BR-KSA-23' && /رموز إعفاء مختلفة/.test(i.messageAr)), JSON.stringify(issues));
  const edu = clone(STANDARD_INVOICE);
  edu.items[2] = { ...edu.items[2], vatExemptionCode: 'VATEX-SA-EDU', vatExemptionReason: 'Private education to citizen' };
  assert.deepEqual(errRules(build(edu, 2)), ['BR-KSA-49']);
  edu.buyer = { ...BUSINESS_BUYER, buyerIdScheme: 'NAT', buyerIdValue: '1012345678' };
  assert.deepEqual(errRules(build(edu, 2)), []);
});

test('إعفاء الصحة/التعليم على فاتورة مبسطة لفرد: هويته الوطنية تُكتب فتمرّ، وبلا هوية BR-KSA-49، وبلا اسم BR-KSA-25', () => {
  const hea = clone(SIMPLIFIED_INVOICE);
  hea.buyer = { ...WALK_IN_BUYER, buyerIdScheme: 'NAT', buyerIdValue: '1012345678' };
  hea.items.push({ itemName: 'كشف طبي', qty: 1, unitPrice: 150, discountPct: 0, taxPct: 0, vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-HEA', vatExemptionReason: 'Private healthcare to citizen' });
  const doc = build(hea);
  assert.equal(preflightKindOf(doc), 'simplified');
  assert.deepEqual(doc.customer.otherId, { scheme: 'NAT', value: '1012345678' });
  assert.deepEqual(run(doc), []);
  const edu = clone(hea);
  edu.items[2].vatExemptionCode = 'VATEX-SA-EDU';
  assert.deepEqual(run(build(edu)), []);
  assert.deepEqual(errRules(build({ ...hea, buyer: WALK_IN_BUYER })), ['BR-KSA-49']);
  const noName = errors(build({ ...hea, buyer: { buyerType: 'INDIVIDUAL', buyerIdScheme: 'NAT', buyerIdValue: '1012345678' } }));
  assert.deepEqual(noName.map(i => [i.rule, i.field]), [['BR-KSA-25', 'customer.registrationName']]);
  assert.match(noName[0].messageAr, /اسم العميل/);
  // BR-KSA-25 تخصّ المبسطة؛ الضريبية يغطيها BR-KSA-42
  expectOnly(build(edu), d => { d.customer.otherId = { scheme: 'IQA', value: '2012345678' }; }, ['BR-KSA-49']);
});

test('BR-O-13: بنود خارج النطاق (O) مع S وخصم فاتورة تُمنع قبل ICV؛ ومن دون خصم الفاتورة أو بفئة O وحدها تمرّ', () => {
  const oos = { itemName: 'رسوم خدمة حكومية', qty: 1, unitPrice: 50, discountPct: 0, taxPct: 0, vatCategory: 'O', vatExemptionCode: 'VATEX-SA-OOS', vatExemptionReason: 'Government fees collected on behalf' };
  const mixed = { ...clone(STANDARD_INVOICE), items: [{ itemName: 'أرز', unitCode: 'PCE', qty: 1, unitPrice: 100, discountPct: 0, taxPct: 15 }, oos] };
  const withHead = build({ ...mixed, invoiceDiscountPct: 5 }, 2);
  assert.deepEqual(withHead.docAllowances.map(a => [a.category, a.amount]), [['S', '5.00'], ['O', '2.50']]);
  const issues = errors(withHead);
  assert.deepEqual(issues.map(i => [i.rule, i.field]), [['BR-O-13', 'docAllowances[0].category']]);
  assert.match(issues[0].messageAr, /خارج نطاق الضريبة/);
  // O مع S بلا خصم مستند: كعيّنة الـSDK «Out of Scope Standard Tax Invoice»
  assert.deepEqual(run(build({ ...mixed, invoiceDiscountPct: 0 }, 2)), []);
  // O وحدها مع خصم فاتورة: الخصم كله في O
  const onlyO = build({ ...mixed, items: [oos], invoiceDiscountPct: 5 }, 2);
  assert.deepEqual(onlyO.docAllowances.map(a => a.category), ['O']);
  assert.deepEqual(run(onlyO), []);
  // Z مع O وخصم فاتورة: خصم Z يخالف أيضاً
  assert.deepEqual(errRules(build({ ...mixed, items: [STANDARD_INVOICE.items[2], oos], invoiceDiscountPct: 5 }, 2)), ['BR-O-13']);
});

test('BR-KSA-F-06: سبب الإشعار واسم الصنف واسم العميل حتى 1000 حرف (بالمحارف لا بوحدات UTF-16)', () => {
  const at = (n: number) => 'ش'.repeat(n);
  expectOnly(CN, d => { d.instructionNote = at(1001); }, ['BR-KSA-F-06'], /^instructionNote$/);
  assert.deepEqual(errors({ ...clone(CN), instructionNote: at(1000) }), []);
  expectOnly(SIMP, d => { d.lines[0].name = at(1001); }, ['BR-KSA-F-06'], /^lines\[0\]\.name$/);
  assert.deepEqual(errors({ ...clone(SIMP), lines: SIMP.lines.map((l, i) => (i === 0 ? { ...l, name: '🚚'.repeat(1000) } : l)) }), [], '1000 رمز = 2000 وحدة UTF-16 وتبقى ضمن الحدّ');
  expectOnly(STD, d => { d.customer.registrationName = at(1001); }, ['BR-KSA-F-06'], /^customer\.registrationName$/);
  expectOnly(SIMP, d => { d.customer.registrationName = at(1001); }, ['BR-KSA-F-06']);
  // عبر المحوّل: سبب الإشعار الطويل يصل كما هو إلى الفحص
  assert.deepEqual(errRules(build({ ...STANDARD_CREDIT_NOTE, noteReason: at(1001) }, 3)), ['BR-KSA-F-06']);
});

test('النصوص: محارف التحكّم تُحذف عند البناء فيطابق النموذجُ الـXML، وحقل إلزامي من محارف تحكّم فقط يُمنع، والمستند المعدَّل خارج المحوّل يُمسك (XML-TEXT)', () => {
  const C1 = String.fromCharCode(1), C2 = String.fromCharCode(2), CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  // رقم فاتورة من محرف تحكّم فقط ⇒ غائب ⇒ BR-02 (كان يمرّ ويختفي cbc:ID من الـXML)
  assert.deepEqual(errRules(build({ ...SIMPLIFIED_INVOICE, number: C2 })), ['BR-02']);
  // اسم منشأة مشترية من محرف تحكّم فقط على الضريبية ⇒ BR-KSA-42
  assert.deepEqual(errRules(build({ ...STANDARD_INVOICE, buyer: { ...BUSINESS_BUYER, businessName: C1, name: null } }, 2)), ['BR-KSA-42']);
  // تعديل يدوي بعد البناء
  expectOnly(STD, d => { d.lines[0].name = `أرز${C1}`; }, ['XML-TEXT'], /^lines\[0\]\.name$/);
  expectOnly(STD, d => { d.supplier.address!.city = `الرياض${CR}${LF}`; }, ['XML-TEXT'], /^supplier\.address\.city$/);
  expectOnly(STD, d => { d.customer.registrationName = C1; }, ['BR-KSA-42', 'XML-TEXT']);
  expectOnly(SIMP, d => { d.supplier.registrationName = C1; }, ['BR-06', 'XML-TEXT']);
  // LF داخل النص صيغة نهائية مقبولة
  assert.deepEqual(errors({ ...clone(STD), lines: STD.lines.map((l, i) => (i === 0 ? { ...l, name: `أرز${LF}بسمتي` } : l)) }), []);
});

test('بند بقيمة صفرية يُمنع حتى تُحسم U5، والمبالغ السالبة والكمية الصفرية تُمنع (BR-KSA-F-04)', () => {
  const src = clone(SIMPLIFIED_INVOICE);
  src.items[0].unitPrice = 0;
  const issues = errors(build(src));
  assert.deepEqual([...new Set(issues.map(i => i.rule))], ['ZERO-VALUE-LINE']);
  assert.match(issues[0].messageAr, /مياه معدنية/);
  const hundred = clone(STANDARD_INVOICE);
  hundred.items[1].discountPct = 100;
  assert.ok(errRules(build(hundred, 2)).includes('ZERO-VALUE-LINE'), 'خصم 100% = بند صفري');
  expectOnly(SIMP, d => { d.lines[0].quantity = '0.000000'; }, ['BR-KSA-F-04'], /lines\[0\]\.quantity/);
  const neg = expectOnly(SIMP, d => { d.totals.prepaid = '-1.00'; d.totals.payable = '42.05'; }, ['BR-KSA-F-04']);
  assert.equal(neg[0].field, 'totals.prepaid');
});

test('العملة يجب أن تكون SAR (D9)', () => {
  const i = expectOnly(SIMP, d => { d.currency = 'USD'; }, ['ZATCA_CURRENCY']);
  assert.match(i[0].messageAr, /USD/);
  assert.deepEqual(errRules(build({ ...SIMPLIFIED_INVOICE, currency: 'EUR' })), ['ZATCA_CURRENCY']);
});

test('الترويسة: تعارض نوع الفحص مع التصنيف، ICV غير موجب، UUID وPIH غير صالحين', () => {
  assert.deepEqual([...new Set(preflightIssues(STD, 'simplified').filter(i => i.severity === 'error').map(i => i.rule))], ['BR-KSA-06']);
  expectOnly(SIMP, d => { d.icv = 0; }, ['BR-KSA-33']);
  expectOnly(SIMP, d => { d.uuid = 'not a uuid!'; }, ['BR-KSA-03']);
  expectOnly(SIMP, d => { d.pih = ''; }, ['BR-KSA-61']);
  expectOnly(SIMP, d => { d.typeName = '0211010'; }, ['BR-KSA-06']);
  expectOnly(SIMP, d => { d.issueTime = '10:15:30Z'; }, ['BR-KSA-70']);
});

test('الحسابات المُعدَّلة يدوياً تُمسك: BR-CO-10/14/16/17 وBR-KSA-51 والصيغة', () => {
  expectOnly(STD, d => { d.totals.payable = '569.10'; }, ['BR-CO-16'], /totals\.payable/);
  expectOnly(STD, d => { d.subtotals[0].tax = '64.33'; }, ['BR-CO-17', 'BR-CO-14']);
  expectOnly(STD, d => { d.lines[1].roundingAmount = '47.86'; }, ['BR-KSA-51']);
  expectOnly(STD, d => { d.totals.lineExtension = '531.35'; d.totals.taxExclusive = '504.78'; d.totals.taxInclusive = '569.10'; d.totals.payable = '569.10'; }, ['BR-CO-10']);
  expectOnly(STD, d => { d.lines[0].taxAmount = '58.3'; }, ['BR-DEC']);
  expectOnly(STD, d => { d.docAllowances[0].amount = '22.58'; }, ['BR-CO-11', 'BR-S-08']);
  expectOnly(STD, d => { d.lines[0].allowance!.amount = '45.51'; }, ['BR-KSA-EN16931-03']);
});

test('اسم البائع الطويل: تحذير فوق 127 بايت لا يمنع، وخطأ فوق 255 بايت', () => {
  const warn = build({ ...SIMPLIFIED_INVOICE, seller: { ...SELLER, legalName: 'ش'.repeat(64) } });
  const issues = run(warn);
  assert.deepEqual(issues.map(i => [i.rule, i.severity]), [['QR-TAG1-LENGTH', 'warning']]);
  assert.equal(hasBlockingIssues(issues), false);
  const block = build({ ...SIMPLIFIED_INVOICE, seller: { ...SELLER, legalName: 'ش'.repeat(128) } });
  assert.equal(hasBlockingIssues(run(block)), true);
});

test('بيانات بائع ناقصة كلياً تعطي قائمة كاملة بأسماء الحقول بالعربية', () => {
  const doc = build({ ...STANDARD_INVOICE, seller: {} }, 2);
  const fields = errors(doc).map(i => i.field).sort();
  assert.deepEqual(fields, [
    'supplier.address.buildingNumber', 'supplier.address.city', 'supplier.address.district', 'supplier.address.postalZone',
    'supplier.address.street', 'supplier.otherId.value', 'supplier.registrationName', 'supplier.vatNumber',
  ]);
});

test('لا يرمي أبداً على مستند مشوّه — يبلّغ بدلاً من ذلك', () => {
  const garbage = { lines: [{}], subtotals: [{}], totals: {}, supplier: {}, customer: {} } as unknown as UblDocument;
  let issues: ReturnType<typeof preflightIssues> = [];
  assert.doesNotThrow(() => { issues = preflightIssues(garbage, 'standard'); });
  assert.ok(hasBlockingIssues(issues));
  assert.ok(issues.length > 20);
});
