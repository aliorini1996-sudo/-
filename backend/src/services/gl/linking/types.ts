/**
 * عقود «ربط الدفاتر بكامل النظام» L2 (المعاينة والـpreflight والمطابقة) — العقد المُلزِم: scratchpad/l23_contract.md §9.
 * هذا الملف يُنسخ من العقد حرفياً؛ أي تغيير فيه بقرار المعماري وحده. أنواع وثوابت فقط (لا تنفيذ، لا استيراد قيمي لـprisma).
 *
 * قاعدة الملّي: في الذاكرة BigInt؛ وفي JSON (GlLinkPreview.result وردود المسارات) كل حقل ينتهي بـMilli نصّ عدد صحيح بالملّي
 * عبر toJsonMilli (reports/incomeStatement.ts) — PreviewResultJson = JsonMilli<PreviewResult>.
 */
import type { Prisma } from '@prisma/client';
import type { CostingSummary, LoadMovesOptions, LoadMovesResult, LocationKey, LocationTotals, Move, ReplayOptions, ReplayResult, StepperConfig, SummarizeOptions, CostState, StepOutput } from '../../costing/types';
import type { DerivedOpening, ManualBalanceRowInput, OpeningCutoff, OpeningRouting } from '../opening';
import type { JsonMilli } from '../reports/incomeStatement';
import type { GlSettingsRow } from '../resolve';
import type {
  CashInvoiceRouting, EventStatus, InventoryMode, LocalDate, Milli, ReceiptRouting, TaxPeriodicity, TemplateKey,
} from '../types';

// ═══ الثوابت ═══

export const LINK_BASES = ['FY_RESTATED', 'FROM_ACTIVATION'] as const;
export type LinkBasis = (typeof LINK_BASES)[number];
/** قرار المالك: بأثر رجعي من بداية السنة المالية */
export const DEFAULT_LINK_BASIS: LinkBasis = 'FY_RESTATED';

export const PREVIEW_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/** بترتيب التنفيذ */
export const PREVIEW_PHASES = ['QUEUED', 'READ', 'COSTING', 'OPENING', 'RECONCILE', 'POST', 'PARITY', 'PREFLIGHT', 'DONE'] as const;
export type PreviewPhase = (typeof PREVIEW_PHASES)[number];
/** نسبة التقدّم عند **بدء** كل مرحلة (POST يتقدّم داخلياً من 40 إلى 85) */
export const PREVIEW_PHASE_PCT: Readonly<Record<PreviewPhase, number>> = {
  QUEUED: 0, READ: 5, COSTING: 10, OPENING: 25, RECONCILE: 30, POST: 40, PARITY: 88, PREFLIGHT: 94, DONE: 100,
};

export const PREVIEW_ERROR_CODES = ['INTERRUPTED', 'TIMEOUT', 'TOO_LARGE', 'SHADOW_GL_ACCESS', 'ALREADY_ACTIVATED', 'INTERNAL'] as const;
export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

export const PREVIEW_RESULT_MAX_BYTES = 1_500_000;
/** RUNNING بلا نبضٍ أحدث من هذا ⇒ FAILED(INTERRUPTED) */
export const PREVIEW_STALE_MS = 120_000;
/** سقف المهمة كلها */
export const PREVIEW_TIMEOUT_MS = 15 * 60_000;
/** مهلة معاملة اللقطة REPEATABLE READ READ ONLY */
export const PREVIEW_TX_TIMEOUT_MS = 14 * 60_000;
/** حدّ المعدّل: معاينات الشركة في الساعة */
export const PREVIEW_RATE_LIMIT_PER_HOUR = 6;
/** تُبقى نتائج آخر خمس معاينات للشركة، والأقدم يُفرَّغ result (إلا المعتمدة GlSettings.linkPreviewId) */
export const PREVIEW_KEEP_RESULTS = 5;
/** أحداث الظلّ فوق هذا ⇒ FAILED(TOO_LARGE) — P13 يحجب فوق سقف المنصّة */
export const PREVIEW_MAX_EVENTS = 300_000;
export const PLATFORM_EVENT_CAP = 300_000;
/** قصّ القوائم داخل النتيجة */
export const PREVIEW_LIST_CAPS = { openingLines: 2000, drillRows: 200, heldLines: 500, preflightItems: 50, holesSample: 50 } as const;

/** تقدير الترحيل التاريخي (الخطة §3 «Throughput and storage»): CONSERVATIVE_MS_PER_EVENT في backfill.ts = 40 */
export const BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN = 20_000;
export const BACKFILL_PEAK_BUDGET_MS_PER_MIN = 5_000;
export const ROWS_PER_POSTED_EVENT = 9;
export const ROW_BYTES_ESTIMATE = 350;
export const COST_SNAPSHOT_ROW_BYTES = 300;

/** مسارات العهدة الافتراضية للربط (OD4): النقد والشيك مع مندوب ⇒ عهدة، والبقية مباشرة لحسابها */
export const LINKED_DEFAULT_RECEIPT_ROUTING: Readonly<ReceiptRouting> = { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' };

// ═══ المدخلات ═══

/** ما يُقرأ من مسودة المعالج (GlSettings.setupDraft بعد parseStoredDraft) — الأقسام التي يحتاجها الربط وحدها */
export interface LinkingDraft {
  step1?: {
    timezone?: string; fiscalYearEndMonth?: number; fiscalYearEndDay?: number; weekStartsOn?: number;
    taxPeriodicity?: TaxPeriodicity; confirmMidVatPeriod?: boolean;
  };
  step3?: {
    categoryIncomeAccounts?: { categoryId: string; accountCode: string }[];
    receiptRouting?: ReceiptRouting | null;
    cashInvoiceRouting?: CashInvoiceRouting;
  };
  step5?: { rows?: ManualBalanceRowInput[] };
}

/** صف GlSettings الحقيقي كما يحتاجه الربط (الأقفال والتفعيل) — null قبل أي إعداد */
export type LinkingSettingsRow = GlSettingsRow & {
  activatedAt: Date | null;
  setupMethod: string | null;
  linkPreviewId?: string | null;
};

/** خيارات المعاينة كما يحلّها params.ts (P5) — runPreview لا يقرأ المسودة ولا الإعدادات بنفسه */
export interface PreviewOptions {
  basis: LinkBasis;
  /** cutover: fiscalYearStart(اليوم) لـFY_RESTATED، أو اليوم لـFROM_ACTIVATION */
  linkedFrom: LocalDate;
  templateKey: TemplateKey;
  countryCode: string;
  timezone: string;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  weekStartsOn: number;
  taxPeriodicity: TaxPeriodicity;
  /** عملة الدفاتر (القالب أو GlSettings) ومنازلها */
  currency: string;
  currencyDecimals: number;
  receiptRouting: ReceiptRouting;
  cashInvoiceRouting: CashInvoiceRouting;
  /** OD7: PERPETUAL لمن له مخزون الشركة (Tenant.warehouseEnabled)، وإلا PERIODIC (بلا سطور مخزون افتتاحية) */
  inventoryMode: InventoryMode;
  categoryIncomeAccounts: { categoryId: string; accountCode: string }[];
  /** الأرصدة اليدوية للمحاسب (المسودة step5) — بلا الحسابات المشتقة (DERIVED_ACCOUNT) */
  manualRows: ManualBalanceRowInput[];
  /** linkedFrom داخل فترة إقرار مؤكَّدة (تُقبل 212001/116001 يدوياً) */
  midVatPeriod: boolean;
  /** للـpreflight وحده (الأقفال والتفعيل والمسودة) — لا يُبنى منه السياق */
  settingsRow: LinkingSettingsRow | null;
  draft: LinkingDraft | null;
  suiteEnabled: boolean;
  workerEnabled: boolean;
  /** للاختبار والقياس: سقف الأحداث ومهلة اللقطة، ودفعة طيّ التكلفة وسقف حركاتها (linking/costingFold.ts) */
  limits?: { maxEvents?: number; txTimeoutMs?: number; costBatchMoves?: number; maxCostMoves?: number };
}

export interface PreviewHooks {
  /** يُستدعى عند كل مرحلة وكل دفعة POST (≤ مرة في الثانية) — تحديث GlLinkPreview.phase/progressPct/heartbeatAt */
  onProgress?(phase: PreviewPhase, pct: number): void | Promise<void>;
  /** ساعة أحادية للتوقيتات (الافتراضي Date.now) */
  clock?: () => number;
}

// ═══ القيد الافتتاحي المشتقّ (opening.ts — P2) ═══

/** مدخل buildOpeningMove الاختياري `derived` — غيابه = السلوك القائم حرفياً */
export interface DerivedOpeningLinesInput {
  /** computeDerivedOpening: receivables (113001 لكل عميل)، custody (111003 لكل مندوب)، paylinkHeldMilli (112005) — حقله warehouse مُهمَل */
  opening: DerivedOpening;
  /** من محرّك التكلفة (CostingSummary.openingByLocation): WH ⇒ 114001، VAN:<rep> ⇒ 114002 بمندوبه؛ null ⇒ بلا سطور مخزون (PERIODIC) */
  inventory: readonly LocationTotals[] | null;
  /** أسماء المناديب لسطور 114002 (لقطة partnerName) */
  salesRepNames?: Readonly<Record<string, string>>;
}

export interface LinkedOpeningResult {
  derived: DerivedOpeningLinesInput;
  /** لتجميد تقسيم الاستلامات المشمولة (freezeOpeningSettlementSplits) */
  settlementSplits: DerivedOpening['settlementSplits'];
}

// ═══ preflight (P3) ═══

export const PREFLIGHT_CODES = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12', 'P13', 'P14'] as const;
export type PreflightCode = (typeof PREFLIGHT_CODES)[number];
/** B يحجب الاعتماد (L7)، W تحذير يُقرّ به */
export type PreflightLevel = 'B' | 'W';
export type PreflightMode = 'LIGHT' | 'FULL';

export interface PreflightItem {
  id: string | null;
  label: string;
  qty?: number | null;
  valueMilli?: Milli | null;
  date?: LocalDate | null;
}

export interface PreflightCheck {
  code: PreflightCode;
  level: PreflightLevel;
  ok: boolean;
  /** لا ينطبق (مثل P14 لغير التحويل) — ok=true دائماً معه */
  notApplicable?: boolean;
  titleAr: string;
  /** جملة عربية للمالك: ما وُجد وما المطلوب */
  details: string;
  count?: number | null;
  valueMilli?: Milli | null;
  /** حتى PREVIEW_LIST_CAPS.preflightItems */
  items?: PreflightItem[];
  itemsTruncated?: number;
  /** LIGHT: تقدير سريع (GET /preflight)؛ FULL: من المعاينة الكاملة */
  mode: PreflightMode;
}

export interface PreflightReport {
  mode: PreflightMode;
  linkedFrom: LocalDate;
  basis: LinkBasis;
  checks: PreflightCheck[];
  /** عدد B غير المتحققة */
  blocking: number;
  /** عدد W غير المتحققة */
  warnings: number;
}

export interface PreflightEventStats {
  /** أحداث ستُرحَّل في الترحيل التاريخي (DONE في الظلّ) */
  eventsToPost: number;
  /** نسب ضريبة AUTO_SALE_<pct> التي احتاجها الظلّ (بلا مربع إقرار) */
  autoSalePercents: number[];
  byType: Record<string, number>;
  /**
   * الصفوف والبايتات المقيسة من الظلّ نفسه (etaAndStorage — قسم «الوقت والتخزين» في النتيجة). حاضرةً ⇒ يعرضها P13 بدل
   * تقدير ROWS_PER_POSTED_EVENT، فلا يظهر للمالك رقمان مختلفان للحجم نفسه في صفحة واحدة. (إضافة التكامل)
   */
  storage?: { rows: number; bytesEstimate: number } | null;
}

export interface PreflightInput {
  mode: PreflightMode;
  basis: LinkBasis;
  linkedFrom: LocalDate;
  timezone: string;
  templateKey: TemplateKey;
  currency: string;
  currencyDecimals: number;
  receiptRouting: ReceiptRouting;
  cashInvoiceRouting: CashInvoiceRouting;
  settingsRow: LinkingSettingsRow | null;
  draft: LinkingDraft | null;
  suiteEnabled: boolean;
  workerEnabled: boolean;
  now: Date;
  /**
   * وضع المخزون المحلول مع بقية الخيارات (params.ts، OD7). حاضراً ⇒ يُستعمل هو فلا يُعاد اشتقاقه بقراءة ثانية لـ
   * Tenant.warehouseEnabled قد تخالف ما بُنيت عليه المعاينة إن بُدّل المفتاح بينهما. غائباً ⇒ القراءة (السلوك الأول).
   * (إضافة التكامل)
   */
  inventoryMode?: InventoryMode;
  /** FULL وحده */
  costing?: CostingSummary | null;
  eventStats?: PreflightEventStats | null;
}

// ═══ المطابقة (P4) ═══

export const PARITY_CODES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13'] as const;
export type ParityCode = (typeof PARITY_CODES)[number];
export type ParityStatus = 'OK' | 'MISMATCH' | 'NOT_AVAILABLE';
export type ParityScope = 'FULL' | 'OPENING_ONLY' | 'NONE';
export type ParityPartnerType = 'CUSTOMER' | 'REP' | 'VENDOR' | 'LOCATION' | 'MOVE' | 'ACCOUNT';
/**
 * رمز آليّ لسبب NOT_AVAILABLE الذي لا تضيفه أي مرحلة (availableIn = null) — تترجمه الواجهة بدل نصّ reason العربي:
 * INVENTORY_PERIODIC = المخزون الدوري (OD7) فلا رصيد مخزون مستمرّاً في الدفاتر ولا مطابقة R8 أصلاً.
 */
export type ParityReasonCode = 'INVENTORY_PERIODIC';

export interface ParityDrillRow {
  partnerType: ParityPartnerType;
  partnerId: string | null;
  name: string | null;
  expectedMilli: Milli;
  actualMilli: Milli;
  diffMilli: Milli;
  /** شرح عربي قصير (حدث محجوز، وصول متأخر…) */
  note?: string | null;
  /** مفاتيح أحداث/قيود تفسّر الفرق */
  refs?: string[];
}

export interface ParityCheck {
  code: ParityCode;
  titleAr: string;
  status: ParityStatus;
  scope: ParityScope;
  /** NOT_AVAILABLE: المرحلة التي تضيفه */
  availableIn?: 'L4' | 'L5' | 'L6' | 'L7' | null;
  /** NOT_AVAILABLE: «يُضاف في Lx — …» */
  reason?: string | null;
  /** NOT_AVAILABLE بلا مرحلة (availableIn = null): لماذا لا ينطبق الفحص على الشركة — غائب في غير ذلك */
  reasonCode?: ParityReasonCode | null;
  /** المتوقَّع من التشغيل/محرّك التكلفة، والفعلي من الأستاذ (الظلّ)؛ null حين لا معنى للإجمالي */
  expectedMilli: Milli | null;
  actualMilli: Milli | null;
  diffMilli: Milli | null;
  /** مرتّبة بـ|diff| تنازلياً ثم المعرّف — حتى PREVIEW_LIST_CAPS.drillRows */
  drill: ParityDrillRow[];
  drillTruncated: number;
  info?: Record<string, string | number | null>;
}

/** قراءة أرصدة الأستاذ — ينفّذها الظلّ في المعاينة (P1)، ولاحقاً القاعدة للتشغيل الليلي */
export interface GlBalanceQuery {
  /** حتى هذا التاريخ شاملاً (الغائب = الكل) */
  upTo?: LocalDate;
  /** أنواع قيود تُحصر فيها أو تُستبعد (OPENING …) */
  moveTypes?: readonly string[];
  excludeMoveTypes?: readonly string[];
}

export interface GlBalanceView {
  /** معرّف الحساب لمفتاح ربط (AR_CONTROL، REP_CUSTODY، PAYLINK_CLEARING، INVENTORY_WAREHOUSE، INVENTORY_VAN، COGS، AP_CONTROL، GRNI، OPENING_EQUITY، POSTING_SUSPENSE…) */
  accountIdByKey(key: string): string | null;
  /** Σ(مدين − دائن) مجمّعاً بالشريك ('' للسطور بلا شريك) */
  balanceByPartner(accountIds: readonly string[], partner: 'customerId' | 'salesRepId' | 'vendorId', q?: GlBalanceQuery): Map<string, Milli>;
  total(accountIds: readonly string[], q?: GlBalanceQuery): Milli;
  /** قيود غير متوازنة (يجب أن تكون فارغة) */
  unbalancedMoves(): { moveRef: string; sourceKey: string | null; debitMilli: Milli; creditMilli: Milli }[];
  /** Σ المدين وΣ الدائن لكل السطور */
  grandTotals(): { debitMilli: Milli; creditMilli: Milli };
  /** سطور على حساب (للتعمّق) */
  linesOn(accountId: string, limit: number): { moveRef: string; date: LocalDate; moveType: string; sourceKey: string | null; needsAttention: boolean; attentionReason: string | null; debitMilli: Milli; creditMilli: Milli }[];
}

/** حقائق التشغيل المقابلة (loadOperationalFacts — P4) — كل مبلغ مقرَّب **لكل مستند** نصف-لأعلى ثم مجموع بالملّي */
export interface OperationalFacts {
  /** Σ(toMilli(debit) − toMilli(credit)) لكل صفوف AccountEntry حتى اللقطة، لكل عميل */
  arByCustomer: Map<string, Milli>;
  /** الصفوف المشمولة بالافتتاح بقاعدة computeDerivedOpening، لكل عميل */
  arOpeningByCustomer: Map<string, Milli>;
  /** custodyComponentsForRep(loadCustodyInputs) لكل مندوب له أثر */
  custodyByRep: Map<string, { ledgerCustodyMilli: Milli; opsOutstandingMilli: Milli }>;
  /** Σ toMilli(amount) لكل صف settlement_entries حتى اللقطة */
  settlementBalanceMilli: Milli;
  /** Σ amountMilli لكل مورّد (supplier_ledger_entries) حتى اللقطة */
  supplierByVendor: Map<string, Milli>;
  /** Σ قيمة أسطر الوارد المسعَّر غير المصنَّف (paymentMode null) المسجَّل منذ linkedFrom */
  unclassifiedPricedReceiptsFyMilli: Milli;
  names: { customers: Map<string, string>; reps: Map<string, string>; vendors: Map<string, string> };
}

export interface ParityContext {
  linkedFrom: LocalDate;
  /** linkedFrom − 1 */
  openingDate: LocalDate;
  currencyDecimals: number;
  /** فرق 319002 في القيد الافتتاحي (موجب = دائن) — buildOpeningMove.equityDiffMilli */
  openingEquityDiffMilli: Milli;
  costing: CostingSummary | null;
  /** مفاتيح أحداث محجوزة لكل شريك — لملاحظة «يفسّره حدث محجوز» */
  heldByPartner: Map<string, string[]>;
  inventoryMode: InventoryMode;
}

// ═══ النتيجة ═══

export interface OpeningPreviewLine {
  accountCode: string;
  accountName: string;
  /** DERIVED (مشتقّ من التشغيل) | MANUAL (المحاسب) | EQUITY (فرق 319002) */
  origin: 'DERIVED' | 'MANUAL' | 'EQUITY';
  partnerType: 'CUSTOMER' | 'REP' | 'VENDOR' | 'LOCATION' | null;
  partnerId: string | null;
  partnerName: string | null;
  label: string;
  debitMilli: Milli;
  creditMilli: Milli;
}

export interface OpeningPreview {
  date: LocalDate;
  lines: OpeningPreviewLine[];
  linesTruncated: number;
  byAccount: { accountCode: string; accountName: string; debitMilli: Milli; creditMilli: Milli; lines: number }[];
  totals: { debitMilli: Milli; creditMilli: Milli; derivedNetMilli: Milli; manualDebitMilli: Milli; manualCreditMilli: Milli; equityDiffMilli: Milli };
  manualIssues: { index: number; accountCode: string; reason: string }[];
}

export interface EventCountRow {
  sourceType: string;
  event: string;
  status: EventStatus;
  /** skipReason أو سبب HELD/BLOCKED */
  reason: string | null;
  count: number;
}

export interface HeldLine {
  /** EVENT: حدث HELD/ERROR/BLOCKED باقٍ؛ SUSPENSE_LINE: سطر قيد على 911001 */
  kind: 'EVENT' | 'SUSPENSE_LINE';
  sourceKey: string;
  sourceType: string;
  status: string;
  reason: string | null;
  detail: string | null;
  effectDate: LocalDate | null;
  amountMilli: Milli | null;
  partnerType: 'CUSTOMER' | 'REP' | null;
  partnerId: string | null;
  partnerName: string | null;
}

export interface TrialBalanceMonthRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  /** رصيد ما قبل linkedFrom (القيد الافتتاحي) */
  openingMilli: Milli;
  months: { month: string; debitMilli: Milli; creditMilli: Milli }[];
  debitMilli: Milli;
  creditMilli: Milli;
  closingMilli: Milli;
}

export interface TrialBalanceByMonth {
  /** 'YYYY-MM' من شهر linkedFrom إلى شهر اللقطة */
  months: string[];
  rows: TrialBalanceMonthRow[];
  totals: { openingMilli: Milli; debitMilli: Milli; creditMilli: Milli; closingMilli: Milli };
}

export interface StatementPreviewLine {
  key: string;
  labelAr: string;
  amountMilli: Milli;
  depth: number;
}

export interface PnlPreview {
  from: LocalDate;
  to: LocalDate;
  lines: StatementPreviewLine[];
  netMilli: Milli;
}

export interface BalanceSheetPreview {
  asOf: LocalDate;
  lines: StatementPreviewLine[];
  assetsMilli: Milli;
  liabilitiesMilli: Milli;
  equityMilli: Milli;
  balanced: boolean;
}

export interface VatPeriodBoxRow {
  /** 'YYYY-MM' (شهري) أو 'YYYY-Qn' (ربع) أو 'YYYY-Hn' أو 'YYYY' بحسب taxPeriodicity — من بداية الفترة */
  periodKey: string;
  from: LocalDate;
  to: LocalDate;
  /** مربع الإقرار (SA_1…) أو null للقالب العام */
  box: string | null;
  baseMilli: Milli;
  taxMilli: Milli;
}

export interface PreviewEta {
  eventsToPost: number;
  msPerEvent: number;
  offPeakBudgetMsPerMin: number;
  peakBudgetMsPerMin: number;
  etaMinutesOffPeak: number;
  etaMinutesPeakOnly: number;
}

export interface PreviewStorage {
  rows: { events: number; moves: number; lines: number; moveSources: number; audits: number; costSnapshots: number; total: number };
  bytesEstimate: number;
  /** ملاحظة عربية حين يتجاوز التقدير هامش القاعدة (infra_capacity_limits) — null وإلا */
  headroomNote: string | null;
}

export interface PreviewWarning {
  code: string;
  message: string;
  count?: number | null;
}

export interface CostingPreview {
  summary: CostingSummary;
  sourceRows: Record<string, number>;
}

export interface PreviewResult {
  version: 1;
  tenantId: string;
  basis: LinkBasis;
  linkedFrom: LocalDate;
  openingDate: LocalDate;
  /** T0 ISO */
  snapshotAt: string;
  /** ساعة القاعدة داخل اللقطة ISO */
  dbNow: string;
  currency: string;
  currencyDecimals: number;
  timezone: string;
  templateKey: TemplateKey;
  inventoryMode: InventoryMode;
  dataHash: string;
  resultHash: string;
  opening: OpeningPreview;
  eventCounts: EventCountRow[];
  trialBalanceByMonth: TrialBalanceByMonth;
  pnlYtd: PnlPreview;
  balanceSheet: BalanceSheetPreview;
  vatByPeriodBox: VatPeriodBoxRow[];
  parity: ParityCheck[];
  preflight: PreflightReport;
  heldLines: HeldLine[];
  heldTruncated: number;
  costing: CostingPreview;
  eta: PreviewEta;
  storage: PreviewStorage;
  warnings: PreviewWarning[];
  /** خارج resultHash */
  timings: { phase: PreviewPhase; ms: number }[];
}

export type PreviewResultJson = JsonMilli<PreviewResult>;

// ═══ الاعتماديات القابلة للحقن (اختبار P1 وP5 بلا الوحدات الأخرى) ═══

export interface PreviewDeps {
  loadMoves(db: Prisma.TransactionClient, tenantId: string, opts: LoadMovesOptions): Promise<LoadMovesResult>;
  replay(moves: readonly Move[], cfg: StepperConfig, opts?: ReplayOptions): ReplayResult;
  summarizeCosting(outputs: readonly StepOutput[], finalState: CostState, opts: SummarizeOptions): CostingSummary;
  loadLinkedOpening(db: Prisma.TransactionClient, tenantId: string, input: {
    cut: OpeningCutoff; decimals: number; routing: OpeningRouting; inventory: readonly LocationTotals[] | null;
  }): Promise<LinkedOpeningResult>;
  runPreflight(db: Prisma.TransactionClient, tenantId: string, input: PreflightInput): Promise<PreflightReport>;
  loadOperationalFacts(db: Prisma.TransactionClient, tenantId: string, input: {
    snapshotAt: Date; dbNow: Date; linkedFrom: LocalDate; cutoverStart: Date; timezone: string; currencyDecimals: number;
  }): Promise<OperationalFacts>;
  runParity(gl: GlBalanceView, ops: OperationalFacts, ctx: ParityContext): ParityCheck[];
}
