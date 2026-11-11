// ============================================================================
// «هدف الشهر» — أهداف المندوب الشهرية (طلب المالك ٩ نوفمبر ٢٠٢٦). الحساب كله في services/repTargets.ts.
//
// المندوب يقرأ أهدافه وحدها (GET /mine) ليراها دائماً في رئيسية تطبيقه، والإدارة تضبطها من صفحة «المناديب» بصلاحية
// إدارة المناديب (canManageSalesReps) — ومستخدم الشركة المقيَّد النطاق لا يبلغ إلا مناديب نطاقه (404 لغيرهم).
// وخلف «النظام المحاسبي» كله: بلا المحاسبة لا أرقام مالية تُعرض للمندوب أصلاً.
// ============================================================================
import { randomUUID } from 'crypto';
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
  MAX_TARGETS_PER_MONTH, MAX_TARGET_PRODUCTS, MONTH_RE, NOTE_MAX, REWARD_KINDS, REWARD_VALUE_MAX, TARGET_KINDS, TARGET_MESSAGES, TARGET_VALUE_MAX,
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
  // «كمية صنف» بعدة أصناف (طلب المالك ١١ نوفمبر ٢٠٢٦): القائمة كاملةً بالترتيب (الأول = productId/unitId أعلاه)، لكلٍّ وحدته.
  // غائبةٌ أو فارغة ⇒ صنفٌ واحد من الحقول أعلاه كما كان
  products: z.array(z.object({
    productId: z.string().trim().min(1).max(64),
    unitId: nullableId,
    baseUnitName: z.string().transform((v) => v.slice(0, 64)).nullish(),
  })).max(MAX_TARGET_PRODUCTS).nullish(),
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
const NO_PRODUCT: TargetSnapshot = { productId: null, productName: null, unitId: null, unitName: null, unitFactor: 1 };

/**
 * أصناف هدف الكمية ولقطة وحدة كلٍّ (null = الأساس بمعامل ١): الأول في صفّ الهدف و`extras` بعده (RepTargetProduct)؛ وغير الكمية
 * بلا صنفٍ ولا وحدة. و`bases` أساس كل صنفٍ كما قُرئ هنا — تُقفل عليه المعاملة (lockBases) فلا تُكتب لقطةٌ حُلّت على أساسٍ بدّله
 * تحويلٌ التزم بين القراءة والكتابة (×F صامت). والصنف المكرّر في القائمة ⇒ 400 TARGET_PRODUCT_DUPLICATE
 */
async function productSnapshot(tid: string, body: TargetInput): Promise<{ snap: TargetSnapshot; extras: TargetSnapshot[]; bases: ExpectedBases | null }> {
  if (body.kind !== 'PRODUCT_QTY') return { snap: NO_PRODUCT, extras: [], bases: null };
  const lines = body.products && body.products.length
    ? body.products
    : [{ productId: body.productId ?? '', unitId: body.unitId ?? null, baseUnitName: body.baseUnitName ?? null }];
  if (lines.some((l) => !l.productId)) throw new TargetRefusal(400, 'TARGET_PRODUCT_INVALID');
  if (new Set(lines.map((l) => l.productId)).size !== lines.length) throw new TargetRefusal(400, 'TARGET_PRODUCT_DUPLICATE');
  const products = await prisma.product.findMany({
    where: { id: { in: lines.map((l) => l.productId) }, tenantId: tid, deletedAt: null },
    select: {
      id: true, name: true, unit: true, baseConvertedAt: true,
      units: { where: { tenantId: tid, isActive: true }, select: { id: true, name: true, factor: true } },
    },
  });
  if (products.length !== lines.length) throw new TargetRefusal(400, 'TARGET_PRODUCT_INVALID');
  const bases = expectedBasesOf(products);
  // كاش أصنافٍ قديم: «١٠٠ كرتون» بالأساس (unitId فارغ) والأساس صار حبّة ⇒ رفضٌ ظاهر لا هدف ١٠٠ حبّة صامت
  const stale = staleClientBase(lines.map((l) => ({ productId: l.productId, baseUnitName: l.baseUnitName })), bases,
    new Map(products.map((p) => [p.id, p.baseConvertedAt] as const)));
  if (stale) throw new UnitInvalidError(`تغيّرت وحدات «${stale}» — حدّث قائمة الأصناف ثم أعد الحفظ`);
  const snaps = lines.map((l): TargetSnapshot => {
    const product = products.find((p) => p.id === l.productId)!;
    if (!l.unitId) return { productId: product.id, productName: product.name, unitId: null, unitName: product.unit, unitFactor: 1 };
    const unit = product.units.find((u) => u.id === l.unitId);
    const factor = Number(unit?.factor);
    if (!unit || !Number.isFinite(factor) || factor <= 0) throw new TargetRefusal(400, 'TARGET_UNIT_INVALID');
    return { productId: product.id, productName: product.name, unitId: unit.id, unitName: unit.name, unitFactor: factor };
  });
  return { snap: snaps[0], extras: snaps.slice(1), bases };
}

/** «دمج الأهداف»: أهدافٌ للمندوب نفسه في الشهر نفسه تصير هدفاً واحداً بمكافأةٍ واحدة */
const comboSchema = z.object({
  targetIds: z.array(z.string().trim().min(1).max(64)).min(2).max(MAX_TARGETS_PER_MONTH),
  rewardKind: z.enum(REWARD_KINDS),
  rewardValue: z.number().finite().positive(),
}).superRefine((v, ctx) => {
  if (v.rewardValue > REWARD_VALUE_MAX[v.rewardKind]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rewardValue'], message: `قيمة المكافأة لا تتجاوز ${REWARD_VALUE_MAX[v.rewardKind]}` });
  }
});

/** هدفٌ مدمج بقي فيه عضوٌ واحد (حُذف الباقي أو نُقل لشهرٍ آخر) ⇒ يعود مستقلاً */
async function dissolveLoneCombo(tx: Prisma.TransactionClient, tid: string, comboId: string | null): Promise<void> {
  if (!comboId) return;
  const left = await tx.repTarget.count({ where: { tenantId: tid, comboId } });
  if (left < 2) await tx.repTarget.updateMany({ where: { tenantId: tid, comboId }, data: { comboId: null } });
}

/** صفوف الأصناف الإضافية لهدفٍ (RepTargetProduct) بترتيبها بعد الأول */
const extraRows = (tid: string, targetId: string, extras: readonly TargetSnapshot[]) =>
  extras.map((e, i) => ({ tenantId: tid, targetId, ...e, sortOrder: i + 1 }));
const WITH_EXTRAS = { extraProducts: { orderBy: { sortOrder: 'asc' as const } } };

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
    const { snap, extras, bases } = await productSnapshot(tid, body);
    const created = await prisma.$transaction(async (tx) => {
      await lockRepTargets(tx, repId);
      // بعد قفل المندوب: أساس أصناف هدف الكمية تحت قفل صفوفها — تحويلٌ التزم بعد اللقطة أعلاه ⇒ 409 بلا كتابة
      if (bases) await lockBases(tx, tid, bases);
      const count = await tx.repTarget.count({ where: { tenantId: tid, salesRepId: repId, month: body.month } });
      if (count >= MAX_TARGETS_PER_MONTH) throw new TargetRefusal(409, 'TARGET_LIMIT');
      const row = await tx.repTarget.create({
        data: {
          tenantId: tid, salesRepId: repId, month: body.month, kind: body.kind, targetValue: body.targetValue, ...snap,
          rewardKind: body.rewardKind, rewardValue: body.rewardValue, note: body.note ?? null,
          createdById: actorOf(req), createdByName: auditActorName(req),
        },
      });
      if (extras.length) await tx.repTargetProduct.createMany({ data: extraRows(tid, row.id, extras) });
      return tx.repTarget.findFirst({ where: { id: row.id, tenantId: tid }, include: WITH_EXTRAS });
    }, BASE_GUARD_TX);
    if (!created) { refuse(res, 404, 'TARGET_NOT_FOUND'); return; }
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
    const { snap, extras, bases } = await productSnapshot(tid, body);
    const updated = await prisma.$transaction(async (tx) => {
      await lockRepTargets(tx, target.salesRepId);
      // تحت القفل: الدمج والشهر كما هما الآن — دمجٌ أو نقلٌ متزامن التزم بين القراءة والقفل يُرى (لا عضوٌ وحيدٌ يتيم)
      const cur = await tx.repTarget.findFirst({ where: { id: target.id, tenantId: tid }, select: { comboId: true, month: true } });
      if (!cur) throw new TargetRefusal(404, 'TARGET_NOT_FOUND');
      // كالإنشاء: لقطةٌ حُلّت على أساسٍ بدّله تحويلٌ متزامن لا تُكتب فوق ما أعاد التحويل كتابته
      if (bases) await lockBases(tx, tid, bases);
      // النقل إلى شهرٍ آخر يُعدّ على سقف ذلك الشهر
      if (body.month !== cur.month) {
        const count = await tx.repTarget.count({ where: { tenantId: tid, salesRepId: target.salesRepId, month: body.month } });
        if (count >= MAX_TARGETS_PER_MONTH) throw new TargetRefusal(409, 'TARGET_LIMIT');
      }
      // «دمج الأهداف»: النقل لشهرٍ آخر يُخرجه من الهدف المدمج؛ وإلا فمكافأته مكافأة الأعضاء كلهم (تُنسخ عليهم)
      const leaving = cur.comboId != null && body.month !== cur.month;
      const r = await tx.repTarget.updateMany({
        where: { id: target.id, tenantId: tid },
        data: {
          month: body.month, kind: body.kind, targetValue: body.targetValue, ...snap,
          rewardKind: body.rewardKind, rewardValue: body.rewardValue, note: body.note ?? null,
          ...(leaving && { comboId: null }),
        },
      });
      if (r.count === 0) throw new TargetRefusal(404, 'TARGET_NOT_FOUND');
      if (leaving) await dissolveLoneCombo(tx, tid, cur.comboId);
      else if (cur.comboId) {
        await tx.repTarget.updateMany({ where: { tenantId: tid, comboId: cur.comboId }, data: { rewardKind: body.rewardKind, rewardValue: body.rewardValue } });
      }
      // الأصناف الإضافية تُستبدل بقائمة الجسم (وغير هدف الكمية بلا أصناف)
      await tx.repTargetProduct.deleteMany({ where: { tenantId: tid, targetId: target.id } });
      if (extras.length) await tx.repTargetProduct.createMany({ data: extraRows(tid, target.id, extras) });
      return tx.repTarget.findFirst({ where: { id: target.id, tenantId: tid }, include: WITH_EXTRAS });
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
    const r = await prisma.$transaction(async (tx) => {
      await lockRepTargets(tx, target.salesRepId);
      // تحت القفل: الدمج كما هو الآن (دمجٌ متزامن التزم بين القراءة والقفل يُرى)
      const cur = await tx.repTarget.findFirst({ where: { id: target.id, tenantId: tid }, select: { comboId: true } });
      const d = await tx.repTarget.deleteMany({ where: { id: target.id, tenantId: tid } });
      // عضوٌ حُذف من هدفٍ مدمج بقي فيه واحد ⇒ يعود مستقلاً
      await dissolveLoneCombo(tx, tid, cur?.comboId ?? null);
      return d;
    });
    if (r.count === 0) { refuse(res, 404, 'TARGET_NOT_FOUND'); return; }
    res.json({ success: true });
  } catch (err) { fail(err, res, next); }
});

// ═══ «دمج الأهداف» (طلب المالك ١١ نوفمبر ٢٠٢٦) ═══

/** دمج أهدافٍ مستقلة للمندوب نفسه في الشهر نفسه: معرّف دمجٍ واحد ومكافأةٌ واحدة تُنسخ على الأعضاء */
router.post('/combo', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = comboSchema.parse(req.body);
    const ids = [...new Set(body.targetIds)];
    if (ids.length < 2) throw new TargetRefusal(400, 'TARGET_COMBO_INVALID');
    const rows = await prisma.repTarget.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, salesRepId: true, month: true, comboId: true } });
    if (rows.length !== ids.length) throw new TargetRefusal(404, 'TARGET_NOT_FOUND');
    const repId = rows[0].salesRepId;
    if (rows.some((r) => r.salesRepId !== repId || r.month !== rows[0].month)) throw new TargetRefusal(400, 'TARGET_COMBO_INVALID');
    if (!(await repInScope(req, tid, repId))) { refuse(res, 404, 'REP_NOT_FOUND'); return; }
    const comboId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await lockRepTargets(tx, repId);
      // تحت القفل: ما زالت للمندوب والشهر نفسيهما ومستقلة
      const fresh = await tx.repTarget.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { salesRepId: true, month: true, comboId: true } });
      if (fresh.length !== ids.length) throw new TargetRefusal(404, 'TARGET_NOT_FOUND');
      if (fresh.some((r) => r.salesRepId !== repId || r.month !== rows[0].month)) throw new TargetRefusal(400, 'TARGET_COMBO_INVALID');
      if (fresh.some((r) => r.comboId)) throw new TargetRefusal(409, 'TARGET_IN_COMBO');
      await tx.repTarget.updateMany({ where: { tenantId: tid, id: { in: ids } }, data: { comboId, rewardKind: body.rewardKind, rewardValue: body.rewardValue } });
    });
    res.status(201).json({ success: true, data: { comboId } });
  } catch (err) { fail(err, res, next); }
});

/** فكّ الدمج: يعود كل عضوٍ هدفاً مستقلاً بمكافأته (المنسوخة) */
router.delete('/combo/:comboId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const comboId = String(req.params.comboId).slice(0, 64);
    const first = await prisma.repTarget.findFirst({ where: { tenantId: tid, comboId }, select: { salesRepId: true } });
    if (!first) { refuse(res, 404, 'TARGET_NOT_FOUND'); return; }
    if (!(await repInScope(req, tid, first.salesRepId))) { refuse(res, 404, 'REP_NOT_FOUND'); return; }
    await prisma.repTarget.updateMany({ where: { tenantId: tid, comboId }, data: { comboId: null } });
    res.json({ success: true });
  } catch (err) { fail(err, res, next); }
});

export default router;
