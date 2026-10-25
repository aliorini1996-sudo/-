/**
 * «إدارة طرق الدفع» (طلب المالك ٢٥ أكتوبر ٢٠٢٦) — قراءة العمود CompanySettings.paymentMethodsConfig وحفظه.
 *
 * البنية والقواعد كلها في paymentMethodsCore.ts (منسوخة حرفياً في الواجهة): هنا حدّ الحجم قبل التحليل، وتوليد مفاتيح الطرق
 * الجديدة بعشوائيةٍ من الخادم، والقراءة المتسامحة للعرض، وصورة الردّ الموحّدة لـGET وPUT. null في العمود = سلوك اليوم حرفياً.
 *
 * لا يستورد services/gl ولا يستوردها: routes/receipts.ts يقرأ هذه الوحدة ومحروسٌ بـgl-hooks-static (المسارات التشغيلية لا
 * تعرف الدفاتر)، والدفاتر لا تعرف المفتاح المخصّص أصلاً — تعمل على الأساس المخزّن في Receipt.paymentMethod.
 */
import { randomBytes } from 'crypto';
import {
  PAYMENT_METHODS_ISSUES, PAYMENT_METHODS_LIMITS, checkPaymentMethodsConfig, isDefaultPaymentMethodsConfig,
  paymentMethodsConfigBytes, paymentMethodsList, readPaymentMethodsConfig, receiptMethodChoices,
  type PaymentMethodsConfigV1, type PaymentMethodsIssue, type ResolvedPaymentMethod,
} from './paymentMethodsCore';

export * from './paymentMethodsCore';

/** مفتاح طريقة جديدة: c_ وعشرة محارف base36 من بايتات عشوائية — لا يُخمَّن ولا يتكرّر عملياً، ويطابق CUSTOM_METHOD_KEY_RE */
export function newPaymentMethodKey(): string {
  const bytes = randomBytes(10);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] % 36).toString(36);
  return `c_${s}`;
}

/**
 * «استعادة الافتراضي»: جسم PUT هو JSON null أو { reset: true } وحده (كإعدادات الطباعة). لكنه لا يمحو المخصّصة — تبقى
 * معطّلة بأسمائها (resetPaymentMethodsConfig) لأن سنداتها القديمة تُعرض بها.
 */
export function isPaymentMethodsReset(body: unknown): boolean {
  if (body === null) return true;
  if (typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length === 1 && keys[0] === 'reset' && (body as { reset?: unknown }).reset === true;
}

export type PaymentMethodsParse =
  | { ok: true; value: PaymentMethodsConfigV1 }
  | { ok: false; status: 400 | 413; code: 'PAYMENT_METHODS_INVALID' | 'PAYMENT_METHODS_TOO_LARGE'; message: string; issues: PaymentMethodsIssue[] };

/** جسم PUT /api/company/payment-methods ⇒ الصورة القانونية (بمفاتيح مولَّدة للجديدة)، أو سبب الرفض بالعربية */
export function parsePaymentMethodsConfig(body: unknown, newKey: () => string = newPaymentMethodKey): PaymentMethodsParse {
  // الحجم أولاً — قبل أن يمشي zod على جسمٍ ضخم (العمود يُقرأ مع كل GET /api/company لكل جهاز ويُخزَّن أوف‑لاين)
  if (paymentMethodsConfigBytes(body ?? null) > PAYMENT_METHODS_LIMITS.maxBytes) {
    const m = PAYMENT_METHODS_ISSUES.tooLarge;
    return { ok: false, status: 413, code: 'PAYMENT_METHODS_TOO_LARGE', message: m, issues: [{ path: '', message: m }] };
  }
  const r = checkPaymentMethodsConfig(body, { newKey });
  if (!r.ok) return { ok: false, status: 400, code: 'PAYMENT_METHODS_INVALID', message: r.issues[0]?.message ?? PAYMENT_METHODS_ISSUES.shape, issues: r.issues };
  return { ok: true, value: r.value };
}

/**
 * القيمة المخزّنة ⇒ ما يُعرض ويُتحقّق به. config: null = الافتراضي (ومنه كائنٌ يساوي الافتراضي حرفياً). القيمة التي لا
 * تُقرأ (لا يُفترض أن تقع: الحفظ يمرّ من هنا وحده) ⇒ الافتراضي مع تنبيهٍ في السجلّ — كما يفعل الجهاز.
 */
export function storedPaymentMethodsConfig(raw: unknown): { config: PaymentMethodsConfigV1 | null; stored: boolean } {
  if (raw === null || raw === undefined) return { config: null, stored: false };
  const config = readPaymentMethodsConfig(raw);
  if (!config) {
    console.warn('[payment-methods] قيمة مخزّنة غير صالحة — تُقرأ افتراضياً');
    return { config: null, stored: false };
  }
  if (isDefaultPaymentMethodsConfig(config)) return { config: null, stored: false };
  return { config, stored: true };
}

/** ردّ GET وPUT: الإعداد المخزّن (null = الافتراضي) وكل الطرق بأسمائها، وما يعرضه نموذج السند */
export interface PaymentMethodsView {
  data: PaymentMethodsConfigV1 | null;
  stored: boolean;
  hasCompany: boolean;
  methods: ResolvedPaymentMethod[];
  choices: ResolvedPaymentMethod[];
}
export function paymentMethodsView(config: PaymentMethodsConfigV1 | null, hasCompany: boolean): PaymentMethodsView {
  const data = isDefaultPaymentMethodsConfig(config) ? null : config;
  return { data, stored: data !== null, hasCompany, methods: paymentMethodsList(data), choices: receiptMethodChoices(data) };
}
