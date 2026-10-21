// ============================================================================
// التعديل الإداري لبصمات الحضور ورفعها من Excel (طلب المالك، ٢١ أكتوبر ٢٠٢٦) — /api/attendance-admin
//
// لمستخدم الشركة الذي يملك صلاحية التتبّع (canManageTracking) وحده، وفي نطاق مناديبه (canAccessRep)، والميزة مفعّلة
// للشركة. كل كتابة: سببٌ مكتوب، وتحت قفل بصمات المندوب نفسه (فلا تتسابق مع حضوره)، وسطرٌ في AttendanceAudit.
// المنطق الصرف (الحدود والتداخل) في services/attendanceEdit.ts.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId, actorOf } from '../middleware/auth';
import { AuthRequest } from '../types';
import { adminRepFilter, canAccessRep } from '../services/adminScope';
import {
  shiftProblem, overlappingShift, shiftsAround, lockRepAttendance, attendanceEnabled, auditActorName, auditTimes, REP_LOCK_TX, IMPORT_TX,
  type ShiftTimes, type ExistingShift,
} from '../services/attendanceEdit';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canManageTracking'));
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await attendanceEnabled(tenantId(req)))) {
      res.status(403).json({ success: false, code: 'ATTENDANCE_DISABLED', message: 'ميزة بصمة الحضور غير مفعّلة' }); return;
    }
    next();
  } catch (err) { next(err); }
});

/** خطأٌ مقصود برمزه — معالج الأخطاء العامّ يجعل كل Error ‏500 */
class EditError extends Error { constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); } }
function fail(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof EditError) { res.status(err.status).json({ success: false, message: err.message, ...err.extra }); return; }
  next(err);
}

const isoTime = z.string().max(40).refine((v) => Number.isFinite(Date.parse(v)), 'وقت غير صالح');
const reasonSchema = z.string().trim().min(3, 'اكتب سبب التعديل').max(300);
const repIdSchema = z.string().min(1).max(64);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ROW_SELECT = {
  id: true, salesRepId: true, checkInAt: true, checkOutAt: true,
  checkInLat: true, checkInLng: true, checkOutLat: true, checkOutLng: true,
  checkInDevice: true, checkOutDevice: true,
  checkInOutside: true, checkInDistanceM: true, checkOutOutside: true, checkOutDistanceM: true,
  source: true, editedAt: true, editedBy: true,
} as const;

/** المندوب في الشركة وفي نطاق المستخدم — وإلّا 404 (لا يكشف الردّ وجود مندوبٍ خارج النطاق) */
async function assertRep(req: AuthRequest, tid: string, repId: string): Promise<void> {
  const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { id: true } });
  if (!rep || !(await canAccessRep(req, tid, repId))) throw new EditError(404, 'المندوب غير موجود');
}

const toTimes = (b: { checkInAt: string; checkOutAt?: string | null }): ShiftTimes => ({
  checkInAt: new Date(b.checkInAt),
  checkOutAt: b.checkOutAt ? new Date(b.checkOutAt) : null,
});

/** يرفض فترةً مخالفة أو متداخلة — داخل القفل */
function assertShiftOk(s: ShiftTimes, around: ExistingShift[], now: Date, excludeId?: string): void {
  const problem = shiftProblem(s, now);
  if (problem) throw new EditError(400, problem);
  const clash = overlappingShift(s, around, now, excludeId);
  if (clash) {
    throw new EditError(409, 'تتداخل مع فترة أخرى مسجّلة للمندوب في الوقت نفسه', {
      code: 'ATTENDANCE_OVERLAP', conflict: auditTimes(clash),
    });
  }
}

// صفوف بصمات مندوبٍ في مدى أيامٍ محلية (≤ ٣١ يوماً) — لنافذة التعديل وسجلّها
router.get('/rows', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const q = z.object({ salesRepId: repIdSchema, from: z.string().regex(DAY_RE), to: z.string().regex(DAY_RE), tz: z.coerce.number().int().min(-840).max(840).optional() }).parse(req.query);
    await assertRep(req, tid, q.salesRepId);
    const tz = q.tz ?? 0;
    const start = new Date(Date.parse(`${q.from}T00:00:00.000Z`) - tz * 60000);
    const end = new Date(Date.parse(`${q.to}T00:00:00.000Z`) - tz * 60000 + 24 * 60 * 60 * 1000);
    if (!(end > start) || end.getTime() - start.getTime() > 31 * 24 * 60 * 60 * 1000) throw new EditError(400, 'المدى من يوم إلى ٣١ يوماً');
    const [rows, audit] = await Promise.all([
      prisma.repAttendance.findMany({
        where: { tenantId: tid, salesRepId: q.salesRepId, checkInAt: { gte: start, lt: end } },
        orderBy: { checkInAt: 'asc' }, take: 500, select: ROW_SELECT,
      }),
      prisma.attendanceAudit.findMany({
        where: { tenantId: tid, salesRepId: q.salesRepId, createdAt: { gte: start } },
        orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, attendanceId: true, action: true, before: true, after: true, reason: true, actorName: true, createdAt: true },
      }),
    ]);
    res.json({ success: true, data: { rows, audit } });
  } catch (err) { fail(err, res, next); }
});

// إضافة فترة (حضور وانصراف، أو حضورٌ مفتوح)
router.post('/rows', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const b = z.object({ salesRepId: repIdSchema, checkInAt: isoTime, checkOutAt: isoTime.nullable().optional(), reason: reasonSchema }).parse(req.body);
    await assertRep(req, tid, b.salesRepId);
    const s = toTimes(b);
    const name = auditActorName(req);
    const row = await prisma.$transaction(async (tx) => {
      await lockRepAttendance(tx, b.salesRepId);
      const now = new Date();
      assertShiftOk(s, await shiftsAround(tx, tid, b.salesRepId, s, now), now);
      const created = await tx.repAttendance.create({
        data: { tenantId: tid, salesRepId: b.salesRepId, checkInAt: s.checkInAt, checkOutAt: s.checkOutAt, source: 'ADMIN', editedAt: now, editedBy: name },
        select: ROW_SELECT,
      });
      await tx.attendanceAudit.create({
        data: { tenantId: tid, salesRepId: b.salesRepId, attendanceId: created.id, action: 'CREATE', after: auditTimes(s), reason: b.reason, actorId: actorOf(req), actorName: name },
      });
      return created;
    }, REP_LOCK_TX);
    res.status(201).json({ success: true, data: row });
  } catch (err) { fail(err, res, next); }
});

/** صفٌّ في الشركة وفي نطاق المستخدم */
async function rowInScope(req: AuthRequest, tid: string, id: string) {
  const row = await prisma.repAttendance.findFirst({ where: { id, tenantId: tid }, select: { id: true, salesRepId: true } });
  if (!row || !(await canAccessRep(req, tid, row.salesRepId))) throw new EditError(404, 'البصمة غير موجودة');
  return row;
}

// تعديل وقتي فترة (أو إغلاق نوبةٍ مفتوحة على وقتها الحقيقي)
router.put('/rows/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const b = z.object({ checkInAt: isoTime, checkOutAt: isoTime.nullable(), reason: reasonSchema }).parse(req.body);
    const found = await rowInScope(req, tid, String(req.params.id));
    const s = toTimes(b);
    const name = auditActorName(req);
    const row = await prisma.$transaction(async (tx) => {
      await lockRepAttendance(tx, found.salesRepId);
      const before = await tx.repAttendance.findFirst({ where: { id: found.id, tenantId: tid }, select: { checkInAt: true, checkOutAt: true } });
      if (!before) throw new EditError(404, 'البصمة غير موجودة');
      const now = new Date();
      assertShiftOk(s, await shiftsAround(tx, tid, found.salesRepId, s, now), now, found.id);
      const updated = await tx.repAttendance.update({
        where: { id: found.id },
        data: { checkInAt: s.checkInAt, checkOutAt: s.checkOutAt, editedAt: now, editedBy: name },
        select: ROW_SELECT,
      });
      await tx.attendanceAudit.create({
        data: { tenantId: tid, salesRepId: found.salesRepId, attendanceId: found.id, action: 'UPDATE', before: auditTimes(before), after: auditTimes(s), reason: b.reason, actorId: actorOf(req), actorName: name },
      });
      return updated;
    }, REP_LOCK_TX);
    res.json({ success: true, data: row });
  } catch (err) { fail(err, res, next); }
});

// حذف فترة بسببٍ مكتوب — تبقى في سجلّ التدقيق بوقتيها
router.delete('/rows/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const b = z.object({ reason: reasonSchema }).parse(req.body ?? {});
    const found = await rowInScope(req, tid, String(req.params.id));
    const name = auditActorName(req);
    await prisma.$transaction(async (tx) => {
      await lockRepAttendance(tx, found.salesRepId);
      const before = await tx.repAttendance.findFirst({ where: { id: found.id, tenantId: tid }, select: { checkInAt: true, checkOutAt: true, source: true } });
      if (!before) throw new EditError(404, 'البصمة غير موجودة');
      await tx.repAttendance.delete({ where: { id: found.id } });
      await tx.attendanceAudit.create({
        data: { tenantId: tid, salesRepId: found.salesRepId, attendanceId: found.id, action: 'DELETE', before: { ...auditTimes(before), source: before.source }, reason: b.reason, actorId: actorOf(req), actorName: name },
      });
    }, REP_LOCK_TX);
    res.json({ success: true });
  } catch (err) { fail(err, res, next); }
});

/** أقصى صفوف الرفع الواحد */
export const IMPORT_MAX_ROWS = 2000;

// مناديب النطاق لمطابقة أسماء المستخدمين في ملف الرفع — بصلاحية هذا الموجّه نفسها: قائمة /sales-reps تشترط
// «إدارة المناديب»، فصاحب صلاحية التتبّع وحدها كان يرى كل سطرٍ «اسم المستخدم غير معروف»
router.get('/reps', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const reps = await prisma.salesRep.findMany({
      where: { tenantId: tid, ...(await adminRepFilter(req)) },
      select: { id: true, name: true, username: true }, orderBy: { name: 'asc' }, take: 5000,
    });
    res.json({ success: true, data: reps });
  } catch (err) { fail(err, res, next); }
});

/**
 * رفع بصمات من Excel: الواجهة تقرأ الملف وتطابق المندوب باسم المستخدم وتحوّل الأوقات بتوقيت المتصفّح، ثم ترسل الصفوف.
 * كل صفٍّ يُحكم وحده (المندوب في النطاق، الحدود، لا تداخل مع القائم ولا مع صفوف الملف نفسه): المقبول يُكتب بمصدر IMPORT،
 * والمرفوض يعود برقمه وسببه. الرفع كله معاملةٌ واحدة تحت أقفال مناديبه (بترتيبٍ ثابت) — فإمّا يُكتب كله أو لا شيء،
 * لا التزامٌ جزئيّ مجهول يُعاد رفعه مكرّراً — وسطرٌ في سجلّ التدقيق لكل مندوب بما رُفع.
 */
router.post('/import', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // الحدّ برسالةٍ تُفهم قبل zod (التي تقول «بيانات غير صحيحة rows» فلا يُعرف السبب)
    if (Array.isArray(req.body?.rows) && req.body.rows.length > IMPORT_MAX_ROWS) {
      res.status(400).json({ success: false, code: 'IMPORT_TOO_MANY_ROWS', message: `الحد ${IMPORT_MAX_ROWS} صف في الرفع الواحد — قسّم الملف` }); return;
    }
    const b = z.object({
      reason: reasonSchema,
      rows: z.array(z.object({ salesRepId: repIdSchema, checkInAt: isoTime, checkOutAt: isoTime.nullable().optional() })).min(1).max(IMPORT_MAX_ROWS),
    }).parse(req.body);
    const repIds = [...new Set(b.rows.map((r) => r.salesRepId))];
    const allowed = new Set((await prisma.salesRep.findMany({
      where: { id: { in: repIds }, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true },
    })).map((r) => r.id));
    const rejected: { index: number; message: string }[] = [];
    const byRep = new Map<string, { index: number; s: ShiftTimes }[]>();
    b.rows.forEach((r, index) => {
      if (!allowed.has(r.salesRepId)) { rejected.push({ index, message: 'المندوب غير موجود' }); return; }
      const list = byRep.get(r.salesRepId) ?? [];
      list.push({ index, s: toTimes(r) });
      byRep.set(r.salesRepId, list);
    });
    const name = auditActorName(req);
    const reps = [...byRep.keys()].sort();
    const created = await prisma.$transaction(async (tx) => {
      // الأقفال بترتيبٍ ثابت: رفعان متزامنان لا يتشابكان، وبصمة المندوب (قفلٌ واحد) تنتظر انتهاء الرفع
      for (const repId of reps) await lockRepAttendance(tx, repId);
      const now = new Date();
      let total = 0;
      for (const repId of reps) {
        const list = byRep.get(repId)!;
        list.sort((x, y) => x.s.checkInAt.getTime() - y.s.checkInAt.getTime());
        const good = list.filter((x) => Number.isFinite(x.s.checkInAt.getTime()));
        const minIn = good.length ? new Date(Math.min(...good.map((x) => x.s.checkInAt.getTime()))) : now;
        const maxEnd = good.length ? new Date(Math.max(...good.map((x) => (x.s.checkOutAt ?? now).getTime()))) : now;
        const known: ExistingShift[] = await shiftsAround(tx, tid, repId, { checkInAt: minIn, checkOutAt: maxEnd }, now);
        const accepted: ShiftTimes[] = [];
        for (const x of list) {
          const problem = shiftProblem(x.s, now);
          if (problem) { rejected.push({ index: x.index, message: problem }); continue; }
          if (overlappingShift(x.s, known, now)) { rejected.push({ index: x.index, message: 'تتداخل مع فترة أخرى للمندوب' }); continue; }
          known.push({ id: `import:${x.index}`, ...x.s });
          accepted.push(x.s);
        }
        if (!accepted.length) continue;
        // دفعةً واحدة لا صفّاً صفّاً: ألفا إدراجٍ متتابع على قاعدةٍ ضعيفة تتجاوز مهلة المعاملة
        await tx.repAttendance.createMany({
          data: accepted.map((s) => ({ tenantId: tid, salesRepId: repId, checkInAt: s.checkInAt, checkOutAt: s.checkOutAt, source: 'IMPORT', editedAt: now, editedBy: name })),
        });
        await tx.attendanceAudit.create({
          data: { tenantId: tid, salesRepId: repId, action: 'IMPORT', after: { count: accepted.length, rows: accepted.map(auditTimes) }, reason: b.reason, actorId: actorOf(req), actorName: name },
        });
        total += accepted.length;
      }
      return total;
    }, IMPORT_TX);
    rejected.sort((x, y) => x.index - y.index);
    res.json({ success: true, data: { created, rejected } });
  } catch (err) { fail(err, res, next); }
});

export default router;
