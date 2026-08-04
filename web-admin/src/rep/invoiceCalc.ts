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

/**
 * ⚠️ **نسخة مطابقة حرفياً** لـbackend/src/lib/invoiceCalc.ts — أي تعديل هنا
 * يجب أن يقع هناك في اللحظة نفسها، وإلّا خالفت الورقةُ المطبوعة السجلَّ.
 * والمتجهات الذهبية في backend/src/tests/invoice-calc.test.ts هي العقد بينهما.
 */
export function computeInvoiceTotals(rawItems: CalcItemInput[], opts: CalcOptions): CalcResult {
  const { companyVat, decimals: dec, invoiceDiscountPct } = opts;
  const headFactor = 1 - invoiceDiscountPct / 100; // حصّة البند بعد خصم الفاتورة

  let subtotal = 0;      // مجموع الأساس قبل أي خصم (يُعرض «الإجمالي قبل الخصم»)
  let discountAmt = 0;   // خصم البنود + خصم الفاتورة الموزَّع
  let taxAmt = 0;

  const items: CalcItemResult[] = rawItems.map((item) => {
    const lineBase = roundDecimal(item.qty * item.unitPrice, dec);
    const lineDiscount = roundDecimal((lineBase * item.discountPct) / 100, dec);
    const lineAfterDiscount = lineBase - lineDiscount;

    // حصّة هذا البند من خصم الفاتورة الكلّي — تُخصم قبل الضريبة لا بعدها
    const headShare = roundDecimal(lineAfterDiscount * (1 - headFactor), dec);
    const lineNet = lineAfterDiscount - headShare;

    const itemTaxPct = item.taxPct ?? companyVat;
    const lineTax = roundDecimal((lineNet * itemTaxPct) / 100, dec);
    const lineTotal = roundDecimal(lineNet + lineTax, dec);

    subtotal += lineBase;
    discountAmt += lineDiscount + headShare;
    taxAmt += lineTax;

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

  subtotal = roundDecimal(subtotal, dec);
  discountAmt = roundDecimal(discountAmt, dec);
  taxAmt = roundDecimal(taxAmt, dec);
  const total = roundDecimal(subtotal - discountAmt + taxAmt, dec);

  return { items, subtotal, discountAmt, taxAmt, total };
}
