// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦، services/taxMode.ts) — إصدار POST /api/invoices الحقيقي فوق عميل Prisma مزيّف (نمط
// line-ref-invoices.test.ts). لا قاعدة ولا شبكة. المطلوب إثباته:
//   • الشركة بضريبتها (taxDisabled غائب أو false): النداءات نفسها بترتيبها، والمستند نفسه حرفاً (بلا مفتاح taxFree، zatca/generated).
//   • «بلا ضريبة» إصدارٌ حيّ بنسبة صفر أو غائبة: كل بندٍ صفر، taxAmt صفر، none/null، وختم taxFree — بالسعر المرسل نفسه.
//   • جلسةٌ حيّة ببندٍ فوق الصفر ⇒ 409 TAX_MODE_CHANGED، ومفتاح API ⇒ 422 TAX_DISABLED — بلا معاملة ولا مستند.
//   • إعادة رفع الصندوق ببندٍ فوق الصفر تُقبل كما بناها الجهاز (مسار اليوم حرفاً)، وكل بنودها صفر ⇒ بلا ضريبة.
//   • المرتجع من فاتورة بيع: المبلغ المسترد نفسه بنسبة صفر، وحارس سعر المندوب بالسعر الصافي كما هو.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

// نقيّ بلا استيراد — يُحمَّل قبل الحقن بلا أثر
import { TAX_MODE_CODES, TAX_MODE_MESSAGES } from '../services/taxMode';

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
let scripted: Record<string, (a: any) => unknown> = {};

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

const TID = 'tenant-tax-off';
type User = { id: string; role: string; tenantId: string; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TID };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TID };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TID, apiKeyId: 'key-1' };
let currentUser: User = ADMIN;
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
// المرحلة الثانية لا تُلمس هنا أبداً: أيّ نداءٍ لاعتمادياتها فشلٌ صريح
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('فرع المرحلة الثانية لا يُبلغ في هذه الاختبارات'); } });

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesModule = require('../routes/invoices') as typeof import('../routes/invoices');
const invoicesRouter = invoicesModule.default as express.Router;
const { priceLinkedReturn } = invoicesModule;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ الخادم ═══

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
async function postInvoice(body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const s = await startServer();
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/invoices', agent: false,
      headers: { connection: 'close', 'Content-Type': 'application/json', 'Content-Length': String(payload.length), ...headers },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b: Row = {}; try { b = t ? JSON.parse(t) : {}; } catch { b = { raw: t }; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ═══ بيانات المنصّة المزيّفة ═══

/** الأسعار الأساسية صافية (١٠٠ و٤٠) ونسبة الصنف المخزّنة ١٥ — تبقى مخزّنة تحت «إزالة الضريبة» (قرار المالك) */
const productRow = (id: string, name: string, basePrice: number): Row => ({
  id, name, unit: 'حبة', basePrice, taxPct: 15, damagedReturnToStock: true, priceTiers: [], units: [], teams: [], categoryId: null,
  lotTracked: false, repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null, primaryUnitId: null, shelfLifeEnabled: false, returnRuleEnabled: false,
});
const PRODUCT_ROWS = [productRow('p-a', 'صنف أ', 100), productRow('p-b', 'صنف ب', 40)];
const REP: Row = {
  id: 'rep-1', tenantId: TID, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, maxDiscountPct: 100,
};
const CUSTOMER: Row = { id: 'c-1', name: 'عميل', status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: TID, priceListId: null };

/** صفّ الإعدادات كما يقرؤه POST /invoices (select المسار) — والمتغيّر عمودا «إزالة الضريبة» وحدهما */
const BASE_SETTINGS: Row = {
  defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null,
  returnRequiresSaleInvoice: null, returnPolicyChangedAt: null,
};
const TAX_ON_ABSENT: Row = { ...BASE_SETTINGS };
const TAX_ON_FALSE: Row = { ...BASE_SETTINGS, taxDisabled: false, taxModeChangedAt: null };
const TAX_OFF: Row = { ...BASE_SETTINGS, taxDisabled: true, taxModeChangedAt: new Date('2026-11-07T08:00:00.000Z') };

/** البيع المرتبط: s-1 صنف أ ٣ حبّات بعشرة شاملةً ١٥٪، وs-2 صنف ب ٤ بثمانية عشر — بيعٌ صدر بضريبته قبل الإزالة */
const SALE = {
  customerId: 'c-1', type: 'CASH', status: 'CONFIRMED', documentKind: null, locationId: null,
  items: [{ id: 's-1', productId: 'p-a', qty: 3, unitFactor: 1, baseQty: 3 }, { id: 's-2', productId: 'p-b', qty: 4, unitFactor: 1, baseQty: 4 }],
};
const SALE_LINES: Row[] = [{ id: 's-1', qty: 3, unitFactor: 1, lineTotal: 10, taxPct: 15 }, { id: 's-2', qty: 4, unitFactor: 1, lineTotal: 18, taxPct: 15 }];

function reset(user: User = ADMIN): void {
  calls = []; args = {}; scripted = {};
  currentUser = user;
  delete process.env.ZATCA_REHEARSAL_TENANT_IDS;
}

function script(settings: Row, o: { rep?: Row; linkedSale?: boolean } = {}): void {
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => ({ ...REP, ...(o.rep ?? {}) }),
    'customer.findFirst': () => CUSTOMER,
    'product.findMany': (a: { where?: { id?: { in?: string[] } } }) => { const ids = a.where?.id?.in ?? []; return PRODUCT_ROWS.filter(p => ids.includes(p.id)); },
    // صفّ المسار (select بـdefaultVatPct)، وعزل العملاء للمندوب (customerIsolationEnabled) — استعلامان مختلفان
    'companySettings.findUnique': (a: { select?: Row }) => (a.select?.defaultVatPct ? { ...settings } : { customerIsolationEnabled: false }),
    'tenant.findUnique': () => ({ invoiceSignatureEnabled: false, lotTrackingEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': (a: { select?: Row }) => (o.linkedSale && a.select?.items ? SALE : null),
    'invoice.create': (a: { data: Row }) => {
      const data = a.data;
      const items = ((data.items as { create?: Row[] } | undefined)?.create ?? []).map((i, k) => ({ id: `i${k}`, ...i }));
      return { id: 'inv-1', ...data, items, customer: CUSTOMER, installments: [], signature: null };
    },
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
  if (o.linkedSale) {
    scripted['invoiceItem.findMany'] = (a: { where?: Row }) => {
      const w = a.where ?? {};
      if (w.OR) return []; // returnedBySaleItem: لا مرتجع سابق
      const ids: string[] = (w.id as { in?: string[] } | undefined)?.in ?? [];
      return SALE_LINES.filter(l => ids.includes(l.id));
    };
  }
}

const line = (over: Row = {}): Row => ({ productId: 'p-a', qty: 2, unitPrice: 115, discountPct: 0, taxPct: 15, ...over });
const lineB = (over: Row = {}): Row => ({ productId: 'p-b', qty: 1, unitPrice: 46, discountPct: 0, taxPct: 15, ...over });
/** بنود «بلا ضريبة» كما يرسلها جهازٌ حدّث شركته: السعر الصافي المكتوب ونسبة صفر */
const netLines = (over: Row = {}): Row[] => [line({ unitPrice: 100, taxPct: 0, ...over }), lineB({ unitPrice: 40, taxPct: 0, ...over })];
const invBody = (items: Row[], over: Row = {}): Row => ({ customerId: 'c-1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: true, discountPct: 0, items, ...over });
const linkedReturnBody = (taxPct: number | undefined): Row => invBody([
  { productId: 'p-a', invoiceItemId: 's-1', qty: 1, unitPrice: 999, discountPct: 0, ...(taxPct !== undefined && { taxPct }) },
  { productId: 'p-b', invoiceItemId: 's-2', qty: 1, unitPrice: 1, discountPct: 0, ...(taxPct !== undefined && { taxPct }) },
], { type: 'RETURN', originalInvoiceId: 'sale-1' });

const created = (): Row => {
  const a = (args['invoice.create'] ?? []).at(-1) as { data?: Row } | undefined;
  assert.ok(a?.data, `لم يُنشأ مستند: ${calls.join(' → ')}`);
  return a!.data!;
};
const createdItems = (): Row[] => (created().items as { create: Row[] }).create;
const REPLAY = { 'X-FS-Replay': '1' };

/** ختم «بلا ضريبة» كاملاً على المستند المكتوب: صفرٌ في كل بند، none/null، وtaxFree */
function assertTaxFreeDoc(data: Row, total: number): void {
  assert.equal(data.taxFree, true, 'المستند بلا ختم taxFree');
  assert.equal(data.einvoiceProvider, 'none');
  assert.equal(data.einvoiceStatus, null);
  assert.equal(data.taxAmt, 0);
  assert.equal(data.total, total);
  for (const i of (data.items as { create: Row[] }).create) {
    assert.equal(i.taxPct, 0, 'بندٌ بنسبةٍ فوق الصفر');
    assert.equal(i.taxAmt, 0, 'بندٌ بضريبة');
  }
}

/** ختم مسار اليوم: بلا مفتاح taxFree، ومزوّد الشركة وحالته */
function assertTodayDoc(data: Row): void {
  assert.equal('taxFree' in data, false, 'مستند الشركة بضريبتها كُتب بمفتاح taxFree');
  assert.equal(data.einvoiceProvider, 'zatca');
  assert.equal(data.einvoiceStatus, 'generated');
}

/** تسلسل استعلامات إصدار الإدارة الحيّ في المرحلة الأولى — هو نفسه في invoices-phase2-route.test.ts (لا يتغيّر بالميزة) */
const PHASE1_POST_CALLS = [
  'invoice.findUnique', 'salesRep.findFirst', 'admin.findUnique', 'customer.findFirst', 'admin.findUnique', 'product.findMany',
  'companySettings.findUnique', 'invoice.findFirst', '$transaction', '$queryRaw', '$executeRaw', '$queryRaw', '$executeRaw',
  'invoice.create', 'accountEntry.aggregate', 'accountEntry.create', 'accountEntry.create', 'customer.update',
];
const PHASE1_POST_CALLS_WITH_CUSTOMER_LOCK = (() => {
  const withLock = [...PHASE1_POST_CALLS];
  withLock.splice(withLock.indexOf('invoice.create') + 1, 0, '$queryRaw');
  return withLock;
})();

// ═══ (١) الشركة بضريبتها: لا أثر ═══

type Run = { status: number; body: Row; calls: string[]; create: unknown[]; settingsSelect: unknown[] };
async function runOnce(settings: Row, user: User, body: Row, headers: Record<string, string> = {}, o: { rep?: Row; linkedSale?: boolean } = {}): Promise<Run> {
  reset(user);
  script(settings, o);
  const r = await postInvoice(body, headers);
  return {
    status: r.status, body: r.body, calls: [...calls], create: args['invoice.create'] ?? [],
    settingsSelect: (args['companySettings.findUnique'] ?? []).map((a) => (a as { select?: unknown }).select),
  };
}

test('الشركة بضريبتها: taxDisabled غائبٌ أو false ⇒ النداءات بترتيبها والمستند والردّ حرفاً بحرف — بلا taxFree، وzatca/generated', async () => {
  const scenarios: Array<{ name: string; user: User; body: Row; headers?: Record<string, string>; o?: { rep?: Row; linkedSale?: boolean } }> = [
    { name: 'الإدارة حيّاً', user: ADMIN, body: invBody([line(), lineB()]) },
    { name: 'الإدارة بنسبةٍ غائبة (الاحتياطية ١٥)', user: ADMIN, body: invBody([line({ taxPct: undefined }), lineB()]) },
    { name: 'مفتاح API بنسبة ١٥', user: API_KEY, body: invBody([line(), lineB()]) },
    { name: 'المندوب حيّاً بلا «تغيير السعر»', user: REP_USER, body: invBody([line(), lineB()]), o: { rep: { canChangePrice: false, canSellBelowPrice: false } } },
    { name: 'إعادة رفع المندوب', user: REP_USER, body: invBody([line(), lineB()], { clientRef: '7b0f3c64-0d62-4d5e-9d36-2b1f4d1b7a11' }), headers: REPLAY },
    { name: 'المرتجع من فاتورة بيع', user: ADMIN, body: linkedReturnBody(15), o: { linkedSale: true } },
  ];
  for (const s of scenarios) {
    const absent = await runOnce(TAX_ON_ABSENT, s.user, s.body, s.headers, s.o);
    const off = await runOnce(TAX_ON_FALSE, s.user, s.body, s.headers, s.o);
    assert.equal(absent.status, 201, `${s.name}: ${JSON.stringify(absent.body)}`);
    assert.deepEqual(off.calls, absent.calls, `${s.name}: تسلسل الاستعلامات تغيّر`);
    assert.deepEqual(off.create, absent.create, `${s.name}: بيانات المستند تغيّرت`);
    assert.deepEqual(off.body, absent.body, `${s.name}: الردّ تغيّر`);
    assert.equal(off.calls.filter(c => c === 'invoice.create').length, 1);
    assertTodayDoc((off.create[0] as { data: Row }).data);
    // الاستعلام واحدٌ (select المسار نفسه بعموديه الجديدين) — لا استعلام ثانٍ لـ«إزالة الضريبة»
    const routeSelects = off.settingsSelect.filter((sel) => (sel as Row | undefined)?.defaultVatPct);
    assert.equal(routeSelects.length, 1, `${s.name}: استعلام إعدادات ثانٍ`);
    assert.deepEqual(routeSelects[0], {
      defaultVatPct: true, countryCode: true, currency: true, einvoiceProvider: true, zatcaPhase2StartedAt: true, zatcaGoLiveArmedAt: true,
      returnRequiresSaleInvoice: true, returnPolicyChangedAt: true, taxDisabled: true, taxModeChangedAt: true,
    });
  }
});

test('الشركة بضريبتها: إصدار الإدارة الحيّ بتسلسل المرحلة الأولى نفسه، والأرقام كما اليوم (الشامل ١٥٪ والاحتياطية للغائبة)', async () => {
  // clientRef كمسار الإصدار المعتاد (قراءة التكرار أوّلاً)
  const r = await runOnce(TAX_ON_FALSE, ADMIN, invBody([line(), lineB()], { clientRef: crypto.randomUUID() }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const asJson = JSON.stringify(r.calls);
  assert.ok(asJson === JSON.stringify(PHASE1_POST_CALLS) || asJson === JSON.stringify(PHASE1_POST_CALLS_WITH_CUSTOMER_LOCK), `التسلسل تغيّر:\n${r.calls.join('\n')}`);
  const data = (r.create[0] as { data: Row }).data;
  assert.deepEqual([data.subtotal, data.taxAmt, data.total], [240, 36, 276]);
  assert.deepEqual((data.items as { create: Row[] }).create.map(i => [i.taxPct, i.taxAmt, i.lineTotal]), [[15, 30, 230], [15, 6, 46]]);
  // نسبةٌ غائبة ⇒ ضريبة الدولة الاحتياطية كما اليوم (لا صفر)
  const missing = await runOnce(TAX_ON_FALSE, ADMIN, invBody([line({ taxPct: undefined })]));
  assert.equal(missing.status, 201);
  const m = (missing.create[0] as { data: Row }).data;
  assert.deepEqual([m.taxAmt, (m.items as { create: Row[] }).create[0].taxPct], [30, 15]);
});

// ═══ (٢) «بلا ضريبة»: الإصدار الحيّ ═══

test('«بلا ضريبة» — الإدارة حيّاً بنسبة صفر: البنود صفر والسعر المكتوب نهائي، none/null وختم taxFree — شاملٌ وحصريّ سواء', async () => {
  for (const pricesIncludeTax of [true, false]) {
    reset(ADMIN);
    script(TAX_OFF);
    const r = await postInvoice(invBody(netLines(), { pricesIncludeTax }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const data = created();
    assertTaxFreeDoc(data, 240);
    assert.equal(data.subtotal, 240);
    assert.equal(data.discountAmt, 0);
    assert.deepEqual(createdItems().map(i => [i.unitPrice, i.lineTotal]), [[100, 200], [40, 40]]);
    // الردّ يحمل الختم (يقرؤه invoiceDocFromDetail فيطبع بلا ضريبة)
    assert.equal(r.body.data.taxFree, true);
    assert.equal(r.body.data.einvoiceProvider, 'none');
    assert.equal(calls.filter(c => c === 'companySettings.findUnique').length, 1, 'استعلام إعدادات ثانٍ');
  }
});

test('«بلا ضريبة» — نسبةٌ غائبة تعني صفراً (لا احتياطية الدولة ولا نسبة الصنف المخزّنة)، والخصم يعمل على السعر نفسه', async () => {
  reset(ADMIN);
  script(TAX_OFF);
  const r = await postInvoice(invBody(netLines({ taxPct: undefined }), { discountPct: 10 }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assertTaxFreeDoc(created(), 216);
  assert.equal(created().discountAmt, 24);
});

test('«بلا ضريبة» — المرتجع الحرّ (بلا فاتورة بيع) بنسبة صفر: بلا ضريبة ومختوم', async () => {
  reset(ADMIN);
  script(TAX_OFF);
  const r = await postInvoice(invBody(netLines(), { type: 'RETURN' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assertTaxFreeDoc(created(), 240);
});

test('«بلا ضريبة» — جلسةٌ حيّة (الإدارة/الويب/m والمندوب) ببندٍ فوق الصفر ⇒ 409 TAX_MODE_CHANGED بلا معاملة ولا مستند', async () => {
  const cases: Array<[User, Row[], Row]> = [
    [ADMIN, [line(), lineB()], {}],
    [ADMIN, [line({ unitPrice: 100, taxPct: 0 }), lineB()], {}], // بندٌ واحد يكفي
    [REP_USER, [line(), lineB()], {}],
    [REP_USER, [line()], { type: 'RETURN' }], // المرتجع الحرّ كالبيع
  ];
  for (const [user, items, over] of cases) {
    reset(user);
    script(TAX_OFF);
    const r = await postInvoice(invBody(items, over));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(r.body, { success: false, code: TAX_MODE_CODES.changed, message: TAX_MODE_MESSAGES.TAX_MODE_CHANGED });
    assert.equal(r.body.code, 'TAX_MODE_CHANGED');
    assert.ok(!calls.includes('$transaction') && !calls.includes('invoice.create'), calls.join(' → '));
  }
});

test('«بلا ضريبة» — مفتاح API: فوق الصفر ⇒ 422 TAX_DISABLED (ولو بترويسة إعادة الرفع)، والغائب والصفر ⇒ بلا ضريبة', async () => {
  for (const headers of [{}, REPLAY]) {
    reset(API_KEY);
    script(TAX_OFF);
    const r = await postInvoice(invBody([line({ unitPrice: 100, taxPct: 0 }), lineB({ unitPrice: 40, taxPct: 5 })]), headers);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.deepEqual(r.body, { success: false, code: TAX_MODE_CODES.disabled, message: TAX_MODE_MESSAGES.TAX_DISABLED });
    assert.equal(r.body.code, 'TAX_DISABLED');
    assert.ok(!calls.includes('invoice.create'));
  }
  for (const taxPct of [undefined, 0]) {
    reset(API_KEY);
    script(TAX_OFF);
    const r = await postInvoice(invBody(netLines({ taxPct }), { pricesIncludeTax: false }));
    assert.equal(r.status, 201, `${taxPct}: ${JSON.stringify(r.body)}`);
    assertTaxFreeDoc(created(), 240);
  }
});

// ═══ (٣) إعادة رفع الصندوق ═══

test('«بلا ضريبة» — إعادة رفع المندوب ببندٍ فوق الصفر تُقبل كما بناها الجهاز: بضريبتها وبلا ختم، مطابقةً لمسار الشركة بضريبتها حرفاً', async () => {
  const body = invBody([line(), lineB()], { clientRef: '0c7e4c3b-8a6e-4b52-9f1e-5d2d0b6c9a21' });
  const off = await runOnce(TAX_OFF, REP_USER, body, REPLAY, { rep: { canChangePrice: false, canSellBelowPrice: false } });
  const on = await runOnce(TAX_ON_FALSE, REP_USER, body, REPLAY, { rep: { canChangePrice: false, canSellBelowPrice: false } });
  assert.equal(off.status, 201, JSON.stringify(off.body));
  assert.deepEqual(off.create, on.create, 'المستند المقبول كما بُني يخالف مسار اليوم');
  assert.deepEqual(off.calls, on.calls);
  assert.deepEqual(off.body, on.body);
  const data = (off.create[0] as { data: Row }).data;
  assertTodayDoc(data);
  assert.deepEqual([data.taxAmt, data.total], [36, 276], 'الورقة بيد العميل بضريبتها');
});

test('«بلا ضريبة» — إعادة رفعٍ كل بنودها صفر (أو غائبة) ⇒ بلا ضريبة ومختومة', async () => {
  for (const taxPct of [0, undefined]) {
    reset(REP_USER);
    script(TAX_OFF);
    const r = await postInvoice(invBody(netLines({ taxPct }), { clientRef: crypto.randomUUID() }), REPLAY);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assertTaxFreeDoc(created(), 240);
  }
});

// ═══ (٤) حارس سعر المندوب: السعر الصافي المكتوب كما هو ═══

test('«بلا ضريبة» — حارس المندوب بلا «تغيير السعر»: السعر الصافي بنسبة صفر أو غائبة يمرّ (netFromInclusive(…, 0))، والشامل القديم يُرفض', async () => {
  const strict = { rep: { canChangePrice: false, canSellBelowPrice: false, maxDiscountPct: 0 } };
  for (const taxPct of [0, undefined]) {
    const r = await runOnce(TAX_OFF, REP_USER, invBody(netLines({ taxPct })), {}, strict);
    assert.equal(r.status, 201, `${taxPct}: ${JSON.stringify(r.body)}`);
    assertTaxFreeDoc((r.create[0] as { data: Row }).data, 240);
  }
  // السعر الشامل القديم (١١٥) بنسبة صفر لا يُردّ إلى صافيه: هو زيادةٌ على السعر المكتوب ⇒ «تغيير السعر»
  const stale = await runOnce(TAX_OFF, REP_USER, invBody([line({ taxPct: 0 })]), {}, strict);
  assert.equal(stale.status, 403, JSON.stringify(stale.body));
  assert.equal(stale.body.message, 'لا تملك صلاحية تغيير سعر البيع');
  // للمقارنة: الشركة بضريبتها تقيس الغائبة بنسبة الصنف المخزّنة (١٥) فتردّ ١٠٠ إلى ٨٦٫٩٦ — سلوك اليوم كما هو
  const today = await runOnce(TAX_ON_FALSE, REP_USER, invBody(netLines({ taxPct: undefined })), {}, strict);
  assert.equal(today.status, 403, JSON.stringify(today.body));
  const todayOk = await runOnce(TAX_ON_FALSE, REP_USER, invBody([line(), lineB()]), {}, strict);
  assert.equal(todayOk.status, 201, JSON.stringify(todayOk.body));
});

// ═══ (٥) المرتجع من فاتورة بيع: المبلغ نفسه بنسبة صفر ═══

test('«بلا ضريبة» — المرتجع المرتبط ببيعٍ صدر بضريبته: المبلغ المسترد نفسه بنداً بنداً، وضريبته صفر ومختوم — ونسبة الجسم القديمة لا تردّه', async () => {
  const on = await runOnce(TAX_ON_FALSE, ADMIN, linkedReturnBody(15), {}, { linkedSale: true });
  assert.equal(on.status, 201, JSON.stringify(on.body));
  const onData = (on.create[0] as { data: Row }).data;
  assert.ok(onData.taxAmt > 0, 'المرتجع بضريبته في الشركة بضريبتها');
  for (const bodyTax of [15, 0, undefined]) {
    const off = await runOnce(TAX_OFF, ADMIN, linkedReturnBody(bodyTax), {}, { linkedSale: true });
    assert.equal(off.status, 201, `${bodyTax}: ${JSON.stringify(off.body)}`);
    const data = (off.create[0] as { data: Row }).data;
    assertTaxFreeDoc(data, onData.total);
    assert.equal(data.total, 7.83);
    assert.equal(data.pricesIncludeTax, true);
    const items = (data.items as { create: Row[] }).create;
    const onItems = (onData.items as { create: Row[] }).create;
    assert.deepEqual(items.map(i => i.lineTotal), onItems.map(i => i.lineTotal), 'مبلغ البند تغيّر');
    assert.deepEqual(items.map(i => i.lineTotal), [3.33, 4.5]);
    assert.deepEqual(items.map(i => i.returnOfItemId), ['s-1', 's-2']);
    // الصافي صار المبلغ كله (لا وعاء ولا ضريبة)
    assert.equal(data.subtotal, 7.83);
  }
});

test('«بلا ضريبة» — إعادة رفع مرتجعٍ مرتبط ببنود ١٥٪ تُقبل كما بُنيت (بضريبتها)، وبنود صفر ⇒ بلا ضريبة بالمبلغ نفسه', async () => {
  const asBuilt = await runOnce(TAX_OFF, REP_USER, { ...linkedReturnBody(15), clientRef: crypto.randomUUID() }, REPLAY, { linkedSale: true });
  assert.equal(asBuilt.status, 201, JSON.stringify(asBuilt.body));
  const a = (asBuilt.create[0] as { data: Row }).data;
  assertTodayDoc(a);
  assert.deepEqual([a.total, a.taxAmt], [7.83, 1.02]);
  const free = await runOnce(TAX_OFF, REP_USER, { ...linkedReturnBody(0), clientRef: crypto.randomUUID() }, REPLAY, { linkedSale: true });
  assert.equal(free.status, 201, JSON.stringify(free.body));
  assertTaxFreeDoc((free.create[0] as { data: Row }).data, 7.83);
});

test('priceLinkedReturn: taxFree ⇒ نسبة صفر والمبلغ نفسه، وغيابه كما كان حرفاً', () => {
  const saleLines = new Map(SALE_LINES.map(l => [l.id as string, l as never]));
  const items = [{ qty: 2 }, { qty: 3 }];
  const links = [{ saleItemId: 's-1', unitFactor: 1 }, { saleItemId: 's-2', unitFactor: 1 }];
  const today = priceLinkedReturn(items, links, saleLines, new Map(), { companyVat: 15, decimals: 2 });
  const free = priceLinkedReturn(items, links, saleLines, new Map(), { companyVat: 15, decimals: 2, taxFree: true });
  assert.deepEqual(priceLinkedReturn(items, links, saleLines, new Map(), { companyVat: 15, decimals: 2, taxFree: false }), today);
  assert.equal(free.total, today.total);
  assert.deepEqual(free.items.map(i => i.lineTotal), today.items.map(i => i.lineTotal));
  assert.equal(free.taxAmt, 0);
  assert.ok(today.taxAmt > 0);
  assert.deepEqual(free.items.map(i => [i.taxPct, i.taxAmt]), [[0, 0], [0, 0]]);
  assert.equal(free.subtotal, free.total);
  // والكويتيّ (ثلاث خانات) كذلك
  const kwToday = priceLinkedReturn(items, links, saleLines, new Map(), { companyVat: 0, decimals: 3 });
  const kwFree = priceLinkedReturn(items, links, saleLines, new Map(), { companyVat: 0, decimals: 3, taxFree: true });
  assert.equal(kwFree.total, kwToday.total);
});

// ═══ (٦) قرارات المراجعة (٧ نوفمبر ٢٠٢٦): المفتاح والمرتجع، وإعادة الرفع للمندوب وحده، ومستند الصندوق السابق للتبديل ═══

/** شركةٌ أزالت ضريبتها قبل يومين — لإعادة رفعٍ أُنشئت بعد التبديل (لحظة TAX_OFF مستقبلٌ قريب لساعة الاختبار) */
const TAX_OFF_EARLIER: Row = { ...BASE_SETTINGS, taxDisabled: true, taxModeChangedAt: new Date('2026-11-05T08:00:00.000Z') };
/** لحظة الجهاز قبل التبديل (TAX_OFF ٧ نوفمبر ٠٨:٠٠Z) وبعده (TAX_OFF_EARLIER ٥ نوفمبر ٠٨:٠٠Z) */
const BEFORE_SWITCH = '2026-11-06T10:00:00.000Z';
const MANAGER: User = { id: 'mgr-1', role: 'MANAGER', tenantId: TID };
const ACCOUNTANT: User = { id: 'acc-1', role: 'ACCOUNTANT', tenantId: TID };
const docOf = (r: Run): Row => (r.create[0] as { data: Row }).data;

test('قرار ١ — مفتاح API: المرتجع من فاتورة بيع ببندٍ فوق الصفر ⇒ 422 TAX_DISABLED (ولو بترويسة إعادة الرفع) بلا معاملة ولا مستند، والصفر/الغائب ⇒ بلا ضريبة بالمبلغ نفسه', async () => {
  const oneTaxed = invBody([
    { productId: 'p-a', invoiceItemId: 's-1', qty: 1, unitPrice: 999, discountPct: 0, taxPct: 0 },
    { productId: 'p-b', invoiceItemId: 's-2', qty: 1, unitPrice: 1, discountPct: 0, taxPct: 5 }, // بندٌ واحد يكفي
  ], { type: 'RETURN', originalInvoiceId: 'sale-1' });
  for (const headers of [{}, REPLAY]) {
    for (const body of [linkedReturnBody(15), oneTaxed]) {
      const r = await runOnce(TAX_OFF, API_KEY, body, headers, { linkedSale: true });
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.deepEqual(r.body, { success: false, code: TAX_MODE_CODES.disabled, message: TAX_MODE_MESSAGES.TAX_DISABLED });
      assert.ok(!r.calls.includes('$transaction') && !r.calls.includes('invoice.create'), r.calls.join(' → '));
    }
  }
  for (const bodyTax of [0, undefined]) {
    const r = await runOnce(TAX_OFF, API_KEY, linkedReturnBody(bodyTax), {}, { linkedSale: true });
    assert.equal(r.status, 201, `${bodyTax}: ${JSON.stringify(r.body)}`);
    assertTaxFreeDoc(docOf(r), 7.83);
    assert.deepEqual((docOf(r).items as { create: Row[] }).create.map(i => i.lineTotal), [3.33, 4.5]);
  }
  // والشركة بضريبتها: المفتاح بمرتجعه ١٥٪ كما اليوم (بضريبته، بلا ختم)
  const on = await runOnce(TAX_ON_FALSE, API_KEY, linkedReturnBody(15), {}, { linkedSale: true });
  assert.equal(on.status, 201, JSON.stringify(on.body));
  assertTodayDoc(docOf(on));
  assert.equal(docOf(on).taxAmt, 1.02);
});

test('قرار ٢ — المرتجع من فاتورة بيع بجلسةٍ حيّة (الإدارة والمندوب) ببنود ١٥٪ يبقى صفراً بالمبلغ نفسه (بلا 409)', async () => {
  for (const user of [ADMIN, REP_USER]) {
    const r = await runOnce(TAX_OFF, user, linkedReturnBody(15), {}, { linkedSale: true });
    assert.equal(r.status, 201, `${user.role}: ${JSON.stringify(r.body)}`);
    assertTaxFreeDoc(docOf(r), 7.83);
    assert.deepEqual((docOf(r).items as { create: Row[] }).create.map(i => i.lineTotal), [3.33, 4.5]);
  }
});

test('قرار ٣ — ترويسة إعادة الرفع من غير المندوب (الإدارة/المدير/المحاسب) لا تمنح «كما بُني»: بندٌ فوق الصفر ⇒ 409، والصفر ⇒ بلا ضريبة، والمرتجع المرتبط صفرٌ بمبلغه', async () => {
  for (const user of [ADMIN, MANAGER, ACCOUNTANT]) {
    // ولو بلحظة جهازٍ قبل التبديل: التسامح لصندوق المندوب وحده
    for (const over of [{ clientRef: crypto.randomUUID() }, { clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH }]) {
      const r = await runOnce(TAX_OFF, user, invBody([line(), lineB()], over), REPLAY);
      assert.equal(r.status, 409, `${user.role}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { success: false, code: TAX_MODE_CODES.changed, message: TAX_MODE_MESSAGES.TAX_MODE_CHANGED });
      assert.ok(!r.calls.includes('$transaction') && !r.calls.includes('invoice.create'), r.calls.join(' → '));
    }
  }
  const zero = await runOnce(TAX_OFF, ADMIN, invBody(netLines(), { clientRef: crypto.randomUUID() }), REPLAY);
  assert.equal(zero.status, 201, JSON.stringify(zero.body));
  assertTaxFreeDoc(docOf(zero), 240);
  const ret = await runOnce(TAX_OFF, ADMIN, { ...linkedReturnBody(15), clientRef: crypto.randomUUID() }, REPLAY, { linkedSale: true });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assertTaxFreeDoc(docOf(ret), 7.83);
  // والمندوب بالترويسة نفسها يبقى «كما بُني» (المسار المقصود)
  const rep = await runOnce(TAX_OFF, REP_USER, invBody([line(), lineB()], { clientRef: crypto.randomUUID() }), REPLAY);
  assert.equal(rep.status, 201, JSON.stringify(rep.body));
  assertTodayDoc(docOf(rep));
});

test('قرار ٤ — إعادة رفع المندوب لمستندٍ أُنشئ قبل التبديل (clientCreatedAt < taxModeChangedAt): مسار اليوم حرفاً — بلا تصفير ولا ختم ولو بنوده صفر', async () => {
  const bodies: Array<[string, Row, { linkedSale?: boolean }]> = [
    ['بنود صفر', invBody(netLines(), { clientRef: '3d6c1f0a-6a51-4f0e-8a51-0b1c2d3e4f50', clientCreatedAt: BEFORE_SWITCH }), {}],
    ['نسبة غائبة (الاحتياطية كما بُني)', invBody(netLines({ taxPct: undefined }), { clientRef: '3d6c1f0a-6a51-4f0e-8a51-0b1c2d3e4f51', clientCreatedAt: BEFORE_SWITCH }), {}],
    ['بنود ١٥٪', invBody([line(), lineB()], { clientRef: '3d6c1f0a-6a51-4f0e-8a51-0b1c2d3e4f52', clientCreatedAt: BEFORE_SWITCH }), {}],
    ['مرتجع مرتبط بنود صفر', { ...linkedReturnBody(0), clientRef: '3d6c1f0a-6a51-4f0e-8a51-0b1c2d3e4f53', clientCreatedAt: BEFORE_SWITCH }, { linkedSale: true }],
  ];
  for (const [name, body, o] of bodies) {
    const off = await runOnce(TAX_OFF, REP_USER, body, REPLAY, o);
    const on = await runOnce(TAX_ON_FALSE, REP_USER, body, REPLAY, o);
    assert.equal(on.status, 201, `${name}: ${JSON.stringify(on.body)}`);
    assert.equal(off.status, 201, `${name}: ${JSON.stringify(off.body)}`);
    assert.deepEqual(off.calls, on.calls, `${name}: تسلسل الاستعلامات تغيّر`);
    assert.deepEqual(off.create, on.create, `${name}: المستند يخالف مسار اليوم`);
    assert.deepEqual(off.body, on.body, `${name}: الردّ تغيّر`);
    assertTodayDoc(docOf(off));
  }
  // الأرقام: الصفر صفرٌ كما بُني، والغائبة ١٥٪ الاحتياطية كما اليوم، والمرتجع بنسبة بند البيع
  const zero = await runOnce(TAX_OFF, REP_USER, bodies[0][1], REPLAY);
  assert.deepEqual([docOf(zero).taxAmt, docOf(zero).total], [0, 240]);
  const missing = await runOnce(TAX_OFF, REP_USER, bodies[1][1], REPLAY);
  assert.deepEqual([docOf(missing).taxAmt, docOf(missing).total], [31.3, 240]); // ٢٤٠ شاملةً ١٥٪ الاحتياطية
  const ret = await runOnce(TAX_OFF, REP_USER, bodies[3][1], REPLAY, { linkedSale: true });
  assert.deepEqual([docOf(ret).taxAmt, docOf(ret).total], [1.02, 7.83]);
});

test('قرار ٤ — حدود التسامح: بعد التبديل أو بلا لحظة أو بلحظةٍ تالفة أو حيّاً أو بلا taxModeChangedAt ⇒ قواعد «بلا ضريبة»', async () => {
  // بعد التبديل: الصفر مختوم، وفوق الصفر «كما بُني» (قرار ٣)
  const afterSwitch = await runOnce(TAX_OFF_EARLIER, REP_USER, invBody(netLines(), { clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH }), REPLAY);
  assert.equal(afterSwitch.status, 201, JSON.stringify(afterSwitch.body));
  assertTaxFreeDoc(docOf(afterSwitch), 240);
  const afterTaxed = await runOnce(TAX_OFF_EARLIER, REP_USER, invBody([line(), lineB()], { clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH }), REPLAY);
  assert.equal(afterTaxed.status, 201, JSON.stringify(afterTaxed.body));
  assertTodayDoc(docOf(afterTaxed));
  // بلا لحظة جهاز، أو لحظةٌ لا تُقرأ: لا تسامح
  for (const over of [{}, { clientCreatedAt: 'not-a-date' }]) {
    const r = await runOnce(TAX_OFF, REP_USER, invBody(netLines(), { clientRef: crypto.randomUUID(), ...over }), REPLAY);
    assert.equal(r.status, 201, `${JSON.stringify(over)}: ${JSON.stringify(r.body)}`);
    assertTaxFreeDoc(docOf(r), 240);
  }
  // بلا taxModeChangedAt (لا مرجع للمقارنة): لا تسامح
  const noRef = await runOnce({ ...TAX_OFF, taxModeChangedAt: null }, REP_USER, invBody(netLines(), { clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH }), REPLAY);
  assert.equal(noRef.status, 201, JSON.stringify(noRef.body));
  assertTaxFreeDoc(docOf(noRef), 240);
  // المندوب حيّاً (بلا ترويسة) بلحظةٍ قديمة: قواعد الإصدار الحيّ — 409 فوق الصفر، وصفرٌ مختوم
  const liveTaxed = await runOnce(TAX_OFF, REP_USER, invBody([line(), lineB()], { clientCreatedAt: BEFORE_SWITCH }));
  assert.equal(liveTaxed.status, 409, JSON.stringify(liveTaxed.body));
  assert.equal(liveTaxed.body.code, 'TAX_MODE_CHANGED');
  const liveZero = await runOnce(TAX_OFF, REP_USER, invBody(netLines(), { clientCreatedAt: BEFORE_SWITCH }));
  assert.equal(liveZero.status, 201, JSON.stringify(liveZero.body));
  assertTaxFreeDoc(docOf(liveZero), 240);
  // ومفتاح API بلحظةٍ قديمة وترويسة: لا لحظة له (deviceAt) ولا صندوق ⇒ 422
  const key = await runOnce(TAX_OFF, API_KEY, invBody([line(), lineB()], { clientCreatedAt: BEFORE_SWITCH }), REPLAY);
  assert.equal(key.status, 422, JSON.stringify(key.body));
});

// ═══ (٧) CONTRACT2 E1: الوضع الذي سعّر به الجهاز (builtTaxFree) — جدول القرار صفاً صفاً، وانحراف الساعة، والشركة بضريبتها حرفاً ═══

const STRICT = { rep: { canChangePrice: false, canSellBelowPrice: false } };
/** شركةٌ أعادت ضريبتها بعد إزالتها: taxDisabled false ومعه لحظة التبديل — كاش أجهزتها قد يبقى «بلا ضريبة» */
const TAX_ON_RESTORED: Row = { ...BASE_SETTINGS, taxDisabled: false, taxModeChangedAt: new Date('2026-11-06T08:00:00.000Z') };
const TAX_ON_ALL: Array<[string, Row]> = [['غائب', TAX_ON_ABSENT], ['false', TAX_ON_FALSE], ['أُعيدت', TAX_ON_RESTORED]];
const withFlag = (body: Row, builtTaxFree: boolean): Row => ({ ...body, builtTaxFree });
const assert409 = (r: Run, label: string): void => {
  assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body, { success: false, code: TAX_MODE_CODES.changed, message: TAX_MODE_MESSAGES.TAX_MODE_CHANGED });
  assert.ok(!r.calls.includes('$transaction') && !r.calls.includes('invoice.create'), `${label}: ${r.calls.join(' → ')}`);
};
/** مطابقة مسار اليوم حرفاً: النداءات والمستند والردّ واستعلام الإعدادات */
const assertSameRun = (a: Run, b: Run, label: string): void => {
  assert.equal(a.status, b.status, `${label}: ${JSON.stringify(a.body)}`);
  assert.deepEqual(a.calls, b.calls, `${label}: تسلسل الاستعلامات تغيّر`);
  assert.deepEqual(a.create, b.create, `${label}: بيانات المستند تغيّرت`);
  assert.deepEqual(a.body, b.body, `${label}: الردّ تغيّر`);
  assert.deepEqual(a.settingsSelect, b.settingsSelect, `${label}: استعلام الإعدادات تغيّر`);
};

test('E1 — بلا ضريبة × true: الحيّ بقواعده (صفرٌ مختوم، فوق الصفر 409، والمرتجع المرتبط صفرٌ بمبلغه)، وإعادة الرفع كما بُنيت بلا مقارنة لحظة', async () => {
  for (const user of [ADMIN, REP_USER]) {
    const zero = await runOnce(TAX_OFF, user, withFlag(invBody(netLines()), true));
    assert.equal(zero.status, 201, `${user.role}: ${JSON.stringify(zero.body)}`);
    assertTaxFreeDoc(docOf(zero), 240);
    assert409(await runOnce(TAX_OFF, user, withFlag(invBody([line(), lineB()]), true)), `${user.role} فوق الصفر`);
    const ret = await runOnce(TAX_OFF, user, withFlag(linkedReturnBody(15), true), {}, { linkedSale: true });
    assert.equal(ret.status, 201, `${user.role} مرتجع: ${JSON.stringify(ret.body)}`);
    assertTaxFreeDoc(docOf(ret), 7.83);
  }
  // إعادة الرفع: لحظةٌ قبل التبديل (كانت تُسقط الختم) لا تُقرأ — صفرٌ أو غائبة ⇒ مختومة
  for (const taxPct of [0, undefined]) {
    const r = await runOnce(TAX_OFF, REP_USER, withFlag(invBody(netLines({ taxPct }), { clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH }), true), REPLAY);
    assert.equal(r.status, 201, `${taxPct}: ${JSON.stringify(r.body)}`);
    assertTaxFreeDoc(docOf(r), 240);
  }
  const ret = await runOnce(TAX_OFF, REP_USER, withFlag({ ...linkedReturnBody(0), clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH }, true), REPLAY, { linkedSale: true });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assertTaxFreeDoc(docOf(ret), 7.83);
  // وبندٌ فوق الصفر ⇒ كما بُني: مسار الشركة بضريبتها حرفاً (والعَلَم لا يُكتب في المستند)
  const taxed = invBody([line(), lineB()], { clientRef: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' });
  const off = await runOnce(TAX_OFF, REP_USER, withFlag(taxed, true), REPLAY, STRICT);
  const on = await runOnce(TAX_ON_FALSE, REP_USER, taxed, REPLAY, STRICT);
  assertSameRun(off, on, 'كما بُني');
  assertTodayDoc(docOf(off));
  assert.deepEqual([docOf(off).taxAmt, docOf(off).total], [36, 276]);
});

test('E1 — بلا ضريبة × false: الحيّ بقواعده (فوق الصفر 409، صفرٌ مختوم)، وإعادة رفع المندوب مسار اليوم كما بُنيت ولو بنودها صفر', async () => {
  for (const user of [ADMIN, REP_USER]) {
    assert409(await runOnce(TAX_OFF, user, withFlag(invBody([line(), lineB()]), false)), `${user.role} فوق الصفر`);
    const zero = await runOnce(TAX_OFF, user, withFlag(invBody(netLines()), false));
    assert.equal(zero.status, 201, `${user.role}: ${JSON.stringify(zero.body)}`);
    assertTaxFreeDoc(docOf(zero), 240);
  }
  // ترويسة الإعادة من غير المندوب لا تمنح «كما بُني» (قرار ٣ كما هو)
  assert409(await runOnce(TAX_OFF, ADMIN, withFlag(invBody([line(), lineB()], { clientRef: crypto.randomUUID() }), false), REPLAY), 'الإدارة بالترويسة');
  const adminZero = await runOnce(TAX_OFF, ADMIN, withFlag(invBody(netLines(), { clientRef: crypto.randomUUID() }), false), REPLAY);
  assertTaxFreeDoc(docOf(adminZero), 240);
  // المندوب: بلا لحظة أو بلحظةٍ بعد التبديل — لا مقارنة؛ الجهاز سعّر بالضريبة ⇒ مسار اليوم حرفاً كما بُني
  const cases: Array<[string, Row, { linkedSale?: boolean }, [number, number]]> = [
    ['بنود صفر', invBody(netLines(), { clientRef: 'b1000000-0000-4000-8000-000000000001' }), {}, [0, 240]],
    ['نسبة غائبة (الاحتياطية)', invBody(netLines({ taxPct: undefined }), { clientRef: 'b1000000-0000-4000-8000-000000000002' }), {}, [31.3, 240]],
    ['بنود ١٥٪', invBody([line(), lineB()], { clientRef: 'b1000000-0000-4000-8000-000000000003' }), {}, [36, 276]],
    ['مرتجع مرتبط بنود صفر', { ...linkedReturnBody(0), clientRef: 'b1000000-0000-4000-8000-000000000004' }, { linkedSale: true }, [1.02, 7.83]],
    ['بنود صفر بلحظةٍ بعد التبديل', invBody(netLines(), { clientRef: 'b1000000-0000-4000-8000-000000000005', clientCreatedAt: BEFORE_SWITCH }), {}, [0, 240]],
  ];
  for (const [name, body, o, nums] of cases) {
    const off = await runOnce(TAX_OFF_EARLIER, REP_USER, withFlag(body, false), REPLAY, o);
    const on = await runOnce(TAX_ON_FALSE, REP_USER, body, REPLAY, o);
    assertSameRun(off, on, name);
    assertTodayDoc(docOf(off));
    assert.deepEqual([docOf(off).taxAmt, docOf(off).total], nums, name);
  }
});

test('E1 — بلا ضريبة × غائب (عميلٌ قديم): مقارنة اللحظة القائمة، مصحَّحةً بانحراف ساعة الجهاز (X-FS-Device-Now) فوق خمس دقائق', async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const H = 3_600_000;
  const MIN = 60_000;
  const settings: Row = { ...BASE_SETTINGS, taxDisabled: true, taxModeChangedAt: new Date(now - H) };
  const replayAt = async (clientCreatedAt: string, deviceNow?: string): Promise<Run> => runOnce(settings, REP_USER,
    invBody(netLines(), { clientRef: crypto.randomUUID(), clientCreatedAt }),
    { ...REPLAY, ...(deviceNow !== undefined && { 'X-FS-Device-Now': deviceNow }) });
  // جوالٌ متأخّر ٣ ساعات أصدر بعد التبديل بنصف ساعة: لحظته الخام قبل التبديل، والمصحَّحة بعده ⇒ مختوم (رقماً أو ISO)
  const slowAt = iso(now - 3 * H - 30 * MIN);
  for (const deviceNow of [String(now - 3 * H), iso(now - 3 * H)]) {
    const r = await replayAt(slowAt, deviceNow);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assertTaxFreeDoc(docOf(r), 240);
  }
  // وبلا الترويسة: السلوك القائم (الخام قبل التبديل ⇒ مسار اليوم)
  const slowRaw = await replayAt(slowAt);
  assert.equal(slowRaw.status, 201, JSON.stringify(slowRaw.body));
  assertTodayDoc(docOf(slowRaw));
  // جوالٌ متقدّم ٣ ساعات أصدر قبل التبديل بساعة: الخام بعده، والمصحَّح قبله ⇒ مسار اليوم (بنوده صفر بلا ختم)
  const fastAt = iso(now + H);
  const fast = await replayAt(fastAt, String(now + 3 * H));
  assert.equal(fast.status, 201, JSON.stringify(fast.body));
  assertTodayDoc(docOf(fast));
  assert.equal(docOf(fast).taxAmt, 0);
  const fastRaw = await replayAt(fastAt);
  assertTaxFreeDoc(docOf(fastRaw), 240);
  // انحرافٌ دون خمس دقائق لا يُصحَّح: خامٌ قبل التبديل بدقيقتين وساعةٌ متأخّرة ٤ دقائق ⇒ مسار اليوم
  const small = await replayAt(iso(now - H - 2 * MIN), String(now - 4 * MIN));
  assert.equal(small.status, 201, JSON.stringify(small.body));
  assertTodayDoc(docOf(small));
  // ترويسةٌ تالفة ⇒ لا تصحيح
  const bad = await replayAt(slowAt, 'not-a-time');
  assertTodayDoc(docOf(bad));
});

test('E1 — بضريبتها × true: الحيّ 409 TAX_MODE_CHANGED (كاشٌ قديم بعد إعادة الضريبة) بلا معاملة ولا مستند — للإدارة والمندوب والمرتجع وترويسة غير المندوب', async () => {
  for (const [name, settings] of TAX_ON_ALL) {
    const cases: Array<[string, User, Row, Record<string, string>, { linkedSale?: boolean }]> = [
      ['الإدارة صفراً', ADMIN, invBody(netLines()), {}, {}],
      ['المندوب صفراً', REP_USER, invBody(netLines()), {}, {}],
      ['المدير', MANAGER, invBody(netLines()), {}, {}],
      ['المرتجع الحرّ', REP_USER, invBody(netLines(), { type: 'RETURN' }), {}, {}],
      ['المرتجع المرتبط', ADMIN, linkedReturnBody(0), {}, { linkedSale: true }],
      ['بنود ١٥٪', ADMIN, invBody([line(), lineB()]), {}, {}],
      ['الإدارة بترويسة الإعادة', ADMIN, invBody(netLines(), { clientRef: crypto.randomUUID() }), REPLAY, {}],
      ['المحاسب بترويسة الإعادة', ACCOUNTANT, invBody(netLines(), { clientRef: crypto.randomUUID() }), REPLAY, {}],
    ];
    for (const [label, user, body, headers, o] of cases) {
      assert409(await runOnce(settings, user, withFlag(body, true), headers, o), `${name} / ${label}`);
    }
  }
});

test('E1 — بضريبتها × true لشركةٍ لم تُزل ضريبتها قط (بلا taxModeChangedAt): إعادة رفع المندوب صفراً ⇒ مسار اليوم كما بُني بلا ختم (التحقّق النهائي ٧ نوفمبر)', async () => {
  for (const [name, settings] of TAX_ON_ALL) {
    if (settings.taxModeChangedAt) continue;
    const body = invBody(netLines({ taxPct: 0 }), { clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH });
    const flagged = await runOnce(settings, REP_USER, withFlag(body, true), REPLAY, STRICT);
    const plain = await runOnce(settings, REP_USER, body, REPLAY, STRICT);
    assertSameRun(flagged, plain, `${name}: الختم بلا إزالةٍ سابقة`);
    assert.notEqual(docOf(flagged).taxFree, true, name);
  }
});

test('E1 — بضريبتها × true: إعادة رفع المندوب كل بنودها صفر ⇒ مختومة بلا ضريبة (بنود صفر، none/null)، وبندٌ فوق الصفر ⇒ كما بُني', async () => {
  for (const [name, settings] of TAX_ON_ALL.filter(([, s]) => s.taxModeChangedAt != null)) {
    for (const taxPct of [0, undefined]) {
      const r = await runOnce(settings, REP_USER, withFlag(invBody(netLines({ taxPct }), { clientRef: crypto.randomUUID(), clientCreatedAt: BEFORE_SWITCH }), true), REPLAY, STRICT);
      assert.equal(r.status, 201, `${name}/${taxPct}: ${JSON.stringify(r.body)}`);
      assertTaxFreeDoc(docOf(r), 240);
      assert.equal(docOf(r).subtotal, 240);
      assert.equal(r.body.data.taxFree, true);
      assert.equal(r.body.data.einvoiceProvider, 'none');
      // استعلامٌ واحدٌ للإعدادات كما كان
      assert.equal(r.settingsSelect.filter((sel) => (sel as Row | undefined)?.defaultVatPct).length, 1);
    }
    // المرتجع المرتبط: المبلغ المسترد نفسه بنسبة صفر
    const ret = await runOnce(settings, REP_USER, withFlag({ ...linkedReturnBody(0), clientRef: crypto.randomUUID() }, true), REPLAY, { linkedSale: true });
    assert.equal(ret.status, 201, `${name}: ${JSON.stringify(ret.body)}`);
    assertTaxFreeDoc(docOf(ret), 7.83);
    assert.deepEqual((docOf(ret).items as { create: Row[] }).create.map(i => i.lineTotal), [3.33, 4.5]);
    // بندٌ فوق الصفر (لا يبنيه جهازٌ بلا ضريبة) ⇒ كما بُني: مسار اليوم حرفاً
    const taxed = invBody([line(), lineB()], { clientRef: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5e' });
    const asBuilt = await runOnce(settings, REP_USER, withFlag(taxed, true), REPLAY, STRICT);
    const today = await runOnce(settings, REP_USER, taxed, REPLAY, STRICT);
    assertSameRun(asBuilt, today, `${name} كما بُني`);
    assertTodayDoc(docOf(asBuilt));
  }
});

test('E1 — بضريبتها × false أو غائب: النداءات والمستند والردّ حرفاً بحرف (والعَلَم لا يُكتب)، ومفتاح API يتجاهل العَلَم في الحالين', async () => {
  const scenarios: Array<{ name: string; user: User; body: Row; headers?: Record<string, string>; o?: { rep?: Row; linkedSale?: boolean } }> = [
    { name: 'الإدارة حيّاً', user: ADMIN, body: invBody([line(), lineB()]) },
    { name: 'الإدارة بنسبةٍ غائبة', user: ADMIN, body: invBody([line({ taxPct: undefined }), lineB()]) },
    { name: 'الإدارة بنود صفر', user: ADMIN, body: invBody(netLines()) },
    { name: 'المندوب حيّاً', user: REP_USER, body: invBody([line(), lineB()]), o: STRICT },
    { name: 'إعادة رفع المندوب', user: REP_USER, body: invBody([line(), lineB()], { clientRef: 'c1000000-0000-4000-8000-000000000001' }), headers: REPLAY },
    { name: 'إعادة رفع المندوب صفراً بلحظة', user: REP_USER, body: invBody(netLines(), { clientRef: 'c1000000-0000-4000-8000-000000000002', clientCreatedAt: BEFORE_SWITCH }), headers: REPLAY },
    { name: 'المرتجع من فاتورة بيع', user: ADMIN, body: linkedReturnBody(15), o: { linkedSale: true } },
    { name: 'إعادة رفع مرتجعٍ مرتبط', user: REP_USER, body: { ...linkedReturnBody(15), clientRef: 'c1000000-0000-4000-8000-000000000003' }, headers: REPLAY, o: { linkedSale: true } },
  ];
  for (const [name, settings] of TAX_ON_ALL) {
    for (const s of scenarios) {
      const absent = await runOnce(settings, s.user, s.body, s.headers, s.o);
      const flagFalse = await runOnce(settings, s.user, withFlag(s.body, false), s.headers, s.o);
      assert.equal(absent.status, 201, `${name}/${s.name}: ${JSON.stringify(absent.body)}`);
      assertSameRun(flagFalse, absent, `${name}/${s.name}`);
      assertTodayDoc(docOf(flagFalse));
      assert.equal('builtTaxFree' in docOf(flagFalse), false);
    }
  }
  // مفتاح API: العَلَم مُهمَل — بضريبتها كما اليوم، و«بلا ضريبة» بقواعده (422 فوق الصفر، صفرٌ مختوم)
  for (const flag of [true, false]) {
    for (const [name, settings] of TAX_ON_ALL) {
      const body = invBody([line(), lineB()]);
      assertSameRun(await runOnce(settings, API_KEY, withFlag(body, flag), REPLAY), await runOnce(settings, API_KEY, body, REPLAY), `${name} مفتاح ${flag}`);
    }
    const taxed = await runOnce(TAX_OFF, API_KEY, withFlag(invBody([line(), lineB()], { clientCreatedAt: BEFORE_SWITCH }), flag), REPLAY);
    assert.equal(taxed.status, 422, JSON.stringify(taxed.body));
    assert.equal(taxed.body.code, 'TAX_DISABLED');
    const zero = await runOnce(TAX_OFF, API_KEY, withFlag(invBody(netLines()), flag));
    assertSameRun(zero, await runOnce(TAX_OFF, API_KEY, invBody(netLines())), `بلا ضريبة مفتاح ${flag}`);
    assertTaxFreeDoc(docOf(zero), 240);
  }
});

test('E1 — المخطط: builtTaxFree منطقيٌّ اختياري — قيمةٌ بغير نوعها ⇒ 400 بلا مستند', async () => {
  const r = await runOnce(TAX_ON_FALSE, ADMIN, { ...invBody([line(), lineB()]), builtTaxFree: 'yes' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(!r.calls.includes('invoice.create'));
});
