import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, ledgerActor, type GlActor } from '../../services/gl/audit';
import { POST_TX_OPTIONS, isLedgerActivated, type AutoPostDb } from '../../services/gl/autoPost';
import { fromDbDate } from '../../services/gl/dates';
import { fromMilli, toMilli } from '../../services/gl/money';
import { acquirePostLock, postMove } from '../../services/gl/post';
import { GlNotFoundError, loadBuildContext, type GlDb, type LedgerContext } from '../../services/gl/resolve';
import {
  CLEARING_KINDS, CLEARING_KIND_LABELS, buildClearingMove, clearingAccountOf, clearingInputProblems, clearingSourceRef,
  isClearingKind, openClearingLines, openResidualTotal, planClearingMatches,
  type ClearingInput, type ClearingKind, type ClearingLineRow, type ClearingOpenLine, type ClearingProblemReason,
} from '../../services/gl/builders/clearing';
import { LedgerError, type Milli } from '../../services/gl/types';

/**
 * «ربط الدفاتر» L5 — التسوية الموجّهة للحسابات الوسيطة (العقد §5.2، C3/C5؛ الواجهة: الدفاتر ← العملاء ← «تسوية الحسابات الوسيطة»).
 *
 * - `GET /clearing/open?kind=`: السطور المدينة المفتوحة على الحساب الوسيط للنوع (المتبقّي بعد مطابقات CLR وبعد زوج العكس)،
 *   بالأقدم فالأقدم، مع مجموعها ورصيد الحساب وحسابات البنك المرشّحة. قراءة بـcanViewLedger.
 * - `POST /clearing`: قيد يدوي مرحّل (origin MANUAL، دفتر البنك، validationMode MANUAL) يُصفّي الوسيط بالإجمالي ويثبت العمولة
 *   وضريبتها، ثم GlPartialReconcile بـCLR:<moveId> بين السطور المختارة (أو الأقدم فالأقدم) وسطر الدائن، ثم تدقيق RECONCILE —
 *   في معاملة واحدة بعد قفل الترحيل، فلا تُطابَق ثانيةً سطورٌ طابقتها تسويةٌ متزامنة. canPostJournals.
 * - الأخطاء: 422 LEDGER_CLEARING_INVALID بـreason (مبالغ غير متّسقة، أو حساب بنك غير صالح، أو سطر من حساب آخر، أو إجمالي فوق
 *   المفتوح أو فوق رصيد الوسيط)، و404 لسطر لا ينتمي للشركة، و409 LEDGER_NOT_SETUP قبل التفعيل.
 * لا يمسّ المسارات التشغيلية ولا أحداث المزامنة: مستند دفاتر خالص يعكسه المحاسب من «القيود» كأي قيد يدوي، فتسقط مطابقاته
 * من حساب المتبقّي (مطابقةٌ قيدُ دائنها معكوس لا تُحتسب).
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');
const POST = requireLedgerPermission('canPostJournals');

const locals = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(locals(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });

/** سقف السطور المفتوحة المقروءة للحساب الواحد (حارس ذاكرة على قاعدة 0.1 نواة)، وسقف ما يُعرض منها */
export const OPEN_LINES_SCAN_CAP = 5000;
export const OPEN_LINES_PAGE = 1000;
/** سقف السطور المختارة في الطلب الواحد */
export const CLEARING_LINE_IDS_LIMIT = 1000;

// ═══ الرسائل ═══

export type ClearingRouteReason = ClearingProblemReason | 'LINE_OTHER_ACCOUNT' | 'LINE_NOT_OPEN' | 'EXCEEDS_OPEN' | 'EXCEEDS_BALANCE';

const REASON_MESSAGES: Readonly<Record<ClearingRouteReason, string>> = {
  INVALID_KIND: 'نوع التسوية غير معروف',
  INVALID_DATE: 'تاريخ غير صالح',
  GROSS_NOT_POSITIVE: 'الإجمالي يجب أن يكون أكبر من صفر',
  FEE_NEGATIVE: 'العمولة لا تكون سالبة',
  FEE_VAT_NEGATIVE: 'ضريبة العمولة لا تكون سالبة',
  FEES_EXCEED_GROSS: 'العمولة وضريبتها أكبر من الإجمالي',
  FEE_VAT_WITHOUT_FEE: 'ضريبة العمولة بلا عمولة',
  PRECISION: 'المبلغ بمنازل عشرية أكثر مما تسمح به عملة الدفاتر',
  BANK_ACCOUNT_NOT_FOUND: 'حساب البنك غير موجود',
  BANK_ACCOUNT_INACTIVE: 'حساب البنك مؤرشف',
  BANK_ACCOUNT_NOT_CASH: 'الحساب المستلِم يجب أن يكون حساب نقد أو بنك',
  BANK_ACCOUNT_CONTROL: 'لا يجوز الإيداع في حساب رئيسي كعهدة المندوب أو المستخدم',
  CLEARING_ACCOUNT_MISSING: 'الحساب الوسيط لهذا النوع غير موجود في دليل الحسابات',
  CLEARING_ACCOUNT_INACTIVE: 'الحساب الوسيط لهذا النوع مؤرشف',
  BANK_IS_CLEARING: 'حساب البنك هو الحساب الوسيط نفسه',
  FEE_ACCOUNT_MISSING: 'حساب الرسوم البنكية غير مربوط أو مؤرشف',
  VAT_TAX_UNAVAILABLE: 'لا توجد ضريبة مشتريات صالحة لضريبة العمولة: أدخل العمولة شاملة الضريبة أو فعّل ضريبة المشتريات',
  LINE_OTHER_ACCOUNT: 'سطر مختار من حساب غير الحساب الوسيط لهذا النوع',
  LINE_NOT_OPEN: 'سطر مختار غير مفتوح: مطابَق بالكامل أو ليس سطراً مديناً مرحّلاً',
  EXCEEDS_OPEN: 'الإجمالي أكبر من المتبقّي المفتوح في السطور المختارة',
  EXCEEDS_BALANCE: 'الإجمالي أكبر من رصيد الحساب الوسيط',
};

export function clearingInvalid(reason: ClearingRouteReason, details: Record<string, unknown> = {}): LedgerHttpError {
  return new LedgerHttpError(422, REASON_MESSAGES[reason], { reason, ...details }, 'LEDGER_CLEARING_INVALID');
}

// ═══ المدخلات ═══

const amountInput = z.union([z.number().finite(), z.string().trim().min(1).max(40)]);

export const clearingBodySchema = z.object({
  kind: z.enum(CLEARING_KINDS),
  date: z.string().max(10),
  bankAccountId: z.string().min(1).max(64),
  gross: amountInput,
  fee: amountInput.nullish(),
  feeVat: amountInput.nullish(),
  ref: z.string().max(200).nullish(),
  note: z.string().max(1000).nullish(),
  lineIds: z.array(z.string().min(1).max(64)).max(CLEARING_LINE_IDS_LIMIT).nullish(),
});
export type ClearingBody = z.infer<typeof clearingBodySchema>;

/** مبلغ الطلب ⇐ ملّي بدقة الألف — التحقق من منازل العملة في clearingInputProblems (PRECISION) لا تقريب صامت */
export function amountMilliOf(v: number | string | null | undefined, field: string): Milli {
  if (v === null || v === undefined || v === '') return 0n;
  try {
    return toMilli(v, 3);
  } catch {
    throw new LedgerHttpError(400, 'مبلغ غير صالح', { reason: 'INVALID_AMOUNT', field });
  }
}

/** دفتر البنك المستلِم: دفتر BANK (ثم CASH) نشط حسابه الافتراضي هو الحساب المختار — وإلا البنك الرئيسي (null) */
export function bankJournalCodeFor(lc: Pick<LedgerContext, 'journals'>, bankAccountId: string): string | null {
  const own = lc.journals.filter((j) => j.isActive && j.defaultAccountId === bankAccountId && (j.type === 'BANK' || j.type === 'CASH'));
  const bank = own.find((j) => j.type === 'BANK') ?? own[0];
  return bank ? bank.code : null;
}

export function clearingInputOf(body: ClearingBody, lc: Pick<LedgerContext, 'journals'>): ClearingInput {
  const lineIds = [...new Set((body.lineIds ?? []).map((s) => s.trim()).filter(Boolean))];
  return {
    kind: body.kind,
    date: body.date.trim(),
    bankAccountId: body.bankAccountId.trim(),
    grossMilli: amountMilliOf(body.gross, 'gross'),
    feeMilli: amountMilliOf(body.fee, 'fee'),
    feeVatMilli: amountMilliOf(body.feeVat, 'feeVat'),
    ref: body.ref?.trim() || null,
    note: body.note?.trim() || null,
    ...(lineIds.length ? { openLineIds: lineIds } : {}),
    journalCode: bankJournalCodeFor(lc, body.bankAccountId.trim()),
  };
}

// ═══ القراءة: السطور المفتوحة ورصيد الحساب ═══

export type ClearingReadDb = Pick<GlDb, '$queryRaw' | 'glMove' | 'glMoveLine'>;

interface RawOpenRow {
  lineId: string;
  moveId: string;
  moveNumber: string | null;
  date: Date;
  label: string | null;
  seq: number;
  debitMilli: bigint;
  matchedMilli: bigint;
  reversesMoveId: string | null;
  isReversed: boolean;
}

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(String(v ?? 0)));

/**
 * السطور المدينة المرحّلة على الحساب التي لم تُطابَق كاملةً — استعلام واحد مجمّع (لا N+1):
 * المطابَق = Σ مطابقات السطر إلا ما كان قيد دائنها معكوساً (تسوية عُكست تعيد سطورها مفتوحة). ثم دفعتان لزوج العكس:
 * دائن العكس على الحساب نفسه يقابل مدين الأصل، ودائن الأصل يقابل مدين قيده العاكس.
 */
export async function loadOpenClearingLines(
  db: ClearingReadDb, tenantId: string, accountId: string,
): Promise<{ lines: ClearingOpenLine[]; truncated: boolean }> {
  const raw = await db.$queryRaw<RawOpenRow[]>`
    WITH "acct" AS (
      SELECT l."id", l."moveId", l."seq", l."date", l."label", l."debitMilli"
      FROM "gl_move_lines" l
      WHERE l."tenantId" = ${tenantId} AND l."accountId" = ${accountId} AND l."posted" = true AND l."debitMilli" > 0
    ), "matched" AS (
      SELECT p."debitLineId" AS "lineId", SUM(p."amountMilli") AS "amt"
      FROM "gl_partial_reconciles" p
      JOIN "acct" a ON a."id" = p."debitLineId"
      WHERE p."tenantId" = ${tenantId}
        AND NOT EXISTS (
          SELECT 1 FROM "gl_moves" r
          WHERE r."tenantId" = ${tenantId} AND r."state" = 'POSTED' AND r."reversedMoveId" = p."creditMoveId"
        )
      GROUP BY p."debitLineId"
    )
    SELECT a."id" AS "lineId", a."moveId" AS "moveId", m."number" AS "moveNumber", a."date" AS "date", a."label" AS "label",
           a."seq" AS "seq", a."debitMilli" AS "debitMilli", COALESCE(mt."amt", 0)::bigint AS "matchedMilli",
           m."reversedMoveId" AS "reversesMoveId",
           EXISTS (
             SELECT 1 FROM "gl_moves" r2
             WHERE r2."tenantId" = ${tenantId} AND r2."state" = 'POSTED' AND r2."reversedMoveId" = a."moveId"
           ) AS "isReversed"
    FROM "acct" a
    JOIN "gl_moves" m ON m."id" = a."moveId" AND m."tenantId" = ${tenantId} AND m."state" = 'POSTED'
    LEFT JOIN "matched" mt ON mt."lineId" = a."id"
    WHERE a."debitMilli" > COALESCE(mt."amt", 0)
    ORDER BY a."date" ASC, a."moveId" ASC, a."seq" ASC
    LIMIT ${OPEN_LINES_SCAN_CAP + 1}`;
  const truncated = raw.length > OPEN_LINES_SCAN_CAP;
  const rows = truncated ? raw.slice(0, OPEN_LINES_SCAN_CAP) : raw;

  const pair = new Map<string, Milli>();
  const add = (moveId: string, v: Milli) => pair.set(moveId, (pair.get(moveId) ?? 0n) + v);
  const reversedIds = [...new Set(rows.filter((r) => r.isReversed).map((r) => r.moveId))];
  const originalOf = new Map<string, string>(); // الأصل ⇐ قيده العاكس (من السطور المحمّلة)
  for (const r of rows) if (r.reversesMoveId) originalOf.set(r.reversesMoveId, r.moveId);
  const [reversals, originals] = await Promise.all([
    reversedIds.length
      ? db.glMove.findMany({
        where: { tenantId, state: 'POSTED', reversedMoveId: { in: reversedIds } },
        select: { reversedMoveId: true, lines: { where: { accountId }, select: { creditMilli: true } } },
      })
      : Promise.resolve([]),
    originalOf.size
      ? db.glMoveLine.groupBy({
        by: ['moveId'],
        where: { tenantId, accountId, posted: true, moveId: { in: [...originalOf.keys()] } },
        _sum: { creditMilli: true },
      })
      : Promise.resolve([]),
  ]);
  for (const r of reversals) {
    if (!r.reversedMoveId) continue;
    for (const l of r.lines) add(r.reversedMoveId, big(l.creditMilli));
  }
  for (const g of originals as unknown as { moveId: string; _sum: { creditMilli: bigint | null } }[]) {
    const reversal = originalOf.get(g.moveId);
    if (reversal) add(reversal, big(g._sum.creditMilli ?? 0n));
  }

  const lineRows: ClearingLineRow[] = rows.map((r) => ({
    lineId: r.lineId, moveId: r.moveId, moveNumber: r.moveNumber, date: fromDbDate(new Date(r.date)), label: r.label,
    seq: Number(r.seq), debitMilli: big(r.debitMilli), matchedMilli: big(r.matchedMilli),
  }));
  return { lines: openClearingLines(lineRows, pair), truncated };
}

/** رصيد الحساب المرحّل (مدين − دائن) */
export async function loadAccountBalance(db: Pick<GlDb, 'glMoveLine'>, tenantId: string, accountId: string): Promise<Milli> {
  const agg = await db.glMoveLine.aggregate({
    where: { tenantId, accountId, posted: true },
    _sum: { debitMilli: true, creditMilli: true },
  });
  return big(agg._sum.debitMilli ?? 0n) - big(agg._sum.creditMilli ?? 0n);
}

// ═══ الترحيل والمطابقة (معاملة واحدة) ═══

export type ClearingTx = GlDb;

/** نقاط الحقن للاختبار بمخزن مزيّف — الافتراضي الدوال الحقيقية */
export interface ClearingDeps {
  acquirePostLock(tx: ClearingTx, tenantId: string): Promise<void>;
  loadBuildContext(tx: ClearingTx, tenantId: string): Promise<LedgerContext>;
  loadOpenLines(tx: ClearingTx, tenantId: string, accountId: string): Promise<{ lines: ClearingOpenLine[]; truncated: boolean }>;
  loadAccountBalance(tx: ClearingTx, tenantId: string, accountId: string): Promise<Milli>;
  postMove: typeof postMove;
  appendAudit: typeof appendAudit;
}

export const DEFAULT_CLEARING_DEPS: ClearingDeps = {
  acquirePostLock,
  loadBuildContext,
  loadOpenLines: loadOpenClearingLines,
  loadAccountBalance,
  postMove,
  appendAudit,
};

export interface ClearingResult {
  moveId: string;
  moveNumber: string;
  date: string;
  kind: ClearingKind;
  clearingAccount: { id: string; code: string; name: string };
  bankAccountId: string;
  gross: number;
  fee: number;
  feeVat: number;
  net: number;
  sourceRef: string;
  matched: { lineId: string; moveId: string; amount: number }[];
  matchedTotal: number;
}

/**
 * التسوية الموجّهة كاملةً داخل معاملة tx: القفل ⇒ السياق ⇒ التحقق ⇒ السطور المفتوحة تحت القفل ⇒ القيد ⇒ المطابقات ⇒ التدقيق.
 * أي خطأ يُسقط المعاملة كلها (لا قيد بلا مطابقاته ولا مطابقة بلا قيدها).
 */
export async function executeClearing(
  tx: ClearingTx, req: { tenantId: string; actor: GlActor; body: ClearingBody }, deps: ClearingDeps = DEFAULT_CLEARING_DEPS,
): Promise<ClearingResult> {
  const { tenantId, actor } = req;
  // القفل أولاً: المتبقّي يُقرأ تحته فلا تتجاوز تسويتان متزامنتان سطراً واحداً (postMove يعيد أخذه في المعاملة نفسها)
  await deps.acquirePostLock(tx, tenantId);
  const lc = await deps.loadBuildContext(tx, tenantId);
  if (!lc.settings) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });
  const ctx = lc.ctx;
  const input = clearingInputOf(req.body, lc);

  const problems = clearingInputProblems(input, ctx);
  if (problems.length > 0) throw clearingInvalid(problems[0].reason, { field: problems[0].field, problems });
  const clearing = clearingAccountOf(input.kind, ctx);
  if (!clearing) throw clearingInvalid('CLEARING_ACCOUNT_MISSING');

  const open = await deps.loadOpenLines(tx, tenantId, clearing.id);
  let candidates = open.lines;
  if (input.openLineIds && input.openLineIds.length > 0) {
    const openById = new Map(open.lines.map((l) => [l.lineId, l]));
    const missing = input.openLineIds.filter((id) => !openById.has(id));
    if (missing.length > 0) {
      const found = await tx.glMoveLine.findMany({
        where: { tenantId, id: { in: missing } },
        select: { id: true, accountId: true },
      });
      const byId = new Map(found.map((l) => [l.id, l]));
      for (const id of missing) {
        const l = byId.get(id);
        if (!l) throw new GlNotFoundError('GlMoveLine', id); // العزل §9.4: سطر شركة أخرى كغير الموجود
        if (l.accountId !== clearing.id) throw clearingInvalid('LINE_OTHER_ACCOUNT', { lineId: id, accountCode: clearing.code });
        throw clearingInvalid('LINE_NOT_OPEN', { lineId: id });
      }
    }
    const chosen = new Set(input.openLineIds);
    candidates = open.lines.filter((l) => chosen.has(l.lineId));
  }

  const gross = input.grossMilli;
  const available = openResidualTotal(candidates);
  if (gross > available) {
    throw clearingInvalid('EXCEEDS_OPEN', { gross: fromMilli(gross), available: fromMilli(available), truncated: open.truncated });
  }
  // دفاع ثانٍ: لا يصير للوسيط رصيد دائن ولو سبقته قيود يدوية دائنة غير مطابَقة
  const balance = await deps.loadAccountBalance(tx, tenantId, clearing.id);
  if (gross > balance) throw clearingInvalid('EXCEEDS_BALANCE', { gross: fromMilli(gross), balance: fromMilli(balance) });

  const draft = buildClearingMove(input, ctx);
  const posted = await deps.postMove(tx, draft, {
    tenantId, actor, context: lc, validationMode: 'MANUAL', lockPolicy: 'REJECT',
    auditAction: 'MOVE_POST', auditExtra: { clearingKind: input.kind, clearingAccountId: clearing.id },
  });

  const creditLine = await tx.glMoveLine.findFirst({
    where: { tenantId, moveId: posted.id, accountId: clearing.id, creditMilli: { gt: 0n } },
    select: { id: true },
  });
  if (!creditLine) throw new LedgerError('LEDGER_CLEARING_INVALID', { reason: 'CREDIT_LINE_MISSING', moveId: posted.id });
  const sourceRef = clearingSourceRef(posted.id);
  const matches = planClearingMatches(candidates, { lineId: creditLine.id, moveId: posted.id }, gross, sourceRef);
  if (matches.length > 0) {
    await tx.glPartialReconcile.createMany({
      data: matches.map((m) => ({
        tenantId, debitLineId: m.debitLineId, creditLineId: m.creditLineId, amountMilli: m.amountMilli,
        sourceRef: m.sourceRef, debitMoveId: m.debitMoveId, creditMoveId: m.creditMoveId, createdBy: actor.actorId,
      })),
      skipDuplicates: true,
    });
  }
  const matchedTotal = matches.reduce((s, m) => s + m.amountMilli, 0n);
  const fee = input.feeMilli ?? 0n;
  const feeVat = input.feeVatMilli ?? 0n;
  await deps.appendAudit(tx, {
    tenantId, actor, action: 'RECONCILE', entityType: 'MOVE', entityId: posted.id,
    summary: `${CLEARING_KIND_LABELS[input.kind]} بالقيد ${posted.number}: مطابقة ${matches.length} سطراً`,
    after: {
      kind: input.kind, sourceRef, moveNumber: posted.number, clearingAccountCode: clearing.code, bankAccountId: input.bankAccountId,
      grossMilli: gross, feeMilli: fee, feeVatMilli: feeVat, matchedMilli: matchedTotal,
      matches: matches.map((m) => ({ debitLineId: m.debitLineId, debitMoveId: m.debitMoveId, amountMilli: m.amountMilli })),
    },
  });

  return {
    moveId: posted.id,
    moveNumber: posted.number,
    date: posted.date,
    kind: input.kind,
    clearingAccount: { id: clearing.id, code: clearing.code, name: clearing.name },
    bankAccountId: input.bankAccountId,
    gross: fromMilli(gross),
    fee: fromMilli(fee),
    feeVat: fromMilli(feeVat),
    net: fromMilli(gross - fee - feeVat),
    sourceRef,
    matched: matches.map((m) => ({ lineId: m.debitLineId, moveId: m.debitMoveId, amount: fromMilli(m.amountMilli) })),
    matchedTotal: fromMilli(matchedTotal),
  };
}

// ═══ المسارات ═══

function kindParam(v: unknown): ClearingKind {
  const s = Array.isArray(v) ? v[0] : v;
  if (!isClearingKind(s)) throw new LedgerHttpError(400, REASON_MESSAGES.INVALID_KIND, { reason: 'INVALID_KIND', allowed: CLEARING_KINDS });
  return s;
}

router.get('/clearing/open', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const kind = kindParam(req.query.kind);
  const db = prisma as unknown as GlDb;
  const lc = await loadBuildContext(db, tenantId);
  if (!lc.settings) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });
  const account = clearingAccountOf(kind, lc.ctx);
  if (!account) throw clearingInvalid('CLEARING_ACCOUNT_MISSING');
  const [open, balance] = await Promise.all([
    loadOpenClearingLines(db, tenantId, account.id),
    loadAccountBalance(db, tenantId, account.id),
  ]);
  const total = openResidualTotal(open.lines);
  res.json({
    success: true,
    data: {
      kind,
      account: { id: account.id, code: account.code, name: account.name, isActive: account.isActive },
      currency: lc.ctx.settings.currency,
      decimals: lc.ctx.settings.currencyDecimals,
      balance: fromMilli(balance),
      lines: open.lines.slice(0, OPEN_LINES_PAGE).map((l) => ({
        lineId: l.lineId, moveId: l.moveId, moveNumber: l.moveNumber, date: l.date, label: l.label,
        amount: fromMilli(l.amountMilli), residual: fromMilli(l.residualMilli),
      })),
      total: fromMilli(total),
      count: open.lines.length,
      truncated: open.truncated || open.lines.length > OPEN_LINES_PAGE,
      // الحسابات المستلِمة المقبولة في POST: نقد/بنك نشط غير رقابي وليس الوسيط نفسه
      bankAccounts: lc.accounts
        .filter((a) => a.isActive && a.type === 'asset_cash' && a.controlKind === null && a.id !== account.id)
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map((a) => ({ id: a.id, code: a.code, name: a.name })),
    },
  });
}));

router.post('/clearing', POST, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const body = clearingBodySchema.parse(req.body);
  if (!(await isLedgerActivated(prisma as unknown as AutoPostDb, tenantId))) {
    throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'NOT_ACTIVATED' });
  }
  const actor = actorOf(req, res);
  const data = await prisma.$transaction((tx) => executeClearing(tx, { tenantId, actor, body }), POST_TX_OPTIONS);
  res.status(201).json({ success: true, data });
}));

export default router;
