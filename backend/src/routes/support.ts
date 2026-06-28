import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { sendMail, mailLayout } from '../services/mailer';

// Ø·Ù„Ø¨Ø§Øª Ø§Ù„Ø¯Ø¹Ù… Ø§Ù„ÙÙ†ÙŠ Ù…Ù† Ø£Ø¯Ù…Ù† Ø§Ù„Ø´Ø±ÙƒØ© â€” ØªÙØ±Ø³ÙŽÙ„ Ø¥Ù„Ù‰ Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø¯Ø¹Ù… help@fieldsa.net
const router = Router();
router.use(authenticate);

router.post('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { subject, category, message } = z.object({
      subject: z.string().max(200).optional(),
      category: z.string().max(60).optional(),
      message: z.string().min(1),
    }).parse(req.body);

    const [tenant, admin] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tid }, select: { name: true } }),
      prisma.admin.findUnique({ where: { id: req.user!.id }, select: { name: true, email: true } }),
    ]);

    const sent = await sendMail({
      to: 'help@fieldsa.net',
      subject: `ðŸ› ï¸ Ø¯Ø¹Ù… ÙÙ†ÙŠ â€” ${tenant?.name || 'Ø´Ø±ÙƒØ©'}${subject ? ' Â· ' + subject : ''}`,
      replyTo: admin?.email || undefined,
      html: mailLayout('Ø·Ù„Ø¨ Ø¯Ø¹Ù… ÙÙ†ÙŠ', [
        ['Ø§Ù„Ø´Ø±ÙƒØ©', tenant?.name || ''],
        ['Ø§Ù„Ù…ÙØ±Ø³ÙÙ„', admin?.name || ''],
        ['Ø§Ù„Ø¨Ø±ÙŠØ¯', admin?.email || ''],
        ['Ø§Ù„ØªØµÙ†ÙŠÙ', category || 'Ø¹Ø§Ù…'],
        ['Ø§Ù„Ù…ÙˆØ¶ÙˆØ¹', subject || ''],
      ], message.replace(/[<>]/g, '')),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذر إرسال البريد، تحقق من إعدادات SMTP في الخادم' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

export default router;


