// ============================================================================
// تكلفة الوارد وتقييم المخزون — حسابٌ نقيّ بلا قاعدة بيانات.
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

// ════════════════════════════════════════════════════════════════════════════
// تقييم المخزون بتكلفة الشراء — متوسّط متحرّك على الرصيد الباقي، بدلوين
// ════════════════════════════════════════════════════════════════════════════
//
// نسختان سابقتان من هذا الحساب كانتا خاطئتين، وكلتاهما تبدو معقولة على الورق:
//
// ✗ **جمع كل الوارد منذ الأزل**: دفعة يناير ١٠٠٠ بعشرة بيعت كلّها، ودفعة فبراير
//   ١٠٠٠ بعشرين هي الباقية ⇒ المتوسّط ١٥ والقيمة ١٥٬٠٠٠، والحقيقة ٢٠٬٠٠٠.
//   البضاعة المستهلَكة كانت تجرّ التقييم إلى الأبد. الصواب أن تخرج طبقتها من
//   الحساب حين تخرج من المستودع — وهو ما يفعله المتوسّط المتحرّك.
//
// ✗ **تقييم الرصيد كلّه بمتوسّط المسعَّر منه**: عشرة آلاف كرتون وارد قديم بلا
//   سعر + عشرة كراتين بـ١٢ ⇒ القيمة ١٢٠٬١٢٠ والحقيقة الموثَّقة ١٢٠. ألفُ ضعف.
//   والأسوأ أن الشاشة كانت تقول «بلا سعر فلا يدخل هذه القيمة» — وهو نفيٌ لما
//   يفعله الحساب. لذلك صار للكمّية عديمة السعر **دلوٌ منفصل لا يُقيَّم**.
//
// ✗ **تقييم العائد من السيارة بمتوسّط لحظة عودته**: شراء ١٠٠ بعشرة، ثمّ تحميل ٥٠
//   إلى سيارة، ثمّ شراء ١٠٠ بعشرين فيصير المتوسّط ١٦٫٦٧، ثمّ تعود الخمسون ⇒ ترجع
//   البضاعة نفسها بكلفةٍ أعلى ممّا خرجت بها، فتُضخَّم قيمة المخزون ٣٣٣ ريالاً من
//   شراءٍ لم يمسّ هذه الحبّات أصلاً. والصواب أن تعود بكلفة خروجها: ٣٬٠٠٠ ومتوسّط ١٥.
//
// فالحالة الآن دلوان لكل صنف: `costed` له قيمة معروفة، و`uncosted` لا. والوارد
// المسعَّر وحده يحرّك المتوسّط؛ والصرف ينقص الدلوين بنسبتهما فلا يُستنزف أحدهما
// قبل الآخر بلا سبب؛ والجرد الزائد يُقيَّم بمتوسّط اللحظة.
//
// أمّا السيارات فلها **طبقات**: كل تحميلٍ يحفظ كمّيته وكلفتها لحظة خروجها، وكل
// عودةٍ تسحب من الطبقات بالمقلوب — **آخرُ ما حُمّل أوّلُ ما يعود**. والمقلوب هنا
// ليس اصطلاحاً: ما بِيع من حمولةٍ قديمة لن يعود أبداً، فلو طابقنا العائد بالأقدم
// لأعطيناه سعر بضاعةٍ باعها المندوب منذ شهر. وعودةٌ لا تحميل يقابلها — بضاعةٌ
// كانت في السيارة قبل تشغيل النظام — تبقى على متوسّط اللحظة، فلا كلفةَ خروجٍ لها.
//
// ✗ **مكدّسٌ واحدٌ لكلّ السيارات**: القاعدة أعلاه صادقةٌ داخل سيارةٍ واحدة وحدها.
//   فلو حُمّلت سيارةُ أ بمئةٍ بعشرة، ثمّ سيارةُ ب بمئةٍ بثلاثين، ثمّ أنزل أ حمولته،
//   لأخذ العائدُ كلفةَ ب — وحمولةُ ب ما زالت ماديّاً في سيارتها فلا يمكن أن تكون
//   هي ما نزل. وما يبيعه ب لن يعود، فتبقى طبقةُ أ الرخيصة في القاع أبداً وتبقى
//   القيمة مضخَّمةً في كلّ إقفال. لذلك للطبقات **مكدّسٌ لكلّ سيارة** لا مكدّسٌ
//   لكلّ صنف؛ والحركة التي لا سيارة لها تُجمع في مكدّسٍ مشترك واحد.

/** حركة مخزون واحدة، مرتّبةً زمنياً */
export interface CostMove {
  /** موجب يدخل المستودع، سالب يخرج منه */
  qty: number;
  /**
   * RECEIVE وحده يحمل سعراً ويحرّك المتوسّط.
   * VAN_OUT تحميلٌ لسيارة يحفظ كلفة خروجه، وVAN_IN عودةٌ منها تستردّ تلك الكلفة.
   * OTHER تسويةُ جردٍ في المستودع — بلا ثمنٍ وبلا طبقة.
   */
  kind: 'RECEIVE' | 'VAN_OUT' | 'VAN_IN' | 'OTHER';
  unitCost?: number | null;
  /**
   * السيارة (المندوب) صاحبة الحركة — لـVAN_OUT وVAN_IN وحدهما.
   * بدونه تُخلط حمولات المناديب في مكدّسٍ واحد فيعود مندوبٌ بكلفة حمولة زميله.
   */
  vanId?: string | null;
}

export interface CostState {
  costedQty: number;    // كمية في الرصيد تكلفتها معروفة
  costedValue: number;  // قيمتها
  uncostedQty: number;  // كمية في الرصيد بلا تكلفة معروفة — لا تُقيَّم
}

export interface Valuation {
  avgCost: number;      // متوسّط تكلفة الوحدة للكمّية المعروفة
  stockValue: number;   // قيمة الرصيد = الكمّية المعروفة × متوسّطها
  costedQty: number;    // الكمّية المقيَّمة
  uncostedQty: number;  // الكمّية خارج التقييم — تُعلَن للمستخدم صراحةً
}

const avgOf = (s: CostState) => (s.costedQty > 0 ? s.costedValue / s.costedQty : 0);

/**
 * طبقةٌ خرجت إلى سيارة ولم تعُد بعد، تحفظ كلفة خروجها لتعود بها.
 * `uncostedQty` هو جزء الحمولة الذي خرج من الدلو غير المقيَّم فيعود إليه لا إلى
 * الدلو المقيَّم — وإلّا لاختلق التقييمُ قيمةً لبضاعةٍ لم تُعرف كلفتها قطّ.
 */
interface VanLayer {
  costedQty: number;
  unitCost: number;
  uncostedQty: number;
}

/** عتبةُ صفرٍ للكسور العائمة — أدقّ بمراتب من أصغر خانةٍ تُعرَض (١٠⁻⁴) */
const EPS = 1e-9;

/** يُدخل كمّيةً بلا ثمنٍ موثَّق: بمتوسّط اللحظة إن وُجد، وإلّا فخارج التقييم */
function addAtAvg(s: CostState, qty: number): void {
  const avg = avgOf(s);
  if (avg > 0) {
    s.costedQty += qty;
    s.costedValue += qty * avg;
  } else {
    s.uncostedQty += qty;
  }
}

/**
 * يمرّ على الحركات **بترتيبها الزمنيّ** ويُخرج تقييم الرصيد الباقي.
 *
 * الترتيب مسؤولية المستدعي — والمرور غير مرتَّب يعطي رقماً خاطئاً بصمت،
 * فلذلك تُرتَّب في `composeWarehouse` قبل الاستدعاء لا هنا.
 */
export function valueStock(moves: CostMove[]): Valuation {
  const s: CostState = { costedQty: 0, costedValue: 0, uncostedQty: 0 };
  // ما على كلّ سيارةٍ الآن، بترتيب خروجه — يُستهلَك من آخره.
  // المفتاح معرّف السيارة؛ وحركةٌ بلا معرّف تقع في مكدّسٍ مشترك واحد.
  const stacks = new Map<string, VanLayer[]>();
  const stackOf = (vanId?: string | null) => {
    const key = vanId || '';
    let list = stacks.get(key);
    if (!list) { list = []; stacks.set(key, list); }
    return list;
  };

  for (const m of moves) {
    if (!Number.isFinite(m.qty) || m.qty === 0) continue;
    const priced = m.unitCost != null && Number.isFinite(m.unitCost) && m.unitCost > 0;

    if (m.qty > 0) {
      if (m.kind === 'RECEIVE' && priced) {
        // شراء بسعر: يدخل الدلو المعروف ويعيد ترجيح المتوسّط
        s.costedQty += m.qty;
        s.costedValue += m.qty * (m.unitCost as number);
      } else if (m.kind === 'RECEIVE') {
        // شراء بلا سعر: كمية في المستودع بلا قيمة موثَّقة — لا تُخمَّن
        s.uncostedQty += m.qty;
      } else if (m.kind === 'VAN_IN') {
        // عائدٌ من سيارة: يرجع بالكلفة التي خرج بها، من آخر طبقةٍ حُمّلت
        let back = m.qty;
        const mine = stackOf(m.vanId);
        while (back > EPS && mine.length > 0) {
          const layer = mine[mine.length - 1];
          const avail = layer.costedQty + layer.uncostedQty;
          if (avail <= EPS) {
            mine.pop();
            continue;
          }
          const take = Math.min(back, avail);
          // الطبقة تُسحب بنسبة دلويها كما خرجت بها تماماً
          const fromCosted = take * (layer.costedQty / avail);
          s.costedQty += fromCosted;
          s.costedValue += fromCosted * layer.unitCost;
          s.uncostedQty += take - fromCosted;
          layer.costedQty -= fromCosted;
          layer.uncostedQty -= take - fromCosted;
          back -= take;
        }
        // ما زاد عن كلّ ما حُمّل: بضاعةٌ كانت في السيارة قبل النظام — متوسّط اللحظة
        if (back > EPS) addAtAvg(s, back);
      } else {
        // جردٌ زائد في المستودع: يُقيَّم بمتوسّط اللحظة إن وُجد
        addAtAvg(s, m.qty);
      }
      continue;
    }

    // خروج: تحميلٌ لسيارة أو تسوية بالنقص — ينقص الدلوين بنسبتهما
    const out = -m.qty;
    const total = s.costedQty + s.uncostedQty;
    // المتوسّط يُلتقط **قبل** الاستنزاف: الخارج يُقيَّم بمتوسّط لحظة خروجه
    const avg = avgOf(s);

    // ما يمكن سحبه من الموجود فعلاً، وما زاد عنه سحبٌ مكشوف
    const share = total > 0 ? Math.min(out, total) : 0;
    let fromCosted = 0;
    if (share > 0) {
      fromCosted = share * (s.costedQty / total);
      s.costedQty -= fromCosted;
      s.costedValue -= fromCosted * avg;
      s.uncostedQty -= share - fromCosted;
    }

    // السحب المكشوف (تحميلٌ يتجاوز الرصيد) يُقيَّد على الدلو المعروف بمتوسّطه،
    // فيظهر الرصيد سالباً وقيمته سالبة — مؤشّر نقصٍ صريح. ولو ابتُلع في الدلو
    // غير المقيَّم لعاد صفراً صامتاً يُخفي أن المحمَّل تجاوز الوارد.
    const deficit = out - share;
    if (deficit > 0) {
      s.costedQty -= deficit;
      s.costedValue -= deficit * avg;
    }

    // تحميل سيارة يحفظ طبقته بكلفة خروجها — والمكشوف منه يُحفَظ كذلك ليعود
    // بنفس ما خُصم به تماماً، فلا يخلّف الذهابُ والإيابُ فرقاً في القيمة.
    if (m.kind === 'VAN_OUT') {
      stackOf(m.vanId).push({
        costedQty: fromCosted + deficit,
        unitCost: avg,
        uncostedQty: share - fromCosted,
      });
    }
  }

  const avgCost = roundDecimal(avgOf(s), COST_DECIMALS);
  return {
    avgCost,
    stockValue: roundDecimal(s.costedValue, 2),
    costedQty: roundDecimal(s.costedQty, 4),
    uncostedQty: roundDecimal(Math.max(0, s.uncostedQty), 4),
  };
}
