/**
 * حلقة التعلّم — الليلة (٢–٤ فجراً بتوقيت الرياض): لكل شركة مفعّلة ونشطة، بقفل ليلة واحدة (AiLearningRun):
 *   ١ الاحتفاظ ← ٢ إحصاء الميدان ← ٣ تسميات الخطط ← ٤ سياسة الترتيب (ملاءمة/بوابة/ترقية/رجوع آلي)
 *   ← ٥ معايرة الطلب التجريبي (لقطات التحويل + ترك-واحد-خارجاً/بوابة/رجوع) ← ٦ الدروس (قوالب الإحصاء ومكتبة
 *   التصحيح وأحكام التجربة) ← ٧ المراجعة الذاتية بالعقل (Groq، ملخّص رقمي مجهول الهوية، بميزانية) ← ٨ المؤشرات.
 * كل خطوة مستقلة (خطؤها يُسجَّل ولا يوقف غيرها). الوضع OFF يشغّل ١ و٢ و٣ و٨ فقط (قياس بلا تغيير سلوك).
 * لا تنتقل خبرة شركة إلى أخرى: كل خطوة تأخذ tid وحده، والمراجعة الذاتية ترى ملخّص شركة واحدة.
 */
import prisma from '../../config/database';
import { llmConfig, type LlmConfig } from '../llm';
import { loadEstimateData } from '../estimateData';
import { activeMonths } from '../estimate';
import { settingsView, type AiRepSettingsView } from '../settings';
import { outletTypeLabel } from '../taxonomy';
import { createNightBudget, llmLearningEnabled, type Budget } from './budget';
import { calMetrics, checkCalRollback, evaluateSnapshots, fitCalibration, locoGate, looPairs, loadSnapshotPairs } from './calibration';
import { computeFieldStats, fieldHints, loadFieldRows } from './field';
import { loadLessonOnOff, loadSelfAgg, nightlyLessons } from './lessons';
import {
  armAggregates, buildPlanLabels, checkPolicyRollback, counterfactualLift, fitPolicy, loadPlanEvents, samePolicy, shouldPromote, splitTrainHeldOut,
  type PlanTurn,
} from './policy';
import { buildDigest, loadSelfEval, runReflection } from './reflect';
import { fnv1a32, pGreater, riyadhDay } from './stats';
import { invalidateLearned, promotionHold, promoteModel, pruneLearning, rollbackModel, saneCalibration, sanePolicy } from './store';
import { DEFAULT_POLICY, type CandFeature, type FieldStats, type PolicyParams } from './types';

const DAY = 86400000;
const STEP_BUDGET_MS = 30000;
const LLM_BUDGET_MS = 180000; // نداءان كحدّ أقصى بمهلة ٦٠ ث + إعادة

let nightRunning = false;

/** قفل ليلة الشركة: إنشاء صفّها، أو استعادة ليلة فاشلة/معلّقة (>٩٠ دقيقة) بثلاث محاولات كحدّ أقصى. */
export async function claimRun(tid: string, day: string, now: Date): Promise<{ id: string } | null> {
  try {
    const row = await prisma.aiLearningRun.create({ data: { tenantId: tid, day, status: 'RUNNING', startedAt: now }, select: { id: true } });
    return row;
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
  }
  const r = await prisma.aiLearningRun.updateMany({
    where: {
      tenantId: tid, day, attempts: { lt: 3 },
      OR: [{ status: 'FAILED' }, { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - 90 * 60000) } }],
    },
    data: { status: 'RUNNING', startedAt: now, attempts: { increment: 1 } },
  });
  if (r.count !== 1) return null;
  return prisma.aiLearningRun.findFirst({ where: { tenantId: tid, day }, select: { id: true } });
}

/** كل الشركات المفعّلة النشطة (لها دورة أو زيارة خلال ٣٠ يوماً)، الأقدم تعلّماً أولاً. */
async function tenantsToLearn(now: Date): Promise<string[]> {
  // cross-tenant: tenant-list
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true, aiRepEnabled: true, OR: [{ subscriptionEndsAt: null }, { subscriptionEndsAt: { gte: now } }] },
    select: { id: true },
  });
  const since = new Date(now.getTime() - 30 * DAY);
  const out: { id: string; last: number }[] = [];
  for (const t of tenants) {
    const [turn, ev, last] = await Promise.all([
      prisma.aiTurn.findFirst({ where: { tenantId: t.id, createdAt: { gte: since } }, select: { id: true } }),
      prisma.aiOutletEvent.findFirst({ where: { tenantId: t.id, occurredAt: { gte: since } }, select: { id: true } }),
      prisma.aiLearningRun.findFirst({ where: { tenantId: t.id }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
    ]);
    if (turn || ev) out.push({ id: t.id, last: last?.startedAt.getTime() ?? 0 });
  }
  return out.sort((a, b) => a.last - b.last).map(x => x.id);
}

export async function runAiLearningNight(now = new Date()): Promise<void> {
  if (nightRunning) return;
  nightRunning = true;
  try {
    const day = riyadhDay(now);
    const budget = createNightBudget();
    const llm = llmLearningEnabled() ? llmConfig() : null;
    const learned = new Set<string>();
    for (const tid of await tenantsToLearn(now)) {
      learned.add(tid);
      const run = await claimRun(tid, day, new Date()).catch(e => { console.error('[ai-learn] claim', tid, e); return null; });
      if (!run) continue;
      await runTenantLearning(tid, run, { now: new Date(), budget, llm }).catch(async e => {
        console.error('[ai-learn] ليلة فشلت', tid, e);
        await prisma.aiLearningRun.updateMany({ where: { tenantId: tid, id: run.id }, data: { status: 'FAILED', finishedAt: new Date() } }).catch(() => undefined);
      });
    }
    // مدة الحفظ (٤٥/٧٥ يوماً للدورات) تسري على كل شركة لها سجلات — لا المفعّلة النشطة وحدها
    // cross-tenant: tenant-list
    const withData = await prisma.aiTurn.groupBy({ by: ['tenantId'], where: { createdAt: { lt: new Date(now.getTime() - 45 * DAY) } }, _count: { _all: true } });
    for (const { tenantId } of withData) {
      if (learned.has(tenantId)) continue;
      await pruneLearning(tenantId, now).catch(e => console.error('[ai-learn] prune', tenantId, e));
    }
  } finally {
    nightRunning = false;
  }
}

type StepResult = { ok: boolean; ms: number; n?: number; skipped?: string; error?: string };

export async function runTenantLearning(tid: string, run: { id: string }, deps: { now: Date; budget: Budget; llm: LlmConfig | null }): Promise<void> {
  const { now } = deps;
  const day = riyadhDay(now);
  const started = Date.now();
  const steps: Record<string, StepResult> = {};
  let failed = false;
  let overrun = false;
  const step = async <T>(name: string, fn: () => Promise<T>, opts: { deterministic?: boolean } = {}): Promise<T | null> => {
    if (overrun) { steps[name] = { ok: false, ms: 0, skipped: 'TIME_BUDGET' }; return null; }
    const t0 = Date.now();
    try {
      const v = await fn();
      steps[name] = { ok: true, ms: Date.now() - t0 };
      return v;
    } catch (e) {
      failed = true;
      steps[name] = { ok: false, ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 200) };
      console.error(`[ai-learn] ${name} فشل`, tid, e);
      return null;
    } finally {
      if (opts.deterministic !== false && Date.now() - started > STEP_BUDGET_MS) overrun = true;
    }
  };
  const skip = (name: string, why: string) => { steps[name] = { ok: true, ms: 0, skipped: why }; };

  const row = await prisma.aiRepSettings.findUnique({ where: { tenantId: tid } });
  const s: AiRepSettingsView = settingsView(row as Partial<AiRepSettingsView> | null);
  const off = s.learningMode === 'OFF';
  const resetAt = (row as { learningResetAt?: Date | null } | null)?.learningResetAt ?? null;
  const data = await loadEstimateData(tid, { windowMonths: s.estimateWindowMonths, priorityProductIds: s.priorityProductIds });

  // ١ الاحتفاظ
  await step('prune', () => pruneLearning(tid, now));

  // ٢ ما واجهه الميدان (٩٠ يوماً)
  const field: FieldStats | null = await step('field', async () => {
    const { episodes, closedRows } = await loadFieldRows(tid, new Date(now.getTime() - 90 * DAY), data.timezone);
    const activeReps = new Set(closedRows.map(r => r.rep)).size;
    return computeFieldStats(episodes, closedRows, { now, activeReps });
  });
  const activeReps = field?.activeReps ?? 0;

  // ٣ تسميات الخطط: دورات التوجيه (٦٠ يوماً) × زيارات المندوب نفسه خلال ٧٢ ساعة
  const since60 = new Date(Math.max(now.getTime() - 60 * DAY, resetAt?.getTime() ?? 0));
  const planning = await step('labels', async () => {
    // الدورات الأحدث من ٧٢ ساعة لم تكتمل زياراتها بعد — تسميتها الآن تعدّ محطّاتها غير المزورة «متخطّاة» ظلماً.
    // عند بلوغ السقف تُبقى الأحدث (لا الأقدم) ثم تُرتَّب زمنياً.
    const matured = new Date(now.getTime() - 72 * 3600000);
    const rows = await prisma.aiTurn.findMany({
      where: { tenantId: tid, kind: 'GUIDE', createdAt: { gte: since60, lte: matured } },
      select: { id: true, salesRepId: true, createdAt: true, arm: true, policyVersion: true, candidates: true, hourBand: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8000,
    });
    rows.reverse();
    let turns: PlanTurn[] = rows
      .filter(r => Array.isArray(r.candidates))
      .map(r => ({ id: r.id, salesRepId: r.salesRepId, createdAt: r.createdAt, arm: r.arm, policyVersion: r.policyVersion, hb: r.hourBand, candidates: r.candidates as unknown as CandFeature[] }));
    const events = turns.length ? await loadPlanEvents(tid, turns[0].createdAt, new Date(turns[turns.length - 1].createdAt.getTime() + 72 * 3600000)) : [];
    // بلغت الزيارات حدّها: الدورات الأقدم من أقدم زيارة محمّلة نوافذها ناقصة — تُسقط لا تُسمّى خطأً
    if (events.length >= 60000) turns = turns.filter(t => t.createdAt >= events[0].occurredAt);
    const labels = buildPlanLabels(turns, events);
    return { turns, labels, arms: armAggregates(turns, labels), armReps: armRepSpread(turns, labels) };
  });

  // ٤ سياسة الترتيب
  let policyMetrics: Record<string, unknown> | null = null;
  if (off) skip('policy', 'MODE_OFF');
  else if (planning) {
    await step('policy', async () => {
      const active = await prisma.aiLearnedModel.findFirst({ where: { tenantId: tid, kind: 'POLICY', status: 'ACTIVE' }, select: { version: true, params: true, metrics: true, promotedAt: true } });
      const champion: PolicyParams = (active && sanePolicy(active.params)) || DEFAULT_POLICY;
      const seed = fnv1a32(tid + day);
      // رجوع آلي خلال ٢٨ يوماً من الترقية
      if (active?.promotedAt && now.getTime() - active.promotedAt.getTime() <= 28 * DAY) {
        const prevV = Number((active.metrics as { previousVersion?: number } | null)?.previousVersion ?? 0);
        const prevRow = prevV > 0 ? await prisma.aiLearnedModel.findFirst({ where: { tenantId: tid, kind: 'POLICY', version: prevV }, select: { params: true } }) : null;
        const previous = (prevRow && sanePolicy(prevRow.params)) || DEFAULT_POLICY;
        const sincePromotion = planning.turns.filter(t => t.createdAt >= active.promotedAt!);
        const rb = checkPolicyRollback({ sincePromotion, labels: planning.labels, active: champion, previous, arms: armAggregates(sincePromotion, planning.labels) });
        if (rb.rollback) {
          const target = rb.reason === 'AB_WORSE' ? 0 : prevV;
          const r = await rollbackModel(tid, 'POLICY', target, 'SYSTEM', rb.reason);
          // النسخة السابقة حُذفت أو تغيّرت حالتها ⇒ إلى الافتراضي (لا نبلّغ نجاحاً لم يقع)
          if (!r.ok) await rollbackModel(tid, 'POLICY', 0, 'SYSTEM', rb.reason);
          policyMetrics = { rolledBack: rb.reason };
          return;
        }
      }
      const hold = await promotionHold(tid, 'POLICY', now);
      const { train, heldOut } = splitTrainHeldOut(planning.turns);
      if (hold) {
        policyMetrics = { hold: { until: hold.until.toISOString(), by: hold.by } };
      } else {
        // مضاعفات النوع وخطر الإغلاق للمتحدّي من الميدان **قبل** الفترة المحجوبة — وإلا «أكّدت» البوابة ما صُنع من بياناتها
        let fitField = field;
        if (heldOut.length) {
          const pre = await loadFieldRows(tid, new Date(now.getTime() - 90 * DAY), data.timezone, heldOut[0].createdAt);
          fitField = computeFieldStats(pre.episodes, pre.closedRows, { now: heldOut[0].createdAt, activeReps });
        }
        const challenger = fitPolicy(train, planning.labels, champion, fitField);
        if (!samePolicy(challenger, champion)) {
          const gate = shouldPromote(heldOut, planning.labels, champion, challenger, seed, activeReps);
          if (gate.ok) await promoteModel(tid, 'POLICY', challenger, { gate: 'PASS', ...gate });
          policyMetrics = { lastGate: gate };
        }
      }
      const nowActive = await prisma.aiLearnedModel.findFirst({ where: { tenantId: tid, kind: 'POLICY', status: 'ACTIVE' }, select: { version: true, params: true, promotedAt: true } });
      // الأثر المعروض للإدارة على دورات بعد الترقية وحدها (خارج عيّنة الملاءمة)
      const outOfSample = nowActive?.promotedAt ? planning.turns.filter(t => t.createdAt >= nowActive.promotedAt!) : planning.turns;
      const lift = counterfactualLift(outOfSample, planning.labels, (nowActive && sanePolicy(nowActive.params)) || DEFAULT_POLICY, seed);
      policyMetrics = { ...(policyMetrics ?? {}), ...lift, activeVersion: nowActive?.version ?? 0 };
    });
  }

  // ٥ معايرة الطلب التجريبي
  let trialMetrics: Record<string, unknown> | null = null;
  let calCustomers = 0;
  if (off) skip('calibration', 'MODE_OFF');
  else {
    await step('calibration', async () => {
      await evaluateSnapshots(tid, now);
      const snap = await loadSnapshotPairs(tid);
      const loo = looPairs(data, { targetOutletTypes: s.targetOutletTypes, minPeers: s.minPeers, showMoney: s.showMoney }, tid, day, now);
      const pairs = [...snap, ...loo];
      const active = await prisma.aiLearnedModel.findFirst({ where: { tenantId: tid, kind: 'CALIBRATION', status: 'ACTIVE' }, select: { version: true, params: true } });
      const current = active ? saneCalibration(active.params) : null;
      if (active) {
        const rb = checkCalRollback(snap, active.version, s.minPeers);
        if (rb.rollback) { await rollbackModel(tid, 'CALIBRATION', 0, 'SYSTEM', 'AUTO_REGRESSION'); trialMetrics = { rolledBack: true, ...rb }; return; }
      }
      const fit = fitCalibration(pairs, s.minPeers);
      calCustomers = fit.customers;
      let gate: ReturnType<typeof locoGate> | null = null;
      if (fit.active) {
        gate = locoGate(pairs, s.minPeers, current);
        const changed = JSON.stringify(fit.params.trial) !== JSON.stringify(current?.trial ?? null);
        const hold = await promotionHold(tid, 'CALIBRATION', now);
        if (gate.ok && changed && !hold) await promoteModel(tid, 'CALIBRATION', fit.params, { gate: 'PASS', ...gate, customers: fit.customers, pairs: pairs.length });
      }
      trialMetrics = calMetrics(pairs, gate) as unknown as Record<string, unknown>;
    });
  }

  // ٦ الدروس
  if (off) skip('lessons', 'MODE_OFF');
  else {
    await step('lessons', async () => {
      const selfAgg = await loadSelfAgg(tid, new Date(Math.max(now.getTime() - 14 * DAY, resetAt?.getTime() ?? 0)));
      return nightlyLessons(tid, { now, field, selfAgg, typeLabel: outletTypeLabel, mode: s.learningMode, playbook: s.playbook });
    });
  }

  // ٧ المراجعة الذاتية بالعقل
  let llmStatus = 'NOT_RUN';
  let tokens = { in: 0, out: 0 };
  let reflection: { created: number; rejected: Record<string, number>; retired: number } | null = null;
  if (!deps.llm) { llmStatus = 'SKIPPED_NO_KEY'; skip('reflection', llmStatus); }
  else if (off) { llmStatus = 'SKIPPED_MODE'; skip('reflection', llmStatus); }
  else if (await isQuiet(tid, now)) { llmStatus = 'SKIPPED_QUIET'; skip('reflection', llmStatus); }
  else {
    overrun = false; // للمراجعة ميزانيتها الخاصة
    let timedOut = false;
    await step('reflection', async () => {
      const t0 = Date.now();
      const since30 = new Date(now.getTime() - 30 * DAY);
      const [selfEval, lessonRows, onOff] = await Promise.all([
        loadSelfEval(tid, since30),
        prisma.aiLesson.findMany({ where: { tenantId: tid, status: { in: ['ACTIVE', 'TRIAL'] } }, select: { id: true, kind: true, origin: true, outletType: true, textAr: true, status: true }, take: 30 }),
        loadLessonOnOff(tid, since30),
      ]);
      const lessons = lessonRows.map(l => {
        const oo = onOff.byLesson.get(l.id);
        return {
          ...l,
          on: { n: oo?.on.n ?? 0, qRate: oo?.on.n ? oo.on.q / oo.on.n : null },
          off: { n: oo?.off.n ?? 0, qRate: oo?.off.n ? oo.off.q / oo.off.n : null },
          up: oo?.on.up ?? 0, down: oo?.on.down ?? 0,
        };
      });
      const arms = planning?.arms;
      const armCell = (arm: 'LEARNED' | 'BASELINE', a: { planned: number; visited: number; pos: number }) => ({
        n: a.visited, reps: planning?.armReps[arm].reps ?? 0, topRepShare: planning?.armReps[arm].topRepShare ?? 1,
        positiveRate: a.visited ? a.pos / a.visited : 0,
      });
      const bt = (trialMetrics as { buyThrough?: { suggested?: number; taken?: number } } | null)?.buyThrough;
      const activeCal = await prisma.aiLearnedModel.findFirst({ where: { tenantId: tid, kind: 'CALIBRATION', status: 'ACTIVE' }, select: { params: true } });
      const { digest, aliasToId } = buildDigest({
        field, selfEval, lessons,
        cal: trialMetrics ? {
          customers: calCustomers,
          trialFactor: saneCalibration(activeCal?.params)?.trial.tenant ?? null,
          buyThrough: bt?.suggested ? (bt.taken ?? 0) / bt.suggested : null,
        } : null,
        planArms: arms ? { LEARNED: armCell('LEARNED', arms.LEARNED), BASELINE: armCell('BASELINE', arms.BASELINE), adherence: arms.adherence } : null,
        playbook: s.playbook, targetTypes: s.targetOutletTypes, minPeers: s.minPeers,
      });
      const r = await Promise.race([
        runReflection(tid, { cfg: deps.llm!, budget: deps.budget, digest, aliasToId, settings: { learningMode: s.learningMode, targetOutletTypes: s.targetOutletTypes, playbook: s.playbook }, now }),
        new Promise<never>((_, rej) => setTimeout(() => { timedOut = true; rej(new Error('REFLECTION_TIMEOUT')); }, LLM_BUDGET_MS)),
      ]);
      if (timedOut) return r;
      llmStatus = r.status;
      tokens = r.tokens;
      reflection = { created: r.created, rejected: r.rejected, retired: r.retired };
      steps.reflection = { ok: r.status !== 'FAILED', ms: Date.now() - t0, n: r.created };
      return r;
    }, { deterministic: false });
    if (steps.reflection && !steps.reflection.ok && llmStatus === 'NOT_RUN') llmStatus = 'FAILED';
  }

  // ٨ المؤشرات (قبل/بعد) والاقتراحات والخط الأساس
  const metrics = await step('metrics', () => buildMetrics(tid, {
    now, s, resetAt, field, planning, policyMetrics, trialMetrics, calCustomers, data, reflection,
  }), { deterministic: false });

  await prisma.aiLearningRun.updateMany({
    where: { tenantId: tid, id: run.id },
    data: {
      status: failed || overrun ? 'PARTIAL' : 'DONE',
      steps: steps as object, llm: llmStatus, tokensIn: tokens.in, tokensOut: tokens.out,
      ...(field && { field: field as object }), ...(metrics && { metrics: metrics as object }),
      finishedAt: new Date(),
    },
  });
  invalidateLearned(tid);
}

/** انتشار زيارات المحطّات المخطّطة بين المناديب لكل ذراع (عتبة التعرّض في ملخّص المراجعة الذاتية). */
export function armRepSpread(turns: PlanTurn[], labels: Map<string, { p: string; w: number; wasted: boolean }[]>): Record<'LEARNED' | 'BASELINE', { reps: number; topRepShare: number }> {
  const count: Record<'LEARNED' | 'BASELINE', Map<string, number>> = { LEARNED: new Map(), BASELINE: new Map() };
  for (const t of turns) {
    const arm = t.arm === 'BASELINE' ? 'BASELINE' : 'LEARNED';
    const planned = new Set(t.candidates.filter(c => c.fr > 0).map(c => c.p));
    const visited = (labels.get(t.id) ?? []).filter(l => planned.has(l.p) && l.w !== 0.5).length;
    if (visited) count[arm].set(t.salesRepId, (count[arm].get(t.salesRepId) ?? 0) + visited);
  }
  const spread = (m: Map<string, number>) => {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return { reps: m.size, topRepShare: total ? Math.max(...m.values()) / total : 1 };
  };
  return { LEARNED: spread(count.LEARNED), BASELINE: spread(count.BASELINE) };
}

/** المراجعة الذاتية «هادئة» إن لم يجدّ ما يكفي منذ آخر مراجعة (≥٢٠ وحدة، أو ≥٥ مع مرور ٧ أيام). */
async function isQuiet(tid: string, now: Date): Promise<boolean> {
  const last = await prisma.aiLearningRun.findFirst({ where: { tenantId: tid, llm: 'USED' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  const since = last?.startedAt ?? new Date(now.getTime() - 30 * DAY);
  const [turns, events, votes] = await Promise.all([
    prisma.aiTurn.count({ where: { tenantId: tid, source: 'AI', createdAt: { gte: since } } }),
    prisma.aiOutletEvent.count({ where: { tenantId: tid, occurredAt: { gte: since } } }),
    prisma.aiTurn.count({ where: { tenantId: tid, votedAt: { gte: since } } }),
  ]);
  const units = turns + events + votes;
  if (units >= 20) return false;
  if (units >= 5 && (!last || now.getTime() - last.startedAt.getTime() >= 7 * DAY)) return false;
  return true;
}

// ───────────── المؤشرات ─────────────

/** الخط الأساس: أول ٢٨ يوماً من الاستعمال (أو بعد إعادة الضبط) — يُجمَّد مرة ويُقارن به ما بعده. */
interface Baseline {
  frozenAt: string;
  guardBad: number | null; total: number; bad: number;
  upRate: number | null; up: number; down: number;
  trialE0: number | null;
}

async function turnQuality(tid: string, from: Date, to: Date) {
  const rows = await prisma.aiTurn.groupBy({
    by: ['guard'], where: { tenantId: tid, source: 'AI', createdAt: { gte: from, lt: to } }, _count: { _all: true },
  });
  const total = rows.reduce((s2, r) => s2 + r._count._all, 0);
  const bad = rows.filter(r => ['REGEN', 'TRIM', 'TEMPLATE'].includes(r.guard)).reduce((s2, r) => s2 + r._count._all, 0);
  const [flagged, up, down] = await Promise.all([
    prisma.aiTurn.count({ where: { tenantId: tid, source: 'AI', createdAt: { gte: from, lt: to }, NOT: { flags: { isEmpty: true } } } }),
    prisma.aiTurn.count({ where: { tenantId: tid, createdAt: { gte: from, lt: to }, vote: 1 } }),
    prisma.aiTurn.count({ where: { tenantId: tid, createdAt: { gte: from, lt: to }, vote: -1 } }),
  ]);
  return { total, bad, flagged, up, down };
}

async function buildMetrics(tid: string, i: {
  now: Date; s: AiRepSettingsView; resetAt: Date | null; field: FieldStats | null;
  planning: { turns: PlanTurn[]; arms: ReturnType<typeof armAggregates> } | null;
  policyMetrics: Record<string, unknown> | null; trialMetrics: Record<string, unknown> | null; calCustomers: number;
  data: Awaited<ReturnType<typeof loadEstimateData>>;
  reflection: { created: number; rejected: Record<string, number>; retired: number } | null;
}): Promise<Record<string, unknown>> {
  const { now, s } = i;
  const d7 = new Date(now.getTime() - 7 * DAY), d28 = new Date(now.getTime() - 28 * DAY), d30 = new Date(now.getTime() - 30 * DAY);
  const [q7, q28, intents, lessonCounts, retired30, proposals] = await Promise.all([
    turnQuality(tid, d7, now),
    turnQuality(tid, d28, now),
    prisma.aiTurn.groupBy({ by: ['intent'], where: { tenantId: tid, kind: 'CHAT', createdAt: { gte: d30 } }, _count: { _all: true } }),
    prisma.aiLesson.groupBy({ by: ['status'], where: { tenantId: tid }, _count: { _all: true } }),
    prisma.aiLesson.count({ where: { tenantId: tid, status: 'RETIRED', updatedAt: { gte: d30 } } }),
    prisma.aiLearningRun.findMany({ where: { tenantId: tid, startedAt: { gte: d30 } }, select: { metrics: true }, take: 31 }),
  ]);
  const byStatus = (st: string) => lessonCounts.find(r => r.status === st)?._count._all ?? 0;
  const intentCounts = Object.fromEntries(intents.map(r => [r.intent, r._count._all]));
  const chatTotal = intents.reduce((a, r) => a + r._count._all, 0);
  const cutoff = now.getTime() - 60 * DAY;
  const insufficientTypes = s.targetOutletTypes.filter(t =>
    i.data.peers.filter(p => p.outletType === t && p.lastInvoiceAt && p.lastInvoiceAt.getTime() >= cutoff && activeMonths(p.firstYm, i.data.window) >= 3).length < s.minPeers);

  const arms = i.planning?.arms ?? null;
  const pLearnedBetter = arms ? pGreater(arms.LEARNED.pos, arms.LEARNED.visited, arms.BASELINE.pos, arms.BASELINE.visited) : null;

  // الخط الأساس: يُجمَّد مرة واحدة بعد ٢٨ يوماً من أول دورة (أو من إعادة الضبط) ويُنسخ للأمام
  const prevRuns = await prisma.aiLearningRun.findMany({
    where: { tenantId: tid, status: { in: ['DONE', 'PARTIAL'] }, NOT: { day: riyadhDay(now) } }, orderBy: { startedAt: 'desc' }, select: { metrics: true }, take: 60,
  });
  let baseline: Baseline | null = prevRuns.map(r => (r.metrics as { baseline?: Baseline } | null)?.baseline).find(Boolean) ?? null;
  if (baseline && i.resetAt && new Date(baseline.frozenAt) < i.resetAt) baseline = null;
  if (!baseline) {
    const first = await prisma.aiTurn.findFirst({
      where: { tenantId: tid, ...(i.resetAt && { createdAt: { gte: i.resetAt } }) }, orderBy: { createdAt: 'asc' }, select: { createdAt: true },
    });
    const start = i.resetAt && first && first.createdAt < i.resetAt ? i.resetAt : first?.createdAt ?? null;
    if (start && now.getTime() - start.getTime() >= 28 * DAY) {
      const end = new Date(start.getTime() + 28 * DAY);
      const q = await turnQuality(tid, start, end);
      baseline = {
        frozenAt: now.toISOString(),
        guardBad: q.total ? q.bad / q.total : null, total: q.total, bad: q.bad,
        upRate: q.up + q.down ? q.up / (q.up + q.down) : null, up: q.up, down: q.down,
        trialE0: (i.trialMetrics as { E0?: number } | null)?.E0 ?? null,
      };
    }
  }

  // مقترحات المراجعة الذاتية خلال ٣٠ يوماً: نتيجة كل ليلة محفوظة في metrics.reflection (لا تراكم فوق تراكم)
  const rejected: Record<string, number> = {};
  let accepted = 0;
  const nights = [...proposals.map(r => (r.metrics as { reflection?: { created?: number; rejected?: Record<string, number> } } | null)?.reflection), i.reflection];
  for (const p of nights) {
    accepted += p?.created ?? 0;
    for (const [k, v] of Object.entries(p?.rejected ?? {})) rejected[k] = (rejected[k] ?? 0) + v;
  }

  return {
    policy: i.policyMetrics,
    arms: arms ? { LEARNED: arms.LEARNED, BASELINE: arms.BASELINE, pLearnedBetter } : null,
    adherence: arms?.adherence ?? null,
    wastedRate: arms?.wastedRate ?? null,
    trial: i.trialMetrics,
    self: {
      turns7: q7.total, guardBad7: q7.bad, flagsPer100_7: q7.total ? Math.round((q7.flagged / q7.total) * 1000) / 10 : null,
      up28: q28.up, down28: q28.down,
      ...(baseline?.total
        ? { pGuardBetter: pGreater(baseline.bad, baseline.total, q7.bad, q7.total) }
        : {}),
    },
    lessons: { active: byStatus('ACTIVE'), trial: byStatus('TRIAL'), pending: byStatus('PENDING'), retired30, proposals: { accepted, rejected } },
    readiness: {
      pairs: (i.policyMetrics as { pairs?: number } | null)?.pairs ?? 0, pairsNeeded: 40,
      calCustomers: i.calCustomers, calNeeded: Math.max(8, s.minPeers),
      episodes: i.field ? Object.values(i.field.byType).reduce((a, c) => a + c.n, 0) : 0,
    },
    hints: fieldHints({ field: i.field, playbook: s.playbook, intentCounts, chatTotal, insufficientTypes, typeLabel: outletTypeLabel }),
    reflection: i.reflection,
    ...(baseline && { baseline }),
  };
}
