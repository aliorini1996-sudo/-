// PUT /api/customers/:id بلا رفض (أمر المالك ٩ نوفمبر ٢٠٢٦: «حُذف من قبل أو لم يُحذف — اقبله») — معالجات العملاء الحقيقية فوق
// Prisma مزيّف (بلا قاعدة بيانات ولا شبكة). موصل ERP يحتفظ بمعرّفات عملاء قديمة؛ PUT لمعرّفٍ لا يجده الخادم كان 404 فتضيع البيانات:
//   • المعرّف غير مستعمل في أي شركة ⇒ 201 ويُنشأ العميل بالمعرّف نفسه في شركة الطالب بقواعد POST (الاسم البديل، الجوال ''…).
//   • المعرّف لعميل شركة أخرى ⇒ 201 بمعرّف جديد وتحذير CUSTOMER_ID_REASSIGNED، ولا يُمسّ عميل الأخرى.
//   • عميل الشركة نفسها خارج نطاق الطالب ⇒ كما كان (404، أو 403 بلا «تعديل العميل») بلا إنشاء.
//   • صلاحيات المندوب: «إضافة عميل» للإنشاء و«تعديل العميل» للتعديل؛ والعميل القائم يُعدَّل كما كان حرفياً.
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

let calls: { op: string; args: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let scripted: Record<string, (args: any) => unknown> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    calls.push({ op: `${model}.${method}`, args });
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
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };
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

type Reply = { status: number; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function put(url: string, body: unknown): Promise<Reply> {
  const s = await startServer();
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method: 'PUT', path: url, agent: false,
      headers: { connection: 'close', 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

type Row = { id: string; tenantId: string; phone?: string; assignments?: string[] };

/**
 * عالمٌ بصفوف عملاء في شركتين: c1 في T1 (مُسنَد لـrep-1)، وc-hidden في T1 غير مُسنَد، وc-foreign في T2.
 * findFirst يحترم الشركة والإسناد (عزل المناديب)، وfindUnique بالمعرّف وحده (كل الشركات)
 */
function world(o: { user?: User; rep?: { canAddCustomer?: boolean; canEditCustomer?: boolean }; isolation?: boolean; collect?: boolean } = {}) {
  currentUser = o.user ?? ADMIN;
  calls = [];
  const rows: Row[] = [
    { id: 'c1', tenantId: TENANT, phone: '0500000000', assignments: ['rep-1'] },
    { id: 'c-hidden', tenantId: TENANT, phone: '0500000001', assignments: [] },
    { id: 'c-foreign', tenantId: 'T2', phone: '0500000002', assignments: [] },
  ];
  const created: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const updated: { where: unknown; data: Record<string, unknown> }[] = [];
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true, canEditCustomer: true, requireCustomerProximity: false, ...o.rep }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'companySettings.findUnique': () => ({ customerIsolationEnabled: o.isolation === true }),
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: o.collect === true, settings: { countryCode: 'SA', zatcaPhase2StartedAt: null } }),
    'customer.findFirst': (args) => {
      const w = args?.where ?? {};
      if (w.clientRef) return null;
      const r = rows.find(x => x.id === w.id && x.tenantId === w.tenantId
        && (!w.assignments || (x.assignments ?? []).includes(w.assignments.some.salesRepId)));
      return r ? { id: r.id, phone: r.phone } : null;
    },
    'customer.findUnique': (args) => {
      const r = rows.find(x => x.id === args?.where?.id);
      return r ? { tenantId: r.tenantId } : null;
    },
    'customer.create': (args) => {
      const row = { id: args.data.id ?? `uuid-${created.length + 1}`, ...args.data };
      created.push(args.data);
      rows.push({ id: row.id, tenantId: row.tenantId, phone: row.phone, assignments: [] });
      return row;
    },
    'customer.update': (args) => { updated.push({ where: args.where, data: args.data }); return { id: args.where.id, ...args.data }; },
  };
  const ops = () => calls.map(c => c.op);
  return { rows, created, updated, ops };
}

// ═══ الإنشاء بالمعرّف ═══

test('PUT لمعرّفٍ لا يوجد في أي شركة ⇒ 201 created ويُنشأ العميل بالمعرّف نفسه في شركة الطالب بقواعد POST (الاسم البديل والجوال \'\')', async () => {
  for (const user of [ADMIN, API_KEY]) {
    const w = world({ user });
    const r = await put('/api/customers/erp-77', { name: '', businessName: 'بقالة الموصل', city: 'الرياض', creditLimit: '500', priceListId: 'L-OTHER', lat: 999 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.success, true);
    assert.equal(r.body.created, true);
    assert.equal(r.body.data.id, 'erp-77');
    assert.equal('warnings' in r.body, false, 'بلا تحذير');
    assert.equal(w.created.length, 1);
    const d = w.created[0];
    assert.deepEqual(
      [d.id, d.tenantId, d.name, d.phone, d.city, d.creditLimit, d.priceListId, d.lat, d.email, d.channel],
      ['erp-77', TENANT, 'بقالة الموصل', '', 'الرياض', 500, null, null, null, null],
    );
    assert.equal('createdBySalesRepId' in d, false, 'الإدارة ليست منشئاً مندوباً');
    assert.equal(w.updated.length, 0, 'لا تعديل');
    // السؤال عن المعرّف في كل الشركات بالمفتاح وحده
    const holderQ = calls.find(c => c.op === 'customer.findUnique');
    assert.deepEqual(holderQ?.args.where, { id: 'erp-77' });
  }
});

test('PUT لمعرّف عميل شركة أخرى ⇒ 201 بمعرّف جديد وتحذير CUSTOMER_ID_REASSIGNED، ولا يُمسّ عميل الأخرى', async () => {
  const w = world();
  const r = await put('/api/customers/c-foreign', { name: 'عميل منقول', phone: '0555' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  assert.notEqual(r.body.data.id, 'c-foreign');
  assert.equal(r.body.data.tenantId, TENANT);
  assert.equal('id' in w.created[0], false, 'المعرّف من القاعدة لا من الطلب');
  assert.equal(w.created[0].name, 'عميل منقول');
  assert.deepEqual(r.body.warnings.map((x: { code: string; requestedId: string }) => [x.code, x.requestedId]), [['CUSTOMER_ID_REASSIGNED', 'c-foreign']]);
  assert.equal(w.updated.length, 0, 'عميل الشركة الأخرى لا يُعدَّل');
  assert.equal(w.rows.find(x => x.id === 'c-foreign')!.tenantId, 'T2');
});

test('معرّفٌ لا يصلح رابطاً (مسافة) أو اسم مسار ثابت ⇒ يُنشأ بمعرّف جديد مع التحذير نفسه — لا رفض', async () => {
  for (const [url, requestedId] of [['/api/customers/ERP%20001', 'ERP 001'], ['/api/customers/locations', 'locations']]) {
    const w = world();
    const r = await put(url, { name: 'بقالة' });
    assert.equal(r.status, 201, `${url}: ${JSON.stringify(r.body)}`);
    assert.equal('id' in w.created[0], false);
    assert.deepEqual(r.body.warnings.map((x: { code: string; requestedId: string }) => [x.code, x.requestedId]), [['CUSTOMER_ID_REASSIGNED', requestedId]]);
  }
});

test('الإنشاء بالمعرّف: تاريخ جهازٍ لا يُقرأ يُهمل، وبوابة المشتري كالإنشاء (customerId: null) — الخطأ تنبيه يُدمج في warnings', async () => {
  const w = world({ collect: true });
  const r = await put('/api/customers/erp-tax', { name: 'مؤسسة', taxNumber: '123', addrBuildingNo: '12', clientCreatedAt: 'ليس تاريخاً' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.id, 'erp-tax');
  const d = w.created[0];
  assert.equal(d.clientCreatedAt, undefined);
  assert.equal(d.taxNumber, '123', 'الرقم الضريبي (قديم) يُحفظ كما كُتب');
  assert.equal('addrBuildingNo' in d, false, 'حقل المرحلة الثانية الخاطئ يُهمل');
  assert.deepEqual(r.body.warnings.map((x: { field: string }) => x.field).sort(), ['addrBuildingNo', 'taxNumber']);
  // البوابة لا تسأل عن صفٍّ محفوظ (عميل جديد): استعلام العميل الوحيد هو سؤال الوجود
  assert.equal(calls.filter(c => c.op === 'customer.findFirst').length, 1);
});

test('سباق: طلبٌ موازٍ أنشأ المعرّف نفسه بين السؤال والكتابة (P2002 على id) ⇒ يُعاد البحث فيُعدَّل لا 500 ولا تكرار', async () => {
  const w = world();
  scripted['customer.create'] = (args) => {
    w.rows.push({ id: args.data.id, tenantId: TENANT, phone: '0500' });
    throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002', meta: { target: ['id'] } });
  };
  const r = await put('/api/customers/erp-race', { name: 'بقالة' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, undefined);
  assert.equal(w.updated.length, 1);
  assert.deepEqual(w.updated[0].where, { id: 'erp-race' });
});

// ═══ الصلاحيات والعزل ═══

test('المندوب: الإنشاء بالمعرّف يحتاج «إضافة عميل» ويُوثَّق منشئاً ويُسنَد له، ونوع السعر يُسقط كالإنشاء', async () => {
  const w = world({ user: REP, rep: { canAddCustomer: true, canEditCustomer: false } });
  const r = await put('/api/customers/erp-rep', { name: 'بقالة الحي', priceListId: 'L-W' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].id, 'erp-rep');
  assert.equal(w.created[0].createdBySalesRepId, 'rep-1');
  assert.equal('priceListId' in w.created[0], false);
  const assign = calls.find(c => c.op === 'customerAssignment.upsert');
  assert.deepEqual(assign?.args.create, { tenantId: TENANT, customerId: 'erp-rep', salesRepId: 'rep-1', source: 'AUTO' });
  // وبلا «تعديل العميل» لا يعدّل عميلاً قائماً
  const e = await put('/api/customers/c1', { name: 'تغيير' });
  assert.deepEqual([e.status, e.body.message], [403, 'ليس لديك صلاحية تعديل العملاء']);
  assert.equal(w.updated.length, 0);

  // بلا «إضافة عميل»: المعرّف المجهول 403 بلا إنشاء، والقائم يُعدَّل كما كان
  const n = world({ user: REP, rep: { canAddCustomer: false, canEditCustomer: true } });
  const denied = await put('/api/customers/erp-rep2', { name: 'بقالة' });
  assert.deepEqual([denied.status, denied.body.message], [403, 'ليس لديك صلاحية إضافة عملاء']);
  assert.equal(n.created.length, 0);
  assert.equal((await put('/api/customers/c1', { name: 'تغيير' })).status, 200);
  assert.equal(n.updated.length, 1);

  // بلا الصلاحيتين: 403 قبل أي سؤال عن العميل (كما كان)
  const none = world({ user: REP, rep: { canAddCustomer: false, canEditCustomer: false } });
  const r0 = await put('/api/customers/erp-x', { name: 'بقالة' });
  assert.deepEqual([r0.status, r0.body.message], [403, 'ليس لديك صلاحية تعديل العملاء']);
  assert.equal(none.ops().some(op => op.startsWith('customer.')), false);
});

test('عزل العملاء: عميل الشركة نفسها خارج نطاق المندوب ⇒ 404 كما كان (و403 بلا «تعديل العميل») — لا إنشاء ولا كشف', async () => {
  const w = world({ user: REP, isolation: true });
  const r = await put('/api/customers/c-hidden', { name: 'محاولة' });
  assert.deepEqual([r.status, r.body.message], [404, 'العميل غير موجود']);
  assert.equal(w.created.length, 0);
  assert.equal(w.updated.length, 0);
  const noEdit = world({ user: REP, isolation: true, rep: { canAddCustomer: true, canEditCustomer: false } });
  const r2 = await put('/api/customers/c-hidden', { name: 'محاولة' });
  assert.equal(r2.status, 403);
  assert.equal(noEdit.created.length, 0);
  // والمُسنَد له يُعدَّل كما كان
  const ok = world({ user: REP, isolation: true });
  assert.equal((await put('/api/customers/c1', { name: 'تغيير' })).status, 200);
  assert.equal(ok.updated.length, 1);
});

// ═══ العميل القائم كما كان ═══

test('العميل القائم: PUT يعدّله كما كان — 200 بلا created ولا سؤال عن المعرّف في الشركات ولا إنشاء', async () => {
  const w = world();
  const r = await put('/api/customers/c1', { name: 'اسم جديد', city: 'جدة' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, undefined);
  assert.equal(r.body.data.id, 'c1');
  assert.deepEqual(w.updated[0].where, { id: 'c1' });
  assert.equal(w.updated[0].data.name, 'اسم جديد');
  assert.equal(w.updated[0].data.city, 'جدة');
  assert.equal(w.updated[0].data.phone, undefined, 'تعديلٌ بلا phone لا يكتبه');
  assert.deepEqual(w.ops().filter(op => op.startsWith('customer.')), ['customer.findFirst', 'customer.update']);
});
