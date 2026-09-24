// ZATCA المرحلة الثانية (Z5.8، نقد 3/4) — اختبارات POST /invoices عبر الموجّه الحقيقي لرفض التسليح وقرار الانتقال (D11).
// عميل Prisma مزيّف + مصادقة مزيّفة + اعتماديات فرع المرحلة الثانية مُحقنة (بلا قاعدة بيانات ولا شبكة). يثبت:
//   • غير مُسلَّح (armedAt null) ⇒ لا أثر إطلاقاً (المرحلة الأولى كما اليوم).
//   • مُسلَّح: لحظة الجهاز قبل التسليح ⇒ تمرّ 201؛ عند/بعده ⇒ 409 ZATCA_GO_LIVE_ARMING ولا فاتورة.
//   • حيّة + إعادة رفع + لحظة قبل التفعيل ضمن ٧٢ ساعة ⇒ null فتُسجَّل مرحلة أولى؛ خارج المهلة ⇒ 409 وتُحفظ للمراجعة.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import crypto from 'crypto';
import { memoryEgsUnitStore } from '../compliance/zatca/onboardingStore';
import { memoryGoLiveStore, type MemoryGoLiveStore } from '../compliance/zatca/goLiveStore';
import type { CutoverStatus } from '../compliance/zatca/goLive';
import { Z5_TENANT, CUSTOMERS, PRODUCTS, sellerSettings } from '../compliance/zatca/__fixtures__/z5-sources';

// ═══ حقن البدائل قبل تحميل الموجّه (كنمط invoices-phase2-route.test.ts) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let calls: string[] = [];
let scripted: Record<string, (args: unknown) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0 } };
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
function modelProxy(model: string): unknown {
  return new Proxy({}, { get: (_t, method: string) => async (args: unknown) => { calls.push(`${model}.${method}`); const fn = scripted[`${model}.${method}`]; return fn ? fn(args) : defaultFor(method); } });
}
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') return async (arg: unknown) => { calls.push('$transaction'); return typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : arg; };
    if (key === '$queryRaw' || key === '$executeRaw') return async () => { calls.push(key); return key === '$queryRaw' ? [] : 0; };
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

let currentUser: { id: string; role: string; tenantId: string } = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});

let phase2Deps: unknown = null;
let phase2DepsCalls = 0;
stub('routes/invoicesZatcaDeps', {
  productionPhase2Deps: () => { phase2DepsCalls++; if (!phase2Deps) throw new Error('اعتماديات المرحلة الثانية غير مهيّأة'); return phase2Deps; },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesRouter = require('../routes/invoices').default as express.Router;
import type { Phase2IssuanceDeps, Phase2Tx } from '../routes/invoicesZatca';

// ═══ العُدّة ═══

const LIVE_AT = new Date('2026-12-01T00:00:00.000Z');
const ARMED = new Date('2026-11-25T06:00:00.000Z');

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesRouter);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ success: false, message: err.message }); });
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, unknown> };
async function call(method: 'POST' | 'GET', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const s = await startServer();
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: url, agent: false, headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...(o.headers ?? {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const CAPS = { 'X-FS-Caps': 'zatca2' };
const CUSTOMER_ROW = (base: Record<string, unknown>) => ({ ...base, status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: Z5_TENANT, phone: '0500000000' });
const PRODUCT_ROWS = PRODUCTS.map(p => ({ id: p.id, name: p.name, basePrice: 1000, taxPct: null, damagedReturnToStock: true, priceTiers: [], vatCategory: p.vatCategory ?? null, vatExemptionCode: p.vatExemptionCode ?? null, vatExemptionReason: p.vatExemptionReason ?? null }));

function invoiceBody(o: { customerId: string; items: { productId: string; qty: number; unitPrice: number; taxPct?: number }[]; clientRef?: string | null; clientCreatedAt?: string }): Record<string, unknown> {
  return {
    customerId: o.customerId, salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: true, discountPct: 0, items: o.items,
    ...(o.clientRef === null ? {} : { clientRef: o.clientRef ?? crypto.randomUUID() }),
    ...(o.clientCreatedAt ? { clientCreatedAt: o.clientCreatedAt } : {}),
  };
}

/** ردود المنصّة لمسار POST كامل (المرحلة الأولى) — settings تحمل startedAt وarmedAt المطلوبين للاختبار. */
function scriptBase(o: { startedAt?: Date | null; armedAt?: Date | null; customer?: Record<string, unknown> }): void {
  const customer = o.customer ?? CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>);
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => ({ id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true, canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, maxDiscountPct: 100 }),
    'customer.findFirst': () => customer,
    'product.findMany': (args: unknown) => { const ids: string[] = (args as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? []; return PRODUCT_ROWS.filter(p => ids.includes(p.id)); },
    'companySettings.findUnique': () => ({ defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: o.startedAt ?? null, zatcaGoLiveArmedAt: o.armedAt ?? null }),
    'zatcaEgsUnit.findMany': () => [],
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, invoiceSignatureEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => null,
    'invoice.create': (args: unknown) => ({ id: 'legacy-1', ...((args as { data?: Record<string, unknown> }).data ?? {}), items: [], customer, installments: [], signature: null }),
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
}

/** اعتماديات فرع المرحلة الثانية للحالة الحيّة: يكفي منها بائعٌ مُفعَّل + قاعدة النظام الضريبي + خطّاف المراجعة.
 *  قرار الانتقال يُحسم قبل القفل والختم — فأيّ استعمال لبقيّة الاعتماديات يرمي (إثباتٌ أنّها لم تُمسّ). */
function livePhase2Deps(cutover: MemoryGoLiveStore, now: Date, opts: { findStatus?: CutoverStatus } = {}): Phase2IssuanceDeps {
  const units = memoryEgsUnitStore({ settings: [sellerSettings({ zatcaPhase2StartedAt: LIVE_AT })] });
  const boom = () => { throw new Error('لا ينبغي بلوغ الإصدار في مسار الانتقال'); };
  return {
    db: prismaFake as unknown as Phase2IssuanceDeps['db'],
    units,
    documents: { insertSigned: boom, advanceUnitChain: boom, loadProjection: async () => null },
    chain: { lockChainHead: boom, nextNumberInTx: boom },
    keyring: boom,
    ledger: { postCashInvoice: boom, postCreditInvoice: boom, creditLimitNotice: boom },
    transaction: boom as unknown as Phase2IssuanceDeps['transaction'],
    publish: () => {},
    now: () => now,
    env: process.env,
    mutex: null,
    // نقد 3: find يعيد حسم الإدارة السابق (إن وُجد) فتنتهي دورة إعادة الرفع؛ غيابه ⇒ سلوك ما قبل النقد (قرار الانتقال المعتاد)
    cutover: {
      record: input => cutover.recordCutover(input),
      ...(opts.findStatus ? { find: async () => ({ status: opts.findStatus as CutoverStatus }) } : {}),
    },
  };
}

function reset(): void { calls = []; scripted = {}; phase2Deps = null; phase2DepsCalls = 0; currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT }; delete process.env.ZATCA_REHEARSAL_TENANT_IDS; }

// ═══ (١) رفض التسليح في المرحلة الأولى ═══

test('غير مُسلَّح (armedAt null): المرحلة الأولى كما اليوم — 201 ولو حملت لحظة جهاز', async () => {
  reset();
  scriptBase({ startedAt: null, armedAt: null });
  const r = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientCreatedAt: new Date().toISOString() }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((r.body.data as Record<string, unknown>).id, 'legacy-1');
  assert.equal(phase2DepsCalls, 0);
});

test('مُسلَّح: لحظة الجهاز قبل التسليح ⇒ تمرّ 201 (تُقبل مرحلة أولى)', async () => {
  reset();
  scriptBase({ startedAt: null, armedAt: ARMED });
  const before = new Date(ARMED.getTime() - 3600_000).toISOString();
  const r = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientCreatedAt: before }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((r.body.data as Record<string, unknown>).id, 'legacy-1');
});

test('مُسلَّح: لحظة الجهاز عند/بعد التسليح ⇒ 409 ZATCA_GO_LIVE_ARMING ولا فاتورة', async () => {
  for (const c of [ARMED, new Date(ARMED.getTime() + 60_000)]) {
    reset();
    scriptBase({ startedAt: null, armedAt: ARMED });
    const r = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientCreatedAt: c.toISOString() }) });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'ZATCA_GO_LIVE_ARMING');
    assert.equal(calls.includes('invoice.create'), false, 'أُنشئت فاتورة رغم الرفض');
  }
});

test('مُسلَّح: طلب حيّ بلا لحظة جهاز (اللوحة) ⇒ يمرّ 201', async () => {
  reset();
  scriptBase({ startedAt: null, armedAt: ARMED });
  const r = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', clientRef: null, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

// ═══ (٢) قرار الانتقال (D11) بعد التفعيل ═══

test('حيّة + إعادة رفع + لحظة قبل التفعيل ضمن ٧٢ ساعة ⇒ تُسجَّل مرحلة أولى (201) بلا حفظ للمراجعة', async () => {
  reset();
  const cutover = memoryGoLiveStore();
  phase2Deps = livePhase2Deps(cutover, new Date(LIVE_AT.getTime() + 24 * 3600_000)); // بعد يوم من التفعيل
  scriptBase({ startedAt: LIVE_AT, armedAt: ARMED });
  const before = new Date(LIVE_AT.getTime() - 3600_000).toISOString(); // قبل التفعيل بساعة
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', clientCreatedAt: before }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((r.body.data as Record<string, unknown>).id, 'legacy-1');
  assert.equal((r.body.data as Record<string, unknown>).einvoice, undefined, 'سُجّلت مرحلة ثانية بدل الأولى');
  assert.equal(cutover.rows.length, 0, 'حُفظت للمراجعة رغم قبولها');
});

test('حيّة + إعادة رفع + لحظة قبل التفعيل لكن بعد مهلة ٧٢ ساعة ⇒ 409 ZATCA_CUTOVER_REVIEW وتُحفظ للمراجعة', async () => {
  reset();
  const cutover = memoryGoLiveStore();
  phase2Deps = livePhase2Deps(cutover, new Date(LIVE_AT.getTime() + 80 * 3600_000)); // تجاوز ٧٢ ساعة
  scriptBase({ startedAt: LIVE_AT, armedAt: ARMED });
  const before = new Date(LIVE_AT.getTime() - 3600_000).toISOString();
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', clientCreatedAt: before }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CUTOVER_REVIEW');
  assert.equal(calls.includes('invoice.create'), false, 'أُنشئت فاتورة رغم الإحالة للمراجعة');
  assert.equal(cutover.rows.length, 1, 'لم تُحفظ للمراجعة');
  assert.equal(cutover.rows[0].reason, 'WINDOW_EXPIRED');
  assert.equal(cutover.rows[0].clientRef, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
});

test('حيّة + إعادة رفع + لحظة بعد التفعيل ⇒ 409 مراجعة (CREATED_AFTER_GOLIVE)', async () => {
  reset();
  const cutover = memoryGoLiveStore();
  phase2Deps = livePhase2Deps(cutover, new Date(LIVE_AT.getTime() + 3600_000));
  scriptBase({ startedAt: LIVE_AT, armedAt: ARMED });
  const afterGoLive = new Date(LIVE_AT.getTime() + 60_000).toISOString();
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: 'cccccccc-3333-4333-8333-cccccccccccc', clientCreatedAt: afterGoLive }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ZATCA_CUTOVER_REVIEW');
  assert.equal(cutover.rows.length, 1);
  assert.equal(cutover.rows[0].reason, 'CREATED_AFTER_GOLIVE');
});

test('حيّة + طلب حيّ (بلا X-FS-Replay) ⇒ لا يمرّ بقرار الانتقال (يكمل مسار المرحلة الثانية المعتاد)', async () => {
  reset();
  const cutover = memoryGoLiveStore();
  phase2Deps = livePhase2Deps(cutover, new Date(LIVE_AT.getTime() + 24 * 3600_000));
  scriptBase({ startedAt: LIVE_AT, armedAt: ARMED });
  const before = new Date(LIVE_AT.getTime() - 3600_000).toISOString();
  // بلا ترويسة إعادة الرفع: ليس مستنداً انتقالياً — يمضي للمرحلة الثانية (وحدة محجوبة هنا ⇒ 503)، لا مراجعة ولا مرحلة أولى
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: 'dddddddd-4444-4444-8444-dddddddddddd', clientCreatedAt: before }),
    headers: { ...CAPS },
  });
  assert.equal(cutover.rows.length, 0, 'طلب حيّ حُفظ للمراجعة خطأً');
  assert.notEqual(r.status, 201, 'طلب حيّ سُجّل مرحلة أولى خطأً');
  assert.equal(r.body.code, 'ZATCA_UNIT_UNAVAILABLE');
});

// ═══ (٣) سباق التفعيل (نقد 4.4): قفل FOR SHARE داخل معاملة الإنشاء ═══

test('سباق التفعيل: فُعّلت الشركة حيّاً أثناء تجهيز فاتورة مرحلة أولى مُسلَّحة ⇒ 409 ولا فاتورة غير مختومة', async () => {
  reset();
  scriptBase({ startedAt: null, armedAt: ARMED });
  // القراءة قبل المعاملة ترى «لم تُفعَّل» (فالنظام مرحلة أولى)، وإعادة القراءة داخل المعاملة (FOR SHARE) ترى التفعيل مضبوطاً
  let reads = 0;
  scripted['companySettings.findUnique'] = () => {
    reads++;
    return { defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: reads >= 2 ? LIVE_AT : null, zatcaGoLiveArmedAt: ARMED };
  };
  // طلب حيّ (بلا لحظة جهاز) يمرّ رفض التسليح، ويقرّر النظامُ الضريبيُّ المرحلة الأولى — ثمّ يسبقه التفعيل داخل المعاملة
  const r = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', clientRef: null, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }) });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CUTOVER_REVIEW');
  assert.equal(calls.includes('invoice.create'), false, 'أُنشئت فاتورة مرحلة أولى غير مختومة على شركة صارت حيّة');
  assert.ok(reads >= 2, 'لم تُعد قراءة الإعدادات داخل المعاملة');
});

test('غير مُسلَّح: لا إعادة قراءة داخل المعاملة ولو ضُبط التفعيل بين القراءتين (لا أثر لغير المُسلَّح)', async () => {
  reset();
  scriptBase({ startedAt: null, armedAt: null });
  let reads = 0;
  scripted['companySettings.findUnique'] = () => {
    reads++;
    return { defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: reads >= 2 ? LIVE_AT : null, zatcaGoLiveArmedAt: null };
  };
  const r = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', clientRef: null, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }) });
  assert.equal(r.status, 201, JSON.stringify(r.body)); // مرحلة أولى كما اليوم — لا قفل ولا إعادة قراءة ولا رفض
  assert.equal(reads, 1, 'قرأ الإعدادات داخل المعاملة رغم أنّ الشركة غير مُسلَّحة');
});

// ═══ (٤) نتيجة إعادة الرفع بعد حسم الإدارة (D11، نقد 3): لا حلقة لا تنتهي ولا رفض صامت ═══

test('حيّة + إعادة رفع لمستندٍ رفضته الإدارة ⇒ 422 ZATCA_CUTOVER_REJECTED (يُنقل للمرفوضات) بلا حفظ ثانٍ', async () => {
  reset();
  const cutover = memoryGoLiveStore();
  phase2Deps = livePhase2Deps(cutover, new Date(LIVE_AT.getTime() + 100 * 3600_000), { findStatus: 'REJECTED' });
  scriptBase({ startedAt: LIVE_AT, armedAt: ARMED });
  const before = new Date(LIVE_AT.getTime() - 3600_000).toISOString();
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', clientCreatedAt: before }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CUTOVER_REJECTED');
  assert.equal(calls.includes('invoice.create'), false, 'أُنشئت فاتورة رغم رفض الإدارة');
  assert.equal(cutover.rows.length, 0, 'حُفظ مستندٌ ثانٍ رغم وجود حسمٍ سابق');
});

test('حيّة + إعادة رفع لمستندٍ قبلته الإدارة مرحلةً أولى ⇒ تُسجَّل مرحلة أولى (201) عبر المسار القديم', async () => {
  reset();
  const cutover = memoryGoLiveStore();
  phase2Deps = livePhase2Deps(cutover, new Date(LIVE_AT.getTime() + 100 * 3600_000), { findStatus: 'ACCEPTED_PHASE1' });
  scriptBase({ startedAt: LIVE_AT, armedAt: ARMED });
  const before = new Date(LIVE_AT.getTime() - 3600_000).toISOString();
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: 'ffffffff-6666-4666-8666-ffffffffffff', clientCreatedAt: before }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((r.body.data as Record<string, unknown>).id, 'legacy-1');
  assert.equal((r.body.data as Record<string, unknown>).einvoice, undefined, 'سُجّلت مرحلة ثانية بدل الأولى');
  assert.equal(cutover.rows.length, 0);
});

test('حيّة + إعادة رفع لمستندٍ قبلته الإدارة مرحلةً ثانية ⇒ يمضي لإصدار المرحلة الثانية (لا 409 مراجعة ولا حفظ)', async () => {
  reset();
  const cutover = memoryGoLiveStore();
  // وحدة الإصدار محجوبة في العُدّة ⇒ مسار المرحلة الثانية يردّ 503 قبل الختم: يكفي إثباتاً أنّه مضى للإصدار لا للمراجعة
  phase2Deps = livePhase2Deps(cutover, new Date(LIVE_AT.getTime() + 100 * 3600_000), { findStatus: 'ACCEPTED_PHASE2' });
  scriptBase({ startedAt: LIVE_AT, armedAt: ARMED });
  const before = new Date(LIVE_AT.getTime() - 3600_000).toISOString();
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: '99999999-7777-4777-8777-999999999999', clientCreatedAt: before }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.notEqual(r.body.code, 'ZATCA_CUTOVER_REVIEW', 'أُحيل للمراجعة رغم القبول مرحلةً ثانية');
  assert.notEqual(r.body.code, 'ZATCA_CUTOVER_REJECTED');
  assert.equal(r.body.code, 'ZATCA_UNIT_UNAVAILABLE', JSON.stringify(r.body)); // مضى للإصدار (وحدة محجوبة)
  assert.equal(calls.includes('invoice.create'), false, 'سُجّلت مرحلة أولى بدل الثانية');
  assert.equal(cutover.rows.length, 0, 'حُفظ للمراجعة رغم القبول');
});
