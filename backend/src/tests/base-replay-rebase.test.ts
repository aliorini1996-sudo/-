// «الوحدة الرئيسية» — مسار POST /invoices (المرحلة الأولى) عبر الموجّه الحقيقي بعميل Prisma مزيّف (بلا قاعدة بيانات). يثبت:
//   • D16: إعادة رفع مستندٍ بلا لقطة بعد تحويل أساس صنفه تُفسَّر بالسجلّ (×٢٤ لا قارورتان)، وإشعار إدارة واحد لكل clientRef.
//   • I8: صنفٌ لم يُحوَّل (baseConvertedAt = null) لا يُسأل عنه سجلّ التحويلات أبداً، ولا الحيّ.
//   • D19: مفتاح API على صنفٍ محوَّل بلا baseUnitName ⇒ 400 BASE_UNIT_REQUIRED بلا مستند، والصنف غير المحوَّل كما كان.
//   • I10: قفل الأصناف بمهلةٍ محلية تُضبط قبله وتُستعاد بعده، و55P03 ⇒ 503 PRODUCT_UNITS_BUSY بلا مستند ولا رقم.
//   • I9: تلميح LOT لبندٍ أُعيد أساسه يُضرب بالمعامل نفسه فيساوي مجموعه baseQty.
//   • §2.12-9: رسالة تجاوز مخزون السيارة بالوحدة الرئيسية لصنفٍ له رئيسية، وبلاها النصّ القائم.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesModule = require('../routes/invoices') as typeof import('../routes/invoices');
import { scaleLotHint, invoiceLotLines } from '../services/lotsInvoice';
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

// ═══ D16 وI8 ═══

test('D16: جسمٌ بلا لقطة أُعيد رفعه بعد التحويل بأيام وسعره سعر الكرتون القديم ⇒ كرتون ×٢٤ لا قارورتان، وإشعار إدارة واحد', async () => {
  const w = world();
  const body = sale([{ productId: 'p1', qty: 2, unitPrice: 48, discountPct: 0 }], { clientRef: '11111111-1111-4111-8111-111111111111', clientCreatedAt: '2026-10-15T08:00:00Z' });
  const r = await call('POST', '/api/invoices', { body, headers: REPLAY });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const it = w.created[0].items.create[0];
  assert.deepEqual([it.qty, it.unitName, it.unitFactor, it.baseQty, it.unitCode], [2, 'كرتون', 24, 48, 'CT']);
  assert.ok(calls.includes('productBaseConversion.findMany'));
  // الساعة (بعد التحويل) تخالف السعر ⇒ إشعارٌ للإدارة، والمستند لم يُحجز
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].type, 'REPLAY_UNITS_REBASED');
  assert.match(String(w.notices[0].body), /^فاتورة دون اتصال رقم [^ —]+ فُسّرت كميات «مياه» بـكرتون بعد تحويل وحداته — راجع كمياتها/);
  assert.match(String(w.notices[0].data), /11111111-1111-4111-8111-111111111111/);
  // إشعارٌ واحد لكل clientRef
  const w2 = world({ priorNotice: true });
  assert.equal((await call('POST', '/api/invoices', { body, headers: REPLAY })).status, 201);
  assert.equal(w2.notices.length, 0, 'إشعارٌ ثانٍ للمستند نفسه');
});

test('D16: بسعر القارورة ⇒ الأساس بلا إشعار، والسعر والساعة متّفقان ⇒ بلا إشعار', async () => {
  const w = world();
  const r = await call('POST', '/api/invoices', {
    body: sale([{ productId: 'p1', qty: 2, unitPrice: 2, discountPct: 0 }], { clientRef: '22222222-2222-4222-8222-222222222222', clientCreatedAt: '2026-10-15T08:00:00Z' }),
    headers: REPLAY,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const it = w.created[0].items.create[0];
  assert.deepEqual([it.unitFactor, it.baseQty, it.unitName], [1, 2, null]);
  assert.equal(w.notices.length, 0);
});

test('I8: صنفٌ لم يُحوَّل لا يُسأل عنه السجلّ في إعادة الرفع، والحيّ لا يسأله ولو حُوِّل — والجسم بلا unitId أساسٌ (D3)', async () => {
  const w = world({ product: { ...PRODUCT, baseConvertedAt: null } });
  assert.equal((await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 2, unitPrice: 48, discountPct: 0 }]), headers: REPLAY })).status, 201);
  assert.ok(!calls.includes('productBaseConversion.findMany'), 'سُئل السجلّ لصنفٍ لم يُحوَّل');
  assert.equal(w.created[0].items.create[0].unitFactor, 1);
  const live = world();
  assert.equal((await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 2, unitPrice: 48, discountPct: 0 }]) })).status, 201);
  assert.ok(!calls.includes('productBaseConversion.findMany'), 'سُئل السجلّ في إصدارٍ حيّ');
  assert.equal(live.created[0].items.create[0].unitFactor, 1, 'الحيّ: غياب unitId = الأساس دائماً');
  assert.equal(live.notices.length, 0);
});

// ═══ D19 ═══

test('D19: مفتاح API على صنفٍ محوَّل بلا baseUnitName ⇒ 400 BASE_UNIT_REQUIRED بلا مستند، ومعه يمرّ، والصنف غير المحوَّل كما كان', async () => {
  try {
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };
    world();
    const r = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 2, unitPrice: 2, discountPct: 0 }]) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'BASE_UNIT_REQUIRED');
    assert.match(String(r.body.message), /مياه/);
    assert.ok(!calls.includes('invoice.create'));
    world();
    assert.equal((await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 2, unitPrice: 2, discountPct: 0, baseUnitName: 'قارورة' }]) })).status, 201);
    // أساسٌ قديم صريح ⇒ كاشٌ قديم (400 UNIT_INVALID) كما كان
    world();
    const stale = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 2, unitPrice: 2, discountPct: 0, baseUnitName: 'كرتون' }]) });
    assert.deepEqual([stale.status, stale.body.code], [400, 'UNIT_INVALID']);
    world({ product: { ...PRODUCT, baseConvertedAt: null } });
    assert.equal((await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 2, unitPrice: 2, discountPct: 0 }]) })).status, 201);
    // والجلسة (اللوحة والمندوب) لا تمرّ بشيء
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
    world();
    assert.equal((await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 2, unitPrice: 2, discountPct: 0 }]) })).status, 201);
  } finally {
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
  }
});

// ═══ I10 ═══

test('I10: مهلة القفل تُضبط قبل FOR KEY SHARE على الأصناف وتُستعاد بعده، و55P03 ⇒ 503 PRODUCT_UNITS_BUSY بلا مستند', async () => {
  world();
  rawScript = (r) => (r.kind === '$queryRaw' && r.sql.includes("current_setting('lock_timeout')") ? [{ lock_timeout: '7s' }] : undefined);
  assert.equal((await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 1, unitPrice: 2, discountPct: 0 }]) })).status, 201);
  const seq = raws.filter(x => x.inTx).map(x => x.sql.replace(/\s+/g, ' ').trim());
  const lock = seq.findIndex(s => /FROM products WHERE id IN/.test(s) && s.includes('FOR KEY SHARE'));
  assert.ok(lock > 1, seq.join(' | '));
  assert.match(seq[lock - 1], /set_config\('lock_timeout', \?, true\)/);
  assert.match(seq[lock - 2], /current_setting\('lock_timeout'\)/);
  assert.match(seq[lock + 1], /set_config\('lock_timeout', \?, true\)/);
  const inTxRaws = raws.filter(x => x.inTx);
  assert.equal(inTxRaws[lock - 1].values[0], '5s');
  assert.equal(inTxRaws[lock + 1].values[0], '7s', 'المهلة السابقة تُستعاد');

  for (const code of ['55P03', '40P01']) {
    world();
    rawScript = (r) => {
      if (/FROM products WHERE id IN/.test(r.sql) && r.sql.includes('FOR KEY SHARE')) throw Object.assign(new Error('canceling statement due to lock timeout'), { code });
      return undefined;
    };
    for (const headers of [undefined, REPLAY]) {
      calls = [];
      const r = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 1, unitPrice: 2, discountPct: 0 }]), headers });
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.code, 'PRODUCT_UNITS_BUSY');
      assert.doesNotMatch(String(r.body.message), /الأساس/, 'D21');
      assert.ok(!calls.includes('invoice.create'));
    }
  }
});

test('I10 (convert-base-4): قفلٌ مُنح بعد انتظارٍ طويل ثم انقضت معاملة الإصدار (P2028 بعد القفل) ⇒ 503 PRODUCT_UNITS_BUSY لا 500، وبلا انتظارٍ ⇒ كما كان', async () => {
  const expired = () => Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction.'), { code: 'P2028' });
  const script = (waitMs: number) => {
    let locked = false;
    rawScript = (r) => {
      if (/FROM products WHERE id IN/.test(r.sql) && r.sql.includes('FOR KEY SHARE')) {
        locked = true;
        // التحويل يمسك الصفّ ثم يلتزم قبيل مهلة القفل: يُمنح القفل بعد انتظار
        return new Promise((resolve) => setTimeout(() => resolve([]), waitMs));
      }
      // أول أمرٍ بعد القفل (استعادة المهلة) يجد المعاملة قد انقضت — خارج try القفل
      if (locked && r.kind === '$executeRaw' && r.sql.includes("set_config('lock_timeout'")) throw expired();
      return undefined;
    };
  };
  world();
  script(1100);
  const r = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 1, unitPrice: 2, discountPct: 0 }]) });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PRODUCT_UNITS_BUSY');
  assert.ok(!calls.includes('invoice.create'));
  // انقضاءٌ بلا انتظارٍ على القفل ليس «وحدات الأصناف قيد التحديث» — يمرّ إلى المعالج العام كما كان
  world();
  script(0);
  const plain = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 1, unitPrice: 2, discountPct: 0 }]) });
  assert.equal(plain.status, 500, JSON.stringify(plain.body));
  assert.notEqual(plain.body.code, 'PRODUCT_UNITS_BUSY');
});

// ═══ §2.12-9 ═══

test('§2.12-9: تجاوز مخزون السيارة — المتاح بالوحدة الرئيسية لصنفٍ له رئيسية، وبلاها النصّ القائم حرفياً', async () => {
  try {
    currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
    world({ product: { ...PRODUCT, baseConvertedAt: null, primaryUnitId: 'u-ct' }, rep: { canSellWithoutStock: false } });
    const r = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 1, unitPrice: 48, discountPct: 0, unitId: 'u-ct' }]) });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(String(r.body.message), /\(0 كرتون\)$/);
    world({ product: { ...PRODUCT, baseConvertedAt: null, primaryUnitId: null }, rep: { canSellWithoutStock: false } });
    const old = await call('POST', '/api/invoices', { body: sale([{ productId: 'p1', qty: 1, unitPrice: 48, discountPct: 0, unitId: 'u-ct' }]) });
    assert.equal(old.status, 403);
    assert.match(String(old.body.message), /\(0 قارورة\)$/, 'formatQty القائم بلا رئيسية');
  } finally {
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
  }
});

// ═══ I9 ═══

test('I9: scaleLotHint يضرب كميات التلميح بمعامل إعادة الأساس فيساوي مجموعه baseQty البند، ويعيد غير المفهوم كما هو', () => {
  const hint = [{ lotId: 'l1', qty: 1.5 }, { lotId: null, qty: 0.5 }];
  const scaled = scaleLotHint(hint, 24) as Array<{ lotId: string | null; qty: number }>;
  assert.deepEqual(scaled, [{ lotId: 'l1', qty: 36 }, { lotId: null, qty: 12 }]);
  const [line] = invoiceLotLines([{ productId: 'p1', productName: 'مياه', qty: 2, unitFactor: 24, lots: scaled }]);
  const refs = parseLotHint(line.lotsRaw)!;
  assert.equal(refs.reduce((s, x) => s + x.qty, 0), line.qty, 'Σ التلميح ≠ baseQty البند');
  assert.equal(scaleLotHint(hint, 1), hint, 'بلا إعادة أساس: التلميح نفسه');
  assert.equal(scaleLotHint('x', 24), 'x');
  assert.equal(scaleLotHint(undefined, 24), undefined);
  assert.deepEqual(scaleLotHint([{ lotId: 'l1', qty: 'x' }, 7], 24), [{ lotId: 'l1', qty: 'x' }, 7], 'غير المفهوم يبقى فيرفضه parseLotHint');
  assert.equal(parseLotHint(scaleLotHint([{ lotId: 'l1', qty: 'x' }], 24)), null);
});
