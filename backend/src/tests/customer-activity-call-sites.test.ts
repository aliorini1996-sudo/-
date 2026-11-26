// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦) — مواضع كتابة الأحداث غير المالية فوق Prisma مزيّف (بلا قاعدة ولا شبكة):
//   • الطبقة المشتركة services/customerActivityEvents.ts: تقسيم تعديل العميل إلى أحداثه، فرق محطّات خطّ السير، التجميع لكل عميل،
//     الكتابة في المعاملة (دفعات ٥٠٠، تخطّي المقبض المزيّف، رمي خطأ القاعدة) وبعد الالتزام (لا يُفشل إجراءً تمّ)، والفاعل بلا رمي.
//   • حدث الإضافة مرّةً واحدة في معاملة الإنشاء (services/customerNumber.ts) وحدث الاستيراد دفعةً واحدة.
//   • أسعار العملاء الخاصة لصنف، وأثر حذف المندوب على عملائه، ومطابقة طلب المنيو بعميله.
//   • المسارات الحقيقية: إضافة العميل وتعديله وحذفه وأسعاره الخاصة (routes/customers.ts)، والإسناد التلقائي (customerScope)، وإسناد
//     العملاء للمندوب وحذفه (routes/salesReps.ts) — الحدث في معاملة الإجراء حين لها معاملة، ولما تغيّر فعلاً وحده.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ Prisma مزيّف: كل نموذجٍ يسجّل نداءه وهل كان داخل معاملة، والمعدّ سلفاً (scripted) يجيب ═══

type Call = { op: string; args: any; inTx: boolean };
let calls: Call[] = [];
let scripted: Record<string, (args: any) => unknown> = {};
let inTx = 0;
/** صفوف الإدراج في سجلّ العميل بترتيبها، ومعها هل كُتبت داخل معاملة */
const activity = () => calls.filter((c) => c.op === 'customerActivity.createMany')
  .flatMap((c) => (c.args.data as Record<string, any>[]).map((d) => ({ ...d, inTx: c.inTx })));
const opIndex = (op: string) => calls.findIndex((c) => c.op === op);

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    calls.push({ op: `${model}.${method}`, args, inTx: inTx > 0 });
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(args) : defaultFor(method);
  },
});
let rawProducts: { id: string; unit: string }[] = [];
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx++;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx--; }
      };
    }
    if (key === '$queryRaw') {
      return async (strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        calls.push({ op: '$queryRaw', args: { sql }, inTx: inTx > 0 });
        // قفل أسس الأصناف (lockBases): الأساس كما رآه المحرّر — فلا يُرفض الحفظ
        if (/FROM products/.test(sql)) return rawProducts.map((p) => ({ id: p.id, unit: p.unit, lotTracked: false, lotTrackedSince: null }));
        return [];
      };
    }
    if (key === '$executeRaw') return async () => 0;
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; name?: string; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, name: 'مدير' };
const REP: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT, name: 'خالد' };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
/* eslint-disable @typescript-eslint/no-var-requires */
const realScope = require('../services/adminScope') as typeof import('../services/adminScope');
stub('services/adminScope', {
  ...realScope,
  adminRepFilter: async () => ({}), adminCustomerFilter: async () => ({}), scopedRecordWhere: async () => ({}),
});
// حذف العميل بمحرّك الحذف النهائي — خارج هذا الاختبار (يختبره owner-purge)
const realPurge = require('../services/ownerPurge') as typeof import('../services/ownerPurge');
stub('services/ownerPurge', { ...realPurge, purgeInTx: async () => { calls.push({ op: 'purgeInTx', args: null, inTx: inTx > 0 }); return { counts: {}, nullCounts: {} }; } });

const ev = require('../services/customerActivityEvents') as typeof import('../services/customerActivityEvents');
const cn = require('../services/customerNumber') as typeof import('../services/customerNumber');
const cat = require('../services/customerActivityCatalog') as typeof import('../services/customerActivityCatalog');
const { ensureAssignment } = require('../services/customerScope') as typeof import('../services/customerScope');
const customersRouter = (require('../routes/customers') as typeof import('../routes/customers')).default;
const salesRepsRouter = (require('../routes/salesReps') as typeof import('../routes/salesReps')).default;
/* eslint-enable @typescript-eslint/no-var-requires */

function reset(): void { calls = []; scripted = {}; inTx = 0; rawProducts = []; }

/** يشغّل مكدّس المسار نفسه (حرّاس الموجّه العامة خارج الاختبار — الهويّة في req.user) */
async function call(router: unknown, method: string, p: string, req: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const layer = (router as { stack: any[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, ...req };
  for (const h of layer.route.stack as any[]) {
    let passed = false;
    let err: unknown;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}

const META = { actor: { kind: 'ADMIN' as const, id: 'admin-1', name: 'مدير' }, source: 'web' };

// ═══ الطبقة المشتركة ═══

test('customerUpdateEvents: الحالة والموقع ونوع السعر وبيانات الفوترة كلٌّ بحدثه، والباقي «تعديل» بقائمة التغييرات — ولا تغيير ⇒ لا حدث', () => {
  const before = { id: 'c1', name: 'أ', status: 'ACTIVE', lat: 24.1, lng: 46.1, priceListId: null, taxNumber: null, city: 'جدة', balance: 10 };
  const after = { id: 'c1', name: 'ب', status: 'INACTIVE', lat: 24.2, lng: 46.2, priceListId: 'L1', taxNumber: '300000000000003', city: 'جدة', balance: 99 };
  const out = ev.customerUpdateEvents(before, after, { tenantId: TENANT, customerId: 'c1', meta: META, priceListNames: new Map([['L1', 'الجملة']]) });
  assert.deepEqual(out.map((e) => e.action), ['CUSTOMER_STATUS_CHANGED', 'CUSTOMER_LOCATION_SET', 'CUSTOMER_PRICE_LIST_CHANGED', 'CUSTOMER_TAX_DATA_UPDATED', 'CUSTOMER_UPDATED']);
  for (const e of out) assert.deepEqual([e.tenantId, e.customerId, e.refType, e.refId, e.actor.kind, e.source], [TENANT, 'c1', 'CUSTOMER', 'c1', 'ADMIN', 'web']);
  assert.deepEqual(out[0].data, { oldStatus: 'ACTIVE', newStatus: 'INACTIVE' });
  assert.deepEqual(out[1].data, { from: { lat: 24.1, lng: 46.1 }, to: { lat: 24.2, lng: 46.2 } });
  assert.deepEqual(out[2].data, { from: null, to: 'L1', toName: 'الجملة' });
  assert.deepEqual(out[4].data, { changes: [{ field: 'name', from: 'أ', to: 'ب' }] }, 'الرصيد لا يدخل أبداً');
  assert.deepEqual(ev.customerUpdateEvents(before, { ...before, balance: 500 }, { tenantId: TENANT, customerId: 'c1', meta: META }), [], 'لا تغيير متتبَّع');
  const tax = ev.customerUpdateEvents({ taxNumber: null, businessName: 'أ' }, { taxNumber: '3', businessName: 'ب' }, { tenantId: TENANT, customerId: 'c1', meta: META, taxOnly: true });
  assert.deepEqual(tax.map((e) => e.action), ['CUSTOMER_TAX_DATA_UPDATED'], 'مسار الفوترة: حدثٌ واحد');
  assert.equal((tax[0].data!.changes as unknown[]).length, 2);
  assert.deepEqual(ev.priceListIdsChanged({ priceListId: 'A' }, { priceListId: 'B' }), ['A', 'B']);
  assert.deepEqual(ev.priceListIdsChanged({ priceListId: 'A' }, { priceListId: 'A' }), []);
});

test('diffRouteStops: من دخل ومن خرج وحده — الباقي بلا حدث، وتغيّر المندوب يُخرج من خطّ القديم', () => {
  const old = [
    { customerId: 'c1', routeId: 'r1', routeName: 'أ', salesRepId: 'R1' },
    { customerId: 'c2', routeId: 'r1', routeName: 'أ', salesRepId: 'R1' },
    { customerId: 'c2', routeId: 'r9', routeName: 'ب', salesRepId: 'R1' },
  ];
  const d = ev.diffRouteStops(old, ['c2', 'c3'], 'R1');
  assert.deepEqual(d.added, ['c3']);
  assert.deepEqual(d.removed.map((s) => s.customerId), ['c1']);
  const moved = ev.diffRouteStops(old, ['c1'], 'R2');
  assert.deepEqual(moved.added, ['c1']);
  assert.deepEqual(moved.removed.map((s) => s.customerId), ['c1', 'c2'], 'عميلٌ مرّةً لكل مندوب');
});

test('countByCustomer وperCustomerEvents: حدثٌ مجمَّع واحد لكل عميل بعدده', () => {
  const counts = ev.countByCustomer([{ customerId: 'a', _count: { _all: 3 } }, { customerId: 'b', _count: 2 }, { customerId: 'a' }, { customerId: null }]);
  assert.deepEqual([...counts], [['a', 4], ['b', 2]]);
  const out = ev.perCustomerEvents(TENANT, counts, 'INVOICE_REASSIGNED', META, { kind: 'REP' }, 'INVOICE');
  assert.deepEqual(out.map((e) => [e.customerId, e.action, e.refType, e.data]), [
    ['a', 'INVOICE_REASSIGNED', 'INVOICE', { kind: 'REP', count: 4 }],
    ['b', 'INVOICE_REASSIGNED', 'INVOICE', { kind: 'REP', count: 2 }],
  ]);
});

test('recordActivityInTx: المقبض المزيّف بلا جدول يُتخطّى، والمدخل بلا عميل يُسقط، ودفعات ٥٠٠، وخطأ القاعدة يُرمى — وrecordActivityAfter لا يرمي', async () => {
  await ev.recordActivityInTx({}, { tenantId: TENANT, customerId: 'c1', action: 'OTHER', actor: META.actor });
  const batches: number[] = [];
  const db = { customerActivity: { async createMany(a: { data: unknown[] }) { batches.push(a.data.length); return { count: a.data.length }; } } };
  const many = Array.from({ length: 1201 }, (_, i) => ({ tenantId: TENANT, customerId: `c${i}`, action: 'OTHER' as const, actor: META.actor }));
  await ev.recordActivityInTx(db, [...many, null, { tenantId: TENANT, customerId: '', action: 'OTHER' as const, actor: META.actor }]);
  assert.deepEqual(batches, [500, 500, 201]);
  const broken = { customerActivity: { async createMany() { throw new Error('db down'); } } };
  await assert.rejects(ev.recordActivityInTx(broken, many[0]), /db down/, 'في المعاملة: الخطأ يُلغيها');
  const orig = console.error;
  console.error = () => {};
  try { await ev.recordActivityAfter(broken, many[0]); } finally { console.error = orig; }
});

test('activityMeta: الفاعل من الهوية ولا يرمي، والمصدر الصريح يغلب، وبلا طلبٍ «النظام»', () => {
  assert.deepEqual(ev.activityMeta({ user: REP } as never), { actor: { kind: 'REP', id: 'rep-1', name: 'خالد' }, source: 'rep' });
  assert.deepEqual(ev.activityMeta({ user: ADMIN, headers: {} } as never, 'import').source, 'import');
  assert.equal(ev.activityMeta({ user: { ...ADMIN, apiKeyId: 'k1' }, headers: {} } as never).actor.kind, 'API');
  assert.equal(ev.activityMeta(null).actor.kind, 'SYSTEM');
  assert.equal(ev.activityMeta({ get user() { throw new Error('x'); } } as never).actor.kind, 'SYSTEM');
});

test('حدث الإضافة في معاملة الإنشاء بعد الإدراج (CUSTOMER) — وnull بلا حدث، والدفعة CUSTOMER_IMPORTED بإدراجٍ واحد', async () => {
  reset();
  const at = new Date('2026-11-20T08:00:00Z');
  scripted['customer.create'] = (a) => ({ id: 'c-new', createdAt: at, ...a.data });
  const tx = prismaFake as never;
  await cn.createNumberedCustomer(tx, TENANT, { name: 'بقالة', phone: '' }, { ...META, data: { via: 'put' } });
  assert.ok(opIndex('customer.create') < opIndex('customerActivity.createMany'), 'الحدث بعد الإدراج');
  const [a] = activity();
  assert.deepEqual([a.action, a.customerId, a.refType, a.refId, a.actorKind, a.data.name, a.data.via], ['CUSTOMER_CREATED', 'c-new', 'CUSTOMER', 'c-new', 'ADMIN', 'بقالة', 'put']);
  assert.equal(new Date(a.at).getTime(), at.getTime(), 'لحظة الإضافة لحظة إنشاء العميل');

  reset();
  await cn.createNumberedCustomer(prismaFake as never, TENANT, { name: 'بلا حدث', phone: '' }, null);
  assert.equal(activity().length, 0);

  reset();
  let k = 0;
  scripted['customer.create'] = (a) => ({ id: `c${++k}`, ...a.data });
  await cn.createNumberedCustomers(prismaFake as never, TENANT, [{ name: 'أ', phone: '' }, { name: 'ب', phone: '' }], { ...META, source: 'import' });
  assert.equal(calls.filter((c) => c.op === 'customerActivity.createMany').length, 1, 'إدراجٌ واحد');
  assert.deepEqual(activity().map((r) => [r.customerId, r.action, r.source]), [['c1', 'CUSTOMER_IMPORTED', 'import'], ['c2', 'CUSTOMER_IMPORTED', 'import']]);
});

test('productCustomerPriceEvents: حدثٌ لكل عميلٍ له سعرٌ خاصّ للصنف — الحذف بسعره، وتحويل الأساس بالسعر قبل وبعد', async () => {
  reset();
  scripted['customerPrice.findMany'] = () => [{ customerId: 'c1', price: 24 }, { customerId: 'c2', price: 12 }];
  scripted['product.findFirst'] = () => ({ name: 'ماء', unit: 'كرتون' });
  const del = await ev.productCustomerPriceEvents(prismaFake, TENANT, 'p1', META, { action: 'CUSTOMER_PRICE_REMOVED', reason: 'PRODUCT_DELETED' });
  assert.deepEqual(del.map((e) => [e.customerId, e.action, e.refType, e.refId, e.data!.price, e.data!.productName]), [
    ['c1', 'CUSTOMER_PRICE_REMOVED', 'PRICE', 'p1', 24, 'ماء'], ['c2', 'CUSTOMER_PRICE_REMOVED', 'PRICE', 'p1', 12, 'ماء'],
  ]);
  const conv = await ev.productCustomerPriceEvents(prismaFake, TENANT, 'p1', META, { action: 'CUSTOMER_PRICE_SET', reason: 'BASE_UNIT_CONVERTED', factor: 24, fromUnit: 'كرتون', toUnit: 'حبة' });
  assert.deepEqual([conv[0].data!.from, conv[0].data!.to, conv[0].data!.toUnit], [24, 1, 'حبة']);
  assert.deepEqual(await ev.productCustomerPriceEvents({}, TENANT, 'p1', META, { action: 'CUSTOMER_PRICE_REMOVED', reason: 'PRODUCT_DELETED' }), [], 'بلا جدول السجل لا قراءة');
});

test('repDeleteEvents: فواتير المندوب وسنداته إلى «بلا مندوب» وزياراته وإسناداته — حدثٌ مجمَّع لكل عميل', async () => {
  reset();
  scripted['invoice.groupBy'] = () => [{ customerId: 'c1', _count: { _all: 5 } }];
  scripted['receipt.groupBy'] = () => [{ customerId: 'c1', _count: { _all: 2 } }, { customerId: 'c2', _count: { _all: 1 } }];
  scripted['repVisit.groupBy'] = () => [{ customerId: 'c3', _count: { _all: 7 } }];
  scripted['customerAssignment.findMany'] = () => [{ customerId: 'c1' }, { customerId: 'c3' }];
  const out = await ev.repDeleteEvents(prismaFake, TENANT, { id: 'R1', name: 'خالد' }, META, 'REP_DELETED');
  assert.deepEqual(out.map((e) => [e.action, e.customerId, e.data!.count]), [
    ['INVOICE_REASSIGNED', 'c1', 5], ['RECEIPT_REASSIGNED', 'c1', 2], ['RECEIPT_REASSIGNED', 'c2', 1],
    ['VISIT_DELETED', 'c3', 7], ['CUSTOMER_UNASSIGNED', 'c1', 1], ['CUSTOMER_UNASSIGNED', 'c3', 1],
  ]);
  assert.equal(out[0].data!.fromRep, 'خالد');
  assert.equal(out[4].refId, 'R1', 'الإسناد بمرجع المندوب');
});

test('matchCatalogCustomer: مفتاحٌ لا يصلح بلا استعلام، والمطابق الأحدث بالمفتاح الكامل — وcatalogOrderEstimate بالضريبة', async () => {
  const db = { $queryRaw: async () => [
    { id: 'old', name: 'قديم', phone: '0501234567', createdAt: new Date('2026-01-01') },
    { id: 'new', name: 'جديد', phone: '+966 50 123 4567', createdAt: new Date('2026-06-01') },
    { id: 'other', name: 'آخر', phone: '0591234567', createdAt: new Date('2026-07-01') },
  ] } as never;
  assert.equal(await cat.matchCatalogCustomer(db, TENANT, '123'), null);
  assert.deepEqual(await cat.matchCatalogCustomer(db, TENANT, '966501234567'), { id: 'new', name: 'جديد' });
  assert.equal(cat.catalogOrderEstimate([{ qty: 2, unitPrice: 20, taxPct: 15 }, { qty: 3, unitPrice: 2.5, taxPct: 0 }]), 53.5);
});

test('ensureAssignment: الإسناد الجديد وحده حدث CUSTOMER_ASSIGNED بفاعل الطلب بعد الكتابة — والقائم بلا حدث', async () => {
  // «جديد» من الإدراج الذرّي نفسه (createMany skipDuplicates ⇒ count) لا من نافذةٍ زمنية (C13)
  reset();
  scripted['customerAssignment.createMany'] = () => ({ count: 1 });
  scripted['salesRep.findFirst'] = () => ({ name: 'خالد' });
  await ensureAssignment(TENANT, 'c1', 'rep-1', { actor: { kind: 'REP', id: 'rep-1', name: 'خالد' }, source: 'rep' });
  const [a] = activity();
  assert.deepEqual([a.action, a.customerId, a.refType, a.refId, a.actorKind, a.data.mode, a.data.repName], ['CUSTOMER_ASSIGNED', 'c1', 'ASSIGNMENT', 'rep-1', 'REP', 'AUTO', 'خالد']);
  assert.equal(calls.filter((c) => c.op === 'customerAssignment.upsert').length, 0, 'بلا upsert ونافذته');
  reset();
  scripted['customerAssignment.createMany'] = () => ({ count: 0 });
  await ensureAssignment(TENANT, 'c1', 'rep-1');
  assert.equal(activity().length, 0, 'إعادة رفعٍ لإسنادٍ قائم');
});

// ═══ مسارات العملاء ═══

test('POST /customers: حدث الإضافة داخل معاملة الإنشاء بفاعل الطلب، وإسناد المندوب حدثٌ بعد الالتزام', async () => {
  reset();
  scripted['customer.create'] = (a) => ({ id: 'c-new', createdAt: new Date(), ...a.data });
  let r = await call(customersRouter, 'post', '/', { user: ADMIN, body: { name: 'بقالة الأمل', phone: '0501111111' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let rows = activity();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].action, rows[0].customerId, rows[0].actorKind, rows[0].actorId, rows[0].inTx], ['CUSTOMER_CREATED', 'c-new', 'ADMIN', 'admin-1', true]);

  reset();
  scripted['salesRep.findUnique'] = () => ({ canAddCustomer: true });
  scripted['customer.create'] = (a) => ({ id: 'c-rep', createdAt: new Date(), ...a.data });
  scripted['customerAssignment.upsert'] = () => ({ id: 'as1', createdAt: new Date() });
  r = await call(customersRouter, 'post', '/', { user: REP, body: { name: 'محل جديد' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  rows = activity();
  // الإسناد بعد التزام الإنشاء — في معاملته الخاصة مع حدثه (services/customerScope.ts ensureAssignment)
  assert.deepEqual(rows.map((x) => [x.action, x.actorKind, x.inTx]), [['CUSTOMER_CREATED', 'REP', true], ['CUSTOMER_ASSIGNED', 'REP', true]]);
  assert.ok(opIndex('customer.create') < opIndex('customerAssignment.upsert'));
});

test('PUT /customers/:id: ما تغيّر فعلاً أحداثٌ بفاعل الطلب من صورة السؤال نفسه (بلا قراءةٍ زائدة) — والتعديل بلا تغيير لا حدث له', async () => {
  reset();
  const stored = { id: 'c1', name: 'قديم', phone: '0500000000', status: 'ACTIVE', city: 'جدة', lat: null, lng: null, priceListId: null };
  scripted['customer.findFirst'] = (a) => (a?.where?.id === 'c1' ? { ...stored } : null);
  scripted['customer.update'] = (a) => ({ ...stored, ...a.data, id: 'c1' });
  let r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c1' }, body: { name: 'جديد', status: 'INACTIVE' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.filter((c) => c.op.startsWith('customer.')).map((c) => c.op), ['customer.findFirst', 'customer.update']);
  assert.deepEqual(activity().map((x) => [x.action, x.customerId, x.actorKind]), [['CUSTOMER_STATUS_CHANGED', 'c1', 'ADMIN'], ['CUSTOMER_UPDATED', 'c1', 'ADMIN']]);
  assert.deepEqual(activity()[1].data.changes, [{ field: 'name', from: 'قديم', to: 'جديد' }]);

  reset();
  scripted['customer.findFirst'] = (a) => (a?.where?.id === 'c1' ? { ...stored } : null);
  scripted['customer.update'] = (a) => ({ ...stored, ...a.data, id: 'c1' });
  r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c1' }, body: { name: 'قديم', city: 'جدة' } });
  assert.equal(r.status, 200);
  assert.equal(activity().length, 0, 'صدى النموذج نفسه');
});

test('PUT /customers/:id/prices: الأسعار التي تغيّرت وحدها حدثٌ واحد في معاملة الحفظ', async () => {
  reset();
  rawProducts = [{ id: 'p1', unit: 'حبة' }, { id: 'p2', unit: 'حبة' }];
  scripted['customer.findFirst'] = () => ({ id: 'c1' });
  scripted['product.findMany'] = () => [{ id: 'p1', name: 'ماء', unit: 'حبة', baseConvertedAt: null }, { id: 'p2', name: 'عصير', unit: 'حبة', baseConvertedAt: null }];
  scripted['customerPrice.findMany'] = () => [{ productId: 'p1', price: 5 }, { productId: 'p2', price: 3 }];
  const r = await call(customersRouter, 'put', '/:id/prices', { user: ADMIN, params: { id: 'c1' }, body: { prices: [{ productId: 'p1', price: 5 }, { productId: 'p2', price: 4 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = activity();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].action, rows[0].refType, rows[0].refId, rows[0].inTx], ['CUSTOMER_PRICE_SET', 'PRICE', 'p2', true]);
  assert.deepEqual(rows[0].data.items, [{ productId: 'p2', productName: 'عصير', from: 3, to: 4 }]);
  // السعر الذي لم يتغيّر لا يُعاد كتابته (يبقى طابعه تاريخَ آخر تغييرٍ فعليّ — C11)
  assert.deepEqual(calls.filter((c) => c.op === 'customerPrice.upsert').map((c) => [c.args.where.customerId_productId.productId, c.args.update.price]), [['p2', 4]]);
});

test('PUT /customers/:id/prices: تغيّر أكثر من صنف ⇒ سطرٌ لكل صنفٍ مرجعه الصنف (يطابقه القارئ بسطر ميلاده) — والصفّ المكرّر يكتب الأخير مرّةً', async () => {
  reset();
  rawProducts = [{ id: 'p1', unit: 'حبة' }, { id: 'p2', unit: 'حبة' }, { id: 'p3', unit: 'حبة' }];
  scripted['customer.findFirst'] = () => ({ id: 'c1' });
  scripted['product.findMany'] = () => [
    { id: 'p1', name: 'ماء', unit: 'حبة', baseConvertedAt: null }, { id: 'p2', name: 'عصير', unit: 'حبة', baseConvertedAt: null },
    { id: 'p3', name: 'حليب', unit: 'حبة', baseConvertedAt: null },
  ];
  scripted['customerPrice.findMany'] = () => [{ productId: 'p1', price: 5 }, { productId: 'p2', price: 3 }];
  const r = await call(customersRouter, 'put', '/:id/prices', {
    user: ADMIN, params: { id: 'c1' }, body: { prices: [{ productId: 'p1', price: 6 }, { productId: 'p2', price: 3 }, { productId: 'p3', price: 2 }, { productId: 'p1', price: 7 }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = activity();
  assert.deepEqual(rows.map((x) => [x.action, x.refType, x.refId, x.inTx]), [['CUSTOMER_PRICE_SET', 'PRICE', 'p1', true], ['CUSTOMER_PRICE_SET', 'PRICE', 'p3', true]]);
  assert.deepEqual(rows.map((x) => x.data.items), [[{ productId: 'p1', productName: 'ماء', from: 5, to: 7 }], [{ productId: 'p3', productName: 'حليب', from: null, to: 2 }]]);
  assert.deepEqual(calls.filter((c) => c.op === 'customerPrice.upsert').map((c) => [c.args.where.customerId_productId.productId, c.args.update.price]), [['p1', 7], ['p3', 2]]);
});

test('DELETE /customers/:id: لا حدث حذف (سجلّه يُحذف معه بالمحرّك — قرار المالك ٢٧ نوفمبر) والحذف في معاملة — والمرفوض لمستنداته بلا حدث', async () => {
  reset();
  scripted['customer.findFirst'] = () => ({ id: 'c1', name: 'بقالة', number: 12, code: 'X1' });
  let r = await call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(activity().length, 0, 'لا حدث CUSTOMER_DELETED — السجلّ يُحذف مع العميل (customer-activity-delete.test.ts)');
  assert.ok(opIndex('purgeInTx') >= 0 && calls[opIndex('purgeInTx')].inTx, 'الحذف بالمحرّك داخل المعاملة');

  reset();
  scripted['customer.findFirst'] = () => ({ id: 'c1', name: 'بقالة', number: 12, code: 'X1' });
  scripted['invoice.count'] = () => 3;
  r = await call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c1' } });
  assert.equal(r.status, 409);
  assert.equal(activity().length, 0);
});

// ═══ المناديب ═══

test('PUT /sales-reps/:id/customers: الإسناد الجديد والمنزوع فعلاً وحدهما حدثان في معاملة الكتابة', async () => {
  reset();
  scripted['salesRep.findFirst'] = () => ({ id: 'R1', name: 'خالد' });
  scripted['customer.findMany'] = () => [{ id: 'c2' }, { id: 'c3' }];
  // c1 مسنَدٌ (يُنزع)، c3 مسنَدٌ سلفاً (لا حدث إضافة)، c2 جديد، c9 لم يكن مسنَداً (لا حدث نزع)
  scripted['customerAssignment.findMany'] = () => [{ customerId: 'c1' }, { customerId: 'c3' }];
  const r = await call(salesRepsRouter, 'put', '/:id/customers', { user: ADMIN, params: { id: 'R1' }, body: { add: ['c2', 'c3'], remove: ['c1', 'c9'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(activity().map((x) => [x.action, x.customerId, x.refId, x.data.repName, x.inTx]), [
    ['CUSTOMER_UNASSIGNED', 'c1', 'R1', 'خالد', true], ['CUSTOMER_ASSIGNED', 'c2', 'R1', 'خالد', true],
  ]);
});

test('DELETE /sales-reps/:id: أثر الحذف على كل عميل يُقرأ قبل التفريغ ويُكتب في معاملة الحذف', async () => {
  reset();
  scripted['salesRep.findFirst'] = () => ({ id: 'R1', name: 'خالد' });
  scripted['invoice.groupBy'] = () => [{ customerId: 'c1', _count: { _all: 4 } }];
  scripted['repVisit.groupBy'] = () => [{ customerId: 'c2', _count: { _all: 2 } }];
  const r = await call(salesRepsRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'R1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(activity().map((x) => [x.action, x.customerId, x.data.count, x.data.reason, x.inTx]), [
    ['INVOICE_REASSIGNED', 'c1', 4, 'REP_DELETED', true], ['VISIT_DELETED', 'c2', 2, 'REP_DELETED', true],
  ]);
  assert.ok(opIndex('customerActivity.createMany') < opIndex('invoice.updateMany'), 'قبل التفريغ');
});
