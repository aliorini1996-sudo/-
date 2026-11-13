// إصلاحات «ربط الدفاتر» L1 (fixb) #6 — سندات صرف الموردين بنطاق المستخدم المقيَّد، عبر Express الحقيقي والمصادقة الحقيقية (JWT) فوق
// عميل Prisma المزيّف b3b-route-fake.ts: قائمة السندات والسند الواحد لا تكشفان معرّف واسم مندوب عهدةٍ خارج نطاقه، وإلغاء سندٍ من عهدة
// مندوبٍ خارج نطاقه 404 كغير الموجود (يعيد المبلغ إلى عهدة مندوبٍ لا يملكه) — وغير المقيَّد كما كان.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { RouteFakeDb, day, m, type Row } from './b3b-route-fake';

process.env.JWT_SECRET = 'fixb-supplier-scope-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');

const db = new RouteFakeDb();
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const paymentsModule = require('../routes/supplierPayments') as typeof import('../routes/supplierPayments');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/supplier-payments', paymentsModule.default);
    app.use(errorHandler);
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

const T = 'T1';
const auth = (id: string) => ({ authorization: `Bearer ${jwt.sign({ id, role: 'ADMIN', name: id, tenantId: T }, SECRET)}` });
const FULL = auth('a1');
const SCOPED = auth('a2');

/** مستخدمان: a1 غير مقيَّد، وa2 مقيَّد بالقوائم ونطاقه R1 وحده. سندان من عهدة R1 وR2، وثالثٌ نقدي */
function world(): void {
  db.reset();
  db.seed('tenant', { id: T, warehouseEnabled: true, accountingEnabled: true, apiEnabled: true, isActive: true, subscriptionEndsAt: null });
  for (const [id, scoped] of [['a1', false], ['a2', true]] as const) {
    db.seed('admin', { id, tenantId: T, role: 'ADMIN', name: id, isActive: true, lastSeenAt: new Date(), canDelete: true, canManageVanStock: true, scopeEnabled: scoped, scopeMode: 'LISTS' });
  }
  db.seed('companySettings', { tenantId: T, countryCode: 'SA', currency: 'SAR' });
  db.seed('glVendor', { id: 'V1', tenantId: T, name: 'مورّد' });
  db.seed('salesRep', { id: 'R1', tenantId: T, name: 'مندوب الشمال', adminScopes: [{ adminId: 'a2' }] });
  db.seed('salesRep', { id: 'R2', tenantId: T, name: 'مندوب الجنوب', adminScopes: [] });
  const pay = (id: string, number: number, method: string, salesRepId: string | null) => {
    db.seed('supplierPayment', { id, tenantId: T, vendorId: 'V1', number, amountMilli: m(100), method, paidAt: day('2026-11-01'), status: 'POSTED', salesRepId });
    db.seed('supplierLedgerEntry', { tenantId: T, vendorId: 'V1', kind: 'PAYMENT', amountMilli: -m(100), docDate: day('2026-11-01'), supplierPaymentId: id });
  };
  pay('P1', 1, 'REP_CUSTODY', 'R1');
  pay('P2', 2, 'REP_CUSTODY', 'R2');
  pay('P3', 3, 'CASH', null);
}

const repsOf = (items: Row[]) => Object.fromEntries(items.map((p) => [p.id, [p.salesRepId, p.salesRepName]]));

test('#6 قائمة السندات للمقيَّد: مندوب عهدةٍ خارج نطاقه بلا معرّف ولا اسم (الطريقة REP_CUSTODY باقية)، ومن نطاقه كاملاً — وغير المقيَّد يرى الكل', async () => {
  world();
  const scoped = await call('GET', '/api/supplier-payments', undefined, SCOPED);
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.deepEqual(repsOf(scoped.body.data.items), { P1: ['R1', 'مندوب الشمال'], P2: [null, null], P3: [null, null] });
  assert.equal(scoped.body.data.items.find((p: Row) => p.id === 'P2').method, 'REP_CUSTODY');
  const full = await call('GET', '/api/supplier-payments', undefined, FULL);
  assert.deepEqual(repsOf(full.body.data.items), { P1: ['R1', 'مندوب الشمال'], P2: ['R2', 'مندوب الجنوب'], P3: [null, null] });
});

test('#6 السند الواحد (الطباعة) بالحجب نفسه', async () => {
  world();
  const one = await call('GET', '/api/supplier-payments/P2', undefined, SCOPED);
  assert.equal(one.status, 200);
  assert.deepEqual([one.body.data.salesRepId, one.body.data.salesRepName], [null, null]);
  const mine = await call('GET', '/api/supplier-payments/P1', undefined, SCOPED);
  assert.deepEqual([mine.body.data.salesRepId, mine.body.data.salesRepName], ['R1', 'مندوب الشمال']);
});

test('#6 إلغاء سندٍ من عهدة مندوبٍ خارج نطاق المقيَّد ⇒ 404 بلا كتابة؛ ومن نطاقه وغير المقيَّد يُلغيان كما كان', async () => {
  world();
  const hidden = await call('POST', '/api/supplier-payments/P2/cancel', {}, SCOPED);
  assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
  assert.equal(hidden.body.code, 'SUPPLIER_PAYMENT_NOT_FOUND');
  assert.equal(db.t.supplierPayment.find((p) => p.id === 'P2')!.status, 'POSTED');
  assert.ok(!db.t.supplierLedgerEntry.some((l) => l.kind === 'PAYMENT_REV'));
  const mine = await call('POST', '/api/supplier-payments/P1/cancel', {}, SCOPED);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const cash = await call('POST', '/api/supplier-payments/P3/cancel', {}, SCOPED);
  assert.equal(cash.status, 200, 'سندٌ بلا عهدة لا يقيّده النطاق');
  const full = await call('POST', '/api/supplier-payments/P2/cancel', {}, FULL);
  assert.equal(full.status, 200);
  assert.equal(db.t.supplierPayment.find((p) => p.id === 'P2')!.status, 'CANCELLED');
});
