import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { AuthPayload } from '../types';
import {
  CAPS_HEADER, LIVE_CAP, LIVE_CLIENT_UPDATE_CODE, LIVE_CLIENT_UPDATE_MESSAGE, LIVE_REQUIRED_CODE, LIVE_REQUIRED_MESSAGE,
  REPLAY_HEADER, hasCap, isLiveExempt, isReplay, liveVerdict, liveWindow, type LiveVerdict,
} from '../services/liveLocation';

/**
 * حكم «ظاهرٌ على الخريطة الآن» لمندوب: أحدث نقطةٍ استُقبلت والتُقطت خلال النافذة (services/liveLocation.ts).
 * بمعرّف المندوب وشركته معاً — لا تُقرأ نقاط شركةٍ أخرى.
 */
export async function readLiveVerdict(tenantId: string, salesRepId: string, now = Date.now()): Promise<LiveVerdict> {
  const { since, until } = liveWindow(now);
  const latest = await prisma.repLocation.findFirst({
    where: { tenantId, salesRepId, capturedAt: { gte: since, lte: until }, createdAt: { gte: since } },
    orderBy: { capturedAt: 'desc' },
    select: { lat: true, lng: true, accuracy: true, capturedAt: true, createdAt: true },
  });
  return liveVerdict(latest, now);
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
 *  4. حزمةٌ لا تعلن `liveloc` (تطبيقٌ قديم مفتوح، أو تطبيق Flutter) لا تعرف القفل ⇒ «حدّث التطبيق»: 426 للطلب الحيّ،
 *     و503 لإعادة الرفع كي يبقى المستند في صفّ تلك الحزمة (تتوقّف عند 5xx ولا تُعدمه) حتى تتحدّث — لا يضيع مستند مال.
 *  5. لا نقطة حيّة دقيقة ⇒ 409 LOCATION_REQUIRED بسببه (reason). الحزمة الحديثة تُبقي المستند المصفوف ولا تُعدمه.
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

    if (!hasCap(req.headers[CAPS_HEADER], LIVE_CAP)) {
      const replay = isReplay(req.headers[REPLAY_HEADER]);
      if (replay) res.setHeader('Retry-After', '300');
      res.status(replay ? 503 : 426).json({ success: false, code: LIVE_CLIENT_UPDATE_CODE, message: LIVE_CLIENT_UPDATE_MESSAGE });
      return;
    }

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
