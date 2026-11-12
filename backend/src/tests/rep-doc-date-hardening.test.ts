// F1 (تدقيق «هدف الشهر»، نوفمبر ٢٠٢٦): المندوب لا يختار تاريخ مستنده. التاريخ الصريح في الجسم (invoiceDate للفاتورة والمرتجع،
// receiptDate للسند) للوحة الإدارة ومفتاح API وحدهما — بتوكن المندوب كان ينقل بيعاً أو تحصيلاً إلى شهرٍ منتهٍ فيقلب هدفه «متحقّقاً».
// معالجان حقيقيان (POST /api/invoices وPOST /api/receipts) فوق Prisma مزيّف (بلا قاعدة بيانات). يثبت:
//   • المندوب حيّاً: تاريخه الصريح يُهمل ⇒ ساعة الخادم (لا عمود تاريخ في الإنشاء، ورقم الفترة شهر اليوم، وقيد الدفتر كذلك).
//   • المندوب بإعادة رفع الصندوق: قاعدة لحظة الجهاز كما هي (clientCreatedAt: لا مستقبل ولا أقدم من سبعة أيام) — وتاريخه الصريح لا يعطّلها.
//   • الإدارة ومفتاح API: التاريخ الصريح كما كان حرفاً (ولو مع ترويسة الإعادة).
//   • المرحلة الثانية: تاريخ المندوب الصريح لا يصل سياق النواة (تاريخ التوريد)، وتاريخ الإدارة يصلها كما كان.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّهين (نمط price-lists-rep-invoices.test.ts) ═══

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
      const fn = scripted[`${model}.${method}`];
      return fn ? fn(args) : defaultFor(method);
    },
  });
}
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => (typeof arg !== 'function'
        ? Promise.all(arg as Promise<unknown>[])
        : (arg as (tx: unknown) => Promise<unknown>)(prismaFake));
    }
    if (key === '$queryRaw' || key === '$executeRaw') return async () => (key === '$queryRaw' ? [] : 0);
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
// المرحلة الثانية: يُلتقط السياق الذي يسلّمه routes/invoices.ts للنواة (تقرأ منه ctx.body.invoiceDate تاريخ التوريد) بدل الإصدار الحقيقي
let phase2Ctx: any[] = [];
override('routes/invoicesZatca', {
  issuePhase2Invoice: async (ctx: unknown) => { phase2Ctx.push(ctx); return { status: 201, body: { success: true, data: { id: 'z-1', number: 'INV-Z1' } } }; },
});
stub('services/liveEvents', { publishInvoicesChanged: () => { /* — */ } });

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesRouter = (require('../routes/invoices') as typeof import('../routes/invoices')).default;
const receiptsRouter = (require('../routes/receipts') as typeof import('../routes/receipts')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ العُدّة ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/receipts', receiptsRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function post(route: '/api/invoices' | '/api/receipts', body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const s = await startServer();
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method: 'POST', path: route, agent: false,
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
const MANAGER: User = { id: 'mgr-1', role: 'MANAGER', tenantId: TENANT };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'key-1' };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT };
const REPLAY = { 'x-fs-replay': '1' };

/** شهرٌ منتهٍ بعيد — بادئة رقمه INV-2501-/RCP-2501- لا تلتبس بشهر اليوم */
const CRAFTED = '2025-01-15T12:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const CUSTOMER = { id: 'c1', tenantId: TENANT, name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0, priceListId: null };
const REP_ROW = {
  id: 'rep-1', tenantId: TENANT, canCreateInvoice: true, canCreateReceipt: true, canSellOnCredit: true, canSellInCash: true,
  canSellOnInstallment: true, canChangePrice: true, canSellBelowPrice: true, canChangePriceList: false, canSellWithoutStock: true,
  maxDiscountPct: 0, locationId: null, canCancelInvoice: false, defaultPriceListId: null, allowedPriceTypes: null,
  tenant: { locationsEnabled: false, lotTrackingEnabled: false, settings: { teamsEnabled: false, paymentMethodsConfig: null } }, teamMemberships: [],
};
const PRODUCT = {
  id: 'p1', name: 'ماء', unit: 'حبة', basePrice: 10, taxPct: 15, damagedReturnToStock: true, priceTiers: [], units: [],
  shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, teams: [], lotTracked: false,
  repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null, primaryUnitId: null,
};
const PHASE1 = { defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null };

function world(user: User, o: { phase2?: boolean } = {}) {
  currentUser = user;
  phase2Ctx = [];
  const invoices: any[] = [];
  const receipts: any[] = [];
  const entries: any[] = [];
  scripted = {
    'invoice.findUnique': () => null,
    'receipt.findUnique': (args) => (args?.where?.id ? { ...receipts[receipts.length - 1], id: args.where.id, invoiceItems: [] } : null),
    'salesRep.findFirst': () => REP_ROW,
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => CUSTOMER,
    'product.findMany': () => [PRODUCT],
    'companySettings.findUnique': () => (o.phase2 ? { ...PHASE1, zatcaPhase2StartedAt: new Date('2026-10-02T00:00:00Z') } : PHASE1),
    'invoice.create': (args) => { invoices.push(args.data); return { id: `inv-${invoices.length}`, ...args.data, items: args.data.items.create, customer: CUSTOMER }; },
    'receipt.create': (args) => { receipts.push(args.data); return { id: `rcp-${receipts.length}`, ...args.data }; },
    'accountEntry.create': (args) => { entries.push(args.data); return { id: `ae-${entries.length}`, ...args.data }; },
  };
  return { invoices, receipts, entries };
}

/** بيعٌ نقديّ بسيط — والإضافات (التاريخ ولحظة الجهاز) فوقه */
const sale = (extra: Record<string, unknown> = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0,
  items: [{ productId: 'p1', qty: 1, unitPrice: 10, discountPct: 0 }], ...extra,
});
const receipt = (extra: Record<string, unknown> = {}) => ({ customerId: 'c1', salesRepId: 'rep-1', amount: 50, paymentMethod: 'CASH', ...extra });
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : new Date(String(d)).toISOString());

// ═══ (١) الفاتورة والمرتجع — المرحلة الأولى (والمستند بلا ضريبة يسلك المسار نفسه) ═══

test('المندوب حيّاً: invoiceDate المصنوع يُهمل ⇒ ساعة الخادم (لا عمود تاريخ، ورقمٌ بفترة اليوم لا الشهر المنتهي)', async () => {
  const w = world(REP_USER);
  const r = await post('/api/invoices', sale({ invoiceDate: CRAFTED }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal('invoiceDate' in w.invoices[0], false, 'لا تاريخ من الجسم — افتراضيّ العمود (الآن)');
  assert.ok(!String(w.invoices[0].number).startsWith('INV-2501-'), `الرقم ${w.invoices[0].number} بفترة اليوم`);
  // والمرتجع الحرّ كذلك
  const w2 = world(REP_USER);
  const ret = await post('/api/invoices', sale({ type: 'RETURN', returnReason: 'NORMAL', invoiceDate: CRAFTED }));
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal('invoiceDate' in w2.invoices[0], false);
  assert.ok(!String(w2.invoices[0].number).startsWith('RET-2501-'));
});

test('المندوب بإعادة رفع الصندوق: لحظة الجهاز كما كانت، وتاريخه الصريح لا يعطّلها ولا يحلّ محلّها', async () => {
  const at = hoursAgo(3);
  const w = world(REP_USER);
  const r = await post('/api/invoices', sale({ invoiceDate: CRAFTED, clientCreatedAt: at, clientRef: '00000000-0000-4000-8000-000000000001' }), REPLAY);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(iso(w.invoices[0].invoiceDate), at, 'لحظة الجهاز لا التاريخ المصنوع');
  // بلا تاريخٍ صريح: السلوك القائم نفسه
  const w0 = world(REP_USER);
  await post('/api/invoices', sale({ clientCreatedAt: at, clientRef: '00000000-0000-4000-8000-000000000002' }), REPLAY);
  assert.equal(iso(w0.invoices[0].invoiceDate), at);
  // حصر لحظة الجهاز باقٍ: أقدم من سبعة أيام أو في المستقبل ⇒ ساعة الخادم — لا يرجع التاريخ المصنوع بديلاً
  for (const [n, stale] of [[3, hoursAgo(10 * 24)], [4, new Date(Date.now() + 2 * 86_400_000).toISOString()]] as const) {
    const ws = world(REP_USER);
    const s = await post('/api/invoices', sale({ invoiceDate: CRAFTED, clientCreatedAt: stale, clientRef: `00000000-0000-4000-8000-00000000000${n}` }), REPLAY);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal('invoiceDate' in ws.invoices[0], false, `${stale}: ساعة الخادم`);
  }
});

test('الإدارة ومفتاح API: التاريخ الصريح كما كان حرفاً — في العمود والرقم، ولو مع ترويسة الإعادة', async () => {
  for (const user of [ADMIN, MANAGER, API_KEY]) {
    const w = world(user);
    const r = await post('/api/invoices', sale({ invoiceDate: CRAFTED }));
    assert.equal(r.status, 201, `${user.role}${user.apiKeyId ? '/key' : ''}: ${JSON.stringify(r.body)}`);
    assert.equal(iso(w.invoices[0].invoiceDate), CRAFTED);
    assert.ok(String(w.invoices[0].number).startsWith('INV-2501-'), String(w.invoices[0].number));
  }
  // الإدارة بترويسة الإعادة ولحظة جهاز: الصريح يغلب كما كان (offlineInvoiceDate للمندوب وحده)
  const w = world(ADMIN);
  await post('/api/invoices', sale({ invoiceDate: CRAFTED, clientCreatedAt: hoursAgo(3) }), REPLAY);
  assert.equal(iso(w.invoices[0].invoiceDate), CRAFTED);
});

// ═══ (٢) المرحلة الثانية: تاريخ الجسم هو تاريخ التوريد (invoicesZatca.ts supplyDate) ═══

test('المرحلة الثانية: تاريخ المندوب الصريح لا يصل سياق النواة، وتاريخ الإدارة يصلها كما كان', async () => {
  world(REP_USER, { phase2: true });
  const r = await post('/api/invoices', sale({ invoiceDate: '2026-10-01' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(phase2Ctx.length, 1);
  assert.equal(phase2Ctx[0].body.invoiceDate, undefined, 'لا تاريخ توريد من توكن المندوب');
  world(ADMIN, { phase2: true });
  assert.equal((await post('/api/invoices', sale({ invoiceDate: '2026-10-01' }))).status, 201);
  assert.equal(phase2Ctx[0].body.invoiceDate, '2026-10-01');
});

// ═══ (٣) سند القبض ═══

test('سند المندوب حيّاً: receiptDate المصنوع يُهمل ⇒ ساعة الخادم في السند ورقمه وقيد الدفتر', async () => {
  const w = world(REP_USER);
  const r = await post('/api/receipts', receipt({ receiptDate: CRAFTED }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal('receiptDate' in w.receipts[0], false, 'لا تاريخ من الجسم — افتراضيّ العمود (الآن)');
  assert.ok(!String(w.receipts[0].number).startsWith('RCP-2501-'), String(w.receipts[0].number));
  assert.equal(w.entries.length, 1);
  assert.equal('entryDate' in w.entries[0], false, 'قيد الدفتر بتاريخ اليوم');
});

test('سند المندوب بإعادة رفع الصندوق: لحظة الجهاز كما كانت، والصريح لا يعطّلها؛ وخارج الحصر ساعة الخادم', async () => {
  const at = hoursAgo(5);
  const w = world(REP_USER);
  const r = await post('/api/receipts', receipt({ receiptDate: CRAFTED, clientCreatedAt: at, clientRef: '00000000-0000-4000-8000-000000000011' }), REPLAY);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(iso(w.receipts[0].receiptDate), at);
  assert.equal(iso(w.entries[0].entryDate), at, 'القيد بالتاريخ نفسه');
  const ws = world(REP_USER);
  await post('/api/receipts', receipt({ receiptDate: CRAFTED, clientCreatedAt: hoursAgo(9 * 24), clientRef: '00000000-0000-4000-8000-000000000012' }), REPLAY);
  assert.equal('receiptDate' in ws.receipts[0], false, 'أقدم من سبعة أيام ⇒ ساعة الخادم لا التاريخ المصنوع');
});

test('سند الإدارة ومفتاح API: receiptDate الصريح كما كان حرفاً', async () => {
  for (const user of [ADMIN, MANAGER, API_KEY]) {
    const w = world(user);
    const r = await post('/api/receipts', receipt({ receiptDate: CRAFTED }));
    assert.equal(r.status, 201, `${user.role}: ${JSON.stringify(r.body)}`);
    assert.equal(iso(w.receipts[0].receiptDate), CRAFTED);
    assert.ok(String(w.receipts[0].number).startsWith('RCP-2501-'), String(w.receipts[0].number));
    assert.equal(iso(w.entries[0].entryDate), CRAFTED);
  }
});

// ═══ (٤) حارس نصّي: المحو بعد التحليل مباشرةً — قبل كل قارئ، ولا قارئ للجسم الخام ═══

test('حارس نصّي: محو التاريخ الصريح للمندوب يلي التحليل مباشرةً في المسارين، ولا يُقرأ التاريخ من req.body', () => {
  const guard = (field: string) => new RegExp(`if \\(req\\.user!\\.role === 'SALES_REP' && !req\\.user\\?\\.apiKeyId\\) body\\.${field} = undefined;`);
  for (const [file, schema, field, readers] of [
    ['invoices.ts', 'createInvoiceSchema', 'invoiceDate', ['const offlineAt = offlineInvoiceDate(', 'const docDate = body.invoiceDate', 'returnHistoryBound(body.invoiceDate', 'const phase2Ctx: Phase2IssuanceContext']],
    ['receipts.ts', 'receiptSchema', 'receiptDate', ['const offlineAt = offlineInvoiceDate(', 'const docDate = body.receiptDate']],
  ] as const) {
    const src = fs.readFileSync(path.join(SRC, 'routes', file), 'utf8');
    const parseAt = src.indexOf(`const body = ${schema}.parse(req.body);`);
    assert.ok(parseAt > 0, `${file}: التحليل`);
    const m = guard(field).exec(src.slice(parseAt));
    assert.ok(m, `${file}: الحارس`);
    const guardAt = parseAt + m.index;
    // لا شيفرة بين التحليل والحارس (تعليقٌ وحده)
    const between = src.slice(parseAt, guardAt).split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    assert.deepEqual(between, [], `${file}: الحارس يلي التحليل مباشرةً`);
    for (const r of readers) {
      const at = src.indexOf(r);
      assert.ok(at > guardAt, `${file}: ${r} بعد الحارس`);
    }
    assert.equal(new RegExp(`req\\.body\\??\\.${field}`).test(src), false, `${file}: لا قراءة للتاريخ من الجسم الخام`);
  }
});
