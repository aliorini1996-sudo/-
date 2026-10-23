import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { platformGate, PlatformRequest } from '../services/platformAccess';

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

/**
 * ما يمنع حفظ موظف المنصة: المحتوى يُحقن في الصفحة الرئيسية HTML خاماً (LandingPage: applyContent ثم dangerouslySetInnerHTML،
 * ومنه سمات href وsrc بين علامتي تنصيص مزدوجة) على أصل لوحة المالك نفسه — فوسمٌ أو علامة تنصيص واحدة يكتبها موظف تزرع كوداً
 * يسرق جلسة المالك حين يفتح الموقع. المالك يكتب ما يشاء كما كان؛ والموظف نصوصاً وروابط فقط
 */
export const STAFF_UNSAFE_CONTENT = /[<>"`]|javascript:|vbscript:|data:(?!image\/(?:png|jpe?g|webp|gif);base64,)|\{\{/i;

/** أول قيمةٍ نصية غيّرها الطلب (أو أضافها) وفيها ما يمنعه STAFF_UNSAFE_CONTENT — مسارها، أو null. ما لم يتغيّر لا يُفحص:
 * محتوى المالك القائم لا يحجب حفظ الموظف لغيره */
export function staffUnsafeChange(next: unknown, prev: unknown, path = ''): string | null {
  if (typeof next === 'string') return next !== prev && STAFF_UNSAFE_CONTENT.test(next) ? (path || '/') : null;
  if (next && typeof next === 'object') {
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
      const before = prev && typeof prev === 'object' ? (prev as Record<string, unknown>)[k] : undefined;
      const hit = staffUnsafeChange(v, before, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}

// حفظ/تحديث المحتوى — مالك المنصّة، وموظفها بصلاحية «تعديل محتوى الصفحة والبروفايل» نصوصاً بلا HTML
router.put('/', platformGate, async (req: PlatformRequest, res: Response, next: NextFunction) => {
  try {
    if (req.platformStaff) {
      const row = await prisma.siteContent.findUnique({ where: { id: 'main' } });
      let prev: unknown = null;
      if (row) { try { prev = JSON.parse(row.data); } catch { prev = null; } }
      const hit = staffUnsafeChange(req.body ?? {}, prev);
      if (hit) {
        res.status(400).json({
          success: false, code: 'STAFF_CONTENT_UNSAFE', field: hit,
          message: 'لا يسمح للموظف بكتابة الرموز < > " ` او اكواد في المحتوى عدل النص واحفظ مجددا',
        });
        return;
      }
    }
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
