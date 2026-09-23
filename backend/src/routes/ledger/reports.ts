import crypto from 'node:crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { ledgerExportLimiter } from '../../middleware/rateLimits';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, canonicalJson, ledgerActor } from '../../services/gl/audit';
import { addDays, fromDbDate, isLocalDate, todayLocal, toDbDate, zonedStartOfDay } from '../../services/gl/dates';
import { LedgerError, type LocalDate, type Milli } from '../../services/gl/types';
import { composeBalancesFromSources, zeroBalance } from '../../services/gl/reports/balances';
import {
  assertScanRange, loadBalanceSources, loadReportAccounts, loadReportSettings, reportLoadOptions,
  type ReportDb, type ReportSettings,
} from '../../services/gl/reports/load';
import { comparisonPeriods, resolveReportPeriod, type FiscalYearConfig } from '../../services/gl/reports/period';
import { buildTrialBalance, serializeTrialBalance } from '../../services/gl/reports/trialBalance';
import {
  DRAWINGS_KEY, EMPTY_ACCOUNT_ROLES, RETAINED_EARNINGS_KEY, buildIncomeStatement, reportAccountRoles,
  type IncomeStatement, type ReportAccountRoles,
} from '../../services/gl/reports/incomeStatement';
import { buildBalanceSheet, flattenBalanceSheet, type BalanceSheet } from '../../services/gl/reports/balanceSheet';
import { buildExecutiveSummary, executiveSummaryLineCount } from '../../services/gl/reports/executive';
import {
  MAX_FILTER_IDS, MAX_SEARCH_LENGTH, REPORT_BREAKDOWNS, REPORT_COMPARISON_KINDS, REPORT_DATE_MODES,
  normalizeReportOptions, requiresLineScan,
  type AccountBalance, type ReportAccount, type ReportDateFilter, type ReportOptions, type ReportPeriod,
} from '../../services/gl/reports/types';
import {
  GENERAL_LEDGER_MAX_PAGE_SIZE, GENERAL_LEDGER_PAGE_SIZE, buildGeneralLedger, generalLedgerExportLines,
  isShiftedLine, normalizePage, normalizePageSize, sortLedgerLines,
  type GeneralLedgerResult, type GeneralLedgerRow, type GeneralLedgerSection, type GeneralLedgerTotals,
  type LedgerLineInput,
} from '../../services/gl/reports/generalLedger';

/**
 * تقارير الدفاتر (M4، DESIGN.md §7.1 إلى §7.5، RPT‑01…RPT‑15، ملحق أ).
 *
 * - `GET /reports/:key` (canViewLedger): ميزان المراجعة وقائمة الدخل والميزانية ودفتر الأستاذ العام،
 *   بخيارات §7.1 الموحّدة (zod)، وردٍّ موحّد `{reportKey, period, options, rows, totals, comparison, warnings}`.
 * - `POST /reports/:key/export` (canViewLedger + `ledgerExportLimiter`): **مجموعة البيانات كاملة**
 *   بلا ترقيم ولا طيّ ولا تحميل كسول (§7.1 RPT‑01)، بسقف 50,000 سطر لـxlsx و5,000 لـpdf، وفوقه 422
 *   `LEDGER_EXPORT_TOO_LARGE {lines, cap}`، ثم صفّ تدقيق `EXPORT`. الخادم لا يبني ملفاً (ADR‑9).
 *
 * **لا مزامنة تلقائية** (§5.1، §7.1): فتح التقرير لا يشغّل المُرحِّل؛ يُحسب تنبيه RPT‑08 بعدّين
 * رخيصين (مسودات ≤ `to`، وأحداث `PENDING/BLOCKED/ERROR/HELD` بـ`effectAt ≤ to`) ويُعاد في `warnings`
 * مع زر «مزامنة الآن» اليدوي في الواجهة.
 *
 * **تقسيم المسؤولية (§7.1، ADR‑9):** المنطق المحاسبي كلّه في دوالّ `services/gl/reports/*` الصرفة،
 * وقراءة الأرصدة في `reports/load.ts`. القراءة الوحيدة هنا هي سطور دفتر الأستاذ التفصيلية
 * (`loadLedgerLines`) لأنّ `loadBalanceSources` لا تحمل أعمدة §7.5 (الرقم والدفتر والشريك والبيان)،
 * ومعها تركيبُ **صفحة** الأستاذ (ترقيمٌ لا محاسبة) في دوالّ صرفة مُصدَّرة أدناه.
 *
 * **عقد المبالغ (قرار M4):** كل مبلغ في الردّ **نصّ عدد صحيح بالملّي** تحت مفتاح ينتهي بـ`Milli`.
 * لا تنسيق ولا تقريب ولا وحدة عرض على الخادم: الوحدة (`unit`، RPT‑06) ومنازل العملة بيانٌ وصفي
 * في `options`/`settings` تصيّر به الواجهة. والمسار لا يلمس مبلغاً — يمرّر مخرَج الوحدات كما هو،
 * و`reportJson` تحوّل BigInt إلى نصّه حرفاً بحرف.
 *
 * **مفتاح التقرير واحد في كل موضع:** `income-statement` (مسار الواجهة، ومفتاح النقطة، ومفتاح
 * الوحدة). `profit-and-loss` اسمٌ داخلي في `reports/incomeStatement.ts` يُقبل **مرادفاً في المدخل
 * وحده** ولا يظهر في الردّ أبداً (‏`reportKey` وحده يسمّي التقرير).
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');
const locals = (res: Response) => res.locals.ledger as LedgerLocals;

// ═══ المفاتيح ═══

export const REPORT_KEYS = ['trial-balance', 'income-statement', 'balance-sheet', 'general-ledger', 'executive-summary'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** القوائم الثلاث التي تبنيها وحدات §7.2/§7.3/§7.4 من الأرصدة المُجمَّعة. */
export const STATEMENT_KEYS = ['trial-balance', 'income-statement', 'balance-sheet', 'executive-summary'] as const;
export type StatementKey = (typeof STATEMENT_KEYS)[number];

export function isReportKey(v: unknown): v is ReportKey {
  return typeof v === 'string' && (REPORT_KEYS as readonly string[]).includes(v);
}

export function isStatementKey(v: unknown): v is StatementKey {
  return typeof v === 'string' && (STATEMENT_KEYS as readonly string[]).includes(v);
}

/**
 * مرادفات **المدخل وحده**: الاسم الداخلي لوحدة قائمة الدخل (`profit-and-loss`) يُقبل في المسار
 * فلا ينكسر رابطٌ قديم، ويُعاد دائماً تحت المفتاح الواحد `income-statement`.
 */
export const REPORT_KEY_ALIASES: Readonly<Record<string, ReportKey>> = Object.freeze({
  'profit-and-loss': 'income-statement',
});

/** المفتاح القانوني للمدخل (المرادف يُحلّ)، أو `null` إن لم يكن تقريراً معروفاً. صرفة. */
export function canonicalReportKey(raw: string): ReportKey | null {
  if (isReportKey(raw)) return raw;
  return REPORT_KEY_ALIASES[raw] ?? null;
}

/** تقارير §7.6 إلى §7.10 تُسلَّم مع مراحلها (M4+/M5/M6/M7/M11) — 404 مفهوم لا «مفتاح مجهول». */
export const LATER_REPORT_KEYS = [
  'partner-ledger', 'aged-receivable', 'aged-payable', 'vat-return', 'cash-flow',
] as const;

// ═══ السقوف ═══

/** §7.1: XLSX حتى 50,000 سطر، وPDF حتى 5,000 (نحو 100 صفحة A4). */
export const REPORT_EXPORT_CAPS: Readonly<Record<'xlsx' | 'pdf', number>> = { xlsx: 50_000, pdf: 5_000 };
export type ExportFormat = keyof typeof REPORT_EXPORT_CAPS;

/**
 * سقف دفاعي لسطور دفتر الأستاذ في طلب واحد (ذاكرة الخادم، لا سقف §7.1).
 * يخصّ **التصدير وحده** بعد اليوم: العرض يقرأ صفحةً واحدة لكل حساب فلا يبلغه أصلاً.
 */
export const LEDGER_LINES_MAX = 200_000;
export const LEDGER_LINES_BATCH = 5_000;

/** أقصى طول لمؤشّر الصفحة في الاستعلام (حمايةٌ من سلسلة ضخمة قبل فكّ الترميز). */
export const MAX_CURSOR_LENGTH = 512;

/** يرفض التصدير فوق سقف صيغته (422 `LEDGER_EXPORT_TOO_LARGE {lines, cap}`، §7.1). صرفة. */
export function assertExportUnderCap(format: ExportFormat, lines: number): void {
  const cap = REPORT_EXPORT_CAPS[format];
  if (lines > cap) throw new LedgerError('LEDGER_EXPORT_TOO_LARGE', { lines, cap, format });
}

// ═══ تنبيه RPT‑08 (صرف) ═══

export interface ReportWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReportWarningFacts {
  /** قيود مسودة بتاريخ ≤ `to` */
  draftMoveCount: number;
  /** أحداث PENDING/BLOCKED/ERROR/HELD بـ`effectAt ≤ to` (بلا أحداث المخزون) */
  pendingEventCount: number;
  /** أحداث المخزون المنتظرة للأفق الآمن — تُذكر منفصلة (§5.4) */
  pendingStockEventCount: number;
  /** وضع مسح البنود: وسم «مفلتر، أبطأ» (§7.1) */
  filtered: boolean;
  /** التقرير لا يدعم أعمدة المقارنة وقد طُلبت */
  comparisonIgnored?: boolean;
  /** فلتر الحسابات لا ينطبق على القوائم (مجاميعها تفترض كل الحسابات) وقد أُرسل */
  accountFilterIgnored?: boolean;
  /** §7.4: أُجبر وضع التاريخ على «اعتباراً من» */
  dateModeCoerced?: boolean;
}

export const RPT08_MESSAGE = 'توجد قيود غير مرحّلة أو أحداث بانتظار الترحيل ضمن هذه الفترة أو قبلها';
export const RPT08_STOCK_MESSAGE = 'أحداث مخزون بانتظار الأفق الآمن للترحيل (تتأخر عشر دقائق على الأقل)';
export const RPT08_FILTERED_MESSAGE = 'مفلتر، أبطأ: التقرير محسوب من البنود مباشرةً لا من الأرصدة الشهرية';
export const RPT08_NO_COMPARISON_MESSAGE = 'هذا التقرير لا يدعم أعمدة المقارنة، وقد أُهملت';
export const RPT08_AS_OF_MESSAGE =
  'الميزانية العمومية تُقرأ «اعتباراً من» تاريخ واحد، فقُرئ المدى المطلوب على تاريخ نهايته';
export const RPT08_ACCOUNT_FILTER_MESSAGE =
  'فلتر الحسابات لا ينطبق على القوائم المالية (مجاميعها تشمل كل الحسابات)، وقد أُهمل: استعمل دفتر الأستاذ العام';

/**
 * تنبيهات الردّ (§7.1 RPT‑08). **صرفة**: لا تستدعي مزامنة ولا تلمس القاعدة — الحقائق تُعدّ خارجها.
 */
export function buildReportWarnings(f: ReportWarningFacts): ReportWarning[] {
  const out: ReportWarning[] = [];
  if (f.draftMoveCount > 0 || f.pendingEventCount > 0) {
    out.push({
      code: 'UNPOSTED_ENTRIES',
      message: RPT08_MESSAGE,
      details: { draftMoves: f.draftMoveCount, pendingEvents: f.pendingEventCount, syncPath: '/api/ledger/sync' },
    });
  }
  if (f.pendingStockEventCount > 0) {
    out.push({
      code: 'STOCK_EVENTS_PENDING',
      message: RPT08_STOCK_MESSAGE,
      details: { pendingStockEvents: f.pendingStockEventCount },
    });
  }
  if (f.filtered) out.push({ code: 'FILTERED_SCAN', message: RPT08_FILTERED_MESSAGE });
  if (f.comparisonIgnored === true) out.push({ code: 'COMPARISON_NOT_SUPPORTED', message: RPT08_NO_COMPARISON_MESSAGE });
  if (f.accountFilterIgnored === true) out.push({ code: 'ACCOUNT_FILTER_IGNORED', message: RPT08_ACCOUNT_FILTER_MESSAGE });
  if (f.dateModeCoerced === true) out.push({ code: 'DATE_MODE_AS_OF', message: RPT08_AS_OF_MESSAGE });
  return out;
}

/** أنواع أحداث المخزون التي تنتظر الأفق الآمن (§5.4). */
export const STOCK_SOURCE_TYPES = ['WH_ENTRY', 'VAN_LOAD', 'RESTOCK'] as const;
const PENDING_EVENT_STATUSES = ['PENDING', 'BLOCKED', 'ERROR', 'HELD'] as const;

/** عدّان رخيصان لتنبيه RPT‑08 — قراءة فقط وبلا أي استدعاء للمُرحِّل (§5.1). */
export async function countReportWarningFacts(
  tx: ReportDb,
  tenantId: string,
  period: ReportPeriod,
  timezone: string,
  flags: { filtered: boolean; comparisonIgnored?: boolean; accountFilterIgnored?: boolean; dateModeCoerced?: boolean },
): Promise<ReportWarningFacts> {
  const toDb = toDbDate(period.to);
  const effectBefore = zonedStartOfDay(addDays(period.to, 1), timezone);
  const [draftMoveCount, pendingEventCount, pendingStockEventCount] = await Promise.all([
    tx.glMove.count({ where: { tenantId, state: 'DRAFT', date: { lte: toDb } } }),
    tx.glSourceEvent.count({
      where: {
        tenantId, status: { in: [...PENDING_EVENT_STATUSES] }, effectAt: { lt: effectBefore },
        sourceType: { notIn: [...STOCK_SOURCE_TYPES] },
      },
    }),
    tx.glSourceEvent.count({
      where: {
        tenantId, status: { in: [...PENDING_EVENT_STATUSES] }, effectAt: { lt: effectBefore },
        sourceType: { in: [...STOCK_SOURCE_TYPES] },
      },
    }),
  ]);
  return {
    draftMoveCount,
    pendingEventCount,
    pendingStockEventCount,
    filtered: flags.filtered,
    comparisonIgnored: flags.comparisonIgnored === true,
    accountFilterIgnored: flags.accountFilterIgnored === true,
    dateModeCoerced: flags.dateModeCoerced === true,
  };
}

// ═══ الخيارات (zod، §7.1) ═══

const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]);
const intish = z.union([z.number(), z.string().regex(/^-?\d{1,9}$/)]);
const idsish = z.union([z.string(), z.array(z.string())]);
const dateish = z.string().refine(isLocalDate, { message: 'تاريخ غير صالح' });

const optionsShape = {
  mode: z.enum(REPORT_DATE_MODES).optional(),
  from: dateish.optional(),
  to: dateish.optional(),
  /** مرادف `to` في «اعتباراً من» (§7.4) */
  asOf: dateish.optional(),
  comparison: z.enum(REPORT_COMPARISON_KINDS).optional(),
  comparisonCount: intish.optional(),
  postedOnly: boolish.optional(),
  includeDrafts: boolish.optional(),
  unit: intish.optional(),
  hierarchy: boolish.optional(),
  hideZero: boolish.optional(),
  /** RPT‑14: «إظهار الصفري» — حسابات قائمة الدخل بلا حركة تظهر (§7.3). مستقل عن `hideZero`. */
  showZero: boolish.optional(),
  journals: idsish.optional(),
  analytic: idsish.optional(),
  salesReps: idsish.optional(),
  accounts: idsish.optional(),
  partners: idsish.optional(),
  search: z.string().max(MAX_SEARCH_LENGTH).optional(),
  breakdown: z.enum(REPORT_BREAKDOWNS).optional(),
  page: intish.optional(),
  pageSize: intish.optional(),
  /** §7.1 «التحميل الكسول»: مؤشّر keyset يعيده قسم الحساب في `nextCursor` — يحمّل صفحته التالية */
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
};

export const reportQuerySchema = z.object(optionsShape);
export const reportExportSchema = z.object({ ...optionsShape, format: z.enum(['xlsx', 'pdf']) });
export type ReportQueryInput = z.infer<typeof reportQuerySchema>;

const asBool = (v: boolean | 'true' | 'false' | '1' | '0' | undefined): boolean | undefined =>
  v === undefined ? undefined : v === true || v === 'true' || v === '1';
const asInt = (v: number | string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};
const asIds = (v: string | string[] | undefined): string[] => {
  if (v === undefined) return [];
  const raw = Array.isArray(v) ? v : v.split(',');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const s = typeof x === 'string' ? x.trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_FILTER_IDS) break;
  }
  return out;
};

/** الفترة الافتراضية لكل تقرير: الشهر الحالي (§7.2)، والسنة المالية (§7.3)، و«اعتباراً من اليوم» (§7.4). */
export function defaultDateFilter(key: ReportKey, today: LocalDate): ReportDateFilter {
  if (key === 'balance-sheet') return { mode: 'asOf', from: today, to: today };
  if (key === 'income-statement') return { mode: 'fiscalYear', from: today, to: today };
  return { mode: 'month', from: today, to: today };
}

/**
 * فلتر التاريخ من الاستعلام (RPT‑02، RPT‑03). صرفة.
 * `custom` يحتاج الطرفين، و`to` قبل `from` ⇒ 400 (لا `RangeError` من `makePeriod`).
 */
export function resolveDateFilter(key: ReportKey, q: ReportQueryInput, today: LocalDate): ReportDateFilter {
  const fallback = defaultDateFilter(key, today);
  // §7.4: فلتر الميزانية «اعتباراً من» تاريخ واحد دائماً لا مدى، وأي وضع آخر يُحوّل إليه بتنبيه
  const mode = key === 'balance-sheet' ? 'asOf' : (q.mode ?? fallback.mode);
  if (mode === 'asOf') {
    const d = q.asOf ?? q.to ?? q.from ?? today;
    return { mode, from: d, to: d };
  }
  if (mode === 'custom') {
    const from = q.from ?? q.to;
    const to = q.to ?? q.from;
    if (!from || !to) throw new LedgerHttpError(400, 'الفترة المخصصة تحتاج تاريخي البداية والنهاية', { reason: 'RANGE_REQUIRED' });
    if (to < from) throw new LedgerHttpError(400, 'تاريخ النهاية يسبق تاريخ البداية', { reason: 'INVALID_RANGE', from, to });
    return { mode, from, to };
  }
  const anchor = q.from ?? q.to ?? today;
  return { mode, from: anchor, to: anchor };
}

/** هل أُجبر وضع التاريخ على «اعتباراً من» (الميزانية وحدها، §7.4)؟ صرفة — لتنبيه لا صمت. */
export function dateModeCoerced(key: ReportKey, q: ReportQueryInput): boolean {
  return key === 'balance-sheet' && q.mode !== undefined && q.mode !== 'asOf';
}

export interface ParsedReportRequest {
  options: ReportOptions;
  /** فلتر الحسابات (دفتر الأستاذ والتعمّق) */
  accounts: string[];
  /** فلتر الشركاء: عميل أو مورّد (§7.5) */
  partners: string[];
  /** RPT‑14 «إظهار الصفري» في قائمة الدخل (§7.3) */
  showZero: boolean;
  /** §7.4: أُجبر وضع التاريخ على «اعتباراً من» للميزانية */
  dateModeCoerced: boolean;
  page: number;
  /** `null` في التصدير: بلا ترقيم (§7.1 RPT‑01) */
  pageSize: number | null;
  /** مؤشّر الصفحة التالية لحساب واحد في دفتر الأستاذ (§7.1)، و`null` عند الفتح */
  cursor: string | null;
}

/** يحوّل مخرَج zod إلى خيارات §7.1 الموحّدة. صرفة. */
export function parseReportRequest(
  key: ReportKey,
  q: ReportQueryInput,
  today: LocalDate,
  forExport = false,
): ParsedReportRequest {
  const dateFilter = resolveDateFilter(key, q, today);
  const comparisonKind = q.comparison;
  const options = normalizeReportOptions({
    dateFilter,
    comparison: comparisonKind ? { kind: comparisonKind, count: asInt(q.comparisonCount) ?? 1 } : null,
    postedOnly: asBool(q.postedOnly),
    includeDrafts: asBool(q.includeDrafts),
    unit: asInt(q.unit) as ReportOptions['unit'] | undefined,
    hierarchy: asBool(q.hierarchy),
    hideZero: asBool(q.hideZero),
    journals: asIds(q.journals),
    analytic: asIds(q.analytic),
    salesReps: asIds(q.salesReps),
    search: q.search,
    breakdown: q.breakdown,
  });
  return {
    options,
    accounts: asIds(q.accounts),
    partners: asIds(q.partners),
    showZero: asBool(q.showZero) === true,
    dateModeCoerced: dateModeCoerced(key, q),
    page: normalizePage(asInt(q.page)),
    pageSize: forExport ? null : normalizePageSize(asInt(q.pageSize) ?? GENERAL_LEDGER_PAGE_SIZE),
    // التصدير بلا ترقيم أصلاً (RPT‑01) فلا مؤشّر له
    cursor: forExport ? null : (typeof q.cursor === 'string' && q.cursor.trim() !== '' ? q.cursor.trim() : null),
  };
}

/** بصمة الخيارات في صفّ التدقيق (sha256 مختصرة، كما في تصدير القوائم §8.3). */
export function reportOptionsHash(key: string, req: ParsedReportRequest): string {
  const payload = {
    key,
    ...req.options,
    accounts: req.accounts,
    partners: req.partners,
    showZero: req.showZero,
  };
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

// ═══ جسر القوائم الثلاث (§7.2، §7.3، §7.4) ═══

/** عمود أرصدة لفترة: الأساسية ثم أعمدة المقارنة (RPT‑04). */
export interface StatementPeriodBalances {
  period: ReportPeriod;
  balances: readonly AccountBalance[];
}

/**
 * مدخل موحّد لبناء أي من القوائم الثلاث من الأرصدة المُجمّعة.
 * `buildTrialBalance` تستوفيه بنيوياً، وقائمة الدخل والميزانية تُغلّفان بمحوّلين رقيقين أدناه.
 */
export interface StatementInput {
  reportKey: StatementKey;
  period: ReportPeriod;
  /** حسابات الشركة كاملةً */
  accounts: readonly ReportAccount[];
  /** مخرَج `composeBalances` للفترة الأساسية */
  balances: readonly AccountBalance[];
  settings: ReportSettings;
  options: ReportOptions;
  /** أدوار الحسابات: المسحوبات والأرباح المبقاة (§7.3 PL‑02، §7.4) */
  roles: ReportAccountRoles;
  /** RPT‑14 «إظهار الصفري»: حسابات قائمة الدخل بلا حركة تظهر (§7.3) */
  showZero: boolean;
  /** عدد قيود المسودة المقروءة (RPT‑08) — يُعاد كما هو */
  draftMoveCount: number;
  /** أعمدة المقارنة، الأقرب أولاً (فارغة بلا مقارنة، RPT‑04) */
  comparisons: readonly StatementPeriodBalances[];
}

/**
 * مخرَج موحّد: `rows` و`totals` في جسم الردّ، و`lineCount` سقفُ التصدير، وكل حقل آخر يُنشر
 * في الردّ بجوارهما (ولا يزيح مفتاحاً من العقد الموحّد، انظر `responseBody`).
 */
export interface StatementResult {
  rows: unknown[];
  totals: unknown;
  lineCount?: number;
  [extra: string]: unknown;
}

export type StatementBuilder = (input: StatementInput) => StatementResult;

/** الحقول التي تُنشر في الردّ (كل شيء عدا الثلاثة المعروفة). صرفة. */
export function statementExtras(result: StatementResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'rows' || k === 'totals' || k === 'lineCount') continue;
    out[k] = v;
  }
  return out;
}

/**
 * أدوار الحسابات (المسحوبات `DRAWINGS` والأرباح المبقاة `RETAINED_EARNINGS`) من مفاتيح الربط
 * والوسوم — قراءة رقيقة، والمنطق كلّه في `reportAccountRoles` الصرفة (§7.3 PL‑02، §7.4).
 */
export async function loadReportAccountRoles(
  tx: ReportDb,
  tenantId: string,
  accounts: readonly ReportAccount[],
): Promise<ReportAccountRoles> {
  const [mappings, tagLinks] = await Promise.all([
    tx.glAccountMapping.findMany({
      where: { tenantId, key: { in: [DRAWINGS_KEY, RETAINED_EARNINGS_KEY] } },
      select: { key: true, accountId: true },
    }),
    tx.glAccountTagLink.findMany({
      where: { tenantId, tag: { name: DRAWINGS_KEY } },
      select: { accountId: true, tag: { select: { name: true } } },
    }),
  ]);
  return reportAccountRoles({
    accounts,
    mappings,
    tagLinks: tagLinks.map((t) => ({ tag: t.tag.name, accountId: t.accountId })),
  });
}

/** عدد أسطر قائمة الدخل في الملف: السطر الرئيسي وسطوره الفرعية وصفوف حساباته (RPT‑01). صرفة. */
export function incomeStatementLineCount(statement: IncomeStatement): number {
  let n = 0;
  for (const line of statement.lines) {
    n += 1 + line.accounts.length;
    for (const g of line.groups) n += 1 + g.accounts.length;
  }
  return n;
}

/** عدد أسطر الميزانية في الملف: كل عقدة مسطّحة وصفوف حساباتها (RPT‑01). صرفة. */
export function balanceSheetLineCount(sheet: BalanceSheet): number {
  let n = 0;
  for (const { node } of flattenBalanceSheet(sheet)) n += 1 + node.accounts.length;
  return n;
}

/**
 * عمود مقارنة في الردّ: قائمةٌ كاملة بلا اسمها الداخلي. مفتاح التقرير واحد في العقد الموحّد
 * (`reportKey` أعلى الردّ)، فلا يحمل عمودٌ اسماً ثانياً للتقرير نفسه (`profit-and-loss`). صرفة.
 */
export function comparisonColumn<T extends { reportKey: string }>(statement: T): Omit<T, 'reportKey'> {
  const { reportKey: _internalName, ...rest } = statement;
  return rest;
}

/** ميزان المراجعة: مقارنته داخل خلايا كل صف (`cells[0]` = الفترة الأساسية). */
export const trialBalanceAdapter: StatementBuilder = (input) => {
  const report = buildTrialBalance(input);
  const { rows, totals, lineCount, ...rest } = serializeTrialBalance(report, {
    currencyDecimals: input.settings.currencyDecimals,
    currency: input.settings.currency,
  });
  return { rows, totals, lineCount, ...rest };
};

/**
 * قائمة الدخل: أعمدة المقارنة قوائمُ كاملة مستقلة في `comparisonColumns` بترتيب
 * `comparison.periods` (لا خلايا داخل الصف كما في الميزان).
 */
export const incomeStatementAdapter: StatementBuilder = (input) => {
  const make = (period: ReportPeriod, balances: readonly AccountBalance[]): IncomeStatement => buildIncomeStatement({
    period,
    accounts: input.accounts,
    balances,
    roles: input.roles,
    settings: {
      drawingsAfterNetProfit: input.settings.drawingsAfterNetProfit,
      depreciationInOperatingExpenses: input.settings.depreciationInOperatingExpenses,
    },
    showAccountsWithoutMovement: input.showZero,
    hideZero: input.options.hideZero,
    search: input.options.search,
    unit: input.options.unit,
    hierarchy: input.options.hierarchy,
  });
  const statement = make(input.period, input.balances);
  return {
    rows: statement.lines,
    totals: {
      netProfitMilli: statement.netProfitMilli,
      drawingsMilli: statement.drawingsMilli,
      netProfitAfterDrawingsMilli: statement.netProfitAfterDrawingsMilli,
    },
    lineCount: incomeStatementLineCount(statement),
    statementOptions: statement.options,
    comparisonColumns: input.comparisons.map((c) => comparisonColumn(make(c.period, c.balances))),
  };
};

/** الميزانية «اعتباراً من» D، وأعمدة المقارنة ميزانياتٌ كاملة بتواريخ سابقة (§7.4). */
export const balanceSheetAdapter: StatementBuilder = (input) => {
  const make = (period: ReportPeriod, balances: readonly AccountBalance[]): BalanceSheet => buildBalanceSheet({
    period,
    accounts: input.accounts,
    balances,
    roles: input.roles,
    settings: { drawingsAfterNetProfit: input.settings.drawingsAfterNetProfit },
    hideZero: input.options.hideZero,
    search: input.options.search,
    unit: input.options.unit,
    hierarchy: input.options.hierarchy,
  });
  const sheet = make(input.period, input.balances);
  return {
    rows: sheet.sections,
    totals: {
      totalAssetsMilli: sheet.totalAssetsMilli,
      totalLiabilitiesMilli: sheet.totalLiabilitiesMilli,
      totalEquityMilli: sheet.totalEquityMilli,
      currentYearEarningsMilli: sheet.currentYearEarningsMilli,
      previousYearsEarningsMilli: sheet.previousYearsEarningsMilli,
      imbalanceMilli: sheet.imbalanceMilli,
      equityInvariantMilli: sheet.equityInvariantMilli,
      balanced: sheet.balanced,
      totalLine: sheet.totalLine,
    },
    lineCount: balanceSheetLineCount(sheet),
    asOf: sheet.asOf,
    statementOptions: sheet.options,
    comparisonColumns: input.comparisons.map((c) => comparisonColumn(make(c.period, c.balances))),
  };
};

/**
 * ORPT‑09 «الملخّص التنفيذي» (§7.3): اثنتا عشرة بطاقة — الإيراد وإجمالي الربح وهامشه وصافي الربح
 * وهامشه والنقد والذمم والموردون وDSO وDPO والنسبة الجارية وصافي حركة النقد. وضع مجمّع بلا مسح بنود،
 * وعدد أسطره ثابت فلا يقترب من سقفَي التصدير.
 */
export const executiveSummaryAdapter: StatementBuilder = (input) => {
  const summary = buildExecutiveSummary({
    period: input.period,
    accounts: input.accounts,
    balances: input.balances,
    roles: input.roles,
    settings: {
      drawingsAfterNetProfit: input.settings.drawingsAfterNetProfit,
      depreciationInOperatingExpenses: input.settings.depreciationInOperatingExpenses,
    },
    comparisons: input.comparisons,
    unit: input.options.unit,
  });
  return {
    rows: summary.cards,
    totals: summary.current,
    lineCount: executiveSummaryLineCount(summary),
    statementKey: summary.reportKey,
    statementOptions: summary.options,
    days: summary.days,
    comparisonColumns: summary.comparison,
  };
};

export const STATEMENT_BUILDERS: Readonly<Record<StatementKey, StatementBuilder>> = {
  'trial-balance': trialBalanceAdapter,
  'income-statement': incomeStatementAdapter,
  'balance-sheet': balanceSheetAdapter,
  'executive-summary': executiveSummaryAdapter,
};

/**
 * أعمدة المقارنة (RPT‑04). الميزانية «اعتباراً من» تاريخ، فكل عمود مقارنة يُعاد حلّه
 * إلى [FYStart(D'), D'] كما تشترط `buildBalanceSheet` (§7.4).
 */
export function statementComparisonPeriods(
  key: StatementKey,
  period: ReportPeriod,
  options: ReportOptions,
  fy: FiscalYearConfig,
): ReportPeriod[] {
  const periods = comparisonPeriods(period, options.comparison, fy);
  if (key !== 'balance-sheet') return periods;
  return periods.map((p) => resolveReportPeriod({ mode: 'asOf', from: p.to, to: p.to }, fy));
}

// ═══ الطبقة الرقيقة: سطور دفتر الأستاذ التفصيلية (§7.5) ═══

export interface LedgerLineFilters {
  accountIds?: readonly string[];
  journals?: readonly string[];
  analytic?: readonly string[];
  salesReps?: readonly string[];
  partners?: readonly string[];
  includeDrafts?: boolean;
}

/** `taxRole='MARKER'` مستبعدة كما تستبعدها `gl_period_balances` (I1، §5.9 C2) فيطابق الأستاذ الميزان. */
const NOT_MARKER: Prisma.GlMoveLineWhereInput = { OR: [{ taxRole: null }, { taxRole: { not: 'MARKER' } }] };

const inOf = (ids: readonly string[] | undefined) => (ids && ids.length > 0 ? { in: [...ids] } : undefined);

/** شرط قراءة سطور المدى (صرف، يُختبر بلا قاعدة). */
export function ledgerLineWhere(
  tenantId: string,
  period: ReportPeriod,
  f: LedgerLineFilters = {},
): Prisma.GlMoveLineWhereInput {
  const where: Prisma.GlMoveLineWhereInput = {
    tenantId,
    date: { gte: toDbDate(period.from), lte: toDbDate(period.to) },
    ...NOT_MARKER,
  };
  if (f.includeDrafts !== true) where.posted = true;
  const acc = inOf(f.accountIds);
  if (acc) where.accountId = acc;
  const j = inOf(f.journals);
  if (j) where.journalId = j;
  const a = inOf(f.analytic);
  if (a) where.analyticAccountId = a;
  const s = inOf(f.salesReps);
  if (s) where.salesRepId = s;
  const p = inOf(f.partners);
  if (p) where.AND = [{ OR: [{ customerId: p }, { vendorId: p }] }];
  return where;
}

const LEDGER_LINE_SELECT = {
  id: true, moveId: true, accountId: true, journalId: true, date: true, seq: true, label: true,
  debitMilli: true, creditMilli: true, customerId: true, vendorId: true, salesRepId: true,
  partnerName: true, analyticAccountId: true,
  // لا علاقة `journal` على السطر (‏`journalId` منسوخ للفهارس)، فاسم الدفتر من قيده كما في قائمة البنود
  move: {
    select: {
      number: true, state: true, moveType: true, originalDate: true, lateArrival: true,
      journal: { select: { code: true, name: true } },
    },
  },
} as const;

type RawLedgerLine = Prisma.GlMoveLineGetPayload<{ select: typeof LEDGER_LINE_SELECT }>;

function toLedgerLine(r: RawLedgerLine, repNames: ReadonlyMap<string, string>): LedgerLineInput {
  return {
    id: r.id,
    moveId: r.moveId,
    accountId: r.accountId,
    date: fromDbDate(r.date),
    originalDate: r.move.originalDate ? fromDbDate(r.move.originalDate) : null,
    lateArrival: r.move.lateArrival,
    seq: r.seq,
    moveNumber: r.move.number,
    moveState: r.move.state,
    moveType: r.move.moveType,
    journalId: r.journalId,
    journalCode: r.move.journal.code,
    journalName: r.move.journal.name,
    partnerId: r.customerId ?? r.vendorId ?? null,
    partnerName: r.partnerName,
    salesRepId: r.salesRepId,
    salesRepName: r.salesRepId ? repNames.get(r.salesRepId) ?? null : null,
    analyticAccountId: r.analyticAccountId,
    label: r.label,
    debitMilli: r.debitMilli,
    creditMilli: r.creditMilli,
  };
}

/** أسماء المناديب دفعةً واحدة (لا علاقة `salesRepId` في النموذج) ثم تحويل الصفوف الخام. */
async function attachRepNames(tx: ReportDb, tenantId: string, rows: readonly RawLedgerLine[]): Promise<LedgerLineInput[]> {
  const repIds = [...new Set(rows.map((r) => r.salesRepId).filter((x): x is string => !!x))];
  const repNames = new Map<string, string>();
  if (repIds.length > 0) {
    const reps = await tx.salesRep.findMany({ where: { tenantId, id: { in: repIds } }, select: { id: true, name: true } });
    for (const r of reps) repNames.set(r.id, r.name);
  }
  return rows.map((r) => toLedgerLine(r, repNames));
}

/** عدد سطور المدى قبل قراءتها — سقفا التصدير يُفحصان عليه بلا تحميل النتيجة كاملة. */
export async function countLedgerLines(
  tx: ReportDb,
  tenantId: string,
  period: ReportPeriod,
  f: LedgerLineFilters = {},
): Promise<number> {
  return tx.glMoveLine.count({ where: ledgerLineWhere(tenantId, period, f) });
}

// ═══ ترتيب القراءة ومؤشّر keyset (§7.1 «الأداء») ═══

/**
 * ترتيب القراءة **هو نفسه** ترتيب العرض الحتمي في `compareLedgerLines`: التاريخ، ثم رقم القيد
 * (والمسودة بلا رقم آخراً)، ثم القيد، ثم تسلسل السطر، ثم المعرّف.
 *
 * تساويهما شرطُ صحّة الترقيم: صفحة العرض شريحةٌ من الترتيب الذي يبنيه التصدير نفسه، فلا يختلف
 * «الرصيد الجاري» ولا «رصيد مُرحَّل» بين الشاشة والملف ولا بين صفحة وأخرى.
 */
export const LEDGER_LINE_ORDER_BY: Prisma.GlMoveLineOrderByWithRelationInput[] = [
  { date: 'asc' },
  { move: { number: { sort: 'asc', nulls: 'last' } } },
  { moveId: 'asc' },
  { seq: 'asc' },
  { id: 'asc' },
];

/** موضع سطر في الترتيب أعلاه — مفتاح المؤشّر (keyset) لا إزاحة (offset). */
export interface LedgerLineKey {
  date: LocalDate;
  moveNumber: string | null;
  moveId: string;
  seq: number;
  id: string;
}

/** موضع سطرٍ مقروء. صرفة. */
export function ledgerLineKeyOf(l: LedgerLineInput): LedgerLineKey {
  return { date: l.date, moveNumber: l.moveNumber, moveId: l.moveId, seq: l.seq, id: l.id };
}

/** شرط «بعد هذا الموضع تماماً» بترتيب `LEDGER_LINE_ORDER_BY` (المسودة بلا رقم بعد المرقَّمة). صرفة. */
export function ledgerLineAfterWhere(k: LedgerLineKey): Prisma.GlMoveLineWhereInput {
  const d = toDbDate(k.date);
  const sameNumber: Prisma.GlMoveLineWhereInput = { date: d, move: { number: k.moveNumber } };
  const sameMove: Prisma.GlMoveLineWhereInput = { date: d, moveId: k.moveId };
  const branches: Prisma.GlMoveLineWhereInput[] = [{ date: { gt: d } }];
  if (k.moveNumber !== null) {
    branches.push({ date: d, move: { number: { gt: k.moveNumber } } });
    // النهاية: كل سطر بلا رقم في اليوم نفسه يأتي بعد كل سطر مرقَّم
    branches.push({ date: d, move: { number: null } });
  }
  branches.push({ ...sameNumber, moveId: { gt: k.moveId } });
  branches.push({ ...sameMove, seq: { gt: k.seq } });
  branches.push({ ...sameMove, seq: k.seq, id: { gt: k.id } });
  return { OR: branches };
}

/** شرط «قبل هذا الموضع تماماً» — صورة `ledgerLineAfterWhere` المطابقة (بلا NOT). صرفة. */
export function ledgerLineBeforeWhere(k: LedgerLineKey): Prisma.GlMoveLineWhereInput {
  const d = toDbDate(k.date);
  const sameNumber: Prisma.GlMoveLineWhereInput = { date: d, move: { number: k.moveNumber } };
  const sameMove: Prisma.GlMoveLineWhereInput = { date: d, moveId: k.moveId };
  const branches: Prisma.GlMoveLineWhereInput[] = [{ date: { lt: d } }];
  branches.push(k.moveNumber === null
    ? { date: d, move: { number: { not: null } } }
    : { date: d, move: { number: { lt: k.moveNumber } } });
  branches.push({ ...sameNumber, moveId: { lt: k.moveId } });
  branches.push({ ...sameMove, seq: { lt: k.seq } });
  branches.push({ ...sameMove, seq: k.seq, id: { lt: k.id } });
  return { OR: branches };
}

/**
 * بصمة نطاق المؤشّر: الشركة والمدى والفلاتر وحجم الصفحة. مؤشّرٌ من تقرير آخر (أو من فترة أخرى)
 * يُرفض صراحةً بـ400 بدل أن يخلط سطور تقريرين بصمت. صرفة.
 */
export function ledgerCursorScope(
  tenantId: string,
  period: ReportPeriod,
  f: LedgerLineFilters,
  pageSize: number,
): string {
  const payload = {
    tenantId,
    from: period.from,
    to: period.to,
    pageSize,
    accountIds: [...(f.accountIds ?? [])],
    journals: [...(f.journals ?? [])],
    analytic: [...(f.analytic ?? [])],
    salesReps: [...(f.salesReps ?? [])],
    partners: [...(f.partners ?? [])],
    includeDrafts: f.includeDrafts === true,
  };
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

/** مؤشّر صفحة حسابٍ واحد: نطاقه وحسابه وموضع آخر سطر عُرض. */
export interface LedgerCursor extends LedgerLineKey {
  scope: string;
  accountId: string;
}

/** ترميز المؤشّر نصّاً واحداً يعود في `nextCursor` ويعود كما هو في `cursor`. صرفة. */
export function encodeLedgerCursor(c: LedgerCursor): string {
  const tuple = [c.scope, c.accountId, c.date, c.moveNumber, c.moveId, c.seq, c.id];
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

/**
 * فكّ المؤشّر والتحقّق من نطاقه. أي تشويه أو نطاقٍ مختلف ⇒ 400 برسالة عربية تطلب إعادة الفتح
 * (لا 500 ولا صفحةٌ من تقرير آخر). صرفة.
 */
export function decodeLedgerCursor(raw: string, scope: string): LedgerCursor {
  const reject = (): never => {
    throw new LedgerHttpError(
      400,
      'مؤشّر الصفحة لا يطابق هذا التقرير: أعد فتح دفتر الأستاذ ثم حمّل التالي',
      { reason: 'INVALID_CURSOR' },
    );
  };
  let tuple: unknown;
  try {
    tuple = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return reject();
  }
  if (!Array.isArray(tuple) || tuple.length !== 7) return reject();
  const [s, accountId, date, moveNumber, moveId, seq, id] = tuple as unknown[];
  if (typeof s !== 'string' || s !== scope) return reject();
  if (typeof accountId !== 'string' || accountId === '') return reject();
  if (typeof date !== 'string' || !isLocalDate(date)) return reject();
  if (moveNumber !== null && typeof moveNumber !== 'string') return reject();
  if (typeof moveId !== 'string' || moveId === '') return reject();
  if (typeof seq !== 'number' || !Number.isInteger(seq)) return reject();
  if (typeof id !== 'string' || id === '') return reject();
  return { scope: s, accountId, date, moveNumber, moveId, seq, id };
}

// ═══ قراءة كسولة: تجميعٌ في القاعدة ثم صفحةٌ واحدة لكل حساب ═══

/**
 * إجمالي سطور مدى (لحساب واحد)، **مفصولاً** بنود قيد إقفال السنة عن غيرها.
 * الفصل ضروري لأنّ §7.2 تعامل النوعين معاملتين مختلفتين، والقاعدةُ نفسها تبقى في
 * `reports/generalLedger.ts` الصرفة: هنا عدٌّ ومجاميع خام لا أكثر.
 */
export interface LedgerLineAggregate {
  count: number;
  debitMilli: Milli;
  creditMilli: Milli;
  closingCount: number;
  closingDebitMilli: Milli;
  closingCreditMilli: Milli;
}

export const emptyLedgerAggregate = (): LedgerLineAggregate => ({
  count: 0, debitMilli: 0n, creditMilli: 0n, closingCount: 0, closingDebitMilli: 0n, closingCreditMilli: 0n,
});

/** عدد سطور الحساب كلها في المدى (المحتسَبة وبنود الإقفال معاً). صرفة. */
export const aggregateLineCount = (a: LedgerLineAggregate | undefined): number =>
  a ? a.count + a.closingCount : 0;

const CLOSING_ONLY: Prisma.GlMoveLineWhereInput = { move: { moveType: 'FY_CLOSING' } };
const NOT_CLOSING: Prisma.GlMoveLineWhereInput = { move: { moveType: { not: 'FY_CLOSING' } } };

/**
 * إجماليات كل حساب في المدى باستعلامَي تجميع (‏`groupBy`) لا بتحميل سطر واحد.
 * هي ما يجعل التحميل الكسول ممكناً: أعمدة «مدين/دائن/الإجمالي/عدد السطور» تبقى على **كل**
 * سطور الفترة بينما لا يُقرأ من السطور إلا صفحةٌ واحدة لكل حساب (§7.1 «الأداء»).
 */
export async function loadLedgerAccountAggregates(
  tx: ReportDb,
  tenantId: string,
  period: ReportPeriod,
  f: LedgerLineFilters = {},
): Promise<Map<string, LedgerLineAggregate>> {
  const base = ledgerLineWhere(tenantId, period, f);
  const group = (extra: Prisma.GlMoveLineWhereInput) => tx.glMoveLine.groupBy({
    by: ['accountId'],
    where: { AND: [base, extra] },
    _count: { _all: true },
    _sum: { debitMilli: true, creditMilli: true },
    orderBy: { accountId: 'asc' },
  });
  const [plain, closing] = await Promise.all([group(NOT_CLOSING), group(CLOSING_ONLY)]);
  const out = new Map<string, LedgerLineAggregate>();
  const slot = (accountId: string): LedgerLineAggregate => {
    let v = out.get(accountId);
    if (!v) { v = emptyLedgerAggregate(); out.set(accountId, v); }
    return v;
  };
  for (const r of plain) {
    const v = slot(r.accountId);
    v.count = r._count._all;
    v.debitMilli = r._sum.debitMilli ?? 0n;
    v.creditMilli = r._sum.creditMilli ?? 0n;
  }
  for (const r of closing) {
    const v = slot(r.accountId);
    v.closingCount = r._count._all;
    v.closingDebitMilli = r._sum.debitMilli ?? 0n;
    v.closingCreditMilli = r._sum.creditMilli ?? 0n;
  }
  return out;
}

/**
 * ما قبل أول سطر في الصفحة لحسابٍ واحد: عددُه ومجاميعه (مفصولةً بالإقفال) — تجميعٌ في القاعدة
 * لا قراءة سطور. منه يُشتقّ «رصيد مُرحَّل» ورقمُ الصفحة، فيبقيان صحيحين في أي صفحة.
 */
export async function aggregateLedgerLinesBefore(
  tx: ReportDb,
  tenantId: string,
  period: ReportPeriod,
  f: LedgerLineFilters,
  accountId: string,
  key: LedgerLineKey,
): Promise<LedgerLineAggregate> {
  const base: Prisma.GlMoveLineWhereInput = {
    AND: [ledgerLineWhere(tenantId, period, f), { accountId }, ledgerLineBeforeWhere(key)],
  };
  const agg = (extra: Prisma.GlMoveLineWhereInput) => tx.glMoveLine.aggregate({
    where: { AND: [base, extra] },
    _count: { _all: true },
    _sum: { debitMilli: true, creditMilli: true },
  });
  const [plain, closing] = await Promise.all([agg(NOT_CLOSING), agg(CLOSING_ONLY)]);
  return {
    count: plain._count._all,
    debitMilli: plain._sum.debitMilli ?? 0n,
    creditMilli: plain._sum.creditMilli ?? 0n,
    closingCount: closing._count._all,
    closingDebitMilli: closing._sum.debitMilli ?? 0n,
    closingCreditMilli: closing._sum.creditMilli ?? 0n,
  };
}

/** صفحة سطورٍ واحدة لحساب واحد (500 افتراضاً) — بمؤشّر keyset لا بإزاحة. */
export async function loadLedgerLinePage(
  tx: ReportDb,
  tenantId: string,
  period: ReportPeriod,
  f: LedgerLineFilters,
  accountId: string,
  after: LedgerLineKey | null,
  take: number,
): Promise<RawLedgerLine[]> {
  return tx.glMoveLine.findMany({
    where: {
      AND: [ledgerLineWhere(tenantId, period, f), { accountId }, ...(after ? [ledgerLineAfterWhere(after)] : [])],
    },
    select: LEDGER_LINE_SELECT,
    orderBy: LEDGER_LINE_ORDER_BY,
    take,
  });
}

/**
 * سطور دفتر الأستاذ للمدى **كاملةً** — للتصدير وحده (§7.1 RPT‑01: بلا ترقيم ولا تحميل كسول).
 * بدفعات مؤشّر (keyset) على `[accountId, date, id]` (الفهرس `[tenantId, accountId, date]`)
 * فلا تُطلب من قاعدة 256MB نتيجة واحدة ضخمة، وسقف الصيغة مفحوصٌ بعدٍّ **قبل** هذه القراءة.
 */
export async function loadLedgerLines(
  tx: ReportDb,
  tenantId: string,
  period: ReportPeriod,
  f: LedgerLineFilters = {},
  batchSize = LEDGER_LINES_BATCH,
): Promise<LedgerLineInput[]> {
  const where = ledgerLineWhere(tenantId, period, f);
  const batch = Math.max(100, Math.min(batchSize, 20_000));
  const order: Prisma.GlMoveLineOrderByWithRelationInput[] = [{ accountId: 'asc' }, { date: 'asc' }, { id: 'asc' }];
  const rows: RawLedgerLine[] = [];
  let last: { accountId: string; date: Date; id: string } | null = null;
  for (;;) {
    const page: RawLedgerLine[] = await tx.glMoveLine.findMany({
      where: last
        ? {
          AND: [where, {
            OR: [
              { accountId: { gt: last.accountId } },
              { accountId: last.accountId, date: { gt: last.date } },
              { accountId: last.accountId, date: last.date, id: { gt: last.id } },
            ],
          }],
        }
        : where,
      select: LEDGER_LINE_SELECT,
      orderBy: order,
      take: batch,
    });
    rows.push(...page);
    if (rows.length > LEDGER_LINES_MAX) {
      throw new LedgerError('LEDGER_RANGE_TOO_LARGE', {
        from: period.from, to: period.to, cap: LEDGER_LINES_MAX, reason: 'TOO_MANY_LINES',
      });
    }
    if (page.length < batch) break;
    const tail = page[page.length - 1];
    last = { accountId: tail.accountId, date: tail.date, id: tail.id };
  }
  return attachRepNames(tx, tenantId, rows);
}

// ═══ تركيب صفحة دفتر الأستاذ (ترقيمٌ لا محاسبة) ═══

/**
 * سطران صناعيان يلخّصان حركة حساب: واحدٌ للسطور العادية وآخر لبنود قيد الإقفال.
 *
 * يُمرَّران إلى `buildGeneralLedger` **الصرفة** فتطبّق عليهما قاعدة §7.2 نفسها التي تطبّقها على
 * السطور الحقيقية (فصل بنود الإقفال عن حسابات قائمة الدخل وإبقاؤها في حسابات الميزانية)، فتخرج
 * أرقام القسم — الافتتاحي ومدين ودائن وصفّ الإقفال والإجمالي — صحيحةً **بلا تحميل سطر واحد**،
 * ولا تُعاد كتابة قاعدة محاسبية واحدة في طبقة المسار. هذه السطور لا تُعاد في الردّ أبداً:
 * الردّ يحمل سطور الصفحة الحقيقية وحدها.
 */
export function aggregateLedgerLines(
  accountId: string,
  date: LocalDate,
  agg: LedgerLineAggregate,
): LedgerLineInput[] {
  const make = (suffix: string, moveType: string, debitMilli: Milli, creditMilli: Milli): LedgerLineInput => ({
    id: `aggregate:${accountId}:${suffix}`,
    moveId: `aggregate:${accountId}:${suffix}`,
    accountId,
    date,
    originalDate: null,
    lateArrival: false,
    seq: 0,
    moveNumber: null,
    moveState: 'POSTED',
    moveType,
    journalId: '',
    journalCode: null,
    journalName: null,
    partnerId: null,
    partnerName: null,
    salesRepId: null,
    salesRepName: null,
    analyticAccountId: null,
    label: null,
    debitMilli,
    creditMilli,
  });
  const out: LedgerLineInput[] = [];
  if (agg.count > 0) out.push(make('lines', 'ENTRY', agg.debitMilli, agg.creditMilli));
  if (agg.closingCount > 0) out.push(make('closing', 'FY_CLOSING', agg.closingDebitMilli, agg.closingCreditMilli));
  return out;
}

/** قسم حساب في العرض: شكل `buildGeneralLedger` نفسه، ومعه مؤشّر الصفحة التالية. */
export interface LedgerPageSection extends GeneralLedgerSection {
  /** مؤشّر keyset يحمّل الصفحة التالية لهذا الحساب، و`null` حين لا تالي */
  nextCursor: string | null;
}

export interface LedgerPageResult extends GeneralLedgerResult {
  sections: LedgerPageSection[];
  pageSize: number;
}

/**
 * «هيكل» التقرير: أقسامٌ بأرقام الفترة كلها من الإجماليات، بلا أي سطر محمَّل.
 * الحسابات الظاهرة (RPT‑07 «إخفاء الصفري» وRPT‑15 البحث) تحسمها الدالّة الصرفة نفسها،
 * فلا تُقرأ صفحةُ حسابٍ مخفيّ أصلاً.
 */
export function buildLedgerSkeleton(input: {
  period: ReportPeriod;
  accounts: readonly ReportAccount[];
  balances: readonly AccountBalance[];
  aggregates: ReadonlyMap<string, LedgerLineAggregate>;
  hideZero?: boolean;
  search?: string;
  partners?: readonly string[];
  /** 'partners' متى مُرّر الشريك إلى طبقة القراءة فصار الافتتاح مفلتراً مثله */
  openingScope?: 'account' | 'partners';
}): GeneralLedgerResult {
  const lines: LedgerLineInput[] = [];
  for (const account of input.accounts) {
    const agg = input.aggregates.get(account.id);
    if (agg) lines.push(...aggregateLedgerLines(account.id, input.period.from, agg));
  }
  return buildGeneralLedger({
    period: input.period,
    accounts: input.accounts,
    balances: input.balances,
    lines,
    options: {
      pageSize: null,
      page: 1,
      hideZero: input.hideZero,
      search: input.search,
      partners: input.partners,
      // مفلترٌ بالشريك متى مُرّر إلى طبقة القراءة، وإلا فالحساب كلّه ويعلنه المحرّك بتنبيه
      openingScope: input.openingScope ?? 'account',
    },
  });
}

/**
 * «رصيد مُرحَّل» لصفحةٍ غير الأولى: الرصيد الجاري بعد كل ما قبلها. يُحسب بتمرير إجماليات
 * ما قبل الصفحة إلى `buildGeneralLedger` الصرفة، فتطبّق قاعدة §7.2 (بنود الإقفال المفصولة لا
 * تحرّك الرصيد الجاري في حسابات قائمة الدخل) بلا تكرارها هنا.
 */
export function carriedForwardAfter(
  period: ReportPeriod,
  account: ReportAccount,
  balances: readonly AccountBalance[],
  before: LedgerLineAggregate,
): Milli {
  const one = buildGeneralLedger({
    period,
    accounts: [account],
    balances,
    lines: aggregateLedgerLines(account.id, period.from, before),
    options: { pageSize: null, page: 1 },
  });
  return one.sections[0]?.carriedOutMilli ?? 0n;
}

/** موضع صفحة حساب: كم سطراً قبلها، وبأي رصيد مُرحَّل تبدأ. */
export interface LedgerPagePosition {
  offset: number;
  carriedForwardMilli: Milli;
  lines: readonly LedgerLineInput[];
}

/**
 * يدمج الهيكل (أرقام الفترة) بالصفحات المقروءة (السطور والرصيد الجاري). **صرف وحتمي**، ولا
 * يحسب مبلغاً: كل مبلغ يأتي من `buildGeneralLedger`، وما هنا عددٌ وموضعٌ ومؤشّر.
 */
export function mergeLedgerPages(input: {
  skeleton: GeneralLedgerResult;
  /** الأقسام المُعادة في هذا الردّ (كلها عند الفتح، وحسابُ المؤشّر وحده عند التحميل) */
  sectionIds: readonly string[];
  /** مخرَج `buildGeneralLedger` على سطور الصفحات ببذور «رصيد مُرحَّل» */
  paged: GeneralLedgerResult;
  positions: ReadonlyMap<string, LedgerPagePosition>;
  aggregates: ReadonlyMap<string, LedgerLineAggregate>;
  pageSize: number;
  scope: string;
}): LedgerPageResult {
  const { skeleton, sectionIds, paged, positions, aggregates, pageSize, scope } = input;
  const pagedById = new Map(paged.sections.map((s) => [s.account.id, s]));
  const wanted = new Set(sectionIds);

  const sections: LedgerPageSection[] = [];
  let displayedLineCount = 0;
  for (const base of skeleton.sections) {
    const accountId = base.account.id;
    if (!wanted.has(accountId)) continue;
    const position = positions.get(accountId);
    const offset = position?.offset ?? 0;
    const carriedForwardMilli = position?.carriedForwardMilli ?? base.openingMilli;
    const rows = pagedById.get(accountId)?.lines ?? [];
    const lineCount = aggregateLineCount(aggregates.get(accountId));
    const hasMore = offset + rows.length < lineCount;
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    const pageCount = Math.max(1, Math.ceil(lineCount / pageSize));
    sections.push({
      ...base,
      lineCount,
      // مقصوصٌ إلى آخر صفحة كما تقصّه `buildGeneralLedger` (مؤشّرٌ على آخر سطر لا يعطي صفحةً وهمية)
      page: Math.min(Math.floor(offset / pageSize) + 1, pageCount),
      pageSize,
      pageCount,
      offset,
      carriedForwardMilli,
      carriedOutMilli: last ? last.runningMilli : carriedForwardMilli,
      hasMore,
      lines: rows,
      nextCursor: hasMore && last
        ? encodeLedgerCursor({ scope, accountId, ...ledgerLineKeyOf(last) })
        : null,
    });
    displayedLineCount += rows.length;
  }

  // عدد السطور في الإجمالي على **كل** الحسابات الظاهرة لا على المُعاد في هذا الردّ،
  // فلا يتغيّر رقمٌ في التقرير بتحميل صفحةٍ أخرى. المبالغ كلها من الهيكل كما هي.
  let lineCount = 0;
  for (const s of skeleton.sections) lineCount += aggregateLineCount(aggregates.get(s.account.id));

  return {
    ...skeleton,
    sections,
    totals: { ...skeleton.totals, lineCount, displayedLineCount },
    paginated: true,
    pageSize,
    page: sections.length > 0 ? Math.min(...sections.map((s) => s.page)) : 1,
  };
}

// ═══ بناء التقرير ═══

interface BuiltReport {
  reportKey: ReportKey;
  period: ReportPeriod;
  settings: ReportSettings;
  options: ReportOptions;
  mode: 'AGGREGATE' | 'LINE_SCAN';
  rows: unknown[];
  totals: unknown;
  comparison: { kind: string; count: number; periods: ReportPeriod[]; columns?: unknown[] } | null;
  pagination: { page: number; pageSize: number | null; paginated: boolean } | null;
  /** عدد السطور الذي تُقاس عليه سقوف التصدير */
  lineCount: number;
  extra: Record<string, unknown>;
  comparisonIgnored: boolean;
  accountFilterIgnored: boolean;
  /** تنبيهات من المحرّك الصرف (مثل فلتر الشركاء في §7.5) — تُنشر مع تنبيهات RPT‑08 لا تُبتلع */
  engineWarnings: ReportWarning[];
}

/**
 * القوائم الثلاث (§7.2، §7.3، §7.4): الأرصدة من المحرّك المشترك، والهيكل من وحدة كل قائمة.
 *
 * فلتر الحسابات (`accounts=`) خاصّ بدفتر الأستاذ والتعمّق، ولا يُطبّق على القوائم لأنّ مجاميعها
 * تفترض كل الحسابات (وإلا انكسر توازن §7.2 و§7.4)؛ فيُهمَل صراحةً بتنبيه لا بصمت.
 */
async function buildStatement(
  tenantId: string,
  key: StatementKey,
  req: ParsedReportRequest,
  settings: ReportSettings,
  period: ReportPeriod,
): Promise<BuiltReport> {
  const loadOpts = reportLoadOptions(req.options);
  const [accounts, sources] = await Promise.all([
    loadReportAccounts(prisma, tenantId),
    loadBalanceSources(prisma, tenantId, period, loadOpts),
  ]);
  const balances = composeBalancesFromSources(sources, accounts, req.options.includeDrafts);

  // كل عمود مقارنة قراءةٌ مستقلة، والسقف يُفحص لكلّ على حدة داخل `loadBalanceSources` (§7.1)
  const cmpPeriods = statementComparisonPeriods(key, period, req.options, settings.fy);
  const comparisons: StatementPeriodBalances[] = [];
  for (const p of cmpPeriods) {
    const s = await loadBalanceSources(prisma, tenantId, p, loadOpts);
    comparisons.push({ period: p, balances: composeBalancesFromSources(s, accounts, req.options.includeDrafts) });
  }

  // الميزان لا يحتاج الأدوار؛ قائمة الدخل والميزانية تحتاجانها (المسحوبات والأرباح المبقاة)
  const roles = key === 'trial-balance' ? EMPTY_ACCOUNT_ROLES : await loadReportAccountRoles(prisma, tenantId, accounts);

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
  });

  return {
    reportKey: key,
    period,
    settings,
    options: req.options,
    mode: sources.mode,
    rows: result.rows,
    totals: result.totals,
    comparison: req.options.comparison
      ? { kind: req.options.comparison.kind, count: cmpPeriods.length, periods: cmpPeriods }
      : null,
    pagination: null,
    lineCount: typeof result.lineCount === 'number' ? result.lineCount : result.rows.length,
    extra: { ...statementExtras(result), draftMoveCount: sources.draftMoveCount },
    comparisonIgnored: false,
    accountFilterIgnored: req.accounts.length > 0,
    engineWarnings: [],
  };
}

/** فلاتر سطور دفتر الأستاذ من الطلب. صرفة. */
function generalLedgerFilters(req: ParsedReportRequest): LedgerLineFilters {
  const accountIds = req.accounts.length > 0 ? req.accounts : undefined;
  return {
    ...(accountIds ? { accountIds } : {}),
    journals: req.options.journals,
    analytic: req.options.analytic,
    salesReps: req.options.salesReps,
    partners: req.partners,
    includeDrafts: req.options.includeDrafts,
  };
}

function generalLedgerBuilt(
  req: ParsedReportRequest,
  settings: ReportSettings,
  period: ReportPeriod,
  mode: 'AGGREGATE' | 'LINE_SCAN',
  result: GeneralLedgerResult,
  /** سطور الملف لو صُدِّر المدى كاملاً — على **كل** الحسابات لا على المُعاد في هذا الردّ */
  lineCount: number,
  extra: Record<string, unknown>,
): BuiltReport {
  return {
    reportKey: 'general-ledger',
    period,
    settings,
    options: req.options,
    mode,
    rows: result.sections,
    totals: result.totals,
    comparison: null,
    pagination: { page: result.page, pageSize: result.pageSize, paginated: result.paginated },
    lineCount,
    extra: { accountFilter: req.accounts, partnerFilter: req.partners, ...extra },
    comparisonIgnored: req.options.comparison !== null,
    accountFilterIgnored: false,
    engineWarnings: result.warnings.map((w) => ({ code: w.code, message: w.message, details: w.details })),
  };
}

/**
 * التصدير (§7.1 RPT‑01): المجموعة كاملةً بلا ترقيم ولا تحميل كسول، بدفعات مؤشّر.
 * السقف مفحوصٌ بعدٍّ قبل الدخول هنا، فلا تُقرأ نتيجةٌ تُرفض.
 */
async function buildGeneralLedgerExport(
  tenantId: string,
  req: ParsedReportRequest,
  settings: ReportSettings,
  period: ReportPeriod,
): Promise<BuiltReport> {
  assertScanRange(period);
  const filters = generalLedgerFilters(req);
  const accountIds = filters.accountIds;
  // §7.5: فلتر الشركاء يدخل طبقة القراءة أيضاً، وإلا عرض الافتتاحُ رصيدَ الحساب كلّه لعميلٍ واحد.
  // وجوده يفرض مسح البنود (gl_period_balances بلا شريك) فيسري سقف 12 شهراً ووسم «مفلتر، أبطأ».
  const partnerIds = req.partners.length > 0 ? req.partners : undefined;
  const loadOpts = reportLoadOptions(req.options, {
    ...(accountIds ? { accountIds } : {}),
    ...(partnerIds ? { partners: partnerIds } : {}),
  });
  const [accounts, sources, lines] = await Promise.all([
    loadReportAccounts(prisma, tenantId, accountIds ? { accountIds } : {}),
    loadBalanceSources(prisma, tenantId, period, loadOpts),
    loadLedgerLines(prisma, tenantId, period, filters),
  ]);
  const balances = composeBalancesFromSources(sources, accounts, req.options.includeDrafts);
  const result = buildGeneralLedger({
    period,
    accounts,
    balances,
    lines,
    options: {
      pageSize: null,
      page: 1,
      hideZero: req.options.hideZero,
      search: req.options.search,
      partners: req.partners,
      openingScope: partnerIds ? 'partners' : 'account',
    },
  });
  return generalLedgerBuilt(
    req, settings, period, requiresLineScan(req.options) ? 'LINE_SCAN' : sources.mode,
    result, generalLedgerExportLines(result), {},
  );
}

/**
 * العرض (§7.1 «الأداء»، التحميل الكسول): **صفحةٌ واحدة تُقرأ فعلاً** — 500 سطر لكل حساب —
 * والتالية بمؤشّر صريح لحسابٍ واحد. لا تُحمَّل سطور الفترة كلها إلى الذاكرة أبداً:
 *
 * 1. `loadLedgerAccountAggregates` (استعلاما `groupBy`): مدين ودائن وعدد السطور لكل حساب على **كل**
 *    سطور الفترة — فتبقى أرقام الأقسام والإجمالي كما كانت حين كان كل شيء في الذاكرة.
 * 2. الحسابات الظاهرة تُحسم قبل أي قراءة سطور (البحث و«إخفاء الصفري»)، فلا تُقرأ صفحةُ حسابٍ مخفيّ.
 * 3. لكل حساب ظاهر صفحةٌ واحدة بترتيب العرض نفسه؛ ومع المؤشّر يُقرأ حسابُه وحده.
 * 4. «رصيد مُرحَّل» ورقم الصفحة من تجميع ما قبل أول سطر في الصفحة (استعلامٌ واحد، بلا قراءة سطوره).
 */
async function buildGeneralLedgerView(
  tenantId: string,
  req: ParsedReportRequest,
  settings: ReportSettings,
  period: ReportPeriod,
): Promise<BuiltReport> {
  // دفتر الأستاذ يمسّ البنود دائماً ⇒ سقف 12 شهراً كوضع مسح البنود (§7.1)؛ وما فوقه الحزمة النظامية (§9.5 G8).
  assertScanRange(period);
  const pageSize = req.pageSize ?? GENERAL_LEDGER_PAGE_SIZE;
  if (req.cursor === null && req.page > 1) {
    throw new LedgerHttpError(
      400,
      'الصفحة التالية من دفتر الأستاذ تُطلب بمؤشّر الحساب (cursor) الذي يعيده القسم، لا برقم صفحة',
      { reason: 'CURSOR_REQUIRED', page: req.page },
    );
  }
  const filters = generalLedgerFilters(req);
  const accountIds = filters.accountIds;
  // §7.5: فلتر الشركاء يدخل طبقة القراءة أيضاً، وإلا عرض الافتتاحُ رصيدَ الحساب كلّه لعميلٍ واحد.
  // وجوده يفرض مسح البنود (gl_period_balances بلا شريك) فيسري سقف 12 شهراً ووسم «مفلتر، أبطأ».
  const partnerIds = req.partners.length > 0 ? req.partners : undefined;
  const loadOpts = reportLoadOptions(req.options, {
    ...(accountIds ? { accountIds } : {}),
    ...(partnerIds ? { partners: partnerIds } : {}),
  });
  const [accounts, sources, aggregates] = await Promise.all([
    loadReportAccounts(prisma, tenantId, accountIds ? { accountIds } : {}),
    loadBalanceSources(prisma, tenantId, period, loadOpts),
    loadLedgerAccountAggregates(prisma, tenantId, period, filters),
  ]);
  const balances = composeBalancesFromSources(sources, accounts, req.options.includeDrafts);

  // (1) الهيكل: كل أرقام الفترة من الإجماليات، والحسابات الظاهرة تُحسم، بلا سطر واحد محمَّل
  const skeleton = buildLedgerSkeleton({
    period, accounts, balances, aggregates,
    hideZero: req.options.hideZero, search: req.options.search, partners: req.partners,
    openingScope: partnerIds ? 'partners' : 'account',
  });

  const scope = ledgerCursorScope(tenantId, period, filters, pageSize);
  const cursor = req.cursor === null ? null : decodeLedgerCursor(req.cursor, scope);
  const targets = cursor === null
    ? skeleton.sections
    : skeleton.sections.filter((s) => s.account.id === cursor.accountId);
  if (cursor !== null && targets.length === 0) {
    throw new LedgerHttpError(404, 'الحساب المطلوب ليس ضمن هذا التقرير', {
      reason: 'CURSOR_ACCOUNT_NOT_IN_REPORT', accountId: cursor.accountId,
    });
  }

  // (2) صفحةٌ واحدة لكل حساب ظاهر (وحسابُ المؤشّر وحده عند التحميل)، ومعها موضعها
  const positions = new Map<string, LedgerPagePosition>();
  const pageLines: LedgerLineInput[] = [];
  for (const section of targets) {
    const accountId = section.account.id;
    const agg = aggregates.get(accountId);
    const after = cursor !== null && cursor.accountId === accountId ? cursor : null;
    if (aggregateLineCount(agg) === 0) {
      positions.set(accountId, { offset: 0, carriedForwardMilli: section.openingMilli, lines: [] });
      continue;
    }
    const raw = await loadLedgerLinePage(prisma, tenantId, period, filters, accountId, after, pageSize);
    const lines = await attachRepNames(prisma, tenantId, raw);
    if (lines.length === 0) {
      // مؤشّرٌ على آخر سطر: لا تالي — ما قبل الصفحة هو كل سطور الحساب
      positions.set(accountId, {
        offset: aggregateLineCount(agg),
        carriedForwardMilli: carriedForwardAfter(period, section.account, balances, agg ?? emptyLedgerAggregate()),
        lines: [],
      });
      continue;
    }
    const before = after === null
      ? emptyLedgerAggregate()
      : await aggregateLedgerLinesBefore(prisma, tenantId, period, filters, accountId, ledgerLineKeyOf(lines[0]));
    positions.set(accountId, {
      offset: aggregateLineCount(before),
      carriedForwardMilli: after === null
        ? section.openingMilli
        : carriedForwardAfter(period, section.account, balances, before),
      lines,
    });
    pageLines.push(...lines);
  }

  // (3) سطور الصفحات في الدالّة الصرفة نفسها، ببذرةٍ = «رصيد مُرحَّل» لكل حساب،
  //     فتخرج أوسمة السطر (مسودة/إقفال/مفصول/مُزاح) ورصيدُه الجاري من المحرّك لا من هنا
  const seeds: AccountBalance[] = targets.map((s) => ({
    ...zeroBalance(s.account.id),
    openingMilli: positions.get(s.account.id)?.carriedForwardMilli ?? s.openingMilli,
  }));
  const paged = buildGeneralLedger({
    period,
    accounts: targets.map((s) => s.account),
    balances: seeds,
    lines: pageLines,
    options: { pageSize: null, page: 1 },
  });

  const result = mergeLedgerPages({
    skeleton,
    sectionIds: targets.map((s) => s.account.id),
    paged,
    positions,
    aggregates,
    pageSize,
    scope,
  });
  return generalLedgerBuilt(
    req, settings, period, requiresLineScan(req.options) ? 'LINE_SCAN' : sources.mode, result,
    // صفّ افتتاحي وصفّ إجمالي لكل حساب ظاهر مع سطوره — كما يقيسها التصدير (`generalLedgerExportLines`)
    result.totals.lineCount + result.totals.accountCount * 2,
    { cursorAccountId: cursor === null ? null : cursor.accountId },
  );
}

async function buildGeneralLedgerReport(
  tenantId: string,
  req: ParsedReportRequest,
  settings: ReportSettings,
  period: ReportPeriod,
): Promise<BuiltReport> {
  return req.pageSize === null
    ? buildGeneralLedgerExport(tenantId, req, settings, period)
    : buildGeneralLedgerView(tenantId, req, settings, period);
}

async function buildReport(
  tenantId: string,
  key: ReportKey,
  req: ParsedReportRequest,
  settings: ReportSettings,
): Promise<BuiltReport> {
  const period = resolveReportPeriod(req.options.dateFilter, settings.fy);
  return key === 'general-ledger'
    ? buildGeneralLedgerReport(tenantId, req, settings, period)
    : buildStatement(tenantId, key, req, settings, period);
}

/** BigInt ⇒ نص (كل مبالغ الدفاتر ملّي، §2.3) فلا ينهار `res.json`. */
export function reportJson<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

function responseBody(built: BuiltReport, req: ParsedReportRequest, warnings: ReportWarning[]): Record<string, unknown> {
  return {
    // الحقول الثابتة تُكتب بعد الإضافيات فلا يقدر تقريرٌ على إزاحة مفتاح من العقد الموحّد
    ...built.extra,
    reportKey: built.reportKey,
    period: built.period,
    dateFilter: built.options.dateFilter,
    options: {
      ...built.options,
      accounts: req.accounts,
      partners: req.partners,
    },
    settings: {
      currency: built.settings.currency,
      currencyDecimals: built.settings.currencyDecimals,
      timezone: built.settings.timezone,
      fiscalYearEnd: { month: built.settings.fy.endMonth, day: built.settings.fy.endDay },
      drawingsAfterNetProfit: built.settings.drawingsAfterNetProfit,
      depreciationInOperatingExpenses: built.settings.depreciationInOperatingExpenses,
      configured: built.settings.configured,
    },
    mode: built.mode,
    rows: built.rows,
    totals: built.totals,
    comparison: built.comparison,
    pagination: built.pagination,
    lineCount: built.lineCount,
    warnings,
  };
}

/** تنبيهات الردّ: تنبيهات RPT‑08 ثم تنبيهات المحرّك الصرف (§7.5) — لا يُبتلع تنبيهٌ منها. صرفة. */
function reportWarnings(built: BuiltReport, facts: ReportWarningFacts): ReportWarning[] {
  return [...buildReportWarnings(facts), ...built.engineWarnings];
}

function assertKnownKey(raw: string): ReportKey {
  const key = canonicalReportKey(raw);
  if (key) return key;
  const later = (LATER_REPORT_KEYS as readonly string[]).includes(raw);
  throw new LedgerHttpError(404, later ? 'هذا التقرير يُتاح مع مرحلته' : 'تقرير غير معروف', {
    reason: later ? 'REPORT_NOT_AVAILABLE' : 'UNKNOWN_REPORT', reportKey: raw,
  });
}

// ═══ النقاط ═══

router.get('/reports/:key', VIEW, ledgerHandler(async (req, res) => {
  const l = locals(res);
  const key = assertKnownKey(String(req.params.key));
  const q = reportQuerySchema.parse(req.query);
  const settings = await loadReportSettings(prisma, l.tenantId);
  const parsed = parseReportRequest(key, q, todayLocal(new Date(), settings.timezone), false);
  const built = await buildReport(l.tenantId, key, parsed, settings);
  const facts = await countReportWarningFacts(
    prisma, l.tenantId, built.period, settings.timezone,
    {
      filtered: built.mode === 'LINE_SCAN',
      comparisonIgnored: built.comparisonIgnored,
      accountFilterIgnored: built.accountFilterIgnored,
      dateModeCoerced: parsed.dateModeCoerced,
    },
  );
  res.json({ success: true, data: reportJson(responseBody(built, parsed, reportWarnings(built, facts))) });
}));

router.post('/reports/:key/export', VIEW, ledgerExportLimiter, ledgerHandler(async (req, res) => {
  const l = locals(res);
  const key = assertKnownKey(String(req.params.key));
  const body = reportExportSchema.parse(req.body ?? {});
  const format = body.format as ExportFormat;
  const settings = await loadReportSettings(prisma, l.tenantId);
  // `forExport = true` ⇒ pageSize = null: مجموعة البيانات كاملة بلا ترقيم ولا طيّ (§7.1 RPT‑01)
  const parsed = parseReportRequest(key, body, todayLocal(new Date(), settings.timezone), true);

  if (key === 'general-ledger') {
    // السقف قبل القراءة: عدّ السطور أولاً فلا تُطلب نتيجةٌ ضخمة ثم تُرفض
    const period = resolveReportPeriod(parsed.options.dateFilter, settings.fy);
    assertScanRange(period);
    const probe = await countLedgerLines(prisma, l.tenantId, period, {
      ...(parsed.accounts.length > 0 ? { accountIds: parsed.accounts } : {}),
      journals: parsed.options.journals,
      analytic: parsed.options.analytic,
      salesReps: parsed.options.salesReps,
      partners: parsed.partners,
      includeDrafts: parsed.options.includeDrafts,
    });
    assertExportUnderCap(format, probe);
  }

  const built = await buildReport(l.tenantId, key, parsed, settings);
  assertExportUnderCap(format, built.lineCount);

  const facts = await countReportWarningFacts(
    prisma, l.tenantId, built.period, settings.timezone,
    {
      filtered: built.mode === 'LINE_SCAN',
      comparisonIgnored: built.comparisonIgnored,
      accountFilterIgnored: built.accountFilterIgnored,
      dateModeCoerced: parsed.dateModeCoerced,
    },
  );
  const actor = ledgerActor(l, { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });
  await prisma.$transaction((tx) => appendAudit(tx, {
    tenantId: l.tenantId,
    actor,
    action: 'EXPORT',
    entityType: 'REPORT',
    entityId: key,
    summary: `تصدير تقرير ${key} بصيغة ${format} (${built.lineCount} سطر)`,
    after: {
      reportKey: key,
      format,
      from: built.period.from,
      to: built.period.to,
      optionsHash: reportOptionsHash(key, parsed),
      lineCount: built.lineCount,
      impersonated: l.impersonated === true,
    },
  }));

  res.json({
    success: true,
    data: reportJson({
      ...responseBody(built, parsed, reportWarnings(built, facts)),
      format,
      cap: REPORT_EXPORT_CAPS[format],
      paginated: false,
    }),
  });
}));

export default router;
export { GENERAL_LEDGER_MAX_PAGE_SIZE, GENERAL_LEDGER_PAGE_SIZE };
