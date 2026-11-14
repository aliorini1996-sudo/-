import type { LedgerEnvelope } from './ledgerConfig';

/**
 * عميل تقارير الشركاء من الدفاتر — «ربط الدفاتر» L8 (عقد L4/L5/L8 §6.2 و§6.3)، مُوفَّق حرفياً مع
 * `backend/src/routes/ledger/partnerReports.ts` و`sourceAttachments.ts`:
 *
 * - `GET /ledger/reports/<key>` لكل من: دفتر أستاذ الشريك، وأعمار الذمم المدينة والدائنة، والمستندات التي وصلت متأخرة،
 *   وتقرير الأصناف. والتصدير `POST /ledger/reports/<key>/export` تناديه وحدة التصدير القائمة (`reports/exportReport.ts`)
 *   بالخيارات نفسها مضافاً إليها `format` — فلا يُصدَّر ما على الشاشة أبداً.
 * - `GET /ledger/partners/search?type=&q=` لمنتقي الشريك والصنف (حدّ 20)، بصلاحية عرض الدفاتر وحدها.
 * - `GET /ledger/source-attachments?sourceType=&sourceId=` و`GET /ledger/source-attachments/:kind/:id` لمرفقات المستند المصدر.
 *
 * **المبالغ أرقام بوحدة العملة** (القاعدة 5 في العقد: `fromMilli` في الخادم)؛ والجمع والطرح هنا بالملّي (`toMilli`) لا بالعائم.
 *
 * الملف **صرف** يُختبر في node: عميل HTTP يُحمَّل كسولاً داخل كل نداء (`api/client` يلمس `import.meta.env` وlocalStorage
 * عند الاستيراد)، والأنواع وحدها من `ledgerConfig`.
 */

type Tr = (ar: string) => string;
export type LocalDate = string;

const L = '/ledger';
const http = async () => (await import('./client')).default;

// ═══ المفاتيح والثوابت (مرآة الخادم) ═══

export const PARTNER_REPORT_KEYS = ['partner-ledger', 'aged-receivable', 'aged-payable', 'late-arrivals', 'product-ledger'] as const;
export type PartnerReportKey = (typeof PARTNER_REPORT_KEYS)[number];

/** أنواع الشريك وحساباته: العميل AR، والمورّد AP، والمندوب عهدة 111003 (salesRepId)، ومستخدم الشركة عهدة 111004 (adminUserId) */
export const PARTNER_TYPES = ['customer', 'vendor', 'rep', 'user'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];
export const PARTNER_SEARCH_TYPES = [...PARTNER_TYPES, 'product'] as const;
export type PartnerSearchType = (typeof PARTNER_SEARCH_TYPES)[number];

export const AGING_BASES = ['due', 'date'] as const;
export type AgingBasis = (typeof AGING_BASES)[number];
export const DEFAULT_AGING_BUCKETS: readonly number[] = [30, 60, 90, 120];
export const AGING_BUCKET_KEYS = ['notDue', 'b1', 'b2', 'b3', 'b4', 'older'] as const;
export type AgingBucketKey = (typeof AGING_BUCKET_KEYS)[number];

/** مصادر المرفقات (`ATTACHMENT_SOURCE_TYPES` في sourceAttachments.ts) — غيرها (قيد يدوي) مرفقاته في شاشة القيد نفسه */
export const ATTACHMENT_SOURCE_TYPES = [
  'RECEIPT', 'SETTLEMENT', 'USER_SETTLEMENT', 'INVOICE', 'WH_ENTRY', 'CUSTOMER',
  'AR_ENTRY', 'CUSTOMER_ADJUSTMENT', 'PAYLINK_FEE', 'PAYOUT', 'PAYLINK_REFUND', 'VAN_LOAD',
] as const;
export type AttachmentSourceType = (typeof ATTACHMENT_SOURCE_TYPES)[number];

export const ATTACHMENT_KINDS = [
  'RECEIPT_PHOTO', 'REP_SETTLEMENT_PHOTO', 'USER_SETTLEMENT_PHOTO', 'INVOICE_SIGNATURE', 'WAREHOUSE_ATTACHMENT',
  'CUSTOMER_DOCUMENT', 'LEDGER_ATTACHMENT',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const isPartnerType = (v: unknown): v is PartnerType => typeof v === 'string' && (PARTNER_TYPES as readonly string[]).includes(v);
export const isAttachmentSourceType = (v: unknown): v is AttachmentSourceType =>
  typeof v === 'string' && (ATTACHMENT_SOURCE_TYPES as readonly string[]).includes(v);
export const isAttachmentKind = (v: unknown): v is AttachmentKind => typeof v === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(v);

// ═══ الردود ═══

export interface PartnerReportSettings {
  currency: string;
  currencyDecimals: number;
  timezone: string;
  /** الدفاتر مربوطة: المطابقة الآلية والإيراد لكل صنف قائمان */
  linked: boolean;
}

export interface PartnerReportWarning {
  /** RPT‑08 (`UNPOSTED_ENTRIES`…)، و`RECONCILE_NOT_ACTIVE`، و`PRODUCT_LINES_LINKED_ONLY` */
  code: string;
  /** نص الخادم العربي — يُعرض حين لا تسمية مترجمة لرمزه */
  message: string;
  details?: Record<string, unknown>;
}

interface PartnerReportBase {
  settings: PartnerReportSettings;
  warnings: PartnerReportWarning[];
}

export interface PartnerLedgerMatch {
  lineId: string;
  moveId: string | null;
  moveNumber: string | null;
  amount: number;
}

export interface LineAttachments { count: number; kinds: string[] }

export interface PartnerLedgerLine {
  lineId: string;
  moveId: string;
  moveNumber: string | null;
  date: LocalDate;
  journalCode: string | null;
  ref: string | null;
  label: string | null;
  sourceType: string | null;
  sourceId: string | null;
  debit: number;
  credit: number;
  /** الرصيد الجاري (مدين − دائن) من الافتتاح حتى السطر */
  balance: number;
  dueDate: LocalDate | null;
  /** موقَّع: مدين مفتوح موجب، ودائن مفتوح سالب، والمطابَق كلياً صفر */
  residual: number;
  fullyReconciled: boolean;
  matches: PartnerLedgerMatch[];
  productId: string | null;
  productName: string | null;
  quantity: number | null;
  attachments: LineAttachments;
}

export interface PartnerLedgerData extends PartnerReportBase {
  reportKey: 'partner-ledger';
  partner: { type: PartnerType; id: string; name: string | null };
  currency: string;
  decimals: number;
  from: LocalDate;
  to: LocalDate;
  includeReconciled: boolean;
  opening: number;
  closing: number;
  totalDebit: number;
  totalCredit: number;
  lines: PartnerLedgerLine[];
  /** وثائق العميل في «استديو العميل» (customer_documents) — للعميل وحده */
  documents: { count: number };
  pagination: { page: number; pageSize: number | null; total: number; pages: number; paginated: boolean };
  lineCount: number;
}

export interface AgingColumns {
  notDue: number;
  b1: number;
  b2: number;
  b3: number;
  b4: number;
  older: number;
  /** سالب: البنود المفتوحة على الجانب المعاكس (رصيد دائن للعميل، دفعة مقدمة للمورد) */
  unappliedCredits: number;
  total: number;
}

export interface AgingRow extends AgingColumns {
  partnerId: string;
  name: string | null;
}

export interface AgingDetailLine {
  lineId: string | null;
  moveId: string | null;
  moveNumber: string | null;
  date: LocalDate;
  dueDate: LocalDate | null;
  daysOverdue: number;
  residual: number;
  bucket: AgingBucketKey | 'unapplied';
}

export interface AgingData extends PartnerReportBase {
  reportKey: 'aged-receivable' | 'aged-payable';
  kind: 'AR' | 'AP';
  partnerId: string | null;
  asOf: LocalDate;
  basis: AgingBasis;
  buckets: number[];
  rows: AgingRow[];
  totals: AgingColumns;
  /** لشريك واحد (`partnerId`) */
  detail?: AgingDetailLine[];
}

export type LateArrivalReason = 'PERIOD_LOCKED' | 'AFTER_CUTOVER';

export interface LateArrivalRow {
  moveId: string;
  moveNumber: string | null;
  sourceType: string | null;
  sourceId: string | null;
  ref: string | null;
  partnerName: string | null;
  originalDate: LocalDate;
  postedDate: LocalDate;
  reason: LateArrivalReason | string;
  amount: number;
}

export interface LateArrivalsData extends PartnerReportBase {
  reportKey: 'late-arrivals';
  from: LocalDate;
  to: LocalDate;
  /** بداية الدفاتر (linkedFrom ثم cutoverDate) */
  cutoverDate: LocalDate | null;
  rows: LateArrivalRow[];
  total: number;
  count: number;
}

export interface ProductLedgerColumns {
  quantity: number;
  soldQuantity: number;
  returnedQuantity: number;
  revenue: number;
  discount: number;
  returns: number;
  net: number;
}

export interface ProductLedgerRow extends ProductLedgerColumns {
  productId: string;
  productName: string | null;
}

export interface ProductLedgerData extends PartnerReportBase {
  reportKey: 'product-ledger';
  from: LocalDate;
  to: LocalDate;
  filters: { productId: string | null; customerId: string | null; salesRepId: string | null };
  rows: ProductLedgerRow[];
  totals: ProductLedgerColumns;
}

export interface PartnerReportDataMap {
  'partner-ledger': PartnerLedgerData;
  'aged-receivable': AgingData;
  'aged-payable': AgingData;
  'late-arrivals': LateArrivalsData;
  'product-ledger': ProductLedgerData;
}

// ═══ المعاملات ═══

export interface PartnerLedgerParams {
  partnerType: PartnerType;
  partnerId: string;
  from?: LocalDate;
  to?: LocalDate;
  includeReconciled?: boolean;
  page?: number;
  pageSize?: number;
}

export interface AgingParams {
  asOf?: LocalDate;
  basis?: AgingBasis;
  /** «30,60,90,120» */
  buckets?: string;
  partnerId?: string;
}

export interface RangeParams { from?: LocalDate; to?: LocalDate }

export interface ProductLedgerParams extends RangeParams {
  productId?: string;
  customerId?: string;
  salesRepId?: string;
}

export interface PartnerReportParamsMap {
  'partner-ledger': PartnerLedgerParams;
  'aged-receivable': AgingParams;
  'aged-payable': AgingParams;
  'late-arrivals': RangeParams;
  'product-ledger': ProductLedgerParams;
}

export interface PartnerSearchItem { id: string; name: string; hint: string | null }

export interface SourceAttachmentItem {
  kind: AttachmentKind;
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface SourceAttachmentList { sourceType: AttachmentSourceType; sourceId: string; items: SourceAttachmentItem[] }

/** `data` = data URL كامل */
export interface SourceAttachmentContent { data: string; mime: string; name: string }

type QValue = string | number | boolean | null | undefined;

/** يحذف الفارغ (`undefined` و`null` و`''`) فلا يصير معامل بلا قيمة فلتراً. صرفة. */
export function cleanPartnerParams<T extends object>(params: T | null | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!params) return out;
  for (const [k, v] of Object.entries(params as Record<string, QValue>)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

// ═══ النقاط ═══

export const ledgerPartnersApi = {
  /** `GET /reports/<key>` — canViewLedger. التصدير عبر `runReportExport` (reports/exportReport.ts) */
  report: async <K extends PartnerReportKey>(key: K, params: PartnerReportParamsMap[K]) => { const api = await http(); return api.get<LedgerEnvelope<PartnerReportDataMap[K]>>(`${L}/reports/${key}`, { params: cleanPartnerParams(params) }); },
  /** منتقي الشريك والصنف — canViewLedger، حدّ 20 */
  search: async (type: PartnerSearchType, q: string) => { const api = await http(); return api.get<LedgerEnvelope<{ type: PartnerSearchType; items: PartnerSearchItem[] }>>(`${L}/partners/search`, { params: cleanPartnerParams({ type, q: q.trim() }) }); },
  attachments: {
    /** بيانات وصفية بلا المحتوى */
    list: async (sourceType: AttachmentSourceType, sourceId: string) => { const api = await http(); return api.get<LedgerEnvelope<SourceAttachmentList>>(`${L}/source-attachments`, { params: { sourceType, sourceId } }); },
    /** المحتوى (data URL)؛ `sourceId` يثبت انتماء المرفق لمصدره في الخادم */
    content: async (kind: AttachmentKind, id: string, sourceId?: string | null) => { const api = await http(); return api.get<LedgerEnvelope<SourceAttachmentContent>>(`${L}/source-attachments/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { params: cleanPartnerParams({ sourceId }) }); },
  },
};

export const ledgerPartnersKeys = {
  all: ['ledger', 'partner-report'] as const,
  report: (key: PartnerReportKey, params: unknown) => ['ledger', 'partner-report', key, params ?? {}] as const,
  search: (type: PartnerSearchType, q: string) => ['ledger', 'partners', 'search', type, q] as const,
  attachments: (sourceType: string, sourceId: string) => ['ledger', 'source-attachments', sourceType, sourceId] as const,
  attachment: (kind: string, id: string) => ['ledger', 'source-attachments', 'content', kind, id] as const,
};

// ═══ المبالغ بالملّي (لا جمع عائم) ═══

/** رقم بوحدة العملة (≤ 3 منازل من الخادم) ⇒ ملّي صحيح. صرفة. */
export function toMilli(n: number | null | undefined): bigint {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 1000));
}

/** ملّي ⇒ رقم بوحدة العملة (للعرض بـLedgerAmount وللتصدير). صرفة. */
export const fromMilliNumber = (m: bigint): number => Number(m) / 1000;

/**
 * «رصيد مُرحَّل» أعلى صفحة من دفتر الشريك = الرصيد الجاري قبل أول سطر فيها (رصيد السطر − مدينه + دائنه)،
 * وفي الصفحة الأولى = الافتتاح. بالملّي، فيبقى «المُرحَّل + حركة الصفحة = رصيد آخر سطر» تاماً. صرفة.
 */
export function carriedBalance(data: Pick<PartnerLedgerData, 'opening' | 'lines'> & { pagination?: { page: number } }): number {
  const first = data.lines[0];
  if (!first || (data.pagination?.page ?? 1) <= 1) return data.opening;
  return fromMilliNumber(toMilli(first.balance) - toMilli(first.debit) + toMilli(first.credit));
}

/** «الافتتاح + المدين − الدائن = الختام» على ردّ الخادم بالملّي — ثابت يحرسه الاختبار ويُنبَّه عليه في الشاشة. صرفة. */
export function partnerLedgerBalanced(d: Pick<PartnerLedgerData, 'opening' | 'closing' | 'totalDebit' | 'totalCredit'>): boolean {
  return toMilli(d.opening) + toMilli(d.totalDebit) - toMilli(d.totalCredit) === toMilli(d.closing);
}

/** صفّ الأعمار: مجموع الأعمدة والأرصدة غير المخصّصة = الإجمالي (بالملّي). صرفة. */
export function agingRowBalanced(r: AgingColumns): boolean {
  const sum = AGING_BUCKET_KEYS.reduce((s, k) => s + toMilli(r[k]), 0n) + toMilli(r.unappliedCredits);
  return sum === toMilli(r.total);
}

// ═══ الحالة في عنوان الصفحة (رابط قابل للمشاركة) ═══

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: string | null): v is string => !!v && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const idOf = (v: string | null): string | null => (v && v.trim() !== '' && v.length <= 64 ? v.trim() : null);
const nameOf = (v: string | null): string | null => (v && v.trim() !== '' ? v.trim().slice(0, 120) : null);

export interface PartnerLedgerState {
  type: PartnerType;
  partnerId: string | null;
  /** اسمٌ مؤقت للعرض قبل وصول الردّ (يكتبه المنتقي أو رابط التعمّق) */
  partnerName: string | null;
  from: LocalDate | null;
  to: LocalDate | null;
  includeReconciled: boolean;
  page: number;
}

/** `?type=customer&partner=<id>&pname=&from=&to=&reconciled=0&page=2` ⇒ الحالة. صرفة. */
export function readPartnerLedgerState(search: string | URLSearchParams): PartnerLedgerState {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search;
  const type = sp.get('type');
  const page = Number(sp.get('page'));
  return {
    type: isPartnerType(type) ? type : 'customer',
    partnerId: idOf(sp.get('partner')),
    partnerName: nameOf(sp.get('pname')),
    from: isDate(sp.get('from')) ? sp.get('from') : null,
    to: isDate(sp.get('to')) ? sp.get('to') : null,
    includeReconciled: sp.get('reconciled') !== '0',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** الحالة ⇒ معاملات العنوان (الافتراضي لا يُكتب). صرفة. */
export function partnerLedgerSearch(s: PartnerLedgerState): Record<string, string> {
  const out: Record<string, string> = { type: s.type };
  if (s.partnerId) out.partner = s.partnerId;
  if (s.partnerId && s.partnerName) out.pname = s.partnerName;
  if (s.from) out.from = s.from;
  if (s.to) out.to = s.to;
  if (!s.includeReconciled) out.reconciled = '0';
  if (s.page > 1) out.page = String(s.page);
  return out;
}

/** معاملات النقطة — `null` حين لا شريك (لا طلب). صرفة. */
export function partnerLedgerParams(s: PartnerLedgerState): PartnerLedgerParams | null {
  if (!s.partnerId) return null;
  return {
    partnerType: s.type,
    partnerId: s.partnerId,
    ...(s.from ? { from: s.from } : {}),
    ...(s.to ? { to: s.to } : {}),
    ...(s.includeReconciled ? {} : { includeReconciled: false }),
    ...(s.page > 1 ? { page: s.page } : {}),
  };
}

/** رابط دفتر الشريك (تعمّق من الأعمار أو من أي شاشة). صرفة. */
export function partnerLedgerHref(p: { type: PartnerType; id: string; name?: string | null; from?: string | null; to?: string | null }): string {
  const sp = new URLSearchParams(partnerLedgerSearch({
    type: p.type, partnerId: p.id, partnerName: p.name ?? null, from: p.from ?? null, to: p.to ?? null, includeReconciled: true, page: 1,
  }));
  return `/app/ledger/reports/partner-ledger?${sp.toString()}`;
}

/**
 * «30,60,90,120» ⇒ أربعة أعداد صحيحة موجبة متزايدة تماماً (≤ 3650) — مرآة `parseAgingBuckets` في الخادم،
 * فلا يُرسل ما يرفضه بـ400. الفارغ ⇒ الافتراضي، وغير الصالح ⇒ null. صرفة.
 */
export function parseAgingBucketsInput(raw: string | null | undefined): number[] | null {
  if (raw === null || raw === undefined || raw.trim() === '') return [...DEFAULT_AGING_BUCKETS];
  const parts = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[،\s]+/g, ',').split(',').filter((p) => p !== '');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,4}$/.test(p)) return null;
    const n = Number(p);
    if (n <= 0 || n > 3650) return null;
    if (out.length > 0 && n <= out[out.length - 1]) return null;
    out.push(n);
  }
  return out;
}

export interface AgingState {
  asOf: LocalDate | null;
  basis: AgingBasis;
  /** كما في العنوان (صالح أو الافتراضي) */
  buckets: number[];
  partnerId: string | null;
  partnerName: string | null;
}

export function readAgingState(search: string | URLSearchParams): AgingState {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search;
  const basis = sp.get('basis');
  return {
    asOf: isDate(sp.get('asOf')) ? sp.get('asOf') : null,
    basis: basis === 'date' ? 'date' : 'due',
    buckets: parseAgingBucketsInput(sp.get('buckets')) ?? [...DEFAULT_AGING_BUCKETS],
    partnerId: idOf(sp.get('partner')),
    partnerName: nameOf(sp.get('pname')),
  };
}

const sameBuckets = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function agingSearch(s: AgingState): Record<string, string> {
  const out: Record<string, string> = {};
  if (s.asOf) out.asOf = s.asOf;
  if (s.basis !== 'due') out.basis = s.basis;
  if (!sameBuckets(s.buckets, DEFAULT_AGING_BUCKETS)) out.buckets = s.buckets.join(',');
  if (s.partnerId) out.partner = s.partnerId;
  if (s.partnerId && s.partnerName) out.pname = s.partnerName;
  return out;
}

export function agingParams(s: AgingState): AgingParams {
  return {
    ...(s.asOf ? { asOf: s.asOf } : {}),
    ...(s.basis !== 'due' ? { basis: s.basis } : {}),
    ...(sameBuckets(s.buckets, DEFAULT_AGING_BUCKETS) ? {} : { buckets: s.buckets.join(',') }),
    ...(s.partnerId ? { partnerId: s.partnerId } : {}),
  };
}

export interface ProductLedgerState {
  from: LocalDate | null;
  to: LocalDate | null;
  productId: string | null;
  productName: string | null;
  customerId: string | null;
  customerName: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
}

export function readRangeState(search: string | URLSearchParams): { from: LocalDate | null; to: LocalDate | null } {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search;
  return { from: isDate(sp.get('from')) ? sp.get('from') : null, to: isDate(sp.get('to')) ? sp.get('to') : null };
}

export function rangeParams(s: { from: LocalDate | null; to: LocalDate | null }): RangeParams {
  return { ...(s.from ? { from: s.from } : {}), ...(s.to ? { to: s.to } : {}) };
}

export function readProductLedgerState(search: string | URLSearchParams): ProductLedgerState {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search;
  const productId = idOf(sp.get('product'));
  const customerId = idOf(sp.get('customer'));
  const salesRepId = idOf(sp.get('rep'));
  return {
    ...readRangeState(sp),
    productId, productName: productId ? nameOf(sp.get('productName')) : null,
    customerId, customerName: customerId ? nameOf(sp.get('customerName')) : null,
    salesRepId, salesRepName: salesRepId ? nameOf(sp.get('repName')) : null,
  };
}

export function productLedgerSearch(s: ProductLedgerState): Record<string, string> {
  const out: Record<string, string> = {};
  if (s.from) out.from = s.from;
  if (s.to) out.to = s.to;
  if (s.productId) { out.product = s.productId; if (s.productName) out.productName = s.productName; }
  if (s.customerId) { out.customer = s.customerId; if (s.customerName) out.customerName = s.customerName; }
  if (s.salesRepId) { out.rep = s.salesRepId; if (s.salesRepName) out.repName = s.salesRepName; }
  return out;
}

export function productLedgerParams(s: ProductLedgerState): ProductLedgerParams {
  return {
    ...rangeParams(s),
    ...(s.productId ? { productId: s.productId } : {}),
    ...(s.customerId ? { customerId: s.customerId } : {}),
    ...(s.salesRepId ? { salesRepId: s.salesRepId } : {}),
  };
}

// ═══ التسميات (بنداءات tr حرفية — حارس langs.test) ═══

export const partnerTypeLabels = (tr: Tr): Record<PartnerType, string> => ({
  customer: tr('عميل'),
  vendor: tr('مورّد'),
  rep: tr('مندوب'),
  user: tr('مستخدم الشركة'),
});

/** تلميح منتقي مستخدمي الشركة: الخادم يعيد رمز الدور (لا البريد) — يُعرض بتسميته */
export function partnerHintText(type: PartnerSearchType, hint: string | null, tr: Tr): string | null {
  if (!hint) return null;
  if (type !== 'user') return hint;
  const roles: Record<string, string> = { ADMIN: tr('مدير'), MANAGER: tr('مشرف'), ACCOUNTANT: tr('محاسب') };
  return roles[hint] ?? hint;
}

/** عنوان كل تقرير — يطابق عناصر قائمة «إعداد التقارير ← الشركاء» */
export const partnerReportTitles = (tr: Tr): Record<PartnerReportKey, string> => ({
  'partner-ledger': tr('دفتر أستاذ الشركاء'),
  'aged-receivable': tr('أعمار الذمم المدينة'),
  'aged-payable': tr('أعمار الذمم الدائنة'),
  'late-arrivals': tr('مستندات وصلت متأخرة (تقرير)'),
  'product-ledger': tr('تقرير الأصناف من الدفاتر'),
});

export const agingBasisLabels = (tr: Tr): Record<AgingBasis, string> => ({
  due: tr('حسب تاريخ الاستحقاق'),
  date: tr('حسب تاريخ المستند'),
});

/** عناوين أعمدة الأعمار من حدودها: «1–30» … «أقدم من 120». صرفة. */
export function agingColumnLabels(buckets: readonly number[], tr: Tr, kind: 'AR' | 'AP'): Record<AgingBucketKey | 'unappliedCredits' | 'total', string> {
  const b = buckets.length === 4 ? buckets : DEFAULT_AGING_BUCKETS;
  return {
    notDue: tr('غير مستحق'),
    b1: `1–${b[0]}`,
    b2: `${b[0] + 1}–${b[1]}`,
    b3: `${b[1] + 1}–${b[2]}`,
    b4: `${b[2] + 1}–${b[3]}`,
    older: `${tr('أقدم من')} ${b[3]}`,
    unappliedCredits: kind === 'AR' ? tr('أرصدة دائنة غير مخصّصة') : tr('دفعات مقدمة غير مخصّصة'),
    total: tr('الإجمالي'),
  };
}

export const lateArrivalReasonLabels = (tr: Tr): Record<LateArrivalReason, string> => ({
  PERIOD_LOCKED: tr('تاريخه في فترة مقفلة'),
  AFTER_CUTOVER: tr('تاريخه قبل بداية الدفاتر'),
});

export const attachmentKindLabels = (tr: Tr): Record<AttachmentKind, string> => ({
  RECEIPT_PHOTO: tr('صورة السند'),
  REP_SETTLEMENT_PHOTO: tr('صورة الاستلام'),
  USER_SETTLEMENT_PHOTO: tr('صورة التوريد'),
  INVOICE_SIGNATURE: tr('توقيع الفاتورة'),
  WAREHOUSE_ATTACHMENT: tr('مرفق حركة المستودع'),
  CUSTOMER_DOCUMENT: tr('وثيقة العميل'),
  LEDGER_ATTACHMENT: tr('مرفق القيد'),
});

/** أسباب نقاط تقارير الشركاء والمرفقات (`reason` في جسم الخطأ) — نصّ يقول ما العمل */
export const partnerReportReasonLabels = (tr: Tr): Record<string, string> => ({
  PARTNER_NOT_FOUND: tr('الشريك غير موجود في هذه الشركة: اختره من المنتقي من جديد'),
  INVALID_BUCKETS: tr('أعمدة الأعمار أربعة أعداد صحيحة موجبة متزايدة مثل 30,60,90,120'),
  INVALID_RANGE: tr('تاريخ النهاية يسبق تاريخ البداية'),
  SOURCE_NOT_FOUND: tr('المستند المصدر غير موجود في هذه الشركة'),
  SOURCE_ID_REQUIRED: tr('المستند المصدر غير موجود في هذه الشركة'),
  ATTACHMENT_NOT_FOUND: tr('المرفق غير موجود'),
  INVALID_KIND: tr('المرفق غير موجود'),
});

export const partnerReportCodeLabels = (tr: Tr): Record<string, string> => ({
  // سطور الشريك (دفتر الأستاذ) أو القيود المتأخرة فوق 50,000 في المدى — النصّ نفسه في وحدة التصدير
  LEDGER_RANGE_TOO_LARGE: tr('المدى المطلوب أكبر من حدّ التقرير المفلتر: ضيّق الفترة أو قلّل الفلاتر'),
});

/** تنبيهات الخادم: رموز التقارير الجديدة بنصّ مترجم، وما عداها (RPT‑08) برسالته كما في القشرة القائمة. صرفة. */
export function partnerWarningText(w: PartnerReportWarning, tr: Tr): string {
  if (w.code === 'RECONCILE_NOT_ACTIVE') return tr('المطابقة الآلية بين الفواتير والسندات تعمل في الدفاتر المربوطة وحدها: البنود غير المطابَقة تظهر مفتوحة بتواريخها');
  if (w.code === 'PRODUCT_LINES_LINKED_ONLY') return tr('الإيراد لكل صنف يُرحَّل في الدفاتر المربوطة وحدها');
  return w.message;
}

/** المسودات والأحداث المعلّقة تحذير، وما عداها خبر. صرفة. */
export const partnerWarningTone = (code: string): 'amber' | 'blue' =>
  (code === 'UNPOSTED_ENTRIES' || code === 'STOCK_EVENTS_PENDING' ? 'amber' : 'blue');

// ═══ المرفقات ═══

export type AttachmentPreview = 'image' | 'pdf' | 'download';

/**
 * طريقة العرض من نوع المحتوى: صور الويب الآمنة في `<img>`، وPDF في `<object>`، وغيرهما (ومنه SVG الذي يحمل نصاً برمجياً)
 * تنزيلٌ فقط. صرفة.
 */
export function attachmentPreviewKind(mime: string | null | undefined): AttachmentPreview {
  const m = (mime ?? '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'image/jpeg' || m === 'image/jpg' || m === 'image/png' || m === 'image/webp' || m === 'image/gif') return 'image';
  return 'download';
}

/** حجم مقروء: «12 KB» / «1.4 MB». صرفة. */
export function formatBytes(size: number | null | undefined): string {
  const b = Number(size ?? 0);
  if (!Number.isFinite(b) || b <= 0) return '0 KB';
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

/**
 * data URL ⇒ بايتات بنوعها (لـBlob ورابط كائن: المتصفح يمنع فتح data URL مباشرة، وPDF يُعرض من blob).
 * يقبل base64 وغيره؛ غير الصالح ⇒ null. صرفة.
 */
export function decodeDataUrl(dataUrl: string | null | undefined): { mime: string; bytes: Uint8Array } | null {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const head = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = (head.split(';')[0] || 'application/octet-stream').toLowerCase();
  try {
    if (/;base64$/i.test(head)) {
      const bin = atob(body.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { mime, bytes };
    }
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(body)) };
  } catch {
    return null;
  }
}

/** اسم ملف للتنزيل بامتداد نوعه إن غاب. صرفة. */
export function attachmentFileName(name: string, mime: string): string {
  const ext: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
  const clean = (name || 'attachment').replace(/[\\/?*[\]:<>|"]/g, '·').slice(0, 120);
  const e = ext[mime.toLowerCase()];
  return e && !clean.toLowerCase().endsWith(`.${e}`) ? `${clean}.${e}` : clean;
}

// ═══ الروابط ═══

/** من سطر الشريك أو التقرير إلى قيده */
export const ledgerMoveHref = (moveId: string): string => `/app/ledger/entries/${encodeURIComponent(moveId)}`;

/** عرض الكمية بلا غبار طفو: حتى أربع منازل كمنازل التكلفة. صرفة. */
export function roundQuantity(q: number | null | undefined): number | null {
  if (q === null || q === undefined || !Number.isFinite(q)) return null;
  return Math.round(q * 10_000) / 10_000;
}
