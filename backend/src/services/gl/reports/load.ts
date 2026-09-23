/**
 * الطبقة الرقيقة الوحيدة التي تلمس prisma في محرّك التقارير (M4، DESIGN.md §7.1، ADR‑9).
 *
 * كل المنطق المحاسبي صرفٌ في `balances.ts` و`period.ts`؛ هنا قراءةٌ فقط، معزولة بالشركة (§9.4):
 *
 * - **الوضع المجمّع** (بلا فلتر دفتر/تحليلي/مندوب/شريك وبلا تقسيم أفقي): أرصدة `gl_period_balances`
 *   للشهور الكاملة، وبنود الشهور التي يقع داخلها حدّ (`fyStart`/`from`/`to`) وحدها.
 * - **وضع مسح البنود**: `gl_move_lines` مباشرةً عبر `[tenantId, journalId, date]` و
 *   `[tenantId, salesRepId, date]` و`[tenantId, accountId, date]`، **بسقف 12 شهراً** للمدى،
 *   وما فوقه 422 `LEDGER_RANGE_TOO_LARGE`.
 * - **فلتر الشركاء** (`partners`، §7.5): عميلٌ أو مورّد على السطر. `gl_period_balances` لا تحمل
 *   الشريك، فوجوده يفرض وضع مسح البنود تماماً كفلتر الدفتر — وإلا خرج رصيدٌ افتتاحي للحساب كلّه
 *   تحت سطورٍ مفلترة بشريك واحد (إسقاط صامت).
 * - **بنود قيد إقفال السنة** تُقرأ دائماً من قيودها (`moveType='FY_CLOSING'`) لا من مفاتيح
 *   `YYYY-CL` المجمّعة، فنعرف تاريخها الحقيقي ونصنّفها قبل الفترة أو داخلها (§2.5، §7.2).
 * - **المسودات** (`includeDrafts`) عبر `gl_moves [tenantId, state, date]` ثم البنود بـ`[moveId]`.
 *
 * القراءة كلّها بدفعات مؤشّر (keyset) لا بنتيجة واحدة ضخمة (قاعدة 256MB/0.1 نواة)، ومؤشّر البنود
 * على `[tenantId, accountId, date, id]` كما في §7.1 (وهو الفهرس الموجود على الجدول) لا على `id` وحده.
 * سطور العلامة (`taxRole='MARKER'`) مستبعدة كما تستبعدها `gl_period_balances` (I1، §5.9 C2).
 */
import type { Prisma } from '@prisma/client';
import { fromDbDate, monthKey, toDbDate } from '../dates';
import { LedgerError, type AccountType } from '../types';
import { exceedsScanRange, fiscalYearConfigOf, monthSpan, splitMonthKeys, splitMonthRanges, type FiscalYearConfig } from './period';
import {
  SCAN_RANGE_MAX_MONTHS, requiresLineScan,
  type BalanceLineRow, type BalanceReadMode, type BalanceSources, type PeriodBalanceRow, type ReportAccount,
  type ReportBreakdown, type ReportOptions, type ReportPeriod,
} from './types';

/** المعاملة أو عميل prisma — القراءة لا تكتب شيئاً. */
export type ReportDb = Prisma.TransactionClient;

/** حجم دفعة المؤشّر الافتراضي (مطابق لدفعات التصدير القائمة). */
export const REPORT_READ_BATCH = 5_000;

/**
 * سقف دفاعي لعدد البنود المقروءة في طلب واحد: فوقه 422 `LEDGER_RANGE_TOO_LARGE`
 * بـ`{reason:'TOO_MANY_LINES'}`. ليس سقف §7.1 (ذاك بالشهور) بل حماية ذاكرة الخادم.
 */
export const REPORT_MAX_LINES = 400_000;

export interface LoadBalanceOptions {
  /** RPT‑05 — `includeDrafts` هو الحاسم، و`postedOnly` مرادفه المعكوس */
  postedOnly?: boolean;
  includeDrafts?: boolean;
  journals?: readonly string[];
  analytic?: readonly string[];
  salesReps?: readonly string[];
  breakdown?: ReportBreakdown;
  /** حصر بحسابات بعينها (التعمّق ودفتر الأستاذ) */
  accountIds?: readonly string[];
  /**
   * فلتر الشركاء (§7.5): `customerId` أو `vendorId` على السطر. **يفرض وضع مسح البنود** لأنّ
   * الأرصدة المجمّعة لا تحمل الشريك، فيصير الرصيد الافتتاحي مفلتراً بالشريك كالسطور تماماً.
   */
  partners?: readonly string[];
  batchSize?: number;
  /** سقف وضع المسح بالشهور (الافتراضي 12، §7.1) */
  scanRangeMaxMonths?: number;
}

/** فلاتر لا تحملها `ReportOptions` الموحّدة (خاصّة بدفتر الأستاذ والتعمّق، §7.5). */
export interface ReportLoadExtras {
  accountIds?: readonly string[];
  partners?: readonly string[];
}

/**
 * خيارات التقرير الموحّدة ⇐ خيارات القراءة (بلا الخيارات العرضية).
 *
 * `extra` لفلاتر §7.5 التي لا مكان لها في `ReportOptions` (الحسابات والشركاء): تمريرها هنا هو
 * ما يجعل **الرصيد الافتتاحي** مفلتراً بالفلتر نفسه الذي فُلترت به السطور، فلا إسقاط صامت.
 * القوائم الفارغة لا تُضاف مفتاحاً (فيبقى شكل الخيارات كما هو بلا فلتر).
 */
export function reportLoadOptions(opts: ReportOptions, extra: ReportLoadExtras = {}): LoadBalanceOptions {
  const accountIds = extra.accountIds && extra.accountIds.length > 0 ? [...extra.accountIds] : undefined;
  const partners = extra.partners && extra.partners.length > 0 ? [...extra.partners] : undefined;
  return {
    postedOnly: opts.postedOnly,
    includeDrafts: opts.includeDrafts,
    journals: opts.journals,
    analytic: opts.analytic,
    salesReps: opts.salesReps,
    breakdown: opts.breakdown,
    ...(accountIds ? { accountIds } : {}),
    ...(partners ? { partners } : {}),
  };
}

/** فلتر شركاء فعّال؟ (‏`gl_period_balances` لا تحمل الشريك ⇒ مسح بنود، §7.1) */
export function requiresPartnerScan(opts: Pick<LoadBalanceOptions, 'partners'>): boolean {
  return (opts.partners?.length ?? 0) > 0;
}

/**
 * الوضع الذي ستُقرأ به الأرصدة (§7.1). فلتر الشركاء يُضاف إلى فلاتر §7.1 الثلاثة: الأرصدة الشهرية
 * لا تحمل إلا الحساب والشهر، فلا تجيب عن «هذا العميل وحده».
 */
export function balanceReadMode(opts: LoadBalanceOptions): BalanceReadMode {
  return requiresLineScan(opts) || requiresPartnerScan(opts) ? 'LINE_SCAN' : 'AGGREGATE';
}

/** يرفض المدى الذي يتجاوز سقف وضع المسح (422 `LEDGER_RANGE_TOO_LARGE`، §7.1). */
export function assertScanRange(period: ReportPeriod, cap = SCAN_RANGE_MAX_MONTHS): void {
  if (exceedsScanRange(period, cap)) {
    throw new LedgerError('LEDGER_RANGE_TOO_LARGE', {
      from: period.from,
      to: period.to,
      months: monthSpan(period.from, period.to),
      cap,
      reason: 'FILTERED_SCAN',
    });
  }
}

const includesDrafts = (o: LoadBalanceOptions): boolean => o.includeDrafts ?? (o.postedOnly === false);

function idIn<T extends string>(ids: readonly T[] | undefined): { in: string[] } | undefined {
  return ids && ids.length > 0 ? { in: [...ids] } : undefined;
}

/** قراءة مؤشّرية (keyset) على `id` حتى النهاية، بسقف دفاعي. */
async function readAllById<T extends { id: string }>(
  fetch: (args: { take: number; cursor?: { id: string }; skip?: number }) => Promise<T[]>,
  batch: number,
  maxRows: number,
  onOverflow: () => never,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetch({ take: batch, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    out.push(...page);
    if (out.length > maxRows) onOverflow();
    if (page.length < batch) return out;
    cursor = page[page.length - 1].id;
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ═══ الإعدادات والحسابات ═══

export interface ReportSettings {
  configured: boolean;
  fy: FiscalYearConfig;
  currency: string;
  currencyDecimals: number;
  timezone: string;
  /** §7.3 PL‑02 / §7.4: نقل المسحوبات إلى ما بعد صافي الربح */
  drawingsAfterNetProfit: boolean;
  /** §7.3: الإهلاك ضمن نفقات التشغيل بدل «النفقات الأخرى» */
  depreciationInOperatingExpenses: boolean;
}

/** إعدادات الدفاتر التي تحتاجها التقارير (§2.5، §7.3، §7.4). صفٌّ غائب ⇒ `configured:false` بافتراضات. */
export async function loadReportSettings(tx: ReportDb, tenantId: string): Promise<ReportSettings> {
  const s = await tx.glSettings.findUnique({
    where: { tenantId },
    select: {
      fiscalYearEndMonth: true, fiscalYearEndDay: true, currency: true, currencyDecimals: true,
      timezone: true, drawingsAfterNetProfit: true, depreciationInOperatingExpenses: true,
    },
  });
  return {
    configured: !!s,
    fy: fiscalYearConfigOf(s),
    currency: s?.currency ?? 'SAR',
    currencyDecimals: s?.currencyDecimals ?? 2,
    timezone: s?.timezone ?? 'Asia/Riyadh',
    drawingsAfterNetProfit: s?.drawingsAfterNetProfit === true,
    depreciationInOperatingExpenses: s?.depreciationInOperatingExpenses === true,
  };
}

function i18nOf(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string') out[k] = x;
  return Object.keys(out).length > 0 ? out : null;
}

/** حسابات الشركة بالشكل الذي يحتاجه المحرّك، مرتّبة بالرمز. */
export async function loadReportAccounts(
  tx: ReportDb,
  tenantId: string,
  opts: { accountIds?: readonly string[] } = {},
): Promise<ReportAccount[]> {
  const rows = await tx.glAccount.findMany({
    where: { tenantId, ...(idIn(opts.accountIds) ? { id: idIn(opts.accountIds) } : {}) },
    select: { id: true, code: true, name: true, nameI18n: true, type: true },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    nameI18n: i18nOf(r.nameI18n),
    type: r.type as AccountType,
  }));
}

// ═══ البنود ═══

const LINE_SELECT = { id: true, moveId: true, accountId: true, date: true, debitMilli: true, creditMilli: true } as const;

/** صفّ بند كما تقرأه هذه الطبقة (أعمدة `LINE_SELECT` وحدها). */
export type RawLine = {
  id: string; moveId: string; accountId: string; date: Date; debitMilli: bigint; creditMilli: bigint;
};

/** `taxRole='MARKER'` مستبعدة كما في `gl_period_balances` (I1) — والحقل قابل للعدم فيلزم الاتحاد الصريح. */
const NOT_MARKER: Prisma.GlMoveLineWhereInput = { OR: [{ taxRole: null }, { taxRole: { not: 'MARKER' } }] };

function overflow(period: ReportPeriod, cap: number): never {
  throw new LedgerError('LEDGER_RANGE_TOO_LARGE', {
    from: period.from, to: period.to, cap, reason: 'TOO_MANY_LINES',
  });
}

function mapLines(rows: readonly RawLine[], closing: boolean | ReadonlySet<string>, draft: boolean): BalanceLineRow[] {
  return rows.map((r) => ({
    accountId: r.accountId,
    date: fromDbDate(r.date),
    debitMilli: r.debitMilli,
    creditMilli: r.creditMilli,
    closing: typeof closing === 'boolean' ? closing : closing.has(r.moveId),
    draft,
  }));
}

/**
 * فلاتر البنود المشتركة. **الشريك بـ`AND`** لا بـ`OR` مباشر: مفتاح `OR` محجوز لشرط
 * `NOT_MARKER` في كل موضع استدعاء، فلو كتب الفلتر `OR` لأزاحه ولاختفى استبعاد سطور العلامة.
 * (الشكل نفسه الذي تستعمله `ledgerLineWhere` في الطبقة الرقيقة، فيقرأ الطرفان المجموعة نفسها.)
 */
export function reportLineFilters(opts: LoadBalanceOptions): Prisma.GlMoveLineWhereInput {
  const w: Prisma.GlMoveLineWhereInput = {};
  const j = idIn(opts.journals);
  if (j) w.journalId = j;
  const a = idIn(opts.analytic);
  if (a) w.analyticAccountId = a;
  const s = idIn(opts.salesReps);
  if (s) w.salesRepId = s;
  const acc = idIn(opts.accountIds);
  if (acc) w.accountId = acc;
  const p = idIn(opts.partners);
  if (p) w.AND = [{ OR: [{ customerId: p }, { vendorId: p }] }];
  return w;
}

// ═══ مؤشّر البنود [tenantId, accountId, date, id] (§7.1) ═══

/** ترتيب دفعات البنود: مطابق للفهرس `[tenantId, accountId, date]` مع `id` فاصلاً حاسماً. */
export const LINE_KEYSET_ORDER_BY = [
  { accountId: 'asc' }, { date: 'asc' }, { id: 'asc' },
] as const satisfies readonly Prisma.GlMoveLineOrderByWithRelationInput[];

/** موضع آخر سطر في الدفعة السابقة — ثلاثية المؤشّر بعد حصر `tenantId` في الشرط. */
export interface LineKeysetCursor {
  accountId: string;
  date: Date;
  id: string;
}

/**
 * «ما بعد هذا الموضع» بترتيب `[accountId, date, id]` — مقارنة معجمية صريحة على ثلاثة فروع،
 * فلا تكرار ولا فقد بين الدفعات حتى مع تساوي التاريخ أو الحساب (وهو الغالب في يوم واحد).
 * صرفة تماماً وتُختبر بلا قاعدة.
 */
export function lineKeysetAfter(c: LineKeysetCursor): Prisma.GlMoveLineWhereInput {
  return {
    OR: [
      { accountId: { gt: c.accountId } },
      { accountId: c.accountId, date: { gt: c.date } },
      { accountId: c.accountId, date: c.date, id: { gt: c.id } },
    ],
  };
}

/** ترتيب ثلاثية المؤشّر (‏`date` بالمللي ثانية) — ما تطابقه `lineKeysetAfter` في القاعدة. */
export function compareLineKeys(a: LineKeysetCursor, b: LineKeysetCursor): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  const ta = a.date.getTime();
  const tb = b.date.getTime();
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * قراءة مؤشّرية على `[accountId, date, id]` حتى النهاية، بسقف دفاعي.
 * `fetchPage` تُمرَّر حقناً فتُختبر الحلقة (حدود الدفعات: مضاعف تام، وأقل بواحد، وأكثر بواحد،
 * وتواريخ متساوية على حدّ الدفعة) بلا قاعدة بيانات.
 */
export async function readLinesByKeyset(
  fetchPage: (args: { take: number; after: LineKeysetCursor | null }) => Promise<RawLine[]>,
  batch: number,
  maxRows: number,
  onOverflow: () => never,
): Promise<RawLine[]> {
  const out: RawLine[] = [];
  let after: LineKeysetCursor | null = null;
  for (;;) {
    const page = await fetchPage({ take: batch, after });
    out.push(...page);
    if (out.length > maxRows) onOverflow();
    if (page.length < batch) return out;
    const last = page[page.length - 1];
    after = { accountId: last.accountId, date: last.date, id: last.id };
  }
}

async function fetchLines(
  tx: ReportDb,
  where: Prisma.GlMoveLineWhereInput,
  period: ReportPeriod,
  batch: number,
  maxRows: number,
): Promise<RawLine[]> {
  return readLinesByKeyset(
    ({ take, after }) => tx.glMoveLine.findMany({
      where: after ? { AND: [where, lineKeysetAfter(after)] } : where,
      select: LINE_SELECT,
      orderBy: [...LINE_KEYSET_ORDER_BY],
      take,
    }) as Promise<RawLine[]>,
    batch,
    maxRows,
    () => overflow(period, maxRows),
  );
}

// ═══ المصادر ═══

/**
 * يقرأ المصادر الأربعة لـ`composeBalances` (§7.1).
 *
 * @param tx معاملة أو عميل prisma (قراءة فقط)
 * @param tenantId الشركة — كل استعلام محصور بها (§9.4)
 * @param period المدى بعد `resolveReportPeriod` (يحمل `fyStart`)
 * @param opts فلاتر القراءة؛ وجود فلتر دفتر/تحليلي/مندوب/شريك أو تقسيم أفقي يفرض وضع المسح بسقف 12 شهراً
 */
export async function loadBalanceSources(
  tx: ReportDb,
  tenantId: string,
  period: ReportPeriod,
  opts: LoadBalanceOptions = {},
): Promise<BalanceSources> {
  const mode = balanceReadMode(opts);
  const batch = Math.max(100, Math.min(opts.batchSize ?? REPORT_READ_BATCH, 20_000));
  const withDrafts = includesDrafts(opts);
  const toDb = toDbDate(period.to);
  const filters = reportLineFilters(opts);

  if (mode === 'LINE_SCAN') assertScanRange(period, opts.scanRangeMaxMonths ?? SCAN_RANGE_MAX_MONTHS);

  const lines: BalanceLineRow[] = [];

  // (4) بنود قيد إقفال السنة — من قيودها لا من مفاتيح YYYY-CL، فنعرف تاريخها (§2.5)
  const closingMoves = await tx.glMove.findMany({
    where: { tenantId, moveType: 'FY_CLOSING', state: 'POSTED', date: { lte: toDb } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (closingMoves.length > 0) {
    for (const ids of chunk(closingMoves.map((m) => m.id), 200)) {
      const rows = await fetchLines(
        tx,
        { tenantId, moveId: { in: ids }, ...NOT_MARKER, ...filters },
        period, batch, REPORT_MAX_LINES,
      );
      lines.push(...mapLines(rows, true, false));
    }
  }

  // (3) المسودات (RPT‑05) — عبر [tenantId, state, date] ثم [moveId]
  let draftMoveCount = 0;
  if (withDrafts) {
    const draftMoves = await readAllById<{ id: string; moveType: string }>(
      (args) => tx.glMove.findMany({
        where: { tenantId, state: 'DRAFT', date: { lte: toDb } },
        select: { id: true, moveType: true },
        orderBy: { id: 'asc' },
        ...args,
      }),
      batch, REPORT_MAX_LINES, () => overflow(period, REPORT_MAX_LINES),
    );
    draftMoveCount = draftMoves.length;
    // بند مسودة قيدُه FY_CLOSING يبقى بند إقفال (يُصنَّف بالقيد لا بالسطر)
    const draftClosing = new Set(draftMoves.filter((m) => m.moveType === 'FY_CLOSING').map((m) => m.id));
    for (const ids of chunk(draftMoves.map((m) => m.id), 200)) {
      const rows = await fetchLines(
        tx,
        { tenantId, moveId: { in: ids }, ...NOT_MARKER, ...filters },
        period, batch, REPORT_MAX_LINES,
      );
      lines.push(...mapLines(rows, draftClosing, true));
    }
  }

  if (mode === 'LINE_SCAN') {
    // كل الحركة من البنود مباشرةً (§7.1) — الافتتاحي أيضاً، فالأرصدة المجمّعة لا تحمل الفلاتر
    const rows = await fetchLines(
      tx,
      { tenantId, posted: true, date: { lte: toDb }, move: { moveType: { not: 'FY_CLOSING' } }, ...NOT_MARKER, ...filters },
      period, batch, REPORT_MAX_LINES,
    );
    lines.push(...mapLines(rows, false, false));
    return { mode, period, periods: [], lines, splitMonths: [], draftMoveCount };
  }

  // (1) الشهور الكاملة من gl_period_balances (بلا مفاتيح YYYY-CL وبلا الشهور المقسومة)
  const splitMonths = splitMonthKeys(period);
  const periods = await loadPeriodBalances(tx, tenantId, monthKey(period.to), splitMonths, opts.accountIds, batch);

  // (2) بنود الشهور الجزئية على الحواف
  for (const range of splitMonthRanges(period)) {
    const rows = await fetchLines(
      tx,
      {
        tenantId, posted: true,
        date: { gte: toDbDate(range.from), lte: toDbDate(range.to) },
        move: { moveType: { not: 'FY_CLOSING' } },
        ...NOT_MARKER, ...filters,
      },
      period, batch, REPORT_MAX_LINES,
    );
    lines.push(...mapLines(rows, false, false));
  }

  return { mode, period, periods, lines, splitMonths, draftMoveCount };
}

/** أرصدة الشهور الكاملة بدفعات مؤشّر على المفتاح الفريد `[tenantId, accountId, periodKey]`. */
async function loadPeriodBalances(
  tx: ReportDb,
  tenantId: string,
  maxMonthKey: string,
  splitMonths: readonly string[],
  accountIds: readonly string[] | undefined,
  batch: number,
): Promise<PeriodBalanceRow[]> {
  const where: Prisma.GlPeriodBalanceWhereInput = {
    tenantId,
    periodKey: { lte: maxMonthKey, ...(splitMonths.length > 0 ? { notIn: [...splitMonths] } : {}) },
    NOT: { periodKey: { endsWith: '-CL' } },
    ...(idIn(accountIds) ? { accountId: idIn(accountIds) } : {}),
  };
  const out: PeriodBalanceRow[] = [];
  let cursor: { accountId: string; periodKey: string } | undefined;
  for (;;) {
    const page = await tx.glPeriodBalance.findMany({
      where,
      select: { accountId: true, periodKey: true, debitMilli: true, creditMilli: true },
      orderBy: [{ accountId: 'asc' }, { periodKey: 'asc' }],
      take: batch,
      ...(cursor ? { cursor: { tenantId_accountId_periodKey: { tenantId, ...cursor } }, skip: 1 } : {}),
    });
    out.push(...page.map((r) => ({
      accountId: r.accountId, periodKey: r.periodKey, debitMilli: r.debitMilli, creditMilli: r.creditMilli,
    })));
    if (page.length < batch) return out;
    const last = page[page.length - 1];
    cursor = { accountId: last.accountId, periodKey: last.periodKey };
  }
}
