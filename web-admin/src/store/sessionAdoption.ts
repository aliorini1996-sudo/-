/**
 * قرار «تبنّي جلسة اللوحة» في تطبيق الإدارة — قاعدة نقيّة تُختبَر وحدها.
 *
 * ═══ العطل الذي وُلدت منه ═══
 *
 * التطبيق على `/m` يتبنّى جلسة اللوحة عند أوّل فتح كي لا يُطلب دخولٌ ثانٍ ممّن
 * هو مسجَّلٌ أصلاً. والتوكن يعيش **ثماني ساعات** (`JWT_EXPIRES_IN`). فكان يقع
 * هذا كلّ يوم عند من يستعمل اللوحة والتطبيق في المتصفّح نفسه:
 *
 *   ١) التطبيق يُقلع بتوكنٍ منتهٍ، فأوّل طلبٍ يردّ ٤٠١.
 *   ٢) معترِض الردّ يمحو `m_token` ويذهب إلى `/m` — وهو **المسار نفسه**،
 *      فالذهاب إليه إعادةُ تحميلٍ كاملة.
 *   ٣) عند الإقلاع يجد التبنّي `m_token` غائباً و`token` (اللوحة) موجوداً
 *      فينسخه — **فيُحيي التوكن الميّت نفسه**.
 *   ٤) فيعود إلى (١).
 *
 * حلقةٌ لا تنتهي: شاشة الشعار ثمّ الرئيسية ثمّ الشعار، كلّ ثانيةٍ تقريباً،
 * والرئيسية عالقةٌ على «جاري التحميل» لأنّ الصفحة تُستبدَل قبل أن يعود أيّ
 * طلب. **ولا رسالة خطأ واحدة**: كلّ ٤٠١ يموت مع الصفحة التي أطلقته.
 *
 * (أُعيد إنتاجها حيّاً على fieldsa.net/m بحقن توكنٍ منتهٍ: ٨٣ إقلاعاً و٣٤٠
 * طلباً في دقيقة، و`m_token` يعود مطابقاً لتوكن اللوحة بعد كل محو.)
 *
 * ═══ ولماذا هذه القاعدة بهذا الشكل ═══
 *
 * التبنّي **ميزة** لا خلل: من سجّل دخوله على اللوحة لا يُطلب منه دخولٌ ثانٍ.
 * فعلاجُ الحلقة بإلغائه يقتل الميزة لكل الناس بسبب حالةٍ واحدة. ولهذا يُرفض
 * **التوكن بعينه** لا التبنّي: توكنٌ ردّه الخادم يُسجَّل في `m_rejected` فلا
 * يُتبنّى ثانيةً أبداً، ودخولٌ جديد على اللوحة يعطي توكناً آخر يُتبنّى كالعادة.
 */

/** مفتاح التوكن الذي ردّه الخادم — يُرفض تبنّيه ثانيةً */
export const REJECTED_KEY = 'm_rejected';
/** علامة الخروج الصريح من التطبيق */
export const SIGNED_OUT_KEY = 'm_signed_out';

/**
 * لحظة انتهاء توكن JWT بالمللي ثانية، أو `null` إن تعذّرت القراءة.
 *
 * قراءةٌ بلا تحقّق من التوقيع — وهي كافية هنا: السؤال «هل يستحقّ أن يُجرَّب؟»
 * لا «هل هو صحيح؟»، والخادم وحده يجيب الثاني. وتوكنٌ مزوَّر ينتهي إلى ٤٠١
 * كأيّ توكنٍ آخر.
 */
export function jwtExpMs(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    // base64url ← base64: الحرفان المختلفان ثمّ الحشو
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(decodeURIComponent(escape(atob(b64)))) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface AdoptInput {
  /** مسار الصفحة الحاليّ */
  path: string;
  /** توكن مساحة التطبيق (`m_token`) */
  mToken: string | null;
  /** توكن مساحة اللوحة (`token`) */
  dashToken: string | null;
  /** مستخدم اللوحة كما هو مخزَّن نصّاً (`user`) */
  dashUserRaw: string | null;
  /** علامة الخروج الصريح */
  signedOut: string | null;
  /** آخر توكنٍ ردّه الخادم في هذا الجهاز */
  rejected: string | null;
  /** ساعة الجهاز */
  nowMs: number;
}

/** لماذا رُفض التبنّي — للتوثيق والاختبار، ولا يُعرض للمستخدم */
export type AdoptVerdict =
  | 'adopt'
  | 'not-app-path'
  | 'already-has-session'
  | 'signed-out'
  | 'no-dashboard-session'
  | 'owner-session'
  | 'rejected-before'
  | 'expired';

export function adoptVerdict(i: AdoptInput): AdoptVerdict {
  const isAppPath = i.path === '/m' || i.path.startsWith('/m/');
  if (!isAppPath) return 'not-app-path';
  if (i.mToken) return 'already-has-session';
  // خروجٌ صريح يمنع التبنّي، وإلّا ألغى زرُّ الخروج نفسَه عند أوّل إعادة فتح
  if (i.signedOut === '1') return 'signed-out';
  if (!i.dashToken || !i.dashUserRaw) return 'no-dashboard-session';

  let role: unknown;
  try { role = (JSON.parse(i.dashUserRaw) as { role?: unknown })?.role; } catch { return 'no-dashboard-session'; }
  // مالك المنصّة مساحته sa_*، ووجوده في token يعني انتحالاً جارياً
  if (role === 'SUPER_ADMIN') return 'owner-session';

  /* توكنٌ ردّه الخادم من قبل لا يُجرَّب ثانيةً — هذا هو قاطع الحلقة.
   * ويُقارَن بالتوكن نفسه لا بعلامةٍ منطقية: دخولٌ جديد يعطي توكناً مختلفاً
   * فيُتبنّى كالعادة، فلا تموت الميزة بسبب جلسةٍ واحدة انتهت. */
  if (i.rejected && i.rejected === i.dashToken) return 'rejected-before';

  /* وانتهاءُ المدّة يُقرأ قبل أن يُسأل الخادم: يمنع حتى الومضة الواحدة
   * (٤٠١ ثمّ إعادة تحميل) لمن فتح التطبيق بعد يومين.
   * وساعة الجهاز قد تكذب، وكلا الاتجاهين محتمَل: ساعةٌ متقدّمة تُسقط توكناً
   * حيّاً فيُطلب دخولٌ يدويّ (أثرٌ مقبول)، وساعةٌ متأخّرة تُمرّر ميّتاً فيردّه
   * الخادم مرّةً واحدة ويلتقطه `m_rejected`. فلا هامش أمانٍ يلزم. */
  const exp = jwtExpMs(i.dashToken);
  if (exp !== null && exp <= i.nowMs) return 'expired';

  return 'adopt';
}

export const shouldAdopt = (i: AdoptInput): boolean => adoptVerdict(i) === 'adopt';
