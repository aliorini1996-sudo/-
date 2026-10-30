import { Router, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { actorOf, authenticate, isOwnerSession, requireAdminPermission, requireLots, tenantId, type AdminPermission } from '../middleware/auth';
import { AuthRequest } from '../types';
import { adminRepFilter, adminScopeEnabled, canAccessRep, scopedRecordWhere, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { paginate, paginationMeta } from '../utils/helpers';
import { shelfLifeOf } from '../services/shelfLife';
import { addDays, isLocalDate } from '../services/gl/dates';
import { warehouseAsOf } from './warehouse';
import {
  LOT_BLOCK_KINDS, LOT_BUCKETS, LOT_EPS, LOT_MAX_ROWS, LOT_NUMBER_MAX, LOT_PLACES, LOT_RELABEL_REASONS, LOT_STATUSES, LotError,
  allocateOutLines, isLotExpiredOn, isLotQty, lotDatesProblem, lotErr, lotHttpError, lotMessage, multiLotWarning, normalizeLotNumber, roundLot,
  splitAvailability, zeroBuckets,
  type AllocRow, type LotBalance, type LotWarning, type OutLine, type PlaceLotView,
} from '../services/lots';
import {
  LOT_LOCK_TIMEOUT, acquireLotQueue, companyDay, lockLotProducts, lotMetaOf, placeViews, recordLotEvent, resolveOrCreateLot,
  type LotEventActor, type LotTx,
} from '../services/lotsDb';
import { relabelInTx } from '../services/lotsRelabel';
import {
  LOT_REP_GONE_NAME, lotEventVisible, lotHasReferences, lotHealth, lotSummaries, lotTrace, lotVanKeys, namedLotBalances, placeViewDto, trackingAttention,
  unloadPlan,
} from '../services/lotsTrace';

/**
 * «تتبّع اللوط» — /api/lots (المواصفة §٥.١، والتدفّقات §٤.٢ و§٤.٣ و§٤.٦ و§٤.١٦ و§٤.١٧ و§٤.٢٠). القواعد الصرفة في
 * services/lots.ts، والقفل والتجميع في services/lotsDb.ts، والتسمية في lotsRelabel.ts، والقراءات في lotsTrace.ts.
 *
 * - **الحرّاس بالترتيب:** المصادقة، ثم رفض المندوب (requireAdminPermission يمرّره بلا فحص)، ثم requireLots (المحاسبة ثم
 *   العَلَم: ACCOUNTING_NOT_ALLOWED / LOTS_NOT_ALLOWED)، ثم «إدارة مخزون السيارات». مفتاح API يمرّ بهوية مُصدِره كاللوحة.
 * - **كل كتابة** (إنشاء وتعديل وحالة وحذف وتسمية وتبديل التتبّع): الطابور داخل العملية قبل طلب اتصال (D29)، ثم المعاملة
 *   بمهلة اللوط (D13)، وأول ما فيها قفل الصنف (lockLotProducts) قبل أي قراءة رصيد أو كتابة، ثم LotEvent لكل تغيير (D27).
 * - **D27:** مدّ انتهاء لوطٍ له حركات، والإيقاف والسحب وإعادة التنشيط — لمستخدم غير مقيّد بنطاق (LOT_SCOPED_USER)
 *   وبسببٍ مكتوب (LOT_REASON_REQUIRED). والتسمية من موقوف أو منتهٍ مرفوضة (lotsRelabel.ts).
 * - **النطاق:** المقيّد يرى سيارات مناديبه وحدها (بلا سيارات المحذوفين)، وفواتير نطاقه في التتبّع (scopedRecordWhere).
 * - المسارات الثابتة قبل /:id.
 */
const router = Router();
router.use(authenticate);

// موجّه اللوحة وحدها — المندوب يرى لوطات سيارته من /van-stock/lot-balances. requireAdminPermission يمرّره بلا فحص فيُمنع صراحةً
router.use((req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role === 'SALES_REP') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
});
router.use(requireLots);
router.use(requireAdminPermission('canManageVanStock'));

/** D13: كل معاملةٍ فيها صنفٌ متتبَّع */
const LOT_TX = { maxWait: 10_000, timeout: 20_000 } as const;
/** D17 (افتراض المالك): البيع والتحميل من غير المسمّى بعد نفاد المسمّى المؤهَّل */
const LOTS_ALLOW_UNKNOWN = true;

/** الطابور قبل طلب اتصال من المجمّع (D29)، ثم المعاملة بمهلة اللوط — والتحرير في finally */
async function inLotTx<T>(tid: string, productIds: string[], fn: (tx: LotTx) => Promise<T>): Promise<T> {
  const release = await acquireLotQueue(tid, productIds);
  try {
    return await prisma.$transaction((tx) => fn(tx), LOT_TX);
  } finally {
    release();
  }
}

const LOT_ROW_SELECT = {
  id: true, productId: true, lotNumber: true, productionDate: true, expiryDate: true, status: true, blockKind: true, blockReason: true,
  blockedAt: true, blockedBy: true, note: true, source: true, createdBy: true, createdAt: true, updatedAt: true,
} as const;
type LotRow = Prisma.ProductLotGetPayload<{ select: typeof LOT_ROW_SELECT }>;
const SHELF_SELECT = { id: true, name: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true } as const;

/** صفّ product_lots ⇒ ProductLotDto (بلا tenantId ولا sourceEntryId) */
function lotDto(r: LotRow) {
  return {
    ...lotMetaOf(r),
    blockReason: r.blockReason ?? null, blockedBy: r.blockedBy ?? null, note: r.note ?? null,
    source: r.source, createdBy: r.createdBy ?? null, updatedAt: r.updatedAt,
  };
}

/** فاعل سجل التدقيق: المفتاح، أو جلسة الدعم الفني (المالك أو موظف المنصة)، أو مستخدم الشركة — والمعرّف بـactorOf */
function lotActor(req: AuthRequest): LotEventActor {
  const id = actorOf(req);
  if (req.user?.apiKeyId) return { type: 'API_KEY', id, name: req.user.name ?? null };
  if (isOwnerSession(req)) return { type: req.user?.byKind === 'STAFF' ? 'STAFF' : 'OWNER', id, name: 'الدعم الفني' };
  return { type: 'ADMIN', id, name: req.user?.name ?? null };
}

/** صلاحيةٌ بلا منع (لإخفاء جزءٍ من الردّ): كـrequireAdminPermission — جلسة المالك تمرّ، وfalse الصريحة وحدها تمنع */
async function hasPermission(req: AuthRequest, perm: AdminPermission): Promise<boolean> {
  if (isOwnerSession(req)) return true;
  const admin = await prisma.admin.findUnique({ where: { id: req.user!.id } });
  return !!admin?.isActive && (admin as unknown as Record<string, unknown>)[perm] !== false;
}

/** سيارات المستخدم المقيّد (مناديب نطاقه، بلا المحذوفين) — null لغير المقيّد (كل السيارات ومنها المحذوفة) */
async function visibleReps(req: AuthRequest, tid: string): Promise<Set<string> | null> {
  const filter = await adminRepFilter(req);
  if (!Object.keys(filter).length) return null;
  const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, ...filter }, select: { id: true } });
  return new Set(reps.map((r) => r.id));
}
const vanFilter = (vis: Set<string> | null) => (key: string, live: boolean) => !vis || (live && vis.has(key));

async function warehouseOn(tid: string): Promise<boolean> {
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { warehouseEnabled: true } });
  return t?.warehouseEnabled === true;
}

/** معامل استعلامٍ نصّي وحده (qs يحوّل ?x[in][]=… كائناً) */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const listParam = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
const uniq = (xs: (string | undefined | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];
const dayDate = (d: string | null): Date | null => (d ? new Date(`${d}T00:00:00.000Z`) : null);
const chunks = <T>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** اللوط في المسار غير موجود في الشركة ⇒ 404 (و422 حين يأتي في الجسم، §٣.٣) */
const lotGone = (lotId: string) => new LotError('LOT_NOT_FOUND', lotMessage('LOT_NOT_FOUND'), 404, { lotId });
const productGone = (res: Response) => res.status(404).json({ success: false, message: 'الصنف غير موجود' });

/** عرضٌ فيه شيء (رصيد صنفٍ أو خام أو محجوز لوط) — تُسقط السيارات الفارغة من ردّ الأرصدة */
function viewHasContent(v: PlaceLotView): boolean {
  if (v.total && LOT_BUCKETS.some((b) => Math.abs(v.total![b]) > LOT_EPS)) return true;
  return v.lots.some((l) => LOT_BUCKETS.some((b) => Math.abs(l.raw[b]) > LOT_EPS || Math.abs(l.held[b]) > LOT_EPS));
}

// ═══ القراءات الثابتة ═══

/**
 * البطاقات بحثاً وقائمة: q (رقمٌ مطبَّع أو اسم صنف)، productId، status (ACTIVE|BLOCKED)، expiringWithinDays (ما ينتهي خلال
 * N يوماً بيوم الشركة، والمنتهي ضمنه)، page وlimit (≤ ٢٠٠). كلٌّ بملخّص أرصدته (المستودع وسيارات النطاق).
 */
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = Math.max(1, Math.trunc(Number(req.query.page) || 1));
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit) || 50)));
    const q = str(req.query.q)?.trim();
    const productId = str(req.query.productId);
    const status = str(req.query.status);
    const within = str(req.query.expiringWithinDays);
    const where: Prisma.ProductLotWhereInput = { tenantId: tid };
    if (productId) where.productId = productId;
    if (status === 'ACTIVE' || status === 'BLOCKED') where.status = status;
    if (q) {
      const n = normalizeLotNumber(q);
      where.OR = [...(n ? [{ lotNumber: { contains: n } }] : []), { product: { name: { contains: q, mode: 'insensitive' as const } } }];
    }
    if (within !== undefined) {
      const days = Number(within);
      if (!Number.isInteger(days) || days < 0) { res.status(400).json({ success: false, message: 'عدد الأيام غير صالح' }); return; }
      const { day } = await companyDay(prisma, tid);
      where.expiryDate = { not: null, lte: dayDate(addDays(day, Math.min(days, 3650))) as Date };
    }
    const [total, rows] = await Promise.all([
      prisma.productLot.count({ where }),
      prisma.productLot.findMany({
        where, ...paginate(page, limit),
        orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { lotNumber: 'asc' }, { id: 'asc' }],
        select: { ...LOT_ROW_SELECT, product: { select: { name: true, code: true, unit: true } } },
      }),
    ]);
    const [wh, vis] = await Promise.all([warehouseOn(tid), visibleReps(req, tid)]);
    const sums = await lotSummaries(prisma, tid, rows.map((r) => ({ id: r.id, productId: r.productId })), { warehouse: wh, visibleVan: vanFilter(vis) });
    const data = rows.map((r) => {
      const s = sums.get(r.id);
      const summary = s ? { warehouse: s.warehouse, vans: s.vans, held: s.held, vanCount: s.vanCount, total: s.total } : null;
      return { ...lotDto(r), productName: r.product.name, productCode: r.product.code, productUnit: r.product.unit, summary };
    });
    res.json({ success: true, data, pagination: paginationMeta(total, page, limit), scoped: !!vis });
  } catch (err) { next(err); }
});

/**
 * أرصدة اللوطات لصنفٍ أو أصناف (≤ ٥٠) في المستودع وكل سيارة (§٥.١)، و«المخزون في تاريخ» بـasOf (§٤.٢٠): الحركات
 * والتسميات قبل نهاية اليوم، والفواتير بتاريخها — مرشّحات مسار المستودع نفسها (warehouseAsOf)، والحقبة كما هي.
 */
router.get('/balances', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const ids = uniq([str(req.query.productId), ...listParam(req.query.productIds)]);
    if (!ids.length) { res.status(400).json({ success: false, message: 'حدد الصنف' }); return; }
    if (ids.length > 50) { res.status(400).json({ success: false, message: 'خمسون صنفا على الأكثر في الطلب الواحد' }); return; }
    const pids = (await prisma.product.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true } })).map((p) => p.id);
    const asOf = str(req.query.asOf);
    const [before, wh, filter] = await Promise.all([warehouseAsOf(tid, asOf), warehouseOn(tid), adminRepFilter(req)]);
    const scoped = Object.keys(filter).length > 0;
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, ...filter }, select: { id: true, name: true } });
    const names = new Map(reps.map((r) => [r.id, r.name]));
    // سيارات المحذوفين لغير المقيّد وحده (المقيّد لا يُعرف نطاقه في مندوبٍ لم يعد موجوداً — كـ/warehouse/vans)
    const deleted = scoped || !pids.length ? [] : (await lotVanKeys(prisma, tid, { productIds: pids })).filter((k) => !names.has(k));
    const keys = [...reps.map((r) => r.id).sort(), ...deleted];
    const views = await placeViews(prisma, tid, { warehouse: wh, vanKeys: keys, productIds: pids, withTotals: true, before });
    const day = before && isLocalDate(asOf) ? asOf : (await companyDay(prisma, tid)).day;
    const dto = (v: PlaceLotView) => ({ ...placeViewDto(v), availability: splitAvailability(v, day, { allowUnknown: LOTS_ALLOW_UNKNOWN }) });
    const warehouse = wh ? pids.map((pid) => views.warehouse.get(pid)).filter((v): v is PlaceLotView => !!v).map(dto) : [];
    const vans: { salesRepId: string; repName: string | null; deleted: boolean; view: ReturnType<typeof dto> }[] = [];
    for (const key of keys) {
      for (const pid of pids) {
        const v = views.vans.get(key)?.get(pid);
        if (!v || !viewHasContent(v)) continue;
        vans.push({ salesRepId: key, repName: names.get(key) ?? LOT_REP_GONE_NAME, deleted: !names.has(key), view: dto(v) });
      }
    }
    res.json({ success: true, data: { asOf: before ? asOf : null, day, warehouse, vans, scoped } });
  } catch (err) { next(err); }
});

/**
 * عرض السيارة بعد إضافة صفوف تحميلٍ مقترح — لتحذير LOT_MULTI_IN_VAN بـmultiLotWarning نفسها (§٤.٧ الردّ). اللوط الجديد على
 * السيارة يأخذ بطاقته من عرض المستودع.
 */
function vanAfterLoad(van: PlaceLotView | undefined, wh: PlaceLotView, rows: AllocRow[]): PlaceLotView {
  const lots = new Map<string, LotBalance>((van?.lots ?? []).map((l) => [l.lotId, { ...l, usable: { ...l.usable } }]));
  for (const r of rows) {
    if (!r.lotId) continue;
    let l = lots.get(r.lotId);
    if (!l) {
      const w = wh.lots.find((x) => x.lotId === r.lotId);
      if (!w) continue;
      l = { lotId: r.lotId, meta: w.meta, raw: zeroBuckets(), held: zeroBuckets(), usable: zeroBuckets() };
      lots.set(r.lotId, l);
    }
    l.usable.SELLABLE = roundLot(l.usable.SELLABLE + r.qty);
  }
  return { ...wh, place: 'VAN', vanKey: van?.vanKey ?? null, lots: [...lots.values()] };
}

/** سقف أسطر الاقتراح في الطلب الواحد */
const FEFO_MAX_LINES = 50;
/** رتبة الخدمة في allocateOutLines (D22): الوحدة الأكبر أولاً — لاقتطاع المتاح عند النقص بالترتيب نفسه */
const serviceRank = (F: number) => (Number.isFinite(F) && F > 1 ? F : 1);

/**
 * أسطر الاقتراح: `lines` «كمية[:معامل]» مفصولةً بفاصلة — الكمية أساسية بأربع خانات والمعامل لقطة وحدة السطر (١ افتراضاً)؛
 * أو qty وunitFactor لسطرٍ واحد. صنفٌ في سطرين بوحدتين («٢ كرتون + ٥ حبة») يُقترح لكل سطرٍ من متاحٍ مشترك كما يوزّعه الحفظ
 * (allocateOutLines)، لا اقتراحين مستقلّين يأخذ كلٌّ منهما اللوط نفسه.
 */
function fefoLinesOf(req: AuthRequest, productId: string): OutLine[] | { status: 400; message: string } {
  const specs = req.query.lines !== undefined
    ? listParam(req.query.lines)
    : [`${str(req.query.qty) ?? ''}${req.query.unitFactor === undefined ? '' : `:${String(req.query.unitFactor)}`}`];
  if (!specs.length || specs.length > FEFO_MAX_LINES) return { status: 400, message: 'حدد كميات الأسطر خمسون سطرا على الأكثر' };
  const lines: OutLine[] = [];
  for (const [idx, s] of specs.entries()) {
    const [q, f] = s.split(':');
    const qty = Number(q);
    if (!q || !isLotQty(qty)) throw lotErr('LOT_QTY_INVALID', {}, { productId, wanted: q ?? null, line: idx, decimals: 4 });
    const unitFactor = f === undefined || f === '' ? 1 : Number(f);
    if (!(Number.isFinite(unitFactor) && unitFactor > 0)) return { status: 400, message: 'معامل الوحدة غير صالح' };
    lines.push({ idx, qty, unitFactor });
  }
  return lines;
}

/**
 * اقتراح التحميل من المستودع بـFEFO (قراءة بلا قفل؛ الخادم يعيد التحقق عند الحفظ): لكل سطرٍ بقاعدة الكرتون (D22) من متاحٍ
 * مشترك (fefoLinesOf). النقص يُعاد shortage مع اقتراح المتاح منه (الأسطر بترتيب الخدمة). وsalesRepId يضيف تحذير
 * LOT_MULTI_IN_VAN. شركةٌ بلا مستودع (D4) أو صنفٌ غير متتبَّع: لا اقتراح.
 */
router.get('/fefo', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const productId = str(req.query.productId);
    if (!productId) { res.status(400).json({ success: false, message: 'حدد الصنف' }); return; }
    const lines = fefoLinesOf(req, productId);
    if (!Array.isArray(lines)) { res.status(lines.status).json({ success: false, message: lines.message }); return; }
    const product = await prisma.product.findFirst({ where: { id: productId, tenantId: tid }, select: { id: true, name: true, lotTracked: true } });
    if (!product) { productGone(res); return; }
    const salesRepId = str(req.query.salesRepId);
    if (salesRepId) {
      // مندوبٌ قائم في الشركة وفي النطاق — canAccessRep وحدها تمرّر أي معرّف لغير المقيّد
      const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true } });
      if (!rep || !(await canAccessRep(req, tid, salesRepId))) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    }
    const wh = await warehouseOn(tid);
    const none = (extra: Record<string, unknown> = {}) => res.json({
      success: true, data: { rows: [], lines: lines.map((l) => ({ ...l, rows: [] })), warnings: [], ...extra },
    });
    if (!product.lotTracked || !wh) { none({ warehouse: wh, tracked: product.lotTracked }); return; }
    const { day } = await companyDay(prisma, tid);
    const views = await placeViews(prisma, tid, { warehouse: true, vanKeys: salesRepId ? [salesRepId] : [], productIds: [product.id], withTotals: true });
    const view = views.warehouse.get(product.id);
    if (!view) { none(); return; }
    const run = (ls: OutLine[]) => allocateOutLines({
      productId: product.id, productName: product.name, lines: ls, view, day, mode: 'LOAD', allowUnknown: LOTS_ALLOW_UNKNOWN,
    });
    let r = run(lines);
    let shortage: Record<string, unknown> | undefined;
    if (!r.ok) {
      if (r.error.code !== 'LOT_STOCK_INSUFFICIENT') throw r.error;
      shortage = r.error.detail;
      // المتاح كله مقتطعاً على الأسطر بترتيب الخدمة: الكراتين أولاً
      let left = roundLot(splitAvailability(view, day, { allowUnknown: LOTS_ALLOW_UNKNOWN }).available);
      const trimmed = new Map<number, number>();
      for (const l of [...lines].sort((a, b) => serviceRank(b.unitFactor) - serviceRank(a.unitFactor) || a.idx - b.idx)) {
        const q = roundLot(Math.max(0, Math.min(l.qty, left)));
        trimmed.set(l.idx, q);
        left = roundLot(left - q);
      }
      const partial = [...trimmed.values()].some((q) => q > LOT_EPS) ? run(lines.map((l) => ({ ...l, qty: trimmed.get(l.idx) ?? 0 }))) : null;
      r = partial && partial.ok ? partial : { ok: true, lines: new Map(lines.map((l) => [l.idx, []])), rows: [], warnings: [] };
    }
    const alloc = r.ok ? r : { lines: new Map<number, AllocRow[]>(), rows: [] as AllocRow[], warnings: [] as LotWarning[] };
    const warnings: LotWarning[] = [...alloc.warnings];
    if (salesRepId) {
      const multi = multiLotWarning(vanAfterLoad(views.vans.get(salesRepId)?.get(product.id), view, alloc.rows));
      if (multi) warnings.push(multi);
    }
    res.json({
      success: true,
      data: { rows: alloc.rows, lines: lines.map((l) => ({ ...l, rows: alloc.lines.get(l.idx) ?? [] })), ...(shortage && { shortage }), warnings },
    });
  } catch (err) { next(err); }
});

/** «سلامة الأرصدة»: كل خامٍ أو صالحٍ سالب لكل الأصناف المتتبَّعة والأماكن — والمقيّد يرى المستودع وسيارات نطاقه */
router.get('/health', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [h, vis] = await Promise.all([lotHealth(prisma, tid), visibleReps(req, tid)]);
    const deficits = vis ? h.deficits.filter((d) => d.place === 'WAREHOUSE' || (d.salesRepId != null && vis.has(d.salesRepId))) : h.deficits;
    res.json({ success: true, data: { deficits, scoped: !!vis } });
  } catch (err) { next(err); }
});

// ═══ الكتابات الثابتة ═══

const dateField = z.string().max(32).nullable().optional();
const createSchema = z.object({
  productId: z.string().min(1),
  lotNumber: z.union([z.string().max(256), z.number()]),
  productionDate: dateField,
  expiryDate: dateField,
  note: z.string().max(500).nullable().optional(),
});

/** إنشاء بطاقة (§٤.٣): الرقم المطبَّع القائم ⇒ 409 LOT_NUMBER_TAKEN بمعرّفه، والانتهاء إلزامي مع الصلاحية، ثم LotEvent CREATE */
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = createSchema.parse(req.body);
    const product = await prisma.product.findFirst({ where: { id: body.productId, tenantId: tid }, select: SHELF_SELECT });
    if (!product) { productGone(res); return; }
    const lotNumber = normalizeLotNumber(body.lotNumber);
    // رقمٌ أطول من الحدّ بعد التطبيع لا يُقصّ (القصّ يدمج تشغيلتين) — ورسالته غير «حدّد التشغيلة»
    if (!lotNumber && String(body.lotNumber).trim()) { res.status(400).json({ success: false, message: `رقم التشغيلة ${LOT_NUMBER_MAX} حرفا على الأكثر` }); return; }
    if (!lotNumber) throw lotErr('LOT_REQUIRED', { name: product.name }, { productId: product.id });
    const shelfLifeOn = shelfLifeOf(product) != null;
    const problem = lotDatesProblem(body.productionDate ?? null, body.expiryDate ?? null, { expiryRequired: shelfLifeOn });
    if (problem) throw lotErr(problem, {}, { productId: product.id, lotNumber });
    const actor = lotActor(req);
    const lot = await inLotTx(tid, [product.id], async (tx) => {
      await lockLotProducts(tx, tid, [product.id]);
      const taken = await tx.productLot.findUnique({ where: { tenantId_productId_lotNumber: { tenantId: tid, productId: product.id, lotNumber } }, select: { id: true } });
      if (taken) throw lotErr('LOT_NUMBER_TAKEN', {}, { id: taken.id, lotNumber });
      const r = await resolveOrCreateLot(tx, tid, { id: product.id, name: product.name, shelfLifeOn },
        { lotNumber, productionDate: body.productionDate ?? null, expiryDate: body.expiryDate ?? null },
        { source: 'MANUAL', createdBy: actor.id, note: body.note?.trim() || null, actor });
      // سبقنا مُدرِجٌ آخر بالرقم نفسه
      if (!r.created) throw lotErr('LOT_NUMBER_TAKEN', {}, { id: r.meta.id, lotNumber });
      return tx.productLot.findFirst({ where: { id: r.meta.id, tenantId: tid }, select: LOT_ROW_SELECT });
    });
    res.status(201).json({ success: true, data: lot ? lotDto(lot) : null });
  } catch (err) { next(err); }
});

const relabelSchema = z.object({
  productId: z.string().min(1),
  place: z.enum(LOT_PLACES),
  vanKey: z.string().min(1).nullable().optional(),
  salesRepId: z.string().min(1).optional(),
  bucket: z.enum(LOT_BUCKETS).optional(),
  fromLotId: z.string().min(1).max(128).nullable().optional(),
  reason: z.enum(LOT_RELABEL_REASONS),
  note: z.string().max(500).nullable().optional(),
  lines: z.array(z.object({
    toLotId: z.string().min(1).max(128).nullable().optional(),
    lotNumber: z.union([z.string().max(256), z.number()]).optional(),
    productionDate: dateField,
    expiryDate: dateField,
    qty: z.number(),
  })).min(1).max(LOT_MAX_ROWS),
});

/**
 * سيارةٌ يسمّي فيها المستخدم: مندوبٌ قائم في نطاقه (assertRepInScope)، أو سيارة مندوبٍ محذوف لغير المقيّد بشرط أثرٍ سابق لها
 * (D30) — بمصادر lotVanKeys نفسها التي تعرض بها الأرصدة والتتبّع وخطة التنزيل سيارات المحذوفين (تحميلاته المحفوظة، وصفوف
 * توزيع حركات السيارة والفواتير، والتسميات في السيارة)، فلا تُعرض سيارةٌ يُرفض تصحيحها. وإلا 404 لا 403 كي لا يكشف الردّ
 * وجود مندوبٍ خارج النطاق (كـvanStock.ts).
 */
async function vanInScope(req: AuthRequest, tid: string, key: string, scoped: boolean): Promise<boolean> {
  const rep = await prisma.salesRep.findFirst({ where: { id: key, tenantId: tid }, select: { id: true } });
  if (rep) return canAccessRep(req, tid, key);
  if (scoped) return false;
  if (await prisma.vanLoad.findFirst({ where: { tenantId: tid, deletedSalesRepId: key }, select: { id: true } })) return true;
  if (await prisma.vanLoadItemLot.findFirst({ where: { tenantId: tid, vanKey: key }, select: { id: true } })) return true;
  if (await prisma.invoiceItemLot.findFirst({ where: { tenantId: tid, vanKey: key }, select: { id: true } })) return true;
  return !!(await prisma.lotRelabel.findFirst({ where: { tenantId: tid, place: 'VAN', vanKey: key }, select: { id: true } }));
}

/** تسمية الرصيد القائم وإعادة التصنيف والتصحيح (§٤.٦) — قيود المصدر ومنع السالب في relabelInTx تحت القفل */
router.post('/relabel', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = relabelSchema.parse(req.body);
    const scoped = await adminScopeEnabled(req);
    const vanKey = body.place === 'VAN' ? (body.vanKey ?? body.salesRepId ?? null) : null;
    if (body.place === 'VAN') {
      if (!vanKey) { res.status(400).json({ success: false, message: 'حدد سيارة المندوب' }); return; }
      if (!(await vanInScope(req, tid, vanKey, scoped))) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    }
    const { day } = await companyDay(prisma, tid);
    const actor = lotActor(req);
    const data = await inLotTx(tid, [body.productId], (tx) => relabelInTx(tx, {
      tenantId: tid, productId: body.productId, place: body.place, vanKey, bucket: body.bucket ?? 'SELLABLE',
      fromLotId: body.fromLotId ?? null, reason: body.reason, note: body.note ?? null, day,
      actor: { type: actor.type, id: actor.id, name: actor.name, scoped },
      lines: body.lines.map((l) => ({
        toLotId: l.toLotId, lotNumber: l.lotNumber == null ? undefined : String(l.lotNumber),
        productionDate: l.productionDate ?? null, expiryDate: l.expiryDate ?? null, qty: l.qty,
      })),
    }));
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

const trackingSchema = z.object({
  enabled: z.boolean(),
  productIds: z.array(z.string().min(1)).max(1000).optional(),
  categoryId: z.string().min(1).optional(),
  all: z.literal(true).optional(),
  confirmLotBalances: z.boolean().optional(),
});
type TrackingRow = { id: string; lotTracked: boolean; lotTrackedSince: Date | null };

/**
 * التفعيل والإطفاء الجماعي لتتبّع الأصناف (§٤.٢) بصلاحية المنتجات أيضاً: دفعاتٌ بمئة صنف، في كلٍّ صفوف الأصناف FOR UPDATE
 * ثم أقفال اللوط بترتيب المفتاح (D25)، والحقبة عند كل انتقالٍ إلى التفعيل، وLotEvent لكل صنف. الإطفاء مع خامٍ مسمّى موجب
 * ⇒ 409 LOT_TRACKING_HAS_BALANCE ما لم يُرسل confirmLotBalances (D9) — يُفحص مسبقاً بلا قفل (فلا إطفاء جزئي) ثم تحت القفل.
 * الردّ needsAttention (بعد التفعيل): الأصناف ذات الرصيد غير المسمّى أو السالب في أي مكان — إجراء يوم التفعيل.
 */
router.post('/products/tracking', requireAdminPermission('canManageProducts'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = trackingSchema.parse(req.body);
    if ([body.productIds !== undefined, body.categoryId !== undefined, body.all === true].filter(Boolean).length !== 1) {
      res.status(400).json({ success: false, message: 'حدد الأصناف أو الفئة أو الكل' });
      return;
    }
    const where: Prisma.ProductWhereInput = body.productIds
      ? { tenantId: tid, id: { in: uniq(body.productIds) } }
      : body.categoryId ? { tenantId: tid, categoryId: body.categoryId, deletedAt: null } : { tenantId: tid, deletedAt: null };
    const products = await prisma.product.findMany({ where, select: { id: true, name: true, lotTracked: true }, orderBy: { id: 'asc' } });
    const changing = products.filter((p) => p.lotTracked !== body.enabled).map((p) => p.id);
    const confirm = body.confirmLotBalances === true;
    const names = new Map(products.map((p) => [p.id, p.name]));
    const hasBalance = (bal: Awaited<ReturnType<typeof namedLotBalances>>, updated: number) => lotErr('LOT_TRACKING_HAS_BALANCE', {}, {
      updated,
      products: bal.map((b) => ({ productId: b.productId, name: names.get(b.productId) ?? null, warehouse: b.warehouse, vans: b.vans, qty: roundLot(b.warehouse + b.vans.reduce((s, v) => s + v.qty, 0)) })),
    });
    if (!body.enabled && !confirm && changing.length) {
      const bal = await namedLotBalances(prisma, tid, changing);
      if (bal.length) throw hasBalance(bal, 0);
    }
    const actor = lotActor(req);
    let updated = 0;
    for (const batch of chunks(changing, 100)) {
      updated += await inLotTx(tid, batch, async (tx) => {
        // تبديل العلم يأخذ صفوف الأصناف FOR UPDATE (يتعارض مع FOR KEY SHARE في كل عملية لوط، D25) بمهلة انتظارٍ محلية تُستعاد
        const prevRows = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)`;
        const rows = await tx.$queryRaw<TrackingRow[]>`
          SELECT id, "lotTracked", "lotTrackedSince" FROM products
          WHERE "tenantId" = ${tid} AND id = ANY(${batch}::text[])
          ORDER BY id
          FOR UPDATE`;
        const change = rows.filter((r) => r.lotTracked !== body.enabled);
        const ids = change.map((r) => r.id);
        // ثم أقفال اللوط بترتيب المفتاح لكل صنفٍ يتبدّل — lotTracked: true يقفل الذي سيصير متتبَّعاً أيضاً
        await lockLotProducts(tx, tid, ids, { lockedRows: change.map((r) => ({ id: r.id, lotTracked: true, lotTrackedSince: r.lotTrackedSince })) });
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${prevRows[0]?.lock_timeout ?? '0'}, true)`;
        if (!change.length) return 0;
        if (!body.enabled && !confirm) {
          const bal = await namedLotBalances(tx, tid, ids);
          if (bal.length) throw hasBalance(bal, updated);
        }
        const now = new Date();
        await tx.product.updateMany({ where: { tenantId: tid, id: { in: ids } }, data: body.enabled ? { lotTracked: true, lotTrackedSince: now } : { lotTracked: false } });
        for (const r of change) {
          await recordLotEvent(tx, {
            tenantId: tid, lotId: null, productId: r.id, kind: body.enabled ? 'TRACKING_ON' : 'TRACKING_OFF',
            before: { lotTracked: r.lotTracked, lotTrackedSince: r.lotTrackedSince ? new Date(r.lotTrackedSince).toISOString() : null },
            after: { lotTracked: body.enabled, ...(body.enabled && { lotTrackedSince: now.toISOString() }) },
            reason: !body.enabled && confirm ? 'confirmLotBalances' : null, actor,
          });
        }
        return change.length;
      });
    }
    let needsAttention: Awaited<ReturnType<typeof trackingAttention>> = [];
    if (body.enabled && products.length) {
      const [wh, filter] = await Promise.all([warehouseOn(tid), adminRepFilter(req)]);
      const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, ...filter }, select: { id: true } });
      needsAttention = await trackingAttention(prisma, tid, products.map((p) => ({ id: p.id, name: p.name })), { warehouse: wh, vanKeys: reps.map((r) => r.id).sort() });
    }
    res.json({ success: true, data: { updated, needsAttention } });
  } catch (err) { next(err); }
});

/** «طباعة رقم التشغيلة على فاتورة العميل» (D15) — عمودٌ مستقل لا يمسّ printSettingsCore، بصلاحية إعدادات الشركة */
router.put('/settings', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { lotOnInvoice } = z.object({ lotOnInvoice: z.boolean() }).parse(req.body);
    const r = await prisma.companySettings.updateMany({ where: { tenantId: tenantId(req) }, data: { lotOnInvoice } });
    if (!r.count) { res.status(404).json({ success: false, message: 'أكمل إعدادات الشركة أولا' }); return; }
    res.json({ success: true, data: { lotOnInvoice } });
  } catch (err) { next(err); }
});

// ═══ مسارات اللوط (/:id) ═══

/** البطاقة وأرصدتها في المستودع وسيارات النطاق، وهل لها حركات (inUse: لا تُحذف، ومدّ انتهائها لغير المقيّد بسبب) */
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const lot = await prisma.productLot.findFirst({
      where: { id, tenantId: tid },
      select: { ...LOT_ROW_SELECT, product: { select: { ...SHELF_SELECT, code: true, unit: true, lotTracked: true } } },
    });
    if (!lot) throw lotGone(id);
    const [wh, vis, { day }] = await Promise.all([warehouseOn(tid), visibleReps(req, tid), companyDay(prisma, tid)]);
    const sums = await lotSummaries(prisma, tid, [{ id: lot.id, productId: lot.productId }], { warehouse: wh, visibleVan: vanFilter(vis) });
    const inUse = await lotHasReferences(prisma, tid, lot.id);
    const dto = lotDto(lot);
    res.json({
      success: true,
      data: {
        ...dto,
        product: { id: lot.product.id, name: lot.product.name, code: lot.product.code, unit: lot.product.unit, lotTracked: lot.product.lotTracked, shelfLifeOn: shelfLifeOf(lot.product) != null },
        expired: isLotExpiredOn(dto, day), day, inUse, summary: sums.get(lot.id) ?? null, scoped: !!vis,
      },
    });
  } catch (err) { next(err); }
});

const updateSchema = z.object({
  productionDate: dateField,
  expiryDate: dateField,
  note: z.string().max(500).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  updatedAt: z.string().min(1),
});

/** نسخة البطاقة التي فتحها المستخدم — اختلافها ⇒ LOT_CHANGED */
const sameVersion = (sent: string, current: Date) => {
  const t = Date.parse(sent);
  return Number.isFinite(t) && t === new Date(current).getTime();
};

/**
 * تعديل التواريخ والملاحظة (§٤.٣): مدّ الانتهاء (أو محوه) للوطٍ له حركات لغير المقيّد وبسبب (D27)، والتقصير حرّ. لقطات
 * InvoiceItemLot.expiryDate لا تتغيّر. ثم LotEvent UPDATE_DATES (أو UPDATE_NOTE) بالقيم قبل وبعد.
 */
router.patch('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const body = updateSchema.parse(req.body);
    const lot0 = await prisma.productLot.findFirst({ where: { id, tenantId: tid }, select: { id: true, productId: true } });
    if (!lot0) throw lotGone(id);
    const scoped = await adminScopeEnabled(req);
    const actor = lotActor(req);
    const lot = await inLotTx(tid, [lot0.productId], async (tx) => {
      await lockLotProducts(tx, tid, [lot0.productId]);
      const cur = await tx.productLot.findFirst({ where: { id, tenantId: tid }, select: LOT_ROW_SELECT });
      if (!cur) throw lotGone(id);
      if (!sameVersion(body.updatedAt, cur.updatedAt)) throw lotErr('LOT_CHANGED', {}, { lotId: id, updatedAt: cur.updatedAt });
      const meta = lotMetaOf(cur);
      const nextProd = body.productionDate === undefined ? meta.productionDate : (body.productionDate || null);
      const nextExp = body.expiryDate === undefined ? meta.expiryDate : (body.expiryDate || null);
      const nextNote = body.note === undefined ? (cur.note ?? null) : (body.note?.trim() || null);
      const datesChanged = nextProd !== meta.productionDate || nextExp !== meta.expiryDate;
      const noteChanged = nextNote !== (cur.note ?? null);
      if (!datesChanged && !noteChanged) return cur;
      if (datesChanged) {
        const product = await tx.product.findFirst({ where: { id: cur.productId, tenantId: tid }, select: SHELF_SELECT });
        const problem = lotDatesProblem(nextProd, nextExp, { expiryRequired: !!product && shelfLifeOf(product) != null });
        if (problem) throw lotErr(problem, {}, { lotId: id });
      }
      const reason = body.reason?.trim() || null;
      // مدّ الانتهاء (أو محوه) يعيد المنتهي إلى البيع — للوطٍ له حركات: لغير المقيّد وبسببٍ مكتوب (D27)
      const extendsExpiry = meta.expiryDate != null && (nextExp == null || nextExp > meta.expiryDate);
      if (extendsExpiry && (await lotHasReferences(tx, tid, id))) {
        if (scoped) throw lotErr('LOT_SCOPED_USER', {}, { lotId: id, change: 'EXTEND_EXPIRY' });
        if (!reason) throw lotErr('LOT_REASON_REQUIRED', {}, { lotId: id, change: 'EXTEND_EXPIRY' });
      }
      const upd = await tx.productLot.updateMany({
        where: { id, tenantId: tid, updatedAt: cur.updatedAt },
        data: { productionDate: dayDate(nextProd), expiryDate: dayDate(nextExp), note: nextNote },
      });
      if (!upd.count) throw lotErr('LOT_CHANGED', {}, { lotId: id });
      await recordLotEvent(tx, {
        tenantId: tid, lotId: id, productId: cur.productId, kind: datesChanged ? 'UPDATE_DATES' : 'UPDATE_NOTE',
        before: { productionDate: meta.productionDate, expiryDate: meta.expiryDate, ...(noteChanged && { note: cur.note ?? null }) },
        after: { productionDate: nextProd, expiryDate: nextExp, ...(noteChanged && { note: nextNote }) },
        reason, actor,
      });
      return tx.productLot.findFirst({ where: { id, tenantId: tid }, select: LOT_ROW_SELECT });
    });
    res.json({ success: true, data: lot ? lotDto(lot) : null });
  } catch (err) { next(err); }
});

const statusSchema = z.object({
  status: z.enum(LOT_STATUSES),
  blockKind: z.enum(LOT_BLOCK_KINDS).optional(),
  reason: z.string().max(500).nullable().optional(),
  updatedAt: z.string().min(1),
});

/**
 * الإيقاف (HOLD) والسحب (RECALL) وإعادة التنشيط (§٤.١٦): لغير المقيّد بنطاق، وبسببٍ إلزامي في الاتجاهين (D27)، تحت قفل
 * الصنف، ثم LotEvent BLOCK أو UNBLOCK. تصعيد الإيقاف إلى سحبٍ يُبقي لحظة الإيقاف الأولى (blockedAt: طبقة الإعادة ١ تعدّ
 * الموقوف بعد البيع، فتحريكها يفتح الموقوف لبيعٍ تمّ بعد إيقافه). blockKind الغائب يُبقي نوع الموقوف، والتنزيل من السحب إلى
 * الإيقاف بـblockKind: 'HOLD' صريحاً وحده.
 */
router.patch('/:id/status', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    if (await adminScopeEnabled(req)) throw lotErr('LOT_SCOPED_USER', {}, { lotId: id, change: 'STATUS' });
    const body = statusSchema.parse(req.body);
    const reason = (body.reason ?? '').trim();
    if (!reason) throw lotErr('LOT_REASON_REQUIRED', {}, { lotId: id, change: 'STATUS' });
    const lot0 = await prisma.productLot.findFirst({ where: { id, tenantId: tid }, select: { id: true, productId: true } });
    if (!lot0) throw lotGone(id);
    const actor = lotActor(req);
    const lot = await inLotTx(tid, [lot0.productId], async (tx) => {
      await lockLotProducts(tx, tid, [lot0.productId]);
      const cur = await tx.productLot.findFirst({ where: { id, tenantId: tid }, select: LOT_ROW_SELECT });
      if (!cur) throw lotGone(id);
      if (!sameVersion(body.updatedAt, cur.updatedAt)) throw lotErr('LOT_CHANGED', {}, { lotId: id, updatedAt: cur.updatedAt });
      // بلا blockKind: الموقوف يبقى بنوعه (طلبٌ يعيد الحالة لا ينزّل السحب إيقافاً بصمت فتُوسَم إعادته REPLAY_BLOCKED)، والنشط HOLD
      const kept = cur.status === 'BLOCKED' && (cur.blockKind === 'HOLD' || cur.blockKind === 'RECALL') ? cur.blockKind : 'HOLD';
      const blockKind = body.status === 'BLOCKED' ? (body.blockKind ?? kept) : null;
      if (cur.status === body.status && (cur.blockKind ?? null) === blockKind) return cur;
      const wasBlocked = cur.status === 'BLOCKED';
      const data = body.status === 'BLOCKED'
        ? { status: 'BLOCKED', blockKind, blockReason: reason, blockedAt: wasBlocked && cur.blockedAt ? cur.blockedAt : new Date(), blockedBy: wasBlocked && cur.blockedBy ? cur.blockedBy : actor.id }
        : { status: 'ACTIVE', blockKind: null, blockReason: null, blockedAt: null, blockedBy: null };
      const upd = await tx.productLot.updateMany({ where: { id, tenantId: tid, updatedAt: cur.updatedAt }, data });
      if (!upd.count) throw lotErr('LOT_CHANGED', {}, { lotId: id });
      await recordLotEvent(tx, {
        tenantId: tid, lotId: id, productId: cur.productId, kind: body.status === 'BLOCKED' ? 'BLOCK' : 'UNBLOCK',
        before: { status: cur.status, blockKind: cur.blockKind ?? null, blockReason: cur.blockReason ?? null },
        after: { status: body.status, blockKind, blockReason: body.status === 'BLOCKED' ? reason : null },
        reason, actor,
      });
      return tx.productLot.findFirst({ where: { id, tenantId: tid }, select: LOT_ROW_SELECT });
    });
    res.json({ success: true, data: lot ? lotDto(lot) : null });
  } catch (err) { next(err); }
});

/** حذف بطاقةٍ بلا أي مرجع في الجداول الأربعة (وإلا 409 LOT_IN_USE)، تحت قفل الصنف، ثم LotEvent DELETE (يبقى بعد الحذف) */
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const lot0 = await prisma.productLot.findFirst({ where: { id, tenantId: tid }, select: { id: true, productId: true } });
    if (!lot0) throw lotGone(id);
    const actor = lotActor(req);
    await inLotTx(tid, [lot0.productId], async (tx) => {
      await lockLotProducts(tx, tid, [lot0.productId]);
      const cur = await tx.productLot.findFirst({ where: { id, tenantId: tid }, select: LOT_ROW_SELECT });
      if (!cur) throw lotGone(id);
      if (await lotHasReferences(tx, tid, id)) throw lotErr('LOT_IN_USE', {}, { lotId: id });
      await tx.productLot.delete({ where: { id } });
      const m = lotMetaOf(cur);
      await recordLotEvent(tx, {
        tenantId: tid, lotId: id, productId: cur.productId, kind: 'DELETE',
        before: { lotNumber: m.lotNumber, productionDate: m.productionDate, expiryDate: m.expiryDate, status: m.status, source: cur.source },
        actor,
      });
    });
    res.json({ success: true, data: { id } });
  } catch (err) {
    // مرجعٌ كُتب بين الفحص والحذف (لصنفٍ غير متتبَّع لا يأخذ قفل اللوط): المفتاح الأجنبي NoAction يرفض الحذف
    if ((err as { code?: unknown })?.code === 'P2003') { next(lotErr('LOT_IN_USE', {}, { lotId: String(req.params.id) })); return; }
    next(err);
  }
});

/** شاشة التتبّع (§٤.١٧): STRICT ما سُجّل باللوط، وBROAD يضيف بيع الصنف من السيارة في نوافذ وجود اللوط فيها */
router.get('/:id/trace', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const scope = req.query.scope === 'BROAD' ? 'BROAD' : 'STRICT';
    const exists = await prisma.productLot.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
    if (!exists) throw lotGone(id);
    const [canSeeCustomers, scopeWhere, vis] = await Promise.all([
      hasPermission(req, 'canManageCustomers'), scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT), visibleReps(req, tid),
    ]);
    const data = await lotTrace(prisma, tid, id, {
      scope, canSeeCustomers, scopeWhere: Object.keys(scopeWhere).length ? scopeWhere : null, visibleReps: vis,
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

/** خطة التنزيل بعد الإيقاف أو السحب: لكل سيارةٍ فيها اللوط (والمحذوفة لغير المقيّد، D30) صالحه ومحجوزه */
router.get('/:id/unload-plan', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const exists = await prisma.productLot.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
    if (!exists) throw lotGone(id);
    const [rows, vis] = await Promise.all([unloadPlan(prisma, tid, id), visibleReps(req, tid)]);
    res.json({ success: true, data: vis ? rows.filter((r) => !r.deleted && vis.has(r.salesRepId)) : rows });
  } catch (err) { next(err); }
});

/**
 * سجل تدقيق اللوط (المادة ٥٢) — الأحدث أولاً، وlimit ≤ ٥٠٠. اللوط المحذوف يبقى سجلّه (lotId نصّ بلا مفتاح). والمقيّد لا يرى
 * تسميات سياراتٍ خارج نطاقه ولا سيارات المحذوفين (lotEventVisible، كسجلّ التتبّع)، وlimit على المرئي منه: دفعاتٌ بالترتيب
 * نفسه حتى يكتمل أو ينفد السجلّ.
 */
router.get('/:id/events', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit) || 200)));
    const [exists, vis] = await Promise.all([prisma.productLot.findFirst({ where: { id, tenantId: tid }, select: { id: true } }), visibleReps(req, tid)]);
    const page = (skip: number) => prisma.lotEvent.findMany({
      where: { tenantId: tid, lotId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: limit,
      select: { id: true, lotId: true, productId: true, kind: true, before: true, after: true, reason: true, actorType: true, actorName: true, createdAt: true },
    });
    const events: Awaited<ReturnType<typeof page>> = [];
    let seen = false;
    for (let skip = 0; ; skip += limit) {
      const rows = await page(skip);
      seen ||= rows.length > 0;
      for (const e of rows) if (events.length < limit && lotEventVisible(e.after, vis)) events.push(e);
      if (!vis || events.length >= limit || rows.length < limit) break;
    }
    if (!exists && !seen) throw lotGone(id);
    res.json({ success: true, data: events, scoped: !!vis });
  } catch (err) { next(err); }
});

// أخطاء اللوط برموزها وحالاتها (§٣.٣) — معالج الأخطاء العام يحوّل كل Error إلى 500. والانشغال (55P03 و40P01 وP2028
// والطابور) 503 LOT_BUSY: كل مسارات هذا الموجّه مسارات لوط. ثم 4xx ذات status كموجّه مخزون السيارات.
router.use((err: unknown, _req: AuthRequest, res: Response, next: NextFunction) => {
  // خطأ التحقق 400 من المعالج العام — ورسالته تحمل قيم الطلب فلا تُفحص بنمط الانشغال («lock timeout» في حقلٍ ليس 503)
  if (err instanceof ZodError) { next(err); return; }
  const lh = lotHttpError(err);
  if (lh) { res.status(lh.status).json(lh.body); return; }
  const status = (err as { status?: unknown })?.status;
  if (err instanceof Error && typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ success: false, message: err.message });
    return;
  }
  next(err);
});

export default router;
