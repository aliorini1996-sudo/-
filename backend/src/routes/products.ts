import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireAccounting, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';
import { canAccessCustomer } from '../services/customerScope';
import { applyProductVatGate } from './productsZatca';
import { RETURN_RULE_METRICS, RETURN_RULE_MODES, SHELF_LIFE_BASES, SHELF_LIFE_UNITS, returnRuleConfigProblem, shelfLifeProblem } from '../services/shelfLife';

const router = Router();
router.use(authenticate); // القراءة متاحة للمندوب (للبحث عند إصدار الفاتورة)؛ الكتابة للإدارة فقط
router.use(requireAccounting); // عزل «النظام المحاسبي»
router.use(requireAdminPermission('canManageProducts'));

const productSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  // nullish لا optional: نماذج RHF ترسل null للحقول الفارغة غير الملموسة،
  // وoptional() يرفض null فيفشل حفظ التعديل بلا سبب ظاهر (درس نموذج العملاء)
  barcode: z.string().nullish(),
  unit: z.string().min(1),
  basePrice: z.number().min(0),
  taxPct: z.number().min(0).max(100).nullish(), // يُورَث من ضريبة دولة الشركة عند الغياب
  image: z.string().nullish().or(z.literal('')), // صورة الصنف (base64 data URL)
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  damagedReturnToStock: z.boolean().optional(), // سياسة: هل يعود مرتجع هذا الصنف التالف للمخزون؟
  // صلاحية الصنف وأساس حسابها (البيع | الشراء بتاريخٍ يُكتب هنا | تحميل السيارة) — يُتحقَّق منها بعد الدمج مع المحفوظ
  shelfLifeEnabled: z.boolean().optional(),
  shelfLifeValue: z.number().int().positive().nullish(),
  shelfLifeUnit: z.enum(SHELF_LIFE_UNITS).nullish(),
  shelfLifeBasis: z.enum(SHELF_LIFE_BASES).optional(),
  shelfLifeFromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('')),
  // قيد المرتجع لصنف الصلاحية: قرب الانتهاء | ما زال صالحاً، بالأيام | بالنسبة — يُتحقَّق منه مدمجاً (returnRuleConfigProblem)
  returnRuleEnabled: z.boolean().optional(),
  returnRuleMode: z.enum(RETURN_RULE_MODES).nullish(),
  returnRuleMetric: z.enum(RETURN_RULE_METRICS).nullish(),
  returnRuleValue: z.number().int().positive().nullish(),
  categoryId: z.string().nullish(),
  // أكواد الفوترة الإلكترونية
  itemCode: z.string().nullish().or(z.literal('')),     // كود الصنف (EGS/GS1)
  itemCodeType: z.enum(['EGS', 'GS1']).nullish(),
  unitCode: z.string().nullish().or(z.literal('')),     // كود الوحدة حسب جدول المزوّد
});

const categorySchema = z.object({ name: z.string().min(1) });

/** تاريخ الشراء YYYY-MM-DD ⇒ تاريخٌ مجرّد (منتصف ليل UTC لعمود @db.Date)؛ والفارغ null */
const asDay = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00.000Z`) : null);

const priceTierSchema = z.array(z.object({
  minQty: z.number().min(0),
  maxQty: z.number().optional(),
  price: z.number().min(0),
}));

// أسعار عميل بعينها (صافية قبل الضريبة) — يحتاجها تطبيق المندوب ليعرض السعر المتفق
// عليه مع هذا العميل. بدونها كان يعرض basePrice الأعلى فيرفضه حارس الصلاحية في الخادم
// (سعر العميل هو السقف المرجعي) ⇒ «لا تملك صلاحية تغيير سعر البيع» على كل مستند لهذا العميل.
// خفيفة عمداً (معرّف + سعر) لتُحمَّل وتُخزَّن في الكاش على الجوال بلا كلفة.
router.get('/customer-prices/:customerId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (!(await canAccessCustomer(req, tid, req.params.customerId))) {
      res.status(403).json({ success: false, message: 'هذا العميل غير مسند لك' });
      return;
    }
    const prices = await prisma.customerPrice.findMany({
      where: { customerId: req.params.customerId, product: { tenantId: tid, deletedAt: null } },
      select: { productId: true, price: true },
    });
    res.json({ success: true, data: prices });
  } catch (err) { next(err); }
});

router.get('/categories', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const cats = await prisma.productCategory.findMany({ where: { tenantId: tid }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: cats });
  } catch (err) { next(err); }
});

router.post('/categories', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = categorySchema.parse(req.body);
    const cat = await prisma.productCategory.create({ data: { ...data, tenantId: tid } as any });
    res.status(201).json({ success: true, data: cat });
  } catch (err) { next(err); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const search = req.query.search as string | undefined;
    const categoryId = req.query.categoryId as string | undefined;
    const status = req.query.status as string | undefined;

    const where = {
      tenantId: tid,
      deletedAt: null, // المؤرشف محذوف من كل القوائم — صفه باق لأسماء الفواتير القديمة
      ...(search && {
        OR: [
          { name: { contains: search } },
          { code: { contains: search } },
          { barcode: { contains: search } },
        ],
      }),
      ...(categoryId && { categoryId }),
      ...(status && { status: status as 'ACTIVE' | 'INACTIVE' }),
    };

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        // teams: فرق الصنف («الفرق») — تطبيق المندوب يصفّي بها أصناف فريقه الحالي + العامة
        include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, teams: { select: { teamId: true } } },
        ...paginate(page, limit),
        orderBy: { name: 'asc' },
      }),
    ]);

    res.json({ success: true, data: products, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } } },
    });
    if (!product) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

/**
 * التصنيف من الشركة نفسها — أو لا تصنيف. بلا هذا يُربط صنفٌ بتصنيف شركةٍ أخرى (المفتاح الأجنبيّ لا يعرف
 * الشركة) فيُقرأ اسمه مع الصنف، أو يفشل معرّفٌ مجهول بخطأ 500 بدل 400.
 */
async function categoryOwned(tid: string, categoryId: string | null | undefined): Promise<boolean> {
  if (!categoryId) return true;
  return (await prisma.productCategory.count({ where: { id: categoryId, tenantId: tid } })) > 0;
}

router.post('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = productSchema.parse(req.body);
    // كود مكرر يفسر بوضوح (خاصة تصادم كود صنف مؤرشف) بدل خطأ unique غامض
    const dupe = await prisma.product.findFirst({ where: { tenantId: tid, code: data.code }, select: { deletedAt: true } });
    if (dupe) {
      res.status(409).json({ success: false, message: dupe.deletedAt ? 'الكود مستخدم بصنف محذوف مؤرشف بفواتيره القديمة استخدم كودا مختلفا' : 'كود الصنف مستخدم من قبل' });
      return;
    }
    const lifeProblem = shelfLifeProblem(data) ?? returnRuleConfigProblem(data);
    if (lifeProblem) { res.status(400).json({ success: false, message: lifeProblem }); return; }
    if (data.taxPct == null) { // وراثة ضريبة دولة الشركة عند عدم تحديدها
      const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
      data.taxPct = company?.defaultVatPct ?? 15;
    }
    // فوترة ZATCA (Z5.1a): الفئة الضريبية للشركة الجامعة وحدها — لا تُقرأ البوابة إلا إن حمل الجسم حقلاً منها
    const vatGate = await applyProductVatGate(prisma, req.body, tid, { productId: null, taxPct: data.taxPct });
    if (!vatGate.ok) { res.status(vatGate.status).json(vatGate.body); return; }
    if (!(await categoryOwned(tid, data.categoryId))) { res.status(400).json({ success: false, message: 'التصنيف غير موجود' }); return; }
    const product = await prisma.product.create({ data: { ...data, ...vatGate.patch, barcode: data.barcode || null, shelfLifeFromDate: asDay(data.shelfLifeFromDate), categoryId: data.categoryId || null, image: data.image || null, itemCode: data.itemCode || null, unitCode: data.unitCode || null, tenantId: tid } as any, include: { category: true } });
    res.status(201).json({ success: true, data: product });
  } catch (err) { next(err); }
});

router.put('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.product.findFirst({
      where: { id: req.params.id, tenantId: tid },
      select: {
        id: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true, shelfLifeBasis: true, shelfLifeFromDate: true,
        returnRuleEnabled: true, returnRuleMode: true, returnRuleMetric: true, returnRuleValue: true,
      },
    });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    const data = productSchema.partial().parse(req.body);
    // الصلاحية تُفحص مدمجةً مع المحفوظ: تفعيلها وحده يلزمه مدةٌ محفوظة من قبل أو مرسلة معه
    const merged = {
      shelfLifeEnabled: data.shelfLifeEnabled ?? exists.shelfLifeEnabled,
      shelfLifeValue: data.shelfLifeValue !== undefined ? data.shelfLifeValue : exists.shelfLifeValue,
      shelfLifeUnit: data.shelfLifeUnit !== undefined ? data.shelfLifeUnit : exists.shelfLifeUnit,
      shelfLifeBasis: data.shelfLifeBasis ?? exists.shelfLifeBasis,
      shelfLifeFromDate: data.shelfLifeFromDate !== undefined ? (data.shelfLifeFromDate || null) : exists.shelfLifeFromDate,
      returnRuleEnabled: data.returnRuleEnabled ?? exists.returnRuleEnabled,
      returnRuleMode: data.returnRuleMode !== undefined ? data.returnRuleMode : exists.returnRuleMode,
      returnRuleMetric: data.returnRuleMetric !== undefined ? data.returnRuleMetric : exists.returnRuleMetric,
      returnRuleValue: data.returnRuleValue !== undefined ? data.returnRuleValue : exists.returnRuleValue,
    };
    const lifeProblem = shelfLifeProblem(merged) ?? returnRuleConfigProblem(merged);
    if (lifeProblem) { res.status(400).json({ success: false, message: lifeProblem }); return; }
    const updateData: Record<string, unknown> = { ...data };
    if ('barcode' in updateData) updateData.barcode = updateData.barcode || null;
    // taxPct الفارغ (حقل مُسح او null من النموذج) يعني «بلا تغيير» لا تصفير النسبة
    if (updateData.taxPct == null) delete updateData.taxPct;
    if ('categoryId' in updateData) updateData.categoryId = updateData.categoryId || null;
    if (!(await categoryOwned(tid, updateData.categoryId as string | null | undefined))) { res.status(400).json({ success: false, message: 'التصنيف غير موجود' }); return; }
    if ('image' in updateData) updateData.image = updateData.image || null;
    if ('itemCode' in updateData) updateData.itemCode = updateData.itemCode || null;
    if ('unitCode' in updateData) updateData.unitCode = updateData.unitCode || null;
    if ('shelfLifeFromDate' in updateData) updateData.shelfLifeFromDate = asDay(data.shelfLifeFromDate);
    // فوترة ZATCA (Z5.1a): الفئة الضريبية للشركة الجامعة وحدها — على الحالة المدمجة مع المحفوظ والنسبة التي ستُحفظ
    const vatGate = await applyProductVatGate(prisma, req.body, tid, { productId: req.params.id, taxPct: updateData.taxPct as number | undefined });
    if (!vatGate.ok) { res.status(vatGate.status).json(vatGate.body); return; }
    Object.assign(updateData, vatGate.patch);
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: updateData,
      include: { category: true },
    });
    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!product) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }

    // صنف له أثر مالي/مخزني يؤرشف لا يمحى: يختفي من كل القوائم ولا يباع مجددا،
    // ويبقى صفه باسمه حيا فتعرضه الفواتير والسندات والكشوف القديمة وتقارير
    // المبيعات حسب الصنف كما كانت حرفيا
    const [invoiceItems, loadItems, warehouseItems] = await Promise.all([
      prisma.invoiceItem.count({ where: { productId: req.params.id } }),
      prisma.vanLoadItem.count({ where: { productId: req.params.id } }),
      prisma.warehouseEntryItem.count({ where: { productId: req.params.id } }),
    ]);
    if (invoiceItems > 0 || loadItems > 0 || warehouseItems > 0) {
      await prisma.$transaction([
        prisma.priceTier.deleteMany({ where: { productId: req.params.id } }),
        prisma.customerPrice.deleteMany({ where: { productId: req.params.id } }),
        prisma.product.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), status: 'INACTIVE' } }),
      ]);
      res.json({ success: true, archived: true });
      return;
    }

    // بلا أي أثر: حذف فعلي مع بيانات التسعير التابعة، في معاملة واحدة
    await prisma.$transaction([
      prisma.priceTier.deleteMany({ where: { productId: req.params.id } }),
      prisma.customerPrice.deleteMany({ where: { productId: req.params.id } }),
      prisma.product.delete({ where: { id: req.params.id } }),
    ]);
    res.json({ success: true, archived: false });
  } catch (err) { next(err); }
});

router.put('/:id/price-tiers', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    const tiers = priceTierSchema.parse(req.body.tiers);
    await prisma.$transaction([
      prisma.priceTier.deleteMany({ where: { productId: req.params.id } }),
      ...tiers.map(t => prisma.priceTier.create({ data: { productId: req.params.id, ...t } as any })),
      // الشرائح بلا طابع تعديل وتُضمَّن في الصنف — فتغييرها تغييرٌ للصنف تراه مزامنة ERP و/api/v1/sync
      prisma.product.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } }),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;

