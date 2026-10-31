import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { emptyPrintTexts, isPrintTextsReset, parsePrintTexts, storedPrintTexts } from '../services/printTexts';

/**
 * «نصوص المطبوعات» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — مُركَّبٌ تحت /api/company/print-texts (routes/company.ts) بعد authenticate.
 *
 * القراءة لكل مستخدم مسجّل (المندوب يطبع بها) — ولو أن GET /api/company يحمل العمود نفسه خاماً لجهاز المندوب وذاكرته
 * أوف-لاين؛ والواجهة تقرؤه دائماً عبر normalizePrintTexts. الحفظ بصلاحية «إعدادات الشركة» كـ«إعدادات الطباعة» تماماً.
 *
 * PUT /api/company وcompanySchema لم يُمسّا عمداً: حارس قفل ZATCA (company-zatca-lock.test.ts) يثبّت قراءتيه بالعدد.
 */
const router = Router();

const COMPANY_SETTINGS_MISSING = 'احفظ بيانات الشركة أولا';

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.companySettings.findUnique({ where: { tenantId: tenantId(req) }, select: { printTexts: true } });
    const { texts, stored } = storedPrintTexts(row?.printTexts ?? null);
    res.json({ success: true, data: texts, stored, hasCompany: !!row });
  } catch (err) { next(err); }
});

router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    let value: ReturnType<typeof emptyPrintTexts> | null = null;
    if (!isPrintTextsReset(req.body)) {
      const parsed = parsePrintTexts(req.body);
      if (!parsed.ok) {
        res.status(parsed.status).json({ success: false, code: parsed.code, message: parsed.message, issues: parsed.issues });
        return;
      }
      value = parsed.value;
    }
    // كتابة واحدة على صفّ الشركة — الإعداد بلا أثر والاستعادة كلاهما null حرفياً (نصوص اليوم)؛ count 0 = لا صفّ ⇒ 409 بلا إنشاء
    const r = await prisma.companySettings.updateMany({
      where: { tenantId: tid },
      data: { printTexts: value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonValue) },
    });
    if (r.count === 0) {
      res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: COMPANY_SETTINGS_MISSING });
      return;
    }
    res.json({ success: true, data: value ?? emptyPrintTexts(), stored: value !== null, hasCompany: true });
  } catch (err) { next(err); }
});

export default router;
