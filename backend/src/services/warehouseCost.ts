// ============================================================================
// تكلفة الوارد للمستودع — حسابٌ نقيّ بلا قاعدة بيانات.
// ----------------------------------------------------------------------------
// القاعدة الحاكمة: `unitCost` المخزَّن **صافٍ قبل الضريبة، دائماً**.
//
// لماذا هذا الحسم مهمّ: فاتورة المورّد في السعودية تُعلن السعر شاملاً الضريبة
// غالباً، فلو خُزّن ما يُكتب كما هو لصار العمود يحمل معنيين — صافياً حيناً
// وشاملاً حيناً — ولا سبيل بعدها للتفرقة بينهما في تقرير. فالمستخدم يكتب ما
// يقرؤه في فاتورته ويؤشّر «شاملة الضريبة»، والخادم يردّه إلى صافيه قبل الحفظ.
//
// وضريبة المدخلات مستردّة للمنشأة المسجَّلة، فليست جزءاً من كلفة المخزون
// أصلاً — والصافي هو الرقم الصحيح محاسبياً لا مجرّد اصطلاح داخليّ.
// ============================================================================
import { netFromInclusive } from '../lib/money';
import { roundDecimal } from '../utils/helpers';

/** خانات تخزين تكلفة الوحدة — أوسع من خانات العملة عمداً: شراء ٣ حبّات بريال
 *  يعطي ٠٫٣٣٣٣ للوحدة، وتقريبها إلى خانتين يضيّع فلساً في كل مئة وحدة. */
export const COST_DECIMALS = 4;

/**
 * تكلفة الوحدة الصافية من الرقم الذي كتبه المستخدم.
 *
 * @param entered   ما كُتب في الخانة (صافياً أو شاملاً بحسب `inclusive`)
 * @param taxPct    نسبة ضريبة الصنف
 * @param inclusive هل الرقم المكتوب شاملٌ للضريبة
 */
export function netUnitCost(entered: number, taxPct: number, inclusive: boolean): number {
  if (!Number.isFinite(entered) || entered < 0) return 0;
  const net = inclusive ? netFromInclusive(entered, taxPct) : entered;
  return roundDecimal(net, COST_DECIMALS);
}

/** قيمة سطر = الكمية × تكلفة الوحدة (بخانات العملة، فهي مبلغ يُقرأ لا معامل) */
export function lineCost(qty: number, unitCost: number | null | undefined, decimals = 2): number {
  if (unitCost == null || !Number.isFinite(unitCost) || !Number.isFinite(qty)) return 0;
  return roundDecimal(qty * unitCost, decimals);
}

/**
 * إجمالي قيمة الحركة.
 *
 * يُجمع من قيم الأسطر **بعد تقريب كلٍّ منها** لا من حاصل ضربٍ خام، ليطابق
 * الإجمالي ما تراه العين مجموعاً من الأسطر المعروضة — فرقُ فلسٍ بين الاثنين
 * يقرؤه المحاسب خطأً في النظام لا تقريباً.
 */
export function entryTotalCost(
  items: { qty: number; unitCost?: number | null }[],
  decimals = 2,
): number {
  return roundDecimal(
    items.reduce((s, i) => s + lineCost(i.qty, i.unitCost, decimals), 0),
    decimals,
  );
}

/** هل في الحركة سطرٌ واحد على الأقلّ بسعر؟ (الحركة قد تُسجَّل بلا أسعار) */
export function hasAnyCost(items: { unitCost?: number | null }[]): boolean {
  return items.some((i) => i.unitCost != null && Number.isFinite(i.unitCost) && i.unitCost > 0);
}

// ═══ تقييم المخزون بتكلفة الشراء ═══

export interface CostBasis {
  avgCost: number;      // متوسّط تكلفة الوحدة المرجّح بالكميات
  costedQty: number;    // الكمية الواردة التي لها سعر
  uncostedQty: number;  // الكمية الواردة بلا سعر — حدّ صدق المتوسّط
}

/**
 * متوسّط تكلفة الوحدة، مرجّحاً بالكميّات، من **الوارد وحده**.
 *
 * ثلاثة قرارات في هذه الدالّة تستحقّ التسمية:
 *
 * ١) **الترجيح بالكميّة لا المتوسّط الحسابيّ**: من اشترى ١٠٠٠ بريال ثمّ ١٠
 *    بريالين تكلفته الوسطى ١٫٠١ لا ١٫٥٠. المتوسّط الساذج يقلب التقييم رأساً على
 *    عقب عند أوّل شراء صغير بسعر شاذّ.
 *
 * ٢) **السطر بلا سعر يُستبعَد من البسط والمقام معاً** — لا يُحسب صفراً. لو حُسب
 *    صفراً لهبط المتوسّط كلّما سُجّل استلامٌ قبل وصول فاتورته، فيظهر المخزون
 *    أرخص ممّا كلّف. وتُردّ كميّته في `uncostedQty` ليُقال للمستخدم صراحةً كم
 *    من رصيده خارج التقييم بدل أن يُخفى النقص في رقمٍ واثق.
 *
 * ٣) **التسويات لا تدخل المتوسّط**: التسوية جردٌ أو تالف لا شراء، فليس لها ثمن
 *    تُسعَّر به. وتُقيَّم كميّتها لاحقاً بمتوسّط الشراء نفسه.
 */
export function weightedAvgCost(receiveItems: { qty: number; unitCost?: number | null }[]): CostBasis {
  let value = 0, costedQty = 0, uncostedQty = 0;
  for (const it of receiveItems) {
    if (!Number.isFinite(it.qty) || it.qty <= 0) continue;
    if (it.unitCost != null && Number.isFinite(it.unitCost) && it.unitCost > 0) {
      value += it.qty * it.unitCost;
      costedQty += it.qty;
    } else {
      uncostedQty += it.qty;
    }
  }
  return {
    avgCost: costedQty > 0 ? roundDecimal(value / costedQty, COST_DECIMALS) : 0,
    costedQty: roundDecimal(costedQty, 4),
    uncostedQty: roundDecimal(uncostedQty, 4),
  };
}

/**
 * قيمة الرصيد الحاليّ بتكلفة الشراء = الرصيد × متوسّط التكلفة.
 *
 * والرصيد السالب يُقيَّم سالباً عمداً — رقمٌ أحمر في التقرير أصدق من صفرٍ
 * يُخفي أن المحمّل للسيارات تجاوز الوارد.
 */
export function stockValue(onHand: number, avgCost: number, decimals = 2): number {
  if (!Number.isFinite(onHand) || !Number.isFinite(avgCost) || avgCost <= 0) return 0;
  return roundDecimal(onHand * avgCost, decimals);
}
