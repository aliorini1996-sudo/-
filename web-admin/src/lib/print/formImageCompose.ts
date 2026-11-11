// ============================================================================
// «نموذج الشركة المطبوع مسبقاً» — تجهيز صورة النموذج الفارغ في المتصفح قبل رفعها (بلا مكتبة):
//   الملف ← فكّ الترميز باتجاه EXIF (createImageBitmap أو Image) ← تصغير أطول ضلع إلى 2400 بكسل قبل getImageData (حدود لوحة
//   الرسم في iOS) ← تصحيح المنظور من الأركان الأربعة إلى مستطيل الورقة بدقة 150 نقطة (formRasterPx: A4 = 1240 × 1754)
//   ← JPEG بجودةٍ تنزل 0.85 → 0.5 حتى 600 كيلوبايت ← Blob وأبعاده، يرفعه FormUploadStep إلى /api/company/print-forms.
//
// الأجزاء الخالصة (تصنيف الملف، المقاسات، الأركان، حلقة الجودة، قراءة ردّ الخادم، ورسائل الخطأ) تُختبر في node؛ وما يمسّ
// لوحة الرسم (loadFormSource وcomposeFormImage) للمتصفح وحده.
// ============================================================================

import { isConvexQuad, quadSignedArea, rectQuad, solveHomography, warpToRect, type Pt, type Quad } from './homography';
import { FORM_BOUNDS, FORM_IMAGE_ID_RE, FORM_IMAGE_V_RE, formRasterPx, formSheetSize, type FormImageRef, type FormPaper } from './formModel';

export type { Pt, Quad } from './homography';

// ─── الثوابت ───

/** الأنواع المقبولة للرفع (والخادم يفحص البايتات نفسها) */
export const FORM_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** قيمة accept لحقل الملف: الصور، وPDF ليُقال لصاحبه كيف يحفظه صورة بدل أن يختفي من نافذة الاختيار */
export const FORM_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,application/pdf,.pdf';
/** أطول ضلعٍ للصورة بعد فكّ ترميزها وقبل getImageData — صورة جوال 12 ميغابكسل = 48 ميغابايت RGBA، وiOS يحدّ اللوحة بـ16.7 م بكسل */
export const FORM_DECODE_MAX_PX = 2400;
/** هدف الضغط: 600 كيلوبايت (صورة نموذجٍ خطّي بـ150 نقطة نحو 200–450 كيلوبايت) */
export const FORM_UPLOAD_TARGET_BYTES = 600 * 1024;
/** سقف الخادم (PRINT_FORM_CAPS.maxBytes في backend/src/services/printForms.ts) */
export const FORM_UPLOAD_MAX_BYTES = 1.5 * 1024 * 1024;
/** ملف المصدر قبل المعالجة: صورة الجوال 2–12 ميغابايت؛ ما فوق 40 لا يُفكّ في المتصفح بأمان */
export const FORM_SOURCE_MAX_BYTES = 40 * 1024 * 1024;
/** جودة JPEG بالترتيب حتى يبلغ الحجم الهدف */
export const FORM_JPEG_QUALITIES: readonly number[] = Object.freeze([0.85, 0.78, 0.71, 0.64, 0.57, 0.5]);

/** رسائل الرفع (عربية تمرّ بـtr()) — ونصوص رموز الخادم مطابقةٌ لـPRINT_FORM_MESSAGES حرفياً */
export const FORM_UPLOAD_MESSAGES = Object.freeze({
  pdf: 'احفظ الملف صورة JPG أو PNG ثم ارفعه',
  unsupported: 'نوع الملف غير مدعوم — اختر صورة JPG أو PNG أو WebP',
  empty: 'الملف فارغ — اختر صورة النموذج من جديد',
  huge: 'الصورة كبيرة جداً — اختر صورة أصغر من 40 ميغابايت',
  decode: 'تعذرت قراءة الصورة — جرب صورة JPG أو PNG أخرى',
  quad: 'الأركان الأربعة متقاطعة أو متقاربة أو مبدلة — ضع كل ركن على ركن الورقة الموافق له',
  canvas: 'تعذر تجهيز الصورة في هذا المتصفح — جرب متصفحاً آخر أو صورة أصغر',
  encode: 'تعذر ضغط الصورة في هذا المتصفح — جرب متصفحاً آخر',
  type: 'نوع الملف غير مدعوم — ارفع صورة JPG أو PNG أو WebP (ملف PDF احفظه صورة JPG أو PNG ثم ارفعه)',
  tooLarge: 'حجم صورة النموذج أكبر من 1.5 ميغابايت',
  size: 'أبعاد صورة النموذج بين 200 و10000 بكسل',
  limit: 'بلغت الحد الأقصى لصور النماذج (8) — احذف صورة غير مستخدمة ثم أعد الرفع',
  forbidden: 'رفع صورة النموذج يحتاج صلاحية إدارة إعدادات الشركة',
  apiKey: 'هذا الإجراء غير متاح بمفتاح API',
  network: 'تعذر الاتصال بالخادم — تحقق من الإنترنت ثم أعد المحاولة',
  badResponse: 'رد غير متوقع من الخادم بعد الرفع — حاول مجدداً',
  failed: 'تعذر رفع صورة النموذج — حاول مجدداً',
} as const);
export type FormUploadErrorCode = keyof typeof FORM_UPLOAD_MESSAGES;

/** خطأ التجهيز برمزه — رسالته من FORM_UPLOAD_MESSAGES */
export class FormImageError extends Error {
  readonly code: FormUploadErrorCode;
  constructor(code: FormUploadErrorCode) {
    super(FORM_UPLOAD_MESSAGES[code]);
    this.name = 'FormImageError';
    this.code = code;
  }
}

// ─── الأجزاء الخالصة ───

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export type FormFileKind = 'image' | 'pdf' | 'unsupported' | 'empty' | 'huge';

/** أسماءٌ غير قانونية للصيغ الثلاث نفسها (تسجيلات MIME في ويندوز وبعض المتصفّحات) */
const FORM_IMAGE_MIME_ALIASES: readonly string[] = Object.freeze(['image/jpg', 'image/pjpeg', 'image/jpe', 'image/jfif', 'image/pjp', 'image/x-png', 'image/x-citrix-jpeg', 'image/x-citrix-png']);
const FORM_IMAGE_EXTS: readonly string[] = Object.freeze(['jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'png', 'webp']);

/** تصنيف الملف المختار قبل فكّه: الصورة المقبولة، أو PDF (برسالة الحفظ صورة)، أو غير المدعوم/الفارغ/الضخم */
export function classifyFormFile(f: { type?: string | null; name?: string | null; size?: number | null }): FormFileKind {
  const type = String(f.type ?? '').split(';')[0].trim().toLowerCase();
  const name = String(f.name ?? '').trim().toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  // أنواعٌ غير قانونية يعلنها بعض الأنظمة للصيغ الثلاث (image/jpg، image/pjpeg، image/x-png…)، أو امتدادٌ معروف بنوعٍ ليس صورةً أخرى
  // (فارغ أو application/octet-stream): الفكّ يحكم بعدها والخادم يفحص البايتات — وHEIC/GIF/SVG تبقى غير مدعومة برسالتها
  const image = (FORM_IMAGE_MIMES as readonly string[]).includes(type)
    || FORM_IMAGE_MIME_ALIASES.includes(type)
    || (FORM_IMAGE_EXTS.includes(ext) && !type.startsWith('image/'));
  if (!image) return 'unsupported';
  if (!fin(f.size) || f.size <= 0) return 'empty';
  if (f.size > FORM_SOURCE_MAX_BYTES) return 'huge';
  return 'image';
}

/** المقاس بعد التصغير ليبلغ أطول ضلعٍ maxPx على الأكثر (أعداد صحيحة ≥ 1، والأصغر يبقى كما هو) */
export function fitWithin(w: number, h: number, maxPx: number): { w: number; h: number } {
  const W = fin(w) && w > 0 ? w : 1;
  const H = fin(h) && h > 0 ? h : 1;
  const k = fin(maxPx) && maxPx > 0 ? Math.min(1, maxPx / Math.max(W, H)) : 1;
  return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)) };
}

/** الأركان الافتراضية = أركان الصورة (المسح المستوي يطابقها أصلاً) */
export function defaultFormQuad(w: number, h: number): Quad {
  return rectQuad(w, h);
}

/** تحويل الأركان من فضاء صورةٍ fromW×fromH إلى فضاءٍ toW×toH (مثلاً من المعاينة إلى صورة العمل) */
export function scaleQuad(q: Quad, fromW: number, fromH: number, toW: number, toH: number): Quad {
  const kx = fromW > 0 ? toW / fromW : 1;
  const ky = fromH > 0 ? toH / fromH : 1;
  return q.map((p) => ({ x: p.x * kx, y: p.y * ky })) as unknown as Quad;
}

/** ركنٌ داخل الصورة 0..w × 0..h (القيمة غير العددية ⇒ 0) */
export function clampPt(p: Pt, w: number, h: number): Pt {
  return { x: clamp(fin(p.x) ? p.x : 0, 0, Math.max(0, w)), y: clamp(fin(p.y) ? p.y : 0, 0, Math.max(0, h)) };
}

/** ركنٌ i من الأركان بعد تحريكه — يبقى داخل الصورة، والأركان الأخرى كما هي */
export function withQuadCorner(q: Quad, i: number, p: Pt, w: number, h: number): Quad {
  if (!Number.isInteger(i) || i < 0 || i > 3) return q;
  const next = [...q] as Pt[];
  next[i] = clampPt(p, w, h);
  return next as unknown as Quad;
}

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** نسبة العرض إلى الطول التقريبية للورقة في الصورة (متوسط الضلعين الأفقيين ÷ متوسط العموديين) */
export function quadAspect(q: Quad): number {
  const wTop = dist(q[0], q[1]); const wBot = dist(q[3], q[2]);
  const hL = dist(q[0], q[3]); const hR = dist(q[1], q[2]);
  const hh = (hL + hR) / 2;
  return hh > 0 ? (wTop + wBot) / 2 / hh : 0;
}

/**
 * الأركان لا تشبه مقاس الورقة (فرقٌ في النسبة فوق tolerance، 30٪ افتراضياً): تنبيهٌ لا منع — المنظور يغيّر النسبة قليلاً،
 * والفرق الكبير يعني ركناً في غير موضعه أو مقاس ورقٍ آخر في القالب.
 */
export function quadAspectMismatch(q: Quad, paper: FormPaper | null | undefined, tolerance = 0.3): boolean {
  const s = formSheetSize(paper);
  const a = quadAspect(q);
  if (!(a > 0)) return true;
  return Math.abs(Math.log(a / (s.widthMm / s.lengthMm))) > Math.log(1 + tolerance);
}

/**
 * أصغر مساحةٍ مقبولة للأركان: 5٪ من مساحة الصورة (أقلّ منها صورةٌ مغبّشة لا دليلٌ يُقرأ) — وبالترتيب المعتمد على الشاشة (أعلى اليسار
 * ثم اليمين ثم أسفل اليمين ثم اليسار): ركنان متبادلان (اليسار مكان اليمين أو الأعلى مكان الأسفل) يُخرجان صورةً معكوسة كالمرآة.
 */
export function quadUsable(q: Quad, w: number, h: number): boolean {
  return isConvexQuad(q, Math.max(1, 0.05 * Math.max(0, w) * Math.max(0, h))) && quadSignedArea(q) > 0;
}

/**
 * حلقة الجودة: يجرّب الجودات بالترتيب ويعيد أوّل نتيجةٍ لا تتجاوز maxBytes، وإلا آخر محاولة (الأصغر) — والمتصل يقارنها بسقف
 * الخادم. null إن لم يُنتج المرمِّز شيئاً (متصفحٌ بلا toBlob أو لوحةٌ أكبر من حدّه).
 */
export async function encodeWithinBudget(
  encode: (quality: number) => Promise<Blob | null>,
  maxBytes: number = FORM_UPLOAD_TARGET_BYTES,
  qualities: readonly number[] = FORM_JPEG_QUALITIES,
): Promise<{ blob: Blob; quality: number } | null> {
  let last: { blob: Blob; quality: number } | null = null;
  for (const q of qualities) {
    const blob = await encode(q);
    if (!blob || !(blob.size > 0)) return last;
    last = { blob, quality: q };
    if (blob.size <= maxBytes) return last;
  }
  return last;
}

/** ردّ الخادم بعد الرفع ({ id, v, wPx, hPx, … }) ⇒ مرجع الصورة في النموذج، أو null إن لم يكن صالحاً */
export function formImageRefOf(data: unknown): FormImageRef | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const [lo, hi] = FORM_BOUNDS.imagePx;
  const okPx = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (typeof d.id !== 'string' || !FORM_IMAGE_ID_RE.test(d.id)) return null;
  if (typeof d.v !== 'string' || !FORM_IMAGE_V_RE.test(d.v)) return null;
  if (!okPx(d.wPx) || !okPx(d.hPx)) return null;
  return { id: d.id, v: d.v, wPx: d.wPx, hPx: d.hPx };
}

const SERVER_CODES: Readonly<Record<string, FormUploadErrorCode>> = Object.freeze({
  PRINT_FORM_TYPE: 'type',
  PRINT_FORM_INVALID: 'failed',
  PRINT_FORM_TOO_LARGE: 'tooLarge',
  PRINT_FORM_SIZE: 'size',
  PRINT_FORM_LIMIT: 'limit',
  API_KEY_FORBIDDEN: 'apiKey',
});

/** رمز رسالة الخطأ: خطأ التجهيز برمزه، أو ردّ الخادم برمزه وحالته، أو انقطاع الشبكة */
export function formUploadErrorCode(err: unknown): FormUploadErrorCode {
  if (err instanceof FormImageError) return err.code;
  const e = err as { code?: unknown; response?: { status?: unknown; data?: { code?: unknown } }; request?: unknown } | null;
  const res = e?.response;
  if (res) {
    const code = typeof res.data?.code === 'string' ? res.data.code : '';
    if (code && SERVER_CODES[code]) {
      // رمز PRINT_FORM_TYPE يحمل أيضاً «تعذّرت القراءة» حين يُقرأ النوع ولا تُقرأ الأبعاد — الرسالة العامة للنوع تكفي
      return SERVER_CODES[code];
    }
    if (res.status === 413) return 'tooLarge';
    if (res.status === 403) return 'forbidden';
    return 'failed';
  }
  if (e && (e.code === 'ERR_NETWORK' || e.code === 'ECONNABORTED' || e.request)) return 'network';
  return 'failed';
}

/** الرسالة العربية للخطأ (تمرّ بـtr() في الواجهة) */
export const formUploadErrorMessage = (err: unknown): string => FORM_UPLOAD_MESSAGES[formUploadErrorCode(err)];

// ─── المتصفح ───

/** مرحلة التجهيز للعرض: قراءة الصورة، التصحيح، الضغط، الرفع */
export type FormComposeStage = 'read' | 'warp' | 'encode' | 'upload';

/** صورة العمل بعد فكّها وتصغيرها: لوحة رسمٍ تُعرض في المعاينة وتُقرأ بكسلاتها عند التصحيح */
export interface FormSource {
  canvas: HTMLCanvasElement;
  /** أبعاد اللوحة (بعد التصغير) — فضاء الأركان */
  w: number;
  h: number;
  /** أبعاد الصورة الأصلية بعد اتجاه EXIF */
  naturalW: number;
  naturalH: number;
}

/** ما يرسمه drawImage مع أبعاده وتحريره */
interface Decoded { src: CanvasImageSource; w: number; h: number; close(): void }

/** إطارٌ للرسم قبل العمل الثقيل (الدوّار والرسالة تظهر) */
const yieldFrame = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

async function decodeImage(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    // اتجاه EXIF صراحةً (صور الجوال العمودية): المتصفحات القديمة كان افتراضها 'none'
    for (const opts of [{ imageOrientation: 'from-image' } as ImageBitmapOptions, undefined]) {
      try {
        const bmp = opts ? await createImageBitmap(file, opts) : await createImageBitmap(file);
        if (bmp.width > 0 && bmp.height > 0) return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
        bmp.close();
      } catch { /* الخيار غير مدعوم أو الترميز — نجرّب التالي ثم Image */ }
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new FormImageError('decode');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new FormImageError('decode'));
      img.src = url;
    });
    // المتصفحات الحديثة تطبّق اتجاه EXIF على <img> ورسمها (image-orientation: from-image افتراضياً)
    const w = img.naturalWidth; const h = img.naturalHeight;
    if (!(w > 0 && h > 0)) throw new FormImageError('decode');
    return { src: img, w, h, close: () => { img.src = ''; } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function newCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (typeof document === 'undefined') throw new FormImageError('canvas');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new FormImageError('canvas');
  return { canvas, ctx };
}

/** يحرّر ذاكرة لوحةٍ لم تعد لازمة (Safari يحتفظ بها حتى يصغر مقاسها) */
export function releaseCanvas(c: HTMLCanvasElement | null | undefined): void {
  if (!c) return;
  try { c.width = 0; c.height = 0; } catch { /* لا شيء */ }
}

/**
 * يفكّ الصورة ويصغّرها إلى maxPx على الأكثر فوق خلفيةٍ بيضاء (PNG الشفاف يصير ورقاً أبيض). التصغير الكبير بخطوات النصف لئلّا
 * تتسنّن الخطوط الرفيعة (Safari يتجاهل imageSmoothingQuality).
 */
export async function loadFormSource(file: Blob, maxPx: number = FORM_DECODE_MAX_PX): Promise<FormSource> {
  const kind = classifyFormFile(file as Blob & { name?: string });
  if (kind !== 'image') throw new FormImageError(kind === 'pdf' ? 'pdf' : kind);
  const d = await decodeImage(file);
  try {
    const t = fitWithin(d.w, d.h, maxPx);
    let src: CanvasImageSource = d.src; let sw = d.w; let sh = d.h;
    let tmp: HTMLCanvasElement | null = null;
    while (sw / 2 >= t.w * 1.0001 && sh / 2 >= t.h * 1.0001) {
      const hw = Math.max(t.w, Math.round(sw / 2)); const hh = Math.max(t.h, Math.round(sh / 2));
      const step = newCanvas(hw, hh);
      step.ctx.imageSmoothingEnabled = true;
      step.ctx.imageSmoothingQuality = 'high';
      step.ctx.drawImage(src, 0, 0, hw, hh);
      releaseCanvas(tmp);
      tmp = step.canvas; src = step.canvas; sw = hw; sh = hh;
    }
    const out = newCanvas(t.w, t.h);
    out.ctx.fillStyle = '#ffffff';
    out.ctx.fillRect(0, 0, t.w, t.h);
    out.ctx.imageSmoothingEnabled = true;
    out.ctx.imageSmoothingQuality = 'high';
    out.ctx.drawImage(src, 0, 0, t.w, t.h);
    releaseCanvas(tmp);
    return { canvas: out.canvas, w: t.w, h: t.h, naturalW: d.w, naturalH: d.h };
  } finally {
    d.close();
  }
}

const canvasToBlob = (c: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    try { c.toBlob((b) => resolve(b), type, quality); } catch { resolve(null); }
  });

export interface ComposedFormImage {
  blob: Blob;
  /** نوع المحتوى للرفع (image/jpeg) */
  mime: string;
  /** أبعاد الصورة المصحّحة = formRasterPx(paper) */
  wPx: number;
  hPx: number;
  quality: number;
}

/**
 * التصحيح والقصّ والضغط: الأركان quad (في فضاء src.w × src.h) ⇒ صورة الورقة بأبعاد formRasterPx(paper) بـJPEG ضمن 600
 * كيلوبايت ما أمكن. onStage يُبلَّغ بالمرحلة (warp ثم encode) مع إطار رسمٍ قبل كلٍّ منها.
 */
export async function composeFormImage(
  src: FormSource, quad: Quad, paper: FormPaper | null | undefined,
  opts: { onStage?(s: FormComposeStage): void; targetBytes?: number } = {},
): Promise<ComposedFormImage> {
  if (!quadUsable(quad, src.w, src.h)) throw new FormImageError('quad');
  const { wPx, hPx } = formRasterPx(paper);
  const H = solveHomography(rectQuad(wPx, hPx), quad);
  if (!H) throw new FormImageError('quad');
  opts.onStage?.('warp');
  await yieldFrame();
  const sctx = src.canvas.getContext('2d');
  if (!sctx) throw new FormImageError('canvas');
  let pixels: ImageData;
  try { pixels = sctx.getImageData(0, 0, src.w, src.h); } catch { throw new FormImageError('canvas'); }
  const out = newCanvas(wPx, hPx);
  try {
    const img = out.ctx.createImageData(wPx, hPx);
    warpToRect(pixels.data, src.w, src.h, H, wPx, hPx, img.data);
    out.ctx.putImageData(img, 0, 0);
    opts.onStage?.('encode');
    await yieldFrame();
    const res = await encodeWithinBudget((q) => canvasToBlob(out.canvas, 'image/jpeg', q), opts.targetBytes ?? FORM_UPLOAD_TARGET_BYTES);
    if (!res) throw new FormImageError('encode');
    if (res.blob.size > FORM_UPLOAD_MAX_BYTES) throw new FormImageError('tooLarge');
    const mime = (FORM_IMAGE_MIMES as readonly string[]).includes(res.blob.type) ? res.blob.type : 'image/jpeg';
    return { blob: res.blob, mime, wPx, hPx, quality: res.quality };
  } finally {
    releaseCanvas(out.canvas);
  }
}
