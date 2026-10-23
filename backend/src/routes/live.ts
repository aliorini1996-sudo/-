import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { subscribe, sseFrame, HEARTBEAT_MS } from '../services/liveEvents';
import { impersonationIssuerOk } from '../services/platformAccess';

/**
 * قناة التحديث اللحظيّ للوحة الشركة (انظر `services/liveEvents.ts`).
 *
 * تُفتح بـ`fetch` لا `EventSource`: الأخيرة لا تحمل ترويسة Authorization،
 * والبديل وضع التوكن في الرابط — فيُكتب في سجلّات الخادم والوسطاء.
 */
const router = Router();

/** أقصى مهلةٍ يقبلها setTimeout (~٢٤٫٨ يوماً) — ما فوقها يُطلقه فوراً */
const MAX_TIMER_MS = 2_147_483_647;

/** معالج القناة — مُصدَّر ليُختبر خلف مصادقةٍ مزيّفة بخادم HTTP حقيقيّ */
export function liveStreamHandler(req: AuthRequest, res: Response): void {
  const user = req.user!;
  const tid = user.tenantId;
  // المالك بلا شركة لا يستمع لشيء؛ والمندوب لا يعرض عمود «المدفوع» — لا اتصال
  // مفتوح بلا قارئ
  if (!tid) { res.status(400).json({ success: false, message: 'لا توجد شركة مرتبطة بالحساب' }); return; }
  if (user.role === 'SALES_REP') { res.status(403).json({ success: false, message: 'غير متاح' }); return; }

  // العميل انقطع أثناء التحقّق من الجلسة (قراءة قاعدة بيانات بطيئة): حدث «close»
  // وقع قبل وصولنا، فمستمعٌ يُسجَّل الآن لا يُلغى أبداً — تسرّب مقعدٍ ومؤقّت نبض
  if (req.destroyed || res.destroyed || req.socket?.destroyed) return;

  const unsubscribe = subscribe(tid, res, user.id);
  if (!unsubscribe) {
    res.status(503).json({ success: false, message: 'اتصالات لحظية كثيرة لهذه الشركة' });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // no-transform: وسيط compression يتخطّى ما يحملها — والضغط كان سيحبس الإطارات
  // في مخزنه حتى يمتلئ فلا يصل الحدث لحظةَ وقوعه
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(sseFrame('ready', { at: Date.now() }));

  // القناة لا تعيش بعد جلستها: authenticate يحكم عند الفتح وحده والقناة تبقى ساعات — فتُغلق عند انتهاء التوكن، وجلسة
  // «دخول» تُغلق متى سقط مُصدِرها (عُطّل أو أُخرج أو سُحبت منه الصلاحية). العميل يعيد الاتصال فيردّه authenticate بـ٤٠١
  const exp = (user as { exp?: unknown }).exp;
  const expMs = typeof exp === 'number' ? exp * 1000 : null;
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* يُغلق أدناه */ }
    if (expMs !== null && Date.now() >= expMs) { end(); return; }
    // تعذّر القراءة يُغلق أيضاً: لا قناة بلا مُصدِرٍ متحقَّقٍ منه، والعميل يعيد الاتصال
    if (user.impersonated) impersonationIssuerOk(user).then((ok) => { if (!ok) end(); }, end);
  }, HEARTBEAT_MS);
  // لا يُبقي العملية حيّةً وحده: خادم HTTP يُبقيها في الإنتاج، ونبضٌ متسرّب لا يُعلّق اختباراً
  heartbeat.unref?.();
  // مهلةٌ أبعد من سقف setTimeout تُترك للنبضة أعلاه
  const expiry = expMs !== null && expMs - Date.now() <= MAX_TIMER_MS ? setTimeout(() => end(), Math.max(0, expMs - Date.now())) : undefined;
  expiry?.unref?.();

  let closed = false;
  const close = () => { closed = true; clearInterval(heartbeat); clearTimeout(expiry); unsubscribe(); };
  /** إنهاءٌ من الخادم */
  const end = () => {
    if (closed) return;
    close();
    try { res.end(); } catch { /* مقبسٌ مات */ }
  };
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);
}

router.get('/stream', authenticate, liveStreamHandler);

export default router;
