import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { subscribe, sseFrame, HEARTBEAT_MS } from '../services/liveEvents';

/**
 * قناة التحديث اللحظيّ للوحة الشركة (انظر `services/liveEvents.ts`).
 *
 * تُفتح بـ`fetch` لا `EventSource`: الأخيرة لا تحمل ترويسة Authorization،
 * والبديل وضع التوكن في الرابط — فيُكتب في سجلّات الخادم والوسطاء.
 */
const router = Router();

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

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* يُغلق أدناه */ }
  }, HEARTBEAT_MS);
  // لا يُبقي العملية حيّةً وحده: خادم HTTP يُبقيها في الإنتاج، ونبضٌ متسرّب لا يُعلّق اختباراً
  heartbeat.unref?.();

  const close = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);
}

router.get('/stream', authenticate, liveStreamHandler);

export default router;
