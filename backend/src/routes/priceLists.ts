import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAccounting, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { customerScope } from '../services/customerScope';
import {
  PRICE_LIST_IN_USE_BY, PRICE_LIST_MESSAGES, PRICE_LIST_NAME_MAX, priceListName, type PriceListCode,
} from '../services/priceLists';

/**
 * «أنواع الأسعار» (طلب المالك، ١ نوفمبر ٢٠٢٦) — /api/price-lists: أسعارٌ مسمّاة تحدّدها الشركة («سعر الجملة»، «سعر التجزئة»…)،
 * لكل عميل نوعه فتُسعَّر فواتيره به، ولا يبدّله المندوب على فاتورةٍ إلا بصلاحية «تبديل نوع السعر». القواعد في services/priceLists.ts.
 *
 * - **القراءة** لكل مستخدم شركة ومندوب (الأسماء ليست سرّاً): نموذج العميل والفاتورة وتطبيق المندوب تحتاجها.
 * - **الكتابة** (الأنواع واسم زرّ الأساس) لمدير الأصناف: requireAdmin + صلاحية الأصناف، كبقيّة كتابات الأسعار.
 * - **أسعار الأنواع** (/prices) بشكل /products/customer-prices نفسه فيعيد تطبيق المندوب أساسها بعد تحويلٍ كأسعار العميل —
 *   والمندوب بلا «تبديل نوع السعر» لا يرى إلا أنواع عملائه ونوعه الافتراضي (لا قائمة جملةٍ كاملة في كاش جواله).
 * - **النوع الذي عليه عملاء لا يُحذف** (409 PRICE_LIST_IN_USE): الحذف يفرّغ نوعهم (SetNull) فيسقط سعرهم إلى الأساس بصمت.
 *   ولا الذي هو افتراضيّ مندوبٍ أو ضمن أنواعه المسموحة (طلب المالك ٢ نوفمبر ٢٠٢٦، repsCount في الردّ).
 *   وأسعاره تُحذف معه (Cascade)، والفواتير المختومة به يُفرَّغ ختمها.
 */
const router = Router();
router.use(authenticate);
router.use(requireAccounting); // عزل «النظام المحاسبي» كالأصناف

/** كتابة الأنواع: مستخدم شركة بصلاحية الأصناف (جلسة المالك تمرّ) */
const manage = [requireAdmin, requireAdminPermission('canManageProducts')];

const refuse = (res: Response, status: number, code: PriceListCode, extra: Record<string, unknown> = {}) => {
  res.status(status).json({ success: false, code, message: PRICE_LIST_MESSAGES[code], ...extra });
};
const isUniqueClash = (e: unknown) => (e as { code?: string })?.code === 'P2002';

// الاسم يُقصّ ويُفحص طوله في priceListName — المخطّط يقبل نصاً معقولاً فقط فلا تصل رسالة zod الإنجليزية
const nameSchema = z.string().max(PRICE_LIST_NAME_MAX * 4);
const LIST_SELECT = { id: true, name: true, sortOrder: true } as const;
const LIST_ORDER = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];
/** العملاء الأحياء — المحذوف (status DELETED) صفٌّ باقٍ لأسماء فواتيره لا يُحسب «مستخدماً» ولا يمنع الحذف */
const LIVE_CUSTOMER = { status: { not: 'DELETED' } } as const;
/**
 * مناديب على النوع: افتراضيّهم، أو ضمن أنواعهم المسموحة (مصفوفة JSON تحويه — `@>` في PostgreSQL). والمندوب المعطَّل يُحسب:
 * إعداده باقٍ ويعود بتفعيله. والمحذوف لا صفّ له
 */
const repsOnList = (id: string) => ({ OR: [{ defaultPriceListId: id }, { allowedPriceTypes: { array_contains: [id] } }] });

/** عدد العملاء الأحياء على كل نوع — groupBy واحد للشركة */
async function customersCountOf(tid: string): Promise<Map<string, number>> {
  const rows = await prisma.customer.groupBy({
    by: ['priceListId'], where: { tenantId: tid, priceListId: { not: null }, ...LIVE_CUSTOMER }, _count: { _all: true },
  });
  return new Map((rows ?? []).filter((r) => r.priceListId).map((r) => [r.priceListId as string, r._count._all]));
}

// الأنواع مرتّبة واسم زرّ الأساس (null = «السعر الأساسي») وعدد عملاء كلٍّ منها — شركةٌ بلا أنواع: قائمة فارغة بلا groupBy
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [lists, settings] = await Promise.all([
      prisma.priceList.findMany({ where: { tenantId: tid }, orderBy: LIST_ORDER, select: LIST_SELECT }),
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { basePriceLabel: true } }),
    ]);
    const counts = lists.length ? await customersCountOf(tid) : new Map<string, number>();
    res.json({
      success: true,
      data: { basePriceLabel: settings?.basePriceLabel ?? null, lists: lists.map((l) => ({ ...l, customersCount: counts.get(l.id) ?? 0 })) },
    });
  } catch (err) { next(err); }
});

/**
 * أسعار الأنواع لتطبيق المندوب والفواتير: `[{ id, name, items: [{ productId, price, unit, baseConvertedAt }] }]` — السعر صافٍ لوحدة
 * الأساس، و`unit` أساس الصنف لحظة القراءة و`baseConvertedAt` لحظة آخر تحويلٍ له (كـ/products/customer-prices حرفياً): بهما يعرف
 * الجهاز على أي أساسٍ حُسب السعر المخزَّن في كاشه. والسعر وأساس صنفه في جملةٍ واحدة — لقطةٌ واحدة لا يفصلها تحويلٌ يلتزم بين
 * استعلامين (يقسم الأسعار على F ويغيّر الأساس في معاملةٍ واحدة). الأصناف المؤرشفة خارجها.
 * وهي أسعار أصناف: مستخدم شركةٍ بلا صلاحية الأصناف (ومفتاحه) لا يقرؤها كما لا يقرأ /products — والمندوب يمرّ بالحارس نفسه
 * (requireAdminPermission) ويقيّده نطاقه أدناه. وأسماء الأنواع (GET /) تبقى لكل مستخدم: نموذج العميل يحتاجها
 */
router.get('/prices', requireAdminPermission('canManageProducts'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    let lists = await prisma.priceList.findMany({ where: { tenantId: tid }, orderBy: LIST_ORDER, select: { id: true, name: true } });
    if (lists.length && req.user?.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findFirst({
        where: { id: req.user.id, tenantId: tid }, select: { canChangePriceList: true, defaultPriceListId: true },
      });
      if (rep?.canChangePriceList !== true) {
        // بلا «تبديل نوع السعر»: أنواع عملائه وحدها (بنطاق عزل العملاء) — لا يسعّر إلا بنوع العميل أصلاً — ونوعه الافتراضي
        // لعميلٍ بلا نوع (طلب المالك ٢ نوفمبر ٢٠٢٦) يكون في كاش جواله دون اتصال. لا أنواعه المسموحة: لا يبدّل إليها بلا الصلاحية
        // (403 PRICE_LIST_FORBIDDEN)، فلا قائمة جملةٍ كاملة في كاشه لا يسعّر بها
        const used = await prisma.customer.findMany({
          where: { tenantId: tid, priceListId: { not: null }, ...LIVE_CUSTOMER, ...(await customerScope(req, tid)) },
          distinct: ['priceListId'], select: { priceListId: true },
        });
        const mine = new Set<string | null>((used ?? []).map((c) => c.priceListId));
        if (rep?.defaultPriceListId) mine.add(rep.defaultPriceListId);
        lists = lists.filter((l) => mine.has(l.id));
      }
    }
    if (!lists.length) { res.json({ success: true, data: [] }); return; }
    const ids = lists.map((l) => l.id);
    const rows = await prisma.$queryRaw<Array<{ priceListId: string; productId: string; price: number; unit: string | null; baseConvertedAt: Date | null }>>`
      SELECT i."priceListId", i."productId", i.price, p.unit, p."baseConvertedAt"
      FROM price_list_items i JOIN products p ON p.id = i."productId"
      WHERE i."tenantId" = ${tid} AND p."tenantId" = ${tid} AND p."deletedAt" IS NULL AND i."priceListId" IN (${Prisma.join(ids)})`;
    const byList = new Map<string, Array<{ productId: string; price: number; unit: string | null; baseConvertedAt: Date | null }>>();
    for (const r of rows ?? []) {
      byList.set(r.priceListId, [...(byList.get(r.priceListId) ?? []),
        { productId: r.productId, price: Number(r.price), unit: r.unit ?? null, baseConvertedAt: r.baseConvertedAt ?? null }]);
    }
    res.json({ success: true, data: lists.map((l) => ({ id: l.id, name: l.name, items: byList.get(l.id) ?? [] })) });
  } catch (err) { next(err); }
});

// اسم زرّ السعر الأساسي (Product.basePrice) — null أو الفارغ يعيده «السعر الأساسي». قبل /:id وإلا التُقط معرّفاً
router.put('/base-label', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { label } = z.object({ label: nameSchema.nullable() }).parse(req.body);
    const stored = label == null || label.trim() === '' ? null : priceListName(label);
    if (label != null && label.trim() !== '' && stored == null) { refuse(res, 400, 'PRICE_LIST_NAME_INVALID'); return; }
    // كتابة واحدة على صفّ الشركة — count 0 = لا صفّ بعد ⇒ 409 بلا إنشاء (نمط companyBuyerRelax)
    const r = await prisma.companySettings.updateMany({ where: { tenantId: tid }, data: { basePriceLabel: stored } });
    if (r.count === 0) { res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: 'احفظ إعدادات الشركة أولاً' }); return; }
    res.json({ success: true, data: { basePriceLabel: stored } });
  } catch (err) { next(err); }
});

// نوعٌ جديد في آخر الترتيب
router.post('/', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ name: nameSchema }).parse(req.body);
    const name = priceListName(body.name);
    if (!name) { refuse(res, 400, 'PRICE_LIST_NAME_INVALID'); return; }
    const last = await prisma.priceList.findFirst({ where: { tenantId: tid }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const list = await prisma.priceList.create({
      data: { tenantId: tid, name, sortOrder: (last?.sortOrder ?? -1) + 1 },
      select: LIST_SELECT,
    });
    res.status(201).json({ success: true, data: { ...list, customersCount: 0 } });
  } catch (err) {
    if (isUniqueClash(err)) { refuse(res, 409, 'PRICE_LIST_NAME_TAKEN'); return; }
    next(err);
  }
});

// إعادة تسمية نوعٍ أو نقله في الترتيب — اسمه في ملفات العملاء والفواتير يتبعه (مرجعٌ لا لقطة اسم)
router.put('/:id', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ name: nameSchema.optional(), sortOrder: z.number().int().min(0).max(100_000).optional() }).parse(req.body);
    const exists = await prisma.priceList.findFirst({ where: { id: String(req.params.id), tenantId: tid }, select: { id: true } });
    if (!exists) { refuse(res, 404, 'PRICE_LIST_INVALID'); return; }
    const data: { name?: string; sortOrder?: number } = {};
    if (body.name !== undefined) {
      const name = priceListName(body.name);
      if (!name) { refuse(res, 400, 'PRICE_LIST_NAME_INVALID'); return; }
      data.name = name;
    }
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    const list = await prisma.priceList.update({ where: { id: exists.id }, data, select: LIST_SELECT });
    const counts = await customersCountOf(tid);
    res.json({ success: true, data: { ...list, customersCount: counts.get(list.id) ?? 0 } });
  } catch (err) {
    if (isUniqueClash(err)) { refuse(res, 409, 'PRICE_LIST_NAME_TAKEN'); return; }
    next(err);
  }
});

/**
 * حذف نوعٍ لا عملاء أحياء عليه — أسعاره تُحذف معه (Cascade). كلّه في معاملةٍ واحدة بعد قفل صفّ النوع (FOR UPDATE، كقفل حذف
 * الصنف): إسناد عميلٍ إليه يأخذ FOR KEY SHARE لمفتاحه الأجنبي فيتعارض مع القفل — إمّا التزم قبله فعُدَّ هنا (409)، وإمّا انتظر
 * ففشل مفتاحه بعد الحذف (400 PRICE_LIST_INVALID في routes/customers.ts)، ولا يسقط عميلٌ إلى السعر الأساسي بصمت (SetNull).
 * والمناديب كذلك: كتابة أنواع المندوب تقفل صفوف أنواعها FOR KEY SHARE في معاملتها (routes/salesReps.ts) فتُعدّ هنا أو تُردّ 400.
 * وختم الفواتير والعملاء المحذوفين يُفرَّغ هنا صراحةً بطابع تعديل: SetNull في القاعدة لا يحرّك updatedAt، فتبقى مزامنة
 * /api/v1/sync عند مكامِلٍ على معرّفٍ لا يُترجم (كـtouchInvoice في services/invoiceExpiry.ts)
 */
router.delete('/:id', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const refusal = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM price_lists WHERE id = ${id} AND "tenantId" = ${tid} FOR UPDATE`;
      if (!locked?.length) return { status: 404, code: 'PRICE_LIST_INVALID' as const };
      const customersCount = await tx.customer.count({ where: { tenantId: tid, priceListId: id, ...LIVE_CUSTOMER } });
      // ومناديب هو افتراضيّهم أو ضمن أنواعهم المسموحة (أنواع الأسعار على مستوى المندوب): الحذف يُسقط افتراضيّهم إلى الأساس
      // بصمت (SetNull) ويترك في allowedPriceTypes معرّفاً ميتاً. وكتابة المندوب تقفل الصفّ نفسه FOR KEY SHARE (routes/salesReps.ts)
      const repsCount = await tx.salesRep.count({ where: { tenantId: tid, ...repsOnList(id) } });
      if (customersCount > 0 || repsCount > 0) {
        const message = PRICE_LIST_IN_USE_BY[customersCount > 0 ? (repsCount > 0 ? 'both' : 'customers') : 'reps'];
        return { status: 409, code: 'PRICE_LIST_IN_USE' as const, customersCount, repsCount, message };
      }
      const unstamp = { priceListId: null, updatedAt: new Date() };
      await tx.invoice.updateMany({ where: { tenantId: tid, priceListId: id }, data: unstamp });
      await tx.customer.updateMany({ where: { tenantId: tid, priceListId: id }, data: unstamp });
      await tx.priceList.deleteMany({ where: { id, tenantId: tid } });
      return null;
    }, { maxWait: 10_000, timeout: 30_000 }); // نوعٌ على آلاف الفواتير: تفريغها عبارةٌ واحدة قد تتجاوز مهلة الخمس ثوانٍ
    if (refusal) {
      const { status, code, ...extra } = refusal;
      refuse(res, status, code, extra);
      return;
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
