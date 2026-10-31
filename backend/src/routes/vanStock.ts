import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { actorOf, authenticate, requireAdmin, requireAdminPermission, requireAccounting, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { suggestLoad, type SaleRow } from '../services/suggestLoad';
import { computeAccuracy } from '../services/suggestAccuracy';
import { canAccessRep, adminRepFilter, adminScopeEnabled, scopedRepRecordWhere, scopedRecordWhere, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { roundDecimal } from '../utils/helpers';
import { DAMAGED_VAN_SINCE, isDamagedVanReturn } from '../services/vanDamaged';
// «لوكيشن»: ختم التحميل بموقع المندوب وقت التحميل، وفلتر سجلّ التحميلات بالختم (services/locations.ts)
import { locationDocWhere, locationFilterOf, repStampLocation } from '../services/locations';
import { tenantTz } from '../services/invoiceExpiry';
import { paymentMethodsRange } from '../services/paymentMethodsReport';
// الوحدات المتعددة: كل رصيدٍ ومقارنة بالأساس (baseQtyOf)، وكل بندٍ يُكتب بلقطة وحدته (unitFields)
import { baseQtyOf, primaryUnitOf, productQtyText, toBase, unitFields } from '../services/units';
import { resolveLineUnits, unitsByProduct, UnitInvalidError, UNIT_SELECT } from '../services/warehouseStock';
// «الوحدة الرئيسية» §3 (#2 و#4): كل حركة تُقارن الأساس الذي يعرفه العميل حيّاً، ثم الأساس الذي حُلّت عليه تحت قفل الأصناف
import {
  BASE_GUARD_TX, ProductUnitsBusyError, ProductUnitsChangedError, assertBasesUnchanged, baseGuardReply, baseUnitRequiredReply, expectedBasesOf, lockBases,
  missingBaseForApi, staleClientBase,
} from '../services/baseGuard';
// «تتبّع اللوط»: حركات السيارة بالتشغيلات (§٤.٧) — كلها خلف علم الشركة وعلم الصنف؛ المطفأ والصنف غير المتتبَّع كما كانا حرفياً
import { LotError, asLotBusy, lotErr, lotErrorBody, lotHttpError, type VanMovementPlan } from '../services/lots';
import { acquireLotQueue, companyDay, lockLotProducts } from '../services/lotsDb';
import { VAN_LOT_ALLOW_UNKNOWN, lotOnUntrackedError, planVanMovementInTx, vanItemLotColumns, vanLineCarriesLot, vanLotSnapshot } from '../services/lotsVan';
// فاعل سجل تدقيق اللوط بالمساعد نفسه للمستودع والاستيراد: جلسة «دخول» بمُصدِرها (STAFF/OWNER)، والمفتاح بمعرّفه
import { lotEventActorOf } from '../services/lotsWarehouse';
// D25 للمسار غير المتتبَّع: إعادة قراءة التتبّع FOR KEY SHARE وحدها (لا حارس ولا قفل لوط) — الدالّة نفسها لإلغاء المرتجع وإعادته
import { assertReturnStillUntracked as assertStillUntracked } from '../services/lotsInvoice';
import { shelfLifeOf } from '../services/shelfLife';

const router = Router();
router.use(authenticate);
router.use(requireAccounting); // عزل «النظام المحاسبي»
router.use(requireAdminPermission('canManageVanStock'));

/** مكان اسم مندوبٍ حُذف في سجلّ التحميلات — كتقارير الإقرار اليوميّ */
const REP_GONE_NAME = 'مندوب محذوف';

const loadSchema = z.object({
  salesRepId: z.string().optional(), // الأدمن يحدّده؛ المندوب يُستخدم معرّفه تلقائياً
  // EXPIRED_OUT / DAMAGED_OUT: إزالة المنتهي صلاحيته أو التالف من السيارة (إتلاف) — للإدارة وحدها، من رصيده هو لا من المتاح
  type: z.enum(['LOAD', 'UNLOAD', 'ADJUST', 'EXPIRED_OUT', 'DAMAGED_OUT']).default('LOAD'),
  note: z.string().optional(),
  // «تتبّع اللوط» D30: تنزيلٌ إداري من سيارة مندوبٍ محذوف (UNLOAD وحده، لأصنافٍ متتبَّعة بلوطاتٍ صريحة) — مكان salesRepId
  deletedSalesRepId: z.string().optional(),
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number(), // موجب للتحميل/الإرجاع للمستودع؛ قد تكون سالبة لـADJUST — بوحدة البند
    // وحدة البند (كرتون/حبة). غائبة ⇒ وحدة الأساس بمعامل ١: عميلٌ قديم أو مفتاح API يرسل الكمية بالأساس كما كان
    unitId: z.string().nullish(),
    // ما اقترحه المحرّك وقت التحميل — يُخزَّن للمقارنة لاحقاً. **بالأساس دائماً** مهما كانت وحدة البند:
    // المحرّك يُخرجها بالأساس وقياس الدقّة يقارنها بالمحمَّل بالأساس (services/suggestAccuracy)
    suggestedQty: z.number().optional(),
    expectedQty: z.number().optional(),
    // «الوحدة الرئيسية» §3: وحدة الأساس التي حسب عليها العميل الكمية (Product.unit في كتالوجه) — ومنها بنود إزالة المنتهي والتالف.
    // غائبة ⇒ مسار اليوم حرفياً؛ ومختلفة عن أساس الصنف الآن ⇒ 400 UNIT_INVALID فيعيد تحميل أصنافه. لمفتاح API على صنفٍ حُوِّل: إلزامية (D19)
    baseUnitName: z.string().transform(v => v.slice(0, 64)).nullish(),
    // «تتبّع اللوط» (للصنف المتتبَّع وحده، ويُحلَّل بصرامة في services/lotsVan.ts): lots صفوفٌ صريحة **بالكمية الأساسية** مهما
    // كانت وحدة البند (lotId: null = غير مسمّى)؛ lotNumber وتاريخاه لتشغيلةٍ تُنشأ مع التحميل بلا مستودع (D4) أو التسوية
    // بالزيادة؛ lotReason = 'EXPIRED_UNSOLD_DESTROY' وسم إتلاف المنتهي غير المباع. بلا تحقق هنا: أجسام الشركة المطفأة كما كانت
    lots: z.unknown().optional(),
    lotNumber: z.unknown().optional(),
    productionDate: z.unknown().optional(),
    expiryDate: z.unknown().optional(),
    lotReason: z.unknown().optional(),
  })).min(1),
});

// يحدّد المندوب المستهدف: المندوب=نفسه، الأدمن=من الطلب
function resolveRep(req: AuthRequest, bodyRepId?: string): { salesRepId: string; isRep: boolean } {
  const isRep = req.user?.role === 'SALES_REP';
  if (isRep) return { salesRepId: req.user!.id, isRep: true };
  if (!bodyRepId) throw Object.assign(new Error('يجب تحديد المندوب'), { status: 400 });
  return { salesRepId: bodyRepId, isRep: false };
}

/**
 * حارس نطاق المندوب — يُستدعى في **كل** مسار يستقبل `salesRepId` من الطلب.
 *
 * كل مسارات هذا الملفّ تكشف أداء مندوب بعينه (المحمّل والمُباع والمتبقّي
 * وتاريخ آخر تحميل)، وهو عين ما يحكمه نطاق المستخدم الإداري. و**404 لا 403**
 * كي لا يكشف الردّ نفسه وجود مندوب خارج النطاق.
 *
 * المندوب يُستثنى: له عزله المنفصل، ومعرّفه يأتي من توكنه لا من الطلب.
 */
async function assertRepInScope(req: AuthRequest, tid: string, salesRepId: string): Promise<void> {
  if (req.user?.role === 'SALES_REP') return;
  // حزامٌ ثانٍ: معرّفٌ غير نصّي شرطُ Prisma لا معرّف (انظر queryRepId)
  if (typeof salesRepId !== 'string' || !salesRepId) throw Object.assign(new Error('المندوب غير موجود'), { status: 404 });
  if (!(await canAccessRep(req, tid, salesRepId))) {
    throw Object.assign(new Error('المندوب غير موجود'), { status: 404 });
  }
}

/**
 * معرّف المندوب من الاستعلام **نصاً وحده**. Express يحلّل الاستعلام بـqs فيصير `?salesRepId[in][]=A&salesRepId[in][]=B`
 * كائناً `{ in: [A, B] }` — وتمريره كما هو إلى Prisma شرطٌ لا معرّف: حارس النطاق يجد المندوب الذي في النطاق فيمرّ، ثم
 * يعيد الاستعلام بيانات الاثنين (مراجعة ١٥ أكتوبر ٢٠٢٦). غير النصّ يُعامَل غائباً.
 */
function queryRepId(req: AuthRequest): string | undefined {
  const v = req.query.salesRepId;
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * «تتبّع اللوط» D11: صفوف التوزيع تُضمّ إلى القراءة بـwithLots=1 وحده، وحين الميزة مفعّلة (D8: الإطفاء يُخفي ولا يحذف).
 * بلا المعامل لا استعلام زائد والردّ كما كان حرفياً.
 */
async function withLotsOf(req: AuthRequest, tid: string): Promise<boolean> {
  const v = req.query.withLots;
  if (v !== '1' && v !== 'true') return false;
  return (await prisma.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true } }))?.lotTrackingEnabled === true;
}

/** صفوف توزيع البند (حركةً أو فاتورة) مع رقم التشغيلة وانتهائها — withLots وردّ الإنشاء */
const ITEM_LOTS_INCLUDE = { include: { lot: { select: { lotNumber: true, expiryDate: true } } }, orderBy: { createdAt: 'asc' } } as const;

/**
 * «تتبّع اللوط» D30: هدف التنزيل الإداري من سيارة مندوبٍ محذوف. «الحذف يمضي دائماً» (salesReps.ts) فتبقى سيارته بلوطاتها
 * ويُفرَّغ بـUNLOAD وحده، لإداري غير مقيّد بنطاق والميزة مفعّلة. المعرّف لمندوبٍ محذوفٍ فعلاً: لا مندوب قائم به، وله أثرٌ
 * محفوظ (van_loads.deletedSalesRepId، أو صفوف توزيع فواتيره). رصيد صنف سيارته مجهول، فالتنزيل بلوطاتٍ صريحة يُفحص على صالحها.
 */
async function deletedVanOf(req: AuthRequest, tid: string, data: { salesRepId?: string; type: string; deletedSalesRepId?: string }): Promise<{ vanKey: string; warehouseEnabled: boolean }> {
  if (req.user?.role === 'SALES_REP') throw Object.assign(new Error('تنقيص مخزون السيارة متاح للإدارة فقط'), { status: 403 });
  const key = data.deletedSalesRepId ?? '';
  if (!key) throw Object.assign(new Error('يجب تحديد المندوب'), { status: 400 });
  if (data.salesRepId) throw Object.assign(new Error('حدّد المندوب أو المندوب المحذوف لا كليهما'), { status: 400 });
  if (data.type !== 'UNLOAD') throw Object.assign(new Error('سيارة المندوب المحذوف تُفرَّغ بالتنزيل للمستودع وحده'), { status: 400 });
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true, warehouseEnabled: true } });
  if (t?.lotTrackingEnabled !== true) throw lotErr('LOTS_NOT_ALLOWED');
  if (await adminScopeEnabled(req)) throw lotErr('LOT_SCOPED_USER');
  const live = await prisma.salesRep.findFirst({ where: { id: key, tenantId: tid }, select: { id: true } });
  const past = live ? null
    : (await prisma.vanLoad.findFirst({ where: { tenantId: tid, deletedSalesRepId: key }, select: { id: true } }))
      ?? (await prisma.invoiceItemLot.findFirst({ where: { tenantId: tid, vanKey: key }, select: { id: true } }));
  if (live || !past) throw Object.assign(new Error('المندوب المحذوف غير موجود'), { status: 404 });
  return { vanKey: key, warehouseEnabled: t.warehouseEnabled === true };
}

/** رصيد صنفٍ في السيارة — كل الكميات **بوحدة الأساس** (`unit`)، والواجهة تعرضها بـformatQty */
interface StockRow {
  productId: string; name: string; code: string; unit: string;
  /** «الوحدة الرئيسية» (القاعدة ١٢): عرضٌ فقط — الرصيد يبقى بالأساس */
  primaryUnitId: string | null;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
  /** رصيد «منتهي الصلاحية» في السيارة: مرتجعٌ عاد بعد انتهاء صلاحيته — لا يُباع ولا يدخل `remaining`، ويبقى حتى تزيله الإدارة */
  expired: number;
  /** رصيد «المرتجع التالف» في السيارة: مرتجعٌ سجّله المندوب «بضاعة تالفة» — لا يُباع ولا يدخل `remaining` حتى تزيله الإدارة */
  damaged: number;
}

/**
 * نافذة زمنية اختيارية لتصفية الجدول.
 *
 * ⚠️ الرصيد والتدفّق لا يُصفَّيان بالطريقة نفسها:
 * «المحمَّل» و«المُباع» **تدفّقات** فتُحسب داخل النافذة [from, to].
 * لكن «المتبقّي» **رصيدٌ** لا يخصّ مدّة — فيُحسب تراكميّاً **حتى** `to` لا داخل النافذة.
 * لولا هذا الفصل لظهر مندوبٌ حُمِّل الشهر الماضي وباع هذا الشهر برصيد **سالب**.
 * وحين لا تُمرَّر نافذة يبقى السلوك كما كان حرفياً (كل المستدعين الآخرين).
 */
export interface StockRange { from?: string; to?: string }

export interface StockBucket {
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number;
  expiredIn: number; expiredOut: number; damagedIn: number; damagedOut: number;
}
/**
 * لقطة وحدة الصفّ (الوحدات المتعددة): `unitFactor`/`baseQty` كما في القاعدة، والطيّ يقرأ الكمية بالأساس منهما
 * (baseQtyOf). غائبان ⇒ `qty` بالأساس كما هي — صفٌّ سبق الميزة، أو صفٌّ حوّله قارئه إلى الأساس سلفاً (فلا يُحمل معه
 * المعامل وإلا ضُرب مرّتين).
 */
interface RowUnit { unitFactor?: number | null; baseQty?: number | null }
export interface LoadRow extends RowUnit { productId: string; qty: number; vanLoad: { type: string; createdAt: Date } }
/**
 * returnExpired: بند مرتجعٍ عاد بعد انتهاء صلاحيته (services/invoiceExpiry.ts). returnReason/createdAt: سبب المرتجع ولحظة
 * تسجيله في الخادم — التالف يدخل رصيد «المرتجع التالف» منذ DAMAGED_VAN_SINCE.
 */
export interface InvRow extends RowUnit {
  productId: string | null; qty: number; returnExpired?: boolean | null;
  invoice: { type: string; returnToStock: boolean | null; invoiceDate: Date; returnReason?: string | null; createdAt?: Date | null };
}

// «المرتجع التالف» منذ DAMAGED_VAN_SINCE («من اليوم فصاعداً» — services/vanDamaged.ts)
export { DAMAGED_VAN_SINCE, isDamagedVanReturn };

const blankBucket = (): StockBucket => ({ loaded: 0, unloaded: 0, adjusted: 0, sold: 0, returned: 0, expiredIn: 0, expiredOut: 0, damagedIn: 0, damagedOut: 0 });

/**
 * يطوي الحركات في دلوين: `bal` كل ما وصل (الرصيد)، و`acc` ما وقع داخل النافذة (التدفّق).
 *
 * مستخرَجة صرفةً عمداً: الفرق بين الرصيد والتدفّق هو مكمن الخطأ في هذه الميزة
 * (نافذةٌ على الاثنين معاً تُنتج رصيداً سالباً)، وهو أهمّ ما يستحقّ اختباراً
 * بلا قاعدة بيانات. الصفوف تصل مقيَّدة بـ`to` من الاستعلام، و`from` يُرشَّح هنا.
 */
export function foldStock(loadItems: LoadRow[], invItems: InvRow[], from?: Date): { acc: Map<string, StockBucket>; bal: Map<string, StockBucket> } {
  const acc = new Map<string, StockBucket>();
  const bal = new Map<string, StockBucket>();
  const inWindow = (d: Date) => !from || d >= from;
  const ensure = (map: Map<string, StockBucket>, pid: string) => {
    if (!map.has(pid)) map.set(pid, blankBucket());
    return map.get(pid)!;
  };
  const addLoad = (m: StockBucket, type: string, qty: number) => {
    if (type === 'LOAD') m.loaded += qty;
    else if (type === 'UNLOAD') m.unloaded += qty;
    else if (type === 'EXPIRED_OUT') m.expiredOut += qty; // إزالة المنتهي: من رصيده هو لا من المتاح
    else if (type === 'DAMAGED_OUT') m.damagedOut += qty; // إزالة التالف: من رصيده هو لا من المتاح
    else m.adjusted += qty;
  };
  const addInv = (m: StockBucket, inv: InvRow['invoice'], qty: number, returnExpired?: boolean | null) => {
    if (inv.type === 'RETURN') {
      // المنتهي صلاحيته يدخل السيارة «منتهي الصلاحية» مهما كان سبب الإرجاع — لا يُباع ويبقى حتى تزيله الإدارة
      if (returnExpired) m.expiredIn += qty;
      // والتالف (منذ DAMAGED_VAN_SINCE) يدخل «المرتجع التالف» — لا يُباع مهما كانت returnToStock أو سياسة الصنف
      else if (isDamagedVanReturn(inv)) m.damagedIn += qty;
      // وغيرهما لا يُعاد لمخزون السيارة إلا إذا حُدِّد returnToStock
      else if (inv.returnToStock) m.returned += qty;
    } else m.sold += qty;
  };
  // الكمية بالأساس: تحميل كرتونين (٤٨ حبة) وبيع حبّةٍ من الصنف نفسه يُطويان في رصيدٍ واحد صادق
  for (const it of loadItems) {
    const q = baseQtyOf(it);
    addLoad(ensure(bal, it.productId), it.vanLoad.type, q);
    if (inWindow(it.vanLoad.createdAt)) addLoad(ensure(acc, it.productId), it.vanLoad.type, q);
  }
  for (const it of invItems) {
    // مخزون السيارة للمنتجات وحدها: بندٌ بلا productId وتمريره
    // كان يفتح صفّاً بمفتاح فارغ يلوّث كل الأرصدة.
    if (!it.productId) continue;
    const q = baseQtyOf(it);
    addInv(ensure(bal, it.productId), it.invoice, q, it.returnExpired);
    if (inWindow(it.invoice.invoiceDate)) addInv(ensure(acc, it.productId), it.invoice, q, it.returnExpired);
  }
  return { acc, bal };
}

const rangeEnd = (to?: string) => (to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : undefined);

/** المتاح للبيع في السيارة من رصيد صنف: المحمّل − المنزَّل + التسوية − المُباع + المُرتجع (التالف والمنتهي خارجه) */
export const bucketRemaining = (b: StockBucket) => roundDecimal(b.loaded - b.unloaded + b.adjusted - b.sold + b.returned, 4);

// يحسب مخزون سيارة مندوب لكل منتج: المتبقي = المحمّل − المنزَّل + التسوية − المُباع + المُرتجع
export async function computeStock(tid: string, salesRepId: string, range?: StockRange): Promise<StockRow[]> {
  const from = range?.from ? new Date(range.from) : undefined;
  const to = rangeEnd(range?.to);
  // الاستعلام محدود بـ`to` وحده — فكل ما يعود يدخل الرصيد، والنافذة تُرشَّح في الذاكرة
  // بـ`from`. استعلامٌ واحد لكل مصدر لا اثنان، والمسار يمرّ على كل مندوب في حلقة.
  const inWindow = (d: Date) => !from || d >= from;

  // لقطة وحدة كل صفّ (unitFactor/baseQty) — foldStock يطوي بالأساس منها لا من `qty` الخام
  const [loadItems, invItems, products] = await Promise.all([
    prisma.vanLoadItem.findMany({
      where: { vanLoad: { tenantId: tid, salesRepId, ...(to && { createdAt: { lte: to } }) } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { type: true, createdAt: true } } },
    }),
    prisma.invoiceItem.findMany({
      where: { invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED', ...(to && { invoiceDate: { lte: to } }) } },
      select: {
        productId: true, qty: true, unitFactor: true, baseQty: true, returnExpired: true,
        invoice: { select: { type: true, returnToStock: true, invoiceDate: true, returnReason: true, createdAt: true } },
      },
    }),
    prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, unit: true, code: true, primaryUnitId: true } }),
  ]);

  const { acc, bal } = foldStock(loadItems, invItems, from);

  const prodById = new Map(products.map(p => [p.id, p]));
  const rows: StockRow[] = [];
  // نمرّ على `bal` لا `acc`: صنفٌ في السيارة لم تُحرَّك كميّته داخل النافذة يجب أن
  // يظهر برصيده لا أن يختفي من الجدول.
  for (const [pid, b] of bal) {
    const p = prodById.get(pid);
    if (!p) continue;
    const m = acc.get(pid) ?? blankBucket();
    // تقريب 4 خانات يمحو غبار سلسلة الجمع (3×0.1−0.3 = 5.55e-17 صف شبحي يتصدر الفرز)
    const remaining = bucketRemaining(b);
    const expired = roundDecimal(b.expiredIn - b.expiredOut, 4);
    const damaged = roundDecimal(b.damagedIn - b.damagedOut, 4);
    rows.push({ productId: pid, name: p.name, code: p.code, unit: p.unit, primaryUnitId: p.primaryUnitId ?? null, ...m, remaining, expired, damaged });
  }
  rows.sort((a, b) => b.remaining - a.remaining);
  return rows;
}

// تسجيل حركة تحميل/تنزيل/تسوية لسيارة المندوب
router.post('/loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = loadSchema.parse(req.body);
    // «تتبّع اللوط» D30: سيارة مندوبٍ محذوف مفتاحها معرّفه المحفوظ — لا مندوب يُحلّ ولا نطاق (إداري غير مقيّد وحده)
    const gone = data.deletedSalesRepId !== undefined ? await deletedVanOf(req, tid, data) : null;
    const { salesRepId, isRep } = gone ? { salesRepId: gone.vanKey, isRep: false } : resolveRep(req, data.salesRepId);

    // التنقيص/التسوية (الكميات السالبة و UNLOAD/ADJUST) متاح للإدارة فقط؛ المندوب يُحمّل موجباً فقط
    if (isRep && (data.type !== 'LOAD' || data.items.some(i => i.qty < 0))) {
      res.status(403).json({ success: false, message: 'تنقيص مخزون السيارة متاح للإدارة فقط' });
      return;
    }

    if (!gone) await assertRepInScope(req, tid, salesRepId);
    // عَلَم «لوكيشن» مع صفّ المندوب نفسه (موقعه عمودٌ فيه) — لا استعلام زائد للختم؛ وعَلَما «تتبّع اللوط» والمستودع كذلك
    const rep = gone ? null : await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, include: { tenant: { select: { locationsEnabled: true, lotTrackingEnabled: true, warehouseEnabled: true } } } });
    if (!gone && !rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (isRep && rep?.canManageVanStock === false) { res.status(403).json({ success: false, message: 'غير مسموح لك بإدارة مخزون السيارة' }); return; }
    // «لوكيشن»: التحميل (LOAD وحده — «فقط الفواتير والتحميلات») يُختم بموقع المندوب الآن؛ نقله لاحقاً لا يحرّك الختم.
    // التنزيل والتسوية والإزالة بلا ختم. والميزة المطفأة ⇒ null (services/locations.ts)
    const loadLocationId = data.type === 'LOAD' ? repStampLocation(rep) : null;
    const lotsOn = gone !== null || rep?.tenant?.lotTrackingEnabled === true;

    // البنود غير الصفرية وكلٌّ بموضعه `at` في طلب العميل: به تُعرَّف أسطر خطة اللوط، فيشير تحذيرها وخطؤها ({idx}، §٢.٦) إلى
    // السطر الذي أرسله لا إلى موضعه بعد ترشيح الأصفار. وما سواها (units وترتيب البنود) بموضع البند في `items` كما كان
    const items = data.items.map((i, at) => ({ ...i, at })).filter(i => i.qty !== 0);
    if (!items.length) { res.status(400).json({ success: false, message: 'لا توجد كميات صالحة' }); return; }
    const productIds = [...new Set(items.map(i => i.productId))];
    // الأصناف نفسها بدل العدّ (استعلامٌ واحد كما كان): «الوحدة الرئيسية» §3 تحتاج أساسها وتاريخ تحويلها ووحداتها في الميزتين،
    // و«تتبّع اللوط» علمها واسمها وصلاحيتها (lotProducts) والميزة مفعّلة وحدها. تُقرأ **قبل** حلّ وحدات البنود: فتحويلٌ يلتزم بين
    // القراءتين يجعل الأساس المتوقَّع أقدم من الوحدات المحلولة فيرفضه القفل (409)؛ ولو قُرئت بعدها لرأت الأساس الجديد ومرّ القفل
    // ببندٍ حُلّ معامله على الأساس القديم (طبلية ×50 كرتوناً تُكتب ×50 قارورة). ردود الرفض بترتيبها القائم (الصنف غير الصالح أدناه)
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: tid },
      select: {
        id: true, name: true, unit: true, primaryUnitId: true, baseConvertedAt: true, units: { select: UNIT_SELECT },
        lotTracked: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true,
      },
    });
    // لقطة وحدة كل بند بترتيب `items` — يحلّها الخادم من وحدات الصنف (بلا unitId ⇒ الأساس، ولا استعلام)
    const units = await resolveLineUnits(tid, items, { replay: String(req.headers['x-fs-replay'] || '') === '1' });

    // إزالة المنتهي صلاحيته أو التالف: كمياتٌ موجبة لا تتجاوز رصيده لكل صنف في سيارة هذا المندوب — والفحص والإنشاء
    // تحت قفلٍ استشاري للمندوب ولذلك الرصيد (أدناه) فلا تتجاوز إزالتان متزامنتان رصيده معاً
    const outBucket = data.type === 'EXPIRED_OUT' ? 'expired' : data.type === 'DAMAGED_OUT' ? 'damaged' : null;
    if (outBucket && items.some(i => i.qty < 0)) {
      res.status(400).json({ success: false, message: 'كمية الإزالة يجب أن تكون موجبة' }); return;
    }
    const assertOutAvailable = async (bucket: 'expired' | 'damaged') => {
      const haveById = new Map((await computeStock(tid, salesRepId)).map(s => [s.productId, s[bucket]]));
      // بالأساس: «٢ كرتون» تالفة لا تُزال من رصيد «٢ حبة» تالفة، وكرتونٌ وحبّةٌ من الصنف نفسه يُجمعان
      const want = new Map<string, number>();
      items.forEach((i, idx) => want.set(i.productId, (want.get(i.productId) ?? 0) + toBase(i.qty, { unitFactor: units[idx].factor })));
      for (const [pid, q] of want) {
        const have = haveById.get(pid) ?? 0;
        if (q > have + 1e-9) {
          const what = bucket === 'expired' ? 'المنتهي صلاحيته' : 'التالف';
          // «الوحدة الرئيسية» (R10): صنفٌ له رئيسية ⇒ الرصيد بها «2 كرتون و3 قارورة»؛ وإلا النص القائم حرفياً (I1)
          const p = productById.get(pid);
          const have0 = Math.max(0, have);
          const shown = p && primaryUnitOf(p) ? productQtyText(have0, p) : String(Number(have0.toFixed(3)));
          throw Object.assign(new Error(`الكمية أكبر من ${what} في السيارة (${shown})`), { status: 400 });
        }
      }
    };

    if (products.length !== productIds.length) { res.status(400).json({ success: false, message: 'منتج غير صالح' }); return; }
    const lotProducts = lotsOn ? products : null;
    const productById = new Map(products.map(p => [p.id, p]));
    // «الوحدة الرئيسية» §3: الأساس الذي حُلّت عليه البنود. مفتاح API على صنفٍ حُوِّل بلا baseUnitName ⇒ 400 (D19)، ثم المقارنة
    // الحيّة بما يعرفه العميل ⇒ 400 UNIT_INVALID — والسباق بعدها يحرسه القفل في المعاملة. وفي إعادة الرفع لا 4xx (المستند سُجّل
    // على الجهاز ولا يُعدم): أساسٌ مُرسَل يخالف أساس الصنف ⇒ 503 PRODUCT_UNITS_CHANGED كالسباق، لا كتابةٌ صامتة بأساسٍ يعرف الخادم
    // أنه غير أساس العميل (كمية كرتونٍ تُكتب قوارير)
    const replay = String(req.headers['x-fs-replay'] || '') === '1';
    const expected = expectedBasesOf(products);
    const noBase = missingBaseForApi(!!req.user?.apiKeyId, items, productById);
    if (noBase) { const r = baseUnitRequiredReply(noBase); res.status(r.status).json(r.body); return; }
    const bad = staleClientBase(items, expected);
    if (bad) {
      if (replay) throw new ProductUnitsChangedError([bad]);
      throw new UnitInvalidError(`تغيّرت وحدات «${bad}» — حدّث قائمة الأصناف ثم أعد الحفظ`);
    }
    const preTracked = new Set((lotProducts ?? []).filter(p => p.lotTracked === true).map(p => p.id));
    if (gone && preTracked.size !== productIds.length) {
      res.status(400).json({ success: false, message: 'تنزيل سيارة مندوبٍ محذوف للأصناف المتتبَّعة وحدها' }); return;
    }
    // «تتبّع اللوط» (D9) والميزة مفعّلة: بندٌ يحمل تشغيلةً لصنفٍ غير متتبَّع ⇒ 422 بموضع سطره لا إهمالٌ صامت (واجهةٌ قديمة لصنفٍ
    // أُطفئ تتبّعه: التنزيل بلا صفوف يُنقص الصنف ويُبقي رصيد اللوط فيتكرّر). بلا استعلام؛ والمطفأة (lotProducts null) تُهملها كما كانت
    if (lotProducts) {
      const stray = items.find(i => !preTracked.has(i.productId) && vanLineCarriesLot(i));
      if (stray) throw lotOnUntrackedError(lotProducts.find(p => p.id === stray.productId)?.name ?? '', stray.productId, stray.at);
    }

    // نداء الإنشاء الوحيد (locations.test.ts): الحركة وبنودها — وتوزيع البند على التشغيلات حين تحمل الخطة صفوفه (D2: البند لا يُشطر)
    const createLoad = (db: Prisma.TransactionClient | typeof prisma, plan: VanMovementPlan | null = null) => db.vanLoad.create({
      data: {
        tenantId: tid, salesRepId: gone ? null : salesRepId, type: data.type, note: data.note,
        // D30: تنزيل سيارة مندوبٍ محذوف بمعرّفه المحفوظ، كما يكتبه حذف المندوب على حركاته
        ...(gone && { deletedSalesRepId: gone.vanKey }),
        ...(loadLocationId && { locationId: loadLocationId }),
        createdBy: isRep ? 'REP' : 'ADMIN',
        // لقطة الوحدة + الكمية بالأساس؛ والمقترَح والمتنبَّأ به بالأساس كما أخرجهما المحرّك
        items: {
          create: items.map((i, idx) => ({
            productId: i.productId, ...unitFields(i.qty, units[idx]), suggestedQty: i.suggestedQty ?? null, expectedQty: i.expectedQty ?? null,
            ...(plan && vanItemLotColumns(plan, i.at, { tenantId: tid, productId: i.productId, vanKey: salesRepId, moveType: data.type })),
          })),
        },
      },
      include: { items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(plan && { lots: ITEM_LOTS_INCLUDE }) } } },
    });

    // «تتبّع اللوط» (§٤.٧): في الحركة صنفٌ متتبَّع — يوم الشركة قبل المعاملة، ثم الطابور، ثم معاملةٌ بمهلة اللوط (D13) فيها
    // بالترتيب: قفل الدلو للإزالة، ثم قفل الأصناف (lockLotProducts)، ثم فحص رصيد الإزالة القائم، ثم خطة التوزيع التي تمنع
    // السالب على مستوى اللوط (planVanMovementInTx)، ثم نداء الإنشاء الوحيد. وبلا صنفٍ متتبَّع: المسار القائم أدناه حرفياً
    if (preTracked.size) {
      const byId = new Map((lotProducts ?? []).map(p => [p.id, p]));
      const by = actorOf(req);
      const { day } = await companyDay(prisma, tid);
      const release = await acquireLotQueue(tid, preTracked);
      try {
        const out = await prisma.$transaction(async (tx) => {
          if (outBucket) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`van-${outBucket}:` + salesRepId}))`;
          const locked = await lockLotProducts(tx, tid, productIds);
          // §3: الأساس تحت قفل lockLotProducts نفسه (صفوفه تحمل unit) — بلا قفلٍ ثانٍ، وقبل أي رصيد أو خطة أو كتابة
          assertBasesUnchanged(expected, locked.units);
          if (outBucket) await assertOutAvailable(outBucket); // رصيد الدلو للصنف كما كان، ثم اللوط في الخطة
          const plan = await planVanMovementInTx(tx, {
            tenantId: tid, vanKey: salesRepId, deletedVan: gone !== null, type: data.type,
            warehouseEnabled: gone ? gone.warehouseEnabled : rep?.tenant?.warehouseEnabled === true,
            actor: isRep ? 'REP' : req.user?.apiKeyId ? 'API_KEY' : 'ADMIN', createdBy: by, day, allowUnknown: VAN_LOT_ALLOW_UNKNOWN,
            lines: items.map((i, n) => {
              const p = byId.get(i.productId);
              return {
                // idx موضع السطر في الطلب (i.at) — به تُضمّ صفوفه إلى بنده في createLoad
                idx: i.at, productId: i.productId, productName: p?.name ?? '', shelfLifeOn: !!p && shelfLifeOf(p) !== null,
                // الكمية الأساسية بإشارتها كما تُكتب في البند (unitFields)، ومعامل وحدته لقاعدة الكرتون (D22)
                qty: unitFields(i.qty, units[n]).baseQty, unitFactor: units[n].factor,
                lotsRaw: { lots: i.lots, lotNumber: i.lotNumber, productionDate: i.productionDate, expiryDate: i.expiryDate },
                reason: i.lotReason == null ? null : String(i.lotReason),
              };
            }),
          }, { locked, eventActor: lotEventActorOf(req.user) });
          return { load: await createLoad(tx, plan), warnings: plan.warnings };
        }, { maxWait: 10_000, timeout: 20_000 });
        res.status(201).json({ success: true, data: out.load, warnings: out.warnings });
      } catch (e) {
        // تبدّل الأساس (§3) يُفحص قبل asLotBusy فيمرّ كما هو إلى baseGuardReply أدناه (409/503 PRODUCT_UNITS_CHANGED) — لا يُقرأ
        // انشغالاً من اسم صنفٍ في رسالته. وما سواه: 55P03 و40P01 وP2028 في مسار اللوط ⇒ 503 LOT_BUSY (صندوق المندوب يعيد على 5xx)
        if (e instanceof ProductUnitsChangedError) throw e;
        throw asLotBusy(e) ?? e;
      } finally {
        release();
      }
      return;
    }

    // «تتبّع اللوط» (D25) والميزة مفعّلة: القراءة المسبقة رأت الأصناف كلها غير متتبَّعة — تُعاد قراءة تتبّعها FOR KEY SHARE داخل
    // معاملة الكتابة (بعد قفل الدلو، ترتيب §٣.١). صنفٌ صار متتبَّعاً بين القراءتين ⇒ 503 LOT_BUSY TRACKING_CHANGED بلا حركة فيُعاد
    // بمسار اللوط، وإلا انتظر التبديلُ (FOR UPDATE) التزامنا. لا طابور ولا قفل لوط ولا مهلة جديدة (§١٠.٢)، والمطفأة كما كانت حرفياً.
    // والميزة مفعّلة: مهلة المعاملة الافتراضية (P2028) أو انتظار قفل التبديل تحت الضغط ⇒ 503 LOT_BUSY (asLotBusy كمسار اللوط) فيعيد
    // صندوق المندوب؛ والمطفأة (الإزالة بمعاملتها القائمة) يمرّ خطؤها إلى baseGuardReply ثم المعالج العام.
    // «الوحدة الرئيسية» §3: قفل الأصناف ومقارنة أساسها (lockBases) في كل فرع — بعد القفل الاستشاري للإزالة وقبل إعادة قراءة
    // التتبّع — والفرع المطفأ صار معاملةً لذلك وحده. كلها بمهلة BASE_GUARD_TX (I10)
    const busy = (e: unknown): never => { throw (lotsOn && !(e instanceof ProductUnitsChangedError) ? asLotBusy(e) : null) ?? e; };
    const load = outBucket
      ? await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`van-${outBucket}:` + salesRepId}))`;
        await lockBases(tx, tid, expected);
        if (lotsOn) await assertStillUntracked(tx, tid, productIds);
        await assertOutAvailable(outBucket); // يقرأ الملتزَم: الإزالة السابقة التزمت قبل أن يُفكّ قفلها
        return createLoad(tx);
      }, BASE_GUARD_TX).catch(busy)
      : lotsOn
        ? await prisma.$transaction(async (tx) => {
          await lockBases(tx, tid, expected);
          await assertStillUntracked(tx, tid, productIds);
          return createLoad(tx);
        }, BASE_GUARD_TX).catch(busy)
        : await prisma.$transaction(async (tx) => {
          await lockBases(tx, tid, expected);
          return createLoad(tx);
        }, BASE_GUARD_TX);
    res.status(201).json({ success: true, data: load });
  } catch (err) {
    // §3: تبدّل الأساس أثناء الحفظ ⇒ PRODUCT_UNITS_CHANGED، 409 حيّاً و503 لإعادة الرفع (الصندوق يعيد ولا يُعدم المستند)؛ وانتظار
    // قفل الأصناف (lockBases يحوّله ProductUnitsBusyError) ⇒ 503 PRODUCT_UNITS_BUSY. صنفا خطأ الحارس وحدهما (كـcustomers.ts): مهلة
    // معاملةٍ أو تعطّلٌ متبادل أو انتظار قفل الدلو ليست «وحدات الأصناف قيد التحديث» — تمرّ إلى المعالج العام كما كانت قبل الميزة.
    // LotError (ومنه LOT_BUSY) يمرّ إلى معالج الموجّه كما كان
    const g = err instanceof ProductUnitsChangedError || err instanceof ProductUnitsBusyError
      ? baseGuardReply(err, String(req.headers['x-fs-replay'] || '') === '1') : null;
    if (g) { res.status(g.status).json(g.body); return; }
    next(err);
  }
});

// المخزون الحالي لمندوب (المندوب=سيارته، الأدمن=يمرّر salesRepId)
router.get('/current', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : queryRepId(req);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);
    const rows = await computeStock(tid, salesRepId);
    // الأرصدة بالأساس، ومعها وحدات كل صنف لتعرضها الواجهة «٢ كرتون و٣ حبة» (formatQty) — استعلامٌ واحد هنا لا داخل
    // computeStock: مستدعوه الآخرون (حارس البيع في الفاتورة وملخّص كل المناديب) لا يحتاجونها
    // و«الوحدة الرئيسية»: primaryUnitId في الصفّ نفسه (computeStock) فتعرض الواجهة الرصيد بها — عرضٌ فقط
    const units = await unitsByProduct(tid, rows.map(r => r.productId));
    res.json({ success: true, data: rows.map(r => ({ ...r, units: units.get(r.productId) ?? [] })) });
  } catch (err) { next(err); }
});

/**
 * «تتبّع اللوط»: أرصدة تشغيلات سيارة مندوب (VanLotSnapshotDto، §٧.١) — مرجع المتاح دون اتصال في تطبيق المندوب، وتوسيع صفّ
 * السيارة في اللوحة، وتحذير حذف المندوب. المندوب سيارته، والإدارة تمرّر salesRepId بنطاقها. قراءةٌ بلا قفل؛ والميزة المطفأة 403.
 */
router.get('/lot-balances', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : queryRepId(req);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);
    // المندوب وعلم الشركة في قراءةٍ واحدة
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true, tenant: { select: { lotTrackingEnabled: true } } } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (rep.tenant?.lotTrackingEnabled !== true) { res.status(403).json(lotErrorBody(lotErr('LOTS_NOT_ALLOWED'))); return; }
    res.json({ success: true, data: await vanLotSnapshot(prisma, tid, salesRepId) });
  } catch (err) { next(err); }
});

/**
 * كمية التحميل المقترحة لسيارة مندوب في يوم مُحدَّد.
 *
 * لا يُخزَّن شيء هنا — الاقتراح حساب لحظي من التاريخ. يُخزَّن فقط حين يُنشئ
 * المستخدم تحميلاً فعلياً (suggestedQty على البند)، فتُقارَن لاحقاً بالمُباع.
 *
 * النافذة والهامش معاملان يُدخلهما المستخدم لا ثابتان مخفيّان: شركة توزيع
 * مياه ليست كشركة توزيع مستحضرات، ولا رقم سوق نعرفه نيابةً عنها.
 */
router.get('/suggest', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : queryRepId(req);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);

    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true, name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const windowDays = Math.min(180, Math.max(7, Number(req.query.windowDays) || 28));
    // قيمة غير رقمية تعود للافتراضي لا لصفر: صفر هامش قرار تشغيلي مختلف
    // تماماً عن «لم يُرسَل معامل»، وابتلاعه صامتاً يغيّر التوصية بلا علم أحد.
    const rawBuffer = Number(req.query.bufferPct);
    const bufferPct = Math.min(100, Math.max(0, Number.isFinite(rawBuffer) ? rawBuffer : 15));
    const targetDate = String(req.query.date || '') || new Date().toISOString();

    // نجلب أوسع قليلاً من النافذة ثم يُرشّح المحرّك بدقّة — أرخص من حساب
    // حدود اليوم المحلّي هنا مرّتين بمنطقين مختلفين.
    const since = new Date(new Date(targetDate).getTime() - (windowDays + 2) * 86400000);
    const [items, products, stock] = await Promise.all([
      prisma.invoiceItem.findMany({
        where: {
          productId: { not: null },
          invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED', invoiceDate: { gte: since } },
        },
        select: { productId: true, qty: true, unitFactor: true, baseQty: true, invoice: { select: { invoiceDate: true, type: true } } },
      }),
      // ووحدات الصنف تُرفق بكل صفّ اقتراح: الكمية المقترحة بالأساس، والواجهة تعرضها «٢ كرتون و٣ حبة»
      prisma.product.findMany({
        where: { tenantId: tid, status: { not: 'INACTIVE' } },
        // و«الوحدة الرئيسية»: الاقتراح بها في الواجهة (suggestionChoice) — عرضٌ فقط، الكميات بالأساس كما هي
        select: { id: true, name: true, code: true, unit: true, units: { select: UNIT_SELECT }, primaryUnitId: true },
      }),
      computeStock(tid, salesRepId),
    ]);

    // المبيع والمرتجع بالأساس — كما `onVan` من computeStock. تحويلُ أحدهما دون الآخر يُخطئ الاقتراح بمعامل الكرتون
    const sales: SaleRow[] = [];
    const returns: SaleRow[] = [];
    for (const it of items) {
      if (!it.productId) continue;
      const row = { productId: it.productId, qty: baseQtyOf(it), date: it.invoice.invoiceDate };
      (it.invoice.type === 'RETURN' ? returns : sales).push(row);
    }

    const result = suggestLoad({
      sales, returns, products, targetDate, windowDays, bufferPct,
      onVan: stock.map((s) => ({ productId: s.productId, remaining: s.remaining })),
    });

    res.json({ success: true, data: { ...result, salesRep: rep } });
  } catch (err) { next(err); }
});

// دقّة الاقتراح — «هل يستحقّ المحرّك الثقة؟» رقماً لا انطباعاً.
// يقارن التنبّؤ اليومي المخزَّن مع كل تحميل (expectedQty) بالمبيع الفعلي
// في نفس اليوم، عبر محرّك صرف (services/suggestAccuracy) اختباراتُه تشرح
// المصائد الثلاث: قِس التنبّؤ لا كمية التعبئة، ويوماً تقويمياً لا فترةً
// بين تحميلين، واستبعد اليوم الجاري لأنه لم يكتمل بيعُه.
router.get('/accuracy', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : queryRepId(req);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);

    const days = Math.min(60, Math.max(7, Number(req.query.days) || 14));
    // «اليوم» يومُ المندوب لا الخادم (الخادم UTC): نُزيح كل الطوابع بإزاحة
    // المتصفّح قبل المحرّك — مبيعُ التاسعة مساءً بالرياض ليس من يوم الغد.
    const tzOffsetMin = Math.max(-840, Math.min(840, parseInt(req.query.tz as string) || 0));
    const shift = (d: Date) => new Date(d.getTime() + tzOffsetMin * 60000);
    const since = new Date(Date.now() - (days + 1) * 86400000);

    const [loads, saleItems, products] = await Promise.all([
      prisma.vanLoad.findMany({
        // LOAD وحدها: التسويات والتنقيصات ليست قراراتِ تحميلٍ تنبّؤية
        where: { tenantId: tid, salesRepId, type: 'LOAD', createdAt: { gte: since } },
        select: { id: true, createdAt: true, items: { select: { productId: true, qty: true, unitFactor: true, baseQty: true, suggestedQty: true, expectedQty: true } } },
      }),
      prisma.invoiceItem.findMany({
        where: {
          productId: { not: null },
          invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED', invoiceDate: { gte: since } },
        },
        select: { productId: true, qty: true, unitFactor: true, baseQty: true, invoice: { select: { invoiceDate: true, type: true } } },
      }),
      // ووحدات الصنف ورئيسيّه لعرض صفوف الدقّة (services/suggestAccuracy) — عرضٌ فقط
      prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, code: true, unit: true, units: { select: UNIT_SELECT }, primaryUnitId: true } }),
    ]);

    // المحمَّل والمبيع بالأساس، والمقترَح والمتنبَّأ به مخزَّنان بالأساس أصلاً — وإلا عُدّ تحميل «٢ كرتون» لاقتراح ٤٨
    // «عدم تبنٍّ» وخطأً بأربعةٍ وعشرين ضعفاً
    const result = computeAccuracy({
      loads: loads.map(l => ({
        id: l.id,
        at: shift(l.createdAt),
        items: l.items.filter(i => i.productId).map(i => ({
          productId: i.productId,
          qty: baseQtyOf(i),
          suggestedQty: i.suggestedQty === null ? null : Number(i.suggestedQty),
          expectedQty: i.expectedQty === null ? null : Number(i.expectedQty),
        })),
      })),
      sales: saleItems.filter(i => i.productId).map(i => ({
        productId: i.productId!,
        qty: baseQtyOf(i),
        at: shift(i.invoice.invoiceDate),
        isReturn: i.invoice.type === 'RETURN',
      })),
      now: shift(new Date()),
      products,
    });

    res.json({ success: true, data: { ...result, meta: { days, tzOffsetMin } } });
  } catch (err) { next(err); }
});

// ملخّص مخزون كل المناديب — للأدمن (ينعكس بلوحة التحكم)
router.get('/summary', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // نافذة اختيارية بنفس نمط بقيّة المسارات (from/to بصيغة YYYY-MM-DD).
    // نصّ فاسد يُهمَل بدل أن يرمي: مُصفٍّ خاطئ لا يليق به إسقاط الصفحة كلها.
    const valid = (v?: string) => (v && !Number.isNaN(new Date(v).getTime()) ? v : undefined);
    let from = valid(req.query.from as string | undefined);
    let to = valid(req.query.to as string | undefined);
    // مدى مقلوب: نصحّحه بدل إرجاع جدول فارغ يحيّر المستخدم
    if (from && to && new Date(from) > new Date(to)) [from, to] = [to, from];
    const range = from || to ? { from, to } : undefined;
    const lastLoadBefore = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : undefined;

    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true, name: true, isActive: true, canSellWithoutStock: true } });
    // عهدة الأدوات: رصيد اللحظة (لا تتبع المدّة — عهدةٌ قائمة لا تدفّق)، باستعلامٍ مجمَّع واحد للشركة
    const toolGroups = await prisma.vanToolMove.groupBy({
      by: ['salesRepId', 'type'], where: { tenantId: tid, salesRepId: { in: reps.map(r => r.id) } }, _sum: { qty: true },
    });
    const toolsByRep = toolCountsByRep(toolGroups);
    const data = await Promise.all(reps.map(async r => {
      const rows = await computeStock(tid, r.id, range);
      const lastLoad = await prisma.vanLoad.findFirst({
        // «آخر تحميل» يلتزم نهاية المدّة أيضاً، وإلا عرض الجدولُ تاريخاً خارجها
        where: { tenantId: tid, salesRepId: r.id, type: 'LOAD', ...(lastLoadBefore && { createdAt: { lte: lastLoadBefore } }) },
        orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      });
      // المجاميع عبر الأصناف بوحدات الأساس (حبّات لا كراتين) — computeStock بالأساس، فلصنفٍ بلا وحدات لا يتغيّر شيء
      return {
        salesRepId: r.id, repName: r.name, isActive: r.isActive, canSellWithoutStock: r.canSellWithoutStock,
        productCount: rows.filter(x => Math.abs(x.remaining) > 1e-9).length,
        totalRemaining: roundDecimal(rows.reduce((s, x) => s + x.remaining, 0), 4),
        totalLoaded: roundDecimal(rows.reduce((s, x) => s + x.loaded, 0), 4),
        totalSold: roundDecimal(rows.reduce((s, x) => s + x.sold, 0), 4),
        // «المرتجع التالف»: رصيدٌ حتى نهاية المدّة كالمتبقّي، لا يُباع
        // الموجب وحده: رصيدٌ سالب لصنف (إلغاء مرتجعٍ بعد إزالة بضاعته) لا يُخفي تالفاً حقيقياً لصنفٍ آخر في المجموع
        totalDamaged: roundDecimal(rows.reduce((s, x) => s + Math.max(0, x.damaged), 0), 4),
        toolsCount: toolsByRep.get(r.id) ?? 0,
        lastLoadAt: lastLoad?.createdAt || null,
      };
    }));
    // `filtered` تُخبر الواجهة أن «محمَّل/مباع» صارا تدفّقَي مدّة لا إجماليين
    res.json({ success: true, data, filtered: !!range, from: from || null, to: to || null });
  } catch (err) { next(err); }
});

// تبديل صلاحية «البيع بدون مخزون» لمندوب — للإدارة فقط
router.patch('/sell-permission', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { salesRepId, canSellWithoutStock } = z.object({
      salesRepId: z.string(), canSellWithoutStock: z.boolean(),
    }).parse(req.body);
    await assertRepInScope(req, tid, salesRepId);
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    await prisma.salesRep.update({ where: { id: salesRepId }, data: { canSellWithoutStock } });
    res.json({ success: true, data: { salesRepId, canSellWithoutStock } });
  } catch (err) { next(err); }
});

/** أنواع حركات السيارة المقبولة في فلتر سجلّ التحميلات (نصٌّ من القائمة وحدها — غيره يُهمل) */
const LOAD_TYPES = ['LOAD', 'UNLOAD', 'ADJUST', 'EXPIRED_OUT', 'DAMAGED_OUT'] as const;
/** أقصى صفحة لسجلّ التحميلات المرقَّم — البنود تُضمَّن مع كل حركة */
const LOADS_MAX_PAGE = 200;

/**
 * سجل التحميلات. بلا معاملات: آخر ١٠٠ حركة كما كان حرفياً (مستدعو المسار القائمون). ومعاملاتٌ اختيارية كلّها بالنشر
 * الشرطيّ (لا مفتاح يُضاف حين تغيب):
 * - `locationId` («لوكيشن»): معرّف موقع أو `none` («بلا موقع») — بختم الحركة لا بموقع المندوب الحاليّ.
 * - `type`: نوع الحركة (LOAD للتحميلات وحدها).
 * - `from`/`to` (YYYY-MM-DD): بأيام الشركة (tenantTz) على لحظة التسجيل (createdAt — لا تاريخ مستندٍ للتحميل)؛
 *   تُقرأ منطقة الشركة حين يُطلب المدى وحده.
 * - `page`/`limit`: ترقيمٌ مع `pagination` في الردّ (الحدّ ٢٠٠)؛ وبلا page يبقى سقف ١٠٠ بلا عدّ.
 */
router.get('/loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : queryRepId(req);
    if (salesRepId) await assertRepInScope(req, tid, salesRepId);
    const location = locationFilterOf(req.query.locationId);
    const type = typeof req.query.type === 'string' && (LOAD_TYPES as readonly string[]).includes(req.query.type) ? req.query.type : undefined;
    const wantsRange = (typeof req.query.from === 'string' && !!req.query.from) || (typeof req.query.to === 'string' && !!req.query.to);
    let createdAt: { gte: Date; lt: Date } | undefined;
    if (wantsRange) {
      const range = paymentMethodsRange(req.query.from, req.query.to, await tenantTz(tid));
      if (!range.ok) { res.status(400).json({ success: false, message: range.message }); return; }
      createdAt = { gte: range.gte, lt: range.lt };
    }
    const paged = typeof req.query.page === 'string' && !!req.query.page;
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(LOADS_MAX_PAGE, Math.max(1, parseInt(String(req.query.limit)) || 50));
    const where = {
      tenantId: tid,
      ...(salesRepId && { salesRepId }),
      ...locationDocWhere(location),
      ...(type && { type }),
      ...(createdAt && { createdAt }),
      // القيد يغطّي حالة عدم تمرير معرّف: بلا نطاق يعود {} فلا يتغيّر شيء
      ...(await scopedRepRecordWhere(req)),
    };
    // «تتبّع اللوط» (D11): items[].lots بتشغيلاتها مع withLots=1 والميزة مفعّلة — وبدونه الردّ كما كان
    const withLots = await withLotsOf(req, tid);
    const [loads, total] = await Promise.all([
      prisma.vanLoad.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: paged ? (page - 1) * limit : undefined,
        take: paged ? limit : 100,
        include: {
          items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(withLots && { lots: ITEM_LOTS_INCLUDE }) } },
          salesRep: { select: { id: true, name: true } },
          // «لوكيشن»: اسم الموقع المختوم (عمود السجلّ) — null لما بلا ختم
          location: { select: { id: true, name: true } },
        },
      }),
      paged ? prisma.vanLoad.count({ where }) : Promise.resolve(null),
    ]);
    // تحميلات مندوبٍ محذوف تبقى (حركة مخزون) بلا مندوب — اسمٌ صريح لا null يكسر الواجهة.
    // والمستخدم المقيَّد لا يراها أصلاً: قيد النطاق علاقةٌ بمندوب، والمفرَّغ لا يطابقها.
    res.json({
      success: true,
      data: loads.map(l => ({ ...l, salesRep: l.salesRep ?? { id: null, name: REP_GONE_NAME }, location: l.location ?? null })),
      ...(total !== null && { pagination: { total, page, limit, pages: Math.ceil(total / limit) } }),
    });
  } catch (err) { next(err); }
});

// حركة المخزون عبر الزمن (تحميلات + مبيعات + مرتجعات) — كم نزل من البضاعة ومتى
router.get('/movements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : queryRepId(req);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);
    // «تتبّع اللوط» (D11): تشغيلات كل بندٍ (حركةً وفاتورة) مع withLots=1 والميزة مفعّلة — وبدونه الردّ كما كان
    const withLots = await withLotsOf(req, tid);

    const [loads, invoices] = await Promise.all([
      prisma.vanLoad.findMany({
        where: { tenantId: tid, salesRepId }, orderBy: { createdAt: 'desc' }, take: 50,
        include: { items: { include: { product: { select: { name: true, unit: true, primaryUnitId: true } }, ...(withLots && { lots: ITEM_LOTS_INCLUDE }) } } },
      }),
      prisma.invoice.findMany({
        where: { tenantId: tid, salesRepId, status: 'CONFIRMED' }, orderBy: { invoiceDate: 'desc' }, take: 50,
        include: { items: { include: { product: { select: { name: true, unit: true, primaryUnitId: true } }, ...(withLots && { lots: ITEM_LOTS_INCLUDE }) } }, customer: { select: { name: true } } },
      }),
    ]);
    // المستخدم المقيَّد (ومشرف الفرق بوسم الفاتورة): حركة فاتورةٍ خارج نطاقه تبقى بكمّياتها (رصيد السيارة واحد) بلا رقمها
    // ولا عميلها — مندوبٌ في فريقين لا يكشف مبيعات الفريق الآخر. والمندوب وغير المقيَّد بلا استعلامٍ إضافيّ
    const docScope = isRep ? {} : await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const visible = Object.keys(docScope).length
      ? new Set((await prisma.invoice.findMany({ where: { id: { in: invoices.map(i => i.id) }, ...docScope }, select: { id: true } })).map(i => i.id))
      : null;

    // البند بلقطة وحدته: «٢ كرتون» تبقى كرتوناً لا «٢ حبة» (وحدة الصنف صارت الأساس)، و`baseQty` لمن يجمع الحركات.
    // و«الوحدة الرئيسية»: primaryUnitId للبند (R2، فخّ «×5») — حاضرٌ دائماً و null لصنفٍ بلا رئيسية (D18، كصفوف /current)
    const primaryOf = (p: { primaryUnitId?: string | null } | null | undefined) => ({ primaryUnitId: p?.primaryUnitId || null });
    const movements = [
      ...loads.map(l => ({
        kind: l.type, date: l.createdAt, ref: l.note || '', by: l.createdBy,
        items: l.items.map(i => ({ name: i.product.name, unit: i.unitName ?? i.product.unit, qty: i.qty, baseQty: baseQtyOf(i), ...primaryOf(i.product), ...(withLots && { lots: (i as { lots?: unknown }).lots ?? [] }) })),
      })),
      ...invoices.map(inv => ({
        // المرتجع التالف (منذ DAMAGED_VAN_SINCE) يدخل رصيد «المرتجع التالف» لا المتاح — فيُوسم بذلك في الحركة
        kind: inv.type === 'RETURN' ? (isDamagedVanReturn(inv) ? 'RETURN_DAMAGED' : 'RETURN') : 'SALE', date: inv.invoiceDate,
        ref: !visible || visible.has(inv.id) ? `${inv.number} · ${inv.customer.name}` : 'مستند خارج نطاقك', by: 'REP',
        items: inv.items.map(i => ({ name: i.product?.name ?? 'صنف محذوف', unit: i.unitName ?? i.product?.unit ?? '', qty: i.qty, baseQty: baseQtyOf(i), ...primaryOf(i.product), ...(withLots && { lots: (i as { lots?: unknown }).lots ?? [] }) })),
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 60);

    res.json({ success: true, data: movements });
  } catch (err) { next(err); }
});

// ═══ عهدة أدوات السيارة (طلب المالك ١٥ أكتوبر ٢٠٢٦) ═══
// عربة تحميل، سلة… تُسلَّم لسيارة المندوب عهدةً. دفتر حركات (VanToolMove): تسليمٌ ISSUE أو استلامٌ RETURN، والرصيد مشتقّ.
// الإدارة تسجّل (requireAdmin + نطاق المندوب)، والمندوب يطّلع على عهدته وحده. ليست بضاعة: لا تمسّ مخزون السيارة ولا المستودع.

/** مفتاح اسم الأداة: «سلة»، « سلة »، و«سلة  كبيرة» بمسافتين = أداةٌ واحدة؛ والحروف اللاتينية بلا حالة */
export const toolKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * أرصدة العهدة لكل أداة من حركاتها بترتيبها الزمني: المسلَّم − المستلَم، والاسم المعروض أول ما سُجّل به. أداةٌ رصيدها
 * صفر (سُلّمت ثم استُلمت كلها) لا تظهر.
 */
export function foldTools(moves: { toolName: string; qty: number; type: string }[]): { toolName: string; qty: number }[] {
  const byKey = new Map<string, { toolName: string; qty: number }>();
  for (const m of moves) {
    const k = toolKey(m.toolName);
    const row = byKey.get(k) ?? { toolName: m.toolName.trim().replace(/\s+/g, ' '), qty: 0 };
    row.qty += m.type === 'RETURN' ? -m.qty : m.qty;
    byKey.set(k, row);
  }
  return [...byKey.values()].filter(r => r.qty !== 0).sort((a, b) => b.qty - a.qty || a.toolName.localeCompare(b.toolName, 'ar'));
}

/** عدد الأدوات في عهدة كل مندوب من مجموعٍ مجمَّع (salesRepId × type) */
export function toolCountsByRep(groups: { salesRepId: string | null; type: string; _sum: { qty: number | null } }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) {
    if (!g.salesRepId) continue;
    const q = g._sum.qty ?? 0;
    out.set(g.salesRepId, (out.get(g.salesRepId) ?? 0) + (g.type === 'RETURN' ? -q : q));
  }
  return out;
}

const toolMoveSchema = z.object({
  salesRepId: z.string().min(1),
  type: z.enum(['ISSUE', 'RETURN']),
  note: z.string().trim().max(300).optional(),
  items: z.array(z.object({
    toolName: z.string().trim().min(1, 'اكتب اسم الأداة').max(80),
    qty: z.number().int('العدد يجب أن يكون عددا صحيحا').positive('العدد يجب أن يكون أكبر من صفر').max(100000),
  })).min(1).max(50),
});

// عهدة الأدوات لمندوب: الأرصدة وآخر الحركات (المندوب=سيارته، الأدمن=يمرّر salesRepId) + أسماء أدوات الشركة للإدارة
router.get('/tools', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : queryRepId(req);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);
    const [moves, names] = await Promise.all([
      prisma.vanToolMove.findMany({
        where: { tenantId: tid, salesRepId }, orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, toolName: true, qty: true, note: true, createdByName: true, createdAt: true },
      }),
      // اقتراحات الاسم في نموذج التسليم — من كل أدوات الشركة، للإدارة وحدها
      isRep ? Promise.resolve([] as { toolName: string }[]) : prisma.vanToolMove.findMany({
        where: { tenantId: tid }, distinct: ['toolName'], select: { toolName: true }, take: 200,
      }),
    ]);
    const balances = foldTools(moves);
    res.json({
      success: true,
      data: {
        balances,
        total: balances.reduce((s, b) => s + b.qty, 0),
        moves: moves.slice(-100).reverse(),
        names: [...new Map(names.map(n => [toolKey(n.toolName), n.toolName.trim().replace(/\s+/g, ' ')])).values()].sort((a, b) => a.localeCompare(b, 'ar')),
      },
    });
  } catch (err) { next(err); }
});

// تسليم أدوات للسيارة أو استلامها منها — للإدارة. الاستلام لا يتجاوز ما في العهدة، والفحص والكتابة تحت قفلٍ استشاري
// للمندوب فلا يتجاوز استلامان متزامنان رصيده معاً
router.post('/tools', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = toolMoveSchema.parse(req.body);
    await assertRepInScope(req, tid, data.salesRepId);
    const rep = await prisma.salesRep.findFirst({ where: { id: data.salesRepId, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    // سطران للأداة نفسها في الطلب يُجمعان — والاسم بصيغته الموحّدة
    const want = new Map<string, { toolName: string; qty: number }>();
    for (const i of data.items) {
      const k = toolKey(i.toolName);
      const row = want.get(k) ?? { toolName: i.toolName.trim().replace(/\s+/g, ' '), qty: 0 };
      row.qty += i.qty;
      want.set(k, row);
    }
    const actor = actorOf(req);
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'van-tools:' + data.salesRepId}))`;
      if (data.type === 'RETURN') {
        const have = new Map(foldTools(await tx.vanToolMove.findMany({
          where: { tenantId: tid, salesRepId: data.salesRepId }, orderBy: { createdAt: 'asc' },
          select: { toolName: true, qty: true, type: true },
        })).map(b => [toolKey(b.toolName), b]));
        for (const [k, w] of want) {
          const h = have.get(k)?.qty ?? 0;
          if (w.qty > h) throw Object.assign(new Error(`العدد أكبر من عهدة «${w.toolName}» في السيارة (${Math.max(0, h)})`), { status: 400 });
          w.toolName = have.get(k)!.toolName; // الاستلام باسم التسليم نفسه
        }
      }
      await tx.vanToolMove.createMany({
        data: [...want.values()].map(w => ({
          tenantId: tid, salesRepId: data.salesRepId, type: data.type, toolName: w.toolName, qty: w.qty,
          // جلسة المالك تُسجَّل OWNER:<المعرّف> و«الدعم الفني» لا باسم مدير الشركة (actorOf)
          note: data.note || null, createdById: actor, createdByName: actor.startsWith('OWNER:') ? 'الدعم الفني' : (req.user?.name ?? null),
        })),
      });
      return want.size;
    });
    res.status(201).json({ success: true, data: { count: created } });
  } catch (err) { next(err); }
});

// أخطاء هذا الموجّه ذات status (4xx): «يجب تحديد المندوب»، «المندوب غير موجود»، تجاوز رصيد الإزالة أو العهدة — تُردّ
// بحالتها ورسالتها. معالج الأخطاء العام لا يقرأ status فيردّها 500، ولمفتاح API «خطأ في الخادم» بلا سبب.
router.use((err: unknown, _req: AuthRequest, res: Response, next: NextFunction) => {
  // «تتبّع اللوط» قبل فرع 4xx: LotError بحالته ورمزه وتفاصيله (ومنه 503 LOT_BUSY الذي يتجاوزه فرع 4xx). الانشغال حُوِّل إليه
  // في مسار اللوط وحده (asLotBusy في POST /loads، ومعه غير المتتبَّع والميزة مفعّلة)، فمهلة معاملةٍ في مسارٍ بلا لوط (العهدة) تبقى
  // كما كانت. وPOST /loads يردّ تبدّل الأساس وانتظار قفل الأصناف (§3) في catch المسار نفسه (baseGuardReply) قبل أن يصل هنا
  const lh = err instanceof LotError ? lotHttpError(err) : null;
  if (lh) { res.status(lh.status).json(lh.body); return; }
  const status = (err as { status?: unknown })?.status;
  if (err instanceof Error && typeof status === 'number' && status >= 400 && status < 500) {
    // وحدة بند غير صالحة (UnitInvalidError): برمزها UNIT_INVALID كبقية مسارات الكتابة (errorHandler)
    const unitInvalid = (err as { code?: unknown }).code === 'UNIT_INVALID';
    res.status(status).json(unitInvalid ? { success: false, code: 'UNIT_INVALID', message: err.message } : { success: false, message: err.message });
    return;
  }
  next(err);
});

export default router;
