/**
 * حساب بنود الفاتورة في مسار **الإدارة** — منقول حرفياً عن `calcLine` في
 * `components/forms/InvoiceModal.tsx` كي يُعرض على الجوال ما يُعرض على اللوحة.
 *
 * ⚠️ **الفخّ الحاكم — لا تنسخ منطق تطبيق المندوب هنا:**
 * مسار الأدمن (`POST /invoices`) يتوقّع `unitPrice` **قبل الضريبة** ومعه
 * `taxPct` منفصلاً — والسعر يأتي من `product.basePrice` وهو صافٍ. أمّا شاشة
 * المندوب فتُدخِل سعراً **شاملاً** وتشتقّ ما قبله. فنسخُ غلاف المندوب إلى هنا
 * يُنتج فواتير بمبالغ خاطئة تمرّ بلا خطأ ولا تحذير.
 *
 * والخادم هو المرجع النهائي للمبالغ؛ هذه الدوالّ للعرض اللحظيّ فقط.
 */

export interface Line {
  productId: string; name: string; unit: string;
  qty: number; unitPrice: number; discountPct: number; taxPct: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** إجمالي البند شاملاً ضريبته بعد خصمه */
export function lineTotal(l: Pick<Line, 'qty' | 'unitPrice' | 'discountPct' | 'taxPct'>): number {
  const base = l.qty * l.unitPrice;
  const afterDisc = base - (base * l.discountPct) / 100;
  return r2(afterDisc + (afterDisc * l.taxPct) / 100);
}

/** ملخّص الفاتورة — بنفس صيغة نافذة اللوحة، فلا يختلف رقمان لمستند واحد */
export function invoiceTotals(lines: Line[], invoiceDiscountPct: number) {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const lineDiscount = lines.reduce((s, l) => s + (l.qty * l.unitPrice * l.discountPct) / 100, 0);
  const headDiscount = (subtotal * invoiceDiscountPct) / 100;
  const tax = lines.reduce(
    (s, l) => s + (l.qty * l.unitPrice * (1 - l.discountPct / 100) * l.taxPct) / 100,
    0,
  );
  const discount = lineDiscount + headDiscount;
  return {
    subtotal: r2(subtotal),
    discount: r2(discount),
    tax: r2(tax),
    total: r2(subtotal - discount + tax),
  };
}
