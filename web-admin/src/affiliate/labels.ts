// ============================================================================
// تسميات كل قيمة حالة في واجهات «سفير فيلد سيلز» — مفاتيح في قاموس البوابة
// (./i18n) بخمس لغات، ونبرة لون.
// `Record<Union, …>` يُلزم التصريف بكل قيمة، واختبار labels.test.ts يقرأ
// docs/affiliate/API.md نفسه ليُفشل أي قيمةٍ تُضاف للمواصفة بلا تسمية هنا.
// ============================================================================
import type { Lang } from '../i18n/lang';
import type {
  UserStatus, ClaimStatus, AttributionStatus, CommissionStatus, PayoutStatus,
  ClaimHow, CompanyStatus, CompanySource, AdjustmentKind, ActivationStatus, CompanyRow,
  PartnerType, SocialPlatform, DocKind, ProfileMissing, MissedClaimStatus, MaterialCategory,
} from './types';
import { translate, type AxKey } from './i18n';

/** نبرة الشارة — تُترجم إلى ألوان الهوية في ui.tsx */
export type Tone = 'green' | 'amber' | 'red' | 'gray' | 'coral';

/** تسمية قاموسية: مفتاح ترجمة + نبرة */
export interface LabelDef { key: AxKey; tone: Tone }
/** تسمية محلولة بلغة العرض */
export interface Label { label: string; tone: Tone }

export const USER_STATUS: Record<UserStatus, LabelDef> = {
  pending_email: { key: 'st.user.pending_email', tone: 'amber' },
  pending_review: { key: 'st.user.pending_review', tone: 'amber' },
  approved: { key: 'st.user.approved', tone: 'green' },
  rejected: { key: 'st.user.rejected', tone: 'red' },
  suspended: { key: 'st.user.suspended', tone: 'red' },
};

export const CLAIM_STATUS: Record<ClaimStatus, LabelDef> = {
  under_review: { key: 'st.claim.under_review', tone: 'amber' },
  approved: { key: 'st.claim.approved', tone: 'green' },
  rejected: { key: 'st.claim.rejected', tone: 'red' },
  withdrawn: { key: 'st.claim.withdrawn', tone: 'gray' },
  expired: { key: 'st.claim.expired', tone: 'gray' },
  converted: { key: 'st.claim.converted', tone: 'coral' },
};

export const ATTRIBUTION_STATUS: Record<AttributionStatus, LabelDef> = {
  active: { key: 'st.attr.active', tone: 'green' },
  disputed: { key: 'st.attr.disputed', tone: 'amber' },
  void: { key: 'st.attr.void', tone: 'gray' },
};

export const COMMISSION_STATUS: Record<CommissionStatus, LabelDef> = {
  pending: { key: 'st.commission.pending', tone: 'amber' },
  on_hold: { key: 'st.commission.on_hold', tone: 'red' },
  approved: { key: 'st.commission.approved', tone: 'green' },
  paid: { key: 'st.commission.paid', tone: 'coral' },
  reversed: { key: 'st.commission.reversed', tone: 'gray' },
  declined: { key: 'st.commission.declined', tone: 'red' },
};

/** للسفير (V2_SPEC §3): قيد المعالجة · مدفوعة · ملغاة · فشل التحويل */
export const PAYOUT_STATUS: Record<PayoutStatus, LabelDef> = {
  draft: { key: 'st.payout.draft', tone: 'amber' },
  recorded: { key: 'st.payout.recorded', tone: 'green' },
  void: { key: 'st.payout.void', tone: 'gray' },
  failed: { key: 'st.payout.failed', tone: 'red' },
};

export const COMPANY_STATUS: Record<CompanyStatus, LabelDef> = {
  trial: { key: 'st.company.trial', tone: 'amber' },
  paid: { key: 'st.company.paid', tone: 'green' },
  disputed: { key: 'st.company.disputed', tone: 'amber' },
  void: { key: 'st.company.void', tone: 'gray' },
  expired: { key: 'st.company.expired', tone: 'gray' },
};

export const COMPANY_SOURCE: Record<CompanySource, AxKey> = {
  signup_code: 'src.signup_code',
  claim: 'src.claim',
  owner: 'src.owner',
  portal: 'src.portal',
};

/** تفعيل حسابٍ فتحه السفير: بانتظار اختيار المسؤول كلمة مروره، أو فُعّل */
export const ACTIVATION: Record<ActivationStatus, LabelDef> = {
  pending: { key: 'st.activation.pending', tone: 'amber' },
  active: { key: 'st.activation.active', tone: 'green' },
};

export const ADJUSTMENT_KIND: Record<AdjustmentKind, AxKey> = {
  clawback_refund: 'adj.clawback_refund',
  correction: 'adj.correction',
};

export const CLAIM_HOW: Record<ClaimHow, AxKey> = {
  visit: 'how.visit',
  relationship: 'how.relationship',
  event: 'how.event',
  online: 'how.online',
  other: 'how.other',
};

/** حالات «المطالبة بإحالة فائتة» — غير حالات الترشيح المسبق */
export const MISSED_CLAIM_STATUS: Record<MissedClaimStatus, LabelDef> = {
  under_review: { key: 'st.missed.under_review', tone: 'amber' },
  accepted: { key: 'st.missed.accepted', tone: 'green' },
  rejected: { key: 'st.missed.rejected', tone: 'red' },
  withdrawn: { key: 'st.missed.withdrawn', tone: 'gray' },
};

/** نوع السفير — بطاقات التسجيل و«ملفي» بهذا الترتيب */
export const PARTNER_TYPE: Record<PartnerType, AxKey> = {
  individual: 'partner.individual',
  company: 'partner.company',
  influencer: 'partner.influencer',
};
export const PARTNER_TYPE_ORDER: PartnerType[] = ['individual', 'company', 'influencer'];

export const SOCIAL_PLATFORM: Record<SocialPlatform, AxKey> = {
  x: 'social.x',
  instagram: 'social.instagram',
  snapchat: 'social.snapchat',
  tiktok: 'social.tiktok',
  youtube: 'social.youtube',
  linkedin: 'social.linkedin',
  website: 'social.website',
  other: 'social.other',
};
export const SOCIAL_PLATFORM_ORDER: SocialPlatform[] = ['x', 'instagram', 'snapchat', 'tiktok', 'youtube', 'linkedin', 'website', 'other'];

export const DOC_KIND: Record<DocKind, AxKey> = {
  national_id: 'doc.national_id',
  commercial_reg: 'doc.commercial_reg',
};

/** ما ينقص الملف (`missing` من GET /me) */
export const PROFILE_MISSING: Record<ProfileMissing, AxKey> = {
  partnerType: 'missing.partnerType',
  iban: 'missing.iban',
  national_id: 'missing.national_id',
  commercial_reg: 'missing.commercial_reg',
};

export const MATERIAL_CATEGORY: Record<MaterialCategory, AxKey> = {
  image: 'mat.cat.image',
  video: 'mat.cat.video',
  document: 'mat.cat.document',
  text: 'mat.cat.text',
  link: 'mat.cat.link',
};
export const MATERIAL_CATEGORY_ORDER: MaterialCategory[] = ['image', 'video', 'document', 'text', 'link'];

/**
 * «الطريقة» في «شركاتي» (V2_SPEC §7): رابط · رمز · ترشيح · حساب تجريبي · إداري.
 * مصدر `signup_code` يُفرَّق بـ`refVia` إن أرسله الخادم، وإلا «رابط أو رمز» بلا تخمين.
 * إسناد المطالبة الفائتة المقبولة يصل `owner` ⇒ «إداري».
 */
export type CompanyMethod = 'link' | 'code' | 'linkOrCode' | 'nomination' | 'trial' | 'admin';
export const COMPANY_METHOD: Record<CompanyMethod, AxKey> = {
  link: 'method.link',
  code: 'method.code',
  linkOrCode: 'method.linkOrCode',
  nomination: 'method.nomination',
  trial: 'method.trial',
  admin: 'method.admin',
};
export function companyMethod(row: Pick<CompanyRow, 'source' | 'refVia'>): CompanyMethod {
  switch (row.source) {
    case 'signup_code': return row.refVia === 'link' ? 'link' : row.refVia === 'typed' ? 'code' : 'linkOrCode';
    case 'claim': return 'nomination';
    case 'portal': return 'trial';
    default: return 'admin';
  }
}

/** ترتيب ثابت لخيارات «كيف عرّفتهم» في النموذج */
export const CLAIM_HOW_ORDER: ClaimHow[] = ['visit', 'relationship', 'event', 'online', 'other'];

/** تسمية بلغة العرض لقيمةٍ قد تصل من خادمٍ أحدث من الواجهة (تُعرض كما هي) */
export function labelOf<K extends string>(map: Record<K, LabelDef>, value: string, lang: Lang = 'ar'): Label {
  const def = (map as Record<string, LabelDef>)[value];
  return def ? { label: translate(lang, def.key), tone: def.tone } : { label: value, tone: 'gray' };
}

export function textOf<K extends string>(map: Record<K, AxKey>, value: string, lang: Lang = 'ar'): string {
  const key = (map as Record<string, AxKey>)[value];
  return key ? translate(lang, key) : value;
}
