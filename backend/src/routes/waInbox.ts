/**
 * جسر قراءة محادثات بوت واتساب — للمالك وحده.
 *
 * البوت خدمةٌ منفصلة بقاعدة بيانات معزولة (قرار متعمَّد: عطلٌ في البوت لا يمسّ
 * المنصّة). فلرؤية محادثاته من لوحة المالك يلزم وسيط، وهذا هو.
 *
 * لماذا وسيط لا نداء مباشر من المتصفّح: النداء المباشر كان سيضع رمز البوت في
 * كود الواجهة — أي في يد كل من يفتح اللوحة. هنا يبقى الرمز في بيئة الخادم،
 * وتُحرَس النقطة بمصادقة المالك القائمة بدل سرٍّ ثانٍ يُدار.
 */

import { Router, Response, NextFunction } from 'express';
import { platformGate } from '../services/platformAccess';
import { fetchWaBot } from '../services/waBotInbox';
import { AuthRequest } from '../types';

const router = Router();
// مالك المنصة وموظفوها بصلاحياتهم (services/platformAccess.ts: platformGate — ما لا قاعدة له للمالك وحده)
router.use(platformGate);

/**
 * ينادي البوت ويعيد جسمه كما هو (النداء نفسه في services/waBotInbox.ts — تشاركه مزامنة «إدارة المبيعات»).
 *
 * مهلة ٦٠ ثانية لا ١٠: البوت على خطّة تُنيم الخدمة، وإيقاظها يستغرق ~٥٠ ثانية.
 * مهلةٌ قصيرة كانت ستُظهر «البوت معطّل» بينما هو نائم فقط.
 */
async function proxy(path: string, res: Response): Promise<void> {
  const r = await fetchWaBot(path, {
    timeoutMs: 60_000,
    timeoutMessage: 'البوت لم يستجب خلال دقيقة — قد يكون نائماً، أعد المحاولة',
  });
  if (!r.ok) {
    res.status(r.status).json({ success: false, message: r.message });
    return;
  }
  res.json({ success: true, data: r.body });
}

router.get('/stats', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { await proxy('/inbox/stats', res); } catch (err) { next(err); }
});

router.get('/threads', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const p = new URLSearchParams();
    if (req.query.limit) p.set('limit', String(req.query.limit));
    if (req.query.stage) p.set('stage', String(req.query.stage));
    if (req.query.q) p.set('q', String(req.query.q));
    await proxy(`/inbox/threads${p.toString() ? `?${p}` : ''}`, res);
  } catch (err) { next(err); }
});

router.get('/thread/:phone', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // تطبيع هنا أيضاً: لا نمرّر ما لم نتحقّق من شكله ولو تحقّق منه الطرف الآخر
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (!phone) { res.status(400).json({ success: false, message: 'رقم غير صالح' }); return; }
    await proxy(`/inbox/thread/${phone}`, res);
  } catch (err) { next(err); }
});

export default router;
