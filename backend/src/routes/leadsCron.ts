import { Router, Request, Response, NextFunction } from 'express';
import { runAutoHuntBatch, getHuntConfig } from '../services/leadHunter';

// نقطة الصيد المستمر للجدولة الخارجية (GitHub Actions) — محميّة بتوكن سرّي بدل جلسة المستخدم.
const router = Router();

router.post('/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = (process.env.AUTO_HUNT_TOKEN || '').trim();
    const provided = (req.headers['x-autohunt-token'] as string || '').trim();
    if (!token || provided !== token) {
      res.status(401).json({ success: false, message: 'توكن غير صالح' });
      return;
    }
    const cfg = await getHuntConfig();
    if (!cfg.enabled) {
      res.json({ success: true, skipped: true, message: 'الصيد المستمر متوقّف (enabled=false)' });
      return;
    }
    const result = await runAutoHuntBatch('auto-hunt (cron)');
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
