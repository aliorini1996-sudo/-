/**
 * «المحاسب الذكي AI» — أدوات قراءة الدفاتر (المواصفة §٣.٣، الحزمة A3).
 *
 * ثلاث أدوات للنموذج، تُبنى **فقط** حين تكون الدفاتر مفعّلة (`booksActivated`) والمستخدم يملك `canViewLedger`
 * والمحاسبة مفعّلة للشركة (`accountingOn` — بلاها لا مبالغ أصلاً):
 *   - `ledger_report(key, month|from/to, account_code?)`: القوائم الخمس نفسها التي يعيدها
 *     `GET /api/ledger/reports/:key` (routes/ledger/reports.ts) — قائمة الدخل، الميزانية، ميزان المراجعة،
 *     الملخص التنفيذي (وفيه النقد وصافي حركة النقد: جواب «التدفق النقدي»)، ودفتر الأستاذ لحساب واحد.
 *   - `expenses_summary(month|from/to)`: حسابات المصروفات في الفترة — من محرّك قائمة الدخل نفسه فلا يختلف رقمٌ عنها.
 *   - `accounts_lookup(kind, search?)`: رموز وأسماء حسابات النقد/البنك/المصروفات/الالتزامات (بلا الحسابات الرقابية).
 *
 * **مطابقة المسار حرفياً:** الخيارات تمرّ بـ`parseReportRequest` نفسها، والفترة بـ`resolveReportPeriod`، والأرصدة بـ
 * `loadReportAccounts`/`loadBalanceSources`/`composeBalancesFromSources`، والقوائم بـ`STATEMENT_BUILDERS` المُصدَّرة
 * من المسار، والتنبيهات بـ`countReportWarningFacts`/`buildReportWarnings`، ثم `reportJson` (BigInt ⇒ نص بالملّي).
 * الفرق الوحيد: `buildStatement` في المسار غير مُصدَّرة فتُنسخ هنا خطوةً بخطوة بقاعدة محقونة (للاختبار بلا شبكة).
 * الافتراضات بلا فترة هي افتراضات المسار: قائمة الدخل = السنة المالية، الميزانية = اعتباراً من اليوم، غيرهما = الشهر.
 *
 * **الأرقام:** المحرّك يعيد ملّي (نصاً بعد reportJson) ⇒ `milliToNumber` يقرّبها لمنازل عملة الدفاتر نصف-لأعلى
 * (roundMilli من gl/money.ts) ثم رقماً عشرياً. المجاميع تُجمع بالملّي قبل التحويل فلا ينحرف قرشٌ بالتقريب.
 *
 * **العزل:** tenantId من السياق وحده؛ وسائط النموذج لا تحمل شركة (zod يُسقط أي مفتاح زائد).
 * كل أداة تقرير تدفع AiReport في ctx.reports (تُرسم في الواجهة وتُنزَّل PDF)، و`data` المختصرة وحدها تذهب للنموذج.
 */
import { z } from 'zod';
import prisma from '../../config/database';
import { normalizeDigits } from '../../ai-rep/advisor';
import type { AcctCtx, AiReport, Tool } from './context';
import { parsePeriod as defaultParsePeriod } from './period';
import {
  REPORT_KEYS, STATEMENT_BUILDERS, balanceSheetReclassInputs, buildLedgerSkeleton, buildReportWarnings,
  canonicalReportKey, countReportWarningFacts, loadLedgerAccountAggregates, loadLedgerLines, loadReportAccountRoles,
  parseReportRequest, reportJson, statementComparisonPeriods, statementExtras, statementWarnings, aggregateLineCount,
  type LedgerLineFilters, type ParsedReportRequest, type ReportKey, type ReportQueryInput, type ReportWarning,
  type StatementKey, type StatementPeriodBalances,
} from '../../routes/ledger/reports';
import { ledgerErrorResponse } from '../../routes/ledger/errors';
import {
  loadBalanceSources, loadReportAccounts, loadReportSettings, reportLoadOptions, assertScanRange,
  type ReportDb, type ReportSettings,
} from '../gl/reports/load';
import { composeBalancesFromSources } from '../gl/reports/balances';
import { resolveReportPeriod } from '../gl/reports/period';
import { EMPTY_ACCOUNT_ROLES } from '../gl/reports/incomeStatement';
import { buildGeneralLedger, type GeneralLedgerResult } from '../gl/reports/generalLedger';
import type { ReportPeriod } from '../gl/reports/types';
import { addDays, isLocalDate, todayLocal, zonedStartOfDay } from '../gl/dates';
import { fromMilli, roundMilli } from '../gl/money';
import { rankAccounts } from '../gl/coa/search';

// ═══ الثوابت ═══

/** أسماء أدوات هذه الحزمة (لاختبار القائمة البيضاء وللسجلّ). */
export const LEDGER_TOOL_NAMES = ['ledger_report', 'expenses_summary', 'accounts_lookup'] as const;

/** القوائم المسموحة لـledger_report — مفاتيح المسار نفسها (cash-flow وvat-return غير متاحة بعد في المحرّك). */
export const AI_LEDGER_REPORT_KEYS = REPORT_KEYS;

/** سقف سطور دفتر الأستاذ في تقرير الدردشة (فوقه تُعرض المجاميع وحدها، ويُحال المستخدم لصفحة الأستاذ). */
export const AI_GL_MAX_LINES = 200;
/** سطور الأستاذ التي تذهب للنموذج (الأحدث) — حجم السياق، لا حدّ التقرير المرسوم */
export const AI_GL_LLM_LINES = 20;
/** سقف صفوف الحسابات تحت سطرٍ واحد في القوائم (الباقي يُجمع في «حسابات أخرى») */
export const AI_ACCOUNT_ROWS_PER_LINE = 25;
/** سقف صفوف قسمٍ في ميزان المراجعة */
export const AI_TB_ROWS_PER_SECTION = 250;

const KIND_OF_KEY: Readonly<Record<ReportKey, AiReport['kind']>> = {
  'income-statement': 'income-statement',
  'balance-sheet': 'balance-sheet',
  'trial-balance': 'trial-balance',
  'executive-summary': 'executive-summary',
  'general-ledger': 'general-ledger',
};

const TITLE_OF_KEY: Readonly<Record<ReportKey, string>> = {
  'income-statement': 'قائمة الدخل',
  'balance-sheet': 'الميزانية العمومية',
  'trial-balance': 'ميزان المراجعة',
  'executive-summary': 'الملخص التنفيذي',
  'general-ledger': 'دفتر الأستاذ العام',
};

// ═══ الملّي ⇐ رقم ═══

/**
 * مبلغ ملّي (نصّ reportJson، أو bigint، أو رقم) ⇐ رقم عشري مقرَّب لمنازل العملة نصف-لأعلى.
 * المدخل الفاسد ⇒ 0 (لا NaN في تقرير). صرفة.
 */
export function milliToNumber(v: unknown, decimals = 2): number {
  const m = toBig(v);
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 3 ? decimals : 2;
  const n = fromMilli(roundMilli(m, d));
  return Object.is(n, -0) ? 0 : n;
}

/** ملّي ⇐ BigInt (نصّ عدد صحيح أو رقم أو bigint)، والفاسد صفر. صرفة. */
export function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.round(v));
  return 0n;
}

/** رقمٌ للملخّص العربي: فواصل الآلاف ومنازل العملة بحدّ أقصى. صرفة. */
export function fmtAmount(n: number, decimals = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: Math.max(0, Math.min(3, decimals)) });
}

// ═══ أشكال الردّ بعد reportJson (المبالغ نصوص ملّي) ═══

type MilliJson = string | number | null | undefined;

export interface LedgerReportJson {
  reportKey: string;
  period: { from: string; to: string; fyStart?: string };
  settings: { currency: string; currencyDecimals: number; timezone?: string };
  mode?: string;
  rows: unknown[];
  totals: unknown;
  lineCount?: number;
  warnings?: { code: string; message: string }[];
  asOf?: string;
  [extra: string]: unknown;
}

interface AccountRowJson { accountId?: string; code: string; name: string; type?: string; amountMilli: MilliJson }
interface IsGroupJson { key: string; label: string; amountMilli: MilliJson; accounts?: AccountRowJson[] }
interface IsLineJson {
  key: string; label: string; amountMilli: MilliJson; total: boolean;
  accounts?: AccountRowJson[]; groups?: IsGroupJson[];
}
interface BsNodeJson {
  key: string; label: string; amountMilli: MilliJson; total: boolean;
  accounts?: AccountRowJson[]; children?: BsNodeJson[];
}
interface BsTotalsJson {
  totalAssetsMilli?: MilliJson; totalLiabilitiesMilli?: MilliJson; totalEquityMilli?: MilliJson;
  currentYearEarningsMilli?: MilliJson; previousYearsEarningsMilli?: MilliJson; imbalanceMilli?: MilliJson;
  balanced?: boolean; totalLine?: BsNodeJson;
}
interface TbCellJson { openingMilli?: MilliJson; debitMilli?: MilliJson; creditMilli?: MilliJson; endingMilli?: MilliJson }
interface TbRowJson { kind: string; code: string; name: string; cells?: TbCellJson[] }
interface ExecCardJson {
  key: string; kind: string; label: string; amountMilli?: MilliJson;
  value?: number; defined?: boolean; decimals?: number;
}
interface GlLineJson {
  date: string; moveNumber?: string | null; label?: string | null; journalName?: string | null;
  partnerName?: string | null; debitMilli: MilliJson; creditMilli: MilliJson; runningMilli?: MilliJson;
}
interface GlSectionJson {
  account: { code: string; name: string; type?: string };
  openingMilli: MilliJson; debitMilli: MilliJson; creditMilli: MilliJson; endingMilli: MilliJson;
  lineCount?: number; lines?: GlLineJson[];
}

/** ناتج التحويل: التقرير المرسوم، والبيانات المختصرة للنموذج، والملخّص العربي الحتمي. */
export interface MappedReport {
  report: AiReport;
  data: Record<string, unknown>;
  summaryAr: string;
}

type Row = AiReport['sections'][number]['rows'][number];
type Section = AiReport['sections'][number];

interface Meta { currency: string; decimals: number; from: string; to: string }

function metaOf(json: LedgerReportJson): Meta {
  const decimals = Number.isInteger(json.settings?.currencyDecimals) ? json.settings.currencyDecimals : 2;
  return {
    currency: json.settings?.currency || 'SAR',
    decimals,
    from: json.period?.from ?? '',
    to: json.period?.to ?? '',
  };
}

/** تنبيهات الردّ (RPT‑08 وتحذيرات المحرّك) ⇒ ملاحظات التقرير بنصّها العربي. */
function warningNotes(json: LedgerReportJson): string[] {
  return (json.warnings ?? []).map((w) => w.message).filter((m): m is string => typeof m === 'string' && m.length > 0);
}

/** صفوف حسابات بسقف، والباقي يُجمع في صفّ «حسابات أخرى (N)» بالملّي. */
function accountRows(list: readonly AccountRowJson[] | undefined, level: 0 | 1 | 2, d: number, withCode: boolean): Row[] {
  const rows: Row[] = [];
  const all = (list ?? []).filter((a) => toBig(a.amountMilli) !== 0n);
  for (const a of all.slice(0, AI_ACCOUNT_ROWS_PER_LINE)) {
    rows.push({ label: withCode ? `${a.code} ${a.name}` : a.name, amount: milliToNumber(a.amountMilli, d), level });
  }
  const rest = all.slice(AI_ACCOUNT_ROWS_PER_LINE);
  if (rest.length > 0) {
    let sum = 0n;
    for (const a of rest) sum += toBig(a.amountMilli);
    rows.push({ label: `حسابات أخرى (${rest.length})`, amount: milliToNumber(sum, d), level });
  }
  return rows;
}

// ═══ قائمة الدخل ═══

const IS_SECTIONS: readonly { title: string; keys: readonly string[] }[] = [
  { title: 'الإيرادات', keys: ['grossRevenue', 'salesDeductions', 'revenue'] },
  { title: 'تكلفة الإيرادات', keys: ['costOfRevenue', 'grossProfit'] },
  { title: 'المصروفات', keys: ['operatingExpenses', 'operatingIncome', 'otherIncome', 'otherExpenses', 'profitBeforeZakat', 'zakat'] },
  { title: 'النتيجة', keys: ['netProfit', 'drawings', 'netProfitAfterDrawings'] },
];

const isLines = (json: LedgerReportJson): IsLineJson[] =>
  (Array.isArray(json.rows) ? json.rows : []) as IsLineJson[];

/** صفوف سطر من قائمة الدخل: السطر، ثم مجموعاته وحساباته (السطر المجموع بلا تفصيل). */
function incomeLineRows(line: IsLineJson, d: number): Row[] {
  const rows: Row[] = [{ label: line.label, amount: milliToNumber(line.amountMilli, d), level: 0, ...(line.total ? { bold: true } : {}) }];
  if (line.total) return rows;
  for (const g of line.groups ?? []) {
    if (toBig(g.amountMilli) === 0n && !(g.accounts ?? []).some((a) => toBig(a.amountMilli) !== 0n)) continue;
    rows.push({ label: g.label, amount: milliToNumber(g.amountMilli, d), level: 1 });
    rows.push(...accountRows(g.accounts, 2, d, false));
  }
  rows.push(...accountRows(line.accounts, 1, d, false));
  return rows;
}

const lineAmount = (lines: readonly IsLineJson[], key: string): bigint =>
  toBig(lines.find((l) => l.key === key)?.amountMilli);

/** حسابات المصروفات (تشغيلية + أخرى) مسطّحةً من سطور قائمة الدخل — لأعلى المصروفات. */
function expenseAccountsOf(lines: readonly IsLineJson[], keys: readonly string[]): AccountRowJson[] {
  const out: AccountRowJson[] = [];
  for (const l of lines) {
    if (!keys.includes(l.key)) continue;
    out.push(...(l.accounts ?? []));
    for (const g of l.groups ?? []) out.push(...(g.accounts ?? []));
  }
  return out;
}

function topAccounts(list: readonly AccountRowJson[], n: number, d: number): { code: string; name: string; amount: number }[] {
  return [...list]
    .filter((a) => toBig(a.amountMilli) !== 0n)
    .sort((a, b) => {
      const x = toBig(a.amountMilli);
      const y = toBig(b.amountMilli);
      return y > x ? 1 : y < x ? -1 : a.code < b.code ? -1 : 1;
    })
    .slice(0, n)
    .map((a) => ({ code: a.code, name: a.name, amount: milliToNumber(a.amountMilli, d) }));
}

/** قائمة الدخل ⇒ تقرير: الإيرادات، التكلفة ومجمل الربح، المصروفات، النتيجة. صرفة. */
export function mapIncomeStatement(json: LedgerReportJson): MappedReport {
  const m = metaOf(json);
  const d = m.decimals;
  const lines = isLines(json);
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const sections: Section[] = [];
  for (const s of IS_SECTIONS) {
    const rows: Row[] = [];
    for (const k of s.keys) {
      const l = byKey.get(k);
      if (!l) continue;
      const empty = !l.total && toBig(l.amountMilli) === 0n
        && !(l.accounts ?? []).some((a) => toBig(a.amountMilli) !== 0n)
        && !(l.groups ?? []).some((g) => toBig(g.amountMilli) !== 0n);
      if (empty) continue;
      rows.push(...incomeLineRows(l, d));
    }
    if (rows.length > 0) sections.push({ title: s.title, rows });
  }
  const n = (k: string) => milliToNumber(lineAmount(lines, k), d);
  const net = lineAmount(lines, 'netProfit');
  const hasDrawings = byKey.has('netProfitAfterDrawings');
  const data: Record<string, unknown> = {
    report: 'income-statement',
    period: { from: m.from, to: m.to },
    currency: m.currency,
    revenue: n('revenue'),
    ...(lineAmount(lines, 'salesDeductions') !== 0n ? { gross_revenue: n('grossRevenue'), sales_returns_discounts: n('salesDeductions') } : {}),
    cost_of_revenue: n('costOfRevenue'),
    gross_profit: n('grossProfit'),
    operating_expenses: n('operatingExpenses'),
    operating_income: n('operatingIncome'),
    other_income: n('otherIncome'),
    other_expenses: n('otherExpenses'),
    zakat: n('zakat'),
    net_profit: n('netProfit'),
    ...(hasDrawings ? { drawings: n('drawings'), net_profit_after_drawings: n('netProfitAfterDrawings') } : {}),
    top_expense_accounts: topAccounts(expenseAccountsOf(lines, ['operatingExpenses', 'otherExpenses']), 8, d),
    ...(warningNotes(json).length ? { warnings: warningNotes(json) } : {}),
  };
  const netWord = net < 0n ? 'صافي الخسارة' : 'صافي الربح';
  const summaryAr = `قائمة الدخل من ${m.from} إلى ${m.to}: الإيرادات ${fmtAmount(n('revenue'), d)}، `
    + `مجمل الربح ${fmtAmount(n('grossProfit'), d)}، المصروفات التشغيلية ${fmtAmount(n('operatingExpenses'), d)}، `
    + `${netWord} ${fmtAmount(Math.abs(n('netProfit')), d)} ${m.currency}.`;
  return {
    report: {
      kind: 'income-statement',
      title: TITLE_OF_KEY['income-statement'],
      period: { from: m.from, to: m.to },
      currency: m.currency,
      sections,
      notes: warningNotes(json),
    },
    data,
    summaryAr,
  };
}

// ═══ الميزانية ═══

const bsNodes = (json: LedgerReportJson): BsNodeJson[] => (Array.isArray(json.rows) ? json.rows : []) as BsNodeJson[];

function hasValue(node: BsNodeJson): boolean {
  if (toBig(node.amountMilli) !== 0n) return true;
  if ((node.accounts ?? []).some((a) => toBig(a.amountMilli) !== 0n)) return true;
  return (node.children ?? []).some(hasValue);
}

/** عقد الجذر مسطّحة: كل عقدة صفّ بمستواها، وحساباتها غير الصفرية تحتها؛ الابن بتسمية أبيه يُدمج فيه. */
function balanceNodeRows(node: BsNodeJson, depth: number, d: number, parentLabel: string | null): Row[] {
  const rows: Row[] = [];
  if (!node.total && !hasValue(node)) return rows;
  const merged = parentLabel !== null && node.label === parentLabel;
  const level = Math.min(Math.max(depth - 1, 0), 2) as 0 | 1 | 2;
  if (!merged) rows.push({ label: node.label, amount: milliToNumber(node.amountMilli, d), level, ...(node.total ? { bold: true } : {}) });
  const childLevel = (merged ? level : Math.min(level + 1, 2)) as 0 | 1 | 2;
  for (const c of node.children ?? []) rows.push(...balanceNodeRows(c, depth + 1, d, node.label));
  rows.push(...accountRows(node.accounts, childLevel, d, false));
  return rows;
}

function findNode(nodes: readonly BsNodeJson[], key: string): BsNodeJson | undefined {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = findNode(n.children ?? [], key);
    if (hit) return hit;
  }
  return undefined;
}

/** الميزانية «اعتباراً من» ⇒ تقرير: الأصول، الالتزامات، حقوق الملكية، ثم سطر الالتزامات + الملكية. صرفة. */
export function mapBalanceSheet(json: LedgerReportJson): MappedReport {
  const m = metaOf(json);
  const d = m.decimals;
  const roots = bsNodes(json);
  const totals = (json.totals ?? {}) as BsTotalsJson;
  const asOf = typeof json.asOf === 'string' && json.asOf ? json.asOf : m.to;
  const sections: Section[] = [];
  for (const root of roots) {
    const rows: Row[] = [];
    for (const c of root.children ?? []) rows.push(...balanceNodeRows(c, 1, d, root.label));
    rows.push(...accountRows(root.accounts, 0, d, false));
    rows.push({ label: `إجمالي ${root.label}`, amount: milliToNumber(root.amountMilli, d), level: 0, bold: true });
    sections.push({ title: root.label, rows });
  }
  if (totals.totalLine) {
    sections.push({
      title: null,
      rows: [{ label: totals.totalLine.label, amount: milliToNumber(totals.totalLine.amountMilli, d), level: 0, bold: true }],
    });
  }
  const notes = warningNotes(json);
  if (totals.balanced === false) {
    notes.unshift(`تنبيه: الميزانية غير متوازنة بفرق ${fmtAmount(milliToNumber(totals.imbalanceMilli, d), d)} ${m.currency} — راجع المحاسب.`);
  }
  const node = (k: string) => milliToNumber(findNode(roots, k)?.amountMilli, d);
  const data: Record<string, unknown> = {
    report: 'balance-sheet',
    as_of: asOf,
    currency: m.currency,
    total_assets: milliToNumber(totals.totalAssetsMilli, d),
    total_liabilities: milliToNumber(totals.totalLiabilitiesMilli, d),
    total_equity: milliToNumber(totals.totalEquityMilli, d),
    current_year_earnings: milliToNumber(totals.currentYearEarningsMilli, d),
    previous_years_earnings: milliToNumber(totals.previousYearsEarningsMilli, d),
    cash_and_banks: node('assetCash'),
    receivables: node('assetReceivable'),
    current_assets: node('currentAssets'),
    current_liabilities: node('currentLiabilities'),
    payables: node('liabilityPayable'),
    balanced: totals.balanced !== false,
    ...(notes.length ? { warnings: notes } : {}),
  };
  const summaryAr = `الميزانية كما في ${asOf}: الأصول ${fmtAmount(milliToNumber(totals.totalAssetsMilli, d), d)}، `
    + `الالتزامات ${fmtAmount(milliToNumber(totals.totalLiabilitiesMilli, d), d)}، `
    + `حقوق الملكية ${fmtAmount(milliToNumber(totals.totalEquityMilli, d), d)} ${m.currency}.`;
  return {
    report: {
      kind: 'balance-sheet',
      title: TITLE_OF_KEY['balance-sheet'],
      period: { from: asOf, to: asOf },
      currency: m.currency,
      sections,
      notes,
    },
    data,
    summaryAr,
  };
}

// ═══ ميزان المراجعة ═══

/**
 * ميزان المراجعة بالأرصدة ⇒ تقرير بعمود مبلغ واحد: «أرصدة مدينة» و«أرصدة دائنة» (الدائن موجباً) ومجموع كلٍّ،
 * ثم حركة الفترة (إجمالي المدين والدائن). المجاميع بالملّي فيتساوى القسمان حرفاً حين يتوازن الميزان. صرفة.
 */
export function mapTrialBalance(json: LedgerReportJson): MappedReport {
  const m = metaOf(json);
  const d = m.decimals;
  const rows = ((Array.isArray(json.rows) ? json.rows : []) as TbRowJson[]).filter((r) => r.kind !== 'group');
  const totals = (Array.isArray(json.totals) ? json.totals : []) as TbCellJson[];
  const balanced = (json as { balanced?: unknown }).balanced !== false;
  const debit: { row: TbRowJson; ending: bigint }[] = [];
  const credit: { row: TbRowJson; ending: bigint }[] = [];
  for (const r of rows) {
    const ending = toBig(r.cells?.[0]?.endingMilli);
    if (ending > 0n) debit.push({ row: r, ending });
    else if (ending < 0n) credit.push({ row: r, ending: -ending });
  }
  const label = (r: TbRowJson) => (r.code ? `${r.code} ${r.name}` : r.name);
  const sectionOf = (title: string, totalLabel: string, list: { row: TbRowJson; ending: bigint }[]): { section: Section; total: bigint } => {
    let total = 0n;
    for (const x of list) total += x.ending;
    const shown = list.slice(0, AI_TB_ROWS_PER_SECTION).map((x) => ({ label: label(x.row), amount: milliToNumber(x.ending, d), level: 0 as const }));
    const rest = list.slice(AI_TB_ROWS_PER_SECTION);
    if (rest.length > 0) {
      let s = 0n;
      for (const x of rest) s += x.ending;
      shown.push({ label: `حسابات أخرى (${rest.length})`, amount: milliToNumber(s, d), level: 0 as const });
    }
    return { section: { title, rows: [...shown, { label: totalLabel, amount: milliToNumber(total, d), level: 0, bold: true }] }, total };
  };
  const dr = sectionOf('أرصدة مدينة', 'إجمالي الأرصدة المدينة', debit);
  const cr = sectionOf('أرصدة دائنة', 'إجمالي الأرصدة الدائنة', credit);
  const base = totals[0] ?? {};
  const movement: Section = {
    title: 'حركة الفترة',
    rows: [
      { label: 'إجمالي المدين', amount: milliToNumber(base.debitMilli, d), level: 0 },
      { label: 'إجمالي الدائن', amount: milliToNumber(base.creditMilli, d), level: 0 },
    ],
  };
  const notes = warningNotes(json);
  notes.unshift(balanced ? 'الميزان متوازن.' : 'تنبيه: الميزان غير متوازن — راجع المحاسب.');
  const ranked = [...debit.map((x) => ({ ...x, sign: 1n })), ...credit.map((x) => ({ ...x, sign: -1n }))]
    .sort((a, b) => (b.ending > a.ending ? 1 : b.ending < a.ending ? -1 : 0))
    .slice(0, 30)
    .map((x) => ({ code: x.row.code, name: x.row.name, balance: milliToNumber(x.ending * x.sign, d) }));
  const data: Record<string, unknown> = {
    report: 'trial-balance',
    period: { from: m.from, to: m.to },
    currency: m.currency,
    total_debit_balances: milliToNumber(dr.total, d),
    total_credit_balances: milliToNumber(cr.total, d),
    balanced,
    period_debit: milliToNumber(base.debitMilli, d),
    period_credit: milliToNumber(base.creditMilli, d),
    accounts_with_balance: debit.length + credit.length,
    note: 'balance > 0 is a debit balance, < 0 a credit balance',
    largest_balances: ranked,
    ...(notes.length > 1 ? { warnings: notes.slice(1) } : {}),
  };
  const summaryAr = `ميزان المراجعة من ${m.from} إلى ${m.to}: الأرصدة المدينة ${fmtAmount(milliToNumber(dr.total, d), d)} `
    + `والدائنة ${fmtAmount(milliToNumber(cr.total, d), d)} ${m.currency} — ${balanced ? 'متوازن' : 'غير متوازن'}.`;
  return {
    report: {
      kind: 'trial-balance',
      title: TITLE_OF_KEY['trial-balance'],
      period: { from: m.from, to: m.to },
      currency: m.currency,
      sections: [dr.section, cr.section, movement],
      notes,
    },
    data,
    summaryAr,
  };
}

// ═══ الملخّص التنفيذي ═══

const EXEC_SECTIONS: readonly { title: string; keys: readonly string[] }[] = [
  { title: 'الأداء', keys: ['revenue', 'grossProfit', 'grossMargin', 'netProfit', 'netMargin'] },
  { title: 'النقد والسيولة', keys: ['cash', 'netCashFlow', 'currentRatio'] },
  { title: 'الذمم', keys: ['receivable', 'payable', 'dso', 'dpo'] },
];

/** نصّ بطاقة نسبة: ٪ للهوامش، «يوماً» للفترات، ورقم مجرّد للنسبة الجارية؛ غير المعرَّفة «—». صرفة. */
export function ratioText(card: Pick<ExecCardJson, 'kind' | 'value' | 'defined'>): string {
  if (card.defined === false || typeof card.value !== 'number' || !Number.isFinite(card.value)) return '—';
  const v = fmtAmount(card.value, 2);
  if (card.kind === 'percent') return `${v}٪`;
  if (card.kind === 'days') return `${v} يوماً`;
  return v;
}

const ratioValue = (c: ExecCardJson | undefined): number | null =>
  c && c.defined !== false && typeof c.value === 'number' && Number.isFinite(c.value) ? c.value : null;

/**
 * الملخّص التنفيذي ⇒ تقرير: الأداء، النقد والسيولة (النقد آخر الفترة وصافي حركته — جواب «التدفق النقدي»)، الذمم.
 * بطاقات المال مبالغ، والنِّسب نصوص بلا مبلغ. صرفة.
 */
export function mapExecutiveSummary(json: LedgerReportJson): MappedReport {
  const m = metaOf(json);
  const d = m.decimals;
  const cards = (Array.isArray(json.rows) ? json.rows : []) as ExecCardJson[];
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const sections: Section[] = [];
  for (const s of EXEC_SECTIONS) {
    const rows: Row[] = [];
    for (const k of s.keys) {
      const c = byKey.get(k);
      if (!c) continue;
      rows.push(c.kind === 'money'
        ? { label: c.label, amount: milliToNumber(c.amountMilli, d), level: 0 }
        : { label: c.label, amount: null, text: ratioText(c), level: 0 });
    }
    if (rows.length > 0) sections.push({ title: s.title, rows });
  }
  const money = (k: string) => milliToNumber(byKey.get(k)?.amountMilli, d);
  const notes = [
    'صافي حركة النقد = مجموع حركة الحسابات النقدية والبنكية في الفترة؛ قائمة التدفقات النقدية التفصيلية غير متاحة بعد في الدفاتر.',
    ...warningNotes(json),
  ];
  const data: Record<string, unknown> = {
    report: 'executive-summary',
    period: { from: m.from, to: m.to },
    currency: m.currency,
    revenue: money('revenue'),
    gross_profit: money('grossProfit'),
    gross_margin_pct: ratioValue(byKey.get('grossMargin')),
    net_profit: money('netProfit'),
    net_margin_pct: ratioValue(byKey.get('netMargin')),
    cash_at_period_end: money('cash'),
    net_cash_flow: money('netCashFlow'),
    receivables: money('receivable'),
    payables: money('payable'),
    dso_days: ratioValue(byKey.get('dso')),
    dpo_days: ratioValue(byKey.get('dpo')),
    current_ratio: ratioValue(byKey.get('currentRatio')),
    cash_flow_note: 'net_cash_flow = movement of cash and bank accounts in the period (no detailed cash-flow statement yet)',
    ...(warningNotes(json).length ? { warnings: warningNotes(json) } : {}),
  };
  const summaryAr = `الملخص التنفيذي من ${m.from} إلى ${m.to}: الإيراد ${fmtAmount(money('revenue'), d)}، `
    + `صافي الربح ${fmtAmount(money('netProfit'), d)}، النقد ${fmtAmount(money('cash'), d)}، `
    + `صافي حركة النقد ${fmtAmount(money('netCashFlow'), d)} ${m.currency}.`;
  return {
    report: {
      kind: 'executive-summary',
      title: TITLE_OF_KEY['executive-summary'],
      period: { from: m.from, to: m.to },
      currency: m.currency,
      sections,
      notes,
    },
    data,
    summaryAr,
  };
}

// ═══ دفتر الأستاذ (كشف حساب) ═══

/** بيان سطر الأستاذ: التاريخ · رقم القيد · البيان (أو الشريك أو الدفتر). صرفة. */
export function ledgerLineLabel(l: GlLineJson): string {
  const desc = (l.label && l.label.trim()) || (l.partnerName && l.partnerName.trim()) || (l.journalName && l.journalName.trim()) || '';
  return [l.date, l.moveNumber || '—', desc].filter((x) => x !== '').join(' · ');
}

/**
 * دفتر الأستاذ لحساب ⇒ تقرير: الافتتاحي، ثم الحركات (المدين موجب والدائن سالب)، ثم إجمالي المدين والدائن والختامي.
 * `truncated` حين تجاوزت حركات الفترة سقف الدردشة: المجاميع كاملة والسطور غير معروضة. صرفة.
 */
export function mapGeneralLedger(json: LedgerReportJson, opts: { truncated?: boolean } = {}): MappedReport {
  const m = metaOf(json);
  const d = m.decimals;
  const secs = (Array.isArray(json.rows) ? json.rows : []) as GlSectionJson[];
  const sections: Section[] = [];
  const notes: string[] = ['المبالغ الموجبة مدينة والسالبة دائنة.'];
  const llmAccounts: Record<string, unknown>[] = [];
  for (const s of secs) {
    const lines = s.lines ?? [];
    const rows: Row[] = [{ label: 'الرصيد الافتتاحي', amount: milliToNumber(s.openingMilli, d), level: 0, bold: true }];
    for (const l of lines.slice(0, AI_GL_MAX_LINES)) {
      rows.push({ label: ledgerLineLabel(l), amount: milliToNumber(toBig(l.debitMilli) - toBig(l.creditMilli), d), level: 1 });
    }
    rows.push({ label: 'إجمالي المدين', amount: milliToNumber(s.debitMilli, d), level: 0 });
    rows.push({ label: 'إجمالي الدائن', amount: milliToNumber(s.creditMilli, d), level: 0 });
    rows.push({ label: 'الرصيد الختامي', amount: milliToNumber(s.endingMilli, d), level: 0, bold: true });
    sections.push({ title: `${s.account.code} ${s.account.name}`, rows });
    const total = typeof s.lineCount === 'number' ? s.lineCount : lines.length;
    const shown = Math.min(lines.length, AI_GL_MAX_LINES);
    if (opts.truncated === true || total > shown) {
      notes.push(`عُرضت ${shown} من أصل ${total} حركة لحساب ${s.account.name} — ضيّق الفترة أو افتح دفتر الأستاذ العام في «الدفاتر» للتفصيل الكامل.`);
    }
    llmAccounts.push({
      code: s.account.code,
      name: s.account.name,
      opening: milliToNumber(s.openingMilli, d),
      debit: milliToNumber(s.debitMilli, d),
      credit: milliToNumber(s.creditMilli, d),
      closing: milliToNumber(s.endingMilli, d),
      line_count: total,
      latest_lines: lines.slice(-AI_GL_LLM_LINES).map((l) => ({
        date: l.date,
        number: l.moveNumber ?? null,
        label: (l.label || l.partnerName || l.journalName || '').slice(0, 80),
        debit: milliToNumber(l.debitMilli, d),
        credit: milliToNumber(l.creditMilli, d),
      })),
    });
  }
  notes.push(...warningNotes(json));
  const first = secs[0];
  const title = first ? `${TITLE_OF_KEY['general-ledger']} — ${first.account.name}` : TITLE_OF_KEY['general-ledger'];
  const data: Record<string, unknown> = {
    report: 'general-ledger',
    period: { from: m.from, to: m.to },
    currency: m.currency,
    accounts: llmAccounts,
    ...(notes.length > 1 ? { notes: notes.slice(1) } : {}),
  };
  const summaryAr = first
    ? `كشف حساب ${first.account.name} من ${m.from} إلى ${m.to}: الافتتاحي ${fmtAmount(milliToNumber(first.openingMilli, d), d)}، `
      + `المدين ${fmtAmount(milliToNumber(first.debitMilli, d), d)}، الدائن ${fmtAmount(milliToNumber(first.creditMilli, d), d)}، `
      + `الختامي ${fmtAmount(milliToNumber(first.endingMilli, d), d)} ${m.currency}.`
    : `لا حركات في الفترة من ${m.from} إلى ${m.to}.`;
  return {
    report: {
      kind: 'general-ledger',
      title,
      period: { from: m.from, to: m.to },
      currency: m.currency,
      sections,
      notes,
    },
    data,
    summaryAr,
  };
}

// ═══ ملخّص المصروفات (من قائمة الدخل نفسها) ═══

const EXPENSE_SECTIONS: readonly { key: string; title: string; totalLabel: string }[] = [
  { key: 'operatingExpenses', title: 'المصروفات التشغيلية', totalLabel: 'إجمالي المصروفات التشغيلية' },
  { key: 'costOfRevenue', title: 'تكلفة البضاعة المباعة', totalLabel: 'إجمالي تكلفة البضاعة المباعة' },
  { key: 'otherExpenses', title: 'مصروفات أخرى', totalLabel: 'إجمالي المصروفات الأخرى' },
  { key: 'zakat', title: 'الزكاة وضريبة الدخل', totalLabel: 'إجمالي الزكاة وضريبة الدخل' },
];

/**
 * المصروفات بالحساب من مخرَج قائمة الدخل (لا معادلة موازية): التشغيلية بمجموعاتها، ثم تكلفة المبيعات والأخرى والزكاة،
 * والإجمالي = مجموع الأسطر الأربعة بالملّي. الأقسام الصفرية تُحذف عدا التشغيلية. صرفة.
 */
export function mapExpensesSummary(json: LedgerReportJson): MappedReport {
  const m = metaOf(json);
  const d = m.decimals;
  const lines = isLines(json);
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const sections: Section[] = [];
  let total = 0n;
  for (const s of EXPENSE_SECTIONS) {
    const l = byKey.get(s.key);
    const amount = toBig(l?.amountMilli);
    total += amount;
    if (!l || (amount === 0n && s.key !== 'operatingExpenses')) continue;
    const rows: Row[] = [];
    for (const g of l.groups ?? []) {
      if (toBig(g.amountMilli) === 0n && !(g.accounts ?? []).some((a) => toBig(a.amountMilli) !== 0n)) continue;
      rows.push({ label: g.label, amount: milliToNumber(g.amountMilli, d), level: 0 });
      rows.push(...accountRows(g.accounts, 1, d, false));
    }
    rows.push(...accountRows(l.accounts, 0, d, false));
    rows.push({ label: s.totalLabel, amount: milliToNumber(amount, d), level: 0, bold: true });
    sections.push({ title: s.title, rows });
  }
  sections.push({ title: null, rows: [{ label: 'إجمالي المصروفات', amount: milliToNumber(total, d), level: 0, bold: true }] });
  const n = (k: string) => milliToNumber(lineAmount(lines, k), d);
  const notes = ['من القيود المرحّلة في الدفاتر للفترة.', ...warningNotes(json)];
  const data: Record<string, unknown> = {
    report: 'expenses',
    period: { from: m.from, to: m.to },
    currency: m.currency,
    total_expenses: milliToNumber(total, d),
    operating_expenses: n('operatingExpenses'),
    cost_of_goods_sold: n('costOfRevenue'),
    other_expenses: n('otherExpenses'),
    zakat: n('zakat'),
    top_accounts: topAccounts(expenseAccountsOf(lines, ['operatingExpenses', 'costOfRevenue', 'otherExpenses', 'zakat']), 12, d),
    ...(warningNotes(json).length ? { warnings: warningNotes(json) } : {}),
  };
  const summaryAr = `مصروفات الفترة من ${m.from} إلى ${m.to}: الإجمالي ${fmtAmount(milliToNumber(total, d), d)}، `
    + `منها تشغيلية ${fmtAmount(n('operatingExpenses'), d)} وتكلفة مبيعات ${fmtAmount(n('costOfRevenue'), d)} ${m.currency}.`;
  return {
    report: {
      kind: 'expenses',
      title: 'ملخص المصروفات',
      period: { from: m.from, to: m.to },
      currency: m.currency,
      sections,
      notes,
    },
    data,
    summaryAr,
  };
}

/** موزّع التحويل بمفتاح التقرير. صرفة. */
export function mapLedgerReport(json: LedgerReportJson, opts: { truncated?: boolean } = {}): MappedReport {
  switch (json.reportKey) {
    case 'income-statement': return mapIncomeStatement(json);
    case 'balance-sheet': return mapBalanceSheet(json);
    case 'trial-balance': return mapTrialBalance(json);
    case 'executive-summary': return mapExecutiveSummary(json);
    case 'general-ledger': return mapGeneralLedger(json, opts);
    default: throw new Error(`mapLedgerReport: مفتاح غير معروف ${json.reportKey}`);
  }
}

// ═══ القراءة: نسخة GET /api/ledger/reports/:key بقاعدة محقونة ═══

interface BuiltForAi {
  period: ReportPeriod;
  mode: 'AGGREGATE' | 'LINE_SCAN';
  rows: unknown[];
  totals: unknown;
  lineCount: number;
  extra: Record<string, unknown>;
  accountFilterIgnored: boolean;
  engineWarnings: ReportWarning[];
  truncated: boolean;
}

/** `buildStatement` (routes/ledger/reports.ts) خطوةً بخطوة — غير مُصدَّرة هناك وتقرأ prisma العامّة. */
async function buildStatementForAi(
  db: ReportDb,
  tenantId: string,
  key: StatementKey,
  req: ParsedReportRequest,
  settings: ReportSettings,
  period: ReportPeriod,
): Promise<BuiltForAi> {
  const loadOpts = reportLoadOptions(req.options);
  const [accounts, sources] = await Promise.all([
    loadReportAccounts(db, tenantId),
    loadBalanceSources(db, tenantId, period, loadOpts),
  ]);
  const balances = composeBalancesFromSources(sources, accounts, req.options.includeDrafts);
  const cmpPeriods = statementComparisonPeriods(key, period, req.options, settings.fy);
  const comparisons: StatementPeriodBalances[] = [];
  for (const p of cmpPeriods) {
    const s = await loadBalanceSources(db, tenantId, p, loadOpts);
    comparisons.push({ period: p, balances: composeBalancesFromSources(s, accounts, req.options.includeDrafts) });
  }
  const roles = key === 'trial-balance' ? EMPTY_ACCOUNT_ROLES : await loadReportAccountRoles(db, tenantId, accounts);
  const reclass = key === 'balance-sheet' ? await balanceSheetReclassInputs(db, tenantId, period, cmpPeriods) : null;
  if (reclass) comparisons.forEach((c, i) => { c.partnerReclass = reclass.comparisons[i] ?? null; });
  const result = STATEMENT_BUILDERS[key]({
    reportKey: key,
    period,
    accounts,
    balances,
    settings,
    options: req.options,
    roles,
    showZero: req.showZero,
    draftMoveCount: sources.draftMoveCount,
    comparisons,
    ...(reclass?.linkedPosting ? { linkedPosting: true, partnerReclass: reclass.base } : {}),
  });
  return {
    period,
    mode: sources.mode,
    rows: result.rows,
    totals: result.totals,
    lineCount: typeof result.lineCount === 'number' ? result.lineCount : result.rows.length,
    extra: { ...statementExtras(result), draftMoveCount: sources.draftMoveCount },
    accountFilterIgnored: req.accounts.length > 0,
    engineWarnings: statementWarnings(result),
    truncated: false,
  };
}

/**
 * دفتر الأستاذ لحسابٍ واحد: حتى `maxLines` حركة ⇒ مسار التصدير نفسه (كل السطور + `buildGeneralLedger`)؛
 * وفوقه ⇒ «الهيكل» (`buildLedgerSkeleton` من إجماليات `groupBy`) بأرقام الفترة كاملة وبلا سطور.
 */
async function buildAccountLedgerForAi(
  db: ReportDb,
  tenantId: string,
  accountId: string,
  req: ParsedReportRequest,
  period: ReportPeriod,
  maxLines: number,
): Promise<BuiltForAi> {
  // دفتر الأستاذ يمسّ البنود دائماً ⇒ سقف 12 شهراً كالمسار (422 LEDGER_RANGE_TOO_LARGE)
  assertScanRange(period);
  const accountIds = [accountId];
  const filters: LedgerLineFilters = {
    accountIds,
    journals: req.options.journals,
    analytic: req.options.analytic,
    salesReps: req.options.salesReps,
    partners: [],
    includeDrafts: req.options.includeDrafts,
  };
  const loadOpts = reportLoadOptions(req.options, { accountIds });
  const [accounts, sources, aggregates] = await Promise.all([
    loadReportAccounts(db, tenantId, { accountIds }),
    loadBalanceSources(db, tenantId, period, loadOpts),
    loadLedgerAccountAggregates(db, tenantId, period, filters),
  ]);
  const balances = composeBalancesFromSources(sources, accounts, req.options.includeDrafts);
  const count = aggregateLineCount(aggregates.get(accountId));
  let result: GeneralLedgerResult;
  let truncated = false;
  if (count <= maxLines) {
    const lines = await loadLedgerLines(db, tenantId, period, filters);
    result = buildGeneralLedger({
      period, accounts, balances, lines,
      options: { pageSize: null, page: 1, hideZero: req.options.hideZero, search: req.options.search, partners: [], openingScope: 'account' },
    });
  } else {
    truncated = true;
    const skeleton = buildLedgerSkeleton({
      period, accounts, balances, aggregates,
      hideZero: req.options.hideZero, search: req.options.search, partners: [], openingScope: 'account',
    });
    // سطور الهيكل صناعية (إجماليات) فلا تُعرض أبداً، وعدد السطور الحقيقي من الإجماليات (كما يفعل mergeLedgerPages)
    let lineCount = 0;
    const sections = skeleton.sections.map((s) => {
      const n = aggregateLineCount(aggregates.get(s.account.id));
      lineCount += n;
      return { ...s, lines: [], lineCount: n };
    });
    result = { ...skeleton, sections, totals: { ...skeleton.totals, lineCount, displayedLineCount: 0 } };
  }
  return {
    period,
    mode: sources.mode,
    rows: result.sections,
    totals: result.totals,
    lineCount: result.totals.lineCount,
    extra: { accountFilter: accountIds },
    accountFilterIgnored: false,
    engineWarnings: result.warnings.map((w) => ({ code: w.code, message: w.message, details: w.details })),
    truncated,
  };
}

export interface LoadLedgerReportOptions {
  /** «الآن» لافتراض الفترة (يُحقن في الاختبار) */
  now?: Date;
  /** دفتر الأستاذ: الحساب الواحد (إلزامي لـgeneral-ledger في الدردشة) */
  accountId?: string;
  /** سقف سطور الأستاذ قبل الاكتفاء بالمجاميع */
  maxLines?: number;
}

/**
 * تقرير دفاتر بشكل ردّ `GET /api/ledger/reports/:key` (‏`reportJson`: المبالغ نصوص ملّي) — الخيارات والافتراضات
 * والتنبيهات كالمسار. ترمي أخطاء الدفاتر كما هي (LedgerError/LedgerHttpError) ويحوّلها المستدعي لرسالة.
 */
export async function loadLedgerReport(
  db: ReportDb,
  tenantId: string,
  key: ReportKey,
  q: ReportQueryInput,
  opts: LoadLedgerReportOptions = {},
): Promise<LedgerReportJson & { truncated: boolean }> {
  const settings = await loadReportSettings(db, tenantId);
  const parsed = parseReportRequest(key, q, todayLocal(opts.now ?? new Date(), settings.timezone), false);
  const period = resolveReportPeriod(parsed.options.dateFilter, settings.fy);
  let built: BuiltForAi;
  if (key === 'general-ledger') {
    if (!opts.accountId) throw new Error('loadLedgerReport: دفتر الأستاذ في الدردشة لحسابٍ واحد');
    built = await buildAccountLedgerForAi(db, tenantId, opts.accountId, parsed, period, opts.maxLines ?? AI_GL_MAX_LINES);
  } else {
    built = await buildStatementForAi(db, tenantId, key, parsed, settings, period);
  }
  const facts = await countReportWarningFacts(db, tenantId, built.period, settings.timezone, {
    filtered: built.mode === 'LINE_SCAN',
    comparisonIgnored: false,
    accountFilterIgnored: built.accountFilterIgnored,
    dateModeCoerced: parsed.dateModeCoerced,
  });
  const warnings = [...buildReportWarnings(facts), ...built.engineWarnings];
  const body = reportJson({
    ...built.extra,
    reportKey: key,
    period: built.period,
    settings: {
      currency: settings.currency,
      currencyDecimals: settings.currencyDecimals,
      timezone: settings.timezone,
    },
    mode: built.mode,
    rows: built.rows,
    totals: built.totals,
    lineCount: built.lineCount,
    warnings,
  }) as LedgerReportJson;
  return { ...body, truncated: built.truncated };
}

// ═══ الفترة من وسائط النموذج ═══

export interface PeriodArgs { from?: string; to?: string; month?: string }
type ParsePeriodFn = typeof defaultParsePeriod;

const cleanArg = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = normalizeDigits(v).trim();
  return s === '' ? undefined : s;
};

/**
 * فترة شاملة الطرفين من وسائط النموذج عبر parsePeriod (A2، بتوقيت الشركة). `null` حين لا فترة (افتراض المسار).
 * `to` يُشتق شاملاً من `lt` إن جاء حصرياً (حدٌّ يساوي منتصف ليل `toLocal`) — فلا يتوقف على اصطلاح المُعيد. صرفة.
 */
export function aiPeriodOf(
  args: PeriodArgs,
  tz: string,
  today: string,
  parse: ParsePeriodFn = defaultParsePeriod,
  opts: { emptyAsDefault?: boolean } = {},
): { from: string; to: string } | { error: string } | null {
  const a: PeriodArgs = { from: cleanArg(args.from), to: cleanArg(args.to), month: cleanArg(args.month) };
  // بلا فترة: null (افتراض المسار) — أو افتراض parsePeriod نفسه حين يُطلب
  if (!a.from && !a.to && !a.month && opts.emptyAsDefault !== true) return null;
  const r = parse(a, tz, today);
  if ('error' in r) return { error: r.error };
  const from = r.fromLocal;
  let to = r.toLocal;
  if (isLocalDate(to) && zonedStartOfDay(to, tz).getTime() === r.lt.getTime()) to = addDays(to, -1);
  if (!isLocalDate(from) || !isLocalDate(to) || to < from) return { error: 'فترة غير صالحة — اكتب الشهر YYYY-MM أو من/إلى YYYY-MM-DD' };
  return { from, to };
}

/**
 * وسائط المسار (`ReportQueryInput`) من فترة الدردشة: الميزانية «اعتباراً من» نهاية الفترة (أو `to` وحده حرفياً)،
 * وغيرها مدى مخصّص؛ ولا فترة ⇒ `{}` فتسري افتراضات المسار. صرفة.
 */
export function reportQueryOf(
  key: ReportKey,
  args: PeriodArgs,
  tz: string,
  today: string,
  parse: ParsePeriodFn = defaultParsePeriod,
): ReportQueryInput | { error: string } {
  if (key === 'balance-sheet') {
    const to = cleanArg(args.to);
    if (to && !cleanArg(args.from) && !cleanArg(args.month)) {
      return isLocalDate(to) ? { mode: 'asOf', asOf: to } : { error: `تاريخ «${args.to}» غير صالح — الصيغة YYYY-MM-DD` };
    }
  }
  const p = aiPeriodOf(args, tz, today, parse);
  if (p === null) return {};
  if ('error' in p) return p;
  return key === 'balance-sheet' ? { mode: 'asOf', asOf: p.to } : { mode: 'custom', from: p.from, to: p.to };
}

// ═══ دليل الحسابات ═══

export const ACCOUNT_LOOKUP_KINDS = ['cash', 'bank', 'expense', 'liability'] as const;
export type AccountLookupKind = (typeof ACCOUNT_LOOKUP_KINDS)[number];

const TYPES_OF_KIND: Readonly<Record<AccountLookupKind, readonly string[]>> = {
  cash: ['asset_cash'],
  bank: ['asset_cash'],
  expense: ['expense', 'expense_direct_cost', 'expense_depreciation', 'expense_other', 'expense_zakat'],
  liability: ['liability_current', 'liability_non_current', 'liability_credit_card', 'liability_payable'],
};

const BANK_NAME_RE = /بنك|مصرف|\bbank\b/i;

export interface LookupAccountRow {
  id: string; code: string; name: string; nameEn?: string | null; nameI18n?: unknown; type: string;
}

/** حساب نقدي بنكي؟ مفتاح MAIN_BANK أو حساب دفترٍ بنكي افتراضي أو بادئة 1111 أو اسمٌ فيه «بنك/مصرف». صرفة. */
export function isBankAccount(a: Pick<LookupAccountRow, 'id' | 'code' | 'name' | 'nameEn'>, bankIds: ReadonlySet<string>): boolean {
  return bankIds.has(a.id) || a.code.startsWith('1111') || BANK_NAME_RE.test(a.name) || BANK_NAME_RE.test(a.nameEn ?? '');
}

/** يصفّي حسابات النوع (النقد بلا البنوك والعكس) ويرتّبها بالبحث إن وُجد. صرفة. */
export function filterLookupAccounts<T extends LookupAccountRow>(
  rows: readonly T[],
  kind: AccountLookupKind,
  bankIds: ReadonlySet<string>,
  search?: string,
): T[] {
  const types = new Set(TYPES_OF_KIND[kind]);
  let out = rows.filter((r) => types.has(r.type));
  if (kind === 'cash') out = out.filter((r) => !isBankAccount(r, bankIds));
  if (kind === 'bank') out = out.filter((r) => isBankAccount(r, bankIds));
  if (search && search.trim()) out = rankAccounts(out, search.trim());
  return out;
}

// ═══ الأدوات ═══

export interface LedgerReadDeps {
  /** القاعدة (افتراضاً prisma) — تُحقن في الاختبار */
  db?: ReportDb;
  now?: () => Date;
  parsePeriod?: ParsePeriodFn;
}

const optStr = z.string().max(40).nullish();

const ledgerReportArgs = z.object({
  key: z.string().max(40),
  month: optStr,
  from: optStr,
  to: optStr,
  account_code: optStr,
});

const expensesArgs = z.object({ month: optStr, from: optStr, to: optStr });

const lookupArgs = z.object({
  kind: z.enum(ACCOUNT_LOOKUP_KINDS),
  search: z.string().max(80).nullish(),
});

const periodSchemaProps = {
  month: { type: 'string', description: "Month 'YYYY-MM' or just 'MM' (current year), e.g. '2026-11' or '11'." },
  from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' },
  to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' },
} as const;

/** يدفع التقرير في السياق مستبدلاً تقريراً مطابقاً (النوع والعنوان والفترة) فلا يتكرر في الواجهة. */
function pushReport(ctx: AcctCtx, report: AiReport): void {
  const sig = (r: AiReport) => `${r.kind}|${r.title}|${r.period?.from ?? ''}|${r.period?.to ?? ''}`;
  const s = sig(report);
  const i = ctx.reports.findIndex((r) => sig(r) === s);
  if (i >= 0) ctx.reports.splice(i, 1);
  ctx.reports.push(report);
}

/** أخطاء الدفاتر المعروفة (فترة طويلة، فترة مقلوبة…) ⇒ رسالة للنموذج؛ غيرها يُرمى (runAdvisor: «tool failed»). */
function ledgerFailure(e: unknown): { error: string } {
  const r = ledgerErrorResponse(e);
  if (r) {
    const msg = (r.body as { message?: unknown }).message;
    return { error: typeof msg === 'string' && msg ? msg : 'تعذّر إعداد التقرير' };
  }
  if (e instanceof RangeError) return { error: e.message };
  throw e;
}

/**
 * أدوات قراءة الدفاتر للمحاسب الذكي. لا أدوات إطلاقاً ما لم تكن المحاسبة مفعّلة والدفاتر مفعّلة والمستخدم يملك
 * `canViewLedger` (الحارس يُحكم في السياق من صفوف القاعدة لا من النموذج).
 */
export function buildLedgerReadTools(ctx: AcctCtx, deps: LedgerReadDeps = {}): Tool[] {
  if (!ctx.accountingOn || !ctx.booksActivated || !ctx.canViewLedger) return [];
  const db: ReportDb = deps.db ?? (prisma as unknown as ReportDb);
  const now = deps.now ?? (() => new Date());
  const parse = deps.parsePeriod ?? defaultParsePeriod;
  const tenantId = ctx.tenantId;

  const ledgerReport: Tool = {
    spec: {
      type: 'function',
      function: {
        name: 'ledger_report',
        description: 'Official accounting statements from the company books (posted journal entries), computed by the server exactly like the Ledger reports pages. '
          + 'key: "income-statement" (profit & loss: revenue, cost of goods sold, gross profit, expenses, net profit), '
          + '"balance-sheet" (assets, liabilities, equity as of the period end date), "trial-balance" (account balances), '
          + '"executive-summary" (revenue, gross/net profit and margins, cash at period end, NET CASH FLOW of cash and bank accounts, receivables, payables, DSO/DPO, current ratio — use it for cash-flow questions), '
          + '"general-ledger" (statement of ONE account — requires account_code; get codes from accounts_lookup). '
          + 'Period: month ("YYYY-MM" or "MM") or from/to (YYYY-MM-DD). Without a period: income-statement = current fiscal year, balance-sheet = as of today, others = current month. '
          + 'Quote the returned figures exactly; never compute new ones.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: [...AI_LEDGER_REPORT_KEYS] },
            ...periodSchemaProps,
            account_code: { type: 'string', description: 'Account code (e.g. "111001") — only for key "general-ledger".' },
          },
          required: ['key'],
          additionalProperties: false,
        },
      },
    },
    async run(args) {
      const p = ledgerReportArgs.safeParse(args);
      if (!p.success) return { error: 'invalid arguments — key is required; month/from/to are strings' };
      // «Income_Statement» ⇒ income-statement؛ ثم القائمة البيضاء نفسها التي يقبلها المسار (ومرادفه profit-and-loss)
      const rawKey = p.data.key.trim().toLowerCase().replace(/[_\s]+/g, '-');
      const key = canonicalReportKey(rawKey);
      if (!key) {
        return {
          error: `unknown report "${rawKey}" — use one of ${AI_LEDGER_REPORT_KEYS.join(', ')}`
            + (rawKey === 'cash-flow' ? '; for cash flow use executive-summary (cash and net_cash_flow)' : ''),
        };
      }
      const q = reportQueryOf(key, { month: p.data.month ?? undefined, from: p.data.from ?? undefined, to: p.data.to ?? undefined }, ctx.tz, ctx.todayLocal, parse);
      if ('error' in q) return { error: String(q.error) };
      let accountId: string | undefined;
      if (key === 'general-ledger') {
        const code = cleanArg(p.data.account_code ?? undefined);
        if (!code || !/^\d{3,10}$/.test(code)) return { error: 'general-ledger needs account_code (digits) — call accounts_lookup first' };
        const acc = await db.glAccount.findFirst({ where: { tenantId, code }, select: { id: true } });
        if (!acc) return { error: `no account with code ${code} — call accounts_lookup` };
        accountId = acc.id;
      }
      try {
        const json = await loadLedgerReport(db, tenantId, key, q, { now: now(), ...(accountId ? { accountId } : {}) });
        const mapped = mapLedgerReport(json, { truncated: json.truncated });
        pushReport(ctx, mapped.report);
        return { data: mapped.data, summaryAr: mapped.summaryAr };
      } catch (e) {
        return ledgerFailure(e);
      }
    },
  };

  const expensesSummary: Tool = {
    spec: {
      type: 'function',
      function: {
        name: 'expenses_summary',
        description: 'Expenses recorded in the company books for a period, by account: operating expenses (selling / general & administrative), cost of goods sold, other expenses and zakat, with totals and the largest accounts. '
          + 'Same numbers as the income statement. Period: month ("YYYY-MM" or "MM") or from/to (YYYY-MM-DD); default = current month to today.',
        parameters: { type: 'object', properties: { ...periodSchemaProps }, additionalProperties: false },
      },
    },
    async run(args) {
      const p = expensesArgs.safeParse(args);
      if (!p.success) return { error: 'invalid arguments — month/from/to are strings' };
      const a: PeriodArgs = { month: p.data.month ?? undefined, from: p.data.from ?? undefined, to: p.data.to ?? undefined };
      // بلا فترة: افتراض parsePeriod (الشهر الحالي حتى اليوم) — لا افتراض «السنة المالية» لقائمة الدخل
      const range = aiPeriodOf(a, ctx.tz, ctx.todayLocal, parse, { emptyAsDefault: true });
      if (range === null) return { error: 'period could not be resolved' };
      if ('error' in range) return { error: range.error };
      try {
        const json = await loadLedgerReport(db, tenantId, 'income-statement', { mode: 'custom', from: range.from, to: range.to }, { now: now() });
        const mapped = mapExpensesSummary(json);
        pushReport(ctx, mapped.report);
        return { data: mapped.data, summaryAr: mapped.summaryAr };
      } catch (e) {
        return ledgerFailure(e);
      }
    },
  };

  const accountsLookup: Tool = {
    spec: {
      type: 'function',
      function: {
        name: 'accounts_lookup',
        description: "List the company's chart-of-accounts entries (code + name) of one kind: cash (cash boxes), bank (bank accounts), expense, liability. "
          + 'Control accounts (receivables, payables, custody, VAT, inventory) are excluded. Optional search text (Arabic or English, synonyms supported, e.g. "إيجار", "بنزين").',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...ACCOUNT_LOOKUP_KINDS] },
            search: { type: 'string', description: 'Optional words to rank matching accounts first.' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
    },
    async run(args) {
      const p = lookupArgs.safeParse(args);
      if (!p.success) return { error: `kind must be one of ${ACCOUNT_LOOKUP_KINDS.join(', ')}` };
      const { kind } = p.data;
      const search = typeof p.data.search === 'string' ? normalizeDigits(p.data.search).trim().slice(0, 80) : '';
      const rows = await db.glAccount.findMany({
        where: { tenantId, isActive: true, controlKind: null, type: { in: [...TYPES_OF_KIND[kind]] } },
        select: { id: true, code: true, name: true, nameEn: true, nameI18n: true, type: true },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      const bankIds = new Set<string>();
      if (kind === 'cash' || kind === 'bank') {
        const [journals, mappings] = await Promise.all([
          db.glJournal.findMany({ where: { tenantId, type: 'BANK', defaultAccountId: { not: null } }, select: { defaultAccountId: true } }),
          db.glAccountMapping.findMany({ where: { tenantId, key: 'MAIN_BANK' }, select: { accountId: true } }),
        ]);
        for (const j of journals) if (j.defaultAccountId) bankIds.add(j.defaultAccountId);
        for (const m of mappings) bankIds.add(m.accountId);
      }
      const list = filterLookupAccounts(rows as LookupAccountRow[], kind, bankIds, search || undefined);
      const shown = list.slice(0, search ? 20 : 80).map((r) => ({ code: r.code, name: r.name, type: r.type }));
      const KIND_AR: Record<AccountLookupKind, string> = { cash: 'الصناديق', bank: 'البنوك', expense: 'المصروفات', liability: 'الالتزامات' };
      return {
        data: { kind, count: list.length, accounts: shown, ...(list.length > shown.length ? { more: list.length - shown.length } : {}) },
        summaryAr: list.length
          ? `حسابات ${KIND_AR[kind]}: ${shown.slice(0, 5).map((a) => `${a.code} ${a.name}`).join('، ')}${list.length > 5 ? '…' : ''}`
          : `لا توجد حسابات ${KIND_AR[kind]} مطابقة في دليل الحسابات.`,
      };
    },
  };

  return [ledgerReport, expensesSummary, accountsLookup];
}
