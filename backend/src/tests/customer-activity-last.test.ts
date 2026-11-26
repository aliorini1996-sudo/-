// «سجلّ العميل» — المُصلِح الأخير (٢٧ نوفمبر ٢٠٢٦): أربعة مواضع كان حدثها يُكتب بعد التزام الإجراء أو يُنسب بقاعدةٍ أخرى. فوق Prisma
// مزيّف **بمعاملاتٍ تُتراجع** (ما كُتب في معاملةٍ فشلت أو فشل التزامها لا يبقى — لا الحدث ولا الإجراء)، بلا قاعدة ولا شبكة ولا خادم:
//   ١) المكالمة (services/telephony.ts recordCallEvent): سجلّ المكالمة وحدث CALL_LOGGED في معاملةٍ واحدة.
//   ٢) نطاق مستخدم الشركة (services/adminScope.ts setAdminScope): الحذف والإضافة وأحداث CUSTOMER_ASSIGNED/UNASSIGNED في معاملةٍ واحدة.
//   ٣) ربط الكود في استيراد العملاء (routes/import.ts POST /customers): كل تحديثٍ وحدثه CUSTOMER_UPDATED في معاملة شريحته.
//   ٤) الحذف النهائي لطلب المنيو (routes/ownerPurge.ts purgeActivityEvents): عميل الطلب بالقاعدة الواحدة (catalogOrderCustomers)،
//      وعميل فاتورة إغلاقه للطلب الذي لا عميل له بها وحده.
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

const plain = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
function whereMatches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, w]) => (plain(w) && Array.isArray(w.in) ? w.in.includes(row[k]) : row[k] === w));
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
            if (key === 'customerActivity' && method === 'findMany' && !fn) {
              return committed.map((c) => c.row).filter((r) => whereMatches(r, args?.where));
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
const callsOf = (op: string): Call[] => calls.filter((c) => c.op === op);
const P2002 = () => Object.assign(new Error('Unique constraint failed on the fields: (`providerCallId`)'), { code: 'P2002' });
const ACTIVITY_DOWN = () => { throw new Error('activity insert failed'); };

// ═══════════════════ الحقن قبل تحميل ما يُختبر ═══════════════════

const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
const realAuth = require('../middleware/auth') as typeof import('../middleware/auth');
stub('middleware/auth', {
  ...realAuth,
  authenticate: pass, requireAdmin: pass, requireAdminPermission: () => pass, requireSalesRep: pass, requireSuperAdmin: pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});

const { recordCallEvent } = require('../services/telephony') as typeof import('../services/telephony');
const { setAdminScope } = require('../services/adminScope') as typeof import('../services/adminScope');
const importRouter = require('../routes/import').default;
const ownerPurgeRoute = require('../routes/ownerPurge') as typeof import('../routes/ownerPurge');

// ═══════════════════ تشغيل معالج المسار ═══════════════════

type Reply = { status: number; body: any; error: unknown };
/** المعالج الأخير وحده (صلاحية الاستيراد لها اختباراتها) */
async function callLast(router: unknown, method: string, p: string, req: Row): Promise<Reply> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} missing`);
  const res: Row = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; res.headersSent = true; return res; };
  res.setHeader = (k: string, v: unknown) => { res.headers[k.toLowerCase()] = v; return res; };
  res.set = res.setHeader;
  const full = { method: method.toUpperCase(), url: p, query: {}, params: {}, body: {}, headers: {}, ip: '127.0.0.1', ...req };
  let err: unknown = null;
  await layer!.route.stack.at(-1).handle(full, res, (e?: unknown) => { if (e) err = e; });
  if (err) return { status: 500, body: null, error: err };
  return { status: res.statusCode, body: res.body, error: null };
}
const why = (r: Reply): string => (r.error ? String((r.error as Error)?.stack ?? r.error) : JSON.stringify(r.body));
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error; const w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
}

const T = 'T1';

// ═══════════════════ ١) المكالمة ═══════════════════

let callRows: Row[] = [];
let callSeq = 0;
function scriptCalls(customers: Row[] = [{ id: 'c-1' }]): void {
  callRows = [];
  scripted = {
    'workChannel.findFirst': () => ({ id: 'wc-1', assignedRepId: 'rep-1' }),
    'customer.findMany': () => customers,
    'salesRep.findFirst': () => ({ name: 'خالد' }),
    // القيد الفريد (tenantId, providerCallId) كالقاعدة، والمكالمة تبقى بالتزام معاملتها وحده
    'callLog.create': (a: Row, ctx: Ctx) => {
      if (callRows.some((c) => c.providerCallId === a.data.providerCallId)) throw P2002();
      const c = { id: `call-${++callSeq}`, ...a.data };
      ctx.onCommit(() => callRows.push(c));
      return c;
    },
  };
}
const callEvent = (providerCallId = 'pc-1') => ({
  direction: 'IN', fromE164: '+966501234567', toE164: '+966112223333', startedAt: new Date(Date.now() - 60_000), durationSec: 42,
  recordingUrl: null, transcript: null, aiSummary: 'طلب عرض سعر', providerCallId, channelProviderId: 'ch-1', channelE164: null,
}) as unknown as Parameters<typeof recordCallEvent>[1];

test('المكالمة: الالتزام ⇒ مكالمةٌ واحدة وحدث CALL_LOGGED واحد بمقبض معاملة إنشائها نفسها', async () => {
  reset(); scriptCalls();
  assert.equal(await recordCallEvent(T, callEvent()), 'created');
  assert.equal(callRows.length, 1);
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.refType, e.refId, e.actorKind, e.actorId, e.actorName, e.data.note]),
    [['CALL_LOGGED', 'c-1', 'CALL', callRows[0].id, 'REP', 'rep-1', 'خالد', 'طلب عرض سعر']]);
  const create = callOf('callLog.create')!;
  assert.notEqual(create.tx, null, 'المكالمة داخل معاملة');
  assert.equal(committed[0].tx, create.tx, 'الحدث بمقبض معاملة المكالمة نفسها');
  assert.equal(callOf('salesRep.findFirst')!.tx, null, 'اسم المندوب يُقرأ قبل المعاملة');
});

test('المكالمة: تعذّر إدراج الحدث أو فشل الالتزام ⇒ لا مكالمة ولا حدث — وإعادة الإرسال تحفظها مع حدثٍ واحد', async () => {
  reset(); scriptCalls();
  scripted['customerActivity.createMany'] = ACTIVITY_DOWN;
  await assert.rejects(recordCallEvent(T, callEvent()), /activity insert failed/);
  assert.equal(callRows.length, 0, 'المكالمة تراجعت مع حدثها');
  assert.equal(events().length, 0);
  assert.ok(callOf('callLog.create') && callOf('$rollback'));

  delete scripted['customerActivity.createMany'];
  calls = [];
  failCommits = 1;
  await assert.rejects(recordCallEvent(T, callEvent()), /COMMIT/);
  assert.equal(callsOf('customerActivity.createMany').length, 1, 'الحدث كُتب داخل المعاملة قبل فشلها');
  assert.equal(callRows.length, 0);
  assert.equal(events().length, 0);

  assert.equal(await recordCallEvent(T, callEvent()), 'created');
  assert.equal(callRows.length, 1);
  assert.equal(events().length, 1);
});

test('المكالمة: إعادة إرسال الويبهوك (P2002) ⇒ duplicate بلا حدثٍ ثانٍ — ومكالمةٌ بلا عميل في معاملتها بلا حدث', async () => {
  reset(); scriptCalls();
  assert.equal(await recordCallEvent(T, callEvent('pc-9')), 'created');
  assert.equal(await recordCallEvent(T, callEvent('pc-9')), 'duplicate');
  assert.equal(callRows.length, 1);
  assert.equal(events().length, 1, 'الإعادة لا تُكرّر الحدث');

  reset(); scriptCalls([]);
  assert.equal(await recordCallEvent(T, callEvent('pc-10')), 'created');
  assert.equal(callRows.length, 1);
  assert.notEqual(callOf('callLog.create')!.tx, null);
  assert.equal(callOf('customerActivity.createMany'), undefined, 'لا عميل ⇒ لا حدث');
  assert.equal(callOf('salesRep.findFirst'), undefined, 'ولا قراءة لاسم المندوب');
});

// ═══════════════════ ٢) نطاق مستخدم الشركة ═══════════════════

let scopes: string[] = [];
function scriptScope(initial: string[]): void {
  scopes = [...initial];
  scripted = {
    'customer.findMany': (a: Row) => (a.where.id.in as string[]).filter((id) => id !== 'foreign').map((id) => ({ id })),
    'adminCustomerScope.findMany': () => scopes.map((customerId) => ({ customerId })),
    'adminCustomerScope.deleteMany': (a: Row, ctx: Ctx) => {
      const out = a.where.customerId.in as string[];
      ctx.onCommit(() => { scopes = scopes.filter((id) => !out.includes(id)); });
      return { count: out.length };
    },
    'adminCustomerScope.createMany': (a: Row, ctx: Ctx) => {
      const add = (a.data as Row[]).map((d) => d.customerId as string);
      ctx.onCommit(() => { scopes.push(...add.filter((id) => !scopes.includes(id))); });
      return { count: add.length };
    },
    'admin.findFirst': () => ({ name: 'منى' }),
    'adminCustomerScope.count': () => scopes.length,
  };
}
const AMETA = { actor: { kind: 'ADMIN' as const, id: 'boss-1', name: 'المدير' }, source: 'web' };

test('نطاق المستخدم: الالتزام ⇒ الحذف والإضافة وأحداثهم بمقبض معاملةٍ واحدة', async () => {
  reset(); scriptScope(['c-3']);
  const out = await setAdminScope(T, 'ad-1', ['c-1', 'c-2', 'foreign'], null, AMETA);
  assert.deepEqual(out, { customers: 2, reps: 0 });
  assert.deepEqual([...scopes].sort(), ['c-1', 'c-2']);
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.actorKind, e.data.kind, e.data.adminName]), [
    ['CUSTOMER_ASSIGNED', 'c-1', 'ADMIN', 'ADMIN_SCOPE', 'منى'],
    ['CUSTOMER_ASSIGNED', 'c-2', 'ADMIN', 'ADMIN_SCOPE', 'منى'],
    ['CUSTOMER_UNASSIGNED', 'c-3', 'ADMIN', 'ADMIN_SCOPE', 'منى'],
  ]);
  const del = callOf('adminCustomerScope.deleteMany')!;
  const add = callOf('adminCustomerScope.createMany')!;
  assert.notEqual(del.tx, null, 'الكتابة داخل معاملة');
  assert.equal(add.tx, del.tx);
  assert.ok(committed.every((c) => c.tx === del.tx), 'الأحداث بمقبض معاملة الكتابة نفسها');
  assert.equal(callsOf('$transaction').length, 1);
});

test('نطاق المستخدم: تعذّر الحدث أو فشل الالتزام ⇒ النطاق كما كان بلا حدث — والإعادة تكتبه بأحداثه مرّةً', async () => {
  reset(); scriptScope(['c-3']);
  scripted['customerActivity.createMany'] = ACTIVITY_DOWN;
  await assert.rejects(setAdminScope(T, 'ad-1', ['c-1'], null, AMETA), /activity insert failed/);
  assert.deepEqual(scopes, ['c-3'], 'الحذف والإضافة تراجعا مع أحداثهما');
  assert.equal(events().length, 0);

  delete scripted['customerActivity.createMany'];
  failCommits = 1;
  await assert.rejects(setAdminScope(T, 'ad-1', ['c-1'], null, AMETA), /COMMIT/);
  assert.deepEqual(scopes, ['c-3']);
  assert.equal(events().length, 0);

  await setAdminScope(T, 'ad-1', ['c-1'], null, AMETA);
  assert.deepEqual(scopes, ['c-1']);
  assert.deepEqual(events().map((e) => [e.action, e.customerId]), [['CUSTOMER_ASSIGNED', 'c-1'], ['CUSTOMER_UNASSIGNED', 'c-3']]);
});

test('نطاق المستخدم: لا تغيّر ⇒ لا معاملة ولا حدث', async () => {
  reset(); scriptScope(['c-1']);
  await setAdminScope(T, 'ad-1', ['c-1'], null, AMETA);
  assert.equal(callOf('$transaction'), undefined);
  assert.equal(events().length, 0);
});

// ═══════════════════ ٣) ربط الكود في استيراد العملاء ═══════════════════

const AUTO_1 = 'clx9k2m7p0000abcd1234efgh';
const AUTO_2 = 'clx9k2m7p0000abcd1234efgk';
let codes = new Map<string, string>();
function scriptImport(current: Record<string, string> = { 'c-1': AUTO_1, 'c-2': AUTO_2 }): void {
  codes = new Map(Object.entries(current));
  scripted = {
    'importBatch.create': () => ({ id: 'b-1' }),
    // ما قرأه المخطِّط: الكودان التلقائيان (والقائم قد يتغيّر بعد القراءة)
    'customer.findMany': () => [
      { id: 'c-1', phone: '0501234567', code: AUTO_1, name: 'مؤسسة النور' },
      { id: 'c-2', phone: '0551234567', code: AUTO_2, name: 'بقالة الحي' },
    ],
    // التحديث المشروط بالكود السابق، والكود الجديد يبقى بالتزام معاملته وحده
    'customer.updateMany': (a: Row, ctx: Ctx) => {
      const { id, code } = a.where;
      if (code !== undefined && codes.get(id) !== code) return { count: 0 };
      ctx.onCommit(() => codes.set(id, a.data.code));
      return { count: 1 };
    },
  };
}
const ADMIN = { id: 'ad-1', role: 'ADMIN', tenantId: T, name: 'منى' };
const importRows = [
  { code: 'C001', phone: '0501234567', name: 'مؤسسة النور' },
  { code: 'C002', phone: '0551234567', name: 'بقالة الحي' },
];
const postImport = () => callLast(importRouter, 'post', '/customers', { user: ADMIN, body: { rows: importRows } });

test('ربط الكود: الالتزام ⇒ كل تحديثٍ وحدثه CUSTOMER_UPDATED بمقبض معاملة شريحته نفسها', async () => {
  reset(); scriptImport();
  const r = await postImport();
  assert.equal(r.status, 200, why(r));
  assert.equal(r.body.data.attached, 2);
  assert.deepEqual(r.body.data.attachedRows.map((x: Row) => [x.row, x.code, x.matchedBy]), [[2, 'C001', 'phone'], [3, 'C002', 'phone']]);
  assert.deepEqual([codes.get('c-1'), codes.get('c-2')], ['C001', 'C002']);
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.source, e.data.changes[0].from, e.data.changes[0].to, e.data.row]), [
    ['CUSTOMER_UPDATED', 'c-1', 'import', AUTO_1, 'C001', 2],
    ['CUSTOMER_UPDATED', 'c-2', 'import', AUTO_2, 'C002', 3],
  ]);
  const upd = callsOf('customer.updateMany');
  assert.equal(upd.length, 2);
  assert.ok(upd.every((u) => u.tx !== null && u.tx === upd[0].tx), 'التحديثان في معاملة شريحتهما');
  assert.ok(committed.every((c) => c.tx === upd[0].tx), 'وأحداثهما بمقبضها نفسه');
});

test('ربط الكود: تعذّر الحدث ⇒ لا كود ولا حدث، وخطأٌ لكل صفّ — وفشل التزام الشريحة يُعاد صفاً صفاً بحدثٍ واحدٍ لكلٍّ', async () => {
  reset(); scriptImport();
  scripted['customerActivity.createMany'] = ACTIVITY_DOWN;
  const f = await quiet(postImport);
  assert.equal(f.status, 200, why(f));
  assert.equal(f.body.data.attached ?? 0, 0);
  assert.deepEqual(f.body.data.errors.map((e: Row) => e.row), [2, 3], 'الخطأ منسوبٌ لصفّه');
  assert.deepEqual([codes.get('c-1'), codes.get('c-2')], [AUTO_1, AUTO_2], 'التحديثات تراجعت مع أحداثها');
  assert.equal(events().length, 0);

  reset(); scriptImport();
  // بعد حجز الدفعة (معاملته الخاصة): معاملة شريحة الربط وحدها يفشل التزامها ⇒ تُعاد صفاً صفاً
  const readExisting = scripted['customer.findMany'];
  scripted['customer.findMany'] = (a: Row, ctx: Ctx) => { failCommits = 1; return readExisting(a, ctx); };
  const r = await quiet(postImport);
  assert.equal(r.status, 200, why(r));
  assert.equal(r.body.data.attached, 2);
  assert.deepEqual([codes.get('c-1'), codes.get('c-2')], ['C001', 'C002']);
  assert.deepEqual(events().map((e) => e.customerId), ['c-1', 'c-2'], 'لا حدث من المعاملة المتراجعة');
  const [a, b] = committed.map((c) => c.tx);
  assert.notEqual(a, b, 'كل صفٍّ أُعيد في معاملته');
});

test('ربط الكود: كودٌ تغيّر بعد القراءة ⇒ يُتخطّى (CODE_ATTACHABLE) بلا حدث، والآخر يُربط بحدثه', async () => {
  reset(); scriptImport({ 'c-1': AUTO_1, 'c-2': 'HUMAN-9' });
  const r = await postImport();
  assert.equal(r.status, 200, why(r));
  assert.equal(r.body.data.attached, 1);
  assert.deepEqual(r.body.data.skippedRows, [{ row: 3, reason: 'CODE_ATTACHABLE' }]);
  assert.equal(codes.get('c-2'), 'HUMAN-9');
  assert.deepEqual(events().map((e) => e.customerId), ['c-1']);
});

// ═══════════════════ ٤) الحذف النهائي لطلب المنيو ═══════════════════

const OWNER_META = { actor: { kind: 'OWNER' as const, id: 'owner-1', name: null }, source: 'web' };
const ORDER_AT = new Date('2026-11-20T10:00:00Z');

test('الحذف النهائي لطلب المنيو: عميله بالقاعدة الواحدة (catalogOrderCustomers) داخل معاملة الحذف، وفاتورة الإغلاق لما لا عميل له وحده', async () => {
  reset();
  committed.push({ row: { tenantId: T, customerId: 'c-logged', action: 'CATALOG_ORDER_PLACED', refType: 'CATALOG_ORDER', refId: 'o-1' }, tx: null });
  scripted['catalogOrder.findMany'] = () => [
    // سطر طلبه في السجلّ نهائيّ — ولو طابق جوالُه عميلاً آخر الآن
    { id: 'o-1', status: 'NEW', phoneKey: '966551234567', customerName: 'أبو محمد', invoiceId: null, createdAt: ORDER_AT },
    // مطابقٌ فريد لحظة الطلب ⇒ هو عميله، لا عميل فاتورة إغلاقه
    { id: 'o-2', status: 'DONE', phoneKey: '966551234567', customerName: 'أبو محمد', invoiceId: 'inv-7', createdAt: ORDER_AT },
    // جوالٌ يحمله عميلان ⇒ لا عميل بالقاعدة ⇒ عميل فاتورة إغلاقه
    { id: 'o-3', status: 'DONE', phoneKey: '966571234567', customerName: 'أم علي', invoiceId: 'inv-8', createdAt: ORDER_AT },
    // ملتبسٌ بلا فاتورة ⇒ لا حدث
    { id: 'o-4', status: 'NEW', phoneKey: '966571234567', customerName: 'زائر', invoiceId: null, createdAt: ORDER_AT },
    // عميلٌ أُنشئ بعد الطلب لا يُنسب له (المطابقة القديمة كانت تلصقه بالأحدث)
    { id: 'o-5', status: 'NEW', phoneKey: '966561234567', customerName: 'جديد', invoiceId: null, createdAt: ORDER_AT },
  ];
  scripted['invoice.findFirst'] = (a: Row) => ({ customerId: a.where.id === 'inv-8' ? 'c-inv8' : 'c-inv7' });
  raw = (sql) => (/FROM customers/.test(sql) ? [
    { id: 'c-phone', name: 'بقالة', phone: '0551234567', createdAt: new Date('2026-06-01') },
    { id: 'c-twin-a', name: 'أ', phone: '0571234567', createdAt: new Date('2026-06-01') },
    { id: 'c-twin-b', name: 'ب', phone: '+966571234567', createdAt: new Date('2026-06-02') },
    { id: 'c-late', name: 'لاحق', phone: '0561234567', createdAt: new Date('2026-11-25') },
  ] : undefined);

  const out = await prismaFake.$transaction((tx: unknown) => ownerPurgeRoute.purgeActivityEvents(tx as never, T, 'CatalogOrder', ['o-1', 'o-2', 'o-3', 'o-4', 'o-5'], OWNER_META));
  assert.deepEqual((out as Row[]).map((e) => [e.action, e.customerId, e.refId, e.data.oldStatus, e.data.newStatus, e.data.reason]), [
    ['CATALOG_ORDER_UPDATED', 'c-logged', 'o-1', 'NEW', 'DELETED', 'OWNER_PURGE'],
    ['CATALOG_ORDER_UPDATED', 'c-phone', 'o-2', 'DONE', 'DELETED', 'OWNER_PURGE'],
    ['CATALOG_ORDER_UPDATED', 'c-inv8', 'o-3', 'DONE', 'DELETED', 'OWNER_PURGE'],
  ]);
  assert.deepEqual(callsOf('invoice.findFirst').map((c) => c.args.where.id), ['inv-8'], 'فاتورة الإغلاق لما لا عميل له وحده');
  const tx = callOf('$transaction')!.tx;
  const reads = calls.filter((c) => c.op === 'customerActivity.findMany' || c.op === '$queryRaw' || c.op === 'catalogOrder.findMany');
  assert.ok(reads.length >= 3 && reads.every((c) => c.tx === tx), 'قراءات النسبة بمقبض معاملة الحذف نفسها');
  assert.equal(callsOf('$queryRaw').length, 1, 'استعلامٌ واحد لكل ذيول الجوالات');
});
