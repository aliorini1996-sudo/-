/**
 * تصدير تقارير الدفاتر (RPT‑01، DESIGN.md §7.1 البندان 5 و6).
 *
 * **القاعدة الأولى: لا يُصدَّر ما على الشاشة أبداً.** زرّا PDF وXLSX ينادِيان
 * `POST /api/ledger/reports/:key/export` بخيارات الشاشة نفسها مضافاً إليها `format`، فيعيد الخادم
 * **مجموعة البيانات كاملة** بلا ترقيم ولا تحميل كسول ولا طيّ (§7.1 البند 4)؛ ثم يبني المتصفّح
 * الملف من الردّ. الطيّ وصفحة الـ500 سطر في دفتر الأستاذ لا أثر لهما في الملف.
 *
 * **الخادم لا يلمس مبلغاً** (ADR‑9، عقد المبالغ في `routes/ledger/reports.ts`): كل مفتاح ينتهي
 * بـ`Milli` نصّ عدد صحيح بالملّي، والوحدة (RPT‑06) ومنازل العملة بيانٌ وصفي في `options`/`settings`.
 * فالتحويل هنا: `القيمة = الملّي ÷ 1000 ÷ الوحدة`، ويُقرَّب بمنازل العملة في خلية XLSX الرقمية.
 *
 * **تقسيم المسؤولية:** الجدول يُبنى مرة واحدة (`buildReportTable`) ثم يُصيَّر مرّتين —
 * `tableToSheet` لـXLSX عبر `utils/excel` القائم، و`tableToPdfRows` + `rowsToPagedPdf` لـPDF المرقَّم.
 * كل الدوال أدناه **صرفة** عدا `fetchReportExport` و`runReportExport`.
 *
 * كل نصّ جديد يمرّ بـ`tr('…')`: المُستدعي يمرّر `tr` من `useTr()`.
 */
import { num } from '../../../utils/excel';
import { gregorianLocale } from '../../../utils/format';
import type { ExcelSheet } from '../../../utils/excel';
import { rowsToPagedPdf, type PagedPdfColumn, type PagedPdfRow } from '../../../rep/pdfPaged';
import {
  PARTNER_REPORT_KEYS, agingBasisLabels, agingColumnLabels, lateArrivalReasonLabels, partnerReportTitles, partnerTypeLabels, roundQuantity,
  type PartnerReportKey,
} from '../../../api/ledgerPartners';
import { sourceTypeLabels } from '../../../lib/ledger/sync';

// ═══ العقد مع النقطة (‏`backend/src/routes/ledger/reports.ts` حرفياً) ═══

export const REPORT_EXPORT_FORMATS = ['xlsx', 'pdf'] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

/** §7.1: XLSX حتى 50,000 سطر وPDF حتى 5,000 — للعرض في الرسالة، والحَكَم هو الخادم. */
export const REPORT_EXPORT_CAPS: Readonly<Record<ReportExportFormat, number>> = { xlsx: 50_000, pdf: 5_000 };

/** مفاتيح التقارير المتاحة اليوم (‏`REPORT_KEYS` في المسار). */
export const REPORT_KEYS = ['trial-balance', 'income-statement', 'balance-sheet', 'general-ledger', 'executive-summary'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export type ReportExportParams = Record<string, string | number | boolean | readonly string[] | null | undefined>;

export interface ReportPeriodJson { from: string; to: string; fyStart: string }

export interface ReportExportOptionsJson {
  dateFilter: { mode: string; from: string; to: string };
  comparison: { kind: string; count: number } | null;
  postedOnly: boolean;
  includeDrafts: boolean;
  unit: number;
  hierarchy: boolean;
  hideZero: boolean;
  journals: readonly string[];
  analytic: readonly string[];
  salesReps: readonly string[];
  search: string;
  breakdown: string;
  accounts: readonly string[];
  partners: readonly string[];
}

export interface ReportExportSettingsJson {
  currency: string;
  currencyDecimals: number;
  timezone: string;
}

export interface ReportWarningJson { code: string; message: string; details?: Record<string, unknown> }

/** جسم `data` في ردّ نقطة التصدير — المفاتيح الثابتة من `responseBody`، وما بعدها إضافيات كل تقرير. */
export interface ReportExportData {
  reportKey: string;
  period: ReportPeriodJson;
  options: ReportExportOptionsJson;
  settings: ReportExportSettingsJson;
  mode: 'AGGREGATE' | 'LINE_SCAN';
  rows: unknown[];
  totals: unknown;
  comparison: { kind: string; count: number; periods: ReportPeriodJson[] } | null;
  lineCount: number;
  warnings: ReportWarningJson[];
  format: ReportExportFormat;
  cap: number;
  [extra: string]: unknown;
}

/** معاملات النقطة: تُنظَّف من الفارغ فلا يُرسل `search=''` فيصير فلتراً بلا سبب. صرفة. */
export function exportRequestBody(params: ReportExportParams, format: ReportExportFormat): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || k === 'format') continue;
    if (Array.isArray(v)) {
      const list = v.filter((x) => typeof x === 'string' && x.trim() !== '');
      if (list.length > 0) out[k] = list;
      continue;
    }
    out[k] = v;
  }
  // التصدير بلا ترقيم أصلاً (RPT‑01): مؤشّر الصفحة ورقمها لا معنى لهما ولا يُرسلان
  delete out.page;
  delete out.pageSize;
  delete out.cursor;
  out.format = format;
  return out;
}

// ═══ الأخطاء (ملحق ب) ═══

export interface ReportExportErrorInfo {
  status?: number;
  code?: string;
  /** رسالة الخادم العربية (‏`LEDGER_ERROR_MESSAGES`) */
  message?: string;
  lines?: number;
  cap?: number;
  format?: ReportExportFormat;
  /** ثوانٍ من ترويسة `Retry-After` أو من جسم الردّ */
  retryAfter?: number | null;
}

export class ReportExportError extends Error {
  readonly info: ReportExportErrorInfo;
  constructor(message: string, info: ReportExportErrorInfo) {
    super(message);
    this.name = 'ReportExportError';
    this.info = info;
  }
}

/** ثوانٍ من `Retry-After` (عدد ثوانٍ أو تاريخ HTTP). صرفة — `null` حين لا تُفهم. */
export function retryAfterSeconds(header: unknown, now: Date = new Date()): number | null {
  if (typeof header === 'number' && Number.isFinite(header)) return Math.max(0, Math.round(header));
  if (typeof header !== 'string' || header.trim() === '') return null;
  const raw = header.trim();
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw));
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - now.getTime()) / 1000));
}

/** مهلة مقروءة بالعربية: ثوانٍ تحت الدقيقة، ودقائق فوقها. صرفة. */
export function waitLabel(seconds: number | null | undefined, tr: (ar: string) => string): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return tr('بعد قليل');
  }
  if (seconds < 60) return `${tr('بعد')} ${Math.ceil(seconds)} ${tr('ثانية')}`;
  return `${tr('بعد')} ${Math.ceil(seconds / 60)} ${tr('دقيقة')}`;
}

/**
 * نصّ الخطأ بالعربية (§7.1). صرفة.
 *
 * - 422 `LEDGER_EXPORT_TOO_LARGE`: يذكر عدد الأسطر والسقف، ويقترح **XLSX** حين كان الطلب PDF
 *   (سقف XLSX عشرة أضعافه)، وتضييق الفترة أو الحسابات دائماً.
 * - 429: مهلةٌ صريحة بدل «حدث خطأ».
 */
export function exportErrorText(info: ReportExportErrorInfo, tr: (ar: string) => string): string {
  if (info.code === 'LEDGER_EXPORT_TOO_LARGE') {
    const head = info.lines !== undefined && info.cap !== undefined
      ? `${tr('التصدير يتجاوز الحد المسموح')}: ${info.lines} ${tr('سطر')} ${tr('والسقف')} ${info.cap}`
      : tr('التصدير يتجاوز الحد المسموح');
    const hint = info.format === 'pdf'
      ? tr('ضيّق الفترة أو الحسابات، أو صدّر XLSX')
      : tr('ضيّق الفترة أو الحسابات');
    return `${head}. ${hint}`;
  }
  if (info.code === 'LEDGER_RANGE_TOO_LARGE') {
    return info.message ?? tr('المدى المطلوب أكبر من حدّ التقرير المفلتر: ضيّق الفترة أو قلّل الفلاتر');
  }
  if (info.status === 429 || info.code === 'RATE_LIMITED') {
    return `${tr('طلبات تصدير كثيرة')}: ${tr('أعد المحاولة')} ${waitLabel(info.retryAfter, tr)}`;
  }
  if (info.code === 'LEDGER_EXPORT_IN_PROGRESS') {
    return info.message ?? tr('تصدير آخر قيد التنفيذ: انتظر انتهاءه ثم أعد المحاولة');
  }
  if (info.status === 403) return info.message ?? tr('لا تملك صلاحية عرض الدفاتر');
  if (info.status === 404) return info.message ?? tr('هذا التقرير غير متاح');
  return info.message ?? tr('تعذّر تصدير التقرير');
}

const asNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** يقرأ خطأ axios (الجسم ينشر التفاصيل بجانب الرمز، ملحق ب) إلى `ReportExportErrorInfo`. صرفة. */
export function exportErrorInfo(err: unknown, format?: ReportExportFormat, now?: Date): ReportExportErrorInfo {
  const res = (err as { response?: { status?: number; data?: unknown; headers?: Record<string, unknown> } })?.response;
  const body = (res?.data && typeof res.data === 'object' ? res.data : {}) as Record<string, unknown>;
  const details = (body.details && typeof body.details === 'object' ? body.details : {}) as Record<string, unknown>;
  const pick = (k: string): unknown => (body[k] !== undefined ? body[k] : details[k]);
  const headerRetry = res?.headers
    ? (res.headers['retry-after'] ?? res.headers['Retry-After'] ?? (res.headers as Record<string, unknown>)['ratelimit-reset'])
    : undefined;
  const bodyFormat = pick('format');
  return {
    status: res?.status,
    code: typeof body.code === 'string' ? body.code : undefined,
    message: typeof body.message === 'string' && body.message.trim() !== '' ? body.message : undefined,
    lines: asNumber(pick('lines')),
    cap: asNumber(pick('cap')),
    format: bodyFormat === 'xlsx' || bodyFormat === 'pdf' ? bodyFormat : format,
    retryAfter: retryAfterSeconds(headerRetry, now),
  };
}

// ═══ النداء ═══

/** ينادي نقطة التصدير ويعيد **مجموعة البيانات كاملة**، أو يرمي `ReportExportError` برسالة عربية. */
export async function fetchReportExport(
  reportKey: string,
  params: ReportExportParams,
  format: ReportExportFormat,
  tr: (ar: string) => string,
): Promise<ReportExportData> {
  // تحميلٌ كسول: `api/client` يلمس localStorage عند الاستيراد فلا يُحمَّل في اختبار عقدة
  const { default: api } = await import('../../../api/client');
  try {
    const res = await api.post(`/ledger/reports/${reportKey}/export`, exportRequestBody(params, format));
    const data = (res.data as { data?: unknown } | undefined)?.data;
    if (!data || typeof data !== 'object') {
      throw new ReportExportError(tr('ردّ التصدير غير مفهوم'), { code: 'BAD_EXPORT_BODY' });
    }
    return data as ReportExportData;
  } catch (err) {
    if (err instanceof ReportExportError) throw err;
    const info = exportErrorInfo(err, format);
    throw new ReportExportError(exportErrorText(info, tr), info);
  }
}

// ═══ الجدول الموحّد ═══

export interface ExportColumn {
  label: string;
  /** خلية رقمية: تُكتب رقماً في XLSX وتُحاذى يساراً في PDF */
  numeric?: boolean;
  /** حصّة العرض في PDF */
  width?: number;
  /** خلية رقمية ليست مبلغاً (الكمية، العدد): منازلها هي، لا منازل العملة — «ربط الدفاتر» L8 */
  decimals?: number;
}

export interface ExportRow {
  /** عمق الشجرة (RPT‑07) */
  level: number;
  cells: readonly (string | number | null)[];
  strong?: boolean;
  muted?: boolean;
  head?: boolean;
  /** صفّ «رصيد مُرحَّل» يتكرر أعلى صفحات PDF (§7.1، §7.5) */
  carry?: boolean;
}

export interface ExportTable {
  columns: ExportColumn[];
  rows: ExportRow[];
  /** فهرس الخلية التي تحمل إزاحة الشجرة */
  indentIndex: number;
}

/** قيمة معروضة من مبلغ ملّي نصّي بوحدة العرض (RPT‑06). صرفة. */
export function milliToUnits(milli: unknown, unit: number): number | null {
  if (milli === null || milli === undefined || milli === '') return null;
  const n = typeof milli === 'number' ? milli : Number(milli);
  if (!Number.isFinite(n)) return null;
  const u = unit === 1000 || unit === 1_000_000 ? unit : 1;
  return n / 1000 / u;
}

/**
 * تحييد الصيغ (§7.1 البند 5): خليّة نصّية تبدأ بـ`=` أو `+` أو `-` أو `@` تُسبق بفاصلة عليا،
 * فلا يفسّرها Excel معادلةً. الفحص على أول محرف **غير فراغ** فلا تفلت خليّة أُزيحت بمسافات. صرفة.
 */
export function formulaSafe(text: string): string {
  const first = text.replace(/^[\s ]+/, '').charAt(0);
  return first === '=' || first === '+' || first === '-' || first === '@' ? `'${text}` : text;
}

/** إزاحة نصّية تُظهر الشجرة داخل الخلية (XLSX وPDF معاً). صرفة. */
export function indentText(level: number, text: string): string {
  const l = Number.isFinite(level) ? Math.min(8, Math.max(0, Math.trunc(level))) : 0;
  return l > 0 ? `${' '.repeat(l)}${text}` : text;
}

/** عناوين فريدة: مفاتيح ورقة XLSX كائنٌ، فعمودان بالاسم نفسه يبتلع أحدهما الآخر. صرفة. */
export function dedupeLabels(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((raw) => {
    const label = raw === '' ? ' ' : raw;
    const n = seen.get(label) ?? 0;
    seen.set(label, n + 1);
    return n === 0 ? label : `${label} (${n + 1})`;
  });
}

// ═══ ترويسة الملف ═══

export interface ReportMetaInput {
  data: ReportExportData;
  tr: (ar: string) => string;
  company?: string | null;
  now?: Date;
  /** لغة تنسيق التاريخ */
  locale?: string;
}

/** عنوان التقرير بالعربية (§7.2 إلى §7.5، ORPT‑09). صرفة. */
export function reportTitle(reportKey: string, tr: (ar: string) => string): string {
  if (reportKey === 'trial-balance') return tr('ميزان المراجعة');
  if (reportKey === 'income-statement') return tr('قائمة الدخل');
  if (reportKey === 'balance-sheet') return tr('الميزانية العمومية');
  if (reportKey === 'general-ledger') return tr('دفتر الأستاذ العام');
  if (reportKey === 'executive-summary') return tr('الملخص التنفيذي');
  if (isPartnerExportKey(reportKey)) return partnerExportTitle(reportKey, tr);
  return tr('تقرير');
}

/** وسم وحدة العرض (RPT‑06) — فارغ عند الآحاد. صرفة. */
export function unitLabel(unit: number, tr: (ar: string) => string): string {
  if (unit === 1000) return tr('بالآلاف');
  if (unit === 1_000_000) return tr('بالملايين');
  return '';
}

/** سطر «الفترة»: «اعتباراً من» للميزانية (§7.4) ومدى لغيرها. صرفة. */
export function periodLabel(data: ReportExportData, tr: (ar: string) => string): string {
  const asOf = typeof data.asOf === 'string' ? data.asOf : null;
  if (data.reportKey === 'balance-sheet' || data.options.dateFilter.mode === 'asOf') {
    return `${tr('اعتباراً من')} ${asOf ?? data.period.to}`;
  }
  return `${data.period.from} — ${data.period.to}`;
}

/** ملخّص الخيارات المؤثّرة في الأرقام (RPT‑05 وRPT‑06 وRPT‑07 وRPT‑15). صرفة. */
export function optionsLabel(data: ReportExportData, tr: (ar: string) => string): string {
  const o = data.options;
  const parts: string[] = [o.includeDrafts ? tr('مع المسودات') : tr('المرحّلة فقط')];
  const unit = unitLabel(o.unit, tr);
  if (unit) parts.push(unit);
  if (o.hierarchy) parts.push(tr('هرمي'));
  if (o.hideZero) parts.push(tr('إخفاء الأصفار'));
  if (o.search) parts.push(`${tr('بحث')}: ${o.search}`);
  if (o.comparison) {
    const kind = o.comparison.kind === 'sameLastYear' ? tr('مقارنة بالعام الماضي') : tr('مقارنة بالفترة السابقة');
    parts.push(`${kind} (${o.comparison.count})`);
  }
  if (o.journals.length > 0) parts.push(`${tr('دفاتر')}: ${o.journals.length}`);
  if (o.analytic.length > 0) parts.push(`${tr('تحليلي')}: ${o.analytic.length}`);
  if (o.salesReps.length > 0) parts.push(`${tr('مناديب')}: ${o.salesReps.length}`);
  if (o.accounts.length > 0) parts.push(`${tr('حسابات')}: ${o.accounts.length}`);
  if (o.partners.length > 0) parts.push(`${tr('شركاء')}: ${o.partners.length}`);
  if (data.mode === 'LINE_SCAN') parts.push(tr('مفلتر، أبطأ'));
  return parts.join(' · ');
}

/** صفوف الترويسة الأولى: الشركة والفترة والخيارات وتاريخ الطباعة (§7.1 البند 5). صرفة. */
export function reportMetaRows(input: ReportMetaInput): { label: string; value: string }[] {
  if (isPartnerExportKey(input.data.reportKey)) return partnerExportMetaRows(input);
  const { data, tr } = input;
  const now = input.now ?? new Date();
  const printed = (() => {
    try { return now.toLocaleString(gregorianLocale(input.locale ?? 'ar-SA')); } catch { return now.toISOString().slice(0, 16).replace('T', ' '); }
  })();
  const out: { label: string; value: string }[] = [];
  if (input.company && input.company.trim() !== '') out.push({ label: tr('الشركة'), value: input.company.trim() });
  out.push({ label: tr('التقرير'), value: reportTitle(data.reportKey, tr) });
  out.push({ label: tr('الفترة'), value: periodLabel(data, tr) });
  out.push({ label: tr('الخيارات'), value: optionsLabel(data, tr) });
  out.push({ label: tr('العملة'), value: `${data.settings.currency}` });
  out.push({ label: tr('تاريخ الطباعة'), value: printed });
  return out;
}

/** اسم الملف: عنوان التقرير ومداه، بلا محارف تكسر أنظمة الملفات. صرفة. */
export function reportFileName(data: ReportExportData, tr: (ar: string) => string): string {
  if (isPartnerExportKey(data.reportKey)) return partnerExportFileName(data, tr);
  const span = data.reportKey === 'balance-sheet' || data.options.dateFilter.mode === 'asOf'
    ? String(data.asOf ?? data.period.to)
    : `${data.period.from}_${data.period.to}`;
  return `${reportTitle(data.reportKey, tr)}-${span}`.replace(/[\\/?*[\]:<>|"]/g, '·').slice(0, 80);
}

// ═══ تسطيح صفوف كل تقرير ═══

interface TbCellJson {
  openingMilli: string; debitMilli: string; creditMilli: string; endingMilli: string;
  deltaMilli: string | null; percent: number | null;
}
interface TbRowJson {
  id: string; kind: string; accountId: string | null; code: string; name: string; level: number;
  cells: TbCellJson[];
}
interface TbColumnJson { from: string; to: string; fyStart: string; kind: 'base' | 'comparison'; index: number }

interface AmountRowJson { accountId: string; code: string; name: string; amountMilli: string }
interface IsGroupJson { key: string; label: string; amountMilli: string; accounts: AmountRowJson[] }
interface IsLineJson {
  key: string; label: string; amountMilli: string; total: boolean;
  accounts: AmountRowJson[]; groups: IsGroupJson[];
}
interface BsNodeJson {
  key: string; label: string; amountMilli: string; total: boolean;
  accounts: AmountRowJson[]; children: BsNodeJson[];
}

interface GlLineJson {
  date: string; originalDate: string | null; shifted?: boolean; draft?: boolean; closing?: boolean; excluded?: boolean;
  moveNumber: string | null; journalCode: string | null; journalName: string | null;
  partnerName: string | null; salesRepName: string | null; label: string | null;
  debitMilli: string; creditMilli: string; runningMilli: string;
}
interface GlSectionJson {
  account: { id: string; code: string; name: string };
  openingMilli: string; carriedForwardMilli?: string;
  debitMilli: string; creditMilli: string; endingMilli: string;
  closingExcluded?: boolean; closingDebitMilli?: string; closingCreditMilli?: string;
  lines: GlLineJson[];
}

interface ExecCardJson {
  key: string; kind: string; label: string; decimals?: number;
  amountMilli?: string; previousMilli?: string | null; changeMilli?: string | null; changePct?: number | null;
  value?: number; defined?: boolean; previousValue?: number | null; changeValue?: number | null;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const columnSpan = (c: TbColumnJson): string => `${c.from} — ${c.to}`;

/** ميزان المراجعة (§7.2): الأعمدة من `columnLabels` في الردّ، فلا تُخترع مسمّيات. صرفة. */
function trialBalanceTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const unit = data.options.unit;
  const labels = (data.columnLabels ?? {}) as Partial<Record<'opening' | 'debit' | 'credit' | 'ending', string>>;
  const L = {
    opening: labels.opening ?? tr('الرصيد الافتتاحي'),
    debit: labels.debit ?? tr('مدين'),
    credit: labels.credit ?? tr('دائن'),
    ending: labels.ending ?? tr('الرصيد النهائي'),
  };
  const cols = arr<TbColumnJson>(data.columns);
  const periods: TbColumnJson[] = cols.length > 0
    ? cols
    : [{ from: data.period.from, to: data.period.to, fyStart: data.period.fyStart, kind: 'base', index: 0 }];

  const columns: ExportColumn[] = [
    { label: tr('المستوى'), numeric: true, width: 0.5 },
    { label: tr('الرمز'), width: 1 },
    { label: tr('الحساب'), width: 3 },
  ];
  for (const c of periods) {
    const suffix = c.kind === 'comparison' ? ` (${columnSpan(c)})` : '';
    columns.push({ label: `${L.opening}${suffix}`, numeric: true, width: 1.2 });
    columns.push({ label: `${L.debit}${suffix}`, numeric: true, width: 1.2 });
    columns.push({ label: `${L.credit}${suffix}`, numeric: true, width: 1.2 });
    columns.push({ label: `${L.ending}${suffix}`, numeric: true, width: 1.2 });
    if (c.kind === 'comparison') columns.push({ label: `${tr('٪ التغيّر')}${suffix}`, numeric: true, width: 0.9 });
  }

  const cellsOf = (cells: readonly TbCellJson[]): (string | number | null)[] => {
    const out: (string | number | null)[] = [];
    periods.forEach((c, i) => {
      const cell = cells[i];
      out.push(milliToUnits(cell?.openingMilli, unit));
      out.push(milliToUnits(cell?.debitMilli, unit));
      out.push(milliToUnits(cell?.creditMilli, unit));
      out.push(milliToUnits(cell?.endingMilli, unit));
      if (c.kind === 'comparison') out.push(cell?.percent ?? null);
    });
    return out;
  };

  const rows: ExportRow[] = arr<TbRowJson>(data.rows).map((r) => ({
    level: r.level ?? 0,
    strong: r.kind === 'group',
    cells: [r.level ?? 0, txt(r.code), txt(r.name), ...cellsOf(arr<TbCellJson>(r.cells))],
  }));
  rows.push({
    level: 0,
    strong: true,
    cells: [0, '', tr('الإجمالي'), ...cellsOf(arr<TbCellJson>(data.totals))],
  });
  return { columns, rows, indentIndex: 2 };
}

/** أعمدة المبلغ: الأساسية ثم عمود لكل فترة مقارنة (RPT‑04). صرفة. */
function amountColumns(data: ReportExportData, tr: (ar: string) => string): ExportColumn[] {
  const out: ExportColumn[] = [{ label: tr('المبلغ'), numeric: true, width: 1.4 }];
  const periods = data.comparison?.periods ?? [];
  const count = Math.max(periods.length, arr<unknown>(data.comparisonColumns).length);
  for (let i = 0; i < count; i++) {
    const p = periods[i];
    const span = p ? ` (${p.from} — ${p.to})` : ` (${i + 2})`;
    out.push({ label: `${tr('المبلغ')}${span}`, numeric: true, width: 1.4 });
  }
  return out;
}

/** قائمة الدخل (§7.3): السطر ثم سطوره الفرعية ثم حساباته، والتسميات من الخادم. صرفة. */
function incomeStatementTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const unit = data.options.unit;
  const columns: ExportColumn[] = [
    { label: tr('المستوى'), numeric: true, width: 0.5 },
    { label: tr('الرمز'), width: 1 },
    { label: tr('السطر'), width: 3.4 },
    ...amountColumns(data, tr),
  ];
  const comparisons = arr<{ lines?: IsLineJson[] }>(data.comparisonColumns);
  /** خريطة مبلغ لكل مفتاح صفّ في كل عمود مقارنة */
  const maps = comparisons.map((c) => {
    const m = new Map<string, string>();
    for (const line of arr<IsLineJson>(c.lines)) {
      m.set(`line:${line.key}`, line.amountMilli);
      for (const g of arr<IsGroupJson>(line.groups)) {
        m.set(`group:${line.key}:${g.key}`, g.amountMilli);
        for (const a of arr<AmountRowJson>(g.accounts)) m.set(`acct:${line.key}:${g.key}:${a.accountId}`, a.amountMilli);
      }
      for (const a of arr<AmountRowJson>(line.accounts)) m.set(`acct:${line.key}::${a.accountId}`, a.amountMilli);
    }
    return m;
  });
  const amounts = (key: string, base: unknown): (number | null)[] =>
    [milliToUnits(base, unit), ...maps.map((m) => milliToUnits(m.get(key), unit))];

  const rows: ExportRow[] = [];
  for (const line of arr<IsLineJson>(data.rows)) {
    rows.push({
      level: 0,
      strong: line.total === true,
      cells: [0, '', txt(line.label), ...amounts(`line:${line.key}`, line.amountMilli)],
    });
    for (const g of arr<IsGroupJson>(line.groups)) {
      rows.push({
        level: 1,
        cells: [1, '', txt(g.label), ...amounts(`group:${line.key}:${g.key}`, g.amountMilli)],
      });
      for (const a of arr<AmountRowJson>(g.accounts)) {
        rows.push({
          level: 2,
          cells: [2, txt(a.code), txt(a.name), ...amounts(`acct:${line.key}:${g.key}:${a.accountId}`, a.amountMilli)],
        });
      }
    }
    for (const a of arr<AmountRowJson>(line.accounts)) {
      rows.push({
        level: 1,
        cells: [1, txt(a.code), txt(a.name), ...amounts(`acct:${line.key}::${a.accountId}`, a.amountMilli)],
      });
    }
  }
  return { columns, rows, indentIndex: 2 };
}

/** الميزانية العمومية (§7.4): الشجرة مسطَّحة بعمقها، ثم سطر «الالتزامات + حقوق الملكية». صرفة. */
function balanceSheetTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const unit = data.options.unit;
  const columns: ExportColumn[] = [
    { label: tr('المستوى'), numeric: true, width: 0.5 },
    { label: tr('الرمز'), width: 1 },
    { label: tr('السطر'), width: 3.4 },
    ...amountColumns(data, tr),
  ];
  const walk = (node: BsNodeJson, depth: number, path: string, into: (k: string, n: BsNodeJson, d: number) => void): void => {
    const key = `${path}/${node.key}`;
    into(key, node, depth);
    for (const c of arr<BsNodeJson>(node.children)) walk(c, depth + 1, key, into);
  };
  const flatten = (sections: BsNodeJson[], totalLine: BsNodeJson | null): { key: string; node: BsNodeJson; depth: number }[] => {
    const out: { key: string; node: BsNodeJson; depth: number }[] = [];
    for (const s of sections) walk(s, 0, '', (key, node, depth) => out.push({ key, node, depth }));
    if (totalLine) out.push({ key: `/${totalLine.key}`, node: totalLine, depth: 0 });
    return out;
  };
  const totals = (data.totals ?? {}) as { totalLine?: BsNodeJson };
  const base = flatten(arr<BsNodeJson>(data.rows), totals.totalLine ?? null);

  const maps = arr<{ sections?: BsNodeJson[]; totalLine?: BsNodeJson }>(data.comparisonColumns).map((c) => {
    const m = new Map<string, string>();
    for (const { key, node } of flatten(arr<BsNodeJson>(c.sections), c.totalLine ?? null)) {
      m.set(`node:${key}`, node.amountMilli);
      for (const a of arr<AmountRowJson>(node.accounts)) m.set(`acct:${key}:${a.accountId}`, a.amountMilli);
    }
    return m;
  });
  const amounts = (key: string, value: unknown): (number | null)[] =>
    [milliToUnits(value, unit), ...maps.map((m) => milliToUnits(m.get(key), unit))];

  const rows: ExportRow[] = [];
  for (const { key, node, depth } of base) {
    rows.push({
      level: depth,
      strong: node.total === true,
      cells: [depth, '', txt(node.label), ...amounts(`node:${key}`, node.amountMilli)],
    });
    for (const a of arr<AmountRowJson>(node.accounts)) {
      rows.push({
        level: depth + 1,
        cells: [depth + 1, txt(a.code), txt(a.name), ...amounts(`acct:${key}:${a.accountId}`, a.amountMilli)],
      });
    }
  }
  return { columns, rows, indentIndex: 2 };
}

/** وسوم السطر في دفتر الأستاذ: مسودة، إقفال مفصول، مستند مُزاح (ADR‑7، §7.2). صرفة. */
export function ledgerLineNote(line: GlLineJson, tr: (ar: string) => string): string {
  const marks: string[] = [];
  if (line.draft === true) marks.push(tr('مسودة'));
  if (line.closing === true) marks.push(tr('إقفال'));
  if (line.excluded === true) marks.push(tr('مفصول'));
  if (line.shifted === true && line.originalDate) marks.push(`${tr('مُزاح من')} ${line.originalDate}`);
  const label = txt(line.label);
  if (marks.length === 0) return label;
  return label === '' ? `[${marks.join(' · ')}]` : `${label} [${marks.join(' · ')}]`;
}

/** دفتر الأستاذ العام (§7.5): أعمدته الموثّقة، وصفٌّ افتتاحي مُرحَّل لكل حساب ثم إجماليه. صرفة. */
function generalLedgerTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const unit = data.options.unit;
  const columns: ExportColumn[] = [
    { label: tr('المستوى'), numeric: true, width: 0.4 },
    { label: tr('التاريخ'), width: 1 },
    { label: tr('الرقم'), width: 1 },
    { label: tr('الدفتر'), width: 1 },
    { label: tr('الشريك'), width: 1.4 },
    { label: tr('المندوب'), width: 1.1 },
    { label: tr('البيان'), width: 2.6 },
    { label: tr('مدين'), numeric: true, width: 1.1 },
    { label: tr('دائن'), numeric: true, width: 1.1 },
    { label: tr('رصيد جارٍ'), numeric: true, width: 1.2 },
  ];
  const rows: ExportRow[] = [];
  for (const s of arr<GlSectionJson>(data.rows)) {
    const code = txt(s.account?.code);
    const name = txt(s.account?.name);
    // الصفّ الافتتاحي يحمل اسم الحساب ورصيده المُرحَّل، فيكرّره PDF أعلى كل صفحة تالية (§7.1)
    rows.push({
      level: 0,
      head: true,
      strong: true,
      carry: true,
      cells: [
        0, data.period.from, '', '', '', '',
        `${code} ${name} — ${tr('الرصيد الافتتاحي')}`.trim(),
        null, null, milliToUnits(s.carriedForwardMilli ?? s.openingMilli, unit),
      ],
    });
    for (const line of arr<GlLineJson>(s.lines)) {
      rows.push({
        level: 1,
        muted: line.excluded === true,
        cells: [
          1, txt(line.date), txt(line.moveNumber),
          txt(line.journalCode ?? line.journalName), txt(line.partnerName), txt(line.salesRepName),
          ledgerLineNote(line, tr),
          milliToUnits(line.debitMilli, unit), milliToUnits(line.creditMilli, unit),
          milliToUnits(line.runningMilli, unit),
        ],
      });
    }
    if (s.closingExcluded === true) {
      rows.push({
        level: 1,
        muted: true,
        cells: [
          1, '', '', '', '', '', tr('منقول إلى أرباح سنوات سابقة'),
          milliToUnits(s.closingDebitMilli, unit), milliToUnits(s.closingCreditMilli, unit), null,
        ],
      });
    }
    rows.push({
      level: 0,
      strong: true,
      cells: [
        0, '', '', '', '', '', `${tr('الإجمالي')} — ${code}`,
        milliToUnits(s.debitMilli, unit), milliToUnits(s.creditMilli, unit), milliToUnits(s.endingMilli, unit),
      ],
    });
  }
  const t = (data.totals ?? {}) as { debitMilli?: string; creditMilli?: string; endingMilli?: string };
  rows.push({
    level: 0,
    strong: true,
    cells: [
      0, '', '', '', '', '', tr('الإجمالي العام'),
      milliToUnits(t.debitMilli, unit), milliToUnits(t.creditMilli, unit), milliToUnits(t.endingMilli, unit),
    ],
  });
  return { columns, rows, indentIndex: 6 };
}

/** الملخّص التنفيذي (ORPT‑09): بطاقة في كل صفّ، والنِّسب بمنازلها لا بالملّي. صرفة. */
function executiveSummaryTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const unit = data.options.unit;
  const columns: ExportColumn[] = [
    { label: tr('المستوى'), numeric: true, width: 0.4 },
    { label: tr('البند'), width: 3 },
    { label: tr('القيمة'), numeric: true, width: 1.4 },
    { label: tr('الفترة المقارنة'), numeric: true, width: 1.4 },
    { label: tr('التغيّر'), numeric: true, width: 1.4 },
    { label: tr('٪ التغيّر'), numeric: true, width: 1 },
  ];
  const rows: ExportRow[] = arr<ExecCardJson>(data.rows).map((card) => {
    if (card.kind === 'money') {
      return {
        level: 0,
        cells: [
          0, txt(card.label),
          milliToUnits(card.amountMilli, unit),
          milliToUnits(card.previousMilli, unit),
          milliToUnits(card.changeMilli, unit),
          card.changePct ?? null,
        ],
      };
    }
    return {
      level: 0,
      cells: [
        0, txt(card.label),
        card.defined === false ? null : (card.value ?? null),
        card.previousValue ?? null,
        card.changeValue ?? null,
        null,
      ],
    };
  });
  return { columns, rows, indentIndex: 1 };
}

/** يبني جدول التصدير من ردّ النقطة — مصدرٌ واحد لـXLSX وPDF. صرفة. */
export function buildReportTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  if (data.reportKey === 'trial-balance') return trialBalanceTable(data, tr);
  if (data.reportKey === 'income-statement') return incomeStatementTable(data, tr);
  if (data.reportKey === 'balance-sheet') return balanceSheetTable(data, tr);
  if (data.reportKey === 'general-ledger') return generalLedgerTable(data, tr);
  if (data.reportKey === 'executive-summary') return executiveSummaryTable(data, tr);
  if (isPartnerExportKey(data.reportKey)) return partnerExportTable(data, tr);
  return { columns: [{ label: tr('البند') }], rows: [], indentIndex: 0 };
}

// ═══ XLSX (‏§7.1 البند 5) ═══

export interface SheetBuildInput {
  table: ExportTable;
  meta: readonly { label: string; value: string }[];
  sheetName: string;
  /** منازل العملة من `settings.currencyDecimals` */
  decimals: number;
}

/**
 * ورقة XLSX واحدة للتقرير (§7.1 البند 5). صرفة.
 *
 * - عمود «المستوى» رقماً، والخلية النصّية الأولى مُزاحة بعمق الشجرة.
 * - كل مبلغ **خلية رقمية** عبر `num()` بمنازل العملة (لا نصّ، فتُجمع في Excel).
 * - **تحييد الصيغ** على كل خلية نصّية.
 * - الشركة والفترة والخيارات وتاريخ الطباعة في الصفوف الأولى، يفصلها صفّ فارغ عن البيانات.
 *   (‏`utils/excel` يبني الترويسة من مفاتيح الكائن، فصفّ العناوين يبقى أوّل صفوف الورقة.)
 */
export function tableToSheet(input: SheetBuildInput): ExcelSheet {
  const { table, meta, decimals } = input;
  const labels = dedupeLabels(table.columns.map((c) => c.label));
  const rows: Record<string, unknown>[] = [];
  for (const m of meta) {
    const row: Record<string, unknown> = {};
    row[labels[0]] = formulaSafe(m.label);
    if (labels.length > 1) row[labels[1]] = formulaSafe(m.value);
    rows.push(row);
  }
  if (meta.length > 0) rows.push({ [labels[0]]: '' });
  for (const r of table.rows) {
    const row: Record<string, unknown> = {};
    labels.forEach((label, i) => {
      const v = r.cells[i];
      if (v === null || v === undefined) { row[label] = ''; return; }
      if (typeof v === 'number') {
        // «المستوى» عددٌ صحيح لا مبلغ، فلا يُقرَّب بمنازل العملة
        row[label] = i === 0 ? v : num(v, table.columns[i]?.decimals ?? decimals);
        return;
      }
      row[label] = formulaSafe(i === table.indentIndex ? indentText(r.level, v) : v);
    });
    rows.push(row);
  }
  const colWidths = table.columns.map((c, i) => (i === 0 ? 8 : Math.round(12 * (c.width ?? 1)) + 6));
  return { name: input.sheetName.slice(0, 31), rows, colWidths };
}

// ═══ PDF (‏§7.1 البند 6) ═══

/** منسّق مبلغ افتراضي: فواصل آلاف ومنازل العملة. */
export function makeAmountFormatter(decimals: number, locale = 'ar-SA'): (v: number) => string {
  try {
    const f = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return (v: number) => f.format(v);
  } catch {
    return (v: number) => v.toFixed(decimals);
  }
}

export interface PdfRowsInput {
  table: ExportTable;
  formatAmount: (v: number) => string;
  /** خلايا العمود ذي `decimals` (كمية لا مبلغ)؛ الافتراضي `makeQuantityFormatter()` */
  formatQuantity?: (v: number, decimals: number) => string;
}

/**
 * صفوف PDF: عمود «المستوى» يسقط (الإزاحة النصّية تُغني عنه على الورق)، والأرقام تُنسَّق نصّاً. صرفة.
 */
export function tableToPdfRows(input: PdfRowsInput): { columns: PagedPdfColumn[]; rows: PagedPdfRow[] } {
  const { table, formatAmount } = input;
  const formatQuantity = input.formatQuantity ?? makeQuantityFormatter();
  // جدولٌ بعمود واحد يبقى كما هو (وإلا خرجت صفحةٌ بلا أعمدة)
  const keep = table.columns.length > 1 ? table.columns.map((_, i) => i).filter((i) => i !== 0) : [0];
  const columns: PagedPdfColumn[] = keep.map((i) => ({
    label: table.columns[i].label,
    width: table.columns[i].width,
    align: table.columns[i].numeric ? 'end' : 'start',
  }));
  const rows: PagedPdfRow[] = table.rows.map((r) => ({
    // الإزاحة نصّية هنا، فلا يزيحها `pdfPaged` مرّة ثانية
    level: 0,
    strong: r.strong,
    muted: r.muted,
    head: r.head,
    carry: r.carry,
    cells: keep.map((i) => {
      const v = r.cells[i];
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return table.columns[i].decimals === undefined ? formatAmount(v) : formatQuantity(v, table.columns[i].decimals as number);
      return i === table.indentIndex ? indentText(r.level, v) : v;
    }),
  }));
  return { columns, rows };
}

// ═══ التشغيل ═══

export interface RunReportExportInput {
  reportKey: string;
  /** خيارات الشاشة نفسها ⇄ معاملات النقطة (من `reportOptions.ts`) */
  params: ReportExportParams;
  format: ReportExportFormat;
  tr: (ar: string) => string;
  company?: string | null;
  /** تنسيق المبلغ للعرض في PDF (من `reportOptions.ts`)؛ الافتراضي منازل العملة */
  formatAmount?: (v: number) => string;
  /** لغة تنسيق تاريخ الطباعة والأرقام */
  locale?: string;
  /** زرّ المشاركة في الجوال بدل التنزيل المباشر (‏`MLedgerReport`) */
  share?: boolean;
  now?: Date;
}

export interface RunReportExportResult {
  format: ReportExportFormat;
  fileName: string;
  /** عدد أسطر الملف كما عدّه الخادم (‏`lineCount`) */
  lineCount: number;
  /** عدد الصفوف المكتوبة فعلاً في الجدول */
  rowCount: number;
  warnings: ReportWarningJson[];
  delivery: 'shared' | 'downloaded';
}

/**
 * المسار الكامل: نداء النقطة ⇒ جدول ⇒ ملف ⇒ تنزيل. يرمي `ReportExportError` برسالة عربية جاهزة.
 * الواجهة تعرض الرسالة كما هي (‏422 `LEDGER_EXPORT_TOO_LARGE` و429 لهما نصّاهما المخصّصان).
 */
export async function runReportExport(input: RunReportExportInput): Promise<RunReportExportResult> {
  const { tr, format } = input;
  const data = await fetchReportExport(input.reportKey, input.params, format, tr);
  const table = buildReportTable(data, tr);
  const meta = reportMetaRows({ data, tr, company: input.company, now: input.now, locale: input.locale });
  const fileName = reportFileName(data, tr);
  const decimals = Number.isFinite(data.settings?.currencyDecimals) ? data.settings.currencyDecimals : 2;

  let delivery: 'shared' | 'downloaded' = 'downloaded';
  if (format === 'xlsx') {
    const { exportExcel, shareOrDownloadExcel } = await import('../../../utils/excel');
    const sheet = tableToSheet({ table, meta, sheetName: reportTitle(data.reportKey, tr), decimals });
    if (input.share === true) delivery = await shareOrDownloadExcel([sheet], fileName);
    else await exportExcel([sheet], fileName);
  } else {
    const formatAmount = input.formatAmount ?? makeAmountFormatter(decimals, input.locale);
    const { columns, rows } = tableToPdfRows({ table, formatAmount });
    const blob = await rowsToPagedPdf({
      title: reportTitle(data.reportKey, tr),
      meta: meta.map((m) => `${m.label}: ${m.value}`),
      columns,
      rows,
      tr,
    });
    const pdf = await import('../../../rep/pdf');
    if (input.share === true) delivery = await pdf.shareOrDownloadPdf(blob, `${fileName}.pdf`);
    else pdf.downloadPdf(blob, fileName);
  }

  return {
    format,
    fileName,
    lineCount: Number(data.lineCount ?? 0),
    rowCount: table.rows.length,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    delivery,
  };
}

// ═══ «ربط الدفاتر» L8: تقارير الشركاء (عقد L4/L5/L8 §6.2) ═══
//
// الردّ هنا **أرقام بوحدة العملة** (`fromMilli` في `routes/ledger/partnerReports.ts`) لا ملّي نصّي، ولا `period` ولا `options`:
// فلكل تقرير جدوله وترويسته، والمسار المشترك (‏`runReportExport` ← `buildReportTable` و`reportMetaRows` و`reportFileName`)
// يحوّل إليها بسطر واحد. الكمية والعدد خليتان رقميتان بمنازلهما (`ExportColumn.decimals`) لا بمنازل العملة.

/** هل المفتاح تقرير شركاء (L8)؟ صرفة. */
export function isPartnerExportKey(key: string): key is PartnerReportKey {
  return (PARTNER_REPORT_KEYS as readonly string[]).includes(key);
}

export function partnerExportTitle(key: PartnerReportKey, tr: (ar: string) => string): string {
  return partnerReportTitles(tr)[key];
}

/** منسّق الكمية: حتى `decimals` منازل بلا أصفار لاحقة («240» و«2.5»). صرفة. */
export function makeQuantityFormatter(locale = 'ar-SA'): (v: number, decimals: number) => string {
  const cache = new Map<number, Intl.NumberFormat | null>();
  return (v: number, decimals: number) => {
    const d = Math.max(0, Math.min(6, Math.trunc(decimals)));
    if (!cache.has(d)) {
      try { cache.set(d, new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: d })); } catch { cache.set(d, null); }
    }
    const f = cache.get(d);
    return f ? f.format(v) : String(Math.round(v * 10 ** d) / 10 ** d);
  };
}

type PartnerCell = string | number | null;
interface KeyedColumn { key: string; col: ExportColumn }
interface KeyedRow { level: number; values: Readonly<Record<string, PartnerCell>>; strong?: boolean; head?: boolean; carry?: boolean; muted?: boolean }

/** صفوف بمفاتيح الأعمدة ⇒ جدول التصدير (العمود الغائب خلية فارغة). صرفة. */
function keyedTable(columns: readonly KeyedColumn[], rows: readonly KeyedRow[], indentKey: string): ExportTable {
  return {
    columns: columns.map((c) => c.col),
    rows: rows.map((r) => ({
      level: r.level, strong: r.strong, head: r.head, carry: r.carry, muted: r.muted,
      cells: columns.map((c) => (c.key === 'level' ? r.level : r.values[c.key] ?? null)),
    })),
    indentIndex: Math.max(0, columns.findIndex((c) => c.key === indentKey)),
  };
}

/** مبلغ من الردّ (رقم بوحدة العملة) أو فارغ. صرفة. */
const partnerAmount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const qtyCell = (v: unknown): number | null => roundQuantity(typeof v === 'number' ? v : null);
const levelColumn = (tr: (ar: string) => string): KeyedColumn => ({ key: 'level', col: { label: tr('المستوى'), numeric: true, width: 0.4 } });
const QTY_DECIMALS = 4;

interface PlMatchJson { moveNumber: string | null; amount: number }
interface PlLineJson {
  date: string; moveNumber: string | null; journalCode: string | null; ref: string | null; label: string | null;
  sourceType: string | null; debit: number; credit: number; balance: number; dueDate: string | null; residual: number;
  fullyReconciled: boolean; matches: PlMatchJson[]; productName: string | null; quantity: number | null;
  attachments?: { count?: number };
}
interface PlJson {
  partner?: { type?: string; id?: string; name?: string | null };
  from: string; to: string; includeReconciled?: boolean; decimals?: number;
  opening: number; closing: number; totalDebit: number; totalCredit: number; lines: PlLineJson[];
}

/**
 * دفتر أستاذ الشريك: صفّ الافتتاح (يتكرر أعلى صفحات PDF)، ثم السطور برصيد جارٍ، ثم صفّ الإجمالي بالختام.
 * أعمدة الاستحقاق والمتبقّي والمطابقات للعميل والمورّد وحدهما (المطابقة على الذمم)، والصنف والكمية حين يحملهما سطر. صرفة.
 */
function partnerLedgerExportTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const d = data as unknown as PlJson;
  const lines = arr<PlLineJson>(d.lines);
  const isArAp = d.partner?.type === 'customer' || d.partner?.type === 'vendor';
  const hasProduct = lines.some((l) => !!l.productName || (typeof l.quantity === 'number' && l.quantity !== 0));
  const dec = Number.isFinite(data.settings?.currencyDecimals) ? data.settings.currencyDecimals : Number.isFinite(d.decimals) ? Number(d.decimals) : 2;
  const src = sourceTypeLabels(tr);
  const columns: KeyedColumn[] = [
    levelColumn(tr),
    { key: 'date', col: { label: tr('التاريخ'), width: 1 } },
    { key: 'number', col: { label: tr('رقم القيد'), width: 1.1 } },
    { key: 'journal', col: { label: tr('الدفتر'), width: 0.7 } },
    { key: 'ref', col: { label: tr('المرجع'), width: 1 } },
    { key: 'source', col: { label: tr('المستند'), width: 1 } },
    { key: 'label', col: { label: tr('البيان'), width: 2.4 } },
    ...(hasProduct ? [
      { key: 'product', col: { label: tr('الصنف'), width: 1.4 } },
      { key: 'quantity', col: { label: tr('الكمية'), numeric: true, width: 0.8, decimals: QTY_DECIMALS } },
    ] : []),
    ...(isArAp ? [{ key: 'due', col: { label: tr('الاستحقاق'), width: 1 } }] : []),
    { key: 'debit', col: { label: tr('مدين'), numeric: true, width: 1.1 } },
    { key: 'credit', col: { label: tr('دائن'), numeric: true, width: 1.1 } },
    { key: 'balance', col: { label: tr('الرصيد'), numeric: true, width: 1.2 } },
    ...(isArAp ? [
      { key: 'residual', col: { label: tr('المتبقّي'), numeric: true, width: 1.1 } },
      { key: 'matches', col: { label: tr('المطابقات'), width: 1.6 } },
    ] : []),
    { key: 'attachments', col: { label: tr('المرفقات'), numeric: true, width: 0.6, decimals: 0 } },
  ];
  // كصفّ الحساب في دفتر الأستاذ العام: اسم الشريك ورصيده الافتتاحي، ويعيده PDF أعلى كل صفحة تالية سياقاً للقارئ
  const who = txt(d.partner?.name) || txt(d.partner?.id);
  const rows: KeyedRow[] = [{
    level: 0, head: true, strong: true, carry: true,
    values: { date: txt(d.from), label: who ? `${who} — ${tr('الرصيد الافتتاحي')}` : tr('الرصيد الافتتاحي'), balance: partnerAmount(d.opening) },
  }];
  for (const l of lines) {
    const matches = arr<PlMatchJson>(l.matches).map((m) => `${txt(m.moveNumber) || '—'}: ${Number(m.amount).toFixed(dec)}`).join('، ');
    rows.push({
      level: 1,
      values: {
        date: txt(l.date), number: txt(l.moveNumber), journal: txt(l.journalCode), ref: txt(l.ref),
        source: l.sourceType ? src[l.sourceType] ?? l.sourceType : '',
        label: txt(l.label), product: txt(l.productName), quantity: qtyCell(l.quantity), due: txt(l.dueDate),
        debit: partnerAmount(l.debit), credit: partnerAmount(l.credit), balance: partnerAmount(l.balance),
        residual: partnerAmount(l.residual),
        matches: l.fullyReconciled ? (matches ? `${tr('مطابَق كلياً')} — ${matches}` : tr('مطابَق كلياً')) : matches,
        attachments: l.attachments?.count ? l.attachments.count : null,
      },
    });
  }
  rows.push({
    level: 0, strong: true,
    values: {
      date: txt(d.to), label: tr('إجمالي الفترة والرصيد الختامي'),
      debit: partnerAmount(d.totalDebit), credit: partnerAmount(d.totalCredit), balance: partnerAmount(d.closing),
    },
  });
  return keyedTable(columns, rows, 'label');
}

interface AgingColsJson { notDue: number; b1: number; b2: number; b3: number; b4: number; older: number; unappliedCredits: number; total: number }
interface AgingRowJson extends AgingColsJson { partnerId: string; name: string | null }
interface AgingDetailJson { moveNumber: string | null; date: string; dueDate: string | null; daysOverdue: number; residual: number; bucket: string }
interface AgingJson { kind?: 'AR' | 'AP'; asOf: string; basis?: string; buckets?: number[]; partnerId?: string | null; rows: AgingRowJson[]; totals: AgingColsJson; detail?: AgingDetailJson[] }

const AGING_AMOUNT_KEYS = ['notDue', 'b1', 'b2', 'b3', 'b4', 'older', 'unappliedCredits', 'total'] as const;

/**
 * أعمار الذمم: صفّ لكل شريك بأعمدته، وتحته (لشريك واحد) بنوده المفتوحة كلٌّ في عموده، ثم الإجمالي. صرفة.
 */
function agingExportTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const d = data as unknown as AgingJson;
  const kind = d.kind ?? (data.reportKey === 'aged-payable' ? 'AP' : 'AR');
  const labels = agingColumnLabels(arr<number>(d.buckets), tr, kind);
  const columns: KeyedColumn[] = [
    levelColumn(tr),
    { key: 'name', col: { label: kind === 'AR' ? tr('العميل') : tr('المورّد'), width: 2.6 } },
    ...AGING_AMOUNT_KEYS.map((k) => ({ key: k, col: { label: labels[k], numeric: true, width: k === 'unappliedCredits' ? 1.3 : 1.1 } })),
  ];
  const amounts = (c: Partial<AgingColsJson> | undefined): Record<string, PartnerCell> =>
    Object.fromEntries(AGING_AMOUNT_KEYS.map((k) => [k, partnerAmount(c?.[k])]));
  const rows: KeyedRow[] = [];
  const detail = arr<AgingDetailJson>(d.detail);
  for (const r of arr<AgingRowJson>(d.rows)) {
    rows.push({ level: 0, strong: detail.length > 0, values: { name: txt(r.name) || txt(r.partnerId), ...amounts(r) } });
  }
  for (const x of detail) {
    const col = x.bucket === 'unapplied' ? 'unappliedCredits' : x.bucket;
    const parts = [txt(x.moveNumber) || '—', txt(x.date)];
    if (x.dueDate) parts.push(`${tr('الاستحقاق')} ${x.dueDate}`);
    if (x.bucket !== 'unapplied') parts.push(`${x.daysOverdue} ${tr('يوماً')}`);
    rows.push({ level: 1, values: { name: parts.join(' · '), [col]: partnerAmount(x.residual), total: partnerAmount(x.residual) } });
  }
  rows.push({ level: 0, strong: true, values: { name: tr('الإجمالي'), ...amounts(d.totals) } });
  return keyedTable(columns, rows, 'name');
}

interface LateRowJson {
  moveNumber: string | null; sourceType: string | null; ref: string | null; partnerName: string | null;
  originalDate: string; postedDate: string; reason: string; amount: number;
}

/** المستندات التي وصلت متأخرة: قيدٌ لكل صفّ بتاريخه الأصلي وتاريخ ترحيله وسببه، ثم الإجمالي وعدده. صرفة. */
function lateArrivalsExportTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const d = data as unknown as { rows: LateRowJson[]; total: number; count: number };
  const src = sourceTypeLabels(tr);
  const reasons = lateArrivalReasonLabels(tr) as Record<string, string>;
  const columns: KeyedColumn[] = [
    levelColumn(tr),
    { key: 'number', col: { label: tr('رقم القيد'), width: 1.1 } },
    { key: 'source', col: { label: tr('المستند'), width: 1.2 } },
    { key: 'ref', col: { label: tr('المرجع'), width: 1.1 } },
    { key: 'partner', col: { label: tr('الشريك'), width: 1.6 } },
    { key: 'original', col: { label: tr('تاريخ المستند'), width: 1 } },
    { key: 'posted', col: { label: tr('تاريخ الترحيل'), width: 1 } },
    { key: 'reason', col: { label: tr('السبب'), width: 1.6 } },
    { key: 'amount', col: { label: tr('المبلغ'), numeric: true, width: 1.1 } },
  ];
  const rows: KeyedRow[] = arr<LateRowJson>(d.rows).map((r) => ({
    level: 0,
    values: {
      number: txt(r.moveNumber), source: r.sourceType ? src[r.sourceType] ?? r.sourceType : '', ref: txt(r.ref),
      partner: txt(r.partnerName), original: txt(r.originalDate), posted: txt(r.postedDate),
      reason: reasons[r.reason] ?? txt(r.reason), amount: partnerAmount(r.amount),
    },
  }));
  rows.push({ level: 0, strong: true, values: { number: `${tr('الإجمالي')} (${Number(d.count ?? rows.length)})`, amount: partnerAmount(d.total) } });
  return keyedTable(columns, rows, 'number');
}

interface ProductColsJson { quantity: number; soldQuantity: number; returnedQuantity: number; revenue: number; discount: number; returns: number; net: number }
interface ProductRowJson extends ProductColsJson { productId: string; productName: string | null }

/** تقرير الأصناف من الدفاتر: الكميات بمنازلها والمبالغ بمنازل العملة، و«الصافي = الإيراد − الخصم − المردودات». صرفة. */
function productLedgerExportTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  const d = data as unknown as { rows: ProductRowJson[]; totals: ProductColsJson };
  const columns: KeyedColumn[] = [
    levelColumn(tr),
    { key: 'name', col: { label: tr('الصنف'), width: 2.6 } },
    { key: 'soldQuantity', col: { label: tr('الكمية المباعة'), numeric: true, width: 1, decimals: QTY_DECIMALS } },
    { key: 'returnedQuantity', col: { label: tr('الكمية المرتجعة'), numeric: true, width: 1, decimals: QTY_DECIMALS } },
    { key: 'quantity', col: { label: tr('صافي الكمية'), numeric: true, width: 1, decimals: QTY_DECIMALS } },
    { key: 'revenue', col: { label: tr('الإيراد'), numeric: true, width: 1.1 } },
    { key: 'discount', col: { label: tr('الخصم'), numeric: true, width: 1.1 } },
    { key: 'returns', col: { label: tr('المردودات'), numeric: true, width: 1.1 } },
    { key: 'net', col: { label: tr('الصافي'), numeric: true, width: 1.2 } },
  ];
  const vals = (r: Partial<ProductColsJson> | undefined): Record<string, PartnerCell> => ({
    soldQuantity: qtyCell(r?.soldQuantity), returnedQuantity: qtyCell(r?.returnedQuantity), quantity: qtyCell(r?.quantity),
    revenue: partnerAmount(r?.revenue), discount: partnerAmount(r?.discount), returns: partnerAmount(r?.returns), net: partnerAmount(r?.net),
  });
  const rows: KeyedRow[] = arr<ProductRowJson>(d.rows).map((r) => ({ level: 0, values: { name: txt(r.productName) || txt(r.productId), ...vals(r) } }));
  rows.push({ level: 0, strong: true, values: { name: tr('الإجمالي'), ...vals(d.totals) } });
  return keyedTable(columns, rows, 'name');
}

/** جدول تقرير الشركاء من ردّ نقطة التصدير. صرفة. */
export function partnerExportTable(data: ReportExportData, tr: (ar: string) => string): ExportTable {
  if (data.reportKey === 'partner-ledger') return partnerLedgerExportTable(data, tr);
  if (data.reportKey === 'aged-receivable' || data.reportKey === 'aged-payable') return agingExportTable(data, tr);
  if (data.reportKey === 'late-arrivals') return lateArrivalsExportTable(data, tr);
  return productLedgerExportTable(data, tr);
}

/** ترويسة ملف تقرير الشركاء: الشركة والتقرير والشريك والفترة والخيارات والعملة وتاريخ الطباعة. صرفة. */
export function partnerExportMetaRows(input: ReportMetaInput): { label: string; value: string }[] {
  const { tr } = input;
  const data = input.data;
  const d = data as unknown as {
    partner?: { type?: string; id?: string; name?: string | null }; from?: string; to?: string; asOf?: string; includeReconciled?: boolean;
    basis?: string; buckets?: number[]; partnerId?: string | null; rows?: { name?: string | null; productName?: string | null }[];
    filters?: { productId?: string | null; customerId?: string | null; salesRepId?: string | null };
  };
  const now = input.now ?? new Date();
  const printed = (() => {
    try { return now.toLocaleString(input.locale ?? 'ar-SA'); } catch { return now.toISOString().slice(0, 16).replace('T', ' '); }
  })();
  const key = data.reportKey as PartnerReportKey;
  const out: { label: string; value: string }[] = [];
  if (input.company && input.company.trim() !== '') out.push({ label: tr('الشركة'), value: input.company.trim() });
  out.push({ label: tr('التقرير'), value: partnerExportTitle(key, tr) });
  const options: string[] = [];
  if (key === 'partner-ledger') {
    const types = partnerTypeLabels(tr) as Record<string, string>;
    const type = d.partner?.type ? types[d.partner.type] ?? d.partner.type : '';
    out.push({ label: tr('الشريك'), value: [type, txt(d.partner?.name) || txt(d.partner?.id)].filter(Boolean).join(' — ') });
    out.push({ label: tr('الفترة'), value: `${txt(d.from)} — ${txt(d.to)}` });
    options.push(d.includeReconciled === false ? tr('البنود غير المطابَقة وحدها') : tr('مع البنود المطابَقة كلياً'));
  } else if (key === 'aged-receivable' || key === 'aged-payable') {
    if (d.partnerId) out.push({ label: tr('الشريك'), value: txt(arr<{ name?: string | null }>(d.rows)[0]?.name) || d.partnerId });
    out.push({ label: tr('الفترة'), value: `${tr('اعتباراً من')} ${txt(d.asOf)}` });
    const bases = agingBasisLabels(tr) as Record<string, string>;
    options.push(bases[d.basis ?? 'due'] ?? txt(d.basis));
    if (arr<number>(d.buckets).length > 0) options.push(`${tr('الأعمدة')}: ${arr<number>(d.buckets).join(' / ')}`);
  } else {
    out.push({ label: tr('الفترة'), value: `${txt(d.from)} — ${txt(d.to)}` });
    if (key === 'product-ledger') {
      const f = d.filters ?? {};
      if (f.productId) options.push(`${tr('الصنف')}: ${txt(arr<{ productName?: string | null }>(d.rows)[0]?.productName) || f.productId}`);
      if (f.customerId) options.push(tr('عميل محدد'));
      if (f.salesRepId) options.push(tr('مندوب محدد'));
    }
  }
  if (options.length > 0) out.push({ label: tr('الخيارات'), value: options.join(' · ') });
  out.push({ label: tr('العملة'), value: `${data.settings?.currency ?? ''}` });
  out.push({ label: tr('تاريخ الطباعة'), value: printed });
  return out;
}

/** اسم ملف تقرير الشركاء: العنوان، والشريك (لدفتره)، والمدى أو تاريخ الأعمار. صرفة. */
export function partnerExportFileName(data: ReportExportData, tr: (ar: string) => string): string {
  const key = data.reportKey as PartnerReportKey;
  const d = data as unknown as { partner?: { name?: string | null }; from?: string; to?: string; asOf?: string };
  const span = key === 'aged-receivable' || key === 'aged-payable' ? txt(d.asOf) : `${txt(d.from)}_${txt(d.to)}`;
  const who = key === 'partner-ledger' ? txt(d.partner?.name) : '';
  return [partnerExportTitle(key, tr), who, span].filter((p) => p !== '').join('-').replace(/[\\/?*[\]:<>|"]/g, '·').slice(0, 80);
}
