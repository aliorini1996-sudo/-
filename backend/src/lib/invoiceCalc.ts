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

import { roundHalfUp, distributeAmount } from './money';

// تقريب لعدد خانات عشرية محدّد (٢ أو ٣ حسب عملة الدولة) — نصف-لأعلى موحّد
export function roundDecimal(value: number, decimals = 2): number {
  return roundHalfUp(value, decimals);
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
  /** الاسعار المدخلة **شاملة الضريبة** (تطبيق المندوب): يبقى سعر البند واجماليه
   *  كما اعلن للعميل حرفيا، وتشتق الضريبة من الداخل — فلا يدفع العميل قرشا
   *  فوق السعر المعلن بسبب تقريب وسيط. */
  pricesIncludeTax?: boolean;
}

export interface CalcResult {
  items: CalcItemResult[];
  subtotal: number;     // مجموع أساس البنود قبل الخصم الكلّي (lineBase)
  discountAmt: number;  // مبلغ خصم الفاتورة الكلّي
  taxAmt: number;       // مجموع ضرائب البنود
  total: number;        // الإجمالي النهائي
}

/**
 * يحسب البنود والإجماليات — المرجع الوحيد للخادم والعميل معاً.
 *
 * ═══ ثابتان لا يجوز كسرهما ═══
 *  1. **الإجمالي = مجموع صافي البنود.** وإلّا خالفت الورقةُ المطبوعة السجلَّ
 *     المحاسبيّ، ولا يكتشف أحدٌ الفرقَ حتى يشتكي العميل.
 *  2. **الضريبة = نسبتها من الوعاء بعد كل خصم.** رمز ZATCA يحمل الإجمالي
 *     والضريبة معاً (الحقلان 4 و5)، فزوجٌ غير متّسق = فاتورة تسقط في أي تدقيق.
 *
 * ⚠️ **ما كان قبل التصحيح** (كان موثَّقاً في الاختبار بوصفه «سلوكاً تاريخياً»):
 *  · `subtotal` كان يجمع الأساس **قبل** خصم البند، فخصم البند يخفّض الضريبة
 *    ولا يخفّض الإجمالي ⇒ ٣ قطع بـ١٠٠ وخصم ١٠٪ تُطبع ٣١٠٫٥٠ وتُقيَّد ٣٤٠٫٥٠.
 *  · وخصم الفاتورة الكلّي كان يُخصم من الوعاء **بعد** حساب الضريبة ⇒ ضريبةٌ
 *    على مبلغ لم يُبَع به، ونسبةٌ ضمنية ١٥٫٧٩٪ في رمز ZATCA بدل ١٥٪.
 *
 * والتصحيح: **خصم الفاتورة يُوزَّع على البنود قبل الضريبة**، فيصير كلّ بندٍ
 * حاملاً حصّته من الخصم وضريبته محسوبةً على صافيه — وبذلك يتحقّق الثابتان معاً.
 */
export function computeInvoiceTotals(rawItems: CalcItemInput[], opts: CalcOptions): CalcResult {
  const { companyVat, decimals: dec, invoiceDiscountPct } = opts;
  const inclusive = !!opts.pricesIncludeTax;

  // ═══ المرحلة ١: اساس كل بند وخصمه السطري ═══
  // في الوضع الشامل «الاساس» هو المبلغ شامل الضريبة كما ادخل؛ وفي الحصري هو الصافي قبلها
  const bases = rawItems.map(item => roundDecimal(item.qty * item.unitPrice, dec));
  const lineDiscounts = rawItems.map((item, i) => roundDecimal((bases[i] * item.discountPct) / 100, dec));
  const afterDisc = bases.map((b, i) => roundDecimal(b - lineDiscounts[i], dec));

  // ═══ المرحلة ٢: خصم الفاتورة الكلي — مبلغ واحد مقرب يوزع باكبر الباقي ═══
  // التقريب لكل حصة على حدة كان يجعل الخصم الفعلي يخالف النسبة المعلنة
  // (٪٥ من ١٠ بنود صغيرة تصير ٤٫٥٩٪) ويصفر حصص البنود الصغيرة
  const afterDiscSum = afterDisc.reduce((s, v) => s + v, 0);
  const headTarget = roundDecimal((afterDiscSum * invoiceDiscountPct) / 100, dec);
  const headShares = distributeAmount(headTarget, afterDisc, dec);
  const nets = afterDisc.map((v, i) => roundDecimal(v - headShares[i], dec));

  // ═══ المرحلة ٣: الضريبة بسلة النسبة ثم توزيعها على البنود ═══
  // تقريب ضريبة كل بند على حدة ينحرف بالمجموع عن النسبة المعلنة كلما كثرت
  // البنود الصغيرة (١٠٠ بند صغير @١٥٪ كانت تخرج ١٤٫٥٦٪ فعلية) — فنحسب ضريبة
  // كل نسبة على وعائها الكامل ثم نوزعها، فيطابق الزوج المطبوع في QR نسبته
  const pcts = rawItems.map(item => item.taxPct ?? companyVat);
  const buckets = new Map<number, number[]>(); // pct -> فهارس البنود
  pcts.forEach((pct, i) => {
    const arr = buckets.get(pct) || [];
    arr.push(i);
    buckets.set(pct, arr);
  });
  const taxes = new Array<number>(rawItems.length).fill(0);
  let taxAmt = 0;
  for (const [pct, idxs] of buckets) {
    if (pct <= 0) continue;
    const bucketBase = idxs.reduce((s, i) => s + nets[i], 0);
    const bucketTax = inclusive
      ? roundDecimal((bucketBase * pct) / (100 + pct), dec)
      : roundDecimal((bucketBase * pct) / 100, dec);
    const shares = distributeAmount(bucketTax, idxs.map(i => nets[i]), dec);
    idxs.forEach((itemIdx, k) => { taxes[itemIdx] = shares[k]; });
    taxAmt += bucketTax;
  }
  taxAmt = roundDecimal(taxAmt, dec);

  // ═══ المرحلة ٤: اجمالي البند والمجاميع — الثابت: الاجمالي = مجموع البنود حرفيا ═══
  const items: CalcItemResult[] = rawItems.map((item, i) => ({
    qty: item.qty,
    unitPrice: item.unitPrice,
    discountPct: item.discountPct,
    taxPct: pcts[i],
    discountAmt: lineDiscounts[i],
    taxAmt: taxes[i],
    lineTotal: inclusive ? nets[i] : roundDecimal(nets[i] + taxes[i], dec),
  }));

  const subtotal = roundDecimal(bases.reduce((s, v) => s + v, 0), dec);
  const discountAmt = roundDecimal(lineDiscounts.reduce((s, v) => s + v, 0) + headTarget, dec);
  const total = inclusive
    ? roundDecimal(subtotal - discountAmt, dec)
    : roundDecimal(subtotal - discountAmt + taxAmt, dec);

  return { items, subtotal, discountAmt, taxAmt, total };
}
