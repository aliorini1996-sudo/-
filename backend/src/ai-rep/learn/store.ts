/**
 * حلقة التعلّم — المخزن: قراءة ما تعلّمته الشركة للاستعمال الحيّ (بذاكرة ١٠ دقائق، **تفشل مفتوحةً** إلى الافتراضي
 * فلا يكسر خللٌ في التعلّم توجيهاً أو محادثة)، وتسجيل دورات المستشار بلا نص، وترقية النسخ والرجوع عنها، وإعادة الضبط،
 * والاحتفاظ. كل استعلام مقيّد بالشركة.
 */
import prisma from '../../config/database';
import {
  DEFAULT_POLICY, EMPTY_LEARNED,
  type AiLessonLite, type CalParams, type FieldStats, type Learned, type LearningMode, type LessonKind, type LessonOrigin, type LessonStatus, type PolicyParams,
} from './types';

const TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const cache = new Map<string, { at: number; ttl: number; value: Learned }>();

export function invalidateLearned(tid: string): void { cache.delete(tid); }
/** للاختبارات. */
export function clearLearnedCache(): void { cache.clear(); }

const num = (x: unknown, lo: number, hi: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null;

/** سياسة محفوظة سليمة الشكل أو null (لا نثق بـJSON من القاعدة دون فحص). */
export function sanePolicy(p: unknown): PolicyParams | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const alpha = num(o.alpha, 0.3, 3);
  const cw = (o.confW ?? {}) as Record<string, unknown>;
  const confW = { HIGH: num(cw.HIGH, 0, 2), MEDIUM: num(cw.MEDIUM, 0, 2), LOW: num(cw.LOW, 0, 2), NONE: num(cw.NONE, 0, 2) };
  if (alpha == null || Object.values(confW).some(v => v == null)) return null;
  const typeMult: Record<string, number> = {};
  for (const [k, v] of Object.entries((o.typeMult ?? {}) as Record<string, unknown>)) { const n = num(v, 0.3, 3); if (n != null) typeMult[k] = n; }
  let closedRisk: Record<string, number[]> | null = null;
  if (o.closedRisk && typeof o.closedRisk === 'object') {
    closedRisk = {};
    for (const [k, v] of Object.entries(o.closedRisk as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length === 5 && v.every(x => num(x, 0, 1) != null)) closedRisk[k] = v as number[];
    }
  }
  return { v: 1, alpha, confW: confW as PolicyParams['confW'], typeMult, closedRisk, useClosed: o.useClosed === true && !!closedRisk };
}

export function saneCalibration(p: unknown): CalParams | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const t = (o.trial ?? {}) as Record<string, unknown>;
  const tenant = num(t.tenant, 0.5, 1.5);
  if (tenant == null) return null;
  const byType: Record<string, number> = {};
  for (const [k, v] of Object.entries((t.byType ?? {}) as Record<string, unknown>)) { const n = num(v, 0.5, 1.5); if (n != null) byType[k] = n; }
  return { v: 1, trial: { tenant, byType }, customers: Number(o.customers) || 0, pairs: Number(o.pairs) || 0 };
}

const lessonN = (evidence: unknown): number => {
  const items = (evidence as { items?: { n?: number }[] } | null)?.items;
  return Array.isArray(items) ? Math.max(0, ...items.map(i => Number(i?.n) || 0)) : 0;
};

/** ما تعلّمته الشركة (بذاكرة ١٠ دقائق). أي خطأ ⇒ الافتراضي (لا يُكسر التوجيه). */
export async function getLearned(tid: string): Promise<Learned> {
  const hit = cache.get(tid);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  try {
    const [row, models, lessons, runs] = await Promise.all([
      prisma.aiRepSettings.findUnique({ where: { tenantId: tid }, select: { learningMode: true } }),
      prisma.aiLearnedModel.findMany({ where: { tenantId: tid, status: 'ACTIVE' }, select: { kind: true, version: true, params: true }, orderBy: { version: 'desc' }, take: 4 }),
      prisma.aiLesson.findMany({
        where: { tenantId: tid, status: { in: ['ACTIVE', 'TRIAL'] } },
        select: { id: true, key: true, kind: true, origin: true, outletType: true, intent: true, textAr: true, status: true, evidence: true },
        orderBy: { updatedAt: 'desc' }, take: 40,
      }),
      prisma.aiLearningRun.findMany({
        where: { tenantId: tid, status: { in: ['DONE', 'PARTIAL'] } },
        select: { field: true }, orderBy: { startedAt: 'desc' }, take: 3,
      }),
    ]);
    const mode: LearningMode = row?.learningMode === 'REVIEW' || row?.learningMode === 'OFF' ? row.learningMode : 'AUTO';
    const pol = models.find(m => m.kind === 'POLICY');
    const cal = models.find(m => m.kind === 'CALIBRATION');
    const polParams = pol ? sanePolicy(pol.params) : null;
    const calParams = cal ? saneCalibration(cal.params) : null;
    const fieldRaw = runs.find(r => r.field != null)?.field as unknown;
    const field = fieldRaw && typeof fieldRaw === 'object' && (fieldRaw as FieldStats).v === 1 ? fieldRaw as FieldStats : null;
    const value: Learned = {
      mode,
      policy: pol && polParams ? { version: pol.version, params: polParams } : null,
      calibration: cal && calParams ? { version: cal.version, params: calParams } : null,
      field,
      lessons: lessons.map(l => ({
        id: l.id, key: l.key, kind: l.kind as LessonKind, origin: l.origin as LessonOrigin, outletType: l.outletType, intent: l.intent,
        textAr: l.textAr, status: l.status as LessonStatus, n: lessonN(l.evidence),
      } satisfies AiLessonLite)),
    };
    cache.set(tid, { at: Date.now(), ttl: TTL_MS, value });
    return value;
  } catch (e) {
    console.warn('[ai-learn] getLearned فشل — الافتراضي:', (e as Error)?.message);
    cache.set(tid, { at: Date.now(), ttl: FAIL_TTL_MS, value: EMPTY_LEARNED });
    return EMPTY_LEARNED;
  }
}

/** سياسة الترتيب للذراع: المتعلَّمة في LEARNED إن وُجدت، وإلا الافتراضية. */
export function policyFor(learned: Learned, arm: 'LEARNED' | 'BASELINE'): { params: PolicyParams; version: number } {
  if (arm === 'LEARNED' && learned.mode !== 'OFF' && learned.policy) return { params: learned.policy.params, version: learned.policy.version };
  return { params: DEFAULT_POLICY, version: 0 };
}

// ───────────── تسجيل الدورات (بلا نص) ─────────────

export interface TurnRecord {
  id: string;
  tenantId: string;
  salesRepId: string;
  /** GUIDE توجيه (المسح بمرشّحيه)، CHAT محادثة، STUDY دراسة محل (بلا مرشّحين) */
  kind: 'GUIDE' | 'CHAT' | 'STUDY';
  source: 'AI' | 'RULES' | 'ERROR';
  intent: string;
  arm: 'LEARNED' | 'BASELINE';
  policyVersion: number;
  guard: string;
  badKinds: string[];
  flags: string[];
  tools: string[];
  hops: number;
  /** فترة اليوم كما خُدمت الدورة (بتوقيت الشركة) */
  hourBand?: number | null;
  lessonIds: string[];
  heldOutIds: string[];
  candidates?: unknown;
  tokensIn: number;
  tokensOut: number;
}

/** سجلّ دورة واحدة — أفضل جهد (خطؤه لا يُسقط الرد). لا يحوي نص السؤال ولا الرد أبداً. */
export async function recordTurn(t: TurnRecord): Promise<void> {
  try {
    await prisma.aiTurn.create({
      data: {
        id: t.id, tenantId: t.tenantId, salesRepId: t.salesRepId, kind: t.kind, source: t.source, intent: t.intent, arm: t.arm,
        policyVersion: t.policyVersion, guard: t.guard, badKinds: t.badKinds, flags: t.flags, tools: [...new Set(t.tools)].slice(0, 12),
        hops: t.hops, hourBand: t.hourBand ?? null, lessonIds: t.lessonIds, heldOutIds: t.heldOutIds,
        ...(t.candidates != null && { candidates: t.candidates as object }),
        tokensIn: t.tokensIn, tokensOut: t.tokensOut,
      },
    });
  } catch (e) {
    console.warn('[ai-learn] recordTurn فشل:', (e as Error)?.message);
  }
}

/**
 * تحديث دورة مسحٍ حين يصل توجيه العقل بعد القائمة (/rep/scan/guide): المصدر والحارس والرموز والدروس، والمرشّحون
 * بموضعهم في خطة العقل (fr) — مقيّد بالشركة والمندوب، أفضل جهد كالتسجيل.
 */
export async function updateTurn(tid: string, repId: string, id: string, patch: Pick<TurnRecord, 'source' | 'guard' | 'badKinds' | 'flags' | 'lessonIds' | 'heldOutIds' | 'tokensIn' | 'tokensOut'> & { candidates?: unknown }): Promise<void> {
  try {
    await prisma.aiTurn.updateMany({
      where: { id, tenantId: tid, salesRepId: repId },
      data: {
        source: patch.source, guard: patch.guard, badKinds: patch.badKinds, flags: patch.flags, lessonIds: patch.lessonIds, heldOutIds: patch.heldOutIds,
        tokensIn: patch.tokensIn, tokensOut: patch.tokensOut, ...(patch.candidates != null && { candidates: patch.candidates as object }),
      },
    });
  } catch (e) {
    console.warn('[ai-learn] updateTurn فشل:', (e as Error)?.message);
  }
}

// ───────────── نسخ المعاملات ─────────────

type ModelKind = 'POLICY' | 'CALIBRATION';

/** حفظ نسخة غير مرقّاة (مرفوضة ببوابتها) — للشفافية. */
export async function storeRejectedModel(tid: string, kind: ModelKind, params: object, metrics: object, reason: string): Promise<number> {
  const max = await prisma.aiLearnedModel.aggregate({ where: { tenantId: tid, kind }, _max: { version: true } });
  const version = (max._max.version ?? 0) + 1;
  await prisma.aiLearnedModel.create({ data: { tenantId: tid, kind, version, status: 'REJECTED', params, metrics, reason } });
  return version;
}

/** ترقية نسخة جديدة فعّالةً، والفعّالة السابقة ← SUPERSEDED. يعيد رقم النسخة. */
export async function promoteModel(tid: string, kind: ModelKind, params: object, metrics: object): Promise<number> {
  return prisma.$transaction(async tx => {
    const max = await tx.aiLearnedModel.aggregate({ where: { tenantId: tid, kind }, _max: { version: true } });
    const prev = await tx.aiLearnedModel.findFirst({ where: { tenantId: tid, kind, status: 'ACTIVE' }, select: { version: true } });
    const version = (max._max.version ?? 0) + 1;
    await tx.aiLearnedModel.updateMany({ where: { tenantId: tid, kind, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
    await tx.aiLearnedModel.create({
      data: { tenantId: tid, kind, version, status: 'ACTIVE', params, metrics: { ...(metrics as object), previousVersion: prev?.version ?? 0 }, promotedAt: new Date() },
    });
    return version;
  });
}

/**
 * الرجوع عن النسخة الفعّالة: إلى نسخة سابقة (SUPERSEDED/ROLLED_BACK) أو إلى الافتراضي (version = 0 ⇒ لا فعّالة).
 * by = معرّف المستخدم أو 'SYSTEM' (رجوع آلي).
 */
export async function rollbackModel(tid: string, kind: ModelKind, toVersion: number, by: string, reason: string): Promise<{ ok: true } | { ok: false; status: 404 }> {
  const now = new Date();
  const res = await prisma.$transaction(async tx => {
    if (toVersion > 0) {
      const target = await tx.aiLearnedModel.findFirst({ where: { tenantId: tid, kind, version: toVersion }, select: { id: true, status: true } });
      if (!target || !['SUPERSEDED', 'ROLLED_BACK'].includes(target.status)) return false;
      await tx.aiLearnedModel.updateMany({ where: { tenantId: tid, kind, status: 'ACTIVE' }, data: { status: 'ROLLED_BACK', reason, changedById: by, changedAt: now } });
      await tx.aiLearnedModel.updateMany({ where: { tenantId: tid, id: target.id }, data: { status: 'ACTIVE', promotedAt: now, changedById: by, changedAt: now } });
      return true;
    }
    await tx.aiLearnedModel.updateMany({ where: { tenantId: tid, kind, status: 'ACTIVE' }, data: { status: 'ROLLED_BACK', reason, changedById: by, changedAt: now } });
    return true;
  });
  invalidateLearned(tid);
  return res ? { ok: true } : { ok: false, status: 404 };
}

const HOLD_DAYS = { SYSTEM: { POLICY: 28, CALIBRATION: 45 }, ADMIN: 60 } as const;

/**
 * مهلة قبل أي ترقية آلية بعد رجوع: الرجوع الآلي ٢٨ يوماً (الترتيب) أو ٤٥ (المعايرة — تنتظر نضج لقطات جديدة)،
 * ورجوع الإدارة ٦٠ يوماً — فلا تُلغي ليلةٌ واحدة قرارَ رجوعٍ بإعادة ترقية النسخة نفسها. إعادة الضبط لا تحجز.
 */
export async function promotionHold(tid: string, kind: ModelKind, now: Date): Promise<{ until: Date; by: 'SYSTEM' | 'ADMIN' } | null> {
  // أطول مهلة سارية من الرجوعات الأخيرة (رجوعٌ آلي لاحق لا يقصّر مهلةَ رجوعِ الإدارة)
  const recent = await prisma.aiLearnedModel.findMany({
    where: { tenantId: tid, kind, status: 'ROLLED_BACK', changedAt: { gte: new Date(now.getTime() - HOLD_DAYS.ADMIN * DAY_MS) } },
    orderBy: { changedAt: 'desc' }, select: { changedAt: true, changedById: true }, take: 10,
  });
  let best: { until: Date; by: 'SYSTEM' | 'ADMIN' } | null = null;
  for (const r of recent) {
    if (!r.changedAt) continue;
    const by = r.changedById === 'SYSTEM' ? 'SYSTEM' : 'ADMIN';
    const days = by === 'SYSTEM' ? HOLD_DAYS.SYSTEM[kind] : HOLD_DAYS.ADMIN;
    const until = new Date(r.changedAt.getTime() + days * DAY_MS);
    if (until > now && (!best || until > best.until)) best = { until, by };
  }
  return best;
}

const DAY_MS = 86400000;

const pushHistory = (history: unknown, entry: object): object[] => {
  const arr = Array.isArray(history) ? history as object[] : [];
  return [...arr, entry].slice(-20);
};

/**
 * «إعادة التعلّم من الصفر»: النسخ الفعّالة ← SUPERSEDED، والدروس الحيّة ← RETIRED. البيانات الخام تبقى.
 * مفتاح الدرس المتقاعد يُحرَّر (لاحقة #reset) فيُعاد تعلّمه من جديد بدليله — لا يُحجب ١٨٠ يوماً — والصفّ يبقى للتدقيق.
 */
export async function resetLearning(tid: string, by: string): Promise<void> {
  const now = new Date();
  await prisma.aiLearnedModel.updateMany({ where: { tenantId: tid, status: 'ACTIVE' }, data: { status: 'SUPERSEDED', reason: 'ADMIN_RESET', changedById: by, changedAt: now } });
  const live = await prisma.aiLesson.findMany({ where: { tenantId: tid, status: { in: ['ACTIVE', 'TRIAL', 'PENDING'] } }, select: { id: true, key: true, status: true, history: true }, take: 500 });
  for (const l of live) {
    await prisma.aiLesson.updateMany({
      where: { tenantId: tid, id: l.id },
      data: {
        key: `${l.key}#reset:${now.getTime()}`,
        status: 'RETIRED', statusReason: 'ADMIN_RESET',
        history: pushHistory(l.history, { at: now.toISOString(), from: l.status, to: 'RETIRED', by, reason: 'ADMIN_RESET' }),
      },
    });
  }
  await prisma.aiRepSettings.upsert({ where: { tenantId: tid }, create: { tenantId: tid, learningResetAt: now, updatedById: by }, update: { learningResetAt: now } });
  invalidateLearned(tid);
}

// ───────────── الاحتفاظ ─────────────

const DAY = 86400000;

async function deleteInBatches(find: () => Promise<{ id: string }[]>, del: (ids: string[]) => Promise<{ count: number }>, maxBatches = 20): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const ids = (await find()).map(r => r.id);
    if (!ids.length) break;
    total += (await del(ids)).count;
    if (ids.length < 2000) break;
  }
  return total;
}

/** حذف القديم: المحادثات والدراسات >٤٥ يوماً، التوجيه >٧٥، سقف ٣٠ ألف دورة؛ الليالي >٤٠٠؛ الدروس المرفوضة/المتقاعدة >١٨٠؛ آخر ١٠ نسخ. */
export async function pruneLearning(tid: string, now: Date): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const turnsBy = (where: object) => deleteInBatches(
    () => prisma.aiTurn.findMany({ where: { tenantId: tid, ...where }, select: { id: true }, take: 2000 }),
    ids => prisma.aiTurn.deleteMany({ where: { tenantId: tid, id: { in: ids } } }),
  );
  out.chat = await turnsBy({ kind: 'CHAT', createdAt: { lt: new Date(now.getTime() - 45 * DAY) } });
  out.guide = await turnsBy({ kind: 'GUIDE', createdAt: { lt: new Date(now.getTime() - 75 * DAY) } });
  out.study = await turnsBy({ kind: 'STUDY', createdAt: { lt: new Date(now.getTime() - 45 * DAY) } });
  const cut = await prisma.aiTurn.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, skip: 30000, take: 1, select: { createdAt: true } });
  out.cap = cut.length ? await turnsBy({ createdAt: { lte: cut[0].createdAt } }) : 0;
  out.runs = (await prisma.aiLearningRun.deleteMany({ where: { tenantId: tid, startedAt: { lt: new Date(now.getTime() - 400 * DAY) } } })).count;
  out.lessons = (await prisma.aiLesson.deleteMany({ where: { tenantId: tid, status: { in: ['REJECTED', 'RETIRED'] }, updatedAt: { lt: new Date(now.getTime() - 180 * DAY) } } })).count;
  out.models = 0;
  for (const kind of ['POLICY', 'CALIBRATION']) {
    const old = await prisma.aiLearnedModel.findMany({ where: { tenantId: tid, kind }, orderBy: { version: 'desc' }, skip: 10, select: { id: true, status: true } });
    const ids = old.filter(m => m.status !== 'ACTIVE').map(m => m.id);
    if (ids.length) out.models += (await prisma.aiLearnedModel.deleteMany({ where: { tenantId: tid, id: { in: ids }, NOT: { status: 'ACTIVE' } } })).count;
  }
  return out;
}
