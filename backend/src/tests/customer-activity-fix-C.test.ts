// «سجلّ العميل» — جولة الإصلاح (المُصلِح C: كتّاب جهة العميل، ٢٧ نوفمبر ٢٠٢٦). اختبارات انحدارٍ فوق Prisma مزيّف **بمعاملاتٍ تُلتزم
// أو تُتراجع** (نمط customer-activity-behavior.test.ts)، بلا قاعدة ولا شبكة ولا خادم — لكل عنقودٍ أُصلح:
//   C2  تعديل العميل (PUT /:id، فرع الرقم المرجعي، PATCH /:id/buyer-data): قفل الصفّ وصورته «قبل» تحت القفل والكتابة وحدثها في
//       معاملةٍ واحدة، والفرق بالحقول المكتوبة وحدها، وإحياء المؤرشف حدث حالة، وتعذّر الحدث يُلغي التعديل.
//   C14 اعتماد التصنيف المقترح: الحدث لمن قُفل وكُتب فعلاً وحده، في معاملة الكتابة.
//   C13 الإسناد التلقائي «جديد» من الكتابة نفسها (لا نافذة زمنية)، وإسناد الإدارة يقفل صفّ المندوب قبل قراءة «ما كان».
//   C12 حذف المندوب: محطّات خطوطه وطلبات منيوه و«المندوب الذي أضاف العميل» أحداثٌ في معاملة الحذف.
//   C16 لحظة الزيارة: مستقبل الإدارة ومفتاح API يُصحَّح، والسطر لا يأخذ لحظةً خارج نافذة العمل دون اتصال.
//   C17 نتيجة المندوب الذكي عند عميلٍ قائم حدث SMART_REP_OUTCOME في معاملتها.
//   C4  قاعدة نسبة طلب المنيو: العميل الوحيد المطابق لحظة الطلب، والعلنيّ «غير موثَّق» بعد الردّ، والإغلاق يتبع السطر الأوّل.
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

type Call = { op: string; args: any; tx: number | null };
let calls: Call[] = [];
let scripted: Record<string, (args: any, tx: number | null) => unknown> = {};
let raw: (sql: string, values: unknown[], tx: number | null) => unknown = () => undefined;
let committed: { row: Row; tx: number | null }[] = [];
let txSeq = 0;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}

function delegate(model: string, tx: number | null, sink: { row: Row; tx: number | null }[] | null): unknown {
  return new Proxy({}, {
    get: (_t, method: string) => {
      if (method === 'then') return undefined;
      return async (args: any) => {
        calls.push({ op: `${model}.${method}`, args, tx });
        const fn = scripted[`${model}.${method}`];
        if (model === 'customerActivity' && method === 'createMany') {
          if (fn) await fn(args, tx);
          const rows = (args?.data ?? []).map((d: Row) => ({ row: { ...d }, tx }));
          (sink ?? committed).push(...rows);
          return { count: rows.length };
        }
        return fn ? fn(args, tx) : defaultFor(method);
      };
    },
  });
}

function client(tx: number | null, sink: { row: Row; tx: number | null }[] | null): Row {
  return new Proxy({}, {
    get: (_t, key: string) => {
      if (key === 'then') return undefined;
      if (key === '$transaction') {
        return async (arg: unknown, opts?: unknown) => {
          if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
          if (tx !== null) return (arg as (t: unknown) => Promise<unknown>)(client(tx, sink));
          const id = ++txSeq;
          const buf: { row: Row; tx: number | null }[] = [];
          calls.push({ op: '$transaction', args: opts ?? null, tx: id });
          try {
            const out = await (arg as (t: unknown) => Promise<unknown>)(client(id, buf));
            committed.push(...buf);
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
          const out = raw(sql, values, tx);
          if (out !== undefined) return out;
          return key === '$queryRaw' ? [] : 0;
        };
      }
      return delegate(key, tx, sink);
    },
  });
}
const prismaFake = client(null, null);

function reset(): void { calls = []; scripted = {}; committed = []; raw = () => undefined; }
const events = (): Row[] => committed.map((c) => c.row);
const opIndex = (pred: (c: Call) => boolean): number => calls.findIndex(pred);
const LOCK_CUSTOMER = /FROM "customers" WHERE "id" = \? AND "tenantId" = \? FOR UPDATE/;

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
const realUsage = require('../ai-rep/usage') as Row;
stub('ai-rep/usage', { ...realUsage, reserveUsage: async () => true, refundUsage: async () => undefined });

const customersRouter = require('../routes/customers').default;
const salesRepsRouter = require('../routes/salesReps').default;
const visitsRouter = require('../routes/visits').default;
const visitsModule = require('../routes/visits') as typeof import('../routes/visits');
const aiRepRouter = require('../routes/aiRep').default;
const publicCatalogRouter = require('../routes/publicCatalog').default;
const catalogOrdersRouter = require('../routes/catalogOrders').default;
const { createCustomerBuyerDataRouter } = require('../routes/customersZatca') as typeof import('../routes/customersZatca');
const { ensureAssignment } = require('../services/customerScope') as typeof import('../services/customerScope');
const ev = require('../services/customerActivityEvents') as typeof import('../services/customerActivityEvents');

// ═══════════════════ تشغيل مكدّس المسار ═══════════════════

type Reply = { status: number; body: any; error: unknown };
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Row[] }; handle?: { stack?: Layer[] } };
function findRoute(router: unknown, method: string, p: string): Layer['route'] {
  const walk = (stack: Layer[]): Layer['route'] | null => {
    for (const l of stack) {
      if (l.route && l.route.path === p && l.route.methods?.[method]) return l.route;
      if (l.handle?.stack) { const r = walk(l.handle.stack); if (r) return r; }
    }
    return null;
  };
  const r = walk((router as { stack: Layer[] }).stack);
  assert.ok(r, `${method.toUpperCase()} ${p} missing`);
  return r!;
}
async function call(router: unknown, method: string, p: string, req: Row, opts: { lastOnly?: boolean } = {}): Promise<Reply> {
  const route = findRoute(router, method, p)!;
  const res: Row = { statusCode: 200, body: undefined, headersSent: false };
  // معالجٌ ملفوف لا يعيد وعده (customersZatca: fn(req, res).catch(next)) — يُنتظر ردّه أو next
  let settle: () => void = () => {};
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; res.headersSent = true; settle(); return res; };
  const full = { method: method.toUpperCase(), url: p, query: {}, params: {}, body: {}, headers: {}, ip: '127.0.0.1', ...req };
  const stack = opts.lastOnly ? [route.stack.at(-1)!] : route.stack;
  for (const h of stack) {
    let passed = false;
    let err: unknown = null;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const ret = h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; settle(); });
    await ret;
    if (!passed && !err && !res.headersSent) await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
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
const ADMIN = { id: 'admin-1', role: 'ADMIN', tenantId: T, name: 'سارة' };
const REP = { id: 'rep-1', role: 'SALES_REP', tenantId: T, name: 'خالد' };
const changesOf = (e: Row | undefined) => (e?.data?.changes ?? []).map((c: Row) => [c.field, c.from, c.to]);

// ═══════════════════ C2 — تعديل العميل ═══════════════════

const STALE = { id: 'c-1', name: 'بقالة الأمل', phone: '0500000001', status: 'ACTIVE', city: 'جدة', lat: null, lng: null, priceListId: null };

function scriptPut(locked: Row, update?: (data: Row, n: number) => Row): void {
  let n = 0;
  scripted = {
    'customer.findFirst': (a: Row) => (a?.where?.id === 'c-1' ? { ...STALE } : null),
    'customer.update': (a: Row) => (update ? update(a.data, ++n) : { ...locked, ...a.data }),
    'priceList.findMany': () => [],
  };
  raw = (sql) => (LOCK_CUSTOMER.test(sql) ? [{ ...locked }] : undefined);
}

test('C2 PUT /customers/:id: صورة «قبل» تحت قفل الصفّ لا السؤال الأوّل — إعادة نموذجٍ قديمٍ لحالةٍ حظرها غيره تُسجَّل، وجوالٌ غيّره غيره لا يُنسب لهذا الفاعل', async () => {
  reset();
  // بين سؤال الوجود والكتابة: مديرٌ آخر حظر العميل، ومزامنةٌ غيّرت جواله
  const locked = { ...STALE, status: 'BLOCKED', phone: '0500000002' };
  scriptPut(locked);
  const r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { name: 'بقالة الخير', status: 'ACTIVE' } });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => e.action), ['CUSTOMER_STATUS_CHANGED', 'CUSTOMER_UPDATED']);
  assert.deepEqual([events()[0].data.oldStatus, events()[0].data.newStatus], ['BLOCKED', 'ACTIVE'], 'الإعادة إلى «نشط» ظاهرةٌ بفاعلها');
  assert.deepEqual(changesOf(events()[1]), [['name', 'بقالة الأمل', 'بقالة الخير']], 'الجوال لم يكتبه هذا الطلب');
  // القفل ثم الكتابة ثم الحدث — كلها في معاملةٍ واحدة التزمت
  const lockAt = opIndex((c) => c.op === '$queryRaw' && LOCK_CUSTOMER.test(c.args.sql));
  const upd = calls.find((c) => c.op === 'customer.update')!;
  assert.ok(lockAt >= 0 && lockAt < calls.indexOf(upd), 'القفل قبل الكتابة');
  assert.notEqual(upd.tx, null);
  assert.equal(calls[lockAt].tx, upd.tx);
  assert.ok(committed.every((c) => c.tx === upd.tx), 'الأحداث في معاملة الكتابة نفسها');
  assert.deepEqual(calls[lockAt].args.values.slice(-2), ['c-1', T], 'القفل بالعميل وشركته');
});

test('C2 PUT /customers/:id: الصفّ الكامل الذي تعيده الكتابة لا يُدخل في الفرق إلا ما كُتب — وكتابةٌ بلا تغيير لا حدث لها', async () => {
  reset();
  scriptPut(STALE, (data) => ({ ...STALE, ...data, phone: '0599999999', outletType: 'GROCERY', updatedAt: new Date() }));
  let r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { city: 'الرياض' } });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, changesOf(e)]), [['CUSTOMER_UPDATED', [['city', 'جدة', 'الرياض']]]]);

  reset();
  scriptPut(STALE, (data) => ({ ...STALE, ...data, phone: '0599999999' }));
  r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { name: 'بقالة الأمل', city: 'جدة' } });
  assert.equal(r.status, 200, why(r));
  assert.equal(events().length, 0, JSON.stringify(events()));
});

test('C2 PUT /customers/:id: إحياء المؤرشف (DELETED ⇒ ACTIVE) حدث حالةٍ بفاعل الطلب في المعاملة نفسها', async () => {
  reset();
  const locked = { ...STALE, status: 'DELETED' };
  let state: Row = { ...locked };
  scriptPut(locked, (data) => { state = { ...state, ...data }; return { ...state }; });
  const r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { city: 'الدمام' } });
  assert.equal(r.status, 200, why(r));
  assert.equal(r.body.data.status, 'ACTIVE');
  assert.deepEqual(events().map((e) => e.action), ['CUSTOMER_STATUS_CHANGED', 'CUSTOMER_UPDATED']);
  assert.deepEqual([events()[0].data.oldStatus, events()[0].data.newStatus, events()[0].actorKind], ['DELETED', 'ACTIVE', 'ADMIN']);
  const updates = calls.filter((c) => c.op === 'customer.update');
  assert.equal(updates.length, 2);
  assert.ok(updates.every((u) => u.tx !== null && u.tx === updates[0].tx));
});

test('C2 PUT /customers/:id: تعذّر كتابة الحدث يُلغي التعديل كلّه — لا تعديل بلا أثره (كان يُبتلع بعد الالتزام)', async () => {
  reset();
  scriptPut(STALE);
  scripted['customerActivity.createMany'] = () => { throw Object.assign(new Error('pool timeout'), { code: 'P2024' }); };
  const r = await quiet(() => call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { name: 'اسم جديد' } }));
  assert.equal(r.status, 500);
  assert.ok(calls.some((c) => c.op === '$rollback'), 'المعاملة تراجعت');
  assert.ok(calls.filter((c) => c.op === 'customer.update').every((c) => c.tx !== null), 'الكتابة داخل المعاملة المتراجعة');
  assert.equal(events().length, 0);
});

test('C2 POST /customers بالرقم المرجعي لعميلٍ قائم: القفل والصورة تحت القفل والحدث (via ref) في معاملة الكتابة — بالحقول المكتوبة وحدها', async () => {
  reset();
  const byRef = { id: 'c-7', code: 'ERP-7', name: 'قديم', phone: '0500000007', city: 'جدة', status: 'ACTIVE' };
  const locked = { ...byRef, phone: '0500000008' }; // غيّره غيره بعد سؤال الرقم المرجعي
  scripted = {
    'customer.findFirst': (a: Row) => (a?.where?.code ? { ...byRef } : null),
    'customer.update': (a: Row) => ({ ...locked, ...a.data, outletType: 'X' }),
  };
  raw = (sql) => (LOCK_CUSTOMER.test(sql) ? [{ ...locked }] : undefined);
  const r = await call(customersRouter, 'post', '/', { user: ADMIN, body: { code: 'ERP-7', name: 'جديد' } });
  assert.equal(r.status, 200, why(r));
  assert.equal(r.body.updated, true);
  assert.equal(events().length, 1, JSON.stringify(events()));
  assert.deepEqual([events()[0].action, events()[0].data.via, events()[0].customerId], ['CUSTOMER_UPDATED', 'ref', 'c-7']);
  assert.deepEqual(changesOf(events()[0]), [['name', 'قديم', 'جديد']]);
  const upd = calls.find((c) => c.op === 'customer.update')!;
  assert.notEqual(upd.tx, null);
  assert.ok(committed.every((c) => c.tx === upd.tx));
});

// ─── بيانات الفوترة (customersZatca.ts) ───

const buyerRouter = createCustomerBuyerDataRouter({
  db: prismaFake as never,
  customerScope: async () => ({}),
  canAccessCustomer: async () => true,
  tenantId: (req) => req.user?.tenantId ?? '',
  audit: () => {},
});
const COLLECT_ON = () => ({ zatcaPhase2Enabled: true, settings: { countryCode: 'SA', zatcaPhase2StartedAt: null, buyerVatAddressRelaxed: false } });

test('C2 PATCH /:id/buyer-data: الكتابة وحدثها في معاملةٍ واحدة، «قبل» تحت القفل — وحقلٌ غيّره غيره في الأثناء لا يُنسب لهذا الفاعل', async () => {
  reset();
  const stored = { id: 'c-1', name: 'بقالة', city: 'جدة', district: null, addrStreet: null, taxNumber: null, buyerType: null, status: 'ACTIVE' };
  const locked = { ...stored, addrStreet: 'شارع الملك فهد' };
  scripted = {
    'tenant.findUnique': COLLECT_ON,
    'customer.findFirst': () => ({ ...stored }),
    'customer.update': (a: Row) => ({ ...locked, ...a.data }),
  };
  raw = (sql) => (LOCK_CUSTOMER.test(sql) ? [{ ...locked }] : undefined);
  const r = await call(buyerRouter, 'patch', '/:id/buyer-data', { user: ADMIN, params: { id: 'c-1' }, body: { district: 'الملز' } });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(r.body.changed, ['district']);
  assert.equal(events().length, 1, JSON.stringify(events()));
  assert.equal(events()[0].action, 'CUSTOMER_TAX_DATA_UPDATED');
  assert.deepEqual(changesOf(events()[0]), [['district', null, 'الملز']]);
  const upd = calls.find((c) => c.op === 'customer.update')!;
  assert.notEqual(upd.tx, null);
  assert.ok(opIndex((c) => c.op === '$queryRaw' && LOCK_CUSTOMER.test(c.args.sql)) < calls.indexOf(upd));
  assert.ok(committed.every((c) => c.tx === upd.tx));
});

// ═══════════════════ C14 — اعتماد التصنيف المقترح ═══════════════════

test('C14 apply-suggested: الحدث لمن قُفل وكُتب فعلاً وحده — من صنّفه غيره بعد القراءة لا يُكتب ولا حدث له، والعدّ من الكتابة', async () => {
  reset();
  const row = (id: string) => ({ id, name: id, phone: '', status: 'ACTIVE', taxNumber: '300000000000003', buyerType: null });
  scripted = {
    'tenant.findUnique': COLLECT_ON,
    'customer.findMany': () => [row('c-a'), row('c-b')],
    'customer.updateMany': (a: Row) => ({ count: a.where.id.in.length }),
  };
  // c-b صنّفه تبويبٌ آخر (أو المندوب «فرداً») بين القراءة والكتابة: لا يُقفل
  raw = (sql) => (/FROM customers WHERE "tenantId" = \? AND id = ANY\(\?::text\[\]\) AND "buyerType" IS NULL ORDER BY id FOR UPDATE/.test(sql) ? [{ id: 'c-a' }] : undefined);
  const r = await call(buyerRouter, 'post', '/zatca-buyer-data/apply-suggested', { user: ADMIN, body: { ids: ['c-a', 'c-b'] } });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(r.body.data, { updated: 1, skipped: 1 });
  assert.deepEqual(events().map((e) => [e.action, e.customerId]), [['CUSTOMER_TAX_DATA_UPDATED', 'c-a']]);
  const um = calls.find((c) => c.op === 'customer.updateMany')!;
  assert.deepEqual(um.args.where.id.in, ['c-a'], 'الكتابة للمقفولين وحدهم');
  assert.notEqual(um.tx, null);
  assert.ok(committed.every((c) => c.tx === um.tx), 'الحدث في معاملة الكتابة');
  const lock = calls.find((c) => c.op === '$queryRaw')!;
  assert.equal(lock.tx, um.tx);
  assert.deepEqual(lock.args.values, [T, ['c-a', 'c-b']]);
});

// ═══════════════════ C13 — الإسناد ═══════════════════

const RMETA = { actor: { kind: 'REP' as const, id: 'rep-1', name: 'خالد' }, source: 'rep' };

test('C13 ensureAssignment: «جديد» من الإدراج الذرّي نفسه — count 1 حدثٌ واحد، و0 لا حدث مهما كانت لحظة الصفّ؛ وإنشاء الطلب نفسه حدثٌ مرّةً واحدة', async () => {
  reset();
  scripted['customerAssignment.createMany'] = () => ({ count: 1 });
  scripted['salesRep.findFirst'] = () => ({ name: 'خالد' });
  await ensureAssignment(T, 'c1', 'rep-1', RMETA);
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.refId, e.actorKind, e.data.mode]), [['CUSTOMER_ASSIGNED', 'c1', 'rep-1', 'REP', 'AUTO']]);
  const cm = calls.find((c) => c.op === 'customerAssignment.createMany')!;
  assert.equal(cm.args.skipDuplicates, true);
  assert.deepEqual(cm.args.data, [{ tenantId: T, customerId: 'c1', salesRepId: 'rep-1', source: 'AUTO' }]);
  assert.equal(calls.some((c) => c.op === 'customerAssignment.upsert'), false);

  // إعادة رفعٍ لإسنادٍ قائم أُنشئ قبل ثانيتين: الإدراج لم يُدرج شيئاً ⇒ لا حدث (كانت نافذة الخمس ثوانٍ تعدّه جديداً)
  reset();
  scripted['customerAssignment.createMany'] = () => ({ count: 0 });
  scripted['customerAssignment.upsert'] = () => ({ id: 'as-1', createdAt: new Date(Date.now() - 2000) });
  await ensureAssignment(T, 'c1', 'rep-1', RMETA);
  assert.equal(events().length, 0);

  // العميل أنشأه هذا الطلب: upsert آمنٌ للتكرار وحدثه مرّةً واحدة — ولو كانت لحظة الصفّ قديمة (لا نافذة زمنية)
  reset();
  scripted['customerAssignment.upsert'] = () => ({ id: 'as-1', createdAt: new Date('2020-01-01') });
  await ensureAssignment(T, 'c2', 'rep-1', RMETA, { createdNow: true });
  assert.deepEqual(events().map((e) => [e.action, e.customerId]), [['CUSTOMER_ASSIGNED', 'c2']]);
});

test('C13 POST /customers (مندوب): الإنشاء ثم إعادة رفعه مرّتين بـclientRef نفسه (والإسناد قائم) — حدث إسنادٍ واحد فقط', async () => {
  reset();
  let created: Row | null = null;
  const ref = '0b6d7a1e-6a1c-4f7e-9d2b-3c1a2b3c4d5e';
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true }),
    'salesRep.findFirst': () => ({ name: 'خالد' }),
    'customer.findFirst': (a: Row) => (created && a.where?.clientRef === ref ? { ...created, createdBySalesRepId: 'rep-1' } : null),
    'customer.create': (a: Row) => { created = { id: 'c-new', createdAt: new Date(), ...a.data }; return created; },
    'customerAssignment.upsert': () => ({ id: 'as-1', createdAt: new Date() }),
    // الإسناد قائمٌ منذ الإنشاء: الإدراج الذرّي في إعادة الرفع لا يُدرج شيئاً
    'customerAssignment.createMany': () => ({ count: 0 }),
  };
  const first = await call(customersRouter, 'post', '/', { user: REP, body: { name: 'كشك السلام', clientRef: ref } });
  assert.equal(first.status, 201, why(first));
  for (let i = 0; i < 2; i++) {
    const again = await call(customersRouter, 'post', '/', { user: REP, body: { name: 'كشك السلام', clientRef: ref } });
    assert.equal(again.status, 200, why(again));
    assert.equal(again.body.idempotent, true);
  }
  assert.equal(events().filter((e) => e.action === 'CUSTOMER_ASSIGNED').length, 1);
});

test('C13 PUT /sales-reps/:id/customers: قفل صفّ المندوب (FOR UPDATE) أوّل المعاملة قبل قراءة «ما كان مسنَداً» — والأحداث لما تغيّر وحده', async () => {
  reset();
  scripted = {
    'salesRep.findFirst': () => ({ id: 'R1', name: 'خالد' }),
    'customer.findMany': () => [{ id: 'c2' }, { id: 'c3' }],
    'customerAssignment.findMany': () => [{ customerId: 'c1' }, { customerId: 'c3' }],
  };
  const r = await call(salesRepsRouter, 'put', '/:id/customers', { user: ADMIN, params: { id: 'R1' }, body: { add: ['c2', 'c3'], remove: ['c1', 'c9'] } });
  assert.equal(r.status, 200, why(r));
  const lockAt = opIndex((c) => c.op === '$queryRaw' && /FROM sales_reps WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(c.args.sql));
  const readAt = opIndex((c) => c.op === 'customerAssignment.findMany');
  assert.ok(lockAt >= 0 && lockAt < readAt, 'القفل قبل القراءة');
  assert.equal(calls[lockAt].tx, calls[readAt].tx);
  assert.notEqual(calls[lockAt].tx, null);
  assert.deepEqual(calls[lockAt].args.values, ['R1', T]);
  assert.deepEqual(events().map((e) => [e.action, e.customerId]), [['CUSTOMER_UNASSIGNED', 'c1'], ['CUSTOMER_ASSIGNED', 'c2']]);
});

// ═══════════════════ C4 — قاعدة نسبة طلب المنيو ═══════════════════

const cand = (id: string, phone: string, createdAt: string) => ({ id, name: id, phone, createdAt: new Date(createdAt) });

test('C4 uniqueCatalogMatch: العميل الوحيد المطابق وحده — عميلان بالجوال نفسه لا نسبة، ومن أُنشئ بعد الطلب لا يُحسب، والمفتاح العابث لا يطابق', () => {
  const key = '966551234567';
  const a = cand('A', '0551234567', '2026-06-01'); const b = cand('B', '+966 55 123 4567', '2026-09-01'); const other = cand('O', '0559999999', '2026-01-01');
  assert.equal(ev.uniqueCatalogMatch(key, [a, other]), 'A');
  assert.equal(ev.uniqueCatalogMatch(key, [a, b, other]), null, 'عميلان بالجوال نفسه');
  assert.equal(ev.uniqueCatalogMatch(key, [a, b], new Date('2026-07-01')), 'A', 'B أُنشئ بعد الطلب');
  assert.equal(ev.uniqueCatalogMatch(key, [b], '2026-07-01'), null);
  assert.equal(ev.uniqueCatalogMatch(key, [a, { ...a }]), 'A', 'الصفّ نفسه مكرّراً عميلٌ واحد');
  assert.equal(ev.uniqueCatalogMatch('00000000000', [cand('Z', '00000000000', '2026-01-01')]), null);
  assert.equal(ev.uniqueCatalogMatch(null, [a]), null);
});

const CT = '11111111-1111-4111-8111-111111111111';
const CR = '22222222-2222-4222-8222-222222222222';
const CP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ORDER_BODY = { clientRef: '44444444-4444-4444-8444-444444444444', name: 'أبو محمد', phone: '0551234567', note: 'بعد العصر', items: [{ productId: CP, unitId: null, qty: 2 }] };
function scriptCatalog(candidates: Row[]): void {
  scripted = {
    'tenant.findUnique': () => ({ isActive: true, catalogEnabled: true }),
    'companySettings.findUnique': () => ({ taxDisabled: false }),
    'salesRep.findFirst': () => ({ id: CR, name: 'خالد', defaultPriceListId: null }),
    'product.findMany': () => [{ id: CP, name: 'ماء', basePrice: 10, taxPct: 15, categoryId: null, primaryUnitId: null, units: [] }],
    'catalogOrder.findUnique': () => null,
    'catalogOrder.count': () => 0,
    'catalogOrder.create': () => ({ id: 'O-NEW' }),
  };
  raw = (sql) => (/FROM customers/.test(sql) ? candidates : undefined);
}

test('C4 طلب المنيو العام: على العميل الوحيد المطابق بفاعلٍ «العميل» غير موثَّق (unverified) في معاملة الطلب — وعميلان بالجوال نفسه بلا سطر', async () => {
  reset();
  scriptCatalog([cand('c-1', '0551234567', '2026-06-01'), cand('c-x', '0559999999', '2026-06-01')]);
  const r = await call(publicCatalogRouter, 'post', '/catalog/:tenantId/:repId/orders', { params: { tenantId: CT, repId: CR }, body: ORDER_BODY }, { lastOnly: true });
  assert.equal(r.status, 201, why(r));
  assert.deepEqual(r.body, { success: true, data: { id: 'O-NEW', repName: 'خالد' } });
  assert.equal(events().length, 1);
  const e = events()[0];
  assert.deepEqual([e.action, e.customerId, e.actorKind, e.actorName, e.source, e.refType, e.refId], ['CATALOG_ORDER_PLACED', 'c-1', 'CUSTOMER', 'أبو محمد', 'public', 'CATALOG_ORDER', 'O-NEW']);
  assert.equal(e.data.unverified, true);
  assert.equal('customerName' in e.data, false, 'الاسم المدّعى في الفاعل وحده');
  // الطلب وسطره معاملةٌ واحدة (QA ٢٧ نوفمبر): المطابقة قبلها خارجها (الاستعلام نفسه لكل طلب: لا يفرق الزمن إلا بإدراج السطر)،
  // والإنشاء والسطر بمقبض المعاملة نفسها
  const createCall = calls.find((c) => c.op === 'catalogOrder.create')!;
  const matchAt = opIndex((c) => c.op === '$queryRaw' && /FROM customers/.test(c.args.sql));
  assert.ok(matchAt >= 0 && matchAt < calls.indexOf(createCall) && calls[matchAt].tx === null, 'المطابقة قبل المعاملة وخارجها');
  assert.notEqual(createCall.tx, null);
  assert.ok(committed.every((c) => c.tx === createCall.tx), 'السطر في معاملة الطلب نفسها');

  reset();
  scriptCatalog([cand('c-1', '0551234567', '2026-06-01'), cand('c-2', '+966551234567', '2026-08-01')]);
  const amb = await call(publicCatalogRouter, 'post', '/catalog/:tenantId/:repId/orders', { params: { tenantId: CT, repId: CR }, body: ORDER_BODY }, { lastOnly: true });
  assert.equal(amb.status, 201, why(amb));
  assert.equal(events().length, 0, 'لا يُلصق الطلب بأحد العميلين');

  // تعذّر المطابقة لا يرمي ولا يُفشل الطلب (يُحفظ بلا سطر)
  reset();
  scriptCatalog([]);
  raw = (sql) => { if (/FROM customers/.test(sql)) throw new Error('db down'); return undefined; };
  const down = await quiet(() => call(publicCatalogRouter, 'post', '/catalog/:tenantId/:repId/orders', { params: { tenantId: CT, repId: CR }, body: ORDER_BODY }, { lastOnly: true }));
  assert.equal(down.status, 201, why(down));
  assert.equal(events().length, 0);
});

const ORDER = '33333333-3333-4333-8333-333333333333';
function scriptClose(o: { logged?: string | null; candidates?: Row[]; invoiceCustomer?: string | null }): void {
  scripted = {
    'tenant.findUnique': () => ({ catalogEnabled: true, isActive: true }),
    'invoice.findFirst': () => (o.invoiceCustomer !== undefined ? { id: 'INV-1', customerId: o.invoiceCustomer, number: 'INV-0001' } : null),
    'catalogOrder.findFirst': () => ({ status: 'SEEN', phoneKey: '966551234567', createdAt: new Date('2026-11-20T10:00:00Z') }),
    'catalogOrder.updateMany': () => ({ count: 1 }),
    'customerActivity.findMany': () => (o.logged ? [{ refId: ORDER, customerId: o.logged }] : []),
  };
  raw = (sql) => (/FROM customers/.test(sql) ? (o.candidates ?? []) : undefined);
}
const closeReq = (body: Row) => ({ user: REP, params: { id: ORDER }, body });

test('C4 إغلاق طلب المنيو: عميل السطر الأوّل للطلب نهائيّ (لا عميل الفاتورة ولا مطابقةٌ جديدة)، وإلا الوحيد المطابق لحظة الطلب، وإلا عميل الفاتورة', async () => {
  // سُجّل الطلب على c-1؛ ثم أُضيف عميلٌ ثانٍ بالجوال نفسه وأُغلق الطلب بفاتورة عميلٍ ثالث ⇒ الإغلاق على c-1
  reset();
  scriptClose({ logged: 'c-1', candidates: [cand('c-2', '0551234567', '2026-06-01')], invoiceCustomer: 'c-inv' });
  let r = await call(catalogOrdersRouter, 'post', '/:id/status', closeReq({ status: 'DONE', invoiceId: 'INV-1' }), { lastOnly: true });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.data.newStatus, e.data.invoiceNo, e.actorKind]), [['CATALOG_ORDER_UPDATED', 'c-1', 'DONE', 'INV-0001', 'REP']]);
  assert.equal(calls.some((c) => c.op === '$queryRaw' && /FROM customers/.test(c.args.sql)), false, 'السطر الأوّل يكفي بلا مطابقة');

  // بلا سطر: الوحيد المطابق **لحظة الطلب** — عميلٌ أُنشئ بعده لا يُحسب فلا يصير الطلب ملتبساً
  reset();
  scriptClose({ candidates: [cand('c-old', '0551234567', '2026-06-01'), cand('c-late', '0551234567', '2026-11-25')], invoiceCustomer: 'c-inv' });
  r = await call(catalogOrdersRouter, 'post', '/:id/status', closeReq({ status: 'DONE', invoiceId: 'INV-1' }), { lastOnly: true });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => e.customerId), ['c-old']);

  // عميلان لحظة الطلب ⇒ لا نسبة بالجوال، والفاتورة تحدّد عميله
  reset();
  scriptClose({ candidates: [cand('c-a', '0551234567', '2026-06-01'), cand('c-b', '0551234567', '2026-07-01')], invoiceCustomer: 'c-inv' });
  r = await call(catalogOrdersRouter, 'post', '/:id/status', closeReq({ status: 'DONE', invoiceId: 'INV-1' }), { lastOnly: true });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => e.customerId), ['c-inv']);

  // ملتبسٌ بلا فاتورة ⇒ لا حدث
  reset();
  scriptClose({ candidates: [cand('c-a', '0551234567', '2026-06-01'), cand('c-b', '0551234567', '2026-07-01')] });
  r = await call(catalogOrdersRouter, 'post', '/:id/status', closeReq({ status: 'CANCELLED' }), { lastOnly: true });
  assert.equal(r.status, 200, why(r));
  assert.equal(events().length, 0);
});

// ═══════════════════ C12 — حذف المندوب ═══════════════════

function scriptRepDelete(): void {
  scripted = {
    'salesRep.findFirst': () => ({ id: 'R1', name: 'خالد' }),
    'repRouteStop.findMany': (a: Row) => {
      assert.deepEqual(a.where, { tenantId: T, route: { salesRepId: 'R1', isActive: true } });
      return [
        { customerId: 'c1', routeId: 'rt-1', route: { name: 'خط الأحد' } },
        { customerId: 'c1', routeId: 'rt-2', route: { name: 'خط الخميس' } },
        { customerId: 'c1', routeId: 'rt-1', route: { name: 'خط الأحد' } },
        { customerId: 'c2', routeId: 'rt-1', route: { name: 'خط الأحد' } },
      ];
    },
    'catalogOrder.findMany': () => [
      { id: 'o-logged', phoneKey: '966551111111', status: 'DONE', createdAt: new Date('2026-11-10') },
      { id: 'o-match', phoneKey: '966552222222', status: 'NEW', createdAt: new Date('2026-11-10') },
      { id: 'o-amb', phoneKey: '966553333333', status: 'SEEN', createdAt: new Date('2026-11-10') },
      { id: 'o-late', phoneKey: '966554444444', status: 'NEW', createdAt: new Date('2026-11-10') },
      { id: 'o-none', phoneKey: null, status: 'NEW', createdAt: new Date('2026-11-10') },
    ],
    'customerActivity.findMany': () => [{ refId: 'o-logged', customerId: 'c-log' }],
    'customer.findMany': (a: Row) => (a.where?.createdBySalesRepId === 'R1' ? [{ id: 'c-made' }] : []),
  };
  raw = (sql) => (/FROM customers/.test(sql) ? [
    cand('c-m', '0552222222', '2026-01-01'),
    cand('c-a1', '0553333333', '2026-01-01'), cand('c-a2', '0553333333', '2026-02-01'),
    cand('c-new', '0554444444', '2026-11-20'), // أُنشئ بعد الطلب
  ] : undefined);
}

test('C12 حذف المندوب: محطّات خطوطه النشطة وطلبات منيوه و«المندوب الذي أضاف العميل» أحداثٌ في معاملة الحذف قبل الحذف', async () => {
  reset();
  scriptRepDelete();
  const r = await call(salesRepsRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'R1' } });
  assert.equal(r.status, 200, why(r));
  const got = events().map((e) => [e.action, e.customerId, e.refType ?? null, e.refId ?? null]);
  assert.deepEqual(got, [
    ['ROUTE_STOP_REMOVED', 'c1', 'ROUTE', 'rt-1'], ['ROUTE_STOP_REMOVED', 'c1', 'ROUTE', 'rt-2'], ['ROUTE_STOP_REMOVED', 'c2', 'ROUTE', 'rt-1'],
    ['CATALOG_ORDER_UPDATED', 'c-log', 'CATALOG_ORDER', 'o-logged'], ['CATALOG_ORDER_UPDATED', 'c-m', 'CATALOG_ORDER', 'o-match'],
    ['CUSTOMER_UPDATED', 'c-made', 'CUSTOMER', 'c-made'],
  ]);
  const stop = events()[0];
  assert.deepEqual([stop.data.routeName, stop.data.repName, stop.data.reason], ['خط الأحد', 'خالد', 'REP_DELETED']);
  const order = events()[3];
  assert.deepEqual([order.data.oldStatus, order.data.newStatus, order.data.reason], ['DONE', 'DELETED', 'REP_DELETED']);
  assert.deepEqual(changesOf(events()[5]), [['createdBySalesRepId', 'R1', null]]);
  for (const e of events()) assert.deepEqual([e.actorKind, e.actorId], ['ADMIN', 'admin-1']);
  // في معاملة الحذف نفسها وقبل حذف المندوب (التعاقب)
  const del = calls.find((c) => c.op === 'salesRep.delete')!;
  assert.ok(opIndex((c) => c.op === 'customerActivity.createMany') < calls.indexOf(del));
  assert.ok(committed.every((c) => c.tx === del.tx));
});

test('C12 repDeleteEvents: مقبضٌ قديم بلا نماذج المحطّات والطلبات لا يرمي — والأحداث القديمة كما هي', async () => {
  const db = {
    customerActivity: { createMany: async () => ({ count: 0 }) },
    invoice: { groupBy: async () => [{ customerId: 'c1', _count: { _all: 2 } }] },
    receipt: { groupBy: async () => [] },
    repVisit: { groupBy: async () => [] },
    customerAssignment: { findMany: async () => [] },
  };
  const out = await ev.repDeleteEvents(db, T, { id: 'R1', name: 'خالد' }, { actor: { kind: 'ADMIN', id: 'a', name: null }, source: 'web' }, 'REP_DELETED');
  assert.deepEqual(out.map((e) => [e.action, e.customerId]), [['INVOICE_REASSIGNED', 'c1']]);
});

// ═══════════════════ C16 — لحظة الزيارة ═══════════════════

test('C16 boundedActivityAt وstaffVisitMoment: نافذة العمل دون اتصال للسطر، والمستقبل والتالف لزيارة الإدارة', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  const n = now.getTime(); const MIN = 60_000; const DAY = 86_400_000;
  assert.equal(ev.boundedActivityAt(new Date(n - 3 * DAY), now)?.getTime(), n - 3 * DAY);
  assert.equal(ev.boundedActivityAt(new Date(n + 4 * MIN), now)?.getTime(), n + 4 * MIN);
  assert.equal(ev.boundedActivityAt(new Date('2099-01-01'), now), undefined);
  assert.equal(ev.boundedActivityAt(new Date('2020-01-01'), now), undefined);
  assert.equal(ev.boundedActivityAt(new Date('x'), now), undefined);
  assert.equal(ev.boundedActivityAt(null, now), undefined);

  const { staffVisitMoment } = visitsModule;
  assert.deepEqual(staffVisitMoment('2026-10-30T10:00:00.000Z', now), { createdAt: new Date('2026-10-30T10:00:00.000Z'), shiftMs: 0 }, 'المتأخّر كما هو');
  assert.deepEqual(staffVisitMoment('2099-01-01T00:00:00.000Z', now), { createdAt: now, shiftMs: n - Date.parse('2099-01-01T00:00:00.000Z') });
  assert.deepEqual(staffVisitMoment(new Date(n + 4 * MIN).toISOString(), now), { createdAt: new Date(n + 4 * MIN), shiftMs: 0 });
  for (const bad of ['garbage', '', undefined, null, 42]) assert.deepEqual(staffVisitMoment(bad, now), { createdAt: null, shiftMs: 0 }, String(bad));
});

function scriptVisit(): Row[] {
  const created: Row[] = [];
  scripted = {
    'salesRep.findFirst': () => ({ id: 'rep-1', name: 'خالد', requireLocationOn: false, tenant: { settings: { teamsEnabled: false } }, teamMemberships: [] }),
    'customer.findFirst': () => ({ id: 'c-1' }),
    'repVisit.findFirst': () => null,
    'repVisit.create': (a: Row) => { created.push(a.data); return { id: `v-${created.length}`, createdAt: a.data.createdAt ?? new Date(), _count: { photos: 0 }, ...a.data }; },
  };
  return created;
}

test('C16 POST /visits (الإدارة/مفتاح API): لحظةٌ في ٢٠٩٩ تُصحَّح إلى «الآن» بطابعَي مؤقّتها، والتالفة لا تُسقط الطلب، والمتأخّرة تبقى للزيارة وسطرها بلحظة تسجيله', async () => {
  reset();
  let created = scriptVisit();
  const t0 = Date.now();
  let r = await call(visitsRouter, 'post', '/', {
    user: ADMIN,
    body: { customerId: 'c-1', salesRepId: 'rep-1', note: 'x', createdAt: '2099-01-01T10:00:00.000Z', startedAt: '2099-01-01T09:40:00.000Z', endedAt: '2099-01-01T10:00:00.000Z' },
  });
  assert.equal(r.status, 201, why(r));
  const at = created[0].createdAt.getTime();
  assert.ok(at >= t0 && at <= Date.now(), 'المستقبل ⇒ الآن');
  assert.equal(created[0].durationSec, 1200, 'المدّة باقية');
  assert.equal(created[0].endedAt.getTime(), at, 'الطابعان نُقلا مع اللحظة');
  assert.equal(events().length, 1);
  assert.ok(events()[0].at.getTime() >= t0 && events()[0].at.getTime() <= Date.now(), 'سطر السجلّ لا يعلو الخطّ الزمني');

  reset();
  created = scriptVisit();
  r = await call(visitsRouter, 'post', '/', { user: ADMIN, body: { customerId: 'c-1', salesRepId: 'rep-1', note: 'x', createdAt: 'not-a-date' } });
  assert.equal(r.status, 201, why(r));
  assert.equal('createdAt' in created[0], false, 'ساعة الخادم');

  reset();
  created = scriptVisit();
  r = await call(visitsRouter, 'post', '/', { user: { ...ADMIN, apiKeyId: 'k-1' }, body: { customerId: 'c-1', salesRepId: 'rep-1', note: 'x', createdAt: '2020-03-01T10:00:00.000Z' } });
  assert.equal(r.status, 201, why(r));
  assert.equal(created[0].createdAt.toISOString(), '2020-03-01T10:00:00.000Z', 'التسجيل المتأخّر للزيارة كما أُرسل');
  const e = events()[0];
  assert.equal('at' in e, false, 'السطر بلحظة كتابته (افتراض العمود) — لا يصير أقدم سطرٍ للعميل');
  assert.equal(e.data.backdated, true);
  assert.equal(e.data.visitAt, '2020-03-01T10:00:00.000Z');
});

// ═══════════════════ C17 — نتيجة المندوب الذكي ═══════════════════

const AI_CTX = { tid: T, repId: 'rep-1', showMoney: false, countryCode: 'SA', settings: { dailySearchesPerRep: 30, searchRadiusM: 2000, targetOutletTypes: ['GROCERY'], advisorEnabled: false, minPeers: 3 } };
const outcomeReq = (body: Row) => ({ user: REP, aiRep: AI_CTX, headers: {}, body: { clientRef: '7d1f6a0e-3b2a-4c55-9a2e-1f2b3c4d5e6f', placeId: 'ChIJshop', outletType: 'GROCERY', ...body } });
function scriptOutcome(outlet: Row | null, customers: Record<string, string>): void {
  scripted = {
    'aiOutletEvent.findUnique': () => null,
    'aiOutlet.findUnique': () => outlet,
    'aiOutlet.update': (a: Row) => ({ id: outlet?.id ?? 'o-new', ...a.data }),
    'aiOutlet.create': (a: Row) => ({ id: 'o-new', ...a.data }),
    'aiOutletEvent.create': (a: Row) => ({ id: 'ev-1', ...a.data }),
    'customer.findFirst': (a: Row) => {
      const w = a.where ?? {};
      if (w.tenantId !== T) return null;
      const id = w.id ?? Object.entries(customers).find(([place]) => place === w.aiPlaceId)?.[1];
      return id && Object.values(customers).includes(id) ? { id } : null;
    },
  };
}

test('C17 نتيجة المندوب الذكي عند محلٍّ محوَّل (عميلٌ قائم): SMART_REP_OUTCOME في معاملة النتيجة بملاحظتها واعتراضها — وعند محلٍّ ليس عميلاً لا حدث', async () => {
  reset();
  scriptOutcome({ id: 'o1', status: 'CONVERTED', convertedCustomerId: 'cust-1', lastOutcomeAt: new Date('2026-11-01'), lastOutcome: 'CONVERTED', lastSalesRepId: 'rep-1' }, { ChIJother: 'cust-1' });
  let r = await call(aiRepRouter, 'post', '/outcomes', outcomeReq({ kind: 'NOT_INTERESTED', note: 'العميل يشتكي من السعر', relation: 'CUSTOMER' }), { lastOnly: true });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  const e = events()[0];
  assert.deepEqual([e.customerId, e.actorKind, e.actorId, e.refId, e.source], ['cust-1', 'REP', 'rep-1', 'ev-1', 'rep']);
  assert.ok(e.action === 'SMART_REP_OUTCOME' || (e.action === 'OTHER' && e.data.action === 'SMART_REP_OUTCOME'), e.action);
  assert.deepEqual([e.data.kind, e.data.note, e.data.via, e.data.outletId], ['NOT_INTERESTED', 'العميل يشتكي من السعر', 'AI_REP', 'o1']);
  const evCreate = calls.find((c) => c.op === 'aiOutletEvent.create')!;
  assert.ok(committed.every((c) => c.tx === evCreate.tx && c.tx !== null), 'في معاملة النتيجة نفسها');

  // محلٌّ جديد لا يربطه شيءٌ بعميل — ولو قال الجهاز relation CUSTOMER — لا حدث (حقيقة الخادم وحدها)
  reset();
  scriptOutcome(null, {});
  r = await call(aiRepRouter, 'post', '/outcomes', outcomeReq({ kind: 'INTERESTED', relation: 'CUSTOMER' }), { lastOnly: true });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 0);

  // محلٌّ بلا سجلٍّ محوَّل لكنه مربوطٌ بعميلٍ بمعرّف المكان ⇒ حدثٌ على ذلك العميل
  reset();
  scriptOutcome(null, { ChIJshop: 'cust-9' });
  r = await call(aiRepRouter, 'post', '/outcomes', outcomeReq({ kind: 'CALL_BACK' }), { lastOnly: true });
  assert.equal(r.status, 201, why(r));
  assert.deepEqual(events().map((x) => x.customerId), ['cust-9']);
});

test('C17 سباق clientRef (P2002 عند إنشاء الحدث) يُلغي المعاملة فلا يبقى سطرٌ في السجلّ', async () => {
  reset();
  scriptOutcome({ id: 'o1', status: 'CONVERTED', convertedCustomerId: 'cust-1', lastOutcomeAt: new Date('2026-11-01'), lastOutcome: 'CONVERTED', lastSalesRepId: 'rep-1' }, { x: 'cust-1' });
  let n = 0;
  scripted['aiOutletEvent.findUnique'] = () => (n++ === 0 ? null : { id: 'ev-first', outletId: 'o1' });
  scripted['customerActivity.createMany'] = () => { throw Object.assign(new Error('Unique constraint'), { code: 'P2002' }); };
  const r = await quiet(() => call(aiRepRouter, 'post', '/outcomes', outcomeReq({ kind: 'QUOTE' }), { lastOnly: true }));
  assert.equal(r.status, 200, why(r));
  assert.equal(r.body.idempotent, true);
  assert.equal(events().length, 0);
});
