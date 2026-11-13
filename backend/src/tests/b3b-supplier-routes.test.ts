// «ربط الدفاتر» L1 (B3b): مسارا /api/suppliers و/api/supplier-payments عبر Express الحقيقي والمصادقة الحقيقية (JWT ومفتاح API)
// فوق عميل Prisma مزيّف (b3b-route-fake.ts) — بلا قاعدة ولا شبكة خارجية.
//   • الحرّاس (حرّاس المستودع): بلا توكن، المندوب، سحب canManageVanStock، المحاسبة المطفأة، المستودع المطفأ، مفتاح «قراءة فقط»،
//     وصلاحية الحذف — للمسارين وبلا كتابة.
//   • الموردون: التحقق (400 SUPPLIER_INVALID)، التطبيع، التفرّد تحت قفل (409 SUPPLIER_CODE_EXISTS/SUPPLIER_VAT_EXISTS)، التعديل
//     الجزئي والأرشفة، الحذف الحقيقي و409 SUPPLIER_HAS_HISTORY، القائمة بالبحث والحالة والصفحات والرصيد بتجميعٍ ثابت (لا N+1)،
//     كشف الحساب بأوصافٍ عربية والمرفقات والفترة، الفواتير المفتوحة، أعمار الذمم.
//   • السندات: التحقق (400 SUPPLIER_PAYMENT_INVALID)، التقريب بمنازل العملة، التخصيص الصريح والآلي و409
//     ALLOCATION_EXCEEDS_OUTSTANDING، clientRef المكرَّر 200 بلا كتابة، القائمة والفلاتر، الإلغاء بقيد عكسي و409 للآلي.
//   • العزل: كل صفٍّ من شركةٍ أخرى 404 أو غائب، ولا يدخل رصيداً. وصفر كتابات في gl_* عدا سجلّ الموردين gl_vendors نفسه.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { RouteFakeDb, day, m, type Row } from './b3b-route-fake';
import { companyTimeZone, localDateIn } from '../services/erpPayload';

process.env.JWT_SECRET = 'b3b-supplier-routes-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');

const db = new RouteFakeDb();
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const apiKeys = require('../services/apiKeys') as typeof import('../services/apiKeys');
const suppliersModule = require('../routes/suppliers') as typeof import('../routes/suppliers');
const paymentsModule = require('../routes/supplierPayments') as typeof import('../routes/supplierPayments');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ الخادم ═══

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/suppliers', suppliersModule.default);
    app.use('/api/supplier-payments', paymentsModule.default);
    app.use(errorHandler);
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

// ═══ العالم ═══

const T = 'T1';
const T2 = 'T2';
const ADMIN_NAME = 'مدير المشتريات';

function world(o: { tenant?: Row; admin?: Row; company?: Row } = {}): void {
  db.reset();
  db.seed('tenant', { id: T, warehouseEnabled: true, accountingEnabled: true, apiEnabled: true, isActive: true, subscriptionEndsAt: null, ...o.tenant });
  db.seed('tenant', { id: T2, warehouseEnabled: true, accountingEnabled: true, apiEnabled: true, isActive: true, subscriptionEndsAt: null });
  db.seed('admin', {
    id: 'a1', tenantId: T, role: 'ADMIN', name: ADMIN_NAME, isActive: true, lastSeenAt: new Date(), canDelete: true, canManageVanStock: true,
    scopeEnabled: false, scopeMode: 'LISTS', ...o.admin,
  });
  db.seed('companySettings', { tenantId: T, countryCode: 'SA', currency: 'SAR', ...o.company });
  db.seed('companySettings', { tenantId: T2, countryCode: 'SA', currency: 'SAR' });
  db.seed('glVendor', { id: 'V1', tenantId: T, name: 'مورّد الأول', code: 'S-01', vatNumber: '300000000000003', paymentDays: 30 });
  db.seed('glVendor', { id: 'V2', tenantId: T, name: 'مورّد مؤرشف', code: 'OLD', isActive: false });
  db.seed('glVendor', { id: 'VX', tenantId: T2, name: 'مورّد شركة أخرى', code: 'X-9', vatNumber: '311111111111113' });
  db.seed('salesRep', { id: 'R1', tenantId: T, name: 'مندوب الشمال', adminScopes: [] });
  db.seed('salesRep', { id: 'RX', tenantId: T2, name: 'مندوب شركة أخرى', adminScopes: [] });
}

const token = (o: Row = {}): string => jwt.sign({ id: 'a1', role: 'ADMIN', name: ADMIN_NAME, tenantId: T, ...o }, SECRET);
const auth = (o: Row = {}) => ({ authorization: `Bearer ${token(o)}` });
const A = auth();

/** فاتورة مورّد (حركة وارد مسعَّرة) */
function bill(o: { id: string; vendorId?: string; tenantId?: string; mode?: 'CASH' | 'CREDIT' | null; total: number; billDate?: string; dueDate?: string; status?: string; supplierRef?: string }): Row {
  return db.seed('warehouseEntry', {
    id: o.id,
    tenantId: o.tenantId ?? T,
    type: 'RECEIVE',
    vendorId: o.vendorId ?? 'V1',
    paymentMode: o.mode === undefined ? 'CREDIT' : o.mode,
    status: o.status ?? 'POSTED',
    supplierRef: o.supplierRef ?? `INV-${o.id}`,
    billDate: day(o.billDate ?? '2026-10-01'),
    dueDate: day(o.dueDate ?? o.billDate ?? '2026-10-01'),
    totalMilli: m(o.total),
  });
}

/** قيد كشف مورّد */
function ledger(o: { kind: string; amount: number; docDate: string; vendorId?: string; tenantId?: string; ref?: string | null; note?: string | null; entry?: string; payment?: string; dueDate?: string }): Row {
  return db.seed('supplierLedgerEntry', {
    tenantId: o.tenantId ?? T,
    vendorId: o.vendorId ?? 'V1',
    kind: o.kind,
    amountMilli: m(o.amount),
    docDate: day(o.docDate),
    ref: o.ref ?? null,
    note: o.note ?? null,
    warehouseEntryId: o.entry ?? null,
    supplierPaymentId: o.payment ?? null,
    dueDate: o.dueDate ? day(o.dueDate) : null,
  });
}

/** سند صرف مزروع (للقراءة والإلغاء) مع قيده PAYMENT */
function payment(o: { id: string; number: number; amount: number; paidAt: string; vendorId?: string; tenantId?: string; method?: string; status?: string; autoFor?: string; salesRepId?: string; allocations?: [string, number][] }): Row {
  const p = db.seed('supplierPayment', {
    id: o.id, tenantId: o.tenantId ?? T, vendorId: o.vendorId ?? 'V1', number: o.number, amountMilli: m(o.amount), method: o.method ?? 'CASH',
    paidAt: day(o.paidAt), status: o.status ?? 'POSTED', autoForEntryId: o.autoFor ?? null, salesRepId: o.salesRepId ?? null,
  });
  for (const [entry, amt] of o.allocations ?? []) db.seed('supplierPaymentAllocation', { tenantId: p.tenantId, paymentId: p.id, warehouseEntryId: entry, amountMilli: m(amt) });
  ledger({ kind: 'PAYMENT', amount: -o.amount, docDate: o.paidAt, vendorId: p.vendorId, tenantId: p.tenantId, payment: p.id, ref: `SP-${String(o.number).padStart(6, '0')}` });
  return p;
}

const sinceMark = () => db.calls.length;
const writesSince = (mark: number) => db.calls.slice(mark).map((c) => c.op).filter((op) => /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(op));
const glWritesSince = (mark: number) => writesSince(mark).filter((op) => /^gl[A-Z]/.test(op));

// ═══ الحرّاس ═══

test('الحرّاس: بلا توكن 401، والمندوب 403، وسحب canManageVanStock 403، والمحاسبة المطفأة 403 ACCOUNTING_NOT_ALLOWED، والمستودع المطفأ 403 WAREHOUSE_NOT_ENABLED — للمسارين وبلا كتابة', async () => {
  for (const base of ['/api/suppliers', '/api/supplier-payments']) {
    world();
    assert.equal((await call('GET', base)).status, 401, `${base}: بلا توكن`);

    world();
    const rep = await call('POST', base, { name: 'x' }, auth({ id: 'R1', role: 'SALES_REP', name: 'مندوب' }));
    assert.equal(rep.status, 403, `${base}: المندوب`);

    world({ admin: { canManageVanStock: false } });
    assert.equal((await call('GET', base, undefined, A)).status, 403, `${base}: صلاحية المخزون`);

    world({ tenant: { accountingEnabled: false } });
    const acc = await call('POST', base, {}, A);
    assert.equal(acc.status, 403);
    assert.equal(acc.body.code, 'ACCOUNTING_NOT_ALLOWED');

    world({ tenant: { warehouseEnabled: false } });
    const wh = await call('GET', base, undefined, A);
    assert.equal(wh.status, 403);
    assert.equal(wh.body.code, 'WAREHOUSE_NOT_ENABLED');

    // المستودع مطفأ افتراضياً: عَلَمٌ غائب يمنع لا يفتح
    world({ tenant: { warehouseEnabled: null } });
    assert.equal((await call('POST', base, { name: 'x' }, A)).status, 403);
    assert.deepEqual(db.writes().filter((w) => !w.startsWith('admin.')), [], `${base}: لا كتابة خلف الحرّاس`);
  }
});

test('مفتاح API: «قراءة فقط» يقرأ وتُرفض كتابته 403 API_KEY_FORBIDDEN بلا كتابة، والكامل يكتب — و/supplier-payments ليست /payments الممنوعة', async () => {
  world();
  const ro = apiKeys.generateApiKey();
  const full = apiKeys.generateApiKey();
  db.seed('apiKey', { id: 'k-ro', tenantId: T, keyHash: ro.hash, readOnly: true, revokedAt: null, lastUsedAt: new Date(), createdBy: 'a1', adminId: 'a1' });
  db.seed('apiKey', { id: 'k-full', tenantId: T, keyHash: full.hash, readOnly: false, revokedAt: null, lastUsedAt: new Date(), createdBy: 'a1', adminId: 'a1' });
  const RO = { 'x-api-key': ro.key };
  const FULL = { 'x-api-key': full.key };

  assert.equal((await call('GET', '/api/suppliers', undefined, RO)).status, 200);
  assert.equal((await call('GET', '/api/supplier-payments', undefined, RO)).status, 200);
  const mark = sinceMark();
  for (const [method, url, body] of [
    ['POST', '/api/suppliers', { name: 'مورّد' }],
    ['PUT', '/api/suppliers/V1', { phone: '0500' }],
    ['DELETE', '/api/suppliers/V2', undefined],
    ['POST', '/api/supplier-payments', { supplierId: 'V1', amount: 10, method: 'CASH', paidAt: '2026-11-05' }],
    ['POST', '/api/supplier-payments/P1/cancel', {}],
  ] as const) {
    const r = await call(method, url, body, RO);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.body.code, 'API_KEY_FORBIDDEN');
  }
  assert.deepEqual(writesSince(mark).filter((w) => !w.startsWith('apiKey.')), []);

  const created = await call('POST', '/api/suppliers', { name: 'مورّد الربط' }, FULL);
  assert.equal(created.status, 201);
  const paid = await call('POST', '/api/supplier-payments', { supplierId: created.body.data.id, amount: 10, method: 'CASH', paidAt: '2026-11-05' }, FULL);
  assert.equal(paid.status, 201);
  // الحكم نفسه صرفاً: البادئة الممنوعة /payments لا تلتقط /supplier-payments
  assert.equal(apiKeys.apiKeyRouteDecision('POST', '/supplier-payments', false), null);
  assert.equal(apiKeys.apiKeyRouteDecision('GET', '/suppliers/aging', true), null);
  assert.ok(apiKeys.apiKeyRouteDecision('POST', '/suppliers', true));
});

test('صلاحية الحذف: مستخدم سُحبت منه canDelete ⇒ DELETE 403 DELETE_NOT_ALLOWED والمورّد باقٍ', async () => {
  world({ admin: { canDelete: false } });
  db.seed('glVendor', { id: 'V9', tenantId: T, name: 'بلا أثر' });
  const r = await call('DELETE', '/api/suppliers/V9', undefined, A);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'DELETE_NOT_ALLOWED');
  assert.ok(db.t.glVendor.some((v) => v.id === 'V9'));
});

// ═══ الموردون: الإنشاء والتفرّد ═══

test('إنشاء المورّد: التحقق 400 SUPPLIER_INVALID بلا كتابة، والتطبيع (قصّ، فارغ⇒null، رقم ضريبي وآيبان بلا مسافات)، ودولة الشركة، والقفل قبل الكتابة', async () => {
  world({ company: { countryCode: 'AE' } });
  const bad: [unknown, string][] = [
    [{}, 'name'],
    [{ name: '   ' }, 'name'],
    [{ name: 'x'.repeat(121) }, 'name'],
    [{ name: 'م', paymentDays: 400 }, 'paymentDays'],
    [{ name: 'م', paymentDays: 1.5 }, 'paymentDays'],
    [{ name: 'م', email: 'not-an-email' }, 'email'],
    [{ name: 'م', iban: 'SA12' }, 'iban'],
    [{ name: 'م', vatNumber: '300/000' }, 'vatNumber'],
    [{ name: 'م', countryCode: 'SAU' }, 'countryCode'],
  ];
  for (const [body, field] of bad) {
    const r = await call('POST', '/api/suppliers', body, A);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'SUPPLIER_INVALID');
    assert.ok(r.body.errors?.[field], `${field} في الأخطاء: ${JSON.stringify(r.body.errors)}`);
  }
  assert.deepEqual(db.writes().filter((w) => !w.startsWith('admin.')), []);

  const mark = sinceMark();
  const r = await call('POST', '/api/suppliers', {
    name: '  شركة التوريد  ', nameEn: ' Supply Co ', code: ' S-02 ', vatNumber: '300 111 222 333 003', email: 'ap@supply.sa',
    iban: 'sa03 8000-0000 6080 1016 7519', paymentDays: '45', phone: '', notes: '   ', bankName: null, balance: 999, isActive: false,
  }, A);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const s = r.body.data;
  assert.equal(s.name, 'شركة التوريد');
  assert.equal(s.nameEn, 'Supply Co');
  assert.equal(s.code, 'S-02');
  assert.equal(s.vatNumber, '300111222333003');
  assert.equal(s.iban, 'SA0380000000608010167519');
  assert.equal(s.paymentDays, 45);
  assert.equal(s.phone, null);
  assert.equal(s.notes, null);
  assert.equal(s.countryCode, 'AE', 'دولة الشركة');
  assert.equal(s.isActive, true, 'الإنشاء لا يقبل isActive');
  assert.equal(s.balance, 0, 'balance لا يُكتب من الجسم');
  assert.equal(s.openBillsCount, 0);
  assert.equal(typeof s.createdAt, 'string');
  // القفل الاستشاري ثم فحص التفرّد ثم الكتابة — كلها في المعاملة
  const ops = db.calls.slice(mark);
  const lockAt = ops.findIndex((c) => c.op === '$executeRaw' && String((c.args as Row).values?.[0]).startsWith('supplier-master:T1'));
  const createAt = ops.findIndex((c) => c.op === 'glVendor.create');
  assert.ok(lockAt >= 0 && createAt > lockAt, 'القفل قبل الكتابة');
  assert.ok(ops[lockAt].inTx && ops[createAt].inTx);
  assert.deepEqual(glWritesSince(mark), ['glVendor.create'], 'الكتابة الوحيدة في gl_* سجلّ الموردين');

  const eg = await call('POST', '/api/suppliers', { name: 'مورّد مصري', countryCode: 'eg' }, A);
  assert.equal(eg.body.data.countryCode, 'EG');
});

test('التفرّد: رمز المورّد بلا حساسية للأحرف (والمؤرشف يحجزه) ⇒ 409 SUPPLIER_CODE_EXISTS، والرقم الضريبي ⇒ 409 SUPPLIER_VAT_EXISTS — وشركةٌ أخرى لا تحجز', async () => {
  world();
  const code = await call('POST', '/api/suppliers', { name: 'جديد', code: 's-01' }, A);
  assert.equal(code.status, 409);
  assert.equal(code.body.code, 'SUPPLIER_CODE_EXISTS');
  assert.equal(code.body.details.supplierId, 'V1');
  const archived = await call('POST', '/api/suppliers', { name: 'جديد', code: 'old' }, A);
  assert.equal(archived.body.code, 'SUPPLIER_CODE_EXISTS', 'المؤرشف يحجز رمزه');
  const vat = await call('POST', '/api/suppliers', { name: 'جديد', vatNumber: '300 000 000 000 003' }, A);
  assert.equal(vat.status, 409);
  assert.equal(vat.body.code, 'SUPPLIER_VAT_EXISTS');
  assert.equal(db.t.glVendor.filter((v) => v.tenantId === T).length, 2, 'لا مورّد جديد');
  // رمز شركةٍ أخرى ورقمها الضريبي حرّان هنا (العزل)
  const other = await call('POST', '/api/suppliers', { name: 'جديد', code: 'X-9', vatNumber: '311111111111113' }, A);
  assert.equal(other.status, 201);
});

// ═══ الموردون: التعديل والحذف ═══

test('تعديل المورّد: الحقول المرسَلة وحدها، والمسح بـnull، والأرشفة، والتكرار القديم لا يمنع تعديل غيره — والمكرَّر الجديد 409 ومورّد شركةٍ أخرى 404 بلا كتابة', async () => {
  world();
  // تكرارٌ قديم من M2 (قبل التفرّد): V3 يحمل رمز V1
  db.seed('glVendor', { id: 'V3', tenantId: T, name: 'مكرّر قديم', code: 'S-01', phone: '0500000000', notes: 'قديم' });
  const phone = await call('PUT', '/api/suppliers/V3', { phone: ' 0555555555 ', code: 's-01' }, A);
  assert.equal(phone.status, 200, JSON.stringify(phone.body));
  assert.equal(phone.body.data.phone, '0555555555');
  assert.equal(phone.body.data.name, 'مكرّر قديم', 'الاسم لم يُرسَل فبقي');
  assert.equal(phone.body.data.code, 's-01', 'الرمز نفسه بحالة أحرفٍ أخرى ليس تغييراً يُفحص');

  const dup = await call('PUT', '/api/suppliers/V2', { code: 'S-01' }, A);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'SUPPLIER_CODE_EXISTS');
  const vatDup = await call('PUT', '/api/suppliers/V3', { vatNumber: '300000000000003' }, A);
  assert.equal(vatDup.body.code, 'SUPPLIER_VAT_EXISTS');

  const clear = await call('PUT', '/api/suppliers/V3', { notes: null, paymentDays: '', isActive: false }, A);
  assert.equal(clear.status, 200);
  assert.equal(clear.body.data.notes, null);
  assert.equal(clear.body.data.paymentDays, null);
  assert.equal(clear.body.data.isActive, false);

  assert.equal((await call('PUT', '/api/suppliers/V3', { name: ' ' }, A)).body.code, 'SUPPLIER_INVALID');
  assert.equal((await call('PUT', '/api/suppliers/V3', { isActive: 'yes' }, A)).status, 400);

  const mark = sinceMark();
  const foreign = await call('PUT', '/api/suppliers/VX', { name: 'اختطاف' }, A);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'SUPPLIER_NOT_FOUND');
  assert.deepEqual(writesSince(mark), []);
  assert.equal(db.t.glVendor.find((v) => v.id === 'VX')!.name, 'مورّد شركة أخرى');
});

test('حذف المورّد: حقيقي لمن لا أثر له (بعد قفل صفّه)، و409 SUPPLIER_HAS_HISTORY لمن له حركة أو قيد كشف أو سند أو سطر قيد في الدفاتر، و404 لمورّد شركةٍ أخرى', async () => {
  const cases: [string, (id: string) => void, string][] = [
    ['حركة مستودع', (id) => bill({ id: 'E1', vendorId: id, total: 10 }), 'warehouseEntries'],
    ['قيد كشف', (id) => ledger({ kind: 'OPENING', amount: 5, docDate: '2026-01-01', vendorId: id }), 'ledgerEntries'],
    ['سند', (id) => db.seed('supplierPayment', { tenantId: T, vendorId: id, number: 1, amountMilli: m(5), method: 'CASH', paidAt: day('2026-11-01') }), 'payments'],
    ['سطر قيد يدوي في الدفاتر', (id) => db.seed('glMoveLine', { tenantId: T, vendorId: id, moveId: 'mv1', accountId: 'acc' }), 'journalEntries'],
  ];
  for (const [label, seedHistory, flag] of cases) {
    world();
    db.seed('glVendor', { id: 'V9', tenantId: T, name: 'مورّد بأثر' });
    seedHistory('V9');
    const r = await call('DELETE', '/api/suppliers/V9', undefined, A);
    assert.equal(r.status, 409, label);
    assert.equal(r.body.code, 'SUPPLIER_HAS_HISTORY');
    assert.equal(r.body.details[flag], true, label);
    assert.ok(db.t.glVendor.some((v) => v.id === 'V9'), `${label}: باقٍ`);
    assert.ok(!db.calls.some((c) => c.op === 'glVendor.deleteMany'), `${label}: لا حذف`);
  }

  world();
  db.seed('glVendor', { id: 'V9', tenantId: T, name: 'بلا أثر' });
  // أثرٌ لشركةٍ أخرى يحمل المعرّف نفسه لا يمنع (العزل) — ولا يقع حقيقةً، لكنه يثبت أن الفحص بـtenantId
  db.seed('glMove', { tenantId: T2, vendorId: 'V9' });
  const mark = sinceMark();
  const ok = await call('DELETE', '/api/suppliers/V9', undefined, A);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.data, { id: 'V9', deleted: true });
  assert.ok(!db.t.glVendor.some((v) => v.id === 'V9'));
  const ops = db.calls.slice(mark).map((c) => (c.op === '$queryRaw' ? `$queryRaw:${String((c.args as Row).sql).includes('FROM gl_vendors') ? 'gl_vendors' : '?'}` : c.op));
  assert.ok(ops.indexOf('$queryRaw:gl_vendors') < ops.indexOf('glVendor.deleteMany'), 'قفل الصفّ قبل الحذف');
  assert.deepEqual(glWritesSince(mark), ['glVendor.deleteMany']);

  const foreign = await call('DELETE', '/api/suppliers/VX', undefined, A);
  assert.equal(foreign.status, 404);
  assert.ok(db.t.glVendor.some((v) => v.id === 'VX'));
});

test('حذف المورّد: شبكة الأمان — مفتاحٌ أجنبي ترفضه القاعدة (P2003) يُردّ 409 SUPPLIER_HAS_HISTORY لا 500', async () => {
  world();
  db.seed('glVendor', { id: 'V9', tenantId: T, name: 'مورّد' });
  // حركةٌ تشير إليه من «شركة أخرى» لا يراها فحص tenantId — والقاعدة (المفتاح الأجنبي) ترفض الحذف رغم ذلك
  bill({ id: 'E9', vendorId: 'V9', tenantId: T2, total: 1 });
  const r = await call('DELETE', '/api/suppliers/V9', undefined, A);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SUPPLIER_HAS_HISTORY');
  assert.ok(db.t.glVendor.some((v) => v.id === 'V9'), 'تراجعت المعاملة');
});

// ═══ الموردون: القائمة والبطاقة ═══

test('قائمة الموردين: البحث بلا حساسية بالاسم والرمز والرقم الضريبي والجوال، والحالة (active افتراضياً)، والصفحات، والعزل', async () => {
  world();
  db.seed('glVendor', { id: 'V3', tenantId: T, name: 'ب مورّد', nameEn: 'ACME Trading', phone: '0551234567' });
  db.seed('glVendor', { id: 'V4', tenantId: T, name: 'ج مورّد', code: 'ZED-7' });
  const ids = async (qs: string) => {
    const r = await call('GET', `/api/suppliers${qs}`, undefined, A);
    assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`);
    return (r.body.data.items as Row[]).map((s) => s.id).sort();
  };
  assert.deepEqual(await ids(''), ['V1', 'V3', 'V4'], 'المؤرشف وشركةٌ أخرى خارج الافتراضي');
  assert.deepEqual(await ids('?status=archived'), ['V2']);
  assert.deepEqual(await ids('?status=ALL'), ['V1', 'V2', 'V3', 'V4']);
  assert.deepEqual(await ids('?search=acme'), ['V3'], 'الاسم الإنجليزي بلا حساسية');
  assert.deepEqual(await ids('?search=zed'), ['V4'], 'الرمز');
  assert.deepEqual(await ids('?search=300000'), ['V1'], 'الرقم الضريبي');
  assert.deepEqual(await ids('?search=0551'), ['V3'], 'الجوال');
  assert.deepEqual(await ids('?search=x-9&status=all'), [], 'رمز شركةٍ أخرى لا يظهر');
  const bad = await call('GET', '/api/suppliers?status=deleted', undefined, A);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'SUPPLIER_INVALID');

  const p2 = await call('GET', '/api/suppliers?status=all&limit=2&page=2', undefined, A);
  assert.equal(p2.body.data.total, 4);
  assert.equal(p2.body.data.items.length, 2);
  assert.equal(p2.body.data.page, 2);
  assert.equal(p2.body.data.limit, 2);
  const capped = await call('GET', '/api/suppliers?limit=5000&page=-3', undefined, A);
  assert.equal(capped.body.data.limit, 200);
  assert.equal(capped.body.data.page, 1);
});

test('قائمة الموردين: الرصيد (Σ الكشف) وعدد الفواتير المفتوحة بتجميعٍ واحد — عدد الاستعلامات لا يتبع عدد الموردين، وقيود شركةٍ أخرى لا تدخل', async () => {
  world();
  bill({ id: 'E1', total: 1150, dueDate: '2026-10-31' });
  ledger({ kind: 'BILL', amount: 1150, docDate: '2026-10-01', entry: 'E1', ref: 'INV-E1' });
  payment({ id: 'P1', number: 1, amount: 150, paidAt: '2026-10-10', allocations: [['E1', 150]] });
  // قيدٌ بشركةٍ أخرى يحمل معرّف V1 (لا يقع، ويثبت أن التجميع بـtenantId)
  ledger({ kind: 'BILL', amount: 999, docDate: '2026-10-01', tenantId: T2 });
  const r = await call('GET', '/api/suppliers?status=all', undefined, A);
  const v1 = (r.body.data.items as Row[]).find((s) => s.id === 'V1')!;
  assert.equal(v1.balance, 1000);
  assert.equal(v1.openBillsCount, 1);
  const v2 = (r.body.data.items as Row[]).find((s) => s.id === 'V2')!;
  assert.equal(v2.balance, 0);
  assert.equal(v2.openBillsCount, 0);
  assert.ok(db.calls.some((c) => c.op === 'supplierLedgerEntry.groupBy'), 'الرصيد بتجميع groupBy');

  const queriesFor = async (n: number) => {
    world();
    for (let i = 0; i < n; i++) {
      db.seed('glVendor', { id: `W${i}`, tenantId: T, name: `مورّد ${i}` });
      bill({ id: `B${i}`, vendorId: `W${i}`, total: 100 });
      ledger({ kind: 'BILL', amount: 100, docDate: '2026-10-01', vendorId: `W${i}`, entry: `B${i}` });
    }
    const mark = sinceMark();
    const res = await call('GET', '/api/suppliers?limit=200', undefined, A);
    assert.equal(res.body.data.items.length, n + 1);
    return db.calls.slice(mark).filter((c) => !c.op.startsWith('tx.') && !c.op.startsWith('admin.') && !c.op.startsWith('tenant.')).length;
  };
  assert.equal(await queriesFor(2), await queriesFor(12), 'لا N+1');
});

test('بطاقة المورّد برصيده — ومورّد شركةٍ أخرى 404 SUPPLIER_NOT_FOUND', async () => {
  world();
  ledger({ kind: 'OPENING', amount: 75.5, docDate: '2026-01-01' });
  const r = await call('GET', '/api/suppliers/V1', undefined, A);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.balance, 75.5);
  assert.equal(r.body.data.code, 'S-01');
  const x = await call('GET', '/api/suppliers/VX', undefined, A);
  assert.equal(x.status, 404);
  assert.equal(x.body.code, 'SUPPLIER_NOT_FOUND');
});

// ═══ كشف الحساب والفواتير المفتوحة والأعمار ═══

/** كشفٌ كامل: فاتورة آجلة بمرفقين، وشراء نقدي بسنده الآلي، وسند بنكي أُلغي، ومرتجع جزئي */
function statementWorld(): void {
  world();
  bill({ id: 'E1', total: 1150, billDate: '2026-10-01', dueDate: '2026-10-31', supplierRef: 'INV-100' });
  db.seed('warehouseEntryAttachment', { tenantId: T, entryId: 'E1', name: 'a.pdf' });
  db.seed('warehouseEntryAttachment', { tenantId: T, entryId: 'E1', name: 'b.jpg' });
  ledger({ kind: 'BILL', amount: 1150, docDate: '2026-10-01', entry: 'E1', ref: 'INV-100', dueDate: '2026-10-31' });
  bill({ id: 'E2', mode: 'CASH', total: 230, billDate: '2026-10-05', supplierRef: 'INV-101' });
  ledger({ kind: 'BILL', amount: 230, docDate: '2026-10-05', entry: 'E2', ref: 'INV-101' });
  payment({ id: 'P1', number: 1, amount: 230, paidAt: '2026-10-05', autoFor: 'E2', allocations: [['E2', 230]] });
  payment({ id: 'P2', number: 2, amount: 500, paidAt: '2026-10-20', method: 'BANK_TRANSFER', status: 'CANCELLED', allocations: [['E1', 500]] });
  ledger({ kind: 'PAYMENT_REV', amount: 500, docDate: '2026-10-25', payment: 'P2', ref: 'SP-000002', note: 'خطأ في المبلغ' });
  db.seed('warehouseEntry', { id: 'E3', tenantId: T, type: 'RETURN', vendorId: 'V1', returnOfEntryId: 'E1', totalMilli: m(115), billDate: day('2026-10-28') });
  ledger({ kind: 'RETURN', amount: -115, docDate: '2026-10-28', entry: 'E3', ref: 'INV-100' });
  // قيدٌ بشركةٍ أخرى يحمل معرّف V1 — لا يظهر (العزل)
  ledger({ kind: 'BILL', amount: 777, docDate: '2026-10-02', tenantId: T2 });
}

test('كشف حساب المورّد: أوصافٌ عربية لكل نوع، والرصيد الجاري والإجماليات بفرق صفر، ومرفقات الحركة، والعملة، ورصيد البطاقة', async () => {
  statementWorld();
  const r = await call('GET', '/api/suppliers/V1/statement', undefined, A);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.data;
  assert.equal(s.currency, 'SAR');
  assert.equal(s.from, null);
  assert.equal(s.to, null);
  assert.equal(s.opening, 0);
  assert.deepEqual((s.lines as Row[]).map((l) => l.description), [
    'فاتورة مورّد INV-100',
    'فاتورة مورّد INV-101 — شراء نقدي',
    'سند صرف SP-000001 — نقداً من الصندوق (آلي لشراء نقدي)',
    'سند صرف SP-000002 — تحويل بنكي',
    'إلغاء سند صرف SP-000002 — خطأ في المبلغ',
    'مرتجع للمورّد INV-100',
  ]);
  assert.deepEqual((s.lines as Row[]).map((l) => [l.kind, l.debit, l.credit, l.balance]), [
    ['BILL', 0, 1150, 1150],
    ['BILL', 0, 230, 1380],
    ['PAYMENT', 230, 0, 1150],
    ['PAYMENT', 500, 0, 650],
    ['PAYMENT_REV', 0, 500, 1150],
    ['RETURN', 115, 0, 1035],
  ]);
  assert.equal(s.closing, 1035);
  assert.equal(s.totalDebit, 845);
  assert.equal(s.totalCredit, 1880);
  assert.equal(s.totalCredit - s.totalDebit, s.closing - s.opening);
  assert.deepEqual((s.lines as Row[]).map((l) => l.attachmentsCount), [2, 0, 0, 0, 0, 0]);
  assert.equal(s.lines[0].dueDate, '2026-10-31');
  assert.equal(s.lines[0].date, '2026-10-01');
  assert.equal(s.lines[0].warehouseEntryId, 'E1');
  assert.equal(s.lines[2].supplierPaymentId, 'P1');
  assert.equal(s.lines[0].ref, 'INV-100');
  // البطاقة برصيدها الكلي (لا رصيد الفترة) وفاتورتها المفتوحة: 1150 − 115 (السند الملغى لا يُحسب)
  assert.equal(s.supplier.id, 'V1');
  assert.equal(s.supplier.balance, 1035);
  assert.equal(s.supplier.openBillsCount, 1);
});

test('كشف الحساب لفترة: الافتتاحي = Σ ما قبل from، والسطور داخلها برصيدٍ جارٍ يبدأ منه — والتاريخ غير الصالح والفترة المقلوبة 400 ومورّد شركةٍ أخرى 404', async () => {
  statementWorld();
  const r = await call('GET', '/api/suppliers/V1/statement?from=2026-10-06&to=2026-10-26', undefined, A);
  assert.equal(r.status, 200);
  const s = r.body.data;
  assert.equal(s.from, '2026-10-06');
  assert.equal(s.to, '2026-10-26');
  assert.equal(s.opening, 1150);
  assert.deepEqual((s.lines as Row[]).map((l) => [l.kind, l.balance]), [['PAYMENT', 650], ['PAYMENT_REV', 1150]]);
  assert.equal(s.closing, 1150);
  assert.equal(s.supplier.balance, 1035, 'البطاقة بالرصيد الكلي');

  for (const qs of ['?from=2026-13-01', '?to=yesterday', '?from=2026-10-26&to=2026-10-06']) {
    const bad = await call('GET', `/api/suppliers/V1/statement${qs}`, undefined, A);
    assert.equal(bad.status, 400, qs);
    assert.equal(bad.body.code, 'SUPPLIER_INVALID');
  }
  const x = await call('GET', '/api/suppliers/VX/statement', undefined, A);
  assert.equal(x.status, 404);
});

test('وصف سطر الكشف (صرف): الافتتاحي والاسترداد وإلغاء الفاتورة والنوع المجهول، والمرجع الغائب من الحركة أو رقم السند', () => {
  const ctx = {
    payments: new Map([['P7', { method: 'REP_CUSTODY', number: 7, autoForEntryId: null }], ['P8', { method: 'CHEQUE', number: 8, autoForEntryId: null }]]),
    entries: new Map([['E5', { supplierRef: 'INV-5', paymentMode: 'CREDIT' }]]),
  };
  const d = (row: Partial<Row>) => suppliersModule.describeStatementLine({ kind: 'BILL', ref: null, note: null, warehouseEntryId: null, supplierPaymentId: null, ...row } as never, ctx);
  assert.equal(d({ kind: 'OPENING', note: 'رصيد مرحَّل' }), 'رصيد افتتاحي — رصيد مرحَّل');
  assert.equal(d({ kind: 'REFUND_IN', ref: 'INV-5' }), 'استرداد نقدي من المورّد INV-5');
  assert.equal(d({ kind: 'BILL_REV', warehouseEntryId: 'E5' }), 'إلغاء فاتورة مورّد INV-5');
  assert.equal(d({ kind: 'BILL', warehouseEntryId: 'E5' }), 'فاتورة مورّد INV-5');
  assert.equal(d({ kind: 'BILL' }), 'فاتورة مورّد');
  assert.equal(d({ kind: 'PAYMENT', supplierPaymentId: 'P7' }), 'سند صرف SP-000007 — من عهدة مندوب');
  assert.equal(d({ kind: 'PAYMENT', supplierPaymentId: 'P8', ref: 'SP-000008' }), 'سند صرف SP-000008 — شيك');
  assert.equal(d({ kind: 'PAYMENT_REV', supplierPaymentId: 'P8' }), 'إلغاء سند صرف SP-000008');
  assert.equal(d({ kind: 'MYSTERY', ref: 'R1' }), 'MYSTERY R1');
});

test('الفواتير المفتوحة: الآجلة غير الملغاة ذات المتبقّي وحدها، الأقدم استحقاقاً أولاً، وأيام التأخّر حتى يوم الشركة — ومورّد شركةٍ أخرى 404', async () => {
  world();
  bill({ id: 'E1', total: 1000, billDate: '2026-09-01', dueDate: '2026-10-31', supplierRef: 'A' });
  bill({ id: 'E2', total: 300, billDate: '2026-09-10', dueDate: '2026-09-15', supplierRef: 'B' });
  bill({ id: 'E3', total: 200, billDate: '2026-09-01', dueDate: '2026-09-01', supplierRef: 'C' }); // مسدَّدة كاملة
  bill({ id: 'E4', mode: 'CASH', total: 50, billDate: '2026-09-01' }); // نقدية
  bill({ id: 'E5', total: 70, status: 'CANCELLED' }); // ملغاة
  bill({ id: 'E6', vendorId: 'V2', total: 90 }); // مورّد آخر
  payment({ id: 'P1', number: 1, amount: 400, paidAt: '2026-10-01', allocations: [['E3', 200], ['E1', 200]] });
  const r = await call('GET', '/api/suppliers/V1/open-bills', undefined, A);
  assert.equal(r.status, 200);
  const rows = r.body.data as Row[];
  assert.deepEqual(rows.map((b) => b.warehouseEntryId), ['E2', 'E1']);
  assert.deepEqual(rows[1], {
    warehouseEntryId: 'E1', supplierRef: 'A', billDate: '2026-09-01', dueDate: '2026-10-31', total: 1000, paid: 200, returned: 0, outstanding: 800,
    daysOverdue: rows[1].daysOverdue,
  });
  const today = Date.parse(`${localDateIn(new Date(), companyTimeZone(null, 'SA'))}T00:00:00Z`);
  assert.equal(rows[0].daysOverdue, Math.max(0, Math.floor((today - Date.parse('2026-09-15T00:00:00Z')) / 86_400_000)));
  assert.equal(rows[1].daysOverdue, Math.max(0, Math.floor((today - Date.parse('2026-10-31T00:00:00Z')) / 86_400_000)));
  assert.equal((await call('GET', '/api/suppliers/VX/open-bills', undefined, A)).status, 404);
});

test('أعمار الذمم الدائنة حتى asOf: شرائح الاستحقاق والإجماليات، والتاريخ غير الصالح 400، والافتراضي يوم الشركة', async () => {
  world();
  bill({ id: 'E1', total: 100, billDate: '2026-10-01', dueDate: '2026-10-31' }); // 30 يوماً ⇒ d1_30
  bill({ id: 'E2', total: 200, billDate: '2026-09-01', dueDate: '2026-09-15' }); // 76 ⇒ d61_90
  bill({ id: 'E3', total: 300, billDate: '2026-11-20', dueDate: '2026-12-20' }); // لم يستحق ⇒ current
  bill({ id: 'E4', total: 999, billDate: '2026-12-05', dueDate: '2026-12-05' }); // بعد asOf ⇒ خارج التقرير
  ledger({ kind: 'BILL', amount: 100, docDate: '2026-10-01', entry: 'E1' });
  ledger({ kind: 'BILL', amount: 200, docDate: '2026-09-01', entry: 'E2' });
  ledger({ kind: 'BILL', amount: 300, docDate: '2026-11-20', entry: 'E3' });
  ledger({ kind: 'BILL', amount: 999, docDate: '2026-12-05', entry: 'E4' });
  const r = await call('GET', '/api/suppliers/aging?asOf=2026-11-30', undefined, A);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.asOf, '2026-11-30');
  const row = (r.body.data.rows as Row[]).find((x) => x.supplierId === 'V1')!;
  assert.deepEqual([row.current, row.d1_30, row.d31_60, row.d61_90, row.d90_plus, row.total], [300, 100, 0, 200, 0, 600]);
  assert.equal(row.name, 'مورّد الأول');
  assert.equal(r.body.data.totals.total, 600);
  const bad = await call('GET', '/api/suppliers/aging?asOf=30-11-2026', undefined, A);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'SUPPLIER_INVALID');
  const today = await call('GET', '/api/suppliers/aging', undefined, A);
  assert.equal(today.status, 200);
  assert.equal(today.body.data.asOf, localDateIn(new Date(), companyTimeZone(null, 'SA')));
});

// ═══ السندات: الإنشاء ═══

const basePay = (o: Row = {}) => ({ supplierId: 'V1', amount: 100, method: 'CASH', paidAt: '2026-11-05', ...o });

test('سند الصرف: التحقق 400 SUPPLIER_PAYMENT_INVALID (المبلغ والطريقة والتاريخ ومندوب العهدة) ومورّد شركةٍ أخرى 404 — بلا أي كتابة', async () => {
  world();
  const bad: [Row, string][] = [
    [{ supplierId: undefined }, 'supplierId'],
    [{ amount: 0 }, 'amount'],
    [{ amount: -5 }, 'amount'],
    [{ amount: 'abc' }, 'amount'],
    [{ amount: 1e13 }, 'amount'],
    [{ method: 'GOLD' }, 'method'],
    [{ paidAt: '2026-02-30' }, 'paidAt'],
    [{ paidAt: undefined }, 'paidAt'],
    [{ clientRef: 'مرجع عربي' }, 'clientRef'],
    [{ allocations: [{ warehouseEntryId: 'E1', amount: -1 }] }, 'allocations'],
  ];
  for (const [o, field] of bad) {
    const r = await call('POST', '/api/supplier-payments', basePay(o), A);
    assert.equal(r.status, 400, JSON.stringify(o));
    assert.equal(r.body.code, 'SUPPLIER_PAYMENT_INVALID');
    assert.ok(r.body.errors?.[field], `${field}: ${JSON.stringify(r.body)}`);
  }
  const rounding = await call('POST', '/api/supplier-payments', basePay({ amount: 0.004 }), A);
  assert.equal(rounding.status, 400, 'دون أصغر وحدة في العملة');
  assert.equal(rounding.body.code, 'SUPPLIER_PAYMENT_INVALID');
  const noRep = await call('POST', '/api/supplier-payments', basePay({ method: 'REP_CUSTODY' }), A);
  assert.equal(noRep.status, 400);
  assert.equal(noRep.body.code, 'SUPPLIER_PAYMENT_INVALID');
  const foreignRep = await call('POST', '/api/supplier-payments', basePay({ method: 'REP_CUSTODY', salesRepId: 'RX' }), A);
  assert.equal(foreignRep.status, 400);
  assert.equal(foreignRep.body.code, 'SUPPLIER_PAYMENT_INVALID');
  const foreignVendor = await call('POST', '/api/supplier-payments', basePay({ supplierId: 'VX' }), A);
  assert.equal(foreignVendor.status, 404);
  assert.equal(foreignVendor.body.code, 'SUPPLIER_NOT_FOUND');
  assert.equal(db.t.supplierPayment.length, 0);
  assert.equal(db.t.supplierLedgerEntry.length, 0);
});

test('سند الصرف: 201 بالتخصيص الصريح — الرقم SP-000001، وأرقام فواتير المورّد، وقيد PAYMENT −المبلغ بتاريخ الدفع، وصفر كتابات في gl_*', async () => {
  world();
  bill({ id: 'E1', total: 1150, dueDate: '2026-10-31', supplierRef: 'INV-1' });
  bill({ id: 'E2', total: 500, dueDate: '2026-10-15', supplierRef: 'INV-2' });
  const mark = sinceMark();
  const r = await call('POST', '/api/supplier-payments', basePay({
    amount: '700', method: 'BANK_TRANSFER', reference: ' TRX-9 ', note: 'دفعة أكتوبر',
    allocations: [{ warehouseEntryId: 'E1', amount: 400 }, { warehouseEntryId: 'E2', amount: '300' }],
    autoForEntryId: 'E1', // لا يقبله الجسم (السند الآلي من حركة المستودع وحدها)
  }), A);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = r.body.data;
  assert.equal(v.number, 1);
  assert.equal(v.displayNumber, 'SP-000001');
  assert.equal(v.supplierId, 'V1');
  assert.equal(v.supplierName, 'مورّد الأول');
  assert.equal(v.amount, 700);
  assert.equal(v.method, 'BANK_TRANSFER');
  assert.equal(v.paidAt, '2026-11-05');
  assert.equal(v.reference, 'TRX-9');
  assert.equal(v.note, 'دفعة أكتوبر');
  assert.equal(v.status, 'POSTED');
  assert.equal(v.autoForEntryId, null);
  assert.equal(v.salesRepId, null);
  assert.equal(v.createdBy, ADMIN_NAME);
  assert.equal(v.cancelledAt, null);
  assert.deepEqual(v.allocations, [
    { warehouseEntryId: 'E1', supplierRef: 'INV-1', amount: 400 },
    { warehouseEntryId: 'E2', supplierRef: 'INV-2', amount: 300 },
  ]);
  const led = db.t.supplierLedgerEntry.find((l) => l.supplierPaymentId === v.id)!;
  assert.equal(led.kind, 'PAYMENT');
  assert.equal(led.amountMilli, -700_000n);
  assert.equal(led.ref, 'SP-000001');
  assert.equal(led.docDate.toISOString(), '2026-11-05T00:00:00.000Z');
  assert.deepEqual(glWritesSince(mark), [], 'صفر كتابات في gl_*');
  assert.deepEqual(writesSince(mark).filter((w) => !w.startsWith('admin.')).sort(), ['supplierLedgerEntry.create', 'supplierPayment.create', 'supplierPaymentAllocation.createMany']);
  const open = await call('GET', '/api/suppliers/V1/open-bills', undefined, A);
  assert.deepEqual((open.body.data as Row[]).map((b) => [b.warehouseEntryId, b.outstanding]), [['E2', 200], ['E1', 750]]);
  // السند التالي بالرقم التالي
  const r2 = await call('POST', '/api/supplier-payments', basePay({ amount: 5 }), A);
  assert.equal(r2.body.data.displayNumber, 'SP-000002');
});

test('سند الصرف: تجاوز المتبقّي 409 ALLOCATION_EXCEEDS_OUTSTANDING، وفاتورة نقدية أو لمورّد آخر أو Σ أكبر من المبلغ 400 — والمعاملة تتراجع كاملة', async () => {
  world();
  bill({ id: 'E1', total: 100, supplierRef: 'INV-1' });
  bill({ id: 'E2', mode: 'CASH', total: 50 });
  bill({ id: 'E3', vendorId: 'V2', total: 80 });
  const over = await call('POST', '/api/supplier-payments', basePay({ amount: 150, allocations: [{ warehouseEntryId: 'E1', amount: 120 }] }), A);
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'ALLOCATION_EXCEEDS_OUTSTANDING');
  assert.equal(over.body.details.outstanding, 100);
  assert.equal(over.body.details.requested, 120);
  for (const [o, label] of [
    [{ allocations: [{ warehouseEntryId: 'E2', amount: 10 }] }, 'نقدية'],
    [{ allocations: [{ warehouseEntryId: 'E3', amount: 10 }] }, 'مورّد آخر'],
    [{ amount: 50, allocations: [{ warehouseEntryId: 'E1', amount: 60 }] }, 'Σ > المبلغ'],
    [{ allocations: [{ warehouseEntryId: 'NOPE', amount: 10 }] }, 'غير موجودة'],
  ] as const) {
    const r = await call('POST', '/api/supplier-payments', basePay(o), A);
    assert.equal(r.status, 400, label);
    assert.equal(r.body.code, 'SUPPLIER_PAYMENT_INVALID', label);
  }
  assert.equal(db.t.supplierPayment.length, 0);
  assert.equal(db.t.supplierPaymentAllocation.length, 0);
  assert.equal(db.t.supplierLedgerEntry.length, 0);
  assert.ok(db.calls.some((c) => c.op === 'tx.rollback'));
});

test('سند الصرف: autoAllocate على الأقدم استحقاقاً أولاً، والزائد دفعة مقدّمة غير مخصَّصة (رصيد مدين للمورّد)', async () => {
  world();
  bill({ id: 'E1', total: 1150, dueDate: '2026-10-31' });
  bill({ id: 'E2', total: 500, dueDate: '2026-10-15' });
  ledger({ kind: 'BILL', amount: 1150, docDate: '2026-10-01', entry: 'E1' });
  ledger({ kind: 'BILL', amount: 500, docDate: '2026-10-01', entry: 'E2' });
  const a = await call('POST', '/api/supplier-payments', basePay({ amount: 800, autoAllocate: true }), A);
  assert.equal(a.status, 201);
  assert.deepEqual((a.body.data.allocations as Row[]).map((x) => [x.warehouseEntryId, x.amount]), [['E2', 500], ['E1', 300]]);
  const b = await call('POST', '/api/supplier-payments', basePay({ amount: 1200, autoAllocate: true }), A);
  assert.deepEqual((b.body.data.allocations as Row[]).map((x) => [x.warehouseEntryId, x.amount]), [['E1', 850]]);
  const card = await call('GET', '/api/suppliers/V1', undefined, A);
  assert.equal(card.body.data.balance, -350, '1650 − 800 − 1200');
  assert.equal(card.body.data.openBillsCount, 0);
});

test('سند الصرف: المبلغ بمنازل عملة الشركة نصف-لأعلى — الريال خانتان (10.125 ⇒ 10.13) والدينار الكويتي ثلاث (10.125 كما هو)', async () => {
  world();
  const sar = await call('POST', '/api/supplier-payments', basePay({ amount: 10.125 }), A);
  assert.equal(sar.body.data.amount, 10.13);
  assert.equal(db.t.supplierPayment[0].amountMilli, 10_130n);
  world({ company: { currency: 'KWD' } });
  const kwd = await call('POST', '/api/supplier-payments', basePay({ amount: 10.125 }), A);
  assert.equal(kwd.body.data.amount, 10.125);
  assert.equal(db.t.supplierPayment[0].amountMilli, 10_125n);
});

test('سند الصرف: clientRef المكرَّر ⇒ 200 replay بالسند القائم بلا أي كتابة (تحت قفل المرجع)، ولمبلغ آخر ⇒ 409 CLIENT_REF_REUSED', async () => {
  world();
  const body = basePay({ amount: 250, clientRef: 'c0ffee-1' });
  const first = await call('POST', '/api/supplier-payments', body, A);
  assert.equal(first.status, 201);
  const mark = sinceMark();
  const again = await call('POST', '/api/supplier-payments', body, A);
  assert.equal(again.status, 200);
  assert.equal(again.body.replay, true);
  assert.equal(again.body.data.id, first.body.data.id);
  assert.equal(again.body.data.displayNumber, 'SP-000001');
  assert.deepEqual(writesSince(mark).filter((w) => !w.startsWith('admin.')), [], 'لا كتابة في الإعادة');
  const lock = db.calls.slice(mark).find((c) => c.op === '$executeRaw');
  assert.ok(lock && String((lock.args as Row).values?.[0]).startsWith('supplier-payment-ref:T1:c0ffee-1') && lock.inTx, 'قفل المرجع داخل المعاملة');
  assert.equal(db.t.supplierPayment.length, 1);
  const reused = await call('POST', '/api/supplier-payments', { ...body, amount: 251 }, A);
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, 'CLIENT_REF_REUSED');
  // المرجع نفسه في شركةٍ أخرى سندٌ مستقل (العزل)
  db.seed('admin', { id: 'b1', tenantId: T2, role: 'ADMIN', name: 'مدير آخر', isActive: true, lastSeenAt: new Date(), canDelete: true, canManageVanStock: true });
  const other = await call('POST', '/api/supplier-payments', { ...body, supplierId: 'VX' }, auth({ id: 'b1', tenantId: T2, name: 'مدير آخر' }));
  assert.equal(other.status, 201);
  assert.equal(other.body.data.displayNumber, 'SP-000001', 'الترقيم لكل شركة');
});

test('سند الصرف من عهدة مندوب: المستخدم المقيّد لا يدفع من عهدة مندوبٍ خارج نطاقه (400 برسالة غير الموجود) ويدفع من عهدة من يراه', async () => {
  world({ admin: { scopeEnabled: true, scopeMode: 'LISTS' } });
  db.seed('salesRep', { id: 'R2', tenantId: T, name: 'مندوب الجنوب', adminScopes: [{ adminId: 'a1' }] });
  const hidden = await call('POST', '/api/supplier-payments', basePay({ method: 'REP_CUSTODY', salesRepId: 'R1' }), A);
  assert.equal(hidden.status, 400);
  assert.equal(hidden.body.code, 'SUPPLIER_PAYMENT_INVALID');
  assert.equal(hidden.body.message, 'المندوب غير موجود في الشركة');
  const seen = await call('POST', '/api/supplier-payments', basePay({ method: 'REP_CUSTODY', salesRepId: 'R2' }), A);
  assert.equal(seen.status, 201, JSON.stringify(seen.body));
  assert.equal(seen.body.data.salesRepId, 'R2');
  assert.equal(seen.body.data.salesRepName, 'مندوب الجنوب');
  // طريقةٌ غير العهدة: المندوب يُهمل
  const cash = await call('POST', '/api/supplier-payments', basePay({ method: 'CASH', salesRepId: 'R1' }), A);
  assert.equal(cash.status, 201);
  assert.equal(cash.body.data.salesRepId, null);
});

// ═══ السندات: القائمة والعرض والإلغاء ═══

function paymentsWorld(): void {
  world();
  bill({ id: 'E1', total: 1000, supplierRef: 'INV-1' });
  payment({ id: 'P1', number: 1, amount: 100, paidAt: '2026-10-01', allocations: [['E1', 100]] });
  payment({ id: 'P2', number: 2, amount: 200, paidAt: '2026-10-15', method: 'REP_CUSTODY', salesRepId: 'R1' });
  payment({ id: 'P3', number: 3, amount: 300, paidAt: '2026-11-01', status: 'CANCELLED' });
  db.seed('glVendor', { id: 'V3', tenantId: T, name: 'مورّد ثالث' });
  payment({ id: 'P4', number: 4, amount: 400, paidAt: '2026-10-20', vendorId: 'V3' });
  payment({ id: 'PX', number: 1, amount: 999, paidAt: '2026-10-20', vendorId: 'VX', tenantId: T2 });
}

test('قائمة السندات: الأحدث أولاً، وفلاتر المورّد والحالة والفترة والصفحات، والتاريخ أو الحالة غير الصالحة 400، والعزل', async () => {
  paymentsWorld();
  const list = async (qs: string) => {
    const r = await call('GET', `/api/supplier-payments${qs}`, undefined, A);
    assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`);
    return r.body.data as { items: Row[]; total: number };
  };
  const all = await list('');
  assert.deepEqual(all.items.map((p) => p.id), ['P3', 'P4', 'P2', 'P1']);
  assert.equal(all.total, 4, 'سند شركةٍ أخرى لا يُعدّ');
  assert.deepEqual((await list('?supplierId=V1')).items.map((p) => p.id), ['P3', 'P2', 'P1']);
  assert.deepEqual((await list('?status=cancelled')).items.map((p) => p.id), ['P3']);
  assert.deepEqual((await list('?status=all')).items.length, 4);
  assert.deepEqual((await list('?from=2026-10-10&to=2026-10-31')).items.map((p) => p.id), ['P4', 'P2']);
  assert.deepEqual((await list('?supplierId=VX')).items, [], 'مورّد شركةٍ أخرى');
  const page = await list('?limit=1&page=2');
  assert.deepEqual(page.items.map((p) => p.id), ['P4']);
  assert.equal(page.total, 4);
  const p2 = all.items.find((p) => p.id === 'P2')!;
  assert.equal(p2.salesRepName, 'مندوب الشمال');
  assert.equal(p2.amount, 200);
  assert.equal(all.items.find((p) => p.id === 'P1')!.allocations[0].supplierRef, 'INV-1');
  for (const qs of ['?from=2026-1-1', '?status=VOID']) {
    const bad = await call('GET', `/api/supplier-payments${qs}`, undefined, A);
    assert.equal(bad.status, 400, qs);
    assert.equal(bad.body.code, 'SUPPLIER_PAYMENT_INVALID');
  }
});

test('قائمة السندات: عدد الاستعلامات لا يتبع عدد السندات (أسماء المناديب وأرقام الفواتير باستعلامين)', async () => {
  const queriesFor = async (n: number) => {
    world();
    for (let i = 0; i < n; i++) {
      db.seed('salesRep', { id: `RR${i}`, tenantId: T, name: `مندوب ${i}`, adminScopes: [] });
      bill({ id: `B${i}`, total: 100 });
      payment({ id: `Q${i}`, number: i + 1, amount: 10, paidAt: '2026-10-01', method: 'REP_CUSTODY', salesRepId: `RR${i}`, allocations: [[`B${i}`, 10]] });
    }
    const mark = sinceMark();
    const r = await call('GET', '/api/supplier-payments?limit=200', undefined, A);
    assert.equal(r.body.data.items.length, n);
    return db.calls.slice(mark).filter((c) => !c.op.startsWith('admin.') && !c.op.startsWith('tenant.')).length;
  };
  assert.equal(await queriesFor(2), await queriesFor(15));
});

test('عرض السند للطباعة — وسند شركةٍ أخرى 404 SUPPLIER_PAYMENT_NOT_FOUND', async () => {
  paymentsWorld();
  const r = await call('GET', '/api/supplier-payments/P2', undefined, A);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.displayNumber, 'SP-000002');
  assert.equal(r.body.data.method, 'REP_CUSTODY');
  assert.equal(r.body.data.paidAt, '2026-10-15');
  assert.equal(typeof r.body.data.createdAt, 'string');
  const x = await call('GET', '/api/supplier-payments/PX', undefined, A);
  assert.equal(x.status, 404);
  assert.equal(x.body.code, 'SUPPLIER_PAYMENT_NOT_FOUND');
});

test('إلغاء السند: 200 CANCELLED بقيد PAYMENT_REV يعكس الأصل ويعيد متبقّي الفاتورة، والثاني 409، والآلي 409 AUTO_PAYMENT_CANCEL_VIA_ENTRY، وسند شركةٍ أخرى 404 — بلا gl_*', async () => {
  paymentsWorld();
  const before = await call('GET', '/api/suppliers/V1/open-bills', undefined, A);
  assert.equal(before.body.data[0].outstanding, 900);
  const mark = sinceMark();
  const r = await call('POST', '/api/supplier-payments/P1/cancel', { reason: '  مكرّر  ' }, A);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'CANCELLED');
  assert.equal(r.body.data.cancelReason, 'مكرّر');
  assert.equal(typeof r.body.data.cancelledAt, 'string');
  const original = db.t.supplierLedgerEntry.find((l) => l.supplierPaymentId === 'P1' && l.kind === 'PAYMENT')!;
  const rev = db.t.supplierLedgerEntry.find((l) => l.supplierPaymentId === 'P1' && l.kind === 'PAYMENT_REV')!;
  assert.equal(rev.amountMilli, -original.amountMilli);
  assert.equal(rev.reversesId, original.id);
  assert.equal(rev.ref, 'SP-000001');
  assert.equal(rev.note, 'مكرّر');
  assert.equal(rev.createdBy, ADMIN_NAME);
  assert.ok(rev.docDate.getTime() >= day('2026-10-01').getTime(), 'العكس لا يسبق الدفع');
  assert.deepEqual(glWritesSince(mark), []);
  const after = await call('GET', '/api/suppliers/V1/open-bills', undefined, A);
  assert.equal(after.body.data[0].outstanding, 1000, 'التخصيص الملغى لا يُحسب');

  const again = await call('POST', '/api/supplier-payments/P1/cancel', {}, A);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'SUPPLIER_PAYMENT_ALREADY_CANCELLED');

  bill({ id: 'E2', mode: 'CASH', total: 50 });
  payment({ id: 'PA', number: 9, amount: 50, paidAt: '2026-10-02', autoFor: 'E2', allocations: [['E2', 50]] });
  const m2 = sinceMark();
  const auto = await call('POST', '/api/supplier-payments/PA/cancel', {}, A);
  assert.equal(auto.status, 409);
  assert.equal(auto.body.code, 'AUTO_PAYMENT_CANCEL_VIA_ENTRY');
  assert.deepEqual(writesSince(m2).filter((w) => !w.startsWith('admin.')), [], 'الآلي بلا كتابة');

  const foreign = await call('POST', '/api/supplier-payments/PX/cancel', {}, A);
  assert.equal(foreign.status, 404);
  assert.equal(db.t.supplierPayment.find((p) => p.id === 'PX')!.status, 'POSTED');

  const long = await call('POST', '/api/supplier-payments/P2/cancel', { reason: 'x'.repeat(501) }, A);
  assert.equal(long.status, 400);
  assert.equal(long.body.code, 'SUPPLIER_PAYMENT_INVALID');
  assert.equal(db.t.supplierPayment.find((p) => p.id === 'P2')!.status, 'POSTED');
});

// ═══ ثوابت المصدر ═══

test('ثوابت: التركيب في index.ts بعد المستودع، والمسارات بعلامتي اقتباس مفردتين و/aging قبل /:id، ولا استيراد لـservices/gl، والكتابة في gl_* سجلّ الموردين وحده', () => {
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
  const index = read('index.ts');
  assert.ok(index.includes("import suppliersRouter from './routes/suppliers';"));
  assert.ok(index.includes("import supplierPaymentsRouter from './routes/supplierPayments';"));
  const at = (s: string) => index.indexOf(s);
  assert.ok(at("app.use('/api/suppliers', suppliersRouter);") > at("app.use('/api/warehouse', warehouseRouter);"));
  assert.ok(at("app.use('/api/supplier-payments', supplierPaymentsRouter);") > at("app.use('/api', requireRepLiveLocation);"));
  const sup = read('routes/suppliers.ts');
  const pay = read('routes/supplierPayments.ts');
  for (const r of ["router.get('/',", "router.get('/aging',", "router.get('/:id',", "router.post('/',", "router.put('/:id',", "router.delete('/:id',", "router.get('/:id/statement',", "router.get('/:id/open-bills',"]) {
    assert.ok(sup.includes(r), r);
  }
  assert.ok(sup.indexOf("router.get('/aging',") < sup.indexOf("router.get('/:id',"), '/aging قبل /:id');
  for (const r of ["router.get('/',", "router.get('/:id',", "router.post('/',", "router.post('/:id/cancel',"]) assert.ok(pay.includes(r), r);
  for (const src of [sup, pay]) {
    assert.ok(!/from '\.\.\/services\/gl/.test(src), 'لا استيراد لمحرّك الدفاتر');
    assert.ok(!/\.\s*(glAccount|glMove|glJournal|glSettings|glTax)\w*\s*\.\s*(create|update|upsert|delete)/.test(src), 'لا كتابة في دفاتر gl_*');
  }
  assert.ok(!/glVendor\s*\.\s*(create|update|delete)/.test(pay), 'السندات لا تكتب سجلّ الموردين');
});
