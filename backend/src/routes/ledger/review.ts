import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { LedgerLocals } from './context';
import { ledgerHandler } from './errors';
import { DEFAULT_TIMEZONE } from '../../services/gl/dates';
import { instantRange, listOf, pageOf } from './customers';

/**
 * «مراجعة ← سجل التدقيق» (M3، DESIGN.md §8.2 `review/audit`، §8.3 «عرض سجل التدقيق»، §9.3).
 *
 * `GET /audit` (canConfigureLedger، قراءة فقط): صفوف GlAuditLog للشركة بترتيب `seq` تنازلياً (السلسلة تُبنى بالتسلسل
 * لا بالوقت)، بفلاتر `entityType` و`entityId` (رابط «عرض سجل التدقيق» في LedgerForm) و`action` (قائمة بفواصل)
 * و`actorType` و`dateFrom/dateTo` (محلي) و`q` (الملخص يحتوي). لا نقطة تحذف السجل أو تعدّله.
 */
const router = Router();
const CONFIGURE = requireLedgerPermission('canConfigureLedger');

const locals = (res: Response) => res.locals.ledger as LedgerLocals;

export const AUDIT_ACTOR_TYPES = ['ADMIN', 'IMPERSONATION', 'SYSTEM', 'OWNER'] as const;

/** where من معاملات الاستعلام (صرفة) */
export function auditWhere(tenantId: string, q: Record<string, unknown>, timezone: string): Prisma.GlAuditLogWhereInput {
  const where: Prisma.GlAuditLogWhereInput = { tenantId };
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);
  const entityType = text(q.entityType);
  if (entityType) where.entityType = entityType;
  const entityId = text(q.entityId);
  if (entityId) where.entityId = entityId;
  const actions = listOf(q.action).filter((a) => /^[A-Z_]+$/.test(a));
  if (actions.length) where.action = { in: actions };
  const actorTypes = listOf(q.actorType, AUDIT_ACTOR_TYPES);
  if (actorTypes.length) where.actorType = { in: actorTypes };
  const range = instantRange(q, timezone);
  if (range) where.at = range;
  const search = text(q.q);
  if (search) where.summary = { contains: search, mode: 'insensitive' };
  return where;
}

router.get('/audit', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as Record<string, unknown>;
  const s = await prisma.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } });
  const where = auditWhere(tenantId, q, s?.timezone || DEFAULT_TIMEZONE);
  const page = pageOf(q, 200, 50);
  const [rows, total] = await Promise.all([
    prisma.glAuditLog.findMany({
      where, orderBy: { seq: 'desc' }, skip: page.offset, take: page.limit,
      select: {
        id: true, seq: true, at: true, actorType: true, actorId: true, actorName: true, impersonated: true, action: true,
        entityType: true, entityId: true, summary: true, beforeJson: true, afterJson: true, requestIp: true, hash: true, prevHash: true,
      },
    }),
    prisma.glAuditLog.count({ where }),
  ]);
  res.json({ success: true, data: { rows, total, ...page } });
}));

export default router;
