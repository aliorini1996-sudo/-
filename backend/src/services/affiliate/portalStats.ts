/**
 * أرقام «الرئيسية» في بوابة السفير (V2_SPEC §6.1 — GET /dashboard): دوالٌّ نقيّة بلا قاعدة، تُغذّيها استعلامات
 * routes/affiliate.ts (المقيّدة بـaffiliateId من التوكن — حارس الاختبار قائم هناك) ويختبرها affiliate-v2-portal.test.ts.
 */

/** الحالات «الحيّة» للعمولة — ما نشأ ولم يُعكس أو يُرفض. بها تُعدّ «الشركات التي دفعت» ويُرسم مخطّط الأشهر */
export const LIVE_COMMISSION_STATUSES = ['pending', 'on_hold', 'approved', 'paid'] as const;

/** أشهر مخطّط الأرباح في الرئيسية */
export const EARNINGS_MONTHS = 6;

const RIYADH_OFFSET_MS = 3 * 3600_000;

/** الشهر بتوقيت الرياض `YYYY-MM` */
export function riyadhMonth(d: Date): string {
  return new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 7);
}

/** آخر `n` أشهر بتوقيت الرياض، الأقدم أوّلاً والحالي آخراً */
export function lastMonths(now: Date, n: number = EARNINGS_MONTHS): string[] {
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** أوّل لحظةٍ في أقدم الأشهر (منتصف ليل الرياض في اليوم الأوّل) — حدّ الاستعلام */
export function monthsWindowStart(now: Date, n: number = EARNINGS_MONTHS): Date {
  const [y, m] = lastMonths(now, n)[0].split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - RIYADH_OFFSET_MS);
}

/**
 * أرباح كل شهرٍ من آخر ستة **بتاريخ الدفعة** (`paymentPaidAt` — يوم دفعت الشركة)، صفراً للشهر الخالي.
 * المُدخل عمولاتٌ حيّة (LIVE_COMMISSION_STATUSES) بصافيها بعد الاسترداد الجزئي (`commissionHalalas`).
 */
export function earningsByMonth(rows: ReadonlyArray<{ paymentPaidAt: Date; commissionHalalas: number }>, now: Date, n: number = EARNINGS_MONTHS): Array<{ month: string; halalas: number }> {
  const months = lastMonths(now, n);
  const sums = new Map(months.map(m => [m, 0]));
  for (const r of rows) {
    const k = riyadhMonth(r.paymentPaidAt);
    if (sums.has(k)) sums.set(k, sums.get(k)! + Math.trunc(r.commissionHalalas));
  }
  return months.map(month => ({ month, halalas: sums.get(month)! }));
}

/** معدّل التحويل: الشركات التي دفعت ÷ التسجيلات — كسرٌ بين 0 و1 بأربع خانات، أو null بلا تسجيلات */
export function conversionRate(paidCompanies: number, signups: number): number | null {
  if (!(signups > 0)) return null;
  return Math.round(Math.min(1, Math.max(0, paidCompanies / signups)) * 10_000) / 10_000;
}

/**
 * مجاميع الرئيسية من مجاميع الحالات والقيود:
 * - `totalEarnedHalalas` = المعتمد + المدفوع + كل القيود (الاسترداد بالسالب) — «صافياً»، ولا يقلّ عن صفر.
 * - `pendingSettlementHalalas` = المعتمد (بلا دفعة، أو في دفعةٍ قيد المعالجة — العمولة تبقى approved حتى التسجيل)
 *   + القيود غير المسوّاة (بلا دفعة أو في مسودّة) — ما ستحمله التسوية القادمة، ولا يقلّ عن صفر.
 */
export function earningsTotals(p: { approvedHalalas: number; paidHalalas: number; allAdjustmentsHalalas: number; openAdjustmentsHalalas: number }): { totalEarnedHalalas: number; pendingSettlementHalalas: number } {
  return {
    totalEarnedHalalas: Math.max(0, p.approvedHalalas + p.paidHalalas + p.allAdjustmentsHalalas),
    pendingSettlementHalalas: Math.max(0, p.approvedHalalas + p.openAdjustmentsHalalas),
  };
}
