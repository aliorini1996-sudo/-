/**
 * معاينة صلاحية الصنف في اللوحة — نسخةٌ من قاعدة الخادم (backend/src/services/shelfLife.ts) حرفياً، والخادم هو
 * الذي يحسب التاريخ ويسجّله عند البيع والمرتجع؛ هذه للعرض قبل الحفظ فقط. والاختبار يثبّت الحالات نفسها في الطرفين.
 */
export type ShelfLifeUnit = 'DAY' | 'MONTH' | 'YEAR';

export const SHELF_LIFE_UNIT_LABELS: Record<ShelfLifeUnit, string> = { DAY: 'أيام', MONTH: 'أشهر', YEAR: 'سنوات' };

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** يضيف المدة إلى تاريخ YYYY-MM-DD — الأشهر والسنوات بالتقويم وتُقصّ إلى آخر الشهر */
export function addShelfLife(date: string, value: number, unit: ShelfLifeUnit): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  if (unit === 'DAY') return isoOf(new Date(Date.UTC(y, mo, d + value)));
  const total = mo + (unit === 'MONTH' ? value : value * 12);
  const ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return isoOf(new Date(Date.UTC(ny, nm, Math.min(d, lastDay))));
}

/** تاريخ اليوم المحلي في المتصفّح YYYY-MM-DD */
export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** تاريخ الانتهاء لما يُباع اليوم، أو null لصنفٍ بلا صلاحية مكتملة */
export function previewExpiry(
  p: { shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null },
  today = todayLocal(),
): string | null {
  const v = Number(p.shelfLifeValue);
  const unit = p.shelfLifeUnit as ShelfLifeUnit;
  if (!p.shelfLifeEnabled || !Number.isInteger(v) || v <= 0 || !(unit in SHELF_LIFE_UNIT_LABELS)) return null;
  return addShelfLife(today, v, unit);
}
