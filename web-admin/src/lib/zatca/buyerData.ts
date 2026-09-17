// ============================================================================
// نسخة حرفية من backend/src/compliance/zatca/buyerData.ts (بعد رأسه) — بيانات المشتري في بطاقة العميل (D2): التطبيع وفحص الحفظ
// والاكتمال والتصنيف — فتحكم الواجهة قبل الإرسال بما يحكم به الخادم والإصدار.
// لا تعدّل هنا: عدّل ملف الخادم ثم انسخه. الحارس lib/zatca/buyerData.test.ts يفشل عند أي فرق.
// ============================================================================

import {
  BUYER_ID_SCHEMES, buyerIssues, charLength, isAlphanumericId, isBuildingNo, isCountryCode, isPostalCode, isSaudiVat, sanitizeText,
  TEXT_MAX_CHARS,
} from './validators';
import type { IssueLike } from './validators';
import { classifyBuyerSubtype, mapBuyerPartyLike } from './buyerParty';
import type { BuyerPartySource, BuyerSubtype } from './buyerParty';

export const BUYER_TYPES = ['INDIVIDUAL', 'BUSINESS', 'GOVERNMENT'] as const;
export type BuyerType = (typeof BUYER_TYPES)[number];

/** أعمدة المرحلة الثانية الجديدة في Customer (لا يكتبها اليوم أحد). */
export const BUYER_PHASE2_FIELDS = [
  'buyerType', 'buyerIdScheme', 'buyerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'countryCode',
] as const;
/** أعمدة قائمة يقرؤها طرف المشتري. */
export const BUYER_LEGACY_FIELDS = ['businessName', 'taxNumber', 'commercialReg', 'city', 'district'] as const;
/** حقول الفوترة كلها — ما تقبله نقطة المندوب الضيّقة (Q3) لا غير. */
export const BUYER_BILLING_FIELDS = [...BUYER_PHASE2_FIELDS, ...BUYER_LEGACY_FIELDS] as const;
/**
 * قرار المالك Q3: ما يُكمله المندوب الذي يصدر الفواتير **بلا** صلاحية تعديل العملاء — نوع العميل والمعرّف والعنوان الوطني
 * والدولة، والفارغ منها وحده (لا اسم منشأة ولا رقم ضريبي ولا سجل تجاري، ولا تغيير قيمة محفوظة).
 */
export const BUYER_REP_COMPLETE_FIELDS = [
  'buyerType', 'buyerIdScheme', 'buyerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'city', 'district', 'countryCode',
] as const;
/** مخططات معرّف المشتري الخاصة بالمنشآت (BR-KSA-14): قيمة لأحدها مؤشر منشأة كالسجل التجاري (Q2). */
export const BUSINESS_ID_SCHEMES = ['CRN', '700', 'MOM', 'MLS', 'SAG', 'TIN'] as const;
/** وجود أحدها في جسم POST/PUT يستدعي قراءة بوابة الشركة (غيرها لا يكلّف استعلاماً). */
export const BUYER_GATE_TRIGGER_FIELDS = [...BUYER_PHASE2_FIELDS, 'taxNumber', 'commercialReg'] as const;

export type BuyerField = (typeof BUYER_BILLING_FIELDS)[number];
export type BuyerPatch = Partial<Record<BuyerField, string | null>>;
/** صفّ العميل كما يُقرأ (أعمدة الفوترة + الاسم والقناة). */
export type BuyerRowLike = Partial<Record<BuyerField | 'name' | 'channel', string | null>>;

export interface BuyerFieldError {
  field: BuyerField;
  messageAr: string;
}

/** قنوات البيع التجارية: مؤشر منشأة متوسط (Q2 ⇒ «غير مصنّف» ما لم يوجد رقم ضريبي أو سجل). */
export const BUSINESS_CHANNELS = ['MT', 'WHOLESALE', 'TT', 'DISCOUNTER'] as const;

const DIGIT_FIELDS: ReadonlySet<string> = new Set(['taxNumber', 'commercialReg', 'buyerIdValue', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode']);
const UPPER_FIELDS: ReadonlySet<string> = new Set(['buyerType', 'buyerIdScheme', 'countryCode']);

/** أرقام عربية-هندية وفارسية ⇒ لاتينية (لوحة مفاتيح الجوال). */
export function latinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

/** قيمة حقل الفوترة كما تُحفظ: قصّ، أرقام لاتينية في الحقول الرقمية، أحرف كبيرة للنوع والمخطط والدولة، '' ⇒ null. */
export function buyerFieldValue(field: string, v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (DIGIT_FIELDS.has(field)) s = latinDigits(s);
  if (UPPER_FIELDS.has(field)) s = s.toUpperCase();
  return s === '' ? null : s;
}

const has = (o: unknown, k: string): boolean =>
  !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) && (o as Record<string, unknown>)[k] !== undefined;

/** يلتقط حقول الفوترة الموجودة في الجسم ويطبّعها. قيمة ليست نصاً ولا null ⇒ خطأ للحقل. */
export function normalizeBuyerFields(body: unknown, fields: readonly BuyerField[] = BUYER_BILLING_FIELDS): { patch: BuyerPatch; errors: BuyerFieldError[] } {
  const patch: BuyerPatch = {};
  const errors: BuyerFieldError[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { patch, errors };
  const b = body as Record<string, unknown>;
  for (const f of fields) {
    if (!has(b, f)) continue;
    const v = b[f];
    if (v === null) { patch[f] = null; continue; }
    if (typeof v !== 'string') { errors.push({ field: f, messageAr: `${BUYER_FIELD_LABELS_AR[f]}: قيمة غير صالحة` }); continue; }
    patch[f] = buyerFieldValue(f, v);
  }
  return { patch, errors };
}

/** وجود أي حقل يستدعي بوابة الفوترة في الجسم. */
export function bodyTouchesBuyerGate(body: unknown): boolean {
  return BUYER_GATE_TRIGGER_FIELDS.some(f => has(body, f));
}

/** أسماء الحقول كما يراها المستخدم (رسائل الخادم وقائمة النواقص في الواجهة). */
export const BUYER_FIELD_LABELS_AR: Readonly<Record<BuyerField, string>> = Object.freeze({
  buyerType: 'نوع العميل',
  buyerIdScheme: 'نوع المعرّف',
  buyerIdValue: 'رقم المعرّف',
  addrStreet: 'اسم الشارع',
  addrBuildingNo: 'رقم المبنى',
  addrAdditionalNo: 'الرقم الإضافي',
  addrPostalCode: 'الرمز البريدي',
  countryCode: 'الدولة',
  businessName: 'اسم المنشأة',
  taxNumber: 'الرقم الضريبي',
  commercialReg: 'السجل التجاري',
  city: 'المدينة',
  district: 'الحي',
});

const merge = (stored: BuyerRowLike | null, patch: BuyerPatch): BuyerRowLike => ({ ...(stored ?? {}), ...patch });
const norm = (row: BuyerRowLike | null, f: BuyerField): string | null => buyerFieldValue(f, row?.[f] ?? null);
/** القيمة الفعلية للمقارنة: الدولة null = السعودية (فاختيار «السعودية» صراحةً لعميل بلا دولة — أو العكس — ليس تغييراً). */
const effective = (f: BuyerField, v: string | null | undefined): string | null => (f === 'countryCode' ? v ?? 'SA' : v ?? null);

/** الحقول التي تتغيّر فعلاً بعد التطبيع (المُرسل مقارنةً بالمحفوظ). عميل جديد (stored = null): كل مُرسل غير فارغ. */
export function changedBuyerFields(stored: BuyerRowLike | null, patch: BuyerPatch): BuyerField[] {
  return (Object.keys(patch) as BuyerField[]).filter(f => (BUYER_BILLING_FIELDS as readonly string[]).includes(f) && effective(f, patch[f]) !== effective(f, norm(stored, f)));
}

const SCHEME_FORMAT: Readonly<Record<string, { re: RegExp; hint: string }>> = Object.freeze({
  NAT: { re: /^1[0-9]{9}$/, hint: 'الهوية الوطنية عادةً 10 أرقام تبدأ بالرقم 1' },
  IQA: { re: /^2[0-9]{9}$/, hint: 'رقم الإقامة عادةً 10 أرقام يبدأ بالرقم 2' },
  CRN: { re: /^[0-9]{10}$/, hint: 'السجل التجاري عادةً 10 أرقام' },
  '700': { re: /^7[0-9]{9}$/, hint: 'الرقم الموحد عادةً 10 أرقام يبدأ بالرقم 7' },
  TIN: { re: /^[0-9]{10}$/, hint: 'الرقم المميز عادةً 10 أرقام' },
});

export interface BuyerValidation {
  errors: BuyerFieldError[];
  /** لا تمنع الحفظ (صيغ غير مؤكَّدة من الهيئة، وتنبيهات تصنيف). */
  warnings: BuyerFieldError[];
  changed: BuyerField[];
}

/**
 * فحص الحفظ (الخادم مرجع؛ الواجهة تستعمل النسخة نفسها قبل الإرسال). patch مطبَّع (normalizeBuyerFields)، stored = الصفّ المحفوظ
 * (null لعميل جديد). تُفحص المتغيّرة وحدها — وتغيّر الدولة يُعيد فحص المبنى والرمز البريدي والرقم الضريبي بقيمها المدمجة.
 */
export function validateBuyerChanges(patch: BuyerPatch, stored: BuyerRowLike | null): BuyerValidation {
  const errors: BuyerFieldError[] = [];
  const warnings: BuyerFieldError[] = [];
  const changed = changedBuyerFields(stored, patch);
  const m = merge(stored, patch);
  const v = (f: BuyerField) => norm(m, f);
  const countryChanged = changed.includes('countryCode');
  const check = (f: BuyerField) => changed.includes(f) || (countryChanged && v(f) !== null && ['addrBuildingNo', 'addrPostalCode', 'taxNumber'].includes(f));
  const e = (field: BuyerField, messageAr: string) => errors.push({ field, messageAr });
  const w = (field: BuyerField, messageAr: string) => warnings.push({ field, messageAr });
  const country = v('countryCode') ?? 'SA';
  const saudi = country === 'SA';

  const buyerType = v('buyerType');
  if (check('buyerType') && buyerType !== null && !(BUYER_TYPES as readonly string[]).includes(buyerType)) {
    e('buyerType', 'نوع العميل غير صالح — اختر فرداً أو منشأة أو جهة حكومية');
  }
  const scheme = v('buyerIdScheme');
  if (check('buyerIdScheme') && scheme !== null && !(BUYER_ID_SCHEMES as readonly string[]).includes(scheme)) {
    e('buyerIdScheme', `نوع المعرّف غير مسموح — المسموح: ${BUYER_ID_SCHEMES.join('، ')}`);
  }
  const idValue = v('buyerIdValue');
  const idValueOk = idValue !== null && idValue.length <= 64 && isAlphanumericId(idValue);
  if (check('buyerIdValue') && idValue !== null && !idValueOk) {
    e('buyerIdValue', idValue.length > 64 ? 'رقم المعرّف أطول من المسموح' : 'رقم المعرّف يجب أن يكون أرقاماً أو حروفاً لاتينية بلا مسافات أو رموز');
  }
  const cr = v('commercialReg');
  // الزوج (نوع المعرّف وقيمته) على الصفّ المدمج — حين يتغيّر أحد أطرافه فقط (فلا تمنع بقايا قديمة حفظ غيرها)
  if (changed.includes('buyerIdScheme') || changed.includes('buyerIdValue') || changed.includes('commercialReg')) {
    if (scheme !== null && idValue === null && !(scheme === 'CRN' && cr !== null)) {
      e('buyerIdValue', 'أدخل رقم المعرّف لنوع المعرّف المختار (أو أفرغ نوع المعرّف)');
    }
    if (idValue !== null && scheme === null) e('buyerIdScheme', 'اختر نوع المعرّف لرقم المعرّف المُدخل');
    if (scheme !== null && idValueOk && SCHEME_FORMAT[scheme] && !SCHEME_FORMAT[scheme].re.test(idValue!)) {
      w('buyerIdValue', `تنبيه: ${SCHEME_FORMAT[scheme].hint} — تحقّق من الرقم`);
    }
  }

  const vat = v('taxNumber');
  if (check('taxNumber') && vat !== null) {
    if (saudi) {
      if (!isSaudiVat(vat)) e('taxNumber', 'الرقم الضريبي للعميل يجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3');
    } else if (vat.length > 64) {
      e('taxNumber', 'الرقم الضريبي أطول من المسموح');
    } else {
      w('taxNumber', 'تنبيه: رقم ضريبي لعميل خارج السعودية — معالجته في الفاتورة الضريبية لم تُؤكَّد بعد');
    }
  }
  if (check('commercialReg') && cr !== null) {
    if (cr.length > 64 || !isAlphanumericId(cr)) e('commercialReg', 'السجل التجاري يجب أن يكون أرقاماً أو حروفاً لاتينية بلا مسافات أو رموز');
    else if (!/^[0-9]{10}$/.test(cr)) w('commercialReg', 'تنبيه: رقم السجل التجاري عادةً 10 أرقام — تحقّق منه');
  }

  const text = (f: BuyerField, max: number) => {
    const s = v(f);
    if (!check(f) || s === null) return;
    if (sanitizeText(s) !== s) e(f, `${BUYER_FIELD_LABELS_AR[f]} يحتوي محارف غير مسموحة`);
    else if (charLength(s) > max) e(f, `${BUYER_FIELD_LABELS_AR[f]} أطول من المسموح (${max} حرف)`);
  };
  text('addrStreet', 200);
  text('city', 200);
  text('district', 200);
  text('businessName', TEXT_MAX_CHARS);

  const building = v('addrBuildingNo');
  if (check('addrBuildingNo') && building !== null) {
    if (saudi && !isBuildingNo(building)) e('addrBuildingNo', 'رقم المبنى يجب أن يكون 4 أرقام');
    else if (!saudi && building.length > 16) e('addrBuildingNo', 'رقم المبنى أطول من المسموح');
  }
  const postal = v('addrPostalCode');
  if (check('addrPostalCode') && postal !== null) {
    if (saudi && !isPostalCode(postal)) e('addrPostalCode', 'الرمز البريدي يجب أن يكون 5 أرقام');
    else if (!saudi && postal.length > 16) e('addrPostalCode', 'الرمز البريدي أطول من المسموح');
  }
  const extra = v('addrAdditionalNo');
  if (check('addrAdditionalNo') && extra !== null) {
    if (extra.length > 16) e('addrAdditionalNo', 'الرقم الإضافي أطول من المسموح');
    else if (!/^[0-9]{4}$/.test(extra)) w('addrAdditionalNo', 'تنبيه: الرقم الإضافي في العنوان الوطني عادةً 4 أرقام');
  }
  const cc = v('countryCode');
  if (check('countryCode') && cc !== null && !isCountryCode(cc)) e('countryCode', 'رمز الدولة يجب أن يكون حرفين لاتينيين مثل SA');

  if ((changed.includes('buyerType') || changed.includes('taxNumber') || changed.includes('commercialReg'))
    && buyerType === 'INDIVIDUAL' && ((vat !== null && isSaudiVat(vat)) || cr !== null)) {
    w('buyerType', 'تنبيه: العميل مسجّل فرداً وله رقم ضريبي أو سجل تجاري — هل هو منشأة؟ (الفرد يُصدر له فاتورة مبسطة)');
  }
  // معرّف منشأة (سجل تجاري، رقم موحد، ترخيص…) في حقلَي المعرّف بلا رقم ضريبي ولا سجل: الإصدار لا يعدّه منشأة ما لم يُصنَّف
  const businessId = scheme !== null && (BUSINESS_ID_SCHEMES as readonly string[]).includes(scheme) && idValue !== null;
  if (businessId && vat === null && cr === null && (changed.includes('buyerType') || changed.includes('buyerIdScheme') || changed.includes('buyerIdValue'))) {
    if (buyerType === null) w('buyerType', 'تنبيه: المعرّف المُدخل لمنشأة (سجل تجاري أو رقم موحد أو ترخيص) والعميل غير مصنّف — اختر «منشأة» ليُصدر له فاتورة ضريبية');
    else if (buyerType === 'INDIVIDUAL') w('buyerType', 'تنبيه: العميل مسجّل فرداً ومعرّفه لمنشأة — هل هو منشأة؟ (الفرد يُصدر له فاتورة مبسطة)');
  }
  return { errors, warnings, changed };
}

/** مصدر طرف المشتري من صفّ العميل — الأرقام لاتينية عند القراءة، فتحكم القائمة على البيانات القديمة كما سيحكم الإصدار. */
export function buyerSourceFromCustomer(row: BuyerRowLike): BuyerPartySource {
  const d = (x: string | null | undefined) => (typeof x === 'string' ? latinDigits(x) : x ?? null);
  return {
    name: row.name ?? null,
    businessName: row.businessName ?? null,
    taxNumber: d(row.taxNumber),
    commercialReg: d(row.commercialReg),
    buyerType: row.buyerType ?? null,
    buyerIdScheme: row.buyerIdScheme ?? null,
    buyerIdValue: d(row.buyerIdValue),
    addrStreet: row.addrStreet ?? null,
    addrBuildingNo: d(row.addrBuildingNo),
    addrAdditionalNo: d(row.addrAdditionalNo),
    addrPostalCode: d(row.addrPostalCode),
    district: row.district ?? null,
    city: row.city ?? null,
    countryCode: row.countryCode ?? null,
  };
}

/** حقل مخالفة buyerIssues ⇒ حقل بطاقة العميل. */
export const CUSTOMER_FIELD_MAP: Readonly<Record<string, BuyerField>> = Object.freeze({
  'customer.registrationName': 'businessName',
  'customer.vatNumber': 'taxNumber',
  'customer.otherId.scheme': 'buyerIdScheme',
  'customer.otherId.value': 'buyerIdValue',
  'customer.address.street': 'addrStreet',
  'customer.address.buildingNumber': 'addrBuildingNo',
  'customer.address.additionalNumber': 'addrAdditionalNo',
  'customer.address.district': 'district',
  'customer.address.city': 'city',
  'customer.address.postalZone': 'addrPostalCode',
  'customer.address.country': 'countryCode',
});

export type BuyerClassification = 'business' | 'government' | 'individual' | 'unclassified';
export type BuyerBucket = 'incomplete' | 'complete' | 'unclassified';
export type SuggestionSource = 'explicit' | 'vat' | 'vat-invalid' | 'cr' | 'businessId' | 'channel' | 'businessName';

export interface BuyerStatus {
  /** التصنيف المعروض (Q2). */
  classification: BuyerClassification;
  /** النوع المحفوظ صراحةً (null = لم يُصنَّف). */
  explicitType: BuyerType | null;
  /** نوع الفاتورة لو صدرت الآن (classifySubtype). */
  subtypeIfIssuedNow: BuyerSubtype;
  /** بيانات الضريبية (01) مكتملة: buyerIssues('standard') بلا خطأ. */
  complete: boolean;
  /** مخالفات الضريبية (01) كما يفحصها الإصدار. */
  issues: IssueLike[];
  suggestedType: BuyerType | null;
  suggestionSource: SuggestionSource | null;
  /** موضعه في قائمة بيانات الفوترة (null = فرد بلا مؤشرات: خارج القائمة). */
  bucket: BuyerBucket | null;
}

const blank = (s: string | null | undefined) => typeof s !== 'string' || sanitizeText(s).trim() === '';

export function customerBuyerStatus(row: BuyerRowLike): BuyerStatus {
  const src = buyerSourceFromCustomer(row);
  const t = blank(row.buyerType) ? null : sanitizeText(row.buyerType as string).trim().toUpperCase();
  const explicitType = t !== null && (BUYER_TYPES as readonly string[]).includes(t) ? (t as BuyerType) : null;
  const subtypeIfIssuedNow = classifyBuyerSubtype(src);
  const issues = buyerIssues('standard', mapBuyerPartyLike(src, '01'));
  const complete = !issues.some(i => i.severity === 'error');
  const channel = blank(row.channel) ? null : (row.channel as string).trim().toUpperCase();
  const channelSignal = channel !== null && (BUSINESS_CHANNELS as readonly string[]).includes(channel);
  // معرّف منشأة بقيمته في حقلَي المعرّف (CRN، 700، MOM…) — مؤشر منشأة كالسجل، لكن الإصدار (classifySubtype) لا يعدّه: «غير مصنّف»
  const scheme = blank(row.buyerIdScheme) ? null : sanitizeText(row.buyerIdScheme as string).trim().toUpperCase();
  const businessIdSignal = scheme !== null && (BUSINESS_ID_SCHEMES as readonly string[]).includes(scheme) && !blank(src.buyerIdValue);

  let suggestedType: BuyerType | null = null;
  let suggestionSource: SuggestionSource | null = null;
  if (explicitType) { suggestedType = explicitType; suggestionSource = 'explicit'; }
  else if (!blank(src.taxNumber)) { suggestedType = 'BUSINESS'; suggestionSource = isSaudiVat((src.taxNumber as string).trim()) ? 'vat' : 'vat-invalid'; }
  else if (!blank(src.commercialReg)) { suggestedType = 'BUSINESS'; suggestionSource = 'cr'; }
  else if (businessIdSignal) { suggestedType = 'BUSINESS'; suggestionSource = 'businessId'; }
  else if (channelSignal) { suggestedType = 'BUSINESS'; suggestionSource = 'channel'; }
  else if (!blank(src.businessName)) { suggestedType = 'BUSINESS'; suggestionSource = 'businessName'; }

  let classification: BuyerClassification;
  let bucket: BuyerBucket | null;
  if (subtypeIfIssuedNow === '01') {
    classification = explicitType === 'GOVERNMENT' ? 'government' : 'business';
    bucket = complete ? 'complete' : 'incomplete';
  } else if (explicitType === 'INDIVIDUAL') {
    classification = 'individual';
    bucket = null;
  } else if (suggestionSource === 'businessId' || suggestionSource === 'channel' || suggestionSource === 'businessName') {
    classification = 'unclassified';
    bucket = 'unclassified';
  } else {
    classification = 'individual';
    bucket = null;
  }
  return { classification, explicitType, subtypeIfIssuedNow, complete, issues, suggestedType, suggestionSource, bucket };
}

/** حقول البطاقة الناقصة أو الخاطئة للضريبية (بلا تكرار، بترتيب المخالفات). */
export function missingBuyerFormFields(status: Pick<BuyerStatus, 'issues'>): BuyerField[] {
  const out: BuyerField[] = [];
  for (const i of status.issues) {
    if (i.severity !== 'error') continue;
    const f = CUSTOMER_FIELD_MAP[i.field];
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * نقد الخطة 21: هل ينقل التعديل العميلَ من فاتورة ضريبية (01) إلى مبسطة (02)؟ (مسح الرقم الضريبي/السجل، أو «فرد» لمنشأة.)
 * للإدارة وحدها — المندوب يُكمل ولا يُخفّض.
 */
export function buyerDowngrade(stored: BuyerRowLike, patch: BuyerPatch): boolean {
  return classifyBuyerSubtype(buyerSourceFromCustomer(stored)) === '01'
    && classifyBuyerSubtype(buyerSourceFromCustomer(merge(stored, patch))) === '02';
}

/** حقول محفوظة بقيمة يمسحها التعديل (نقطة المندوب الضيّقة: إكمال لا مسح). الدولة SA ⇒ null ليست مسحاً (null = السعودية). */
export function clearedBuyerFields(stored: BuyerRowLike, patch: BuyerPatch): BuyerField[] {
  return (Object.keys(patch) as BuyerField[]).filter(f => patch[f] === null && norm(stored, f) !== null && effective(f, null) !== effective(f, norm(stored, f)));
}

/**
 * Q3 للمندوب **بلا** صلاحية تعديل العملاء: الحقول المتغيّرة المخالفة — خارج BUYER_REP_COMPLETE_FIELDS، أو لها قيمة محفوظة
 * (إكمال الفارغ لا تعديل المحفوظ ولا مسحه). فارغة = مسموح (والتخفيض يُفحص على حدة: buyerDowngrade).
 */
export function repCompleteOnlyDenied(stored: BuyerRowLike, patch: BuyerPatch): BuyerField[] {
  return changedBuyerFields(stored, patch)
    .filter(f => !(BUYER_REP_COMPLETE_FIELDS as readonly string[]).includes(f) || norm(stored, f) !== null);
}
