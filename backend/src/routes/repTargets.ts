// ============================================================================
// «هدف الشهر» — أهداف المندوب الشهرية (طلب المالك ٩ نوفمبر ٢٠٢٦). الحساب كله في services/repTargets.ts.
//
// المندوب يقرأ أهدافه وحدها (GET /mine) ليراها دائماً في رئيسية تطبيقه، والإدارة تضبطها من صفحة «المناديب» بصلاحية
// إدارة المناديب (canManageSalesReps) — ومستخدم الشركة المقيَّد النطاق لا يبلغ إلا مناديب نطاقه (404 لغيرهم).
// وخلف «النظام المحاسبي» كله: بلا المحاسبة لا أرقام مالية تُعرض للمندوب أصلاً.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAccounting, requireAdmin, requireAdminPermission, tenantId, actorOf } from '../middleware/auth';
import { auditActorName } from '../services/attendanceEdit';
import { adminRepFilter } from '../services/adminScope';
import { UnitInvalidError } from '../services/warehouseStock';
// «الوحدة الرئيسية» §2.9: أساس صنف هدف الكمية كما رآه العميل يُقارن حيّاً، ثم تحت قفل صفّ الصنف (FOR KEY SHARE) في المعاملة
import {
  BASE_GUARD_TX, ProductUnitsBusyError, ProductUnitsChangedError, baseGuardReply, expectedBasesOf, lockBases, staleClientBase,
  type ExpectedBases,
} from '../services/baseGuard';
import { AuthRequest } from '../types';
import {
  MAX_TARGETS_PER_MONTH, MONTH_RE, NOTE_MAX, REWARD_KINDS, REWARD_VALUE_MAX, TARGET_KINDS, TARGET_MESSAGES, TARGET_VALUE_MAX,
  repTargetViewOf, repTargetsMonth, type TargetCode,
} from '../services/repTargets';

const router = Router();
router.use(authenticate, requireAccounting);

/** الشهر 'YYYY-MM' بسنةٍ معقولة (حدود الشهر تُحسب بالتقويم الميلادي بتوقيت الشركة) */
const monthSchema = z.string().regex(MONTH_RE).refine((m) => {
  const y = Number(m.slice(0, 4));
  return y >= 2000 && y <= 2100;
}, 'شهر غير صحيح');

/** ?month= اختياري: الغائب = الشهر الجاري بتوقيت الشركة، وغير الصالح 400 (errorHandler) */
const monthQuerySchema = z.object({ month: monthSchema.optional() });

/** معرّفٌ اختياري: الفارغ = null */
const nullableId = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(64).nullish());

/** جسم الإنشاء والتعديل — أرقامٌ صريحة منتهية (لا نصّ رقمي)، وحدود القيمة والمكافأة بحسب نوع كلٍّ منهما */
const targetInputSchema = z.object({
  month: monthSchema,
  kind: z.enum(TARGET_KINDS),
  targetValue: z.number().finite().positive(),
  productId: nullableId,
  unitId: nullableId,
  // اسم وحدة الصنف الصغرى (الأساس) كما رآها العميل: يختلف عن الصنف الآن (حُوِّل) ⇒ 400 UNIT_INVALID فيعيد العميل جلب الأصناف.
  // غائبٌ ⇒ الحكم كما كان، والسباق مع تحويلٍ يحرسه القفل في المعاملة
  baseUnitName: z.string().transform((v) => v.slice(0, 64)).nullish(),
  rewardKind: z.enum(REWARD_KINDS),
  rewardValue: z.number().finite().positive(),
  note: z.preprocess((v) => (typeof v === 'string' ? (v.trim() || null) : v), z.string().max(NOTE_MAX).nullish()),
}).superRefine((v, ctx) => {
  if (v.targetValue > TARGET_VALUE_MAX[v.kind]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetValue'], message: `قيمة الهدف لا تتجاوز ${TARGET_VALUE_MAX[v.kind]}` });
  }
  if (v.rewardValue > REWARD_VALUE_MAX[v.rewardKind]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rewardValue'], message: `قيمة المكافأة لا تتجاوز ${REWARD_VALUE_MAX[v.rewardKind]}` });
  }
});
type TargetInput = z.infer<typeof targetInputSchema>;

/** رفضٌ برمزه ورسالته العربية */
class TargetRefusal extends Error {
  constructor(readonly status: number, readonly code: TargetCode) { super(TARGET_MESSAGES[code]); }
}
const refuse = (res: Response, status: number, code: TargetCode): void => {
  res.status(status).json({ success: false, code, message: TARGET_MESSAGES[code] });
};
const fail = (err: unknown, res: Response, next: NextFunction): void => {
  if (err instanceof TargetRefusal) { refuse(res, err.status, err.code); return; }
  // تغيّر أساس الصنف أثناء الحفظ (baseGuard): 409 PRODUCT_UNITS_CHANGED، وانتظار قفل صفّه 503 PRODUCT_UNITS_BUSY
  const guard = err instanceof ProductUnitsChangedError || err instanceof ProductUnitsBusyError ? baseGuardReply(err, false) : null;
  if (guard) { res.status(guard.status).json(guard.body); return; }
  next(err);
};

type TargetSnapshot = { productId: string | null; productName: string | null; unitId: string | null; unitName: string | null; unitFactor: number };

/**
 * صنف هدف الكمية ولقطة وحدته (null = الأساس بمعامل ١)؛ وغير الكمية بلا صنفٍ ولا وحدة. و`bases` أساس الصنف كما قُرئ هنا — تُقفل
 * عليه المعاملة (lockBases) فلا تُكتب لقطةٌ حُلّت على أساسٍ بدّله تحويلٌ التزم بين القراءة والكتابة (×F صامت)
 */
async function productSnapshot(tid: string, body: TargetInput): Promise<{ snap: TargetSnapshot; bases: ExpectedBases | null }> {
  if (body.kind !== 'PRODUCT_QTY') return { snap: { productId: null, productName: null, unitId: null, unitName: null, unitFactor: 1 }, bases: null };
  if (!body.productId) throw new TargetRefusal(400, 'TARGET_PRODUCT_INVALID');
  const product = await prisma.product.findFirst({
    where: { id: body.productId, tenantId: tid, deletedAt: null },
    select: {
      id: true, name: true, unit: true, baseConvertedAt: true,
      units: { where: { tenantId: tid, isActive: true }, select: { id: true, name: true, factor: true } },
    },
  });
  if (!product) throw new TargetRefusal(400, 'TARGET_PRODUCT_INVALID');
  const bases = expectedBasesOf([product]);
  // كاش أصنافٍ قديم: «١٠٠ كرتون» بالأساس (unitId فارغ) والأساس صار حبّة ⇒ رفضٌ ظاهر لا هدف ١٠٠ حبّة صامت
  const stale = staleClientBase([{ productId: product.id, baseUnitName: body.baseUnitName }], bases, new Map([[product.id, product.baseConvertedAt]]));
  if (stale) throw new UnitInvalidError(`تغيّرت وحدات «${stale}» — حدّث قائمة الأصناف ثم أعد الحفظ`);
  if (!body.unitId) return { snap: { productId: product.id, productName: product.name, unitId: null, unitName: product.unit, unitFactor: 1 }, bases };
  const unit = product.units.find((u) => u.id === body.unitId);
  const factor = Number(unit?.factor);
  if (!unit || !Number.isFinite(factor) || factor <= 0) throw new TargetRefusal(400, 'TARGET_UNIT_INVALID');
  return { snap: { productId: product.id, productName: product.name, unitId: unit.id, unitName: unit.name, unitFactor: factor }, bases };
}

/** المندوب في الشركة وفي نطاق المستخدم — وإلا 404 (لا يُكشف وجود مندوبٍ خارج النطاق) */
async function repInScope(req: AuthRequest, tid: string, repId: string): Promise<boolean> {
  const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
  return rep !== null;
}

/** أهداف المندوب في الشهر تمرّ واحدةً واحدة: فلا يتجاوز طلبان متزامنان السقف */
const lockRepTargets = (tx: Prisma.TransactionClient, repId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rep-targets:' + repId}))`;

// ═══ المندوب: أهدافه وحدها ═══

router.get('/mine', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'هذا المسار للمندوب' }); return; }
    const tid = tenantId(req);
    const { month } = monthQuerySchema.parse(req.query);
    res.json({ success: true, data: await repTargetsMonth(tid, req.user.id, month) });
  } catch (err) { next(err); }
});

// ═══ الإدارة: صفحة «المناديب» (المندوب يُردّ هنا 403 بـrequireAdmin) ═══

router.use(requireAdmin, requireAdminPermission('canManageSalesReps'));

router.get('/rep/:repId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = String(req.params.repId);
    const { month } = monthQuerySchema.parse(req.query);
    if (!(await repInScope(req, tid, repId))) { refuse(res, 404, 'REP_NOT_FOUND'); return; }
    res.json({ success: true, data: await repTargetsMonth(tid, repId, month) });
  } catch (err) { next(err); }
});

router.post('/rep/:repId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = String(req.params.repId);
    if (!(await repInScope(req, tid, repId))) { refuse(res, 404, 'REP_NOT_FOUND'); return; }
    const body = targetInputSchema.parse(req.body);
    const { snap, bases } = await productSnapshot(tid, body);
    const created = await prisma.$transaction(async (tx) => {
      await lockRepTargets(tx, repId);
      // بعد قفل المندوب: أساس صنف هدف الكمية تحت قفل صفّه — تحويلٌ التزم بعد اللقطة أعلاه ⇒ 409 بلا كتابة
      if (bases) await lockBases(tx, tid, bases);
      const count = await tx.repTarget.count({ where: { tenantId: tid, salesRepId: repId, month: body.month } });
      if (count >= MAX_TARGETS_PER_MONTH) throw new TargetRefusal(409, 'TARGET_LIMIT');
      return tx.repTarget.create({
        data: {
          tenantId: tid, salesRepId: repId, month: body.month, kind: body.kind, targetValue: body.targetValue, ...snap,
          rewardKind: body.rewardKind, rewardValue: body.rewardValue, note: body.note ?? null,
          createdById: actorOf(req), createdByName: auditActorName(req),
        },
      });
    }, BASE_GUARD_TX);
    res.status(201).json({ success: true, data: await repTargetViewOf(tid, created) });
  } catch (err) { fail(err, res, next); }
});

/** الهدف في الشركة ثم مندوبه في نطاق المستخدم — وإلا 404 */
async function targetInScope(req: AuthRequest, res: Response, tid: string, id: string) {
  const target = await prisma.repTarget.findFirst({ where: { id, tenantId: tid } });
  if (!target) { refuse(res, 404, 'TARGET_NOT_FOUND'); return null; }
  if (!(await repInScope(req, tid, target.salesRepId))) { refuse(res, 404, 'REP_NOT_FOUND'); return null; }
  return target;
}

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const target = await targetInScope(req, res, tid, String(req.params.id));
    if (!target) return;
    const body = targetInputSchema.parse(req.body);
    const { snap, bases } = await productSnapshot(tid, body);
    const updated = await prisma.$transaction(async (tx) => {
      await lockRepTargets(tx, target.salesRepId);
      // كالإنشاء: لقطةٌ حُلّت على أساسٍ بدّله تحويلٌ متزامن لا تُكتب فوق ما أعاد التحويل كتابته
      if (bases) await lockBases(tx, tid, bases);
      // النقل إلى شهرٍ آخر يُعدّ على سقف ذلك الشهر
      if (body.month !== target.month) {
        const count = await tx.repTarget.count({ where: { tenantId: tid, salesRepId: target.salesRepId, month: body.month } });
        if (count >= MAX_TARGETS_PER_MONTH) throw new TargetRefusal(409, 'TARGET_LIMIT');
      }
      const r = await tx.repTarget.updateMany({
        where: { id: target.id, tenantId: tid },
        data: {
          month: body.month, kind: body.kind, targetValue: body.targetValue, ...snap,
          rewardKind: body.rewardKind, rewardValue: body.rewardValue, note: body.note ?? null,
        },
      });
      if (r.count === 0) throw new TargetRefusal(404, 'TARGET_NOT_FOUND');
      return tx.repTarget.findFirst({ where: { id: target.id, tenantId: tid } });
    }, BASE_GUARD_TX);
    if (!updated) { refuse(res, 404, 'TARGET_NOT_FOUND'); return; }
    res.json({ success: true, data: await repTargetViewOf(tid, updated) });
  } catch (err) { fail(err, res, next); }
});

router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const target = await targetInScope(req, res, tid, String(req.params.id));
    if (!target) return;
    const r = await prisma.repTarget.deleteMany({ where: { id: target.id, tenantId: tid } });
    if (r.count === 0) { refuse(res, 404, 'TARGET_NOT_FOUND'); return; }
    res.json({ success: true });
  } catch (err) { fail(err, res, next); }
});

export default router;
