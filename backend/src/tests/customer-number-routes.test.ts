// «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — موجّه العملاء الحقيقي فوق Prisma مزيّف (بلا قاعدة ولا شبكة). يثبت:
//   • الإنشاء (POST، وPUT لمعرّفٍ مجهول) يمرّ بمساعد الترقيم داخل معاملةٍ بمهلة CUSTOMER_NUMBER_TX، فيأخذ العميل الرقم التالي
//     لشركته؛ و«number» في الجسم لا أثر له (للقراءة وحدها) في الإنشاء ولا التعديل.
//   • فشل الإنشاء داخل المعاملة (تصادم المعرّف 'RACED'، أو نوع سعرٍ حُذف P2003) يُلغيها فلا يُستهلك رقم ولا تبقى فجوة منه.
//   • الإسناد التلقائي للمندوب بعد الالتزام لا داخل معاملة الإنشاء (اتصالٌ آخر لا يرى صفّاً لم يُلتزم) — في معاملته الخاصة مع حدثه.
//   • البحث: نصٌّ أرقامٌ كلّه (#١٢ أو 12) يضيف { number: N } إلى OR القائمة مع الاسم والجوال والكود — والجوال الخام أول شرط جوال كما كان؛
//     و05 وabc والجوال الطويل بلا شرط رقم. وقائمة بيانات الفوترة كذلك داخل عنصر AND نفسه.
// المساعد الحقيقي (قفل صفّ الشركة والـSQL الخام) يختبره customer-number.test.ts؛ هنا يُستبدل createNumberedCustomer وحده بعدّادٍ
// في الذاكرة يحاكي customerSeq ويتراجع مع المعاملة — وبقية الوحدة (customerNumberOr وCUSTOMER_NUMBER_TX) حقيقية؛ واختبارٌ واحد
// (realHelper) يمرّ بالمساعد الحقيقي نفسه فوق $queryRaw مزيّف يحاكي صفّ الشركة.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّه (نمط customer-phone-free.test.ts) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Call = { op: string; inTx: boolean };
let calls: Call[] = [];
let scripted: Record<string, (args: any) => unknown> = {};
let inTx = 0;
let txOptions: unknown[] = [];
/** عدّاد الشركة (customerSeq) في الذاكرة — يُستعاد إن رمت المعاملة كما تتراجع القاعدة */
let seq = new Map<string, number>();

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    calls.push({ op: `${model}.${method}`, inTx: inTx > 0 });
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(args) : defaultFor(method);
  },
});
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown, opts?: unknown) => {
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        txOptions.push(opts);
        const snapshot = new Map(seq);
        inTx++;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); }
        catch (e) { seq = snapshot; throw e; }
        finally { inTx--; }
      };
    }
    if (key === '$queryRaw') return fakeQueryRaw;
    if (key === '$executeRaw') return async () => 0;
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

/** الـSQL الخام الذي نفّذه المساعد الحقيقي: نصّه وقيمه وهل كان داخل معاملة */
let rawLog: { sql: string; values: unknown[]; inTx: boolean }[] = [];
/** المساعد الحقيقي (قفل صفّ الشركة وقراءة الأساس وحفظ العدّاد) بدل البديل — لاختبارٍ واحد يمرّ بالمسار كاملاً */
let realHelper = false;
/**
 * $queryRaw المزيّف: [] دائماً (فالمساعد الحقيقي يُنشئ بلا رقم كبقية البدائل) — إلا مع realHelper فيحاكي جدول الشركات:
 * قراءة الأساس (GREATEST(customerSeq, MAX(number))) تُعيد عدّاد الذاكرة، وحفظ العدّاد يكتبه فيها (ويتراجع مع المعاملة)
 */
async function fakeQueryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> {
  const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
  rawLog.push({ sql, values, inTx: inTx > 0 });
  if (!realHelper) return [];
  if (/GREATEST\(t\."customerSeq"/.test(sql)) return [{ base: seq.get(String(values[0])) ?? 0 }];
  if (/UPDATE "tenants" SET "customerSeq"/.test(sql)) { seq.set(String(values[1]), Number(values[0])); return [{ customerSeq: values[0] }]; }
  return [];
}

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const REP: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
let currentUser: User = ADMIN;
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});

/* eslint-disable @typescript-eslint/no-var-requires */
const realNumbers = require('../services/customerNumber') as typeof import('../services/customerNumber');
/** المنشأ بالمساعد: الشركة والبيانات كما وصلته، وهل كان داخل معاملة */
const helperCalls: { tid: string; data: Record<string, unknown>; inTx: boolean }[] = [];
stub('services/customerNumber', {
  ...realNumbers,
  // عقد المساعد: الرقم التالي للشركة يكتب فوق أي number في البيانات — والإنشاء بـtx المعاملة نفسها
  createNumberedCustomer: async (tx: any, tid: string, data: Record<string, unknown>) => {
    helperCalls.push({ tid, data: { ...data }, inTx: inTx > 0 });
    if (realHelper) return realNumbers.createNumberedCustomer(tx, tid, data as never);
    const n = (seq.get(tid) ?? 0) + 1;
    seq.set(tid, n);
    return tx.customer.create({ data: { ...data, number: n } });
  },
});
const customersModule = require('../routes/customers') as typeof import('../routes/customers');
const { buyerListWhere, pinnedBuyerRow, scanBuyerData } = require('../routes/customersZatca') as typeof import('../routes/customersZatca');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ العُدّة ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/customers', customersModule.default);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'PUT' | 'GET', url: string, body?: unknown): Promise<Reply> {
  const s = await startServer();
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** عالمٌ بعميلٍ قائم c1 (رقمه 7) — يسجّل ما يُنشأ وما يُعدَّل */
function world(o: { user?: User; startSeq?: number } = {}) {
  currentUser = o.user ?? ADMIN;
  calls = [];
  txOptions = [];
  rawLog = [];
  realHelper = false;
  helperCalls.length = 0;
  seq = new Map([[TENANT, o.startSeq ?? 0]]);
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true, canEditCustomer: true, requireCustomerProximity: false }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': (args) => (args?.where?.id === 'c1' ? { id: 'c1', phone: '0500000000', number: 7 } : null),
    'customer.findUnique': () => null,
    'customer.create': (args) => { created.push(args.data); return { id: (args.data.id as string) ?? `c-new-${created.length}`, ...args.data }; },
    'customer.update': (args) => { updated.push(args.data); return { id: 'c1', number: 7, ...args.data }; },
  };
  return { created, updated };
}

const p2002OnId = () => Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002', meta: { target: ['id'] } });

// ═══ الإنشاء ═══

test('POST: العميل يأخذ رقم شركته التالي من المساعد داخل معاملة بمهلة CUSTOMER_NUMBER_TX — و«number» في الجسم لا أثر له', async () => {
  const w = world({ startSeq: 41 });
  const r1 = await call('POST', '/api/customers', { name: 'بقالة الأمل', phone: '0501111111', number: 999 });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.data.number, 42, 'التالي بعد عدّاد الشركة لا رقم الجسم');
  assert.equal(helperCalls.length, 1);
  assert.equal(helperCalls[0].tid, TENANT, 'شركة الطالب');
  assert.equal(helperCalls[0].inTx, true, 'داخل المعاملة');
  assert.equal('number' in helperCalls[0].data, false, 'المخطّط يُسقط number');
  assert.equal(helperCalls[0].data.tenantId, TENANT);
  assert.deepEqual(txOptions, [realNumbers.CUSTOMER_NUMBER_TX], 'معاملةٌ واحدة بمهلة الترقيم');
  // إنشاءٌ مباشر خارج المساعد لا يحدث: كل customer.create داخل المعاملة
  assert.ok(calls.filter((c) => c.op === 'customer.create').every((c) => c.inTx));

  const r2 = await call('POST', '/api/customers', { name: 'تموينات الحي' });
  assert.equal(r2.body.data.number, 43, 'متتالٍ في الشركة');
  assert.equal(w.created.length, 2);
  assert.deepEqual(w.created.map((d) => d.number), [42, 43]);
});

test('POST من المندوب: الإسناد التلقائي بعد الالتزام لا داخل المعاملة، والرقم يُمنح كالإدارة', async () => {
  world({ user: REP });
  const r = await call('POST', '/api/customers', { name: 'محل جديد', clientRef: '6f1c2a9e-3b7d-4c2e-9a51-2f0e8d7c4b10' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.number, 1, 'أول عميل للشركة');
  assert.equal(r.body.data.createdBySalesRepId, 'rep-1');
  const assign = calls.filter((c) => c.op.startsWith('customerAssignment.'));
  assert.equal(assign.length, 1);
  // بعد التزام الإنشاء في معاملته الخاصة مع حدثه في «سجلّ العميل» (ensureAssignment): معاملتان — الإنشاء ثم الإسناد
  assert.equal(assign[0].inTx, true, 'ensureAssignment في معاملته الخاصة');
  assert.equal(txOptions.length, 2, 'معاملة الإسناد مستقلّة بعد معاملة الإنشاء');
  const createAt = calls.findIndex((c) => c.op === 'customer.create');
  assert.ok(createAt >= 0 && calls.indexOf(assign[0]) > createAt);
});

test('POST: إعادة الرفع بـclientRef لعميلٍ قائم تعيده كما هو برقمه — بلا مساعد ولا رقمٍ جديد', async () => {
  world({ startSeq: 5 });
  const clientRef = '0b7a3c1e-2d4f-4a6b-8c9d-1e2f3a4b5c6d';
  scripted['customer.findFirst'] = (args) => (args?.where?.clientRef === clientRef ? { id: 'c-old', name: 'قديم', number: 3, clientRef } : null);
  const r = await call('POST', '/api/customers', { name: 'قديم', clientRef, number: 77 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.idempotent, true);
  assert.equal(r.body.data.number, 3);
  assert.equal(helperCalls.length, 0);
  assert.equal(seq.get(TENANT), 5, 'العدّاد لم يتحرّك');
});

test('POST: رفعان متزامنان للمستند نفسه — الثاني يجد الأوّل تحت قفل الشركة فيُعاد كما هو بلا عميلٍ ثانٍ ولا رقم', async () => {
  // الفحص الأوّل (خارج المعاملة) لا يجده — سبقه الرفع الآخر بين الفحص والإدراج — وإعادة الفحص تحت القفل تجده
  world({ startSeq: 8 });
  const clientRef = '5d2e8f10-7a3b-4c9d-8e1f-2a3b4c5d6e7f';
  scripted['customer.findFirst'] = (args) => (inTx > 0 && args?.where?.clientRef === clientRef
    ? { id: 'c-twin', name: 'محل', number: 9, clientRef, createdBySalesRepId: null } : null);
  const r = await call('POST', '/api/customers', { name: 'محل', clientRef });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.idempotent, true);
  assert.equal(r.body.data.id, 'c-twin');
  assert.equal(r.body.data.number, 9);
  assert.equal(helperCalls.length, 0, 'لا إنشاء');
  assert.equal(seq.get(TENANT), 8, 'لا رقم مستهلك');
  // القفل على صفّ الشركة قبل إعادة الفحص، وكلاهما في المعاملة
  const lock = rawLog.findIndex((q) => /FOR NO KEY UPDATE/.test(q.sql));
  assert.ok(lock >= 0 && rawLog[lock].inTx, 'قفل الشركة في المعاملة');
  assert.deepEqual(rawLog[lock].values, [TENANT]);
  const finds = calls.filter((c) => c.op === 'customer.findFirst');
  assert.deepEqual(finds.map((c) => c.inTx), [false, true], 'الفحص الأوّل ثم إعادته تحت القفل');

  // مندوبٌ آخر لا يملك العميل ولا يصله (عزل العملاء مفعّل) ⇒ 403 كالفحص الأوّل حرفياً — لا كشف ولا إسناد
  world({ user: REP, startSeq: 8 });
  scripted['customer.findFirst'] = (args) => (inTx > 0 && args?.where?.clientRef === clientRef
    ? { id: 'c-twin', name: 'محل', number: 9, clientRef, createdBySalesRepId: 'rep-2' } : null);
  scripted['companySettings.findUnique'] = () => ({ customerIsolationEnabled: true });
  const denied = await call('POST', '/api/customers', { name: 'محل', clientRef });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.data, undefined, 'لا بيانات العميل');
  assert.equal(calls.some((c) => c.op.startsWith('customerAssignment.')), false, 'لا إسناد لغير المنشئ');
  assert.equal(helperCalls.length, 0);
  // ومنشئه نفسه ⇒ 200 ويُضمن إسناده بعد المعاملة
  world({ user: REP, startSeq: 8 });
  scripted['customer.findFirst'] = (args) => (inTx > 0 && args?.where?.clientRef === clientRef
    ? { id: 'c-twin', name: 'محل', number: 9, clientRef, createdBySalesRepId: 'rep-1' } : null);
  const mine = await call('POST', '/api/customers', { name: 'محل', clientRef });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.idempotent, true);
  const assign = calls.filter((c) => c.op.startsWith('customerAssignment.'));
  assert.equal(assign.length, 1);
  assert.equal(assign[0].inTx, true, 'الإسناد في معاملته الخاصة');
  assert.equal(txOptions.length, 2, 'معاملة الإسناد مستقلّة بعد معاملة إعادة الفحص');
  assert.equal(helperCalls.length, 0);

  // بلا clientRef: لا قفلٌ زائد ولا إعادة فحص — المساعد وحده يقفل
  world();
  await call('POST', '/api/customers', { name: 'بلا مرجع' });
  assert.equal(calls.filter((c) => c.op === 'customer.findFirst' && c.inTx).length, 0);
});

test('POST: نوع سعرٍ حُذف بين الفحص والكتابة (P2003) ⇒ 400 PRICE_LIST_INVALID، والمعاملة تتراجع فلا يُستهلك رقم', async () => {
  const w = world({ startSeq: 10 });
  scripted['priceList.count'] = () => 1;
  scripted['customer.create'] = () => {
    throw Object.assign(new Error('Foreign key constraint failed on the field: `customers_priceListId_fkey (index)`'),
      { code: 'P2003', meta: { field_name: 'customers_priceListId_fkey (index)' } });
  };
  const r = await call('POST', '/api/customers', { name: 'بقالة', priceListId: 'L-1' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PRICE_LIST_INVALID');
  assert.equal(seq.get(TENANT), 10, 'الرقم المحجوز عاد مع التراجع');
  assert.equal(w.created.length, 0);
});

test('POST بالمساعد الحقيقي: قفل صفّ الشركة ثم الأساس ثم حفظ العدّاد على اتصال المعاملة قبل الإدراج — والفشل بعده يعيد العدّاد', async () => {
  const w = world({ startSeq: 41 });
  realHelper = true;
  const r = await call('POST', '/api/customers', { name: 'بقالة الأمل', number: 999 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.number, 42, 'رقم الخادم لا رقم الجسم');
  assert.deepEqual(w.created.map((d) => [d.number, d.tenantId]), [[42, TENANT]]);
  assert.equal(seq.get(TENANT), 42, 'العدّاد محفوظ');
  assert.deepEqual(txOptions, [realNumbers.CUSTOMER_NUMBER_TX]);
  // الـSQL الخام للمساعد كله داخل المعاملة، وأوّله قفل صفّ شركة الطالب
  const helperRaw = rawLog.filter((q) => /FOR NO KEY UPDATE|customerSeq|"number"/.test(q.sql));
  assert.ok(helperRaw.length >= 3 && helperRaw.every((q) => q.inTx), JSON.stringify(rawLog.map((q) => [q.sql.slice(0, 40), q.inTx])));
  assert.match(helperRaw[0].sql, /FROM "tenants" WHERE "id" = \? FOR NO KEY UPDATE/);
  assert.deepEqual(helperRaw[0].values, [TENANT]);
  const insert = calls.findIndex((c) => c.op === 'customer.create');
  assert.ok(insert >= 0 && calls[insert].inTx, 'الإدراج في المعاملة نفسها');

  assert.equal((await call('POST', '/api/customers', { name: 'تموينات الحي' })).body.data.number, 43, 'متتالٍ');
  // نوع سعرٍ حُذف بين الفحص والكتابة (P2003) بعد حفظ العدّاد داخل المعاملة ⇒ التراجع يعيده فلا فجوة
  scripted['priceList.count'] = () => 1;
  scripted['customer.create'] = () => {
    throw Object.assign(new Error('Foreign key constraint failed on the field: `customers_priceListId_fkey (index)`'),
      { code: 'P2003', meta: { field_name: 'customers_priceListId_fkey (index)' } });
  };
  const failed = await call('POST', '/api/customers', { name: 'بقالة', priceListId: 'L-1' });
  assert.equal(failed.status, 400, JSON.stringify(failed.body));
  assert.equal(seq.get(TENANT), 43, 'العدّاد كما كان قبل الإنشاء الفاشل');
});

test('PUT لمعرّفٍ مجهول: يُنشأ بمعرّفه نفسه ورقمه التالي داخل معاملة — و«number» في الجسم لا أثر له', async () => {
  const w = world({ startSeq: 2 });
  const r = await call('PUT', '/api/customers/erp-77', { name: 'عميل ERP', number: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.equal(r.body.data.id, 'erp-77', 'المعرّف كما أرسله النظام الخارجي');
  assert.equal(r.body.data.number, 3);
  assert.equal(helperCalls.length, 1);
  assert.equal(helperCalls[0].inTx, true);
  assert.equal('number' in helperCalls[0].data, false);
  assert.deepEqual(txOptions, [realNumbers.CUSTOMER_NUMBER_TX]);
  assert.equal(w.created.length, 1);
});

test('PUT لمعرّفٍ مجهول سبقه طلبٌ موازٍ (P2002 على id — RACED): المعاملة تتراجع فلا يُستهلك رقم، ويُعدَّل العميل بلا رقمٍ جديد', async () => {
  const w = world({ startSeq: 20 });
  let raced = false;
  scripted['customer.create'] = () => { raced = true; throw p2002OnId(); };
  // بعد السباق يجده البحث الثاني (أنشأه الطلب الموازي برقمه)
  scripted['customer.findFirst'] = (args) => (raced && args?.where?.id === 'erp-9' ? { id: 'erp-9', phone: '', number: 21 } : null);
  scripted['customer.update'] = (args) => { w.updated.push(args.data); return { id: 'erp-9', number: 21, ...args.data }; };
  const r = await call('PUT', '/api/customers/erp-9', { name: 'عميل ERP', number: 500 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.number, 21, 'رقم العميل الذي أنشأه السابق');
  assert.equal(seq.get(TENANT), 20, 'السباق الخاسر لم يستهلك رقماً');
  assert.equal(w.updated.length, 1);
  assert.equal('number' in w.updated[0], false, 'التعديل لا يكتب الرقم');
  // والإنشاء التالي بلا فجوة
  scripted['customer.create'] = (args) => { w.created.push(args.data); return { id: 'c-next', ...args.data }; };
  assert.equal((await call('POST', '/api/customers', { name: 'التالي' })).body.data.number, 21);
});

test('PUT لعميلٍ قائم: «number» في الجسم لا يُكتب (للقراءة وحدها) — وبقية الحقول كما كانت', async () => {
  const w = world();
  const r = await call('PUT', '/api/customers/c1', { name: 'اسم جديد', number: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.updated.length, 1);
  assert.equal('number' in w.updated[0], false);
  assert.equal(w.updated[0].name, 'اسم جديد');
  assert.equal(r.body.data.number, 7, 'الرقم المحفوظ يعود كما هو');
  assert.equal(helperCalls.length, 0);
});

// ═══ البحث ═══

async function searchWhere(q: string): Promise<Record<string, any>> {
  const seen: any[] = [];
  world();
  scripted['customer.findMany'] = (args) => { seen.push(args.where); return []; };
  const r = await call('GET', `/api/customers?search=${encodeURIComponent(q)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return seen[0];
}
const numberClauses = (where: Record<string, any>) => (where.OR ?? []).filter((c: Record<string, unknown>) => 'number' in c);

test('GET /customers?search=#١٢: OR يضيف { number: 12 } مع الاسم والجوال والكود — والجوال الخام أول شرط جوال، والشركة والحالة خارج OR', async () => {
  const where = await searchWhere('#١٢');
  assert.deepEqual(numberClauses(where), [{ number: 12 }]);
  // الشروط القائمة كما هي وبترتيبها في رأس OR
  assert.deepEqual(where.OR.slice(0, 4), [
    { name: { contains: '#١٢', mode: 'insensitive' } },
    { businessName: { contains: '#١٢', mode: 'insensitive' } },
    { phone: { contains: '#١٢' } },
    { code: { contains: '#١٢', mode: 'insensitive' } },
  ]);
  assert.deepEqual(where.OR.find((c: Record<string, unknown>) => 'phone' in c), { phone: { contains: '#١٢' } }, 'الجوال الخام أولاً');
  assert.equal(where.tenantId, TENANT);
  assert.deepEqual(where.status, { not: 'DELETED' });
  assert.equal('number' in where, false, 'الرقم داخل OR لا شرطاً أعلى يطغى على البحث');
});

test('GET /customers: «12» و«# 7» و«٣» أرقام عملاء، والجوال الذي يحوي الأرقام يطابق كما كان', async () => {
  const w12 = await searchWhere('12');
  assert.deepEqual(numberClauses(w12), [{ number: 12 }]);
  assert.ok(w12.OR.some((c: any) => c.phone?.contains === '12'), 'الجوال بالاحتواء باقٍ');
  assert.deepEqual(numberClauses(await searchWhere('# 7')), [{ number: 7 }]);
  const w3 = await searchWhere('٣');
  assert.deepEqual(numberClauses(w3), [{ number: 3 }]);
  // الأرقام العربية-الهندية تطابق الجوال المخزَّن لاتينياً — شرطٌ إضافيّ بعد الخام
  assert.ok(w3.OR.some((c: any) => c.phone?.contains === '3'));
  assert.equal(w3.OR.find((c: Record<string, unknown>) => 'phone' in c).phone.contains, '٣');
});

test('GET /customers: 05 وabc و966551234567 (فوق السقف) والفارغ بلا شرط رقم', async () => {
  for (const q of ['05', 'abc', '966551234567', 'بقالة 12', '12a', '0']) {
    const where = await searchWhere(q);
    assert.deepEqual(numberClauses(where), [], q);
    assert.ok(Array.isArray(where.OR), `${q}: بحث الاسم والجوال كما كان`);
  }
  const empty = await searchWhere('');
  assert.equal('OR' in empty, false, 'البحث الفارغ لا يضيف شرطاً');
});

test('GET /customers?search=12: صاحب الرقم أوّل الصفحة الأولى ولو سبقه أكثر من صفحةٍ من الجوالات المطابقة — والصفحات التالية مُزاحةٌ بلاه', async () => {
  // ٤٠ عميلاً جوالاتهم تحوي «12» أحدث من #12 (createdAt desc يضعه آخرهم) — والصفحة ١٥
  const phones = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `جوال ${i}`, phone: `05512${String(i).padStart(4, '0')}`, number: 100 + i }));
  const exact = { id: 'c12', name: 'مؤسسة سمارة', phone: '', number: 12 };
  const finds: any[] = [];
  const pages: any[] = [];
  world();
  scripted['customer.count'] = () => phones.length + 1;
  scripted['customer.findFirst'] = (args) => { finds.push(args); return args?.where?.number === 12 ? exact : null; };
  scripted['customer.findMany'] = (args) => {
    pages.push(args);
    const notId = args.where?.id?.not;
    const all = [...phones, exact].filter((c) => c.id !== notId);
    return all.slice(args.skip, args.skip + args.take);
  };
  const p1 = await call('GET', '/api/customers?search=12&limit=15&page=1');
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.data.length, 15);
  assert.equal(p1.body.data[0].id, 'c12', '#12 أوّلاً');
  assert.deepEqual(p1.body.data.slice(1).map((c: any) => c.id), phones.slice(0, 14).map((c) => c.id));
  assert.equal(p1.body.pagination.total, 41, 'المجموع لا يتغيّر');
  // صاحب الرقم بالشرط نفسه (الشركة والحالة وOR البحث) مع number
  const w = finds[0].where;
  assert.equal(w.tenantId, TENANT);
  assert.deepEqual(w.status, { not: 'DELETED' });
  assert.equal(w.number, 12);
  assert.ok(Array.isArray(w.OR) && w.OR.some((c: any) => c.phone?.contains === '12'));
  assert.deepEqual(pages[0].where.id, { not: 'c12' });
  assert.deepEqual([pages[0].skip, pages[0].take], [0, 14]);
  assert.deepEqual(pages[0].orderBy, { createdAt: 'desc' });

  // الصفحة الثانية: تبدأ حيث انتهت الأولى بلا تكرارٍ ولا سقوط، والثالثة آخرها
  const p2 = await call('GET', '/api/customers?search=%2312&limit=15&page=2');
  assert.deepEqual(p2.body.data.map((c: any) => c.id), phones.slice(14, 29).map((c) => c.id));
  assert.deepEqual([pages[1].skip, pages[1].take], [14, 15]);
  const p3 = await call('GET', '/api/customers?search=12&limit=15&page=3');
  assert.deepEqual(p3.body.data.map((c: any) => c.id), phones.slice(29).map((c) => c.id));
  const seen = [...p1.body.data, ...p2.body.data, ...p3.body.data].map((c: any) => c.id);
  assert.equal(new Set(seen).size, 41, 'كل العملاء مرّةً واحدة');

  // لا صاحب رقم ⇒ الصفحة كما كانت حرفياً؛ ونصٌّ ليس رقماً ⇒ لا استعلامٌ زائد
  finds.length = 0; pages.length = 0;
  await call('GET', '/api/customers?search=999&limit=15');
  assert.equal(finds.length, 1);
  assert.equal(pages[0].where.id, undefined);
  assert.deepEqual([pages[0].skip, pages[0].take], [0, 15]);
  finds.length = 0; pages.length = 0;
  await call('GET', '/api/customers?search=abc&limit=15');
  assert.equal(finds.length, 0);
  assert.deepEqual([pages[0].skip, pages[0].take], [0, 15]);
});

test('GET /customers/locations: رقم العميل في select مع الاسم', async () => {
  const seen: any[] = [];
  world();
  scripted['customer.findMany'] = (args) => { seen.push(args); return [{ id: 'c1', number: 7, name: 'بقالة' }]; };
  const r = await call('GET', '/api/customers/locations');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(seen[0].select.number, true);
  assert.equal(r.body.data[0].number, 7);
});

test('buyerListWhere: بحث «#7» يضيف { number: 7 } داخل عنصر OR نفسه في AND — والنطاق عنصرٌ مستقل لا يُمسّ', () => {
  const scope = { assignments: { some: { salesRepId: 'rep-1' } } };
  const where = buyerListWhere({ tid: TENANT, scope, status: 'ACTIVE', search: '#7', repId: null });
  assert.deepEqual(Object.keys(where).sort(), ['AND', 'tenantId']);
  const and = where.AND as Record<string, any>[];
  assert.ok(and.includes(scope as never) || and.some((c) => JSON.stringify(c) === JSON.stringify(scope)), 'النطاق في AND');
  const or = and.find((c) => 'OR' in c && JSON.stringify(c).includes('"contains":"#7"'))!.OR as Record<string, unknown>[];
  assert.deepEqual(or[or.length - 1], { number: 7 });
  assert.deepEqual(or.slice(0, 4).map((c) => Object.keys(c)[0]), ['name', 'businessName', 'phone', 'code']);
  // وغير الأرقام بلا شرط رقم
  const plain = buyerListWhere({ tid: TENANT, scope: {}, status: 'ALL', search: '05', repId: null });
  const plainOr = (plain.AND as Record<string, any>[]).find((c) => 'OR' in c && JSON.stringify(c).includes('"contains":"05"'))!.OR as Record<string, unknown>[];
  assert.equal(plainOr.some((c) => 'number' in c), false);
});

test('قائمة بيانات الفوترة: صاحب الرقم مثبَّتٌ أوّل الصفحة الأولى ومستثنى من المسح — لا تكرار ولا سقوط عبر الصفحات، والملخّص يعدّه', async () => {
  const mk = (id: string, name: string, number: number) => ({
    id, code: null, number, name, businessName: 'منشأة', phone: '', city: null, district: null, channel: null, status: 'ACTIVE',
    taxNumber: null, commercialReg: null, buyerType: null, buyerIdScheme: null, buyerIdValue: null, addrStreet: null, addrBuildingNo: null,
    addrAdditionalNo: null, addrPostalCode: null, countryCode: null,
  });
  // الترتيب بالاسم يضع صاحب الرقم «ي» آخر الكل
  const others = Array.from({ length: 5 }, (_, i) => mk(`a${i}`, `أ${i}`, 100 + i));
  const exact = mk('z12', 'ي', 12);
  const all = [...others, exact];
  const firsts: any[] = [];
  const scans: any[] = [];
  const db = {
    customer: {
      findFirst: async (a: any) => { firsts.push(a); return a.where.number === 12 ? exact : null; },
      findMany: async (a: any) => {
        scans.push(a);
        let list = all.filter((r) => r.id !== a.where.id?.not);
        if (a.cursor) list = list.slice(list.findIndex((r) => r.id === a.cursor.id) + (a.skip ?? 0));
        return list.slice(0, a.take);
      },
    },
  } as never;
  const where = buyerListWhere({ tid: TENANT, scope: {}, status: 'ACTIVE', search: '#12', repId: null });
  const pinned = await pinnedBuyerRow(db, where, '#12', 'all', 3);
  assert.equal(pinned?.id, 'z12');
  // صاحب الرقم بالشرط نفسه (الشركة وAND القائمة) مع number
  assert.equal(firsts[0].where.tenantId, TENANT);
  assert.deepEqual(firsts[0].where.AND, where.AND);
  assert.equal(firsts[0].where.number, 12);

  const p1 = await scanBuyerData(db, where, { bucket: 'all', limit: 3, cursor: null, withSummary: true, pinned });
  assert.deepEqual(p1.rows.map((r) => r.id), ['z12', 'a0', 'a1']);
  assert.equal(p1.summary?.scanned, 6, 'الملخّص يعدّ المثبَّت مرّةً واحدة');
  assert.equal(p1.summary?.unclassifiedWithSignals, 6);
  assert.ok(scans.every((s) => s.where.id?.not === 'z12'), 'المسح بلا صاحب الرقم');
  const p2 = await scanBuyerData(db, where, { bucket: 'all', limit: 3, cursor: p1.nextCursor, withSummary: false, pinned });
  assert.deepEqual(p2.rows.map((r) => r.id), ['a2', 'a3', 'a4'], 'الصفحة الثانية بلا تكرارٍ ولا سقوط');

  // صاحب رقمٍ خارج الدلو، أو صفحةٌ أصغر من صفّين، أو نصٌّ ليس رقماً ⇒ لا تثبيت (والأخير بلا استعلام)
  assert.equal(await pinnedBuyerRow(db, where, '12', 'complete', 3), null);
  assert.equal(await pinnedBuyerRow(db, where, '12', 'all', 1), null);
  firsts.length = 0;
  assert.equal(await pinnedBuyerRow(db, where, 'abc', 'all', 3), null);
  assert.equal(firsts.length, 0);
  // وبلا تثبيت المسح كما كان حرفياً
  scans.length = 0;
  const plain = await scanBuyerData(db, where, { bucket: 'all', limit: 3, cursor: null, withSummary: true, pinned: null });
  assert.deepEqual(plain.rows.map((r) => r.id), ['a0', 'a1', 'a2']);
  assert.equal(plain.summary?.scanned, 6);
  assert.equal(scans[0].where, where);
});
