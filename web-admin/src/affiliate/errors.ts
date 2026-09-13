// ============================================================================
// قراءة نقيّة لأخطاء خادم البوابة — بلا axios ولا import.meta، فتُختبر في node.
// الخادم يُرسل `{ success: false, message, code? }`؛ `code` يميّز حالاتٍ تحتاج
// سلوكاً لا نصّاً فقط (شروطٌ جديدة، كلمة مرور لا تطابق الطلب).
// ============================================================================

type ErrLike = { response?: { status?: number; data?: { message?: unknown; code?: unknown } } } | null | undefined;

export function errorStatus(err: unknown): number | undefined {
  const s = (err as ErrLike)?.response?.status;
  return typeof s === 'number' ? s : undefined;
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
