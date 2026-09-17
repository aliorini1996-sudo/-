/**
 * من يرى تبويب ربط فوترة المرحلة الثانية في إعدادات الشركة — صغير وبلا استيراد كي لا يُحمَّل منطق التبويب في صفحة الإعدادات.
 *
 * مطابق لحارس /api/zatca في الخادم: علم المالك للشركة (=== true وحدها) + شركة سعودية + مدير الشركة (دور ADMIN) وحده غير مقيّد
 * النطاق — قرار المالك: المشرف (MANAGER) والمحاسب (ACCOUNTANT) لا يرون التبويب ولو ملكا صلاحية الإعدادات (الخادم يردّهما 403)،
 * والمدير المقيّد النطاق يردّه الخادم 403 SCOPED_ADMIN. جلسة دخول مالك المنصة تحمل دور حساب الشركة الذي دخل به ونطاقه، فتعمل
 * كذلك الحساب تماماً (قرار المالك 17 سبتمبر 2026: يحفظ ويربط ويجدّد ويوقف كالمدير، والخادم يسجّل كل كتابة بها) — لا وضع اطلاع.
 */
export const ZATCA_TAB_ROLE = 'ADMIN';

export function zatcaTabVisible(
  company: { zatcaPhase2Enabled?: boolean | null; countryCode?: string | null } | null | undefined,
  role: string | null | undefined,
  scopeEnabled?: boolean | null,
): boolean {
  return company?.zatcaPhase2Enabled === true && company.countryCode === 'SA' && role === ZATCA_TAB_ROLE && scopeEnabled !== true;
}

/** شركة بعلم المالك والمستخدم ليس مدير الشركة أو مقيّد النطاق — من يردّه حارس حقول البائع في الخادم. */
function zatcaSellerRestricted(
  company: { zatcaPhase2Enabled?: boolean | null } | null | undefined,
  role: string | null | undefined,
  scopeEnabled?: boolean | null,
): boolean {
  return company?.zatcaPhase2Enabled === true && (role !== ZATCA_TAB_ROLE || scopeEnabled === true);
}

/**
 * الرقم الضريبي والسجل التجاري والدولة في «الإعدادات العامة» للاطلاع فقط؟ — لحارس PUT /api/company في الخادم
 * (companyZatcaFieldChanges): يحرس الحقول حين تكون المنشأة سعودية قبل الحفظ أو بعده. فتُقفل لمستخدم مردود (zatcaSellerRestricted)
 * حين الدولة المحفوظة السعودية أو لا دولة محفوظة (الصفحة تعرض السعودية افتراضاً وترسلها فيُرفض الحفظ 403). ودولة محفوظة غير
 * السعودية: الخادم لا يحرس شيئاً فتبقى الحقول قابلة للتعديل، والتحويل إلى السعودية وحده يُرفض — فلا يُعرض خيارها
 * (zatcaCountryChoiceAllowed) وإلا أبقت إعادة الجلب اختيار المستخدم فتكرّر الرفض مع كل حفظ.
 * الخادم يقرّر بالدور والنطاق من القاعدة؛ هذا كي لا يكتب المستخدم قيمة يرفضها الحفظ.
 */
export function zatcaSellerFieldsLocked(
  company: { zatcaPhase2Enabled?: boolean | null; countryCode?: string | null } | null | undefined,
  role: string | null | undefined,
  scopeEnabled?: boolean | null,
): boolean {
  return zatcaSellerRestricted(company, role, scopeEnabled) && (!company?.countryCode || company.countryCode === 'SA');
}

/** خيار دولة في قائمة «الدولة»: السعودية لا تُعرض لمستخدم مردود على شركة بعلم المالك دولتها المحفوظة غير السعودية (غير المقفلة). */
export function zatcaCountryChoiceAllowed(
  code: string,
  company: { zatcaPhase2Enabled?: boolean | null; countryCode?: string | null } | null | undefined,
  role: string | null | undefined,
  scopeEnabled?: boolean | null,
): boolean {
  return code !== 'SA' || !zatcaSellerRestricted(company, role, scopeEnabled) || zatcaSellerFieldsLocked(company, role, scopeEnabled);
}

/**
 * سبب القفل (عبارة القاموس العامّ، تُمرَّر إلى tr) تحت الحقول المقفلة — بترتيب حارس الخادم: غير المدير، ثم النطاق.
 */
export function zatcaSellerLockHint(role: string | null | undefined, scopeEnabled?: boolean | null): string {
  if (role === ZATCA_TAB_ROLE && scopeEnabled === true) return COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_SCOPED;
  return COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_ADMIN_ONLY;
}

/**
 * مظهر الحقل المقفل في «الإعدادات العامة» (الرقم الضريبي والسجل والدولة لمستخدم مردود): خلفية باهتة ومؤشّر «ممنوع» وبلا حلقة
 * التركيز البرتقالية التي توحي بالكتابة — أدوات Tailwind فوق .input (طبقة المكوّنات) لا تغيير في أنماط الحقول العامة.
 */
export const LOCKED_INPUT_CLASS = 'bg-[#F1EBDF] text-[#6E6557] cursor-not-allowed focus:ring-0 focus:border-[#D8CDB9]';

/** معرّف سطر سبب القفل تحت الحقول — تشير إليه الحقول المقفلة (aria-describedby) فيُقرأ السبب مع الحقل. */
export const SELLER_LOCK_HINT_ID = 'company-seller-lock-hint';

/** حقول PUT /api/company التي يحرسها الخادم لشركة سعودية بعلم المالك (COMPANY_ZATCA_FIELDS). */
export const COMPANY_SELLER_FIELDS = ['taxNumber', 'commercialReg', 'countryCode'] as const;

/**
 * جسم حفظ «الإعدادات العامة»: الحقول المقفلة لا تُرسل (غيابها عند الخادم = بلا تغيير، والعملة من الدولة المحفوظة) — وإلا فقيمتها
 * في الصفحة قد تكون قديمة (غيّرها المدير بعد تحميلها) فيرفض الخادم حفظ الشعار أو الهاتف 403 على حقل لا يستطيع المستخدم تعديله.
 */
export function withoutLockedSellerFields<T extends Record<string, unknown>>(body: T, locked: boolean): T {
  if (!locked) return body;
  const out: Record<string, unknown> = { ...body };
  for (const f of COMPANY_SELLER_FIELDS) delete out[f];
  return out as T;
}

/** رموز رفض PUT /api/company من حارس حقول البائع ⇒ عبارة القاموس العامّ (تُترجم بـtr) بدل «حدث خطأ في الحفظ». */
export const COMPANY_SELLER_ERROR_PHRASES: Readonly<Record<string, string>> = {
  SELLER_FIELDS_ADMIN_ONLY: 'الرقم الضريبي والسجل التجاري والدولة مرتبطة بربط الفوترة الإلكترونية — يعدلها مدير الشركة',
  SELLER_FIELDS_SCOPED: 'حسابك مقيد بنطاق محدد — الرقم الضريبي والسجل التجاري والدولة يعدلها مدير الشركة بصلاحية غير مقيدة',
  SELLER_INVALID: 'الرقم الضريبي أو السجل التجاري غير صحيح',
};

/** أخطاء الصيغة لكل حقل (fieldErrors من SELLER_INVALID) — عبارات القاموس العامّ لا نصّ الخادم العربي. */
export const COMPANY_SELLER_FIELD_ERROR_PHRASES: Readonly<Record<string, string>> = {
  taxNumber: 'الرقم الضريبي غير صحيح — يجب أن يكون 15 رقما يبدأ وينتهي بالرقم 3',
  commercialReg: 'السجل التجاري غير صحيح — تحقق من الرقم',
};

export const COMPANY_SELLER_ERROR_CODES: readonly string[] = Object.keys(COMPANY_SELLER_ERROR_PHRASES);

function companySaveErrorCode(err: unknown): { code: string; fieldErrors: unknown } | null {
  const d = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!d || typeof d !== 'object') return null;
  const r = d as { code?: unknown; fieldErrors?: unknown };
  if (typeof r.code !== 'string' || !Object.prototype.hasOwnProperty.call(COMPANY_SELLER_ERROR_PHRASES, r.code)) return null;
  return { code: r.code, fieldErrors: r.fieldErrors };
}

/** مفتاح عبارة الرفض في القاموس العامّ (يُمرَّر إلى tr) — null لغير رموز الحارس (الرسالة العامة كما كانت). */
export function companySaveErrorMessage(err: unknown): string | null {
  const e = companySaveErrorCode(err);
  if (!e) return null;
  if (e.code === 'SELLER_INVALID' && Array.isArray(e.fieldErrors)) {
    const field = (e.fieldErrors[0] as { field?: unknown } | undefined)?.field;
    if (typeof field === 'string' && Object.prototype.hasOwnProperty.call(COMPANY_SELLER_FIELD_ERROR_PHRASES, field)) return COMPANY_SELLER_FIELD_ERROR_PHRASES[field];
  }
  return COMPANY_SELLER_ERROR_PHRASES[e.code];
}

/**
 * رفض الصلاحية (لا الصيغة): إعادة جلب ['company'] تُحدِّث علم المالك والدولة وقيم الحقول المقفلة مع إبقاء تعديلات الحقول الأخرى
 * (keepLocalEdits) — فتنجح إعادة الحفظ بدل تكرار 403 حتى إعادة تحميل الصفحة.
 */
export function companySaveNeedsRefetch(err: unknown): boolean {
  const e = companySaveErrorCode(err);
  return !!e && e.code !== 'SELLER_INVALID';
}
