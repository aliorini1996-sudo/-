// ============================================================================
// توزيع خطوط السير على الأيام (طلب المالك ٢٢ نوفمبر ٢٠٢٦): مندوبٌ له عدّة خطوطٍ دائمة، وكلّ يومٍ يُوجَّه إلى
// واحدٍ منها — **حسب أيام الأسبوع** (لكل خطٍّ أيّامه) أو **تناوباً بالترتيب** الذي يضعه المالك (يومٌ لكل خطّ
// وتُتخطّى أيام الراحة). ومن لا جدول له باقٍ على القديم: خطٌّ دائمٌ واحد كل يوم.
//
// دالّةٌ نقيّة بلا قاعدة بيانات: «خطّ اليوم» يُحسب منها وحدها في كل موضع — routeFor (تطبيق المندوب وخريطة
// التتبّع عبر /mine)، وعلامة «اليوم» في قائمة الإدارة، ونافذة الجدول — فلا تختلف شاشتان على خطّ اليوم.
// ============================================================================

/** نمطا الجدول المخزَّنان — و«خط واحد يومياً» غيابُ الجدول نفسه (السلوك القديم) */
export const SCHEDULE_MODES = ['weekdays', 'rotation'] as const;
export type ScheduleMode = typeof SCHEDULE_MODES[number];

/** أيام الراحة الافتراضية في التناوب: الجمعة */
export const DEFAULT_OFF_DAYS: readonly number[] = [5];

/** 0=الأحد … 6=السبت — عرف getUTCDay */
export const WEEKDAY_NAMES_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;

export interface PickableRoute {
  id: string;
  isPermanent: boolean;
  routeDate: string | null;
  isActive?: boolean | null;
  createdAt: Date | string;
  weekdays?: number[] | null;
  rotationOrder?: number | null;
}

export interface PickSchedule {
  mode: string;
  rotationStart: string | null;
  offDays?: number[] | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86400000;

/** 'YYYY-MM-DD' ⇒ منتصف ليل ذلك اليوم UTC بالمللي، أو null لنصٍّ ليس تاريخاً حقيقياً (2026-02-30) */
export function dayMs(day: string): number | null {
  if (!DAY_RE.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t;
}

export const isValidDay = (day: string): boolean => dayMs(day) !== null;

/**
 * يوم الأسبوع **من نصّ التاريخ نفسه** (0=الأحد…6=السبت) — UTC صريحاً، فلا تنزلق منطقة الخادم الزمنية
 * بالسبت إلى الجمعة. اليوم المحسوب هنا هو يوم المندوب كما وصل (dayOf في المسار).
 */
export function weekdayOf(day: string): number {
  const t = dayMs(day);
  if (t === null) return -1;
  return new Date(t).getUTCDay();
}

const cleanDays = (days: readonly number[] | null | undefined): Set<number> =>
  new Set((days ?? []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6));

/**
 * أيام العمل (غير أيام الراحة) من `start` حتى `day` **دون** `day` نفسه — موضع `day` في دورة التناوب.
 * بالأسابيع الكاملة ثم الباقي، فلا حلقة على مئات الأيام لتناوبٍ بدأ قبل سنة.
 */
export function workDaysBetween(start: string, day: string, offDays: readonly number[]): number {
  const a = dayMs(start), b = dayMs(day);
  if (a === null || b === null) return 0;
  const diff = Math.round((b - a) / MS_DAY);
  if (diff <= 0) return 0;
  const off = cleanDays(offDays);
  const weeks = Math.floor(diff / 7);
  let n = weeks * (7 - off.size);
  const startWd = new Date(a).getUTCDay();
  for (let i = weeks * 7; i < diff; i++) if (!off.has((startWd + i) % 7)) n++;
  return n;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/** ترتيب الدورة: rotationOrder ثم الأقدم إنشاءً ثم المعرّف — ثابتٌ مهما جاء ترتيب الاستعلام */
export function orderRoutes<R extends Pick<PickableRoute, 'id' | 'createdAt' | 'rotationOrder'>>(routes: readonly R[]): R[] {
  return [...routes].sort((x, y) =>
    (x.rotationOrder ?? 0) - (y.rotationOrder ?? 0)
    || ms(x.createdAt) - ms(y.createdAt)
    || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * خطّ هذا اليوم من خطوط المندوب:
 *  (أ) المؤقّت لهذا اليوم بعينه يفوز دائماً (كما كان) — ولا يُزيح دورة التناوب: يأخذ دور يومه فقط؛
 *  (ب) بلا جدول ⇒ السلوك القديم: أوّل خطٍّ دائم؛
 *  (ج) «حسب أيام الأسبوع» ⇒ الخطّ الذي أيّامه تشمل يوم الأسبوع، وإلا فلا خطّ ذلك اليوم؛
 *  (د) «تناوب بالترتيب» ⇒ يوم الراحة بلا خطّ، وما قبل بداية التناوب بلا خطّ، وإلا فالخطّ رقم
 *      (أيام العمل من البداية حتى اليوم) باقي القسمة على عدد الخطوط؛
 *  (هـ) الموقوف لا يُقرأ، والدائم لا يسري على يومٍ سبق إنشاءه (نهاية ذلك اليوم هي الحدّ) — فالدورة لليوم
 *      الماضي تُحسب بالخطوط التي كانت موجودةً فيه، ولا يُتّهم المندوب بخطّةٍ لم تكن.
 */
export function pickRouteForDay<R extends PickableRoute>(day: string, schedule: PickSchedule | null | undefined, routes: readonly R[]): R | null {
  const start = dayMs(day);
  if (start === null) return null;
  const endOfDay = start + MS_DAY;
  const live = routes.filter(r => r.isActive !== false);

  const dated = live.find(r => !r.isPermanent && r.routeDate === day);
  if (dated) return dated;

  const perms = orderRoutes(live.filter(r => r.isPermanent && ms(r.createdAt) < endOfDay));
  if (!perms.length) return null;
  if (!schedule) return perms[0];

  if (schedule.mode === 'weekdays') {
    const wd = weekdayOf(day);
    return perms.find(r => cleanDays(r.weekdays).has(wd)) ?? null;
  }

  if (schedule.mode === 'rotation') {
    const off = [...cleanDays(schedule.offDays ?? DEFAULT_OFF_DAYS)];
    if (off.includes(weekdayOf(day))) return null;
    const from = schedule.rotationStart ? dayMs(schedule.rotationStart) : null;
    if (from === null || start < from) return null;
    return perms[workDaysBetween(schedule.rotationStart!, day, off) % perms.length];
  }

  // نمطٌ لا يعرفه هذا الإصدار ⇒ السلوك القديم لا يومٌ بلا خطّ
  return perms[0];
}

/**
 * أوّل يومٍ من `days` يستعمله خطٌّ آخر للمندوب — «حسب أيام الأسبوع» لكل يومٍ خطٌّ واحد، وإلا صار «ما خطّ
 * سيري اليوم؟» سؤالاً بجوابين.
 */
export function weekdayConflict<R extends { id: string; name: string; weekdays?: number[] | null }>(
  others: readonly R[], days: readonly number[],
): { day: number; routeId: string; name: string } | null {
  const want = cleanDays(days);
  for (const d of [...want].sort((a, b) => a - b)) {
    const r = others.find(o => cleanDays(o.weekdays).has(d));
    if (r) return { day: d, routeId: r.id, name: r.name };
  }
  return null;
}

/** أوّل تعارض أيامٍ بين خطوط المندوب نفسها — قبل التحويل إلى «حسب أيام الأسبوع» */
export function firstInternalConflict<R extends { id: string; name: string; weekdays?: number[] | null }>(
  routes: readonly R[],
): { day: number; a: string; b: string } | null {
  for (let i = 0; i < routes.length; i++) {
    const c = weekdayConflict(routes.slice(0, i), routes[i].weekdays ?? []);
    if (c) return { day: c.day, a: c.name, b: routes[i].name };
  }
  return null;
}

export const weekdayConflictMessage = (day: number, name: string): string =>
  `يوم ${WEEKDAY_NAMES_AR[day] ?? day} مستخدمٌ في خط «${name}» — لكل يومٍ خطٌّ واحد`;
