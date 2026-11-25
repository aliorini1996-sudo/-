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
import {
  unitsByProduct, UnitInvalidError, UNIT_SELECT, assertWarehouseCovers, WarehouseInsufficientError, vanKeyOf,
} from '../services/warehouseStock';
// «الربط لا يُرفض» (أمر المالك ٩ نوفمبر ٢٠٢٦): الحركة تُقبل بما يمكن معالجته، والمتروك أو المعدَّل تحذيرٌ في ردّ النجاح
import { countMatchesWarning, lenientStockLines, lotIgnoredWarning, noQuantitiesWarning, stockNoopBody, zeroQtyIgnoredWarnings, type StockWarning } from '../services/stockLenient';
// «ربط الدفاتر» L1: سبب تسوية السيارة (ADJUST) من قائمةٍ ثابتة — الفحص المشترك مع تسوية المستودع (الواجهة 400، ومفتاح API تحذير)
import { VAN_ADJUST_REASONS } from '../services/suppliers/core';
import { isSupplierError, supplierErrorBody } from '../services/suppliers/payments';
import { resolveAdjustReason } from '../services/suppliers/warehouseBills';
// مفتاح منع التكرار لحركات السيارة (D8): بلا قيدٍ فريد — قفلٌ استشاري على المرجع ثم البحث به داخل المعاملة
import { CLIENT_REF_SCHEMA, ClientRefReplay, clientRefQuery, lockClientRef } from '../services/stockClientRef';
// حدود أيام ملخّص السيارات بتوقيت الشركة كسجلّ التحميلات (#14)
import { addDays, isLocalDate, zonedStartOfDay } from '../services/gl/dates';
// ملخّص المناديب بالوحدة الكبرى لكل صنف (عرضٌ فقط — المجاميع بالأساس كما هي)
import { repStockMajor } from '../services/majorUnitTotals';
// «الوحدة الرئيسية» §3 (#2 و#4): كل حركة تُقارن الأساس الذي يعرفه العميل حيّاً، ثم الأساس الذي حُلّت عليه تحت قفل الأصناف
import {
  BASE_GUARD_TX, ProductUnitsBusyError, ProductUnitsChangedError, assertBasesUnchanged, baseGuardReply, baseUnitRequiredReply, expectedBasesOf, lockBases,
  missingBaseForApi, staleClientBase,
} from '../services/baseGuard';
// «تتبّع اللوط»: حركات السيارة بالتشغيلات (§٤.٧) — كلها خلف علم الشركة وعلم الصنف؛ المطفأ والصنف غير المتتبَّع كما كانا حرفياً
import { LotError, asLotBusy, lotErr, lotErrorBody, lotHttpError } from '../services/lots';
import { acquireLotQueue, companyDay, lockLotProducts, type LotEventActor } from '../services/lotsDb';
import {
  VAN_LOT_ALLOW_UNKNOWN, VanCountPostcondition, VanPlanNoop, executeVanCountInTx, lotOnUntrackedError, planVanMovementInTx, vanAppliedItemFields,
  vanItemLotColumns, vanLineCarriesLot, vanLotSnapshot, vanPlanWritesNothing, type VanCountLine, type VanMovementPlanResult,
} from '../services/lotsVan';
// فاعل سجل تدقيق اللوط بالمساعد نفسه للمستودع والاستيراد: جلسة «دخول» بمُصدِرها (STAFF/OWNER)، والمفتاح بمعرّفه
import { lotEventActorOf } from '../services/lotsWarehouse';
// D25 للمسار غير المتتبَّع: إعادة قراءة التتبّع FOR KEY SHARE وحدها (لا حارس ولا قفل لوط) — الدالّة نفسها لإلغاء المرتجع وإعادته
import { assertReturnStillUntracked as assertStillUntracked } from '../services/lotsInvoice';
import { shelfLifeOf } from '../services/shelfLife';
// «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦): التحميل المعلّق وقبوله وتوقيعه — الحركة نفسها بمسار POST /loads وحده
import {
  PENDING_LINE_ALTERING, PENDING_SELECT, PENDING_STATUSES, PendingLinesChanged, PendingLoadSettled, VanDryRun, notifyPendingLoad,
  pendingAcceptSchema, pendingActorName, pendingCancelSchema, pendingDisputeSchema, pendingEventActor, pendingLinesView, pendingLoadLockKey,
  pendingLoadView, pendingRefusal, reopenRepRequestsOf, storedEventActor, vanLoadAcceptanceOn, type PendingLoadCode, type PendingRow,
  type PendingVanLoadView,
} from '../services/vanPendingLoads';

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
  // مفتاح منع التكرار (D8): واحدٌ لكل محاولة حفظ يُعاد مع إعادتها — المكرَّر يردّ الحركة القائمة 200 بلا كتابة. غائبٌ ⇒ كما كان
  clientRef: CLIENT_REF_SCHEMA.optional(),
  // الجرد المطلق (طلب المالك ١٦ نوفمبر ٢٠٢٦، لمفتاح الربط وحده): type ADJUST وmode COUNT ⇒ qty الكمية المعدودة (والصفر ذو معنى)
  // لا الفرق، وlots[] (اختياري، بالأساس) التشغيلات المعدودة وغير المذكورة صفر. scope VAN: كل صنفٍ في السيارة غير مذكور يصير صفراً،
  // وincludeUnsellable يصفّر المنتهي والتالف معه. غائبٌ (DELTA) ⇒ الحركة كما كانت حرفياً
  mode: z.enum(['DELTA', 'COUNT']).optional(),
  scope: z.enum(['LINES', 'VAN']).optional(),
  includeUnsellable: z.boolean().optional(),
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number(), // موجب للتحميل/الإرجاع للمستودع؛ قد تكون سالبة لـADJUST — بوحدة البند
    // وحدة البند (كرتون/حبة). غائبة ⇒ وحدة الأساس بمعامل ١: عميلٌ قديم أو مفتاح API يرسل الكمية بالأساس كما كان
    unitId: z.string().nullish(),
    // ما اقترحه المحرّك وقت التحميل — يُخزَّن للمقارنة لاحقاً. **بالأساس دائماً** مهما كانت وحدة البند:
    // المحرّك يُخرجها بالأساس وقياس الدقّة يقارنها بالمحمَّل بالأساس (services/suggestAccuracy)
    suggestedQty: z.number().optional(),
    expectedQty: z.number().optional(),
    // «مرجع السطر»: معرّف السطر في نظام المُكامِل (الربط البرمجي) — يُحفظ على البند ويعود معه كما هو في الردّ والسجلّ والحركات
    // والمزامنة. لا تفرّد ولا تحقق سوى الطول (فوق ١٠٠ ⇒ 400)، والفراغ بعد القصّ ⇒ null. الواجهات وتطبيق المندوب لا ترسله
    lineRef: z.string().trim().max(100).nullish(),
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
    // معرّف تشغيلةٍ مسطَّح على البند (مفتاح الربط): كان يُحذف بصمت فيسحب الخادم غيرها — صار تفضيلاً للبند كله. الواجهة لا ترسله
    lotId: z.unknown().optional(),
  })).min(1),
  // «ربط الدفاتر» L1: سبب التسوية ADJUST — COUNT | DAMAGE | EXPIRY | SHORTAGE_REP (عجز على المندوب) | SAMPLE | OTHER. لغير ADJUST يُهمل.
  // بلا تحقق نوعٍ هنا: غير الصالح ⇒ 400 ADJUST_REASON_INVALID للواجهة، ويُهمل بتحذير ADJUST_REASON_IGNORED لمفتاح API («الربط لا يُرفض»)
  reason: z.unknown().optional(),
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
  /** حالة الصنف كما خُزّنت (ACTIVE | INACTIVE) وأرشفته (deletedAt) — عرضٌ فقط (S1): وسم «موقوف/محذوف» على صفّ السيارة */
  status?: string;
  archived?: boolean;
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
export interface StockRange {
  from?: string; to?: string;
  /**
   * حدّا المدّة لحظاتٍ بتوقيت الشركة (#14، ملخّص المناديب): `fromAt` بداية يوم from، و`toBefore` بداية اليوم التالي لـto (حصرية).
   * يغلبان النصّين حين يُمرَّران؛ وبدونهما السلوك القائم حرفياً (منتصف ليل UTC ونهاية اليوم بساعة الخادم)
   */
  fromAt?: Date; toBefore?: Date;
}

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
  const from = range?.fromAt ?? (range?.from ? new Date(range.from) : undefined);
  // نهاية المدّة: لحظةٌ حصرية بتوقيت الشركة إن مُرِّرت (#14)، وإلا نهاية اليوم كما كانت
  const to = range?.toBefore ? undefined : rangeEnd(range?.to);
  const toWhere = range?.toBefore ? { lt: range.toBefore } : to ? { lte: to } : undefined;
  // الاستعلام محدود بـ`to` وحده — فكل ما يعود يدخل الرصيد، والنافذة تُرشَّح في الذاكرة
  // بـ`from`. استعلامٌ واحد لكل مصدر لا اثنان، والمسار يمرّ على كل مندوب في حلقة.
  const inWindow = (d: Date) => !from || d >= from;

  // لقطة وحدة كل صفّ (unitFactor/baseQty) — foldStock يطوي بالأساس منها لا من `qty` الخام
  const [loadItems, invItems, products] = await Promise.all([
    prisma.vanLoadItem.findMany({
      where: { vanLoad: { tenantId: tid, salesRepId, ...(toWhere && { createdAt: toWhere }) } },
      select: { productId: true, qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { type: true, createdAt: true } } },
    }),
    prisma.invoiceItem.findMany({
      where: { invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED', ...(toWhere && { invoiceDate: toWhere }) } },
      select: {
        productId: true, qty: true, unitFactor: true, baseQty: true, returnExpired: true,
        invoice: { select: { type: true, returnToStock: true, invoiceDate: true, returnReason: true, createdAt: true } },
      },
    }),
    // والحالة والأرشفة (S1) في القراءة نفسها: وسم «موقوف/محذوف» على صفّ السيارة بلا استعلام زائد
    prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, unit: true, code: true, primaryUnitId: true, status: true, deletedAt: true } }),
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
    rows.push({
      productId: pid, name: p.name, code: p.code, unit: p.unit, primaryUnitId: p.primaryUnitId ?? null,
      ...(p.status != null && { status: p.status }), ...(p.deletedAt !== undefined && { archived: p.deletedAt != null }),
      ...m, remaining, expired, damaged,
    });
  }
  rows.sort((a, b) => b.remaining - a.remaining);
  return rows;
}

/**
 * أصناف بنود حركة السيارة في قراءةٍ واحدة: الأساس وتاريخ تحويله ووحداته («الوحدة الرئيسية» §3)، وعلم التتبّع واسمه وصلاحيته
 * («تتبّع اللوط»)، والأرشفة والرمز («الربط لا يُرفض»: توأم المؤرشف الحيّ). بها تُقرأ التوائم أيضاً (services/stockLenient.ts)
 */
const VAN_LINE_PRODUCT_SELECT = {
  id: true, name: true, code: true, unit: true, primaryUnitId: true, baseConvertedAt: true, units: { select: UNIT_SELECT },
  lotTracked: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true, deletedAt: true,
} as const;

type LoadBody = z.infer<typeof loadSchema>;
/** ردّ مسار الحركة: Express Response، أو ملتقِطٌ يقرأ منه قبولُ التحميل المعلّق الحكمَ بلا إرسال */
interface VanReply { status(code: number): { json(body: unknown): unknown } }
interface CapturedReply extends VanReply { code: number | null; body: Record<string, unknown> | null }
function captureReply(): CapturedReply {
  const r: CapturedReply = {
    code: null, body: null,
    status(c: number) { r.code = c; return { json(b: unknown) { r.body = b as Record<string, unknown>; return r; } }; },
  };
  return r;
}
/**
 * «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦): مداخل مسار الحركة لتجربة الإرسال وللقبول — غائبةٌ كلها ⇒ الحركة كما
 * كانت حرفياً (POST /loads نفسه)
 */
interface VanMovementOptions {
  /** قبول المعلّق: حركةٌ كأن الإدارة أنشأتها لسيارة هذا المندوب (isRep=false) بفاعل المرسِل */
  asAdmin?: { salesRepId: string; actorId: string; eventActor: LotEventActor };
  /** أول ما في كل معاملة كتابة (داخل refGate قبل مرجع D8): قفل صفّ المعلّق وحالته */
  gate?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** داخل المعاملة قبل نداء الإنشاء الوحيد بكل التحذيرات (التساهل ثم خطة اللوط) — يرمي ليُلغي المعاملة */
  beforeCreate?: (warnings: ReadonlyArray<{ code: string }>) => void;
  /** ختم القبول على الحركة */
  stamp?: { acceptedAt: Date; pendingLoadId: string };
  /** بعد الإنشاء في المعاملة نفسها */
  afterCreate?: (tx: Prisma.TransactionClient, load: { id: string }) => Promise<void>;
}

// تسجيل حركة تحميل/تنزيل/تسوية لسيارة المندوب
router.post('/loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = loadSchema.parse(req.body);
    // الجرد المطلق (mode COUNT) مسارٌ مستقلّ بأقفاله وخطته (runVanCount أدناه) — والحركة بالفرق (DELTA، الغائب) كما كانت حرفياً
    if (data.mode === 'COUNT') {
      await runVanCount(req, res, {
        salesRepId: data.salesRepId, type: data.type, deleted: data.deletedSalesRepId !== undefined, clientRef: data.clientRef ?? null, note: data.note ?? null,
        scope: data.scope ?? 'LINES', includeUnsellable: data.includeUnsellable === true, items: data.items, zero: false,
      });
      return;
    }
    // «قبول المندوب للتحميل» (طلب المالك ٢٢ نوفمبر ٢٠٢٦): تحميل الإدارة والميزة مفعّلة ⇒ معلّقٌ بلا أثر حتى يقبله المندوب ويوقّعه
    if (await pendingLoadWanted(req, tid, data)) { await createPendingLoad(req, res, data); return; }
    await executeVanMovement(req, res, data);
  } catch (err) { next(err); }
});

/**
 * حركة السيارة بالفرق (DELTA): التحميل والتنزيل والتسوية والإزالة — جسم POST /loads كما كان حرفياً، ومعه قبول التحميل المعلّق
 * وتجربة إرساله (opts). الأخطاء التي لها ردّ تُردّ هنا، وغيرها يُرمى لمعالج الموجّه
 */
async function executeVanMovement(req: AuthRequest, res: VanReply, data: LoadBody, opts: VanMovementOptions = {}): Promise<void> {
  try {
    const tid = tenantId(req);
    // «ربط الدفاتر» L1: سبب التسوية يُحكم عليه قبل أي قراءة — الواجهة بسببٍ مجهول 400 بلا عمل، ومفتاح API تحذيرٌ يُضمّ لردّ النجاح
    const reasonWarnings: StockWarning[] = [];
    const adjustReason = data.type === 'ADJUST' ? resolveAdjustReason(data.reason, VAN_ADJUST_REASONS, !!req.user?.apiKeyId, reasonWarnings) : null;
    // «تتبّع اللوط» D30: سيارة مندوبٍ محذوف مفتاحها معرّفه المحفوظ — لا مندوب يُحلّ ولا نطاق (إداري غير مقيّد وحده)
    const gone = data.deletedSalesRepId !== undefined ? await deletedVanOf(req, tid, data) : null;
    const { salesRepId, isRep } = gone ? { salesRepId: gone.vanKey, isRep: false } : opts.asAdmin ? { salesRepId: opts.asAdmin.salesRepId, isRep: false } : resolveRep(req, data.salesRepId);

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

    // D8: مرجعٌ سبق حفظه ⇒ الحركة القائمة 200 بشكل ردّ الإنشاء (و replay: true) بلا أي كتابة ولا حكمٍ جديد على أصنافها — بعد النطاق
    // (السيارة في نطاق المستخدم، وحركة المرجع لها نفسها) لا قبله. ومرجعٌ لحركةٍ أخرى (سيارة أو نوع آخر) ⇒ 409 CLIENT_REF_REUSED.
    // والطلبان المتزامنان بالمرجع نفسه يحسمهما القفل في المعاملة (refGate)
    const clientRef = data.clientRef ?? null;
    const priorInclude = { items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(lotsOn && { lots: ITEM_LOTS_INCLUDE }) } } };
    const priorOf = async (db: Prisma.TransactionClient | typeof prisma) => {
      if (!clientRef) return null;
      const prior = await db.vanLoad.findFirst({ where: { tenantId: tid, clientRef }, orderBy: { createdAt: 'asc' }, include: priorInclude });
      if (prior && (vanKeyOf(prior) !== salesRepId || prior.type !== data.type)) {
        throw Object.assign(new Error('مرجع الحفظ clientRef مستعملٌ لحركةٍ أخرى — ولّد مرجعاً جديداً لكل حفظ'), { status: 409, code: 'CLIENT_REF_REUSED' });
      }
      return prior;
    };
    const prior0 = await priorOf(prisma);
    if (prior0) { res.status(200).json({ success: true, data: prior0, replay: true, idempotent: true }); return; }
    /** أول ما في كل معاملة كتابة: قفل المرجع ثم البحث به — وُجد ⇒ تُجهَض المعاملة بلا كتابة ويُردّ القائم (ClientRefReplay) */
    const refGate = async (tx: Prisma.TransactionClient) => {
      // «قبول المندوب للتحميل»: قفل صفّ المعلّق وحالته قبل كل شيء — غائبٌ ⇒ كما كان
      if (opts.gate) await opts.gate(tx);
      if (!clientRef) return;
      await lockClientRef(tx, 'van-load', tid, clientRef);
      const prior = await priorOf(tx);
      if (prior) throw new ClientRefReplay(prior);
    };

    // البنود غير الصفرية وكلٌّ بموضعه `at` في طلب العميل: به تُعرَّف أسطر خطة اللوط، فيشير تحذيرها وخطؤها ({idx}، §٢.٦) إلى
    // السطر الذي أرسله لا إلى موضعه بعد ترشيح الأصفار. وما سواها (units وترتيب البنود) بموضع البند في `items` كما كان
    const nonZero = data.items.map((i, at) => ({ ...i, at })).filter(i => i.qty !== 0);
    // «الربط لا يُرفض» (أمر المالك ٩ نوفمبر ٢٠٢٦، services/stockLenient.ts): كل الأسطر صفرية ⇒ 200 بلا حركة وتحذير NO_QUANTITIES
    // (كان 400 «لا توجد كميات صالحة»). وما تُرك أو عُدِّل بعدها تحذيرٌ في ردّ النجاح (warnings) بموضع سطره i.at
    if (!nonZero.length) { res.status(200).json(stockNoopBody([noQuantitiesWarning()])); return; }
    const replay = String(req.headers['x-fs-replay'] || '') === '1';
    // الأصناف نفسها بدل العدّ (استعلامٌ واحد كما كان): «الوحدة الرئيسية» §3 تحتاج أساسها وتاريخ تحويلها ووحداتها في الميزتين،
    // و«تتبّع اللوط» علمها واسمها وصلاحيتها (lotProducts) والميزة مفعّلة وحدها. تُقرأ **قبل** حلّ وحدات البنود: فتحويلٌ يلتزم بين
    // القراءتين يجعل الأساس المتوقَّع أقدم من الوحدات المحلولة فيرفضه القفل (409)؛ ولو قُرئت بعدها لرأت الأساس الجديد ومرّ القفل
    // ببندٍ حُلّ معامله على الأساس القديم (طبلية ×50 كرتوناً تُكتب ×50 قارورة). ومعها الأرشفة والرمز (توأم المؤرشف الحيّ)
    const found = await prisma.product.findMany({
      where: { id: { in: [...new Set(nonZero.map(i => i.productId))] }, tenantId: tid },
      select: VAN_LINE_PRODUCT_SELECT,
    });
    // #23 وH2 (مراجعة المخزون) صارا بلا رفض — وجود الأصناف **قبل** حلّ وحداتها: صنفٌ لا يتبع الشركة ⇒ صنفٌ مؤقّت بمعرّفه نفسه
    // (PRODUCT_PLACEHOLDER_CREATED، كان 400) ما لم يكن المعرّف لشركةٍ أخرى (يُترك سطره PRODUCT_NOT_FOUND)، و**التحميل** لصنفٍ مؤرشف ⇒
    // صنفٌ حيّ واحد بالرمز نفسه (PRODUCT_REDIRECTED) وإلا يُقبل على المؤرشف (PRODUCT_ARCHIVED، كان 422 — ورصيد المستودع يحكم عليه كأي
    // تحميل). والتنزيل والتسوية والإزالة تمرّ عليه كما كانت. ثم لقطة وحدة كل بند يحلّها الخادم: الموقوفة بمعاملها (وإعادة الرفع كما
    // كانت)، والغريبة أساساً بلا خطر تحويل وإلا يُترك سطرها (UNIT_INVALID) — units[idx] لـitems[idx]
    const lenient = await lenientStockLines(tid, nonZero, found, {
      archived: data.type === 'LOAD' ? 'LOAD' : null, select: VAN_LINE_PRODUCT_SELECT, replay,
      isApiKey: !!req.user?.apiKeyId, lotsOn, carriesLot: vanLineCarriesLot,
      stripLot: (i) => ({ ...i, lots: undefined, lotNumber: undefined, productionDate: undefined, expiryDate: undefined, lotReason: undefined, lotId: undefined }),
    });
    const { lines: items, units, products, warnings } = lenient;
    // مفتاح الربط: سطرٌ بكمية صفر بين أسطرٍ أخرى كان يُترك بصمت — تحذيرٌ بموضعه يدلّ على mode COUNT (الصفر هناك ذو معنى)
    warnings.push(...reasonWarnings, ...(req.user?.apiKeyId ? zeroQtyIgnoredWarnings(data.items) : []));
    // لم يبقَ سطرٌ يُكتب ⇒ 200 بلا حركة بتحذيراته (لا مرجع يُحفظ: إعادته تعيد الردّ نفسه)
    if (!items.length) { res.status(200).json(stockNoopBody(warnings)); return; }
    const productIds = [...new Set(items.map(i => i.productId))];

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
      // مفتاح الربط (١٦ نوفمبر ٢٠٢٦): الصنف المتتبَّع يحصره رصيد تشغيلاته في الخطة (LOT_CLAMPED) لا رفض المستند — فلا يُفحص هنا
      const lotClamped = (pid: string) => !!req.user?.apiKeyId && preTracked.has(pid);
      items.forEach((i, idx) => { if (!lotClamped(i.productId)) want.set(i.productId, (want.get(i.productId) ?? 0) + toBase(i.qty, { unitFactor: units[idx].factor })); });
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

    const lotProducts = lotsOn ? products : null;
    const productById = new Map(products.map(p => [p.id, p]));
    // «الوحدة الرئيسية» §3: الأساس الذي حُلّت عليه البنود. مفتاح API على صنفٍ حُوِّل بلا baseUnitName ⇒ 400 (D19)، ثم المقارنة
    // الحيّة بما يعرفه العميل ⇒ 400 UNIT_INVALID — والسباق بعدها يحرسه القفل في المعاملة. وفي إعادة الرفع لا 4xx (المستند سُجّل
    // على الجهاز ولا يُعدم): أساسٌ مُرسَل يخالف أساس الصنف ⇒ 503 PRODUCT_UNITS_CHANGED كالسباق، لا كتابةٌ صامتة بأساسٍ يعرف الخادم
    // أنه غير أساس العميل (كمية كرتونٍ تُكتب قوارير). باقٍ بلا تساهل مع «الربط لا يُرفض»: يمنع خطأ الكمية الصامت (replay أعلاه)
    const expected = expectedBasesOf(products);
    const noBase = missingBaseForApi(!!req.user?.apiKeyId, items, productById);
    if (noBase) { const r = baseUnitRequiredReply(noBase); res.status(r.status).json(r.body); return; }
    const bad = staleClientBase(items, expected, new Map(products.map((p) => [p.id, p.baseConvertedAt])));
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
      // مفتاح الربط (١٦ نوفمبر ٢٠٢٦): تشغيلةٌ لصنفٍ غير متتبَّع تُهمل بتحذير LOT_IGNORED ويتحرّك الصنف كما هو — لا رفض المستند كله
      if (req.user?.apiKeyId) {
        items.forEach((i, k) => {
          if (preTracked.has(i.productId) || !(vanLineCarriesLot(i) || (i.lotId != null && i.lotId !== ''))) return;
          warnings.push(lotIgnoredWarning(i.at, i.productId, lotProducts.find(p => p.id === i.productId)?.name ?? ''));
          items[k] = { ...i, lots: undefined, lotNumber: undefined, productionDate: undefined, expiryDate: undefined, lotReason: undefined, lotId: undefined };
        });
      }
      const stray = items.find(i => !preTracked.has(i.productId) && vanLineCarriesLot(i));
      if (stray) throw lotOnUntrackedError(lotProducts.find(p => p.id === stray.productId)?.name ?? '', stray.productId, stray.at);
    }
    // مراجعة المخزون S5 وقرار المالك D2 («التحميل فوق رصيد المستودع يمنع»): المستودع مفعّل ⇒ تحميلٌ يتجاوز رصيد صنفٍ في المستودع
    // (بالأساس، وأسطر الصنف الواحد مجموعة) 422 WAREHOUSE_INSUFFICIENT بلا كتابة — لكل مُصدِر. الحكم داخل المعاملة بعد أقفال الأصناف
    // وتحت قفل المستودع للشركة (whGate)، فلا يمرّ تحميلان متزامنان فوق الرصيد. التنزيل والتسوية والإزالة والشركة بلا مستودع كما كانت
    const whGuard = data.type === 'LOAD' && !gone && rep?.tenant?.warehouseEnabled === true;
    const whLines = whGuard ? items.map((i, n) => ({ productId: i.productId, baseQty: unitFields(i.qty, units[n]).baseQty, at: i.at })) : [];
    const whGate = async (tx: Prisma.TransactionClient) => { if (whGuard) await assertWarehouseCovers(tx, tid, whLines, productById); };
    // D10: حركةٌ تُنقص المتاح في سيارة مندوبٍ قائم (تنزيلٌ موجب، أو تحميلٌ/تسويةٌ بسطرٍ سالب) تأخذ قفل `van-sellable:` نفسه
    // (services/repSaleStock VAN_SELLABLE_LOCK_PREFIX) بعد أقفال الأصناف — فتتسلسل مع حارس إلغاء المرتجع والبيع فلا يقرآن رصيداً
    // تُنقصه هي في اللحظة نفسها. الترتيب الكلّي في VAN_LOCK_ORDER. وإزالة المنتهي/التالف لا تمسّ المتاح
    const sellOut = !outBucket && !gone && items.some(i => (data.type === 'UNLOAD' ? i.qty > 0 : i.qty < 0));
    const sellGate = async (tx: Prisma.TransactionClient) => {
      if (sellOut) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'van-sellable:' + salesRepId}))`;
    };

    // نداء الإنشاء الوحيد (locations.test.ts): الحركة وبنودها — وتوزيع البند على التشغيلات حين تحمل الخطة صفوفه (D2: البند لا يُشطر).
    // «قبول المندوب للتحميل»: beforeCreate يرى كل التحذيرات قبله (تجربة الإرسال تُجهض هنا، والقبول يرفض ما يغيّر الأسطر)، وafterCreate
    // يختم الصفّ المعلّق في المعاملة نفسها — غائبان ⇒ الإنشاء كما كان
    const createLoad = async (db: Prisma.TransactionClient | typeof prisma, plan: VanMovementPlanResult | null = null) => {
      opts.beforeCreate?.([...warnings, ...(plan?.warnings ?? [])]);
      const load = await db.vanLoad.create({
        data: {
          tenantId: tid, salesRepId: gone ? null : salesRepId, type: data.type, note: data.note,
          // سبب التسوية بالنشر الشرطيّ — غائبٌ ⇒ العمود null والحركة كما كانت حرفياً
          ...(adjustReason && { reason: adjustReason }),
          // D30: تنزيل سيارة مندوبٍ محذوف بمعرّفه المحفوظ، كما يكتبه حذف المندوب على حركاته
          ...(gone && { deletedSalesRepId: gone.vanKey }),
          ...(loadLocationId && { locationId: loadLocationId }),
          // D8: مرجع منع التكرار بالنشر الشرطيّ — غائبٌ ⇒ العمود null كما كان
          ...(clientRef && { clientRef }),
          // «قبول المندوب للتحميل»: لحظة القبول ومعرّف صفّ الإقرار الموقَّع — غائبان ⇒ العمودان null كما كانا
          ...(opts.stamp && { acceptedAt: opts.stamp.acceptedAt, pendingLoadId: opts.stamp.pendingLoadId }),
          createdBy: isRep ? 'REP' : 'ADMIN',
          // لقطة الوحدة + الكمية بالأساس؛ والمقترَح والمتنبَّأ به بالأساس كما أخرجهما المحرّك
          items: {
            // مفتاح الربط: سطرٌ حصرته خطة اللوط (LOT_CLAMPED) أو قرّبت كسره يُكتب بكميته المطبَّقة (vanAppliedItemFields بعد unitFields
            // فتغلبها)، والمحصور إلى صفر لا يُكتب. غير المفتاح: applied فارغة فالبنود كما كانت حرفياً
            create: items.flatMap((i, idx) => (Math.abs(plan?.applied?.get(i.at) ?? 1) <= 1e-9 ? [] : [{
              productId: i.productId, ...unitFields(i.qty, units[idx]), ...vanAppliedItemFields(plan, i.at, units[idx]), suggestedQty: i.suggestedQty ?? null, expectedQty: i.expectedQty ?? null,
              // «مرجع السطر» بالنشر الشرطيّ: غائبٌ أو فارغٌ بعد القصّ ⇒ لا مفتاح فيبقى العمود null والبند كما كان حرفياً. في كل الأنواع
              // ومنها تنزيل سيارة المندوب المحذوف (D30)، وتوزيع البند على تشغيلاته لا يشطره (D2) فالمرجع على البند الواحد
              ...(i.lineRef && { lineRef: i.lineRef }),
              ...(plan && vanItemLotColumns(plan, i.at, { tenantId: tid, productId: i.productId, vanKey: salesRepId, moveType: data.type })),
            }])),
          },
        },
        include: { items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(plan && { lots: ITEM_LOTS_INCLUDE }) } } },
      });
      if (opts.afterCreate) await opts.afterCreate(db as Prisma.TransactionClient, load);
      return load;
    };

    // «تتبّع اللوط» (§٤.٧): في الحركة صنفٌ متتبَّع — يوم الشركة قبل المعاملة، ثم الطابور، ثم معاملةٌ بمهلة اللوط (D13) فيها
    // بالترتيب: قفل الدلو للإزالة، ثم قفل الأصناف (lockLotProducts)، ثم فحص رصيد الإزالة القائم، ثم خطة التوزيع التي تمنع
    // السالب على مستوى اللوط (planVanMovementInTx)، ثم نداء الإنشاء الوحيد. وبلا صنفٍ متتبَّع: المسار القائم أدناه حرفياً
    if (preTracked.size) {
      const byId = new Map((lotProducts ?? []).map(p => [p.id, p]));
      // قبول المعلّق: المرسِل فاعل الحركة وسجل اللوط لا المندوب
      const by = opts.asAdmin?.actorId ?? actorOf(req);
      const { day } = await companyDay(prisma, tid);
      const release = await acquireLotQueue(tid, preTracked);
      try {
        const out = await prisma.$transaction(async (tx) => {
          await refGate(tx); // D8: المرجع أولاً — مكرَّرٌ ⇒ لا قفل لوط ولا خطة
          if (outBucket) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`van-${outBucket}:` + salesRepId}))`;
          const locked = await lockLotProducts(tx, tid, productIds);
          // §3: الأساس تحت قفل lockLotProducts نفسه (صفوفه تحمل unit) — بلا قفلٍ ثانٍ، وقبل أي رصيد أو خطة أو كتابة
          assertBasesUnchanged(expected, locked.units);
          await sellGate(tx);
          if (outBucket) await assertOutAvailable(outBucket); // رصيد الدلو للصنف كما كان، ثم اللوط في الخطة
          // D2: رصيد المستودع تحت قفله بعد أقفال الأصناف (فلا يمسك قفلَ الشركة منتظراً صنفاً)، ثم خطة التشغيلات
          await whGate(tx);
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
                lotsRaw: { lots: i.lots, lotNumber: i.lotNumber, productionDate: i.productionDate, expiryDate: i.expiryDate, ...(req.user?.apiKeyId && { lotId: i.lotId }) },
                reason: i.lotReason == null ? null : String(i.lotReason),
              };
            }),
          }, { locked, eventActor: opts.asAdmin?.eventActor ?? lotEventActorOf(req.user), lenient: !!req.user?.apiKeyId });
          // مفتاح الربط: كل الأسطر حُصرت إلى صفر (لا شيء في السيارة يُنقص) ⇒ 200 بلا حركة بتحذيراتها، لا حركةٌ بلا بنود
          if (vanPlanWritesNothing(plan, items.map(i => i.at))) throw new VanPlanNoop([...warnings, ...plan.warnings]);
          return { load: await createLoad(tx, plan), warnings: plan.warnings };
        }, { maxWait: 10_000, timeout: 20_000 });
        // تحذيرات «الربط لا يُرفض» ثم تحذيرات اللوط — بلا الأولى كما كان حرفياً
        res.status(201).json({ success: true, data: out.load, warnings: [...warnings, ...out.warnings] });
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
        await refGate(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`van-${outBucket}:` + salesRepId}))`;
        await lockBases(tx, tid, expected);
        if (lotsOn) await assertStillUntracked(tx, tid, productIds);
        await assertOutAvailable(outBucket); // يقرأ الملتزَم: الإزالة السابقة التزمت قبل أن يُفكّ قفلها
        return createLoad(tx);
      }, BASE_GUARD_TX).catch(busy)
      : lotsOn
        ? await prisma.$transaction(async (tx) => {
          await refGate(tx);
          await lockBases(tx, tid, expected);
          await assertStillUntracked(tx, tid, productIds);
          await sellGate(tx);
          await whGate(tx);
          return createLoad(tx);
        }, BASE_GUARD_TX).catch(busy)
        : await prisma.$transaction(async (tx) => {
          await refGate(tx);
          await lockBases(tx, tid, expected);
          await sellGate(tx);
          await whGate(tx);
          return createLoad(tx);
        }, BASE_GUARD_TX);
    // «الربط لا يُرفض»: التحذيرات حين وُجدت وحدها — وإلا الردّ كما كان حرفياً
    res.status(201).json({ success: true, data: load, ...(warnings.length > 0 && { warnings }) });
  } catch (err) {
    // §3: تبدّل الأساس أثناء الحفظ ⇒ PRODUCT_UNITS_CHANGED، 409 حيّاً و503 لإعادة الرفع (الصندوق يعيد ولا يُعدم المستند)؛ وانتظار
    // قفل الأصناف (lockBases يحوّله ProductUnitsBusyError) ⇒ 503 PRODUCT_UNITS_BUSY. صنفا خطأ الحارس وحدهما (كـcustomers.ts): مهلة
    // معاملةٍ أو تعطّلٌ متبادل أو انتظار قفل الدلو ليست «وحدات الأصناف قيد التحديث» — تمرّ إلى المعالج العام كما كانت قبل الميزة.
    // LotError (ومنه LOT_BUSY) يمرّ إلى معالج الموجّه كما كان
    const g = err instanceof ProductUnitsChangedError || err instanceof ProductUnitsBusyError
      ? baseGuardReply(err, String(req.headers['x-fs-replay'] || '') === '1') : null;
    if (g) { res.status(g.status).json(g.body); return; }
    // مفتاح الربط: كل أسطر الحركة حُصرت إلى صفر في خطة اللوط ⇒ 200 noop بتحذيراتها (LOT_CLAMPED) — لا مرجع يُحفظ
    if (err instanceof VanPlanNoop) { res.status(200).json(stockNoopBody(err.warnings as StockWarning[])); return; }
    // D2: التحميل فوق رصيد المستودع ⇒ 422 بأسطره (index وproductId وavailableBase وrequestedBase) بلا كتابة
    if (err instanceof WarehouseInsufficientError) { res.status(422).json(err.body()); return; }
    // D8: طلبٌ مكرَّر تزامن مع أصله فوجده القفل ⇒ الحركة القائمة كما في المسار السريع
    if (err instanceof ClientRefReplay) { res.status(200).json({ success: true, data: err.row, replay: true, idempotent: true }); return; }
    if ((err as { code?: unknown })?.code === 'CLIENT_REF_REUSED') { res.status(409).json({ success: false, code: 'CLIENT_REF_REUSED', message: (err as Error).message }); return; }
    // «ربط الدفاتر» L1: سبب تسويةٍ غير معروف من الواجهة ⇒ 400 ADJUST_REASON_INVALID بلا حركة
    if (isSupplierError(err)) { res.status(err.status).json(supplierErrorBody(err)); return; }
    throw err;
  }
}

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
        // والمؤرشف خارجه (D3): تحميله يُرفض 422 PRODUCT_ARCHIVED فلا يُقترح — ولو أُعيد ACTIVE بعد أرشفته
        where: { tenantId: tid, status: { not: 'INACTIVE' }, deletedAt: null },
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
    // #14: حدود الأيام بتوقيت الشركة كسجلّ التحميلات في الصفحة نفسها (GET /loads: paymentMethodsRange) — كانت منتصف ليل UTC ونهاية
    // اليوم بساعة الخادم، فتحميل الواحدة والنصف فجراً بالرياض يسقط من يومه ويدخل اليوم السابق. التاريخ YYYY-MM-DD وحده؛ وغيره كما كان
    const tz = (from && isLocalDate(from)) || (to && isLocalDate(to)) ? await tenantTz(tid) : null;
    const fromAt = tz && from && isLocalDate(from) ? zonedStartOfDay(from, tz) : undefined;
    const toBefore = tz && to && isLocalDate(to) ? zonedStartOfDay(addDays(to, 1), tz) : undefined;
    const range = from || to ? { from, to, ...(fromAt && { fromAt }), ...(toBefore && { toBefore }) } : undefined;
    const lastLoadBefore = to && !toBefore ? new Date(new Date(to).setHours(23, 59, 59, 999)) : undefined;

    const repFilter = await adminRepFilter(req);
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, ...repFilter }, select: { id: true, name: true, isActive: true, canSellWithoutStock: true } });
    // عهدة الأدوات: رصيد اللحظة (لا تتبع المدّة — عهدةٌ قائمة لا تدفّق)، باستعلامٍ مجمَّع واحد للشركة
    const toolGroups = await prisma.vanToolMove.groupBy({
      by: ['salesRepId', 'type'], where: { tenantId: tid, salesRepId: { in: reps.map(r => r.id) } }, _sum: { qty: true },
    });
    const toolsByRep = toolCountsByRep(toolGroups);
    const rowsByRep = new Map<string, StockRow[]>();
    const data = await Promise.all(reps.map(async r => {
      const rows = await computeStock(tid, r.id, range);
      rowsByRep.set(r.id, rows);
      const lastLoad = await prisma.vanLoad.findFirst({
        // «آخر تحميل» يلتزم نهاية المدّة أيضاً، وإلا عرض الجدولُ تاريخاً خارجها
        where: {
          tenantId: tid, salesRepId: r.id, type: 'LOAD',
          ...(toBefore ? { createdAt: { lt: toBefore } } : lastLoadBefore && { createdAt: { lte: lastLoadBefore } }),
        },
        orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      });
      // المجاميع عبر الأصناف بوحدات الأساس (حبّات لا كراتين) — computeStock بالأساس، فلصنفٍ بلا وحدات لا يتغيّر شيء
      return {
        salesRepId: r.id, repName: r.name, isActive: r.isActive, canSellWithoutStock: r.canSellWithoutStock,
        // productCount بمعناه المنشور (كل صنفٍ متبقّيه غير صفري، موجباً أو سالباً) — والإضافة onVanCount «أصناف بالسيارة» ما فيها
        // فعلاً (#10): العجز (رصيدٌ سالب من بيعٍ بلا مخزون) ليس صنفاً في السيارة، يُعدّ في deficitCount
        productCount: rows.filter(x => Math.abs(x.remaining) > 1e-9).length,
        onVanCount: rows.filter(x => x.remaining > 1e-9).length,
        // المتبقّي صافياً بإشارته كما كان، والعجز والمنتهي يُعرضان بجانبه إضافةً (totalDeficit وdeficitCount وtotalExpired)
        totalRemaining: roundDecimal(rows.reduce((s, x) => s + x.remaining, 0), 4),
        totalDeficit: roundDecimal(rows.reduce((s, x) => s + Math.max(0, -x.remaining), 0), 4),
        deficitCount: rows.filter(x => x.remaining < -1e-9).length,
        // «منتهي الصلاحية» في السيارة لا يُباع — الموجب وحده كالتالف أدناه
        totalExpired: roundDecimal(rows.reduce((s, x) => s + Math.max(0, x.expired), 0), 4),
        totalLoaded: roundDecimal(rows.reduce((s, x) => s + x.loaded, 0), 4),
        totalSold: roundDecimal(rows.reduce((s, x) => s + x.sold, 0), 4),
        // «المرتجع التالف»: رصيدٌ حتى نهاية المدّة كالمتبقّي، لا يُباع
        // الموجب وحده: رصيدٌ سالب لصنف (إلغاء مرتجعٍ بعد إزالة بضاعته) لا يُخفي تالفاً حقيقياً لصنفٍ آخر في المجموع
        totalDamaged: roundDecimal(rows.reduce((s, x) => s + Math.max(0, x.damaged), 0), 4),
        toolsCount: toolsByRep.get(r.id) ?? 0,
        lastLoadAt: lastLoad?.createdAt || null,
      };
    }));
    // «عرض الكميات بالوحدة الكبرى» (طلب المالك ٤ نوفمبر ٢٠٢٦): الأعمدة الأربعة نفسها لكل صنفٍ بوحدته الكبرى في `major` — إضافةٌ،
    // والمجاميع بالأساس أعلاه كما هي حرفياً. الوحدات باستعلامٍ واحد لكل المناديب لا داخل computeStock (مستدعوه الآخرون لا يحتاجونها)
    const units = await unitsByProduct(tid, [...rowsByRep.values()].flatMap(rs => rs.map(x => x.productId)));
    const withMajor = data.map(d => ({ ...d, major: repStockMajor(rowsByRep.get(d.salesRepId) ?? [], units) }));
    // D9: عهد أدوات المناديب المحذوفين القائمة — صفوف «مندوب محذوف» بجانب الجدول (إضافةٌ؛ data كما هي). لغير المقيَّد وحده كبطاقة
    // سيارات المحذوفين: المقيَّد لا يُعرف نطاقه في مندوبٍ لم يعد موجوداً، فيعود له [] بلا استعلام
    const deletedTools = Object.keys(repFilter).length ? [] : await deletedToolHolders(tid);
    // `filtered` تُخبر الواجهة أن «محمَّل/مباع» صارا تدفّقَي مدّة لا إجماليين
    res.json({ success: true, data: withMajor, filtered: !!range, from: from || null, to: to || null, deletedTools });
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
    // D8: ?clientRef= — هل حُفظت محاولةٌ بمرجعها قبل إعادة الإرسال؟ نصٌّ صالح وحده، وغيره يُهمل
    const clientRef = clientRefQuery(req.query.clientRef);
    const where = {
      tenantId: tid,
      ...(salesRepId && { salesRepId }),
      ...locationDocWhere(location),
      ...(type && { type }),
      ...(createdAt && { createdAt }),
      ...(clientRef && { clientRef }),
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
          // البند بكل أعمدته — ومنها «مرجع السطر» lineRef كما حُفظ (null لما لم يُرسَل)، كردّ الإنشاء
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
      // «تصفير المخزون»: zeroRunId صريحٌ لكل حركة (null لغير التصفير) — الواجهة توسم حركة التصفير بالوسم لا بنصّ الملاحظة
      data: loads.map(l => ({ ...l, zeroRunId: l.zeroRunId ?? null, salesRep: l.salesRep ?? { id: null, name: REP_GONE_NAME }, location: l.location ?? null })),
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
    // و«مرجع السطر» (lineRef) كذلك: حاضرٌ دائماً بقيمته المحفوظة على البند (حركةً وفاتورة) و null لما لم يُرسَل —
    // إلا بند فاتورةٍ خارج النطاق: null كرقمها وعميلها (مرجع المُدمِج مثل «SO-…/CUST-…» يعرّف المستند)
    const primaryOf = (p: { primaryUnitId?: string | null } | null | undefined) => ({ primaryUnitId: p?.primaryUnitId || null });
    const movements = [
      ...loads.map(l => ({
        // «تصفير المخزون»: معرّف التشغيلة لحركة التصفير (null لغيرها؛ والفواتير أدناه null دائماً)
        kind: l.type, date: l.createdAt, ref: l.note || '', by: l.createdBy, zeroRunId: l.zeroRunId ?? null,
        // «قبول المندوب للتحميل»: التحميل الذي قبله المندوب ووقّعه بمعرّف إقراره ولحظته — وغيره كما كان حرفاً
        ...(l.pendingLoadId && { pendingLoadId: l.pendingLoadId, acceptedAt: l.acceptedAt }),
        // «ربط الدفاتر» L1: سبب التسوية (COUNT | DAMAGE | EXPIRY | SHORTAGE_REP | SAMPLE | OTHER) حين سُجّل وحده — والحركة بلا سبب كما كانت حرفاً
        ...(l.reason != null && { reason: l.reason }),
        items: l.items.map(i => ({ name: i.product.name, unit: i.unitName ?? i.product.unit, qty: i.qty, baseQty: baseQtyOf(i), ...primaryOf(i.product), lineRef: i.lineRef ?? null, ...(withLots && { lots: (i as { lots?: unknown }).lots ?? [] }) })),
      })),
      ...invoices.map(inv => ({
        // المرتجع التالف (منذ DAMAGED_VAN_SINCE) يدخل رصيد «المرتجع التالف» لا المتاح — فيُوسم بذلك في الحركة
        kind: inv.type === 'RETURN' ? (isDamagedVanReturn(inv) ? 'RETURN_DAMAGED' : 'RETURN') : 'SALE', date: inv.invoiceDate,
        ref: !visible || visible.has(inv.id) ? `${inv.number} · ${inv.customer.name}` : 'مستند خارج نطاقك', by: 'REP', zeroRunId: null,
        items: inv.items.map(i => ({ name: i.product?.name ?? i.itemName ?? 'صنف محذوف', unit: i.unitName ?? i.product?.unit ?? '', qty: i.qty, baseQty: baseQtyOf(i), ...primaryOf(i.product), lineRef: !visible || visible.has(inv.id) ? (i.lineRef ?? null) : null, ...(withLots && { lots: (i as { lots?: unknown }).lots ?? [] }) })),
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

/**
 * عهدة مندوبٍ محذوف (مراجعة المخزون D9): حذف المندوب يُبقي حركات أدواته بمعرّفه في deletedSalesRepId (salesReps.ts) فتبقى ظاهرة
 * «مندوب محذوف». لإداري غير مقيَّد بنطاق وحده (المقيَّد لا يُعرف نطاقه في مندوبٍ لم يعد موجوداً — كبطاقة سيارات المحذوفين)، والمعرّف
 * لمندوبٍ محذوفٍ فعلاً له أثر عهدة. وإلا 404 كمندوبٍ غير موجود
 */
async function deletedToolHolderOf(req: AuthRequest, tid: string, key: string): Promise<string> {
  const gone = () => Object.assign(new Error('المندوب غير موجود'), { status: 404 });
  if (req.user?.role === 'SALES_REP' || !key || (await adminScopeEnabled(req))) throw gone();
  const live = await prisma.salesRep.findFirst({ where: { id: key, tenantId: tid }, select: { id: true } });
  const past = live ? null : await prisma.vanToolMove.findFirst({ where: { tenantId: tid, salesRepId: null, deletedSalesRepId: key }, select: { id: true } });
  if (live || !past) throw gone();
  return key;
}

/** عهد المناديب المحذوفين القائمة (رصيدٌ موجب) — لبطاقة ملخّص المناديب: صفٌّ «مندوب محذوف» لكل حامل باستعلامٍ واحد للشركة */
export async function deletedToolHolders(tid: string): Promise<{ deletedSalesRepId: string; repName: string; toolsCount: number; balances: { toolName: string; qty: number }[] }[]> {
  const moves = await prisma.vanToolMove.findMany({
    where: { tenantId: tid, salesRepId: null, deletedSalesRepId: { not: null } }, orderBy: { createdAt: 'asc' },
    select: { deletedSalesRepId: true, toolName: true, qty: true, type: true },
  });
  const byKey = new Map<string, { toolName: string; qty: number; type: string }[]>();
  for (const m of moves) {
    if (!m.deletedSalesRepId) continue;
    const list = byKey.get(m.deletedSalesRepId) ?? [];
    list.push(m);
    byKey.set(m.deletedSalesRepId, list);
  }
  return [...byKey].map(([deletedSalesRepId, ms]) => {
    const balances = foldTools(ms).filter(b => b.qty > 0);
    return { deletedSalesRepId, repName: REP_GONE_NAME, toolsCount: balances.reduce((s, b) => s + b.qty, 0), balances };
  }).filter(h => h.toolsCount > 0);
}

const toolMoveSchema = z.object({
  // أحدهما: مندوبٌ قائم، أو مندوبٌ محذوف (D9) تُستلم أدواته (RETURN وحده)
  salesRepId: z.string().min(1).optional(),
  deletedSalesRepId: z.string().min(1).optional(),
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
    // D9: ?deletedSalesRepId= عهدة مندوبٍ محذوف بالشكل نفسه (إداري غير مقيَّد) — مكان salesRepId
    const goneQ = !isRep && typeof req.query.deletedSalesRepId === 'string' && req.query.deletedSalesRepId ? req.query.deletedSalesRepId : null;
    const goneKey = goneQ ? await deletedToolHolderOf(req, tid, goneQ) : null;
    const salesRepId = isRep ? req.user!.id : goneKey ? null : queryRepId(req);
    if (!salesRepId && !goneKey) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    if (salesRepId) await assertRepInScope(req, tid, salesRepId);
    const holder = goneKey ? { salesRepId: null, deletedSalesRepId: goneKey } : { salesRepId };
    const [moves, names] = await Promise.all([
      prisma.vanToolMove.findMany({
        where: { tenantId: tid, ...holder }, orderBy: { createdAt: 'asc' },
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
    if (!data.salesRepId === !data.deletedSalesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    // D9: مندوبٌ محذوف ⇒ الاستلام وحده (تُستردّ عهدته، ولا تسليم لمن لم يعد موجوداً)
    if (data.deletedSalesRepId && data.type !== 'RETURN') { res.status(400).json({ success: false, message: 'المندوب المحذوف تُستلم منه أدواته فقط' }); return; }
    const goneKey = data.deletedSalesRepId ? await deletedToolHolderOf(req, tid, data.deletedSalesRepId) : null;
    if (data.salesRepId) {
      await assertRepInScope(req, tid, data.salesRepId);
      const rep = await prisma.salesRep.findFirst({ where: { id: data.salesRepId, tenantId: tid }, select: { id: true } });
      if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    }
    // حامل العهدة: المندوب، أو معرّف المحذوف بمرجعٍ مفرَّغ كما كتبه حذفه
    const holder = goneKey ? { salesRepId: null, deletedSalesRepId: goneKey } : { salesRepId: data.salesRepId! };
    const lockKey = goneKey ?? data.salesRepId!;
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
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'van-tools:' + lockKey}))`;
      if (data.type === 'RETURN') {
        const have = new Map(foldTools(await tx.vanToolMove.findMany({
          where: { tenantId: tid, ...holder }, orderBy: { createdAt: 'asc' },
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
          tenantId: tid, ...holder, type: data.type, toolName: w.toolName, qty: w.qty,
          // جلسة المالك تُسجَّل OWNER:<المعرّف> و«الدعم الفني» لا باسم مدير الشركة (actorOf)
          note: data.note || null, createdById: actor, createdByName: actor.startsWith('OWNER:') ? 'الدعم الفني' : (req.user?.name ?? null),
        })),
      });
      return want.size;
    });
    res.status(201).json({ success: true, data: { count: created } });
  } catch (err) { next(err); }
});

// ═══ الجرد المطلق وتصفير السيارة (طلب المالك ١٦ نوفمبر ٢٠٢٦: «تصفير مخزون السيارة في Odoo يبقى في فيلد كمية LOT») ═══

type VanLoadItemBody = z.infer<typeof loadSchema>['items'][number];
interface VanCountRequest {
  salesRepId?: string; type: string; deleted: boolean; clientRef: string | null; note: string | null;
  scope: 'LINES' | 'VAN'; includeUnsellable: boolean; items: VanLoadItemBody[]; zero: boolean;
}
/** أنواع الحركات التي يكتبها الجرد — مرجع clientRef لأيٍّ منها في السيارة نفسها إعادةٌ لا «حركةٌ أخرى» */
const COUNT_LOAD_TYPES = ['ADJUST', 'EXPIRED_OUT', 'DAMAGED_OUT'];

/** تشغيلات سطر الجرد المعدودة بالأساس: lots[] بمعرّف فيلد أو برقم التشغيلة، أو رقمٌ مسطَّح للسطر كله — null ⇒ بلا تشغيلات */
function countLotsOf(i: VanLoadItemBody, base: number): VanCountLine['lots'] {
  if (Array.isArray(i.lots)) {
    const rows = i.lots.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)).map((r) => ({
      lotId: typeof r.lotId === 'string' && r.lotId ? r.lotId : null, lotNumber: r.lotNumber,
      qty: Math.max(0, Number(r.qty) || 0),
      productionDate: typeof r.productionDate === 'string' ? r.productionDate : null, expiryDate: typeof r.expiryDate === 'string' ? r.expiryDate : null,
    })).filter((r) => r.lotId || (r.lotNumber != null && r.lotNumber !== ''));
    return rows.length ? rows : null;
  }
  const lotId = typeof i.lotId === 'string' && i.lotId ? i.lotId : null;
  if (!lotId && (i.lotNumber == null || i.lotNumber === '')) return null;
  return [{
    lotId, lotNumber: i.lotNumber, qty: Math.max(0, base),
    productionDate: typeof i.productionDate === 'string' ? i.productionDate : null, expiryDate: typeof i.expiryDate === 'string' ? i.expiryDate : null,
  }];
}

/**
 * الجرد المطلق (POST /loads بـmode COUNT، لمفتاح الربط وحده) وتصفير السيارة (POST /zero، للمفتاح وللإدارة بصلاحية مخزون السيارة).
 * Odoo يرسل الكمية المعدودة لا الفرق: الخادم يحسب الفرق تحت الأقفال (executeVanCountInTx) — حركة ADJUST واحدة بسبب COUNT، والإزالة
 * حين includeUnsellable، وإعادة تسمية التشغيلات — ثم يعيد القراءة ويتحقّق. خطةٌ فارغة ⇒ 200 noop بتحذير COUNT_MATCHES (متكرّرٌ
 * بالبناء)، وclientRef محفوظ ⇒ الحركة القائمة 200 (D8). سيارة مندوبٍ قائم وحده (لا D30)، وبنطاق المستخدم، ولا يصل إليه المندوب.
 */
async function runVanCount(req: AuthRequest, res: Response, q: VanCountRequest): Promise<void> {
  const tid = tenantId(req);
  const isApi = !!req.user?.apiKeyId;
  if (req.user?.role === 'SALES_REP') { res.status(403).json({ success: false, message: 'جرد السيارة وتصفيرها متاحان للإدارة فقط' }); return; }
  if (!q.zero && !isApi) {
    res.status(403).json({ success: false, code: 'COUNT_API_KEY_ONLY', message: 'الجرد بالكمية المعدودة (mode COUNT) لمفتاح الربط — سجّل التسوية بالفرق من الواجهة' });
    return;
  }
  if (!q.zero && q.type !== 'ADJUST') { res.status(400).json({ success: false, code: 'COUNT_TYPE_INVALID', message: 'الجرد بالكمية المعدودة نوعه ADJUST وحده' }); return; }
  if (q.deleted) { res.status(400).json({ success: false, message: 'الجرد لسيارة مندوبٍ قائم — سيارة المندوب المحذوف تُفرَّغ بالتنزيل' }); return; }
  const { salesRepId } = resolveRep(req, q.salesRepId);
  await assertRepInScope(req, tid, salesRepId);
  const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, include: { tenant: { select: { lotTrackingEnabled: true } } } });
  if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
  const lotsOn = rep.tenant?.lotTrackingEnabled === true;
  const include = { items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(lotsOn && { lots: ITEM_LOTS_INCLUDE }) } } };
  const priorOf = async (db: Prisma.TransactionClient | typeof prisma) => {
    if (!q.clientRef) return null;
    const prior = await db.vanLoad.findFirst({ where: { tenantId: tid, clientRef: q.clientRef }, orderBy: { createdAt: 'asc' }, include });
    if (prior && (vanKeyOf(prior) !== salesRepId || !COUNT_LOAD_TYPES.includes(prior.type))) {
      throw Object.assign(new Error('مرجع الحفظ clientRef مستعملٌ لحركةٍ أخرى — ولّد مرجعاً جديداً لكل حفظ'), { status: 409, code: 'CLIENT_REF_REUSED' });
    }
    return prior;
  };
  const replayed = (row: unknown) => res.status(200).json({ success: true, data: { mode: 'COUNT', zero: q.zero, loads: [row] }, replay: true, idempotent: true });
  const prior0 = await priorOf(prisma);
  if (prior0) { replayed(prior0); return; }

  // الأسطر: الصفر ذو معنى هنا (لا ترشيح)، والسالب يُقرأ صفراً بتحذير. وscope VAN أو التصفير: كل صنفٍ له أثرٌ في السيارة غير مذكور ⇒ صفر
  const warnings: StockWarning[] = [];
  const raw = q.items.map((i, at) => {
    if (!(i.qty < 0)) return { ...i, at };
    warnings.push({ code: 'COUNT_NEGATIVE_AS_ZERO', index: at, productId: i.productId, message: `كمية الجرد في السطر ${at + 1} سالبة فقُرئت صفراً` });
    return { ...i, qty: 0, at };
  });
  const scopeIds = q.scope === 'VAN' || q.zero ? (await computeStock(tid, salesRepId)).map((s) => s.productId) : [];
  const lineIds = [...new Set(raw.map((i) => i.productId))];
  const found = await prisma.product.findMany({ where: { id: { in: [...new Set([...lineIds, ...scopeIds])] }, tenantId: tid }, select: VAN_LINE_PRODUCT_SELECT });
  const lenient = await lenientStockLines(tid, raw, found.filter((p) => lineIds.includes(p.id)), {
    archived: null, select: VAN_LINE_PRODUCT_SELECT, replay: false, isApiKey: isApi, lotsOn, carriesLot: vanLineCarriesLot,
    stripLot: (i) => ({ ...i, lots: undefined, lotNumber: undefined, productionDate: undefined, expiryDate: undefined, lotReason: undefined, lotId: undefined }),
  });
  warnings.push(...lenient.warnings);
  const byId = new Map([...found, ...lenient.products].map((p) => [p.id, p]));
  // «الوحدة الرئيسية» §3 كالحركة بالفرق: الأساس الذي حُلّت عليه الأسطر حيّاً ثم تحت القفل
  const expected = expectedBasesOf(lenient.products);
  const noBase = missingBaseForApi(isApi, lenient.lines, byId);
  if (noBase) { const r = baseUnitRequiredReply(noBase); res.status(r.status).json(r.body); return; }
  const stale = staleClientBase(lenient.lines, expected, new Map(lenient.products.map((p) => [p.id, p.baseConvertedAt])));
  if (stale) throw new UnitInvalidError(`تغيّرت وحدات «${stale}» — حدّث قائمة الأصناف ثم أعد الحفظ`);
  const targets = new Map<string, VanCountLine>();
  const lineOf = (pid: string): VanCountLine | null => {
    const p = byId.get(pid);
    if (!p) return null;
    let t = targets.get(pid);
    if (!t) { t = { productId: pid, productName: p.name, shelfLifeOn: shelfLifeOf(p) !== null, qty: 0, lots: null, lineRef: null }; targets.set(pid, t); }
    return t;
  };
  lenient.lines.forEach((i, n) => {
    const t = lineOf(i.productId);
    if (!t) return;
    const base = unitFields(i.qty, lenient.units[n]).baseQty;
    t.qty += base;
    t.lineRef = t.lineRef ?? i.lineRef ?? null;
    const lots = countLotsOf(i, base);
    if (!lots) return;
    // تشغيلاتٌ لصنفٍ غير متتبَّع (أو الميزة مطفأة) تُهمل بتحذير — الصنف يُجرد بكميته
    if (lotsOn && byId.get(i.productId)?.lotTracked === true) t.lots = [...(t.lots ?? []), ...lots];
    else warnings.push(lotIgnoredWarning(i.at, i.productId, t.productName));
  });
  for (const pid of scopeIds) lineOf(pid);
  if (!targets.size) { res.status(200).json(stockNoopBody([...warnings, countMatchesWarning()])); return; }

  const trackedPre = lotsOn ? [...targets.keys()].filter((pid) => byId.get(pid)?.lotTracked === true) : [];
  const { day } = await companyDay(prisma, tid);
  const release = trackedPre.length ? await acquireLotQueue(tid, trackedPre) : () => undefined;
  try {
    const out = await prisma.$transaction((tx) => executeVanCountInTx(tx, {
      tenantId: tid, vanKey: salesRepId, day, actorId: actorOf(req) || null, note: q.note, clientRef: q.clientRef, includeUnsellable: q.includeUnsellable,
      lines: [...targets.values()], include,
      gate: async (t) => {
        if (!q.clientRef) return;
        await lockClientRef(t, 'van-load', tid, q.clientRef);
        const prior = await priorOf(t);
        if (prior) throw new ClientRefReplay(prior);
      },
      afterLock: (locked) => assertBasesUnchanged(expected, locked.units),
    }, { eventActor: lotEventActorOf(req.user) }), { maxWait: 10_000, timeout: 30_000 });
    if (out.noop) { res.status(200).json(stockNoopBody([...warnings, ...(out.warnings as StockWarning[]), countMatchesWarning()])); return; }
    res.status(201).json({
      success: true, data: { mode: 'COUNT', zero: q.zero, loads: out.loads, relabels: out.relabels, products: out.products }, warnings: [...warnings, ...out.warnings],
    });
  } catch (e) {
    if (e instanceof ClientRefReplay) { replayed(e.row); return; }
    if ((e as { code?: unknown })?.code === 'CLIENT_REF_REUSED') { res.status(409).json({ success: false, code: 'CLIENT_REF_REUSED', message: (e as Error).message }); return; }
    if (e instanceof VanCountPostcondition) { res.status(503).json({ success: false, code: e.code, message: e.message, detail: e.detail }); return; }
    const g = e instanceof ProductUnitsChangedError || e instanceof ProductUnitsBusyError ? baseGuardReply(e, false) : null;
    if (g) { res.status(g.status).json(g.body); return; }
    // LotError بحالته، وانتظار القفل أو مهلة المعاملة ⇒ 503 LOT_BUSY فيعيد المُكامِل
    const h = lotHttpError(e);
    if (h) { res.status(h.status).json(h.body); return; }
    throw e;
  } finally {
    release();
  }
}

const zeroSchema = z.object({
  salesRepId: z.string().optional(),
  clientRef: CLIENT_REF_SCHEMA.optional(),
  // الافتراضي true: التصفير يُفرغ المنتهي والتالف المرتجعَين أيضاً (لا يعرفهما نظام المُكامِل)
  includeUnsellable: z.boolean().optional(),
  note: z.string().optional(),
});

/**
 * تصفير سيارة مندوب: الجرد المطلق بنطاق السيارة كلها وكل صنفٍ صفر، وكل التشغيلات (والمنتهي والتالف ما لم يُرسل includeUnsellable: false).
 * لمفتاح الربط وللإدارة بصلاحية مخزون السيارة (حارس الموجّه)، لا للمندوب. المحجوز (D24) يبقى بتحذير LOT_HELD_REMAINS
 */
router.post('/zero', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = zeroSchema.parse(req.body ?? {});
    await runVanCount(req, res, {
      salesRepId: data.salesRepId, type: 'ADJUST', deleted: false, clientRef: data.clientRef ?? null, note: data.note ?? null,
      scope: 'VAN', includeUnsellable: data.includeUnsellable ?? true, items: [], zero: true,
    });
  } catch (err) { next(err); }
});

// ═══ «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) ═══
// الإدارة ترفع التحميل والميزة مفعّلة (CompanySettings.vanLoadAcceptance) ⇒ صفٌّ معلّق (PendingVanLoad) بلا أثرٍ في أي مخزون، ثم يقبله
// المندوب ويوقّع فتُسجَّل الحركة بمسار POST /loads نفسه (executeVanMovement) كأن الإدارة أنشأتها — أو يعترض بسببٍ فتعدّله الإدارة أو
// تلغيه. كل المسارات ترفض مفتاح API (403 API_KEY_FORBIDDEN)، والمطفأة لا تبلغ شيئاً منها (POST /loads كما كان حرفياً).

/**
 * هل يصير هذا الطلب تحميلاً معلّقاً؟ الشروط الرخيصة أولاً، والإعداد آخراً (قراءة واحدة لتحميل الإدارة وحده).
 * ترويسة إعادة الرفع (X-FS-Replay) لا تُعفي: صندوق الأوف‑لاين لتطبيق المندوب وحده (والمندوب معفى بدوره، والمفتاح تُمحى ترويسته) —
 * فهي من مستخدم الشركة طلبٌ حيّ كغيره، ولو أعفته لدخلت البضاعة السيارة بلا قبولٍ ولا توقيع والميزة مفعّلة
 */
async function pendingLoadWanted(req: AuthRequest, tid: string, data: LoadBody): Promise<boolean> {
  if (data.type !== 'LOAD') return false;
  if (req.user?.role === 'SALES_REP') return false;
  if (req.user?.apiKeyId) return false;
  if (data.deletedSalesRepId !== undefined) return false;
  return vanLoadAcceptanceOn(tid);
}

/** سطرٌ سالب في التحميل المرسل إزالةٌ من السيارة لا «استلام» يوقّع عليه المندوب — يُرفض (التنزيل حركةٌ منفصلة) */
const hasNegativeQty = (items: readonly { qty: number }[]): boolean => items.some((i) => i.qty < 0);

const PENDING_CLIENT_REF_REUSED = 'مرجع الحفظ clientRef مستعملٌ لحركةٍ أخرى — ولّد مرجعاً جديداً لكل حفظ';
const pendingRefuse = (res: Response, status: number, code: PendingLoadCode, extra: Record<string, unknown> = {}): void => {
  res.status(status).json(pendingRefusal(code, extra));
};
/** المسارات كلها للوحة وتطبيق المندوب: المفتاح البرمجي مرفوض قبل أي قراءة */
const pendingApiKeyRefused = (req: AuthRequest, res: Response): boolean => {
  if (!req.user?.apiKeyId) return false;
  pendingRefuse(res, 403, 'API_KEY_FORBIDDEN');
  return true;
};

/** الصفوف بعقد العرض — أسطرها بقراءتين للصفوف كلها */
async function pendingViews(tid: string, rows: PendingRow[], opts: { admin: boolean; withSignature: boolean }): Promise<PendingVanLoadView[]> {
  const lines = await pendingLinesView(tid, rows);
  return rows.map((r) => pendingLoadView(r, lines.get(r.id), opts));
}

/**
 * صفّ المعلّق لمستدعيه — null ⇒ 404. المندوب صفوفه وحده (بمعرّفه من التوكن)، والإدارة بنطاقها: مندوب الصفّ في نطاقها، وصفّ مندوبٍ
 * محذوف لغير المقيّد وحده (لا يُعرف نطاق مندوبٍ لم يعد موجوداً — كبطاقة سيارات المحذوفين)
 */
async function pendingRowFor(req: AuthRequest, tid: string, id: string, mode: 'rep' | 'admin', withSignature = false): Promise<PendingRow | null> {
  const select = withSignature ? { ...PENDING_SELECT, signature: true } : PENDING_SELECT;
  if (mode === 'rep') {
    return (await prisma.pendingVanLoad.findFirst({ where: { id, tenantId: tid, salesRepId: req.user!.id }, select })) as PendingRow | null;
  }
  const row = (await prisma.pendingVanLoad.findFirst({ where: { id, tenantId: tid }, select })) as PendingRow | null;
  if (!row) return null;
  if (row.salesRepId ? !(await canAccessRep(req, tid, row.salesRepId)) : await adminScopeEnabled(req)) return null;
  return row;
}

/**
 * تجربة الحركة بلا كتابة: مسار executeVanMovement كله (الأصناف والوحدات والتشغيلات ورصيد المستودع تحت أقفاله) حتى نداء الإنشاء، ثم
 * تُجهَض معاملته. ردّ المسار إن ردّ قبله (4xx، 422 WAREHOUSE_INSUFFICIENT، 200 بلا حركة…)، وإلا تحذيراته. وغير ذلك يُرمى كما كان
 */
async function dryRunVanLoad(req: AuthRequest, data: LoadBody): Promise<{ reply: CapturedReply } | { warnings: { code: string }[] }> {
  const cap = captureReply();
  try {
    await executeVanMovement(req, cap, { ...data, clientRef: undefined }, { beforeCreate: (w) => { throw new VanDryRun([...w]); } });
  } catch (e) {
    if (!(e instanceof VanDryRun)) throw e;
    return { warnings: e.warnings };
  }
  return { reply: cap };
}

/** تحذيرات التجربة التي تغيّر سطراً عند التسجيل (PENDING_LINE_ALTERING) — تمنع الإرسال: المندوب يوقّع على ما أُرسل حرفياً */
const alteringOf = (ws: unknown): { code: string }[] =>
  (Array.isArray(ws) ? ws : []).filter((w): w is { code: string } => !!w && typeof (w as { code?: unknown }).code === 'string' && PENDING_LINE_ALTERING.has((w as { code: string }).code));

/** ردّ التجربة حين لم تبلغ الإنشاء: «لا شيء يُكتب» بأسطرٍ تُركت ⇒ 422 كتحذيرات الإنشاء، وما سواه ردّ المسار نفسه */
function sendDryReply(res: Response, cap: CapturedReply): void {
  if (cap.code === null || !cap.body) throw new Error('van movement produced no reply');
  const bad = cap.code === 200 && cap.body.noop === true ? alteringOf(cap.body.warnings) : [];
  if (bad.length) { pendingRefuse(res, 422, 'PENDING_LOAD_LINES_CHANGED', { warnings: bad }); return; }
  res.status(cap.code).json(cap.body);
}

/** POST /loads والميزة مفعّلة: تحميل الإدارة يُجرَّب بلا كتابة ثم يُحفظ معلّقاً ويُنبَّه المندوب — 201 { pending: true } */
async function createPendingLoad(req: AuthRequest, res: Response, data: LoadBody): Promise<void> {
  const tid = tenantId(req);
  if (!data.salesRepId) throw Object.assign(new Error('يجب تحديد المندوب'), { status: 400 });
  const salesRepId = data.salesRepId;
  await assertRepInScope(req, tid, salesRepId);
  const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true, name: true, isActive: true } });
  if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
  if (rep.isActive === false) { pendingRefuse(res, 409, 'PENDING_LOAD_REP_INACTIVE'); return; }
  if (hasNegativeQty(data.items)) { pendingRefuse(res, 400, 'PENDING_LOAD_QTY_NEGATIVE'); return; }
  const { clientRef, ...body } = data;
  const admin = { admin: true, withSignature: false };
  const replayed = async (prior: PendingRow) => {
    res.status(200).json({ success: true, pending: true, data: (await pendingViews(tid, [prior], admin))[0], replay: true, idempotent: true });
  };
  const reused = () => res.status(409).json({ success: false, code: 'CLIENT_REF_REUSED', message: PENDING_CLIENT_REF_REUSED });
  if (clientRef) {
    // D8: إعادة إرسالٍ بمرجعٍ حُفظ معلّقاً ⇒ الصفّ القائم 200 بلا كتابة؛ ولسيارةٍ أخرى ⇒ 409
    const prior = (await prisma.pendingVanLoad.findFirst({ where: { tenantId: tid, clientRef }, orderBy: { createdAt: 'asc' }, select: PENDING_SELECT })) as PendingRow | null;
    if (prior) { if (prior.salesRepId === salesRepId) await replayed(prior); else reused(); return; }
    // ومرجعٌ سُجّلت به حركةٌ مباشرة (قبل تفعيل الميزة) ⇒ مسار الحركة نفسه يعيدها 200 أو يرفض المرجع — لا معلّقٌ مكرَّر
    if (await prisma.vanLoad.findFirst({ where: { tenantId: tid, clientRef }, select: { id: true } })) { await executeVanMovement(req, res, data); return; }
  }
  const dry = await dryRunVanLoad(req, { ...body, salesRepId });
  if ('reply' in dry) { sendDryReply(res, dry.reply); return; }
  const bad = alteringOf(dry.warnings);
  if (bad.length) { pendingRefuse(res, 422, 'PENDING_LOAD_LINES_CHANGED', { warnings: bad }); return; }
  const actor = actorOf(req);
  let row: PendingRow;
  try {
    row = await prisma.$transaction(async (tx) => {
      if (clientRef) {
        // التفرّد بلا قيدٍ فريد: قفل المرجع ثم البحث به داخل المعاملة (كحركات السيارة)
        await lockClientRef(tx, 'pending-van-load', tid, clientRef);
        const prior = (await tx.pendingVanLoad.findFirst({ where: { tenantId: tid, clientRef }, orderBy: { createdAt: 'asc' }, select: PENDING_SELECT })) as PendingRow | null;
        if (prior) {
          if (prior.salesRepId !== salesRepId) throw Object.assign(new Error(PENDING_CLIENT_REF_REUSED), { status: 409, code: 'CLIENT_REF_REUSED' });
          throw new ClientRefReplay(prior);
        }
      }
      return (await tx.pendingVanLoad.create({
        data: {
          tenantId: tid, salesRepId, repName: rep.name, status: 'PENDING',
          // JSON صرف: المفاتيح الغائبة (undefined) لا تُحفظ، فالجسم المحفوظ هو ما سيُعاد تحليله بـloadSchema عند القبول
          body: JSON.parse(JSON.stringify({ ...body, type: 'LOAD', salesRepId })) as Prisma.InputJsonValue,
          note: body.note?.trim() || null, clientRef: clientRef ?? null,
          createdById: actor, createdByName: pendingActorName(actor, req.user?.name),
          // فاعل سجل تدقيق اللوط كما كان سيكتبه المسار المباشر الآن (موظف المنصة والمالك بمعرّفيهما) — يُمرَّر للحركة عند القبول
          createdByActor: lotEventActorOf(req.user) as unknown as Prisma.InputJsonValue,
        },
        select: PENDING_SELECT,
      })) as PendingRow;
    });
  } catch (e) {
    if (e instanceof ClientRefReplay) { await replayed(e.row as PendingRow); return; }
    if ((e as { code?: unknown })?.code === 'CLIENT_REF_REUSED') { reused(); return; }
    throw e;
  }
  notifyPendingLoad(salesRepId);
  const [view] = await pendingViews(tid, [row], admin);
  res.status(201).json({ success: true, pending: true, data: view, ...(dry.warnings.length > 0 && { warnings: dry.warnings }) });
}

const PENDING_LIST_MAX = 100;
const PENDING_RECENT_DAYS = { admin: 7, rep: 3 } as const;

/**
 * التحميلات المعلّقة: المندوب صفوفه وحده، والإدارة بنطاقها (و?salesRepId). بلا status: المفتوحة (PENDING وDISPUTED) أحدثها أولاً،
 * ثم المقبولة حديثاً (٧ أيام للإدارة و٣ للمندوب). status: open | PENDING | DISPUTED | ACCEPTED | CANCELLED وحده (وغيره يُهمل).
 * withSignature=1 (للإدارة): التوقيع على المقبول للمصغّرة. counts: عدّ المعلّق والمعترَض عليه بالقيد نفسه
 */
router.get('/pending-loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (pendingApiKeyRefused(req, res)) return;
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const q = typeof req.query.status === 'string' ? req.query.status : '';
    const status = q === 'open' || (PENDING_STATUSES as readonly string[]).includes(q) ? q : null;
    const limit = Math.min(PENDING_LIST_MAX, Math.max(1, parseInt(String(req.query.limit)) || 50));
    let base: Prisma.PendingVanLoadWhereInput;
    if (isRep) base = { tenantId: tid, salesRepId: req.user!.id };
    else {
      const repId = queryRepId(req);
      if (repId) await assertRepInScope(req, tid, repId);
      base = { tenantId: tid, ...(repId && { salesRepId: repId }), ...(await scopedRepRecordWhere(req)) };
    }
    const withSig = !isRep && (req.query.withSignature === '1' || req.query.withSignature === 'true');
    const select = withSig ? { ...PENDING_SELECT, signature: true } : PENDING_SELECT;
    const find = (where: Prisma.PendingVanLoadWhereInput, orderBy: Prisma.PendingVanLoadOrderByWithRelationInput, take: number) =>
      prisma.pendingVanLoad.findMany({ where: { ...base, ...where }, orderBy, take, select }) as Promise<PendingRow[]>;
    let rows: PendingRow[];
    if (status && status !== 'open') {
      const orderBy = status === 'ACCEPTED' ? { acceptedAt: 'desc' as const } : status === 'CANCELLED' ? { cancelledAt: 'desc' as const } : { createdAt: 'desc' as const };
      rows = await find({ status }, orderBy, limit);
    } else {
      const open = await find({ status: { in: ['PENDING', 'DISPUTED'] } }, { createdAt: 'desc' }, limit);
      const since = new Date(Date.now() - (isRep ? PENDING_RECENT_DAYS.rep : PENDING_RECENT_DAYS.admin) * 86_400_000);
      rows = status === 'open' ? open : [...open, ...(await find({ status: 'ACCEPTED', acceptedAt: { gte: since } }, { acceptedAt: 'desc' }, 20))];
    }
    const [pending, disputed] = await Promise.all([
      prisma.pendingVanLoad.count({ where: { ...base, status: 'PENDING' } }),
      prisma.pendingVanLoad.count({ where: { ...base, status: 'DISPUTED' } }),
    ]);
    const views = await pendingViews(tid, rows, { admin: !isRep, withSignature: false });
    res.json({
      success: true,
      data: views.map((v, n) => (withSig && rows[n].status === 'ACCEPTED' ? { ...v, signature: rows[n].signature ?? null } : v)),
      counts: { pending, disputed },
    });
  } catch (err) { next(err); }
});

/** تحميلٌ معلّق بتوقيعه — للمندوب صفّه وحده وللإدارة بنطاقها؛ والمقبول ومعه حركته (vanLoad) لطباعة إقرار الاستلام */
router.get('/pending-loads/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (pendingApiKeyRefused(req, res)) return;
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const row = await pendingRowFor(req, tid, String(req.params.id), isRep ? 'rep' : 'admin', true);
    if (!row) { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    const [view] = await pendingViews(tid, [row], { admin: !isRep, withSignature: true });
    let vanLoad: unknown = null;
    if (row.status === 'ACCEPTED' && row.vanLoadId) {
      // تشغيلات البنود والميزة مفعّلة — قراءة العلم هنا لا withLotsOf (معاملٌ لا يخصّ هذا المسار)
      const lotsOn = (await prisma.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true } }))?.lotTrackingEnabled === true;
      vanLoad = await prisma.vanLoad.findFirst({
        where: { id: row.vanLoadId, tenantId: tid },
        include: { items: { include: { product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }, ...(lotsOn && { lots: ITEM_LOTS_INCLUDE }) } } },
      });
    }
    res.json({ success: true, data: { ...view, ...(row.status === 'ACCEPTED' && { vanLoad }) } });
  } catch (err) { next(err); }
});

/**
 * قبول المندوب وتوقيعه: الحركة بالجسم المحفوظ بمسار POST /loads نفسه كأن الإدارة أنشأتها (فاعلها المرسِل)، في معاملته وتحت قفل
 * الصفّ أولاً — الحالة PENDING والمراجعة التي رآها المندوب، ثم الحركة مختومةً بلحظة القبول، ثم الصفّ ACCEPTED بتوقيعه ومعرّف الحركة.
 * ما يغيّر سطراً الآن (صنفٌ حُذف، وحدةٌ تبدّلت، تشغيلةٌ نفدت) أو رصيد مستودعٍ لا يكفي ⇒ 409 بلا حركة ويبقى معلّقاً. والإعادة ⇒ 200
 */
router.post('/pending-loads/:id/accept', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (pendingApiKeyRefused(req, res)) return;
    if (req.user?.role !== 'SALES_REP') { pendingRefuse(res, 403, 'PENDING_LOAD_REP_ONLY'); return; }
    // إقرارٌ بتوقيعٍ حيّ: لا يُقبل من صندوق دون اتصال (المستند يُكتب لاحقاً بحالٍ لم يرها المندوب)
    if (String(req.headers['x-fs-replay'] || '') === '1') { pendingRefuse(res, 400, 'PENDING_LOAD_ONLINE_ONLY'); return; }
    const parsed = pendingAcceptSchema.safeParse(req.body ?? {});
    if (!parsed.success) { pendingRefuse(res, 400, 'PENDING_LOAD_SIGNATURE_REQUIRED'); return; }
    const { signature, revision, lat, lng } = parsed.data;
    const tid = tenantId(req);
    const id = String(req.params.id);
    const viewOf = async (r: PendingRow) => (await pendingViews(tid, [r], { admin: false, withSignature: false }))[0];
    const reread = async () => { const r = await pendingRowFor(req, tid, id, 'rep'); return r ? viewOf(r) : null; };
    const row = await pendingRowFor(req, tid, id, 'rep');
    if (!row) { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    if (row.status === 'ACCEPTED') { res.json({ success: true, data: await viewOf(row), replay: true }); return; }
    if (row.status !== 'PENDING') { pendingRefuse(res, 409, 'PENDING_LOAD_NOT_PENDING', { data: await viewOf(row) }); return; }
    if (row.revision !== revision) { pendingRefuse(res, 409, 'PENDING_LOAD_REVISED', { data: await viewOf(row) }); return; }
    const body = loadSchema.safeParse(row.body);
    if (!body.success || body.data.type !== 'LOAD' || !row.salesRepId) { pendingRefuse(res, 409, 'PENDING_LOAD_CHANGED'); return; }
    const salesRepId = row.salesRepId;
    // فاعل سجل تدقيق اللوط المحفوظ لحظة الإرسال (lotEventActorOf كالمسار المباشر) — لا يُقرأ في PENDING_SELECT ولا يصل أي ردّ؛
    // وصفٌّ بلاه (أقدم) يُبنى من المرسِل
    const sent = await prisma.pendingVanLoad.findFirst({ where: { id, tenantId: tid }, select: { createdByActor: true } });
    const eventActor = storedEventActor(sent?.createdByActor) ?? pendingEventActor(row.createdById, row.createdByName);
    const now = new Date();
    // الموقع زوجٌ كامل أو لا شيء — إحداثيةٌ وحدها لا تدلّ على مكان
    const fix = lat != null && lng != null ? { lat, lng } : null;
    const cap = captureReply();
    try {
      await executeVanMovement(req, cap, { ...body.data, type: 'LOAD', salesRepId, clientRef: undefined, deletedSalesRepId: undefined, mode: undefined }, {
        asAdmin: { salesRepId, actorId: row.createdById ?? actorOf(req), eventActor },
        gate: async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pendingLoadLockKey(id)}))`;
          const cur = await tx.pendingVanLoad.findFirst({ where: { id, tenantId: tid }, select: { status: true, revision: true } });
          if (cur?.status === 'ACCEPTED') throw new PendingLoadSettled('ACCEPTED');
          if (!cur || cur.status !== 'PENDING') throw new PendingLoadSettled('NOT_PENDING');
          if (cur.revision !== revision) throw new PendingLoadSettled('REVISED');
        },
        beforeCreate: (w) => {
          const bad = w.filter((x) => PENDING_LINE_ALTERING.has(x.code));
          if (bad.length) throw new PendingLinesChanged([...bad]);
        },
        stamp: { acceptedAt: now, pendingLoadId: id },
        afterCreate: async (tx, load) => {
          await tx.pendingVanLoad.update({
            where: { id },
            data: { status: 'ACCEPTED', acceptedAt: now, signature, acceptedLat: fix?.lat ?? null, acceptedLng: fix?.lng ?? null, vanLoadId: load.id },
          });
        },
      });
    } catch (e) {
      if (e instanceof PendingLoadSettled) {
        const data = await reread();
        if (e.state === 'ACCEPTED') { res.json({ success: true, data, replay: true }); return; }
        pendingRefuse(res, 409, e.state === 'REVISED' ? 'PENDING_LOAD_REVISED' : 'PENDING_LOAD_NOT_PENDING', data ? { data } : {});
        return;
      }
      if (e instanceof PendingLinesChanged) {
        // تشغيلاتٌ لم تعد كما أُرسلت (صريحٌ لا يكفيه صالحه، أو كسرٌ يُقرَّب) غير صنفٍ أو وحدةٍ تبدّلت
        const lotsOnly = e.warnings.every((w) => w.code.startsWith('LOT_'));
        pendingRefuse(res, 409, lotsOnly ? 'PENDING_LOAD_LOTS_SHORT' : 'PENDING_LOAD_CHANGED', { warnings: e.warnings });
        return;
      }
      if (e instanceof LotError) {
        // الانشغال (503 LOT_BUSY) يمرّ فيعيد المندوب، وما سواه تشغيلاتٌ لم تعد كما أُرسلت
        const h = lotHttpError(e)!;
        if (h.status === 503) { res.status(503).json(h.body); return; }
        pendingRefuse(res, 409, 'PENDING_LOAD_LOTS_SHORT', { lot: h.body });
        return;
      }
      if (e instanceof UnitInvalidError || (e as { code?: unknown })?.code === 'UNIT_INVALID') { pendingRefuse(res, 409, 'PENDING_LOAD_CHANGED'); return; }
      const st = (e as { status?: unknown })?.status;
      if (e instanceof Error && typeof st === 'number' && st >= 400 && st < 500) { res.status(st).json({ success: false, message: e.message }); return; }
      next(e);
      return;
    }
    const code = cap.code ?? 500;
    const out = cap.body ?? {};
    if (code === 201) {
      res.json({ success: true, data: await reread(), load: out.data, ...(Array.isArray(out.warnings) && out.warnings.length > 0 && { warnings: out.warnings }) });
      return;
    }
    if (code === 422 && out.code === 'WAREHOUSE_INSUFFICIENT') { pendingRefuse(res, 409, 'PENDING_LOAD_STOCK_SHORT', { lines: out.lines }); return; }
    // تبدّل أساس صنفٍ أثناء الحفظ، أو «لا شيء يُكتب» (أسطرٌ تُركت كلها) ⇒ تغيّر التحميل منذ إرساله
    if ((code === 409 && out.code === 'PRODUCT_UNITS_CHANGED') || code === 200) { pendingRefuse(res, 409, 'PENDING_LOAD_CHANGED'); return; }
    res.status(code).json(out);
  } catch (err) { next(err); }
});

/** اعتراض المندوب بسببٍ إلزامي ⇒ DISPUTED تراه الإدارة فتعدّله أو تلغيه. الاعتراض ثانيةً يحدّث سببه، والمقبول والملغى 409 */
router.post('/pending-loads/:id/dispute', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (pendingApiKeyRefused(req, res)) return;
    if (req.user?.role !== 'SALES_REP') { pendingRefuse(res, 403, 'PENDING_LOAD_REP_ONLY'); return; }
    const parsed = pendingDisputeSchema.safeParse(req.body ?? {});
    if (!parsed.success) { pendingRefuse(res, 400, 'PENDING_LOAD_NOTE_REQUIRED'); return; }
    const tid = tenantId(req);
    const id = String(req.params.id);
    if (!(await pendingRowFor(req, tid, id, 'rep'))) { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    const out = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pendingLoadLockKey(id)}))`;
      const cur = await tx.pendingVanLoad.findFirst({ where: { id, tenantId: tid }, select: { status: true } });
      if (!cur) return 'GONE' as const;
      if (cur.status === 'ACCEPTED' || cur.status === 'CANCELLED') return cur.status;
      await tx.pendingVanLoad.update({ where: { id }, data: { status: 'DISPUTED', disputeNote: parsed.data.note, disputedAt: new Date() } });
      return 'OK' as const;
    });
    if (out === 'GONE') { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    if (out === 'ACCEPTED') { pendingRefuse(res, 409, 'PENDING_LOAD_ACCEPTED'); return; }
    if (out === 'CANCELLED') { pendingRefuse(res, 409, 'PENDING_LOAD_CANCELLED'); return; }
    const row = await pendingRowFor(req, tid, id, 'rep');
    res.json({ success: true, data: row ? (await pendingViews(tid, [row], { admin: false, withSignature: false }))[0] : null });
  } catch (err) { next(err); }
});

/**
 * تعديل الإدارة: الجسم كاملاً بمراجعته (revision) — تجربةٌ بلا كتابة كالإرسال ثم PENDING بمراجعةٍ جديدة ويُمحى الاعتراض.
 * updatedAt (اختياري): لحظة الصفّ كما فُتح عليها التعديل — اعترض المندوب بعدها (أو حدّث سبب اعتراضه) ⇒ 409 PENDING_LOAD_DISPUTED
 * بالصفّ وملاحظته، فلا يُمحى اعتراضٌ لم يره الإداري (الاعتراض لا يغيّر revision)
 */
const pendingEditSchema = loadSchema.extend({ revision: z.number().int().positive(), updatedAt: z.string().max(64).optional() });

router.put('/pending-loads/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (pendingApiKeyRefused(req, res)) return;
    if (req.user?.role === 'SALES_REP') { pendingRefuse(res, 403, 'PENDING_LOAD_ADMIN_ONLY'); return; }
    const data = pendingEditSchema.parse(req.body);
    if (data.type !== 'LOAD' || data.mode !== undefined || data.deletedSalesRepId !== undefined) { pendingRefuse(res, 400, 'PENDING_LOAD_TYPE_INVALID'); return; }
    if (hasNegativeQty(data.items)) { pendingRefuse(res, 400, 'PENDING_LOAD_QTY_NEGATIVE'); return; }
    const tid = tenantId(req);
    const id = String(req.params.id);
    const row = await pendingRowFor(req, tid, id, 'admin');
    if (!row) { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    if (row.salesRepId == null) { pendingRefuse(res, 409, 'PENDING_LOAD_REP_GONE'); return; }
    if (data.salesRepId !== undefined && data.salesRepId !== row.salesRepId) { pendingRefuse(res, 400, 'PENDING_LOAD_REP_FIXED'); return; }
    if (row.status === 'ACCEPTED') { pendingRefuse(res, 409, 'PENDING_LOAD_ACCEPTED'); return; }
    if (row.status === 'CANCELLED') { pendingRefuse(res, 409, 'PENDING_LOAD_CANCELLED'); return; }
    const salesRepId = row.salesRepId;
    // المرجع لا يتغيّر بالتعديل (مرجع الإرسال الأول)
    const { revision, clientRef: _ref, updatedAt: seenAt, ...rest } = data;
    void _ref;
    const body: LoadBody = { ...rest, type: 'LOAD', salesRepId };
    const dry = await dryRunVanLoad(req, body);
    if ('reply' in dry) { sendDryReply(res, dry.reply); return; }
    const bad = alteringOf(dry.warnings);
    if (bad.length) { pendingRefuse(res, 422, 'PENDING_LOAD_LINES_CHANGED', { warnings: bad }); return; }
    const out = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pendingLoadLockKey(id)}))`;
      const cur = await tx.pendingVanLoad.findFirst({ where: { id, tenantId: tid }, select: { status: true, revision: true, updatedAt: true } });
      if (!cur) return 'GONE' as const;
      if (cur.status === 'ACCEPTED' || cur.status === 'CANCELLED') return cur.status;
      if (cur.revision !== revision) return 'REVISED' as const;
      // معترَضٌ عليه بعد أن فُتح التعديل (أو تبدّل سببه): لا يُمحى اعتراضٌ لم يره الإداري
      if (cur.status === 'DISPUTED' && seenAt !== undefined && Date.parse(seenAt) !== cur.updatedAt.getTime()) return 'DISPUTED' as const;
      await tx.pendingVanLoad.update({
        where: { id },
        data: {
          body: JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue, note: body.note?.trim() || null, revision: { increment: 1 },
          status: 'PENDING', disputeNote: null, disputedAt: null,
        },
      });
      return 'OK' as const;
    });
    if (out === 'GONE') { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    if (out === 'ACCEPTED') { pendingRefuse(res, 409, 'PENDING_LOAD_ACCEPTED'); return; }
    if (out === 'CANCELLED') { pendingRefuse(res, 409, 'PENDING_LOAD_CANCELLED'); return; }
    if (out === 'REVISED') { pendingRefuse(res, 409, 'PENDING_LOAD_REVISED'); return; }
    if (out === 'DISPUTED') {
      const now = await pendingRowFor(req, tid, id, 'admin');
      pendingRefuse(res, 409, 'PENDING_LOAD_DISPUTED', now ? { data: (await pendingViews(tid, [now], { admin: true, withSignature: false }))[0] } : {});
      return;
    }
    notifyPendingLoad(salesRepId);
    const fresh = await pendingRowFor(req, tid, id, 'admin');
    res.json({
      success: true, data: fresh ? (await pendingViews(tid, [fresh], { admin: true, withSignature: false }))[0] : null,
      ...(dry.warnings.length > 0 && { warnings: dry.warnings }),
    });
  } catch (err) { next(err); }
});

/**
 * إلغاء الإدارة للمعلّق أو المعترَض عليه (لا أثر يُعكس — لم يُكتب شيء). المقبول 409، والملغى ثانيةً 200.
 * وطلب بضاعة المندوب المعلَّم «حُمِّل» بهذا الصفّ («تحميل مباشر») يعود كما كان في المعاملة نفسها (reopenRepRequestsOf)
 */
router.post('/pending-loads/:id/cancel', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (pendingApiKeyRefused(req, res)) return;
    if (req.user?.role === 'SALES_REP') { pendingRefuse(res, 403, 'PENDING_LOAD_ADMIN_ONLY'); return; }
    const { reason } = pendingCancelSchema.parse(req.body ?? {});
    const tid = tenantId(req);
    const id = String(req.params.id);
    if (!(await pendingRowFor(req, tid, id, 'admin'))) { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    const actor = actorOf(req);
    const out = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pendingLoadLockKey(id)}))`;
      const cur = await tx.pendingVanLoad.findFirst({ where: { id, tenantId: tid }, select: { status: true } });
      if (!cur) return 'GONE' as const;
      if (cur.status === 'ACCEPTED' || cur.status === 'CANCELLED') return cur.status;
      // سبب الاعتراض يبقى كما كتبه المندوب؛ وسبب الإلغاء (إن كُتب) في الملاحظة — جسم التحميل يحفظ ملاحظته الأصلية
      await tx.pendingVanLoad.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: actor, cancelledByName: pendingActorName(actor, req.user?.name), ...(reason && { note: reason }) },
      });
      // لم يصل السيارة شيء ⇒ طلب المندوب المعلَّم «حُمِّل» بهذا الصفّ يعود كما كان (قفل الطلبات بعد قفل الصفّ)
      await reopenRepRequestsOf(tx, tid, id, pendingActorName(actor, req.user?.name));
      return 'OK' as const;
    });
    if (out === 'GONE') { pendingRefuse(res, 404, 'PENDING_LOAD_NOT_FOUND'); return; }
    if (out === 'ACCEPTED') { pendingRefuse(res, 409, 'PENDING_LOAD_ACCEPTED'); return; }
    const row = await pendingRowFor(req, tid, id, 'admin');
    res.json({ success: true, data: row ? (await pendingViews(tid, [row], { admin: true, withSignature: false }))[0] : null });
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
