// «تصفير المخزون» (طلب المالك ١ نوفمبر ٢٠٢٦) — الجرد الافتتاحي بعد التصفير: الحركات (بنود المستودع وتحميل/تنزيل السيارات)
// ودفعات الجرد السابقة حتى آخر StockZeroRun لا تمنع استيراداً جديداً (أُلغي رصيدها بالتصفير)، وما بعده يمنع كما كان، وبلا تصفير
// السلوك حرفياً كما كان؛ والتراجع عن دفعةٍ قبل التصفير ممنوع. المسار الحقيقي (routes/import.ts) فوق القاعدة المزيّفة lots-b3-fake.ts
// مع stockZeroRun وتجميعات groupBy تفهم createdAt.gt وzeroRunId (المزيّفة المشتركة لا تعرفهما). لا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, type Row } from './lots-b3-fake';
import {
  IMPORT_ROW_MESSAGES, STOCK_ZERO_DURING_IMPORT_MESSAGE, coveredByStockZero, openingStockRevertBlockReason, stockZeroMovedWhere,
} from '../services/importLedger';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
const db = world.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const importRoutes = require('../routes/import') as typeof import('../routes/import');
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };

// ═══ تشغيلات التصفير وتجميعات الفحص (فوق صفوف العالم المزيّف) ═══

let runs: { tenantId: string; createdAt: Date; warehouseZeroed: boolean }[] = [];
const whereLog: { table: 'warehouse' | 'van'; where: Row }[] = [];
const zeroWheres: Row[] = [];
db.stockZeroRun = {
  // warehouseZeroed في الشرط يُحترم (حدّ الاستيراد تصفيرٌ صفّر المستودع وحده)، والنداء يُسجَّل في calls بترتيبه مع SQL الخام
  findFirst: async (a: Row) => {
    world.calls.push({ op: 'stockZeroRun.findFirst', args: a });
    zeroWheres.push(a.where);
    const mine = runs.filter((r) => r.tenantId === a.where.tenantId && (a.where.warehouseZeroed === undefined || r.warehouseZeroed === a.where.warehouseZeroed))
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
    return mine[0] ? { createdAt: mine[0].createdAt } : null;
  },
};
const inList = (cond: Row | undefined, v: string) => cond === undefined || (cond.in as string[]).includes(v);
const afterOk = (cond: Row | undefined, at: Date) => !cond?.gt || at.getTime() > (cond.gt as Date).getTime();
const zeroOk = (want: unknown, has: unknown) => want === undefined || (has ?? null) === want;
db.warehouseEntryItem.groupBy = async (a: Row) => {
  whereLog.push({ table: 'warehouse', where: a.where });
  const w = a.where;
  const ids = new Set<string>();
  for (const it of world.items) {
    const e = world.entries.find((x) => x.id === it.entryId) as (typeof world.entries[number] & { zeroRunId?: string | null }) | undefined;
    if (!e || e.tenantId !== w.entry.tenantId || !inList(w.productId, it.productId)) continue;
    if (w.entryId?.notIn?.includes(it.entryId)) continue;
    if (!afterOk(w.entry.createdAt, e.createdAt) || !zeroOk(w.entry.zeroRunId, e.zeroRunId)) continue;
    ids.add(it.productId);
  }
  return [...ids].map((productId) => ({ productId, _count: { _all: 1 } }));
};
db.vanLoadItem.groupBy = async (a: Row) => {
  whereLog.push({ table: 'van', where: a.where });
  const w = a.where;
  const ids = new Set<string>();
  for (const v of world.vanItems as (typeof world.vanItems[number] & { zeroRunId?: string | null })[]) {
    if (v.tenantId !== w.vanLoad.tenantId || !inList(w.productId, v.productId) || !w.vanLoad.type.in.includes(v.type)) continue;
    if (!afterOk(w.vanLoad.createdAt, v.createdAt) || !zeroOk(w.vanLoad.zeroRunId, v.zeroRunId)) continue;
    ids.add(v.productId);
  }
  return [...ids].map((productId) => ({ productId, _count: { _all: 1 } }));
};

function fresh(): void {
  Object.assign(world, new World());
  world.lotsEnabled = false;
  for (const [id, code, name] of [['p1', 'A-1', 'ماء'], ['p2', 'B-2', 'حليب'], ['p3', 'C-3', 'سكر'], ['p4', 'D-4', 'زيت']]) world.product({ id, code, name });
  runs = [];
  whereLog.length = 0;
  zeroWheres.length = 0;
}

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }
async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row }> {
  const stack = (importRoutes.default as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { method: method.toUpperCase(), query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  let err: unknown = null;
  for (const h of [...pre, ...layer!.route!.stack.map((l) => l.handle)]) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) throw err;
  return { status: res.statusCode, body: res.body };
}
const importFile = (rows: Row[]) => call('post', '/opening-stock', { body: { rows } });
const ALL = [
  { productCode: 'A-1', qty: 4, unitCost: 2 }, { productCode: 'B-2', qty: 5, unitCost: 2 },
  { productCode: 'C-3', qty: 6, unitCost: 2 }, { productCode: 'D-4', qty: 7, unitCost: 2 },
];

/** تاريخ الشركة قبل التصفير: وارد مستودع لـp1، وتحميل سيارة لـp2، ودفعة جرد غير متراجع عنها لـp3 */
async function history(): Promise<string> {
  world.entry('RECEIVE', [{ productId: 'p1', qty: 10 }]);
  world.vanMove('LOAD', 'r1', 'p2', 5, null);
  const first = await importFile([{ productCode: 'C-3', qty: 3, unitCost: 1 }]);
  assert.equal(first.body.data.created, 1, JSON.stringify(first.body));
  return first.body.data.batchId as string;
}

/** التصفير: صفّ التشغيلة ثم تسويته (zeroRunId) بعده بلحظة — كما تكتبها معاملة التصفير */
function zero(): Date {
  const at = world.now();
  runs.push({ tenantId: 't1', createdAt: at, warehouseZeroed: true });
  const adj = world.entry('ADJUST', [{ productId: 'p1', qty: -10 }, { productId: 'p3', qty: -3 }]);
  Object.assign(adj, { zeroRunId: 'Z1', note: 'تصفير المخزون' });
  return at;
}

const codes = (body: Row) => (body.data.errors as Row[]).map((e) => [e.row, e.code]);

// ═══ القواعد الصرفة ═══

test('القواعد الصرفة: بلا تصفير لا شيء مغطّى والشرط {} حرفياً؛ وبه الحدّ شامل (≤) والشرط بعده وبلا حركات التصفير', () => {
  const z = new Date('2026-11-01T09:00:00Z');
  assert.deepEqual(stockZeroMovedWhere(null), {});
  assert.deepEqual(stockZeroMovedWhere(undefined), {});
  assert.deepEqual(stockZeroMovedWhere(new Date('invalid')), {});
  assert.deepEqual(stockZeroMovedWhere(z), { createdAt: { gt: z }, zeroRunId: null });
  assert.equal(coveredByStockZero(new Date('2026-10-01T00:00:00Z'), null), false);
  assert.equal(coveredByStockZero(new Date('2026-10-01T00:00:00Z'), z), true);
  assert.equal(coveredByStockZero(new Date(z.getTime()), z), true, 'لحظة التصفير نفسها مغطّاة');
  assert.equal(coveredByStockZero(new Date(z.getTime() + 1), z), false);
  assert.equal(coveredByStockZero('2026-10-01', z), false, 'نصٌّ لا يُقارن');
  // التراجع: السبب الجديد أولاً، وغيابه يُبقي الأسباب كما كانت
  const none = { vanLoads: 0, invoiceItems: 0, warehouseOut: 0 };
  assert.equal(openingStockRevertBlockReason(none), null);
  assert.equal(openingStockRevertBlockReason({ ...none, zeroedAfter: false }), null);
  assert.equal(openingStockRevertBlockReason({ ...none, zeroedAfter: true }), 'صُفّر المخزون بعد هذا الاستيراد');
  assert.equal(openingStockRevertBlockReason({ ...none, warehouseOut: 1, zeroedAfter: true }), 'صُفّر المخزون بعد هذا الاستيراد');
  assert.equal(openingStockRevertBlockReason({ ...none, vanLoads: 2 }), 'حُمّل من أصناف المخزون الافتتاحي إلى السيارات');
});

// ═══ المسار الحقيقي ═══

test('بلا تصفير: السلوك كما كان — الحركات السابقة والدفعة غير المتراجع عنها تمنع، والاستعلامات بلا createdAt ولا zeroRunId', async () => {
  fresh();
  await history();
  whereLog.length = 0;
  const r = await importFile(ALL);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(codes(r.body), [[2, 'PRODUCT_HAS_STOCK_MOVEMENTS'], [3, 'PRODUCT_HAS_STOCK_MOVEMENTS'], [4, 'OPENING_STOCK_ALREADY_IMPORTED']]);
  assert.equal(r.body.data.errors[0].message, IMPORT_ROW_MESSAGES.PRODUCT_HAS_STOCK_MOVEMENTS);
  assert.equal(r.body.data.created, 1);
  assert.ok(whereLog.length >= 2);
  for (const { table, where } of whereLog) {
    const scope = table === 'warehouse' ? where.entry : where.vanLoad;
    assert.deepEqual(Object.keys(scope).sort(), table === 'warehouse' ? ['tenantId'] : ['tenantId', 'type'], `${table}: شرطٌ زائد بلا تصفير`);
  }
});

test('بعد التصفير: حركات ما قبله (ومنها تسوية التصفير نفسها) ودفعة الجرد السابقة لا تمنع — الملف كله يُقبل', async () => {
  fresh();
  await history();
  const at = zero();
  whereLog.length = 0;
  const r = await importFile(ALL);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(codes(r.body), []);
  assert.equal(r.body.data.created, 4);
  // الاستعلامان بحدّ آخر تصفير وبلا حركات التصفير
  const wh = whereLog.find((x) => x.table === 'warehouse')!.where;
  assert.deepEqual([wh.entry.createdAt, wh.entry.zeroRunId], [{ gt: at }, null]);
  // p1 ثبتت «بلا حركة» في المستودع فيُسأل عن تحميلاته كذلك
  const van = whereLog.find((x) => x.table === 'van')!.where;
  assert.deepEqual([van.vanLoad.createdAt, van.vanLoad.zeroRunId], [{ gt: at }, null]);
  // والجرد الجديد نفسه يمنع تكراره كما كان (دفعة بعد التصفير)
  const again = await importFile([{ productCode: 'D-4', qty: 8, unitCost: 2 }]);
  assert.deepEqual(codes(again.body), [[2, 'OPENING_STOCK_ALREADY_IMPORTED']]);
});

test('حركة بعد التصفير تمنع كما كانت: وارد مستودع لـp1 وتحميل سيارة لـp2 وتنزيل لـp4، وp3 (دفعته قبل التصفير) يُقبل', async () => {
  fresh();
  await history();
  zero();
  world.entry('RECEIVE', [{ productId: 'p1', qty: 2 }]);
  world.vanMove('LOAD', 'r1', 'p2', 1, null);
  world.vanMove('UNLOAD', 'r1', 'p4', 1, null);
  const r = await importFile(ALL);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(codes(r.body), [[2, 'PRODUCT_HAS_STOCK_MOVEMENTS'], [3, 'PRODUCT_HAS_STOCK_MOVEMENTS'], [5, 'PRODUCT_HAS_STOCK_MOVEMENTS']]);
  assert.equal(r.body.data.created, 1);
  assert.deepEqual(world.items.filter((i) => i.entryId === r.body.data.entryId).map((i) => i.productId), ['p3']);
});

test('تصفيرٌ ثانٍ: الحدّ آخر تشغيلة — حركة بين التصفيرين لا تمنع بعد الثاني', async () => {
  fresh();
  await history();
  zero();
  world.entry('RECEIVE', [{ productId: 'p1', qty: 2 }]);
  assert.deepEqual(codes((await importFile([ALL[0]])).body), [[2, 'PRODUCT_HAS_STOCK_MOVEMENTS']]);
  zero();
  const r = await importFile([ALL[0]]);
  assert.deepEqual(codes(r.body), []);
  assert.equal(r.body.data.created, 1);
});

test('تصفيرٌ التزم أثناء معاملة الجرد (أحدث من بدايتها) ⇒ 409 OPENING_STOCK_LEDGER_BUSY بلا حركة ولا دفعة', async () => {
  fresh();
  runs.push({ tenantId: 't1', createdAt: new Date(Date.parse('2027-01-01T00:00:00Z')), warehouseZeroed: true });
  const r = await importFile([ALL[3]]);
  assert.deepEqual([r.status, r.body.code, r.body.message], [409, 'OPENING_STOCK_LEDGER_BUSY', STOCK_ZERO_DURING_IMPORT_MESSAGE]);
  assert.equal(world.entries.length, 0);
  assert.equal(world.batches.length, 0);
});

test('التراجع: دفعة جرد قبل التصفير ممنوعة بسببه (ولو بلا تسوية مستودع تمنعها)، وبلا تصفير يُتراجع عنها كما كان', async () => {
  fresh();
  const batchId = await history();
  runs.push({ tenantId: 't1', createdAt: world.now(), warehouseZeroed: false });   // تصفيرٌ بلا تسوية مستودع (المستودع مطفأ حينها)
  zeroWheres.length = 0;
  const blocked = await call('post', '/batches/:id/revert', { params: { id: batchId } });
  // التراجع يقرأ آخر تصفيرٍ أيّاً كان (بلا warehouseZeroed): منعه هو الاتجاه المحافظ
  assert.deepEqual(zeroWheres, [{ tenantId: 't1' }]);
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.data.reverted, false);
  assert.deepEqual(blocked.body.data.blocked.map((b: Row) => b.reason), ['صُفّر المخزون بعد هذا الاستيراد']);
  assert.equal(world.batches.find((b) => b.id === batchId)?.reverted, false);
  // بلا تصفير: التراجع كما كان
  runs = [];
  const ok = await call('post', '/batches/:id/revert', { params: { id: batchId } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.reverted, true);
});

// ═══ تصفيرٌ والمستودع مطفأ (warehouseZeroed=false) لا يصير حدّاً للاستيراد ═══

test('تصفيرٌ لم يصفّر المستودع (مطفأ حينها) لا يرفع المنع: الحركات والدفعة قبله تمنع كما بلا تصفير، والشرط warehouseZeroed', async () => {
  fresh();
  await history();
  // تصفير السيارات وحدها: لا تسوية مستودع، فرصيد المستودع المخفي (+١٠ لـp1، و+٣ دفعة p3) باقٍ
  runs.push({ tenantId: 't1', createdAt: world.now(), warehouseZeroed: false });
  whereLog.length = 0;
  zeroWheres.length = 0;
  const r = await importFile(ALL);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(codes(r.body), [[2, 'PRODUCT_HAS_STOCK_MOVEMENTS'], [3, 'PRODUCT_HAS_STOCK_MOVEMENTS'], [4, 'OPENING_STOCK_ALREADY_IMPORTED']]);
  assert.equal(r.body.data.created, 1);
  assert.deepEqual(zeroWheres, [{ tenantId: 't1', warehouseZeroed: true }]);
  // والاستعلامان بلا حدّ (كما بلا تصفير حرفياً)
  for (const { table, where } of whereLog) {
    const scope = table === 'warehouse' ? where.entry : where.vanLoad;
    assert.deepEqual(Object.keys(scope).sort(), table === 'warehouse' ? ['tenantId'] : ['tenantId', 'type'], `${table}: حدٌّ من تصفيرٍ لم يمسّ المستودع`);
  }
});

test('الحدّ آخر تصفيرٍ صفّر المستودع: تصفيرٌ لاحق والمستودع مطفأ لا يغطّي حركةً بينهما، ولا يُعدّ سباقاً (لا 409)', async () => {
  fresh();
  await history();
  zero();                                              // صفّر المستودع
  world.entry('RECEIVE', [{ productId: 'p1', qty: 70 }]);   // +٧٠ بعده
  runs.push({ tenantId: 't1', createdAt: world.now(), warehouseZeroed: false });   // ثم تصفير السيارات وحدها
  const r = await importFile([ALL[0], ALL[2]]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(codes(r.body), [[2, 'PRODUCT_HAS_STOCK_MOVEMENTS']], 'p1: الـ+٧٠ لم يُصفَّر؛ p3: دفعته قبل التصفير الأول');
  assert.equal(r.body.data.created, 1);
  // تصفيرٌ لم يمسّ المستودع «أحدث» من بدء المعاملة ليس سباقاً على المستودع
  fresh();
  runs.push({ tenantId: 't1', createdAt: new Date(Date.parse('2027-01-01T00:00:00Z')), warehouseZeroed: false });
  const ok = await importFile([ALL[3]]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.created, 1);
});

// ═══ التراجع والتتبّع مطفأ يتسلسل مع تصفيرٍ جارٍ ═══

const PRODUCT_SHARE = /^SELECT id FROM products WHERE "tenantId" = \$1 AND id = ANY\(\$2::text\[\]\) ORDER BY id FOR KEY SHARE$/;

test('التراجع والتتبّع مطفأ: قفل الحركة ثم FOR KEY SHARE على أصنافها (مرتّبة) ثم آخر تصفير — ثم الحذف', async () => {
  fresh();
  const first = await importFile([ALL[3], ALL[2]]);
  const batchId = first.body.data.batchId as string;
  world.calls.length = 0;
  const r = await call('post', '/batches/:id/revert', { params: { id: batchId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.reverted, true);
  const ops = world.calls;
  const entryLock = ops.findIndex((c) => c.op === 'query' && /FROM warehouse_entries WHERE id/.test(c.sql ?? ''));
  const share = ops.findIndex((c) => c.op === 'query' && PRODUCT_SHARE.test(c.sql ?? ''));
  const zeroRead = ops.findIndex((c) => c.op === 'stockZeroRun.findFirst');
  assert.ok(entryLock >= 0 && share > entryLock && zeroRead > share, JSON.stringify(ops.map((c) => c.op + (c.sql ? `: ${c.sql}` : ''))));
  assert.deepEqual(ops[share].values, ['t1', ['p3', 'p4']]);
  assert.equal(ops.filter((c) => c.op === 'query' && PRODUCT_SHARE.test(c.sql ?? '')).length, 1);
});

test('التراجع والتتبّع مطفأ: انتظار قفل الأصناف يتجاوز المهلة (تصفيرٌ جارٍ) ⇒ 409 IMPORT_REVERT_LEDGER_BUSY والدفعة باقية', async () => {
  fresh();
  const first = await importFile([ALL[3]]);
  const batchId = first.body.data.batchId as string;
  world.calls.length = 0;
  world.failOn = (sql) => (PRODUCT_SHARE.test(sql) ? new Error('canceling statement due to lock timeout (55P03)') : null);
  try {
    const r = await call('post', '/batches/:id/revert', { params: { id: batchId } });
    assert.deepEqual([r.status, r.body.code], [409, 'IMPORT_REVERT_LEDGER_BUSY']);
  } finally {
    world.failOn = null;
  }
  assert.equal(world.batches.find((b) => b.id === batchId)?.reverted, false);
  assert.ok(world.entries.some((e) => e.id === first.body.data.entryId), 'الحركة حُذفت رغم الانشغال');
  assert.ok(!world.calls.some((c) => c.op === 'stockZeroRun.findFirst'), 'قُرئ آخر تصفير قبل القفل');
});

test('التراجع والتتبّع مفعّل: قفل lockLotProducts وحده يكفي — لا قفل أصناف ثانٍ', async () => {
  fresh();
  const first = await importFile([ALL[3]]);
  const batchId = first.body.data.batchId as string;
  world.lotsEnabled = true;
  world.calls.length = 0;
  const r = await call('post', '/batches/:id/revert', { params: { id: batchId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.reverted, true);
  assert.equal(world.calls.filter((c) => c.op === 'query' && PRODUCT_SHARE.test(c.sql ?? '')).length, 0);
  const lotShare = world.calls.findIndex((c) => c.op === 'query' && /FROM products .*FOR KEY SHARE$/.test(c.sql ?? ''));
  const zeroRead = world.calls.findIndex((c) => c.op === 'stockZeroRun.findFirst');
  assert.ok(lotShare >= 0 && zeroRead > lotShare, 'آخر تصفير قبل قفل الأصناف');
});

test('حارس ثابت: آخر تصفير يُقرأ بعد قفل الأصناف وقبل دفعات الجرد، ويدخل الاستعلامين وخريطة الدفعات والتراجع', () => {
  const src = require('node:fs').readFileSync(path.join(SRC, 'routes/import.ts'), 'utf8').replace(/\r\n/g, '\n') as string;
  const start = src.indexOf("router.post('/opening-stock'");
  const body = src.slice(start, src.indexOf('\nrouter.', start + 10));
  let pos = -1;
  for (const n of [
    'await lockBases(tx, tid, expectedBases)', 'const zeroedAt = await latestStockZeroAt(tx, tid, { warehouseOnly: true })', 'zeroedAt.getTime() >= dbNow.getTime()',
    'kind: OPENING_STOCK_KIND, reverted: false', 'entry: { tenantId: tid, ...afterZero }', "type: { in: ['LOAD', 'UNLOAD'] }, ...afterZero",
    '!coveredByStockZero(b.createdAt, zeroedAt)', 'openingStockMovementConflicts(',
  ]) {
    const k = body.indexOf(n, pos + 1);
    assert.ok(k > pos, `/opening-stock: ${n} خارج الترتيب`);
    pos = k;
  }
  const rev = src.slice(src.indexOf('} else if (batch.kind === OPENING_STOCK_KIND) {'));
  const k = rev.indexOf('coveredByStockZero(entry.createdAt, await latestStockZeroAt(tx, tid))');
  assert.ok(k > 0 && k < rev.indexOf('openingStockRevertBlockReason('), 'التراجع لا يقرأ آخر تصفير قبل أسباب المنع');
  // والتتبّع مطفأ: FOR KEY SHARE على أصناف الحركة بعد lockLotProducts وقبل قراءة آخر تصفير (ينتظر التزام تصفيرٍ جارٍ)
  const lots = rev.indexOf('await lockLotProducts(tx, tid, productIds)');
  const gate = rev.indexOf('if (!lotLocks && productIds.length) {');
  const share = rev.indexOf('ORDER BY id FOR KEY SHARE', gate);
  assert.ok(lots > 0 && gate > lots && share > gate && share < k, 'التراجع لا يقفل أصناف الحركة قبل قراءة آخر تصفير');
});
