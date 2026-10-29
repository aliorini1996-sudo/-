import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireAccounting, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta, roundDecimal } from '../utils/helpers';
import { canAccessCustomer } from '../services/customerScope';
import { applyProductVatGate } from './productsZatca';
import { RETURN_RULE_METRICS, RETURN_RULE_MODES, SHELF_LIFE_BASES, SHELF_LIFE_UNITS, returnRuleConfigProblem, shelfLifeProblem } from '../services/shelfLife';
import { MAX_UNIT_FACTOR, QTY_EPS, unitProblem, factorOf, type UnitDef } from '../services/units';

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

// حدود الشريحة **بوحدة الأساس** وسعرها لوحدة الأساس (DESIGN القاعدتان ٤ و٥). baseMinQty/baseMaxQty اختياريان:
// غيابهما ⇒ هما minQty/maxQty نفسيهما — فالواجهة القائمة التي ترسل minQty وحده تكتب العمودين معاً كما يلزم
const priceTierSchema = z.array(z.object({
  minQty: z.number().min(0),
  maxQty: z.number().optional(),
  baseMinQty: z.number().min(0).optional(),
  baseMaxQty: z.number().nullish(),
  price: z.number().min(0),
}));

// ═══ الوحدات المتعددة (DESIGN.md «عقد الـAPI») ═══

/** ترتيب وحدات الصنف في كل ردّ: ترتيب المدير ثم المعامل — والأولى هي وحدة البيع الافتراضية بعد التحويل */
const UNITS_ORDER = { orderBy: [{ sortOrder: 'asc' as const }, { factor: 'asc' as const }] };

/** سعر الوحدة: رقمٌ موجب، أو فارغ/null ⇒ يُشتقّ من سعر الأساس × المعامل (unitPriceOf) */
const unitPriceField = z.union([z.number(), z.literal(''), z.null()]).optional();

const unitCreateSchema = z.object({
  name: z.string(),
  factor: z.number(),
  price: unitPriceField,
  unitCode: z.string().max(16).nullish().or(z.literal('')),
  sortOrder: z.number().int().optional(),
});

const unitUpdateSchema = z.object({
  name: z.string().optional(),
  factor: z.number().optional(),
  price: unitPriceField,
  unitCode: z.string().max(16).nullish().or(z.literal('')),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const convertBaseSchema = z.object({
  newBaseName: z.string(),
  factor: z.number(),
  // اسم وحدة الأساس كما رآه من فتح نافذة التحويل — يمنع التحويل المزدوج (نقرتان أو مديران معاً)
  expectedBaseName: z.string(),
  basePrice: z.number().min(0).nullish(),
  // اختياري: رمز وحدة الأساس الجديدة الضريبي. غيابه ⇒ رمز الصنف كما هو؛ والرمز القديم يرثه الكرتون (الخطوة ٣)
  baseUnitCode: z.string().max(16).nullish().or(z.literal('')),
});

/** وحدة الأساس كوحدةٍ بمعامل ١ — تدخل «الأخريات» في unitProblem فلا تُكرَّر باسمها ولا بمعاملها */
const baseAsUnit = (unit: string): UnitDef => ({ name: unit, factor: 1 });

const priceOrNull = (p: number | '' | null | undefined): number | null => (p === '' || p == null ? null : p);

/** رفض بنيويّ للتحويل والوحدات — يُرمى داخل المعاملة فيُلغيها، ويُردّ برمزه ورسالته */
class UnitsRefusal extends Error {
  constructor(readonly status: number, message: string, readonly code = 'PRODUCT_UNITS_INVALID') { super(message); }
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === 'P2002';

/**
 * قفل صفّ الصنف داخل المعاملة ثم قراءته — كل كتابةٍ على وحدات الصنف تمرّ من هنا.
 *
 * لماذا القفل حتى لإضافة وحدة: التحويل يضرب معاملات الوحدات القائمة بـF، فوحدةٌ تُضاف بمعاملٍ محسوبٍ على الأساس
 * القديم وتلتزم بعد التحويل تُقرأ على الأساس الجديد — كرتونٌ صار حبّتين. والقفل يرتّب الكاتبَين فيرى الثاني ما التزمه الأوّل.
 */
async function lockProduct(tx: Prisma.TransactionClient, tid: string, productId: string) {
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} AND "tenantId" = ${tid} FOR UPDATE`;
  return tx.product.findFirst({
    where: { id: productId, tenantId: tid },
    select: {
      id: true, unit: true, basePrice: true, unitCode: true,
      units: { select: { id: true, name: true, factor: true, price: true, unitCode: true, isActive: true, sortOrder: true } },
    },
  });
}

/** وحدات الصنف بلا طابع تعديل في الصنف — فتغييرها تغييرٌ للصنف تراه مزامنة ERP و/api/v1/sync (كالشرائح) */
const touchProduct = (tx: Prisma.TransactionClient, tid: string, productId: string) =>
  tx.product.updateMany({ where: { id: productId, tenantId: tid }, data: { updatedAt: new Date() } });

/**
 * سبب رفض تحويل وحدة الأساس، أو null — صرفةٌ على صفّ الصنف المقفل.
 *
 * المعامل صحيحٌ ≥ ٢: الأساس الجديد أصغر من القديم (كرتون ⇒ حبة)، والمعامل ١ تحويلٌ بلا معنى، والكسر نقضٌ للمبدأ.
 * ووحدات الصنف القائمة تُضرب بـF، فلا تتجاوز إحداها الحدّ بعده.
 */
export function baseConversionProblem(
  product: { unit: string; units: Array<{ name: string; factor: number }> },
  input: { newBaseName: string; factor: number },
): string | null {
  const f = Number(input.factor);
  if (!Number.isFinite(f) || Math.abs(f - Math.round(f)) > QTY_EPS || Math.round(f) < 2) {
    return 'معامل التحويل عدد صحيح أكبر من ١ — كم وحدة أساس جديدة في الوحدة الحالية';
  }
  const F = Math.round(f);
  if (F > MAX_UNIT_FACTOR) return `معامل التحويل لا يتجاوز ${MAX_UNIT_FACTOR}`;
  const name = String(input.newBaseName ?? '').trim();
  if (!name) return 'اسم وحدة الأساس الجديدة مطلوب';
  if (name.length > 24) return 'اسم الوحدة طويل';
  if (name === product.unit.trim()) return 'وحدة الأساس الجديدة هي الحالية نفسها';
  if (product.units.some((u) => u.name.trim() === name)) return 'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف';
  // الوحدة الحالية تصير وحدةً باسمها — فلا وحدةَ قائمة تحمل الاسم نفسه (قيد productId+name)
  if (product.units.some((u) => u.name.trim() === product.unit.trim())) return 'يوجد وحدة باسم وحدة الأساس الحالية لهذا الصنف';
  const over = product.units.find((u) => Number(u.factor) * F > MAX_UNIT_FACTOR);
  if (over) return `معامل وحدة «${over.name}» يتجاوز ${MAX_UNIT_FACTOR} بعد التحويل`;
  return null;
}

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
        // units: وحداته النشطة والموقوفة — الموقوفة لعرض مستندٍ صدر بها وإعادة رفعه، ولا تُعرض للبيع
        include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, units: UNITS_ORDER, teams: { select: { teamId: true } } },
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
      include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, units: UNITS_ORDER },
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
    const product = await prisma.product.create({ data: { ...data, ...vatGate.patch, barcode: data.barcode || null, shelfLifeFromDate: asDay(data.shelfLifeFromDate), categoryId: data.categoryId || null, image: data.image || null, itemCode: data.itemCode || null, unitCode: data.unitCode || null, tenantId: tid } as any, include: { category: true, units: UNITS_ORDER } });
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
        unit: true, units: { select: { name: true } },
      },
    });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    const data = productSchema.partial().parse(req.body);
    // اسم الأساس لا يأخذ اسم وحدةٍ أكبر للصنف نفسه: «٢ كرتون» تصير ملتبسة بين الأساس والكرتون
    if (data.unit !== undefined && data.unit.trim() !== exists.unit.trim() && exists.units.some((u) => u.name.trim() === data.unit!.trim())) {
      res.status(400).json({ success: false, message: 'اسم وحدة الأساس مستخدم لوحدة أخرى لهذا الصنف' }); return;
    }
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
      // الوحدات مع الردّ: الواجهة تستبدل صفّ الصنف بما يعود، فبلاها تختفي وحداته من الشاشة حتى إعادة التحميل
      include: { category: true, units: UNITS_ORDER },
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
    await prisma.$transaction(async (tx) => {
      // بقفل صفّ الصنف كالتحويل: شرائح بحدودٍ على الأساس القديم لا تلتزم بعد تحويله فتُقرأ على الجديد
      if (!(await lockProduct(tx, tid, req.params.id))) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      await tx.priceTier.deleteMany({ where: { productId: req.params.id } });
      // العمودان معاً (القاعدة ٥): الحدود بالأساس للحساب، والقديمان للعرض القائم. والكمية المرسلة بوحدة الأساس الحالية
      for (const t of tiers) {
        await tx.priceTier.create({
          data: {
            productId: req.params.id, minQty: t.minQty, maxQty: t.maxQty ?? null, price: t.price,
            baseMinQty: t.baseMinQty ?? t.minQty,
            baseMaxQty: t.baseMaxQty !== undefined ? t.baseMaxQty : (t.maxQty ?? null),
          },
        });
      }
      // الشرائح بلا طابع تعديل وتُضمَّن في الصنف — فتغييرها تغييرٌ للصنف تراه مزامنة ERP و/api/v1/sync
      await touchProduct(tx, tid, req.params.id);
    });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    next(err);
  }
});

// ═══ وحدات الصنف (DESIGN.md «عقد الـAPI») — الكتابة للإدارة بصلاحية الأصناف كبقيّة كتابات الصنف ═══

router.post('/:id/units', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = unitCreateSchema.parse(req.body);
    const unit = await prisma.$transaction(async (tx) => {
      const product = await lockProduct(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      // الأساس بين «الأخريات»: لا وحدة باسمه، ولا وحدة بمعامل ١ (هي الأساس نفسه)
      const problem = unitProblem(data, [baseAsUnit(product.unit), ...product.units]);
      if (problem) throw new UnitsRefusal(400, problem);
      const created = await tx.productUnit.create({
        data: {
          tenantId: tid, productId: product.id, name: data.name.trim(),
          // المعامل صحيحٌ تحقّق منه unitProblem — يُخزَّن مقرَّباً فلا يحمل غبار العائمة إلى كل لقطة
          factor: Math.round(Number(data.factor)),
          price: priceOrNull(data.price), unitCode: data.unitCode || null, sortOrder: data.sortOrder ?? 0,
        },
      });
      await touchProduct(tx, tid, product.id);
      return created;
    });
    res.status(201).json({ success: true, data: unit });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, message: 'اسم الوحدة مكرر لهذا الصنف' }); return; }
    next(err);
  }
});

/**
 * تعديل وحدة: اسمها ومعاملها وسعرها ورمزها وإيقافها وترتيبها.
 *
 * تغيير المعامل لا يمسّ ما مضى: كل صفٍّ كُتب بالوحدة يحمل لقطة معامله (unitFields)، فكرتونٌ صار ١٢ بعد أن كان ٢٤
 * لا يُنقص مخزون شهرٍ مضى. والإيقاف يحجبها عن البيع الجديد ولا يُسقط مستنداً أوف-لاين صدر بها (القاعدة ٧).
 */
router.put('/:id/units/:unitId', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = unitUpdateSchema.parse(req.body);
    const unit = await prisma.$transaction(async (tx) => {
      const product = await lockProduct(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      const current = product.units.find((u) => u.id === req.params.unitId);
      if (!current) throw new UnitsRefusal(404, 'الوحدة غير موجودة', 'UNIT_NOT_FOUND');
      const merged = {
        name: data.name ?? current.name,
        factor: data.factor ?? current.factor,
        price: data.price !== undefined ? data.price : current.price,
      };
      const problem = unitProblem(merged, [baseAsUnit(product.unit), ...product.units.filter((u) => u.id !== current.id)]);
      if (problem) throw new UnitsRefusal(400, problem);
      await tx.productUnit.updateMany({
        where: { id: current.id, productId: product.id, tenantId: tid },
        data: {
          ...(data.name !== undefined && { name: data.name.trim() }),
          ...(data.factor !== undefined && { factor: Math.round(Number(data.factor)) }),
          ...(data.price !== undefined && { price: priceOrNull(data.price) }),
          ...(data.unitCode !== undefined && { unitCode: data.unitCode || null }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        },
      });
      await touchProduct(tx, tid, product.id);
      return tx.productUnit.findFirst({ where: { id: current.id, productId: product.id, tenantId: tid } });
    });
    res.json({ success: true, data: unit });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, message: 'اسم الوحدة مكرر لهذا الصنف' }); return; }
    next(err);
  }
});

/** حذفٌ فعليّ: الصفوف تحمل لقطة وحدتها (الاسم والمعامل) فلا ينكسر مستندٌ ولا مخزونٌ مضى، وإعادة الرفع تتحقّق من التاريخ */
router.delete('/:id/units/:unitId', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    await prisma.$transaction(async (tx) => {
      const product = await lockProduct(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      const gone = await tx.productUnit.deleteMany({ where: { id: req.params.unitId, productId: product.id, tenantId: tid } });
      if (gone.count === 0) throw new UnitsRefusal(404, 'الوحدة غير موجودة', 'UNIT_NOT_FOUND');
      await touchProduct(tx, tid, product.id);
    });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    next(err);
  }
});

/**
 * تحويل وحدة الأساس إلى أصغر منها (كرتون ⇒ حبة، F = ٢٤) لصنفٍ له تاريخ — DESIGN.md «عقد الـAPI» بخطواته الخمس.
 *
 * ═══ لماذا لا يكفي تعديل اسم الوحدة ═══
 * كل صفٍّ قديم كُتب بالكرتون يحمل `unitFactor = 1` (الكرتون كان الأساس). لو صار الأساس «حبة» بتعديل الاسم لقُرئت
 * مبيعات سنةٍ وتحميلاتها ومخزون السيارات حبّاتٍ لا كراتين: خطأ ٢٤ ضعفاً في كل رصيدٍ وتقرير. فالتحويل يعيد كتابة
 * **اللقطة** لا الكمية: كل صفٍّ يأخذ اسم وحدته القديمة ومعاملها مضروباً بـF، فيبقى «٢ كرتون» مطبوعاً كما هو ويصير
 * أساسه ٤٨ حبة. والأسعار المخزَّنة لوحدة الأساس (سعر العميل والشرائح) تُقسم على F فيبقى سعر الكرتون للعميل كما هو.
 *
 * ═══ لماذا معاملةٌ واحدة بقفل صفّ الصنف ═══
 * خطوةٌ تلتزم وأخرى تفشل = تاريخٌ نصفه بأساسٍ ونصفه بآخر، ولا سبيل لمعرفة أيّ الصفوف حُوّل. والقفل يمنع تحويلين
 * متزامنين (ومعه `expectedBaseName`: نقرةٌ ثانية بعد التزام الأولى تُردّ 409 لا تضرب بـF مرّتين)، ويرتّبه مع إصدار
 * الفواتير الذي يقفل صفوف أصنافه قفلاً مشتركاً (routes/invoices.ts).
 */
router.post('/:id/convert-base', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = convertBaseSchema.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const product = await lockProduct(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      // ١. التحويل المزدوج: ما رآه الطالب ليس الأساس الآن ⇒ حُوّل قبله (أو عُدّل) — لا يُضرب بـF ثانيةً
      if (product.unit !== body.expectedBaseName) {
        throw new UnitsRefusal(409, `وحدة الأساس الآن «${product.unit}» — تغيّرت منذ فتحت التحويل، أعد فتح الصنف`, 'BASE_UNIT_CHANGED');
      }
      const problem = baseConversionProblem(product, body);
      if (problem) throw new UnitsRefusal(400, problem);
      const F = Math.round(body.factor);
      const oldUnit = product.unit;
      const pid = product.id;

      /* ٢. لقطات الصفوف في الجداول الأربعة: الاسم القديم لما لا اسم له، والمعامل × F، والأساس من جديد.
       * qty وunitPrice وunitCost وlineTotal لا تُمسّ — هي بوحدة الصفّ وما زالت الكرتون. والمعامل التالف (≤٠) يُقرأ ١
       * كما يقرؤه factorOf، فيصير F لا صفراً. والمُطلِق (scripts/backfillBaseQty.ts) يحسب baseQty أيضاً؛ القيمة الصريحة
       * هنا لبيئةٍ لم يُركَّب فيها بعد. والشركة شرطٌ في كل جملة عبر رأس المستند — لا يكفي معرّف الصنف وحده.
       * وبند الفاتورة يحمل رمز وحدته الضريبي أيضاً (القاعدة ١٠): البند القديم بلا رمز كان يُقرأ برمز الصنف، فيأخذه لقطةً
       * قبل أن يتغيّر رمز الصنف إلى رمز الأساس الجديد (baseUnitCode) — وإلّا خرج إشعارٌ دائن على كرتونٍ قديم برمز الحبة.
       * ورمزٌ فارغٌ على الصنف يبقى البند فارغاً كما كان (COALESCE مع null). */
      const invoiceItems = await tx.$executeRaw`
        UPDATE "invoice_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "unitCode" = COALESCE(r."unitCode", ${product.unitCode || null}::text)
        FROM "invoices" AS d
        WHERE r."invoiceId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;
      /* وبند التحميل يحمل كميّتين **بالأساس دائماً** (قرار التنفيذ): الاقتراح والتنبّؤ — بلا ضربهما بـF يُقاس تنبّؤ «٥ كرتون»
       * على مبيعٍ صار ١٢٠ حبّة فتنقلب دقّة الاقتراح كلّها لأشهرٍ مضت. والفارغ يبقى فارغاً (null × F = null) */
      const vanLoadItems = await tx.$executeRaw`
        UPDATE "van_load_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "suggestedQty" = r."suggestedQty" * ${F}::float8,
          "expectedQty" = r."expectedQty" * ${F}::float8
        FROM "van_loads" AS d
        WHERE r."vanLoadId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;
      const warehouseEntryItems = await tx.$executeRaw`
        UPDATE "warehouse_entry_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8
        FROM "warehouse_entries" AS d
        WHERE r."entryId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;
      const stockRequestItems = await tx.$executeRaw`
        UPDATE "rep_stock_request_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8
        FROM "rep_stock_requests" AS d
        WHERE r."requestId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;

      /* ٣. الوحدات القائمة تُضرب بـF (طبليةٌ = ٥٠ كرتون ⇒ ١٢٠٠ حبة) وتتأخّر رتبةً، والوحدة القديمة تصير وحدةً بمعامل F
       * **بسعرها القديم** ورمزها الضريبي، وأولى في الترتيب: هي ما يبيعه المندوب كل يوم، فلا يتغيّر عمله بعد التحويل.
       *
       * وقبل الضرب: الوحداتُ المشتقّةُ سعرَها (price = null، كالطبلية) تُجمَّد على سعرها المشتقّ الآن
       * (سعر الأساس القديم × معاملها). وإلّا فبعد التحويل يُشتقّ سعرها من الأساس الجديد المقرَّب لأربع منازل ×
       * المعامل المضروب، فيزحّ سعرها هللاتٍ بلا أن يطلب أحدٌ ذلك. التجميد يبقيه كما كان حرفاً. */
      const derived = await tx.productUnit.findMany({ where: { productId: pid, tenantId: tid, price: null }, select: { id: true, factor: true } });
      for (const u of derived) {
        await tx.productUnit.update({ where: { id: u.id }, data: { price: roundDecimal(Number(product.basePrice) * factorOf({ unitFactor: u.factor }), 2) } });
      }
      await tx.productUnit.updateMany({
        where: { productId: pid, tenantId: tid },
        data: { factor: { multiply: F }, sortOrder: { increment: 1 } },
      });
      await tx.productUnit.create({
        data: {
          tenantId: tid, productId: pid, name: oldUnit, factor: F, price: Number(product.basePrice),
          unitCode: product.unitCode || null, isActive: true, sortOrder: 0,
        },
      });

      // ٤. الأسعار المخزَّنة لوحدة الأساس تصير للحبة: ÷ F — بلا تقريب، فسعر العميل × ٢٤ يعود سعر كرتونه بالفلس.
      // وحدود الشرائح بالأساس × F؛ والشريحة التي لم يملأها الترحيل بعد (baseMinQty = 0 وminQty ≠ 0) تُحسب من القديم
      const customerPrices = await tx.customerPrice.updateMany({
        where: { productId: pid, product: { tenantId: tid } },
        data: { price: { divide: F } },
      });
      const priceTiers = await tx.$executeRaw`
        UPDATE "price_tiers" AS t SET
          "price" = t."price" / ${F}::float8,
          "baseMinQty" = (CASE WHEN t."baseMinQty" = 0 AND t."minQty" <> 0 THEN t."minQty" ELSE t."baseMinQty" END) * ${F}::float8,
          "baseMaxQty" = COALESCE(t."baseMaxQty", t."maxQty") * ${F}::float8
        FROM "products" AS p
        WHERE t."productId" = p.id AND p."tenantId" = ${tid} AND t."productId" = ${pid}`;

      // ٥. الأساس الجديد وسعره: المُرسَل، وإلّا القديم ÷ F بأربع منازل (سعر الكرتون محفوظٌ على وحدته في الخطوة ٣)
      await tx.product.updateMany({
        where: { id: pid, tenantId: tid },
        data: {
          unit: body.newBaseName.trim(),
          basePrice: body.basePrice ?? roundDecimal(Number(product.basePrice) / F, 4),
          ...(body.baseUnitCode !== undefined && { unitCode: body.baseUnitCode || null }),
        },
      });
      const data = await tx.product.findFirst({
        where: { id: pid, tenantId: tid },
        include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, units: UNITS_ORDER },
      });
      return {
        data,
        converted: { factor: F, from: oldUnit, invoiceItems, vanLoadItems, warehouseEntryItems, stockRequestItems, customerPrices: customerPrices.count, priceTiers },
      };
    }, { maxWait: 10_000, timeout: 120_000 }); // صنفٌ بتاريخ سنوات: آلاف الصفوف بالمُطلِق على قاعدةٍ صغيرة
    res.json({ success: true, data: result.data, converted: result.converted });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, message: 'يوجد وحدة باسم وحدة الأساس الحالية لهذا الصنف' }); return; }
    next(err);
  }
});

export default router;

