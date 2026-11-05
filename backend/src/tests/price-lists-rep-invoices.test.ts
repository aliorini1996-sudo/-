// «نوع سعر المندوب» (طلب المالك، ٢ نوفمبر ٢٠٢٦) — المرحلة الثانية من «أنواع الأسعار» في POST /api/invoices: معالجٌ حقيقيّ فوق Prisma
// مزيّف (بلا قاعدة بيانات). يثبت:
//   • افتراضيّ المستند = نوع العميل ?? النوع الافتراضي لمندوب المستند ?? السعر الأساسي — للمندوب وللإدارة ومفتاح API (مندوب salesRepId)،
//     ومرجع حارس السعر بسعره، والختم به، وصفّ المندوب المقروء أصلاً يحمل العمودين (لا استعلام جديد، وبلا أنواعٍ لا استعلام أنواع).
//   • المندوب بلا «تبديل نوع السعر» لا يرسل غير الافتراضيّ (403 PRICE_LIST_FORBIDDEN)، وبها يبدّل ضمن أنواعه المسموحة وحدها
//     (allowedPriceTypes: null = كل الأنواع، 'base' = السعر الأساسي)، ونوع العميل نفسه مسموحٌ دائماً، ونوع شركةٍ أخرى 400.
//   • الإدارة ومفتاح API أحرار من قيد الأنواع المسموحة.
//   • إعادة رفع الصندوق (X-FS-Replay) بنوعٍ حُذف أو صلاحيةٍ/نوعٍ نُزعا ⇒ الافتراضيّ الجديد (لا نوع العميل وحده) ولا يُعدم المستند.
//   • المرتجع الحرّ والمرتبط كاليوم بالقاعدة الجديدة، والمرحلة الثانية (فاتورةً وإشعاراً يدوياً) تتسلّم النوع المحسوم نفسه.
//   • «قوائم الأسعار» (٥ نوفمبر ٢٠٢٦): رسائل الرفض بالاسم الجديد، وقواعد القائمة تُقرأ للقائمة المحسومة نفسها وحدها
//     (حارس القواعد نفسه في price-rules-invoices.test.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  BASE_PRICE_TYPE, PRICE_LIST_MESSAGES, PRICE_TYPE_NOT_ALLOWED_REASON, allowedPriceTypesOf, defaultPriceTypeOf, priceTypeAllowed,
  switchablePriceTypesOf,
} from '../services/priceLists';

// ═══ حقن البدائل قبل تحميل الموجّه (نمط price-lists.test.ts) ═══

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
let inTx = false;
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
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async () => { calls.push(key); return key === '$queryRaw' ? [] : 0; };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});
void inTx;

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
// المرحلة الثانية: يُلتقط السياق الذي يسلّمه routes/invoices.ts للنواة (هي تختم ctx.priceListId — invoicesZatca.ts) بدل الإصدار الحقيقي
let phase2Ctx: any[] = [];
let noteCtx: any[] = [];
override('routes/invoicesZatca', {
  issuePhase2Invoice: async (ctx: unknown) => { phase2Ctx.push(ctx); return { status: 201, body: { success: true, data: { id: 'z-1', number: 'INV-Z1' } } }; },
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
function reset(user: User): void {
  calls = []; inTx = false; scripted = {}; phase2Ctx = []; noteCtx = [];
  currentUser = user;
}
const touched = (prefix: string) => calls.filter(c => c.startsWith(prefix));

/** عميلٌ بلا نوع (افتراضاً) — والمندوب بنوعٍ افتراضيّ «التجزئة» L-R وبلا قيد أنواع */
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
/** أسعار الأنواع لوحدة الأساس: الجملة L-W كرتونها ٨، والتجزئة L-R ١٢ — وL-X لشركةٍ أخرى */
const LIST_PRICES: Record<string, number> = { 'L-W': 8 / 24, 'L-R': 12 / 24 };
const MY_LISTS = new Set(['L-W', 'L-R']);
const PHASE1 = { defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null };

function issueWorld(o: {
  customer?: Partial<typeof CUSTOMER>; rep?: Partial<typeof REP_ROW> | Record<string, unknown>; phase2?: boolean;
  /** «قوائم الأسعار» بقواعدها (٥ نوفمبر ٢٠٢٦): قواعد كل قائمة */
  rules?: Record<string, Record<string, unknown>[]>;
} = {}) {
  const created: any[] = [];
  const itemQueries: any[] = [];
  const ruleQueries: any[] = [];
  const repReads: any[] = [];
  const customer = { ...CUSTOMER, ...o.customer };
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': (args) => { repReads.push(args); return { ...REP_ROW, ...o.rep }; },
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => customer,
    'product.findMany': () => [PRODUCT],
    'customerPrice.findMany': () => [],
    'priceList.count': (args) => (MY_LISTS.has(args?.where?.id) && args?.where?.tenantId === TENANT ? 1 : 0),
    'priceListItem.findMany': (args) => {
      itemQueries.push(args);
      const id = args?.where?.priceListId;
      return args?.where?.tenantId === TENANT && LIST_PRICES[id] != null ? [{ productId: 'p1', price: LIST_PRICES[id] }] : [];
    },
    'priceListRule.findMany': (args) => {
      ruleQueries.push(args);
      return args?.where?.tenantId === TENANT ? (o.rules?.[args?.where?.priceListId] ?? []) : [];
    },
    'companySettings.findUnique': () => (o.phase2 ? { ...PHASE1, zatcaPhase2StartedAt: new Date('2026-10-02T00:00:00Z') } : PHASE1),
    'invoice.create': (args) => { created.push(args.data); return { id: `inv-${created.length}`, ...args.data, items: args.data.items.create, customer }; },
  };
  return { created, itemQueries, ruleQueries, repReads };
}
/** بيع كرتونٍ واحد بسعرٍ صافٍ */
const sellCarton = (unitPrice: number, extra: Record<string, unknown> = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0,
  items: [{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice, discountPct: 0 }], ...extra,
});
/** مرتجعٌ حرّ لكرتونٍ واحد */
const returnCarton = (unitPrice: number, extra: Record<string, unknown> = {}) => sellCarton(unitPrice, { type: 'RETURN', returnReason: 'NORMAL', ...extra });
const stampOf = (row: Record<string, unknown>) => ('priceListId' in row ? row.priceListId : null);

// ═══ (١) القواعد الصرفة (النسخة الخادمية — ومثيلتها في web-admin/src/lib/priceLists.ts تختبرها حزمة الويب) ═══

test('القواعد: الافتراضيّ = نوع العميل ?? نوع المندوب ?? الأساسي، والمسموح من JSON بلا تكرار، والافتراضيّ مسموحٌ دائماً', () => {
  assert.equal(defaultPriceTypeOf('L-W', 'L-R'), 'L-W', 'نوع العميل يغلب نوع المندوب');
  assert.equal(defaultPriceTypeOf(null, 'L-R'), 'L-R');
  assert.equal(defaultPriceTypeOf(undefined, undefined), null);
  assert.equal(defaultPriceTypeOf('', null), null);
  assert.equal(BASE_PRICE_TYPE, 'base');
  assert.equal(allowedPriceTypesOf(null), null, 'null = بلا قيد');
  assert.equal(allowedPriceTypesOf(undefined), null);
  assert.equal(allowedPriceTypesOf({ a: 1 }), null);
  assert.deepEqual(allowedPriceTypesOf(['L-W', 'base', 'L-W', 7, '', 'L-R']), ['L-W', null, 'L-R'], 'الترتيب محفوظ والأساسي null');
  assert.deepEqual(allowedPriceTypesOf([]), [], 'مصفوفةٌ فارغة: لا مسموح إلا الافتراضي');
  assert.equal(priceTypeAllowed('L-W', null, 'L-R'), true);
  assert.equal(priceTypeAllowed('L-W', ['L-R'], 'L-R'), false);
  assert.equal(priceTypeAllowed('L-W', [], 'L-W'), true, 'الافتراضيّ (نوع العميل) مسموحٌ دائماً');
  assert.equal(priceTypeAllowed(null, [null, 'L-R'], 'L-R'), true);
  assert.equal(priceTypeAllowed(null, ['L-R'], 'L-R'), false);
  assert.deepEqual(switchablePriceTypesOf(null, 'L-R', ['L-W', 'L-R']), ['L-R', null, 'L-W']);
  assert.deepEqual(switchablePriceTypesOf(['L-W', 'L-GONE', null], 'L-R', ['L-W', 'L-R']), ['L-R', 'L-W', null], 'المحذوف يسقط');
});

// ═══ (٢) الافتراضيّ ═══

test('افتراضيّ المستند: عميلٌ بلا نوع ⇒ نوع المندوب الافتراضي (التجزئة) يُسعَّر به الحارس ويُختم — والأساسي تحته يُرفض', async () => {
  reset(REP_USER);
  const w = issueWorld();
  const ok = await post(sellCarton(12));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(w.created[0].priceListId, 'L-R', 'الختم بنوع المندوب');
  assert.deepEqual(w.itemQueries.map((q) => q.where.priceListId), ['L-R']);
  assert.equal(calls.includes('priceList.count'), false, 'نوع المندوب محروسٌ عند كتابته — لا فحص ثانٍ');
  assert.equal(w.repReads.length, 1, 'عمودا المندوب من صفّه المقروء أصلاً — لا استعلام جديد');
  // سعر الكرتون الأساسي (١٠) تحت سقف التجزئة (١٢) — المندوب بلا «تغيير السعر» لا يبيع بغير مرجعه
  reset(REP_USER);
  const w2 = issueWorld();
  const under = await post(sellCarton(10));
  assert.equal(under.status, 403, JSON.stringify(under.body));
  assert.equal(under.body.message, 'لا تملك صلاحية تغيير سعر البيع');
  assert.equal(w2.created.length, 0);
  // إرسال الافتراضيّ صراحةً ليس تبديلاً
  reset(REP_USER);
  issueWorld();
  assert.equal((await post(sellCarton(12, { priceListId: 'L-R' }))).status, 201);
});

test('نوع العميل يغلب نوع المندوب: عميل الجملة يُسعَّر بها ويُختم بها ولو كان المندوب «تجزئة»', async () => {
  reset(REP_USER);
  const w = issueWorld({ customer: { priceListId: 'L-W' } });
  const r = await post(sellCarton(8));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].priceListId, 'L-W');
  assert.deepEqual(w.itemQueries.map((q) => q.where.priceListId), ['L-W']);
  reset(REP_USER);
  issueWorld({ customer: { priceListId: 'L-W' } });
  assert.equal((await post(sellCarton(12))).status, 403, 'سعر التجزئة فوق سقف الجملة');
});

test('مندوبٌ بلا نوعٍ افتراضيّ ولا قيد (صفٌّ سبق الميزة): سلوك المرحلة الأولى حرفياً — وبلا أنواعٍ لا استعلام أنواع ولا ختم', async () => {
  reset(REP_USER);
  const w = issueWorld({ rep: { defaultPriceListId: null } });
  const r = await post(sellCarton(10));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(touched('priceList'), []);
  assert.equal('priceListId' in w.created[0], false);
  // صفّ مندوبٍ بلا العمودين أصلاً
  reset(REP_USER);
  const { defaultPriceListId: _d, allowedPriceTypes: _a, ...legacy } = REP_ROW;
  void _d; void _a;
  const w2 = issueWorld();
  scripted['salesRep.findFirst'] = () => legacy;
  assert.equal((await post(sellCarton(10))).status, 201);
  assert.deepEqual(touched('priceList'), []);
  assert.equal('priceListId' in w2.created[0], false);
  // وعميل الجملة معه: نوع العميل كما في المرحلة الأولى
  reset(REP_USER);
  const w3 = issueWorld({ customer: { priceListId: 'L-W' } });
  scripted['salesRep.findFirst'] = () => legacy;
  assert.equal((await post(sellCarton(8))).status, 201);
  assert.equal(w3.created[0].priceListId, 'L-W');
});

// ═══ (٣) التبديل ═══

test('بلا «تبديل نوع السعر»: غير الافتراضيّ ⇒ 403 PRICE_LIST_FORBIDDEN بلا مستند — إلى الأساسي أو نوعٍ آخر، ولو أجازته أنواعه', async () => {
  for (const [priceListId, rep] of [[null, {}], ['L-W', {}], ['L-W', { allowedPriceTypes: ['L-R', 'L-W'] }], [null, { allowedPriceTypes: ['base', 'L-R'] }]] as const) {
    reset(REP_USER);
    const w = issueWorld({ rep });
    const r = await post(sellCarton(priceListId ? 8 : 10, { priceListId }));
    assert.equal(r.status, 403, `${priceListId}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'PRICE_LIST_FORBIDDEN');
    assert.equal(r.body.message, 'لا تملك صلاحية تبديل قائمة الأسعار');
    assert.equal('reason' in r.body, false, 'بلا وسم NOT_ALLOWED: السبب الصلاحية — التطبيق يطفئ رقائقه');
    assert.equal(w.created.length, 0);
    assert.equal(w.itemQueries.length, 0, 'لا أسعار تُقرأ لتبديلٍ مرفوض');
  }
});

test('بالصلاحية وقيد الأنواع: المسموح يمرّ بسعره ويُختم، وغيره 403 — والأساسي بـ«base» وحدها، ومصفوفةٌ فارغة = الافتراضيّ وحده', async () => {
  const CAN = { canChangePriceList: true };
  // التجزئة افتراضيّة والجملة مسموحة: الجملة بسعرها
  reset(REP_USER);
  const w = issueWorld({ rep: { ...CAN, allowedPriceTypes: ['L-R', 'L-W'] } });
  const ok = await post(sellCarton(8, { priceListId: 'L-W' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(w.created[0].priceListId, 'L-W');
  assert.deepEqual(w.itemQueries.map((q) => q.where.priceListId), ['L-W']);
  // الأساسي خارج المسموح ⇒ 403
  reset(REP_USER);
  const w0 = issueWorld({ rep: { ...CAN, allowedPriceTypes: ['L-R', 'L-W'] } });
  const noBase = await post(sellCarton(10, { priceListId: null }));
  assert.equal(noBase.status, 403, JSON.stringify(noBase.body));
  assert.equal(noBase.body.code, 'PRICE_LIST_FORBIDDEN');
  // صلاحيته قائمة والنوع خارج مسموحه: الرسالة بالسبب لا «لا تملك صلاحية»، ووسم reason يبقي رقائق التطبيق
  assert.equal(noBase.body.message, PRICE_LIST_MESSAGES.PRICE_TYPE_NOT_ALLOWED);
  assert.equal(noBase.body.message, 'قائمة الأسعار غير مسموحة لك');
  assert.equal(noBase.body.reason, PRICE_TYPE_NOT_ALLOWED_REASON);
  assert.equal(PRICE_TYPE_NOT_ALLOWED_REASON, 'NOT_ALLOWED');
  assert.equal(w0.created.length, 0);
  // و«base» في المسموح ⇒ الأساسي يمرّ بلا ختم ولا أسعار نوع
  reset(REP_USER);
  const wb = issueWorld({ rep: { ...CAN, allowedPriceTypes: ['base', 'L-R'] } });
  assert.equal((await post(sellCarton(10, { priceListId: null }))).status, 201);
  assert.equal('priceListId' in wb.created[0], false);
  assert.equal(wb.itemQueries.length, 0);
  // نوعٌ خارج المسموح (الجملة) ⇒ 403 ولو كان من الشركة
  reset(REP_USER);
  issueWorld({ rep: { ...CAN, allowedPriceTypes: ['base', 'L-R'] } });
  const outside = await post(sellCarton(8, { priceListId: 'L-W' }));
  assert.deepEqual([outside.body.code, outside.body.reason, outside.body.message], ['PRICE_LIST_FORBIDDEN', 'NOT_ALLOWED', 'قائمة الأسعار غير مسموحة لك']);
  // مصفوفةٌ فارغة: الافتراضيّ وحده
  reset(REP_USER);
  issueWorld({ rep: { ...CAN, allowedPriceTypes: [] } });
  assert.equal((await post(sellCarton(8, { priceListId: 'L-W' }))).body.code, 'PRICE_LIST_FORBIDDEN');
  reset(REP_USER);
  issueWorld({ rep: { ...CAN, allowedPriceTypes: [] } });
  assert.equal((await post(sellCarton(12, { priceListId: 'L-R' }))).status, 201);
});

test('نوع العميل نفسه مسموحٌ دائماً: عميل الجملة لمندوبٍ أنواعه «التجزئة» وحدها — بلا مفتاحٍ أو صريحاً، ولا يبدّل إلى غير المسموح', async () => {
  const rep = { canChangePriceList: true, allowedPriceTypes: ['L-R'] };
  for (const extra of [{}, { priceListId: 'L-W' }]) {
    reset(REP_USER);
    const w = issueWorld({ customer: { priceListId: 'L-W' }, rep });
    const r = await post(sellCarton(8, extra));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(w.created[0].priceListId, 'L-W');
  }
  // والتجزئة (المسموحة) تمرّ بسعرها
  reset(REP_USER);
  const w = issueWorld({ customer: { priceListId: 'L-W' }, rep });
  assert.equal((await post(sellCarton(12, { priceListId: 'L-R' }))).status, 201);
  assert.equal(w.created[0].priceListId, 'L-R');
  // والأساسي ليس في المسموح
  reset(REP_USER);
  issueWorld({ customer: { priceListId: 'L-W' }, rep });
  assert.equal((await post(sellCarton(10, { priceListId: null }))).body.code, 'PRICE_LIST_FORBIDDEN');
});

test('بالصلاحية بلا قيد (null): كل أنواع الشركة والأساسي كاليوم، ونوع شركةٍ أخرى 400 — ومعرّفٌ أجنبيّ تسرّب إلى المسموح لا يفتح شيئاً', async () => {
  for (const [priceListId, price] of [['L-W', 8], [null, 10]] as const) {
    reset(REP_USER);
    const w = issueWorld({ rep: { canChangePriceList: true } });
    const r = await post(sellCarton(price, { priceListId }));
    assert.equal(r.status, 201, `${priceListId}: ${JSON.stringify(r.body)}`);
    assert.equal(stampOf(w.created[0]), priceListId);
  }
  for (const allowedPriceTypes of [null, ['L-R', 'L-X']]) {
    reset(REP_USER);
    const w = issueWorld({ rep: { canChangePriceList: true, allowedPriceTypes } });
    const r = await post(sellCarton(8, { priceListId: 'L-X' }));
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRICE_LIST_INVALID');
    assert.equal(w.created.length, 0);
  }
  // وبقيدٍ لا يحوي المعرّف الأجنبيّ: 403 قبل فحص الوجود
  reset(REP_USER);
  issueWorld({ rep: { canChangePriceList: true, allowedPriceTypes: ['L-R'] } });
  assert.equal((await post(sellCarton(8, { priceListId: 'L-X' }))).body.code, 'PRICE_LIST_FORBIDDEN');
  assert.equal(calls.includes('priceList.count'), false);
});

// ═══ (٤) الإدارة ومفتاح API ═══

test('الإدارة ومفتاح API: الافتراضيّ نوع مندوب المستند (salesRepId)، والاختيار حرٌّ من قيد أنواعه وصلاحيته', async () => {
  for (const user of [ADMIN, API_KEY]) {
    // بلا مفتاح: نوع المندوب المُصدَر له
    reset(user);
    const w = issueWorld();
    const r = await post(sellCarton(11));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(w.created[0].priceListId, 'L-R');
    assert.deepEqual(w.itemQueries.map((q) => q.where.priceListId), ['L-R']);
    // مندوبٌ بلا صلاحيةٍ ولا أنواعٍ غير التجزئة: الإدارة تبيع بالجملة وبالأساسي
    for (const [priceListId, price] of [['L-W', 9], [null, 10]] as const) {
      reset(user);
      const w2 = issueWorld({ rep: { allowedPriceTypes: ['L-R'] } });
      const r2 = await post(sellCarton(price, { priceListId }));
      assert.equal(r2.status, 201, `${user.apiKeyId ?? 'admin'} ${priceListId}: ${JSON.stringify(r2.body)}`);
      assert.equal(stampOf(w2.created[0]), priceListId);
    }
    // ونوع شركةٍ أخرى 400 كاليوم
    reset(user);
    issueWorld();
    assert.equal((await post(sellCarton(8, { priceListId: 'L-X' }))).body.code, 'PRICE_LIST_INVALID');
  }
  // ونوع العميل يغلب نوع المندوب للإدارة كذلك
  reset(ADMIN);
  const w = issueWorld({ customer: { priceListId: 'L-W' } });
  assert.equal((await post(sellCarton(8))).status, 201);
  assert.equal(w.created[0].priceListId, 'L-W');
});

// ═══ (٥) إعادة رفع الصندوق ═══

test('إعادة الرفع (X-FS-Replay): نوعٌ حُذف أو صلاحيةٌ/نوعٌ مسموح نُزعا ⇒ الافتراضيّ الجديد (نوع المندوب) لا الأساسي ولا يُعدم — والحيّ 400/403', async () => {
  // (أ) نوعٌ حُذف قبل المزامنة — مندوبٌ بالتبديل و«تغيير السعر»: يُختم بنوع المندوب (عميلٌ بلا نوع) لا بالأساسي
  reset(REP_USER);
  const a = issueWorld({ rep: { canChangePriceList: true, canChangePrice: true } });
  const gone = await post(sellCarton(12, { priceListId: 'L-GONE' }), REPLAY);
  assert.equal(gone.status, 201, JSON.stringify(gone.body));
  assert.equal(a.created[0].priceListId, 'L-R');
  assert.deepEqual(a.itemQueries.map((q) => q.where.priceListId), ['L-R']);
  reset(REP_USER);
  issueWorld({ rep: { canChangePriceList: true, canChangePrice: true } });
  assert.equal((await post(sellCarton(12, { priceListId: 'L-GONE' }))).body.code, 'PRICE_LIST_INVALID');

  // (ب) نُزعت «تبديل نوع السعر»: الإعادة تُسعَّر بالافتراضيّ الجديد
  reset(REP_USER);
  const b = issueWorld();
  const revoked = await post(sellCarton(12, { priceListId: null }), REPLAY);
  assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
  assert.equal(b.created[0].priceListId, 'L-R');
  assert.equal(calls.includes('priceList.count'), false);

  // (ج) نُزع نوعٌ من أنواعه المسموحة بعد الإصدار: كذلك
  reset(REP_USER);
  const c = issueWorld({ rep: { canChangePriceList: true, allowedPriceTypes: ['L-R'] } });
  const narrowed = await post(sellCarton(12, { priceListId: 'L-W' }), REPLAY);
  assert.equal(narrowed.status, 201, JSON.stringify(narrowed.body));
  assert.equal(c.created[0].priceListId, 'L-R');
  reset(REP_USER);
  issueWorld({ rep: { canChangePriceList: true, allowedPriceTypes: ['L-R'] } });
  assert.equal((await post(sellCarton(8, { priceListId: 'L-W' }))).body.code, 'PRICE_LIST_FORBIDDEN', 'والحيّ 403');

  // (د) ولا ثغرة: الترويسة لا تفتح نوعاً أرخص — الجملة (٨) يقيسها الحارس بالافتراضيّ (التجزئة ١٢) فتُرفض
  reset(REP_USER);
  const d = issueWorld();
  const cheap = await post(sellCarton(8, { priceListId: 'L-W' }), REPLAY);
  assert.equal(cheap.status, 403, JSON.stringify(cheap.body));
  assert.equal(cheap.body.message, 'لا تملك صلاحية تغيير سعر البيع');
  assert.equal(d.created.length, 0);

  // (هـ) وصندوقٌ قديم بلا المفتاح: الافتراضيّ الجديد كذلك
  reset(REP_USER);
  const e = issueWorld();
  assert.equal((await post(sellCarton(12), REPLAY)).status, 201);
  assert.equal(e.created[0].priceListId, 'L-R');
});

test('قواعد القائمة (٥ نوفمبر ٢٠٢٦) تتبع القائمة المحسومة نفسها: الافتراضيّة والمختارة بالصلاحية والافتراضيّة الجديدة في إعادة الرفع — وبلا قائمةٍ لا استعلام', async () => {
  /** قاعدة صنفٍ ثابتة على التجزئة: كرتونها ١١ (تغلب سعر الصنف الثابت فيها ١٢ عند التساوي) */
  const rules = { 'L-R': [{ id: 'R-11', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 11 / 24, minQty: 0, startsOn: null, endsOn: null }] };
  // الافتراضيّة (قائمة المندوب): القاعدة تحكم، واستعلامٌ واحد مع الأسعار
  reset(REP_USER);
  const w = issueWorld({ rules });
  assert.equal((await post(sellCarton(11))).status, 201);
  assert.deepEqual(w.ruleQueries.map((q) => q.where.priceListId), ['L-R']);
  assert.deepEqual(w.itemQueries.map((q) => q.where.priceListId), ['L-R']);
  reset(REP_USER);
  issueWorld({ rules });
  assert.equal((await post(sellCarton(12))).status, 403, 'سعر الصنف الثابت فوق القاعدة');
  // المختارة بالصلاحية: قواعد الجملة (لا شيء) وسعرها
  reset(REP_USER);
  const sw = issueWorld({ rules, rep: { canChangePriceList: true } });
  assert.equal((await post(sellCarton(8, { priceListId: 'L-W' }))).status, 201);
  assert.deepEqual(sw.ruleQueries.map((q) => q.where.priceListId), ['L-W']);
  // إعادة الرفع بقائمةٍ نُزعت صلاحيتها: قواعد الافتراضيّة الجديدة
  reset(REP_USER);
  const rp = issueWorld({ rules });
  assert.equal((await post(sellCarton(11, { priceListId: 'L-W' }), REPLAY)).status, 201);
  assert.deepEqual(rp.ruleQueries.map((q) => q.where.priceListId), ['L-R']);
  // والتبديل المرفوض لا يقرأ قواعد، وبلا قائمةٍ لا استعلام
  reset(REP_USER);
  const no = issueWorld({ rules });
  assert.equal((await post(sellCarton(8, { priceListId: 'L-W' }))).status, 403);
  assert.equal(no.ruleQueries.length, 0);
  reset(REP_USER);
  const base = issueWorld({ rules, rep: { defaultPriceListId: null } });
  assert.equal((await post(sellCarton(10))).status, 201);
  assert.equal(base.ruleQueries.length, 0);
  assert.deepEqual(touched('priceList'), []);
});

// ═══ (٦) المرتجع ═══

test('المرتجع الحرّ: بلا مفتاحٍ يُختم بالافتراضيّ الجديد، والتبديل بلا صلاحية 403 كالبيع، وبها ضمن المسموح', async () => {
  reset(REP_USER);
  const w = issueWorld();
  const r = await post(returnCarton(12));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].type, 'RETURN');
  assert.equal(w.created[0].priceListId, 'L-R');
  reset(REP_USER);
  issueWorld();
  assert.equal((await post(returnCarton(8, { priceListId: 'L-W' }))).body.code, 'PRICE_LIST_FORBIDDEN');
  reset(REP_USER);
  issueWorld({ rep: { canChangePriceList: true, allowedPriceTypes: ['L-R'] } });
  assert.equal((await post(returnCarton(8, { priceListId: 'L-W' }))).body.code, 'PRICE_LIST_FORBIDDEN');
  reset(REP_USER);
  const w2 = issueWorld({ rep: { canChangePriceList: true, allowedPriceTypes: ['L-R', 'L-W'] } });
  assert.equal((await post(returnCarton(8, { priceListId: 'L-W' }))).status, 201);
  assert.equal(w2.created[0].priceListId, 'L-W');
});

test('المرتجع من فاتورة بيع (المرحلة الأولى): تطبيق المندوب لا يرسل المفتاح ⇒ الختم بالافتراضيّ الجديد، ومبلغه من بند البيع كما هو', async () => {
  reset(REP_USER);
  const w = issueWorld();
  const SALE = {
    id: 'sale-1', customerId: 'c1', type: 'CASH', status: 'CONFIRMED', documentKind: null, locationId: null, teamId: null,
    items: [{ id: 'si-1', productId: 'p1', qty: 1, unitFactor: 24, baseQty: 24 }],
  };
  // فاتورة البيع لمن يسأل عنها بمعرّفها (النطاق والروابط والفريق)، وما عداها (آخر رقمٍ للتسلسل) لا شيء
  scripted['invoice.findFirst'] = (args) => (args?.where?.id === 'sale-1' ? SALE : null);
  scripted['invoiceItem.findMany'] = (args) => (args?.where?.OR ? [] : [{ id: 'si-1', qty: 1, unitFactor: 24, lineTotal: 11.5, taxPct: 15 }]);
  const r = await post(returnCarton(99, { originalInvoiceId: 'sale-1', items: [{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice: 99, discountPct: 0, invoiceItemId: 'si-1' }] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].priceListId, 'L-R');
  assert.equal(Number(w.created[0].total), 11.5, 'المبلغ من بند البيع لا من نوع السعر');
});

// ═══ (٧) المرحلة الثانية ═══

test('المرحلة الثانية: الفاتورة والإشعار الدائن اليدويّ يتسلّمان النوع المحسوم نفسه (افتراضيّ المندوب أو المختار)، والحارس قبلهما', async () => {
  reset(REP_USER);
  issueWorld({ phase2: true });
  const r = await post(sellCarton(12));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(phase2Ctx.length, 1);
  assert.equal(phase2Ctx[0].priceListId, 'L-R', 'ختم النوع في سياق المرحلة الثانية');
  reset(REP_USER);
  issueWorld({ phase2: true, rep: { canChangePriceList: true, allowedPriceTypes: ['L-R', 'L-W'] } });
  assert.equal((await post(sellCarton(8, { priceListId: 'L-W' }))).status, 201);
  assert.equal(phase2Ctx[0].priceListId, 'L-W');
  // والتبديل الممنوع يُردّ قبل النواة
  reset(REP_USER);
  issueWorld({ phase2: true });
  assert.equal((await post(sellCarton(8, { priceListId: 'L-W' }))).body.code, 'PRICE_LIST_FORBIDDEN');
  assert.equal(phase2Ctx.length, 0);
  // المرتجع: السياق اليدويّ (الاشتراط مطفأ) يحمل الختم، والمرتبط بلا نوعٍ من الطلب كاليوم (يرث بنود أصله)
  reset(ADMIN);
  issueWorld({ phase2: true });
  scripted['companySettings.findUnique'] = () => ({ ...PHASE1, zatcaPhase2StartedAt: new Date('2026-10-02T00:00:00Z'), returnRequiresSaleInvoice: false });
  const manual = await post(returnCarton(12, { originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'إرجاع بضاعة' }));
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  assert.equal(noteCtx.length, 1);
  assert.equal(noteCtx[0].manualReturn?.invoice?.priceListId, 'L-R');
  assert.equal('priceListId' in noteCtx[0], false, 'الإشعار المرتبط يأخذ أسعاره من أصله لا من نوع السعر');
});
