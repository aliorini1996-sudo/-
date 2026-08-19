import { computeInvoiceTotals } from '../rep/invoiceCalc';
import { currencyDecimals } from '../i18n/countries';
import { getActiveCurrency } from '../utils/format';

/**
 * حساب بنود الفاتورة في مسار **الإدارة**.
 *
 * ⚠️ **الفخّ الحاكم — لا تنسخ منطق تطبيق المندوب هنا:**
 * مسار الأدمن (`POST /invoices`) يتوقّع `unitPrice` **قبل الضريبة** ومعه
 * `taxPct` منفصلاً — والسعر يأتي من `product.basePrice` وهو صافٍ. أمّا شاشة
 * المندوب فتُدخِل سعراً **شاملاً** وتشتقّ ما قبله.
 *
 * ولا حساب هنا إطلاقاً: كل الأرقام من **المحرّك المشترك** الذي يطابق الخادم
 * حرفياً. كانت هذه الوحدة تحسب بنفسها، فورثت الخللَ الذي كان في الخادم
 * (خصم البند لا يخفّض الإجمالي) — والحلّ ألّا يوجد إلا مصدر حساب واحد.
 */

export interface Line {
  productId: string; name: string; unit: string;
  qty: number; unitPrice: number; discountPct: number; taxPct: number;
}

/** إجمالي البند شاملاً ضريبته بعد خصمه (بلا خصم الفاتورة الكلّي) */
export function lineTotal(l: Pick<Line, 'qty' | 'unitPrice' | 'discountPct' | 'taxPct'>): number {
  const r = computeInvoiceTotals(
    [{ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct }],
    { companyVat: l.taxPct, decimals: currencyDecimals(getActiveCurrency()), invoiceDiscountPct: 0 },
  );
  return r.items[0].lineTotal;
}

/** ملخّص الفاتورة — من المحرّك المشترك، فلا يختلف رقمان لمستند واحد */
export function invoiceTotals(lines: Line[], invoiceDiscountPct: number) {
  const r = computeInvoiceTotals(
    lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct })),
    { companyVat: 15, decimals: currencyDecimals(getActiveCurrency()), invoiceDiscountPct },
  );
  return { subtotal: r.subtotal, discount: r.discountAmt, tax: r.taxAmt, total: r.total };
}
