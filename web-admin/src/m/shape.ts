/**
 * حرّاس شكل الاستجابة.
 *
 * **لماذا:** لو ردّ الخادم (أو وسيطٌ بينه وبين الجهاز) بشيء غير متوقَّع — صفحة
 * HTML من بوّابة شبكة فندق مثلاً، أو ردّ فارغ — فإن `res.data.data` تصير
 * `undefined`، فتبقى الشاشة معلّقة على «جاري التحميل» بلا نهاية ولا رسالة.
 * وهذا أسوأ من خطأ صريح: المستخدم ينتظر شيئاً لن يأتي.
 *
 * الرمي هنا يحوّل الصمت إلى حالة خطأ لها زرّ «إعادة المحاولة».
 */

export function expectArray<T>(payload: unknown, what: string): T[] {
  if (!Array.isArray(payload)) throw new Error(`استجابة غير متوقَّعة عند جلب ${what}`);
  return payload as T[];
}

export function expectObject<T>(payload: unknown, what: string): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`استجابة غير متوقَّعة عند جلب ${what}`);
  }
  return payload as T;
}
