// ============================================================================
// ملفات البوابة: مستندات «ملفي» (الهوية/الإقامة والسجل) وتنزيل المواد التسويقية.
//
// · المستند data URL بـbase64 داخل JSON (V2_SPEC §3): jpeg/png/webp/pdf ≤ ٥ ميغابايت.
//   الخادم يفحص البايتات ويُشفّر — هذه طبقة راحة: صورة الكاميرا (٤–١٢ ميغابايت أحياناً،
//   أو HEIC من الآيفون) تُصغَّر في المتصفّح إلى JPEG ≤ 2400px قبل الرفع، والـPDF يُرسل كما هو.
// · الأجزاء النقيّة (التحقّق وتفكيك data URL) تُختبر في node؛ والباقي يحتاج المتصفّح.
// ============================================================================
import { msg, type AxMsg } from './i18n';

export const DOC_MAX_BYTES = 5 * 1024 * 1024;
export const DOC_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
/** ما يقبله منتقي الملفات («من الاستديو/الملفات») — الكاميرا `image/*` وحدها */
export const DOC_ACCEPT = DOC_MIMES.join(',');
/** أطول ضلعٍ لصورة المستند بعد التصغير — يكفي لقراءة الهوية بوضوح */
export const DOC_MAX_DIM = 2400;

/** صورة نقطية يمكن تصغيرها في المتصفّح (لا SVG: نصٌّ قد يحمل سكربتاً) */
export function isRasterImage(type: string): boolean {
  return /^image\//i.test(type) && !/svg/i.test(type);
}

/**
 * خطأ الملف **قبل** التحضير أو null: PDF أكبر من الحدّ مرفوض (لا يُصغَّر)، وما ليس صورة
 * ولا PDF مرفوض. الصورة الكبيرة مقبولة هنا لأنها تُصغَّر بعد.
 */
export function docFileError(f: { type: string; size: number }): AxMsg | null {
  const type = (f.type || '').toLowerCase();
  if (type === 'application/pdf') return f.size > DOC_MAX_BYTES ? msg('val.docTooLarge', { max: 5 }) : null;
  if (isRasterImage(type)) return null;
  return msg('val.docType');
}

/** يحتاج تصغيراً؟ — صورةٌ بنوعٍ لا يقبله الخادم (HEIC…) أو أكبر من 1.5 ميغابايت */
export function needsDownscale(f: { type: string; size: number }): boolean {
  const type = (f.type || '').toLowerCase();
  if (!isRasterImage(type)) return false;
  return !(DOC_MIMES as readonly string[]).includes(type) || f.size > 1.5 * 1024 * 1024;
}

/** تفكيك data URL ⇒ النوع ونصّ base64، أو null لغير الصالح */
export function dataUrlParts(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  return m ? { mime: m[1].toLowerCase(), base64: m[2].replace(/\s+/g, '') } : null;
}

/** حجم المحتوى الفعلي لـbase64 بالبايت (بلا فكّه) */
export function base64Bytes(base64: string): number {
  const b = (base64 || '').replace(/\s+/g, '');
  const pad = b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b.length * 3) / 4) - pad);
}

/** data URL ⇒ Blob (تنزيل المواد الكبيرة برابط blob: لا data: الذي تحجبه متصفّحات) */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const p = dataUrlParts(dataUrl);
  if (!p) return null;
  const bin = atob(p.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: p.mime });
}

/** اسم ملفٍ آمن للتنزيل — بلا مسارات ولا محارف تحكّم */
export function safeFileName(name: string | null | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const s = (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120);
  return s || fallback;
}

// ─────────────────────────── المتصفّح ───────────────────────────

export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

async function downscale(file: Blob): Promise<Blob | null> {
  const img = await loadImage(file);
  const scale = Math.min(1, DOC_MAX_DIM / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff'; // شفافية PNG تصير بيضاء لا سوداء في JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  for (const q of [0.85, 0.72, 0.6]) {
    const b = await canvasJpeg(canvas, q);
    if (b && b.size <= DOC_MAX_BYTES) return b;
  }
  return null;
}

export type PreparedDoc = { ok: true; dataUrl: string; mime: string; size: number } | { ok: false; error: AxMsg };

/** يحضّر الملف المختار للرفع: تحقّق ثم تصغير الصورة الكبيرة ثم data URL */
export async function prepareDocument(file: File): Promise<PreparedDoc> {
  const pre = docFileError(file);
  if (pre) return { ok: false, error: pre };
  let blob: Blob = file;
  if (needsDownscale(file)) {
    try {
      const small = await downscale(file);
      if (small) blob = small;
    } catch { /* تعذّر فكّ الصورة (HEIC على متصفّحٍ لا يدعمه) — يُفحص الأصل أدناه */ }
  }
  const type = (blob.type || '').toLowerCase();
  if (!(DOC_MIMES as readonly string[]).includes(type)) return { ok: false, error: msg('val.docType') };
  if (blob.size > DOC_MAX_BYTES) return { ok: false, error: msg('val.docTooLarge', { max: 5 }) };
  const dataUrl = await readAsDataUrl(blob);
  return { ok: true, dataUrl, mime: type, size: blob.size };
}

/** تنزيل data URL باسم ملف — عبر رابط blob: مؤقّت */
export function downloadDataUrl(dataUrl: string, fileName: string): boolean {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

/** هل يستطيع الجهاز مشاركة ملفٍ بقائمة المشاركة الأصلية؟ */
export function canShareFile(file: File): boolean {
  try {
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    return typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function dataUrlToFile(dataUrl: string, fileName: string): File | null {
  const blob = dataUrlToBlob(dataUrl);
  return blob ? new File([blob], fileName, { type: blob.type }) : null;
}

/** يفتح data URL (PDF غالباً) في تبويبٍ جديد عبر رابط blob: مؤقّت — المتصفّحات تحجب فتح data: */
export function openDataUrl(dataUrl: string): boolean {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  // مع noopener يُعيد window.open دائماً null — فلا يُقرأ ناتجه
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
