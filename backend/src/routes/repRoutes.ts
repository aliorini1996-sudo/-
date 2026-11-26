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
import { planRoadPath } from '../services/planRoadPath';
import {
  pickRouteForDay, orderRoutes, isValidDay, weekdayConflict, firstInternalConflict, weekdayConflictMessage, DEFAULT_OFF_DAYS, WEEKDAY_NAMES_AR,
} from '../services/routeSchedule';
// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): دخول العميل خطّ سير مندوبٍ وخروجه منه حدثان في سجلّه — حدثٌ لكل
// عميلٍ تغيّر حاله في الحفظ لا لكل محطّةٍ بقيت، في معاملة الحفظ أو الحذف نفسها
import { activityMeta, diffRouteStops, keptStopDates, recordActivityInTx, type ActivityInput, type ActivityMeta, type RouteStopRef } from '../services/customerActivityEvents';

const router = Router();
router.use(authenticate);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** أيام أسبوعٍ 0=الأحد..6=السبت بلا تكرار — أيام الخطّ وأيام الراحة */
const weekdayList = (dup: string) => z.array(z.number().int().min(0, 'يوم الأسبوع بين 0 و6').max(6, 'يوم الأسبوع بين 0 و6'))
  .refine(v => new Set(v).size === v.length, { message: dup });

const routeSchema = z.object({
  salesRepId: z.string().uuid(),
  name: z.string().min(1).max(80),
  isPermanent: z.boolean().default(false),
  routeDate: z.string().regex(DAY).nullish(),
  /** خطٌّ يحلّ هذا محلّه — يُحذف فعلياً داخل المعاملة نفسها مهما تغيّرت مفاتيحه */
  replacesId: z.string().uuid().nullish(),
  /** «حسب أيام الأسبوع» (طلب المالك ٢٢ نوفمبر ٢٠٢٦): أيام هذا الخطّ الدائم — غيابه في التعديل يُبقي أيامه */
  weekdays: weekdayList('يومٌ مكرَّر في أيام الخط').optional(),
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

/** عميل المحطّة في خطّ اليوم — number: رقم العميل التسلسليّ يُعاد customerNumber (طلب المالك ٢٣ نوفمبر ٢٠٢٦) */
const STOP_CUSTOMER_SELECT = {
  id: true, name: true, number: true, businessName: true, phone: true, address: true, lat: true, lng: true,
} as const;

/**
 * خط سير هذا المندوب في هذا اليوم: **المؤقّت يفوز على الدائم**.
 * تخصيصُ يومٍ بعينه أحدثُ قصداً من خطّةٍ عامّة وُضعت قبل شهر.
 */
async function routeFor(tid: string, salesRepId: string, day: string) {
  const dated = await prisma.repRoute.findFirst({
    where: { tenantId: tid, salesRepId, isActive: true, isPermanent: false, routeDate: day },
    include: { stops: { include: { customer: { select: STOP_CUSTOMER_SELECT } }, orderBy: { seq: 'asc' } } },
  });
  if (dated) return dated;
  /* الخطّ الدائم لا يسري على يومٍ **سبق إنشاءه**.
   *
   * بلا هذا القيد كان خطٌّ أُنشئ اليوم يُرسم على الأسبوع الماضي بوصفه «ما كان
   * مطلوباً» حينها، وعدّاده «0 / N» يتّهم المندوب بتقصيرٍ في خطّةٍ لم تكن
   * موجودة أصلاً. والحدّ نهايةُ ذلك اليوم لا بدايته: خطّةٌ وُضعت صباحاً تسري
   * على يومها. (والقيد نفسه في pickRouteForDay — هنا تضييقٌ للاستعلام.) */
  const endOfDay = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86400000);
  /* عدّة خطوطٍ دائمة (طلب المالك ٢٢ نوفمبر ٢٠٢٦): يُختار خطّ اليوم بجدول المندوب — أيام الأسبوع أو التناوب —
   * بالدالّة النقيّة نفسها التي تقرؤها قائمة الإدارة ونافذة الجدول. بلا جدولٍ ⇒ أوّل دائمٍ كما كان. */
  const [schedule, perms] = await Promise.all([
    prisma.repRouteSchedule.findFirst({ where: { tenantId: tid, salesRepId }, select: { mode: true, rotationStart: true, offDays: true } }),
    prisma.repRoute.findMany({
      where: { tenantId: tid, salesRepId, isActive: true, isPermanent: true, createdAt: { lt: endOfDay } },
      select: ROUTE_PICK_SELECT,
      orderBy: [{ rotationOrder: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);
  const pick = pickRouteForDay(day, schedule, perms);
  if (!pick) return null;
  return prisma.repRoute.findFirst({
    where: { id: pick.id, tenantId: tid, isActive: true },
    include: { stops: { include: { customer: { select: STOP_CUSTOMER_SELECT } }, orderBy: { seq: 'asc' } } },
  });
}

/** أعمدة اختيار خطّ اليوم وعرض الجدول — لا محطّات */
const ROUTE_PICK_SELECT = {
  id: true, name: true, isPermanent: true, routeDate: true, isActive: true, createdAt: true, weekdays: true, rotationOrder: true,
} as const;

/** خطوط المندوب الدائمة النشطة بترتيب الدورة (rotationOrder ثم الأقدم) */
async function permanentRoutesOf(db: Prisma.TransactionClient, tid: string, salesRepId: string) {
  return orderRoutes(await db.repRoute.findMany({
    where: { tenantId: tid, salesRepId, isActive: true, isPermanent: true },
    select: ROUTE_PICK_SELECT,
    orderBy: [{ rotationOrder: 'asc' }, { createdAt: 'asc' }],
  }));
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
async function deleteRoutes(tx: Prisma.TransactionClient, tid: string, where: Prisma.RepRouteWhereInput, track?: RouteTrack): Promise<number> {
  const routes: { id: string; name: string | null; salesRepId: string | null; isActive: boolean }[] = await tx.repRoute.findMany({
    where: { ...where, tenantId: tid },
    select: { id: true, name: true, salesRepId: true, isActive: true },
  });
  const ids = routes.map(r => r.id);
  if (!ids.length) return 0;
  // «أرشيف العميل»: محطّات الخطوط النشطة قبل حذفها — يجمعها الحفظ (collect) فيقارن بها خطّه الجديد، ويسجّل الحذف (record) خروج
  // كل عميلٍ منها. بقايا التعطيل القديم (isActive=false) خرجت من الخطّ يوم أُوقفت فلا تُعدّ خروجاً الآن
  if (track) {
    const removed: RouteStopRef[] = [];
    const live = new Map(routes.filter(r => r.isActive !== false).map(r => [r.id, r]));
    if (live.size) {
      const stops: { customerId: string; routeId: string; createdAt?: Date | null }[] = await tx.repRouteStop.findMany({
        where: { routeId: { in: [...live.keys()] } }, select: { customerId: true, routeId: true, createdAt: true },
      });
      for (const s of stops ?? []) {
        const r = live.get(s.routeId);
        if (r) {
          removed.push({
            customerId: s.customerId, routeId: r.id, routeName: r.name ?? null, salesRepId: r.salesRepId ?? null,
            ...(s.createdAt instanceof Date && { createdAt: s.createdAt }),
          });
        }
      }
    }
    if (track.collect) track.collect.push(...removed);
    if (track.record && removed.length) {
      const reps = await repNamesOf(tx, tid, removed.map(s => s.salesRepId));
      // عميلٌ مرّةً لكل مندوب (diffRouteStops مع خطٍّ فارغ)
      const unique = diffRouteStops(removed, [], '').removed;
      await recordActivityInTx(tx, stopRemovedEvents(tid, unique, track.record.meta, reps, track.record.reason));
    }
  }
  await tx.repRouteStop.deleteMany({ where: { routeId: { in: ids } } });
  return (await tx.repRoute.deleteMany({ where: { id: { in: ids }, tenantId: tid } })).count;
}

/** «أرشيف العميل»: ما يفعله deleteRoutes بمحطّات الخطوط النشطة المحذوفة — جمعها للمقارنة، أو تسجيل خروج عملائها بفاعلٍ وسبب */
interface RouteTrack { collect?: RouteStopRef[]; record?: { meta: ActivityMeta; reason: string } }

/** أسماء المناديب لأحداث خطوط السير — قراءةٌ واحدة لمن ورد منهم */
async function repNamesOf(tx: Prisma.TransactionClient, tid: string, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== ''))];
  if (!want.length) return new Map();
  const rows = await tx.salesRep.findMany({ where: { tenantId: tid, id: { in: want } }, select: { id: true, name: true } });
  return new Map((rows ?? []).map(r => [r.id, r.name]));
}

/** أحداث الخروج من الخطّ (ROUTE_STOP_REMOVED) لمحطّاتٍ حُذفت */
function stopRemovedEvents(tid: string, removed: readonly RouteStopRef[], meta: ActivityMeta, reps: ReadonlyMap<string, string>, reason: string): ActivityInput[] {
  return removed.map(s => ({
    tenantId: tid, customerId: s.customerId, action: 'ROUTE_STOP_REMOVED' as const, actor: meta.actor, source: meta.source,
    refType: 'ROUTE' as const, refId: s.routeId,
    data: {
      ...(s.routeName && { routeName: s.routeName }), ...(s.salesRepId && { salesRepId: s.salesRepId }),
      ...(s.salesRepId && reps.get(s.salesRepId) && { repName: reps.get(s.salesRepId) }), reason,
    },
  }));
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

    // خريطة الإدارة (?shape=1): الخطّ المخطَّط على الشوارع بترتيب المحطّات — طلب المالك ٢١ نوفمبر (services/planRoadPath.ts)
    const roadPath = !isRep && req.query.shape === '1'
      ? await planRoadPath(
          visible.filter(s => s.customer.lat != null && s.customer.lng != null)
            .map(s => ({ lat: Number(s.customer.lat), lng: Number(s.customer.lng) })),
          tid,
        )
      : undefined;

    res.json({
      success: true,
      data: {
        id: route.id, name: route.name, isPermanent: route.isPermanent, routeDate: route.routeDate, day,
        stops: visible.map(s => ({
          id: s.id, seq: s.seq, note: s.note,
          customerId: s.customerId,
          customerName: s.customer.businessName || s.customer.name,
          customerNumber: s.customer.number ?? null,
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
        ...(roadPath !== undefined ? { roadPath } : {}),
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
      orderBy: [{ isPermanent: 'asc' }, { routeDate: 'desc' }, { rotationOrder: 'asc' }, { createdAt: 'asc' }],
    });

    /* «خطّ اليوم» لكل مندوب بجدوله (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — الدالّة نفسها التي يقرؤها تطبيقه وخريطة
     * التتبّع، فلا تُعلِّم القائمة خطّاً «لليوم» والمندوب يسير على غيره. */
    const schedules = await prisma.repRouteSchedule.findMany({
      where: { tenantId: tid, ...(scopedReps && { salesRepId: { in: scopedReps } }) },
      select: { salesRepId: true, mode: true, rotationStart: true, offDays: true },
    });
    const scheduleOf = new Map(schedules.map(x => [x.salesRepId, x]));
    const byRep = new Map<string, typeof routes>();
    for (const r of routes) {
      const list = byRep.get(r.salesRepId);
      if (list) list.push(r); else byRep.set(r.salesRepId, [r]);
    }
    const todayIds = new Set<string>();
    for (const [repId, list] of byRep) {
      const t = pickRouteForDay(day, scheduleOf.get(repId) ?? null, list);
      if (t) todayIds.add(t.id);
    }

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
        // خطٌّ ليس خطَّ اليوم لا «أنجز اليوم» له: عدّ زيارات اليوم عليه يعطي
        // رقماً صحيح الحساب كاذب المعنى — فيُرسَل null وتعرض الواجهة شرطة.
        // وخطّ اليوم من جدول المندوب لا «كل دائمٍ لليوم» (طلب المالك ٢٢ نوفمبر ٢٠٢٦: عدّة خطوطٍ دائمة)
        const isToday = todayIds.has(r.id);
        return {
          id: r.id, name: r.name, isPermanent: r.isPermanent, routeDate: r.routeDate,
          salesRepId: r.salesRepId, salesRepName: r.salesRep.name,
          weekdays: r.weekdays, rotationOrder: r.rotationOrder,
          scheduleMode: scheduleOf.get(r.salesRepId)?.mode ?? null,
          isToday,
          total: r.stops.length,
          doneToday: isToday ? r.stops.filter(s => seen.has(key(r.salesRepId, s.customerId))).length : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

// ═══════════ طريقة توزيع الخطوط على الأيام (طلب المالك ٢٢ نوفمبر ٢٠٢٦) ═══════════
//
// مندوبٌ له عدّة خطوطٍ دائمة يُوجَّه كل يومٍ إلى واحدٍ منها: «حسب أيام الأسبوع» أو «تناوب بالترتيب».
// و«خط واحد يومياً» = لا جدول (السلوك القديم). الحرّاس هم حرّاس الراوتر نفسه (requireAdmin + صلاحية التتبّع)
// ونطاق المندوب (canAccessRep) — مندوبٌ خارج النطاق أو الشركة «غير موجود» لا «ممنوع».

const scheduleSchema = z.object({
  mode: z.enum(['single', 'weekdays', 'rotation'], { errorMap: () => ({ message: 'طريقة التوزيع غير معروفة' }) }),
  rotationStart: z.string().regex(DAY, 'التاريخ بصيغة YYYY-MM-DD').refine(isValidDay, 'تاريخ بداية التناوب غير صالح').nullish(),
  offDays: weekdayList('يوم راحةٍ مكرَّر').refine(v => v.length < 7, 'لا بدّ من يوم عملٍ واحد على الأقل').optional(),
});

const orderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'لا خطوط في الترتيب').max(200)
    .refine(v => new Set(v).size === v.length, { message: 'خطٌّ مكرَّر في الترتيب' }),
});

/** المندوب في هذه الشركة وفي نطاق المستخدم — وإلا فهو «غير موجود» لا «ممنوع» كي لا يكشف الردّ وجوده */
async function repInScope(req: AuthRequest, tid: string, salesRepId: string): Promise<boolean> {
  if (!z.string().uuid().safeParse(salesRepId).success) return false;
  if (!(await canAccessRep(req, tid, salesRepId))) return false;
  return !!(await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { id: true } }));
}

/** حال الجدول كما تعرضه النافذة: الطريقة وخطوط المندوب الدائمة بترتيب الدورة وخطّ اليوم */
async function scheduleView(tid: string, salesRepId: string, day: string) {
  const [schedule, perms, dated] = await Promise.all([
    prisma.repRouteSchedule.findFirst({
      where: { tenantId: tid, salesRepId },
      select: { mode: true, rotationStart: true, offDays: true, updatedAt: true },
    }),
    permanentRoutesOf(prisma, tid, salesRepId),
    prisma.repRoute.findFirst({
      where: { tenantId: tid, salesRepId, isActive: true, isPermanent: false, routeDate: day },
      select: ROUTE_PICK_SELECT,
    }),
  ]);
  const today = pickRouteForDay(day, schedule, dated ? [dated, ...perms] : perms);
  return {
    day,
    schedule,
    routes: perms.map(r => ({ id: r.id, name: r.name, weekdays: r.weekdays, rotationOrder: r.rotationOrder })),
    today: today ? { routeId: today.id, name: today.name, isPermanent: today.isPermanent } : null,
  };
}

/** طريقة توزيع خطوط مندوبٍ وخطّ يومه */
router.get('/schedule/:salesRepId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const salesRepId = String(req.params.salesRepId);
    if (!(await repInScope(req, tid, salesRepId))) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    res.json({ success: true, data: await scheduleView(tid, salesRepId, dayOf(req)) });
  } catch (err) { next(err); }
});

/**
 * تغيير الطريقة: 'single' يحذف الجدول فعلياً (عودةٌ إلى دائمٍ واحد)، و'weekdays'/'rotation' تُنشئه أو تعدّله.
 * ما لم يُرسَل من بداية التناوب وأيام الراحة يبقى كما كان — فالتنقّل بين الطريقتين لا يمحو إعداد الأخرى.
 */
router.put('/schedule/:salesRepId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = scheduleSchema.parse(req.body);
    const salesRepId = String(req.params.salesRepId);
    if (!(await repInScope(req, tid, salesRepId))) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const day = dayOf(req);
    const perms = await permanentRoutesOf(prisma, tid, salesRepId);

    if (body.mode === 'single') {
      /* «خط واحد يومياً» يحفظ الدائم القادم بحذف بقيّة الدوائم (السلوك القديم) — فلا يُدخَل إليه ومعه عدّة
       * دوائم: إمّا حذفٌ صامتٌ لاحقاً لخطوطٍ لم يقصدها المالك، أو «أوّل دائم» لا يعرف أيّها. يختار هو ما يحذف. */
      if (perms.length > 1) {
        res.status(409).json({
          success: false, code: 'MULTIPLE_PERMANENT',
          message: `للمندوب ${perms.length} خطوط دائمة — «خط واحد يومياً» يُبقي خطاً دائماً واحداً، فاحذف الخطوط الزائدة أولاً`,
        });
        return;
      }
      await prisma.repRouteSchedule.deleteMany({ where: { tenantId: tid, salesRepId } });
      res.json({ success: true, data: await scheduleView(tid, salesRepId, day) });
      return;
    }

    if (body.mode === 'weekdays') {
      /* خطوطٌ دائمة كلّها بلا أيام ⇒ لا خطّ للمندوب في أي يوم: التحويل يُطفئ خطّته صامتاً (مراجعة ٢٢ نوفمبر ٢٠٢٦).
       * يُرفض حتى يحدّد المالك أيام كل خطّ. وبلا دوائم أصلاً لا شيء يُطفأ — فيُقبل ليُعدّ الطريقة قبل الخطوط. */
      const bare = perms.filter(r => !r.weekdays?.length);
      if (perms.length && bare.length === perms.length) {
        res.status(409).json({
          success: false, code: 'NO_WEEKDAYS',
          message: `«حسب أيام الأسبوع» يحتاج أياماً لكل خط — ${bare.length === 1 ? 'خطّ المندوب' : 'خطوط المندوب'} ${bare.map(r => `«${r.name}»`).join('، ')} بلا أيام فلن يظهر له خطٌّ في أي يوم. حدّد أيام كل خطٍّ من «تعديل» أولاً`,
          routes: bare.map(r => ({ id: r.id, name: r.name })),
        });
        return;
      }
      // خطّان على يومٍ واحد يجعلان «خطّ اليوم» بجوابين — يُرفض التحويل حتى يُصلح المالك أيامهما
      const c = firstInternalConflict(perms);
      if (c) {
        res.status(409).json({ success: false, code: 'WEEKDAY_CONFLICT', message: `يوم ${WEEKDAY_NAMES_AR[c.day]} في خطّي «${c.a}» و«${c.b}» — لكل يومٍ خطٌّ واحد، فعدّل أيام أحدهما أولاً` });
        return;
      }
    }

    const existing = await prisma.repRouteSchedule.findFirst({ where: { tenantId: tid, salesRepId }, select: { rotationStart: true, offDays: true } });
    const rotationStart = body.rotationStart ?? existing?.rotationStart ?? (body.mode === 'rotation' ? day : null);
    const offDays = [...(body.offDays ?? existing?.offDays ?? DEFAULT_OFF_DAYS)].sort((a, b) => a - b);
    const data = { mode: body.mode, rotationStart, offDays, updatedBy: req.user!.id };
    await prisma.repRouteSchedule.upsert({
      where: { salesRepId },
      create: { tenantId: tid, salesRepId, ...data },
      update: data,
    });
    res.json({ success: true, data: await scheduleView(tid, salesRepId, day) });
  } catch (err) { next(err); }
});

/**
 * ترتيب دورة التناوب: `ids` هي خطوط المندوب الدائمة النشطة **كلّها** وحدها مرّةً واحدة، فيُكتب لكلٍّ موضعه
 * 0..ن-1. قائمةٌ ناقصة أو زائدة (صفحةٌ قديمة بعد حذف خطٍّ أو إضافته) تُرفض بدل ترتيبٍ نصفه قديم.
 * والكتابة الوحيدة على رأس الخطّ هي موضعه — لا تعطيل ولا تعديل غيره (الحذف فعليّ، أمر المالك ٧ نوفمبر).
 */
router.put('/order/:salesRepId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = orderSchema.parse(req.body);
    const salesRepId = String(req.params.salesRepId);
    if (!(await repInScope(req, tid, salesRepId))) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const perms = await permanentRoutesOf(prisma, tid, salesRepId);
    const have = new Set(perms.map(r => r.id));
    if (body.ids.length !== have.size || body.ids.some(id => !have.has(id))) {
      res.status(400).json({
        success: false, code: 'ORDER_MISMATCH',
        message: 'الترتيب يجب أن يشمل كل خطوط المندوب الدائمة مرة واحدة — حدّث الصفحة وأعد المحاولة',
      });
      return;
    }
    await prisma.$transaction(async tx => {
      for (let i = 0; i < body.ids.length; i++) {
        await tx.repRoute.updateMany({ where: { id: body.ids[i], tenantId: tid, salesRepId }, data: { rotationOrder: i } });
      }
    });
    res.json({ success: true, data: await scheduleView(tid, salesRepId, dayOf(req)) });
  } catch (err) { next(err); }
});

/** تفاصيل خط سير للتحرير */
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const r = await prisma.repRoute.findFirst({
      // النسخ المعطَّلة القديمة (قبل الحذف الحقيقي، أمر المالك ٧ نوفمبر) لا تُقرأ — المحذوف محذوف
      where: { id: String(req.params.id), tenantId: tid, isActive: true },
      include: { stops: { orderBy: { seq: 'asc' }, include: { customer: { select: { id: true, name: true, number: true, businessName: true } } } } },
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
        weekdays: r.weekdays, rotationOrder: r.rotationOrder,
        stops: r.stops.map(s => ({
          customerId: s.customerId, seq: s.seq, note: s.note,
          customerName: s.customer.businessName || s.customer.name,
          customerNumber: s.customer.number ?? null,
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
      ? await prisma.repRoute.findFirst({
        where: { id: body.replacesId, tenantId: tid },
        select: { id: true, salesRepId: true, isPermanent: true, weekdays: true, rotationOrder: true, createdAt: true },
      })
      : null;
    const replacedId = replaced && (await canAccessRep(req, tid, replaced.salesRepId)) ? replaced.id : null;

    /* عدّة خطوطٍ دائمة (طلب المالك ٢٢ نوفمبر ٢٠٢٦): مندوبٌ له جدول (أيام الأسبوع أو التناوب) لا يُحذف دائمُه
     * الآخر حين يُحفظ دائم — يُستبدل المُحرَّر وحده بمعرّفه. ومن لا جدول له باقٍ على «دائمٍ واحد» كما كان. */
    const schedule = body.isPermanent
      ? await prisma.repRouteSchedule.findFirst({ where: { tenantId: tid, salesRepId: body.salesRepId }, select: { mode: true } })
      : null;
    // تعديل دائمٍ للمندوب نفسه يُبقي موضعه في الدورة وأيامه (ما لم تُرسَل أيامٌ جديدة) وتاريخ إنشائه — لا يقفز إلى آخر الترتيب
    const kept = replaced && replacedId && replaced.isPermanent && replaced.salesRepId === body.salesRepId ? replaced : null;
    const weekdays = body.isPermanent ? [...(body.weekdays ?? kept?.weekdays ?? [])].sort((a, b) => a - b) : [];
    /* لكل يومٍ خطٌّ واحد — يومٌ يستعمله خطٌّ آخر للمندوب يُرفض بدل أن يصير لليوم خطّان. يُفحص **متى أُرسلت الأيام
     * أيّاً كانت الطريقة** (مراجعة ٢٢ نوفمبر ٢٠٢٦): أيامٌ تُحدَّد في التناوب تمهيداً لـ«حسب أيام الأسبوع» لا تُخزَّن
     * متعارضةً فيُرفض التحويل بعدها؛ وفي «حسب أيام الأسبوع» تُفحص أيام المُحرَّر الباقية كذلك كما كانت.
     * والمقارنة بما يبقى بعد الحفظ وحده: بلا جدولٍ يُستبدل كل دائمٍ للمندوب (أدناه) فلا يبقى ما يُعارَض. */
    if (body.isPermanent && weekdays.length && (body.weekdays !== undefined || schedule?.mode === 'weekdays')) {
      const others = schedule ? (await permanentRoutesOf(prisma, tid, body.salesRepId)).filter(r => r.id !== replacedId) : [];
      const clash = weekdayConflict(others, weekdays);
      if (clash) {
        res.status(409).json({ success: false, code: 'WEEKDAY_CONFLICT', message: weekdayConflictMessage(clash.day, clash.name), conflict: clash });
        return;
      }
    }

    const meta = activityMeta(req);
    const saved = await prisma.$transaction(async tx => {
      // «أرشيف العميل»: محطّات الخطوط النشطة التي يحذفها هذا الحفظ — يُقارن بها الخطّ الجديد (diffRouteStops)
      const before: RouteStopRef[] = [];
      // **خطٌّ واحد لكل حالة**: دائمٌ واحد للمندوب، ومؤقّتٌ واحد لليوم.
      // خطّان يجعلان «ما خط سيري اليوم؟» سؤالاً بلا جواب — فيُستبدل القديم
      // بدل أن يتراكما صامتَين. والاستبدال **حذفٌ فعليّ** لا تعطيل: لا نسخةٌ
      // مخفيّة تبقى للخطّ القديم (أمر المالك ٧ نوفمبر ٢٠٢٦).
      // **الخطّ المُحرَّر يُحذف بمعرّفه**: الاستبدال بالمفاتيح وحده يفشل متى
      // غُيّر أحدها (تاريخ أو نوع أو مندوب)، فيبقى القديم نشطاً ويعمل المندوب
      // على خطٍّ ظنّ المالك أنه بدّله — أو يراه مندوبان معاً في اليوم نفسه.
      if (replacedId) await deleteRoutes(tx, tid, { id: replacedId }, { collect: before });
      // بالمفاتيح بلا شرط isActive: يذهب النشط وما بقي موقوفاً من المسار القديم معاً.
      // والدائم بالمفاتيح لمن لا جدول له وحده — صاحب الجدول يجمع عدّة دوائم (طلب المالك ٢٢ نوفمبر ٢٠٢٦)
      if (!body.isPermanent) {
        await deleteRoutes(tx, tid, { salesRepId: body.salesRepId, isPermanent: false, routeDate: body.routeDate! }, { collect: before });
      } else if (!schedule) {
        await deleteRoutes(tx, tid, { salesRepId: body.salesRepId, isPermanent: true }, { collect: before });
      }
      // وبقايا التعطيل القديم لهذا المندوب (خطوطٌ «أُوقفت» قبل أمر الحذف الفعليّ) — لا يقرؤها شيء
      await deleteRoutes(tx, tid, { salesRepId: body.salesRepId, isActive: false });
      // موضع الدورة: المُحرَّر يبقى في موضعه، والجديد آخر الترتيب (الأكبر + 1)
      let rotationOrder = 0;
      if (body.isPermanent) {
        if (kept) rotationOrder = kept.rotationOrder;
        else {
          const rest = await tx.repRoute.findMany({
            where: { tenantId: tid, salesRepId: body.salesRepId, isPermanent: true }, select: { rotationOrder: true },
          });
          rotationOrder = rest.length ? Math.max(...rest.map(x => x.rotationOrder)) + 1 : 0;
        }
      }
      const r = await tx.repRoute.create({
        data: {
          tenantId: tid, salesRepId: body.salesRepId, name: body.name,
          isPermanent: body.isPermanent,
          routeDate: body.isPermanent ? null : body.routeDate!,
          weekdays, rotationOrder,
          /* الدائم المُحرَّر يرث تاريخ إنشاء سلفه (مراجعة ٢٢ نوفمبر ٢٠٢٦): الدائم لا يسري على يومٍ سبق إنشاءه، فتاريخٌ
           * جديد كان يُسقطه من الأيام الماضية — فتنتقل خطّة يومٍ مضى في التناوب (أو «أوّل دائم») إلى خطٍّ آخر */
          ...(kept && { createdAt: kept.createdAt }),
        },
      });
      // الترتيب من موضع العميل في المصفوفة — هو ما رتّبه المالك بعينه. و«أرشيف العميل»: العميل الباقي في خطّ مندوبه يرث تاريخ
      // دخوله (keptStopDates) — فإعادة الحفظ لا تجعل عضويته القديمة «دخولاً الآن» ولا تُسقط تاريخها قبل بدء السجلّ
      const joined = keptStopDates(before, body.salesRepId);
      for (let i = 0; i < stops.length; i++) {
        const since = joined.get(stops[i].customerId);
        await tx.repRouteStop.create({
          data: {
            tenantId: tid, routeId: r.id, customerId: stops[i].customerId, seq: i + 1, note: stops[i].note ?? null,
            ...(since && { createdAt: since }),
          },
        });
      }
      // «أرشيف العميل»: من دخل خطّ المندوب ومن خرج منه بهذا الحفظ — وإعادة الترتيب أو الملاحظة لعميلٍ باقٍ لا حدث لها
      const { added, removed } = diffRouteStops(before, stops.map(s => s.customerId), body.salesRepId);
      if (added.length || removed.length) {
        const reps = await repNamesOf(tx, tid, [body.salesRepId, ...removed.map(s => s.salesRepId)]);
        const seqOf = new Map(stops.map((s, i) => [s.customerId, i + 1]));
        const routeInfo = {
          routeName: body.name, salesRepId: body.salesRepId, ...(reps.get(body.salesRepId) && { repName: reps.get(body.salesRepId) }),
          isPermanent: body.isPermanent, ...(body.isPermanent ? (weekdays.length ? { weekdays } : {}) : { routeDate: body.routeDate }),
        };
        await recordActivityInTx(tx, [
          ...added.map(customerId => ({
            tenantId: tid, customerId, action: 'ROUTE_STOP_ADDED' as const, actor: meta.actor, source: meta.source,
            refType: 'ROUTE' as const, refId: r.id, data: { ...routeInfo, seq: seqOf.get(customerId) ?? null },
          })),
          ...stopRemovedEvents(tid, removed, meta, reps, 'ROUTE_SAVED'),
        ]);
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
    // «أرشيف العميل»: حذف الخطّ يُخرج كل عملائه منه — حدث ROUTE_STOP_REMOVED لكل عميل في معاملة الحذف نفسها
    const meta = activityMeta(req);
    await prisma.$transaction(tx => deleteRoutes(tx, tid, { OR: [{ id: r.id }, { salesRepId: r.salesRepId, isActive: false }] }, { record: { meta, reason: 'ROUTE_DELETED' } }));
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
