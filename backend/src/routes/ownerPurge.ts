/**
 * «الحذف النهائي» — لمالك المنصة وحده داخل جلسة «دخول» أصدرها هو (لا موظف المنصة، ولا مدير الشركة، ولا مفتاح API).
 * المحرّك في services/ownerPurge.ts. كل حذفٍ سطرٌ في سجل نشاط المنصة (PlatformAuditLog) بما حُذف.
 */
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { buildPurgePlan, delegateOf, executePurge, labelFieldsOf, PurgeRefused, targetableModels } from '../services/ownerPurge';

const router = Router();

/** جلسة المالك نفسه: توكن «دخول» مُصدِره المالك (byKind OWNER) — authenticate تحقّق أن المُصدِر حيّ */
export function isPlatformOwnerSession(req: AuthRequest): boolean {
  const u = req.user as unknown as { impersonated?: boolean; byKind?: string; apiKeyId?: string } | undefined;
  return u?.impersonated === true && u?.byKind === 'OWNER' && !u?.apiKeyId;
}

router.use(authenticate);
router.use((req: AuthRequest, res: Response, next: NextFunction) => {
  if (!isPlatformOwnerSession(req)) { res.status(403).json({ success: false, code: 'OWNER_ONLY', message: 'الحذف النهائي لمالك المنصة وحده' }); return; }
  next();
});

const MODEL = z.string().min(1).max(64).regex(/^[A-Z][A-Za-z0-9]*$/);

/** أنواع السجلات القابلة للحذف */
router.get('/models', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: targetableModels().map((m) => ({ model: m, fields: labelFieldsOf(m) })) });
});

/** بحث بالرقم/الاسم/الرمز أو المعرّف — ٢٠ نتيجة */
router.get('/search', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const model = MODEL.parse(req.query.model);
    const q = String(req.query.q ?? '').trim().slice(0, 120);
    if (!targetableModels().includes(model)) { res.status(400).json({ success: false, message: 'نوع غير معروف' }); return; }
    const fields = labelFieldsOf(model);
    const or: Array<Record<string, unknown>> = q ? fields.map((f) => ({ [f]: { contains: q, mode: 'insensitive' } })) : [];
    if (q) or.push({ id: q });
    const select: Record<string, true> = { id: true };
    for (const f of fields) select[f] = true;
    const d = (prisma as unknown as Record<string, { findMany(a: unknown): Promise<Array<Record<string, unknown>>> }>)[delegateOf(model)];
    const rows = await d.findMany({
      where: { tenantId: tenantId(req), ...(or.length && { OR: or }) },
      select, take: 20,
    }).catch(() => d.findMany({ where: { tenantId: tenantId(req), ...(q && { id: q }) }, select: { id: true }, take: 20 }));
    res.json({ success: true, data: rows.map((r) => ({ id: String(r.id), label: fields.map((f) => r[f]).filter((v) => v != null && v !== '').join(' · ') || String(r.id) })) });
  } catch (err) { next(err); }
});

const TARGET = z.object({ model: MODEL, id: z.string().min(1).max(100) });

/** المعاينة: ما سيُحذف وما يُفرَّغ مفتاحه — بلا كتابة */
router.post('/preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { model, id } = TARGET.parse(req.body);
    const plan = await buildPurgePlan(prisma, tenantId(req), model, id);
    res.json({ success: true, data: { counts: plan.counts, nullCounts: plan.nullCounts } });
  } catch (err) {
    if (err instanceof PurgeRefused) { res.status(404).json({ success: false, message: err.message }); return; }
    next(err);
  }
});

/** الحذف النهائي */
router.post('/delete', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { model, id } = TARGET.parse(req.body);
    const tid = tenantId(req);
    const result = await executePurge(tid, model, id);
    const u = req.user as unknown as { by?: string; id?: string };
    await prisma.platformAuditLog.create({
      data: {
        actorType: 'OWNER', actorId: String(u.by ?? ''), action: 'owner.purge', method: 'POST', path: '/api/owner-purge/delete', status: 200,
        targetId: id, detail: JSON.stringify({ tenantId: tid, model, counts: result.counts, nullCounts: result.nullCounts }).slice(0, 4000),
        ip: req.ip ?? null,
      },
    }).catch(() => { /* السجل لا يُسقط حذفاً تمّ */ });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof PurgeRefused) { res.status(404).json({ success: false, message: err.message }); return; }
    next(err);
  }
});

export default router;
