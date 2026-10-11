// مزامنة «الربط البرمجي API» (/api/v1/sync) — قوائم سماح صريحة لكل مورد، ومؤشّرات صفحات، وعزل الشركة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// —— قاعدة مزيّفة تسجّل الاستعلام وتعيد صفوفاً مرتّبة ——
let lastArgs: Record<string, unknown> | null = null;
let rows: Record<string, unknown>[] = [];
let adminRow: Record<string, unknown> | null = { isActive: true, scopeEnabled: false, canManageCustomers: true, canManageInvoices: true };
let tenantRow: Record<string, unknown> = { accountingEnabled: true, warehouseEnabled: false };
const delegate = { async findMany(args: Record<string, unknown>) { lastArgs = args; return rows.slice(0, Number(args.take)); } };
const prismaFake = new Proxy({
  admin: { async findUnique() { return adminRow; } },
  tenant: { async findUnique() { return tenantRow; } },
  apiKey: { async findUnique() { return { name: 'نظامنا', prefix: 'fsk_abcd1234', readOnly: false, createdAt: new Date(), tenant: { name: 'شركة' }, admin: { name: 'مدير' } }; } },
} as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : delegate) });
stub('config/database', { default: prismaFake });
// المصادقة نفسها مختبرة في api-keys.test.ts — هنا تمرير بهوية المفتاح المحقونة
stub('middleware/auth', {
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  tenantId: (req: { user?: { tenantId?: string } }) => req.user!.tenantId!,
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sync = require('../services/apiSync') as typeof import('../services/apiSync');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/apiV1').default as Router;

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] }; handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }
const KEY_USER = { id: 'a1', role: 'ADMIN', name: 'م', tenantId: 't1', apiKeyId: 'k1' };
function mockRes() {
  return { statusCode: 200, body: null as Record<string, unknown> | null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b as Record<string, unknown>; return this; } };
}
/** يمرّ بسلسلة الموجّه كلها (الوسطاء ثم المسار) كما يمرّ الطلب الحقيقي */
async function call(p: string, opts: { user?: unknown; query?: Record<string, unknown> } = {}) {
  const res = mockRes();
  const params: Record<string, string> = {};
  const req = { user: 'user' in opts ? opts.user : KEY_USER, query: opts.query ?? {}, params, method: 'GET' };
  const stack = (router as unknown as { stack: Layer[] }).stack;
  for (const l of stack) {
    if (res.body) break;
    if (l.route) {
      const pattern = new RegExp('^' + l.route.path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
      const m = pattern.exec(p);
      if (!m || !l.route.methods.get) continue;
      Object.assign(params, m.groups ?? {});
      await l.route.stack[l.route.stack.length - 1].handle(req, res, (e?: unknown) => { if (e) throw e; });
      break;
    }
    let passed = false;
    await l.handle(req, res, (e?: unknown) => { if (e) throw e; passed = true; });
    if (!passed) break;
  }
  return res;
}

// —— تغطية الأعمدة: كل عمود في جدول المورد مصنَّف سماحاً أو منعاً ——
function schemaScalars(model: string): string[] {
  const s = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const name = model[0].toUpperCase() + model.slice(1);
  const start = s.indexOf(`model ${name} {`);
  assert.ok(start >= 0, `النموذج ${name} غير موجود`);
  const body = s.slice(start, s.indexOf('\n}', start)).split(/\r?\n/).slice(1);
  const scalar = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal', 'Bytes']);
  const out: string[] = [];
  for (const line of body) {
    const m = /^\s+(\w+)\s+(\w+)(\[\])?\??/.exec(line);
    if (m && !line.trim().startsWith('//') && scalar.has(m[2])) out.push(m[1]);
  }
  return out;
}

test('كل عمود في جداول المزامنة مصنَّف: مسموح في select أو ممنوع بسبب — عمودٌ جديد يُفشل هذا حتى يُقرَّر', () => {
  for (const def of sync.SYNC_RESOURCES) {
    const cols = schemaScalars(def.model);
    const allowed = Object.keys(def.select).filter(k => cols.includes(k));
    const denied = Object.keys(def.denied);
    // عمود الأب (customerId في أسعار العملاء) ليس عمود شركة؛ والعزل عبر العلاقة
    const unclassified = cols.filter(c => !allowed.includes(c) && !denied.includes(c));
    assert.deepEqual(unclassified, [], `${def.name}: أعمدة غير مصنّفة`);
    for (const d of denied) assert.ok(!(d in def.select), `${def.name}: ${d} ممنوع ومسموح معاً`);
  }
});

test('الأسرار والثقيل لا تُختار أبداً — ولا في العلاقات المضمّنة', () => {
  const all = JSON.stringify(sync.SYNC_RESOURCES.map(r => r.select));
  for (const bad of ['passwordHash', 'fcmToken', 'einvoiceClientSecret', 'einvoiceSnapshot', '"image"', 'privateKey', 'token', 'secret', 'clientBundle']) {
    assert.ok(!all.includes(bad), `حقل محظور في المزامنة: ${bad}`);
  }
  assert.ok(!JSON.stringify(sync.syncResource('visits')!.select).includes('"data"'), 'صور الزيارة لا تُضمَّن');
  // الموقع اللحظي للمندوب تحرسه صلاحية التتبّع في اللوحة لا صلاحية المناديب
  for (const f of ['lastLat', 'lastLng', 'lastSeenAt']) assert.ok(!(f in sync.syncResource('sales-reps')!.select), f);
});

test('المؤشّر: ذهاباً وإياباً، ولا يصلح لمورد آخر، والتالف يُرفض', () => {
  const c = sync.encodeCursor({ r: 'customers', t: '2026-10-11T10:00:00.000Z', i: 'abc' });
  assert.deepEqual(sync.decodeCursor(c, 'customers'), { r: 'customers', t: '2026-10-11T10:00:00.000Z', i: 'abc' });
  assert.equal(sync.decodeCursor(c, 'invoices'), 'invalid');
  assert.equal(sync.decodeCursor('%%%', 'customers'), 'invalid');
  assert.equal(sync.decodeCursor(undefined, 'customers'), null);
  assert.equal(sync.parseSince('2026-10-11T10:00:00Z')?.toString(), new Date('2026-10-11T10:00:00Z').toString());
  assert.equal(sync.parseSince('أمس'), 'invalid');
  assert.equal(sync.clampLimit('9999', 100, 500), 500);
  assert.equal(sync.clampLimit('-3', 100, 500), 100);
  assert.equal(sync.clampLimit('0.5', 100, 500), 1, 'كسرٌ دون الواحد لا يصير صفحة صفرية بلا مؤشّر');
  assert.equal(sync.clampLimit(['7', '9'], 100, 500), 7, 'limit مكرّر في الرابط');
  // سنةٌ موسّعة يقبلها Date.parse وترفضها القاعدة ⇒ 400 لا 500
  assert.equal(sync.parseSince('+010000-01-01T00:00:00Z'), 'invalid');
  assert.equal(sync.parseSince({ gt: '2026-01-01' }), 'invalid', 'كائن من محلّل الاستعلام');
  assert.equal(sync.decodeCursor(sync.encodeCursor({ r: 'customers', t: '+010000-01-01T00:00:00.000Z', i: 'x' }), 'customers'), 'invalid');
});

test('شروط الاستعلام: عزل الشركة، و«منذ» بعمود النمط، والحضور بالبصمة أو الانصراف، والقائمة الكاملة بلا منذ', () => {
  const cust = sync.syncResource('customers')!;
  assert.deepEqual(sync.tenantWhere(cust, 't1'), { tenantId: 't1' });
  // العميل والصنف معاً: مسار حفظ الأسعار لا يتحقّق أن الصنف من الشركة
  assert.deepEqual(sync.tenantWhere(sync.syncResource('customer-prices')!, 't1'), { customer: { tenantId: 't1' }, product: { tenantId: 't1' } });
  // معرّفٌ فارغ يرمي — `{ tenantId: undefined }` في Prisma بلا قيد = كل الشركات
  assert.throws(() => sync.tenantWhere(cust, ''));
  assert.throws(() => sync.tenantWhere(cust, undefined as unknown as string));
  // الزيارات بطابع الاستلام لا بطابع الجهاز (الملتقطة دون اتصال تُرفع متأخرة)
  const visits = sync.syncResource('visits')!;
  assert.equal(sync.cursorColumn(visits), 'receivedAt');
  assert.deepEqual(sync.sinceWhere(visits, new Date(0)), { receivedAt: { gte: new Date(0) } });
  const since = new Date('2026-10-01T00:00:00Z');
  assert.deepEqual(sync.sinceWhere(cust, since), { updatedAt: { gte: since } });
  assert.deepEqual(sync.sinceWhere(sync.syncResource('warehouse-entries')!, since), { createdAt: { gte: since } });
  // تتغيّر بعد إنشائها (إعادة حساب الرصيد، إزاحة التاريخ، حذف المندوب) فتُقرأ بطابع التعديل
  for (const n of ['account-entries', 'van-loads']) assert.deepEqual(sync.sinceWhere(sync.syncResource(n)!, since), { updatedAt: { gte: since } }, n);
  assert.match(JSON.stringify(sync.sinceWhere(sync.syncResource('attendance')!, since)), /checkOutAt/);
  assert.equal(sync.sinceWhere(sync.syncResource('categories')!, since), null);
  const after = sync.afterCursorWhere(cust, { r: 'customers', t: since.toISOString(), i: 'x' });
  assert.deepEqual(after, { OR: [{ updatedAt: { gt: since } }, { updatedAt: since, id: { gt: 'x' } }] });
  assert.deepEqual(sync.orderByFor(cust), [{ updatedAt: 'asc' }, { id: 'asc' }]);
});

test('GET /sync/customers: صفحة بحدّها ومؤشّر للتالية ووقت الخادم، والاستعلام معزول بالشركة', async () => {
  const t = new Date('2026-10-11T10:00:00Z');
  rows = [1, 2, 3].map(i => ({ id: `c${i}`, updatedAt: new Date(t.getTime() + i) }));
  adminRow = { isActive: true, scopeEnabled: false, canManageCustomers: true };
  const res = await call('/sync/customers', { query: { limit: '2', since: '2026-10-01T00:00:00Z' } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.body!.data as unknown[]).length, 2);
  assert.equal(res.body!.hasMore, true);
  assert.ok(typeof res.body!.nextCursor === 'string');
  assert.ok(typeof res.body!.serverTime === 'string');
  const w = JSON.stringify(lastArgs!.where);
  assert.match(w, /"tenantId":"t1"/);
  assert.equal(lastArgs!.take, 3);
  assert.ok(!('passwordHash' in (lastArgs!.select as object)));
});

test('المزامنة لمفاتيح API وحدها، ولصاحبٍ غير مقيّد يملك صلاحية القسم، والمحاسبة المطفأة تحجب الفواتير', async () => {
  rows = [];
  let res = await call('/sync/customers', { user: { id: 'a1', role: 'ADMIN', tenantId: 't1' } });
  assert.equal(res.statusCode, 403); assert.equal(res.body!.code, 'API_KEY_REQUIRED');

  adminRow = { isActive: true, scopeEnabled: true, canManageCustomers: true };
  res = await call('/sync/customers');
  assert.equal(res.statusCode, 403); assert.equal(res.body!.code, 'API_KEY_SCOPED_OWNER');

  adminRow = { isActive: true, scopeEnabled: false, canManageInvoices: false };
  res = await call('/sync/invoices');
  assert.equal(res.statusCode, 403); assert.equal(res.body!.code, 'FORBIDDEN');

  adminRow = { isActive: true, scopeEnabled: false, canManageInvoices: true };
  tenantRow = { accountingEnabled: false, warehouseEnabled: false };
  res = await call('/sync/invoices');
  assert.equal(res.statusCode, 403); assert.equal(res.body!.code, 'ACCOUNTING_DISABLED');
  tenantRow = { accountingEnabled: true, warehouseEnabled: false };

  adminRow = { isActive: true, scopeEnabled: false, canManageVanStock: true };
  res = await call('/sync/warehouse-entries');
  assert.equal(res.statusCode, 403); assert.equal(res.body!.code, 'WAREHOUSE_DISABLED');
});

test('مورد مجهول 404 بقائمة الموارد، ومؤشّر مورد آخر 400، و/ids يعيد المعرّفات وحدها', async () => {
  adminRow = { isActive: true, scopeEnabled: false, canManageCustomers: true };
  let res = await call('/sync/passwords');
  assert.equal(res.statusCode, 404);
  assert.ok(Array.isArray(res.body!.resources));
  const foreign = sync.encodeCursor({ r: 'invoices', t: null, i: 'x' });
  res = await call('/sync/customers', { query: { cursor: foreign } });
  assert.equal(res.statusCode, 400);
  rows = [{ id: 'c1' }, { id: 'c2' }];
  res = await call('/sync/customers/ids');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body!.ids, ['c1', 'c2']);
  assert.deepEqual(lastArgs!.select, { id: true });
  assert.match(JSON.stringify(lastArgs!.where), /"tenantId":"t1"/);
});

test('GET /me: الشركة والمفتاح والموارد', async () => {
  const res = await call('/me');
  assert.equal(res.statusCode, 200);
  const d = res.body!.data as Record<string, unknown>;
  assert.equal(d.company, 'شركة');
  assert.equal((d.resources as unknown[]).length, sync.SYNC_RESOURCES.length);
});
