// ============================================================================
// تسميات كل قيمة حالة في واجهات «سفير فيلد سيلز» — مفاتيح في قاموس البوابة
// (./i18n) بخمس لغات، ونبرة لون.
// `Record<Union, …>` يُلزم التصريف بكل قيمة، واختبار labels.test.ts يقرأ
// docs/affiliate/API.md نفسه ليُفشل أي قيمةٍ تُضاف للمواصفة بلا تسمية هنا.
// ============================================================================
import type { Lang } from '../i18n/lang';
import type {
  UserStatus, ClaimStatus, AttributionStatus, CommissionStatus, PayoutStatus,
  ClaimHow, CompanyStatus, CompanySource, AdjustmentKind,
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

export const PAYOUT_STATUS: Record<PayoutStatus, LabelDef> = {
  draft: { key: 'st.payout.draft', tone: 'amber' },
  recorded: { key: 'st.payout.recorded', tone: 'green' },
  void: { key: 'st.payout.void', tone: 'gray' },
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
