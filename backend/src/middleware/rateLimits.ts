import rateLimit, { Options } from 'express-rate-limit';

// حدود معدّل الطلبات — حماية ضد التخمين والسبام وإساءة الاستخدام.
// ملاحظة: يتطلب app.set('trust proxy', 1) خلف بروكسي Render لاحتساب IP الحقيقي.

const base: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'تجاوزت الحد المسموح من المحاولات، حاول لاحقاً' },
};

// تسجيل الدخول — صارم ضد تخمين كلمات المرور (لكل IP)
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { success: false, message: 'محاولات دخول كثيرة — انتظر 15 دقيقة ثم حاول مجدداً' },
});

// التسجيل الذاتي — يمنع إنشاء شركات وهمية بكثافة
export const signupLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 6,
  message: { success: false, message: 'طلبات تسجيل كثيرة — حاول بعد ساعة' },
});

// نماذج البريد (تواصل/دعم/تحقق) — يمنع السبام
export const mailLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { success: false, message: 'طلبات كثيرة — حاول بعد قليل' },
});

// حدّ عام واقٍ لكل واجهة API
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 600,
});
