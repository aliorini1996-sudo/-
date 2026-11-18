// ============================================================================
// «سطر رفض مفتاح الربط» (طلب المالك ١٦ نوفمبر ٢٠٢٦): موصِل العميل (Odoo) أعاد POST /api/van-stock/loads فرُفض 422 ست مرات في أربع
// عشرة دقيقة، وجسم الرفض لا يُسجَّل فبقي الرمز مجهولاً. لكل طلبٍ بمفتاح API يُردّ بـ4xx على مسارات مخزون السيارة والمستودع والأصناف
// سطرٌ واحد في السجلّ: [api-reject] <method> <path> <status> <code> key=<أول ستة أحرف من معرّف المفتاح>
// بلا جسمٍ ولا استعلام (?…) ولا بيانات عميل — المسار ومعرّفات المسار وحدها. الجلسات (الواجهة و/m والمندوب) لا سطر لها.
// ============================================================================
import type { NextFunction, Request, Response } from 'express';

/** سطر السجلّ — صرفٌ للاختبار */
export function apiRejectLine(method: string, path: string, status: number, code: string | null, apiKeyId: string): string {
  return `[api-reject] ${method} ${path} ${status} ${code || '-'} key=${String(apiKeyId).slice(0, 6)}`;
}

/** رمز الرفض من جسم JSON (code، وإلا error.code) — نصٌّ قصير وحده */
function codeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as { code?: unknown; error?: { code?: unknown } | unknown };
  const c = typeof o.code === 'string' ? o.code
    : o.error && typeof o.error === 'object' && typeof (o.error as { code?: unknown }).code === 'string' ? (o.error as { code: string }).code : null;
  return c ? c.slice(0, 64) : null;
}

/**
 * Middleware يُركَّب قبل الموجّهات (index.ts): يلتقط رمز الجسم من res.json ويكتب السطر عند انتهاء الردّ. req.user يضعه authenticate
 * داخل الموجّه — والسطر يُكتب بعده (finish) فيقرؤه. `log` قابلٌ للحقن في الاختبار.
 */
export function apiRejectLog(log: (line: string) => void = (l) => console.warn(l)) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let code: string | null = null;
    const json = res.json.bind(res);
    res.json = ((body: unknown) => { code = codeOf(body); return json(body); }) as Response['json'];
    res.on('finish', () => {
      const keyId = (req as Request & { user?: { apiKeyId?: string } }).user?.apiKeyId;
      if (!keyId || res.statusCode < 400 || res.statusCode >= 500) return;
      // originalUrl بلا الاستعلام: baseUrl وpath يتبدّلان أثناء التوجيه، والاستعلام قد يحمل بيانات
      const path = String(req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`).split('?')[0].slice(0, 200);
      try { log(apiRejectLine(req.method, path, res.statusCode, code, keyId)); } catch { /* السجلّ لا يكسر ردّاً */ }
    });
    next();
  };
}
