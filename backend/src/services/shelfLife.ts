/**
 * صلاحية الصنف — مدةٌ بالأيام أو الأشهر أو السنوات تُحسب من **تاريخ التوريد**: تاريخ «الوارد» في مخزون الشركة
 * بتوقيت الشركة (لا UTC: وارد الساعة ١ فجراً بالرياض يومُه اليوم لا أمس).
 *
 * صرفةٌ بلا قاعدة: الخادم يحسب بها تاريخ الانتهاء عند الوارد ويحفظه مع سطره، واللوحة تعاينه بالقاعدة نفسها.
 */

export const SHELF_LIFE_UNITS = ['DAY', 'MONTH', 'YEAR'] as const;
export type ShelfLifeUnit = (typeof SHELF_LIFE_UNITS)[number];

/** سقفٌ معقول لكل وحدة (مئة سنة) — يمنع رقماً مكتوباً خطأً يصنع تاريخاً بلا معنى */
export const SHELF_LIFE_MAX: Readonly<Record<ShelfLifeUnit, number>> = Object.freeze({ DAY: 36500, MONTH: 1200, YEAR: 100 });

export interface ShelfLifeSettings {
  shelfLifeEnabled?: boolean | null;
  shelfLifeValue?: number | null;
  shelfLifeUnit?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * يضيف المدة إلى تاريخ YYYY-MM-DD. الأشهر والسنوات بالتقويم لا بعدد أيام ثابت، وتُقصّ إلى آخر الشهر:
 * ٣١ يناير + شهر = آخر فبراير (لا ٣ مارس)، و٢٩ فبراير + سنة = ٢٨ فبراير.
 */
export function addShelfLife(date: string, value: number, unit: ShelfLifeUnit): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`تاريخ غير صالح: ${date}`);
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  if (unit === 'DAY') return isoOf(new Date(Date.UTC(y, mo, d + value)));
  const total = mo + (unit === 'MONTH' ? value : value * 12);
  const ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return isoOf(new Date(Date.UTC(ny, nm, Math.min(d, lastDay))));
}

/** التاريخ المحلي YYYY-MM-DD للحظةٍ بمنطقة الشركة */
export function localDateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** صلاحية الصنف إن كانت مفعّلة ومكتملة، وإلا null */
export function shelfLifeOf(p: ShelfLifeSettings): { value: number; unit: ShelfLifeUnit } | null {
  if (!p.shelfLifeEnabled) return null;
  const unit = p.shelfLifeUnit as ShelfLifeUnit;
  const value = Number(p.shelfLifeValue);
  if (!(SHELF_LIFE_UNITS as readonly string[]).includes(unit) || !Number.isInteger(value) || value <= 0) return null;
  return { value, unit };
}

/**
 * تاريخ انتهاء صلاحية ما وُرِّد في لحظة `suppliedAt` — بصيغة تاريخٍ مجرّد (منتصف ليل UTC لعمود @db.Date).
 * null لصنفٍ بلا صلاحية مفعّلة.
 */
export function expiryDateFor(p: ShelfLifeSettings, suppliedAt: Date, timeZone: string): Date | null {
  const life = shelfLifeOf(p);
  if (!life) return null;
  return new Date(`${addShelfLife(localDateIn(suppliedAt, timeZone), life.value, life.unit)}T00:00:00.000Z`);
}

/**
 * يتحقّق من إعداد الصلاحية بعد دمجه مع المحفوظ: المفعّلة تلزمها مدةٌ صحيحة موجبة ووحدة، وفي حدود السقف.
 * يعيد رسالةً عربية للمستخدم أو null. والمطفأة تُقبل كما هي (تبقى المدة محفوظة لتعود عند إعادة التفعيل).
 */
export function shelfLifeProblem(p: ShelfLifeSettings): string | null {
  if (!p.shelfLifeEnabled) return null;
  if (!(SHELF_LIFE_UNITS as readonly string[]).includes(String(p.shelfLifeUnit))) return 'اختر وحدة مدة الصلاحية: أيام أو أشهر أو سنوات';
  const v = p.shelfLifeValue;
  if (v == null || !Number.isInteger(v) || v <= 0) return 'مدة الصلاحية يجب أن تكون عدداً صحيحاً أكبر من صفر';
  if (v > SHELF_LIFE_MAX[p.shelfLifeUnit as ShelfLifeUnit]) return 'مدة الصلاحية أطول من المعقول — راجع الرقم والوحدة';
  return null;
}
