import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { AuthPayload } from '../types';
import {
  LIVE_REQUIRED_CODE, LIVE_REQUIRED_MESSAGE, isLiveExempt, liveVerdict, liveWindow, type LiveVerdict,
} from '../services/liveLocation';

/**
 * حكم «ظاهرٌ على الخريطة الآن» لمندوب: أحدث نقطةٍ استُقبلت والتُقطت خلال النافذة (services/liveLocation.ts).
 * بمعرّف المندوب وشركته معاً — لا تُقرأ نقاط شركةٍ أخرى.
 */
export async function readLiveVerdict(tenantId: string, salesRepId: string, now = Date.now()): Promise<LiveVerdict> {
  return (await readLivePoint(tenantId, salesRepId, now)).verdict;
}

/** النقطة الحيّة نفسها مع حكمها — الزيارة بلا إحداثيات من مقيَّدٍ حيّ تُسجَّل بموقعه الظاهر على الخريطة الآن */
export async function readLivePoint(tenantId: string, salesRepId: string, now = Date.now()):
  Promise<{ verdict: LiveVerdict; lat: number | null; lng: number | null }> {
  const { since, until } = liveWindow(now);
  const latest = await prisma.repLocation.findFirst({
    where: { tenantId, salesRepId, capturedAt: { gte: since, lte: until }, createdAt: { gte: since } },
    orderBy: { capturedAt: 'desc' },
    select: { lat: true, lng: true, accuracy: true, capturedAt: true, createdAt: true },
  });
  const verdict = liveVerdict(latest, now);
  return { verdict, lat: verdict.ok && latest ? latest.lat : null, lng: verdict.ok && latest ? latest.lng : null };
}

/** POST /visits (نسبةً إلى /api) — بتوحيد حالة الأحرف والشرطة الأخيرة كما يوجّهها Express */
export function isVisitCreate(method: string, path: string): boolean {
  return String(method || '').toUpperCase() === 'POST' && String(path || '').toLowerCase().replace(/\/+$/, '') === '/visits';
}

/**
 * «اشتراط تفعيل الموقع» — القفل الكامل على الخادم (أمر المالك، ٦ أكتوبر ٢٠٢٦): كل طلبٍ يغيّر بياناً من مندوبٍ مقيَّد
 * (requireLocationOn === true) يُردّ ما لم يكن ظاهراً على الخريطة الآن بموقعٍ دقيق. مركَّبٌ مرةً على /api قبل كل موجّه،
 * فيغطّي كل مسارٍ قائم وكل مسارٍ يُضاف لاحقاً — الفواتير والمرتجعات والسندات والعملاء والزيارات والبصمة والمندوب الذكي
 * والتقرير اليومي وتحميل السيارة وغيرها — حيّاً كان الطلب أو إعادة رفعٍ من صفّ العمل دون اتصال.
 *
 * ترتيب الحكم:
 *  1. القراءة والمستثنى (الدخول/التجديد/رمز الإشعارات/نقطة الموقع/نبضة الحضور) تمرّ.
 *  2. توكنٌ غائب أو فاسد يمرّ إلى `authenticate` في موجّهه (401 هناك). وغير المندوب يمرّ.
 *  3. غير المقيَّد يمرّ — القيد يُقرأ بـ=== true بمعرّف المندوب وشركته.
 *  4. لا نقطة حيّة دقيقة ⇒ 409 LOCATION_REQUIRED بسببه (reason) — لكل نسخةٍ من التطبيق سواء: بأمر المالك لا رسالة
 *     «حدّث التطبيق» لأحد؛ الحزمة القديمة ترسل نقاط التتبّع فتعمل ما دام موقعها المباشر ظاهراً، وتُردّ متى غاب.
 */
export async function requireRepLiveLocation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (isLiveExempt(req.method, req.path)) { next(); return; }
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) { next(); return; }
    let payload: AuthPayload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
    } catch {
      next(); return;
    }
    if (payload?.role !== 'SALES_REP' || !payload.id || !payload.tenantId) { next(); return; }

    const rep = await prisma.salesRep.findFirst({
      where: { id: payload.id, tenantId: payload.tenantId },
      select: { requireLocationOn: true },
    });
    if (rep?.requireLocationOn !== true) { next(); return; }

    const v = await readLiveVerdict(payload.tenantId, payload.id);
    if (!v.ok) {
      res.status(409).json({ success: false, code: LIVE_REQUIRED_CODE, reason: v.reason, message: LIVE_REQUIRED_MESSAGE });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
