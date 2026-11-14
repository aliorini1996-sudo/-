/**
 * أرقام المستند المختوم «بلا ضريبة» كما تُعرض وتُطبع — «ربط الدفاتر» B6 (مراجعة ١٤ نوفمبر ٢٠٢٦).
 *
 * لماذا: في شركةٍ مربوطة أزالت ضريبتها، يحتفظ مرتجع فاتورة بيعٍ صدرت بضريبتها بنسبة بند البيع (B6 — الدفاتر تعكس ضريبة البيع)
 * ويبقى مختوماً taxFree. فيُخزَّن: subtotal = 100 (الصافي) وtaxAmt = 15 وtotal = 115. والختم يُخفي سطري الضريبة والوعاء، فكانت
 * الورقة الافتراضية (A4 الكلاسيكي) والورق المطبوع مسبقاً وشاشة تفاصيل الفاتورة تعرض «المجموع قبل الخصم 100.00» ثم «الإجمالي 115.00»
 * بلا سطرٍ يفسّر الـ15 — كشفٌ ضمنيّ للضريبة على مستندٍ «بلا ضريبة»، وخلافٌ لورقة المندوب دون اتصال (115). أُصلح العرض لا التخزين:
 * الأرقام المخزّنة صحيحة للدفاتر.
 *
 * القاعدة: المستند المختوم بلا ضريبة يُعرض بلغة «لا ضريبة» — «المجموع قبل الخصم» = الإجمالي + الخصم، والضريبة صفر، ونسب البنود صفر
 * (السعر وإجمالي البند شاملان أصلاً) — أي ما كان يُخزَّن ويُطبع قبل B6 حرفاً. ومستندٌ مختوم ضريبته صفر (كل مستندٍ قبل B6) أو غير
 * مختوم: المرجع نفسه بلا نسخ — الورقة حرفاً كما اليوم.
 * ملفٌّ نقيّ: بلا React ولا قاموس (يُختبر في node).
 */
import { isDocTaxFree, type TaxModeDoc } from './taxMode';

type Num = number | string | null | undefined;

const num = (v: Num): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** تنظيف غبار الطفو بثلاث منازل (أكثر منازل العملات) — العرض يقرّب بعدها بمنازل العملة */
const clean3 = (n: number): number => Math.round(n * 1000) / 1000;

/** مختومٌ بلا ضريبة وضريبته المخزّنة غير صفر؟ (مرتجع B6 وحده اليوم) */
export function taxFreeCarriesVat(d: TaxModeDoc & { tax?: Num; taxAmt?: Num }): boolean {
  return isDocTaxFree(d) && num(d.tax ?? d.taxAmt) !== 0;
}

/**
 * «المجموع قبل الخصم» كما يُعرض: للمختوم بلا ضريبة وضريبته غير صفر = الإجمالي + الخصم؛ وإلا subtotal المخزَّن كما هو.
 * يقبل شكل المستند المطبوع (discount/tax) وشكل صفّ الخادم (discountAmt/taxAmt).
 */
export function taxFreeShownSubtotal(d: TaxModeDoc & { subtotal: Num; total: Num; discount?: Num; discountAmt?: Num; tax?: Num; taxAmt?: Num }): number {
  if (!taxFreeCarriesVat(d)) return num(d.subtotal);
  return clean3(num(d.total) + num(d.discount ?? d.discountAmt));
}

interface AmountsDoc extends TaxModeDoc {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  items: ReadonlyArray<{ taxPct: number; taxAmt?: number | null }>;
}

/**
 * المستند كما يُرسم بلا ضريبة (يستدعيه taxFreeView قبل كل قالب: الكلاسيكي والثنائي والمطبوع مسبقاً): المختوم الذي يحمل ضريبةً
 * (B6) ⇒ subtotal = الإجمالي + الخصم، والضريبة صفر، ونسب البنود وضرائبها صفر — فيتّزن «المجموع − الخصم = الإجمالي» على الورقة.
 * وغيره: المرجع نفسه حرفاً.
 */
export function taxFreeShownAmounts<T extends AmountsDoc>(doc: T): T {
  if (!taxFreeCarriesVat(doc)) return doc;
  return {
    ...doc,
    subtotal: taxFreeShownSubtotal(doc),
    tax: 0,
    items: doc.items.map((it) => ({ ...it, taxPct: 0, ...(it.taxAmt !== undefined && it.taxAmt !== null ? { taxAmt: 0 } : {}) })),
  };
}
