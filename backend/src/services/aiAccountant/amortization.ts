/**
 * «المحاسب الذكي AI» — الإطفاء الشهري للمدفوع مقدماً (طلب المالك ١٨ نوفمبر ٢٠٢٦، القرار D2).
 *
 * قيد الدفع المقدّم (PREPAID، من مستند) يحمل جدوله في AiAccountantPost.meta (posting.ts PrepaidSchedule). كل يوم:
 *   - لكل صفّ PREPAID في شركةٍ مؤهلة بحالة دفاترها وحدها (النظام المتكامل مفعّل والمحاسبة غير مطفأة والدفاتر مفعّلة) — لا
 *     بعَلَم «المحاسب الذكي»: قيد الدفع صار في الدفاتر، فإطفاء عَلَم الميزة لاحقاً لا يترك 115001/115002 متضخّماً والمصروف
 *     ناقصاً كل شهر بلا أي تنبيه (قائمة القيود تختفي مع الميزة)،
 *     ولكل شهر k (1..months) انقضى آخر يومٍ فيه بتوقيت الشركة (اليوم المحلي بعده) ولم يُرحَّل قسطه بعد، يُرحَّل قيد:
 *     مدين المصروف / دائن المدفوع مقدماً بقسطه (round(الأساس ÷ الأشهر) نصف-لأعلى، والأخير يأخذ الباقي) بتاريخ آخر الشهر
 *     (ولا يسبق تاريخ قيد الدفع)، بالمرجع AI-AMORT-<parentPostId>-<k> — فريدٌ للشركة في ai_accountant_posts فلا يتكرّر
 *     القسط مهما أُعيد التشغيل (مرجعٌ موجود ⇒ يُتخطّى، وسباقٌ نادر يُسقطه القيد الفريد بمعاملته كلها).
 *   - قيد الدفع معكوس (أو لم يعد مرحّلاً) ⇒ يتوقف الإطفاء له؛ الأقساط المرحّلة قبله تبقى، وقائمة القيود تنبّه إليها.
 *   - فترة مقفلة ⇒ يُتخطّى ذلك الشهر (لا يُرحَّل إلى غيره) ويُسجَّل تنبيهٌ في meta.lockedSkip ويُعاد في التشغيل التالي.
 *   - لا مسودات أبداً (حذف المسودة يحذف مرفقاتها، والعكس لا يلغي مسودات مستقبلية): ترحيلٌ مباشر بالمنفّذ SYSTEM
 *     «المحاسب الذكي (إطفاء مجدول)»، قيدٌ يدوي بلا sourceType يعكسه المستخدم من الدفاتر كأي قيد للمحاسب الذكي.
 *   - مفتاح AI_ACCOUNTANT_WRITE=0 (مفتاح المنصة) يوقف التشغيل كله (يُستكمل ما فات في أول تشغيل بعد رفعه).
 * كل شهر في معاملته وتحت قفل الترحيل؛ فشلُ شركةٍ أو شهرٍ لا يوقف غيره. القاعدة والترحيل يُحقنان (مخزن مزيّف في الاختبار).
 * والمُجدول نفسه (startAiAccountantScheduler) يكنس معه مستندات المحادثة غير المرحّلة القديمة (documents/gc.ts).
 */
import type { Prisma } from '@prisma/client';
import { SYSTEM_ACTOR, type GlActor } from '../gl/audit';
import { POST_TX_OPTIONS } from '../gl/autoPost';
import { DEFAULT_TIMEZONE, compareLocalDate, isValidTimeZone, todayLocal } from '../gl/dates';
import type { GlDb } from '../gl/resolve';
import { isLedgerError } from '../gl/types';
import { bookMode } from '../booksMode';
import { aiWriteEnabled } from './context';
import {
  AI_POST_ROW_SELECT, AiPostRefusal, DEFAULT_AI_POST_DEPS, amortizationDate, amortizationMonthEnd, buildAmortizationPlan,
  scheduleOf, type AiPostDeps, type BooksModeLike, type PrepaidSchedule,
} from './posting';

/** منفّذ الإطفاء في سجلّ الدفاتر وصفّ القيد */
export const AMORT_ACTOR_NAME = 'المحاسب الذكي (إطفاء مجدول)';
export const AMORT_ACTOR: Readonly<GlActor> = { ...SYSTEM_ACTOR, actorName: AMORT_ACTOR_NAME };
/** صاحب صفّ القسط: النظام لا مستخدم */
export const AMORT_ADMIN_ID = 'SYSTEM';
/** إجراء التدقيق — البادئة EXPENSE_ مفتوحة (audit.ts) */
export const AMORT_AUDIT_ACTION = 'EXPENSE_AI_AMORTIZATION';
/** صفحة صفوف PREPAID في الدورة */
export const AMORT_PAGE = 200;
/** التشغيل اليومي (وأوّله بعد ثلاث دقائق من الإقلاع) */
export const AMORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AMORT_FIRST_RUN_MS = 3 * 60 * 1000;

/** مرجع قسط الشهر k — فريدٌ للشركة (ai_accountant_posts @@unique([tenantId, ref])) */
export const amortRefOf = (parentPostId: string, k: number): string => `AI-AMORT-${parentPostId}-${k}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Q = (args: any) => Promise<any>;

/** أدنى شكل للقاعدة: PrismaClient والمزيّف */
export interface AmortDb {
  aiAccountantPost: { findMany: Q; updateMany: Q };
  glSettings: { findMany: Q };
  $transaction<T>(fn: (tx: GlDb) => Promise<T>, opts?: { maxWait?: number; timeout?: number }): Promise<T>;
}

export interface AmortParent {
  id: string;
  tenantId: string;
  moveId: string;
  moveNumber: string | null;
  dateLocal: string;
  meta: unknown;
}

export interface AmortTenantRow {
  tenantId: string;
  activatedAt: Date | null;
  timezone: string | null;
  setupMethod?: string | null;
  tenant?: { accountingSuiteEnabled?: boolean | null; accountingEnabled?: boolean | null; aiAccountantEnabled?: boolean | null } | null;
}

export interface AmortResult {
  posted: { tenantId: string; parentPostId: string; k: number; moveId: string; number: string }[];
  /** فترة مقفلة: الشهر تُخطّي وسُجّل تنبيهه */
  locked: { tenantId: string; parentPostId: string; k: number; date: string }[];
  /** قيد الدفع معكوس أو غير مرحّل ⇒ توقف إطفاؤه */
  stopped: { tenantId: string; parentPostId: string }[];
  failed: { tenantId: string; parentPostId: string; k: number; code: string }[];
  skippedTenants: number;
  /** AI_ACCOUNTANT_WRITE=0 ⇒ لا شيء */
  disabled?: boolean;
}

export interface AmortOpts {
  env?: NodeJS.ProcessEnv;
  post?: AiPostDeps;
  page?: number;
  log?: (line: string) => void;
}

/** الأشهر المستحقة الآن التي لم تُرحَّل: k انقضى آخر يومٍ فيه (اليوم المحلي بعده) ومرجعه غير موجود */
export function dueMonths(schedule: Pick<PrepaidSchedule, 'months' | 'startYm'>, today: string, postedKs: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let k = 1; k <= schedule.months; k++) {
    if (compareLocalDate(today, amortizationMonthEnd(schedule.startYm, k)) <= 0) break;
    if (!postedKs.has(k)) out.push(k);
  }
  return out;
}

/**
 * شركةٌ مؤهلة للإطفاء بحالة دفاترها وحدها: الدفاتر مفعّلة والنظام المتكامل والمحاسبة غير مطفأين. عَلَم المحاسب الذكي لا
 * يُشترط: الإطفاء يُكمل قيد دفعٍ مرحّلاً في الدفاتر أصلاً (مفتاح المنصة AI_ACCOUNTANT_WRITE وحده يوقفه).
 */
export function amortEligible(s: AmortTenantRow | undefined): boolean {
  return !!s?.activatedAt && s.tenant?.accountingSuiteEnabled === true && s.tenant?.accountingEnabled !== false;
}

type StepOutcome = 'POSTED' | 'EXISTS' | 'PARENT_DEAD';

/**
 * قسط شهرٍ واحد في معاملته: القفل ⇒ المرجع موجود؟ ⇒ قيد الدفع حيّ؟ ⇒ السياق ⇒ الخطة ⇒ postMove ⇒ صفّ PREPAID_AMORT
 * (وتُمحى ملاحظة الفترة المقفلة إن كانت لهذا الشهر). الفترة المقفلة ترمي LEDGER_PERIOD_LOCKED فتسقط المعاملة.
 */
async function postMonth(
  tx: GlDb, deps: AiPostDeps, parent: AmortParent, schedule: PrepaidSchedule, k: number, booksMode: BooksModeLike, now: Date,
): Promise<{ outcome: StepOutcome; moveId?: string; number?: string }> {
  const { tenantId } = parent;
  const ref = amortRefOf(parent.id, k);
  await deps.acquirePostLock(tx, tenantId);
  const existing = await tx.aiAccountantPost.findFirst({ where: { tenantId, ref }, select: { id: true } });
  if (existing) return { outcome: 'EXISTS' };
  // قيد الدفع حيّ: مرحّل بلا قيد عاكس — وإلا يتوقف الإطفاء (الأقساط المرحّلة باقية)
  const parentMove = await tx.glMove.findFirst({ where: { tenantId, id: parent.moveId, state: 'POSTED' }, select: { id: true } });
  const reversal = parentMove ? await tx.glMove.findFirst({ where: { tenantId, reversedMoveId: parent.moveId }, select: { id: true } }) : null;
  if (!parentMove || reversal) return { outcome: 'PARENT_DEAD' };
  const lc = await deps.loadBuildContext(tx, tenantId);
  if (!lc.settings) throw new AiPostRefusal({ code: 'NOT_ACTIVATED', message: 'الدفاتر غير مفعّلة لهذه الشركة بعد.' });
  const date = amortizationDate(schedule, k, parent.dateLocal);
  const out = buildAmortizationPlan({ lc, booksMode, currency: lc.ctx.settings.currency, taxDisabled: false }, { parentPostId: parent.id, schedule, k, date });
  if (!out.ok) throw new AiPostRefusal(out.refusal);
  const plan = out.plan;
  const posted = await deps.postMove(tx, { ...plan.draft, ref }, {
    tenantId,
    actor: AMORT_ACTOR,
    context: lc,
    validationMode: 'MANUAL',
    lockPolicy: 'REJECT',
    auditAction: AMORT_AUDIT_ACTION,
    auditSummary: `المحاسب الذكي: ${plan.summaryAr}`.slice(0, 500),
    auditExtra: { aiAccountant: true, amortization: true, parentPostId: parent.id, k, ref },
    now,
  });
  await tx.aiAccountantPost.create({
    data: {
      tenantId,
      adminId: AMORT_ADMIN_ID,
      adminName: AMORT_ACTOR_NAME,
      moveId: posted.id,
      moveNumber: posted.number,
      ref,
      kind: 'PREPAID_AMORT',
      amountMilli: plan.totalMilli,
      dateLocal: posted.date,
      summaryAr: plan.summaryAr,
      parentPostId: parent.id,
    },
    select: AI_POST_ROW_SELECT,
  });
  if (schedule.lockedSkip?.k === k) {
    await tx.aiAccountantPost.updateMany({
      where: { id: parent.id, tenantId },
      data: { meta: { ...schedule, lockedSkip: null } as unknown as Prisma.InputJsonValue },
    });
    schedule.lockedSkip = null;
  }
  return { outcome: 'POSTED', moveId: posted.id, number: posted.number };
}

/**
 * تشغيلٌ واحد لكل الشركات: صفوف PREPAID (صفحاتٍ بالمعرّف) ⇐ الشركات المؤهلة ⇐ الأشهر المستحقة غير المرحّلة ⇐ قسطٌ
 * لكل شهر في معاملته. now يحدّد اليوم المحلي لكل شركة بتوقيتها.
 */
export async function runAmortization(db: AmortDb, now: Date = new Date(), opts: AmortOpts = {}): Promise<AmortResult> {
  const env = opts.env ?? process.env;
  const deps = opts.post ?? DEFAULT_AI_POST_DEPS;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const result: AmortResult = { posted: [], locked: [], stopped: [], failed: [], skippedTenants: 0 };
  if (!aiWriteEnabled(env)) return { ...result, disabled: true };
  const page = Math.max(1, Math.min(1000, opts.page ?? AMORT_PAGE));
  const settingsCache = new Map<string, AmortTenantRow | undefined>();
  let cursor: string | null = null;
  for (;;) {
    const parents: AmortParent[] = await db.aiAccountantPost.findMany({
      where: { kind: 'PREPAID', ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, tenantId: true, moveId: true, moveNumber: true, dateLocal: true, meta: true },
      orderBy: { id: 'asc' }, take: page,
    });
    if (!parents.length) break;
    cursor = parents[parents.length - 1].id;

    const unknown = [...new Set(parents.map((p) => p.tenantId))].filter((t) => !settingsCache.has(t));
    if (unknown.length) {
      const rows: AmortTenantRow[] = await db.glSettings.findMany({
        where: { tenantId: { in: unknown } },
        select: {
          tenantId: true, activatedAt: true, timezone: true, setupMethod: true,
          tenant: { select: { accountingSuiteEnabled: true, accountingEnabled: true } },
        },
      });
      const byTenant = new Map(rows.map((r) => [r.tenantId, r]));
      for (const t of unknown) {
        const s = byTenant.get(t);
        settingsCache.set(t, s);
        if (!amortEligible(s)) result.skippedTenants++;
      }
    }
    const eligible = parents.filter((p) => amortEligible(settingsCache.get(p.tenantId)));
    if (!eligible.length) {
      if (parents.length < page) break;
      continue;
    }
    // الأقساط المرحّلة لهذه الصفحة دفعةً واحدة (المرجع يحدّد الشهر)
    const children: { tenantId: string; parentPostId: string | null; ref: string }[] = await db.aiAccountantPost.findMany({
      where: { parentPostId: { in: eligible.map((p) => p.id) } }, select: { tenantId: true, parentPostId: true, ref: true },
    });
    for (const parent of eligible) {
      const schedule = scheduleOf(parent.meta);
      if (!schedule) continue;
      const s = settingsCache.get(parent.tenantId)!;
      const tz = s.timezone && isValidTimeZone(s.timezone) ? s.timezone : DEFAULT_TIMEZONE;
      const today = todayLocal(now, tz);
      const postedKs = new Set<number>();
      for (const c of children) {
        if (c.parentPostId !== parent.id || c.tenantId !== parent.tenantId) continue;
        const m = /-(\d+)$/.exec(c.ref);
        if (m) postedKs.add(Number(m[1]));
      }
      const booksMode: BooksModeLike = bookMode(s);
      for (const k of dueMonths(schedule, today, postedKs)) {
        try {
          const r = await db.$transaction((tx) => postMonth(tx, deps, parent, schedule, k, booksMode, now), POST_TX_OPTIONS);
          if (r.outcome === 'PARENT_DEAD') { result.stopped.push({ tenantId: parent.tenantId, parentPostId: parent.id }); break; }
          if (r.outcome === 'POSTED') {
            result.posted.push({ tenantId: parent.tenantId, parentPostId: parent.id, k, moveId: r.moveId!, number: r.number! });
          }
        } catch (e) {
          if (isLedgerError(e) && e.code === 'LEDGER_PERIOD_LOCKED') {
            const date = amortizationDate(schedule, k, parent.dateLocal);
            result.locked.push({ tenantId: parent.tenantId, parentPostId: parent.id, k, date });
            // تنبيهٌ في جدول القيد: يظهر في قائمة القيود حتى يُرحَّل ذلك الشهر (يُعاد في كل تشغيل)
            if (schedule.lockedSkip?.k !== k || schedule.lockedSkip?.date !== date) {
              const meta = { ...schedule, lockedSkip: schedule.lockedSkip && schedule.lockedSkip.k < k ? schedule.lockedSkip : { k, date, at: now.toISOString() } };
              await db.aiAccountantPost.updateMany({ where: { id: parent.id, tenantId: parent.tenantId }, data: { meta } }).catch(() => undefined);
              schedule.lockedSkip = meta.lockedSkip;
            }
            continue;
          }
          const code = e instanceof AiPostRefusal ? e.refusal.code : isLedgerError(e) ? e.code : (e as Error)?.name ?? 'ERROR';
          result.failed.push({ tenantId: parent.tenantId, parentPostId: parent.id, k, code: String(code) });
          log(`[ai-accountant] تعذّر قسط إطفاء ${JSON.stringify({ tenant: parent.tenantId, parent: parent.id, k, code })}`);
          break;
        }
      }
    }
    if (parents.length < page) break;
  }
  return result;
}

let started = false;

/**
 * يُسجَّل من startOpsScheduler (services/opsSchedule.ts): الإطفاء الشهري ثم كنس مستندات المحادثة غير المرحّلة القديمة —
 * أول تشغيل بعد ثلاث دقائق من الإقلاع ثم يومياً. الأخطاء تُسجَّل ولا تُسقط العملية.
 */
export function startAiAccountantScheduler(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      const { default: prisma } = await import('../../config/database');
      const r = await runAmortization(prisma as unknown as AmortDb);
      if (r.posted.length || r.locked.length || r.failed.length) {
        console.log(`📒 ai-accountant amortization: posted ${r.posted.length}, locked ${r.locked.length}, failed ${r.failed.length}, stopped ${r.stopped.length}`);
      }
    } catch (e) {
      console.error('ai-accountant amortization tick error:', (e as Error)?.message);
    }
    try {
      const [{ default: prisma }, { runDocsGc }] = await Promise.all([import('../../config/database'), import('./documents/gc')]);
      const g = await runDocsGc(prisma as unknown as Parameters<typeof runDocsGc>[0]);
      if (g.deleted || g.failed) console.log(`🧹 ai-accountant docs gc: deleted ${g.deleted}, failed ${g.failed}`);
    } catch (e) {
      console.error('ai-accountant docs gc error:', (e as Error)?.message);
    }
  };
  setTimeout(() => { void tick(); }, AMORT_FIRST_RUN_MS);
  setInterval(() => { void tick(); }, AMORT_INTERVAL_MS);
}
