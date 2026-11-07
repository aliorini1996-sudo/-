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

/** رسالة المنع العامة (عربية تُمرَّر إلى tr) — لرفضٍ بلا سببٍ معروف؛ والأسباب المعروفة بعباراتها (taxModeBlockLines) */
export const TAX_MODE_BLOCKED_TEXT = TAX_MODE_MESSAGES[TAX_MODE_CODES.zatcaConflict];

// ─── أسباب منع الإزالة (ردّ 409 TAX_MODE_ZATCA_CONFLICT يحمل reasons[] — compliance/zatca/settingsGuards في الخادم) ───

/** أسباب المنع بترتيبها الثابت (كالخادم): علم المالك، التفعيل الحيّ، التسليح، قائمة البروفة */
export const TAX_MODE_ZATCA_REASONS = Object.freeze(['TENANT_FLAG', 'LIVE', 'ARMED', 'REHEARSAL'] as const);
export type TaxModeZatcaReason = (typeof TAX_MODE_ZATCA_REASONS)[number];

/** عبارة كل سبب (عربية تُمرَّر إلى tr) — تظهر تحت المفتاح المعطّل وفي رسالة الرفض، فيعرف المدير ما يمنعه بالضبط وكيف يُرفع */
export const TAX_MODE_REASON_TEXT: Readonly<Record<TaxModeZatcaReason, string>> = Object.freeze({
  TENANT_FLAG: 'لا يمكن إزالة الضريبة لأن ربط الفوترة الإلكترونية (المرحلة الثانية) مفعل لشركتك من إدارة المنصة — تواصل مع الدعم لإيقافه أولا',
  LIVE: 'لا يمكن إزالة الضريبة لأن ربط الفوترة الإلكترونية (المرحلة الثانية) بدأ فعليا لشركتك وهذا التفعيل لا يلغى',
  ARMED: 'لا يمكن إزالة الضريبة لأن تفعيل ربط الفوترة الإلكترونية (المرحلة الثانية) مسلح لشركتك — انزع التسليح أولا من تبويب الربط',
  REHEARSAL: 'لا يمكن إزالة الضريبة لأن شركتك ضمن تجربة ربط الفوترة الإلكترونية — تواصل مع الدعم لإخراجها منها أولا',
});

/**
 * أسباب رفض الخادم للإزالة: المعروفة منها بالترتيب الثابت، و[] لرفضٍ بلا سببٍ معروف (فتظهر العبارة العامة)، وnull لأي ردٍّ آخر
 * (ليس 409 TAX_MODE_ZATCA_CONFLICT).
 */
export function taxModeConflictReasons(err: unknown): TaxModeZatcaReason[] | null {
  if (taxModeErrorCode(err) !== TAX_MODE_CODES.zatcaConflict) return null;
  const raw = (err as { response?: { data?: { reasons?: unknown } } }).response?.data?.reasons;
  const got: unknown[] = Array.isArray(raw) ? raw : [];
  return TAX_MODE_ZATCA_REASONS.filter((r) => got.includes(r));
}

/**
 * عبارات منع الإزالة (عربية تُمرَّر إلى tr) — [] ⇒ المفتاح متاح. ما يظهر في ردّ GET /company (العلم والتفعيل والتسليح) يُقرأ منه
 * طازجاً (فنزع التسليح يعيد المفتاح بلا تحديث للصفحة)، وقائمة البروفة لا تصل إلا في ردّ الرفض فتُحفظ منه (stickyReasons)، ورفضٌ
 * بلا سببٍ معروف (stickyReasons = []) ⇒ العبارة العامة. الشركة بلا ضريبة: [] دائماً (إعادة الضريبة حرّة).
 */
export function taxModeBlockLines(c: TaxModeCardCompany | null | undefined, stickyReasons: readonly TaxModeZatcaReason[] | null): string[] {
  if (isTaxOff(c)) return [];
  const on: Record<TaxModeZatcaReason, boolean> = {
    TENANT_FLAG: c?.zatcaPhase2Enabled === true,
    LIVE: present(c?.zatcaPhase2StartedAt),
    ARMED: present(c?.zatcaGoLiveArmedAt),
    REHEARSAL: stickyReasons?.includes('REHEARSAL') === true,
  };
  const lines = TAX_MODE_ZATCA_REASONS.filter((r) => on[r]).map((r) => TAX_MODE_REASON_TEXT[r]);
  if (lines.length) return lines;
  return stickyReasons !== null && stickyReasons.length === 0 ? [TAX_MODE_BLOCKED_TEXT] : [];
}

/**
 * ما يُحفظ من رفض الخادم ليبقى المفتاح معطّلاً (لا حلقة تأكيدٍ ثم رفض): البروفة وحدها من الأسباب المعروفة (غيرها يُقرأ من ردّ
 * /company الذي يُعاد بعد الرفض)، و[] لرفضٍ بلا سببٍ معروف، وnull ⇒ لا شيء يُحفظ.
 */
export function taxModeStickyReasons(reasons: readonly TaxModeZatcaReason[] | null): TaxModeZatcaReason[] | null {
  if (reasons === null) return null;
  if (reasons.length === 0) return [];
  return reasons.includes('REHEARSAL') ? ['REHEARSAL'] : null;
}

/** رسالة رفض القلب: لكل سببٍ عبارته (سطرٌ لكل سبب)، وإلا عبارة الرمز (taxModeErrorMessage) — null لغير رموز الوضع */
export function taxModeRefusalLines(err: unknown): string[] | null {
  const reasons = taxModeConflictReasons(err);
  if (reasons && reasons.length) return reasons.map((r) => TAX_MODE_REASON_TEXT[r]);
  const known = taxModeErrorMessage(err);
  return known ? [known] : null;
}

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
