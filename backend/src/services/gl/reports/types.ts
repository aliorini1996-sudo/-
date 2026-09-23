/**
 * عقد محرّك التقارير المشترك (M4، DESIGN.md §7.1، RPT‑02…RPT‑07، ADR‑9).
 *
 * صرف تماماً: لا prisma ولا I/O هنا ولا في balances.ts ولا period.ts — الطبقة الوحيدة التي تلمس
 * القاعدة هي `reports/load.ts`. المبالغ «ملّي» BigInt (§2.3)، والتواريخ نصوص محلية 'YYYY-MM-DD' (§2.5).
 */
import type { AccountType, LocalDate, Milli } from '../types';

// ═══ فلتر التاريخ (RPT‑02، RPT‑03) ═══

export const REPORT_DATE_MODES = ['month', 'quarter', 'fiscalYear', 'custom', 'asOf'] as const;
export type ReportDateMode = (typeof REPORT_DATE_MODES)[number];

export function isReportDateMode(v: unknown): v is ReportDateMode {
  return typeof v === 'string' && (REPORT_DATE_MODES as readonly string[]).includes(v);
}

/**
 * `{mode, from, to}` كما في §7.1.
 * - `month` و`quarter` و`fiscalYear`: `from` مرساة، والمدى يُشتق منها (والربع **ربع سنة مالية**، انظر period.ts).
 * - `custom`: المدى حرفياً، و`to` لا يسبق `from` (RPT‑03).
 * - `asOf`: «اعتباراً من» تاريخ واحد (§7.4 الميزانية) — `to` هو D، و`from` = بداية السنة المالية لـD
 *   حتى تكون حركة الفترة هي حركة السنة الجارية مباشرةً.
 */
export interface ReportDateFilter {
  mode: ReportDateMode;
  from: LocalDate;
  to: LocalDate;
}

// ═══ المقارنة (RPT‑04) ═══

export const REPORT_COMPARISON_KINDS = ['previousPeriod', 'sameLastYear'] as const;
export type ReportComparisonKind = (typeof REPORT_COMPARISON_KINDS)[number];

export function isReportComparisonKind(v: unknown): v is ReportComparisonKind {
  return typeof v === 'string' && (REPORT_COMPARISON_KINDS as readonly string[]).includes(v);
}

/** عدد أعمدة المقارنة 1..12 (§7.1). */
export const MAX_COMPARISON_COUNT = 12;

export interface ReportComparison {
  kind: ReportComparisonKind;
  /** عدد الفترات المقارَنة (1..12) */
  count: number;
}

// ═══ وحدة العرض والتقسيم (RPT‑06، RPT‑07) ═══

export const REPORT_UNITS = [1, 1000, 1_000_000] as const;
export type ReportUnit = (typeof REPORT_UNITS)[number];

export function isReportUnit(v: unknown): v is ReportUnit {
  return v === 1 || v === 1000 || v === 1_000_000;
}

export const REPORT_BREAKDOWNS = ['none', 'month', 'quarter', 'salesRep', 'analytic', 'journal'] as const;
export type ReportBreakdown = (typeof REPORT_BREAKDOWNS)[number];

export function isReportBreakdown(v: unknown): v is ReportBreakdown {
  return typeof v === 'string' && (REPORT_BREAKDOWNS as readonly string[]).includes(v);
}

/** تقسيمات لا يجيب عنها `gl_period_balances` (لا يحمل إلا الحساب والشهر) ⇒ وضع مسح البنود (§7.1). */
export const LINE_SCAN_BREAKDOWNS: readonly ReportBreakdown[] = ['salesRep', 'analytic', 'journal'];

/** سقف المدى في وضع مسح البنود: 12 شهراً، ولكل عمود مقارنة على حدة (§7.1). */
export const SCAN_RANGE_MAX_MONTHS = 12;

/** حد طول قوائم الفلاتر في طلب واحد (حماية من طلب ضخم؛ الواجهة لا ترسل أكثر). */
export const MAX_FILTER_IDS = 200;

/** حد طول نص البحث (RPT‑15) — كما في فلاتر القوائم القائمة. */
export const MAX_SEARCH_LENGTH = 200;

// ═══ الخيارات الموحّدة (RPT‑02 إلى RPT‑07) ═══

/**
 * خيارات كل تقارير §7. `postedOnly` و`includeDrafts` وجهان لمفتاح RPT‑05 نفسه ويبقيان متسقين
 * بعد `normalizeReportOptions` (‏`postedOnly === !includeDrafts`).
 *
 * الخيارات العرضية (`unit`, `hierarchy`, `hideZero`, `search`) **لا تؤثر في الأرصدة**: تُطبَّق في
 * طبقة التقرير نفسه (ميزان/دخل/ميزانية). والفلاتر (`journals`, `analytic`, `salesReps`) والتقسيم
 * تُطبَّق في `load.ts` وتفرض وضع مسح البنود.
 */
export interface ReportOptions {
  dateFilter: ReportDateFilter;
  comparison: ReportComparison | null;
  /** RPT‑05: المرحّلة فقط (الافتراضي) */
  postedOnly: boolean;
  /** RPT‑05: مع المسودات — دائماً `!postedOnly` */
  includeDrafts: boolean;
  /** RPT‑06 */
  unit: ReportUnit;
  /** RPT‑07: التجميع ببادئة الرمز */
  hierarchy: boolean;
  /** RPT‑07 / RPT‑14 */
  hideZero: boolean;
  /** معرّفات دفاتر (`GlJournal.id`) */
  journals: readonly string[];
  /** معرّفات حسابات تحليلية (`GlMoveLine.analyticAccountId`) */
  analytic: readonly string[];
  /** معرّفات مناديب (`GlMoveLine.salesRepId`) */
  salesReps: readonly string[];
  /** RPT‑15 */
  search: string;
  /** RPT‑16 / M11 */
  breakdown: ReportBreakdown;
}

export type ReportOptionsInput = Partial<Omit<ReportOptions, 'dateFilter'>> & { dateFilter: ReportDateFilter };

function idList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_FILTER_IDS) break;
  }
  return out;
}

function comparisonOf(v: ReportComparison | null | undefined): ReportComparison | null {
  if (!v || !isReportComparisonKind(v.kind)) return null;
  const n = Number(v.count);
  if (!Number.isFinite(n)) return { kind: v.kind, count: 1 };
  const count = Math.min(MAX_COMPARISON_COUNT, Math.max(1, Math.trunc(n)));
  return { kind: v.kind, count };
}

/** يملأ الافتراضات ويوحّد `postedOnly`/`includeDrafts` ويقصّ القوائم والبحث. صرفة. */
export function normalizeReportOptions(input: ReportOptionsInput): ReportOptions {
  const includeDrafts = input.includeDrafts ?? (input.postedOnly === undefined ? false : !input.postedOnly);
  return {
    dateFilter: input.dateFilter,
    comparison: comparisonOf(input.comparison),
    postedOnly: !includeDrafts,
    includeDrafts,
    unit: isReportUnit(input.unit) ? input.unit : 1,
    hierarchy: input.hierarchy === true,
    hideZero: input.hideZero === true,
    journals: idList(input.journals),
    analytic: idList(input.analytic),
    salesReps: idList(input.salesReps),
    search: typeof input.search === 'string' ? input.search.trim().slice(0, MAX_SEARCH_LENGTH) : '',
    breakdown: isReportBreakdown(input.breakdown) ? input.breakdown : 'none',
  };
}

// ═══ الفترة المحسوبة ═══

/** مدى التقرير بعد حلّ `dateFilter`، مع بداية السنة المالية لـ`from` (§7.2 قاعدة الافتتاحي). */
export interface ReportPeriod {
  from: LocalDate;
  to: LocalDate;
  /** بداية السنة المالية التي يقع فيها `from` */
  fyStart: LocalDate;
}

// ═══ الحسابات ═══

/** ما يحتاجه المحرّك من `GlAccount` (لا يقرأ غيره). */
export interface ReportAccount {
  id: string;
  code: string;
  name: string;
  nameI18n: Readonly<Record<string, string>> | null;
  type: AccountType;
}

// ═══ الأرصدة ═══

/**
 * رصيد حساب لفترة (§7.1).
 *
 * كل المبالغ صافية بقاعدة الإشارة `balance = debit − credit` إلا `debitMilli`/`creditMilli` فهما إجماليّا
 * الفترة. **بنود قيد إقفال السنة (`YYYY-CL`, `moveType=FY_CLOSING`) منفصلة تماماً** ولا تدخل
 * `openingMilli` ولا `preFyMilli` ولا `debitMilli/creditMilli` (§7.1 البند 4، §2.5):
 * - `closingMilli`: صافي بنود الإقفال الواقعة **داخل** `[from, to]`.
 * - `closingOpeningMilli`: صافي بنود الإقفال الواقعة **قبل** `from`.
 * فيطبّق كل تقرير قاعدته: ميزان المراجعة ينقلها لصف «أرباح سنوات سابقة» لحسابات قائمة الدخل
 * ويُبقيها في صف الحساب لحسابات الميزانية (313001)، والميزانية تحتسبها في حقوق الملكية (§7.4).
 */
export interface AccountBalance {
  accountId: string;
  /**
   * الرصيد الافتتاحي بقاعدة §7.2:
   * - حسابات الميزانية: Σ كل ما قبل `from` = `preFyMilli` + حركة [fyStart, from).
   * - حسابات قائمة الدخل (`income*`, `expense*`): حركة [fyStart, from) وحدها.
   */
  openingMilli: Milli;
  /** إجمالي مدين الفترة [from, to] بلا بنود الإقفال */
  debitMilli: Milli;
  /** إجمالي دائن الفترة [from, to] بلا بنود الإقفال */
  creditMilli: Milli;
  /** صافي بنود الإقفال (YYYY-CL) داخل [from, to] */
  closingMilli: Milli;
  /** صافي بنود الإقفال (YYYY-CL) قبل `from` */
  closingOpeningMilli: Milli;
  /** صافي ما قبل بداية السنة المالية (بلا بنود الإقفال) — مصدر صف «أرباح سنوات سابقة» (§7.2) */
  preFyMilli: Milli;
}

/** النافذة الزمنية التي يقع فيها تاريخ بالنسبة إلى الفترة. */
export type BalanceWindow = 'PRE_FY' | 'FY_OPENING' | 'PERIOD' | 'AFTER';

/** صف من `gl_period_balances` لشهر كامل (`periodKey` = 'YYYY-MM' حصراً؛ بنود CL لا تمرّ من هنا). */
export interface PeriodBalanceRow {
  accountId: string;
  periodKey: string;
  debitMilli: Milli;
  creditMilli: Milli;
}

/** بند من `gl_move_lines` (حافة جزئية، أو مسودة، أو بند إقفال، أو وضع مسح البنود). */
export interface BalanceLineRow {
  accountId: string;
  date: LocalDate;
  debitMilli: Milli;
  creditMilli: Milli;
  /** بند قيد إقفال سنة (`GlMove.moveType = 'FY_CLOSING'`) */
  closing: boolean;
  /** بند مسودة (`GlMove.state = 'DRAFT'`) */
  draft: boolean;
}

/** وضع القراءة (§7.1 «وضعان للحساب»). */
export type BalanceReadMode = 'AGGREGATE' | 'LINE_SCAN';

/** مخرَج `loadBalanceSources` — مدخل `composeBalances` مباشرةً. */
export interface BalanceSources {
  mode: BalanceReadMode;
  period: ReportPeriod;
  /** أرصدة الشهور الكاملة (فارغة في وضع مسح البنود) */
  periods: readonly PeriodBalanceRow[];
  /** الحواف الجزئية + المسودات + بنود الإقفال (وكل البنود في وضع المسح) */
  lines: readonly BalanceLineRow[];
  /** الشهور التي يقع داخلها حدّ فتُقرأ بنوداً لا أرصدةً مجمّعة */
  splitMonths: readonly string[];
  /** عدد قيود المسودة المقروءة (للتنبيه RPT‑08 ولا شيء غيره) */
  draftMoveCount: number;
}

/** يتطلب الخيار وضع مسح البنود؟ (§7.1: فلتر دفتر أو تحليلي أو مندوب، أو تقسيم لا يجيب عنه الشهر) */
export function requiresLineScan(opts: {
  journals?: readonly string[];
  analytic?: readonly string[];
  salesReps?: readonly string[];
  breakdown?: ReportBreakdown;
}): boolean {
  if ((opts.journals?.length ?? 0) > 0) return true;
  if ((opts.analytic?.length ?? 0) > 0) return true;
  if ((opts.salesReps?.length ?? 0) > 0) return true;
  return opts.breakdown !== undefined && LINE_SCAN_BREAKDOWNS.includes(opts.breakdown);
}
