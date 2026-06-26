import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';

// إدارة محتوى الصفحة التعريفية التسويقية والصفحات التابعة (CMS)
const router = Router();

// قراءة المحتوى — عام (لعرض الصفحة للزوّار). يرجع null إن لم يُحفظ بعد (تستخدم الواجهة الافتراضي)
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.siteContent.findUnique({ where: { id: 'main' } });
    let data: unknown = null;
    if (row) { try { data = JSON.parse(row.data); } catch { data = null; } }
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// حفظ/تحديث المحتوى — مالك المنصّة (السوبر أدمن) فقط
router.put('/', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = JSON.stringify(req.body ?? {});
    const row = await prisma.siteContent.upsert({
      where: { id: 'main' },
      create: { id: 'main', data },
      update: { data },
    });
    res.json({ success: true, data: JSON.parse(row.data) });
  } catch (err) { next(err); }
});

export default router;
