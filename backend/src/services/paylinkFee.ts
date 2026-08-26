import { roundHalfUp } from '../lib/money';
import { VAT_PCT } from './finance';

/**
 * حساب عمولة «الدفع الإلكتروني» — وحدة صغيرة معزولة عمداً لأنها أخطر ما في الميزة.
 *
 * نحن نجمع ثم نوزّع: العميل يدفع لحسابنا، ونحن ندين للشركة بما دفعه ناقصَ عمولتنا.
 * ومن هنا القاعدة التي تنكسر عندها أنظمة كثيرة:
 *
 *   سند قبض العميل يُسجَّل **بما دفعه كاملاً**، لا بما تبقّى بعد العمولة.
 *
 * لو سُجّل بالصافي لبقيت الفاتورة ناقصةً بمقدار العمولة إلى الأبد، وطارد النظامُ
 * عميلاً سدّد دَينه. العمولة تُقتطع مما ندين به للشركة — لا من حساب العميل.
 *
 * والعمولة **شاملة ضريبة القيمة المضافة** بقرار المالك، فالضريبة تُستخرَج منها
 * ولا تُضاف إليها (نفس مبدأ وحدة المالية): ٤١ ريالاً شاملة = ٣٥٫٦٥ عمولة + ٥٫٣٥ ضريبة.
 */

export interface PaylinkFee {
  /** ما دفعه العميل فعلاً — وهو مبلغ سند القبض */
  collected: number;
  /** عمولتنا شاملة الضريبة */
  feeGross: number;
  /** عمولتنا قبل الضريبة — إيرادنا */
  feeNet: number;
  /** ضريبة القيمة المضافة على عمولتنا */
  feeVat: number;
  /** ما ندين به للشركة ويُورَّد لها */
  payable: number;
}

/**
 * @param collected ما دفعه العميل بالريال
 * @param pct نسبة العمولة (٤ افتراضاً) — لكل شركة على حدة
 * @param flat المبلغ الثابت لكل دفعة (١ ريال افتراضاً)
 * @param vatPct نسبة الضريبة المستخرَجة من العمولة
 */
export function computePaylinkFee(
  collected: number,
  pct: number,
  flat: number,
  vatPct: number = VAT_PCT,
): PaylinkFee {
  if (!Number.isFinite(collected) || collected <= 0) {
    throw new Error('مبلغ محصل غير صالح');
  }
  const safePct = Number.isFinite(pct) && pct >= 0 ? pct : 0;
  const safeFlat = Number.isFinite(flat) && flat >= 0 ? flat : 0;

  // الحدّ الأعلى ليس تجميلاً: دفعة أصغر من الريال الثابت كانت ستجعل ما ندين به
  // للشركة سالباً — أي أن تحصيلاً يزيد دَينها علينا. العمولة لا تتجاوز المحصَّل.
  const raw = (collected * safePct) / 100 + safeFlat;
  const feeGross = Math.min(roundHalfUp(raw, 2), roundHalfUp(collected, 2));

  const feeNet = roundHalfUp(feeGross / (1 + vatPct / 100), 2);
  // الضريبة فرقٌ لا حاصلُ ضرب: هكذا يتحقّق feeNet + feeVat = feeGross دائماً
  // مهما وقع التقريب، فلا ينحرف الإقرار الضريبي عن دفتر الأمانات بهللة.
  const feeVat = roundHalfUp(feeGross - feeNet, 2);

  const payable = roundHalfUp(roundHalfUp(collected, 2) - feeGross, 2);

  return { collected: roundHalfUp(collected, 2), feeGross, feeNet, feeVat, payable };
}
