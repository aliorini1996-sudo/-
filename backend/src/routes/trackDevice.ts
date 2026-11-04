import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../config/database';
import { AuthRequest } from '../types';
import { pingLimiter, PING_IP_LIMIT } from '../middleware/rateLimits';
import {
  bearerToken, verifyTrackToken, deviceTrackDecision, deviceNowMs, isoInstantMs, markNativeTrack, clearNativeTrack, isTrackFinal,
  TRACK_FINAL_HEADER, TRACK_TOKEN_INVALID, LOCATION_SOURCE_DEVICE,
} from '../services/deviceTrack';
import { DEVICE_NOW_HEADER } from '../services/liveLocation';
import { pingSchema, storeRepPings, PingPoint } from './tracking';

// ═══ نقطة موقع التطبيق الأصلي في الخلفية (طلب المالك، ٤ نوفمبر ٢٠٢٦) — services/deviceTrack.ts ═══
// خدمة الموقع في أندرويد (TrackService) وآيفون (TrackService.swift) ترسل نقاطها هنا والتطبيق في الخلفية أو الشاشة مقفلة،
// بلا جلسة ويب: المصادقة برمز التتبّع (Bearer) الذي أصدرته /api/tracking/device-token لجلسة المندوب. لا authenticate هنا:
// توكن الجلسة لا يُقبل في هذا المسار، ورمز التتبّع لا يُقبل في غيره (مفتاحان مختلفان).
//
// مركَّبٌ في index.ts قبل محدِّد المعدّل العام: نقاط الخلفية لمناديب شركةٍ خلف NAT المشغّل الواحد كانت ستستهلك حدّ IP العام عن
// فواتيرهم وسنداتهم — فلها دلو عنوانٍ مستقلّ بسقف نقاط الويب نفسه (PING_IP_LIMIT)، ثم دلو المندوب نفسه (pingLimiter) بعد التحقّق.

const router = Router();

/** دلو العنوان قبل التحقّق من الرمز — بسقف نقاط الويب لكل عنوان (١٢٠/دقيقة) */
const deviceIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: PING_IP_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `track-device-ip:${req.ip ?? ''}`,
  message: { success: false, message: 'تجاوزت الحد المسموح من المحاولات حاول لاحقا' },
});

type TrackLocals = { track: { repId: string; tenantId: string } };

/**
 * رمز التتبّع: غائبٌ أو فاسدٌ أو منتهٍ ⇒ 401 TRACK_TOKEN_INVALID (يمسح التطبيق رمزه ويتوقّف). صحيحٌ ⇒ هوية المندوب على الطلب
 * — وبها يَعُدّ pingLimiter نقاطه في دلو المندوب نفسه (rep-ping:<id>) مع نقاط الويب.
 */
function requireTrackToken(req: Request, res: Response<unknown, TrackLocals>, next: NextFunction): void {
  const raw = bearerToken(req.headers.authorization);
  const who = raw ? verifyTrackToken(raw) : null;
  if (!who) { res.status(401).json({ success: false, code: TRACK_TOKEN_INVALID, message: 'رمز التتبّع غير صالح' }); return; }
  res.locals.track = who;
  (req as AuthRequest).user = { id: who.repId, role: 'SALES_REP', name: '', tenantId: who.tenantId };
  next();
}

/**
 * لحظة الالتقاط كما أرسلها الجهاز إن كانت ISO-8601 سليمة — وإلا تُترك فيأخذ الخادم لحظة الاستقبال: نقطةٌ فاسدة لا تُعلق
 * الدفعة كلها بخطأ خادمٍ يعيدها الجهاز بلا نهاية (طابوره يقف خلفها)
 */
const cleanPoint = (p: PingPoint): PingPoint =>
  (p.capturedAt !== undefined && isoInstantMs(p.capturedAt) == null ? { ...p, capturedAt: undefined } : p);

router.post('/ping', deviceIpLimiter, requireTrackToken, pingLimiter, async (req: Request, res: Response<unknown, TrackLocals>, next: NextFunction) => {
  try {
    const { repId, tenantId: tid } = res.locals.track;
    // رفع الإغلاق (TRACK_FINAL_HEADER) قد يأتي بلا نقطة: طابور الجهاز فارغٌ لحظة التوقّف، والنسيان هو المقصود منه — فيُقبل فارغاً
    // بالترويسة وحدها. والرفع العاديّ بمخطّط /ping نفسه (١–٢٠٠ نقطة)
    const final = isTrackFinal(req.headers[TRACK_FINAL_HEADER]);
    const sent = (req.body as { points?: unknown } | undefined)?.points;
    const points: PingPoint[] = final && Array.isArray(sent) && sent.length === 0 ? [] : pingSchema.parse(req.body).points;

    const [settings, rep] = await Promise.all([
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { trackingEnabled: true } }),
      prisma.salesRep.findFirst({
        where: { id: repId, tenantId: tid },
        select: { isActive: true, canBeTracked: true, requireLocationOn: true, tenant: { select: { isActive: true, subscriptionEndsAt: true } } },
      }),
    ]);
    const decision = deviceTrackDecision(rep, settings?.trackingEnabled);
    // المندوب حُذف أو عُطّل، أو الشركة موقوفة/انتهى اشتراكها (كما يحكم الدخول) ⇒ الرمز لم يعد يمثّل أحداً
    if (decision === 'gone') { res.status(401).json({ success: false, code: TRACK_TOKEN_INVALID, message: 'رمز التتبّع غير صالح' }); return; }
    // التتبّع أُطفئ للشركة أو استُثني المندوب (وليس مقيَّداً) بعد إصدار الرمز ⇒ لا تخزين، والتطبيق يوقف خدمته
    if (decision === 'off') { res.json({ success: true, data: { stored: 0, stop: true } }); return; }

    // ساعة الجهاز رقماً أو ISO-8601 ⇒ رقمٌ كما يقرؤه correctCapturedAt (الويب يرسل الرقم)
    const dn = deviceNowMs(req.headers[DEVICE_NOW_HEADER]);
    // storeRepPings يفترض نقطةً واحدة على الأقل (أحدثها يحرّك الدبّوس) — فرفع الإغلاق الفارغ لا يمرّ بها.
    // والمصدر 'device' من هذا المسار نفسه لا من الجسم: به لا يُمدّ يوم العمل بمساء الخلفية في التقارير (services/foregroundEnvelope.ts)
    const stored = points.length
      ? await storeRepPings(tid, repId, points.map(cleanPoint), dn != null ? String(dn) : undefined, rep?.requireLocationOn === true, LOCATION_SOURCE_DEVICE)
      : 0;
    // نقاط الإغلاق تُخزَّن كغيرها، ثم يُنسى «يعمل الآن»: الخدمة توقّفت، فلا تُسقَط نقاط الصفحة ولا يُمنع بدءٌ جديد ٩٠ث بعدها
    if (final) clearNativeTrack(repId);
    else markNativeTrack(repId);
    res.json({ success: true, data: { stored } });
  } catch (err) { next(err); }
});

export default router;
