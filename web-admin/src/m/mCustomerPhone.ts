import { telHref } from './mLotsLogic';
import { CUSTOMER_PHONE_MAX } from '../lib/customerPhoneField';

/**
 * جوال العميل في تطبيق الإدارة على الجوال — حرٌّ تماماً (طلب المالك ٧ نوفمبر ٢٠٢٦: «فك القيد بالكامل» ثم «اجعل تسجيل الجوال
 * ليس اجباري»): اختياريّ بلا حدّ أدنى ولا صيغة. يبقى القصّ وسقف أمانٍ ٣٠ حرفاً كسقف الخادم، والعمود NOT NULL فالفارغ ''.
 *
 * والقيد للعملاء وحدهم: جوال المندوب (MSalesReps) باقٍ على شرطه.
 * السقف هو CUSTOMER_PHONE_MAX في lib/customerPhoneField.ts نفسه (تعريفٌ واحد للويب) لا نسخةٌ تفترق عنه.
 */
export const M_CUSTOMER_PHONE_MAX = CUSTOMER_PHONE_MAX;

/**
 * صلاحية نموذج العميل للحفظ: الاسم وحده إلزاميّ. والجوال لا يُشترط — إلا أن يتجاوز السقف بعد تعديله؛ ورقمٌ قديمٌ أطول من
 * السقف لم يُمسّ لا يمنع تعديل باقي الحقول (ولا يُرسَل أصلاً — انظر mCustomerPhonePayload).
 */
export function mCustomerFormValid(form: { name: string; phone: string }, stored?: string | null): boolean {
  if (form.name.trim().length === 0) return false;
  const phone = form.phone.trim();
  if (stored != null && phone === stored.trim()) return true;
  return phone.length <= M_CUSTOMER_PHONE_MAX;
}

/**
 * حقل الجوال في حمولة الحفظ: الإنشاء يرسله دائماً مقصوصاً ('' = بلا جوال، والعمود NOT NULL)؛ والتعديل يرسله حين يتغيّر وحده
 * — فتفريغه عمداً يُرسَل ''، ورقمٌ قديم لم يُمسّ لا يُعاد فحصه على الخادم.
 */
export function mCustomerPhonePayload(phone: string, stored?: string | null): { phone?: string } {
  const v = phone.trim();
  if (stored != null && v === stored.trim()) return {};
  return { phone: v };
}

/**
 * رابط الاتصال بالعميل: جوالٌ فارغ أو عبثيّ (أقل من ٥ أرقام أو أكثر من ١٥) ⇒ null فلا رابط ولا زرّ اتصال — يُعرض نصّه كما هو.
 * يعيد استعمال telHref (التتبّع بالتشغيلة) نفسه فلا يتفرّع منطقان.
 */
export function mCustomerTel(phone: string | null | undefined): string | null {
  return telHref(phone);
}
