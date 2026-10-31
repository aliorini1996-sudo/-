/**
 * «اشتراط اختيار فاتورة البيع للمرتجع» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — القاعدة الفعّالة على الجهاز، مرآة الخادم
 * (backend/src/services/returnPolicy.ts) والخادم هو الحَكَم: الجهاز يقرأ الإعداد من /company المخبّأ فقد يتأخّر ٥ دقائق.
 *
 *   الإعداد null (الافتراضي)  ⇒ المرحلة الأولى حرّ والمرحلة الثانية مرتبط — سلوك اليوم حرفياً
 *   true                      ⇒ المرتجع يُختار له فاتورة البيع دائماً (قيدٌ جديد للمرحلة الأولى)
 *   false                     ⇒ لا اشتراط: في المرحلة الأولى مرتجعٌ حرّ، وفي المرحلة الثانية إشعارٌ دائن «برقم فاتورةٍ أصلية يدويّ»
 *                               (فاتورة من نظامٍ سابق) — الهيئة تشترط مرجعاً للإشعار الدائن (BR-KSA-56) ولا تشترط أن يكون في المنصّة
 *
 * مدير الشركة يغيّره من «إعدادات الشركة» (PUT /api/company/return-policy).
 */
import { zatcaRegimeOf } from './zatcaRegime';

type CompanyLike = Parameters<typeof zatcaRegimeOf>[0] & { returnRequiresSaleInvoice?: boolean | null };

/** الشركة على المرحلة الثانية (قرار الخادم أو الانطلاق الحيّ) */
export const isPhase2Company = (company: CompanyLike | null | undefined): boolean => zatcaRegimeOf(company).phase === 2;

/** الافتراضي حين لا إعداد: المرحلة الثانية تشترط، والأولى لا */
export const returnLinkDefault = (company: CompanyLike | null | undefined): boolean => isPhase2Company(company);

/** هل يُشترط اختيار فاتورة البيع لكل مرتجع؟ — الإعداد الصريح وإلا افتراضيّ المرحلة */
export function returnLinkRequired(company: CompanyLike | null | undefined): boolean {
  const v = company?.returnRequiresSaleInvoice;
  return v === true || v === false ? v : returnLinkDefault(company);
}

/** مرتجعٌ «برقم فاتورةٍ أصلية يدويّ» مسموح: المرحلة الثانية والاشتراط مطفأ */
export const manualReturnRefAllowed = (company: CompanyLike | null | undefined): boolean =>
  isPhase2Company(company) && !returnLinkRequired(company);

/** حدود رقم الفاتورة الأصلية اليدويّ — مرآة الخادم */
export const RETURN_REF_MIN = 3;
export const RETURN_REF_MAX = 60;
/** سبب الإشعار الدائن (KSA-10) — مرآة NOTE_REASON_MIN/MAX في الخادم */
export const NOTE_REASON_MIN = 3;
export const NOTE_REASON_MAX = 1000;

/** رقمٌ يُطبع مرجعاً للإشعار الدائن: سطرٌ واحد بلا محارف تحكّم أو اتجاه، وأرقامه لاتينية (١٢٣ ⇒ 123) — مرآة normalizeReturnRef في الخادم */
export function normalizeReturnRef(s: string | null | undefined): string {
  return typeof s === 'string' ? s.replace(/[​‎‏‪-‮⁠-⁤⁦-⁩]/g, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).trim() : '';
}

/** سبب رفض الرقم (عبارة القاموس) أو null — يلزم رقمٌ واحد على الأقل، فلا «-» ولا «لا يوجد» */
export function returnRefProblem(s: string | null | undefined): string | null {
  const v = normalizeReturnRef(s);
  if (Array.from(v).length < RETURN_REF_MIN || Array.from(v).length > RETURN_REF_MAX || !/\d/.test(v)) {
    return 'اكتب رقم الفاتورة الأصلية كما هو عليها (من 3 إلى 60 حرفا وفيه رقم)';
  }
  return null;
}
