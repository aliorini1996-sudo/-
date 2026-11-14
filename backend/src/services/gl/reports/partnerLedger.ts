/**
 * «ربط الدفاتر» L8 — دفتر أستاذ الشريك (عقد §6.2، Odoo Partner Ledger). **صرف تماماً**: القراءة في `partnerLoad.prisma.ts`.
 *
 * الشريك وحساباته:
 * | النوع     | الحسابات                     | بُعد السطر     |
 * |-----------|------------------------------|----------------|
 * | customer  | controlKind AR (113001…)     | customerId     |
 * | vendor    | controlKind AP (211001…)     | vendorId       |
 * | rep       | controlKind CUSTODY (111003) | salesRepId     |
 * | user      | controlKind CUSTODY (111004) | adminUserId    |
 *
 * الرصيد بقاعدة `مدين − دائن` لكل الأنواع (كـOdoo): الافتتاح = Σ ما قبل `from`، والجاري = الافتتاح + Σ الحركة حتى السطر،
 * والختام = الافتتاح + Σ المدين − Σ الدائن — **ثابت بالبناء** («الافتتاح + الحركة = الختام»).
 *
 * `includeReconciled=false` (Odoo «غير المطابَقة»): تُسقط السطور المطابَقة كلياً من الفترة، والافتتاح يُحسب بالقاعدة نفسها
 * (المستدعي يمرّر افتتاح السطور غير المطابَقة كلياً) — فيبقى الثابت قائماً على المعروض.
 *
 * المتبقّي `residual` موقَّع: موجب لسطر مدين مفتوح، وسالب لدائن مفتوح؛ والمطابَق كلياً صفر.
 */
import { fromMilli } from '../money';
import type { ControlKind, LocalDate, Milli } from '../types';

export const PARTNER_TYPES = ['customer', 'vendor', 'rep', 'user'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export function isPartnerType(v: unknown): v is PartnerType {
  return typeof v === 'string' && (PARTNER_TYPES as readonly string[]).includes(v);
}

export type PartnerLineField = 'customerId' | 'vendorId' | 'salesRepId' | 'adminUserId';

/** حسابات الشريك وبُعده على السطر */
export const PARTNER_LEDGER_SCOPE: Readonly<Record<PartnerType, { controlKind: ControlKind; field: PartnerLineField }>> = {
  customer: { controlKind: 'AR', field: 'customerId' },
  vendor: { controlKind: 'AP', field: 'vendorId' },
  rep: { controlKind: 'CUSTODY', field: 'salesRepId' },
  user: { controlKind: 'CUSTODY', field: 'adminUserId' },
};

export const PARTNER_LEDGER_PAGE_SIZE = 100;
export const PARTNER_LEDGER_MAX_PAGE_SIZE = 500;
/** سقف دفاعي لسطور الفترة لشريك واحد (= سقف XLSX §7.1) — فوقه 422 LEDGER_RANGE_TOO_LARGE */
export const PARTNER_LEDGER_MAX_LINES = 50_000;

export interface PartnerLedgerLineInput {
  lineId: string;
  moveId: string;
  moveNumber: string | null;
  /** لحظة إنشاء القيد (ms) — ترتيب القيود داخل اليوم الواحد */
  moveCreatedAt?: number | null;
  date: LocalDate;
  journalCode: string | null;
  ref: string | null;
  label: string | null;
  sourceType: string | null;
  sourceId: string | null;
  seq: number;
  debitMilli: Milli;
  creditMilli: Milli;
  dueDate: LocalDate | null;
  productId: string | null;
  quantity: number | null;
}

/** صفّ مطابقة يمسّ سطراً من سطور الفترة */
export interface PartnerLedgerPartial {
  /** معرّف الصفّ — يُزال به تكرار صفٍّ وصل في دفعتي قراءة */
  id?: string;
  debitLineId: string;
  creditLineId: string;
  debitMoveId: string | null;
  creditMoveId: string | null;
  amountMilli: Milli;
}

export interface PartnerLedgerMatch {
  /** السطر المقابل */
  lineId: string;
  moveId: string | null;
  amountMilli: Milli;
}

export interface PartnerLedgerRow extends PartnerLedgerLineInput {
  balanceMilli: Milli;
  /** موقَّع: مدين مفتوح موجب، ودائن مفتوح سالب */
  residualMilli: Milli;
  fullyReconciled: boolean;
  matches: PartnerLedgerMatch[];
}

export interface PartnerLedgerInput {
  partner: { type: PartnerType; id: string; name: string | null };
  currency: string;
  decimals: number;
  from: LocalDate;
  to: LocalDate;
  /** Σ (مدين − دائن) قبل `from` — للسطور غير المطابَقة كلياً حين `includeReconciled=false` */
  openingMilli: Milli;
  /** كل سطور الفترة [from, to] (بأي ترتيب) */
  lines: readonly PartnerLedgerLineInput[];
  /** المطابقات التي تمسّ سطور الفترة (من الجهتين) */
  partials: readonly PartnerLedgerPartial[];
  includeReconciled: boolean;
  page: number;
  /** null ⇒ بلا ترقيم (التصدير) */
  pageSize: number | null;
}

export interface PartnerLedger {
  partner: { type: PartnerType; id: string; name: string | null };
  currency: string;
  decimals: number;
  from: LocalDate;
  to: LocalDate;
  includeReconciled: boolean;
  openingMilli: Milli;
  closingMilli: Milli;
  totalDebitMilli: Milli;
  totalCreditMilli: Milli;
  /** سطور الصفحة (أو كلها بلا ترقيم) بالرصيد الجاري الصحيح ولو كانت الصفحة الأخيرة */
  lines: PartnerLedgerRow[];
  /** عدد السطور المعروضة في الفترة كلها (بعد الفلتر) */
  lineCount: number;
  page: number;
  pageSize: number | null;
  pages: number;
}

/** ترتيب حتمي: التاريخ، ثم لحظة القيد، ثم رقمه، ثم معرّفه، ثم ترتيب السطر */
export function comparePartnerLines(a: PartnerLedgerLineInput, b: PartnerLedgerLineInput): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ca = a.moveCreatedAt ?? null;
  const cb = b.moveCreatedAt ?? null;
  if (ca !== null && cb !== null && ca !== cb) return ca - cb;
  const na = a.moveNumber ?? '';
  const nb = b.moveNumber ?? '';
  if (na !== nb) return na < nb ? -1 : 1;
  if (a.moveId !== b.moveId) return a.moveId < b.moveId ? -1 : 1;
  return a.seq - b.seq;
}

export function normalizePartnerPage(page: number | undefined): number {
  return Number.isInteger(page) && (page as number) > 0 ? (page as number) : 1;
}

export function normalizePartnerPageSize(size: number | undefined): number {
  if (!Number.isInteger(size) || (size as number) <= 0) return PARTNER_LEDGER_PAGE_SIZE;
  return Math.min(size as number, PARTNER_LEDGER_MAX_PAGE_SIZE);
}

export function buildPartnerLedger(input: PartnerLedgerInput): PartnerLedger {
  if (input.from > input.to) throw new RangeError(`buildPartnerLedger: from ${input.from} بعد to ${input.to}`);
  const matched = new Map<string, bigint>();
  const matches = new Map<string, PartnerLedgerMatch[]>();
  const seen = new Set<string>();
  const ids = new Set(input.lines.map((l) => l.lineId));
  for (const p of input.partials) {
    // الصفّ نفسه قد يصل مرتين (دفعتا قراءة) — يُعدّ مرة واحدة بمعرّفه
    if (p.id) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
    }
    if (ids.has(p.debitLineId)) {
      matched.set(p.debitLineId, (matched.get(p.debitLineId) ?? 0n) + p.amountMilli);
      const arr = matches.get(p.debitLineId) ?? [];
      arr.push({ lineId: p.creditLineId, moveId: p.creditMoveId, amountMilli: p.amountMilli });
      matches.set(p.debitLineId, arr);
    }
    if (ids.has(p.creditLineId)) {
      matched.set(p.creditLineId, (matched.get(p.creditLineId) ?? 0n) + p.amountMilli);
      const arr = matches.get(p.creditLineId) ?? [];
      arr.push({ lineId: p.debitLineId, moveId: p.debitMoveId, amountMilli: p.amountMilli });
      matches.set(p.creditLineId, arr);
    }
  }

  const sorted = [...input.lines].sort(comparePartnerLines);
  const all: PartnerLedgerRow[] = [];
  let running = input.openingMilli;
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const l of sorted) {
    const amount = l.debitMilli > 0n ? l.debitMilli : l.creditMilli;
    const m = matched.get(l.lineId) ?? 0n;
    const open = amount - m;
    const fullyReconciled = amount > 0n && open <= 0n;
    if (!input.includeReconciled && fullyReconciled) continue;
    running += l.debitMilli - l.creditMilli;
    totalDebit += l.debitMilli;
    totalCredit += l.creditMilli;
    all.push({
      ...l,
      balanceMilli: running,
      residualMilli: l.debitMilli > 0n ? open : -open,
      fullyReconciled,
      matches: matches.get(l.lineId) ?? [],
    });
  }

  const page = normalizePartnerPage(input.page);
  const pageSize = input.pageSize === null ? null : normalizePartnerPageSize(input.pageSize);
  const pages = pageSize === null ? 1 : Math.max(1, Math.ceil(all.length / pageSize));
  const lines = pageSize === null ? all : all.slice((page - 1) * pageSize, page * pageSize);
  return {
    partner: input.partner,
    currency: input.currency,
    decimals: input.decimals,
    from: input.from,
    to: input.to,
    includeReconciled: input.includeReconciled,
    openingMilli: input.openingMilli,
    closingMilli: input.openingMilli + totalDebit - totalCredit,
    totalDebitMilli: totalDebit,
    totalCreditMilli: totalCredit,
    lines,
    lineCount: all.length,
    page,
    pageSize,
    pages,
  };
}

// ═══ الردّ (أرقام بوحدة العملة، لا BigInt) ═══

export interface PartnerLedgerExtras {
  /** رقم القيد لكل معرّف قيد مقابل في المطابقات */
  moveNumbers?: ReadonlyMap<string, string | null>;
  /** اسم الصنف لكل productId */
  productNames?: ReadonlyMap<string, string>;
  /** مرفقات مصدر كل سطر (بمفتاح lineId) */
  attachments?: ReadonlyMap<string, { count: number; kinds: string[] }>;
  /** عدد وثائق العميل (customer_documents) — للعميل وحده */
  documentsCount?: number;
}

export function serializePartnerLedger(l: PartnerLedger, extras: PartnerLedgerExtras = {}): Record<string, unknown> {
  return {
    partner: l.partner,
    currency: l.currency,
    decimals: l.decimals,
    from: l.from,
    to: l.to,
    includeReconciled: l.includeReconciled,
    opening: fromMilli(l.openingMilli),
    closing: fromMilli(l.closingMilli),
    totalDebit: fromMilli(l.totalDebitMilli),
    totalCredit: fromMilli(l.totalCreditMilli),
    lines: l.lines.map((r) => ({
      lineId: r.lineId,
      moveId: r.moveId,
      moveNumber: r.moveNumber,
      date: r.date,
      journalCode: r.journalCode,
      ref: r.ref,
      label: r.label,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      debit: fromMilli(r.debitMilli),
      credit: fromMilli(r.creditMilli),
      balance: fromMilli(r.balanceMilli),
      dueDate: r.dueDate,
      residual: fromMilli(r.residualMilli),
      fullyReconciled: r.fullyReconciled,
      matches: r.matches.map((m) => ({
        lineId: m.lineId,
        moveId: m.moveId,
        moveNumber: m.moveId ? extras.moveNumbers?.get(m.moveId) ?? null : null,
        amount: fromMilli(m.amountMilli),
      })),
      productId: r.productId,
      productName: r.productId ? extras.productNames?.get(r.productId) ?? null : null,
      quantity: r.quantity,
      attachments: extras.attachments?.get(r.lineId) ?? { count: 0, kinds: [] },
    })),
    documents: { count: extras.documentsCount ?? 0 },
    pagination: { page: l.page, pageSize: l.pageSize, total: l.lineCount, pages: l.pages, paginated: l.pageSize !== null },
    lineCount: l.lineCount,
  };
}
