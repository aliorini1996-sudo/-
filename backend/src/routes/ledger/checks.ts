import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, ledgerActor, type GlActor } from '../../services/gl/audit';
import { todayLocal } from '../../services/gl/dates';
import { toMilli } from '../../services/gl/money';
import { acquirePostLock, postMove } from '../../services/gl/post';
import { loadBuildContext } from '../../services/gl/resolve';
import { LedgerError, type Milli } from '../../services/gl/types';
import {
  CONTROL_KIND_OF_CHECK, ControlAdjustmentError, buildControlAdjustmentDraft,
} from '../../services/gl/checks/controlAdjustment';
import { rebuildPeriodBalances } from '../../services/gl/checks/rebuild';
import { c3Gaps, c4Gaps, c5Gap } from '../../services/gl/checks/rules';
import {
  loadC3Input, loadC5Input, loadPendingPartners, loadRepCustodyFacts, runChecks, type CheckStore,
} from '../../services/gl/checks/run';
import { createPrismaCheckStore } from '../../services/gl/checks/store.prisma';
import {
  CHECK_KEYS, isCheckKey, isControlAdjustableCheck, type CheckKey, type ControlAdjustableCheck,
} from '../../services/gl/checks/types';
import { LEDGER_CHECKS_CACHE, newlyRedNotifiable, recordChecksReport } from '../../services/gl/checks/notify';

/**
 * فحوصات السلامة (M3، DESIGN.md §5.9 REV‑03، ملحق أ، §9.3).
 *
 * - `GET /checks` (canViewLedger): آخر تقرير للشركة (في ذاكرة العملية) أو null.
 * - `POST /checks/run` (canConfigureLedger): يشغّل الفحوص (أو `{only:[…]}`)، بحد مرة كل 60 ثانية لكل شركة، ويُشعر الأدمن
 *   الرئيسي حين يصير C8 أو C15 أحمر (§9.3).
 * - `POST /checks/rebuild-balances` (canConfigureLedger): معاملة تحت قفل gl-post تعيد بناء gl_period_balances من البنود (C2).
 * - `POST /checks/:key/control-adjustment` (canConfigureLedger، سبب إلزامي): **المسار الوحيد** الذي يُنشئ
 *   moveType === 'CONTROL_ADJUSTMENT'، لفحص أحمر من C3 إلى C5 وحده (C6 من M9)؛ الانحراف يُعاد حسابه تحت قفل gl-post
 *   والمبلغ لا يتجاوزه؛ سطران: الحساب الرئيسي المنحرف (وشريكه) مقابل 911001؛ تدقيق MOVE_CONTROL_ADJUST وإشعار.
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');
const CONFIGURE = requireLedgerPermission('canConfigureLedger');

const locals = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(locals(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });

/** آخر تقرير لكل شركة: في services/gl/checks/notify.ts (مشترك مع الفحوص الليلية في المجدول) */
export { LEDGER_CHECKS_CACHE, newlyRedNotifiable };
export const CHECKS_RUN_MIN_INTERVAL_MS = 60_000;
/** آخر بدء تشغيل لكل شركة — كامل أو بـ`only` — فلا يتجاوز الفحص المفرد حد مرة كل 60 ثانية */
export const LEDGER_CHECKS_LAST_RUN = new Map<string, number>();

/** حد التشغيل (صرف): null ⇒ مسموح، وإلا ثوانٍ متبقية */
export function checksRunThrottle(lastRunAt: number | undefined, now: number, minIntervalMs = CHECKS_RUN_MIN_INTERVAL_MS): number | null {
  if (lastRunAt === undefined || now - lastRunAt >= minIntervalMs) return null;
  return Math.max(1, Math.ceil((minIntervalMs - (now - lastRunAt)) / 1000));
}

/** `only` بعد الترشيح؛ إن غطّى كل مفاتيح CHECK_KEYS عومل تشغيلاً كاملاً (فيُحدَّث الكاش والإشعار) */
export function normalizeOnly(only: readonly string[] | undefined): CheckKey[] | undefined {
  const keys = [...new Set((only ?? []).filter(isCheckKey))];
  if (keys.length === 0 || CHECK_KEYS.every((k) => keys.includes(k))) return undefined;
  return keys;
}
const CHECK_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

async function assertActivated(tenantId: string): Promise<void> {
  const s = await prisma.glSettings.findUnique({ where: { tenantId }, select: { activatedAt: true } });
  if (!s?.activatedAt) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'NOT_ACTIVATED' });
}

router.get('/checks', VIEW, ledgerHandler(async (_req, res) => {
  const { tenantId } = locals(res);
  const cached = LEDGER_CHECKS_CACHE.get(tenantId) ?? null;
  res.json({ success: true, data: { report: cached?.report ?? null, keys: CHECK_KEYS } });
}));

const runSchema = z.object({ only: z.array(z.string()).max(CHECK_KEYS.length).optional() }).strict();

router.post('/checks/run', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const body = runSchema.parse(req.body ?? {});
  const only = normalizeOnly(body.only);
  await assertActivated(tenantId);
  const cached = LEDGER_CHECKS_CACHE.get(tenantId) ?? null;
  // الحد لكل تشغيل (كامل أو مفرد): C3/C4 يقرآن كل الصفوف فلا يُكرَّران بلا حد
  const retryAfterSeconds = checksRunThrottle(LEDGER_CHECKS_LAST_RUN.get(tenantId), Date.now());
  if (retryAfterSeconds !== null) {
    res.json({ success: true, data: { report: cached?.report ?? null, throttled: true, retryAfterSeconds } });
    return;
  }
  LEDGER_CHECKS_LAST_RUN.set(tenantId, Date.now());
  const report = await runChecks(createPrismaCheckStore(prisma), tenantId, only ? { only } : {});
  if (!only) await recordChecksReport(prisma, tenantId, report);
  res.json({ success: true, data: { report, throttled: false } });
}));

router.post('/checks/rebuild-balances', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  await assertActivated(tenantId);
  const actor = actorOf(req, res);
  const result = await prisma.$transaction(async (tx) => {
    const r = await rebuildPeriodBalances(tx, tenantId);
    // لا إجراء مخصص لإعادة البناء في §9.3 — يُدوَّن تغيير إعدادات على الأرصدة الشهرية
    await appendAudit(tx, {
      tenantId, actor, action: 'SETTINGS_CHANGE', entityType: 'PERIOD_BALANCES', entityId: null,
      summary: `إعادة بناء الأرصدة الشهرية (${r.inserted} رصيد، ${r.mismatchesBefore} غير متطابق قبلها)`,
      before: { rows: r.deleted, mismatches: r.mismatchesBefore }, after: { rows: r.inserted },
    });
    return r;
  }, CHECK_TX_OPTIONS);
  LEDGER_CHECKS_CACHE.delete(tenantId);
  LEDGER_CHECKS_LAST_RUN.delete(tenantId); // إعادة الفحص فوراً بعد الإصلاح
  res.json({ success: true, data: result });
}));

// ═══ قيد تصحيح حساب رئيسي (CONTROL_ADJUSTMENT) ═══

const amountValue = z.union([z.number(), z.string().trim().min(1)]);
const adjustSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  customerId: z.string().trim().min(1).max(100).optional(),
  salesRepId: z.string().trim().min(1).max(100).optional(),
  amount: amountValue.optional(),
}).strict();

export interface ControlDeviation {
  gapMilli: Milli;
  pending: boolean;
  partnerName: string | null;
}

/** الانحراف الحالي لفحص وشريكه (تحت قفل المُستدعي) — gap = 0 ⇒ لا انحراف */
export async function currentControlDeviation(
  store: CheckStore, tenantId: string, key: ControlAdjustableCheck, partner: { customerId?: string; salesRepId?: string },
): Promise<ControlDeviation> {
  const s = await store.loadSettings(tenantId);
  if (!s?.activatedAt) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'NOT_ACTIVATED' });
  const pending = await loadPendingPartners(store, tenantId, s);
  const accounts = await store.controlAccounts(tenantId);
  if (key === 'C3') {
    if (!partner.customerId) throw new ControlAdjustmentError('PARTNER_REQUIRED', 422, { field: 'customerId' });
    const g = c3Gaps(await loadC3Input(store, tenantId, s, pending, accounts)).find((x) => x.partnerId === partner.customerId);
    const names = g ? null : await store.customerNames(tenantId, [partner.customerId]);
    return { gapMilli: g?.gapMilli ?? 0n, pending: g?.pending ?? false, partnerName: g?.name ?? names?.get(partner.customerId) ?? null };
  }
  if (key === 'C4') {
    if (!partner.salesRepId) throw new ControlAdjustmentError('PARTNER_REQUIRED', 422, { field: 'salesRepId' });
    const reps = await loadRepCustodyFacts(store, tenantId, s, pending, accounts, partner.salesRepId);
    const g = c4Gaps(reps)[0];
    return { gapMilli: g?.gapMilli ?? 0n, pending: g?.pending ?? false, partnerName: reps[0]?.name ?? null };
  }
  const c5 = await loadC5Input(store, tenantId, s, pending, accounts);
  return { gapMilli: c5Gap(c5), pending: c5.pending, partnerName: null };
}

function adjustmentHttpError(e: ControlAdjustmentError): LedgerHttpError {
  const messages: Record<string, string> = {
    REASON_REQUIRED: 'سبب قيد التصحيح مطلوب',
    PARTNER_REQUIRED: 'حدد الشريك المنحرف',
    NO_DEVIATION: 'لا انحراف قائم لهذا الفحص',
    CHECK_NOT_RED: 'الانحراف مؤقت بانتظار الترحيل الآلي — زامن ثم أعد الفحص',
    AMOUNT_INVALID: 'مبلغ غير صالح',
    AMOUNT_EXCEEDS_DEVIATION: 'المبلغ يتجاوز الانحراف المحسوب',
    ACCOUNT_NOT_MAPPED: 'الحساب الرئيسي أو حساب المعلّق غير مربوط',
  };
  return new LedgerHttpError(e.status, messages[e.reason] ?? e.reason, { reason: e.reason, ...e.details });
}

router.post('/checks/:key/control-adjustment', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const key = String(req.params.key);
  if (!isControlAdjustableCheck(key)) {
    throw new LedgerHttpError(422, 'قيد التصحيح متاح لفحوص ذمم العملاء والعهدة والأمانات وحدها', { reason: 'CHECK_NOT_ADJUSTABLE', key });
  }
  const body = adjustSchema.parse(req.body ?? {});
  await assertActivated(tenantId);
  const actor = actorOf(req, res);
  try {
    const posted = await prisma.$transaction(async (tx) => {
      await acquirePostLock(tx, tenantId);
      const store = createPrismaCheckStore(tx);
      const partner = key === 'C3' ? { customerId: body.customerId } : key === 'C4' ? { salesRepId: body.salesRepId } : {};
      const dev = await currentControlDeviation(store, tenantId, key, partner);
      if (dev.gapMilli === 0n) throw new ControlAdjustmentError('NO_DEVIATION', 409);
      if (dev.pending) throw new ControlAdjustmentError('CHECK_NOT_RED', 409, { gapMilli: dev.gapMilli.toString() });

      const context = await loadBuildContext(tx, tenantId);
      const settings = context.ctx.settings;
      const accounts = await store.controlAccounts(tenantId);
      const mapped = context.ctx.accounts.byKey(key === 'C3' ? 'AR_CONTROL' : key === 'C4' ? 'REP_CUSTODY' : 'PAYLINK_CLEARING');
      const controlAccountId = mapped?.controlKind === CONTROL_KIND_OF_CHECK[key]
        ? mapped.id
        : accounts.find((a) => a.controlKind === CONTROL_KIND_OF_CHECK[key])?.id ?? null;
      const now = await store.dbNow();
      const draft = buildControlAdjustmentDraft({
        key, gapMilli: dev.gapMilli,
        amountMilli: body.amount === undefined ? null : toMilli(body.amount, settings.currencyDecimals),
        customerId: body.customerId ?? null, salesRepId: body.salesRepId ?? null, partnerName: dev.partnerName,
        reason: body.reason, date: todayLocal(now, settings.timezone), controlAccountId,
      }, context.ctx);
      const move = await postMove(tx, draft, {
        tenantId, actor, context, validationMode: 'MANUAL', lockPolicy: 'REJECT',
        auditAction: 'MOVE_CONTROL_ADJUST',
        auditSummary: `قيد تصحيح حساب رئيسي (${key}): ${body.reason}`,
        auditExtra: {
          checkKey: key, gapMilli: dev.gapMilli.toString(), customerId: body.customerId ?? null, salesRepId: body.salesRepId ?? null,
          reason: body.reason,
        },
        now,
      });
      // §5.9: إشعار للأدمن الرئيسي
      await tx.notification.create({
        data: {
          tenantId, type: 'LEDGER_CONTROL_ADJUSTMENT', title: 'قيد تصحيح حساب رئيسي',
          body: `${move.number} (${key}): ${body.reason}`,
          customerId: key === 'C3' ? body.customerId ?? null : null,
          salesRepId: key === 'C4' ? body.salesRepId ?? null : null,
          data: JSON.stringify({ moveId: move.id, number: move.number, checkKey: key, gapMilli: dev.gapMilli.toString(), actorId: actor.actorId, impersonated: actor.impersonated }),
        },
      });
      return { move, gapMilli: dev.gapMilli };
    }, CHECK_TX_OPTIONS);
    LEDGER_CHECKS_CACHE.delete(tenantId);
    LEDGER_CHECKS_LAST_RUN.delete(tenantId); // إعادة الفحص فوراً بعد الإصلاح
    res.status(201).json({
      success: true,
      data: { id: posted.move.id, number: posted.move.number, date: posted.move.date, totalMilli: posted.move.totalMilli.toString(), gapMilli: posted.gapMilli.toString() },
    });
  } catch (e) {
    if (e instanceof ControlAdjustmentError) throw adjustmentHttpError(e);
    throw e;
  }
}));

export default router;
