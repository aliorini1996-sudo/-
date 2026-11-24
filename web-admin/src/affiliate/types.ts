// ============================================================================
// أنواع بوابة «سفير فيلد سيلز» — منسوخة من docs/affiliate/API.md §1 ومن
// docs/affiliate/V2_SPEC.md §3 و§6.1 (الإصدار الثاني — قرار المالك ١٨ نوفمبر ٢٠٢٦).
// لا تُوسَّع هنا: الخادم يُكتب بالتوازي على المواصفة نفسها، وأي حقلٍ مُخترَع
// في الواجهة كذبةٌ على المستخدم حين لا يرسله الخادم.
// ============================================================================

/**
 * `pending_email`/`pending_review` إرثٌ فقط (V2_SPEC §3): التسجيل يُنشئ `approved` مباشرةً،
 * والإرث يُرقّى عند الإقلاع وعند أيّ دخولٍ ناجح.
 */
export type UserStatus = 'pending_email' | 'pending_review' | 'approved' | 'rejected' | 'suspended';
export type ClaimStatus = 'under_review' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'converted';
export type AttributionStatus = 'active' | 'disputed' | 'void';
export type CommissionStatus = 'pending' | 'on_hold' | 'approved' | 'paid' | 'reversed' | 'declined';
/** للسفير: قيد المعالجة · مدفوعة · ملغاة (لا تُعاد له) · فشل التحويل (V2_SPEC §3) */
export type PayoutStatus = 'draft' | 'recorded' | 'void' | 'failed';
/** نوع السفير — يُختار عند التسجيل ويُعدَّل من «ملفي» */
export type PartnerType = 'individual' | 'company' | 'influencer';
export type SocialPlatform = 'x' | 'instagram' | 'snapchat' | 'tiktok' | 'youtube' | 'linkedin' | 'website' | 'other';
/** مستندات الملف: الهوية/الإقامة، والسجل التجاري للشركة */
export type DocKind = 'national_id' | 'commercial_reg';
/** ما ينقص الملف لدخول دورة التسوية */
export type ProfileMissing = 'partnerType' | 'iban' | 'national_id' | 'commercial_reg';
export type MissedClaimStatus = 'under_review' | 'accepted' | 'rejected' | 'withdrawn';
export type MaterialCategory = 'image' | 'video' | 'document' | 'text' | 'link';
export type ClaimHow = 'visit' | 'relationship' | 'event' | 'online' | 'other';
export type CompanyStatus = 'trial' | 'paid' | 'disputed' | 'void' | 'expired';
/** `portal` = حسابٌ تجريبيّ فتحه السفير من البوابة لشركةٍ طلبته (يُفعّله مسؤولها من بريده) */
export type CompanySource = 'signup_code' | 'claim' | 'owner' | 'portal';
/** حالة تفعيل حساب الشركة — لصفوف `portal` وحدها، وnull لغيرها */
export type ActivationStatus = 'pending' | 'active';
export type AdjustmentKind = 'clawback_refund' | 'correction';

export interface PublicTerms {
  version: string;
  body: string;
  disclosureText: string;
  rateBps: number;
  holdDays: number;
  minPayoutHalalas: number;
  /** نافذة الإسناد بالأيام (1..365) — صفحة تسجيل الشركات تُسقط رمز رابطٍ أقدم منها */
  refWindowDays: number;
  intakeOpen: boolean;
  /** اختياريّ — غيابه ⇒ 10 (format.SETTLEMENT_EVERY_DAYS) */
  settlementEveryDays?: number;
}

/** رابط تواصل في الملف: منصّة + رابط `https?://` ≤300 (حتى ٨) */
export interface SocialLink {
  platform: SocialPlatform;
  url: string;
}

/**
 * جسم POST /register (V2_SPEC §6.1) — الانضمام فوريّ: 201 `{ token, user }`.
 * المدينة والرقم الضريبي خرجا من التسجيل إلى «ملفي» (بطاقةٌ واحدة كتسجيل الشركات).
 */
export interface RegisterBody {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  partnerType: PartnerType;
  /** إلزاميّ حين partnerType = 'company' (2..120) */
  companyName?: string;
  socialLinks?: SocialLink[];
  marketingConsent?: boolean;
  acceptTerms: true;
  termsVersion: string;
}

/** مستندٌ رُفع — بلا محتواه (المعاينة بطلبٍ منفصل) */
export interface AffiliateDocument {
  kind: DocKind;
  mime: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AffiliateMe {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  city: string | null;
  code: string;
  status: UserStatus;
  statusReason: string | null;
  /** حقول قديمة قد يُرسلها الخادم — لم تعد البوابة تعرضها ولا تطلبها */
  publicPromoter?: boolean;
  mawthooqNo?: string | null;
  mawthooqExpiry?: string | null;
  vatNumber: string | null;
  marketingConsent: boolean;
  termsVersion: string;
  payout: { holderName: string; bankName: string | null; ibanLast4: string; updatedAt: string } | null;
  createdAt: string;
  // ─── v2 (V2_SPEC §6.1 GET /me) ───
  partnerType: PartnerType | null;
  companyName: string | null;
  socialLinks: SocialLink[] | null;
  documents: AffiliateDocument[];
  /** الملف مكتمل = شرط دخول دورة التسوية فقط (لا يحجب الحساب) */
  profileComplete: boolean;
  missing: ProfileMissing[];
}

export interface MeSettings {
  disclosureText: string;
  rateBps: number;
  holdDays: number;
  minPayoutHalalas: number;
  currentTermsVersion: string;
  /** مفتاح «افتح حساباً تجريبياً» (AX_PORTAL_TRIAL_ENABLED) — والواجهة تقرأ غيابه (خادمٌ أقدم) مطفأً */
  portalTrialEnabled: boolean;
  /** نهاية دورة التسوية القادمة (أيام 1 و11 و21 منتصف ليل الرياض) — ISO */
  nextSettlementAt: string | null;
  /** طول دورة التسوية بالأيام (10) */
  settlementEveryDays: number;
}

export interface MeResponse {
  user: AffiliateMe;
  settings: MeSettings;
  /** `https://fieldsa.net/signup?ref=CODE` — رابطٌ مباشر لصفحة تسجيل الشركات */
  link: string;
  /** إرث v1 — نموذج الحساب البنكي متاحٌ دائماً في v2 فلا تقرؤه الواجهة */
  canSetPayout?: boolean;
}

export interface UpdateMeBody {
  city?: string;
  marketingConsent?: boolean;
  vatNumber?: string;
  partnerType?: PartnerType;
  /** `''` يمسح الحقل */
  companyName?: string;
  socialLinks?: SocialLink[];
}

export interface Dashboard {
  clicks30d: number;
  signups: number;
  paidCompanies: number;
  pendingHalalas: number;
  approvedHalalas: number;
  paidHalalas: number;
  /** التسويات **غير المُسوّاة** فقط — ما سيدخل دفعتك القادمة */
  adjustmentsHalalas: number;
  // ─── v2 (V2_SPEC §6.1 GET /dashboard) ───
  /** المعتمدة + المدفوعة صافياً */
  totalEarnedHalalas: number;
  /** معتمدةٌ بلا دفعة + ما في دفعة قيد المعالجة */
  pendingSettlementHalalas: number;
  /** إسناداتٌ سارية */
  activeReferrals: number;
  /** paidCompanies / signups (كسرٌ 0..1) أو null حين لا تسجيلات */
  conversionRate: number | null;
  /** آخر ٦ أشهر بتاريخ الدفعة */
  earningsByMonth: Array<{ month: string; halalas: number }>;
  nextSettlementAt: string | null;
  steps: { account: boolean; shared: boolean; firstPaid: boolean };
}

export interface CompanyRow {
  id: string;
  tenantName: string;
  source: CompanySource;
  status: CompanyStatus;
  signedUpAt: string;
  firstPaymentDeadline: string;
  firstPaidAt: string | null;
  commission: { status: CommissionStatus; commissionHalalas: number; eligibleAt: string } | null;
  /** لصفوف `portal`: هل اختار مسؤول الشركة كلمة مروره من رابط بريده؟ null لغيرها (أو خادمٍ أقدم) */
  activation: ActivationStatus | null;
  /**
   * اختياريّ: لمصدر `signup_code` — هل سجّلت المنشأة **بالرابط** أم **كتبت الرمز**؟ (من
   * `TenantAttribution.refVia`). غيابه (خادمٌ لا يرسله) ⇒ «رابط أو رمز» بلا تخمين.
   */
  refVia?: 'link' | 'typed' | null;
}

/**
 * جسم POST /trials — حسابٌ تجريبيّ يفتحه السفير لشركةٍ طلبته. **لا كلمة مرور**: مسؤول الشركة
 * يختارها بنفسه من رابطٍ يصل بريده وحده، والسفير لا يرى الرابط ولا كلمة المرور أبداً.
 */
export interface TrialBody {
  companyName: string;
  adminName: string;
  adminEmail: string;
  /** جوال المسؤول دولياً `+<مفتاح><الرقم>` */
  adminPhone: string;
  countryCode?: string;
  crNumber?: string | null;
  /** إقرار السفير بأن الشركة طلبت الحساب ووافقت على بريد التفعيل — إلزاميّ */
  consent: true;
  /** فحص البوابات كلها بلا كتابة (للتحقّق الحيّ دون إنشاء شركة) */
  dryRun?: boolean;
}

export interface ClaimBody {
  companyName: string;
  crNumber: string;
  city?: string;
  /** إلزامي — جوال أو هاتف المنشأة أو المسؤول (≤30) */
  contactPhone: string;
  how: ClaimHow;
  note?: string;
}

export interface ClaimRow {
  id: string;
  companyName: string;
  crNumber: string;
  city: string | null;
  /** null للترشيحات الأقدم من الخانة */
  contactPhone?: string | null;
  how: ClaimHow;
  status: ClaimStatus;
  lockedUntil: string | null;
  submittedAt: string;
}

export interface CommissionRow {
  id: string;
  tenantName: string;
  paymentAmountHalalas: number;
  /** استردادٌ جزئيّ مؤكَّد — العمولة على (الدفعة − المستردّ) */
  refundedHalalas?: number;
  commissionHalalas: number;
  rateBps: number;
  status: CommissionStatus;
  paymentPaidAt: string;
  eligibleAt: string;
  reasonNote: string | null;
  paidAt: string | null;
}

export interface AdjustmentRow {
  id: string;
  kind: AdjustmentKind;
  amountHalalas: number;
  note: string | null;
  createdAt: string;
  settled: boolean;
}

/**
 * دفعة تسوية (V2_SPEC §6.1 GET /payouts) — كل دفعات السفير عدا الملغاة: قيد المعالجة
 * (`draft`)، مدفوعة (`recorded`)، فشل التحويل (`failed` + السبب).
 */
export interface PayoutRow {
  id: string;
  netHalalas: number;
  commissionsHalalas: number;
  adjustmentsHalalas: number;
  status: PayoutStatus;
  /** حدود الدورة — null لدفعةٍ يدوية من قبل v2 */
  periodStart: string | null;
  periodEnd: string | null;
  transferredAt: string | null;
  bankReference: string | null;
  ibanLast4: string;
  failedReason: string | null;
  /** قد يرسله الخادم (v1) — بديل الفترة لدفعةٍ قديمة */
  createdAt?: string;
}

// ─────────────────────── v2: المستندات والمطالبات والمواد ───────────────────────

/** جسم POST /documents — الملف data URL بـbase64 (jpeg/png/webp/pdf ≤ ٥ ميغابايت) */
export interface DocumentUploadBody {
  kind: DocKind;
  dataUrl: string;
}

/** جسم POST /missed-claims — «مطالبة بإحالة فائتة» (لا تخلط بالترشيح المسبق) */
export interface MissedClaimBody {
  companyName: string;
  contactPhone?: string;
  crNumber?: string;
  note?: string;
}

export interface MissedClaimRow {
  id: string;
  companyName: string;
  contactPhone: string | null;
  crNumber: string | null;
  note: string | null;
  status: MissedClaimStatus;
  /** سبب القرار كما كتبه فريق فيلد سيلز — يُعرض كما هو */
  reasonNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
}

export interface MaterialRow {
  id: string;
  title: string;
  category: MaterialCategory;
  /** للمادة الملف وحدها */
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  /** للمادة الرابط */
  url: string | null;
  /** للنصّ الجاهز */
  textBody: string | null;
  createdAt: string;
}

export interface PayoutProfileBody {
  iban: string;
  holderName: string;
  bankName?: string;
}

/** الباقات والأسعار في البوابة — شاملة الضريبة، بالهللات؛ `discountPct` خصمٌ إقليميّ (سفير اليمن ٣٣) */
export type PricingPackageId = 'starter' | 'growth' | 'pro';
export interface PricingResponse {
  region: string | null;
  discountPct: number;
  vatInclusive: true;
  packages: Array<{
    id: PricingPackageId;
    listMonthlyHalalas: number;
    listYearlyHalalas: number;
    /** سعر السفراء قبل الخصم الإقليميّ (سعر المالك أو الكتالوج) — اختياريّ: خادمٌ أقدم لا يرسله فيُشطب المعلن */
    baseMonthlyHalalas?: number;
    baseYearlyHalalas?: number;
    monthlyHalalas: number;
    yearlyHalalas: number;
  }>;
}

