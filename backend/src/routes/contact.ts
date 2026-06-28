import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendMail, mailLayout } from '../services/mailer';

// Ø§Ø³ØªÙ‚Ø¨Ø§Ù„ Ø±Ø³Ø§Ø¦Ù„ Ø§Ù„ØªÙˆØ§ØµÙ„ Ù…Ù† Ø§Ù„ØµÙØ­Ø© Ø§Ù„ØªØ¹Ø±ÙŠÙÙŠØ© ÙˆØ¥Ø±Ø³Ø§Ù„Ù‡Ø§ Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø´Ø±ÙƒØ©
const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().optional(),
      message: z.string().min(1),
    }).parse(req.body);

    const sent = await sendMail({
      to: 'info@fieldsa.net',
      subject: `ðŸ“© Ø±Ø³Ø§Ù„Ø© ØªÙˆØ§ØµÙ„ Ø¬Ø¯ÙŠØ¯Ø© Ù…Ù† ${body.name}`,
      replyTo: body.email,
      html: mailLayout('Ø±Ø³Ø§Ù„Ø© ØªÙˆØ§ØµÙ„ Ø¬Ø¯ÙŠØ¯Ø©', [
        ['Ø§Ù„Ø§Ø³Ù…', body.name],
        ['Ø§Ù„Ø¨Ø±ÙŠØ¯', body.email],
        ['Ø§Ù„Ø¬ÙˆØ§Ù„', body.phone || ''],
      ], body.message.replace(/[<>]/g, '')),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذر إرسال البريد، تحقق من إعدادات SMTP في الخادم' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

export default router;



