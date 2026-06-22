import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const isSalesRep = req.user?.role === 'SALES_REP';
    const notifications = await prisma.notification.findMany({
      where: isSalesRep ? { salesRepId: req.user!.id } : {},
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ success: true, data: notifications });
  } catch (err) { next(err); }
});

router.patch('/:id/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // المندوب لا يعلّم إلا إشعاراته؛ الإدارة أي إشعار
    const where = req.user?.role === 'SALES_REP'
      ? { id: req.params.id, salesRepId: req.user.id }
      : { id: req.params.id };
    await prisma.notification.updateMany({ where, data: { isRead: true } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.patch('/read-all', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const isSalesRep = req.user?.role === 'SALES_REP';
    await prisma.notification.updateMany({
      where: isSalesRep ? { salesRepId: req.user!.id, isRead: false } : { isRead: false },
      data: { isRead: true },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
