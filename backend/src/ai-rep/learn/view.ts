/**
 * حلقة التعلّم — «ما تعلّمه العقل» لإدارة الشركة: آخر الليالي، والمؤشرات قبل/بعد، ونسخ الترتيب والمعايرة، والدروس
 * بدليلها وأثرها (مع/بدون)، والاعتراضات حسب نوع المحل (الخلايا المكشوفة فقط). للإدارة وحدها — لا يصل للعقل.
 */
import prisma from '../../config/database';
import { llmConfig } from '../llm';
import { outletTypeLabel } from '../taxonomy';
import { OBJECTION_LABEL_AR } from './labels';
import { loadLessonOnOff, statusReasonAr } from './lessons';
import { describePolicy } from './policy';
import { sanePolicy, saneCalibration } from './store';
import { DEFAULT_POLICY, type FieldStats, type ObjectionCode } from './types';

const DAY = 86400000;
const arNum = (x: number, d = 2) => x.toLocaleString('ar-SA', { maximumFractionDigits: d });

function calSummary(params: unknown): string {
  const c = saneCalibration(params);
  if (!c) return 'معايرة الطلب التجريبي';
  const types = Object.entries(c.trial.byType).map(([t, f]) => `${outletTypeLabel(t)} ×${arNum(f)}`);
  return `الطلب التجريبي ×${arNum(c.trial.tenant)}${types.length ? ` (${types.join('، ')})` : ''} — من ${arNum(c.customers, 0)} عميلاً`;
}

export async function learningView(tid: string, s: { learningMode: string; holdoutPct: number }, now = new Date()) {
  const [runs, models, lessons, onOff] = await Promise.all([
    prisma.aiLearningRun.findMany({
      where: { tenantId: tid }, orderBy: { startedAt: 'desc' }, take: 14,
      select: { day: true, status: true, llm: true, tokensIn: true, tokensOut: true, steps: true, metrics: true, field: true, finishedAt: true },
    }),
    prisma.aiLearnedModel.findMany({
      where: { tenantId: tid }, orderBy: [{ kind: 'asc' }, { version: 'desc' }], take: 40,
      select: { kind: true, version: true, status: true, params: true, metrics: true, reason: true, trainedAt: true, promotedAt: true },
    }),
    prisma.aiLesson.findMany({
      where: { tenantId: tid, NOT: { status: 'REJECTED' } }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, kind: true, origin: true, outletType: true, textAr: true, status: true, statusReason: true, evidence: true, history: true, createdAt: true },
    }),
    loadLessonOnOff(tid, new Date(now.getTime() - 30 * DAY)).catch(() => null),
  ]);

  const latest = runs.find(r => r.status === 'DONE' || r.status === 'PARTIAL');
  const byKindVersion = new Map(models.map(m => [`${m.kind}|${m.version}`, m]));
  const perKind: Record<string, number> = {};
  const modelRows = models.filter(m => (perKind[m.kind] = (perKind[m.kind] ?? 0) + 1) <= 10).map(m => {
    let summaryAr = '';
    if (m.kind === 'POLICY') {
      const prevV = Number((m.metrics as { previousVersion?: number } | null)?.previousVersion ?? 0);
      const prev = prevV > 0 ? sanePolicy(byKindVersion.get(`POLICY|${prevV}`)?.params) : null;
      const next = sanePolicy(m.params);
      summaryAr = next ? describePolicy(prev ?? DEFAULT_POLICY, next) : 'سياسة ترتيب';
    } else {
      summaryAr = calSummary(m.params);
    }
    return {
      kind: m.kind, version: m.version, status: m.status, trainedAt: m.trainedAt.toISOString(),
      promotedAt: m.promotedAt?.toISOString() ?? null, reason: m.reason, summaryAr, metrics: m.metrics,
    };
  });

  const field = latest?.field as FieldStats | null | undefined;
  const objections = field?.byType
    ? Object.entries(field.byType)
        .filter(([, c]) => c.exposed && c.objections?.exposed)
        .map(([code, c]) => ({
          typeLabel: outletTypeLabel(code),
          items: Object.entries(c.objections!.shares)
            .filter(([k]) => k !== 'OTHER')
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, 5)
            .map(([k, v]) => ({ label: OBJECTION_LABEL_AR[k as ObjectionCode], share: Math.round((v ?? 0) * 100) / 100 })),
        }))
    : [];

  return {
    mode: s.learningMode,
    holdoutPct: s.holdoutPct,
    llmConfigured: !!llmConfig(),
    lastRun: runs[0] ? { day: runs[0].day, status: runs[0].status, llm: runs[0].llm, finishedAt: runs[0].finishedAt?.toISOString() ?? null } : null,
    runs: runs.map(r => ({
      day: r.day, status: r.status, llm: r.llm, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
      steps: Object.fromEntries(Object.entries((r.steps ?? {}) as Record<string, { ok?: boolean; skipped?: string }>).map(([k, v]) => [k, { ok: !!v?.ok, ...(v?.skipped && { skipped: v.skipped }) }])),
    })),
    metrics: latest?.metrics ?? null,
    models: modelRows,
    lessons: lessons.map(l => {
      const oo = onOff?.byLesson.get(l.id) ?? null;
      return {
        id: l.id, kind: l.kind, origin: l.origin, outletType: l.outletType ? outletTypeLabel(l.outletType) : null, textAr: l.textAr,
        status: l.status, statusReason: l.statusReason, statusReasonAr: l.statusReason ? statusReasonAr(l.statusReason) : null,
        evidence: l.evidence, history: l.history, createdAt: l.createdAt.toISOString(),
        onOff: oo ? {
          on: oo.on.n, off: oo.off.n,
          qOn: oo.on.n ? oo.on.q / oo.on.n : null, qOff: oo.off.n ? oo.off.q / oo.off.n : null,
          up: oo.on.up, down: oo.on.down,
        } : null,
      };
    }),
    objections,
  };
}
