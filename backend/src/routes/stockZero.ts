// ============================================================================
// «تصفير المخزون» — GET /api/stock-zero/preview و POST /api/stock-zero (مُركَّب في index.ts)
// ----------------------------------------------------------------------------
// طلب المالك ١ نوفمبر ٢٠٢٦: زرٌّ واحد يصفّر مخزون الشركة كلّه — المستودع وكل سيارات المناديب القائمين (ومنهم الموقوفون) —
// بحركات تسوية عادية (ADJUST / DAMAGED_OUT / EXPIRED_OUT) موسومة بـzeroRunId، فيبقى التاريخ وتبدأ الشركة إدخال الوارد من جديد.
//   • لمدير الشركة (الدور من القاعدة: ADMIN فعّال في هذه الشركة غير مقيّد بنطاق ولم تُسحب منه صلاحية «مخزون السيارات»
//     canManageVanStock — من يُرفض في /api/warehouse و/api/van-stock لا يرى قيمة المخزون ولا يصفّره) أو جلسة مالك المنصة
//     وحدهما. مفتاح API مرفوض دائماً، وجلسة «دخول» موظف المنصة كذلك: قرارٌ لا رجعة فيه على مخزون الشركة كلها لا يُتّخذ
//     ببرنامج ولا بنيابة موظف.
//   • التأكيد بكتابة «تصفير»، وzeroRef يولّده العميل لكل محاولة: إعادة الطلب نفسه (انقطاع الشبكة) تردّ التشغيلة القائمة.
//   • التنفيذ معاملةٌ واحدة: قفلٌ استشاري للشركة (تصفيران متزامنان ⇒ 409)، ثم تجميد كل أصناف الشركة FOR UPDATE، ثم الأرصدة
//     الدقيقة **داخل** المعاملة، ثم الكتابة، ثم إعادة الحساب.
//     من ينتظر التجميد: كل كاتبٍ **يُدرج** صفّاً يشير إلى الصنف بمفتاحه الأجنبي (أسطر الفاتورة، وأسطر تحميل السيارة وتسويتها،
//     وأسطر وارد المستودع) — الإدراج يأخذ FOR KEY SHARE على الصنف فيصطدم بـFOR UPDATE وينتظر التزامنا.
//     ومن لا ينتظره: كتّابٌ يغيّرون الرصيد بتحديث حالةٍ لا بإدراج (إلغاء فاتورة، وPATCH /invoices/:id/restock، وإلغاء مرتجع)
//     لا يلمسون صفّ الصنف فيمضون. هؤلاء يغطّيهم إعادة الحساب: كلٌّ عبارةٌ بلقطةٍ جديدة (READ COMMITTED) فترى ما التزموه أثناء
//     التصفير بقيّةً ⇒ تراجعٌ كامل و503 STOCK_ZERO_BUSY قابلٌ للإعادة (لا خطأ سلامة)، وما التزموه بعدها حركةٌ لاحقة كأي حركة.
//   • عهدة الأدوات لا تُمسّ، وسيارات المناديب المحذوفين لا تُمسّ (رصيدها مجهول) وتُعدّ، وأجهزة المناديب بصندوقٍ صادر غير مرفوع
//     تظهر في المعاينة — بلا تعويض في الإصدار الأول.
// «تصفير سيارة مندوب واحدة» (طلب المالك ١٨ نوفمبر ٢٠٢٦): salesRepId اختياريٌّ في المعاينة (query) والتنفيذ (body) — حين يُرسَل
//   تُصفَّر سيارة هذا المندوب وحدها (ومنه الموقوف)، والمستودع وبقية السيارات لا تُمسّ، والتشغيلة warehouseZeroed = false وملخّصها
//   scope: 'VAN' باسم المندوب. مندوبٌ من شركة أخرى أو محذوف ⇒ 404 STOCK_ZERO_REP_NOT_FOUND. والحرّاس والقفل الاستشاري (واحدٌ للشركة:
//   تصفير سيارةٍ وتصفير الشركة لا يتزامنان) وتجميد الأصناف وzeroRef والتحقق بعد الكتابة كما هي حرفاً.
// «أصناف اللوط تُصفَّر تشغيلةً تشغيلة» (طلب المالك ١٨ نوفمبر ٢٠٢٦ — كان 409 STOCK_ZERO_LOT_TRACKED): والميزة مفعّلة يُؤخذ طابور
//   أصناف اللوط داخل العملية قبل طلب اتصال المعاملة (acquireLotQueue، D29)، وداخلها بعد تجميد الأصناف FOR UPDATE قفلُ اللوط الاستشاري
//   لكل صنفٍ متتبَّع بترتيب المفتاح على الصفوف المقفلة نفسها (lockLotProducts بـlockedRows — موضع قفل اللوط الوحيد، وترتيب المنصّة:
//   صفوف الأصناف ثم أقفال اللوط)، والمتتبَّع تحت القفل هو المرجع (D25). ثم أرصدة التشغيلات في الخطة والكتابة والتحقق بعدها
//   (services/stockZero.ts)، والمعاينة تعرض أصناف اللوط بتشغيلاتها. والميزة مطفأة: لا طابور ولا قفل لوط ولا قراءة — كما كان.
// الاعتماديات مُحقنة (createStockZeroRouter) فتختبرها tests/stock-zero.test.ts بقاعدة مزيّفة في الذاكرة بلا شبكة.
// ============================================================================
import { NextFunction, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../config/database';
import { actorOf, authenticate, isOwnerSession, requireAccounting, requireAdmin, tenantId as tenantIdOf } from '../middleware/auth';
import { adminScopeEnabled } from '../services/adminScope';
import { acquireLotQueue, lockLotProducts } from '../services/lotsDb';
import { isStaffImpersonation } from '../services/platformAccess';
import { tenantCurrencyDecimals } from '../services/warehouseStock';
import {
  PENDING_DEVICE_DAYS, STOCK_ZERO_CONFIRM_WORD, STOCK_ZERO_LOT_PREVIEW_LIMIT, STOCK_ZERO_SUPPORT_NAME, StockZeroError,
  alreadyZeroResult, isStockZeroBusy, loadValuation, loadZeroBalances, lotPreviewOf, planStockZero, residualsOf, runSummaryOf, stockZeroAuditLine,
  totalsOf, vanLoadCountOf, writeStockZero, type StockZeroRep, type ZeroProduct,
} from '../services/stockZero';
import type { AuthRequest } from '../types';

export interface StockZeroDeps {
  db: PrismaClient;
  /** حرّاس الموجّه (الإنتاج: authenticate ثم requireAccounting ثم requireAdmin) — الاختبار يحقن هويته ويُبقي requireAdmin */
  guards?: RequestHandler[];
  /** هل المستخدم مقيّد النطاق؟ (الإنتاج: adminScopeEnabled — من القاعدة لا التوكن) */
  scopeEnabled(req: AuthRequest): Promise<boolean>;
  tenantId(req: AuthRequest): string;
  /** خانات عملة الشركة (الإنتاج: tenantCurrencyDecimals) */
  decimals(tid: string): Promise<number>;
  /** سطر التدقيق (JSON) بعد الالتزام — افتراضياً console.warn */
  audit?(line: string): void;
  now?(): Date;
}

/** مهلة المعاملة: انتظار اتصالٍ ١٠ ثوانٍ، والتنفيذ حتى دقيقة (شركةٌ بآلاف الأصناف وعشرات السيارات) */
export const STOCK_ZERO_TX = Object.freeze({ maxWait: 10_000, timeout: 60_000 });
/** مهلة انتظار قفل كل صنف داخل المعاملة — كاتبٌ ممسكٌ بصنفٍ طويلاً ⇒ 503 فيُعاد بعد لحظات لا انتظار دقيقة */
export const STOCK_ZERO_LOCK_TIMEOUT = '5s';

// salesRepId غائبٌ = الشركة كلها؛ وnull أو نصٌّ فارغ مرفوضٌ (400) لا «الشركة كلها» — عميلٌ أخطأ في سيارةٍ لا يصفّر كل شيء
const bodySchema = z.object({ confirm: z.string().max(100), zeroRef: z.string().uuid(), salesRepId: z.string().trim().min(1).max(100).optional() }).strict();

/** salesRepId المعاينة من الاستعلام: غائبٌ ⇒ null (الشركة كلها)، ونصٌّ غير فارغ ⇒ هو، وغير ذلك (مكرّر أو فارغ) ⇒ undefined (رفض) */
function repQueryOf(req: AuthRequest): string | null | undefined {
  const v = req.query.salesRepId;
  if (v === undefined) return null;
  if (typeof v !== 'string') return undefined;
  const id = v.trim();
  return id && id.length <= 100 ? id : undefined;
}

/** حدّ أسطر البقيّة في سجلّ الخادم — ألف صنفٍ متبقٍّ لا يُغرق السجلّ */
const RESIDUAL_LOG_LIMIT = 20;

// بيانات رفضٍ دون 5xx وحدها للعميل: بيانات 5xx (أسطر البقيّة) للسجلّ لا للعميل
const reply = (res: Response, e: StockZeroError) => {
  res.status(e.status).json({ success: false, code: e.code, message: e.message, ...(e.data !== undefined && e.status < 500 && { data: e.data }) });
};

/** ردّ تشغيلةٍ قائمة (إعادة الطلب بالـzeroRef نفسه): النتيجة المحفوظة في ملخّصها كما رُدّت أول مرة */
function resultOfRun(run: { id: string; summary: Prisma.JsonValue; warehouseEntryId: string | null; vanLoadCount: number }) {
  const s = run.summary as { result?: unknown } | null;
  if (s && typeof s === 'object' && s.result && typeof s.result === 'object') return s.result;
  return { runId: run.id, alreadyZero: false, warehouse: { entryId: run.warehouseEntryId }, vans: { loads: run.vanLoadCount } };
}

const RUN_SELECT = { id: true, summary: true, warehouseEntryId: true, vanLoadCount: true } as const;
const LAST_RUN_SELECT = { id: true, createdAt: true, actorName: true } as const;

export function createStockZeroRouter(deps: StockZeroDeps): Router {
  const router = Router();
  const db = deps.db;
  const audit = deps.audit ?? ((line: string) => console.warn(line));
  const now = deps.now ?? (() => new Date());
  for (const g of deps.guards ?? [authenticate, requireAccounting, requireAdmin]) router.use(g);

  /**
   * من يصفّر — بالترتيب: (١) مفتاح API لا يقرّر هذا أبداً، (٢) جلسة موظف المنصة كذلك، (٣) جلسة المالك تمرّ (لا دور ولا نطاق
   * يقيّدها)، وإلا فالدور من القاعدة لا التوكن (مديرٌ عُطّل أو نُقل أو خُفّض يسري عليه فوراً)، ثم النطاق: المقيّد لا يقرّر للشركة كلها،
   * ثم صلاحية «مخزون السيارات»: مديرٌ سُحبت منه (companyUsers يسمح بذلك) مرفوضٌ في /api/warehouse و/api/van-stock فلا يرى قيمة
   * المخزون هنا ولا يصفّره — بعرف requireAdminPermission نفسه (`=== false`: الغائب/null يمرّ كالحسابات القديمة).
   */
  const refusal = async (req: AuthRequest): Promise<StockZeroError | null> => {
    if (req.user?.apiKeyId) return new StockZeroError(403, 'API_KEY_FORBIDDEN');
    if (isStaffImpersonation(req)) return new StockZeroError(403, 'STOCK_ZERO_ADMIN_ONLY');
    if (isOwnerSession(req)) return null;
    const tid = deps.tenantId(req);
    const row = await db.admin.findUnique({
      where: { id: req.user?.id ?? '' },
      select: { role: true, tenantId: true, isActive: true, scopeEnabled: true, canManageVanStock: true },
    });
    if (!(row?.role === 'ADMIN' && row.tenantId === tid && row.isActive === true)) return new StockZeroError(403, 'STOCK_ZERO_ADMIN_ONLY');
    if (row.scopeEnabled === true || await deps.scopeEnabled(req)) return new StockZeroError(403, 'STOCK_ZERO_SCOPED');
    if (row.canManageVanStock === false) return new StockZeroError(403, 'STOCK_ZERO_ADMIN_ONLY');
    return null;
  };

  /** مندوب «تصفير سيارة واحدة» من هذه الشركة (ومنه الموقوف) — null لمندوب شركةٍ أخرى أو محذوف */
  const repOf = async (client: Pick<Prisma.TransactionClient, 'salesRep'>, tid: string, id: string): Promise<StockZeroRep | null> =>
    client.salesRep.findFirst({ where: { id, tenantId: tid }, select: { id: true, name: true } });

  /** آخر تصفيرٍ مسّ سيارة المندوب (للشركة كلها أو لسيارته وحدها): من آخر حركة تصفيرٍ على سيارته — كحدّ دفعات الصلاحية */
  const lastVanRunOf = async (tid: string, repId: string) => {
    const z = await db.vanLoad.findFirst({
      where: { tenantId: tid, salesRepId: repId, zeroRunId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { zeroRunId: true },
    });
    return z?.zeroRunId ? db.stockZeroRun.findFirst({ where: { id: z.zeroRunId, tenantId: tid }, select: LAST_RUN_SELECT }) : null;
  };

  // المعاينة: ما سيُصفَّر وقيمته، وأصناف اللوط بتشغيلاتها كما ستُصفَّر، وما يستحقّ التنبيه (أجهزة بصندوقٍ صادر)، وآخر تصفير.
  // وبـ?salesRepId= سيارة ذلك المندوب وحدها: لا مستودع ولا سيارات أخرى ولا محذوفين، وجهازه هو، وآخر تصفيرٍ مسّ سيارته
  router.get('/preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const denied = await refusal(req);
      if (denied) { reply(res, denied); return; }
      const tid = deps.tenantId(req);
      const repId = repQueryOf(req);
      const rep = repId ? await repOf(db, tid, repId) : null;
      if (repId === undefined || (repId && !rep)) { reply(res, new StockZeroError(404, 'STOCK_ZERO_REP_NOT_FOUND')); return; }
      const [tenant, products, reps, lastRun, dec] = await Promise.all([
        db.tenant.findUnique({ where: { id: tid }, select: { warehouseEnabled: true, lotTrackingEnabled: true } }),
        // كل الأصناف ومنها المعطّلة: بضاعتها قد تبقى في المستودع أو السيارات
        db.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, lotTracked: true }, orderBy: { id: 'asc' } }),
        // كل المناديب القائمين ومنهم الموقوفون — سيارة الموقوف تُصفَّر أيضاً (أو المندوب المختار وحده)
        rep ? [{ id: rep.id, name: rep.name }] : db.salesRep.findMany({ where: { tenantId: tid }, select: { id: true, name: true } }),
        rep ? lastVanRunOf(tid, rep.id) : db.stockZeroRun.findFirst({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, select: LAST_RUN_SELECT }),
        deps.decimals(tid),
      ]);
      const lotsOn = tenant?.lotTrackingEnabled === true;
      // «تتبّع اللوط»: تشغيلات الأصناف المتتبَّعة وبطاقاتها (رقمها وانتهاؤها) للعرض — قراءةٌ بلا قفل (المعاينة عرضٌ لا عقد)
      const lotProductIds = lotsOn ? products.filter((p) => p.lotTracked === true).map((p) => p.id) : [];
      const balances = await loadZeroBalances(db, tid, { productIds: products.map((p) => p.id), repIds: reps.map((r) => r.id), lotProductIds }, { vansOnly: !!rep, lotMetas: true });
      const plan = planStockZero({
        // سيارةٌ واحدة: المستودع خارج النطاق كأنه مطفأ — لا سطر له ولا قسم في المعاينة
        products, warehouseEnabled: !rep && tenant?.warehouseEnabled === true, lotTrackingEnabled: lotsOn, balances,
      });
      const lotItems = lotPreviewOf(plan, {
        metas: balances.lots?.metas ?? new Map(), productNames: new Map(products.map((p) => [p.id, p.name])), repNames: new Map(reps.map((r) => [r.id, r.name])),
      });
      const totals = totalsOf(plan, await loadValuation(db, tid, dec));
      const since = new Date(now().getTime() - PENDING_DEVICE_DAYS * 86_400_000);
      const pending = await db.salesRep.findMany({
        where: { tenantId: tid, ...(rep && { id: rep.id }), outboxPending: { gt: 0 }, lastSeenAt: { gte: since } },
        select: { id: true, name: true, outboxPending: true }, orderBy: { name: 'asc' },
      });
      res.json({
        success: true,
        data: {
          ...(rep && { scope: 'VAN', salesRep: rep }),
          warehouse: totals.warehouse,
          vans: totals.vans,
          lotProducts: lotItems.slice(0, STOCK_ZERO_LOT_PREVIEW_LIMIT),
          lotProductsTotal: lotItems.length,
          pendingDevices: pending.map((r) => ({ repId: r.id, name: r.name, outboxPending: r.outboxPending ?? 0 })),
          lastRun: lastRun ? { id: lastRun.id, createdAt: lastRun.createdAt, actorName: lastRun.actorName } : null,
          alreadyZero: plan.alreadyZero,
          currencyDecimals: dec,
        },
      });
    } catch (err) { next(err); }
  });

  router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const denied = await refusal(req);
      if (denied) { reply(res, denied); return; }
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success || parsed.data.confirm.trim() !== STOCK_ZERO_CONFIRM_WORD) { reply(res, new StockZeroError(400, 'STOCK_ZERO_CONFIRM_REQUIRED')); return; }
      const tid = deps.tenantId(req);
      const { zeroRef } = parsed.data;
      const repId = parsed.data.salesRepId ?? null;
      const runKey = { tenantId_zeroRef: { tenantId: tid, zeroRef } };

      // إعادة الطلب نفسه بعد نجاحه: ردّه المحفوظ بلا معاملة ولا صفّ
      const prior = await db.stockZeroRun.findUnique({ where: runKey, select: RUN_SELECT });
      if (prior) { res.json({ success: true, idempotent: true, data: resultOfRun(prior) }); return; }
      // سيارةٌ واحدة: المندوب من هذه الشركة قبل أي قفلٍ أو قراءة مخزون (ويُعاد داخل المعاملة: حذفٌ بينهما ⇒ 404 هناك)
      if (repId && !(await repOf(db, tid, repId))) { reply(res, new StockZeroError(404, 'STOCK_ZERO_REP_NOT_FOUND')); return; }

      // التقييم قبل القفل (قراءة كل الحركات بترتيبها الزمني): لقطةٌ تدقيقية للقيمة. الكميات المكتوبة من داخل المعاملة وحدها
      const dec = await deps.decimals(tid);
      const val = await loadValuation(db, tid, dec);
      const owner = isOwnerSession(req);
      const actorId = actorOf(req);
      const actorName = owner ? STOCK_ZERO_SUPPORT_NAME : (req.user?.name ?? '');

      // «تتبّع اللوط»: طابور أصناف اللوط المتتبَّعة (القراءة المسبقة) داخل العملية قبل طلب اتصال المعاملة (D29) ويُحرَّر في finally —
      // صنفٌ صار متتبَّعاً بين القراءتين يُقفل في القاعدة وحدها (lockLotProducts أدناه). الانشغال ⇒ 503 STOCK_ZERO_BUSY
      const preLots = await db.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true } });
      const preTracked = preLots?.lotTrackingEnabled === true
        ? (await db.product.findMany({ where: { tenantId: tid, lotTracked: true }, select: { id: true, lotTracked: true } })).filter((p) => p.lotTracked === true).map((p) => p.id)
        : [];
      const releaseLots = preTracked.length ? await acquireLotQueue(tid, preTracked) : null;
      const out = await db.$transaction(async (tx) => {
        // (١) تصفيرٌ واحد للشركة في كل لحظة — المحاولة لا الانتظار: الثاني يعود فوراً 409
        const lock = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${'stock-zero:' + tid})) AS ok`;
        if (lock[0]?.ok !== true) throw new StockZeroError(409, 'STOCK_ZERO_IN_PROGRESS');
        // الـzeroRef نفسه التزم بين القراءة أعلاه والقفل (طلبان متطابقان متتابعان) ⇒ ردّه لا تشغيلة ثانية
        const dup = await tx.stockZeroRun.findUnique({ where: runKey, select: RUN_SELECT });
        if (dup) return { kind: 'idempotent' as const, data: resultOfRun(dup) };
        // (٢) تجميد كل أصناف الشركة بترتيب المفتاح، بمهلة قفلٍ محلية: كل كاتبٍ يُدرج سطراً بالصنف ينتظر التزامنا (لا تحديثات الحالة
        //     — انظر الرأس و(٥))، وكاتبٌ عالق ⇒ 503 لا انتظار دقيقة
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${STOCK_ZERO_LOCK_TIMEOUT}, true)`;
        const products = await tx.$queryRaw<ZeroProduct[]>`SELECT id, name, "lotTracked", "lotTrackedSince" FROM products WHERE "tenantId" = ${tid} ORDER BY id FOR UPDATE`;
        const tenant = await tx.tenant.findUnique({ where: { id: tid }, select: { warehouseEnabled: true, lotTrackingEnabled: true } });
        const lotsOn = tenant?.lotTrackingEnabled === true;
        // «تتبّع اللوط»: قفل اللوط الاستشاري لكل صنفٍ متتبَّع بترتيب المفتاح بعد صفوف الأصناف (ترتيب المنصّة §٣.١) — على الصفوف المقفلة
        // نفسها بلا FOR KEY SHARE ثانٍ (lockedRows)، والمتتبَّع تحت القفل هو المرجع (D25). والميزة مطفأة: لا قفل ولا قراءة لوط
        const locked = lotsOn
          ? await lockLotProducts(tx, tid, products.map((p) => p.id), {
            lockedRows: products.map((p) => ({ id: p.id, lotTracked: p.lotTracked === true, lotTrackedSince: p.lotTrackedSince ?? null })),
          })
          : null;
        // سيارةٌ واحدة: مندوبها وحده (حذفٌ التزم منذ الفحص أعلاه ⇒ 404 بلا كتابة)، وإلا كل المناديب القائمين
        const rep = repId ? await repOf(tx, tid, repId) : null;
        if (repId && !rep) throw new StockZeroError(404, 'STOCK_ZERO_REP_NOT_FOUND');
        const reps = rep ? [{ id: rep.id }] : await tx.salesRep.findMany({ where: { tenantId: tid }, select: { id: true } });
        const q = { productIds: products.map((p) => p.id), repIds: reps.map((r) => r.id), lotProductIds: locked ? [...locked.tracked] : [] };
        const scope = { vansOnly: !!rep };
        // (٣) الأرصدة الدقيقة تحت التجميد — لا ما قُرئ قبله، ومعها تشغيلات الأصناف المتتبَّعة (تُصفَّر تشغيلةً تشغيلة) وبطاقاتها للملخّص.
        //     وسيارةٌ واحدة: المستودع خارج النطاق (لا تسوية، وwarehouseZeroed = false)
        const balances = await loadZeroBalances(tx, tid, q, { ...scope, lotMetas: true });
        const plan = planStockZero({ products, warehouseEnabled: !rep && tenant?.warehouseEnabled === true, lotTrackingEnabled: lotsOn, balances });
        const repTag = rep ? { scope: 'VAN' as const, salesRep: rep } : {};
        if (plan.alreadyZero) return { kind: 'zero' as const, data: { ...alreadyZeroResult(plan), ...repTag } };

        // (٤) التشغيلة ثم الحركات الموسومة بها ثم ربطها بها
        const totals = totalsOf(plan, val);
        const summary = runSummaryOf(plan, val, totals, rep, balances.lots?.metas);
        const run = await tx.stockZeroRun.create({
          data: { tenantId: tid, zeroRef, actorId, actorName, impersonated: owner, warehouseZeroed: plan.warehouse.enabled, summary: summary as unknown as Prisma.InputJsonValue },
          select: { id: true },
        });
        const w = await writeStockZero(tx, { tenantId: tid, runId: run.id, plan, createdBy: actorName });
        const result = {
          runId: run.id, alreadyZero: false, ...repTag,
          warehouse: { products: plan.warehouse.lines.length, entryId: w.entryId },
          vans: { reps: totals.vans.reps, loads: w.vanLoads, products: totals.vans.products },
          skipped: plan.skipped,
          value: { warehouse: totals.warehouse.value, vans: totals.vans.value },
        };
        await tx.stockZeroRun.update({
          where: { id: run.id },
          data: { warehouseEntryId: w.entryId, vanLoadCount: w.vanLoads, summary: { ...summary, result } as unknown as Prisma.InputJsonValue },
        });

        // (٥) شرط ما بعد التصفير. أولاً المستحيل: حركاتٌ مكتوبة لا تطابق الخطة خللٌ في الكود ⇒ 500 (لا تزامن يسبّبه).
        if (w.vanLoads !== vanLoadCountOf(plan)) throw new StockZeroError(500, 'STOCK_ZERO_POSTCONDITION', ['VAN_LOAD_COUNT']);
        // ثم إعادة الحساب داخل المعاملة نفسها — رصيد كل صنفٍ وكل تشغيلةٍ لصنفٍ متتبَّع: بقيّةٌ ⇒ كاتبٌ لا ينتظر التجميد (إلغاء فاتورة،
        // إعادة مخزون، إلغاء مرتجع) التزم أثناءنا ⇒ تراجعٌ كامل و503 قابلٌ للإعادة — الإعادة تقرأ رصيده الجديد فتصفّره
        const residual = residualsOf(await loadZeroBalances(tx, tid, q, scope), plan.warehouse.enabled);
        if (residual.length) throw new StockZeroError(503, 'STOCK_ZERO_BUSY', residual);
        return { kind: 'done' as const, data: result, warehouseLines: plan.warehouse.lines.length, vanLoads: w.vanLoads, salesRepId: rep?.id ?? null };
      }, STOCK_ZERO_TX).finally(() => releaseLots?.());

      if (out.kind === 'idempotent') { res.json({ success: true, idempotent: true, data: out.data }); return; }
      if (out.kind === 'done') {
        audit(stockZeroAuditLine({
          tenantId: tid, actorId, impersonated: owner, runId: out.data.runId, warehouseLines: out.warehouseLines, vanLoads: out.vanLoads, salesRepId: out.salesRepId,
        }));
      }
      res.json({ success: true, data: out.data });
    } catch (err) {
      if (err instanceof StockZeroError) {
        // بعد التراجع: البقيّة (انشغالٌ متوقَّع) تحذيرٌ، والمستحيل خطأ — كلاهما بأوّل أسطره فقط
        const rest = Array.isArray(err.data) ? err.data.slice(0, RESIDUAL_LOG_LIMIT) : [];
        if (err.code === 'STOCK_ZERO_BUSY' && Array.isArray(err.data)) {
          console.warn(JSON.stringify({ event: 'STOCK_ZERO_RESIDUAL', tenantId: req.user?.tenantId ?? null, residuals: rest }));
        }
        if (err.code === 'STOCK_ZERO_POSTCONDITION') {
          console.error(JSON.stringify({ event: 'STOCK_ZERO_POSTCONDITION', tenantId: req.user?.tenantId ?? null, residual: rest }));
        }
        reply(res, err);
        return;
      }
      if (isStockZeroBusy(err)) { reply(res, new StockZeroError(503, 'STOCK_ZERO_BUSY')); return; }
      // تصادم (tenantId, zeroRef) الفريد — لا يقع والقفل الاستشاري قائم، والحزام: ردّ التشغيلة التي سبقت
      if ((err as { code?: unknown })?.code === 'P2002') {
        try {
          const parsed = bodySchema.safeParse(req.body);
          const run = parsed.success
            ? await db.stockZeroRun.findUnique({ where: { tenantId_zeroRef: { tenantId: deps.tenantId(req), zeroRef: parsed.data.zeroRef } }, select: RUN_SELECT })
            : null;
          if (run) { res.json({ success: true, idempotent: true, data: resultOfRun(run) }); return; }
        } catch { /* إلى المعالج العام */ }
      }
      next(err);
    }
  });

  return router;
}

export default createStockZeroRouter({
  db: prisma,
  scopeEnabled: adminScopeEnabled,
  tenantId: tenantIdOf,
  decimals: tenantCurrencyDecimals,
  audit: (line) => console.warn(line),
});
