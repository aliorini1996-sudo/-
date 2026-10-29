// ============================================================================
// «طلب بضاعة» المندوب (طلب المالك، ١٥ أكتوبر ٢٠٢٦).
// المندوب الذي لا يملك صلاحية التحميل يرفع من «مخزون سيارتي» ما يحتاجه من كل صنف، فيظهر
// للإدارة في نافذة «طلب مخزون» بصفحة مخزون الشركة: تعدّل طلب كل مندوب، ثم ترسل الطلب العام
// (PDF للمشتريات/الإنتاج) فتُعلَّم الطلبات المشمولة «أُرسلت». طلبٌ لا حركة: لا يمسّ أي رصيد.
//
// كل كتابة — من المندوب أو الإدارة أو الإرسال — تمرّ تحت قفلٍ استشاريّ واحد للشركة، فلا يُكرَّر
// الطلب المعلّق للمندوب، ولا يُرسَل طلبٌ عدّله صاحبه بعد أن رآه الإداري (فحص updatedAt داخل القفل).
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAccounting, requireAdminPermission, isOwnerSession, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { scopedRepRecordWhere } from '../services/adminScope';
import { normalizeRepLines, mergeRepUpdate, applyAdminEdit, MAX_REQUEST_ITEMS, MAX_REQUEST_QTY, type OutLine } from '../services/repStockRequest';
import { baseQtyOf, toBase, unitFields } from '../services/units';
import { resolveLineUnits, UNIT_SELECT } from '../services/warehouseStock';

const router = Router();
router.use(authenticate);
router.use(requireAccounting); // عزل «النظام المحاسبي» كمخزون السيارة
router.use(requireAdminPermission('canManageVanStock')); // يمرّر المندوب؛ ويحرس مستخدمي الشركة

// الطلبات تُراجَع في صفحة مخزون الشركة، فبلا مستودعٍ مفعّل لا وجهة لها — والتطبيق يُبقي زرّ «تحميل» حينها
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { warehouseEnabled: true } });
    if (!t?.warehouseEnabled) { res.status(403).json({ success: false, code: 'WAREHOUSE_NOT_ENABLED', message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' }); return; }
    next();
  } catch (err) { fail(err, res, next); }
});

const repOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
  next();
};
const companyOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role === 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
  next();
};

const itemsSchema = z.array(z.object({
  productId: z.string().min(1).max(64),
  qty: z.number().finite().min(0).max(MAX_REQUEST_QTY), // بوحدة البند
  // وحدة البند. طلب المندوب: غائبة ⇒ وحدة الأساس بمعامل ١ (سلوك ما قبل الميزة).
  // تعديل الإدارة: غائبة (undefined) ⇒ وحدة سطر المندوب نفسه، وnull ⇒ الأساس صراحةً (services/repStockRequest applyAdminEdit)
  unitId: z.string().max(64).nullish(),
})).min(1).max(MAX_REQUEST_ITEMS);

/** السقف بالأساس: «١٠٠٠٠٠٠ كرتون» تعني ٢٤ مليون حبّة — خطأ إدخالٍ يمرّ من سقف الكمية الخام */
const overCap = (lines: { qty: number; unitFactor?: number | null }[]) => lines.some((l) => toBase(l.qty, l) > MAX_REQUEST_QTY);
const OVER_CAP = 'الكمية أكبر من الحد المسموح';

/** حقول سطرٍ يُكتب: ما طلبه المندوب، والمعتمد بلقطة وحدته وكميته بالأساس */
const fieldsOf = (l: OutLine) => ({ requestedQty: l.requestedQty, ...unitFields(l.qty, { name: l.unitName, factor: l.unitFactor }) });
const rowOf = (l: OutLine) => ({ productId: l.productId, ...fieldsOf(l) });

const ITEMS_INCLUDE = { items: { include: { product: { select: { name: true, code: true, unit: true, units: { select: UNIT_SELECT } } } } } } as const;
type RequestWithItems = Prisma.RepStockRequestGetPayload<{ include: typeof ITEMS_INCLUDE }>;

/**
 * `unit` وحدة السطر (لقطته، وإلا وحدة الصنف) فيُقرأ «١٠» بوحدتها لا كرتوناً وهي حبّات؛ و`baseQty`/`requestedBaseQty`
 * بوحدة الأساس `baseUnit` لمن يجمع طلبات المناديب في الطلب العام، و`units` لعرضها «X كرتون و Y حبة».
 */
const shape = (r: RequestWithItems) => ({
  id: r.id, status: r.status, note: r.note, createdAt: r.createdAt, updatedAt: r.updatedAt,
  decidedAt: r.decidedAt, sentRef: r.sentRef,
  items: r.items
    .map((i) => ({
      productId: i.productId, name: i.product.name, code: i.product.code, unit: i.unitName ?? i.product.unit, requestedQty: i.requestedQty, qty: i.qty,
      unitName: i.unitName, unitFactor: i.unitFactor, baseQty: baseQtyOf(i), requestedBaseQty: toBase(i.requestedQty, i),
      baseUnit: i.product.unit, units: i.product.units,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
});

/** قفل الشركة لكل كتابة على طلبات البضاعة (انظر رأس الملف) */
const lockTenant = (tx: Prisma.TransactionClient, tid: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rep-stock-request:' + tid}))`;

const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const notFound = () => Object.assign(new Error('الطلب غير موجود'), { status: 404 });

/** معالج الأخطاء العامّ يجعل كل Error ‏500؛ أخطاء هذا الموجّه المقصودة تحمل رمزها (409 يقول للواجهة «أعد التحميل») */
function fail(err: unknown, res: Response, next: NextFunction) {
  const status = (err as { status?: number })?.status;
  if (err instanceof Error && status && status >= 400 && status < 500) { res.status(status).json({ success: false, message: err.message }); return; }
  next(err);
}

/** «من قرّر»: جلسة المالك ومفتاحه يُسجَّلان «الدعم الفني» لا باسم مدير الشركة (وعد اتفاقية البيانات) */
const deciderName = (req: AuthRequest) => (isOwnerSession(req) || req.user?.ownerIssuedKey === true ? 'الدعم الفني' : req.user?.name || null);

// ---------------------------------------------------------------------------
// المندوب: طلبه المعلّق (إن وُجد) وآخر طلبٍ حُسم — ليعرف أأُرسل أم رُفض
// ---------------------------------------------------------------------------
router.get('/mine', repOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const me = req.user!.id;
    const [pending, last] = await Promise.all([
      prisma.repStockRequest.findFirst({ where: { tenantId: tid, salesRepId: me, status: 'PENDING' }, include: ITEMS_INCLUDE }),
      prisma.repStockRequest.findFirst({ where: { tenantId: tid, salesRepId: me, status: { in: ['SENT', 'REJECTED'] } }, orderBy: { decidedAt: 'desc' }, include: ITEMS_INCLUDE }),
    ]);
    res.json({ success: true, data: { pending: pending && shape(pending), last: last && shape(last) } });
  } catch (err) { fail(err, res, next); }
});

// رفع الطلب أو تحديثه: طلبٌ معلّق واحد للمندوب، والرفع الثاني يحلّ محلّ أصنافه (mergeRepUpdate يحفظ تعديل الإدارة لما لم يتغيّر)
router.put('/mine', repOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const me = req.user!.id;
    const data = z.object({ note: z.string().max(300).optional(), items: itemsSchema }).parse(req.body);
    // وحدة كل بند يحلّها الخادم (بلا unitId ⇒ الأساس)، ثم سطرٌ واحد لكل صنف (المفتاح الفريد requestId+productId)
    const units = await resolveLineUnits(tid, data.items);
    const lines = normalizeRepLines(data.items.map((i, idx) => ({ productId: i.productId, qty: i.qty, unitName: units[idx].name, unitFactor: units[idx].factor })));
    if (!lines.length) { res.status(400).json({ success: false, message: 'أضف صنفا وكمية صحيحة' }); return; }
    if (overCap(lines)) { res.status(400).json({ success: false, message: OVER_CAP }); return; }

    const ids = lines.map((l) => l.productId);
    const valid = await prisma.product.count({ where: { id: { in: ids }, tenantId: tid, deletedAt: null } });
    if (valid !== ids.length) { res.status(400).json({ success: false, message: 'منتج غير صالح' }); return; }
    const note = data.note?.trim() || null;

    const saved = await prisma.$transaction(async (tx) => {
      await lockTenant(tx, tid);
      const cur = await tx.repStockRequest.findFirst({ where: { tenantId: tid, salesRepId: me, status: 'PENDING' }, include: { items: true } });
      if (!cur) {
        return tx.repStockRequest.create({
          data: { tenantId: tid, salesRepId: me, note, items: { create: lines.map((l) => rowOf({ ...l, requestedQty: l.qty })) } },
          include: ITEMS_INCLUDE,
        });
      }
      const merged = mergeRepUpdate(cur.items, lines);
      await tx.repStockRequestItem.deleteMany({ where: { requestId: cur.id } });
      return tx.repStockRequest.update({
        where: { id: cur.id },
        // updatedAt صريحاً: هو «نسخة» الطلب التي يتحقّق منها تعديل الإدارة وإرسالها
        data: { note, updatedAt: new Date(), items: { create: merged.map(rowOf) } },
        include: ITEMS_INCLUDE,
      });
    });
    res.json({ success: true, data: shape(saved) });
  } catch (err) { fail(err, res, next); }
});

// المندوب يسحب طلبه المعلّق قبل أن يُرسَل
router.delete('/mine', repOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const me = req.user!.id;
    const n = await prisma.$transaction(async (tx) => {
      await lockTenant(tx, tid);
      return tx.repStockRequest.updateMany({
        where: { tenantId: tid, salesRepId: me, status: 'PENDING' },
        data: { status: 'CANCELLED', decidedAt: new Date(), decidedBy: req.user!.name || null },
      });
    });
    res.json({ success: true, data: { cancelled: n.count } });
  } catch (err) { fail(err, res, next); }
});

// ---------------------------------------------------------------------------
// الإدارة: الطلبات المعلّقة لمناديب نطاقها، تعديلها، رفضها، وإرسالها ضمن الطلب العام
// ---------------------------------------------------------------------------

/** نطاق المستخدم الإداري على المناديب: من لا يرى المندوب لا يرى طلبه ولا يعدّله */
async function repScopeWhere(req: AuthRequest): Promise<Prisma.RepStockRequestWhereInput> {
  return (await scopedRepRecordWhere(req)) as Prisma.RepStockRequestWhereInput;
}

router.get('/', companyOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = await prisma.repStockRequest.findMany({
      where: { tenantId: tid, status: 'PENDING', ...(await repScopeWhere(req)) },
      orderBy: { createdAt: 'asc' },
      include: { ...ITEMS_INCLUDE, salesRep: { select: { name: true } } },
    });
    res.json({ success: true, data: rows.map((r) => ({ ...shape(r), salesRepId: r.salesRepId, repName: r.salesRep.name })) });
  } catch (err) { fail(err, res, next); }
});

// الإرسال قبل /:id كي لا يُقرأ «send» معرّفاً
const sendSchema = z.object({
  ref: z.string().min(1).max(40),
  requests: z.array(z.object({ id: z.string().min(1).max(64), updatedAt: z.string().max(40) })).min(1).max(MAX_REQUEST_ITEMS),
});

router.post('/send', companyOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = sendSchema.parse(req.body);
    const want = new Map(data.requests.map((r) => [r.id, r.updatedAt]));
    const scope = await repScopeWhere(req);
    const n = await prisma.$transaction(async (tx) => {
      await lockTenant(tx, tid);
      const rows = await tx.repStockRequest.findMany({
        where: { id: { in: [...want.keys()] }, tenantId: tid, status: 'PENDING', ...scope },
        select: { id: true, updatedAt: true },
      });
      // طلبٌ غاب (أُرسل/سُحب/خارج النطاق) أو عدّله صاحبه بعد فتح النافذة: لا يُرسَل نصف ما رآه الإداري
      if (rows.length !== want.size || rows.some((r) => r.updatedAt.toISOString() !== want.get(r.id))) {
        throw conflict('تغيرت طلبات المناديب منذ فتح النافذة أعد فتحها وراجعها');
      }
      return tx.repStockRequest.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { status: 'SENT', decidedAt: new Date(), decidedBy: deciderName(req), sentRef: data.ref },
      });
    });
    res.json({ success: true, data: { sent: n.count } });
  } catch (err) { fail(err, res, next); }
});

const versionSchema = z.object({ updatedAt: z.string().max(40) });

/** يقرأ الطلب المعلّق داخل القفل ويتحقّق أنه النسخة التي رآها الإداري */
async function pendingForEdit(tx: Prisma.TransactionClient, req: AuthRequest, tid: string, id: string, seen: string) {
  const cur = await tx.repStockRequest.findFirst({ where: { id, tenantId: tid, status: 'PENDING', ...(await repScopeWhere(req)) }, include: { items: true } });
  if (!cur) throw notFound();
  if (cur.updatedAt.toISOString() !== seen) throw conflict('عدل المندوب طلبه للتو أعد فتح النافذة');
  return cur;
}

router.put('/:id', companyOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = versionSchema.extend({ items: itemsSchema }).parse(req.body);
    // وحدة التعديل: غائبةٌ ⇒ وحدة سطر المندوب (لا تُحلّ ولا تُمرَّر)، وnull ⇒ الأساس، ومعرّفٌ ⇒ وحدته من الصنف.
    // وحلّها قبل المعاملة: إعداد الوحدات ليس ممّا يحرسه قفل الطلبات
    const units = await resolveLineUnits(tid, data.items);
    const edits = data.items.map((i, idx) => ({
      productId: i.productId, qty: i.qty,
      ...(i.unitId !== undefined && { unitName: units[idx].name, unitFactor: units[idx].factor }),
    }));
    const saved = await prisma.$transaction(async (tx) => {
      await lockTenant(tx, tid);
      const cur = await pendingForEdit(tx, req, tid, String(req.params.id), data.updatedAt);
      const edit = applyAdminEdit(cur.items, edits);
      if (!edit.ok) throw Object.assign(new Error('الصنف ليس في طلب المندوب'), { status: 400 });
      if (overCap(edit.lines)) throw Object.assign(new Error(OVER_CAP), { status: 400 });
      for (const l of edit.lines) {
        // الكتابة بلقطة الوحدة كاملةً: تعديلٌ بوحدةٍ أخرى يعيد السطر إلى الأساس (طلب المندوب ومعتمد الإدارة معاً)
        await tx.repStockRequestItem.update({ where: { requestId_productId: { requestId: cur.id, productId: l.productId } }, data: fieldsOf(l) });
      }
      return tx.repStockRequest.update({ where: { id: cur.id }, data: { updatedAt: new Date() }, include: ITEMS_INCLUDE });
    });
    res.json({ success: true, data: shape(saved) });
  } catch (err) { fail(err, res, next); }
});

router.post('/:id/reject', companyOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = versionSchema.parse(req.body);
    await prisma.$transaction(async (tx) => {
      await lockTenant(tx, tid);
      const cur = await pendingForEdit(tx, req, tid, String(req.params.id), data.updatedAt);
      await tx.repStockRequest.update({ where: { id: cur.id }, data: { status: 'REJECTED', decidedAt: new Date(), decidedBy: deciderName(req) } });
    });
    res.json({ success: true });
  } catch (err) { fail(err, res, next); }
});

export default router;
