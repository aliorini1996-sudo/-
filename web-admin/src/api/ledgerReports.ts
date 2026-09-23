import api from './client';
import type { LedgerEnvelope } from './ledgerConfig';
import type { LocalDate, ReportComparisonKind, ReportDateMode, ReportKey, ReportQueryParams, ReportUnit } from '../pages/ledger/reports/reportOptions';

/**
 * عميل تقارير الدفاتر — `GET /api/ledger/reports/:key` و`POST /api/ledger/reports/:key/export`
 * (M4، ملحق أ، DESIGN.md §7.1). مُوفَّق حرفياً مع `backend/src/routes/ledger/reports.ts`:
 *
 * - الردّ `{success, data: {...}}` بعقدٍ موحّد لكل التقارير: `reportKey` و`period` و`dateFilter`
 *   و`options` و`settings` و`mode` و`rows` و`totals` و`comparison` و`pagination` و`lineCount`
 *   و`warnings`، ويُنشَر بجوارها ما يخصّ التقرير (`columns` للميزان، `comparisonColumns` و`asOf`
 *   للقوائم، `sections` لدفتر الأستاذ…) — ولذلك فهرس `[extra: string]: unknown` أدناه.
 * - **كل مبلغ نصّ عدد صحيح بالملّي** تحت مفتاح ينتهي بـ`Milli` (قرار M4): لا تنسيق ولا تقريب ولا
 *   وحدة عرض على الخادم. القسمة على وحدة العرض وتنسيقها في `reports/reportOptions.ts` وحده.
 * - التصدير **لا يصدّر مما على الشاشة أبداً** (§7.1 البند 4): النقطة نفسها بجسمها نفسه مضافاً
 *   إليه `format`، فتعيد مجموعة البيانات كاملة بلا ترقيم ولا طيّ، ومعها `format` و`cap`.
 *   فوق السقف 422 `LEDGER_EXPORT_TOO_LARGE {lines, cap}` (ملحق ب).
 * - بناء الملف في المتصفح (ADR‑9): هذا الملف يجلب البيانات ويسلّمها لمُصدِّرَي XLSX وPDF
 *   المسجَّلين عبر `registerReportExporters`.
 */

const L = '/ledger';

// ═══ عقد الردّ الموحّد ═══

export interface ReportPeriodPayload {
  from: LocalDate;
  to: LocalDate;
  /** بداية السنة المالية التي يقع فيها `from` (§7.2 قاعدة الافتتاحي) */
  fyStart: LocalDate;
}

export interface ReportDateFilterPayload {
  mode: ReportDateMode;
  from: LocalDate;
  to: LocalDate;
}

/** خيارات §7.1 كما طبّعها الخادم (‏`normalizeReportOptions`) مضافاً إليها فلترا الحسابات والشركاء. */
export interface ReportOptionsPayload {
  dateFilter: ReportDateFilterPayload;
  comparison: { kind: ReportComparisonKind; count: number } | null;
  postedOnly: boolean;
  includeDrafts: boolean;
  unit: ReportUnit;
  hierarchy: boolean;
  hideZero: boolean;
  journals: string[];
  analytic: string[];
  salesReps: string[];
  search: string;
  breakdown: string;
  accounts: string[];
  partners: string[];
}

export interface ReportSettingsPayload {
  currency: string;
  currencyDecimals: number;
  timezone: string;
  fiscalYearEnd: { month: number; day: number };
  drawingsAfterNetProfit: boolean;
  depreciationInOperatingExpenses: boolean;
  configured: boolean;
}

/** رموز تنبيهات RPT‑08 كما يبنيها `buildReportWarnings` — لا نصّ يُعاد كتابته في الواجهة. */
export const REPORT_WARNING_CODES = [
  'UNPOSTED_ENTRIES', 'STOCK_EVENTS_PENDING', 'FILTERED_SCAN',
  'COMPARISON_NOT_SUPPORTED', 'ACCOUNT_FILTER_IGNORED', 'DATE_MODE_AS_OF',
] as const;
export type ReportWarningCode = (typeof REPORT_WARNING_CODES)[number];

export interface ReportWarning {
  /** من `REPORT_WARNING_CODES`، ويُحتمل رمزٌ من المحرّك الصرف (§7.5) فيبقى النوع نصاً */
  code: ReportWarningCode | string;
  /** نصّ عربي جاهز من الخادم — يُعرض كما هو */
  message: string;
  details?: Record<string, unknown>;
}

export interface ReportComparisonPayload {
  kind: ReportComparisonKind | string;
  count: number;
  periods: ReportPeriodPayload[];
  columns?: unknown[];
}

export interface ReportPaginationPayload {
  page: number;
  pageSize: number | null;
  paginated: boolean;
}

/**
 * جسم `data` في ردّ التقرير. `TRow` و`TTotals` تضيّقهما صفحة كل تقرير بأنواعها
 * (صفوف الميزان، أسطر قائمة الدخل، أقسام الميزانية، أقسام دفتر الأستاذ).
 */
export interface ReportResponse<TRow = Record<string, unknown>, TTotals = Record<string, unknown>> {
  reportKey: ReportKey;
  period: ReportPeriodPayload;
  dateFilter: ReportDateFilterPayload;
  options: ReportOptionsPayload;
  settings: ReportSettingsPayload;
  /** `LINE_SCAN` = «مفلتر، أبطأ» (§7.1) */
  mode: 'AGGREGATE' | 'LINE_SCAN';
  rows: TRow[];
  totals: TTotals;
  comparison: ReportComparisonPayload | null;
  pagination: ReportPaginationPayload | null;
  /** عدد السطور الذي تُقاس عليه سقوف التصدير */
  lineCount: number;
  warnings: ReportWarning[];
  /** ما ينشره كل تقرير بجوار العقد الموحّد (`columns`، `comparisonColumns`، `asOf`، `sections`…) */
  [extra: string]: unknown;
}

export type ExportFormat = 'xlsx' | 'pdf';

/** §7.1: XLSX حتى 50,000 سطر وPDF حتى 5,000 — نُسخة `REPORT_EXPORT_CAPS` على الخادم. */
export const REPORT_EXPORT_CAPS: Readonly<Record<ExportFormat, number>> = { xlsx: 50_000, pdf: 5_000 };

export interface ReportExportResponse<TRow = Record<string, unknown>, TTotals = Record<string, unknown>>
  extends ReportResponse<TRow, TTotals> {
  format: ExportFormat;
  cap: number;
  paginated: false;
}

// ═══ النقاط ═══

export const ledgerReportsApi = {
  /** `GET /reports/:key` — `canViewLedger`. المعاملات من `reportQueryParams`. */
  get: <TRow = Record<string, unknown>, TTotals = Record<string, unknown>>(key: ReportKey, params: ReportQueryParams) =>
    api.get<LedgerEnvelope<ReportResponse<TRow, TTotals>>>(`${L}/reports/${key}`, { params }),

  /**
   * `POST /reports/:key/export` — الخيارات نفسها مضافاً إليها `format`. محدود بـ`ledgerExportLimiter`
   * (نحو 20 طلباً كل 15 دقيقة) ويكتب صفّ تدقيق `EXPORT`، فلا يُستدعى إلا بنقرة المستخدم.
   */
  export: <TRow = Record<string, unknown>, TTotals = Record<string, unknown>>(
    key: ReportKey,
    body: ReportQueryParams & { format: ExportFormat },
  ) => api.post<LedgerEnvelope<ReportExportResponse<TRow, TTotals>>>(`${L}/reports/${key}/export`, body),
};

export const ledgerReportKeys = {
  all: ['ledger', 'report'] as const,
  report: (key: ReportKey, params?: unknown) => ['ledger', 'report', key, params ?? {}] as const,
};

// ═══ مُصدِّرا الملف (ADR‑9: الخادم لا يبني ملفاً) ═══

export interface ReportExportJob<TRow = Record<string, unknown>, TTotals = Record<string, unknown>> {
  reportKey: ReportKey;
  format: ExportFormat;
  /** عنوان التقرير بلغة العرض (لترويسة الملف) */
  title: string;
  /** اسم الملف المقترح بلا امتداد */
  fileName: string;
  /** مجموعة البيانات كاملة كما أعادتها نقطة التصدير */
  data: ReportExportResponse<TRow, TTotals>;
}

/** وحدة التصدير تُسجّل دالّتيها هنا، و`ReportView` ينادي المسجَّل ويعطّل الزرّ حين لا مُصدِّر. */
export interface ReportExporters {
  xlsx: (job: ReportExportJob) => void | Promise<void>;
  pdf: (job: ReportExportJob) => void | Promise<void>;
}

const exporters: Partial<ReportExporters> = {};

export function registerReportExporters(next: Partial<ReportExporters>): void {
  if (next.xlsx) exporters.xlsx = next.xlsx;
  if (next.pdf) exporters.pdf = next.pdf;
}

export function getReportExporters(): Partial<ReportExporters> {
  return exporters;
}

/** اسم ملف التصدير: المفتاح والمدى («trial-balance_2026-01-01_2026-01-31»). صرفة. */
export function reportFileName(key: ReportKey, period: { from: string; to: string }): string {
  return `${key}_${period.from}_${period.to}`;
}
