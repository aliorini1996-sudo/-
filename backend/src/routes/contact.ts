import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { sendMail, mailLayout } from '../services/mailer';
import { mailLimiter } from '../middleware/rateLimits';
import { leadAlertRecipients } from '../services/leadAlerts';
import { pageLangSchema, pageLangLabel } from '../lib/pageLang';
import { recordInboundContact } from '../services/salesInbox';

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

    // «إدارة المبيعات»: يُسجَّل قبل البريد، وتعذّر القاعدة لا يمنع البريد (services/salesInbox.ts)
    try {
      await recordInboundContact({ channel: 'CONTACT', name: body.name, email: body.email, phone: body.phone, message: body.message });
    } catch (e) { console.error('[contact] تعذّر تسجيل التواصل في إدارة المبيعات:', e); }

    const sent = await sendMail({
      // لحظياً إلى البريد الرئيسي وabdullah وanas وceo (طلب المالك ١٠ نوفمبر — services/leadAlerts.ts)
      to: leadAlertRecipients(),
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
    // «إدارة المبيعات»: يُسجَّل قبل البريد، وتعذّر القاعدة لا يمنع البريد (services/salesInbox.ts)
    try {
      await recordInboundContact({
        channel: body.kind === 'quote' ? 'QUOTE_REQUEST' : 'SUBSCRIPTION',
        name: body.contactName, company: body.companyName, email: body.email, phone: body.phone, country: body.country,
        message: [
          body.notes?.trim(),
          body.city?.trim() ? `المدينة: ${body.city.trim()}` : '',
          body.repsCount?.trim() ? `عدد المناديب المتوقع: ${body.repsCount.trim()}` : '',
        ].filter(Boolean).join(' · '),
      });
    } catch (e) { console.error('[contact] تعذّر تسجيل الطلب في إدارة المبيعات:', e); }

    const sent = await sendMail({
      // لحظياً إلى البريد الرئيسي وabdullah وanas وceo (طلب المالك ١٠ نوفمبر — services/leadAlerts.ts)
      to: leadAlertRecipients(),
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
// اللغة أي وسم BCP-47 قصير صحيح (lib/pageLang.ts) لا قائمة مغلقة: صفحة بلغة جديدة (es، pt-BR) لا تُرفض فيضيع العميل.
export const meetingSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  country: z.string().trim().regex(/^[A-Z]{2}$/).optional(),
  lang: pageLangSchema.optional(),
});

router.post('/meeting', mailLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = meetingSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, message: 'اكتب اسمك ورقم جوال صحيحا' }); return; }
    const body = parsed.data;
    const name = body.name.replace(/[<>]/g, '');
    // «إدارة المبيعات»: يُسجَّل قبل البريد، وتعذّر القاعدة لا يمنع البريد (services/salesInbox.ts)
    try {
      await recordInboundContact({
        channel: 'MEETING', name: body.name, phone: body.phone, country: body.country,
        message: `لغة الصفحة: ${pageLangLabel(body.lang || 'ar')}`,
      });
    } catch (e) { console.error('[contact] تعذّر تسجيل طلب الاجتماع في إدارة المبيعات:', e); }

    const sent = await sendMail({
      // لحظياً إلى البريد الرئيسي والثلاثة (طلب المالك ٨ نوفمبر — services/leadAlerts.ts)
      to: leadAlertRecipients(),
      subject: `📅 طلب اجتماع من ${name}`,
      html: mailLayout('طلب اجتماع جديد', [
        ['الاسم', name],
        ['الجوال', body.phone],
        ['الدولة', body.country || ''],
        ['لغة الصفحة', pageLangLabel(body.lang || 'ar')],
      ], 'تواصل معه لتحديد موعد الاجتماع.'),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذر إرسال الطلب حاول لاحقا أو راسلنا مباشرة' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

export default router;
