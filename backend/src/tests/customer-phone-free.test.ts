// جوال العميل حرّ (أمر المالك ٧ نوفمبر ٢٠٢٦: «فك القيد بالكامل… اجعل تسجيل الجوال ليس إجبارياً») — معالجات العملاء الحقيقية
// فوق Prisma مزيّف (بلا قاعدة بيانات). يثبت:
//   • الإنشاء: الجوال اختياريّ (غائب/null/فارغ/مسافات ⇒ '' لأن العمود NOT NULL)، بلا حدٍّ أدنى ولا صيغة، يُقصّ طرفاه، وسقفه ٣٠ حرفاً.
//   • الرفع المؤجَّل من صندوق المندوب (clientRef) بلا جوال يُنشأ ولا يُرفض، ولا يُطابَق عميلٌ بجواله (التكرار بـclientRef وحده).
//   • التعديل: الغائب لا يمسّ الجوال، وnull/الفارغ يمسحه إلى ''، والقصير يُقبل، والجوال المحفوظ الأطول من السقف يعود كما هو بلا رفض
//     ولا كتابة، والجديد الأطول ٤٠٠.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّه (نمط price-lists.test.ts) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let calls: string[] = [];
let scripted: Record<string, (args: any) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    calls.push(`${model}.${method}`);
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(args) : defaultFor(method);
  },
});
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : Promise.all(arg as Promise<unknown>[]));
    }
    if (key === '$queryRaw' || key === '$executeRaw') return async () => (key === '$queryRaw' ? [] : 0);
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

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
const customersModule = require('../routes/customers') as typeof import('../routes/customers');
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

/** عالمٌ بعميلٍ واحد c1 بجواله المحفوظ storedPhone — يسجّل ما يُكتب وما يُسأل عنه العميل */
function world(o: { user?: User; storedPhone?: string } = {}) {
  currentUser = o.user ?? ADMIN;
  calls = [];
  const written: Record<string, unknown>[] = [];
  const customerQueries: any[] = [];
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true, canEditCustomer: true, requireCustomerProximity: false }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': (args) => {
      customerQueries.push(args);
      return args?.where?.id === 'c1' ? { id: 'c1', phone: o.storedPhone ?? '0500000000' } : null;
    },
    'customer.create': (args) => { written.push(args.data); return { id: 'c-new', ...args.data }; },
    'customer.update': (args) => { written.push(args.data); return { id: 'c1', ...args.data }; },
  };
  return { written, customerQueries };
}

// ═══ الإنشاء ═══

test('الإنشاء: الجوال اختياريّ — الغائب وnull والفارغ والمسافات تُحفظ \'\' (العمود NOT NULL)', async () => {
  for (const phone of [undefined, null, '', '   ']) {
    const w = world();
    const r = await call('POST', '/api/customers', { name: 'بقالة', ...(phone !== undefined && { phone }) });
    assert.equal(r.status, 201, `${JSON.stringify(phone)}: ${JSON.stringify(r.body)}`);
    assert.equal(w.written.length, 1);
    assert.equal(w.written[0].phone, '', `${JSON.stringify(phone)} يُكتب ''`);
  }
});

test('الإنشاء: بلا حدٍّ أدنى ولا صيغة — يُقصّ طرفاه ويُحفظ كما كُتب', async () => {
  for (const [sent, stored] of [['1', '1'], ['12345678', '12345678'], [' 0500 ', '0500'], ['هاتف المحل', 'هاتف المحل'], ['+966 50 123', '+966 50 123']]) {
    const w = world();
    const r = await call('POST', '/api/customers', { name: 'بقالة', phone: sent });
    assert.equal(r.status, 201, `${sent}: ${JSON.stringify(r.body)}`);
    assert.equal(w.written[0].phone, stored);
  }
});

test('الإنشاء: سقف الأمان ٣٠ حرفاً بعد القصّ — ٣٠ تمرّ و٣١ ⇒ 400 على phone بلا كتابة', async () => {
  assert.equal(customersModule.CUSTOMER_PHONE_MAX, 30);
  const ok = world();
  assert.equal((await call('POST', '/api/customers', { name: 'بقالة', phone: `  ${'5'.repeat(30)}  ` })).status, 201);
  assert.equal(ok.written[0].phone, '5'.repeat(30));
  const bad = world();
  const r = await call('POST', '/api/customers', { name: 'بقالة', phone: '5'.repeat(31) });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(r.body.errors?.phone, 'الخطأ على phone');
  assert.equal(bad.written.length, 0);
  // والجوال نصٌّ كما كان: الرقم المجرّد يُرفض لا يُحوَّل بصمت
  const num = world();
  assert.equal((await call('POST', '/api/customers', { name: 'بقالة', phone: 501234567 })).status, 400);
  assert.equal(num.written.length, 0);
});

test('الرفع المؤجَّل من صندوق المندوب (clientRef) بلا جوال يُنشأ، والتكرار بـclientRef وحده لا بالجوال', async () => {
  const w = world({ user: REP });
  const clientRef = '6f1c2a9e-3b7d-4c2e-9a51-2f0e8d7c4b10';
  const r = await call('POST', '/api/customers', { name: 'بقالة الحي', phone: '', clientRef });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.written[0].phone, '');
  assert.equal(w.written[0].createdBySalesRepId, 'rep-1');
  // استعلام التكرار الوحيد قبل الإنشاء بـclientRef — لا يُسأل عن عميلٍ بالجوال (الفارغ لا يساوي فارغاً آخر)
  const dedupe = w.customerQueries.filter((q) => q?.where?.clientRef);
  assert.equal(dedupe.length, 1);
  assert.deepEqual(dedupe[0].where, { tenantId: TENANT, clientRef });
  assert.ok(w.customerQueries.every((q) => !('phone' in (q?.where ?? {}))), 'لا مطابقة بالجوال');
});

// ═══ التعديل ═══

test('التعديل: الغائب لا يمسّ الجوال، وnull والفارغ يمسحانه إلى \'\'، والقصير يُقبل', async () => {
  const w = world();
  assert.equal((await call('PUT', '/api/customers/c1', { name: 'اسم جديد' })).status, 200);
  assert.equal(w.written[0].phone, undefined, 'تعديلٌ بلا phone لا يكتبه');
  assert.equal((await call('PUT', '/api/customers/c1', { phone: null })).status, 200);
  assert.equal(w.written[1].phone, '');
  assert.equal((await call('PUT', '/api/customers/c1', { phone: '  ' })).status, 200);
  assert.equal(w.written[2].phone, '');
  assert.equal((await call('PUT', '/api/customers/c1', { phone: '5' })).status, 200);
  assert.equal(w.written[3].phone, '5');
  // والمندوب كذلك (تطبيق المندوب يرسل الجوال مع تعديل العميل)
  const rep = world({ user: REP });
  const r = await call('PUT', '/api/customers/c1', { name: 'بقالة', phone: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(rep.written[0].phone, '');
});

test('التعديل: جوالٌ محفوظ أطول من السقف يعود مع النموذج كما هو ⇒ يُقبل ويُترك بلا كتابة، والجديد الأطول ⇒ 400', async () => {
  const stored = '0501234567 / 0551234567 / 0561234567';
  assert.ok(stored.length > 30);
  const w = world({ storedPhone: stored });
  const same = await call('PUT', '/api/customers/c1', { name: 'اسم جديد', phone: ` ${stored} ` });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(w.written[0].name, 'اسم جديد');
  assert.equal(w.written[0].phone, undefined, 'الجوال المحفوظ لا يُعاد كتابته');
  // سؤال الوجود يحمل الجوال المحفوظ للمقارنة
  assert.deepEqual(w.customerQueries[0].select, { id: true, phone: true });

  const changed = await call('PUT', '/api/customers/c1', { name: 'اسم جديد', phone: `${stored}9` });
  assert.equal(changed.status, 400, JSON.stringify(changed.body));
  assert.ok(changed.body.errors?.phone);
  assert.equal(w.written.length, 1, 'الجديد الأطول لا يُكتب');
  // واستبداله بقصير يمرّ
  assert.equal((await call('PUT', '/api/customers/c1', { phone: '0501234567' })).status, 200);
  assert.equal(w.written[1].phone, '0501234567');
});

// ═══ البحث: الجوال الفارغ لا يطابق بحثاً ═══

test('البحث: نصّ البحث يُطابق الجوال بالاحتواء — والبحث الفارغ لا يُضيف شرطاً (فلا يطابق جوالاً فارغاً)', async () => {
  const seen: any[] = [];
  world();
  scripted['customer.findMany'] = (args) => { seen.push(args.where); return []; };
  assert.equal((await call('GET', '/api/customers?search=')).status, 200);
  assert.equal('OR' in seen[0], false);
  assert.equal((await call('GET', '/api/customers?search=05')).status, 200);
  assert.deepEqual(seen[1].OR.find((c: Record<string, unknown>) => 'phone' in c), { phone: { contains: '05' } });
});

// ═══ حارس نصّي ═══

test('customers.ts: لا حدّ أدنى لجوال العميل في المخطّط، والسقف وحده', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'customers.ts'), 'utf8');
  const schema = src.slice(src.indexOf('const customerSchema'), src.indexOf('});', src.indexOf('const customerSchema')));
  assert.doesNotMatch(schema, /phone: z\.string\(\)\.min\(/, 'عاد الحدّ الأدنى');
  assert.match(schema, /phone: z\.string\(\)\.trim\(\)\.max\(CUSTOMER_PHONE_MAX\)\.nullish\(\),/);
});
