/**
 * بصمتا معاينة «ربط الدفاتر» (L2 — العقد §10.1، والخطة §4 «Commit protocol»).
 *
 * - dataHash: بصمة **مدخلات الافتتاح** وحدها — إعدادات الربط، والأرصدة اليدوية، وسطور القيد المشتقّة، وافتتاح محرّك
 *   التكلفة، وإحصاء كل مصدر بأثرٍ قبل بداية الربط (أياً كان createdAt): العدد وأكبر (createdAt, id) ومجموع المبالغ بالملّي
 *   (مقرّبة لكل صفّ) ومجموع ثواني الأثر. نشاط السنة لا يغيّرها؛ وصفٌّ رجعيّ أو محذوف أو معدَّل قبل linkedFrom يغيّرها، فيُعاد
 *   التشغيل قبل الاعتماد (L7 يقارن البصمة).
 * - resultHash: بصمة الجزء الحتمي من النتيجة (بلا التوقيتات واللقطة والساعة) — «تشغيلان بالمدخلات نفسها = النتيجة نفسها».
 * JSON قانوني: المفاتيح مرتّبة، وBigInt نصّاً، وDate بـISO، وundefined يُسقط — ثم sha256 hex.
 * القراءة بصفحات مفتاحية (createdAt, id) على فهارس [tenantId, createdAt, id]، بلا جمع Float في SQL (ترتيبه غير حتمي).
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { LocationTotals } from '../../costing/types';
import { toMilli } from '../money';
import { SETTLEMENT_HAS_REP } from '../settlementRep';
import type { ManualBalanceRowInput } from '../opening';
import type { CashInvoiceRouting, InventoryMode, LocalDate, ReceiptRouting, TemplateKey } from '../types';
import type { LinkBasis, PreviewResult } from './types';

export interface PreCutoverSourceStat {
  count: number;
  maxCreatedAt: string | null;
  maxId: string | null;
  /** Σ ملّي المبالغ لكل صفّ (أسطر المخزون: «القيمة|الكمية بالميكرو»؛ سجلّ الإعادة: وزن الحالتين) */
  sumMilli: string;
  sumEffectSec: number;
}

export interface DataHashInput {
  settings: {
    basis: LinkBasis;
    linkedFrom: LocalDate;
    timezone: string;
    currency: string;
    currencyDecimals: number;
    templateKey: TemplateKey;
    countryCode: string;
    fyEnd: { month: number; day: number };
    receiptRouting: ReceiptRouting;
    cashInvoiceRouting: CashInvoiceRouting;
    inventoryMode: InventoryMode;
    categoryIncomeAccounts: readonly { categoryId: string; accountCode: string }[];
  };
  manualRows: readonly ManualBalanceRowInput[];
  derivedLines: readonly { account: string; partner: string | null; milli: bigint }[];
  costingOpening: readonly LocationTotals[];
  preCutoverSources: Record<string, PreCutoverSourceStat>;
}

/** JSON قانوني حتمي */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x === undefined) return undefined;
    if (x === null) return null;
    if (typeof x === 'bigint') return x.toString();
    if (x instanceof Date) return x.toISOString();
    if (typeof x === 'number') return Number.isFinite(x) ? x : String(x);
    if (Array.isArray(x)) return x.map((e) => { const n = norm(e); return n === undefined ? null : n; });
    if (x instanceof Map) return norm(Object.fromEntries([...x.entries()].map(([k, val]) => [String(k), val])));
    if (typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        const n = norm((x as Record<string, unknown>)[k]);
        if (n !== undefined) out[k] = n;
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function computeDataHash(i: DataHashInput): string {
  return sha256(canonicalJson(i));
}

/** يُسقط الحقول غير الحتمية دفاعياً ولو مُرِّرت */
export function computeResultHash(r: Omit<PreviewResult, 'resultHash' | 'timings' | 'snapshotAt' | 'dbNow'>): string {
  const { resultHash: _a, timings: _b, snapshotAt: _c, dbNow: _d, ...rest } = r as Partial<PreviewResult>;
  void _a; void _b; void _c; void _d;
  return sha256(canonicalJson(rest));
}

// ═══ إحصاء مصادر ما قبل البدء ═══

export type PreCutoverDb = Pick<Prisma.TransactionClient,
  'accountEntry' | 'repSettlement' | 'settlementEntry' | 'warehouseEntry' | 'vanLoad' | 'invoiceRestockLog'>;

/** صفوف كل صفحة (جداول مسطّحة) — والآباء للمخزون بصفحة أصغر لأن أسطرها تُحمَّل معها */
export const PRE_CUTOVER_PAGE = 5000;
export const PRE_CUTOVER_PARENT_PAGE = 1000;

interface Acc { count: number; maxAt: Date | null; maxId: string | null; sum: bigint; sum2: bigint; sec: bigint }
const newAcc = (): Acc => ({ count: 0, maxAt: null, maxId: null, sum: 0n, sum2: 0n, sec: 0n });
const secOf = (d: Date): bigint => BigInt(Math.floor(d.getTime() / 1000));
const qtyMicro = (q: number | null | undefined): bigint => BigInt(Math.round((Number(q) || 0) * 1e6));

function bump(a: Acc, at: Date, id: string): void {
  if (!a.maxAt || at.getTime() > a.maxAt.getTime() || (at.getTime() === a.maxAt.getTime() && (a.maxId === null || id > a.maxId))) {
    a.maxAt = at;
    a.maxId = id;
  }
}

function statOf(a: Acc, sumText?: string): PreCutoverSourceStat {
  return {
    count: a.count, maxCreatedAt: a.maxAt ? a.maxAt.toISOString() : null, maxId: a.maxId,
    sumMilli: sumText ?? a.sum.toString(), sumEffectSec: Number(a.sec),
  };
}

type Cursor = { at: Date; id: string } | null;
/**
 * نافذة المؤشّر (createdAt, id) حصرياً **بحدٍّ أدنى صريح** createdAt ≥ c.at (مع حدٍّ أعلى إن وُجد) — كـrowWindow في parity.ts
 * وstreams.ts: Postgres لا يشتقّ حدّ نطاقٍ للفهرس (tenantId, createdAt, id) من OR وحده، فبلا gte تمسح كل صفحة الفهرس من أول
 * صفٍّ للشركة وتُسقط ما قبل المؤشّر (مسحٌ تربيعي: 300 ألف صفّ ⇒ ~9 ملايين زيارة بدل 300 ألف).
 */
const keysetWhere = (c: Cursor, createdAt: { lt?: Date } = {}) => (c
  ? { createdAt: { ...createdAt, gte: c.at }, OR: [{ createdAt: { gt: c.at } }, { createdAt: c.at, id: { gt: c.id } }] }
  : (createdAt.lt ? { createdAt } : {}));
const ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

async function pages<T extends { id: string; createdAt: Date }>(size: number, fetch: (c: Cursor) => Promise<T[]>, each: (r: T) => void): Promise<void> {
  let c: Cursor = null;
  for (;;) {
    const rows = await fetch(c);
    for (const r of rows) each(r);
    if (rows.length < size) return;
    const last = rows[rows.length - 1];
    c = { at: last.createdAt, id: last.id };
  }
}

/**
 * لكل مصدر بأثرٍ قبل cutoverStart **أياً كان createdAt**: account_entries (entryDate)، rep_settlements (settledAt)،
 * settlement_entries (createdAt)، warehouse_entry_items وvan_load_items (createdAt الأب)، invoice_restock_logs (createdAt).
 */
export async function loadPreCutoverSourceStats(
  db: PreCutoverDb, tenantId: string, cutoverStart: Date, decimals: number,
  /** للاختبار: أحجام الصفحات (الإنتاج يترك الثوابت) */
  tuning: { page?: number; parentPage?: number } = {},
): Promise<Record<string, PreCutoverSourceStat>> {
  const lt = { lt: cutoverStart };
  const PAGE = tuning.page ?? PRE_CUTOVER_PAGE;
  const PARENT_PAGE = tuning.parentPage ?? PRE_CUTOVER_PARENT_PAGE;

  const ae = newAcc();
  await pages(PAGE, (c) => db.accountEntry.findMany({
    where: { tenantId, entryDate: lt, ...keysetWhere(c) }, orderBy: ORDER, take: PAGE,
    select: { id: true, createdAt: true, debit: true, credit: true, entryDate: true },
  }), (r) => {
    ae.count++;
    bump(ae, r.createdAt, r.id);
    ae.sum += toMilli(r.debit, decimals) - toMilli(r.credit, decimals);
    ae.sec += secOf(r.entryDate);
  });

  // استلامات مندوبٍ قائم وحدها (SETTLEMENT_HAS_REP — ما تراه الدفاتر): حذف المندوب يُفرّغ salesRepId فيخرج استلامه من
  // الأستاذ، فيجب أن يغيّر البصمة أيضاً (بلا المرشّح يبقى العدد والمجموع كما هما فتتطابق بصمتان لأستاذين مختلفين)
  const rs = newAcc();
  await pages(PAGE, (c) => db.repSettlement.findMany({
    where: { tenantId, ...SETTLEMENT_HAS_REP, settledAt: lt, ...keysetWhere(c) }, orderBy: ORDER, take: PAGE,
    select: { id: true, createdAt: true, amount: true, settledAt: true, salesRepId: true },
  }), (r) => {
    rs.count++;
    bump(rs, r.createdAt, r.id);
    rs.sum += toMilli(r.amount, decimals);
    rs.sec += secOf(r.settledAt);
  });

  const se = newAcc();
  await pages(PAGE, (c) => db.settlementEntry.findMany({
    where: { tenantId, ...keysetWhere(c, lt) }, orderBy: ORDER, take: PAGE,
    select: { id: true, createdAt: true, amount: true },
  }), (r) => {
    se.count++;
    bump(se, r.createdAt, r.id);
    se.sum += toMilli(r.amount, decimals);
    se.sec += secOf(r.createdAt);
  });

  const wi = newAcc();
  await pages(PARENT_PAGE, (c) => db.warehouseEntry.findMany({
    where: { tenantId, ...keysetWhere(c, lt) }, orderBy: ORDER, take: PARENT_PAGE,
    select: { id: true, createdAt: true, items: { select: { id: true, qty: true, unitCost: true }, orderBy: { id: 'asc' } } },
  }), (e) => {
    for (const it of e.items) {
      wi.count++;
      wi.sum += it.unitCost === null || it.unitCost === undefined ? 0n : toMilli(it.qty * it.unitCost, decimals);
      wi.sum2 += qtyMicro(it.qty);
      wi.sec += secOf(e.createdAt);
    }
    if (e.items.length) bump(wi, e.createdAt, e.id);
  });

  const vi = newAcc();
  await pages(PARENT_PAGE, (c) => db.vanLoad.findMany({
    where: { tenantId, ...keysetWhere(c, lt) }, orderBy: ORDER, take: PARENT_PAGE,
    select: { id: true, createdAt: true, items: { select: { id: true, qty: true }, orderBy: { id: 'asc' } } },
  }), (v) => {
    for (const it of v.items) {
      vi.count++;
      vi.sum2 += qtyMicro(it.qty);
      vi.sec += secOf(v.createdAt);
    }
    if (v.items.length) bump(vi, v.createdAt, v.id);
  });

  const rl = newAcc();
  await pages(PAGE, (c) => db.invoiceRestockLog.findMany({
    where: { tenantId, ...keysetWhere(c, lt) }, orderBy: ORDER, take: PAGE,
    select: { id: true, createdAt: true, previous: true, returnToStock: true },
  }), (r) => {
    rl.count++;
    bump(rl, r.createdAt, r.id);
    rl.sum += (r.returnToStock ? 2n : 0n) + (r.previous ? 1n : 0n);
    rl.sec += secOf(r.createdAt);
  });

  return {
    account_entries: statOf(ae),
    rep_settlements: statOf(rs),
    settlement_entries: statOf(se),
    warehouse_entry_items: statOf(wi, `${wi.sum}|${wi.sum2}`),
    van_load_items: statOf(vi, `0|${vi.sum2}`),
    invoice_restock_logs: statOf(rl),
  };
}
