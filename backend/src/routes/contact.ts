import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendMail, mailLayout } from '../services/mailer';

// استقبال رسائل التواصل من الصفحة التعريفية وإرسالها لبريد الشركة
const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      phone: z.string().optional(),
      message: z.string().min(1),
    }).parse(req.body);

    await sendMail({
      subject: `📩 رسالة تواصل جديدة من ${body.name}`,
      replyTo: body.email,
      html: mailLayout('رسالة تواصل جديدة', [
        ['الاسم', body.name],
        ['البريد', body.email],
        ['الجوال', body.phone || ''],
      ], body.message.replace(/[<>]/g, '')),
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
