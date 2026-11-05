// مراجعة المخزون — حركات المستودع (POST /warehouse/entries) فوق القاعدة المزيّفة lots-b3-fake.ts (نمط line-ref-warehouse.test.ts):
//  · D8: clientRef — يُحفظ، والمكرَّر يردّ الحركة القائمة 200 (replay: true) بلا كتابة ولو تزامن مع أصله (القفل في المعاملة يجده)،
//    ومرجعٌ لحركةٍ من نوعٍ آخر 409 CLIENT_REF_REUSED، ولكل شركة مستقلّ، وGET /entries?clientRef=.
//  · D3: الوارد RECEIVE لصنفٍ مؤرشف 422 PRODUCT_ARCHIVED بموضع سطره، والتسوية عليه تمرّ (طريق تصفية رصيده).
//  · #23: صنفٌ لا يتبع الشركة 400 PRODUCT_NOT_FOUND بموضع سطره (كان «منتج غير صالح» بلا رمز ولا سطر).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { World, type Row } from './lots-b3-fake';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const world = new World();
const db = world.db;
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const router = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
const { authenticate } = require('../middleware/auth') as typeof import('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// القاعدة المزيّفة لا تعرف العمود الجديد: تُكمَل هنا كما تفعل Prisma — clientRef والشركة على رأس الحركة، والبحث بهما
const refOf = new Map<string, string | null>();
let hidePrior = 0;
const origCreate = db.warehouseEntry.create as (a: Row) => Promise<Row>;
db.warehouseEntry.create = async (a: Row) => {
  const out = await origCreate(a);
  const e = world.entries.at(-1)!;
  e.tenantId = a.data.tenantId;
  refOf.set(e.id, a.data.clientRef ?? null);
  return { ...out, tenantId: e.tenantId, clientRef: a.data.clientRef ?? null };
};
const origFindMany = db.warehouseEntry.findMany as (a: Row) => Promise<Row[]>;
db.warehouseEntry.findMany = async (a: Row) => (await origFindMany(a)).filter((e) => a.where.clientRef === undefined || refOf.get(e.id as string) === a.where.clientRef);
db.warehouseEntry.findFirst = async (a: Row) => {
  world.calls.push({ op: 'warehouseEntry.findFirst', args: a });
  // محاكاة طلبٍ تزامن مع أصله: البحث الأول (خارج المعاملة) لا يراه
  if (hidePrior > 0) { hidePrior--; return null; }
  const e = world.entries.find((x) => x.tenantId === a.where.tenantId && refOf.get(x.id) === a.where.clientRef);
  if (!e) return null;
  return { ...e, clientRef: refOf.get(e.id), items: world.items.filter((i) => i.entryId === e.id).map((i) => ({ ...i, product: { id: i.productId, name: i.productId, unit: 'حبة', primaryUnitId: null } })) };
};

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: 't1', name: 'المدير' };

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: Function }

async function call(method: string, p: string, req: Row = {}): Promise<{ status: number; body: Row }> {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods[method]);
  assert.ok(layer, `${method} ${p} مفقود`);
  const pre = stack.filter((l) => !l.route && l.handle.length < 4 && l.handle !== authenticate).map((l) => l.handle);
  const errHandlers = [...stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle), errorHandler];
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
  if (err) {
    for (const eh of errHandlers) {
      let next: unknown = null;
      let passed = false;
      await eh(err, full, res, (e?: unknown) => { next = e; passed = true; });
      if (!passed) return { status: res.statusCode, body: res.body };
      err = next;
    }
    return { status: 500, body: { message: (err as Error)?.message } };
  }
  return { status: res.statusCode, body: res.body };
}

/** عالمٌ جديد: P3 غير متتبَّع، وOLD مؤرشف بقي له رصيد، وQ1 لشركةٍ أخرى — والميزة مطفأة (المسار القائم) */
function fresh(): void {
  Object.assign(world, new World());
  world.lotsEnabled = false;
  world.product({ id: 'P3', name: 'سكر' });
  world.product({ id: 'OLD', name: 'كرتون بيض M', status: 'INACTIVE', deletedAt: new Date('2026-10-01T00:00:00Z') });
  world.product({ id: 'Q1', name: 'سكر', tenantId: 't2' });
  refOf.clear();
  hidePrior = 0;
}
const post = (body: Row, user: Row = ADMIN) => call('post', '/entries', { body, user });
const creates = () => world.calls.filter((c) => c.op === 'warehouseEntry.create').length;

test('D8: المرجع يُحفظ، والمكرَّر 200 بالحركة نفسها (replay) بلا كتابة ولا حكمٍ جديد، وGET ?clientRef= يجدها', async () => {
  fresh();
  const first = await post({ type: 'RECEIVE', clientRef: 'po-2026-114', items: [{ productId: 'P3', qty: 50, unitCost: 3 }] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = first.body.data.id as string;
  assert.equal(refOf.get(id), 'po-2026-114');
  // الإعادة بعد ضياع الردّ — ولو أُرشف الصنف بعدها: الحركة القائمة لا 422
  world.products.find((p) => p.id === 'P3')!.deletedAt = new Date();
  const again = await post({ type: 'RECEIVE', clientRef: 'po-2026-114', items: [{ productId: 'P3', qty: 50, unitCost: 3 }] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replay, true);
  assert.equal(again.body.data.id, id);
  assert.deepEqual((again.body.data.items as Row[]).map((i) => [i.productId, i.qty]), [['P3', 50]]);
  assert.equal(creates(), 1, 'لا كتابة ثانية');
  assert.equal(world.entries.length, 1);
  const g = await call('get', '/entries', { query: { clientRef: 'po-2026-114' } });
  assert.deepEqual((g.body.data as Row[]).map((e) => e.id), [id]);
  assert.deepEqual((await call('get', '/entries', { query: { clientRef: 'other' } })).body.data, []);
  assert.equal(((await call('get', '/entries', { query: { clientRef: { in: ['x'] } } })).body.data as Row[]).length, 1, 'كائن qs يُهمل');
  assert.equal((await post({ type: 'RECEIVE', clientRef: 'مرجع', items: [{ productId: 'P3', qty: 1 }] })).status, 400, 'مرجعٌ غير لاتيني 400');
});

test('D8: طلبٌ مكرَّر تزامن مع أصله (لم يره البحث الأول) — قفل المرجع في المعاملة يجده فيُردّ 200 وتُجهَض المعاملة بلا كتابة', async () => {
  fresh();
  assert.equal((await post({ type: 'ADJUST', clientRef: 'adj-1', items: [{ productId: 'P3', qty: -2 }] })).status, 201);
  hidePrior = 1;
  world.calls = [];
  const again = await post({ type: 'ADJUST', clientRef: 'adj-1', items: [{ productId: 'P3', qty: -2 }] });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replay, true);
  assert.equal(creates(), 0);
  const ops = world.calls.map((c) => (c.op === 'exec' ? `exec:${String(c.values?.[0]).split(':')[0]}` : c.op));
  assert.ok(ops.indexOf('exec:warehouse-entry-ref') >= 0 && ops.indexOf('exec:warehouse-entry-ref') < ops.lastIndexOf('warehouseEntry.findFirst'), `القفل قبل البحث الثاني: ${ops.join(' ')}`);
  assert.ok(ops.includes('tx.rollback'));
});

test('D8: مرجعٌ لحركةٍ من نوعٍ آخر 409 CLIENT_REF_REUSED، والمرجع نفسه لشركةٍ أخرى حركةٌ مستقلّة', async () => {
  fresh();
  assert.equal((await post({ type: 'RECEIVE', clientRef: 'dup', items: [{ productId: 'P3', qty: 5 }] })).status, 201);
  const r = await post({ type: 'ADJUST', clientRef: 'dup', items: [{ productId: 'P3', qty: 1 }] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CLIENT_REF_REUSED');
  const other = await post({ type: 'RECEIVE', clientRef: 'dup', items: [{ productId: 'Q1', qty: 5 }] }, { ...ADMIN, tenantId: 't2' });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  assert.equal(world.entries.length, 2);
});

test('D3: الوارد لصنفٍ مؤرشف 422 PRODUCT_ARCHIVED بموضعه بلا حركة، والتسوية عليه تمرّ؛ و#23: صنفٌ غريب 400 PRODUCT_NOT_FOUND بموضعه', async () => {
  fresh();
  const r = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 1 }, { productId: 'OLD', qty: 3 }] });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.deepEqual([r.body.code, r.body.productId, r.body.index], ['PRODUCT_ARCHIVED', 'OLD', 1]);
  assert.match(String(r.body.message), /«كرتون بيض M» محذوف/);
  assert.equal(world.entries.length, 0);
  const adj = await post({ type: 'ADJUST', items: [{ productId: 'OLD', qty: 25 }] });
  assert.equal(adj.status, 201, JSON.stringify(adj.body));
  // الموضع من items كما أرسلها العميل: السطر الصفري لا يزيحه
  const nf = await post({ type: 'RECEIVE', items: [{ productId: 'P3', qty: 0 }, { productId: 'P3', qty: 1 }, { productId: 'Q1', qty: 1 }] });
  assert.equal(nf.status, 400, JSON.stringify(nf.body));
  assert.deepEqual([nf.body.code, nf.body.productId, nf.body.index, nf.body.indexes], ['PRODUCT_NOT_FOUND', 'Q1', 2, [2]]);
});
