/**
 * تنفيذ ReconcilerStore بـPrisma (M3، DESIGN.md §5.1، §5.2).
 *
 * يأخذ العميل من المُستدعي (المجدول يمرّر PrismaClient المستقل بـ?connection_limit=1)، فلا يستورد config/database.
 * - الصفحة بصيغة Prisma للمفتاح المركّب: OR:[{createdAt:{gt:at}}, {createdAt:at, id:{gt:id}}] مع createdAt <= upTo،
 *   مرتبة بـ[createdAt, id] (الفهارس @@index([tenantId, createdAt, id]) على الجداول الثلاثة).
 * - الالتزام في معاملة واحدة: createMany({skipDuplicates}) ثم updateMany مشروط بأن المفتاح الجديد أكبر (GREATEST) —
 *   فلا يتراجع المؤشر حين تكتب نبضة انتهى عقدها.
 * - الحقائق بالمفتاح الأساسي لصفوف الصفحة فقط (invoice.findMany({where:{tenantId, id:{in}}})…).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { sourceEventCreateRow, factIdsForRows, type DeriveContext, type InvoiceFacts, type ReceiptFacts, type ReconciledSource, type SourceRow } from './desired';
import type { CommitPageResult, PageQuery, ReconcileSettings, ReconcilerStore } from './reconciler';
import type { CompositeKey, DesiredEvent, SyncCursorState } from './types';

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

function afterWhere(q: Pick<PageQuery, 'after' | 'upTo'>) {
  return {
    createdAt: { lte: q.upTo },
    OR: [{ createdAt: { gt: q.after.at } }, { createdAt: q.after.at, id: { gt: q.after.id } }],
  };
}

const ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

function createRows(tenantId: string, events: readonly DesiredEvent[]): Prisma.GlSourceEventCreateManyInput[] {
  return events.map((e) => sourceEventCreateRow(tenantId, e) as Prisma.GlSourceEventCreateManyInput);
}

async function insert(db: Tx | Db, tenantId: string, events: readonly DesiredEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const r = await db.glSourceEvent.createMany({ data: createRows(tenantId, events), skipDuplicates: true });
  return r.count;
}

export function createPrismaReconcilerStore(db: Db): ReconcilerStore {
  return {
    async dbNow() {
      const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      return new Date(rows[0].now);
    },

    async loadSettings(tenantId): Promise<ReconcileSettings | null> {
      const s = await db.glSettings.findUnique({
        where: { tenantId },
        select: { activatedAt: true, timezone: true, currency: true, currencyDecimals: true },
      });
      if (!s) return null;
      const company = await db.companySettings.findUnique({ where: { tenantId }, select: { currency: true } });
      return {
        tenantId, activatedAt: s.activatedAt, timezone: s.timezone,
        currency: company?.currency ?? s.currency, currencyDecimals: s.currencyDecimals,
      };
    },

    async readCursor(tenantId, source): Promise<SyncCursorState | null> {
      const c = await db.glSyncCursor.findUnique({ where: { tenantId_source: { tenantId, source } } });
      if (!c) return null;
      return {
        source, watermarkAt: c.watermarkAt, watermarkId: c.watermarkId, lastRunAt: c.lastRunAt,
        lastCount: c.lastCount, stallTicks: c.stallTicks,
      };
    },

    async readPage(tenantId, source, q): Promise<SourceRow[]> {
      const where = { tenantId, ...afterWhere(q) };
      switch (source) {
        case 'ACCOUNT_ENTRY':
          return db.accountEntry.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: { id: true, customerId: true, invoiceId: true, receiptId: true, type: true, debit: true, credit: true, description: true, entryDate: true, createdAt: true },
          });
        case 'REP_SETTLEMENT':
          return db.repSettlement.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: { id: true, salesRepId: true, amount: true, method: true, note: true, settledAt: true, createdAt: true },
          });
        case 'SETTLEMENT_ENTRY':
          return db.settlementEntry.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: { id: true, kind: true, amount: true, feeNet: true, feeVat: true, linkId: true, payoutId: true, note: true, createdAt: true },
          });
      }
    },

    async loadFacts(tenantId, source, rows, settings): Promise<DeriveContext> {
      const ids = factIdsForRows(source, rows);
      const ctx: DeriveContext = { timezone: settings.timezone, currency: settings.currency, currencyDecimals: settings.currencyDecimals };

      if (ids.invoiceIds.length > 0) {
        const list = await db.invoice.findMany({
          where: { tenantId, id: { in: ids.invoiceIds } },
          select: {
            id: true, number: true, type: true, customerId: true, salesRepId: true, pricesIncludeTax: true,
            subtotal: true, discountAmt: true, taxAmt: true, total: true, dueDate: true,
            customer: { select: { name: true } }, salesRep: { select: { name: true } },
            items: {
              select: { productId: true, qty: true, unitPrice: true, taxPct: true, taxAmt: true, lineTotal: true, vatCategory: true, product: { select: { categoryId: true } } },
              orderBy: { id: 'asc' },
            },
          },
        });
        ctx.invoices = new Map(list.map((i): [string, InvoiceFacts] => [i.id, {
          id: i.id, number: i.number, type: i.type, customerId: i.customerId, salesRepId: i.salesRepId,
          pricesIncludeTax: i.pricesIncludeTax, subtotal: i.subtotal, discountAmt: i.discountAmt, taxAmt: i.taxAmt, total: i.total,
          dueDate: i.dueDate, customerName: i.customer?.name ?? null, salesRepName: i.salesRep?.name ?? null,
          items: i.items.map((it) => ({
            productId: it.productId, categoryId: it.product?.categoryId ?? null, qty: it.qty, unitPrice: it.unitPrice,
            taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal, vatCategory: it.vatCategory,
          })),
        }]));
      }

      if (ids.receiptIds.length > 0) {
        const list = await db.receipt.findMany({
          where: { tenantId, id: { in: ids.receiptIds } },
          select: {
            id: true, number: true, customerId: true, salesRepId: true, paymentMethod: true, amount: true,
            customer: { select: { name: true } }, salesRep: { select: { name: true } },
          },
        });
        // paylinkId من CustomerPaymentLink.receiptId = receipt.id — لا من clientRef
        const links = await db.customerPaymentLink.findMany({
          where: { tenantId, receiptId: { in: ids.receiptIds } },
          select: { id: true, receiptId: true },
        });
        const linkByReceipt = new Map(links.filter((l) => l.receiptId).map((l) => [l.receiptId as string, l.id]));
        const refunds = links.length === 0 ? [] : await db.settlementEntry.findMany({
          where: { tenantId, kind: 'REFUND', linkId: { in: links.map((l) => l.id) } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, linkId: true, amount: true },
        });
        const refundByLink = new Map<string, { entryId: string; amount: number }>();
        for (const r of refunds) if (r.linkId && !refundByLink.has(r.linkId)) refundByLink.set(r.linkId, { entryId: r.id, amount: r.amount });
        ctx.receipts = new Map(list.map((r): [string, ReceiptFacts] => {
          const paylinkId = linkByReceipt.get(r.id) ?? null;
          return [r.id, {
            id: r.id, number: r.number, customerId: r.customerId, salesRepId: r.salesRepId, paymentMethod: r.paymentMethod,
            amount: r.amount, customerName: r.customer?.name ?? null, salesRepName: r.salesRep?.name ?? null,
            paylinkId, refund: paylinkId ? (refundByLink.get(paylinkId) ?? null) : null,
          }];
        }));
      }

      if (ids.customerIds.length > 0) {
        const list = await db.customer.findMany({ where: { tenantId, id: { in: ids.customerIds } }, select: { id: true, name: true } });
        ctx.customerNames = new Map(list.map((c) => [c.id, c.name]));
      }
      if (ids.salesRepIds.length > 0) {
        const list = await db.salesRep.findMany({ where: { tenantId, id: { in: ids.salesRepIds } }, select: { id: true, name: true } });
        ctx.salesRepNames = new Map(list.map((r) => [r.id, r.name]));
      }
      if (ids.payoutIds.length > 0) {
        const list = await db.payout.findMany({ where: { tenantId, id: { in: ids.payoutIds } }, select: { id: true, bankReference: true } });
        ctx.payouts = new Map(list.map((p) => [p.id, { id: p.id, bankReference: p.bankReference }]));
      }
      return ctx;
    },

    async commitPage(tenantId, source, events, advanceTo, rowCount): Promise<CommitPageResult> {
      return db.$transaction(async (tx) => {
        const inserted = await insert(tx, tenantId, events);
        // GREATEST: التحديث مشروط بأن (advanceTo.at, advanceTo.id) > المؤشر القائم
        await tx.glSyncCursor.updateMany({
          where: {
            tenantId, source,
            OR: [{ watermarkAt: { lt: advanceTo.at } }, { watermarkAt: advanceTo.at, watermarkId: { lt: advanceTo.id } }],
          },
          data: { watermarkAt: advanceTo.at, watermarkId: advanceTo.id },
        });
        await tx.glSyncCursor.updateMany({ where: { tenantId, source }, data: { lastRunAt: new Date(), lastCount: rowCount } });
        const c = await tx.glSyncCursor.findUnique({ where: { tenantId_source: { tenantId, source } }, select: { watermarkAt: true, watermarkId: true } });
        const watermark: CompositeKey = c ? { at: c.watermarkAt, id: c.watermarkId } : advanceTo;
        return { inserted, watermark };
      });
    },

    insertEvents(tenantId, events) {
      return insert(db, tenantId, events);
    },

    async recordStall(tenantId, source) {
      await db.glSyncCursor.updateMany({ where: { tenantId, source }, data: { stallTicks: { increment: 1 } } });
      const c = await db.glSyncCursor.findUnique({ where: { tenantId_source: { tenantId, source } }, select: { stallTicks: true } });
      return c?.stallTicks ?? 0;
    },

    async hasUnreadRows(tenantId, source: ReconciledSource, watermark, horizon) {
      const where = { tenantId, ...afterWhere({ after: watermark, upTo: horizon }) };
      const select = { id: true } as const;
      switch (source) {
        case 'ACCOUNT_ENTRY': return !!(await db.accountEntry.findFirst({ where, select }));
        case 'REP_SETTLEMENT': return !!(await db.repSettlement.findFirst({ where, select }));
        case 'SETTLEMENT_ENTRY': return !!(await db.settlementEntry.findFirst({ where, select }));
      }
    },
  };
}
