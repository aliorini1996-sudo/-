/**
 * الأنواع والثوابت المشتركة للمحرك المحاسبي الصرف (M1، DESIGN.md §2–§5).
 *
 * قاعدة M1: لا استيراد لـprisma ولا '@prisma/client' ولا أي I/O تحت services/gl.
 * المبالغ «ملّي» BigInt (§2.3)، والتواريخ المحاسبية نصوص محلية 'YYYY-MM-DD' (§2.5)
 * لا كائنات Date — فلا تتسلل منطقة الخادم الزمنية إلى القيد.
 */

// ═══ الأنواع الأساسية ═══

/** مبلغ بوحدة الألف من وحدة العملة (هللة/1000 × 10) — §2.3. */
export type Milli = bigint;

/** تاريخ محلي للشركة بصيغة 'YYYY-MM-DD' (§2.5) — يُحوَّل إلى @db.Date عند الحفظ فقط. */
export type LocalDate = string;

// ═══ أنواع الحسابات (§4.1) ═══

export const ACCOUNT_TYPES = [
  'asset_cash',
  'asset_receivable',
  'asset_current',
  'asset_prepayments',
  'asset_fixed',
  'asset_non_current',
  'liability_payable',
  'liability_credit_card',
  'liability_current',
  'liability_non_current',
  'equity',
  'equity_unaffected',
  'income',
  'income_other',
  'expense_direct_cost',
  'expense',
  'expense_depreciation',
  'expense_other',
  'expense_zakat',
  'off_balance',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** الجانب الطبيعي لكل نوع (§4.1) — off_balance بلا جانب. */
export const ACCOUNT_TYPE_NATURAL_SIDE: Readonly<Record<AccountType, 'DEBIT' | 'CREDIT' | null>> = {
  asset_cash: 'DEBIT',
  asset_receivable: 'DEBIT',
  asset_current: 'DEBIT',
  asset_prepayments: 'DEBIT',
  asset_fixed: 'DEBIT',
  asset_non_current: 'DEBIT',
  liability_payable: 'CREDIT',
  liability_credit_card: 'CREDIT',
  liability_current: 'CREDIT',
  liability_non_current: 'CREDIT',
  equity: 'CREDIT',
  equity_unaffected: 'CREDIT',
  income: 'CREDIT',
  income_other: 'CREDIT',
  expense_direct_cost: 'DEBIT',
  expense: 'DEBIT',
  expense_depreciation: 'DEBIT',
  expense_other: 'DEBIT',
  expense_zakat: 'DEBIT',
  off_balance: null,
};

export function isAccountType(v: unknown): v is AccountType {
  return typeof v === 'string' && (ACCOUNT_TYPES as readonly string[]).includes(v);
}

// ═══ مفاتيح الربط (§4.5) ═══

export const MAPPING_KEYS = [
  'AR_CONTROL', 'AP_CONTROL', 'SALES_REVENUE', 'SALES_RETURNS', 'SALES_DISCOUNT',
  'OUTPUT_VAT', 'INPUT_VAT', 'VAT_PAYABLE', 'VAT_RECEIVABLE', 'VAT_RC_OUTPUT',
  'REP_CUSTODY', 'MAIN_CASH', 'PETTY_CASH', 'MAIN_BANK', 'OUTSTANDING_RECEIPTS',
  'OUTSTANDING_PAYMENTS', 'CHEQUES_UNDER_COLLECTION', 'POS_CLEARING', 'PAYLINK_CLEARING',
  'PAYLINK_FEE_EXPENSE', 'PAYLINK_PAYOUT_ACCOUNT', 'BANK_SUSPENSE', 'BANK_FEES',
  'INTERNAL_TRANSFER', 'OPENING_EQUITY', 'CURRENT_YEAR_EARNINGS', 'RETAINED_EARNINGS',
  'DRAWINGS', 'ROUNDING', 'POSTING_SUSPENSE', 'INVENTORY_WAREHOUSE', 'INVENTORY_VAN',
  'GRNI', 'COGS', 'PURCHASES', 'PURCHASE_RETURNS', 'INVENTORY_CHANGE', 'INVENTORY_WRITEOFF',
  'INVENTORY_ADJUSTMENT', 'VENDOR_ADVANCES', 'EARLY_DISCOUNT_GAIN', 'EARLY_DISCOUNT_LOSS',
  'DEFERRED_REVENUE', 'DEFERRED_EXPENSE', 'ASSET_GAIN', 'ASSET_LOSS', 'LOAN_INTEREST',
  'LEASE_LIABILITY', 'ROU_ASSET', 'ROU_ACCUMULATED', 'FX_GAIN', 'FX_LOSS', 'WHT_PAYABLE',
  'ZAKAT_EXPENSE', 'ZAKAT_PROVISION', 'BAD_DEBT', 'DOUBTFUL_ALLOWANCE', 'ACCRUED_EXPENSES',
  'EOSB_PROVISION', 'FUEL', 'VAT_CORRECTIONS',
] as const;
export type MappingKey = (typeof MAPPING_KEYS)[number];

export function isMappingKey(v: unknown): v is MappingKey {
  return typeof v === 'string' && (MAPPING_KEYS as readonly string[]).includes(v);
}

// ═══ أنواع الحسابات الرئيسية (§3.2 controlKind، I4، I7) ═══

export const CONTROL_KINDS = ['AR', 'AP', 'CUSTODY', 'PAYLINK', 'INVENTORY', 'VAT_OUT', 'VAT_IN', 'SUSPENSE'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** I4/I7: حسابات يغذّيها مصدرها وحده — ممنوعة في القيد اليدوي، وتجعل القيد مملوكاً لمصدر. */
export const SOURCE_OWNED_CONTROL_KINDS: readonly ControlKind[] = ['AR', 'AP', 'CUSTODY', 'PAYLINK', 'INVENTORY'];

/** I4: سطر يدوي عليها يُقبل فقط بـtaxId وvatBox. */
export const VAT_CONTROL_KINDS: readonly ControlKind[] = ['VAT_OUT', 'VAT_IN'];

export const CASH_FLOW_TAGS = ['OPERATING', 'INVESTING', 'FINANCING', 'EXCLUDE', 'CASH_EQUIVALENT'] as const;
export type CashFlowTag = (typeof CASH_FLOW_TAGS)[number];

// ═══ الدفاتر (§3.2، §4.3) ═══

export const JOURNAL_TYPES = ['SALE', 'PURCHASE', 'CASH', 'BANK', 'GENERAL'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

export const JOURNAL_SYSTEM_KEYS = [
  'SALES', 'RECEIPTS', 'CUSTODY', 'PURCHASES', 'PAYMENTS', 'EXPENSES', 'CASH_MAIN', 'BANK_MAIN',
  'PAYLINK', 'MISC', 'STOCK', 'TAX', 'DEPRECIATION', 'ZAKAT', 'OPENING', 'FX',
] as const;
export type JournalSystemKey = (typeof JOURNAL_SYSTEM_KEYS)[number];

/** رمز الدفتر المزروع لكل systemKey (§4.3) — القالب؛ الشركة قد تغيّر الرمز قبل أول ترحيل. */
export const JOURNAL_CODE_BY_SYSTEM_KEY: Readonly<Record<JournalSystemKey, string>> = {
  SALES: 'INV',
  RECEIPTS: 'RCPT',
  CUSTODY: 'CUST',
  PURCHASES: 'BILL',
  PAYMENTS: 'PAY',
  EXPENSES: 'EXP',
  CASH_MAIN: 'CSH1',
  BANK_MAIN: 'BNK1',
  PAYLINK: 'PLNK',
  MISC: 'MISC',
  STOCK: 'STK',
  TAX: 'TAX',
  DEPRECIATION: 'DEP',
  ZAKAT: 'ZKT',
  OPENING: 'OPEN',
  FX: 'FX',
};

export const SEQUENCE_RESETS = ['MONTHLY', 'YEARLY'] as const;
export type SequenceReset = (typeof SEQUENCE_RESETS)[number];

// ═══ القيود (§3.3) ═══

export const MOVE_TYPES = [
  'ENTRY', 'OUT_INVOICE', 'OUT_REFUND', 'CUST_RECEIPT', 'CUSTODY_SETTLEMENT', 'PAYLINK_FEE',
  'PAYLINK_PAYOUT', 'IMPORT', 'IN_INVOICE', 'IN_REFUND', 'PAYMENT', 'EXPENSE', 'STATEMENT_LINE',
  'RECONCILE', 'STOCK', 'COGS', 'INV_CLOSING', 'DEPRECIATION', 'LOAN', 'DEFERRAL', 'TAX_CLOSING',
  'OPENING', 'FY_CLOSING', 'FX', 'CUSTOMER_ADJUSTMENT', 'CUSTODY_SHORTAGE', 'CONTROL_ADJUSTMENT',
] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export const MOVE_STATES = ['DRAFT', 'POSTED'] as const;
export type MoveState = (typeof MOVE_STATES)[number];

export const MOVE_ORIGINS = ['MANUAL', 'AUTO'] as const;
export type MoveOrigin = (typeof MOVE_ORIGINS)[number];

export const TAX_ROLES = ['BASE', 'TAX', 'MARKER'] as const;
export type TaxRole = (typeof TAX_ROLES)[number];

// ═══ الضرائب (§3.2 GlTax، §4.4) ═══

export const TAX_USES = ['SALE', 'PURCHASE', 'NONE'] as const;
export type TaxUse = (typeof TAX_USES)[number];

export const VAT_CATEGORIES = ['S', 'Z', 'E', 'O'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

/** مربعات الإقرار السعودي المخزّنة على السطور (§3.2 vatBox، §7.8). */
export const VAT_BOXES_SA = [
  'SA_1', 'SA_2', 'SA_3', 'SA_4', 'SA_5', 'SA_6', 'SA_7', 'SA_8', 'SA_9', 'SA_10', 'SA_11',
] as const;
export type VatBoxSA = (typeof VAT_BOXES_SA)[number];

export const TAX_DEADLINE_RULES = ['END_OF_NEXT_MONTH', 'DAYS_AFTER'] as const;
export type TaxDeadlineRule = (typeof TAX_DEADLINE_RULES)[number];

export const TAX_PERIODICITIES = [
  'MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'FOUR_MONTHS', 'SEMIANNUAL', 'ANNUAL', 'FISCAL_YEAR',
] as const;
export type TaxPeriodicity = (typeof TAX_PERIODICITIES)[number];

export const TEMPLATE_KEYS = ['SA_6D', 'GENERIC_6D'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

// ═══ الإعدادات (§3.2 GlSettings) ═══

export const INVENTORY_MODES = ['PERIODIC', 'PERPETUAL'] as const;
export type InventoryMode = (typeof INVENTORY_MODES)[number];

export const CASH_INVOICE_ROUTINGS = ['MAIN_CASH', 'CUSTODY'] as const;
export type CashInvoiceRouting = (typeof CASH_INVOICE_ROUTINGS)[number];

export const BACKFILL_STATES = ['NONE', 'RUNNING', 'DONE', 'PAUSED'] as const;
export type BackfillState = (typeof BACKFILL_STATES)[number];

/** طرق الدفع القائمة في Receipt/RepSettlement (schema.prisma وroutes/receipts.ts). */
export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'ONLINE'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** receiptRouting (§3.2): وجهة كل طريقة غير إلكترونية بوجود مندوب. */
export type ReceiptRouteTarget = 'CUSTODY' | 'DIRECT';
export type ReceiptRouting = Partial<Record<Exclude<PaymentMethod, 'ONLINE'>, ReceiptRouteTarget>>;

// ═══ المزامنة والأحداث (§3.4، §5.2، §5.4) ═══

export const SOURCE_TYPES = [
  'INVOICE', 'RECEIPT', 'AR_ENTRY', 'SETTLEMENT', 'PAYLINK_FEE', 'PAYOUT', 'WH_ENTRY', 'VAN_LOAD',
  'RESTOCK', 'CUSTOMER_ADJUSTMENT',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_EVENTS = ['POST', 'REVERSE', 'COGS', 'RESTOCK'] as const;
export type SourceEvent = (typeof SOURCE_EVENTS)[number];

export const EVENT_STATUSES = ['PENDING', 'DONE', 'SKIPPED', 'BLOCKED', 'ERROR', 'HELD'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const SKIP_REASONS = ['OPENING', 'NETTED', 'MANUAL', 'NEVER_MATERIALIZED', 'ZERO_VALUE'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** حالات الأحداث (ملحق ب — ليست استجابات HTTP) ومعها HELD(UNEXPECTED_ENTRY_SHAPE) من §5.2. */
export const EVENT_HOLD_REASONS = [
  'CURRENCY_MISMATCH', 'MISSING_MAPPING', 'SOURCE_NOT_FOUND', 'UNEXPECTED_ENTRY_SHAPE',
] as const;
export type EventHoldReason = (typeof EVENT_HOLD_REASONS)[number];

// ═══ رموز الأخطاء (ملحق ب) ═══

export const LEDGER_ERROR_HTTP = {
  ACCOUNTING_SUITE_NOT_ALLOWED: 403,
  LEDGER_PERMISSION_DENIED: 403,
  LEDGER_SCOPED_ADMIN: 403,
  LEDGER_NOT_SETUP: 409,
  LEDGER_UNBALANCED: 422,
  LEDGER_PERIOD_LOCKED: 422,
  LEDGER_CONTROL_ACCOUNT_MANUAL: 422,
  LEDGER_ACCOUNT_ARCHIVED: 422,
  LEDGER_ADJUSTMENT_BEFORE_CUTOVER: 422,
  LEDGER_ADJUSTMENT_EXCEEDS_BALANCE: 422,
  LEDGER_OFF_BALANCE_MIXED: 422,
  LEDGER_LOCK_DATE_BACKWARD: 422,
  LEDGER_DRAFTS_BEFORE_LOCK: 422,
  LEDGER_SECURED_MOVE: 409,
  LEDGER_MOVE_NOT_DRAFT: 409,
  LEDGER_MOVE_DOCUMENT_OWNED: 409,
  LEDGER_SOURCE_OWNED_MOVE: 409,
  LEDGER_SYNC_PENDING: 409,
  LEDGER_DUPLICATE_BILL: 409,
  LEDGER_RETENTION_ACTIVE: 409,
  LEDGER_HAS_POSTED_MOVES: 409,
  LEDGER_RESET_BLOCKED: 409,
  LEDGER_JOURNAL_HAS_POSTED_MOVES: 409,
  // إضافة M1 (خارج ملحق ب): رمز دفتر يساوي رمزاً قائماً أو بادئة مرتجعه (R+رمز) ⇒ تصادم @@unique([tenantId, number]) (G2)
  LEDGER_JOURNAL_CODE_CONFLICT: 409,
  LEDGER_REVERSAL_REASON_REQUIRED: 422,
  LEDGER_EXPORT_IN_PROGRESS: 409,
  LEDGER_NAME_ARABIC_REQUIRED: 422,
  LEDGER_PAYLINK_FEE_INVOICE_DATE_INVALID: 422,
  LEDGER_PAYLINK_FEE_INVOICE_DATE_LOCKED: 409,
  LEDGER_HISTORY_LOCKED: 409,
  LEDGER_VAT_LINE_UNTAGGED: 422,
  LEDGER_CUTOVER_MID_VAT_PERIOD: 422,
  LEDGER_CUTOVER_IN_FUTURE: 422,
  LEDGER_HISTORY_TOO_LARGE: 422,
  LEDGER_RANGE_TOO_LARGE: 422,
  LEDGER_EXPORT_TOO_LARGE: 422,
  LEDGER_ATTACHMENT_QUOTA: 413,
  // إضافة validate.ts (خارج ملحق ب): I5 بلا رمز في التصميم، وسطر بحساب لا يُحلّ
  LEDGER_PARTNER_REQUIRED: 422,
  LEDGER_ACCOUNT_NOT_FOUND: 422,
} as const;
export type LedgerErrorCode = keyof typeof LEDGER_ERROR_HTTP;

/** الرموز التي تُرمى من دوال M1 الصرفة (validate/locks/builders). */
export const M1_ERROR_CODES = [
  'LEDGER_UNBALANCED',
  'LEDGER_ACCOUNT_ARCHIVED',
  'LEDGER_CONTROL_ACCOUNT_MANUAL',
  'LEDGER_VAT_LINE_UNTAGGED',
  'LEDGER_OFF_BALANCE_MIXED',
  'LEDGER_PERIOD_LOCKED',
  'LEDGER_LOCK_DATE_BACKWARD',
  'LEDGER_SYNC_PENDING',
  'LEDGER_NOT_SETUP',
  'LEDGER_PARTNER_REQUIRED',
  'LEDGER_ACCOUNT_NOT_FOUND',
] as const satisfies readonly LedgerErrorCode[];
export type M1ErrorCode = (typeof M1_ERROR_CODES)[number];

/**
 * خطأ دفاتر صرف: رمز من ملحق ب وتفاصيل قابلة للتسلسل JSON.
 * لا يعرف Express — المسارات (M2+) تحوّله إلى {status: httpStatus, body: {code, ...details}}.
 */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: LedgerErrorCode, details: Record<string, unknown> = {}, message?: string) {
    super(message ?? code);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, LedgerError.prototype);
  }

  get httpStatus(): number {
    return LEDGER_ERROR_HTTP[this.code];
  }
}

export function isLedgerError(e: unknown, code?: LedgerErrorCode): e is LedgerError {
  return e instanceof LedgerError && (code === undefined || e.code === code);
}

// ═══ لقطات الصفوف كما يراها المحرك الصرف ═══

export interface AccountRef {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  isActive: boolean;
  reconcile: boolean;
  controlKind: ControlKind | null;
}

export interface TaxRef {
  id: string;
  key: string | null;
  name: string;
  use: TaxUse;
  rate: number;
  vatCategory: VatCategory;
  priceInclude: boolean;
  /** حساب الضريبة؛ للصفرية حساب سطر العلامة. null ⇒ OUTPUT_VAT/INPUT_VAT حسب use (§4.4). */
  accountId: string | null;
  rcOutputAccountId: string | null;
  deductible: boolean;
  vatBox: string | null;
  isActive: boolean;
}

export interface JournalRef {
  id: string;
  code: string;
  name: string;
  type: JournalType;
  systemKey: JournalSystemKey | null;
  defaultAccountId: string | null;
  suspenseAccountId: string | null;
  useOutstandingAccounts: boolean;
  sequenceReset: SequenceReset;
  isActive: boolean;
}

/** GlProductCategoryAccount (§3.8) — غياب الصف = مفاتيح الربط الافتراضية. */
export interface CategoryAccountsRef {
  incomeAccountId: string | null;
  expenseAccountId: string | null;
  cogsAccountId: string | null;
  inventoryAccountId: string | null;
}

/** إعدادات GlSettings التي تقرؤها الدوال الصرفة (§3.2) — التواريخ محلية. */
export interface GlSettingsSnapshot {
  templateKey: TemplateKey;
  countryCode: string;
  currency: string;
  currencyDecimals: number;
  timezone: string;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  /** 0=الأحد … 6=السبت */
  weekStartsOn: number;
  cutoverDate: LocalDate | null;
  inventoryMode: InventoryMode;
  perpetualFromDate: LocalDate | null;
  salesLockDate: LocalDate | null;
  purchaseLockDate: LocalDate | null;
  taxLockDate: LocalDate | null;
  hardLockDate: LocalDate | null;
  taxPeriodicity: TaxPeriodicity;
  taxDeadlineRule: TaxDeadlineRule;
  taxDeadlineDays: number | null;
  zeroRatedSalesTaxKey: string | null;
  postSalesDiscountSeparately: boolean;
  postReturnsToContra: boolean;
  receiptRouting: ReceiptRouting | null;
  cashInvoiceRouting: CashInvoiceRouting;
  /** D2: null ⇒ ضريبة العمولة غير مستردة؛ تاريخ ⇒ تُسترد لعمولة تاريخها المحلي ≥ هذا التاريخ. */
  paylinkFeeTaxInvoiceFrom: LocalDate | null;
  postPurchaseDiscountSeparately: boolean;
  billPricesIncludeTax: boolean;
  earlyDiscountAdjustsVat: boolean;
  taxRoundingMethod: 'PER_TAX' | 'PER_LINE';
  defaultPurchaseTaxId: string | null;
}

/** القيم الافتراضية من @default في §3.2 — للاختبارات والمعالج. */
export const DEFAULT_GL_SETTINGS: Readonly<GlSettingsSnapshot> = {
  templateKey: 'SA_6D',
  countryCode: 'SA',
  currency: 'SAR',
  currencyDecimals: 2,
  timezone: 'Asia/Riyadh',
  fiscalYearEndMonth: 12,
  fiscalYearEndDay: 31,
  weekStartsOn: 0,
  cutoverDate: null,
  inventoryMode: 'PERIODIC',
  perpetualFromDate: null,
  salesLockDate: null,
  purchaseLockDate: null,
  taxLockDate: null,
  hardLockDate: null,
  taxPeriodicity: 'QUARTERLY',
  taxDeadlineRule: 'END_OF_NEXT_MONTH',
  taxDeadlineDays: null,
  zeroRatedSalesTaxKey: 'Z_SALE',
  postSalesDiscountSeparately: true,
  postReturnsToContra: true,
  receiptRouting: null,
  cashInvoiceRouting: 'MAIN_CASH',
  paylinkFeeTaxInvoiceFrom: null,
  postPurchaseDiscountSeparately: false,
  billPricesIncludeTax: false,
  earlyDiscountAdjustsVat: true,
  taxRoundingMethod: 'PER_TAX',
  defaultPurchaseTaxId: null,
};

// ═══ مسودة القيد (مخرج الـbuilders ومدخل validate/post) ═══

export interface LineDraft {
  /** مصدر الحساب: واحد على الأقل من accountKey أو accountCode أو accountId (الأولوية: id ثم code ثم key). */
  accountKey?: MappingKey;
  accountCode?: string;
  accountId?: string;
  /** بالعربية دائماً (G7) */
  label: string;
  debitMilli: Milli;
  creditMilli: Milli;
  customerId?: string | null;
  vendorId?: string | null;
  salesRepId?: string | null;
  /** لقطة الاسم — إلزامية حين يوجد customerId أو vendorId أو salesRepId (G6 (ز)) */
  partnerName?: string | null;
  analyticAccountId?: string | null;
  productId?: string | null;
  quantity?: number | null;
  /** مفتاح الضريبة في القالب (S15_SALE…)؛ يُحلّ إلى taxId عبر ctx.taxes */
  taxCode?: string | null;
  taxId?: string | null;
  taxRole?: TaxRole | null;
  /** على TAX/MARKER: الوعاء بعد كل خصم (موقَّع، سالب في المرتجعات) */
  taxBaseMilli?: Milli | null;
  vatBox?: string | null;
  vatAdjustment?: boolean;
  dueDate?: LocalDate | null;
}

export interface MoveDraft {
  kind: 'MOVE';
  /** رمز الدفتر (INV، RCPT…) */
  journalCode: string;
  /** يُفضَّل في الحل على الرمز لأن الشركة قد تعدّل الرمز قبل أول ترحيل */
  journalSystemKey?: JournalSystemKey;
  /** بادئة التسلسل (INV، RINV، RCPT…) — sequence.ts */
  sequencePrefix?: string;
  moveType: MoveType;
  origin: MoveOrigin;
  /** التاريخ المحاسبي المحلي؛ الإزاحة ADR‑7 تُطبَّق لاحقاً في locks.ts */
  date: LocalDate;
  originalDate?: LocalDate | null;
  lateArrival?: boolean;
  ref?: string | null;
  /** بالعربية دائماً (G7) */
  narration: string;
  needsAttention: boolean;
  attentionReason?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  salesRepId?: string | null;
  sourceType?: SourceType | null;
  sourceId?: string | null;
  /** مفتاح GlMoveSource (INVOICE:<id>:POST …) */
  sourceKey?: string | null;
  sourceEvent?: SourceEvent | null;
  currencyCode: string;
  currencyDecimals: number;
  lines: LineDraft[];
}

export interface NoMove {
  kind: 'NO_MOVE';
  reason: SkipReason;
  note?: string;
}

export type BuildResult = MoveDraft | NoMove;

export function noMove(reason: SkipReason = 'ZERO_VALUE', note?: string): NoMove {
  return note === undefined ? { kind: 'NO_MOVE', reason } : { kind: 'NO_MOVE', reason, note };
}

export function isNoMove(r: BuildResult): r is NoMove {
  return r.kind === 'NO_MOVE';
}

// ═══ سياق البناء (§5.4: builder(data, mapping, taxes, settings)) ═══

export interface AccountResolver {
  byKey(key: MappingKey): AccountRef | null;
  byCode(code: string): AccountRef | null;
  byId(id: string): AccountRef | null;
}

export interface TaxResolver {
  byKey(key: string): TaxRef | null;
  byId(id: string): TaxRef | null;
  /** أول ضريبة نشطة بالاستخدام والنسبة (للنِّسب غير القالبية AUTO_SALE_<pct>، §4.4) */
  byUseAndRate(use: TaxUse, rate: number): TaxRef | null;
}

export interface JournalResolver {
  bySystemKey(key: JournalSystemKey): JournalRef | null;
  byCode(code: string): JournalRef | null;
}

export interface BuildContext {
  settings: GlSettingsSnapshot;
  accounts: AccountResolver;
  taxes: TaxResolver;
  journals: JournalResolver;
  /** GlProductCategoryAccount — null/غياب = الافتراضي */
  categoryAccounts(categoryId: string): CategoryAccountsRef | null;
  /** GlRepAnalyticDefault — null = بلا تحليلي */
  repAnalytic(salesRepId: string): string | null;
}

export interface BuildContextInput {
  settings?: Partial<GlSettingsSnapshot>;
  accounts: readonly AccountRef[];
  /** مفتاح الربط ← معرّف الحساب (GlAccountMapping) */
  mappings: Readonly<Partial<Record<MappingKey, string>>>;
  taxes?: readonly TaxRef[];
  journals?: readonly JournalRef[];
  categoryAccounts?: Readonly<Record<string, CategoryAccountsRef>>;
  repAnalytics?: Readonly<Record<string, string>>;
}

/** يبني سياقاً في الذاكرة من صفوف مقروءة مسبقاً — للمُرحِّل (M3) وللاختبارات. */
export function createBuildContext(input: BuildContextInput): BuildContext {
  const byId = new Map<string, AccountRef>();
  const byCode = new Map<string, AccountRef>();
  for (const a of input.accounts) {
    byId.set(a.id, a);
    byCode.set(a.code, a);
  }
  const taxes = input.taxes ?? [];
  const taxById = new Map<string, TaxRef>();
  const taxByKey = new Map<string, TaxRef>();
  for (const t of taxes) {
    taxById.set(t.id, t);
    if (t.key) taxByKey.set(t.key, t);
  }
  const journals = input.journals ?? [];
  const jByKey = new Map<string, JournalRef>();
  const jByCode = new Map<string, JournalRef>();
  for (const j of journals) {
    if (j.systemKey) jByKey.set(j.systemKey, j);
    jByCode.set(j.code, j);
  }
  return {
    settings: { ...DEFAULT_GL_SETTINGS, ...(input.settings ?? {}) },
    accounts: {
      byKey: (key) => {
        const id = input.mappings[key];
        return id ? byId.get(id) ?? null : null;
      },
      byCode: (code) => byCode.get(code) ?? null,
      byId: (id) => byId.get(id) ?? null,
    },
    taxes: {
      byKey: (key) => taxByKey.get(key) ?? null,
      byId: (id) => taxById.get(id) ?? null,
      byUseAndRate: (use, rate) => taxes.find((t) => t.isActive && t.use === use && t.rate === rate) ?? null,
    },
    journals: {
      bySystemKey: (key) => jByKey.get(key) ?? null,
      byCode: (code) => jByCode.get(code) ?? null,
    },
    categoryAccounts: (categoryId) => input.categoryAccounts?.[categoryId] ?? null,
    repAnalytic: (salesRepId) => input.repAnalytics?.[salesRepId] ?? null,
  };
}
