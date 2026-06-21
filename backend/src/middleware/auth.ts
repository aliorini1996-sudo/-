import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, AuthPayload } from '../types';

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ success: false, message: 'غير مصرح' });
    return;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية، يرجى تسجيل الدخول مجدداً' });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

export function requireSalesRep(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'SALES_REP') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}
