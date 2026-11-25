// «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — البحث برقم العميل وتسلسله في المستندات والدفاتر والمالك والمندوب الذكي وخطوط السير
// والمناديب ولوحة التحكم (بلا قاعدة ولا شبكة). يثبت:
//   • قائمة السندات (GET /receipts): بحثٌ جديد (رقم السند أو اسم العميل احتواءً، أو رقم العميل تامّاً) عنصرٌ في AND **بعد** عناصر
//     قيد النطاق كما هي — فلا يمحو النطاقَ ولا يمحوه، والمندوب يبقى مقيَّداً بسنداته؛ وعميل السند يحمل number.
//   • قائمة الفواتير (GET /invoices): { customer: { number: N } } يُلحق بآخر OR البحث القائم وحده، وقيد النطاق (AND) كما هو.
//   • نصٌّ أرقامٌ كلّه («12» أو «#١٢» أو «# 12») يضيف شرط الرقم؛ و«05» (بادئة جوال) و«abc» والجوال الطويل بلا شرط رقم.
//   • منتقي الشريك في الدفاتر (searchPartners): الرقم بعد الاسم والجوال والرمز، وnumber حقلٌ غائبٌ (لا null) لغير المرقَّم.
//   • الأرصدة الافتتاحية اليدوية (resolveManualPartners): customerRef بالرمز التامّ ثم رقم العميل ثم الاسم التامّ، مقيّداً بالشركة.
//   • بحث «الحذف النهائي» للمالك: شرط الرقم للعميل وحده، والتسمية «#12 · …» للمرقَّم.
//   • حرّاس ثابتة لدفاتر العملاء والمندوب الذكي وخطوط السير والمناديب ولوحة التحكم: شرط الرقم بعد الشروط القائمة، وتسلسل
//     customerNumber/number في الصفوف.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّهات (نمط customer-number-routes.test.ts) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/** وسائط كل نداء Prisma بمفتاح «النموذج.الطريقة» — وردودٌ مبرمجة لكل اختبار */
let seen: Record<string, any[]> = {};
let scripted: Record<string, (args: any) => unknown> = {};
function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: {} };
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    (seen[`${model}.${method}`] ??= []).push(args);
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
type User = { id: string; role: string; tenantId: string; impersonated?: boolean; byKind?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const REP: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
const OWNER: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, impersonated: true, byKind: 'OWNER' };
let currentUser: User = ADMIN;
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireSalesRep: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});

/** قيد النطاق كما يعيده scopedRecordWhere (`{ AND: [...] }` أو `{}`) — يضبطه كل اختبار */
let scope: Record<string, unknown> = {};
const realScope = require('../services/adminScope') as Record<string, unknown>;
stub('services/adminScope', { ...realScope, scopedRecordWhere: async () => scope });

const receiptsRouter = require('../routes/receipts').default as express.Router;
const invoicesRouter = require('../routes/invoices').default as express.Router;
const ownerPurgeRouter = require('../routes/ownerPurge').default as express.Router;
const { purgeSearchLabel } = require('../routes/ownerPurge') as typeof import('../routes/ownerPurge');
const { receiptSearchOr, receiptScopeAnd } = require('../routes/receipts') as typeof import('../routes/receipts');
const { searchPartners } = require('../services/gl/reports/partnerLoad.prisma') as typeof import('../services/gl/reports/partnerLoad.prisma');
const { resolveManualPartners, validateManualBalanceRows } = require('../services/gl/opening') as typeof import('../services/gl/opening');
const { saContext } = require('../services/gl/testing/fixtures') as typeof import('../services/gl/testing/fixtures');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ العُدّة ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json());
  app.use('/api/receipts', receiptsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/owner-purge', ownerPurgeRouter);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ success: false, message: err.message });
  });
  const s = http.createServer(app);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function get(url: string): Promise<Reply> {
  const s = await startServer();
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method: 'GET', path: url, agent: false, headers: { connection: 'close' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    req.end();
  });
}
const q = (s: string) => encodeURIComponent(s);
function reset(o: { user?: User; scope?: Record<string, unknown> } = {}) {
  currentUser = o.user ?? ADMIN;
  scope = o.scope ?? {};
  seen = {};
  scripted = {};
}
const last = (key: string): any => { const a = seen[key] ?? []; assert.ok(a.length, `لم يُنادَ ${key}`); return a[a.length - 1]; };

/** قيدا نطاقٍ مركّبان كما يركّبهما composeRecordWhere — يجب أن يبقيا في AND كما هما */
const S_CUST = { customer: { adminScopes: { some: { adminId: 'admin-1' } } } };
const S_REP = { OR: [{ salesRep: { adminScopes: { some: { adminId: 'admin-1' } } } }, { salesRepId: null }] };
const VALID = ['12', '#١٢', '# 12', '＃12', '۱۲'];
const INVALID = ['05', 'abc', '966551234567', '12a', '0', '1 2'];

// ═══ GET /receipts ═══

test('سندات القبض: البحث عنصرٌ في AND بعد عناصر النطاق كما هي — رقم السند واسم العميل احتواءً ورقم العميل تامّاً', async () => {
  reset({ scope: { AND: [S_CUST, S_REP] } });
  const r = await get(`/api/receipts?search=${q('  #١٢ ')}`);
  assert.equal(r.status, 200);
  const args = last('receipt.findMany');
  const where = args.where;
  assert.equal(where.tenantId, TENANT);
  assert.equal(where.status, 'ACTIVE');
  // شرطا العميل مقيّدان بالشركة: الاستعلام الفرعيّ على customers يمرّ على فهرس الشركة لا على عملاء كل الشركات
  assert.deepEqual(where.AND, [
    S_CUST, S_REP,
    { OR: [
      { number: { contains: '#١٢', mode: 'insensitive' } },
      { customer: { tenantId: TENANT, name: { contains: '#١٢', mode: 'insensitive' } } },
      { customer: { tenantId: TENANT, number: 12 } },
    ] },
  ]);
  assert.equal('OR' in where, false, 'لا OR في المستوى الأعلى يصطدم بمفتاحٍ آخر');
  // العدّ بالشرط نفسه، وعميل السند يحمل رقمه
  assert.deepEqual(last('receipt.count').where, where);
  assert.deepEqual(args.include.customer, { select: { id: true, name: true, number: true } });
});

test('سندات القبض: كل صيغ الرقم الصالحة تضيف الشرط، وغير الرقم (05 وabc والجوال الطويل) يبقى احتواءً وحده', async () => {
  for (const s of VALID) {
    reset();
    await get(`/api/receipts?search=${q(s)}`);
    const or = last('receipt.findMany').where.AND[0].OR;
    assert.deepEqual(or[2], { customer: { tenantId: TENANT, number: 12 } }, s);
    assert.equal(or.length, 3, s);
  }
  for (const s of INVALID) {
    reset();
    await get(`/api/receipts?search=${q(s)}`);
    const where = last('receipt.findMany').where;
    assert.deepEqual(where.AND, [{ OR: [
      { number: { contains: s, mode: 'insensitive' } },
      { customer: { tenantId: TENANT, name: { contains: s, mode: 'insensitive' } } },
    ] }], s);
  }
});

test('سندات القبض: بلا بحث (أو بحثٍ ليس نصّاً) قيد النطاق كما كان حرفياً، والمندوب مقيَّد بسنداته مع البحث', async () => {
  reset({ scope: { AND: [S_CUST] } });
  await get('/api/receipts');
  assert.deepEqual(last('receipt.findMany').where.AND, [S_CUST]);
  reset({ scope: { AND: [S_CUST] } });
  await get('/api/receipts?search=a&search=b');
  assert.deepEqual(last('receipt.findMany').where.AND, [S_CUST]);
  reset();
  await get('/api/receipts?search=%20%20');
  assert.equal('AND' in last('receipt.findMany').where, false);
  // المندوب: salesRepId من جلسته ولو بحث، وفلتر salesRepId من الرابط لا يتجاوزه
  reset({ user: REP });
  await get(`/api/receipts?search=12&salesRepId=rep-2`);
  const where = last('receipt.findMany').where;
  assert.equal(where.salesRepId, 'rep-1');
  assert.deepEqual(where.AND[0].OR[2], { customer: { tenantId: TENANT, number: 12 } });
  // البحث يُقصّ إلى ١٠٠ حرف
  reset();
  await get(`/api/receipts?search=${'x'.repeat(150)}`);
  assert.equal(last('receipt.findMany').where.AND[0].OR[0].number.contains.length, 100);
});

test('سندات القبض: مساعدا البحث صافيان — النطاق المفرد والمصفوفة والغائب', () => {
  assert.deepEqual(receiptScopeAnd({}), []);
  assert.deepEqual(receiptScopeAnd({ AND: S_CUST }), [S_CUST]);
  assert.deepEqual(receiptScopeAnd({ AND: [S_CUST, S_REP] }), [S_CUST, S_REP]);
  assert.equal(receiptSearchOr('abc', TENANT).length, 2);
  assert.deepEqual(receiptSearchOr('abc', TENANT)[1], { customer: { tenantId: TENANT, name: { contains: 'abc', mode: 'insensitive' } } });
  assert.deepEqual(receiptSearchOr('٧', 'T9')[2], { customer: { tenantId: 'T9', number: 7 } });
});

// ═══ GET /invoices ═══

test('الفواتير: رقم العميل يُلحق بآخر OR البحث القائم، والنطاق (AND) كما هو، وعميل الصفّ يحمل number', async () => {
  for (const s of VALID) {
    reset({ scope: { AND: [S_CUST, S_REP] } });
    const r = await get(`/api/invoices?search=${q(s)}`);
    assert.equal(r.status, 200, s);
    const args = last('invoice.findMany');
    assert.deepEqual(args.where.OR, [
      { number: { contains: s } },
      { customer: { name: { contains: s } } },
      { customer: { tenantId: TENANT, number: 12 } },
    ], s);
    assert.deepEqual(args.where.AND, [S_CUST, S_REP], s);
    assert.equal(args.where.tenantId, TENANT);
    assert.deepEqual(args.include.customer, { select: { id: true, name: true, phone: true, number: true } });
    assert.deepEqual(last('invoice.count').where, args.where);
  }
  for (const s of INVALID) {
    reset();
    await get(`/api/invoices?search=${q(s)}`);
    assert.deepEqual(last('invoice.findMany').where.OR, [{ number: { contains: s } }, { customer: { name: { contains: s } } }], s);
  }
  reset();
  await get('/api/invoices');
  assert.equal('OR' in last('invoice.findMany').where, false);
});

// ═══ منتقي الشريك في الدفاتر ═══

function fakeCustomerDb(rows: Array<Record<string, unknown>>, exact: Record<string, unknown> | null = null) {
  const calls: any[] = [];
  const firsts: any[] = [];
  const db = {
    customer: {
      findMany: async (a: unknown) => { calls.push(a); return rows; },
      findFirst: async (a: unknown) => { firsts.push(a); return exact; },
    },
  } as never;
  return { db, calls, firsts };
}

test('منتقي الشريك: رقم العميل بعد الاسم والجوال والرمز، وnumber حقلٌ للمرقَّم وحده (غائب لا null)', async () => {
  const rows = [
    { id: 'c1', name: 'مؤسسة سمارة', phone: '0551234567', number: 12 },
    { id: 'c2', name: 'بقالة', phone: '', number: null },
  ];
  const a = fakeCustomerDb(rows);
  const items = await searchPartners(a.db, TENANT, 'customer', ' #١٢ ');
  const where = a.calls[0].where;
  assert.equal(where.tenantId, TENANT);
  assert.deepEqual(where.OR, [
    { name: { contains: '#١٢', mode: 'insensitive' } },
    { phone: { contains: '#١٢' } },
    { code: { contains: '#١٢', mode: 'insensitive' } },
    { number: 12 },
  ]);
  assert.equal(a.calls[0].select.number, true);
  assert.deepEqual(items, [
    { id: 'c1', name: 'مؤسسة سمارة', hint: '0551234567', number: 12 },
    { id: 'c2', name: 'بقالة', hint: null },
  ]);
  assert.equal('number' in items[1], false);
  for (const s of ['05', 'abc', '966551234567']) {
    const b = fakeCustomerDb([]);
    await searchPartners(b.db, TENANT, 'customer', s);
    assert.equal(b.calls[0].where.OR.length, 3, s);
    // نصٌّ ليس رقم عميل ⇒ لا استعلام لصاحب الرقم
    assert.equal(b.firsts.length, 0, s);
  }
  const c = fakeCustomerDb([]);
  await searchPartners(c.db, TENANT, 'customer', '');
  assert.equal('OR' in c.calls[0].where, false);
  assert.equal(c.firsts.length, 0);
});

test('منتقي الشريك: صاحب الرقم أوّل النتائج ولو سبقته بالاسم عشرون جوالاً تحوي الأرقام — بالحدّ نفسه وبلا تكرار', async () => {
  const phones = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `أ${String(i).padStart(2, '0')}`, phone: `0551200${String(i).padStart(3, '0')}`, number: 200 + i }));
  const exact = { id: 'c12', name: 'ي مؤسسة', phone: '', number: 12 };
  const a = fakeCustomerDb(phones, exact);
  const items = await searchPartners(a.db, TENANT, 'customer', '12');
  assert.equal(items.length, 20, 'الحدّ ٢٠ كما كان');
  assert.deepEqual(items[0], { id: 'c12', name: 'ي مؤسسة', hint: null, number: 12 });
  assert.deepEqual(items.slice(1).map((i) => i.id), phones.slice(0, 19).map((p) => p.id));
  // صاحب الرقم مقيّدٌ بالشركة وبالحقول نفسها
  assert.deepEqual(a.firsts[0], { where: { tenantId: TENANT, number: 12 }, select: { id: true, name: true, phone: true, number: true } });
  // وإن كان بين النتائج أصلاً لا يتكرّر
  const b = fakeCustomerDb([phones[0], exact, phones[1]], exact);
  assert.deepEqual((await searchPartners(b.db, TENANT, 'customer', '#12')).map((i) => i.id), ['c12', 'p0', 'p1']);
  // ولا صاحب رقم ⇒ النتائج كما هي
  const c = fakeCustomerDb(phones.slice(0, 3), null);
  assert.deepEqual((await searchPartners(c.db, TENANT, 'customer', '12')).map((i) => i.id), ['p0', 'p1', 'p2']);
});

// ═══ الأرصدة الافتتاحية اليدوية ═══

test('الأرصدة اليدوية: customerRef بالرمز التامّ ثم رقم العميل ثم الاسم التامّ — مقيّداً بالشركة، والمكرّر مخالفة', async () => {
  const customers = [
    { id: 'c1', tenantId: 't1', code: 'ckz9c1x2y3z4a5b6c7d8e9f0', name: 'مؤسسة سمارة', number: 12 },
    { id: 'c2', tenantId: 't1', code: '12', name: 'بقالة الأمل', number: 3 },
    { id: 'c3', tenantId: 't1', code: 'CUST-3', name: '7', number: 5 },
    { id: 'c4', tenantId: 't1', code: 'CUST-4', name: 'تموينات', number: 7 },
    { id: 'c5', tenantId: 't1', code: 'CUST-5', name: 'قديم', number: null },
    { id: 'x9', tenantId: 't2', code: 'X', name: 'شركة أخرى', number: 40 },
  ];
  const db = {
    customer: { findMany: async ({ where }: { where: { tenantId: string } }) => customers.filter((c) => c.tenantId === where.tenantId) },
    salesRep: { findMany: async () => [] },
  } as never;
  const v = validateManualBalanceRows([
    { accountCode: '113001', debit: 10, customerRef: '#١٢' }, // ٠: الرقم ⇒ c1
    { accountCode: '113001', debit: 10, customerRef: '12' }, // ١: الرمز «12» يسبق الرقم ⇒ c2
    { accountCode: '113001', debit: 10, customerRef: '3' }, // ٢: رقم c2
    { accountCode: '113001', debit: 10, customerRef: '7' }, // ٣: الرقم يسبق الاسم «7» ⇒ c4
    { accountCode: '113001', debit: 10, customerRef: '40' }, // ٤: رقمٌ لشركةٍ أخرى ⇒ غير موجود
    { accountCode: '113001', debit: 10, customerRef: '05' }, // ٥: ليس رقم عميل ولا اسماً ⇒ غير موجود
    { accountCode: '113001', debit: 10, customerRef: ' تموينات ' }, // ٦: الاسم كما كان
  ], saContext(), { midVatPeriod: false });
  assert.equal(v.issues.length, 0);
  const r = await resolveManualPartners(db, 't1', v.lines);
  assert.deepEqual(r.issues.map((i) => [i.index, i.reason]), [[4, 'CUSTOMER_NOT_FOUND'], [5, 'CUSTOMER_NOT_FOUND']]);
  assert.deepEqual(v.lines.map((l) => l.customerId), ['c1', 'c2', 'c2', 'c4', null, null, 'c4']);
  assert.equal(v.lines[0].customerName, 'مؤسسة سمارة');

  // رقمٌ مكرّر (حالةٌ لا يصنعها المساعد، لكن لا قيد فريد في القاعدة) ⇒ مخالفة لا اختيارٌ عشوائيّ
  const dup = {
    customer: { findMany: async () => [{ id: 'a', code: 'A', name: 'أ', number: 9 }, { id: 'b', code: 'B', name: 'ب', number: 9 }] },
    salesRep: { findMany: async () => [] },
  } as never;
  const w = validateManualBalanceRows([{ accountCode: '113001', debit: 1, customerRef: '9' }], saContext(), { midVatPeriod: false });
  const r2 = await resolveManualPartners(dup, 't1', w.lines);
  assert.deepEqual(r2.issues.map((i) => i.reason), ['CUSTOMER_AMBIGUOUS']);
});

// ═══ بحث «الحذف النهائي» للمالك ═══

test('بحث الحذف النهائي: شرط الرقم للعميل وحده والتسمية «#12 · …»، والمسار العامّ للنماذج الأخرى كما هو', async () => {
  reset({ user: OWNER });
  scripted['customer.findMany'] = () => [
    { id: 'c1', name: 'مؤسسة سمارة', code: 'ckz9c1x2y3z4a5b6c7d8e9f0', phone: '0551234567', number: 12 },
    { id: 'c2', name: 'بقالة', code: 'B-1', phone: '', number: null },
  ];
  const r = await get(`/api/owner-purge/search?model=Customer&q=${q('#١٢')}`);
  assert.equal(r.status, 200);
  const args = last('customer.findMany');
  assert.equal(args.where.tenantId, TENANT);
  assert.deepEqual(args.where.OR.at(-1), { number: 12 });
  assert.ok(args.where.OR.some((c: Record<string, unknown>) => 'id' in c), 'البحث بالمعرّف باقٍ');
  assert.equal(args.select.number, true);
  assert.equal(args.take, 20);
  assert.ok(r.body.data[0].label.startsWith('#12 · مؤسسة سمارة'), r.body.data[0].label);
  assert.ok(!r.body.data[1].label.startsWith('#'), r.body.data[1].label);

  reset({ user: OWNER });
  await get(`/api/owner-purge/search?model=Customer&q=${q('05')}`);
  const a2 = last('customer.findMany');
  assert.equal(a2.where.OR.some((c: Record<string, unknown>) => 'number' in c), false);
  assert.equal(a2.select.number, true, 'الرقم يُقرأ للتسمية ولو لم يكن البحث رقماً');

  reset({ user: OWNER });
  await get(`/api/owner-purge/search?model=Product&q=12`);
  const p = last('product.findMany');
  assert.equal(p.where.OR.some((c: Record<string, unknown>) => JSON.stringify(c) === '{"number":12}'), false);

  // التسمية صافية: العميل بلا رقم والنموذج الآخر بلا بادئة
  assert.equal(purgeSearchLabel({ id: 'x', name: 'أ', number: 3 }, ['name'], true), '#3 · أ');
  assert.equal(purgeSearchLabel({ id: 'x', name: 'أ', number: null }, ['name'], true), 'أ');
  assert.equal(purgeSearchLabel({ id: 'x', number: 3 }, [], true), '#3 · x');
  assert.equal(purgeSearchLabel({ id: 'x', name: 'أ', number: 3 }, ['name'], false), 'أ');

  // صاحب الرقم أوّل النتائج ولو ملأت العشرين أكوادٌ تحوي الأرقام قبله — مقيّداً بالشركة، وبلا تكرار، وبالحدّ نفسه
  reset({ user: OWNER });
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, name: `عميل ${i}`, code: `X12-${i}`, phone: '', number: 300 + i }));
  scripted['customer.findMany'] = () => many;
  scripted['customer.findFirst'] = (a) => (a?.where?.number === 12 ? { id: 'c12', name: 'مؤسسة سمارة', code: 'C-12', phone: '', number: 12 } : null);
  const hoisted = await get(`/api/owner-purge/search?model=Customer&q=12`);
  assert.equal(hoisted.body.data.length, 20);
  assert.equal(hoisted.body.data[0].id, 'c12');
  assert.ok(hoisted.body.data[0].label.startsWith('#12 · مؤسسة سمارة'));
  assert.deepEqual(hoisted.body.data.slice(1).map((r: { id: string }) => r.id), many.slice(0, 19).map((r) => r.id));
  const exactArgs = last('customer.findFirst');
  assert.deepEqual(exactArgs.where, { tenantId: TENANT, number: 12 });
  assert.equal(exactArgs.select.number, true);
  // نصٌّ ليس رقماً أو نموذجٌ آخر ⇒ لا استعلام لصاحب الرقم
  reset({ user: OWNER });
  await get(`/api/owner-purge/search?model=Customer&q=${q('05')}`);
  await get(`/api/owner-purge/search?model=Product&q=12`);
  assert.equal(seen['customer.findFirst'], undefined);

  // غير المالك مرفوض قبل أي بحث
  reset({ user: ADMIN });
  const denied = await get('/api/owner-purge/search?model=Customer&q=12');
  assert.equal(denied.status, 403);
  assert.equal(seen['customer.findMany'], undefined);
});

// ═══ حرّاس ثابتة: دفاتر العملاء والمندوب الذكي وخطوط السير والمناديب ولوحة التحكم ═══

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (rel: string) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const between = (s: string, from: string, to: string) => {
  const i = s.indexOf(from);
  assert.ok(i >= 0, `غاب: ${from}`);
  const j = s.indexOf(to, i + from.length);
  return s.slice(i, j < 0 ? undefined : j);
};

test('دفاتر العملاء: قائمتا الفواتير والسندات تضيفان رقم العميل بعد الشرطين القائمين، وصفوفهما تحمل customerNumber', () => {
  const src = code('routes/ledger/customers.ts');
  for (const from of ["router.get('/customers/invoices'", "router.get('/customers/receipts'"]) {
    const h = between(src, from, '\nrouter.');
    assert.match(h, /OR: \[\{ number: \{ contains: search, mode: 'insensitive' \} \}, \{ customer: \{ name: \{ contains: search, mode: 'insensitive' \} \} \}, \.\.\.customerRelNumberOr\(search, tenantId\)\]/, from);
    assert.match(h, /customer: \{ select: \{ name: true, number: true \} \}/, from);
    assert.match(h, /customerNumber: r\.customer\?\.number \?\? null/, from);
  }
  // سجلّ روابط الدفع يحمل الرقم كذلك
  assert.match(between(src, "router.get('/customers/paylink/entries'", '\nrouter.'), /customerNumber: r\.customer\?\.number \?\? null/);
});

test('المندوب الذكي (تصنيف المحلات): الرقم بعد الاسم واسم المنشأة، والنطاق خارج OR، والصفّ يحمل number', () => {
  const h = between(code('routes/aiRep.ts'), "admin.get('/classify'", '\nadmin.');
  assert.match(h, /OR: \[\{ name: \{ contains: search \} \}, \{ businessName: \{ contains: search \} \}, \.\.\.customerNumberOr\(search\)\]/);
  assert.match(h, /\.\.\.\(await customerScope\(req, tid\)\)/);
  assert.match(h, /const select = \{ id: true, name: true, number: true,/);
  // صاحب الرقم أوّل الصفحة الأولى بالشرط نفسه، والصفحة بلاه — بالحقول نفسها
  assert.match(h, /exactNumberFirstPage\(\{\n\s+search, skip: \(page - 1\) \* limit, take: limit,/);
  assert.match(h, /findExact: \(n\) => prisma\.customer\.findFirst\(\{ where: \{ \.\.\.where, number: n \}, select \}\)/);
  assert.match(h, /where: notId \? \{ \.\.\.where, id: \{ not: notId \} \} : where, skip, take, orderBy: \{ name: 'asc' \}, select,/);
  assert.match(h, /number: r\.number \?\? null/);
});

test('خطوط السير: عميل المحطة يُقرأ برقمه في خطّ اليوم وتفصيل الخطّ، والمحطة تحمل customerNumber', () => {
  const src = code('routes/repRoutes.ts');
  assert.match(src, /const STOP_CUSTOMER_SELECT = \{\s*id: true, name: true, number: true,/);
  const routeFor = between(src, 'async function routeFor(', '\n}\n');
  assert.equal((routeFor.match(/customer: \{ select: STOP_CUSTOMER_SELECT \}/g) ?? []).length, 2, 'الخطّ المؤقّت والدائم كلاهما');
  assert.match(between(src, "router.get('/mine'", '\nrouter.'), /customerNumber: s\.customer\.number \?\? null/);
  const one = between(src, "router.get('/:id'", '\nrouter.');
  assert.match(one, /customer: \{ select: \{ id: true, name: true, number: true, businessName: true \} \}/);
  assert.match(one, /customerNumber: s\.customer\.number \?\? null/);
});

test('المناديب ولوحة التحكم: عملاء المندوب وأفضل العملاء وآخر الفواتير تحمل رقم العميل (للعرض وحده)', () => {
  const reps = between(code('routes/salesReps.ts'), "router.get('/:id/customers'", '\nrouter.');
  assert.match(reps, /customer: \{ select: \{ id: true, name: true, businessName: true, phone: true, code: true, number: true \} \}/);
  const dash = code('routes/dashboard.ts');
  assert.match(dash, /select: \{ id: true, name: true, number: true, totalSales: true, balance: true \}/);
  assert.match(dash, /include: \{ customer: \{ select: \{ name: true, number: true \} \}, salesRep: \{ select: \{ name: true \} \} \}/);
});

// ═══ مستند الربط البرمجي: الحقل للقراءة، والبحث بالرقم حيث يبحث الخادم به ═══

/** مقطع مسارٍ واحد من دليل API (نصّاً لا استيراداً — فلا تدخل أنواع الواجهة في tsc الخادم) */
const WEB_LIB = path.join(SRC, '..', '..', 'web-admin', 'src', 'lib');
const docsText = (file: string) => fs.readFileSync(path.join(WEB_LIB, file), 'utf8').replace(/\r\n/g, '\n');
function endpointDoc(method: string, p: string): string {
  const all = docsText('apiDocsCatalog.ts');
  const head = `"method": "${method}",\n    "path": "${p}",`;
  const i = all.indexOf(head);
  assert.ok(i >= 0, `غاب من الدليل: ${method} ${p}`);
  const j = all.indexOf('"method": "', i + head.length);
  return all.slice(i, j < 0 ? undefined : j);
}

test('دليل API: number للقراءة في العميل وعميل الفاتورة والسند، وبحث السندات الجديد، والرقم في منتقي الشريك وخطّ اليوم', () => {
  const cust = endpointDoc('GET', '/customers');
  assert.match(cust, /id وcode وnumber \(«رقم العميل»: عدد صحيح تسلسليّ في الشركة للقراءة وحدها/);
  assert.match(cust, /number مطابقةً تامّة حين يكون النص رقماً: 12 أو #12 أو ١٢/);
  assert.match(cust, /number في جسم POST أو PUT أو الاستيراد يُهمل بصمت، والاستيراد لا يطابق العملاء به/);
  assert.match(endpointDoc('POST', '/customers'), /number \(«رقم العميل»\) يمنحه الخادم في معاملة الإنشاء نفسها/);
  const inv = endpointDoc('GET', '/invoices');
  assert.match(inv, /رقم العميل customer\.number مطابقةً تامّة/);
  assert.match(inv, /customer\{id,name,phone,number\}/);
  // بحث السندات موثّقٌ بحدّه وشروطه كما في الخادم، وعميل السند برقمه
  const rec = endpointDoc('GET', '/receipts');
  assert.match(rec, /"name": "search",\n\s+"type": "string ≤ 100",/);
  assert.match(rec, /رقم السند أو اسم العميل احتواءً بلا تفريق لحالة الأحرف، أو رقم العميل customer\.number مطابقةً تامّة/);
  assert.match(rec, /customer \{id, name, number\}/);
  const srv = code('routes/receipts.ts');
  assert.match(srv, /req\.query\.search\.trim\(\)\.slice\(0, 100\)/, 'الحدّ ١٠٠ في الخادم كما في الدليل');
  // منتقي الشريك: الحقل غائبٌ لغير المرقَّم — كما يعيده searchPartners
  const partners = endpointDoc('GET', '/ledger/partners/search');
  assert.match(partners, /items:\[\{id, name, hint, number\?\}\]/);
  assert.match(partners, /الحقل غائب لغير العميل ولعميلٍ لم يُرقَّم بعد/);
  assert.match(endpointDoc('GET', '/rep-routes/mine'), /customerName, customerNumber, phone/);
  // المزامنة: الحقل في العملاء، وأرقام القدامى بلا تغيير updatedAt ⇒ سحبٌ كامل مرّةً
  const sync = docsText('apiDocsData.ts');
  assert.match(sync, /ورقمه number \(«رقم العميل»: تسلسلٌ لكل شركة يمنحه الخادم، للقراءة وحدها ولا يُكتب/);
  assert.match(sync, /رُقِّموا دون تغيير updatedAt[^)]*اسحب المورد كاملاً مرةً واحدة بلا since/);
});

test('لا كتابة لرقم العميل في الملفات المعنيّة: number يُقرأ ويُطابَق ولا يُكتب في data', () => {
  for (const rel of ['routes/invoices.ts', 'routes/receipts.ts', 'routes/ledger/customers.ts', 'routes/aiRep.ts', 'routes/ownerPurge.ts',
    'routes/repRoutes.ts', 'routes/salesReps.ts', 'routes/dashboard.ts', 'services/gl/opening.ts', 'services/gl/reports/partnerLoad.prisma.ts']) {
    const src = code(rel);
    // لا customer.create/update بمفتاح number، ولا مساعدا الإنشاء المرقَّم هنا (ليست مسارات إنشاء عملاء)
    assert.doesNotMatch(src, /customer\.(update|updateMany|upsert)\(\{[^)]*\bnumber:/, rel);
    assert.doesNotMatch(src, /createNumberedCustomers?\(/, rel);
  }
});

// ═══ دفاتر القيود وبنودها: customerId عمودٌ بلا علاقة ═══

/* eslint-disable @typescript-eslint/no-var-requires */
const { searchCustomerIds, moveListWhere, itemListWhere } = require('../routes/ledger/moves') as typeof import('../routes/ledger/moves');
/* eslint-enable @typescript-eslint/no-var-requires */

test('القيود وبنودها: رقم العميل يضيف قيود عملائه (رأساً أو سطراً) بـ«أو» بعد الشروط القائمة — بمعرّفاتٍ من فهرس الشركة', async () => {
  reset();
  scripted['customer.findMany'] = (a) => (a?.where?.number === 12 ? [{ id: 'c12' }] : []);
  assert.deepEqual(await searchCustomerIds(TENANT, { search: ' #١٢ ' }), ['c12']);
  assert.deepEqual(last('customer.findMany'), { where: { tenantId: TENANT, number: 12 }, select: { id: true }, take: 10 });
  reset();
  assert.deepEqual(await searchCustomerIds(TENANT, { search: 'abc' }), []);
  assert.deepEqual(await searchCustomerIds(TENANT, { search: '05' }), []);
  assert.deepEqual(await searchCustomerIds(TENANT, {}), []);
  assert.equal(seen['customer.findMany'], undefined, 'لا استعلام لغير الرقم');

  const or = (moveListWhere(TENANT, { search: '12' }, ['c12']).AND as any[])[0].OR;
  assert.deepEqual(or.slice(0, 4).map((c: Record<string, unknown>) => Object.keys(c)[0]), ['number', 'ref', 'narration', 'lines']);
  assert.deepEqual(or.slice(4), [{ customerId: { in: ['c12'] } }, { lines: { some: { customerId: { in: ['c12'] } } } }]);
  assert.equal((moveListWhere(TENANT, { search: '12' }).AND as any[])[0].OR.length, 4, 'بلا معرّفات كما كان');
  const items = (itemListWhere(TENANT, { search: '12' }, ['c12']).AND as any[])[0].OR;
  assert.equal(items.length, 5);
  assert.deepEqual(items[4], { customerId: { in: ['c12'] } });
  assert.equal((itemListWhere(TENANT, { search: '12' }).AND as any[])[0].OR.length, 4);
  // القائمتان وتصديرهما يمرّران المعرّفات
  for (const rel of ['routes/ledger/moves.ts', 'routes/ledger/lists.ts']) {
    assert.equal((code(rel).match(/ListWhere\(tenantId, q, await searchCustomerIds\(tenantId, q\)\)/g) ?? []).length, 2, rel);
  }
});
