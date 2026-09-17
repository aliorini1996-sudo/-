/**
 * تسجيل تقرير فحوصات السلامة (M3، DESIGN.md §5.9، §9.3) — مشترك بين `POST /api/ledger/checks/run` والفحوص الليلية
 * وفحوص اكتمال الترحيل التاريخي في المجدول، فلا يستورد المجدول الموجّه.
 *
 * - LEDGER_CHECKS_CACHE: آخر تقرير كامل لكل شركة في ذاكرة العملية.
 * - الإشعار LEDGER_CHECK_RED للأدمن الرئيسي حين يصير C8 أو C15 أحمر، ولا يتكرر لمفتاح أُشعر به خلال 24 ساعة
 *   (الكاش يضيع بإعادة التشغيل، فيُقرأ آخر إشعار من القاعدة).
 */
import type { CheckKey, ChecksReport } from './types';

/** آخر تقرير لكل شركة (العملية الواحدة) */
export const LEDGER_CHECKS_CACHE = new Map<string, { report: ChecksReport; at: number }>();

/** نافذة منع تكرار إشعار المفتاح الأحمر نفسه */
export const CHECK_RED_NOTIFY_DEDUPE_MS = 24 * 60 * 60_000;

/** الفحوص الحمراء الجديدة التي تستوجب إشعار الأدمن الرئيسي (§9.3: C8 وC15) */
export function newlyRedNotifiable(prev: ChecksReport | null, next: ChecksReport): CheckKey[] {
  const notifiable: CheckKey[] = ['C8', 'C15'];
  return next.results
    .filter((r) => notifiable.includes(r.key) && r.status === 'RED')
    .filter((r) => prev?.results.find((p) => p.key === r.key)?.status !== 'RED')
    .map((r) => r.key);
}

/** مفاتيح أُشعر بها في إشعارات سابقة (data = JSON {keys}) */
export function notifiedKeys(rows: readonly { data: string | null }[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const d = r.data ? JSON.parse(r.data) as { keys?: unknown } : null;
      if (Array.isArray(d?.keys)) for (const k of d!.keys as unknown[]) if (typeof k === 'string') out.add(k);
    } catch { /* بيانات غير JSON: تُتجاهل */ }
  }
  return out;
}

/** ما يلزم من القاعدة (PrismaClient أو معاملة) */
export interface ChecksNotifyDb {
  notification: {
    findMany(args: { where: { tenantId: string; type: string; createdAt: { gte: Date } }; select: { data: true } }): Promise<{ data: string | null }[]>;
    create(args: { data: { tenantId: string; type: string; title: string; body: string; data: string } }): Promise<unknown>;
  };
}

/**
 * يحدّث الكاش ويُنشئ إشعار LEDGER_CHECK_RED للمفاتيح الحمراء الجديدة. يعيد المفاتيح التي أُشعر بها.
 * التقرير الجزئي (`only`) لا يمرّ من هنا (لا يحدّث الكاش ولا يُشعر).
 */
export async function recordChecksReport(db: ChecksNotifyDb, tenantId: string, report: ChecksReport, opts: { now?: Date; cache?: Map<string, { report: ChecksReport; at: number }> } = {}): Promise<CheckKey[]> {
  const cache = opts.cache ?? LEDGER_CHECKS_CACHE;
  const now = opts.now ?? new Date();
  const prev = cache.get(tenantId)?.report ?? null;
  let red = newlyRedNotifiable(prev, report);
  cache.set(tenantId, { report, at: now.getTime() });
  if (red.length === 0) return [];
  const recent = await db.notification.findMany({
    where: { tenantId, type: 'LEDGER_CHECK_RED', createdAt: { gte: new Date(now.getTime() - CHECK_RED_NOTIFY_DEDUPE_MS) } },
    select: { data: true },
  });
  const already = notifiedKeys(recent);
  red = red.filter((k) => !already.has(k));
  if (red.length === 0) return [];
  await db.notification.create({
    data: {
      tenantId, type: 'LEDGER_CHECK_RED', title: 'فحص سلامة الدفاتر أحمر',
      body: red.map((k) => report.results.find((r) => r.key === k)?.summary ?? k).join('، '),
      data: JSON.stringify({ keys: red, ranAt: report.ranAt }),
    },
  });
  return red;
}
