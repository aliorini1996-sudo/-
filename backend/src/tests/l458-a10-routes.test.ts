// «ربط الدفاتر» L8 (A10) — مسارات تقارير الشركاء والمرفقات سلوكياً فوق Prisma مزيّف في الذاكرة بشركتين (بلا قاعدة ولا خادم):
// - دفتر الشريك: الافتتاح + الحركة = الختام، والمتبقّي والمطابقات ورقم القيد المقابل، وعدّادات المرفقات دفعةً، ولا سطر من شركة أخرى.
// - التصدير: البيانات كاملة وصفّ تدقيق EXPORT.
// - المرفقات: لا مرفق من شركة أخرى، ولا من جدول نوعٍ آخر، ولا من مصدر آخر (sourceId).
// - LATER_REPORT_KEYS لم يعد يحوي مفاتيح الشركاء، وما بقي فيه ما زال 404 مفهوماً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Router } from 'express';
import { FakeDb, dataUrlMetaOf } from './l458-a10-fake-db';
import { M } from './l458-a10-mem-reconcile-store';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

const db = new FakeDb();
stub('config/database', { default: db.client() });
/* eslint-disable @typescript-eslint/no-var-requires */
const partnerRouter = require('../routes/ledger/partnerReports').default as Router;
const attachRouter = require('../routes/ledger/sourceAttachments').default as Router;
const reportsMod = require('../routes/ledger/reports') as { default: Router; LATER_REPORT_KEYS: readonly string[] };
const { dataUrlSize, dataUrlMime } = require('../routes/ledger/sourceAttachments') as {
  dataUrlSize: (len: number, head: string, tail: string) => number; dataUrlMime: (h: string) => string;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const T1 = 'tenant-1';
const T2 = 'tenant-2';
const ACTOR = 'admin-1';
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const JPEG = `data:image/jpeg;base64,${Buffer.from('abcdefgh').toString('base64')}`; // 8 بايتات ⇒ YWJjZGVmZ2g=

function seed(): void {
  db.tables = {};
  db.insert('admin', [
    { id: ACTOR, tenantId: T1, isActive: true, role: 'MANAGER', canManageCompanyUsers: false, scopeEnabled: false, canViewLedger: true, canPostJournals: false, canManagePayables: false, canManageBank: false, canCloseLedgerPeriods: false, canConfigureLedger: false, name: 'محاسب' },
  ]);
  db.insert('glSettings', [
    { tenantId: T1, setupMethod: 'LINKED', activatedAt: new Date('2026-11-01T00:00:00Z'), currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', fiscalYearEndMonth: 12, fiscalYearEndDay: 31, linkedFrom: D('2026-01-01'), cutoverDate: null },
    { tenantId: T2, setupMethod: 'LINKED', activatedAt: new Date('2026-11-01T00:00:00Z'), currency: 'SAR', currencyDecimals: 2, timezone: 'Asia/Riyadh', fiscalYearEndMonth: 12, fiscalYearEndDay: 31, linkedFrom: D('2026-01-01'), cutoverDate: null },
  ]);
  db.insert('glAccount', [
    { id: 'ar', tenantId: T1, code: '113001', controlKind: 'AR', type: 'asset_receivable' },
    { id: 'rev', tenantId: T1, code: '411001', controlKind: null, type: 'income' },
    { id: 'disc', tenantId: T1, code: '413001', controlKind: null, type: 'income' },
    { id: 'ar2', tenantId: T2, code: '113001', controlKind: 'AR', type: 'asset_receivable' },
  ]);
  db.insert('glAccountMapping', [{ tenantId: T1, key: 'SALES_DISCOUNT', accountId: 'disc' }]);
  db.insert('glJournal', [{ id: 'j1', tenantId: T1, code: 'INV' }, { id: 'j2', tenantId: T1, code: 'RCPT' }]);
  db.insert('customer', [{ id: 'C1', tenantId: T1, name: 'عميل أ', phone: '0500', code: 'c1' }, { id: 'C9', tenantId: T2, name: 'عميل آخر', phone: '0599', code: 'c9' }]);
  db.insert('product', [{ id: 'P1', tenantId: T1, name: 'مياه' }]);
  const t0 = new Date('2026-11-14T08:00:00Z').getTime();
  db.insert('glMove', [
    { id: 'M0', tenantId: T1, number: 'OPEN/1', journalId: 'j1', date: D('2025-12-31'), state: 'POSTED', ref: null, sourceType: null, sourceId: null, createdAt: new Date(t0 - 9e9), originalDate: null, lateArrival: false, totalMilli: M(100) },
    { id: 'M1', tenantId: T1, number: 'INV/0001', journalId: 'j1', date: D('2026-11-14'), state: 'POSTED', ref: 'INV-1001', sourceType: 'INVOICE', sourceId: 'I1', createdAt: new Date(t0), originalDate: null, lateArrival: false, totalMilli: M(1150), moveType: 'OUT_INVOICE', customerId: 'C1', salesRepId: null },
    { id: 'M2', tenantId: T1, number: 'RCPT/0001', journalId: 'j2', date: D('2026-11-20'), state: 'POSTED', ref: 'R-1', sourceType: 'RECEIPT', sourceId: 'R1', createdAt: new Date(t0 + 1e6), originalDate: null, lateArrival: false, totalMilli: M(600), customerId: 'C1' },
    { id: 'M3', tenantId: T1, number: 'INV/0002', journalId: 'j1', date: D('2026-11-01'), state: 'POSTED', ref: 'INV-9', sourceType: 'INVOICE', sourceId: 'I9', createdAt: new Date(t0 + 2e6), originalDate: D('2026-10-02'), lateArrival: true, totalMilli: M(115), customerId: 'C1' },
    { id: 'MX', tenantId: T2, number: 'INV/0001', journalId: 'jx', date: D('2026-11-14'), state: 'POSTED', ref: null, sourceType: 'INVOICE', sourceId: 'IX', createdAt: new Date(t0), originalDate: D('2026-10-02'), lateArrival: true, totalMilli: M(5) },
  ]);
  const line = (o: Record<string, unknown>) => ({
    tenantId: T1, posted: true, customerId: null, vendorId: null, salesRepId: null, adminUserId: null, dueDate: null, productId: null,
    quantity: null, label: null, partnerName: null, seq: 0, debitMilli: 0n, creditMilli: 0n, ...o,
  });
  db.insert('glMoveLine', [
    line({ id: 'L0', moveId: 'M0', accountId: 'ar', customerId: 'C1', date: D('2025-12-31'), debitMilli: M(100) }),
    line({ id: 'L1', moveId: 'M1', accountId: 'ar', customerId: 'C1', date: D('2026-11-14'), debitMilli: M(575), dueDate: D('2026-12-14'), partnerName: 'عميل أ' }),
    line({ id: 'L2', moveId: 'M1', seq: 1, accountId: 'ar', customerId: 'C1', date: D('2026-11-14'), debitMilli: M(575), dueDate: D('2027-01-13') }),
    line({ id: 'L4', moveId: 'M1', seq: 2, accountId: 'rev', date: D('2026-11-14'), creditMilli: M(1000), productId: 'P1', quantity: 240 }),
    line({ id: 'L5', moveId: 'M1', seq: 3, accountId: 'disc', date: D('2026-11-14'), debitMilli: M(0.5), productId: 'P1' }),
    line({ id: 'L3', moveId: 'M2', seq: 1, accountId: 'ar', customerId: 'C1', date: D('2026-11-20'), creditMilli: M(600) }),
    // شركة أخرى بالمعرّف نفسه للعميل: لا تظهر أبداً
    line({ id: 'LX', tenantId: T2, moveId: 'MX', accountId: 'ar2', customerId: 'C1', date: D('2026-11-14'), debitMilli: M(999) }),
  ]);
  db.insert('glPartialReconcile', [
    { id: 'p1', tenantId: T1, debitLineId: 'L1', creditLineId: 'L3', debitMoveId: 'M1', creditMoveId: 'M2', amountMilli: M(575), sourceRef: 'RI:x' },
    { id: 'p2', tenantId: T1, debitLineId: 'L2', creditLineId: 'L3', debitMoveId: 'M1', creditMoveId: 'M2', amountMilli: M(25), sourceRef: 'RI:x' },
  ]);
  db.insert('receipt', [{ id: 'R1', tenantId: T1 }, { id: 'R9', tenantId: T2 }]);
  db.insert('invoice', [{ id: 'I1', tenantId: T1 }]);
  db.insert('receiptPhoto', [
    { id: 'ph1', receiptId: 'R1', data: JPEG, createdAt: new Date(t0) },
    { id: 'ph9', receiptId: 'R9', data: JPEG, createdAt: new Date(t0) },
  ]);
  db.insert('invoiceSignature', [{ invoiceId: 'I1', tenantId: T1, image: 'data:image/png;base64,iVBORw==', repImage: null, createdAt: new Date(t0) }]);
  db.insert('glAttachment', [{ id: 'ga1', tenantId: T1, entityType: 'MOVE', entityId: 'M1', fileName: 'فاتورة.pdf', mimeType: 'application/pdf', sizeBytes: 3, createdAt: new Date(t0) }]);
  db.insert('glAttachmentBlob', [{ id: 'b1', attachmentId: 'ga1', tenantId: T1, bytes: Buffer.from('PDF') }]);
  db.insert('customerDocument', [{ id: 'd1', tenantId: T1, customerId: 'C1', kind: 'CR', data: JPEG, sizeBytes: 8, createdAt: new Date(t0) }]);
  db.rawHandler = (sql, values) => {
    if (sql.includes('"receipt_photos"')) {
      const [sourceId, tenantId] = values as string[];
      const r = db.table('receipt').find((x) => x.id === sourceId && x.tenantId === tenantId);
      return r ? db.table('receiptPhoto').filter((p) => p.receiptId === sourceId).map((p) => ({ id: p.id, createdAt: p.createdAt, ...dataUrlMetaOf(p.data as string) })) : [];
    }
    if (sql.includes('"invoice_signatures"')) {
      const [sourceId, tenantId] = values as string[];
      return db.table('invoiceSignature').filter((s) => s.invoiceId === sourceId && s.tenantId === tenantId).map((s) => {
        const a = dataUrlMetaOf(s.image as string | null);
        const b = dataUrlMetaOf(s.repImage as string | null);
        return { invoiceId: s.invoiceId, ...a, repHead: b.head, repLen: b.len, repTail: b.tail, createdAt: s.createdAt };
      });
    }
    if (sql.includes('"customer_documents"')) {
      const [tenantId, customerId] = values as string[];
      return db.table('customerDocument').filter((d) => d.tenantId === tenantId && d.customerId === customerId)
        .map((d) => ({ id: d.id, head: (d.data as string).slice(0, 64), size: d.sizeBytes, kind: d.kind, createdAt: d.createdAt }));
    }
    return [];
  };
}

// ═══ تشغيل سلسلة المسار الحقيقية بطلب/ردّ مقلَّدين ═══

interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => unknown }[] } }

function handlersFor(router: Router, method: 'get' | 'post', routePath: string) {
  for (const layer of (router as unknown as { stack: RouteLayer[] }).stack) {
    const r = layer.route;
    if (r && r.path === routePath && r.methods[method] === true) return r.stack.map((s) => s.handle);
  }
  throw new Error(`نقطة غير مسجَّلة: ${method.toUpperCase()} ${routePath}`);
}

async function call(router: Router, method: 'get' | 'post', routePath: string, req: Record<string, unknown>, tenantId = T1) {
  const res = {
    statusCode: 200, body: null as Record<string, unknown> | null, headers: {} as Record<string, unknown>,
    locals: { ledger: { tenantId, actorId: ACTOR, impersonated: false } }, onSend: null as (() => void) | null,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p as Record<string, unknown>; this.onSend?.(); return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; }, getHeader(k: string) { return this.headers[k]; },
    removeHeader(k: string) { delete this.headers[k]; }, on() { return this; }, once() { return this; },
  };
  const fullReq = {
    params: {}, query: {}, body: {}, headers: {}, ip: '127.0.0.1', app: { get: () => undefined },
    user: { id: ACTOR, role: 'MANAGER', tenantId, name: 'محاسب', impersonated: false }, ...req,
  };
  for (const handle of handlersFor(router, method, routePath)) {
    const outcome = await new Promise<'next' | 'sent'>((resolve, reject) => {
      res.onSend = () => resolve('sent');
      Promise.resolve().then(() => handle(fullReq, res, (err?: unknown) => (err ? reject(err) : resolve('next')))).catch(reject);
    });
    if (outcome === 'sent') break;
  }
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

const data = (r: { body: Record<string, unknown> | null }) => r.body?.data as Record<string, unknown>;

// ═══ المفاتيح ═══

test('LATER_REPORT_KEYS = vat-return وcash-flow، ومفاتيح الشركاء مسجّلة GET وتصديراً قبل reportsRouter', () => {
  assert.deepEqual([...reportsMod.LATER_REPORT_KEYS], ['vat-return', 'cash-flow']);
  for (const k of ['partner-ledger', 'aged-receivable', 'aged-payable', 'late-arrivals', 'product-ledger']) {
    assert.ok(handlersFor(partnerRouter, 'get', `/reports/${k}`).length >= 2);
    assert.ok(handlersFor(partnerRouter, 'post', `/reports/${k}/export`).length >= 3, 'VIEW + محدد التصدير + المعالج');
  }
  assert.ok(handlersFor(partnerRouter, 'get', '/partners/search'));
  assert.ok(handlersFor(attachRouter, 'get', '/source-attachments'));
  assert.ok(handlersFor(attachRouter, 'get', '/source-attachments/:kind/:id'));
});

test('reportsRouter: vat-return ما زال 404 «يُتاح مع مرحلته»', async () => {
  seed();
  const r = await call(reportsMod.default, 'get', '/reports/:key', { params: { key: 'vat-return' } });
  assert.equal(r.status, 404);
  assert.equal(r.body?.reason, 'REPORT_NOT_AVAILABLE');
});

// ═══ دفتر الشريك ═══

test('دفتر الشريك للعميل: الافتتاح 100 + الحركة = الختام 650، والمتبقّي والمطابقات والمرفقات، ولا سطر من شركة أخرى', async () => {
  seed();
  const r = await call(partnerRouter, 'get', '/reports/partner-ledger', { query: { partnerType: 'customer', partnerId: 'C1', from: '2026-01-01', to: '2026-12-31' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = data(r);
  assert.equal(d.reportKey, 'partner-ledger');
  assert.deepEqual(d.partner, { type: 'customer', id: 'C1', name: 'عميل أ' });
  assert.equal(d.opening, 100);
  assert.equal(d.totalDebit, 1150);
  assert.equal(d.totalCredit, 600);
  assert.equal(d.closing, 650);
  const lines = d.lines as Record<string, unknown>[];
  assert.deepEqual(lines.map((l) => [l.lineId, l.balance, l.residual, l.fullyReconciled, l.journalCode]), [
    ['L1', 675, 0, true, 'INV'], ['L2', 1250, 550, false, 'INV'], ['L3', 650, 0, true, 'RCPT'],
  ]);
  assert.deepEqual(lines[2].matches, [{ lineId: 'L1', moveId: 'M1', moveNumber: 'INV/0001', amount: 575 }, { lineId: 'L2', moveId: 'M1', moveNumber: 'INV/0001', amount: 25 }]);
  // INVOICE I1: توقيع المستلم + مرفق القيد M1؛ RECEIPT R1: صورة واحدة
  assert.deepEqual(lines[0].attachments, { count: 2, kinds: ['INVOICE_SIGNATURE', 'LEDGER_ATTACHMENT'] });
  assert.deepEqual(lines[2].attachments, { count: 1, kinds: ['RECEIPT_PHOTO'] });
  assert.deepEqual(d.documents, { count: 1 });
  assert.deepEqual(d.warnings, []);
  // لا BigInt ولا قراءة بلا شركة: كل نداء نموذجٍ له tenantId (عدا صفّ الحساب وأبناء الصور المقيّدة بعلاقة الأب)
  assert.doesNotThrow(() => JSON.stringify(r.body));
  for (const c of db.calls) {
    if (c.model === 'admin' && c.method === 'findUnique') continue;
    const s = JSON.stringify(c.args, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    assert.ok(s.includes(T1), `${c.model}.${c.method} بلا tenantId: ${s}`);
    assert.ok(!s.includes(T2), `${c.model}.${c.method} يقرأ شركة أخرى`);
  }
});

test('دفتر الشريك: غير المطابَقة وحدها، والترقيم يحفظ الرصيد الجاري، وشريك مجهول 404، ونوع غير معروف 400', async () => {
  seed();
  const open = data(await call(partnerRouter, 'get', '/reports/partner-ledger', { query: { partnerType: 'customer', partnerId: 'C1', from: '2026-01-01', to: '2026-12-31', includeReconciled: 'false' } }));
  assert.deepEqual((open.lines as Record<string, unknown>[]).map((l) => l.lineId), ['L2']);
  assert.equal(open.opening, 100, 'L0 غير مطابَق');
  assert.equal(open.closing, 675);
  const p2 = data(await call(partnerRouter, 'get', '/reports/partner-ledger', { query: { partnerType: 'customer', partnerId: 'C1', from: '2026-01-01', to: '2026-12-31', page: '2', pageSize: '2' } }));
  assert.deepEqual((p2.lines as Record<string, unknown>[]).map((l) => [l.lineId, l.balance]), [['L3', 650]]);
  assert.deepEqual(p2.pagination, { page: 2, pageSize: 2, total: 3, pages: 2, paginated: true });
  const nf = await call(partnerRouter, 'get', '/reports/partner-ledger', { query: { partnerType: 'customer', partnerId: 'C9' } });
  assert.equal(nf.status, 404, 'عميل شركة أخرى كغير الموجود');
  assert.equal(nf.body?.reason, 'PARTNER_NOT_FOUND');
  await assert.rejects(call(partnerRouter, 'get', '/reports/partner-ledger', { query: { partnerType: 'nope', partnerId: 'C1' } }), /ZodError|Invalid/);
  const bad = await call(partnerRouter, 'get', '/reports/partner-ledger', { query: { partnerType: 'customer', partnerId: 'C1', from: '2026-12-01', to: '2026-01-01' } });
  assert.equal(bad.status, 400);
});

test('تصدير دفتر الشريك: البيانات كاملة بلا ترقيم وصفّ تدقيق EXPORT', async () => {
  seed();
  const r = await call(partnerRouter, 'post', '/reports/partner-ledger/export', { body: { format: 'xlsx', partnerType: 'customer', partnerId: 'C1', from: '2026-01-01', to: '2026-12-31', pageSize: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = data(r);
  assert.equal((d.lines as unknown[]).length, 3, 'التصدير يتجاهل pageSize');
  assert.equal(d.paginated, false);
  assert.equal(d.cap, 50_000);
  const audit = db.table('glAuditLog');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'EXPORT');
  assert.equal(audit[0].entityId, 'partner-ledger');
  assert.equal(audit[0].tenantId, T1);
});

// ═══ الأعمار ═══

test('aged-receivable: البنود المفتوحة من SQL الشركة بأسمائها وتفصيلها لشريك واحد، وتحذير المطابقة لغير المربوطة', async () => {
  seed();
  const prevRaw = db.rawHandler;
  db.rawHandler = (sql, values) => {
    if (sql.includes('"gl_partial_reconciles"') && sql.includes('"controlKind"')) {
      assert.ok(values.includes(T1) && !values.includes(T2), 'SQL الأعمار مقيّد بالشركة');
      assert.ok(values.includes('AR'));
      return sql.includes('"gl_moves"')
        ? [{ id: 'L2', moveId: 'M1', number: 'INV/0001', partnerId: 'C1', date: D('2026-11-14'), dueDate: D('2027-01-13'), debitMilli: M(575), creditMilli: 0n, amt: M(25) }]
        : [{ partnerId: 'C1', date: D('2026-11-14'), dueDate: D('2027-01-13'), residualMilli: M(550) }];
    }
    return prevRaw(sql, values);
  };
  const all = data(await call(partnerRouter, 'get', '/reports/aged-receivable', { query: { asOf: '2027-01-20' } }));
  assert.equal(all.reportKey, 'aged-receivable');
  assert.deepEqual(all.rows, [{ partnerId: 'C1', name: 'عميل أ', notDue: 0, b1: 550, b2: 0, b3: 0, b4: 0, older: 0, unappliedCredits: 0, total: 550 }]);
  assert.equal(all.detail, undefined);
  assert.deepEqual(all.warnings, []);
  const one = data(await call(partnerRouter, 'get', '/reports/aged-receivable', { query: { asOf: '2027-01-20', partnerId: 'C1' } }));
  assert.deepEqual(one.detail, [{ lineId: 'L2', moveId: 'M1', moveNumber: 'INV/0001', date: '2026-11-14', dueDate: '2027-01-13', daysOverdue: 7, residual: 550, bucket: 'b1' }]);
  const badBuckets = await call(partnerRouter, 'get', '/reports/aged-receivable', { query: { buckets: '30,20,90,120' } });
  assert.equal(badBuckets.status, 400);
  // غير مربوطة: تحذير المطابقة
  db.table('glSettings')[0].setupMethod = 'OPENING';
  const legacy = data(await call(partnerRouter, 'get', '/reports/aged-receivable', { query: { asOf: '2027-01-20' } }));
  assert.deepEqual((legacy.warnings as Record<string, unknown>[]).map((w) => w.code), ['RECONCILE_NOT_ACTIVE']);
  db.rawHandler = prevRaw;
});

// ═══ الوصول المتأخر والأصناف والبحث ═══

test('late-arrivals: E8.4 بسببه وباسم الشريك، بلا قيود شركة أخرى', async () => {
  seed();
  const d = data(await call(partnerRouter, 'get', '/reports/late-arrivals', { query: { from: '2026-01-01', to: '2026-12-31' } }));
  assert.deepEqual((d.rows as Record<string, unknown>[]).map((x) => [x.moveId, x.originalDate, x.postedDate, x.reason, x.partnerName, x.amount]),
    [['M3', '2026-10-02', '2026-11-01', 'PERIOD_LOCKED', 'عميل أ', 115]]);
  assert.equal(d.cutoverDate, '2026-01-01');
});

test('product-ledger: سطور الإيراد والخصم ذات الصنف من قيد البيع', async () => {
  seed();
  const d = data(await call(partnerRouter, 'get', '/reports/product-ledger', { query: { from: '2026-11-01', to: '2026-11-30' } }));
  assert.deepEqual(d.rows, [{ productId: 'P1', productName: 'مياه', quantity: 240, soldQuantity: 240, returnedQuantity: 0, revenue: 1000, discount: 0.5, returns: 0, net: 999.5 }]);
  const byCustomer = data(await call(partnerRouter, 'get', '/reports/product-ledger', { query: { from: '2026-11-01', to: '2026-11-30', customerId: 'C9' } }));
  assert.deepEqual(byCustomer.rows, []);
});

test('partners/search: عملاء الشركة وحدها بحدّ 20', async () => {
  seed();
  const d = data(await call(partnerRouter, 'get', '/partners/search', { query: { type: 'customer', q: 'عميل' } }));
  assert.deepEqual(d.items, [{ id: 'C1', name: 'عميل أ', hint: '0500' }]);
  const p = data(await call(partnerRouter, 'get', '/partners/search', { query: { type: 'product', q: 'مي' } }));
  assert.deepEqual(p.items, [{ id: 'P1', name: 'مياه', hint: null }]);
});

// ═══ المرفقات ═══

test('dataUrlSize/dataUrlMime: الحجم بعد فكّ base64 بالحشو، والنوع من البادئة', () => {
  const m = dataUrlMetaOf(JPEG);
  assert.equal(dataUrlSize(m.len as number, m.head as string, m.tail as string), 8);
  const png = 'data:image/png;base64,iVBORw==';
  assert.equal(dataUrlSize(png.length, png, png.slice(-2)), 4);
  assert.equal(dataUrlMime('data:application/pdf;base64,JVBE'), 'application/pdf');
  assert.equal(dataUrlMime('garbage'), 'application/octet-stream');
});

test('قائمة مرفقات المصدر: صور السند، وتوقيع الفاتورة ومرفق قيدها، ووثائق العميل — ومصدر شركة أخرى 404', async () => {
  seed();
  const rc = data(await call(attachRouter, 'get', '/source-attachments', { query: { sourceType: 'RECEIPT', sourceId: 'R1' } }));
  assert.deepEqual((rc.items as Record<string, unknown>[]).map((i) => [i.kind, i.id, i.mime, i.size]), [['RECEIPT_PHOTO', 'ph1', 'image/jpeg', 8]]);
  const inv = data(await call(attachRouter, 'get', '/source-attachments', { query: { sourceType: 'INVOICE', sourceId: 'I1' } }));
  assert.deepEqual((inv.items as Record<string, unknown>[]).map((i) => [i.kind, i.id, i.mime]), [
    ['INVOICE_SIGNATURE', 'I1:customer', 'image/png'], ['LEDGER_ATTACHMENT', 'ga1', 'application/pdf'],
  ]);
  const cu = data(await call(attachRouter, 'get', '/source-attachments', { query: { sourceType: 'CUSTOMER', customerId: 'C1' } }));
  assert.deepEqual((cu.items as Record<string, unknown>[]).map((i) => [i.kind, i.id, i.size]), [['CUSTOMER_DOCUMENT', 'd1', 8]]);
  const other = await call(attachRouter, 'get', '/source-attachments', { query: { sourceType: 'RECEIPT', sourceId: 'R9' } });
  assert.equal(other.status, 404);
  assert.equal(other.body?.reason, 'SOURCE_NOT_FOUND');
  assert.ok(!db.raw.some((q) => (q.values as string[]).includes('R9') && q.sql.includes('receipt_photos')), 'لا قراءة لصور مصدرٍ ليس للشركة');
});

test('محتوى المرفق: لا من شركة أخرى، ولا من جدول نوعٍ آخر، ولا من مصدر آخر', async () => {
  seed();
  const ok = await call(attachRouter, 'get', '/source-attachments/:kind/:id', { params: { kind: 'RECEIPT_PHOTO', id: 'ph1' }, query: { sourceId: 'R1' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(data(ok), { data: JPEG, mime: 'image/jpeg', name: 'صورة السند 1.jpg' });
  assert.equal(ok.headers['Cache-Control'], 'private, no-store');
  for (const [kind, id, query] of [
    ['RECEIPT_PHOTO', 'ph9', {}], // شركة أخرى
    ['CUSTOMER_DOCUMENT', 'ph1', {}], // جدول نوع آخر
    ['RECEIPT_PHOTO', 'ph1', { sourceId: 'R-other' }], // مصدر آخر
    ['INVOICE_SIGNATURE', 'I1:rep', {}], // توقيع غير موجود
    ['INVOICE_SIGNATURE', 'I1:customer', { sourceId: 'I2' }],
    ['LEDGER_ATTACHMENT', 'ga1', { sourceId: 'I-other' }],
  ] as const) {
    const r = await call(attachRouter, 'get', '/source-attachments/:kind/:id', { params: { kind, id }, query });
    assert.equal(r.status, 404, `${kind}/${id} ${JSON.stringify(query)}`);
  }
  const sig = data(await call(attachRouter, 'get', '/source-attachments/:kind/:id', { params: { kind: 'INVOICE_SIGNATURE', id: 'I1:customer' }, query: { sourceId: 'I1' } }));
  assert.equal(sig.mime, 'image/png');
  const gl = data(await call(attachRouter, 'get', '/source-attachments/:kind/:id', { params: { kind: 'LEDGER_ATTACHMENT', id: 'ga1' }, query: { sourceId: 'I1' } }));
  assert.deepEqual(gl, { data: `data:application/pdf;base64,${Buffer.from('PDF').toString('base64')}`, mime: 'application/pdf', name: 'فاتورة.pdf' });
  const bad = await call(attachRouter, 'get', '/source-attachments/:kind/:id', { params: { kind: 'NOPE', id: 'x' } });
  assert.equal(bad.status, 400);
  // من شركة أخرى بالمعرّف الصحيح لشركتها: مسموح لها وحدها
  const t2 = await call(attachRouter, 'get', '/source-attachments/:kind/:id', { params: { kind: 'RECEIPT_PHOTO', id: 'ph9' } }, T2);
  assert.equal(t2.status, 403, 'مستخدم T1 لا يصير مستخدماً لـT2 (الحارس يرفض قبل المعالج)');
});
