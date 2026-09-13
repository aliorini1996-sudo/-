// ============================================================================
// تسميات عربية لكل قيمة حالة في واجهات «سفير فيلد سيلز».
// `Record<Union, …>` يُلزم التصريف بكل قيمة، واختبار labels.test.ts يقرأ
// docs/affiliate/API.md نفسه ليُفشل أي قيمةٍ تُضاف للمواصفة بلا تسمية هنا.
// ============================================================================
import type {
  UserStatus, ClaimStatus, AttributionStatus, CommissionStatus, PayoutStatus,
  ClaimHow, CompanyStatus, CompanySource, AdjustmentKind,
} from './types';

/** نبرة الشارة — تُترجم إلى ألوان الهوية في ui.tsx */
export type Tone = 'green' | 'amber' | 'red' | 'gray' | 'coral';

export interface Label { label: string; tone: Tone }

export const USER_STATUS: Record<UserStatus, Label> = {
  pending_email: { label: 'بانتظار تأكيد البريد', tone: 'amber' },
  pending_review: { label: 'قيد المراجعة', tone: 'amber' },
  approved: { label: 'معتمد', tone: 'green' },
  rejected: { label: 'مرفوض', tone: 'red' },
  suspended: { label: 'موقوف', tone: 'red' },
};

export const CLAIM_STATUS: Record<ClaimStatus, Label> = {
  under_review: { label: 'قيد المراجعة', tone: 'amber' },
  approved: { label: 'مقبول', tone: 'green' },
  rejected: { label: 'مرفوض', tone: 'red' },
  withdrawn: { label: 'مسحوب', tone: 'gray' },
  expired: { label: 'منتهٍ', tone: 'gray' },
  converted: { label: 'تحوّل لعميل', tone: 'coral' },
};

export const ATTRIBUTION_STATUS: Record<AttributionStatus, Label> = {
  active: { label: 'ساري', tone: 'green' },
  disputed: { label: 'قيد المراجعة', tone: 'amber' },
  void: { label: 'ملغى', tone: 'gray' },
};

export const COMMISSION_STATUS: Record<CommissionStatus, Label> = {
  pending: { label: 'معلّقة', tone: 'amber' },
  on_hold: { label: 'موقوفة', tone: 'red' },
  approved: { label: 'معتمدة', tone: 'green' },
  paid: { label: 'مدفوعة', tone: 'coral' },
  reversed: { label: 'مُلغاة بالاسترداد', tone: 'gray' },
  declined: { label: 'مرفوضة', tone: 'red' },
};

export const PAYOUT_STATUS: Record<PayoutStatus, Label> = {
  draft: { label: 'قيد الإعداد', tone: 'amber' },
  recorded: { label: 'تم التحويل', tone: 'green' },
  void: { label: 'ملغاة', tone: 'gray' },
};

export const COMPANY_STATUS: Record<CompanyStatus, Label> = {
  trial: { label: 'تجربة', tone: 'amber' },
  paid: { label: 'دفعت', tone: 'green' },
  disputed: { label: 'قيد المراجعة', tone: 'amber' },
  void: { label: 'ملغاة', tone: 'gray' },
  expired: { label: 'انتهت المهلة', tone: 'gray' },
};

export const COMPANY_SOURCE: Record<CompanySource, string> = {
  signup_code: 'سجّلت برابطك أو رمزك',
  claim: 'ترشيح معتمد',
  owner: 'إسناد من الإدارة',
};

export const ADJUSTMENT_KIND: Record<AdjustmentKind, string> = {
  clawback_refund: 'خصم بسبب استرداد',
  correction: 'تصحيح',
};

export const CLAIM_HOW: Record<ClaimHow, string> = {
  visit: 'زيارة ميدانية',
  relationship: 'معرفة أو علاقة سابقة',
  event: 'فعالية أو معرض',
  online: 'تواصل عبر الإنترنت',
  other: 'أخرى',
};

/** ترتيب ثابت لخيارات «كيف عرّفتهم» في النموذج */
export const CLAIM_HOW_ORDER: ClaimHow[] = ['visit', 'relationship', 'event', 'online', 'other'];

/** تسمية آمنة لقيمة قد تصل من خادمٍ أحدث من الواجهة */
export function labelOf<K extends string>(map: Record<K, Label>, key: string): Label {
  return (map as Record<string, Label>)[key] ?? { label: key, tone: 'gray' };
}

export function textOf<K extends string>(map: Record<K, string>, key: string): string {
  return (map as Record<string, string>)[key] ?? key;
}
