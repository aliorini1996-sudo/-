// ============================================================================
// ZATCA المرحلة الثانية (Z2) — XAdES: CertDigest وSignedProperties وخانات التوقيع
// ----------------------------------------------------------------------------
// • C-S4: CertDigest = base64(hex(SHA-256(نصّ base64 للشهادة))).
// • C-S7: SignedProperties digest = base64(hex(SHA-256(السلسلة الحرفية))) — **بلا C14N**: الكتلة
//   كما تُرسم داخل المستند (بمسافاتها البادئة المضمَّنة، LF، DigestMethod ذاتي الإغلاق) مع «دفع النطاقات
//   للأسفل»: xmlns:xades على الجذر وxmlns:ds على كل عنصر ds:*.
// مصدر حقيقة واحد: القالب UBL_EXTENSIONS_TEMPLATE في ubl.ts (Z1) — لا نسخة ثانية هنا. نبني منه
// مستنداً مصغّراً، نملأ الخانات نصّاً، ثم نطبّق خوارزمية الدفع نفسها التي نطبّقها على المستند المختوم،
// فيثبت self-check في stamp.ts أن السلسلة المُجزَّأة = البايتات المضمَّنة فعلاً.
// ============================================================================

import { sha256HexB64 } from './crypto';
import { UBL_NS } from './c14n';
import { isCanonicalBase64, isXmlSafeText } from './cert';
import { isIsoDate } from './time';
import { ROOT_OPEN, UBL_EXTENSIONS_TEMPLATE } from './ubl';
import {
  XmlDocument, XmlElement, XmlError, attr, childElements, childPath, directText, fillEmptyElements, onlyChild, parseXml,
} from './xml';

export const ALG = Object.freeze({
  C14N11: 'http://www.w3.org/2006/12/xml-c14n11',
  ECDSA_SHA256: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  SHA256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  XPATH: 'http://www.w3.org/TR/1999/REC-xpath-19991116',
  SIGNATURE_PROPERTIES: 'http://www.w3.org/2000/09/xmldsig#SignatureProperties',
});

/** UNVERIFIED(U2): قبول لاحقة Z في SigningTime — نلتزم صيغة عيّنات الـSDK بلا Z (design §6.2). */
export const SIGNING_TIME_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/** الصيغة **و**تاريخ تقويمي حقيقي: V8 يحوّل 2026-02-30 بصمت إلى 2 مارس، وxs:dateTime عند الهيئة يرفضه. */
export function isValidSigningTime(s: unknown): s is string {
  return typeof s === 'string' && SIGNING_TIME_RE.test(s) && isIsoDate(s.slice(0, 10));
}

/** C-S4 */
export function certDigest(certB64: string): string {
  if (!isCanonicalBase64(certB64)) throw new XmlError('STRUCTURE', 'نصّ الشهادة ليس base64 قانونياً');
  return sha256HexB64(certB64);
}

// ─────────────────────────────────────────────────────────────────────────────
// خانات قالب التوقيع
// ─────────────────────────────────────────────────────────────────────────────

export interface SignatureSlots {
  invoiceDigest: XmlElement;
  signedPropertiesDigest: XmlElement;
  signatureValue: XmlElement;
  certificate: XmlElement;
  signedProperties: XmlElement;
  signingTime: XmlElement;
  certDigest: XmlElement;
  issuerName: XmlElement;
  serialNumber: XmlElement;
}

const need = (el: XmlElement | undefined, what: string): XmlElement => {
  if (!el) throw new XmlError('STRUCTURE', `قالب التوقيع: ${what} مفقود`);
  return el;
};

function expectAlgorithm(el: XmlElement | undefined, alg: string, what: string): void {
  if (!el || attr(el, 'Algorithm') !== alg) throw new XmlError('STRUCTURE', `قالب التوقيع: ${what} يجب أن يكون ${alg}`, el?.start ?? -1);
}

/**
 * يحدّد خانات ds:Signature ويتحقق من خوارزمياتها كما في قالب الـSDK (C-S8): C14N11، ECDSA-SHA256،
 * مرجعان فقط (invoiceSignedData بثلاثة تحويلات XPath + C14N11، ثم SignedProperties)، وSHA-256.
 */
export function locateSignatureSlots(dsSignature: XmlElement): SignatureSlots {
  const DS = UBL_NS.DS, XADES = UBL_NS.XADES;
  if (dsSignature.ns !== DS || dsSignature.local !== 'Signature') throw new XmlError('STRUCTURE', 'ليس ds:Signature', dsSignature.start);
  const signedInfo = need(onlyChild(dsSignature, DS, 'SignedInfo'), 'ds:SignedInfo');
  expectAlgorithm(onlyChild(signedInfo, DS, 'CanonicalizationMethod'), ALG.C14N11, 'CanonicalizationMethod');
  expectAlgorithm(onlyChild(signedInfo, DS, 'SignatureMethod'), ALG.ECDSA_SHA256, 'SignatureMethod');
  const refs = childElements(signedInfo, DS, 'Reference');
  if (refs.length !== 2) throw new XmlError('STRUCTURE', 'ds:SignedInfo يجب أن يحوي مرجعين بالضبط', signedInfo.start);
  const [invRef, spRef] = refs;
  if (attr(invRef, 'Id') !== 'invoiceSignedData' || attr(invRef, 'URI') !== '') throw new XmlError('STRUCTURE', 'المرجع الأول ليس invoiceSignedData', invRef.start);
  const transforms = childElements(need(onlyChild(invRef, DS, 'Transforms'), 'ds:Transforms'), DS, 'Transform');
  if (transforms.length !== 4 || transforms.slice(0, 3).some(t => attr(t, 'Algorithm') !== ALG.XPATH) || attr(transforms[3], 'Algorithm') !== ALG.C14N11) {
    throw new XmlError('STRUCTURE', 'تحويلات invoiceSignedData تخالف قالب الهيئة', invRef.start);
  }
  expectAlgorithm(onlyChild(invRef, DS, 'DigestMethod'), ALG.SHA256, 'DigestMethod (الفاتورة)');
  if (attr(spRef, 'URI') !== '#xadesSignedProperties' || attr(spRef, 'Type') !== ALG.SIGNATURE_PROPERTIES) {
    throw new XmlError('STRUCTURE', 'المرجع الثاني ليس #xadesSignedProperties', spRef.start);
  }
  expectAlgorithm(onlyChild(spRef, DS, 'DigestMethod'), ALG.SHA256, 'DigestMethod (الخصائص الموقَّعة)');
  const qp = need(childPath(dsSignature, [[DS, 'Object'], [XADES, 'QualifyingProperties']]), 'xades:QualifyingProperties');
  if (attr(qp, 'Target') !== (attr(dsSignature, 'Id') ?? '') || attr(qp, 'Target') !== 'signature') {
    throw new XmlError('STRUCTURE', 'QualifyingProperties/@Target لا يشير إلى ds:Signature/@Id=signature', qp.start);
  }
  const sp = need(onlyChild(qp, XADES, 'SignedProperties'), 'xades:SignedProperties');
  if (attr(sp, 'Id') !== 'xadesSignedProperties') throw new XmlError('STRUCTURE', 'SignedProperties/@Id ليس xadesSignedProperties', sp.start);
  const ssp = need(onlyChild(sp, XADES, 'SignedSignatureProperties'), 'xades:SignedSignatureProperties');
  const cert = need(childPath(ssp, [[XADES, 'SigningCertificate'], [XADES, 'Cert']]), 'xades:Cert');
  const cd = need(onlyChild(cert, XADES, 'CertDigest'), 'xades:CertDigest');
  expectAlgorithm(onlyChild(cd, DS, 'DigestMethod'), ALG.SHA256, 'DigestMethod (الشهادة)');
  const is = need(onlyChild(cert, XADES, 'IssuerSerial'), 'xades:IssuerSerial');
  return {
    invoiceDigest: need(onlyChild(invRef, DS, 'DigestValue'), 'DigestValue (الفاتورة)'),
    signedPropertiesDigest: need(onlyChild(spRef, DS, 'DigestValue'), 'DigestValue (الخصائص)'),
    signatureValue: need(onlyChild(dsSignature, DS, 'SignatureValue'), 'ds:SignatureValue'),
    certificate: need(childPath(dsSignature, [[DS, 'KeyInfo'], [DS, 'X509Data'], [DS, 'X509Certificate']]), 'ds:X509Certificate'),
    signedProperties: sp,
    signingTime: need(onlyChild(ssp, XADES, 'SigningTime'), 'xades:SigningTime'),
    certDigest: need(onlyChild(cd, DS, 'DigestValue'), 'DigestValue (الشهادة)'),
    issuerName: need(onlyChild(is, DS, 'X509IssuerName'), 'ds:X509IssuerName'),
    serialNumber: need(onlyChild(is, DS, 'X509SerialNumber'), 'ds:X509SerialNumber'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// دفع النطاقات للأسفل (C-S7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * يعيد نصّ العنصر كما هو في المصدر بايتاً ببايت، مضافاً إلى وسم بداية كل عنصر إعلانُ نطاق بادئته
 * (وبادئات سماته) إن لم يُعلَن على سلفٍ داخل الجزء المقتطَع — مباشرة بعد اسم العنصر.
 * هذا ما يعيد به المُتحقِّق تسلسل SignedProperties: xmlns:xades على الجذر وxmlns:ds على كل ds:*.
 */
/** حدود دفع النطاقات: كتلة SignedProperties نحو 12 عنصراً وأقل من 1KB إدراجات — لا مستند محشوّ يتضخّم 1000×. */
export const PUSH_DOWN_MAX_ELEMENTS = 256;
export const PUSH_DOWN_MAX_INSERT_CHARS = 64 * 1024;

export function pushDownNamespaces(doc: XmlDocument, el: XmlElement, limits: { maxElements?: number; maxInsertChars?: number } = {}): string {
  const maxElements = limits.maxElements ?? PUSH_DOWN_MAX_ELEMENTS;
  const maxInsertChars = limits.maxInsertChars ?? PUSH_DOWN_MAX_INSERT_CHARS;
  const src = doc.source;
  const inserts: Array<[number, string]> = [];
  let elements = 0;
  let inserted = 0;
  const stack: Array<{ e: XmlElement; scope: ReadonlyMap<string, string> }> = [{ e: el, scope: new Map() }];
  while (stack.length) {
    const { e, scope } = stack.pop()!;
    if (++elements > maxElements) throw new XmlError('STRUCTURE', `دفع النطاقات: أكثر من ${maxElements} عنصراً`, e.start);
    // نسخ كسول: لا تُنسخ الخريطة إلا حين يُضاف إليها فعلاً (النسخ لكل عنصر كان تربيعياً على مستند محشوّ)
    let own: ReadonlyMap<string, string> = scope;
    let mutable: Map<string, string> | null = null;
    const set = (prefix: string, uri: string) => {
      if (!mutable) { mutable = new Map(scope); own = mutable; }
      mutable.set(prefix, uri);
    };
    for (const d of e.nsDecls) if (own.get(d.prefix) !== d.uri) set(d.prefix, d.uri);
    const added: string[] = [];
    const want = (prefix: string, uri: string) => {
      if (prefix === 'xml') return;
      const current = own.get(prefix) ?? (prefix === '' ? '' : undefined);
      if (current === uri) return;
      set(prefix, uri);
      const v = uri.replace(/[&<"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&quot;'));
      added.push(prefix === '' ? ` xmlns="${v}"` : ` xmlns:${prefix}="${v}"`);
    };
    want(e.prefix, e.ns);
    for (const a of e.attributes) if (a.prefix !== '') want(a.prefix, a.ns);
    if (added.length) {
      const text = added.join('');
      if ((inserted += text.length) > maxInsertChars) throw new XmlError('STRUCTURE', `دفع النطاقات: إدراجات أطول من ${maxInsertChars}`, e.start);
      inserts.push([e.start + 1 + e.qname.length, text]);
    }
    for (let i = e.children.length - 1; i >= 0; i--) {
      const c = e.children[i];
      if (c.kind === 'element') stack.push({ e: c, scope: own });
    }
  }
  inserts.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let pos = el.start;
  for (const [at, text] of inserts) {
    parts.push(src.slice(pos, at), text);
    pos = at;
  }
  parts.push(src.slice(pos, el.end));
  // المُحقِّق يقرأ الكتلة من شجرة مُحلَّلة، ومحلّل XML يوحّد CRLF/CR إلى LF قبل أي معالجة (C-S7 بـLF):
  // بلا هذا يُرفض مستند صحيح مرّ على أداة حوّلت نهايات الأسطر.
  return parts.join('').replace(/\r\n?/g, '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// مطابقة قالب التوقيع كاملاً (C-S8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * بصمة بنيوية لشجرة: الاسم الموسَّع لكل عنصر، وسماته مرتّبة بقيمها، ونصوصه غير الفراغية — مع تجاهل
 * نصوص الخانات (skipText) وعُقد الفراغ والتعليقات. تتوقّف فور تجاوز maxElements (لا حرق CPU على مستند محشوّ).
 */
function structuralFingerprint(root: XmlElement, skipText: ReadonlySet<XmlElement>, maxElements: number): string[] | null {
  const out: string[] = [];
  let count = 0;
  const stack: Array<{ e: XmlElement; i: number }> = [];
  const open = (e: XmlElement): boolean => {
    if (++count > maxElements) return false;
    const attrs = e.attributes.map(a => `${a.ns}|${a.local}=${a.value}`).sort();
    out.push(`<{${e.ns}}${e.local} ${attrs.join(' ')}`);
    stack.push({ e, i: 0 });
    return true;
  };
  if (!open(root)) return null;
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.e.children.length) { out.push('>'); stack.pop(); continue; }
    const c = top.e.children[top.i++];
    if (c.kind === 'element') { if (!open(c)) return null; }
    else if (c.kind === 'text' && !skipText.has(top.e) && c.value.replace(/[ \t\n\r]/g, '') !== '') out.push(`#${c.value}`);
    else if (c.kind === 'pi') out.push(`?${c.target}`);
  }
  return out;
}

let templateFingerprintCache: string[] | null = null;

const SLOT_KEYS: Array<keyof SignatureSlots> = [
  'invoiceDigest', 'signedPropertiesDigest', 'signatureValue', 'certificate', 'signingTime', 'certDigest', 'issuerName', 'serialNumber',
];

/**
 * يشترط أن تطابق كتلة ext:UBLExtensions قالب ubl.ts بنيوياً كاملاً: نصوص XPath الثلاثة، ExtensionURI،
 * معرّفات SignatureInformation، وKeyInfo بالشهادة وحدها، ولا عناصر زائدة — لا الخوارزميات والمعرّفات فقط.
 * هذه كلها خارج التجزئة وخارج SignatureValue، فبلا المطابقة يُختم قالبٌ خاطئ ويجتاز كل فحص ذاتي ثم ترفضه الهيئة.
 * الفراغ بين الوسوم لا يُقارن (عيّنات الـSDK تختلف عن قالبنا بفراغ زائد واحد).
 */
export function assertSignatureTemplate(ublExtensions: XmlElement, slots: SignatureSlots): void {
  if (!templateFingerprintCache) {
    const { doc, slots: tslots } = templateDocument();
    const ext = need(childPath(doc.root, [[UBL_NS.EXT, 'UBLExtensions']]), 'ext:UBLExtensions في قالب ubl.ts');
    templateFingerprintCache = structuralFingerprint(ext, new Set(SLOT_KEYS.map(k => tslots[k])), Number.MAX_SAFE_INTEGER)!;
  }
  const want = templateFingerprintCache;
  const elementCount = want.filter(x => x.startsWith('<')).length;
  const got = structuralFingerprint(ublExtensions, new Set(SLOT_KEYS.map(k => slots[k])), elementCount);
  if (!got) throw new XmlError('STRUCTURE', `قالب التوقيع: عناصر أكثر من قالب الهيئة (${elementCount})`, ublExtensions.start);
  if (got.length !== want.length || got.some((x, i) => x !== want[i])) {
    const i = got.findIndex((x, k) => x !== want[k]);
    const at = i < 0 ? Math.min(got.length, want.length) : i;
    throw new XmlError('STRUCTURE', `قالب التوقيع يخالف قالب الهيئة عند «${(got[at] ?? '∅').slice(0, 120)}» (المتوقَّع «${(want[at] ?? '∅').slice(0, 120)}»)`, ublExtensions.start);
  }
}

export const CAC_SIGNATURE_ID = 'urn:oasis:names:specification:ubl:signature:Invoice';
export const CAC_SIGNATURE_METHOD = 'urn:oasis:names:specification:ubl:dsig:enveloped:xades';

/** cac:Signature: بالضبط cbc:ID وcbc:SignatureMethod بقيمتيهما الثابتتين (خارج التجزئة، فتُفحص هنا). */
export function assertCacSignature(cacSignature: XmlElement): void {
  const kids = childElements(cacSignature);
  const texts = cacSignature.children.filter(c => c.kind === 'text' && c.value.replace(/[ \t\n\r]/g, '') !== '');
  const [id, method] = kids;
  if (kids.length !== 2 || texts.length || cacSignature.attributes.length
    || id.ns !== UBL_NS.CBC || id.local !== 'ID' || directText(id) !== CAC_SIGNATURE_ID || id.attributes.length
    || method.ns !== UBL_NS.CBC || method.local !== 'SignatureMethod' || directText(method) !== CAC_SIGNATURE_METHOD || method.attributes.length
    || childElements(id).length || childElements(method).length) {
    throw new XmlError('STRUCTURE', `cac:Signature يجب أن يحوي cbc:ID=${CAC_SIGNATURE_ID} وcbc:SignatureMethod=${CAC_SIGNATURE_METHOD} فقط`, cacSignature.start);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SignedProperties من القالب
// ─────────────────────────────────────────────────────────────────────────────

let templateCache: { doc: XmlDocument; slots: SignatureSlots } | null = null;

function templateDocument(): { doc: XmlDocument; slots: SignatureSlots } {
  if (templateCache) return templateCache;
  const doc = parseXml(`${ROOT_OPEN}${UBL_EXTENSIONS_TEMPLATE.join('\n')}</Invoice>`);
  const ds = need(
    childPath(doc.root, [[UBL_NS.EXT, 'UBLExtensions'], [UBL_NS.EXT, 'UBLExtension'], [UBL_NS.EXT, 'ExtensionContent'], [UBL_NS.SIG, 'UBLDocumentSignatures'], [UBL_NS.SAC, 'SignatureInformation'], [UBL_NS.DS, 'Signature']]),
    'ds:Signature في قالب ubl.ts',
  );
  templateCache = { doc, slots: locateSignatureSlots(ds) };
  return templateCache;
}

export interface SignedPropertiesValues {
  signingTime: string;
  certDigest: string;
  issuerName: string;
  serialDecimal: string;
}

export function assertSignedPropertiesValues(v: SignedPropertiesValues): void {
  if (!isValidSigningTime(v.signingTime)) throw new XmlError('STRUCTURE', `SigningTime ليس تاريخاً صالحاً بصيغة YYYY-MM-DDTHH:mm:ss: «${v.signingTime}»`);
  if (!isCanonicalBase64(v.certDigest) || Buffer.from(v.certDigest, 'base64').length !== 64) throw new XmlError('STRUCTURE', 'CertDigest ليس base64 لـ hex SHA-256');
  if (!v.issuerName || !isXmlSafeText(v.issuerName)) throw new XmlError('STRUCTURE', 'اسم المُصدِر فارغ أو فيه محارف تحكّم أو محارف لا تصلح في XML');
  if (!/^[1-9]\d*$/.test(v.serialDecimal)) throw new XmlError('STRUCTURE', 'الرقم التسلسلي ليس عدداً عشرياً موجباً');
}

/** C-S7: السلسلة الحرفية التي تُجزَّأ — من قالب ubl.ts بعد ملء الخانات ودفع النطاقات. */
export function signedPropertiesString(signingTime: string, certDigestB64: string, issuerName: string, serialDecimal: string): string {
  assertSignedPropertiesValues({ signingTime, certDigest: certDigestB64, issuerName, serialDecimal });
  const { doc, slots } = templateDocument();
  const filled = parseXml(fillEmptyElements(doc, [
    { element: slots.signingTime, text: signingTime },
    { element: slots.certDigest, text: certDigestB64 },
    { element: slots.issuerName, text: issuerName },
    { element: slots.serialNumber, text: serialDecimal },
  ]));
  const ds = childPath(filled.root, [[UBL_NS.EXT, 'UBLExtensions'], [UBL_NS.EXT, 'UBLExtension'], [UBL_NS.EXT, 'ExtensionContent'], [UBL_NS.SIG, 'UBLDocumentSignatures'], [UBL_NS.SAC, 'SignatureInformation'], [UBL_NS.DS, 'Signature']])!;
  return pushDownNamespaces(filled, locateSignatureSlots(ds).signedProperties);
}

/** base64(hex(SHA-256)) لسلسلة SignedProperties جاهزة. */
export function signedPropertiesDigestOf(spString: string): string {
  return sha256HexB64(Buffer.from(spString, 'utf8'));
}

/** C-S7 */
export function signedPropertiesDigest(signingTime: string, certDigestB64: string, issuerName: string, serialDecimal: string): string {
  return signedPropertiesDigestOf(signedPropertiesString(signingTime, certDigestB64, issuerName, serialDecimal));
}

/** سلسلة SignedProperties كما هي مضمَّنة في مستند (بعد دفع النطاقات) — للتحقق الذاتي والاختبار. */
export function embeddedSignedPropertiesString(doc: XmlDocument, slots: SignatureSlots): string {
  return pushDownNamespaces(doc, slots.signedProperties);
}

/** قيم الخانات الحالية (نصّاً) — للاختبار والتدقيق. */
export function slotTexts(slots: SignatureSlots): Record<keyof SignatureSlots, string> {
  const out = {} as Record<keyof SignatureSlots, string>;
  for (const k of Object.keys(slots) as Array<keyof SignatureSlots>) out[k] = k === 'signedProperties' ? '' : directText(slots[k]);
  return out;
}
