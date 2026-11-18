/**
 * منطق لوحة «سفير فيلد سيلز» للمالك — نقيّ بلا DOM ولا React ولا شبكة.
 *
 * الأشكال والتعدادات منقولة حرفياً من `docs/affiliate/API.md` §2، وتعدادات v2
 * (حالة الدفعة `failed`، نوع السفير، المنصّات، المستندات، المطالبات الفائتة،
 * المواد التسويقية) من `docs/affiliate/V2_SPEC.md` §3 — قرار المالك ١٨ نوفمبر ٢٠٢٦:
 * انضمامٌ فوريّ بلا موافقة، وحجز ١٠ أيام ثم اعتمادٌ تلقائي، ودورة تسوية كل ١٠ أيام.
 * الخادم يُكتب بالتوازي على المواصفة نفسها، فأي اسم هنا يخالفها خللٌ صامت (حالة
 * بلا تسمية تظهر للمالك رمزاً إنجليزياً). الحارس في `affiliatesPanelLogic.test.ts`.
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
// v2: `failed` = «فشل التحويل» — المالك يسجّله على مسودّةٍ ارتدّ تحويلها فتعود عمولاتها «معتمدة» للدورة التالية
export const PAYOUT_STATUSES = ['draft', 'recorded', 'void', 'failed'] as const;
export const CLAIM_HOWS = ['visit', 'relationship', 'event', 'online', 'other'] as const;
export const CLAIM_REASONS = ['existing_customer', 'duplicate', 'self_referral', 'insufficient', 'other'] as const;
export const FLAGS = ['self_email', 'self_phone', 'returning_company', 'ip_match', 'terms_outdated', 'link_expired', 'claim_conflict'] as const;
export const ATTRIBUTION_SOURCES = ['signup_code', 'claim', 'owner', 'portal'] as const;
/** تفعيل حسابٍ فتحه السفير من البوابة (`source = 'portal'` وحده؛ null لغيره) */
export const ACTIVATION_STATES = ['pending', 'active'] as const;
export const REF_VIAS = ['link', 'typed'] as const;
export const ADJUSTMENT_KINDS = ['clawback_refund', 'correction'] as const;
// staff: موظف منصة بصلاحية السفراء (services/affiliate/core.ts platformActor)
export const ACTOR_TYPES = ['system', 'affiliate', 'owner', 'staff', 'company'] as const;

// ─── تعدادات v2 (V2_SPEC §3) ───────────────────────────────────────────────
export const PARTNER_TYPES = ['individual', 'company', 'influencer'] as const;
export const SOCIAL_PLATFORMS = ['x', 'instagram', 'snapchat', 'tiktok', 'youtube', 'linkedin', 'website', 'other'] as const;
export const DOC_KINDS = ['national_id', 'commercial_reg'] as const;
export const MISSED_CLAIM_STATUSES = ['under_review', 'accepted', 'rejected', 'withdrawn'] as const;
export const MATERIAL_CATEGORIES = ['image', 'video', 'document', 'text', 'link'] as const;
/** ما ينقص الملف كما يعيده الخادم في `missing` (V2_SPEC §6.1 `GET /me`) */
export const PROFILE_MISSING = ['partnerType', 'iban', 'national_id', 'commercial_reg'] as const;
/** سبب اقتراح شركةٍ لمطالبةٍ فائتة: مطابقة بالسجل ثمّ الجوال ثمّ الاسم (API.md §2 `GET /missed-claims`) */
export const MISSED_MATCHES = ['cr', 'phone', 'name'] as const;
/**
 * سبب حجب مرشّح الصرف (API.md `type PayoutBlock`): أوّل ما ينطبق بالترتيب. `iban_failed` = فشل آخر
 * تحويلٍ ولم يحدّث السفير بيانات استلامه بعده — يحجب **الدورة الآلية** وحدها، والمالك يُنشئ يدوياً إن شاء.
 */
export const PAYOUT_BLOCKS = ['not_approved', 'below_min', 'no_iban', 'profile_incomplete', 'has_draft', 'iban_failed'] as const;
/** مهلة المطالبة بإحالة فائتة من تسجيل الشركة (الشروط v4 — يفرضها الخادم بـ409 `claim_late`) */
export const MISSED_CLAIM_WINDOW_DAYS = 30;
/**
 * حالات تصفية المسوّقين: `pending_*` إرثٌ يُرقّى إلى `approved` عند الإقلاع وعند الدخول
 * (V2_SPEC §3) فلا يُعرض زرّاً — ويبقى في القاموس كي لا يظهر صفٌّ قديم رمزاً إنجليزياً.
 */
export const USER_FILTER_STATUSES = ['approved', 'suspended', 'rejected'] as const;

export type UserStatus = typeof USER_STATUSES[number];
export type ClaimStatus = typeof CLAIM_STATUSES[number];
export type AttributionStatus = typeof ATTRIBUTION_STATUSES[number];
export type CommissionStatus = typeof COMMISSION_STATUSES[number];
export type PayoutStatus = typeof PAYOUT_STATUSES[number];
export type ClaimHow = typeof CLAIM_HOWS[number];
export type ClaimReason = typeof CLAIM_REASONS[number];
export type Flag = typeof FLAGS[number];
export type AttributionSource = typeof ATTRIBUTION_SOURCES[number];
export type ActivationState = typeof ACTIVATION_STATES[number];
export type PartnerType = typeof PARTNER_TYPES[number];
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];
export type DocKind = typeof DOC_KINDS[number];
export type MissedClaimStatus = typeof MISSED_CLAIM_STATUSES[number];
export type MaterialCategory = typeof MATERIAL_CATEGORIES[number];
export type ProfileMissing = typeof PROFILE_MISSING[number];
export type MissedMatch = typeof MISSED_MATCHES[number];
export type PayoutBlock = typeof PAYOUT_BLOCKS[number];

/** تسمية عربية + نغمة لون (تُترجَم لأصناف Tailwind في المكوّن) */
export type Tone = 'gray' | 'amber' | 'green' | 'red' | 'blue' | 'orange';
export interface Label { label: string; tone: Tone }

export const USER_STATUS_LABEL: Record<UserStatus, Label> = {
  // إرثٌ قبل v2 — يُرقّى «معتمداً» تلقائياً (لا موافقة ولا تأكيد بريد بعد ١٨ نوفمبر ٢٠٢٦)
  pending_email: { label: 'طلب قديم — لم يؤكّد البريد', tone: 'gray' },
  pending_review: { label: 'طلب قديم — بانتظار المراجعة', tone: 'gray' },
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

/**
 * يراها السفير: قيد المعالجة / مدفوعة / ملغاة / فشل التحويل. والمالك يرى معها كلمة «مسودّة»
 * لأن رسائل الخادم تسمّيها كذلك («ألغِ مسودّة الدفعة أولاً»).
 */
export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, Label> = {
  draft: { label: 'مسودّة — قيد المعالجة', tone: 'amber' },
  recorded: { label: 'مدفوعة — مسجَّلة', tone: 'green' },
  void: { label: 'ملغاة', tone: 'gray' },
  failed: { label: 'فشل التحويل', tone: 'red' },
};

export const PARTNER_TYPE_LABEL: Record<PartnerType, string> = {
  individual: 'فرد',
  company: 'شركة',
  influencer: 'مؤثر',
};

export const SOCIAL_PLATFORM_LABEL: Record<SocialPlatform, string> = {
  x: 'إكس (تويتر)',
  instagram: 'إنستغرام',
  snapchat: 'سناب شات',
  tiktok: 'تيك توك',
  youtube: 'يوتيوب',
  linkedin: 'لينكدإن',
  website: 'موقع إلكتروني',
  other: 'أخرى',
};

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  national_id: 'الهوية / الإقامة',
  commercial_reg: 'السجل التجاري',
};

export const PROFILE_MISSING_LABEL: Record<ProfileMissing, string> = {
  partnerType: 'نوع السفير',
  iban: 'الآيبان',
  national_id: 'الهوية / الإقامة',
  commercial_reg: 'السجل التجاري',
};

export const MISSED_CLAIM_STATUS_LABEL: Record<MissedClaimStatus, Label> = {
  under_review: { label: 'قيد المراجعة', tone: 'amber' },
  accepted: { label: 'مقبولة — أُسندت', tone: 'green' },
  rejected: { label: 'مرفوضة', tone: 'red' },
  withdrawn: { label: 'سحبها السفير', tone: 'gray' },
};

export const MISSED_MATCH_LABEL: Record<MissedMatch, string> = {
  cr: 'السجل التجاري مطابق',
  phone: 'الجوال مطابق',
  name: 'الاسم مشابه',
};

/** عمود «الأهلية» في المرشّحين — وملخّص من تخطّتهم دورة التسوية (`skipped`) */
export const PAYOUT_BLOCK_LABEL: Record<PayoutBlock, string> = {
  not_approved: 'السفير غير معتمد',
  below_min: 'دون الحدّ الأدنى — يُرحَّل',
  no_iban: 'لم يُدخل آيبان بعد',
  profile_incomplete: 'ملفه غير مكتمل',
  has_draft: 'له مسودّة دفعة مفتوحة',
  iban_failed: 'فشل آخر تحويل ولم يحدّث الآيبان',
};

/** أسباب تخطّي الدورة غير أسباب الحجب: دُفع له في هذه الدورة، أو خطأ عابر */
export const SETTLEMENT_SKIP_LABEL: Record<string, string> = {
  ...PAYOUT_BLOCK_LABEL,
  cycle_done: 'له دفعة في هذه الدورة',
  error: 'تعذّر إنشاء دفعته',
};

export const MATERIAL_CATEGORY_LABEL: Record<MaterialCategory, string> = {
  image: 'صورة',
  video: 'فيديو',
  document: 'مستند',
  text: 'نصّ جاهز',
  link: 'رابط',
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
  // حسابٌ فتحه السفير لمنشأةٍ يحجزها ترشيحٌ معتمد لسفيرٍ آخر — «الأسبق يكسب» والقرار للمالك
  claim_conflict: 'ترشيح سفير آخر',
};

export const SOURCE_LABEL: Record<AttributionSource, string> = {
  signup_code: 'رمز عند التسجيل',
  claim: 'ترشيح',
  owner: 'إسناد يدوي',
  portal: 'فتحه السفير من البوابة',
};

/**
 * تفعيل حسابٍ فتحه السفير: «بانتظار التفعيل» = لم يختر مسؤول الشركة كلمة مروره من رابط بريده
 * بعد (بديل المالك: الدخول بالانتحال أو «إعادة تعيين كلمة مرور المدير» يفعّله).
 */
export const ACTIVATION_LABEL: Record<ActivationState, Label> = {
  pending: { label: 'بانتظار تفعيل الشركة', tone: 'amber' },
  active: { label: 'فعّلته الشركة', tone: 'green' },
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
  staff: 'موظف المنصة',
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

/**
 * v2 (قرار المالك ١٨ نوفمبر ٢٠٢٦: الانضمام فوريّ بلا موافقة): لا اعتماد ولا رفض للطلبات بعد اليوم —
 * الرفض = إيقاف. `approve`/`reject` باقيان في الخادم للإرث وحده فلا تعرضهما اللوحة.
 */
export type UserAction = 'suspend' | 'reactivate';
export const USER_ACTIONS: Record<UserStatus, UserAction[]> = {
  // إرثٌ يُرقّى «معتمداً» تلقائياً عند الإقلاع وعند دخول صاحبه — لا إجراء يدوي
  pending_email: [],
  pending_review: [],
  approved: ['suspend'],
  // `reactivate` على المرفوض (إرثاً) يعيده **معتمداً** مباشرةً كالموقوف (V2_SPEC §3: rejected→approved)
  rejected: ['reactivate'],
  suspended: ['reactivate'],
};

/** نصّ زرّ `reactivate` ورسالة نجاحه — المرفوض والموقوف كلاهما يعود «معتمداً» في v2 */
export function reactivateCopy(status: UserStatus): { label: string; success: string } {
  return status === 'rejected'
    ? { label: 'إعادة تفعيل', success: 'أُعيد تفعيل السفير — صار معتمداً' }
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
/**
 * v2: المعتمدة تُوقف أيضاً (`holdCommission` يقبل pending وapproved — V2_SPEC §0: «ويبقى للمالك الاعتماد
 * والإيقاف اليدويّان»). الاعتماد التلقائي كلّ ساعة يُخرج العمولة من «معلّقة» بعد حجزها بقليل، فبلا هذا لا
 * يبقى للمالك ما يوقفها به قبل أن تدخل مسودّة الدورة.
 */
export const COMMISSION_ACTIONS: Record<CommissionStatus, CommissionAction[]> = {
  pending: ['approve', 'hold', 'decline'],
  on_hold: ['release', 'decline'],
  approved: ['hold'],
  paid: [],
  reversed: [],
  declined: [],
};

/**
 * إجراءات صفّ عمولة: بحسب الحالة، وما في مسودّة دفعة (`payoutId`) لا يُعتمد ولا يُوقف ولا يُرفض — الخادم
 * يرفضها (`in_draft`)؛ تُلغى المسودّة أولاً فتعود العمولة «معتمدة» بلا دفعة.
 */
export function commissionActions(c: { status: CommissionStatus; payoutId?: string | null }): CommissionAction[] {
  const list = COMMISSION_ACTIONS[c.status] ?? [];
  return c.payoutId ? list.filter((a) => a === 'release') : [...list];
}

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
 * v2: حين يصل `blockedBy` يُحكم به — `null` مؤهَّل، و`iban_failed` يحجب الدورة الآلية وحدها فيبقى
 * للمالك الإنشاء اليدوي (بتأكيد). وغيابه (خادمٌ أقدم) ⇒ `eligible` كما كان.
 */
export function canCreatePayout(c: { eligible: boolean; hasPayout: boolean; blockedBy?: string | null }): boolean {
  if (c.hasPayout !== true) return false;
  if (c.blockedBy !== undefined) return c.blockedBy === null || c.blockedBy === 'iban_failed';
  return c.eligible === true;
}

/**
 * سبب عدم أهلية مرشّح للصرف — بالعربية لعمود «الأهلية». v2: `blockedBy` من الخادم أولاً (الحدّ الأدنى
 * من شروط السفير نفسه `minPayoutHalalas`)، وإلا يُستنتج كما كان. `profileComplete: false` يُذكر صراحةً:
 * الملف المكتمل شرطٌ لدخول دورة التسوية (V2_SPEC §0)؛ وغيابه من خادمٍ أقدم لا يحجب.
 */
export function candidateBlocker(
  c: { eligible: boolean; hasPayout: boolean; netHalalas: number; profileComplete?: boolean | null; blockedBy?: string | null; minPayoutHalalas?: number | null },
  minPayoutHalalas?: number,
): string | null {
  const min = typeof c.minPayoutHalalas === 'number' ? c.minPayoutHalalas : minPayoutHalalas;
  if (c.blockedBy !== undefined) {
    if (c.blockedBy === null) return null;
    if (c.blockedBy === 'below_min') {
      if (c.netHalalas <= 0) return 'الصافي صفر أو سالب';
      return min != null ? `دون الحدّ الأدنى ${formatHalalas(min)} — يُرحَّل` : PAYOUT_BLOCK_LABEL.below_min;
    }
    return labelOf(PAYOUT_BLOCK_LABEL, c.blockedBy);
  }
  if (!c.hasPayout) return 'لم يُدخل آيبان بعد';
  if (c.profileComplete === false) return 'ملفه غير مكتمل';
  if (c.netHalalas <= 0) return 'الصافي صفر أو سالب';
  if (min != null && c.netHalalas < min) return `دون الحدّ الأدنى ${formatHalalas(min)}`;
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
/** صفحة البرنامج العلنية المفهرسة (V2_SPEC §9) — تُشارَك بدل رابط البوابة */
// بالشرطة الأخيرة: الصفحة مجلّدٌ مصيَّرٌ مسبقاً (dist/ambassadors/index.html) وRender لا يخدمه إلا بها — وبدونها
// يردّ غلاف الرئيسية (عنوانها وog وcanonical «/») فتُعرض معاينة الرابط في واتساب وX ولينكدإن صفحةً رئيسية
export const PUBLIC_PAGE_URL = 'https://fieldsa.net/ambassadors/';

// ─── ملف السفير (v2) ───────────────────────────────────────────────────────

/**
 * حالة الملف لعمود «الملف»: مكتمل، أو «ينقصه: …» بأسماء ما ينقص بالترتيب الثابت.
 * غياب الحقلين (خادمٌ أقدم) ⇒ «—» لا «مكتمل» — لا نطمئن المالك على ما لا نعرفه.
 */
export function profileState(r: { profileComplete?: boolean | null; missing?: readonly string[] | null }): Label {
  if (r.profileComplete === true) return { label: 'مكتمل', tone: 'green' };
  const missing = Array.isArray(r.missing) ? r.missing : [];
  if (r.profileComplete === false || missing.length > 0) {
    const known = PROFILE_MISSING.filter((k) => missing.includes(k)).map((k) => PROFILE_MISSING_LABEL[k]);
    const extra = missing.filter((k) => !(PROFILE_MISSING as readonly string[]).includes(k));
    const all = [...known, ...extra];
    return { label: all.length ? `ينقصه: ${all.join('، ')}` : 'غير مكتمل', tone: 'amber' };
  }
  return { label: '—', tone: 'gray' };
}

/** رابطٌ يُفتح من اللوحة: http/https فقط — `javascript:` وأخواتها تُعرض نصّاً لا رابطاً */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s) || s.length > 2048) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export interface SocialLink { platform: string; url: string }

/** `socialLinks Json?` كما يصل (مصفوفة `{platform, url}`) ⇒ مصفوفة نظيفة؛ غير ذلك ⇒ [] */
export function socialLinksOf(v: unknown): SocialLink[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is { platform?: unknown; url?: unknown } => !!x && typeof x === 'object')
    .map((x) => ({ platform: typeof x.platform === 'string' ? x.platform : 'other', url: typeof x.url === 'string' ? x.url : '' }))
    .filter((x) => x.url.trim() !== '');
}

/** حجم ملفٍ مقروء: «812 بايت» · «1.4 ك.ب» · «3.2 م.ب» */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) < 0) return '—';
  const b = Math.trunc(Number(n));
  if (b < 1024) return `${b} بايت`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1).replace(/\.0$/, '')} ك.ب`;
  return `${(b / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} م.ب`;
}

/**
 * معاينة مستند الهوية/السجل (`GET /affiliates/:id/documents/:kind` ⇒ `{dataUrl}`): الأنواع
 * الأربعة المفحوصة في الخادم وحدها (V2_SPEC §3) — أي نوعٍ آخر (svg/html…) لا يُعرض في اللوحة.
 */
export const DOC_PREVIEW_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export function documentPreview(dataUrl: string | null | undefined): { kind: 'image' | 'pdf'; mime: string } | null {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i.exec(String(dataUrl ?? ''));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!(DOC_PREVIEW_MIMES as readonly string[]).includes(mime)) return null;
  return { kind: mime === 'application/pdf' ? 'pdf' : 'image', mime };
}

/** data URL ‏base64 ⇒ بايتات (لـBlob ورابط blob: — Chrome يمنع data: لملفات PDF في الإطارات) */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const i = dataUrl.indexOf(';base64,');
  if (i < 0) return null;
  try {
    const bin = atob(dataUrl.slice(i + 8));
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  } catch {
    return null;
  }
}

// ─── دورة التسوية (v2: كل ١٠ أيام — 1 و11 و21 منتصف الليل بتوقيت الرياض) ─────

export const SETTLEMENT_DAYS = [1, 11, 21] as const;

/**
 * يوم نهاية الدورة القادمة بيوم الرياض — احتياطٌ للعرض فقط حين لا يصل `nextSettlementAt`
 * من الخادم (مصدر الحقيقة `services/affiliate/settlement.ts`). اليوم الذي بلغ منتصف ليله
 * لا يُعدّ قادماً: لحظة 00:00 من يوم 11 دورتها القادمة 21.
 */
export function nextSettlementDayKey(at: Date | number = Date.now()): string {
  const today = riyadhDayKey(at);
  const [y, m, d] = today.split('-').map(Number);
  const p = (n: number) => String(n).padStart(2, '0');
  const next = SETTLEMENT_DAYS.find((x) => x > d);
  if (next) return `${y}-${p(m)}-${p(next)}`;
  return m === 12 ? `${y + 1}-01-01` : `${y}-${p(m + 1)}-01`;
}

/** يوم الرياض قبل يومٍ معطى ('YYYY-MM-DD') */
function prevDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  const dt = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * فترة دفعة الدورة كأيامٍ شاملة: `periodStart` نهاية الدورة السابقة و`periodEnd` نهاية هذه
 * (منتصف ليل الرياض — حصريّة)، فدورة `2026-11-11` تغطّي ١ ← ١٠ نوفمبر لا ١ ← ١١.
 * دفعةٌ يدوية بلا فترة ⇒ null.
 */
export function payoutPeriod(p: { periodStart?: string | null; periodEnd?: string | null; cycleKey?: string | null }): { from: string; to: string } | null {
  const endKey = dayKeyOf(p.periodEnd) ?? (p.cycleKey && isIsoDay(p.cycleKey) ? p.cycleKey : null);
  const from = dayKeyOf(p.periodStart);
  if (!endKey || !from) return null;
  const to = prevDayKey(endKey);
  return to < from ? { from, to: from } : { from, to };
}

export const FAIL_REASON_MIN = 3;
export const FAIL_REASON_MAX = 300;
/** سبب «فشل التحويل» — `POST /payouts/:id/fail {reason 3..300}` ويصل السفيرَ في بريده */
export function validateFailReason(reason: string): string | null {
  const n = reason.trim().length;
  if (n < FAIL_REASON_MIN) return `اكتب سبب الفشل (${FAIL_REASON_MIN} أحرف على الأقل)`;
  if (n > FAIL_REASON_MAX) return `سبب الفشل ${FAIL_REASON_MAX} حرف كحدّ أقصى`;
  return null;
}

/** «١٠ أيام» · «٣٠ يوماً» · «يوم واحد» — عدد الأيام بتمييزه العربي (أرقام لاتينية كبقية اللوحة) */
export function daysText(n: number): string {
  const d = Math.trunc(Number(n) || 0);
  if (d === 1) return 'يوم واحد';
  if (d === 2) return 'يومان';
  if (d >= 3 && d <= 10) return `${d} أيام`;
  return `${d} يوماً`;
}

/**
 * ملاحظة تبويب العمولات: الاعتماد تلقائيّ خلال نحو ساعةٍ من انتهاء الحجز (نبضة المجدول كلّ ساعة — لا دورة
 * التسوية)، ويبقى اليدوي، والإيقاف للمعلّقة والمعتمدة ما لم تدخل مسودّة دفعة.
 */
export function autoApproveNote(holdDays?: number | null): string {
  const hold = typeof holdDays === 'number' && Number.isFinite(holdDays) ? daysText(holdDays) : daysText(10);
  return `تُعتمد العمولة تلقائياً خلال نحو ساعة من انتهاء فترة حجزها (${hold} في الشروط الحالية) ما لم تكن موقوفة — ويبقى لك الاعتماد اليدوي متى انتهى الحجز، والإيقاف ما لم تدخل مسودّة دفعة`;
}

/**
 * ردّ `POST /settlement/run` (API.md §2): دورة آخر نهايةٍ مرّت بمفتاحها نفسه — آمنةٌ للتكرار، فتشغيلها
 * ثانيةً يلتقط من صار مؤهَّلاً بعد مرورها ويتخطّى من دُفع له فيها (`skipped.cycle_done`). تنشئ مسودّات فقط.
 */
export interface SettlementRunResult {
  cycleKey?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  ran?: boolean | null;
  /** `already_ran`: أُنجزت أو تجري الآن في نسخةٍ أخرى (للمجدول — الزرّ اليدوي يمرّ دائماً) */
  reason?: string | null;
  manual?: boolean | null;
  autoApproved?: number | null;
  payouts?: Array<{ id: string; affiliateId: string; netHalalas: number }> | number | null;
  totalHalalas?: number | null;
  skipped?: Record<string, number> | null;
  nextSettlementAt?: string | null;
}

const countOf = (v: unknown): number | null => (Array.isArray(v) ? v.length : typeof v === 'number' && Number.isFinite(v) ? v : null);

/** «دفعة واحدة» · «دفعتان» · «3 دفعات» · «11 دفعة» */
export function payoutsCountText(n: number): string {
  const k = Math.trunc(Number(n) || 0);
  if (k === 1) return 'دفعة واحدة';
  if (k === 2) return 'دفعتان';
  if (k >= 3 && k <= 10) return `${k} دفعات`;
  return `${k} دفعة`;
}

/** «ملفه غير مكتمل: 2 · لم يُدخل آيبان بعد: 1» — ما تخطّته الدورة بأسبابه (عدا ما دون الحدّ: يُرحَّل بصمت) */
export function skippedText(skipped: Record<string, number> | null | undefined): string {
  if (!skipped || typeof skipped !== 'object') return '';
  return Object.entries(skipped)
    .filter(([k, n]) => k !== 'below_min' && typeof n === 'number' && n > 0)
    .map(([k, n]) => `${labelOf(SETTLEMENT_SKIP_LABEL, k)}: ${n}`)
    .join(' · ');
}

/** رسالة تشغيل الدورة يدوياً: ما أُنشئ ومجموعه، وما اعتُمد تلقائياً، ومن تُخطّي ولماذا */
export function settlementRunMessage(r: SettlementRunResult | null | undefined): OutcomeMessage {
  const cycle = r?.cycleKey ? ` (${r.cycleKey})` : '';
  if (r?.ran === false) {
    return { text: `دورة التسوية${cycle} أُنجزت أو تجري الآن — لا دفعات جديدة. أعد المحاولة بعد دقائق أو أنشئ دفعةً يدوية من «المرشّحون للصرف»`, warn: true };
  }
  // الخادم يعدّ ما اعتمده النظام منذ الدورة السابقة (لا ما اعتمده هذا التشغيل وحده)
  const auto = typeof r?.autoApproved === 'number' && r.autoApproved > 0 ? ` · اعتُمدت تلقائياً ${r.autoApproved} عمولة منذ الدورة السابقة` : '';
  const skip = skippedText(r?.skipped);
  const skipPart = skip ? ` · تُخطّي: ${skip}` : '';
  const n = countOf(r?.payouts);
  if (n === null) return { text: `شُغّلت دورة التسوية${cycle}${auto}${skipPart}`, warn: false };
  if (n === 0) return { text: `شُغّلت دورة التسوية${cycle} — لا دفعات جديدة (لا سفير مؤهَّل: الحدّ الأدنى والملف المكتمل والآيبان)${auto}${skipPart}`, warn: false };
  const total = typeof r?.totalHalalas === 'number' ? ` بمجموع ${formatHalalas(r.totalHalalas)}` : '';
  return { text: `شُغّلت دورة التسوية${cycle} — أُنشئت ${payoutsCountText(n)}${total}. حوّلها من بنكك ثم سجّل كل تحويل${auto}${skipPart}`, warn: false };
}

/** «آخر دورة 2026-11-11: 3 دفعات بمجموع X» لبطاقة النظرة العامة والصرف — `ranAt: null` بلا دفعات = لم تُنجز بعد */
export function lastCycleText(c: { cycleKey?: string | null; payouts?: number | null; totalHalalas?: number | null; ranAt?: string | null } | null | undefined): string {
  if (!c || !c.cycleKey) return 'لم تُشغَّل دورة بعد';
  const n = Math.trunc(Number(c.payouts) || 0);
  if (c.ranAt === null && n === 0) return `آخر دورة ${c.cycleKey}: لم تُنجز بعد`;
  return `آخر دورة ${c.cycleKey}: ${payoutsCountText(n)} بمجموع ${formatHalalas(Number(c.totalHalalas) || 0)}`;
}

/** يوم التسوية القادمة للعرض: من الخادم (`nextSettlementAt` لحظة منتصف ليل الرياض) وإلا الحساب المحلي */
export function nextSettlementKey(nextSettlementAt: string | null | undefined, now: Date | number = Date.now()): string {
  return dayKeyOf(nextSettlementAt) ?? nextSettlementDayKey(now);
}

// ─── المطالبات الفائتة (v2) ─────────────────────────────────────────────────

/** القبول والرفض لما تحت المراجعة وحده — المقبولة والمرفوضة والمسحوبة نهائية */
export function missedClaimActions(c: { status: string }): { accept: boolean; reject: boolean } {
  const open = c.status === 'under_review';
  return { accept: open, reject: open };
}

export const MISSED_ACCEPT_REASON_MAX = 500;
/** قبول مطالبة: شركةٌ مختارة وسببٌ يُحفظ في السجلّ (`POST /missed-claims/:id/accept {tenantId, reason 3..500}`) */
export function validateMissedAccept(tenantId: string | null | undefined, reason: string): string | null {
  if (!tenantId) return 'اختر الشركة التي سجّلت';
  const r = validateReason(reason);
  if (r) return r;
  if (reason.trim().length > MISSED_ACCEPT_REASON_MAX) return `السبب ${MISSED_ACCEPT_REASON_MAX} حرف كحدّ أقصى`;
  return null;
}

/**
 * أيامٌ من تسجيل الشركة حتى تقديم المطالبة — بالقاعدة الواحدة في الخادم (missedClaims.ts: `missedClaimDays`
 * = `floor((submittedAt − createdAt)/يوم)`، وبها يحكم القائمة **والقبول** `claim_late`) لشركةٍ اختارها المالك
 * بالبحث (الاقتراحات تحملها جاهزة `daysFromSignup`). غير الصالح ⇒ null.
 */
export function daysFromSignup(submittedAt: string | null | undefined, tenantCreatedAt: string | null | undefined): number | null {
  const a = Date.parse(String(submittedAt ?? ''));
  const b = Date.parse(String(tenantCreatedAt ?? ''));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((a - b) / 86_400_000);
}

/**
 * شارة مهلة المطالبة: داخل ٣٠ يوماً من تسجيل الشركة أو خارجها — `days ≤ 30` كما `withinMissedClaimWindow` في
 * الخادم (اليوم الثلاثون بساعاته داخلها)، فما تعرضه «داخل المهلة» يقبله الخادم وما تعرضه خارجها يرفضه بـ`claim_late`.
 */
export function missedWindowLabel(days: number | null | undefined, withinWindow?: boolean | null): Label | null {
  if (typeof days !== 'number' || !Number.isFinite(days)) return null;
  if (days < 0) return { label: 'قُدّمت قبل تسجيل الشركة', tone: 'green' };
  const inside = typeof withinWindow === 'boolean' ? withinWindow : days <= MISSED_CLAIM_WINDOW_DAYS;
  if (inside) return { label: `بعد ${daysText(days)} من تسجيلها — داخل المهلة`, tone: 'green' };
  return { label: `بعد ${daysText(days)} من تسجيلها — خارج مهلة ${MISSED_CLAIM_WINDOW_DAYS} يوماً`, tone: 'red' };
}

/** رسالة قبول المطالبة: الإسناد الناشئ وأثره على العمولة (أُنشئت أو سبب عدم إنشائها) */
export function missedAcceptMessage(companyName: string, tenantName: string, affiliateName: string, r: AccrualResult | null | undefined): OutcomeMessage {
  return withAccrual(`قُبلت مطالبة «${companyName}» — أُسندت ${tenantName} إلى ${affiliateName}`, r);
}

// ─── المواد التسويقية (v2) ──────────────────────────────────────────────────

/** ملف المادة ≤ ٨ ميغابايت (V2_SPEC §6.2) — يُفحص هنا قبل قراءته base64 فلا يُرسل ما سيُرفض */
export const MATERIAL_MAX_BYTES = 8 * 1024 * 1024;
/**
 * حدّ جسم JSON العامّ في الخادم (`express.json({ limit: '10mb' })` = 10×1024×1024 بايت). الملف يُرسل
 * data URL ‏base64 (+٣٣٪)، فأكبر ملفٍ يمرّ فعلاً ≈ ٧٫٥ ميغابايت — ما فوقه يُرفض 413 قبل المسار برسالةٍ غير عربية.
 */
export const JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const MATERIAL_TITLE_MIN = 2;
export const MATERIAL_TITLE_MAX = 120;
export const MATERIAL_TEXT_MAX = 4000;
export const MATERIAL_URL_MAX = 500;

export type MaterialNeed = 'required' | 'optional' | 'none';
/**
 * ما تحتاجه كل فئة (مطابق لـ`services/affiliate/materials.ts`): الصورة والمستند **ملفٌّ** إلزاماً، والفيديو
 * ملفٌّ قصير **أو** رابط (واحدٌ منهما)، والرابط رابط، والنصّ نصّ؛ ونصٌّ مرافقٌ مسموحٌ مع أيّ فئة.
 */
export function materialNeeds(category: string): { file: MaterialNeed; url: MaterialNeed; text: MaterialNeed } | null {
  switch (category) {
    case 'image':
    case 'document': return { file: 'required', url: 'none', text: 'optional' };
    case 'video': return { file: 'optional', url: 'optional', text: 'optional' };
    case 'link': return { file: 'none', url: 'required', text: 'optional' };
    case 'text': return { file: 'none', url: 'none', text: 'required' };
    default: return null;
  }
}

/** ما يقبله حقل الملف لكل فئة (تلميحٌ للمتصفّح — الخادم يفحص البايتات) */
export const MATERIAL_ACCEPT: Record<'image' | 'video' | 'document', string> = {
  image: 'image/jpeg,image/png,image/webp,image/gif',
  video: 'video/mp4,video/webm,video/quicktime',
  document: 'application/pdf',
};

/** طول نصٍّ بترميز UTF-8 (العربية بايتان للحرف) — لتقدير حجم جسم الطلب */
function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** تقدير حجم جسم `POST /materials` بالبايت: base64 الملف + بادئة data URL + الحقول (بهامش للهروب) + هامش JSON */
export function materialBodyBytes(fileSize: number, title: string, textBody: string, fileName = ''): number {
  const b64 = Math.ceil(Math.max(0, fileSize) / 3) * 4;
  return b64 + 64 + utf8Length(title) + utf8Length(textBody) * 2 + utf8Length(fileName) + 256;
}

export interface MaterialFileMeta { name: string; size: number; type: string }
export interface MaterialForm {
  title: string;
  category: MaterialCategory | '';
  url: string;
  textBody: string;
  file: MaterialFileMeta | null;
}

export function validateMaterial(f: MaterialForm): string | null {
  const title = f.title.trim();
  if (title.length < MATERIAL_TITLE_MIN) return `اكتب عنوان المادة (${MATERIAL_TITLE_MIN} أحرف على الأقل)`;
  if (title.length > MATERIAL_TITLE_MAX) return `العنوان ${MATERIAL_TITLE_MAX} حرفاً كحدّ أقصى`;
  const need = materialNeeds(f.category);
  if (!need) return 'اختر فئة المادة';
  const file = need.file === 'none' ? null : f.file;
  const url = need.url === 'none' ? '' : f.url.trim();
  const text = f.textBody.trim();

  if (need.file === 'required' && !file) return 'اختر الملف';
  if (f.category === 'video' && !file === !url) return 'الفيديو ملفٌّ قصير أو رابط — واحدٌ منهما';
  if (file) {
    if (file.size <= 0) return 'الملف فارغ';
    if (file.size > MATERIAL_MAX_BYTES) return `حجم الملف ${formatBytes(file.size)} — الحدّ الأقصى ٨ ميغابايت`;
    if (materialBodyBytes(file.size, title, text, file.name) > JSON_BODY_LIMIT_BYTES) {
      return `حجم الملف ${formatBytes(file.size)} أكبر ممّا يُرفع من اللوحة (≈ ٧٫٥ ميغابايت بعد الترميز) — اضغطه أو أضفه رابطاً`;
    }
    const type = (file.type || '').toLowerCase();
    if (type && f.category === 'image' && !type.startsWith('image/')) return 'الملف ليس صورة — اختر فئةً تناسبه';
    if (type && f.category === 'video' && !type.startsWith('video/')) return 'الملف ليس فيديو — اختر فئةً تناسبه';
    if (type && f.category === 'document' && type !== 'application/pdf') return 'المستند ملف PDF — اختر فئةً تناسبه';
  }
  if (need.url === 'required' && !url) return 'اكتب الرابط';
  if (url) {
    if (url.length > MATERIAL_URL_MAX) return `الرابط ${MATERIAL_URL_MAX} حرف كحدّ أقصى`;
    if (!safeHttpUrl(url)) return 'الرابط يبدأ بـ https:// أو http://';
  }
  if (need.text === 'required' && !text) return 'اكتب النصّ الجاهز';
  if (text.length > MATERIAL_TEXT_MAX) return `النصّ ${MATERIAL_TEXT_MAX} حرف كحدّ أقصى`;
  return null;
}

/** جسم `POST /materials` — حقول المصدر الموافقة للفئة وحدها (`dataUrl` يقرؤه المكوّن من الملف) */
export interface MaterialBody { title: string; category: MaterialCategory; dataUrl?: string; fileName?: string; url?: string; textBody?: string }
export function buildMaterialBody(f: MaterialForm, dataUrl?: string | null): MaterialBody {
  const category = f.category as MaterialCategory;
  const body: MaterialBody = { title: f.title.trim(), category };
  const need = materialNeeds(category);
  if (need && need.file !== 'none' && dataUrl) {
    body.dataUrl = dataUrl;
    if (f.file?.name) body.fileName = f.file.name.slice(0, 200);
  }
  const url = f.url.trim();
  if (need && need.url !== 'none' && url && !body.dataUrl) body.url = url;
  const text = f.textBody.trim();
  if (text) body.textBody = text;
  return body;
}

// ─── أشكال الردود (API.md §2) ──────────────────────────────────────────────

export interface AffRef { id: string; fullName: string; code: string }

/** آخر دورةٍ انتهت: دفعاتها عدا الملغاة، و`ranAt: null` = لم تُنجز بعد (المجدول لم يمرّ أو يجري الآن) */
export interface LastCycle { cycleKey: string; payouts: number; totalHalalas: number; ranAt: string | null }

/**
 * `GET /overview` — v2 يضيف السفراء الجدد هذا الأسبوع والملفات الناقصة والمطالبات الفائتة
 * والتسوية القادمة وآخر دورة، ويحذف `pending_review` من البطاقات (يبقى اختيارياً للإرث).
 */
export interface Overview {
  affiliates: { pending_review?: number; approved: number; suspended: number; total: number };
  claimsUnderReview: number;
  attributions: { active: number; disputed: number };
  commissions: { pendingHalalas: number; onHoldHalalas: number; readyToApprove: number; approvedUnpaidHalalas: number; paidHalalas: number };
  payoutCandidates: number;
  newAffiliates7d: number;
  incompleteProfiles: number;
  missedClaimsUnderReview: number;
  /** ISO لنهاية الدورة القادمة (منتصف ليل الرياض) */
  nextSettlementAt: string | null;
  settlementDays?: number[];
  settlementEveryDays?: number;
  lastCycle: LastCycle | null;
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
  /** v2 — عمودا «النوع» و«الملف» (اختيارية: خادمٌ أقدم لا يرسلها فيُعرض «—») */
  partnerType?: PartnerType | null;
  companyName?: string | null;
  profileComplete?: boolean | null;
  missing?: string[] | null;
}

export interface AffiliateDocumentMeta { kind: DocKind | string; mime: string; sizeBytes: number; createdAt: string }

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
    /** v2 (V2_SPEC §6.2): روابط التواصل وبيانات المستندات بلا محتواها — المحتوى بطلبٍ مستقلّ يُسجَّل */
    socialLinks?: SocialLink[];
    documents?: AffiliateDocumentMeta[];
    profileCompletedAt?: string | null;
  };
  claims: Array<Partial<ClaimRow> & { id: string }>;
  attributions: Array<Partial<AttributionRow> & { id: string; tenantNameSnapshot?: string }>;
  commissions: Array<Partial<CommissionRow> & { id: string; tenantNameSnapshot?: string }>;
  adjustments: Array<{ id: string; kind?: string; amountHalalas?: number; note?: string | null; createdAt?: string; payoutId?: string | null; settled?: boolean; inDraft?: boolean }>;
  payouts: Array<Partial<PayoutRow> & { id: string }>;
  /** v2: مطالباته بإحالاتٍ فائتة (صفوف خام) */
  missedClaims?: Array<Partial<MissedClaimRow> & { id: string }>;
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
  /** لصفوف `portal`: هل فعّل مسؤول الشركة حسابه؟ null لغيرها (وغائبٌ من خادمٍ أقدم) */
  activation?: ActivationState | null;
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
  /** v2: الملف المكتمل شرطٌ لدخول دورة التسوية (اختياري — يغيب في خادمٍ أقدم) */
  profileComplete?: boolean | null;
  /** v2: سبب الحجب (null = مؤهَّل) والحدّ الأدنى من شروط السفير نفسه وما ينقص ملفه */
  blockedBy?: PayoutBlock | null;
  minPayoutHalalas?: number;
  missing?: string[];
  /** فشل آخر تحويلٍ ولم يحدّث السفير بيانات استلامه بعده */
  ibanNeedsUpdate?: boolean;
}

export interface PayoutRow {
  id: string; affiliate: AffRef; commissionsHalalas: number; adjustmentsHalalas: number; netHalalas: number;
  status: PayoutStatus; ibanLast4: string; holderName: string; transferredAt: string | null;
  bankReference: string | null; createdAt: string; voidReason: string | null; commissionCount: number;
  /** v2: دفعة الدورة (`createdBy='system'`) تحمل مفتاحها وفترتها؛ اليدوية بلا فترة */
  cycleKey?: string | null; periodStart?: string | null; periodEnd?: string | null;
  failedReason?: string | null; failedAt?: string | null; createdBy?: string | null;
}

/** `GET /missed-claims?status` — مطالبة السفير بشركةٍ سجّلت دون رمزه، مع اقتراحات مطابقة */
export interface MissedClaimRow {
  id: string; affiliate: AffRef; companyName: string; contactPhone: string | null; crNumber: string | null;
  note: string | null; status: MissedClaimStatus; reasonNote: string | null; submittedAt: string; reviewedAt: string | null;
  reviewedBy?: string | null; tenantId?: string | null; tenantName?: string | null;
  /** لما تحت المراجعة وحده — مطابقة بالسجل ثمّ الجوال ثمّ الاسم، وأيامٌ من تسجيل الشركة حتى المطالبة */
  suggestions: Array<{
    tenantId: string; tenantName: string; match: MissedMatch | string; createdAt?: string | null; attributed?: boolean | null;
    daysFromSignup?: number | null; withinWindow?: boolean | null;
  }>;
}

/** ردّ `POST /missed-claims/:id/accept` — إسنادٌ يدويّ ثمّ المطالبة `accepted` */
export interface MissedAcceptResult extends AccrualResult {
  status: 'accepted';
  attribution?: { id: string; status: AttributionStatus };
  commission?: { id: string; status: CommissionStatus; commissionHalalas?: number } | null;
}

/** `GET /materials` — المحتوى نفسه لا يعود في القائمة */
export interface MaterialRow {
  id: string; title: string; category: MaterialCategory; fileName: string | null; mime: string | null;
  sizeBytes: number | null; url: string | null; textBody: string | null; sortOrder?: number; createdAt: string; createdBy?: string | null;
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

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** أرقام v2 الغائبة (خادمٌ أقدم أثناء النشر) تصير أصفاراً، والتسوية القادمة/آخر دورة null */
export function normalizeOverview(o: Partial<Overview> & Pick<Overview, 'affiliates' | 'attributions' | 'commissions'>): Overview {
  const lc = o.lastCycle;
  return {
    ...o,
    claimsUnderReview: num(o.claimsUnderReview),
    payoutCandidates: num(o.payoutCandidates),
    newAffiliates7d: num(o.newAffiliates7d),
    incompleteProfiles: num(o.incompleteProfiles),
    missedClaimsUnderReview: num(o.missedClaimsUnderReview),
    nextSettlementAt: typeof o.nextSettlementAt === 'string' && o.nextSettlementAt ? o.nextSettlementAt : null,
    lastCycle: lc && typeof lc === 'object' && lc.cycleKey
      ? { cycleKey: lc.cycleKey, payouts: num(lc.payouts), totalHalalas: num(lc.totalHalalas), ranAt: typeof lc.ranAt === 'string' ? lc.ranAt : null }
      : null,
  } as Overview;
}

/**
 * تفصيل السفير: v2 يضيف حقول الملف — تُقرأ من `affiliate` أولاً ثم من جذر الردّ
 * (المواصفة تقول «يضيف» دون تعيين الموضع)، والمستندات والروابط الغائبة تصير فارغة.
 */
export function normalizeDetail(d: AffiliateDetail): AffiliateDetail {
  const root = d as AffiliateDetail & Partial<Pick<AffiliateRow, 'partnerType' | 'companyName' | 'profileComplete' | 'missing'>> & { documents?: unknown; socialLinks?: unknown };
  const a = d.affiliate;
  return {
    ...d,
    affiliate: a ? {
      ...a,
      partnerType: a.partnerType ?? root.partnerType ?? null,
      companyName: a.companyName ?? root.companyName ?? null,
      profileComplete: a.profileComplete ?? root.profileComplete ?? null,
      missing: arr((a.missing ?? root.missing) as string[] | null | undefined),
      socialLinks: socialLinksOf(a.socialLinks ?? root.socialLinks),
      documents: arr((a.documents ?? root.documents) as AffiliateDocumentMeta[] | null | undefined),
    } : a,
    claims: arr(d.claims),
    attributions: arr(d.attributions),
    commissions: arr(d.commissions),
    adjustments: arr(d.adjustments),
    payouts: arr(d.payouts),
    missedClaims: arr(d.missedClaims),
    events: arr(d.events),
  };
}

export function normalizeClaims(list: ClaimRow[]): ClaimRow[] {
  return arr(list).map((c) => ({ ...c, conflicts: arr(c.conflicts), suggestions: arr(c.suggestions) }));
}

export function normalizeAttributions(list: AttributionRow[]): AttributionRow[] {
  return arr(list).map((a) => ({ ...a, flags: arr(a.flags) }));
}

export function normalizeMissedClaims(list: MissedClaimRow[]): MissedClaimRow[] {
  return arr(list).map((c) => ({ ...c, suggestions: arr(c.suggestions) }));
}
