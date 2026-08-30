import { roundHalfUp } from '../lib/money';

/**
 * جدولة أقساط الفاتورة.
 *
 * لماذا وحدة معزولة على الخادم: مجموع الأقساط **يجب** أن يساوي إجمالي الفاتورة
 * بالضبط، لا أن يقاربه. والقسمة على عددٍ لا يقبلها تُخلّف كسراً ضائعاً (١٠٠٠ على
 * ٣ = ٣٣٣٫٣٣ × ٣ = ٩٩٩٫٩٩)، فيبقى قرشٌ معلَّقاً على العميل إلى الأبد لا يُغلق
 * به دَينه. القاعدة هنا: تُقرَّب الأقساط لأسفل إلى خانة العملة، ويحمل **القسط
 * الأخير** الفارقَ كلَّه — فيُغلق الحساب حتماً.
 *
 * والحساب على الخادم لا على الواجهة: الإجمالي يحسبه محرّك الفاتورة في الخادم
 * (شاملاً الضريبة والخصم)، فلو حسبت الواجهة الأقساط من إجماليٍّ قدّرته بنفسها
 * لاختلّ المجموع عند أي فرق تقريب. الواجهة تعرض تقديراً، والخادم يكتب الحقيقة.
 */

export type InstallmentPeriod = 'MONTHLY' | 'SEMI_MONTHLY' | 'WEEKLY';

export interface InstallmentRow {
  seq: number;
  dueDate: Date;
  amount: number;
}

export interface InstallmentPlanInput {
  count: number;
  startDate: Date | string;
  period: InstallmentPeriod;
}

/** أقصى عدد أقساط — سقفٌ يمنع جدولاً عبثياً يُثقل الصفوف والطباعة */
export const MAX_INSTALLMENTS = 60;

/**
 * يضيف فترةً واحدة إلى تاريخ.
 *
 * الشهور تُزاد بالتقويم لا بثلاثين يوماً: قسطٌ أوّله ٣١ يناير يستحقّ ٢٨ فبراير
 * لا ٢ مارس. و`setMonth` في جافاسكربت يفيض عند تجاوز طول الشهر (٣١ يناير + شهر
 * = ٣ مارس)، فنقصّه صراحةً إلى آخر يوم في الشهر المقصود.
 */
export function addPeriod(base: Date, period: InstallmentPeriod, steps: number): Date {
  const d = new Date(base.getTime());
  if (period === 'WEEKLY') { d.setDate(d.getDate() + 7 * steps); return d; }
  if (period === 'SEMI_MONTHLY') { d.setDate(d.getDate() + 15 * steps); return d; }

  const day = d.getDate();
  d.setDate(1);                       // نتجنّب فيضان الشهر قبل تغييره
  d.setMonth(d.getMonth() + steps);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/**
 * يبني جدول الأقساط من إجمالي الفاتورة وخطّة التقسيط.
 *
 * @param total إجمالي الفاتورة كما حسبه محرّك الفاتورة (شاملاً الضريبة)
 * @param plan عدد الأقساط وتاريخ أوّلها ودوريّتها
 * @param decimals خانات العملة (ريال ٢، دينار ٣) — التقريب بخاناتها لا بخانتين
 */
export function buildInstallments(
  total: number,
  plan: InstallmentPlanInput,
  decimals = 2,
): InstallmentRow[] {
  const grand = roundHalfUp(Number(total) || 0, decimals);
  const count = Math.floor(Number(plan?.count) || 0);
  if (!(grand > 0) || count < 1) return [];
  if (count > MAX_INSTALLMENTS) throw new Error(`عدد الأقساط يتجاوز الحد المسموح (${MAX_INSTALLMENTS})`);

  const start = new Date(plan.startDate);
  if (Number.isNaN(start.getTime())) throw new Error('تاريخ أول قسط غير صالح');

  const unit = Math.pow(10, decimals);
  // الحساب بالوحدات الصغرى الصحيحة (هللات/فلوس) لا بالعائمة: القسمة العائمة
  // تُنتج أقساطاً بصفر في المبالغ الصغيرة (٠٫٠٣ ÷ ٣ = ٠٫٠٠٩٩٩… فتُقرَّب لأسفل
  // إلى صفر)، والصحيحُ لا يكذب.
  const grandUnits = Math.round(grand * unit);
  if (grandUnits < count) {
    throw new Error(`المبلغ لا يكفي لتقسيمه على ${count} قسطا`);
  }

  // القسمة لأسفل، والفارق كلّه يحمله القسط الأخير — وهو العرف التجاري المألوف
  const baseUnits = Math.floor(grandUnits / count);
  const rows: InstallmentRow[] = [];
  for (let i = 0; i < count - 1; i++) {
    rows.push({ seq: i + 1, dueDate: addPeriod(start, plan.period, i), amount: baseUnits / unit });
  }
  rows.push({
    seq: count,
    dueDate: addPeriod(start, plan.period, count - 1),
    amount: (grandUnits - baseUnits * (count - 1)) / unit,
  });
  return rows;
}

/**
 * يتحقّق من جدولٍ أرسلته الواجهة (حين يعدّل المستخدم المبالغ بيده).
 * يُقبل فقط إن ساوى مجموعه الإجماليَّ تماماً وكانت كل مبالغه موجبة.
 */
export function validateInstallments(
  rows: { dueDate: Date | string; amount: number }[],
  total: number,
  decimals = 2,
): { ok: true } | { ok: false; message: string } {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, message: 'جدول الأقساط فارغ' };
  if (rows.length > MAX_INSTALLMENTS) return { ok: false, message: `عدد الأقساط يتجاوز الحد المسموح (${MAX_INSTALLMENTS})` };

  for (const r of rows) {
    const a = Number(r.amount);
    if (!Number.isFinite(a) || a <= 0) return { ok: false, message: 'مبلغ القسط يجب أن يكون أكبر من صفر' };
    if (Number.isNaN(new Date(r.dueDate).getTime())) return { ok: false, message: 'تاريخ استحقاق قسط غير صالح' };
  }

  const unit = Math.pow(10, decimals);
  const sum = rows.reduce((s, r) => s + Math.round(Number(r.amount) * unit), 0);
  const grand = Math.round(roundHalfUp(Number(total) || 0, decimals) * unit);
  if (sum !== grand) {
    return { ok: false, message: 'مجموع الأقساط لا يساوي إجمالي الفاتورة' };
  }
  return { ok: true };
}
