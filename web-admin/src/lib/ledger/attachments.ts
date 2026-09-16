/** سقوف مرفقات الدفاتر وقواعد ترميز الصور على الجهاز (§3.9). */

export const ATTACHMENT_PDF_MAX = 1024 * 1024;
export const ATTACHMENT_IMAGE_MAX = 400 * 1024;

/** الخادم يقبل PDF وJPEG وPNG وحدها — أي صورة أخرى تُعاد ترميزاً إلى JPEG. */
export const ATTACHMENT_IMAGE_TYPES_AS_IS = ['image/jpeg', 'image/png'] as const;

/** تُرسل الصورة كما هي فقط إن كانت JPEG/PNG ضمن السقف؛ غير ذلك (WebP/GIF/HEIC أو أكبر) تمر بالضغط. */
export const imageNeedsReencode = (type: string, size: number, maxBytes = ATTACHMENT_IMAGE_MAX): boolean =>
  size > maxBytes || !(ATTACHMENT_IMAGE_TYPES_AS_IS as readonly string[]).includes(type);
