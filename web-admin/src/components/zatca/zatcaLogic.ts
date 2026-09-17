/**
 * منطق تبويب «الفوترة الإلكترونية — المرحلة الثانية (فاتورة)» — نقيّ بلا React ولا DOM ولا شبكة.
 *
 * الخادم (backend/src/routes/zatca.ts) هو الحارس الفعلي: الفحوص هنا تكرار للصيغ نفسها كي يرى المدير الخطأ
 * بجانب الحقل قبل الإرسال، لا بديلٌ عنها. التسميات عربية وتُمرَّر عبر tr() في المكوّن (مداخلها في i18n/strings.ts،
 * والحارس في zatcaLogic.test.ts).
 */
import type {
  ZatcaEnv, ZatcaJobOutcome, ZatcaReadinessIssue, ZatcaSellerData, ZatcaSellerField, ZatcaUnitPayload, ZatcaUnitStatus, ZatcaUnitView,
} from '../../types';

// ─── الأرقام ورمز التحقق ───

/** أرقام عربية-هندية وفارسية ⇒ لاتينية (لوحة مفاتيح الجوال). */
export function normalizeDigits(s: string): string {
  return s.replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

/** ما يُكتب في خانة OTP: أرقام لاتينية فقط، ستّة على الأكثر (اللصق بمسافات أو شرطات يُقبل). */
export function normalizeOtp(s: string): string {
  return normalizeDigits(s).replace(/[^0-9]/g, '').slice(0, 6);
}

export function isOtpComplete(s: string): boolean {
  return /^[0-9]{6}$/.test(s);
}

/**
 * أقصى طول لخانة OTP الأصلية (maxLength). ليس 6: المتصفّح يقصّ النصّ الملصوق قبل onChange، فـ«123 456» أو « 123456»
 * تصير خمسة أرقام ويبقى الزرّ معطّلاً بلا تفسير. normalizeOtp هي التي تقصّ إلى ستة بعد حذف المسافات والشرطات.
 */
export const OTP_INPUT_MAX_LENGTH = 32;

// ─── بيانات البائع ───

export const SELLER_FIELDS: readonly ZatcaSellerField[] = [
  'legalName', 'taxNumber', 'commercialReg', 'sellerIdScheme', 'sellerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo',
  'addrDistrict', 'addrCity', 'addrPostalCode', 'vatGroupTin',
];

export const SELLER_FIELD_LABEL: Record<ZatcaSellerField, string> = {
  legalName: 'الاسم القانوني للمنشأة كما في السجل التجاري',
  taxNumber: 'الرقم الضريبي',
  commercialReg: 'السجل التجاري',
  sellerIdScheme: 'نوع معرّف المنشأة',
  sellerIdValue: 'رقم المعرّف إن اختلف عن السجل التجاري',
  addrStreet: 'اسم الشارع',
  addrBuildingNo: 'رقم المبنى',
  addrAdditionalNo: 'الرقم الإضافي',
  addrDistrict: 'الحي',
  addrCity: 'المدينة',
  addrPostalCode: 'الرمز البريدي',
  vatGroupTin: 'الرقم المميّز لعضو المجموعة الضريبية',
};

export const SELLER_ID_SCHEMES = ['CRN', 'MOM', 'MLS', '700', 'SAG', 'OTH'] as const;

export const SELLER_ID_SCHEME_LABEL: Record<(typeof SELLER_ID_SCHEMES)[number], string> = {
  CRN: 'السجل التجاري (CRN)',
  MOM: 'ترخيص وزارة البلديات (MOM)',
  MLS: 'ترخيص وزارة الموارد البشرية (MLS)',
  '700': 'الرقم الموحد (700)',
  SAG: 'ترخيص وزارة الاستثمار (SAG)',
  OTH: 'معرّف آخر (OTH)',
};

const DIGIT_FIELDS: ReadonlySet<ZatcaSellerField> = new Set<ZatcaSellerField>(['taxNumber', 'commercialReg', 'sellerIdValue', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'vatGroupTin']);

export type SellerDraft = Record<ZatcaSellerField, string>;

export function draftOf(seller: Partial<ZatcaSellerData> | null | undefined): SellerDraft {
  const out = {} as SellerDraft;
  for (const f of SELLER_FIELDS) out[f] = seller?.[f] ?? '';
  return out;
}

/** قيمة الحقل كما تُرسل (مسافات الأطراف تُحذف، والأرقام العربية تُطبَّع في الحقول الرقمية). */
export function cleanFieldValue(field: ZatcaSellerField, value: string): string {
  let s = value.trim();
  if (DIGIT_FIELDS.has(field)) s = normalizeDigits(s);
  if (field === 'sellerIdScheme') s = s.toUpperCase();
  return s;
}

export function isVatGroup(vat: string | null | undefined): boolean {
  return typeof vat === 'string' && /^[0-9]{15}$/.test(vat) && vat[10] === '1';
}

/** خطأ صيغة الحقل (رسالة عربية) — يُفحص فقط حين تُدخل قيمة (design §1.4). */
export function sellerFieldError(field: ZatcaSellerField, raw: string): string | null {
  const v = cleanFieldValue(field, raw);
  if (v === '') return null;
  switch (field) {
    case 'taxNumber': return /^3[0-9]{13}3$/.test(v) ? null : 'الرقم الضريبي يجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3';
    case 'addrBuildingNo': return /^[0-9]{4}$/.test(v) ? null : 'رقم المبنى يجب أن يكون 4 أرقام';
    case 'addrPostalCode': return /^[0-9]{5}$/.test(v) ? null : 'الرمز البريدي يجب أن يكون 5 أرقام';
    case 'vatGroupTin': return /^[0-9]{10}$/.test(v) ? null : 'الرقم المميّز لعضو المجموعة الضريبية يجب أن يكون 10 أرقام';
    case 'sellerIdScheme': return (SELLER_ID_SCHEMES as readonly string[]).includes(v) ? null : 'نوع معرّف المنشأة غير مسموح';
    case 'sellerIdValue': return /^[A-Za-z0-9]+$/.test(v) ? null : 'معرّف المنشأة يجب أن يكون أرقاماً أو حروفاً لاتينية بلا مسافات أو رموز';
    default: return null;
  }
}

export function draftErrors(draft: SellerDraft): Partial<Record<ZatcaSellerField, string>> {
  const out: Partial<Record<ZatcaSellerField, string>> = {};
  for (const f of SELLER_FIELDS) {
    const e = sellerFieldError(f, draft[f]);
    if (e) out[f] = e;
  }
  return out;
}

/** الحقول التي تغيّرت فعلاً (فارغ = إفراغ ⇒ null) — لا يُرسل ما لم يمسّه المدير. */
export function sellerPatch(original: Partial<ZatcaSellerData> | null | undefined, draft: SellerDraft): Partial<Record<ZatcaSellerField, string | null>> {
  const out: Partial<Record<ZatcaSellerField, string | null>> = {};
  for (const f of SELLER_FIELDS) {
    const next = cleanFieldValue(f, draft[f]);
    const prev = original?.[f] ?? '';
    if (next !== prev) out[f] = next === '' ? null : next;
  }
  return out;
}

/**
 * بيانات منشأة جديدة من الخادم في مسودة البطاقة، حقلاً بحقل (نظير keepLocalEdits في الإعدادات العامة): الحقل الذي ما زالت قيمته
 * بعد التنظيف كخطّ الأساس (آخر بيانات طُبّقت، أو ما حُفظ) يأخذ الجديد، وما عدّله المدير يبقى. التبويبان مركّبان معاً، فحفظ
 * الرقم الضريبي أو السجل من «الإعدادات العامة» أثناء تعديل غير محفوظ هنا يصل المسودة — ولا يعيده «حفظ بيانات المنشأة» قديماً.
 * baseline = null ⇒ الخادم كاملاً.
 */
export function mergeSellerDraft(baseline: Partial<ZatcaSellerData> | null | undefined, next: Partial<ZatcaSellerData> | null | undefined, draft: SellerDraft): SellerDraft {
  if (!baseline) return draftOf(next);
  const out = { ...draft };
  for (const f of SELLER_FIELDS) {
    if (cleanFieldValue(f, draft[f]) === cleanFieldValue(f, baseline[f] ?? '')) out[f] = next?.[f] ?? '';
  }
  return out;
}

/** خطّ الأساس بعد حفظ ناجح: البيانات السابقة مع ما أُرسل — فيأخذ كل حقل محفوظ لم يُعدَّل بعد الإرسال قيمةَ الخادم المطبَّعة. */
export function sellerBaselineAfterSave(seller: Partial<ZatcaSellerData> | null | undefined, patch: Partial<Record<ZatcaSellerField, string | null>>): Partial<ZatcaSellerData> {
  return { ...(seller ?? {}), ...patch } as Partial<ZatcaSellerData>;
}

export function readinessErrors(issues: readonly ZatcaReadinessIssue[] | null | undefined): ZatcaReadinessIssue[] {
  return (issues ?? []).filter(i => i.severity === 'error');
}

/** قيود طلب شهادة الهيئة (CSR) على الاسم — مطابقة لـvalidateCsrParams في الخادم (compliance/zatca/csr.ts). */
export const CSR_ORG_NAME_MAX = 64;
const CSR_FORBIDDEN_CHARACTERS = /[!@#$%&*_<]/;
const CSR_INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * تنبيه (لا يمنع الحفظ) على الاسم القانوني: يُكتب اسمَ المنشأة (O) في طلب الشهادة الذي يرفض ما تجاوز 64 محرفاً أو حمل
 * ! @ # $ % & * _ < أو محارف خفية. الخادم يقبل الاسم كما هو ويعرض المسألة في الجاهزية فيمنع «إنشاء وحدة الربط» وحده.
 */
export function csrOrgNameHint(raw: string): string | null {
  switch (csrTextIssue(raw)) {
    case 'invisible': return 'الاسم يحتوي محارف خفية أو علامات اتجاه (غالبا من نص منسوخ) يرفضها طلب شهادة الهيئة — أعد كتابته يدويا';
    case 'long': return 'طلب شهادة الهيئة يقبل 64 محرفا على الأكثر لاسم المنشأة — اختصر الاسم قبل ربط الوحدة';
    case 'forbidden': return 'طلب شهادة الهيئة لا يقبل المحارف ! @ # $ % & * _ < في اسم المنشأة — احذفها قبل ربط الوحدة';
    default: return null;
  }
}

/** مخالفة نصّ حقل CSR (الاسم أو العنوان — الحدّ 64 لكليهما) بقواعد validateCsrParams؛ فراغ الطرفين يُحذف قبل الإرسال فلا يُعدّ. */
function csrTextIssue(raw: string): 'invisible' | 'long' | 'forbidden' | null {
  const v = raw.trim();
  if (v === '') return null;
  if (CSR_INVISIBLE_CHARACTERS.test(v)) return 'invisible';
  if (Array.from(v).length > CSR_ORG_NAME_MAX) return 'long';
  if (CSR_FORBIDDEN_CHARACTERS.test(v) || v.startsWith('\\')) return 'forbidden';
  return null;
}

/** «العنوان المختصر في الشهادة» (registeredAddress ≤ 64) بقواعد الخادم نفسها — لا يُرسل رمز تحقق سيرفض طلبُ الشهادة عنوانه. */
export function csrLocationHint(raw: string): string | null {
  switch (csrTextIssue(raw)) {
    case 'invisible': return 'العنوان يحتوي محارف خفية أو علامات اتجاه (غالبا من نص منسوخ) يرفضها طلب شهادة الهيئة — أعد كتابته يدويا';
    case 'long': return 'طلب شهادة الهيئة يقبل 64 محرفا على الأكثر للعنوان — اختصره';
    case 'forbidden': return 'طلب شهادة الهيئة لا يقبل المحارف ! @ # $ % & * _ < في العنوان — احذفها';
    default: return null;
  }
}

/** بادئة مسألة الجاهزية حين يرفض طلبُ الشهادة العنوانَ المشتقّ من عنوان المنشأة (csrReadinessIssues في routes/zatca.ts). */
export const CSR_ADDRESS_RULE_PREFIX = 'CSR-REGISTERED-ADDRESS-';

/**
 * «العنوان المختصر في الشهادة» في نموذجَي إعادة الربط بعد رفض (ERROR_NEEDS_OTP) والتجديد: الخدمة تعيد فيهما اشتقاق العنوان
 * من عنوان المنشأة الحالي. إن كان ذلك العنوان مرفوضاً (تحذير الجاهزية) يُفتح الحقل مسبقاً بعنوان الوحدة الحالي — العنوان
 * المختصر الذي أُنشئت به — وإلا يبقى فارغاً مطويّاً فيُكتب عنوان المنشأة المحدَّث (design §5.1 خطوة 9).
 */
export function csrLocationDefaults(unit: Pick<ZatcaUnitView, 'locationAddress'>, issues: readonly ZatcaReadinessIssue[] | null | undefined): { open: boolean; value: string } {
  if (!(issues ?? []).some(i => i.rule.startsWith(CSR_ADDRESS_RULE_PREFIX))) return { open: false, value: '' };
  const current = (unit.locationAddress ?? '').trim();
  return { open: true, value: current !== '' && csrLocationHint(current) === null ? current : '' };
}

export type CsrFix = { kind: 'unit-location' } | { kind: 'seller-field'; inputId: string };

/** ما يُصلح نتيجة مهمّة CSR_PARAMS_INVALID على بطاقة الوحدة: خانة العنوان المختصر في البطاقة، أو حقل بيانات المنشأة. */
export function csrFailureFix(outcome: ZatcaJobOutcome | null | undefined, ctx: { vatGroup: boolean }): CsrFix | null {
  if (!outcome || outcome.ok || outcome.code !== 'CSR_PARAMS_INVALID') return null;
  switch (outcome.field) {
    case 'locationAddress': return { kind: 'unit-location' };
    case 'orgName': return { kind: 'seller-field', inputId: 'zatca-legalName' };
    case 'vatNumber': return { kind: 'seller-field', inputId: 'zatca-taxNumber' };
    case 'orgUnit': return ctx.vatGroup ? { kind: 'seller-field', inputId: 'zatca-vatGroupTin' } : null;
    default: return null;
  }
}

/** مسألة جاهزية من قيود طلب الشهادة لحقل محفوظ (rule يبدأ بـCSR-) — تُعرض بجانب الحقل ما لم يعدّله المدير. */
export function csrIssueFor(issues: readonly ZatcaReadinessIssue[] | null | undefined, field: ZatcaSellerField): ZatcaReadinessIssue | null {
  return (issues ?? []).find(i => i.settingsField === field && i.rule.startsWith('CSR-')) ?? null;
}

/** حقول العنوان الوطني التي يُشتقّ منها عنوان الوحدة في طلب الشهادة (LOCATION_SOURCE_FIELDS في routes/zatca.ts). */
const CSR_LOCATION_SOURCE_FIELDS: ReadonlySet<string> = new Set(['addrStreet', 'addrDistrict', 'addrCity', 'addrBuildingNo', 'addrPostalCode']);

/**
 * حقل الإدخال الذي يُصلح رفض CSR_PARAMS_INVALID عند الإنشاء (field من الخادم: حقل CSR لا حقل الإعدادات).
 * advanced = تُفتح «خيارات متقدمة لطلب الشهادة» قبل التركيز (الحقل فيها، أو فيها البديل).
 * العنوان المشتقّ المرفوض (بلا عنوان مختصر): الحقل الذي سمّاه الخادم في مسألة الجاهزية CSR-REGISTERED-ADDRESS-* (قد يكون الحي أو
 * المدينة لا الشارع) مع فتح الخيارات المتقدمة ففيها «العنوان المختصر في الشهادة» — وبلا مسألة: خانة العنوان المختصر نفسها.
 */
export function csrFieldTarget(
  field: string | null,
  ctx: { vatGroup: boolean; locationOverride: boolean; issues?: readonly ZatcaReadinessIssue[] | null },
): { inputId: string; advanced: boolean } | null {
  switch (field) {
    case 'orgName': return { inputId: 'zatca-legalName', advanced: false };
    case 'vatNumber': return { inputId: 'zatca-taxNumber', advanced: false };
    case 'orgUnit': return ctx.vatGroup ? { inputId: 'zatca-vatGroupTin', advanced: false } : { inputId: 'zatca-branch', advanced: true };
    case 'locationAddress': {
      if (ctx.locationOverride) return { inputId: 'zatca-location', advanced: true };
      const culprit = (ctx.issues ?? []).find(i => i.rule.startsWith(CSR_ADDRESS_RULE_PREFIX) && !!i.settingsField && CSR_LOCATION_SOURCE_FIELDS.has(i.settingsField))?.settingsField;
      return { inputId: culprit ? `zatca-${culprit}` : 'zatca-location', advanced: true };
    }
    case 'industry': return { inputId: 'zatca-industry', advanced: true };
    default: return null;
  }
}

// ─── التسميات ───

export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export const UNIT_STATUS_LABEL: Record<ZatcaUnitStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'مسودة', tone: 'neutral' },
  CSR_READY: { label: 'بانتظار رمز التحقق', tone: 'warning' },
  CCSID_ISSUED: { label: 'صدرت شهادة الامتثال', tone: 'progress' },
  CHECKS_RUNNING: { label: 'فحوص الامتثال جارية', tone: 'progress' },
  CHECKS_PASSED: { label: 'اجتازت فحوص الامتثال', tone: 'progress' },
  ERROR_NEEDS_OTP: { label: 'تحتاج رمز تحقق جديداً', tone: 'danger' },
  ACTIVE: { label: 'مربوطة وشهادة الإنتاج صالحة', tone: 'success' },
  RENEWING: { label: 'تجديد الشهادة جارٍ', tone: 'progress' },
  AUTH_FAILED: { label: 'رفضت الهيئة شهادة الوحدة', tone: 'danger' },
  EXPIRED: { label: 'شهادة الوحدة منتهية', tone: 'danger' },
  REVOKED: { label: 'موقوفة نهائياً', tone: 'neutral' },
};

export function statusLabel(status: string): { label: string; tone: Tone } {
  return UNIT_STATUS_LABEL[status as ZatcaUnitStatus] ?? { label: 'حالة غير معروفة', tone: 'neutral' };
}

/**
 * تسمية حالة الوحدة كما تُعرض: CHECKS_RUNNING أو RENEWING بلا عمل حيّ (عامل مات بعد انقضاء عقد الإيجار) لا تُقرأ «جارية»
 * والبطاقة نفسها تعرض «متابعة الربط» أو «إلغاء التجديد المتوقف».
 */
export function cardStatusLabel(p: ZatcaUnitPayload): { label: string; tone: Tone } {
  const s = p.unit.status;
  if (!shouldPoll(p)) {
    if (s === 'CHECKS_RUNNING') return { label: 'توقفت فحوص الامتثال قبل اكتمالها', tone: 'warning' };
    if (s === 'RENEWING') {
      return p.unit.complianceProgress?.renewal?.stage === 'unconfirmed'
        ? { label: 'نتيجة تجديد الشهادة غير مؤكدة', tone: 'danger' }
        : { label: 'توقف تجديد الشهادة قبل اكتماله', tone: 'warning' };
    }
  }
  return statusLabel(s);
}

/** تسميات cardStatusLabel خارج UNIT_STATUS_LABEL (للحارس: لكل منها ترجمة). */
export const CARD_STATUS_EXTRA_LABELS = ['توقفت فحوص الامتثال قبل اكتمالها', 'توقف تجديد الشهادة قبل اكتماله', 'نتيجة تجديد الشهادة غير مؤكدة'] as const;

/** وصف البيئة في قائمة الاختيار — المحاكاة واضحة أنها لا تُنتج فواتير حقيقية. */
export const ENV_LABEL: Record<ZatcaEnv, string> = {
  simulation: 'بيئة المحاكاة — للاختبار، لا تُنتج فواتير حقيقية',
  production: 'بيئة الإنتاج — فواتير ضريبية حقيقية',
  sandbox: 'بيئة المطوّرين — بيانات تجريبية فقط',
};

export const ENV_SHORT_LABEL: Record<ZatcaEnv, string> = {
  simulation: 'المحاكاة',
  production: 'الإنتاج',
  sandbox: 'المطوّرين',
};

export const CHECKLIST_LABEL: Record<string, string> = {
  key: 'توليد مفتاح التوقيع',
  csr: 'إنشاء طلب الشهادة CSR',
  ccsid: 'استلام شهادة الامتثال',
  'standard-compliant': 'فحص الامتثال: فاتورة ضريبية',
  'standard-credit-note-compliant': 'فحص الامتثال: إشعار دائن ضريبي',
  'standard-debit-note-compliant': 'فحص الامتثال: إشعار مدين ضريبي',
  'simplified-compliant': 'فحص الامتثال: فاتورة مبسّطة',
  'simplified-credit-note-compliant': 'فحص الامتثال: إشعار دائن مبسّط',
  'simplified-debit-note-compliant': 'فحص الامتثال: إشعار مدين مبسّط',
  pcsid: 'استلام شهادة الإنتاج',
};

export const RENEWAL_STAGE_LABEL: Record<string, string> = {
  waiting: 'انتظار الفواتير الجارية قبل التجديد',
  'patch-sent': 'أُرسل طلب التجديد إلى الهيئة',
  checks: 'فحوص الامتثال للمفتاح الجديد',
  'production-sent': 'طُلبت شهادة الإنتاج الجديدة',
  unconfirmed: 'نتيجة التجديد غير مؤكَّدة — الإصدار موقوف احتياطاً',
  done: 'اكتمل التجديد',
  aborted: 'أُلغي التجديد',
};

export const RETIRE_REASONS = ['abandoned', 'revoked-in-portal'] as const;
export type RetireReason = (typeof RETIRE_REASONS)[number];

export const RETIRE_REASON_LABEL: Record<RetireReason, string> = {
  abandoned: 'التخلّي عن وحدة لم تكتمل أو زائدة',
  'revoked-in-portal': 'أُبطلت الوحدة في بوابة فاتورة',
};

/**
 * السبب المختار مسبقاً في نموذج الإيقاف: «أُبطلت في البوابة» لوحدة إنتاج كانت تحمل شهادة، و«تخلٍّ» لغيرها — فإيقاف وحدة
 * المحاكاة بعد تجربتها للانتقال إلى الإنتاج لا يُسجَّل إبطالاً.
 */
export function defaultRetireReason(unit: Pick<ZatcaUnitView, 'status' | 'environment'>): RetireReason {
  return unit.environment === 'production' && (unit.status === 'ACTIVE' || unit.status === 'EXPIRED' || unit.status === 'AUTH_FAILED') ? 'revoked-in-portal' : 'abandoned';
}

// ─── حالة الوحدة والإجراءات ───

const OTP_STATES: ReadonlySet<string> = new Set(['CSR_READY', 'ERROR_NEEDS_OTP']);
const RESUME_STATES: ReadonlySet<string> = new Set(['CCSID_ISSUED', 'CHECKS_RUNNING', 'CHECKS_PASSED']);
const RENEW_STATES: ReadonlySet<string> = new Set(['ACTIVE', 'EXPIRED', 'RENEWING']);

/** الاستطلاع ما دامت مهمّة جارية أو عملية حديثة على الوحدة. */
export function shouldPoll(p: ZatcaUnitPayload | null | undefined): boolean {
  return !!p && (p.activity?.busy === true || p.job?.state === 'running');
}

/** بعد دقيقة من بدء المهمّة (انتظار فواتير التجديد حتى 10 دقائق) أو لعامل آخر: كل 5 ثوانٍ لا كل ثانيتين — الحدّ العامّ 600 طلب/15 دقيقة لكل IP. */
export const POLL_SLOW_MS = 5000;
export const POLL_SLOW_AFTER_MS = 60_000;

/**
 * مهلة الاستطلاع التالي لاستعلام الوحدة (refetchInterval) — false = توقّف.
 * خطأ (بعد إعادات shouldRetryUnitFetch) ⇒ توقّف: البيانات المخزّنة تبقى «مشغولة» فلا يُستطلع إلى الأبد عبر 403/404/429/5xx.
 */
export function unitPollInterval(state: { status: string; data: ZatcaUnitPayload | null | undefined }, baseMs: number, nowMs: number): number | false {
  if (state.status === 'error') return false;
  const p = state.data;
  if (!p || !shouldPoll(p)) return false;
  const base = baseMs > 0 ? baseMs : 2000;
  const started = p.job?.state === 'running' ? Date.parse(p.job.startedAt) : NaN;
  const fresh = p.activity?.reason === 'job' && Number.isFinite(started) && nowMs - started <= POLL_SLOW_AFTER_MS;
  return fresh ? base : Math.max(base, POLL_SLOW_MS);
}

/** إعادة جلب الوحدة بعد فشل: الشبكة و5xx مرتين (بتأخير react-query المتصاعد)، وأي 4xx (401/403/404/429…) بلا إعادة. */
export function shouldRetryUnitFetch(failureCount: number, err: unknown): boolean {
  const status = apiErrorOf(err).status;
  if (status !== null && status < 500) return false;
  return failureCount < 2;
}

/**
 * ما يعرضه التبويب لاستعلام النظرة العامّة. react-query يُبقي isError صحيحاً حين تفشل إعادة جلبٍ والبيانات مخزّنة (isRefetchError):
 * بطاقة الخطأ الكاملة عندها تُزيل جسم التبويب بمسوّداته (بيانات المنشأة غير المحفوظة، OTP، نماذج التجديد والإيقاف) — فهي للتحميل
 * الأول الفاشل وحده، وفشل التحديث لافتة فوق المحتوى القائم (refreshFailed). وبلا بيانات ولا خطأ فالجلب الأول لم ينتهِ — ومنه
 * الموقوف بلا اتصال (status 'pending' وfetchStatus 'paused': isLoading خطأ) ⇒ تحميل، لا بطاقة «تعذر التحميل» لفشل لم يقع.
 */
export function overviewView(q: { isError: boolean; data: unknown }): { view: 'loading' | 'error' | 'ready'; refreshFailed: boolean } {
  if (q.data) return { view: 'ready', refreshFailed: q.isError };
  return { view: q.isError ? 'error' : 'loading', refreshFailed: false };
}

export interface UnitActions {
  busy: boolean;
  /** إدخال OTP لبدء الربط (أو إعادة البدء برمز جديد). */
  needsOtp: boolean;
  /** متابعة الربط بلا رمز (بعد خطأ مؤقت أو توقّف عامل). */
  canResume: boolean;
  canRenew: boolean;
  /** إلغاء تجديد متوقّف لم يُرسل فيه طلب قد يُصدر شهادة. */
  canAbort: boolean;
  canRetire: boolean;
}

export function unitActions(p: ZatcaUnitPayload): UnitActions {
  const busy = shouldPoll(p);
  const s = p.unit.status;
  const stage = p.unit.complianceProgress?.renewal?.stage;
  return {
    busy,
    needsOtp: !busy && OTP_STATES.has(s),
    canResume: !busy && RESUME_STATES.has(s),
    canRenew: !busy && RENEW_STATES.has(s),
    canAbort: !busy && s === 'RENEWING' && stage !== 'unconfirmed',
    canRetire: !busy && s !== 'REVOKED',
  };
}

/** نتيجة فشل آخر مهمّة (للوحة الخطأ) — null إن نجحت أو ما زالت جارية أو لا مهمّة. */
export function failureOf(p: ZatcaUnitPayload | null | undefined): ZatcaJobOutcome | null {
  const o = p?.job?.state === 'finished' ? p.job.outcome : null;
  return o && !o.ok ? o : null;
}

export interface CardControls extends UnitActions {
  /** بيئة الوحدة ضمن ZATCA_ALLOWED_ENVS على الخادم الآن (وإلا يرفض الربط والتجديد 403 ENV_NOT_ALLOWED). */
  envAllowed: boolean;
  showOtpForm: boolean;
  /** «متابعة الربط» — في كل حالة قابلة للاستئناف ما لم يُعرض «إعادة المحاولة» مكانه، أيّاً كانت نتيجة آخر مهمّة. */
  showResume: boolean;
  /** «إعادة المحاولة» في لوحة الخطأ لنتيجة retryable. */
  showRetry: boolean;
  showRenew: boolean;
  /** زرّ لوحة الخطأ لنتيجة needsNewOtp: خانة الرمز، أو نافذة التجديد، أو الإيقاف حين لا مسار رمز في الحالة (AUTH_FAILED). */
  newOtpAction: 'focus-otp' | 'open-renew' | 'open-retire' | null;
  /** «العنوان المختصر في الشهادة» في نموذج الرمز: بعد رفض (ERROR_NEEDS_OTP) يُعاد اشتقاق العنوان — والتجديد يعرضه دائماً. */
  showOtpLocation: boolean;
  /** زرّ «صحح الحقل المشار إليه» لنتيجة CSR_PARAMS_INVALID — null إن لم تكن للحقل خانة ظاهرة. */
  csrFix: CsrFix | null;
}

/**
 * ما تعرضه بطاقة الوحدة. نتيجة مهمّة منتهية لا تُخفي مسار الاستئناف: فشل غير قابل لإعادة المحاولة وليس برمز جديد
 * (ZATCA_CONFIG، SELLER_DATA_INCOMPLETE، SECRETS_UNAVAILABLE…) يترك الوحدة قابلة للاستئناف، فيعالج المدير السبب ثم يتابع.
 */
export function cardControls(p: ZatcaUnitPayload, allowedEnvs: readonly string[], readOnly = false): CardControls {
  const a = unitActions(p);
  const failure = failureOf(p);
  const envAllowed = allowedEnvs.includes(p.unit.environment);
  // جلسة انتحال المالك: الخادم يرفض كل كتابة (403 IMPERSONATION_READ_ONLY) ⇒ لا زرّ كتابة يفشل عند النقر
  if (readOnly) {
    return {
      ...a, canAbort: false, canRetire: false, envAllowed, showOtpForm: false, showResume: false, showRetry: false, showRenew: false,
      newOtpAction: null, showOtpLocation: false, csrFix: null,
    };
  }
  const showRetry = envAllowed && a.canResume && failure?.retryable === true;
  let newOtpAction: CardControls['newOtpAction'] = null;
  if (failure?.needsNewOtp) {
    if (a.needsOtp) newOtpAction = envAllowed ? 'focus-otp' : null;
    else if (a.canRenew) newOtpAction = envAllowed ? 'open-renew' : null;
    else if (!a.canResume && a.canRetire) newOtpAction = 'open-retire';
  }
  const showOtpForm = envAllowed && a.needsOtp;
  const showRenew = envAllowed && a.canRenew;
  const showOtpLocation = showOtpForm && p.unit.status === 'ERROR_NEEDS_OTP';
  const fix = csrFailureFix(failure, { vatGroup: isVatGroup(p.unit.vatNumber) });
  return {
    ...a,
    envAllowed,
    showOtpForm,
    showResume: envAllowed && a.canResume && !showRetry,
    showRetry,
    showRenew,
    newOtpAction,
    showOtpLocation,
    csrFix: fix?.kind === 'unit-location' && !showOtpLocation && !showRenew ? null : fix,
  };
}

export type CertState = 'none' | 'valid' | 'expiring' | 'expired';

export function certValidity(unit: Pick<ZatcaUnitView, 'certNotAfter'>, now: Date, warnDays = 30): { state: CertState; daysLeft: number | null } {
  if (!unit.certNotAfter) return { state: 'none', daysLeft: null };
  const end = new Date(unit.certNotAfter).getTime();
  if (!Number.isFinite(end)) return { state: 'none', daysLeft: null };
  const daysLeft = Math.floor((end - now.getTime()) / 86_400_000);
  if (end <= now.getTime()) return { state: 'expired', daysLeft: 0 };
  return { state: daysLeft <= warnDays ? 'expiring' : 'valid', daysLeft };
}

/** نصّ تاريخ الشهادة: «انتهت في» للمنتهية لا «صالحة حتى» — null بلا شهادة. */
export function certDateLabel(state: CertState): string | null {
  return state === 'none' ? null : state === 'expired' ? 'انتهت في' : 'صالحة حتى';
}

export type ProblemKind = 'AUTH_FAILED' | 'REVOKED_ACTIVE' | 'RENEWAL_UNCONFIRMED' | 'EXPIRED' | 'EXPIRING' | null;

/**
 * لافتة المشكلة (design §5.1 خطوة 9) لوحدة: رفض الشهادة، إيقاف وحدة كانت مفعّلة، تجديد غير مؤكَّد، انتهاء أو قرب انتهاء.
 * الوحدة الموقوفة لا تُنذر إلا وحدة إنتاج كانت مفعّلة وأُبطلت: لا لافتة لوحدة لم تُفعَّل قطّ، ولا لما أُوقف تخلّياً
 * (RETIRED:abandoned)، ولا لوحدة محاكاة أو مطوّرين (لا فواتير ضريبية فيهما — المسار المعتاد: تجربة المحاكاة ثم إيقافها
 * وربط الإنتاج).
 */
export function problemOf(unit: ZatcaUnitView, now: Date): ProblemKind {
  if (unit.status === 'AUTH_FAILED') return 'AUTH_FAILED';
  if (unit.status === 'REVOKED') {
    return unit.activatedAt && unit.environment === 'production' && unit.lastError !== 'RETIRED:abandoned' ? 'REVOKED_ACTIVE' : null;
  }
  if (unit.status === 'RENEWING' && unit.complianceProgress?.renewal?.stage === 'unconfirmed') return 'RENEWAL_UNCONFIRMED';
  const c = certValidity(unit, now);
  if (unit.status === 'EXPIRED' || (unit.status === 'ACTIVE' && c.state === 'expired')) return 'EXPIRED';
  if (unit.status === 'ACTIVE' && c.state === 'expiring') return 'EXPIRING';
  return null;
}

/**
 * لافتات المشكلات لكل الوحدات: وحدة موقوفة كانت مفعّلة لا تُنذر إن رُبطت بعدها وحدة أحدث في البيئة نفسها.
 */
export function problemBanners(units: readonly ZatcaUnitPayload[], now: Date): Array<{ p: ZatcaUnitPayload; kind: Exclude<ProblemKind, null> }> {
  const out: Array<{ p: ZatcaUnitPayload; kind: Exclude<ProblemKind, null> }> = [];
  for (const p of units) {
    const kind = problemOf(p.unit, now);
    if (!kind) continue;
    if (kind === 'REVOKED_ACTIVE') {
      const replaced = units.some(o => o.unit.id !== p.unit.id && o.unit.environment === p.unit.environment && o.unit.status !== 'REVOKED'
        && new Date(o.unit.createdAt).getTime() >= new Date(p.unit.createdAt).getTime());
      if (replaced) continue;
    }
    out.push({ p, kind });
  }
  return out;
}

const STATUS_WEIGHT: Record<string, number> = {
  ACTIVE: 9, RENEWING: 9, EXPIRED: 8, AUTH_FAILED: 8, CHECKS_RUNNING: 7, CHECKS_PASSED: 7, CCSID_ISSUED: 7, ERROR_NEEDS_OTP: 6, CSR_READY: 6, DRAFT: 1, REVOKED: 0,
};

/**
 * الوحدات كما يعرفها المتصفّح الآن: نسخة الاستطلاع المخزّنة (unitKey) ما لم تكن أقدم من النظرة العامّة.
 * رأس الحالة يقرأ منها فلا يبقى على «بانتظار رمز التحقق» والبطاقة تحته تمرّ بفحوص الامتثال.
 */
export function liveUnits(overview: readonly ZatcaUnitPayload[], cached: ReadonlyArray<ZatcaUnitPayload | null | undefined>): ZatcaUnitPayload[] {
  return overview.map((o, i) => {
    const c = cached[i];
    if (!c || c.unit.id !== o.unit.id) return o;
    const cu = Date.parse(c.unit.updatedAt);
    const ou = Date.parse(o.unit.updatedAt);
    return Number.isFinite(ou) && (!Number.isFinite(cu) || cu < ou) ? o : c;
  });
}

/** الوحدة التي يلخّصها رأس الحالة: الإنتاج قبل المحاكاة، والمربوطة قبل الجارية، ثم الأحدث. */
export function primaryUnit(units: readonly ZatcaUnitPayload[]): ZatcaUnitPayload | null {
  const envWeight = (e: string) => (e === 'production' ? 2 : e === 'simulation' ? 1 : 0);
  const sorted = [...units].sort((a, b) =>
    (STATUS_WEIGHT[b.unit.status] ?? 0) - (STATUS_WEIGHT[a.unit.status] ?? 0)
    || envWeight(b.unit.environment) - envWeight(a.unit.environment)
    || new Date(b.unit.createdAt).getTime() - new Date(a.unit.createdAt).getTime());
  return sorted[0] ?? null;
}

const BLOCKING: ReadonlySet<string> = new Set(['CSR_READY', 'CCSID_ISSUED', 'CHECKS_RUNNING', 'CHECKS_PASSED', 'ERROR_NEEDS_OTP', 'ACTIVE', 'RENEWING']);

/** البيئات المسموحة التي لا توجد فيها وحدة قيد الربط أو مفعّلة (يمكن إنشاء وحدة فيها). */
export function creatableEnvs(allowed: readonly ZatcaEnv[], units: readonly ZatcaUnitPayload[]): ZatcaEnv[] {
  return allowed.filter(env => !units.some(u => u.unit.environment === env && BLOCKING.has(u.unit.status)));
}

// ─── أخطاء الواجهة البرمجية ───

export interface ApiErrorInfo {
  status: number | null;
  code: string | null;
  message: string | null;
  needsNewOtp: boolean;
  retryable: boolean;
  /** حقل الرفض (مثل orgName لـCSR_PARAMS_INVALID). */
  field: string | null;
  fieldErrors: Array<{ field: string; messageAr: string }>;
  issues: Array<{ field: string; messageAr: string; severity: string }>;
}

/** يستخرج من خطأ axios ما يرسله الخادم فقط (لا config ولا جسم الطلب — قد يحمل OTP). */
export function apiErrorOf(err: unknown): ApiErrorInfo {
  const r = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const d = r && r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {};
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    status: typeof r?.status === 'number' ? r.status : null,
    code: typeof d.code === 'string' ? d.code : null,
    message: typeof d.message === 'string' ? d.message : null,
    needsNewOtp: d.needsNewOtp === true,
    retryable: d.retryable === true,
    field: typeof d.field === 'string' ? d.field : null,
    fieldErrors: arr(d.fieldErrors).filter((e): e is { field: string; messageAr: string } => !!e && typeof e.field === 'string' && typeof e.messageAr === 'string'),
    issues: arr(d.issues).filter((e): e is { field: string; messageAr: string; severity: string } => !!e && typeof e.messageAr === 'string'),
  };
}
