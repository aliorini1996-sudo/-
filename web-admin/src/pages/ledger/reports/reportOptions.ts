/**
 * خيارات تقارير الدفاتر (M4، DESIGN.md §7.1، RPT‑02 إلى RPT‑07 وRPT‑15) — منطق **صرف**.
 *
 * بلا React وبلا axios وبلا `import.meta`، فلا استيراد فيه أصلاً: يقرؤه `tsx --test` مباشرةً
 * ويستورده كلٌّ من `ledgerReports.ts` (معاملات النقطة) و`ReportView.tsx` (شريط الخيارات).
 *
 * **العقد مقروء من المصدر لا من الذاكرة** — أسماء المعاملات وقيمها من
 * `backend/src/routes/ledger/reports.ts` (`optionsShape`، `resolveDateFilter`، `parseReportRequest`)
 * و`backend/src/services/gl/reports/{types,period}.ts`:
 * - أوضاع التاريخ: `month|quarter|fiscalYear|custom|asOf`، والمرساة `from` للأوضاع المشتقّة،
 *   و`asOf` مرادف `to` في «حتى تاريخ».
 * - المقارنة: `comparison=previousPeriod|sameLastYear` مع `comparisonCount` بين 1 و12.
 * - `postedOnly` (الافتراض `true`)، `unit` من 1|1000|1000000، `hierarchy`، `hideZero`، `search`.
 * - المبالغ في الردّ **نصّ عدد صحيح بالملّي** تحت مفتاح ينتهي بـ`Milli`: الوحدة ومنازل العملة
 *   تصييرٌ في الواجهة لا حساب على الخادم، فدوالّ العرض أدناه هي الموضع الوحيد الذي يقسم على الوحدة.
 *
 * **ثلاث قواعد تحكم هذا الملف:**
 * 1. لا حساب عائم على مبلغ: القسمة على الوحدة ونسبة التغيّر بـ`BigInt` (مطابقة `percentChange`
 *    في `services/gl/reports/trialBalance.ts` حرفياً، نصف‑لأعلى بعيداً عن الصفر).
 * 2. حالة الشاشة كلّها في عنوان الصفحة (query) فيكون التقرير قابلاً للمشاركة برابط، وأسماء
 *    المعاملات هي أسماء النقطة نفسها إلا `account` (مفرد في الرابط، `accounts` في النقطة) كما
 *    يقتضي عقد التعمّق.
 * 3. ما ساوى الافتراض لا يُكتب في الرابط — فلا يتضخّم رابط المشاركة بقيم لا تغيّر شيئاً.
 */

// ═══ الأنواع (مرآة backend/src/services/gl/reports/types.ts) ═══

/** تاريخ محلي 'YYYY-MM-DD' بلا منطقة زمنية (§2.5). */
export type LocalDate = string;

export const REPORT_DATE_MODES = ['month', 'quarter', 'fiscalYear', 'custom', 'asOf'] as const;
export type ReportDateMode = (typeof REPORT_DATE_MODES)[number];

export const REPORT_COMPARISON_KINDS = ['previousPeriod', 'sameLastYear'] as const;
export type ReportComparisonKind = (typeof REPORT_COMPARISON_KINDS)[number];

export const REPORT_UNITS = [1, 1000, 1_000_000] as const;
export type ReportUnit = (typeof REPORT_UNITS)[number];

/** مفاتيح التقارير المسلَّمة في M4 (‏`REPORT_KEYS` في `routes/ledger/reports.ts`). */
export const REPORT_KEYS = ['trial-balance', 'income-statement', 'balance-sheet', 'general-ledger', 'executive-summary'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** عدد أعمدة المقارنة 1..12 (§7.1). */
export const MAX_COMPARISON_COUNT = 12;
/** حدّ نصّ البحث كما في `MAX_SEARCH_LENGTH` على الخادم (RPT‑15). */
export const MAX_SEARCH_LENGTH = 200;
/** لا يُستدعى الخادم عند كل ضغطة مفتاح (§7.1 الأداء، قاعدة 0.1 CPU). */
export const SEARCH_DEBOUNCE_MS = 450;

export interface FiscalYearConfig {
  /** 1..12 */
  endMonth: number;
  /** 1..31 (يُقصّ إلى آخر يوم في الشهر) */
  endDay: number;
}

export const DEFAULT_FISCAL_YEAR: FiscalYearConfig = { endMonth: 12, endDay: 31 };

export interface DateRangeLocal { from: LocalDate; to: LocalDate }

/** حالة شريط الخيارات — هي نفسها ما يُكتب في عنوان الصفحة وما يُترجم إلى معاملات النقطة. */
export interface ReportOptionsState {
  mode: ReportDateMode;
  /** مرساة الأوضاع المشتقّة، وبداية المدى في `custom`، وتُهمَل في `asOf` */
  from: LocalDate;
  /** نهاية المدى في `custom`، وتاريخ «حتى» في `asOf`، وتُهمَل في غيرهما */
  to: LocalDate;
  comparison: ReportComparisonKind | null;
  /** 1..12، ولا معنى له بلا مقارنة */
  comparisonCount: number;
  /** RPT‑05: الافتراض `true` (المرحّلة فقط) */
  postedOnly: boolean;
  /** RPT‑06 */
  unit: ReportUnit;
  /** RPT‑07: التجميع ببادئة الرمز */
  hierarchy: boolean;
  /** RPT‑07 / RPT‑14 */
  hideZero: boolean;
  /** RPT‑15 */
  search: string;
  /** فلتر الحسابات (التعمّق ودفتر الأستاذ) — `account` في الرابط و`accounts` في النقطة */
  accounts: string[];
}

/** معاملات النقطة `GET /api/ledger/reports/:key` (وجسم التصدير معها `format`). */
export type ReportQueryParams = Record<string, string>;

// ═══ تواريخ محلية صرفة (مرآة backend/src/services/gl/dates.ts) ═══

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number) => String(n).padStart(2, '0');
const pad4 = (n: number) => String(n).padStart(4, '0');
const DAY_MS = 86_400_000;

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isLocalDate(v: unknown): v is LocalDate {
  if (typeof v !== 'string') return false;
  const mm = LOCAL_DATE_RE.exec(v);
  if (!mm) return false;
  const y = +mm[1];
  const m = +mm[2];
  const d = +mm[3];
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function ymd(date: LocalDate): { y: number; m: number; d: number } {
  const mm = LOCAL_DATE_RE.exec(date);
  if (!mm) throw new RangeError(`تاريخ محلي غير صالح: "${date}"`);
  return { y: +mm[1], m: +mm[2], d: +mm[3] };
}

const fmt = (y: number, m: number, d: number): LocalDate => `${pad4(y)}-${pad2(m)}-${pad2(d)}`;

const utcMs = (date: LocalDate): number => {
  const { y, m, d } = ymd(date);
  return Date.UTC(y, m - 1, d);
};

const fromUtcMs = (ms: number): LocalDate => {
  const t = new Date(ms);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

export function addDaysLocal(date: LocalDate, days: number): LocalDate {
  return fromUtcMs(utcMs(date) + Math.trunc(days) * DAY_MS);
}

/** b − a بالأيام. */
export function diffDaysLocal(a: LocalDate, b: LocalDate): number {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/** يضيف أشهراً مع قصّ اليوم إلى آخر الشهر (31 يناير + 1 = 28/29 فبراير) — كـ`addMonths` في الخادم. */
export function addMonthsLocal(date: LocalDate, months: number): LocalDate {
  const { y, m, d } = ymd(date);
  const idx = y * 12 + (m - 1) + Math.trunc(months);
  const ny = Math.floor(idx / 12);
  const nm = idx - ny * 12 + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function startOfMonthLocal(date: LocalDate): LocalDate {
  const { y, m } = ymd(date);
  return fmt(y, m, 1);
}

export function endOfMonthLocal(date: LocalDate): LocalDate {
  const { y, m } = ymd(date);
  return fmt(y, m, daysInMonth(y, m));
}

const fiscalEndIn = (y: number, fy: FiscalYearConfig): LocalDate =>
  fmt(y, fy.endMonth, Math.min(fy.endDay, daysInMonth(y, fy.endMonth)));

/** السنة المالية التي يقع فيها التاريخ (كـ`fiscalYearOf` في الخادم). */
export function fiscalYearRange(date: LocalDate, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): DateRangeLocal {
  const { y } = ymd(date);
  const endThis = fiscalEndIn(y, fy);
  const to = date <= endThis ? endThis : fiscalEndIn(y + 1, fy);
  return { from: addDaysLocal(fiscalEndIn(+to.slice(0, 4) - 1, fy), 1), to };
}

/**
 * الربع **المالي** الذي يحوي التاريخ: كتل ثلاثة أشهر من بداية السنة المالية
 * (كـ`fiscalQuarterOf` في `reports/period.ts`). مع سنة تقويمية يطابق الربع التقويمي.
 */
export function fiscalQuarterRange(date: LocalDate, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): DateRangeLocal {
  const year = fiscalYearRange(date, fy);
  for (let i = 0; i < 4; i++) {
    const qFrom = addMonthsLocal(year.from, 3 * i);
    const raw = addDaysLocal(addMonthsLocal(year.from, 3 * (i + 1)), -1);
    const qTo = i === 3 || raw > year.to ? year.to : raw;
    if (date <= qTo) return { from: qFrom, to: qTo };
  }
  return { from: addMonthsLocal(year.from, 9), to: year.to };
}

/** اليوم بالتقويم المحلي لمنطقة الشركة الزمنية (‏`todayLocal` في الخادم بمنطقة `settings.timezone`). */
export function todayInTimezone(timezone = 'Asia/Riyadh', now: Date = new Date()): LocalDate {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ═══ الفترة (RPT‑02، RPT‑03) ═══

/**
 * المدى الذي سيحسبه الخادم لهذه الحالة — مرآة `resolveReportPeriod`، **للعرض قبل وصول الردّ**
 * (ولتسمية أعمدة التصدير). الردّ نفسه يحمل `period` النهائية فهي المرجع بعد وصوله.
 *
 * `asOf` هنا [D, D] لا [FYStart(D), D]: المعروض للمستخدم هو تاريخ «حتى»، وامتداد المدى إلى بداية
 * السنة المالية تفصيلٌ محاسبي داخلي في §7.4 يعيده الخادم في `period`.
 */
export function resolvePeriodRange(state: ReportOptionsState, fy: FiscalYearConfig = DEFAULT_FISCAL_YEAR): DateRangeLocal {
  switch (state.mode) {
    case 'month':
      return { from: startOfMonthLocal(state.from), to: endOfMonthLocal(state.from) };
    case 'quarter':
      return fiscalQuarterRange(state.from, fy);
    case 'fiscalYear':
      return fiscalYearRange(state.from, fy);
    case 'asOf':
      return { from: state.to, to: state.to };
    case 'custom':
    default:
      return state.from <= state.to ? { from: state.from, to: state.to } : { from: state.to, to: state.from };
  }
}

/**
 * «السابق» و«التالي»: تُزاح **المرساة** بطول الوضع (شهر، ثلاثة أشهر، اثنا عشر شهراً)، و`custom`
 * بطول مداها بالأيام، و`asOf` بشهر. فالإزاحة لا تحتاج السنة المالية أصلاً: كتل الربع والسنة
 * مرتبطة ببدايتها، وإزاحة المرساة تقع في الكتلة المجاورة أياً كانت نهاية السنة المالية.
 */
export function shiftReportPeriod(state: ReportOptionsState, direction: 1 | -1): ReportOptionsState {
  const step = direction === 1 ? 1 : -1;
  switch (state.mode) {
    case 'month':
      return { ...state, from: startOfMonthLocal(addMonthsLocal(state.from, step)) };
    case 'quarter':
      return { ...state, from: addMonthsLocal(state.from, 3 * step) };
    case 'fiscalYear':
      return { ...state, from: addMonthsLocal(state.from, 12 * step) };
    case 'asOf':
      return { ...state, to: addMonthsLocal(state.to, step) };
    case 'custom':
    default: {
      const r = resolvePeriodRange(state);
      const len = diffDaysLocal(r.from, r.to) + 1;
      return { ...state, from: addDaysLocal(r.from, step * len), to: addDaysLocal(r.to, step * len) };
    }
  }
}

// ═══ الحالة الافتراضية والخصائص المتاحة لكل تقرير ═══

/**
 * الفترة الافتراضية لكل تقرير — **مرآة `defaultDateFilter` في الخادم حرفياً**: «حتى تاريخ» للميزانية
 * (§7.4)، والسنة المالية لقائمة الدخل (§7.3)، والشهر الحالي لما عداهما (§7.2) ومنه الملخّص التنفيذي.
 */
export function defaultDateMode(key: ReportKey): ReportDateMode {
  if (key === 'balance-sheet') return 'asOf';
  if (key === 'income-statement') return 'fiscalYear';
  return 'month';
}

export function defaultReportOptions(key: ReportKey, today: LocalDate): ReportOptionsState {
  return {
    mode: defaultDateMode(key),
    from: today,
    to: today,
    comparison: null,
    comparisonCount: 1,
    postedOnly: true,
    unit: 1,
    hierarchy: false,
    hideZero: false,
    search: '',
    accounts: [],
  };
}

/** الخيارات التي يعرضها شريط التقرير — وما لا يدعمه التقرير يُخفى بدل أن يُهمَل بصمت. */
export interface ReportFeatures {
  dateModes: readonly ReportDateMode[];
  comparison: boolean;
  hierarchy: boolean;
  unit: boolean;
  postedOnly: boolean;
  hideZero: boolean;
  search: boolean;
}

const ALL_MODES_BUT_AS_OF = REPORT_DATE_MODES.filter((m) => m !== 'asOf');

/**
 * §7.4: الميزانية «اعتباراً من» تاريخ واحد دائماً (الخادم يُجبر الوضع ويُنبّه `DATE_MODE_AS_OF`)،
 * فلا يُعرض لها وضعٌ آخر أصلاً. و§7.5: دفتر الأستاذ العام بلا أعمدة مقارنة ولا هرمية.
 */
export function reportFeatures(key: ReportKey): ReportFeatures {
  const base: ReportFeatures = {
    dateModes: ALL_MODES_BUT_AS_OF,
    comparison: true,
    hierarchy: true,
    unit: true,
    postedOnly: true,
    hideZero: true,
    search: true,
  };
  if (key === 'balance-sheet') return { ...base, dateModes: ['asOf'] };
  if (key === 'general-ledger') return { ...base, comparison: false, hierarchy: false };
  if (key === 'executive-summary') return { ...base, hierarchy: false, hideZero: false, search: false };
  return base;
}

/** يقصّ الحالة على ما يدعمه التقرير (وضع تاريخ غير متاح ⇒ الافتراضي). صرفة. */
export function clampToFeatures(state: ReportOptionsState, key: ReportKey): ReportOptionsState {
  const f = reportFeatures(key);
  const mode = f.dateModes.includes(state.mode) ? state.mode : f.dateModes[0];
  return {
    ...state,
    mode,
    comparison: f.comparison ? state.comparison : null,
    hierarchy: f.hierarchy ? state.hierarchy : false,
    hideZero: f.hideZero ? state.hideZero : false,
    search: f.search ? state.search : '',
    unit: f.unit ? state.unit : 1,
  };
}

// ═══ الحالة ⇄ عنوان الصفحة ⇄ معاملات النقطة ═══

const clampCount = (n: number): number =>
  Math.min(MAX_COMPARISON_COUNT, Math.max(1, Number.isFinite(n) ? Math.trunc(n) : 1));

const asUnit = (v: string | null): ReportUnit | null => {
  const n = Number(v);
  return n === 1 || n === 1000 || n === 1_000_000 ? n : null;
};

const asBool = (v: string | null): boolean | null =>
  v === null ? null : v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : null;

const asIds = (v: string | null): string[] => {
  if (!v) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v.split(',')) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

/**
 * يقرأ حالة الشريط من عنوان الصفحة (query) — فأي تقرير قابل للمشاركة برابط.
 * ما غاب أو كان غير صالح يعود لافتراضه بلا خطأ (رابطٌ مبتور يفتح التقرير لا شاشة عطل).
 */
export function parseReportOptions(
  query: string | URLSearchParams,
  opts: { reportKey: ReportKey; today: LocalDate; fiscalYear?: FiscalYearConfig },
): ReportOptionsState {
  const sp = typeof query === 'string' ? new URLSearchParams(query) : query;
  const base = defaultReportOptions(opts.reportKey, opts.today);
  const features = reportFeatures(opts.reportKey);
  const rawMode = sp.get('mode');
  const wanted = (REPORT_DATE_MODES as readonly string[]).includes(rawMode ?? '') ? (rawMode as ReportDateMode) : base.mode;
  // §7.4: الميزانية «حتى تاريخ» دائماً — يُقصّ الوضع **قبل** اشتقاق التواريخ فلا يضيع تاريخ الرابط
  const mode: ReportDateMode = features.dateModes.includes(wanted) ? wanted : features.dateModes[0];

  const pick = (k: string): LocalDate | null => (isLocalDate(sp.get(k)) ? (sp.get(k) as LocalDate) : null);
  const qFrom = pick('from');
  const qTo = pick('to');
  const qAsOf = pick('asOf');
  // ترتيب البدائل نفسه الذي في `resolveDateFilter` على الخادم
  const anchor: LocalDate = mode === 'asOf'
    ? qAsOf ?? qTo ?? qFrom ?? base.to
    : qFrom ?? qTo ?? base.from;
  const rangeTo: LocalDate = mode === 'custom' ? qTo ?? qFrom ?? base.to : anchor;

  const rawCmp = sp.get('comparison');
  const comparison = (REPORT_COMPARISON_KINDS as readonly string[]).includes(rawCmp ?? '') ? (rawCmp as ReportComparisonKind) : null;
  const postedOnly = asBool(sp.get('postedOnly'));
  const includeDrafts = asBool(sp.get('includeDrafts'));
  const state: ReportOptionsState = {
    mode,
    // في «حتى تاريخ» المرساة هي التاريخ نفسه، فلا يبقى `from` قديماً يضلّل «السابق/التالي»
    from: anchor,
    to: rangeTo,
    comparison,
    comparisonCount: clampCount(Number(sp.get('comparisonCount') ?? 1)),
    postedOnly: includeDrafts !== null ? !includeDrafts : postedOnly !== null ? postedOnly : base.postedOnly,
    unit: asUnit(sp.get('unit')) ?? base.unit,
    hierarchy: asBool(sp.get('hierarchy')) ?? base.hierarchy,
    hideZero: asBool(sp.get('hideZero')) ?? base.hideZero,
    search: (sp.get('search') ?? '').slice(0, MAX_SEARCH_LENGTH),
    // `account` مفرداً هو ما يكتبه رابط التعمّق، و`accounts` اسم المعامل على النقطة — يُقبلان معاً
    accounts: [...asIds(sp.get('account')), ...asIds(sp.get('accounts'))].filter((v, i, a) => a.indexOf(v) === i),
  };
  return clampToFeatures(state, opts.reportKey);
}

/** معاملات التاريخ وحدها (الثلاثة التي يقرؤها `resolveDateFilter`). صرفة. */
function dateParams(state: ReportOptionsState): ReportQueryParams {
  if (state.mode === 'asOf') return { mode: 'asOf', asOf: state.to };
  if (state.mode === 'custom') {
    const r = resolvePeriodRange(state);
    return { mode: 'custom', from: r.from, to: r.to };
  }
  return { mode: state.mode, from: state.from };
}

/**
 * حالة ⇒ معاملات النقطة (`GET /reports/:key`). ما ساوى الافتراض يُحذف، وفلتر الحسابات
 * يُرسَل تحت اسم النقطة `accounts`.
 */
export function reportQueryParams(state: ReportOptionsState, extra: ReportQueryParams = {}): ReportQueryParams {
  const p: ReportQueryParams = { ...dateParams(state) };
  if (state.comparison) {
    p.comparison = state.comparison;
    p.comparisonCount = String(clampCount(state.comparisonCount));
  }
  if (!state.postedOnly) p.postedOnly = 'false';
  if (state.unit !== 1) p.unit = String(state.unit);
  if (state.hierarchy) p.hierarchy = 'true';
  if (state.hideZero) p.hideZero = 'true';
  if (state.search.trim()) p.search = state.search.trim().slice(0, MAX_SEARCH_LENGTH);
  if (state.accounts.length > 0) p.accounts = state.accounts.join(',');
  return { ...p, ...extra };
}

/**
 * حالة ⇒ query عنوان الصفحة. كمعاملات النقطة تماماً إلا فلتر الحسابات: `account` مفرداً كما
 * يكتبه رابط التعمّق في العقد، فلا يحمل الرابط الاسمين لشيء واحد.
 */
export function reportSearchParams(state: ReportOptionsState): ReportQueryParams {
  const { accounts, ...rest } = reportQueryParams(state);
  return accounts ? { ...rest, account: accounts } : rest;
}

/** نصّ query للرابط (مرتّب المفاتيح فيتساوى رابطان لحالة واحدة). صرفة. */
export function reportSearchString(state: ReportOptionsState): string {
  const p = reportSearchParams(state);
  const sp = new URLSearchParams();
  for (const k of Object.keys(p).sort()) sp.set(k, p[k]);
  return sp.toString();
}

// ═══ التعمّق (§7.1) ═══

export const LEDGER_REPORTS_BASE = '/app/ledger/reports';

/**
 * كل مبلغ رابطٌ إلى دفتر الأستاذ العام للحساب ضمن الفترة نفسها (§7.1 «التعمّق»).
 * `mode=custom` جزءٌ لازم من الرابط: بدونه يقرأ دفتر الأستاذ `from` **مرساةً لشهر** فيفتح
 * على مدى غير الذي نُقر عليه.
 */
export function generalLedgerHref(accountId: string, range: DateRangeLocal, opts: { postedOnly?: boolean } = {}): string {
  const sp = new URLSearchParams({ account: accountId, mode: 'custom', from: range.from, to: range.to });
  if (opts.postedOnly === false) sp.set('postedOnly', 'false');
  return `${LEDGER_REPORTS_BASE}/general-ledger?${sp.toString()}`;
}

/** من سطر الأستاذ إلى قيده (§7.5). */
export function moveHref(moveId: string): string {
  return `/app/ledger/entries/${moveId}`;
}

// ═══ العرض: الوحدة ونسبة التغيّر (RPT‑04، RPT‑06) ═══

/** مبلغ الردّ: نصّ عدد صحيح بالملّي (أو رقم/BigInt من مصدر محلي). */
export type MilliInput = string | number | bigint | null | undefined;

/** يقرأ مبلغ الردّ ملّياً بلا فقد دقة؛ غير الصالح صفر (لا NaN يتسرّب إلى جدول محاسبي). */
export function toMilli(value: MilliInput): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.round(value)) : 0n;
  const s = value.trim();
  if (!/^[+-]?\d+$/.test(s)) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** عدد المنازل التي تكفي لتمثيل الملّي مقسوماً على الوحدة بلا تقريب: 3 و6 و9. */
export function unitScaleDigits(unit: ReportUnit): number {
  return unit === 1_000_000 ? 9 : unit === 1000 ? 6 : 3;
}

/**
 * ملّي ⇒ نصّ عشري **دقيق** بوحدة العرض (RPT‑06): `unit=1000` تقسم على ألف و`1000000` على مليون.
 * القسمة بـ`BigInt` بلا عائم، والناتج يُمرَّر إلى `LedgerAmount` فيقرّبه إلى منازل العملة ويلوّنه.
 */
export function milliToUnitString(value: MilliInput, unit: ReportUnit = 1): string {
  const digits = unitScaleDigits(unit);
  const v = toMilli(value);
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(digits + 1, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
}

/** وسم الوحدة تحت عنوان العمود («بالآلاف») — `null` للعملة فلا يُكتب شيء. */
export function unitSuffixKey(unit: ReportUnit): 'thousands' | 'millions' | null {
  return unit === 1000 ? 'thousands' : unit === 1_000_000 ? 'millions' : null;
}

/**
 * نسبة التغيّر بمنزلتين بلا عائم — **نسخة `percentChange` في `reports/trialBalance.ts` حرفياً**
 * (نصف‑لأعلى بعيداً عن الصفر)، فتطابق الواجهة `cell.percent` الذي يحسبه الخادم للميزان.
 * الأساس صفراً ⇒ `null` (لا «∞٪» ولا قسمة على صفر).
 */
export function percentChange(deltaMilli: MilliInput, baseMilli: MilliInput): number | null {
  const base = toMilli(baseMilli);
  if (base === 0n) return null;
  const absBase = base < 0n ? -base : base;
  const scaled = toMilli(deltaMilli) * 10_000n;
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const q = abs / absBase;
  const out = (abs % absBase) * 2n >= absBase ? q + 1n : q;
  return Number(neg ? -out : out) / 100;
}

/** نسبة تغيّر العمود الأساسي عن عمود مقارنة: (الأساسي − المقارَن) ÷ |المقارَن| (RPT‑04). */
export function changePercent(currentMilli: MilliInput, baseMilli: MilliInput): number | null {
  return percentChange(toMilli(currentMilli) - toMilli(baseMilli), baseMilli);
}

/** نصّ النسبة بعلامتها ومنزلتيها («+12.50٪»)، وشرطة حين لا نسبة. صرفة. */
export function formatPercent(pct: number | null, locale = 'en-US'): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const body = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(pct));
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  return `${sign}${body}٪`;
}
