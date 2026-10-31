/**
 * فوترة ZATCA المرحلة الثانية (Z5.1a، D2) — أدوات نماذج بيانات المشتري في الواجهة (بلا React): القيم النصّية للنموذج، الحمولة
 * (للإنشاء: غير الفارغ فقط؛ للتعديل: المتغيّر فقط — والمُفرَّغ null)، الفحص قبل الإرسال بقواعد الخادم نفسها (buyerData.ts نسخة
 * حرفية)، والحالة الحيّة للعرض. تُستعمل في لوحة الإدارة و/m وتطبيق المندوب — وكلها لا تظهر إلا حين zatcaCollectOn(company).
 *
 * طلب المالك ٣١ أكتوبر ٢٠٢٦: فكّ قيد الرقم الضريبي والعنوان الوطني (buyerRelaxOn) — الفحص بـ{ relaxed: true } يحوّل أخطاء صيغ
 * الرقم الضريبي ورقم المبنى والرمز البريدي إلى تنبيهات لا تمنع الحفظ، والشارة تقول «ناقصة تصدر مبسطة». بلا الخيار: كما اليوم حرفياً.
 */
import { BUYER_ID_SCHEMES } from './validators';
import {
  BUYER_BILLING_FIELDS, BUYER_FIELD_LABELS_AR, BUYER_PHASE2_FIELDS, BUYER_RELAXABLE_FIELDS, BUYER_REP_COMPLETE_FIELDS, BuyerField, BuyerFieldError,
  BuyerPatch, BuyerRowLike, BuyerStatus, buyerFieldValue, buyerIssuanceDecision, clearedBuyerFields, customerBuyerStatus, normalizeBuyerFields,
  validateBuyerChanges,
} from './buyerData';

export type BuyerFormValues = Record<BuyerField, string>;

/**
 * أسماء الحقول في الواجهة (مفاتيح القاموس العامّ). حقول العنوان الوطني بصيغة تذكر عدد الأرقام — والأسماء المجرّدة
 * («اسم الشارع»، «رقم المبنى»…) عبارات تبويب الربط في حزمته الكسولة (zatcaPhrases.ts) ولا تتكرّر في القاموس العامّ.
 */
export const BUYER_FIELD_UI_LABELS_AR: Readonly<Record<BuyerField, string>> = Object.freeze({
  ...BUYER_FIELD_LABELS_AR,
  addrStreet: 'اسم الشارع (العنوان الوطني)',
  addrBuildingNo: 'رقم المبنى (4 أرقام)',
  addrAdditionalNo: 'الرقم الإضافي (4 أرقام)',
  addrPostalCode: 'الرمز البريدي (5 أرقام)',
});

/** أسماء مخططات معرّف المشتري (BR-KSA-14) كما يراها المستخدم. */
export const BUYER_ID_SCHEME_LABELS_AR: Readonly<Record<(typeof BUYER_ID_SCHEMES)[number], string>> = Object.freeze({
  TIN: 'الرقم المميز',
  CRN: 'السجل التجاري',
  MOM: 'رخصة وزارة الشؤون البلدية',
  MLS: 'رخصة وزارة الموارد البشرية',
  '700': 'الرقم الموحد 700',
  SAG: 'ترخيص وزارة الاستثمار',
  NAT: 'الهوية الوطنية',
  GCC: 'هوية خليجية',
  IQA: 'الإقامة',
  PAS: 'جواز السفر',
  OTH: 'معرف آخر',
});

export const BUYER_TYPE_LABELS_AR = Object.freeze({ BUSINESS: 'منشأة', INDIVIDUAL: 'فرد', GOVERNMENT: 'جهة حكومية' } as const);

export const BUYER_CLASSIFICATION_LABELS_AR = Object.freeze({
  business: 'منشأة', government: 'جهة حكومية', individual: 'فرد', unclassified: 'غير مصنف',
} as const);

/** قيم النموذج النصّية من صفّ العميل (null ⇒ ''). */
export function buyerFormValues(row?: BuyerRowLike | null): BuyerFormValues {
  const out = {} as BuyerFormValues;
  for (const f of BUYER_BILLING_FIELDS) {
    const v = row?.[f];
    out[f] = typeof v === 'string' ? v : '';
  }
  return out;
}

/** حمولة الإنشاء: الحقول غير الفارغة وحدها (الخادم يطبّع). */
export function buyerCreatePayload(values: Partial<BuyerFormValues>, fields: readonly BuyerField[] = BUYER_PHASE2_FIELDS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = (values[f] ?? '').trim();
    if (v !== '') out[f] = v;
  }
  return out;
}

/** حمولة التعديل: المتغيّر بعد التطبيع وحده؛ المُفرَّغ من قيمة محفوظة يُرسل null (فيُمسح فعلاً). */
export function buyerUpdatePayload(values: Partial<BuyerFormValues>, stored: BuyerRowLike | null | undefined, fields: readonly BuyerField[] = BUYER_PHASE2_FIELDS): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of fields) {
    if (values[f] === undefined) continue;
    const next = buyerFieldValue(f, values[f]);
    if (next === buyerFieldValue(f, stored?.[f] ?? null)) continue;
    out[f] = next === null ? null : (values[f] as string).trim();
  }
  return out;
}

export interface BuyerFormCheck {
  patch: BuyerPatch;
  /** رسالة الخطأ الأولى لكل حقل. */
  errors: Partial<Record<BuyerField, string>>;
  warnings: BuyerFieldError[];
  /** حقول محفوظة بقيمة يُفرغها النموذج. */
  cleared: BuyerField[];
  ok: boolean;
}

/**
 * الفحص قبل الإرسال — القواعد نفسها في الخادم (المتغيّر وحده؛ النقص لا يمنع). opts.relaxed (= buyerRelaxOn(company)): ما يفكّه
 * القيد يصل في warnings فيبقى ok صادقاً؛ غيابه أو false = فحص اليوم حرفياً.
 */
export function buyerFormCheck(values: Partial<BuyerFormValues>, stored: BuyerRowLike | null | undefined, fields: readonly BuyerField[] = BUYER_PHASE2_FIELDS, opts: { relaxed?: boolean } = {}): BuyerFormCheck {
  const body: Record<string, string> = {};
  for (const f of fields) if (values[f] !== undefined) body[f] = values[f] as string;
  const { patch, errors: typeErrors } = normalizeBuyerFields(body, fields);
  const v = validateBuyerChanges(patch, stored ?? null, { relaxed: opts.relaxed === true });
  const errors: Partial<Record<BuyerField, string>> = {};
  for (const e of [...typeErrors, ...v.errors]) if (!errors[e.field]) errors[e.field] = e.messageAr;
  const cleared = stored ? clearedBuyerFields(stored, patch) : [];
  return { patch, errors, warnings: v.warnings, cleared, ok: Object.keys(errors).length === 0 };
}

/** صفّ العميل كما سيُحفظ (قيم النموذج فوق المحفوظ). */
export function liveBuyerRow(stored: BuyerRowLike | null | undefined, values: Partial<Record<BuyerField | 'name' | 'channel', string>>): BuyerRowLike {
  const row: BuyerRowLike = { ...(stored ?? {}) };
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string') (row as Record<string, string | null>)[k] = v;
  return row;
}

/** حالة العميل كما ستُحفظ (قيم النموذج فوق المحفوظ) — للعرض الحيّ في النموذج. */
export function liveBuyerStatus(stored: BuyerRowLike | null | undefined, values: Partial<Record<BuyerField | 'name' | 'channel', string>>): BuyerStatus {
  return customerBuyerStatus(liveBuyerRow(stored, values));
}

/**
 * فكّ القيد: منشأة (01) ناقصة تصدر لها الآن فاتورة مبسطة (02) — القرار نفسه الذي يتّخذه الإصدار في الخادم (buyerIssuanceDecision
 * بنسخته الحرفية). للشركة التي فكّت القيد وحدها؛ ولغيرها لا يُسأل.
 */
export function buyerRelaxSimplified(row: BuyerRowLike): boolean {
  return buyerIssuanceDecision(row, true).simplifiedByRelax;
}

/**
 * تنبيهات فكّ القيد الحيّة في النموذج: ما صار تنبيهاً من صيغ الرقم الضريبي ورقم المبنى والرمز البريدي (BUYER_RELAXABLE_FIELDS) —
 * لا تنبيهات التصنيف القائمة اليوم (لا تُعرض في النموذج اليوم ولا تتغيّر). للشركة التي فكّت القيد وحدها.
 */
export function buyerRelaxWarnings(values: Partial<BuyerFormValues>, stored: BuyerRowLike | null | undefined): BuyerFieldError[] {
  return buyerFormCheck(values, stored, BUYER_BILLING_FIELDS, { relaxed: true }).warnings
    .filter(w => (BUYER_RELAXABLE_FIELDS as readonly string[]).includes(w.field));
}

/**
 * Q3 (نموذج المندوب بلا صلاحية تعديل العملاء): حقل مقفل = خارج حقول الإكمال، أو له قيمة محفوظة — القاعدة نفسها التي يفرضها
 * الخادم (repCompleteOnlyDenied). الدولة المحفوظة null (= السعودية) تبقى قابلة للإكمال.
 */
export function repCompleteLocked(stored: BuyerRowLike | null | undefined, field: BuyerField): boolean {
  return !(BUYER_REP_COMPLETE_FIELDS as readonly string[]).includes(field) || buyerFieldValue(field, stored?.[field] ?? null) !== null;
}

/**
 * شارة القائمة: ناقص لضريبية، أو غير مصنّف، أو لا شيء. relaxed (فكّ القيد): الناقص الذي تصدر له مبسطة ⇒ 'simplified'
 * («ناقصة تصدر مبسطة») — وبلاه كما اليوم حرفياً.
 */
export function buyerBadge(row: BuyerRowLike, relaxed = false): 'incomplete' | 'unclassified' | 'simplified' | null {
  const b = customerBuyerStatus(row).bucket;
  if (relaxed && b === 'incomplete' && buyerRelaxSimplified(row)) return 'simplified';
  return b === 'incomplete' || b === 'unclassified' ? b : null;
}
