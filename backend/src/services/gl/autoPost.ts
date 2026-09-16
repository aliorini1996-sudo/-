/**
 * ترحيل المسودات: الجماعي من المسار ومجدول autoPostOn (M2، DESIGN.md §6.1، §8.3، §9.3).
 *
 * - **قبل التفعيل** (GlSettings.activatedAt فارغ): المسار يرد 409 LEDGER_NOT_SETUP، و/moves/post-drafts يعيد كل
 *   معرّف في rejected بالرمز نفسه، والمجدول يتخطى الشركة. الفحص هنا وفي المسارات **لا في post.ts** (§6.1):
 *   قيد OPEN يُرحَّل داخل معاملة التفعيل قبل ضبط activatedAt.
 * - كل قيد في معاملة postDraftMove مستقلة (§8.3): رفض قيد لا يُسقط غيره.
 * - الدوال تأخذ db بحقن الاعتماد (prisma في الإنتاج، ومزيّف في الاختبار) ولا تستورد prisma العام إلا
 *   ديناميكياً في startLedgerAutoPostScheduler.
 */
import { appendAudit, SYSTEM_ACTOR, type GlActor, type GlTx } from './audit';
import { addDays, todayLocal, toDbDate, fromDbDate, DEFAULT_TIMEZONE } from './dates';
import { postDraftMove, type PostDraftOptions, type PostedMove } from './post';
import { isGlNotFoundError } from './resolve';
import { isLedgerError } from './types';

/** حد المعرّفات في الإجراءات الجماعية (§8.3). */
export const BULK_MOVE_IDS_LIMIT = 100;

/** مهلة معاملة ترحيل واحدة على قاعدة 0.1 نواة (§3.9). */
export const POST_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

type SettingsRow = { activatedAt: Date | null; timezone?: string | null } | null;

/** الحد الأدنى من العميل الذي تحتاجه الدوال هنا (PrismaClient يستوفيه). */
export interface AutoPostDb {
  glSettings: {
    findUnique(args: { where: { tenantId: string }; select: { activatedAt: true; timezone?: true } }): Promise<SettingsRow>;
  };
  $transaction<T>(fn: (tx: GlTx) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
}

export type PostDraftFn = (tx: GlTx, opts: PostDraftOptions) => Promise<PostedMove>;

/** activatedAt مضبوط ⇒ الترحيل مسموح (§6.1). */
export async function isLedgerActivated(db: Pick<AutoPostDb, 'glSettings'>, tenantId: string): Promise<boolean> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: { activatedAt: true } });
  return !!s?.activatedAt;
}

export interface BulkRejection {
  id: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface PostDraftsResult {
  posted: { id: string; number: string; date: string }[];
  rejected: BulkRejection[];
}

/** خطأ ترحيل ⇐ صف rejected (رموز ملحق ب، وNOT_FOUND للمعرّف الغريب عن الشركة). غير المتوقع يُرمى. */
export function rejectionOf(id: string, e: unknown): BulkRejection {
  if (isLedgerError(e)) return { id, code: e.code, details: { ...e.details } };
  if (isGlNotFoundError(e)) return { id, code: 'NOT_FOUND' };
  const pc = (e as { code?: unknown })?.code;
  if (pc === 'P2002' || pc === 'P2034') return { id, code: 'LEDGER_MOVE_NOT_DRAFT', details: { reason: 'RACE' } };
  throw e;
}

/** يزيل التكرار والفراغ ويحفظ الترتيب. */
export function normalizeIds(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of ids) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * POST /moves/post-drafts: قبل التفعيل كل معرّف في rejected بـLEDGER_NOT_SETUP بلا أي معاملة؛
 * وبعده كل قيد في معاملة postDraftMove مستقلة.
 */
export async function postDraftsBatch(
  db: AutoPostDb,
  opts: { tenantId: string; actor: GlActor; ids: readonly string[]; now?: Date; post?: PostDraftFn },
): Promise<PostDraftsResult> {
  const ids = normalizeIds(opts.ids);
  if (!(await isLedgerActivated(db, opts.tenantId))) {
    return { posted: [], rejected: ids.map((id) => ({ id, code: 'LEDGER_NOT_SETUP', details: { reason: 'NOT_ACTIVATED' } })) };
  }
  const post = opts.post ?? postDraftMove;
  const result: PostDraftsResult = { posted: [], rejected: [] };
  for (const id of ids) {
    try {
      const p = await db.$transaction(
        (tx) => post(tx, { tenantId: opts.tenantId, actor: opts.actor, moveId: id, now: opts.now }),
        POST_TX_OPTIONS,
      );
      result.posted.push({ id, number: p.number, date: p.date });
    } catch (e) {
      result.rejected.push(rejectionOf(id, e));
    }
  }
  return result;
}

// ═══ مجدول autoPostOn ═══

/** دورة المجدول: كل ساعة (autoPostOn تاريخ لا وقت). */
export const AUTO_POST_INTERVAL_MS = 60 * 60 * 1000;
/** سقف المسودات في الدورة الواحدة — ما يتبقى يُرحَّل في الدورة التالية. */
export const AUTO_POST_BATCH = 200;
/** وسم المسودة التي فشل ترحيلها المجدول: تُتخطى حتى يحرّرها المستخدم (الحفظ يعيد needsAttention=false). */
export const AUTO_POST_ATTENTION_PREFIX = 'AUTO_POST_FAILED:';

export interface AutoPostCandidate {
  id: string;
  tenantId: string;
  autoPostOn: Date | null;
}

export interface AutoPostTenantRow {
  tenantId: string;
  activatedAt: Date | null;
  timezone: string | null;
  tenant: { accountingSuiteEnabled: boolean; accountingEnabled: boolean | null } | null;
}

/** شرط أهلية الشركة داخل استعلام المرشحين: الميزة مفعّلة والدفاتر مفعّلة (§6.1، §9.4). */
export interface AutoPostEligibleTenantWhere {
  accountingSuiteEnabled: true;
  accountingEnabled: true;
  glSettings: { is: { activatedAt: { not: null } } };
}

export const AUTO_POST_ELIGIBLE_TENANT: AutoPostEligibleTenantWhere = {
  accountingSuiteEnabled: true,
  accountingEnabled: true,
  glSettings: { is: { activatedAt: { not: null } } },
};

export interface AutoPostTickDb {
  glMove: {
    findMany(args: {
      where: {
        state: 'DRAFT'; number: null; needsAttention: false; autoPostOn: { not: null; lte: Date };
        tenant: AutoPostEligibleTenantWhere;
      };
      select: { id: true; tenantId: true; autoPostOn: true };
      orderBy: [{ autoPostOn: 'asc' }, { id: 'asc' }];
      take: number;
    }): Promise<AutoPostCandidate[]>;
  };
  glSettings: {
    findMany(args: {
      where: { tenantId: { in: string[] } };
      select: { tenantId: true; activatedAt: true; timezone: true; tenant: { select: { accountingSuiteEnabled: true; accountingEnabled: true } } };
    }): Promise<AutoPostTenantRow[]>;
  };
  $transaction<T>(fn: (tx: GlTx) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
}

export interface AutoPostTickResult {
  posted: { id: string; tenantId: string; number: string }[];
  rejected: (BulkRejection & { tenantId: string })[];
  /** شركات تُخطّيت: NOT_ACTIVATED (activatedAt فارغ) أو SUITE_OFF (الميزة مطفأة) */
  skippedTenants: { tenantId: string; reason: 'NOT_ACTIVATED' | 'SUITE_OFF' }[];
  /** مسودات لم يحن تاريخها بتوقيت الشركة */
  notDue: number;
}

/** رموز لا تُوسم بها المسودة (سباق عابر مع ترحيل أو حذف يدوي). */
const TRANSIENT_CODES = new Set(['LEDGER_MOVE_NOT_DRAFT', 'NOT_FOUND']);

/**
 * دورة واحدة: المسودات التي حلّ autoPostOn لها (≤ اليوم بتوقيت الشركة) تُرحَّل كلٌّ في معاملته بالمنفّذ SYSTEM.
 * الشركة بلا activatedAt أو بميزة مطفأة تُتخطى كلها (§6.1، §5.7). الفشل غير العابر يوسم المسودة
 * needsAttention (بشرط state:'DRAFT' وnumber:null) مع تدقيق، فلا تُعاد محاولتها كل ساعة.
 */
export async function runAutoPostTick(
  db: AutoPostTickDb,
  opts: { now?: Date; post?: PostDraftFn; limit?: number } = {},
): Promise<AutoPostTickResult> {
  const now = opts.now ?? new Date();
  const post = opts.post ?? postDraftMove;
  // أوسع منطقة زمنية متقدّمة (+14) لا تتجاوز يوماً بعد تاريخ UTC — يُضيَّق لكل شركة بتوقيتها
  const horizon = toDbDate(addDays(todayLocal(now, 'UTC'), 1));
  // الأهلية داخل الاستعلام: مسودات شركة غير مفعّلة أو مطفأة لا تحتل الدفعة فتجمّد المجدول لغيرها (العزل §9.4)
  const candidates = await db.glMove.findMany({
    where: {
      state: 'DRAFT', number: null, needsAttention: false, autoPostOn: { not: null, lte: horizon },
      tenant: AUTO_POST_ELIGIBLE_TENANT,
    },
    select: { id: true, tenantId: true, autoPostOn: true },
    orderBy: [{ autoPostOn: 'asc' }, { id: 'asc' }],
    take: opts.limit ?? AUTO_POST_BATCH,
  });
  const result: AutoPostTickResult = { posted: [], rejected: [], skippedTenants: [], notDue: 0 };
  if (candidates.length === 0) return result;

  const tenantIds = [...new Set(candidates.map((c) => c.tenantId))];
  const settings = await db.glSettings.findMany({
    where: { tenantId: { in: tenantIds } },
    select: { tenantId: true, activatedAt: true, timezone: true, tenant: { select: { accountingSuiteEnabled: true, accountingEnabled: true } } },
  });
  const byTenant = new Map(settings.map((s) => [s.tenantId, s]));

  for (const tenantId of tenantIds) {
    const s = byTenant.get(tenantId);
    // دفاع ثانٍ: الحالة قد تتغير بين الاستعلامين
    if (!s?.activatedAt) {
      result.skippedTenants.push({ tenantId, reason: 'NOT_ACTIVATED' });
      continue;
    }
    if (s.tenant?.accountingSuiteEnabled !== true || s.tenant?.accountingEnabled === false) {
      result.skippedTenants.push({ tenantId, reason: 'SUITE_OFF' });
      continue;
    }
    const today = todayLocal(now, s.timezone || DEFAULT_TIMEZONE);
    for (const c of candidates) {
      if (c.tenantId !== tenantId || !c.autoPostOn) continue;
      if (fromDbDate(c.autoPostOn) > today) { result.notDue++; continue; }
      try {
        const p = await db.$transaction(
          (tx) => post(tx, {
            tenantId, actor: SYSTEM_ACTOR, moveId: c.id, now,
            auditSummary: 'ترحيل مجدول لمسودة في تاريخ الترحيل التلقائي',
          }),
          POST_TX_OPTIONS,
        );
        result.posted.push({ id: c.id, tenantId, number: p.number });
      } catch (e) {
        let r: BulkRejection;
        try { r = rejectionOf(c.id, e); } catch (unexpected) {
          console.error('ledger auto-post error:', (unexpected as Error)?.message);
          r = { id: c.id, code: 'ERROR' };
        }
        result.rejected.push({ ...r, tenantId });
        if (!TRANSIENT_CODES.has(r.code)) {
          await flagAutoPostFailure(db, tenantId, c.id, r.code, now).catch((fe) => {
            console.error('ledger auto-post flag error:', (fe as Error)?.message);
          });
        }
      }
    }
  }
  return result;
}

/** يوسم المسودة التي فشل ترحيلها المجدول (مسودة بلا رقم فقط) مع تدقيق في المعاملة نفسها. */
async function flagAutoPostFailure(db: Pick<AutoPostTickDb, '$transaction'>, tenantId: string, moveId: string, code: string, now: Date): Promise<void> {
  await db.$transaction(async (tx) => {
    const flagged = await tx.glMove.updateMany({
      where: { id: moveId, tenantId, state: 'DRAFT', number: null },
      data: { needsAttention: true, attentionReason: `${AUTO_POST_ATTENTION_PREFIX}${code}` },
    });
    if (flagged.count !== 1) return;
    await appendAudit(tx, {
      tenantId, actor: SYSTEM_ACTOR, action: 'MOVE_UPDATE_DRAFT', entityType: 'MOVE', entityId: moveId,
      summary: `تعذّر الترحيل التلقائي للمسودة (${code}) — تحتاج انتباهاً`,
      after: { needsAttention: true, attentionReason: `${AUTO_POST_ATTENTION_PREFIX}${code}` },
      at: now,
    });
  }, POST_TX_OPTIONS);
}

let started = false;

/** يُسجَّل من startOpsScheduler (services/opsSchedule.ts). دورة كل ساعة، وأولى بعد دقيقتين من الإقلاع. */
export function startLedgerAutoPostScheduler(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      const { default: prisma } = await import('../../config/database');
      const r = await runAutoPostTick(prisma as unknown as AutoPostTickDb);
      if (r.posted.length || r.rejected.length) {
        console.log(`📒 ledger auto-post: posted ${r.posted.length}, rejected ${r.rejected.length}`);
      }
    } catch (e) {
      console.error('ledger auto-post tick error:', (e as Error)?.message);
    }
  };
  setTimeout(() => { void tick(); }, 2 * 60 * 1000);
  setInterval(() => { void tick(); }, AUTO_POST_INTERVAL_MS);
}
