// ============================================================================
// ZATCA المرحلة الثانية (Z4) — طلب توقيع الشهادة (CSR، PKCS#10) لوحدة EGS بـder.ts وnode:crypto وحدهما
// ----------------------------------------------------------------------------
// المرجع: report_apis-onboarding §7 وdesign §3 Z4 (جدول الحقول) و§4.4 C-R1. الترميز مطابق بايتاً بايتاً لعيّنة
// CSR الرسمية في Swagger (__fixtures__/z3/compliance-request.json) عدا المفتاح العام والتوقيع — ومطابق لما يبنيه
// CsrGenerationService في حزمة SDK 3.4.8 الرسمية (BouncyCastle، قُرئ محلياً من الـjar):
//   CertificationRequestInfo ::= SEQUENCE {
//     version INTEGER 0,
//     subject: C (PrintableString) ← OU ← O ← CN (UTF8String)، كل قيمة في RDN مستقل وبهذا الترتيب،
//     subjectPKInfo: id-ecPublicKey + secp256k1،
//     attributes [0] IMPLICIT: extensionRequest (1.2.840.113549.1.9.14) SET { Extensions:
//       1) certificateTemplateName 1.3.6.1.4.1.311.20.2 (غير حرجة) = OCTET STRING { UTF8String اسم القالب }
//          (SDK: DisplayText(CONTENT_TYPE_UTF8STRING)؛ دليل FATOORA يكتب PRINTABLESTRING — العيّنة والـSDK يحسمان UTF8)
//       2) subjectAltName 2.5.29.17 (غير حرجة) = GeneralNames { [4] directoryName { SN 2.5.4.4, UID
//          0.9.2342.19200300.100.1.1, title 2.5.4.12, registeredAddress 2.5.4.26, businessCategory 2.5.4.15 } }
//          كلها UTF8String وكل قيمة في RDN مستقل بهذا الترتيب } }
//   التوقيع: ecdsa-with-SHA256 (بلا معاملات) فوق بايتات CertificationRequestInfo بمفتاح secp256k1، DER.
// PEM: أسطر base64 بطول 64 وLF وسطر جديد أخير (كالعيّنة)؛ جسم الواجهة = base64 لنصّ PEM كاملاً (C-R2).
// المدخلات تُفحص بصرامة قبل البناء، والرفض لا القصّ: أي تعديل صامت يُصدر شهادة باسم غير الذي يراه المدير.
// وكل PEM يخرج من الوحدة (buildCsr، assembleCsrPem لموقِّع خارجي) أو يُرمَّز جسماً للواجهة (csrBodyForApi، ومنه طلب مخزَّن)
// يمرّ بـassertZatcaCsr: منحنى secp256k1، توقيع DER يتحقق، الحقول العشرة بقواعدها، والبنية بايتاً بايتاً كقالب الهيئة —
// فلا يُكتشف طلب معيب برفض Invalid-CSR بعد استهلاك رمز OTP (ساعة واحدة).
// ============================================================================

import crypto from 'crypto';
import type { FatooraEnv } from './api';
import { OID as CERT_OID } from './cert';
import {
  DerError, DerNode, TAG, childrenOf, decodeBitString, decodeInteger, decodeOid, decodeString, encBitString, encContext, encInteger,
  encOctetString, encOid, encPrintableString, encSequence, encSet, encUtf8String, expectTag, parseDer,
} from './der';

export const CSR_OID = Object.freeze({
  COUNTRY: '2.5.4.6',
  ORG_UNIT: '2.5.4.11',
  ORG: '2.5.4.10',
  COMMON_NAME: '2.5.4.3',
  /** «SN» في الـSAN هو surname (2.5.4.4) لا serialNumber (2.5.4.5) — كما في العيّنة وRFC4519Style.sn في الـSDK. */
  SERIAL_NUMBER_SN: '2.5.4.4',
  UID: '0.9.2342.19200300.100.1.1',
  TITLE: '2.5.4.12',
  REGISTERED_ADDRESS: '2.5.4.26',
  BUSINESS_CATEGORY: '2.5.4.15',
  EXTENSION_REQUEST: '1.2.840.113549.1.9.14',
  CERTIFICATE_TEMPLATE_NAME: '1.3.6.1.4.1.311.20.2',
  SUBJECT_ALT_NAME: '2.5.29.17',
  EC_PUBLIC_KEY: CERT_OID.EC_PUBLIC_KEY,
  SECP256K1: CERT_OID.SECP256K1,
  ECDSA_WITH_SHA256: CERT_OID.ECDSA_WITH_SHA256,
});

/**
 * اسم قالب الشهادة لكل بيئة. production [FPM p.31 + عيّنة Swagger] وsimulation [FPM p.31] مؤكَّدان.
 * UNVERIFIED(U6): sandbox «TSTZATCA-Code-Signing» — هو ما يكتبه SDK 3.4.8 مع الخيار -nonprod (مقروء من الـjar)،
 * لكن عيّنة Swagger الرسمية لبيئة sandbox نفسها تحمل ZATCA-Code-Signing؛ قبول البوابة يُحسم في G3.
 */
export const CERTIFICATE_TEMPLATE_NAMES: Readonly<Record<FatooraEnv, string>> = Object.freeze({
  sandbox: 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
});

/** خريطة الوظائف «TSCZ»: T قياسية، S مبسّطة، والخانتان الأخيرتان محجوزتان صفراً [S4 §3.3.3]. */
export type FunctionMap = '1000' | '0100' | '1100';
export const FUNCTION_MAPS: readonly FunctionMap[] = Object.freeze(['1000', '0100', '1100'] as FunctionMap[]);

/** المرحلة الثانية للمنشآت السعودية وحدها (سياسة المنصّة كـD9)، فالدولة ثابتة. */
export const CSR_COUNTRY = 'SA';

/** design §3 Z4 CsrParams. */
export interface CsrParams {
  env: FatooraEnv;
  commonName: string;
  serialNumber: string;
  orgName: string;
  orgUnit: string;
  vatNumber: string;
  functionMap: FunctionMap;
  locationAddress: string;
  industry: string;
}

export type CsrParamField = keyof CsrParams;
export type CsrErrorField = CsrParamField | 'params' | 'privateKey' | 'csrPem';

export type CsrErrorCode = 'INVALID_PARAM' | 'INVALID_KEY' | 'INVALID_CSR' | 'SELF_CHECK';

export type CsrParamReason =
  | 'REQUIRED' | 'FORMAT' | 'TOO_LONG' | 'WHITESPACE' | 'CONTROL_CHARACTER' | 'FORBIDDEN_CHARACTER' | 'VAT_GROUP_TIN';

/**
 * خطأ مصنَّف: code ثابت، والحقل وسبب الرفض (لـINVALID_PARAM، ولـINVALID_CSR حين يكون الرفض من قاعدة حقل).
 * INVALID_CSR: طلب مُمرَّر (مخزَّن أو ملصوق) لا تقبله الهيئة. SELF_CHECK: طلب بنيناه نحن (buildCsr/assembleCsrPem)
 * فشل فحصه الذاتي — خلل في الموقِّع أو الكود لا في مدخلات المدير. الرسالة لا تحمل مادة مفتاح أبداً.
 */
export class CsrError extends Error {
  readonly code: CsrErrorCode;
  readonly field?: CsrErrorField;
  readonly reason?: CsrParamReason;
  /** الشرح وحده بلا بادئة «CSR <code> <field>:» (لإعادة التصنيف دون تكرار البادئة). */
  readonly detail: string;
  constructor(code: CsrErrorCode, message: string, extra: { field?: CsrErrorField; reason?: CsrParamReason } = {}) {
    super(`CSR ${code}${extra.field ? ` ${extra.field}` : ''}: ${message}`);
    this.name = 'CsrError';
    this.code = code;
    this.detail = message;
    if (extra.field !== undefined) this.field = extra.field;
    if (extra.reason !== undefined) this.reason = extra.reason;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// قواعد التحقق
// ─────────────────────────────────────────────────────────────────────────────

/**
 * حدود الطول بنقاط يونيكود. serialNumber ≤ 64 [STAFF D9188] وregisteredAddress ≤ 64 [S15] مُبلَّغ عنهما من الهيئة.
 * UNVERIFIED: البقية حدود X.520 العليا (ub-common-name/organization-name/organizational-unit-name = 64،
 * ub-business-category = 128) التي تفرضها جهات إصدار من نوع ADCS افتراضياً؛ الـSDK نفسه لا يفحص الطول.
 */
export const CSR_MAX_CHARS: Readonly<Record<'commonName' | 'orgName' | 'orgUnit' | 'serialNumber' | 'locationAddress' | 'industry', number>> = Object.freeze({
  commonName: 64,
  orgName: 64,
  orgUnit: 64,
  serialNumber: 64,
  locationAddress: 64,
  industry: 128,
});

/**
 * المحارف الممنوعة في CN وOU وO والموقع والقطاع: specialCharacterRegex في application.properties بحزمة SDK 3.4.8
 * (فحص جهة العميل مؤكَّد من الـjar؛ UNVERIFIED أن بوابة الهيئة تفرضه). الرقم التسلسلي يُمنع فيه «=» وحده (كالـSDK).
 * القرار: **رفض** لا حذف — design §3 Z4 كتب «Strip»، لكن الحذف الصامت يغيّر الاسم القانوني/الموقع في الشهادة عمّا
 * أدخله المدير دون علمه؛ الرفض برسالة تسمّي الحقل يجعله يختار نصاً صريحاً للشهادة.
 */
export const CSR_FORBIDDEN_CHARACTERS = /[!@#$%&*_<]/;

/**
 * كل محرف لا يُرى أو يغيّر العرض دون أن يظهر — فالقيمة في الشهادة هي حرفياً ما يراه المدير:
 *   \p{Cc}  تحكّم C0 وDEL وC1.
 *   \p{Cf}  محارف التنسيق كلها، ومنها: علامتا الاتجاه LRM/RLM (U+200E/U+200F) وعلامة الحرف العربي ALM (U+061C) —
 *           تكثر في نصوص عربية منسوخة من Word/PDF وتعيد ترتيب عرض الأرقام و«-» — والتضمين/التجاوز (U+202A–U+202E)
 *           والعزل (U+2066–U+2069) وZWSP (U+200B) ووصل الكلمات والعوامل الخفية (U+2060–U+2064) وأشكال الأرقام والتشكيل
 *           المهملة (U+206A–U+206F) والشرطة اللينة (U+00AD) وBOM (U+FEFF) والتعليق الخطّي (U+FFF9–U+FFFB) والوسوم (U+E00xx)،
 *           وعلامات الأعداد العربية المسبقة (U+0600–U+0605، U+06DD) التي لا مكان لها في اسم أو عنوان.
 *   \p{Zl}\p{Zp}  فاصلا السطر والفقرة.
 * القرار في ZWNJ/ZWJ (U+200C/U+200D، من \p{Cf}): **رفض** — لا تحتاجهما الكتابة العربية في الأسماء والعناوين، ويجعلان
 * اسمين متطابقين بصرياً مختلفين بايتياً في الشهادة. التشكيل (U+064B…، فئة Mn) والتطويل (U+0640) مسموحان لأنهما مرئيان.
 * مكتوبة بخصائص يونيكود لا حرفياً (لا محارف خفية في المصدر).
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SERIAL_RE = /^1-(.+)\|2-(.+)\|3-(.+)$/;
const VAT_RE = /^3[0-9]{13}3$/;

const FIELD_AR: Record<CsrParamField, string> = {
  env: 'بيئة الربط',
  commonName: 'الاسم الشائع للوحدة (CN)',
  serialNumber: 'الرقم التسلسلي للوحدة (SN)',
  orgName: 'اسم المنشأة (O)',
  orgUnit: 'اسم الفرع/الوحدة التنظيمية (OU)',
  vatNumber: 'الرقم الضريبي (UID)',
  functionMap: 'أنواع الفواتير (title)',
  locationAddress: 'عنوان الوحدة (registeredAddress)',
  industry: 'قطاع النشاط (businessCategory)',
};

const codePoints = (s: string) => Array.from(s).length;

function bad(field: CsrParamField, reason: CsrParamReason, message: string): never {
  throw new CsrError('INVALID_PARAM', `${FIELD_AR[field]}: ${message}`, { field, reason });
}

function textField(p: Record<string, unknown>, field: keyof typeof CSR_MAX_CHARS, forbidSpecial: boolean): string {
  const v = p[field];
  if (typeof v !== 'string' || v.trim() === '') bad(field, 'REQUIRED', 'مطلوب');
  const s = v as string;
  if (s !== s.trim()) bad(field, 'WHITESPACE', 'فراغ في البداية أو النهاية — احذفه');
  if (CONTROL.test(s)) bad(field, 'CONTROL_CHARACTER', 'يحتوي محارف تحكّم أو سطراً جديداً أو علامات اتجاه/تنسيق خفية (غالباً من نصّ منسوخ من Word أو PDF) — أعد كتابته يدوياً');
  if (LONE_SURROGATE.test(s)) bad(field, 'FORMAT', 'نصّ يونيكود غير صالح');
  if (codePoints(s) > CSR_MAX_CHARS[field]) bad(field, 'TOO_LONG', `أطول من ${CSR_MAX_CHARS[field]} محرفاً`);
  if (forbidSpecial) {
    const m = CSR_FORBIDDEN_CHARACTERS.exec(s);
    if (m) bad(field, 'FORBIDDEN_CHARACTER', `المحرف «${m[0]}» غير مسموح (الممنوع: ! @ # $ % & * _ <)`);
    // BouncyCastle (مولّد الـSDK) يحذف «\» البادئة من القيمة؛ نرفضها كي لا يختلف ما نرمّزه عمّا يرمّزه المرجع
    if (s.startsWith('\\')) bad(field, 'FORBIDDEN_CHARACTER', 'لا يبدأ بالمحرف «\\»');
  }
  return s;
}

/** يفحص المدخلات ويعيد نسخة مطبَّعة الأنواع. يرمي CsrError(INVALID_PARAM) بأول حقل مخالف (field + reason). */
export function validateCsrParams(params: CsrParams): CsrParams {
  if (!params || typeof params !== 'object') throw new CsrError('INVALID_PARAM', 'مدخلات CSR مفقودة', { field: 'params', reason: 'REQUIRED' });
  const p = params as unknown as Record<string, unknown>;

  const env = p.env;
  if (typeof env !== 'string' || !Object.prototype.hasOwnProperty.call(CERTIFICATE_TEMPLATE_NAMES, env)) {
    bad('env', env === undefined ? 'REQUIRED' : 'FORMAT', 'يجب أن تكون sandbox أو simulation أو production');
  }

  const vat = p.vatNumber;
  if (typeof vat !== 'string' || vat === '') bad('vatNumber', 'REQUIRED', 'مطلوب');
  if (!VAT_RE.test(vat as string)) bad('vatNumber', 'FORMAT', 'يجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3');

  const fm = p.functionMap;
  if (typeof fm !== 'string' || fm === '') bad('functionMap', 'REQUIRED', 'مطلوب');
  // الـSDK يقبل ^[0-1]{4}$؛ نقصره على ما تدعمه المنصّة وتعرف الهيئة خطوات امتثاله (1000/0100/1100)
  if (!(FUNCTION_MAPS as readonly string[]).includes(fm as string)) bad('functionMap', 'FORMAT', 'يجب أن تكون 1000 أو 0100 أو 1100');

  const commonName = textField(p, 'commonName', true);
  const orgName = textField(p, 'orgName', true);
  const orgUnit = textField(p, 'orgUnit', true);
  // مجموعة ضريبية (الخانة 11 = 1): OU = الرقم المميّز للعضو بعشر خانات [S4 p.27، SEC Table 1؛ الـSDK يفحص الطول وحده]
  if ((vat as string)[10] === '1' && !/^[0-9]{10}$/.test(orgUnit)) {
    bad('orgUnit', 'VAT_GROUP_TIN', 'الرقم الضريبي لمجموعة ضريبية (الخانة 11 = 1): يجب أن يكون OU الرقم المميّز للعضو بعشرة أرقام');
  }
  const serialNumber = textField(p, 'serialNumber', false);
  if (serialNumber.includes('=')) bad('serialNumber', 'FORBIDDEN_CHARACTER', 'المحرف «=» غير مسموح');
  if (!SERIAL_RE.test(serialNumber)) bad('serialNumber', 'FORMAT', 'يجب أن يكون بالصيغة 1-<المزوّد>|2-<الطراز/الإصدار>|3-<التسلسلي>');
  const locationAddress = textField(p, 'locationAddress', true);
  const industry = textField(p, 'industry', true);

  return {
    env: env as FatooraEnv, commonName, serialNumber, orgName, orgUnit, vatNumber: vat as string,
    functionMap: fm as FunctionMap, locationAddress, industry,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// قيم التصميم لوحدة الخادم (design §3 Z4 جدول CSR)
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** SN = "1-FieldSales|2-EGS1|3-<uuid الوحدة>" (58 محرفاً، دون حدّ 64). */
export function egsSerialNumber(unitUuid: string): string {
  if (typeof unitUuid !== 'string' || !UUID_RE.test(unitUuid)) bad('serialNumber', 'FORMAT', 'معرّف الوحدة يجب أن يكون UUID');
  return `1-FieldSales|2-EGS1|3-${unitUuid.toLowerCase()}`;
}

/** CN = "FS-<vat>-<unitShortId>". unitShortId: 1–40 محرفاً من [A-Za-z0-9-]. */
export function egsCommonName(vatNumber: string, unitShortId: string): string {
  if (typeof vatNumber !== 'string' || !VAT_RE.test(vatNumber)) bad('vatNumber', 'FORMAT', 'يجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3');
  if (typeof unitShortId !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(unitShortId)) bad('commonName', 'FORMAT', 'معرّف الوحدة المختصر 1–40 محرفاً من [A-Za-z0-9-]');
  return `FS-${vatNumber}-${unitShortId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// البناء
// ─────────────────────────────────────────────────────────────────────────────

const rdn = (oid: string, value: Uint8Array) => encSet([encSequence([encOid(oid), value])]);

/** SubjectPublicKeyInfo لمفتاح EC على secp256k1 بالضبط (يرمي INVALID_KEY لغيره). */
function assertSecp256k1Spki(spkiDer: Uint8Array): void {
  try {
    const spki = childrenOf(expectTag(parseDer(spkiDer, 16), TAG.SEQUENCE, 'SubjectPublicKeyInfo'));
    const alg = childrenOf(expectTag(spki[0], TAG.SEQUENCE, 'AlgorithmIdentifier'));
    if (spki.length !== 2 || alg.length !== 2 || decodeOid(alg[0]) !== CSR_OID.EC_PUBLIC_KEY || decodeOid(alg[1]) !== CSR_OID.SECP256K1) {
      throw new Error('curve');
    }
    const bits = decodeBitString(spki[1]);
    if (bits.unusedBits !== 0 || bits.bytes.length !== 65 || bits.bytes[0] !== 0x04) throw new Error('point');
  } catch {
    throw new CsrError('INVALID_KEY', 'المفتاح العام ليس EC على secp256k1 بصيغة نقطة غير مضغوطة', { field: 'privateKey' });
  }
}

/**
 * CertificationRequestInfo بصيغة DER من مدخلات مفحوصة ومفتاح عام (SPKI DER). مُصدَّر للاختبار ولموقِّع خارجي
 * مستقبلاً (KMS): يُوقَّع ناتجه بـecdsa-with-SHA256 ثم يُلفّ بـassembleCsrPem.
 */
export function buildCertificationRequestInfo(params: CsrParams, subjectPublicKeyInfoDer: Uint8Array): Uint8Array {
  const p = validateCsrParams(params);
  if (!(subjectPublicKeyInfoDer instanceof Uint8Array)) throw new CsrError('INVALID_KEY', 'SPKI مفقود', { field: 'privateKey' });
  assertSecp256k1Spki(subjectPublicKeyInfoDer);

  const subject = encSequence([
    rdn(CSR_OID.COUNTRY, encPrintableString(CSR_COUNTRY)),
    rdn(CSR_OID.ORG_UNIT, encUtf8String(p.orgUnit)),
    rdn(CSR_OID.ORG, encUtf8String(p.orgName)),
    rdn(CSR_OID.COMMON_NAME, encUtf8String(p.commonName)),
  ]);
  const templateExt = encSequence([
    encOid(CSR_OID.CERTIFICATE_TEMPLATE_NAME),
    encOctetString(encUtf8String(CERTIFICATE_TEMPLATE_NAMES[p.env])),
  ]);
  const dirName = encSequence([
    rdn(CSR_OID.SERIAL_NUMBER_SN, encUtf8String(p.serialNumber)),
    rdn(CSR_OID.UID, encUtf8String(p.vatNumber)),
    rdn(CSR_OID.TITLE, encUtf8String(p.functionMap)),
    rdn(CSR_OID.REGISTERED_ADDRESS, encUtf8String(p.locationAddress)),
    rdn(CSR_OID.BUSINESS_CATEGORY, encUtf8String(p.industry)),
  ]);
  const sanExt = encSequence([
    encOid(CSR_OID.SUBJECT_ALT_NAME),
    encOctetString(encSequence([encContext(4, dirName)])), // GeneralNames { directoryName [4] EXPLICIT Name }
  ]);
  const extensionRequest = encSequence([
    encOid(CSR_OID.EXTENSION_REQUEST),
    encSet([encSequence([templateExt, sanExt])]),
  ]);
  return encSequence([
    encInteger(0),
    subject,
    subjectPublicKeyInfoDer,
    encContext(0, [extensionRequest]), // attributes [0] IMPLICIT SET OF Attribute (عنصر واحد)
  ]);
}

/** طول توقيع خام r||s لمنحنى 256 بت (IEEE P1363) — ناتج WebCrypto وكثير من خدمات KMS بدل DER. */
const P1363_SIGNATURE_BYTES = 64;

/** ECDSA-Sig-Value بصيغة DER صارمة: SEQUENCE { INTEGER r, INTEGER s } موجبان بأقصر ترميز و≤ 33 بايتاً، بلا بايت زائد. */
function isDerEcdsaSignature(sig: Uint8Array): boolean {
  try {
    const parts = childrenOf(expectTag(parseDer(sig, 3), TAG.SEQUENCE, 'ECDSA-Sig-Value'));
    return parts.length === 2 && parts.every(n => decodeInteger(n, 33) > BigInt(0));
  } catch {
    return false;
  }
}

/**
 * توقيع DER كما هو؛ وخام r||s بـ64 بايتاً (ليس DER صالحاً) يُحوَّل إلى ECDSA-Sig-Value. أي شكل آخر يمرّ كما هو فيرفضه
 * الفحص الذاتي. التحويل لا يخفي خطأً: توقيع خام من مفتاح آخر يبقى لا يتحقق ⇒ SELF_CHECK.
 */
function ecdsaSignatureDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== P1363_SIGNATURE_BYTES || isDerEcdsaSignature(sig)) return sig;
  return encSequence([encInteger(sig.subarray(0, 32)), encInteger(sig.subarray(32))]);
}

/** CertificationRequest ⇒ PEM (أسطر 64، LF، سطر أخير) بلا فحص؛ لا يخرج ناتجه من الوحدة إلا عبر selfChecked. */
function assemblePem(certificationRequestInfoDer: Uint8Array, signatureDer: Uint8Array): string {
  const der = encSequence([certificationRequestInfoDer, encSequence([encOid(CSR_OID.ECDSA_WITH_SHA256)]), encBitString(signatureDer)]);
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
}

/** طلب بنيناه نحن: assertZatcaCsr، وأي رفض INVALID_CSR يُعاد تصنيفه SELF_CHECK (خلل موقِّع/كود لا مدخل مدير). */
function selfChecked(pem: string, expected: ZatcaCsrExpectation): string {
  try {
    assertZatcaCsr(pem, expected);
  } catch (e) {
    if (e instanceof CsrError && e.code === 'INVALID_CSR') {
      throw new CsrError('SELF_CHECK', e.detail, e.reason === undefined ? {} : { reason: e.reason });
    }
    throw e;
  }
  return pem;
}

/**
 * لموقِّع خارجي (KMS): يلفّ CertificationRequestInfo (من buildCertificationRequestInfo) وتوقيع ecdsa-with-SHA256 فوق
 * بايتاتها في CertificationRequest ويعيد PEM. التوقيع DER (ECDSA-Sig-Value)، أو خام r||s بـ64 بايتاً فيُحوَّل إلى DER.
 * الناتج يمرّ بـassertZatcaCsr قبل الإعادة: توقيع لا يتحقق بالمفتاح المضمَّن (مفتاح آخر، بايتات عشوائية، DER غير قانوني)
 * أو CRI لا تطابق قالب الهيئة ⇒ CsrError(SELF_CHECK) — بدل PEM يبدو سليماً لا يُكتشف إلا برفض Invalid-CSR بعد استهلاك OTP.
 */
export function assembleCsrPem(certificationRequestInfoDer: Uint8Array, signature: Uint8Array): string {
  if (!(certificationRequestInfoDer instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
    throw new CsrError('SELF_CHECK', 'CertificationRequestInfo والتوقيع يجب أن يكونا بايتات (Uint8Array)');
  }
  return selfChecked(assemblePem(certificationRequestInfoDer, ecdsaSignatureDer(signature)), {});
}

function loadPrivateKey(privateKey: string | crypto.KeyObject): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
  } catch {
    // لا نُلحق رسالة OpenSSL ولا أي جزء من المدخل
    throw new CsrError('INVALID_KEY', 'تعذّر تحميل المفتاح الخاص (المتوقَّع PEM بصيغة SEC1 أو PKCS#8)', { field: 'privateKey' });
  }
  if (key.type !== 'private') throw new CsrError('INVALID_KEY', 'المطلوب مفتاح خاص لا عام', { field: 'privateKey' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp256k1') {
    // UNVERIFIED(U6/R11): قبول الهيئة لـprime256v1 — لا نرسل إلا secp256k1 كما في العيّنة والـSDK
    throw new CsrError('INVALID_KEY', 'المفتاح يجب أن يكون EC على منحنى secp256k1', { field: 'privateKey' });
  }
  return key;
}

/**
 * design §3 Z4: buildCsr(params, privateKey) ⇒ PEM. المفتاح PEM (SEC1/PKCS#8) أو KeyObject خاص على secp256k1.
 * تحقّق ذاتي قبل الإعادة (assertZatcaCsr): قبول الهيئة، وكل حقل = المدخلات، والتوقيع يتحقق، والمفتاح العام = مفتاح المدخل.
 */
export function buildCsr(params: CsrParams, privateKey: string | crypto.KeyObject): string {
  const p = validateCsrParams(params);
  const key = loadPrivateKey(privateKey);
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const cri = buildCertificationRequestInfo(p, spki);
  const signature = crypto.sign('sha256', cri, { key, dsaEncoding: 'der' });
  return selfChecked(assemblePem(cri, signature), { params: p, subjectPublicKeyInfoDer: spki });
}

/**
 * جسم POST /compliance وPATCH /production/csids: base64 لنصّ PEM كاملاً بما فيه سطرا BEGIN/END (C-R2، report §4.1).
 * لا يُرمَّز إلا طلب يجتاز assertZatcaCsr — ومنه csrPem مخزَّن يُعاد إرساله — وإلا CsrError(INVALID_CSR) قبل أن يُستهلك
 * رمز OTP (ساعة واحدة) بطلب سترفضه الهيئة بـInvalid-CSR.
 */
export function csrBodyForApi(csrPem: string): string {
  assertZatcaCsr(csrPem);
  return Buffer.from(csrPem, 'utf8').toString('base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// القراءة (فحص ذاتي، اختبارات، وعرض CSR مخزَّن)
// ─────────────────────────────────────────────────────────────────────────────

/** قيمة سمة في اسم: OID ووسم النوع (TAG.UTF8_STRING …) والنصّ. */
export interface CsrNameValue {
  oid: string;
  tag: number;
  value: string;
}

export interface CsrExtension {
  oid: string;
  critical: boolean;
  /** محتوى OCTET STRING (قيمة الامتداد بصيغة DER). */
  valueDer: Uint8Array;
}

export interface ParsedCsr {
  der: Uint8Array;
  certificationRequestInfoDer: Uint8Array;
  version: number;
  /** الاسم بالترتيب كما في الطلب؛ كل RDN بقيمة واحدة. */
  subject: CsrNameValue[];
  subjectPublicKeyInfoDer: Uint8Array;
  publicKeyAlgorithmOid: string;
  publicKeyCurveOid: string;
  /** OIDs السمات في [0] بالترتيب. */
  attributeOids: string[];
  extensions: CsrExtension[];
  /** قالب الشهادة: وسم النوع والنصّ (null إن غاب الامتداد). */
  templateName: { tag: number; value: string } | null;
  /** قيم directoryName الوحيد في subjectAltName بالترتيب (فارغة إن غاب). */
  subjectAltName: CsrNameValue[];
  signatureAlgorithmOid: string;
  signatureDer: Uint8Array;
  /** توقيع ecdsa-with-SHA256 فوق CertificationRequestInfo يتحقق بالمفتاح العام المضمَّن. */
  signatureValid: boolean;
  /** الحقول التجارية مستخرجة بالـOID (undefined إن غابت أو تكرّرت). */
  fields: {
    country?: string; orgUnit?: string; orgName?: string; commonName?: string;
    serialNumber?: string; vatNumber?: string; functionMap?: string; locationAddress?: string; industry?: string;
    templateName?: string;
  };
}

export const MAX_CSR_PEM_CHARS = 16384;
const CSR_PEM_RE = /^-----BEGIN CERTIFICATE REQUEST-----\r?\n((?:[A-Za-z0-9+/=]{1,76}\r?\n){1,256})-----END CERTIFICATE REQUEST-----(?:\r?\n)?$/;
const MAX_CSR_DER_NODES = 256;

function nameValues(name: DerNode, what: string): CsrNameValue[] {
  return childrenOf(expectTag(name, TAG.SEQUENCE, what), what).map(set => {
    const atvs = childrenOf(expectTag(set, TAG.SET, `${what} RDN`));
    if (atvs.length !== 1) throw new DerError(`${what}: RDN متعدّد القيم غير مدعوم`, set.offset);
    const parts = childrenOf(expectTag(atvs[0], TAG.SEQUENCE, `${what} AttributeTypeAndValue`));
    if (parts.length !== 2) throw new DerError(`${what}: AttributeTypeAndValue غير صالح`, atvs[0].offset);
    return { oid: decodeOid(parts[0]), tag: parts[1].tag, value: decodeString(parts[1]) };
  });
}

const single = (values: CsrNameValue[], oid: string): string | undefined => {
  const hits = values.filter(v => v.oid === oid);
  return hits.length === 1 ? hits[0].value : undefined;
};

/** يحلّل PEM لـCSR بصرامة DER. يرمي CsrError(INVALID_CSR) عند أي خلل بنيوي؛ التوقيع الخاطئ لا يرمي (signatureValid=false). */
export function parseCsr(csrPem: string): ParsedCsr {
  try {
    return parseCsrUnsafe(csrPem);
  } catch (e) {
    if (e instanceof CsrError) throw e;
    throw new CsrError('INVALID_CSR', e instanceof DerError ? e.message : 'بنية CSR غير صالحة', { field: 'csrPem' });
  }
}

function parseCsrUnsafe(csrPem: string): ParsedCsr {
  if (typeof csrPem !== 'string' || csrPem.length > MAX_CSR_PEM_CHARS) throw new CsrError('INVALID_CSR', 'CSR يجب أن يكون نصّ PEM محدود الطول', { field: 'csrPem' });
  const m = CSR_PEM_RE.exec(csrPem);
  if (!m) throw new CsrError('INVALID_CSR', 'ليس PEM من نوع CERTIFICATE REQUEST', { field: 'csrPem' });
  const b64 = m[1].replace(/\r?\n/g, '');
  const der = Buffer.from(b64, 'base64');
  if (der.toString('base64') !== b64) throw new CsrError('INVALID_CSR', 'محتوى PEM ليس base64 قانونياً', { field: 'csrPem' });

  const root = childrenOf(expectTag(parseDer(der, MAX_CSR_DER_NODES), TAG.SEQUENCE, 'CertificationRequest'));
  if (root.length !== 3) throw new DerError('CertificationRequest يجب أن يضمّ 3 عناصر');
  const [criNode, sigAlgNode, sigNode] = root;
  const cri = childrenOf(expectTag(criNode, TAG.SEQUENCE, 'CertificationRequestInfo'));
  if (cri.length !== 4) throw new DerError('CertificationRequestInfo يجب أن يضمّ 4 عناصر (version, subject, spki, [0])');
  const version = decodeInteger(cri[0], 4);
  if (version !== BigInt(0)) throw new DerError('إصدار CSR يجب أن يكون 0');
  const subject = nameValues(cri[1], 'subject');

  const spkiParts = childrenOf(expectTag(cri[2], TAG.SEQUENCE, 'SubjectPublicKeyInfo'));
  const spkiAlg = childrenOf(expectTag(spkiParts[0], TAG.SEQUENCE, 'AlgorithmIdentifier'));
  if (spkiParts.length !== 2 || spkiAlg.length !== 2) throw new DerError('SubjectPublicKeyInfo غير صالح');
  const publicKeyAlgorithmOid = decodeOid(spkiAlg[0]);
  const publicKeyCurveOid = decodeOid(spkiAlg[1]);
  decodeBitString(spkiParts[1]);

  const attrs = expectTag(cri[3], 0xa0, 'attributes [0]');
  const attributeOids: string[] = [];
  const extensions: CsrExtension[] = [];
  for (const attr of childrenOf(attrs, 'attributes')) {
    const [oidNode, valuesNode, ...rest] = childrenOf(expectTag(attr, TAG.SEQUENCE, 'Attribute'));
    if (!oidNode || !valuesNode || rest.length) throw new DerError('Attribute غير صالح', attr.offset);
    const oid = decodeOid(oidNode);
    attributeOids.push(oid);
    const values = childrenOf(expectTag(valuesNode, TAG.SET, 'Attribute values'));
    if (oid !== CSR_OID.EXTENSION_REQUEST) continue;
    if (values.length !== 1) throw new DerError('extensionRequest يجب أن يحمل قيمة واحدة', valuesNode.offset);
    for (const ext of childrenOf(expectTag(values[0], TAG.SEQUENCE, 'Extensions'))) {
      const parts = childrenOf(expectTag(ext, TAG.SEQUENCE, 'Extension'));
      let critical = false;
      let valueNode: DerNode | undefined;
      if (parts.length === 2) valueNode = parts[1];
      else if (parts.length === 3) {
        expectTag(parts[1], TAG.BOOLEAN, 'Extension.critical');
        if (parts[1].value.length !== 1 || (parts[1].value[0] !== 0xff && parts[1].value[0] !== 0x00)) throw new DerError('BOOLEAN غير صالح', parts[1].offset);
        // DER: القيمة الافتراضية FALSE لا تُكتب
        if (parts[1].value[0] === 0x00) throw new DerError('critical=FALSE لا يُكتب في DER', parts[1].offset);
        critical = true;
        valueNode = parts[2];
      } else {
        throw new DerError('Extension غير صالح', ext.offset);
      }
      extensions.push({ oid: decodeOid(parts[0]), critical, valueDer: Uint8Array.from(expectTag(valueNode, TAG.OCTET_STRING, 'extnValue').value) });
    }
  }

  const sigAlg = childrenOf(expectTag(sigAlgNode, TAG.SEQUENCE, 'signatureAlgorithm'));
  if (sigAlg.length !== 1) throw new DerError('ecdsa-with-SHA256 بلا معاملات: عنصر واحد فقط', sigAlgNode.offset);
  const signatureAlgorithmOid = decodeOid(sigAlg[0]);
  const sigBits = decodeBitString(sigNode);
  if (sigBits.unusedBits !== 0) throw new DerError('BIT STRING التوقيع بحشو', sigNode.offset);
  const signatureDer = Uint8Array.from(sigBits.bytes);

  let templateName: ParsedCsr['templateName'] = null;
  let subjectAltName: CsrNameValue[] = [];
  const onlyExt = (oid: string) => {
    const hits = extensions.filter(e => e.oid === oid);
    if (hits.length > 1) throw new DerError(`امتداد مكرّر ${oid}`);
    return hits[0];
  };
  const tmpl = onlyExt(CSR_OID.CERTIFICATE_TEMPLATE_NAME);
  if (tmpl) {
    const n = parseDer(tmpl.valueDer, 4);
    templateName = { tag: n.tag, value: decodeString(n) };
  }
  const san = onlyExt(CSR_OID.SUBJECT_ALT_NAME);
  if (san) {
    const names = childrenOf(expectTag(parseDer(san.valueDer, 128), TAG.SEQUENCE, 'GeneralNames'));
    if (names.length !== 1 || names[0].tag !== 0xa4) throw new DerError('subjectAltName يجب أن يحمل directoryName واحداً');
    const inner = childrenOf(names[0], 'directoryName');
    if (inner.length !== 1) throw new DerError('directoryName يجب أن يلفّ Name واحداً');
    subjectAltName = nameValues(inner[0], 'subjectAltName');
  }

  const criDer = Uint8Array.from(criNode.raw);
  const spkiDer = Uint8Array.from(cri[2].raw);
  let signatureValid = false;
  if (signatureAlgorithmOid === CSR_OID.ECDSA_WITH_SHA256) {
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
      signatureValid = crypto.verify('sha256', criDer, pub, signatureDer);
    } catch {
      signatureValid = false;
    }
  }

  return {
    der: Uint8Array.from(der),
    certificationRequestInfoDer: criDer,
    version: Number(version),
    subject,
    subjectPublicKeyInfoDer: spkiDer,
    publicKeyAlgorithmOid,
    publicKeyCurveOid,
    attributeOids,
    extensions,
    templateName,
    subjectAltName,
    signatureAlgorithmOid,
    signatureDer,
    signatureValid,
    fields: {
      country: single(subject, CSR_OID.COUNTRY),
      orgUnit: single(subject, CSR_OID.ORG_UNIT),
      orgName: single(subject, CSR_OID.ORG),
      commonName: single(subject, CSR_OID.COMMON_NAME),
      serialNumber: single(subjectAltName, CSR_OID.SERIAL_NUMBER_SN),
      vatNumber: single(subjectAltName, CSR_OID.UID),
      functionMap: single(subjectAltName, CSR_OID.TITLE),
      locationAddress: single(subjectAltName, CSR_OID.REGISTERED_ADDRESS),
      industry: single(subjectAltName, CSR_OID.BUSINESS_CATEGORY),
      templateName: templateName?.value,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// فحص قبول الهيئة قبل الإرسال — مشترك بين buildCsr وassembleCsrPem وcsrBodyForApi
// ─────────────────────────────────────────────────────────────────────────────

export interface ZatcaCsrExpectation {
  /** مدخلات الوحدة: تُفحص بـvalidateCsrParams ثم يُطابَق كل حقل (والقالب عبر env) مع ما في الطلب. */
  params?: CsrParams;
  /** SubjectPublicKeyInfo (DER) لمفتاح الوحدة الذي سيوقّع الفواتير. */
  subjectPublicKeyInfoDer?: Uint8Array;
}

export interface ZatcaCsr {
  parsed: ParsedCsr;
  /** الحقول العشرة مستخرجة من الطلب ومفحوصة بقواعد validateCsrParams (env من اسم القالب). */
  params: CsrParams;
}

const TEMPLATE_ENVS: ReadonlyMap<string, FatooraEnv> = new Map(
  (Object.keys(CERTIFICATE_TEMPLATE_NAMES) as FatooraEnv[]).map((env): [string, FatooraEnv] => [CERTIFICATE_TEMPLATE_NAMES[env], env]),
);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

function invalidCsr(message: string, reason?: CsrParamReason): never {
  throw new CsrError('INVALID_CSR', message, reason === undefined ? { field: 'csrPem' } : { field: 'csrPem', reason });
}

/**
 * يرمي CsrError(INVALID_CSR) لكل طلب لن تقبله الهيئة، ويعيد التحليل والحقول لطلب مقبول. الشروط بالترتيب:
 *   1) ecdsa-with-SHA256، ومفتاح id-ecPublicKey على secp256k1 بنقطة غير مضغوطة.
 *   2) التوقيع ECDSA-Sig-Value بصيغة DER صارمة (لا r||s خام) ويتحقق بالمفتاح المضمَّن فوق بايتات CRI.
 *   3) الحقول العشرة موجودة مرة واحدة: C=SA وOU وO وCN، وSN وUID وtitle وregisteredAddress وbusinessCategory، وقالب شهادة
 *      معروف — وقيمها تجتاز validateCsrParams (المحارف الخفية والممنوعة، والأطوال، وصيغ VAT وSN والخريطة).
 *   4) البنية القانونية: CRI بايتاً بايتاً = buildCertificationRequestInfo للحقول والمفتاح نفسيهما (المطابقة للعيّنة الرسمية)
 *      ⇒ يُرفض ترتيب آخر، أو نوع سلسلة آخر (C بـUTF8String، قالب بـPrintableString)، أو سمة/امتداد زائد، أو امتداد حرج.
 *   5) المتوقَّع إن مُرِّر: كل حقل = المدخلات، والمفتاح العام = مفتاح الوحدة.
 * يأخذ نصّ PEM لا ParsedCsr: الحكم على البايتات نفسها لا على كائن قد يُعدَّل بعد التحليل.
 */
export function assertZatcaCsr(csrPem: string, expected: ZatcaCsrExpectation = {}): ZatcaCsr {
  if (expected === null || typeof expected !== 'object') {
    throw new CsrError('INVALID_PARAM', 'توقّعات الفحص يجب أن تكون كائناً', { field: 'params', reason: 'FORMAT' });
  }
  const parsed = parseCsr(csrPem);

  // 1) الخوارزميات والمفتاح
  if (parsed.signatureAlgorithmOid !== CSR_OID.ECDSA_WITH_SHA256) invalidCsr(`خوارزمية التوقيع ${parsed.signatureAlgorithmOid} ليست ecdsa-with-SHA256`);
  if (parsed.publicKeyAlgorithmOid !== CSR_OID.EC_PUBLIC_KEY || parsed.publicKeyCurveOid !== CSR_OID.SECP256K1) {
    invalidCsr(`المفتاح العام ليس EC على secp256k1 (الخوارزمية ${parsed.publicKeyAlgorithmOid}، المنحنى ${parsed.publicKeyCurveOid})`);
  }
  try {
    assertSecp256k1Spki(parsed.subjectPublicKeyInfoDer);
  } catch {
    invalidCsr('المفتاح العام ليس نقطة secp256k1 غير مضغوطة (65 بايتاً تبدأ بـ04)');
  }

  // 2) التوقيع
  if (!isDerEcdsaSignature(parsed.signatureDer)) invalidCsr('التوقيع ليس ECDSA-Sig-Value بصيغة DER (توقيع خام r||s أو بايتات أخرى؟)');
  if (parsed.signatureValid !== true) invalidCsr('التوقيع لا يتحقق بالمفتاح العام المضمَّن (وُقّع بمفتاح آخر أو عُدّل الطلب بعد التوقيع)');

  // 3) الحقول العشرة وقيمها
  const f = parsed.fields;
  const present: Array<[string, string | undefined]> = [
    ['C', f.country], ['OU', f.orgUnit], ['O', f.orgName], ['CN', f.commonName], ['SN', f.serialNumber], ['UID', f.vatNumber],
    ['title', f.functionMap], ['registeredAddress', f.locationAddress], ['businessCategory', f.industry], ['certificateTemplateName', f.templateName],
  ];
  const missing = present.filter(([, v]) => v === undefined).map(([name]) => name);
  if (missing.length) invalidCsr(`حقول مفقودة أو مكرّرة: ${missing.join('، ')}`);
  if (f.country !== CSR_COUNTRY) invalidCsr(`الدولة (C) يجب أن تكون ${CSR_COUNTRY}`);
  const env = TEMPLATE_ENVS.get(f.templateName as string);
  if (env === undefined) invalidCsr(`اسم قالب الشهادة غير معروف — المسموح: ${[...TEMPLATE_ENVS.keys()].join('، ')}`);
  let params: CsrParams;
  try {
    params = validateCsrParams({
      env, commonName: f.commonName as string, serialNumber: f.serialNumber as string, orgName: f.orgName as string,
      orgUnit: f.orgUnit as string, vatNumber: f.vatNumber as string, functionMap: f.functionMap as FunctionMap,
      locationAddress: f.locationAddress as string, industry: f.industry as string,
    });
  } catch (e) {
    if (e instanceof CsrError && e.code === 'INVALID_PARAM') invalidCsr(`قيمة مرفوضة في الطلب — ${e.detail}`, e.reason);
    throw e;
  }

  // 4) البنية القانونية
  if (!sameBytes(buildCertificationRequestInfo(params, parsed.subjectPublicKeyInfoDer), parsed.certificationRequestInfoDer)) {
    invalidCsr('بنية الطلب تختلف عن قالب الهيئة (ترتيب الحقول، أو نوع سلسلة، أو سمة/امتداد زائد، أو امتداد حرج)');
  }

  // 5) المتوقَّع
  if (expected.params !== undefined) {
    const want = validateCsrParams(expected.params);
    for (const k of Object.keys(want) as CsrParamField[]) {
      if (want[k] !== params[k]) invalidCsr(`الحقل ${k} في الطلب لا يطابق مدخلات الوحدة`);
    }
  }
  if (expected.subjectPublicKeyInfoDer !== undefined) {
    const spki = expected.subjectPublicKeyInfoDer;
    if (!(spki instanceof Uint8Array) || !sameBytes(spki, parsed.subjectPublicKeyInfoDer)) invalidCsr('المفتاح العام في الطلب ليس مفتاح الوحدة المتوقَّع');
  }
  return { parsed, params };
}
