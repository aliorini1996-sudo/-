// «ربط الدفاتر» L1 (وكيل B5): بطاقة «المشتريات الشهرية» في لوحة التحكم — المسار الحقيقي routes/dashboard.ts على Prisma مزيّف
// يجيب استعلامها الخام من صفوف حركات المستودع بدلالة SQL نفسها (الربط الأيسر بالوارد الأصلي، والتجميع بالنوع والحالة والمصدر
// ومصدر الأصل)، فيمرّ القرار بـmonthPurchasesOf: الوارد − المرتجع للمورّد، بلا المخزون الافتتاحي ولا مرتجع وارده، والعدد للوارد
// غير الملغى. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Prisma } from '@prisma/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const TID = 't1';
const now = new Date();
const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
const thisMonth = (h: number) => new Date(startOfMonth.getTime() + h * 3_600_000);
const lastMonth = new Date(startOfMonth.getTime() - 86_400_000);

interface Entry { id: string; tenantId: string; type: string; status: string; source: string; returnOfEntryId: string | null; createdAt: Date }
interface Item { entryId: string; qty: number; unitCost: number | null }
const state = { warehouseEnabled: true, accountingEnabled: true, entries: [] as Entry[], items: [] as Item[], queries: [] as string[] };

let seq = 0;
function entry(type: string, lines: [number, number | null][], o: Partial<Entry> = {}): string {
  const id = o.id ?? `we-${++seq}`;
  state.entries.push({ id, tenantId: TID, type, status: 'POSTED', source: 'MANUAL', returnOfEntryId: null, createdAt: thisMonth(1), ...o });
  for (const [qty, unitCost] of lines) state.items.push({ entryId: id, qty, unitCost });
  return id;
}

/** يجيب استعلام المشتريات بدلالة SQL حرفياً: JOIN البنود بحركتها، LEFT JOIN بالأصل، المرشّحات، ثم GROUP BY 1,2,3,4 */
function purchasesQuery(sql: string, values: unknown[]): Row[] {
  assert.ok(sql.includes('LEFT JOIN "warehouse_entries" o ON o.id = e."returnOfEntryId"'), sql);
  assert.ok(sql.includes("e.type IN ('RECEIVE', 'RETURN')") && sql.includes('i."unitCost" IS NOT NULL') && sql.includes('GROUP BY 1, 2, 3, 4'), sql);
  const [tid, since] = values as [string, Date];
  const groups = new Map<string, Row & { ids: Set<string> }>();
  for (const i of state.items) {
    const e = state.entries.find((x) => x.id === i.entryId)!;
    if (e.tenantId !== tid || !['RECEIVE', 'RETURN'].includes(e.type) || !(e.createdAt >= since) || i.unitCost == null) continue;
    const o = e.returnOfEntryId ? state.entries.find((x) => x.id === e.returnOfEntryId) : undefined;
    const key = [e.type, e.status, e.source, o?.source ?? null];
    const k = JSON.stringify(key);
    const g = groups.get(k) ?? { type: key[0], status: key[1], source: key[2], returnOfSource: key[3], value: 0, ids: new Set<string>() };
    g.value += i.qty * i.unitCost;
    g.ids.add(e.id);
    groups.set(k, g);
  }
  return [...groups.values()].map(({ ids, ...g }) => ({ ...g, entries: ids.size }));
}

const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, aggregate: async () => ({ _sum: {}, _count: {} }), groupBy: async () => [] };
const db = new Proxy({
  invoice: { async aggregate() { return { _sum: { total: 0 }, _count: { id: 0 } }; }, async groupBy() { return []; }, async findMany() { return []; } },
  receipt: { async aggregate() { return { _sum: { amount: 0 }, _count: { id: 0 } }; } },
  customer: { fields: { creditLimit: 'creditLimit' }, async count() { return 0; }, async findMany() { return []; } },
  salesRep: { async findMany() { return []; } },
  tenant: { async findUnique() { return { accountingEnabled: state.accountingEnabled, warehouseEnabled: state.warehouseEnabled }; } },
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    const sql = q.text.replace(/\s+/g, ' ').trim();
    state.queries.push(sql);
    return purchasesQuery(sql, q.values);
  },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });
stub('services/adminScope', {
  scopedRecordWhere: async () => ({}), scopedRepRecordWhere: async () => ({}), adminCustomerFilter: async () => ({}), adminRepFilter: async () => ({}),
  SHAPE_INVOICE_RECEIPT: {}, SHAPE_VISIT: {},
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dashboard = require('../routes/dashboard').default;

async function month(): Promise<Row> {
  const layer = (dashboard as { stack: Row[] }).stack.find((l) => l.route?.path === '/' && l.route.methods.get);
  const handler = layer!.route.stack.slice(-1)[0].handle;
  let body: Row | null = null;
  let err: unknown = null;
  const res = { status() { return this; }, json(b: Row) { body = b; return this; } };
  await handler({ query: {}, params: {}, user: { id: 'a1', role: 'ADMIN', tenantId: TID } }, res, (e: unknown) => { err = e; });
  if (err) throw err;
  return body!.data.month;
}

function reset(): void {
  state.entries = [];
  state.items = [];
  state.queries = [];
  state.warehouseEnabled = true;
  state.accountingEnabled = true;
}

test('وارد ثم مرتجعٌ جزئي له للمورّد ⇒ المشتريات صافية والعدد حركة شراء واحدة', async () => {
  reset();
  const r = entry('RECEIVE', [[10, 12], [5, 4]]);                   // ١٢٠ + ٢٠ = ١٤٠
  entry('RETURN', [[-3, 12]], { returnOfEntryId: r });                // −٣٦
  const m = await month();
  assert.deepEqual([m.purchasesTotal, m.purchaseEntriesCount], [104, 1]);
});

test('المخزون الافتتاحي وإلغاؤه خارج المشتريات، ووارد الشهر الماضي ووارد بلا سعر وتسوية المستودع خارجها كذلك', async () => {
  reset();
  const opening = entry('RECEIVE', [[100, 5]], { source: 'OPENING_IMPORT' });
  entry('RETURN', [[-100, 5]], { returnOfEntryId: opening });          // إلغاء استيرادٍ خاطئ
  entry('RECEIVE', [[7, 3]], { source: 'API' });                        // ٢١ — الربط البرمجي شراءٌ حقيقي
  entry('RECEIVE', [[4, null]]);                                        // بلا سعر: لا قيمة ولا عدد
  entry('RECEIVE', [[50, 2]], { createdAt: lastMonth });                // الشهر الماضي
  entry('ADJUST', [[-6, 3]], { source: 'STOCK_ZERO' });                 // التسوية ليست شراءً
  const m = await month();
  assert.deepEqual([m.purchasesTotal, m.purchaseEntriesCount], [21, 1]);
});

test('وارد الشهر الماضي يُرتجع هذا الشهر ⇒ ينقص مشتريات هذا الشهر (المرتجع في فترته)، والملغى لا يُعدّ', async () => {
  reset();
  const old = entry('RECEIVE', [[20, 10]], { createdAt: lastMonth, status: 'CANCELLED' });
  entry('RETURN', [[-20, 10]], { returnOfEntryId: old });               // حركة إلغائه هذا الشهر: −٢٠٠
  const same = entry('RECEIVE', [[8, 25]], { status: 'CANCELLED' });    // أُلغي في الشهر نفسه: ٢٠٠ − ٢٠٠
  entry('RETURN', [[-8, 25]], { returnOfEntryId: same });
  entry('RECEIVE', [[2, 150]]);                                         // ٣٠٠
  const m = await month();
  assert.deepEqual([m.purchasesTotal, m.purchaseEntriesCount], [100, 1]);
});

test('البيانات القائمة (وارد وتسوية بلا مرتجع ولا افتتاحي) ⇒ الرقمان كما كانا: Σ الكمية × السعر وعدد الحركات المسعَّرة', async () => {
  reset();
  entry('RECEIVE', [[10, 1.1], [3, 2.2]]);
  entry('RECEIVE', [[1, 0.1]]);
  entry('ADJUST', [[-2, null]]);
  const m = await month();
  // كما كان الاستعلام القديم: SUM(qty × unitCost) على الوارد = ١١ + ٦٫٦ + ٠٫١
  assert.deepEqual([m.purchasesTotal, m.purchaseEntriesCount], [17.7, 2]);
});

test('المستودع أو المحاسبة مطفأة ⇒ لا استعلام والبطاقة صفر', async () => {
  reset();
  entry('RECEIVE', [[10, 10]]);
  state.warehouseEnabled = false;
  let m = await month();
  assert.deepEqual([m.purchasesTotal, m.purchaseEntriesCount, state.queries.length], [0, 0, 0]);
  state.warehouseEnabled = true;
  state.accountingEnabled = false;
  m = await month();
  assert.deepEqual([m.purchasesTotal, m.purchaseEntriesCount, state.queries.length], [0, 0, 0]);
});
