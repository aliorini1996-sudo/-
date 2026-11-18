// «تتبّع اللوط» — GET /api/lots/customer-history (طلب المالك ١٦ نوفمبر ٢٠٢٦): ما اشتراه العميل من تشغيلات صنفٍ مسمّاة في الحقبة
// الحالية، الأحدث أولاً، بالمباع والمُرجَع — يغذّي اختيار تشغيلة المرتجع في الويب وتطبيق المندوب. الموجّه الحقيقي فوق قاعدةٍ مزيّفة
// تقيّم شروط where (Prisma) على الصفوف المخزّنة؛ والنطاق (canAccessCustomer وscopedRecordWhere) بدائل يتحكّم بها الاختبار.
//   • الخدمة customerLotHistory: الترتيب بلحظة البيع (LEAST لحظة الجهاز ولحظة الرفع، وإلا تاريخ الفاتورة)، والحقبة، والملغى،
//     والإشعارات، والمُرجَع، وبطاقة الصنف نفسه والشركة نفسها (I5)، والسقف.
//   • المسار: المندوب لعملائه وحدهم (404)، والإدارة بصلاحية الفواتير وبنطاقها، والميزة أو الصنف غير المتتبَّع ⇒ []، ولا عبور شركات.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const D = (s: string) => new Date(s);
const EPOCH = D('2026-06-01T00:00:00Z');

interface State {
  tenant: Row; admins: Row[]; customers: Row[]; products: Row[]; lots: Row[]; iil: Row[];
  repCustomers: Set<string>; adminScope: Row;
}
let st: State;

const lot = (id: string, productId: string, o: Row = {}): Row => ({
  id, tenantId: 'T1', productId, lotNumber: id.toUpperCase(), productionDate: null, expiryDate: D('2027-01-01T00:00:00Z'),
  status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: EPOCH, ...o,
});
let seq = 0;
/** صفّ توزيع بفاتورته — `at` لحظة الإنشاء وتاريخ الفاتورة، و`device` لحظة الجهاز إن صدر منه */
function row(o: { lotId: string | null; qty: number; at: string; type?: string; status?: string; customerId?: string; productId?: string; tenantId?: string; device?: string; documentKind?: string | null; salesRepId?: string; createdAt?: string }): void {
  const at = D(o.at);
  const invoice = {
    id: `inv-${++seq}`, tenantId: o.tenantId ?? 'T1', customerId: o.customerId ?? 'C1', type: o.type ?? 'CASH', status: o.status ?? 'CONFIRMED',
    documentKind: o.documentKind ?? null, invoiceDate: at, createdAt: o.createdAt ? D(o.createdAt) : at, clientCreatedAt: o.device ? D(o.device) : null,
    salesRepId: o.salesRepId ?? 'R1',
  };
  st.iil.push({ id: `iil-${seq}`, tenantId: invoice.tenantId, productId: o.productId ?? 'P1', lotId: o.lotId, quantity: o.qty, createdAt: invoice.createdAt, invoiceItem: { invoice } });
}

function fresh(): State {
  return {
    tenant: { id: 'T1', lotTrackingEnabled: true, lotTrackingSince: EPOCH, accountingEnabled: true },
    admins: [{ id: 'A1', isActive: true, canManageInvoices: true }, { id: 'A2', isActive: true, canManageInvoices: false }],
    customers: [{ id: 'C1', tenantId: 'T1' }, { id: 'C9', tenantId: 'T2' }],
    products: [{ id: 'P1', tenantId: 'T1', lotTracked: true, lotTrackedSince: null }, { id: 'P2', tenantId: 'T1', lotTracked: false, lotTrackedSince: null }],
    lots: [lot('l1', 'P1'), lot('l2', 'P1', { status: 'BLOCKED', blockKind: 'HOLD' }), lot('l3', 'P1'), lot('lp', 'P2'), { ...lot('lt', 'P1'), tenantId: 'T2' }],
    iil: [], repCustomers: new Set(['C1']), adminScope: {},
  };
}

// ═══ مطابقة where (Prisma) ═══
const OPS = new Set(['in', 'notIn', 'not', 'lte', 'gte', 'lt', 'gt']);
const val = (x: unknown) => (x instanceof Date ? x.getTime() : x);
function ops(v: unknown, o: Row): boolean {
  if ('in' in o && !(o.in as unknown[]).includes(v)) return false;
  if ('notIn' in o && (o.notIn as unknown[]).includes(v)) return false;
  if ('not' in o && (o.not === null ? v == null : val(v) === val(o.not))) return false;
  if ('gte' in o && !(v != null && (val(v) as number) >= (val(o.gte) as number))) return false;
  if ('lte' in o && !(v != null && (val(v) as number) <= (val(o.lte) as number))) return false;
  return true;
}
function match(obj: Row | null | undefined, w: Row): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === 'AND') { if (!(v as Row[]).every((x) => match(obj, x))) return false; continue; }
    if (k === 'OR') { if (!(v as Row[]).some((x) => match(obj, x))) return false; continue; }
    const cur = obj?.[k];
    if (v === null) { if (cur != null) return false; continue; }
    if (v instanceof Date || typeof v !== 'object') { if (val(cur) !== val(v)) return false; continue; }
    const keys = Object.keys(v as Row);
    if (keys.length && keys.every((x) => OPS.has(x))) { if (!ops(cur, v as Row)) return false; continue; }
    if (!match(cur, v as Row)) return false;
  }
  return true;
}

const models: Record<string, Record<string, (a: Row) => unknown>> = {
  tenant: { findUnique: ({ where }) => (where.id === st.tenant.id ? { ...st.tenant } : null) },
  admin: { findUnique: ({ where }) => st.admins.find((a) => a.id === where.id) ?? null },
  customer: { findFirst: ({ where }) => st.customers.find((c) => match(c, where)) ?? null },
  product: { findFirst: ({ where }) => st.products.find((p) => match(p, where)) ?? null },
  productLot: { findMany: ({ where }) => st.lots.filter((l) => match(l, where)) },
  invoiceItemLot: {
    findMany: ({ where, take }) => st.iil.filter((r) => match(r, where)).sort((a, b) => b.createdAt - a.createdAt).slice(0, take ?? Infinity),
  },
};
const prismaFake = new Proxy({}, {
  get: (_t, k: string) => {
    if (k === 'then') return undefined;
    const m = models[k];
    if (!m) throw new Error(`مزيّف: نموذج غير معروف ${k}`);
    return new Proxy({}, { get: (_x, method: string) => async (a: Row) => { const fn = m[method]; if (!fn) throw new Error(`${k}.${method}`); return fn(a ?? {}); } });
  },
});

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: prismaFake });
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا يُستدعى'); } });
const realAuth = require('../middleware/auth') as typeof import('../middleware/auth');
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: any, res: any, next: () => void) => {
    const h = req.headers['x-test-user'];
    if (!h) { res.status(401).json({ success: false }); return; }
    req.user = JSON.parse(Buffer.from(String(h), 'base64').toString('utf8'));
    next();
  },
});
const realScope = require('../services/customerScope') as typeof import('../services/customerScope');
stub('services/customerScope', {
  ...realScope,
  canAccessCustomer: async (req: any, tid: string, customerId: string) =>
    req.user?.role === 'SALES_REP' ? st.repCustomers.has(customerId) : st.customers.some((c) => c.id === customerId && c.tenantId === tid),
});
const realAdminScope = require('../services/adminScope') as typeof import('../services/adminScope');
stub('services/adminScope', { ...realAdminScope, scopedRecordWhere: async () => st.adminScope });

const lotsRouter = (require('../routes/lots') as typeof import('../routes/lots')).default;
const { customerLotHistory } = require('../services/lotsDb') as typeof import('../services/lotsDb');

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });

type User = { id: string; role: string; tenantId: string };
const ADMIN: User = { id: 'A1', role: 'ADMIN', tenantId: 'T1' };
const NO_INVOICES: User = { id: 'A2', role: 'MANAGER', tenantId: 'T1' };
const REP: User = { id: 'R1', role: 'SALES_REP', tenantId: 'T1' };

async function get(url: string, user: User): Promise<{ status: number; body: Row }> {
  if (!server) {
    const app = express();
    app.use('/api/lots', lotsRouter);
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const res = await fetch(`http://127.0.0.1:${server.port}${url}`, { headers: { 'x-test-user': Buffer.from(JSON.stringify(user)).toString('base64'), connection: 'close' } });
  return { status: res.status, body: await res.json() as Row };
}
const URL_OK = '/api/lots/customer-history?customerId=C1&productId=P1';

/** عالمٌ نموذجي: l1 قديم، l3 أحدث بلحظة جهازٍ أسبق من رفعه، l2 موقوفة بيعت وسط ذلك، ومرتجع من l1 */
function seed(): void {
  row({ lotId: 'l1', qty: 5, at: '2026-07-01T09:00:00Z' });
  row({ lotId: 'l1', qty: 2, at: '2026-07-05T09:00:00Z' });
  row({ lotId: 'l2', qty: 1, at: '2026-08-01T09:00:00Z' });
  row({ lotId: 'l3', qty: 4, at: '2026-08-02T09:00:00Z', device: '2026-07-20T09:00:00Z', createdAt: '2026-08-02T09:00:00Z' });
  row({ lotId: 'l1', qty: 3, at: '2026-08-10T09:00:00Z', type: 'RETURN' });
  // لا يُعدّ: بيعٌ ملغى، وإشعار دائن، وقبل الحقبة، وعميلٌ آخر، وصفٌّ «غير معروف»، ومرتجعٌ ملغى
  row({ lotId: 'l3', qty: 9, at: '2026-09-01T09:00:00Z', status: 'CANCELLED' });
  row({ lotId: 'l3', qty: 9, at: '2026-09-01T09:00:00Z', documentKind: 'DEBIT_NOTE' });
  row({ lotId: 'l3', qty: 9, at: '2026-01-01T09:00:00Z' });
  row({ lotId: 'l3', qty: 9, at: '2026-09-02T09:00:00Z', customerId: 'C2' });
  row({ lotId: null, qty: 9, at: '2026-09-03T09:00:00Z' });
  row({ lotId: 'l1', qty: 9, at: '2026-09-04T09:00:00Z', type: 'RETURN', status: 'CANCELLED' });
}

test('الخدمة: الأحدث بلحظة البيع أولاً، والمباع والمُرجَع بالأساس، وما لا يُعدّ لا يُعدّ', async () => {
  st = fresh(); seed();
  const rows = await customerLotHistory(prismaFake as never, 'T1', { customerId: 'C1', productId: 'P1' });
  assert.deepEqual(rows.map((r) => [r.lotId, r.soldBase, r.returnedBase, r.status, r.lastSoldAt?.toISOString()]), [
    ['l2', 1, 0, 'BLOCKED', '2026-08-01T09:00:00.000Z'],
    ['l3', 4, 0, 'ACTIVE', '2026-07-20T09:00:00.000Z'],        // LEAST(لحظة الجهاز، لحظة الرفع)
    ['l1', 7, 3, 'ACTIVE', '2026-07-05T09:00:00.000Z'],
  ]);
  assert.equal(rows[0].lotNumber, 'L2');
  assert.equal(rows[0].expiryDate, '2027-01-01');
});

test('الخدمة: بطاقةٌ من شركةٍ أخرى أو لصنفٍ آخر لا تُعرض، والسقف ≤ ٥٠ ويحترم limit', async () => {
  st = fresh();
  row({ lotId: 'lt', qty: 1, at: '2026-07-01T09:00:00Z' });
  row({ lotId: 'lp', qty: 1, at: '2026-07-01T09:00:00Z' });
  row({ lotId: 'l1', qty: 1, at: '2026-07-02T09:00:00Z' });
  row({ lotId: 'l3', qty: 1, at: '2026-07-03T09:00:00Z' });
  assert.deepEqual((await customerLotHistory(prismaFake as never, 'T1', { customerId: 'C1', productId: 'P1' })).map((r) => r.lotId), ['l3', 'l1']);
  assert.deepEqual((await customerLotHistory(prismaFake as never, 'T1', { customerId: 'C1', productId: 'P1', limit: 1 })).map((r) => r.lotId), ['l3']);
  assert.deepEqual(await customerLotHistory(prismaFake as never, 'T1', { customerId: 'C1', productId: 'PX' }), []);
});

test('المسار: المندوب لعميله ⇒ 200 بالصفوف، ولعميلٍ ليس له ⇒ 404', async () => {
  st = fresh(); seed();
  const ok = await get(URL_OK, REP);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data.map((r: Row) => [r.lotId, r.soldBase, r.returnedBase]), [['l2', 1, 0], ['l3', 4, 0], ['l1', 7, 3]]);
  assert.deepEqual(Object.keys(ok.body.data[0]).sort(), ['blockKind', 'expiryDate', 'lastSoldAt', 'lotId', 'lotNumber', 'returnedBase', 'soldBase', 'status']);
  st.repCustomers = new Set();
  assert.equal((await get(URL_OK, REP)).status, 404);
});

test('المسار: الإدارة بنطاقها — فواتير خارج النطاق لا تُعدّ، وبلا صلاحية الفواتير 403', async () => {
  st = fresh(); seed();
  row({ lotId: 'l3', qty: 6, at: '2026-10-01T09:00:00Z', salesRepId: 'R2' });
  const all = (await get(URL_OK, ADMIN)).body.data;
  assert.deepEqual([all[0].lotId, all[0].soldBase], ['l3', 10], 'بلا نطاق: بيع R2 الأحدث ظاهر ومعدود');
  st.adminScope = { salesRepId: 'R1' };
  assert.deepEqual((await get(URL_OK, ADMIN)).body.data.map((r: Row) => r.lotId), ['l2', 'l3', 'l1']);
  assert.equal((await get(URL_OK, ADMIN)).body.data[1].soldBase, 4);
  assert.equal((await get(URL_OK, NO_INVOICES)).status, 403);
});

test('المسار: عميل شركةٍ أخرى 404، وبلا معاملات 400، والميزة مطفأة أو الصنف غير متتبَّع ⇒ []', async () => {
  st = fresh(); seed();
  assert.equal((await get('/api/lots/customer-history?customerId=C9&productId=P1', ADMIN)).status, 404);
  assert.equal((await get('/api/lots/customer-history?customerId=C1', ADMIN)).status, 400);
  assert.equal((await get('/api/lots/customer-history?customerId=C1&productId=PX', ADMIN)).status, 404);
  assert.deepEqual((await get('/api/lots/customer-history?customerId=C1&productId=P2', ADMIN)).body, { success: true, data: [] });
  st.tenant.lotTrackingEnabled = false;
  assert.deepEqual((await get(URL_OK, REP)).body, { success: true, data: [] });
});
