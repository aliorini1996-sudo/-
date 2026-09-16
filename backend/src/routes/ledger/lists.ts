import crypto from 'node:crypto';
import { Router, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { ledgerExportLimiter } from '../../middleware/rateLimits';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import {
  MOVE_ITEM_SELECT, MOVE_LIST_SELECT, itemListWhere, listParam, moveListWhere, serializeItemRow, serializeMoveRow,
  taxNamesFor, type ListQuery,
} from './moves';
import { appendAudit, canonicalJson, ledgerActor } from '../../services/gl/audit';
import { normalizeIds } from '../../services/gl/autoPost';
import { LedgerError } from '../../services/gl/types';

/**
 * تصدير القوائم (§8.3، §9.4، ملحق أ): `POST /lists/:list/export` بصلاحية canViewLedger ومحدد ledgerExportLimiter.
 * - الجسم: `{format?: 'xlsx', filters?: {...فلاتر القائمة نفسها}, ids?: string[]}` (الفلاتر تُقبل أيضاً في جذر الجسم).
 * - الخادم يعيد الصفوف كاملة بدفعات مؤشّر (keyset) بلا ترقيم، والمتصفح يبني XLSX بـutils/excel (ADR‑9).
 * - السقف 50,000 صف وإلا 422 LEDGER_EXPORT_TOO_LARGE {lines, cap}.
 * - صف تدقيق EXPORT قبل الرد: {reportKey, format, from, to, optionsHash, lineCount, impersonated}.
 * M2: moves وitems وaccounts؛ bills|payments|expenses|vendors في M6 (404 حتى ذلك الحين).
 */
const router = Router();

const locals = (res: Response) => res.locals.ledger as LedgerLocals;

export const LIST_EXPORT_CAP = 50_000;
export const LIST_EXPORT_BATCH = 5_000;
export const EXPORTABLE_LISTS = ['moves', 'items', 'accounts'] as const;
export type ExportableList = (typeof EXPORTABLE_LISTS)[number];
/** قوائم ملحق أ التي تُسلَّم مع وحداتها (M6) */
export const LATER_LISTS = ['bills', 'payments', 'expenses', 'vendors'] as const;

/** فلاتر التصدير: `filters` أو جذر الجسم، و`ids[]` للمحدد. */
export function exportFiltersOf(body: unknown): ListQuery {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const nested = b.filters && typeof b.filters === 'object' && !Array.isArray(b.filters) ? (b.filters as Record<string, unknown>) : null;
  const { format: _f, filters: _n, ...root } = b;
  void _f; void _n;
  const q: ListQuery = { ...(nested ?? root) };
  if (b.ids !== undefined) q.ids = b.ids;
  return q;
}

/** حد المعرّفات المحددة في طلب تصدير واحد (مطابق لاقتطاع listParam). */
export const EXPORT_IDS_MAX = 1000;

/**
 * تحديد التصدير الصارم (§9.4: التصدير والتدقيق يعكسان ما طُلب):
 * - 'ABSENT': لا ids ⇒ الفلاتر وحدها.
 * - 'EMPTY': ids مُرسَلة بلا معرّف صالح ⇒ لا صفوف (لا تسقط إلى تصدير الكل).
 * - string[]: المعرّفات؛ وما فوق EXPORT_IDS_MAX ⇒ 400 TOO_MANY_IDS لا اقتطاع صامت.
 */
export function exportIdsOf(v: unknown): 'ABSENT' | 'EMPTY' | string[] {
  if (v === undefined || v === null) return 'ABSENT';
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const ids = normalizeIds(raw);
  if (ids.length > EXPORT_IDS_MAX) {
    throw new LedgerHttpError(400, 'عدد المعرّفات المحددة يتجاوز الحد', { reason: 'TOO_MANY_IDS', max: EXPORT_IDS_MAX, count: ids.length });
  }
  const valid = listParam(ids);
  return valid ? valid : 'EMPTY';
}

/** بصمة الخيارات للتدقيق (sha256 مختصرة لخيارات مرتبة المفاتيح). */
export function optionsHashOf(list: string, q: ListQuery): string {
  return crypto.createHash('sha256').update(canonicalJson({ list, ...q })).digest('hex').slice(0, 16);
}

/** قراءة مؤشّرية بدفعات حتى النهاية. */
export async function readBatched<T extends { id: string }>(
  fetch: (args: { take: number; cursor?: { id: string }; skip?: number }) => Promise<T[]>,
  batch = LIST_EXPORT_BATCH,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetch({ take: batch, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    out.push(...page);
    if (page.length < batch) return out;
    cursor = page[page.length - 1].id;
  }
}

function assertUnderCap(lines: number): void {
  if (lines > LIST_EXPORT_CAP) throw new LedgerError('LEDGER_EXPORT_TOO_LARGE', { lines, cap: LIST_EXPORT_CAP });
}

const ACCOUNT_EXPORT_SELECT = {
  id: true, code: true, name: true, nameEn: true, description: true, type: true, reconcile: true, isActive: true,
  isSystem: true, controlKind: true, currencyCode: true, cashFlowTag: true,
  tagLinks: { select: { tag: { select: { name: true } } } },
} as const;

export function accountListWhere(tenantId: string, q: ListQuery): Prisma.GlAccountWhereInput {
  const where: Prisma.GlAccountWhereInput = { tenantId };
  const types = listParam(q.type);
  if (types) where.type = { in: types };
  const kinds = listParam(q.controlKind);
  if (kinds) where.controlKind = { in: kinds };
  if (q.isActive === true || q.isActive === 'true' || q.isActive === '1') where.isActive = true;
  if (q.isActive === false || q.isActive === 'false' || q.isActive === '0') where.isActive = false;
  const ids = listParam(q.ids);
  if (ids) where.id = { in: ids };
  const search = typeof q.search === 'string' ? q.search.trim().slice(0, 200) : '';
  if (search) {
    where.OR = [
      { code: { startsWith: search } },
      { name: { contains: search, mode: 'insensitive' } },
      { nameEn: { contains: search, mode: 'insensitive' } },
    ];
  }
  return where;
}

export async function exportRows(tenantId: string, list: ExportableList, q: ListQuery): Promise<unknown[]> {
  if (exportIdsOf(q.ids) === 'EMPTY') return [];
  if (list === 'moves') {
    const where = moveListWhere(tenantId, q);
    assertUnderCap(await prisma.glMove.count({ where }));
    const rows = await readBatched((page) => prisma.glMove.findMany({
      where, select: MOVE_LIST_SELECT, orderBy: [{ date: 'asc' }, { id: 'asc' }], ...page,
    }));
    return rows.map(serializeMoveRow);
  }
  if (list === 'items') {
    const where = itemListWhere(tenantId, q);
    assertUnderCap(await prisma.glMoveLine.count({ where }));
    const rows = await readBatched((page) => prisma.glMoveLine.findMany({
      where, select: MOVE_ITEM_SELECT, orderBy: [{ date: 'asc' }, { moveId: 'asc' }, { seq: 'asc' }, { id: 'asc' }], ...page,
    }));
    const taxNames = await taxNamesFor(tenantId, rows.map((r) => r.taxId));
    return rows.map((r) => serializeItemRow(r, taxNames));
  }
  const where = accountListWhere(tenantId, q);
  assertUnderCap(await prisma.glAccount.count({ where }));
  const rows = await readBatched((page) => prisma.glAccount.findMany({
    where, select: ACCOUNT_EXPORT_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }], ...page,
  }));
  return rows.map(({ tagLinks, ...a }) => ({ ...a, tags: tagLinks.map((t) => t.tag.name) }));
}

router.post('/lists/:list/export', requireLedgerPermission('canViewLedger'), ledgerExportLimiter, ledgerHandler(async (req, res) => {
  const l = locals(res);
  const list = String(req.params.list);
  if (!(EXPORTABLE_LISTS as readonly string[]).includes(list)) {
    const later = (LATER_LISTS as readonly string[]).includes(list);
    throw new LedgerHttpError(404, later ? 'هذه القائمة تُتاح مع وحدة الموردين' : 'قائمة غير معروفة', {
      reason: later ? 'LIST_NOT_AVAILABLE' : 'UNKNOWN_LIST', list,
    });
  }
  const format = req.body?.format ?? 'xlsx';
  if (format !== 'xlsx') throw new LedgerHttpError(400, 'صيغة التصدير غير مدعومة', { reason: 'UNSUPPORTED_FORMAT', format });
  const q = exportFiltersOf(req.body);
  const selection = exportIdsOf(q.ids);
  const rows = await exportRows(l.tenantId, list as ExportableList, q);

  const actor = ledgerActor(l, { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });
  const from = typeof q.dateFrom === 'string' ? q.dateFrom : null;
  const to = typeof q.dateTo === 'string' ? q.dateTo : null;
  await prisma.$transaction((tx) => appendAudit(tx, {
    tenantId: l.tenantId, actor, action: 'EXPORT', entityType: 'LIST', entityId: list,
    summary: `تصدير قائمة ${list} (${rows.length} صف)`,
    after: {
      reportKey: `lists/${list}`, format, from, to, optionsHash: optionsHashOf(list, q), lineCount: rows.length,
      impersonated: l.impersonated === true, selected: selection !== 'ABSENT',
    },
  }));
  res.json({ success: true, data: { list, format, rows, lineCount: rows.length, cap: LIST_EXPORT_CAP } });
}));

export default router;
