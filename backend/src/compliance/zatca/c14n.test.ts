// اختبارات Z2: محلّل XML الصارم وC14N الشامل وتجزئة الفاتورة (C-S1).
// الاختبارات الذهبية تتخطّى نفسها عند غياب __fixtures__/sdk (CI والمستودع العام).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  assertNoForeignSignature, canonicalize, compareCodepoints, computeInvoiceHash, hashExcludedElements, invoiceHashInput,
} from './c14n';
import { parseXml, XmlError, XmlErrorCode, descendants } from './xml';
import { mapInvoiceToUbl, InvoiceSource } from './mapInvoice';
import { serializeUnsigned } from './ubl';
import {
  SIMPLIFIED_INVOICE, STANDARD_INVOICE, STANDARD_CREDIT_NOTE, SIMPLIFIED_DEBIT_NOTE, SELLER, BUSINESS_BUYER, WALK_IN_BUYER, chainFor,
} from './__fixtures__/z1-sources';
import { CORE_SIX, RAW, SDK_SKIP, naiveHashInput, rawText, sdkSamples } from './__fixtures__/z2-sdk';

const NS = 'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';

function rejects(xml: string | Uint8Array, code: XmlErrorCode, limits?: Parameters<typeof parseXml>[1]) {
  assert.throws(() => parseXml(xml, limits), (e: unknown) => {
    assert.ok(e instanceof XmlError, `ليس XmlError: ${String(e)}`);
    assert.equal(e.code, code, `${typeof xml === 'string' ? JSON.stringify(xml.slice(0, 80)) : 'bytes'}: ${e.message}`);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// قواعد C14N
// ─────────────────────────────────────────────────────────────────────────────

test('C14N: إعلانات النطاق أولاً مرتّبة بالبادئة (الافتراضي أولاً) ثم السمات بـ(URI النطاق، الاسم المحلي) لا بالبادئة', () => {
  assert.equal(
    canonicalize('<r z="1" xmlns:b="urn:b" b:y="2" xmlns="urn:d" a:x="3" xmlns:a="urn:a" c="4"/>'),
    '<r xmlns="urn:d" xmlns:a="urn:a" xmlns:b="urn:b" c="4" z="1" a:x="3" b:y="2"></r>',
  );
  // الترتيب بالـURI: البادئة a تشير إلى urn:z فتأتي بعد b (urn:a)
  assert.equal(
    canonicalize('<r xmlns:a="urn:z" xmlns:b="urn:a" a:k="1" b:k="2" b:j="3"/>'),
    '<r xmlns:a="urn:z" xmlns:b="urn:a" b:j="3" b:k="2" a:k="1"></r>',
  );
  // حالة عيّنات الـSDK الست: schemeID قبل schemeAgencyID في المصدر
  assert.equal(canonicalize('<cbc:ID xmlns:cbc="urn:u" schemeID="UN/ECE 5305" schemeAgencyID="6">S</cbc:ID>'),
    '<cbc:ID xmlns:cbc="urn:u" schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>');
  // ترتيب نقاط يونيكود لا وحدات UTF-16: U+FFFD قبل U+10000
  assert.equal(canonicalize('<r \u{10000}="1" \uFFFD="2"/>'), '<r \uFFFD="2" \u{10000}="1"></r>');
  assert.ok(compareCodepoints('\uFFFD', '\u{10000}') < 0 && '\uFFFD' > '\u{10000}', 'JS < وحده كان سيخطئ هنا');
  assert.equal(compareCodepoints('ab', 'abc') < 0, true);
});

test('C14N شامل: الإعلان الزائد يُحذف، والنطاق غير المستعمل يبقى، وxmlns="" فقط عند وجود افتراضي لدى الأب', () => {
  assert.equal(
    canonicalize('<a xmlns:x="urn:u"><x:b xmlns:x="urn:u"><c xmlns:x="urn:v"/></x:b></a>'),
    '<a xmlns:x="urn:u"><x:b><c xmlns:x="urn:v"></c></x:b></a>',
  );
  assert.equal(canonicalize('<a xmlns:unused="urn:never"><b/></a>'), '<a xmlns:unused="urn:never"><b></b></a>', 'الشامل لا يحذف غير المستعمل (عكس الحصري)');
  assert.equal(canonicalize('<a><b xmlns=""/></a>'), '<a><b></b></a>');
  assert.equal(canonicalize('<a xmlns=""/>'), '<a></a>');
  assert.equal(canonicalize('<a xmlns="urn:u"><b xmlns=""><c xmlns=""/></b></a>'), '<a xmlns="urn:u"><b xmlns=""><c></c></b></a>');
  assert.equal(canonicalize('<a xmlns="urn:u"><b xmlns="urn:u"/></a>'), '<a xmlns="urn:u"><b></b></a>');
  // xmlns:xml المطابق مسموح ولا يُرسم؛ xml:lang سمة عادية بنطاق XML
  assert.equal(canonicalize('<a xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:lang="ar" b="1"/>'), '<a b="1" xml:lang="ar"></a>');
});

test('C14N: التهريب في النص (& < > CR) وفي السمات (& < " TAB LF CR) و> تبقى حرفية في السمة', () => {
  assert.equal(canonicalize('<a>&amp; &lt; &gt; " \' &#xD; &#13;x</a>'), '<a>&amp; &lt; &gt; " \' &#xD; &#xD;x</a>');
  assert.equal(canonicalize('<a b="&amp;&lt;&gt;&quot;\'&#9;&#10;&#13;"/>'), '<a b="&amp;&lt;>&quot;\'&#x9;&#xA;&#xD;"></a>');
  assert.equal(canonicalize('<a b=\'x"y\' c="p>q"/>'), '<a b="x&quot;y" c="p>q"></a>');
  assert.equal(canonicalize('<a>]]&gt;</a>'), '<a>]]&gt;</a>');
});

test('C14N: CDATA يصير نصاً مهرَّباً ويندمج مع النص المجاور، والإشارات والكيانات الخمسة تُفكّ', () => {
  assert.equal(canonicalize('<a>x<![CDATA[<b>&amp;]]>y</a>'), '<a>x&lt;b&gt;&amp;amp;y</a>');
  assert.equal(canonicalize('<a>&#x41;&#65;&apos;&quot;&#x1F600;&#x10FFFF;</a>'), '<a>AA\'"😀\u{10FFFF}</a>');
  const doc = parseXml('<a>x<![CDATA[y]]>z</a>');
  assert.equal(doc.root.children.length, 1, 'عقدة نص واحدة');
  assert.equal((doc.root.children[0] as { value: string }).value, 'xyz');
});

test('C14N: CRLF وCR ⇒ LF في النص، وTAB/LF/CR الحرفية في السمات ⇒ فراغ (CRLF فراغ واحد)، والمحرف المُشار إليه يبقى', () => {
  assert.equal(canonicalize('<a>x\r\ny\rz\n</a>'), '<a>x\ny\nz\n</a>');
  assert.equal(canonicalize('<a b="1\r\n2\t3\n4\r5&#10;6"/>'), '<a b="1 2 3 4 5&#xA;6"></a>');
  assert.equal(canonicalize('<a><![CDATA[p\r\nq]]></a>'), '<a>p\nq</a>');
});

test('C14N: الوسم ذاتي الإغلاق يُكتب بوسمَي بداية ونهاية، والتعليقات تُحذف، وPI تبقى، ولا شيء خارج الجذر إلا PI', () => {
  assert.equal(canonicalize('<a/>'), '<a></a>');
  assert.equal(canonicalize('<a><b /><c></c></a>'), '<a><b></b><c></c></a>');
  assert.equal(
    canonicalize('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<?pi before?>\n<!--c-->\n<a><!--x-->t<?p  d ?></a>\n<!--y-->\n<?post?>\n'),
    '<?pi before?>\n<a>t<?p d ?></a>\n<?post?>',
  );
  assert.equal(canonicalize('\uFEFF<?xml version="1.0"?><a>  </a>  \n'), '<a>  </a>', 'BOM والإعلان والفراغ الخارجي تُسقط');
  assert.equal(canonicalize(Buffer.from('<a>مرحبا</a>', 'utf8')), '<a>مرحبا</a>');
});

test('الحذف قبل التجزئة: الكتل الثلاث تُحذف كعُقد والفراغ حولها باقٍ، وأي *:Signature متداخل يُحذف، وQR بـnormalize-space', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice ${NS}><ext:UBLExtensions><ext:UBLExtension/></ext:UBLExtensions>
    <cbc:ID>1</cbc:ID>
    <cac:AdditionalDocumentReference>
        <cbc:ID> \n\tQR  </cbc:ID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference><cbc:ID>QRX</cbc:ID></cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference xmlns:o="urn:other"><o:ID>QR</o:ID></cac:AdditionalDocumentReference>
    <cac:Signature><cbc:ID>s</cbc:ID></cac:Signature>
    <cac:X><foo:Signature xmlns:foo="urn:f">deep</foo:Signature>kept<cac:Y><Signature/></cac:Y></cac:X>
</Invoice>\n`;
  const expected = [
    `<Invoice ${NS}>`,
    '    <cbc:ID>1</cbc:ID>',
    '    ', // فراغ ما بين مرجع QR المحذوف وجاره يبقى بحروفه
    '    <cac:AdditionalDocumentReference><cbc:ID>QRX</cbc:ID></cac:AdditionalDocumentReference>',
    '    <cac:AdditionalDocumentReference xmlns:o="urn:other"><o:ID>QR</o:ID></cac:AdditionalDocumentReference>',
    '    ',
    '    <cac:X>kept<cac:Y></cac:Y></cac:X>',
    '</Invoice>',
  ].join('\n');
  assert.equal(invoiceHashInput(xml).toString('utf8'), expected);
  assert.equal(computeInvoiceHash(xml), crypto.createHash('sha256').update(expected, 'utf8').digest('base64'));
  assert.deepEqual(hashExcludedElements(xml).map(e => e.qname), ['ext:UBLExtensions', 'cac:AdditionalDocumentReference', 'cac:Signature', 'foo:Signature', 'Signature']);
  // الحارس يرفض التوقيع الغريب في الجسم
  assert.throws(() => assertNoForeignSignature(xml), (e: unknown) => e instanceof XmlError && (e.code === 'FOREIGN_SIGNATURE' || e.code === 'STRUCTURE'));
  // cbc:ID مجزّأ بتعليق = غموض عند الـSDK ⇒ رفض
  assert.throws(() => computeInvoiceHash(`<Invoice ${NS}><cac:AdditionalDocumentReference><cbc:ID>Q<!---->R</cbc:ID></cac:AdditionalDocumentReference></Invoice>`),
    (e: unknown) => e instanceof XmlError && e.code === 'AMBIGUOUS_QR_ID');
  // الجذر يجب أن يكون Invoice في نطاق UBL
  assert.throws(() => computeInvoiceHash('<Invoice><a/></Invoice>'), (e: unknown) => e instanceof XmlError && e.code === 'NOT_INVOICE');
  assert.throws(() => computeInvoiceHash('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/>'), (e: unknown) => e instanceof XmlError && e.code === 'NOT_INVOICE');
});

test('assertNoForeignSignature: يقبل قالب Z1 ويرفض Signature/UBLExtensions/مرجع QR في غير موضعه', () => {
  const base = serializeUnsigned(mapInvoiceToUbl(SIMPLIFIED_INVOICE, chainFor(1)));
  const layout = assertNoForeignSignature(base);
  assert.equal(layout.dsSignature.qname, 'ds:Signature');
  assert.equal(layout.cacSignature.qname, 'cac:Signature');
  // FOREIGN_SIGNATURE لعنصر Signature غريب في الجسم فقط؛ كتلة قالب مكرّرة أو في غير موضعها = STRUCTURE (خلل قالب)
  const variants: Array<[string, string, XmlErrorCode]> = [
    ['توقيع في بند', base.replace('<cbc:Name>', '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/><cbc:Name>'), 'FOREIGN_SIGNATURE'],
    ['cac:Signature ثانٍ', base.replace('<cac:AccountingSupplierParty>', '<cac:Signature><cbc:ID>x</cbc:ID></cac:Signature><cac:AccountingSupplierParty>'), 'STRUCTURE'],
    ['مرجع QR ثانٍ', base.replace('<cac:Signature>', '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID></cac:AdditionalDocumentReference><cac:Signature>'), 'STRUCTURE'],
    ['UBLExtensions متداخل', base.replace('<cbc:Name>', '<ext:UBLExtensions/><cbc:Name>'), 'STRUCTURE'],
    ['ds:Signature ثانٍ داخل الامتدادات', base.replace('<sac:SignatureInformation>', '<sac:SignatureInformation><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/>'), 'STRUCTURE'],
    ['ds:Signature خارج مساره (داخل ExtensionContent مباشرة)', base.replace('<sig:UBLDocumentSignatures', '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/><sig:UBLDocumentSignatures'), 'FOREIGN_SIGNATURE'],
  ];
  for (const [why, xml, code] of variants) {
    assert.notEqual(xml, base, why);
    assert.throws(() => assertNoForeignSignature(xml), (e: unknown) => e instanceof XmlError && e.code === code || assert.fail(`${why}: ${String(e)}`), why);
  }
  assert.throws(() => assertNoForeignSignature(base.replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '')), (e: unknown) => e instanceof XmlError && e.code === 'STRUCTURE');
});

// ─────────────────────────────────────────────────────────────────────────────
// الرفض
// ─────────────────────────────────────────────────────────────────────────────

test('الرفض: DOCTYPE وإعلانات الكيانات والكيانات غير المعرّفة («مليار ضحكة» وXXE لا تُحلَّل أصلاً)', () => {
  rejects('<!DOCTYPE a><a/>', 'DOCTYPE');
  rejects('<?xml version="1.0"?>\n<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><a>&lol2;</a>', 'DOCTYPE');
  rejects('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a>&xxe;</a>', 'DOCTYPE');
  rejects('<a><!DOCTYPE a></a>', 'DOCTYPE');
  rejects('<!ENTITY x "y"><a/>', 'ENTITY');
  rejects('<a>&foo;</a>', 'ENTITY');
  rejects('<a b="&nbsp;"/>', 'ENTITY');
  rejects('<a>&amp</a>', 'SYNTAX');
  rejects('<a>&#X41;</a>', 'SYNTAX');
});

test('الرفض: التداخل الخاطئ، الوسوم غير المغلقة، جذران، نص خارج الجذر، والصيغة المكسورة', () => {
  rejects('<a><b></a></b>', 'NESTING');
  rejects('<a><b></b>', 'NESTING');
  rejects('<a></a><b/>', 'CONTENT_OUTSIDE_ROOT');
  rejects('x<a/>', 'CONTENT_OUTSIDE_ROOT');
  rejects('<a/>x', 'CONTENT_OUTSIDE_ROOT');
  rejects('', 'NO_ROOT');
  rejects('<!--c-->', 'NO_ROOT');
  rejects('<a b=1/>', 'SYNTAX');
  rejects('<a b="1"c="2"/>', 'SYNTAX');
  rejects('<a b="<"/>', 'SYNTAX');
  rejects('<a>]]></a>', 'SYNTAX');
  rejects('<a><!-- x -- y --></a>', 'SYNTAX');
  rejects('<a><!-- x ---></a>', 'SYNTAX');
  rejects(' <?xml version="1.0"?><a/>', 'SYNTAX');
  rejects('<?xml version="1.1"?><a/>', 'SYNTAX');
  rejects('<a:b:c/>', 'SYNTAX');
  rejects('<1a/>', 'SYNTAX');
  rejects('<a><![CDATA[x</a>', 'SYNTAX');
});

test('الرفض: السمات المكرّرة بالاسم أو بالاسم الموسَّع، والبادئات غير المعلنة أو المحجوزة', () => {
  rejects('<a b="1" b="2"/>', 'DUP_ATTR');
  rejects('<a xmlns:p="urn:u" xmlns:q="urn:u" p:x="1" q:x="2"/>', 'DUP_ATTR');
  rejects('<a xmlns:p="urn:u" xmlns:p="urn:v"/>', 'DUP_ATTR');
  rejects('<x:a/>', 'NS_UNDECLARED');
  rejects('<a x:b="1"/>', 'NS_UNDECLARED');
  rejects('<a><x:b xmlns:y="urn:u"/></a>', 'NS_UNDECLARED');
  rejects('<a xmlns:p=""/>', 'NS_INVALID');
  rejects('<a xmlns:xml="urn:not-xml"/>', 'NS_INVALID');
  rejects('<a xmlns:xmlns="urn:u"/>', 'NS_INVALID');
  rejects('<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>', 'NS_INVALID');
  rejects('<xmlns:a/>', 'NS_INVALID');
  // النطاق المعلن على الأب يسري على الأبناء
  assert.equal(parseXml('<a xmlns:p="urn:u"><p:b p:c="1"/></a>').root.children.length, 1);
});

test('الرفض: المحارف خارج XML 1.0 والترميز غير UTF-8', () => {
  rejects('<a>\u0001</a>', 'CHAR');
  rejects('<a>&#0;</a>', 'CHAR');
  rejects('<a>&#xFFFE;</a>', 'CHAR');
  rejects('<a>\uD800</a>', 'CHAR');
  rejects('<a b="\uFFFF"/>', 'CHAR');
  rejects(Uint8Array.from([0x3c, 0x61, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x61, 0x3e]), 'ENCODING');
  rejects('<?xml version="1.0" encoding="ISO-8859-1"?><a/>', 'ENCODING');
});

test('الحدود: الحجم والعمق وعدد العُقد والسمات — والعمق الهائل لا يُفيض المكدّس', () => {
  const body = '<a>' + 'x'.repeat(100) + '</a>';
  rejects(body, 'SIZE', { maxBytes: 50 });
  rejects(Buffer.from(body), 'SIZE', { maxBytes: 50 });
  rejects('<a>' + 'ب'.repeat(40) + '</a>', 'SIZE', { maxBytes: 50 }); // 47 وحدة UTF-16 لكن 87 بايت
  assert.equal(parseXml(body, { maxBytes: 107 }).root.local, 'a');
  rejects('<a>'.repeat(65) + '</a>'.repeat(65), 'DEPTH');
  assert.equal(descendants(parseXml('<a>'.repeat(64) + '</a>'.repeat(64)).root).length, 63);
  rejects('<a>'.repeat(200_000) + '</a>'.repeat(200_000), 'DEPTH', { maxBytes: 64 * 1024 * 1024 });
  rejects('<r>' + '<i/>'.repeat(1000) + '</r>', 'NODES', { maxNodes: 500 });
  rejects('<r ' + Array.from({ length: 65 }, (_, i) => `a${i}="1"`).join(' ') + '/>', 'ATTRS');
});

test('المواضع: start/openEnd/closeStart/end تشير إلى النص الأصلي بدقّة (أساس الملء نصّاً)', () => {
  const src = '<?xml version="1.0"?>\r\n<a x="1">\r\n  <b></b><c/>\r\n</a>';
  const doc = parseXml(src);
  const [b, c] = doc.root.children.filter(k => k.kind === 'element') as Array<ReturnType<typeof descendants>[number]>;
  assert.equal(src.slice(b.start, b.openEnd), '<b>');
  assert.equal(b.openEnd, b.closeStart);
  assert.equal(src.slice(b.closeStart, b.end), '</b>');
  assert.equal(src.slice(c.start, c.end), '<c/>');
  assert.equal(c.selfClosing, true);
  assert.equal(src.slice(doc.root.start, doc.root.end), src.slice(src.indexOf('<a')));
});

// ─────────────────────────────────────────────────────────────────────────────
// مخرجات Z1 قانونية أصلاً (خاصية)
// ─────────────────────────────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('خاصية: لقطات Z1 الأربع وألف مستند Z1 عشوائي — بايتات C14N بعد الحذف = الحذف النصّي البسيط (مخرجاتنا قانونية)', () => {
  const dir = path.join(__dirname, '__fixtures__', 'z1');
  const snapshots = fs.readdirSync(dir).filter(f => f.endsWith('.xml')).map(f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(snapshots.length, 4);
  for (const xml of snapshots) assert.equal(invoiceHashInput(xml).toString('utf8'), naiveHashInput(xml));

  const r = rng(20260914);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const TEXT = ['أرز & سكر', 'عصير <برتقال>', '"ممتاز" \'جداً\'', 'Café ☕ 🚚', 'a]]>b', 'سطر\r\nثانٍ', 'x\tتبويب', '  حواف  '];
  let n = 0;
  for (let i = 0; i < 1000; i++) {
    const inclusive = r() < 0.5;
    const kind = pick(['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'] as const);
    const lines = 1 + Math.floor(r() * 6);
    const src: InvoiceSource = {
      kind,
      number: `INV-${i}-${pick(TEXT)}`,
      currency: 'SAR',
      pricesIncludeTax: inclusive,
      invoiceDiscountPct: inclusive ? 0 : pick([0, 0, 5, 12.5]),
      paymentType: pick(['CASH', 'CREDIT', 'INSTALLMENT']),
      seller: { ...SELLER, legalName: `${SELLER.legalName} ${pick(TEXT)}` },
      buyer: r() < 0.5 ? { ...BUSINESS_BUYER, businessName: pick(TEXT) } : { ...WALK_IN_BUYER, name: pick(TEXT) },
      billingReferences: kind === 'INVOICE' ? null : [`INV-${pick(TEXT)}`],
      noteReason: kind === 'INVOICE' ? null : pick(TEXT),
      items: Array.from({ length: lines }, () => {
        const zero = r() < 0.2;
        return {
          itemName: pick(TEXT),
          unitCode: pick([null, 'PCE', 'KGM', 'BX', 'LTR']),
          qty: pick([1, 2, 3, 12.5, 0.75, 100]),
          unitPrice: Math.round(r() * 100000) / 100 + 0.01,
          discountPct: pick([0, 0, 5, 10, 33.3]),
          taxPct: zero ? 0 : pick([15, 5]),
          ...(zero ? { vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-35', vatExemptionReason: pick(TEXT) } : {}),
        };
      }),
    };
    let xml: string;
    try {
      xml = serializeUnsigned(mapInvoiceToUbl(src, { ...chainFor(1 + (i % 9)), uuid: crypto.randomUUID() }));
    } catch {
      continue; // مُدخلات يرفضها Z1 عمداً — ليست موضوع هذه الخاصية
    }
    n++;
    assert.equal(invoiceHashInput(xml).toString('utf8'), naiveHashInput(xml), `مستند ${i}`);
  }
  assert.ok(n >= 900, `مستندات مولَّدة فعلاً: ${n}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// ذهبي: عيّنات الـSDK الرسمية
// ─────────────────────────────────────────────────────────────────────────────

test('ذهبي (SDK 3.4.8): computeInvoiceHash يطابق DigestValue لـ invoiceSignedData في العيّنات التسع عشرة كلها', { skip: SDK_SKIP }, () => {
  const samples = sdkSamples();
  assert.equal(samples.length, 19, 'عدد العيّنات');
  for (const s of samples) {
    assert.equal(computeInvoiceHash(s.xml), rawText(s.xml, RAW.invoiceDigest), s.rel);
    assert.doesNotThrow(() => assertNoForeignSignature(s.xml), s.rel);
  }
  // قيم الجدول الذهبي في design §3 Z2
  const table: Record<string, string> = {
    'Simplified/Invoice/Simplified_Invoice.xml': 'z5F9qsS6oWyDhehD8u8S0DaxV+2CUiUz9Y+UsR61JgQ=',
    'Standard/Invoice/Standard_Invoice.xml': 'V4U5qlZ3yXQ/Si1AC/R8SLc3F+iNy27wdVe8IWRqFAQ=',
    'Simplified/Credit/Simplified_Credit_Note.xml': '2kBYLvmDlvKUxK/0ma+P8jFkKoiPh5VKBWjXERwUfxk=',
    'Standard/Debit/Standard_Debit_Note.xml': '111hQXj+6NtfV62H0ITiDNgOJvcatTi3l41yDEE04F8=',
  };
  for (const [rel, h] of Object.entries(table)) assert.equal(computeInvoiceHash(samples.find(s => s.rel === rel)!.xml), h, rel);
});

test('ذهبي (SDK 3.4.8): الحذف النصّي الساذج يفشل في الست الأساسية بالضبط — لأن سماتها بغير الترتيب القانوني لا لأنها عُدّلت', { skip: SDK_SKIP }, () => {
  const failing: string[] = [];
  for (const s of sdkSamples()) {
    const naive = naiveHashInput(s.xml);
    const naiveHash = crypto.createHash('sha256').update(naive, 'utf8').digest('base64');
    if (naiveHash !== rawText(s.xml, RAW.invoiceDigest)) {
      failing.push(s.rel);
      // نفس مجموعة المعلومات: تطبيع النص الساذج يعطي بايتات التجزئة نفسها، والفرق أسطر سماتٍ فقط
      assert.equal(canonicalize(naive), invoiceHashInput(s.xml).toString('utf8'), s.rel);
      const a = naive.split('\n'), b = invoiceHashInput(s.xml).toString('utf8').split('\n');
      assert.equal(a.length, b.length);
      const diff = a.map((l, i) => [l, b[i]] as const).filter(([x, y]) => x !== y);
      assert.ok(diff.length > 0);
      for (const [x, y] of diff) {
        assert.match(x, /schemeID="[^"]*" schemeAgencyID="6"/, `${s.rel}: ${x}`);
        assert.equal(x.replace(/schemeID="([^"]*)" schemeAgencyID="6"/, 'schemeAgencyID="6" schemeID="$1"'), y);
      }
    } else {
      assert.equal(naive, invoiceHashInput(s.xml).toString('utf8'), s.rel);
    }
  }
  assert.deepEqual(failing.sort(), [...CORE_SIX].sort());
});
