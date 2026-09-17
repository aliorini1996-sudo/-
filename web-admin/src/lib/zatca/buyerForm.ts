/**
 * فوترة ZATCA المرحلة الثانية (Z5.1a، D2) — أدوات نماذج بيانات المشتري في الواجهة (بلا React): القيم النصّية للنموذج، الحمولة
 * (للإنشاء: غير الفارغ فقط؛ للتعديل: المتغيّر فقط — والمُفرَّغ null)، الفحص قبل الإرسال بقواعد الخادم نفسها (buyerData.ts نسخة
 * حرفية)، والحالة الحيّة للعرض. تُستعمل في لوحة الإدارة و/m وتطبيق المندوب — وكلها لا تظهر إلا حين zatcaCollectOn(company).
 */
import { BUYER_ID_SCHEMES } from './validators';
import {
  BUYER_BILLING_FIELDS, BUYER_FIELD_LABELS_AR, BUYER_PHASE2_FIELDS, BUYER_REP_COMPLETE_FIELDS, BuyerField, BuyerFieldError, BuyerPatch, BuyerRowLike,
  BuyerStatus, buyerFieldValue, clearedBuyerFields, customerBuyerStatus, normalizeBuyerFields, validateBuyerChanges,
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

/** الفحص قبل الإرسال — القواعد نفسها في الخادم (المتغيّر وحده؛ النقص لا يمنع). */
export function buyerFormCheck(values: Partial<BuyerFormValues>, stored: BuyerRowLike | null | undefined, fields: readonly BuyerField[] = BUYER_PHASE2_FIELDS): BuyerFormCheck {
  const body: Record<string, string> = {};
  for (const f of fields) if (values[f] !== undefined) body[f] = values[f] as string;
  const { patch, errors: typeErrors } = normalizeBuyerFields(body, fields);
  const v = validateBuyerChanges(patch, stored ?? null);
  const errors: Partial<Record<BuyerField, string>> = {};
  for (const e of [...typeErrors, ...v.errors]) if (!errors[e.field]) errors[e.field] = e.messageAr;
  const cleared = stored ? clearedBuyerFields(stored, patch) : [];
  return { patch, errors, warnings: v.warnings, cleared, ok: Object.keys(errors).length === 0 };
}

/** حالة العميل كما ستُحفظ (قيم النموذج فوق المحفوظ) — للعرض الحيّ في النموذج. */
export function liveBuyerStatus(stored: BuyerRowLike | null | undefined, values: Partial<Record<BuyerField | 'name' | 'channel', string>>): BuyerStatus {
  const row: BuyerRowLike = { ...(stored ?? {}) };
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string') (row as Record<string, string | null>)[k] = v;
  return customerBuyerStatus(row);
}

/**
 * Q3 (نموذج المندوب بلا صلاحية تعديل العملاء): حقل مقفل = خارج حقول الإكمال، أو له قيمة محفوظة — القاعدة نفسها التي يفرضها
 * الخادم (repCompleteOnlyDenied). الدولة المحفوظة null (= السعودية) تبقى قابلة للإكمال.
 */
export function repCompleteLocked(stored: BuyerRowLike | null | undefined, field: BuyerField): boolean {
  return !(BUYER_REP_COMPLETE_FIELDS as readonly string[]).includes(field) || buyerFieldValue(field, stored?.[field] ?? null) !== null;
}

/** شارة القائمة: ناقص لضريبية، أو غير مصنّف، أو لا شيء. */
export function buyerBadge(row: BuyerRowLike): 'incomplete' | 'unclassified' | null {
  const b = customerBuyerStatus(row).bucket;
  return b === 'incomplete' || b === 'unclassified' ? b : null;
}
