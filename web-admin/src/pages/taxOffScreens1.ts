/**
 * «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — منطق شاشات الإدارة (المجموعة الأولى) بلا React: مفتاح الإعدادات ورفضه، وتصدير
 * العملاء بلا عمود الرقم الضريبي. الشركة بضريبتها (taxDisabled غائب أو false): كل دالّة تعيد ما كان حرفاً.
 * القواعد المشتركة في lib/taxMode.ts (isTaxOff وTAX_MODE_*)، وما يخصّ شاشات الطباعة في components/print/taxOffPrint.ts.
 */
import { TAX_MODE_CODES, TAX_MODE_MESSAGES, isTaxOff, type TaxModeCompany } from '../lib/taxMode';

type TaxModeCode = keyof typeof TAX_MODE_MESSAGES;

/** رمز رفض «وضع الضريبة» من ردّ الخادم (TAX_MODE_CODES) أو null لغيره */
export function taxModeErrorCode(err: unknown): TaxModeCode | null {
  const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(TAX_MODE_MESSAGES, code) ? (code as TaxModeCode) : null;
}

/** رسالة رفض قلب المفتاح (عربية تُمرَّر إلى tr): 409 TAX_MODE_ZATCA_CONFLICT وغيره من رموز الوضع — null لغيرها (الرسالة العامة) */
export function taxModeErrorMessage(err: unknown): string | null {
  const code = taxModeErrorCode(err);
  return code ? TAX_MODE_MESSAGES[code] : null;
}

/** حقول الشركة التي يقرؤها مفتاح الإعدادات من ردّ GET /company */
export interface TaxModeCardCompany extends TaxModeCompany {
  zatcaPhase2Enabled?: boolean | null;
  zatcaPhase2StartedAt?: string | Date | null;
  zatcaGoLiveArmedAt?: string | Date | null;
}

const present = (v: unknown): boolean => v instanceof Date || (typeof v === 'string' && v !== '');

/**
 * إزالة الضريبة ممنوعةٌ الآن في الواجهة؟ (قرار المالك: يُمنع القلب ما دام ربط المرحلة الثانية مفعّلاً — علم المالك أو التفعيل الحيّ
 * أو تسليحه) — فيُعطَّل المفتاح وتظهر رسالة الرفض نفسها. الخادم مرجعٌ أوسع (قائمة البروفة) ويرفض 409 TAX_MODE_ZATCA_CONFLICT.
 * إعادة الضريبة لشركةٍ أزالتها مسموحةٌ دائماً.
 */
export function taxModeBlockedByZatca(c: TaxModeCardCompany | null | undefined): boolean {
  if (isTaxOff(c)) return false;
  return c?.zatcaPhase2Enabled === true || present(c?.zatcaPhase2StartedAt) || present(c?.zatcaGoLiveArmedAt);
}

/** رسالة المنع المعروضة تحت المفتاح المعطّل (عربية تُمرَّر إلى tr) */
export const TAX_MODE_BLOCKED_TEXT = TAX_MODE_MESSAGES[TAX_MODE_CODES.zatcaConflict];

/** القيمة المعروضة في المفتاح أثناء الحفظ: المطلوب، وإلا علم الشركة */
export function taxModeChecked(pending: boolean, requested: boolean | undefined, company: TaxModeCompany | null | undefined): boolean {
  return pending && requested !== undefined ? requested : isTaxOff(company);
}

// ─── تصدير العملاء (CustomersPage) ───

/** موضع عمود «الرقم الضريبي» في تصدير العملاء (بعد العنوان) */
export const CUSTOMER_EXPORT_TAX_COL = 9;

/** عروض أعمدة تصدير العملاء: كما اليوم حرفاً، وبلا عمود الرقم الضريبي لشركةٍ بلا ضريبة */
export function customerExportColWidths(accountingOn: boolean, taxOff: boolean): number[] {
  const widths = accountingOn
    ? [26, 28, 24, 14, 14, 24, 14, 14, 28, 18, 16, 14, 14, 14, 10, 10, 40, 14]
    : [26, 28, 24, 14, 14, 24, 14, 14, 28, 18, 16, 14, 10, 40, 14];
  return taxOff ? widths.filter((_, i) => i !== CUSTOMER_EXPORT_TAX_COL) : widths;
}
