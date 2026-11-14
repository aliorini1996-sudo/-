import api from './client';
import type { LedgerEnvelope, LocalDate } from './ledgerConfig';

/**
 * عميل «عمليات» الدفاتر المربوطة — L4/L5 من «ربط الدفاتر» (العقد §4.8، §5.2، §5.3، §5.9، §6.4 A11).
 *
 * مُوفَّق مع backend/src/routes/ledger/{paymentMethodMap,customerAdjustments,clearing,customers,partnerReports}.ts
 * ومع routes/receipts.ts (cancel-options):
 * - مبالغ المستندات والتسويات **أرقام** بوحدة العملة (fromMilli في الخادم)، ومبالغ العهدة ملّي نصوصاً بلاحقة `Milli`.
 * - الإرسال: المبالغ نصوصاً عشرية من الملّي (milliToDecimalString) — لا تقريب صامت ولا أرقام عائمة على السلك.
 * - كل خطأ `{success:false, code, message, reason, ...}`؛ والواجهة لا تعرض message العربية (ledgerErrorMessage / opsErrorMessage).
 */

type QValue = string | number | boolean | undefined | null;
type Q = Record<string, QValue>;
const clean = (q?: Q) => (q ? Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')) : undefined);

// ═══ خريطة طرق الدفع (D3، OD4/OD14، C2/C10) ═══

/** المفاتيح الأساسية الست — مرآة PAYMENT_METHOD_MAP_KEYS في services/gl/types.ts */
export const PAYMENT_METHOD_MAP_KEYS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'CARD', 'PAYOUT'] as const;
export type PaymentMethodMapKey = (typeof PAYMENT_METHOD_MAP_KEYS)[number];

export interface AccountBrief { id: string; code: string; name: string }

export interface PaymentMethodMapRow {
  methodKey: string;
  /** اسم الخادم: اسم الشركة للمخصّصة أو المدمجة المسمّاة، وإلا الافتراضي العربي (الواجهة تترجم الافتراضي) */
  label: string;
  /** أساس الطريقة (Receipt.paymentMethod) — للمخصّصة أساسها، وفارغ لصفّ يتيم */
  base: string;
  custom: boolean;
  archived: boolean;
  /** حساب D3 الافتراضي (وللمخصّصة الحساب الفعلي لأساسها) */
  defaultAccount: AccountBrief | null;
  accountId: string | null;
  account: AccountBrief | null;
  journalId: string | null;
  /** الحساب الذي يقيّد عليه السند فعلاً في الدفاتر المربوطة */
  effective: AccountBrief | null;
}

export interface PaymentMethodMapView { linked: boolean; methods: PaymentMethodMapRow[] }
export interface PaymentMethodMapInput { accountId: string; journalId?: string | null }

// ═══ تسويات ذمم العملاء (M4، العقد §4.8) ═══

export const CUSTOMER_ADJUSTMENT_KINDS = ['BAD_DEBT_WRITEOFF', 'CREDIT_REFUND'] as const;
export type CustomerAdjustmentKind = (typeof CUSTOMER_ADJUSTMENT_KINDS)[number];
/** الشطب: BAD_DEBT ⇒ 711005 (الافتراضي)، ALLOWANCE ⇒ 113009 */
export const WRITEOFF_COUNTERS = ['BAD_DEBT', 'ALLOWANCE'] as const;
export type WriteoffCounter = (typeof WRITEOFF_COUNTERS)[number];
/** الاسترداد: CASH (الافتراضي) | BANK_TRANSFER | CHEQUE */
export const REFUND_METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];
export const CUSTOMER_ADJUSTMENT_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export type CustomerAdjustmentStatus = (typeof CUSTOMER_ADJUSTMENT_STATUSES)[number];

export interface CustomerAdjustmentView {
  id: string;
  customerId: string;
  customerName: string | null;
  kind: CustomerAdjustmentKind;
  amount: number;
  counterAccountCode: string;
  method: string | null;
  docDate: LocalDate;
  reference: string | null;
  note: string | null;
  status: CustomerAdjustmentStatus | string;
  moveId: string | null;
  moveNumber: string | null;
  reverseMoveId: string | null;
  reverseMoveNumber?: string | null;
  allocations: { invoiceId: string; invoiceNumber: string | null; amount: number }[];
  createdBy: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface CustomerAdjustmentListParams extends Q {
  customerId?: string;
  status?: string;
  kind?: string;
  from?: LocalDate;
  to?: LocalDate;
  page?: number;
  limit?: number;
}

export interface CustomerAdjustmentPage { items: CustomerAdjustmentView[]; total: number; page?: number; limit?: number }

export interface OpenInvoiceView {
  invoiceId: string;
  number: string;
  invoiceDate: LocalDate;
  dueDate: LocalDate | null;
  total: number;
  remaining: number;
}

export interface CustomerOpenItems {
  customerId: string;
  customerName: string | null;
  currencyDecimals: number;
  invoices: OpenInvoiceView[];
  truncated: boolean;
  balance: number;
  debitBalance: number;
  creditBalance: number;
  /** أول يوم تقبله التسويات (linkedFrom ثم cutoverDate) */
  linkedFrom: LocalDate | null;
}

export interface CreateCustomerAdjustmentInput {
  customerId: string;
  kind: CustomerAdjustmentKind;
  /** نص عشري من الملّي */
  amount: string;
  docDate: LocalDate;
  counter?: WriteoffCounter;
  method?: RefundMethod;
  allocations?: { invoiceId: string; amount: string }[];
  autoAllocate?: boolean;
  reference?: string;
  note?: string;
}

// ═══ التسوية الموجّهة للحسابات الوسيطة (العقد §5.2، C3/C5) ═══

export const CLEARING_KINDS = ['POS_SETTLEMENT', 'CARD_SETTLEMENT', 'CHEQUE_CLEARANCE', 'DEPOSIT_CLEARANCE'] as const;
export type ClearingKind = (typeof CLEARING_KINDS)[number];

export interface ClearingOpenLineView {
  lineId: string;
  moveId: string;
  moveNumber: string | null;
  date: LocalDate;
  label: string | null;
  amount: number;
  residual: number;
}

export interface ClearingOpenView {
  kind: ClearingKind;
  account: AccountBrief & { isActive: boolean };
  currency: string;
  decimals: number;
  /** رصيد الحساب الوسيط المرحَّل */
  balance: number;
  lines: ClearingOpenLineView[];
  /** Σ المتبقّي لكل السطور المفتوحة (لا المعروضة وحدها) */
  total: number;
  count: number;
  truncated: boolean;
  /** الحسابات المستلِمة المقبولة: نقد/بنك نشط غير رئيسي */
  bankAccounts: AccountBrief[];
}

export interface ClearingInput {
  kind: ClearingKind;
  date: LocalDate;
  bankAccountId: string;
  gross: string;
  fee?: string;
  feeVat?: string;
  ref?: string;
  note?: string;
  lineIds?: string[];
}

export interface ClearingResult {
  moveId: string;
  moveNumber: string;
  date: LocalDate;
  kind: ClearingKind;
  clearingAccount: AccountBrief;
  bankAccountId: string;
  gross: number;
  fee: number;
  feeVat: number;
  net: number;
  sourceRef: string;
  matched: { lineId: string; moveId: string; amount: number }[];
  matchedTotal: number;
}

// ═══ شرح فرق عهدة المندوب (OD3) وعهدة مستخدمي الشركة (C4u، OD5) ═══

export type CustodyExplainKind =
  | 'OPENING' | 'ONLINE' | 'OUTSIDE' | 'STAMPED_OUTSIDE' | 'EXPENSE' | 'SHORTAGE' | 'SHORTAGE_EXPENSED' | 'SETTLEMENT_R'
  | 'CANCEL_REFUND_OUTSIDE' | 'CASH_INVOICE_CUSTODY';

export interface CustodyExplainItemView {
  kind: CustodyExplainKind | string;
  refId: string;
  /** ISO للحظة الأثر؛ فارغ لبند الافتتاح */
  at: string;
  /** موقَّع: موجب يرفع الشاشة التشغيلية على الأستاذ */
  amountMilli: string;
}

export interface CustodyExplanationView {
  salesRepId: string;
  name: string | null;
  opsMilli: string;
  /** عهدة الأستاذ المتوقَّعة (ledgerCustody) */
  ledgerMilli: string;
  /** رصيد 111003 الفعلي للمندوب */
  ledgerActualMilli: string;
  c4GapMilli: string;
  items: CustodyExplainItemView[];
  totalMilli: string;
  unexplainedMilli: string;
}

export interface CustodyExplainResponse {
  activated: boolean;
  manualLedger?: boolean;
  lastSyncAt?: string | null;
  currencyDecimals?: number;
  explanation: CustodyExplanationView | null;
}

export interface UserCustodyRow {
  userId: string;
  name: string | null;
  isActive: boolean;
  /** رصيد 111004 للمستخدم (بُعد adminUserId) */
  ledgerMilli: string;
  /** العهدة التشغيلية (foldUserCustody: النقد والشيكات وحدها) */
  opsOutstandingMilli: string;
  c4uGapMilli: string;
}

export interface UserCustodyView {
  activated: boolean;
  linked: boolean;
  manualLedger?: boolean;
  lastSyncAt?: string | null;
  currencyDecimals?: number;
  /** أحداث استلام/توريد غير نهائية — فرقٌ معها قد يكون عابراً */
  pendingEvents?: number;
  users: UserCustodyRow[];
  totals: { ledgerMilli: string; opsOutstandingMilli: string; c4uGapMilli: string } | null;
}

// ═══ إلغاء سند القبض: من أين رُدّ المال؟ (C11، routes/receipts.ts) ═══

export const CANCEL_REFUND_SOURCES = ['REP_CUSTODY', 'USER_CUSTODY', 'MAIN_CASH', 'BANK', 'METHOD'] as const;
export type CancelRefundFrom = (typeof CANCEL_REFUND_SOURCES)[number];
export type CancelCustodyClass = 'CUSTODY' | 'ONLINE' | 'OUTSIDE';

export interface CancelRefundOptionView {
  value: CancelRefundFrom;
  /** اسم الخادم العربي — الواجهة تترجم بالمفتاح value */
  label?: string;
  userId?: string;
  userName?: string | null;
  userOutstanding?: number;
}

export interface ReceiptCancelOptions {
  linked: boolean;
  custodyClass: CancelCustodyClass;
  handedOver: boolean;
  suggested: CancelRefundFrom | null;
  suggestedUserId: string | null;
  repOutstanding: number | null;
  options: CancelRefundOptionView[];
}

/** جسم PATCH /receipts/:id/cancel الاختياري — يُرسل حين يظهر المنتقي وحده (cancelRequestBody) */
export interface ReceiptCancelBody { refundFrom: CancelRefundFrom; refundFromUserId?: string }

// ═══ منتقي الشريك (GET /ledger/partners/search) ═══

export interface PartnerSearchItem { id: string; name: string; hint: string | null }

// ═══ النقاط ═══

const L = '/ledger';

export const ledgerOpsApi = {
  paymentMethods: {
    list: () => api.get<LedgerEnvelope<PaymentMethodMapView>>(`${L}/config/payment-methods`),
    set: (methodKey: string, data: PaymentMethodMapInput) =>
      api.put<LedgerEnvelope<PaymentMethodMapView>>(`${L}/config/payment-methods/${encodeURIComponent(methodKey)}`, data),
    /** يعيد الافتراضي (متساوي الأثر) */
    reset: (methodKey: string) => api.delete<LedgerEnvelope<PaymentMethodMapView>>(`${L}/config/payment-methods/${encodeURIComponent(methodKey)}`),
  },

  adjustments: {
    list: (params?: CustomerAdjustmentListParams) =>
      api.get<LedgerEnvelope<CustomerAdjustmentPage>>(`${L}/customer-adjustments`, { params: clean(params) }),
    get: (id: string) => api.get<LedgerEnvelope<CustomerAdjustmentView>>(`${L}/customer-adjustments/${encodeURIComponent(id)}`),
    openItems: (customerId: string) =>
      api.get<LedgerEnvelope<CustomerOpenItems>>(`${L}/customer-adjustments/open-items`, { params: { customerId } }),
    create: (data: CreateCustomerAdjustmentInput) => api.post<LedgerEnvelope<CustomerAdjustmentView>>(`${L}/customer-adjustments`, data),
    /** السبب إلزامي (422 LEDGER_REVERSAL_REASON_REQUIRED) */
    cancel: (id: string, reason: string) =>
      api.post<LedgerEnvelope<CustomerAdjustmentView>>(`${L}/customer-adjustments/${encodeURIComponent(id)}/cancel`, { reason }),
  },

  clearing: {
    open: (kind: ClearingKind) => api.get<LedgerEnvelope<ClearingOpenView>>(`${L}/clearing/open`, { params: { kind } }),
    post: (data: ClearingInput) => api.post<LedgerEnvelope<ClearingResult>>(`${L}/clearing`, data),
  },

  custody: {
    explain: (salesRepId: string) =>
      api.get<LedgerEnvelope<CustodyExplainResponse>>(`${L}/customers/custody/${encodeURIComponent(salesRepId)}/explain`),
    users: () => api.get<LedgerEnvelope<UserCustodyView>>(`${L}/customers/user-custody`),
  },

  partners: {
    /** بحث العملاء بصلاحية عرض الدفاتر وحدها (المحاسب بلا صلاحية تشغيلية) — حدّ 20 */
    customers: (q: string) =>
      api.get<LedgerEnvelope<{ type: string; items: PartnerSearchItem[] }>>(`${L}/partners/search`, { params: clean({ type: 'customer', q }) }),
  },
};

export const ledgerOpsKeys = {
  paymentMethods: ['ledger', 'config', 'payment-methods'] as const,
  adjustments: (params?: unknown) => ['ledger', 'customer-adjustments', params ?? {}] as const,
  adjustmentOpenItems: (customerId: string) => ['ledger', 'customer-adjustments', 'open-items', customerId] as const,
  clearingOpen: (kind: ClearingKind) => ['ledger', 'clearing', 'open', kind] as const,
  custodyExplain: (salesRepId: string) => ['ledger', 'customers', 'custody', 'explain', salesRepId] as const,
  userCustody: ['ledger', 'customers', 'user-custody'] as const,
  customerSearch: (q: string) => ['ledger', 'partners', 'customer', q] as const,
  receiptCancelOptions: (receiptId: string) => ['receipts', 'cancel-options', receiptId] as const,
};
