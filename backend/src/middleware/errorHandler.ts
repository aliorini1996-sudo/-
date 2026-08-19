import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const fieldErrors = err.flatten().fieldErrors;
    const fields = Object.keys(fieldErrors);
    res.status(400).json({
      success: false,
      message: fields.length ? `بيانات غير صحيحة: ${fields.join('، ')}` : 'بيانات غير صحيحة',
      errors: fieldErrors,
    });
    return;
  }

  if (err instanceof Error) {
    console.error(err.message);
    if (err.message.includes('Unique constraint')) {
      res.status(409).json({ success: false, message: 'السجل موجود مسبقاً' });
      return;
    }
    // رسائل الاعطال الداخلية (اتصال DB ونحوه) قد تحمل تفاصيل بنية تحتية —
    // لا تصل الا لمستخدم مصادق عليه؛ النقاط العامة (كصفحة نجاح الدفع) ترى رسالة عامة
    const authed = !!(req as { user?: unknown }).user;
    res.status(500).json({ success: false, message: authed ? err.message : 'خطأ في الخادم' });
    return;
  }

  res.status(500).json({ success: false, message: 'خطأ في الخادم' });
}
