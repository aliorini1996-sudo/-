/**
 * محرّك حساب الفاتورة (نسخة العميل) — **يجب أن يطابق حرفياً** backend/src/lib/invoiceCalc.ts.
 *
 * لماذا نسخة على العميل: في العمل دون اتصال يطبع المندوب الفاتورة (إجمالي/ضريبة/QR) محلياً،
 * ثم يعيد الخادم الحساب عند الرفع. إن اختلفت الصيغتان بأي كسر خالفت الورقة سجلَّ الخادم.
 *
 * ⚠️ لا تعدّل هنا وحدك: أي تغيير يجب أن يُطبَّق على النسخة الخادمية أيضاً، وأن تمرّ المتجهات
 * الذهبية في backend/src/tests/invoice-calc.test.ts. المنطق نقيّ (بلا DOM/تبعيات).
 */

export function roundDecimal(value: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

export interface CalcItemInput {
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct?: number;
}

export interface CalcItemResult {
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  discountAmt: number;
  taxAmt: number;
  lineTotal: number;
}

export interface CalcOptions {
  companyVat: number;
  decimals: number;
  invoiceDiscountPct: number;
}

export interface CalcResult {
  items: CalcItemResult[];
  subtotal: number;
  discountAmt: number;
  taxAmt: number;
  total: number;
}

export function computeInvoiceTotals(rawItems: CalcItemInput[], opts: CalcOptions): CalcResult {
  const { companyVat, decimals: dec, invoiceDiscountPct } = opts;

  let subtotal = 0;
  const items: CalcItemResult[] = rawItems.map((item) => {
    const lineBase = roundDecimal(item.qty * item.unitPrice, dec);
    const lineDiscount = roundDecimal((lineBase * item.discountPct) / 100, dec);
    const lineAfterDiscount = lineBase - lineDiscount;
    const itemTaxPct = item.taxPct ?? companyVat;
    const lineTax = roundDecimal((lineAfterDiscount * itemTaxPct) / 100, dec);
    const lineTotal = lineAfterDiscount + lineTax;
    subtotal += lineBase;
    return {
      qty: item.qty,
      unitPrice: item.unitPrice,
      discountPct: item.discountPct,
      taxPct: itemTaxPct,
      discountAmt: lineDiscount,
      taxAmt: lineTax,
      lineTotal,
    };
  });

  const discountAmt = roundDecimal((subtotal * invoiceDiscountPct) / 100, dec);
  const taxableSubtotal = subtotal - discountAmt;
  let taxAmt = 0;
  for (const it of items) taxAmt += it.taxAmt;
  const total = roundDecimal(taxableSubtotal + taxAmt, dec);

  return { items, subtotal, discountAmt, taxAmt, total };
}
