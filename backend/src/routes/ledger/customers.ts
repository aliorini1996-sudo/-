import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { DEFAULT_TIMEZONE, addDays, fromDbDate, isLocalDate, localDate, zonedStartOfDay } from '../../services/gl/dates';
import { custodyC4Gap, custodyC4bGap, type CustodyComponents } from '../../services/gl/custody';
import { c5Gap } from '../../services/gl/checks/rules';
import { loadC5Input, loadPendingPartners, loadRepCustodyFacts } from '../../services/gl/checks/run';
import { createPrismaCheckStore } from '../../services/gl/checks/store.prisma';
import { milliText } from '../../services/gl/checks/types';
import { decodeEventNote, type EventNote } from '../../services/gl/sync/classify';
import { postKeyOf, reverseKeyOf } from '../../services/gl/sync/keys';
import type { SourceType } from '../../services/gl/types';

/**
 * قائمة «العملاء» في الدفاتر (M3، DESIGN.md §8.2، INV‑01، PAY‑01، §5.5 custodyComponents، §5.9 C4/C4b/C5).
 *
 * كلها قراءة بـcanViewLedger ولا تكتب شيئاً ولا تمسّ المسارات التشغيلية (invoices/receipts/paylink):
 * - `GET /customers/invoices`: الفواتير والمرتجعات القائمة مع حالة ترحيلها (أحداث INVOICE:<id>:POST|REVERSE).
 * - `GET /customers/receipts`: سندات القبض مع حالة ترحيلها (RECEIPT:<id>:POST|REVERSE).
 * - `GET /customers/custody`: عهدة المناديب بمكوّنات custodyComponents (C4 وC4b) — و`?salesRepId=` يضيف الاستلامات بتقسيمها.
 * - `GET /customers/paylink`: ملخص الأمانات (C5) — و`GET /customers/paylink/entries?kind=ONLINE|FEE|PAYOUT` بحالة الترحيل.
 * المبالغ من الأستاذ ملّي نصوصاً بلاحقة Milli، ومبالغ المستندات التشغيلية كما هي (أرقام).
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');

const locals = (res: Response) => res.locals.ledger as LedgerLocals;

// ═══ حالة الترحيل (صرفة) ═══

export type PostingState =
  | 'NOT_SYNCED' | 'PENDING' | 'BLOCKED' | 'ERROR' | 'HELD'
  | 'POSTED' | 'IN_OPENING' | 'SKIPPED' | 'REVERSE_PENDING' | 'REVERSED';

export interface EventStatusFacts { status: string; skipReason: string | null }

const NON_FINAL = new Set(['PENDING', 'BLOCKED', 'ERROR', 'HELD']);

/**
 * حالة ترحيل المستند من حدثي POST وREVERSE:
 * - لا حدث بعد ⇒ NOT_SYNCED (لم تلتقطه نبضة المُطابِق، أو قبل التفعيل).
 * - POST غير نهائي ⇒ حالته. POST DONE ⇒ POSTED، ثم REVERSED بعكس DONE أو REVERSE_PENDING بعكس غير نهائي.
 * - POST SKIPPED(OPENING) ⇒ IN_OPENING (مشمول بالقيد الافتتاحي)، وعكسه كذلك. غير ذلك من التخطي ⇒ SKIPPED.
 */
export function postingStateOf(post: EventStatusFacts | null, reverse: EventStatusFacts | null): PostingState {
  const reverseState = (base: PostingState): PostingState => {
    if (!reverse) return base;
    if (reverse.status === 'DONE') return 'REVERSED';
    if (NON_FINAL.has(reverse.status)) return 'REVERSE_PENDING';
    return base;
  };
  if (!post) {
    if (!reverse) return 'NOT_SYNCED';
    return reverse.status === 'DONE' ? 'REVERSED' : NON_FINAL.has(reverse.status) ? 'REVERSE_PENDING' : 'SKIPPED';
  }
  if (NON_FINAL.has(post.status)) return post.status as PostingState;
  if (post.status === 'DONE') return reverseState('POSTED');
  if (post.skipReason === 'OPENING') return reverseState('IN_OPENING');
  return 'SKIPPED';
}

export interface EventBrief {
  id: string;
  sourceKey: string;
  status: string;
  skipReason: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  effectAt: Date;
  moveId: string | null;
  moveNumber: string | null;
  note: EventNote | null;
}

export interface Posting { state: PostingState; post: EventBrief | null; reverse: EventBrief | null }

/** أحداث POST/REVERSE لصفحة من المستندات ⇒ حالة ترحيل كلٍّ منها (استعلامان بلا حلقة). */
async function loadPostings(tenantId: string, sourceType: SourceType, ids: readonly string[]): Promise<Map<string, Posting>> {
  const out = new Map<string, Posting>();
  if (!ids.length) return out;
  const keyOf = new Map<string, { id: string; kind: 'post' | 'reverse' }>();
  for (const id of ids) {
    keyOf.set(postKeyOf(sourceType, id), { id, kind: 'post' });
    const rk = reverseKeyOf(sourceType, id);
    if (rk) keyOf.set(rk, { id, kind: 'reverse' });
  }
  const events = await prisma.glSourceEvent.findMany({
    where: { tenantId, sourceKey: { in: [...keyOf.keys()] } },
    select: { id: true, sourceKey: true, status: true, skipReason: true, attempts: true, nextAttemptAt: true, effectAt: true, moveId: true, lastError: true },
  });
  const moveIds = [...new Set(events.map((e) => e.moveId).filter((m): m is string => !!m))];
  const moves = moveIds.length
    ? await prisma.glMove.findMany({ where: { tenantId, id: { in: moveIds } }, select: { id: true, number: true } })
    : [];
  const numberOf = new Map(moves.map((m) => [m.id, m.number]));
  const partial = new Map<string, { post: EventBrief | null; reverse: EventBrief | null }>();
  for (const e of events) {
    const k = keyOf.get(e.sourceKey);
    if (!k) continue;
    const brief: EventBrief = {
      id: e.id, sourceKey: e.sourceKey, status: e.status, skipReason: e.skipReason, attempts: e.attempts,
      nextAttemptAt: e.nextAttemptAt, effectAt: e.effectAt, moveId: e.moveId,
      moveNumber: e.moveId ? numberOf.get(e.moveId) ?? null : null, note: decodeEventNote(e.lastError),
    };
    const p = partial.get(k.id) ?? { post: null, reverse: null };
    p[k.kind] = brief;
    partial.set(k.id, p);
  }
  for (const id of ids) {
    const p = partial.get(id) ?? { post: null, reverse: null };
    out.set(id, { state: postingStateOf(p.post, p.reverse), post: p.post, reverse: p.reverse });
  }
  return out;
}

// ═══ معاملات الاستعلام ═══

type Q = Record<string, unknown>;

export function listOf(v: unknown, allowed?: readonly string[]): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const vals = raw.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  return allowed ? vals.filter((x) => allowed.includes(x)) : vals;
}

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, 200) : undefined;
};

export function pageOf(q: Q, max = 200, fallback = 80): { offset: number; limit: number } {
  const off = Number(q.offset);
  const lim = Number(q.limit);
  return {
    offset: Number.isFinite(off) && off > 0 ? Math.min(Math.floor(off), 1_000_000) : 0,
    limit: Number.isFinite(lim) && lim > 0 ? Math.min(Math.floor(lim), max) : fallback,
  };
}

/** نطاق تاريخ محلي ⇒ [بداية اليوم الأول، بداية اليوم التالي للأخير) بتوقيت الشركة. */
export function instantRange(q: Q, timezone: string): Prisma.DateTimeFilter | undefined {
  const r: Prisma.DateTimeFilter = {};
  for (const f of ['dateFrom', 'dateTo'] as const) {
    const v = q[f];
    if (v === undefined || v === '') continue;
    if (!isLocalDate(v)) throw new LedgerHttpError(400, 'تاريخ غير صالح', { reason: 'INVALID_DATE', field: f });
  }
  if (isLocalDate(q.dateFrom)) r.gte = zonedStartOfDay(q.dateFrom, timezone);
  if (isLocalDate(q.dateTo)) r.lt = zonedStartOfDay(addDays(q.dateTo, 1), timezone);
  return r.gte || r.lt ? r : undefined;
}

/** حالات حدث POST المسموح الفلترة بها (posting=…) */
export const POSTING_FILTER_STATUSES = ['PENDING', 'BLOCKED', 'ERROR', 'HELD', 'DONE', 'SKIPPED'] as const;
/** سقف المستندات المطابقة لفلتر حالة الترحيل (صفحة واحدة من الأحداث) */
export const POSTING_FILTER_CAP = 5000;

/**
 * معرّفات المستندات بحالة ترحيل POST معيّنة — أحدث POSTING_FILTER_CAP بأثرها، مضيَّقة بنطاق التاريخ إن طُلب (أثر POST =
 * تاريخ المستند) فلا يُسقط القص نتائج داخل الفترة. capped=true ⇒ النتائج مقتصرة (الواجهة تنبّه بتضييق النطاق).
 */
export async function sourceIdsWithPostStatus(
  tenantId: string, sourceType: SourceType, statuses: string[], range?: Prisma.DateTimeFilter | null,
  db: { glSourceEvent: { findMany(args: Prisma.GlSourceEventFindManyArgs): Promise<{ sourceId: string }[]> } } = prisma as never,
): Promise<{ ids: string[]; capped: boolean }> {
  const rows = await db.glSourceEvent.findMany({
    where: { tenantId, sourceType, event: 'POST', status: { in: statuses }, ...(range ? { effectAt: range } : {}) },
    select: { sourceId: true }, orderBy: { effectAt: 'desc' }, take: POSTING_FILTER_CAP + 1,
  });
  return { ids: rows.slice(0, POSTING_FILTER_CAP).map((r) => r.sourceId), capped: rows.length > POSTING_FILTER_CAP };
}

async function ledgerFacts(tenantId: string) {
  const s = await prisma.glSettings.findUnique({
    where: { tenantId }, select: { activatedAt: true, cutoverDate: true, timezone: true, currencyDecimals: true, backfillState: true, lastSyncAt: true },
  });
  return {
    activated: !!s?.activatedAt,
    timezone: s?.timezone || DEFAULT_TIMEZONE,
    meta: {
      activatedAt: s?.activatedAt ?? null,
      cutoverDate: s?.cutoverDate ? fromDbDate(s.cutoverDate) : null,
      backfillState: s?.backfillState ?? 'NONE',
      lastSyncAt: s?.lastSyncAt ?? null,
      currencyDecimals: s?.currencyDecimals ?? 2,
    },
  };
}

// ═══ الفواتير والمرتجعات ═══

export const INVOICE_TYPES = ['CASH', 'CREDIT', 'RETURN'] as const;
export const INVOICE_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;

router.get('/customers/invoices', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as Q;
  const f = await ledgerFacts(tenantId);
  const page = pageOf(q);
  const where: Prisma.InvoiceWhereInput = { tenantId };
  const and: Prisma.InvoiceWhereInput[] = [];
  const types = listOf(q.type, INVOICE_TYPES);
  if (types.length) where.type = { in: types };
  const statuses = listOf(q.status, INVOICE_STATUSES);
  if (statuses.length) where.status = { in: statuses };
  const range = instantRange(q, f.timezone);
  if (range) where.invoiceDate = range;
  for (const k of ['customerId', 'salesRepId'] as const) { const v = str(q[k]); if (v) where[k] = v; }
  const search = str(q.search);
  if (search) and.push({ OR: [{ number: { contains: search, mode: 'insensitive' } }, { customer: { name: { contains: search, mode: 'insensitive' } } }] });
  const posting = listOf(q.posting, POSTING_FILTER_STATUSES);
  let postingFilterCapped = false;
  if (posting.length) {
    const matched = await sourceIdsWithPostStatus(tenantId, 'INVOICE', posting, range);
    postingFilterCapped = matched.capped;
    and.push({ id: { in: matched.ids } });
  }
  if (and.length) where.AND = and;

  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where, orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], skip: page.offset, take: page.limit,
      select: {
        id: true, number: true, type: true, status: true, invoiceDate: true, createdAt: true, subtotal: true, discountAmt: true,
        taxAmt: true, total: true, remainingAmt: true, customerId: true, salesRepId: true,
        customer: { select: { name: true } }, salesRep: { select: { name: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);
  const postings = await loadPostings(tenantId, 'INVOICE', rows.map((r) => r.id));
  res.json({
    success: true,
    data: {
      ...f.meta, activated: f.activated, total, ...page, postingFilterCapped,
      rows: rows.map((r) => ({
        id: r.id, number: r.number, type: r.type, status: r.status,
        date: localDate(r.invoiceDate, f.timezone), invoiceDate: r.invoiceDate, createdAt: r.createdAt,
        subtotal: r.subtotal, discountAmt: r.discountAmt, taxAmt: r.taxAmt, total: r.total, remainingAmt: r.remainingAmt,
        customerId: r.customerId, customerName: r.customer?.name ?? null, salesRepId: r.salesRepId, salesRepName: r.salesRep?.name ?? null,
        posting: postings.get(r.id),
      })),
    },
  });
}));

// ═══ سندات القبض ═══

export const RECEIPT_METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'ONLINE'] as const;
export const RECEIPT_STATUSES = ['ACTIVE', 'CANCELLED'] as const;

router.get('/customers/receipts', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as Q;
  const f = await ledgerFacts(tenantId);
  const page = pageOf(q);
  const where: Prisma.ReceiptWhereInput = { tenantId };
  const and: Prisma.ReceiptWhereInput[] = [];
  const methods = listOf(q.paymentMethod, RECEIPT_METHODS);
  if (methods.length) where.paymentMethod = { in: methods };
  const statuses = listOf(q.status, RECEIPT_STATUSES);
  if (statuses.length) where.status = { in: statuses };
  const range = instantRange(q, f.timezone);
  if (range) where.receiptDate = range;
  for (const k of ['customerId', 'salesRepId'] as const) { const v = str(q[k]); if (v) where[k] = v; }
  const search = str(q.search);
  if (search) and.push({ OR: [{ number: { contains: search, mode: 'insensitive' } }, { customer: { name: { contains: search, mode: 'insensitive' } } }] });
  const posting = listOf(q.posting, POSTING_FILTER_STATUSES);
  let postingFilterCapped = false;
  if (posting.length) {
    const matched = await sourceIdsWithPostStatus(tenantId, 'RECEIPT', posting, range);
    postingFilterCapped = matched.capped;
    and.push({ id: { in: matched.ids } });
  }
  if (and.length) where.AND = and;

  const [rows, total] = await Promise.all([
    prisma.receipt.findMany({
      where, orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], skip: page.offset, take: page.limit,
      select: {
        id: true, number: true, paymentMethod: true, status: true, receiptDate: true, createdAt: true, amount: true,
        customerId: true, salesRepId: true, customer: { select: { name: true } }, salesRep: { select: { name: true } },
      },
    }),
    prisma.receipt.count({ where }),
  ]);
  const ids = rows.map((r) => r.id);
  const [postings, links] = await Promise.all([
    loadPostings(tenantId, 'RECEIPT', ids),
    ids.length
      ? prisma.customerPaymentLink.findMany({ where: { tenantId, receiptId: { in: ids } }, select: { id: true, receiptId: true, status: true } })
      : Promise.resolve([]),
  ]);
  const linkOf = new Map(links.map((l) => [l.receiptId, l]));
  res.json({
    success: true,
    data: {
      ...f.meta, activated: f.activated, total, ...page, postingFilterCapped,
      rows: rows.map((r) => ({
        id: r.id, number: r.number, paymentMethod: r.paymentMethod, status: r.status,
        date: localDate(r.receiptDate, f.timezone), receiptDate: r.receiptDate, createdAt: r.createdAt, amount: r.amount,
        customerId: r.customerId, customerName: r.customer?.name ?? null, salesRepId: r.salesRepId, salesRepName: r.salesRep?.name ?? null,
        paylinkId: linkOf.get(r.id)?.id ?? null, paylinkStatus: linkOf.get(r.id)?.status ?? null,
        posting: postings.get(r.id),
      })),
    },
  });
}));

// ═══ عهدة المناديب (C4/C4b) ═══

export function serializeComponents(c: CustodyComponents) {
  return {
    ledgerCustodyMilli: milliText(c.ledgerCustody),
    onlineUnclearedMilli: milliText(c.onlineUncleared),
    cashSalesOutsideCustodyMilli: milliText(c.cashSalesOutsideCustody),
    custodyExpensesMilli: milliText(c.custodyExpenses),
    openShortageMilli: milliText(c.openShortage),
    shortagesExpensedMilli: milliText(c.shortagesExpensed),
    nonCustodyClearedMilli: milliText(c.nonCustodyCleared),
    suspenseClearedMilli: milliText(c.suspenseCleared),
    shortageRecoveredMilli: milliText(c.shortageRecovered),
    nonCustodyAllowanceMilli: milliText(c.nonCustodyAllowance),
  };
}

router.get('/customers/custody', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as Q;
  const onlyRepId = str(q.salesRepId);
  const store = createPrismaCheckStore(prisma);
  const s = await store.loadSettings(tenantId);
  if (!s?.activatedAt) {
    res.json({ success: true, data: { activated: false, reps: [], totals: null } });
    return;
  }
  const pending = await loadPendingPartners(store, tenantId, s);
  const reps = await loadRepCustodyFacts(store, tenantId, s, pending, undefined, onlyRepId);
  if (onlyRepId && !reps.length) throw new LedgerHttpError(404, 'المندوب غير موجود', { reason: 'NOT_FOUND', salesRepId: onlyRepId });
  let ledger = 0n; let ops = 0n; let c4 = 0n;
  const out = reps.map((r) => {
    const c = r.components;
    const c4Gap = custodyC4Gap(r.ledgerMilli, c);
    const c4bGap = custodyC4bGap(c, r.opsOutstandingMilli);
    ledger += r.ledgerMilli; ops += r.opsOutstandingMilli; c4 += c4Gap;
    return {
      salesRepId: r.salesRepId, name: r.name, isActive: r.isActive, pending: r.pending,
      ledgerMilli: milliText(r.ledgerMilli), opsOutstandingMilli: milliText(r.opsOutstandingMilli),
      c4GapMilli: milliText(c4Gap), c4bGapMilli: milliText(c4bGap),
      components: serializeComponents(c),
      ...(onlyRepId ? {
        settlements: c.settlements.map((x) => ({
          id: x.id, amountMilli: milliText(x.amountMilli), coveredMilli: milliText(x.coveredMilli), recoveredMilli: milliText(x.recoveredMilli),
          nonCustodyClearedMilli: milliText(x.nonCustodyClearedMilli), suspenseMilli: milliText(x.suspenseMilli), stored: x.stored, reversed: x.reversed,
        })),
      } : {}),
    };
  });
  res.json({
    success: true,
    data: {
      activated: true, lastSyncAt: s.lastSyncAt, currencyDecimals: s.currencyDecimals, reps: out,
      totals: { ledgerMilli: milliText(ledger), opsOutstandingMilli: milliText(ops), c4GapMilli: milliText(c4) },
    },
  });
}));

// ═══ أمانات الدفع الإلكتروني (C5) ═══

router.get('/customers/paylink', VIEW, ledgerHandler(async (_req, res) => {
  const { tenantId } = locals(res);
  const store = createPrismaCheckStore(prisma);
  const s = await store.loadSettings(tenantId);
  if (!s?.activatedAt) {
    res.json({ success: true, data: { activated: false, summary: null } });
    return;
  }
  const pending = await loadPendingPartners(store, tenantId, s);
  const c5 = await loadC5Input(store, tenantId, s, pending);
  res.json({
    success: true,
    data: {
      activated: true, lastSyncAt: s.lastSyncAt, currencyDecimals: s.currencyDecimals,
      summary: {
        ledgerMilli: milliText(c5.ledgerMilli), settlementBalanceMilli: milliText(c5.settlementBalanceMilli),
        gapMilli: milliText(c5Gap(c5)), pending: c5.pending,
        refundedLinksWithoutRefund: c5.refundedLinksWithoutRefund.map((x) => ({ ...x, amountMilli: milliText(x.amountMilli) })),
        cancelledOnlineWithoutRefund: c5.cancelledOnlineWithoutRefund.map((x) => ({ ...x, amountMilli: milliText(x.amountMilli) })),
      },
    },
  });
}));

export const PAYLINK_ENTRY_KINDS = ['ONLINE', 'FEE', 'PAYOUT'] as const;
export type PaylinkEntryKind = (typeof PAYLINK_ENTRY_KINDS)[number];

router.get('/customers/paylink/entries', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as Q;
  const kind = (listOf(q.kind, PAYLINK_ENTRY_KINDS)[0] ?? 'ONLINE') as PaylinkEntryKind;
  const f = await ledgerFacts(tenantId);
  const page = pageOf(q);
  const range = instantRange(q, f.timezone);

  if (kind === 'ONLINE') {
    const where: Prisma.ReceiptWhereInput = { tenantId, paymentMethod: 'ONLINE', ...(range ? { receiptDate: range } : {}) };
    const [rows, total] = await Promise.all([
      prisma.receipt.findMany({
        where, orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }], skip: page.offset, take: page.limit,
        select: { id: true, number: true, status: true, receiptDate: true, amount: true, customerId: true, customer: { select: { name: true } }, salesRepId: true },
      }),
      prisma.receipt.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [postings, links] = await Promise.all([
      loadPostings(tenantId, 'RECEIPT', ids),
      ids.length ? prisma.customerPaymentLink.findMany({ where: { tenantId, receiptId: { in: ids } }, select: { id: true, receiptId: true, status: true } }) : Promise.resolve([]),
    ]);
    const linkOf = new Map(links.map((l) => [l.receiptId, l]));
    res.json({
      success: true,
      data: {
        ...f.meta, activated: f.activated, kind, total, ...page,
        rows: rows.map((r) => ({
          id: r.id, number: r.number, status: r.status, date: localDate(r.receiptDate, f.timezone), amount: r.amount,
          customerId: r.customerId, customerName: r.customer?.name ?? null, salesRepId: r.salesRepId,
          paylinkId: linkOf.get(r.id)?.id ?? null, paylinkStatus: linkOf.get(r.id)?.status ?? null, posting: postings.get(r.id),
        })),
      },
    });
    return;
  }

  if (kind === 'FEE') {
    const where: Prisma.SettlementEntryWhereInput = { tenantId, kind: 'FEE', ...(range ? { createdAt: range } : {}) };
    const [rows, total] = await Promise.all([
      prisma.settlementEntry.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.offset, take: page.limit,
        select: { id: true, amount: true, feeNet: true, feeVat: true, linkId: true, note: true, createdAt: true },
      }),
      prisma.settlementEntry.count({ where }),
    ]);
    const postings = await loadPostings(tenantId, 'PAYLINK_FEE', rows.map((r) => r.id));
    res.json({
      success: true,
      data: {
        ...f.meta, activated: f.activated, kind, total, ...page,
        rows: rows.map((r) => ({ ...r, date: localDate(r.createdAt, f.timezone), posting: postings.get(r.id) })),
      },
    });
    return;
  }

  const where: Prisma.PayoutWhereInput = { tenantId, ...(range ? { createdAt: range } : {}) };
  const [rows, total] = await Promise.all([
    prisma.payout.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.offset, take: page.limit,
      select: { id: true, amount: true, bankReference: true, note: true, createdAt: true },
    }),
    prisma.payout.count({ where }),
  ]);
  const postings = await loadPostings(tenantId, 'PAYOUT', rows.map((r) => r.id));
  res.json({
    success: true,
    data: {
      ...f.meta, activated: f.activated, kind, total, ...page,
      rows: rows.map((r) => ({ ...r, date: localDate(r.createdAt, f.timezone), posting: postings.get(r.id) })),
    },
  });
}));

export default router;
