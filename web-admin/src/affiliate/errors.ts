// ============================================================================
// قراءة نقيّة لأخطاء خادم البوابة — بلا axios ولا import.meta، فتُختبر في node.
// الخادم يُرسل `{ success: false, message, code? }`؛ `code` يميّز حالاتٍ تحتاج
// سلوكاً لا نصّاً فقط (شروطٌ جديدة، كلمة مرور لا تطابق الطلب).
//
// نصوص الخادم عربية. `errorText` يُترجم الحالات المعروفة (شبكة، 429، رموز الأخطاء،
// ومفتاحٌ «معروف» تمرّره الشاشة) لغير العربية، ويعرض أي رسالة خادمٍ أخرى كما هي؛
// وبالعربية تبقى رسالة الخادم كما كانت تُعرض تماماً.
// ============================================================================
import type { Lang } from '../i18n/lang';
import { translate, type AxKey, type AxMsg } from './i18n';
import { CITY_MAX, NOTE_MAX } from './validation';

type ErrLike = {
  isAxiosError?: boolean;
  response?: { status?: number; data?: { message?: unknown; code?: unknown; errors?: unknown } };
} | null | undefined;

export function errorStatus(err: unknown): number | undefined {
  const s = (err as ErrLike)?.response?.status;
  return typeof s === 'number' ? s : undefined;
}

/** رسالة الخادم النصّية إن وُجدت */
export function serverMessage(err: unknown): string | undefined {
  const m = (err as ErrLike)?.response?.data?.message;
  return typeof m === 'string' && m.trim() ? m : undefined;
}

/** طلبٌ لم يصل ردّه (انقطاع، مهلة، CORS) */
export function isNetworkError(err: unknown): boolean {
  const e = err as ErrLike;
  return !!e && e.isAxiosError === true && !e.response;
}

export function errorCode(err: unknown): string | undefined {
  const c = (err as ErrLike)?.response?.data?.code;
  return typeof c === 'string' && c ? c : undefined;
}

/**
 * 403 `terms_outdated`: نُشر إصدارٌ جديد من الشروط ولم يقبله السفير. ليس خطأً
 * يُعرض ولا سبباً للخروج — تُعاد قراءة /me وتظهر بوابة قبول الشروط.
 */
export function isTermsOutdated(err: unknown): boolean {
  return errorStatus(err) === 403 && errorCode(err) === 'terms_outdated';
}

/**
 * نوع فشل تأكيد البريد:
 *  · `mismatch` — 400 `password_mismatch`: كلمة المرور لا تطابق آخر طلبٍ بهذا البريد
 *    (قد يكون غيره سجّل ببريده) ⇒ رسالة الخادم + «قدّم طلب انضمام»
 *  · `invalid`  — 400 آخر أو 409 (رابطٌ غير صالح أو قديم) ⇒ إعادة إرسال الرابط
 *  · `retry`    — شبكة أو محدِّد أو عطل خادم ⇒ يبقى النموذج لإعادة المحاولة
 */
export type VerifyErrorKind = 'mismatch' | 'invalid' | 'retry';
export function verifyErrorKind(err: unknown): VerifyErrorKind {
  const s = errorStatus(err);
  if (s === 400 && errorCode(err) === 'password_mismatch') return 'mismatch';
  if (s === 400 || s === 409) return 'invalid';
  return 'retry';
}

/** رموز أخطاء الخادم التي لها نصٌّ مترجم */
const CODE_KEYS: Record<string, AxKey> = {
  password_mismatch: 'verify.mismatch',
  terms_outdated: 'err.termsOutdated',
  // 429 قاعدةُ عمل لا محدِّد: ٥٠ ترشيحاً قيد المراجعة — «انتظر قليلاً» تضلّل هنا
  too_many_open_claims: 'err.tooManyOpenClaims',
};

/**
 * حقول أخطاء zod (`errors: { field: [...] }` من errorHandler) ⇒ رسالة التحقّق المطابقة،
 * بترتيب الحقول على الشاشة. بدونها يرى المستخدم «بيانات غير صحيحة email» بعربيةٍ واسم حقلٍ خام.
 */
const FIELD_MSGS: Array<[string, AxMsg]> = [
  ['fullName', { key: 'val.fullName' }],
  ['email', { key: 'val.email' }],
  ['phone', { key: 'val.phone' }],
  ['companyName', { key: 'val.companyName' }],
  ['crNumber', { key: 'val.cr' }],
  ['city', { key: 'val.cityTooLong', vars: { max: CITY_MAX } }],
  ['contactPhone', { key: 'val.contactPhone' }],
  ['password', { key: 'val.passwordMin' }],
  ['vatNumber', { key: 'val.vat' }],
  ['how', { key: 'val.how' }],
  ['note', { key: 'val.noteTooLong', vars: { max: NOTE_MAX } }],
];

/** رسالة التحقّق لأوّل حقلٍ مرفوض في ردّ 400 من zod — أو null */
export function fieldErrorMsg(err: unknown): AxMsg | null {
  if (errorStatus(err) !== 400) return null;
  const errors = (err as ErrLike)?.response?.data?.errors;
  if (!errors || typeof errors !== 'object') return null;
  const rec = errors as Record<string, unknown>;
  for (const [field, m] of FIELD_MSGS) {
    const v = rec[field];
    if (Array.isArray(v) ? v.length > 0 : !!v) return m;
  }
  return null;
}

/**
 * نصّ خطأٍ بلغة العرض:
 *  1. 400 بحقلٍ مرفوض من zod ⇒ رسالة التحقّق المطابقة (بكل اللغات، العربية منها).
 *  2. العربية + رسالة خادم ⇒ الرسالة كما هي (سلوك البوابة الأصلي).
 *  3. رمز خطأ معروف (password_mismatch · terms_outdated · too_many_open_claims) ⇒ نصّه
 *     المترجم — **قبل** فرع 429 العام، فرمز قاعدة العمل لا يُبتلع في «محاولات كثيرة».
 *  4. 429 بلا رمز (المحدِّد) ⇒ «محاولات كثيرة»، وانقطاع ⇒ «تعذّر الاتصال».
 *  5. `known` — حالةٌ تعرفها الشاشة (401 الدخول، رابطٌ غير صالح) ⇒ نصّها المترجم.
 *  6. وإلا رسالة الخادم كما هي (عربية)، أو `fallback` المترجم إن لم تكن رسالة.
 */
export function errorText(err: unknown, lang: Lang, fallback: AxKey, known?: AxKey): string {
  const field = fieldErrorMsg(err);
  if (field) return translate(lang, field.key, field.vars);
  const message = serverMessage(err);
  if (lang === 'ar' && message) return message;
  const code = errorCode(err);
  if (code && CODE_KEYS[code]) return translate(lang, CODE_KEYS[code]);
  if (errorStatus(err) === 429) return translate(lang, 'err.tooMany');
  if (isNetworkError(err)) return translate(lang, 'err.network');
  if (known) return translate(lang, known);
  return message ?? translate(lang, fallback);
}

/**
 * نصّ نجاحٍ يأتي من الخادم (ردود 202 الموحّدة، «استلمنا الترشيح»): بالعربية يُعرض نصّ
 * الخادم كما كان، وبغيرها النصّ المترجم للحالة نفسها.
 */
export function localizedServerText(lang: Lang, message: string | null | undefined, key: AxKey): string {
  return lang === 'ar' && typeof message === 'string' && message.trim() ? message : translate(lang, key);
}
