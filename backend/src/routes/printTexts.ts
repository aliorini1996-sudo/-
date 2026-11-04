import { createHash } from 'node:crypto';
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
 * والقراءة والحفظ يعيدان rev (printTextsRevision)؛ والحفظ برأس x-print-texts-rev مشروطٌ بأن العمود لم يتغيّر منذ تلك المراجعة
 * (409 PRINT_TEXTS_STALE) — فلا يمسح مديرٌ ثانٍ أو نافذةٌ قديمة تعديلات غيره بصمت. وبلا الرأس (حزمةٌ أقدم) الحفظ كما كان.
 *
 * PUT /api/company وcompanySchema لم يُمسّا عمداً: حارس قفل ZATCA (company-zatca-lock.test.ts) يثبّت قراءتيه بالعدد.
 */
const router = Router();

const COMPANY_SETTINGS_MISSING = 'احفظ بيانات الشركة أولا';

/**
 * مراجعة نصوص المطبوعات (بلاغ ٤ نوفمبر ٢٠٢٦: حفظٌ من جهازين يمسح تعديلات الأول بلا تنبيه) — بصمةٌ قصيرة للقيمة المخزّنة كما هي
 * (null = نصوص اليوم): أول ١٦ حرفاً من sha256 لتسلسلٍ بمفاتيح مرتّبة. الترتيب لازم: عمود Json في PostgreSQL (jsonb) يعيد ترتيب
 * المفاتيح عند الحفظ، فبصمة ما كُتب (ردّ PUT) يجب أن تساوي بصمة ما يُقرأ بعده (GET والفحص في PUT التالي) وإلا رُفض كل حفظٍ ثانٍ.
 * هنا لا في services/printTexts.ts: الخدمة لا تستورد غير النواة (حارس print-texts.test.ts)، والبصمة تحتاج node:crypto.
 */
export function printTextsRevision(stored: unknown | null): string {
  return createHash('sha256').update(stableJson(stored ?? null)).digest('hex').slice(0, 16);
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

/** رأس المراجعة التي بنى عليها المحرّر مسودّته — غيابه (حزمةٌ أقدم) = حفظ اليوم بلا شرط */
export const PRINT_TEXTS_REV_HEADER = 'x-print-texts-rev';
const PRINT_TEXTS_STALE = 'تغيرت نصوص المطبوعات من جهاز آخر';

function expectedRevision(req: AuthRequest): string | null {
  const h = (req.headers as Record<string, string | string[] | undefined> | undefined)?.[PRINT_TEXTS_REV_HEADER];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === 'string' ? v.trim() : null;
}

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.companySettings.findUnique({ where: { tenantId: tenantId(req) }, select: { printTexts: true } });
    const { texts, stored } = storedPrintTexts(row?.printTexts ?? null);
    res.json({ success: true, data: texts, stored, hasCompany: !!row, rev: printTextsRevision(row?.printTexts ?? null) });
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
    const expected = expectedRevision(req);
    if (expected !== null) {
      // حفظٌ مشروط بالمراجعة: القراءة والمقارنة والكتابة في معاملة واحدة — تغيّرت القيمة منذ فتح المحرّر ⇒ 409 بلا كتابة
      const outcome = await prisma.$transaction(async (tx) => {
        const cur = await tx.companySettings.findUnique({ where: { tenantId: tid }, select: { printTexts: true } });
        if (!cur) return 'missing' as const;
        if (printTextsRevision(cur.printTexts ?? null) !== expected) return 'stale' as const;
        const w = await tx.companySettings.updateMany({
          where: { tenantId: tid },
          data: { printTexts: value === null ? Prisma.DbNull : (value as unknown as Prisma.InputJsonValue) },
        });
        return w.count === 0 ? ('missing' as const) : ('ok' as const);
      });
      if (outcome === 'missing') {
        res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: COMPANY_SETTINGS_MISSING });
        return;
      }
      if (outcome === 'stale') {
        res.status(409).json({ success: false, code: 'PRINT_TEXTS_STALE', message: PRINT_TEXTS_STALE });
        return;
      }
      res.json({ success: true, data: value ?? emptyPrintTexts(), stored: value !== null, hasCompany: true, rev: printTextsRevision(value) });
      return;
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
    res.json({ success: true, data: value ?? emptyPrintTexts(), stored: value !== null, hasCompany: true, rev: printTextsRevision(value) });
  } catch (err) { next(err); }
});

export default router;
