/**
 * «طريقة توزيع الخطوط» في الواجهة (طلب المالك ٢٢ نوفمبر ٢٠٢٦): مندوبٌ له عدّة خطوطٍ دائمة، وكل يومٍ يُوجَّه إلى
 * واحدٍ منها — حسب أيام الأسبوع أو تناوباً بالترتيب. **خطّ اليوم يحسبه الخادم وحده** (services/routeSchedule.ts)
 * ويصل في الردّ؛ وهذه أدواتٌ نقيّة للنافذة: الأيام المحجوزة، وتبديل يوم، وتحريك خطٍّ في الترتيب.
 */

export type DistMode = 'single' | 'weekdays' | 'rotation';

/** 0=الأحد … 6=السبت — عرف الخادم (getUTCDay) */
export const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** راحة التناوب الافتراضية: الجمعة */
export const DEFAULT_OFF_DAYS = [5];

export const DIST_MODES: readonly { mode: DistMode; label: string }[] = [
  { mode: 'single', label: 'خط واحد يوميا' },
  { mode: 'weekdays', label: 'حسب أيام الأسبوع' },
  { mode: 'rotation', label: 'تناوب بالترتيب' },
];

/** نمط الجدول كما يُعرض: غياب الجدول = «خط واحد يومياً» */
export function modeOf(schedule: { mode?: string | null } | null | undefined): DistMode {
  return schedule?.mode === 'weekdays' || schedule?.mode === 'rotation' ? schedule.mode : 'single';
}

/** تبديل يومٍ في قائمة أيام — مرتّبةٌ بلا تكرار، وما خارج 0..6 يسقط */
export function toggleDay(days: readonly number[], d: number): number[] {
  const s = new Set(days.filter(x => Number.isInteger(x) && x >= 0 && x <= 6));
  if (s.has(d)) s.delete(d); else if (Number.isInteger(d) && d >= 0 && d <= 6) s.add(d);
  return [...s].sort((a, b) => a - b);
}

/**
 * الأيام التي تستعملها خطوط المندوب الأخرى ⇒ اسم الخطّ — تُعطَّل في محرّر الخطّ ويظهر اسم صاحبها.
 * `exceptId` الخطّ المُحرَّر نفسه: أيامه ليست محجوزةً عليه.
 */
export function takenDays(routes: readonly { id: string; name: string; weekdays?: number[] | null }[], exceptId?: string | null): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of routes) {
    if (exceptId && r.id === exceptId) continue;
    for (const d of r.weekdays ?? []) if (!out.has(d)) out.set(d, r.name);
  }
  return out;
}

/** تحريك عنصرٍ خطوةً للأعلى (-1) أو للأسفل (1) — نسخةٌ جديدة، والطرفان لا يتحرّكان */
export function moveItem<T>(list: readonly T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const c = [...list];
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}

export const sameList = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export interface RouteListRow {
  id: string; name: string; isPermanent: boolean; routeDate: string | null;
  salesRepId: string; salesRepName: string;
  weekdays?: number[] | null; rotationOrder?: number | null;
  scheduleMode?: string | null;
  /** خطّ اليوم بجدول المندوب — يحسبه الخادم */
  isToday?: boolean;
}

export interface RepGroup<R extends RouteListRow> {
  salesRepId: string; salesRepName: string; mode: DistMode;
  /** خطّ اليوم أو null (يوم راحة، أو يومٌ بلا خطّ) */
  today: R | null;
  /** الدائمة بترتيب الدورة ثم المؤقّتة كما جاءت (الأحدث يوماً أوّلاً) */
  permanents: R[]; dated: R[];
}

/** صفوف القائمة مجمّعةً لكل مندوب — المناديب بأسمائهم، ودوائم كلٍّ بترتيب دورته */
export function groupByRep<R extends RouteListRow>(rows: readonly R[]): RepGroup<R>[] {
  const by = new Map<string, RepGroup<R>>();
  for (const r of rows) {
    let g = by.get(r.salesRepId);
    if (!g) {
      g = { salesRepId: r.salesRepId, salesRepName: r.salesRepName, mode: modeOf({ mode: r.scheduleMode }), today: null, permanents: [], dated: [] };
      by.set(r.salesRepId, g);
    }
    (r.isPermanent ? g.permanents : g.dated).push(r);
    if (r.isToday && !g.today) g.today = r;
  }
  const groups = [...by.values()];
  for (const g of groups) {
    g.permanents = g.permanents.map((r, i) => ({ r, i }))
      .sort((a, b) => (a.r.rotationOrder ?? 0) - (b.r.rotationOrder ?? 0) || a.i - b.i)
      .map(x => x.r);
  }
  return groups.sort((a, b) => a.salesRepName.localeCompare(b.salesRepName, 'ar'));
}

/** أسماء الأيام بالترتيب مفصولةً — `name` تترجم الاسم (tr) */
export function daysText(days: readonly number[] | null | undefined, name: (ar: string) => string = (s) => s): string {
  return [...(days ?? [])].sort((a, b) => a - b).map(d => name(WEEKDAYS_AR[d] ?? String(d))).join(' · ');
}
