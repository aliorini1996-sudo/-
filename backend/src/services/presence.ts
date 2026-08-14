import prisma from '../config/database';

// «متصل الآن» = آخر ظهور خلال هذه النافذة (نبض المندوب كل ≤٣ دقائق).
export const LIVE_WINDOW_MIN = 5;

// الاحتفاظ بلقطات الحضور — يُقلَّم ما هو أقدم عند كل تسجيل.
const RETENTION_DAYS = 45;

export interface LiveUser { id: string; name: string; kind: 'rep' | 'admin'; lastSeenAt: Date | null }
export interface LiveCompany { tenantId: string; reps: number; admins: number; total: number; users: LiveUser[] }
export interface LiveCounts {
  totalReps: number;
  totalAdmins: number;
  total: number;
  companies: LiveCompany[];
}

/**
 * عدّ المتصلين الآن عبر كل الشركات — مع أسماء المتصلين لكل شركة (مصدر واحد للحقيقة
 * يستخدمه مسارُ المالك ومسجّلُ اللقطات معاً؛ اللقطة تأخذ الأعداد فقط). المجموعة
 * الحيّة صغيرة (متصلون خلال ٥ دقائق) فجلبُ الصفوف بدل groupBy كلفةٌ مهملة.
 */
export async function computeLiveCounts(now: number = Date.now()): Promise<LiveCounts> {
  const since = new Date(now - LIVE_WINDOW_MIN * 60 * 1000);

  const [reps, admins] = await Promise.all([
    prisma.salesRep.findMany({ where: { isActive: true, lastSeenAt: { gte: since } }, select: { id: true, name: true, tenantId: true, lastSeenAt: true } }),
    prisma.admin.findMany({ where: { isActive: true, lastSeenAt: { gte: since } }, select: { id: true, name: true, tenantId: true, lastSeenAt: true } }),
  ]);

  const byTenant = new Map<string, LiveCompany>();
  const ensure = (tid: string): LiveCompany => {
    let e = byTenant.get(tid);
    if (!e) { e = { tenantId: tid, reps: 0, admins: 0, total: 0, users: [] }; byTenant.set(tid, e); }
    return e;
  };
  for (const r of reps) {
    const e = ensure(r.tenantId);
    e.reps++; e.total++;
    e.users.push({ id: r.id, name: r.name, kind: 'rep', lastSeenAt: r.lastSeenAt });
  }
  for (const a of admins) {
    const e = ensure(a.tenantId);
    e.admins++; e.total++;
    e.users.push({ id: a.id, name: a.name, kind: 'admin', lastSeenAt: a.lastSeenAt });
  }

  const companies = [...byTenant.values()].filter(c => c.total > 0);
  for (const c of companies) {
    c.users.sort((x, y) => (y.lastSeenAt?.getTime() || 0) - (x.lastSeenAt?.getTime() || 0));
  }
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
