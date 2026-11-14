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
import { isDamagedVanReturn } from '../../vanDamaged';
import type { CostItemFacts, RestockInvoiceFacts, RestockLogSourceRow, SupplierEntrySourceRow, VanLoadSourceRow, WarehouseEntrySourceRow } from './desired';
import type { SupplierEntryWarehouseFacts } from './types';
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
        select: { activatedAt: true, timezone: true, currency: true, currencyDecimals: true, setupMethod: true, inventoryMode: true },
      });
      if (!s) return null;
      const company = await db.companySettings.findUnique({ where: { tenantId }, select: { currency: true } });
      const linked = isLinked({ setupMethod: s.setupMethod, activatedAt: s.activatedAt });
      return {
        tenantId, activatedAt: s.activatedAt, timezone: s.timezone,
        currency: company?.currency ?? s.currency, currencyDecimals: s.currencyDecimals,
        // «ربط الدفاتر» (D1): المربوطة المفعّلة وحدها
        linked,
        // «ربط الدفاتر» L6: المخزون والمشتريات وتكلفة المبيعات — المربوطة بالجرد المستمر وحدها (يُكتب حين true فقط)
        ...(linked && s.inventoryMode === 'PERPETUAL' ? { inventoryPosting: true } : {}),
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
        // «ربط الدفاتر» L6: الفهارس [tenantId, createdAt, id] على الجداول الأربعة — والمؤشّرات للمربوطة بالجرد المستمر وحدها
        case 'WAREHOUSE_ENTRY':
          return db.warehouseEntry.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: {
              id: true, type: true, source: true, reason: true, zeroRunId: true, vendorId: true, supplierRef: true, note: true,
              billDate: true, totalMilli: true, createdAt: true, items: { select: { id: true, qty: true, baseQty: true }, orderBy: { id: 'asc' } },
            },
          }) as Promise<WarehouseEntrySourceRow[]>;
        case 'VAN_LOAD':
          return db.vanLoad.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: {
              id: true, type: true, reason: true, zeroRunId: true, salesRepId: true, deletedSalesRepId: true, note: true, createdAt: true,
              items: { select: { id: true, qty: true, baseQty: true }, orderBy: { id: 'asc' } },
            },
          }) as Promise<VanLoadSourceRow[]>;
        case 'RETURN_RESTOCK':
          return db.invoiceRestockLog.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: { id: true, invoiceId: true, previous: true, returnToStock: true, createdAt: true },
          }) as Promise<RestockLogSourceRow[]>;
        case 'SUPPLIER_ENTRY':
          return db.supplierLedgerEntry.findMany({
            where, orderBy: ORDER, take: q.limit,
            select: {
              id: true, vendorId: true, kind: true, amountMilli: true, netMilli: true, taxMilli: true, warehouseEntryId: true,
              supplierPaymentId: true, reversesId: true, docDate: true, dueDate: true, ref: true, note: true, createdAt: true,
            },
          }) as Promise<SupplierEntrySourceRow[]>;
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
      // «ربط الدفاتر» L6: المربوطة بالجرد المستمر وحدها — غيرها لا استعلام زائد ولا حقل جديد
      if (linked && settings.inventoryPosting === true) {
        ctx.inventoryPosting = true;
        await loadInventoryFacts(db, tenantId, source, rows, ctx, ids.invoiceIds);
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
        case 'REP_SETTLEMENT': return !!(await db.repSettlement.findFirst({ where: { ...where, ...SETTLEMENT_HAS_REP }, select }));
        case 'SETTLEMENT_ENTRY': return !!(await db.settlementEntry.findFirst({ where, select }));
        case 'USER_SETTLEMENT': return !!(await db.userSettlement.findFirst({ where, select }));
        case 'WAREHOUSE_ENTRY': return !!(await db.warehouseEntry.findFirst({ where, select }));
        case 'VAN_LOAD': return !!(await db.vanLoad.findFirst({ where, select }));
        case 'RETURN_RESTOCK': return !!(await db.invoiceRestockLog.findFirst({ where, select }));
        case 'SUPPLIER_ENTRY': return !!(await db.supplierLedgerEntry.findFirst({ where, select }));
      }
    },
  };
}

// ═══ «ربط الدفاتر» L6: حقائق المخزون والمشتريات وتكلفة المبيعات (بالمفتاح الأساسي لصفوف الصفحة) ═══

const uniq = (xs: readonly (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

const COST_ITEM_SELECT = {
  id: true, invoiceId: true, productId: true, qty: true, baseQty: true, unitFactor: true, returnExpired: true,
  product: { select: { categoryId: true } },
} as const;

type CostItemRow = {
  id: string; invoiceId: string; productId: string | null; qty: number; baseQty: number | null; unitFactor: number | null;
  returnExpired: boolean | null; product: { categoryId: string | null } | null;
};

const costItemOf = (it: CostItemRow): CostItemFacts => ({
  id: it.id, invoiceId: it.invoiceId, productId: it.productId, qty: it.qty, baseQty: it.baseQty, unitFactor: it.unitFactor,
  returnExpired: it.returnExpired, categoryId: it.product?.categoryId ?? null,
});

async function repNames(db: Db, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const list = await db.salesRep.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true, name: true } });
  return new Map(list.map((r) => [r.id, r.name]));
}

async function vendorNames(db: Db, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const list = await db.glVendor.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true, name: true } });
  return new Map(list.map((v) => [v.id, v.name]));
}

async function loadInventoryFacts(
  db: Db, tenantId: string, source: ReconciledSource, rows: readonly SourceRow[], ctx: DeriveContext, invoiceIds: readonly string[],
): Promise<void> {
  switch (source) {
    case 'ACCOUNT_ENTRY': {
      if (invoiceIds.length === 0) return;
      const items = (await db.invoiceItem.findMany({
        where: { invoiceId: { in: [...invoiceIds] }, invoice: { tenantId } }, select: COST_ITEM_SELECT, orderBy: { id: 'asc' },
      })) as CostItemRow[];
      const by = new Map<string, CostItemFacts[]>();
      for (const it of items) {
        const list = by.get(it.invoiceId) ?? [];
        list.push(costItemOf(it));
        by.set(it.invoiceId, list);
      }
      ctx.costItems = by;
      return;
    }
    case 'WAREHOUSE_ENTRY': {
      ctx.vendorNames = await vendorNames(db, tenantId, uniq((rows as readonly WarehouseEntrySourceRow[]).map((r) => r.vendorId)));
      return;
    }
    case 'VAN_LOAD': {
      const ids = uniq((rows as readonly VanLoadSourceRow[]).map((r) => r.salesRepId ?? r.deletedSalesRepId));
      ctx.salesRepNames = await repNames(db, tenantId, ids);
      return;
    }
    case 'RETURN_RESTOCK': {
      const invIds = uniq((rows as readonly RestockLogSourceRow[]).map((r) => r.invoiceId));
      if (invIds.length === 0) return;
      const invs = await db.invoice.findMany({
        where: { tenantId, id: { in: invIds } },
        select: {
          id: true, number: true, type: true, salesRepId: true, returnReason: true, createdAt: true,
          salesRep: { select: { name: true } }, items: { select: COST_ITEM_SELECT, orderBy: { id: 'asc' } },
        },
      });
      ctx.restockInvoices = new Map(invs.map((i): [string, RestockInvoiceFacts] => [i.id, {
        id: i.id, number: i.number, type: i.type, salesRepId: i.salesRepId, salesRepName: i.salesRep?.name ?? null,
        damaged: isDamagedVanReturn(i), items: (i.items as CostItemRow[]).map(costItemOf),
      }]));
      // رقم التبديل: ترتيب الصفّ بين صفوف فاتورته (إلحاقية ⇒ حتمي)
      const logs = await db.invoiceRestockLog.findMany({
        where: { tenantId, invoiceId: { in: invIds } }, select: { id: true, invoiceId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const seen = new Map<string, number>();
      const gens = new Map<string, number>();
      for (const l of logs) {
        const n = (seen.get(l.invoiceId) ?? 0) + 1;
        seen.set(l.invoiceId, n);
        gens.set(l.id, n);
      }
      ctx.restockGenerations = gens;
      return;
    }
    case 'SUPPLIER_ENTRY': {
      const rs = rows as readonly SupplierEntrySourceRow[];
      ctx.vendorNames = await vendorNames(db, tenantId, uniq(rs.map((r) => r.vendorId)));
      const payIds = uniq(rs.map((r) => r.supplierPaymentId));
      const pays = payIds.length > 0
        ? await db.supplierPayment.findMany({ where: { tenantId, id: { in: payIds } }, select: { id: true, number: true, method: true, salesRepId: true } })
        : [];
      ctx.supplierPayments = new Map(pays.map((p) => [p.id, { id: p.id, number: p.number, method: p.method, salesRepId: p.salesRepId }]));
      const weIds = uniq(rs.map((r) => r.warehouseEntryId));
      const wes = weIds.length > 0
        ? await db.warehouseEntry.findMany({
          where: { tenantId, id: { in: weIds } },
          select: { id: true, type: true, vatTreatment: true, paidAccountRef: true, createdAt: true, items: { select: { id: true, qty: true, baseQty: true } } },
        })
        : [];
      ctx.supplierWarehouse = new Map(wes.map((w): [string, SupplierEntryWarehouseFacts] => [w.id, {
        id: w.id, type: w.type, vatTreatment: w.vatTreatment, paidAccountRef: w.paidAccountRef,
        costRef: { at: w.createdAt.toISOString(), id: w.id },
        expectedItemIds: w.items.filter((i) => { const q = i.baseQty ?? i.qty; return Number.isFinite(q) && q !== 0; }).map((i) => i.id).sort(),
      }]));
      const reps = uniq([
        ...pays.map((p) => p.salesRepId),
        ...wes.map((w) => (w.paidAccountRef ? /^REP_CUSTODY:(.+)$/.exec(w.paidAccountRef)?.[1] ?? null : null)),
      ]);
      ctx.salesRepNames = await repNames(db, tenantId, reps);
      return;
    }
    default:
      return;
  }
}
