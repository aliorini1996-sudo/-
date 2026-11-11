/**
 * نوع الصورة وأبعادها من بايتاتها وحدها (صرفة، بلا مكتبة) — لصورة «النموذج المطبوع مسبقاً» (routes/printForms.ts).
 *
 * لا يُوثق بترويسة Content-Type ولا بامتداد: النوع من البايتات الأولى، والأبعاد من ترويسة الصيغة نفسها —
 * PNG من مقطع IHDR، وJPEG من أول مقطع SOFn (بالمشي على المقاطع لا بالبحث عن بايتين)، وWebP من ترويسة VP8 أو VP8L أو VP8X.
 * ما لا يُقرأ (مبتور أو تالف أو صيغة أخرى) ⇒ null، والمسار يرفضه. الأبعاد كما في الملف (اتجاه EXIF لا يُطبَّق: الواجهة
 * تعيد ترميز الصورة على لوحة رسم فلا يبقى فيها EXIF).
 */

export const FORM_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type FormImageMime = (typeof FORM_IMAGE_MIMES)[number];

export interface ImageInfo { mime: FormImageMime; width: number; height: number }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/** النوع من البايتات الأولى: JPEG (FF D8 FF)، PNG (89 50 4E 47 0D 0A 1A 0A)، WebP (RIFF....WEBP) — وإلا null */
export function sniffImageMime(b: Uint8Array): FormImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && PNG_SIG.every((x, i) => b[i] === x)) return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  return null;
}

/** PNG: أول مقطع بعد التوقيع IHDR بطول 13 — العرض والارتفاع BE32 */
function pngSize(b: Uint8Array): [number, number] | null {
  if (b.length < 24 || be32(b, 8) !== 13 || !ascii(b, 12, 'IHDR')) return null;
  return [be32(b, 16), be32(b, 20)];
}

/**
 * JPEG: مشيٌ على المقاطع من بعد SOI. علامات بلا طول (RSTn وTEM) تُتخطّى، وبايتات الحشو FF تُطوى، وأول SOFn
 * (C0–CF عدا DHT C4 وJPG C8 وDAC CC) يحمل الارتفاع ثم العرض BE16. بلوغ SOS أو EOI قبله ⇒ null.
 */
function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // حشو
    if (i >= b.length) return null;
    const m = b[i++];
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // بلا طول
    if (m === 0xd8 || m === 0xd9 || m === 0xda) return null; // SOI مكرر أو EOI أو SOS قبل SOF
    if (i + 2 > b.length) return null;
    const len = be16(b, i);
    if (len < 2) return null;
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      if (len < 7 || i + 7 > b.length) return null;
      return [be16(b, i + 5), be16(b, i + 3)];
    }
    i += len;
  }
  return null;
}

/** WebP: المقطع الأول بعد RIFF/WEBP — VP8X (لوحة 24 بت + 1)، VP8 (إطار مفتاحي 14 بت)، VP8L (14 بت + 1) */
function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, 'VP8X')) return [1 + le24(b, 24), 1 + le24(b, 27)];
  if (ascii(b, 12, 'VP8 ')) {
    // وسم الإطار 3 بايتات (20..22) ثم رمز البدء 9D 01 2A
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return [le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff];
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    // 4 بايتات بعد التوقيع: العرض−1 (14 بت) ثم الارتفاع−1 (14 بت) بترتيب البتّات الصغير
    const b1 = b[21], b2 = b[22], b3 = b[23], b4 = b[24];
    return [1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))];
  }
  return null;
}

/** النوع والأبعاد معاً — null إن لم تكن صورة من الثلاث أو تعذّرت قراءة أبعادها (أو كان أحدها صفراً) */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  const mime = sniffImageMime(b);
  if (!mime) return null;
  const wh = mime === 'image/png' ? pngSize(b) : mime === 'image/jpeg' ? jpegSize(b) : webpSize(b);
  if (!wh || !(wh[0] > 0) || !(wh[1] > 0)) return null;
  return { mime, width: wh[0], height: wh[1] };
}
