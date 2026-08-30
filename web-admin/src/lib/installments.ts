/**
 * معاينة جدول الأقساط في الواجهة.
 *
 * ⚠️ نسخة مطابقة لمنطق `backend/src/services/installments.ts` — والخادم هو من
 * يكتب الجدول الحقيقي من الإجمالي الذي يحسبه محرّكه. هذه للعرض قبل الإصدار
 * فقط، وتتطابق معه ما دام الإجمالي واحداً: كلاهما يحسب بالوحدات الصغرى
 * الصحيحة (هللات/فلوس) ويضع الفارق على القسط الأخير.
 *
 * ولماذا لا نعتمد على معاينة العميل في الكتابة: الضريبة وخانات العملة
 * و«الأسعار الشاملة» كلّها تُحسم في الخادم، فقد يخالف إجماليّه ما قدّرته
 * الواجهة بهللة — وجدولٌ مبنيّ على إجمالٍ خاطئ لا يساوي مجموعه الفاتورة.
 */

export type InstallmentPeriod = 'MONTHLY' | 'SEMI_MONTHLY' | 'WEEKLY';

export interface PreviewRow { seq: number; dueDate: Date; amount: number }

export const MAX_INSTALLMENTS = 60;

/** يضيف فترةً واحدة — الشهور بالتقويم فلا يقفز ٣١ يناير إلى مارس */
export function addPeriod(base: Date, period: InstallmentPeriod, steps: number): Date {
  const d = new Date(base.getTime());
  if (period === 'WEEKLY') { d.setDate(d.getDate() + 7 * steps); return d; }
  if (period === 'SEMI_MONTHLY') { d.setDate(d.getDate() + 15 * steps); return d; }
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + steps);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/**
 * معاينة الجدول. تُعيد قائمة فارغة حين يتعذّر التقسيم (مبلغ أصغر من عدد أقساطه)
 * — والواجهة تعرض حينها تنبيهاً بدل جدول كاذب.
 */
export function previewInstallments(
  total: number, count: number, firstDueDate: string | Date,
  period: InstallmentPeriod, decimals = 2,
): PreviewRow[] {
  const start = new Date(firstDueDate);
  const n = Math.floor(Number(count) || 0);
  if (!(Number(total) > 0) || n < 1 || Number.isNaN(start.getTime()) || n > MAX_INSTALLMENTS) return [];

  const unit = Math.pow(10, decimals);
  const units = Math.round(Number(total) * unit);
  if (units < n) return []; // لا يمكن إعطاء كل قسط وحدةً واحدة على الأقل

  const base = Math.floor(units / n);
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    dueDate: addPeriod(start, period, i),
    amount: (i < n - 1 ? base : units - base * (n - 1)) / unit,
  }));
}

/** تاريخ اليوم + شهر بصيغة YYYY-MM-DD — الافتراض المعقول لأول قسط */
export function defaultFirstDue(): string {
  const d = addPeriod(new Date(), 'MONTHLY', 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const PERIOD_LABELS: Record<InstallmentPeriod, string> = {
  MONTHLY: 'شهري',
  SEMI_MONTHLY: 'نصف شهري',
  WEEKLY: 'أسبوعي',
};
