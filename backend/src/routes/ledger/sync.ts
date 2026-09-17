import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, ledgerActor, type GlActor } from '../../services/gl/audit';
import { DEFAULT_TIMEZONE, isLocalDate, zonedStartOfDay, addDays } from '../../services/gl/dates';
import { acquirePostLock } from '../../services/gl/post';
import { LedgerError } from '../../services/gl/types';
import { EVENT_ACTION_AUDIT, planEventAction, type EventAction } from '../../services/gl/checks/eventActions';
import { decodeEventNote } from '../../services/gl/sync/classify';
import { siblingPostKey } from '../../services/gl/sync/keys';
import { runLedgerManualSync } from '../../services/gl/sync/scheduler';
import { EVENT_STATUSES, SOURCE_TYPES, type ManualSyncResponse, type SourceEventPatch } from '../../services/gl/sync/types';

/**
 * المزامنة وأحداث الترحيل الآلي (M3، DESIGN.md §5.1 «مزامنة الآن»، §5.4، §2.5، ملحق أ، §9.3).
 *
 * - `POST /sync` (canViewLedger): نبضة محدودة (2 ثانية) للشركة عبر عقد الإيجار نفسه، **مرة كل 60 ثانية لكل شركة**
 *   (runManualSync). لم يفز بالعقد أو قبل مرور الحد ⇒ 202 `{running: true, pendingEvents}`؛ وإلا 200 بالنتيجة.
 * - `GET /events` (canViewLedger): قائمة الأحداث بفلاتر الحالة والنوع والتاريخ والمفتاح، مع سبب الحجب المفكوك وحالة شقيق POST.
 * - `POST /events/:id/retry|skip|release` (canConfigureLedger): تحت قفل gl-post وبشرط الحالة المقروءة، مع تدقيق
 *   EVENT_RETRY / EVENT_SKIP / EVENT_HOLD_RELEASE (skip بسبب إلزامي).
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');
const CONFIGURE = requireLedgerPermission('canConfigureLedger');

const locals = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(locals(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });

/** رمز الحالة لاستجابة «مزامنة الآن» (§5.1): 202 حين تجري نبضة أخرى أو قبل مرور الحد */
export function manualSyncHttpStatus(r: ManualSyncResponse): 200 | 202 {
  return r.running ? 202 : 200;
}

const jsonSafe = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

router.post('/sync', VIEW, ledgerHandler(async (_req, res) => {
  const { tenantId } = locals(res);
  const s = await prisma.glSettings.findUnique({ where: { tenantId }, select: { activatedAt: true } });
  if (!s?.activatedAt) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'NOT_ACTIVATED' });
  let r: ManualSyncResponse;
  try {
    r = await runLedgerManualSync(tenantId);
  } catch (e) {
    if ((e as Error)?.message === 'LEDGER_WORKER_UNAVAILABLE') {
      throw new LedgerHttpError(503, 'معالج الترحيل غير متاح حالياً', { reason: 'LEDGER_WORKER_UNAVAILABLE' });
    }
    throw e;
  }
  res.status(manualSyncHttpStatus(r)).json({ success: true, running: r.running, pendingEvents: r.pendingEvents, data: jsonSafe(r) });
}));

// ═══ الأحداث ═══

const PAGE_MAX = 200;

function listOf(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return raw.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
}

/** where من معاملات الاستعلام (صرفة) */
export function eventsWhere(tenantId: string, q: Record<string, unknown>, timezone: string): Prisma.GlSourceEventWhereInput {
  const statuses = listOf(q.status).filter((s) => (EVENT_STATUSES as readonly string[]).includes(s));
  const types = listOf(q.sourceType).filter((s) => (SOURCE_TYPES as readonly string[]).includes(s));
  const events = listOf(q.event).filter((s) => ['POST', 'REVERSE', 'COGS', 'RESTOCK'].includes(s));
  const where: Prisma.GlSourceEventWhereInput = { tenantId };
  if (statuses.length) where.status = { in: statuses };
  if (types.length) where.sourceType = { in: types };
  if (events.length) where.event = { in: events };
  const effectAt: Prisma.DateTimeFilter = {};
  if (typeof q.dateFrom === 'string' && isLocalDate(q.dateFrom)) effectAt.gte = zonedStartOfDay(q.dateFrom, timezone);
  if (typeof q.dateTo === 'string' && isLocalDate(q.dateTo)) effectAt.lt = zonedStartOfDay(addDays(q.dateTo, 1), timezone);
  if (effectAt.gte || effectAt.lt) where.effectAt = effectAt;
  const search = typeof q.q === 'string' ? q.q.trim().slice(0, 200) : '';
  if (search) where.OR = [{ sourceKey: { contains: search } }, { sourceId: search }];
  return where;
}

router.get('/events', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as Record<string, unknown>;
  const s = await prisma.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } });
  const where = eventsWhere(tenantId, q, s?.timezone || DEFAULT_TIMEZONE);
  const offset = Math.max(0, Math.min(1_000_000, Number(q.offset) || 0));
  const limit = Math.max(1, Math.min(PAGE_MAX, Number(q.limit) || 50));
  const [rows, total, counts] = await Promise.all([
    prisma.glSourceEvent.findMany({
      where, orderBy: [{ effectAt: 'asc' }, { sourceKey: 'asc' }], skip: offset, take: limit,
      select: {
        id: true, sourceKey: true, sourceType: true, sourceId: true, event: true, effectAt: true, detectedAt: true, status: true,
        skipReason: true, attempts: true, nextAttemptAt: true, lastError: true, moveId: true, processedAt: true,
        nonCustodyClearedMilli: true, shortageRecoveredMilli: true,
      },
    }),
    prisma.glSourceEvent.count({ where }),
    prisma.glSourceEvent.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
  ]);
  const siblingKeys = [...new Set(rows.map((r) => siblingPostKey(r.sourceKey)).filter((k): k is string => !!k))];
  const siblings = siblingKeys.length
    ? await prisma.glSourceEvent.findMany({
      where: { tenantId, sourceKey: { in: siblingKeys } },
      select: { sourceKey: true, status: true, skipReason: true, nextAttemptAt: true, moveId: true },
    })
    : [];
  const sibByKey = new Map(siblings.map((x) => [x.sourceKey, x]));
  const moveIds = [...new Set(rows.map((r) => r.moveId).filter((m): m is string => !!m))];
  const moves = moveIds.length
    ? await prisma.glMove.findMany({ where: { tenantId, id: { in: moveIds } }, select: { id: true, number: true } })
    : [];
  const numberOf = new Map(moves.map((m) => [m.id, m.number]));
  res.json({
    success: true,
    data: {
      total, offset, limit,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      rows: rows.map((r) => {
        const k = siblingPostKey(r.sourceKey);
        const sib = k ? sibByKey.get(k) : undefined;
        return {
          ...r,
          nonCustodyClearedMilli: r.nonCustodyClearedMilli?.toString() ?? null,
          shortageRecoveredMilli: r.shortageRecoveredMilli?.toString() ?? null,
          note: decodeEventNote(r.lastError),
          moveNumber: r.moveId ? numberOf.get(r.moveId) ?? null : null,
          sibling: k ? { sourceKey: k, status: sib?.status ?? null, skipReason: sib?.skipReason ?? null, nextAttemptAt: sib?.nextAttemptAt ?? null, moveId: sib?.moveId ?? null } : null,
        };
      }),
    },
  });
}));

const ACTION_MESSAGES: Record<string, string> = {
  STATUS_NOT_ALLOWED: 'حالة الحدث لا تسمح بهذا الإجراء',
  REASON_REQUIRED: 'سبب التخطي مطلوب',
  STATUS_CHANGED: 'تغيّرت حالة الحدث — أعد التحميل',
};

async function eventAction(req: AuthRequest, res: Response, action: EventAction): Promise<void> {
  const { tenantId } = locals(res);
  const id = String(req.params.id);
  const actor = actorOf(req, res);
  const out = await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    const ev = await tx.glSourceEvent.findFirst({
      where: { id, tenantId },
      select: { id: true, sourceKey: true, status: true, skipReason: true, attempts: true, nextAttemptAt: true, lastError: true },
    });
    if (!ev) throw new LedgerHttpError(404, 'الحدث غير موجود', { reason: 'NOT_FOUND', id });
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
    const plan = planEventAction(action, ev.status, { reason: req.body?.reason, now });
    if (!plan.ok) {
      throw new LedgerHttpError(plan.reason === 'REASON_REQUIRED' ? 422 : 409, ACTION_MESSAGES[plan.reason], {
        reason: plan.reason, status: ev.status, allowed: plan.allowed,
      });
    }
    const upd = await tx.glSourceEvent.updateMany({ where: { id, tenantId, status: plan.onlyIfStatus }, data: patchData(plan.patch) });
    if (upd.count !== 1) throw new LedgerHttpError(409, ACTION_MESSAGES.STATUS_CHANGED, { reason: 'STATUS_CHANGED' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : null;
    await appendAudit(tx, {
      tenantId, actor, action: EVENT_ACTION_AUDIT[action], entityType: 'SOURCE_EVENT', entityId: ev.id,
      summary: `${action === 'skip' ? 'تخطي' : action === 'release' ? 'إفراج عن' : 'إعادة محاولة'} الحدث ${ev.sourceKey}${reason ? `: ${reason}` : ''}`,
      before: { status: ev.status, skipReason: ev.skipReason, attempts: ev.attempts, nextAttemptAt: ev.nextAttemptAt, lastError: ev.lastError },
      after: { ...plan.patch, reason },
    });
    return { id: ev.id, sourceKey: ev.sourceKey, status: plan.patch.status, skipReason: plan.patch.skipReason ?? null };
  }, { maxWait: 10_000, timeout: 20_000 });
  res.json({ success: true, data: out });
}

function patchData(p: SourceEventPatch): Prisma.GlSourceEventUpdateManyMutationInput {
  const d: Prisma.GlSourceEventUpdateManyMutationInput = {};
  if (p.status !== undefined) d.status = p.status;
  if (p.skipReason !== undefined) d.skipReason = p.skipReason;
  if (p.attempts !== undefined) d.attempts = p.attempts;
  if (p.nextAttemptAt !== undefined) d.nextAttemptAt = p.nextAttemptAt;
  if (p.lastError !== undefined) d.lastError = p.lastError;
  if (p.processedAt !== undefined) d.processedAt = p.processedAt;
  return d;
}

router.post('/events/:id/retry', CONFIGURE, ledgerHandler((req, res) => eventAction(req, res, 'retry')));
router.post('/events/:id/skip', CONFIGURE, ledgerHandler((req, res) => eventAction(req, res, 'skip')));
router.post('/events/:id/release', CONFIGURE, ledgerHandler((req, res) => eventAction(req, res, 'release')));

export default router;
