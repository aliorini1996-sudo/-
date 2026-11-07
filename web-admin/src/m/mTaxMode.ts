import { createContext, useContext } from 'react';
import { isTaxOff, TAX_MODE_CODES, type TaxModeCompany } from '../lib/taxMode';

/**
 * «إزالة الضريبة» في تطبيق الإدارة على الجوال (`/m`) — طلب المالك ٧ نوفمبر ٢٠٢٦:
 * «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام ولا في اي مستند».
 *
 * مصدر الحقيقة علم الشركة `CompanySettings.taxDisabled` (يصل مع ردّ `/company` الذي تحمله القوقعة MobileApp وتجدّده)، ويُقرأ
 * بـ`isTaxOff` وحدها (=== true): غيابه أو إعداداتٌ لم تصل بعد = الشاشات كما كانت حرفاً. والقوقعة تمرّره للشاشات بسياقٍ واحد
 * (`MTaxOffContext`) فلا يُمرَّر خاصيةً عبر كل مكوّن فرعي — والسياق بلا مزوّد `false` = اليوم.
 * والمستندات نفسها (الفاتورة والسند والكشف وإشعارات المستودع) تُرسم بقوالب rep/RepDocuments المشتركة: الفاتورة بختمها
 * (`Invoice.taxFree`) والبقية بعلم الشركة — لا شيء منها هنا.
 */

/** هل الشركة «بلا ضريبة»؟ — من ردّ /company كما تحمله الشاشات (`unknown`) */
export function mTaxOffOf(company: unknown): boolean {
  return isTaxOff(company as TaxModeCompany | null | undefined);
}

/** علم «بلا ضريبة» للشاشات — القوقعة تزوّده من إعدادات الشركة، وبلا مزوّد `false` (اليوم حرفاً) */
export const MTaxOffContext = createContext(false);

/** الشاشة تقرأ العلم — لا خاصية تُمرَّر عبر كل مكوّن فرعي */
export function useMTaxOff(): boolean {
  return useContext(MTaxOffContext);
}

/**
 * ردّ الخادم على فاتورةٍ بنسبة ضريبةٍ لشركةٍ أُزيلت ضريبتها (409 `TAX_MODE_CHANGED`): الإعدادات على الجهاز أقدم من القلب.
 * الرمز وحده يحكم (لا نصّ الرسالة).
 */
export function taxModeChangedOf(e: unknown): boolean {
  const data = (e as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data;
  return data?.code === TAX_MODE_CODES.changed;
}

/**
 * طلب إعادة جلب إعدادات الشركة **فوراً** (بلا فجوة الدقائق الخمس): القوقعة تستمع للحدث فتجلب `/company`، فيصل العلم الجديد
 * شاشة الفاتورة المفتوحة فتعيد نسبة بنودها (mUnits.retaxInvoiceLines). بلا window (اختبار) لا شيء.
 */
export const M_COMPANY_REFETCH_EVENT = 'fieldsales:m-company-refetch';

export function requestCompanyRefetch(): void {
  try {
    const w = (globalThis as { window?: EventTarget }).window;
    if (w && typeof w.dispatchEvent === 'function') w.dispatchEvent(new Event(M_COMPANY_REFETCH_EVENT));
  } catch { /* لا يمنع شيئاً — التجديد الدوري يصل بعد حين */ }
}
