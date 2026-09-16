// ============================================================================
// ZATCA المرحلة الثانية (Z2) — تجزئة الفاتورة: حذف الكتل الثلاث + C14N شامل (native)
// ----------------------------------------------------------------------------
// C-S1 (design §4.3): invoiceHash = base64(SHA-256(C14N(المستند بعد حذف العُقد))).
// ما تفعله حزمة الـSDK 3.4.8 حرفياً (invoice.xsl داخل الـjar): تحويل XSLT هويّة يحذف
//   • //Invoice//*[local-name()='UBLExtensions']
//   • //*[local-name()='AdditionalDocumentReference'][cbc:ID[normalize-space(text())='QR']]
//   • //Invoice//*[local-name()='Signature']            ← أي عنصر بهذا الاسم المحلي في أي عمق
// مع omit-xml-declaration، ثم Apache Santuario بـ http://www.w3.org/2006/12/xml-c14n11، ثم SHA-256.
// نحذف العُقد مباشرة على الشجرة (C-S2) ونُبقي عُقد الفراغ المحيطة كما هي.
//
// لماذا C14N 1.0 الشامل = C14N 1.1 هنا:
//   الفرق بين الإصدارين محصور في معالجة سمات xml:* (xml:id لا يُورَّث، وxml:base يُصحَّح) عند
//   تطبيع **جزء** من مستند (document subset) تُحذف فيه عناصر أسلاف تحمل تلك السمات. أما هنا فالـSDK
//   يطبّع **مستنداً كاملاً** ناتجاً عن التحويل (لا node-set جزئي)، فلا أسلاف محذوفة تورِّث xml:*،
//   ولا تُطبَّق قواعد الوراثة في أيّ من الإصدارين؛ والمخرجات متطابقة بايتاً ببايت.
//
// قواعد التسلسل المطبَّقة (Canonical XML، بلا تعليقات):
//   • لا إعلان XML ولا DTD؛ خارج الجذر تُرسم تعليمات المعالجة فقط (قبل الجذر يليها LF، وبعده يسبقها LF).
//   • إعلانات النطاق أولاً مرتّبة بالبادئة (الافتراضي أولاً)، ثم السمات مرتّبة بـ(URI النطاق، الاسم المحلي)
//     بترتيب نقاط يونيكود؛ الإعلان الزائد (نفس القيمة لدى الأب) لا يُرسم، وxmlns="" يُرسم فقط إن كان للأب نطاق افتراضي.
//   • النص: & < > وCR ⇒ &amp; &lt; &gt; &#xD;. السمات: & < " TAB LF CR ⇒ &amp; &lt; &quot; &#x9; &#xA; &#xD;.
//   • العنصر الفارغ يُكتب بوسمَي بداية ونهاية؛ التعليقات تُحذف.
// ============================================================================

import crypto from 'crypto';
import {
  XmlChild, XmlDocument, XmlElement, XmlError, XmlLimits, XmlMisc, descendants, directText, normalizeSpace, parseXml,
} from './xml';

export const UBL_NS = Object.freeze({
  INVOICE: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  CAC: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  CBC: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  EXT: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  SIG: 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
  SAC: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
  SBC: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
  DS: 'http://www.w3.org/2000/09/xmldsig#',
  XADES: 'http://uri.etsi.org/01903/v1.3.2#',
});

export type XmlInput = string | Uint8Array | XmlDocument;

export function toDocument(input: XmlInput, limits?: Partial<XmlLimits>): XmlDocument {
  if (typeof input === 'string' || input instanceof Uint8Array) return parseXml(input, limits);
  if (input && typeof input === 'object' && 'root' in input && 'source' in input) return input;
  throw new XmlError('SYNTAX', 'مُدخل XML غير مدعوم');
}

// ─────────────────────────────────────────────────────────────────────────────
// التهريب والترتيب
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#xD;' };
const ATTR_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '"': '&quot;', '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' };

export function c14nEscapeText(s: string): string {
  return /[&<>\r]/.test(s) ? s.replace(/[&<>\r]/g, c => TEXT_ESC[c]) : s;
}

export function c14nEscapeAttr(s: string): string {
  return /[&<"\t\n\r]/.test(s) ? s.replace(/[&<"\t\n\r]/g, c => ATTR_ESC[c]) : s;
}

/** مقارنة بنقاط يونيكود (لا بوحدات UTF-16) كما يشترط C14N. */
export function compareCodepoints(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff, ys = y >= 0xd800 && y <= 0xdfff;
    if (xs === ys) return x - y;
    // بديل (≥ U+10000) أكبر دائماً من أي محرف BMP غير بديل
    return xs ? 1 : -1;
  }
  return a.length - b.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// C14N الشامل لمستند كامل، مع استثناء عناصر (تُحذف كعُقد ويبقى ما حولها)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * رتبة كل URI نطاق للسمات في المستند: تُرتَّب القائمة المميَّزة (≤ ~130) مرة واحدة بنقاط يونيكود، ثم يُقارَن
 * بالأرقام. المقارنة الكاملة داخل كل ترتيب كانت ~1000 تكرار لكل زوج سمات (فاتورة 8MB مصمَّمة: 85 ثانية).
 */
function attributeNsRanks(root: XmlElement): Map<string, number> {
  const distinct = new Set<string>();
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const e = stack.pop()!;
    for (const a of e.attributes) distinct.add(a.ns);
    for (const c of e.children) if (c.kind === 'element') stack.push(c);
  }
  const ranks = new Map<string, number>();
  [...distinct].sort(compareCodepoints).forEach((u, i) => ranks.set(u, i));
  return ranks;
}

function startTag(el: XmlElement, out: string[], nsRank: ReadonlyMap<string, number>): void {
  out.push('<', el.qname);
  const parentScope = el.parent ? el.parent.inScope : null;
  if (el.nsDecls.length) {
    const rendered = el.nsDecls.filter(d => {
      if (d.prefix === '' && d.uri === '') return parentScope !== null && (parentScope.get('') ?? '') !== '';
      return parentScope === null || parentScope.get(d.prefix) !== d.uri;
    });
    rendered.sort((a, b) => compareCodepoints(a.prefix, b.prefix));
    for (const d of rendered) {
      out.push(d.prefix === '' ? ' xmlns="' : ` xmlns:${d.prefix}="`, c14nEscapeAttr(d.uri), '"');
    }
  }
  if (el.attributes.length) {
    const attrs = el.attributes.length === 1 ? el.attributes : [...el.attributes].sort((a, b) => (nsRank.get(a.ns)! - nsRank.get(b.ns)!) || compareCodepoints(a.local, b.local));
    for (const a of attrs) out.push(' ', a.qname, '="', c14nEscapeAttr(a.value), '"');
  }
  out.push('>');
}

function pi(p: { target: string; data: string }): string {
  return p.data === '' ? `<?${p.target}?>` : `<?${p.target} ${p.data}?>`;
}

function serializeElement(root: XmlElement, out: string[], excluded: ReadonlySet<XmlElement>): void {
  const nsRank = attributeNsRanks(root);
  // تكراري: كل إطار = عنصر ومؤشّر ابنه التالي
  const stack: Array<{ e: XmlElement; i: number }> = [];
  startTag(root, out, nsRank);
  stack.push({ e: root, i: 0 });
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.e.children.length) {
      out.push('</', top.e.qname, '>');
      stack.pop();
      continue;
    }
    const c: XmlChild = top.e.children[top.i++];
    if (c.kind === 'text') out.push(c14nEscapeText(c.value));
    else if (c.kind === 'element') {
      if (excluded.has(c)) continue;
      startTag(c, out, nsRank);
      stack.push({ e: c, i: 0 });
    } else if (c.kind === 'pi') out.push(pi(c));
    // التعليقات: تُحذف
  }
}

/** C14N شامل (بلا تعليقات) لمستند كامل؛ excluded: عناصر تُحذف بشجراتها. */
export function canonicalizeDocument(doc: XmlDocument, excluded: ReadonlySet<XmlElement> = new Set()): string {
  if (excluded.has(doc.root)) throw new XmlError('STRUCTURE', 'لا يمكن حذف العنصر الجذر');
  const out: string[] = [];
  const misc = (m: XmlMisc) => m.kind === 'pi';
  for (const p of doc.prolog) if (misc(p)) out.push(pi(p as { target: string; data: string }), '\n');
  serializeElement(doc.root, out, excluded);
  for (const p of doc.epilog) if (misc(p)) out.push('\n', pi(p as { target: string; data: string }));
  return out.join('');
}

/** Canonical XML (inclusive، بلا تعليقات) لمستند كامل بلا حذف. */
export function canonicalize(input: XmlInput): string {
  return canonicalizeDocument(toDocument(input));
}

// ─────────────────────────────────────────────────────────────────────────────
// مجموعة الحذف كما في invoice.xsl
// ─────────────────────────────────────────────────────────────────────────────

/** هل هذا مرجع QR: AdditionalDocumentReference (أي نطاق) له cbc:ID نصّه بعد normalize-space = QR. */
export function isQrReference(el: XmlElement): boolean {
  if (el.local !== 'AdditionalDocumentReference') return false;
  for (const c of el.children) {
    if (c.kind !== 'element' || c.ns !== UBL_NS.CBC || c.local !== 'ID') continue;
    const texts = c.children.filter(k => k.kind === 'text');
    // normalize-space(text()) مع أكثر من عقدة نص خطأ نوع في XPath 2.0 عند الـSDK: نرفض بدل التخمين
    if (texts.length > 1) throw new XmlError('AMBIGUOUS_QR_ID', 'cbc:ID مجزّأ بعدة عُقد نص تحت AdditionalDocumentReference', c.start);
    if (texts.length === 1 && normalizeSpace((texts[0] as { value: string }).value) === 'QR') return true;
  }
  return false;
}

function assertInvoiceRoot(doc: XmlDocument): void {
  if (doc.root.local !== 'Invoice' || doc.root.ns !== UBL_NS.INVOICE) {
    throw new XmlError('NOT_INVOICE', `الجذر ليس {${UBL_NS.INVOICE}}Invoice بل <${doc.root.qname}>`, doc.root.start);
  }
}

/** العناصر المحذوفة قبل التجزئة (العليا فقط؛ ما تحتها يُحذف معها)، بترتيب المستند. */
export function hashExcludedElements(input: XmlInput): XmlElement[] {
  const doc = toDocument(input);
  assertInvoiceRoot(doc);
  const out: XmlElement[] = [];
  const all = descendants(doc.root);
  const removed = new Set<XmlElement>();
  for (const el of all) {
    if (el.parent && removed.has(el.parent)) { removed.add(el); continue; }
    if (el.local === 'UBLExtensions' || el.local === 'Signature' || isQrReference(el)) {
      removed.add(el);
      out.push(el);
    }
  }
  return out;
}

/** بايتات UTF-8 التي تُجزَّأ فعلاً (للتشخيص والمقارنة). */
export function invoiceHashInput(input: XmlInput): Buffer {
  const doc = toDocument(input);
  return Buffer.from(canonicalizeDocument(doc, new Set(hashExcludedElements(doc))), 'utf8');
}

/** C-S1: base64(SHA-256(C14N(المستند بعد حذف الكتل الثلاث))). */
export function computeInvoiceHash(input: XmlInput): string {
  return crypto.createHash('sha256').update(invoiceHashInput(input)).digest('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// حارس مسار الختم: لا عنصر محذوف قبل التجزئة في غير موضعه المتوقَّع
// ─────────────────────────────────────────────────────────────────────────────

const DS_SIGNATURE_PATH: ReadonlyArray<readonly [string, string]> = [
  [UBL_NS.EXT, 'UBLExtension'], [UBL_NS.EXT, 'ExtensionContent'], [UBL_NS.SIG, 'UBLDocumentSignatures'],
  [UBL_NS.SAC, 'SignatureInformation'], [UBL_NS.DS, 'Signature'],
];

export interface HashExclusionLayout {
  ublExtensions: XmlElement;
  dsSignature: XmlElement;
  qrReference: XmlElement;
  cacSignature: XmlElement;
}

/**
 * يرفض أي مستند فيه عنصر محلي الاسم Signature أو UBLExtensions أو مرجع QR خارج البنية المتوقَّعة:
 * ext:UBLExtensions أول عنصر ابن للجذر وفيه ds:Signature واحد في مساره القياسي، ومرجع QR واحد
 * وcac:Signature واحد كلاهما ابن مباشر للجذر. أي «توقيع» آخر في الجسم كان سيُحذف من التجزئة بصمت
 * لدى الـSDK (فيصير محتوى غير مغطّى بالتوقيع) — لذا يُرفض قبل الختم.
 */
export function assertNoForeignSignature(input: XmlInput): HashExclusionLayout {
  const doc = toDocument(input);
  assertInvoiceRoot(doc);
  const root = doc.root;
  const firstChild = root.children.find(c => c.kind === 'element') as XmlElement | undefined;
  let ublExtensions: XmlElement | undefined;
  let dsSignature: XmlElement | undefined;
  let qrReference: XmlElement | undefined;
  let cacSignature: XmlElement | undefined;
  const fail = (el: XmlElement, why: string): never => {
    throw new XmlError('FOREIGN_SIGNATURE', `${why}: <${el.qname}>`, el.start);
  };
  for (const el of descendants(root)) {
    const qr = isQrReference(el);
    if (el.local === 'UBLExtensions') {
      if (el.parent !== root || el.ns !== UBL_NS.EXT || el !== firstChild || ublExtensions) fail(el, 'UBLExtensions في غير موضعه');
      ublExtensions = el;
    } else if (el.local === 'Signature') {
      if (el.parent === root && el.ns === UBL_NS.CAC && !cacSignature) { cacSignature = el; continue; }
      if (el.ns === UBL_NS.DS && !dsSignature && ublExtensions) {
        let p: XmlElement | null = el;
        let ok = true;
        for (let i = DS_SIGNATURE_PATH.length - 1; i >= 0; i--) {
          if (!p || p.ns !== DS_SIGNATURE_PATH[i][0] || p.local !== DS_SIGNATURE_PATH[i][1]) { ok = false; break; }
          p = p.parent;
        }
        if (ok && p === ublExtensions) { dsSignature = el; continue; }
      }
      fail(el, 'عنصر Signature غير متوقَّع');
    } else if (qr) {
      if (el.parent !== root || el.ns !== UBL_NS.CAC || qrReference) fail(el, 'مرجع QR غير متوقَّع');
      qrReference = el;
    }
  }
  if (!ublExtensions || !dsSignature || !qrReference || !cacSignature) {
    throw new XmlError('STRUCTURE', 'قالب التوقيع ناقص (UBLExtensions/ds:Signature/مرجع QR/cac:Signature)');
  }
  return { ublExtensions, dsSignature, qrReference, cacSignature };
}

/** نصّ QR الحالي من مرجع QR (بلا تحقق من صحّته). */
export function qrReferenceText(ref: XmlElement): string | undefined {
  for (const att of ref.children) {
    if (att.kind !== 'element' || att.ns !== UBL_NS.CAC || att.local !== 'Attachment') continue;
    for (const obj of att.children) {
      if (obj.kind === 'element' && obj.ns === UBL_NS.CBC && obj.local === 'EmbeddedDocumentBinaryObject') return directText(obj);
    }
  }
  return undefined;
}
