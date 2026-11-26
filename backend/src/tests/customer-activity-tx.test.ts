// «سجلّ العميل» — ذرّية الحدث مع إجرائه (QA ٢٧ نوفمبر ٢٠٢٦): أحداثٌ كانت تُكتب **بعد** التزام الإجراء (recordActivityAfter) فيضيع
// الحدث إلى الأبد لو تعذّر، صارت في معاملة الإجراء نفسها. فوق Prisma مزيّف **بمعاملاتٍ تُتراجع** (ما كُتب في معاملةٍ فشلت أو فشل
// التزامها لا يبقى — لا الحدث ولا الإجراء)، بلا قاعدة ولا شبكة ولا خادم. لكل موضع:
//   ١) الالتزام ⇒ حدثٌ واحد بالضبط، بمقبض معاملة الإجراء نفسها.
//   ٢) فشلٌ بعد كتابة الحدث داخل المعاملة (تعذّر إدراجه، أو فشل COMMIT) ⇒ لا حدث ولا إجراء.
//   ٣) الإعادة بالمرجع نفسه (clientRef) ⇒ ما زال حدثاً واحداً.
// المواضع: الزيارة (routes/visits.ts POST /)، الإسناد التلقائي (services/customerScope.ts ensureAssignment)، طلب المنيو العام
// (routes/publicCatalog.ts)، وإغلاق طلب المنيو (routes/catalogOrders.ts POST /:id/status).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
type Row = Record<string, any>;

// ═══════════════════ Prisma مزيّف بمعاملاتٍ تُلتزم أو تُتراجع ═══════════════════

/** سياق النداء: معاملته، ومُسجِّل أثرٍ يقع عند الالتزام وحده (خارج المعاملة: فوراً) */
type Ctx = { tx: number | null; onCommit: (fn: () => void) => void };
type Call = { op: string; args: any; tx: number | null };
let calls: Call[] = [];
let scripted: Record<string, (args: any, ctx: Ctx) => unknown> = {};
let raw: (sql: string, values: unknown[]) => unknown = () => undefined;
/** أسطر السجلّ الملتزمة ومعاملة كلٍّ منها */
let committed: { row: Row; tx: number | null }[] = [];
/** عدد المعاملات القادمة التي يفشل التزامها بعد نجاح ردّ النداء (فشل COMMIT) */
let failCommits = 0;
let txSeq = 0;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}

function client(tx: number | null, pending: (() => void)[] | null): Row {
  const ctx: Ctx = { tx, onCommit: (fn) => { if (pending) pending.push(fn); else fn(); } };
  return new Proxy({}, {
    get: (_t, key: string) => {
      if (key === 'then') return undefined;
      if (key === '$transaction') {
        return async (arg: unknown, opts?: unknown) => {
          if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
          if (tx !== null) return (arg as (t: unknown) => Promise<unknown>)(client(tx, pending));
          const id = ++txSeq;
          const buf: (() => void)[] = [];
          calls.push({ op: '$transaction', args: opts ?? null, tx: id });
          try {
            const out = await (arg as (t: unknown) => Promise<unknown>)(client(id, buf));
            if (failCommits > 0) {
              failCommits--;
              throw Object.assign(new Error('simulated COMMIT failure'), { code: 'P2034' });
            }
            for (const f of buf) f();
            calls.push({ op: '$commit', args: null, tx: id });
            return out;
          } catch (e) {
            calls.push({ op: '$rollback', args: (e as Error)?.message ?? null, tx: id });
            throw e;
          }
        };
      }
      if (key === '$queryRaw' || key === '$executeRaw') {
        return async (strings: unknown, ...values: unknown[]) => {
          const sql = (Array.isArray(strings) ? (strings as string[]).join('?') : String(strings)).replace(/\s+/g, ' ');
          calls.push({ op: key, args: { sql, values }, tx });
          const out = raw(sql, values);
          if (out !== undefined) return out;
          return key === '$queryRaw' ? [] : 0;
        };
      }
      return new Proxy({}, {
        get: (_m, method: string) => {
          if (method === 'then') return undefined;
          return async (args: any) => {
            calls.push({ op: `${key}.${method}`, args, tx });
            const fn = scripted[`${key}.${method}`];
            if (key === 'customerActivity' && method === 'createMany') {
              if (fn) await fn(args, ctx); // قد يرمي (تعذّر إدراج الحدث)
              const rows = (args?.data ?? []).map((d: Row) => ({ row: { ...d }, tx }));
              ctx.onCommit(() => committed.push(...rows));
              return { count: rows.length };
            }
            return fn ? fn(args, ctx) : defaultFor(method);
          };
        },
      });
    },
  });
}
const prismaFake = client(null, null);

function reset(): void {
  calls = []; scripted = {}; committed = []; failCommits = 0; raw = () => undefined;
}
const events = (): Row[] => committed.map((c) => c.row);
const callOf = (op: string): Call | undefined => calls.find((c) => c.op === op);
const P2002 = () => Object.assign(new Error('Unique constraint failed on the fields: (`clientRef`)'), { code: 'P2002' });
const ACTIVITY_DOWN = () => { throw new Error('activity insert failed'); };

// ═══════════════════ الحقن قبل تحميل المسارات ═══════════════════

const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
const realAuth = require('../middleware/auth') as typeof import('../middleware/auth');
stub('middleware/auth', {
  ...realAuth,
  authenticate: pass, requireAdmin: pass, requireAdminPermission: () => pass, requireSalesRep: pass, requireSuperAdmin: pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
const realAdminScope = require('../services/adminScope') as typeof import('../services/adminScope');
stub('services/adminScope', {
  ...realAdminScope,
  adminScopeEnabled: async () => false, adminCustomerFilter: async () => ({}), adminRepFilter: async () => ({}),
  scopedRecordWhere: async () => ({}), scopedRepRecordWhere: async () => ({}), canAccessRep: async () => true,
  canAccessCustomerAsAdmin: async () => true, existingInScope: async () => true,
});
const realWebPush = require('../services/webPush') as Row;
stub('services/webPush', { ...realWebPush, sendPushToRep: async () => 0, sendPushToAdmins: async () => 0, sendPush: async () => 'sent' });

const visitsRouter = require('../routes/visits').default;
const publicCatalogRouter = require('../routes/publicCatalog').default;
const catalogOrdersRouter = require('../routes/catalogOrders').default;
const { ensureAssignment } = require('../services/customerScope') as typeof import('../services/customerScope');

// ═══════════════════ تشغيل مكدّس المسار ═══════════════════

type Reply = { status: number; body: any; error: unknown };
async function call(router: unknown, method: string, p: string, req: Row, opts: { lastOnly?: boolean } = {}): Promise<Reply> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} missing`);
  const res: Row = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; res.headersSent = true; return res; };
  res.setHeader = (k: string, v: unknown) => { res.headers[k.toLowerCase()] = v; return res; };
  res.set = res.setHeader;
  const full = { method: method.toUpperCase(), url: p, query: {}, params: {}, body: {}, headers: {}, ip: '127.0.0.1', ...req };
  const stack: Row[] = opts.lastOnly ? [layer!.route.stack.at(-1)] : layer!.route.stack;
  for (const h of stack) {
    let passed = false;
    let err: unknown = null;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) return { status: 500, body: null, error: err };
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body, error: null };
}
const why = (r: Reply): string => (r.error ? String((r.error as Error)?.stack ?? r.error) : JSON.stringify(r.body));
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error; const w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
}

const T = 'T1';
const REP = { id: 'rep-1', role: 'SALES_REP', tenantId: T, name: 'خالد' };

// ═══════════════════ الزيارة ═══════════════════

let visits: Row[] = [];
let visitSeq = 0;
/** الزيارات الملتزمة وحدها في visits — والمكتوبة في معاملةٍ تراجعت لا تبقى. والفريد (tenantId, clientRef) كالقاعدة */
function scriptVisits(): void {
  visits = [];
  scripted = {
    'salesRep.findFirst': () => ({ id: 'rep-1', name: 'خالد', requireLocationOn: false, tenant: { settings: { teamsEnabled: false } }, teamMemberships: [] }),
    'customer.findFirst': () => ({ id: 'c-1' }),
    'repVisit.findFirst': (a: Row) => visits.find((v) => v.clientRef === a.where?.clientRef) ?? null,
    'repVisit.create': (a: Row, ctx: Ctx) => {
      if (a.data.clientRef && visits.some((v) => v.clientRef === a.data.clientRef)) throw P2002();
      const { photos, ...data } = a.data;
      const v = { id: `v-${++visitSeq}`, createdAt: new Date(), ...data, _count: { photos: photos?.create?.length ?? 0 } };
      ctx.onCommit(() => visits.push(v));
      return v;
    },
  };
}
const VISIT_REF = '5d2f6a3b-1c4e-4f8a-9b7c-0a1b2c3d4e5f';
const visitBody = () => ({
  customerId: 'c-1', note: 'الرف ممتلئ', lat: 24.7, lng: 46.7, clientRef: VISIT_REF, photos: ['data:image/jpeg;base64,AAAA'],
  startedAt: new Date(Date.now() - 600_000).toISOString(), endedAt: new Date(Date.now() - 300_000).toISOString(),
});
const postVisit = () => call(visitsRouter, 'post', '/', { user: REP, body: visitBody() });

test('الزيارة: الالتزام ⇒ زيارةٌ واحدة وحدث VISIT_RECORDED واحد بمقبض معاملة إنشائها نفسها', async () => {
  reset(); scriptVisits();
  const r = await postVisit();
  assert.equal(r.status, 201, why(r));
  assert.equal(visits.length, 1);
  assert.equal(events().length, 1);
  const e = events()[0];
  assert.deepEqual([e.action, e.customerId, e.refType, e.refId, e.actorKind, e.data.photosCount], ['VISIT_RECORDED', 'c-1', 'VISIT', visits[0].id, 'REP', 1]);
  const create = callOf('repVisit.create')!;
  assert.notEqual(create.tx, null, 'الإنشاء داخل معاملة');
  assert.equal(committed[0].tx, create.tx, 'الحدث بمقبض معاملة الزيارة نفسها');
  assert.deepEqual(callOf('$transaction')!.args, { maxWait: 10_000, timeout: 60_000 }, 'مهلةٌ تتّسع للصور');
  assert.equal(r.body.data.id, visits[0].id, 'الردّ بالزيارة كما كان');
});

test('الزيارة: تعذّر إدراج الحدث داخل المعاملة ⇒ لا زيارة ولا حدث — وإعادة الرفع بالمرجع نفسه تحفظها مع حدثٍ واحد', async () => {
  reset(); scriptVisits();
  scripted['customerActivity.createMany'] = ACTIVITY_DOWN;
  const f = await quiet(postVisit);
  assert.equal(f.status, 500);
  assert.match(String((f.error as Error)?.message), /activity insert failed/);
  assert.equal(visits.length, 0, 'الزيارة تراجعت مع حدثها');
  assert.equal(events().length, 0);
  assert.ok(callOf('repVisit.create') && calls.some((c) => c.op === '$rollback'));

  delete scripted['customerActivity.createMany'];
  const r = await postVisit();
  assert.equal(r.status, 201, why(r));
  assert.equal(visits.length, 1);
  assert.equal(events().length, 1);
});

test('الزيارة: فشل الالتزام بعد كتابة الحدث ⇒ لا زيارة ولا حدث', async () => {
  reset(); scriptVisits();
  failCommits = 1;
  const f = await quiet(postVisit);
  assert.equal(f.status, 500);
  assert.equal(calls.filter((c) => c.op === 'customerActivity.createMany').length, 1, 'الحدث كُتب داخل المعاملة قبل فشلها');
  assert.equal(visits.length, 0);
  assert.equal(events().length, 0);
});

test('الزيارة: الإعادة بالمرجع نفسه (clientRef) ⇒ ما زال حدثاً واحداً — والإعادة المتزامنة (P2002) تتراجع بحدثها', async () => {
  reset(); scriptVisits();
  assert.equal((await postVisit()).status, 201);
  const again = await postVisit();
  assert.equal(again.status, 200, why(again));
  assert.equal(again.body.idempotent, true);
  assert.equal(visits.length, 1);
  assert.equal(events().length, 1, 'الإعادة لا تُكرّر الحدث');

  // سباق: الفحص المسبق لم يرَ الأولى (التزمت بعده) ⇒ الإنشاء يصطدم بالفريد فتتراجع المعاملة كلها — لا زيارة ثانية ولا حدث ثانٍ
  scripted['repVisit.findFirst'] = () => null;
  const raced = await quiet(postVisit);
  assert.equal(raced.status, 500);
  assert.equal((raced.error as { code?: string })?.code, 'P2002');
  assert.equal(visits.length, 1);
  assert.equal(events().length, 1);
});

// ═══════════════════ الإسناد التلقائي ═══════════════════

let assignments: Row[] = [];
function scriptAssign(): void {
  assignments = [];
  const exists = (d: Row) => assignments.some((x) => x.customerId === d.customerId && x.salesRepId === d.salesRepId);
  scripted = {
    'salesRep.findFirst': () => ({ name: 'خالد' }),
    // ON CONFLICT DO NOTHING: count = 1 لإدراجٍ جديد، و٠ لقائم
    'customerAssignment.createMany': (a: Row, ctx: Ctx) => {
      const d = a.data[0];
      if (exists(d)) return { count: 0 };
      ctx.onCommit(() => assignments.push(d));
      return { count: 1 };
    },
    'customerAssignment.upsert': (a: Row, ctx: Ctx) => {
      const d = a.create;
      if (!exists(d)) ctx.onCommit(() => assignments.push(d));
      return { id: 'as-1', ...d };
    },
  };
}
const RMETA = { actor: { kind: 'REP' as const, id: 'rep-1', name: 'خالد' }, source: 'rep' };

test('الإسناد التلقائي: الالتزام ⇒ إسنادٌ واحد وحدث CUSTOMER_ASSIGNED واحد بمقبض معاملة الإسناد نفسها (الإنشاء والإعادة)', async () => {
  reset(); scriptAssign();
  await ensureAssignment(T, 'c-1', 'rep-1', RMETA, { createdNow: true });
  assert.equal(assignments.length, 1);
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.refId, e.actorKind, e.data.repName, e.data.mode]), [['CUSTOMER_ASSIGNED', 'c-1', 'rep-1', 'REP', 'خالد', 'AUTO']]);
  const write = callOf('customerAssignment.upsert')!;
  assert.notEqual(write.tx, null);
  assert.equal(committed[0].tx, write.tx);

  reset(); scriptAssign();
  await ensureAssignment(T, 'c-2', 'rep-1', RMETA);
  const cm = callOf('customerAssignment.createMany')!;
  assert.notEqual(cm.tx, null);
  assert.deepEqual(committed.map((c) => [c.row.customerId, c.tx]), [['c-2', cm.tx]]);
});

test('الإسناد التلقائي: تعذّر الحدث أو فشل الالتزام ⇒ لا إسناد ولا حدث — والإعادة تُسنده مرّةً بحدثٍ واحد', async () => {
  reset(); scriptAssign();
  scripted['customerActivity.createMany'] = ACTIVITY_DOWN;
  await assert.rejects(ensureAssignment(T, 'c-1', 'rep-1', RMETA, { createdNow: true }), /activity insert failed/);
  assert.equal(assignments.length, 0, 'الإسناد تراجع مع حدثه');
  assert.equal(events().length, 0);

  delete scripted['customerActivity.createMany'];
  failCommits = 1;
  await assert.rejects(ensureAssignment(T, 'c-1', 'rep-1', RMETA, { createdNow: true }), /COMMIT/);
  assert.equal(assignments.length, 0);
  assert.equal(events().length, 0);

  // إعادة الرفع (لعميلٍ قائم): الإدراج الذرّي يُنشئ الإسناد الآن ⇒ حدثٌ واحد
  await ensureAssignment(T, 'c-1', 'rep-1', RMETA);
  assert.equal(assignments.length, 1);
  assert.equal(events().length, 1);
});

test('الإسناد التلقائي: الإعادة والإسناد قائم ⇒ ما زال حدثاً واحداً', async () => {
  reset(); scriptAssign();
  await ensureAssignment(T, 'c-1', 'rep-1', RMETA, { createdNow: true });
  await ensureAssignment(T, 'c-1', 'rep-1', RMETA);
  await ensureAssignment(T, 'c-1', 'rep-1', RMETA);
  assert.equal(assignments.length, 1);
  assert.equal(events().filter((e) => e.action === 'CUSTOMER_ASSIGNED').length, 1);
});

// ═══════════════════ طلب المنيو العام ═══════════════════

const CT = '11111111-1111-4111-8111-111111111111';
const CR = '22222222-2222-4222-8222-222222222222';
const CP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ORDER_REF = '44444444-4444-4444-8444-444444444444';
let orders: Row[] = [];
let orderSeq = 0;
function scriptCatalog(): void {
  orders = [];
  scripted = {
    'tenant.findUnique': () => ({ isActive: true, catalogEnabled: true }),
    'companySettings.findUnique': () => ({ taxDisabled: false }),
    'salesRep.findFirst': () => ({ id: CR, name: 'خالد', defaultPriceListId: null }),
    'product.findMany': () => [{ id: CP, name: 'ماء', basePrice: 10, taxPct: 15, categoryId: null, primaryUnitId: null, units: [] }],
    'catalogOrder.findUnique': (a: Row) => orders.find((o) => o.clientRef === a.where?.tenantId_clientRef?.clientRef) ?? null,
    'catalogOrder.count': () => 0,
    'catalogOrder.create': (a: Row, ctx: Ctx) => {
      if (orders.some((o) => o.clientRef === a.data.clientRef)) throw P2002();
      const o = { id: `O-${++orderSeq}`, salesRepId: a.data.salesRepId, clientRef: a.data.clientRef };
      ctx.onCommit(() => orders.push(o));
      return { id: o.id };
    },
  };
  raw = (sql) => (/FROM customers/.test(sql) ? [{ id: 'c-1', name: 'بقالة', phone: '0551234567', createdAt: new Date('2026-06-01') }] : undefined);
}
const orderBody = { clientRef: ORDER_REF, name: 'أبو محمد', phone: '0551234567', items: [{ productId: CP, unitId: null, qty: 2 }] };
const placeOrder = () => call(publicCatalogRouter, 'post', '/catalog/:tenantId/:repId/orders', { params: { tenantId: CT, repId: CR }, body: orderBody }, { lastOnly: true });

test('طلب المنيو: الالتزام ⇒ طلبٌ واحد وحدث CATALOG_ORDER_PLACED واحد بمقبض معاملة الطلب نفسها — والردّ كما كان', async () => {
  reset(); scriptCatalog();
  const r = await placeOrder();
  assert.equal(r.status, 201, why(r));
  assert.deepEqual(r.body, { success: true, data: { id: orders[0]?.id, repName: 'خالد' } });
  assert.equal(orders.length, 1);
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.refId, e.actorKind, e.source]), [['CATALOG_ORDER_PLACED', 'c-1', orders[0].id, 'CUSTOMER', 'public']]);
  const create = callOf('catalogOrder.create')!;
  assert.notEqual(create.tx, null);
  assert.equal(committed[0].tx, create.tx);
});

test('طلب المنيو: تعذّر الحدث أو فشل الالتزام ⇒ لا طلب ولا حدث — والإعادة بالمرجع نفسه تحفظه بحدثٍ واحد', async () => {
  reset(); scriptCatalog();
  scripted['customerActivity.createMany'] = ACTIVITY_DOWN;
  const f = await quiet(placeOrder);
  assert.equal(f.status, 500);
  assert.equal(orders.length, 0, 'الطلب تراجع مع حدثه');
  assert.equal(events().length, 0);

  delete scripted['customerActivity.createMany'];
  failCommits = 1;
  const c = await quiet(placeOrder);
  assert.equal(c.status, 500);
  assert.equal(orders.length, 0);
  assert.equal(events().length, 0);

  const r = await placeOrder();
  assert.equal(r.status, 201, why(r));
  assert.equal(orders.length, 1);
  assert.equal(events().length, 1);
});

test('طلب المنيو: الإعادة بالمرجع نفسه ⇒ الطلب نفسه وما زال حدثاً واحداً — والإعادة المتزامنة (P2002) تُجاب بالأوّل بلا حدثٍ ثانٍ', async () => {
  reset(); scriptCatalog();
  const first = await placeOrder();
  assert.equal(first.status, 201, why(first));
  const again = await placeOrder();
  assert.equal(again.status, 200, why(again));
  assert.equal(again.body.data.id, first.body.data.id);
  assert.equal(orders.length, 1);
  assert.equal(events().length, 1);

  // سباق: الفحص الأوّل لم يرَ الطلب ⇒ الإنشاء يصطدم بالفريد فتتراجع معاملته بحدثها، ويُجاب بالطلب الأوّل
  const realFind = scripted['catalogOrder.findUnique'];
  let misses = 1;
  scripted['catalogOrder.findUnique'] = (a: Row, ctx: Ctx) => (misses-- > 0 ? null : realFind(a, ctx));
  const raced = await placeOrder();
  assert.equal(raced.status, 200, why(raced));
  assert.equal(raced.body.data.id, first.body.data.id);
  assert.equal(orders.length, 1);
  assert.equal(events().length, 1);
});

// ═══════════════════ إغلاق طلب المنيو ═══════════════════

const ORDER = '33333333-3333-4333-8333-333333333333';
let orderStatus = 'SEEN';
function scriptClose(): void {
  orderStatus = 'SEEN';
  scripted = {
    'tenant.findUnique': () => ({ catalogEnabled: true, isActive: true }),
    'catalogOrder.findFirst': () => ({ status: orderStatus, phoneKey: '966551234567', createdAt: new Date('2026-11-20T10:00:00Z') }),
    // الشرط في التحديث نفسه (NEW|SEEN)، والحالة الجديدة تُلتزم مع المعاملة وحدها
    'catalogOrder.updateMany': (a: Row, ctx: Ctx) => {
      if (!(a.where?.status?.in ?? []).includes(orderStatus)) return { count: 0 };
      ctx.onCommit(() => { orderStatus = a.data.status; });
      return { count: 1 };
    },
    'customerActivity.findMany': () => [],
  };
  raw = (sql) => (/FROM customers/.test(sql) ? [{ id: 'c-1', name: 'بقالة', phone: '0551234567', createdAt: new Date('2026-06-01') }] : undefined);
}
const closeOrder = () => call(catalogOrdersRouter, 'post', '/:id/status', { user: REP, params: { id: ORDER }, body: { status: 'DONE' } });

test('إغلاق طلب المنيو: الالتزام ⇒ الحالة تتغيّر وحدث CATALOG_ORDER_UPDATED واحد بمقبض معاملة التحديث نفسها', async () => {
  reset(); scriptClose();
  const r = await closeOrder();
  assert.equal(r.status, 200, why(r));
  assert.deepEqual([r.body.data.id, r.body.data.status], [ORDER, 'DONE']);
  assert.equal(orderStatus, 'DONE');
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.refId, e.actorKind, e.data.oldStatus, e.data.newStatus]), [['CATALOG_ORDER_UPDATED', 'c-1', ORDER, 'REP', 'SEEN', 'DONE']]);
  const upd = callOf('catalogOrder.updateMany')!;
  assert.notEqual(upd.tx, null);
  assert.equal(committed[0].tx, upd.tx);
});

test('إغلاق طلب المنيو: تعذّر الحدث أو فشل الالتزام ⇒ لا إغلاق ولا حدث — والإعادة تُغلقه بحدثٍ واحد، ثم ٤٠٩ بلا حدثٍ ثانٍ', async () => {
  reset(); scriptClose();
  scripted['customerActivity.createMany'] = ACTIVITY_DOWN;
  const f = await quiet(closeOrder);
  assert.equal(f.status, 500);
  assert.equal(orderStatus, 'SEEN', 'الإغلاق تراجع مع حدثه');
  assert.equal(events().length, 0);

  delete scripted['customerActivity.createMany'];
  failCommits = 1;
  const c = await quiet(closeOrder);
  assert.equal(c.status, 500);
  assert.equal(orderStatus, 'SEEN');
  assert.equal(events().length, 0);

  const r = await closeOrder();
  assert.equal(r.status, 200, why(r));
  assert.equal(orderStatus, 'DONE');
  assert.equal(events().length, 1);

  const again = await closeOrder();
  assert.equal(again.status, 409, why(again));
  assert.equal(again.body.status, 'DONE');
  assert.equal(events().length, 1, 'إغلاقٌ لم يقع لا حدث له');
});
