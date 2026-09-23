/**
 * حساب فترات التقارير والسنة المالية (M4، DESIGN.md §7.1 RPT‑02/RPT‑04، §7.2، §2.5).
 *
 * دوالّ صرفة بلا I/O: تأخذ `fiscalYearEndMonth/Day` من `GlSettings` وتُعيد مدياتٍ نصيّة محلية.
 * الحساب التقويمي كلّه مفوَّض إلى `services/gl/dates.ts` (لا تكرار، ولا دوال Date المحلية).
 */
import {
  addDays, addMonths, compareLocalDate, daysInMonth, diffDays, endOfMonth, fiscalYearEnd, fiscalYearOf,
  fiscalYearStart, monthKey, parseLocalDate, startOfMonth,
} from '../dates';
import type { LocalDate } from '../types';
import { SCAN_RANGE_MAX_MONTHS, type ReportComparison, type ReportDateFilter, type ReportPeriod } from './types';

// ═══ إعداد السنة المالية ═══

export interface FiscalYearConfig {
  /** 1..12 */
  endMonth: number;
  /** 1..31 (يُقصّ إلى آخر يوم في الشهر) */
  endDay: number;
}

export const DEFAULT_FISCAL_YEAR: FiscalYearConfig = { endMonth: 12, endDay: 31 };

/** يقرأ الإعداد من صف `GlSettings` (أو لقطته) مع الافتراض 12/31 (§2.5). */
export function fiscalYearConfigOf(
  settings: { fiscalYearEndMonth?: number | null; fiscalYearEndDay?: number | null } | null | undefined,
): FiscalYearConfig {
  const m = settings?.fiscalYearEndMonth;
  const d = settings?.fiscalYearEndDay;
  return {
    endMonth: Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 12 ? (m as number) : DEFAULT_FISCAL_YEAR.endMonth,
    endDay: Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 31 ? (d as number) : DEFAULT_FISCAL_YEAR.endDay,
  };
}

// ═══ أدوات الشهور ═══

/** هل التاريخ أول يوم في شهره؟ */
export function isMonthStart(date: LocalDate): boolean {
  return parseLocalDate(date).d === 1;
}

/** هل التاريخ آخر يوم في شهره؟ */
export function isMonthEnd(date: LocalDate): boolean {
  const { y, m, d } = parseLocalDate(date);
  return d === daysInMonth(y, m);
}

/** عدد الشهور التقويمية التي يلمسها المدى (مارس 10 ← أبريل 2 = شهران). */
export function monthSpan(from: LocalDate, to: LocalDate): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return (b.y * 12 + b.m) - (a.y * 12 + a.m) + 1;
}

/** مفاتيح الشهور 'YYYY-MM' من `from` إلى `to` ضمناً (تصاعدياً). */
export function monthKeysBetween(from: LocalDate, to: LocalDate): string[] {
  if (compareLocalDate(from, to) > 0) return [];
  const out: string[] = [];
  let cur = startOfMonth(from);
  const last = monthKey(to);
  for (;;) {
    const k = monthKey(cur);
    out.push(k);
    if (k >= last) break;
    cur = addMonths(cur, 1);
  }
  return out;
}

/** أول يوم في شهر بمفتاحه 'YYYY-MM'. */
export function monthKeyStart(key: string): LocalDate {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new RangeError(`مفتاح شهر غير صالح: "${key}"`);
  return `${key}-01`;
}

/** آخر يوم في شهر بمفتاحه 'YYYY-MM'. */
export function monthKeyEnd(key: string): LocalDate {
  return endOfMonth(monthKeyStart(key));
}

// ═══ بناء الفترة ═══

/** يبني `ReportPeriod` مع `fyStart` ويتحقق أنّ `to` لا يسبق `from` (RPT‑03). */
export function makePeriod(from: LocalDate, to: LocalDate, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): ReportPeriod {
  parseLocalDate(from);
  parseLocalDate(to);
  if (compareLocalDate(to, from) < 0) {
    throw new RangeError(`تاريخ النهاية ${to} يسبق تاريخ البداية ${from}`);
  }
  return { from, to, fyStart: fiscalYearStart(from, fy.endMonth, fy.endDay) };
}

/**
 * الربع **المالي** الذي يحوي التاريخ: كتل ثلاثة أشهر تبدأ من بداية السنة المالية.
 * مع سنة مالية تقويمية يطابق الربع التقويمي تماماً.
 */
export function fiscalQuarterOf(date: LocalDate, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): { from: LocalDate; to: LocalDate } {
  const year = fiscalYearOf(date, fy.endMonth, fy.endDay);
  for (let i = 0; i < 4; i++) {
    const qFrom = addMonths(year.start, 3 * i);
    const nextFrom = addMonths(year.start, 3 * (i + 1));
    const qToRaw = addDays(nextFrom, -1);
    const qTo = compareLocalDate(qToRaw, year.end) > 0 || i === 3 ? year.end : qToRaw;
    if (compareLocalDate(date, qTo) <= 0) return { from: qFrom, to: qTo };
  }
  return { from: addMonths(year.start, 9), to: year.end };
}

/**
 * يحلّ `dateFilter` إلى مدى (§7.1):
 * - `month` / `quarter` / `fiscalYear`: `from` مرساة.
 * - `custom`: المدى حرفياً.
 * - `asOf`: D = `to` (أو `from` إن غاب)، والمدى [FYStart(D), D] فتكون حركة الفترة حركة السنة الجارية (§7.4).
 */
export function resolveReportPeriod(filter: ReportDateFilter, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): ReportPeriod {
  switch (filter.mode) {
    case 'month': {
      const anchor = filter.from ?? filter.to;
      return makePeriod(startOfMonth(anchor), endOfMonth(anchor), fy);
    }
    case 'quarter': {
      const anchor = filter.from ?? filter.to;
      const q = fiscalQuarterOf(anchor, fy);
      return makePeriod(q.from, q.to, fy);
    }
    case 'fiscalYear': {
      const anchor = filter.from ?? filter.to;
      const y = fiscalYearOf(anchor, fy.endMonth, fy.endDay);
      return makePeriod(y.start, y.end, fy);
    }
    case 'asOf': {
      const d = filter.to ?? filter.from;
      return makePeriod(fiscalYearStart(d, fy.endMonth, fy.endDay), d, fy);
    }
    case 'custom':
    default:
      return makePeriod(filter.from, filter.to, fy);
  }
}

// ═══ المقارنة (RPT‑04) ═══

/** هل الفترة سنة مالية كاملة؟ (يُغيّر قاعدة الإزاحة: السنة المالية تُزاح سنةً لا 12 شهراً مقصوصاً) */
export function isFiscalYearPeriod(period: ReportPeriod, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): boolean {
  return period.from === period.fyStart && period.to === fiscalYearEnd(period.from, fy.endMonth, fy.endDay);
}

/** هل الفترة شهور كاملة (تبدأ أول شهر وتنتهي آخر شهر)؟ */
export function isWholeMonthPeriod(period: ReportPeriod): boolean {
  return isMonthStart(period.from) && isMonthEnd(period.to);
}

function clampCount(count: number): number {
  const n = Number.isFinite(count) ? Math.trunc(count) : 1;
  return Math.min(12, Math.max(1, n));
}

/** الفترات السابقة (الأقرب أولاً) بعدد `count`. */
export function previousPeriods(period: ReportPeriod, count = 1, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): ReportPeriod[] {
  const n = clampCount(count);
  const out: ReportPeriod[] = [];
  if (isFiscalYearPeriod(period, fy)) {
    let cursor = period.from;
    for (let i = 0; i < n; i++) {
      const y = fiscalYearOf(addDays(cursor, -1), fy.endMonth, fy.endDay);
      out.push(makePeriod(y.start, y.end, fy));
      cursor = y.start;
    }
    return out;
  }
  if (isWholeMonthPeriod(period)) {
    const k = monthSpan(period.from, period.to);
    for (let i = 1; i <= n; i++) {
      out.push(makePeriod(startOfMonth(addMonths(period.from, -k * i)), endOfMonth(addMonths(period.to, -k * i)), fy));
    }
    return out;
  }
  const len = diffDays(period.from, period.to) + 1;
  for (let i = 1; i <= n; i++) {
    out.push(makePeriod(addDays(period.from, -len * i), addDays(period.to, -len * i), fy));
  }
  return out;
}

/** المدة نفسها من السنوات الماضية (الأقرب أولاً) بعدد `count`. */
export function sameLastYearPeriods(period: ReportPeriod, count = 1, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): ReportPeriod[] {
  const n = clampCount(count);
  if (isFiscalYearPeriod(period, fy)) return previousPeriods(period, n, fy);
  const out: ReportPeriod[] = [];
  for (let i = 1; i <= n; i++) {
    const from = addMonths(period.from, -12 * i);
    const to = addMonths(period.to, -12 * i);
    out.push(isWholeMonthPeriod(period) ? makePeriod(startOfMonth(from), endOfMonth(to), fy) : makePeriod(from, to, fy));
  }
  return out;
}

/** أعمدة المقارنة كما في §7.1 (فارغة بلا مقارنة). */
export function comparisonPeriods(
  period: ReportPeriod,
  comparison: ReportComparison | null | undefined,
  fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR,
): ReportPeriod[] {
  if (!comparison) return [];
  return comparison.kind === 'sameLastYear'
    ? sameLastYearPeriods(period, comparison.count, fy)
    : previousPeriods(period, comparison.count, fy);
}

// ═══ تقسيم الشهور بين «مجمّع» و«بنود» (§7.1 المصدران 1 و2) ═══

/**
 * الشهور التي يقع داخلها حدّ (`fyStart` أو `from` أو `to`) فلا تصلح أرصدتها المجمّعة ويلزم مسح بنودها.
 * ما عداها شهور كاملة تقع بتمامها في نافذة واحدة (PRE_FY أو FY_OPENING أو PERIOD).
 */
export function splitMonthKeys(period: ReportPeriod): string[] {
  const keys = new Set<string>();
  if (!isMonthStart(period.fyStart)) keys.add(monthKey(period.fyStart));
  if (!isMonthStart(period.from)) keys.add(monthKey(period.from));
  if (!isMonthEnd(period.to)) keys.add(monthKey(period.to));
  return [...keys].sort();
}

/** مديات التواريخ التي تُقرأ بنوداً لحواف الشهور الجزئية (شهر كامل لكل مفتاح مقسوم). */
export function splitMonthRanges(period: ReportPeriod): { from: LocalDate; to: LocalDate }[] {
  return splitMonthKeys(period).map((k) => ({ from: monthKeyStart(k), to: monthKeyEnd(k) }));
}

// ═══ سقف وضع المسح (§7.1) ═══

/** هل يتجاوز المدى سقف وضع مسح البنود (12 شهراً)؟ */
export function exceedsScanRange(period: { from: LocalDate; to: LocalDate }, cap = SCAN_RANGE_MAX_MONTHS): boolean {
  return monthSpan(period.from, period.to) > cap;
}
