// ============================================================================
// ضغط صور الجهاز قبل الرفع — مصدرٌ واحد لتسجيل الزيارة ولمرفقات سند القبض.
// ----------------------------------------------------------------------------
// لماذا الضغط أصلاً: الصورة تُخزَّن base64 في قاعدة البيانات، وصورةُ هاتفٍ خام
// تتجاوز خمسة ميغابايت — أي أربعة أضعاف حدّ الحقل بعد ترميز base64، ورفعُها من
// شبكة ميدانية ضعيفة يفشل قبل أن يبدأ.
//
// ولماذا وحدةٌ مشتركة لا نسخة في كل شاشة: الحدّان (١٢٨٠ بكسل وجودة ٠٫٧) مُعايَران
// ليقعا تحت سقف الخادم (٢٫٥ ميغابايت للصورة) مع إبقاء رقم الإيصال مقروءاً. نسخةٌ
// ثانية تُعدَّل وحدها يوماً فتُنتج صوراً يرفضها الخادم في شاشةٍ دون أخرى.
// ============================================================================

/** أقصى بُعد للصورة بعد الضغط (بكسل) */
const MAX_DIM = 1280;
/** جودة JPEG — ٠٫٧ تُبقي النصّ المطبوع مقروءاً بحجمٍ يقارب عُشر الأصل */
const QUALITY = 0.7;

/**
 * يقرأ ملف صورة ويعيده data URL مضغوطاً بصيغة JPEG.
 *
 * يرفض الوعد عند ملفٍ تالف أو غير صورة — والمستدعي يتجاهله بصمت عادةً، فملفٌ
 * واحدٌ فاسد بين ثمانية لا يجوز أن يُسقط الاختيار كلّه.
 */
export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = MAX_DIM;
        let { width, height } = img;
        if (width > max || height > max) {
          const s = Math.min(max / width, max / height);
          width = Math.round(width * s);
          height = Math.round(height * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas')); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', QUALITY));
      };
      img.onerror = () => reject(new Error('img'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(file);
  });
}
