// «ربط الدفاتر» L1 — التقاط المبيعات التشغيليّ في مسارات الفواتير (الوكيل B2b):
//   • ختم العملة: كل إنشاء صفّ فاتورة (المرحلة الأولى في invoices.ts ومنها إعادة رفع صندوق المندوب ومفتاح API، والمرحلة الثانية في
//     invoicesZatca.ts، والإشعاران في invoicesNotes.ts) يكتب Invoice.currency = عملة الشركة الفعلية لحظة الإصدار (invoiceCurrencyOf)
//     من صفّ الإعدادات المقروء أصلاً — بلا استعلام زائد.
//   • سجلّ تبديل «إعادة المرتجع للمخزون» (B11): PATCH /invoices/:id/restock يُلحق صفّ InvoiceRestockLog {previous, returnToStock,
//     changedBy} داخل معاملة التبديل نفسها، حين تتغيّر القيمة فعلاً وحده — والتبديل إلى القيمة نفسها لا يكتب، والرفض لا يكتب.
//   • لا شيء من ذلك يمسّ الدفاتر: المسارات لا تستورد services/gl ولا تذكر جداولها (الحارس gl-hooks-static).
// المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة (نمط price-list-cash-only.test.ts) — لا قاعدة بيانات ولا شبكة خارجية.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { getCountryTax } from '../config/countries';

// ═══ حقن البدائل قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
const override = (rel: string, patch: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const real = require(id) as Record<string, unknown>;
  require.cache[id]!.exports = { __esModule: true, ...real, ...patch };
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
let calls: string[] = [];
let scripted: Record<string, (args: any) => unknown> = {};
/** صفوف الفواتير وسجلّ التبديل — تُستعاد لقطتها حين ترمي المعاملة (كالقاعدة) */
let store: { invoices: Row[]; restockLogs: Row[] } = { invoices: [], restockLogs: [] };
let failRaw: ((sql: string) => unknown) | null = null;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0, amount: 0, paidAmt: 0 } };
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
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
        const snap = structuredClone(store);
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } catch (e) { store = snap; throw e; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (s: TemplateStringsArray) => {
        const sql = Array.from(s).join('?').replace(/\s+/g, ' ').trim();
        calls.push(`${key} ${sql}`);
        if (failRaw) { const e = failRaw(sql); if (e) throw e; }
        return key === '$queryRaw' ? [] : 0;
      };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; apiKeyId?: string; impersonated?: boolean; ownerIssuedKey?: boolean };
let currentUser: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
// بلا actorOf عمداً — كبقية اختبارات المسار (lots-invoices.test.ts): المسار لا يعتمد عليه (restockActorOf محلية)
stub('middleware/auth', {
  authenticate: (req: { user?: unknown; headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.user = currentUser;
    if (currentUser.apiKeyId) delete req.headers['x-fs-replay'];
    next();
  },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: (req: { user?: { impersonated?: boolean } }) => req.user?.impersonated === true,
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => ({}) });
override('routes/invoicesNotes', {
  issueReturnAsCreditNote: async () => ({ status: 201, body: { success: true, data: { id: 'n-1', number: 'RET-Z1' } } }),
});

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesModule = require('../routes/invoices') as typeof import('../routes/invoices');
const invoicesRouter = invoicesModule.default;
const { recordRestockToggleInTx, restockActorOf } = invoicesModule;
const { invoiceCurrencyOf } = require('../routes/invoicesZatca') as typeof import('../routes/invoicesZatca');
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ العُدّة ═══

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
async function call(method: 'POST' | 'PATCH', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
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
const OWNER_SESSION: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, impersonated: true };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
const REPLAY = { 'x-fs-replay': '1' };
function reset(user: User): void {
  calls = []; scripted = {}; failRaw = null;
  store = { invoices: [], restockLogs: [] };
  currentUser = user;
}

// ═══ (١) invoiceCurrencyOf — نقيّة ═══

test('invoiceCurrencyOf: تجاوز العملة يغلب (بأحرف كبيرة بلا فراغ)، وإلا عملة الإعدادات، وبلا صفٍّ أو بعملةٍ فارغة عملة الدولة', () => {
  assert.equal(invoiceCurrencyOf({ currency: 'SAR', currencyOverride: null, countryCode: 'SA' }), 'SAR');
  assert.equal(invoiceCurrencyOf({ currency: 'USD', currencyOverride: 'USD', countryCode: 'SA' }), 'USD');
  // صفٌّ قديم لم تُحدَّث عملته مع التجاوز: التجاوز هو الفعلي (ما تقارنه الدفاتر: currencyOverride || currency)
  assert.equal(invoiceCurrencyOf({ currency: 'KWD', currencyOverride: ' usd ', countryCode: 'KW' }), 'USD');
  assert.equal(invoiceCurrencyOf({ currency: ' kwd ', currencyOverride: '', countryCode: 'KW' }), 'KWD');
  assert.equal(invoiceCurrencyOf({ currency: 'EGP', currencyOverride: null }), 'EGP');
  // بلا صفّ إعدادات: دولة الشركة الافتراضية (كخانات التقريب في invoices.ts)
  assert.equal(invoiceCurrencyOf(null), getCountryTax(null).currency);
  assert.equal(invoiceCurrencyOf(undefined), 'SAR');
  assert.equal(invoiceCurrencyOf({ currency: '', currencyOverride: null, countryCode: 'KW' }), getCountryTax('KW').currency);
  assert.equal(invoiceCurrencyOf({ currency: null, countryCode: 'AE' }), getCountryTax('AE').currency);
});

test('invoiceCurrencyOf يطابق مقارنة الدفاتر (currencyOverride || currency) لكل صفٍّ يكتبه company.ts', () => {
  // company.ts: التجاوز من قائمةٍ مغلقة (USD|EUR) ويكتب currency = عملته؛ وبلا تجاوزٍ currency = عملة الدولة
  const rows = [
    { currency: 'SAR', currencyOverride: null }, { currency: 'USD', currencyOverride: 'USD' }, { currency: 'EUR', currencyOverride: 'EUR' },
    { currency: 'KWD', currencyOverride: null }, { currency: 'IQD', currencyOverride: null }, { currency: 'AED', currencyOverride: null },
  ];
  for (const r of rows) assert.equal(invoiceCurrencyOf(r), r.currencyOverride || r.currency, JSON.stringify(r));
});

// ═══ (٢) POST /invoices — ختم العملة في المرحلة الأولى ═══

const CUSTOMER = { id: 'c1', tenantId: TENANT, name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0, priceListId: null as string | null };
const REP_ROW = {
  id: 'rep-1', tenantId: TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canChangePriceList: false, canSellWithoutStock: true, maxDiscountPct: 100, locationId: null,
  canCancelInvoice: false, defaultPriceListId: null as string | null, allowedPriceTypes: null as unknown,
  tenant: { locationsEnabled: false, lotTrackingEnabled: false, settings: { teamsEnabled: false } }, teamMemberships: [],
};
const PRODUCT = {
  id: 'p1', name: 'ماء', unit: 'حبة', basePrice: 10 / 24, taxPct: 15, damagedReturnToStock: true, priceTiers: [] as unknown[],
  units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true }],
  shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, teams: [], lotTracked: false,
  repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null, primaryUnitId: 'u-ct',
};
const SA = { defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', currencyOverride: null, einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null };

function issueWorld(company: Row | null) {
  const created: Row[] = [];
  const companyReads: Row[] = [];
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => ({ ...REP_ROW }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => CUSTOMER,
    'product.findMany': () => [PRODUCT],
    'customerPrice.findMany': () => [],
    'companySettings.findUnique': (args) => { companyReads.push(args); return company; },
    'invoice.create': (args) => { created.push(args.data); return { id: `inv-${created.length}`, ...args.data, items: args.data.items.create, customer: CUSTOMER }; },
  };
  return { created, companyReads };
}
const sellCarton = (extra: Row = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0,
  items: [{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice: 10, discountPct: 0 }], ...extra,
});

test('POST /invoices: الفاتورة تُختم بعملة الشركة الفعلية — من صفّ الإعدادات نفسه (قراءةٌ واحدة بـselect المثبَّت) بلا استعلام زائد', async () => {
  const cases: [string, Row | null, string][] = [
    ['السعودية', SA, 'SAR'],
    ['تجاوز الدولار', { ...SA, currency: 'USD', currencyOverride: 'USD' }, 'USD'],
    ['الكويت بلا تجاوز', { ...SA, countryCode: 'KW', currency: 'KWD', einvoiceProvider: 'none' }, 'KWD'],
    ['بلا صفّ إعدادات', null, 'SAR'],
  ];
  for (const [label, company, want] of cases) {
    reset(ADMIN);
    const w = issueWorld(company);
    const r = await call('POST', '/api/invoices', { body: sellCarton() });
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(w.created.length, 1, label);
    assert.equal(w.created[0].currency, want, label);
    assert.equal(w.companyReads.length, 1, `${label}: قراءةٌ واحدة لصفّ الإعدادات كما كانت`);
    // العملة من عمود currency المقروء أصلاً (company.ts يكتبه = عملة التجاوز حين يُضبط) — لا عمود زائد في select المثبَّت
    assert.equal(w.companyReads[0].select.currency, true, `${label}: العملة من الصفّ نفسه`);
    assert.equal('currencyOverride' in w.companyReads[0].select, false, `${label}: select كما كان`);
    assert.equal(calls.filter((c) => c === 'companySettings.findUnique').length, 1, `${label}: لا استعلام زائد`);
  }
});

test('POST /invoices: كل مسارات الإنشاء في المرحلة الأولى تختم العملة — الإدارة، والمندوب الحيّ، وإعادة رفع صندوقه، ومفتاح API، والمرتجع والآجل', async () => {
  const usd = { ...SA, currency: 'USD', currencyOverride: 'USD' };
  const runs: [string, User, Row, Record<string, string>][] = [
    ['الإدارة نقدي', ADMIN, sellCarton(), {}],
    ['الإدارة آجل', ADMIN, sellCarton({ type: 'CREDIT' }), {}],
    ['مرتجع حرّ', ADMIN, sellCarton({ type: 'RETURN', returnReason: 'NORMAL' }), {}],
    ['المندوب حيّاً', REP_USER, sellCarton(), {}],
    ['إعادة رفع صندوق المندوب', REP_USER, sellCarton({ clientRef: '7b0f3c64-0d62-4d5e-9d36-2b1f4d1b7a12' }), REPLAY],
    ['مفتاح API', API_KEY, sellCarton(), {}],
  ];
  for (const [label, user, body, headers] of runs) {
    reset(user);
    const w = issueWorld(usd);
    const r = await call('POST', '/api/invoices', { body, headers });
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(w.created[0]?.currency, 'USD', label);
    // والختم يصل الردّ مع بقية أعمدة الصفّ
    assert.equal(r.body.data.currency, 'USD', `${label}: في الردّ`);
  }
});

// ═══ (٣) سجلّ تبديل «إعادة المرتجع للمخزون» ═══

/** معاملةٌ مزيّفة بدلالة UPDATE … WHERE المشروط (العدّ صفّ واحد حين يطابق الشرط النسخة الحالية) */
function toggleDb(rows: Row[]) {
  const logs: Row[] = [];
  const db = {
    invoice: {
      async updateMany(a: { where: Row; data: Row }) {
        let count = 0;
        for (const r of rows) {
          if (r.id === a.where.id && r.tenantId === a.where.tenantId && r.returnToStock === a.where.returnToStock) { Object.assign(r, a.data); count++; }
        }
        return { count };
      },
    },
    invoiceRestockLog: { async create(a: { data: Row }) { logs.push({ ...a.data }); return a.data; } },
  };
  return { db, logs };
}

test('recordRestockToggleInTx: صفٌّ واحد حين تتغيّر القيمة فعلاً (السابقة نقيض الجديدة)، ولا شيء للقيمة نفسها ولا لشركةٍ أخرى', async () => {
  const rows = [{ id: 'ret-1', tenantId: TENANT, returnToStock: true }, { id: 'ret-2', tenantId: 'T2', returnToStock: true }];
  const { db, logs } = toggleDb(rows);
  assert.equal(await recordRestockToggleInTx(db, TENANT, 'ret-1', false, 'admin-1'), true);
  assert.deepEqual(logs, [{ tenantId: TENANT, invoiceId: 'ret-1', previous: true, returnToStock: false, changedBy: 'admin-1' }]);
  assert.equal(rows[0].returnToStock, false);
  // التبديل إلى القيمة نفسها: لا صفّ
  assert.equal(await recordRestockToggleInTx(db, TENANT, 'ret-1', false, 'admin-1'), false);
  assert.equal(logs.length, 1);
  // والعودة: صفٌّ بالسابقة false
  assert.equal(await recordRestockToggleInTx(db, TENANT, 'ret-1', true, 'OWNER:admin-1'), true);
  assert.deepEqual(logs[1], { tenantId: TENANT, invoiceId: 'ret-1', previous: false, returnToStock: true, changedBy: 'OWNER:admin-1' });
  // مرتجع شركةٍ أخرى بالمعرّف نفسه لا يُمسّ
  assert.equal(await recordRestockToggleInTx(db, TENANT, 'ret-2', false, 'admin-1'), false);
  assert.equal(rows[1].returnToStock, true);
  assert.equal(logs.length, 2);
});

test('recordRestockToggleInTx: تبديلان متزامنان إلى القيمة نفسها يكتب أحدهما وحده — فالسجلّ يطابق الحالة دائماً', async () => {
  const rows = [{ id: 'ret-1', tenantId: TENANT, returnToStock: true }];
  const { db, logs } = toggleDb(rows);
  const results = await Promise.all([
    recordRestockToggleInTx(db, TENANT, 'ret-1', false, 'a'),
    recordRestockToggleInTx(db, TENANT, 'ret-1', false, 'b'),
  ]);
  assert.deepEqual(results.filter(Boolean).length, 1);
  assert.equal(logs.length, 1);
  // متعاكسان متتاليان: كلٌّ صفّه، وآخر صفٍّ = الحالة
  await recordRestockToggleInTx(db, TENANT, 'ret-1', true, 'c');
  await recordRestockToggleInTx(db, TENANT, 'ret-1', false, 'd');
  assert.deepEqual(logs.map((l) => [l.previous, l.returnToStock]), [[true, false], [false, true], [true, false]]);
  assert.equal(logs.at(-1)!.returnToStock, rows[0].returnToStock);
});

test('restockActorOf: بدلالة actorOf — جلسة المالك ومفتاح الدعم OWNER:<المعرّف>، وإلا المعرّف، وبلا مستخدم null', () => {
  assert.equal(restockActorOf({ id: 'u1' }), 'u1');
  assert.equal(restockActorOf({ id: 'u1', impersonated: true }), 'OWNER:u1');
  assert.equal(restockActorOf({ id: 'u1', ownerIssuedKey: true }), 'OWNER:u1');
  assert.equal(restockActorOf(null), null);
  assert.equal(restockActorOf({}), null);
});

/** عالم المرتجع: صفّ فاتورة في المخزن المزيّف، وتحديثاتها كالقاعدة (updateMany مشروط، وupdate يعيد الصفّ) */
function restockWorld(o: { returnToStock: boolean; type?: string; lotTracking?: boolean }) {
  store.invoices.push({ id: 'ret-1', tenantId: TENANT, type: o.type ?? 'RETURN', status: 'CONFIRMED', salesRepId: null, returnToStock: o.returnToStock, updatedAt: 0 });
  const inv = () => store.invoices.find((r) => r.id === 'ret-1')!;
  scripted = {
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'invoice.findFirst': (args) => {
      const r = inv();
      if (args?.where?.tenantId !== TENANT) return null;
      return args?.select?.tenant ? { id: r.id, type: r.type, tenant: { lotTrackingEnabled: o.lotTracking === true } } : { ...r };
    },
    'invoice.updateMany': (args) => {
      const r = inv();
      if (r.id !== args.where.id || r.tenantId !== args.where.tenantId || r.returnToStock !== args.where.returnToStock) return { count: 0 };
      Object.assign(r, args.data, { updatedAt: r.updatedAt + 1 });
      return { count: 1 };
    },
    'invoice.update': (args) => { const r = inv(); Object.assign(r, args.data, { updatedAt: r.updatedAt + 1 }); return { ...r }; },
    'invoiceRestockLog.create': (args) => { const row = { id: `log-${store.restockLogs.length + 1}`, ...args.data }; store.restockLogs.push(row); return row; },
    'invoiceItem.findMany': () => [],
  };
  return { inv };
}
const restock = (returnToStock: boolean) => call('PATCH', '/api/invoices/ret-1/restock', { body: { returnToStock } });

test('PATCH /restock إطفاء العودة (true→false): صفّ السجلّ في معاملة التبديل بعد قفل الصفّ وحارسه وقبل التحديث — والردّ كما كان', async () => {
  reset(ADMIN);
  const w = restockWorld({ returnToStock: true });
  const r = await restock(false);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  assert.equal(r.body.data.returnToStock, false, 'الردّ صفّ الفاتورة المحدَّث كما كان');
  assert.equal(w.inv().returnToStock, false);
  assert.equal(store.restockLogs.length, 1);
  assert.deepEqual(store.restockLogs[0], { id: 'log-1', tenantId: TENANT, invoiceId: 'ret-1', previous: true, returnToStock: false, changedBy: 'admin-1' });
  // الترتيب داخل المعاملة الواحدة: القفل ← الحارس (قراءة المرتجع) ← التبديل المشروط ← السجلّ ← التحديث القائم
  const from = calls.indexOf('$transaction');
  assert.ok(from >= 0, 'معاملة');
  const inTx = calls.slice(from);
  const at = (needle: string) => inTx.findIndex((c) => c.startsWith(needle));
  assert.ok(at('$queryRaw SELECT id FROM invoices') >= 0, 'قفل صفّ المرتجع');
  assert.ok(at('$queryRaw SELECT id FROM invoices') < at('invoice.updateMany'), 'القفل قبل التبديل');
  assert.ok(at('invoice.findFirst') < at('invoice.updateMany'), 'الحارس قبل التبديل');
  assert.ok(at('invoice.updateMany') < at('invoiceRestockLog.create'), 'السجلّ بعد التبديل المشروط');
  assert.ok(at('invoiceRestockLog.create') < inTx.lastIndexOf('invoice.update'), 'السجلّ قبل التحديث القائم');
  assert.equal(calls.filter((c) => c === '$transaction').length, 1, 'معاملةٌ واحدة');
});

test('PATCH /restock تشغيل العودة (false→true): صفّ السجلّ في معاملةٍ واحدة مع التحديث، بلا قفل لوطٍ ولا حارس — وجلسة المالك OWNER:<المعرّف>', async () => {
  reset(OWNER_SESSION);
  const w = restockWorld({ returnToStock: false });
  const r = await restock(true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.returnToStock, true);
  assert.equal(w.inv().returnToStock, true);
  assert.deepEqual(store.restockLogs.map((l) => [l.previous, l.returnToStock, l.changedBy]), [[false, true, 'OWNER:admin-1']]);
  assert.equal(calls.filter((c) => c === '$transaction').length, 1, 'معاملةٌ واحدة');
  assert.ok(!calls.some((c) => c.includes('FOR UPDATE') || c.includes('pg_advisory_xact_lock')), 'التشغيل زيادةٌ خالصة: لا قفل ولا حارس كما كان');
  const inTx = calls.slice(calls.indexOf('$transaction'));
  assert.ok(inTx.indexOf('invoice.updateMany') < inTx.indexOf('invoiceRestockLog.create'));
  assert.ok(inTx.indexOf('invoiceRestockLog.create') < inTx.lastIndexOf('invoice.update'));
});

test('PATCH /restock إلى القيمة نفسها (true→true وfalse→false): لا صفّ في السجلّ — والتحديث والردّ كما كانا', async () => {
  for (const v of [true, false]) {
    reset(ADMIN);
    const w = restockWorld({ returnToStock: v });
    const r = await restock(v);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.returnToStock, v);
    assert.equal(w.inv().returnToStock, v);
    assert.deepEqual(store.restockLogs, [], `${v}: لا صفّ`);
    assert.ok(calls.includes('invoice.update'), `${v}: التحديث القائم يمضي كما كان`);
    assert.ok(!calls.includes('invoiceRestockLog.create'), `${v}: لا كتابة سجلّ`);
  }
});

test('PATCH /restock: تبديلٌ ثم عكسه ثم تكرار ⇒ السجلّ صفّان بالترتيب وآخرهما يطابق الحالة', async () => {
  reset(ADMIN);
  const w = restockWorld({ returnToStock: true });
  assert.equal((await restock(false)).status, 200);
  assert.equal((await restock(false)).status, 200);
  assert.equal((await restock(true)).status, 200);
  assert.deepEqual(store.restockLogs.map((l) => [l.previous, l.returnToStock]), [[true, false], [false, true]]);
  assert.equal(store.restockLogs.at(-1)!.returnToStock, w.inv().returnToStock);
});

test('PATCH /restock: الرفض لا يكتب سجلاً — فشل قفل صفّ المرتجع يُلغي المعاملة قبل التبديل، وغير المرتجع 400 بلا معاملة', async () => {
  reset(ADMIN);
  const w = restockWorld({ returnToStock: true });
  failRaw = (sql) => (sql.includes('FOR UPDATE') ? Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010' }) : null);
  const r = await restock(false);
  assert.ok(r.status >= 400, JSON.stringify(r.body));
  assert.deepEqual(store.restockLogs, []);
  assert.equal(w.inv().returnToStock, true, 'لا تغيير');
  assert.ok(!calls.includes('invoice.updateMany') && !calls.includes('invoiceRestockLog.create'));
  // ليس مرتجعاً
  reset(ADMIN);
  restockWorld({ returnToStock: true, type: 'CASH' });
  const bad = await restock(false);
  assert.equal(bad.status, 400);
  assert.ok(!calls.includes('$transaction') && !calls.includes('invoiceRestockLog.create'));
});

// ═══ (٤) حرّاس نصّية ═══

/** كتلة data لنداء إنشاء الفاتورة: من `invoice.create({` حتى `items: {` الأول (أعمدة الرأس) */
function createHeads(src: string): string[] {
  const out: string[] = [];
  const re = /\b(?:tx|t|prisma)\.invoice\.create\(\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = src.indexOf('items: {', m.index);
    assert.ok(end > m.index, 'نهاية أعمدة الرأس');
    out.push(src.slice(m.index, end));
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules' && e.name !== '__fixtures__') walkTs(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('حارس نصّي: كل إنشاء صفّ فاتورة في الخادم يختم العملة — المرحلة الأولى والثانية والإشعاران، ولا مسار إنشاءٍ خارجها', () => {
  const sites = new Map<string, number>();
  for (const f of walkTs(SRC)) {
    const s = fs.readFileSync(f, 'utf8');
    const n = (s.match(/\.invoice\.create\(/g) ?? []).length;
    if (n) sites.set(path.relative(SRC, f).replace(/\\/g, '/'), n);
  }
  assert.deepEqual([...sites.entries()].sort(), [['routes/invoices.ts', 1], ['routes/invoicesNotes.ts', 1], ['routes/invoicesZatca.ts', 1]],
    'مسار إنشاء فواتير جديد: اختم Invoice.currency فيه بـinvoiceCurrencyOf ثم حدّث هذا الحارس');
  const p1 = createHeads(read('routes/invoices.ts'));
  assert.equal(p1.length, 1);
  assert.match(p1[0], /\n\s+currency: docCurrency,/, 'المرحلة الأولى');
  const inv = read('routes/invoices.ts');
  assert.match(inv, /const docCurrency = invoiceCurrencyOf\(company\);/);
  assert.match(inv, /defaultVatPct: true, countryCode: true, currency: true, einvoiceProvider: true,/, 'العملة من صفّ الإعدادات المقروء أصلاً');
  for (const f of ['routes/invoicesZatca.ts', 'routes/invoicesNotes.ts']) {
    const heads = createHeads(read(f));
    assert.equal(heads.length, 1, f);
    assert.match(heads[0], /\n\s+currency: invoiceCurrencyOf\(seller\),/, `${f}: من صفّ البائع المحمَّل`);
  }
});

test('حارس نصّي: سجلّ التبديل في كل مسارات الكتابة الأربعة لـrestock — بعد الحرّاس وقبل التحديث القائم وداخل معاملة', () => {
  const src = read('routes/invoices.ts');
  const start = src.indexOf("router.patch('/:id/restock',");
  const h = src.slice(start, src.indexOf('\n});', start));
  assert.match(h, /const changedBy = restockActorOf\(req\.user\);/);
  const LOG = 'await recordRestockToggleInTx(tx, tid, invoice.id, returnToStock, changedBy);';
  assert.equal(h.split(LOG).length - 1, 4, 'أربعة مسارات كتابة');
  // كل تحديثٍ لـreturnToStock مسبوقٌ بالسجلّ داخل المعاملة نفسها، ولا تحديث خارج معاملة
  assert.doesNotMatch(h, /prisma\.invoice\.update\(/, 'لا تحديث خارج معاملة');
  const updates = [...h.matchAll(/tx\.invoice\.update\(\{ where: \{ id: invoice\.id \}, data: \{ returnToStock \} \}\)/g)].map((m) => m.index!);
  assert.equal(updates.length, 4);
  for (const u of updates) {
    const log = h.lastIndexOf(LOG, u);
    const tx = h.lastIndexOf('prisma.$transaction(async tx => {', u);
    assert.ok(log > tx && tx >= 0, 'السجلّ داخل معاملة التحديث وقبله');
  }
  // بعد الحرّاس: حارس اللوط وحارس المتاح في السيارة قبل السجلّ في مسارَي الإطفاء
  assert.ok(h.indexOf('await assertRestockOffKeepsLots(tx, tid, invoice.id);') < h.indexOf(LOG));
  const second = h.indexOf(LOG, h.indexOf(LOG) + 1);
  assert.ok(h.indexOf("await assertReturnRemovalKeepsVan(tx, tid, invoice.id, 'RESTOCK_OFF');") < second);
  // والدالة: تحديثٌ مشروط بالقيمة السابقة ثم الصفّ حين count > 0 وحده
  const fn = src.slice(src.indexOf('export async function recordRestockToggleInTx('), src.indexOf('\n}\n', src.indexOf('export async function recordRestockToggleInTx(')));
  assert.match(fn, /tx\.invoice\.updateMany\(\{ where: \{ id: invoiceId, tenantId: tid, returnToStock: !returnToStock \}, data: \{ returnToStock \} \}\)/);
  assert.match(fn, /if \(flipped\.count === 0\) return false;/);
  assert.match(fn, /tx\.invoiceRestockLog\.create\(\{ data: \{ tenantId: tid, invoiceId, previous: !returnToStock, returnToStock, changedBy \} \}\)/);
});

test('المخطّط: InvoiceRestockLog إلحاقيّ بفهرس (tenantId, createdAt, id) للمؤشّر، وInvoice.currency اختياري (القديمة null)', () => {
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const log = schema.slice(schema.indexOf('model InvoiceRestockLog {'), schema.indexOf('\n}', schema.indexOf('model InvoiceRestockLog {')));
  for (const f of [/\n\s+invoiceId\s+String\n/, /\n\s+previous\s+Boolean\n/, /\n\s+returnToStock\s+Boolean\n/, /\n\s+changedBy\s+String\?\n/, /@@index\(\[tenantId, createdAt, id\]\)/]) {
    assert.match(log, f);
  }
  const inv = schema.slice(schema.indexOf('model Invoice {'), schema.indexOf('\n}', schema.indexOf('model Invoice {')));
  assert.match(inv, /\n\s+currency\s+String\?\n/);
});

test('المسارات التشغيلية لا تعرف الدفاتر: لا استيراد services/gl ولا ذكر جداولها في invoices.ts وinvoicesZatca*.ts وinvoicesNotes.ts وreceipts.ts', () => {
  for (const f of ['routes/invoices.ts', 'routes/invoicesZatca.ts', 'routes/invoicesZatcaDeps.ts', 'routes/invoicesNotes.ts', 'routes/receipts.ts']) {
    const s = read(f);
    assert.doesNotMatch(s, /from\s+['"][^'"]*services\/gl[^'"]*['"]/, f);
    assert.doesNotMatch(s, /glSourceEvent|glMove|glSyncCursor|gl_[a-z_]+/, f);
  }
});
