import { Router, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, ledgerActor } from '../../services/gl/audit';
import { GlNotFoundError } from '../../services/gl/resolve';

/**
 * مفضلات البحث في قوائم الدفاتر (GlSavedFilter، NAV‑09، §8.3) — canViewLedger للقراءة والكتابة (ملحق أ).
 * - GET يعيد مفضلات المستخدم ومفضلات الشركة المشتركة للشاشة.
 * - POST ينشئ مفضلة للمستخدم نفسه؛ isDefault يُسقط افتراضية مفضلاته الأخرى للشاشة نفسها.
 * - DELETE لمفضلات المستخدم وحده (مفضلة مشتركة لغيره ⇒ 404).
 * كل كتابة تُدقَّق SAVED_FILTER_CHANGE في معاملتها (§9.3).
 */
const router = Router();

const locals = (res: Response) => res.locals.ledger as LedgerLocals;

/** معرّف الشاشة: entries | items | accounts | review/… */
export const SAVED_FILTER_SCREEN_RE = /^[a-z][a-z0-9_/-]{0,59}$/;
/** سقف حجم domainJson مسلسلاً. */
export const SAVED_FILTER_MAX_JSON = 20_000;

const SELECT = {
  id: true, userId: true, screen: true, name: true, domainJson: true, isDefault: true, isShared: true, createdAt: true,
} as const;

const createSchema = z.object({
  screen: z.string().regex(SAVED_FILTER_SCREEN_RE),
  name: z.string().trim().min(1).max(100),
  domainJson: z.record(z.unknown()),
  isDefault: z.boolean().optional(),
  isShared: z.boolean().optional(),
});

router.get('/saved-filters', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const { tenantId, actorId } = locals(res);
  const screen = typeof req.query.screen === 'string' ? req.query.screen : undefined;
  if (screen !== undefined && !SAVED_FILTER_SCREEN_RE.test(screen)) {
    throw new LedgerHttpError(400, 'شاشة غير صالحة', { reason: 'INVALID_SCREEN' });
  }
  const rows = await prisma.glSavedFilter.findMany({
    where: { tenantId, ...(screen ? { screen } : {}), OR: [{ userId: actorId }, { isShared: true }] },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: SELECT,
    take: 500,
  });
  res.json({ success: true, data: rows.map((r) => ({ ...r, mine: r.userId === actorId })) });
}));

router.post('/saved-filters', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const l = locals(res);
  const body = createSchema.parse(req.body);
  if (JSON.stringify(body.domainJson).length > SAVED_FILTER_MAX_JSON) {
    throw new LedgerHttpError(413, 'المفضلة أكبر من المسموح', { reason: 'FILTER_TOO_LARGE', cap: SAVED_FILTER_MAX_JSON });
  }
  const actor = ledgerActor(l, { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });
  const created = await prisma.$transaction(async (tx) => {
    if (body.isDefault) {
      await tx.glSavedFilter.updateMany({
        where: { tenantId: l.tenantId, userId: l.actorId, screen: body.screen, isDefault: true },
        data: { isDefault: false },
      });
    }
    const row = await tx.glSavedFilter.create({
      data: {
        tenantId: l.tenantId, userId: l.actorId, screen: body.screen, name: body.name,
        domainJson: body.domainJson as Prisma.InputJsonValue, isDefault: body.isDefault === true, isShared: body.isShared === true,
      },
      select: SELECT,
    });
    await appendAudit(tx, {
      tenantId: l.tenantId, actor, action: 'SAVED_FILTER_CHANGE', entityType: 'SAVED_FILTER', entityId: row.id,
      summary: `حفظ مفضلة «${row.name}» لشاشة ${row.screen}`,
      after: { screen: row.screen, name: row.name, isDefault: row.isDefault, isShared: row.isShared, domainJson: row.domainJson },
    });
    return row;
  });
  res.status(201).json({ success: true, data: { ...created, mine: true } });
}));

router.delete('/saved-filters/:id', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const l = locals(res);
  const id = String(req.params.id);
  const actor = ledgerActor(l, { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });
  await prisma.$transaction(async (tx) => {
    const row = await tx.glSavedFilter.findFirst({ where: { id, tenantId: l.tenantId, userId: l.actorId }, select: SELECT });
    if (!row) throw new GlNotFoundError('GlSavedFilter', id);
    const del = await tx.glSavedFilter.deleteMany({ where: { id, tenantId: l.tenantId, userId: l.actorId } });
    if (del.count !== 1) throw new GlNotFoundError('GlSavedFilter', id);
    await appendAudit(tx, {
      tenantId: l.tenantId, actor, action: 'SAVED_FILTER_CHANGE', entityType: 'SAVED_FILTER', entityId: id,
      summary: `حذف مفضلة «${row.name}» من شاشة ${row.screen}`,
      before: { screen: row.screen, name: row.name, isDefault: row.isDefault, isShared: row.isShared, domainJson: row.domainJson },
    });
  });
  res.json({ success: true, data: { id } });
}));

export default router;
