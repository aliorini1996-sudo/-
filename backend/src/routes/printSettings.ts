import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { isLegacyPrintSettings, isPrintSettingsReset, legacyPrintSettings, parsePrintSettings, storedPrintSettings } from '../services/printSettings';
import { PRINT_FORM_LOCK_PREFIX, PRINT_FORM_MESSAGES, formImageRefMatches, formImageRefsOf, isFormImageId } from '../services/printForms';

/**
 * «إعدادات الطباعة» (طلب المالك ٢٣ أكتوبر ٢٠٢٦) — مُركَّبٌ تحت /api/company/print-settings (routes/company.ts) بعد authenticate.
 *
 * القراءة لكل مستخدم مسجّل (المندوب يطبع بها) — ولو أن GET /api/company يحمل العمود نفسه خاماً لجهاز المندوب وذاكرته
 * أوف-لاين؛ والواجهة تقرؤه دائماً عبر normalizePrintSettings. الحفظ لمستخدم الشركة بصلاحية «إعدادات الشركة» (كـPUT
 * /api/company) بلا شرط ADMIN ولا نطاق: الطابعة والورق ليسا مما يحكم ما يراه المستخدم.
 *
 * PUT /api/company وcompanySchema لم يُمسّا عمداً: حارس قفل ZATCA (company-zatca-lock.test.ts) يثبّت قراءتيه بالعدد.
 */
const router = Router();

const COMPANY_SETTINGS_MISSING = 'احفظ بيانات الشركة أولا';

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.companySettings.findUnique({ where: { tenantId: tenantId(req) }, select: { printSettings: true } });
    const { settings, stored } = storedPrintSettings(row?.printSettings ?? null);
    // hasCompany: بلا صفّ إعدادات لا حفظ (الاسم عمود إلزامي ولا نخترع اسماً) — فتنبّه الواجهة قبل أن تُصمَّم القوالب
    res.json({ success: true, data: settings, stored, hasCompany: !!row });
  } catch (err) { next(err); }
});

router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // «استعادة الافتراضي» ({ reset: true } أو null): العمود null حرفياً — سلوك اليوم بلا «مخصّص» ولا اختيار جهاز ولا سطر «تغيير».
    // كتابة واحدة كالحفظ، و409 بلا صفّ (لا إنشاء)
    if (isPrintSettingsReset(req.body)) {
      const cleared = await prisma.companySettings.updateMany({ where: { tenantId: tid }, data: { printSettings: Prisma.DbNull } });
      if (cleared.count === 0) {
        res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: COMPANY_SETTINGS_MISSING });
        return;
      }
      res.json({ success: true, data: legacyPrintSettings(), stored: false, hasCompany: true });
      return;
    }
    const parsed = parsePrintSettings(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ success: false, code: parsed.code, message: parsed.message, issues: parsed.issues });
      return;
    }
    // «النموذج المطبوع مسبقاً»: كل صورة يشير إليها قالبٌ (layout.form.image) محفوظةٌ للشركة نفسها ببصمتها وأبعادها (routes/printForms.ts)
    // — النواة تفحص شكل المرجع وحده، فلا يُحفظ مرجعٌ يتيم أو لصورة شركة أخرى. الفحص والكتابة في معاملةٍ واحدة تحت قفل صور الشركة
    // (قفل الرفع والحذف نفسه): حذفٌ أو جمعُ مهمَلٍ بينهما كان يترك المحفوظ يشير إلى صورةٍ زالت فيُرفض كل حفظٍ بعده.
    // ولا قراءة ولا قفل بلا مراجع
    const refs = formImageRefsOf(parsed.value);
    let r: { count: number };
    if (refs.length > 0) {
      const out = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PRINT_FORM_LOCK_PREFIX + tid}::text))`;
        const ids = [...new Set(refs.map((x) => x.id))].filter(isFormImageId);
        const rows = ids.length ? await tx.printFormImage.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, sha256: true, widthPx: true, heightPx: true } }) : [];
        const bad = refs.find((x) => !formImageRefMatches(x, rows.find((y) => y.id === x.id)));
        if (bad) return { bad };
        return { written: await tx.companySettings.updateMany({ where: { tenantId: tid }, data: { printSettings: parsed.value as unknown as Prisma.InputJsonValue } }) };
      });
      if (out.bad) {
        res.status(400).json({ success: false, code: 'PRINT_FORM_IMAGE_MISSING', message: PRINT_FORM_MESSAGES.imageMissing, issues: [{ path: out.bad.path, message: PRINT_FORM_MESSAGES.imageMissing }] });
        return;
      }
      r = out.written;
    } else {
      // كتابة واحدة على صفّ الشركة — count 0 = لا صفّ بعد ⇒ 409 بلا إنشاء (لا اسم نخترعه للشركة)
      r = await prisma.companySettings.updateMany({ where: { tenantId: tid }, data: { printSettings: parsed.value as unknown as Prisma.InputJsonValue } });
    }
    if (r.count === 0) {
      res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: COMPANY_SETTINGS_MISSING });
      return;
    }
    // كائنٌ يساوي الافتراضي حرفياً يُقرأ غير مخصّص (storedPrintSettings) — والردّ يقول الشيء نفسه
    res.json({ success: true, data: parsed.value, stored: !isLegacyPrintSettings(parsed.value), hasCompany: true });
  } catch (err) { next(err); }
});

export default router;
