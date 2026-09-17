import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { LedgerLocals } from './context';
import { ledgerHandler } from './errors';
import { appendAudit, ledgerActor, type GlTx } from '../../services/gl/audit';
import { acquirePostLock } from '../../services/gl/post';
import { settingsSnapshotFromRow } from '../../services/gl/resolve';
import { fromDbDate, isLocalDate, toDbDate, todayLocal } from '../../services/gl/dates';
import {
  LOCK_DATE_FIELDS, LOCK_SYNC_EVENT_LIMIT, draftsBeforeLock, lockSyncBlockers, lockSyncEventWhere, planLockDateChange,
  type LockDateField, type LockDates, type LockSyncInput, type SyncCursorSnapshot,
} from '../../services/gl/locks';
import { LedgerError, type BackfillState, type LocalDate } from '../../services/gl/types';
import type { PrismaClient } from '@prisma/client';
import { isReconciledSource } from '../../services/gl/sync/desired';
import { reconcileHorizon } from '../../services/gl/sync/reconciler';
import { createPrismaReconcilerStore } from '../../services/gl/sync/reconcilerStore.prisma';

/**
 * تواريخ الإقفال — `GET/PUT /api/ledger/lock-dates` بصلاحية canCloseLedgerPeriods (M2، §2.5، LOCK‑01، §9.5 G3).
 *
 * ترتيب PUT في معاملة واحدة:
 * 1. pg_advisory_xact_lock(hashtext('gl-post:'||tid)) — قفل الترحيل نفسه، **أول عبارة** (postMove يعيد قراءة
 *    تواريخ الإقفال بعد القفل، فلا يُرحَّل قيد داخل فترة أُقفلت قبله بلحظات).
 * 2. قراءة GlSettings (غيابه ⇒ 409 LEDGER_NOT_SETUP) وساعة القاعدة، ثم planLockDateChange الصرفة:
 *    النهائي لا يتراجع (LEDGER_LOCK_DATE_BACKWARD)، ولا تاريخ في المستقبل بتوقيت الشركة.
 * 3. لكل تاريخ **يتقدم**: lockSyncBlockers بالحالة الفعلية (activatedAt، backfillState، المؤشرات، الأحداث) ⇒
 *    409 LEDGER_NOT_SETUP أو LEDGER_SYNC_PENDING؛ ثم المسودات حتى التاريخ ⇒ 422 LEDGER_DRAFTS_BEFORE_LOCK.
 *    التراجع في المبيعات والمشتريات والضريبة لا يُفحص.
 * 4. الكتابة، ثم GlAuditLog بـLOCK_DATE_CHANGE، ثم إشعار للشركة — كلها داخل المعاملة.
 */
const router = Router();
const PERM = requireLedgerPermission('canCloseLedgerPeriods');
const DRAFT_ROWS_LIMIT = 200;

const ledgerOf = (res: Response) => res.locals.ledger as LedgerLocals;
const dateOut = (d: Date | null | undefined): LocalDate | null => (d ? fromDbDate(d) : null);

const FIELD_LABELS: Record<LockDateField, string> = {
  salesLockDate: 'إقفال المبيعات',
  purchaseLockDate: 'إقفال المشتريات',
  taxLockDate: 'إقفال الضريبة',
  hardLockDate: 'الإقفال النهائي',
};

type LockSettingsRow = {
  timezone: string;
  inventoryMode: string;
  activatedAt: Date | null;
  backfillState: string;
  salesLockDate: Date | null;
  purchaseLockDate: Date | null;
  taxLockDate: Date | null;
  hardLockDate: Date | null;
};

export function lockDatesOut(s: Pick<LockSettingsRow, LockDateField>): LockDates {
  return {
    salesLockDate: dateOut(s.salesLockDate),
    purchaseLockDate: dateOut(s.purchaseLockDate),
    taxLockDate: dateOut(s.taxLockDate),
    hardLockDate: dateOut(s.hardLockDate),
  };
}

/**
 * مدخلات lockSyncBlockers من القاعدة لتاريخ جديد: المؤشرات، وأول 50 حدثاً حاجباً بتاريخ محلي ≤ التاريخ
 * (الفهرس [tenantId, status, effectAt]) مع عددها.
 * hasUnreadRows (M3، الالتزام 2): للمصادر الثلاثة التي يقرؤها المُطابِق استعلام EXISTS فعلي
 * `("createdAt","id") > المؤشر AND "createdAt" <= horizon` (horizon = dbNow − LATE_COMMIT_WINDOW، §5.2 البند 5) عبر
 * ReconcilerStore.hasUnreadRows داخل المعاملة نفسها؛ ومصادر المخزون (M9، بلا مُطابِق بعد) تبقى true المحافظة.
 */
export async function loadLockSyncInput(
  tx: GlTx, tenantId: string, s: LockSettingsRow, newDate: LocalDate, now: Date,
): Promise<LockSyncInput> {
  const tz = s.timezone;
  const where = { tenantId, ...lockSyncEventWhere(newDate, tz) };
  const [cursors, events, eventCount] = await Promise.all([
    tx.glSyncCursor.findMany({ where: { tenantId }, select: { source: true, watermarkAt: true, watermarkId: true, lastRunAt: true } }),
    tx.glSourceEvent.findMany({
      where, orderBy: { effectAt: 'asc' }, take: LOCK_SYNC_EVENT_LIMIT,
      select: { id: true, sourceKey: true, status: true, effectAt: true, lastError: true },
    }),
    tx.glSourceEvent.count({ where }),
  ]);
  const reconciler = createPrismaReconcilerStore(tx as unknown as PrismaClient);
  const horizon = reconcileHorizon(now);
  const snapshots: SyncCursorSnapshot[] = [];
  for (const c of cursors) {
    const hasUnreadRows = isReconciledSource(c.source)
      ? await reconciler.hasUnreadRows(tenantId, c.source, { at: c.watermarkAt, id: c.watermarkId }, horizon)
      : true;
    snapshots.push({ source: c.source, watermarkAt: c.watermarkAt, lastRunAt: c.lastRunAt, hasUnreadRows });
  }
  return {
    settings: {
      timezone: tz,
      inventoryMode: s.inventoryMode === 'PERPETUAL' ? 'PERPETUAL' : 'PERIODIC',
      activatedAt: s.activatedAt,
      backfillState: s.backfillState as BackfillState,
    },
    cursors: snapshots,
    eventSummary: { events, eventCount },
    newDate,
    now,
  };
}

router.get('/lock-dates', PERM, ledgerHandler(async (_req, res) => {
  const { tenantId } = ledgerOf(res);
  const s = await prisma.glSettings.findUnique({ where: { tenantId } });
  if (!s) {
    res.json({
      success: true,
      data: { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: null, today: null, timezone: null, activatedAt: null, backfillState: 'NONE', setupRequired: true },
    });
    return;
  }
  res.json({
    success: true,
    data: {
      ...lockDatesOut(s), today: todayLocal(new Date(), s.timezone), timezone: s.timezone,
      activatedAt: s.activatedAt, backfillState: s.backfillState, setupRequired: s.activatedAt == null,
    },
  });
}));

const lockDateValue = z.string().refine(isLocalDate, 'تاريخ غير صالح YYYY-MM-DD').nullable().optional();
const lockDatesSchema = z.object({
  salesLockDate: lockDateValue,
  purchaseLockDate: lockDateValue,
  taxLockDate: lockDateValue,
  hardLockDate: lockDateValue,
}).strict().refine((b) => LOCK_DATE_FIELDS.some((f) => b[f] !== undefined), 'لا تاريخ إقفال في الطلب');

router.put('/lock-dates', PERM, ledgerHandler(async (req, res) => {
  const ctx = ledgerOf(res);
  const { tenantId } = ctx;
  const body = lockDatesSchema.parse(req.body);
  const actor = ledgerActor(ctx, { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });

  const result = await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    const s = await tx.glSettings.findUnique({ where: { tenantId } });
    if (!s) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const snap = settingsSnapshotFromRow(s);
    const current = lockDatesOut(s);
    const today = todayLocal(now, snap.timezone);
    const plan = planLockDateChange({ current, next: body, today });
    const changed = plan.changes.filter((c) => c.direction !== 'UNCHANGED');
    if (!changed.length) return { dates: current, changed: [] as LockDateField[] };

    // §2.5: لكل تاريخ يتقدم — عوائق المزامنة (ومنها activatedAt فارغ ⇒ LEDGER_NOT_SETUP)، ثم المسودات
    for (const adv of plan.advancing) {
      const blockers = lockSyncBlockers(await loadLockSyncInput(tx, tenantId, s, adv.newDate, now));
      if (blockers) {
        const { code, ...details } = blockers;
        throw new LedgerError(code, { ...details, field: adv.field, date: adv.newDate });
      }
    }
    for (const adv of plan.advancing) {
      const where = { tenantId, state: 'DRAFT', date: { lte: toDbDate(adv.newDate) } };
      const [rows, count] = await Promise.all([
        tx.glMove.findMany({
          where, orderBy: { date: 'asc' }, take: DRAFT_ROWS_LIMIT,
          select: { id: true, date: true, ref: true, totalMilli: true, journal: { select: { code: true } } },
        }),
        tx.glMove.count({ where }),
      ]);
      const hit = draftsBeforeLock(rows.map((r) => ({ id: r.id, date: fromDbDate(r.date) })), adv.newDate);
      if (hit) {
        throw new LedgerError('LEDGER_DRAFTS_BEFORE_LOCK', {
          ...hit, count, field: adv.field, date: adv.newDate,
          drafts: rows.map((r) => ({ id: r.id, date: fromDbDate(r.date), ref: r.ref, journalCode: r.journal.code, total: Number(r.totalMilli) / 1000 })),
        });
      }
    }

    const data: Partial<Record<LockDateField, Date | null>> = {};
    for (const c of changed) data[c.field] = c.to ? toDbDate(c.to) : null;
    const updated = await tx.glSettings.update({ where: { tenantId }, data });
    const before: Partial<LockDates> = {};
    const after: Partial<LockDates> = {};
    for (const c of changed) { before[c.field] = c.from; after[c.field] = c.to; }
    const summary = changed.map((c) => `${FIELD_LABELS[c.field]}: ${c.from ?? '—'} ← ${c.to ?? '—'}`).join('، ');
    await appendAudit(tx, {
      tenantId, actor, action: 'LOCK_DATE_CHANGE', entityType: 'SETTINGS', entityId: s.id,
      summary: `تغيير تواريخ الإقفال (${summary})`, before, after,
    });
    // §9.3: تغيير تاريخ إقفال يولّد إشعاراً للشركة
    await tx.notification.create({
      data: {
        tenantId, type: 'LEDGER_LOCK_DATE_CHANGE', title: 'تغيير تواريخ الإقفال',
        body: summary, data: JSON.stringify({ before, after, actorId: actor.actorId, impersonated: actor.impersonated }),
      },
    });
    return { dates: lockDatesOut(updated), changed: changed.map((c) => c.field) };
  }, { timeout: 30_000, maxWait: 10_000 });

  res.json({ success: true, data: { ...result.dates, changed: result.changed } });
}));

export default router;
