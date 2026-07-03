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

// طلب اشتراك جديد من صفحة «تسجيل طلب اشتراك جديد» — يصل للإدارة بريدياً بكامل بيانات الشركة
router.post('/subscription', mailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      companyName: z.string().min(1).max(200),
      contactName: z.string().min(1).max(200),
      email: z.string().email(),
      phone: z.string().min(5).max(30),
      country: z.string().min(1).max(100),
      city: z.string().max(100).optional(),
      repsCount: z.string().max(30).optional(),
      notes: z.string().max(2000).optional(),
    }).parse(req.body);

    const sent = await sendMail({
      to: 'info@fieldsa.net',
      subject: `🟠 طلب اشتراك جديد — ${body.companyName}`,
      replyTo: body.email,
      html: mailLayout('طلب اشتراك جديد', [
        ['الشركة', body.companyName],
        ['المسؤول', body.contactName],
        ['البريد', body.email],
        ['الجوال', body.phone],
        ['الدولة', body.country],
        ['المدينة', body.city || ''],
        ['عدد المناديب المتوقع', body.repsCount || ''],
      ], (body.notes || '').replace(/[<>]/g, '')),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذّر إرسال الطلب — حاول لاحقاً أو راسلنا مباشرة' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

export default router;
