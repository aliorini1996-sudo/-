// فترات يوم العمل (الدوام المتقطّع) في خليةٍ واحدة — مشتركة بين جدول الويب وشاشة الجوال وأوراق Excel/PDF.
// كل دخولٍ يُسجَّل وكل خروجٍ يُسجَّل: فترةٌ لكل حضور→انصراف ببصمة المندوب، والمندوب الذي يبصم ٩ص–١ظ ثم ٥م–٩م
// يظهر **صفّاً واحداً** لليوم: «٩:٠٠ ص – ١:٠٠ م · ٥:٠٠ م – ٩:٠٠ م» واستراحةٌ «٤ س» (ما بين انصرافه وحضوره التالي).
// لا كشفَ آلياً ولا عتبة زمنية: يومٌ بلا بصمة امتدادٌ واحد من أول أثرٍ إلى آخره (ACTIVITY) بلا استراحة.
// وأين حضر وأين انصرف: كل وقتٍ في الخلية رابطٌ لموقع بصمته على الخريطة، وورقة «تفاصيل البصمات» صفٌّ لكل فترة.
// الحساب كله في الخادم (backend/src/services/workDay.ts)؛ هنا العرض فقط.

import { mergeRuns, type CellMerge } from './mergeRuns';

type Tr = (ar: string) => string;

export interface WorkPeriodLike {
  start: string;
  /** null = نوبةٌ مفتوحة بلا انصراف */
  end: string | null;
  /** PUNCH = حضور→انصراف مسجَّلان ببصمة المندوب، ACTIVITY = يومٌ بلا بصمة: امتدادٌ واحد من أول أثرٍ إلى آخره */
  source?: 'PUNCH' | 'ACTIVITY';
  /** موقع بصمة الحضور (PUNCH) — null بلا التقاط، وغائبٌ من خادمٍ أقدم */
  inLat?: number | null; inLng?: number | null;
  /** موقع الانصراف الذي أنهى الفترة — null للمفتوحة أو بلا التقاط */
  outLat?: number | null; outLng?: number | null;
}

/** رابط خرائط Google لموقع — null متى غاب أحد الإحداثيين أو فسد (لا رابطٌ يفتح المحيط) */
export function mapsUrl(lat: number | null | undefined, lng: number | null | undefined): string | null {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** أين بصم الحضور */
export const punchInUrl = (p: WorkPeriodLike): string | null => mapsUrl(p.inLat, p.inLng);
/** أين بصم الانصراف — لا موقع لفترةٍ مفتوحة */
export const punchOutUrl = (p: WorkPeriodLike): string | null => (p.end ? mapsUrl(p.outLat, p.outLng) : null);
/** يومٌ فيه بصمةٌ واحدة على الأقل بموقعٍ معلوم */
export const hasPunchLocation = (d: WorkDayLike): boolean =>
  periodsOf(d).some(p => p.source === 'PUNCH' && !!(punchInUrl(p) || punchOutUrl(p)));

export interface WorkDayLike {
  firstActivity: string; lastActivity: string; absent: boolean;
  spanMinutes: number; appMinutes: number; visitsCount: number; visitsSec: number;
  /** اختياريّان: خادمٌ أقدم أثناء انزلاق النشر لا يرسلهما */
  periods?: WorkPeriodLike[];
  breakMinutes?: number;
}

/** فترات اليوم من الخادم، وإلّا (خادمٌ أقدم) فترةٌ واحدة من أول أثر إلى آخره — كما كان العرض */
export function periodsOf(d: WorkDayLike): WorkPeriodLike[] {
  if (d.absent) return [];
  if (Array.isArray(d.periods)) return d.periods;
  return [{ start: d.firstActivity, end: d.lastActivity, source: 'ACTIVITY' }];
}

/** دقائق الاستراحة: ما بين انصرافٍ والحضور التالي (٠ بلا بصمتين أو من خادمٍ أقدم) */
export const breakOf = (d: WorkDayLike): number => (d.absent ? 0 : Math.max(0, d.breakMinutes ?? 0));

/** نهاية اليوم: null متى كانت آخر فترة نوبةً مفتوحة — «آخر انصراف» قبلها ليس نهاية يومٍ ما زال جارياً */
export function dayEnd(d: WorkDayLike): string | null {
  const ps = periodsOf(d);
  const last = ps[ps.length - 1];
  if (last && last.end === null) return null;
  return d.lastActivity;
}

/** «٠٩:٠٠ ص – ٠١:٠٠ م · ٠٥:٠٠ م – ٠٩:٠٠ م» — والمفتوحة تنتهي بـ`openLabel` */
export function formatPeriods(periods: readonly WorkPeriodLike[], clock: (iso: string) => string, openLabel: string): string {
  return periods.map(p => `${clock(p.start)} – ${p.end ? clock(p.end) : openLabel}`).join(' · ');
}

/** مدّةٌ مختصرة بلا أصفار: «٤ س»، «٤ س ٣٠ د»، «٤٥ د» */
export function compactMinutes(min: number, tr: Tr): string {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h} ${tr('س')} ${m} ${tr('د')}`;
  if (h) return `${h} ${tr('س')}`;
  return `${m} ${tr('د')}`;
}

/**
 * خلايا اليوم في ورقة «الحضور اليومي» (بعد «المندوب» و«التاريخ») — ورقة كل المناديب وورقة المندوب
 * الواحد تبنيان من هنا فلا تنحرف إحداهما. «إجمالي وقت العمل» بلا الاستراحة (هكذا يرسله الخادم).
 */
export function attendanceDayCells(d: WorkDayLike, fx: {
  tr: Tr;
  clock: (iso: string) => string;
  minutes: (min: number) => string;
  visitDur: (sec: number | null) => string | null;
}): Record<string, unknown> {
  const { tr } = fx;
  const brk = breakOf(d);
  const end = dayEnd(d);
  return {
    [tr('بداية العمل')]: d.absent ? tr('لا نشاط') : fx.clock(d.firstActivity),
    [tr('نهاية العمل')]: d.absent ? tr('لا نشاط') : end ? fx.clock(end) : tr('لم ينصرف'),
    [tr('فترات العمل')]: d.absent ? '—' : formatPeriods(periodsOf(d), fx.clock, tr('لم ينصرف')),
    [tr('الاستراحة')]: brk > 0 ? compactMinutes(brk, tr) : '—',
    [tr('إجمالي وقت العمل')]: d.absent ? '—' : fx.minutes(d.spanMinutes),
    [tr('نشاط التطبيق')]: d.absent ? '—' : fx.minutes(d.appMinutes),
    [tr('عدد الزيارات')]: d.visitsCount,
    [tr('وقت داخل الزيارات')]: fx.visitDur(d.visitsSec) || '—',
  };
}

/**
 * ورقة «تفاصيل البصمات»: صفٌّ لكل فترة حضور→انصراف بموقعَي بصمتيها (رابط خريطة يصير قابلاً للنقر في Excel).
 * المندوب مرّةً لكل مندوب والتاريخ مرّةً لكل يوم (خلايا موحّدة) — لا تكرار في كل صفّ. أيام البصمة وحدها:
 * يومٌ بلا بصمة لا حضور فيه ولا انصراف يُذكر. `withRep` لورقة كل المناديب؛ ورقة المندوب الواحد بلا عموده.
 */
export function punchDetailRows(
  reps: ReadonlyArray<{ name: string; days: ReadonlyArray<WorkDayLike & { date: string }> }>,
  withRep: boolean,
  fx: { tr: Tr; clock: (iso: string) => string; minutes: (min: number) => string },
): { rows: Record<string, unknown>[]; merges: CellMerge[] } {
  const { tr } = fx;
  const items = reps.flatMap((r, ri) => r.days.flatMap(d => periodsOf(d)
    .filter(p => p.source === 'PUNCH')
    .map(p => ({ rep: String(ri), day: `${ri}|${d.date}`, row: {
      ...(withRep ? { [tr('المندوب')]: r.name } : {}),
      [tr('التاريخ')]: d.date,
      [tr('الحضور')]: fx.clock(p.start),
      [tr('موقع الحضور')]: punchInUrl(p) ?? tr('بلا موقع'),
      [tr('الانصراف')]: p.end ? fx.clock(p.end) : tr('لم ينصرف'),
      [tr('موقع الانصراف')]: p.end ? punchOutUrl(p) ?? tr('بلا موقع') : '—',
      // مدّة الفترة بتقريب الخادم نفسه — مجموعها يطابق «إجمالي وقت العمل» لليوم
      [tr('المدة')]: p.end ? fx.minutes(Math.max(0, Math.round((Date.parse(p.end) - Date.parse(p.start)) / 60000))) : '—',
    } as Record<string, unknown> }))));
  return mergeRuns(items.map(x => x.row), [
    ...(withRep ? [{ cols: [tr('المندوب')], keyOf: (i: number) => items[i].rep }] : []),
    { cols: [tr('التاريخ')], keyOf: (i: number) => items[i].day },
  ]);
}
