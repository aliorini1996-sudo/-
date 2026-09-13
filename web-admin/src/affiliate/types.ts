// ============================================================================
// أنواع بوابة «سفير فيلد سيلز» — منسوخة من docs/affiliate/API.md §1 حرفياً.
// لا تُوسَّع هنا: الخادم يُكتب بالتوازي على المواصفة نفسها، وأي حقلٍ مُخترَع
// في الواجهة كذبةٌ على المستخدم حين لا يرسله الخادم.
// ============================================================================

export type UserStatus = 'pending_email' | 'pending_review' | 'approved' | 'rejected' | 'suspended';
export type ClaimStatus = 'under_review' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'converted';
export type AttributionStatus = 'active' | 'disputed' | 'void';
export type CommissionStatus = 'pending' | 'on_hold' | 'approved' | 'paid' | 'reversed' | 'declined';
export type PayoutStatus = 'draft' | 'recorded' | 'void';
export type ClaimHow = 'visit' | 'relationship' | 'event' | 'online' | 'other';
export type CompanyStatus = 'trial' | 'paid' | 'disputed' | 'void' | 'expired';
export type CompanySource = 'signup_code' | 'claim' | 'owner';
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
}

export interface RegisterBody {
  fullName: string;
  email: string;
  phone: string;
  city?: string;
  password: string;
  vatNumber?: string;
  marketingConsent: boolean;
  acceptTerms: true;
  termsVersion: string;
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
}

export interface MeSettings {
  disclosureText: string;
  rateBps: number;
  holdDays: number;
  minPayoutHalalas: number;
  currentTermsVersion: string;
}

export interface MeResponse {
  user: AffiliateMe;
  settings: MeSettings;
  link: string;
  canSetPayout: boolean;
}

export interface UpdateMeBody {
  city?: string;
  marketingConsent?: boolean;
  vatNumber?: string;
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

export interface PayoutRow {
  id: string;
  netHalalas: number;
  commissionsHalalas: number;
  adjustmentsHalalas: number;
  status: 'recorded';
  transferredAt: string | null;
  bankReference: string | null;
  ibanLast4: string;
  createdAt: string;
}

export interface PayoutProfileBody {
  iban: string;
  holderName: string;
  bankName?: string;
}
