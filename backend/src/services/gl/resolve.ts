/**
 * حلّ سياق الدفاتر من صفوف القاعدة (M2، DESIGN.md §5.4 builder(data, mapping, taxes, settings)، §2.1 I7).
 *
 * - الدوال الصرفة (…FromRow، buildContextFromRows، moveDraftFromRecord، manualOwnership) بلا I/O وتُختبر بلا قاعدة.
 * - loadBuildContext/loadMoveRecord تأخذ tx (معاملة الكتابة أو prisma للقراءة) وتقرأ صفوف الشركة وحدها (§9.4).
 * - التواريخ المحاسبية تُقرأ من @db.Date بـfromDbDate (مكوّنات UTC حرفياً، §2.5).
 */
import type { GlSettings, Prisma } from '@prisma/client';
import { fromDbDate } from './dates';
import {
  DEFAULT_GL_SETTINGS, SOURCE_OWNED_CONTROL_KINDS, createBuildContext,
  type AccountRef, type AccountType, type BuildContext, type CategoryAccountsRef, type ControlKind,
  type GlSettingsSnapshot, type JournalRef, type JournalSystemKey, type JournalType, type LineDraft,
  type LocalDate, type MappingKey, type MoveDraft, type MoveOrigin, type MoveType, type ReceiptRouting,
  type SequenceReset, type SourceType, type TaxRef, type TaxRole, type TaxUse, type VatCategory,
  isMappingKey,
} from './types';

export type GlDb = Prisma.TransactionClient;

/** كيان غير موجود للشركة — المسار يحوّله 404 (§9.4)؛ ليس رمزاً من ملحق ب. */
export class GlNotFoundError extends Error {
  readonly entity: string;
  readonly id: string;
  constructor(entity: string, id: string) {
    super(`${entity} غير موجود: ${id}`);
    this.name = 'GlNotFoundError';
    this.entity = entity;
    this.id = id;
    Object.setPrototypeOf(this, GlNotFoundError.prototype);
  }
}

export function isGlNotFoundError(e: unknown): e is GlNotFoundError {
  return e instanceof GlNotFoundError;
}

const dateOrNull = (d: Date | null | undefined): LocalDate | null => (d ? fromDbDate(d) : null);

// ═══ الصفوف ⇐ لقطات المحرك (صرفة) ═══

/** الحقول التي تقرؤها settingsSnapshotFromRow من GlSettings. */
export type GlSettingsRow = Pick<
  GlSettings,
  | 'templateKey' | 'countryCode' | 'currency' | 'currencyDecimals' | 'timezone' | 'fiscalYearEndMonth'
  | 'fiscalYearEndDay' | 'weekStartsOn' | 'cutoverDate' | 'inventoryMode' | 'perpetualFromDate'
  | 'salesLockDate' | 'purchaseLockDate' | 'taxLockDate' | 'hardLockDate' | 'taxPeriodicity'
  | 'taxDeadlineRule' | 'taxDeadlineDays' | 'zeroRatedSalesTaxKey' | 'postSalesDiscountSeparately'
  | 'postReturnsToContra' | 'receiptRouting' | 'cashInvoiceRouting' | 'paylinkFeeTaxInvoiceFrom'
  | 'postPurchaseDiscountSeparately' | 'billPricesIncludeTax' | 'earlyDiscountAdjustsVat'
  | 'taxRoundingMethod' | 'defaultPurchaseTaxId'
>;

function receiptRoutingOf(v: unknown): ReceiptRouting | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: ReceiptRouting = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if ((k === 'CASH' || k === 'BANK_TRANSFER' || k === 'POS' || k === 'CHEQUE') && (x === 'CUSTODY' || x === 'DIRECT')) {
      out[k] = x;
    }
  }
  return out;
}

export function settingsSnapshotFromRow(row: GlSettingsRow): GlSettingsSnapshot {
  return {
    templateKey: row.templateKey as GlSettingsSnapshot['templateKey'],
    countryCode: row.countryCode,
    currency: row.currency,
    currencyDecimals: row.currencyDecimals,
    timezone: row.timezone || DEFAULT_GL_SETTINGS.timezone,
    fiscalYearEndMonth: row.fiscalYearEndMonth,
    fiscalYearEndDay: row.fiscalYearEndDay,
    weekStartsOn: row.weekStartsOn,
    cutoverDate: dateOrNull(row.cutoverDate),
    inventoryMode: row.inventoryMode === 'PERPETUAL' ? 'PERPETUAL' : 'PERIODIC',
    perpetualFromDate: dateOrNull(row.perpetualFromDate),
    salesLockDate: dateOrNull(row.salesLockDate),
    purchaseLockDate: dateOrNull(row.purchaseLockDate),
    taxLockDate: dateOrNull(row.taxLockDate),
    hardLockDate: dateOrNull(row.hardLockDate),
    taxPeriodicity: row.taxPeriodicity as GlSettingsSnapshot['taxPeriodicity'],
    taxDeadlineRule: row.taxDeadlineRule === 'DAYS_AFTER' ? 'DAYS_AFTER' : 'END_OF_NEXT_MONTH',
    taxDeadlineDays: row.taxDeadlineDays ?? null,
    zeroRatedSalesTaxKey: row.zeroRatedSalesTaxKey ?? null,
    postSalesDiscountSeparately: row.postSalesDiscountSeparately,
    postReturnsToContra: row.postReturnsToContra,
    receiptRouting: receiptRoutingOf(row.receiptRouting),
    cashInvoiceRouting: row.cashInvoiceRouting === 'CUSTODY' ? 'CUSTODY' : 'MAIN_CASH',
    paylinkFeeTaxInvoiceFrom: dateOrNull(row.paylinkFeeTaxInvoiceFrom),
    postPurchaseDiscountSeparately: row.postPurchaseDiscountSeparately,
    billPricesIncludeTax: row.billPricesIncludeTax,
    earlyDiscountAdjustsVat: row.earlyDiscountAdjustsVat,
    taxRoundingMethod: row.taxRoundingMethod === 'PER_LINE' ? 'PER_LINE' : 'PER_TAX',
    defaultPurchaseTaxId: row.defaultPurchaseTaxId ?? null,
  };
}

export interface GlAccountRow {
  id: string; code: string; name: string; type: string; isActive: boolean; reconcile: boolean; controlKind: string | null;
}
export interface GlTaxRow {
  id: string; key: string | null; name: string; use: string; rate: number; vatCategory: string; priceInclude: boolean;
  accountId: string | null; rcOutputAccountId: string | null; deductible: boolean; vatBox: string | null; isActive: boolean;
}
export interface GlJournalRow {
  id: string; code: string; name: string; type: string; systemKey: string | null; defaultAccountId: string | null;
  suspenseAccountId: string | null; useOutstandingAccounts: boolean; sequenceReset: string; isActive: boolean;
}

export function accountRefFromRow(r: GlAccountRow): AccountRef {
  return {
    id: r.id, code: r.code, name: r.name, type: r.type as AccountType, isActive: r.isActive, reconcile: r.reconcile,
    controlKind: (r.controlKind ?? null) as ControlKind | null,
  };
}

export function taxRefFromRow(r: GlTaxRow): TaxRef {
  return {
    id: r.id, key: r.key ?? null, name: r.name, use: r.use as TaxUse, rate: r.rate, vatCategory: r.vatCategory as VatCategory,
    priceInclude: r.priceInclude, accountId: r.accountId ?? null, rcOutputAccountId: r.rcOutputAccountId ?? null,
    deductible: r.deductible, vatBox: r.vatBox ?? null, isActive: r.isActive,
  };
}

export function journalRefFromRow(r: GlJournalRow): JournalRef {
  return {
    id: r.id, code: r.code, name: r.name, type: r.type as JournalType, systemKey: (r.systemKey ?? null) as JournalSystemKey | null,
    defaultAccountId: r.defaultAccountId ?? null, suspenseAccountId: r.suspenseAccountId ?? null,
    useOutstandingAccounts: r.useOutstandingAccounts, sequenceReset: (r.sequenceReset === 'MONTHLY' ? 'MONTHLY' : 'YEARLY') as SequenceReset,
    isActive: r.isActive,
  };
}

export interface LedgerRows {
  settings: GlSettingsRow | null;
  accounts: readonly GlAccountRow[];
  mappings: readonly { key: string; accountId: string }[];
  taxes: readonly GlTaxRow[];
  journals: readonly GlJournalRow[];
  categoryAccounts?: readonly ({ categoryId: string } & CategoryAccountsRef)[];
  repAnalytics?: readonly { salesRepId: string; analyticAccountId: string }[];
}

export interface LedgerContext {
  ctx: BuildContext;
  /** null ⇒ لم يُزرع القالب بعد (الإعدادات = DEFAULT_GL_SETTINGS) */
  settings: GlSettingsRow | null;
  accounts: AccountRef[];
  taxes: TaxRef[];
  journals: JournalRef[];
  accountById: ReadonlyMap<string, AccountRef>;
  taxById: ReadonlyMap<string, TaxRef>;
  journalById: ReadonlyMap<string, JournalRef>;
}

/** يبني سياق المحرك من صفوف مقروءة (صرفة). مفاتيح الربط غير المعروفة تُتجاهل. */
export function buildContextFromRows(rows: LedgerRows): LedgerContext {
  const accounts = rows.accounts.map(accountRefFromRow);
  const taxes = rows.taxes.map(taxRefFromRow);
  const journals = rows.journals.map(journalRefFromRow);
  const mappings: Partial<Record<MappingKey, string>> = {};
  for (const m of rows.mappings) if (isMappingKey(m.key)) mappings[m.key] = m.accountId;
  const categoryAccounts: Record<string, CategoryAccountsRef> = {};
  for (const c of rows.categoryAccounts ?? []) {
    categoryAccounts[c.categoryId] = {
      incomeAccountId: c.incomeAccountId ?? null, expenseAccountId: c.expenseAccountId ?? null,
      cogsAccountId: c.cogsAccountId ?? null, inventoryAccountId: c.inventoryAccountId ?? null,
    };
  }
  const repAnalytics: Record<string, string> = {};
  for (const r of rows.repAnalytics ?? []) repAnalytics[r.salesRepId] = r.analyticAccountId;
  const ctx = createBuildContext({
    settings: rows.settings ? settingsSnapshotFromRow(rows.settings) : {},
    accounts, mappings, taxes, journals, categoryAccounts, repAnalytics,
  });
  return {
    ctx,
    settings: rows.settings,
    accounts,
    taxes,
    journals,
    accountById: new Map(accounts.map((a) => [a.id, a])),
    taxById: new Map(taxes.map((t) => [t.id, t])),
    journalById: new Map(journals.map((j) => [j.id, j])),
  };
}

// ═══ القراءة من القاعدة ═══

export const ACCOUNT_REF_SELECT = { id: true, code: true, name: true, type: true, isActive: true, reconcile: true, controlKind: true } as const;
export const TAX_REF_SELECT = {
  id: true, key: true, name: true, use: true, rate: true, vatCategory: true, priceInclude: true, accountId: true,
  rcOutputAccountId: true, deductible: true, vatBox: true, isActive: true,
} as const;
export const JOURNAL_REF_SELECT = {
  id: true, code: true, name: true, type: true, systemKey: true, defaultAccountId: true, suspenseAccountId: true,
  useOutstandingAccounts: true, sequenceReset: true, isActive: true,
} as const;

/**
 * يقرأ سياق الشركة كاملاً: الإعدادات والحسابات والربط والضرائب والدفاتر وربط الفئات وتحليلي المناديب.
 * داخل معاملة الترحيل تُستدعى **بعد** القفل فتُقرأ تواريخ الإقفال الحالية (§2.5).
 */
export async function loadBuildContext(db: GlDb, tenantId: string): Promise<LedgerContext> {
  const where = { tenantId };
  const [settings, accounts, mappings, taxes, journals, categoryAccounts, repAnalytics] = await Promise.all([
    db.glSettings.findUnique({ where }),
    db.glAccount.findMany({ where, select: ACCOUNT_REF_SELECT }),
    db.glAccountMapping.findMany({ where, select: { key: true, accountId: true } }),
    db.glTax.findMany({ where, select: TAX_REF_SELECT }),
    db.glJournal.findMany({ where, select: JOURNAL_REF_SELECT }),
    db.glProductCategoryAccount.findMany({
      where, select: { categoryId: true, incomeAccountId: true, expenseAccountId: true, cogsAccountId: true, inventoryAccountId: true },
    }),
    db.glRepAnalyticDefault.findMany({ where, select: { salesRepId: true, analyticAccountId: true } }),
  ]);
  return buildContextFromRows({ settings, accounts, mappings, taxes, journals, categoryAccounts, repAnalytics });
}

// ═══ القيد المخزَّن ⇐ مسودة المحرك ═══

export const MOVE_LINE_ENGINE_SELECT = {
  id: true, seq: true, accountId: true, label: true, debitMilli: true, creditMilli: true, customerId: true, vendorId: true,
  salesRepId: true, partnerName: true, analyticAccountId: true, productId: true, quantity: true, taxId: true, taxRole: true,
  taxBaseMilli: true, vatBox: true, vatAdjustment: true, dueDate: true, currencyCode: true, amountCurrencyMilli: true,
  posted: true, generated: true,
} as const;

export const MOVE_RECORD_SELECT = {
  id: true, tenantId: true, journalId: true, number: true, state: true, moveType: true, origin: true, date: true,
  originalDate: true, lateArrival: true, ref: true, narration: true, currencyCode: true, currencyDecimals: true,
  totalMilli: true, customerId: true, vendorId: true, salesRepId: true, sourceType: true, sourceId: true,
  reversedMoveId: true, reversalReason: true, draftOfMoveId: true, autoPostOn: true, reviewState: true,
  needsAttention: true, attentionReason: true, createdBy: true, createdByImpersonated: true, postedAt: true,
  postedBy: true, postedByImpersonated: true, secureSeq: true, secureHash: true,
  journal: { select: { id: true, code: true, systemKey: true, type: true, sequenceReset: true } },
  lines: { select: MOVE_LINE_ENGINE_SELECT, orderBy: { seq: 'asc' as const } },
  sources: { select: { sourceKey: true, sourceType: true, sourceId: true, event: true } },
  reversal: { select: { id: true, number: true } },
} as const;

export type MoveRecord = Prisma.GlMoveGetPayload<{ select: typeof MOVE_RECORD_SELECT }>;

/** يقرأ القيد بسطوره ودفتره ومصادره وعكسه — null إن لم يوجد للشركة. */
export async function loadMoveRecord(db: GlDb, tenantId: string, moveId: string): Promise<MoveRecord | null> {
  return db.glMove.findFirst({ where: { id: moveId, tenantId }, select: MOVE_RECORD_SELECT });
}

export async function requireMoveRecord(db: GlDb, tenantId: string, moveId: string): Promise<MoveRecord> {
  const m = await loadMoveRecord(db, tenantId, moveId);
  if (!m) throw new GlNotFoundError('GlMove', moveId);
  return m;
}

/** الحد الأدنى من القيد المخزَّن الذي تحتاجه moveDraftFromRecord. */
export type MoveRecordForDraft = Pick<
  MoveRecord,
  | 'moveType' | 'origin' | 'date' | 'originalDate' | 'lateArrival' | 'ref' | 'narration' | 'needsAttention'
  | 'attentionReason' | 'customerId' | 'vendorId' | 'salesRepId' | 'sourceType' | 'sourceId' | 'currencyCode'
  | 'currencyDecimals'
> & {
  journal: { code: string; systemKey: string | null };
  lines: readonly Pick<
    MoveRecord['lines'][number],
    | 'accountId' | 'label' | 'debitMilli' | 'creditMilli' | 'customerId' | 'vendorId' | 'salesRepId' | 'partnerName'
    | 'analyticAccountId' | 'productId' | 'quantity' | 'taxId' | 'taxRole' | 'taxBaseMilli' | 'vatBox' | 'vatAdjustment'
    | 'dueDate'
  >[];
};

/** قيد مخزَّن ⇐ MoveDraft بحساب كل سطر بمعرّفه (للترحيل والعكس). sourceKey لا يُنسخ (GlMoveSource صفوف مستقلة). */
export function moveDraftFromRecord(m: MoveRecordForDraft): MoveDraft {
  const lines: LineDraft[] = m.lines.map((l) => ({
    accountId: l.accountId,
    label: l.label ?? '',
    debitMilli: l.debitMilli,
    creditMilli: l.creditMilli,
    customerId: l.customerId,
    vendorId: l.vendorId,
    salesRepId: l.salesRepId,
    partnerName: l.partnerName,
    analyticAccountId: l.analyticAccountId,
    productId: l.productId,
    quantity: l.quantity,
    taxId: l.taxId,
    taxRole: (l.taxRole ?? null) as TaxRole | null,
    taxBaseMilli: l.taxBaseMilli,
    vatBox: l.vatBox,
    vatAdjustment: l.vatAdjustment,
    dueDate: dateOrNull(l.dueDate),
  }));
  return {
    kind: 'MOVE',
    journalCode: m.journal.code,
    ...(m.journal.systemKey ? { journalSystemKey: m.journal.systemKey as JournalSystemKey } : {}),
    moveType: m.moveType as MoveType,
    origin: m.origin as MoveOrigin,
    date: fromDbDate(m.date),
    originalDate: dateOrNull(m.originalDate),
    lateArrival: m.lateArrival,
    ref: m.ref,
    narration: m.narration ?? '',
    needsAttention: m.needsAttention,
    attentionReason: m.attentionReason,
    customerId: m.customerId,
    vendorId: m.vendorId,
    salesRepId: m.salesRepId,
    sourceType: (m.sourceType ?? null) as SourceType | null,
    sourceId: m.sourceId,
    currencyCode: m.currencyCode,
    currencyDecimals: m.currencyDecimals,
    lines,
  };
}

// ═══ I7: القيد المملوك لمصدر (صرفة) ═══

export type OwnershipReason = 'AUTO_ORIGIN' | 'SOURCE_TYPE' | 'MOVE_SOURCE' | 'CONTROL_ACCOUNT';

export interface OwnershipFacts {
  origin: string;
  sourceType: string | null;
  sourceId: string | null;
  salesRepId?: string | null;
  moveType?: string | null;
  /** عدد صفوف GlMoveSource للقيد (أو أولها) */
  moveSources: readonly { sourceType: string; sourceId: string }[] | number;
  /** controlKind لحساب كل سطر */
  lineControlKinds: readonly (string | null | undefined)[];
}

export interface SourceOwnership {
  reasons: OwnershipReason[];
  sourceType: string | null;
  sourceId: string | null;
  /** مسار الإلغاء في المستند نفسه (I7) — null إن لم يُعرف */
  ownerAction: string | null;
}

/**
 * مسار إلغاء المستند المالك (I7، §2.1). المعاملات غير المعروفة (مثل :batchId) تُترك نصاً قالبياً.
 */
export function ownerActionFor(sourceType: string | null, sourceId: string | null, salesRepId?: string | null): string | null {
  if (!sourceType) return null;
  const id = sourceId ?? ':id';
  switch (sourceType) {
    case 'INVOICE': return `PATCH /api/invoices/${id}/cancel`;
    case 'RECEIPT': return `PATCH /api/receipts/${id}/cancel`;
    case 'SETTLEMENT': return `DELETE /api/sales-reps/${salesRepId ?? ':repId'}/settlements/${id}`;
    case 'AR_ENTRY': return 'POST /api/import/batches/:batchId/revert';
    case 'CUSTOMER_ADJUSTMENT': return `POST /api/ledger/customer-adjustments/${id}/cancel`;
    default: return null;
  }
}

/** null ⇒ قيد يدوي حرّ؛ وإلا أسباب الملكية ومسار المالك (I7). */
export function manualOwnership(f: OwnershipFacts): SourceOwnership | null {
  const reasons: OwnershipReason[] = [];
  if (f.origin === 'AUTO') reasons.push('AUTO_ORIGIN');
  if (f.sourceType) reasons.push('SOURCE_TYPE');
  const sources = typeof f.moveSources === 'number' ? f.moveSources : f.moveSources.length;
  if (sources > 0) reasons.push('MOVE_SOURCE');
  if (f.lineControlKinds.some((k) => !!k && (SOURCE_OWNED_CONTROL_KINDS as readonly string[]).includes(k))) {
    reasons.push('CONTROL_ACCOUNT');
  }
  if (reasons.length === 0) return null;
  const first = typeof f.moveSources === 'number' ? null : f.moveSources[0] ?? null;
  const sourceType = f.sourceType ?? first?.sourceType ?? null;
  const sourceId = f.sourceId ?? first?.sourceId ?? null;
  return { reasons, sourceType, sourceId, ownerAction: ownerActionFor(sourceType, sourceId, f.salesRepId) };
}
