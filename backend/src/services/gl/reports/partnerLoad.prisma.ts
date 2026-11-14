/**
 * «ربط الدفاتر» L8 — قراءة تقارير الشركاء والأعمار والأصناف والوصول المتأخر وإعادة تصنيف الميزانية (عقد §6.2).
 *
 * كل الحساب في الوحدات الصرفة (`partnerLedger.ts` و`aging.ts` و`lateArrivals.ts` و`productLedger.ts` و`balanceSheet.ts`)،
 * وهنا القراءة وحدها: كل استعلام مقيّد بـtenantId (§9.4)، ومجمّع بلا N+1 (القاعدة 0.1 نواة) — صفحة دفتر الشريك تُكمَّل
 * بأرقام القيود المقابلة وأسماء الأصناف وعدّادات المرفقات في استعلامات دفعيّة لكلٍّ منها.
 *
 * SQL الخام في موضعين فقط حيث لا يكفي عميل Prisma: الأعمار لكل الشركاء (المتبقّي = المبلغ − Σ المطابقات، مجمّعاً في القاعدة
 * فلا تُنقل سطور الذمم كلها)، وبيانات مرفقات «data URL» (البادئة والطول دون نقل الصورة).
 */
import { Prisma } from '@prisma/client';
import type { GlDb } from '../resolve';
import { fromDbDate, toDbDate } from '../dates';
import { isLinked } from '../mode';
import { LedgerError, type ControlKind, type LocalDate, type Milli } from '../types';
import {
  PARTNER_LEDGER_MAX_LINES, PARTNER_LEDGER_SCOPE, buildPartnerLedger,
  type PartnerLedger, type PartnerLedgerExtras, type PartnerLedgerLineInput, type PartnerLedgerPartial, type PartnerType,
} from './partnerLedger';
import type { AgingItem } from './aging';
import type { LateArrivalMoveInput } from './lateArrivals';
import type { ProductLedgerLineInput } from './productLedger';
import type { PartnerReclassInput } from './balanceSheet';

export type PartnerDb = GlDb;

const ID_CHUNK = 2_000;

function chunks<T>(xs: readonly T[], n = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const uniq = <T>(xs: readonly (T | null | undefined)[]): T[] => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];

// ═══ الإعدادات ═══

export interface PartnerReportSettings {
  configured: boolean;
  linked: boolean;
  currency: string;
  currencyDecimals: number;
  timezone: string;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  /** بداية الدفاتر: linkedFrom للمربوطة، وإلا cutoverDate */
  cutoverDate: LocalDate | null;
}

export async function loadPartnerReportSettings(db: PartnerDb, tenantId: string): Promise<PartnerReportSettings> {
  const s = await db.glSettings.findUnique({
    where: { tenantId },
    select: {
      setupMethod: true, activatedAt: true, currency: true, currencyDecimals: true, timezone: true,
      fiscalYearEndMonth: true, fiscalYearEndDay: true, linkedFrom: true, cutoverDate: true,
    },
  });
  // «مربوطة» بالتعريف الواحد (services/booksMode عبر gl/mode)
  const linked = isLinked(s);
  const start = s?.linkedFrom ?? s?.cutoverDate ?? null;
  return {
    configured: !!s,
    linked,
    currency: s?.currency ?? 'SAR',
    currencyDecimals: s?.currencyDecimals ?? 2,
    timezone: s?.timezone ?? 'Asia/Riyadh',
    fiscalYearEndMonth: s?.fiscalYearEndMonth ?? 12,
    fiscalYearEndDay: s?.fiscalYearEndDay ?? 31,
    cutoverDate: start ? fromDbDate(start) : null,
  };
}

// ═══ الحسابات والشريك ═══

export async function controlAccountIds(db: PartnerDb, tenantId: string, kind: ControlKind): Promise<string[]> {
  const rows = await db.glAccount.findMany({ where: { tenantId, controlKind: kind }, select: { id: true } });
  return rows.map((r) => r.id);
}

function partnerLineWhere(type: PartnerType, partnerId: string): Prisma.GlMoveLineWhereInput {
  switch (type) {
    case 'customer': return { customerId: partnerId };
    case 'vendor': return { vendorId: partnerId };
    case 'rep': return { salesRepId: partnerId };
    case 'user': return { adminUserId: partnerId };
  }
}

/** أسماء الشركاء دفعةً واحدة (للأعمار ودفتر الشريك والوصول المتأخر) */
export async function loadPartnerNames(db: PartnerDb, tenantId: string, type: PartnerType, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks(uniq(ids))) {
    const rows: { id: string; name: string }[] = type === 'customer'
      ? await db.customer.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, name: true } })
      : type === 'vendor'
        ? await db.glVendor.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, name: true } })
        : type === 'rep'
          ? await db.salesRep.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, name: true } })
          : await db.admin.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, name: true } });
    for (const r of rows) out.set(r.id, r.name);
  }
  return out;
}

export const PARTNER_SEARCH_LIMIT = 20;
export const PARTNER_SEARCH_TYPES = ['customer', 'vendor', 'rep', 'user', 'product'] as const;
export type PartnerSearchType = (typeof PARTNER_SEARCH_TYPES)[number];

/** منتقي الشريك (والصنف): بحث بالاسم (وبالجوال/الرمز حيث وُجد) بحدّ 20، مقيّداً بالشركة */
export async function searchPartners(
  db: PartnerDb, tenantId: string, type: PartnerSearchType, q: string,
): Promise<{ id: string; name: string; hint: string | null }[]> {
  const term = q.trim().slice(0, 100);
  const has = term !== '';
  const contains = { contains: term, mode: 'insensitive' as const };
  switch (type) {
    case 'customer': {
      const rows = await db.customer.findMany({
        where: { tenantId, ...(has ? { OR: [{ name: contains }, { phone: { contains: term } }, { code: contains }] } : {}) },
        select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' }, take: PARTNER_SEARCH_LIMIT,
      });
      return rows.map((r) => ({ id: r.id, name: r.name, hint: r.phone || null }));
    }
    case 'vendor': {
      const rows = await db.glVendor.findMany({
        where: { tenantId, ...(has ? { OR: [{ name: contains }, { phone: { contains: term } }] } : {}) },
        select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' }, take: PARTNER_SEARCH_LIMIT,
      });
      return rows.map((r) => ({ id: r.id, name: r.name, hint: r.phone ?? null }));
    }
    case 'rep': {
      const rows = await db.salesRep.findMany({
        where: { tenantId, ...(has ? { OR: [{ name: contains }, { phone: { contains: term } }] } : {}) },
        select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' }, take: PARTNER_SEARCH_LIMIT,
      });
      return rows.map((r) => ({ id: r.id, name: r.name, hint: r.phone || null }));
    }
    case 'user': {
      // مستخدمو لوحة الشركة (عهدة 111004) — الاسم والدور وحدهما، لا البريد
      const rows = await db.admin.findMany({
        where: { tenantId, ...(has ? { name: contains } : {}) },
        select: { id: true, name: true, role: true }, orderBy: { name: 'asc' }, take: PARTNER_SEARCH_LIMIT,
      });
      return rows.map((r) => ({ id: r.id, name: r.name, hint: r.role ?? null }));
    }
    case 'product': {
      const rows = await db.product.findMany({
        where: { tenantId, ...(has ? { name: contains } : {}) },
        select: { id: true, name: true }, orderBy: { name: 'asc' }, take: PARTNER_SEARCH_LIMIT,
      });
      return rows.map((r) => ({ id: r.id, name: r.name, hint: null }));
    }
  }
}

// ═══ المطابقات ═══

/** صفوف المطابقة التي تمسّ أيّ سطر من السطور (من الجهتين)، بلا تكرار */
export async function partialsTouching(db: PartnerDb, tenantId: string, lineIds: readonly string[]): Promise<Required<PartnerLedgerPartial>[]> {
  const seen = new Set<string>();
  const out: Required<PartnerLedgerPartial>[] = [];
  for (const part of chunks(uniq(lineIds))) {
    const rows = await db.glPartialReconcile.findMany({
      where: { tenantId, OR: [{ debitLineId: { in: part } }, { creditLineId: { in: part } }] },
      select: { id: true, debitLineId: true, creditLineId: true, debitMoveId: true, creditMoveId: true, amountMilli: true },
    });
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

// ═══ عدّادات المرفقات ═══

export interface AttachmentRef {
  key: string;
  sourceType: string | null;
  sourceId: string | null;
  moveId: string | null;
}

/** أنواع المرفقات بحسب المصدر (عقد §6.3) */
export const ATTACHMENT_KINDS = [
  'RECEIPT_PHOTO', 'REP_SETTLEMENT_PHOTO', 'USER_SETTLEMENT_PHOTO', 'INVOICE_SIGNATURE', 'WAREHOUSE_ATTACHMENT',
  'CUSTOMER_DOCUMENT', 'LEDGER_ATTACHMENT',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export function isAttachmentKind(v: unknown): v is AttachmentKind {
  return typeof v === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(v);
}

/**
 * عدد مرفقات مصدر كل سطر وأنواعها — استعلام دفعيّ واحد لكل جدول (groupBy) لا لكل سطر: صور السند، وصور الاستلام،
 * وصور توريد المستخدم، وتوقيعا الفاتورة، ومرفقات حركة المستودع، ومرفقات القيد نفسه (GlAttachment).
 */
export async function countSourceAttachments(
  db: PartnerDb, tenantId: string, refs: readonly AttachmentRef[],
): Promise<Map<string, { count: number; kinds: string[] }>> {
  const idsOf = (t: string) => uniq(refs.filter((r) => r.sourceType === t).map((r) => r.sourceId));
  const receiptIds = idsOf('RECEIPT');
  const settlementIds = idsOf('SETTLEMENT');
  const userSettlementIds = idsOf('USER_SETTLEMENT');
  const invoiceIds = idsOf('INVOICE');
  const whIds = idsOf('WH_ENTRY');
  const moveIds = uniq(refs.map((r) => r.moveId));
  const none = Promise.resolve([] as { id: string; n: number }[]);
  const [receipts, settlements, userSettlements, signatures, repSignatures, wh, gl] = await Promise.all([
    receiptIds.length
      ? db.receiptPhoto.groupBy({ by: ['receiptId'], where: { receiptId: { in: receiptIds }, receipt: { tenantId } }, _count: { _all: true } })
        .then((rs) => rs.map((r) => ({ id: r.receiptId, n: r._count._all })))
      : none,
    settlementIds.length
      ? db.repSettlementPhoto.groupBy({ by: ['settlementId'], where: { settlementId: { in: settlementIds }, settlement: { tenantId } }, _count: { _all: true } })
        .then((rs) => rs.map((r) => ({ id: r.settlementId, n: r._count._all })))
      : none,
    userSettlementIds.length
      ? db.userSettlementPhoto.groupBy({ by: ['settlementId'], where: { settlementId: { in: userSettlementIds }, settlement: { tenantId } }, _count: { _all: true } })
        .then((rs) => rs.map((r) => ({ id: r.settlementId, n: r._count._all })))
      : none,
    invoiceIds.length
      ? db.invoiceSignature.findMany({ where: { tenantId, invoiceId: { in: invoiceIds }, image: { not: null } }, select: { invoiceId: true } })
        .then((rs) => rs.map((r) => ({ id: r.invoiceId, n: 1 })))
      : none,
    invoiceIds.length
      ? db.invoiceSignature.findMany({ where: { tenantId, invoiceId: { in: invoiceIds }, repImage: { not: null } }, select: { invoiceId: true } })
        .then((rs) => rs.map((r) => ({ id: r.invoiceId, n: 1 })))
      : none,
    whIds.length
      ? db.warehouseEntryAttachment.groupBy({ by: ['entryId'], where: { tenantId, entryId: { in: whIds } }, _count: { _all: true } })
        .then((rs) => rs.map((r) => ({ id: r.entryId, n: r._count._all })))
      : none,
    moveIds.length
      ? db.glAttachment.groupBy({ by: ['entityId'], where: { tenantId, entityType: 'MOVE', entityId: { in: moveIds } }, _count: { _all: true } })
        .then((rs) => rs.map((r) => ({ id: r.entityId, n: r._count._all })))
      : none,
  ]);
  const bySource = new Map<string, { count: number; kinds: string[] }>();
  const addTo = (sourceType: string, rows: { id: string; n: number }[], kind: AttachmentKind) => {
    for (const r of rows) {
      const k = `${sourceType}:${r.id}`;
      const cur = bySource.get(k) ?? { count: 0, kinds: [] };
      cur.count += r.n;
      if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
      bySource.set(k, cur);
    }
  };
  addTo('RECEIPT', receipts, 'RECEIPT_PHOTO');
  addTo('SETTLEMENT', settlements, 'REP_SETTLEMENT_PHOTO');
  addTo('USER_SETTLEMENT', userSettlements, 'USER_SETTLEMENT_PHOTO');
  addTo('INVOICE', signatures, 'INVOICE_SIGNATURE');
  addTo('INVOICE', repSignatures, 'INVOICE_SIGNATURE');
  addTo('WH_ENTRY', wh, 'WAREHOUSE_ATTACHMENT');
  addTo('MOVE', gl, 'LEDGER_ATTACHMENT');
  const out = new Map<string, { count: number; kinds: string[] }>();
  for (const r of refs) {
    const src = r.sourceType && r.sourceId ? bySource.get(`${r.sourceType}:${r.sourceId}`) : undefined;
    const mv = r.moveId ? bySource.get(`MOVE:${r.moveId}`) : undefined;
    const count = (src?.count ?? 0) + (mv?.count ?? 0);
    out.set(r.key, { count, kinds: uniq([...(src?.kinds ?? []), ...(mv?.kinds ?? [])]) });
  }
  return out;
}

// ═══ دفتر أستاذ الشريك ═══

export interface PartnerLedgerQuery {
  type: PartnerType;
  partnerId: string;
  from: LocalDate;
  to: LocalDate;
  includeReconciled: boolean;
  page: number;
  /** null ⇒ التصدير بلا ترقيم */
  pageSize: number | null;
}

export interface PartnerLedgerLoaded {
  ledger: PartnerLedger;
  extras: PartnerLedgerExtras;
  /** لا شريك بهذا المعرّف في الشركة ولا حركة له ⇒ 404 في المسار */
  found: boolean;
}

const LEDGER_LINE_SELECT = {
  id: true, moveId: true, seq: true, date: true, dueDate: true, label: true, debitMilli: true, creditMilli: true,
  productId: true, quantity: true, partnerName: true,
  move: { select: { number: true, ref: true, sourceType: true, sourceId: true, createdAt: true, journal: { select: { code: true } } } },
} as const;

export async function loadPartnerLedger(
  db: PartnerDb, tenantId: string, s: Pick<PartnerReportSettings, 'currency' | 'currencyDecimals'>, q: PartnerLedgerQuery,
): Promise<PartnerLedgerLoaded> {
  const scope = PARTNER_LEDGER_SCOPE[q.type];
  const accountIds = await controlAccountIds(db, tenantId, scope.controlKind);
  const base: Prisma.GlMoveLineWhereInput = { tenantId, posted: true, accountId: { in: accountIds }, ...partnerLineWhere(q.type, q.partnerId) };
  // العهد لا تُطابَق أصلاً: لا قراءة لجدول المطابقات لها
  const reconcilable = scope.controlKind === 'AR' || scope.controlKind === 'AP';
  const fromDb = toDbDate(q.from);

  const names = await loadPartnerNames(db, tenantId, q.type, [q.partnerId]);
  if (accountIds.length === 0) {
    return {
      ledger: buildPartnerLedger({
        partner: { type: q.type, id: q.partnerId, name: names.get(q.partnerId) ?? null }, currency: s.currency, decimals: s.currencyDecimals,
        from: q.from, to: q.to, openingMilli: 0n, lines: [], partials: [], includeReconciled: q.includeReconciled, page: q.page, pageSize: q.pageSize,
      }),
      extras: {},
      found: names.has(q.partnerId),
    };
  }

  // الافتتاح: Σ ما قبل from — وللمعروض غير المطابَق كلياً: السطور غير المطابَقة كلياً وحدها (بالقاعدة نفسها)
  let openingMilli = 0n;
  let hadBefore = false;
  if (q.includeReconciled || !reconcilable) {
    const agg = await db.glMoveLine.aggregate({ where: { ...base, date: { lt: fromDb } }, _sum: { debitMilli: true, creditMilli: true }, _count: { _all: true } });
    openingMilli = (agg._sum.debitMilli ?? 0n) - (agg._sum.creditMilli ?? 0n);
    hadBefore = agg._count._all > 0;
  } else {
    const before = await db.glMoveLine.findMany({
      where: { ...base, date: { lt: fromDb } }, select: { id: true, debitMilli: true, creditMilli: true }, take: PARTNER_LEDGER_MAX_LINES * 4 + 1,
    });
    if (before.length > PARTNER_LEDGER_MAX_LINES * 4) throw new LedgerError('LEDGER_RANGE_TOO_LARGE', { lines: before.length, cap: PARTNER_LEDGER_MAX_LINES * 4 });
    hadBefore = before.length > 0;
    const matched = new Map<string, bigint>();
    for (const p of await partialsTouching(db, tenantId, before.map((b) => b.id))) {
      matched.set(p.debitLineId, (matched.get(p.debitLineId) ?? 0n) + p.amountMilli);
      matched.set(p.creditLineId, (matched.get(p.creditLineId) ?? 0n) + p.amountMilli);
    }
    for (const b of before) {
      const amount = b.debitMilli > 0n ? b.debitMilli : b.creditMilli;
      if (amount > 0n && (matched.get(b.id) ?? 0n) >= amount) continue;
      openingMilli += b.debitMilli - b.creditMilli;
    }
  }

  const rows = await db.glMoveLine.findMany({
    where: { ...base, date: { gte: fromDb, lte: toDbDate(q.to) } },
    select: LEDGER_LINE_SELECT,
    orderBy: [{ date: 'asc' }, { moveId: 'asc' }, { seq: 'asc' }],
    take: PARTNER_LEDGER_MAX_LINES + 1,
  });
  if (rows.length > PARTNER_LEDGER_MAX_LINES) {
    throw new LedgerError('LEDGER_RANGE_TOO_LARGE', { lines: rows.length, cap: PARTNER_LEDGER_MAX_LINES });
  }
  const lines: PartnerLedgerLineInput[] = rows.map((r) => ({
    lineId: r.id, moveId: r.moveId, moveNumber: r.move.number, moveCreatedAt: r.move.createdAt.getTime(), date: fromDbDate(r.date),
    journalCode: r.move.journal?.code ?? null, ref: r.move.ref, label: r.label, sourceType: r.move.sourceType, sourceId: r.move.sourceId,
    seq: r.seq, debitMilli: r.debitMilli, creditMilli: r.creditMilli, dueDate: r.dueDate ? fromDbDate(r.dueDate) : null,
    productId: r.productId, quantity: r.quantity,
  }));
  const partials = reconcilable ? await partialsTouching(db, tenantId, lines.map((l) => l.lineId)) : [];
  const snapshotName = [...rows].reverse().find((r) => r.partnerName)?.partnerName ?? null;
  const ledger = buildPartnerLedger({
    partner: { type: q.type, id: q.partnerId, name: names.get(q.partnerId) ?? snapshotName },
    currency: s.currency, decimals: s.currencyDecimals, from: q.from, to: q.to, openingMilli, lines, partials,
    includeReconciled: q.includeReconciled, page: q.page, pageSize: q.pageSize,
  });

  // تكملة الصفحة وحدها: أرقام القيود المقابلة، وأسماء الأصناف، والمرفقات، ووثائق العميل
  const counterpartMoveIds = uniq(ledger.lines.flatMap((l) => l.matches.map((m) => m.moveId)));
  const orphanLineIds = uniq(ledger.lines.flatMap((l) => l.matches.filter((m) => !m.moveId).map((m) => m.lineId)));
  const orphanMoves = orphanLineIds.length
    ? await db.glMoveLine.findMany({ where: { tenantId, id: { in: orphanLineIds } }, select: { id: true, moveId: true } })
    : [];
  const orphanMoveOf = new Map(orphanMoves.map((o) => [o.id, o.moveId]));
  for (const l of ledger.lines) for (const m of l.matches) if (!m.moveId) m.moveId = orphanMoveOf.get(m.lineId) ?? null;
  const moveIds = uniq([...counterpartMoveIds, ...orphanMoves.map((o) => o.moveId)]);
  const productIds = uniq(ledger.lines.map((l) => l.productId));
  const [moves, products, attachments, documentsCount] = await Promise.all([
    moveIds.length ? db.glMove.findMany({ where: { tenantId, id: { in: moveIds } }, select: { id: true, number: true } }) : Promise.resolve([]),
    productIds.length ? db.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    countSourceAttachments(db, tenantId, ledger.lines.map((l) => ({ key: l.lineId, sourceType: l.sourceType, sourceId: l.sourceId, moveId: l.moveId }))),
    q.type === 'customer' ? db.customerDocument.count({ where: { tenantId, customerId: q.partnerId } }) : Promise.resolve(0),
  ]);
  return {
    ledger,
    extras: {
      moveNumbers: new Map(moves.map((m) => [m.id, m.number])),
      productNames: new Map(products.map((p) => [p.id, p.name])),
      attachments,
      documentsCount,
    },
    found: names.has(q.partnerId) || hadBefore || rows.length > 0,
  };
}

// ═══ الأعمار ═══

/**
 * البنود المفتوحة على حسابات الذمة «اعتباراً من» asOf: السطر حتى التاريخ، والمطابقة تُحسب إن كان سطرها المقابل حتى
 * التاريخ أيضاً (أعمار تاريخية). لكل الشركاء: مجمّعة في القاعدة بـ(الشريك، التاريخ، الاستحقاق، الجانب)؛ ولشريك واحد: سطراً
 * سطراً برقم القيد (التفصيل). استعلام واحد في الحالتين.
 */
export async function loadAgingItems(
  db: PartnerDb, tenantId: string, q: { kind: 'AR' | 'AP'; asOf: LocalDate; partnerId?: string | null },
): Promise<AgingItem[]> {
  const partnerCol = q.kind === 'AR' ? Prisma.raw('"customerId"') : Prisma.raw('"vendorId"');
  const one = q.partnerId ? Prisma.sql` AND l.${partnerCol} = ${q.partnerId}` : Prisma.empty;
  const linesCte = Prisma.sql`
    WITH "lines" AS (
      SELECT l."id", l."moveId", l.${partnerCol} AS "partnerId", l."date", l."dueDate", l."debitMilli", l."creditMilli"
      FROM "gl_move_lines" l
      JOIN "gl_accounts" a ON a."id" = l."accountId"
      WHERE l."tenantId" = ${tenantId} AND a."tenantId" = ${tenantId} AND a."controlKind" = ${q.kind}
        AND l."posted" = true AND l.${partnerCol} IS NOT NULL AND l."date" <= ${q.asOf}::date${one}
    ), "m" AS (
      SELECT x."lineId", SUM(x."amountMilli") AS "amt"
      FROM (
        SELECT p."debitLineId" AS "lineId", p."creditLineId" AS "otherId", p."amountMilli"
        FROM "gl_partial_reconciles" p JOIN "lines" d ON d."id" = p."debitLineId"
        WHERE p."tenantId" = ${tenantId}
        UNION ALL
        SELECT p."creditLineId" AS "lineId", p."debitLineId" AS "otherId", p."amountMilli"
        FROM "gl_partial_reconciles" p JOIN "lines" c ON c."id" = p."creditLineId"
        WHERE p."tenantId" = ${tenantId}
      ) x
      JOIN "gl_move_lines" o ON o."id" = x."otherId" AND o."date" <= ${q.asOf}::date
      GROUP BY x."lineId"
    )`;
  if (q.partnerId) {
    const rows = await db.$queryRaw<{
      id: string; moveId: string; number: string | null; partnerId: string; date: Date; dueDate: Date | null;
      debitMilli: bigint; creditMilli: bigint; amt: bigint | null;
    }[]>`${linesCte}
      SELECT ln."id", ln."moveId", mv."number", ln."partnerId", ln."date", ln."dueDate", ln."debitMilli", ln."creditMilli",
             COALESCE(m."amt", 0)::bigint AS "amt"
      FROM "lines" ln
      JOIN "gl_moves" mv ON mv."id" = ln."moveId"
      LEFT JOIN "m" ON m."lineId" = ln."id"
      WHERE ln."debitMilli" + ln."creditMilli" > COALESCE(m."amt", 0)
      ORDER BY ln."date", ln."moveId"`;
    return rows.map((r) => {
      const open = BigInt(r.debitMilli) + BigInt(r.creditMilli) - BigInt(r.amt ?? 0n);
      return {
        partnerId: r.partnerId, lineId: r.id, moveId: r.moveId, moveNumber: r.number, date: fromDbDate(r.date),
        dueDate: r.dueDate ? fromDbDate(r.dueDate) : null, residualMilli: BigInt(r.debitMilli) > 0n ? open : -open,
      };
    });
  }
  const rows = await db.$queryRaw<{ partnerId: string; date: Date; dueDate: Date | null; residualMilli: bigint }[]>`${linesCte}
    SELECT ln."partnerId", ln."date", ln."dueDate",
           SUM(CASE WHEN ln."debitMilli" > 0 THEN ln."debitMilli" - COALESCE(m."amt", 0)
                    ELSE -(ln."creditMilli" - COALESCE(m."amt", 0)) END)::bigint AS "residualMilli"
    FROM "lines" ln
    LEFT JOIN "m" ON m."lineId" = ln."id"
    WHERE ln."debitMilli" + ln."creditMilli" > COALESCE(m."amt", 0)
    GROUP BY ln."partnerId", ln."date", ln."dueDate", (ln."debitMilli" > 0)`;
  return rows.map((r) => ({
    partnerId: r.partnerId, date: fromDbDate(r.date), dueDate: r.dueDate ? fromDbDate(r.dueDate) : null,
    residualMilli: BigInt(r.residualMilli),
  }));
}

// ═══ الوصول المتأخر ═══

export const LATE_ARRIVALS_MAX_ROWS = 50_000;

export async function loadLateArrivalMoves(
  db: PartnerDb, tenantId: string, from: LocalDate, to: LocalDate,
): Promise<LateArrivalMoveInput[]> {
  const moves = await db.glMove.findMany({
    where: {
      tenantId, state: 'POSTED', date: { gte: toDbDate(from), lte: toDbDate(to) },
      OR: [{ lateArrival: true }, { originalDate: { not: null } }],
    },
    select: {
      id: true, number: true, sourceType: true, sourceId: true, ref: true, date: true, originalDate: true, lateArrival: true,
      totalMilli: true, customerId: true, vendorId: true, salesRepId: true,
    },
    orderBy: [{ date: 'asc' }, { number: 'asc' }],
    take: LATE_ARRIVALS_MAX_ROWS + 1,
  });
  if (moves.length > LATE_ARRIVALS_MAX_ROWS) throw new LedgerError('LEDGER_RANGE_TOO_LARGE', { lines: moves.length, cap: LATE_ARRIVALS_MAX_ROWS });
  const [customers, vendors, reps] = await Promise.all([
    loadPartnerNames(db, tenantId, 'customer', moves.map((m) => m.customerId).filter((x): x is string => !!x)),
    loadPartnerNames(db, tenantId, 'vendor', moves.map((m) => m.vendorId).filter((x): x is string => !!x)),
    loadPartnerNames(db, tenantId, 'rep', moves.map((m) => m.salesRepId).filter((x): x is string => !!x)),
  ]);
  return moves.map((m) => ({
    moveId: m.id, moveNumber: m.number, sourceType: m.sourceType, sourceId: m.sourceId, ref: m.ref,
    partnerName: (m.customerId ? customers.get(m.customerId) : undefined)
      ?? (m.vendorId ? vendors.get(m.vendorId) : undefined)
      ?? (m.salesRepId ? reps.get(m.salesRepId) : undefined)
      ?? null,
    date: fromDbDate(m.date), originalDate: m.originalDate ? fromDbDate(m.originalDate) : null, lateArrival: m.lateArrival,
    totalMilli: m.totalMilli,
  }));
}

// ═══ تقرير الأصناف ═══

export interface ProductLedgerQuery {
  from: LocalDate;
  to: LocalDate;
  productId?: string | null;
  customerId?: string | null;
  salesRepId?: string | null;
}

/**
 * سطور الإيراد ذات الصنف مجمّعةً في القاعدة بـ(الصنف، الحساب) لكل (مرتجع؟ × جانب): أربعة استعلامات groupBy بلا مسح في
 * الذاكرة. العميل والمندوب على رأس القيد (سطر الإيراد لا يحملهما).
 */
export async function loadProductLedgerLines(
  db: PartnerDb, tenantId: string, q: ProductLedgerQuery,
): Promise<{ lines: ProductLedgerLineInput[]; discountAccountIds: Set<string>; returnsAccountIds: Set<string>; names: Map<string, string> }> {
  const moveWhere: Prisma.GlMoveWhereInput = {
    ...(q.customerId ? { customerId: q.customerId } : {}),
    ...(q.salesRepId ? { salesRepId: q.salesRepId } : {}),
  };
  const base: Prisma.GlMoveLineWhereInput = {
    tenantId, posted: true, date: { gte: toDbDate(q.from), lte: toDbDate(q.to) }, account: { type: 'income' },
    ...(q.productId ? { productId: q.productId } : { productId: { not: null } }),
  };
  const group = (isReturn: boolean, side: 'D' | 'C') => db.glMoveLine.groupBy({
    by: ['productId', 'accountId'],
    where: {
      ...base,
      ...(side === 'D' ? { debitMilli: { gt: 0n } } : { creditMilli: { gt: 0n } }),
      move: isReturn ? { ...moveWhere, moveType: 'OUT_REFUND' } : { ...moveWhere, moveType: { not: 'OUT_REFUND' } },
    },
    _sum: { debitMilli: true, creditMilli: true, quantity: true },
  });
  const [rd, rc, nd, nc, mappings] = await Promise.all([
    group(true, 'D'), group(true, 'C'), group(false, 'D'), group(false, 'C'),
    db.glAccountMapping.findMany({ where: { tenantId, key: { in: ['SALES_DISCOUNT', 'SALES_RETURNS'] } }, select: { key: true, accountId: true } }),
  ]);
  const lines: ProductLedgerLineInput[] = [];
  const push = (rows: typeof rd, isReturn: boolean, side: 'D' | 'C') => {
    for (const r of rows) {
      if (!r.productId) continue;
      const qty = r._sum.quantity ?? 0;
      lines.push({
        productId: r.productId, accountId: r.accountId, isReturnMove: isReturn,
        debitMilli: r._sum.debitMilli ?? 0n, creditMilli: r._sum.creditMilli ?? 0n,
        debitQuantity: side === 'D' ? qty : 0, creditQuantity: side === 'C' ? qty : 0,
      });
    }
  };
  push(rd, true, 'D'); push(rc, true, 'C'); push(nd, false, 'D'); push(nc, false, 'C');
  const productIds = uniq(lines.map((l) => l.productId));
  const names = new Map<string, string>();
  for (const part of chunks(productIds)) {
    const ps = await db.product.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, name: true } });
    for (const p of ps) names.set(p.id, p.name);
  }
  return {
    lines,
    discountAccountIds: new Set(mappings.filter((m) => m.key === 'SALES_DISCOUNT').map((m) => m.accountId)),
    returnsAccountIds: new Set(mappings.filter((m) => m.key === 'SALES_RETURNS').map((m) => m.accountId)),
    names,
  };
}

// ═══ إعادة تصنيف الميزانية (E5.15) ═══

/**
 * Σ الأرصدة الدائنة لكل عميل على كل حساب AR، وΣ الأرصدة المدينة لكل مورد على كل حساب AP «اعتباراً من» asOf — رصيد كل
 * شريك على حدة (groupBy بالحساب والشريك في القاعدة)، المرحَّل وحده.
 */
export async function loadPartnerReclass(db: PartnerDb, tenantId: string, asOf: LocalDate): Promise<PartnerReclassInput> {
  const [arIds, apIds] = await Promise.all([controlAccountIds(db, tenantId, 'AR'), controlAccountIds(db, tenantId, 'AP')]);
  const asOfDb = toDbDate(asOf);
  const [ar, ap] = await Promise.all([
    arIds.length
      ? db.glMoveLine.groupBy({
        by: ['accountId', 'customerId'],
        where: { tenantId, posted: true, accountId: { in: arIds }, customerId: { not: null }, date: { lte: asOfDb } },
        _sum: { debitMilli: true, creditMilli: true },
      })
      : Promise.resolve([]),
    apIds.length
      ? db.glMoveLine.groupBy({
        by: ['accountId', 'vendorId'],
        where: { tenantId, posted: true, accountId: { in: apIds }, vendorId: { not: null }, date: { lte: asOfDb } },
        _sum: { debitMilli: true, creditMilli: true },
      })
      : Promise.resolve([]),
  ]);
  const fold = (rows: readonly { accountId: string; _sum: { debitMilli: bigint | null; creditMilli: bigint | null } }[], sign: 1n | -1n) => {
    const by = new Map<string, { accountId: string; amountMilli: Milli; partners: number }>();
    for (const r of rows) {
      // العميل: الرصيد الدائن (مدين − دائن < 0)؛ المورد: الرصيد المدين (> 0)
      const bal = ((r._sum.debitMilli ?? 0n) - (r._sum.creditMilli ?? 0n)) * sign;
      if (bal <= 0n) continue;
      const cur = by.get(r.accountId) ?? { accountId: r.accountId, amountMilli: 0n, partners: 0 };
      cur.amountMilli += bal;
      cur.partners += 1;
      by.set(r.accountId, cur);
    }
    return [...by.values()];
  };
  return { customerCredits: fold(ar, -1n), vendorDebits: fold(ap, 1n) };
}
