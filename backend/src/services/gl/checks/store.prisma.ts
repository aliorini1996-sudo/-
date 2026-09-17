/**
 * تنفيذ CheckStore بـPrisma (M3، DESIGN.md §5.9).
 *
 * يأخذ العميل أو معاملة من المُستدعي (المسار يمرّر prisma للتشغيل، ومعاملة قيد التصحيح تحت قفل gl-post)،
 * فلا يستورد config/database. كل استعلام معزول بـtenantId (§9.4). قراءة فقط — لا كتابة هنا.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { fromDbDate, toDbDate } from '../dates';
import { toMilli } from '../money';
import { RECONCILED_SOURCES } from '../sync/desired';
import { siblingPostKey } from '../sync/keys';
import { PrismaPostingTx } from '../sync/postingStore.prisma';
import { cursorLagMs } from '../sync/reconciler';
import { createPrismaReconcilerStore } from '../sync/reconcilerStore.prisma';
import type { BackfillState, InventoryMode, LocalDate, Milli } from '../types';
import type { CheckSettingsFacts, CheckStore, PendingPartners } from './run';
import type { CursorFacts, PeriodTotal, ProblemEvent } from './rules';

type Db = Prisma.TransactionClient | PrismaClient;

const NON_FINAL = ['PENDING', 'BLOCKED', 'ERROR', 'HELD'];
const PENDING_SCAN_LIMIT = 5000;

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : v === null || v === undefined ? 0n : BigInt(String(v).split('.')[0]));
const dateOut = (d: Date | null | undefined): LocalDate | null => (d ? fromDbDate(d) : null);

function netMilli(debit: number | null | undefined, credit: number | null | undefined, decimals: number): Milli {
  return toMilli(debit ?? 0, decimals) - toMilli(credit ?? 0, decimals);
}

type AnyPayload = Record<string, unknown> | null;
const payloadOf = (v: unknown): AnyPayload => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function createPrismaCheckStore(db: Db): CheckStore {
  const postingTxs = new Map<string, PrismaPostingTx>();
  const d = db as Prisma.TransactionClient;

  return {
    async dbNow() {
      const rows = await d.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
      return new Date(rows[0].now);
    },

    async loadSettings(tenantId): Promise<CheckSettingsFacts | null> {
      const s = await d.glSettings.findUnique({ where: { tenantId } });
      if (!s) return null;
      return {
        activatedAt: s.activatedAt, backfillState: s.backfillState as BackfillState,
        setupMethod: s.setupMethod === 'FULL_HISTORY' ? 'FULL_HISTORY' : s.setupMethod === 'OPENING' ? 'OPENING' : null,
        cutoverDate: dateOut(s.cutoverDate), openingSnapshotAt: s.openingSnapshotAt, timezone: s.timezone,
        currencyDecimals: s.currencyDecimals, lastSyncAt: s.lastSyncAt,
        inventoryMode: (s.inventoryMode === 'PERPETUAL' ? 'PERPETUAL' : 'PERIODIC') as InventoryMode,
        lockDates: {
          salesLockDate: dateOut(s.salesLockDate), purchaseLockDate: dateOut(s.purchaseLockDate),
          taxLockDate: dateOut(s.taxLockDate), hardLockDate: dateOut(s.hardLockDate),
        },
      };
    },

    async unbalancedMoves(tenantId, limit) {
      const rows = await d.$queryRaw<{ moveId: string; number: string | null; d: bigint; c: bigint }[]>`
        SELECT m."id" AS "moveId", m."number" AS "number",
               COALESCE(SUM(l."debitMilli"), 0)::bigint AS "d", COALESCE(SUM(l."creditMilli"), 0)::bigint AS "c"
        FROM "gl_moves" m LEFT JOIN "gl_move_lines" l ON l."moveId" = m."id"
        WHERE m."tenantId" = ${tenantId} AND m."state" = 'POSTED'
        GROUP BY m."id", m."number"
        HAVING COALESCE(SUM(l."debitMilli"), 0) <> COALESCE(SUM(l."creditMilli"), 0)
        LIMIT ${limit}`;
      return rows.map((r) => ({ moveId: r.moveId, number: r.number, debitMilli: big(r.d), creditMilli: big(r.c) }));
    },

    async periodLineTotals(tenantId): Promise<PeriodTotal[]> {
      const rows = await d.$queryRaw<{ accountId: string; accountCode: string | null; periodKey: string; d: bigint; c: bigint }[]>`
        SELECT l."accountId" AS "accountId", a."code" AS "accountCode",
               CASE WHEN m."moveType" = 'FY_CLOSING' THEN to_char(l."date", 'YYYY') || '-CL' ELSE to_char(l."date", 'YYYY-MM') END AS "periodKey",
               COALESCE(SUM(l."debitMilli"), 0)::bigint AS "d", COALESCE(SUM(l."creditMilli"), 0)::bigint AS "c"
        FROM "gl_move_lines" l
        JOIN "gl_moves" m ON m."id" = l."moveId"
        LEFT JOIN "gl_accounts" a ON a."id" = l."accountId"
        WHERE l."tenantId" = ${tenantId} AND l."posted" = true AND m."state" = 'POSTED'
          AND (l."taxRole" IS NULL OR l."taxRole" <> 'MARKER')
        GROUP BY 1, 2, 3
        HAVING COALESCE(SUM(l."debitMilli"), 0) <> 0 OR COALESCE(SUM(l."creditMilli"), 0) <> 0`;
      return rows.map((r) => ({ accountId: r.accountId, accountCode: r.accountCode, periodKey: r.periodKey, debitMilli: big(r.d), creditMilli: big(r.c) }));
    },

    async storedPeriodBalances(tenantId): Promise<PeriodTotal[]> {
      const rows = await d.glPeriodBalance.findMany({
        where: { tenantId, OR: [{ debitMilli: { not: 0n } }, { creditMilli: { not: 0n } }] },
        select: { accountId: true, periodKey: true, debitMilli: true, creditMilli: true },
      });
      return rows.map((r) => ({ accountId: r.accountId, periodKey: r.periodKey, debitMilli: r.debitMilli, creditMilli: r.creditMilli }));
    },

    async controlAccounts(tenantId) {
      const rows = await d.glAccount.findMany({ where: { tenantId, controlKind: { not: null } }, select: { id: true, code: true, controlKind: true } });
      return rows.map((r) => ({ id: r.id, code: r.code, controlKind: r.controlKind as string }));
    },

    async mappedAccounts(tenantId, keys) {
      const rows = await d.glAccountMapping.findMany({
        where: { tenantId, key: { in: [...keys] } }, select: { key: true, account: { select: { id: true, code: true } } },
      });
      return rows.map((r) => ({ key: r.key, id: r.account.id, code: r.account.code }));
    },

    async ledgerByPartner(tenantId, accountIds, partner, opts = {}) {
      const where: Prisma.GlMoveLineWhereInput = {
        tenantId, posted: true, accountId: { in: [...accountIds] }, [partner]: { not: null },
        ...(opts.moveType ? { move: { moveType: opts.moveType, state: 'POSTED' } } : {}),
      };
      const rows = partner === 'customerId'
        ? await d.glMoveLine.groupBy({ by: ['customerId'], where, _sum: { debitMilli: true, creditMilli: true } })
        : await d.glMoveLine.groupBy({ by: ['salesRepId'], where, _sum: { debitMilli: true, creditMilli: true } });
      const out = new Map<string, Milli>();
      for (const r of rows as { customerId?: string | null; salesRepId?: string | null; _sum: { debitMilli: bigint | null; creditMilli: bigint | null } }[]) {
        const id = partner === 'customerId' ? r.customerId : r.salesRepId;
        if (!id) continue;
        out.set(id, (r._sum.debitMilli ?? 0n) - (r._sum.creditMilli ?? 0n));
      }
      return out;
    },

    async ledgerTotal(tenantId, accountIds) {
      if (accountIds.length === 0) return 0n;
      const agg = await d.glMoveLine.aggregate({
        where: { tenantId, posted: true, accountId: { in: [...accountIds] } }, _sum: { debitMilli: true, creditMilli: true },
      });
      return (agg._sum.debitMilli ?? 0n) - (agg._sum.creditMilli ?? 0n);
    },

    async accountEntryTotals(tenantId, excludeOpening, decimals) {
      const where: Prisma.AccountEntryWhereInput = {
        tenantId,
        ...(excludeOpening ? { NOT: { entryDate: { lt: excludeOpening.cutoverStart }, createdAt: { lte: excludeOpening.openingSnapshotAt } } } : {}),
      };
      const rows = await d.accountEntry.groupBy({ by: ['customerId'], where, _sum: { debit: true, credit: true } });
      const out = new Map<string, Milli>();
      for (const r of rows) out.set(r.customerId, netMilli(r._sum.debit, r._sum.credit, decimals));
      return out;
    },

    async deletedOpeningImports(tenantId, decimals) {
      const reverses = await d.glSourceEvent.findMany({
        where: { tenantId, sourceType: 'AR_ENTRY', event: 'REVERSE', NOT: { status: 'SKIPPED' } },
        select: { sourceId: true, payload: true },
      });
      const out = new Map<string, Milli>();
      if (reverses.length === 0) return out;
      const postKeys = reverses.map((r) => `AR_ENTRY:${r.sourceId}:POST`);
      const opening = await d.glSourceEvent.findMany({
        where: { tenantId, sourceKey: { in: postKeys }, status: 'SKIPPED', skipReason: 'OPENING' }, select: { sourceId: true },
      });
      const included = new Set(opening.map((o) => o.sourceId));
      for (const r of reverses) {
        if (!included.has(r.sourceId)) continue;
        const p = payloadOf(r.payload);
        const customerId = str(p?.customerId);
        if (!p || !customerId) continue;
        const debit = toMilli(String(p.debit ?? '0'), decimals);
        const credit = toMilli(String(p.credit ?? '0'), decimals);
        out.set(customerId, (out.get(customerId) ?? 0n) + debit - credit);
      }
      return out;
    },

    async customerNames(tenantId, ids) {
      const out = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 1000) {
        const rows = await d.customer.findMany({ where: { tenantId, id: { in: ids.slice(i, i + 1000) } }, select: { id: true, name: true } });
        for (const r of rows) out.set(r.id, r.name);
      }
      return out;
    },

    async salesReps(tenantId) {
      return d.salesRep.findMany({ where: { tenantId }, select: { id: true, name: true, isActive: true } });
    },

    async custodyInputs(tenantId, salesRepId) {
      let tx = postingTxs.get(tenantId);
      if (!tx) { tx = new PrismaPostingTx(d, tenantId); postingTxs.set(tenantId, tx); }
      return tx.loadCustodyInputs(salesRepId);
    },

    async repCollections(tenantId, decimals) {
      const [collected, settled] = await Promise.all([
        d.receipt.groupBy({ by: ['salesRepId'], where: { tenantId, status: 'ACTIVE', salesRepId: { not: null } }, _sum: { amount: true } }),
        d.repSettlement.groupBy({ by: ['salesRepId'], where: { tenantId }, _sum: { amount: true } }),
      ]);
      const out = new Map<string, Milli>();
      for (const r of collected) if (r.salesRepId) out.set(r.salesRepId, toMilli(r._sum.amount ?? 0, decimals));
      for (const r of settled) out.set(r.salesRepId, (out.get(r.salesRepId) ?? 0n) - toMilli(r._sum.amount ?? 0, decimals));
      return out;
    },

    async settlementBalance(tenantId, decimals) {
      const agg = await d.settlementEntry.aggregate({ where: { tenantId }, _sum: { amount: true } });
      return toMilli(Number(agg._sum.amount ?? 0), decimals);
    },

    async paylinkExplanations(tenantId, decimals) {
      const [refundRows, refundedLinks, cancelledOnline] = await Promise.all([
        d.settlementEntry.findMany({ where: { tenantId, kind: 'REFUND', linkId: { not: null } }, select: { linkId: true } }),
        d.customerPaymentLink.findMany({ where: { tenantId, status: 'refunded' }, select: { id: true, receiptId: true, amount: true } }),
        d.receipt.findMany({ where: { tenantId, paymentMethod: 'ONLINE', status: 'CANCELLED' }, select: { id: true, number: true, amount: true }, take: 500 }),
      ]);
      const refunded = new Set(refundRows.map((r) => r.linkId as string));
      const links = cancelledOnline.length
        ? await d.customerPaymentLink.findMany({ where: { tenantId, receiptId: { in: cancelledOnline.map((r) => r.id) } }, select: { id: true, receiptId: true } })
        : [];
      const linkOfReceipt = new Map(links.map((l) => [l.receiptId as string, l.id]));
      return {
        refundedLinksWithoutRefund: refundedLinks.filter((l) => !refunded.has(l.id)).map((l) => ({ linkId: l.id, receiptId: l.receiptId, amountMilli: toMilli(l.amount, decimals) })),
        cancelledOnlineWithoutRefund: cancelledOnline
          .filter((r) => { const link = linkOfReceipt.get(r.id); return !link || !refunded.has(link); })
          .map((r) => ({ receiptId: r.id, number: r.number, amountMilli: toMilli(r.amount, decimals) })),
      };
    },

    async pendingPartners(tenantId, since): Promise<PendingPartners> {
      const out: PendingPartners = { customerIds: new Set(), salesRepIds: new Set(), settlement: false, unknown: false };
      const events = await d.glSourceEvent.findMany({
        where: { tenantId, status: { in: NON_FINAL } },
        select: { sourceType: true, sourceId: true, event: true, payload: true }, take: PENDING_SCAN_LIMIT,
      });
      if (events.length >= PENDING_SCAN_LIMIT) out.unknown = true;
      const invoiceIds = new Set<string>();
      const receiptIds = new Set<string>();
      for (const e of events) {
        const p = payloadOf(e.payload);
        const c = str(p?.customerId);
        const r = str(p?.salesRepId);
        if (c) out.customerIds.add(c);
        if (r) out.salesRepIds.add(r);
        switch (e.sourceType) {
          case 'PAYLINK_FEE':
          case 'PAYOUT':
            out.settlement = true;
            break;
          case 'RECEIPT':
            if (p?.paymentMethod === 'ONLINE' || str(p?.paylinkId)) out.settlement = true;
            if (!c || !r) receiptIds.add(e.sourceId);
            break;
          case 'INVOICE':
            if (!c) invoiceIds.add(e.sourceId);
            break;
          case 'AR_ENTRY':
          case 'SETTLEMENT':
          case 'CUSTOMER_ADJUSTMENT':
            if (!p) out.unknown = true;
            break;
          default:
            break;
        }
      }
      if (invoiceIds.size) {
        const rows = await d.invoice.findMany({ where: { tenantId, id: { in: [...invoiceIds] } }, select: { id: true, customerId: true, salesRepId: true } });
        if (rows.length < invoiceIds.size) out.unknown = true;
        for (const i of rows) { out.customerIds.add(i.customerId); if (i.salesRepId) out.salesRepIds.add(i.salesRepId); }
      }
      if (receiptIds.size) {
        const rows = await d.receipt.findMany({ where: { tenantId, id: { in: [...receiptIds] } }, select: { id: true, customerId: true, salesRepId: true, paymentMethod: true } });
        if (rows.length < receiptIds.size) out.unknown = true;
        for (const r of rows) {
          out.customerIds.add(r.customerId);
          if (r.salesRepId) out.salesRepIds.add(r.salesRepId);
          if (r.paymentMethod === 'ONLINE') out.settlement = true;
        }
      }
      if (since) {
        const [entries, settlements, settlementEntries] = await Promise.all([
          d.accountEntry.findMany({
            where: { tenantId, createdAt: { gt: since } }, take: PENDING_SCAN_LIMIT,
            select: { customerId: true, invoice: { select: { salesRepId: true } }, receipt: { select: { salesRepId: true, paymentMethod: true } } },
          }),
          d.repSettlement.findMany({ where: { tenantId, createdAt: { gt: since } }, select: { salesRepId: true }, take: PENDING_SCAN_LIMIT }),
          d.settlementEntry.count({ where: { tenantId, createdAt: { gt: since } } }),
        ]);
        if (entries.length >= PENDING_SCAN_LIMIT) out.unknown = true;
        for (const e of entries) {
          out.customerIds.add(e.customerId);
          const rep = e.invoice?.salesRepId ?? e.receipt?.salesRepId ?? null;
          if (rep) out.salesRepIds.add(rep);
          if (e.receipt?.paymentMethod === 'ONLINE') out.settlement = true;
        }
        for (const s of settlements) out.salesRepIds.add(s.salesRepId);
        if (settlementEntries > 0) out.settlement = true;
      }
      return out;
    },

    async problemEvents(tenantId, limit): Promise<ProblemEvent[]> {
      const rows = await d.glSourceEvent.findMany({
        where: { tenantId, status: { in: ['BLOCKED', 'ERROR', 'HELD'] } },
        orderBy: [{ detectedAt: 'asc' }, { sourceKey: 'asc' }], take: limit,
        select: {
          id: true, sourceKey: true, sourceType: true, event: true, status: true, effectAt: true, detectedAt: true,
          nextAttemptAt: true, attempts: true, lastError: true,
        },
      });
      const keys = [...new Set(rows.map((r) => siblingPostKey(r.sourceKey)).filter((k): k is string => !!k))];
      const siblings = keys.length
        ? await d.glSourceEvent.findMany({
          where: { tenantId, sourceKey: { in: keys } }, select: { sourceKey: true, status: true, skipReason: true, nextAttemptAt: true },
        })
        : [];
      const byKey = new Map(siblings.map((s) => [s.sourceKey, s]));
      return rows.map((r) => {
        const k = siblingPostKey(r.sourceKey);
        const s = k ? byKey.get(k) : undefined;
        return {
          ...r,
          sibling: k ? { sourceKey: k, status: s?.status ?? 'MISSING', skipReason: s?.skipReason ?? null, nextAttemptAt: s?.nextAttemptAt ?? null } : null,
        };
      });
    },

    async cursorStates(tenantId, dbNow): Promise<CursorFacts[]> {
      const rows = await d.glSyncCursor.findMany({ where: { tenantId } });
      const reconciler = createPrismaReconcilerStore(db as unknown as PrismaClient);
      const out: CursorFacts[] = [];
      for (const c of rows) {
        const lagMs = (RECONCILED_SOURCES as readonly string[]).includes(c.source)
          ? await cursorLagMs(reconciler, tenantId, c.source as (typeof RECONCILED_SOURCES)[number], dbNow)
          : null;
        out.push({ source: c.source, watermarkAt: c.watermarkAt, lastRunAt: c.lastRunAt, lastCount: c.lastCount, stallTicks: c.stallTicks, lagMs });
      }
      return out;
    },

    async attentionMovesOn(tenantId, accountId, limit) {
      const lines = await d.glMoveLine.findMany({
        where: { tenantId, accountId, posted: true },
        orderBy: [{ date: 'desc' }], take: limit,
        select: { debitMilli: true, creditMilli: true, move: { select: { id: true, number: true, date: true, attentionReason: true } } },
      });
      return lines.map((l) => ({
        moveId: l.move.id, number: l.move.number, date: fromDbDate(l.move.date), attentionReason: l.move.attentionReason,
        amountMilli: l.debitMilli - l.creditMilli,
      }));
    },

    async draftsUpTo(tenantId, date, limit) {
      const where = { tenantId, state: 'DRAFT', date: { lte: toDbDate(date) } };
      const [count, rows] = await Promise.all([
        d.glMove.count({ where }),
        d.glMove.findMany({ where, orderBy: { date: 'asc' }, take: limit, select: { id: true, date: true, ref: true } }),
      ]);
      return { count, drafts: rows.map((r) => ({ id: r.id, date: fromDbDate(r.date), ref: r.ref })) };
    },

    async taxes(tenantId) {
      return d.glTax.findMany({ where: { tenantId }, select: { id: true, key: true, name: true, rate: true, vatBox: true } });
    },

    async sequences(tenantId) {
      const rows = await d.glSequence.findMany({
        where: { tenantId }, select: { journalId: true, prefix: true, periodKey: true, nextNumber: true, journal: { select: { code: true } } },
      });
      return rows.map((r) => ({ journalId: r.journalId, journalCode: r.journal?.code ?? null, prefix: r.prefix, periodKey: r.periodKey, nextNumber: r.nextNumber }));
    },

    async postedMoveNumbers(tenantId) {
      const rows = await d.glMove.findMany({ where: { tenantId, state: 'POSTED', number: { not: null } }, select: { journalId: true, number: true } });
      return rows.map((r) => ({ journalId: r.journalId, number: r.number as string }));
    },

    async erpOdooActive(tenantId) {
      const [tenant, erp] = await Promise.all([
        d.tenant.findUnique({ where: { id: tenantId }, select: { erpEnabled: true, accountingSuiteEnabled: true } }),
        d.erpIntegration.findUnique({ where: { tenantId }, select: { enabled: true, provider: true } }),
      ]);
      return !!tenant?.erpEnabled && !!erp?.enabled && erp.provider === 'ODOO';
    },
  };
}

