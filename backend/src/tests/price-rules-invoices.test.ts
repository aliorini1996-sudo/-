// «قوائم الأسعار» بقواعد Odoo (طلب المالك، ٥ نوفمبر ٢٠٢٦) — حارس سعر المندوب في POST /api/invoices بالحلّ المشترك
// (services/priceRules.ts): معالجٌ حقيقيّ فوق Prisma مزيّف (بلا قاعدة بيانات). يثبت:
//   • النسبة (خصمٌ أو زيادة) من «سعر البند بلا قائمة»، والسعر الثابت للفئة (بالرئيسية ÷ معاملها لوحدة الأساس) لبند الكرتون والحبّة،
//     والحدّ الأدنى للكمية بمجموع بنود الصنف كلّها بكل وحداتها، وسعر العميل الخاص يغلب القائمة، وأولوية السعر الثابت في القائمة
//     مقابل القواعد — للمندوب بلا «تغيير السعر»، والإدارة ومفتاح API أحرار.
//   • يوم التسعير: الحيّ بيوم الخادم، وإعادة رفع الصندوق بلحظة الجهاز (عرضٌ سرى لحظة البيع ثم انتهى يُقبل)، ولحظةٌ أقدم من ثلاثين
//     يوماً أو في المستقبل ⇒ ساعة الخادم، وتاريخ الجسم لا يُقرأ أبداً.
//   • مرشّحو التسعير (CONTRACT2 D1/D3 وتحقّقها): يوم الجهاز (pricingDay) إن ساوى يوم الشركة قبل لحظة التسعير بساعتين أو بعدها بساعتين
//     (قرب منتصف ليل الشركة وحده — ظهراً لا يفتح تاريخ الجوال عرضاً)، وقواعد القائمة كما عرفها الجهاز: لحظة إصداره، أو لحظة جلبه كاش
//     الأسعار (pricesSeenAt) قبلها (L2.2) — السقف أعلى المراجع والأرضية أدناها، ومرشّحٌ واحد كما كان حرفياً.
//   • صفر كلفة: بلا قائمةٍ لا استعلام قواعد، وبلا قاعدةٍ بفترة لا استعلام منطقة، والإدارة ومفتاح API بلا استعلام قواعد (D5). وسقف
//     المرتجع الحرّ بالمرجع نفسه، وإشارة سعر إعادة الرفع (تخمين وحدة جسمٍ بلا لقطة بعد تحويل الأساس) بتلميح القائمة كما رآه الجهاز.
import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّه (نمط price-lists-rep-invoices.test.ts) ═══

const SRC = path.join(__dirname, '..');
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

let calls: string[] = [];
let scripted: Record<string, (args: any) => unknown> = {};

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
let noteCtx: any[] = [];
override('routes/invoicesZatca', {
  issuePhase2Invoice: async () => ({ status: 201, body: { success: true, data: { id: 'z-1', number: 'INV-Z1' } } }),
});
override('routes/invoicesNotes', {
  issueReturnAsCreditNote: async (ctx: unknown) => { noteCtx.push(ctx); return { status: 201, body: { success: true, data: { id: 'n-1', number: 'RET-Z1' } } }; },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesRouter = (require('../routes/invoices') as typeof import('../routes/invoices')).default;
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

type Reply = { status: number; body: Record<string, any> };
async function post(body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const s = await startServer();
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/invoices', agent: false,
      headers: { connection: 'close', 'Content-Type': 'application/json', 'Content-Length': String(payload.length), ...headers },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
const REPLAY = { 'x-fs-replay': '1' };
const DAY_MS = 86_400_000;
const CHANGE = 'لا تملك صلاحية تغيير سعر البيع';

/** يوم الشركة (الرياض — دولة الشركة SA بلا منطقة في الدفاتر) للحظةٍ بعد `days` يوماً من الآن */
const dayAt = (days: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * DAY_MS));
const isoAt = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString();
/** لحظة إصدارٍ على الجهاز بتوقيت الشركة (الرياض +03:00 بلا توقيتٍ صيفي): الساعة `hhmm` من يوم الشركة قبل `daysAgo` يوماً */
const riyadhIso = (daysAgo: number, hhmm: string): string => new Date(`${dayAt(-daysAgo)}T${hhmm}:00+03:00`).toISOString();
/**
 * ساعة الخادم مثبّتةً على لحظةٍ بتوقيت الشركة (Date وحده — المؤقّتات حقيقية فيعمل الخادم والطلب)، ويُعيدها node:test بعد الاختبار؛
 * فـdayAt وisoAt والقواعد المنشأة بعدها نسبةً إليها. ويعيد مبدّلاً للحظةٍ أخرى في الاختبار نفسه
 */
const fixClock = (t: TestContext, local: string): ((next: string) => void) => {
  const ms = (l: string): number => Date.parse(`${l}:00+03:00`);
  t.mock.timers.enable({ apis: ['Date'], now: ms(local) });
  return (next) => t.mock.timers.setTime(ms(next));
};

/** عميلٌ على القائمة L1، ومندوبٌ بلا «تغيير السعر» ولا قائمةٍ افتراضية */
const CUSTOMER = { id: 'c1', tenantId: TENANT, name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0, priceListId: 'L1' as string | null };
const REP_ROW = {
  id: 'rep-1', tenantId: TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: false, canSellBelowPrice: false, canChangePriceList: false, canSellWithoutStock: true, maxDiscountPct: 0, locationId: null,
  canCancelInvoice: false, defaultPriceListId: null as string | null, allowedPriceTypes: null as unknown,
  tenant: { locationsEnabled: false, lotTrackingEnabled: false, settings: { teamsEnabled: false } }, teamMemberships: [],
};
const PRODUCT_BASE = {
  taxPct: 15, damagedReturnToStock: true, priceTiers: [] as { price: number; baseMinQty: number }[],
  shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, teams: [], lotTracked: false,
  repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null as Date | null,
};
/** عصير: الحبّة أساسٌ بعشرة الكرتون ÷ ٢٤، والكرتون (٢٤) رئيسيٌّ بسعره المحدَّد عشرة — في فئة العصائر */
const JUICE = {
  ...PRODUCT_BASE, id: 'p1', name: 'عصير', unit: 'حبة', basePrice: 10 / 24, categoryId: 'cat-juice' as string | null,
  units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true }], primaryUnitId: 'u-ct' as string | null,
};
/** علبة عصيرٍ بلا وحدة رئيسية (السعر للأساس نفسه) في الفئة نفسها، وماءٌ في فئةٍ أخرى */
const CAN = { ...PRODUCT_BASE, id: 'p2', name: 'عصير علب', unit: 'علبة', basePrice: 3, categoryId: 'cat-juice' as string | null, units: [], primaryUnitId: null as string | null };
const WATER = { ...PRODUCT_BASE, id: 'p3', name: 'ماء', unit: 'قارورة', basePrice: 1, categoryId: 'cat-water' as string | null, units: [], primaryUnitId: null as string | null };

type Rule = Record<string, unknown> & { id: string; scope: string };
/** قاعدةٌ كُتبت قبل ستين يوماً — أقدم من أي لحظة جهازٍ تُعتمد (≤ ثلاثين يوماً)، فلا يُسقطها مرشّح D3 إلا حيث يُختبر صراحةً */
const rule = (o: Partial<Rule> & { id: string; scope: string }): Rule => ({
  productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: null, minQty: 0, startsOn: null, endsOn: null,
  updatedAt: new Date(Date.now() - 60 * DAY_MS), ...o,
});
const PHASE1 = { defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null };

/** يطابق شرط Prisma (OR على النطاق) كما يفهمه الاستعلام الحقيقي */
const ruleMatchesWhere = (r: Rule, w: any): boolean => {
  if (w?.tenantId !== TENANT || w?.priceListId !== 'L1') return false;
  if (!Array.isArray(w.OR)) return true;
  return w.OR.some((b: any) => b.scope === r.scope
    && (b.productId?.in ? b.productId.in.includes(r.productId) : true)
    && (b.categoryId?.in ? b.categoryId.in.includes(r.categoryId) : true));
};

function world(o: {
  rules?: Rule[]; items?: Record<string, number>; products?: any[]; customer?: Partial<typeof CUSTOMER>; rep?: Record<string, unknown>;
  cps?: { productId: string; price: number }[]; company?: Record<string, unknown>;
} = {}) {
  const created: any[] = [];
  const ruleQueries: any[] = [];
  const itemQueries: any[] = [];
  const customer = { ...CUSTOMER, ...o.customer };
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => ({ ...REP_ROW, ...o.rep }),
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => customer,
    'product.findMany': (args) => {
      const ids: string[] | undefined = args?.where?.id?.in;
      const all = o.products ?? [JUICE];
      return ids ? all.filter((p) => ids.includes(p.id)) : all;
    },
    'customerPrice.findMany': () => o.cps ?? [],
    'priceList.count': (args) => (args?.where?.id === 'L1' && args?.where?.tenantId === TENANT ? 1 : 0),
    'priceListItem.findMany': (args) => {
      itemQueries.push(args);
      if (args?.where?.tenantId !== TENANT || args?.where?.priceListId !== 'L1') return [];
      return Object.entries(o.items ?? {}).filter(([pid]) => args.where.productId.in.includes(pid)).map(([productId, price]) => ({ productId, price }));
    },
    'priceListRule.findMany': (args) => { ruleQueries.push(args); return (o.rules ?? []).filter((r) => ruleMatchesWhere(r, args?.where)); },
    'companySettings.findUnique': () => ({ ...PHASE1, ...o.company }),
    'invoice.create': (args) => { created.push(args.data); return { id: `inv-${created.length}`, ...args.data, items: args.data.items.create, customer }; },
  };
  return { created, ruleQueries, itemQueries };
}
function reset(user: User): void {
  calls = []; scripted = {}; noteCtx = [];
  currentUser = user;
}
const tzReads = () => calls.filter((c) => c === 'glSettings.findUnique').length;

/** بنود بيعٍ بسعرٍ صافٍ: [صنف، وحدة، كمية، سعر] */
type Line = [string, string | null, number, number];
const sale = (lines: Line[], extra: Record<string, unknown> = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0,
  items: lines.map(([productId, unitId, qty, unitPrice]) => ({ productId, ...(unitId && { unitId }), qty, unitPrice, discountPct: 0 })),
  ...extra,
});
const carton = (price: number, qty = 1): Line => ['p1', 'u-ct', qty, price];
const piece = (price: number, qty = 1): Line => ['p1', null, qty, price];
/** يُصدر المندوب المستند ويعيد الحالة (والرسالة عند الرفض) */
async function repStatus(w: Parameters<typeof world>[0], lines: Line[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<number> {
  reset(REP_USER);
  world(w);
  const r = await post(sale(lines, extra), headers);
  if (r.status === 403) assert.equal(r.body.message, CHANGE, JSON.stringify(r.body));
  else assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.status;
}

// ═══ (١) النسبة ═══

test('خصم ١٠٪ على كل الأصناف: الكرتون ٩ والحبّة ٠٫٣٧٥ يُقبلان للمندوب بلا «تغيير السعر» — والسعر العامّ فوق المرجع وما دونه يُرفضان', async () => {
  const rules = [rule({ id: 'R-all', scope: 'all', percent: 10 })];
  assert.equal(await repStatus({ rules }, [carton(9)]), 201);
  assert.equal(await repStatus({ rules }, [piece(0.38)]), 201, 'الحبّة: الأساس × ٠٫٩ = ٠٫٣٧٥ ضمن هامش ٠٫٠١');
  assert.equal(await repStatus({ rules }, [carton(10)]), 403, 'السعر العامّ فوق مرجع الخصم');
  assert.equal(await repStatus({ rules }, [carton(8.5)]), 403, 'تحت المرجع بلا شرائح');
  assert.equal(await repStatus({ rules }, [piece(0.42)]), 403);
  // شاملاً للضريبة كما يرسله التطبيق: ٩ × ١٫١٥ = ١٠٫٣٥
  assert.equal(await repStatus({ rules }, [carton(10.35)], { pricesIncludeTax: true }), 201);
});

test('زيادة بنسبة (سالبة): −٢٠٪ ⇒ الكرتون ١٢ — والنسبة من سعر الكرتون المحدَّد لا من الأساس × ٢٤', async () => {
  const rules = [rule({ id: 'R-up', scope: 'all', percent: -20 })];
  assert.equal(await repStatus({ rules }, [carton(12)]), 201);
  assert.equal(await repStatus({ rules }, [carton(12.5)]), 403);
  // كرتونٌ سعره المحدَّد ٩ (لا ١٠ = الأساس × ٢٤): الزيادة منه ⇒ ١٠٫٨
  const odd = { ...JUICE, units: [{ ...JUICE.units[0], price: 9 }] };
  assert.equal(await repStatus({ rules, products: [odd] }, [carton(10.8)]), 201);
  assert.equal(await repStatus({ rules, products: [odd] }, [carton(12)]), 403);
});

// ═══ (٢) الفئة ═══

test('سعرٌ ثابت لفئة العصائر (٦ للوحدة الرئيسية): الكرتون ٦ والحبّة ٦ ÷ ٢٤ = ٠٫٢٥، وصنفٌ بلا رئيسية ٦ لأساسه، وفئةٌ أخرى بسعرها', async () => {
  const rules = [rule({ id: 'R-cat', scope: 'category', categoryId: 'cat-juice', kind: 'fixed', primaryPrice: 6 })];
  const products = [JUICE, CAN, WATER];
  assert.equal(await repStatus({ rules, products }, [carton(6)]), 201);
  assert.equal(await repStatus({ rules, products }, [piece(0.25)]), 201);
  assert.equal(await repStatus({ rules, products }, [carton(10)]), 403, 'سعر الكرتون العامّ فوق سعر الفئة');
  assert.equal(await repStatus({ rules, products }, [piece(0.42)]), 403);
  assert.equal(await repStatus({ rules, products }, [['p2', null, 1, 6]]), 201, 'بلا رئيسية: السعر لوحدة الأساس نفسها');
  assert.equal(await repStatus({ rules, products }, [['p2', null, 1, 3]]), 403);
  assert.equal(await repStatus({ rules, products }, [['p3', null, 1, 1]]), 201, 'الماء خارج الفئة بسعره');
  // والاستعلام مضيَّقٌ بأصناف المستند وفئاتها
  reset(REP_USER);
  const w = world({ rules, products });
  assert.equal((await post(sale([carton(6), ['p2', null, 1, 6], ['p3', null, 1, 1]]))).status, 201);
  assert.equal(w.ruleQueries.length, 1);
  const q = w.ruleQueries[0];
  assert.equal(q.where.tenantId, TENANT);
  assert.equal(q.where.priceListId, 'L1');
  assert.deepEqual(q.where.OR, [
    { scope: 'product', productId: { in: ['p1', 'p2', 'p3'] } },
    { scope: 'category', categoryId: { in: ['cat-juice', 'cat-water'] } },
    { scope: 'all' },
  ]);
  assert.deepEqual(Object.keys(q.select).sort(), ['basePrice', 'categoryId', 'endsOn', 'id', 'kind', 'minQty', 'percent', 'primaryPrice', 'productId', 'scope', 'startsOn', 'updatedAt']);
  // وشكل استعلام السعر الثابت كما كان حرفياً
  assert.deepEqual(w.itemQueries, [{ where: { tenantId: TENANT, priceListId: 'L1', productId: { in: ['p1', 'p2', 'p3'] } }, select: { productId: true, price: true } }]);
  // وأصنافٌ بلا فئة: لا فرع فئة
  reset(REP_USER);
  const w2 = world({ products: [{ ...JUICE, categoryId: null }] });
  assert.equal((await post(sale([carton(10)]))).status, 201);
  assert.deepEqual(w2.ruleQueries[0].where.OR, [{ scope: 'product', productId: { in: ['p1'] } }, { scope: 'all' }]);
});

// ═══ (٣) الحدّ الأدنى للكمية ═══

test('الحدّ الأدنى للكمية بمجموع بنود الصنف: كرتونٌ و٢٤ حبّة = كرتونان ⇒ الخصم للبندين، وكرتونٌ وحده أو و٢٣ حبّة ⇒ بلا خصم', async () => {
  const rules = [rule({ id: 'R-q', scope: 'product', productId: 'p1', percent: 10, minQty: 2 })];
  assert.equal(await repStatus({ rules }, [carton(9), piece(0.375, 24)]), 201);
  assert.equal(await repStatus({ rules }, [carton(9)]), 403, 'كرتونٌ واحد دون الحدّ');
  assert.equal(await repStatus({ rules }, [carton(9), piece(0.375, 23)]), 403, '٤٧ حبّة دون كرتونين');
  assert.equal(await repStatus({ rules }, [carton(10), piece(0.42, 23)]), 201, 'دون الحدّ: سعر اليوم');
  assert.equal(await repStatus({ rules }, [carton(9), piece(0.42, 24)]), 403, 'بلغ الحدّ: الحبّة بسعرها العامّ فوق مرجع الخصم');
  assert.equal(await repStatus({ rules }, [carton(9, 2)]), 201, 'كرتونان في بندٍ واحد');
  // شريحتان: ١٠٪ من كرتونين و٢٠٪ من خمسة — الأعلى حدّاً يغلب حين يتحقّقان
  const tiers = [...rules, rule({ id: 'R-q5', scope: 'product', productId: 'p1', percent: 20, minQty: 5 })];
  assert.equal(await repStatus({ rules: tiers }, [carton(8, 3), piece(1 / 3, 48)]), 201);
  assert.equal(await repStatus({ rules: tiers }, [carton(9, 3), piece(0.375, 48)]), 403, 'خمسة كراتين: شريحة ٢٠٪');
  assert.equal(await repStatus({ rules: tiers }, [carton(9, 4)]), 201, 'أربعة كراتين: شريحة ١٠٪');
});

// ═══ (٤) الصلاحية ويوم التسعير ═══

test('الصلاحية في الإصدار الحيّ بيوم الخادم: عرض اليوم يسري، وعرض الأمس لا — وتاريخ الجسم لا يُقرأ للحارس أبداً', async () => {
  const today = [rule({ id: 'R-d0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })];
  const yesterday = [rule({ id: 'R-d1', scope: 'all', percent: 10, startsOn: dayAt(-1), endsOn: dayAt(-1) })];
  const open = [rule({ id: 'R-from', scope: 'all', percent: 10, startsOn: dayAt(-30) })];
  const future = [rule({ id: 'R-to', scope: 'all', percent: 10, startsOn: dayAt(1) })];
  assert.equal(await repStatus({ rules: today }, [carton(9)]), 201);
  assert.equal(await repStatus({ rules: yesterday }, [carton(9)]), 403);
  assert.equal(await repStatus({ rules: yesterday }, [carton(10)]), 201, 'انتهى العرض: سعر اليوم');
  assert.equal(await repStatus({ rules: open }, [carton(9)]), 201, 'بدايةٌ بلا نهاية');
  assert.equal(await repStatus({ rules: future }, [carton(9)]), 403, 'لم يبدأ بعد');
  // المندوب يرسل invoiceDate بيوم العرض المنتهي: لا يفتحه
  assert.equal(await repStatus({ rules: yesterday }, [carton(9)], { invoiceDate: dayAt(-1) }), 403);
});

test('إعادة رفع الصندوق بلحظة الجهاز: عرضٌ سرى لحظة البيع ثم انتهى قبل المزامنة يُقبل — والطلب الحيّ نفسه 403، وانحراف ساعة الجهاز يُصحَّح', async () => {
  const promo = [rule({ id: 'R-p', scope: 'all', percent: 10, startsOn: dayAt(-2), endsOn: dayAt(-2) })];
  const body = { clientCreatedAt: isoAt(-2) };
  assert.equal(await repStatus({ rules: promo }, [carton(9)], body, REPLAY), 201);
  assert.equal(await repStatus({ rules: promo }, [carton(9)], body), 403, 'الحيّ بيوم الخادم');
  // ساعة الجهاز متأخّرة يوماً: أصدر عند «قبل ٣ أيام» على ساعته ورفع حين كانت ساعته «قبل يوم» ⇒ الإصدار الحقيقي قبل يومين
  assert.equal(await repStatus({ rules: promo }, [carton(9)], { clientCreatedAt: isoAt(-3) }, { ...REPLAY, 'x-fs-device-now': String(Date.now() - DAY_MS) }), 201);
  // وبلا تصحيح (الترويسة غائبة) لحظة «قبل ٣ أيام» خارج العرض
  assert.equal(await repStatus({ rules: promo }, [carton(9)], { clientCreatedAt: isoAt(-3) }, REPLAY), 403);
});

test('لحظة جهازٍ حتى ثلاثين يوماً (D1 — المحجوز «بانتظار الإدارة»): ١٠ و٢٥ يوماً بيوم الجهاز، وأقدم أو في المستقبل ⇒ ساعة الخادم', async () => {
  for (const days of [8, 10, 25]) {
    const promo = [rule({ id: `R-${days}`, scope: 'all', percent: 10, startsOn: dayAt(-days), endsOn: dayAt(-days) })];
    const at = { clientCreatedAt: isoAt(-days) };
    assert.equal(await repStatus({ rules: promo }, [carton(9)], at, REPLAY), 201, `${days} يوماً: عرض يوم البيع يسري`);
    assert.equal(await repStatus({ rules: promo }, [carton(10)], at, REPLAY), 403, `${days} يوماً: مرشّحٌ واحد — السعر العامّ فوق مرجع يوم البيع`);
    assert.equal(await repStatus({ rules: promo }, [carton(9)], at), 403, `${days} يوماً: والحيّ بيوم الخادم`);
  }
  const old = { clientCreatedAt: isoAt(-40) };
  assert.equal(await repStatus({ rules: [rule({ id: 'R-40', scope: 'all', percent: 10, startsOn: dayAt(-40), endsOn: dayAt(-40) })] }, [carton(9)], old, REPLAY), 403, 'أربعون يوماً ⇒ ساعة الخادم');
  assert.equal(await repStatus({ rules: [rule({ id: 'R-0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })] }, [carton(9)], old, REPLAY), 201);
  const edge = { clientCreatedAt: isoAt(-31) };
  assert.equal(await repStatus({ rules: [rule({ id: 'R-31', scope: 'all', percent: 10, startsOn: dayAt(-31), endsOn: dayAt(-31) })] }, [carton(9)], edge, REPLAY), 403, 'واحدٌ وثلاثون ⇒ ساعة الخادم');
  const ahead = { clientCreatedAt: isoAt(2) };
  assert.equal(await repStatus({ rules: [rule({ id: 'R+2', scope: 'all', percent: 10, startsOn: dayAt(2), endsOn: dayAt(2) })] }, [carton(9)], ahead, REPLAY), 403);
  assert.equal(await repStatus({ rules: [rule({ id: 'R-0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })] }, [carton(9)], ahead, REPLAY), 201);
  // ولحظةٌ تالفة كذلك
  assert.equal(await repStatus({ rules: [rule({ id: 'R-0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })] }, [carton(9)], { clientCreatedAt: 'غداً' }, REPLAY), 201);
});

// ═══ (٤-ب) يوم تسعير الجهاز (CONTRACT2 D1) ═══

test('D1: يوم الجهاز (pricingDay) مرشّحٌ ثانٍ ضمن ساعتين من لحظة الخادم — ٠٠:٣٠ بتوقيت الشركة يقبل أمسها، والنطاق بين المرجعين', async (t) => {
  fixClock(t, '2026-11-06T00:30');
  assert.equal(dayAt(0), '2026-11-06');
  const yesterday = [rule({ id: 'R-y', scope: 'all', percent: 10, startsOn: dayAt(-1), endsOn: dayAt(-1) })];
  const dev = { pricingDay: dayAt(-1) };
  // سلّةٌ سُعّرت قبل منتصف الليل (أو جهازٌ بمنطقة UTC يومه أمسُ الشركة) والعرض ساريه — يُقبل حيّاً، وبلا pricingDay كما كان 403
  assert.equal(await repStatus({ rules: yesterday }, [carton(9)], dev), 201);
  assert.equal(await repStatus({ rules: yesterday }, [carton(9)]), 403, 'بلا يوم الجهاز كما كان');
  // النطاق: السعر العامّ (يوم الخادم) والخصم (يوم الجهاز) كلاهما، وما خارجهما يُرفض
  assert.equal(await repStatus({ rules: yesterday }, [carton(10)], dev), 201);
  assert.equal(await repStatus({ rules: yesterday }, [carton(9.5)], dev), 201);
  assert.equal(await repStatus({ rules: yesterday }, [carton(8.5)], dev), 403);
  assert.equal(await repStatus({ rules: yesterday }, [carton(10.5)], dev), 403);
  assert.equal(await repStatus({ rules: yesterday }, [carton(10.35)], { ...dev, pricesIncludeTax: true }), 201, 'شاملاً للضريبة');
});

test('D1: ٢٣:٣٠ بتوقيت الشركة يقبل يوم غدها — عرضٌ يبدأ غداً، ونهاية عرضٍ اليوم والجهاز سعّر بسعر الغد العامّ', async (t) => {
  fixClock(t, '2026-11-05T23:30');
  assert.equal(dayAt(0), '2026-11-05');
  // المرآة: عرضٌ يبدأ غداً ويوم الجهاز غدٌ (ساعة الجهاز متقدّمة دقائق أو منطقته شرقاً)
  const tomorrow = [rule({ id: 'R-t', scope: 'all', percent: 10, startsOn: dayAt(1) })];
  assert.equal(await repStatus({ rules: tomorrow }, [carton(9)], { pricingDay: dayAt(1) }), 201);
  assert.equal(await repStatus({ rules: tomorrow }, [carton(9)]), 403);
  // ونهاية عرضٍ في يوم الخادم والجهاز سعّر بسعر الغد العامّ (سلّةٌ مفتوحة عبر منتصف الليل على جهازٍ متقدّم)
  const endsToday = [rule({ id: 'R-e', scope: 'all', percent: 10, endsOn: dayAt(0) })];
  assert.equal(await repStatus({ rules: endsToday }, [carton(10)], { pricingDay: dayAt(1) }), 201);
  assert.equal(await repStatus({ rules: endsToday }, [carton(10)]), 403);
  // والأمس ليس ضمن ساعتين من ٢٣:٣٠
  const yesterday = [rule({ id: 'R-y', scope: 'all', percent: 10, startsOn: dayAt(-1), endsOn: dayAt(-1) })];
  assert.equal(await repStatus({ rules: yesterday }, [carton(9)], { pricingDay: dayAt(-1) }), 403);
});

test('D1 (التحقّق): ظهراً يُهمل يوم الجهاز المخالف — تغيير تاريخ الجوال يوماً لا يفتح لمندوبٍ بلا «تغيير السعر» عرض الأمس المنتهي ولا عرض الغد', async (t) => {
  const setClock = fixClock(t, '2026-11-05T12:00');
  const ended = [rule({ id: 'R-y', scope: 'all', percent: 10, startsOn: '2026-11-04', endsOn: '2026-11-04' })];
  const next = [rule({ id: 'R-t', scope: 'all', percent: 10, startsOn: '2026-11-06' })];
  const endsToday = [rule({ id: 'R-e', scope: 'all', percent: 10, endsOn: '2026-11-05' })];
  assert.equal(await repStatus({ rules: ended }, [carton(9)], { pricingDay: '2026-11-04' }), 403, 'عرض الأمس ظهراً');
  assert.equal(await repStatus({ rules: ended }, [carton(10)], { pricingDay: '2026-11-04' }), 201, 'سعر اليوم');
  assert.equal(await repStatus({ rules: next }, [carton(9)], { pricingDay: '2026-11-06' }), 403, 'عرض الغد ظهراً');
  assert.equal(await repStatus({ rules: endsToday }, [carton(10)], { pricingDay: '2026-11-06' }), 403, 'سعر الغد العامّ ظهراً');
  assert.equal(await repStatus({ rules: endsToday }, [carton(9)], { pricingDay: '2026-11-06' }), 201);
  // حدّا النافذة: ٢١:٥٩ لا يبلغ الغد و٢٢:٠٠ يبلغه؛ و٠١:٥٩ يبلغ الأمس و٠٢:٠٠ لا
  setClock('2026-11-05T21:59');
  assert.equal(await repStatus({ rules: next }, [carton(9)], { pricingDay: '2026-11-06' }), 403);
  setClock('2026-11-05T22:00');
  assert.equal(await repStatus({ rules: next }, [carton(9)], { pricingDay: '2026-11-06' }), 201);
  const endedTwoAm = [rule({ id: 'R-5', scope: 'all', percent: 10, startsOn: '2026-11-05', endsOn: '2026-11-05' })];
  setClock('2026-11-06T01:59');
  assert.equal(await repStatus({ rules: endedTwoAm }, [carton(9)], { pricingDay: '2026-11-05' }), 201);
  setClock('2026-11-06T02:00');
  assert.equal(await repStatus({ rules: endedTwoAm }, [carton(9)], { pricingDay: '2026-11-05' }), 403);
});

test('D1: يوم جهازٍ على بعد يومين فأكثر أو تالفٍ أو بغير نوعه يُهمل بصمت (لا 400)، ويومٌ يساوي يوم الخادم مرشّحٌ واحد كما كان', async () => {
  const twoAgo = [rule({ id: 'R-2', scope: 'all', percent: 10, startsOn: dayAt(-2), endsOn: dayAt(-2) })];
  assert.equal(await repStatus({ rules: twoAgo }, [carton(9)], { pricingDay: dayAt(-2) }), 403, 'قبل يومين');
  assert.equal(await repStatus({ rules: twoAgo }, [carton(10)], { pricingDay: dayAt(-2) }), 201);
  const inTwo = [rule({ id: 'R+2', scope: 'all', percent: 10, startsOn: dayAt(2) })];
  assert.equal(await repStatus({ rules: inTwo }, [carton(9)], { pricingDay: dayAt(2) }), 403, 'بعد يومين');
  const yesterday = [rule({ id: 'R-y', scope: 'all', percent: 10, startsOn: dayAt(-1), endsOn: dayAt(-1) })];
  for (const pricingDay of ['غداً', '2026-13-01', `${dayAt(-1)}T00:00:00Z`, 20261105, { d: 1 }, '', null, 'x'.repeat(60)]) {
    assert.equal(await repStatus({ rules: yesterday }, [carton(10)], { pricingDay }), 201, JSON.stringify(pricingDay));
    assert.equal(await repStatus({ rules: yesterday }, [carton(9)], { pricingDay }), 403, JSON.stringify(pricingDay));
  }
  // يوم الجهاز = يوم الخادم: كما كان حرفياً
  const today = [rule({ id: 'R-d0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })];
  assert.equal(await repStatus({ rules: today }, [carton(9)], { pricingDay: dayAt(0) }), 201);
  assert.equal(await repStatus({ rules: today }, [carton(10)], { pricingDay: dayAt(0) }), 403);
  assert.equal(await repStatus({ rules: today }, [carton(8.5)], { pricingDay: dayAt(0) }), 403);
});

test('D1: في إعادة الرفع تُقاس النافذة من لحظة الجهاز لا من لحظة المزامنة — ٠٠:٣٠ على الجهاز يقبل أمسه و٢٣:٣٠ غده، وظهراً لا', async () => {
  // باع ٠٠:٣٠ قبل يومين (لحظة الجهاز) وسعّر بيوم أمسها (سلّةٌ قبل منتصف الليل): ضمن ساعتين من لحظته
  const threeAgo = [rule({ id: 'R-3', scope: 'all', percent: 10, startsOn: dayAt(-3), endsOn: dayAt(-3) })];
  const body = { clientCreatedAt: riyadhIso(2, '00:30'), pricingDay: dayAt(-3) };
  assert.equal(await repStatus({ rules: threeAgo }, [carton(9)], body, REPLAY), 201);
  assert.equal(await repStatus({ rules: threeAgo }, [carton(9)], { clientCreatedAt: body.clientCreatedAt }, REPLAY), 403, 'بلا يوم الجهاز');
  assert.equal(await repStatus({ rules: threeAgo }, [carton(9)], { pricingDay: dayAt(-3) }), 403, 'والحيّ: أيامٌ عن لحظة الخادم');
  // والبيع نفسه ظهراً على الجهاز: يوم الجهاز المخالف يُهمل
  const noon = { clientCreatedAt: riyadhIso(2, '12:00'), pricingDay: dayAt(-3) };
  assert.equal(await repStatus({ rules: threeAgo }, [carton(9)], noon, REPLAY), 403, 'ظهراً على الجهاز');
  assert.equal(await repStatus({ rules: threeAgo }, [carton(10)], noon, REPLAY), 201);
  // والمرآة: ٢٣:٣٠ على الجهاز يقبل يوم غده، وظهراً لا
  const twoAgo = [rule({ id: 'R-2', scope: 'all', percent: 10, startsOn: dayAt(-2), endsOn: dayAt(-2) })];
  assert.equal(await repStatus({ rules: twoAgo }, [carton(9)], { clientCreatedAt: riyadhIso(3, '23:30'), pricingDay: dayAt(-2) }, REPLAY), 201);
  assert.equal(await repStatus({ rules: twoAgo }, [carton(9)], { clientCreatedAt: riyadhIso(3, '12:00'), pricingDay: dayAt(-2) }, REPLAY), 403);
});

test('D1: «تغيير السعر» بلا «البيع بأقل» — الأرضية أدنى المرجعين عند منتصف الليل والسقف لا يُحرس، وظهراً أرضية يوم الخادم وحده', async (t) => {
  const setClock = fixClock(t, '2026-11-06T00:30');
  const canChange = { canChangePrice: true, canSellBelowPrice: false };
  const ended = [rule({ id: 'R-y', scope: 'all', percent: 10, startsOn: '2026-11-05', endsOn: '2026-11-05' })];
  const run = async (price: number, extra: Record<string, unknown>) => {
    reset(REP_USER);
    world({ rules: ended, rep: canChange });
    return post(sale([carton(price)], extra));
  };
  assert.equal((await run(9, { pricingDay: '2026-11-05' })).status, 201);
  assert.equal((await run(12, { pricingDay: '2026-11-05' })).status, 201);
  const below = await run(8.5, { pricingDay: '2026-11-05' });
  assert.equal(below.status, 403);
  assert.equal(below.body.message, 'لا تملك صلاحية البيع بأقل من السعر المحدد');
  assert.equal((await run(9, {})).status, 403, 'بلا يوم الجهاز: الأرضية سعر اليوم العامّ');
  // ظهراً (العرض أمسُ الشركة): يوم الجهاز يُهمل والأرضية سعر اليوم العامّ
  setClock('2026-11-06T12:00');
  assert.equal((await run(9, { pricingDay: '2026-11-05' })).status, 403);
  assert.equal((await run(10, { pricingDay: '2026-11-05' })).status, 201);
});

test('D1: سقف المرتجع الحرّ أعلى المرجعين — زيادةٌ سرت يوم الجهاز (٠٠:٣٠، أمسُ الشركة) ترفع السقف، وظهراً لا', async (t) => {
  const setClock = fixClock(t, '2026-11-06T00:30');
  const run = async (unitPrice: number, extra: Record<string, unknown>) => {
    reset(REP_USER);
    world({
      rules: [rule({ id: 'R-up', scope: 'all', percent: -20, startsOn: '2026-11-05', endsOn: '2026-11-05' })],
      company: { zatcaPhase2StartedAt: new Date('2026-10-02T00:00:00Z'), returnRequiresSaleInvoice: false },
    });
    const r = await post(sale([carton(unitPrice)], { type: 'RETURN', returnReason: 'NORMAL', originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'إرجاع', ...extra }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return noteCtx[0].manualReturn.repPriceProblem;
  };
  assert.equal(await run(11.5, { pricingDay: '2026-11-05' }), null, 'سقفٌ ١٢ بزيادة يوم الجهاز');
  assert.equal(await run(12.5, { pricingDay: '2026-11-05' }), CHANGE);
  assert.equal(await run(11.5, {}), CHANGE, 'بلا يوم الجهاز: السقف ١٠');
  setClock('2026-11-06T12:00');
  assert.equal(await run(11.5, { pricingDay: '2026-11-05' }), CHANGE, 'ظهراً: السقف ١٠');
});

// ═══ (٤-ج) قواعد كُتبت أثناء انقطاع المندوب (CONTRACT2 D3) ═══

test('D3: قاعدةٌ كُتبت بعد لحظة الجهاز لا تُرفض بها إعادة الرفع (مرشّحٌ بقواعد الجهاز) — والحيّ يُحرس بها، وما عرفه الجهاز مرشّحٌ واحد', async () => {
  const fresh = [rule({ id: 'R-new', scope: 'all', percent: 10, updatedAt: new Date(Date.now() - DAY_MS) })];
  const body = { clientCreatedAt: isoAt(-2) };
  // الجهاز لم يعرف الخصم: باع بالسعر العامّ ١٠ ⇒ يُقبل، والخصم ٩ كذلك (النطاق)، وما خارجهما يُرفض
  assert.equal(await repStatus({ rules: fresh }, [carton(10)], body, REPLAY), 201);
  assert.equal(await repStatus({ rules: fresh }, [carton(9)], body, REPLAY), 201);
  assert.equal(await repStatus({ rules: fresh }, [carton(10.5)], body, REPLAY), 403);
  assert.equal(await repStatus({ rules: fresh }, [carton(8.5)], body, REPLAY), 403);
  // والحيّ: القاعدة تحرسه
  assert.equal(await repStatus({ rules: fresh }, [carton(10)], body), 403);
  // إعادة رفعٍ بعد كتابتها بلا لحظة جلب الكاش (pricesSeenAt): يُفترض أن الجهاز عرفها ⇒ مرشّحٌ واحد كما كان؛ وجلبٌ قبلها (التحقّق L2.2)
  // يعني أنه لم يرها ⇒ مرشّح قواعد الجهاز
  assert.equal(await repStatus({ rules: fresh }, [carton(10)], { clientCreatedAt: isoAt(-0.5) }, REPLAY), 403);
  assert.equal(await repStatus({ rules: fresh }, [carton(10)], { clientCreatedAt: isoAt(-0.5), pricesSeenAt: isoAt(-2) }, REPLAY), 201);
  // ولا لحظة جهاز (تالفة، أو أقدم من ثلاثين يوماً، أو في المستقبل) ⇒ القواعد الحالية وحدها
  for (const clientCreatedAt of ['غداً', isoAt(-40), isoAt(1)]) {
    assert.equal(await repStatus({ rules: fresh }, [carton(10)], { clientCreatedAt }, REPLAY), 403, clientCreatedAt);
  }
  // زيادةٌ كُتبت بعد لحظة الجهاز: السعر العامّ يُقبل في الإعادة، والحيّ بها
  const up = [rule({ id: 'R-up', scope: 'all', percent: -20, updatedAt: new Date(Date.now() - DAY_MS) })];
  assert.equal(await repStatus({ rules: up }, [carton(10)], body, REPLAY), 201);
  assert.equal(await repStatus({ rules: up }, [carton(12)], body, REPLAY), 201);
  assert.equal(await repStatus({ rules: up }, [carton(10)], body), 403);
  // وقاعدةٌ جديدة فوق سعرٍ ثابتٍ في القائمة عرفه الجهاز: الثابت (٨) أو القاعدة (٧)
  const fix7 = [rule({ id: 'R-7', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 7 / 24, updatedAt: new Date(Date.now() - DAY_MS) })];
  assert.equal(await repStatus({ rules: fix7, items: { p1: 8 / 24 } }, [carton(8)], body, REPLAY), 201);
  assert.equal(await repStatus({ rules: fix7, items: { p1: 8 / 24 } }, [carton(8)], body), 403);
  // ومع قاعدةٍ قديمة يعرفها الجهاز: تبقى في مرشّحه (خصمٌ قديم ١٠٪ وزيادةٌ جديدة لم يعرفها)
  const mixed = [rule({ id: 'R-old', scope: 'all', percent: 10 }), rule({ id: 'R-cat', scope: 'category', categoryId: 'cat-juice', percent: -20, updatedAt: new Date(Date.now() - DAY_MS) })];
  assert.equal(await repStatus({ rules: mixed }, [carton(9)], body, REPLAY), 201, 'قواعد الجهاز: الخصم القديم');
  assert.equal(await repStatus({ rules: mixed }, [carton(10)], body, REPLAY), 201, 'ضمن النطاق ٩–١٢');
  assert.equal(await repStatus({ rules: mixed }, [carton(8.5)], body, REPLAY), 403);
  assert.equal(await repStatus({ rules: mixed }, [carton(9)], body), 403, 'الحيّ: الفئة الجديدة ١٢');
});

test('D1×D3: يوم الجهاز وقواعده معاً — أربعة مرشّحين، والنطاق أعلاها وأدناها', async () => {
  // عرضٌ كُتب بعد لحظة الجهاز ويسري يوم الجهاز وحده (أمسَ لحظته)، وزيادةٌ قديمة تسري يوم الخادم وحده
  const rules = [
    rule({ id: 'R-new', scope: 'all', percent: 50, startsOn: dayAt(-3), endsOn: dayAt(-3), updatedAt: new Date(Date.now() - DAY_MS) }),
    rule({ id: 'R-up', scope: 'all', percent: -20, startsOn: dayAt(-2), endsOn: dayAt(-2) }),
  ];
  const body = { clientCreatedAt: riyadhIso(2, '00:30'), pricingDay: dayAt(-3) };
  // المراجع: (كل القواعد، يوم اللحظة) ١٢ · (كل القواعد، يوم الجهاز) ٥ · (قواعد الجهاز، يوم اللحظة) ١٢ · (قواعد الجهاز، يوم الجهاز) ١٠
  for (const [price, status] of [[5, 201], [10, 201], [12, 201], [4.5, 403], [12.5, 403]] as const) {
    assert.equal(await repStatus({ rules }, [carton(price)], body, REPLAY), status, String(price));
  }
  // وبلا يوم الجهاز: (كل القواعد/قواعد الجهاز، يوم اللحظة) ١٢ ⇒ ١٢ وحده
  assert.equal(await repStatus({ rules }, [carton(10)], { clientCreatedAt: body.clientCreatedAt }, REPLAY), 403);
  assert.equal(await repStatus({ rules }, [carton(12)], { clientCreatedAt: body.clientCreatedAt }, REPLAY), 201);
  // وظهراً على الجهاز: يوم الجهاز يُهمل ⇒ ١٢ وحده كذلك
  const noon = { clientCreatedAt: riyadhIso(2, '12:00'), pricingDay: dayAt(-3) };
  assert.equal(await repStatus({ rules }, [carton(5)], noon, REPLAY), 403);
  assert.equal(await repStatus({ rules }, [carton(12)], noon, REPLAY), 201);
});

// ═══ (٤-د) قاعدةٌ كُتبت بين جلب الكاش والبيع (التحقّق L2.2: body.pricesSeenAt) ═══

test('L2.2: قاعدةٌ كُتبت بعد جلب الجهاز كاش الأسعار وقبل بيعه لا تُرفض بها إعادة الرفع (pricesSeenAt) — وبلاه كما كان، والمزوّرة والحيّ يُهملانه', async () => {
  const H = 3_600_000;
  const ago = (h: number): string => new Date(Date.now() - h * H).toISOString();
  // المزامنة الآن (١٤:٠٠)، وخصم الفئة ١٠٪ كُتب ١٠:٠٠ (−٤س)، والكاش جُلب ٠٨:٠٠ (−٦س)، والبيعان ٠٩:٠٠ (−٥س) و١١:٠٠ (−٣س) بالسعر الكامل ١٠
  const cat10 = [rule({ id: 'R-cat', scope: 'category', categoryId: 'cat-juice', percent: 10, updatedAt: new Date(Date.now() - 4 * H) })];
  const seen = { pricesSeenAt: ago(6) };
  const at9 = { clientCreatedAt: ago(5) };
  const at11 = { clientCreatedAt: ago(3) };
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { ...at9, ...seen }, REPLAY), 201, '٠٩:٠٠');
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { ...at11, ...seen }, REPLAY), 201, '١١:٠٠ — الجهاز لم يرَ القاعدة');
  // بلا pricesSeenAt كما كان: ٠٩:٠٠ يُقبل (القاعدة بعد البيع) و١١:٠٠ يُرفض (يُفترض أن الجهاز عرفها)
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], at9, REPLAY), 201);
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], at11, REPLAY), 403);
  // النطاق: الخصم ٩ (القواعد الحالية) والكامل ١٠ (قواعد الجهاز)، وما خارجهما يُرفض
  assert.equal(await repStatus({ rules: cat10 }, [carton(9)], { ...at11, ...seen }, REPLAY), 201);
  assert.equal(await repStatus({ rules: cat10 }, [carton(8.5)], { ...at11, ...seen }, REPLAY), 403);
  assert.equal(await repStatus({ rules: cat10 }, [carton(10.5)], { ...at11, ...seen }, REPLAY), 403);
  // جلبٌ بعد القاعدة (١٠:٣٠): عرفها ⇒ مرشّحٌ واحد كما كان
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { ...at11, pricesSeenAt: ago(3.5) }, REPLAY), 403);
  // جلبٌ «بعد» البيع (١٢:٠٠) لا يكون ⇒ يُهمل ويبقى حدّ الإصدار
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { ...at11, pricesSeenAt: ago(2) }, REPLAY), 403);
  // مزوّرةٌ أقدم من البيع بأكثر من ثلاثين يوماً ⇒ تُهمل، وضمن الثلاثين تُقبل
  const sold = Date.now() - 3 * H;
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { ...at11, pricesSeenAt: new Date(sold - 30 * DAY_MS - 60_000).toISOString() }, REPLAY), 403, 'أقدم من ثلاثين يوماً');
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { ...at11, pricesSeenAt: new Date(sold - 29 * DAY_MS).toISOString() }, REPLAY), 201);
  // الحيّ لا يقرؤها
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], seen), 403, 'الحيّ');
  // تالفةٌ أو بغير نوعها: لا 400 أبداً، وكأنها غائبة
  for (const pricesSeenAt of ['x', '2026-11-05', ago(6).slice(0, 19), 1_730_000_000_000, { a: 1 }, 'x'.repeat(80), null]) {
    assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { ...at11, pricesSeenAt }, REPLAY), 403, JSON.stringify(pricesSeenAt));
    assert.equal(await repStatus({ rules: cat10 }, [carton(9)], { ...at11, pricesSeenAt }, REPLAY), 201, JSON.stringify(pricesSeenAt));
  }
  // ساعة الجهاز متأخّرة ساعتين (X-FS-Device-Now): لحظتا الإصدار والجلب على ساعته تُصحَّحان بالفرق نفسه
  const behind = { ...REPLAY, 'x-fs-device-now': String(Date.now() - 2 * H) };
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { clientCreatedAt: ago(5), pricesSeenAt: ago(8) }, behind), 201);
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { clientCreatedAt: ago(5) }, behind), 403, 'بلا الجلب');
  // ومتقدّمة ساعتين: جلبٌ «١١:٣٠» على ساعته = ٠٩:٣٠ قبل القاعدة — بلا تصحيحه لبدا بعد الإصدار (١١:٠٠) فأُهمل
  const ahead = { ...REPLAY, 'x-fs-device-now': String(Date.now() + 2 * H) };
  assert.equal(await repStatus({ rules: cat10 }, [carton(10)], { clientCreatedAt: ago(1), pricesSeenAt: ago(2.5) }, ahead), 201);
});

// ═══ (٥) الأولوية ═══

test('سعر العميل الخاص يغلب القائمة وقواعدها: الكرتون له بتسعة ولو خصمت القائمة النصف', async () => {
  const cps = [{ productId: 'p1', price: 9 / 24 }];
  const rules = [rule({ id: 'R-50', scope: 'all', percent: 50 }), rule({ id: 'R-fix', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 4 / 24 })];
  assert.equal(await repStatus({ rules, cps, items: { p1: 8 / 24 } }, [carton(9)]), 201);
  assert.equal(await repStatus({ rules, cps, items: { p1: 8 / 24 } }, [carton(5)]), 403);
  assert.equal(await repStatus({ rules, cps, items: { p1: 8 / 24 } }, [piece(0.375)]), 201);
});

test('السعر الثابت في القائمة مقابل القواعد: قاعدة صنفٍ بلا شرط تغلبه، وبحدٍّ لم يتحقّق لا، والفئة وكل الأصناف دونه', async () => {
  const items = { p1: 8 / 24 };
  // بلا قواعد: السعر الثابت كاليوم حرفياً
  assert.equal(await repStatus({ items }, [carton(8)]), 201);
  assert.equal(await repStatus({ items }, [carton(10)]), 403);
  // قاعدة صنفٍ ثابتة بلا حدٍّ ولا فترة: المكتوبة تغلب السعر الثابت عند التساوي
  const fix7 = rule({ id: 'R-7', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 7 / 24 });
  assert.equal(await repStatus({ items, rules: [fix7] }, [carton(7)]), 201);
  assert.equal(await repStatus({ items, rules: [fix7] }, [carton(8)]), 403);
  // بحدّ خمسة كراتين لم يتحقّق: السعر الثابت
  const fix7q5 = rule({ ...fix7, minQty: 5 });
  assert.equal(await repStatus({ items, rules: [fix7q5] }, [carton(8)]), 201);
  assert.equal(await repStatus({ items, rules: [fix7q5] }, [carton(7)]), 403);
  assert.equal(await repStatus({ items, rules: [fix7q5] }, [carton(7, 5)]), 201, 'تحقّق الحدّ');
  // الفئة وكل الأصناف أعمّ من سعر الصنف الثابت
  const cat6 = rule({ id: 'R-c', scope: 'category', categoryId: 'cat-juice', kind: 'fixed', primaryPrice: 6 });
  const all50 = rule({ id: 'R-a', scope: 'all', percent: 50 });
  assert.equal(await repStatus({ items, rules: [cat6, all50] }, [carton(8)]), 201);
  assert.equal(await repStatus({ items, rules: [cat6, all50] }, [carton(6)]), 403);
  // والعرض المؤقّت للصنف يغلب الدائم
  const promo = rule({ id: 'R-pr', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 6.5 / 24, startsOn: dayAt(-1), endsOn: dayAt(1) });
  assert.equal(await repStatus({ items, rules: [fix7, promo] }, [carton(6.5)]), 201);
  assert.equal(await repStatus({ items, rules: [fix7, promo] }, [carton(7)]), 403);
});

// ═══ (٦) الإدارة ومفتاح API ═══

test('الإدارة ومفتاح API أحرار: قواعد القائمة لا تحرسهم، والمستند يُختم بالقائمة — ولا استعلام قواعد ولا منطقة (D5)', async () => {
  for (const user of [ADMIN, API_KEY]) {
    // خط الأساس: الشخص نفسه بلا قائمة (ما يقرؤه المسار من منطقةٍ لغير القائمة)
    reset(user);
    world({ customer: { priceListId: null } });
    assert.equal((await post(sale([carton(10)]))).status, 201);
    const baseTz = tzReads();
    for (const price of [3, 9, 20]) {
      reset(user);
      // قاعدةٌ بفترة ويوم جهاز: لا شيء منهما يُقرأ للإدارة والمفتاح
      const w = world({ rules: [rule({ id: 'R-all', scope: 'all', percent: 10 }), rule({ id: 'R-d', scope: 'all', percent: 20, startsOn: dayAt(-1), endsOn: dayAt(1) })] });
      const r = await post(sale([carton(price)], { pricingDay: dayAt(-1) }));
      assert.equal(r.status, 201, `${user.apiKeyId ?? 'admin'} ${price}: ${JSON.stringify(r.body)}`);
      assert.equal(w.created[0].priceListId, 'L1');
      assert.equal(w.ruleQueries.length, 0, 'لا استعلام قواعد للإدارة ولا للمفتاح');
      assert.equal(calls.includes('priceListRule.findMany'), false);
      assert.equal(tzReads(), baseTz, 'ولا منطقة');
      // واستعلام السعر الثابت كما كان حرفياً
      assert.deepEqual(w.itemQueries, [{ where: { tenantId: TENANT, priceListId: 'L1', productId: { in: ['p1'] } }, select: { productId: true, price: true } }]);
    }
  }
  // إعادة رفعٍ بجلسة الإدارة (لا مفتاح): إشارة سعر إعادة الرفع تقرأ القواعد كما كان
  reset(ADMIN);
  const replayed = world({ rules: [rule({ id: 'R-all', scope: 'all', percent: 10 })] });
  assert.equal((await post(sale([carton(9)]), REPLAY)).status, 201);
  assert.equal(replayed.ruleQueries.length, 1);
});

// ═══ (٧) صفر كلفة ═══

test('بلا قائمةٍ لا استعلام قواعد ولا أسعار ولا منطقة، وبقواعد بلا فترة استعلام قواعد واحد بلا منطقة، وبفترةٍ قراءة منطقة واحدة', async () => {
  // عميلٌ بلا قائمة ومندوبٌ بلا افتراضية: مسار اليوم حرفياً
  reset(REP_USER);
  const none = world({ customer: { priceListId: null } });
  assert.equal((await post(sale([carton(10)]))).status, 201);
  assert.deepEqual(calls.filter((c) => c.startsWith('priceList')), []);
  assert.equal(none.ruleQueries.length, 0);
  assert.equal('priceListId' in none.created[0], false);
  const baseTz = tzReads();
  // قائمةٌ بقواعد بلا فترة: استعلام قواعد واحد، ولا قراءة منطقةٍ زائدة
  reset(REP_USER);
  const undated = world({ rules: [rule({ id: 'R-all', scope: 'all', percent: 10, minQty: 1 })] });
  assert.equal((await post(sale([carton(9)]))).status, 201);
  assert.equal(undated.ruleQueries.length, 1);
  assert.equal(calls.filter((c) => c === 'priceListRule.findMany').length, 1);
  assert.equal(tzReads(), baseTz, 'لا منطقة بلا قاعدةٍ بفترة');
  // وقائمةٌ بلا قواعد أصلاً: كذلك
  reset(REP_USER);
  world({ items: { p1: 8 / 24 } });
  assert.equal((await post(sale([carton(8)]))).status, 201);
  assert.equal(tzReads(), baseTz);
  // وقاعدةٌ بفترة: قراءة منطقةٍ واحدة
  reset(REP_USER);
  world({ rules: [rule({ id: 'R-d', scope: 'all', percent: 10, startsOn: dayAt(-1), endsOn: dayAt(1) })] });
  assert.equal((await post(sale([carton(9)]))).status, 201);
  assert.equal(tzReads(), baseTz + 1);
  // وقاعدةٌ بفترة لصنفٍ آخر لا تصل (الاستعلام مضيَّق) ⇒ بلا منطقة
  reset(REP_USER);
  world({ rules: [rule({ id: 'R-o', scope: 'product', productId: 'p-other', percent: 10, startsOn: dayAt(-1) })] });
  assert.equal((await post(sale([carton(10)]))).status, 201);
  assert.equal(tzReads(), baseTz);
  // ويوم الجهاز (pricingDay) بلا قاعدةٍ بفترة: لا منطقة ولا مرشّح — وبلا قائمةٍ لا شيء
  reset(REP_USER);
  world({ rules: [rule({ id: 'R-all', scope: 'all', percent: 10 })] });
  assert.equal((await post(sale([carton(9)], { pricingDay: dayAt(-1) }))).status, 201);
  assert.equal(tzReads(), baseTz);
  reset(REP_USER);
  world({ customer: { priceListId: null } });
  assert.equal((await post(sale([carton(10)], { pricingDay: dayAt(-1) }), REPLAY)).status, 201);
  assert.deepEqual(calls.filter((c) => c.startsWith('priceList')), []);
  assert.equal(tzReads(), baseTz);
  // وبقاعدةٍ بفترة: قراءة منطقةٍ واحدة ولو حضر يوم الجهاز ولحظته وقاعدةٌ لم يعرفها (المرشّحون من القراءة نفسها) — فوق ما تقرؤه
  // إعادة الرفع نفسها بلا قائمة (منطقة رقم المستند المؤرَّخ بلحظة الجهاز: numTz، كما كانت)
  const replayBody = { pricingDay: dayAt(-2), clientCreatedAt: isoAt(-1), pricesSeenAt: isoAt(-1.5) };
  reset(REP_USER);
  world({ customer: { priceListId: null } });
  assert.equal((await post(sale([carton(10)], replayBody), REPLAY)).status, 201);
  const replayTz = tzReads();
  reset(REP_USER);
  world({ rules: [rule({ id: 'R-d', scope: 'all', percent: 10, startsOn: dayAt(-3), endsOn: dayAt(1) }), rule({ id: 'R-new', scope: 'all', percent: 5, updatedAt: new Date() })] });
  assert.equal((await post(sale([carton(9)], replayBody), REPLAY)).status, 201);
  assert.equal(tzReads(), replayTz + 1);
  assert.equal(calls.filter((c) => c === 'priceListRule.findMany').length, 1);
});

// ═══ (٨) سقف المرتجع الحرّ وإشارة سعر إعادة الرفع ═══

test('سقف المرتجع الحرّ (إشعارٌ دائن برقمٍ يدويّ، المرحلة الثانية) بالمرجع نفسه: خصم القائمة ١٠٪ ⇒ ٩٫٥ فوقه و٩ عنده', async () => {
  const run = async (unitPrice: number) => {
    reset(REP_USER);
    world({
      rules: [rule({ id: 'R-all', scope: 'all', percent: 10 })],
      company: { zatcaPhase2StartedAt: new Date('2026-10-02T00:00:00Z'), returnRequiresSaleInvoice: false },
    });
    const r = await post(sale([carton(unitPrice)], { type: 'RETURN', returnReason: 'NORMAL', originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'إرجاع' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(noteCtx.length, 1);
    return noteCtx[0].manualReturn.repPriceProblem;
  };
  assert.equal(await run(9.5), CHANGE);
  assert.equal(await run(9), null);
});

test('إشارة سعر إعادة الرفع بعد تحويل الأساس (جسمٌ بلا لقطة): تلميح القائمة (زيادة ١٠٠٪) يلتقط الكرتون — وبلا قاعدةٍ تحكم الساعة', async () => {
  /** مياهٌ كان أساسها كرتوناً (٤٨) ثم حُوّلت إلى قارورة (٢) */
  const T_CONV = new Date(Date.now() - 10 * DAY_MS);
  const water = {
    ...PRODUCT_BASE, id: 'p1', name: 'مياه', unit: 'قارورة', basePrice: 2, taxPct: 0, categoryId: null,
    units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 48, unitCode: 'CT', isActive: true }], primaryUnitId: null, baseConvertedAt: T_CONV,
  };
  const run = async (rules: Rule[]) => {
    reset(REP_USER);
    const w = world({ rules, products: [water], rep: { canChangePrice: true, canSellBelowPrice: true } });
    scripted['productBaseConversion.findMany'] = () => [{ productId: 'p1', fromUnit: 'كرتون', toUnit: 'قارورة', factor: 24, fromUnitId: 'u-ct', convertedAt: T_CONV }];
    const r = await post(sale([['p1', null, 2, 96]], { clientRef: '33333333-3333-4333-8333-333333333333', clientCreatedAt: isoAt(-1) }), REPLAY);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const it = w.created[0].items.create[0];
    return [it.unitFactor, it.baseQty];
  };
  assert.deepEqual(await run([rule({ id: 'R-x2', scope: 'all', percent: -100 })]), [24, 48], 'القارورة ٤ بالزيادة ⇒ الكرتون ٩٦');
  assert.deepEqual(await run([]), [1, 2], 'بلا قاعدة: ٩٦ بعيدٌ عن ٤٨ وعن ٢ ⇒ الساعة (بعد التحويل)');
  // D3: الإشارة بما رآه الجهاز — زيادةٌ كُتبت بعد لحظة إصداره لم تصله فلا تلتقط بها الوحدة
  assert.deepEqual(await run([rule({ id: 'R-x2', scope: 'all', percent: -100, updatedAt: new Date() })]), [1, 2], 'قاعدةٌ بعد لحظة الجهاز ⇒ الساعة');
});
