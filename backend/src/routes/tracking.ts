import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { adminRepFilter, scopedRepRecordWhere, scopedRecordWhere, canAccessRep, SHAPE_VISIT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { snapToRoads, routeThrough } from '../services/mapMatch';
import { buildRouteShape, haversineM } from '../services/routeShape';
import { isolationEnabled } from '../services/customerScope';
import { punchDeviceOf } from '../services/punchDevice';
import { attendanceEnabled, lockRepAttendance, REP_LOCK_TX } from '../services/attendanceEdit';
import { getVapidKeys, pushEndpointAllowed, pushKeysValid } from '../services/webPush';
import { heartbeatClientState } from '../services/repHeartbeat';
import { countStopsByRep, asVisitLike } from '../services/workDay';
import { correctCapturedAt, DEVICE_NOW_HEADER } from '../services/liveLocation';
import { readLiveVerdict } from '../middleware/repLiveLocation';
import { pingLimiter } from '../middleware/rateLimits';
import { publishLocationsChanged } from '../services/liveEvents';
import { pendingPresence, presenceOutcome, PRESENCE_TAP_HOLD_MS } from '../services/presenceChecks';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageTracking'));

// إعدادات التتبّع — هل التتبّع مفعّل على مستوى الشركة
router.get('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const s = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { trackingEnabled: true } });
    res.json({ success: true, data: { enabled: s?.trackingEnabled ?? false } });
  } catch (err) { next(err); }
});

router.patch('/settings', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    await prisma.companySettings.update({ where: { tenantId: tid }, data: { trackingEnabled: enabled } });
    res.json({ success: true, data: { enabled } });
  } catch (err) { next(err); }
});

const pingSchema = z.object({
  points: z.array(z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().optional(),
    speed: z.number().nullable().optional(),
    capturedAt: z.string().optional(),
  })).min(1).max(200),
});

// استقبال نقاط موقع المندوب (دفعة) — يخزّنها ويحدّث آخر موقع معروف
router.post('/ping', pingLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const tid = tenantId(req);
    const repId = req.user.id;
    const { points } = pingSchema.parse(req.body);

    // احترام إعدادات الخصوصية: لا نخزّن إن كان التتبّع موقوفاً أو المندوب مستثنى
    const [settings, rep] = await Promise.all([
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { trackingEnabled: true } }),
      prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { canBeTracked: true, requireLocationOn: true } }),
    ]);
    // «اشتراط تفعيل الموقع»: موقع المقيَّد يُخزَّن دائماً — ظهوره على الخريطة شرطُ عمله، فلا يُسقطه إيقاف
    // التتبّع للشركة ولا استثناؤه (لو أُسقط لما عمل أبداً). المدير فعّل القيد له صراحةً، والتلميح في إعداداته يقول ذلك.
    const strict = rep?.requireLocationOn === true;
    if (!strict && (!settings?.trackingEnabled || rep?.canBeTracked === false)) {
      res.json({ success: true, data: { stored: 0, disabled: true } });
      return;
    }

    // المقيَّد: لحظة القراءة بساعة الخادم (ساعة الجهاز تنحرف) ولا مستقبل — عليها يُحكم «طازجة أم قديمة»
    const serverNow = Date.now();
    const rows = points.map(p => ({
      tenantId: tid, salesRepId: repId, lat: p.lat, lng: p.lng,
      accuracy: p.accuracy ?? null, speed: p.speed ?? null,
      capturedAt: strict ? correctCapturedAt(p.capturedAt, req.headers[DEVICE_NOW_HEADER], serverNow)
        : p.capturedAt ? new Date(p.capturedAt) : new Date(),
    }));
    await prisma.repLocation.createMany({ data: rows });

    // أحدث نقطة = آخر موقع معروف (الإحداثيّات من نقطة العميل، أمّا «آخر ظهور» فبوقت
    // الخادم لا بساعة الجهاز: عدّاد «الزيارات الحية» يوازن lastSeenAt بنافذة وقت خادم
    // مطلقة، فساعةُ جهازٍ منحرفةٌ كانت ستُبقي المندوب «متصلاً» أطول/أقصر من حقيقته).
    // ولحظة الموقع lastLocAt بساعة الخادم (مصحَّحة لكل مندوب): بها تعرف اللوحة «موقعه الآن» من «متصل وموقعه قديم».
    // دفعةٌ أقدم تصل متأخّرة (أعاد التطبيق إرسالها بعد انقطاع) لا تُرجع الدبّوس إلى الوراء — تُخزَّن في المسار فقط
    const fixAt = points.map(p => correctCapturedAt(p.capturedAt, req.headers[DEVICE_NOW_HEADER], serverNow).getTime());
    const iLatest = fixAt.reduce((best, t, i) => (t > fixAt[best] ? i : best), 0);
    const latestAt = new Date(fixAt[iLatest]);
    const now = new Date();
    const moved = await prisma.salesRep.updateMany({
      where: { id: repId, OR: [{ lastLocAt: null }, { lastLocAt: { lt: latestAt } }] },
      data: { lastLat: rows[iLatest].lat, lastLng: rows[iLatest].lng, lastLocAt: latestAt, lastSeenAt: now },
    });
    // دفعةٌ أقدم لم تحرّك الدبّوس: لا حدث — لا جديد تقرؤه الخريطة
    if (moved.count === 0) await prisma.salesRep.update({ where: { id: repId }, data: { lastSeenAt: now } });
    else publishLocationsChanged(tid);

    // المقيَّد: حكم الخادم نفسه الذي يحرس كل إجراء (middleware/repLiveLocation.ts) في ردّ النقطة — به يرفع التطبيق حاجزه
    if (strict) {
      res.json({ success: true, data: { stored: rows.length, live: await readLiveVerdict(tid, repId) } });
      return;
    }
    res.json({ success: true, data: { stored: rows.length } });
  } catch (err) { next(err); }
});

// نبضة حضور من تطبيق المندوب — تُمدّد جلسة العمل الحالية أو تبدأ جديدة (مستقلّة عن GPS).
// تُحسب منها ساعات العمل (الوقت الذي كان فيه متصلاً وفاتحاً التطبيق).
router.post('/heartbeat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const tid = tenantId(req);
    const repId = req.user.id;
    const now = new Date();
    const GAP_MS = 3 * 60 * 1000; // فجوة أكبر من 3 دقائق ⇒ جلسة جديدة (اعتُبر التطبيق مُغلقاً)

    const last = await prisma.repSession.findFirst({
      where: { tenantId: tid, salesRepId: repId },
      orderBy: { lastBeatAt: 'desc' },
      select: { id: true, lastBeatAt: true },
    });
    if (last && now.getTime() - new Date(last.lastBeatAt).getTime() <= GAP_MS) {
      await prisma.repSession.update({ where: { id: last.id }, data: { lastBeatAt: now } });
    } else {
      await prisma.repSession.create({ data: { tenantId: tid, salesRepId: repId, startedAt: now, lastBeatAt: now } });
    }
    // آخر ظهور = الآن (يجعل مؤشّر «متصل» يعكس فتح التطبيق حتى بلا GPS)
    // + حالة الجهاز الاختيارية من الحزمة الحديثة (Z5.0: الحزمة وعدّا الصفّ الصادر) في التحديث نفسه — جسم غائب ⇒ كما كان
    const beat = await prisma.salesRep.update({
      where: { id: repId }, data: { lastSeenAt: now, ...heartbeatClientState(req.body, now) }, select: { requirePresenceCheck: true },
    });

    // «التحقق العشوائي من التواجد»: طلبٌ أُرسل ولم يُجب — يصل التطبيق المفتوح بلا تنبيهات مفعّلة (الإشعار هو الطريق الأول)
    const presence = beat.requirePresenceCheck && (await attendanceEnabled(tid)) ? await pendingPresence(tid, repId, now) : null;
    res.json({ success: true, data: { presence } });
  } catch (err) { next(err); }
});

// ═══ بصمة الحضور والانصراف ═══
// المندوب يعلن بداية عمله ونهايته بضغطة، فتُحسب ساعاته من إعلانه لا من نبضة الاتصال.
// نوبة واحدة مفتوحة (checkOutAt = null) في كل لحظة: الحضور يفتحها، والانصراف يغلقها.
// وكل دخولٍ يُسجَّل وكل خروجٍ يُسجَّل: حضورٌ بعد انصرافٍ في اليوم نفسه نوبةٌ جديدة (الدوام المتقطّع).
// لا عتبة زمنية ولا حدّ لعدد النوبات — التقرير يعرض فترةً لكل نوبة، وما بينها استراحة.

const punchSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // نصف قطر دقّة القراءة كما يعطيه الجوال — يحكم به «بصمة الحضور بموقع عميل» (judgePunchPlace)
  accuracy: z.number().finite().min(0).max(1_000_000).optional(),
  // جهاز البصمة: معرّف التطبيق على الجهاز ووصفه (services/punchDevice.ts) — يُنقّيان هناك، فحزمةٌ أقدم بلا جهاز لا تُردّ بـ400
  deviceId: z.unknown().optional(),
  deviceName: z.unknown().optional(),
});

// حارس الميزة: يفعّلها المالك لكل شركة (Tenant.attendanceEnabled — services/attendanceEdit.ts). مطفأة ⇒ 403 حتى لو نادى
// التطبيقُ النقطةَ مباشرة. المندوب المصرّح وحده يصل هنا (الفحص في كل معالج)؛ هذا يضيف شرط الاشتراك دفاعاً في العمق.

async function ensureRepAttendance(req: AuthRequest, res: Response): Promise<{ tid: string; repId: string } | null> {
  if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return null; }
  const tid = tenantId(req);
  if (!(await attendanceEnabled(tid))) { res.status(403).json({ success: false, code: 'ATTENDANCE_DISABLED', message: 'ميزة بصمة الحضور غير مفعّلة' }); return null; }
  return { tid, repId: req.user.id };
}

// «اشتراط تفعيل الموقع» لا يحرس البصمة (أمر المالك، ٧ أكتوبر ٢٠٢٦): القيد على صفحة العميل وحدها — موقع البصمة أفضل جهد
// للجميع، يُسجَّل إن أرسله الجوال ولا تُردّ بغيابه.

/**
 * «بصمة الحضور بموقع عميل» — قيدٌ تقييديّ على المندوب: مفعّلٌ ⇒ البصمة داخل المسافة التي حدّدتها الإدارة له
 * (`punchRadiusM`، ١٠–٥٠٠٠ م، ٥٠ افتراضاً) من موقع أحد عملائه المسجَّل. وخارجها: تُردّ (`punchOutsideAction`=REJECT،
 * السلوك الأول) أو تُقبل بوسم «خارج النطاق» ومسافة أقرب عميل تراها الإدارة (FLAG، طلب المالك ٢١ أكتوبر ٢٠٢٦).
 *
 * «عملاؤه» بالنطاق نفسه الذي يرى به قائمته (customerScope): المُسنَدون له حين يكون العزل مفعّلاً، وعملاء الشركة
 * كلّهم حين لا يكون. والعميل المحذوف يسقط، والعميل بلا إحداثيات لا يُحتسب.
 *
 * أقرب العملاء يُرتَّبون **في القاعدة** (nearestCustomersM) لا عيّنةً منها: سقف «ألف عميل» من مربّع البحث كان يكفي
 * المسافات الصغيرة، لكن نطاق كيلومترات في مدينةٍ كثيفة يملأ المربّع بآلاف العملاء، فقد تُختار زواياه البعيدة وحدها
 * ويُرفض صادقٌ عند باب عميله («يعمل على كل المسافات»، طلب المالك ٢١ أكتوبر ٢٠٢٦).
 *
 * ودقّة القراءة (بلاغ «لا يعمل إلا بـ٣٠٠ متر»): الجوال يقرأ قراءةً طازجة بأفضل دقّة (rep/punchFix.ts)، ويُسامَح هنا
 * بقدر هامش خطأ الجهاز حتى ٢٥ متراً. وقراءةٌ أسوأ من النطاق نفسه — وعميلٌ قد يقع داخله في حدود خطئها — لا يُحكم بها
 * بُعداً: «موقعك غير دقيق». والرمز يبقى PUNCH_AWAY_FROM_CUSTOMER بسببٍ فرعيّ (reason) لا رمزاً جديداً: حزمةٌ أقدم
 * مفتوحة على جوال مندوب ترسل الدقّة أيضاً، ورمزٌ لا تعرفه تبتلعه بلا رسالة.
 */
export const PUNCH_RADIUS_M = 50;
/** أقصى ما يُسامَح به من هامش خطأ الجهاز فوق مسافة الإدارة — فقراءةٌ رديئة لا تفتح القيد مهما ادّعت */
export const PUNCH_ACCURACY_ALLOWANCE_M = 25;
/** أقلّ مدى يُبحث فيه عن أقرب عميل — رفضٌ بالبُعد يذكر مسافته فيكشف للإدارة موقع عميلٍ مسجَّلاً خطأً */
const PUNCH_NEAREST_SEARCH_M = 2000;
/** مسافة المندوب كما خُزّنت — وقيمةٌ فاسدة (يدويّاً في القاعدة) لا تُسقط القيد: تعود إلى الافتراض */
export function punchRadiusOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 5000 ? v : PUNCH_RADIUS_M;
}
/** السماحية من دقّة القراءة: هامش خطأ الجهاز حتى سقفه — وغائبةٌ (جهازٌ لا يعطيها) صفر كما كان الحكم.
 *  والحزمة الأقدم ترسل دقّة قراءتها المخبّأة أيضاً فتنالها السماحية بسقفها نفسه */
export function punchAllowanceOf(accuracy: unknown): number {
  return typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy > 0 ? Math.min(accuracy, PUNCH_ACCURACY_ALLOWANCE_M) : 0;
}
/** قراءةٌ هامش خطئها أوسع من النطاق المسموح (ومن ٥٠م) لا تكفي للحكم بأن المندوب بعيد */
export function punchFixTooCoarse(accuracy: unknown, radius: number): boolean {
  return typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy > Math.max(radius, PUNCH_RADIUS_M);
}
/** خارج النطاق: REJECT تردّ البصمة (الافتراض)، FLAG تقبلها بوسم */
export type PunchOutsideAction = 'REJECT' | 'FLAG';
export const punchOutsideActionOf = (v: unknown): PunchOutsideAction => (v === 'FLAG' ? 'FLAG' : 'REJECT');

type PunchRefusal = { code: 'PUNCH_AWAY_FROM_CUSTOMER'; reason?: 'LOW_ACCURACY' | 'DEVICE'; message: string };
const boxAround = (lat: number, lng: number, m: number) => {
  const dLat = m / 111320;
  const dLng = m / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { lat: { gte: lat - dLat, lte: lat + dLat }, lng: { gte: lng - dLng, lte: lng + dLng } };
};

/**
 * مسافات أقرب عملاء المندوب من نقطة بالأمتار، تصاعدياً. الترتيب في القاعدة بمسافةٍ مسطّحة (دقيقةٌ لبضعة كيلومترات)،
 * ثمّ هافرساين هنا لأقرب ثمانية. والنطاق كـcustomerScope للمندوب: كل عملاء الشركة، أو المُسنَدون له حين يكون العزل مفعّلاً.
 */
async function nearestCustomersM(tid: string, repId: string, lat: number, lng: number, searchM: number): Promise<number[]> {
  const isolated = await isolationEnabled(tid);
  const b = boxAround(lat, lng, searchM);
  const mLng = 111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  const rows = await prisma.$queryRaw<{ lat: number; lng: number }[]>`
    SELECT c."lat", c."lng" FROM "customers" c
    WHERE c."tenantId" = ${tid} AND c."status" <> 'DELETED'
      AND c."lat" IS NOT NULL AND c."lng" IS NOT NULL
      AND c."lat" BETWEEN ${b.lat.gte}::float8 AND ${b.lat.lte}::float8
      AND c."lng" BETWEEN ${b.lng.gte}::float8 AND ${b.lng.lte}::float8
      ${isolated ? Prisma.sql`AND EXISTS (SELECT 1 FROM "customer_assignments" ca WHERE ca."customerId" = c."id" AND ca."salesRepId" = ${repId})` : Prisma.empty}
    ORDER BY ((c."lat" - ${lat}::float8) * 111320.0) ^ 2 + ((c."lng" - ${lng}::float8) * ${mLng}::float8) ^ 2
    LIMIT 8`;
  return rows
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng))
    .map((c) => haversineM({ lat, lng }, { lat: c.lat, lng: c.lng }))
    .sort((x, y) => x - y);
}

/** حكم مكان بصمةٍ لمندوبٍ مقيَّد: هل هو داخل النطاق (بسماحية الدقّة)، وأقرب عميل، وسبب الخروج */
export interface PunchPlace { inside: boolean; nearestM: number | null; radius: number; accuracy: number | null; lowAccuracy: boolean; noFix: boolean }
async function judgePunchPlace(tid: string, repId: string, radiusRaw: unknown, lat?: number, lng?: number, accuracy?: number): Promise<PunchPlace> {
  const radius = punchRadiusOf(radiusRaw);
  const acc = typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null;
  if (lat == null || lng == null) return { inside: false, nearestM: null, radius, accuracy: acc, lowAccuracy: false, noFix: true };
  const reach = radius + punchAllowanceOf(accuracy);
  const dists = await nearestCustomersM(tid, repId, lat, lng, Math.max(reach, PUNCH_NEAREST_SEARCH_M));
  const nearest = dists.length ? dists[0] : null;
  const inside = nearest != null && nearest <= reach;
  // الدقّة سببٌ فقط حين قد يقع عميلٌ داخل النطاق في حدود خطئها — المندوب البعيد كيلومترات يُقال له بُعده لا «انتظر»
  const lowAccuracy = !inside && nearest != null && punchFixTooCoarse(accuracy, radius) && nearest - acc! <= radius;
  return { inside, nearestM: nearest, radius, accuracy: acc, lowAccuracy, noFix: false };
}

/** نصّ رفض البصمة خارج النطاق */
function placeRefusal(p: PunchPlace): PunchRefusal {
  if (p.noFix) return { code: 'PUNCH_AWAY_FROM_CUSTOMER', message: 'فعّل الموقع في جوالك — البصمة مشروطة بأن تكون عند أحد عملائك' };
  if (p.lowAccuracy) {
    return { code: 'PUNCH_AWAY_FROM_CUSTOMER', reason: 'LOW_ACCURACY', message: `موقعك غير دقيق الآن (±${Math.round(p.accuracy!)} م) — انتظر لحظات أو اقترب من مكان مفتوح ثم أعد المحاولة` };
  }
  const where = p.nearestM != null
    ? ` — أقرب عملائك على بعد ${Math.round(p.nearestM)} مترا منك`
    : ' — لا عميل لك قريب من موقعك الحالي';
  return { code: 'PUNCH_AWAY_FROM_CUSTOMER', message: `البصمة مشروطة بأن تكون داخل ${p.radius} مترا من موقع أحد عملائك${where}` };
}

/** ما يُكتب على صفّ البصمة من حكم المكان: null للمندوب غير المقيّد، وإلّا داخل/خارج ومسافة أقرب عميل */
const placeColumns = (p: PunchPlace | null) => (p
  ? { outside: !p.inside, distanceM: p.nearestM != null ? Math.round(p.nearestM) : null }
  : { outside: null, distanceM: null });

type RepPunchPolicy = {
  requirePunchAtCustomer: boolean; punchRadiusM: number; punchOutsideAction: string;
  requireBoundDevice: boolean; boundDeviceId: string | null; boundDeviceName: string | null;
};
const REP_PUNCH_SELECT = {
  requirePunchAtCustomer: true, punchRadiusM: true, punchOutsideAction: true,
  requireBoundDevice: true, boundDeviceId: true, boundDeviceName: true,
} as const;

const deviceMismatch = (boundName: string | null | undefined): PunchRefusal => ({
  code: 'PUNCH_AWAY_FROM_CUSTOMER', reason: 'DEVICE',
  message: `حسابك مربوط بجهاز آخر${boundName ? ` (${boundName})` : ''} — ابصم منه أو اطلب من الإدارة فكّ ربط جهازك`,
});

/**
 * «ربط البصمة بجهاز واحد» (ضد البصمة بالنيابة): مقيَّدٌ ⇒ لا بصمة إلا من جهازه المربوط. أول بصمةٍ مقبولة تربط
 * جهازها (bindFirstDevice)، ولا يُربط جهازٌ مربوطٌ بمندوبٍ آخر مقيَّد في الشركة — جوالٌ واحد لا يبصم لاثنين.
 * حزمةٌ أقدم بلا معرّف تُردّ برسالةٍ تُفهم: إعادة فتح التطبيق تحمّل الأحدث فيرسل المعرّف.
 */
async function deviceRefusal(tid: string, repId: string, rep: RepPunchPolicy, device: { id: string | null }): Promise<PunchRefusal | null> {
  if (rep.requireBoundDevice !== true) return null;
  if (!device.id) return { code: 'PUNCH_AWAY_FROM_CUSTOMER', reason: 'DEVICE', message: 'أغلق التطبيق وافتحه من جديد ثم أعد المحاولة — بصمتك مربوطة بجهازك' };
  if (rep.boundDeviceId) return rep.boundDeviceId === device.id ? null : deviceMismatch(rep.boundDeviceName);
  const other = await prisma.salesRep.findFirst({
    // كل ربطٍ قائم ولو أُطفئ قيد صاحبه مؤقتاً: وإلّا رُبط الجوال نفسه بحسابين فيبصم لهما معاً حين يُعاد القيد
    where: { tenantId: tid, id: { not: repId }, boundDeviceId: device.id },
    select: { id: true },
  });
  return other ? { code: 'PUNCH_AWAY_FROM_CUSTOMER', reason: 'DEVICE', message: 'هذا الجهاز مربوط بحساب مندوب آخر — ابصم من جوالك' } : null;
}

class PunchRefused extends Error { constructor(public refusal: PunchRefusal) { super(refusal.message); } }

/** أول بصمةٍ مقبولة لمقيَّدٍ بلا جهاز تربط جهازها — ذرّياً: بصمتان متزامنتان من جهازين يُربط أحدهما ويُردّ الآخر */
async function bindFirstDevice(tx: Prisma.TransactionClient, repId: string, rep: RepPunchPolicy, device: { id: string | null; name: string }): Promise<void> {
  if (rep.requireBoundDevice !== true || rep.boundDeviceId || !device.id) return;
  const n = await tx.salesRep.updateMany({
    where: { id: repId, boundDeviceId: null },
    data: { boundDeviceId: device.id, boundDeviceName: device.name, boundDeviceAt: new Date() },
  });
  if (n.count === 1) return;
  const now = await tx.salesRep.findUnique({ where: { id: repId }, select: { boundDeviceId: true, boundDeviceName: true } });
  if (now?.boundDeviceId !== device.id) throw new PunchRefused(deviceMismatch(now?.boundDeviceName));
}

const OPEN_SHIFT_SELECT = { id: true, checkInAt: true, checkInLat: true, checkInLng: true, checkInOutside: true, checkInDistanceM: true } as const;

/** النوبة المفتوحة لهذا المندوب (بلا انصراف)، أو null. */
async function openShift(db: Prisma.TransactionClient | typeof prisma, tid: string, repId: string) {
  return db.repAttendance.findFirst({
    where: { tenantId: tid, salesRepId: repId, checkOutAt: null },
    orderBy: { checkInAt: 'desc' },
    select: OPEN_SHIFT_SELECT,
  });
}

/** بداية يوم المندوب المحلي (لحظة UTC) بإزاحته شرقي UTC بالدقائق — إزاحةٌ غائبة/فاسدة ⇒ يوم UTC */
function repDayStart(tzOffsetMin: unknown): Date {
  const n = Number(tzOffsetMin || 0);
  const off = Number.isFinite(n) ? Math.max(-840, Math.min(840, n)) : 0;
  const d = new Date(Date.now() + off * 60000);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - off * 60000);
}

/**
 * بصمات اليوم كلها — كل دخولٍ وكل خروج — ليرى المندوب ما سُجّل له. الدوام المتقطّع نوباتٌ متتالية
 * (حضور→انصراف ثم حضورٌ جديد)، والتقرير يعرض فترةً لكل نوبة؛ فالقائمة هنا هي ما سيراه المشرف.
 * تشمل: ما بدأ اليوم، وما انتهى اليوم (نوبةٌ عبرت منتصف الليل)، والمفتوحة ولو من أمس (نسي الانصراف).
 */
async function dayShifts(tid: string, repId: string, since: Date) {
  // الأحدث أولاً بسقفٍ (حارسٌ لا حدّ عمل)، ثم تُعرض بترتيب وقوعها
  const rows = await prisma.repAttendance.findMany({
    where: { tenantId: tid, salesRepId: repId, OR: [{ checkInAt: { gte: since } }, { checkOutAt: { gte: since } }, { checkOutAt: null }] },
    orderBy: { checkInAt: 'desc' },
    take: 50,
    select: { checkInAt: true, checkOutAt: true, checkInOutside: true, checkOutOutside: true },
  });
  return rows.reverse();
}

// حالة اليوم: النوبة المفتوحة إن وُجدت، وإلا آخر نوبة مغلقة اليوم — ليعرف التطبيق أيّ زرّ يعرض —
// ومعها بصمات اليوم كلها (shifts). بعد الانصراف يبقى زرّ الحضور متاحاً لفترةٍ جديدة في اليوم نفسه.
router.get('/attendance/today', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const { tid, repId } = ctx;
    const since = repDayStart(req.query.tzOffsetMin);
    const [open, shifts] = await Promise.all([openShift(prisma, tid, repId), dayShifts(tid, repId, since)]);
    if (open) { res.json({ success: true, data: { status: 'in', shift: open, shifts } }); return; }
    // آخر نوبة انتهت اليوم (يوم المندوب بإزاحته) — لعرض «خرجت الساعة …» بدل «لم تسجّل حضورك» فوراً بعد الانصراف
    const last = await prisma.repAttendance.findFirst({
      where: { tenantId: tid, salesRepId: repId, checkOutAt: { gte: since } },
      orderBy: { checkOutAt: 'desc' },
      select: { checkInAt: true, checkOutAt: true },
    });
    res.json({ success: true, data: { status: last ? 'out' : 'none', last, shifts } });
  } catch (err) { next(err); }
});

/**
 * حكم بصمةٍ قبل كتابتها: الجهاز (ربطٌ مقيَّد)، ثم المكان (بصمة بموقع عميل) — يعيد رفضاً، أو حكم المكان للصفّ.
 * غير المقيَّد بالمكان لا يُستعلم له عن عملاء: لا حكم ولا وسم (null).
 */
async function judgePunch(tid: string, repId: string, rep: RepPunchPolicy, device: { id: string | null }, lat?: number, lng?: number, accuracy?: number):
  Promise<{ refusal: PunchRefusal } | { place: PunchPlace | null }> {
  const byDevice = await deviceRefusal(tid, repId, rep, device);
  if (byDevice) return { refusal: byDevice };
  if (rep.requirePunchAtCustomer !== true) return { place: null };
  const place = await judgePunchPlace(tid, repId, rep.punchRadiusM, lat, lng, accuracy);
  if (!place.inside && punchOutsideActionOf(rep.punchOutsideAction) === 'REJECT') return { refusal: placeRefusal(place) };
  return { place };
}

// تسجيل الحضور — يفتح نوبة. نوبةٌ مفتوحة سلفاً تُعاد كما هي (لا تُفتح ثانية) فيأمن الضغط المكرّر.
router.post('/attendance/checkin', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const { tid, repId } = ctx;
    const body = punchSchema.parse(req.body ?? {});
    const { lat, lng, accuracy } = body;
    const device = punchDeviceOf(body, req.get('user-agent'));
    const since = repDayStart(req.query.tzOffsetMin);
    // نوبةٌ مفتوحة تُعاد كما هي: الضغط المكرّر لا يكتب شيئاً
    const existing = await openShift(prisma, tid, repId);
    if (existing) { res.json({ success: true, data: { status: 'in', shift: existing, already: true, shifts: await dayShifts(tid, repId, since) } }); return; }
    const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: REP_PUNCH_SELECT });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const verdict = await judgePunch(tid, repId, rep, device, lat, lng, accuracy);
    if ('refusal' in verdict) { res.status(409).json({ success: false, ...verdict.refusal }); return; }
    const place = placeColumns(verdict.place);
    const out = await prisma.$transaction(async (tx) => {
      await lockRepAttendance(tx, repId);
      // تحت القفل: طلبٌ متزامن سبق ففتح نوبة ⇒ تُعاد كما هي، لا تُفتح ثانية
      const again = await openShift(tx, tid, repId);
      if (again) return { already: again };
      await bindFirstDevice(tx, repId, rep, device);
      const shift = await tx.repAttendance.create({
        data: {
          tenantId: tid, salesRepId: repId, checkInAt: new Date(), checkInLat: lat ?? null, checkInLng: lng ?? null,
          checkInDeviceId: device.id, checkInDevice: device.name,
          checkInOutside: place.outside, checkInDistanceM: place.distanceM,
        },
        select: OPEN_SHIFT_SELECT,
      });
      return { shift };
    }, REP_LOCK_TX);
    const shifts = await dayShifts(tid, repId, since);
    if ('already' in out) { res.json({ success: true, data: { status: 'in', shift: out.already, already: true, shifts } }); return; }
    res.json({ success: true, data: { status: 'in', shift: out.shift, shifts, ...(place.outside ? { place } : {}) } });
  } catch (err) {
    if (err instanceof PunchRefused) { res.status(409).json({ success: false, ...err.refusal }); return; }
    next(err);
  }
});

// تسجيل الانصراف — يغلق النوبة المفتوحة. بلا نوبة مفتوحة ⇒ 409 (لم يسجّل حضوراً بعد).
router.post('/attendance/checkout', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const { tid, repId } = ctx;
    const body = punchSchema.parse(req.body ?? {});
    const { lat, lng, accuracy } = body;
    const device = punchDeviceOf(body, req.get('user-agent'));
    const open = await openShift(prisma, tid, repId);
    if (!open) { res.status(409).json({ success: false, code: 'NO_OPEN_SHIFT', message: 'لم تسجّل حضوراً بعد' }); return; }
    const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: REP_PUNCH_SELECT });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const verdict = await judgePunch(tid, repId, rep, device, lat, lng, accuracy);
    if ('refusal' in verdict) { res.status(409).json({ success: false, ...verdict.refusal }); return; }
    const place = placeColumns(verdict.place);
    const shift = await prisma.$transaction(async (tx) => {
      await lockRepAttendance(tx, repId);
      const current = await openShift(tx, tid, repId);
      if (!current) return null;
      await bindFirstDevice(tx, repId, rep, device);
      return tx.repAttendance.update({
        where: { id: current.id },
        data: {
          checkOutAt: new Date(), checkOutLat: lat ?? null, checkOutLng: lng ?? null,
          checkOutDeviceId: device.id, checkOutDevice: device.name,
          checkOutOutside: place.outside, checkOutDistanceM: place.distanceM,
        },
        select: { checkInAt: true, checkOutAt: true },
      });
    }, REP_LOCK_TX);
    if (!shift) { res.status(409).json({ success: false, code: 'NO_OPEN_SHIFT', message: 'لم تسجّل حضوراً بعد' }); return; }
    res.json({ success: true, data: { status: 'out', last: shift, shifts: await dayShifts(tid, repId, repDayStart(req.query.tzOffsetMin)), ...(place.outside ? { place } : {}) } });
  } catch (err) {
    if (err instanceof PunchRefused) { res.status(409).json({ success: false, ...err.refusal }); return; }
    next(err);
  }
});

// ═══ التحقق العشوائي من التواجد (طلب المالك، ٢٢ أكتوبر ٢٠٢٦) — services/presenceChecks.ts ═══
// الخادم يرسل «أثبت تواجدك» في موعدٍ عشوائي، والمندوب يضغط «أثبت تواجدي» فيُرسل التطبيق قراءةً طازجة. الموعد لا يُكشف قبل
// إرساله: هذه النقطة تعيد الطلب المعلّق وحده.

router.get('/presence', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    res.json({ success: true, data: await pendingPresence(ctx.tid, ctx.repId) });
  } catch (err) { next(err); }
});

// لحظة الضغط على «أثبت تواجدي» بساعة الخادم — قبل قراءة الموقع: بها يُحكم، فثواني القراءة والشبكة الميدانية لا تُحسب عليه
router.post('/presence/:id/tap', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const now = new Date();
    const check = await prisma.presenceCheck.findFirst({
      where: { id: String(req.params.id), tenantId: ctx.tid, salesRepId: ctx.repId, status: 'SENT' },
      select: { id: true, sentAt: true },
    });
    if (!check?.sentAt || !presenceOutcome(check.sentAt, now)) { res.json({ success: true, data: { tapped: false } }); return; }
    const n = await prisma.presenceCheck.updateMany({ where: { id: check.id, status: 'SENT', tappedAt: null }, data: { tappedAt: now } });
    res.json({ success: true, data: { tapped: n.count === 1 } });
  } catch (err) { next(err); }
});

router.post('/presence/:id/respond', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const { tid, repId } = ctx;
    const body = punchSchema.parse(req.body ?? {});
    const now = new Date();
    const check = await prisma.presenceCheck.findFirst({
      where: { id: String(req.params.id), tenantId: tid, salesRepId: repId },
      select: { id: true, status: true, sentAt: true, tappedAt: true, lat: true },
    });
    if (!check) { res.status(404).json({ success: false, message: 'طلب التحقق غير موجود' }); return; }
    // ردٌّ وصل وضاع جوابه في الشبكة فأُعيد: حكمه كما سُجّل، لا «انتهى» يوهمه أنه فشل
    if (check.status === 'PASSED' || check.status === 'LATE') {
      res.json({ success: true, data: { status: check.status, located: check.lat != null } }); return;
    }
    if (check.status !== 'SENT' || !check.sentAt) {
      res.status(409).json({ success: false, code: 'PRESENCE_CLOSED', message: 'انتهى طلب التحقق' }); return;
    }
    // يُحكم بلحظة الضغط إن سُجّلت والردّ وصل بعدها خلال ٧٥ ثانية (قراءة الموقع والشبكة)، وإلّا بلحظة الوصول — فلا يُضغط ثم يُمشى
    const judgedAt = check.tappedAt && now.getTime() - check.tappedAt.getTime() <= PRESENCE_TAP_HOLD_MS ? check.tappedAt : now;
    const outcome = presenceOutcome(check.sentAt, judgedAt);
    if (!outcome) { res.status(409).json({ success: false, code: 'PRESENCE_EXPIRED', message: 'انتهت مهلة التحقق' }); return; }
    const { lat, lng, accuracy } = body;
    const hasFix = lat != null && lng != null;
    const device = punchDeviceOf(body, req.get('user-agent'));
    const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { requireBoundDevice: true, boundDeviceId: true } });
    const nearest = hasFix ? (await nearestCustomersM(tid, repId, lat, lng, PUNCH_NEAREST_SEARCH_M))[0] ?? null : null;
    // التحويل الشرطيّ: ردّان متزامنان (ضغطتان) يُكتب أولهما وحده
    const done = await prisma.presenceCheck.updateMany({
      where: { id: check.id, status: 'SENT' },
      data: {
        status: outcome, respondedAt: now, delaySec: Math.round((judgedAt.getTime() - check.sentAt.getTime()) / 1000),
        lat: hasFix ? lat : null, lng: hasFix ? lng : null, accuracy: hasFix && accuracy != null ? accuracy : null,
        distanceM: nearest != null ? Math.round(nearest) : null,
        deviceId: device.id, device: device.name,
        otherDevice: rep?.requireBoundDevice === true && rep.boundDeviceId ? device.id !== rep.boundDeviceId : null,
      },
    });
    if (done.count !== 1) {
      // سبقه ردٌّ متزامن (ضغطتان): حكمُ الأول
      const first = await prisma.presenceCheck.findFirst({ where: { id: check.id }, select: { status: true, lat: true } });
      if (first && (first.status === 'PASSED' || first.status === 'LATE')) { res.json({ success: true, data: { status: first.status, located: first.lat != null } }); return; }
      res.status(409).json({ success: false, code: 'PRESENCE_CLOSED', message: 'انتهى طلب التحقق' }); return;
    }
    res.json({ success: true, data: { status: outcome, located: hasFix } });
  } catch (err) { next(err); }
});

// ═══ تنبيهات الحضور على جوال المندوب (Web Push، طلب المالك ٢١ أكتوبر ٢٠٢٦) — services/webPush.ts و attendanceAlerts.ts ═══
// المندوب يوافق على الإشعارات من شاشة البصمة، فيُحفظ اشتراك جهازه ومعه إزاحة توقيته (لحساب «قبل الدوام» بتوقيته).

/** أقصى اشتراكات المندوب — جهازٌ جديد يُبقي الأحدث خمسة */
const MAX_PUSH_SUBS_PER_REP = 5;
const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().max(1000),
    keys: z.object({ p256dh: z.string().min(60).max(200), auth: z.string().min(16).max(64) }),
  }),
  tzOffsetMin: z.number().int().min(-840).max(840).optional(),
  lang: z.string().max(8).optional(),
});

router.get('/push/key', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    res.json({ success: true, data: { publicKey: (await getVapidKeys()).publicKey } });
  } catch (err) { next(err); }
});

router.post('/push/subscribe', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const { tid, repId } = ctx;
    const b = pushSubscribeSchema.parse(req.body ?? {});
    // الخادم سيرسل إلى هذا الرابط: خدمات الإشعارات المعروفة وحدها (لا عناوين داخلية)
    if (!pushEndpointAllowed(b.subscription.endpoint)) { res.status(400).json({ success: false, message: 'رابط الإشعارات غير مدعوم' }); return; }
    if (!pushKeysValid(b.subscription.keys.p256dh, b.subscription.keys.auth)) { res.status(400).json({ success: false, message: 'مفاتيح الإشعارات غير صالحة' }); return; }
    const lang = b.lang && /^[a-z]{2}$/.test(b.lang) ? b.lang : null;
    // الجهاز نفسه بحسابٍ آخر (تبديل الحسابات): الاشتراك ينتقل إلى من سجّل دخوله الآن
    await prisma.repPushSubscription.upsert({
      where: { endpoint: b.subscription.endpoint },
      create: { tenantId: tid, salesRepId: repId, endpoint: b.subscription.endpoint, p256dh: b.subscription.keys.p256dh, auth: b.subscription.keys.auth, lang },
      update: { tenantId: tid, salesRepId: repId, p256dh: b.subscription.keys.p256dh, auth: b.subscription.keys.auth, lang },
    });
    const extra = await prisma.repPushSubscription.findMany({
      where: { salesRepId: repId }, orderBy: { updatedAt: 'desc' }, skip: MAX_PUSH_SUBS_PER_REP, select: { id: true },
    });
    if (extra.length) await prisma.repPushSubscription.deleteMany({ where: { id: { in: extra.map((x) => x.id) } } });
    if (b.tzOffsetMin != null) await prisma.salesRep.update({ where: { id: repId }, data: { tzOffsetMin: b.tzOffsetMin } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/push/unsubscribe', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const endpoint = z.object({ endpoint: z.string().max(1000) }).parse(req.body ?? {}).endpoint;
    await prisma.repPushSubscription.deleteMany({ where: { endpoint, salesRepId: req.user.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// المواقع الحالية لكل المناديب — للأدمن (الخريطة الحيّة) مع عدّاد زيارات اليوم.
// lite=1: المواقع وحدها بلا عدّاد الزيارات (أثقل ما في المسار) — تقرؤها الخريطة عند حدث «locations» كل ثوانٍ، والكاملة كل دقيقة
router.get('/live', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const lite = req.query.lite === '1';

    const [reps, visitRows] = await Promise.all([
      // كل المناديب النشطين (لا فقط من أرسل موقعاً) — كي يظهر المضاف حديثاً فوراً؛
      // من له موقع أوّلاً (nulls last)، ومن لم يُحدّد موقعه بعد يظهر بلا دبّوس على الخريطة
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true, ...(await adminRepFilter(req)) },
        select: { id: true, name: true, phone: true, isActive: true, lastLat: true, lastLng: true, lastSeenAt: true, lastLocAt: true },
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
      }),
      // الوقفات لا السجلّات — عدّاد الخريطة يطابق قائمة زياراتها
      lite ? Promise.resolve(null) : prisma.repVisit.findMany({
        where: { tenantId: tid, createdAt: { gte: dayStart }, ...(await scopedRecordWhere(req, SHAPE_VISIT)) },
        select: { salesRepId: true, customerId: true, createdAt: true, startedAt: true, durationSec: true, customer: { select: { name: true } } },
        take: 20000,
      }),
    ]);
    // serverNow: ساعة الخادم — بها تحسب اللوحة عمر الموقع ولو انحرفت ساعة جهاز المدير
    if (!visitRows) { res.json({ success: true, data: reps, serverNow: Date.now() }); return; }
    const visitsByRep = countStopsByRep(visitRows.map(asVisitLike));

    res.json({ success: true, data: reps.map(r => ({ ...r, visitsToday: visitsByRep[r.id] || 0 })), serverNow: Date.now() });
  } catch (err) { next(err); }
});

// خطّ سير مندوب في يوم محدّد — للأدمن
router.get('/route', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const salesRepId = req.query.salesRepId as string | undefined;
    if (!salesRepId) { res.status(400).json({ success: false, message: 'يجب تحديد المندوب' }); return; }
    const dateStr = (req.query.date as string | undefined) || new Date().toISOString().slice(0, 10);
    const start = new Date(`${dateStr}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    // مندوب خارج نطاق المستخدم ⇒ لا خطّ سير (وإلا كُشف مساره بتمرير معرّفه)
    if (!(await canAccessRep(req, tid, salesRepId))) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const points = await prisma.repLocation.findMany({
      where: { tenantId: tid, salesRepId, capturedAt: { gte: start, lt: end }, ...(await scopedRepRecordWhere(req)) },
      orderBy: { capturedAt: 'asc' }, take: 5000,
      select: { lat: true, lng: true, accuracy: true, speed: true, capturedAt: true },
    });

    // بصمة الحضور/الانصراف لهذا اليوم — لتوضيح «من أين بدأ عمله بالضبط» على الخريطة.
    // أوّل بصمة حضور لها موقع، وآخر بصمة انصراف لها موقع (قد تختلف عن أوّل/آخر رصد GPS).
    const shifts = await prisma.repAttendance.findMany({
      where: { tenantId: tid, salesRepId, checkInAt: { gte: start, lt: end }, ...(await scopedRepRecordWhere(req)) },
      orderBy: { checkInAt: 'asc' },
      select: { checkInAt: true, checkInLat: true, checkInLng: true, checkOutAt: true, checkOutLat: true, checkOutLng: true },
    });
    const inShift = shifts.find((s) => s.checkInLat != null && s.checkInLng != null);
    const outShift = [...shifts].reverse().find((s) => s.checkOutAt && s.checkOutLat != null && s.checkOutLng != null);
    const checkIn = inShift ? { lat: inShift.checkInLat, lng: inShift.checkInLng, at: inShift.checkInAt } : null;
    const checkOut = outShift ? { lat: outShift.checkOutLat, lng: outShift.checkOutLng, at: outShift.checkOutAt } : null;

    // بناء شكل المسار: مطابقةٌ للأثر الكثيف وتوجيهٌ للفراغات، مقاطعَ موسومة
    // (مرصود/مُرجَّح). راجع services/routeShape.ts — المطابقة وحدها كانت تفشل
    // كلّياً على أي فجوة تتجاوز ٢ كم فيسقط الخطّ مستقيماً فوق البحر والمباني.
    const snap = (req.query.snap as string | undefined) !== '0';

    /**
     * مفتاح الكاش يصف **المقطع نفسه** لا يومَه.
     *
     * كان يحمل عدد نقاط اليوم كلّه، وهو يتغيّر كل دقيقة لمندوبٍ يعمل الآن
     * (نقطة كل ٨ ثوانٍ تُرفع كل ٤٥ث) — فكل إعادة جلبٍ لمسار «اليوم» تُنتج
     * مفاتيح جديدة كلّها: إصابةُ الكاش صفر، وإعادةُ حسابِ يومٍ لم يتغيّر ٩٩٪
     * منه، ومئاتُ النداءات في ساعة إن تنقّل المشرف بين مناديبه. والمفاتيح
     * الميتة تطرد إدخالات صالحة (الكاش عالميّ محدود بـ٢٠٠).
     *
     * والآن مفتاحُ كل مقطع من طرفيه وعدد نقاطه: المقطع الذي لم يتغيّر يُصيب
     * الكاش مهما تراكمت نقاطٌ بعده. و`tid` يمنع تشارك الشركات مفتاحاً واحداً.
     */
    const segKey = (tag: string, a: { lat: number; lng: number }, b: { lat: number; lng: number }, n: number) =>
      `${tid}:${tag}:${a.lat.toFixed(5)},${a.lng.toFixed(5)}:${b.lat.toFixed(5)},${b.lng.toFixed(5)}:${n}`;

    const shape = snap
      ? await buildRouteShape(points, {
          match: (pts) => snapToRoads(pts, segKey('m', pts[0], pts[pts.length - 1], pts.length)),
          route: (wps) => routeThrough(wps, segKey('r', wps[0], wps[wps.length - 1], wps.length)),
        })
      : null;

    // `snapped` يبقى للتوافق: نافذةُ نشرٍ قصيرة تفصل بين رفع الخادم والواجهة،
    // فحذفُه يترك اللوحة المنشورة بلا خطّ أصلاً حتى تلحق.
    const snapped = shape && !shape.degraded
      ? shape.segments.flatMap((sg) => sg.points)
      : null;

    res.json({ success: true, data: points, snapped, shape, checkIn, checkOut });
  } catch (err) { next(err); }
});

export default router;
