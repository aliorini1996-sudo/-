import type { CheckKey, CheckStatus, ChecksReport } from '../../api/ledgerReview';

const RANK: Record<CheckStatus, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

/** أسوأ حالة تغلب — مرآة worstStatus في backend/src/services/gl/checks/run.ts (بلا نتائج ⇒ GREEN) */
export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), 'GREEN');
}

/** ردّ POST /checks/run (backend/src/routes/ledger/checks.ts) — المقيَّد يعيد آخر تقرير كامل مخزَّن أو null */
export interface ChecksRunResponse {
  report: ChecksReport | null;
  throttled: boolean;
  retryAfterSeconds?: number;
}

/**
 * التقرير المعروض بعد تشغيل الفحوصات (M3، §5.9) — صرفة ومختبَرة في checks.test.ts.
 * يعيد null حين لا يجب تغيير بيانات الاستعلام.
 * - مقيَّد: لا تغيير إلا بتقرير مخزَّن أحدثَ تماماً من المعروض. المساواة في ranAt تعني المخزَّن نفسه الذي
 *   بُني عليه المعروض — وقد يحمل المعروض دمجاً محلياً لفحص مفرد لاحق (يحتفظ بـranAt الكامل) فلا يُمحى.
 * - فحص مفرد: التشغيل المفرد لا يحدّث ذاكرة الخادم ⇒ تُدمج نتائجه محلياً في المعروض ويُعاد حساب overall.
 * - كامل: يُستبدل المعروض.
 */
export function mergeChecksRun(current: ChecksReport | null, run: ChecksRunResponse, only?: readonly CheckKey[]): ChecksReport | null {
  const next = run.report;
  if (!next) return null;
  if (run.throttled) {
    if (current && Date.parse(current.ranAt) >= Date.parse(next.ranAt)) return null;
    return next;
  }
  if (only?.length && current) {
    const results = current.results.map(x => next.results.find(n => n.key === x.key) ?? x);
    return { ...current, results, overall: worstStatus(results.map(r => r.status)) };
  }
  return next;
}
