// ============================================================================
// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات.
// الرصيد محسوبٌ: الوارد + تسويات المستودع + العائد من السيارات − المحمّل لها.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { computeWarehouseStock, tenantCurrencyDecimals, loadWarehouseInputs, composeWarehouse, summarizeVansStock, resolveLineUnits } from '../services/warehouseStock';
import { unitFields } from '../services/units';
import type { VanLayer } from '../services/warehouseCost';
import { foldStock, bucketRemaining, type LoadRow, type InvRow } from './vanStock';
import { adminRepFilter } from '../services/adminScope';
import { addDays, isLocalDate } from '../services/gl/dates';
import { importedEntryInstant } from '../services/importTimezoneRebase';
import { importTimezone } from '../services/importLedger';

/**
 * «المخزون في تاريخ» (طلب المالك ١٨ أكتوبر ٢٠٢٦): لحظة نهاية اليوم المطلوب (بداية اليوم التالي، حصرية) بتوقيت الشركة،
 * فلا تنزاح حركة الحادية عشرة ليلاً إلى اليوم التالي على خادم UTC. والتوقيت `importTimezone` (توقيت الدفاتر وإلا الرياض)
 * لا `explicitTimezone`: هذه لحظاتٌ حيّة كُتبت بـnow() لا قيودٌ مستوردة بمنتصف ليل UTC — وشركةٌ بلا إعدادات دفاتر (أغلب
 * الشركات) كان يومها ينتهي الثالثة فجراً بتوقيتها فيدخل تحميل الفجر في رصيد الأمس.
 * بلا تاريخ صالح (YYYY-MM-DD) ⇒ undefined: الرصيد الحالي كما كان.
 */
export async function warehouseAsOf(tid: string, asOf: unknown): Promise<Date | undefined> {
  if (!isLocalDate(asOf)) return undefined;
  const gl = await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true, timezone: true, setupDraft: true } });
  return importedEntryInstant(addDays(asOf, 1), importTimezone(gl));
}
import { netUnitCost, entryTotalCost, lineCost } from '../services/warehouseCost';

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

// حارس التفعيل: عَلَمان في استعلام واحد. «النظام المحاسبي» يعلو لأنّه يعزل الوحدة
// كلّها، وافتراضه true فلا يمنع إلا حين يكون false صريحاً — بعكس warehouseEnabled
// المطفأ افتراضياً والذي لا يمرّ إلا بتفعيلٍ صريح.
router.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { warehouseEnabled: true, accountingEnabled: true } });
    if (t?.accountingEnabled === false) { res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' }); return; }
    if (!t?.warehouseEnabled) { res.status(403).json({ success: false, message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' }); return; }
    next();
  } catch (err) { next(err); }
});

// رصيد مخزون الشركة لكل منتج (مع تفصيل الوارد/الخارج للسيارات/العائد)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // خانات عملة الشركة تُقرأ **مرّة واحدة** لهذا الطلب ثم تمرّ إلى التقييم كلّه:
    // شركةٌ بالدينار كانت ترى قيمة كل صنفٍ مقرَّبةً إلى خانتين (٠٫٣٧ بدل ٠٫٣٧١).
    const [dec, before] = await Promise.all([tenantCurrencyDecimals(tid), warehouseAsOf(tid, req.query.asOf)]);
    res.json({ success: true, data: await computeWarehouseStock(tid, dec, before) });
  } catch (err) { next(err); }
});

/**
 * ما في مخزون السيارات الآن وقيمته بتكلفة الشراء (طلب المالك ١٨ أكتوبر ٢٠٢٦) — بطاقةٌ بجانب قيمة المستودع.
 * الرصيد بطيّ حركات كل سيارة كمسار مخزون السيارات (foldStock)، والقيمة بكلفة خروجه من المستودع (summarizeVansStock).
 * سيارات نطاق المستخدم وحدها (المشرف مناديب فرقه). استعلاماتٌ مجمَّعة للشركة لا حلقة استعلامٍ لكل مندوب.
 */
router.get('/vans', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // ما في السيارات في تاريخٍ مضى: حركاتها وفواتيرها قبل نهاية يومه وحدها (فواتير السيارة بتاريخها كصفحة مخزون السيارات)
    const before = await warehouseAsOf(tid, req.query.asOf);
    const repFilter = await adminRepFilter(req);
    const [dec, inputs, reps] = await Promise.all([
      tenantCurrencyDecimals(tid),
      loadWarehouseInputs(tid, { includeInactive: true, before }),
      prisma.salesRep.findMany({ where: { tenantId: tid, ...repFilter }, select: { id: true } }),
    ]);
    const repIds = reps.map((r) => r.id);
    // بنود الفواتير بلقطة وحدتها (foldStock يطوي بالأساس منها)؛ وحركات السيارات من loadWarehouseInputs بالأساس سلفاً
    const invItems = repIds.length ? await prisma.invoiceItem.findMany({
      where: { invoice: { tenantId: tid, status: 'CONFIRMED', salesRepId: { in: repIds }, ...(before && { invoiceDate: { lt: before } }) } },
      select: {
        productId: true, qty: true, unitFactor: true, baseQty: true, returnExpired: true,
        invoice: { select: { salesRepId: true, type: true, returnToStock: true, invoiceDate: true, returnReason: true, createdAt: true } },
      },
    }) : [];

    const layers = new Map<string, Map<string, VanLayer[]>>();
    const rows = composeWarehouse(inputs.products, inputs.whItems, inputs.vanItems, dec, layers);
    const avgCost = new Map(rows.map((r) => [r.productId, r.avgCost]));

    const repSet = new Set(repIds);
    const loadsByRep = new Map<string, LoadRow[]>();
    for (const v of inputs.vanItems) {
      if (!v.salesRepId || !repSet.has(v.salesRepId)) continue;
      const list = loadsByRep.get(v.salesRepId) ?? [];
      list.push({ productId: v.productId, qty: v.qty, vanLoad: { type: v.type, createdAt: v.at } });
      loadsByRep.set(v.salesRepId, list);
    }
    const invByRep = new Map<string, InvRow[]>();
    for (const it of invItems) {
      const rid = it.invoice.salesRepId;
      if (!rid) continue;
      const list = invByRep.get(rid) ?? [];
      list.push(it);
      invByRep.set(rid, list);
    }
    const perRep = repIds.map((repId) => {
      const { bal } = foldStock(loadsByRep.get(repId) ?? [], invByRep.get(repId) ?? []);
      return {
        repId,
        products: [...bal].map(([productId, b]) => ({
          productId,
          remaining: bucketRemaining(b),
          unsellable: Math.max(0, b.damagedIn - b.damagedOut) + Math.max(0, b.expiredIn - b.expiredOut),
        })),
      };
    });
    // سيارات المناديب المحذوفين: حذفُ المندوب يُبقي تحميلاته بمعرّفه المحفوظ (vanKeyOf) ويُفرغ مندوب فواتيره، فلا يُعرف ما بقي
    // في سيارته. تُعدّ صراحةً بدل أن تسقط بصمت — لغير المقيَّد وحده (المقيَّد لا يُعرف نطاقه في مندوبٍ لم يعد موجوداً)
    let deletedVans = 0;
    if (!Object.keys(repFilter).length) {
      const net = new Map<string, number>();
      for (const v of inputs.vanItems) {
        if (!v.salesRepId || repSet.has(v.salesRepId)) continue;
        const sign = v.type === 'LOAD' || v.type === 'ADJUST' ? 1 : v.type === 'UNLOAD' ? -1 : 0;
        if (sign) net.set(v.salesRepId, (net.get(v.salesRepId) ?? 0) + sign * v.qty);
      }
      deletedVans = [...net.values()].filter((q) => q > 1e-9).length;
    }
    res.json({ success: true, data: { ...summarizeVansStock(perRep, layers, avgCost, dec), deletedVans } });
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
    qty: z.number(), // بوحدة البند
    // وحدة البند (كرتون/حبة). غائبة ⇒ وحدة الأساس بمعامل ١: عميلٌ قديم أو مفتاح API يرسل الكمية بالأساس كما كان
    unitId: z.string().nullish(),
    // موجبٌ فقط: سعرٌ سالب لا معنى له، وصفرٌ يعني «بلا سعر» فيُرسَل غائباً.
    // تكلفة **وحدة البند** كما في فاتورة المورّد (الكرتون) — والتقييم يقسمها على المعامل عند القراءة (unitCostPerBase)
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
    // لقطة وحدة كل بند بترتيب `items` — يحلّها الخادم من وحدات الصنف (بلا unitId ⇒ الأساس، ولا استعلام)
    const units = await resolveLineUnits(tid, items);

    const by = req.user as { name?: string } | undefined;
    const entry = await prisma.warehouseEntry.create({
      data: {
        tenantId: tid, type: data.type, note: data.note, supplier: data.supplier, createdBy: by?.name,
        items: {
          create: items.map((i, idx) => ({
            productId: i.productId,
            // الكمية بوحدة البند كما في فاتورة المورّد، ولقطة وحدتها، والكمية بالأساس للرصيد والتقييم
            ...unitFields(i.qty, units[idx]),
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
    // الخانات تُقرأ مرّة واحدة مع الحركات — لا داخل حلقة الأسطر أدناه
    const [dec, entries] = await Promise.all([
      tenantCurrencyDecimals(tid),
      prisma.warehouseEntry.findMany({
        where: { tenantId: tid },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { items: { include: { product: { select: { name: true, unit: true } } } } },
      }),
    ]);
    // الإجمالي يُحسب هنا بالدالّة المختبَرة لا في المتصفّح: حسابان لرقمٍ واحد
    // ينزاحان يوماً — وقاعدة التقريب (جمعُ أسطرٍ مقرَّبة) تعيش في مكان واحد.
    //
    // و**قيمة كل سطر** تُرسَل معه للسبب نفسه: إشعار الوارد المطبوع يعرض الأسطر
    // والإجمالي معاً على ورقةٍ تُوقَّع، فإن حسب المتصفّح الأسطر بقاعدته هو
    // وجاء الإجمالي من هنا، أمكن أن تقول الورقة «مجموع الأسطر ≠ الإجمالي».
    //
    // والقيمة **بوحدة السطر** (كمية الكراتين × تكلفة الكرتون)، والسطر يحمل لقطة وحدته (unitName/unitFactor)
    // وكميته بالأساس (baseQty) — فالإشعار يطبع «٥ كرتون» لا «٥ حبة».
    res.json({
      success: true,
      data: entries.map((e) => ({
        ...e,
        items: e.items.map((i) => ({ ...i, lineCost: lineCost(i.qty, i.unitCost, dec) })),
        totalCost: entryTotalCost(e.items, dec),
      })),
    });
  } catch (err) { next(err); }
});

export default router;
