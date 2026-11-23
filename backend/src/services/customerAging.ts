/**
 * «عمر الدين» لكل عميلٍ مدين في تقرير أرصدة العملاء (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — دالّةٌ صرفة: لا قاعدة ولا ساعة.
 *
 * مصدر الدين: الفواتير المفتوحة بمتبقّيها (`Invoice.remainingAmt` — ما تعرضه صفحة الفواتير بعد السند الموزَّع عليها والمرتجع
 * المربوط بها والإشعار الدائن)، كلٌّ بيومه بتوقيت الشركة. ثم يُطابَق مجموعها برصيد العميل المعروض في التقرير (`customer.balance`)
 * فيساوي مجموعُ الشرائح الرصيدَ دائماً — لا رقمان مختلفان للعميل نفسه في صفّ واحد:
 *  • الرصيد أقلّ من المفتوح (سندٌ لم يُوزَّع على فاتورة، مرتجعٌ غير مربوط، تسويةٌ دائنة): الفرق يُطفئ الأقدم أولاً.
 *  • الرصيد أكبر (رصيدٌ افتتاحيّ مستورد أو تسويةٌ مدينة ليست على فاتورة): الفرق يُؤرَّخ بقيود التسوية المدينة من الأحدث إلى
 *    الأقدم — ما بقي من دينٍ قديم هو آخر ما يُسدَّد — وما لا يغطّيه قيدٌ يبقى «بلا تاريخ» ظاهراً في الردّ لا مخفيّاً.
 *
 * العمر بالأيام من يوم الدين إلى يوم الشركة الآن (اليوم نفسه = صفر). والتأخّر من يوم الاستحقاق: تاريخ استحقاق الفاتورة إن وُجد،
 * وإلا يومها + مهلة سداد العميل (`paymentDays`) — يحسبه المنادي ويمرّره `dueDay`.
 */
import { cleanMoney } from './netSales';
import { addDays, diffDays, isLocalDate } from './gl/dates';

/** شرائح العمر: من ٠ إلى ٣٠ يوماً، ومن ٣١ إلى ٦٠، ومن ٦١ إلى ٩٠، وأكثر من ٩٠ */
export const DEBT_AGE_BANDS = ['d0_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type DebtAgeBand = (typeof DEBT_AGE_BANDS)[number];

/** غبار العائمة: أصغر من أصغر وحدةٍ نقدية (0.001) بكثير، كحدّ «المدينين» في التقرير نفسه */
export const DEBT_EPS = 1e-6;

/** دينٌ مؤرَّخ: فاتورةٌ مفتوحة بمتبقّيها (أو قسطٌ منها)، أو قيد تسويةٍ مدين */
export interface DatedDebt {
  /** يوم الدين بتوقيت الشركة 'YYYY-MM-DD' */
  day: string;
  amount: number;
  /** يوم الاستحقاق 'YYYY-MM-DD' — null: يوم الدين نفسه */
  dueDay?: string | null;
  /**
   * قيدٌ يومه المخزَّن ليس يوم الدين الحقيقي (رصيدٌ افتتاحيّ استُورد بلا تاريخ فأخذ لحظة الاستيراد): يُغطّي الفرق في موضعه
   * كغيره، لكن ما يغطّيه يُعدّ «بلا تاريخ» — لا عمرَ مخترعاً من يوم الاستيراد
   */
  undated?: boolean;
}

export interface CustomerAging {
  /** أقدم يومٍ ما زال منه دين — null حين لا دين مؤرَّخ */
  oldestDay: string | null;
  /** الأيام من أقدم دينٍ قائم إلى اليوم */
  ageDays: number | null;
  /** أيام تجاوز أقدم استحقاقٍ لم يُسدَّد — صفر: لا شيء متأخّر عن مهلته */
  overdueDays: number;
  /** المتأخّر عن مهلة السداد من الرصيد */
  overdueAmount: number;
  /** الرصيد موزّعاً على شرائح العمر */
  bands: Record<DebtAgeBand, number>;
  /** ما لا يُعرف يومه من الرصيد (لا فاتورة مفتوحة ولا قيد تسويةٍ يغطّيه) */
  undated: number;
}

export function bandOf(ageDays: number): DebtAgeBand {
  if (ageDays <= 30) return 'd0_30';
  if (ageDays <= 60) return 'd31_60';
  if (ageDays <= 90) return 'd61_90';
  return 'd90_plus';
}

const emptyBands = (): Record<DebtAgeBand, number> => ({ d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

/** الأقدم أوّلاً، وبالاستحقاق الأقدم عند تساوي اليوم — ترتيبٌ ثابت لا يتبع ترتيب الصفوف */
const byDayAsc = (a: DatedDebt, b: DatedDebt): number =>
  a.day < b.day ? -1 : a.day > b.day ? 1 : (a.dueDay ?? a.day) < (b.dueDay ?? b.day) ? -1 : (a.dueDay ?? a.day) > (b.dueDay ?? b.day) ? 1 : 0;

/**
 * عمر دين عميلٍ واحد. `balance` رصيده المعروض، و`openInvoices` فواتيره المفتوحة، و`adjustments` قيود التسوية المدينة عليه
 * (أيّ ترتيب)، و`today` يوم الشركة الآن. رصيدٌ صفر أو دائن ⇒ null (لا دين له عمر).
 */
export function customerAging(input: {
  balance: number;
  openInvoices: readonly DatedDebt[];
  adjustments?: readonly DatedDebt[];
  today: string;
}): CustomerAging | null {
  const balance = cleanMoney(Number(input.balance));
  if (!Number.isFinite(balance) || balance <= DEBT_EPS || !isLocalDate(input.today)) return null;

  const valid = (d: DatedDebt) => isLocalDate(d.day) && Number.isFinite(Number(d.amount)) && Number(d.amount) > DEBT_EPS;
  const norm = (d: DatedDebt): DatedDebt => ({
    day: d.day,
    amount: cleanMoney(Number(d.amount)),
    dueDay: d.dueDay && isLocalDate(d.dueDay) ? d.dueDay : null,
    ...(d.undated && { undated: true }),
  });
  const open = input.openInvoices.filter(valid).map(norm).sort(byDayAsc);
  const openSum = cleanMoney(open.reduce((s, d) => s + d.amount, 0));

  let items: DatedDebt[] = open;
  let undated = 0;
  const gap = cleanMoney(balance - openSum);
  if (gap < -DEBT_EPS) {
    // دائنٌ غير موزَّع: يُطفئ الأقدم أوّلاً
    let credit = -gap;
    items = [];
    for (const d of open) {
      if (credit >= d.amount - DEBT_EPS) { credit = cleanMoney(credit - d.amount); continue; }
      items.push({ ...d, amount: cleanMoney(d.amount - credit) });
      credit = 0;
    }
  } else if (gap > DEBT_EPS) {
    // دينٌ ليس على فاتورة: يُؤرَّخ بقيود التسوية المدينة من الأحدث إلى الأقدم
    let rest = gap;
    const adj = (input.adjustments ?? []).filter(valid).map(norm).sort(byDayAsc).reverse();
    const extra: DatedDebt[] = [];
    for (const d of adj) {
      if (rest <= DEBT_EPS) break;
      const take = Math.min(rest, d.amount);
      // قيدٌ بلا يومٍ حقيقيّ يغطّي حصّته في موضعه، وحصّته «بلا تاريخ»
      if (d.undated) undated = cleanMoney(undated + take);
      else extra.push({ ...d, amount: cleanMoney(take) });
      rest = cleanMoney(rest - take);
    }
    if (rest > DEBT_EPS) undated = cleanMoney(undated + rest);
    items = [...extra, ...open].sort(byDayAsc);
  }

  const bands = emptyBands();
  let oldestDay: string | null = null;
  let oldestDue: string | null = null;
  let overdueAmount = 0;
  for (const d of items) {
    if (d.amount <= DEBT_EPS) continue;
    const age = Math.max(0, diffDays(d.day, input.today));
    const band = bandOf(age);
    bands[band] = cleanMoney(bands[band] + d.amount);
    if (oldestDay == null || d.day < oldestDay) oldestDay = d.day;
    const due = d.dueDay ?? d.day;
    if (due < input.today) {
      overdueAmount = cleanMoney(overdueAmount + d.amount);
      if (oldestDue == null || due < oldestDue) oldestDue = due;
    }
  }

  return {
    oldestDay,
    ageDays: oldestDay == null ? null : Math.max(0, diffDays(oldestDay, input.today)),
    overdueDays: oldestDue == null ? 0 : diffDays(oldestDue, input.today),
    overdueAmount,
    bands,
    undated,
  };
}

/**
 * فاتورة تقسيط: متبقّيها موزّعاً على أقساطها — تاريخ استحقاق الفاتورة نفسها هو **آخر** قسط (invoices.ts)، فبدون التوزيع لا يُعدّ
 * شيءٌ منها متأخّراً قبل آخر قسط ولو فاتت أقساطٌ كثيرة. المسدَّد (الإجمالي − المتبقّي: سنداتٌ ومرتجعٌ مربوط وإشعارٌ دائن) يُطفئ
 * الأقساط بترتيبها كما يشتقّ النظام حالة كل قسط، وكل جزءٍ باقٍ بيوم الفاتورة (فلا يتغيّر العمر ولا الشرائح) واستحقاقِ قسطه.
 * مجموع الأجزاء = المتبقّي دائماً: أقساطٌ لا تساوي الإجمالي (صفوفٌ قديمة) أو فرق تقريب يُسوّى من آخر الأجزاء.
 * `installments` بترتيب seq، و`fallbackDueDay` لقسطٍ بلا تاريخ ولما لا تغطّيه الأقساط.
 */
export function installmentPieces(
  day: string,
  total: number,
  remaining: number,
  installments: readonly { dueDay: string | null; amount: number }[],
  fallbackDueDay: string | null,
): DatedDebt[] {
  const rem = cleanMoney(Number(remaining));
  if (!Number.isFinite(rem) || rem <= DEBT_EPS) return [];
  let settled = Math.max(0, cleanMoney(Number(total) - rem));
  if (!Number.isFinite(settled)) settled = 0;
  const out: DatedDebt[] = [];
  for (const ins of installments) {
    const amt = cleanMoney(Number(ins.amount));
    if (!Number.isFinite(amt) || amt <= DEBT_EPS) continue;
    const absorbed = Math.min(settled, amt);
    settled = cleanMoney(settled - absorbed);
    const left = cleanMoney(amt - absorbed);
    if (left > DEBT_EPS) out.push({ day, amount: left, dueDay: ins.dueDay && isLocalDate(ins.dueDay) ? ins.dueDay : fallbackDueDay });
  }
  let diff = cleanMoney(rem - out.reduce((s, d) => s + d.amount, 0));
  if (diff > DEBT_EPS) {
    // متبقٍّ لا تحمله الأقساط: إلى آخر جزء (أبعد استحقاق — لا يُتّهم بالتأخّر قبل أوانه)، وبلا أجزاءٍ كلّه باستحقاق الفاتورة
    if (out.length) out[out.length - 1].amount = cleanMoney(out[out.length - 1].amount + diff);
    else out.push({ day, amount: rem, dueDay: fallbackDueDay });
  } else if (diff < -DEBT_EPS) {
    // أقساطٌ أكبر من المتبقّي: يُنقص من آخر الأجزاء فالذي قبله
    for (let i = out.length - 1; i >= 0 && diff < -DEBT_EPS; i--) {
      const cut = Math.min(out[i].amount, -diff);
      out[i].amount = cleanMoney(out[i].amount - cut);
      diff = cleanMoney(diff + cut);
    }
  }
  return out.filter((d) => d.amount > DEBT_EPS);
}

/**
 * يوم استحقاق دينٍ: تاريخ الاستحقاق الصريح (يومه بتوقيت الشركة) إن وُجد، وإلا يوم الدين + مهلة السداد. مهلةٌ غير رقمية أو سالبة
 * ⇒ صفر (مستحقٌّ يومه) — كقاعدة اشتقاق الاستحقاق في الدفاتر (invoices.ts linkedCreditDueDate).
 */
export function dueDayOf(day: string, explicitDueDay: string | null | undefined, paymentDays: unknown): string {
  if (explicitDueDay && isLocalDate(explicitDueDay)) return explicitDueDay;
  const n = Number(paymentDays);
  const days = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return addDays(day, days);
}
