import api from './client';
import { collectPages } from '../lib/ledger/pages';

/**
 * عميل تهيئة الدفاتر — `/api/ledger/*` (ملحق أ، M2): الحالة، الحسابات، الدفاتر، الضرائب،
 * الربط، الإعدادات، السنوات المالية، الوسوم، تواريخ الإقفال.
 *
 * الأشكال من §3.2 وملحق أ. المبالغ في المخرجات **أرقام** عبر `serializeMoney` (§3.9)،
 * والتواريخ المحاسبية نصوص `YYYY-MM-DD`. الأخطاء `{success:false, code, message, ...details}` (ملحق ب).
 */

// ═══ الغلاف المشترك ═══

export interface LedgerEnvelope<T> {
  success: boolean;
  data: T;
  pagination?: LedgerPagination;
  message?: string;
}

export interface LedgerPagination {
  total: number;
  offset: number;
  limit: number;
}

/** جسم خطأ الدفاتر (ملحق ب) — `code` من LEDGER_ERROR_HTTP وتفاصيله منشورة بجانبه. */
export interface LedgerErrorBody {
  success: false;
  code?: LedgerErrorCode | string;
  message?: string;
  /** قيود التحرير بلا رمز في ملحق ب (LedgerHttpError) تحمل سببها هنا: CODE_EXISTS، MAPPED، TAX_IN_USE… */
  reason?: string;
  /** التفاصيل كاملة (ومنها `code` المحجوز مثل رمز الدفتر في LEDGER_JOURNAL_CODE_CONFLICT) */
  details?: Record<string, unknown>;
  [detail: string]: unknown;
}

export type LedgerErrorCode =
  | 'ACCOUNTING_SUITE_NOT_ALLOWED' | 'LEDGER_PERMISSION_DENIED' | 'LEDGER_SCOPED_ADMIN'
  | 'LEDGER_NOT_SETUP' | 'LEDGER_UNBALANCED' | 'LEDGER_PERIOD_LOCKED' | 'LEDGER_CONTROL_ACCOUNT_MANUAL'
  | 'LEDGER_ACCOUNT_ARCHIVED' | 'LEDGER_ACCOUNT_NOT_FOUND' | 'LEDGER_PARTNER_REQUIRED' | 'LEDGER_OFF_BALANCE_MIXED'
  | 'LEDGER_LOCK_DATE_BACKWARD' | 'LEDGER_DRAFTS_BEFORE_LOCK' | 'LEDGER_SECURED_MOVE' | 'LEDGER_MOVE_NOT_DRAFT'
  | 'LEDGER_MOVE_DOCUMENT_OWNED' | 'LEDGER_SOURCE_OWNED_MOVE' | 'LEDGER_SYNC_PENDING' | 'LEDGER_JOURNAL_HAS_POSTED_MOVES'
  | 'LEDGER_JOURNAL_CODE_CONFLICT' | 'LEDGER_REVERSAL_REASON_REQUIRED' | 'LEDGER_NAME_ARABIC_REQUIRED'
  | 'LEDGER_VAT_LINE_UNTAGGED' | 'LEDGER_EXPORT_TOO_LARGE' | 'LEDGER_ATTACHMENT_QUOTA';

/** يستخرج جسم خطأ الدفاتر من خطأ axios (أو null). */
export function ledgerErrorOf(err: unknown): (LedgerErrorBody & { status?: number }) | null {
  const r = (err as { response?: { status?: number; data?: unknown } })?.response;
  if (!r || !r.data || typeof r.data !== 'object') return null;
  return { ...(r.data as LedgerErrorBody), status: r.status };
}

/** 403 بسبب النطاق أو الصلاحية يُعرض إشعاراً واضحاً لا خطأً عاماً (§8.1). */
export function isLedgerAccessError(err: unknown): boolean {
  const code = ledgerErrorOf(err)?.code;
  return code === 'LEDGER_SCOPED_ADMIN' || code === 'LEDGER_PERMISSION_DENIED' || code === 'ACCOUNTING_SUITE_NOT_ALLOWED';
}

type Q = Record<string, string | number | boolean | undefined | null>;
const clean = (q?: Q) => (q ? Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')) : undefined);

// ═══ الأنواع (§3.2) ═══

export type LocalDate = string;
export type I18nNames = Partial<Record<'ar' | 'en' | 'fr' | 'tr' | 'zh', string>>;

export type AccountType =
  | 'asset_cash' | 'asset_receivable' | 'asset_current' | 'asset_prepayments' | 'asset_fixed' | 'asset_non_current'
  | 'liability_payable' | 'liability_credit_card' | 'liability_current' | 'liability_non_current'
  | 'equity' | 'equity_unaffected' | 'income' | 'income_other'
  | 'expense_direct_cost' | 'expense' | 'expense_depreciation' | 'expense_other' | 'expense_zakat' | 'off_balance';

export type ControlKind = 'AR' | 'AP' | 'CUSTODY' | 'PAYLINK' | 'INVENTORY' | 'VAT_OUT' | 'VAT_IN' | 'SUSPENSE';
export type CashFlowTag = 'OPERATING' | 'INVESTING' | 'FINANCING' | 'EXCLUDE' | 'CASH_EQUIVALENT';
export type JournalType = 'SALE' | 'PURCHASE' | 'CASH' | 'BANK' | 'GENERAL';
export type SequenceReset = 'MONTHLY' | 'YEARLY';
export type TaxUse = 'SALE' | 'PURCHASE' | 'NONE';
export type VatCategory = 'S' | 'Z' | 'E' | 'O';
export type BackfillState = 'NONE' | 'RUNNING' | 'DONE' | 'PAUSED';

export interface LedgerStatus {
  tenantId: string;
  suiteEnabled: boolean;
  activatedAt: string | null;
  setupRequired: boolean;
  /** صف GlSettings موجود (زُرع القالب) */
  seeded?: boolean;
  backfillState?: BackfillState;
  templateKey?: string | null;
  countryCode?: string | null;
  currency?: string | null;
  currencyDecimals?: number | null;
  cutoverDate?: LocalDate | null;
  setupMethod?: string | null;
  timezone?: string | null;
  lastSyncAt?: string | null;
}

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  nameEn: string | null;
  nameI18n: I18nNames | null;
  description: string | null;
  type: AccountType;
  reconcile: boolean;
  isActive: boolean;
  isSystem: boolean;
  controlKind: ControlKind | null;
  currencyCode: string | null;
  cashFlowTag: CashFlowTag | null;
  templateRef: string | null;
  tagIds?: string[];
  /** رصيد مرحَّل (اختياري في القائمة) */
  balance?: number;
  hasMoves?: boolean;
  /** GET /accounts/:id وحده: مفاتيح الربط المشيرة إليه */
  mappingKeys?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** عقدة شجرة بادئات الرموز (COA‑05) — ثلاثة مستويات، والأول بأسماء مجموعة القالب. */
export interface GlAccountTreeNode {
  prefix: string;
  count: number;
  names?: I18nNames;
  children: GlAccountTreeNode[];
}

export interface GlAccountInput {
  code: string;
  name: string;
  nameEn?: string | null;
  description?: string | null;
  type: AccountType;
  reconcile?: boolean;
  cashFlowTag?: CashFlowTag | null;
  currencyCode?: string | null;
  tagIds?: string[];
}

export interface AccountListParams extends Q {
  search?: string;
  type?: string;
  /** debit|credit|equity|asset|liability|income|expense|hasMoves|archived|custom — COA‑06 */
  filter?: string;
  groupBy?: 'type';
  includeArchived?: boolean;
  /** بادئة الرمز من شجرة البادئات */
  prefix?: string;
  offset?: number;
  limit?: number;
}

/** رد GET /accounts: مع groupBy=type يحمل عدّاد كل نوع على الفلاتر كلها. */
export type GlAccountListEnvelope = LedgerEnvelope<GlAccount[]> & { groups?: { type: AccountType; count: number }[] };

export interface AccountImportRow { code: string; name: string; nameEn?: string | null; type: AccountType; reconcile?: boolean }
export type AccountImportSkipReason = 'EXISTS' | 'DUPLICATE_IN_FILE' | 'RECONCILE_CASH' | 'EQUITY_UNAFFECTED';
export interface AccountImportResult { created: number; skipped: { code: string; reason: AccountImportSkipReason | string }[]; dryRun: boolean }

export interface GlJournal {
  id: string;
  code: string;
  name: string;
  nameEn: string | null;
  nameI18n: I18nNames | null;
  type: JournalType;
  systemKey: string | null;
  defaultAccountId: string | null;
  suspenseAccountId: string | null;
  useOutstandingAccounts: boolean;
  sequenceReset: SequenceReset;
  showOnDashboard: boolean;
  color: number;
  bankName: string | null;
  ibanMasked: string | null;
  isActive: boolean;
  isSystem: boolean;
  /** للدفتر قيد مرحَّل ⇒ code وsequenceReset مقفلان (G2) */
  hasPostedMoves?: boolean;
}

export type GlJournalInput = Partial<Pick<GlJournal,
  'code' | 'name' | 'nameEn' | 'type' | 'defaultAccountId' | 'suspenseAccountId' | 'useOutstandingAccounts'
  | 'sequenceReset' | 'showOnDashboard' | 'color' | 'bankName' | 'isActive'>> & { iban?: string | null };

export interface GlTax {
  id: string;
  key: string | null;
  name: string;
  nameEn: string | null;
  nameI18n: I18nNames | null;
  groupId: string | null;
  use: TaxUse;
  rate: number;
  vatCategory: VatCategory;
  priceInclude: boolean;
  accountId: string | null;
  rcOutputAccountId: string | null;
  deductible: boolean;
  vatBox: string | null;
  isActive: boolean;
  isSystem: boolean;
}

export type GlTaxInput = Partial<Pick<GlTax,
  'name' | 'nameEn' | 'use' | 'rate' | 'vatCategory' | 'priceInclude' | 'accountId' | 'rcOutputAccountId'
  | 'deductible' | 'vatBox' | 'isActive'>>;

export interface GlAccountMapping {
  key: string;
  accountId: string | null;
  account?: Pick<GlAccount, 'id' | 'code' | 'name' | 'nameEn' | 'nameI18n' | 'type' | 'isActive' | 'controlKind'> | null;
  updatedAt?: string | null;
  /** GET وحده: الأنواع المقبولة لحساب المفتاح (الأول نوع حساب القالب) */
  allowedTypes?: AccountType[];
  /** GET وحده: المفتاح يتطلب حساباً رئيسياً من هذا النوع */
  controlKind?: ControlKind | null;
}

export type TaxPeriodicity = 'MONTHLY' | 'BIMONTHLY' | 'QUARTERLY' | 'FOUR_MONTHS' | 'SEMIANNUAL' | 'ANNUAL' | 'FISCAL_YEAR';
export type ReceiptMethod = 'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE';
export const RECEIPT_METHODS: readonly ReceiptMethod[] = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'];

export interface GlSettings {
  id?: string;
  tenantId?: string;
  templateKey: 'SA_6D' | 'GENERIC_6D' | string;
  countryCode: string;
  currency: string;
  currencyDecimals: number;
  timezone: string;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  weekStartsOn: number;
  setupMethod: string | null;
  cutoverDate: LocalDate | null;
  activatedAt: string | null;
  backfillState: BackfillState;
  inventoryMode: 'PERIODIC' | 'PERPETUAL';
  perpetualFromDate: LocalDate | null;
  salesLockDate: LocalDate | null;
  purchaseLockDate: LocalDate | null;
  taxLockDate: LocalDate | null;
  hardLockDate: LocalDate | null;
  taxPeriodicity: TaxPeriodicity;
  taxDeadlineRule: 'END_OF_NEXT_MONTH' | 'DAYS_AFTER';
  taxDeadlineDays: number | null;
  taxClosingJournalId: string | null;
  cashBasisEnabled: boolean;
  defaultPurchaseTaxId: string | null;
  taxRoundingMethod: 'PER_TAX' | 'PER_LINE';
  zeroRatedSalesTaxKey: string | null;
  billPricesIncludeTax: boolean;
  billPredictionEnabled: boolean;
  postPurchaseDiscountSeparately: boolean;
  earlyDiscountAdjustsVat: boolean;
  postSalesDiscountSeparately: boolean;
  postReturnsToContra: boolean;
  receiptRouting: Partial<Record<ReceiptMethod, 'CUSTODY' | 'DIRECT'>> | null;
  cashInvoiceRouting: 'MAIN_CASH' | 'CUSTODY';
  paylinkFeeTaxInvoiceFrom: LocalDate | null;
  autoValidateBills: boolean;
  batchPaymentsEnabled: boolean;
  deferralJournalId: string | null;
  deferralGenerate: 'ON_VALIDATION' | 'MANUAL';
  deferralMethod: 'BY_MONTHS' | 'BY_DAYS';
  drawingsAfterNetProfit: boolean;
  depreciationInOperatingExpenses: boolean;
  lastSyncAt?: string | null;
  openingSnapshotAt?: string | null;
  activatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** تقرير زرع القالب (services/gl/seed.ts SeedReport) — المُنشأ والمتخطّى لكل جدول. */
export interface SeedCounts { accounts: number; tags: number; tagLinks: number; journals: number; taxes: number; mappings: number; settings: number }
/** مفتاح ربط لم يُنشأ: الحساب القائم برمز القالب يخالف نوع المفتاح أو حسابه الرئيسي (قاعدة PUT /mappings). */
export interface SeedMappingConflict {
  key: string;
  accountId: string;
  code: string;
  type: string;
  controlKind: string | null;
  reason: 'MAPPING_TYPE_MISMATCH' | 'MAPPING_CONTROL_KIND';
}
/** مرجع حساب ضريبة أو دفتر تُرك فارغاً: الحساب القائم بالرمز يخالف نوع حساب القالب أو controlKind. */
export interface SeedAccountRefConflict {
  entity: 'TAX' | 'JOURNAL';
  /** مفتاح الضريبة أو رمز الدفتر */
  ref: string;
  field: 'accountId' | 'rcOutputAccountId' | 'defaultAccountId' | 'suspenseAccountId';
  accountId: string;
  code: string;
  type: string;
  controlKind: string | null;
}
export interface SeedReport {
  templateKey: string;
  created: SeedCounts;
  skipped: SeedCounts;
  /** مفاتيح ربط لم يُعثر على حسابها */
  unresolvedMappings: string[];
  conflictingMappings: SeedMappingConflict[];
  conflictingAccountRefs: SeedAccountRefConflict[];
}

/** الحقول القابلة للتعديل من صفحة الإعدادات (§8.4)؛ المجمّد (العملة والقالب) والمملوك للمالك (paylinkFeeTaxInvoiceFrom) خارجها. */
export type GlSettingsInput = Partial<Omit<GlSettings,
  'templateKey' | 'countryCode' | 'currency' | 'currencyDecimals' | 'activatedAt' | 'backfillState' | 'setupMethod'
  | 'cutoverDate' | 'paylinkFeeTaxInvoiceFrom' | 'salesLockDate' | 'purchaseLockDate' | 'taxLockDate' | 'hardLockDate' | 'lastSyncAt'
  | 'id' | 'tenantId' | 'openingSnapshotAt' | 'activatedBy' | 'createdAt' | 'updatedAt' | 'cashBasisEnabled'>> & {
  /** الأساس النقدي مؤجَّل: الخادم يقبل false وحدها (TAX‑08) */
  cashBasisEnabled?: false;
};

export interface GlFiscalYear {
  id: string;
  name: string;
  dateFrom: LocalDate;
  dateTo: LocalDate;
  state: 'OPEN' | 'CLOSED';
  closingMoveId: string | null;
  closedAt: string | null;
  closedBy: string | null;
}
export type GlFiscalYearInput = Pick<GlFiscalYear, 'name' | 'dateFrom' | 'dateTo'>;

export interface GlAccountTag {
  id: string;
  name: string;
  nameEn: string | null;
  applicability: 'ACCOUNTS' | 'REPORTS' | string;
  accountCount?: number;
}
export type GlAccountTagInput = Partial<Pick<GlAccountTag, 'name' | 'nameEn' | 'applicability'>>;

// ═══ تواريخ الإقفال (§2.5، LOCK‑01) ═══

export interface LockDates {
  salesLockDate: LocalDate | null;
  purchaseLockDate: LocalDate | null;
  taxLockDate: LocalDate | null;
  hardLockDate: LocalDate | null;
}
export type LockDateField = keyof LockDates;
export const LOCK_DATE_FIELDS: readonly LockDateField[] = ['salesLockDate', 'purchaseLockDate', 'taxLockDate', 'hardLockDate'];

/** رد GET /lock-dates */
export interface LockDatesState extends LockDates {
  today?: LocalDate;
  timezone?: string | null;
  activatedAt?: string | null;
  backfillState?: BackfillState;
  setupRequired?: boolean;
}

/** تفاصيل 409 LEDGER_SYNC_PENDING / LEDGER_NOT_SETUP — شكل `LockSyncBlockers` في services/gl/locks.ts */
export interface LockSyncBlockers {
  code: 'LEDGER_NOT_SETUP' | 'LEDGER_SYNC_PENDING';
  backfillState: BackfillState;
  laggingSources: { source: string; watermarkAt: string | null; lastRunAt: string | null }[];
  events: { id: string; sourceKey: string; status: string; effectAt: string; lastError: string | null }[];
  eventCount: number;
}

/** تفاصيل 422 LEDGER_DRAFTS_BEFORE_LOCK — شكل `DraftsBeforeLock` (+ صفوف المسودات إن أُرسلت) */
export interface DraftsBeforeLockBody {
  ids: string[];
  count: number;
  listUrl: string;
  drafts?: { id: string; date: LocalDate; ref?: string | null; journalCode?: string | null; total?: number }[];
}

/** رد POST /sync (ManualSyncResponse في services/gl/sync/types.ts) */
export type LedgerSyncResult =
  | { running: true; pendingEvents: number; retryAfterSeconds?: number }
  | { running: false; pendingEvents: number; result?: Record<string, unknown> };

// ═══ النقاط ═══

const L = '/ledger';

export const ledgerConfigApi = {
  status: () => api.get<LedgerEnvelope<LedgerStatus>>(`${L}/status`),

  accounts: {
    list: (params?: AccountListParams) => api.get<GlAccountListEnvelope>(`${L}/accounts`, { params: clean(params) }),
    /** شجرة بادئات الرموز (COA‑05) */
    tree: (includeArchived?: boolean) => api.get<LedgerEnvelope<GlAccountTreeNode[]>>(`${L}/accounts/tree`, { params: clean({ includeArchived }) }),
    get: (id: string) => api.get<LedgerEnvelope<GlAccount>>(`${L}/accounts/${id}`),
    create: (data: GlAccountInput) => api.post<LedgerEnvelope<GlAccount>>(`${L}/accounts`, data),
    update: (id: string, data: Partial<GlAccountInput>) => api.put<LedgerEnvelope<GlAccount>>(`${L}/accounts/${id}`, data),
    archive: (id: string, archived = true) => api.post<LedgerEnvelope<GlAccount>>(`${L}/accounts/${id}/archive`, { archived }),
    /** ≤ 5000 صف؛ `dryRun` يعيد المُنشأ والمتخطّى دون كتابة (معاينة COA‑07) */
    import: (rows: AccountImportRow[], dryRun = false) => api.post<LedgerEnvelope<AccountImportResult>>(`${L}/accounts/import`, { rows, ...(dryRun ? { dryRun: true } : {}) }),
  },

  journals: {
    /** canConfigureLedger؛ المؤرشف مشمول افتراضياً (includeArchived=false لاستبعاده) */
    list: (params?: { includeArchived?: boolean }) => api.get<LedgerEnvelope<GlJournal[]>>(`${L}/journals`, { params: clean(params) }),
    create: (data: GlJournalInput) => api.post<LedgerEnvelope<GlJournal>>(`${L}/journals`, data),
    update: (id: string, data: GlJournalInput) => api.put<LedgerEnvelope<GlJournal>>(`${L}/journals/${id}`, data),
  },

  taxes: {
    /** canConfigureLedger؛ المؤرشف مشمول افتراضياً */
    list: (params?: { use?: TaxUse; includeArchived?: boolean }) => api.get<LedgerEnvelope<GlTax[]>>(`${L}/taxes`, { params: clean(params) }),
    create: (data: GlTaxInput) => api.post<LedgerEnvelope<GlTax>>(`${L}/taxes`, data),
    update: (id: string, data: GlTaxInput) => api.put<LedgerEnvelope<GlTax>>(`${L}/taxes/${id}`, data),
  },

  mappings: {
    list: () => api.get<LedgerEnvelope<GlAccountMapping[]>>(`${L}/mappings`),
    update: (mappings: { key: string; accountId: string }[]) => api.put<LedgerEnvelope<GlAccountMapping[]>>(`${L}/mappings`, { mappings }),
  },

  settings: {
    get: () => api.get<LedgerEnvelope<GlSettings | null>>(`${L}/settings`),
    update: (data: GlSettingsInput) => api.put<LedgerEnvelope<GlSettings>>(`${L}/settings`, data),
    /** «تحميل القالب/إعادة تحميله» (TAX‑01): يضيف الناقص فقط ولا يعدّل الموجود */
    loadTemplate: () => api.post<LedgerEnvelope<{ report: SeedReport; settings: GlSettings | null }>>(`${L}/settings/load-template`),
  },

  fiscalYears: {
    list: () => api.get<LedgerEnvelope<GlFiscalYear[]>>(`${L}/fiscal-years`),
    create: (data: GlFiscalYearInput) => api.post<LedgerEnvelope<GlFiscalYear>>(`${L}/fiscal-years`, data),
    update: (id: string, data: Partial<GlFiscalYearInput>) => api.put<LedgerEnvelope<GlFiscalYear>>(`${L}/fiscal-years/${id}`, data),
  },

  tags: {
    list: () => api.get<LedgerEnvelope<GlAccountTag[]>>(`${L}/tags`),
    create: (data: GlAccountTagInput) => api.post<LedgerEnvelope<GlAccountTag>>(`${L}/tags`, data),
    update: (id: string, data: GlAccountTagInput) => api.put<LedgerEnvelope<GlAccountTag>>(`${L}/tags/${id}`, data),
  },

  /**
   * «مزامنة الآن» (§5.1، M3، canViewLedger): نبضة 2 ثانية عبر عقد الإيجار، مرة كل 60 ثانية لكل شركة.
   * 202 `{running: true, pendingEvents, retryAfterSeconds?}` حين تجري نبضة أخرى أو قبل مرور الحد، و200 بالنتيجة.
   */
  sync: () => api.post<LedgerEnvelope<LedgerSyncResult> & { running: boolean; pendingEvents: number }>(`${L}/sync`, {}),

  lockDates: {
    get: () => api.get<LedgerEnvelope<LockDatesState>>(`${L}/lock-dates`),
    update: (data: Partial<LockDates>) => api.put<LedgerEnvelope<LockDates & { changed?: LockDateField[] }>>(`${L}/lock-dates`, data),
  },
};

/** كل حسابات الشركة بالمؤرشف بصفحات من 1000 (سقف 20,000) — لمنتقيات نموذج القيد والتهيئة تحت ledgerKeys.allAccounts. */
export async function fetchAllLedgerAccounts(): Promise<GlAccount[]> {
  return collectPages(async (offset, limit) => {
    const r = (await ledgerConfigApi.accounts.list({ includeArchived: true, limit, offset })).data;
    return { rows: r.data, total: r.pagination?.total ?? null };
  });
}

/** مفاتيح react-query الموحّدة للتهيئة — لتصفير الذاكرة بعد الكتابة من أي صفحة. */
export const ledgerKeys = {
  all: ['ledger'] as const,
  status: ['ledger', 'status'] as const,
  accounts: (params?: unknown) => ['ledger', 'accounts', params ?? {}] as const,
  /** كل الحسابات بالمؤرشف — جالبه الوحيد fetchAllLedgerAccounts (حارس pages.test) */
  allAccounts: ['ledger', 'accounts', 'all-pages'] as const,
  accountTree: ['ledger', 'accounts-tree'] as const,
  account: (id: string) => ['ledger', 'account', id] as const,
  journals: ['ledger', 'journals'] as const,
  taxes: ['ledger', 'taxes'] as const,
  mappings: ['ledger', 'mappings'] as const,
  settings: ['ledger', 'settings'] as const,
  fiscalYears: ['ledger', 'fiscal-years'] as const,
  tags: ['ledger', 'tags'] as const,
  lockDates: ['ledger', 'lock-dates'] as const,
};
