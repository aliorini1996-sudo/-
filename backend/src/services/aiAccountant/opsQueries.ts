/**
 * «المحاسب الذكي AI» — قراءات أدوات التشغيل من القاعدة (حزمة A2).
 *
 * كل دالّة هنا **تنسخ شرط where لمسارها حرفياً** (routes/reports.ts وroutes/dashboard.ts وroutes/warehouse.ts وroutes/suppliers.ts)
 * بلا تعديلها، مع فرقين مقصودين لا غير:
 *   ١. الحدود [gte, lt) بأيام الشركة المحلية (period.ts) لا منتصف ليل UTC ولا توقيت الخادم.
 *   ٢. لا نطاق مستخدم (scopedRecordWhere/adminCustomerFilter/adminRepFilter): الموجّه يرفض المدير المقيَّد أصلاً
 *      (403 AI_ACCOUNTANT_SCOPED) وجلسة المالك غير مقيَّدة بتصميمها — فالنطاق في كل استعلامٍ هنا `{}` كما يحسبه المسار لهما.
 * والشركة **دائماً** من سياق الجلسة (المعامل tid) — لا معرّف من وسائط النموذج يصل إلى هنا.
 * تجميعاتٌ في القاعدة لا صفوفٌ كاملة حيث أمكن (حصّة الذاكرة)، والقراءة الثقيلة الوحيدة (بنود الفواتير لترتيب الأصناف) مسقوفة.
 */
import prisma from '../../config/database';
import { COLLECTED_CASH_SALE, COLLECTED_RECEIPT } from '../paymentMethodsReport';
import { readPaymentMethodsConfig, type PaymentMethodsConfigV1 } from '../paymentMethodsCore';
import { computeWarehouseStock, tenantCurrencyDecimals, type PurchaseAggRow, type WarehouseRow } from '../warehouseStock';
import { loadValuation } from '../stockZero';
import { agingJson, loadAging } from '../suppliers/statement';
import { importedEntryInstant } from '../importTimezoneRebase';
import { importTimezone } from '../importLedger';
import { addDays, isLocalDate, toDbDate } from '../gl/dates';
import type { RepTypeGroup } from '../topReps';
import type { UnitSnapshot } from '../units';

/** مجموع فواتير مؤكَّدة لنوعٍ واحد (CASH | CREDIT | RETURN) في الفترة */
export interface TypeTotals { type: string | null; total: number; taxAmt: number; discountAmt: number; count: number }
/** سندات قبض سارية مجمّعة بطريقة الدفع */
export interface ReceiptMethodGroup { paymentMethod: string; paymentMethodKey: string | null; amount: number; count: number }
/** مجموع فواتير صاحبٍ (عميل) لنوعٍ واحد */
export interface PartyGroup { id: string | null; type: string | null; total: number; count: number }
/** بند فاتورة كما يقرؤه salesByProduct (routes/reports.ts) — شكل salesInclude بلا الحقول التي لا يمسّها */
export type SaleItemRow = {
  qty: number; lineTotal: number; baseQty?: number | null;
  product: { id: string; name: string; code: string; unit: string; primaryUnitId?: string | null } | null;
} & UnitSnapshot;
export interface ReceivablesData {
  /** Σ الأرصدة المدينة (> 1e-6) وعدد أصحابها — جمهور GET /reports/balances?type=overdue */
  debit: { total: number; count: number };
  /** Σ الأرصدة الدائنة (< −1e-6: دفعاتٌ مقدّمة أو زيادة تحصيل) وعدد أصحابها — قيمةٌ موجبة */
  credit: { total: number; count: number };
  /** عملاء رصيدهم فوق حدّهم الائتماني (> 0) — جمهور ?type=exceeded */
  exceededCount: number;
  /** أعلى المدينين (رصيداً تنازلياً، كترتيب المسار) */
  top: { name: string; balance: number; creditLimit: number; paymentDays: number | null; status: string }[];
}
export type AgingJson = ReturnType<typeof agingJson>;

/** سقف بنود الفواتير لترتيب الأصناف وتقدير الربح — فترةٌ أكبر تُرفض بطلب تقليصها لا تُقصّ صامتة */
export const SALE_ITEMS_CAP = 150_000;

/** قراءات أدوات التشغيل — تُحقن في buildOpsTools فتُختبر الأدوات بقاعدة مزيّفة بلا شبكة */
export interface OpsDeps {
  salesByType(tid: string, gte: Date, lt: Date): Promise<TypeTotals[]>;
  receiptsByMethod(tid: string, gte: Date, lt: Date): Promise<ReceiptMethodGroup[]>;
  cashSalesCollected(tid: string, gte: Date, lt: Date): Promise<{ amount: number; count: number }>;
  paymentMethodsConfig(tid: string): Promise<PaymentMethodsConfigV1 | null>;
  purchases(tid: string, gte: Date, lt: Date): Promise<PurchaseAggRow[]>;
  supplierPayments(tid: string, fromLocal: string, toLocal: string): Promise<{ amount: number; count: number }>;
  currencyDecimals(tid: string): Promise<number>;
  warehouseAsOf(tid: string, day: string): Promise<Date | undefined>;
  warehouseStock(tid: string, decimals: number, before?: Date): Promise<WarehouseRow[]>;
  supplierAging(tid: string, asOfLocal: string): Promise<AgingJson>;
  receivables(tid: string, topN: number): Promise<ReceivablesData>;
  customerGroups(tid: string, gte: Date, lt: Date): Promise<PartyGroup[]>;
  customerNames(tid: string, ids: string[]): Promise<Map<string, string>>;
  repGroups(tid: string, gte: Date, lt: Date): Promise<RepTypeGroup[]>;
  activeReps(tid: string): Promise<{ id: string; name: string }[]>;
  /** بنود فواتير البيع والمرتجع المؤكَّدة في الفترة — null إن تجاوزت SALE_ITEMS_CAP */
  saleItems(tid: string, gte: Date, lt: Date): Promise<{ sales: SaleItemRow[]; returns: SaleItemRow[] } | null>;
  /** متوسّط تكلفة وحدة الأساس غير المقرَّب لكل صنف (stockZero.loadValuation — مخزون الشركة) */
  avgCosts(tid: string, decimals: number): Promise<Map<string, number>>;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** شرط فواتير التقرير — baseWhere في GET /reports/sales بلا فلاتر المعرّفات والنطاق، وبحدّي الشركة */
const invoiceWhere = (tid: string, gte: Date, lt: Date) => ({ tenantId: tid, status: 'CONFIRMED', invoiceDate: { gte, lt } });

export const defaultOpsDeps: OpsDeps = {
  async salesByType(tid, gte, lt) {
    // تجميعٌ واحد بالنوع يغني عن تجميعَي البيع والمرتجع (dashboard.ts) — البيع = غير RETURN، والمرتجع RETURN
    const groups = await prisma.invoice.groupBy({
      by: ['type'],
      where: invoiceWhere(tid, gte, lt),
      _sum: { total: true, taxAmt: true, discountAmt: true },
      _count: { _all: true },
    });
    return groups.map((g) => ({
      type: g.type, total: num(g._sum.total), taxAmt: num(g._sum.taxAmt), discountAmt: num(g._sum.discountAmt), count: g._count._all,
    }));
  },

  async receiptsByMethod(tid, gte, lt) {
    // GET /reports/collections: السند الساري (COLLECTED_RECEIPT) بتاريخه — مجمّعاً بالطريقة كـGET /reports/payment-methods
    const groups = await prisma.receipt.groupBy({
      by: ['paymentMethod', 'paymentMethodKey'],
      where: { tenantId: tid, ...COLLECTED_RECEIPT, receiptDate: { gte, lt } },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return groups.map((g) => ({ paymentMethod: g.paymentMethod, paymentMethodKey: g.paymentMethodKey, amount: num(g._sum.amount), count: g._count._all }));
  },

  async cashSalesCollected(tid, gte, lt) {
    // فواتير البيع النقدي المحصَّلة (GET /reports/payment-methods): المدفوع منها، وشرط «المحصَّل» في AND لأن فيه OR
    const agg = await prisma.invoice.aggregate({
      where: { tenantId: tid, invoiceDate: { gte, lt }, AND: [COLLECTED_CASH_SALE] },
      _sum: { paidAmt: true },
      _count: { _all: true },
    });
    return { amount: num(agg._sum.paidAmt), count: agg._count._all };
  },

  async paymentMethodsConfig(tid) {
    const row = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { paymentMethodsConfig: true } });
    return readPaymentMethodsConfig(row?.paymentMethodsConfig ?? null);
  },

  async purchases(tid, gte, lt) {
    // استعلام «المشتريات الشهرية» في routes/dashboard.ts حرفياً، بحدَّي الفترة على createdAt بدل «منذ أول الشهر»
    return prisma.$queryRaw<PurchaseAggRow[]>`
      SELECT e.type, e.status, e.source, o.source AS "returnOfSource",
             COALESCE(SUM(i.qty * i."unitCost"), 0)::float8 AS value,
             COUNT(DISTINCT e.id)::int AS entries
      FROM "warehouse_entry_items" i
      JOIN "warehouse_entries" e ON e.id = i."entryId"
      LEFT JOIN "warehouse_entries" o ON o.id = e."returnOfEntryId"
      WHERE e."tenantId" = ${tid} AND e.type IN ('RECEIVE', 'RETURN')
        AND e."createdAt" >= ${gte} AND e."createdAt" < ${lt} AND i."unitCost" IS NOT NULL
      GROUP BY 1, 2, 3, 4`;
  },

  async supplierPayments(tid, fromLocal, toLocal) {
    // سندات صرف الموردين السارية (POSTED) — paidAt عمود @db.Date فالحدّان يوما الفترة المحليّان شاملين
    const agg = await prisma.supplierPayment.aggregate({
      where: { tenantId: tid, status: 'POSTED', paidAt: { gte: toDbDate(fromLocal), lte: toDbDate(toLocal) } },
      _sum: { amountMilli: true },
      _count: { _all: true },
    });
    return { amount: Number(agg._sum.amountMilli ?? 0n) / 1000, count: agg._count._all };
  },

  currencyDecimals: (tid) => tenantCurrencyDecimals(tid),

  async warehouseAsOf(tid, day) {
    // نسخة warehouseAsOf (routes/warehouse.ts) بدوالّها نفسها — لا يُستورد مسارٌ في خدمة
    if (!isLocalDate(day)) return undefined;
    const gl = await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true, timezone: true, setupDraft: true } });
    return importedEntryInstant(addDays(day, 1), importTimezone(gl));
  },

  warehouseStock: (tid, decimals, before) => computeWarehouseStock(tid, decimals, before),

  // GET /suppliers/aging: أعمار الذمم الدائنة حتى يومٍ (منتصف ليل UTC كما يقرؤه queryDay) — بشكل agingJson
  supplierAging: async (tid, asOfLocal) => agingJson(await loadAging(prisma, tid, toDbDate(asOfLocal))),

  async receivables(tid, topN) {
    // GET /reports/balances: كل عميلٍ غير محذوف (النشط والموقوف والمحظور)، و1e-6 حدّ غبار العائمة
    const base = { tenantId: tid, status: { not: 'DELETED' } };
    const [debit, credit, exceeded, top] = await Promise.all([
      prisma.customer.aggregate({ where: { ...base, balance: { gt: 1e-6 } }, _sum: { balance: true }, _count: { _all: true } }),
      prisma.customer.aggregate({ where: { ...base, balance: { lt: -1e-6 } }, _sum: { balance: true }, _count: { _all: true } }),
      // ?type=exceeded: حدٌّ ائتماني موجب ورصيدٌ فوقه — بمقارنة العمودين في القاعدة كـdashboard.ts
      prisma.customer.count({
        where: { ...base, creditLimit: { gt: 0 }, balance: { gt: prisma.customer.fields.creditLimit as never } },
      }).catch(() => 0),
      prisma.customer.findMany({
        where: { ...base, balance: { gt: 1e-6 } },
        select: { name: true, balance: true, creditLimit: true, paymentDays: true, status: true },
        orderBy: { balance: 'desc' },
        take: topN,
      }),
    ]);
    return {
      debit: { total: num(debit._sum.balance), count: debit._count._all },
      credit: { total: -num(credit._sum.balance), count: credit._count._all },
      exceededCount: exceeded,
      top: top.map((c) => ({ name: c.name, balance: num(c.balance), creditLimit: num(c.creditLimit), paymentDays: c.paymentDays ?? null, status: c.status })),
    };
  },

  async customerGroups(tid, gte, lt) {
    // groupBy=customer في GET /reports/sales بتجميعٍ في القاعدة: البيع موجب والمرتجع سالب، والعدد للبيع وحده
    const groups = await prisma.invoice.groupBy({
      by: ['customerId', 'type'],
      where: invoiceWhere(tid, gte, lt),
      _sum: { total: true },
      _count: { _all: true },
    });
    return groups.map((g) => ({ id: g.customerId, type: g.type, total: num(g._sum.total), count: g._count._all }));
  },

  async customerNames(tid, ids) {
    if (!ids.length) return new Map();
    const rows = await prisma.customer.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  async repGroups(tid, gte, lt) {
    // «أفضل المناديب» (dashboard.ts) بحدَّي الفترة: تجميعٌ بالمندوب والنوع لـrankTopReps
    const groups = await prisma.invoice.groupBy({
      by: ['salesRepId', 'type'],
      where: { ...invoiceWhere(tid, gte, lt), salesRepId: { not: null } },
      _sum: { total: true },
      _count: { _all: true },
    });
    return groups.map((g) => ({ salesRepId: g.salesRepId, type: g.type, _sum: { total: g._sum.total }, _count: { _all: g._count._all } }));
  },

  activeReps: (tid) => prisma.salesRep.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true } }),

  async saleItems(tid, gte, lt) {
    // بنود الفواتير المؤكَّدة في الفترة بلقطة وحدتها (salesInclude.items في GET /reports/sales) — والعزل بشرط الفاتورة
    const rows = await prisma.invoiceItem.findMany({
      where: { invoice: invoiceWhere(tid, gte, lt) },
      select: {
        qty: true, lineTotal: true, unitName: true, unitFactor: true, baseQty: true,
        product: { select: { id: true, name: true, code: true, unit: true, primaryUnitId: true } },
        invoice: { select: { type: true } },
      },
      take: SALE_ITEMS_CAP + 1,
    });
    if (rows.length > SALE_ITEMS_CAP) return null;
    const sales: SaleItemRow[] = [];
    const returns: SaleItemRow[] = [];
    for (const { invoice, ...item } of rows) (invoice.type === 'RETURN' ? returns : sales).push(item);
    return { sales, returns };
  },

  avgCosts: async (tid, decimals) => (await loadValuation(prisma, tid, decimals)).avgCost,
};
