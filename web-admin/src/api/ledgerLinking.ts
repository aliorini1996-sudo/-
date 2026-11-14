import api from './client';
import type { LedgerEnvelope, LocalDate } from './ledgerConfig';
import type { EventStatus } from './ledgerReview';

/**
 * عميل «ربط الدفاتر بالنظام» (معاينة L2) — `/api/ledger/linking/*` (العقد l23 §14.3 و§15).
 *
 * مُوفَّق مع backend/src/routes/ledger/linking.ts وbackend/src/services/gl/linking/types.ts:
 * - كل المسارات `canConfigureLedger` **ولمالك الشركة وحده** (403 `LEDGER_LINKING_OWNER_ONLY`)، وللقراءة فقط:
 *   الكتابة الوحيدة صفّ المعاينة نفسه (`gl_link_previews`) — لا زرّ اعتماد هنا (L7).
 * - الأنواع منسوخة يدوياً من `PreviewResultJson = JsonMilli<PreviewResult>`: كل bigint نصّ عدد صحيح بالملّي
 *   (كل حقل ينتهي بـ`Milli`)، ويُعرض عبر milliToDecimalString/LedgerAmount — لا `Number` على مبلغ أبداً.
 * - أعضاء الكائن أدناه سطرٌ لكلٍّ منها: حارس ledgerMenuPerms يقرأ المسار من نصّ السطر.
 */

/** مبلغ ملّي كما يصل من الخادم: نصّ عدد صحيح (قد يكون سالباً) */
export type MilliText = string;

// ═══ الثوابت (مرآة linking/types.ts) ═══

export const LINK_BASES = ['FY_RESTATED', 'FROM_ACTIVATION'] as const;
export type LinkBasis = (typeof LINK_BASES)[number];
/** قرار المالك: بأثر رجعي من بداية السنة المالية */
export const DEFAULT_LINK_BASIS: LinkBasis = 'FY_RESTATED';

export const PREVIEW_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/** بترتيب التنفيذ */
export const PREVIEW_PHASES = ['QUEUED', 'READ', 'COSTING', 'OPENING', 'RECONCILE', 'POST', 'PARITY', 'PREFLIGHT', 'DONE'] as const;
export type PreviewPhase = (typeof PREVIEW_PHASES)[number];
/** نسبة التقدّم عند بدء كل مرحلة (POST يتقدّم داخلياً من 40 إلى 85) */
export const PREVIEW_PHASE_PCT: Readonly<Record<PreviewPhase, number>> = {
  QUEUED: 0, READ: 5, COSTING: 10, OPENING: 25, RECONCILE: 30, POST: 40, PARITY: 88, PREFLIGHT: 94, DONE: 100,
};

export const PREVIEW_ERROR_CODES = ['INTERRUPTED', 'TIMEOUT', 'TOO_LARGE', 'SHADOW_GL_ACCESS', 'ALREADY_ACTIVATED', 'INTERNAL'] as const;
export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

/** حدّ المعدّل في الخادم: معاينات الشركة في الساعة */
export const PREVIEW_RATE_LIMIT_PER_HOUR = 6;
/** قصّ القوائم داخل النتيجة (للعرض: «و N أخرى») */
export const PREVIEW_LIST_CAPS = { openingLines: 2000, drillRows: 200, heldLines: 500, preflightItems: 50, holesSample: 50 } as const;

export type InventoryMode = 'PERPETUAL' | 'PERIODIC';
export type LocationKey = 'WH' | `VAN:${string}`;

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
  valueMilli?: MilliText | null;
  date?: LocalDate | null;
}

export interface PreflightCheck {
  code: PreflightCode;
  level: PreflightLevel;
  ok: boolean;
  notApplicable?: boolean;
  /** نصّ الخادم العربي — الواجهة تعرض تسميتها المترجمة (lib/ledger/linking.ts) */
  titleAr: string;
  details: string;
  count?: number | null;
  valueMilli?: MilliText | null;
  items?: PreflightItem[];
  itemsTruncated?: number;
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

// ═══ المطابقة (P4) ═══

export const PARITY_CODES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13'] as const;
export type ParityCode = (typeof PARITY_CODES)[number];
export type ParityStatus = 'OK' | 'MISMATCH' | 'NOT_AVAILABLE';
export type ParityScope = 'FULL' | 'OPENING_ONLY' | 'NONE';
export type ParityPartnerType = 'CUSTOMER' | 'REP' | 'VENDOR' | 'LOCATION' | 'MOVE' | 'ACCOUNT';
export type LinkingMilestone = 'L4' | 'L5' | 'L6' | 'L7';
/** لماذا لا ينطبق فحص NOT_AVAILABLE بلا مرحلة (availableIn = null): INVENTORY_PERIODIC = جرد دوري فلا مطابقة R8 أصلاً */
export type ParityReasonCode = 'INVENTORY_PERIODIC';

export interface ParityDrillRow {
  partnerType: ParityPartnerType;
  partnerId: string | null;
  name: string | null;
  expectedMilli: MilliText;
  actualMilli: MilliText;
  diffMilli: MilliText;
  note?: string | null;
  refs?: string[];
}

export interface ParityCheck {
  code: ParityCode;
  titleAr: string;
  status: ParityStatus;
  scope: ParityScope;
  availableIn?: LinkingMilestone | null;
  reason?: string | null;
  /** غائب إلا لما لا ينطبق على الشركة في أي مرحلة */
  reasonCode?: ParityReasonCode | null;
  expectedMilli: MilliText | null;
  actualMilli: MilliText | null;
  diffMilli: MilliText | null;
  drill: ParityDrillRow[];
  drillTruncated: number;
  info?: Record<string, string | number | null>;
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
  debitMilli: MilliText;
  creditMilli: MilliText;
}

export interface OpeningPreview {
  date: LocalDate;
  lines: OpeningPreviewLine[];
  linesTruncated: number;
  byAccount: { accountCode: string; accountName: string; debitMilli: MilliText; creditMilli: MilliText; lines: number }[];
  totals: {
    debitMilli: MilliText; creditMilli: MilliText; derivedNetMilli: MilliText;
    manualDebitMilli: MilliText; manualCreditMilli: MilliText; equityDiffMilli: MilliText;
  };
  manualIssues: { index: number; accountCode: string; reason: string }[];
}

export interface EventCountRow {
  sourceType: string;
  event: string;
  status: EventStatus;
  reason: string | null;
  count: number;
}

export interface HeldLine {
  kind: 'EVENT' | 'SUSPENSE_LINE';
  sourceKey: string;
  sourceType: string;
  status: string;
  reason: string | null;
  detail: string | null;
  effectDate: LocalDate | null;
  amountMilli: MilliText | null;
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
  openingMilli: MilliText;
  months: { month: string; debitMilli: MilliText; creditMilli: MilliText }[];
  debitMilli: MilliText;
  creditMilli: MilliText;
  closingMilli: MilliText;
}

export interface TrialBalanceByMonth {
  /** 'YYYY-MM' من شهر linkedFrom إلى شهر اللقطة */
  months: string[];
  rows: TrialBalanceMonthRow[];
  totals: { openingMilli: MilliText; debitMilli: MilliText; creditMilli: MilliText; closingMilli: MilliText };
}

export interface StatementPreviewLine {
  key: string;
  labelAr: string;
  amountMilli: MilliText;
  depth: number;
}

export interface PnlPreview {
  from: LocalDate;
  to: LocalDate;
  lines: StatementPreviewLine[];
  netMilli: MilliText;
}

export interface BalanceSheetPreview {
  asOf: LocalDate;
  lines: StatementPreviewLine[];
  assetsMilli: MilliText;
  liabilitiesMilli: MilliText;
  equityMilli: MilliText;
  balanced: boolean;
}

export interface VatPeriodBoxRow {
  periodKey: string;
  from: LocalDate;
  to: LocalDate;
  /** مربع الإقرار (SA_1…) أو null للقالب العام */
  box: string | null;
  baseMilli: MilliText;
  taxMilli: MilliText;
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
  /** ملاحظة عربية حين يتجاوز التقدير هامش القاعدة — null وإلا */
  headroomNote: string | null;
}

export interface PreviewWarning {
  code: string;
  message: string;
  count?: number | null;
}

export interface LocationTotals {
  location: LocationKey;
  qtyBase: number;
  uncostedQty: number;
  valueMilli: MilliText;
}

export interface CostingSummary {
  moveCount: number;
  productCount: number;
  openingByLocation: LocationTotals[];
  nowByLocation: LocationTotals[];
  fyCogsMilli: MilliText;
  fyVarianceMilli: MilliText;
  fyWriteOffMilli: MilliText;
  uncostedAtCutover: { productId: string; location: LocationKey; uncostedQty: number }[];
  uncostedAtCutoverTotalQty: number;
  negativeAtCutover: { productId: string; location: LocationKey; qtyBase: number }[];
  holesFy: { count: number; varianceMilli: MilliText; sample: { key: string; productId: string; location: LocationKey; varianceMilli: MilliText }[] };
  warnings: { code: string; count: number; sample: string[] }[];
}

export interface CostingPreview {
  summary: CostingSummary;
  sourceRows: Record<string, number>;
}

/** `PreviewResultJson = JsonMilli<PreviewResult>` (linking/types.ts) */
export interface PreviewResultJson {
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
  templateKey: string;
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
  timings: { phase: PreviewPhase; ms: number }[];
}

// ═══ صفّ المعاينة (GlLinkPreview) ═══

/** `GET /linking/preview/:id` */
export interface GlLinkPreviewView {
  id: string;
  status: PreviewStatus;
  phase: PreviewPhase | null;
  progressPct: number;
  basis: LinkBasis;
  linkedFrom: LocalDate;
  snapshotAt: string | null;
  dataHash: string | null;
  resultHash: string | null;
  resultBytes: number | null;
  errorCode: PreviewErrorCode | string | null;
  /** رسالة عربية للمالك (تُعرض في الواجهة العربية وحدها؛ غيرها بتسمية errorCode) */
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  result: PreviewResultJson | null;
}

/** `GET /linking/previews` — بلا result، الأحدث أولاً */
export type GlLinkPreviewSummary = Omit<GlLinkPreviewView, 'result'>;

/** `POST /linking/preview`: 202 جديدة، أو 200 بالجارية (`existing: true`) */
export interface StartPreviewResult {
  id: string;
  status: PreviewStatus;
  existing: boolean;
}

/** رموز أخطاء المسارات (`{success:false, code, message}`) — تسمياتها في lib/ledger/linking.ts */
export type LedgerLinkingErrorCode =
  | 'LEDGER_LINKING_OWNER_ONLY' | 'LEDGER_LINKING_INTERACTIVE_ONLY' | 'LEDGER_LINK_ALREADY_ACTIVATED'
  | 'LEDGER_LINK_PREVIEW_RATE_LIMITED' | 'LEDGER_LINK_PREVIEW_NOT_FOUND';

// ═══ النقاط ═══

const L = '/ledger';

export const ledgerLinkingApi = {
  startPreview: (body: { basis?: LinkBasis } = {}) => api.post<LedgerEnvelope<StartPreviewResult>>(`${L}/linking/preview`, body),
  getPreview: (id: string) => api.get<LedgerEnvelope<GlLinkPreviewView>>(`${L}/linking/preview/${encodeURIComponent(id)}`),
  listPreviews: (limit?: number) => api.get<LedgerEnvelope<GlLinkPreviewSummary[]>>(`${L}/linking/previews`, { params: limit ? { limit } : undefined }),
  preflight: (basis?: LinkBasis) => api.get<LedgerEnvelope<PreflightReport>>(`${L}/linking/preflight`, { params: basis ? { basis } : undefined }),
};

export const ledgerLinkingKeys = {
  all: ['ledger', 'linking'] as const,
  previews: ['ledger', 'linking', 'previews'] as const,
  preview: (id: string) => ['ledger', 'linking', 'preview', id] as const,
  preflight: (basis: LinkBasis) => ['ledger', 'linking', 'preflight', basis] as const,
};
