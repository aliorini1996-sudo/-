// «الوحدة الرئيسية» I9 على المسار الحقيقي (§3-10): مستندٌ دون اتصال لصنفٍ متتبَّع أُعيد أساسه بعد تحويل وحداته (×٢٤) — تلميح LOT
// الذي أرسله الجهاز بأساسه القديم يصل التوزيعَ مضروباً بالمعامل نفسه، فيساوي مجموعُه baseQty البند (لا LOT_HINT_REJECTED).
// وبلا إعادة أساس يصل التلميح نفسه كما أُرسل (I1). وI10: P2028 (انقضاء المعاملة وهي تنتظر القفل) ⇒ 503 PRODUCT_UNITS_BUSY.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Raw = { kind: '$queryRaw' | '$executeRaw'; sql: string; values: unknown[]; inTx: boolean };
let calls: string[] = [];
let raws: Raw[] = [];
let inTx = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
let currentUser: { id: string; role: string; tenantId: string; apiKeyId?: string } = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا مرحلة ثانية في هذه الاختبارات'); } });

// «تتبّع اللوط»: الخدمات الحقيقية، والتوزيع وحده مزيّفٌ يلتقط الخطة كما بناها المسار (ومعها التلميح بعد ضربه)، والطابور ويوم الشركة
// بلا قاعدة. تُحمَّل الحقيقية أولاً ثم يحلّ محلّها في الذاكرة نسخةٌ بالدوالّ نفسها عدا المزيّف — قبل تحميل الموجّه
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let plans: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLotsInvoice = require('../services/lotsInvoice') as typeof import('../services/lotsInvoice');
stub('services/lotsInvoice', {
  ...realLotsInvoice,
  allocateInvoiceLotsInTx: async (_tx: unknown, plan: unknown) => { plans.push(plan); return { warnings: [], lines: null }; },
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLotsDb = require('../services/lotsDb') as typeof import('../services/lotsDb');
stub('services/lotsDb', {
  ...realLotsDb,
  acquireLotQueue: async () => () => undefined,
  companyDay: async () => ({ tz: 'Asia/Riyadh', day: '2026-10-20' }),
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesModule = require('../routes/invoices') as typeof import('../routes/invoices');
import { parseLotHint } from '../services/lots';

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesModule.default);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ success: false, message: err.message });
  });
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
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

// ═══ العالم ═══

const CUSTOMER = { id: 'c1', tenantId: TENANT, name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0 };
const REP = {
  id: 'rep-1', tenantId: TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, maxDiscountPct: 100, locationId: null,
  tenant: { locationsEnabled: false, lotTrackingEnabled: false, settings: { teamsEnabled: false } }, teamMemberships: [],
};
const T_CONV = new Date('2026-10-10T08:00:00Z');
const CT = { id: 'u-ct', name: 'كرتون', factor: 24, price: 48, unitCode: 'CT', isActive: true };
/** مياهٌ كان أساسها كرتوناً (٤٨) ثم حُوّلت إلى قارورة (٢): الكرتون وحدةٌ بمعامل ٢٤ */
const PRODUCT = {
  id: 'p1', name: 'مياه', unit: 'قارورة', basePrice: 2, taxPct: 0, damagedReturnToStock: true, priceTiers: [] as { price: number; baseMinQty: number }[],
  units: [CT],
  shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, teams: [], lotTracked: false,
  repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: T_CONV as Date | null, primaryUnitId: null as string | null,
};
const CONV_ROWS = [{ productId: 'p1', fromUnit: 'كرتون', toUnit: 'قارورة', factor: 24, fromUnitId: 'u-ct', convertedAt: T_CONV }];

function world(o: { product?: typeof PRODUCT; priorNotice?: boolean; rep?: Record<string, unknown> } = {}) {
  const created: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const notices: Record<string, unknown>[] = [];
  const product = o.product ?? PRODUCT;
  calls = []; raws = []; inTx = false; rawScript = () => undefined;
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => ({ ...REP, ...(o.rep ?? {}) }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => CUSTOMER,
    'product.findMany': () => [product],
    'customerPrice.findMany': () => [],
    'productBaseConversion.findMany': () => CONV_ROWS,
    'companySettings.findUnique': () => ({ defaultVatPct: 0, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null }),
    'invoice.findFirst': () => null,
    'invoice.create': (args) => { created.push(args.data); return { id: `inv-${created.length}`, number: `INV-${created.length}`, ...args.data, items: args.data.items.create, customer: CUSTOMER }; },
    'notification.findFirst': () => (o.priorNotice ? { id: 'n-old' } : null),
    'notification.create': (args) => { notices.push(args.data); return { id: 'n' }; },
  };
  return { created, notices };
}

const sale = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0, items, ...extra,
});
const REPLAY = { 'X-FS-Replay': '1' };


const LOT_REP = { ...REP, tenant: { ...REP.tenant, lotTrackingEnabled: true } };
const TRACKED = { ...PRODUCT, lotTracked: true };
const lockedRow = (r: Raw) => (/FROM products WHERE id IN/.test(r.sql) && r.sql.includes('FOR KEY SHARE')
  ? [{ id: 'p1', unit: 'قارورة', lotTracked: true, lotTrackedSince: null }] : undefined);

test('I9 (§3-10): تلميح LOT لبندٍ أُعيد أساسه (كرتون ×٢٤) يصل التوزيع مضروباً — Σ = baseQty البند، وبلا إعادة أساس كما أُرسل', async () => {
  const hint = [{ lotId: 'L1', qty: 1.5 }, { lotId: null, qty: 0.5 }];
  // جسمٌ بلا لقطة من بناء ما قبل الميزة، بسعر الكرتون القديم: يُفسَّر كرتوناً ×٢٤ (D16-B) — والتلميح كان بالكرتون
  const w = world({ product: TRACKED, rep: LOT_REP });
  plans = [];
  rawScript = lockedRow;
  const r = await call('POST', '/api/invoices', {
    body: sale([{ productId: 'p1', qty: 2, unitPrice: 48, discountPct: 0, lots: hint }], { clientRef: '33333333-3333-4333-8333-333333333333', clientCreatedAt: '2026-10-15T08:00:00Z' }),
    headers: REPLAY,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].items.create[0].baseQty, 48);
  assert.equal(plans.length, 1, 'لم يمرّ المستند بالتوزيع');
  const [line] = plans[0].lines;
  assert.equal(line.qty, 48);
  assert.deepEqual(line.lotsRaw, [{ lotId: 'L1', qty: 36 }, { lotId: null, qty: 12 }]);
  const refs = parseLotHint(line.lotsRaw)!;
  assert.equal(refs.reduce((s, x) => s + x.qty, 0), line.qty, 'Σ التلميح ≠ baseQty البند');

  // بسعر القارورة: لا إعادة أساس ⇒ التلميح نفسه كما أُرسل (I1)
  world({ product: TRACKED, rep: LOT_REP });
  plans = [];
  rawScript = lockedRow;
  const same = [{ lotId: 'L1', qty: 2 }];
  const r2 = await call('POST', '/api/invoices', {
    body: sale([{ productId: 'p1', qty: 2, unitPrice: 2, discountPct: 0, lots: same }], { clientRef: '44444444-4444-4444-8444-444444444444', clientCreatedAt: '2026-10-15T08:00:00Z' }),
    headers: REPLAY,
  });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.deepEqual(plans[0].lines[0].lotsRaw, same);
  assert.equal(plans[0].lines[0].qty, 2);
});

test('I10: انقضاء المعاملة وهي تنتظر قفل الأصناف (P2028) في المسار غير المتتبَّع ⇒ 503 PRODUCT_UNITS_BUSY بلا مستند', async () => {
  world();
  rawScript = (r) => {
    if (/FROM products WHERE id IN/.test(r.sql) && r.sql.includes('FOR KEY SHARE')) {
      throw Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction'), { code: 'P2028' });
    }
    return undefined;
  };
  calls = [];
  const r = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 1, unitPrice: 2, discountPct: 0 }]) });
  assert.deepEqual([r.status, r.body.code], [503, 'PRODUCT_UNITS_BUSY'], JSON.stringify(r.body));
  assert.ok(!calls.includes('invoice.create'));
});
