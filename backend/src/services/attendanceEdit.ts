// ============================================================================
// التعديل الإداري لبصمات الحضور ورفعها من Excel (طلب المالك، ٢١ أكتوبر ٢٠٢٦) — المنطق الصرف والقفل المشترك.
//
// قبل هذا كانت بصمة المندوب لا تُصحَّح: نوبةٌ نسي انصرافها تبقى بساعاتها المضخّمة. الآن يضيف مستخدم الشركة (صلاحية
// التتبّع) فترةً أو يعدّل وقتيها أو يحذفها بسببٍ مكتوب، ويرفع بصمات من ملف — وكلّه في AttendanceAudit (مَن ومتى ولماذا
// والقيم قبل وبعد). الحدود هنا يحرسها الخادم: لا مستقبل، الانصراف بعد الحضور، لا فترة فوق ٢٤ ساعة، لا تداخل.
// ============================================================================
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { isOwnerSession } from '../middleware/auth';
import type { AuthRequest } from '../types';

/** أطول فترة تُقبل في التعديل والرفع — نوبةٌ أطول خطأُ إدخال (أو نوبةٌ منسيّة تُقسَّم) */
export const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;
/** هامش ساعة الجهاز لوقتٍ «الآن» — دقيقتان */
export const FUTURE_SLACK_MS = 2 * 60 * 1000;
/** أقدم ما يُعدَّل أو يُرفع — ما بعد ٤٠٠ يوم أرشيفٌ لا تصحيح */
export const MAX_BACKDATE_MS = 400 * 24 * 60 * 60 * 1000;

export interface ShiftTimes { checkInAt: Date; checkOutAt: Date | null }
export interface ExistingShift extends ShiftTimes { id: string }

const valid = (d: Date | null): boolean => d === null || (d instanceof Date && Number.isFinite(d.getTime()));

/** مشكلة فترةٍ مدخلة، أو null حين تُقبل */
export function shiftProblem(s: ShiftTimes, now: Date): string | null {
  if (!valid(s.checkInAt) || !s.checkInAt) return 'وقت الحضور غير صالح';
  if (!valid(s.checkOutAt)) return 'وقت الانصراف غير صالح';
  const t = now.getTime();
  if (s.checkInAt.getTime() > t + FUTURE_SLACK_MS) return 'وقت الحضور في المستقبل';
  if (t - s.checkInAt.getTime() > MAX_BACKDATE_MS) return 'التاريخ أقدم من المسموح';
  if (s.checkOutAt) {
    if (s.checkOutAt.getTime() > t + FUTURE_SLACK_MS) return 'وقت الانصراف في المستقبل';
    if (s.checkOutAt.getTime() <= s.checkInAt.getTime()) return 'وقت الانصراف يجب أن يكون بعد وقت الحضور';
    // ٢٤ ساعةً بالضبط خطأُ إدخالٍ كذلك: كشف جهاز البصمة يصدّر يوم البصمة الواحدة بحضورٍ يساوي انصرافه
    if (s.checkOutAt.getTime() - s.checkInAt.getTime() >= MAX_SHIFT_MS) return 'الفترة ٢٤ ساعة أو أطول';
  } else if (t - s.checkInAt.getTime() >= MAX_SHIFT_MS) {
    // فترةٌ مفتوحة في تاريخٍ مضى تمتدّ إلى الآن: تبتلع ما بعدها (كل صفٍّ لاحقٍ «يتداخل») وتصير نوبة المندوب الحالية
    return 'أدخل وقت الانصراف — لا تبقى فترة مفتوحة أكثر من ٢٤ ساعة';
  }
  return null;
}

/**
 * أول فترةٍ للمندوب تتداخل معها هذه — المفتوحة تمتدّ إلى الآن، والتلامس (انصرافٌ ثمّ حضورٌ في اللحظة نفسها) ليس تداخلاً.
 * وفترةٌ مفتوحة ثانية تتداخل حتماً مع المفتوحة القائمة، فلا تُفتح نوبتان.
 */
export function overlappingShift(s: ShiftTimes, others: readonly ExistingShift[], now: Date, excludeId?: string): ExistingShift | null {
  const end = (x: ShiftTimes) => (x.checkOutAt ?? now).getTime();
  const a0 = s.checkInAt.getTime();
  const a1 = Math.max(end(s), a0 + 1);
  for (const o of others) {
    if (o.id === excludeId) continue;
    const b0 = o.checkInAt.getTime();
    const b1 = Math.max(end(o), b0 + 1);
    if (a0 < b1 && b0 < a1) return o;
  }
  return null;
}

/**
 * المرشّحون للتداخل من القاعدة: فتراتٌ بدأت قبل نهاية هذه ولم تنتهِ قبل بدايتها (أو ما زالت مفتوحة) — كلّها بلا سقف:
 * الرفع يسأل بمدى الملف كله (حتى ٤٠٠ يوم)، وسقفٌ يُخفي فتراتٍ يكتب فوقها بصماتٍ مكرّرة.
 */
export async function shiftsAround(db: Prisma.TransactionClient | typeof prisma, tid: string, repId: string, s: ShiftTimes, now: Date): Promise<ExistingShift[]> {
  const endAt = s.checkOutAt ?? now;
  return db.repAttendance.findMany({
    where: {
      tenantId: tid, salesRepId: repId,
      checkInAt: { lt: new Date(Math.max(endAt.getTime(), s.checkInAt.getTime() + 1)) },
      OR: [{ checkOutAt: null }, { checkOutAt: { gt: s.checkInAt } }],
    },
    select: { id: true, checkInAt: true, checkOutAt: true },
    orderBy: { checkInAt: 'asc' },
  });
}

/**
 * مهلتا المعاملات تحت قفل المندوب. الرفع يمسك أقفال مناديب ملفه حتى ينتهي (≤ ٣٠ ثانية)، ومعاملة البصمة والتعديل تنتظر
 * القفل داخلها — بمهلة Prisma الافتراضية (٥ ثوانٍ) تسقط بـ500 أثناء رفعٍ طويل بدل أن «تنتظر انتهاءه»
 */
export const IMPORT_TX = { maxWait: 10_000, timeout: 30_000 } as const;
export const REP_LOCK_TX = { maxWait: 5_000, timeout: 45_000 } as const;

/** قفل بصمات المندوب: الحضور والانصراف والتعديل الإداري تمرّ واحدةً واحدة — فلا تُفتح نوبتان بطلبين متزامنين */
export const lockRepAttendance = (tx: Prisma.TransactionClient, repId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rep-attendance:' + repId}))`;

/** الميزة مفعّلة للشركة (يفعّلها المالك لكل شركة، مطفأة افتراضاً) */
export async function attendanceEnabled(tid: string): Promise<boolean> {
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { attendanceEnabled: true } });
  return t?.attendanceEnabled === true;
}

/** اسم المنفّذ في سجلّ التدقيق: جلسة المالك ومفتاحه «الدعم الفني» لا باسم مدير الشركة (وعد اتفاقية البيانات) */
export function auditActorName(req: AuthRequest): string | null {
  return isOwnerSession(req) || req.user?.ownerIssuedKey === true ? 'الدعم الفني' : (req.user?.name || null);
}

/** وقتا الفترة كما يُدوَّنان في سجلّ التدقيق */
export const auditTimes = (s: ShiftTimes) => ({ checkInAt: s.checkInAt.toISOString(), checkOutAt: s.checkOutAt ? s.checkOutAt.toISOString() : null });
