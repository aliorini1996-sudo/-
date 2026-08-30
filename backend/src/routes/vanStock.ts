import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { suggestLoad, type SaleRow } from '../services/suggestLoad';
import { computeAccuracy } from '../services/suggestAccuracy';
import { canAccessRep, adminRepFilter, scopedRepRecordWhere } from '../services/adminScope';
import { roundDecimal } from '../utils/helpers';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageVanStock'));

const loadSchema = z.object({
  salesRepId: z.string().optional(), // الأدمن يحدّده؛ المندوب يُستخدم معرّفه تلقائياً
  type: z.enum(['LOAD', 'UNLOAD', 'ADJUST']).default('LOAD'),
  note: z.string().optional(),
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number(), // موجب للتحميل/الإرجاع للمستودع؛ قد تكون سالبة لـADJUST
    // ما اقترحه المحرّك وقت التحميل — يُخزَّن للمقارنة لاحقاً
    suggestedQty: z.number().optional(),
    expectedQty: z.number().optional(),
  })).min(1),
});

// يحدّد المندوب المستهدف: المندوب=نفسه، الأدمن=من الطلب
function resolveRep(req: AuthRequest, bodyRepId?: string): { salesRepId: string; isRep: boolean } {
  const isRep = req.user?.role === 'SALES_REP';
  if (isRep) return { salesRepId: req.user!.id, isRep: true };
  if (!bodyRepId) throw Object.assign(new Error('يجب تحديد المندوب'), { status: 400 });
  return { salesRepId: bodyRepId, isRep: false };
}

/**
 * حارس نطاق المندوب — يُستدعى في **كل** مسار يستقبل `salesRepId` من الطلب.
 *
 * كل مسارات هذا الملفّ تكشف أداء مندوب بعينه (المحمّل والمُباع والمتبقّي
 * وتاريخ آخر تحميل)، وهو عين ما يحكمه نطاق المستخدم الإداري. و**404 لا 403**
 * كي لا يكشف الردّ نفسه وجود مندوب خارج النطاق.
 *
 * المندوب يُستثنى: له عزله المنفصل، ومعرّفه يأتي من توكنه لا من الطلب.
 */
async function assertRepInScope(req: AuthRequest, tid: string, salesRepId: string): Promise<void> {
  if (req.user?.role === 'SALES_REP') return;
  if (!(await canAccessRep(req, tid, salesRepId))) {
    throw Object.assign(new Error('المندوب غير موجود'), { status: 404 });
  }
}

interface StockRow {
  productId: string; name: string; code: string; unit: string;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
}

// يحسب مخزون سيارة مندوب لكل منتج: المتبقي = المحمّل − المنزَّل + التسوية − المُباع + المُرتجع
export async function computeStock(tid: string, salesRepId: string): Promise<StockRow[]> {
  const [loadItems, invItems, products] = await Promise.all([
    prisma.vanLoadItem.findMany({
      where: { vanLoad: { tenantId: tid, salesRepId } },
      select: { productId: true, qty: true, vanLoad: { select: { type: true } } },
    }),
    prisma.invoiceItem.findMany({
      where: { invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED' } },
      select: { productId: true, qty: true, invoice: { select: { type: true, returnToStock: true } } },
    }),
    prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, unit: true, code: true } }),
  ]);

  const acc = new Map<string, Omit<StockRow, 'productId' | 'name' | 'code' | 'unit' | 'remaining'>>();
  const ensure = (pid: string) => {
    if (!acc.has(pid)) acc.set(pid, { loaded: 0, unloaded: 0, adjusted: 0, sold: 0, returned: 0 });
    return acc.get(pid)!;
  };
  for (const it of loadItems) {
    const m = ensure(it.productId);
    if (it.vanLoad.type === 'LOAD') m.loaded += it.qty;
    else if (it.vanLoad.type === 'UNLOAD') m.unloaded += it.qty;
    else m.adjusted += it.qty;
  }
  for (const it of invItems) {
    // مخزون السيارة للمنتجات وحدها: بند فاتورة المطعم بلا productId، وتمريره
    // كان يفتح صفّاً بمفتاح فارغ يلوّث كل الأرصدة.
    if (!it.productId) continue;
    const m = ensure(it.productId);
    // المرتجع لا يُعاد لمخزون السيارة إلا إذا حُدِّد returnToStock (التالف عادةً لا يعود)
    if (it.invoice.type === 'RETURN') { if (it.invoice.returnToStock) m.returned += it.qty; }
    else m.sold += it.qty;
  }

  const prodById = new Map(products.map(p => [p.id, p]));
  const rows: StockRow[] = [];
  for (const [pid, m] of acc) {
    const p = prodById.get(pid);
    if (!p) continue;
    // تقريب 4 خانات يمحو غبار سلسلة الجمع (3×0.1−0.3 = 5.55e-17 صف شبحي يتصدر الفرز)
    const remaining = roundDecimal(m.loaded - m.unloaded + m.adjusted - m.sold + m.returned, 4);
    rows.push({ productId: pid, name: p.name, code: p.code, unit: p.unit, ...m, remaining });
  }
  rows.sort((a, b) => b.remaining - a.remaining);
  return rows;
}

// تسجيل حركة تحميل/تنزيل/تسوية لسيارة المندوب
router.post('/loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = loadSchema.parse(req.body);
    const { salesRepId, isRep } = resolveRep(req, data.salesRepId);

    // التنقيص/التسوية (الكميات السالبة و UNLOAD/ADJUST) متاح للإدارة فقط؛ المندوب يُحمّل موجباً فقط
    if (isRep && (data.type !== 'LOAD' || data.items.some(i => i.qty < 0))) {
      res.status(403).json({ success: false, message: 'تنقيص مخزون السيارة متاح للإدارة فقط' });
      return;
    }

    await assertRepInScope(req, tid, salesRepId);
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (isRep && rep.canManageVanStock === false) { res.status(403).json({ success: false, message: 'غير مسموح لك بإدارة مخزون السيارة' }); return; }

    const items = data.items.filter(i => i.qty !== 0);
    if (!items.length) { res.status(400).json({ success: false, message: 'لا توجد كميات صالحة' }); return; }

    const productIds = [...new Set(items.map(i => i.productId))];
    const valid = await prisma.product.count({ where: { id: { in: productIds }, tenantId: tid } });
    if (valid !== productIds.length) { res.status(400).json({ success: false, message: 'منتج غير صالح' }); return; }

    const load = await prisma.vanLoad.create({
      data: {
        tenantId: tid, salesRepId, type: data.type, note: data.note,
        createdBy: isRep ? 'REP' : 'ADMIN',
        items: { create: items.map(i => ({ productId: i.productId, qty: i.qty, suggestedQty: i.suggestedQty ?? null, expectedQty: i.expectedQty ?? null })) },
      },
      include: { items: { include: { product: { select: { id: true, name: true, unit: true } } } } },
    });
    res.status(201).json({ success: true, data: load });
  } catch (err) { next(err); }
});

// المخزون الحالي لمندوب (المندوب=سيارته، الأدمن=يمرّر salesRepId)
router.get('/current', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);
    const rows = await computeStock(tid, salesRepId);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

/**
 * كمية التحميل المقترحة لسيارة مندوب في يوم مُحدَّد.
 *
 * لا يُخزَّن شيء هنا — الاقتراح حساب لحظي من التاريخ. يُخزَّن فقط حين يُنشئ
 * المستخدم تحميلاً فعلياً (suggestedQty على البند)، فتُقارَن لاحقاً بالمُباع.
 *
 * النافذة والهامش معاملان يُدخلهما المستخدم لا ثابتان مخفيّان: شركة توزيع
 * مياه ليست كشركة توزيع مستحضرات، ولا رقم سوق نعرفه نيابةً عنها.
 */
router.get('/suggest', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);

    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true, name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const windowDays = Math.min(180, Math.max(7, Number(req.query.windowDays) || 28));
    // قيمة غير رقمية تعود للافتراضي لا لصفر: صفر هامش قرار تشغيلي مختلف
    // تماماً عن «لم يُرسَل معامل»، وابتلاعه صامتاً يغيّر التوصية بلا علم أحد.
    const rawBuffer = Number(req.query.bufferPct);
    const bufferPct = Math.min(100, Math.max(0, Number.isFinite(rawBuffer) ? rawBuffer : 15));
    const targetDate = String(req.query.date || '') || new Date().toISOString();

    // نجلب أوسع قليلاً من النافذة ثم يُرشّح المحرّك بدقّة — أرخص من حساب
    // حدود اليوم المحلّي هنا مرّتين بمنطقين مختلفين.
    const since = new Date(new Date(targetDate).getTime() - (windowDays + 2) * 86400000);
    const [items, products, stock] = await Promise.all([
      prisma.invoiceItem.findMany({
        where: {
          productId: { not: null },
          invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED', invoiceDate: { gte: since } },
        },
        select: { productId: true, qty: true, invoice: { select: { invoiceDate: true, type: true } } },
      }),
      prisma.product.findMany({
        where: { tenantId: tid, status: { not: 'INACTIVE' } },
        select: { id: true, name: true, code: true, unit: true },
      }),
      computeStock(tid, salesRepId),
    ]);

    const sales: SaleRow[] = [];
    const returns: SaleRow[] = [];
    for (const it of items) {
      if (!it.productId) continue;
      const row = { productId: it.productId, qty: it.qty, date: it.invoice.invoiceDate };
      (it.invoice.type === 'RETURN' ? returns : sales).push(row);
    }

    const result = suggestLoad({
      sales, returns, products, targetDate, windowDays, bufferPct,
      onVan: stock.map((s) => ({ productId: s.productId, remaining: s.remaining })),
    });

    res.json({ success: true, data: { ...result, salesRep: rep } });
  } catch (err) { next(err); }
});

// دقّة الاقتراح — «هل يستحقّ المحرّك الثقة؟» رقماً لا انطباعاً.
// يقارن التنبّؤ اليومي المخزَّن مع كل تحميل (expectedQty) بالمبيع الفعلي
// في نفس اليوم، عبر محرّك صرف (services/suggestAccuracy) اختباراتُه تشرح
// المصائد الثلاث: قِس التنبّؤ لا كمية التعبئة، ويوماً تقويمياً لا فترةً
// بين تحميلين، واستبعد اليوم الجاري لأنه لم يكتمل بيعُه.
router.get('/accuracy', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);

    const days = Math.min(60, Math.max(7, Number(req.query.days) || 14));
    // «اليوم» يومُ المندوب لا الخادم (الخادم UTC): نُزيح كل الطوابع بإزاحة
    // المتصفّح قبل المحرّك — مبيعُ التاسعة مساءً بالرياض ليس من يوم الغد.
    const tzOffsetMin = Math.max(-840, Math.min(840, parseInt(req.query.tz as string) || 0));
    const shift = (d: Date) => new Date(d.getTime() + tzOffsetMin * 60000);
    const since = new Date(Date.now() - (days + 1) * 86400000);

    const [loads, saleItems, products] = await Promise.all([
      prisma.vanLoad.findMany({
        // LOAD وحدها: التسويات والتنقيصات ليست قراراتِ تحميلٍ تنبّؤية
        where: { tenantId: tid, salesRepId, type: 'LOAD', createdAt: { gte: since } },
        select: { id: true, createdAt: true, items: { select: { productId: true, qty: true, suggestedQty: true, expectedQty: true } } },
      }),
      prisma.invoiceItem.findMany({
        where: {
          productId: { not: null },
          invoice: { tenantId: tid, salesRepId, status: 'CONFIRMED', invoiceDate: { gte: since } },
        },
        select: { productId: true, qty: true, invoice: { select: { invoiceDate: true, type: true } } },
      }),
      prisma.product.findMany({ where: { tenantId: tid }, select: { id: true, name: true, code: true, unit: true } }),
    ]);

    const result = computeAccuracy({
      loads: loads.map(l => ({
        id: l.id,
        at: shift(l.createdAt),
        items: l.items.filter(i => i.productId).map(i => ({
          productId: i.productId,
          qty: Number(i.qty),
          suggestedQty: i.suggestedQty === null ? null : Number(i.suggestedQty),
          expectedQty: i.expectedQty === null ? null : Number(i.expectedQty),
        })),
      })),
      sales: saleItems.filter(i => i.productId).map(i => ({
        productId: i.productId!,
        qty: Number(i.qty),
        at: shift(i.invoice.invoiceDate),
        isReturn: i.invoice.type === 'RETURN',
      })),
      now: shift(new Date()),
      products,
    });

    res.json({ success: true, data: { ...result, meta: { days, tzOffsetMin } } });
  } catch (err) { next(err); }
});

// ملخّص مخزون كل المناديب — للأدمن (ينعكس بلوحة التحكم)
router.get('/summary', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true, name: true, isActive: true, canSellWithoutStock: true } });
    const data = await Promise.all(reps.map(async r => {
      const rows = await computeStock(tid, r.id);
      const lastLoad = await prisma.vanLoad.findFirst({
        where: { tenantId: tid, salesRepId: r.id, type: 'LOAD' },
        orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      });
      return {
        salesRepId: r.id, repName: r.name, isActive: r.isActive, canSellWithoutStock: r.canSellWithoutStock,
        productCount: rows.filter(x => Math.abs(x.remaining) > 1e-9).length,
        totalRemaining: roundDecimal(rows.reduce((s, x) => s + x.remaining, 0), 4),
        totalLoaded: roundDecimal(rows.reduce((s, x) => s + x.loaded, 0), 4),
        totalSold: roundDecimal(rows.reduce((s, x) => s + x.sold, 0), 4),
        lastLoadAt: lastLoad?.createdAt || null,
      };
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// تبديل صلاحية «البيع بدون مخزون» لمندوب — للإدارة فقط
router.patch('/sell-permission', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { salesRepId, canSellWithoutStock } = z.object({
      salesRepId: z.string(), canSellWithoutStock: z.boolean(),
    }).parse(req.body);
    await assertRepInScope(req, tid, salesRepId);
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    await prisma.salesRep.update({ where: { id: salesRepId }, data: { canSellWithoutStock } });
    res.json({ success: true, data: { salesRepId, canSellWithoutStock } });
  } catch (err) { next(err); }
});

// سجل التحميلات
router.get('/loads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (salesRepId) await assertRepInScope(req, tid, salesRepId);
    const loads = await prisma.vanLoad.findMany({
      // القيد يغطّي حالة عدم تمرير معرّف: بلا نطاق يعود {} فلا يتغيّر شيء
      where: { tenantId: tid, ...(salesRepId && { salesRepId }), ...(await scopedRepRecordWhere(req)) },
      orderBy: { createdAt: 'desc' }, take: 100,
      include: {
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
        salesRep: { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, data: loads });
  } catch (err) { next(err); }
});

// حركة المخزون عبر الزمن (تحميلات + مبيعات + مرتجعات) — كم نزل من البضاعة ومتى
router.get('/movements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user?.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : (req.query.salesRepId as string | undefined);
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    await assertRepInScope(req, tid, salesRepId);

    const [loads, invoices] = await Promise.all([
      prisma.vanLoad.findMany({
        where: { tenantId: tid, salesRepId }, orderBy: { createdAt: 'desc' }, take: 50,
        include: { items: { include: { product: { select: { name: true, unit: true } } } } },
      }),
      prisma.invoice.findMany({
        where: { tenantId: tid, salesRepId, status: 'CONFIRMED' }, orderBy: { invoiceDate: 'desc' }, take: 50,
        include: { items: { include: { product: { select: { name: true, unit: true } } } }, customer: { select: { name: true } } },
      }),
    ]);

    const movements = [
      ...loads.map(l => ({
        kind: l.type, date: l.createdAt, ref: l.note || '', by: l.createdBy,
        items: l.items.map(i => ({ name: i.product.name, unit: i.product.unit, qty: i.qty })),
      })),
      ...invoices.map(inv => ({
        kind: inv.type === 'RETURN' ? 'RETURN' : 'SALE', date: inv.invoiceDate,
        ref: `${inv.number} · ${inv.customer.name}`, by: 'REP',
        items: inv.items.map(i => ({ name: i.product?.name ?? 'صنف محذوف', unit: i.product?.unit ?? '', qty: i.qty })),
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 60);

    res.json({ success: true, data: movements });
  } catch (err) { next(err); }
});

export default router;
