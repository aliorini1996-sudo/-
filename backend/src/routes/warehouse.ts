// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// الرصيد محسوبٌ: الوارد + تسويات المستودع + العائد من السيارات − المحمّل لها.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { computeWarehouseStock } from '../services/warehouseStock';
import { netUnitCost, entryTotalCost } from '../services/warehouseCost';

const router = Router();
router.use(authenticate);

/**
 * المستودع للوحة الشركة وحدها — لا للمندوب.
 *
 * `requireAdminPermission` يمرّر `SALES_REP` بلا فحص (middleware/auth.ts)، وهو
 * مقصودٌ في المسارات التي يشترك فيها التطبيقان. لكنّ هذا المسار صار يحمل
 * **تكلفة الشراء وقيمة المخزون**، أي هامش ربح الشركة على كل صنف — ولا شيء في
 * تطبيق المندوب يستدعيه أصلاً. فالمنع صريحٌ هنا لا متروكٌ لعمومية الحارس.
 */
router.use((req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role === 'SALES_REP') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
});

// نفس صلاحية إدارة المخزون؛ المستودع مركزيّ على مستوى الشركة (لا يخصّ مندوباً)
router.use(requireAdminPermission('canManageVanStock'));

// حارس التفعيل: الميزة مطفأة افتراضياً، يُفعّلها المالك لكل شركة على حدة (طرح مدروس)
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { warehouseEnabled: true } });
    if (!t?.warehouseEnabled) { res.status(403).json({ success: false, message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' }); return; }
    next();
  } catch (err) { next(err); }
});

// رصيد مخزون الشركة لكل منتج (مع تفصيل الوارد/الخارج للسيارات/العائد)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await computeWarehouseStock(tenantId(req)) });
  } catch (err) { next(err); }
});

const entrySchema = z.object({
  type: z.enum(['RECEIVE', 'ADJUST']).default('RECEIVE'),
  note: z.string().max(300).optional(),
  supplier: z.string().max(200).optional(),
  // هل الأسعار المكتوبة شاملةٌ للضريبة؟ يقرّره المستخدم بحسب فاتورة مورّده،
  // والخادم يردّها إلى صافيها — فالمخزَّن معنى واحد لا معنيان (انظر warehouseCost)
  costsIncludeTax: z.boolean().optional().default(false),
  items: z.array(z.object({
    productId: z.string(),
    qty: z.number(),
    // موجبٌ فقط: سعرٌ سالب لا معنى له، وصفرٌ يعني «بلا سعر» فيُرسَل غائباً
    unitCost: z.number().positive().finite().max(1e9).optional(),
  })).min(1),
});

// تسجيل وارد (استلام/شراء) أو تسوية للمستودع
router.post('/entries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = entrySchema.parse(req.body);
    const items = data.items.filter((i) => i.qty !== 0);
    if (!items.length) { res.status(400).json({ success: false, message: 'لا توجد كميات صالحة' }); return; }
    // الوارد موجبٌ دائماً؛ التنقيص يكون تسويةً صريحة
    if (data.type === 'RECEIVE' && items.some((i) => i.qty < 0)) {
      res.status(400).json({ success: false, message: 'كمية الوارد يجب أن تكون موجبة استخدم تسوية للتنقيص' });
      return;
    }
    // التسوية جردٌ أو تالف لا شراء — فلا ثمن لها. والرفض الصريح أصدق من إسقاطٍ صامت
    if (data.type === 'ADJUST' && items.some((i) => i.unitCost != null)) {
      res.status(400).json({ success: false, message: 'سعر الوحدة يسجل مع الوارد فقط لا مع التسوية' });
      return;
    }

    const productIds = [...new Set(items.map((i) => i.productId))];
    // نقرأ الضريبة مع التحقّق: الردّ من الشامل إلى الصافي يحتاج نسبة كل صنف
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: tid },
      select: { id: true, taxPct: true },
    });
    if (products.length !== productIds.length) { res.status(400).json({ success: false, message: 'منتج غير صالح' }); return; }
    const taxOf = new Map(products.map((p) => [p.id, p.taxPct]));

    const by = req.user as { name?: string } | undefined;
    const entry = await prisma.warehouseEntry.create({
      data: {
        tenantId: tid, type: data.type, note: data.note, supplier: data.supplier, createdBy: by?.name,
        items: {
          create: items.map((i) => ({
            productId: i.productId,
            qty: i.qty,
            unitCost: i.unitCost == null
              ? null
              : netUnitCost(i.unitCost, taxOf.get(i.productId) ?? 0, data.costsIncludeTax),
          })),
        },
      },
      include: { items: { include: { product: { select: { id: true, name: true, unit: true } } } } },
    });
    res.status(201).json({ success: true, data: entry });
  } catch (err) { next(err); }
});

// سجلّ حركات المستودع (الوارد/التسوية) — للعرض والتصدير
router.get('/entries', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const entries = await prisma.warehouseEntry.findMany({
      where: { tenantId: tid },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { items: { include: { product: { select: { name: true, unit: true } } } } },
    });
    // الإجمالي يُحسب هنا بالدالّة المختبَرة لا في المتصفّح: حسابان لرقمٍ واحد
    // ينزاحان يوماً — وقاعدة التقريب (جمعُ أسطرٍ مقرَّبة) تعيش في مكان واحد
    res.json({
      success: true,
      data: entries.map((e) => ({ ...e, totalCost: entryTotalCost(e.items) })),
    });
  } catch (err) { next(err); }
});

export default router;
