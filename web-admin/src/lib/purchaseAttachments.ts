/**
 * «إرفاق فاتورة المشتريات» (طلب المالك ١٣ نوفمبر ٢٠٢٦): مرفقات حركة المستودع — صورةٌ بالكاميرا أو من الاستديو أو ملف PDF، للوارد
 * (وتجوز للتسوية). منطقٌ صرف بلا React ولا شبكة يُختبر وحده (purchaseAttachments.test.ts)، ويقرؤه منتقي نافذة «استلام / تسوية»
 * (components/PurchaseAttachmentsPicker) ونافذة مرفقات الحركة (components/EntryAttachmentsModal) وشاشة الجوال /m.
 *
 * الحدود مرآة الخادم، **والخادم هو الحَكَم**: يفحص بايتات الملف (توقيعه في أوّله) لا ما تدّعيه بادئة data URL ولا اسم الملف،
 * ومرفقٌ لا يصلح ⇒ 400 ATTACHMENT_INVALID ولا يُكتب شيء (لا الحركة ولا مرفقاتها). هنا يُمنع ما سيُرفض قبل الإرسال لا بعده.
 */
import { DOC_COMPRESS } from './customerDocs';

const MB = 1024 * 1024;

/** أقصى عدد مرفقات في الطلب الواحد (مع الحركة أو إضافةً لاحقة) */
export const PURCHASE_ATT_MAX_PER_REQUEST = 5;
/** أقصى عدد مرفقات للحركة الواحدة */
export const PURCHASE_ATT_MAX_PER_ENTRY = 10;
/** سقف الصورة بعد فكّ base64 (بايتاتها الفعلية) — الضغط على الجهاز يقع تحته بكثير */
export const PURCHASE_ATT_IMAGE_MAX_BYTES = 1.5 * MB;
/** سقف ملف PDF (لا يُضغط على الجهاز) */
export const PURCHASE_ATT_PDF_MAX_BYTES = 4 * MB;
/** مجموع مرفقات الطلب الواحد — يبقى الجسم مع ترميز base64 (+٣٣٪) تحت حدّ JSON في الخادم (10mb) */
export const PURCHASE_ATT_TOTAL_MAX_BYTES = 6 * MB;
/** أقصى طول لاسم المرفق */
export const PURCHASE_ATT_NAME_MAX = 120;
/** ضغط صورة الفاتورة: كصور الوثائق (نصّ مطبوعٌ يبقى مقروءاً) — مصدرٌ واحد فلا يختلف الويب والجوال */
export const PURCHASE_ATT_COMPRESS = DOC_COMPRESS;

export const PURCHASE_ATT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type PurchaseAttMime = (typeof PURCHASE_ATT_MIMES)[number];

/** مرفقٌ اختير على الجهاز وجُهّز للإرسال — `key` محلّيّ للعرض وحده، والمُرسَل الاسم والبيانات (attachmentsPayload) */
export interface PickedAttachment { key: string; name: string; mime: PurchaseAttMime; size: number; data: string }

/** مرفقٌ محفوظ كما تردّه القائمة (بلا بيانات) */
export interface AttachmentMeta { id: string; name: string; mime: string; size: number; createdBy: string | null; createdAt: string }

// ─── base64 ───

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = Object.fromEntries([...B64_ALPHABET].map((c, i) => [c, i]));

/** عدد البايتات بعد فكّ نصّ base64 (بحشوه) — الحجم الذي يحكم به الخادم لا طول النصّ */
export function b64DecodedSize(b64: string): number {
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** فكّ base64 بلا atob (يعمل في المتصفّح وفي اختبار Node) — يقرأ أوّل `maxBytes` وحدها حين تُعطى */
export function b64ToBytes(b64: string, maxBytes = Infinity): Uint8Array {
  // الملف كلّه (فتح PDF أو تنزيله): atob الأصليّ أسرع بكثير في ملفٍ بالميغابايتات — والنصّ مفحوصٌ بنمطه قبلها
  if (maxBytes === Infinity && typeof atob === 'function') {
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch { /* نصٌّ لا يقبله atob — إلى الفكّ اليدويّ */ }
  }
  const clean = b64.replace(/=+$/, '');
  const total = Math.min(Math.floor((clean.length * 6) / 8), maxBytes);
  const out = new Uint8Array(total);
  let buf = 0, bits = 0, o = 0;
  for (let i = 0; i < clean.length && o < total; i++) {
    const v = B64_INDEX[clean[i]];
    if (v === undefined) break;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  return o === total ? out : out.subarray(0, o);
}

/** نوع الملف من بايتاته الأولى — JPEG وPNG وWebP وPDF، وغيرها null (التوقيعات نفسها في الخادم) */
export function sniffAttachmentMime(h: Uint8Array): PurchaseAttMime | null {
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (h.length >= 4 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'image/png';
  const ascii = (a: number, b: number) => String.fromCharCode(...h.subarray(a, b));
  if (h.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (h.length >= 5 && ascii(0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/;
const IMAGE_DATA_URL_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * data URL مرفقٍ صالح البنية: النوع المعلن من الأربعة، والبايتات توافقه بتوقيعها — وإلا null.
 * الحجم بعد الفكّ؛ والسقوف تُفحص في checkAttachment.
 */
export function parseAttachmentData(data: unknown): { mime: PurchaseAttMime; size: number; b64: string } | null {
  if (typeof data !== 'string') return null;
  const m = DATA_URL_RE.exec(data);
  if (!m) return null;
  const b64 = m[2];
  if (b64.length % 4 !== 0) return null;
  const size = b64DecodedSize(b64);
  if (size < 8) return null;
  const mime = m[1] as PurchaseAttMime;
  return sniffAttachmentMime(b64ToBytes(b64.slice(0, 24))) === mime ? { mime, size, b64 } : null;
}

export const isPdf = (x: string | { mime?: string | null } | null | undefined): boolean =>
  (typeof x === 'string' ? x : x?.mime) === 'application/pdf';

/** سقف البايتات لنوع المرفق */
export const maxBytesFor = (mime: string): number => (isPdf(mime) ? PURCHASE_ATT_PDF_MAX_BYTES : PURCHASE_ATT_IMAGE_MAX_BYTES);

// ─── المشكلات: مفتاح القاموس العربي (يمرّ بـtr) ورقمٌ يحلّ محلّ {n} ───

export type AttProblemCode = 'TYPE' | 'CORRUPT' | 'IMAGE_TOO_BIG' | 'PDF_TOO_BIG' | 'TOO_MANY' | 'TOTAL_TOO_BIG' | 'ENTRY_FULL';
export interface AttProblem { code: AttProblemCode; key: string; n?: number | string }

export const ATT_PROBLEM_KEYS: Record<AttProblemCode, string> = {
  TYPE: 'نوع الملف غير مدعوم — PDF أو صورة فقط',
  CORRUPT: 'الملف تالف أو لا يطابق نوعه',
  IMAGE_TOO_BIG: 'الصورة أكبر من {n} ميغابايت',
  PDF_TOO_BIG: 'ملف PDF أكبر من {n} ميغابايت',
  TOO_MANY: 'الحد الأقصى {n} مرفقات',
  TOTAL_TOO_BIG: 'مجموع المرفقات أكبر من {n} ميغابايت',
  ENTRY_FULL: 'بلغت الحركة الحد الأقصى للمرفقات ({n})',
};

const mbText = (bytes: number) => String(Math.round((bytes / MB) * 10) / 10);
const problem = (code: AttProblemCode, n?: number | string): AttProblem => ({ code, key: ATT_PROBLEM_KEYS[code], ...(n !== undefined && { n }) });

/** نصّ المشكلة بلغة الواجهة */
export const problemText = (p: AttProblem, tr: (s: string) => string): string => tr(p.key).replace('{n}', String(p.n ?? ''));

// ─── الاسم ───

const EXT_RE = /\.[A-Za-z0-9]{1,5}$/;

/**
 * اسم المرفق للعرض والحفظ: بلا محارف تحكّم ولا مسار، ≤ ١٢٠، وامتداده من نوعه الفعلي (الصورة تُضغط JPEG فـ`.jpg`) —
 * والاسم لا يُصدَّق في النوع أبداً. فارغٌ ⇒ اسمٌ عامّ بترتيبه.
 */
export function attachmentName(raw: string | null | undefined, mime: PurchaseAttMime, index = 1): string {
  const ext = isPdf(mime) ? '.pdf' : mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  let base = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim().replace(EXT_RE, '').trim();
  if (!base) base = `${isPdf(mime) ? 'purchase-invoice' : 'invoice-photo'}-${index}`;
  return base.slice(0, PURCHASE_ATT_NAME_MAX - ext.length).trim() + ext;
}

// ─── الفحص ───

/** ملفٌ اختير على الجهاز: صورةٌ (تُضغط) أو PDF أو نوعٌ لا يُقبل — والنوع الفعلي يحسمه التوقيع بعد القراءة */
export function pickedFileKind(f: { type?: string | null; name?: string | null }): 'image' | 'pdf' | null {
  const t = String(f.type ?? '').toLowerCase();
  const n = String(f.name ?? '').toLowerCase();
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('image/')) return 'image';
  // بعض المتصفّحات ومديري الملفات لا يعلنون النوع — الامتداد تلميحٌ للقراءة وحدها، والتوقيع يحسم بعدها
  if (!t || t === 'application/octet-stream') {
    if (n.endsWith('.pdf')) return 'pdf';
    if (/\.(jpe?g|png|webp|heic|heif)$/.test(n)) return 'image';
  }
  return null;
}

/** ملف PDF قبل قراءته: الحجم الخام هو حجمه بعد الفكّ — فلا يُقرأ ملفٌ سيُرفض */
export function pdfFileProblem(size: number): AttProblem | null {
  return size > PURCHASE_ATT_PDF_MAX_BYTES ? problem('PDF_TOO_BIG', mbText(PURCHASE_ATT_PDF_MAX_BYTES)) : null;
}

/**
 * نتيجة FileReader لملف PDF ⇒ data URL بنوعه الصحيح: بعض المتصفّحات تقرؤه `application/octet-stream` أو بلا نوع،
 * فتُؤخذ البيانات ويُحكم بالتوقيع `%PDF-` لا بالبادئة. ليس PDF ⇒ null.
 */
export function normalizePdfDataUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const at = raw.indexOf(';base64,');
  if (!raw.startsWith('data:') || at < 0) return null;
  const data = `data:application/pdf;base64,${raw.slice(at + 8)}`;
  return parseAttachmentData(data)?.mime === 'application/pdf' ? data : null;
}

/** مرفقٌ واحد كما سيُرسل: البنية والتوقيع وسقف نوعه — صالحٌ ⇒ جاهزٌ للقائمة */
export function checkAttachment(a: { name?: string | null; data: unknown }, index = 1, key = `att-${index}`):
  { ok: true; att: PickedAttachment } | { ok: false; problem: AttProblem } {
  const p = parseAttachmentData(a.data);
  if (!p) return { ok: false, problem: problem(typeof a.data === 'string' && /^data:(image\/(jpeg|png|webp)|application\/pdf);/.test(a.data) ? 'CORRUPT' : 'TYPE') };
  if (p.size > maxBytesFor(p.mime)) {
    return { ok: false, problem: isPdf(p.mime) ? problem('PDF_TOO_BIG', mbText(PURCHASE_ATT_PDF_MAX_BYTES)) : problem('IMAGE_TOO_BIG', mbText(PURCHASE_ATT_IMAGE_MAX_BYTES)) };
  }
  return { ok: true, att: { key, name: attachmentName(a.name, p.mime, index), mime: p.mime, size: p.size, data: a.data as string } };
}

export const totalBytes = (list: readonly { size: number }[]): number => list.reduce((s, a) => s + (Number(a.size) || 0), 0);

/** كم مرفقاً يُضاف بعد: الأقلّ من سقف الطلب (ناقصاً ما اختير) وسقف الحركة (ناقصاً المحفوظ وما اختير) */
export function slotsLeft(picked: number, existing = 0, maxPerRequest = PURCHASE_ATT_MAX_PER_REQUEST): number {
  return Math.max(0, Math.min(maxPerRequest - picked, PURCHASE_ATT_MAX_PER_ENTRY - existing - picked));
}

/**
 * هل يُضاف `next` إلى ما اختير؟ — سقف الحركة (مع المحفوظ لها)، ثم سقف الطلب، ثم سقف نوعه، ثم المجموع. null = يُضاف.
 * `maxPerRequest` لا يتجاوز سقف العقد مهما مُرّر.
 */
export function addProblem(list: readonly PickedAttachment[], next: Pick<PickedAttachment, 'mime' | 'size'>,
  opts: { existing?: number; maxPerRequest?: number } = {}): AttProblem | null {
  const existing = Math.max(0, opts.existing ?? 0);
  const perReq = Math.min(PURCHASE_ATT_MAX_PER_REQUEST, opts.maxPerRequest ?? PURCHASE_ATT_MAX_PER_REQUEST);
  if (existing + list.length >= PURCHASE_ATT_MAX_PER_ENTRY) return problem('ENTRY_FULL', PURCHASE_ATT_MAX_PER_ENTRY);
  if (list.length >= perReq) return problem('TOO_MANY', perReq);
  if (next.size > maxBytesFor(next.mime)) {
    return isPdf(next.mime) ? problem('PDF_TOO_BIG', mbText(PURCHASE_ATT_PDF_MAX_BYTES)) : problem('IMAGE_TOO_BIG', mbText(PURCHASE_ATT_IMAGE_MAX_BYTES));
  }
  if (totalBytes(list) + next.size > PURCHASE_ATT_TOTAL_MAX_BYTES) return problem('TOTAL_TOO_BIG', mbText(PURCHASE_ATT_TOTAL_MAX_BYTES));
  return null;
}

/** حمولة الإرسال: لا مفتاح أصلاً حين لا مرفقات — فيبقى جسم الحركة (ومرجع محاولتها) كما كان حرفياً */
export const attachmentsPayload = (list: readonly PickedAttachment[]): { attachments?: { name: string; data: string }[] } =>
  (list.length > 0 ? { attachments: list.map((a) => ({ name: a.name, data: a.data })) } : {});

/** رسالة ردّ 400 ATTACHMENT_INVALID (العربية من الخادم) — وغيره null */
export function attachmentInvalidOf(e: unknown): string | null {
  const r = (e as { response?: { status?: number; data?: { code?: unknown; message?: unknown } } })?.response;
  if (r?.data?.code !== 'ATTACHMENT_INVALID') return null;
  return typeof r.data.message === 'string' && r.data.message.trim() ? r.data.message : ATT_PROBLEM_KEYS.TYPE;
}

// ─── العرض ───

/** حجمٌ مقروء: «850 KB» و«1.2 MB» */
export function humanSize(bytes: number): string {
  const b = Math.max(0, Number(bytes) || 0);
  return b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/** صورةٌ يجوز وضعها في src: data URL صورة JPEG/PNG/WebP بحروف base64 وحدها — وغيرها null (لا يُعرض نصٌّ لم يُفحص) */
export const safeImageSrc = (data: unknown): string | null => (typeof data === 'string' && IMAGE_DATA_URL_RE.test(data) ? data : null);

/**
 * بايتات PDF من data URL للفتح في تبويب (Blob URL) — لا يُوضع نصّ data: في رابطٍ أبداً. البنية والتوقيع `%PDF-` وإلا null.
 */
export function pdfBytesOf(data: unknown): Uint8Array | null {
  const p = parseAttachmentData(data);
  if (!p || p.mime !== 'application/pdf') return null;
  return b64ToBytes(p.b64);
}

/** بايتات أي مرفقٍ صالح ونوعه — لتنزيله Blob URL */
export function attachmentBytesOf(data: unknown): { mime: PurchaseAttMime; bytes: Uint8Array } | null {
  const p = parseAttachmentData(data);
  return p ? { mime: p.mime, bytes: b64ToBytes(p.b64) } : null;
}
