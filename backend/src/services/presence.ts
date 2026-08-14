import prisma from '../config/database';

// «متصل الآن» = آخر ظهور خلال هذه النافذة (نبض المندوب كل ≤٣ دقائق).
export const LIVE_WINDOW_MIN = 5;

// الاحتفاظ بلقطات الحضور — يُقلَّم ما هو أقدم عند كل تسجيل.
const RETENTION_DAYS = 45;

export interface LiveCounts {
  totalReps: number;
  totalAdmins: number;
  total: number;
  companies: { tenantId: string; reps: number; admins: number; total: number }[];
}

/**
 * عدّ المتصلين الآن عبر كل الشركات (مصدر واحد للحقيقة يستخدمه مسارُ المالك
 * ومسجّلُ اللقطات معاً، فيتطابق الرقم اللحظيّ مع نقاط المنحنى).
 */
export async function computeLiveCounts(now: number = Date.now()): Promise<LiveCounts> {
  const since = new Date(now - LIVE_WINDOW_MIN * 60 * 1000);

  const [repRows, adminRows] = await Promise.all([
    prisma.salesRep.groupBy({ by: ['tenantId'], where: { isActive: true, lastSeenAt: { gte: since } }, _count: { _all: true } }),
    prisma.admin.groupBy({ by: ['tenantId'], where: { isActive: true, lastSeenAt: { gte: since } }, _count: { _all: true } }),
  ]);

  const repBy = new Map<string, number>();
  for (const r of repRows) repBy.set(r.tenantId, r._count._all);
  const adminBy = new Map<string, number>();
  for (const a of adminRows) adminBy.set(a.tenantId, a._count._all);

  const ids = [...new Set<string>([...repBy.keys(), ...adminBy.keys()])];
  const companies = ids
    .map(id => {
      const reps = repBy.get(id) || 0;
      const admins = adminBy.get(id) || 0;
      return { tenantId: id, reps, admins, total: reps + admins };
    })
    .filter(c => c.total > 0);

  const totalReps = companies.reduce((s, c) => s + c.reps, 0);
  const totalAdmins = companies.reduce((s, c) => s + c.admins, 0);
  return { totalReps, totalAdmins, total: totalReps + totalAdmins, companies };
}

/** تسجيل لقطة حضور واحدة + تقليم القديم (يُستدعى دورياً من مجدول العمليات). */
export async function recordPresenceSnapshot(): Promise<void> {
  const c = await computeLiveCounts();
  await prisma.presenceSnapshot.create({ data: { reps: c.totalReps, admins: c.totalAdmins, total: c.total } });
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
  await prisma.presenceSnapshot.deleteMany({ where: { at: { lt: cutoff } } });
}
