// ============================================================================
// قراءة نقيّة للوحة الرئيسية (GET /dashboard — V2_SPEC §6.1) بتسامحٍ مع خادمٍ أقدم:
// الحقول الجديدة تُشتقّ من القديمة إن غابت، فلا تظهر «undefined» ولا تسقط الصفحة أثناء
// نشرٍ لم يكتمل (الواجهة والخادم يُنشران بالتوازي).
// ============================================================================
import type { Dashboard } from './types';

export interface DashboardView {
  totalEarnedHalalas: number;
  pendingSettlementHalalas: number;
  activeReferrals: number;
  conversionRate: number | null;
  /** آخر ستة أشهر بالترتيب الزمنيّ (الأقدم أولاً) */
  months: Array<{ month: string; halalas: number }>;
  nextSettlementAt: string | null;
  steps: { account: boolean; shared: boolean; firstPaid: boolean };
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function dashboardView(d: Partial<Dashboard> & Pick<Dashboard, 'clicks30d' | 'signups' | 'paidCompanies'>, fallbackNext: string | null = null): DashboardView {
  const approved = num(d.approvedHalalas, 0);
  const paid = num(d.paidHalalas, 0);
  const signups = num(d.signups, 0);
  const paidCompanies = num(d.paidCompanies, 0);
  const months = Array.isArray(d.earningsByMonth)
    ? d.earningsByMonth
      .filter((p) => p && typeof p.month === 'string' && /^\d{4}-\d{2}$/.test(p.month))
      .map((p) => ({ month: p.month, halalas: num(p.halalas, 0) }))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
      .slice(-6)
    : [];
  const conv = d.conversionRate === null ? null
    : typeof d.conversionRate === 'number' && Number.isFinite(d.conversionRate) ? d.conversionRate
      : signups > 0 ? paidCompanies / signups : null;
  const steps = d.steps && typeof d.steps === 'object'
    ? { account: d.steps.account !== false, shared: d.steps.shared === true, firstPaid: d.steps.firstPaid === true }
    : { account: true, shared: num(d.clicks30d, 0) > 0 || signups > 0, firstPaid: paidCompanies > 0 };
  return {
    totalEarnedHalalas: num(d.totalEarnedHalalas, approved + paid),
    pendingSettlementHalalas: num(d.pendingSettlementHalalas, approved),
    activeReferrals: num(d.activeReferrals, signups),
    conversionRate: conv,
    months,
    nextSettlementAt: typeof d.nextSettlementAt === 'string' && d.nextSettlementAt ? d.nextSettlementAt : fallbackNext,
    steps,
  };
}
