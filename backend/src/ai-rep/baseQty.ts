/**
 * المندوب الذكي — الكميات **بوحدة الأساس** (الوحدات المتعددة للصنف، docs/multi-unit/DESIGN.md).
 *
 * المحرّكات كلّها (توقّع المحلات المشابهة، والطلب المتوقع من ملف Google، وحلقة التعلّم) تجمع كميات بنود الفواتير
 * وتأخذ وسيطها. وبندٌ بالكرتون (٢٤ حبة) وآخر بالحبّة من الصنف نفسه يُجمعان خاماً «١ + ١ = ٢» — رقمٌ بلا وحدة،
 * ووسيطٌ يقفز ٢٤ ضعفاً بين عميلين. فكلّ ما يُجمع أو يُقارَن أو يُؤخذ وسيطه هنا بالأساس، والوسم وحدة الأساس،
 * والعرض يفكّكه «٢ كرتون و٣ حبة» بوحدات الصنف (`qtyText`).
 */
import { Prisma } from '@prisma/client';
import { formatQty, primaryUnitOf } from '../services/units';

/**
 * كمية بند الفاتورة (`invoice_items` بالاسم المستعار `ii`) بالأساس داخل SQL — مقطعٌ ثابت بلا قيم.
 *
 * العمود المخزَّن `baseQty` يحرسه مُطلِقٌ في القاعدة (scripts/backfillBaseQty)، والفارغ (صفٌّ لم يملأه الترحيل
 * بعد) يُحسب من اللقطة كما يحسبه المُطلِق نفسه: `qty × unitFactor`، والمعامل الصفريّ أو الفارغ ١ (`factorOf`).
 */
export const II_BASE_QTY = Prisma.sql`COALESCE(ii."baseQty", ii.qty * COALESCE(NULLIF(ii."unitFactor", 0), 1))`;

/**
 * وحدة بيعٍ أكبر من الأساس كما يحتاجها العرض — الاسم وعدد وحدات الأساس فيها. و`id` معرّف الوحدة (صفٌّ من القاعدة)،
 * و`primary` وسم «الوحدة الرئيسية» (القاعدة ١٢، عرضٌ وحده) يضعه `displayUnits` على رئيسيّةٍ صالحة فقط — فيحملها
 * الصنف مع وحداته عبر المحرّكات بلا حقلٍ جديد في أنواعها، ويقف `qtyText` عندها «52 كرتون و2 قارورة».
 */
export interface QtyUnit { id?: string; name: string; factor: number; primary?: true }

/** `select` وحدات الصنف النشطة للعرض، من الأكبر. */
export const ACTIVE_UNITS_SELECT = { where: { isActive: true }, select: { id: true, name: true, factor: true }, orderBy: { factor: 'desc' as const } };

/**
 * وحدات الصنف ← وحدات العرض: الأكبر من الأساس وحدها (معامل > ١)، أرقاماً لا Decimal، بمعرّفها إن حضر.
 * و`primaryUnitId` (اختياري) يَسِم الرئيسية الصالحة (`primaryUnitOf`) بـ`primary: true`؛ غيابه أو null أو معرّفٌ تالف
 * ⇒ الوحدات بلا وسم، كما قبل الميزة.
 */
export function displayUnits(
  rows: ReadonlyArray<{ id?: string | null; name: string; factor: number | string }> | null | undefined,
  primaryUnitId?: string | null,
): QtyUnit[] {
  const units: QtyUnit[] = (rows ?? [])
    .map(u => ({ ...(u.id ? { id: String(u.id) } : {}), name: String(u.name), factor: Number(u.factor) }))
    .filter(u => u.name && Number.isFinite(u.factor) && u.factor > 1)
    .sort((a, b) => b.factor - a.factor);
  const prim = primaryUnitOf({ primaryUnitId, units });
  return prim ? units.map(u => (u === prim ? { ...u, primary: true as const } : u)) : units;
}

/** معرّف الوحدة الرئيسية الموسومة في وحدات العرض (`displayUnits`)، أو null — ليعرضها الجهاز بـunitsText */
export function primaryIdOf(units: ReadonlyArray<QtyUnit> | null | undefined): string | null {
  return (units ?? []).find(u => u.primary && u.id)?.id ?? null;
}

/**
 * الكمية بوحداتها: «٢ كرتون و٣ حبة». صنفٌ بلا وحدات ⇒ «٥ حبة» حرفياً كما كان يُكتب `${qty} ${unit}`.
 * ولصنفٍ له وحدة رئيسية (`primaryUnitId` صريحاً، وإلّا الوحدة الموسومة `primary`) يقف عندها: «52 كرتون و2 قارورة».
 */
export function qtyText(qty: number, units: ReadonlyArray<QtyUnit> | null | undefined, baseUnit: string, primaryUnitId?: string | null): string {
  const list = [...(units ?? [])];
  return formatQty(qty, list, baseUnit, primaryUnitOf({ primaryUnitId: primaryUnitId ?? primaryIdOf(list), units: list }));
}

/** أحجام الوحدات للنموذج: «كرتون = 24 حبة» — فيعرف التحويل، وتصير أرقامه مسموحةً لحارس الأرقام. */
export function unitSizes(units: ReadonlyArray<QtyUnit> | null | undefined, baseUnit: string): string[] {
  return (units ?? []).map(u => `${u.name} = ${u.factor} ${baseUnit}`);
}
