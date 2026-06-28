import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendMail, mailLayout } from '../services/mailer';
import { mailLimiter } from '../middleware/rateLimits';

// استقبال رسائل التواصل من الصفحة التعريفية وإرسالها لبريد الشركة
const router = Router();

router.post('/', mailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().optional(),
      message: z.string().min(1),
    }).parse(req.body);

    const sent = await sendMail({
      to: 'info@fieldsa.net',
      subject: `📩 رسالة تواصل جديدة من ${body.name}`,
      replyTo: body.email,
      html: mailLayout('رسالة تواصل جديدة', [
        ['الاسم', body.name],
        ['البريد', body.email],
        ['الجوال', body.phone || ''],
      ], body.message.replace(/[<>]/g, '')),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذّر إرسال البريد — تحقّق من إعدادات البريد في الخادم' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

export default router;
