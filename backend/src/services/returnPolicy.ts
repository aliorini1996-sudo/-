/**
 * «اشتراط اختيار فاتورة البيع للمرتجع» (قرار المالك ٣١ أكتوبر ٢٠٢٦) — قواعد نقيّة بلا قاعدة ولا شبكة.
 *
 * العمود CompanySettings.returnRequiresSaleInvoice ثلاثيّ يضبطه مدير الشركة (routes/returnPolicy.ts):
 *   null (الافتراضي)  ⇒ افتراضيّ المرحلة حرفياً: الأولى مرتجعٌ حرّ مسموح، والثانية إشعارٌ دائن مرتبط بفاتورة بيع (D3)
 *   true              ⇒ كل مرتجعٍ يُختار له فاتورة البيع (قيدٌ جديد للمرحلة الأولى — 422 RETURN_LINK_REQUIRED)
 *   false             ⇒ لا اشتراط: في الأولى مرتجعٌ حرّ، وفي الثانية إشعارٌ دائن «برقم فاتورةٍ أصلية يدويّ» (فاتورة من نظامٍ
 *                       سابق) — BT-25 = الرقم المكتوب (BR-KSA-56) وKSA-10 = السبب، ولا مرتجع سالب 388 أبداً
 *
 * المرجع في الخادم: routes/invoices.ts (المرحلة الأولى) وroutes/invoicesNotes.ts (المرحلة الثانية). ومرآة الواجهة
 * web-admin/src/lib/returnPolicy.ts (الجهاز يقرأ /company المخبّأ فقد يتأخّر — والخادم يقرّر).
 */

/** حدود رقم الفاتورة الأصلية اليدويّ — مرآة الواجهة (RETURN_REF_MIN/MAX) */
export const RETURN_REF_MIN = 3;
export const RETURN_REF_MAX = 60;

/** طريقة دفع الفاتورة الأصلية (BR-49 PaymentMeans) — لا افتراضيّ صامت: يختارها المُصدِر */
export const RETURN_PAYMENT_TYPES = ['CASH', 'CREDIT'] as const;
export type ReturnPaymentType = typeof RETURN_PAYMENT_TYPES[number];

/** نافذة تسامح إعادة الرفع بعد تغيير الإعداد — الجهاز يملك ساعته، فالنافذة محصورة (نمط LOT_REPLAY_MAX_AGE_MS) */
export const RETURN_POLICY_REPLAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** رسالة رفض رقمٍ غير صالح — مرآة returnRefProblem في الواجهة حرفياً */
export const RETURN_REF_PROBLEM_MESSAGE = 'اكتب رقم الفاتورة الأصلية كما هو عليها (من 3 إلى 60 حرفا وفيه رقم)';
/** رسالة غياب طريقة الدفع */
export const RETURN_PAYMENT_PROBLEM_MESSAGE = 'اختر طريقة دفع الفاتورة الأصلية (نقدي أو آجل)';
/** رسالة قيد صلاحية الأصناف للمندوب — نصّ routes/invoices.ts نفسه (RETURN_NEEDS_SALE_INVOICE) */
export const RETURN_NEEDS_SALE_INVOICE_MESSAGE = 'الأصناف المفعّلة صلاحيتها تُرجَع من فاتورة بيعها — اختر فاتورة البيع ثم الأصناف المرتجعة';

/** القيمة المخزّنة كما تُقرأ: true/false صريحة، وغيرهما (null، غياب العمود في صفٍّ قديم أو مزيّف) = افتراضيّ المرحلة */
export function storedReturnPolicy(v: unknown): boolean | null {
  return v === true || v === false ? v : null;
}

/** الافتراضي حين لا إعداد: المرحلة الثانية تشترط، والأولى لا */
export const returnLinkDefault = (phase2: boolean): boolean => phase2 === true;

/** هل يُشترط اختيار فاتورة البيع لكل مرتجع؟ — الإعداد الصريح وإلا افتراضيّ المرحلة */
export function returnLinkRequired(stored: unknown, phase2: boolean): boolean {
  const v = storedReturnPolicy(stored);
  return v === null ? returnLinkDefault(phase2) : v;
}

/** ما يُحفظ: اختيارٌ يساوي افتراضيّ المرحلة يُحفظ null — فلا تحمل شركةٌ «لا» من المرحلة الأولى إلى الثانية يوم الانطلاق */
export function normalizeReturnPolicy(value: boolean | null, phase2: boolean): boolean | null {
  return value === null || value === returnLinkDefault(phase2) ? null : value;
}

/** أثر الحفظ في سجلّ الفوترة (zatca_api_logs.outcome) */
export function returnPolicyOutcome(stored: boolean | null): 'REQUIRED' | 'OPTIONAL' | 'DEFAULT' {
  return stored === true ? 'REQUIRED' : stored === false ? 'OPTIONAL' : 'DEFAULT';
}

/**
 * افتراضيّ المرحلة كما يقرّره الإصدار نفسه (compliance/zatca/regime.ts resolveInvoiceRegime): مفعّلة حيّاً
 * (zatcaPhase2StartedAt)، أو شركة بروفة (قائمة البيئة) بعلم المالك وسعودية ومزوّدها الهيئة. وغير ذلك — ومنه علمٌ مضاء لشركةٍ
 * لم تنطلق ولا بروفة لها — مرحلة أولى: إصدارها مرحلة أولى، فافتراضيّها «حرّ» وما يحفظه المدير يسري عليها الآن.
 */
export function returnPolicyPhase2(input: {
  candidate: 'phase1' | 'live' | 'rehearsal-candidate';
  tenantFlag: boolean | null | undefined;
  countryCode: string | null | undefined;
  einvoiceProvider: string | null | undefined;
}): boolean {
  if (input.candidate === 'live') return true;
  if (input.candidate !== 'rehearsal-candidate') return false;
  return input.tenantFlag === true && input.countryCode === 'SA' && input.einvoiceProvider === 'zatca';
}

/** رقمٌ يُطبع مرجعاً للإشعار الدائن: سطرٌ واحد بلا محارف تحكّم أو اتجاه — مرآة normalizeReturnRef في الواجهة */
// والأرقام العربية الهندية (١٢٣ و۱۲۳) لاتينية — لوحة مفاتيح المندوب العربية تكتبها، والمرجع يُطابَق ويُبلَّغ بها موحَّداً
export function normalizeReturnRef(s: unknown): string {
  return typeof s === 'string'
    ? s.replace(/[​‎‏‪-‮⁠-⁤⁦-⁩]/g, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).trim()
    : '';
}

/** سبب رفض الرقم أو null — من ٣ إلى ٦٠ محرفاً وفيه رقمٌ واحد على الأقل، فلا «-» ولا «لا يوجد» */
export function returnRefProblem(s: unknown): string | null {
  const v = normalizeReturnRef(s);
  const n = Array.from(v).length;
  return n < RETURN_REF_MIN || n > RETURN_REF_MAX || !/\d/.test(v) ? RETURN_REF_PROBLEM_MESSAGE : null;
}

/** طريقة دفعٍ مفهومة أو null */
export function returnPaymentTypeOf(v: unknown): ReturnPaymentType | null {
  return (RETURN_PAYMENT_TYPES as readonly string[]).includes(String(v)) ? (v as ReturnPaymentType) : null;
}

/**
 * مستند صندوق الأوف-لاين (X-FS-Replay) أُنشئ على الجهاز **قبل** آخر تغييرٍ للإعداد ⇒ يُقبل: صدر وسُلّمت ورقته حين كان مسموحاً،
 * فرفضه يُعدمه في الصندوق — نمط replayPredatesRepRule (services/repProductRules.ts). ومفتاح API لا ينال التسامح أبداً (عميلٌ
 * حيّ لا صندوق — ترويسته تُمحى أصلاً). ولحظة الجهاز محصورة بـ«الآن − ٧ أيام»: الجهاز يملك ساعته، فتغييرٌ أقدم من النافذة لا
 * يُتسامح معه. بلا لحظةٍ مفهومة أو بلا تغييرٍ مسجَّل ⇒ لا تسامح.
 */
export function replayPredatesReturnPolicy(input: {
  replay: boolean;
  viaApiKey: boolean;
  deviceAt: string | null | undefined;
  changedAt: Date | string | null | undefined;
  now: Date;
}): boolean {
  if (!input.replay || input.viaApiKey || !input.deviceAt || input.changedAt == null) return false;
  const device = Date.parse(input.deviceAt);
  const changed = new Date(input.changedAt).getTime();
  if (!Number.isFinite(device) || !Number.isFinite(changed)) return false;
  const hi = input.now.getTime();
  const clamped = Math.min(hi, Math.max(hi - RETURN_POLICY_REPLAY_MAX_AGE_MS, device));
  return clamped < changed;
}
