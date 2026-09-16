import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, ledgerActor, type GlActor, type GlTx } from '../../services/gl/audit';
import { acquirePostLock, assertJournalNumberingEditable } from '../../services/gl/post';
import { GlNotFoundError } from '../../services/gl/resolve';
import { seedTemplate } from '../../services/gl/seed';
import { assertArabicName, hasArabicLetter } from '../../services/gl/names';
import { JOURNAL_CODE_RE } from '../../services/gl/sequence';
import { MAPPING_KEY_ALLOWED_TYPES, MAPPING_KEY_CONTROL_KIND, SA_6D_ACCOUNT_GROUPS } from '../../services/gl/coa/sa';
import { addMonths, compareLocalDate, daysInMonth, fromDbDate, isLocalDate, isValidTimeZone, toDbDate } from '../../services/gl/dates';
import {
  ACCOUNT_TYPES, ACCOUNT_TYPE_NATURAL_SIDE, CASH_FLOW_TAGS, CASH_INVOICE_ROUTINGS, INVENTORY_MODES, JOURNAL_TYPES,
  LedgerError, MAPPING_KEYS, SEQUENCE_RESETS, TAX_DEADLINE_RULES, TAX_PERIODICITIES, TAX_USES, VAT_BOXES_SA, VAT_CATEGORIES,
  type AccountType, type MappingKey, type TemplateKey,
} from '../../services/gl/types';

/**
 * تهيئة الدفاتر — `/api/ledger` (M2، ملحق أ، §3.2، §4، §8.4، §8.7، §9.2–§9.5):
 * الحسابات (قائمة وتجميع وشجرة واستيراد وأرشفة)، الدفاتر، الضرائب، الربط، الإعدادات وزرع القالب،
 * السنوات المالية، الوسوم.
 *
 * - يُركَّب داخل routes/ledger/index.ts بعد سلسلة الحراسة، فـres.locals.ledger مضبوط دائماً.
 * - الصلاحيات: GET للحسابات وGET /fiscal-years بـcanViewLedger، وكل ما عداها canConfigureLedger.
 * - العزل (§9.4): كل استعلام بـtenantId من السياق، وكل معرّف مُدخل يُتحقق من انتمائه للشركة وإلا 404.
 * - كل كتابة تُدوَّن في GlAuditLog داخل معاملتها (§9.3)، بوسم الانتحال من ledgerActor.
 * - الأسماء عربية إلزاماً (G7)، وتعديل name أو nameEn يضع nameI18n = null (§8.7).
 * - الدفتر: code وsequenceReset مقفلان بعد أول ترحيل، وتصادم الرمز 409 (G2، I6) تحت قفل gl-post.
 */
const router = Router();

const VIEW = requireLedgerPermission('canViewLedger');
const CONFIGURE = requireLedgerPermission('canConfigureLedger');
const TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

// ═══ مساعدات ═══

const ledgerOf = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(ledgerOf(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });
const dateOut = (d: Date | null | undefined): string | null => (d ? fromDbDate(d) : null);
const localDateSchema = z.string().refine(isLocalDate, 'تاريخ غير صالح YYYY-MM-DD');
const boolQuery = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).optional()
  .transform((v) => v === true || v === 'true' || v === '1');
const csv = (v: unknown): string[] =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? v.map(String) : [];
const milliToNumber = (m: bigint): number => Number(m) / 1000;

/** يحوّل قائمة الحقول المتغيّرة فعلاً بين صفين إلى {before, after} للتدقيق. */
function diffOf(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const x = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k];
    const y = after[k] instanceof Date ? (after[k] as Date).toISOString() : after[k];
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) { b[k] = before[k] ?? null; a[k] = after[k] ?? null; }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

async function requireAccount(db: GlTx | typeof prisma, tenantId: string, id: string) {
  const a = await db.glAccount.findFirst({ where: { id, tenantId } });
  if (!a) throw new GlNotFoundError('GlAccount', id);
  return a;
}

/** حساب مُدخل مرجعاً (افتراضي دفتر، حساب ضريبة…): للشركة ونشط. */
async function requireActiveAccountRef(db: GlTx, tenantId: string, id: string | null | undefined, field: string) {
  if (!id) return;
  const a = await db.glAccount.findFirst({ where: { id, tenantId }, select: { id: true, isActive: true } });
  if (!a) throw new GlNotFoundError('GlAccount', id);
  if (!a.isActive) throw new LedgerError('LEDGER_ACCOUNT_ARCHIVED', { accountId: id, field });
}

async function requireJournalRef(db: GlTx, tenantId: string, id: string | null | undefined) {
  if (!id) return;
  const j = await db.glJournal.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!j) throw new GlNotFoundError('GlJournal', id);
}

async function requireTagIds(db: GlTx, tenantId: string, tagIds: readonly string[]) {
  const uniq = [...new Set(tagIds)];
  if (!uniq.length) return uniq;
  const found = await db.glAccountTag.findMany({ where: { tenantId, id: { in: uniq } }, select: { id: true } });
  const have = new Set(found.map((t) => t.id));
  const missing = uniq.find((id) => !have.has(id));
  if (missing) throw new GlNotFoundError('GlAccountTag', missing);
  return uniq;
}

// ═══ الحسابات (COA‑01…09) ═══

type AccountRow = Prisma.GlAccountGetPayload<object>;

function accountOut(a: AccountRow, extra: { tagIds?: string[]; hasMoves?: boolean; balance?: number } = {}) {
  return {
    id: a.id, code: a.code, name: a.name, nameEn: a.nameEn, nameI18n: a.nameI18n, description: a.description,
    type: a.type, reconcile: a.reconcile, isActive: a.isActive, isSystem: a.isSystem, controlKind: a.controlKind,
    currencyCode: a.currencyCode, cashFlowTag: a.cashFlowTag, templateRef: a.templateRef,
    createdAt: a.createdAt, updatedAt: a.updatedAt, ...extra,
  };
}

const TYPE_FILTERS: Record<string, readonly AccountType[]> = {
  debit: ACCOUNT_TYPES.filter((t) => ACCOUNT_TYPE_NATURAL_SIDE[t] === 'DEBIT'),
  credit: ACCOUNT_TYPES.filter((t) => ACCOUNT_TYPE_NATURAL_SIDE[t] === 'CREDIT'),
  asset: ACCOUNT_TYPES.filter((t) => t.startsWith('asset_')),
  liability: ACCOUNT_TYPES.filter((t) => t.startsWith('liability_')),
  equity: ACCOUNT_TYPES.filter((t) => t.startsWith('equity')),
  income: ACCOUNT_TYPES.filter((t) => t.startsWith('income')),
  expense: ACCOUNT_TYPES.filter((t) => t.startsWith('expense')),
};

const accountListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  type: z.string().optional(),
  /** debit|credit|equity|asset|liability|income|expense|hasMoves|archived|custom (COA‑06)، مفصولة بفواصل */
  filter: z.string().optional(),
  groupBy: z.enum(['type']).optional(),
  includeArchived: boolQuery,
  prefix: z.string().regex(/^\d{1,10}$/).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(80),
});

router.get('/accounts', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const q = accountListQuery.parse(req.query);
  const filters = new Set(csv(q.filter));
  const types = csv(q.type).filter((t): t is AccountType => (ACCOUNT_TYPES as readonly string[]).includes(t));

  const where: Prisma.GlAccountWhereInput = { tenantId };
  const and: Prisma.GlAccountWhereInput[] = [];
  // فلاتر الجانب/الفئة تُجمع بـOR بينها (نمط Odoo)، ثم AND مع النوع الصريح
  const typeGroups = [...filters].filter((f) => TYPE_FILTERS[f]);
  if (typeGroups.length) and.push({ type: { in: [...new Set(typeGroups.flatMap((f) => TYPE_FILTERS[f]))] } });
  if (types.length) and.push({ type: { in: types } });
  if (filters.has('archived')) and.push({ isActive: false });
  else if (!q.includeArchived) and.push({ isActive: true });
  if (filters.has('custom')) and.push({ templateRef: null });
  if (q.prefix) and.push({ code: { startsWith: q.prefix } });
  if (q.search) {
    and.push({ OR: [
      { code: { startsWith: q.search } },
      { name: { contains: q.search, mode: 'insensitive' } },
      { nameEn: { contains: q.search, mode: 'insensitive' } },
      { description: { contains: q.search, mode: 'insensitive' } },
    ] });
  }
  if (filters.has('hasMoves')) {
    const used = await prisma.glMoveLine.groupBy({ by: ['accountId'], where: { tenantId } });
    and.push({ id: { in: used.map((u) => u.accountId) } });
  }
  if (and.length) where.AND = and;

  const [total, rows, groups] = await Promise.all([
    prisma.glAccount.count({ where }),
    prisma.glAccount.findMany({ where, orderBy: { code: 'asc' }, skip: q.offset, take: q.limit, include: { tagLinks: { select: { tagId: true } } } }),
    q.groupBy === 'type'
      ? prisma.glAccount.groupBy({ by: ['type'], where, _count: { _all: true }, orderBy: { type: 'asc' } })
      : Promise.resolve(null),
  ]);
  const ids = rows.map((r) => r.id);
  const [lineCounts, balances] = ids.length
    ? await Promise.all([
      prisma.glMoveLine.groupBy({ by: ['accountId'], where: { tenantId, accountId: { in: ids } }, _count: { _all: true } }),
      prisma.glPeriodBalance.groupBy({ by: ['accountId'], where: { tenantId, accountId: { in: ids } }, _sum: { debitMilli: true, creditMilli: true } }),
    ])
    : [[], []];
  const moved = new Set(lineCounts.map((l) => l.accountId));
  const bal = new Map(balances.map((b) => [b.accountId, (b._sum.debitMilli ?? 0n) - (b._sum.creditMilli ?? 0n)]));

  res.json({
    success: true,
    data: rows.map(({ tagLinks, ...a }) => accountOut(a, {
      tagIds: tagLinks.map((l) => l.tagId), hasMoves: moved.has(a.id), balance: milliToNumber(bal.get(a.id) ?? 0n),
    })),
    pagination: { total, offset: q.offset, limit: q.limit },
    ...(groups ? { groups: groups.map((g) => ({ type: g.type, count: g._count._all })) } : {}),
  });
}));

/** شجرة بادئات الرموز (COA‑05): المستوى الأول برأس المجموعة، ثم بادئتا الرقمين والثلاثة. */
router.get('/accounts/tree', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const includeArchived = boolQuery.parse(req.query.includeArchived);
  const rows = await prisma.glAccount.findMany({
    where: { tenantId, ...(includeArchived ? {} : { isActive: true }) },
    select: { code: true },
    orderBy: { code: 'asc' },
  });
  type Node = { prefix: string; count: number; names?: Record<string, string>; children: Node[] };
  const root: Node[] = [];
  const index = new Map<string, Node>();
  const groupNames = new Map(SA_6D_ACCOUNT_GROUPS.map((g) => [g.code, g.names]));
  for (const { code } of rows) {
    let siblings = root;
    for (let len = 1; len <= Math.min(3, code.length); len++) {
      const prefix = code.slice(0, len);
      let node = index.get(prefix);
      if (!node) {
        node = { prefix, count: 0, children: [], ...(len === 1 && groupNames.has(prefix) ? { names: { ...groupNames.get(prefix)! } } : {}) };
        index.set(prefix, node);
        siblings.push(node);
      }
      node.count++;
      siblings = node.children;
    }
  }
  res.json({ success: true, data: root });
}));

router.get('/accounts/:id', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const a = await prisma.glAccount.findFirst({ where: { id: String(req.params.id), tenantId }, include: { tagLinks: { select: { tagId: true } } } });
  if (!a) throw new GlNotFoundError('GlAccount', String(req.params.id));
  const [line, sums, mappings] = await Promise.all([
    prisma.glMoveLine.findFirst({ where: { tenantId, accountId: a.id }, select: { id: true } }),
    prisma.glPeriodBalance.aggregate({ where: { tenantId, accountId: a.id }, _sum: { debitMilli: true, creditMilli: true } }),
    prisma.glAccountMapping.findMany({ where: { tenantId, accountId: a.id }, select: { key: true } }),
  ]);
  const { tagLinks, ...row } = a;
  res.json({
    success: true,
    data: {
      ...accountOut(row, {
        tagIds: tagLinks.map((l) => l.tagId), hasMoves: !!line,
        balance: milliToNumber((sums._sum.debitMilli ?? 0n) - (sums._sum.creditMilli ?? 0n)),
      }),
      mappingKeys: mappings.map((m) => m.key),
    },
  });
}));

const accountCodeSchema = z.string().trim().regex(/^\d{4,10}$/, 'رمز الحساب من 4 إلى 10 أرقام');
const accountFields = {
  name: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).nullish(),
  description: z.string().trim().max(2000).nullish(),
  type: z.enum(ACCOUNT_TYPES),
  reconcile: z.boolean().optional(),
  cashFlowTag: z.enum(CASH_FLOW_TAGS).nullish(),
  currencyCode: z.string().trim().regex(/^[A-Z]{3}$/).nullish(),
  tagIds: z.array(z.string().min(1)).max(50).optional(),
};
const accountCreateSchema = z.object({ code: accountCodeSchema, ...accountFields });
const accountUpdateSchema = z.object({ code: accountCodeSchema, ...accountFields }).partial();

/** COA‑02: التسوية مخفية لحسابات asset_cash (§4.5). */
function assertReconcileAllowed(type: string, reconcile: boolean | undefined) {
  if (reconcile === true && type === 'asset_cash') {
    throw new LedgerHttpError(422, 'لا تُفعَّل التسوية لحسابات البنك والنقد', { reason: 'RECONCILE_CASH', field: 'reconcile' });
  }
}

router.post('/accounts', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = accountCreateSchema.parse(req.body);
  assertArabicName(body.name, { entity: 'ACCOUNT' });
  assertReconcileAllowed(body.type, body.reconcile);
  const actor = actorOf(req, res);
  const created = await prisma.$transaction(async (tx) => {
    const dup = await tx.glAccount.findFirst({ where: { tenantId, code: body.code }, select: { id: true } });
    if (dup) throw new LedgerHttpError(409, 'رمز الحساب مستخدم', { reason: 'CODE_EXISTS', field: 'code', code: body.code, accountId: dup.id });
    if (body.type === 'equity_unaffected') {
      const ex = await tx.glAccount.findFirst({ where: { tenantId, type: 'equity_unaffected' }, select: { id: true } });
      if (ex) throw new LedgerHttpError(409, 'حساب أرباح السنة الجارية موجود ويحسبه النظام', { reason: 'EQUITY_UNAFFECTED_EXISTS', accountId: ex.id });
    }
    const tagIds = await requireTagIds(tx, tenantId, body.tagIds ?? []);
    const a = await tx.glAccount.create({
      data: {
        tenantId, code: body.code, name: body.name, nameEn: body.nameEn ?? null, description: body.description ?? null,
        type: body.type, reconcile: body.reconcile ?? false, cashFlowTag: body.cashFlowTag ?? null,
        currencyCode: body.currencyCode ?? null, isSystem: false, controlKind: null, templateRef: null,
      },
    });
    if (tagIds.length) await tx.glAccountTagLink.createMany({ data: tagIds.map((tagId) => ({ tenantId, accountId: a.id, tagId })), skipDuplicates: true });
    await appendAudit(tx, {
      tenantId, actor, action: 'ACCOUNT_CREATE', entityType: 'ACCOUNT', entityId: a.id,
      summary: `إنشاء الحساب ${a.code} ${a.name}`, after: { ...accountOut(a), tagIds },
    });
    return { a, tagIds };
  }, TX_OPTS);
  res.status(201).json({ success: true, data: accountOut(created.a, { tagIds: created.tagIds, hasMoves: false, balance: 0 }) });
}));

/** تغيير النوع يعبر حدّ off_balance (منه أو إليه). */
export function typeChangeCrossesOffBalance(from: string, to: string): boolean {
  return (from === 'off_balance') !== (to === 'off_balance');
}

router.put('/accounts/:id', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const id = String(req.params.id);
  const body = accountUpdateSchema.parse(req.body);
  if (body.name !== undefined) assertArabicName(body.name, { entity: 'ACCOUNT' });
  const actor = actorOf(req, res);
  const out = await prisma.$transaction(async (tx) => {
    const a = await requireAccount(tx, tenantId, id);
    const hasMoves = !!(await tx.glMoveLine.findFirst({ where: { tenantId, accountId: id }, select: { id: true } }));
    const data: Prisma.GlAccountUpdateInput = {};

    if (body.code !== undefined && body.code !== a.code) {
      // الرمز مرجع القالب والـbuilders (accountCode) وأرقام التقارير: لا يتغير لحساب مزروع أو له حركة
      if (a.templateRef || hasMoves) {
        throw new LedgerHttpError(409, 'لا يتغير رمز حساب من القالب أو له حركة', { reason: 'CODE_LOCKED', field: 'code', hasMoves, templateRef: a.templateRef });
      }
      const dup = await tx.glAccount.findFirst({ where: { tenantId, code: body.code, id: { not: id } }, select: { id: true } });
      if (dup) throw new LedgerHttpError(409, 'رمز الحساب مستخدم', { reason: 'CODE_EXISTS', field: 'code', code: body.code, accountId: dup.id });
      data.code = body.code;
    }

    const nextType = body.type ?? a.type;
    if (body.type !== undefined && body.type !== a.type) {
      if (a.controlKind) throw new LedgerHttpError(409, 'لا يتغير نوع حساب رئيسي', { reason: 'TYPE_LOCKED_CONTROL', field: 'type', controlKind: a.controlKind });
      if (a.isSystem && hasMoves) throw new LedgerHttpError(409, 'لا يتغير نوع حساب النظام بعد أول حركة', { reason: 'TYPE_LOCKED_SYSTEM', field: 'type' });
      // I8 وثبات المرحَّل (G1): العبور إلى off_balance أو منه يغيّر معنى القيود المرحّلة والميزانية بأثر رجعي.
      // سطور المسودات مسموحة لأن I8 يُعاد فحصه عند ترحيلها.
      if (typeChangeCrossesOffBalance(a.type, body.type)) {
        const postedLine = await tx.glMoveLine.findFirst({ where: { tenantId, accountId: id, posted: true }, select: { id: true } });
        if (postedLine) {
          throw new LedgerHttpError(409, 'لا يتغير نوع حساب له قيود مرحّلة إلى خارج الميزانية أو منه (I8)', { reason: 'TYPE_LOCKED_OFF_BALANCE', field: 'type' });
        }
      }
      const keys = (await tx.glAccountMapping.findMany({ where: { tenantId, accountId: id }, select: { key: true } })).map((m) => m.key as MappingKey);
      const bad = keys.filter((k) => MAPPING_KEY_ALLOWED_TYPES[k] && !MAPPING_KEY_ALLOWED_TYPES[k].includes(body.type!));
      if (bad.length) throw new LedgerHttpError(422, 'النوع لا يوافق مفاتيح الربط المرتبطة بالحساب', { reason: 'MAPPING_TYPE_MISMATCH', field: 'type', keys: bad });
      if (body.type === 'equity_unaffected') {
        const ex = await tx.glAccount.findFirst({ where: { tenantId, type: 'equity_unaffected', id: { not: id } }, select: { id: true } });
        if (ex) throw new LedgerHttpError(409, 'حساب أرباح السنة الجارية موجود ويحسبه النظام', { reason: 'EQUITY_UNAFFECTED_EXISTS', accountId: ex.id });
      }
      data.type = body.type;
    }

    const nextReconcile = body.reconcile ?? (nextType === 'asset_cash' ? false : a.reconcile);
    if (body.reconcile !== undefined && body.reconcile !== a.reconcile && a.controlKind === 'AR') {
      throw new LedgerHttpError(409, 'التسوية مقفلة لحساب ذمم العملاء الرئيسي', { reason: 'RECONCILE_LOCKED', field: 'reconcile' });
    }
    assertReconcileAllowed(nextType, nextReconcile);
    if (nextReconcile !== a.reconcile) data.reconcile = nextReconcile;

    if (body.name !== undefined && body.name !== a.name) data.name = body.name;
    if (body.nameEn !== undefined && (body.nameEn ?? null) !== a.nameEn) data.nameEn = body.nameEn ?? null;
    // §8.7: تعديل المستخدم يعلو ترجمة القالب
    if (data.name !== undefined || data.nameEn !== undefined) data.nameI18n = Prisma.DbNull;
    if (body.description !== undefined) data.description = body.description ?? null;
    if (body.cashFlowTag !== undefined) data.cashFlowTag = body.cashFlowTag ?? null;
    if (body.currencyCode !== undefined) data.currencyCode = body.currencyCode ?? null;

    const beforeTags = (await tx.glAccountTagLink.findMany({ where: { tenantId, accountId: id }, select: { tagId: true } })).map((l) => l.tagId).sort();
    let tagIds = beforeTags;
    if (body.tagIds !== undefined) {
      tagIds = (await requireTagIds(tx, tenantId, body.tagIds)).sort();
      if (JSON.stringify(tagIds) !== JSON.stringify(beforeTags)) {
        await tx.glAccountTagLink.deleteMany({ where: { tenantId, accountId: id } });
        if (tagIds.length) await tx.glAccountTagLink.createMany({ data: tagIds.map((tagId) => ({ tenantId, accountId: id, tagId })), skipDuplicates: true });
      }
    }

    const updated = Object.keys(data).length ? await tx.glAccount.update({ where: { id }, data }) : a;
    const d = diffOf({ ...accountOut(a), tagIds: beforeTags }, { ...accountOut(updated), tagIds });
    if (d.changed.length) {
      await appendAudit(tx, {
        tenantId, actor, action: 'ACCOUNT_UPDATE', entityType: 'ACCOUNT', entityId: id,
        summary: `تعديل الحساب ${updated.code} (${d.changed.join('، ')})`, before: d.before, after: d.after,
      });
    }
    return { updated, tagIds, hasMoves };
  }, TX_OPTS);
  res.json({ success: true, data: accountOut(out.updated, { tagIds: out.tagIds, hasMoves: out.hasMoves }) });
}));

const archiveSchema = z.object({ archived: z.boolean().default(true) });

/** أرشفة لا حذف (§3.2): الحساب الرئيسي والمربوط بمفتاح أو بدفتر أو بضريبة نشطة لا يُؤرشف فتنكسر الترحيلات (I3). */
router.post('/accounts/:id/archive', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const id = String(req.params.id);
  const { archived } = archiveSchema.parse(req.body ?? {});
  const actor = actorOf(req, res);
  const updated = await prisma.$transaction(async (tx) => {
    const a = await requireAccount(tx, tenantId, id);
    if (a.isActive === !archived) return a;
    if (archived) {
      if (a.controlKind) throw new LedgerHttpError(409, 'لا يُؤرشف حساب رئيسي', { reason: 'CONTROL_ACCOUNT', controlKind: a.controlKind });
      const [mappings, journals, taxes] = await Promise.all([
        tx.glAccountMapping.findMany({ where: { tenantId, accountId: id }, select: { key: true } }),
        tx.glJournal.findMany({ where: { tenantId, isActive: true, OR: [{ defaultAccountId: id }, { suspenseAccountId: id }] }, select: { id: true, code: true } }),
        tx.glTax.findMany({ where: { tenantId, isActive: true, OR: [{ accountId: id }, { rcOutputAccountId: id }] }, select: { id: true, name: true } }),
      ]);
      if (mappings.length) throw new LedgerHttpError(409, 'الحساب مربوط بمفتاح ربط ويُغيَّر الربط أولاً', { reason: 'MAPPED', keys: mappings.map((m) => m.key) });
      if (journals.length) throw new LedgerHttpError(409, 'الحساب افتراضي لدفتر نشط', { reason: 'JOURNAL_ACCOUNT', journals });
      if (taxes.length) throw new LedgerHttpError(409, 'الحساب مستعمل في ضريبة نشطة', { reason: 'TAX_ACCOUNT', taxes });
    }
    const u = await tx.glAccount.update({ where: { id }, data: { isActive: !archived } });
    await appendAudit(tx, {
      tenantId, actor, action: 'ACCOUNT_ARCHIVE', entityType: 'ACCOUNT', entityId: id,
      summary: `${archived ? 'أرشفة' : 'استعادة'} الحساب ${a.code} ${a.name}`, before: { isActive: a.isActive }, after: { isActive: u.isActive },
    });
    return u;
  }, TX_OPTS);
  res.json({ success: true, data: accountOut(updated) });
}));

const importSchema = z.object({
  rows: z.array(z.object({
    code: accountCodeSchema,
    name: z.string().trim().min(1).max(200),
    nameEn: z.string().trim().max(200).nullish(),
    type: z.enum(ACCOUNT_TYPES),
    reconcile: z.boolean().optional(),
  })).min(1).max(5000),
  dryRun: z.boolean().optional(),
});

/** COA‑07: الصفوف يقرؤها المتصفح من XLSX/CSV (ADR‑9) — الموجود بالرمز يُتخطى ولا يُعدَّل، والاسم غير العربي يرفض الملف (G7). */
router.post('/accounts/import', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = importSchema.parse(req.body);
  const nonArabic = body.rows.map((r, index) => ({ index, code: r.code, name: r.name })).filter((r) => !hasArabicLetter(r.name));
  if (nonArabic.length) throw new LedgerError('LEDGER_NAME_ARABIC_REQUIRED', { field: 'name', entity: 'ACCOUNT', rows: nonArabic.slice(0, 200), count: nonArabic.length });
  const actor = actorOf(req, res);
  const result = await prisma.$transaction(async (tx) => {
    const existing = new Set((await tx.glAccount.findMany({ where: { tenantId }, select: { code: true } })).map((a) => a.code));
    const seen = new Set<string>();
    const skipped: { code: string; reason: string }[] = [];
    const data: Prisma.GlAccountCreateManyInput[] = [];
    for (const r of body.rows) {
      if (existing.has(r.code)) { skipped.push({ code: r.code, reason: 'EXISTS' }); continue; }
      if (seen.has(r.code)) { skipped.push({ code: r.code, reason: 'DUPLICATE_IN_FILE' }); continue; }
      if (r.reconcile === true && r.type === 'asset_cash') { skipped.push({ code: r.code, reason: 'RECONCILE_CASH' }); continue; }
      if (r.type === 'equity_unaffected') { skipped.push({ code: r.code, reason: 'EQUITY_UNAFFECTED' }); continue; }
      seen.add(r.code);
      data.push({ tenantId, code: r.code, name: r.name, nameEn: r.nameEn ?? null, type: r.type, reconcile: r.reconcile ?? false });
    }
    if (body.dryRun) return { created: data.length, skipped, dryRun: true };
    const created = data.length ? (await tx.glAccount.createMany({ data, skipDuplicates: true })).count : 0;
    await appendAudit(tx, {
      tenantId, actor, action: 'ACCOUNT_IMPORT', entityType: 'ACCOUNT', entityId: null,
      summary: `استيراد ${created} حساباً وتخطي ${skipped.length}`,
      after: { created, codes: data.map((d) => d.code), skipped },
    });
    return { created, skipped, dryRun: false };
  }, TX_OPTS);
  res.status(body.dryRun ? 200 : 201).json({ success: true, data: result });
}));

// ═══ الدفاتر (JRN‑01…04، G2) ═══

type JournalRow = Prisma.GlJournalGetPayload<object>;

function journalOut(j: JournalRow, hasPostedMoves?: boolean) {
  return {
    id: j.id, code: j.code, name: j.name, nameEn: j.nameEn, nameI18n: j.nameI18n, type: j.type, systemKey: j.systemKey,
    defaultAccountId: j.defaultAccountId, suspenseAccountId: j.suspenseAccountId, useOutstandingAccounts: j.useOutstandingAccounts,
    sequenceReset: j.sequenceReset, showOnDashboard: j.showOnDashboard, color: j.color, bankName: j.bankName,
    ibanMasked: j.ibanMasked, isActive: j.isActive, isSystem: j.isSystem, createdAt: j.createdAt, updatedAt: j.updatedAt,
    ...(hasPostedMoves === undefined ? {} : { hasPostedMoves }),
  };
}

/** §9.4: IBAN يُخزَّن مقنّعاً — أول أربعة وآخر أربعة فقط. */
export function maskIban(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const clean = iban.replace(/\s+/g, '').toUpperCase();
  if (clean.length <= 8) return `${clean.slice(0, 2)}****`;
  return `${clean.slice(0, 4)} **** **** ${clean.slice(-4)}`;
}

const journalFields = {
  code: z.string().trim().transform((s) => s.toUpperCase()).refine((s) => JOURNAL_CODE_RE.test(s), 'رمز الدفتر حتى 6 أحرف لاتينية'),
  name: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).nullish(),
  type: z.enum(JOURNAL_TYPES),
  defaultAccountId: z.string().min(1).nullish(),
  suspenseAccountId: z.string().min(1).nullish(),
  useOutstandingAccounts: z.boolean().optional(),
  sequenceReset: z.enum(SEQUENCE_RESETS).optional(),
  showOnDashboard: z.boolean().optional(),
  color: z.number().int().min(0).max(11).optional(),
  bankName: z.string().trim().max(120).nullish(),
  iban: z.string().trim().transform((s) => s.replace(/\s+/g, '').toUpperCase())
    .refine((s) => s === '' || /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s), 'IBAN غير صالح').nullish(),
};
const journalCreateSchema = z.object(journalFields);
const journalUpdateSchema = z.object({ ...journalFields, isActive: z.boolean() }).partial();

async function postedJournalIds(tenantId: string): Promise<Set<string>> {
  const g = await prisma.glMove.groupBy({ by: ['journalId'], where: { tenantId, state: 'POSTED' } });
  return new Set(g.map((x) => x.journalId));
}

router.get('/journals', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const includeArchived = req.query.includeArchived === undefined ? true : boolQuery.parse(req.query.includeArchived);
  const [rows, posted] = await Promise.all([
    prisma.glJournal.findMany({ where: { tenantId, ...(includeArchived ? {} : { isActive: true }) }, orderBy: [{ isSystem: 'desc' }, { code: 'asc' }] }),
    postedJournalIds(tenantId),
  ]);
  res.json({ success: true, data: rows.map((j) => journalOut(j, posted.has(j.id))) });
}));

router.post('/journals', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = journalCreateSchema.parse(req.body);
  assertArabicName(body.name, { entity: 'JOURNAL' });
  const actor = actorOf(req, res);
  const j = await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    // التزام M1: رمز يساوي رمز دفتر آخر أو بادئة مرتجعه ⇒ 409 LEDGER_JOURNAL_CODE_CONFLICT (journalCodeConflict)
    await assertJournalNumberingEditable(tx, { tenantId, code: body.code, sequenceReset: body.sequenceReset ?? null });
    await requireActiveAccountRef(tx, tenantId, body.defaultAccountId, 'defaultAccountId');
    await requireActiveAccountRef(tx, tenantId, body.suspenseAccountId, 'suspenseAccountId');
    const created = await tx.glJournal.create({
      data: {
        tenantId, code: body.code, name: body.name, nameEn: body.nameEn ?? null, type: body.type, systemKey: null,
        defaultAccountId: body.defaultAccountId ?? null, suspenseAccountId: body.suspenseAccountId ?? null,
        useOutstandingAccounts: body.useOutstandingAccounts ?? false, sequenceReset: body.sequenceReset ?? 'YEARLY',
        showOnDashboard: body.showOnDashboard ?? true, color: body.color ?? 0, bankName: body.bankName ?? null,
        ibanMasked: maskIban(body.iban), isActive: true, isSystem: false,
      },
    });
    await appendAudit(tx, {
      tenantId, actor, action: 'JOURNAL_CREATE', entityType: 'JOURNAL', entityId: created.id,
      summary: `إنشاء الدفتر ${created.code} ${created.name}`, after: journalOut(created),
    });
    return created;
  }, TX_OPTS);
  res.status(201).json({ success: true, data: journalOut(j, false) });
}));

router.put('/journals/:id', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const id = String(req.params.id);
  const body = journalUpdateSchema.parse(req.body);
  if (body.name !== undefined) assertArabicName(body.name, { entity: 'JOURNAL' });
  const actor = actorOf(req, res);
  const out = await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    // G2 تحت قفل الترحيل: 404 للدفتر الغريب، وLEDGER_JOURNAL_HAS_POSTED_MOVES، وLEDGER_JOURNAL_CODE_CONFLICT
    await assertJournalNumberingEditable(tx, { tenantId, journalId: id, code: body.code ?? null, sequenceReset: body.sequenceReset ?? null });
    const j = await tx.glJournal.findFirst({ where: { id, tenantId } });
    if (!j) throw new GlNotFoundError('GlJournal', id);
    if (j.isSystem && body.type !== undefined && body.type !== j.type) {
      throw new LedgerHttpError(409, 'لا يتغير نوع دفتر النظام', { reason: 'SYSTEM_JOURNAL_TYPE', field: 'type', systemKey: j.systemKey });
    }
    if (j.isSystem && body.isActive === false) {
      throw new LedgerHttpError(409, 'لا يُؤرشف دفتر النظام', { reason: 'SYSTEM_JOURNAL_ARCHIVE', field: 'isActive', systemKey: j.systemKey });
    }
    if (body.defaultAccountId !== undefined && body.defaultAccountId !== j.defaultAccountId) await requireActiveAccountRef(tx, tenantId, body.defaultAccountId, 'defaultAccountId');
    if (body.suspenseAccountId !== undefined && body.suspenseAccountId !== j.suspenseAccountId) await requireActiveAccountRef(tx, tenantId, body.suspenseAccountId, 'suspenseAccountId');

    const data: Prisma.GlJournalUncheckedUpdateInput = {};
    if (body.code !== undefined && body.code !== j.code) data.code = body.code;
    if (body.sequenceReset !== undefined && body.sequenceReset !== j.sequenceReset) data.sequenceReset = body.sequenceReset;
    if (body.name !== undefined && body.name !== j.name) data.name = body.name;
    if (body.nameEn !== undefined && (body.nameEn ?? null) !== j.nameEn) data.nameEn = body.nameEn ?? null;
    if (data.name !== undefined || data.nameEn !== undefined) data.nameI18n = Prisma.DbNull;
    if (body.type !== undefined) data.type = body.type;
    if (body.defaultAccountId !== undefined) data.defaultAccountId = body.defaultAccountId ?? null;
    if (body.suspenseAccountId !== undefined) data.suspenseAccountId = body.suspenseAccountId ?? null;
    if (body.useOutstandingAccounts !== undefined) data.useOutstandingAccounts = body.useOutstandingAccounts;
    if (body.showOnDashboard !== undefined) data.showOnDashboard = body.showOnDashboard;
    if (body.color !== undefined) data.color = body.color;
    if (body.bankName !== undefined) data.bankName = body.bankName ?? null;
    if (body.iban !== undefined) data.ibanMasked = maskIban(body.iban);
    if (body.isActive !== undefined) data.isActive = body.isActive;

    const updated = await tx.glJournal.update({ where: { id }, data });
    const d = diffOf(journalOut(j), journalOut(updated));
    if (d.changed.length) {
      await appendAudit(tx, {
        tenantId, actor, action: body.isActive === false && j.isActive ? 'JOURNAL_ARCHIVE' : 'JOURNAL_UPDATE',
        entityType: 'JOURNAL', entityId: id, summary: `تعديل الدفتر ${updated.code} (${d.changed.join('، ')})`,
        before: d.before, after: d.after,
      });
    }
    const posted = await tx.glMove.findFirst({ where: { tenantId, journalId: id, state: 'POSTED' }, select: { id: true } });
    return journalOut(updated, !!posted);
  }, TX_OPTS);
  res.json({ success: true, data: out });
}));

// ═══ الضرائب (TAX‑01، §4.4) ═══

type TaxRow = Prisma.GlTaxGetPayload<object>;

function taxOut(t: TaxRow) {
  return {
    id: t.id, key: t.key, name: t.name, nameEn: t.nameEn, nameI18n: t.nameI18n, groupId: t.groupId, use: t.use, rate: t.rate,
    vatCategory: t.vatCategory, priceInclude: t.priceInclude, accountId: t.accountId, rcOutputAccountId: t.rcOutputAccountId,
    deductible: t.deductible, vatBox: t.vatBox, isActive: t.isActive, isSystem: t.isSystem, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

const taxFields = {
  name: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).nullish(),
  use: z.enum(TAX_USES),
  rate: z.number().min(0).max(100),
  vatCategory: z.enum(VAT_CATEGORIES),
  priceInclude: z.boolean().optional(),
  accountId: z.string().min(1).nullish(),
  rcOutputAccountId: z.string().min(1).nullish(),
  deductible: z.boolean().optional(),
  vatBox: z.enum(VAT_BOXES_SA).nullish(),
  isActive: z.boolean().optional(),
};
const taxCreateSchema = z.object(taxFields);
const taxUpdateSchema = z.object(taxFields).partial();

/** قواعد الضريبة الصرفة: الفئة S بنسبة موجبة وغيرها صفرية، وعدم الخصم والاحتساب العكسي للمشتريات وحدها. */
export function taxShapeIssue(t: { use: string; rate: number; vatCategory: string; deductible: boolean; rcOutputAccountId: string | null }): string | null {
  if (t.vatCategory === 'S' ? !(t.rate > 0) : t.rate !== 0) return 'RATE_CATEGORY_MISMATCH';
  if (!t.deductible && t.use !== 'PURCHASE') return 'NON_DEDUCTIBLE_NOT_PURCHASE';
  if (t.rcOutputAccountId && t.use !== 'PURCHASE') return 'REVERSE_CHARGE_NOT_PURCHASE';
  return null;
}

router.get('/taxes', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const use = typeof req.query.use === 'string' && (TAX_USES as readonly string[]).includes(req.query.use) ? req.query.use : undefined;
  const includeArchived = req.query.includeArchived === undefined ? true : boolQuery.parse(req.query.includeArchived);
  const rows = await prisma.glTax.findMany({
    where: { tenantId, ...(use ? { use } : {}), ...(includeArchived ? {} : { isActive: true }) },
    orderBy: [{ use: 'asc' }, { rate: 'desc' }, { name: 'asc' }],
  });
  res.json({ success: true, data: rows.map(taxOut) });
}));

router.post('/taxes', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = taxCreateSchema.parse(req.body);
  assertArabicName(body.name, { entity: 'TAX' });
  const shape = { use: body.use, rate: body.rate, vatCategory: body.vatCategory, deductible: body.deductible ?? true, rcOutputAccountId: body.rcOutputAccountId ?? null };
  const issue = taxShapeIssue(shape);
  if (issue) throw new LedgerHttpError(422, 'إعداد الضريبة غير متسق', { reason: issue });
  const actor = actorOf(req, res);
  const t = await prisma.$transaction(async (tx) => {
    await requireActiveAccountRef(tx, tenantId, body.accountId, 'accountId');
    await requireActiveAccountRef(tx, tenantId, body.rcOutputAccountId, 'rcOutputAccountId');
    const created = await tx.glTax.create({
      data: {
        tenantId, key: null, name: body.name, nameEn: body.nameEn ?? null, use: body.use, rate: body.rate,
        vatCategory: body.vatCategory, priceInclude: body.priceInclude ?? false, accountId: body.accountId ?? null,
        rcOutputAccountId: body.rcOutputAccountId ?? null, deductible: shape.deductible, vatBox: body.vatBox ?? null,
        isActive: body.isActive ?? true, isSystem: false,
      },
    });
    await appendAudit(tx, {
      tenantId, actor, action: 'TAX_CREATE', entityType: 'TAX', entityId: created.id,
      summary: `إنشاء الضريبة ${created.name}`, after: taxOut(created),
    });
    return created;
  }, TX_OPTS);
  res.status(201).json({ success: true, data: taxOut(t) });
}));

const TAX_COMPUTE_FIELDS = ['use', 'rate', 'vatCategory', 'priceInclude', 'deductible'] as const;

router.put('/taxes/:id', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const id = String(req.params.id);
  const body = taxUpdateSchema.parse(req.body);
  if (body.name !== undefined) assertArabicName(body.name, { entity: 'TAX' });
  const actor = actorOf(req, res);
  const out = await prisma.$transaction(async (tx) => {
    const t = await tx.glTax.findFirst({ where: { id, tenantId } });
    if (!t) throw new GlNotFoundError('GlTax', id);
    const changedCompute = TAX_COMPUTE_FIELDS.filter((f) => body[f] !== undefined && body[f] !== t[f]);
    if (changedCompute.length) {
      // حساب الضريبة على سطور قائمة وإقرارات سابقة: لا يتغير لضريبة القالب ولا لضريبة مستعملة
      if (t.isSystem) throw new LedgerHttpError(409, 'لا تتغير نسبة ضريبة القالب أو طبيعتها', { reason: 'SYSTEM_TAX', fields: changedCompute, key: t.key });
      const used = await tx.glMoveLine.findFirst({ where: { tenantId, taxId: id }, select: { id: true } });
      if (used) throw new LedgerHttpError(409, 'لا تتغير نسبة ضريبة مستعملة في قيود — أنشئ ضريبة جديدة', { reason: 'TAX_IN_USE', fields: changedCompute });
    }
    const next = {
      use: body.use ?? t.use, rate: body.rate ?? t.rate, vatCategory: body.vatCategory ?? t.vatCategory,
      deductible: body.deductible ?? t.deductible,
      rcOutputAccountId: body.rcOutputAccountId === undefined ? t.rcOutputAccountId : body.rcOutputAccountId ?? null,
    };
    const issue = taxShapeIssue(next);
    if (issue) throw new LedgerHttpError(422, 'إعداد الضريبة غير متسق', { reason: issue });
    if (body.accountId !== undefined && body.accountId !== t.accountId) await requireActiveAccountRef(tx, tenantId, body.accountId, 'accountId');
    if (body.rcOutputAccountId !== undefined && body.rcOutputAccountId !== t.rcOutputAccountId) await requireActiveAccountRef(tx, tenantId, body.rcOutputAccountId, 'rcOutputAccountId');
    if (body.isActive === false && t.isActive) {
      const s = await tx.glSettings.findUnique({ where: { tenantId }, select: { defaultPurchaseTaxId: true, zeroRatedSalesTaxKey: true } });
      if (s && (s.defaultPurchaseTaxId === id || (t.key && s.zeroRatedSalesTaxKey === t.key))) {
        throw new LedgerHttpError(409, 'الضريبة مستعملة في إعدادات الدفاتر', { reason: 'TAX_IN_SETTINGS' });
      }
    }
    const data: Prisma.GlTaxUncheckedUpdateInput = {};
    if (body.name !== undefined && body.name !== t.name) data.name = body.name;
    if (body.nameEn !== undefined && (body.nameEn ?? null) !== t.nameEn) data.nameEn = body.nameEn ?? null;
    if (data.name !== undefined || data.nameEn !== undefined) data.nameI18n = Prisma.DbNull;
    for (const f of changedCompute) (data as Record<string, unknown>)[f] = body[f];
    if (body.accountId !== undefined) data.accountId = body.accountId ?? null;
    if (body.rcOutputAccountId !== undefined) data.rcOutputAccountId = body.rcOutputAccountId ?? null;
    if (body.vatBox !== undefined) data.vatBox = body.vatBox ?? null;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    const updated = await tx.glTax.update({ where: { id }, data });
    const d = diffOf(taxOut(t), taxOut(updated));
    if (d.changed.length) {
      await appendAudit(tx, {
        tenantId, actor, action: body.isActive === false && t.isActive ? 'TAX_ARCHIVE' : 'TAX_UPDATE', entityType: 'TAX', entityId: id,
        summary: `تعديل الضريبة ${updated.name} (${d.changed.join('، ')})`, before: d.before, after: d.after,
      });
    }
    return updated;
  }, TX_OPTS);
  res.json({ success: true, data: taxOut(out) });
}));

// ═══ مفاتيح الربط (§4.5) ═══

const MAPPING_ACCOUNT_SELECT = { id: true, code: true, name: true, nameEn: true, nameI18n: true, type: true, isActive: true, controlKind: true } as const;

router.get('/mappings', CONFIGURE, ledgerHandler(async (_req, res) => {
  const { tenantId } = ledgerOf(res);
  const rows = await prisma.glAccountMapping.findMany({ where: { tenantId }, include: { account: { select: MAPPING_ACCOUNT_SELECT } } });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  res.json({
    success: true,
    data: MAPPING_KEYS.map((key) => {
      const r = byKey.get(key);
      return {
        key, accountId: r?.accountId ?? null, account: r?.account ?? null, updatedAt: r?.updatedAt ?? null,
        allowedTypes: MAPPING_KEY_ALLOWED_TYPES[key], controlKind: MAPPING_KEY_CONTROL_KIND[key] ?? null,
      };
    }),
  });
}));

const mappingsSchema = z.object({
  mappings: z.array(z.object({ key: z.enum(MAPPING_KEYS), accountId: z.string().min(1) })).min(1).max(MAPPING_KEYS.length)
    .refine((a) => new Set(a.map((m) => m.key)).size === a.length, 'مفتاح مكرر'),
});

router.put('/mappings', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const { mappings } = mappingsSchema.parse(req.body);
  const actor = actorOf(req, res);
  await prisma.$transaction(async (tx) => {
    // الربط يغيّر حسابات الترحيل الآلي: تحت قفل الترحيل فلا يُبنى قيد على ربط نصف محدَّث
    await acquirePostLock(tx, tenantId);
    const accounts = await tx.glAccount.findMany({ where: { tenantId, id: { in: [...new Set(mappings.map((m) => m.accountId))] } }, select: MAPPING_ACCOUNT_SELECT });
    const accById = new Map(accounts.map((a) => [a.id, a]));
    const current = new Map((await tx.glAccountMapping.findMany({ where: { tenantId }, select: { key: true, accountId: true } })).map((m) => [m.key, m.accountId]));
    const before: Record<string, string | null> = {};
    const after: Record<string, string> = {};
    for (const m of mappings) {
      const acc = accById.get(m.accountId);
      if (!acc) throw new GlNotFoundError('GlAccount', m.accountId);
      if (!acc.isActive) throw new LedgerError('LEDGER_ACCOUNT_ARCHIVED', { accountId: acc.id, key: m.key });
      const allowed = MAPPING_KEY_ALLOWED_TYPES[m.key];
      if (!allowed.includes(acc.type as AccountType)) {
        throw new LedgerHttpError(422, 'نوع الحساب لا يوافق مفتاح الربط', { reason: 'MAPPING_TYPE_MISMATCH', key: m.key, accountId: acc.id, type: acc.type, allowedTypes: allowed });
      }
      const kind = MAPPING_KEY_CONTROL_KIND[m.key] ?? null;
      if (kind && acc.controlKind !== kind) {
        throw new LedgerHttpError(422, 'مفتاح الربط يتطلب حساباً رئيسياً من نوعه', { reason: 'MAPPING_CONTROL_KIND', key: m.key, accountId: acc.id, controlKind: kind });
      }
      if ((current.get(m.key) ?? null) === m.accountId) continue;
      before[m.key] = current.get(m.key) ?? null;
      after[m.key] = m.accountId;
      await tx.glAccountMapping.upsert({
        where: { tenantId_key: { tenantId, key: m.key } },
        create: { tenantId, key: m.key, accountId: m.accountId },
        update: { accountId: m.accountId },
      });
    }
    if (Object.keys(after).length) {
      await appendAudit(tx, {
        tenantId, actor, action: 'MAPPING_CHANGE', entityType: 'MAPPING', entityId: null,
        summary: `تعديل مفاتيح الربط (${Object.keys(after).join('، ')})`, before, after,
      });
    }
  }, TX_OPTS);
  const rows = await prisma.glAccountMapping.findMany({ where: { tenantId }, include: { account: { select: MAPPING_ACCOUNT_SELECT } } });
  res.json({ success: true, data: rows.map((r) => ({ key: r.key, accountId: r.accountId, account: r.account, updatedAt: r.updatedAt })) });
}));

// ═══ الإعدادات (§8.4، CFG‑01) وزرع القالب (TAX‑01، §4.5) ═══

type SettingsRow = Prisma.GlSettingsGetPayload<object>;

/** صف الإعدادات للواجهة: تواريخ @db.Date محلية، وبلا عقد إيجار المعالج. */
export function settingsOut(s: SettingsRow) {
  const { workerLeaseToken: _t, workerLeaseUntil: _u, ...rest } = s;
  return {
    ...rest,
    cutoverDate: dateOut(s.cutoverDate), perpetualFromDate: dateOut(s.perpetualFromDate),
    salesLockDate: dateOut(s.salesLockDate), purchaseLockDate: dateOut(s.purchaseLockDate),
    taxLockDate: dateOut(s.taxLockDate), hardLockDate: dateOut(s.hardLockDate),
    paylinkFeeTaxInvoiceFrom: dateOut(s.paylinkFeeTaxInvoiceFrom),
  };
}

router.get('/settings', CONFIGURE, ledgerHandler(async (_req, res) => {
  const { tenantId } = ledgerOf(res);
  const s = await prisma.glSettings.findUnique({ where: { tenantId } });
  res.json({ success: true, data: s ? settingsOut(s) : null });
}));

const RECEIPT_METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'] as const;

const settingsUpdateSchema = z.object({
  timezone: z.string().min(1).refine(isValidTimeZone, 'منطقة زمنية غير صالحة'),
  fiscalYearEndMonth: z.number().int().min(1).max(12),
  fiscalYearEndDay: z.number().int().min(1).max(31),
  weekStartsOn: z.number().int().min(0).max(6),
  inventoryMode: z.enum(INVENTORY_MODES),
  perpetualFromDate: localDateSchema.nullable(),
  taxPeriodicity: z.enum(TAX_PERIODICITIES),
  taxDeadlineRule: z.enum(TAX_DEADLINE_RULES),
  taxDeadlineDays: z.number().int().min(1).max(365).nullable(),
  taxClosingJournalId: z.string().min(1).nullable(),
  /** الأساس النقدي مؤجَّل ويبقى false (§8.4) */
  cashBasisEnabled: z.literal(false),
  defaultPurchaseTaxId: z.string().min(1).nullable(),
  billPricesIncludeTax: z.boolean(),
  billPredictionEnabled: z.boolean(),
  postPurchaseDiscountSeparately: z.boolean(),
  earlyDiscountAdjustsVat: z.boolean(),
  taxRoundingMethod: z.enum(['PER_TAX', 'PER_LINE']),
  zeroRatedSalesTaxKey: z.string().min(1).nullable(),
  postSalesDiscountSeparately: z.boolean(),
  postReturnsToContra: z.boolean(),
  receiptRouting: z.record(z.enum(RECEIPT_METHODS), z.enum(['CUSTODY', 'DIRECT'])).nullable(),
  cashInvoiceRouting: z.enum(CASH_INVOICE_ROUTINGS),
  autoValidateBills: z.boolean(),
  batchPaymentsEnabled: z.boolean(),
  deferralJournalId: z.string().min(1).nullable(),
  deferralGenerate: z.enum(['ON_VALIDATION', 'MANUAL']),
  deferralMethod: z.enum(['BY_MONTHS', 'BY_DAYS']),
  drawingsAfterNetProfit: z.boolean(),
  depreciationInOperatingExpenses: z.boolean(),
}).partial().strict();

/** تغييرها بعد التفعيل يعيد تفسير تواريخ مرحّلة وسنوات وأرصدة مخزون قائمة. */
const FROZEN_AFTER_ACTIVATION = ['timezone', 'fiscalYearEndMonth', 'fiscalYearEndDay', 'inventoryMode', 'perpetualFromDate'] as const;

router.put('/settings', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = settingsUpdateSchema.parse(req.body);
  const actor = actorOf(req, res);
  const updated = await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    const s = await tx.glSettings.findUnique({ where: { tenantId } });
    if (!s) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });

    if (s.activatedAt) {
      const frozen = FROZEN_AFTER_ACTIVATION.filter((f) => {
        if (body[f] === undefined) return false;
        const cur = f === 'perpetualFromDate' ? dateOut(s.perpetualFromDate) : s[f];
        return body[f] !== cur;
      });
      if (frozen.length) throw new LedgerHttpError(409, 'هذه الإعدادات لا تتغير بعد تفعيل الدفاتر', { reason: 'FROZEN_AFTER_ACTIVATION', fields: frozen });
    }
    const month = body.fiscalYearEndMonth ?? s.fiscalYearEndMonth;
    const day = body.fiscalYearEndDay ?? s.fiscalYearEndDay;
    if (day > daysInMonth(2001, month)) {
      throw new LedgerHttpError(422, 'يوم نهاية السنة المالية غير صالح للشهر', { reason: 'INVALID_FISCAL_YEAR_END', fiscalYearEndMonth: month, fiscalYearEndDay: day });
    }
    const rule = body.taxDeadlineRule ?? s.taxDeadlineRule;
    let deadlineDays = body.taxDeadlineDays === undefined ? s.taxDeadlineDays : body.taxDeadlineDays;
    if (rule === 'DAYS_AFTER' && deadlineDays == null) {
      throw new LedgerHttpError(422, 'عدد أيام موعد الإقرار مطلوب', { reason: 'TAX_DEADLINE_DAYS_REQUIRED', field: 'taxDeadlineDays' });
    }
    if (rule === 'END_OF_NEXT_MONTH') deadlineDays = null;

    if (body.taxClosingJournalId !== undefined) await requireJournalRef(tx, tenantId, body.taxClosingJournalId);
    if (body.deferralJournalId !== undefined) await requireJournalRef(tx, tenantId, body.deferralJournalId);
    if (body.defaultPurchaseTaxId) {
      const t = await tx.glTax.findFirst({ where: { id: body.defaultPurchaseTaxId, tenantId }, select: { use: true, isActive: true } });
      if (!t) throw new GlNotFoundError('GlTax', body.defaultPurchaseTaxId);
      if (t.use !== 'PURCHASE' || !t.isActive) throw new LedgerHttpError(422, 'ضريبة الشراء الافتراضية يجب أن تكون ضريبة مشتريات نشطة', { reason: 'DEFAULT_PURCHASE_TAX_INVALID' });
    }
    if (body.zeroRatedSalesTaxKey) {
      const t = await tx.glTax.findFirst({ where: { tenantId, key: body.zeroRatedSalesTaxKey }, select: { use: true, rate: true, isActive: true } });
      if (!t) throw new GlNotFoundError('GlTax', body.zeroRatedSalesTaxKey);
      if (t.use !== 'SALE' || t.rate !== 0 || !t.isActive) throw new LedgerHttpError(422, 'ربط النسبة الصفرية يتطلب ضريبة مبيعات صفرية نشطة', { reason: 'ZERO_RATED_TAX_INVALID' });
    }

    const data: Prisma.GlSettingsUncheckedUpdateInput = {};
    for (const [k, v] of Object.entries(body)) {
      if (k === 'perpetualFromDate') data.perpetualFromDate = v ? toDbDate(v as string) : null;
      else if (k === 'receiptRouting') data.receiptRouting = v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
      else (data as Record<string, unknown>)[k] = v;
    }
    data.taxDeadlineDays = deadlineDays;
    const u = await tx.glSettings.update({ where: { tenantId }, data });
    const d = diffOf(settingsOut(s), settingsOut(u));
    if (d.changed.length) {
      await appendAudit(tx, {
        tenantId, actor, action: 'SETTINGS_CHANGE', entityType: 'SETTINGS', entityId: s.id,
        summary: `تعديل إعدادات الدفاتر (${d.changed.join('، ')})`, before: d.before, after: d.after,
      });
    }
    return u;
  }, TX_OPTS);
  res.json({ success: true, data: settingsOut(updated) });
}));

/**
 * زرع القالب متساوي الأثر (M2: «الإعداد للقالب فقط»، §4.5، TAX‑01، TAX‑02): زر «تحميل القالب/إعادة تحميله».
 * القالب من لقطة GlSettings إن وُجدت، وإلا من دولة CompanySettings (SA ⇒ SA_6D، غيرها ⇒ GENERIC_6D).
 * يضيف الناقص فقط ولا يعدّل الموجود، فلا يصطدم به معالج M3. تحت قفل gl-post لأنه ينشئ دفاتر (تصادم الرمز).
 */
router.post('/settings/load-template', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const actor = actorOf(req, res);
  const out = await prisma.$transaction(async (tx) => {
    await acquirePostLock(tx, tenantId);
    const existing = await tx.glSettings.findUnique({ where: { tenantId }, select: { templateKey: true, countryCode: true } });
    let templateKey: TemplateKey;
    let countryCode: string;
    if (existing) {
      templateKey = existing.templateKey === 'GENERIC_6D' ? 'GENERIC_6D' : 'SA_6D';
      countryCode = existing.countryCode;
    } else {
      const cs = await tx.companySettings.findUnique({ where: { tenantId }, select: { countryCode: true } });
      countryCode = (cs?.countryCode || 'SA').toUpperCase();
      templateKey = countryCode === 'SA' ? 'SA_6D' : 'GENERIC_6D';
    }
    let report;
    try {
      report = await seedTemplate(tx, tenantId, templateKey, templateKey === 'GENERIC_6D' ? { countryCode } : {});
    } catch (e) {
      if (e instanceof RangeError) throw new LedgerHttpError(422, 'لا قالب محاسبي لدولة الشركة', { reason: 'TEMPLATE_UNAVAILABLE', templateKey, countryCode });
      throw e;
    }
    await appendAudit(tx, {
      tenantId, actor, action: 'TEMPLATE_SEED', entityType: 'SETTINGS', entityId: null,
      summary: `تحميل القالب ${templateKey}`, after: { countryCode, ...report },
    });
    const s = await tx.glSettings.findUnique({ where: { tenantId } });
    return { report, settings: s ? settingsOut(s) : null };
  }, { timeout: 60_000, maxWait: 10_000 });
  res.json({ success: true, data: out });
}));

// ═══ السنوات المالية (§2.5) ═══

type FiscalYearRow = Prisma.GlFiscalYearGetPayload<object>;
const fiscalYearOut = (f: FiscalYearRow) => ({
  id: f.id, name: f.name, dateFrom: fromDbDate(f.dateFrom), dateTo: fromDbDate(f.dateTo), state: f.state,
  closingMoveId: f.closingMoveId, closedAt: f.closedAt, closedBy: f.closedBy,
});

const fiscalYearSchema = z.object({ name: z.string().trim().min(1).max(100), dateFrom: localDateSchema, dateTo: localDateSchema });

/** السنة الأولى القصيرة أو الطويلة: من ≤ إلى، وبحد 24 شهراً. صرفة. */
export function fiscalYearRangeIssue(dateFrom: string, dateTo: string): string | null {
  if (compareLocalDate(dateFrom, dateTo) > 0) return 'INVALID_RANGE';
  if (compareLocalDate(dateTo, addMonths(dateFrom, 24)) >= 0) return 'RANGE_TOO_LONG';
  return null;
}

async function assertFiscalYearFree(tx: GlTx, tenantId: string, dateFrom: string, dateTo: string, exceptId?: string) {
  const issue = fiscalYearRangeIssue(dateFrom, dateTo);
  if (issue) throw new LedgerHttpError(422, 'مدى السنة المالية غير صالح', { reason: issue, dateFrom, dateTo });
  const overlap = await tx.glFiscalYear.findFirst({
    where: { tenantId, ...(exceptId ? { id: { not: exceptId } } : {}), dateFrom: { lte: toDbDate(dateTo) }, dateTo: { gte: toDbDate(dateFrom) } },
    select: { id: true, name: true },
  });
  if (overlap) throw new LedgerHttpError(409, 'السنة المالية تتداخل مع سنة قائمة', { reason: 'OVERLAP', fiscalYear: overlap });
}

router.get('/fiscal-years', VIEW, ledgerHandler(async (_req, res) => {
  const { tenantId } = ledgerOf(res);
  const rows = await prisma.glFiscalYear.findMany({ where: { tenantId }, orderBy: { dateFrom: 'asc' } });
  res.json({ success: true, data: rows.map(fiscalYearOut) });
}));

router.post('/fiscal-years', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = fiscalYearSchema.parse(req.body);
  const actor = actorOf(req, res);
  const fy = await prisma.$transaction(async (tx) => {
    await assertFiscalYearFree(tx, tenantId, body.dateFrom, body.dateTo);
    const created = await tx.glFiscalYear.create({ data: { tenantId, name: body.name, dateFrom: toDbDate(body.dateFrom), dateTo: toDbDate(body.dateTo) } });
    await appendAudit(tx, {
      tenantId, actor, action: 'SETTINGS_CHANGE', entityType: 'FISCAL_YEAR', entityId: created.id,
      summary: `إنشاء السنة المالية ${created.name}`, after: fiscalYearOut(created),
    });
    return created;
  }, TX_OPTS);
  res.status(201).json({ success: true, data: fiscalYearOut(fy) });
}));

router.put('/fiscal-years/:id', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const id = String(req.params.id);
  const body = fiscalYearSchema.partial().parse(req.body);
  const actor = actorOf(req, res);
  const fy = await prisma.$transaction(async (tx) => {
    const f = await tx.glFiscalYear.findFirst({ where: { id, tenantId } });
    if (!f) throw new GlNotFoundError('GlFiscalYear', id);
    if (f.state === 'CLOSED') throw new LedgerHttpError(409, 'السنة المالية مقفلة', { reason: 'CLOSED' });
    const dateFrom = body.dateFrom ?? fromDbDate(f.dateFrom);
    const dateTo = body.dateTo ?? fromDbDate(f.dateTo);
    if (body.dateFrom !== undefined || body.dateTo !== undefined) {
      await assertFiscalYearFree(tx, tenantId, dateFrom, dateTo, id);
      // المدى الواقع تحت الإقفال النهائي مجمَّد (G4)
      const s = await tx.glSettings.findUnique({ where: { tenantId }, select: { hardLockDate: true } });
      const hard = dateOut(s?.hardLockDate);
      const oldFrom = fromDbDate(f.dateFrom);
      if (hard && compareLocalDate(minDate(oldFrom, dateFrom), hard) <= 0 && (dateFrom !== oldFrom || dateTo !== fromDbDate(f.dateTo))) {
        throw new LedgerHttpError(409, 'السنة المالية ضمن الإقفال النهائي', { reason: 'HARD_LOCKED', hardLockDate: hard });
      }
    }
    const u = await tx.glFiscalYear.update({
      where: { id },
      data: { ...(body.name !== undefined ? { name: body.name } : {}), dateFrom: toDbDate(dateFrom), dateTo: toDbDate(dateTo) },
    });
    const d = diffOf(fiscalYearOut(f), fiscalYearOut(u));
    if (d.changed.length) {
      await appendAudit(tx, {
        tenantId, actor, action: 'SETTINGS_CHANGE', entityType: 'FISCAL_YEAR', entityId: id,
        summary: `تعديل السنة المالية ${u.name}`, before: d.before, after: d.after,
      });
    }
    return u;
  }, TX_OPTS);
  res.json({ success: true, data: fiscalYearOut(fy) });
}));

const minDate = (a: string, b: string) => (compareLocalDate(a, b) <= 0 ? a : b);

// ═══ الوسوم ═══

const tagSchema = z.object({
  name: z.string().trim().min(1).max(100),
  nameEn: z.string().trim().max(100).nullish(),
  applicability: z.enum(['ACCOUNTS', 'REPORTS']).optional(),
});

type TagRow = Prisma.GlAccountTagGetPayload<object>;
const tagOut = (t: TagRow, accountCount?: number) => ({
  id: t.id, name: t.name, nameEn: t.nameEn, applicability: t.applicability, ...(accountCount === undefined ? {} : { accountCount }),
});

router.get('/tags', CONFIGURE, ledgerHandler(async (_req, res) => {
  const { tenantId } = ledgerOf(res);
  const rows = await prisma.glAccountTag.findMany({ where: { tenantId }, orderBy: { name: 'asc' }, include: { _count: { select: { links: true } } } });
  res.json({ success: true, data: rows.map(({ _count, ...t }) => tagOut(t, _count.links)) });
}));

router.post('/tags', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const body = tagSchema.parse(req.body);
  const actor = actorOf(req, res);
  const t = await prisma.$transaction(async (tx) => {
    const dup = await tx.glAccountTag.findFirst({ where: { tenantId, name: body.name }, select: { id: true } });
    if (dup) throw new LedgerHttpError(409, 'اسم الوسم مستخدم', { reason: 'NAME_EXISTS', field: 'name', tagId: dup.id });
    const created = await tx.glAccountTag.create({ data: { tenantId, name: body.name, nameEn: body.nameEn ?? null, applicability: body.applicability ?? 'ACCOUNTS' } });
    await appendAudit(tx, {
      tenantId, actor, action: 'SETTINGS_CHANGE', entityType: 'ACCOUNT_TAG', entityId: created.id,
      summary: `إنشاء الوسم ${created.name}`, after: tagOut(created),
    });
    return created;
  }, TX_OPTS);
  res.status(201).json({ success: true, data: tagOut(t, 0) });
}));

router.put('/tags/:id', CONFIGURE, ledgerHandler(async (req, res) => {
  const { tenantId } = ledgerOf(res);
  const id = String(req.params.id);
  const body = tagSchema.partial().parse(req.body);
  const actor = actorOf(req, res);
  const t = await prisma.$transaction(async (tx) => {
    const cur = await tx.glAccountTag.findFirst({ where: { id, tenantId } });
    if (!cur) throw new GlNotFoundError('GlAccountTag', id);
    if (body.name !== undefined && body.name !== cur.name) {
      const dup = await tx.glAccountTag.findFirst({ where: { tenantId, name: body.name, id: { not: id } }, select: { id: true } });
      if (dup) throw new LedgerHttpError(409, 'اسم الوسم مستخدم', { reason: 'NAME_EXISTS', field: 'name', tagId: dup.id });
    }
    const u = await tx.glAccountTag.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.nameEn !== undefined ? { nameEn: body.nameEn ?? null } : {}),
        ...(body.applicability !== undefined ? { applicability: body.applicability } : {}),
      },
    });
    const d = diffOf(tagOut(cur), tagOut(u));
    if (d.changed.length) {
      await appendAudit(tx, {
        tenantId, actor, action: 'SETTINGS_CHANGE', entityType: 'ACCOUNT_TAG', entityId: id,
        summary: `تعديل الوسم ${u.name}`, before: d.before, after: d.after,
      });
    }
    return u;
  }, TX_OPTS);
  const count = await prisma.glAccountTagLink.count({ where: { tenantId, tagId: id } });
  res.json({ success: true, data: tagOut(t, count) });
}));

export default router;
