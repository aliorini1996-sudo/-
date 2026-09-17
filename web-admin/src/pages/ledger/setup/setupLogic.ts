import type { LocalDate, TaxPeriodicity } from '../../../api/ledgerConfig';
import type { ManualBalanceRowInput, SetupDraft, SetupEffective, SetupMethod } from '../../../api/ledgerSetup';
import { parseAmountToMilli } from '../../../lib/ledger/format';

/**
 * منطق معالج الإعداد الصرف (§5.6) بلا React — مختبَر في setupLogic.test.ts:
 * خطوات المعالج، ومرآة إرشادية لحد فترة الإقرار (الخادم هو الحكم بـLEDGER_CUTOVER_MID_VAT_PERIOD)،
 * وتحليل قالب XLSX للأرصدة اليدوية إلى `draft.step5.rows`، ومجاميعها بالمللي.
 */

// ═══ ثوابت الخادم (مرآة services/gl/opening.ts وstep5Schema — حارس setupLogic.test) ═══

/** سقف صفوف الأرصدة اليدوية في المسودة */
export const MANUAL_BALANCE_MAX_ROWS = 5000;
/** أعمدة قالب XLSX للأرصدة اليدوية */
export const OPENING_BALANCE_TEMPLATE_COLUMNS = ['accountCode', 'debit', 'credit', 'vendorName', 'dueDate'] as const;
export const MANUAL_BALANCE_ISSUES = [
  'ACCOUNT_NOT_FOUND', 'ACCOUNT_ARCHIVED', 'DERIVED_ACCOUNT', 'OPENING_EQUITY', 'EQUITY_UNAFFECTED', 'OFF_BALANCE',
  'VAT_REQUIRES_MID_PERIOD', 'VENDOR_REQUIRED', 'INVALID_AMOUNT', 'NEGATIVE_AMOUNT', 'DEBIT_AND_CREDIT', 'ZERO_AMOUNT',
  'INVALID_DUE_DATE',
] as const;
export type ManualBalanceIssueReason = (typeof MANUAL_BALANCE_ISSUES)[number];

// ═══ الخطوات ═══

export const SETUP_STEPS = [1, 2, 3, 4, 5, 6] as const;
export type SetupStepNo = (typeof SETUP_STEPS)[number];

export const clampStep = (n: unknown): SetupStepNo => {
  const v = Math.trunc(Number(n));
  return (v >= 1 && v <= 6 ? v : 1) as SetupStepNo;
};

// ═══ التواريخ (مرآة services/gl/dates.ts وopening.ts) ═══

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const pad = (n: number) => String(n).padStart(2, '0');

export function isLocalDate(v: unknown): v is LocalDate {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** نهاية السنة المالية في سنة y (اليوم مقصوص على طول الشهر: 29 فبراير) */
const fiscalEndIn = (y: number, m: number, d: number): LocalDate => `${y}-${pad(m)}-${pad(Math.min(d, daysInMonth(y, m)))}`;

export function fiscalYearStart(date: LocalDate, endMonth = 12, endDay = 31): LocalDate {
  const y = Number(date.slice(0, 4));
  const endThis = fiscalEndIn(y, endMonth, endDay);
  const end = date <= endThis ? endThis : fiscalEndIn(y + 1, endMonth, endDay);
  return addDays(fiscalEndIn(Number(end.slice(0, 4)) - 1, endMonth, endDay), 1);
}

const PERIOD_MONTHS: Record<Exclude<TaxPeriodicity, 'FISCAL_YEAR'>, number> = {
  MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, FOUR_MONTHS: 4, SEMIANNUAL: 6, ANNUAL: 12,
};

/** مرآة isVatPeriodStart: فترات تقويمية (الربعية يناير/أبريل/يوليو/أكتوبر)، وFISCAL_YEAR بداية السنة المالية */
export function isVatPeriodStart(date: LocalDate, periodicity: TaxPeriodicity, fyEndMonth = 12, fyEndDay = 31): boolean {
  if (!isLocalDate(date)) return false;
  if (periodicity === 'FISCAL_YEAR') return fiscalYearStart(date, fyEndMonth, fyEndDay) === date;
  const m = Number(date.slice(5, 7));
  if (date.slice(8) !== '01') return false;
  return (m - 1) % PERIOD_MONTHS[periodicity] === 0;
}

/** SA_6D وتاريخ داخل فترة ⇒ يلزم التأكيد ومبالغ المربعات (إرشادي؛ الخادم الحكم) */
export function needsMidPeriodConfirm(templateKey: string, cutoverDate: LocalDate | null | undefined, periodicity: TaxPeriodicity, fyEndMonth: number, fyEndDay: number): boolean {
  if (templateKey !== 'SA_6D' || !cutoverDate || !isLocalDate(cutoverDate)) return false;
  return !isVatPeriodStart(cutoverDate, periodicity, fyEndMonth, fyEndDay);
}

/** مربعات الإقرار السعودي ذات السطور (1–5 المبيعات، 7–11 المشتريات) للإقرار الأول العابر لتاريخ البدء (§6.6) */
export const PRE_CUTOVER_BOX_NOS = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11] as const;
export const preCutoverBoxKey = (no: number, col: 'amount' | 'tax') => `SA_${no}.${col}`;

/** مبالغ المربعات المدخلة ⇒ السجل المرسَل (الفارغ لا يُرسل)؛ null حين لا قيمة */
export function compactBoxes(values: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const s = String(v ?? '').trim();
    if (s !== '') out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

// ═══ الطريقة والتاريخ الفعلي ═══

/** تاريخ البدء الفعلي: الطريقة (ب) = بداية السنة المالية لأقدم أثر (من الخادم)، وإلا تاريخ الخطوة 1 */
export function effectiveCutover(method: SetupMethod, step1Cutover: LocalDate | null | undefined, fullHistoryCutoverDate: LocalDate | null | undefined): LocalDate | null {
  if (method === 'FULL_HISTORY') return fullHistoryCutoverDate ?? step1Cutover ?? null;
  return step1Cutover ?? null;
}

/** تاريخ القيد الافتتاحي = cutover − 1 */
export const openingDateOf = (cutover: LocalDate) => addDays(cutover, -1);

/** قيم الخطوة 1 الابتدائية: المسودة ثم الفعلي من الخادم ثم التاريخ المقترح */
export function initialStep1(draft: SetupDraft, eff: SetupEffective, suggested: LocalDate) {
  const d = draft.step1 ?? {};
  return {
    timezone: d.timezone ?? eff.timezone,
    fiscalYearEndMonth: d.fiscalYearEndMonth ?? eff.fiscalYearEndMonth,
    fiscalYearEndDay: d.fiscalYearEndDay ?? eff.fiscalYearEndDay,
    weekStartsOn: d.weekStartsOn ?? eff.weekStartsOn,
    taxPeriodicity: d.taxPeriodicity ?? eff.taxPeriodicity,
    cutoverDate: d.cutoverDate ?? eff.cutoverDate ?? suggested,
    confirmMidVatPeriod: d.confirmMidVatPeriod === true,
    preCutoverBoxes: d.preCutoverBoxes ?? null,
  };
}

// ═══ الأرصدة اليدوية (الخطوة 5) ═══

export type OpeningImportField = (typeof OPENING_BALANCE_TEMPLATE_COLUMNS)[number];

const HEADER_SYNONYMS: Record<OpeningImportField, string[]> = {
  accountCode: ['accountCode', 'account code', 'code', 'account', 'رمز الحساب', 'الرمز', 'رقم الحساب', 'الحساب'],
  debit: ['debit', 'مدين', 'المدين'],
  credit: ['credit', 'دائن', 'الدائن'],
  vendorName: ['vendorName', 'vendor name', 'vendor', 'supplier', 'المورد', 'المورّد', 'اسم المورد', 'اسم المورّد'],
  dueDate: ['dueDate', 'due date', 'due', 'تاريخ الاستحقاق', 'الاستحقاق'],
};

const normHeader = (s: string) => s.trim().toLowerCase().replace(/[ّ]/g, '').replace(/[\s_\-.]+/g, ' ').replace(/[أإآ]/g, 'ا');

export function openingFieldOf(header: string): OpeningImportField | null {
  const h = normHeader(header);
  for (const [field, names] of Object.entries(HEADER_SYNONYMS) as [OpeningImportField, string[]][]) {
    if (names.some(n => normHeader(n) === h)) return field;
  }
  return null;
}

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).trim();
};

/** تاريخ من خلية: YYYY-MM-DD، أو DD/MM/YYYY، أو Date (cellDates) — غير الصالح يُمرَّر نصاً ليرفضه الخادم بسببه */
export function normalizeDueDate(v: unknown): string | null {
  const s = cellText(v).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
  if (!s) return null;
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (iso) return `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`;
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
  return s;
}

export interface OpeningImportResult {
  rows: ManualBalanceRowInput[];
  /** أعمدة إلزامية غائبة (الرمز ومدين أو دائن) */
  missingColumns: OpeningImportField[];
  /** صفوف فارغة الرمز والمبالغ تُتجاهل */
  skippedEmpty: number;
  tooMany: boolean;
}

/** سجلات parseExcelFile (مفتاح = عنوان العمود) ⇒ صفوف step5 بأعمدة القالب */
export function parseOpeningBalanceRecords(records: readonly Record<string, unknown>[]): OpeningImportResult {
  const headers = new Map<OpeningImportField, string>();
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      const f = openingFieldOf(k);
      if (f && !headers.has(f)) headers.set(f, k);
    }
  }
  const missingColumns: OpeningImportField[] = [];
  if (!headers.has('accountCode')) missingColumns.push('accountCode');
  if (!headers.has('debit') && !headers.has('credit')) missingColumns.push('debit', 'credit');
  const get = (rec: Record<string, unknown>, f: OpeningImportField) => (headers.has(f) ? rec[headers.get(f)!] : undefined);
  const rows: ManualBalanceRowInput[] = [];
  let skippedEmpty = 0;
  if (missingColumns.length === 0) {
    for (const rec of records) {
      const accountCode = cellText(get(rec, 'accountCode'));
      const debit = cellText(get(rec, 'debit'));
      const credit = cellText(get(rec, 'credit'));
      if (!accountCode && !debit && !credit) { skippedEmpty++; continue; }
      const vendorName = cellText(get(rec, 'vendorName'));
      const dueDate = normalizeDueDate(get(rec, 'dueDate'));
      rows.push({
        accountCode,
        debit: debit || null,
        credit: credit || null,
        ...(vendorName ? { vendorName } : {}),
        ...(dueDate ? { dueDate } : {}),
      });
    }
  }
  return { rows: rows.slice(0, MANUAL_BALANCE_MAX_ROWS), missingColumns, skippedEmpty, tooMany: rows.length > MANUAL_BALANCE_MAX_ROWS };
}

/** صف فارغ تماماً (لا يُرسل) */
export const isBlankRow = (r: ManualBalanceRowInput) =>
  !String(r.accountCode ?? '').trim() && !String(r.debit ?? '').trim() && !String(r.credit ?? '').trim() && !String(r.vendorName ?? '').trim();

/** الصفوف المرسلة: بلا الفارغة، والمبالغ نصوص مطبّعة (أرقام عربية هندية ⇒ لاتينية) */
export function cleanManualRows(rows: readonly ManualBalanceRowInput[]): ManualBalanceRowInput[] {
  const norm = (v: unknown) => {
    const s = String(v ?? '').trim().replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.').replace(/[٬,\s]/g, '');
    return s === '' ? null : s;
  };
  return rows.filter(r => !isBlankRow(r)).map(r => {
    const out: ManualBalanceRowInput = { accountCode: String(r.accountCode ?? '').trim(), debit: norm(r.debit), credit: norm(r.credit) };
    const vendorName = String(r.vendorName ?? '').trim();
    if (r.vendorId) out.vendorId = r.vendorId;
    if (vendorName) out.vendorName = vendorName;
    if (r.dueDate) out.dueDate = r.dueDate;
    if (r.salesRepId) out.salesRepId = r.salesRepId;
    if (r.label) out.label = r.label;
    return out;
  });
}

/** مجاميع مدين ودائن بالمللي (غير الصالح يُتجاهل هنا ويرفضه الخادم بسببه) */
export function manualTotalsMilli(rows: readonly ManualBalanceRowInput[], decimals: number): { debit: bigint; credit: bigint; invalid: number } {
  let debit = 0n; let credit = 0n; let invalid = 0;
  for (const r of rows) {
    const d = parseAmountToMilli(r.debit ?? '', decimals);
    const c = parseAmountToMilli(r.credit ?? '', decimals);
    if (d === null || c === null) { invalid++; continue; }
    debit += d; credit += c;
  }
  return { debit, credit, invalid };
}

/** نص عشري من مللي للعرض عبر LedgerAmount */
export function milliText(m: bigint): string {
  const neg = m < 0n;
  const s = (neg ? -m : m).toString().padStart(4, '0');
  return `${neg ? '-' : ''}${s.slice(0, -3)}.${s.slice(-3)}`;
}

/** قيمة مبلغ معاينة (نص formatMilli) صفرية؟ */
export const isZeroAmount = (v: string | number | null | undefined) => !v || /^-?[0.]*$/.test(String(v));

// ═══ الاستيراد والدفاتر (تنبيهات المعالج) ═══

/** رابط قسم «استيراد البيانات من نظامك السابق» في إعدادات الشركة */
export const DATA_IMPORT_HREF = '/app/company#data-import';
export const DATA_IMPORT_ANCHOR = 'data-import';
/** وارد المستودع بتكلفته (المخزون الافتتاحي) */
export const WAREHOUSE_HREF = '/app/warehouse';

/** تنبيه «حركات مستوردة بعد تاريخ البدء» يظهر حين عددها > 0 */
export const hasPostCutoverImports = (x: { count: number } | null | undefined): boolean => !!x && Number(x.count) > 0;

/** زر التفعيل ينتظر الإقرار بالحركات المستوردة بعد البدء */
export const importsAckBlocksCommit = (x: { count: number } | null | undefined, acknowledged: boolean): boolean =>
  hasPostCutoverImports(x) && !acknowledged;

// ═══ المخزون الافتتاحي المستورد (openingStock في المعاينة) ═══

export type OpeningStockCommitBlock = 'FULL_HISTORY' | 'AFTER_CUTOVER_ACK' | 'TOO_RECENT' | null;

export interface OpeningStockReview {
  /** للمعاينة شيء يُعرض */
  visible: boolean;
  fullHistoryBlocked: boolean;
  afterCutover: boolean;
  tooRecent: boolean;
  /** أقرب تاريخ بدء يشمل كل الحركات المستوردة بعد البدء (الاعتماد في يوم لاحق) */
  minCutoverDate: LocalDate | null;
  retryAfter: string | null;
  /** المتبقي حتى retryAfter بالملّي ثانية (0 حين مضى) */
  waitMs: number;
  /** ما يمنع زر التفعيل، بترتيب فحوص /setup/commit */
  block: OpeningStockCommitBlock;
}

type OpeningStockLike = {
  fullHistoryBlocked?: boolean;
  afterCutover?: { count: number; minCutoverDate?: LocalDate | null } | null;
  tooRecent?: { count: number; retryAfter?: string | null } | null;
} | null | undefined;

/**
 * مرآة فحوص /setup/commit للمخزون الافتتاحي على المعاينة (الخادم هو الحكم):
 * التاريخ الكامل مع دفعة ⇒ ممنوع؛ بعد البدء ⇒ إقرار acknowledgeOpeningStockExcluded؛ أحدث من اللقطة ⇒ انتظار retryAfter.
 * retryAfter مضى ⇒ لا يمنع (تُعاد المعاينة فيختفي).
 */
export function openingStockReview(os: OpeningStockLike, acknowledged: boolean, now: Date): OpeningStockReview {
  const fullHistoryBlocked = os?.fullHistoryBlocked === true;
  const afterCutover = Number(os?.afterCutover?.count ?? 0) > 0;
  const tooRecent = Number(os?.tooRecent?.count ?? 0) > 0;
  const retryAfter = tooRecent ? os?.tooRecent?.retryAfter ?? null : null;
  const at = retryAfter ? Date.parse(retryAfter) : NaN;
  const waitMs = Number.isFinite(at) ? Math.max(0, at - now.getTime()) : 0;
  const block: OpeningStockCommitBlock = fullHistoryBlocked ? 'FULL_HISTORY'
    : afterCutover && !acknowledged ? 'AFTER_CUTOVER_ACK'
      : tooRecent && waitMs > 0 ? 'TOO_RECENT'
        : null;
  return {
    visible: fullHistoryBlocked || afterCutover || tooRecent,
    fullHistoryBlocked, afterCutover, tooRecent,
    minCutoverDate: afterCutover ? os?.afterCutover?.minCutoverDate ?? null : null,
    retryAfter, waitMs, block,
  };
}

// ═══ البند 26: روابط فئات المنتجات بحسابات الإيراد في المسودة ═══

/**
 * روابط «فئة ⇒ حساب إيراد» المحفوظة في الخطوة 3، مصفّاةً على الفئات القائمة.
 *
 * فئة حُذفت (بتراجع عن دفعة منتجات مثلاً) يبقى معرّفها في المسودة فيُعاد حفظه كل مرة، ويُسقطه
 * الخادم عند الاعتماد بلا علم المالك. و`liveIds === null` يعني أن القائمة غير معروفة (الاستعلام
 * معطّل قبل زرع شجرة الحسابات، أو قيد التحميل، أو فشل): تُحفظ الروابط كما هي، فمسحُها لمجرد
 * فشل استعلام يضيّع ربطاً صحيحاً — وهو خطأ أسوأ من الذي نصلحه.
 */
export function keepLiveCategoryLinks(
  catCodes: Record<string, string>, liveIds: ReadonlySet<string> | null,
): { categoryId: string; accountCode: string }[] {
  return Object.entries(catCodes)
    .filter(([categoryId, code]) => !!code && (!liveIds || liveIds.has(categoryId)))
    .map(([categoryId, accountCode]) => ({ categoryId, accountCode }));
}

// ═══ البند 25: تعارض المنطقة الزمنية مع الأرصدة والكشوف المستوردة ═══

/** رمز الخادم: تغيير المنطقة وللشركة دفعات balances/ledger غير متراجع عنها بلا rebaseImportDates */
export const TIMEZONE_IMPORTS_CONFLICT_CODE = 'LEDGER_TIMEZONE_IMPORTS_CONFLICT';

export interface TimezoneImportsConflict {
  previousTimezone: string;
  timezone: string;
  batches: { id: string; kind: string; count: number; createdAt: string }[];
}

/**
 * جسم 409 LEDGER_TIMEZONE_IMPORTS_CONFLICT ⇒ تفاصيله، وإلا null.
 *
 * بدونه كان تغيير المنطقة مسدوداً في الواجهة: الخادم يطلب إقراراً (`rebaseImportDates`) ولا مسار
 * في المعالج لإرساله، فشركةٌ استوردت أرصدتها قبل فتح المعالج لا تستطيع اختيار منطقتها إطلاقاً.
 */
export function timezoneImportsConflictOf(e: unknown): TimezoneImportsConflict | null {
  const body = e as { code?: string; details?: Record<string, unknown> | null } | null | undefined;
  if (!body || body.code !== TIMEZONE_IMPORTS_CONFLICT_CODE) return null;
  const d = (body.details ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(d.batches) ? d.batches : [];
  return {
    previousTimezone: typeof d.previousTimezone === 'string' ? d.previousTimezone : '',
    timezone: typeof d.timezone === 'string' ? d.timezone : '',
    batches: raw.map(b => {
      const x = (b ?? {}) as Record<string, unknown>;
      return {
        id: String(x.id ?? ''), kind: String(x.kind ?? ''),
        count: typeof x.count === 'number' ? x.count : 0,
        createdAt: typeof x.createdAt === 'string' ? x.createdAt : '',
      };
    }),
  };
}

/** رفض اعتماد يستوجب إعادة المعاينة وإلغاء الإقرارات (الأرقام تغيّرت بعد المعاينة) */
export const COMMIT_REFRESH_CODES = [
  'LEDGER_POST_CUTOVER_IMPORTS_ACK', 'LEDGER_IMPORT_IN_PROGRESS',
  'LEDGER_OPENING_STOCK_AFTER_CUTOVER', 'LEDGER_OPENING_STOCK_FULL_HISTORY', 'LEDGER_OPENING_STOCK_TOO_RECENT',
] as const;
export const commitNeedsRefresh = (code: string | null | undefined): boolean =>
  !!code && (COMMIT_REFRESH_CODES as readonly string[]).includes(code);

/** تلميحات الخطوة 4: ذمم صفرية وللشركة عملاء، ومخزون صفري وللشركة منتجات */
export function openingDataHints(p: {
  opening: { receivablesTotal: string; warehouse: { value: string } };
  tenantCounts?: { customers: number; products: number } | null;
  openingStock?: { batches: number } | null;
}): { receivablesMissing: boolean; inventoryMissing: boolean } {
  const c = p.tenantCounts;
  return {
    receivablesMissing: !!c && c.customers > 0 && isZeroAmount(p.opening.receivablesTotal),
    // مخزون مستورد خارج الافتتاح يُشرح في تنبيهه، لا «مخزون صفري»
    inventoryMissing: !!c && c.products > 0 && isZeroAmount(p.opening.warehouse.value) && !(p.openingStock && p.openingStock.batches > 0),
  };
}

export type DerivedAccountKind = 'AR' | 'INVENTORY' | 'OTHER';

/**
 * نوع الحساب المشتق لنص DERIVED_ACCOUNT: الذمم ⇒ صفحة الاستيراد، ومخزون المستودع ⇒ وارد المستودع، والباقي النص العام.
 * بلا نوع رئيسي (الشجرة لم تُزرع بعد) يُستدل بالرمز القالبي 113001/114001.
 */
export function derivedAccountKind(controlKind: string | null | undefined, accountCode?: string | number | null): DerivedAccountKind {
  if (controlKind === 'AR') return 'AR';
  if (controlKind === 'INVENTORY') return 'INVENTORY';
  if (controlKind) return 'OTHER';
  const code = String(accountCode ?? '').trim();
  if (code === '113001') return 'AR';
  if (code === '114001') return 'INVENTORY';
  return 'OTHER';
}
