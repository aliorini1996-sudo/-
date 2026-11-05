// «قوائم الأسعار» بقواعد Odoo (طلب المالك، ٥ نوفمبر ٢٠٢٦) — حارس سعر المندوب في POST /api/invoices بالحلّ المشترك
// (services/priceRules.ts): معالجٌ حقيقيّ فوق Prisma مزيّف (بلا قاعدة بيانات). يثبت:
//   • النسبة (خصمٌ أو زيادة) من «سعر البند بلا قائمة»، والسعر الثابت للفئة (بالرئيسية ÷ معاملها لوحدة الأساس) لبند الكرتون والحبّة،
//     والحدّ الأدنى للكمية بمجموع بنود الصنف كلّها بكل وحداتها، وسعر العميل الخاص يغلب القائمة، وأولوية السعر الثابت في القائمة
//     مقابل القواعد — للمندوب بلا «تغيير السعر»، والإدارة ومفتاح API أحرار.
//   • يوم التسعير: الحيّ بيوم الخادم، وإعادة رفع الصندوق بلحظة الجهاز (عرضٌ سرى لحظة البيع ثم انتهى يُقبل)، ولحظةٌ أقدم من سبعة
//     أيام أو في المستقبل ⇒ ساعة الخادم، وتاريخ الجسم لا يُقرأ أبداً.
//   • صفر كلفة: بلا قائمةٍ لا استعلام قواعد، وبلا قاعدةٍ بفترة لا استعلام منطقة. وسقف المرتجع الحرّ بالمرجع نفسه، وإشارة سعر
//     إعادة الرفع (تخمين وحدة جسمٍ بلا لقطة بعد تحويل الأساس) بتلميح القائمة.
import { after, test } from 'node:test';
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
const rule = (o: Partial<Rule> & { id: string; scope: string }): Rule => ({
  productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: null, minQty: 0, startsOn: null, endsOn: null,
  updatedAt: new Date('2026-11-01T00:00:00Z'), ...o,
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
async function repStatus(w: { rules?: Rule[]; items?: Record<string, number>; products?: any[]; cps?: { productId: string; price: number }[] }, lines: Line[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<number> {
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

test('لحظة جهازٍ أقدم من سبعة أيام أو في المستقبل ⇒ ساعة الخادم: عرض يومها لا يسري، وعرض اليوم يسري', async () => {
  const old = { clientCreatedAt: isoAt(-8) };
  assert.equal(await repStatus({ rules: [rule({ id: 'R-8', scope: 'all', percent: 10, startsOn: dayAt(-8), endsOn: dayAt(-8) })] }, [carton(9)], old, REPLAY), 403);
  assert.equal(await repStatus({ rules: [rule({ id: 'R-0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })] }, [carton(9)], old, REPLAY), 201);
  const ahead = { clientCreatedAt: isoAt(2) };
  assert.equal(await repStatus({ rules: [rule({ id: 'R+2', scope: 'all', percent: 10, startsOn: dayAt(2), endsOn: dayAt(2) })] }, [carton(9)], ahead, REPLAY), 403);
  assert.equal(await repStatus({ rules: [rule({ id: 'R-0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })] }, [carton(9)], ahead, REPLAY), 201);
  // ولحظةٌ تالفة كذلك
  assert.equal(await repStatus({ rules: [rule({ id: 'R-0', scope: 'all', percent: 10, startsOn: dayAt(0), endsOn: dayAt(0) })] }, [carton(9)], { clientCreatedAt: 'غداً' }, REPLAY), 201);
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

test('الإدارة ومفتاح API أحرار: قواعد القائمة لا تحرسهم، والمستند يُختم بالقائمة', async () => {
  for (const user of [ADMIN, API_KEY]) {
    for (const price of [3, 9, 20]) {
      reset(user);
      const w = world({ rules: [rule({ id: 'R-all', scope: 'all', percent: 10 })] });
      const r = await post(sale([carton(price)]));
      assert.equal(r.status, 201, `${user.apiKeyId ?? 'admin'} ${price}: ${JSON.stringify(r.body)}`);
      assert.equal(w.created[0].priceListId, 'L1');
    }
  }
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
});
