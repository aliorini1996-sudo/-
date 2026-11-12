// «بيع نقدي فقط» لقائمة الأسعار (طلب المالك ١٢ نوفمبر ٢٠٢٦: «قائمة السعر لا يتم البيع فيها الا بيع نقدي فقط ولا يمكن بيع بها اجل») —
// المعالجات الحقيقية (/api/price-lists وPOST /api/invoices) فوق Prisma مزيّف (بلا قاعدة بيانات، نمط price-lists-rep-invoices.test.ts). يثبت:
//   • PriceList.cashOnly عمودٌ إضافيّ بافتراضٍ مطفأ (db push آمن)، والرسالة حرفاً كما في المواصفة بلا تشكيل.
//   • /api/price-lists: GET يحمل cashOnly لكل قائمة (في select)، وPOST وPUT يقبلانه اختيارياً — غيابه لا يكتبه، وغير المنطقيّ 400.
//   • POST /invoices: بيعٌ آجل (CREDIT) أو بالتقسيط بقائمة المستند المحسومة (المختارة، وإلا قائمة العميل، وإلا قائمة المندوب
//     الافتراضية) وهي cashOnly ⇒ 409 PRICE_LIST_CASH_ONLY قبل أي كتابة — للمندوب والإدارة. والنقدي والمرتجع يمرّان بلا استعلام زائد،
//     وقائمةٌ بلا العلم والسعر الأساسي (بلا قائمة) كما كانا. وإعادة رفع الصندوق (X-FS-Replay) ومفتاح API معفيّان: يُقبلان كما أُرسلا.
//   • حارسٌ نصّي: الفحص بعد حسم docListId (ومنه رجوع إعادة الرفع إلى الافتراضيّة) وقبل أول كتابة في المسار.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PRICE_LIST_MESSAGES } from '../services/priceLists';

// ═══ حقن البدائل قبل تحميل الموجّهات ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
/** يحمّل الوحدة الحقيقية ثم يستبدل بعض صادراتها في الذاكرة المؤقتة — قبل أن يحمّلها routes/invoices.ts */
const override = (rel: string, patch: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const real = require(id) as Record<string, unknown>;
  require.cache[id]!.exports = { __esModule: true, ...real, ...patch };
};

let calls: string[] = [];
let scripted: Record<string, (args: any) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0 } };
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
        return (arg as (tx: unknown) => Promise<unknown>)(prismaFake);
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async () => { calls.push(key); return key === '$queryRaw' ? [] : 0; };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TENANT = 'T1';
type User = { id: string; role: string; tenantId: string; apiKeyId?: string };
let currentUser: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => false,
  actorOf: (req: { user?: { id?: string } }) => req.user?.id ?? '',
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => ({}) });
override('routes/invoicesZatca', {
  issuePhase2Invoice: async () => ({ status: 201, body: { success: true, data: { id: 'z-1', number: 'INV-Z1' } } }),
});
override('routes/invoicesNotes', {
  issueReturnAsCreditNote: async () => ({ status: 201, body: { success: true, data: { id: 'n-1', number: 'RET-Z1' } } }),
});

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesRouter = (require('../routes/invoices') as typeof import('../routes/invoices')).default;
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
  app.use('/api/price-lists', priceListsRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'GET' | 'PUT', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
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
const post = (body: unknown, headers: Record<string, string> = {}) => call('POST', '/api/invoices', { body, headers });

const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
const REPLAY = { 'x-fs-replay': '1' };
function reset(user: User): void {
  calls = []; scripted = {};
  currentUser = user;
}
/** استعلام علم القائمة (findFirst بـselect cashOnly) — وحده يقرأ العمود في مسار الإصدار */
const cashReads = () => calls.filter((c) => c === 'priceList.findFirst');

/** عميلٌ بلا قائمة (افتراضاً) — والمندوب بقائمةٍ افتراضيّة «التجزئة» L-R وبكل صلاحيات البيع */
const CUSTOMER = { id: 'c1', tenantId: TENANT, name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0, priceListId: null as string | null };
const REP_ROW = {
  id: 'rep-1', tenantId: TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: false, canSellBelowPrice: false, canChangePriceList: false, canSellWithoutStock: true, maxDiscountPct: 0, locationId: null,
  canCancelInvoice: false,
  defaultPriceListId: 'L-R' as string | null, allowedPriceTypes: null as unknown,
  tenant: { locationsEnabled: false, lotTrackingEnabled: false, settings: { teamsEnabled: false } }, teamMemberships: [],
};
/** ماء: الحبة أساسٌ، والكرتون (٢٤) بسعره المحدَّد عشرة */
const PRODUCT = {
  id: 'p1', name: 'ماء', unit: 'حبة', basePrice: 10 / 24, taxPct: 15, damagedReturnToStock: true, priceTiers: [] as { price: number; baseMinQty: number }[],
  units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true }],
  shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, teams: [], lotTracked: false,
  repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null, primaryUnitId: 'u-ct',
};
/**
 * قوائم الشركة وأسعار كرتونها لوحدة الأساس: «دفع كاش» L-CASH (نقدي فقط) كرتونها ٩، والجملة L-W ٨، والتجزئة L-R ١٢ (افتراضيّة المندوب)
 * — وL-X لشركةٍ أخرى
 */
const LIST_PRICES: Record<string, number> = { 'L-CASH': 9 / 24, 'L-W': 8 / 24, 'L-R': 12 / 24 };
const MY_LISTS = new Set(Object.keys(LIST_PRICES));
const PHASE1 = { defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null };

function issueWorld(o: { customer?: Partial<typeof CUSTOMER>; rep?: Record<string, unknown>; cashOnly?: string[] } = {}) {
  const created: any[] = [];
  const flagReads: any[] = [];
  const customer = { ...CUSTOMER, ...o.customer };
  const cashOnly = new Set(o.cashOnly ?? ['L-CASH']);
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => ({ ...REP_ROW, ...o.rep }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => customer,
    'product.findMany': () => [PRODUCT],
    'customerPrice.findMany': () => [],
    'priceList.count': (args) => (MY_LISTS.has(args?.where?.id) && args?.where?.tenantId === TENANT ? 1 : 0),
    'priceList.findFirst': (args) => {
      flagReads.push(args);
      const id = args?.where?.id;
      return MY_LISTS.has(id) && args?.where?.tenantId === TENANT ? { cashOnly: cashOnly.has(id) } : null;
    },
    'priceListItem.findMany': (args) => {
      const id = args?.where?.priceListId;
      return args?.where?.tenantId === TENANT && LIST_PRICES[id] != null ? [{ productId: 'p1', price: LIST_PRICES[id] }] : [];
    },
    'companySettings.findUnique': () => PHASE1,
    'invoice.create': (args) => { created.push(args.data); return { id: `inv-${created.length}`, ...args.data, items: args.data.items.create, customer }; },
  };
  return { created, flagReads };
}
/** بيع كرتونٍ واحد بسعرٍ صافٍ — آجلٌ افتراضاً */
const sellCarton = (unitPrice: number, extra: Record<string, unknown> = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'CREDIT', pricesIncludeTax: false, discountPct: 0,
  items: [{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice, discountPct: 0 }], ...extra,
});
const INSTALLMENT = { paymentPlan: 'INSTALLMENT', installmentPlan: { count: 3, firstDueDate: '2026-12-01', period: 'MONTHLY' } };

/** الرفض: 409 بالرمز والرسالة حرفاً، بلا مستندٍ ولا معاملةٍ ولا قراءة أسعار القائمة (الفحص قبلها) */
function assertRefused(r: Reply, w: { created: unknown[] }, label: string): void {
  assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
  assert.deepEqual(r.body, { success: false, code: 'PRICE_LIST_CASH_ONLY', message: PRICE_LIST_MESSAGES.PRICE_LIST_CASH_ONLY }, label);
  assert.equal(w.created.length, 0, `${label}: لا مستند`);
  assert.equal(calls.includes('$transaction'), false, `${label}: لا معاملة`);
  assert.deepEqual(calls.filter((c) => /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(c)), [], `${label}: لا كتابة`);
  assert.equal(calls.includes('priceListItem.findMany'), false, `${label}: الفحص قبل قراءة أسعار القائمة`);
}

// ═══ (١) العمود والرسالة ═══

test('المخطّط: PriceList.cashOnly عمودٌ منطقيّ بافتراضٍ مطفأ (إضافيّ لـdb push) — والرسالة حرفاً بلا تشكيل ولا «نوع»', () => {
  const s = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const start = s.indexOf('model PriceList {');
  const model = s.slice(start, s.indexOf('\n}', start));
  assert.match(model, /\n\s+cashOnly\s+Boolean\s+@default\(false\)/);
  assert.equal(PRICE_LIST_MESSAGES.PRICE_LIST_CASH_ONLY, 'قائمة الأسعار هذه للبيع النقدي فقط — لا يباع بها آجل ولا تقسيط');
  assert.doesNotMatch(PRICE_LIST_MESSAGES.PRICE_LIST_CASH_ONLY, /[ً-ْ]/, 'مفاتيح ترجمة الواجهة بلا تشكيل');
  assert.doesNotMatch(PRICE_LIST_MESSAGES.PRICE_LIST_CASH_ONLY, /نوع|أنواع/);
  // والواجهة تعرض رسالة الخادم نفسها (PRICE_LIST_CASH_ONLY_MSG في web-admin/src/lib/priceLists.ts) — مطابقةٌ حرفاً فلا تفترق ترجمتها
  const web = fs.readFileSync(path.join(SRC, '..', '..', 'web-admin', 'src', 'lib', 'priceLists.ts'), 'utf8');
  const m = /export const PRICE_LIST_CASH_ONLY_MSG = '([^']+)';/.exec(web);
  assert.ok(m, 'PRICE_LIST_CASH_ONLY_MSG في web-admin/src/lib/priceLists.ts');
  assert.equal(m![1], PRICE_LIST_MESSAGES.PRICE_LIST_CASH_ONLY);
});

// ═══ (٢) /api/price-lists ═══

test('GET /price-lists: cashOnly في select القوائم فيصل كل قائمة لكل الأدوار (المندوب يقرؤه في كاشه) — والقائمة بلاه كما كانت', async () => {
  for (const user of [ADMIN, REP_USER]) {
    reset(user);
    let seen: any = null;
    scripted = {
      'priceList.findMany': (args) => {
        seen = args;
        return [{ id: 'L-CASH', name: 'دفع كاش', sortOrder: 0, cashOnly: true }, { id: 'L-W', name: 'سعر الجملة', sortOrder: 1, cashOnly: false }];
      },
      'companySettings.findUnique': () => ({ basePriceLabel: null, countryCode: 'SA' }),
      'customer.groupBy': () => [{ priceListId: 'L-CASH', _count: { _all: 2 } }],
    };
    const r = await call('GET', '/api/price-lists');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(seen.select.cashOnly, true, 'select يحمل العلم');
    assert.deepEqual(r.body.data.lists.map((l: any) => [l.id, l.cashOnly, l.customersCount]), [['L-CASH', true, 2], ['L-W', false, 0]], user.role);
  }
});

test('POST /price-lists: cashOnly اختياريّ — true يُكتب، وغيابه لا يُكتب (افتراض العمود)، وغير المنطقيّ 400 بلا كتابة', async () => {
  reset(ADMIN);
  const created: any[] = [];
  scripted = {
    'priceList.findFirst': () => ({ sortOrder: 1 }),
    'priceList.create': (args) => { created.push(args); return { id: 'L-N', name: args.data.name, sortOrder: args.data.sortOrder, cashOnly: args.data.cashOnly ?? false }; },
  };
  const on = await call('POST', '/api/price-lists', { body: { name: 'دفع كاش', cashOnly: true } });
  assert.equal(on.status, 201, JSON.stringify(on.body));
  assert.deepEqual(created[0].data, { tenantId: TENANT, name: 'دفع كاش', sortOrder: 2, cashOnly: true });
  assert.equal(created[0].select.cashOnly, true, 'الردّ يحمل العلم');
  assert.equal(on.body.data.cashOnly, true);
  const plain = await call('POST', '/api/price-lists', { body: { name: 'سعر الجملة' } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal('cashOnly' in created[1].data, false, 'غيابه = افتراض العمود (مطفأ)');
  assert.equal(plain.body.data.cashOnly, false);
  const bad = await call('POST', '/api/price-lists', { body: { name: 'س', cashOnly: 'yes' } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(created.length, 2, 'لا كتابة لجسمٍ غير صالح');
});

test('PUT /price-lists/:id: cashOnly يُشغَّل ويُطفأ وحده أو مع الاسم، وغيابه لا يمسّه، وقائمة شركةٍ أخرى 404 بلا كتابة', async () => {
  reset(ADMIN);
  const updates: any[] = [];
  scripted = {
    'priceList.findFirst': (args) => (args?.where?.id === 'L-W' && args?.where?.tenantId === TENANT ? { id: 'L-W' } : null),
    'priceList.update': (args) => { updates.push(args); return { id: 'L-W', name: args.data.name ?? 'سعر الجملة', sortOrder: 1, cashOnly: args.data.cashOnly ?? false }; },
    'customer.groupBy': () => [],
  };
  const on = await call('PUT', '/api/price-lists/L-W', { body: { cashOnly: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual(updates[0].where, { id: 'L-W' });
  assert.deepEqual(updates[0].data, { cashOnly: true });
  assert.equal(updates[0].select.cashOnly, true);
  assert.equal(on.body.data.cashOnly, true);
  const off = await call('PUT', '/api/price-lists/L-W', { body: { name: 'دفع كاش', cashOnly: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(updates[1].data, { name: 'دفع كاش', cashOnly: false });
  const rename = await call('PUT', '/api/price-lists/L-W', { body: { name: 'سعر الجملة' } });
  assert.equal(rename.status, 200);
  assert.equal('cashOnly' in updates[2].data, false, 'إعادة التسمية لا تمسّ العلم');
  const bad = await call('PUT', '/api/price-lists/L-W', { body: { cashOnly: 1 } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const other = await call('PUT', '/api/price-lists/L-X', { body: { cashOnly: true } });
  assert.equal(other.status, 404);
  assert.equal(other.body.code, 'PRICE_LIST_INVALID');
  assert.equal(updates.length, 3, 'لا كتابة للجسم غير الصالح ولا لقائمة شركةٍ أخرى');
});

// ═══ (٣) POST /invoices — الرفض ═══

test('آجلٌ بقائمة العميل «نقدي فقط» ⇒ 409 PRICE_LIST_CASH_ONLY قبل أي كتابة — للمندوب والإدارة، واستعلامٌ واحد لعمودٍ واحد بشرط الشركة', async () => {
  for (const user of [REP_USER, ADMIN]) {
    reset(user);
    const w = issueWorld({ customer: { priceListId: 'L-CASH' } });
    const r = await post(sellCarton(9));
    assertRefused(r, w, user.role);
    assert.deepEqual(w.flagReads, [{ where: { id: 'L-CASH', tenantId: TENANT }, select: { cashOnly: true } }], `${user.role}: قراءةٌ واحدة`);
  }
});

test('التقسيط (CREDIT بخطة INSTALLMENT) بقائمةٍ «نقدي فقط» ⇒ 409 بالرمز نفسه', async () => {
  for (const user of [REP_USER, ADMIN]) {
    reset(user);
    const w = issueWorld({ customer: { priceListId: 'L-CASH' } });
    assertRefused(await post(sellCarton(9, INSTALLMENT)), w, `${user.role} تقسيط`);
  }
});

test('القائمة المحسومة هي التي تحكم: المختارة صراحةً، وقائمة المندوب الافتراضية لعميلٍ بلا قائمة — وتبديل الإدارة عنها يفتح الآجل', async () => {
  // الإدارة تختار «دفع كاش» صراحةً لعميلٍ بلا قائمة
  reset(ADMIN);
  const chosen = issueWorld();
  assertRefused(await post(sellCarton(9, { priceListId: 'L-CASH' })), chosen, 'المختارة');
  assert.deepEqual(chosen.flagReads.map((a) => a.where.id), ['L-CASH']);
  // مندوبٌ بالتبديل يختارها
  reset(REP_USER);
  const repChosen = issueWorld({ rep: { canChangePriceList: true } });
  assertRefused(await post(sellCarton(9, { priceListId: 'L-CASH' })), repChosen, 'مختارة المندوب');
  // قائمة المندوب الافتراضية «نقدي فقط» وعميلٌ بلا قائمة
  reset(REP_USER);
  const repDefault = issueWorld({ rep: { defaultPriceListId: 'L-CASH' } });
  assertRefused(await post(sellCarton(9)), repDefault, 'افتراضيّة المندوب');
  // عميل «دفع كاش» والإدارة تبدّل إلى الجملة: المستند بالجملة فيمرّ آجلاً ويُختم بها
  reset(ADMIN);
  const switched = issueWorld({ customer: { priceListId: 'L-CASH' } });
  const ok = await post(sellCarton(8, { priceListId: 'L-W' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(switched.created[0].priceListId, 'L-W');
  assert.equal(switched.created[0].type, 'CREDIT');
  assert.deepEqual(switched.flagReads.map((a) => a.where.id), ['L-W'], 'العلم يُقرأ للقائمة المحسومة وحدها');
  // والسعر الأساسي صراحةً (null) لعميل «دفع كاش»: بلا قائمةٍ لا قيد ولا استعلام
  reset(ADMIN);
  const base = issueWorld({ customer: { priceListId: 'L-CASH' } });
  const free = await post(sellCarton(10, { priceListId: null }));
  assert.equal(free.status, 201, JSON.stringify(free.body));
  assert.deepEqual(base.flagReads, []);
});

// ═══ (٤) POST /invoices — ما يمرّ ═══

test('النقدي بقائمة «نقدي فقط» يمرّ ويُختم بها — بلا استعلام زائد', async () => {
  for (const user of [REP_USER, ADMIN]) {
    reset(user);
    const w = issueWorld({ customer: { priceListId: 'L-CASH' } });
    const r = await post(sellCarton(9, { type: 'CASH' }));
    assert.equal(r.status, 201, `${user.role}: ${JSON.stringify(r.body)}`);
    assert.equal(w.created[0].type, 'CASH');
    assert.equal(w.created[0].priceListId, 'L-CASH');
    assert.deepEqual(cashReads(), [], `${user.role}: لا قراءة للعلم في النقدي`);
  }
});

test('المرتجع بقائمة «نقدي فقط» لا يمسّه القيد — بلا استعلام زائد', async () => {
  for (const user of [REP_USER, ADMIN]) {
    reset(user);
    const w = issueWorld({ customer: { priceListId: 'L-CASH' } });
    const r = await post(sellCarton(9, { type: 'RETURN', returnReason: 'NORMAL' }));
    assert.equal(r.status, 201, `${user.role}: ${JSON.stringify(r.body)}`);
    assert.equal(w.created[0].type, 'RETURN');
    assert.deepEqual(cashReads(), [], `${user.role}: لا قراءة للعلم في المرتجع`);
  }
});

test('قائمةٌ بلا العلم: الآجل والتقسيط كما كانا — وبلا قائمةٍ (السعر الأساسي) لا استعلام', async () => {
  reset(REP_USER);
  const w = issueWorld({ customer: { priceListId: 'L-W' } });
  const r = await post(sellCarton(8));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].type, 'CREDIT');
  assert.equal(w.created[0].priceListId, 'L-W');
  assert.deepEqual(w.flagReads.map((a) => a.where.id), ['L-W'], 'قراءةٌ واحدة للآجل بقائمة');
  // والتقسيط بالجملة يصدر بخطته بعد قراءة العلم
  reset(ADMIN);
  const wi = issueWorld({ customer: { priceListId: 'L-W' } });
  const inst = await post(sellCarton(8, INSTALLMENT));
  assert.equal(inst.status, 201, JSON.stringify(inst.body));
  assert.deepEqual([wi.created[0].type, wi.created[0].paymentPlan], ['CREDIT', 'INSTALLMENT']);
  assert.deepEqual(cashReads(), ['priceList.findFirst']);
  // مندوبٌ بلا قائمةٍ افتراضيّة وعميلٌ بلا قائمة: السعر الأساسي — لا قيد ولا استعلام
  reset(REP_USER);
  const bare = issueWorld({ rep: { defaultPriceListId: null } });
  const free = await post(sellCarton(10));
  assert.equal(free.status, 201, JSON.stringify(free.body));
  assert.equal('priceListId' in bare.created[0], false);
  assert.deepEqual(cashReads(), []);
});

test('إعادة رفع الصندوق (X-FS-Replay) بآجلٍ أو تقسيطٍ على قائمة «نقدي فقط»: يُقبل كما أُرسل بلا استعلام — مستندٌ سُلّمت بضاعته لا يُعدم', async () => {
  reset(REP_USER);
  const w = issueWorld({ customer: { priceListId: 'L-CASH' } });
  const r = await post(sellCarton(9), REPLAY);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].type, 'CREDIT');
  assert.equal(w.created[0].priceListId, 'L-CASH');
  assert.deepEqual(cashReads(), []);
  reset(REP_USER);
  const wi = issueWorld({ customer: { priceListId: 'L-CASH' } });
  const inst = await post(sellCarton(9, INSTALLMENT), REPLAY);
  assert.equal(inst.status, 201, JSON.stringify(inst.body));
  assert.deepEqual([wi.created[0].type, wi.created[0].paymentPlan, wi.created[0].priceListId], ['CREDIT', 'INSTALLMENT', 'L-CASH']);
  assert.deepEqual(cashReads(), []);
  // والطلب الحيّ نفسه بلا الترويسة يُرفض
  reset(REP_USER);
  const live = issueWorld({ customer: { priceListId: 'L-CASH' } });
  assertRefused(await post(sellCarton(9)), live, 'الحيّ');
  // والترويسة من مستخدمي الشركة (لا صندوق للوحة الإدارة ولا /m) إصدارٌ حيّ: آجلٌ وتقسيطٌ بها يُرفضان
  reset(ADMIN);
  const admin = issueWorld({ customer: { priceListId: 'L-CASH' } });
  assertRefused(await post(sellCarton(9), REPLAY), admin, 'ترويسة الإدارة');
  assert.deepEqual(admin.flagReads.map((a) => a.where.id), ['L-CASH']);
  reset(ADMIN);
  const adminInst = issueWorld({ customer: { priceListId: 'L-CASH' } });
  assertRefused(await post(sellCarton(9, INSTALLMENT), REPLAY), adminInst, 'ترويسة الإدارة تقسيط');
});

test('مفتاح API: آجلٌ بقائمة «نقدي فقط» (قائمة العميل أو المختارة) يُقبل كما أُرسل بلا استعلام — الربط حرّ', async () => {
  for (const extra of [{}, { priceListId: 'L-CASH' }]) {
    reset(API_KEY);
    const w = issueWorld({ customer: { priceListId: 'L-CASH' } });
    const r = await post(sellCarton(9, extra));
    assert.equal(r.status, 201, `${JSON.stringify(extra)}: ${JSON.stringify(r.body)}`);
    assert.equal(w.created[0].type, 'CREDIT');
    assert.equal(w.created[0].priceListId, 'L-CASH');
    assert.deepEqual(cashReads(), []);
  }
});

// ═══ (٥) حارسٌ نصّي: الموضع ═══

test('حارس نصّي: الفحص بعد حسم docListId (ومنه رجوع إعادة الرفع إلى الافتراضيّة) وقبل قراءة أسعار القائمة وأول كتابة — بإعفاء الصندوق والمفتاح', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes', 'invoices.ts'), 'utf8').replace(/\r\n/g, '\n');
  const handler = src.slice(src.indexOf("router.post('/', async"), src.indexOf('router.', src.indexOf("router.post('/', async") + 10));
  const guard = handler.indexOf("code: 'PRICE_LIST_CASH_ONLY'");
  assert.ok(guard > 0, 'الحارس في POST /');
  const replay = "const cashReplay = listReplay && req.user!.role === 'SALES_REP';";
  const cond = "if (docListId && body.type === 'CREDIT' && !cashReplay && !req.user?.apiKeyId) {";
  assert.ok(handler.includes(replay), 'إعفاء إعادة الرفع لصندوق المندوب وحده');
  assert.ok(handler.includes(cond), 'الشرط: قائمةٌ وآجل، بلا إعادة رفع صندوق المندوب ولا مفتاح');
  assert.ok(handler.indexOf(replay) < handler.indexOf(cond));
  assert.ok(handler.indexOf(cond) < guard);
  assert.ok(handler.lastIndexOf('docListId = defaultListId;', guard) > 0, 'بعد رجوع إعادة الرفع إلى الافتراضيّة');
  assert.equal(handler.indexOf('docListId =', guard), -1, 'لا تُعاد كتابة docListId بعد الحارس');
  assert.ok(guard < handler.indexOf('prisma.priceListItem.findMany'), 'قبل قراءة أسعار القائمة');
  for (const write of ['$transaction', '.create(', '.update(', '.updateMany(', '.createMany(', '.upsert(']) {
    const at = handler.indexOf(write);
    assert.ok(at === -1 || at > guard, `قبل أول ${write}`);
  }
  assert.match(handler, /message: PRICE_LIST_MESSAGES\.PRICE_LIST_CASH_ONLY/);
});
