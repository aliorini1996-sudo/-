/**
 * محرّك حساب الفاتورة — **مصدر واحد للحقيقة** يتشاركه الخادم والعميل (تطبيق المندوب).
 *
 * لماذا مشترك: في العمل دون اتصال يطبع المندوب الفاتورة (إجمالي + ضريبة + QR) محلياً على
 * الجهاز، ثم يعيد الخادم الحساب عند الرفع. إن اختلفت الصيغتان بأي كسر، خالفت الورقة التي
 * بيد العميل سجلَّ الخادم. لذا هذه الوحدة **نقيّة ومحمولة** (بلا Prisma/DOM/تبعيات)، ولها
 * نسخة متطابقة حرفياً في web-admin/src/rep/invoiceCalc.ts.
 *
 * ⚠️ عند تعديل الصيغة: عدّل النسختين معاً، وحدّث المتجهات الذهبية في invoiceCalc.test.ts.
 * السلوك مطابق تماماً للمنطق التاريخي في routes/invoices.ts (لا نُصلحه هنا — نوحّده).
 */

// تقريب لعدد خانات عشرية محدّد (٢ أو ٣ حسب عملة الدولة)
export function roundDecimal(value: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

export interface CalcItemInput {
  qty: number;
  unitPrice: number;
  discountPct: number;   // خصم البند %
  taxPct?: number;       // ضريبة البند % (يرث ضريبة الشركة عند الغياب)
}

export interface CalcItemResult {
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;        // بعد وراثة ضريبة الشركة
  discountAmt: number;   // مبلغ خصم البند
  taxAmt: number;        // مبلغ ضريبة البند
  lineTotal: number;     // صافي البند شامل الضريبة
}

export interface CalcOptions {
  companyVat: number;      // ضريبة الشركة الافتراضية %
  decimals: number;        // خانات العملة (getCountryTax(...).currencyDecimals)
  invoiceDiscountPct: number; // خصم الفاتورة الكلّي %
}

export interface CalcResult {
  items: CalcItemResult[];
  subtotal: number;     // مجموع أساس البنود قبل الخصم الكلّي (lineBase)
  discountAmt: number;  // مبلغ خصم الفاتورة الكلّي
  taxAmt: number;       // مجموع ضرائب البنود
  total: number;        // الإجمالي النهائي
}

/**
 * يحسب البنود والإجماليات — مطابق حرفياً لمنطق routes/invoices.ts.
 * ملاحظة سلوكية محفوظة عمداً: ضريبة البند تُحسب على (الأساس - خصم البند) قبل خصم الفاتورة
 * الكلّي، والإجمالي = (المجموع - خصم الفاتورة) + مجموع ضرائب البنود.
 */
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
