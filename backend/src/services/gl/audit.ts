/**
 * سجل تدقيق الدفاتر (M2، DESIGN.md §9.3، §9.5 G5).
 *
 * - إلحاقي فقط: لا update ولا delete على gl_audit_logs في أي ملف (ولا تحذفه إعادة الضبط، GL_RESET_KEEP §5.7).
 * - كل كتابة تُدوَّن **داخل معاملتها** بـappendAudit(tx, …).
 * - السلسلة: hash = sha256(prevHash + canonical(entry)) تحت pg_advisory_xact_lock(hashtext('gl-audit:'||tid)).
 *   السابق = صف seq الأعلى (لا at الأحدث)، وseq = prev.seq + 1 تحت القفل نفسه، و@@unique([tenantId, seq]) يحسم السباق.
 * - أقفال المعاملة وحدها (xact) — لا أقفال جلسة.
 */
import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';

export type GlTx = Prisma.TransactionClient;

// ═══ المنفّذ ═══

export const AUDIT_ACTOR_TYPES = ['ADMIN', 'IMPERSONATION', 'SYSTEM', 'OWNER'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** منفّذ كتابة الدفاتر كما يُدوَّن على القيد (createdBy/postedBy) وفي GlAuditLog. */
export interface GlActor {
  actorType: AuditActorType;
  actorId: string | null;
  actorName?: string | null;
  impersonated: boolean;
  requestIp?: string | null;
}

/** المُرحِّل والمجدول وخدمات النظام. */
export const SYSTEM_ACTOR: Readonly<GlActor> = { actorType: 'SYSTEM', actorId: null, actorName: null, impersonated: false };

/** منفّذ من res.locals.ledger (routes/ledger/context.ts): الانتحال يُوسم IMPERSONATION مع impersonated=true. */
export function ledgerActor(
  locals: { actorId: string; impersonated: boolean },
  extra: { actorName?: string | null; requestIp?: string | null } = {},
): GlActor {
  return {
    actorType: locals.impersonated ? 'IMPERSONATION' : 'ADMIN',
    actorId: locals.actorId,
    actorName: extra.actorName ?? null,
    impersonated: locals.impersonated === true,
    requestIp: extra.requestIp ?? null,
  };
}

// ═══ الإجراءات (§9.3) ═══

export const AUDIT_ACTIONS = [
  'SETUP_START', 'SETUP_COMMIT', 'FLAG_TOGGLE',
  'MOVE_CREATE', 'MOVE_UPDATE_DRAFT', 'MOVE_DELETE_DRAFT', 'MOVE_POST', 'MOVE_REVERSE', 'MOVE_RESET_DRAFT',
  'MOVE_REPOST', 'MOVE_REVIEW', 'MOVE_NOTE', 'MOVE_CONTROL_ADJUST',
  'CUSTOMER_ADJUSTMENT', 'CUSTODY_SHORTAGE', 'AUTO_POST',
  'EVENT_RETRY', 'EVENT_SKIP', 'EVENT_HOLD_RELEASE',
  'ACCOUNT_CREATE', 'ACCOUNT_UPDATE', 'ACCOUNT_ARCHIVE', 'ACCOUNT_IMPORT',
  'JOURNAL_CREATE', 'JOURNAL_UPDATE', 'JOURNAL_ARCHIVE', 'JOURNAL_SEED',
  'TAX_CREATE', 'TAX_UPDATE', 'TAX_ARCHIVE', 'TAX_SEED',
  'TEMPLATE_SEED', 'MAPPING_CHANGE', 'SETTINGS_CHANGE', 'LOCK_DATE_CHANGE',
  'RECONCILE', 'UNRECONCILE', 'STATEMENT_IMPORT',
  'ATTACHMENT_ADD', 'SAVED_FILTER_CHANGE',
  'TAX_RETURN_LOCK', 'TAX_RETURN_FILE', 'TAX_RETURN_PAY',
  'INVENTORY_CLOSE', 'SECURE_ENTRIES', 'FY_CLOSE', 'LEDGER_RESET', 'EXPORT',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** البادئات المفتوحة في §9.3 (JOURNAL_*، TAX_*، BILL_*، PAYMENT_*، EXPENSE_*، ASSET_*، LOAN_*). */
const OPEN_ACTION_PREFIXES = ['JOURNAL_', 'TAX_', 'BILL_', 'PAYMENT_', 'EXPENSE_', 'ASSET_', 'LOAN_', 'ATTACHMENT_'];

export function isAuditAction(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(v)) return false;
  return (AUDIT_ACTIONS as readonly string[]).includes(v) || OPEN_ACTION_PREFIXES.some((p) => v.startsWith(p));
}

// ═══ JSON قانوني ═══

/**
 * يحوّل قيمة إلى JSON آمن للتخزين: BigInt ⇒ نص، Date ⇒ ISO، undefined يُسقط، والدوال والرموز تُسقط.
 * null ⇒ null.
 */
export function toAuditJson(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => toAuditJson(x));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
      out[k] = toAuditJson(x);
    }
    return out;
  }
  return null;
}

/**
 * JSON قانوني: مفاتيح مرتبة تكرارياً (jsonb في Postgres لا يحفظ ترتيب المفاتيح، فالتحقق بعد القراءة يحتاج الترتيب نفسه).
 */
export function canonicalJson(v: unknown): string {
  const norm = toAuditJson(v);
  const walk = (x: unknown): string => {
    if (x === null) return 'null';
    if (Array.isArray(x)) return `[${x.map(walk).join(',')}]`;
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${walk(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(x);
  };
  return walk(norm);
}

/** الحقول الداخلة في التجزئة — كل أعمدة الصف عدا id وprevHash وhash. */
export interface AuditHashFields {
  tenantId: string;
  seq: number;
  at: Date;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  impersonated: boolean;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  beforeJson: unknown;
  afterJson: unknown;
  requestIp: string | null;
}

export function canonicalAuditEntry(e: AuditHashFields): string {
  return canonicalJson({
    tenantId: e.tenantId,
    seq: e.seq,
    at: e.at instanceof Date ? e.at.toISOString() : String(e.at),
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    actorName: e.actorName ?? null,
    impersonated: e.impersonated === true,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    summary: e.summary,
    beforeJson: e.beforeJson ?? null,
    afterJson: e.afterJson ?? null,
    requestIp: e.requestIp ?? null,
  });
}

/** hash = sha256(prevHash + canonical(entry)) بترميز hex؛ الصف الأول prevHash = null ⇒ ''. */
export function computeAuditHash(prevHash: string | null, canonical: string): string {
  return crypto.createHash('sha256').update((prevHash ?? '') + canonical, 'utf8').digest('hex');
}

export interface AuditChainRow extends AuditHashFields {
  prevHash: string | null;
  hash: string;
}

export type AuditChainVerdict =
  | { ok: true; count: number; lastSeq: number; lastHash: string | null }
  | { ok: false; seq: number; reason: 'SEQ_GAP' | 'PREV_HASH' | 'HASH' };

/**
 * يتحقق من السلسلة بترتيب seq (لا at): تبدأ من 1 بلا فجوات، وprevHash = hash السابق، وhash يطابق إعادة الحساب.
 * حذف صف ⇒ SEQ_GAP أو PREV_HASH، وتعديل صف ⇒ HASH.
 */
export function verifyAuditChain(rows: readonly AuditChainRow[]): AuditChainVerdict {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  let prev: AuditChainRow | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.seq !== i + 1) return { ok: false, seq: r.seq, reason: 'SEQ_GAP' };
    if ((r.prevHash ?? null) !== (prev ? prev.hash : null)) return { ok: false, seq: r.seq, reason: 'PREV_HASH' };
    if (computeAuditHash(r.prevHash ?? null, canonicalAuditEntry(r)) !== r.hash) return { ok: false, seq: r.seq, reason: 'HASH' };
    prev = r;
  }
  return { ok: true, count: sorted.length, lastSeq: prev ? prev.seq : 0, lastHash: prev ? prev.hash : null };
}

// ═══ الكتابة ═══

export const AUDIT_LOCK_PREFIX = 'gl-audit:';

export interface AppendAuditInput {
  tenantId: string;
  actor: GlActor;
  action: AuditAction | string;
  entityType: string;
  entityId?: string | null;
  /** عربي مقروء */
  summary: string;
  before?: unknown;
  after?: unknown;
  /** يتجاوز actor.requestIp */
  requestIp?: string | null;
  /** للاختبار — الافتراضي الآن (دقة ملّي ثانية كعمود Prisma الافتراضي) */
  at?: Date;
}

export interface AppendedAudit {
  id: string;
  seq: number;
  hash: string;
  prevHash: string | null;
}

/**
 * يُلحق صف تدقيق داخل المعاملة tx (ولا يفتح معاملة): قفل gl-audit للشركة، ثم آخر seq، ثم التجزئة، ثم الإدراج.
 */
export async function appendAudit(tx: GlTx, input: AppendAuditInput): Promise<AppendedAudit> {
  if (!isAuditAction(input.action)) throw new RangeError(`إجراء تدقيق غير معروف: ${String(input.action)}`);
  if (!input.tenantId) throw new RangeError('appendAudit: tenantId مطلوب');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${AUDIT_LOCK_PREFIX + input.tenantId}::text))`;
  const prev = await tx.glAuditLog.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });
  const seq = (prev?.seq ?? 0) + 1;
  const prevHash = prev?.hash ?? null;
  const at = new Date(Math.floor((input.at ?? new Date()).getTime()));
  const beforeJson = input.before === undefined || input.before === null ? null : toAuditJson(input.before);
  const afterJson = input.after === undefined || input.after === null ? null : toAuditJson(input.after);
  const fields: AuditHashFields = {
    tenantId: input.tenantId,
    seq,
    at,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId ?? null,
    actorName: input.actor.actorName ?? null,
    impersonated: input.actor.impersonated === true,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary,
    beforeJson,
    afterJson,
    requestIp: input.requestIp ?? input.actor.requestIp ?? null,
  };
  const hash = computeAuditHash(prevHash, canonicalAuditEntry(fields));
  const row = await tx.glAuditLog.create({
    data: {
      tenantId: fields.tenantId,
      seq,
      at,
      actorType: fields.actorType,
      actorId: fields.actorId,
      actorName: fields.actorName,
      impersonated: fields.impersonated,
      action: fields.action,
      entityType: fields.entityType,
      entityId: fields.entityId,
      summary: fields.summary,
      ...(beforeJson !== null ? { beforeJson: beforeJson as Prisma.InputJsonValue } : {}),
      ...(afterJson !== null ? { afterJson: afterJson as Prisma.InputJsonValue } : {}),
      requestIp: fields.requestIp,
      prevHash,
      hash,
    },
    select: { id: true },
  });
  return { id: row.id, seq, hash, prevHash };
}
