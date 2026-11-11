/**
 * «النموذج المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — ثوابت صورة النموذج وقراءة مراجعها من إعدادات الطباعة (صرفة).
 *
 * الصورة نفسها في جدولين خارج صفّ الشركة (PrintFormImage + PrintFormImageBlob، routes/printForms.ts): إعدادات الطباعة تُقرأ مع
 * كل /api/company وتُخبّأ على أجهزة المناديب، فلا تحمل إلا مرجعاً صغيراً { id, v, wPx, hPx } في profiles[i].options.layout.form.image.
 * القراءة هنا دفاعية (unknown) عمداً: تمشي على أي كائن — المحفوظ الخام في العمود والمحلَّل للحفظ — ولا تفترض شكل النواة.
 */

const KB = 1024;
const MB = 1024 * KB;

export const PRINT_FORM_CAPS = {
  /** الصورة الواحدة ١٫٥ ميغابايت (الواجهة تعيد ترميزها JPEG حتى ٦٠٠ كيلوبايت لورقة A4 بدقة 150) */
  maxBytes: 1.5 * MB,
  /** حدّ قارئ الجسم الخام — فوق الحدّ بقليل ليصل الردّ 413 برمزه لا بانقطاع */
  rawLimitBytes: 1.5 * MB + 100 * KB,
  minPx: 200,
  maxPx: 10000,
  /** صور النماذج لكل شركة (النماذج نفسها ٤ — والفائض لإعادة الرفع قبل حذف القديمة) */
  maxImages: 8,
  /** عند السقف: صورةٌ لا يشير إليها المحفوظ ومضى على رفعها يوم تُحذف ليمرّ الرفع (رفعُ تجربةٍ أو صورةٌ استُبدلت). الأحدث منها
   * قد يحمله مصمّمٌ مفتوح لم يُحفظ بعد فيبقى */
  staleMs: 24 * 60 * 60 * 1000,
} as const;

/** قفل الشركة الاستشاري لصور النماذج: الرفع (وجمع المهمَل عند السقف) والحذف وحفظ إعدادات طباعةٍ تشير إلى صورة — تحت القفل نفسه
 * فلا يُحذف ما يُحفظ مرجعه في اللحظة نفسها */
export const PRINT_FORM_LOCK_PREFIX = 'print-form:';

export const PRINT_FORM_MESSAGES = {
  type: 'نوع الملف غير مدعوم — ارفع صورة JPG أو PNG أو WebP (ملف PDF احفظه صورة JPG أو PNG ثم ارفعه)',
  unreadable: 'تعذّرت قراءة الصورة — الملف تالف أو ليس صورة JPG أو PNG أو WebP',
  tooLarge: 'حجم صورة النموذج أكبر من 1.5 ميغابايت',
  size: 'أبعاد صورة النموذج بين 200 و10000 بكسل',
  limit: 'بلغت الحد الأقصى لصور النماذج (8) — احذف صورة غير مستخدمة ثم أعد الرفع',
  invalid: 'لم تصل صورة النموذج — أرسلها خاماً بنوعها أو JSON { mimeType, contentBase64 }',
  notFound: 'صورة النموذج غير موجودة',
  inUse: 'صورة النموذج مستخدمة في إعدادات الطباعة — أزلها من النموذج واحفظ ثم احذفها',
  imageMissing: 'صورة النموذج غير موجودة أو تغيّرت — ارفعها من جديد في مصمّم النموذج',
  apiKey: 'هذا الإجراء غير متاح بمفتاح API',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isFormImageId = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/** بصمة النسخة في المرجع وفي رابط التخبئة: أول ١٦ محرفاً من sha256 */
export const formImageVersion = (sha256: string): string => sha256.slice(0, 16);

export interface FormImageRefAt { id: string; v?: string; wPx?: number; hPx?: number; path: string }

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** كل مرجع صورة نموذج في إعدادات الطباعة (أي شكل): profiles[i].options.layout.form.image.id — بمساره لرسالة الرفض */
export function formImageRefsOf(settings: unknown): FormImageRefAt[] {
  const profiles = obj(settings)?.profiles;
  if (!Array.isArray(profiles)) return [];
  const out: FormImageRefAt[] = [];
  profiles.forEach((p, i) => {
    const image = obj(obj(obj(obj(obj(p)?.options)?.layout)?.form)?.image);
    if (!image || typeof image.id !== 'string') return;
    const ref: FormImageRefAt = { id: image.id, path: `profiles[${i}].options.layout.form.image.id` };
    if (typeof image.v === 'string') ref.v = image.v;
    if (typeof image.wPx === 'number') ref.wPx = image.wPx;
    if (typeof image.hPx === 'number') ref.hPx = image.hPx;
    out.push(ref);
  });
  return out;
}

/** المرجع يطابق الصورة المحفوظة: موجودة، وبصمتها تبدأ بـv، وأبعادها wPx×hPx (ما غاب من المرجع لا يُقارَن) */
export function formImageRefMatches(ref: FormImageRefAt, row: { sha256: string; widthPx: number; heightPx: number } | undefined): boolean {
  if (!row) return false;
  if (ref.v !== undefined && (ref.v.length < 8 || !row.sha256.startsWith(ref.v.toLowerCase()))) return false;
  if (ref.wPx !== undefined && ref.wPx !== row.widthPx) return false;
  if (ref.hPx !== undefined && ref.hPx !== row.heightPx) return false;
  return true;
}

/** If-None-Match يطابق الوسم؟ (قائمة مفصولة بفواصل، وW/ الضعيف، و*) */
export function etagMatches(header: unknown, etag: string): boolean {
  if (typeof header !== 'string' || !header) return false;
  return header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === '*' || t === etag);
}
