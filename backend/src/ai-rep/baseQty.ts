/**
 * المندوب الذكي — الكميات **بوحدة الأساس** (الوحدات المتعددة للصنف، docs/multi-unit/DESIGN.md).
 *
 * المحرّكات كلّها (توقّع المحلات المشابهة، والطلب المتوقع من ملف Google، وحلقة التعلّم) تجمع كميات بنود الفواتير
 * وتأخذ وسيطها. وبندٌ بالكرتون (٢٤ حبة) وآخر بالحبّة من الصنف نفسه يُجمعان خاماً «١ + ١ = ٢» — رقمٌ بلا وحدة،
 * ووسيطٌ يقفز ٢٤ ضعفاً بين عميلين. فكلّ ما يُجمع أو يُقارَن أو يُؤخذ وسيطه هنا بالأساس، والوسم وحدة الأساس،
 * والعرض يفكّكه «٢ كرتون و٣ حبة» بوحدات الصنف (`qtyText`).
 */
import { Prisma } from '@prisma/client';
import { formatQty } from '../services/units';

/**
 * كمية بند الفاتورة (`invoice_items` بالاسم المستعار `ii`) بالأساس داخل SQL — مقطعٌ ثابت بلا قيم.
 *
 * العمود المخزَّن `baseQty` يحرسه مُطلِقٌ في القاعدة (scripts/backfillBaseQty)، والفارغ (صفٌّ لم يملأه الترحيل
 * بعد) يُحسب من اللقطة كما يحسبه المُطلِق نفسه: `qty × unitFactor`، والمعامل الصفريّ أو الفارغ ١ (`factorOf`).
 */
export const II_BASE_QTY = Prisma.sql`COALESCE(ii."baseQty", ii.qty * COALESCE(NULLIF(ii."unitFactor", 0), 1))`;

/** وحدة بيعٍ أكبر من الأساس كما يحتاجها العرض — الاسم وعدد وحدات الأساس فيها. */
export interface QtyUnit { name: string; factor: number }

/** `select` وحدات الصنف النشطة للعرض، من الأكبر. */
export const ACTIVE_UNITS_SELECT = { where: { isActive: true }, select: { name: true, factor: true }, orderBy: { factor: 'desc' as const } };

/** وحدات الصنف ← وحدات العرض: الأكبر من الأساس وحدها (معامل > ١)، أرقاماً لا Decimal. */
export function displayUnits(rows: ReadonlyArray<{ name: string; factor: number | string }> | null | undefined): QtyUnit[] {
  return (rows ?? [])
    .map(u => ({ name: String(u.name), factor: Number(u.factor) }))
    .filter(u => u.name && Number.isFinite(u.factor) && u.factor > 1)
    .sort((a, b) => b.factor - a.factor);
}

/** الكمية بوحداتها: «٢ كرتون و٣ حبة». صنفٌ بلا وحدات ⇒ «٥ حبة» حرفياً كما كان يُكتب `${qty} ${unit}`. */
export function qtyText(qty: number, units: ReadonlyArray<QtyUnit> | null | undefined, baseUnit: string): string {
  return formatQty(qty, [...(units ?? [])], baseUnit);
}

/** أحجام الوحدات للنموذج: «كرتون = 24 حبة» — فيعرف التحويل، وتصير أرقامه مسموحةً لحارس الأرقام. */
export function unitSizes(units: ReadonlyArray<QtyUnit> | null | undefined, baseUnit: string): string[] {
  return (units ?? []).map(u => `${u.name} = ${u.factor} ${baseUnit}`);
}
