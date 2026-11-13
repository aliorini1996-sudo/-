/**
 * «إرفاق فاتورة المشتريات» (طلب المالك ١٣ نوفمبر ٢٠٢٦): عند استلام البضاعة في مخزون الشركة يُرفق المستخدم فاتورة مورّده —
 * صورةً بالتصوير أو من الاستديو، أو ملف PDF. تصل data URL (base64) مع حركة المستودع أو بعدها (routes/warehouse.ts)، والخادم هو الحَكَم:
 * النوع من البايتات الأولى لا من البادئة ولا من اسم الملف، والحجم من البايتات بعد فكّ base64 لا من طول النصّ.
 *
 * وخلافاً لوثائق العميل (services/customerDocs.ts: ما لا يصلح يُسقط بتحذير) المرفقُ هنا كلُّه أو لا شيء: ملفٌّ واحد لا يصلح ⇒ 400
 * ATTACHMENT_INVALID برسالةٍ عربية تسمّيه، ولا تُكتب حركةٌ ولا مرفق — المستخدم أمام الشاشة يعيد الاختيار.
 * وحدودها مرآةٌ في web-admin/src/lib/purchaseAttachments.ts (العميل يضغط الصورة ويمنع قبل الإرسال، والخادم يفحص من جديد).
 *
 * دوالٌّ صرفة بلا قاعدة ولا طلب — يختبرها warehouse-attachments.test.ts.
 */

/** الأنواع المقبولة — SVG وGIF وغيرها خارجها (SVG يحمل سكربتاً) */
export const PURCHASE_ATTACHMENT_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type PurchaseAttachmentMime = (typeof PURCHASE_ATTACHMENT_MIMES)[number];

const MB = 1024 * 1024;
/** سقف الصورة بعد فكّ base64 — الصورة تُضغط على الجهاز قبل الإرسال فتقع تحته بكثير */
export const PURCHASE_ATTACHMENT_IMAGE_MAX_BYTES = 1.5 * MB;
/** سقف ملف PDF بعد فكّ base64 — لا يُضغط على الجهاز */
export const PURCHASE_ATTACHMENT_PDF_MAX_BYTES = 4 * MB;
/** أقصى عدد ملفات في الطلب الواحد */
export const PURCHASE_ATTACHMENT_MAX_PER_REQUEST = 5;
/** أقصى مجموع بايتات الطلب الواحد — base64 يزيده الثلث (~8.4MB) فيبقى تحت حدّ جسم JSON (10mb في index.ts) */
export const PURCHASE_ATTACHMENT_MAX_TOTAL_BYTES = 6 * MB;
/** أقصى عدد مرفقات للحركة الواحدة */
export const PURCHASE_ATTACHMENT_MAX_PER_ENTRY = 10;
/** أقصى طول لاسم الملف المحفوظ */
export const PURCHASE_ATTACHMENT_NAME_MAX = 120;
/** أصغر ملفٍّ معقول — ما دونه ليس صورةً ولا PDF حقيقياً */
const MIN_BYTES = 32;

/** أطول نصّ data URL ممكن لأكبر ملف مسموح — يُرفض ما فوقه قبل أي تعبيرٍ نمطي على نصٍّ ضخم */
const MAX_DATA_LEN = 'data:application/pdf;base64,'.length + Math.ceil(PURCHASE_ATTACHMENT_PDF_MAX_BYTES / 3) * 4;

const DATA_URL = /^data:(image\/jpeg|image\/png|image\/webp|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/;

/** امتداد الاسم المحفوظ من النوع المفحوص لا من اسم المُرسِل */
const EXT: Record<PurchaseAttachmentMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const EXT_OK: Record<PurchaseAttachmentMime, RegExp> = {
  'image/jpeg': /\.jpe?g$/i, 'image/png': /\.png$/i, 'image/webp': /\.webp$/i, 'application/pdf': /\.pdf$/i,
};
/** امتداد ملفٍّ معروف في آخر الاسم — يُستبدل بامتداد النوع المفحوص */
const FILE_EXT = /\.(jpe?g|png|webp|pdf|heic|heif|gif|bmp|tiff?)$/i;

/** مرفقٌ صالح جاهزٌ للحفظ */
export interface PurchaseAttachmentInput { name: string; mime: PurchaseAttachmentMime; size: number; data: string }

/** نوع الملف من بايتاته الأولى — JPEG FF D8 FF، PNG 89 50 4E 47 0D 0A 1A 0A، WEBP RIFF....WEBP، PDF %PDF- */
export function sniffAttachmentMime(head: Buffer): PurchaseAttachmentMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** سقف النوع بالبايتات */
export const attachmentMaxBytes = (mime: PurchaseAttachmentMime): number =>
  (mime === 'application/pdf' ? PURCHASE_ATTACHMENT_PDF_MAX_BYTES : PURCHASE_ATTACHMENT_IMAGE_MAX_BYTES);

/** «1.5 ميغابايت» للرسائل */
const mbLabel = (bytes: number) => `${Number((bytes / MB).toFixed(1))} ميغابايت`;

/**
 * نصّ data URL ⇒ نوعه المفحوص وحجمه بعد الفكّ، أو سبب الرفض بالعربية. البادئة تُعلن النوع والبايتات تشهد عليه:
 * PDF بادئته image/png يُرفض، وصورةٌ بادئتها application/pdf تُرفض. يُستعمل عند الحفظ وعند إعادة التقديم (servableAttachment)
 */
export function parseAttachmentData(raw: unknown): { ok: true; mime: PurchaseAttachmentMime; size: number; data: string } | { ok: false; reason: string } {
  const data = typeof raw === 'string' ? raw.trim() : '';
  if (!data) return { ok: false, reason: 'الملف فارغ' };
  if (data.length > MAX_DATA_LEN) return { ok: false, reason: `حجم الملف أكبر من المسموح (${mbLabel(PURCHASE_ATTACHMENT_PDF_MAX_BYTES)})` };
  const m = DATA_URL.exec(data);
  if (!m) return { ok: false, reason: 'نوع الملف غير مدعوم — المسموح صورة (JPEG أو PNG أو WebP) أو ملف PDF' };
  const b64 = m[2];
  // base64 سليم الحشو (كما يكتبه FileReader) — وإلا لا يُعرف الحجم الحقيقي
  if (b64.length % 4 !== 0) return { ok: false, reason: 'الملف تالف' };
  const size = (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (size < MIN_BYTES) return { ok: false, reason: 'الملف تالف أو فارغ' };
  const declared = m[1] as PurchaseAttachmentMime;
  if (sniffAttachmentMime(Buffer.from(b64.slice(0, 24), 'base64')) !== declared) {
    return { ok: false, reason: 'محتوى الملف لا يطابق نوعه — المسموح صورة (JPEG أو PNG أو WebP) أو ملف PDF' };
  }
  const max = attachmentMaxBytes(declared);
  if (size > max) {
    return { ok: false, reason: declared === 'application/pdf' ? `ملف PDF أكبر من ${mbLabel(max)}` : `الصورة أكبر من ${mbLabel(max)}` };
  }
  return { ok: true, mime: declared, size, data };
}

/**
 * اسم الملف للحفظ والعرض: محارف التحكّم والاتجاه (U+202E يقلب «fdp.exe» إلى ما يشبه PDF) والفواصل تُحذف، ويُقصّ إلى سقفه،
 * وينتهي بامتداد نوعه المفحوص — الاسم لا يُصدَّق في النوع أبداً. فارغٌ ⇒ «فاتورة-مشتريات.<الامتداد>»
 */
export function attachmentName(raw: unknown, mime: PurchaseAttachmentMime): string {
  const ext = EXT[mime];
  const clean = (typeof raw === 'string' ? raw : '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = clean || 'فاتورة-مشتريات';
  if (EXT_OK[mime].test(base) && base.length <= PURCHASE_ATTACHMENT_NAME_MAX) return base;
  // امتداد ملفٍّ معروف لا يطابق النوع (صورة HEIC ضُغطت JPEG على الجهاز) يُستبدل لا يُلحق به
  const stem = base.replace(FILE_EXT, '').trim() || 'فاتورة-مشتريات';
  return `${stem.slice(0, PURCHASE_ATTACHMENT_NAME_MAX - ext.length - 1).trim()}.${ext}`;
}

/** خطأ المرفقات بالشكل الذي يردّه المسار 400 */
export const attachmentInvalid = (message: string) => ({ success: false as const, code: 'ATTACHMENT_INVALID' as const, message });

/**
 * قائمة المرفقات من جسم الطلب — كلها أو لا شيء. غائبةٌ (undefined/null) ⇒ لا مرفقات. وإلا مصفوفةٌ من { name, data }
 * حتى PURCHASE_ATTACHMENT_MAX_PER_REQUEST ملفات ومجموعها تحت PURCHASE_ATTACHMENT_MAX_TOTAL_BYTES، وكل ملفٍّ يجتاز parseAttachmentData.
 * الخطأ يسمّي الملف بموضعه واسمه.
 */
export function parsePurchaseAttachments(raw: unknown): { ok: true; items: PurchaseAttachmentInput[] } | { ok: false; message: string } {
  if (raw == null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'المرفقات يجب أن تكون قائمة ملفات' };
  if (raw.length > PURCHASE_ATTACHMENT_MAX_PER_REQUEST) {
    return { ok: false, message: `يمكن إرفاق ${PURCHASE_ATTACHMENT_MAX_PER_REQUEST} ملفات كحد أقصى في المرة الواحدة` };
  }
  const items: PurchaseAttachmentInput[] = [];
  let total = 0;
  for (let k = 0; k < raw.length; k++) {
    const o = (raw[k] && typeof raw[k] === 'object' ? raw[k] : {}) as { name?: unknown; data?: unknown };
    const shown = typeof o.name === 'string' && o.name.trim() ? `«${o.name.trim().slice(0, 60)}»` : `رقم ${k + 1}`;
    const p = parseAttachmentData(o.data);
    if (!p.ok) return { ok: false, message: `المرفق ${shown}: ${p.reason}` };
    total += p.size;
    if (total > PURCHASE_ATTACHMENT_MAX_TOTAL_BYTES) {
      return { ok: false, message: `مجموع حجم المرفقات أكبر من ${mbLabel(PURCHASE_ATTACHMENT_MAX_TOTAL_BYTES)} — أرسلها على دفعات` };
    }
    items.push({ name: attachmentName(o.name, p.mime), mime: p.mime, size: p.size, data: p.data });
  }
  return { ok: true, items };
}

/** رسالة تجاوز سقف الحركة (الموجود + الجديد) — null حين يتّسع */
export function entryCapMessage(existing: number, adding: number): string | null {
  if (existing + adding <= PURCHASE_ATTACHMENT_MAX_PER_ENTRY) return null;
  const room = Math.max(0, PURCHASE_ATTACHMENT_MAX_PER_ENTRY - existing);
  return room === 0
    ? `بلغت الحركة الحد الأقصى للمرفقات (${PURCHASE_ATTACHMENT_MAX_PER_ENTRY}) — احذف ما لا تحتاجه ثم أرفق من جديد`
    : `يمكن إضافة ${room} من المرفقات فقط لهذه الحركة (الحد الأقصى ${PURCHASE_ATTACHMENT_MAX_PER_ENTRY})`;
}

/**
 * مرفقٌ محفوظ يجوز إعادته للمتصفح: يُفحص من جديد قبل كل تقديم (صفٌّ كُتب بغير هذا المسار أو عُدّل في القاعدة لا يصير رابطاً
 * أو صورة SVG أو نصّاً آخر) — ونوعه المحفوظ يطابق بايتاته
 */
export function servableAttachment(mime: unknown, data: unknown): boolean {
  const p = parseAttachmentData(data);
  return p.ok && p.mime === mime;
}

/** الأعمدة الوصفية — القائمة والردود بلا البيانات */
export const ATTACHMENT_META_SELECT = { id: true, name: true, mime: true, size: true, createdBy: true, createdAt: true } as const;
