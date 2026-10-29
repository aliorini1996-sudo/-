import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requirePaymentMethods, tenantId } from '../middleware/auth';
import { scopedRecordWhere, scopedRepRecordWhere, adminCustomerFilter, adminRepFilter, SHAPE_INVOICE_RECEIPT, SHAPE_VISIT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { composeWorkDays, attendanceByDay, overlayAttendance, mergeVisitsByRep, asVisitLike } from '../services/workDay';
import { FINANCIAL_METRICS, RANKING_METRICS, rankRows, trackedMeters, type RankingMetric } from '../services/repRanking';
import { TEAM_NAME_SELECT, reportTeamOf, teamDocWhere, teamRepOrDocsWhere, teamRepWhere } from '../services/teams';
import { isDamagedVanReturn } from '../services/vanDamaged';
import { tenantTz } from '../services/invoiceExpiry';
import { COLLECTED_CASH_SALE, COLLECTED_RECEIPT, buildPaymentMethodsReport, paymentMethodsRange, rosterOf, summarizeCollectionsByMethod, type RepInfo } from '../services/paymentMethodsReport';
import { CUSTOM_METHOD_KEY_RE, readPaymentMethodsConfig } from '../services/paymentMethodsCore';
import { baseQtyOf, factorOf, roundQty, type UnitSnapshot } from '../services/units';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canViewReports'));

/** وحدة بيعٍ أكبر من الأساس كما يحتاجها العارض لـformatQty («٢ كرتون و٣ حبة») — النشطة وحدها. */
export interface ReportUnit { name: string; factor: number }

/** وحدات الصنف النشطة للعرض، من الأكبر — `select` واحد لكل مسار يعيد كميةً بالأساس. */
const ACTIVE_UNITS_SELECT = { where: { isActive: true }, select: { name: true, factor: true }, orderBy: { factor: 'desc' as const } };

/** وحدات أصنافٍ بعينها دفعةً واحدة (صنف ← وحداته النشطة من الأكبر) — للتجميعات التي لا تمرّ بصفّ الصنف. */
async function activeUnitsByProduct(tid: string, productIds: string[]): Promise<Map<string, ReportUnit[]>> {
  const out = new Map<string, ReportUnit[]>();
  if (!productIds.length) return out;
  const rows = await prisma.productUnit.findMany({
    where: { tenantId: tid, productId: { in: productIds }, isActive: true },
    select: { productId: true, name: true, factor: true },
    orderBy: { factor: 'desc' },
  });
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push({ name: r.name, factor: Number(r.factor) });
    out.set(r.productId, list);
  }
  return out;
}

type SalesItemRow = { qty: number; lineTotal: number; product: { id: string; name: string; code: string; unit: string } | null } & UnitSnapshot & { baseQty?: number | null };

/**
 * المبيعات حسب الصنف — الكمية **بالأساس**.
 *
 * كان يجمع `qty` خاماً، فكرتونان وثلاث حبّات من الصنف نفسه تُقرأ «٥». والجمع بالأساس
 * يعطي ٥١ حبّة، ويعرضها العارض «٢ كرتون و٣ حبة» من `units`. و`qty` يبقى في الردّ
 * بالمعنى نفسه (`baseQty`) لأنّ مستهلكي المفاتيح يقرؤونه: لصنفٍ بلا وحدات — كلّ ما
 * قبل الميزة — الأساس هو الخام نفسه فلا يتغيّر رقمٌ عندهم، ولصنفٍ بوحدات كان الخام
 * رقماً بلا معنى أصلاً. و`total` مجموع `lineTotal` كما كان: المال لا يتأثّر بالوحدة.
 */
export function salesByProduct(
  invoices: ReadonlyArray<{ items: ReadonlyArray<SalesItemRow> }>,
  unitsOf: ReadonlyMap<string, ReportUnit[]> = new Map(),
): Array<{ productId: string | null; name: string; code: string; qty: number; baseQty: number; unit: string; units: ReportUnit[]; total: number }> {
  const byProduct: Record<string, { productId: string | null; name: string; code: string; unit: string; base: number; total: number }> = {};
  invoices.forEach(inv => {
    inv.items.forEach(item => {
      // بندٌ بلا منتج يُجمَع تحت مفتاح واحد بدل أن يُسقِط التقرير —
      // الرقم الناقص أهون من صفحة لا تفتح.
      const ref = item.product;
      const key = ref?.id ?? 'unknown';
      if (!byProduct[key]) byProduct[key] = { productId: ref?.id ?? null, name: ref?.name ?? 'صنف محذوف', code: ref?.code ?? '—', unit: ref?.unit ?? '', base: 0, total: 0 };
      byProduct[key].base += baseQtyOf(item);
      byProduct[key].total += Number(item.lineTotal);
    });
  });
  return Object.values(byProduct)
    .map(p => {
      const base = roundQty(p.base);
      return { productId: p.productId, name: p.name, code: p.code, qty: base, baseQty: base, unit: p.unit, units: (p.productId && unitsOf.get(p.productId)) || [], total: p.total };
    })
    .sort((a, b) => b.total - a.total);
}

/**
 * بند تقرير المرتجع: كميته **بوحدته هو** (لقطة البند) لا بوحدة الصنف اليوم.
 *
 * كان يأخذ الوحدة من `product.unit` الحاليّ، فتغيير اسم وحدة الصنف يغيّر تقارير الماضي،
 * وحبّةٌ أُرجعت من بند كرتون تظهر «١ كرتون». فالوحدة = لقطة البند، وإلّا وحدة الصنف
 * (بندٌ سبق الميزة كُتب بها)، ومعها الكمية بالأساس ووحدة الأساس لمن يجمع أو يقارن.
 */
export function returnLineView(i: {
  qty: number; lineTotal: number; returnExpired: boolean | null; expiresAt: Date | null; itemName: string | null;
  baseQty?: number | null; product: { name: string; unit: string } | null;
} & UnitSnapshot) {
  return {
    name: i.product?.name ?? i.itemName ?? 'صنف محذوف',
    unit: i.unitName || i.product?.unit || '',
    qty: Number(i.qty),
    unitFactor: factorOf(i),
    baseQty: baseQtyOf(i),
    baseUnit: i.product?.unit ?? '',
    lineTotal: Number(i.lineTotal),
    returnExpired: i.returnExpired,
    expiresAt: i.expiresAt ? i.expiresAt.toISOString().slice(0, 10) : null,
  };
}

/** معيار «الصنف» في تقييم الأداء: الكمية المباعة لكل مندوب **بالأساس** — الترتيب قد يُبنى عليه حافز، فلا يُقارن كرتونٌ بحبّة. */
export function productQtyByRep(rows: ReadonlyArray<{ qty: number; baseQty?: number | null; invoice: { salesRepId: string | null } } & UnitSnapshot>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const rep = r.invoice.salesRepId;
    if (rep) out.set(rep, (out.get(rep) ?? 0) + baseQtyOf(r));
  }
  return out;
}

router.get('/sales', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to, salesRepId, customerId, groupBy } = req.query as Record<string, string>;
    const team = reportTeamOf(req.query.teamId); // «الفرق»: فلتر الفريق (بوسم المستند)
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
        ...teamDocWhere(team),
      },
      include: {
        customer: { select: { id: true, name: true, channel: true, city: true } },
        salesRep: { select: { id: true, name: true } },
        team: TEAM_NAME_SELECT,
        items: {
          // البند كاملاً ومعه لقطة وحدته (unitName/unitFactor/baseQty) — ووحدة الصنف لبندٍ سبق الميزة بلا لقطة
          include: { product: { select: { id: true, name: true, code: true, unit: true } } },
        },
      },
      orderBy: { invoiceDate: 'asc' },
    });

    if (groupBy === 'product') {
      const ids = [...new Set(invoices.flatMap(inv => inv.items.map(i => i.product?.id).filter((x): x is string => !!x)))];
      res.json({ success: true, data: salesByProduct(invoices, await activeUnitsByProduct(tid, ids)) });
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

    // «الفرق»: التجميع حسب الفريق — بوسم الفاتورة، ودلو «بلا فريق» للقديمة (قبل التفعيل) ولمن لم يُحسم فريقه
    if (groupBy === 'team') {
      const byTeam: Record<string, { name: string; count: number; total: number }> = {};
      invoices.forEach(inv => {
        const key = inv.team?.id ?? '__none';
        if (!byTeam[key]) byTeam[key] = { name: inv.team?.name ?? '', count: 0, total: 0 };
        byTeam[key].count++;
        byTeam[key].total += Number(inv.total);
      });
      res.json({ success: true, data: Object.values(byTeam).sort((a, b) => b.total - a.total) });
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

/**
 * تقرير الطلبات — الفواتير التي **حُدّد لها تاريخ تسليم** وحدها.
 *
 * والمدى يُطبَّق على `deliveryDate` لا على `invoiceDate`: سؤال المشرف هنا «ما
 * الذي عليّ تسليمه بين هذين التاريخين»، لا «أيّ فواتيرَ أصدرتُ فيهما». وفاتورةٌ
 * أُصدرت اليوم لتسليم الشهر القادم تخصّ الشهر القادم.
 *
 * والملغاة تسقط: طلبٌ أُلغي ليس عملاً معلّقاً على أحد.
 */
router.get('/orders', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query as Record<string, string>;
    // كتقرير المبيعات: الطرف الغائب بلا حدّ، وغيابهما معاً يُقصَر على مدىً افتراضيّ
    const DEFAULT_DAYS = 90;
    const rangeApplied = !!(from || to);
    const deliveryFilter = rangeApplied
      ? {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : {}),
      }
      : { gte: new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000) };

    const orders = await prisma.invoice.findMany({
      where: {
        tenantId: tid,
        ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)),
        status: { not: 'CANCELLED' },
        // الشرط الذي يصنع التقرير: تاريخ تسليمٍ محدَّد
        deliveryDate: { not: null, ...deliveryFilter },
        ...teamDocWhere(reportTeamOf(req.query.teamId)),
      },
      select: {
        id: true, number: true, invoiceDate: true, deliveryDate: true,
        total: true, paidAmt: true, status: true, team: TEAM_NAME_SELECT,
        customer: { select: { id: true, name: true, phone: true, city: true } },
        salesRep: { select: { id: true, name: true } },
      },
      orderBy: { deliveryDate: 'asc' },   // الأقرب تسليماً أوّلاً — ترتيب العمل لا ترتيب الإصدار
      take: 5000,
    });

    res.json({
      success: true,
      data: {
        orders,
        summary: {
          count: orders.length,
          total: orders.reduce((s, o) => s + Number(o.total || 0), 0),
          paid: orders.reduce((s, o) => s + Number(o.paidAmt || 0), 0),
        },
        rangeApplied,
        defaultDays: rangeApplied ? null : DEFAULT_DAYS,
      },
    });
  } catch (err) { next(err); }
});

/**
 * تقرير المرتجع (طلب المالك ١٣ أكتوبر ٢٠٢٦) — مستندات الإرجاع المؤكَّدة في المدى، ومنها الإشعارات الدائنة (المرحلة الثانية).
 * لكلّ مرتجع: عميله ومندوبه وسببه وهل عاد للمخزون، وفاتورة البيع التي أُرجع منها إن رُبط بها (الإشعار الدائن بأصله،
 * والمرتجع من فاتورة بيع ببنوده returnOfItemId)، وبنوده بحالة صلاحيتها. والملخّص: العدد والقيمة وتوزيعها على السبب،
 * ونسبة المرتجع من مبيعات المدى نفسه في النطاق نفسه. المدى كتقرير المبيعات: الطرف الغائب بلا حدّ، وغيابهما ٩٠ يوماً.
 */
router.get('/returns', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query as Record<string, string>;
    const DEFAULT_DAYS = 90;
    const rangeApplied = !!(from || to);
    const dateFilter = rangeApplied
      ? {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : {}),
      }
      : { gte: new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000) };
    // «الفرق»: الفريق جزءٌ من النطاق نفسه — فيطبَّق على المرتجعات وعلى مبيعات النسبة معاً
    const scope = { ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)), ...teamDocWhere(reportTeamOf(req.query.teamId)) };

    const [returns, sales] = await Promise.all([
      prisma.invoice.findMany({
        where: { tenantId: tid, ...scope, status: 'CONFIRMED', type: 'RETURN', invoiceDate: dateFilter },
        select: {
          id: true, number: true, invoiceDate: true, total: true, taxAmt: true,
          returnReason: true, returnToStock: true, documentKind: true, notes: true, createdAt: true, team: TEAM_NAME_SELECT,
          originalInvoice: { select: { number: true } },
          customer: { select: { id: true, name: true, phone: true, city: true } },
          salesRep: { select: { id: true, name: true } },
          items: {
            select: {
              qty: true, lineTotal: true, returnExpired: true, expiresAt: true, returnOfItemId: true, itemName: true,
              unitName: true, unitFactor: true, baseQty: true,
              product: { select: { name: true, unit: true } },
            },
          },
        },
        orderBy: { invoiceDate: 'desc' },
        take: 5000,
      }),
      // نسبة المرتجع: مبيعات المدى نفسه في النطاق نفسه (تعريف تقرير المبيعات)
      prisma.invoice.aggregate({
        where: { tenantId: tid, ...scope, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: dateFilter },
        _sum: { total: true },
      }),
    ]);

    // فاتورة البيع للمرتجع المرتبط في المرحلة الأولى: من بنوده (returnOfItemId) — استعلامٌ واحد لكل المرتجعات
    const saleItemIds = [...new Set(returns.flatMap((r) => r.items.map((i) => i.returnOfItemId).filter((x): x is string => !!x)))];
    const saleNumberOf = new Map<string, string>();
    if (saleItemIds.length) {
      const saleItems = await prisma.invoiceItem.findMany({
        where: { id: { in: saleItemIds }, invoice: { tenantId: tid } },
        select: { id: true, invoice: { select: { number: true } } },
      });
      for (const it of saleItems) saleNumberOf.set(it.id, it.invoice.number);
    }

    const rows = returns.map((r) => {
      const linked = [...new Set(r.items.map((i) => (i.returnOfItemId ? saleNumberOf.get(i.returnOfItemId) : undefined)).filter((x): x is string => !!x))];
      return {
        id: r.id, number: r.number, invoiceDate: r.invoiceDate,
        total: Number(r.total), taxAmt: Number(r.taxAmt),
        reason: r.returnReason ?? 'NORMAL', returnToStock: r.returnToStock, creditNote: r.documentKind === 'CREDIT_NOTE',
        // التالف منذ ١٥ أكتوبر ٢٠٢٦ يدخل رصيد «المرتجع التالف» في السيارة (لا يُباع) مهما كانت returnToStock
        toDamagedStock: isDamagedVanReturn(r),
        notes: r.notes,
        saleInvoices: r.originalInvoice ? [r.originalInvoice.number] : linked,
        customer: r.customer, salesRep: r.salesRep,
        items: r.items.map(returnLineView),
      };
    });

    const total = rows.reduce((t, r) => t + r.total, 0);
    const byReason: Record<string, { count: number; total: number }> = {};
    for (const r of rows) {
      const b = (byReason[r.reason] ??= { count: 0, total: 0 });
      b.count += 1;
      b.total += r.total;
    }
    const salesTotal = Number(sales._sum.total ?? 0);
    res.json({
      success: true,
      data: {
        returns: rows,
        summary: {
          count: rows.length,
          total: Math.round(total * 1000) / 1000,
          salesTotal: Math.round(salesTotal * 1000) / 1000,
          // نسبة المرتجع من المبيعات بمنزلةٍ عشرية — null بلا مبيعات (القسمة على صفر لا معنى لها)
          returnRate: salesTotal > 0 ? Math.round((total / salesTotal) * 1000) / 10 : null,
          byReason,
          expiredLines: rows.reduce((n, r) => n + r.items.filter((i) => i.returnExpired === true).length, 0),
        },
        rangeApplied,
        defaultDays: rangeApplied ? null : DEFAULT_DAYS,
      },
    });
  } catch (err) { next(err); }
});

router.get('/collections', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to, salesRepId, paymentMethod, paymentMethodKey } = req.query as Record<string, string>;
    // نطاق شامل ليوم «إلى» كاملاً (حتى منتصف ليلته) — يُصلح التصفية ليوم واحد وآخر يوم
    // طرفٌ واحد يكفي (راجع تقرير المبيعات): الغائب = بلا حدّ، لا إلغاءَ للفلتر
    const dateFilter = (from || to) ? {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lt: new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) } : {}),
    } : undefined;

    const [receipts, methodsRow] = await Promise.all([
      prisma.receipt.findMany({
        where: {
          tenantId: tid,
          ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)),
          status: 'ACTIVE',
          ...(dateFilter && { receiptDate: dateFilter }),
          ...(salesRepId && { salesRepId }),
          // paymentMethod يصفّي بالأساس كما اليوم (ومعه المخصّصة التي تُعامل مثله)؛ وpaymentMethodKey بطريقة مخصّصة بعينها
          ...(paymentMethod && { paymentMethod: paymentMethod as 'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE' }),
          ...(typeof paymentMethodKey === 'string' && CUSTOM_METHOD_KEY_RE.test(paymentMethodKey) && { paymentMethodKey }),
          ...teamDocWhere(reportTeamOf(req.query.teamId)),
        },
        include: {
          customer: { select: { id: true, name: true } },
          salesRep: { select: { id: true, name: true } },
          team: TEAM_NAME_SELECT,
        },
        orderBy: { receiptDate: 'asc' },
      }),
      // «إدارة طرق الدفع»: أسماء الشركة لملخّص الطرق — byMethod يبقى بالأساس للجداول القائمة ووثائق API
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { paymentMethodsConfig: true } }),
    ]);
    const byKey = summarizeCollectionsByMethod(receipts, readPaymentMethodsConfig(methodsRow?.paymentMethodsConfig ?? null));

    const summary = {
      total: receipts.reduce((s, r) => s + Number(r.amount), 0),
      count: receipts.length,
      byMethod: receipts.reduce((acc, r) => {
        acc[r.paymentMethod] = (acc[r.paymentMethod] ?? 0) + Number(r.amount);
        return acc;
      }, {} as Record<string, number>),
      byMethodKey: byKey.byMethodKey,
      methods: byKey.methods,
    };

    res.json({ success: true, data: { receipts, summary } });
  } catch (err) { next(err); }
});

router.get('/balances', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { type } = req.query as Record<string, string>;

    let where = {};
    // 1e-6 يحجب غبار العائمة التاريخي دون اخفاء اي دين حقيقي (اصغر وحدة 0.001)
    if (type === 'overdue') where = { balance: { gt: 1e-6 } };
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

    // «الفرق»: المناديب بعضويتهم، ومبيعاتهم وتحصيلهم وزياراتهم بوسم المستند — فمندوبٌ في فريقين لا تدخل مبيعات فريقه الآخر
    // قيد المستخدم وفلتر الفريق عنصران في AND: كلاهما قد يحمل المفتاح teamMemberships (مشرف الفرق) فالنثر يمحو الأول.
    // ومجاميع المندوب بنطاق المستند نفسه (docScope): مندوبٌ مشترك لا تظهر لمشرف فريقٍ مبيعاتُ فريقه الآخر
    const team = reportTeamOf(req.query.teamId);
    const docScope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const [reps, sessions, visitRows] = await Promise.all([
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true, AND: [await adminRepFilter(req), teamRepOrDocsWhere(team)] },
        select: {
          id: true, name: true,
          invoices: {
            where: { status: 'CONFIRMED', type: { not: 'RETURN' }, ...(dateFilter && { invoiceDate: dateFilter }), ...teamDocWhere(team), ...docScope },
            select: { total: true, discountAmt: true, type: true },
          },
          receipts: {
            where: { status: 'ACTIVE', ...(dateFilter && { receiptDate: dateFilter }), ...teamDocWhere(team), ...docScope },
            select: { amount: true },
          },
        },
      }),
      // ساعات العمل من جلسات الحضور
      prisma.repSession.findMany({
        where: { tenantId: tid, startedAt: { gte: fromDate, lt: toEnd }, ...(await scopedRepRecordWhere(req)) },
        select: { salesRepId: true, startedAt: true, lastBeatAt: true },
      }),
      /* كلّ الزيارات — لا العدّ الخام (groupBy) ولا ذوات الإحداثيّات وحدها.
       * العدّ يجري على **الوقفات** بعد الدمج: الزيارة المؤقّتة وملاحظتها سجلّان
       * ووقفةٌ واحدة، فكان عدّ السجلّات يضاعف زيارات المندوب في تقرير أدائه. */
      prisma.repVisit.findMany({
        where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd }, ...(await scopedRecordWhere(req, SHAPE_VISIT)), ...teamDocWhere(team) },
        select: {
          salesRepId: true, customerId: true, createdAt: true, startedAt: true, durationSec: true,
          lat: true, lng: true, customer: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' }, take: 20000,
      }),
    ]);

    const minutesByRep = new Map<string, number>();
    for (const s of sessions) {
      minutesByRep.set(s.salesRepId, (minutesByRep.get(s.salesRepId) || 0) + Math.max(0, (s.lastBeatAt.getTime() - s.startedAt.getTime()) / 60000));
    }
    const countByRep = new Map<string, number>();
    const visitsByRep = new Map<string, { customerName: string; createdAt: Date; lat: number; lng: number; mapsUrl: string }[]>();
    for (const m of mergeVisitsByRep(visitRows.map(asVisitLike))) {
      const rep = m.sources[0].salesRepId;
      countByRep.set(rep, (countByRep.get(rep) || 0) + 1);
      if (m.lat == null || m.lng == null) continue;
      const arr = visitsByRep.get(rep) || [];
      if (arr.length < 300) { // سقف معقول لروابط كل مندوب
        arr.push({
          customerName: m.customerName, createdAt: m.start, lat: m.lat, lng: m.lng,
          mapsUrl: `https://www.google.com/maps?q=${m.lat},${m.lng}`,
        });
        visitsByRep.set(rep, arr);
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
      where: { tenantId: tid, createdAt: { gte: fromDate, lt: toEnd }, ...(await scopedRecordWhere(req, SHAPE_VISIT)), ...teamDocWhere(reportTeamOf(req.query.teamId)) },
      select: {
        id: true, salesRepId: true, customerId: true, createdAt: true, startedAt: true,
        note: true, lat: true, lng: true, durationSec: true,
        customer: { select: { name: true } },
        salesRep: { select: { name: true } },
        team: TEAM_NAME_SELECT,
      },
      orderBy: { createdAt: 'desc' }, take: 5000,
    });
    /* وقفةٌ لكلّ صفّ: الزيارة المؤقّتة وملاحظتها (أو صورتها) سجلّان في القاعدة،
     * فكان العميل يظهر مرّتين — مرّةً بمدّة ومرّةً «بلا توقيت» بملاحظة — ويتضاعف
     * عدد زياراته. والصفّ المدموج يأخذ المدّة من المؤقّت، والملاحظة من سجلّها،
     * والموقع من أيّهما حمله. */
    const rows = mergeVisitsByRep(visits.map(asVisitLike)).map(m => {
      const head = m.sources[0];
      const notes = [...new Set(m.sources.map(v => (v.note || '').trim()).filter(Boolean))];
      return {
        id: head.id,
        customerId: head.customerId,
        customerName: m.customerName,
        repName: head.salesRep?.name || '',
        teamName: head.team?.name ?? null,
        createdAt: m.start,
        durationSec: m.durationSec,
        note: notes.join(' · '),
        mapsUrl: m.lat != null && m.lng != null ? `https://www.google.com/maps?q=${m.lat},${m.lng}` : '',
      };
    }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
        where: { tenantId: tid, isActive: true, AND: [await adminRepFilter(req), teamRepWhere(reportTeamOf(req.query.teamId))] },
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
    // حدود المدى على **حدود اليوم المحلي** (كلحظات UTC) لا حدود يوم UTC: التجميع
    // والملء يجريان بالأيام المحلية (tzOffsetMin)، فحدٌّ بتوقيت UTC كان يسقط أول
    // ساعات اليوم الأول بتوقيت المندوب ويُلحق يوماً غائباً زائداً بنهاية التقرير.
    const localDayStart = (d: string) => new Date(Date.parse(d + 'T00:00:00.000Z') - tzOffsetMin * 60000);
    const toEnd = to ? new Date(localDayStart(to).getTime() + 24 * 60 * 60 * 1000) : new Date();
    let fromDate = from ? localDayStart(from) : new Date(toEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    let rangeClamped = false;
    if (toEnd.getTime() - fromDate.getTime() > MAX_DAYS * 24 * 60 * 60 * 1000) {
      fromDate = new Date(toEnd.getTime() - MAX_DAYS * 24 * 60 * 60 * 1000);
      rangeClamped = true;
    }

    // «الفرق»: المناديب بعضويتهم (الساعات والحضور لا تنقسم)، وزياراتهم بوسمها
    const team = reportTeamOf(req.query.teamId);
    const repWhere = { tenantId: tid, isActive: true, AND: [await adminRepFilter(req), teamRepWhere(team)] };
    const [reps, sessions, visits, pingRows, attendance] = await Promise.all([
      prisma.salesRep.findMany({ where: repWhere, select: { id: true, name: true } }),
      prisma.repSession.findMany({
        where: { tenantId: tid, startedAt: { gte: fromDate, lt: toEnd }, ...(await scopedRepRecordWhere(req)) },
        select: { salesRepId: true, startedAt: true, lastBeatAt: true },
      }),
      prisma.repVisit.findMany({
        // الفلتر يُوائم حقل التجميع (at = startedAt || createdAt): الفلتر على
        // createdAt وحده كان يُدخل زيارةً بدأت قبل المدى (startedAt قديم لزيارةٍ
        // عالقة أُنشئ سجلّها داخله) فتُنسب ليوم بدايتها خارج ما حدّده المشرف،
        // ويُسقط زيارةً بدأت في آخر يومٍ وأُنشئ سجلُّها بعد منتصف ليله.
        // النطاق عنصرٌ في مصفوفة AND نفسها: نثرُه بجانب مفتاح AND كان يُكتب فوقه فيسقط قيد عملاء المستخدم المقيّد
        where: {
          tenantId: tid,
          ...teamDocWhere(team),
          AND: [await scopedRecordWhere(req, SHAPE_VISIT), { OR: [
            { startedAt: { gte: fromDate, lt: toEnd } },
            { startedAt: null, createdAt: { gte: fromDate, lt: toEnd } },
          ] }],
        },
        select: { salesRepId: true, createdAt: true, startedAt: true, durationSec: true, lat: true, lng: true, customer: { select: { name: true } } },
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
      // بصمات الحضور: تُنسب ليومها المحلي ببصمة الحضور — نوبةٌ عبرت منتصف الليل تبقى ليوم بدايتها.
      // ومعها إحداثيات البصمتين: التقرير يُظهر أين حضر وأين انصرف (رابط خريطة لكل وقت)
      prisma.repAttendance.findMany({
        where: { tenantId: tid, checkInAt: { gte: fromDate, lt: toEnd }, ...(await scopedRepRecordWhere(req)) },
        select: {
          salesRepId: true, checkInAt: true, checkOutAt: true,
          checkInLat: true, checkInLng: true, checkOutLat: true, checkOutLng: true,
          // الجهاز ووسم «خارج النطاق» ومصدر الصفّ (تعديلٌ إداري أو رفعٌ من Excel) — يعرضها التقرير مع كل فترة
          checkInDevice: true, checkOutDevice: true,
          checkInOutside: true, checkInDistanceM: true, checkOutOutside: true, checkOutDistanceM: true,
          source: true, editedAt: true,
        },
      }),
    ]);

    const byRep = <T extends { salesRepId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) { const a = m.get(r.salesRepId) || []; a.push(r); m.set(r.salesRepId, a); }
      return m;
    };
    const sessByRep = byRep(sessions);
    const visitsByRep = byRep(visits);
    const pingsByRep = byRep(pingRows);
    const attByRep = byRep(attendance);

    const data = reps.map(r => {
      const daysRaw = composeWorkDays({
        sessions: (sessByRep.get(r.id) || []).map(s => ({ start: s.startedAt, end: s.lastBeatAt })),
        pingRanges: (pingsByRep.get(r.id) || []).map(p => ({ day: p.day, min: p.min, max: p.max })),
        visits: (visitsByRep.get(r.id) || []).map(v => ({
          customerName: v.customer?.name || '—',
          at: v.startedAt || v.createdAt,   // بداية المؤقّت أدقّ؛ زيارة الملاحظة بوقت تسجيلها
          durationSec: v.durationSec,
          lat: v.lat, lng: v.lng,
        })),
        tzOffsetMin,
        // مدى الأيام المحلّية: يُملأ الغائب منها بصفوفٍ فارغة كي يظهر الغياب
        range: {
          from: new Date(fromDate.getTime() + tzOffsetMin * 60000).toISOString().slice(0, 10),
          to: new Date(toEnd.getTime() - 1 + tzOffsetMin * 60000).toISOString().slice(0, 10),
        },
      });

      // بصمة الحضور تعلو مقياس الأثر: يومٌ ببصمة ⇒ فترةٌ لكل حضور→انصراف (periods)، وإجماليه مجموع
      // النوبات المغلقة، واستراحته ما بين انصرافٍ والحضور التالي (breakMinutes) — لا عتبة زمنية.
      // «نشاط التطبيق» (appMinutes) يبقى كما هو. الأيام بلا بصمة على مقياسها القديم: امتدادٌ واحد (توافق).
      const days = overlayAttendance(daysRaw, attendanceByDay(attByRep.get(r.id) || [], tzOffsetMin));

      // نشاط التطبيق (نبضة الاتصال) لا يتغيّر بالبصمة — الواجهة المنشورة تقرؤه أثناء انزلاق النشر.
      const appTotal = days.reduce((s, d) => s + d.appMinutes, 0);
      const fieldTotal = days.reduce((s, d) => s + d.spanMinutes, 0);
      const workedDays = days.filter((d) => !d.absent).length;
      const absentDays = days.filter((d) => d.absent).length;
      const visitsTotal = days.reduce((s, d) => s + d.visitsCount, 0);
      const sess = sessByRep.get(r.id) || [];
      // أول/آخر ظهور من أيام **النشاط** وحدها: الأيام الغائبة تُملأ بمنتصف الليل
      // المحلي (workDay.ts)، فحسابها من days[0]/days[len-1] كان يعرض «١٢:٠٠ ص»
      // كأول ظهورٍ متى بدأ المدى أو انتهى بيوم غياب.
      const active = days.filter((d) => !d.absent);
      return {
        id: r.id, name: r.name,
        totalMinutes: appTotal,
        hours: Math.floor(appTotal / 60), minutes: appTotal % 60,
        sessions: sess.length,
        firstSeen: active.length ? active[0].firstActivity : null,
        lastSeen: active.length ? active[active.length - 1].lastActivity : null,
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

/**
 * تقييم الأداء (طلب المالك ١٢ أكتوبر ٢٠٢٦) — ترتيب المناديب حسب معيارٍ واحد يختاره المشرف (services/repRanking.ts):
 *  - visits: الزيارات بعد دمج سجلّات الوقفة الواحدة (تعريف «أداء المندوب» نفسه)؛
 *  - product: الكمية المباعة من صنفٍ بعينه في فواتير البيع المؤكَّدة؛
 *  - sales: قيمة المبيعات — فواتير مؤكَّدة غير مرتجعة (تعريف «أداء المندوب» نفسه)؛
 *  - distance: المسافة المرصودة بالكيلو من نقاط GPS — تُختزل في القاعدة إلى نقطةٍ لكل دقيقة (الأدقّ) لكل مندوب على حدة،
 *    والمدى ٣١ يوماً على الأكثر (كتقرير ساعات العمل) ويُعلن القصّ؛
 *  - appTime: وقت استخدام التطبيق بالدقائق — جلسات النبض (مصدر «ساعات العمل» في أداء المندوب).
 * حدود المدى على **حدود اليوم المحلي** بإزاحة المتصفّح (tz) كتقرير ساعات العمل. والمعياران الماليّان يُرفضان مع المحاسبة المطفأة.
 */
router.get('/rep-ranking', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const q = req.query as Record<string, string | undefined>;
    const metric = q.metric as RankingMetric;
    if (!(RANKING_METRICS as readonly string[]).includes(metric)) {
      res.status(400).json({ success: false, message: 'معيار التقييم غير معروف' }); return;
    }
    if (FINANCIAL_METRICS.includes(metric)) {
      const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true } });
      if (t?.accountingEnabled === false) {
        res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' }); return;
      }
    }
    // الصنف ووحدة أساسه (وسم القيمة) ووحداته النشطة — القيمة بالأساس، والعارض يفكّكها «٢ كرتون و٣ حبة»
    let product: { id: string; name: string; unit: string; units: ReportUnit[] } | null = null;
    if (metric === 'product') {
      if (!q.productId) { res.status(400).json({ success: false, message: 'اختر الصنف' }); return; }
      product = await prisma.product.findFirst({ where: { id: q.productId, tenantId: tid }, select: { id: true, name: true, unit: true, units: ACTIVE_UNITS_SELECT } });
      if (!product) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    }

    // المدى بالأيام المحلية: بلا «من» ⇒ منذ البداية (كأداء المندوب)، إلا المسافة فأسبوعٌ ينتهي اليوم، وسقفها ٣١ يوماً
    const tz = Math.max(-840, Math.min(840, parseInt(q.tz || '') || 0));
    const DAY = 24 * 60 * 60 * 1000;
    const isDay = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const dayStart = (d: string) => new Date(Date.parse(d + 'T00:00:00.000Z') - tz * 60000);
    const today = new Date(Date.now() + tz * 60000).toISOString().slice(0, 10);
    const toDay = isDay(q.to) ? q.to! : today;
    const end = new Date(dayStart(toDay).getTime() + DAY);
    let start = isDay(q.from) ? dayStart(q.from!) : (metric === 'distance' ? new Date(end.getTime() - 7 * DAY) : new Date(0));
    let clampedDays: number | null = null;
    const MAX_DISTANCE_DAYS = 31;
    if (metric === 'distance' && end.getTime() - start.getTime() > MAX_DISTANCE_DAYS * DAY) {
      start = new Date(end.getTime() - MAX_DISTANCE_DAYS * DAY);
      clampedDays = MAX_DISTANCE_DAYS;
    }

    // «الفرق»: المناديب بعضويتهم، والمبيعات وكمية الصنف والزيارات بوسم المستند (المسافة ووقت التطبيق لا تنقسم)
    const team = reportTeamOf(q.teamId);
    // المسافة ووقت التطبيق بعضوية المندوب، والمبيعات والصنف والزيارات بمستنداته — فيدخل من له مستندٌ للفريق
    const docMetric = metric === 'sales' || metric === 'product' || metric === 'visits';
    const reps = await prisma.salesRep.findMany({
      where: { tenantId: tid, isActive: true, AND: [await adminRepFilter(req), docMetric ? teamRepOrDocsWhere(team) : teamRepWhere(team)] },
      select: { id: true, name: true },
    });
    const ids = reps.map((r) => r.id);
    const value = new Map<string, number>();
    const add = (rep: string | null, v: number) => { if (rep) value.set(rep, (value.get(rep) ?? 0) + v); };

    if (ids.length && metric === 'sales') {
      const rows = await prisma.invoice.groupBy({
        by: ['salesRepId'],
        where: { tenantId: tid, salesRepId: { in: ids }, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: start, lt: end }, ...teamDocWhere(team), ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) },
        _sum: { total: true },
      });
      for (const r of rows) add(r.salesRepId, Number(r._sum.total ?? 0));
    } else if (ids.length && metric === 'product' && product) {
      const rows = await prisma.invoiceItem.findMany({
        where: {
          productId: product.id,
          invoice: { tenantId: tid, salesRepId: { in: ids }, status: 'CONFIRMED', type: { not: 'RETURN' }, invoiceDate: { gte: start, lt: end }, ...teamDocWhere(team), ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) },
        },
        select: { qty: true, unitFactor: true, baseQty: true, invoice: { select: { salesRepId: true } } },
      });
      for (const [rep, v] of productQtyByRep(rows)) add(rep, v);
    } else if (ids.length && metric === 'visits') {
      const visits = await prisma.repVisit.findMany({
        where: { tenantId: tid, salesRepId: { in: ids }, createdAt: { gte: start, lt: end }, ...(await scopedRecordWhere(req, SHAPE_VISIT)), ...teamDocWhere(team) },
        select: {
          salesRepId: true, customerId: true, createdAt: true, startedAt: true, durationSec: true,
          lat: true, lng: true, customer: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' }, take: 50000,
      });
      for (const m of mergeVisitsByRep(visits.map(asVisitLike))) add(m.sources[0].salesRepId, 1);
    } else if (ids.length && metric === 'appTime') {
      const sessions = await prisma.repSession.findMany({
        where: { tenantId: tid, salesRepId: { in: ids }, startedAt: { gte: start, lt: end } },
        select: { salesRepId: true, startedAt: true, lastBeatAt: true },
      });
      for (const x of sessions) add(x.salesRepId, Math.max(0, (x.lastBeatAt.getTime() - x.startedAt.getTime()) / 60000));
    } else if (ids.length && metric === 'distance') {
      // مندوبٌ مندوب: نقطةٌ لكل دقيقة (الأدقّ) تُختزل في القاعدة — الخام نقطةٌ كل ٨ ثوانٍ (~٣٦٠٠ يومياً)
      for (const repId of ids) {
        const pts = await prisma.$queryRaw<{ lat: number; lng: number; accuracy: number | null; capturedAt: Date }[]>`
          SELECT DISTINCT ON (date_trunc('minute', "capturedAt")) "lat", "lng", "accuracy", "capturedAt"
          FROM "rep_locations"
          WHERE "tenantId" = ${tid} AND "salesRepId" = ${repId} AND "capturedAt" >= ${start} AND "capturedAt" < ${end}
            AND ("accuracy" IS NULL OR "accuracy" <= 150)
          ORDER BY date_trunc('minute', "capturedAt"), "accuracy" ASC NULLS LAST`;
        add(repId, trackedMeters(pts.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), accuracy: p.accuracy == null ? null : Number(p.accuracy), capturedAt: new Date(p.capturedAt) }))) / 1000);
      }
    }

    // الكيلو بمنزلةٍ عشرية، والدقائق صحيحة، والمبالغ والكميات بثلاث منازل (عملات الدينار)
    const round = (v: number) => (metric === 'distance' ? Math.round(v * 10) / 10 : metric === 'appTime' ? Math.round(v) : Math.round(v * 1000) / 1000);
    const rows = rankRows(reps.map((r) => ({ repId: r.id, name: r.name, value: round(value.get(r.id) ?? 0) })));
    res.json({
      success: true,
      data: {
        metric, product, rows,
        range: { from: start.getTime() === 0 ? null : new Date(start.getTime() + tz * 60000).toISOString().slice(0, 10), to: toDay },
        clampedDays,
      },
    });
  } catch (err) { next(err); }
});

/**
 * «طرق الدفع» — تحصيل كل مندوب موزّعاً على طرق الدفع في الفترة (services/paymentMethodsReport.ts: القرارات ومنطق البناء).
 *
 * - **البوّابة:** صلاحية التقارير (canViewReports على الراوتر كلّه) + عَلَم الشركة paymentMethodsEnabled والمحاسبة
 *   (requirePaymentMethods: ٤٠٣ PAYMENT_METHODS_NOT_ALLOWED / ACCOUNTING_NOT_ALLOWED).
 * - **النطاق** كتقرير التحصيل وأداء المندوب: `scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)` على السندات والفواتير —
 *   المقيَّد بالقوائم يرى ما عميله **و**مندوبه في نطاقه، ومشرف الفرق ما وُسم بفرقه وحده (القديم بلا فريق لا يراه).
 *   وفلتر الفريق بوسم المستند (`teamDocWhere`) فمجموع الفرق إجمالي الشركة بلا ازدواج. والنطاق مفتاح AND واحد
 *   وفلتر الفريق مفتاح teamId — لا يمحو أحدهما الآخر.
 * - **الصفوف من المستندات لا من قائمة المناديب:** تجميعٌ في القاعدة (groupBy) ثم أسماء من حصّل وحدهم — فمندوبٌ أُوقف
 *   بعد أن حصّل لا يسقط تحصيله، ولا يُسحب أيّ سندٍ إلى الذاكرة مهما طال المدى.
 * - **التاريخ** تاريخ المستند (receiptDate / invoiceDate) كبقيّة التقارير — لا لحظة الرفع (المستند الأوف‑لاين يُرفع متأخراً).
 */
router.get('/payment-methods', requirePaymentMethods, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const tz = await tenantTz(tid);
    const range = paymentMethodsRange(req.query.from, req.query.to, tz);
    if (!range.ok) { res.status(400).json({ success: false, message: range.message }); return; }
    const team = reportTeamOf(req.query.teamId);
    const docScope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    const [receiptGroups, cashSaleGroups, activeReps, methodsRow] = await Promise.all([
      prisma.receipt.groupBy({
        // «إدارة طرق الدفع»: والمفتاح المخصّص — جدولٌ لكل طريقة مخصّصة (القرار ٦ في services/paymentMethodsReport.ts)
        by: ['salesRepId', 'paymentMethod', 'paymentMethodKey'],
        where: { tenantId: tid, ...COLLECTED_RECEIPT, receiptDate: { gte: range.gte, lt: range.lt }, ...teamDocWhere(team), ...docScope },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      // فواتير البيع النقدي: نقدٌ قبضه المندوب عند البيع بلا سند (القرار ١) — المبلغ المدفوع (= الإجمالي في النقدية)
      prisma.invoice.groupBy({
        by: ['salesRepId'],
        // شرط «المحصَّل» فيه OR — يُجمع مع النطاق والفريق في AND فلا يطغى مفتاحٌ على مثيله عند النشر
        where: { tenantId: tid, invoiceDate: { gte: range.gte, lt: range.lt }, AND: [COLLECTED_CASH_SALE, teamDocWhere(team), docScope] },
        _sum: { paidAmt: true },
        _count: { _all: true },
      }),
      // كلّ مناديب النطاق النشطين — القائمة تعرضهم جميعاً بكلّ طرق الدفع ولو بلا تحصيل (نطاق تقارير الأداء نفسه)
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true, AND: [await adminRepFilter(req), teamRepOrDocsWhere(team)] },
        select: { id: true, name: true, isActive: true },
      }),
      // أسماء الشركة لطرقها وطرقها المخصّصة وما عطّلته
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { paymentMethodsConfig: true } }),
    ]);

    // أسماء من حصّل وحدهم (المعرّفات من مستنداتٍ مرّت بالنطاق) — نشطاً أو موقوفاً
    const repIds = [...new Set([...receiptGroups, ...cashSaleGroups].map((g) => g.salesRepId).filter((x): x is string => !!x))];
    const reps = repIds.length
      ? await prisma.salesRep.findMany({ where: { tenantId: tid, id: { in: repIds } }, select: { id: true, name: true, isActive: true } })
      : [];
    const repInfo = new Map<string, RepInfo>(reps.map((r) => [r.id, { name: r.name, isActive: r.isActive }]));

    const report = buildPaymentMethodsReport(
      receiptGroups.map((g) => ({ salesRepId: g.salesRepId, paymentMethod: g.paymentMethod, paymentMethodKey: g.paymentMethodKey, amount: Number(g._sum.amount ?? 0), count: g._count._all })),
      cashSaleGroups.map((g) => ({ salesRepId: g.salesRepId, amount: Number(g._sum.paidAmt ?? 0), count: g._count._all })),
      repInfo,
      readPaymentMethodsConfig(methodsRow?.paymentMethodsConfig ?? null),
    );
    res.json({ success: true, data: { range: { from: range.from, to: range.to, timezone: tz }, ...report, roster: rosterOf(activeReps, repInfo) } });
  } catch (err) { next(err); }
});

export default router;
