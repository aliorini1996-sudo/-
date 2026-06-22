import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isSalesRep = req.user?.role === 'SALES_REP';
    const notifications = await prisma.notification.findMany({
      where: { tenantId: tid, ...(isSalesRep && { salesRepId: req.user!.id }) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ success: true, data: notifications });
  } catch (err) { next(err); }
});

router.patch('/:id/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // المندوب لا يعلّم إلا إشعاراته؛ الإدارة أي إشعار ضمن شركتها
    const where = req.user?.role === 'SALES_REP'
      ? { id: req.params.id, tenantId: tid, salesRepId: req.user.id }
      : { id: req.params.id, tenantId: tid };
    await prisma.notification.updateMany({ where, data: { isRead: true } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.patch('/read-all', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isSalesRep = req.user?.role === 'SALES_REP';
    await prisma.notification.updateMany({
      where: { tenantId: tid, isRead: false, ...(isSalesRep && { salesRepId: req.user!.id }) },
      data: { isRead: true },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
