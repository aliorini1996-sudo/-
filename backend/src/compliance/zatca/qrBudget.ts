// ============================================================================
// ZATCA المرحلة الثانية (Z2) — ميزانية طول رمز QR (مكتفٍ بذاته، بلا استيراد)
// ----------------------------------------------------------------------------
// يستعمله الفحص المسبق (Z1) كي يُرفض اسم البائع الطويل **قبل** استهلاك ICV برسالة تسمّي الحقل،
// بدل أن يفشل الختم داخل معاملة الإصدار بخطأ غير مصنَّف. ويستعمله qr.ts للسقف نفسه.
// الوسوم ذات الطول المتغيّر غير الاسم تُحسب بأسوأ حالاتها:
//   2 الرقم الضريبي 15 · 3 الختم الزمني 19 · 6 التجزئة 44 · 7 التوقيع ≤ 96 (DER ≤ 72 بايت لـsecp256k1)
//   8 SPKI 88 · 9 توقيع الشهادة ≤ 72 (المبسّطة فقط) · 4 و5 بطول نصّيهما الفعليين.
// ============================================================================

/** UNVERIFIED(U1): 700 (SEC §4.1) مقابل 1000 (الـSDK، مصدر ثانوي) — design §6.2. */
export const QR_MAX_BASE64_LENGTH = 700;
/** بايت واحد للطول في TLV. */
export const TLV_MAX_VALUE_BYTES = 255;

export const QR_WORST_CASE_BYTES = Object.freeze({
  vat: 15,
  timestamp: 19,
  invoiceHash: 44,
  signature: 96,
  spki: 88,
  certSignature: 72,
});

/** سقف طول صالح: عدد صحيح موجب آمن (NaN أو نص من متغيّر إعداد غير مضبوط كان يُلغي الفحص بصمت). */
export function assertQrMaxLength(max: unknown): number {
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1) {
    throw new RangeError(`سقف طول QR غير صالح: ${String(max)}`);
  }
  return max;
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export interface QrBudgetInput {
  sellerName: string;
  /** نصّ الوسم 4 كما سيُكتب (PayableAmount). */
  totalWithVat: string;
  /** نصّ الوسم 5 كما سيُكتب. */
  vatTotal: string;
  simplified: boolean;
}

/** أسوأ عدد بايتات TLV (قبل base64) بهذه القيم واسمٍ بطول nameBytes. */
function worstCaseBytes(p: Omit<QrBudgetInput, 'sellerName'>, nameBytes: number): number {
  const w = QR_WORST_CASE_BYTES;
  const values = [nameBytes, w.vat, w.timestamp, utf8Bytes(p.totalWithVat), utf8Bytes(p.vatTotal), w.invoiceHash, w.signature, w.spki];
  if (p.simplified) values.push(w.certSignature);
  return values.reduce((a, v) => a + 2 + v, 0);
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** أسوأ طول base64 ممكن للـQR بهذه القيم. */
export function qrWorstCaseBase64Length(p: QrBudgetInput): number {
  return base64Length(worstCaseBytes(p, utf8Bytes(p.sellerName)));
}

/**
 * أطول اسم بائع (بايت UTF-8، ≤ 255) يضمن ألّا يتجاوز الـQR السقف مع هذه المبالغ؛ -1 إن لم يتّسع حتى الاسم الفارغ.
 * صيغة مغلقة: ⌈(b0 + n)/3⌉·4 ≤ max ⇔ b0 + n ≤ ⌊max/4⌋·3 (بايتات المبالغ تُحسب مرة واحدة لا 256 مرة).
 */
export function maxSellerNameBytes(p: Omit<QrBudgetInput, 'sellerName'>, maxLength = QR_MAX_BASE64_LENGTH): number {
  const max = assertQrMaxLength(maxLength);
  const b0 = worstCaseBytes(p, 0);
  const n = Math.floor(max / 4) * 3 - b0;
  return n < 0 ? -1 : Math.min(TLV_MAX_VALUE_BYTES, n);
}
