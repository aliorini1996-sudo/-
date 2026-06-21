import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: 'بيانات غير صحيحة',
      errors: err.flatten().fieldErrors,
    });
    return;
  }

  if (err instanceof Error) {
    console.error(err.message);
    if (err.message.includes('Unique constraint')) {
      res.status(409).json({ success: false, message: 'السجل موجود مسبقاً' });
      return;
    }
    res.status(500).json({ success: false, message: err.message });
    return;
  }

  res.status(500).json({ success: false, message: 'خطأ في الخادم' });
}
