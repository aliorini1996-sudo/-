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
// الدوالّ الصرفة (warehouseBalancesOf، vanBalancesOf، planStockZero، previewOf، residualsOf) بلا قاعدة فتُختبر وحدها
// (tests/stock-zero.test.ts)، والموجّه routes/stockZero.ts يركّبها حول القفل والمعاملة.
// ============================================================================
import { Prisma } from '@prisma/client';
import { foldStock, type InvRow, type LoadRow } from '../routes/vanStock';
import { roundDecimal } from '../utils/helpers';
import { DAMAGED_VAN_SINCE } from './vanDamaged';
import { BASE_QTY_SQL, aggVanTotals, aggWarehouseTotals, type AggVanTotalInv, type AggVanTotalLoad, type LotDb, type WhTotalAgg } from './lotsDb';
import { roundQty, unitFields } from './units';
import { composeWarehouse, loadWarehouseInputs, summarizeVansStock, type WarehouseInputsDb } from './warehouseStock';
import { valueVanQty, type VanLayer } from './warehouseCost';

/** ملاحظة كل حركة تصفير — والوسم الحقيقي zeroRunId (النصّ يُكتب يدوياً في أي تسوية فلا يُعتمد عليه) */
export const STOCK_ZERO_NOTE = 'تصفير المخزون';
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
  STOCK_ZERO_IN_PROGRESS: 'تصفير آخر قيد التنفيذ انتظر ثم أعد المحاولة',
  // صفحة اللوط لا تصفّر رصيد التشغيلات: المستودع بتسوية نقصٍ بالتشغيلة (مخزون الشركة)، والسيارات من مخزون السيارات
  STOCK_ZERO_LOT_TRACKED: 'أصناف بتتبع اللوط لها رصيد صفر رصيد المستودع بتسوية نقص بالتشغيلة من مخزون الشركة وأزل رصيد السيارات من مخزون السيارات أولا',
  // انشغالٌ قابلٌ للإعادة: قفل صنفٍ لم يُفرج، أو كاتبٌ لا ينتظر تجميد الأصناف (إلغاء فاتورة، إعادة مخزون) التزم أثناء التصفير فبقي رصيد
  STOCK_ZERO_BUSY: 'المخزون مشغول بحركة أخرى أعد المحاولة بعد لحظات',
  // حالةٌ مستحيلة وحدها (خللٌ في الكود لا تزامن): حركات السيارات المكتوبة لا تطابق الخطة
  STOCK_ZERO_POSTCONDITION: 'تعذر التحقق من تصفير كل الأرصدة فلم يحفظ شيء أعد المحاولة',
});
export type StockZeroCode = keyof typeof STOCK_ZERO_CODES;

/** رفضٌ برمزه وحالته (ومعه بياناتٌ للواجهة كأصناف اللوط) — يترجمه الموجّه إلى ردّه */
export class StockZeroError extends Error {
  constructor(readonly status: number, readonly code: StockZeroCode, readonly data?: unknown) {
    super(STOCK_ZERO_CODES[code]);
    this.name = 'StockZeroError';
  }
}

// ═══ الأرصدة الدقيقة ═══

export interface ZeroProduct { id: string; name: string; lotTracked?: boolean | null }
/** رصيد صنفٍ في سيارة بدلائه الثلاثة (بالأساس): المتاح للبيع، والمرتجع التالف، والمنتهي — كـcomputeStock */
export interface VanBal { remaining: number; damaged: number; expired: number }
export interface ZeroBalances {
  /** صنف ⇒ رصيد المستودع */
  warehouse: Map<string, number>;
  /** مندوب قائم ⇒ صنف ⇒ رصيد سيارته */
  vans: Map<string, Map<string, VanBal>>;
  /** سيارات مناديب محذوفين بقي فيها شيء — لا تُمسّ (فواتيرهم فقدت مندوبها بالحذف فرصيدها مجهول) */
  deletedVans: number;
}

/**
 * رصيد المستودع لكل صنف = الوارد + التسويات + العائد من السيارات − المحمّل لها (composeWarehouse وwarehouseOnHandAgg)،
 * لكن بستّ منازل: warehouseOnHandAgg تقرّب بأربع (roundLot) للعرض واللوط.
 */
export function warehouseBalancesOf(rows: readonly WhTotalAgg[]): Map<string, number> {
  const acc = new Map<string, number>();
  for (const r of rows) {
    const sign = r.source === 'WH' ? 1 : r.type === 'LOAD' ? -1 : r.type === 'UNLOAD' ? 1 : 0; // تسوية السيارة لا تمسّ المستودع
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
 */
export async function loadZeroBalances(db: LotDb, tid: string, q: { productIds: string[]; repIds: string[] }): Promise<ZeroBalances> {
  const wh = await aggWarehouseTotals(db, tid, { productIds: q.productIds });
  const van = await aggVanTotals(db, tid, { vanKeys: q.repIds, productIds: q.productIds });
  const deleted = await aggDeletedVans(db, tid);
  return { warehouse: warehouseBalancesOf(wh), vans: vanBalancesOf(van.loads, van.invs), deletedVans: deletedVansOf(deleted) };
}

// ═══ الخطة ═══

export interface ZeroLine { productId: string; qty: number }
export interface VanZeroPlan {
  repId: string;
  /** الأرصدة قبل التصفير — كل صنفٍ له شيءٌ غير صفري في أي دلو (ومنه السالب المتروك) */
  products: ({ productId: string } & VanBal)[];
  /** ADJUST بسطر −المتاح (موجبٌ حين المتاح سالب) */
  adjust: ZeroLine[];
  /** DAMAGED_OUT بالتالف الموجب */
  damagedOut: ZeroLine[];
  /** EXPIRED_OUT بالمنتهي الموجب */
  expiredOut: ZeroLine[];
}
export interface StockZeroPlan {
  warehouse: { enabled: boolean; lines: { productId: string; balance: number }[] };
  vans: VanZeroPlan[];
  /** أصنافٌ متتبَّعة باللوط والميزة مفعّلة سيُكتب لها سطر — التنفيذ يرفض (رصيدها بالتشغيلات: تسوية نقصٍ بالتشغيلة في المستودع وإزالةٌ من السيارات أولاً) */
  lotBlocked: { productId: string; name: string }[];
  skipped: { deletedVans: number; negativeUnsellable: number };
  alreadyZero: boolean;
}

const nz = (x: number) => Math.abs(x) > STOCK_ZERO_EPS;

/**
 * الخطة من الأرصدة: سطرٌ لكل صنفٍ له رصيد في المستودع (والمستودع مفعّل)، ولكل سيارة ثلاث حركات بحسب الدلو.
 * التالف والمنتهي السالبان (إلغاء مرتجعٍ بعد إزالة بضاعته) لا يُكتبان: إزالةٌ بكميةٍ سالبة تُدخل بضاعةً لا وجود لها — يُعدّان.
 * الترتيب ثابت (الأصناف بترتيب `products`، والسيارات بمعرّفها) فتتطابق المعاينة والتنفيذ والاختبار.
 */
export function planStockZero(input: {
  products: readonly ZeroProduct[];
  warehouseEnabled: boolean;
  lotTrackingEnabled: boolean;
  balances: ZeroBalances;
}): StockZeroPlan {
  const { products, balances } = input;
  const lines = input.warehouseEnabled
    ? products.map((p) => ({ productId: p.id, balance: balances.warehouse.get(p.id) ?? 0 })).filter((l) => nz(l.balance))
    : [];
  const written = new Set(lines.map((l) => l.productId));
  let negativeUnsellable = 0;
  const vans: VanZeroPlan[] = [];
  for (const repId of [...balances.vans.keys()].sort()) {
    const m = balances.vans.get(repId)!;
    const plan: VanZeroPlan = { repId, products: [], adjust: [], damagedOut: [], expiredOut: [] };
    for (const p of products) {
      const b = m.get(p.id);
      if (!b || !(nz(b.remaining) || nz(b.damaged) || nz(b.expired))) continue;
      plan.products.push({ productId: p.id, remaining: b.remaining, damaged: b.damaged, expired: b.expired });
      if (nz(b.remaining)) plan.adjust.push({ productId: p.id, qty: roundQty(-b.remaining) });
      if (b.damaged > STOCK_ZERO_EPS) plan.damagedOut.push({ productId: p.id, qty: b.damaged });
      else if (nz(b.damaged)) negativeUnsellable += 1;
      if (b.expired > STOCK_ZERO_EPS) plan.expiredOut.push({ productId: p.id, qty: b.expired });
      else if (nz(b.expired)) negativeUnsellable += 1;
    }
    for (const l of [...plan.adjust, ...plan.damagedOut, ...plan.expiredOut]) written.add(l.productId);
    // وسيارةٌ ليس فيها إلا سالبٌ متروك تبقى في الملخّص بلا حركة — يرى المدقّق لماذا لم تُصفَّر
    if (plan.products.length) vans.push(plan);
  }
  const lotBlocked = input.lotTrackingEnabled
    ? products.filter((p) => p.lotTracked === true && written.has(p.id)).map((p) => ({ productId: p.id, name: p.name }))
    : [];
  const writesVans = vans.some((v) => v.adjust.length || v.damagedOut.length || v.expiredOut.length);
  return {
    warehouse: { enabled: input.warehouseEnabled, lines },
    vans,
    lotBlocked,
    skipped: { deletedVans: balances.deletedVans, negativeUnsellable },
    alreadyZero: !lines.length && !writesVans,
  };
}

/** عدد حركات السيارات التي ستُكتب */
export function vanLoadCountOf(plan: StockZeroPlan): number {
  return plan.vans.reduce((s, v) => s + (v.adjust.length ? 1 : 0) + (v.damagedOut.length ? 1 : 0) + (v.expiredOut.length ? 1 : 0), 0);
}

/**
 * شرط ما بعد التصفير: ما بقي غير صفري بعد الكتابة (فارغة = نجاح). المستودع حين يُصفَّر وحده، والسيارات بدلائها — والتالف
 * والمنتهي السالبان متروكان عمداً فلا يُعدّان بقيّة. البقيّة تعني كاتباً لا ينتظر تجميد الأصناف التزم أثناء التصفير
 * (إلغاء فاتورة أو إعادة مخزون) — الموجّه يتراجع ويردّ 503 STOCK_ZERO_BUSY لا خطأ سلامة.
 */
export function residualsOf(b: ZeroBalances, warehouseEnabled: boolean): string[] {
  const out: string[] = [];
  if (warehouseEnabled) for (const [pid, q] of b.warehouse) if (Math.abs(q) > STOCK_ZERO_POST_EPS) out.push(`WH:${pid}:${q}`);
  for (const [repId, m] of b.vans) {
    for (const [pid, v] of m) {
      if (Math.abs(v.remaining) > STOCK_ZERO_POST_EPS) out.push(`VAN:${repId}:${pid}:remaining:${v.remaining}`);
      if (v.damaged > STOCK_ZERO_POST_EPS) out.push(`VAN:${repId}:${pid}:damaged:${v.damaged}`);
      if (v.expired > STOCK_ZERO_POST_EPS) out.push(`VAN:${repId}:${pid}:expired:${v.expired}`);
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

/** ملخّص التشغيلة (StockZeroRun.summary): الأرصدة قبل التصفير لكل نطاق وصنف، والإجماليات، وما تُرك ولماذا */
export function runSummaryOf(plan: StockZeroPlan, val: StockZeroValuation, totals: StockZeroTotals) {
  return {
    warehouse: plan.warehouse.lines.map((l) => ({ productId: l.productId, qty: l.balance, value: val.warehouse.get(l.productId)?.stockValue ?? 0 })),
    vans: plan.vans.map((v) => ({
      repId: v.repId,
      products: v.products.map((p) => ({
        ...p,
        // قيمة المتاح الموجب بطبقات سيارته (valueVanQty) — كبطاقة «في مخزون السيارات»
        value: roundDecimal(valueVanQty(val.layers.get(p.productId)?.get(v.repId), p.remaining, val.avgCost.get(p.productId) ?? 0).value, val.decimals),
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

export type StockZeroWriteTx = Pick<Prisma.TransactionClient, 'warehouseEntry' | 'warehouseEntryItem' | 'vanLoad' | 'vanLoadItem'>;

/**
 * حركات التصفير: تسوية مستودع واحدة (ADJUST) بسطر −الرصيد لكل صنف، ولكل سيارة ADJUST/DAMAGED_OUT/EXPIRED_OUT بحسب الدلو.
 * كل الأسطر بوحدة الأساس (unitFields بلا وحدة: معامل ١ وbaseQty = الكمية) وبلا تكلفة: التسوية جردٌ لا شراء.
 * الرأس ثم أسطره بـcreateMany — ألف صنفٍ إدراجٌ واحد لا ألف.
 */
export async function writeStockZero(tx: StockZeroWriteTx, a: { tenantId: string; runId: string; plan: StockZeroPlan; createdBy: string }): Promise<{ entryId: string | null; vanLoads: number }> {
  let entryId: string | null = null;
  if (a.plan.warehouse.enabled && a.plan.warehouse.lines.length) {
    const entry = await tx.warehouseEntry.create({
      data: { tenantId: a.tenantId, type: 'ADJUST', note: STOCK_ZERO_NOTE, createdBy: a.createdBy, zeroRunId: a.runId },
      select: { id: true },
    });
    entryId = entry.id;
    await tx.warehouseEntryItem.createMany({
      data: a.plan.warehouse.lines.map((l) => ({ entryId: entry.id, productId: l.productId, ...unitFields(roundQty(-l.balance)) })),
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
      await tx.vanLoadItem.createMany({ data: lines.map((l) => ({ vanLoadId: load.id, productId: l.productId, ...unitFields(l.qty) })) });
      vanLoads += 1;
    }
  }
  return { entryId, vanLoads };
}

/** سطر التدقيق بعد الالتزام — معرّفات وأعداد فقط */
export function stockZeroAuditLine(f: { tenantId: string; actorId: string; impersonated: boolean; runId: string; warehouseLines: number; vanLoads: number }): string {
  return JSON.stringify({
    event: STOCK_ZERO_AUDIT_EVENT, tenantId: f.tenantId, actorId: f.actorId, impersonated: f.impersonated === true,
    runId: f.runId, warehouseLines: f.warehouseLines, vanLoads: f.vanLoads,
  });
}

/**
 * انشغالٌ من القاعدة أثناء التجميد أو الكتابة: مهلة القفل (55P03)، وتعطّلٌ متبادل (40P01)، وتعذّر التسلسل (40001)، وانقضاء
 * المعاملة أو انتظار اتصالها (P2028)، وتعارض كتابة (P2034). أخطاء التطبيق (StockZeroError) ليست انشغالاً.
 */
export function isStockZeroBusy(e: unknown): boolean {
  if (e instanceof StockZeroError) return false;
  const o = e as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown } | null | undefined;
  const code = typeof o?.code === 'string' ? o.code : '';
  const metaCode = typeof o?.meta?.code === 'string' ? o.meta.code : '';
  const msg = typeof o?.message === 'string' ? o.message : '';
  const SQL = new Set(['55P03', '40P01', '40001']);
  return code === 'P2028' || code === 'P2034' || SQL.has(code) || SQL.has(metaCode)
    || /\b55P03\b|\b40P01\b|\b40001\b|lock timeout|deadlock detected|could not serialize|Transaction already closed|expired transaction|Unable to start a transaction/i.test(msg);
}
