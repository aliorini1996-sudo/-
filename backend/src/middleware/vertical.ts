import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';

// حارس العزل بين العموديّات (التوزيع/المطاعم) — جوهر منع تسرّب الخدمات.
// • مالك المنصّة (SUPER_ADMIN) يرى العموديّتين ⇒ يمرّ دائماً.
// • التوكنات القديمة (قبل نشر M0) لا تحمل vertical ⇒ تُعامَل كـ distribution، فلا تنكسر جلسات التوزيع القائمة.
// الحارس الأمامي في الواجهة للراحة فقط؛ هذا الحارس الخلفي هو مصدر العزل الأمني.
export function requireVertical(v: 'distribution' | 'restaurant') {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role === 'SUPER_ADMIN') { next(); return; }
    const tv = req.user?.vertical ?? 'distribution';
    if (tv !== v) {
      res.status(403).json({ success: false, message: 'هذه الخدمة غير متاحة لنوع حسابك' });
      return;
    }
    next();
  };
}
