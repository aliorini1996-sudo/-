// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — سلّة المندوب. قراراتٌ صرفة يستعملها CreateInvoice في RepApp.tsx وتُختبر بلا مكوّن:
//  • نسبة البند الجديد = effectiveTaxPct(الشركة من /company المخبّأة، نسبة الصنف) — صفرٌ للشركة «بلا ضريبة»، فالسعر المعروض والمرسل صافٍ
//    (السعر المكتوب للصنف هو ما يدفعه العميل). Product.taxPct يبقى مخزّناً كما هو.
//  • انقلاب الوضع والسلّة مفتوحة (نبضة /company، أو 409 TAX_MODE_CHANGED بعد جلبها): repRetaxLines يعيد كل بندٍ إلى الوضع الجديد.
//  • ورقة الإصدار دون اتصال: «بلا ضريبة» حين تكون الشركة كذلك وكل البنود صفراً — كما يختمها الخادم عند رفع الصندوق (X-FS-Replay).
// والشركة بلا العلم (الافتراض، أو كاشٌ قديم) ⇒ لا شيء يتغيّر: النسب نسب الأصناف والسلّة كما هي حرفاً.
import { effectiveTaxPct, isTaxOff, TAX_MODE_CODES, type TaxModeCompany } from '../lib/taxMode';
import { repKeptPrice } from './repPriceLists';

/** بند سلّة المندوب كما يحمله CreateInvoice — الحقول التي يقرؤها القرار وحدها */
export interface RepTaxLine {
  productId: string;
  unitPrice: number;
  refPrice: number;
  taxPct: number;
  /** بند فاتورة بيع (مرتجعٌ مرتبط): سعر استرداده ثابت ونسبته من بند البيع */
  saleItemId?: unknown;
  link?: { taxPct?: number | null } | null;
}

/** «لم يمسّه المندوب»: سعره ما زال مرجعه (كـrefreshUnits وrepriceUntouched) */
const untouched = (l: RepTaxLine) => Math.abs(Number(l.unitPrice) - Number(l.refPrice)) <= 1e-9;

/**
 * السلّة بوضع الشركة الحالي بعد انقلابه:
 *  • بند الصنف: نسبته الفعلية، ومرجعه من جديد بالوضع الجديد (`refOf` = inclOf المكوّن، وهو يقرأ الوضع نفسه) — غير المعدَّل يأخذ المرجع،
 *    والمعدَّل يدوياً يبقى بسعره (السعر المكتوب نهائي) ويُرفع إلى المرجع لمن لا يبيع بأقل (`floor`): عودة الضريبة تجعل سعره المكتوب
 *    شاملاً فيصير صافيه دون الأرضية ويردّه الخادم «لا تملك صلاحية البيع بأقل».
 *  • صنفٌ غاب عن الكتالوج: سعره كما هو، ونسبته صفرٌ عند الإزالة (وإلا كما هي).
 *  • بند فاتورة البيع: سعر الاسترداد ثابت (المبلغ المسترد نفسه)، ونسبته الفعلية من نسبة بند البيع — صفرٌ عند الإزالة.
 * لا تغيّر ⇒ المصفوفة نفسها.
 */
export function repRetaxLines<L extends RepTaxLine, P extends { taxPct?: unknown }>(
  lines: L[],
  o: {
    company: TaxModeCompany | null | undefined;
    productOf: (l: L) => P | null | undefined;
    refOf: (l: L, p: P) => number;
    floor: boolean;
  },
): L[] {
  const off = isTaxOff(o.company);
  let changed = false;
  const out = lines.map((l) => {
    let next: L = l;
    if (l.saleItemId) {
      const pct = effectiveTaxPct(o.company, l.link ? l.link.taxPct : l.taxPct);
      if (pct !== Number(l.taxPct)) next = { ...l, taxPct: pct };
    } else {
      const p = o.productOf(l);
      if (!p) {
        if (off && Number(l.taxPct) !== 0) next = { ...l, taxPct: 0 };
      } else {
        const pct = effectiveTaxPct(o.company, p.taxPct as number | string | null | undefined);
        const ref = o.refOf(l, p);
        const unitPrice = untouched(l) ? ref : repKeptPrice(l.unitPrice, ref, o.floor);
        if (pct !== Number(l.taxPct) || ref !== l.refPrice || unitPrice !== l.unitPrice) next = { ...l, taxPct: pct, refPrice: ref, unitPrice };
      }
    }
    if (next !== l) changed = true;
    return next;
  });
  return changed ? out : lines;
}

/** ورقة الإصدار دون اتصال «بلا ضريبة»؟ الشركة أزالتها وكل بنود الحمولة صفر — الخادم يختم المصفوف كذلك عند رفعه، وبندٌ بنسبةٍ يُحفظ بضريبته */
export function repOfflineTaxFree(company: TaxModeCompany | null | undefined, lines: ReadonlyArray<{ taxPct?: unknown }>): boolean {
  return isTaxOff(company) && lines.length > 0 && lines.every((l) => Number(l.taxPct) === 0);
}

/** ردّ الخادم: الجهاز سعّر بوضعٍ غير وضع الشركة الآن (409 TAX_MODE_CHANGED) — أُزيلت الضريبة بعد آخر قراءةٍ للجهاز لإعداداتها، أو أُعيدت
 * وحمولته builtTaxFree: true (E1/E2) — يُجلب /company ويُعاد التسعير بالاتجاهين (repRetaxLines) */
export function isTaxModeChanged(err: unknown): boolean {
  const data = (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data;
  return data?.code === TAX_MODE_CODES.changed;
}
