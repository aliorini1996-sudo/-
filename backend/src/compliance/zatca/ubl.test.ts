// اختبارات المُسلسِل: ترتيب العناصر (design §4.2 C-O1/C-O2 + ترتيب XSD المتداخل)، ثبات البايتات،
// قالب التوقيع، التهريب، وثبات كل ما خارج الكتل الثلاث المحذوفة قبل التجزئة.
// لتحديث اللقطات عمداً بعد مراجعة الفرق: UPDATE_ZATCA_FIXTURES=1 ثم حدّث قيم SHA-256 أدناه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { mapInvoiceToUbl } from './mapInvoice';
import { serializeUnsigned, escapeText, ROOT_OPEN, XML_DECLARATION } from './ubl';
import { UblDocument } from './model';
import {
  SIMPLIFIED_INVOICE, STANDARD_INVOICE, STANDARD_CREDIT_NOTE, SIMPLIFIED_DEBIT_NOTE, chainFor,
} from './__fixtures__/z1-sources';

const DOCS: Record<string, UblDocument> = {
  'simplified-invoice': mapInvoiceToUbl(SIMPLIFIED_INVOICE, chainFor(1)),
  'standard-invoice': mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2)),
  'standard-credit-note': mapInvoiceToUbl(STANDARD_CREDIT_NOTE, chainFor(3)),
  'simplified-debit-note': mapInvoiceToUbl(SIMPLIFIED_DEBIT_NOTE, chainFor(4)),
};

// ─── محلّل وسوم مصغّر (يكفي لمخرجاتنا الحتمية: لا تعليقات ولا CDATA، و<> مهرّبة في النصوص) ───
interface Node { name: string; children: Node[]; text: string }
function parse(xml: string): Node {
  const body = xml.replace(/^<\?xml[^>]*\?>\n/, '');
  const root: Node = { name: '#document', children: [], text: '' };
  const stack: Node[] = [root];
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    assert.equal(m.index, consumed, `محارف غير متوقعة عند ${consumed}`);
    consumed = re.lastIndex;
    if (m[5] !== undefined) { stack[stack.length - 1].text += m[5]; continue; }
    if (m[1]) {
      const open = stack.pop()!;
      assert.equal(open.name, m[2], `وسم إغلاق غير مطابق: ${m[2]} بدل ${open.name}`);
      continue;
    }
    const node: Node = { name: m[2], children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  assert.equal(consumed, body.length, 'بقايا غير محلّلة');
  assert.equal(stack.length, 1, 'وسوم غير مغلقة');
  assert.equal(root.children.length, 1, 'جذر واحد');
  return root.children[0];
}
const child = (n: Node, name: string) => n.children.find(c => c.name === name);
const names = (n: Node) => n.children.map(c => c.name);

/** يتحقق أن تسلسل الأسماء يحترم ترتيب مرجعي (كل اسم يجب أن يكون في القائمة). */
function assertOrdered(actual: string[], reference: string[], where: string) {
  let last = -1;
  for (const n of actual) {
    const i = reference.indexOf(n);
    assert.ok(i >= 0, `${where}: عنصر غير متوقع ${n}`);
    assert.ok(i >= last, `${where}: ${n} خارج الترتيب في [${actual.join(', ')}]`);
    last = i;
  }
}

// C-O1 (design §4.2)
const C_O1 = [
  'ext:UBLExtensions', 'cbc:ProfileID', 'cbc:ID', 'cbc:UUID', 'cbc:IssueDate', 'cbc:IssueTime', 'cbc:InvoiceTypeCode', 'cbc:Note',
  'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cac:OrderReference', 'cac:BillingReference', 'cac:ContractDocumentReference',
  'cac:AdditionalDocumentReference', 'cac:Signature', 'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:Delivery',
  'cac:PaymentMeans', 'cac:AllowanceCharge', 'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine',
];
// C-O2
const C_O2 = ['cbc:StreetName', 'cbc:BuildingNumber', 'cbc:PlotIdentification', 'cbc:CitySubdivisionName', 'cbc:CityName', 'cbc:PostalZone', 'cac:Country'];
// ترتيب XSD المتداخل (xml report §3.3)
const PARTY = ['cac:PartyIdentification', 'cac:PartyName', 'cac:PostalAddress', 'cac:PartyTaxScheme', 'cac:PartyLegalEntity'];
const LMT = ['cbc:LineExtensionAmount', 'cbc:TaxExclusiveAmount', 'cbc:TaxInclusiveAmount', 'cbc:AllowanceTotalAmount', 'cbc:ChargeTotalAmount', 'cbc:PrepaidAmount', 'cbc:PayableRoundingAmount', 'cbc:PayableAmount'];
const LINE = ['cbc:ID', 'cbc:InvoicedQuantity', 'cbc:LineExtensionAmount', 'cac:AllowanceCharge', 'cac:TaxTotal', 'cac:Item', 'cac:Price'];
const ALLOWANCE = ['cbc:ChargeIndicator', 'cbc:AllowanceChargeReasonCode', 'cbc:AllowanceChargeReason', 'cbc:MultiplierFactorNumeric', 'cbc:Amount', 'cbc:BaseAmount', 'cac:TaxCategory'];
const TAX_CATEGORY = ['cbc:ID', 'cbc:Percent', 'cbc:TaxExemptionReasonCode', 'cbc:TaxExemptionReason', 'cac:TaxScheme'];
const TAX_TOTAL = ['cbc:TaxAmount', 'cbc:RoundingAmount', 'cac:TaxSubtotal'];
const SUBTOTAL = ['cbc:TaxableAmount', 'cbc:TaxAmount', 'cac:TaxCategory'];
const PAYMENT_MEANS = ['cbc:PaymentMeansCode', 'cbc:InstructionNote'];

function walk(n: Node, visit: (n: Node) => void) { visit(n); n.children.forEach(c => walk(c, visit)); }

test('ترتيب العناصر العليا يطابق C-O1 تماماً لكل نوع مستند', () => {
  const expected: Record<string, string[]> = {
    'simplified-invoice': ['ext:UBLExtensions', 'cbc:ProfileID', 'cbc:ID', 'cbc:UUID', 'cbc:IssueDate', 'cbc:IssueTime', 'cbc:InvoiceTypeCode', 'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:Signature', 'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:Delivery', 'cac:PaymentMeans', 'cac:TaxTotal', 'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine', 'cac:InvoiceLine'],
    'standard-invoice': ['ext:UBLExtensions', 'cbc:ProfileID', 'cbc:ID', 'cbc:UUID', 'cbc:IssueDate', 'cbc:IssueTime', 'cbc:InvoiceTypeCode', 'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:Signature', 'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:Delivery', 'cac:PaymentMeans', 'cac:AllowanceCharge', 'cac:AllowanceCharge', 'cac:TaxTotal', 'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine', 'cac:InvoiceLine', 'cac:InvoiceLine'],
    'standard-credit-note': ['ext:UBLExtensions', 'cbc:ProfileID', 'cbc:ID', 'cbc:UUID', 'cbc:IssueDate', 'cbc:IssueTime', 'cbc:InvoiceTypeCode', 'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cac:BillingReference', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:Signature', 'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:Delivery', 'cac:PaymentMeans', 'cac:TaxTotal', 'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine'],
    'simplified-debit-note': ['ext:UBLExtensions', 'cbc:ProfileID', 'cbc:ID', 'cbc:UUID', 'cbc:IssueDate', 'cbc:IssueTime', 'cbc:InvoiceTypeCode', 'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cac:BillingReference', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:AdditionalDocumentReference', 'cac:Signature', 'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:Delivery', 'cac:PaymentMeans', 'cac:TaxTotal', 'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine'],
  };
  for (const [key, doc] of Object.entries(DOCS)) {
    const root = parse(serializeUnsigned(doc));
    assert.equal(root.name, 'Invoice', 'الإشعارات أيضاً على جذر Invoice (C-H1)');
    assert.deepEqual(names(root), expected[key], key);
    assertOrdered(names(root), C_O1, key);
    // ICV → PIH → QR ثم Signature (C-H8)
    const adrs = root.children.filter(c => c.name === 'cac:AdditionalDocumentReference').map(a => child(a, 'cbc:ID')!.text);
    assert.deepEqual(adrs, ['ICV', 'PIH', 'QR'], key);
  }
});

test('الترتيب المتداخل: PostalAddress (C-O2) وParty وTaxCategory وAllowanceCharge وLegalMonetaryTotal وInvoiceLine', () => {
  let addresses = 0, categories = 0, allowances = 0;
  for (const [key, doc] of Object.entries(DOCS)) {
    const root = parse(serializeUnsigned(doc));
    walk(root, n => {
      if (n.name === 'cac:PostalAddress') { addresses++; assertOrdered(names(n), C_O2, `${key} PostalAddress`); }
      if (n.name === 'cac:Party') assertOrdered(names(n), PARTY, `${key} Party`);
      if (n.name === 'cac:TaxCategory' || n.name === 'cac:ClassifiedTaxCategory') { categories++; assertOrdered(names(n), TAX_CATEGORY, `${key} ${n.name}`); }
      if (n.name === 'cac:AllowanceCharge') { allowances++; assertOrdered(names(n), ALLOWANCE, `${key} AllowanceCharge`); }
      if (n.name === 'cac:LegalMonetaryTotal') assertOrdered(names(n), LMT, `${key} LMT`);
      if (n.name === 'cac:InvoiceLine') assertOrdered(names(n), LINE, `${key} InvoiceLine`);
      if (n.name === 'cac:TaxTotal') assertOrdered(names(n), TAX_TOTAL, `${key} TaxTotal`);
      if (n.name === 'cac:TaxSubtotal') assertOrdered(names(n), SUBTOTAL, `${key} TaxSubtotal`);
      if (n.name === 'cac:PaymentMeans') assertOrdered(names(n), PAYMENT_MEANS, `${key} PaymentMeans`);
    });
    // TaxTotal الأول بلا تفصيل والثاني به (C-A2)
    const totals = root.children.filter(c => c.name === 'cac:TaxTotal');
    assert.deepEqual(names(totals[0]), ['cbc:TaxAmount']);
    assert.ok(names(totals[1]).includes('cac:TaxSubtotal'));
  }
  assert.ok(addresses >= 6 && categories >= 10 && allowances >= 4, 'التغطية');
  // المبسطة: PayableRoundingAmount بين PrepaidAmount وPayableAmount
  const lmt = child(parse(serializeUnsigned(DOCS['simplified-invoice'])), 'cac:LegalMonetaryTotal')!;
  assert.deepEqual(names(lmt).slice(-3), ['cbc:PrepaidAmount', 'cbc:PayableRoundingAmount', 'cbc:PayableAmount']);
});

test('الإشعار الدائن: BillingReference بعد TaxCurrencyCode، ونوع 381 بتصنيف 0100000، وسبب الإشعار بعد رمز الدفع', () => {
  const root = parse(serializeUnsigned(DOCS['standard-credit-note']));
  const typeLine = serializeUnsigned(DOCS['standard-credit-note']).split('\n').find(l => l.includes('InvoiceTypeCode'))!;
  assert.equal(typeLine, '    <cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
  const br = child(root, 'cac:BillingReference')!;
  assert.equal(child(child(br, 'cac:InvoiceDocumentReference')!, 'cbc:ID')!.text, 'INV-2609-000124');
  const pm = child(root, 'cac:PaymentMeans')!;
  assert.deepEqual(pm.children.map(c => [c.name, c.text]), [['cbc:PaymentMeansCode', '30'], ['cbc:InstructionNote', 'إرجاع بضاعة تالفة']]);
  assert.match(serializeUnsigned(DOCS['simplified-debit-note']), /<cbc:InvoiceTypeCode name="0200000">383<\/cbc:InvoiceTypeCode>/);
});

// ─── ثبات البايتات ───
const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'z1');
const SHA256: Record<string, string> = {
  'simplified-invoice': 'cce8c0215a2183aae3d49c1df99e93710e9860bd6b0eb2af0b3805fec3847fcc',
  'standard-invoice': 'ee19a6b29125613c9bd1f3674f5f37f6040bc00721663b7e6be6da0b91a301f4',
  'standard-credit-note': '91f75c94d78c3ac5476b445708fa7b749a11e82fd8468878e99f4aede308a6f0',
  'simplified-debit-note': '3358da40840ad86add77286334b98026930711ced33116c7ec3066f97481ad01',
};

test('ثبات البايتات: لقطات مرجعية مراجَعة لأربعة مستندات (SHA-256 + ملف مقروء)', () => {
  const update = process.env.UPDATE_ZATCA_FIXTURES === '1';
  for (const [key, doc] of Object.entries(DOCS)) {
    const xml = serializeUnsigned(doc);
    const file = path.join(FIXTURE_DIR, `${key}.xml`);
    const sha = crypto.createHash('sha256').update(xml, 'utf8').digest('hex');
    if (update) { fs.mkdirSync(FIXTURE_DIR, { recursive: true }); fs.writeFileSync(file, xml, 'utf8'); console.log(`${key}: ${sha}`); continue; }
    // الملف قد يُحوَّل إلى CRLF عند السحب على ويندوز؛ البصمة تحرس البايتات الفعلية
    assert.equal(xml, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `${key}: تغيّر الـXML عن اللقطة المراجَعة`);
    assert.equal(sha, SHA256[key], `${key}: تغيّرت البصمة`);
  }
});

test('حتمية: نفس المستند ⇒ نفس البايتات، ولا أثر لمنطقة الخادم الزمنية', () => {
  const saved = process.env.TZ;
  try {
    const outs = new Set<string>();
    for (const tz of ['UTC', 'Asia/Riyadh', 'America/New_York']) {
      process.env.TZ = tz;
      outs.add(serializeUnsigned(mapInvoiceToUbl(STANDARD_INVOICE, chainFor(2))));
    }
    assert.equal(outs.size, 1);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('الترميز: إعلان XML ثم الجذر ملاصقاً لـ ext:UBLExtensions، LF فقط، بلا BOM، وينتهي بـ </Invoice>', () => {
  const xml = serializeUnsigned(DOCS['simplified-invoice']);
  const lines = xml.split('\n');
  assert.equal(lines[0], XML_DECLARATION);
  assert.equal(lines[1], `${ROOT_OPEN}<ext:UBLExtensions>`);
  assert.equal(xml.charCodeAt(0), '<'.charCodeAt(0), 'بلا BOM');
  assert.equal(xml.includes('\r'), false);
  assert.ok(xml.endsWith('</Invoice>\n'));
  assert.ok(lines.every(l => /^( {4})*\S/.test(l) || l === ''), 'مسافة بادئة بمضاعفات 4 فقط');
  assert.ok(xml.includes('\n</ext:UBLExtensions>\n    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>\n'), 'تخطيط عيّنة الـSDK حول نهاية الامتدادات');
});

test('قالب التوقيع: خانات Z2 فارغة بالعدد الصحيح، ولا عنصر فارغ غيرها، ولا وسم ذاتي الإغلاق خارج خوارزميات ds', () => {
  const allowedEmpty = new Map([
    ['ds:DigestValue', 3], ['ds:SignatureValue', 1], ['ds:X509Certificate', 1], ['xades:SigningTime', 1],
    ['ds:X509IssuerName', 1], ['ds:X509SerialNumber', 1], ['cbc:EmbeddedDocumentBinaryObject', 1],
  ]);
  for (const [key, doc] of Object.entries(DOCS)) {
    const xml = serializeUnsigned(doc);
    const counts = new Map<string, number>();
    for (const m of xml.matchAll(/<([\w:]+)(?:\s[^>]*)?>\s*<\/\1>/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    assert.deepEqual([...counts.entries()].sort(), [...allowedEmpty.entries()].sort(), `${key}: عناصر فارغة`);
    const selfClosing = new Set([...xml.matchAll(/<([\w:]+)[^>]*\/>/g)].map(m => m[1]));
    assert.deepEqual([...selfClosing].sort(), ['ds:CanonicalizationMethod', 'ds:DigestMethod', 'ds:SignatureMethod', 'ds:Transform']);
    // خانة QR داخل مرجع QR تحديداً
    assert.match(xml, /<cbc:ID>QR<\/cbc:ID>\n {8}<cac:Attachment>\n {12}<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain"><\/cbc:EmbeddedDocumentBinaryObject>/);
  }
});

test('SignedProperties في القالب تطابق السلسلة المُتحقَّق منها (C-S7) بعد دفع النطاقات للأسفل', () => {
  const xml = serializeUnsigned(DOCS['standard-invoice']);
  const start = xml.indexOf('<xades:SignedProperties');
  const end = xml.indexOf('</xades:SignedProperties>') + '</xades:SignedProperties>'.length;
  const pushed = xml.slice(start, end)
    .replace('<xades:SignedProperties Id=', '<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id=')
    .replace(/<ds:(\w+)/g, '<ds:$1 xmlns:ds="http://www.w3.org/2000/09/xmldsig#"');
  const sp = (n: number) => ' '.repeat(n);
  const ds = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
  const expected = [
    '<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">',
    `${sp(36)}<xades:SignedSignatureProperties>`,
    `${sp(40)}<xades:SigningTime></xades:SigningTime>`,
    `${sp(40)}<xades:SigningCertificate>`,
    `${sp(44)}<xades:Cert>`,
    `${sp(48)}<xades:CertDigest>`,
    `${sp(52)}<ds:DigestMethod ${ds} Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>`,
    `${sp(52)}<ds:DigestValue ${ds}></ds:DigestValue>`,
    `${sp(48)}</xades:CertDigest>`,
    `${sp(48)}<xades:IssuerSerial>`,
    `${sp(52)}<ds:X509IssuerName ${ds}></ds:X509IssuerName>`,
    `${sp(52)}<ds:X509SerialNumber ${ds}></ds:X509SerialNumber>`,
    `${sp(48)}</xades:IssuerSerial>`,
    `${sp(44)}</xades:Cert>`,
    `${sp(40)}</xades:SigningCertificate>`,
    `${sp(36)}</xades:SignedSignatureProperties>`,
    `${sp(32)}</xades:SignedProperties>`,
  ].join('\n');
  assert.equal(pushed, expected);
  assert.ok(xml.includes(`\n${sp(32)}<xades:SignedProperties Id="xadesSignedProperties">\n`), 'تبدأ الكتلة عند 32 فراغاً');
});

/** يحذف الكتل الثلاث كعُقد عناصر ويبقي المسافات حولها (C-S1) — كما سيفعل Z2 قبل C14N. */
function cutHashExcluded(xml: string): string {
  const cut = (s: string, from: number, closeTag: string) => {
    const to = s.indexOf(closeTag, from);
    assert.ok(from >= 0 && to > from);
    return s.slice(0, from) + s.slice(to + closeTag.length);
  };
  let s = cut(xml, xml.indexOf('<ext:UBLExtensions>'), '</ext:UBLExtensions>');
  s = cut(s, s.indexOf('<cac:Signature>'), '</cac:Signature>');
  const qrId = s.indexOf('<cbc:ID>QR</cbc:ID>');
  s = cut(s, s.lastIndexOf('<cac:AdditionalDocumentReference>', qrId), '</cac:AdditionalDocumentReference>');
  return s;
}

test('ملء خانات Z2 لا يغيّر بايتاً واحداً خارج الكتل الثلاث المحذوفة قبل التجزئة', () => {
  const xml = serializeUnsigned(DOCS['simplified-invoice']);
  let n = 0;
  const filled = xml
    .replace(/<ds:DigestValue><\/ds:DigestValue>/g, () => `<ds:DigestValue>digest${++n}==</ds:DigestValue>`)
    .replace('<ds:SignatureValue></ds:SignatureValue>', '<ds:SignatureValue>MEUCIQCs+DNQ1vlz7Joov==</ds:SignatureValue>')
    .replace('<ds:X509Certificate></ds:X509Certificate>', '<ds:X509Certificate>MIID3jCCA4SgAwIBAgIT</ds:X509Certificate>')
    .replace('<xades:SigningTime></xades:SigningTime>', '<xades:SigningTime>2026-09-14T10:15:30</xades:SigningTime>')
    .replace('<ds:X509IssuerName></ds:X509IssuerName>', '<ds:X509IssuerName>CN=PRZEINVOICESCA4-CA, DC=extgazt, DC=gov, DC=local</ds:X509IssuerName>')
    .replace('<ds:X509SerialNumber></ds:X509SerialNumber>', '<ds:X509SerialNumber>379112742831380471835263969587287663520528387</ds:X509SerialNumber>')
    .replace('<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain"></cbc:EmbeddedDocumentBinaryObject>', '<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">AW/YtNix2YPYqQ==</cbc:EmbeddedDocumentBinaryObject>');
  assert.equal(n, 3);
  assert.notEqual(filled, xml);
  parse(filled);
  const a = cutHashExcluded(xml), b = cutHashExcluded(filled);
  assert.equal(a, b);
  assert.equal(a.includes('ds:'), false);
  assert.equal(a.includes('<cbc:ID>QR</cbc:ID>'), false);
  assert.ok(a.includes('<cbc:ID>ICV</cbc:ID>') && a.includes('<cbc:ID>PIH</cbc:ID>'));
  // المسافات المحيطة بالكتل المحذوفة باقية (لا دمج أسطر)
  assert.ok(a.includes(`${ROOT_OPEN}\n    <cbc:ProfileID>`));
  assert.ok(a.includes('</cac:AdditionalDocumentReference>\n    \n    \n    <cac:AccountingSupplierParty>'));
});

test('التهريب: & < > " تُهرَّب، ومحارف التحكّم تُحذف، وCRLF يصير LF، والقيم الفارغة لا تُكتب', () => {
  const doc: UblDocument = JSON.parse(JSON.stringify(DOCS['standard-invoice']));
  doc.lines[0].name = 'أرز "ممتاز" <5kg> & more\u0001\u0008\u001F\u007F\uFFFE';
  doc.customer.registrationName = 'مؤسسة\r\nالبقالة';
  doc.customer.otherId = { scheme: 'CR"N', value: '2050012345' };
  doc.supplier.address!.additionalNumber = '   ';
  const xml = serializeUnsigned(doc);
  assert.ok(xml.includes('<cbc:Name>أرز "ممتاز" &lt;5kg&gt; &amp; more</cbc:Name>'));
  assert.ok(xml.includes('<cbc:RegistrationName>مؤسسة\nالبقالة</cbc:RegistrationName>'));
  assert.ok(xml.includes('<cbc:ID schemeID="CR&quot;N">2050012345</cbc:ID>'));
  assert.equal(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\r]/.test(xml), false);
  assert.equal(xml.includes('PlotIdentification'), false, 'قيمة فراغات فقط = لا عنصر');
  parse(xml);
  assert.equal(escapeText('\uD800x\uDC00'), 'x', 'البدائل المنفردة تُحذف');
  assert.equal(escapeText('🚚'), '🚚', 'الزوج البديل الصحيح يبقى');
});
