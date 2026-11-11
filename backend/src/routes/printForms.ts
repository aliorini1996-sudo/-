import express, { Router, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import prisma from '../config/database';
import { actorOf, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { FORM_IMAGE_MIMES, imageInfo, sniffImageMime } from '../services/imageDims';
import { auditActorName } from '../services/attendanceEdit';
import {
  PRINT_FORM_CAPS, PRINT_FORM_LOCK_PREFIX, PRINT_FORM_MESSAGES, etagMatches, formImageRefsOf, formImageVersion, isFormImageId,
} from '../services/printForms';

/**
 * «النموذج المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — صورة نموذج الشركة الفارغ: دليل المصمّم وخلفية اختيارية للطباعة.
 * مُركَّبٌ تحت /api/company/print-forms (routes/company.ts) بعد authenticate.
 *
 * البايتات في PrintFormImageBlob منفصلةً عن بياناتها الوصفية (PrintFormImage) وخارج صفّ الشركة: إعدادات الطباعة تُقرأ مع كل
 * /api/company وتُخبّأ على أجهزة المناديب، فلا تحمل إلا المرجع { id, v, wPx, hPx } (services/printForms.ts). والقرص: الخدمة على
 * Render بلا قرص دائم، فالقاعدة هي المخزن (كمرفقات القيود وشرائح البروفايل).
 *
 * - POST /       رفعٌ لمستخدم الشركة بصلاحية «إعدادات الشركة» بلا مفتاح API: خامٌ (Content-Type صورة) أو JSON { mimeType, contentBase64 }.
 *                النوع من البايتات لا من الترويسة، والأبعاد من ترويسة الصيغة، و٨ صور للشركة بقفلٍ استشاري في المعاملة (وعند السقف
 *                تُحذف الأقدم مما لا يشير إليه المحفوظ ومضى عليه يوم — PRINT_FORM_CAPS.staleMs)، والصورة
 *                نفسها (البصمة نفسها) مرة ثانية تعيد صفّها القائم بلا نسخة وتجدّد وقت رفعه (فلا يجمعه السقف وهو بيد مصمّم).
 *                ومن رفع: جلسة المالك ومفتاحه «الدعم الفني» (auditActorName) لا باسم مدير الشركة.
 * - GET /        القائمة بلا بايتات + هل يشير إليها قالبٌ في إعدادات الطباعة المحفوظة (inUse).
 * - GET /:id     البايتات لكل مسجّل في الشركة نفسها (المندوب يطبع الخلفية): تخزينٌ طويل غير قابل للتغيير ووسم ETag بالبصمة.
 * - DELETE /:id  مرفوضٌ 409 ما دام قالبٌ يشير إليها.
 */
const router = Router();

const LOCK_PREFIX = PRINT_FORM_LOCK_PREFIX;

const META_SELECT = {
  id: true, mime: true, widthPx: true, heightPx: true, sizeBytes: true, sha256: true, createdAt: true, createdByName: true,
} as const;

type Meta = { id: string; mime: string; widthPx: number; heightPx: number; sizeBytes: number; sha256: string; createdAt: Date; createdByName: string | null };
const refOf = (r: Meta) => ({ id: r.id, v: formImageVersion(r.sha256), wPx: r.widthPx, hPx: r.heightPx, sizeBytes: r.sizeBytes });

/** نتيجة معاملة الرفع: صفٌّ (جديدٌ أو القائم بالبصمة نفسها)، أو بلوغ سقف الشركة */
type UploadOutcome = { kind: 'ok'; row: Meta; created: boolean } | { kind: 'limit'; count: number };
/** كتابة حتى 1.5 ميغابايت في bytea على قاعدةٍ صغيرة — مهلةٌ فوق الافتراضي (5 ثوانٍ) كمعاملات الاستيراد */
const UPLOAD_TX = { maxWait: 10_000, timeout: 30_000 } as const;

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void => {
  res.status(status).json({ success: false, code, message, ...extra });
};

/** مفتاح API يحمل دور مُصدِره — والرفع والحذف من مصمّم النموذج في اللوحة وحدها: يُردّ بعد الحرّاس وقبل قراءة الجسم */
function refuseApiKey(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.apiKeyId) { fail(res, 403, 'API_KEY_FORBIDDEN', PRINT_FORM_MESSAGES.apiKey); return; }
  next();
}

const rawImageBody = express.raw({ type: [...FORM_IMAGE_MIMES], limit: PRINT_FORM_CAPS.rawLimitBytes });
/** قارئ الجسم الخام بعد الحرّاس: ما فوق الحدّ ⇒ 413 برمزه (لا خطأ عامّ 500 من errorHandler) */
function readRawImage(req: AuthRequest, res: Response, next: NextFunction): void {
  rawImageBody(req, res, (err?: unknown) => {
    const e = err as { type?: string; status?: number } | undefined;
    if (e && (e.type === 'entity.too.large' || e.status === 413)) { fail(res, 413, 'PRINT_FORM_TOO_LARGE', PRINT_FORM_MESSAGES.tooLarge); return; }
    next(err as Error | undefined);
  });
}

const jsonUploadSchema = z.object({ mimeType: z.string().max(100).optional(), contentBase64: z.string() });

type Upload = { ok: true; bytes: Buffer } | { ok: false; status: 400 | 413; code: string; message: string };
const contentType = (req: AuthRequest): string => String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();

/** الجسم ⇒ البايتات: خامٌ بنوع صورة، أو JSON base64 (data URL مقبول) — وما سواهما (PDF وغيره) رفضُ نوع */
function readUpload(req: AuthRequest): Upload {
  if (Buffer.isBuffer(req.body)) return { ok: true, bytes: req.body };
  const ct = contentType(req);
  if ((FORM_IMAGE_MIMES as readonly string[]).includes(ct)) return { ok: false, status: 400, code: 'PRINT_FORM_INVALID', message: PRINT_FORM_MESSAGES.invalid };
  if (ct !== 'application/json') return { ok: false, status: 400, code: 'PRINT_FORM_TYPE', message: PRINT_FORM_MESSAGES.type };
  const j = jsonUploadSchema.safeParse(req.body);
  if (!j.success) return { ok: false, status: 400, code: 'PRINT_FORM_INVALID', message: PRINT_FORM_MESSAGES.invalid };
  const declared = j.data.mimeType?.split(';')[0].trim().toLowerCase();
  if (declared !== undefined && !(FORM_IMAGE_MIMES as readonly string[]).includes(declared)) {
    return { ok: false, status: 400, code: 'PRINT_FORM_TYPE', message: PRINT_FORM_MESSAGES.type };
  }
  const b64 = j.data.contentBase64.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
  // الحجم قبل الفكّ: ٤ محارف لكل ٣ بايتات
  if (b64.length > Math.ceil(PRINT_FORM_CAPS.maxBytes / 3) * 4) return { ok: false, status: 413, code: 'PRINT_FORM_TOO_LARGE', message: PRINT_FORM_MESSAGES.tooLarge };
  if (!b64 || b64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    return { ok: false, status: 400, code: 'PRINT_FORM_INVALID', message: PRINT_FORM_MESSAGES.invalid };
  }
  return { ok: true, bytes: Buffer.from(b64, 'base64') };
}

router.post('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), refuseApiKey, readRawImage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const up = readUpload(req);
    if (!up.ok) { fail(res, up.status, up.code, up.message); return; }
    const bytes = up.bytes;
    if (bytes.length === 0) { fail(res, 400, 'PRINT_FORM_INVALID', PRINT_FORM_MESSAGES.invalid); return; }
    if (bytes.length > PRINT_FORM_CAPS.maxBytes) { fail(res, 413, 'PRINT_FORM_TOO_LARGE', PRINT_FORM_MESSAGES.tooLarge); return; }
    if (!sniffImageMime(bytes)) { fail(res, 400, 'PRINT_FORM_TYPE', PRINT_FORM_MESSAGES.type); return; }
    const info = imageInfo(bytes);
    if (!info) { fail(res, 400, 'PRINT_FORM_TYPE', PRINT_FORM_MESSAGES.unreadable); return; }
    const { minPx, maxPx } = PRINT_FORM_CAPS;
    if (info.width < minPx || info.height < minPx || info.width > maxPx || info.height > maxPx) {
      fail(res, 400, 'PRINT_FORM_SIZE', PRINT_FORM_MESSAGES.size, { wPx: info.width, hPx: info.height });
      return;
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const out = await prisma.$transaction(async (tx): Promise<UploadOutcome> => {
      // رفعان متزامنان لا يتجاوزان السقف معاً، ولا يُنشئان الصورة نفسها مرتين
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_PREFIX + tid}::text))`;
      const same = await tx.printFormImage.findFirst({ where: { tenantId: tid, sha256 }, select: META_SELECT });
      if (same) {
        // إعادة الرفع رفعٌ: تجدّد وقته فلا يعدّه جمع المهمَل (أدناه) قديماً وقد عاد لتوّه إلى مصمّمٍ لم يُحفظ بعد
        const row = await tx.printFormImage.update({ where: { id: same.id }, data: { createdAt: new Date() }, select: META_SELECT });
        return { kind: 'ok', row, created: false };
      }
      let count = await tx.printFormImage.count({ where: { tenantId: tid } });
      if (count >= PRINT_FORM_CAPS.maxImages) {
        /* جمع المهمَل عند السقف (لا واجهة لحذف الصور): الأقدم مما لا يشير إليه المحفوظ الخام ومضى على رفعه يوم — صورٌ استُبدلت
         * أو رفعُ تجربة. والأحدث يبقى: قد يحمله مصمّمٌ مفتوح لم يُحفظ بعد. تحت القفل نفسه فلا يسابقه حذفٌ ولا رفع */
        const saved = await tx.companySettings.findUnique({ where: { tenantId: tid }, select: { printSettings: true } });
        const used = new Set(formImageRefsOf(saved?.printSettings ?? null).map((r) => r.id));
        const old = await tx.printFormImage.findMany({
          where: { tenantId: tid, createdAt: { lt: new Date(Date.now() - PRINT_FORM_CAPS.staleMs) } },
          orderBy: { createdAt: 'asc' }, select: { id: true },
        });
        const drop = old.filter((r) => !used.has(r.id)).slice(0, count - PRINT_FORM_CAPS.maxImages + 1).map((r) => r.id);
        if (drop.length) count -= (await tx.printFormImage.deleteMany({ where: { tenantId: tid, id: { in: drop } } })).count;
      }
      if (count >= PRINT_FORM_CAPS.maxImages) return { kind: 'limit', count };
      const row = await tx.printFormImage.create({
        data: {
          tenantId: tid, mime: info.mime, widthPx: info.width, heightPx: info.height, sizeBytes: bytes.length, sha256,
          createdById: actorOf(req) || null, createdByName: auditActorName(req),
          blob: { create: { bytes } },
        },
        select: META_SELECT,
      });
      return { kind: 'ok', row, created: true };
    }, UPLOAD_TX);
    if (out.kind === 'limit') {
      fail(res, 409, 'PRINT_FORM_LIMIT', PRINT_FORM_MESSAGES.limit, { limit: PRINT_FORM_CAPS.maxImages, count: out.count });
      return;
    }
    res.status(out.created ? 201 : 200).json({ success: true, data: refOf(out.row) });
  } catch (err) { next(err); }
});

router.get('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [rows, settings] = await Promise.all([
      prisma.printFormImage.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, select: META_SELECT }),
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { printSettings: true } }),
    ]);
    const used = new Set(formImageRefsOf(settings?.printSettings ?? null).map((r) => r.id));
    res.json({
      success: true,
      data: rows.map((r) => ({ ...refOf(r), mime: r.mime, createdAt: r.createdAt, createdByName: r.createdByName, inUse: used.has(r.id) })),
      limit: PRINT_FORM_CAPS.maxImages,
    });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    if (!isFormImageId(id)) { fail(res, 404, 'PRINT_FORM_NOT_FOUND', PRINT_FORM_MESSAGES.notFound); return; }
    // الوصف أولاً (بلا بايتات): طلبٌ يحمل الوسم نفسه يُجاب 304 بلا قراءة المحتوى
    const meta = await prisma.printFormImage.findFirst({ where: { id, tenantId: tid }, select: { mime: true, sha256: true } });
    if (!meta) { fail(res, 404, 'PRINT_FORM_NOT_FOUND', PRINT_FORM_MESSAGES.notFound); return; }
    const etag = `"${meta.sha256}"`;
    const cache = { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
    if (etagMatches(req.headers?.['if-none-match'], etag)) { res.set(cache); res.status(304).end(); return; }
    const blob = await prisma.printFormImageBlob.findUnique({ where: { imageId: id }, select: { bytes: true } });
    if (!blob) { fail(res, 404, 'PRINT_FORM_NOT_FOUND', PRINT_FORM_MESSAGES.notFound); return; }
    const bytes = Buffer.from(blob.bytes);
    res.set({ ...cache, 'Content-Type': meta.mime, 'Content-Length': String(bytes.length) });
    res.end(bytes);
  } catch (err) { next(err); }
});

router.delete('/:id', requireAdmin, requireAdminPermission('canManageCompanySettings'), refuseApiKey, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    if (!isFormImageId(id)) { fail(res, 404, 'PRINT_FORM_NOT_FOUND', PRINT_FORM_MESSAGES.notFound); return; }
    const out = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_PREFIX + tid}::text))`;
      const img = await tx.printFormImage.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
      if (!img) return 'missing' as const;
      // المرجع في المحفوظ الخام (لا المحلَّل): قالبٌ لا يُقرأ اليوم لا يفقد صورته بصمت
      const row = await tx.companySettings.findUnique({ where: { tenantId: tid }, select: { printSettings: true } });
      if (formImageRefsOf(row?.printSettings ?? null).some((r) => r.id === id)) return 'inUse' as const;
      await tx.printFormImage.deleteMany({ where: { id, tenantId: tid } }); // المحتوى يُحذف معه (Cascade)
      return 'deleted' as const;
    });
    if (out === 'missing') { fail(res, 404, 'PRINT_FORM_NOT_FOUND', PRINT_FORM_MESSAGES.notFound); return; }
    if (out === 'inUse') { fail(res, 409, 'PRINT_FORM_IN_USE', PRINT_FORM_MESSAGES.inUse); return; }
    res.json({ success: true, data: { id } });
  } catch (err) { next(err); }
});

export default router;
