// ============================================================================
// رقم جوال العميل في لوحة الإدارة — حرٌّ بالكامل (أمر المالك ٧ نوفمبر ٢٠٢٦):
//   «فك القيد بالكامل» ثمّ «اجعل تسجيل الجوال ليس إجبارياً».
// ----------------------------------------------------------------------------
// • اختياريّ: عميلٌ بلا جوال يُحفظ. والعمود Customer.phone إلزاميّ في القاعدة ⇒ الفارغ يُرسل '' لا null.
// • بلا حدٍّ أدنى ولا صيغة: لا «٩ أرقام» ولا فحص بادئة — قصّ الفراغ من الطرفين وسقف أمانٍ ٣٠ محرفاً وحده.
// • للعملاء وحدهم: جوال المندوب وربط واتساب ونماذج التواصل خارج هذا الملفّ ولها قيودها.
// • الفارغ لا يُعرض فاصلاً يتيماً («الاسم • ») ولا خانةً بيضاء تُقرأ كأنّها خطأ — بل شرطة.
// نقيّ بلا React كي يُختبر مباشرة.
// ============================================================================

/** سقف الأمان الوحيد على جوال العميل — يطابق حدّ الخادم */
export const CUSTOMER_PHONE_MAX = 30;

/** جوال العميل كما يُرسل للخادم: نصٌّ مقصوص الطرفين، والغائب/غير النصّي = '' (العمود لا يقبل null) */
export function trimCustomerPhone(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * خانةٌ فيها نصّ يُعرض؟ ما خلا من كل حرفٍ ورقم (شرطات وفواصل وحدها) لا يُعرض — ومنه علامة «بلا جوال» القديمة «—»
 * التي خزّنها الاستيراد قبل ٧ نوفمبر لمن لا جوال له (باقيةٌ في القاعدة). والنصّ الحرّ ولو بلا أرقام («لا يوجد») يُعرض كما كُتب.
 */
const shownText = (p: string): boolean => /[\p{L}\p{N}]/u.test(p);

/** هل للعميل جوالٌ مكتوب؟ الفارغ والفراغات وحدها و«—» القديمة = لا */
export function hasCustomerPhone(v: unknown): boolean {
  return shownText(trimCustomerPhone(v));
}

/**
 * فحص خانة الجوال في نموذج العميل: الفارغ مقبول، وأيّ صيغةٍ أو طولٍ مقبولان ما لم يتجاوز السقف.
 * `null` = مقبول؛ وإلا نصّ الخطأ العربيّ (يمرّ بـtr في الواجهة).
 */
export function customerPhoneError(v: unknown): string | null {
  return trimCustomerPhone(v).length > CUSTOMER_PHONE_MAX ? 'رقم الجوال أطول من 30 خانة' : null;
}

/**
 * فحص الخانة في تعديل عميلٍ قائم: جوالُه المحفوظ كما هو لا يُفحص بالسقف — رقمٌ أطول من ٣٠ حُفظ قبل السقف (مفتاح API أو
 * استيراد) لا يمنع تعديل حدّه الائتمانيّ أو عنوانه، والخادم يترك المحفوظ المُعاد كما هو (keepStoredPhone). المُغيَّر يُفحص.
 * `stored` غائب (عميلٌ جديد) ⇒ الفحص كاملاً.
 */
export function customerPhoneEditError(v: unknown, stored?: unknown): string | null {
  if (stored != null && trimCustomerPhone(v) === trimCustomerPhone(stored)) return null;
  return customerPhoneError(v);
}

/** جوال العميل للعرض في القوائم والكشوف — الفارغ و«—» القديمة شرطة لا خانة بيضاء */
export function customerPhoneText(v: unknown, empty = '—'): string {
  return hasCustomerPhone(v) ? trimCustomerPhone(v) : empty;
}

/**
 * سطر تلميحٍ يضمّ الجوال مع غيره (الرصيد مثلاً) — يُسقط الفارغ و«—» القديمة فلا يبدأ السطر بفاصلٍ يتيم « • رصيد …».
 * يعيد undefined حين لا يبقى شيء، كي لا تُرسم خانة تلميحٍ فارغة.
 */
export function joinCustomerHint(...parts: Array<string | null | undefined | false>): string | undefined {
  const kept = parts.map(p => (typeof p === 'string' ? p.trim() : '')).filter(shownText);
  return kept.length ? kept.join(' • ') : undefined;
}
