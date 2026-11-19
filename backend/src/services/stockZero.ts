// ============================================================================
// «تصفير المخزون» (طلب المالك ١ نوفمبر ٢٠٢٦) — الحساب والتخطيط والكتابة
// ----------------------------------------------------------------------------
// زرٌّ واحد لمدير الشركة (أو جلسة المالك) يصفّر مستودع الشركة وكل سيارات المناديب القائمين (ومنهم الموقوفون) بحركات تسوية
// عادية موسومة بـzeroRunId — لا حذف تاريخ: السجلّ يبقى، والرصيد بعدها صفر، فتُدخل الشركة الوارد من جديد.
//
// الأرصدة هنا **دقيقة لا للعرض**: تُجمع بالأساس في SQL (aggWarehouseTotals وaggVanTotals من lotsDb — تعبير BASE_QTY_SQL نفسه
// الذي يطابق baseQtyOf) ثم تُطوى بـfoldStock **نفسها** لمسار مخزون السيارات، وتُقرَّب بستّ منازل (roundQty) لا بأربع: سطر
// التصفير = −الرصيد، فلو قُرّب الرصيد بأربع منازل كـbucketRemaining لبقي غبارٌ (٠٫٠٠٠٠٤) لا يراه أحد ويكسر شرط «كل رصيد صفر».
// وكل قراءة تأخذ `db` معاملاً — prisma للمعاينة، والمعاملة (tx) للتنفيذ تحت قفل الأصناف — فالحساب واحدٌ في الموضعين.
//
// الدوالّ الصرفة (warehouseBalancesOf، vanBalancesOf، planStockZero، lotPartsOf، lotPreviewOf، residualsOf) بلا قاعدة فتُختبر وحدها
// (tests/stock-zero.test.ts وstock-zero-lots.test.ts)، والموجّه routes/stockZero.ts يركّبها حول القفل والمعاملة.
//
// «تصفير سيارة مندوب واحدة» (طلب المالك ١٨ نوفمبر ٢٠٢٦): الحساب نفسه بنطاقٍ أضيق — loadZeroBalances بـvansOnly لا تقرأ
// المستودع ولا سيارات المحذوفين، والخطة بمستودعٍ «مطفأ» (لا تسوية مستودع، وwarehouseZeroed = false)، فيبقى كل ما سواها كما هو:
// الحركات الثلاث موسومة بـzeroRunId على سيارته وحدها، وحدّ دفعات الصلاحية (invoiceExpiry.zeroCutoffAt) لكل مندوبٍ من حركات
// سيارته، وحارس استيراد المخزون الافتتاحي (warehouseZeroed وحده) لا يرى فيها تصفيراً للمستودع.
//
// «أصناف اللوط تُصفَّر تشغيلةً تشغيلة» (طلب المالك ١٨ نوفمبر ٢٠٢٦ — بدل رفض 409 STOCK_ZERO_LOT_TRACKED): والميزة مفعّلة، لكل صنفٍ
// متتبَّع (العلم تحت قفل الأصناف، D25) في كل موقعٍ يُصفَّر — المستودع حين يشمله النطاق وكل سيارة — أجزاءُ رصيده: كل تشغيلةٍ مسمّاة
// بخامها (foldWarehouseLots/foldVanLots نفسيهما بعد الحقبة) وغير المسمّى = رصيد الصنف − Σ الخام. المستودع: سطر تسويةٍ لكل جزء
// بـ−كميته ومعه lotId (وغير المسمّى بلا lotId). السيارة: البند الصافي نفسه لكل نوع (ADJUST −المتاح، DAMAGED_OUT/EXPIRED_OUT
// بالموجب كالأصناف العادية — والدلو السالب متروكٌ معدود كما هو) ومعه صفّ van_load_item_lots لكل جزء بكميته **في اتجاه التصفير**
// (فصفّ تشغيلةٍ سالبة الرصيد موجبٌ في تسوية نقص)، ومجموع الصفوف كمية البند (I3). التشغيلة المنتهية في المتاح تُسوّى كبقية
// المتاح (ADJUST)، والمرتجعة منتهيةً تُزال بـEXPIRED_OUT. ثم يشمل شرط ما بعد التصفير كل تشغيلة (خامها صفر في كل موقعٍ مُصفَّر).
// والميزة مطفأة (أو لا صنف متتبَّع) ⇒ لا قراءة لوط ولا صفوف: السلوك كما كان حرفاً.
// ============================================================================
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { foldStock, type InvRow, type LoadRow } from '../routes/vanStock';
import { roundDecimal } from '../utils/helpers';
import { DAMAGED_VAN_SINCE } from './vanDamaged';
import { LotError, foldVanLots, foldWarehouseLots, type AggInvLot, type BucketQty, type LotBucket, type LotMeta } from './lots';
import {
  BASE_QTY_SQL, aggRelabels, aggVanInvoices, aggVanLoadTotals, aggVanLots, aggVanTotals, aggWarehouseTotals, aggWhLots, loadLotMetas,
  type AggVanTotalInv, type AggVanTotalLoad, type LotDb, type WhTotalAgg,
} from './lotsDb';
import type { WarehouseEntrySource } from './suppliers/core';
import { roundQty, unitFields } from './units';
import { composeWarehouse, loadWarehouseInputs, summarizeVansStock, type WarehouseInputsDb } from './warehouseStock';
import { valueVanQty, type VanLayer } from './warehouseCost';

/** ملاحظة كل حركة تصفير — والوسم الحقيقي zeroRunId (النصّ يُكتب يدوياً في أي تسوية فلا يُعتمد عليه) */
export const STOCK_ZERO_NOTE = 'تصفير المخزون';
/** WarehouseEntry.source لتسوية التصفير («ربط الدفاتر» L1) — من قائمة المصادر في services/suppliers/core.ts */
export const STOCK_ZERO_SOURCE: WarehouseEntrySource = 'STOCK_ZERO';
/** كلمة التأكيد التي يكتبها المدير */
export const STOCK_ZERO_CONFIRM_WORD = 'تصفير';
/** الاسم المعروض لجلسة المالك في التشغيلة وحركة المستودع — كبقية مسارات التدقيق (actorOf) */
export const STOCK_ZERO_SUPPORT_NAME = 'الدعم الفني';
/** حدث سطر التدقيق بعد الالتزام */
export const STOCK_ZERO_AUDIT_EVENT = 'STOCK_ZERO';
/** «له رصيد»: أصغر من أصغر كسرٍ ذي معنى ولا يبتلع حبّة */
export const STOCK_ZERO_EPS = 1e-9;
/** شرط ما بعد التصفير: كل رصيد |x| ≤ هذا، وإلا تراجعت المعاملة كلها */
export const STOCK_ZERO_POST_EPS = 1e-6;
/** «جهاز نشط» في المعاينة: آخر نبضة خلال هذه الأيام */
export const PENDING_DEVICE_DAYS = 14;

/** رموز الردّ ورسائلها — العربية أولاً وبلا علامات ترقيم كبقية رسائل المنصة */
export const STOCK_ZERO_CODES = Object.freeze({
  API_KEY_FORBIDDEN: 'هذا الإجراء غير متاح بمفتاح API',
  STOCK_ZERO_ADMIN_ONLY: 'تصفير المخزون لمدير الشركة وحده',
  STOCK_ZERO_SCOPED: 'تصفير المخزون لمدير الشركة غير المقيد بنطاق',
  STOCK_ZERO_CONFIRM_REQUIRED: 'اكتب كلمة التأكيد تصفير',
  // «تصفير سيارة مندوب واحدة»: المندوب ليس من هذه الشركة (أو حُذف) — النصّ نفسه في بقية المسارات وقاموس الواجهة
  STOCK_ZERO_REP_NOT_FOUND: 'المندوب غير موجود',
  STOCK_ZERO_IN_PROGRESS: 'تصفير آخر قيد التنفيذ انتظر ثم أعد المحاولة',
  // انشغالٌ قابلٌ للإعادة: قفل صنفٍ لم يُفرج (أو طابور اللوط)، أو كاتبٌ لا ينتظر تجميد الأصناف (إلغاء فاتورة، إعادة مخزون) التزم
  // أثناء التصفير فبقي رصيد — لصنفٍ أو لتشغيلة
  STOCK_ZERO_BUSY: 'المخزون مشغول بحركة أخرى أعد المحاولة بعد لحظات',
  // حالةٌ مستحيلة وحدها (خللٌ في الكود لا تزامن): حركات السيارات المكتوبة لا تطابق الخطة
  STOCK_ZERO_POSTCONDITION: 'تعذر التحقق من تصفير كل الأرصدة فلم يحفظ شيء أعد المحاولة',
});
export type StockZeroCode = keyof typeof STOCK_ZERO_CODES;

/** رفضٌ برمزه وحالته (ومعه بياناتٌ للسجلّ كأسطر البقيّة) — يترجمه الموجّه إلى ردّه */
export class StockZeroError extends Error {
  constructor(readonly status: number, readonly code: StockZeroCode, readonly data?: unknown) {
    super(STOCK_ZERO_CODES[code]);
    this.name = 'StockZeroError';
  }
}

// ═══ الأرصدة الدقيقة ═══

export interface ZeroProduct { id: string; name: string; lotTracked?: boolean | null; lotTrackedSince?: Date | null }
/** رصيد صنفٍ في سيارة بدلائه الثلاثة (بالأساس): المتاح للبيع، والمرتجع التالف، والمنتهي — كـcomputeStock */
export interface VanBal { remaining: number; damaged: number; expired: number }
/**
 * خام التشغيلات المسمّاة للأصناف المتتبَّعة في المواقع المقروءة (بالأساس وبستّ منازل) — بعد الحقبة كعرض الأماكن (D25).
 * غير المسمّى لا يُخزَّن: هو رصيد الصنف − Σ الخام، يُشتقّ في الخطة من رصيد الصنف الدقيق نفسه.
 */
export interface ZeroLots {
  /** الأصناف المتتبَّعة التي قُرئت تشغيلاتها (الميزة مفعّلة والعلم تحت القفل) */
  tracked: ReadonlySet<string>;
  /** صنف ⇒ تشغيلة ⇒ خام المستودع (فارغةٌ حين لا يشمله النطاق) */
  warehouse: Map<string, Map<string, number>>;
  /** مندوب ⇒ صنف ⇒ تشغيلة ⇒ خام الدلاء الثلاثة */
  vans: Map<string, Map<string, Map<string, BucketQty>>>;
  /** بطاقات التشغيلات (رقمها وانتهاؤها) للمعاينة والملخّص — فارغةٌ حين لا تُطلب (شرط ما بعد التصفير) */
  metas: Map<string, LotMeta>;
}
export interface ZeroBalances {
  /** صنف ⇒ رصيد المستودع */
  warehouse: Map<string, number>;
  /** مندوب قائم ⇒ صنف ⇒ رصيد سيارته */
  vans: Map<string, Map<string, VanBal>>;
  /** سيارات مناديب محذوفين بقي فيها شيء — لا تُمسّ (فواتيرهم فقدت مندوبها بالحذف فرصيدها مجهول) */
  deletedVans: number;
  /** «تتبّع اللوط»: تشغيلات الأصناف المتتبَّعة — غائبٌ والميزة مطفأة أو لا صنف متتبَّع */
  lots?: ZeroLots;
}

/**
 * رصيد المستودع لكل صنف = الوارد + التسويات + العائد من السيارات − المحمّل لها (composeWarehouse وwarehouseOnHandAgg)،
 * لكن بستّ منازل: warehouseOnHandAgg تقرّب بأربع (roundLot) للعرض واللوط.
 */
export function warehouseBalancesOf(rows: readonly WhTotalAgg[]): Map<string, number> {
  const acc = new Map<string, number>();
  for (const r of rows) {
    // أسطر المستودع كلها بإشارتها أيّاً كان نوعها (الوارد والتسوية والمرتجع للمورّد RETURN السالب)؛ وتسوية السيارة لا تمسّ المستودع
    const sign = r.source === 'WH' ? 1 : r.type === 'LOAD' ? -1 : r.type === 'UNLOAD' ? 1 : 0;
    if (sign) acc.set(r.productId, (acc.get(r.productId) ?? 0) + sign * r.qty);
  }
  const out = new Map<string, number>();
  for (const [pid, q] of acc) out.set(pid, roundQty(q));
  return out;
}

const AGG_EPOCH = new Date(0);

/**
 * رصيد كل سيارة قائمة من المجاميع عبر foldStock **نفسها** (كـvanTotalsFromAgg في lotsDb: الطيّ خطّي فالصفوف المجمَّعة تكفي)،
 * والمتاح = المحمّل − المنزَّل + التسوية − المُباع + المُرتجع كـbucketRemaining — بلا تقريبها بأربع منازل.
 */
export function vanBalancesOf(loads: readonly AggVanTotalLoad[], invs: readonly AggVanTotalInv[]): Map<string, Map<string, VanBal>> {
  const loadsBy = new Map<string, LoadRow[]>();
  for (const l of loads) {
    if (!l.vanKey) continue;
    const list = loadsBy.get(l.vanKey) ?? [];
    list.push({ productId: l.productId, qty: l.qty, vanLoad: { type: l.type, createdAt: AGG_EPOCH } });
    loadsBy.set(l.vanKey, list);
  }
  const invsBy = new Map<string, InvRow[]>();
  for (const r of invs) {
    if (!r.vanKey) continue;
    const list = invsBy.get(r.vanKey) ?? [];
    list.push({
      productId: r.productId, qty: r.qty, returnExpired: r.returnExpired,
      invoice: {
        type: r.type, returnToStock: r.returnToStock, invoiceDate: AGG_EPOCH,
        // damaged محسوبٌ في SQL (isDamagedVanReturn) — يُعاد إلى شكله الذي يقرؤه foldStock
        returnReason: r.damaged ? 'DAMAGED' : null, createdAt: r.damaged ? DAMAGED_VAN_SINCE : null,
      },
    });
    invsBy.set(r.vanKey, list);
  }
  const out = new Map<string, Map<string, VanBal>>();
  for (const key of new Set([...loadsBy.keys(), ...invsBy.keys()])) {
    const { bal } = foldStock(loadsBy.get(key) ?? [], invsBy.get(key) ?? []);
    const m = new Map<string, VanBal>();
    for (const [pid, b] of bal) {
      m.set(pid, {
        remaining: roundQty(b.loaded - b.unloaded + b.adjusted - b.sold + b.returned),
        damaged: roundQty(b.damagedIn - b.damagedOut),
        expired: roundQty(b.expiredIn - b.expiredOut),
      });
    }
    out.set(key, m);
  }
  return out;
}

/** سيارات المناديب المحذوفين التي بقي فيها شيء: صافي التحميل والتسوية − التنزيل > 0 (كبطاقة «في مخزون السيارات») */
export function deletedVansOf(rows: readonly { vanKey: string; type: string; qty: number }[]): number {
  const net = new Map<string, number>();
  for (const r of rows) {
    const sign = r.type === 'LOAD' || r.type === 'ADJUST' ? 1 : r.type === 'UNLOAD' ? -1 : 0;
    if (sign) net.set(r.vanKey, (net.get(r.vanKey) ?? 0) + sign * r.qty);
  }
  return [...net.values()].filter((q) => q > STOCK_ZERO_EPS).length;
}

/** حركات سيارات المناديب المحذوفين مجمَّعةً بمفتاحها المحفوظ ونوعها — بالأساس */
async function aggDeletedVans(db: LotDb, tid: string): Promise<{ vanKey: string; type: string; qty: number }[]> {
  const rows = await db.$queryRaw<{ vanKey: string; type: string; qty: number | null }[]>`
    SELECT vl."deletedSalesRepId" AS "vanKey", vl.type, SUM(${BASE_QTY_SQL})::float8 AS qty
    FROM van_load_items vli
    JOIN van_loads vl ON vl.id = vli."vanLoadId"
    WHERE vl."tenantId" = ${tid} AND vl."salesRepId" IS NULL AND vl."deletedSalesRepId" IS NOT NULL
    GROUP BY 1, 2`;
  return rows.map((r) => ({ vanKey: r.vanKey, type: r.type, qty: Number(r.qty) || 0 }));
}

/**
 * الأرصدة الدقيقة للشركة: المستودع (كل السيارات ومنها المحذوفة، كـloadWarehouseInputs) وسيارات المناديب القائمين، لكل أصناف
 * الشركة ومنها المعطّلة. استعلاماتٌ متتابعة لا Promise.all: داخل المعاملة اتصالٌ واحد على أي حال.
 * vansOnly («تصفير سيارة مندوب واحدة»): سيارات `repIds` وحدها — لا المستودع ولا سيارات المحذوفين (خارج النطاق فلا تُقرأ).
 * والسيارات مقصورةٌ على `repIds` في الحالين: الاستعلام يحدّها، والحدّ هنا حزامٌ لا يدع سيارةً أخرى تدخل الخطة.
 */
export async function loadZeroBalances(
  db: LotDb, tid: string, q: { productIds: string[]; repIds: string[]; lotProductIds?: readonly string[] },
  opts: { vansOnly?: boolean; lotMetas?: boolean } = {},
): Promise<ZeroBalances> {
  const lotPids = uniqIds(q.lotProductIds ?? []);
  const wh = opts.vansOnly ? [] : await aggWarehouseTotals(db, tid, { productIds: q.productIds });
  // «تتبّع اللوط»: بنود فواتير السيارات ولوطاتها في عبارةٍ واحدة (aggVanInvoices) — إلغاء فاتورةٍ أو إعادة مخزونها لا ينتظر قفل
  // الأصناف، فلو قُرئا في عبارتين لحُسب غير المسمّى (رصيد الصنف − Σ الخام) من لقطتين. والميزة مطفأة: aggVanTotals كما كانت
  let van: { loads: AggVanTotalLoad[]; invs: AggVanTotalInv[] };
  let invLots: AggInvLot[] = [];
  const pids = uniqIds(q.productIds);
  const repKeys = uniqIds(q.repIds);
  if (lotPids.length && pids.length && repKeys.length) {
    const loads = await aggVanLoadTotals(db, tid, pids, repKeys, null);
    const inv = await aggVanInvoices(db, tid, { productIds: pids, vanKeys: repKeys, totalVanKeys: repKeys });
    const tracked = new Set(lotPids);
    van = { loads, invs: inv.totals };
    invLots = inv.lots.filter((r) => tracked.has(r.productId));
  } else {
    van = await aggVanTotals(db, tid, { vanKeys: q.repIds, productIds: q.productIds });
  }
  const deleted = opts.vansOnly ? [] : await aggDeletedVans(db, tid);
  const keys = new Set(q.repIds);
  const vans = new Map([...vanBalancesOf(van.loads, van.invs)].filter(([repId]) => keys.has(repId)));
  const lots = lotPids.length
    ? await loadZeroLots(db, tid, { productIds: lotPids, repIds: repKeys, warehouse: !opts.vansOnly, invLots, metas: opts.lotMetas === true })
    : null;
  return { warehouse: warehouseBalancesOf(wh), vans, deletedVans: deletedVansOf(deleted), ...(lots && { lots }) };
}

const uniqIds = (xs: Iterable<string>): string[] => [...new Set([...xs].filter((x) => typeof x === 'string' && x.length > 0))];

/**
 * خام تشغيلات الأصناف المتتبَّعة في المستودع (`warehouse`) وسيارات `repIds` — الطيّ نفسه لعرض الأماكن (foldWarehouseLots
 * وfoldVanLots على تجميعات lotsDb بعد الحقبة)، و`invLots` لوطات الفواتير المقروءة مع بنودها في عبارةٍ واحدة (loadZeroBalances).
 * الخام بستّ منازل (roundQty): سطر التصفير −الخام فلا غبار يبقى.
 */
export async function loadZeroLots(db: LotDb, tid: string, q: {
  productIds: string[]; repIds: string[]; warehouse: boolean; invLots: AggInvLot[]; metas: boolean;
}): Promise<ZeroLots> {
  const pids = uniqIds(q.productIds);
  const keys = uniqIds(q.repIds);
  const whLots = q.warehouse ? await aggWhLots(db, tid, { productIds: pids }) : [];
  // المستودع: تحميلات السيارات وتنزيلاتها بـviaWarehouse من كل السيارات ومنها المحذوفة (كرصيد المستودع، D28)
  const whVanLots = q.warehouse ? await aggVanLots(db, tid, { productIds: pids, viaWarehouseOnly: true }) : [];
  const vanLots = keys.length ? await aggVanLots(db, tid, { productIds: pids, vanKeys: keys }) : [];
  const rels = await aggRelabels(db, tid, { productIds: pids, warehouse: q.warehouse, vanKeys: keys });
  const warehouse = new Map<string, Map<string, number>>();
  if (q.warehouse) {
    for (const [pid, m] of foldWarehouseLots(whLots, whVanLots, rels)) {
      warehouse.set(pid, new Map([...m].map(([lotId, x]) => [lotId, roundQty(x)])));
    }
  }
  const vans = new Map<string, Map<string, Map<string, BucketQty>>>();
  for (const key of keys) {
    const { named } = foldVanLots(vanLots, q.invLots, rels, key);
    const m = new Map<string, Map<string, BucketQty>>();
    for (const [pid, lots] of named) {
      m.set(pid, new Map([...lots].map(([lotId, x]) => [lotId, {
        SELLABLE: roundQty(x.raw.SELLABLE), EXPIRED: roundQty(x.raw.EXPIRED), DAMAGED: roundQty(x.raw.DAMAGED),
      }])));
    }
    if (m.size) vans.set(key, m);
  }
  const lotIds = q.metas ? uniqIds([
    ...[...warehouse.values()].flatMap((m) => [...m.keys()]),
    ...[...vans.values()].flatMap((pm) => [...pm.values()].flatMap((m) => [...m.keys()])),
  ]) : [];
  const metas = lotIds.length ? await loadLotMetas(db, tid, { lotIds }) : new Map<string, LotMeta>();
  return { tracked: new Set(pids), warehouse, vans, metas };
}

/// ═══ الخطة ═══

/** جزءٌ من رصيد صنفٍ متتبَّع في موقع قبل التصفير: تشغيلةٌ مسمّاة (lotId) أو غير المسمّى (null) — بالأساس وبإشارته */
export interface ZeroLotBalance { lotId: string | null; balance: number }
/** صفّ لوطٍ يُكتب مع بند السيارة: كميته في اتجاه البند (ADJUST −الجزء، والإزالة +الجزء) ومجموع صفوف البند كميته (I3) */
export interface ZeroLotRow { lotId: string | null; qty: number }
/** بند حركة سيارة: الكمية كما تُكتب، و`lots` لصنفٍ متتبَّع (صفّ لكل تشغيلة ولغير المسمّى) */
export interface ZeroLine { productId: string; qty: number; lots?: ZeroLotRow[] }
/** سطر المستودع: الرصيد قبل التصفير (السطر يُكتب بـ−الرصيد)، و`lots` لصنفٍ متتبَّع: سطرٌ لكل جزء بـ−رصيده */
export interface ZeroWarehouseLine { productId: string; balance: number; lots?: ZeroLotBalance[] }
/** صنفٌ في سيارة قبل التصفير بدلائه، و`lots` أجزاء الصنف المتتبَّع لكل دلو (ومنها دلوٌ سالبٌ متروك) */
export type VanZeroProduct = { productId: string } & VanBal & { lots?: (ZeroLotBalance & { bucket: LotBucket })[] };
export interface VanZeroPlan {
  repId: string;
  /** الأرصدة قبل التصفير — كل صنفٍ له شيءٌ غير صفري في أي دلو أو تشغيلة (ومنه السالب المتروك) */
  products: VanZeroProduct[];
  /** ADJUST بسطر −المتاح (موجبٌ حين المتاح سالب) */
  adjust: ZeroLine[];
  /** DAMAGED_OUT بالتالف الموجب */
  damagedOut: ZeroLine[];
  /** EXPIRED_OUT بالمنتهي الموجب */
  expiredOut: ZeroLine[];
}
export interface StockZeroPlan {
  warehouse: { enabled: boolean; lines: ZeroWarehouseLine[] };
  vans: VanZeroPlan[];
  skipped: { deletedVans: number; negativeUnsellable: number };
  alreadyZero: boolean;
}

const nz = (x: number) => Math.abs(x) > STOCK_ZERO_EPS;
/** −0 ⇒ 0: سطرٌ بلا كمية يُكتب صفراً لا «−0» */
const z0 = (x: number) => (x === 0 ? 0 : x);
const ZERO_BAL: VanBal = Object.freeze({ remaining: 0, damaged: 0, expired: 0 });
const BUCKET_OF = { remaining: 'SELLABLE', expired: 'EXPIRED', damaged: 'DAMAGED' } as const;

/**
 * أجزاء رصيد صنفٍ متتبَّع في دلو: تشغيلاته المسمّاة غير الصفرية بترتيب معرّفها (حتميّ)، ثم غير المسمّى = الرصيد − Σها (null)
 * حين لا يكون صفراً. Σ الأجزاء = الرصيد بستّ منازل، فالتصفير بها يصفّر الرصيد وكل تشغيلةٍ وغير المسمّى معاً.
 */
export function lotPartsOf(total: number, named: Iterable<readonly [string, number]>): ZeroLotBalance[] {
  const out: ZeroLotBalance[] = [];
  let sum = 0;
  for (const [lotId, q] of [...named].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const v = roundQty(q);
    if (!nz(v)) continue;
    out.push({ lotId, balance: v });
    sum += v;
  }
  const unnamed = roundQty(total - sum);
  if (nz(unnamed)) out.push({ lotId: null, balance: unnamed });
  return out;
}

/**
 * الخطة من الأرصدة: سطرٌ لكل صنفٍ له رصيد في المستودع (والمستودع مفعّل)، ولكل سيارة ثلاث حركات بحسب الدلو.
 * التالف والمنتهي السالبان (إلغاء مرتجعٍ بعد إزالة بضاعته) لا يُكتبان: إزالةٌ بكميةٍ سالبة تُدخل بضاعةً لا وجود لها — يُعدّان.
 * الترتيب ثابت (الأصناف بترتيب `products`، والسيارات بمعرّفها) فتتطابق المعاينة والتنفيذ والاختبار.
 * «تتبّع اللوط» (والميزة مفعّلة وتشغيلات الصنف مقروءة في `balances.lots`): السطر نفسه ومعه أجزاؤه (lotPartsOf) — وصنفٌ رصيده صفر
 * وتشغيلاته لا (تشغيلةٌ «شبح» فوق رصيده يقابلها غير مسمّى سالب) يُكتب له سطرٌ بكمية صفر وأجزائه، فتصير كلها صفراً.
 */
export function planStockZero(input: {
  products: readonly ZeroProduct[];
  warehouseEnabled: boolean;
  lotTrackingEnabled: boolean;
  balances: ZeroBalances;
}): StockZeroPlan {
  const { products, balances } = input;
  const lots = input.lotTrackingEnabled ? balances.lots ?? null : null;
  const tracked = (pid: string) => !!lots && lots.tracked.has(pid);
  const lines: ZeroWarehouseLine[] = [];
  if (input.warehouseEnabled) {
    for (const p of products) {
      const balance = balances.warehouse.get(p.id) ?? 0;
      if (!tracked(p.id)) {
        if (nz(balance)) lines.push({ productId: p.id, balance });
        continue;
      }
      const parts = lotPartsOf(balance, lots!.warehouse.get(p.id) ?? []);
      if (nz(balance) || parts.length) lines.push({ productId: p.id, balance, lots: parts });
    }
  }
  let negativeUnsellable = 0;
  const vans: VanZeroPlan[] = [];
  // السيارات: كل سيارةٍ لها رصيد صنف، وكل سيارةٍ لها خام تشغيلات (تسميةٌ بين تشغيلتين بلا رصيد صنف)
  const repIds = [...new Set([...balances.vans.keys(), ...(lots ? lots.vans.keys() : [])])].sort();
  for (const repId of repIds) {
    const m = balances.vans.get(repId);
    const plan: VanZeroPlan = { repId, products: [], adjust: [], damagedOut: [], expiredOut: [] };
    for (const p of products) {
      const b = m?.get(p.id) ?? ZERO_BAL;
      const lm = tracked(p.id) ? [...(lots!.vans.get(repId)?.get(p.id) ?? [])] : null;
      const parts = lm ? {
        remaining: lotPartsOf(b.remaining, lm.map(([id, x]) => [id, x.SELLABLE] as const)),
        damaged: lotPartsOf(b.damaged, lm.map(([id, x]) => [id, x.DAMAGED] as const)),
        expired: lotPartsOf(b.expired, lm.map(([id, x]) => [id, x.EXPIRED] as const)),
      } : null;
      const has = (k: keyof VanBal) => nz(b[k]) || !!parts?.[k].length;
      if (!(has('remaining') || has('damaged') || has('expired'))) continue;
      plan.products.push({
        productId: p.id, remaining: b.remaining, damaged: b.damaged, expired: b.expired,
        ...(parts && { lots: (['remaining', 'expired', 'damaged'] as const).flatMap((k) => parts[k].map((x) => ({ ...x, bucket: BUCKET_OF[k] }))) }),
      });
      // المتاح: −الرصيد، وصفّ كل جزءٍ −رصيده (ومنه التشغيلة المنتهية غير المباعة — تسويةٌ كبقية المتاح)
      if (has('remaining')) {
        plan.adjust.push({
          productId: p.id, qty: z0(roundQty(-b.remaining)),
          ...(parts && { lots: parts.remaining.map((x) => ({ lotId: x.lotId, qty: z0(roundQty(-x.balance)) })) }),
        });
      }
      // التالف والمنتهي: إزالةٌ بالموجب وصفوفها بأجزائها (والمرتجع منتهياً بتشغيلته بـEXPIRED_OUT)؛ والدلو السالب متروكٌ معدودٌ
      // بتشغيلاته كما هو. ودلوٌ صفرٌ بتشغيلاتٍ غير صفرية: بندٌ بكمية صفر وصفوفه
      for (const [k, out] of [['damaged', plan.damagedOut], ['expired', plan.expiredOut]] as const) {
        if (b[k] > STOCK_ZERO_EPS || (!nz(b[k]) && parts?.[k].length)) {
          out.push({ productId: p.id, qty: b[k] > STOCK_ZERO_EPS ? b[k] : 0, ...(parts && { lots: parts[k].map((x) => ({ lotId: x.lotId, qty: x.balance })) }) });
        } else if (nz(b[k])) negativeUnsellable += 1;
      }
    }
    // وسيارةٌ ليس فيها إلا سالبٌ متروك تبقى في الملخّص بلا حركة — يرى المدقّق لماذا لم تُصفَّر
    if (plan.products.length) vans.push(plan);
  }
  const writesVans = vans.some((v) => v.adjust.length || v.damagedOut.length || v.expiredOut.length);
  return {
    warehouse: { enabled: input.warehouseEnabled, lines },
    vans,
    skipped: { deletedVans: balances.deletedVans, negativeUnsellable },
    alreadyZero: !lines.length && !writesVans,
  };
}

/** صنفٌ متتبَّع في معاينة التصفير: موقعه وتشغيلاته (وغير المسمّى lotId null) بكمياتها قبل التصفير ودلوها */
export interface StockZeroLotPreviewItem {
  place: 'WAREHOUSE' | 'VAN';
  repId: string | null;
  repName: string | null;
  productId: string;
  name: string;
  lots: { lotId: string | null; lotNumber: string | null; expiryDate: string | null; bucket: LotBucket; qty: number }[];
}
/** حدّ أصناف اللوط في ردّ المعاينة — والعدد الكامل في lotProductsTotal */
export const STOCK_ZERO_LOT_PREVIEW_LIMIT = 100;

const BUCKET_RANK: Record<LotBucket, number> = { SELLABLE: 0, EXPIRED: 1, DAMAGED: 2 };

/**
 * أصناف اللوط كما ستُصفَّر — من أسطر الخطة نفسها لا من الأرصدة (فالدلو السالب المتروك لا يظهر)، المستودع أولاً ثم كل سيارة.
 * التشغيلات بدلوها ثم بالأقرب انتهاءً ثم برقمها، وغير المسمّى آخر دلوه. الكمية رصيد الجزء قبل التصفير (السالب يُجبر إلى صفر)
 */
export function lotPreviewOf(plan: StockZeroPlan, ctx: {
  metas: ReadonlyMap<string, LotMeta>; productNames: ReadonlyMap<string, string>; repNames: ReadonlyMap<string, string>;
}): StockZeroLotPreviewItem[] {
  const lotOf = (lotId: string | null, bucket: LotBucket, qty: number) => {
    const m = lotId ? ctx.metas.get(lotId) : undefined;
    return { lotId, lotNumber: m?.lotNumber ?? null, expiryDate: m?.expiryDate ?? null, bucket, qty: z0(roundQty(qty)) };
  };
  const sorted = (xs: StockZeroLotPreviewItem['lots']) => xs.sort((a, b) =>
    BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]
    || (a.lotId === null ? 1 : 0) - (b.lotId === null ? 1 : 0)
    || (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31')
    || (a.lotNumber ?? '').localeCompare(b.lotNumber ?? '')
    || (a.lotId ?? '').localeCompare(b.lotId ?? ''));
  const out: StockZeroLotPreviewItem[] = [];
  for (const l of plan.warehouse.lines) {
    if (!l.lots?.length) continue;
    out.push({
      place: 'WAREHOUSE', repId: null, repName: null, productId: l.productId, name: ctx.productNames.get(l.productId) ?? '',
      lots: sorted(l.lots.map((x) => lotOf(x.lotId, 'SELLABLE', x.balance))),
    });
  }
  for (const v of plan.vans) {
    const by = new Map<string, StockZeroLotPreviewItem['lots']>();
    const add = (lines: ZeroLine[], bucket: LotBucket, sign: 1 | -1) => {
      for (const l of lines) {
        if (!l.lots?.length) continue;
        const list = by.get(l.productId) ?? [];
        for (const r of l.lots) list.push(lotOf(r.lotId, bucket, sign * r.qty));
        by.set(l.productId, list);
      }
    };
    add(v.adjust, 'SELLABLE', -1);
    add(v.expiredOut, 'EXPIRED', 1);
    add(v.damagedOut, 'DAMAGED', 1);
    for (const p of v.products) {
      const lots = by.get(p.productId);
      if (!lots) continue;
      out.push({
        place: 'VAN', repId: v.repId, repName: ctx.repNames.get(v.repId) ?? null, productId: p.productId,
        name: ctx.productNames.get(p.productId) ?? '', lots: sorted(lots),
      });
    }
  }
  return out;
}

/** عدد حركات السيارات التي ستُكتب */
export function vanLoadCountOf(plan: StockZeroPlan): number {
  return plan.vans.reduce((s, v) => s + (v.adjust.length ? 1 : 0) + (v.damagedOut.length ? 1 : 0) + (v.expiredOut.length ? 1 : 0), 0);
}

/**
 * شرط ما بعد التصفير: ما بقي غير صفري بعد الكتابة (فارغة = نجاح). المستودع حين يُصفَّر وحده، والسيارات بدلائها — والتالف
 * والمنتهي السالبان متروكان عمداً فلا يُعدّان بقيّة. البقيّة تعني كاتباً لا ينتظر تجميد الأصناف التزم أثناء التصفير
 * (إلغاء فاتورة أو إعادة مخزون) — الموجّه يتراجع ويردّ 503 STOCK_ZERO_BUSY لا خطأ سلامة.
 * «تتبّع اللوط»: وكل تشغيلةٍ لصنفٍ متتبَّع في موقعٍ مُصفَّر خامها صفر (وغير المسمّى = الرصيد − Σ الخام صفرٌ بهما) — إلا دلو
 * التالف أو المنتهي السالب المتروك عمداً بتشغيلاته.
 */
export function residualsOf(b: ZeroBalances, warehouseEnabled: boolean): string[] {
  const out: string[] = [];
  const over = (x: number) => Math.abs(x) > STOCK_ZERO_POST_EPS;
  if (warehouseEnabled) for (const [pid, q] of b.warehouse) if (over(q)) out.push(`WH:${pid}:${q}`);
  for (const [repId, m] of b.vans) {
    for (const [pid, v] of m) {
      if (over(v.remaining)) out.push(`VAN:${repId}:${pid}:remaining:${v.remaining}`);
      if (v.damaged > STOCK_ZERO_POST_EPS) out.push(`VAN:${repId}:${pid}:damaged:${v.damaged}`);
      if (v.expired > STOCK_ZERO_POST_EPS) out.push(`VAN:${repId}:${pid}:expired:${v.expired}`);
    }
  }
  if (b.lots) {
    if (warehouseEnabled) {
      for (const [pid, m] of b.lots.warehouse) for (const [lotId, q] of m) if (over(q)) out.push(`WH:${pid}:lot:${lotId}:${q}`);
    }
    for (const [repId, pm] of b.lots.vans) {
      for (const [pid, m] of pm) {
        const tot = b.vans.get(repId)?.get(pid) ?? ZERO_BAL;
        for (const [lotId, x] of m) {
          if (over(x.SELLABLE)) out.push(`VAN:${repId}:${pid}:lot:${lotId}:remaining:${x.SELLABLE}`);
          if (!(tot.damaged < -STOCK_ZERO_POST_EPS) && over(x.DAMAGED)) out.push(`VAN:${repId}:${pid}:lot:${lotId}:damaged:${x.DAMAGED}`);
          if (!(tot.expired < -STOCK_ZERO_POST_EPS) && over(x.EXPIRED)) out.push(`VAN:${repId}:${pid}:lot:${lotId}:expired:${x.EXPIRED}`);
        }
      }
    }
  }
  return out;
}

// ═══ التقييم (بتكلفة الشراء كصفحة المستودع وبطاقة «في مخزون السيارات») ═══

export interface StockZeroValuation {
  decimals: number;
  /** صنف ⇒ قيمة رصيد المستودع والكمية بلا تكلفة (صفّ composeWarehouse) */
  warehouse: Map<string, { stockValue: number; uncostedQty: number }>;
  layers: Map<string, Map<string, VanLayer[]>>;
  avgCost: Map<string, number>;
}

/**
 * التقييم من حركات الشركة كلها بترتيبها الزمني (composeWarehouse: متوسّطٌ متحرّك وطبقات كل سيارة) — قراءةٌ قبل القفل: القيمة
 * لقطةٌ تدقيقية لما قبل التصفير، والكميات التي تُكتب من الأرصدة الدقيقة داخل المعاملة لا من هنا.
 */
export async function loadValuation(db: WarehouseInputsDb, tid: string, decimals: number): Promise<StockZeroValuation> {
  const inputs = await loadWarehouseInputs(tid, { includeInactive: true }, db);
  const layers = new Map<string, Map<string, VanLayer[]>>();
  const avgCost = new Map<string, number>();
  const rows = composeWarehouse(inputs.products, inputs.whItems, inputs.vanItems, decimals, layers, avgCost);
  return { decimals, warehouse: new Map(rows.map((r) => [r.productId, { stockValue: r.stockValue, uncostedQty: r.uncostedQty }])), layers, avgCost };
}

export interface StockZeroTotals {
  warehouse: { enabled: boolean; products: number; positiveQty: number; negativeQty: number; value: number; uncostedQty: number };
  vans: { reps: number; products: number; sellableQty: number; negativeQty: number; unsellableQty: number; value: number; deletedVans: number };
}

/** الإجماليات للمعاينة وملخّص التشغيلة: الكميات بالأساس، والقيمة بخانات عملة الشركة */
export function totalsOf(plan: StockZeroPlan, val: StockZeroValuation): StockZeroTotals {
  let positiveQty = 0, negativeQty = 0, whValue = 0, uncostedQty = 0;
  for (const l of plan.warehouse.lines) {
    if (l.balance > 0) positiveQty += l.balance; else negativeQty -= l.balance;
    const v = val.warehouse.get(l.productId);
    whValue += v?.stockValue ?? 0;
    uncostedQty += v?.uncostedQty ?? 0;
  }
  let sellableQty = 0, vanNegative = 0, unsellableQty = 0, reps = 0;
  const vanProducts = new Set<string>();
  for (const v of plan.vans) {
    if (v.adjust.length || v.damagedOut.length || v.expiredOut.length) reps += 1;
    for (const p of v.products) {
      if (p.remaining > STOCK_ZERO_EPS) sellableQty += p.remaining;
      else if (p.remaining < -STOCK_ZERO_EPS) vanNegative -= p.remaining;
      if (p.damaged > STOCK_ZERO_EPS) unsellableQty += p.damaged;
      if (p.expired > STOCK_ZERO_EPS) unsellableQty += p.expired;
    }
    for (const l of [...v.adjust, ...v.damagedOut, ...v.expiredOut]) vanProducts.add(l.productId);
  }
  // قيمة ما في السيارات بالدالّة نفسها لبطاقة «في مخزون السيارات» (summarizeVansStock: المتاح الموجب وحده بطبقات سيارته)
  const vanValue = summarizeVansStock(
    plan.vans.map((v) => ({ repId: v.repId, products: v.products.map((p) => ({ productId: p.productId, remaining: p.remaining, unsellable: 0 })) })),
    val.layers, val.avgCost, val.decimals,
  ).value;
  return {
    warehouse: {
      enabled: plan.warehouse.enabled, products: plan.warehouse.lines.length,
      positiveQty: roundQty(positiveQty), negativeQty: roundQty(negativeQty), value: roundDecimal(whValue, val.decimals), uncostedQty: roundQty(uncostedQty),
    },
    vans: {
      reps, products: vanProducts.size, sellableQty: roundQty(sellableQty), negativeQty: roundQty(vanNegative), unsellableQty: roundQty(unsellableQty),
      value: vanValue, deletedVans: plan.skipped.deletedVans,
    },
  };
}

/** مندوب «تصفير سيارة واحدة» كما يُحفظ في الملخّص والنتيجة */
export interface StockZeroRep { id: string; name: string }

/**
 * ملخّص التشغيلة (StockZeroRun.summary): نطاقها (COMPANY للشركة كلها، وVAN لسيارة مندوبٍ واحدة باسمه)، والأرصدة قبل التصفير
 * لكل نطاق وصنف، والإجماليات، وما تُرك ولماذا. «تتبّع اللوط»: ولكل صنفٍ متتبَّع تشغيلاته (lotId ورقمها حين تُعرف، وnull لغير
 * المسمّى) بكمياتها قبل التصفير — المستودع بالمتاح، والسيارة بدلوها
 */
export function runSummaryOf(plan: StockZeroPlan, val: StockZeroValuation, totals: StockZeroTotals, rep?: StockZeroRep | null,
  metas?: ReadonlyMap<string, LotMeta>) {
  const lotNumberOf = (lotId: string | null) => (lotId ? metas?.get(lotId)?.lotNumber ?? null : null);
  return {
    scope: rep ? 'VAN' as const : 'COMPANY' as const,
    ...(rep && { salesRep: { id: rep.id, name: rep.name } }),
    warehouse: plan.warehouse.lines.map((l) => ({
      productId: l.productId, qty: l.balance, value: val.warehouse.get(l.productId)?.stockValue ?? 0,
      ...(l.lots && { lots: l.lots.map((x) => ({ lotId: x.lotId, lotNumber: lotNumberOf(x.lotId), qty: x.balance })) }),
    })),
    vans: plan.vans.map((v) => ({
      repId: v.repId,
      products: v.products.map(({ lots, ...p }) => ({
        ...p,
        // قيمة المتاح الموجب بطبقات سيارته (valueVanQty) — كبطاقة «في مخزون السيارات»
        value: roundDecimal(valueVanQty(val.layers.get(p.productId)?.get(v.repId), p.remaining, val.avgCost.get(p.productId) ?? 0).value, val.decimals),
        ...(lots && { lots: lots.map((x) => ({ lotId: x.lotId, lotNumber: lotNumberOf(x.lotId), bucket: x.bucket, qty: x.balance })) }),
      })),
    })),
    totals,
    skipped: plan.skipped,
    currencyDecimals: val.decimals,
  };
}

/** ردّ «لا شيء يُصفَّر» — بلا تشغيلة ولا صفّ */
export function alreadyZeroResult(plan: StockZeroPlan) {
  return {
    runId: null, alreadyZero: true,
    warehouse: { products: 0, entryId: null }, vans: { reps: 0, loads: 0, products: 0 },
    skipped: plan.skipped, value: { warehouse: 0, vans: 0 },
  };
}

// ═══ الكتابة (داخل المعاملة) ═══

export type StockZeroWriteTx = Pick<Prisma.TransactionClient, 'warehouseEntry' | 'warehouseEntryItem' | 'vanLoad' | 'vanLoadItem' | 'vanLoadItemLot'>;

/**
 * حركات التصفير: تسوية مستودع واحدة (ADJUST) بسطر −الرصيد لكل صنف، ولكل سيارة ADJUST/DAMAGED_OUT/EXPIRED_OUT بحسب الدلو.
 * كل الأسطر بوحدة الأساس (unitFields بلا وحدة: معامل ١ وbaseQty = الكمية) وبلا تكلفة: التسوية جردٌ لا شراء.
 * الرأس ثم أسطره بـcreateMany — ألف صنفٍ إدراجٌ واحد لا ألف.
 * «تتبّع اللوط»: الصنف المتتبَّع في المستودع سطرٌ لكل جزء بـ−رصيده ومعه lotId (وغير المسمّى بلا تشغيلة)؛ وفي السيارة بنده الصافي
 * ومعه صفوف van_load_item_lots (صفّ لكل جزء، بيقين CONFIRMED للمسمّاة وUNKNOWN لغير المسمّى كجرد السيارة) — بمعرّفات بنود
 * الحركة مولَّدةً هنا (createMany لا يُرجع معرّفاتٍ ولا يُنشئ متداخلاً) ثم إدراجٌ واحد للصفوف.
 */
export async function writeStockZero(tx: StockZeroWriteTx, a: { tenantId: string; runId: string; plan: StockZeroPlan; createdBy: string }): Promise<{ entryId: string | null; vanLoads: number }> {
  let entryId: string | null = null;
  if (a.plan.warehouse.enabled && a.plan.warehouse.lines.length) {
    const entry = await tx.warehouseEntry.create({
      // source (ربط الدفاتر L1): مصدر الحركة على صفّها — التصفير تسويةُ جردٍ يميّزها مُطابِق الدفاتر بلا قراءة zeroRunId
      data: { tenantId: a.tenantId, type: 'ADJUST', source: STOCK_ZERO_SOURCE, note: STOCK_ZERO_NOTE, createdBy: a.createdBy, zeroRunId: a.runId },
      select: { id: true },
    });
    entryId = entry.id;
    await tx.warehouseEntryItem.createMany({
      data: a.plan.warehouse.lines.flatMap((l) => (l.lots
        ? l.lots.map((x) => ({ entryId: entry.id, productId: l.productId, ...unitFields(z0(roundQty(-x.balance))), lotId: x.lotId }))
        : [{ entryId: entry.id, productId: l.productId, ...unitFields(roundQty(-l.balance)) }])),
    });
  }
  let vanLoads = 0;
  for (const v of a.plan.vans) {
    for (const [type, lines] of [['ADJUST', v.adjust], ['DAMAGED_OUT', v.damagedOut], ['EXPIRED_OUT', v.expiredOut]] as const) {
      if (!lines.length) continue;
      const load = await tx.vanLoad.create({
        // createdBy ADMIN كبقية حركات الإدارة على السيارة (الفاعل الحقيقي في التشغيلة نفسها)
        data: { tenantId: a.tenantId, salesRepId: v.repId, type, note: STOCK_ZERO_NOTE, createdBy: 'ADMIN', zeroRunId: a.runId },
        select: { id: true },
      });
      const withLots = lines.some((l) => l.lots?.length);
      const ids = withLots ? lines.map(() => randomUUID()) : null;
      await tx.vanLoadItem.createMany({
        data: lines.map((l, i) => ({ ...(ids && { id: ids[i] }), vanLoadId: load.id, productId: l.productId, ...unitFields(l.qty) })),
      });
      if (ids) {
        const rows = lines.flatMap((l, i) => (l.lots ?? []).map((r) => ({
          vanLoadItemId: ids[i], tenantId: a.tenantId, productId: l.productId, vanKey: v.repId, moveType: type, viaWarehouse: false,
          lotId: r.lotId, qty: r.qty, certainty: r.lotId ? 'CONFIRMED' : 'UNKNOWN', reason: null,
        })));
        if (rows.length) await tx.vanLoadItemLot.createMany({ data: rows });
      }
      vanLoads += 1;
    }
  }
  return { entryId, vanLoads };
}

/** سطر التدقيق بعد الالتزام — معرّفات وأعداد فقط (ومعرّف المندوب لتصفير سيارةٍ واحدة) */
export function stockZeroAuditLine(f: {
  tenantId: string; actorId: string; impersonated: boolean; runId: string; warehouseLines: number; vanLoads: number; salesRepId?: string | null;
}): string {
  return JSON.stringify({
    event: STOCK_ZERO_AUDIT_EVENT, tenantId: f.tenantId, actorId: f.actorId, impersonated: f.impersonated === true,
    runId: f.runId, warehouseLines: f.warehouseLines, vanLoads: f.vanLoads,
    ...(f.salesRepId && { scope: 'VAN', salesRepId: f.salesRepId }),
  });
}

/**
 * انشغالٌ من القاعدة أثناء التجميد أو الكتابة: مهلة القفل (55P03)، وتعطّلٌ متبادل (40P01)، وتعذّر التسلسل (40001)، وانقضاء
 * المعاملة أو انتظار اتصالها (P2028)، وتعارض كتابة (P2034). أخطاء التطبيق (StockZeroError) ليست انشغالاً.
 * و«تتبّع اللوط»: انشغال طابور أصناف اللوط داخل العملية (LotError LOT_BUSY من acquireLotQueue) انشغالٌ كذلك.
 */
export function isStockZeroBusy(e: unknown): boolean {
  if (e instanceof StockZeroError) return false;
  if (e instanceof LotError) return e.code === 'LOT_BUSY';
  const o = e as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown } | null | undefined;
  const code = typeof o?.code === 'string' ? o.code : '';
  const metaCode = typeof o?.meta?.code === 'string' ? o.meta.code : '';
  const msg = typeof o?.message === 'string' ? o.message : '';
  const SQL = new Set(['55P03', '40P01', '40001']);
  return code === 'P2028' || code === 'P2034' || SQL.has(code) || SQL.has(metaCode)
    || /\b55P03\b|\b40P01\b|\b40001\b|lock timeout|deadlock detected|could not serialize|Transaction already closed|expired transaction|Unable to start a transaction/i.test(msg);
}
