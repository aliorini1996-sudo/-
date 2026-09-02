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
import { weightedAvgCost, stockValue } from './warehouseCost';

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
  stockValue: number;      // قيمة الرصيد = onHand × avgCost
  uncostedQty: number;     // كمية واردة بلا سعر — حدّ صدق التقييم، تُعرَض للمستخدم
}

interface ProdMeta { id: string; name: string; code: string; unit: string }
interface WhItem { productId: string; qty: number; type: string; unitCost?: number | null } // RECEIVE | ADJUST
interface VanItem { productId: string; qty: number; type: string } // LOAD | UNLOAD | ADJUST

/** دالّة نقيّة (بلا قاعدة بيانات) — تُختبَر وحدها. تُظهر كل المنتجات المُمرَّرة. */
export function composeWarehouse(products: ProdMeta[], warehouseItems: WhItem[], vanItems: VanItem[]): WarehouseRow[] {
  const acc = new Map<string, { received: number; adjusted: number; loadedToVans: number; returnedFromVans: number }>();
  const ensure = (pid: string) => {
    if (!acc.has(pid)) acc.set(pid, { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 });
    return acc.get(pid)!;
  };
  // أسطر الوارد لكل منتج — مادّة متوسّط التكلفة (التسويات لا تدخله: جردٌ لا شراء)
  const receives = new Map<string, { qty: number; unitCost?: number | null }[]>();
  for (const it of warehouseItems) {
    const m = ensure(it.productId);
    if (it.type === 'RECEIVE') {
      m.received += it.qty;
      const list = receives.get(it.productId) || [];
      list.push({ qty: it.qty, unitCost: it.unitCost });
      receives.set(it.productId, list);
    } else m.adjusted += it.qty; // ADJUST
  }
  for (const it of vanItems) {
    if (it.type === 'LOAD') ensure(it.productId).loadedToVans += it.qty;
    else if (it.type === 'UNLOAD') ensure(it.productId).returnedFromVans += it.qty;
    // ADJUST للسيارة لا يمسّ المستودع
  }
  const rows: WarehouseRow[] = products.map((p) => {
    const m = acc.get(p.id) || { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 };
    const onHand = roundDecimal(m.received + m.adjusted + m.returnedFromVans - m.loadedToVans, 4);
    const basis = weightedAvgCost(receives.get(p.id) || []);
    return {
      productId: p.id, name: p.name, code: p.code, unit: p.unit, ...m, onHand,
      avgCost: basis.avgCost,
      stockValue: stockValue(onHand, basis.avgCost),
      uncostedQty: basis.uncostedQty,
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
      select: { productId: true, qty: true, unitCost: true, entry: { select: { type: true } } },
    }),
    prisma.vanLoadItem.findMany({
      where: { vanLoad: { tenantId: tid } },
      select: { productId: true, qty: true, vanLoad: { select: { type: true } } },
    }),
  ]);
  return composeWarehouse(
    products,
    whItems.map((i) => ({ productId: i.productId, qty: i.qty, type: i.entry.type, unitCost: i.unitCost })),
    vanItems.map((i) => ({ productId: i.productId, qty: i.qty, type: i.vanLoad.type })),
  );
}
