// «أنواع الأسعار» (طلب المالك، ١ نوفمبر ٢٠٢٦) — المعالجات الحقيقية (الفواتير والأصناف والعملاء و/api/price-lists) فوق Prisma مزيّف
// (بلا قاعدة بيانات). يثبت:
//   • حارس الفاتورة: نوع العميل يُسعَّر به المندوب بلا «تغيير السعر»، والسعر الأساسي فوق نوعه يُرفض، وسعر العميل الخاص يغلب النوع،
//     والتبديل بلا «تبديل نوع السعر» ⇒ 403 PRICE_LIST_FORBIDDEN وبها يمرّ، ونوع شركةٍ أخرى ⇒ 400، والختم على المستند، وبلا نوعٍ
//     لا استعلام زائد. وإعادة رفع الصندوق بنوعٍ حُذف أو صلاحيةٍ نُزعت تُسعَّر بنوع العميل الحالي لا تُعدَم، وهامش الحارس في عملةٍ
//     بلا كسور نصف وحدتها.
//   • أسعار الصنف في الأنواع: من الرئيسية إلى الأساس بستّ منازل تحت قفل الصنف، والأساس والرئيسية كما رآهما النموذج.
//   • العملاء: نوع السعر يُسقط من جسم المندوب في الإنشاء والتعديل، ويُفحص للإدارة، ونوعٌ حُذف قبل الكتابة 400 لا 500.
//   • /api/price-lists: عزل الشركة، و٤٠٩ للنوع المستخدم تحت قفل صفّه وتفريغ الختم بطابع تعديل، وأسعار المندوب بأنواع عملائه
//     (بنطاق العزل) وحدها بلا الصلاحية، وأسعار الأنواع بحارس صلاحية الأصناف.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { docPriceListOf, listBasePriceOf, priceListName, refOverrideOf, PRICE_LIST_NAME_MAX } from '../services/priceLists';
import { customerPayloadRow, invoicePayloadRow } from '../services/erpPayload';

// ═══ حقن البدائل قبل تحميل الموجّهات (نمط multi-unit-routes.test.ts) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Raw = { kind: '$queryRaw' | '$executeRaw'; sql: string; values: unknown[]; inTx: boolean };
let calls: string[] = [];
let raws: Raw[] = [];
let inTx = false;
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (r: Raw) => unknown = () => undefined;

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0 } };
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
function modelProxy(model: string): unknown {
  return new Proxy({}, {
    get: (_t, method: string) => async (args: unknown) => {
      calls.push(`${model}.${method}`);
      const fn = scripted[`${model}.${method}`];
      return fn ? fn(args) : defaultFor(method);
    },
  });
}
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push('$transaction');
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(key);
        const r: Raw = { kind: key, sql: strings.join('?'), values, inTx };
        raws.push(r);
        const out = rawScript(r);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; impersonated?: boolean; apiKeyId?: string };
let currentUser: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
/** صلاحيات إدارةٍ مطفأة للمستخدم الحالي — بديل requireAdminPermission يحاكي الحقيقي: المندوب يمرّ، وغيره يُردّ 403 بالمطفأة */
let deniedPerms = new Set<string>();
type Res = { status: (n: number) => { json: (b: unknown) => void } };

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass,
  requireAdminPermission: (perm: string) => (req: { user?: { role?: string } }, res: Res, next: () => void) => {
    if (req.user?.role !== 'SALES_REP' && deniedPerms.has(perm)) { res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا القسم' }); return; }
    next();
  },
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: (req: { user?: { impersonated?: boolean } }) => req.user?.impersonated === true,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا مرحلة ثانية في هذه الاختبارات'); } });

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesRouter = (require('../routes/invoices') as typeof import('../routes/invoices')).default;
const productsRouter = (require('../routes/products') as typeof import('../routes/products')).default;
const customersRouter = (require('../routes/customers') as typeof import('../routes/customers')).default;
const priceListsRouter = (require('../routes/priceLists') as typeof import('../routes/priceLists')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ العُدّة ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/price-lists', priceListsRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'GET' | 'PUT' | 'DELETE', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const s = await startServer();
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...(o.headers ?? {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
function reset(user: User = ADMIN): void {
  calls = []; raws = []; inTx = false; scripted = {}; rawScript = () => undefined; deniedPerms = new Set();
  currentUser = user;
}
const touched = (prefix: string) => calls.filter(c => c.startsWith(prefix));

// ═══ (١) القواعد الصرفة ═══

test('القواعد: الرئيسية ÷ معاملها لوحدة الأساس بستّ منازل، ونوع المستند المرسل أو نوع العميل، وسعر العميل يغلب النوع', () => {
  assert.equal(listBasePriceOf(10, 24), 0.416667);
  assert.equal(Math.round(listBasePriceOf(10, 24)! * 24 * 100) / 100, 10, '×٢٤ يعيد سعر الكرتون بالهللة');
  assert.equal(listBasePriceOf(7.5, 1), 7.5, 'بلا رئيسية: السعر للأساس نفسه');
  assert.equal(listBasePriceOf(5, 0), 5, 'المعامل التالف يُقرأ ١');
  assert.equal(listBasePriceOf(Number.NaN, 24), null);
  // المفتاح الغائب ⇒ نوع العميل (العملاء والصناديق القديمة)، وnull ⇒ السعر الأساسي صراحةً
  assert.equal(docPriceListOf(undefined, 'L-W'), 'L-W');
  assert.equal(docPriceListOf(undefined, null), null);
  assert.equal(docPriceListOf(null, 'L-W'), null);
  assert.equal(docPriceListOf('L-R', 'L-W'), 'L-R');
  assert.equal(refOverrideOf(0.375, 0.3), 0.375, 'سعر العميل الخاص يغلب النوع');
  assert.equal(refOverrideOf(undefined, 0.3), 0.3);
  assert.equal(refOverrideOf(null, null), null);
  assert.equal(refOverrideOf(0, 0.3), 0, 'سعر عميلٍ صفريّ سعرٌ لا غياب');
  assert.equal(priceListName('  سعر الجملة  '), 'سعر الجملة');
  assert.equal(priceListName('   '), null);
  assert.equal(priceListName('x'.repeat(PRICE_LIST_NAME_MAX + 1)), null);
});

// ═══ (٢) حارس الفاتورة ═══

const CUSTOMER = { id: 'c1', tenantId: TENANT, name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0, priceListId: 'L-W' as string | null };
const REP_ROW = {
  id: 'rep-1', tenantId: TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: false, canSellBelowPrice: false, canChangePriceList: false, canSellWithoutStock: true, maxDiscountPct: 0, locationId: null,
  tenant: { locationsEnabled: false, settings: { teamsEnabled: false } }, teamMemberships: [],
};
/** ماء: الحبة أساسٌ بعشرة الكرتون ÷ ٢٤، والكرتون (٢٤) بسعره المحدَّد عشرة */
const PRODUCT = {
  id: 'p1', name: 'ماء', unit: 'حبة', basePrice: 10 / 24, taxPct: 15, damagedReturnToStock: true, priceTiers: [] as { price: number; baseMinQty: number }[],
  units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true }],
  shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, teams: [],
  baseConvertedAt: null, primaryUnitId: 'u-ct',
};
/** أسعار الأنواع لوحدة الأساس: الجملة كرتونها ٨، والتجزئة ١٢ — ونوع شركةٍ أخرى L-X */
const LIST_PRICES: Record<string, number> = { 'L-W': 8 / 24, 'L-R': 12 / 24 };
const MY_LISTS = new Set(['L-W', 'L-R']);

function issueWorld(o: { customer?: Partial<typeof CUSTOMER>; rep?: Partial<typeof REP_ROW>; cps?: { productId: string; price: number }[] } = {}) {
  const created: any[] = [];
  const itemQueries: any[] = [];
  const customer = { ...CUSTOMER, ...o.customer };
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => ({ ...REP_ROW, ...o.rep }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => customer,
    'product.findMany': () => [PRODUCT],
    'customerPrice.findMany': () => o.cps ?? [],
    'priceList.count': (args) => (MY_LISTS.has(args?.where?.id) && args?.where?.tenantId === TENANT ? 1 : 0),
    'priceListItem.findMany': (args) => {
      itemQueries.push(args);
      const id = args?.where?.priceListId;
      return args?.where?.tenantId === TENANT && LIST_PRICES[id] != null ? [{ productId: 'p1', price: LIST_PRICES[id] }] : [];
    },
    'companySettings.findUnique': () => ({ defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null }),
    'invoice.create': (args) => { created.push(args.data); return { id: `inv-${created.length}`, ...args.data, items: args.data.items.create, customer }; },
  };
  return { created, itemQueries };
}
/** بيع كرتونٍ واحد بسعرٍ صافٍ */
const sellCarton = (unitPrice: number, extra: Record<string, unknown> = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0,
  items: [{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice, discountPct: 0 }], ...extra,
});

test('حارس المندوب: نوع العميل (الجملة) يُقبل بلا «تغيير السعر» ويُختم، والسعر الأساسي فوقه يُرفض، وأسعار النوع لأصناف المستند وحدها', async () => {
  reset(REP_USER);
  const w = issueWorld();
  const ok = await call('POST', '/api/invoices', { body: sellCarton(8) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(w.created[0].priceListId, 'L-W', 'الختم بنوع العميل');
  assert.deepEqual(w.itemQueries, [{ where: { tenantId: TENANT, priceListId: 'L-W', productId: { in: ['p1'] } }, select: { productId: true, price: true } }]);
  assert.equal(calls.includes('priceList.count'), false, 'نوع العميل محروسٌ عند كتابته — لا فحص ثانٍ');
  // سعر الكرتون العامّ (١٠) فوق سقف الجملة (٨)
  reset(REP_USER);
  const w2 = issueWorld();
  const over = await call('POST', '/api/invoices', { body: sellCarton(10) });
  assert.equal(over.status, 403, JSON.stringify(over.body));
  assert.equal(over.body.message, 'لا تملك صلاحية تغيير سعر البيع');
  assert.equal(w2.created.length, 0);
  // شاملاً للضريبة كما يرسله التطبيق: ٨ × ١٫١٥ = ٩٫٢
  reset(REP_USER);
  issueWorld();
  assert.equal((await call('POST', '/api/invoices', { body: sellCarton(9.2, { pricesIncludeTax: true }) })).status, 201);
});

test('سعر العميل الخاص يغلب نوعه: الكرتون له بتسعة لا بثمانية الجملة', async () => {
  reset(REP_USER);
  issueWorld({ cps: [{ productId: 'p1', price: 9 / 24 }] });
  assert.equal((await call('POST', '/api/invoices', { body: sellCarton(9) })).status, 201);
  reset(REP_USER);
  issueWorld({ cps: [{ productId: 'p1', price: 9 / 24 }] });
  const under = await call('POST', '/api/invoices', { body: sellCarton(8) });
  assert.equal(under.status, 403, 'سعر النوع تحت سعر العميل');
  assert.equal(under.body.message, 'لا تملك صلاحية تغيير سعر البيع');
});

test('تبديل النوع: بلا «تبديل نوع السعر» ⇒ 403 PRICE_LIST_FORBIDDEN بلا مستند (ولو إلى السعر الأساسي)، وبها يمرّ بسعر النوع المختار ويُختم به', async () => {
  for (const priceListId of ['L-R', null]) {
    reset(REP_USER);
    const w = issueWorld();
    const r = await call('POST', '/api/invoices', { body: sellCarton(priceListId ? 12 : 10, { priceListId }) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRICE_LIST_FORBIDDEN');
    assert.equal(r.body.message, 'لا تملك صلاحية تبديل نوع السعر');
    assert.equal(w.created.length, 0);
  }
  // إرسال نوع العميل نفسه صراحةً ليس تبديلاً
  reset(REP_USER);
  issueWorld();
  assert.equal((await call('POST', '/api/invoices', { body: sellCarton(8, { priceListId: 'L-W' }) })).status, 201);
  // بالصلاحية: التجزئة بسعرها، والختم بها
  reset(REP_USER);
  const w = issueWorld({ rep: { canChangePriceList: true } });
  const r = await call('POST', '/api/invoices', { body: sellCarton(12, { priceListId: 'L-R' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].priceListId, 'L-R');
  // وإلى السعر الأساسي: سعر الكرتون المحدَّد، ولا ختم ولا أسعار نوع
  reset(REP_USER);
  const w0 = issueWorld({ rep: { canChangePriceList: true } });
  assert.equal((await call('POST', '/api/invoices', { body: sellCarton(10, { priceListId: null }) })).status, 201);
  assert.equal('priceListId' in w0.created[0], false);
  assert.equal(w0.itemQueries.length, 0);
});

test('نوعٌ ليس من الشركة ⇒ 400 PRICE_LIST_INVALID بلا مستند — للإدارة ولمندوبٍ يملك التبديل', async () => {
  for (const user of [ADMIN, REP_USER]) {
    reset(user);
    const w = issueWorld({ rep: { canChangePriceList: true } });
    const r = await call('POST', '/api/invoices', { body: sellCarton(8, { priceListId: 'L-X' }) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRICE_LIST_INVALID');
    assert.equal(w.created.length, 0);
    assert.equal(w.itemQueries.length, 0, 'لا أسعار تُقرأ لنوعٍ مرفوض');
  }
});

test('الإدارة حرّة: تبدّل النوع وتبيع بأي سعر بلا صلاحية، والمستند يُختم بما اختارته', async () => {
  reset(ADMIN);
  const w = issueWorld();
  const r = await call('POST', '/api/invoices', { body: sellCarton(11, { priceListId: 'L-R' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].priceListId, 'L-R');
});

test('شركةٌ بلا أنواع: لا استعلام أنواعٍ ولا أسعارها ولا ختم — مسار اليوم حرفياً', async () => {
  reset(REP_USER);
  const w = issueWorld({ customer: { priceListId: null } });
  const r = await call('POST', '/api/invoices', { body: sellCarton(10) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(touched('priceList'), []);
  assert.equal('priceListId' in w.created[0], false);
  // عميلٌ قديم بلا العمود أصلاً (صفٌّ سبق الميزة في المزيّف)
  reset(REP_USER);
  const { priceListId: _drop, ...legacy } = CUSTOMER;
  void _drop;
  scripted = {};
  const w2 = issueWorld();
  scripted['customer.findFirst'] = () => legacy;
  assert.equal((await call('POST', '/api/invoices', { body: sellCarton(10) })).status, 201);
  assert.deepEqual(touched('priceList'), []);
  assert.equal('priceListId' in w2.created[0], false);
});

test('إعادة رفع الصندوق (X-FS-Replay): نوعٌ حُذف أو «تبديل نوع السعر» نُزعت قبل المزامنة ⇒ نوع العميل الحالي يحكم ولا يُعدم المستند — والطلب الحيّ 400/403 كما هو', async () => {
  const REPLAY = { 'x-fs-replay': '1' };
  // (أ) مندوبٌ بالتبديل و«تغيير السعر» أصدر دون اتصال بنوعٍ حذفته الإدارة قبل المزامنة: يُقبل مختوماً بنوع العميل الحالي
  // (لا ختم بمعرّفٍ لا وجود له — المفتاح الأجنبي)، وحارس السعر يقيس بمرجعه كالمعتاد
  reset(REP_USER);
  const a = issueWorld({ rep: { canChangePriceList: true, canChangePrice: true } });
  const gone = await call('POST', '/api/invoices', { body: sellCarton(12, { priceListId: 'L-GONE' }), headers: REPLAY });
  assert.equal(gone.status, 201, JSON.stringify(gone.body));
  assert.equal(a.created[0].priceListId, 'L-W');
  assert.deepEqual(a.itemQueries.map((q) => q.where.priceListId), ['L-W'], 'أسعار نوع العميل لا النوع المحذوف');
  // والطلب الحيّ نفسه 400 كما كان
  reset(REP_USER);
  const a2 = issueWorld({ rep: { canChangePriceList: true, canChangePrice: true } });
  const live = await call('POST', '/api/invoices', { body: sellCarton(12, { priceListId: 'L-GONE' }) });
  assert.equal(live.status, 400, JSON.stringify(live.body));
  assert.equal(live.body.code, 'PRICE_LIST_INVALID');
  assert.equal(a2.created.length, 0);

  // (ب) نُزعت «تبديل نوع السعر» بين الإصدار والمزامنة: الإعادة لا تُردّ 403 PRICE_LIST_FORBIDDEN بل تُسعَّر بنوع العميل
  reset(REP_USER);
  const b = issueWorld({ customer: { priceListId: 'L-R' } });
  const same = await call('POST', '/api/invoices', { body: sellCarton(12, { priceListId: 'L-W' }), headers: REPLAY });
  assert.equal(same.status, 201, JSON.stringify(same.body));
  assert.equal(b.created[0].priceListId, 'L-R');
  assert.equal(calls.includes('priceList.count'), false, 'لا فحص وجودٍ لنوعٍ لا يُستعمل');
  // ولا ثغرة: ترويسة الإعادة لا تفتح نوعاً أرخص بلا صلاحية — الجملة (٨) يقيسها الحارس بنوع العميل (التجزئة ١٢) فتُرفض
  reset(REP_USER);
  const b2 = issueWorld({ customer: { priceListId: 'L-R' } });
  const cheap = await call('POST', '/api/invoices', { body: sellCarton(8, { priceListId: 'L-W' }), headers: REPLAY });
  assert.equal(cheap.status, 403, JSON.stringify(cheap.body));
  assert.equal(cheap.body.message, 'لا تملك صلاحية تغيير سعر البيع');
  assert.equal(b2.created.length, 0);
  // والحيّ بلا الصلاحية 403 PRICE_LIST_FORBIDDEN كما كان
  reset(REP_USER);
  issueWorld({ customer: { priceListId: 'L-R' } });
  assert.equal((await call('POST', '/api/invoices', { body: sellCarton(8, { priceListId: 'L-W' }) })).body.code, 'PRICE_LIST_FORBIDDEN');
});

test('عملةٌ بلا كسور (الدينار العراقي): سعر النوع الكسري لوحدة الأساس يصل مقرَّباً لعددٍ صحيح فيقبله الحارس — وهامش الريال ٠٫٠١ كما كان', async () => {
  /** صنفٌ كرتونه ٢٤ وسعر الجملة لكرتونه `list` (لوحدة الأساس بستّ منازل)، وشركةٌ بعملة `currency` */
  const world = (list: number, taxPct: number, currency: string, countryCode: string) => {
    const w = issueWorld();
    scripted['product.findMany'] = () => [{ ...PRODUCT, basePrice: 1200 / 24, taxPct, units: [{ ...PRODUCT.units[0], price: 1200 }] }];
    scripted['priceListItem.findMany'] = () => [{ productId: 'p1', price: listBasePriceOf(list, 24) }];
    scripted['companySettings.findUnique'] = () => ({ defaultVatPct: taxPct, countryCode, currency, einvoiceProvider: 'none', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null });
    return w;
  };
  // حبّةٌ واحدة بالسعر الشامل كما يرسله تطبيق المندوب (مقرَّباً لخانات العملة)
  const sellPiece = (unitPrice: number, taxPct: number) => ({
    customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: true, discountPct: 0,
    items: [{ productId: 'p1', qty: 1, unitPrice, discountPct: 0, taxPct }],
  });
  // كرتون الجملة بألف ⇒ الحبّة ٤١٫٦٦٦٦٦٧ ⇒ يرسل التطبيق ٤٢ بلا ضريبة و٤٨ بـ١٥٪، وكرتونٌ بـ١٠١٠ ⇒ ٤٢٫٠٨٣٣٣٣ ⇒ ٤٢ (تحت المرجع)
  for (const [list, tax, sent] of [[1000, 0, 42], [1000, 15, 48], [1010, 0, 42]]) {
    reset(REP_USER);
    world(list, tax, 'IQD', 'IQ');
    const r = await call('POST', '/api/invoices', { body: sellPiece(sent, tax) });
    assert.equal(r.status, 201, `${list}/${tax}/${sent}: ${JSON.stringify(r.body)}`);
  }
  // هامش تقريبٍ لا حرّية سعر: ٤٣ و٤١ مرفوضان
  for (const sent of [43, 41]) {
    reset(REP_USER);
    world(1000, 0, 'IQD', 'IQ');
    const r = await call('POST', '/api/invoices', { body: sellPiece(sent, 0) });
    assert.equal(r.status, 403, `${sent}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.message, 'لا تملك صلاحية تغيير سعر البيع');
  }
  // الريال (خانتان): الحبّة ٠٫٤١٦٦٦٧ تصل ٠٫٤٢ فتُقبل، و٠٫٤٣ خارج هامش ٠٫٠١ كما كان
  reset(REP_USER);
  world(10, 0, 'SAR', 'SA');
  assert.equal((await call('POST', '/api/invoices', { body: sellPiece(0.42, 0) })).status, 201);
  reset(REP_USER);
  world(10, 0, 'SAR', 'SA');
  assert.equal((await call('POST', '/api/invoices', { body: sellPiece(0.43, 0) })).status, 403);
});

test('حارس نصّي: «سعر العميل» في مرجع البيع وسقف المرتجع الحرّ وإشارة سعر إعادة الرفع = سعر العميل ?? سعر النوع', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'invoices.ts'), 'utf8');
  assert.equal(src.split('refOverrideOf(cpMap.get(it.productId), listPriceOf.get(it.productId))').length - 1, 2, 'البيع والمرتجع الحرّ');
  assert.ok(src.includes('custPrice: refOverrideOf(replayCust.get(p.id), listPriceOf.get(p.id)),'), 'إعادة الرفع');
  assert.equal(src.includes('cpMap.has(it.productId)'), false, 'لا مرجعٌ يقرأ سعر العميل وحده');
  // الختم في المرحلتين
  assert.ok(src.includes('...(docListId && { priceListId: docListId }),'));
  assert.ok(src.includes('priceListId: docListId,'));
  assert.ok(fs.readFileSync(path.join(SRC, 'routes', 'invoicesZatca.ts'), 'utf8').includes('...(ctx.priceListId && { priceListId: ctx.priceListId }),'));
});

// ═══ (٣) أسعار الصنف في الأنواع ═══

/** الصنف كما يقرؤه قفل الكتّاب: الحبة أساس، والكرتون (٢٤) رئيسي */
function listPricesWorld(o: { unit?: string; primaryUnitId?: string | null; baseConvertedAt?: Date | null } = {}) {
  const upserts: any[] = [];
  const deletes: any[] = [];
  const touches: any[] = [];
  scripted = {
    'product.findFirst': (args) => (args?.where?.id === 'p1' && args?.where?.tenantId === TENANT ? {
      id: 'p1', unit: o.unit ?? 'حبة', basePrice: 10 / 24, unitCode: null, lotTracked: false, lotTrackedSince: null,
      primaryUnitId: o.primaryUnitId === undefined ? 'u-ct' : o.primaryUnitId, baseConvertedAt: o.baseConvertedAt ?? null,
      units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true, sortOrder: 0 }],
      repSaleUnit: 'ANY', repReturnUnit: 'ANY',
    } : null),
    'priceList.count': (args) => (args?.where?.tenantId === TENANT ? (args.where.id.in as string[]).filter(id => MY_LISTS.has(id)).length : 0),
    'priceListItem.upsert': (args) => { upserts.push({ args, inTx }); return {}; },
    'priceListItem.deleteMany': (args) => { deletes.push(args); return { count: 1 }; },
    'priceListItem.findMany': () => upserts.map(u => ({ priceListId: u.args.create.priceListId, price: u.args.create.price })),
    'product.updateMany': (args) => { touches.push(args); return { count: 1 }; },
  };
  return { upserts, deletes, touches };
}
const putListPrices = (body: Record<string, unknown>) => call('PUT', '/api/products/p1/list-prices', { body });

test('PUT /products/:id/list-prices: سعر الكرتون الرئيسي ÷ ٢٤ لوحدة الأساس بستّ منازل تحت قفل الصنف، وnull يحذف، والطابع يتحرّك', async () => {
  reset();
  const w = listPricesWorld();
  const r = await putListPrices({ expectedBaseName: 'حبة', expectedPrimary: { id: 'u-ct', factor: 24 }, items: [{ priceListId: 'L-W', price: 10 }, { priceListId: 'L-R', price: null }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(w.upserts, [{
    args: { where: { priceListId_productId: { priceListId: 'L-W', productId: 'p1' } }, create: { tenantId: TENANT, priceListId: 'L-W', productId: 'p1', price: 0.416667 }, update: { price: 0.416667 } },
    inTx: true,
  }]);
  assert.deepEqual(w.deletes, [{ where: { priceListId: 'L-R', productId: 'p1', tenantId: TENANT } }]);
  assert.deepEqual(w.touches.map(t => t.where), [{ id: 'p1', tenantId: TENANT }], 'تغييرٌ للصنف تراه المزامنة');
  const lock = raws.find(x => /FROM products WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(x.sql));
  assert.ok(lock && lock.inTx, 'قفل صفّ الصنف داخل المعاملة');
  assert.deepEqual(r.body.data.listPrices, [{ priceListId: 'L-W', price: 0.416667 }]);
  // بلا رئيسية: السعر للأساس نفسه
  reset();
  const w2 = listPricesWorld({ primaryUnitId: null });
  assert.equal((await putListPrices({ expectedBaseName: 'حبة', expectedPrimary: null, items: [{ priceListId: 'L-W', price: 0.35 }] })).status, 200);
  assert.equal(w2.upserts[0].args.create.price, 0.35);
});

test('list-prices: أساسٌ أو رئيسيةٌ غير ما رآه النموذج ⇒ 409 بلا كتابة، ونوع شركةٍ أخرى ⇒ 400، ومفتاح API على صنفٍ حُوِّل بلا الأساس ⇒ 400', async () => {
  const cases: Array<[Record<string, unknown>, number, string, Parameters<typeof listPricesWorld>[0]?, User?]> = [
    [{ expectedBaseName: 'كرتون', items: [{ priceListId: 'L-W', price: 10 }] }, 409, 'BASE_UNIT_CHANGED'],
    [{ expectedBaseName: 'حبة', expectedPrimary: { id: 'u-ct', factor: 12 }, items: [{ priceListId: 'L-W', price: 10 }] }, 409, 'PRIMARY_UNIT_CHANGED'],
    [{ expectedBaseName: 'حبة', expectedPrimary: null, items: [{ priceListId: 'L-W', price: 10 }] }, 409, 'PRIMARY_UNIT_CHANGED'],
    [{ expectedBaseName: 'حبة', items: [{ priceListId: 'L-X', price: 10 }] }, 400, 'PRICE_LIST_INVALID'],
  ];
  for (const [body, status, code, world, user] of cases) {
    reset(user);
    const w = listPricesWorld(world);
    const r = await putListPrices(body);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.code, code);
    assert.equal(w.upserts.length + w.deletes.length + w.touches.length, 0, `${code}: لا كتابة`);
  }
  // مفتاح API على صنفٍ حُوِّل: الأساس صراحةً (D19) — والمخطّط يلزمه أصلاً للجميع
  reset({ ...ADMIN, apiKeyId: 'k1' });
  listPricesWorld({ baseConvertedAt: new Date('2026-10-30T00:00:00Z') });
  const noBase = await putListPrices({ items: [{ priceListId: 'L-W', price: 10 }] });
  assert.equal(noBase.status, 400, JSON.stringify(noBase.body));
  // والمفتاح الغائب ⇒ رئيسية الصنف الآن (المعامل ٢٤)
  reset();
  const w = listPricesWorld();
  assert.equal((await putListPrices({ expectedBaseName: 'حبة', items: [{ priceListId: 'L-W', price: 12 }] })).status, 200);
  assert.equal(w.upserts[0].args.create.price, 0.5);
});

test('GET /products: listPrices للإدارة وحدها — والمندوب بلا أسعار الأنواع (يقرؤها من /price-lists/prices)', async () => {
  const world = () => {
    scripted = {
      'product.findMany': () => [{ id: 'p1', name: 'ماء', units: [] }],
      'product.count': () => 1,
      'product.findFirst': () => ({ id: 'p1', name: 'ماء', units: [] }),
      'priceListItem.findMany': (args) => (args?.where?.tenantId === TENANT ? [{ productId: 'p1', priceListId: 'L-W', price: 8 / 24 }] : []),
    };
  };
  reset(); world();
  const list = await call('GET', '/api/products');
  assert.deepEqual(list.body.data[0].listPrices, [{ priceListId: 'L-W', price: 8 / 24 }]);
  reset(); world();
  assert.deepEqual((await call('GET', '/api/products/p1')).body.data.listPrices, [{ priceListId: 'L-W', price: 8 / 24 }]);
  reset(REP_USER); world();
  const rep = await call('GET', '/api/products');
  assert.equal('listPrices' in rep.body.data[0], false);
  assert.deepEqual(touched('priceListItem'), []);
});

test('POST /products بأسعار الأنواع: كرتون ٢٤ رئيسيّ بعشرة في الجملة ⇒ 0.416667 للحبّة داخل معاملة الإنشاء، وبلا وحدات للأساس نفسه، ونوع شركةٍ أخرى ⇒ 400 في المعاملة', async () => {
  const world = () => {
    const upserts: any[] = [];
    const creates: boolean[] = [];
    scripted = {
      'product.findFirst': () => null, // لا كود مكرَّر
      'product.create': (args) => {
        creates.push(inTx);
        const units = (args.data.units?.create ?? []).map((u: any, i: number) => ({ id: `u-${i}`, ...u }));
        return { id: 'p-new', ...args.data, units };
      },
      'product.update': () => ({ id: 'p-new', units: [{ id: 'u-0', name: 'كرتون', factor: 24, price: 10 }] }),
      'priceList.count': (args) => (args?.where?.tenantId === TENANT ? (args.where.id.in as string[]).filter(id => MY_LISTS.has(id)).length : 0),
      'priceListItem.upsert': (args) => { upserts.push({ args, inTx }); return {}; },
      'priceListItem.findMany': () => upserts.map(u => ({ productId: 'p-new', priceListId: u.args.create.priceListId, price: u.args.create.price })),
    };
    return { upserts, creates };
  };
  const NEW_PRODUCT = { code: 'W-1', name: 'ماء', unit: 'حبة', taxPct: 15 };
  // الإنشاء العكسي: الكرتون رئيسيّ بمعامل ٢٤ ⇒ سعر الجملة ÷ ٢٤ (لا ١٠ للحبّة: ٢٤ ضعفاً)
  reset();
  const w = world();
  const r = await call('POST', '/api/products', {
    body: { ...NEW_PRODUCT, primaryUnitName: 'كرتون', units: [{ name: 'كرتون', factor: 24, price: 12 }], listPrices: [{ priceListId: 'L-W', price: 10 }, { priceListId: 'L-R', price: null }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(w.creates, [true], 'الصنف في معاملة');
  assert.deepEqual(w.upserts.map(u => [u.args.create.priceListId, u.args.create.price, u.inTx]), [['L-W', 0.416667, true]], 'null لا يُكتب');
  assert.deepEqual(r.body.data.listPrices, [{ priceListId: 'L-W', price: 0.416667 }]);
  // الإنشاء العادي بلا وحدات: السعر لوحدة الأساس نفسها، في معاملة
  reset();
  const w2 = world();
  const plain = await call('POST', '/api/products', { body: { ...NEW_PRODUCT, basePrice: 0.5, listPrices: [{ priceListId: 'L-W', price: 0.35 }] } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.deepEqual(w2.creates, [true]);
  assert.deepEqual(w2.upserts.map(u => [u.args.create.price, u.inTx]), [[0.35, true]]);
  // نوع شركةٍ أخرى: 400 PRICE_LIST_INVALID يُرمى داخل معاملة الإنشاء (فيُلغى الصنف معه) — بلا سعرٍ مكتوب
  for (const body of [
    { ...NEW_PRODUCT, primaryUnitName: 'كرتون', units: [{ name: 'كرتون', factor: 24, price: 12 }], listPrices: [{ priceListId: 'L-X', price: 10 }] },
    { ...NEW_PRODUCT, basePrice: 0.5, listPrices: [{ priceListId: 'L-X', price: 0.35 }] },
  ]) {
    reset();
    const bad = world();
    const x = await call('POST', '/api/products', { body });
    assert.equal(x.status, 400, JSON.stringify(x.body));
    assert.equal(x.body.code, 'PRICE_LIST_INVALID');
    assert.deepEqual(bad.creates, [true], 'الإنشاء داخل المعاملة التي رُمي منها الرفض');
    assert.equal(bad.upserts.length, 0);
  }
  // بلا listPrices: الإنشاء كما كان (بلا معاملة ولا سؤال أنواع)
  reset();
  const w3 = world();
  assert.equal((await call('POST', '/api/products', { body: { ...NEW_PRODUCT, basePrice: 0.5 } })).status, 201);
  assert.deepEqual(w3.creates, [false]);
  assert.deepEqual(touched('priceList'), []);
});

// ═══ (٤) العملاء ═══

function customersWorld() {
  const written: any[] = [];
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true, canEditCustomer: true, requireCustomerProximity: false }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': (args) => (args?.where?.id === 'c1' ? { id: 'c1' } : null),
    'customer.create': (args) => { written.push(args.data); return { id: 'c-new', ...args.data }; },
    'customer.update': (args) => { written.push(args.data); return { id: 'c1', ...args.data }; },
    'priceList.count': (args) => (MY_LISTS.has(args?.where?.id) && args?.where?.tenantId === TENANT ? 1 : 0),
  };
  return { written };
}
const NEW_CUSTOMER = { name: 'بقالة', phone: '0500000000' };

test('العملاء: نوع السعر يُسقط من جسم المندوب في الإنشاء والتعديل (قرار الإدارة)، ويُكتب للإدارة بعد فحص شركته', async () => {
  reset(REP_USER);
  const w = customersWorld();
  const created = await call('POST', '/api/customers', { body: { ...NEW_CUSTOMER, priceListId: 'L-W' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal('priceListId' in w.written[0], false, 'إنشاء المندوب');
  const updated = await call('PUT', '/api/customers/c1', { body: { priceListId: 'L-W', name: 'بقالة ٢' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal('priceListId' in w.written[1], false, 'تعديل المندوب');
  assert.equal(w.written[1].name, 'بقالة ٢', 'وبقية الجسم كما هي');
  assert.deepEqual(touched('priceList'), [], 'ولا فحص لما يُسقط');

  reset(ADMIN);
  const a = customersWorld();
  assert.equal((await call('POST', '/api/customers', { body: { ...NEW_CUSTOMER, priceListId: 'L-W' } })).status, 201);
  assert.equal(a.written[0].priceListId, 'L-W');
  assert.equal((await call('PUT', '/api/customers/c1', { body: { priceListId: null } })).status, 200);
  assert.equal(a.written[1].priceListId, null, 'null صريحة = السعر الأساسي');
  assert.equal((await call('PUT', '/api/customers/c1', { body: { priceListId: '' } })).status, 200);
  assert.equal(a.written[2].priceListId, null, 'الفارغ من النموذج = السعر الأساسي');
  assert.equal((await call('PUT', '/api/customers/c1', { body: { name: 'بلا نوع' } })).status, 200);
  assert.equal('priceListId' in a.written[3], false, 'تعديلٌ لا يحمل المفتاح لا يمسّ النوع');
  for (const [method, url] of [['POST', '/api/customers'], ['PUT', '/api/customers/c1']] as const) {
    const r = await call(method, url, { body: { ...NEW_CUSTOMER, priceListId: 'L-X' } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRICE_LIST_INVALID');
  }
  assert.equal(a.written.length, 4, 'نوع شركةٍ أخرى لا يُكتب');
});

test('العملاء: نوعٌ حُذف بين الفحص والكتابة (P2003 على priceListId) ⇒ 400 PRICE_LIST_INVALID لا عطل 500', async () => {
  const fkFail = () => {
    throw Object.assign(new Error('Foreign key constraint failed on the field: `customers_priceListId_fkey (index)`'),
      { code: 'P2003', meta: { field_name: 'customers_priceListId_fkey (index)' } });
  };
  reset(ADMIN);
  customersWorld();
  scripted['customer.create'] = fkFail;
  scripted['customer.update'] = fkFail;
  for (const [method, url] of [['POST', '/api/customers'], ['PUT', '/api/customers/c1']] as const) {
    const r = await call(method, url, { body: { ...NEW_CUSTOMER, priceListId: 'L-W' } });
    assert.equal(r.status, 400, `${method}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'PRICE_LIST_INVALID');
  }
  // ومفتاحٌ أجنبيّ آخر يبقى كما كان (عطلٌ لا يُقرأ نوعَ سعر)
  scripted['customer.update'] = () => { throw Object.assign(new Error('Foreign key constraint failed on the field: `customers_tenantId_fkey (index)`'), { code: 'P2003', meta: { field_name: 'customers_tenantId_fkey (index)' } }); };
  assert.equal((await call('PUT', '/api/customers/c1', { body: { name: 'س' } })).status, 500);
});

// ═══ (٥) /api/price-lists ═══

test('GET /price-lists: الأنواع مرتّبة واسم زرّ الأساس وعدد العملاء الأحياء — بشرط الشركة، وبلا أنواعٍ لا groupBy', async () => {
  reset();
  const seen: Record<string, any> = {};
  scripted = {
    'priceList.findMany': (args) => { seen.lists = args; return [{ id: 'L-W', name: 'سعر الجملة', sortOrder: 0 }, { id: 'L-R', name: 'سعر التجزئة', sortOrder: 1 }]; },
    'companySettings.findUnique': (args) => { seen.settings = args; return { basePriceLabel: 'سعر المستهلك' }; },
    'customer.groupBy': (args) => { seen.groups = args; return [{ priceListId: 'L-W', _count: { _all: 3 } }]; },
  };
  const r = await call('GET', '/api/price-lists');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, {
    basePriceLabel: 'سعر المستهلك',
    lists: [{ id: 'L-W', name: 'سعر الجملة', sortOrder: 0, customersCount: 3 }, { id: 'L-R', name: 'سعر التجزئة', sortOrder: 1, customersCount: 0 }],
  });
  assert.equal(seen.lists.where.tenantId, TENANT);
  assert.deepEqual(seen.lists.orderBy, [{ sortOrder: 'asc' }, { name: 'asc' }]);
  assert.deepEqual(seen.groups.where, { tenantId: TENANT, priceListId: { not: null }, status: { not: 'DELETED' } });
  reset();
  const empty = await call('GET', '/api/price-lists');
  assert.deepEqual(empty.body.data, { basePriceLabel: null, lists: [] });
  assert.equal(calls.includes('customer.groupBy'), false);
});

test('/price-lists كتابةً: الاسم مقصوص فريدٌ للشركة (409)، ونوع شركةٍ أخرى 404 بلا كتابة، والمستخدم لعملاء 409 PRICE_LIST_IN_USE', async () => {
  reset();
  const created: any[] = [];
  scripted = {
    'priceList.findFirst': (args) => (args?.select?.sortOrder ? { sortOrder: 4 } : null),
    'priceList.create': (args) => { created.push(args.data); return { id: 'L-N', name: args.data.name, sortOrder: args.data.sortOrder }; },
  };
  const r = await call('POST', '/api/price-lists', { body: { name: '  سعر الجملة  ' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(created, [{ tenantId: TENANT, name: 'سعر الجملة', sortOrder: 5 }], 'في آخر الترتيب');
  assert.deepEqual(r.body.data, { id: 'L-N', name: 'سعر الجملة', sortOrder: 5, customersCount: 0 });
  // اسمٌ فارغ أو طويل ⇒ 400؛ ومكرَّر (P2002) ⇒ 409
  assert.equal((await call('POST', '/api/price-lists', { body: { name: '   ' } })).body.code, 'PRICE_LIST_NAME_INVALID');
  assert.equal((await call('POST', '/api/price-lists', { body: { name: 'x'.repeat(41) } })).status, 400);
  scripted['priceList.create'] = () => { throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); };
  const dupe = await call('POST', '/api/price-lists', { body: { name: 'سعر الجملة' } });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, 'PRICE_LIST_NAME_TAKEN');

  // عزل الشركة: البحث بالمعرّف والشركة معاً — نوع شركةٍ أخرى «غير موجود» (والحذف يقفل صفّه بالشرطين نفسيهما)
  reset();
  const where: any[] = [];
  scripted = { 'priceList.findFirst': (args) => { where.push(args.where); return null; } };
  for (const [method, url, body] of [['PUT', '/api/price-lists/L-X', { name: 'س' }], ['DELETE', '/api/price-lists/L-X', undefined]] as const) {
    const x = await call(method, url, { body });
    assert.equal(x.status, 404, JSON.stringify(x.body));
    assert.equal(x.body.code, 'PRICE_LIST_INVALID');
  }
  assert.deepEqual(where, [{ id: 'L-X', tenantId: TENANT }]);
  const lockOf = (r: Raw) => /FROM price_lists WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(r.sql);
  assert.deepEqual(raws.filter(lockOf).map(r => [r.values, r.inTx]), [[['L-X', TENANT], true]]);
  assert.deepEqual(calls.filter(c => /priceList\.(update|delete)|\.updateMany|customer\.count/.test(c)), []);

  // المستخدم لعملاء أحياء لا يُحذف — ويعود عددهم. والعدّ بعد قفل صفّ النوع في المعاملة نفسها: عميلٌ يُسنَد إليه بين العدّ
  // والحذف ينتظر القفل (FOR KEY SHARE لمفتاحه الأجنبي) فإمّا عُدَّ أو فشل مفتاحه — لا يسقط إلى السعر الأساسي بصمت
  reset();
  const seq: Array<[string, boolean]> = [];
  rawScript = (r) => (lockOf(r) ? (seq.push(['lock', r.inTx]), r.values[0] === 'L-W' && r.values[1] === TENANT ? [{ id: 'L-W' }] : []) : undefined);
  scripted = {
    'customer.count': (args) => {
      seq.push(['count', inTx]);
      return args?.where?.priceListId === 'L-W' && args?.where?.tenantId === TENANT && args?.where?.status?.not === 'DELETED' ? 2 : 0;
    },
  };
  const used = await call('DELETE', '/api/price-lists/L-W');
  assert.equal(used.status, 409, JSON.stringify(used.body));
  assert.deepEqual([used.body.code, used.body.customersCount], ['PRICE_LIST_IN_USE', 2]);
  assert.deepEqual(seq, [['lock', true], ['count', true]]);
  assert.deepEqual(calls.filter(c => /\.(updateMany|deleteMany)$/.test(c)), [], 'لا تفريغ ولا حذف');
  // بلا عملاء أحياء: ختم الفواتير والعملاء المحذوفين يُفرَّغ صراحةً بطابع تعديل (SetNull في القاعدة لا يحرّك updatedAt فتبقى
  // مزامنة /api/v1/sync على معرّفٍ لا يُترجم)، ثم يُحذف النوع بشرط الشركة — كلّه بعد القفل في المعاملة نفسها
  const writes: Array<[string, any, boolean]> = [];
  scripted = {
    'customer.count': () => { seq.push(['count', inTx]); return 0; },
    'invoice.updateMany': (args) => { writes.push(['invoice', args, inTx]); return { count: 7 }; },
    'customer.updateMany': (args) => { writes.push(['customer', args, inTx]); return { count: 1 }; },
    'priceList.deleteMany': (args) => { writes.push(['priceList', args, inTx]); return { count: 1 }; },
  };
  seq.length = 0;
  const ok = await call('DELETE', '/api/price-lists/L-W');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(seq, [['lock', true], ['count', true]]);
  assert.deepEqual(writes.map(([m, , tx]) => [m, tx]), [['invoice', true], ['customer', true], ['priceList', true]]);
  for (const [m, args] of writes.slice(0, 2)) {
    assert.deepEqual(args.where, { tenantId: TENANT, priceListId: 'L-W' }, m);
    assert.equal(args.data.priceListId, null, m);
    assert.ok(args.data.updatedAt instanceof Date, `${m}: طابع تعديل تراه المزامنة`);
  }
  assert.deepEqual(writes[2][1], { where: { id: 'L-W', tenantId: TENANT } });
});

test('PUT /price-lists/base-label: يُقصّ ويُحفظ، والفارغ أو null يعيد «السعر الأساسي»، وبلا صفّ إعدادات 409', async () => {
  reset();
  const writes: any[] = [];
  scripted = { 'companySettings.updateMany': (args) => { writes.push(args); return { count: 1 }; } };
  assert.deepEqual((await call('PUT', '/api/price-lists/base-label', { body: { label: ' سعر المستهلك ' } })).body.data, { basePriceLabel: 'سعر المستهلك' });
  assert.deepEqual((await call('PUT', '/api/price-lists/base-label', { body: { label: '' } })).body.data, { basePriceLabel: null });
  assert.deepEqual((await call('PUT', '/api/price-lists/base-label', { body: { label: null } })).body.data, { basePriceLabel: null });
  assert.deepEqual(writes.map(w => w.where), [{ tenantId: TENANT }, { tenantId: TENANT }, { tenantId: TENANT }]);
  scripted['companySettings.updateMany'] = () => ({ count: 0 });
  assert.equal((await call('PUT', '/api/price-lists/base-label', { body: { label: 'س' } })).status, 409);
});

test('GET /price-lists/prices: المندوب بلا «تبديل نوع السعر» يرى أنواع عملائه (بنطاقه) وحدها، وبها كلها — والسعر وأساس صنفه في جملةٍ واحدة', async () => {
  const world = (o: { canChangePriceList: boolean; usedLists: string[] }) => {
    const seen: Record<string, any> = {};
    scripted = {
      'priceList.findMany': () => [{ id: 'L-W', name: 'سعر الجملة' }, { id: 'L-R', name: 'سعر التجزئة' }],
      'salesRep.findFirst': () => ({ canChangePriceList: o.canChangePriceList }),
      'customer.findMany': (args) => { seen.customers = args; return o.usedLists.map(priceListId => ({ priceListId })); },
    };
    rawScript = (r) => {
      if (!/FROM price_list_items/.test(r.sql)) return undefined;
      seen.sql = r;
      return [{ priceListId: 'L-W', productId: 'p1', price: 8 / 24, unit: 'حبة', baseConvertedAt: null }, { priceListId: 'L-R', productId: 'p1', price: 0.5, unit: 'حبة', baseConvertedAt: null }];
    };
    return seen;
  };
  reset(REP_USER);
  const seen = world({ canChangePriceList: false, usedLists: ['L-W'] });
  const mine = await call('GET', '/api/price-lists/prices');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.data, [{ id: 'L-W', name: 'سعر الجملة', items: [{ productId: 'p1', price: 8 / 24, unit: 'حبة', baseConvertedAt: null }] }]);
  assert.deepEqual(seen.customers.where, { tenantId: TENANT, priceListId: { not: null }, status: { not: 'DELETED' } }, 'العزل مطفأ: كل عملاء الشركة');
  assert.deepEqual(seen.customers.distinct, ['priceListId']);
  assert.match(seen.sql.sql, /JOIN products p ON p\.id = i\."productId"/);
  assert.match(seen.sql.sql, /p\."deletedAt" IS NULL/);
  assert.equal(seen.sql.values[0], TENANT);
  // عزل العملاء مفعّل: أنواع عملائه المُسنَدين وحدها — نوع الجملة السرّي على عملاء غيره لا يصل كاش جواله
  reset(REP_USER);
  const iso = world({ canChangePriceList: false, usedLists: [] });
  scripted['companySettings.findUnique'] = () => ({ customerIsolationEnabled: true });
  scripted['customer.findMany'] = (args) => {
    iso.customers = args;
    // عميله المُسنَد على التجزئة، وعملاء غيره على الجملة
    return (args?.where?.assignments?.some?.salesRepId === 'rep-1' ? ['L-R'] : ['L-R', 'L-W']).map(priceListId => ({ priceListId }));
  };
  const scoped = await call('GET', '/api/price-lists/prices');
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.deepEqual(iso.customers.where.assignments, { some: { salesRepId: 'rep-1' } });
  assert.deepEqual(scoped.body.data.map((l: { id: string }) => l.id), ['L-R'], 'نوعٌ عملاؤه خارج نطاقه غائب');
  // بلا عملاء على أي نوع: لا أسعار ولا جملة
  reset(REP_USER);
  world({ canChangePriceList: false, usedLists: [] });
  assert.deepEqual((await call('GET', '/api/price-lists/prices')).body.data, []);
  assert.equal(raws.length, 0);
  // بالصلاحية: كل الأنواع بلا سؤال العملاء
  reset(REP_USER);
  world({ canChangePriceList: true, usedLists: [] });
  const all = await call('GET', '/api/price-lists/prices');
  assert.deepEqual(all.body.data.map((l: { id: string }) => l.id), ['L-W', 'L-R']);
  assert.equal(calls.includes('customer.findMany'), false);
  // الإدارة: كلها بلا قراءة صفّ مندوب
  reset();
  world({ canChangePriceList: false, usedLists: [] });
  assert.equal((await call('GET', '/api/price-lists/prices')).body.data.length, 2);
  assert.equal(calls.includes('salesRep.findFirst'), false);
  // شركةٌ بلا أنواع: استعلامٌ واحد
  reset(REP_USER);
  assert.deepEqual((await call('GET', '/api/price-lists/prices')).body.data, []);
  assert.deepEqual(calls, ['priceList.findMany']);
});

test('GET /price-lists/prices أسعار أصناف: مستخدم شركةٍ بلا صلاحية الأصناف ⇒ 403 بلا قراءة (كـ/products)، وأسماء الأنواع تبقى له، والمندوب يمرّ', async () => {
  const world = () => {
    scripted = {
      'priceList.findMany': () => [{ id: 'L-W', name: 'سعر الجملة', sortOrder: 0 }],
      'salesRep.findFirst': () => ({ canChangePriceList: true }),
    };
    rawScript = (r) => (/FROM price_list_items/.test(r.sql) ? [{ priceListId: 'L-W', productId: 'p1', price: 8 / 24, unit: 'حبة', baseConvertedAt: null }] : undefined);
  };
  reset(ADMIN);
  world();
  deniedPerms = new Set(['canManageProducts']);
  const denied = await call('GET', '/api/price-lists/prices');
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.deepEqual(calls, [], 'لا قراءة أنواعٍ ولا أسعار');
  assert.equal(raws.length, 0);
  // الأسماء (نموذج العميل) بلا حارس الأصناف
  const names = await call('GET', '/api/price-lists');
  assert.equal(names.status, 200, JSON.stringify(names.body));
  assert.deepEqual(names.body.data.lists.map((l: { id: string }) => l.id), ['L-W']);
  // والمندوب يمرّ بالحارس نفسه (requireAdminPermission يمرّره) ويقيّده نطاقه
  reset(REP_USER);
  world();
  deniedPerms = new Set(['canManageProducts']);
  const rep = await call('GET', '/api/price-lists/prices');
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.deepEqual(rep.body.data.map((l: { id: string }) => l.id), ['L-W']);
  // وحارس المسار في المصدر — لا في المعالج وحده (المزيّف أعلاه يحاكي requireAdminPermission)
  const src = fs.readFileSync(path.join(SRC, 'routes', 'priceLists.ts'), 'utf8');
  assert.ok(src.includes("router.get('/prices', requireAdminPermission('canManageProducts'),"));
});

// ═══ (٦) المخطّط والحمولة الخارجية ═══

test('المخطّط إضافيٌّ لـdb push: جدولان جديدان بقيدهما الفريد، وأعمدةٌ اختيارية بـSetNull، والصلاحية مطفأة افتراضاً', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const model = (name: string) => s.slice(s.indexOf(`model ${name} {`), s.indexOf('\n}', s.indexOf(`model ${name} {`)));
  assert.match(model('PriceList'), /@@unique\(\[tenantId, name\]\)/);
  assert.match(model('PriceList'), /@@map\("price_lists"\)/);
  assert.match(model('PriceListItem'), /@@unique\(\[priceListId, productId\]\)/);
  assert.match(model('PriceListItem'), /priceList\s+PriceList\s+@relation\(fields: \[priceListId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(model('PriceListItem'), /product\s+Product\s+@relation\(fields: \[productId\], references: \[id\], onDelete: Cascade\)/);
  for (const m of ['Customer', 'Invoice']) {
    assert.match(model(m), /priceListId\s+String\?/, m);
    assert.match(model(m), /priceList\s+PriceList\?\s+@relation\(fields: \[priceListId\], references: \[id\], onDelete: SetNull\)/, m);
  }
  assert.match(model('SalesRep'), /canChangePriceList Boolean @default\(false\)/);
  assert.match(model('CompanySettings'), /basePriceLabel\s+String\?/);
});

test('ERP: نوع السعر لا يخرج في حمولة العميل ولا الفاتورة (payloadVersion 3 كما هي)، والصفّ بلاه هو الكائن نفسه', () => {
  const c = { id: 'c1', name: 'بقالة', priceListId: 'L-W' };
  assert.deepEqual(customerPayloadRow(c), { id: 'c1', name: 'بقالة' });
  assert.ok('priceListId' in c, 'الأصل لا يُعدَّل');
  const plain = { id: 'c1', name: 'بقالة' };
  assert.equal(customerPayloadRow(plain), plain);
  const row = invoicePayloadRow({ id: 'i', invoiceDate: '2026-11-01T10:00:00Z', total: 10, taxAmt: 0, priceListId: null, items: [] }, 'Asia/Riyadh');
  assert.equal('priceListId' in row, false);
  assert.equal(row.payloadVersion, 3);
});
