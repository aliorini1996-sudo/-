/**
 * تواريخ الدفاتر (DESIGN.md §2.5، §7.8، §10.1 M1).
 *
 * التاريخ المحاسبي نص محلي 'YYYY-MM-DD' = localDate(instant, timezone) عبر Intl بلا مكتبات.
 * ساعة الإنتاج على UTC ولا يُعتمد على منطقتها: لا getDate/getMonth/getHours المحلية هنا —
 * الحساب التقويمي كله بـDate.UTC وgetUTC*.
 */
import type { LocalDate, TaxDeadlineRule } from './types';

export const DEFAULT_TIMEZONE = 'Asia/Riyadh';

const DAY_MS = 86_400_000;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ─── التحليل والتحقق ───

export interface YMD {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** آخر يوم في الشهر (m من 1 إلى 12). */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isLocalDate(v: unknown): v is LocalDate {
  if (typeof v !== 'string') return false;
  const mm = LOCAL_DATE_RE.exec(v);
  if (!mm) return false;
  const y = +mm[1], m = +mm[2], d = +mm[3];
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function parseLocalDate(s: LocalDate): YMD {
  if (!isLocalDate(s)) throw new RangeError(`تاريخ محلي غير صالح: "${s}" (المتوقع YYYY-MM-DD)`);
  const mm = LOCAL_DATE_RE.exec(s)!;
  return { y: +mm[1], m: +mm[2], d: +mm[3] };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad4 = (n: number) => String(n).padStart(4, '0');

export function formatLocalDate(y: number, m: number, d: number): LocalDate {
  const s = `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
  if (!isLocalDate(s)) throw new RangeError(`تاريخ غير صالح: ${y}-${m}-${d}`);
  return s;
}

// ─── المنطقة الزمنية ───

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function toInstant(instant: Date | string | number): Date {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new RangeError(`لحظة زمنية غير صالحة: ${String(instant)}`);
  return d;
}

interface ZonedParts extends YMD {
  hh: number;
  mi: number;
  ss: number;
}

function zonedParts(d: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour') % 24, mi: get('minute'), ss: get('second') };
}

/** التاريخ المحلي للشركة للحظة (§2.5): localDate(instant, tz). */
export function localDate(instant: Date | string | number, timeZone: string = DEFAULT_TIMEZONE): LocalDate {
  const p = zonedParts(toInstant(instant), timeZone);
  return formatLocalDate(p.y, p.m, p.d);
}

/** «اليوم» بتوقيت الشركة. */
export function todayLocal(now: Date, timeZone: string = DEFAULT_TIMEZONE): LocalDate {
  return localDate(now, timeZone);
}

/** فرق المنطقة عن UTC بالملّي ثانية عند لحظة معيّنة (الرياض = +3س). */
export function timeZoneOffsetMs(instant: Date | string | number, timeZone: string = DEFAULT_TIMEZONE): number {
  const d = toInstant(instant);
  const p = zonedParts(d, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/**
 * أول لحظة من اليوم المحلي (00:00 بتوقيت الشركة) — لحدود الاستعلام
 * `effectAt < zonedStartOfDay(newDate + 1 يوم, tz)` في lockSyncBlockers (§2.5).
 * يتعامل مع التوقيت الصيفي: إن لم توجد 00:00 (قفزة) تُعاد أول لحظة موجودة في ذلك اليوم.
 */
export function zonedStartOfDay(date: LocalDate, timeZone: string = DEFAULT_TIMEZONE): Date {
  const { y, m, d } = parseLocalDate(date);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - timeZoneOffsetMs(new Date(wall), timeZone);
  // تمريرتان تكفيان لاستقرار الفرق حول الانتقالات
  for (let i = 0; i < 2; i++) {
    const next = wall - timeZoneOffsetMs(new Date(t), timeZone);
    if (next === t) break;
    t = next;
  }
  // إن وقعت اللحظة في اليوم السابق محلياً (قفزة عند منتصف الليل) نتقدم إلى أول لحظة من اليوم
  if (localDate(t, timeZone) < date) {
    let lo = t, hi = t + 3 * 3_600_000;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDate(mid, timeZone) < date) lo = mid; else hi = mid;
    }
    t = hi;
  }
  return new Date(t);
}

// ─── تحويل @db.Date ───

/** تاريخ محلي ⇐ Date بمنتصف ليل UTC كما يخزّنه Prisma لعمود @db.Date. */
export function toDbDate(date: LocalDate): Date {
  parseLocalDate(date);
  return new Date(`${date}T00:00:00.000Z`);
}

/** Date من عمود @db.Date ⇐ تاريخ محلي (مكوّنات UTC حرفياً، بلا منطقة). */
export function fromDbDate(d: Date): LocalDate {
  const x = toInstant(d);
  return formatLocalDate(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}

// ─── الحساب التقويمي ───

function toUtcMs(date: LocalDate): number {
  const { y, m, d } = parseLocalDate(date);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): LocalDate {
  const x = new Date(ms);
  return formatLocalDate(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}

export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new RangeError(`عدد أيام غير صحيح: ${days}`);
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** b − a بالأيام. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** يضيف أشهراً مع قصّ اليوم إلى آخر الشهر (31 يناير + 1 = 28/29 فبراير). */
export function addMonths(date: LocalDate, months: number): LocalDate {
  if (!Number.isInteger(months)) throw new RangeError(`عدد أشهر غير صحيح: ${months}`);
  const { y, m, d } = parseLocalDate(date);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  return formatLocalDate(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** مقارنة معجمية آمنة لصيغة YYYY-MM-DD: سالب/صفر/موجب. */
export function compareLocalDate(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxLocalDate(...dates: LocalDate[]): LocalDate {
  if (dates.length === 0) throw new RangeError('maxLocalDate: لا تواريخ');
  return dates.reduce((a, b) => (b > a ? b : a));
}

export function minLocalDate(...dates: LocalDate[]): LocalDate {
  if (dates.length === 0) throw new RangeError('minLocalDate: لا تواريخ');
  return dates.reduce((a, b) => (b < a ? b : a));
}

export function startOfMonth(date: LocalDate): LocalDate {
  const { y, m } = parseLocalDate(date);
  return formatLocalDate(y, m, 1);
}

export function endOfMonth(date: LocalDate): LocalDate {
  const { y, m } = parseLocalDate(date);
  return formatLocalDate(y, m, daysInMonth(y, m));
}

/** 0=الأحد … 6=السبت (كـGlSettings.weekStartsOn). */
export function dayOfWeek(date: LocalDate): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

// ─── مفاتيح الفترات ───

/** مفتاح الشهر 'YYYY-MM' (GlPeriodBalance.periodKey، GlSequence الشهري). */
export function monthKey(date: LocalDate): string {
  parseLocalDate(date);
  return date.slice(0, 7);
}

/** مفتاح السنة التقويمية 'YYYY' (GlSequence السنوي). */
export function yearKey(date: LocalDate): string {
  parseLocalDate(date);
  return date.slice(0, 4);
}

/** مفتاح بنود قيد إقفال السنة 'YYYY-CL' (§2.5). */
export function closingPeriodKey(fiscalYearEnd: LocalDate): string {
  return `${yearKey(fiscalYearEnd)}-CL`;
}

/** أول يوم في أسبوع التاريخ حسب weekStartsOn (0=الأحد … 6=السبت). */
export function weekStart(date: LocalDate, weekStartsOn = 0): LocalDate {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError(`weekStartsOn خارج 0..6: ${weekStartsOn}`);
  }
  const back = (dayOfWeek(date) - weekStartsOn + 7) % 7;
  return addDays(date, -back);
}

/** مفتاح الأسبوع = تاريخ أول يوم فيه 'YYYY-MM-DD' — يرتَّب معجمياً ولا يلتبس عند حدود السنة. */
export function weekKey(date: LocalDate, weekStartsOn = 0): string {
  return weekStart(date, weekStartsOn);
}

// ─── السنة المالية (§2.5) ───

export interface FiscalYearRange {
  start: LocalDate;
  end: LocalDate;
}

/** نهاية السنة المالية في سنة تقويمية معيّنة، مع قصّ اليوم (29 فبراير في غير الكبيسة ⇒ 28). */
function fiscalEndIn(year: number, endMonth: number, endDay: number): LocalDate {
  return formatLocalDate(year, endMonth, Math.min(endDay, daysInMonth(year, endMonth)));
}

/** السنة المالية التي تحوي التاريخ، من fiscalYearEndMonth/Day (افتراضياً 12/31). */
export function fiscalYearOf(date: LocalDate, endMonth = 12, endDay = 31): FiscalYearRange {
  if (!Number.isInteger(endMonth) || endMonth < 1 || endMonth > 12) {
    throw new RangeError(`fiscalYearEndMonth خارج 1..12: ${endMonth}`);
  }
  if (!Number.isInteger(endDay) || endDay < 1 || endDay > 31) {
    throw new RangeError(`fiscalYearEndDay خارج 1..31: ${endDay}`);
  }
  const { y } = parseLocalDate(date);
  const endThis = fiscalEndIn(y, endMonth, endDay);
  const end = date <= endThis ? endThis : fiscalEndIn(y + 1, endMonth, endDay);
  const endYear = +end.slice(0, 4);
  const start = addDays(fiscalEndIn(endYear - 1, endMonth, endDay), 1);
  return { start, end };
}

export function fiscalYearStart(date: LocalDate, endMonth = 12, endDay = 31): LocalDate {
  return fiscalYearOf(date, endMonth, endDay).start;
}

export function fiscalYearEnd(date: LocalDate, endMonth = 12, endDay = 31): LocalDate {
  return fiscalYearOf(date, endMonth, endDay).end;
}

// ─── موعد الإقرار الضريبي (§6.6، §10.1 M1) ───

/**
 * الموعد النظامي لإقرار فترة تنتهي في periodEnd:
 * - END_OF_NEXT_MONTH (SA_6D): آخر يوم من الشهر التالي — لا periodEnd + 30.
 *   2027-01-31 ⇒ 2027-02-28، 2028-01-31 ⇒ 2028-02-29، 2027-03-31 ⇒ 2027-04-30.
 * - DAYS_AFTER (GENERIC_6D): periodEnd + taxDeadlineDays، والحقل إلزامي.
 */
export function taxDueDate(
  periodEnd: LocalDate,
  rule: TaxDeadlineRule,
  taxDeadlineDays?: number | null,
): LocalDate {
  if (rule === 'END_OF_NEXT_MONTH') {
    return endOfMonth(addMonths(startOfMonth(periodEnd), 1));
  }
  if (rule === 'DAYS_AFTER') {
    if (taxDeadlineDays == null || !Number.isInteger(taxDeadlineDays) || taxDeadlineDays < 0) {
      throw new RangeError('taxDeadlineDays إلزامي (عدد صحيح ≥ 0) مع قاعدة DAYS_AFTER');
    }
    return addDays(periodEnd, taxDeadlineDays);
  }
  throw new RangeError(`قاعدة موعد إقرار غير معروفة: ${String(rule)}`);
}
