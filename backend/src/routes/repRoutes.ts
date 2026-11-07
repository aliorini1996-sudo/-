// ============================================================================
// خط سير المندوب — قائمة عملاء مرتّبة يجب زيارتهم، دائمةً أو ليومٍ بعينه.
//
// **الإنجاز يُشتقّ من الزيارات ولا يُخزَّن على المحطّة**: تُقرأ زياراتُ اليوم
// (RepVisit) وتُطابَق بالعميل. فالمصدر واحد ولا يقع تناقضٌ بين «✔ في خط السير»
// و«لا زيارة في سجلّ الزيارات»، وزيارةٌ سُجّلت من ملفّ العميل مباشرةً تُحتسب.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { canAccessRep, canAccessCustomerAsAdmin, adminRepFilter } from '../services/adminScope';
import { canAccessCustomer } from '../services/customerScope';

const router = Router();
router.use(authenticate);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const routeSchema = z.object({
  salesRepId: z.string().uuid(),
  name: z.string().min(1).max(80),
  isPermanent: z.boolean().default(false),
  routeDate: z.string().regex(DAY).nullish(),
  /** خطٌّ يحلّ هذا محلّه — يُحذف فعلياً داخل المعاملة نفسها مهما تغيّرت مفاتيحه */
  replacesId: z.string().uuid().nullish(),
  stops: z.array(z.object({
    customerId: z.string().uuid(),
    note: z.string().max(200).nullish(),
  })).min(1, 'خط السير بلا عملاء لا معنى له'),
}).refine(v => v.isPermanent || !!v.routeDate, {
  message: 'خط السير المؤقّت يحتاج تاريخاً',
  path: ['routeDate'],
});

/**
 * يوم الجهاز كما يرسله العميل، أو يوم الخادم عند غيابه.
 *
 * المندوب في منطقةٍ شرقيّة قد يكون في «الغد» بينما الخادم في «اليوم»، فخطّ
 * سيره يُقرأ بيومه هو. ونفس عرف reportDate في التقرير اليومي.
 */
function dayOf(req: AuthRequest): string {
  const d = String(req.query.date || '');
  if (DAY.test(d)) return d;
  const off = Number(req.query.tzOffsetMin || 0);
  const t = Date.now() + (Number.isFinite(off) ? off : 0) * 60000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * خط سير هذا المندوب في هذا اليوم: **المؤقّت يفوز على الدائم**.
 * تخصيصُ يومٍ بعينه أحدثُ قصداً من خطّةٍ عامّة وُضعت قبل شهر.
 */
async function routeFor(tid: string, salesRepId: string, day: string) {
  const dated = await prisma.repRoute.findFirst({
    where: { tenantId: tid, salesRepId, isActive: true, isPermanent: false, routeDate: day },
    include: { stops: { include: { customer: { select: { id: true, name: true, businessName: true, phone: true, address: true, lat: true, lng: true } } }, orderBy: { seq: 'asc' } } },
  });
  if (dated) return dated;
  /* الخطّ الدائم لا يسري على يومٍ **سبق إنشاءه**.
   *
   * بلا هذا القيد كان خطٌّ أُنشئ اليوم يُرسم على الأسبوع الماضي بوصفه «ما كان
   * مطلوباً» حينها، وعدّاده «0 / N» يتّهم المندوب بتقصيرٍ في خطّةٍ لم تكن
   * موجودة أصلاً. والحدّ نهايةُ ذلك اليوم لا بدايته: خطّةٌ وُضعت صباحاً تسري
   * على يومها. */
  const endOfDay = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86400000);
  return prisma.repRoute.findFirst({
    where: { tenantId: tid, salesRepId, isActive: true, isPermanent: true, createdAt: { lt: endOfDay } },
    include: { stops: { include: { customer: { select: { id: true, name: true, businessName: true, phone: true, address: true, lat: true, lng: true } } }, orderBy: { seq: 'asc' } } },
  });
}

/**
 * حذفٌ فعليّ لخطوط سيرٍ بمحطّاتها — لا تعطيل ولا نسخةٌ مخفيّة (أمر المالك ٧ نوفمبر ٢٠٢٦: «أي حذف حذفٌ نهائي»).
 *
 * لا شيء يقرأ خطّاً موقوفاً: الإنجاز يُشتقّ من سجلّ الزيارات (RepVisit) لا من الخطّ، و`routeFor` والقائمة
 * تقرآن النشط وحده، ولا جدول يشير إلى الخطّ غير محطّاته — فبقاء القديم «موقوفاً» لم يكن تاريخاً مقروءاً بل
 * نسخةً مخفيّة. المحطّات تُحذف صراحةً قبل رأسها (مع أن مفتاحها Cascade) كي لا يتعلّق الحذف بقيدٍ في القاعدة،
 * والشركة تُفرض على كل شرط فلا يمسّ الحذف خطّ شركةٍ أخرى مهما كان الشرط.
 *
 * `isActive` باقٍ في الجدول لصفوفٍ موقوفة كتبها المسار القديم: القراءة ما زالت تتجاهلها، وكل كتابةٍ لمندوبٍ
 * تحذف بقاياه (انظر POST وDELETE) — فلا يُنشئ هذا المسار صفّاً موقوفاً بعد اليوم.
 */
async function deleteRoutes(tx: Prisma.TransactionClient, tid: string, where: Prisma.RepRouteWhereInput): Promise<number> {
  const ids = (await tx.repRoute.findMany({ where: { ...where, tenantId: tid }, select: { id: true } })).map(r => r.id);
  if (!ids.length) return 0;
  await tx.repRouteStop.deleteMany({ where: { routeId: { in: ids } } });
  return (await tx.repRoute.deleteMany({ where: { id: { in: ids }, tenantId: tid } })).count;
}

/** حدود اليوم بإزاحة الجهاز — الزيارة تُحتسب ليوم المندوب لا ليوم الخادم */
function dayBounds(day: string, tzOffsetMin: number) {
  const start = new Date(`${day}T00:00:00.000Z`).getTime() - tzOffsetMin * 60000;
  return { gte: new Date(start), lt: new Date(start + 86400000) };
}

// ═══════════════════════ تطبيق المندوب ═══════════════════════

/**
 * خط سيري اليوم مع علامة الإنجاز لكل عميل.
 *
 * يُوضع **قبل** حارس الأدمن كي يبلغه المندوب — ولذلك يحمل حارسه بنفسه.
 * كان بلا حارسٍ إطلاقاً: أيّ مستخدم شركةٍ يمرّر salesRepId فيقرأ خطّ أي مندوب
 * بهواتف عملائه وعناوينهم وإحداثيّاتهم، ولو كان ممنوعاً من قسم التتبّع كلّه.
 */
router.get('/mine', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user!.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : String(req.query.salesRepId || '');
    if (!salesRepId) { res.status(400).json({ success: false, message: 'حدّد المندوب' }); return; }

    // غير المندوب: يلزمه دورُ شركةٍ **وصلاحية التتبّع** ثم أن يرى هذا المندوب.
    // الصلاحية تُقرأ من القاعدة لا من req.user — الأخير لا يحملها.
    if (!isRep) {
      const admin = await prisma.admin.findFirst({
        where: { id: req.user!.id, tenantId: tid },
        select: { isActive: true, canManageTracking: true },
      });
      if (!admin?.isActive || (admin.canManageTracking === false && req.user?.impersonated !== true)) {
        res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا القسم' }); return;
      }
      if (!(await canAccessRep(req, tid, salesRepId))) {
        res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
      }
    }

    const day = dayOf(req);
    const tz = Number(req.query.tzOffsetMin || 0);
    const route = await routeFor(tid, salesRepId, day);
    if (!route) { res.json({ success: true, data: null }); return; }

    /* عزل عملاء المندوب يُحترم هنا كما في كل مسارٍ آخر.
     *
     * محطّةٌ لعميلٍ غير مُسنَدٍ للمندوب كانت تُسلّمه هاتفه وعنوانه وإحداثيّاته،
     * وهي محطّةٌ **يستحيل إنجازها** أصلاً: تسجيل الزيارة يمرّ بنفس العزل فيُردّ.
     * فبقاؤها يعني عدّاداً لا يكتمل أبداً ومندوباً يطارد عميلاً ممنوعاً منه. */
    /* العزل يُطبَّق على **الجميع** لا على المندوب وحده.
     *
     * `canAccessCustomer` تغطّي قيدَي المندوب والإداريّ المقيَّد معاً، وتعيد
     * true لغير المقيَّدين — فاستثناء الإداريّ كان يفتح لطبقة الخطّة ما تُغلقه
     * طبقة مواقع العملاء على الشاشة نفسها: حاجزٌ مفتوحٌ بلونٍ ومغلقٌ بآخر. */
    const visible = [];
    let hidden = 0;
    for (const st of route.stops) {
      if (await canAccessCustomer(req, tid, st.customerId)) visible.push(st);
      else hidden++;
    }

    // الإنجاز من سجلّ الزيارات — مصدرٌ واحد لا نسخة ثانية
    const visits = await prisma.repVisit.findMany({
      where: {
        tenantId: tid, salesRepId,
        customerId: { in: visible.map(s => s.customerId) },
        createdAt: dayBounds(day, Number.isFinite(tz) ? tz : 0),
      },
      select: { customerId: true, createdAt: true },
    });
    const doneAt = new Map(visits.map(v => [v.customerId, v.createdAt]));

    res.json({
      success: true,
      data: {
        id: route.id, name: route.name, isPermanent: route.isPermanent, routeDate: route.routeDate, day,
        stops: visible.map(s => ({
          id: s.id, seq: s.seq, note: s.note,
          customerId: s.customerId,
          customerName: s.customer.businessName || s.customer.name,
          phone: s.customer.phone, address: s.customer.address,
          lat: s.customer.lat, lng: s.customer.lng,
          done: doneAt.has(s.customerId),
          doneAt: doneAt.get(s.customerId) ?? null,
        })),
        doneCount: visible.filter(s => doneAt.has(s.customerId)).length,
        total: visible.length,
        // محطّاتٌ حجبها نطاقُ القارئ — تُقال ولا تُخفى، وإلا رأى خطّاً أقصر
        // من المخطَّط وظنّه كاملاً
        hiddenByScope: hidden,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════ لوحة الإدارة ═══════════════════════

router.use(requireAdmin, requireAdminPermission('canManageTracking'));

/** خطوط سير الشركة — مع تقدّم اليوم لكل خط */
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const day = dayOf(req);
    // نطاق المستخدم يُحترم: مستخدمٌ مقيَّد بمندوبين لا يرى خطوط الثالث
    const repScope = await adminRepFilter(req);
    const scopedReps = Object.keys(repScope).length
      ? (await prisma.salesRep.findMany({ where: { tenantId: tid, ...repScope }, select: { id: true } })).map(r => r.id)
      : null;

    const routes = await prisma.repRoute.findMany({
      where: { tenantId: tid, isActive: true, ...(scopedReps && { salesRepId: { in: scopedReps } }) },
      include: {
        salesRep: { select: { id: true, name: true } },
        stops: { select: { id: true, customerId: true, seq: true }, orderBy: { seq: 'asc' } },
      },
      orderBy: [{ isPermanent: 'asc' }, { routeDate: 'desc' }, { createdAt: 'desc' }],
    });

    // زياراتُ اليوم لكل المناديب دفعةً واحدة — لا استعلامٌ لكل خط
    const visits = await prisma.repVisit.findMany({
      where: { tenantId: tid, createdAt: dayBounds(day, Number(req.query.tzOffsetMin || 0) || 0) },
      select: { salesRepId: true, customerId: true },
    });
    const key = (r: string, c: string) => `${r}|${c}`;
    const seen = new Set(visits.map(v => key(v.salesRepId, v.customerId)));

    res.json({
      success: true,
      data: routes.map(r => {
        // خطٌّ مؤقّت ليومٍ آخر لا «أنجز اليوم» له: عدّ زيارات اليوم عليه يعطي
        // رقماً صحيح الحساب كاذب المعنى — فيُرسَل null وتعرض الواجهة شرطة.
        const isToday = r.isPermanent || r.routeDate === day;
        return {
          id: r.id, name: r.name, isPermanent: r.isPermanent, routeDate: r.routeDate,
          salesRepId: r.salesRepId, salesRepName: r.salesRep.name,
          total: r.stops.length,
          doneToday: isToday ? r.stops.filter(s => seen.has(key(r.salesRepId, s.customerId))).length : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

/** تفاصيل خط سير للتحرير */
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const r = await prisma.repRoute.findFirst({
      // النسخ المعطَّلة القديمة (قبل الحذف الحقيقي، أمر المالك ٧ نوفمبر) لا تُقرأ — المحذوف محذوف
      where: { id: String(req.params.id), tenantId: tid, isActive: true },
      include: { stops: { orderBy: { seq: 'asc' }, include: { customer: { select: { id: true, name: true, businessName: true } } } } },
    });
    // النطاق يسبق: خطُّ مندوبٍ لا يراه المستخدم = غير موجود لا «ممنوع»،
    // كي لا يكشف الردّ وجودَ مندوبٍ خارج نطاقه
    if (!r || !(await canAccessRep(req, tid, r.salesRepId))) {
      res.status(404).json({ success: false, message: 'خط السير غير موجود' }); return;
    }
    res.json({
      success: true,
      data: {
        id: r.id, name: r.name, isPermanent: r.isPermanent, routeDate: r.routeDate, salesRepId: r.salesRepId,
        stops: r.stops.map(s => ({
          customerId: s.customerId, seq: s.seq, note: s.note,
          customerName: s.customer.businessName || s.customer.name,
        })),
      },
    });
  } catch (err) { next(err); }
});

/** إنشاء أو استبدال خط سير */
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = routeSchema.parse(req.body);

    // النطاق يسبق كل شيء: لا يُسنَد خطٌّ لمندوبٍ لا يراه المستخدم — ولا لمندوب شركةٍ أخرى (canAccessRep بلا
    // نطاق لا تسأل عن الشركة، والمفتاح الأجنبيّ لا يعرفها)
    if (!(await canAccessRep(req, tid, body.salesRepId))
      || !(await prisma.salesRep.findFirst({ where: { id: body.salesRepId, tenantId: tid }, select: { id: true } }))) {
      res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
    }
    // ولا يُوضع في الخط عميلٌ خارج نطاق المستخدم أو خارج شركته
    const exists = await prisma.customer.findMany({
      where: { tenantId: tid, id: { in: body.stops.map(s => s.customerId) } },
      select: { id: true },
    });
    const inTenant = new Set(exists.map(c => c.id));
    const ok = new Set<string>();
    for (const id of inTenant) {
      if (await canAccessCustomerAsAdmin(req, tid, id)) ok.add(id);
    }
    const stops = body.stops.filter(s => ok.has(s.customerId));
    if (!stops.length) { res.status(400).json({ success: false, message: 'لا عملاء صالحين في خط السير' }); return; }

    /* الخطّ المُحرَّر يُحذف فعلياً — فيُفحص نطاقه أولاً كما يُفحص في DELETE.
     *
     * قد يكون لمندوبٍ غير المرسَل (غيّر المالك المندوب في التعديل)، وكان التعطيل بالمعرّف وحده كتابةً عمياء
     * على خطّ مندوبٍ خارج نطاق المستخدم. خطٌّ غائب (حذفه مستخدمٌ آخر أثناء التحرير) أو خارج النطاق لا يُمسّ،
     * ويُحفظ الجديد كما كان يُحفظ حين لا يطابق التعطيلُ شيئاً. ومندوب الخطّ لا يتغيّر بعد إنشائه (التعديل
     * إنشاءٌ جديد)، فلا سباق بين هذا الفحص والحذف داخل المعاملة. */
    const replaced = body.replacesId
      ? await prisma.repRoute.findFirst({ where: { id: body.replacesId, tenantId: tid }, select: { id: true, salesRepId: true } })
      : null;
    const replacedId = replaced && (await canAccessRep(req, tid, replaced.salesRepId)) ? replaced.id : null;

    const saved = await prisma.$transaction(async tx => {
      // **خطٌّ واحد لكل حالة**: دائمٌ واحد للمندوب، ومؤقّتٌ واحد لليوم.
      // خطّان يجعلان «ما خط سيري اليوم؟» سؤالاً بلا جواب — فيُستبدل القديم
      // بدل أن يتراكما صامتَين. والاستبدال **حذفٌ فعليّ** لا تعطيل: لا نسخةٌ
      // مخفيّة تبقى للخطّ القديم (أمر المالك ٧ نوفمبر ٢٠٢٦).
      // **الخطّ المُحرَّر يُحذف بمعرّفه**: الاستبدال بالمفاتيح وحده يفشل متى
      // غُيّر أحدها (تاريخ أو نوع أو مندوب)، فيبقى القديم نشطاً ويعمل المندوب
      // على خطٍّ ظنّ المالك أنه بدّله — أو يراه مندوبان معاً في اليوم نفسه.
      if (replacedId) await deleteRoutes(tx, tid, { id: replacedId });
      // بالمفاتيح بلا شرط isActive: يذهب النشط وما بقي موقوفاً من المسار القديم معاً
      await deleteRoutes(tx, tid, body.isPermanent
        ? { salesRepId: body.salesRepId, isPermanent: true }
        : { salesRepId: body.salesRepId, isPermanent: false, routeDate: body.routeDate! });
      // وبقايا التعطيل القديم لهذا المندوب (خطوطٌ «أُوقفت» قبل أمر الحذف الفعليّ) — لا يقرؤها شيء
      await deleteRoutes(tx, tid, { salesRepId: body.salesRepId, isActive: false });
      const r = await tx.repRoute.create({
        data: {
          tenantId: tid, salesRepId: body.salesRepId, name: body.name,
          isPermanent: body.isPermanent,
          routeDate: body.isPermanent ? null : body.routeDate!,
        },
      });
      // الترتيب من موضع العميل في المصفوفة — هو ما رتّبه المالك بعينه
      for (let i = 0; i < stops.length; i++) {
        await tx.repRouteStop.create({
          data: { tenantId: tid, routeId: r.id, customerId: stops[i].customerId, seq: i + 1, note: stops[i].note ?? null },
        });
      }
      return r;
    });

    const dropped = body.stops.length - stops.length;
    res.status(201).json({ success: true, data: { id: saved.id }, ...(dropped > 0 && { warning: `${dropped} عميل خارج نطاقك لم يُضَف` }) });
  } catch (err) { next(err); }
});

/**
 * حذف خط سير — **حذفٌ فعليّ** للخطّ ومحطّاته في معاملةٍ واحدة، لا تعطيل ولا نسخةٌ مخفيّة
 * (أمر المالك ٧ نوفمبر ٢٠٢٦). لا تاريخ يضيع: الإنجاز يُقرأ من سجلّ الزيارات لا من الخطّ.
 * ومعه بقايا التعطيل القديم لمندوبه — خطوطٌ «أُوقفت» قبل الأمر ولا يقرؤها شيء.
 */
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const r = await prisma.repRoute.findFirst({ where: { id: String(req.params.id), tenantId: tid } });
    // كتابةٌ عمياء يمنعها POST صراحةً — فتُمنع هنا كذلك
    if (!r || !(await canAccessRep(req, tid, r.salesRepId))) {
      res.status(404).json({ success: false, message: 'خط السير غير موجود' }); return;
    }
    await prisma.$transaction(tx => deleteRoutes(tx, tid, { OR: [{ id: r.id }, { salesRepId: r.salesRepId, isActive: false }] }));
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
