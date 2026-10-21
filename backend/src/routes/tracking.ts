import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { adminRepFilter, scopedRepRecordWhere, scopedRecordWhere, canAccessRep, SHAPE_VISIT } from '../services/adminScope';
import { AuthRequest } from '../types';
import { snapToRoads, routeThrough } from '../services/mapMatch';
import { buildRouteShape, haversineM } from '../services/routeShape';
import { customerScope } from '../services/customerScope';
import { heartbeatClientState } from '../services/repHeartbeat';
import { countStopsByRep, asVisitLike } from '../services/workDay';
import { correctCapturedAt, DEVICE_NOW_HEADER } from '../services/liveLocation';
import { readLiveVerdict } from '../middleware/repLiveLocation';

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
router.post('/ping', async (req: AuthRequest, res: Response, next: NextFunction) => {
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
    const latest = rows.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b));
    await prisma.salesRep.update({
      where: { id: repId },
      data: { lastLat: latest.lat, lastLng: latest.lng, lastSeenAt: new Date() },
    });

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
    await prisma.salesRep.update({ where: { id: repId }, data: { lastSeenAt: now, ...heartbeatClientState(req.body, now) } });

    res.json({ success: true });
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
  // نصف قطر دقّة القراءة كما يعطيه الجوال — يحكم به «بصمة الحضور بموقع عميل» (punchAwayFromCustomer)
  accuracy: z.number().finite().min(0).max(1_000_000).optional(),
});

// حارس الميزة: يفعّلها المالك لكل شركة (Tenant.attendanceEnabled). مطفأة ⇒ 403 حتى لو نادى التطبيقُ النقطةَ مباشرة.
// المندوب المصرّح وحده يصل هنا (الفحص في كل معالج)؛ هذا يضيف شرط الاشتراك دفاعاً في العمق فوق إخفاء الزرّ.
async function attendanceEnabled(tid: string): Promise<boolean> {
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { attendanceEnabled: true } });
  return t?.attendanceEnabled === true;
}

async function ensureRepAttendance(req: AuthRequest, res: Response): Promise<{ tid: string; repId: string } | null> {
  if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return null; }
  const tid = tenantId(req);
  if (!(await attendanceEnabled(tid))) { res.status(403).json({ success: false, code: 'ATTENDANCE_DISABLED', message: 'ميزة بصمة الحضور غير مفعّلة' }); return null; }
  return { tid, repId: req.user.id };
}

// «اشتراط تفعيل الموقع» لا يحرس البصمة (أمر المالك، ٧ أكتوبر ٢٠٢٦): القيد على صفحة العميل وحدها — موقع البصمة أفضل جهد
// للجميع، يُسجَّل إن أرسله الجوال ولا تُردّ بغيابه.

/**
 * «بصمة الحضور بموقع عميل» — قيدٌ تقييديّ على المندوب: مفعّلٌ ⇒ لا حضور ولا انصراف إلا داخل
 * المسافة التي حدّدتها الإدارة له (`punchRadiusM`، ٥٠ متراً افتراضاً) من موقع أحد عملائه المسجَّل.
 * يُرجع نصّ الرفض، أو null حين تُقبل البصمة.
 *
 * «عملاؤه» بالنطاق نفسه الذي يرى به قائمته (`customerScope`): المُسنَدون له حين يكون العزل مفعّلاً،
 * وعملاء الشركة كلّهم حين لا يكون. والعميل المحذوف يسقط، والعميل بلا إحداثيات لا يُحتسب.
 *
 * والبحث مربّعٌ تقريبيّ حول الموقع ثمّ المسافة الدقيقة — فلا يُقرأ كلّ عملاء الشركة لكلّ بصمة.
 * ٥٠ متراً ≈ ٠٫٠٠٠٤٥ درجة عرضاً، وطولاً تتّسع بقسمة جيب تمام العرض.
 *
 * ودقّة القراءة (بلاغ المالك ٢١ أكتوبر ٢٠٢٦: «لا يعمل إلا بـ٣٠٠ متر»): كان الجوال يرسل قراءةً مخبّأة عمرها
 * حتى ٣٠ ثانية — المندوب الواصل بسيارته قراءته من الشارع قبل مئات الأمتار — ولا يُنظر في دقّتها، فلا يقبل الصادقَ
 * إلا نطاقٌ واسع. الآن يقرأ الجوال قراءةً طازجة بأفضل دقّة، ويُسامَح هنا بقدر هامش خطأ الجهاز حتى ٢٥ متراً
 * (`PUNCH_ACCURACY_ALLOWANCE_M`). وقراءةٌ أسوأ من النطاق نفسه — وعميلٌ قد يقع داخله في حدود خطئها — لا يُحكم بها
 * بُعداً: تُردّ «موقعك غير دقيق». والرمز يبقى PUNCH_AWAY_FROM_CUSTOMER بسببٍ فرعيّ (reason) لا رمزاً جديداً:
 * حزمةٌ أقدم مفتوحة على جوال مندوب ترسل الدقّة أيضاً، ورمزٌ لا تعرفه كانت تبتلعه بلا رسالة.
 */
export const PUNCH_RADIUS_M = 50;
/** أقصى ما يُسامَح به من هامش خطأ الجهاز فوق مسافة الإدارة — فقراءةٌ رديئة لا تفتح القيد مهما ادّعت */
export const PUNCH_ACCURACY_ALLOWANCE_M = 25;
/** رفضٌ بسبب البُعد يذكر المسافة لأقرب عميلٍ حتى هذا البعد — يكشف للإدارة موقع عميلٍ مسجَّلاً خطأً */
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
type PunchRefusal = { code: 'PUNCH_AWAY_FROM_CUSTOMER'; reason?: 'LOW_ACCURACY'; message: string };
const boxAround = (lat: number, lng: number, m: number) => {
  const dLat = m / 111320;
  const dLng = m / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { lat: { gte: lat - dLat, lte: lat + dLat }, lng: { gte: lng - dLng, lte: lng + dLng } };
};
async function punchAwayFromCustomer(req: AuthRequest, tid: string, repId: string, lat?: number, lng?: number, accuracy?: number): Promise<PunchRefusal | null> {
  const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { requirePunchAtCustomer: true, punchRadiusM: true } });
  if (rep?.requirePunchAtCustomer !== true) return null;
  if (lat == null || lng == null) return { code: 'PUNCH_AWAY_FROM_CUSTOMER', message: 'فعّل الموقع في جوالك — البصمة مشروطة بأن تكون عند أحد عملائك' };
  const radius = punchRadiusOf(rep.punchRadiusM);
  const reach = radius + punchAllowanceOf(accuracy);
  const scope = await customerScope(req, tid);
  const near = await prisma.customer.findMany({
    where: { tenantId: tid, status: { not: 'DELETED' }, ...scope, ...boxAround(lat, lng, reach) },
    select: { lat: true, lng: true },
    // مسافةٌ واسعة (كيلومترات) تُدخل في المربّع عملاءَ كثيرين بعضهم في زواياه خارج الدائرة: سقفٌ ضيّق كان قد
    // يختار الزوايا وحدها فيُرفض صادق. ألفُ نقطةٍ إحداثيّتين فقط — رخيصة، والدائرة ٧٨٪ من المربّع
    take: 1000,
  });
  const atCustomer = near.some(c => c.lat != null && c.lng != null
    && haversineM({ lat, lng }, { lat: c.lat, lng: c.lng }) <= reach);
  if (atCustomer) return null;
  // الرفض يذكر أقرب عميلٍ بمسافته: «أنت على ١٨٠م» يقول للإدارة أين الخلل (موقع عميلٍ خاطئ أو مسافةٌ ضيّقة)
  const around = await prisma.customer.findMany({
    where: { tenantId: tid, status: { not: 'DELETED' }, ...scope, ...boxAround(lat, lng, PUNCH_NEAREST_SEARCH_M) },
    select: { lat: true, lng: true },
    take: 2000,
  });
  let nearest = Infinity;
  for (const c of around) {
    if (c.lat == null || c.lng == null) continue;
    nearest = Math.min(nearest, haversineM({ lat, lng }, { lat: c.lat, lng: c.lng }));
  }
  // الدقّة سببٌ فقط حين قد يقع عميلٌ داخل النطاق في حدود خطئها — المندوب البعيد كيلومترات يُقال له بُعده لا «انتظر»
  if (punchFixTooCoarse(accuracy, radius) && nearest - accuracy! <= radius) {
    return { code: 'PUNCH_AWAY_FROM_CUSTOMER', reason: 'LOW_ACCURACY', message: `موقعك غير دقيق الآن (±${Math.round(accuracy!)} م) — انتظر لحظات أو اقترب من مكان مفتوح ثم أعد المحاولة` };
  }
  const where = Number.isFinite(nearest) && nearest <= PUNCH_NEAREST_SEARCH_M
    ? ` — أقرب عملائك على بعد ${Math.round(nearest)} مترا منك`
    : ' — لا عميل لك قريب من موقعك الحالي';
  return { code: 'PUNCH_AWAY_FROM_CUSTOMER', message: `البصمة مشروطة بأن تكون داخل ${radius} مترا من موقع أحد عملائك${where}` };
}

/** النوبة المفتوحة لهذا المندوب (بلا انصراف)، أو null. */
async function openShift(tid: string, repId: string) {
  return prisma.repAttendance.findFirst({
    where: { tenantId: tid, salesRepId: repId, checkOutAt: null },
    orderBy: { checkInAt: 'desc' },
    select: { id: true, checkInAt: true, checkInLat: true, checkInLng: true },
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
    select: { checkInAt: true, checkOutAt: true },
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
    const [open, shifts] = await Promise.all([openShift(tid, repId), dayShifts(tid, repId, since)]);
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

// تسجيل الحضور — يفتح نوبة. نوبةٌ مفتوحة سلفاً تُعاد كما هي (لا تُفتح ثانية) فيأمن الضغط المكرّر.
router.post('/attendance/checkin', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const { tid, repId } = ctx;
    const { lat, lng, accuracy } = punchSchema.parse(req.body ?? {});
    const since = repDayStart(req.query.tzOffsetMin);
    // نوبةٌ مفتوحة تُعاد كما هي: الضغط المكرّر لا يكتب شيئاً
    const existing = await openShift(tid, repId);
    if (existing) { res.json({ success: true, data: { status: 'in', shift: existing, already: true, shifts: await dayShifts(tid, repId, since) } }); return; }
    const away = await punchAwayFromCustomer(req, tid, repId, lat, lng, accuracy);
    if (away) { res.status(409).json({ success: false, ...away }); return; }
    const shift = await prisma.repAttendance.create({
      data: { tenantId: tid, salesRepId: repId, checkInAt: new Date(), checkInLat: lat ?? null, checkInLng: lng ?? null },
      select: { id: true, checkInAt: true, checkInLat: true, checkInLng: true },
    });
    res.json({ success: true, data: { status: 'in', shift, shifts: await dayShifts(tid, repId, since) } });
  } catch (err) { next(err); }
});

// تسجيل الانصراف — يغلق النوبة المفتوحة. بلا نوبة مفتوحة ⇒ 409 (لم يسجّل حضوراً بعد).
router.post('/attendance/checkout', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await ensureRepAttendance(req, res); if (!ctx) return;
    const { tid, repId } = ctx;
    const { lat, lng, accuracy } = punchSchema.parse(req.body ?? {});
    const open = await openShift(tid, repId);
    if (!open) { res.status(409).json({ success: false, code: 'NO_OPEN_SHIFT', message: 'لم تسجّل حضوراً بعد' }); return; }
    const away = await punchAwayFromCustomer(req, tid, repId, lat, lng, accuracy);
    if (away) { res.status(409).json({ success: false, ...away }); return; }
    const shift = await prisma.repAttendance.update({
      where: { id: open.id },
      data: { checkOutAt: new Date(), checkOutLat: lat ?? null, checkOutLng: lng ?? null },
      select: { checkInAt: true, checkOutAt: true },
    });
    res.json({ success: true, data: { status: 'out', last: shift, shifts: await dayShifts(tid, repId, repDayStart(req.query.tzOffsetMin)) } });
  } catch (err) { next(err); }
});

// المواقع الحالية لكل المناديب — للأدمن (الخريطة الحيّة) مع عدّاد زيارات اليوم
router.get('/live', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);

    const [reps, visitRows] = await Promise.all([
      // كل المناديب النشطين (لا فقط من أرسل موقعاً) — كي يظهر المضاف حديثاً فوراً؛
      // من له موقع أوّلاً (nulls last)، ومن لم يُحدّد موقعه بعد يظهر بلا دبّوس على الخريطة
      prisma.salesRep.findMany({
        where: { tenantId: tid, isActive: true, ...(await adminRepFilter(req)) },
        select: { id: true, name: true, phone: true, isActive: true, lastLat: true, lastLng: true, lastSeenAt: true },
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
      }),
      // الوقفات لا السجلّات — عدّاد الخريطة يطابق قائمة زياراتها
      prisma.repVisit.findMany({
        where: { tenantId: tid, createdAt: { gte: dayStart }, ...(await scopedRecordWhere(req, SHAPE_VISIT)) },
        select: { salesRepId: true, customerId: true, createdAt: true, startedAt: true, durationSec: true, customer: { select: { name: true } } },
        take: 20000,
      }),
    ]);
    const visitsByRep = countStopsByRep(visitRows.map(asVisitLike));

    res.json({ success: true, data: reps.map(r => ({ ...r, visitsToday: visitsByRep[r.id] || 0 })) });
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
