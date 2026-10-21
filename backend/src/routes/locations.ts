import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireLocations, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { adminRepFilter, adminScopeEnabled, canAccessRep, scopedRecordWhere, scopedRepRecordWhere, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { tenantTz } from '../services/invoiceExpiry';
import { paymentMethodsRange } from '../services/paymentMethodsReport';
import { LOCATION_NAME_MAX, buildLocationsSummary, locationName, locationPointProblem, type ProductInfo } from '../services/locations';

/**
 * «لوكيشن» (طلب المالك ٢١ أكتوبر ٢٠٢٦) — /api/locations: مواقع الشركة، وإسناد كل مندوبٍ لموقعٍ واحد، وملخّص الفواتير
 * والتحميلات لكل موقع في فترة. القرارات ومنطق الختم والملخّص في services/locations.ts.
 *
 * - **البوّابة:** مستخدم شركة (requireAdmin) + عَلَم الشركة والمحاسبة (requireLocations: ٤٠٣ LOCATIONS_NOT_ALLOWED /
 *   ACCOUNTING_NOT_ALLOWED) على الراوتر كلّه.
 * - **الصلاحيات كنظائرها:** تعريف المواقع (إنشاء/تعديل/أرشفة/حذف) بيانات شركةٍ عامة ⇒ «إعدادات الشركة» ومن غير مقيَّد
 *   النطاق (كإدارة الفرق: المقيَّد لا يعيد رسم ما يراه غيره). إسناد مندوب ⇒ «المناديب» ومندوبٌ في نطاقه (canAccessRep —
 *   404 لا 403 كي لا يُكشف وجوده). الملخّص ⇒ «التقارير» بنطاق المستندات كبقيّة التقارير. وقائمة المواقع لأيّ مستخدم شركة:
 *   فلتر «الموقع» في الفواتير ومخزون السيارات يحتاجها.
 * - **الموقع ذو المستندات لا يُحذف بل يُؤرشف**، والموقع الذي فيه مناديب لا يُؤرشف ولا يُحذف حتى يُنقلوا — فلا يُختم
 *   مستندٌ جديد بموقعٍ مؤرشف، ولا يسقط ختمٌ قديم من تقاريره بصمت.
 */
const router = Router();
router.use(authenticate, requireAdmin, requireLocations);

/** تعريف المواقع: صلاحية إعدادات الشركة، وغير مقيَّد النطاق (جلسة المالك تمرّ) */
const managePerm = requireAdminPermission('canManageCompanySettings');
async function guardManage(req: AuthRequest, res: Response): Promise<boolean> {
  if (await adminScopeEnabled(req)) {
    res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد إدارة المواقع تحتاج صلاحية غير مقيدة' });
    return false;
  }
  return true;
}

const LOCATION_SELECT = { id: true, name: true, lat: true, lng: true, isActive: true, createdAt: true, updatedAt: true } as const;

const nameSchema = z.string().trim().min(1, 'اكتب اسم الموقع').max(LOCATION_NAME_MAX * 2);
// الإحداثيات: رقمٌ أو null صريحة (مسح النقطة)؛ التحقّق من الزوج والمدى في locationPointProblem
const coordSchema = z.number().finite().nullable();

const isUniqueClash = (e: unknown) => (e as { code?: string })?.code === 'P2002';
const nameTaken = (res: Response) => res.status(409).json({ success: false, code: 'LOCATION_NAME_TAKEN', message: 'يوجد موقع بهذا الاسم' });

// المواقع (الفعّال أولاً ثم بالاسم) — وعدد مناديب كلٍّ منها **في نطاق المستخدم**
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [locations, reps] = await Promise.all([
      prisma.salesLocation.findMany({ where: { tenantId: tid }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }], select: LOCATION_SELECT }),
      prisma.salesRep.groupBy({ by: ['locationId'], where: { tenantId: tid, locationId: { not: null }, ...(await adminRepFilter(req)) }, _count: { _all: true } }),
    ]);
    const repsOf = new Map(reps.map((r) => [r.locationId, r._count._all]));
    res.json({ success: true, data: locations.map((l) => ({ ...l, repsCount: repsOf.get(l.id) ?? 0 })) });
  } catch (err) { next(err); }
});

/**
 * ملخّص الفترة لكل موقع (بختم المستند لا بموقع المندوب الحاليّ): فواتير البيع والمرتجعات (عدداً ومبلغاً) والتحميلات
 * (عدداً وكمياتٍ إجمالاً ولكل صنف)، و«بلا موقع» سطرٌ مستقل.
 * - الفترة بأيام الشركة (`from`/`to` YYYY-MM-DD، اليوم افتراضاً) — paymentMethodsRange كصفحة «طرق الدفع».
 * - الفواتير المؤكَّدة وحدها بتاريخها (invoiceDate)، تجميعاً في القاعدة (groupBy موقع × نوع) بنطاق المستندات
 *   (`scopedRecordWhere`: المقيَّد بالقوائم عميله ومندوبه، ومشرف الفرق ما وُسم بفرقه) — مفتاح AND واحد لا يمحوه شيء.
 * - التحميلات (LOAD) بلحظة تسجيلها بنطاق المندوب (`scopedRepRecordWhere`) كسجلّ التحميلات، وبنودها كمّياتٌ لا مبالغ.
 */
router.get('/summary', requireAdminPermission('canViewReports'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const tz = await tenantTz(tid);
    const range = paymentMethodsRange(req.query.from, req.query.to, tz);
    if (!range.ok) { res.status(400).json({ success: false, message: range.message }); return; }
    const [docScope, repScope] = await Promise.all([scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT), scopedRepRecordWhere(req)]);
    const [invoiceGroups, loads, locations] = await Promise.all([
      prisma.invoice.groupBy({
        by: ['locationId', 'type'],
        where: { tenantId: tid, status: 'CONFIRMED', invoiceDate: { gte: range.gte, lt: range.lt }, ...docScope },
        _sum: { total: true },
        _count: { _all: true },
      }),
      prisma.vanLoad.findMany({
        where: { tenantId: tid, type: 'LOAD', createdAt: { gte: range.gte, lt: range.lt }, ...repScope },
        select: { locationId: true, items: { select: { productId: true, qty: true } } },
      }),
      prisma.salesLocation.findMany({ where: { tenantId: tid }, select: { id: true, name: true, isActive: true, lat: true, lng: true } }),
    ]);
    // أسماء الأصناف المحمَّلة وحدها (معرّفاتٌ من تحميلاتٍ مرّت بالنطاق)
    const productIds = [...new Set(loads.flatMap((l) => l.items.map((i) => i.productId)))];
    const products = productIds.length
      ? await prisma.product.findMany({ where: { tenantId: tid, id: { in: productIds } }, select: { id: true, name: true, unit: true } })
      : [];
    const summary = buildLocationsSummary(
      invoiceGroups.map((g) => ({ locationId: g.locationId, type: g.type, amount: Number(g._sum.total ?? 0), count: g._count._all })),
      loads.map((l) => ({ locationId: l.locationId, items: l.items.map((i) => ({ productId: i.productId, qty: Number(i.qty) })) })),
      locations,
      new Map<string, ProductInfo>(products.map((p) => [p.id, { name: p.name, unit: p.unit ?? null }])),
    );
    res.json({ success: true, data: { range: { from: range.from, to: range.to, timezone: tz }, ...summary } });
  } catch (err) { next(err); }
});

// المناديب في نطاق المستخدم بموقع كلٍّ منهم الحاليّ — لشاشة الإسناد
router.get('/reps', requireAdminPermission('canManageSalesReps'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const reps = await prisma.salesRep.findMany({
      where: { tenantId: tid, ...(await adminRepFilter(req)) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, isActive: true, locationId: true },
    });
    res.json({ success: true, data: reps });
  } catch (err) { next(err); }
});

/**
 * إسناد مندوبٍ لموقعٍ واحد (`locationId`، أو null = بلا موقع). يسري على ما يُصدره **بعد** الإسناد وحده — مستنداته القديمة
 * باقيةٌ على ختمها (قرار المالك). موقعٌ مؤرشف لا يُسند إليه (لا يُختم به مستندٌ جديد).
 */
router.put('/reps/:salesRepId', requireAdminPermission('canManageSalesReps'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { locationId } = z.object({ locationId: z.string().min(1).nullable() }).parse(req.body);
    const salesRepId = String(req.params.salesRepId);
    // النطاق قبل الوجود: 404 واحدة للخارج عن النطاق وغير الموجود (لا يكشف الردّ وجوده)
    if (!(await canAccessRep(req, tid, salesRepId))) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (locationId) {
      const loc = await prisma.salesLocation.findFirst({ where: { id: locationId, tenantId: tid }, select: { isActive: true } });
      if (!loc) { res.status(404).json({ success: false, message: 'الموقع غير موجود' }); return; }
      if (!loc.isActive) { res.status(409).json({ success: false, code: 'LOCATION_ARCHIVED', message: 'الموقع مؤرشف — استعده أولا أو اختر موقعا آخر' }); return; }
    }
    await prisma.salesRep.update({ where: { id: rep.id }, data: { locationId } });
    res.json({ success: true, data: { salesRepId: rep.id, locationId } });
  } catch (err) { next(err); }
});

router.post('/', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const body = z.object({ name: nameSchema, lat: coordSchema.optional(), lng: coordSchema.optional() }).parse(req.body);
    const name = locationName(body.name);
    const problem = locationPointProblem(body.lat ?? null, body.lng ?? null);
    if (problem) { res.status(400).json({ success: false, message: problem }); return; }
    if (await prisma.salesLocation.findFirst({ where: { tenantId: tid, name }, select: { id: true } })) { nameTaken(res); return; }
    try {
      const loc = await prisma.salesLocation.create({ data: { tenantId: tid, name, lat: body.lat ?? null, lng: body.lng ?? null }, select: LOCATION_SELECT });
      res.status(201).json({ success: true, data: { ...loc, repsCount: 0 } });
    } catch (e) {
      // سباق إنشاءين بالاسم نفسه تجاوزا الفحص: القيد الفريد يحسمه
      if (isUniqueClash(e)) { nameTaken(res); return; }
      throw e;
    }
  } catch (err) { next(err); }
});

// إعادة التسمية، أو تغيير النقطة (null للمسح)، أو الأرشفة/الاستعادة
router.put('/:id', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const body = z.object({
      name: nameSchema.optional(), lat: coordSchema.optional(), lng: coordSchema.optional(), isActive: z.boolean().optional(),
    }).parse(req.body);
    const loc = await prisma.salesLocation.findFirst({ where: { id: String(req.params.id), tenantId: tid }, select: { id: true, lat: true, lng: true } });
    if (!loc) { res.status(404).json({ success: false, message: 'الموقع غير موجود' }); return; }
    const name = body.name !== undefined ? locationName(body.name) : undefined;
    // النقطة زوجٌ: ما لم يُرسل من الإحداثيين يبقى على قيمته — والزوج الناتج يُتحقّق منه كاملاً
    const pointChanged = body.lat !== undefined || body.lng !== undefined;
    const lat = body.lat !== undefined ? body.lat : loc.lat;
    const lng = body.lng !== undefined ? body.lng : loc.lng;
    if (pointChanged) {
      const problem = locationPointProblem(lat, lng);
      if (problem) { res.status(400).json({ success: false, message: problem }); return; }
    }
    if (name && await prisma.salesLocation.findFirst({ where: { tenantId: tid, name, id: { not: loc.id } }, select: { id: true } })) { nameTaken(res); return; }
    // لا أرشفة وفيه مناديب: كانوا سيُختمون بموقعٍ مؤرشف — يُنقلون أولاً (كلّ مناديب الشركة لا نطاق المستخدم)
    if (body.isActive === false) {
      const reps = await prisma.salesRep.count({ where: { tenantId: tid, locationId: loc.id } });
      if (reps > 0) {
        res.status(409).json({ success: false, code: 'LOCATION_HAS_REPS', message: `في الموقع ${reps} مندوب — انقلهم لموقع آخر قبل الأرشفة`, repsCount: reps });
        return;
      }
    }
    try {
      const updated = await prisma.salesLocation.update({
        where: { id: loc.id },
        data: {
          ...(name !== undefined && { name }),
          ...(pointChanged && { lat, lng }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
        select: LOCATION_SELECT,
      });
      res.json({ success: true, data: updated });
    } catch (e) {
      if (isUniqueClash(e)) { nameTaken(res); return; }
      throw e;
    }
  } catch (err) { next(err); }
});

// حذف موقعٍ بلا مناديب ولا مستندات — وعليه مستندات: يُؤرشف بدل الحذف (الحذف يفرّغ ختمها فتسقط من تقاريره)
router.delete('/:id', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const loc = await prisma.salesLocation.findFirst({ where: { id: String(req.params.id), tenantId: tid }, select: { id: true } });
    if (!loc) { res.status(404).json({ success: false, message: 'الموقع غير موجود' }); return; }
    const [reps, invoice, load] = await Promise.all([
      prisma.salesRep.count({ where: { tenantId: tid, locationId: loc.id } }),
      prisma.invoice.findFirst({ where: { tenantId: tid, locationId: loc.id }, select: { id: true } }),
      prisma.vanLoad.findFirst({ where: { tenantId: tid, locationId: loc.id }, select: { id: true } }),
    ]);
    if (reps > 0) {
      res.status(409).json({ success: false, code: 'LOCATION_HAS_REPS', message: `في الموقع ${reps} مندوب — انقلهم لموقع آخر قبل الحذف`, repsCount: reps });
      return;
    }
    if (invoice || load) {
      res.status(409).json({ success: false, code: 'LOCATION_HAS_DOCUMENTS', message: 'على الموقع فواتير أو تحميلات — أرشفه بدل الحذف ليبقى في التقارير' });
      return;
    }
    await prisma.salesLocation.delete({ where: { id: loc.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
