/**
 * «المحاسب الذكي AI» — مستندات المحادثة: جمع المهمَل (القرار D8، نمط routes/printForms.ts الكسول).
 *
 * المستند غير المرحّل (moveId فارغ) الذي لم يُلمس منذ AI_ACCOUNTANT_DOC_RETENTION_DAYS (افتراض ٣٠ يوماً) يُحذف مع ملفه —
 * القِدم بآخر نشاط (updatedAt: الرفع، والتصحيح، وإعادة رفع الملف نفسه) لا بالإنشاء، فلا يُجمع مستندٌ يراجعه صاحبه الآن:
 *   - كسولاً عند كل رفع، تحت قفل حصّة المرفقات 'gl-attach:'+tenantId نفسه، بحدّ ٥٠ في الدورة (gcTenantDocs) — فيُحرّر
 *     الحصة قبل حسابها؛
 *   - وبكنسٍ يومي لكل الشركات (runDocsGc) يسجّله مُجدول العمليات.
 * لا يُمسّ أبداً مستندٌ مرتبط بقيد (moveId مضبوط، حيّاً أو معكوساً) ولا مرفقٌ صار على قيد (entityType 'MOVE'): الحذف
 * لمرفقات 'AI_DOC' بمعرّف المستند نفسه وحدها، ثم صفوف المستندات بشرط moveId = null (مقارنة وتبديل تحت المعاملة).
 */
import { DOC_ATTACH_LOCK_PREFIX, GC_BATCH, docRetentionDays } from './caps';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Q = (args: any) => Promise<any>;

/** أدنى شكل لمعاملة الجمع: Prisma.TransactionClient والمزيّف في الاختبارات */
export interface DocsGcTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  aiAccountantDocument: { findMany: Q; deleteMany: Q };
  glAttachment: { deleteMany: Q };
}

export interface DocsGcDb {
  aiAccountantDocument: { findMany: Q };
  $transaction<T>(fn: (tx: DocsGcTx) => Promise<T>, opts?: { maxWait?: number; timeout?: number }): Promise<T>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** حدّ القِدم: ما لم يُلمس بعده ولم يُرحَّل يُجمع */
export function docsGcCutoff(now: Date, retentionDays: number = docRetentionDays()): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** يأخذ قفل حصّة المرفقات للشركة داخل المعاملة (رفعٌ وحذفٌ وجمعٌ متزامنة لا تتسابق) */
export async function lockDocAttachments(tx: Pick<DocsGcTx, '$executeRaw'>, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${DOC_ATTACH_LOCK_PREFIX + tenantId}::text))`;
}

/**
 * دورة جمعٍ لشركة واحدة داخل معاملة تحمل قفلها (lockDocAttachments) — تعيد عدد المستندات المحذوفة.
 * الأقدم نشاطاً أولاً، بحدّ limit.
 */
export async function gcTenantDocs(
  tx: DocsGcTx, tenantId: string, now: Date, opts: { limit?: number; retentionDays?: number } = {},
): Promise<number> {
  const cutoff = docsGcCutoff(now, opts.retentionDays ?? docRetentionDays());
  const stale: { id: string }[] = await tx.aiAccountantDocument.findMany({
    where: { tenantId, moveId: null, updatedAt: { lt: cutoff } },
    select: { id: true }, orderBy: { updatedAt: 'asc' }, take: opts.limit ?? GC_BATCH,
  });
  if (!stale.length) return 0;
  const ids = stale.map((d) => d.id);
  // الملف أولاً: مرفق AI_DOC لهذا المستند وحده (المحتوى يُحذف معه بالتتالي) — مرفقٌ صار على قيد لا يطابق الشرط
  await tx.glAttachment.deleteMany({ where: { tenantId, entityType: 'AI_DOC', entityId: { in: ids } } });
  const r: { count: number } = await tx.aiAccountantDocument.deleteMany({ where: { tenantId, id: { in: ids }, moveId: null } });
  return r.count;
}

/** مهلة معاملة الجمع (حذف bytea بالعشرات) */
const GC_TX = { maxWait: 10_000, timeout: 30_000 } as const;
/** أقصى دورات لشركة في كنسٍ واحد (٥٠ × ٢٠ = ١٠٠٠ مستند) */
const MAX_PASSES = 20;
/** أقصى شركات في كنسٍ واحد */
const MAX_TENANTS = 500;

/**
 * الكنس اليومي لكل الشركات: الشركات التي لها مستند قديم غير مرحّل، ثم لكلٍّ معاملةٌ بقفلها ودوراتٌ حتى تفرغ.
 * فشل شركةٍ لا يوقف غيرها (يُعدّ في failed).
 */
export async function runDocsGc(db: DocsGcDb, opts: { now?: Date; retentionDays?: number } = {}): Promise<{ tenants: number; deleted: number; failed: number }> {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? docRetentionDays();
  const rows: { tenantId: string }[] = await db.aiAccountantDocument.findMany({
    where: { moveId: null, updatedAt: { lt: docsGcCutoff(now, retentionDays) } },
    select: { tenantId: true }, distinct: ['tenantId'], take: MAX_TENANTS,
  });
  let deleted = 0;
  let failed = 0;
  for (const { tenantId } of rows) {
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const n = await db.$transaction(async (tx) => {
          await lockDocAttachments(tx, tenantId);
          return gcTenantDocs(tx, tenantId, now, { retentionDays });
        }, GC_TX);
        deleted += n;
        if (n < GC_BATCH) break;
      }
    } catch (err) {
      failed += 1;
      console.error('[ai-accountant] تعذّر جمع مستندات شركة', tenantId, (err as Error)?.message ?? err);
    }
  }
  return { tenants: rows.length, deleted, failed };
}
