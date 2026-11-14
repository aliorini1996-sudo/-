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
import { SETTLEMENT_HAS_REP, settlementHasRep } from '../settlementRep';
import type { Prisma, PrismaClient } from '@prisma/client';
import { sourceEventCreateRow, factIdsForRows, type DeriveContext, type ReconciledSource, type SourceRow } from './desired';
import { loadAdminNames, loadInvoiceFacts, loadReceiptFacts, loadRefundLinks } from './facts.prisma';
import { isLinked } from '../mode';
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
        select: { activatedAt: true, timezone: true, currency: true, currencyDecimals: true, setupMethod: true },
      });
      if (!s) return null;
      const company = await db.companySettings.findUnique({ where: { tenantId }, select: { currency: true } });
      return {
        tenantId, activatedAt: s.activatedAt, timezone: s.timezone,
        currency: company?.currency ?? s.currency, currencyDecimals: s.currencyDecimals,
        // «ربط الدفاتر» (D1): المربوطة المفعّلة وحدها
        linked: isLinked({ setupMethod: s.setupMethod, activatedAt: s.activatedAt }),
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
          return (await db.repSettlement.findMany({
            where: { ...where, ...SETTLEMENT_HAS_REP }, orderBy: ORDER, take: q.limit,
            select: { id: true, salesRepId: true, amount: true, method: true, note: true, settledAt: true, createdAt: true, receivedByUserId: true },
          })).filter(settlementHasRep);
        case 'SETTLEMENT_ENTRY':
          return db.settlementEntry.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: { id: true, kind: true, amount: true, feeNet: true, feeVat: true, linkId: true, payoutId: true, note: true, createdAt: true },
          });
        case 'USER_SETTLEMENT':
          // «ربط الدفاتر» L5 (D13): الفهرس [tenantId, createdAt, id] — والمؤشر للمربوطة وحدها
          return db.userSettlement.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: { id: true, fromUserId: true, amount: true, method: true, note: true, receivedBy: true, receivedByUserId: true, settledAt: true, createdAt: true },
          });
      }
    },

    async loadFacts(tenantId, source, rows, settings): Promise<DeriveContext> {
      const ids = factIdsForRows(source, rows);
      const ctx: DeriveContext = { timezone: settings.timezone, currency: settings.currency, currencyDecimals: settings.currencyDecimals };
      // «ربط الدفاتر» (D1): المربوطة وحدها تحمّل الحقائق الجديدة وتُعلَّم؛ غيرها بالاستعلامات نفسها حرفاً (facts.prisma.ts)
      const linked = settings.linked === true;
      if (linked) ctx.linked = true;

      if (ids.invoiceIds.length > 0) ctx.invoices = await loadInvoiceFacts(db, tenantId, ids.invoiceIds, { linked });
      if (ids.receiptIds.length > 0) ctx.receipts = await loadReceiptFacts(db, tenantId, ids.receiptIds, { linked });

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
      if (linked && ids.userIds.length > 0) ctx.userNames = await loadAdminNames(db, tenantId, ids.userIds);
      if (linked && ids.linkIds.length > 0) ctx.refundLinks = await loadRefundLinks(db, tenantId, ids.linkIds);
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
        case 'REP_SETTLEMENT': return !!(await db.repSettlement.findFirst({ where: { ...where, ...SETTLEMENT_HAS_REP }, select }));
        case 'SETTLEMENT_ENTRY': return !!(await db.settlementEntry.findFirst({ where, select }));
        case 'USER_SETTLEMENT': return !!(await db.userSettlement.findFirst({ where, select }));
      }
    },
  };
}
