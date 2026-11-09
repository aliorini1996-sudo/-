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
import { findArchivedProducts, mergeArchivedProduct, MergeRefused } from '../services/productTwins';
import { asLotBusy } from '../services/lots';

const router = Router();

/** جلسة المالك نفسه: توكن «دخول» مُصدِره المالك (byKind OWNER) — authenticate تحقّق أن المُصدِر حيّ */
export function isPlatformOwnerSession(req: AuthRequest): boolean {
  const u = req.user as unknown as { impersonated?: boolean; byKind?: string; staffFull?: boolean; apiKeyId?: string } | undefined;
  // وموظف المنصة بكل الصلاحيات (staffFull حيّ من authenticate) كالمالك تماماً — أمر المالك ٩ نوفمبر ٢٠٢٦
  return u?.impersonated === true && (u?.byKind === 'OWNER' || (u?.byKind === 'STAFF' && u?.staffFull === true)) && !u?.apiKeyId;
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

const ID = z.string().min(1).max(100);
/** سجلٌّ واحد (id) أو عدّة سجلات من النوع نفسه (ids — التحديد الجماعي في القوائم، حتى ٥٠٠) */
const TARGET = z.object({ model: MODEL, id: ID.optional(), ids: z.array(ID).min(1).max(500).optional() })
  .refine((v) => !!v.id || !!v.ids?.length, { message: 'حدد سجلاً' })
  .transform((v) => ({ model: v.model, ids: v.ids?.length ? v.ids : [v.id!] }));

/** المعاينة: ما سيُحذف وما يُفرَّغ مفتاحه — بلا كتابة */
router.post('/preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { model, ids } = TARGET.parse(req.body);
    const plan = await buildPurgePlan(prisma, tenantId(req), model, ids);
    res.json({ success: true, data: { counts: plan.counts, nullCounts: plan.nullCounts } });
  } catch (err) {
    if (err instanceof PurgeRefused) { res.status(404).json({ success: false, message: err.message }); return; }
    next(err);
  }
});

/** الحذف النهائي */
router.post('/delete', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { model, ids } = TARGET.parse(req.body);
    const tid = tenantId(req);
    const result = await executePurge(tid, model, ids);
    const u = req.user as unknown as { by?: string; id?: string };
    await prisma.platformAuditLog.create({
      data: {
        actorType: 'OWNER', actorId: String(u.by ?? ''), action: 'owner.purge', method: 'POST', path: '/api/owner-purge/delete', status: 200,
        targetId: ids[0], detail: JSON.stringify({ tenantId: tid, model, ids: ids.slice(0, 50), n: ids.length, counts: result.counts, nullCounts: result.nullCounts }).slice(0, 4000),
        ip: req.ip ?? null,
      },
    }).catch(() => { /* السجل لا يُسقط حذفاً تمّ */ });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof PurgeRefused) { res.status(404).json({ success: false, message: err.message }); return; }
    next(err);
  }
});

/**
 * «التوائم المؤرشفة» (services/productTwins.ts): الأصناف المؤرشفة قبل الحذف الحقيقي (٥ نوفمبر ٢٠٢٦) مع توأمها القائم المقترح
 * ورصيدها الباقي في السيارات وعدد حركاتها — قراءةٌ فقط
 */
router.get('/archived-products', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await findArchivedProducts(prisma, tenantId(req)) });
  } catch (err) { next(err); }
});

const MERGE = z.object({ pairs: z.array(z.object({ fromId: ID, toId: ID })).min(1).max(200) });

/**
 * دمج المؤرشف في توأمه: كل زوجٍ في معاملته — حركات A وتاريخه إلى B ثم حذف A نهائياً. فشل زوجٍ لا يوقف غيره (failed[])،
 * وكل دمجٍ تمّ سطرٌ في سجل نشاط المنصة
 */
router.post('/archived-products/merge', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { pairs } = MERGE.parse(req.body ?? {});
    const tid = tenantId(req);
    const u = req.user as unknown as { by?: string };
    const merged: Array<{ fromId: string; toId: string; moved: Record<string, number> }> = [];
    const failed: Array<{ fromId: string; toId: string; code: string; message: string }> = [];
    const seen = new Set<string>();
    for (const { fromId, toId } of pairs) {
      if (seen.has(fromId)) { failed.push({ fromId, toId, code: 'DUPLICATE', message: 'الصنف مكرر في الطلب' }); continue; }
      seen.add(fromId);
      try {
        const r = await prisma.$transaction((tx) => mergeArchivedProduct(tx, tid, fromId, toId), { maxWait: 10_000, timeout: 60_000 });
        merged.push({ fromId, toId, moved: r.moved });
        await prisma.platformAuditLog.create({
          data: {
            actorType: 'OWNER', actorId: String(u.by ?? ''), action: 'owner.mergeArchivedProduct', method: 'POST',
            path: '/api/owner-purge/archived-products/merge', status: 200, targetId: fromId,
            detail: JSON.stringify({ tenantId: tid, toId, moved: r.moved, deleted: r.deleted }).slice(0, 4000),
            ip: req.ip ?? null,
          },
        }).catch(() => { /* السجل لا يُسقط دمجاً تمّ */ });
      } catch (err) {
        if (err instanceof MergeRefused) failed.push({ fromId, toId, code: err.code, message: err.message });
        else if (asLotBusy(err)) failed.push({ fromId, toId, code: 'BUSY', message: 'الصنف مشغول بحركة أخرى أعد المحاولة بعد لحظات' });
        else {
          console.error('[owner-purge] merge archived product failed', fromId, toId, err);
          failed.push({ fromId, toId, code: 'ERROR', message: `تعذر الدمج: ${String((err as Error)?.message ?? err).slice(0, 300)}` });
        }
      }
    }
    res.json({ success: true, data: { merged, failed } });
  } catch (err) { next(err); }
});

/**
 * العملاء المحذوفون قبل ٥ نوفمبر ٢٠٢٦ (status DELETED — نسخة مخفية بأثرها المالي). قرار المالك (٧ نوفمبر): «يُحذفون مع فواتيرهم»
 * — يُعرضون هنا بعدد مستنداتهم، ويحذفها المالك بـPOST /delete { model: 'Customer', ids } (المحرّك يحذف الفواتير والسندات والقيود)
 */
router.get('/archived-customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = await prisma.customer.findMany({
      where: { tenantId: tid, status: 'DELETED' },
      select: { id: true, name: true, code: true, phone: true, balance: true },
      orderBy: { name: 'asc' }, take: 5000,
    });
    const ids = rows.map((r) => r.id);
    const [inv, rec] = ids.length ? await Promise.all([
      prisma.invoice.groupBy({ by: ['customerId'], where: { tenantId: tid, customerId: { in: ids } }, _count: { _all: true } }),
      prisma.receipt.groupBy({ by: ['customerId'], where: { tenantId: tid, customerId: { in: ids } }, _count: { _all: true } }),
    ]) : [[], []];
    const invOf = new Map(inv.map((x) => [x.customerId, x._count._all]));
    const recOf = new Map(rec.map((x) => [x.customerId, x._count._all]));
    res.json({
      success: true,
      data: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, phone: r.phone, balance: Number(r.balance), invoices: invOf.get(r.id) ?? 0, receipts: recOf.get(r.id) ?? 0 })),
    });
  } catch (err) { next(err); }
});

export default router;
