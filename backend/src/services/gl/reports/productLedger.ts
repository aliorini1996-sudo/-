/**
 * «ربط الدفاتر» L8 — تقرير الأصناف من الدفاتر (عقد §6.2). **صرف تماماً**.
 *
 * المصدر: سطور حسابات الإيراد (type income) ذات `productId` — متاحة بعد L4 (ج) للمربوطة: الإيراد لكل صنف بكميته
 * (Σ baseQty)، والخصم لكل صنف، والمرتجع لكل صنف.
 *
 * التصنيف (لكل سطر، بقاعدة R6 فيبقى Σ net = (411001 + فئات) − 412001 − 413001 على السطور ذات الصنف):
 * - حساب الخصم (مفتاح SALES_DISCOUNT): discount += مدين − دائن (خصم مرتجعٍ يُنقصه).
 * - حساب المردودات (SALES_RETURNS) أو قيد مرتجع (OUT_REFUND، ومنه عكسه): returns += مدين − دائن، والكمية المرتجعة
 *   = كمية المدين − كمية الدائن (عكس المرتجع يعيدها).
 * - غير ذلك: revenue += دائن − مدين، والكمية المباعة = كمية الدائن − كمية المدين (إلغاء الفاتورة يعيدها).
 * - net = revenue − discount − returns، وquantity = المباعة − المرتجعة.
 */
import { fromMilli } from '../money';
import type { Milli } from '../types';

export interface ProductLedgerLineInput {
  productId: string;
  accountId: string;
  /** القيد من نوع OUT_REFUND (مرتجع أو عكسه) */
  isReturnMove: boolean;
  debitMilli: Milli;
  creditMilli: Milli;
  /** Σ الكمية على السطور الدائنة / المدينة (مجمّعة أو لسطر واحد) */
  creditQuantity: number;
  debitQuantity: number;
}

export interface ProductLedgerRow {
  productId: string;
  productName: string | null;
  quantity: number;
  soldQuantity: number;
  returnedQuantity: number;
  revenueMilli: Milli;
  discountMilli: Milli;
  returnsMilli: Milli;
  netMilli: Milli;
}

export interface ProductLedger {
  rows: ProductLedgerRow[];
  totals: Omit<ProductLedgerRow, 'productId' | 'productName'>;
}

/** جمع كميات عشرية بلا غبار طفو (أربع منازل كمنازل التكلفة) */
const addQty = (a: number, b: number): number => Math.round((a + b) * 10_000) / 10_000;

export function buildProductLedger(input: {
  lines: readonly ProductLedgerLineInput[];
  discountAccountIds: ReadonlySet<string>;
  returnsAccountIds: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
}): ProductLedger {
  const by = new Map<string, ProductLedgerRow>();
  for (const l of input.lines) {
    let r = by.get(l.productId);
    if (!r) {
      r = {
        productId: l.productId, productName: input.names.get(l.productId) ?? null, quantity: 0, soldQuantity: 0,
        returnedQuantity: 0, revenueMilli: 0n, discountMilli: 0n, returnsMilli: 0n, netMilli: 0n,
      };
      by.set(l.productId, r);
    }
    if (input.discountAccountIds.has(l.accountId)) {
      r.discountMilli += l.debitMilli - l.creditMilli;
    } else if (input.returnsAccountIds.has(l.accountId) || l.isReturnMove) {
      r.returnsMilli += l.debitMilli - l.creditMilli;
      r.returnedQuantity = addQty(r.returnedQuantity, l.debitQuantity - l.creditQuantity);
    } else {
      r.revenueMilli += l.creditMilli - l.debitMilli;
      r.soldQuantity = addQty(r.soldQuantity, l.creditQuantity - l.debitQuantity);
    }
  }
  const rows = [...by.values()].map((r) => ({
    ...r,
    netMilli: r.revenueMilli - r.discountMilli - r.returnsMilli,
    quantity: addQty(r.soldQuantity, -r.returnedQuantity),
  }));
  // الأعلى صافياً أولاً، ثم الاسم ثم المعرّف (حتمي)
  rows.sort((a, b) => {
    if (a.netMilli !== b.netMilli) return b.netMilli > a.netMilli ? 1 : -1;
    const na = a.productName ?? '';
    const nb = b.productName ?? '';
    if (na !== nb) return na < nb ? -1 : 1;
    return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
  });
  const totals: ProductLedger['totals'] = {
    quantity: 0, soldQuantity: 0, returnedQuantity: 0, revenueMilli: 0n, discountMilli: 0n, returnsMilli: 0n, netMilli: 0n,
  };
  for (const r of rows) {
    totals.quantity = addQty(totals.quantity, r.quantity);
    totals.soldQuantity = addQty(totals.soldQuantity, r.soldQuantity);
    totals.returnedQuantity = addQty(totals.returnedQuantity, r.returnedQuantity);
    totals.revenueMilli += r.revenueMilli;
    totals.discountMilli += r.discountMilli;
    totals.returnsMilli += r.returnsMilli;
    totals.netMilli += r.netMilli;
  }
  return { rows, totals };
}

const rowJson = (r: Omit<ProductLedgerRow, 'productId' | 'productName'>) => ({
  quantity: r.quantity, soldQuantity: r.soldQuantity, returnedQuantity: r.returnedQuantity,
  revenue: fromMilli(r.revenueMilli), discount: fromMilli(r.discountMilli), returns: fromMilli(r.returnsMilli), net: fromMilli(r.netMilli),
});

export function serializeProductLedger(p: ProductLedger): Record<string, unknown> {
  return {
    rows: p.rows.map((r) => ({ productId: r.productId, productName: r.productName, ...rowJson(r) })),
    totals: rowJson(p.totals),
  };
}
