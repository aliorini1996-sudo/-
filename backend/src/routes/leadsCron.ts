import { Router, Request, Response, NextFunction } from 'express';
import { runAutoHuntBatch, getHuntConfig } from '../services/leadHunter';

// نقطة الصيد المستمر للجدولة الخارجية (GitHub Actions).
// بلا إعداد أسرار: تعمل فقط إذا فُعّل الصيد من اللوحة (enabled)، مع حارس فاصل زمني
// يمنع أكثر من دفعة كل ~18 دقيقة (حماية من التكرار/الإساءة).
// أمان اختياري: إن ضُبط AUTO_HUNT_TOKEN في الخادم، يُطلب تطابق الهيدر x-autohunt-token.
const router = Router();
const MIN_INTERVAL_MS = 18 * 60 * 1000;

router.post('/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await getHuntConfig();
    if (!cfg.enabled) {
      res.json({ success: true, skipped: true, message: 'الصيد التلقائي متوقّف (فعّله من اللوحة)' });
      return;
    }

    // أمان اختياري بالتوكن (إن ضُبط)
    const token = (process.env.AUTO_HUNT_TOKEN || '').trim();
    if (token) {
      const provided = (req.headers['x-autohunt-token'] as string || '').trim();
      if (provided !== token) {
        res.status(401).json({ success: false, message: 'توكن غير صالح' });
        return;
      }
    }

    // حارس الفاصل الزمني — يمنع التشغيل المتكرّر أو المتوازي
    if (cfg.lastRunAt && Date.now() - new Date(cfg.lastRunAt).getTime() < MIN_INTERVAL_MS) {
      const waitMin = Math.ceil((MIN_INTERVAL_MS - (Date.now() - new Date(cfg.lastRunAt).getTime())) / 60000);
      res.json({ success: true, skipped: true, message: `دفعة حديثة — تخطّي (~${waitMin} دقيقة على التالية)` });
      return;
    }

    const result = await runAutoHuntBatch('auto-hunt (cron)');
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
