// «مرجع السطر» (lineRef) في الفواتير والمرتجعات والإشعارات — الموجّه الحقيقي routes/invoices.ts فوق عميل Prisma مزيّف (نمط
// invoices-arm-cutover-route.test.ts) ومنصّة المرحلة الثانية في الذاكرة (نمط invoices-notes-route.test.ts). لا قاعدة ولا شبكة.
//   • المخطّط: items[].lineRef اختياريّ يُقصّ فراغه، والفارغ/المسافات/null لا يُكتب (العمود null)، وفوق ١٠٠ بعد القصّ ⇒ 400 بلا مستند.
//   • الحفظ على البند في كل مسار إنشاء: المرحلة الأولى (بيعاً ومرتجعاً)، وفاتورة المرحلة الثانية، والإشعار الدائن «برقمٍ يدويّ»، والمرتجع
//     المرتبط (D3)، وPOST /:id/credit-note (بنود الأصل بترتيبه لا ترتيب الطلب) وdebit-note — ولا يدخل الـXML.
//   • إعادة الرفع (clientRef قائم) تعيد البنود المحفوظة كما هي.
//   • GET /invoices?withItems=1&withLots=1 والميزة مفعّلة ⇒ صفوف التوزيع بتضمين GET /:id?withLots=1 نفسه؛ وبلا withLots كما كان.
//   • حمولة ERP (payloadVersion 3) بلا lineRef على البنود.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
let calls: string[] = [];
let args: Record<string, unknown[]> = {};
let scripted: Record<string, (a: unknown) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0 } };
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (a: unknown) => {
    const key = `${model}.${method}`;
    calls.push(key);
    (args[key] ??= []).push(a);
    const fn = scripted[key];
    return fn ? fn(a) : defaultFor(method);
  },
});
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') return async (arg: unknown) => { calls.push('$transaction'); return typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : arg; };
    if (key === '$queryRaw' || key === '$executeRaw') return async () => { calls.push(key); return key === '$queryRaw' ? [] : 0; };
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

let currentUser: { id: string; role: string; tenantId: string; apiKeyId?: string } = { id: 'admin-1', role: 'ADMIN', tenantId: 'tenant-z5' };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});

let phase2Deps: unknown = null;
stub('routes/invoicesZatcaDeps', {
  productionPhase2Deps: () => { if (!phase2Deps) throw new Error('اعتماديات المرحلة الثانية غير مهيّأة لهذا الاختبار'); return phase2Deps; },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesRouter = require('../routes/invoices').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lineRefColumn, legacyItemColumns } = require('../routes/invoicesZatca') as typeof import('../routes/invoicesZatca');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { noteLineRefs } = require('../routes/invoicesNotes') as typeof import('../routes/invoicesNotes');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { invoicePayloadRow, withoutLineRef } = require('../services/erpPayload') as typeof import('../services/erpPayload');

import { createSubmitHarness, type SubmitHarness } from '../compliance/zatca/__fixtures__/z5-submit';
import { CUSTOMERS, PRODUCTS, Z5_TENANT } from '../compliance/zatca/__fixtures__/z5-sources';
import { REQ_STANDARD_NO_HEAD_DISCOUNT, originalInvoice } from '../compliance/zatca/__fixtures__/z5-notes';
import type { NoteOriginalInvoice } from '../compliance/zatca/notes';
import { submitDocument } from '../compliance/zatca/submit';
import { gunzipXml } from '../compliance/zatca/documentStore';
import type { NoteIssuanceDeps } from '../routes/invoicesNotes';
import type { Phase2Tx } from '../routes/invoicesZatca';

const LIVE_AT = new Date('2026-11-20T06:00:00.000Z');
const CAPS = { 'X-FS-Caps': 'zatca2' };

// ═══ الخادم (بمعالج الأخطاء الحقيقيّ: ZodError ⇒ 400) ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Row };
async function call(method: 'POST' | 'GET', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const s = await startServer();
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: url, agent: false, headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...(o.headers ?? {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let body: Row = {}; try { body = t ? JSON.parse(t) : {}; } catch { body = { raw: t }; } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ═══ بيانات المنصّة المزيّفة ═══

const PRODUCT_ROWS = PRODUCTS.map(p => ({
  id: p.id, name: p.name, unit: 'حبة', basePrice: 1000, taxPct: null, damagedReturnToStock: true, priceTiers: [],
  vatCategory: p.vatCategory ?? null, vatExemptionCode: p.vatExemptionCode ?? null, vatExemptionReason: p.vatExemptionReason ?? null,
}));
const CUSTOMER_ROW = (base: Row): Row => ({ ...base, status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: Z5_TENANT, phone: '0500000000' });
const REP: Row = {
  id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, maxDiscountPct: 100,
};
const num = (v: unknown): number => Number(v ?? 0);
const L100 = 'R'.repeat(100);

function reset(): void {
  calls = []; args = {}; scripted = {}; phase2Deps = null;
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };
  delete process.env.ZATCA_REHEARSAL_TENANT_IDS;
}

/** بيانات إنشاء البنود كما وصلت invoice.create في آخر نداء */
const createdItems = (): Row[] => {
  const a = (args['invoice.create'] ?? []).at(-1) as { data?: { items?: { create?: Row[] } } } | undefined;
  return a?.data?.items?.create ?? [];
};

// ═══ (١) المرحلة الأولى ═══

/** ردود المنصّة لمسار POST كامل في المرحلة الأولى — invoice.create يعيد بنوده كما كُتبت (كقاعدةٍ تعيد الصفّ) */
function scriptPhase1(o: { replay?: Row | null } = {}): void {
  const customer = CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row);
  scripted = {
    'invoice.findUnique': () => o.replay ?? null,
    'salesRep.findFirst': () => REP,
    'customer.findFirst': () => customer,
    'product.findMany': (a: unknown) => { const ids: string[] = (a as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? []; return PRODUCT_ROWS.filter(p => ids.includes(p.id)); },
    'companySettings.findUnique': () => ({ defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null }),
    'zatcaEgsUnit.findMany': () => [],
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, invoiceSignatureEnabled: false, lotTrackingEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => null,
    'invoice.create': (a: unknown) => {
      const data = (a as { data: Row }).data;
      const items = ((data.items as { create?: Row[] } | undefined)?.create ?? []).map((i, k) => ({ id: `p1-i${k}`, ...i }));
      return { id: 'inv-p1', ...data, items, customer, installments: [], signature: null };
    },
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
}

const phase1Body = (items: Row[], over: Row = {}): Row => ({
  customerId: 'c-walkin', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: true, discountPct: 0, items, ...over,
});
const water = (over: Row = {}): Row => ({ productId: 'p-water', qty: 1, unitPrice: 11.5, discountPct: 0, taxPct: 15, ...over });
const juice = (over: Row = {}): Row => ({ productId: 'p-juice', qty: 2, unitPrice: 5, discountPct: 0, taxPct: 15, ...over });

test('المرحلة الأولى: lineRef يُقصّ ويُحفظ على بنده، والبند بلاه بلا مفتاح — والردّ يحمله كما حُفظ', async () => {
  reset();
  scriptPhase1();
  const r = await call('POST', '/api/invoices', { body: phase1Body([water({ lineRef: '  ERP-L1  ' }), juice({ lineRef: 'ERP-L2' }), water()]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const items = createdItems();
  assert.deepEqual(items.map(i => i.lineRef), ['ERP-L1', 'ERP-L2', undefined]);
  assert.equal('lineRef' in items[2], false, 'بندٌ بلا مرجعٍ كُتب بمفتاح lineRef');
  assert.deepEqual((r.body.data.items as Row[]).map(i => i.lineRef ?? null), ['ERP-L1', 'ERP-L2', null]);
});

test('المرحلة الأولى: الفارغ والمسافات وnull لا تُكتب (العمود null)، و١٠٠ بعد القصّ تُقبل', async () => {
  reset();
  scriptPhase1();
  const r = await call('POST', '/api/invoices', { body: phase1Body([water({ lineRef: '' }), juice({ lineRef: '    ' }), water({ lineRef: null }), juice({ lineRef: `  ${L100}  ` })]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const items = createdItems();
  assert.deepEqual(items.slice(0, 3).map(i => 'lineRef' in i), [false, false, false]);
  assert.equal(items[3].lineRef, L100);
});

test('المرحلة الأولى: فوق ١٠٠ بعد القصّ أو قيمةٌ ليست نصّاً ⇒ 400 المخطّط بلا مستند', async () => {
  for (const bad of [`${L100}x`, ` ${L100}x `, 123, { ref: 'x' }]) {
    reset();
    scriptPhase1();
    const r = await call('POST', '/api/invoices', { body: phase1Body([water({ lineRef: bad })]) });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} ⇒ ${JSON.stringify(r.body)}`);
    assert.ok(String(r.body.message).includes('items'), JSON.stringify(r.body));
    assert.equal(calls.includes('invoice.create'), false, 'أُنشئ مستندٌ رغم الرفض');
  }
});

test('المرحلة الأولى: المرتجع (بلا فاتورة بيع) يحفظ lineRef لكل بند', async () => {
  reset();
  scriptPhase1();
  const r = await call('POST', '/api/invoices', { body: phase1Body([water({ lineRef: 'RET-1' }), juice()], { type: 'RETURN' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(createdItems().map(i => i.lineRef ?? null), ['RET-1', null]);
});

/**
 * مرتجع المرحلة الأولى من فاتورة بيع (originalInvoiceId + invoiceItemId): بنوده تُعاد بناؤها بتسعير الخادم (priceRefund) قبل
 * المعاملة وتحت القفل حين يتغيّر المرتجَع (returnedChanged) — والمرجع يعبر لأنه يركب بند الجسم (finalItems) لا مخرج التسعير.
 * بيعٌ: s-1 مياه ٣ حبّات بعشرة (الحصّة ٣٫٣٣ والأخيرة تأخذ الباقي)، وs-2 عصير ٤ بثمانية عشر. وتحت القفل مرتجعٌ متزامن من s-1 إن طُلب.
 */
function scriptLinkedReturn(o: { returnedUnderLock?: number } = {}): void {
  scriptPhase1();
  const sale = {
    customerId: 'c-walkin', type: 'CASH', status: 'CONFIRMED', documentKind: null, locationId: null,
    items: [{ id: 's-1', productId: 'p-water', qty: 3, unitFactor: 1, baseQty: 3 }, { id: 's-2', productId: 'p-juice', qty: 4, unitFactor: 1, baseQty: 4 }],
  };
  const saleLines: Row[] = [{ id: 's-1', qty: 3, unitFactor: 1, lineTotal: 10, taxPct: 15 }, { id: 's-2', qty: 4, unitFactor: 1, lineTotal: 18, taxPct: 15 }];
  scripted['invoice.findFirst'] = (a: unknown) => ((a as { select?: { items?: unknown } }).select?.items ? sale : null);
  scripted['invoiceItem.findMany'] = (a: unknown) => {
    const w = (a as { where?: Row }).where ?? {};
    if (w.OR) {
      // returnedBySaleItem: قبل المعاملة لا شيء، وداخلها (بعد القفل) ما التزم مرتجعٌ متزامن
      const n = calls.includes('$transaction') ? (o.returnedUnderLock ?? 0) : 0;
      return n ? [{ qty: n, unitFactor: 1, baseQty: n, returnOfItemId: 's-1', creditedItemId: null }] : [];
    }
    const ids: string[] = (w.id as { in?: string[] } | undefined)?.in ?? [];
    return saleLines.filter(l => ids.includes(l.id));
  };
}

test('المرحلة الأولى: المرتجع من فاتورة بيع (priceRefund) — كل بندٍ بمرجع سطره بعد تسعير الخادم، والبند بلاه بلا مفتاح', async () => {
  reset();
  scriptLinkedReturn();
  const r = await call('POST', '/api/invoices', {
    body: phase1Body([
      water({ invoiceItemId: 's-1', lineRef: '  LR-W1  ' }), juice({ invoiceItemId: 's-2', qty: 1 }), water({ invoiceItemId: 's-1', lineRef: 'LR-W2' }),
    ], { type: 'RETURN', originalInvoiceId: 'sale-1', pricesIncludeTax: false }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const data = (args['invoice.create'].at(-1) as { data: Row }).data;
  // سعر الخادم لا سعر الجسم: شاملٌ، وحصّتا s-1 تتتابعان (٣٫٣٣ ثم ٣٫٣٤) — فالمسار الذي يعيد بناء البنود جرى فعلاً
  assert.equal(data.pricesIncludeTax, true, 'لم يجرِ تسعير المرتجع المرتبط');
  const items = createdItems();
  assert.deepEqual(items.map(i => [i.returnOfItemId, i.lineTotal, i.lineRef ?? null]), [['s-1', 3.33, 'LR-W1'], ['s-2', 4.5, null], ['s-1', 3.34, 'LR-W2']]);
  assert.equal('lineRef' in items[1], false, 'بندٌ بلا مرجعٍ كُتب بمفتاح lineRef');
  assert.deepEqual((r.body.data.items as Row[]).map(i => i.lineRef ?? null), ['LR-W1', null, 'LR-W2']);
});

test('المرحلة الأولى: المرتجع المرتبط يُعاد تسعيره تحت القفل (مرتجعٌ متزامن) — والمراجع باقيةٌ على بنودها', async () => {
  reset();
  scriptLinkedReturn({ returnedUnderLock: 1 });
  const r = await call('POST', '/api/invoices', {
    body: phase1Body([water({ invoiceItemId: 's-1', lineRef: 'LR-W' }), juice({ invoiceItemId: 's-2', qty: 1, lineRef: 'LR-J' })], { type: 'RETURN', originalInvoiceId: 'sale-1' }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // قبل القفل حصّة الحبّة الأولى ٣٫٣٣؛ وتحته رُدّت حبّةٌ قبلها فصارت الثانية ٣٫٣٤ — إعادة البناء داخل المعاملة جرت
  assert.deepEqual(createdItems().map(i => [i.returnOfItemId, i.lineTotal, i.lineRef ?? null]), [['s-1', 3.34, 'LR-W'], ['s-2', 4.5, 'LR-J']]);
});

test('إعادة الرفع (clientRef قائم): البنود المحفوظة تعود كما هي بمرجعها — بلا إنشاء ثانٍ', async () => {
  reset();
  const stored = {
    id: 'inv-old', number: 'INV-1', customerId: 'c-walkin', salesRepId: 'rep-1', zatcaPhase: null,
    items: [{ id: 'it-a', productId: 'p-water', qty: 1, lineRef: 'ERP-OLD' }, { id: 'it-b', productId: 'p-juice', qty: 2, lineRef: null }],
  };
  scriptPhase1({ replay: stored });
  const r = await call('POST', '/api/invoices', { body: phase1Body([water({ lineRef: 'ERP-NEW' })], { clientRef: crypto.randomUUID() }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.idempotent, true);
  assert.deepEqual((r.body.data.items as Row[]).map(i => i.lineRef), ['ERP-OLD', null]);
  assert.equal(calls.includes('invoice.create'), false);
});

// ═══ (٢) GET /invoices?withItems=1&withLots=1 ═══

const LOTS_INCLUDE = { include: { lot: { select: { lotNumber: true, expiryDate: true } } } };

function scriptList(lotsOn: boolean): void {
  scripted = {
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'tenant.findUnique': () => ({ lotTrackingEnabled: lotsOn }),
    'invoice.count': () => 1,
    'invoice.findMany': () => [{
      id: 'inv-1', number: 'INV-1', einvoiceSnapshot: null,
      items: [{ id: 'it-1', unitName: null, product: { unit: 'حبة' }, lineRef: 'ERP-1', lots: [{ id: 'r1', lotId: 'l1', qty: 2, lot: { lotNumber: 'L-1', expiryDate: null } }] }],
    }],
    'invoice.findFirst': () => ({ id: 'inv-1', customerId: null, salesRepId: 'rep-1', zatcaPhase: null, items: [] }),
  };
}
const listInclude = (): Row => ((args['invoice.findMany'] ?? []).at(-1) as { include: Row }).include;

test('GET /invoices?withItems=1&withLots=1 والميزة مفعّلة ⇒ صفوف التوزيع بتضمين GET /:id?withLots=1 نفسه، والبنود بمرجعها', async () => {
  reset();
  scriptList(true);
  const r = await call('GET', '/api/invoices?withItems=1&withLots=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const inc = listInclude().items.include as Row;
  assert.deepEqual(inc.lots, LOTS_INCLUDE);
  assert.deepEqual(inc.product, { select: { name: true, unit: true, primaryUnitId: true } }, 'تضمين الصنف تغيّر');
  const item = r.body.data[0].items[0];
  assert.equal(item.lineRef, 'ERP-1');
  assert.equal(item.lots[0].lot.lotNumber, 'L-1');
  // والتفصيل يضمّ الصفوف بالتضمين نفسه حرفاً
  const one = await call('GET', '/api/invoices/inv-1?withLots=1');
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const detail = ((args['invoice.findFirst'] ?? []).at(-1) as { include: { items: { include: Row } } }).include.items.include;
  assert.deepEqual(detail.lots, inc.lots);
});

test('GET /invoices: الميزة مطفأة أو بلا withLots أو بلا withItems ⇒ البنود كما كانت (ولا قراءة للعَلَم بلا المعاملين معاً)', async () => {
  reset();
  scriptList(false);
  let r = await call('GET', '/api/invoices?withItems=1&withLots=1');
  assert.equal(r.status, 200);
  assert.equal('lots' in (listInclude().items.include as Row), false, 'صفوف لوطٍ لشركةٍ أطفأت الميزة (D8)');

  reset();
  scriptList(true);
  r = await call('GET', '/api/invoices?withItems=1');
  assert.equal(r.status, 200);
  assert.deepEqual(listInclude().items, { include: { product: { select: { name: true, unit: true, primaryUnitId: true } } } });
  assert.equal(calls.includes('tenant.findUnique'), false, 'قُرئ العَلَم بلا withLots');

  reset();
  scriptList(true);
  r = await call('GET', '/api/invoices?withLots=1');
  assert.equal(r.status, 200);
  assert.equal('items' in listInclude(), false);
  assert.equal(calls.includes('tenant.findUnique'), false, 'قُرئ العَلَم بلا withItems');
});

test('GET /:id/returnable: كل سطر بيعٍ بمرجع سطره كما حُفظ (null لما لم يُرسَل) — يطابق به المُكامِل ما يُرجِع منه', async () => {
  reset();
  const product = {
    id: 'p-water', name: 'مياه', code: 'W1', unit: 'حبة', primaryUnitId: null, units: [],
    shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
    returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, repReturnAllowed: true, repReturnUnit: null,
  };
  const line = (id: string, lineRef: string | null) => ({ id, productId: 'p-water', qty: 2, lineTotal: 23, taxPct: 15, expiresAt: null, unitName: null, unitFactor: 1, baseQty: 2, lineRef, product });
  scripted = {
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => ({
      id: 'sale-1', number: 'INV-1', invoiceDate: new Date('2026-10-01T10:00:00Z'), clientCreatedAt: null, customerId: 'c1', salesRepId: 'rep-1',
      type: 'CASH', status: 'CONFIRMED', documentKind: null, items: [line('s-1', 'S-1'), line('s-2', null)],
    }),
  };
  const r = await call('GET', '/api/invoices/sale-1/returnable');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((r.body.data.lines as Row[]).map(l => [l.saleItemId, l.lineRef]), [['s-1', 'S-1'], ['s-2', null]]);
  const sel = ((args['invoice.findFirst'] ?? []).at(-1) as { select: { items: { select: Row } } }).select.items.select;
  assert.equal(sel.lineRef, true);
});

// ═══ (٣) المرحلة الثانية: الفاتورة والمرتجع والإشعاران ═══

interface Rig { h: SubmitHarness; rows: Map<string, Row>; priorNotes: Row[]; created: Row[] }

function txAdapter(rig: Rig): Row {
  const invoice = {
    findFirst: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
    findMany: async ({ where }: { where: { originalInvoiceId?: string | null; documentKind?: unknown } }) =>
      (where && 'documentKind' in where && where.documentKind === null ? [] : rig.priorNotes.filter(n => !where?.originalInvoiceId || n.originalInvoiceId === where.originalInvoiceId)),
    create: async ({ data }: { data: Row }) => {
      const id = `doc-${rig.created.length + 1}`;
      const nested = data.items as { create?: Row[] } | undefined;
      const row: Row = { ...data, id, status: 'CONFIRMED', items: nested?.create ?? [], customer: null, installments: [], signature: null };
      rig.rows.set(id, row);
      rig.created.push(row);
      rig.h.docs.invoices.set(id, {
        id, tenantId: String(data.tenantId), zatcaPhase: 2, einvoiceStatus: (data.einvoiceStatus as string) ?? null,
        einvoiceQr: (data.einvoiceQr as string) ?? null, einvoiceWarnings: null, einvoiceSubmittedAt: null,
      });
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = rig.rows.get(where.id);
      if (!row) return null;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'decrement' in v) row[k] = Math.round((num(row[k]) - num((v as { decrement: number }).decrement)) * 100) / 100;
        else row[k] = v;
      }
      return row;
    },
  };
  return {
    invoice,
    notification: { create: async () => ({ id: 'n' }) },
    customer: { update: async () => ({}) },
    accountEntry: { create: async () => ({}), aggregate: async () => ({ _sum: { debit: 0, credit: 0 } }) },
  };
}

function buildRig(): Rig {
  const h = createSubmitHarness();
  const rig: Rig = { h, rows: new Map(), priorNotes: [], created: [] };
  const deps: NoteIssuanceDeps = {
    db: prismaFake as unknown as NoteIssuanceDeps['db'],
    units: h.units,
    documents: {
      insertSigned: (_tx, doc) => h.docs.insertSigned(null, doc),
      advanceUnitChain: (_tx, a) => h.docs.advanceUnitChain(null, a),
      loadProjection: (tenantId, invoiceId) => h.docs.loadProjection(tenantId, invoiceId),
    },
    chain: {
      lockChainHead: (_tx, unitId) => h.chain.lockChainHead(null, unitId),
      nextNumberInTx: async (_tx, _tenantId, prefix) => `${prefix}${String(rig.created.length + 1).padStart(6, '0')}`,
    },
    keyring: () => h.keyring,
    ledger: {
      postCashInvoice: async () => { /* القيود خارج هذا الاختبار */ },
      postCreditInvoice: async () => { /* القيود خارج هذا الاختبار */ },
      creditLimitNotice: async () => { /* لا حدّ ائتمانيّ هنا */ },
      postReturn: async () => { /* القيود خارج هذا الاختبار */ },
      postDebitNote: async () => { /* القيود خارج هذا الاختبار */ },
    },
    transaction: <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => fn(txAdapter(rig) as unknown as Phase2Tx),
    publish: () => { /* لا بثّ */ },
    expireLinks: () => { /* لا روابط */ },
    now: () => h.clock.now(),
    env: {} as NodeJS.ProcessEnv,
    mutex: null,
    submitInline: (ref, o) => submitDocument(h.deps, ref, { inline: true, timeoutMs: o.timeoutMs }),
  };
  phase2Deps = deps;
  return rig;
}

/** صفّ القاعدة لفاتورةٍ أصلية كما يقرؤه محمّل الإشعار (بند مع بطاقة صنفه) — نمط invoices-notes-route.test.ts */
function dbRow(o: NoteOriginalInvoice): Row {
  return {
    id: o.id, tenantId: o.tenantId, customerId: o.customerId, salesRepId: o.salesRepId, number: o.number, status: o.status,
    type: o.type, paymentPlan: o.paymentPlan, zatcaPhase: o.zatcaPhase, documentKind: o.documentKind,
    invoiceSubtype: o.invoiceSubtype, einvoiceStatus: o.einvoiceStatus, pricesIncludeTax: o.pricesIncludeTax,
    discountPct: o.discountPct, total: o.total, paidAmt: o.paidAmt, remainingAmt: o.remainingAmt, einvoiceSnapshot: null,
    items: o.items.map(i => ({ ...i, product: { name: i.itemName, unit: i.baseUnitName ?? 'حبة', damagedReturnToStock: i.damagedReturnToStock, units: i.units ?? [] } })),
  };
}

/** ردود القاعدة لشركةٍ مفعّلة (المرحلة الثانية) — والأصل القياسيّ المعتمد (it-1 أرز، it-2 سكر، it-3 كمامات) في جدول المعاملة */
function scriptPhase2(rig: Rig, o: { withOriginal?: boolean; manualReturns?: boolean } = {}): NoteOriginalInvoice | null {
  const original = o.withOriginal === false ? null : originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, subtype: '01', einvoiceStatus: 'cleared' });
  if (original) rig.rows.set(original.id, dbRow(original));
  const seller = rig.h.units.settings.get(Z5_TENANT);
  if (seller) rig.h.units.settings.set(Z5_TENANT, { ...seller, zatcaPhase2StartedAt: LIVE_AT });
  calls = []; args = {};
  scripted = {
    // البحث بالرقم (حارس الرقم اليدويّ في النظام) لا يطابق شيئاً، وغيره الأصل
    'invoice.findFirst': (a: unknown) => ((a as { where?: { number?: unknown } }).where?.number ? null : (original ? rig.rows.get(original.id) ?? null : null)),
    'invoice.findUnique': () => null,
    'invoice.findMany': (a: unknown) => { const w = (a as { where?: Row }).where ?? {}; return 'documentKind' in w && w.documentKind === null ? [] : rig.priorNotes; },
    'customer.findFirst': () => CUSTOMER_ROW(CUSTOMERS.b2bComplete as unknown as Row),
    'salesRep.findFirst': () => REP,
    'product.findMany': (a: unknown) => { const ids: string[] = (a as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? []; return PRODUCT_ROWS.filter(p => ids.includes(p.id)); },
    'companySettings.findUnique': () => ({
      defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: LIVE_AT, zatcaGoLiveArmedAt: null,
      returnRequiresSaleInvoice: o.manualReturns ? false : null, returnPolicyChangedAt: null,
    }),
    'zatcaEgsUnit.findMany': (a: unknown) => {
      const env = (a as { where?: { environment?: string } }).where?.environment;
      const u = rig.h.units.units.get(rig.h.unitId);
      return env === 'production'
        ? [{ id: rig.h.unitId, tenantId: Z5_TENANT, environment: u?.environment, status: u?.status, keyVersion: u?.keyVersion, vatNumber: u?.vatNumber, certNotAfter: new Date('2031-01-01T00:00:00Z'), lastIcv: 0, lastInvoiceHash: null }]
        : [];
    },
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, invoiceSignatureEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
  return original;
}

/** [الصنف، المرجع] لكل بند في المستند المُنشأ — مرتّبةً بالصنف: المطابقة بالبند لا بالموضع */
const refsByProduct = (row: Row): [string | null, string | null][] =>
  (row.items as Row[]).map(i => [i.productId ?? i.itemName ?? null, i.lineRef ?? null] as [string | null, string | null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const XML_OF = (rig: Rig): string => [...rig.h.docs.documents.values()].map(d => gunzipXml(d.xmlGz)).join('\n');

test('المرحلة الثانية: فاتورة قياسية — lineRef على بنودها (createInvoice)، والفارغ بلا مفتاح، ولا يدخل الـXML ولا اللقطة', async () => {
  reset();
  const rig = buildRig();
  scriptPhase2(rig, { withOriginal: false });
  const r = await call('POST', '/api/invoices', {
    body: {
      customerId: 'c-b2b', salesRepId: 'rep-1', type: 'CREDIT', pricesIncludeTax: false, discountPct: 0, clientRef: crypto.randomUUID(),
      items: [
        { productId: 'p-rice', qty: 10, unitPrice: 45.5, discountPct: 0, taxPct: 15, lineRef: ' P2-RICE ' },
        { productId: 'p-sugar', qty: 1, unitPrice: 3.35, discountPct: 0, taxPct: 15, lineRef: '' },
      ],
    },
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(rig.created.length, 1);
  const items = rig.created[0].items as Row[];
  assert.deepEqual(items.map(i => i.lineRef), ['P2-RICE', undefined]);
  assert.equal('lineRef' in items[1], false);
  assert.equal((r.body.data.items as Row[])[0].lineRef, 'P2-RICE', 'ردّ الإصدار بلا مرجع السطر');
  assert.ok(!XML_OF(rig).includes('P2-RICE'), 'مرجع السطر دخل مستند الهيئة');
  assert.ok(!JSON.stringify(rig.created[0].einvoiceSnapshot ?? null).includes('P2-RICE'), 'مرجع السطر دخل لقطة الفوترة');
});

test('المرحلة الثانية: الإشعار الدائن «برقمٍ يدويّ» (المرتجع بلا أصل والاشتراط مطفأ) — lineRef على بنوده', async () => {
  reset();
  const rig = buildRig();
  scriptPhase2(rig, { withOriginal: false, manualReturns: true });
  const r = await call('POST', '/api/invoices', {
    body: {
      customerId: 'c-b2b', salesRepId: 'rep-1', type: 'RETURN', pricesIncludeTax: false, discountPct: 0, clientRef: crypto.randomUUID(),
      originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CREDIT', noteReason: 'بضاعة تالفة من النظام السابق',
      items: [
        { productId: 'p-rice', qty: 2, unitPrice: 45.5, discountPct: 0, taxPct: 15, lineRef: 'M-RICE' },
        { productId: 'p-sugar', qty: 1, unitPrice: 3.35, discountPct: 0, taxPct: 15 },
      ],
    },
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(rig.created[0].documentKind, 'CREDIT_NOTE');
  assert.deepEqual(refsByProduct(rig.created[0]), [['p-rice', 'M-RICE'], ['p-sugar', null]]);
});

test('المرحلة الثانية: المرتجع المرتبط (D3) — بنود الإشعار بترتيب الأصل، وكلٌّ بمرجع سطر طلبه لا بموضعه', async () => {
  reset();
  const rig = buildRig();
  const original = scriptPhase2(rig)!;
  const r = await call('POST', '/api/invoices', {
    body: {
      customerId: 'c-b2b', salesRepId: 'rep-1', type: 'RETURN', pricesIncludeTax: false, discountPct: 0, clientRef: crypto.randomUUID(),
      originalInvoiceId: original.id, noteReason: 'بضاعة تالفة',
      // ترتيب الطلب عكس ترتيب الأصل (it-1 أرز قبل it-3 كمامات)
      items: [
        { productId: 'p-mask', qty: 1, unitPrice: 19.99, discountPct: 0, taxPct: 0, lineRef: 'R-MASK' },
        { productId: 'p-rice', qty: 2, unitPrice: 45.5, discountPct: 0, taxPct: 15, lineRef: 'R-RICE' },
      ],
    },
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const note = rig.created[0];
  assert.deepEqual((note.items as Row[]).map(i => i.productId), ['p-rice', 'p-mask'], 'البنود ليست بترتيب الأصل — الاختبار لا يقيس المطابقة');
  assert.deepEqual(refsByProduct(note), [['p-mask', 'R-MASK'], ['p-rice', 'R-RICE']]);
});

test('POST /:id/credit-note — كل بندٍ بمرجع سطر طلبه (ترتيب الأصل لا الطلب)، والبند بلا مرجع بلا مفتاح، وFULL بلا مراجع', async () => {
  reset();
  let rig = buildRig();
  let original = scriptPhase2(rig)!;
  let r = await call('POST', `/api/invoices/${original.id}/credit-note`, {
    body: {
      reason: 'إرجاع بضاعة من العميل', clientRef: crypto.randomUUID(),
      lines: [{ invoiceItemId: 'it-3', qty: 1, lineRef: 'C-3' }, { invoiceItemId: 'it-1', qty: 2, lineRef: '  C-1  ' }, { invoiceItemId: 'it-2', qty: 1 }],
    },
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const items = rig.created[0].items as Row[];
  assert.deepEqual(items.map(i => [i.creditedItemId, i.lineRef ?? null]), [['it-1', 'C-1'], ['it-2', null], ['it-3', 'C-3']]);
  assert.equal('lineRef' in items[1], false);
  assert.deepEqual((r.body.data.items as Row[]).map(i => i.lineRef ?? null), ['C-1', null, 'C-3'], 'ردّ الإشعار بلا مرجع السطر');

  reset();
  rig = buildRig();
  original = scriptPhase2(rig)!;
  r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: { reason: 'إلغاء الفاتورة كاملة', clientRef: crypto.randomUUID(), lines: 'FULL' }, headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((rig.created[0].items as Row[]).length, 3);
  assert.ok((rig.created[0].items as Row[]).every(i => !('lineRef' in i)), 'إشعارٌ كامل كُتب بمراجع لم تُرسَل');
});

test('POST /:id/credit-note بمفتاح API (مسار baseUnitName/الأساس المتوقَّع) يحمل lineRef، وفوق ١٠٠ ⇒ 400 بلا مستند', async () => {
  reset();
  let rig = buildRig();
  let original = scriptPhase2(rig)!;
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT, apiKeyId: 'key-1' };
  let r = await call('POST', `/api/invoices/${original.id}/credit-note`, {
    body: { reason: 'إرجاع بضاعة من العميل', clientRef: crypto.randomUUID(), lines: [{ invoiceItemId: 'it-1', qty: 1, lineRef: 'API-1' }] },
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(calls.includes('invoiceItem.findMany'), 'لم يمرّ بمسار المفتاح');
  assert.deepEqual((rig.created[0].items as Row[]).map(i => i.lineRef), ['API-1']);

  reset();
  rig = buildRig();
  original = scriptPhase2(rig)!;
  r = await call('POST', `/api/invoices/${original.id}/credit-note`, {
    body: { reason: 'إرجاع بضاعة من العميل', clientRef: crypto.randomUUID(), lines: [{ invoiceItemId: 'it-1', qty: 1, lineRef: `${L100}+` }] },
    headers: CAPS,
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(rig.created.length, 0);
});

test('POST /:id/debit-note — بنود المدين بترتيب الطلب، كلٌّ بمرجعه', async () => {
  reset();
  const rig = buildRig();
  const original = scriptPhase2(rig)!;
  const r = await call('POST', `/api/invoices/${original.id}/debit-note`, {
    body: {
      reason: 'فرق سعر على الفاتورة', clientRef: crypto.randomUUID(),
      lines: [{ description: 'فرق سعر أرز', qty: 1, unitPrice: 100, taxPct: 15, lineRef: 'D-1' }, { description: 'رسوم توصيل', qty: 1, unitPrice: 10, taxPct: 15 }],
    },
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual((rig.created[0].items as Row[]).map(i => [i.itemName, i.lineRef ?? null]), [['فرق سعر أرز', 'D-1'], ['رسوم توصيل', null]]);
});

// ═══ (٤) الدوالّ النقيّة ═══

test('noteLineRefs: سطران لبند الأصل نفسه (كرتون وحبة) يُزوَّجان بترتيب طلبهما، وبنود المرتجع سطراً بسطر، وFULL والمدين', () => {
  const eng = (n: number) => ({ items: Array.from({ length: n }, () => ({})) }) as never;
  const explicit = [{ invoiceItemId: 'it-1', qty: 1, lineRef: 'A' }, { invoiceItemId: 'it-2', qty: 1, lineRef: 'B' }, { invoiceItemId: 'it-1', qty: 3, lineRef: 'C' }];
  assert.deepEqual(
    noteLineRefs('CREDIT_NOTE', explicit, explicit, { lines: [{ invoiceItemId: 'it-1' }, { invoiceItemId: 'it-1' }, { invoiceItemId: 'it-2' }] as never, engine: eng(3) }),
    ['A', 'C', 'B'],
  );
  // بنود المرتجع (بالصنف أو بالمعرّف) وقد حُلّت إلى بنود الأصل بموضعها نفسه
  const fromReturn = { fromReturnItems: [{ productId: 'p-1', qty: 1, lineRef: 'X' }, { invoiceItemId: 'it-9', qty: 1, lineRef: null }] };
  assert.deepEqual(
    noteLineRefs('CREDIT_NOTE', fromReturn, [{ invoiceItemId: 'it-5', qty: 1 }, { invoiceItemId: 'it-9', qty: 1 }], { lines: [{ invoiceItemId: 'it-9' }, { invoiceItemId: 'it-5' }] as never, engine: eng(2) }),
    [null, 'X'],
  );
  assert.deepEqual(noteLineRefs('CREDIT_NOTE', 'FULL', 'FULL', { lines: [{ invoiceItemId: 'it-1' }, { invoiceItemId: 'it-2' }] as never, engine: eng(2) }), [null, null]);
  // المدين بلا سطور أصل (lines فارغة) — بموضع بنود المحرّك
  const debit = [{ description: 'أ', qty: 1, unitPrice: 1, taxPct: 15, lineRef: 'D' }, { description: 'ب', qty: 1, unitPrice: 1, taxPct: 15 }];
  assert.deepEqual(noteLineRefs('DEBIT_NOTE', debit, undefined, { lines: [], engine: eng(2) }), ['D', null]);
});

test('lineRefColumn وlegacyItemColumns: المرجع يُكتب حين يحضر نصّاً غير فارغ، وإلا لا مفتاح — صفّ ما قبل الميزة كما كان', () => {
  assert.deepEqual(lineRefColumn('X-1'), { lineRef: 'X-1' });
  for (const v of ['', null, undefined, 5]) assert.deepEqual(lineRefColumn(v), {});
  const line = { productId: 'p-water', qty: 2, unitPrice: 60, discountPct: 0, discountAmt: 0, taxPct: 15, taxAmt: 15.65, lineTotal: 120, unitName: null, unitFactor: 1, unitCode: null };
  assert.equal(legacyItemColumns({ ...line, lineRef: 'L-9' }).lineRef, 'L-9');
  assert.equal('lineRef' in legacyItemColumns(line), false);
  assert.equal('lineRef' in legacyItemColumns({ ...line, lineRef: null }), false);
});

// ═══ (٥) حمولة ERP (payloadVersion 3) ═══

test('ERP: بنود الفاتورة بلا lineRef (بالأساس وبالكرتون) — والحمولة نفسها حرفياً كفاتورةٍ بلا مرجع', () => {
  const inv = (withRef: boolean) => ({
    id: 'i1', number: 'INV-1', type: 'CASH', status: 'CONFIRMED', invoiceDate: new Date('2026-11-01T09:00:00Z'), pricesIncludeTax: false,
    subtotal: 106, taxAmt: 15.9, total: 121.9,
    items: [
      { qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, unitCode: 'CT', unitPrice: 48, taxPct: 15, taxAmt: 14.4, lineTotal: 110.4, product: { id: 'p1', unit: 'حبة' }, ...(withRef && { lineRef: 'ERP-A' }) },
      { qty: 1, unitName: null, unitFactor: 1, baseQty: 1, unitPrice: 10, taxPct: 15, taxAmt: 1.5, lineTotal: 11.5, product: { id: 'p2', unit: 'حبة' }, ...(withRef && { lineRef: null }) },
    ],
  });
  const row = invoicePayloadRow(inv(true) as never, 'Asia/Riyadh');
  assert.equal(row.payloadVersion, 3);
  for (const it of row.items as Row[]) assert.equal('lineRef' in it, false, 'مرجع السطر خرج في حمولة ERP');
  assert.deepEqual(row, invoicePayloadRow(inv(false) as never, 'Asia/Riyadh'));
});

test('ERP: withoutLineRef يعيد الكائن نفسه بلا المفتاح، ونسخةً بلاه حين يحضر — والأصل لا يُعدَّل', () => {
  const plain = { id: 'x', qty: 1 };
  assert.equal(withoutLineRef(plain), plain);
  const withRef = { id: 'x', qty: 1, lineRef: 'R' };
  const out = withoutLineRef(withRef);
  assert.deepEqual(out, { id: 'x', qty: 1 });
  assert.equal(withRef.lineRef, 'R');
});
