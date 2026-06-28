import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { sendMail, mailLayout } from '../services/mailer';
import { mailLimiter } from '../middleware/rateLimits';

// طلبات الدعم الفني من أدمن الشركة — تُرسَل إلى بريد الدعم help@fieldsa.net
const router = Router();
router.use(authenticate);

router.post('/', mailLimiter, requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
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
      to: process.env.SUPPORT_EMAIL || 'help@fieldsa.net',
      subject: `🛠️ دعم فني — ${tenant?.name || 'شركة'}${subject ? ' · ' + subject : ''}`,
      replyTo: admin?.email || undefined,
      html: mailLayout('طلب دعم فني', [
        ['الشركة', tenant?.name || ''],
        ['المُرسِل', admin?.name || ''],
        ['البريد', admin?.email || ''],
        ['التصنيف', category || 'عام'],
        ['الموضوع', subject || ''],
      ], message.replace(/[<>]/g, '')),
    });

    if (!sent) { res.status(503).json({ success: false, message: 'تعذّر إرسال البريد — تحقّق من إعدادات البريد في الخادم' }); return; }
    res.json({ success: true, data: { sent } });
  } catch (err) { next(err); }
});

export default router;
