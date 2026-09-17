import api from './client';
import type {
  AccountType, BackfillState, ControlKind, LedgerEnvelope, LocalDate, ReceiptMethod, SeedAccountRefConflict, SeedCounts,
  SeedMappingConflict, TaxPeriodicity,
} from './ledgerConfig';

/**
 * عميل معالج الإعداد والقيد الافتتاحي والترحيل التاريخي — `/api/ledger/setup*` (M3، §5.6، §8.4 القسم 2)،
 * وتبويب «فئات المنتجات» `/api/ledger/mappings/categories` (CFG‑03، §8.2).
 *
 * الأشكال مرآة `backend/src/routes/ledger/setup.ts` و`services/gl/{opening,backfill}.ts` و`config.ts categoryAccountsOut`.
 * مبالغ المعاينة والاعتماد **نصوص** `formatMilli` بمنازل العملة (لا أرقام) — تُعرض عبر LedgerAmount.
 * الصلاحية canConfigureLedger لكل النقاط.
 */

// ═══ المسودة (GlSettings.setupDraft) ═══

export type SetupMethod = 'OPENING' | 'FULL_HISTORY';
export type CashInvoiceRouting = 'MAIN_CASH' | 'CUSTODY';
export type ReceiptRouteTarget = 'CUSTODY' | 'DIRECT';

export interface SetupStep1 {
  timezone?: string;
  fiscalYearEndMonth?: number;
  fiscalYearEndDay?: number;
  weekStartsOn?: number;
  taxPeriodicity?: TaxPeriodicity;
  cutoverDate?: LocalDate;
  confirmMidVatPeriod?: boolean;
  /** مبالغ المربعات قبل البدء للإقرار الأول (preCutoverBoxesJson، §6.6) — المفتاح `SA_<n>.amount|tax` */
  preCutoverBoxes?: Record<string, number | string> | null;
}

export interface SetupStep3 {
  accountNames?: { code: string; name: string }[];
  categoryIncomeAccounts?: { categoryId: string; accountCode: string }[];
  receiptRouting?: Partial<Record<ReceiptMethod, ReceiptRouteTarget>> | null;
  cashInvoiceRouting?: CashInvoiceRouting;
}

/** صف رصيد يدوي (الخطوة 5) — `ManualBalanceRowInput` في services/gl/opening.ts */
export interface ManualBalanceRowInput {
  accountCode: string;
  debit?: number | string | null;
  credit?: number | string | null;
  vendorId?: string | null;
  vendorName?: string | null;
  dueDate?: LocalDate | null;
  salesRepId?: string | null;
  label?: string | null;
}

export interface SetupDraft {
  currentStep?: number;
  step1?: SetupStep1;
  step2?: { method: SetupMethod };
  step3?: SetupStep3;
  step5?: { rows: ManualBalanceRowInput[] };
}

/** أسباب رفض الصف (MANUAL_BALANCE_ISSUES — الثوابت الصرفة في pages/ledger/setup/setupLogic.ts) */
export interface ManualBalanceIssue { index: number; accountCode: string; reason: string }

// ═══ الحالة ═══

export interface SetupStatus {
  seeded: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
  backfillState: BackfillState;
  setupMethod: SetupMethod | null;
  cutoverDate: LocalDate | null;
  openingSnapshotAt: string | null;
  templateKey: string | null;
  countryCode: string | null;
  currency: string | null;
  currencyDecimals: number | null;
  timezone: string | null;
  inventoryMode: 'PERIODIC' | 'PERPETUAL';
  cashInvoiceRouting: CashInvoiceRouting;
  receiptRouting: Partial<Record<ReceiptMethod, ReceiptRouteTarget>> | null;
}

export interface SetupEffective {
  templateKey: 'SA_6D' | 'GENERIC_6D';
  countryCode: string;
  timezone: string;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  weekStartsOn: number;
  taxPeriodicity: TaxPeriodicity;
  method: SetupMethod;
  cutoverDate: LocalDate | null;
  confirmMidVatPeriod: boolean;
  preCutoverBoxes: Record<string, unknown> | null;
}

export interface HistoryEstimate {
  rows: number;
  estimatedEvents: number;
  estimatedMinutes: number;
  maxRows: number;
  tooLarge: boolean;
  oldestEffectAt?: string | null;
  fullHistoryCutoverDate: LocalDate | null;
}

export interface DraftsBeforeCutover { count: number; listUrl: string }

export type SyncSource = 'ACCOUNT_ENTRY' | 'REP_SETTLEMENT' | 'SETTLEMENT_ENTRY' | 'WAREHOUSE_ENTRY' | 'VAN_LOAD' | 'RETURN_RESTOCK';

export interface BackfillProgress {
  state: BackfillState;
  caughtUp: boolean;
  nextState: BackfillState;
  sources: { source: SyncSource | string; watermarkAt: string; lastRunAt: string | null; lagMs: number; caughtUp: boolean; stallTicks: number }[];
  pendingEvents: number;
  openEvents: number;
  doneEvents: number;
  etaMinutes: number | null;
}

export interface SetupStateBefore {
  activated: false;
  status: SetupStatus;
  draft: SetupDraft;
  effective: SetupEffective;
  company: { countryCode: string; currency: string | null };
  today: LocalDate;
  suggestedCutoverDate: LocalDate;
  history: HistoryEstimate;
  draftsBeforeCutover: DraftsBeforeCutover | null;
  progress: null;
}

export interface SetupStateAfter {
  activated: true;
  status: SetupStatus;
  progress: BackfillProgress | null;
}

export type SetupState = SetupStateBefore | SetupStateAfter;

// ═══ المعاينة والاعتماد ═══

export interface OpeningReceivableJson { customerId: string; customerName: string | null; balance: string; rows: number }
export interface OpeningCustodyJson {
  salesRepId: string;
  salesRepName: string | null;
  ledgerCustody: string;
  onlineUncleared: string;
  nonCustodyCleared: string;
  suspenseCleared: string;
  cashSalesOutsideCustody: string;
  opsOutstanding: string;
}
export interface DerivedOpeningJson {
  cutoverDate: LocalDate;
  openingDate: LocalDate;
  snapshotAt: string;
  receivables: OpeningReceivableJson[];
  receivablesTotal: string;
  custody: OpeningCustodyJson[];
  custodyTotal: string;
  paylinkHeld: string;
  warehouse: { value: string; uncostedQty: number | string; uncostedProducts: number };
  counts: Record<string, number>;
}
export interface OpeningMoveJson { equityDiff: string; totalDebit: string; manualDebit: string; manualCredit: string; lineCount: number }

export interface OpeningPreview {
  preview: true;
  method: SetupMethod;
  midVatPeriod: boolean;
  opening: DerivedOpeningJson;
  manual: { lineCount: number; issues: ManualBalanceIssue[] };
  move: OpeningMoveJson;
  draftsBeforeCutover: DraftsBeforeCutover | null;
}

export interface SetupCommitResult {
  status: SetupStatus;
  opening: DerivedOpeningJson;
  move: OpeningMoveJson & { id: string | null; number: string | null; date: LocalDate };
  watermarkAt: string;
  futureDated: { accountEntries: number; repSettlements: number; eventsInserted: number } | null;
  seed: {
    created: SeedCounts;
    skipped: SeedCounts;
    unresolvedMappings: string[];
    conflictingMappings: SeedMappingConflict[];
    conflictingAccountRefs: SeedAccountRefConflict[];
  };
  vendorsCreated: number;
}

// ═══ فئات المنتجات (CFG‑03) ═══

export type CategoryAccountField = 'incomeAccountId' | 'expenseAccountId' | 'cogsAccountId' | 'inventoryAccountId';
export const CATEGORY_ACCOUNT_FIELDS: readonly CategoryAccountField[] = ['incomeAccountId', 'expenseAccountId', 'cogsAccountId', 'inventoryAccountId'];

export type CategoryAccountRow = {
  categoryId: string;
  categoryName: string;
  productCount: number;
  /** للفئة صف GlProductCategoryAccount */
  customized: boolean;
} & Record<CategoryAccountField, string | null>;

export interface CategoryAccountFieldRule {
  field: CategoryAccountField;
  /** مفتاح الربط الاحتياطي حين الحقل فارغ (§3.8: غياب الصف = الافتراضي) */
  fallbackKey: string;
  fallbackAccountId: string | null;
  allowedTypes: AccountType[];
  controlKind: ControlKind | null;
}

export interface CategoryAccountsOut { categories: CategoryAccountRow[]; fields: CategoryAccountFieldRule[] }

/** سطر PUT: الحقل الغائب يبقى، وnull يعيد الافتراضي، والحقول الأربعة فارغة ⇒ حذف الصف */
export type CategoryAccountPatch = { categoryId: string } & Partial<Record<CategoryAccountField, string | null>>;

// ═══ النقاط ═══

const L = '/ledger';

export const ledgerSetupApi = {
  get: () => api.get<LedgerEnvelope<SetupState>>(`${L}/setup`),
  /** حفظ مسودة خطوة (دمج بالأقسام؛ step1 حقلاً بحقل) — 422 LEDGER_CUTOVER_IN_FUTURE / MID_VAT_PERIOD / HISTORY_TOO_LARGE */
  saveDraft: (draft: SetupDraft) =>
    api.post<LedgerEnvelope<{ draft: SetupDraft; effective: SetupEffective; history: HistoryEstimate | null }>>(`${L}/setup/draft`, draft),
  /** معاينة إرشادية بلا أي كتابة (الخطوة 4) */
  previewOpening: (draft?: SetupDraft) => api.post<LedgerEnvelope<OpeningPreview>>(`${L}/setup/preview-opening`, draft ?? {}),
  /** التفعيل: معاملة واحدة (60 ثانية) — الأرقام النهائية الملتزمة في الرد */
  commit: (draft?: SetupDraft) =>
    api.post<LedgerEnvelope<SetupCommitResult>>(`${L}/setup/commit`, { acknowledgeStatutory: true, ...(draft ? { draft } : {}) }, { timeout: 90_000 }),
  /** «إيقاف مؤقت» / «استئناف» الترحيل التاريخي */
  backfill: (action: 'PAUSE' | 'RESUME') => api.post<LedgerEnvelope<{ backfillState: BackfillState }>>(`${L}/setup/backfill`, { action }),

  categories: {
    list: () => api.get<LedgerEnvelope<CategoryAccountsOut>>(`${L}/mappings/categories`),
    update: (categories: CategoryAccountPatch[]) => api.put<LedgerEnvelope<CategoryAccountsOut>>(`${L}/mappings/categories`, { categories }),
  },
};

export const ledgerSetupKeys = {
  setup: ['ledger', 'setup'] as const,
  categories: ['ledger', 'mappings', 'categories'] as const,
  /** نتيجة التفعيل في الذاكرة فقط (setQueryData) — خارج بادئة 'ledger' فلا يمسّها تصفير الدفاتر */
  commitResult: ['ledger-setup-commit-result'] as const,
};
