/**
 * «ربط الدفاتر» L8 — مخزن المطابقة الجزئية بـPrisma (عقد §3.7). يعمل داخل معاملة المستدعي (PostingTx أو مسار M4)،
 * وكل استعلام مقيّد بـtenantId (§9.4)، ولا حلقة استعلامات: المتبقّي لسطور القيد في استعلامين، والقيود الحيّة لعدة
 * مفاتيح في استعلام واحد.
 */
import { Prisma } from '@prisma/client';
import type { GlDb } from '../resolve';
import { fromDbDate, isLocalDate } from '../dates';
import { toMilli } from '../money';
import { receiptKey } from '../sync/keys';
import { invoiceKey, repostKey } from '../sync/keys';
import { MAX_CURRENCY_DECIMALS } from '../money';
import type { LocalDate } from '../types';
import {
  adjustmentAllocationRef, controlLineSide, receiptAllocationRef,
  type OpenControlLine, type PartialInsert, type PartialRow, type PendingAllocation, type ReconcileKind,
  type ReconcileSide, type ReconcileStore,
} from './types';
import { creditNoteRef, returnRef, type PendingReturn } from './types';

/** منشئ المطابقة الآلية في صفّ GlPartialReconcile (لا تدقيق لكل مطابقة آلية، §6.1) */
export const RECONCILE_SYSTEM_ACTOR = 'SYSTEM';
/** حجم دفعة قوائم IN */
const ID_CHUNK = 2_000;
/** سقف دفاعي لمسح سطور شريك واحد بحثاً عن المفتوح (FIFO) */
const OPEN_SCAN_CAP = 50_000;

const LINE_SELECT = {
  id: true, moveId: true, accountId: true, seq: true, date: true, dueDate: true,
  debitMilli: true, creditMilli: true, customerId: true, vendorId: true,
} as const;

type LineRow = Prisma.GlMoveLineGetPayload<{ select: typeof LINE_SELECT }>;

function chunks<T>(xs: readonly T[], n = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Σ المطابقات لكل سطر (من الجهتين)، مع إزالة تكرار الصفّ الواقع في دفعتين */
async function matchedSums(tx: GlDb, tenantId: string, lineIds: readonly string[]): Promise<Map<string, bigint>> {
  const want = new Set(lineIds);
  const seen = new Set<string>();
  const out = new Map<string, bigint>();
  for (const part of chunks([...want])) {
    const rows = await tx.glPartialReconcile.findMany({
      where: { tenantId, OR: [{ debitLineId: { in: part } }, { creditLineId: { in: part } }] },
      select: { id: true, debitLineId: true, creditLineId: true, amountMilli: true },
    });
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (want.has(r.debitLineId)) out.set(r.debitLineId, (out.get(r.debitLineId) ?? 0n) + r.amountMilli);
      if (want.has(r.creditLineId)) out.set(r.creditLineId, (out.get(r.creditLineId) ?? 0n) + r.amountMilli);
    }
  }
  return out;
}

function toOpenLines(rows: readonly LineRow[], kind: ReconcileKind, matched: ReadonlyMap<string, bigint>): OpenControlLine[] {
  const out: OpenControlLine[] = [];
  for (const r of rows) {
    const partnerId = kind === 'AR' ? r.customerId : r.vendorId;
    if (!partnerId) continue;
    const s = controlLineSide(r.debitMilli, r.creditMilli);
    if (!s) continue;
    out.push({
      lineId: r.id, moveId: r.moveId, accountId: r.accountId, kind, partnerId, side: s.side,
      amountMilli: s.amountMilli, residualMilli: s.amountMilli - (matched.get(r.id) ?? 0n),
      date: fromDbDate(r.date), dueDate: r.dueDate ? fromDbDate(r.dueDate) : null, seq: r.seq,
    });
  }
  return out;
}

/** حدّ دفاعي لطول سلسلة إعادة الترحيل (REPOST:1..n) لمفتاح واحد — n واقعياً آحاد */
const REPOST_CHAIN_CAP = 1_000;

/**
 * «القيد الحيّ» لكل مفتاح POST أساس — بالقاعدة نفسها لـPrismaPostingTx.findLiveMove (§5.4، §6.1): آخر قيد POSTED غير
 * معكوس تحت المفتاح الأساس أو REPOST:<n> منه. **بمفاتيح دقيقة على الفهرس الفريد (tenantId, sourceKey) لا بـLIKE**: بادئة
 * startsWith بوسيطٍ وترتيبٍ غير C لا تستعمل الفهرس، فكانت تمسح كل مفاتيح الشركة مع كل سند مخصّص داخل قفل الترحيل.
 * القيد الأساس حيّ (الغالب) ⇒ استعلام واحد للدفعة كلها. معكوسٌ ⇒ إعادة الترحيل التالية REPOST:<n> بعينها: n = 1 + عدد
 * السابقة (keys.nextRepostIndex) والقيود المرحّلة لا تُحذف، فالسلسلة متّصلة والحيّ آخرها إن لم يُعكس (REPOST_REV قيد عكس).
 */
export async function liveMoveIdsOf(tx: GlDb, tenantId: string, baseKeys: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  /** المفتاح المطلوب في هذه الخطوة ⇒ أساسه */
  let frontier = new Map<string, string>();
  for (const k of new Set(baseKeys)) frontier.set(k, k);
  for (let n = 0; frontier.size > 0 && n <= REPOST_CHAIN_CAP; n++) {
    const next = new Map<string, string>();
    for (const part of chunks([...frontier.keys()])) {
      const rows = await tx.glMoveSource.findMany({
        where: { tenantId, sourceKey: { in: part } },
        select: {
          sourceKey: true,
          move: { select: { id: true, state: true, reversedMoveId: true, reversal: { select: { id: true } } } },
        },
      });
      for (const r of rows) {
        const base = frontier.get(r.sourceKey);
        if (!base) continue;
        if (r.move.state === 'POSTED' && !r.move.reversedMoveId && !r.move.reversal) out.set(base, r.move.id);
        else next.set(repostKey(base, n + 1), base);
      }
    }
    frontier = next;
  }
  return out;
}

export function createPrismaReconcileStore(tx: GlDb, tenantId: string): ReconcileStore {
  let decimals: number | null = null;
  const currencyDecimals = async (): Promise<number> => {
    if (decimals === null) {
      const s = await tx.glSettings.findUnique({ where: { tenantId }, select: { currencyDecimals: true } });
      decimals = s?.currencyDecimals ?? 2;
    }
    return decimals;
  };

  return {
    async controlLinesOfMove(moveId: string, kind: ReconcileKind): Promise<OpenControlLine[]> {
      const rows = await tx.glMoveLine.findMany({
        where: { tenantId, moveId, posted: true, account: { controlKind: kind } },
        select: LINE_SELECT,
        orderBy: { seq: 'asc' },
      });
      if (rows.length === 0) return [];
      return toOpenLines(rows, kind, await matchedSums(tx, tenantId, rows.map((r) => r.id)));
    },

    async controlLinesOfMoves(moveIds: readonly string[], kind: ReconcileKind): Promise<Map<string, OpenControlLine[]>> {
      const out = new Map<string, OpenControlLine[]>();
      const ids = [...new Set(moveIds)];
      for (const id of ids) out.set(id, []);
      for (const part of chunks(ids)) {
        const rows = await tx.glMoveLine.findMany({
          where: { tenantId, moveId: { in: part }, posted: true, account: { controlKind: kind } },
          select: LINE_SELECT,
          orderBy: [{ moveId: 'asc' }, { seq: 'asc' }],
        });
        if (rows.length === 0) continue;
        for (const l of toOpenLines(rows, kind, await matchedSums(tx, tenantId, rows.map((r) => r.id)))) {
          (out.get(l.moveId) as OpenControlLine[]).push(l);
        }
      }
      return out;
    },

    async liveMoveIdOf(baseKey: string): Promise<string | null> {
      return (await liveMoveIdsOf(tx, tenantId, [baseKey])).get(baseKey) ?? null;
    },

    async liveMoveIdsOf(baseKeys: readonly string[]): Promise<Map<string, string>> {
      return liveMoveIdsOf(tx, tenantId, baseKeys);
    },

    async pendingAllocationsForInvoice(invoiceId: string): Promise<PendingAllocation[]> {
      // فحص رخيص بالمفتاح الأساسي أولاً: فاتورة لم يُسقط منها شيء (المتبقّي = الإجمالي) لا تخصيص لها — فلا مسح لجدول التخصيصات
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { total: true, remainingAmt: true } });
      if (!inv) return [];
      const dec = await currencyDecimals();
      if (toMilli(inv.remainingAmt, dec) >= toMilli(inv.total, dec)) return [];

      const [ris, cas] = await Promise.all([
        tx.receiptInvoice.findMany({ where: { invoiceId, receipt: { tenantId } }, select: { id: true, receiptId: true } }),
        tx.customerAdjustmentAllocation.findMany({ where: { tenantId, invoiceId }, select: { id: true, amount: true, adjustmentId: true } }),
      ]);
      const wanted: { sourceRef: string; baseKey: string | null; creditMoveId: string | null; amountMilli: bigint }[] = [];

      // RI: مبلغ التخصيص من لقطة حمولة RECEIPT:POST المرحَّل (لا من الصفّ الحيّ) — ما رُحّل هو ما يُطابَق
      if (ris.length > 0) {
        const keyOf = new Map(ris.map((r) => [receiptKey(r.receiptId, 'POST'), r]));
        const events = await tx.glSourceEvent.findMany({
          where: { tenantId, sourceKey: { in: [...keyOf.keys()] }, status: 'DONE' },
          select: { sourceKey: true, payload: true },
        });
        for (const e of events) {
          const ri = keyOf.get(e.sourceKey);
          const allocs = (e.payload as { allocations?: readonly { id: string; invoiceId: string; amount: string }[] } | null)?.allocations;
          const a = allocs?.find((x) => x.id === ri?.id && x.invoiceId === invoiceId);
          if (!ri || !a) continue;
          wanted.push({ sourceRef: receiptAllocationRef(a.id), baseKey: e.sourceKey, creditMoveId: null, amountMilli: toMilli(a.amount, 3) });
        }
      }

      // CA: شطب نشط له قيد (المسار M4 يرحّله مباشرةً)
      if (cas.length > 0) {
        const adjs = await tx.customerAdjustment.findMany({
          where: { tenantId, id: { in: [...new Set(cas.map((c) => c.adjustmentId))] }, status: 'ACTIVE', moveId: { not: null } },
          select: { id: true, moveId: true },
        });
        const moveOf = new Map(adjs.map((a) => [a.id, a.moveId as string]));
        for (const c of cas) {
          const moveId = moveOf.get(c.adjustmentId);
          if (!moveId) continue;
          wanted.push({ sourceRef: adjustmentAllocationRef(c.id), baseKey: null, creditMoveId: moveId, amountMilli: toMilli(c.amount, dec) });
        }
      }
      if (wanted.length === 0) return [];

      const [live, matched] = await Promise.all([
        liveMoveIdsOf(tx, tenantId, wanted.filter((w) => w.baseKey).map((w) => w.baseKey as string)),
        tx.glPartialReconcile.groupBy({
          by: ['sourceRef'],
          where: { tenantId, sourceRef: { in: wanted.map((w) => w.sourceRef) } },
          _sum: { amountMilli: true },
        }),
      ]);
      const done = new Map(matched.map((m) => [m.sourceRef as string, m._sum.amountMilli ?? 0n]));
      const out: PendingAllocation[] = [];
      for (const w of wanted) {
        const creditMoveId = w.creditMoveId ?? (w.baseKey ? live.get(w.baseKey) ?? null : null);
        if (!creditMoveId) continue;
        const left = w.amountMilli - (done.get(w.sourceRef) ?? 0n);
        if (left > 0n) out.push({ sourceRef: w.sourceRef, creditMoveId, amountMilli: left });
      }
      return out;
    },

    async partialsOfMoves(moveIds: string[]): Promise<PartialRow[]> {
      const ids = [...new Set(moveIds)];
      if (ids.length === 0) return [];
      const rows = await tx.glPartialReconcile.findMany({
        where: { tenantId, OR: [{ debitMoveId: { in: ids } }, { creditMoveId: { in: ids } }] },
        select: { id: true, debitLineId: true, creditLineId: true, amountMilli: true, sourceRef: true },
      });
      return rows;
    },

    async insertPartials(rows: readonly PartialInsert[]): Promise<number> {
      const data = rows.filter((r) => r.amountMilli > 0n).map((r) => ({
        tenantId, debitLineId: r.debitLineId, creditLineId: r.creditLineId, debitMoveId: r.debitMoveId,
        creditMoveId: r.creditMoveId, amountMilli: r.amountMilli, sourceRef: r.sourceRef, createdBy: RECONCILE_SYSTEM_ACTOR,
      }));
      if (data.length === 0) return 0;
      const r = await tx.glPartialReconcile.createMany({ data, skipDuplicates: true });
      return r.count;
    },

    async deletePartials(ids: readonly string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const r = await tx.glPartialReconcile.deleteMany({ where: { tenantId, id: { in: [...ids] } } });
      return r.count;
    },

    async openLinesOfPartner(kind: ReconcileKind, partnerId: string, side: ReconcileSide): Promise<OpenControlLine[]> {
      const partnerWhere: Prisma.GlMoveLineWhereInput = kind === 'AR' ? { customerId: partnerId } : { vendorId: partnerId };
      const sideWhere: Prisma.GlMoveLineWhereInput = side === 'DEBIT' ? { debitMilli: { gt: 0n } } : { creditMilli: { gt: 0n } };
      const out: OpenControlLine[] = [];
      let cursor: string | undefined;
      let scanned = 0;
      // صفحات بالأقدم فالأقدم حتى نهاية سطور الشريك (أو السقف الدفاعي) — المفتوح وحده يُعاد
      while (scanned < OPEN_SCAN_CAP) {
        const rows: LineRow[] = await tx.glMoveLine.findMany({
          where: { tenantId, posted: true, account: { controlKind: kind }, ...partnerWhere, ...sideWhere },
          select: LINE_SELECT,
          orderBy: [{ date: 'asc' }, { id: 'asc' }],
          take: ID_CHUNK,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        if (rows.length === 0) break;
        scanned += rows.length;
        const matched = await matchedSums(tx, tenantId, rows.map((r) => r.id));
        for (const l of toOpenLines(rows, kind, matched)) if (l.residualMilli > 0n) out.push(l);
        if (rows.length < ID_CHUNK) break;
        cursor = rows[rows.length - 1].id;
      }
      return out;
    },

    async pendingReturnsForInvoice(invoiceId: string): Promise<PendingReturn[]> {
      // فحص رخيص بالمفتاح الأساسي أولاً: المرتجع المرتبط والإشعار الدائن يُسقطان من متبقّي البيع، فبيعٌ متبقّيه = إجماليه
      // لا مرتجع مطبَّق عليه — فلا قراءة لبنوده
      const inv = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { total: true, remainingAmt: true } });
      if (!inv) return [];
      const dec = await currencyDecimals();
      if (toMilli(inv.remainingAmt, dec) >= toMilli(inv.total, dec)) return [];

      // المرشّحون بالفهارس (لا مسح JSON للأحداث): مرتجعات بنودها returnOfItemId على بنود هذا البيع، وإشعارات أصلها هو
      const saleItems = await tx.invoiceItem.findMany({ where: { invoiceId, invoice: { tenantId } }, select: { id: true } });
      const [retItems, notes] = await Promise.all([
        saleItems.length > 0
          ? tx.invoiceItem.findMany({
            where: { returnOfItemId: { in: saleItems.map((i) => i.id) }, invoice: { tenantId } }, select: { invoiceId: true },
          })
          : Promise.resolve([] as { invoiceId: string }[]),
        tx.invoice.findMany({ where: { tenantId, originalInvoiceId: invoiceId }, select: { id: true } }),
      ]);
      const ids = [...new Set([...retItems.map((r) => r.invoiceId), ...notes.map((n) => n.id)])].filter((id) => id !== invoiceId);
      if (ids.length === 0) return [];

      // appliesTo من لقطة حمولة INVOICE:POST المرحَّل (لا من الصفّ الحيّ) — ما رُحّل هو ما يُطابَق
      const idOfKey = new Map(ids.map((id) => [invoiceKey(id, 'POST'), id]));
      const wanted: { sourceRef: string; baseKey: string; amountMilli: bigint | null }[] = [];
      for (const part of chunks([...idOfKey.keys()])) {
        const events = await tx.glSourceEvent.findMany({
          where: { tenantId, sourceKey: { in: part }, status: 'DONE' },
          select: { sourceKey: true, payload: true },
        });
        for (const e of events) {
          const id = idOfKey.get(e.sourceKey);
          const applies = (e.payload as { appliesTo?: { invoiceId?: string; amount?: string | number | null } | null } | null)?.appliesTo;
          if (!id || !applies || applies.invoiceId !== invoiceId) continue;
          if (applies.amount === null || applies.amount === undefined) {
            wanted.push({ sourceRef: creditNoteRef(id), baseKey: e.sourceKey, amountMilli: null });
            continue;
          }
          let amt: bigint;
          try { amt = toMilli(applies.amount, MAX_CURRENCY_DECIMALS); } catch { continue; }
          wanted.push({ sourceRef: returnRef(id), baseKey: e.sourceKey, amountMilli: amt });
        }
      }
      if (wanted.length === 0) return [];

      const [live, matched] = await Promise.all([
        liveMoveIdsOf(tx, tenantId, wanted.map((w) => w.baseKey)),
        tx.glPartialReconcile.groupBy({
          by: ['sourceRef'],
          where: { tenantId, sourceRef: { in: wanted.map((w) => w.sourceRef) } },
          _sum: { amountMilli: true },
        }),
      ]);
      const done = new Map(matched.map((m) => [m.sourceRef as string, m._sum.amountMilli ?? 0n]));
      const out: PendingReturn[] = [];
      for (const w of wanted) {
        const creditMoveId = live.get(w.baseKey);
        if (!creditMoveId) continue;
        if (w.amountMilli === null) {
          out.push({ sourceRef: w.sourceRef, creditMoveId, amountMilli: null });
          continue;
        }
        const left = w.amountMilli - (done.get(w.sourceRef) ?? 0n);
        if (left > 0n) out.push({ sourceRef: w.sourceRef, creditMoveId, amountMilli: left });
      }
      return out;
    },

    async openingKeysOf(baseKeys: readonly string[]): Promise<Set<string>> {
      // مفاتيح دقيقة على الفهرس الفريد: المستند المشمول بالافتتاح حدث POST له SKIPPED(OPENING) (classifyCutover)
      const out = new Set<string>();
      for (const part of chunks([...new Set(baseKeys)])) {
        const rows = await tx.glSourceEvent.findMany({
          where: { tenantId, sourceKey: { in: part }, status: 'SKIPPED', skipReason: 'OPENING' },
          select: { sourceKey: true },
        });
        for (const r of rows) out.add(r.sourceKey);
      }
      return out;
    },

    async openingLinesOfPartner(kind: ReconcileKind, partnerId: string): Promise<OpenControlLine[]> {
      // سطور الشريك في قيود OPENING المرحّلة (فهرس tenantId+customerId/vendorId+accountId) — والمفتوح وحده يُعاد
      const partnerWhere: Prisma.GlMoveLineWhereInput = kind === 'AR' ? { customerId: partnerId } : { vendorId: partnerId };
      const rows: LineRow[] = await tx.glMoveLine.findMany({
        where: {
          tenantId, posted: true, ...partnerWhere, account: { controlKind: kind },
          move: { tenantId, moveType: 'OPENING', state: 'POSTED' },
        },
        select: LINE_SELECT,
        orderBy: [{ date: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
        take: OPEN_SCAN_CAP,
      });
      if (rows.length === 0) return [];
      return toOpenLines(rows, kind, await matchedSums(tx, tenantId, rows.map((r) => r.id))).filter((l) => l.residualMilli > 0n);
    },
  };
}

/**
 * الذمم المفتوحة لكل عميل (لـC16، A7): Σ متبقّي سطور الذمة **المدينة** (فواتير وأقساط وأرصدة افتتاحية)، فتقابل
 * Σ remainingAmt للفواتير التشغيلية. الأرصدة الدائنة غير المخصّصة (سند بلا تخصيص، مرتجع غير مطبّق) لا تدخل، كما لا
 * تُنقص remainingAmt تشغيلياً (D7).
 *
 * `asOf`: السطور حتى التاريخ، والمطابقة تُحسب فقط إن كان سطرها المقابل حتى التاريخ أيضاً (أعمار تاريخية صحيحة).
 * استعلام واحد مجمّع بلا N+1.
 */
export async function openArByCustomer(db: GlDb, tenantId: string, asOf?: LocalDate): Promise<Map<string, bigint>> {
  if (asOf !== undefined && !isLocalDate(asOf)) throw new RangeError(`asOf غير صالح: ${asOf}`);
  const lineCond = asOf ? Prisma.sql` AND l."date" <= ${asOf}::date` : Prisma.empty;
  const otherJoin = asOf
    ? Prisma.sql` JOIN "gl_move_lines" o ON o."id" = p."creditLineId" AND o."date" <= ${asOf}::date`
    : Prisma.empty;
  const rows = await db.$queryRaw<{ customerId: string; openMilli: bigint | number | string }[]>`
    WITH "ar" AS (
      SELECT l."id", l."customerId", l."debitMilli"
      FROM "gl_move_lines" l
      JOIN "gl_accounts" a ON a."id" = l."accountId"
      WHERE l."tenantId" = ${tenantId} AND a."tenantId" = ${tenantId} AND a."controlKind" = 'AR'
        AND l."posted" = true AND l."customerId" IS NOT NULL AND l."debitMilli" > 0${lineCond}
    ), "m" AS (
      SELECT p."debitLineId" AS "id", SUM(p."amountMilli") AS "amt"
      FROM "gl_partial_reconciles" p
      JOIN "ar" ON "ar"."id" = p."debitLineId"${otherJoin}
      WHERE p."tenantId" = ${tenantId}
      GROUP BY p."debitLineId"
    )
    SELECT "ar"."customerId" AS "customerId", SUM("ar"."debitMilli" - COALESCE("m"."amt", 0))::bigint AS "openMilli"
    FROM "ar" LEFT JOIN "m" ON "m"."id" = "ar"."id"
    GROUP BY "ar"."customerId"
    HAVING SUM("ar"."debitMilli" - COALESCE("m"."amt", 0)) <> 0`;
  const out = new Map<string, bigint>();
  for (const r of rows) out.set(r.customerId, BigInt(r.openMilli));
  return out;
}
