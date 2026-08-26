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
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate, requireSuperAdmin);

const BOT_URL = (process.env.WA_BOT_URL || 'https://wa-sales-bot.onrender.com').replace(/\/+$/, '');
const TOKEN = (process.env.WA_SWEEP_TOKEN || '').trim();

function configured(): boolean {
  return !!TOKEN;
}

/**
 * ينادي البوت ويعيد جسمه كما هو.
 *
 * مهلة ٦٠ ثانية لا ١٠: البوت على خطّة تُنيم الخدمة، وإيقاظها يستغرق ~٥٠ ثانية.
 * مهلةٌ قصيرة كانت ستُظهر «البوت معطّل» بينما هو نائم فقط.
 */
async function proxy(path: string, res: Response): Promise<void> {
  if (!configured()) {
    res.status(503).json({
      success: false,
      message: 'WA_SWEEP_TOKEN غير مضبوط في بيئة الخادم — لا يمكن قراءة محادثات البوت',
    });
    return;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(`${BOT_URL}${path}`, {
      headers: { 'x-inbox-token': TOKEN },
      signal: ctrl.signal,
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      res.status(r.status === 401 ? 502 : r.status).json({
        success: false,
        message: r.status === 401
          ? 'البوت رفض الرمز — تأكّد أن WA_SWEEP_TOKEN متطابق في الخدمتين'
          : (body as { message?: string })?.message || `البوت ردّ ${r.status}`,
      });
      return;
    }
    res.json({ success: true, data: body });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    res.status(504).json({
      success: false,
      message: aborted ? 'البوت لم يستجب خلال دقيقة — قد يكون نائماً، أعد المحاولة' : 'تعذّر الوصول للبوت',
    });
  } finally {
    clearTimeout(t);
  }
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
