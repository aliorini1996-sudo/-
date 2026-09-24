/**
 * تجميع سندات القبض على المناديب — لتقرير «التحصيل حسب المندوب».
 *
 * هنا لا في المكوّن: المنطق ماليّ (مجاميع تُقارَن ببطاقة الإجمالي فوقها)
 * وحالاتُ حافّته تُختبَر بالقيم — سندٌ بلا مندوب، ومبلغٌ يصل نصّاً من JSON،
 * وترتيبٌ يجب ألّا يزحزح دلو «بلا مندوب» عن آخر الجدول.
 */

export interface CollReceiptLike {
  id: string;
  receiptNumber: string;
  amount: number | string;
  paymentMethod: string;
  receiptDate: string;
  customer: { id: string; name: string } | null;
  salesRep: { id: string; name: string } | null;
}

export interface CollRepGroup<R> {
  /** معرّف المندوب، أو `NO_REP` لدلو «بلا مندوب». */
  id: string;
  /** اسمه كما ورد، وفارغٌ لدلو «بلا مندوب» — تُرجمه الواجهة عند العرض. */
  name: string;
  count: number;
  total: number;
  byMethod: Record<string, number>;
  receipts: R[];
}

/**
 * دلو السندات التي لا مندوب لها.
 *
 * وليس حالةً نادرة: `Receipt.salesRepId` اختياريّ (سندٌ يصدره إداريّ من
 * اللوحة)، و`onDelete: SetNull` يُفرغه حين يُحذف المندوب. فإسقاطه يعني اختفاء
 * مالٍ محصَّل من التقرير، ومجموعَ أعمدةٍ لا يطابق البطاقة فوقه.
 */
export const NO_REP = '__none__';

export function groupCollectionsByRep<R extends CollReceiptLike>(receipts: R[] | undefined | null): CollRepGroup<R>[] {
  if (!Array.isArray(receipts)) return [];
  const map = new Map<string, CollRepGroup<R>>();
  for (const r of receipts) {
    const id = r.salesRep?.id || NO_REP;
    let row = map.get(id);
    if (!row) {
      row = { id, name: (id === NO_REP ? '' : r.salesRep?.name || ''), count: 0, total: 0, byMethod: {}, receipts: [] };
      map.set(id, row);
    }
    // `Number(...)` لا `+`: المبلغ قد يصل نصّاً من JSON، و`NaN` يسمّم المجموع كلّه
    const amt = Number(r.amount);
    const safe = Number.isFinite(amt) ? amt : 0;
    row.count += 1;
    row.total += safe;
    row.byMethod[r.paymentMethod] = (row.byMethod[r.paymentMethod] ?? 0) + safe;
    row.receipts.push(r);
  }
  // الأكبر تحصيلاً أوّلاً، ودلو «بلا مندوب» آخراً مهما كان مبلغه — ليس مندوباً يُقارَن
  return [...map.values()].sort((a, b) => (a.id === NO_REP ? 1 : b.id === NO_REP ? -1 : b.total - a.total));
}

/** مجاميع الصفوف المعروضة — تُعرض تحت البطاقة فيُكشف أيّ سقوطٍ في التجميع. */
export function collectionTotals<R>(rows: CollRepGroup<R>[]): { total: number; count: number } {
  return {
    // تقريبٌ على ستّ منازل كبقيّة مجاميع المنصّة: يحجب غبار العائمة ولا يمسّ هللة
    total: Math.round(rows.reduce((t, r) => t + r.total, 0) * 1e6) / 1e6,
    count: rows.reduce((t, r) => t + r.count, 0),
  };
}
