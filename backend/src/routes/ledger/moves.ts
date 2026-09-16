import crypto from 'node:crypto';
import express, { Router, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, ledgerActor, type GlActor } from '../../services/gl/audit';
import {
  BULK_MOVE_IDS_LIMIT, POST_TX_OPTIONS, isLedgerActivated, normalizeIds, postDraftsBatch, type AutoPostDb,
} from '../../services/gl/autoPost';
import { DEFAULT_TIMEZONE, fromDbDate, isLocalDate, startOfMonth, toDbDate, todayLocal, zonedStartOfDay } from '../../services/gl/dates';
import {
  buildManualMoveDraft, draftRowsFromMoveDraft, priceIncludeGrossAmounts, saveDraftMove, type ManualLineInput,
} from '../../services/gl/draft';
import { effectiveLockDate, lockScopeOfDraft } from '../../services/gl/locks';
import { fromMilli } from '../../services/gl/money';
import { acquirePostLock, postDraftMove, type PostedMove } from '../../services/gl/post';
import {
  GlNotFoundError, MOVE_LINE_ENGINE_SELECT, MOVE_RECORD_SELECT, loadBuildContext, moveDraftFromRecord,
} from '../../services/gl/resolve';
import {
  assertManualOwned, assertReversalReason, deleteDraftMove, deleteDraftMoves, ownershipOfRecord, resetDraft, reverseMove,
} from '../../services/gl/reverse';
import { collectMoveIssues } from '../../services/gl/validate';
import { LedgerError, type LocalDate, type Milli } from '../../services/gl/types';

/**
 * القيود اليدوية وبنود اليومية (M2، DESIGN.md §6.1، §8.3، §9.2–§9.4، ملحق أ).
 *
 * - القراءة canViewLedger، والكتابة canPostJournals. كل استعلام معزول بـtenantId من res.locals.ledger (§9.4).
 * - **قبل التفعيل** (activatedAt فارغ): إنشاء المسودات وتحريرها وحذفها مسموح، والترحيل 409 LEDGER_NOT_SETUP
 *   (`/moves/:id/post` هنا، و`/moves/post-drafts` بكل معرّف في rejected). الفحص في المعالج لا في post.ts.
 * - لا تعديل لسطر (لا glMoveLine.update*)، ولا لمرحَّل إلا reviewState (§2.4). الحذف عبر deleteDraftMove(s) وحده.
 * - reverse/reset-draft: assertReversalReason ثم assertManualOwned قبل reverseMove/resetDraft (I7، G5).
 */
const router = Router();

const locals = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(locals(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });

// ═══ معاملات الاستعلام (مشتركة مع lists.ts) ═══

export type ListQuery = Record<string, unknown>;

function strParam(v: unknown): string | undefined {
  if (Array.isArray(v)) return strParam(v[0]);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t.slice(0, 200);
}

/** قائمة من مصفوفة أو نص مفصول بفواصل. */
export function listParam(v: unknown): string[] | undefined {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = normalizeIds(raw).map((s) => s.slice(0, 200));
  return out.length ? out.slice(0, 1000) : undefined;
}

function boolParam(v: unknown): boolean | undefined {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return undefined;
}

function dateParam(v: unknown, field: string): LocalDate | undefined {
  const s = strParam(v);
  if (!s) return undefined;
  if (!isLocalDate(s)) throw new LedgerHttpError(400, 'تاريخ غير صالح', { reason: 'INVALID_DATE', field });
  return s;
}

export interface Paging { offset: number; limit: number }
export const LIST_DEFAULT_LIMIT = 80;
export const LIST_MAX_LIMIT = 500;

export function pagingOf(q: ListQuery): Paging {
  const off = Number(strParam(q.offset) ?? 0);
  const lim = Number(strParam(q.limit) ?? LIST_DEFAULT_LIMIT);
  return {
    offset: Number.isFinite(off) && off > 0 ? Math.floor(off) : 0,
    limit: Number.isFinite(lim) && lim > 0 ? Math.min(Math.floor(lim), LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT,
  };
}

function dirOf(q: ListQuery, fallback: 'asc' | 'desc'): 'asc' | 'desc' {
  const d = strParam(q.dir);
  return d === 'asc' || d === 'desc' ? d : fallback;
}

/** فلاتر قائمة القيود (JE‑01/02): الحالة والدفتر والمصدر والمراجعة والتاريخ والشريك والحساب والبحث والمعرّفات. */
export function moveListWhere(tenantId: string, q: ListQuery): Prisma.GlMoveWhereInput {
  const and: Prisma.GlMoveWhereInput[] = [];
  const where: Prisma.GlMoveWhereInput = { tenantId };
  const states = listParam(q.state)?.filter((s) => s === 'DRAFT' || s === 'POSTED');
  if (states?.length) where.state = { in: states };
  const journals = listParam(q.journalId);
  if (journals) where.journalId = { in: journals };
  const origins = listParam(q.origin);
  if (origins) where.origin = { in: origins };
  const moveTypes = listParam(q.moveType);
  if (moveTypes) where.moveType = { in: moveTypes };
  const review = listParam(q.reviewState);
  if (review) where.reviewState = { in: review };
  const attention = boolParam(q.needsAttention);
  if (attention !== undefined) where.needsAttention = attention;
  const late = boolParam(q.lateArrival);
  if (late !== undefined) where.lateArrival = late;
  const autoPost = boolParam(q.autoPost);
  if (autoPost !== undefined) where.autoPostOn = autoPost ? { not: null } : null;
  const from = dateParam(q.dateFrom, 'dateFrom');
  const to = dateParam(q.dateTo, 'dateTo');
  if (from || to) where.date = { ...(from ? { gte: toDbDate(from) } : {}), ...(to ? { lte: toDbDate(to) } : {}) };
  const ids = listParam(q.ids);
  if (ids) where.id = { in: ids };
  for (const k of ['customerId', 'vendorId', 'salesRepId'] as const) {
    const v = strParam(q[k]);
    if (v) and.push({ OR: [{ [k]: v }, { lines: { some: { [k]: v } } }] });
  }
  const accounts = listParam(q.accountId);
  if (accounts) and.push({ lines: { some: { accountId: { in: accounts } } } });
  const search = strParam(q.search);
  if (search) {
    and.push({
      OR: [
        { number: { contains: search, mode: 'insensitive' } },
        { ref: { contains: search, mode: 'insensitive' } },
        { narration: { contains: search, mode: 'insensitive' } },
        { lines: { some: { partnerName: { contains: search, mode: 'insensitive' } } } },
      ],
    });
  }
  if (and.length) where.AND = and;
  return where;
}

const MOVE_SORT_FIELDS = ['date', 'number', 'totalMilli', 'createdAt'] as const;

export function moveListOrder(q: ListQuery): Prisma.GlMoveOrderByWithRelationInput[] {
  const f = strParam(q.sort);
  const field = (MOVE_SORT_FIELDS as readonly string[]).includes(f ?? '') ? (f as (typeof MOVE_SORT_FIELDS)[number]) : 'date';
  const dir = dirOf(q, 'desc');
  return [{ [field]: dir }, { createdAt: dir }, { id: dir }];
}

export const MOVE_LIST_SELECT = {
  id: true, number: true, state: true, date: true, ref: true, narration: true, totalMilli: true, currencyCode: true,
  currencyDecimals: true, origin: true, moveType: true, reviewState: true, needsAttention: true, attentionReason: true,
  lateArrival: true, originalDate: true, autoPostOn: true, sourceType: true, sourceId: true, customerId: true,
  vendorId: true, salesRepId: true, reversedMoveId: true, draftOfMoveId: true, createdAt: true, postedAt: true,
  journal: { select: { id: true, code: true, name: true } },
  reversal: { select: { id: true, number: true } },
  lines: { where: { partnerName: { not: null } }, select: { partnerName: true }, orderBy: { seq: 'asc' as const }, take: 1 },
} as const;

type MoveListRow = Prisma.GlMoveGetPayload<{ select: typeof MOVE_LIST_SELECT }>;

const d = (v: Date | null | undefined): LocalDate | null => (v ? fromDbDate(v) : null);
const amt = (v: Milli | null | undefined): number | null => (v === null || v === undefined ? null : fromMilli(v));

export function serializeMoveRow(m: MoveListRow) {
  return {
    id: m.id,
    number: m.number,
    state: m.state,
    date: fromDbDate(m.date),
    journal: m.journal,
    ref: m.ref,
    narration: m.narration,
    partnerName: m.lines[0]?.partnerName ?? null,
    total: fromMilli(m.totalMilli),
    currencyCode: m.currencyCode,
    currencyDecimals: m.currencyDecimals,
    origin: m.origin,
    moveType: m.moveType,
    reviewState: m.reviewState,
    needsAttention: m.needsAttention,
    attentionReason: m.attentionReason,
    lateArrival: m.lateArrival,
    originalDate: d(m.originalDate),
    autoPostOn: d(m.autoPostOn),
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    customerId: m.customerId,
    vendorId: m.vendorId,
    salesRepId: m.salesRepId,
    reversedMoveId: m.reversedMoveId,
    reversal: m.reversal,
    draftOfMoveId: m.draftOfMoveId,
    createdAt: m.createdAt,
    postedAt: m.postedAt,
  };
}

/** فلاتر بنود اليومية (JI، `/items`). */
export function itemListWhere(tenantId: string, q: ListQuery): Prisma.GlMoveLineWhereInput {
  const where: Prisma.GlMoveLineWhereInput = { tenantId };
  const and: Prisma.GlMoveLineWhereInput[] = [];
  const states = listParam(q.state)?.filter((s) => s === 'DRAFT' || s === 'POSTED');
  if (states?.length === 1) where.posted = states[0] === 'POSTED';
  const accounts = listParam(q.accountId);
  if (accounts) where.accountId = { in: accounts };
  const journals = listParam(q.journalId);
  if (journals) where.journalId = { in: journals };
  const from = dateParam(q.dateFrom, 'dateFrom');
  const to = dateParam(q.dateTo, 'dateTo');
  if (from || to) where.date = { ...(from ? { gte: toDbDate(from) } : {}), ...(to ? { lte: toDbDate(to) } : {}) };
  for (const k of ['customerId', 'vendorId', 'salesRepId', 'analyticAccountId', 'productId', 'moveId'] as const) {
    const v = strParam(q[k]);
    if (v) where[k] = v;
  }
  const taxes = listParam(q.taxId);
  if (taxes) where.taxId = { in: taxes };
  const boxes = listParam(q.vatBox);
  if (boxes) where.vatBox = { in: boxes };
  const roles = listParam(q.taxRole);
  if (roles) where.taxRole = { in: roles };
  const ids = listParam(q.ids);
  if (ids) where.id = { in: ids };
  const search = strParam(q.search);
  if (search) {
    and.push({
      OR: [
        { label: { contains: search, mode: 'insensitive' } },
        { partnerName: { contains: search, mode: 'insensitive' } },
        { move: { number: { contains: search, mode: 'insensitive' } } },
        { move: { ref: { contains: search, mode: 'insensitive' } } },
      ],
    });
  }
  if (and.length) where.AND = and;
  return where;
}

export function itemListOrder(q: ListQuery): Prisma.GlMoveLineOrderByWithRelationInput[] {
  const dir = dirOf(q, 'desc');
  return [{ date: dir }, { moveId: dir }, { seq: 'asc' }, { id: 'asc' }];
}

export const MOVE_ITEM_SELECT = {
  id: true, moveId: true, seq: true, accountId: true, journalId: true, date: true, posted: true, label: true,
  debitMilli: true, creditMilli: true, customerId: true, vendorId: true, salesRepId: true, partnerName: true,
  analyticAccountId: true, productId: true, quantity: true, taxId: true, taxRole: true, taxBaseMilli: true,
  vatBox: true, vatAdjustment: true, dueDate: true,
  account: { select: { code: true, name: true, type: true } },
  move: { select: { number: true, state: true, ref: true, origin: true, currencyCode: true, journal: { select: { code: true, name: true } } } },
} as const;

type MoveItemRow = Prisma.GlMoveLineGetPayload<{ select: typeof MOVE_ITEM_SELECT }>;

/** أسماء الضرائب لصفحة من السطور (لا علاقة taxId في النموذج). */
export async function taxNamesFor(tenantId: string, taxIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(taxIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await prisma.glTax.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((t) => [t.id, t.name]));
}

export function serializeItemRow(l: MoveItemRow, taxNames: ReadonlyMap<string, string>) {
  return {
    id: l.id,
    moveId: l.moveId,
    moveNumber: l.move.number,
    moveState: l.move.state,
    moveRef: l.move.ref,
    origin: l.move.origin,
    journal: { id: l.journalId, code: l.move.journal.code, name: l.move.journal.name },
    seq: l.seq,
    date: fromDbDate(l.date),
    posted: l.posted,
    account: { id: l.accountId, code: l.account.code, name: l.account.name, type: l.account.type },
    label: l.label,
    partnerName: l.partnerName,
    debit: fromMilli(l.debitMilli),
    credit: fromMilli(l.creditMilli),
    balance: fromMilli(l.debitMilli - l.creditMilli),
    currencyCode: l.move.currencyCode,
    customerId: l.customerId,
    vendorId: l.vendorId,
    salesRepId: l.salesRepId,
    analyticAccountId: l.analyticAccountId,
    productId: l.productId,
    quantity: l.quantity,
    taxId: l.taxId,
    taxName: l.taxId ? taxNames.get(l.taxId) ?? null : null,
    taxRole: l.taxRole,
    taxBase: amt(l.taxBaseMilli),
    vatBox: l.vatBox,
    vatAdjustment: l.vatAdjustment,
    dueDate: d(l.dueDate),
  };
}

function serializePosted(p: PostedMove) {
  return {
    id: p.id, number: p.number, journalId: p.journalId, date: p.date, originalDate: p.originalDate,
    lateArrival: p.lateArrival, total: fromMilli(p.totalMilli),
  };
}

// ═══ قائمة القيود وتفصيلها ═══

router.get('/moves', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as ListQuery;
  const where = moveListWhere(tenantId, q);
  const page = pagingOf(q);
  const [rows, total] = await Promise.all([
    prisma.glMove.findMany({ where, select: MOVE_LIST_SELECT, orderBy: moveListOrder(q), skip: page.offset, take: page.limit }),
    prisma.glMove.count({ where }),
  ]);
  res.json({ success: true, data: { rows: rows.map(serializeMoveRow), total, ...page } });
}));

// ═══ خيارات نموذج القيد (دفاتر وضرائب للقراءة) ═══

/**
 * GET /moves/options: ما يحتاجه نموذج القيد لاختيار الدفتر والضريبة بصلاحية القراءة وحدها، فلا يتعطل مستخدم
 * canPostJournals بلا canConfigureLedger (§8.2 قاعدة الظهور). بلا حقول البنك وIBAN وإعدادات الدفتر الأخرى.
 * مسجَّل قبل /moves/:id فلا يُطابَق معرّفاً.
 */
router.get('/moves/options', requireLedgerPermission('canViewLedger'), ledgerHandler(async (_req, res) => {
  const { tenantId } = locals(res);
  const [journals, taxes] = await Promise.all([
    prisma.glJournal.findMany({
      where: { tenantId },
      select: {
        id: true, code: true, name: true, nameEn: true, nameI18n: true, type: true, systemKey: true, sequenceReset: true,
        defaultAccountId: true, useOutstandingAccounts: true, isActive: true, isSystem: true,
      },
      orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
    }),
    prisma.glTax.findMany({
      where: { tenantId },
      select: {
        id: true, key: true, name: true, nameEn: true, nameI18n: true, use: true, rate: true, vatCategory: true,
        priceInclude: true, accountId: true, rcOutputAccountId: true, deductible: true, vatBox: true, isActive: true, isSystem: true,
      },
      orderBy: [{ use: 'asc' }, { rate: 'desc' }, { name: 'asc' }],
    }),
  ]);
  res.json({ success: true, data: { journals, taxes } });
}));

export interface GeneratedFlagLine {
  accountId: string;
  /** تسمية السطر: المولَّد يحمل تسمية التوليد وحدها (generatedLabel) */
  label?: string | null;
  taxRole: string | null;
  taxId: string | null;
  debitMilli: bigint;
  creditMilli: bigint;
  taxBaseMilli: bigint | null;
}

/**
 * تسميات buildManualMoveDraft للسطور المولَّدة: `${name} ${rate}٪`، و`وعاء ${name}`، و`${name} (غير قابلة للخصم)`،
 * و`${name} — مخرجات الاحتساب العكسي`. بالشكل لا باسم الضريبة الحالي، فلا يُفقد التعرّف بعد إعادة تسمية الضريبة.
 */
export function isGeneratedTaxLabel(label: string | null | undefined): boolean {
  const t = (label ?? '').trim();
  return /^\S.*\s\d+(?:\.\d+)?٪$/.test(t) || /^وعاء\s\S/.test(t) || /\S\s\(غير قابلة للخصم\)$/.test(t) || /\S\s—\sمخرجات الاحتساب العكسي$/.test(t);
}

/**
 * علم «مولَّد آلياً» لسطور قيد مخزَّن (السطور لا تحفظه). buildManualMoveDraft يُلحق المولَّد بعد كل سطور
 * المستخدم، فالمولَّد هو الذيل المتصل الذي كل سطر فيه:
 * - TAX/MARKER بضريبة لها سطر BASE، و|taxBaseMilli| فيه يساوي مجموع أوعية تلك الضريبة في جانب واحد
 *   (السلة: الضريبة والجانب، أو معهما حساب التكلفة لغير القابلة للخصم)؛
 * - بتسمية التوليد (isGeneratedTaxLabel) عند توفر التسمية؛
 * - وغير مكرر: البناء لا يولّد سطرين بالمفتاح نفسه (الضريبة، الدور، جانب المبلغ، الوعاء بإشارته، الحساب)، فالأقرب إلى
 *   الذيل هو المولَّد وما قبله بالمفتاح نفسه سطر يدوي (I4) يُحفظ ولو حمل الوعاء نفسه.
 * أول سطر من الذيل لا يطابق يوقف المسح، فيبقى سطر الضريبة اليدوي قابلاً للتحرير ولو وقع قبل المولَّد مباشرة.
 */
export function generatedLineFlags(lines: readonly GeneratedFlagLine[]): boolean[] {
  const sums = new Map<string, bigint>();
  const add = (k: string, v: bigint) => sums.set(k, (sums.get(k) ?? 0n) + v);
  for (const l of lines) {
    if (l.taxRole !== 'BASE' || !l.taxId) continue;
    const side = l.debitMilli > 0n && l.creditMilli === 0n ? 'D' : l.creditMilli > 0n && l.debitMilli === 0n ? 'C' : null;
    if (!side) continue;
    const amount = side === 'D' ? l.debitMilli : l.creditMilli;
    add(`${l.taxId}|${side}|`, amount);
    add(`${l.taxId}|${side}|${l.accountId}`, amount);
  }
  const allowed = new Map<string, Set<bigint>>();
  for (const [k, v] of sums) {
    const taxId = k.slice(0, k.indexOf('|'));
    if (!allowed.has(taxId)) allowed.set(taxId, new Set());
    allowed.get(taxId)!.add(v);
  }
  const out = lines.map(() => false);
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.taxRole !== 'TAX' && l.taxRole !== 'MARKER') break;
    const base = l.taxBaseMilli === null ? null : l.taxBaseMilli < 0n ? -l.taxBaseMilli : l.taxBaseMilli;
    if (!l.taxId || base === null || !allowed.get(l.taxId)?.has(base)) break;
    if (l.label !== undefined && !isGeneratedTaxLabel(l.label)) break;
    const amountSide = l.debitMilli > 0n ? 'D' : l.creditMilli > 0n ? 'C' : '0';
    const key = `${l.taxId}|${l.taxRole}|${amountSide}|${l.taxBaseMilli}|${l.accountId}`;
    if (seen.has(key)) break;
    seen.add(key);
    out[i] = true;
  }
  return out;
}

const MOVE_DETAIL_SELECT = {
  ...MOVE_RECORD_SELECT,
  createdAt: true, updatedAt: true, reviewedBy: true, reviewedAt: true,
  journal: { select: { id: true, code: true, name: true, systemKey: true, type: true, sequenceReset: true, isActive: true } },
  lines: {
    select: { ...MOVE_LINE_ENGINE_SELECT, account: { select: { code: true, name: true, type: true, controlKind: true } } },
    orderBy: { seq: 'asc' as const },
  },
  reversedMove: { select: { id: true, number: true } },
} as const;

router.get('/moves/:id', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const id = String(req.params.id);
  const m = await prisma.glMove.findFirst({ where: { id, tenantId }, select: MOVE_DETAIL_SELECT });
  if (!m) throw new GlNotFoundError('GlMove', id);
  const lineTaxIds = [...new Set(m.lines.map((l) => l.taxId).filter((x): x is string => !!x))];
  const [lineTaxes, noteCount, attachmentCount, draftCopies, activated] = await Promise.all([
    lineTaxIds.length
      ? prisma.glTax.findMany({ where: { tenantId, id: { in: lineTaxIds } }, select: { id: true, name: true, rate: true, priceInclude: true, deductible: true, use: true } })
      : Promise.resolve([]),
    prisma.glMoveNote.count({ where: { tenantId, moveId: id } }),
    prisma.glAttachment.count({ where: { tenantId, entityType: 'MOVE', entityId: id } }),
    prisma.glMove.findMany({ where: { tenantId, draftOfMoveId: id }, select: { id: true, state: true, number: true } }),
    isLedgerActivated(prisma as unknown as AutoPostDb, tenantId),
  ]);
  const kinds = new Map(m.lines.map((l) => [l.accountId, l.account.controlKind]));
  const taxNames = new Map(lineTaxes.map((t) => [t.id, t.name]));
  const taxById = new Map(lineTaxes.map((t) => [t.id, t]));
  const generatedFlags = m.origin === 'MANUAL' ? generatedLineFlags(m.lines) : m.lines.map(() => false);
  // الوعاء المخزَّن صافٍ؛ نموذج إعادة الحفظ يرسل المبلغ الشامل لسطر الضريبة الشاملة (priceIncludeGrossAmounts)
  const grossAmounts = m.origin === 'MANUAL'
    ? priceIncludeGrossAmounts(m.lines, generatedFlags, (tid) => taxById.get(tid), m.currencyDecimals)
    : m.lines.map(() => null);
  const ownership = ownershipOfRecord(m, (accountId) => kinds.get(accountId));

  // المسودة: مخالفات I1–I5/I8 والإقفال الفعّال للتنبيه قبل الترحيل
  let issues: unknown[] = [];
  let lock: { lockDate: LocalDate | null; fields: string[]; locked: boolean } | null = null;
  if (m.state === 'DRAFT') {
    const lc = await loadBuildContext(prisma as unknown as Prisma.TransactionClient, tenantId);
    const draft = moveDraftFromRecord(m);
    issues = collectMoveIssues(draft, lc.ctx, { mode: m.origin === 'AUTO' ? 'SYSTEM' : 'MANUAL' }).issues;
    const s = lc.ctx.settings;
    const eff = effectiveLockDate(
      { salesLockDate: s.salesLockDate, purchaseLockDate: s.purchaseLockDate, taxLockDate: s.taxLockDate, hardLockDate: s.hardLockDate },
      lockScopeOfDraft(draft, lc.ctx),
    );
    lock = { ...eff, locked: eff.lockDate !== null && fromDbDate(m.date) <= eff.lockDate };
  }

  res.json({
    success: true,
    data: {
      id: m.id,
      number: m.number,
      state: m.state,
      moveType: m.moveType,
      origin: m.origin,
      journal: m.journal,
      date: fromDbDate(m.date),
      originalDate: d(m.originalDate),
      lateArrival: m.lateArrival,
      ref: m.ref,
      narration: m.narration,
      currencyCode: m.currencyCode,
      currencyDecimals: m.currencyDecimals,
      total: fromMilli(m.totalMilli),
      customerId: m.customerId,
      vendorId: m.vendorId,
      salesRepId: m.salesRepId,
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      sources: m.sources,
      reversedMove: m.reversedMove,
      reversalReason: m.reversalReason,
      reversal: m.reversal,
      draftOfMoveId: m.draftOfMoveId,
      draftCopies,
      autoPostOn: d(m.autoPostOn),
      reviewState: m.reviewState,
      reviewedBy: m.reviewedBy,
      reviewedAt: m.reviewedAt,
      needsAttention: m.needsAttention,
      attentionReason: m.attentionReason,
      createdBy: m.createdBy,
      createdByImpersonated: m.createdByImpersonated,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      postedAt: m.postedAt,
      postedBy: m.postedBy,
      postedByImpersonated: m.postedByImpersonated,
      secured: m.secureSeq !== null || m.secureHash !== null,
      /** I7: null ⇒ قيد يدوي حرّ (العكس و«إعادة إلى مسودة» متاحان)؛ وإلا المصدر ومسار إلغائه */
      ownership,
      ledgerActivated: activated,
      noteCount,
      attachmentCount,
      issues,
      lock,
      lines: m.lines.map((l, i) => ({
        id: l.id,
        seq: l.seq,
        accountId: l.accountId,
        account: l.account,
        label: l.label,
        debit: fromMilli(l.debitMilli),
        credit: fromMilli(l.creditMilli),
        customerId: l.customerId,
        vendorId: l.vendorId,
        salesRepId: l.salesRepId,
        partnerName: l.partnerName,
        analyticAccountId: l.analyticAccountId,
        productId: l.productId,
        quantity: l.quantity,
        taxId: l.taxId,
        taxName: l.taxId ? taxNames.get(l.taxId) ?? null : null,
        taxRole: l.taxRole,
        taxBase: amt(l.taxBaseMilli),
        vatBox: l.vatBox,
        vatAdjustment: l.vatAdjustment,
        dueDate: d(l.dueDate),
        posted: l.posted,
        /** مولَّد آلياً: يُحذف من جسم إعادة الحفظ (أو يُرسَل بـgenerated=true) ليُعاد توليده؛ غيره يُرسَل كما هو */
        generated: generatedFlags[i],
        /**
         * سطر وعاء بضريبة شاملة (priceInclude): المبلغ الشامل الذي يُرسَل بدل debit/credit الصافي عند إعادة الحفظ أو
         * التكرار دون تعديل المبلغ، فيُعاد بناء الوعاء والضريبة كما هما. null لغيره.
         */
        gross: grossAmounts[i] === null ? null : fromMilli(grossAmounts[i] as bigint),
      })),
    },
  });
}));

// ═══ المسودات: إنشاء وتحرير ═══

const amountInput = z.union([z.string().max(40), z.number()]).nullish();
const optId = z.string().max(64).nullish();

const manualLineSchema = z.object({
  accountId: z.string().min(1).max(64),
  label: z.string().max(500).nullish(),
  debit: amountInput,
  credit: amountInput,
  customerId: optId,
  vendorId: optId,
  salesRepId: optId,
  partnerName: z.string().max(200).nullish(),
  analyticAccountId: optId,
  productId: optId,
  quantity: z.number().finite().nullish(),
  taxId: optId,
  vatBox: z.string().max(20).nullish(),
  dueDate: z.string().max(10).nullish(),
  taxRole: z.enum(['BASE', 'TAX', 'MARKER']).nullish(),
  generated: z.boolean().nullish(),
  taxBaseMilli: amountInput,
});

export const manualMoveSchema = z.object({
  journalId: z.string().min(1).max(64),
  date: z.string().max(10),
  ref: z.string().max(200).nullish(),
  narration: z.string().max(2000).nullish(),
  autoPostOn: z.string().max(10).nullish(),
  lines: z.array(manualLineSchema).max(500),
});

type ManualMoveBody = z.infer<typeof manualMoveSchema>;

function requiredDate(v: string, field: string): LocalDate {
  if (!isLocalDate(v)) throw new LedgerHttpError(400, 'تاريخ غير صالح', { reason: 'INVALID_DATE', field });
  return v;
}

type LineRefField = 'customerId' | 'vendorId' | 'salesRepId' | 'productId' | 'analyticAccountId';
type LineRefs = Partial<Record<LineRefField, string | null | undefined>> & { generated?: boolean | null };

/** نماذج المراجع في السطور. analyticAccountId بلا نموذج في M2 ⇒ أي قيمة غير فارغة غير موجودة (TODO(M11): GlAnalyticAccount). */
export const LINE_REF_ENTITIES: Record<LineRefField, string> = {
  customerId: 'Customer', vendorId: 'GlVendor', salesRepId: 'SalesRep', productId: 'Product', analyticAccountId: 'GlAnalyticAccount',
};

interface LineRefModel {
  findMany(args: { where: { tenantId: string; id: { in: string[] } }; select: { id: true } }): Promise<{ id: string }[]>;
}
export interface LineRefDb { customer: LineRefModel; glVendor: LineRefModel; salesRep: LineRefModel; product: LineRefModel }

/**
 * العزل (§9.4): كل معرّف عميل أو مورّد أو مندوب أو منتج أو حساب تحليلي في سطور القيد اليدوي للشركة، وإلا 404
 * (GlNotFoundError) قبل أي كتابة. السطور المولَّدة (generated=true) مستثناة لأنها تُهمل.
 */
export async function assertLineRefsOwned(db: LineRefDb, tenantId: string, lines: readonly LineRefs[]): Promise<void> {
  const sets: Record<LineRefField, Set<string>> = {
    customerId: new Set(), vendorId: new Set(), salesRepId: new Set(), productId: new Set(), analyticAccountId: new Set(),
  };
  const fields = Object.keys(sets) as LineRefField[];
  for (const l of lines) {
    if (l.generated === true) continue;
    for (const f of fields) {
      const v = l[f];
      const t = typeof v === 'string' ? v.trim() : '';
      if (t) sets[f].add(t);
    }
  }
  for (const id of sets.analyticAccountId) throw new GlNotFoundError(LINE_REF_ENTITIES.analyticAccountId, id);
  const q = (ids: Set<string>, model: LineRefModel) =>
    ids.size ? model.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true } }) : Promise.resolve([]);
  const [customers, vendors, reps, products] = await Promise.all([
    q(sets.customerId, db.customer), q(sets.vendorId, db.glVendor), q(sets.salesRepId, db.salesRep), q(sets.productId, db.product),
  ]);
  const found: [LineRefField, { id: string }[]][] = [['customerId', customers], ['vendorId', vendors], ['salesRepId', reps], ['productId', products]];
  for (const [f, rows] of found) {
    const have = new Set(rows.map((r) => r.id));
    for (const id of sets[f]) if (!have.has(id)) throw new GlNotFoundError(LINE_REF_ENTITIES[f], id);
  }
}

/** يبني المسودة اليدوية ويحفظها في معاملة واحدة (إنشاء بلا moveId، واستبدال مع moveId). */
async function saveManualDraft(tenantId: string, actor: GlActor, body: ManualMoveBody, moveId?: string) {
  const date = requiredDate(body.date, 'date');
  const autoPostOn = body.autoPostOn ? requiredDate(body.autoPostOn, 'autoPostOn') : null;
  body.lines.forEach((l, i) => { if (l.dueDate) requiredDate(l.dueDate, `lines.${i}.dueDate`); });

  return prisma.$transaction(async (tx) => {
    let draftOfMoveId: string | null = null;
    if (moveId) {
      const existing = await tx.glMove.findFirst({ where: { id: moveId, tenantId }, select: { id: true, draftOfMoveId: true } });
      if (!existing) throw new GlNotFoundError('GlMove', moveId);
      draftOfMoveId = existing.draftOfMoveId;
    }
    const lc = await loadBuildContext(tx, tenantId);
    const journal = lc.journalById.get(body.journalId);
    if (!journal) throw new GlNotFoundError('GlJournal', body.journalId);
    if (!journal.isActive) throw new LedgerError('LEDGER_ACCOUNT_ARCHIVED', { reason: 'JOURNAL_ARCHIVED', journalId: journal.id });
    // العزل (§9.4): كل حساب في السطور للشركة
    body.lines.forEach((l, lineIndex) => {
      if (l.generated === true) return; // مولَّد يُهمل ويُعاد توليده
      if (!lc.accountById.has(l.accountId)) {
        throw new LedgerError('LEDGER_ACCOUNT_NOT_FOUND', { reason: 'ACCOUNT_NOT_FOUND', lineIndex, accountId: l.accountId });
      }
    });
    // العزل (§9.4): العميل والمورّد والمندوب والمنتج والتحليلي للشركة
    await assertLineRefsOwned(tx, tenantId, body.lines);
    const built = buildManualMoveDraft(
      { journal, date, ref: body.ref ?? null, narration: body.narration ?? null, lines: body.lines as ManualLineInput[] },
      lc.ctx,
    );
    const rows = draftRowsFromMoveDraft(built.draft, lc.ctx, { tenantId, journalId: journal.id, actor, autoPostOn, draftOfMoveId });
    const saved = await saveDraftMove(tx, { tenantId, actor, rows, moveId: moveId ?? null });
    return {
      id: saved.id,
      created: saved.created,
      issues: built.issues,
      generatedLineIndexes: built.generatedLineIndexes,
      totals: { debit: fromMilli(built.totalDebitMilli), credit: fromMilli(built.totalCreditMilli) },
      lock: built.lock,
    };
  }, POST_TX_OPTIONS);
}

router.post('/moves', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const body = manualMoveSchema.parse(req.body);
  const data = await saveManualDraft(locals(res).tenantId, actorOf(req, res), body);
  res.status(201).json({ success: true, data });
}));

router.put('/moves/:id', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const body = manualMoveSchema.parse(req.body);
  const data = await saveManualDraft(locals(res).tenantId, actorOf(req, res), body, String(req.params.id));
  res.json({ success: true, data });
}));

// ═══ حذف المسودة (JE‑05b) ═══

const idsSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1) });

function bulkIds(body: unknown): string[] {
  const ids = normalizeIds(idsSchema.parse(body).ids);
  if (ids.length > BULK_MOVE_IDS_LIMIT) {
    throw new LedgerHttpError(400, `الحد الأقصى ${BULK_MOVE_IDS_LIMIT} قيد في الإجراء الواحد`, { reason: 'TOO_MANY_IDS', limit: BULK_MOVE_IDS_LIMIT });
  }
  return ids;
}

router.delete('/moves/:id', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const actor = actorOf(req, res);
  const moveId = String(req.params.id);
  const data = await prisma.$transaction((tx) => deleteDraftMove(tx, { tenantId, moveId, actor }), POST_TX_OPTIONS);
  res.json({ success: true, data });
}));

/** كل شيء أو لا شيء: أي رفض ⇒ لا يُحذف شيء ويُعاد rejected بسبب كلٍّ منها. */
router.post('/moves/delete-drafts', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const actor = actorOf(req, res);
  const ids = bulkIds(req.body);
  const data = await prisma.$transaction((tx) => deleteDraftMoves(tx, { tenantId, actor, ids }), POST_TX_OPTIONS);
  res.json({ success: true, data });
}));

// ═══ الترحيل ═══

/** §6.1: الترحيل قبل activatedAt ⇒ 409 LEDGER_NOT_SETUP (الفحص هنا لا في post.ts). */
async function assertLedgerActivated(tenantId: string): Promise<void> {
  if (!(await isLedgerActivated(prisma as unknown as AutoPostDb, tenantId))) {
    throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'NOT_ACTIVATED' });
  }
}

router.post('/moves/post-drafts', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const ids = bulkIds(req.body);
  // قبل التفعيل: كل معرّف في rejected بـLEDGER_NOT_SETUP؛ وبعده كل قيد في معاملته
  const data = await postDraftsBatch(prisma as unknown as AutoPostDb, { tenantId, actor: actorOf(req, res), ids });
  res.json({ success: true, data });
}));

router.post('/moves/:id/post', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  await assertLedgerActivated(tenantId);
  const actor = actorOf(req, res);
  const moveId = String(req.params.id);
  const posted = await prisma.$transaction((tx) => postDraftMove(tx, { tenantId, actor, moveId }), POST_TX_OPTIONS);
  res.json({ success: true, data: serializePosted(posted) });
}));

// ═══ المراجعة ═══

export const REVIEW_STATES = ['NONE', 'REVIEWED', 'FLAGGED'] as const;
const reviewStateSchema = z.enum(REVIEW_STATES);

/** تعليم المراجعة (مسموح على المرحَّل غير المؤمَّن، §2.4) — تدقيق MOVE_REVIEW لكل قيد. */
async function reviewMoves(tenantId: string, actor: GlActor, ids: readonly string[], reviewState: (typeof REVIEW_STATES)[number]) {
  return prisma.$transaction(async (tx) => {
    const found = await tx.glMove.findMany({
      where: { tenantId, id: { in: [...ids] } },
      select: { id: true, number: true, reviewState: true, secureSeq: true, secureHash: true },
    });
    const byId = new Map(found.map((m) => [m.id, m]));
    const updated: string[] = [];
    const rejected: { id: string; code: string }[] = [];
    const reviewedBy = reviewState === 'NONE' ? null : actor.actorId;
    const reviewedAt = reviewState === 'NONE' ? null : new Date();
    for (const id of ids) {
      const m = byId.get(id);
      if (!m) { rejected.push({ id, code: 'NOT_FOUND' }); continue; }
      if (m.secureSeq !== null || m.secureHash !== null) { rejected.push({ id, code: 'LEDGER_SECURED_MOVE' }); continue; }
      const r = await tx.glMove.updateMany({
        where: { id, tenantId, secureSeq: null, secureHash: null },
        data: { reviewState, reviewedBy, reviewedAt },
      });
      if (r.count !== 1) { rejected.push({ id, code: 'LEDGER_SECURED_MOVE' }); continue; }
      await appendAudit(tx, {
        tenantId, actor, action: 'MOVE_REVIEW', entityType: 'MOVE', entityId: id,
        summary: `حالة مراجعة القيد ${m.number ?? '(مسودة)'}: ${reviewState}`,
        before: { reviewState: m.reviewState }, after: { reviewState },
      });
      updated.push(id);
    }
    return { updated, rejected };
  }, POST_TX_OPTIONS);
}

router.post('/moves/review', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const ids = bulkIds(req.body);
  const reviewState = reviewStateSchema.parse(req.body?.reviewState);
  const data = await reviewMoves(locals(res).tenantId, actorOf(req, res), ids, reviewState);
  res.json({ success: true, data });
}));

router.post('/moves/:id/review', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const id = String(req.params.id);
  const reviewState = reviewStateSchema.parse(req.body?.reviewState);
  const r = await reviewMoves(locals(res).tenantId, actorOf(req, res), [id], reviewState);
  const rej = r.rejected[0];
  if (rej?.code === 'NOT_FOUND') throw new GlNotFoundError('GlMove', id);
  if (rej) throw new LedgerError('LEDGER_SECURED_MOVE', { moveId: id });
  res.json({ success: true, data: { id, reviewState } });
}));

// ═══ العكس و«إعادة إلى مسودة» (اليدوية وحدها، I7، G5) ═══

router.post('/moves/:id/reverse', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const reason = assertReversalReason(req.body?.reason);
  const requestedDate = dateParam(req.body?.date, 'date') ?? null;
  await assertLedgerActivated(tenantId);
  const actor = actorOf(req, res);
  const moveId = String(req.params.id);
  const r = await prisma.$transaction(async (tx) => {
    await assertManualOwned(tx, tenantId, moveId);
    return reverseMove(tx, { tenantId, moveId, actor, reason, mode: 'MANUAL', requestedDate });
  }, POST_TX_OPTIONS);
  res.json({
    success: true,
    data: {
      alreadyReversed: r.alreadyReversed,
      original: r.original,
      reversal: { id: r.reversal.id, number: r.reversal.number, date: r.reversal.date },
    },
  });
}));

router.post('/moves/:id/reset-draft', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const reason = assertReversalReason(req.body?.reason);
  const requestedDate = dateParam(req.body?.date, 'date') ?? null;
  await assertLedgerActivated(tenantId);
  const actor = actorOf(req, res);
  const moveId = String(req.params.id);
  const r = await prisma.$transaction(async (tx) => {
    await assertManualOwned(tx, tenantId, moveId);
    return resetDraft(tx, { tenantId, moveId, actor, reason, requestedDate });
  }, POST_TX_OPTIONS);
  res.json({
    success: true,
    data: { reversal: { id: r.reversal.id, number: r.reversal.number, date: r.reversal.date }, draft: r.draft },
  });
}));

// ═══ الملاحظات والتتبّع (JE‑10) ═══

const noteSchema = z.object({ body: z.string().trim().min(1).max(4000) });

router.post('/moves/:id/notes', requireLedgerPermission('canPostJournals'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const actor = actorOf(req, res);
  const moveId = String(req.params.id);
  const { body } = noteSchema.parse(req.body);
  const note = await prisma.$transaction(async (tx) => {
    const m = await tx.glMove.findFirst({ where: { id: moveId, tenantId }, select: { id: true, number: true } });
    if (!m) throw new GlNotFoundError('GlMove', moveId);
    const created = await tx.glMoveNote.create({
      data: { tenantId, moveId, authorId: actor.actorId, authorName: actor.actorName ?? null, body },
      select: { id: true, authorId: true, authorName: true, body: true, createdAt: true },
    });
    await appendAudit(tx, {
      tenantId, actor, action: 'MOVE_NOTE', entityType: 'MOVE', entityId: moveId,
      summary: `ملاحظة على القيد ${m.number ?? '(مسودة)'}`, after: { noteId: created.id, body },
    });
    return created;
  }, POST_TX_OPTIONS);
  res.status(201).json({ success: true, data: note });
}));

router.get('/moves/:id/notes', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const moveId = String(req.params.id);
  const m = await prisma.glMove.findFirst({ where: { id: moveId, tenantId }, select: { id: true } });
  if (!m) throw new GlNotFoundError('GlMove', moveId);
  const [notes, tracking] = await Promise.all([
    prisma.glMoveNote.findMany({
      where: { tenantId, moveId }, orderBy: { createdAt: 'asc' },
      select: { id: true, authorId: true, authorName: true, body: true, createdAt: true },
    }),
    // التتبّع مشتق من سجل التدقيق (JE‑10) — بلا لقطات قبل/بعد
    prisma.glAuditLog.findMany({
      where: { tenantId, entityType: 'MOVE', entityId: moveId }, orderBy: { seq: 'asc' }, take: 200,
      select: { seq: true, at: true, action: true, actorType: true, actorId: true, actorName: true, impersonated: true, summary: true },
    }),
  ]);
  res.json({ success: true, data: { notes, tracking } });
}));

// ═══ المرفقات (JE‑09، §3.9، §9.4) ═══

export const ATTACHMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

const KB = 1024;
const MB = 1024 * KB;
/** سقوف حتى قرار D5 (§3.9). */
export const ATTACHMENT_CAPS = {
  pdfBytes: 1 * MB,
  imageBytes: 400 * KB,
  monthlyBytes: 5 * MB,
  totalBytes: 50 * MB,
} as const;

/** نوع الملف من بايتاته الأولى: `%PDF-`، JPEG (FF D8 FF)، PNG (89 50 4E 47 0D 0A 1A 0A). */
export function sniffAttachmentMime(buf: Uint8Array): AttachmentMime | null {
  const at = (i: number) => buf[i];
  if (buf.length >= 5 && at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d) return 'application/pdf';
  if (buf.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => at(i) === b)) return 'image/png';
  return null;
}

export interface AttachmentCapViolation {
  reason: 'FILE_TOO_LARGE' | 'MONTHLY_QUOTA' | 'TOTAL_QUOTA' | 'EMPTY_FILE';
  capBytes: number;
  sizeBytes: number;
  usedBytes?: number;
}

/** فحص السقوف (صرفة): الملف ثم الشهر ثم الإجمالي. */
export function attachmentCapViolation(input: {
  mimeType: AttachmentMime; sizeBytes: number; monthUsedBytes: number; totalUsedBytes: number;
}): AttachmentCapViolation | null {
  const { mimeType, sizeBytes } = input;
  if (sizeBytes <= 0) return { reason: 'EMPTY_FILE', capBytes: 0, sizeBytes };
  const fileCap = mimeType === 'application/pdf' ? ATTACHMENT_CAPS.pdfBytes : ATTACHMENT_CAPS.imageBytes;
  if (sizeBytes > fileCap) return { reason: 'FILE_TOO_LARGE', capBytes: fileCap, sizeBytes };
  if (input.monthUsedBytes + sizeBytes > ATTACHMENT_CAPS.monthlyBytes) {
    return { reason: 'MONTHLY_QUOTA', capBytes: ATTACHMENT_CAPS.monthlyBytes, sizeBytes, usedBytes: input.monthUsedBytes };
  }
  if (input.totalUsedBytes + sizeBytes > ATTACHMENT_CAPS.totalBytes) {
    return { reason: 'TOTAL_QUOTA', capBytes: ATTACHMENT_CAPS.totalBytes, sizeBytes, usedBytes: input.totalUsedBytes };
  }
  return null;
}

/** اسم ملف آمن للتخزين والترويسة: بلا مسار ولا محارف تحكم، وبحد 200 محرف. */
export function sanitizeFileName(name: unknown, mimeType: AttachmentMime): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(0, 200);
  if (clean) return clean;
  return mimeType === 'application/pdf' ? 'attachment.pdf' : mimeType === 'image/png' ? 'attachment.png' : 'attachment.jpg';
}

export const ATTACHMENT_META_SELECT = {
  id: true, entityType: true, entityId: true, fileName: true, mimeType: true, sizeBytes: true, sha256: true,
  uploadedBy: true, createdAt: true,
} as const;

const ATTACHMENT_LOCK_PREFIX = 'gl-attach:';

const attachmentJsonSchema = z.object({
  fileName: z.string().max(500),
  mimeType: z.string().max(100),
  contentBase64: z.string().max(Math.ceil((ATTACHMENT_CAPS.pdfBytes * 4) / 3) + 1024),
});

/** الجسم: خام (Content-Type أحد الأنواع الثلاثة + ترويسة X-File-Name مرمّزة URI) أو JSON {fileName, mimeType, contentBase64}. */
function readAttachmentUpload(req: AuthRequest): { fileName: unknown; declaredMime: string; bytes: Buffer } {
  if (Buffer.isBuffer(req.body)) {
    let fileName: unknown = req.get('x-file-name') ?? '';
    try { fileName = decodeURIComponent(String(fileName)); } catch { /* يبقى كما هو */ }
    return { fileName, declaredMime: (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), bytes: req.body };
  }
  const j = attachmentJsonSchema.parse(req.body);
  const b64 = j.contentBase64.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new LedgerHttpError(400, 'محتوى المرفق غير صالح', { reason: 'INVALID_BASE64' });
  }
  return { fileName: j.fileName, declaredMime: j.mimeType.split(';')[0].trim().toLowerCase(), bytes: Buffer.from(b64, 'base64') };
}

const rawAttachmentBody = express.raw({ type: [...ATTACHMENT_MIME_TYPES], limit: ATTACHMENT_CAPS.pdfBytes + 64 * KB });

router.post('/moves/:id/attachments', requireLedgerPermission('canPostJournals'), rawAttachmentBody, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const actor = actorOf(req, res);
  const moveId = String(req.params.id);
  const upload = readAttachmentUpload(req);
  const sniffed = sniffAttachmentMime(upload.bytes);
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(upload.declaredMime) || !sniffed || sniffed !== upload.declaredMime) {
    throw new LedgerHttpError(415, 'نوع الملف غير مسموح والمسموح PDF أو JPEG أو PNG', {
      reason: 'ATTACHMENT_TYPE_NOT_ALLOWED', declaredMime: upload.declaredMime, detectedMime: sniffed, allowed: ATTACHMENT_MIME_TYPES,
    });
  }
  const mimeType = sniffed;
  const fileName = sanitizeFileName(upload.fileName, mimeType);
  const sizeBytes = upload.bytes.length;
  const sha256 = crypto.createHash('sha256').update(upload.bytes).digest('hex');

  const created = await prisma.$transaction(async (tx) => {
    // قفل الترحيل أولاً (ترتيب ثابت gl-post ثم gl-attach): حذف المسودة يأخذه قبل حذف مرفقاتها وقيدها،
    // فلا يرى الرفع قيداً في طور الحذف فيُدرج مرفقاً يتيماً يستهلك الحصة (§6.1، §3.9)
    await acquirePostLock(tx, tenantId);
    // قفل حصّة المرفقات للشركة: رفعان متزامنان لا يتجاوزان السقف معاً
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ATTACHMENT_LOCK_PREFIX + tenantId}::text))`;
    const m = await tx.glMove.findFirst({ where: { id: moveId, tenantId }, select: { id: true, number: true } });
    if (!m) throw new GlNotFoundError('GlMove', moveId);
    const settings = await tx.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } });
    const tz = settings?.timezone || DEFAULT_TIMEZONE;
    const monthStart = zonedStartOfDay(startOfMonth(todayLocal(new Date(), tz)), tz);
    const [month, total] = await Promise.all([
      tx.glAttachment.aggregate({ where: { tenantId, createdAt: { gte: monthStart } }, _sum: { sizeBytes: true } }),
      tx.glAttachment.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } }),
    ]);
    const violation = attachmentCapViolation({
      mimeType, sizeBytes, monthUsedBytes: month._sum.sizeBytes ?? 0, totalUsedBytes: total._sum.sizeBytes ?? 0,
    });
    if (violation) {
      if (violation.reason === 'EMPTY_FILE') throw new LedgerHttpError(400, 'الملف فارغ', { reason: 'EMPTY_FILE' });
      throw new LedgerError('LEDGER_ATTACHMENT_QUOTA', { ...violation });
    }
    const att = await tx.glAttachment.create({
      data: {
        tenantId, entityType: 'MOVE', entityId: moveId, fileName, mimeType, sizeBytes, sha256, uploadedBy: actor.actorId,
        blob: { create: { tenantId, bytes: upload.bytes } },
      },
      select: ATTACHMENT_META_SELECT,
    });
    await appendAudit(tx, {
      tenantId, actor, action: 'ATTACHMENT_ADD', entityType: 'MOVE', entityId: moveId,
      summary: `إرفاق ${fileName} بالقيد ${m.number ?? '(مسودة)'}`,
      after: { attachmentId: att.id, fileName, mimeType, sizeBytes, sha256 },
    });
    return att;
  }, POST_TX_OPTIONS);
  res.status(201).json({ success: true, data: created });
}));

router.get('/moves/:id/attachments', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const moveId = String(req.params.id);
  const m = await prisma.glMove.findFirst({ where: { id: moveId, tenantId }, select: { id: true } });
  if (!m) throw new GlNotFoundError('GlMove', moveId);
  const rows = await prisma.glAttachment.findMany({
    where: { tenantId, entityType: 'MOVE', entityId: moveId }, orderBy: { createdAt: 'asc' }, select: ATTACHMENT_META_SELECT,
  });
  res.json({ success: true, data: rows });
}));

/** رأس Content-Disposition: inline باسم ASCII احتياطي وfilename* بـUTF‑8. */
export function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

router.get('/moves/:id/attachments/:attachmentId', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const moveId = String(req.params.id);
  const attachmentId = String(req.params.attachmentId);
  const att = await prisma.glAttachment.findFirst({
    where: { id: attachmentId, tenantId, entityType: 'MOVE', entityId: moveId },
    select: { ...ATTACHMENT_META_SELECT, blob: { select: { bytes: true } } },
  });
  if (!att?.blob) throw new GlNotFoundError('GlAttachment', attachmentId);
  const bytes = Buffer.from(att.blob.bytes);
  res.setHeader('Content-Type', att.mimeType);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Content-Disposition', inlineDisposition(att.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(bytes);
}));

// ═══ بنود اليومية ═══

router.get('/items', requireLedgerPermission('canViewLedger'), ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const q = req.query as ListQuery;
  const where = itemListWhere(tenantId, q);
  const page = pagingOf(q);
  const [rows, total, sums] = await Promise.all([
    prisma.glMoveLine.findMany({ where, select: MOVE_ITEM_SELECT, orderBy: itemListOrder(q), skip: page.offset, take: page.limit }),
    prisma.glMoveLine.count({ where }),
    prisma.glMoveLine.aggregate({ where, _sum: { debitMilli: true, creditMilli: true } }),
  ]);
  const taxNames = await taxNamesFor(tenantId, rows.map((r) => r.taxId));
  const debit = sums._sum.debitMilli ?? 0n;
  const credit = sums._sum.creditMilli ?? 0n;
  res.json({
    success: true,
    data: {
      rows: rows.map((r) => serializeItemRow(r, taxNames)),
      total,
      ...page,
      totals: { debit: fromMilli(debit), credit: fromMilli(credit), balance: fromMilli(debit - credit) },
    },
  });
}));

export default router;
