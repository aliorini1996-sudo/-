import api from './client';
import type { LedgerEnvelope, LocalDate, BackfillState } from './ledgerConfig';

/**
 * عميل «مراجعة» و«العملاء» في الدفاتر — `/api/ledger/*` (M3، §5.1، §5.9، §6.1، §8.2، §9.3، ملحق أ).
 *
 * مُوفَّق مع backend/src/routes/ledger/{sync,checks,customers,review}.ts:
 * - مبالغ الأستاذ ملّي نصوصاً بلاحقة `Milli` (تُعرض عبر milliToDecimalString)، ومبالغ المستندات التشغيلية أرقام.
 * - الأحداث والفحوص قبل التفعيل ترد 409 `LEDGER_NOT_SETUP` (التشغيل)، والقوائم تعيد `activated:false`.
 */

type QValue = string | number | boolean | undefined | null | string[];
type Q = Record<string, QValue>;
const clean = (q?: Q) => (q
  ? Object.fromEntries(Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]))
  : undefined);

// ═══ الأحداث (§5.4، §2.5) ═══

export type EventStatus = 'PENDING' | 'DONE' | 'SKIPPED' | 'BLOCKED' | 'ERROR' | 'HELD';
export const EVENT_STATUSES: readonly EventStatus[] = ['PENDING', 'BLOCKED', 'ERROR', 'HELD', 'DONE', 'SKIPPED'];
export type EventAction = 'retry' | 'skip' | 'release';

export type EventNote =
  | { kind: 'HELD'; reason: string; detail?: string | null }
  | { kind: 'BLOCKED'; reason: string; step: number; detail?: string | null }
  | { kind: 'PENDING'; reason: string }
  | { kind: 'ERROR'; message: string };

export interface SyncEventRow {
  id: string;
  sourceKey: string;
  sourceType: string;
  sourceId: string;
  event: string;
  effectAt: string;
  detectedAt: string;
  status: EventStatus;
  skipReason: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  moveId: string | null;
  processedAt: string | null;
  nonCustodyClearedMilli: string | null;
  shortageRecoveredMilli: string | null;
  note: EventNote | null;
  moveNumber: string | null;
  sibling: { sourceKey: string; status: EventStatus | null; skipReason: string | null; nextAttemptAt: string | null; moveId: string | null } | null;
}

export interface SyncEventPage {
  total: number;
  offset: number;
  limit: number;
  counts: Partial<Record<EventStatus, number>>;
  rows: SyncEventRow[];
}

export interface EventListParams extends Q {
  status?: string | string[];
  sourceType?: string | string[];
  event?: string | string[];
  dateFrom?: LocalDate;
  dateTo?: LocalDate;
  q?: string;
  offset?: number;
  limit?: number;
}

// ═══ الفحوص (§5.9) ═══

export type CheckStatus = 'GREEN' | 'YELLOW' | 'RED';
export type CheckKey = 'C1' | 'C2' | 'C3' | 'C4' | 'C4b' | 'C5' | 'C8' | 'C9' | 'C10' | 'C11' | 'C12' | 'C14' | 'C15';
export type CheckFix =
  | 'REBUILD_BALANCES' | 'CONTROL_ADJUSTMENT' | 'REVIEW_EVENTS' | 'REVIEW_DRAFTS' | 'REVIEW_SUSPENSE'
  | 'CONFIGURE_TAXES' | 'SYNC_NOW' | 'DISABLE_ERP_POSTING';
export type CheckRow = Record<string, unknown>;

export interface CheckResult {
  key: CheckKey;
  status: CheckStatus;
  title: string;
  summary: string;
  metrics: Record<string, string | number | boolean | null>;
  rows: CheckRow[];
  rowCount: number;
  fix: CheckFix | null;
}

export interface ChecksReport {
  tenantId: string;
  ranAt: string;
  durationMs: number;
  overall: CheckStatus;
  results: CheckResult[];
}

export interface ControlAdjustmentInput { reason: string; customerId?: string; salesRepId?: string; amount?: string }
export interface ControlAdjustmentResult { id: string; number: string; date: LocalDate; totalMilli: string; gapMilli: string }

// ═══ القوائم (العملاء) ═══

export type PostingState =
  | 'NOT_SYNCED' | 'PENDING' | 'BLOCKED' | 'ERROR' | 'HELD'
  | 'POSTED' | 'IN_OPENING' | 'SKIPPED' | 'REVERSE_PENDING' | 'REVERSED';

export interface EventBrief {
  id: string;
  sourceKey: string;
  status: EventStatus;
  skipReason: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  effectAt: string;
  moveId: string | null;
  moveNumber: string | null;
  note: EventNote | null;
}
export interface Posting { state: PostingState; post: EventBrief | null; reverse: EventBrief | null }

interface ListMeta {
  activated: boolean;
  activatedAt: string | null;
  cutoverDate: LocalDate | null;
  backfillState: BackfillState;
  lastSyncAt: string | null;
  currencyDecimals: number;
  total: number;
  offset: number;
  limit: number;
}

/** قائمتا الفواتير والسندات: فلتر حالة الترحيل يقرأ أحدث POSTING_FILTER_CAP (5000) مستند فقط — true حين اقتُصر */
export interface PostingFilterMeta { postingFilterCapped: boolean }

export interface InvoicePostingRow {
  id: string;
  number: string;
  type: 'CASH' | 'CREDIT' | 'RETURN' | string;
  status: string;
  date: LocalDate;
  subtotal: number;
  discountAmt: number;
  taxAmt: number;
  total: number;
  remainingAmt: number;
  customerId: string;
  customerName: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
  posting: Posting;
}

export interface ReceiptPostingRow {
  id: string;
  number: string;
  paymentMethod: string;
  status: string;
  date: LocalDate;
  amount: number;
  customerId: string;
  customerName: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
  paylinkId: string | null;
  paylinkStatus: string | null;
  posting: Posting;
}

export interface PostingListParams extends Q {
  search?: string;
  type?: string | string[];
  status?: string | string[];
  paymentMethod?: string | string[];
  posting?: string | string[];
  dateFrom?: LocalDate;
  dateTo?: LocalDate;
  customerId?: string;
  salesRepId?: string;
  offset?: number;
  limit?: number;
}

export interface CustodyComponentsView {
  ledgerCustodyMilli: string;
  onlineUnclearedMilli: string;
  cashSalesOutsideCustodyMilli: string;
  custodyExpensesMilli: string;
  openShortageMilli: string;
  shortagesExpensedMilli: string;
  nonCustodyClearedMilli: string;
  suspenseClearedMilli: string;
  shortageRecoveredMilli: string;
  nonCustodyAllowanceMilli: string;
}

export interface CustodySettlementView {
  id: string;
  amountMilli: string;
  coveredMilli: string;
  recoveredMilli: string;
  nonCustodyClearedMilli: string;
  suspenseMilli: string;
  stored: boolean;
  reversed: boolean;
}

export interface CustodyRepRow {
  salesRepId: string;
  name: string | null;
  isActive: boolean;
  pending: boolean;
  ledgerMilli: string;
  opsOutstandingMilli: string;
  c4GapMilli: string;
  c4bGapMilli: string;
  components: CustodyComponentsView;
  settlements?: CustodySettlementView[];
}

export interface CustodyView {
  activated: boolean;
  lastSyncAt?: string | null;
  currencyDecimals?: number;
  reps: CustodyRepRow[];
  totals: { ledgerMilli: string; opsOutstandingMilli: string; c4GapMilli: string } | null;
}

export interface PaylinkSummaryView {
  activated: boolean;
  lastSyncAt?: string | null;
  currencyDecimals?: number;
  summary: {
    ledgerMilli: string;
    settlementBalanceMilli: string;
    gapMilli: string;
    pending: boolean;
    refundedLinksWithoutRefund: { linkId: string; receiptId: string | null; amountMilli: string }[];
    cancelledOnlineWithoutRefund: { receiptId: string; number: string | null; amountMilli: string }[];
  } | null;
}

export type PaylinkEntryKind = 'ONLINE' | 'FEE' | 'PAYOUT';
export interface PaylinkEntryRow {
  id: string;
  date: LocalDate;
  amount: number;
  number?: string;
  status?: string;
  customerName?: string | null;
  paylinkStatus?: string | null;
  feeNet?: number | null;
  feeVat?: number | null;
  bankReference?: string | null;
  note?: string | null;
  posting: Posting;
}

// ═══ سجل التدقيق (§9.3) ═══

export interface AuditLogRow {
  id: string;
  seq: number;
  at: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  impersonated: boolean;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  beforeJson: unknown;
  afterJson: unknown;
  requestIp: string | null;
  hash: string;
  prevHash: string | null;
}

export interface AuditListParams extends Q {
  entityType?: string;
  entityId?: string;
  action?: string | string[];
  actorType?: string | string[];
  dateFrom?: LocalDate;
  dateTo?: LocalDate;
  q?: string;
  offset?: number;
  limit?: number;
}

export interface RepostResult {
  baseKey: string;
  n: number;
  sourceType: string;
  sourceId: string;
  original: { id: string; number: string | null };
  reversal: { id: string; number: string | null; date: LocalDate; sourceKey: string };
  repost: { id: string; number: string | null; date: LocalDate; sourceKey: string };
}

// ═══ النقاط ═══

const L = '/ledger';

export const ledgerReviewApi = {
  events: {
    list: (params?: EventListParams) => api.get<LedgerEnvelope<SyncEventPage>>(`${L}/events`, { params: clean(params) }),
    retry: (id: string) => api.post<LedgerEnvelope<{ id: string; sourceKey: string; status: EventStatus }>>(`${L}/events/${id}/retry`, {}),
    /** السبب إلزامي (422 REASON_REQUIRED) */
    skip: (id: string, reason: string) => api.post<LedgerEnvelope<{ id: string; sourceKey: string; status: EventStatus }>>(`${L}/events/${id}/skip`, { reason }),
    release: (id: string) => api.post<LedgerEnvelope<{ id: string; sourceKey: string; status: EventStatus }>>(`${L}/events/${id}/release`, {}),
  },

  checks: {
    get: () => api.get<LedgerEnvelope<{ report: ChecksReport | null; keys: CheckKey[] }>>(`${L}/checks`),
    run: (only?: CheckKey[]) => api.post<LedgerEnvelope<{ report: ChecksReport | null; throttled: boolean; retryAfterSeconds?: number }>>(`${L}/checks/run`, only?.length ? { only } : {}),
    rebuildBalances: () => api.post<LedgerEnvelope<{ deleted: number; inserted: number; mismatchesBefore: number }>>(`${L}/checks/rebuild-balances`, {}),
    controlAdjustment: (key: 'C3' | 'C4' | 'C5', data: ControlAdjustmentInput) =>
      api.post<LedgerEnvelope<ControlAdjustmentResult>>(`${L}/checks/${key}/control-adjustment`, data),
  },

  customers: {
    invoices: (params?: PostingListParams) => api.get<LedgerEnvelope<ListMeta & PostingFilterMeta & { rows: InvoicePostingRow[] }>>(`${L}/customers/invoices`, { params: clean(params) }),
    receipts: (params?: PostingListParams) => api.get<LedgerEnvelope<ListMeta & PostingFilterMeta & { rows: ReceiptPostingRow[] }>>(`${L}/customers/receipts`, { params: clean(params) }),
    custody: (salesRepId?: string) => api.get<LedgerEnvelope<CustodyView>>(`${L}/customers/custody`, { params: clean({ salesRepId }) }),
    paylink: () => api.get<LedgerEnvelope<PaylinkSummaryView>>(`${L}/customers/paylink`),
    paylinkEntries: (params: { kind: PaylinkEntryKind; dateFrom?: LocalDate; dateTo?: LocalDate; offset?: number; limit?: number }) =>
      api.get<LedgerEnvelope<ListMeta & { kind: PaylinkEntryKind; rows: PaylinkEntryRow[] }>>(`${L}/customers/paylink/entries`, { params: clean(params) }),
  },

  audit: {
    list: (params?: AuditListParams) => api.get<LedgerEnvelope<{ rows: AuditLogRow[]; total: number; offset: number; limit: number }>>(`${L}/audit`, { params: clean(params) }),
  },

  moves: {
    /** origin=AUTO وحده، canConfigureLedger (§6.1) */
    repostFromSource: (id: string) => api.post<LedgerEnvelope<RepostResult>>(`${L}/moves/${id}/repost-from-source`, {}),
  },
};

export const ledgerReviewKeys = {
  events: (params?: unknown) => ['ledger', 'events', params ?? {}] as const,
  checks: ['ledger', 'checks'] as const,
  invoices: (params?: unknown) => ['ledger', 'customers', 'invoices', params ?? {}] as const,
  receipts: (params?: unknown) => ['ledger', 'customers', 'receipts', params ?? {}] as const,
  custody: (salesRepId?: string) => ['ledger', 'customers', 'custody', salesRepId ?? ''] as const,
  paylink: ['ledger', 'customers', 'paylink'] as const,
  paylinkEntries: (params?: unknown) => ['ledger', 'customers', 'paylink-entries', params ?? {}] as const,
  audit: (params?: unknown) => ['ledger', 'audit', params ?? {}] as const,
};
