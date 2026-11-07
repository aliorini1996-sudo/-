import { effectiveTaxPct, type TaxModeCompany } from './taxMode';

/**
 * «إزالة الضريبة» (CONTRACT2 E2) — نافذة الفاتورة في الإدارة (components/forms/InvoiceModal) حين **تعود** ضريبة الشركة والنافذة
 * مفتوحة: ردّ 409 TAX_MODE_CHANGED أعاد قراءة الشركة (البنود سُعِّرت «بلا ضريبة» — builtTaxFree: true — والشركة أعادتها)، أو تجدّدت
 * قراءتها من تبويبٍ آخر. والاتجاه الآخر (إزالتها: كل بندٍ صفر) أثرٌ مستقل في النافذة نفسها.
 *
 * كل بندٍ بنسبة صفر — سُعِّر بلا ضريبة، وعمود النسبة كان مخفياً فلم يمسّه أحد — يعود بنسبة صنفه الفعلية الآن (effectiveTaxPct)،
 * و**السعر الصافي المكتوب كما هو** (أسعار الإدارة صافية والسعر المكتوب نهائي — قرار المالك) والإجمالي يتبع النسبة. بندٌ بنسبةٍ غير
 * الصفر، أو صنفه غائبٌ عن القائمة، أو نسبة صنفه صفر، كما هو. لا تغيّر ⇒ المصفوفة نفسها (لا إعادة رسم).
 */
export interface RetaxLine {
  productId: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
  lineTotal: number;
}

export function retaxRestoredLines<L extends RetaxLine>(
  lines: L[],
  products: readonly { id: string; taxPct?: number | string | null }[] | null | undefined,
  company: TaxModeCompany | null | undefined,
  calc: (qty: number, unitPrice: number, discountPct: number, taxPct: number) => number,
): L[] {
  let changed = false;
  const out = lines.map((l) => {
    if (l.taxPct !== 0) return l;
    const p = (products ?? []).find((x) => x.id === l.productId);
    if (!p) return l;
    const pct = effectiveTaxPct(company, p.taxPct);
    if (pct === 0) return l;
    changed = true;
    return { ...l, taxPct: pct, lineTotal: calc(l.qty, l.unitPrice, l.discountPct, pct) };
  });
  return changed ? out : lines;
}
