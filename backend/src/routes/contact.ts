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

    if (!sent) { res.status(503).json({ success: false, message: 'تعذر إرسال البريد تحقق من إعدادات البريد في الخادم' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

// طلب اشتراك جديد من صفحة «تسجيل طلب اشتراك جديد» — يصل للإدارة بريدياً بكامل بيانات الشركة.
// kind='quote' = الصفحة نفسها بصيغة «طلب عرض سعر» (زرّ الرئيسية): البيانات نفسها وعنوان البريد وحده يتغيّر.
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
      kind: z.enum(['quote']).optional(),
    }).parse(req.body);

    const title = body.kind === 'quote' ? 'طلب عرض سعر' : 'طلب اشتراك جديد';
    const sent = await sendMail({
      to: 'info@fieldsa.net',
      subject: `🟠 ${title} ${body.companyName}`,
      replyTo: body.email,
      html: mailLayout(title, [
        ['الشركة', body.companyName],
        ['المسؤول', body.contactName],
        ['البريد', body.email],
        ['الجوال', body.phone],
        ['الدولة', body.country],
        ['المدينة', body.city || ''],
        ['عدد المناديب المتوقع', body.repsCount || ''],
      ], (body.notes || '').replace(/[<>]/g, '')),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذر إرسال الطلب حاول لاحقا أو راسلنا مباشرة' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

// «احجز اجتماع» (طلب المالك ٨ نوفمبر ٢٠٢٦) — صفحة بسيطة: الاسم والجوال الدولي فقط (أي دولة في العالم)، يصل للإدارة بريدياً.
// الجوال بصيغة دولية كاملة +<مفتاح><رقم> (E.164: ١٥ رقماً على الأكثر)، والدولة رمز ISO من قائمة الواجهة، واللغة للعلم فقط.
export const meetingSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  country: z.string().trim().regex(/^[A-Z]{2}$/).optional(),
  lang: z.enum(['ar', 'en', 'fr', 'tr', 'zh']).optional(),
});

router.post('/meeting', mailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = meetingSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'اكتب اسمك ورقم جوال صحيحا' }); return; }
    const body = parsed.data;
    const name = body.name.replace(/[<>]/g, '');
    const sent = await sendMail({
      to: 'info@fieldsa.net',
      subject: `📅 طلب اجتماع من ${name}`,
      html: mailLayout('طلب اجتماع جديد', [
        ['الاسم', name],
        ['الجوال', body.phone],
        ['الدولة', body.country || ''],
        ['لغة الصفحة', body.lang || 'ar'],
      ], 'تواصل معه لتحديد موعد الاجتماع.'),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذر إرسال الطلب حاول لاحقا أو راسلنا مباشرة' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

export default router;
