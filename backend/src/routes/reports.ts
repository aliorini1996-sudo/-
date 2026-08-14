import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { scopedRecordWhere, scopedRepRecordWhere, adminCustomerFilter, adminRepFilter, SHAPE_INVOICE_RECEIPT, SHAPE_VISIT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { composeWorkDays } from '../services/workDay';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canViewReports'));

router.get('/sales', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to, salesRepId, customerId, groupBy } = req.query as Record<string, string>;
    /**
     * نطاق شامل ليوم «إلى» كاملاً (حتى منتصف ليلته) — يُصلح التصفية ليوم واحد وآخر يوم.
     *
     * **وسقفٌ افتراضيّ حين لا يُمرَّر مدى:** كان غيابُ المدى يعني سحب تاريخ
     * الشركة كاملاً ومعه بنودُ كل فاتورة ومنتجاتها في الذاكرة — وهو المسار
     * الذي تسلكه الصفحة عند أوّل فتح. على خطّة بذاكرة محدودة ينفجر ذلك مع
     * نموّ الشركة، والخادم يسقط للجميع لا لطالب التقرير وحده.
     * فإن لم يُحدَّد مدى نقصره على آخر ٩٠ يوماً ونُعلمه في الاستجابة.
     */
    const DEFAULT_DAYS = 90;
    // طرفٌ واحد يكفي: كان الشرط `from && to` يُسقط «من ١ يناير» بلا «إلى» **بصمت**،
    // فيرى المستخدم كلّ السجلّ وهو يقرأ فلتراً مطبَّقاً على الشاشة. الطرف الغائب
    // يعني «بلا حدّ من تلك الجهة» لا «ألغِ الفلتر».
    const rangeApplied = !!(from || to);
    const dateFilter = rangeApplied
      ? {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : {}),
        }
      : { gte: new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000) };

    const invoices = await prisma.invoice.findMany({
      where: {
        tenantId: tid,
        // نطاق المستخدم: لا تدخل التقرير فاتورةٌ لعميل أو مندوب خارج نطاقه
        ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)),
        status: 'CONFIRMED',
        type: { not: 'RETURN' }, // تقرير المبيعات لا يشمل المرتجعات
        invoiceDate: dateFilter,
        ...(salesRepId && { salesRepId }),
        ...(customerId && { customerId }),
      },
      include: {
        customer: { select: { id: true, name: true, channel: true, city: true } },
        salesRep: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, code: true } } } },
      },
      orderBy: { invoiceDate: 'asc' },
    });

    if (groupBy === 'product') {
      const byProduct: Record<string, { name: string; code: string; qty: number; total: number }> = {};
      invoices.forEach(inv => {
        inv.items.forEach(item => {
          const key = item.product.id;
          if (!byProduct[key]) byProduct[key] = { name: item.product.name, code: item.product.code, qty: 0, total: 0 };
          byProduct[key].qty += Number(item.qty);
          byProduct[key].total += Number(item.lineTotal);
        });
      });
      res.json({ success: true, data: Object.values(byProduct).sort((a, b) => b.total - a.total) });
      return;
    }

    if (groupBy === 'rep') {
      const byRep: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        // `Invoice.salesRepId` قابل للفراغ: حذفُ مندوب يُفرّغه من كل فواتيره
        // (salesReps.ts: updateMany → salesRepId: null) حفظاً للسجلّ المالي.
        // فقراءة `inv.salesRep.id` مباشرةً كانت **تُسقط التقرير بـ500** لأي
        // شركة حذفت مندوباً يوماً. مبيعاته تبقى محسوبة تحت مجموعة صريحة.
        const key = inv.salesRep?.id ?? '—';
        if (!byRep[key]) byRep[key] = { name: inv.salesRep?.name ?? 'بلا مندوب', count: 0, total: 0 };
        byRep[key].count++;
        byRep[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byRep).sort((a, b) => b.total - a.total) });
      return;
    }

    if (groupBy === 'customer') {
      const byCustomer: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.customer.id;
        if (!byCustomer[key]) byCustomer[key] = { name: inv.customer.name, count: 0, total: 0 };
        byCustomer[key].count++;
        byCustomer[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byCustomer).sort((a, b) => b.total - a.total) });
      return;
    }

    // تجميع حسب قناة البيع (تصنيف مؤسسي) — العملاء بلا قناة يُجمَّعون تحت "غير محدّد"
    if (groupBy === 'channel') {
      const byChannel: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.customer.channel || 'UNSET';
        if (!byChannel[key]) byChannel[key] = { name: key, count: 0, total: 0 };
        byChannel[key].count++;
        byChannel[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byChannel).sort((a, b) => b.total - a.total) });
      return;
    }

    // تجميع حسب المنطقة الجغرافية (المدينة)
    if (groupBy === 'region') {
      const byRegion: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.customer.city || '—';
        if (!byRegion[key]) byRegion[key] = { name: key, count: 0, total: 0 };
        byRegion[key].count++;
        byRegion[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byRegion).sort((a, b) => b.total - a.total) });
      return;
    }

    const summary = {
      total: invoices.reduce((s, i) => s + Number(i.total), 0),
      count: invoices.length,
      taxTotal: invoices.reduce((s, i) => s + Number(i.taxAmt), 0),
      discountTotal: invoices.reduce((s, i) => s + Number(i.discountAmt), 0),
      // نُعلن السقف صراحةً: تقريرٌ مقصوصٌ صامتاً يُقرأ على أنه شامل، فتُبنى
      // عليه قرارات ناقصة. الواجهة تعرض التنبيه ويرفعه المستخدم بتحديد مدى.
      ...(rangeApplied ? {} : { defaultRangeDays: DEFAULT_DAYS }),
    };
    res.json({ success: true, data: { invoices, summary } });
  } catch (err) { next(err); }
});

router.get('/collections', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to, salesRepId, paymentMethod } = req.query as Record<string, string>;
    // نطاق شامل ليوم «إلى» كاملاً (حتى منتصف ليلته) — يُصلح التصفية ليوم واحد وآخر يوم
    // طرفٌ واحد يكفي (راجع تقرير المبيعات): الغائب = بلا حدّ، لا إلغاءَ للفلتر
    const dateFilter = (from || to) ? {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : {}),
    } : undefined;

    const receipts = await prisma.receipt.findMany({
      where: {
        tenantId: tid,
        ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)),
        status: 'ACTIVE',
        ...(dateFilter && { receiptDate: dateFilter }),
        ...(salesRepId && { salesRepId }),
        ...(paymentMethod && { paymentMethod: paymentMethod as 'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE' }),
      },
      include: {
        customer: { select: { id: true, name: true } },
        salesRep: { select: { id: true, name: true } },
      },
      orderBy: { receiptDate: 'asc' },
    });

    const summary = {
      total: receipts.reduce((s, r) => s + Number(r.amount), 0),
      count: receipts.length,
      byMethod: receipts.reduce((acc, r) => {
        acc[r.paymentMethod] = (acc[r.paymentMethod] ?? 0) + Number(r.amount);
        return acc;
      }, {} as Record<string, number>),
    };

    res.json({ success: true, data: { receipts, summary } });
  } catch (err) { next(err); }
});

router.get('/balances', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { type } = req.query as Record<string, string>;

    let where = {};
    if (type === 'overdue') where = { balance: { gt: 0 } };
    if (type === 'exceeded') where = { creditLimit: { gt: 0 } };

    const customers = await prisma.customer.findMany({
      where: { tenantId: tid, status: 'ACTIVE', ...(await adminCustomerFilter(req)), ...where },
      select: { id: true, name: true, phone: true, balance: true, creditLimit: true, paymentDays: true, totalSales: true, totalCollected: true },
      orderBy: { balance: 'desc' },
    });

    const result = type === 'exceeded'
      ? customers.filter(c => Number(c.balance) > Number(c.creditLimit))
      : customers;

    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/rep-performance', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query as Record<string, string>;
    // نطاق شامل ليوم «إلى» كاملاً (حتى منتصف ليلته) — يُصلح التصفية ليوم واحد وآخر يوم
    const dateFilter = from && to ? { gte: new Date(from), lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : undefined;

    // نطاق زمني للحضور والزيارات (بداية اليوم من → نهاية اليوم إلى)
    const fromDate = from ? new Date(from) : new Date(0);
    const toEnd = to ? new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) : new Date();

    const [reps, sessions, visitCounts, visitRows] = await Promise.all([
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true, ...(await adminRepFilter(req)) },
        select: {
          id: true, name: true,
          invoices: {
            where: { status: 'CONFIRMED', type: { not: 'RETURN' }, ...(dateFilter && { invoiceDate: dateFilter }) },
            select: { total: true, discountAmt: true, type: true },
          },
          receipts: {
            where: { status: 'ACTIVE', ...(dateFilter && { receiptDate: dateFilter }) },
            select: { amount: true },
          },
        },
      }),
      // ساعات العمل من جلسات الحضور
      prisma.repSession.findMany({
        where: { tenantId: tid, startedAt: { gte: fromDate, lt: toEnd }, ...(await scopedRepRecordWhere(req)) },
        select: { salesRepId: true, startedAt: true, lastBeatAt: true },
      }),
      // عدد الزيارات لكل مندوب (دقيق)
      prisma.repVisit.groupBy({
        by: ['salesRepId'],
        where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd }, ...(await scopedRecordWhere(req, SHAPE_VISIT)) },
        _count: { _all: true },
      }),
      // زيارات لها إحداثيات — لبناء روابط المواقع
      prisma.repVisit.findMany({
        where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd }, lat: { not: null }, lng: { not: null }, ...(await scopedRecordWhere(req, SHAPE_VISIT)) },
        select: { salesRepId: true, createdAt: true, lat: true, lng: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'asc' }, take: 5000,
      }),
    ]);

    const minutesByRep = new Map<string, number>();
    for (const s of sessions) {
      minutesByRep.set(s.salesRepId, (minutesByRep.get(s.salesRepId) || 0) + Math.max(0, (s.lastBeatAt.getTime() - s.startedAt.getTime()) / 60000));
    }
    const countByRep = new Map<string, number>();
    for (const c of visitCounts) countByRep.set(c.salesRepId, c._count._all);
    const visitsByRep = new Map<string, { customerName: string; createdAt: Date; lat: number; lng: number; mapsUrl: string }[]>();
    for (const v of visitRows) {
      const arr = visitsByRep.get(v.salesRepId) || [];
      if (arr.length < 300) { // سقف معقول لروابط كل مندوب
        arr.push({
          customerName: v.customer?.name || '', createdAt: v.createdAt, lat: v.lat!, lng: v.lng!,
          mapsUrl: `https://www.google.com/maps?q=${v.lat},${v.lng}`,
        });
        visitsByRep.set(v.salesRepId, arr);
      }
    }

    const data = reps.map(r => {
      const salesTotal = r.invoices.reduce((s, i) => s + Number(i.total), 0);
      const collectionsTotal = r.receipts.reduce((s, rc) => s + Number(rc.amount), 0);
      const discountTotal = r.invoices.reduce((s, i) => s + Number(i.discountAmt), 0);
      const workMinutes = Math.round(minutesByRep.get(r.id) || 0);
      return {
        id: r.id,
        name: r.name,
        invoicesCount: r.invoices.length,
        salesTotal,
        collectionsTotal,
        discountTotal,
        collectionRate: salesTotal > 0 ? Math.round((collectionsTotal / salesTotal) * 100) : 0,
        avgInvoice: r.invoices.length > 0 ? Math.round(salesTotal / r.invoices.length) : 0,
        workMinutes,
        workHours: Math.floor(workMinutes / 60),
        workMins: workMinutes % 60,
        visitsCount: countByRep.get(r.id) || 0,
        visits: visitsByRep.get(r.id) || [],
      };
    }).sort((a, b) => b.salesTotal - a.salesTotal);

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// تقرير زيارات العملاء — كل الزيارات في تقرير واحد: العميل، المندوب الزائر، الوقت، والموقع
router.get('/customer-visits', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ? new Date(from) : new Date(0);
    const toEnd = to ? new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) : new Date();
    const visits = await prisma.repVisit.findMany({
      where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd }, ...(await scopedRecordWhere(req, SHAPE_VISIT)) },
      select: {
        id: true, createdAt: true, note: true, lat: true, lng: true,
        customer: { select: { name: true } },
        salesRep: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 3000,
    });
    const rows = visits.map(v => ({
      id: v.id,
      customerName: v.customer?.name || '',
      repName: v.salesRep?.name || '',
      createdAt: v.createdAt,
      note: v.note || '',
      mapsUrl: v.lat != null && v.lng != null ? `https://www.google.com/maps?q=${v.lat},${v.lng}` : '',
    }));
    res.json({ success: true, data: { count: rows.length, visits: rows } });
  } catch (err) { next(err); }
});

// تقرير مديونيات المندوب — رصيد كل عميل مُسنَد لكل مندوب، ليقرأ المشرف تقصير
// التحصيل لدى كل عميل ويُصدّره ملفاً.
//
// الرصيد **لحظيّ** (لا يتأثر بفلتر التاريخ) ويُحسب Σمدين − Σدائن من قيود
// الحساب — التعريف الواحد المعتمد في المنظومة كلّها (`accounting.ts`)، لا لقطة
// `customer.balance` المخزّنة. و«آخر تحصيل» من أحدث قيد RECEIPT_CREDIT: عميلٌ
// برصيدٍ وبلا تحصيلٍ حديث هو عينُ التقصير الذي يبحث عنه المشرف.
//
// قاعدة AND لا OR: المستخدم المنطاق يرى تقاطع مناديبه وعملائه — إسنادُ عميلٍ
// خارج نطاقه لمندوبٍ داخله لا يكشف العميل، والعكس بالعكس.
router.get('/rep-receivables', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);

    const [reps, assignments, sums, lastPays] = await Promise.all([
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true, ...(await adminRepFilter(req)) },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.customerAssignment.findMany({
        where: { tenantId: tid, customer: { ...(await adminCustomerFilter(req)) } },
        select: {
          salesRepId: true,
          customer: { select: { id: true, name: true, businessName: true, phone: true, city: true } },
        },
      }),
      // مجموعا كل عملاء الشركة دفعةً واحدة — أرخص من IN بآلاف المعرّفات
      prisma.accountEntry.groupBy({
        by: ['customerId'],
        where: { tenantId: tid },
        _sum: { debit: true, credit: true },
      }),
      prisma.accountEntry.groupBy({
        by: ['customerId'],
        where: { tenantId: tid, type: 'RECEIPT_CREDIT' },
        _max: { entryDate: true },
      }),
    ]);

    const clean = (n: number) => Math.round(n * 1e6) / 1e6;
    const balanceOf = new Map(sums.map(s => [s.customerId, clean(Number(s._sum.debit ?? 0) - Number(s._sum.credit ?? 0))]));
    const lastPayOf = new Map(lastPays.map(p => [p.customerId, p._max.entryDate]));

    type RecvCustomer = { id: string; name: string; businessName: string | null; phone: string; city: string | null; balance: number; lastPaymentAt: Date | null };
    const byRep = new Map<string, RecvCustomer[]>();
    for (const a of assignments) {
      const arr = byRep.get(a.salesRepId) || [];
      arr.push({
        ...a.customer,
        balance: balanceOf.get(a.customer.id) ?? 0,
        lastPaymentAt: lastPayOf.get(a.customer.id) ?? null,
      });
      byRep.set(a.salesRepId, arr);
    }

    // المناديب المنطاقون وحدهم يظهرون (إسنادٌ لمندوبٍ خارج النطاق يسقط هنا).
    // ومن بلا عملاء مُسنَدين يظهر بصفّ صفريّ — غيابُ الإسناد معلومةٌ للمشرف لا فراغ.
    const data = reps.map(r => {
      const customers = (byRep.get(r.id) || []).sort((a, b) => b.balance - a.balance);
      return {
        id: r.id,
        name: r.name,
        customersCount: customers.length,
        debtorsCount: customers.filter(c => c.balance > 0).length,
        totalBalance: clean(customers.reduce((s, c) => s + c.balance, 0)),
        customers,
      };
    }).sort((a, b) => b.totalBalance - a.totalBalance);

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// تقرير ساعات العمل — إجمالي الوقت الذي كان فيه كل مندوب متصلاً وفاتحاً التطبيق
// (من جلسات الحضور RepSession)، مع عدد الجلسات وأول/آخر ظهور.
router.get('/work-hours', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query as Record<string, string>;
    // إزاحة توقيت المتصفّح بالدقائق شرقي UTC (الرياض 180) — «اليوم» يوم المندوب لا الخادم
    const tzOffsetMin = Math.max(-840, Math.min(840, parseInt(req.query.tz as string) || 0));

    // بلا مدى: أسبوع افتراضي. وسقف ٣١ يوماً: التفصيل اليومي بنقاط GPS على مدى
    // مفتوح يعني تجميع ملايين الصفوف في طلب واحد — نقصّ ونُعلن القصّ في الاستجابة.
    const MAX_DAYS = 31;
    const toEnd = to ? new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) : new Date();
    let fromDate = from ? new Date(from) : new Date(toEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    let rangeClamped = false;
    if (toEnd.getTime() - fromDate.getTime() > MAX_DAYS * 24 * 60 * 60 * 1000) {
      fromDate = new Date(toEnd.getTime() - MAX_DAYS * 24 * 60 * 60 * 1000);
      rangeClamped = true;
    }

    const repWhere = { tenantId: tid, isActive: true, ...(await adminRepFilter(req)) };
    const [reps, sessions, visits, pingRows] = await Promise.all([
      prisma.salesRep.findMany({ where: repWhere, select: { id: true, name: true } }),
      prisma.repSession.findMany({
        where: { tenantId: tid, startedAt: { gte: fromDate, lt: toEnd }, ...(await scopedRepRecordWhere(req)) },
        select: { salesRepId: true, startedAt: true, lastBeatAt: true },
      }),
      prisma.repVisit.findMany({
        where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd }, ...(await scopedRecordWhere(req, SHAPE_VISIT)) },
        select: { salesRepId: true, createdAt: true, startedAt: true, durationSec: true, customer: { select: { name: true } } },
        orderBy: { createdAt: 'asc' }, take: 10000,
      }),
      // نقاط GPS تُختزل في القاعدة إلى (مندوب × يوم محلي → أول/آخر التقاط):
      // الصفوف الخام قد تبلغ الملايين، والمطلوب منها طرفا اليوم لا مسارُه.
      // ⚠️ لا make_interval هنا: Prisma يمرّر الرقم bigint وPostgres لا يملك
      // make_interval(mins => bigint) فسقط المسار بـ42883 على الإنتاج فور نشره.
      // ضربُ interval ثابت بالمعامل يقبل bigint بالتحويل الضمني ويؤدّي المعنى نفسه.
      prisma.$queryRaw<{ salesRepId: string; day: string; min: Date; max: Date }[]>`
        SELECT "salesRepId",
               to_char(("capturedAt" + ${tzOffsetMin} * interval '1 minute')::date, 'YYYY-MM-DD') AS "day",
               MIN("capturedAt") AS "min", MAX("capturedAt") AS "max"
        FROM "rep_locations"
        WHERE "tenantId" = ${tid} AND "capturedAt" >= ${fromDate} AND "capturedAt" < ${toEnd}
        GROUP BY 1, 2`,
    ]);

    const byRep = <T extends { salesRepId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) { const a = m.get(r.salesRepId) || []; a.push(r); m.set(r.salesRepId, a); }
      return m;
    };
    const sessByRep = byRep(sessions);
    const visitsByRep = byRep(visits);
    const pingsByRep = byRep(pingRows);

    const data = reps.map(r => {
      const days = composeWorkDays({
        sessions: (sessByRep.get(r.id) || []).map(s => ({ start: s.startedAt, end: s.lastBeatAt })),
        pingRanges: (pingsByRep.get(r.id) || []).map(p => ({ day: p.day, min: p.min, max: p.max })),
        visits: (visitsByRep.get(r.id) || []).map(v => ({
          customerName: v.customer?.name || '—',
          at: v.startedAt || v.createdAt,   // بداية المؤقّت أدقّ؛ زيارة الملاحظة بوقت تسجيلها
          durationSec: v.durationSec,
        })),
        tzOffsetMin,
        // مدى الأيام المحلّية: يُملأ الغائب منها بصفوفٍ فارغة كي يظهر الغياب
        range: {
          from: new Date(fromDate.getTime() + tzOffsetMin * 60000).toISOString().slice(0, 10),
          to: new Date(toEnd.getTime() - 1 + tzOffsetMin * 60000).toISOString().slice(0, 10),
        },
      });

      // الحقول القديمة تبقى كما كانت (نشاط التطبيق) — الواجهة المنشورة تقرؤها
      // أثناء انزلاق النشر، والمقياس الجديد يُضاف جوارها لا مكانها.
      const appTotal = days.reduce((s, d) => s + d.appMinutes, 0);
      const fieldTotal = days.reduce((s, d) => s + d.spanMinutes, 0);
      const workedDays = days.filter((d) => !d.absent).length;
      const absentDays = days.filter((d) => d.absent).length;
      const visitsTotal = days.reduce((s, d) => s + d.visitsCount, 0);
      const sess = sessByRep.get(r.id) || [];
      return {
        id: r.id, name: r.name,
        totalMinutes: appTotal,
        hours: Math.floor(appTotal / 60), minutes: appTotal % 60,
        sessions: sess.length,
        firstSeen: days.length ? days[0].firstActivity : null,
        lastSeen: days.length ? days[days.length - 1].lastActivity : null,
        fieldMinutesTotal: fieldTotal,
        workedDays, absentDays, visitsTotal,
        // متوسط اليوم يُقسَم على أيام **العمل** لا أيام المدى: القسمة على المدى
        // تخلط الغياب بالبطء فتُظهر مجتهداً غاب يومين كأنه متقاعس.
        avgDayMinutes: workedDays ? Math.round(fieldTotal / workedDays) : 0,
        days,
      };
    }).sort((a, b) => b.fieldMinutesTotal - a.fieldMinutesTotal);

    res.json({ success: true, data, meta: { tzOffsetMin, ...(rangeClamped ? { rangeClamped: MAX_DAYS } : {}) } });
  } catch (err) { next(err); }
});

export default router;
