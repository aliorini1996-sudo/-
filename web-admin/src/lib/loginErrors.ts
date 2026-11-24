/**
 * رسائل رفض الدخول الدقيقة (طلب المالك ٢١ نوفمبر ٢٠٢٦): الخادم (POST /auth/login) يُرسل مع كل رفضٍ رمزاً `code`
 * ورسالةً عربية تبيّن الخطأ بالضبط — وهنا يُترجم الرمز إلى فعلٍ يعرضه مربّع الخطأ تحت النموذج:
 *   · كلمة مرور خاطئة (أو بيانات غير صحيحة) ⇒ «نسيت كلمة المرور؟» تفتح نافذة الاستعادة
 *   · حساب مندوب في صفحة الشركة ⇒ رابط تطبيق المندوب، وحساب إدارة في تطبيق المندوب ⇒ رابط صفحة الشركة
 *   · حسابٌ بانتظار التفعيل ⇒ تنبيه «افحص بريدك»
 * والرسالة نفسها تُعرض بـtr() (عبارات الخادم في القاموس حرفاً بحرف) — بلا رسالةٍ من الخادم (انقطاع) تُعرض البديلة.
 * لا React هنا — يُختبر وحده (loginRecovery.test.ts).
 */

export type LoginAction = 'forgot' | 'repApp' | 'adminLogin' | 'checkEmail' | null;

/** رموز الخادم ⇒ الفعل المقترح. رمزٌ لا نعرفه (أو TENANT_BLOCKED/ACCOUNT_DISABLED) بلا فعل — الرسالة تكفي */
export const LOGIN_ACTIONS: Readonly<Record<string, LoginAction>> = Object.freeze({
  WRONG_PASSWORD: 'forgot',
  INVALID_CREDENTIALS: 'forgot',
  REP_ACCOUNT: 'repApp',
  ADMIN_ACCOUNT: 'adminLogin',
  PENDING_ACTIVATION: 'checkEmail',
});

export interface LoginError {
  /** رمز الخادم كما وصل (null لانقطاعٍ أو ردٍّ بلا رمز) */
  code: string | null;
  /** رسالة الخادم العربية — null حين لا ردّ (انقطاع) أو ردٌّ بلا نصّ */
  message: string | null;
  action: LoginAction;
  /** لا ردّ من الخادم أصلاً — انقطاعٌ أو مهلة */
  offline: boolean;
}

export function loginErrorOf(err: unknown): LoginError {
  const r = (err as { response?: { status?: number; data?: { code?: unknown; message?: unknown } } } | null)?.response;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const code = str(r?.data?.code);
  // ردٌّ بلا رمز من التحقّق (400: «بيانات غير صحيحة username») أو من الخادم (5xx) نصٌّ لا يُترجم — تُعرض البديلة المترجمة
  const status = r?.status ?? 0;
  const usable = !!code || (status !== 400 && status < 500);
  return {
    code,
    message: usable ? str(r?.data?.message) : null,
    action: (code && LOGIN_ACTIONS[code]) || null,
    offline: !r,
  };
}

/** الأرقام العربية-الهندية والفارسية (لوحة مفاتيح عربية) إلى لاتينية — لعدّ أرقام الجوال قبل الإرسال */
export function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/** فحصٌ أوّليّ للبريد قبل الإرسال — الخادم يحكم أخيراً */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** رقم جوال الشركة كما يكتبه المستخدم (بأي أرقام) يكفي إن حمل سبعة أرقام فأكثر — الخادم يطبّعه ويطابقه */
export function looksLikePhone(s: string): boolean {
  return latinDigits(s).replace(/\D/g, '').length >= 7;
}

/** رمز رابط إعادة التعيين من **وسم** الرابط `#t=` وحده — لا الاستعلام: الوسم لا يصل الخادم ولا السجلّات ولا Referer */
export function readResetToken(hash: string): string {
  try {
    return new URLSearchParams(String(hash || '').replace(/^#/, '')).get('t') || '';
  } catch {
    return '';
  }
}
