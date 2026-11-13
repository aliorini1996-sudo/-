import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { scopedRecordWhere, adminCustomerFilter, adminRepFilter, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { cleanMoney, netSales, signedAmount } from '../services/netSales';
import { rankTopReps } from '../services/topReps';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canAccessDashboard'));

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86400000 - 1);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      dailySales, dailyReceipts, monthSales, monthReceipts,
      totalCustomers, overdueCustomers, creditExceeded,
      repMonthGroups, activeReps, topCustomers, recentInvoices,
      dailyReturns, monthReturns,
    ] = await (async () => {
    // قيود نطاق المستخدم تُحسب مرّة وتُطبَّق على كل استعلامات اللوحة
    const recScope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const custScope = await adminCustomerFilter(req);
    const repScope = await adminRepFilter(req);
    return Promise.all([
      prisma.invoice.aggregate({
        where: { tenantId: tid, ...recScope, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: startOfDay, lte: endOfDay } },
        _sum: { total: true }, _count: { id: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: tid, ...recScope, status: 'ACTIVE', receiptDate: { gte: startOfDay, lte: endOfDay } },
        _sum: { amount: true }, _count: { id: true },
      }),
      prisma.invoice.aggregate({
        where: { tenantId: tid, ...recScope, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: startOfMonth } },
        _sum: { total: true }, _count: { id: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: tid, ...recScope, status: 'ACTIVE', receiptDate: { gte: startOfMonth } },
        _sum: { amount: true }, _count: { id: true },
      }),
      prisma.customer.count({ where: { tenantId: tid, ...custScope, status: 'ACTIVE' } }),
      // «العملاء بأرصدة» و«تجاوز الحد الائتماني» بجمهور تقرير «أرصدة العملاء» نفسه (تدقيق دقّة التقارير، ١٣ نوفمبر ٢٠٢٦):
      // كل عميلٍ غير محذوف — الموقوف والمحظور مدينان حقيقيان، والحظر هو ما يوقف به المدير البيع لمتعثّر (invoices.ts)،
      // فإسقاطهما كان يُنقص العدّين عمّا في التقرير وكشف الحساب. و1e-6 حدّ التقرير نفسه: غبار العائمة التاريخي لا يُعدّ ديناً
      prisma.customer.count({ where: { tenantId: tid, ...custScope, status: { not: 'DELETED' }, balance: { gt: 1e-6 } } }),
      prisma.customer.count({
        where: { tenantId: tid, ...custScope, status: { not: 'DELETED' }, creditLimit: { gt: 0 }, balance: { gt: prisma.customer.fields.creditLimit as never } },
      }).catch(() => 0),
      // «أفضل المناديب» يُرتَّب قبل أن يُقصّ (services/topReps.ts): صافي الشهر لكل مندوب من تجميعٍ واحد بنطاق المستند
      // (recScope — مندوبٌ مشترك لا تُجمع لمشرف فريقٍ مبيعاتُ فريقه الآخر)، والمرتجع بنوعه ليُطرح (services/netSales.ts)
      prisma.invoice.groupBy({
        by: ['salesRepId', 'type'],
        where: { tenantId: tid, ...recScope, status: 'CONFIRMED', invoiceDate: { gte: startOfMonth }, salesRepId: { not: null } },
        _sum: { total: true }, _count: { _all: true },
      }),
      // والمرشّحون كل المناديب **النشطين** في نطاق المستخدم أو فريقه — لا خمسةٌ بلا ترتيب (take: 5 بلا orderBy كان يأخذ
      // أقدم الصفوف والموقوف معها فيغيب أعلى المناديب مبيعاً). صفوفٌ خفيفة (معرّف واسم) لا فواتير
      prisma.salesRep.findMany({ where: { tenantId: tid, ...repScope, isActive: true }, select: { id: true, name: true } }),
      prisma.customer.findMany({
        // المحذوف يسقط من «أفضل العملاء» كما سقط من قوائمهم
        where: { tenantId: tid, ...custScope, status: { not: 'DELETED' } },
        take: 5, orderBy: { totalSales: 'desc' },
        select: { id: true, name: true, totalSales: true, balance: true },
      }),
      prisma.invoice.findMany({
        where: { tenantId: tid, ...recScope, status: 'CONFIRMED', type: { not: 'RETURN' } },
        take: 10, orderBy: { createdAt: 'desc' },
        include: { customer: { select: { name: true } }, salesRep: { select: { name: true } } },
      }),
      // «إجمالي المبيعات» صافٍ (طلب المالك ٢٩ أكتوبر ٢٠٢٦): مرتجع اليوم والشهر في النطاق نفسه يُطرح من مبيعاتهما
      prisma.invoice.aggregate({
        where: { tenantId: tid, ...recScope, status: 'CONFIRMED', type: 'RETURN', invoiceDate: { gte: startOfDay, lte: endOfDay } },
        _sum: { total: true },
      }),
      prisma.invoice.aggregate({
        where: { tenantId: tid, ...recScope, status: 'CONFIRMED', type: 'RETURN', invoiceDate: { gte: startOfMonth } },
        _sum: { total: true },
      }),
    ]);
    })();

    // «النظام المحاسبي» مطفأ ⇒ لا تغادر أرقامُ المبيعات والتحصيل الخادمَ أصلاً.
    // الدلالة `!== false`: العَلَم افتراضه مفعّل، فغيابه يعني مفعّل لا مطفأ.
    const tenantFlag = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true, warehouseEnabled: true } });
    const accountingOn = tenantFlag?.accountingEnabled !== false;
    const warehouseOn = tenantFlag?.warehouseEnabled === true;

    // المشتريات الشهرية = قيمة الوارد إلى مخزون الشركة (WarehouseEntry type='RECEIVE'): Σ الكمية×سعر التكلفة.
    // تُحسب فقط حين تُفعَّل ميزة المستودع (وإلا لا معنى للبطاقة ولا داعي للاستعلام على قاعدة 0.1 نواة).
    // مبلغٌ على مستوى الشركة (المستودع مركزيّ لا يُنسَب لمندوب)، فلا يمرّ بنطاق السجلات.
    // الوحدات المتعددة: `qty` و`unitCost` كلاهما **بوحدة الصفّ** (كرتونان × سعر الكرتون، كفاتورة المورّد)،
    // فحاصل ضربهما قيمة السطر أيّاً كانت وحدته — لا `baseQty` هنا، وإلا ضُربت كمية الحبّات بسعر الكرتون.
    let monthPurchases = { purchasesTotal: 0, entriesCount: 0 };
    if (warehouseOn && accountingOn) {
      const rows = await prisma.$queryRaw<{ total: number | null; entries: number | bigint }[]>`
        SELECT COALESCE(SUM(i.qty * i."unitCost"), 0)::float8 AS total,
               COUNT(DISTINCT e.id) AS entries
        FROM "warehouse_entry_items" i
        JOIN "warehouse_entries" e ON e.id = i."entryId"
        WHERE e."tenantId" = ${tid} AND e.type = 'RECEIVE'
          AND e."createdAt" >= ${startOfMonth} AND i."unitCost" IS NOT NULL`;
      monthPurchases = { purchasesTotal: Number(rows[0]?.total ?? 0), entriesCount: Number(rows[0]?.entries ?? 0) };
    }

    // صافي مبيعات المندوب (البيع − مرتجعه)، وعدد فواتير البيع وحدها — أعلى خمسة من كل المرشّحين، ثم بالاسم عند التعادل
    const topRepsWithStats = rankTopReps(activeReps, repMonthGroups);

    res.json({
      success: true,
      data: {
        accountingEnabled: accountingOn,
        today: accountingOn
          ? {
            salesTotal: netSales(dailySales._sum.total, dailyReturns._sum.total),
            invoicesCount: dailySales._count.id,
            collectionsTotal: Number(dailyReceipts._sum.amount ?? 0),
            receiptsCount: dailyReceipts._count.id,
          }
          : { salesTotal: 0, invoicesCount: 0, collectionsTotal: 0, receiptsCount: 0 },
        warehouseEnabled: warehouseOn,
        month: accountingOn
          ? {
            salesTotal: netSales(monthSales._sum.total, monthReturns._sum.total),
            invoicesCount: monthSales._count.id,
            collectionsTotal: Number(monthReceipts._sum.amount ?? 0),
            receiptsCount: monthReceipts._count.id,
            // المشتريات الشهرية (مخزون الشركة) — 0 حين الميزة مطفأة، والواجهة تُظهر البطاقة بـwarehouseEnabled
            purchasesTotal: monthPurchases.purchasesTotal,
            purchaseEntriesCount: monthPurchases.entriesCount,
          }
          : { salesTotal: 0, invoicesCount: 0, collectionsTotal: 0, receiptsCount: 0, purchasesTotal: 0, purchaseEntriesCount: 0 },
        customers: { total: totalCustomers, withBalance: overdueCustomers, creditExceeded },
        topReps: accountingOn ? topRepsWithStats : [],
        topCustomers: accountingOn ? topCustomers : [],
        recentInvoices: accountingOn ? recentInvoices : [],
      },
    });
  } catch (err) { next(err); }
});

router.get('/sales-trend', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // منحنى المبيعات محجوب أيضاً عند إطفاء المحاسبة — وإلا بقي مصدرُ ريالاتٍ مفتوحاً
    const tf = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true } });
    if (tf?.accountingEnabled === false) { res.json({ success: true, data: [] }); return; }

    const days = parseInt(req.query.days as string) || 30;
    const from = new Date();
    from.setDate(from.getDate() - days);

    // صافي كل يوم: المرتجع يُطرح من يومه (services/netSales.ts)
    const invoices = await prisma.invoice.findMany({
      where: { tenantId: tid, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)), status: 'CONFIRMED', invoiceDate: { gte: from } },
      select: { invoiceDate: true, total: true, type: true },
      orderBy: { invoiceDate: 'asc' },
    });

    const byDate: Record<string, number> = {};
    invoices.forEach(inv => {
      const d = inv.invoiceDate.toISOString().slice(0, 10);
      byDate[d] = (byDate[d] ?? 0) + signedAmount(inv, inv.total);
    });

    res.json({ success: true, data: Object.entries(byDate).map(([date, total]) => ({ date, total: cleanMoney(total) })) });
  } catch (err) { next(err); }
});

export default router;
