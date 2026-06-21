import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(['admin', 'sales_rep']),
});

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password, role } = loginSchema.parse(req.body);

    if (role === 'admin') {
      const admin = await prisma.admin.findUnique({ where: { email: username } });
      if (!admin || !admin.isActive) {
        res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        return;
      }
      const valid = await bcrypt.compare(password, admin.passwordHash);
      if (!valid) {
        res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        return;
      }
      const token = jwt.sign(
        { id: admin.id, role: admin.role, name: admin.name },
        process.env.JWT_SECRET!,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
      );
      res.json({ success: true, data: { token, user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } } });
    } else {
      const rep = await prisma.salesRep.findUnique({ where: { username } });
      if (!rep || !rep.isActive) {
        res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        return;
      }
      const valid = await bcrypt.compare(password, rep.passwordHash);
      if (!valid) {
        res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        return;
      }
      const token = jwt.sign(
        { id: rep.id, role: 'SALES_REP', name: rep.name },
        process.env.JWT_SECRET!,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
      );
      const { passwordHash: _, ...repData } = rep;
      res.json({ success: true, data: { token, user: { ...repData, role: 'SALES_REP' } } });
    }
  } catch (err) {
    next(err);
  }
});

router.post('/refresh-fcm', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { fcmToken } = req.body;
    if (req.user?.role === 'SALES_REP') {
      await prisma.salesRep.update({ where: { id: req.user.id }, data: { fcmToken } });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user) { res.status(401).json({ success: false }); return; }
    if (req.user.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findUnique({
        where: { id: req.user.id },
        select: { id: true, name: true, phone: true, email: true, username: true,
          canCreateInvoice: true, canEditInvoice: true, canDeleteInvoice: true, canCancelInvoice: true,
          canChangePrice: true, maxDiscountPct: true, canSellBelowPrice: true,
          canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
          canAddCustomer: true, canEditCustomer: true, canViewStatement: true }
      });
      res.json({ success: true, data: { ...rep, role: 'SALES_REP' } });
    } else {
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: { id: true, name: true, email: true, role: true }
      });
      res.json({ success: true, data: admin });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
