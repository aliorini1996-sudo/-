// فوترة ZATCA (Z5.1a، D2) — بيانات المشتري في مسارات العملاء والأصناف: بوابة الكتابة، قائمة بيانات الفوترة، نقطة المندوب الضيّقة
// (Q3)، «اعتماد التصنيف المقترح»، وتقرير الجاهزية — بقاعدة مزيّفة في الذاكرة وخادم على 127.0.0.1 (لا قاعدة ولا شبكة)، مع حرّاس
// نصّية على مواضع الربط في customers.ts وproducts.ts: الشركة غير الجامعة كما اليوم حرفياً.
import { guardHits } from '../compliance/zatca/__fixtures__/z3-netguard';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import {
  BUYER_DOWNGRADE_AUDIT_EVENT, BuyerDataDb, CustomerBuyerDataDeps, applyBuyerGateToWrite, buyerDataReadiness, buyerListWhere,
  createCustomerBuyerDataRouter, scanBuyerData,
} from '../routes/customersZatca';
import { applyProductVatGate } from '../routes/productsZatca';
import { TENANT, fakeSleep, harness } from '../compliance/zatca/__fixtures__/z4-harness';
import { createZatcaRouter, zatcaEnvConfig, zatcaErrorGuard } from '../routes/zatca';
import type { AuthRequest } from '../types';

after(() => { assert.equal(guardHits(), 0, 'محاولة شبكة حقيقية'); });

const SRC = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

// ─── قاعدة مزيّفة ───

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function matches(row: Row, where: any): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'AND') { if (!(cond as unknown[]).every(c => matches(row, c))) return false; continue; }
    if (k === 'OR') { if (!(cond as unknown[]).some(c => matches(row, c))) return false; continue; }
    if (k === 'assignments') { if (!(row.assignments ?? []).includes((cond as any).some.salesRepId)) return false; continue; } // eslint-disable-line @typescript-eslint/no-explicit-any
    if (k === 'adminScopes') { if (!(row.adminScopes ?? []).includes((cond as any).some.adminId)) return false; continue; } // eslint-disable-line @typescript-eslint/no-explicit-any
    const v = row[k] ?? null;
    if (cond === null) { if (v !== null) return false; continue; }
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('not' in c && (c.not === null ? v === null : v === c.not)) return false;
      if ('contains' in c && !(typeof v === 'string' && v.includes(c.contains as string))) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

const selectOf = (row: Row, select?: Record<string, boolean>) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k] ?? null])) : { ...row });

function fakeDb(o: { flag: boolean; country?: string | null; startedAt?: Date | null; customers?: Row[]; reps?: Row[]; products?: Row[] }) {
  const calls: string[] = [];
  const customers = (o.customers ?? []).map(c => ({ ...c }));
  const reps = (o.reps ?? []).map(r => ({ ...r }));
  const products = (o.products ?? []).map(p => ({ ...p }));
  const db = {
    tenant: {
      findUnique: async (_a: unknown) => {
        calls.push('tenant.findUnique');
        return { zatcaPhase2Enabled: o.flag, settings: { countryCode: o.country === undefined ? 'SA' : o.country, zatcaPhase2StartedAt: o.startedAt ?? null } };
      },
    },
    customer: {
      findFirst: async (a: { where: Row; select?: Record<string, boolean> }) => {
        calls.push('customer.findFirst');
        const r = customers.find(c => matches(c, a.where));
        return r ? selectOf(r, a.select) : null;
      },
      findMany: async (a: { where: Row; select?: Record<string, boolean>; orderBy?: Array<Record<string, 'asc' | 'desc'>>; take?: number; cursor?: { id: string }; skip?: number }) => {
        calls.push('customer.findMany');
        let rows = customers.filter(c => matches(c, a.where));
        for (const ob of [...(a.orderBy ?? [])].reverse()) {
          const [k] = Object.keys(ob);
          rows = [...rows].sort((x, y) => String(x[k] ?? '').localeCompare(String(y[k] ?? '')));
        }
        let start = 0;
        if (a.cursor) start = rows.findIndex(r => r.id === a.cursor!.id) + (a.skip ?? 0);
        return rows.slice(start, a.take === undefined ? undefined : start + a.take).map(r => selectOf(r, a.select));
      },
      update: async (a: { where: { id: string }; data: Row; select?: Record<string, boolean> }) => {
        calls.push(`customer.update:${Object.keys(a.data).sort().join(',')}`);
        const r = customers.find(c => c.id === a.where.id)!;
        Object.assign(r, a.data);
        return selectOf(r, a.select);
      },
      updateMany: async (a: { where: Row; data: Row }) => {
        calls.push('customer.updateMany');
        const rows = customers.filter(c => matches(c, a.where));
        for (const r of rows) Object.assign(r, a.data);
        return { count: rows.length };
      },
    },
    salesRep: {
      findUnique: async (a: { where: { id: string } }) => { calls.push('salesRep.findUnique'); return reps.find(r => r.id === a.where.id) ?? null; },
      findMany: async (a: { where: Row }) => { calls.push('salesRep.findMany'); return reps.filter(r => matches(r, a.where)); },
    },
    product: {
      findFirst: async (a: { where: Row; select?: Record<string, boolean> }) => {
        calls.push('product.findFirst');
        const r = products.find(p => matches(p, a.where));
        return r ? selectOf(r, a.select) : null;
      },
      count: async (a: { where: Row }) => { calls.push('product.count'); return products.filter(p => matches(p, a.where)).length; },
    },
  };
  return { db: db as unknown as BuyerDataDb, calls, customers };
}

// ─── عملاء التجهيز ───

const COMPLETE = {
  id: 'c-complete', tenantId: TENANT, code: 'C1', name: 'أبو خالد', businessName: 'مؤسسة البقالة', phone: '0500000001', status: 'ACTIVE',
  taxNumber: '311111111111113', commercialReg: '2050012345', buyerType: 'BUSINESS', buyerIdScheme: null, buyerIdValue: null, addrStreet: 'شارع الملك فهد',
  addrBuildingNo: '7788', addrAdditionalNo: null, addrPostalCode: '31952', district: 'الروضة', city: 'الدمام', countryCode: 'SA', channel: 'MT',
  creditLimit: 5000, lat: 24.1, lng: 46.1, assignments: ['rep-1'], adminScopes: [],
};
const VAT_ONLY = { id: 'c-vat', tenantId: TENANT, code: 'C2', name: 'تموينات النور', phone: '0500000002', status: 'ACTIVE', taxNumber: '300000000000003', channel: null, assignments: ['rep-2'], adminScopes: ['admin-scoped'], creditLimit: 100 };
const CHANNEL_ONLY = { id: 'c-channel', tenantId: TENANT, code: 'C3', name: 'بقالة الحي', phone: '0500000003', status: 'ACTIVE', channel: 'WHOLESALE', assignments: ['rep-1'], adminScopes: [] };
const WALK_IN = { id: 'c-walkin', tenantId: TENANT, code: 'C4', name: 'محمد', phone: '0500000004', status: 'ACTIVE', channel: 'CASH_VAN', assignments: ['rep-1'], adminScopes: [] };
const INACTIVE_B2B = { id: 'c-inactive', tenantId: TENANT, code: 'C5', name: 'شركة موقوفة', phone: '0500000005', status: 'INACTIVE', commercialReg: '1010101010', assignments: [], adminScopes: [] };
const OTHER_TENANT = { id: 'c-other', tenantId: 'tenant-2', code: 'C6', name: 'عميل شركة أخرى', phone: '0500000006', status: 'ACTIVE', taxNumber: '300000000000003', assignments: ['rep-1'], adminScopes: [] };
const ALL = [COMPLETE, VAT_ONLY, CHANNEL_ONLY, WALK_IN, INACTIVE_B2B, OTHER_TENANT];

const ADMIN = { id: 'admin-7', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
const REP1 = { id: 'rep-1', role: 'SALES_REP', name: 'مندوب', tenantId: TENANT };

/** نطاق مزيّف بالقاعدة نفسها: المندوب مع العزل ⇒ الإسناد؛ الإداري المقيّد ⇒ نطاقه. */
function deps(db: BuyerDataDb, o: { isolation?: boolean; scopedAdmins?: string[]; audit?: string[] } = {}): CustomerBuyerDataDeps {
  const scope = async (req: AuthRequest): Promise<Record<string, unknown>> => {
    if (req.user?.role === 'SALES_REP') return o.isolation ? { assignments: { some: { salesRepId: req.user.id } } } : {};
    return (o.scopedAdmins ?? []).includes(req.user?.id ?? '') ? { adminScopes: { some: { adminId: req.user!.id } } } : {};
  };
  return {
    db,
    customerScope: scope,
    canAccessCustomer: async (req, tid, id) => {
      const s = await scope(req);
      if (Object.keys(s).length === 0) return true;
      return (await db.customer.findFirst({ where: { id, tenantId: tid, ...s }, select: { id: true } })) !== null;
    },
    tenantId: req => req.user!.tenantId!,
    audit: line => o.audit?.push(line),
  };
}

const reqOf = (user: object, body: unknown) => ({ user, body }) as unknown as AuthRequest;

// ─── بوابة الكتابة (POST/PUT) ───

test('غير الجامعة (العلم مطفأ بلا تفعيل، أو دولة غير SA): الحمولة كما هي — لا تطبيع ولا فحص ولا حقول جديدة؛ وبلا حقول الفوترة لا استعلام', async () => {
  for (const cfg of [{ flag: false }, { flag: true, country: 'EG' }, { flag: false, startedAt: new Date('2026-11-20T06:00:00Z'), country: 'AE' }]) {
    const f = fakeDb(cfg);
    const body = { name: 'x', phone: '0500000000', taxNumber: '123', commercialReg: ' ١٢٣ ', buyerType: 'PERSON', addrBuildingNo: '1' };
    const data: Record<string, unknown> = { name: 'x', phone: '0500000000', taxNumber: '123', commercialReg: ' ١٢٣ ' };
    const before = JSON.stringify(data);
    const r = await applyBuyerGateToWrite(deps(f.db), reqOf(ADMIN, body), TENANT, data, { customerId: null, replay: false });
    assert.deepEqual(r, { ok: true, warnings: null });
    assert.equal(JSON.stringify(data), before, JSON.stringify(cfg));
    assert.deepEqual(f.calls, ['tenant.findUnique'], 'قراءة البوابة وحدها');
  }
  const f = fakeDb({ flag: true });
  const r = await applyBuyerGateToWrite(deps(f.db), reqOf(ADMIN, { name: 'x', phone: '0500000000', city: 'الرياض' }), TENANT, {}, { customerId: null, replay: false });
  assert.deepEqual(r, { ok: true, warnings: null });
  assert.deepEqual(f.calls, [], 'لا حقل فوترة ⇒ لا استعلام');
});

test('الجامعة: تطبيع وكتابة الحقول، و400 CUSTOMER_ZATCA_INVALID بالحقول للخطأ — والشركة المفعّلة حيّاً بعلم مطفأ تبقى جامعة (نقد الخطة 5)', async () => {
  for (const cfg of [{ flag: true }, { flag: false, startedAt: new Date('2026-11-20T06:00:00Z') }]) {
    const f = fakeDb(cfg);
    const body = { name: 'x', phone: '0500000000', taxNumber: '٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣', buyerType: 'business', addrBuildingNo: '١٢٣٤', addrPostalCode: ' 12345 ', countryCode: '' };
    const data: Record<string, unknown> = { name: 'x', phone: '0500000000', taxNumber: body.taxNumber };
    const r = await applyBuyerGateToWrite(deps(f.db), reqOf(ADMIN, body), TENANT, data, { customerId: null, replay: false });
    assert.deepEqual(r, { ok: true, warnings: null });
    assert.deepEqual(data, { name: 'x', phone: '0500000000', taxNumber: '300000000000003', buyerType: 'BUSINESS', addrBuildingNo: '1234', addrPostalCode: '12345', countryCode: null });

    const bad = await applyBuyerGateToWrite(deps(f.db), reqOf(ADMIN, { taxNumber: '123', addrBuildingNo: '12' }), TENANT, {}, { customerId: null, replay: false });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'CUSTOMER_ZATCA_INVALID');
    assert.match(String(bad.body.message), /^بيانات الفوترة الإلكترونية للعميل غير صحيحة: /);
    assert.deepEqual((bad.body.fieldErrors as { field: string }[]).map(e => e.field).sort(), ['addrBuildingNo', 'taxNumber']);
  }
});

test('الرفع المؤجَّل (إنشاء بـclientRef): لا 400 أبداً — تُسقط حقول المرحلة الثانية الخاطئة، والقديمة تُحفظ كما اليوم، ويعود warnings', async () => {
  const f = fakeDb({ flag: true });
  const body = { name: 'x', phone: '0500000000', taxNumber: '123', buyerType: 'PERSON', addrBuildingNo: '12', addrStreet: 'شارع', buyerIdScheme: 7 };
  const data: Record<string, unknown> = { name: 'x', phone: '0500000000', taxNumber: '123' };
  const r = await applyBuyerGateToWrite(deps(f.db), reqOf(REP1, body), TENANT, data, { customerId: null, replay: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(data, { name: 'x', phone: '0500000000', taxNumber: '123', addrStreet: 'شارع' });
  assert.deepEqual((r.warnings ?? []).map(w => w.field).sort(), ['addrBuildingNo', 'buyerIdScheme', 'buyerType', 'taxNumber']);
});

test('التعديل: المتغيّر وحده يُفحص (بيانات قديمة خاطئة لا تمنع)، والمندوب لا يحوّل منشأة إلى فرد (403)، والإدارة تفعل بسطر تدقيق', async () => {
  const stale = { ...VAT_ONLY, id: 'c-stale', taxNumber: '123' };
  const f = fakeDb({ flag: true, customers: [stale, COMPLETE, VAT_ONLY] });
  const data: Record<string, unknown> = {};
  const ok = await applyBuyerGateToWrite(deps(f.db), reqOf(ADMIN, { taxNumber: '123', addrBuildingNo: '1234' }), TENANT, data, { customerId: 'c-stale', replay: false });
  assert.deepEqual(ok, { ok: true, warnings: null });
  assert.deepEqual(data, { taxNumber: '123', addrBuildingNo: '1234' });

  // مسح الرقم الضريبي لعميل صنّفه هو وحده منشأةً ⇒ مبسطة: تخفيض
  const repDown = await applyBuyerGateToWrite(deps(f.db), reqOf(REP1, { taxNumber: null }), TENANT, {}, { customerId: 'c-vat', replay: false });
  assert.equal(repDown.ok, false);
  if (!repDown.ok) assert.deepEqual([repDown.status, repDown.body.code], [403, 'CUSTOMER_BUYER_REP_RESTRICTED']);
  const repInd = await applyBuyerGateToWrite(deps(f.db), reqOf(REP1, { buyerType: 'INDIVIDUAL' }), TENANT, {}, { customerId: 'c-complete', replay: false });
  assert.equal(repInd.ok, false);
  // منشأة صريحة يُمسح رقمها: ليست تخفيضاً (تبقى ضريبية ناقصة — لا تحايل على الحجب)
  const repClear = await applyBuyerGateToWrite(deps(f.db), reqOf(REP1, { taxNumber: null, commercialReg: null }), TENANT, {}, { customerId: 'c-complete', replay: false });
  assert.equal(repClear.ok, true);

  const audit: string[] = [];
  const adminData: Record<string, unknown> = {};
  const adminDown = await applyBuyerGateToWrite(deps(f.db, { audit }), reqOf({ ...ADMIN, impersonated: true }, { buyerType: 'INDIVIDUAL' }), TENANT, adminData, { customerId: 'c-complete', replay: false });
  assert.equal(adminDown.ok, true);
  assert.equal(adminData.buyerType, 'INDIVIDUAL');
  assert.equal(audit.length, 1);
  const line = JSON.parse(audit[0]);
  assert.deepEqual(line, { event: BUYER_DOWNGRADE_AUDIT_EVENT, tenantId: TENANT, customerId: 'c-complete', actorId: 'admin-7', role: 'ADMIN', impersonated: true, fields: ['buyerType'], route: 'PUT /customers/:id' });
  assert.doesNotMatch(audit[0], /311111111111113|INDIVIDUAL/, 'بلا قيم');
});

// ─── الموجّه عبر HTTP ───

async function serve(d: CustomerBuyerDataDeps, user: () => object) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => { (req as AuthRequest).user = user() as AuthRequest['user']; next(); });
  app.use('/api/customers', createCustomerBuyerDataRouter(d));
  // ما لا يلتقطه الموجّه يصل هنا (كـGET /:id في customers.ts)
  app.use('/api/customers', (_req: Request, res: Response) => { res.status(418).json({ fallthrough: true }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(500).json({ error: String(err) }); });
  const server = http.createServer(app);
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  const call = (method: string, url: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path: `/api/customers${url}`, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
  return { call, close: () => new Promise(r => server.close(r)) };
}

test('GET /zatca-buyer-data: 404 لغير الجامعة؛ للجامعة صفوف السلّة والملخّص، بنطاق الشركة والحالة (ACTIVE افتراضاً)', async () => {
  const off = fakeDb({ flag: false, customers: ALL });
  let s = await serve(deps(off.db), () => ADMIN);
  try {
    const res = await s.call('GET', '/zatca-buyer-data');
    assert.deepEqual([res.status, res.body.code], [404, 'ZATCA_BUYER_DATA_NOT_ENABLED']);
    assert.deepEqual(off.calls, ['tenant.findUnique']);
  } finally { await s.close(); }

  const on = fakeDb({ flag: true, customers: ALL });
  s = await serve(deps(on.db), () => ADMIN);
  try {
    const inc = await s.call('GET', '/zatca-buyer-data');
    assert.equal(inc.status, 200);
    assert.deepEqual(inc.body.data.map((r: { id: string }) => r.id), ['c-vat']);
    assert.deepEqual(inc.body.summary, { effectiveB2b: 2, complete: 1, incomplete: 1, unclassifiedWithSignals: 1, scanned: 3, truncated: false });
    const row = inc.body.data[0];
    assert.deepEqual(row.missingFields, ['addrStreet', 'city', 'addrBuildingNo', 'district', 'addrPostalCode']);
    assert.deepEqual([row.classification, row.subtypeIfIssuedNow, row.suggestedType, row.suggestionSource], ['business', '01', 'BUSINESS', 'vat']);
    assert.equal(row.creditLimit, undefined, 'لا حقول مالية');
    assert.ok(row.issues.every((i: { formField: string | null }) => typeof i.formField === 'string'));
    const unc = await s.call('GET', '/zatca-buyer-data?bucket=unclassified');
    assert.deepEqual(unc.body.data.map((r: { id: string }) => r.id), ['c-channel']);
    const all = await s.call('GET', '/zatca-buyer-data?bucket=all&status=all');
    assert.deepEqual(all.body.data.map((r: { id: string }) => r.id).sort(), ['c-channel', 'c-complete', 'c-inactive', 'c-vat']);
    const search = await s.call('GET', `/zatca-buyer-data?bucket=all&search=${encodeURIComponent('النور')}`);
    assert.deepEqual(search.body.data.map((r: { id: string }) => r.id), ['c-vat']);
    const byRep = await s.call('GET', '/zatca-buyer-data?bucket=all&repId=rep-1');
    assert.deepEqual(byRep.body.data.map((r: { id: string }) => r.id).sort(), ['c-channel', 'c-complete']);
    const summaryOnly = await s.call('GET', '/zatca-buyer-data?limit=0');
    assert.deepEqual([summaryOnly.body.data, summaryOnly.body.nextCursor, summaryOnly.body.summary.incomplete], [[], null, 1]);
  } finally { await s.close(); }
});

test('نطاق العملاء يبقى في AND مع البحث والمندوب (نقد الخطة 22): المندوب مع العزل والإداري المقيّد لا يريان غير نطاقهما', async () => {
  const where = buyerListWhere({ tid: TENANT, scope: { assignments: { some: { salesRepId: 'rep-1' } } }, status: 'ACTIVE', search: 'x', repId: 'rep-2' });
  assert.deepEqual(Object.keys(where).sort(), ['AND', 'tenantId']);
  const and = where.AND as Record<string, unknown>[];
  assert.ok(and.some(c => 'assignments' in c && (c.assignments as { some: { salesRepId: string } }).some.salesRepId === 'rep-1'));
  assert.ok(and.some(c => 'assignments' in c && (c.assignments as { some: { salesRepId: string } }).some.salesRepId === 'rep-2'));
  assert.ok(and.some(c => 'OR' in c && JSON.stringify(c).includes('"contains":"x"')));

  const f = fakeDb({ flag: true, customers: ALL });
  let s = await serve(deps(f.db, { isolation: true }), () => REP1);
  try {
    const all = await s.call('GET', '/zatca-buyer-data?bucket=all&search=' + encodeURIComponent('ا'));
    assert.deepEqual(all.body.data.map((r: { id: string }) => r.id).sort(), ['c-channel', 'c-complete']);
    const spoof = await s.call('GET', '/zatca-buyer-data?bucket=all&repId=rep-2');
    assert.deepEqual(spoof.body.data.map((r: { id: string }) => r.id).sort(), ['c-channel', 'c-complete'], 'repId للإدارة وحدها');
  } finally { await s.close(); }
  s = await serve(deps(f.db, { scopedAdmins: ['admin-scoped'] }), () => ({ ...ADMIN, id: 'admin-scoped' }));
  try {
    const all = await s.call('GET', '/zatca-buyer-data?bucket=all');
    assert.deepEqual(all.body.data.map((r: { id: string }) => r.id), ['c-vat']);
  } finally { await s.close(); }
});

test('المسح بالمؤشّر: صفحات متتالية بلا تكرار ولا فقد، والملخّص يتوقّف عند حدّه ويعلن الاقتطاع', async () => {
  const many = Array.from({ length: 23 }, (_, i) => ({
    id: `m-${String(i).padStart(2, '0')}`, tenantId: TENANT, code: `M${i}`, name: `عميل ${String(i).padStart(2, '0')}`, phone: '05', status: 'ACTIVE',
    taxNumber: i % 3 === 0 ? null : '300000000000003', channel: i % 3 === 0 ? 'MT' : null, assignments: [], adminScopes: [],
  }));
  const f = fakeDb({ flag: true, customers: many });
  const where = buyerListWhere({ tid: TENANT, scope: {}, status: 'ACTIVE', search: '', repId: null });
  const limits = { chunk: 4, defaultLimit: 5, maxLimit: 5, pageScanBudget: 7, summaryScanMax: 10 };
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 30; i++) {
    const r = await scanBuyerData(f.db, where, { bucket: 'incomplete', limit: 5, cursor, withSummary: false }, limits);
    seen.push(...r.rows.map(x => x.id as string));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, many.filter(m => m.taxNumber).map(m => m.id));
  const sum = await scanBuyerData(f.db, where, { bucket: 'incomplete', limit: 3, cursor: null, withSummary: true }, limits);
  assert.deepEqual(sum.summary, { effectiveB2b: 6, complete: 0, incomplete: 6, unclassifiedWithSignals: 4, scanned: 10, truncated: true });
  assert.equal(sum.rows.length, 3);
  assert.equal(sum.nextCursor, sum.rows[2].id);
  const full = await scanBuyerData(f.db, where, { bucket: 'all', limit: 0, cursor: null, withSummary: true }, { ...limits, summaryScanMax: 100 });
  assert.deepEqual([full.summary!.scanned, full.summary!.truncated, full.nextCursor], [23, false, null]);
});

test('PATCH /:id/buyer-data (Q3): من يصدر الفواتير بلا تعديل العملاء يُكمل الفارغ من حقول Q3 وحدها — لا مال ولا موقع ولا حالة، ولا اسم منشأة ولا رقم ضريبي ولا سجل، ولا تعديل محفوظ ولا مسح ولا تخفيض', async () => {
  const off = fakeDb({ flag: false, customers: ALL });
  let s = await serve(deps(off.db), () => REP1);
  try {
    const res = await s.call('PATCH', '/c-vat/buyer-data', { addrBuildingNo: '1234' });
    assert.deepEqual([res.status, res.body.code], [404, 'ZATCA_BUYER_DATA_NOT_ENABLED']);
  } finally { await s.close(); }

  const f = fakeDb({
    flag: true, customers: ALL,
    reps: [{ id: 'rep-1', canCreateInvoice: true, canEditCustomer: false }, { id: 'rep-none', canCreateInvoice: false, canEditCustomer: false }, { id: 'rep-edit', canCreateInvoice: false, canEditCustomer: true }],
  });
  let user: object = { ...REP1, id: 'rep-none' };
  const audit: string[] = [];
  s = await serve(deps(f.db, { isolation: true, audit }), () => user);
  try {
    let res = await s.call('PATCH', '/c-complete/buyer-data', { addrBuildingNo: '1234' });
    assert.deepEqual([res.status, res.body.code], [403, 'CUSTOMER_BUYER_DATA_FORBIDDEN']);

    user = REP1;
    res = await s.call('PATCH', '/c-vat/buyer-data', { addrBuildingNo: '1234' });
    assert.deepEqual([res.status, res.body.code], [404, 'CUSTOMER_NOT_FOUND'], 'خارج نطاق المندوب');

    const vatRow = f.customers.find(c => c.id === 'c-channel')!;
    // اسم المنشأة والرقم الضريبي والسجل خارج Q3 — ولو كانت فارغة: 403 بالحقول ولا كتابة
    const before = f.calls.filter(c => c.startsWith('customer.update:')).length;
    res = await s.call('PATCH', '/c-channel/buyer-data', { businessName: 'بقالة الحي', taxNumber: '300000000000003', commercialReg: '1010101010', addrStreet: 'شارع' });
    assert.deepEqual([res.status, res.body.code, res.body.fields], [403, 'CUSTOMER_BUYER_REP_RESTRICTED', ['businessName', 'taxNumber', 'commercialReg']]);
    assert.match(res.body.message, /الناقصة فقط/);
    assert.equal(f.calls.filter(c => c.startsWith('customer.update:')).length, before);

    res = await s.call('PATCH', '/c-channel/buyer-data', {
      buyerType: 'business', buyerIdScheme: 'crn', buyerIdValue: '1010101010', addrStreet: 'شارع', addrBuildingNo: '١٢٣٤', addrPostalCode: '12345', city: 'الرياض',
      district: 'الملز', countryCode: 'SA', creditLimit: 999999, lat: 1, lng: 1, status: 'BLOCKED', balance: 0, assignments: [], name: 'تغيير الاسم', phone: '1',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(f.calls.filter(c => c.startsWith('customer.update:')).pop(), 'customer.update:addrBuildingNo,addrPostalCode,addrStreet,buyerIdScheme,buyerIdValue,buyerType,city,district');
    assert.deepEqual([vatRow.creditLimit, vatRow.lat, vatRow.status, vatRow.name, vatRow.phone, vatRow.businessName], [undefined, undefined, 'ACTIVE', 'بقالة الحي', '0500000003', undefined]);
    assert.deepEqual([res.body.data.buyerType, res.body.data.addrBuildingNo, res.body.data.complete, res.body.data.classification], ['BUSINESS', '1234', true, 'business']);
    assert.deepEqual(res.body.changed.length, 8, 'الدولة SA لعميل بلا دولة ليست تغييراً');

    // تعديل قيمة محفوظة (ولو أكملها هو): 403 — والمحفوظ نفسه مع حقل فارغ جديد: 200
    res = await s.call('PATCH', '/c-channel/buyer-data', { city: 'جدة', addrAdditionalNo: '1234' });
    assert.deepEqual([res.status, res.body.code, res.body.fields], [403, 'CUSTOMER_BUYER_REP_RESTRICTED', ['city']]);
    res = await s.call('PATCH', '/c-channel/buyer-data', { city: 'الرياض', businessName: null, addrAdditionalNo: '1234' });
    assert.deepEqual([res.status, res.body.changed], [200, ['addrAdditionalNo']]);
    vatRow.addrAdditionalNo = null;

    // تكرار الطلب نفسه: لا كتابة
    const writes = f.calls.filter(c => c.startsWith('customer.update:')).length;
    res = await s.call('PATCH', '/c-channel/buyer-data', { addrBuildingNo: '1234' });
    assert.deepEqual([res.status, res.body.changed], [200, []]);
    assert.equal(f.calls.filter(c => c.startsWith('customer.update:')).length, writes);

    res = await s.call('PATCH', '/c-channel/buyer-data', { district: null });
    assert.deepEqual([res.status, res.body.code, res.body.fields], [403, 'CUSTOMER_BUYER_REP_RESTRICTED', ['district']]);
    res = await s.call('PATCH', '/c-complete/buyer-data', { buyerType: 'INDIVIDUAL' });
    assert.deepEqual([res.status, res.body.code], [403, 'CUSTOMER_BUYER_REP_RESTRICTED']);
    res = await s.call('PATCH', '/c-complete/buyer-data', { addrBuildingNo: '12' });
    assert.deepEqual([res.status, res.body.code, res.body.fields], [403, 'CUSTOMER_BUYER_REP_RESTRICTED', ['addrBuildingNo']], 'محفوظ');
    res = await s.call('PATCH', '/c-complete/buyer-data', { addrAdditionalNo: '1'.repeat(17) });
    assert.deepEqual([res.status, res.body.code, res.body.fieldErrors[0].field], [400, 'CUSTOMER_ZATCA_INVALID', 'addrAdditionalNo']);

    user = { ...REP1, id: 'rep-edit' };
    const channelRow = f.customers.find(c => c.id === 'c-channel')!;
    channelRow.assignments = [...channelRow.assignments, 'rep-edit'];
    res = await s.call('PATCH', '/c-channel/buyer-data', { addrAdditionalNo: '12' });
    assert.equal(res.status, 200, 'صلاحية تعديل العملاء تكفي');
    assert.deepEqual(res.body.warnings.map((w: { field: string }) => w.field), ['addrAdditionalNo']);
    // ومعها حقول الفوترة كلها وتعديل المحفوظ (بلا مسح ولا تخفيض)
    res = await s.call('PATCH', '/c-channel/buyer-data', { city: 'جدة', businessName: 'بقالة الحي', commercialReg: '1010101010' });
    assert.deepEqual([res.status, res.body.changed], [200, ['businessName', 'commercialReg', 'city']]);
    res = await s.call('PATCH', '/c-channel/buyer-data', { city: null });
    assert.deepEqual([res.status, res.body.fields, res.body.message], [403, ['city'], 'يمكنك إكمال بيانات الفوترة فقط — مسحها أو تحويل العميل من منشأة إلى فرد للإدارة']);

    user = ADMIN;
    res = await s.call('PATCH', '/c-complete/buyer-data', { taxNumber: null, commercialReg: null, buyerType: null });
    assert.equal(res.status, 200, 'الإدارة تخفّض');
    assert.equal(res.body.data.subtypeIfIssuedNow, '02');
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0]).route, 'PATCH /customers/:id/buyer-data');
    assert.deepEqual(JSON.parse(audit[0]).fields, ['buyerType', 'taxNumber', 'commercialReg']);
  } finally { await s.close(); }
});

test('معرّف منشأة في حقلَي المعرّف وحده (CRN، 700…) ⇒ «غير مصنّف» في القائمة (يلتقطه المرشّح المسبق) ويقبل «اعتماد التصنيف المقترح»', async () => {
  const idOnly = {
    id: 'c-crn', tenantId: TENANT, code: 'C7', name: 'مؤسسة', phone: '0500000007', status: 'ACTIVE', buyerIdScheme: 'CRN', buyerIdValue: '1010101010',
    addrStreet: 's', addrBuildingNo: '1234', district: 'd', city: 'c', addrPostalCode: '12345', assignments: [], adminScopes: [],
  };
  const unified = { id: 'c-700', tenantId: TENANT, code: 'C8', name: 'شركة', phone: '0500000008', status: 'ACTIVE', buyerIdScheme: '700', buyerIdValue: '7000000001', assignments: [], adminScopes: [] };
  const national = { id: 'c-nat', tenantId: TENANT, code: 'C9', name: 'فرد', phone: '0500000009', status: 'ACTIVE', buyerIdScheme: 'NAT', buyerIdValue: '1000000001', assignments: [], adminScopes: [] };
  const emptyValue = { id: 'c-crn-empty', tenantId: TENANT, code: 'C10', name: 'بلا قيمة', phone: '0500000010', status: 'ACTIVE', buyerIdScheme: 'CRN', buyerIdValue: null, assignments: [], adminScopes: [] };
  const f = fakeDb({ flag: true, customers: [idOnly, unified, national, emptyValue, WALK_IN] });
  const s = await serve(deps(f.db), () => ADMIN);
  try {
    const unc = await s.call('GET', '/zatca-buyer-data?bucket=unclassified');
    assert.deepEqual(unc.body.data.map((r: { id: string }) => r.id).sort(), ['c-700', 'c-crn']);
    assert.deepEqual(unc.body.summary, { effectiveB2b: 0, complete: 0, incomplete: 0, unclassifiedWithSignals: 2, scanned: 2, truncated: false });
    const row = unc.body.data.find((r: { id: string }) => r.id === 'c-crn');
    assert.deepEqual([row.classification, row.subtypeIfIssuedNow, row.suggestedType, row.suggestionSource], ['unclassified', '02', 'BUSINESS', 'businessId']);
    const res = await s.call('POST', '/zatca-buyer-data/apply-suggested', { ids: ['c-crn', 'c-700', 'c-nat'] });
    assert.deepEqual(res.body.data, { updated: 2, skipped: 1 });
    const inc = await s.call('GET', '/zatca-buyer-data?bucket=all');
    assert.deepEqual(inc.body.data.map((r: { id: string; bucket: string }) => [r.id, r.bucket]).sort(), [['c-700', 'incomplete'], ['c-crn', 'complete']]);
  } finally { await s.close(); }
});

test('POST /zatca-buyer-data/apply-suggested: للإدارة وحدها، يكتب «منشأة» لمن لم يُصنَّف وله مؤشر — ولا يمسّ الصريح ولا الفرد', async () => {
  const f = fakeDb({ flag: true, customers: ALL });
  let user: object = REP1;
  const s = await serve(deps(f.db), () => user);
  try {
    let res = await s.call('POST', '/zatca-buyer-data/apply-suggested', { ids: ['c-channel'] });
    assert.deepEqual([res.status, res.body.code], [403, 'FORBIDDEN']);
    user = ADMIN;
    res = await s.call('POST', '/zatca-buyer-data/apply-suggested', { ids: ['c-channel', 'c-vat', 'c-complete', 'c-walkin', 'c-other', 'bad id!'] });
    assert.deepEqual(res.body.data, { updated: 2, skipped: 3 }, 'المعرّف غير الصالح لا يُحتسب');
    assert.deepEqual(f.customers.filter(c => c.buyerType === 'BUSINESS').map(c => c.id).sort(), ['c-channel', 'c-complete', 'c-vat']);
    assert.equal(f.customers.find(c => c.id === 'c-walkin')!.buyerType, undefined);
    assert.equal(f.customers.find(c => c.id === 'c-other')!.buyerType, undefined, 'شركة أخرى');
  } finally { await s.close(); }
});

test('الموجّه لا يلتقط غير مساراته: GET /:id وPUT /:id يمرّان إلى customers.ts', async () => {
  const f = fakeDb({ flag: true, customers: ALL });
  const s = await serve(deps(f.db), () => ADMIN);
  try {
    for (const [m, u] of [['GET', '/c-vat'], ['PUT', '/c-vat'], ['GET', '/c-vat/statement'], ['PATCH', '/c-vat']] as const) {
      const res = await s.call(m, u, m === 'GET' ? undefined : {});
      assert.deepEqual([res.status, res.body], [418, { fallthrough: true }], `${m} ${u}`);
    }
    assert.deepEqual(f.calls, []);
  } finally { await s.close(); }
});

// ─── الأصناف ───

test('الفئة الضريبية للصنف: غير الجامعة بلا قراءة ولا كتابة، والجامعة تفحص الحالة المدمجة مع المحفوظ', async () => {
  const product = { id: 'p1', tenantId: TENANT, taxPct: 0, vatCategory: 'Z', vatExemptionCode: 'VATEX-SA-32', vatExemptionReason: 'صادرات' };
  const off = fakeDb({ flag: false, products: [product] });
  assert.deepEqual(await applyProductVatGate(off.db, { name: 'x', vatCategory: 'Q' }, TENANT, { productId: 'p1', taxPct: 15 }), { ok: true, patch: {} });
  assert.deepEqual(off.calls, ['tenant.findUnique']);
  const none = fakeDb({ flag: true, products: [product] });
  assert.deepEqual(await applyProductVatGate(none.db, { name: 'x', taxPct: 15 }, TENANT, { productId: 'p1', taxPct: 15 }), { ok: true, patch: {} });
  assert.deepEqual(none.calls, []);

  const on = fakeDb({ flag: true, products: [product] });
  assert.deepEqual(await applyProductVatGate(on.db, { vatExemptionReason: ' تصدير ' }, TENANT, { productId: 'p1', taxPct: undefined }), { ok: true, patch: { vatExemptionReason: 'تصدير' } });
  const bad = await applyProductVatGate(on.db, { vatCategory: 's' }, TENANT, { productId: 'p1', taxPct: undefined });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.body.code, 'PRODUCT_ZATCA_INVALID');
    assert.deepEqual((bad.body.fieldErrors as { field: string }[]).map(e => e.field).sort(), ['taxPct', 'vatExemptionCode']);
  }
  assert.deepEqual(await applyProductVatGate(on.db, { vatCategory: 'S', vatExemptionCode: '', vatExemptionReason: null }, TENANT, { productId: 'p1', taxPct: 15 }),
    { ok: true, patch: { vatCategory: 'S', vatExemptionCode: null, vatExemptionReason: null } });
  const created = await applyProductVatGate(on.db, { vatCategory: 'E', vatExemptionCode: 'VATEX-SA-29', vatExemptionReason: 'خدمات مالية' }, TENANT, { productId: null, taxPct: 15 });
  assert.equal(created.ok, false, 'معفى بنسبة 15%');
});

// ─── الجاهزية ───

test('GET /api/zatca/readiness: خلف بوابة المدير؛ العدّادات من القاعدة (عملاء، أصناف 0% بلا فئة، مناديب بصفّ ضريبي أو حزمة قديمة)', async () => {
  const f = fakeDb({
    flag: true, customers: ALL,
    products: [{ id: 'p1', tenantId: TENANT, taxPct: 0, vatCategory: null, deletedAt: null }, { id: 'p2', tenantId: TENANT, taxPct: 0, vatCategory: 'Z', deletedAt: null }, { id: 'p3', tenantId: TENANT, taxPct: 0, vatCategory: null, deletedAt: new Date() }],
    reps: [
      { id: 'r1', tenantId: TENANT, isActive: true, clientBundle: '20261001T000000Z-aaaaaaa', outboxTaxPending: 2 },
      { id: 'r2', tenantId: TENANT, isActive: true, clientBundle: '20260917T000000Z-bbbbbbb', outboxTaxPending: 0 },
      { id: 'r3', tenantId: TENANT, isActive: true, clientBundle: null, outboxTaxPending: null },
      { id: 'r4', tenantId: TENANT, isActive: false, clientBundle: null, outboxTaxPending: 5 },
    ],
  });
  const readiness = await buyerDataReadiness(f.db, TENANT);
  assert.deepEqual(readiness, {
    customers: { effectiveB2b: 2, complete: 1, incomplete: 1, unclassifiedWithSignals: 1, scanned: 3, truncated: false },
    products: { zeroVatUncategorized: 1 },
    reps: { active: 3, withTaxOutbox: 1, withoutBundle: 1, onOlderBundle: 1, latestBundle: '20261001T000000Z-aaaaaaa' },
  });

  for (const withDep of [true, false]) {
    const h = harness({ env: 'simulation' });
    const router = createZatcaRouter({
      authenticate: (req: AuthRequest, _res: Response, next: NextFunction) => { req.user = ADMIN as AuthRequest['user']; next(); },
      loadAdmin: async () => ({ isActive: true, role: 'ADMIN', tenantId: TENANT, canManageCompanySettings: true }),
      isScopeRestricted: async () => false,
      loadTenantFlag: async () => true,
      store: h.store,
      writeSeller: async () => true,
      loadKeyring: () => h.keyring,
      clientFactory: h.client,
      now: h.clock.now,
      config: zatcaEnvConfig({ NODE_ENV: 'production', ZATCA_ALLOWED_ENVS: 'simulation' }),
      sleep: fakeSleep(h),
      log: () => {},
      audit: () => {},
      ...(withDep ? { loadReadiness: async (tid: string) => ({ tid, ok: true }) } : {}),
    });
    const app = express();
    app.use('/api/zatca', router, zatcaErrorGuard);
    const server = http.createServer(app);
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
    try {
      const res = await new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        http.get({ host: '127.0.0.1', port, path: '/api/zatca/readiness' }, r => {
          const chunks: Buffer[] = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        }).on('error', reject);
      });
      if (withDep) assert.deepEqual([res.status, res.body.data], [200, { tid: TENANT, ok: true }]);
      else assert.deepEqual([res.status, res.body.code], [404, 'READINESS_UNAVAILABLE']);
    } finally { await router.idle(); await new Promise(r => server.close(r)); }
  }
});

// ─── حرّاس نصّية على الربط ───

test('customers.ts: مخطّط zod بلا حقول المرحلة الثانية (غير الجامعة كما اليوم)، والموجّه قبل GET /:id، والبوابة في موضعها من POST وPUT', () => {
  const src = read('routes/customers.ts');
  const schema = src.slice(src.indexOf('const customerSchema'), src.indexOf('});', src.indexOf('const customerSchema')));
  for (const k of ['buyerType', 'buyerIdScheme', 'buyerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'countryCode']) {
    assert.doesNotMatch(schema, new RegExp(`\\b${k}\\b`), `المخطّط يقبل ${k}`);
  }
  const mount = src.indexOf('router.use(createCustomerBuyerDataRouter(buyerDataDeps));');
  assert.ok(mount > 0 && mount < src.indexOf("router.get('/:id',") && mount > src.indexOf("router.get('/locations',"));

  const post = src.slice(src.indexOf("router.post('/',"), src.indexOf("router.put('/:id',"));
  const idem = post.indexOf('if (data.clientRef) {');
  const gate = post.indexOf("const buyerGate = await applyBuyerGateToWrite(buyerDataDeps, req, tid, data as Record<string, unknown>, { customerId: null, replay: !!data.clientRef });");
  const create = post.indexOf('prisma.customer.create(');
  assert.ok(idem > 0 && idem < gate && gate < create, 'POST: بعد التكرار وقبل الإنشاء');
  assert.match(post.slice(gate), /^[^\n]*\n\s*if \(!buyerGate\.ok\) \{ res\.status\(buyerGate\.status\)\.json\(buyerGate\.body\); return; \}/);
  assert.ok(post.includes('res.status(201).json({ success: true, data: customer, ...(buyerGate.warnings && { warnings: buyerGate.warnings }) });'));

  const put = src.slice(src.indexOf("router.put('/:id',"), src.indexOf("router.get('/:id/statement',"));
  const exists = put.indexOf('if (!exists) {');
  const strip = put.indexOf('delete data.creditLimit; delete data.paymentDays; delete data.status;');
  const pgate = put.indexOf("const buyerGate = await applyBuyerGateToWrite(buyerDataDeps, req, tid, data as Record<string, unknown>, { customerId: req.params.id, replay: false });");
  const update = put.indexOf('prisma.customer.update(');
  assert.ok(exists > 0 && strip > exists && pgate > strip && pgate < update, 'PUT: بعد الوجود ونزع الحقول المالية وقبل الكتابة');
  assert.ok(put.includes('res.json({ success: true, data: customer, ...(buyerGate.warnings && { warnings: buyerGate.warnings }) });'));
});

test('products.ts: المخطّط بلا حقول الفئة، والبوابة قبل الإنشاء والتعديل بالحالة المدمجة', () => {
  const src = read('routes/products.ts');
  const schema = src.slice(src.indexOf('const productSchema'), src.indexOf('});', src.indexOf('const productSchema')));
  assert.doesNotMatch(schema, /vatCategory|vatExemption/);
  const post = src.slice(src.indexOf("router.post('/', requireAdmin"), src.indexOf("router.put('/:id', requireAdmin"));
  const g1 = post.indexOf('const vatGate = await applyProductVatGate(prisma, req.body, tid, { productId: null, taxPct: data.taxPct });');
  assert.ok(g1 > post.indexOf('data.taxPct = company?.defaultVatPct ?? 15;') && g1 < post.indexOf('prisma.product.create('));
  assert.ok(post.includes('data: { ...data, ...vatGate.patch, barcode:'));
  const put = src.slice(src.indexOf("router.put('/:id', requireAdmin"), src.indexOf("router.delete('/:id'"));
  const g2 = put.indexOf('const vatGate = await applyProductVatGate(prisma, req.body, tid, { productId: req.params.id, taxPct: updateData.taxPct as number | undefined });');
  assert.ok(g2 > put.indexOf('if (updateData.taxPct == null) delete updateData.taxPct;') && g2 < put.indexOf('prisma.product.update('));
  assert.ok(put.includes('Object.assign(updateData, vatGate.patch);'));
});
