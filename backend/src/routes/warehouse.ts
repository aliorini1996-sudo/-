// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// الرصيد محسوبٌ: الوارد + تسويات المستودع + العائد من السيارات − المحمّل لها.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { computeWarehouseStock, tenantCurrencyDecimals, loadWarehouseInputs, composeWarehouse, summarizeVansStock, UnitInvalidError, UNIT_SELECT } from '../services/warehouseStock';
// «الربط لا يُرفض» (أمر المالك ٩ نوفمبر ٢٠٢٦): الحركة تُقبل بما يمكن معالجته، والمتروك أو المعدَّل تحذيرٌ في ردّ النجاح
import { lenientStockLines, noQuantitiesWarning, stockNoopBody, type StockWarning } from '../services/stockLenient';
// «الوحدة الرئيسية» §3 (#5): الوارد والتسوية يكتبان كمية وتكلفةً بوحدة الأساس — تُقارَن بالأساس الذي يعرفه العميل حيّاً، ثم تحت القفل
import {
  BASE_GUARD_TX, ProductUnitsBusyError, ProductUnitsChangedError, assertBasesUnchanged, baseGuardReply, baseUnitRequiredReply, expectedBasesOf, lockBases,
  missingBaseForApi, staleClientBase,
} from '../services/baseGuard';
import { unitFields } from '../services/units';
import type { VanLayer } from '../services/warehouseCost';
import { foldStock, bucketRemaining, type LoadRow, type InvRow } from './vanStock';
import { adminRepFilter } from '../services/adminScope';
import { addDays, isLocalDate } from '../services/gl/dates';
import { importedEntryInstant } from '../services/importTimezoneRebase';
import { importTimezone } from '../services/importLedger';
import { LOT_NUMBER_MAX, LotError, asLotBusy, lotHttpError, type LotWarning, type WarehouseEntryPlan } from '../services/lots';
import { acquireLotQueue, companyDay, lockLotProducts } from '../services/lotsDb';
import { LOT_PRODUCT_SELECT, lotActorOf, lotEventActorOf, planWarehouseEntryInTx, vansLotUnsellable, warehouseLineCarriesLot, warehousePlanLines } from '../services/lotsWarehouse';
// D9: سطرٌ بتشغيلةٍ لصنفٍ غير متتبَّع — الخطأ نفسه لحركة السيارة (422 LOT_PRODUCT_MISMATCH بسبب NOT_TRACKED وموضع السطر)
import { lotOnUntrackedError } from '../services/lotsVan';
// D25 للمسار غير المتتبَّع: إعادة قراءة التتبّع FOR KEY SHARE وحدها (لا حارس ولا قفل لوط) — الدالّة نفسها لإلغاء المرتجع وإعادته
import { assertReturnStillUntracked as assertStillUntracked } from '../services/lotsInvoice';

/**
 * «المخزون في تاريخ» (طلب المالك ١٨ أكتوبر ٢٠٢٦): لحظة نهاية اليوم المطلوب (بداية اليوم التالي، حصرية) بتوقيت الشركة،
 * فلا تنزاح حركة الحادية عشرة ليلاً إلى اليوم التالي على خادم UTC. والتوقيت `importTimezone` (توقيت الدفاتر وإلا الرياض)
 * لا `explicitTimezone`: هذه لحظاتٌ حيّة كُتبت بـnow() لا قيودٌ مستوردة بمنتصف ليل UTC — وشركةٌ بلا إعدادات دفاتر (أغلب
 * الشركات) كان يومها ينتهي الثالثة فجراً بتوقيتها فيدخل تحميل الفجر في رصيد الأمس.
 * بلا تاريخ صالح (YYYY-MM-DD) ⇒ undefined: الرصيد الحالي كما كان.
 */
export async function warehouseAsOf(tid: string, asOf: unknown): Promise<Date | undefined> {
  if (!isLocalDate(asOf)) return undefined;
  const gl = await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true, timezone: true, setupDraft: true } });
  return importedEntryInstant(addDays(asOf, 1), importTimezone(gl));
}
import { netUnitCost, entryTotalCost, lineCost } from '../services/warehouseCost';
// مفتاح منع التكرار للوارد والتسوية (D8): بلا قيدٍ فريد — قفلٌ استشاري على المرجع ثم البحث به داخل المعاملة
import { CLIENT_REF_SCHEMA, ClientRefReplay, clientRefQuery, lockClientRef } from '../services/stockClientRef';
import { isTaxOff } from '../services/taxMode';

const router = Router();
router.use(authenticate);

/**
 * المستودع للوحة الشركة وحدها — لا للمندوب.
 *
 * `requireAdminPermission` يمرّر `SALES_REP` بلا فحص (middleware/auth.ts)، وهو
 * مقصودٌ في المسارات التي يشترك فيها التطبيقان. لكنّ هذا المسار صار يحمل
 * **تكلفة الشراء وقيمة المخزون**، أي هامش ربح الشركة على كل صنف — ولا شيء في
 * تطبيق المندوب يستدعيه أصلاً. فالمنع صريحٌ هنا لا متروكٌ لعمومية الحارس.
 */
router.use((req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role === 'SALES_REP') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
});

// نفس صلاحية إدارة المخزون؛ المستودع مركزيّ على مستوى الشركة (لا يخصّ مندوباً)
router.use(requireAdminPermission('canManageVanStock'));

/**
 * «تتبّع اللوط» (§٤.٤): عَلَم الشركة للطلب، يقرؤه حارس التفعيل في استعلامه نفسه — فلا استعلام زائد والميزة مطفأة (§١٠.١).
 * على الطلب لا على res.locals: حرّاس الموجّه تُشغَّل في الاختبارات بردٍّ مزيّف بلا locals (api-key-feature-guards.test.ts).
 */
const lotsOnOf = new WeakMap<object, boolean>();
const lotsOn = (req: AuthRequest): boolean => lotsOnOf.get(req) === true;

// حارس التفعيل: عَلَمان في استعلام واحد. «النظام المحاسبي» يعلو لأنّه يعزل الوحدة
// كلّها، وافتراضه true فلا يمنع إلا حين يكون false صريحاً — بعكس warehouseEnabled
// المطفأ افتراضياً والذي لا يمرّ إلا بتفعيلٍ صريح.
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { warehouseEnabled: true, accountingEnabled: true, lotTrackingEnabled: true } });
    if (t?.accountingEnabled === false) { res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' }); return; }
    if (!t?.warehouseEnabled) { res.status(403).json({ success: false, message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' }); return; }
    lotsOnOf.set(req, t.lotTrackingEnabled === true);
    next();
  } catch (err) { next(err); }
});

// رصيد مخزون الشركة لكل منتج (مع تفصيل الوارد/الخارج للسيارات/العائد)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // خانات عملة الشركة تُقرأ **مرّة واحدة** لهذا الطلب ثم تمرّ إلى التقييم كلّه:
    // شركةٌ بالدينار كانت ترى قيمة كل صنفٍ مقرَّبةً إلى خانتين (٠٫٣٧ بدل ٠٫٣٧١).
    const [dec, before] = await Promise.all([tenantCurrencyDecimals(tid), warehouseAsOf(tid, req.query.asOf)]);
    res.json({ success: true, data: await computeWarehouseStock(tid, dec, before) });
  } catch (err) { next(err); }
});

/**
 * ما في مخزون السيارات الآن وقيمته بتكلفة الشراء (طلب المالك ١٨ أكتوبر ٢٠٢٦) — بطاقةٌ بجانب قيمة المستودع.
 * الرصيد بطيّ حركات كل سيارة كمسار مخزون السيارات (foldStock)، والقيمة بكلفة خروجه من المستودع (summarizeVansStock).
 * سيارات نطاق المستخدم وحدها (المشرف مناديب فرقه). استعلاماتٌ مجمَّعة للشركة لا حلقة استعلامٍ لكل مندوب.
 */
router.get('/vans', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // ما في السيارات في تاريخٍ مضى: حركاتها وفواتيرها قبل نهاية يومه وحدها (فواتير السيارة بتاريخها كصفحة مخزون السيارات)
    const before = await warehouseAsOf(tid, req.query.asOf);
    const repFilter = await adminRepFilter(req);
    const [dec, inputs, reps] = await Promise.all([
      tenantCurrencyDecimals(tid),
      loadWarehouseInputs(tid, { includeInactive: true, before }),
      prisma.salesRep.findMany({ where: { tenantId: tid, ...repFilter }, select: { id: true } }),
    ]);
    const repIds = reps.map((r) => r.id);
    // بنود الفواتير بلقطة وحدتها (foldStock يطوي بالأساس منها)؛ وحركات السيارات من loadWarehouseInputs بالأساس سلفاً
    const invItems = repIds.length ? await prisma.invoiceItem.findMany({
      where: { invoice: { tenantId: tid, status: 'CONFIRMED', salesRepId: { in: repIds }, ...(before && { invoiceDate: { lt: before } }) } },
      select: {
        productId: true, qty: true, unitFactor: true, baseQty: true, returnExpired: true,
        invoice: { select: { salesRepId: true, type: true, returnToStock: true, invoiceDate: true, returnReason: true, createdAt: true } },
      },
    }) : [];

    const layers = new Map<string, Map<string, VanLayer[]>>();
    // ما زاد على طبقات السيارة يُقيَّم بالمتوسّط **غير المقرَّب** (#13): المقرَّب لأربع خانات للعرض، وبه كان تحويل وحدة الأساس
    // (كرتون 16.33 ⇒ ٨ قوارير 2.0413) يغيّر قيمة البطاقة نفسها. القيمة إلى خانات العملة في summarizeVansStock كما كانت
    const avgCost = new Map<string, number>();
    composeWarehouse(inputs.products, inputs.whItems, inputs.vanItems, dec, layers, avgCost);

    const repSet = new Set(repIds);
    const loadsByRep = new Map<string, LoadRow[]>();
    for (const v of inputs.vanItems) {
      if (!v.salesRepId || !repSet.has(v.salesRepId)) continue;
      const list = loadsByRep.get(v.salesRepId) ?? [];
      list.push({ productId: v.productId, qty: v.qty, vanLoad: { type: v.type, createdAt: v.at } });
      loadsByRep.set(v.salesRepId, list);
    }
    const invByRep = new Map<string, InvRow[]>();
    for (const it of invItems) {
      const rid = it.invoice.salesRepId;
      if (!rid) continue;
      const list = invByRep.get(rid) ?? [];
      list.push(it);
      invByRep.set(rid, list);
    }
    const perRep = repIds.map((repId) => {
      const { bal } = foldStock(loadsByRep.get(repId) ?? [], invByRep.get(repId) ?? []);
      return {
        repId,
        products: [...bal].map(([productId, b]) => ({
          productId,
          remaining: bucketRemaining(b),
          unsellable: Math.max(0, b.damagedIn - b.damagedOut) + Math.max(0, b.expiredIn - b.expiredOut),
        })),
      };
    });
    // عرض البطاقة بالوحدة الكبرى (major): أصناف الشركة بوحداتها ورئيسيّها من القراءة نفسها (loadWarehouseInputs) — بلا استعلام
    const productsMeta = new Map(inputs.products.map((p) => [p.id, p]));
    // سيارات المناديب المحذوفين: حذفُ المندوب يُبقي تحميلاته بمعرّفه المحفوظ (vanKeyOf) ويُفرغ مندوب فواتيره، فلا يُعرف ما بقي
    // في سيارته. تُعدّ صراحةً بدل أن تسقط بصمت — لغير المقيَّد وحده (المقيَّد لا يُعرف نطاقه في مندوبٍ لم يعد موجوداً)
    let deletedVans = 0;
    if (!Object.keys(repFilter).length) {
      const net = new Map<string, number>();
      for (const v of inputs.vanItems) {
        if (!v.salesRepId || repSet.has(v.salesRepId)) continue;
        const sign = v.type === 'LOAD' || v.type === 'ADJUST' ? 1 : v.type === 'UNLOAD' ? -1 : 0;
        if (sign) net.set(v.salesRepId, (net.get(v.salesRepId) ?? 0) + sign * v.qty);
      }
      deletedVans = [...net.values()].filter((q) => q > 1e-9).length;
    }
    // «تتبّع اللوط» (§٤.٤ البند ٧): المعزول (تشغيلةٌ موقوفة أو منتهية لم تُبع) والمحجوز (D24) في سيارات النطاق لكل صنف متتبَّع —
    // داخلان في المتاح أعلاه ولا يُباعان، فتضيفهما الواجهة إلى «لا يُباع». الميزة مطفأة ⇒ الردّ كما كان بلا استعلام
    if (lotsOn(req)) {
      const lots = await vansLotUnsellable(prisma, tid, repIds, { day: isLocalDate(req.query.asOf) ? req.query.asOf : null, before });
      res.json({ success: true, data: { ...summarizeVansStock(perRep, layers, avgCost, dec, productsMeta), deletedVans, ...lots } });
      return;
    }
    res.json({ success: true, data: { ...summarizeVansStock(perRep, layers, avgCost, dec, productsMeta), deletedVans } });
  } catch (err) { next(err); }
});

const entrySchema = z.object({
  type: z.enum(['RECEIVE', 'ADJUST']).default('RECEIVE'),
  note: z.string().max(300).optional(),
  supplier: z.string().max(200).optional(),
  // هل الأسعار المكتوبة شاملةٌ للضريبة؟ يقرّره المستخدم بحسب فاتورة مورّده،
  // والخادم يردّها إلى صافيها — فالمخزَّن معنى واحد لا معنيان (انظر warehouseCost)
  costsIncludeTax: z.boolean().optional().default(false),
  // مفتاح منع التكرار (D8): واحدٌ لكل محاولة حفظ يُعاد مع إعادتها — المكرَّر يردّ الحركة القائمة 200 بلا كتابة. غائبٌ ⇒ كما كان
  clientRef: CLIENT_REF_SCHEMA.optional(),
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number(), // بوحدة البند
    // وحدة البند (كرتون/حبة). غائبة ⇒ وحدة الأساس بمعامل ١: عميلٌ قديم أو مفتاح API يرسل الكمية بالأساس كما كان
    unitId: z.string().nullish(),
    // موجبٌ فقط: سعرٌ سالب لا معنى له، وصفرٌ يعني «بلا سعر» فيُرسَل غائباً.
    // تكلفة **وحدة البند** كما في فاتورة المورّد (الكرتون) — والتقييم يقسمها على المعامل عند القراءة (unitCostPerBase)
    unitCost: z.number().positive().finite().max(1e9).optional(),
    // «الوحدة الرئيسية» §3: وحدة الأساس التي حسب عليها العميل الكمية والتكلفة (Product.unit في كتالوجه). غائبة ⇒ مسار اليوم حرفياً،
    // ومختلفة عن أساس الصنف الآن ⇒ 400 UNIT_INVALID فيعيد تحميل أصنافه. لمفتاح API على صنفٍ حُوِّل: إلزامية (D19)
    baseUnitName: z.string().transform((v) => v.slice(0, 64)).nullish(),
    // «تتبّع اللوط» (§٤.٤): سطرٌ = تشغيلةٌ واحدة — قائمةٌ بمعرّفها، أو رقمٌ (وتاريخان YYYY-MM-DD) يُحلّ أو يُنشأ، أو null صريح
    // لغير المسمّى في التسوية. تُقرأ للصنف المتتبَّع والميزة مفعّلة وحدهما؛ وغيرهما كما كان
    lotId: z.string().min(1).max(128).nullable().optional(),
    lotNumber: z.string().max(LOT_NUMBER_MAX).optional(),
    productionDate: z.string().max(10).nullable().optional(),
    expiryDate: z.string().max(10).nullable().optional(),
    // «مرجع السطر»: معرّف سطر نظام المُكامِل (الربط البرمجي) يُحفظ على البند ويعود معه كما هو. بعد القصّ: فارغ ⇒ null، وفوق ١٠٠ ⇒ 400.
    // لا تفرّد ولا فهرس، ومستقلٌّ عن «تتبّع اللوط» (الواجهة لا ترسله فيبقى null)
    lineRef: z.string().trim().max(100).nullish().transform((v) => v || null),
  })).min(1),
});

/** تشغيلة السطر في ردّ الحركة وسجلّها (ن٢-١٨) — والميزة مفعّلة وحدها، فالردّ للشركة المطفأة كما كان */
const ENTRY_LOT_SELECT = { select: { lotNumber: true, productionDate: true, expiryDate: true } } as const;

/**
 * أصناف أسطر الحركة في قراءةٍ واحدة: الضريبة (الردّ من الشامل إلى الصافي) وأعمدة «تتبّع اللوط» والأساس وتاريخ تحويله (حارس §3)،
 * والأرشفة والرمز والوحدات («الربط لا يُرفض»: توأم المؤرشف الحيّ، وخطر التحويل لوحدةٍ غريبة). بها تُقرأ التوائم أيضاً (stockLenient)
 */
const ENTRY_PRODUCT_SELECT = {
  id: true, taxPct: true, name: true, code: true, unit: true, baseConvertedAt: true, deletedAt: true, units: { select: UNIT_SELECT }, ...LOT_PRODUCT_SELECT,
} as const;

/** ملاحظة تسوية الإنقاص المكتوبة من أسطر وارد سالبة حين لا ملاحظة في الطلب */
const NEGATIVE_RECEIVE_NOTE = 'تسوية إنقاص لأسطر وارد بكمية سالبة';

// تسجيل وارد (استلام/شراء) أو تسوية للمستودع
router.post('/entries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = entrySchema.parse(req.body);
    // D8: مرجعٌ سبق حفظه ⇒ الحركة القائمة 200 بشكل ردّ الإنشاء (و replay: true) بلا كتابة ولا حكمٍ جديد على أصنافها؛ ومرجعٌ لحركةٍ من نوعٍ
    // آخر ⇒ 409 CLIENT_REF_REUSED. والطلبان المتزامنان بالمرجع نفسه يحسمهما القفل في المعاملة (refGate). المستودع للشركة كلها فلا نطاق
    const clientRef = data.clientRef ?? null;
    const priorInclude = { items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(lotsOn(req) && { lot: ENTRY_LOT_SELECT }) } } };
    // «الربط لا يُرفض»: وارد كل أسطره سالبة يُكتب تسويةَ إنقاص (أدناه) فحركته المحفوظة بمرجعه ADJUST — حركته هو لا «حركةٌ أخرى»
    // (فالقبول لواردٍ فيه سطرٌ سالب؛ والمختلط يحمل الوارد مرجعه فيطابق نوعه). ووارد بلا سطرٍ سالب يجد تسويةً بمرجعه ⇒ 409 كما كان
    const negativeReceive = data.type === 'RECEIVE' && data.items.some((i) => i.qty < 0);
    const priorOf = async (db: Prisma.TransactionClient | typeof prisma) => {
      if (!clientRef) return null;
      const prior = await db.warehouseEntry.findFirst({ where: { tenantId: tid, clientRef }, orderBy: { createdAt: 'asc' }, include: priorInclude });
      if (prior && prior.type !== data.type && !(negativeReceive && prior.type === 'ADJUST')) {
        throw Object.assign(new Error('مرجع الحفظ clientRef مستعملٌ لحركةٍ أخرى — ولّد مرجعاً جديداً لكل حفظ'), { status: 409, code: 'CLIENT_REF_REUSED' });
      }
      return prior;
    };
    const prior0 = await priorOf(prisma);
    if (prior0) { res.status(200).json({ success: true, data: prior0, replay: true, idempotent: true }); return; }
    /** أول ما في كل معاملة كتابة: قفل المرجع ثم البحث به — وُجد ⇒ تُجهَض المعاملة بلا كتابة ويُردّ القائم */
    const refGate = async (tx: Prisma.TransactionClient) => {
      if (!clientRef) return;
      await lockClientRef(tx, 'warehouse-entry', tid, clientRef);
      const prior = await priorOf(tx);
      if (prior) throw new ClientRefReplay(prior);
    };
    // «الربط لا يُرفض» (أمر المالك ٩ نوفمبر ٢٠٢٦، services/stockLenient.ts): الحركة تُقبل ويُعالَج منها ما يمكن، وما تُرك أو عُدِّل
    // تحذيرٌ في ردّ النجاح (warnings) بموضع سطره `at` في items كما أرسلها العميل. و`fi` موضعه بعد حذف الأسطر الصفرية — به تُعرَّف
    // أسطر خطة اللوط وأخطاؤها ({idx}) وخطأ D9 كما كانت
    const warnings: StockWarning[] = [];
    const nonZero = data.items.map((i, at) => ({ ...i, at })).filter((i) => i.qty !== 0).map((i, fi) => ({ ...i, fi }));
    // كل الأسطر صفرية ⇒ 200 بلا حركة وتحذير NO_QUANTITIES (كان 400 «لا توجد كميات صالحة»)
    if (!nonZero.length) { res.status(200).json(stockNoopBody([noQuantitiesWarning()])); return; }
    // التسوية جردٌ أو تالف لا شراء — فلا ثمن لها: سعرٌ مُرسَل معها يُهمل بتحذير UNIT_COST_IGNORED (كان 400 للطلب كله)
    const priced = data.type === 'ADJUST' ? nonZero.map((i) => {
      if (i.unitCost == null) return i;
      warnings.push({ code: 'UNIT_COST_IGNORED', index: i.at, productId: i.productId, message: `سعر الوحدة يسجل مع الوارد فقط لا مع التسوية — أُهمل سعر السطر ${i.at + 1}` });
      return { ...i, unitCost: undefined };
    }) : nonZero;

    // الأصناف في قراءةٍ واحدة (ENTRY_PRODUCT_SELECT) قبل حلّ وحدات البنود
    const found = await prisma.product.findMany({
      where: { id: { in: [...new Set(priced.map((i) => i.productId))] }, tenantId: tid },
      select: ENTRY_PRODUCT_SELECT,
    });
    // مراجعة المخزون #23 وH2 صارا بلا رفض: صنفٌ لا يتبع الشركة ⇒ صنفٌ مؤقّت بمعرّفه نفسه (PRODUCT_PLACEHOLDER_CREATED، كان 400)
    // ما لم يكن المعرّف لشركةٍ أخرى (يُترك سطره PRODUCT_NOT_FOUND)، والوارد **الموجب** لصنفٍ مؤرشف ⇒ صنفٌ حيّ واحد بالرمز نفسه
    // (PRODUCT_REDIRECTED) وإلا يُقبل على المؤرشف (PRODUCT_ARCHIVED، كان 422). السالب يصير تسوية إنقاص (أدناه) والتسوية تمرّ على
    // المؤرشف أصلاً. ثم وحدة البند: الموقوفة بمعاملها، والغريبة أساساً بلا خطر تحويل وإلا يُترك سطرها (UNIT_INVALID) — لا كمية تُضرب
    // بمعاملٍ مخمَّن
    const lenient = await lenientStockLines(tid, priced, found, {
      archived: data.type === 'RECEIVE' ? 'RECEIVE' : null, archivedApplies: (i) => i.qty > 0, select: ENTRY_PRODUCT_SELECT,
      isApiKey: !!req.user?.apiKeyId, lotsOn: lotsOn(req), carriesLot: warehouseLineCarriesLot,
      stripLot: (i) => ({ ...i, lotId: undefined, lotNumber: undefined, productionDate: undefined, expiryDate: undefined }),
    });
    warnings.push(...lenient.warnings);
    // لم يبقَ سطرٌ يُكتب ⇒ 200 بلا حركة بتحذيراته (لا مرجع يُحفظ: إعادته تعيد الردّ نفسه)
    if (!lenient.lines.length) { res.status(200).json(stockNoopBody(warnings)); return; }
    const { products } = lenient;
    // كل سطر بلقطة وحدته المحلولة (يكتبها unitFields)
    const lines = lenient.lines.map((i, k) => ({ ...i, unit: lenient.units[k] }));
    type EntryLine = (typeof lines)[number];
    const productIds = [...new Set(lines.map((i) => i.productId))];
    // «الوحدة الرئيسية» §3 (باقٍ بلا تساهل — يمنع خطأ الكمية الصامت): الأساس الذي حُلّت عليه البنود — يُقارَن بما يعرفه العميل الآن،
    // ثم تحت القفل في معاملة الإنشاء. مفتاح API على صنفٍ حُوِّل بلا baseUnitName ⇒ 400 (D19) بدل خطأٍ ×٢٤ صامت في الكمية والتكلفة
    const expected = expectedBasesOf(products);
    const noBase = missingBaseForApi(!!req.user?.apiKeyId, lines, new Map(products.map((p) => [p.id, p])));
    if (noBase) { const r = baseUnitRequiredReply(noBase); res.status(r.status).json(r.body); return; }
    const stale = staleClientBase(lines, expected, new Map(products.map((p) => [p.id, p.baseConvertedAt])));
    if (stale) throw new UnitInvalidError(`تغيّرت وحدات «${stale}» — حدّث قائمة الأصناف ثم أعد الحفظ`);
    // «تتبّع اللوط» (D9، كالسيارة) والميزة مفعّلة: سطرٌ يحمل تشغيلةً لصنفٍ غير متتبَّع ⇒ 422 LOT_PRODUCT_MISMATCH بسبب NOT_TRACKED
    // وموضعه (موضع السطر بعد حذف الصفرية كسائر أخطاء الحركة) لا إهمالٌ صامت — واجهةٌ قديمة لصنفٍ أُطفئ تتبّعه تُنقص الصنف وتُبقي رصيد
    // التشغيلة. بلا استعلام ولا معاملة؛ والمطفأة تُهملها كما كانت حرفياً (§١٠.١)
    if (lotsOn(req)) {
      const trackedNow = new Set(products.filter((p) => p.lotTracked === true).map((p) => p.id));
      const stray = lines.find((i) => !trackedNow.has(i.productId) && warehouseLineCarriesLot(i));
      if (stray) throw lotOnUntrackedError(products.find((p) => p.id === stray.productId)?.name ?? '', stray.productId, stray.fi);
    }
    // «الربط لا يُرفض»: الوارد بكمية سالبة (مرتجعٌ للمورّد أو عكس استلام في نظام المُكامِل) كان 400 — صار **إنقاصاً** بتحذير
    // NEGATIVE_RECEIVE_AS_ADJUST. لا القيمة المطلقة: −٥ تُقرأ +٥ فيبعد الرصيد عشرة عن الحقيقة. ولا سطر وارد سالب: خطة اللوط ترفضه
    // (LOT_QTY_INVALID) وتقييم الوارد يفترض دخولاً. فأسطره السالبة تسويةُ إنقاص (ADJUST) بلا سعر — طريق الإنقاص الذي يعرفه كل قارئ
    // (التقييم بالمتوسّط، وسحب اللوط بالأقرب انتهاءً، وحارس نقص التشغيلة). كلها سالبة ⇒ الحركة نفسها تسوية (تحمل المرجع)؛ ومختلطة ⇒
    // تسويةٌ منفصلة في المعاملة نفسها قبل الوارد (النقص أولاً كخطة اللوط) تعود في الردّ `adjustment`، والوارد يحمل المرجع
    const negative = data.type === 'RECEIVE' ? lines.filter((i) => i.qty < 0) : [];
    for (const i of negative) {
      warnings.push({
        code: 'NEGATIVE_RECEIVE_AS_ADJUST', index: i.at, productId: i.productId,
        message: `كمية السطر ${i.at + 1} سالبة فسُجّلت تسوية إنقاص لا وارداً${i.unitCost != null ? ' وأُهمل سعرها' : ''}`,
      });
    }
    const decreaseOnly = negative.length > 0 && negative.length === lines.length;
    const entryType: 'RECEIVE' | 'ADJUST' = decreaseOnly ? 'ADJUST' : data.type;
    const asDecrease = (i: EntryLine): EntryLine => ({ ...i, unitCost: undefined });
    const mainLines: EntryLine[] = decreaseOnly ? negative.map(asDecrease) : negative.length ? lines.filter((i) => i.qty > 0) : lines;
    const splitLines: EntryLine[] = decreaseOnly ? [] : negative.map(asDecrease);
    // «إزالة الضريبة»: الشركة بلا ضريبة غير مسجّلة فلا تستردّ ضريبة مدخلات — النسبة الفعلية صفر فالتكلفة المخزَّنة ما كُتب.
    // العلم يُقرأ حين يلزم الردّ من الشامل وحده (costsIncludeTax وسطرٌ بسعر)، فالوارد بلا الخيار بلا استعلامٍ زائد كما كان
    const taxOff = data.costsIncludeTax && mainLines.some((i) => i.unitCost != null)
      && isTaxOff(await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { taxDisabled: true } }));
    const taxOf = new Map(products.map((p) => [p.id, taxOff ? 0 : p.taxPct]));

    const by = req.user as { name?: string } | undefined;
    const withLots = lotsOn(req);
    // البنود كما كانت، و«تتبّع اللوط» يضيف lotId لكل سطر من خطة المعاملة وحدها — وسطر نقصٍ سُحب تلقائياً من أكثر من تشغيلة
    // (splitByLine) بندٌ لكلٍّ بإشارته: بوحدة السطر إن كانت حصّته وحداتٍ كاملة، وإلا بوحدة الأساس (Σ الأساس = أساس السطر)
    // و«مرجع السطر» على كل بندٍ من سطره — والمقسوم على تشغيلات يحمله كلُّ بندٍ منه فيجمعها المُكامِل إلى سطره. غائبٌ ⇒ البند كما كان.
    // `part`: الحركة (mainLines بنوعها، وتحمل المرجع) أو تسوية الإنقاص المفصولة من وارد مختلط (splitLines، ADJUST بلا مرجع)
    const entryData = (lotIdByLine: ReadonlyMap<number, string | null> | null, splitByLine?: ReadonlyMap<number, { lotId: string | null; qty: number }[]>, part: 'main' | 'split' = 'main') => ({
      tenantId: tid, type: part === 'split' ? 'ADJUST' : entryType, supplier: data.supplier, createdBy: by?.name,
      note: part === 'split' || decreaseOnly ? (data.note ?? NEGATIVE_RECEIVE_NOTE) : data.note,
      // D8: المرجع بالنشر الشرطيّ — غائبٌ ⇒ العمود null كما كان
      ...(part === 'main' && clientRef && { clientRef }),
      items: {
        create: (part === 'split' ? splitLines : mainLines).flatMap((i) => {
          const unitCost = i.unitCost == null
            ? null
            : netUnitCost(i.unitCost, taxOf.get(i.productId) ?? 0, data.costsIncludeTax);
          const lineRef = i.lineRef != null ? { lineRef: i.lineRef } : null;
          const split = splitByLine?.get(i.fi);
          if (split) {
            const sign = Number(i.qty) < 0 ? -1 : 1;
            const F = i.unit.factor;
            return split.map((r) => {
              const inUnits = r.qty / F;
              const whole = F > 1 && Math.abs(inUnits - Math.round(inUnits)) <= 1e-9;
              return { productId: i.productId, ...unitFields(sign * (whole ? Math.round(inUnits) : r.qty), whole ? i.unit : null), unitCost, lotId: r.lotId, ...lineRef };
            });
          }
          return [{
            productId: i.productId,
            // الكمية بوحدة البند كما في فاتورة المورّد، ولقطة وحدتها، والكمية بالأساس للرصيد والتقييم
            ...unitFields(i.qty, i.unit),
            unitCost,
            ...(lotIdByLine && { lotId: lotIdByLine.get(i.fi) ?? null }),
            ...lineRef,
          }];
        }),
      },
    });
    const entryInclude = { items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(withLots && { lot: ENTRY_LOT_SELECT }) } } };
    /** تسوية الإنقاص المفصولة (وارد مختلط) في معاملة الحركة نفسها، قبل إنشاء الوارد — null حين لا أسطر سالبة مع موجبة */
    const createSplit = (tx: Prisma.TransactionClient, plan: WarehouseEntryPlan | null) => (splitLines.length
      ? tx.warehouseEntry.create({ data: entryData(plan?.lotIdByLine ?? null, plan?.splitByLine, 'split'), include: entryInclude })
      : null);
    /** ردّ الإنشاء: الحركة، وتسوية الإنقاص المفصولة (adjustment) إن وُجدت، والتحذيرات («الربط لا يُرفض» ثم اللوط) إن وُجدت — وإلا كما كان */
    const entryReply = <E>(entry: E, adjustment: E | null, lotWarnings: readonly LotWarning[]) => {
      const all: (StockWarning | LotWarning)[] = [...warnings, ...lotWarnings];
      return { success: true, data: entry, ...(adjustment && { adjustment }), ...(all.length > 0 && { warnings: all }) };
    };
    /** أسطر خطة اللوط بالأساس من unitFields نفسها التي تكتب السطر (D22)، ومعرّف كل سطر موضعه بعد حذف الصفرية (fi) */
    const planLinesOf = (part: readonly EntryLine[]) => warehousePlanLines(part, part.map((i) => unitFields(i.qty, i.unit).baseQty), products, part.map((i) => i.unit.factor))
      .map((l, k) => ({ ...l, idx: part[k].fi }));

    // الميزة مطفأة أو لا صنف متتبَّع في الحركة ⇒ المسار القائم: إنشاءٌ واحد بلا قفل لوط (§١٠). والميزة مفعّلة (D25): تُعاد قراءة تتبّع
    // الأصناف FOR KEY SHARE في معاملة الإنشاء — صنفٌ صار متتبَّعاً بين القراءتين ⇒ 503 LOT_BUSY TRACKING_CHANGED بلا حركة فيُعاد بمسار
    // اللوط، وإلا انتظر التبديلُ (FOR UPDATE) التزامنا. بلا طابور ولا مهلة جديدة (§١٠.٢)، والمطفأة كما كانت حرفياً (§١٠.١).
    // ومهلة المعاملة الافتراضية (P2028) أو انتظار قفل التبديل تحت الضغط ⇒ 503 LOT_BUSY فيعيد العميل (asLotBusy كمسار اللوط) لا 500.
    // «الوحدة الرئيسية» §3: قفل الأصناف ومقارنة أساسها (lockBases) أول المعاملة في الفرعين — والمطفأ صار معاملةً لذلك وحده،
    // بمهلة BASE_GUARD_TX (I10). تحويلٌ التزم بين القراءة والإنشاء ⇒ 409 PRODUCT_UNITS_CHANGED بلا حركة
    const preTracked = withLots ? products.filter((p) => p.lotTracked === true).map((p) => p.id) : [];
    if (!preTracked.length) {
      const out = withLots
        ? await prisma.$transaction(async (tx) => {
          await refGate(tx);
          await lockBases(tx, tid, expected);
          await assertStillUntracked(tx, tid, productIds);
          const adjustment = await createSplit(tx, null);
          const entry = await tx.warehouseEntry.create({ data: entryData(null), include: entryInclude });
          return { entry, adjustment };
        }, BASE_GUARD_TX).catch((e: unknown) => { throw (e instanceof ProductUnitsChangedError ? null : asLotBusy(e)) ?? e; })
        : await prisma.$transaction(async (tx) => {
          await refGate(tx);
          await lockBases(tx, tid, expected);
          const adjustment = await createSplit(tx, null);
          const entry = await tx.warehouseEntry.create({ data: entryData(null), include: entryInclude });
          return { entry, adjustment };
        }, BASE_GUARD_TX);
      res.status(201).json(entryReply(out.entry, out.adjustment, []));
      return;
    }

    // «تتبّع اللوط» (§٤.٤): اليوم قبل المعاملة، ثم طابور الأصناف قبل طلب اتصالها (D29)، ثم المعاملة بمهلتها الموسّعة (D13):
    // قفل الأصناف (المتتبَّع تحت القفل هو المرجع، D25)، ثم الخطة (تشغيلةٌ لكل سطر، والنقص من صالح المستودع I1/I2)، ثم الإنشاء.
    // الكمية للخطة بالأساس من unitFields نفسها التي تكتب السطر (D22، planLinesOf)
    const { day } = await companyDay(prisma, tid);
    const release = await acquireLotQueue(tid, preTracked);
    try {
      const out = await prisma.$transaction(async (tx) => {
        await refGate(tx); // D8: المرجع أولاً — مكرَّرٌ ⇒ لا قفل لوط ولا خطة
        const locked = await lockLotProducts(tx, tid, productIds);
        // §3: الأساس تحت قفل lockLotProducts نفسه (صفوفه تحمل unit) — بلا قفلٍ ثانٍ، وقبل أي خطة أو كتابة
        assertBasesUnchanged(expected, locked.units);
        const planBase = { tenantId: tid, actor: lotActorOf(req.user), createdBy: by?.name ?? null, day, allowUnknown: true, locked, eventActor: lotEventActorOf(req.user) };
        // تسوية الإنقاص المفصولة (وارد مختلط) أولاً: نقصها على رصيد المستودع قبل تشغيلات الوارد — زيادةٌ في الطلب نفسه لا تغطّي نقصه
        // (كخطة اللوط نفسها)، ونقص تشغيلتها 409 LOT_STOCK_INSUFFICIENT كأي تسوية
        const splitPlan = splitLines.length ? await planWarehouseEntryInTx(tx, { ...planBase, type: 'ADJUST', lines: planLinesOf(splitLines) }) : null;
        const plan = await planWarehouseEntryInTx(tx, { ...planBase, type: entryType, lines: planLinesOf(mainLines) });
        const adjustment = await createSplit(tx, splitPlan);
        const entry = await tx.warehouseEntry.create({ data: entryData(plan.lotIdByLine, plan.splitByLine), include: entryInclude });
        return { entry, adjustment, warnings: [...(splitPlan?.warnings ?? []), ...plan.warnings] };
      }, { maxWait: 10_000, timeout: 20_000 });
      res.status(201).json(entryReply(out.entry, out.adjustment, out.warnings));
    } catch (e) {
      // تبدّل الأساس (§3) يُفحص قبل asLotBusy فيمرّ كما هو إلى baseGuardReply أدناه — لا يُقرأ انشغالاً من اسم صنفٍ في رسالته.
      // وانشغال القفل أو مهلة المعاملة في مسار اللوط ⇒ 503 LOT_BUSY (D14) عبر معالج الموجّه أدناه
      if (e instanceof ProductUnitsChangedError) throw e;
      throw asLotBusy(e) ?? e;
    } finally {
      release();
    }
  } catch (err) {
    // §3: تبدّل الأساس أثناء الحفظ ⇒ 409 PRODUCT_UNITS_CHANGED، وانتظار قفل الأصناف (ProductUnitsBusyError من lockBases) ⇒ 503
    // PRODUCT_UNITS_BUSY. صنفا خطأ الحارس وحدهما: مهلة معاملةٍ أو تعطّلٌ متبادل خارج قفل الأصناف يمرّ إلى المعالج العام كما كان.
    // المستودع للوحة وحدها (لا صندوق أوف‑لاين) فلا إعادة رفع. LotError يمرّ إلى معالج الموجّه كما كان
    const g = err instanceof ProductUnitsChangedError || err instanceof ProductUnitsBusyError ? baseGuardReply(err, false) : null;
    if (g) { res.status(g.status).json(g.body); return; }
    // D8: طلبٌ مكرَّر تزامن مع أصله فوجده القفل ⇒ الحركة القائمة كما في المسار السريع؛ ومرجعٌ لحركةٍ أخرى 409
    if (err instanceof ClientRefReplay) { res.status(200).json({ success: true, data: err.row, replay: true, idempotent: true }); return; }
    if ((err as { code?: unknown })?.code === 'CLIENT_REF_REUSED') { res.status(409).json({ success: false, code: 'CLIENT_REF_REUSED', message: (err as Error).message }); return; }
    next(err);
  }
});

// سجلّ حركات المستودع (الوارد/التسوية) — للعرض والتصدير
router.get('/entries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // D8: ?clientRef= — هل حُفظت محاولةٌ بمرجعها قبل إعادة الإرسال؟ نصٌّ صالح وحده، وغيره يُهمل
    const clientRef = clientRefQuery(req.query.clientRef);
    // الخانات تُقرأ مرّة واحدة مع الحركات — لا داخل حلقة الأسطر أدناه
    const [dec, entries] = await Promise.all([
      tenantCurrencyDecimals(tid),
      prisma.warehouseEntry.findMany({
        where: { tenantId: tid, ...(clientRef && { clientRef }) },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { items: { include: { product: { select: { name: true, unit: true, primaryUnitId: true } }, ...(lotsOn(req) && { lot: ENTRY_LOT_SELECT }) } } },
      }),
    ]);
    // الإجمالي يُحسب هنا بالدالّة المختبَرة لا في المتصفّح: حسابان لرقمٍ واحد
    // ينزاحان يوماً — وقاعدة التقريب (جمعُ أسطرٍ مقرَّبة) تعيش في مكان واحد.
    //
    // و**قيمة كل سطر** تُرسَل معه للسبب نفسه: إشعار الوارد المطبوع يعرض الأسطر
    // والإجمالي معاً على ورقةٍ تُوقَّع، فإن حسب المتصفّح الأسطر بقاعدته هو
    // وجاء الإجمالي من هنا، أمكن أن تقول الورقة «مجموع الأسطر ≠ الإجمالي».
    //
    // والقيمة **بوحدة السطر** (كمية الكراتين × تكلفة الكرتون)، والسطر يحمل لقطة وحدته (unitName/unitFactor)
    // وكميته بالأساس (baseQty) — فالإشعار يطبع «٥ كرتون» لا «٥ حبة».
    res.json({
      success: true,
      data: entries.map((e) => ({
        ...e,
        // «تصفير المخزون»: معرّف التشغيلة لتسوية التصفير (null لكل حركة أخرى) — صريحٌ في الردّ فتوسمها الواجهة «تصفير» بالوسم
        // لا بنصّ الملاحظة (يُكتب يدوياً في أي تسوية)
        zeroRunId: e.zeroRunId ?? null,
        items: e.items.map((i) => ({ ...i, lineCost: lineCost(i.qty, i.unitCost, dec) })),
        totalCost: entryTotalCost(e.items, dec),
      })),
    });
  } catch (err) { next(err); }
});

/**
 * «تتبّع اللوط» (§٣.٣): LotError (ومعه انشغال القفل بعد تحويله في مسار اللوط وحده) ⇒ حالته ورمزه لا 500 من errorHandler —
 * على نمط معالج vanStock.ts. وما سواه إلى المعالج العام كما كان.
 */
router.use((err: unknown, _req: AuthRequest, res: Response, next: NextFunction) => {
  const lh = err instanceof LotError ? lotHttpError(err) : null;
  if (lh) { res.status(lh.status).json(lh.body); return; }
  next(err);
});

export default router;
