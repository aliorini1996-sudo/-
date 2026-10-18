// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// ----------------------------------------------------------------------------
// الرصيد لكل منتج =
//     الوارد (RECEIVE) + تسويات المستودع (ADJUST)
//   + العائد من السيارات (VanLoad UNLOAD)
//   − المحمّل للسيارات   (VanLoad LOAD)
// تسوية السيارة (VanLoad ADJUST) حركةٌ داخل السيارة لا تمسّ المستودع.
// والعائد يدخل بالكلفة التي خرج بها لا بمتوسّط لحظة عودته، وبكلفة **سيارته هو**
// لا كلفة حمولة زميله — انظر `valueStock`.
// ============================================================================
import prisma from '../config/database';
import { currencyDecimalsOf } from '../config/countries';
import { roundDecimal } from '../utils/helpers';
import { valueStock, valueVanQty, CostMove, VanLayer, DEFAULT_CURRENCY_DECIMALS } from './warehouseCost';

export interface WarehouseRow {
  productId: string;
  name: string;
  code: string;
  unit: string;
  received: number;        // الوارد للمستودع
  adjusted: number;        // تسويات المستودع (+/−)
  loadedToVans: number;    // خرج للسيارات
  returnedFromVans: number; // عاد من السيارات (UNLOAD)
  onHand: number;          // الرصيد المتبقّي في المستودع
  // ═══ التقييم بتكلفة الشراء ═══
  avgCost: number;         // متوسّط تكلفة الوحدة المرجّح (من الوارد المسعّر وحده)
  stockValue: number;      // قيمة الرصيد = الكمّية المقيَّمة × متوسّطها
  costedQty: number;       // كمية من الرصيد تكلفتها معروفة (هي وحدها المقيَّمة)
  uncostedQty: number;     // كمية من الرصيد بلا تكلفة معروفة — خارج القيمة صراحةً
}

interface ProdMeta { id: string; name: string; code: string; unit: string }
// `at` لحظة الحركة — التقييم متوسّطٌ متحرّك فترتيبه الزمنيّ جزءٌ من صحّته:
// المرور غير المرتَّب يعطي متوسّطاً خاطئاً بصمت. اختياريّ لتبقى الاختبارات
// النقيّة تمرّر ترتيبها بترتيب المصفوفة.
interface WhItem { productId: string; qty: number; type: string; unitCost?: number | null; at?: Date | string | number }
interface VanItem { productId: string; qty: number; type: string; salesRepId?: string | null; at?: Date | string | number }

/**
 * مفتاح «السيارة» لحركة تحميل: مندوبها، أو معرّفه المحفوظ بعد حذفه.
 *
 * حذف المندوب يُفرّغ `salesRepId` ولا يمحو الحركة (الحذف كان يمحوها فيقفز
 * المستودع بكل ما حُمِّل وبيع). والكمّية لا تحتاج المفتاح أصلاً — LOAD وUNLOAD
 * يُحسبان أيّاً كان مندوبهما — لكن **التقييم** يحتاجه: طبقات كل سيارة مكدّسٌ
 * مستقلّ، ومندوبان محذوفان بلا مفتاح يقعان في مكدّسٍ واحد فيعود تنزيلُ أحدهما
 * بكلفة حمولة الآخر وتتغيّر قيمة المستودع بمجرّد الحذف.
 */
export function vanKeyOf(l: { salesRepId: string | null; deletedSalesRepId?: string | null }): string | null {
  return l.salesRepId ?? l.deletedSalesRepId ?? null;
}

/**
 * دالّة نقيّة (بلا قاعدة بيانات) — تُختبَر وحدها. تُظهر كل المنتجات المُمرَّرة.
 *
 * @param decimals خانات عملة الشركة لتقريب **قيمة الرصيد** لكل صنف. اختياريّ
 *   بافتراض خانتين كي لا ينكسر مستدعٍ لم يُحدَّث، لكنّ كل مستدعٍ إنتاجيّ يمرّرها:
 *   شركةٌ بالدينار (ثلاث خانات) كانت تفقد الخانة الثالثة في **كل صنف** — ألفُ
 *   صنفٍ بقيمة ٠٫١٢٣٥ تعطي ١٢٠ بخانتين و١٢٤ بثلاث، وأربعةُ دنانير تضيع من
 *   القيد الافتتاحيّ وشاشة المخزون معاً. والرقم يأتي من خانات عملة الشركة
 *   (`tenantCurrencyDecimals` أدناه) لا من تخمين.
 */
export function composeWarehouse(
  products: ProdMeta[],
  warehouseItems: WhItem[],
  vanItems: VanItem[],
  decimals: number = DEFAULT_CURRENCY_DECIMALS,
  /** يُملأ بطبقات كل سيارة لكل صنف (صنف ← سيارة ← طبقات) — لتقييم ما في السيارات */
  layersOut?: Map<string, Map<string, VanLayer[]>>,
): WarehouseRow[] {
  const acc = new Map<string, { received: number; adjusted: number; loadedToVans: number; returnedFromVans: number }>();
  const ensure = (pid: string) => {
    if (!acc.has(pid)) acc.set(pid, { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 });
    return acc.get(pid)!;
  };
  // حركات التقييم لكل منتج، بإشارتها الصحيحة (موجب يدخل، سالب يخرج).
  // تُجمع من المصدرين معاً ثم تُرتَّب زمنياً — انظر `valueStock`.
  const moves = new Map<string, (CostMove & { t: number; i: number })[]>();
  let seq = 0;
  const ms = (v?: Date | string | number) => {
    if (v == null) return 0;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const push = (pid: string, mv: CostMove, at?: Date | string | number) => {
    const list = moves.get(pid) || [];
    list.push({ ...mv, t: ms(at), i: seq++ });
    moves.set(pid, list);
  };

  for (const it of warehouseItems) {
    const m = ensure(it.productId);
    if (it.type === 'RECEIVE') {
      m.received += it.qty;
      push(it.productId, { qty: it.qty, kind: 'RECEIVE', unitCost: it.unitCost }, it.at);
    } else {
      m.adjusted += it.qty; // ADJUST — جردٌ أو تالف، بلا ثمن
      push(it.productId, { qty: it.qty, kind: 'OTHER' }, it.at);
    }
  }
  for (const it of vanItems) {
    if (it.type === 'LOAD') {
      ensure(it.productId).loadedToVans += it.qty;
      push(it.productId, { qty: -it.qty, kind: 'VAN_OUT', vanId: it.salesRepId }, it.at); // خروجٌ بكلفة اللحظة
    } else if (it.type === 'UNLOAD') {
      ensure(it.productId).returnedFromVans += it.qty;
      push(it.productId, { qty: it.qty, kind: 'VAN_IN', vanId: it.salesRepId }, it.at);  // عودةٌ بكلفة خروجها
    }
    // ADJUST للسيارة لا يمسّ المستودع
  }
  const rows: WarehouseRow[] = products.map((p) => {
    const m = acc.get(p.id) || { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 };
    const onHand = roundDecimal(m.received + m.adjusted + m.returnedFromVans - m.loadedToVans, 4);
    // الترتيب زمنيّ، وعند تساوي اللحظة يُحفظ ترتيب الورود (فرزٌ مستقرّ)
    const mv = (moves.get(p.id) || []).slice().sort((x, y) => x.t - y.t || x.i - y.i);
    const out: { vanLayers?: Map<string, VanLayer[]> } | undefined = layersOut ? {} : undefined;
    const val = valueStock(mv, decimals, out);
    if (layersOut && out?.vanLayers) layersOut.set(p.id, out.vanLayers);
    return {
      productId: p.id, name: p.name, code: p.code, unit: p.unit, ...m, onHand,
      avgCost: val.avgCost,
      stockValue: val.stockValue,
      costedQty: val.costedQty,
      uncostedQty: val.uncostedQty,
    };
  });
  rows.sort((a, b) => b.onHand - a.onHand);
  return rows;
}

/** أقصى خانات عملة تقبلها الدفاتر (services/gl/money.ts) — ما جاوزها إعدادٌ فاسد */
const MAX_LEDGER_DECIMALS = 3;

/**
 * خانات عملة الشركة من **مصدرها الحقيقيّ**، بنفس أسبقية `importLedgerContext`
 * في `routes/import.ts`: خانات الدفاتر إن كانت مضبوطةً وصالحة، وإلّا فمن عملة
 * الشركة عبر `currencyDecimalsOf` (ثلاثٌ للدينار الكويتيّ والبحرينيّ والعمانيّ
 * والأردنيّ، وصفرٌ للدينار العراقيّ، وخانتان للريال).
 *
 * تُقرأ **مرّة واحدة لكل طلب** ثم تُمرَّر إلى الحساب: لا داخل حلقة الأصناف، ولا
 * داخل معاملةٍ تمسك قفل `gl-post` — فالقيد الافتتاحيّ يأخذ خاناته من
 * `opts.decimals` المقروءة قبل المعاملة (`services/gl/opening.ts`) لا من هنا.
 */
export async function tenantCurrencyDecimals(tid: string): Promise<number> {
  const s = await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { currencyDecimals: true } });
  const d = s?.currencyDecimals;
  if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= MAX_LEDGER_DECIMALS) return d;
  const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { currency: true } });
  return currencyDecimalsOf(company?.currency);
}

/**
 * غلاف قاعدة البيانات: يجمع منتجات الشركة ووارد المستودع وحركات السيارات ثم يحسب.
 *
 * @param decimals خانات العملة حين يكون المسار قد قرأها أصلاً. وحين تُترك،
 *   تُقرأ هنا مرّةً واحدة ضمن نفس دفعة القراءات (لا استعلامٌ إضافيّ متسلسل).
 *   و`??` لا `||` عمداً: صفرُ خاناتٍ عملةٌ صحيحة (الدينار العراقيّ) لا غياب.
 */
export async function computeWarehouseStock(tid: string, decimals?: number): Promise<WarehouseRow[]> {
  const [dec, { products, whItems, vanItems }] = await Promise.all([
    decimals ?? tenantCurrencyDecimals(tid),
    loadWarehouseInputs(tid),
  ]);
  return composeWarehouse(products, whItems, vanItems, dec);
}

/**
 * مدخلات تقييم المستودع للشركة: الأصناف وحركات المستودع وحركات السيارات (كل الأنواع — composeWarehouse يأخذ LOAD وUNLOAD،
 * وطيّ رصيد السيارة يأخذ الباقي). `includeInactive`: الأصناف المعطّلة أيضاً — بضاعتها قد تبقى في السيارات.
 */
export async function loadWarehouseInputs(tid: string, opts: { includeInactive?: boolean } = {}): Promise<{
  products: ProdMeta[];
  whItems: WhItem[];
  vanItems: (VanItem & { at: Date })[];
}> {
  const [products, whItems, vanItems] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId: tid, ...(!opts.includeInactive && { status: { not: 'INACTIVE' } }) },
      select: { id: true, name: true, code: true, unit: true },
    }),
    prisma.warehouseEntryItem.findMany({
      where: { entry: { tenantId: tid } },
      select: { productId: true, qty: true, unitCost: true, entry: { select: { type: true, createdAt: true } } },
    }),
    prisma.vanLoadItem.findMany({
      // تحميلات المناديب المحذوفين داخلة عمداً (salesRepId فارغ): خرجت من المستودع فعلاً
      where: { vanLoad: { tenantId: tid } },
      select: { productId: true, qty: true, vanLoad: { select: { type: true, createdAt: true, salesRepId: true, deletedSalesRepId: true } } },
    }),
  ]);
  return {
    products,
    whItems: whItems.map((i) => ({ productId: i.productId, qty: i.qty, type: i.entry.type, unitCost: i.unitCost, at: i.entry.createdAt })),
    vanItems: vanItems.map((i) => ({ productId: i.productId, qty: i.qty, type: i.vanLoad.type, salesRepId: vanKeyOf(i.vanLoad), at: i.vanLoad.createdAt })),
  };
}

/** ما في السيارات بتكلفة الشراء — بطاقة «في مخزون السيارات» في صفحة مخزون الشركة */
export interface VansStockSummary {
  qty: number;           // الرصيد المتاح للبيع في كل السيارات (الموجب وحده)
  value: number;         // قيمته بكلفة خروجه من المستودع
  uncostedQty: number;   // منه كمية بلا تكلفة معروفة — خارج القيمة صراحةً
  unsellableQty: number; // تالفٌ ومنتهٍ في السيارات لا يُباع — خارج الرصيد والقيمة
  reps: number;          // سيارات فيها بضاعة
  products: number;      // أصنافٌ في سيارةٍ واحدة على الأقل
}

/**
 * دالّة نقيّة: رصيد كل سيارة (من طيّ حركاتها كمسار مخزون السيارات) مقيَّماً بطبقاتها (valueVanQty)، وبمتوسّط المستودع لما
 * زاد عليها. الرصيد السالب (بيعٌ بلا مخزون) ليس بضاعة فلا يُنقص غيره.
 */
export function summarizeVansStock(
  perRep: { repId: string; products: { productId: string; remaining: number; unsellable: number }[] }[],
  layers: ReadonlyMap<string, ReadonlyMap<string, VanLayer[]>>,
  avgCost: ReadonlyMap<string, number>,
  decimals: number = DEFAULT_CURRENCY_DECIMALS,
): VansStockSummary {
  let qty = 0, value = 0, uncostedQty = 0, unsellableQty = 0, reps = 0;
  const products = new Set<string>();
  for (const r of perRep) {
    let has = false;
    for (const p of r.products) {
      if (p.unsellable > 0) unsellableQty += p.unsellable;
      if (!(p.remaining > 1e-9)) continue;
      has = true;
      products.add(p.productId);
      qty += p.remaining;
      const v = valueVanQty(layers.get(p.productId)?.get(r.repId), p.remaining, avgCost.get(p.productId) ?? 0);
      value += v.value;
      uncostedQty += v.uncostedQty;
    }
    if (has) reps += 1;
  }
  return {
    qty: roundDecimal(qty, 4),
    value: roundDecimal(value, decimals),
    uncostedQty: roundDecimal(uncostedQty, 4),
    unsellableQty: roundDecimal(unsellableQty, 4),
    reps,
    products: products.size,
  };
}
