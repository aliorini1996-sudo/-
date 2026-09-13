/**
 * منطق لوحة «سفير فيلد سيلز» للمالك — نقيّ بلا DOM ولا React ولا شبكة.
 *
 * الأشكال والتعدادات منقولة حرفياً من `docs/affiliate/API.md` §2؛ الخادم يُكتب
 * بالتوازي على المواصفة نفسها، فأي اسم هنا يخالفها خللٌ صامت (حالة بلا تسمية
 * تظهر للمالك رمزاً إنجليزياً). الحارس في `affiliatesPanelLogic.test.ts`.
 *
 * المال: **هللات صحيحة** من طرف إلى طرف. تحويل نصّ الريال إلى هللات يتمّ
 * بالأجزاء النصّية لا بالضرب العشري — `0.29 * 100` في الفاصلة العائمة
 * يساوي `28.999999999999996` فيُقطع هللةً من مال السفير.
 */

import { contactPhoneDisplay, contactPhoneTel } from '../lib/contactPhone';

// ─── التعدادات (API.md — الأنواع المشتركة) ─────────────────────────────────

export const USER_STATUSES = ['pending_email', 'pending_review', 'approved', 'rejected', 'suspended'] as const;
export const CLAIM_STATUSES = ['under_review', 'approved', 'rejected', 'withdrawn', 'expired', 'converted'] as const;
export const ATTRIBUTION_STATUSES = ['active', 'disputed', 'void'] as const;
export const COMMISSION_STATUSES = ['pending', 'on_hold', 'approved', 'paid', 'reversed', 'declined'] as const;
export const PAYOUT_STATUSES = ['draft', 'recorded', 'void'] as const;
export const CLAIM_HOWS = ['visit', 'relationship', 'event', 'online', 'other'] as const;
export const CLAIM_REASONS = ['existing_customer', 'duplicate', 'self_referral', 'insufficient', 'other'] as const;
export const FLAGS = ['self_email', 'self_phone', 'returning_company', 'ip_match', 'terms_outdated', 'link_expired'] as const;
export const ATTRIBUTION_SOURCES = ['signup_code', 'claim', 'owner'] as const;
export const REF_VIAS = ['link', 'typed'] as const;
export const ADJUSTMENT_KINDS = ['clawback_refund', 'correction'] as const;
export const ACTOR_TYPES = ['system', 'affiliate', 'owner', 'company'] as const;

export type UserStatus = typeof USER_STATUSES[number];
export type ClaimStatus = typeof CLAIM_STATUSES[number];
export type AttributionStatus = typeof ATTRIBUTION_STATUSES[number];
export type CommissionStatus = typeof COMMISSION_STATUSES[number];
export type PayoutStatus = typeof PAYOUT_STATUSES[number];
export type ClaimHow = typeof CLAIM_HOWS[number];
export type ClaimReason = typeof CLAIM_REASONS[number];
export type Flag = typeof FLAGS[number];
export type AttributionSource = typeof ATTRIBUTION_SOURCES[number];

/** تسمية عربية + نغمة لون (تُترجَم لأصناف Tailwind في المكوّن) */
export type Tone = 'gray' | 'amber' | 'green' | 'red' | 'blue' | 'orange';
export interface Label { label: string; tone: Tone }

export const USER_STATUS_LABEL: Record<UserStatus, Label> = {
  pending_email: { label: 'بانتظار تأكيد البريد', tone: 'gray' },
  pending_review: { label: 'بانتظار المراجعة', tone: 'amber' },
  approved: { label: 'معتمد', tone: 'green' },
  rejected: { label: 'مرفوض', tone: 'red' },
  suspended: { label: 'موقوف', tone: 'orange' },
};

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, Label> = {
  under_review: { label: 'قيد المراجعة', tone: 'amber' },
  approved: { label: 'معتمد', tone: 'green' },
  rejected: { label: 'مرفوض', tone: 'red' },
  withdrawn: { label: 'مسحوب', tone: 'gray' },
  expired: { label: 'منتهي', tone: 'gray' },
  converted: { label: 'رُبط بشركة', tone: 'blue' },
};

export const ATTRIBUTION_STATUS_LABEL: Record<AttributionStatus, Label> = {
  active: { label: 'فعّال', tone: 'green' },
  disputed: { label: 'متنازع عليه', tone: 'amber' },
  void: { label: 'ملغى', tone: 'gray' },
};

export const COMMISSION_STATUS_LABEL: Record<CommissionStatus, Label> = {
  pending: { label: 'في فترة الحجز', tone: 'amber' },
  on_hold: { label: 'موقوفة', tone: 'orange' },
  approved: { label: 'معتمدة', tone: 'blue' },
  paid: { label: 'مدفوعة', tone: 'green' },
  reversed: { label: 'معكوسة', tone: 'gray' },
  declined: { label: 'مرفوضة', tone: 'red' },
};

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, Label> = {
  draft: { label: 'مسودّة — لم تُحوَّل', tone: 'amber' },
  recorded: { label: 'مسجَّلة — حُوِّلت', tone: 'green' },
  void: { label: 'ملغاة', tone: 'gray' },
};

export const CLAIM_HOW_LABEL: Record<ClaimHow, string> = {
  visit: 'زيارة ميدانية',
  relationship: 'علاقة سابقة',
  event: 'فعالية أو معرض',
  online: 'عبر الإنترنت',
  other: 'أخرى',
};

export const CLAIM_REASON_LABEL: Record<ClaimReason, string> = {
  existing_customer: 'عميل قائم',
  duplicate: 'مكرر',
  self_referral: 'إحالة ذاتية',
  insufficient: 'بيانات غير كافية',
  other: 'أخرى',
};

export const FLAG_LABEL: Record<Flag, string> = {
  self_email: 'بريد المسوّق نفسه',
  self_phone: 'جوال المسوّق نفسه',
  returning_company: 'شركة عائدة',
  ip_match: 'نفس الشبكة',
  terms_outdated: 'لم يقبل الشروط الحالية',
  link_expired: 'رابط الإحالة تجاوز مدّته',
};

export const SOURCE_LABEL: Record<AttributionSource, string> = {
  signup_code: 'رمز عند التسجيل',
  claim: 'ترشيح',
  owner: 'إسناد يدوي',
};

export const REF_VIA_LABEL: Record<typeof REF_VIAS[number], string> = {
  link: 'عبر الرابط',
  typed: 'كتب الرمز',
};

export const ADJUSTMENT_KIND_LABEL: Record<typeof ADJUSTMENT_KINDS[number], string> = {
  clawback_refund: 'استرداد بعد الصرف',
  correction: 'تصحيح يدوي',
};

export const ACTOR_LABEL: Record<typeof ACTOR_TYPES[number], string> = {
  system: 'النظام',
  affiliate: 'السفير',
  owner: 'المالك',
  company: 'الشركة',
};

/** حالات رابط الدفع (ميسر) كما تعرضها لوحة روابط الدفع */
export const LINK_STATUS_LABEL: Record<string, string> = {
  paid: 'مدفوع',
  initiated: 'بانتظار الدفع',
  canceled: 'ملغي',
  expired: 'منتهي',
  refunded: 'مسترد',
  amount_mismatch: 'مبلغ مختلف',
};

/**
 * حالة قيد التصحيح في تفصيل السفير: `settled` = مربوط بدفعة **مسجَّلة**،
 * `inDraft` = مربوط بمسودّة دفعة لم تُحوَّل، وإلا يدخل الدفعة القادمة.
 * (لا يُستنتج من `payoutId` — الربط بمسودّة ليس تسوية.)
 */
export function adjustmentState(j: { settled?: boolean | null; inDraft?: boolean | null }): Label {
  if (j.settled === true) return { label: 'سُوّي', tone: 'green' };
  if (j.inDraft === true) return { label: 'في مسودّة دفعة', tone: 'blue' };
  return { label: 'تُحتسب في الدفعة القادمة', tone: 'amber' };
}

/** تسمية آمنة لقيمة قد تصل من الخادم خارج القاموس — تُعرض كما هي لا فراغاً */
export function labelOf<K extends string>(map: Record<K, string | Label>, value: string | null | undefined): string {
  if (!value) return '—';
  const hit = (map as Record<string, string | Label>)[value];
  if (!hit) return value;
  return typeof hit === 'string' ? hit : hit.label;
}

export function toneOf<K extends string>(map: Record<K, Label>, value: string | null | undefined): Tone {
  const hit = value ? (map as Record<string, Label>)[value] : undefined;
  return hit ? hit.tone : 'gray';
}

// ─── الإجراءات المسموحة لكل حالة (العرض فقط — الخادم هو الحَكَم بـ409) ──────

export type UserAction = 'approve' | 'reject' | 'suspend' | 'reactivate';
export const USER_ACTIONS: Record<UserStatus, UserAction[]> = {
  pending_email: [],
  pending_review: ['approve', 'reject'],
  approved: ['suspend'],
  // `reactivate` على المرفوض يعيده «بانتظار المراجعة» (لا اعتماد مباشر)
  rejected: ['reactivate'],
  suspended: ['reactivate'],
};

/** نصّ زرّ `reactivate` ورسالة نجاحه حسب الحالة — المرفوض يعود للمراجعة، والموقوف يعود معتمداً */
export function reactivateCopy(status: UserStatus): { label: string; success: string } {
  return status === 'rejected'
    ? { label: 'إعادة للمراجعة', success: 'أُعيد الطلب لقائمة المراجعة' }
    : { label: 'إعادة تفعيل', success: 'أُعيد تفعيل السفير' };
}

/** `void`/`activate` بالمسار نفسه · `reassign` و`window` بنوافذ خاصة (API: /reassign و/window) */
export type AttributionAction = 'void' | 'activate' | 'reassign' | 'window';
export const ATTRIBUTION_ACTIONS: Record<AttributionStatus, AttributionAction[]> = {
  active: ['void'],
  disputed: ['activate', 'void', 'reassign'],
  void: ['activate', 'reassign'],
};

/**
 * إجراءات صفّ إسناد: بحسب الحالة، و«تعديل بداية الإسناد» فقط لإسنادٍ **بلا عمولة**
 * (الخادم يرفضه متى وُجدت عمولة، وتعديل بداية إسنادٍ مُبطَل لا معنى له).
 */
export function attributionActions(row: { status: AttributionStatus; commission: unknown | null | undefined }): AttributionAction[] {
  const list = [...(ATTRIBUTION_ACTIONS[row.status] ?? [])];
  if (!row.commission && row.status !== 'void') list.push('window');
  return list;
}

export type CommissionAction = 'approve' | 'hold' | 'release' | 'decline';
export const COMMISSION_ACTIONS: Record<CommissionStatus, CommissionAction[]> = {
  pending: ['approve', 'hold', 'decline'],
  on_hold: ['release', 'decline'],
  approved: [],
  paid: [],
  reversed: [],
  declined: [],
};

// ─── الأرقام ───────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * يوحّد ما يكتبه المالك: أرقام عربية-هندية (٠-٩) وفارسية (۰-۹)، الفاصلة
 * العشرية العربية (٫) والفاصلة (,) نقطةً، وعلامة الناقص الطباعية (−) شرطة،
 * ويحذف المسافات (بما فيها غير المنكسرة) وعلامات الاتجاه غير المرئية.
 */
export function normalizeNumeric(raw: string): string {
  return String(raw ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.')
    .replace(/[−–﹣－]/g, '-')
    .replace(/[\s ‎‏؜]/g, '');
}

/**
 * عدد عشري بخانتين كحدٍّ أقصى ⇒ عدد صحيح من «المئات» (هللات للريال،
 * نقاط أساس للنسبة المئوية) — بالأجزاء النصّية، بلا فاصلة عائمة.
 */
function parseHundredths(raw: string, what: string): Parsed<number> {
  const s = normalizeNumeric(raw);
  if (s === '') return { ok: false, error: `أدخل ${what}` };
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return { ok: false, error: `${what} غير صالح` };
  const [, sign, intPart, fracPart = ''] = m;
  if (fracPart.length > 2) return { ok: false, error: 'خانتان عشريتان كحدٍّ أقصى' };
  const intDigits = intPart.replace(/^0+(?=\d)/, '') || '0';
  if (intDigits.length > 13) return { ok: false, error: `${what} كبير جداً` };
  const value = Number(intDigits) * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${what} كبير جداً` };
  return { ok: true, value: sign === '-' && value !== 0 ? -value : value };
}

/**
 * نصّ ريال ⇒ هللات صحيحة.
 * `allowNegative` للتصحيحات اليدوية (خصم)، و`allowZero` لحدٍّ أدنى يجوز أن يكون صفراً.
 */
export function parseSarToHalalas(
  raw: string,
  opts: { allowNegative?: boolean; allowZero?: boolean } = {},
): Parsed<number> {
  const r = parseHundredths(raw, 'المبلغ');
  if (!r.ok) return r;
  if (r.value < 0 && !opts.allowNegative) return { ok: false, error: 'المبلغ لا يكون سالباً هنا' };
  if (r.value === 0 && !opts.allowZero) return { ok: false, error: 'المبلغ لا يكون صفراً' };
  return r;
}

/** هللات ⇒ نصّ ريال قابل للتحرير («100» أو «12.50» أو «-0.05») */
export function halalasToSarInput(halalas: number): string {
  const h = Math.trunc(Number(halalas) || 0);
  const abs = Math.abs(h);
  const int = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${h < 0 ? '-' : ''}${int}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

/** هللات ⇒ عرض «1,234.50 ر.س» بأرقام لاتينية كبقية نوافذ المالك */
export function formatHalalas(halalas: number | null | undefined): string {
  if (halalas == null || !Number.isFinite(Number(halalas))) return '—';
  const h = Math.trunc(Number(halalas));
  const abs = Math.abs(h);
  const int = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = abs % 100;
  return `${h < 0 ? '-' : ''}${int}${frac ? `.${String(frac).padStart(2, '0')}` : ''} ر.س`;
}

/** نقاط أساس ⇒ نصّ نسبة مئوية («3000» ⇒ «30»، «1250» ⇒ «12.5»، «5» ⇒ «0.05») */
export function bpsToPercent(bps: number): string {
  const b = Math.trunc(Number(bps) || 0);
  const abs = Math.abs(b);
  const int = Math.floor(abs / 100);
  const frac = abs % 100;
  const fracStr = frac ? `.${String(frac).padStart(2, '0').replace(/0$/, '')}` : '';
  return `${b < 0 ? '-' : ''}${int}${fracStr}`;
}

/** نصّ نسبة مئوية ⇒ نقاط أساس صحيحة ضمن 0..10000 (مدى API) */
export function parsePercentToBps(raw: string): Parsed<number> {
  const r = parseHundredths(raw, 'النسبة');
  if (!r.ok) return r;
  if (r.value < 0 || r.value > 10000) return { ok: false, error: 'النسبة بين 0 و100' };
  return r;
}

/** عدد صحيح ضمن مدى (أيام الإعدادات) — يقبل الأرقام العربية */
export function parseIntInRange(raw: string, min: number, max: number, what = 'القيمة'): Parsed<number> {
  const s = normalizeNumeric(raw);
  if (!/^\d+$/.test(s)) return { ok: false, error: `${what}: عدد صحيح بلا كسور` };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) return { ok: false, error: `${what} بين ${min} و${max}` };
  return { ok: true, value: n };
}

// ─── التحقّق من مدخلات النماذج (مطابقة لحدود API.md) ────────────────────────

export const TERMS_VERSION_RE = /^[\w.-]{3,40}$/;
export const TERMS_BODY_MIN = 50;

export function validateTermsForm(version: string, body: string): string | null {
  if (!TERMS_VERSION_RE.test(version.trim())) return 'رقم الإصدار: 3 إلى 40 حرفاً لاتينياً أو أرقاماً أو . - _';
  if (body.trim().length < TERMS_BODY_MIN) return `نصّ الشروط ${TERMS_BODY_MIN} حرفاً على الأقل`;
  return null;
}

export const REASON_MIN = 3;
export function validateReason(reason: string): string | null {
  return reason.trim().length >= REASON_MIN ? null : `اكتب السبب (${REASON_MIN} أحرف على الأقل)`;
}

export function isIsoDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function validatePayoutRecord(bankReference: string, transferredAt: string, today: string): string | null {
  const ref = bankReference.trim();
  if (ref.length < 3 || ref.length > 80) return 'مرجع التحويل البنكي من 3 إلى 80 حرفاً';
  if (!isIsoDay(transferredAt)) return 'تاريخ التحويل غير صالح';
  if (transferredAt > today) return 'تاريخ التحويل لا يكون في المستقبل';
  return null;
}

export function validateAdjustment(affiliateId: string, amountRaw: string, note: string): Parsed<number> {
  if (!affiliateId) return { ok: false, error: 'اختر السفير' };
  const amount = parseSarToHalalas(amountRaw, { allowNegative: true });
  if (!amount.ok) return amount;
  if (note.trim().length < 3) return { ok: false, error: 'اكتب ملاحظة القيد (3 أحرف على الأقل)' };
  return amount;
}

// ─── إعادة الإسناد وتعديل بدايته ────────────────────────────────────────────

export interface ReassignForm { affiliateId: string; reason: string; effectiveFrom: string; claimId: string }
export interface ReassignBody { affiliateId: string; reason: string; effectiveFrom?: string; claimId?: string }

export function validateReassign(f: ReassignForm): string | null {
  if (!f.affiliateId) return 'اختر السفير';
  const r = validateReason(f.reason);
  if (r) return r;
  if (f.effectiveFrom && !isIsoDay(f.effectiveFrom)) return 'تاريخ البدء غير صالح';
  return null;
}

/** جسم `POST /attributions/:id/reassign` — الاختياريّة تُرسل فقط إن وُجدت */
export function buildReassignBody(f: ReassignForm): ReassignBody {
  const body: ReassignBody = { affiliateId: f.affiliateId, reason: f.reason.trim() };
  if (f.effectiveFrom) body.effectiveFrom = f.effectiveFrom;
  if (f.claimId) body.claimId = f.claimId;
  return body;
}

/** ترشيحات السفير المختار التي يجوز ربطها بإعادة الإسناد: المعتمدة والمنتهية فقط */
export const REASSIGN_CLAIM_STATUSES = ['approved', 'expired'] as const;
export function reassignClaimOptions<T extends { affiliate: { id: string }; status: string }>(
  claims: T[] | null | undefined, affiliateId: string,
): T[] {
  if (!affiliateId || !Array.isArray(claims)) return [];
  return claims.filter((c) => c.affiliate?.id === affiliateId && (REASSIGN_CLAIM_STATUSES as readonly string[]).includes(c.status));
}

export function validateWindow(effectiveFrom: string, reason: string): string | null {
  if (!effectiveFrom) return 'اختر تاريخ بداية الإسناد';
  if (!isIsoDay(effectiveFrom)) return 'تاريخ البدء غير صالح';
  return validateReason(reason);
}

// ─── نتيجة الاحتساب بعد الربط/الإسناد (commissionCreated · accrualReason) ─────

export const ACCRUAL_REASONS = [
  'not_paid_or_unlinked', 'zero_amount', 'no_attribution', 'exists', 'not_first_payment',
  'outside_window', 'zero_commission', 'no_payment', 'first_payment_reversed', 'earlier_payment_linked',
  'earlier_payment_committed', 'earlier_payment_no_commission', 'error',
] as const;
export type AccrualReason = typeof ACCRUAL_REASONS[number];

export const ACCRUAL_REASON_LABEL: Record<AccrualReason, string> = {
  not_paid_or_unlinked: 'الدفعة غير مؤكَّدة أو غير مربوطة',
  zero_amount: 'مبلغ الدفعة صفر',
  no_attribution: 'لا إسناد ساري للشركة',
  exists: 'للشركة عمولة مسبقاً',
  not_first_payment: 'ليست أول دفعة للشركة',
  outside_window: 'الدفعة خارج نافذة الإسناد — عدّل بداية الإسناد إن كان ذلك خطأً',
  zero_commission: 'العمولة صفر',
  no_payment: 'لا دفعة مؤكَّدة للشركة بعد',
  first_payment_reversed: 'أول دفعة للشركة مستردّة',
  earlier_payment_linked: 'رُبطت بالشركة دفعةٌ أقدم — أُوقفت العمولة القائمة للمراجعة',
  earlier_payment_committed: 'رُبطت بالشركة دفعةٌ أقدم، والعمولة القائمة على دفعةٍ لاحقة مصروفةٌ أو في مسودّة — ألغِ المسودّة أو صحّح بقيد',
  earlier_payment_no_commission: 'رُبطت بالشركة دفعةٌ أقدم ولا عمولة قائمة تُحتسب عليها — عوّض بقيد تصحيح إن استحقّ السفير',
  error: 'تعذّر الاحتساب الآن — ستُعاد المحاولة تلقائياً',
};

/** تنازعٌ عند ربط ترشيحٍ بشركةٍ مُسندة لسفيرٍ آخر برمز التسجيل */
export interface LinkConflict { attributionStatus: string; commissionHeld: boolean }

/** «الشركة مُسندة لسفير آخر… الإسناد الآن: متنازع عليه، وأُوقفت عمولته. احسمه…» */
export function conflictMessage(c: LinkConflict): string {
  const st = labelOf(ATTRIBUTION_STATUS_LABEL, c.attributionStatus);
  return `الشركة مُسندة لسفير آخر برمز التسجيل — الإسناد الآن: ${st}${c.commissionHeld ? '، وأُوقفت عمولته' : ''}. احسمه من تبويب الإسناد بـ«إعادة إسناد»`;
}

/**
 * نتيجة الاحتساب في ردود الربط والإسناد. `accrualReason` = null حين كانت للإسناد عمولةٌ
 * قائمة (لم تُجرَّب محاولة)، وسببٌ حقيقي حين جُرّبت ولم تُنشأ.
 */
export interface AccrualResult {
  commissionCreated?: boolean;
  accrualReason?: string | null;
  conflict?: LinkConflict | null;
}

/** رسالة للمالك + هل تستحق تنبيهاً (لا نجاحاً صامتاً) */
export interface OutcomeMessage { text: string; warn: boolean }

/**
 * يُكمل رسالة الإجراء بنتيجة الاحتساب:
 *  · `conflict` (كائن) ⇒ رسالة التنازع بحالة الإسناد الآن وإيقاف العمولة (تنبيه)
 *  · `commissionCreated` ⇒ «أُنشئت عمولة» — **فقط** حينها
 *  · لم تُنشأ وسببٌ مذكور ⇒ السبب بالعربية (تنبيه، عدا «لا إسناد ساري» حين يُطلب إسكاته)
 */
export function withAccrual(base: string, r: AccrualResult | null | undefined, opts: { quietNoAttribution?: boolean } = {}): OutcomeMessage {
  if (r?.conflict && typeof r.conflict === 'object') return { text: `${base}. ${conflictMessage(r.conflict)}`, warn: true };
  if (r?.commissionCreated === true) return { text: `${base} — وأُنشئت عمولة`, warn: false };
  const reason = r?.accrualReason;
  if (reason) {
    const quiet = opts.quietNoAttribution === true && reason === 'no_attribution';
    return { text: `${base} — لم تُنشأ عمولة: ${labelOf(ACCRUAL_REASON_LABEL, reason)}`, warn: !quiet };
  }
  return { text: base, warn: false };
}

/**
 * رسالة ربط ترشيحٍ بشركة: مع التنازع لا تُذكر حالة الإسناد مرّتين (رسالة التنازع تحملها)،
 * وبلا تنازع تُكمَل بنتيجة الاحتساب المعتادة.
 */
export function claimLinkMessage(companyName: string, tenantName: string, r: (AccrualResult & { attribution?: { status?: string } }) | null | undefined): OutcomeMessage {
  const base = `رُبط «${companyName}» بـ${tenantName}`;
  if (r?.conflict && typeof r.conflict === 'object') return withAccrual(base, r);
  return withAccrual(`${base} — الإسناد: ${labelOf(ATTRIBUTION_STATUS_LABEL, r?.attribution?.status)}`, r);
}

/**
 * رسالة إعادة الإسناد: عمولةٌ أُنشئت الآن ⇒ «وأُنشئت عمولة (حالتها)»، وعمولةٌ قائمة نُقلت
 * ⇒ «نُقلت العمولة — حالتها»، وإلا سبب عدم الإنشاء إن وُجد.
 */
export function reassignMessage(
  tenantName: string,
  r: (AccrualResult & { attribution?: { status?: string }; commission?: { status?: string } | null }) | null | undefined,
): OutcomeMessage {
  const base = `أُعيد إسناد ${tenantName} — الإسناد: ${labelOf(ATTRIBUTION_STATUS_LABEL, r?.attribution?.status)}`;
  const com = r?.commission;
  if (com && r?.commissionCreated === true) {
    return { text: `${base} — وأُنشئت عمولة (${labelOf(COMMISSION_STATUS_LABEL, com.status)})`, warn: false };
  }
  if (com) return { text: `${base} — نُقلت العمولة — ${labelOf(COMMISSION_STATUS_LABEL, com.status)}`, warn: false };
  return withAccrual(base, r);
}

/** ما يُعرض على بطاقة ترشيح: الاعتماد للمُراجَع، والرفض للمُراجَع والمعتمد، والربط للمعتمد والمنتهي بلا شركة */
export function claimActions(c: { status: string; tenantId: string | null | undefined }): { approve: boolean; reject: boolean; link: boolean } {
  return {
    approve: c.status === 'under_review',
    reject: c.status === 'under_review' || c.status === 'approved',
    link: (c.status === 'approved' || c.status === 'expired') && !c.tenantId,
  };
}

// ─── الإعدادات مقابل الشروط ─────────────────────────────────────────────────

/** القيم المرتبطة بالشروط: لا تتغيّر من PUT /settings بل بنشر إصدار (POST /terms {rules}) */
export const TERMS_RULE_KEYS = ['rateBps', 'holdDays', 'minPayoutHalalas', 'refWindowDays', 'claimLockDays', 'firstPaymentWithinDays'] as const;
export type TermsRuleKey = typeof TERMS_RULE_KEYS[number];
export type TermsRules = Record<TermsRuleKey, number>;

export const RULE_LABEL: Record<TermsRuleKey, string> = {
  rateBps: 'نسبة العمولة',
  holdDays: 'فترة الحجز',
  minPayoutHalalas: 'الحدّ الأدنى للصرف',
  refWindowDays: 'نافذة رابط الإحالة',
  claimLockDays: 'قفل الترشيح المعتمد',
  firstPaymentWithinDays: 'مهلة الدفعة الأولى',
};

/** مدى كل قاعدة بوحدة الخادم (نقاط أساس · أيام · هللات) — مطابق للخادم */
export const RULE_LIMITS: Record<TermsRuleKey, { min: number; max: number }> = {
  rateBps: { min: 0, max: 10000 },
  holdDays: { min: 0, max: 365 },
  minPayoutHalalas: { min: 0, max: 100_000_000 },
  refWindowDays: { min: 1, max: 365 },
  claimLockDays: { min: 1, max: 365 },
  firstPaymentWithinDays: { min: 1, max: 730 },
};

/** قيمة قاعدة للعرض: «30%» · «1,000 ر.س» · «30 يوماً» */
export function formatRule(key: TermsRuleKey, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  if (key === 'rateBps') return `${bpsToPercent(value)}%`;
  if (key === 'minPayoutHalalas') return formatHalalas(value);
  return `${Math.trunc(Number(value))} يوماً`;
}

/** نصوص حقول القواعد من القيم الحالية (النسبة مئوية، الحدّ الأدنى بالريال) */
export type RuleInputs = Record<TermsRuleKey, string>;
export function rulesToInputs(r: Partial<TermsRules>): RuleInputs {
  const n = (k: TermsRuleKey) => Number(r[k] ?? 0);
  return {
    rateBps: bpsToPercent(n('rateBps')),
    holdDays: String(n('holdDays')),
    minPayoutHalalas: halalasToSarInput(n('minPayoutHalalas')),
    refWindowDays: String(n('refWindowDays')),
    claimLockDays: String(n('claimLockDays')),
    firstPaymentWithinDays: String(n('firstPaymentWithinDays')),
  };
}

/** القواعد الست من كائن الإعدادات */
export function rulesOf(s: Partial<TermsRules>): Partial<TermsRules> {
  const out: Partial<TermsRules> = {};
  for (const k of TERMS_RULE_KEYS) {
    const v = s[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * يحلّل حقول قواعد النشر ويُعيد **المتغيّر فقط** مقارنةً بالقيم الحالية.
 * نسبةٌ مئوية ⇒ نقاط أساس، وريال ⇒ هللات، بالمدى نفسه في الخادم.
 */
export function parseRuleChanges(inputs: RuleInputs, current: Partial<TermsRules>): Parsed<Partial<TermsRules>> {
  const out: Partial<TermsRules> = {};
  for (const k of TERMS_RULE_KEYS) {
    const { min, max } = RULE_LIMITS[k];
    const what = RULE_LABEL[k];
    let r: Parsed<number>;
    if (k === 'rateBps') {
      r = parsePercentToBps(inputs[k]);
      if (!r.ok) return { ok: false, error: `${what}: ${r.error}` };
    } else if (k === 'minPayoutHalalas') {
      r = parseSarToHalalas(inputs[k], { allowZero: true });
      if (!r.ok) return { ok: false, error: `${what}: ${r.error}` };
      if (r.value < min || r.value > max) return { ok: false, error: `${what} بين 0 و${formatHalalas(max)}` };
    } else {
      r = parseIntInRange(inputs[k], min, max, what);
      if (!r.ok) return r;
    }
    if (r.value !== current[k]) out[k] = r.value;
  }
  return { ok: true, value: out };
}

/** سطور «القاعدة: القديم ← الجديد» لنافذة تأكيد النشر */
export function describeRuleChanges(changes: Partial<TermsRules>, current: Partial<TermsRules>): string[] {
  return TERMS_RULE_KEYS.filter((k) => changes[k] !== undefined)
    .map((k) => `${RULE_LABEL[k]}: ${formatRule(k, current[k])} ← ${formatRule(k, changes[k])}`);
}

export const DISCLOSURE_MIN = 10;
export const DISCLOSURE_MAX = 300;
export function validateDisclosure(text: string): string | null {
  const n = text.trim().length;
  if (n < DISCLOSURE_MIN) return `نصّ الإفصاح ${DISCLOSURE_MIN} أحرف على الأقل`;
  if (n > DISCLOSURE_MAX) return `نصّ الإفصاح ${DISCLOSURE_MAX} حرف كحدّ أقصى`;
  return null;
}

/** ما يقبله PUT /settings وحده */
export interface SettingsDraft { intakeOpen: boolean; disclosureText: string }
export type SettingsBody = Partial<SettingsDraft>;

export function settingsDraftOf(s: { intakeOpen: boolean; disclosureText: string }): SettingsDraft {
  return { intakeOpen: !!s.intakeOpen, disclosureText: s.disclosureText ?? '' };
}

/** جسم PUT /settings بالمتغيّر فقط — لا يحمل أيّ قيمة مرتبطة بالشروط أبداً */
export function settingsDiff(draft: SettingsDraft, server: { intakeOpen: boolean; disclosureText: string }): SettingsBody {
  const body: SettingsBody = {};
  if (draft.intakeOpen !== !!server.intakeOpen) body.intakeOpen = draft.intakeOpen;
  const text = draft.disclosureText.trim();
  if (text !== (server.disclosureText ?? '').trim()) body.disclosureText = text;
  return body;
}

export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return a.intakeOpen === b.intakeOpen && a.disclosureText === b.disclosureText;
}

/**
 * مزامنة مسودّة الإعدادات حين يُعاد جلبها (بعد نشر شروط مثلاً): النموذج **النظيف**
 * يتبنّى القيم الجديدة، والمعدَّل يبقى كما هو — لا تُمحى تعديلات غير محفوظة.
 */
export function syncSettingsDraft(draft: SettingsDraft, prevBase: SettingsDraft, nextBase: SettingsDraft): SettingsDraft {
  return sameDraft(draft, prevBase) ? nextBase : draft;
}

// ─── التواريخ ──────────────────────────────────────────────────────────────

/** الرياض UTC+3 بلا توقيت صيفي — إزاحة ثابتة */
const RIYADH_OFFSET_MS = 3 * 3_600_000;

/** يوم الرياض 'YYYY-MM-DD' للحظةٍ ما (افتراضياً الآن) — لا يوم UTC ولا يوم جهاز المالك */
export function riyadhDayKey(at: Date | number = Date.now()): string {
  const t = at instanceof Date ? at.getTime() : at;
  const d = new Date(t + RIYADH_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * مفتاح يوم لقيمةٍ من الخادم: `'YYYY-MM-DD'` (حقول اليوم الخالص — `transferredAt` وبداية
 * الإسناد) تُؤخذ كما هي، ولحظةٌ ISO كاملة تُحوَّل ليوم الرياض — **لا تُقصّ**
 * أوّل عشرة أحرف منها (`2026-09-12T22:00Z` يومها في الرياض 13 لا 12). غير الصالح ⇒ null.
 */
export function dayKeyOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isIsoDay(s) ? s : null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? riyadhDayKey(t) : null;
}


// ─── التصفية والاستعلام ─────────────────────────────────────────────────────

/** يحذف المعاملات الفارغة كي لا يصل `?status=` فارغاً فيُفسَّر تصفيةً على قيمة فارغة */
export function cleanParams(params: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const t = (v ?? '').trim();
    if (t) out[k] = t;
  }
  return out;
}

/** تطبيع عربي للبحث المحلي: همزات، تاء مربوطة، ألف مقصورة، تشكيل، مسافات، حالة الأحرف */
export function normalizeSearch(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesSearch(q: string, ...fields: Array<string | null | undefined>): boolean {
  const n = normalizeSearch(q);
  if (!n) return true;
  return fields.some((f) => normalizeSearch(f).includes(n));
}

/** ترتيب السفراء في قوائم الاختيار: المعتمدون أولاً ثم بالاسم */
export function sortAffiliatesForSelect<T extends { status: string; fullName: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ra = a.status === 'approved' ? 0 : 1;
    const rb = b.status === 'approved' ? 0 : 1;
    return ra - rb || a.fullName.localeCompare(b.fullName, 'ar');
  });
}

/**
 * يجوز «إنشاء دفعة» لمرشّحٍ مؤهّلٍ له آيبان — **ولو بلا عمولات** (`commissionCount: 0`):
 * تصحيحٌ موجب وحده يكفي لدفعة.
 */
export function canCreatePayout(c: { eligible: boolean; hasPayout: boolean }): boolean {
  return c.eligible === true && c.hasPayout === true;
}

/** سبب عدم أهلية مرشّح للصرف — بالعربية لعمود «مؤهّل» */
export function candidateBlocker(c: { eligible: boolean; hasPayout: boolean; netHalalas: number }, minPayoutHalalas?: number): string | null {
  if (!c.hasPayout) return 'لم يُدخل آيبان بعد';
  if (c.netHalalas <= 0) return 'الصافي صفر أو سالب';
  if (minPayoutHalalas != null && c.netHalalas < minPayoutHalalas) return `دون الحدّ الأدنى ${formatHalalas(minPayoutHalalas)}`;
  if (!c.eligible) return 'غير مؤهّل بعد';
  return null;
}

/** رسالة الخادم العربية من خطأ axios — وإلا البديل */
export function apiErrorMessage(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof msg === 'string' && msg.trim() ? msg : fallback;
}

/**
 * رقم تواصل الترشيح كما يخزّنه الخادم (أرقامٌ بلا «+»: `966551234567` · `971501234567` ·
 * `0112345678` · `920012345`) ⇒ رابط `tel:` يُضيف «+» للجوال والدولي، وعرضٌ مقروء.
 */
export const telHref = contactPhoneTel;
export const phoneDisplay = contactPhoneDisplay;

/** آيبان بمجموعات رباعية للقراءة عند التحويل اليدوي («SA03 8000 …») */
export function groupIban(iban: string): string {
  return String(iban ?? '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
}

export const PORTAL_URL = 'https://fieldsa.net/ax';

// ─── أشكال الردود (API.md §2) ──────────────────────────────────────────────

export interface AffRef { id: string; fullName: string; code: string }

export interface Overview {
  affiliates: { pending_review: number; approved: number; suspended: number; total: number };
  claimsUnderReview: number;
  attributions: { active: number; disputed: number };
  commissions: { pendingHalalas: number; onHoldHalalas: number; readyToApprove: number; approvedUnpaidHalalas: number; paidHalalas: number };
  payoutCandidates: number;
}

export interface AffiliateSettings {
  intakeOpen: boolean; rateBps: number; holdDays: number; minPayoutHalalas: number;
  refWindowDays: number; claimLockDays: number; firstPaymentWithinDays: number;
  currentTermsVersion?: string; disclosureText: string; updatedAt?: string; updatedBy?: string | null;
}

export interface TermsVersion { version: string; body: string; publishedAt: string; publishedBy: string; rules?: TermsRules }

export interface AffiliateRow {
  id: string; fullName: string; email: string; phone: string | null; city: string | null; code: string;
  status: UserStatus; statusReason: string | null; createdAt: string; lastLoginAt: string | null;
  counts: { claims: number; attributions: number; commissions: number };
  earnedHalalas: number; paidHalalas: number; hasPayout: boolean;
}

export interface AffiliateEvent {
  id: string; entity: string; entityId: string; action: string; fromState: string | null; toState: string | null;
  actorType: string; actorId: string | null; reason: string | null; meta: unknown; createdAt: string;
}

/**
 * تفصيل السفير — API.md لا يحدّد أشكال مصفوفاته الفرعية (`[...]`)، فتُقرأ
 * هنا بحقول اختيارية مأخوذة من صفوف القوائم ومن نموذج البيانات، ويسقط العرض
 * بأمان عند غياب أيٍّ منها.
 */
export interface AffiliateDetail {
  affiliate: AffiliateRow & {
    vatNumber: string | null; termsVersion: string; termsAcceptedAt: string | null; marketingConsent: boolean;
    payout: { holderName: string; bankName: string | null; ibanLast4: string; updatedAt: string } | null;
  };
  claims: Array<Partial<ClaimRow> & { id: string }>;
  attributions: Array<Partial<AttributionRow> & { id: string; tenantNameSnapshot?: string }>;
  commissions: Array<Partial<CommissionRow> & { id: string; tenantNameSnapshot?: string }>;
  adjustments: Array<{ id: string; kind?: string; amountHalalas?: number; note?: string | null; createdAt?: string; payoutId?: string | null; settled?: boolean; inDraft?: boolean }>;
  payouts: Array<Partial<PayoutRow> & { id: string }>;
  events: AffiliateEvent[];
}

export interface RevealedIban { iban: string; holderName: string; bankName: string | null }

export interface ClaimRow {
  id: string; affiliate: AffRef; companyName: string; crNumber: string; city: string | null;
  /** رقم تواصل المنشأة (إلزامي في الترشيحات الجديدة، null للأقدم) */
  contactPhone: string | null; how: ClaimHow;
  note: string | null; status: ClaimStatus; reasonCode: ClaimReason | null; submittedAt: string;
  reviewedAt: string | null; lockedUntil: string | null; tenantId: string | null; tenantName: string | null;
  conflicts: Array<{ claimId: string; affiliateName: string; status: ClaimStatus }>;
  suggestions: Array<{ tenantId: string; tenantName: string; match: 'cr' | 'name'; createdAt: string }>;
}

export interface AttributionRow {
  id: string; tenantId: string; tenantName: string; affiliate: AffRef; source: AttributionSource;
  status: AttributionStatus; flags: Flag[]; codeUsed: string | null; refVia: string | null; reasonNote: string | null;
  effectiveFrom: string; firstPaymentDeadline: string; rateBps: number; createdAt: string;
  commission: { id: string; status: CommissionStatus; commissionHalalas: number } | null;
}

export interface CommissionRow {
  id: string; tenantId: string; tenantName: string; affiliate: AffRef; paymentLinkId: string;
  paymentAmountHalalas: number; refundedHalalas?: number; coveredMonths: number; rateBps: number; commissionHalalas: number;
  paymentPaidAt: string; eligibleAt: string; status: CommissionStatus; reasonNote: string | null;
  approvedAt: string | null; payoutId: string | null; linkStatus: string; readyToApprove: boolean;
}

export interface PayoutCandidate {
  affiliate: AffRef & { email: string };
  commissionsHalalas: number; adjustmentsHalalas: number; netHalalas: number; commissionCount: number;
  eligible: boolean; hasPayout: boolean; ibanLast4: string | null; holderName: string | null;
}

export interface PayoutRow {
  id: string; affiliate: AffRef; commissionsHalalas: number; adjustmentsHalalas: number; netHalalas: number;
  status: PayoutStatus; ibanLast4: string; holderName: string; transferredAt: string | null;
  bankReference: string | null; createdAt: string; voidReason: string | null; commissionCount: number;
}

export interface TenantHit { id: string; name: string; commercialReg: string | null; createdAt: string; attributed: boolean }

/** ردّ `POST /claims/:id/link-tenant` */
export interface ClaimLinkResult extends AccrualResult {
  attribution: { id: string; status: AttributionStatus };
  commission: { id: string; status: CommissionStatus } | null;
  commissionCreated: boolean; accrualReason: string | null; conflict: LinkConflict | null;
}

/** ردّ `POST /api/payments/:id/link-tenant` */
export interface PaymentLinkResult extends AccrualResult {
  link: unknown; commission: unknown | null; commissionCreated: boolean; accrualReason: string | null;
}

/** ردّ `POST /attributions/:id/reassign` و`/window` */
export interface AttributionChangeResult extends AccrualResult {
  attribution: { id: string; status: AttributionStatus };
  commission: { id: string; status: CommissionStatus; commissionHalalas: number } | null;
  commissionCreated: boolean; accrualReason: string | null;
}

// ─── تطبيع الردود — المصفوفات الغائبة تصير فارغة فلا ينهار العرض ────────────

const arr = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

export function normalizeDetail(d: AffiliateDetail): AffiliateDetail {
  return {
    ...d,
    claims: arr(d.claims),
    attributions: arr(d.attributions),
    commissions: arr(d.commissions),
    adjustments: arr(d.adjustments),
    payouts: arr(d.payouts),
    events: arr(d.events),
  };
}

export function normalizeClaims(list: ClaimRow[]): ClaimRow[] {
  return arr(list).map((c) => ({ ...c, conflicts: arr(c.conflicts), suggestions: arr(c.suggestions) }));
}

export function normalizeAttributions(list: AttributionRow[]): AttributionRow[] {
  return arr(list).map((a) => ({ ...a, flags: arr(a.flags) }));
}
