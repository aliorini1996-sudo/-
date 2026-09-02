// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// ----------------------------------------------------------------------------
// الرصيد لكل منتج =
//     الوارد (RECEIVE) + تسويات المستودع (ADJUST)
//   + العائد من السيارات (VanLoad UNLOAD)
//   − المحمّل للسيارات   (VanLoad LOAD)
// تسوية السيارة (VanLoad ADJUST) حركةٌ داخل السيارة لا تمسّ المستودع.
// ============================================================================
import prisma from '../config/database';
import { roundDecimal } from '../utils/helpers';
import { valueStock, CostMove } from './warehouseCost';

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
interface VanItem { productId: string; qty: number; type: string; at?: Date | string | number }

/** دالّة نقيّة (بلا قاعدة بيانات) — تُختبَر وحدها. تُظهر كل المنتجات المُمرَّرة. */
export function composeWarehouse(products: ProdMeta[], warehouseItems: WhItem[], vanItems: VanItem[]): WarehouseRow[] {
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
      push(it.productId, { qty: -it.qty, kind: 'OTHER' }, it.at); // خروجٌ من المستودع
    } else if (it.type === 'UNLOAD') {
      ensure(it.productId).returnedFromVans += it.qty;
      push(it.productId, { qty: it.qty, kind: 'OTHER' }, it.at);  // عودةٌ إليه
    }
    // ADJUST للسيارة لا يمسّ المستودع
  }
  const rows: WarehouseRow[] = products.map((p) => {
    const m = acc.get(p.id) || { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 };
    const onHand = roundDecimal(m.received + m.adjusted + m.returnedFromVans - m.loadedToVans, 4);
    // الترتيب زمنيّ، وعند تساوي اللحظة يُحفظ ترتيب الورود (فرزٌ مستقرّ)
    const mv = (moves.get(p.id) || []).slice().sort((x, y) => x.t - y.t || x.i - y.i);
    const val = valueStock(mv);
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

/** غلاف قاعدة البيانات: يجمع منتجات الشركة ووارد المستودع وحركات السيارات ثم يحسب. */
export async function computeWarehouseStock(tid: string): Promise<WarehouseRow[]> {
  const [products, whItems, vanItems] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId: tid, status: { not: 'INACTIVE' } },
      select: { id: true, name: true, code: true, unit: true },
    }),
    prisma.warehouseEntryItem.findMany({
      where: { entry: { tenantId: tid } },
      select: { productId: true, qty: true, unitCost: true, entry: { select: { type: true, createdAt: true } } },
    }),
    prisma.vanLoadItem.findMany({
      where: { vanLoad: { tenantId: tid } },
      select: { productId: true, qty: true, vanLoad: { select: { type: true, createdAt: true } } },
    }),
  ]);
  return composeWarehouse(
    products,
    whItems.map((i) => ({ productId: i.productId, qty: i.qty, type: i.entry.type, unitCost: i.unitCost, at: i.entry.createdAt })),
    vanItems.map((i) => ({ productId: i.productId, qty: i.qty, type: i.vanLoad.type, at: i.vanLoad.createdAt })),
  );
}
