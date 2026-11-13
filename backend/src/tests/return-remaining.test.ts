// البند ١١ من تدقيق دقّة التقارير (طلب المالك ١٣ نوفمبر ٢٠٢٦): مرتجع المرحلة الأولى المرتبط بفاتورة بيعٍ آجلة يُسقط من متبقّيها
// بقدره (ولا تحت الصفر) في معاملة إصداره، ويُسجَّل ما أسقطه على المرتجع (remainingApplied) فيردّه إلغاؤه بعينه مسقوفاً بما على
// الفاتورة. الإصدار POST /api/invoices والإلغاء PATCH /api/invoices/:id/cancel الحقيقيّان فوق عميل Prisma مزيّف ذي حالة (نمط
// tax-off-invoices.test.ts) — لا قاعدة ولا شبكة. المطلوب إثباته:
//   • المرتجع المرتبط ينقص المتبقّي داخل المعاملة وقبل قيد العميل، والأكبر من المتبقّي يقف عند الصفر (والقيد بإجماليه كما كان).
//   • الأصل النقدي، والآجلة المسدَّدة، والمرتجع الحرّ: لا قراءة إضافية تُكتب ولا عمود.
//   • الإلغاء يردّ المُسقَط بعينه مسقوفاً بـ total − paidAmt، ومرتجعٌ بلا مبلغٍ مسجَّل لا يستعلم شيئاً.
//   • إعادة الرفع (clientRef قائم، أو سباق P2002) لا تُسقط مرّتين.
//   • فرع المرحلة الثانية (الإشعار الدائن) كما هو: لا يمرّ بهذا المسار، وكوده في invoicesNotes.ts وinvoiceVoid.ts لم يتغيّر.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

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
let rawSql: string[] = [];
let scripted: Record<string, (a: any) => unknown> = {};
let rawScript: (sql: string) => unknown = () => [];

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
    if (key === '$queryRaw') {
      return async (q: unknown) => {
        const sql = Array.isArray(q) ? (q as string[]).join('?') : String(q);
        calls.push('$queryRaw'); rawSql.push(sql);
        return rawScript(sql);
      };
    }
    if (key === '$executeRaw') return async () => { calls.push('$executeRaw'); return 0; };
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TID = 'tenant-ret-rem';
type User = { id: string; role: string; tenantId: string; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TID };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TID };
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
// اعتماديات المرحلة الثانية: كائنٌ وسمٌ لا يُستعمل إلا عبر الإشعار المزيّف أدناه
const PHASE2_DEPS = { tag: 'phase2-deps' };
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => PHASE2_DEPS });
// الإشعار الدائن (فرع المرحلة الثانية) يُسجَّل نداؤه ولا يُنفَّذ — المطلوب أنّ المسار يسلّمه المرتجع كما هو ولا يمسّ المتبقّي بنفسه
let creditNoteCalls: Array<{ ctx: Row; deps: unknown }> = [];
const notInTest = (name: string) => () => { throw new Error(`${name} لا يُبلغ في هذه الاختبارات`); };
stub('routes/invoicesNotes', {
  issueReturnAsCreditNote: async (ctx: Row, deps: unknown) => {
    creditNoteCalls.push({ ctx, deps });
    return { status: 201, body: { success: true, data: { id: 'cn-1', number: 'CN-1', type: 'RETURN', documentKind: 'CREDIT_NOTE' } } };
  },
  creditNotePermission: notInTest('creditNotePermission'), creditScopeOf: notInTest('creditScopeOf'),
  creditableProjection: notInTest('creditableProjection'), debitNotePermission: notInTest('debitNotePermission'),
  issueCreditNote: notInTest('issueCreditNote'), issueDebitNote: notInTest('issueDebitNote'),
});

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesModule = require('../routes/invoices') as typeof import('../routes/invoices');
const invoicesRouter = invoicesModule.default as express.Router;
const { linkedReturnRemainingApplied } = invoicesModule;
const { restoredRemaining } = require('../services/docCancel') as typeof import('../services/docCancel');
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
async function send(method: 'POST' | 'PATCH', url: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const s = await startServer();
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
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
const postInvoice = (body: unknown, headers: Record<string, string> = {}) => send('POST', '/api/invoices', body, headers);
const cancelInvoice = (id: string) => send('PATCH', `/api/invoices/${id}/cancel`, {});

// ═══ المنصّة المزيّفة: فاتورة بيعٍ ذات حالة ومرتجعٌ يُلغى ═══

const productRow = (id: string, name: string, basePrice: number): Row => ({
  id, name, unit: 'حبة', basePrice, taxPct: 0, damagedReturnToStock: true, priceTiers: [], units: [], teams: [], categoryId: null,
  lotTracked: false, repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null, primaryUnitId: null, shelfLifeEnabled: false, returnRuleEnabled: false,
});
const PRODUCT_ROWS = [productRow('p-a', 'صنف أ', 100)];
const REP: Row = {
  id: 'rep-1', tenantId: TID, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, maxDiscountPct: 100,
};
const CUSTOMER: Row = { id: 'c-1', name: 'عميل', status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: TID, priceListId: null };
/** شركةٌ بلا ضريبة قيمة مضافة في المرحلة الأولى (الإمارات بنسبة صفر للتبسيط: المبالغ أرقام صحيحة) */
const PHASE1_SETTINGS: Row = {
  defaultVatPct: 0, countryCode: 'AE', currency: 'AED', einvoiceProvider: null, zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null,
  returnRequiresSaleInvoice: null, returnPolicyChangedAt: null, taxDisabled: false, taxModeChangedAt: null,
};
const PHASE2_SETTINGS: Row = {
  ...PHASE1_SETTINGS, countryCode: 'SA', currency: 'SAR', defaultVatPct: 15, einvoiceProvider: 'zatca',
  zatcaPhase2StartedAt: new Date('2026-10-02T06:00:00.000Z'),
};

/** فاتورة البيع: بندٌ واحد s-1 عشر حبّات بألف — كل حبّة بمئة */
type Sale = { id: string; type: string; status: string; total: number; paidAmt: number; remainingAmt: number };
let sale: Sale;
/** المرتجع كما يقرؤه مسار الإلغاء (include: receiptItems وtenant) */
let returnDoc: Row;
/** صفّ إعادة الرفع: موجودٌ مسبقاً بـclientRef (null = أوّل رفع) */
let existingByRef: Row | null;
/** إجمالي مرتجعات فاتورة البيع الأخرى القائمة كما يقرؤه الإلغاء (0 = لا غيره) */
let otherReturnsTotal = 0;

function reset(user: User = ADMIN, o: { settings?: Row; sale?: Partial<Sale> } = {}): void {
  calls = []; args = {}; rawSql = []; creditNoteCalls = [];
  currentUser = user;
  existingByRef = null;
  otherReturnsTotal = 0;
  delete process.env.ZATCA_REHEARSAL_TENANT_IDS;
  sale = { id: 'sale-1', type: 'CREDIT', status: 'CONFIRMED', total: 1000, paidAmt: 0, remainingAmt: 1000, ...(o.sale ?? {}) };
  returnDoc = {
    id: 'ret-1', tenantId: TID, number: 'RET-1', type: 'RETURN', status: 'CONFIRMED', customerId: 'c-1', salesRepId: 'rep-1',
    total: 300, paidAmt: 0, remainingAmt: 0, zatcaPhase: null, einvoiceStatus: null, remainingApplied: null,
    receiptItems: [], tenant: { lotTrackingEnabled: false },
  };
  const settings = o.settings ?? PHASE1_SETTINGS;
  scripted = {
    'invoice.findUnique': () => existingByRef,
    'salesRep.findFirst': () => ({ ...REP }),
    'customer.findFirst': () => CUSTOMER,
    'product.findMany': (a: { where?: { id?: { in?: string[] } } }) => { const ids = a.where?.id?.in ?? []; return PRODUCT_ROWS.filter(p => ids.includes(p.id)); },
    'companySettings.findUnique': (a: { select?: Row }) => (a.select?.defaultVatPct ? { ...settings } : { customerIsolationEnabled: false }),
    'tenant.findUnique': () => ({ invoiceSignatureEnabled: false, lotTrackingEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': (a: { where?: Row; select?: Row; include?: Row }) => {
      // assertReturnLinks: فاتورة البيع ببنودها
      if (a.select?.items) {
        return a.where?.id === sale.id
          ? { customerId: 'c-1', type: sale.type, status: sale.status, documentKind: null, locationId: null,
            items: [{ id: 's-1', productId: 'p-a', qty: 10, unitFactor: 1, baseQty: 10 }] }
          : null;
      }
      // البند ١١: متبقّي فاتورة البيع تحت قفلها
      if (a.select?.remainingAmt) return a.where?.id === sale.id ? { type: sale.type, status: sale.status, remainingAmt: sale.remainingAmt } : null;
      // مسار الإلغاء: المرتجع بسنداته وعَلَم شركته
      if (a.include?.receiptItems) return a.where?.id === returnDoc.id ? { ...returnDoc } : null;
      return null;
    },
    'invoice.create': (a: { data: Row }) => {
      const data = a.data;
      const items = ((data.items as { create?: Row[] } | undefined)?.create ?? []).map((i, k) => ({ id: `ri${k}`, ...i }));
      return { id: 'ret-new', ...data, items, customer: CUSTOMER, installments: [], signature: null };
    },
    'invoice.update': (a: { where: { id: string }; data: Row }) => {
      if (a.where.id === sale.id) { Object.assign(sale, a.data); return { ...sale }; }
      if (a.where.id === returnDoc.id) { Object.assign(returnDoc, a.data); return { ...returnDoc }; }
      return { id: a.where.id, ...a.data };
    },
    'invoiceItem.findMany': (a: { where?: Row }) => {
      const w = a.where ?? {};
      if (w.OR) return []; // returnedBySaleItem: لا مرتجع سابق
      const ids: string[] = (w.id as { in?: string[] } | undefined)?.in ?? [];
      return [{ id: 's-1', qty: 10, unitFactor: 1, lineTotal: 1000, taxPct: 0 }].filter(l => ids.includes(l.id));
    },
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
  rawScript = (sql: string) => {
    // lockInvoiceForCancel: صفّ المرتجع تحت القفل
    if (sql.includes('SELECT status, type, "paidAmt" FROM invoices')) return [{ status: returnDoc.status, type: returnDoc.type, paidAmt: 0 }];
    // lockInvoiceForCancel: لا مرتجع مرتبط بالمرتجع نفسه
    if (sql.includes('COUNT(*)::int AS n')) return [{ n: 0 }];
    // البند ١١: فاتورة بيع المرتجع من بنوده، مقفلةً ومقروءة
    if (sql.includes('si."invoiceId"')) return [{ id: sale.id, status: sale.status, total: sale.total, paidAmt: sale.paidAmt, remainingAmt: sale.remainingAmt }];
    // وإجمالي مرتجعاتها الأخرى القائمة (سقف الردّ)
    if (sql.includes('"otherReturns"')) return [{ otherReturns: otherReturnsTotal }];
    if (sql.includes('lock_timeout')) return [{ lock_timeout: '0' }];
    return [];
  };
}

const linkedReturn = (qty: number, over: Row = {}): Row => ({
  customerId: 'c-1', salesRepId: 'rep-1', type: 'RETURN', originalInvoiceId: 'sale-1', pricesIncludeTax: true, discountPct: 0,
  items: [{ productId: 'p-a', invoiceItemId: 's-1', qty, unitPrice: 1, discountPct: 0, taxPct: 0 }], ...over,
});
const freeReturn = (qty: number): Row => ({
  customerId: 'c-1', salesRepId: 'rep-1', type: 'RETURN', pricesIncludeTax: true, discountPct: 0,
  items: [{ productId: 'p-a', qty, unitPrice: 100, discountPct: 0, taxPct: 0 }],
});
const created = (): Row => {
  const a = (args['invoice.create'] ?? []).at(-1) as { data?: Row } | undefined;
  assert.ok(a?.data, `لم يُنشأ مستند: ${calls.join(' → ')}`);
  return a!.data!;
};
const saleUpdates = (): Row[] => ((args['invoice.update'] ?? []) as Array<{ where: { id: string }; data: Row }>)
  .filter(u => u.where.id === 'sale-1').map(u => u.data);
/** موضع نداءٍ في التسلسل بعد موضعٍ معلوم (لا أوّل ظهورٍ مطلقاً) */
const indexAfter = (key: string, from: number): number => calls.indexOf(key, from);
/** إماتة روابط الدفع خارج المعاملة وبعد الردّ (import ديناميكيّ) — تُنتظر بحدٍّ أقصى */
async function linkLookups(waitMs: number): Promise<Row[]> {
  const until = Date.now() + waitMs;
  while (Date.now() < until && !(args['customerPaymentLink.findMany'] ?? []).length) await new Promise(r => setTimeout(r, 20));
  return (args['customerPaymentLink.findMany'] ?? []) as Row[];
}

// ═══ (١) الدالة الصرفة ═══

test('linkedReturnRemainingApplied: الآجلة المؤكَّدة وحدها، بقدر المرتجع ولا فوق المتبقّي، وclean لا منزلتان', () => {
  const credit = (remainingAmt: number | null, over: Row = {}) => ({ type: 'CREDIT', status: 'CONFIRMED', remainingAmt, ...over });
  assert.equal(linkedReturnRemainingApplied(credit(1000), 300), 300);
  assert.equal(linkedReturnRemainingApplied(credit(100), 300), 100, 'الأكبر من المتبقّي يقف عنده');
  assert.equal(linkedReturnRemainingApplied(credit(0), 300), 0);
  assert.equal(linkedReturnRemainingApplied(credit(-5), 300), 0, 'متبقٍّ سالبٌ (بيانات قديمة) لا يُسقط شيئاً');
  assert.equal(linkedReturnRemainingApplied(credit(null), 300), 0);
  assert.equal(linkedReturnRemainingApplied(credit(1000), 0), 0);
  assert.equal(linkedReturnRemainingApplied(credit(1000), -10), 0);
  assert.equal(linkedReturnRemainingApplied(credit(10.555), 10.555), 10.555, 'الدينار بثلاث خانات لا يُقرَّب لمنزلتين');
  assert.equal(linkedReturnRemainingApplied(credit(700.1), 0.1 + 0.2), 0.3, 'غبار الأعداد العائمة يُنظَّف');
  assert.equal(linkedReturnRemainingApplied({ type: 'CASH', status: 'CONFIRMED', remainingAmt: 0 }, 300), 0, 'النقدية');
  assert.equal(linkedReturnRemainingApplied({ type: 'CASH', status: 'CONFIRMED', remainingAmt: 50 }, 300), 0, 'النقدية ولو حمل صفّها متبقّياً');
  assert.equal(linkedReturnRemainingApplied(credit(1000, { status: 'CANCELLED' }), 300), 0);
  assert.equal(linkedReturnRemainingApplied(credit(1000, { status: 'DRAFT' }), 300), 0);
  assert.equal(linkedReturnRemainingApplied(credit(1000, { type: 'RETURN' }), 300), 0);
  assert.equal(linkedReturnRemainingApplied(null, 300), 0);
});

test('restoredRemaining: يردّ المُسقَط مسقوفاً بـ total − paidAmt ولا يُنقص المتبقّي أبداً', () => {
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 0, remainingAmt: 700 }, 300), 1000);
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 700, remainingAmt: 0 }, 300), 300, 'سُدّد الباقي بعد المرتجع');
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 800, remainingAmt: 0 }, 300), 200, 'السقف: لا فوق الدَّين');
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 900, remainingAmt: 0 }, 100), 100, 'المُسقَط المقصوص يُردّ بقدره');
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 600, remainingAmt: 500 }, 100), 500, 'متبقٍّ فوق السقف أصلاً لا يُنقص');
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 0, remainingAmt: 700 }, 0), 700);
  assert.equal(restoredRemaining({ total: 10.555, paidAmt: 0, remainingAmt: 0 }, 10.555), 10.555);
  // مرتجعاتها الأخرى القائمة تُنقص السقف: بيع ١٠٠٠، مرتجع ٣٠٠ ثمّ سند ٧٠٠ ثمّ مرتجع ٢٠٠ لم يُسقط شيئاً — إلغاء الأول يعيد ١٠٠
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 700, remainingAmt: 0 }, 300, 200), 100, 'لا دَين وهمي من مرتجعٍ لاحقٍ مقصوص');
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 0, remainingAmt: 0 }, 300, 800), 200, 'الأخرى أسقطت الباقي كله');
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 700, remainingAmt: 0 }, 300, 500), 0, 'سقفٌ سالب يقف عند الصفر');
  assert.equal(restoredRemaining({ total: 1000, paidAmt: 0, remainingAmt: 800 }, 200, 300), 800, 'متبقٍّ قديم فوق الدَّين (مرتجعٌ قبل الميزة) لا يُنقص ولا يُزاد');
});

// ═══ (٢) الإصدار ═══

test('مرتجعٌ مرتبط بفاتورة بيعٍ آجلة: ينقص متبقّيها بقدره داخل معاملة الإصدار وقبل قيد العميل، ويُسجَّل المُسقَط على المرتجع', async () => {
  reset();
  const r = await postInvoice(linkedReturn(3));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const data = created();
  assert.equal(data.type, 'RETURN');
  assert.equal(data.total, 300);
  assert.equal(data.remainingAmt, 0, 'المرتجع نفسه بلا متبقٍّ كما كان');
  assert.equal(data.remainingApplied, 300, 'المُسقَط مسجَّلٌ على المرتجع');
  assert.equal(r.body.data.remainingApplied, 300, 'والردّ يحمله');
  assert.deepEqual(saleUpdates(), [{ remainingAmt: 700 }], 'كتابةٌ واحدة بالقيمة المحسوبة تحت القفل');
  assert.equal(sale.remainingAmt, 700);
  // التسلسل: قفل فاتورة البيع وقراءتها داخل المعاملة، ثم الإنشاء، ثم المتبقّي، ثم قيد العميل
  const tx = calls.indexOf('$transaction');
  const lockAt = rawSql.findIndex(s => s.includes('SELECT id FROM invoices WHERE id = ? AND "tenantId" = ? FOR UPDATE'));
  assert.ok(lockAt >= 0, 'قفل فاتورة البيع');
  const readAt = calls.findIndex((c, i) => i > tx && c === 'invoice.findFirst' && (args['invoice.findFirst'] as Row[])[calls.slice(0, i).filter(x => x === 'invoice.findFirst').length]?.select?.remainingAmt);
  const createAt = indexAfter('invoice.create', tx);
  const updateAt = indexAfter('invoice.update', createAt);
  const ledgerAt = indexAfter('accountEntry.create', createAt);
  assert.ok(tx >= 0 && readAt > tx && readAt < createAt, `قراءة المتبقّي داخل المعاملة قبل الإنشاء: ${calls.join(' → ')}`);
  assert.ok(updateAt > createAt && updateAt < ledgerAt, `المتبقّي بعد الإنشاء وقبل قيد العميل: ${calls.join(' → ')}`);
  // قيد العميل بإجمالي المرتجع كما كان (الرصيد ينقص ٣٠٠)
  const entry = (args['accountEntry.create'] as Array<{ data: Row }>).at(-1)!.data;
  assert.equal(entry.credit, 300);
  assert.equal(entry.type, 'INVOICE_CREDIT');
  // رابط دفعٍ قائم على فاتورة البيع بمبلغها القديم يموت بعد الالتزام (كالإشعار الدائن)
  const links = await linkLookups(3000);
  assert.equal(links.length, 1, 'لم تُفحص روابط فاتورة البيع');
  assert.equal(links[0].where?.invoiceId, 'sale-1');
  assert.equal(links[0].where?.status, 'initiated');
});

test('مرتجعٌ أكبر من متبقّي الفاتورة: يقف المتبقّي عند الصفر ويُسجَّل المقصوص — والفائض رصيدٌ دائن في قيد العميل بالإجمالي', async () => {
  reset(ADMIN, { sale: { paidAmt: 900, remainingAmt: 100 } });
  const r = await postInvoice(linkedReturn(3));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(created().remainingApplied, 100);
  assert.deepEqual(saleUpdates(), [{ remainingAmt: 0 }]);
  assert.equal(sale.remainingAmt, 0);
  assert.equal((args['accountEntry.create'] as Array<{ data: Row }>).at(-1)!.data.credit, 300, 'القيد بالإجمالي لا بالمُسقَط');
});

test('مرتجعان متتاليان على الفاتورة نفسها: الثاني يُسقط ما بقي وحده', async () => {
  reset();
  assert.equal((await postInvoice(linkedReturn(6))).status, 201);
  assert.equal(created().remainingApplied, 600);
  assert.equal(sale.remainingAmt, 400);
  calls = []; args = {};
  assert.equal((await postInvoice(linkedReturn(4))).status, 201);
  assert.equal(created().remainingApplied, 400);
  assert.equal(sale.remainingAmt, 0);
});

test('الأصل النقدي، والآجلة المسدَّدة، والمرتجع الحرّ: لا كتابة على فاتورة البيع ولا عمود remainingApplied', async () => {
  for (const [name, saleOver] of [
    ['نقدية', { type: 'CASH', paidAmt: 1000, remainingAmt: 0 }],
    ['آجلة مسدَّدة', { paidAmt: 1000, remainingAmt: 0 }],
  ] as Array<[string, Partial<Sale>]>) {
    reset(ADMIN, { sale: saleOver });
    const r = await postInvoice(linkedReturn(3));
    assert.equal(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal('remainingApplied' in created(), false, `${name}: عمودٌ بلا مُسقَط`);
    assert.deepEqual(saleUpdates(), [], `${name}: كتابةٌ على فاتورة البيع`);
    assert.equal(sale.remainingAmt, saleOver.remainingAmt);
    assert.equal((args['accountEntry.create'] as Array<{ data: Row }>).at(-1)!.data.credit, 300, `${name}: القيد كما كان`);
  }
  reset();
  const r = await postInvoice(freeReturn(2));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal('remainingApplied' in created(), false);
  assert.deepEqual(saleUpdates(), []);
  assert.equal(sale.remainingAmt, 1000);
  assert.ok(!((args['invoice.findFirst'] ?? []) as Row[]).some(a => a?.select?.remainingAmt), 'المرتجع الحرّ لا يقرأ متبقّي شيء');
  assert.deepEqual(await linkLookups(300), [], 'لا إسقاط ⇒ لا مساس بروابط الدفع');
});

// ═══ (٣) الإلغاء ═══

test('إلغاء المرتجع: يردّ المُسقَط بعينه إلى فاتورة البيع — بعد قفل المرتجع وقبل عكس قيد العميل، والقفل بشركتها FOR UPDATE', async () => {
  reset(ADMIN, { sale: { remainingAmt: 700 } });
  returnDoc.remainingApplied = 300;
  const r = await cancelInvoice('ret-1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(returnDoc.status, 'CANCELLED');
  assert.deepEqual(saleUpdates(), [{ remainingAmt: 1000 }]);
  assert.equal(sale.remainingAmt, 1000);
  const lockAt = rawSql.findIndex(s => s.includes('SELECT status, type, "paidAmt" FROM invoices'));
  const restoreAt = rawSql.findIndex(s => s.includes('si."invoiceId"'));
  assert.ok(lockAt >= 0 && restoreAt > lockAt, 'الردّ بعد قفل المرتجع');
  const restoreSql = rawSql[restoreAt];
  assert.match(restoreSql, /s\."tenantId" = \?/);
  assert.match(restoreSql, /JOIN invoice_items si ON si\.id = r\."returnOfItemId"/);
  assert.match(restoreSql, /FOR UPDATE\s*$/);
  const saleWrite = calls.findIndex((c, i) => c === 'invoice.update' && (args['invoice.update'] as Row[])[calls.slice(0, i).filter(x => x === 'invoice.update').length]?.where?.id === 'sale-1');
  const reverseAt = calls.indexOf('accountEntry.create');
  assert.ok(saleWrite >= 0 && reverseAt > saleWrite, `ردّ المتبقّي قبل عكس قيد العميل: ${calls.join(' → ')}`);
  const reversal = (args['accountEntry.create'] as Array<{ data: Row }>).at(-1)!.data;
  assert.equal(reversal.debit, 300, 'عكس القيد بإجمالي المرتجع كما كان');
});

test('إلغاء المرتجع بعد سدادٍ من الفاتورة: يُردّ المُسقَط مسقوفاً بما عليها (total − paidAmt)', async () => {
  // سدّد العميل ٧٠٠ بعد مرتجع ٣٠٠ ⇒ المتبقّي صفر؛ الإلغاء يعيد ٣٠٠ (= ١٠٠٠ − ٧٠٠)
  reset(ADMIN, { sale: { paidAmt: 700, remainingAmt: 0 } });
  returnDoc.remainingApplied = 300;
  assert.equal((await cancelInvoice('ret-1')).status, 200);
  assert.equal(sale.remainingAmt, 300);
  // والسقف حين يزيد المسدَّد على ما يتّسع له: لا فوق الدَّين
  reset(ADMIN, { sale: { paidAmt: 800, remainingAmt: 0 } });
  returnDoc.remainingApplied = 300;
  assert.equal((await cancelInvoice('ret-1')).status, 200);
  assert.equal(sale.remainingAmt, 200);
});

test('إلغاء المرتجع وعلى الفاتورة مرتجعٌ لاحقٌ قُصّ مُسقَطه: يُردّ ما يبقى ديناً فعلاً لا المُسقَط كله', async () => {
  // بيع ١٠٠٠؛ R1 ٣٠٠ (أسقط ٣٠٠ ⇒ ٧٠٠)؛ سند ٧٠٠ (⇒ صفر)؛ R2 ٢٠٠ (لا متبقٍّ فلم يُسقط شيئاً، ائتمانٌ للعميل). إلغاء R1:
  // رصيد العميل على الفاتورة ١٠٠٠ − ٧٠٠ − ٢٠٠ = ١٠٠ — لا ٣٠٠ (دينٌ وهمي ٢٠٠ في الفواتير المفتوحة والتوزيع ورابط الدفع)
  reset(ADMIN, { sale: { paidAmt: 700, remainingAmt: 0 } });
  returnDoc.remainingApplied = 300;
  otherReturnsTotal = 200;
  assert.equal((await cancelInvoice('ret-1')).status, 200);
  assert.equal(sale.remainingAmt, 100);
  const lockAt = rawSql.findIndex(s => s.includes('si."invoiceId"'));
  const otherAt = rawSql.findIndex(s => s.includes('"otherReturns"'));
  assert.ok(lockAt >= 0 && otherAt > lockAt, 'المرتجعات الأخرى تُقرأ تحت قفل فاتورة البيع');
  const q = rawSql[otherAt];
  assert.match(q, /o\."tenantId" = \?/);
  assert.match(q, /o\.status = 'CONFIRMED' AND o\.type = 'RETURN' AND o\.id <> \?/, 'القائمة وحدها وبلا الملغى نفسه');
  assert.match(q, /JOIN invoice_items sl ON sl\.id = ol\."returnOfItemId"/, 'المرتبطة ببنودها');
  assert.match(q, /UNION\s+SELECT cn\.id FROM invoices cn WHERE cn\."originalInvoiceId" = \?/, 'والإشعارات الدائنة عليها، كلٌّ مرةً');
  // ولا مرتجع غيره: الردّ كما كان (١٠٠٠ − ٧٠٠ = ٣٠٠)
  reset(ADMIN, { sale: { paidAmt: 700, remainingAmt: 0 } });
  returnDoc.remainingApplied = 300;
  assert.equal((await cancelInvoice('ret-1')).status, 200);
  assert.equal(sale.remainingAmt, 300);
});

test('إلغاء مرتجعٍ بلا مُسقَطٍ مسجَّل (حرّ، أو على نقدية، أو قبل الميزة): لا استعلام ولا كتابة على أي فاتورة بيع', async () => {
  for (const applied of [null, 0]) {
    reset(ADMIN, { sale: { remainingAmt: 1000 } });
    returnDoc.remainingApplied = applied;
    const r = await cancelInvoice('ret-1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rawSql.some(s => s.includes('si."invoiceId"')), false, `${applied}: استعلامٌ بلا مُسقَط`);
    assert.deepEqual(saleUpdates(), []);
    assert.equal(sale.remainingAmt, 1000);
  }
});

test('إلغاء مرتجعٍ فاتورة بيعه ملغاة (بيانات قديمة): لا تُحيا ديونها', async () => {
  reset(ADMIN, { sale: { status: 'CANCELLED', remainingAmt: 700 } });
  returnDoc.remainingApplied = 300;
  assert.equal((await cancelInvoice('ret-1')).status, 200);
  assert.deepEqual(saleUpdates(), []);
});

test('دورة كاملة: إصدار ثم إلغاء يعيدان المتبقّي كما كان بالضبط', async () => {
  // متبقٍّ غير مستدير (بقايا كسورٍ قديمة): الإسقاط ثم الردّ يعودان إليه بلا غبار ولا فرق
  reset(ADMIN, { sale: { total: 1000.555, remainingAmt: 1000.555 } });
  assert.equal((await postInvoice(linkedReturn(3))).status, 201);
  const applied = created().remainingApplied as number;
  assert.ok(applied > 0);
  const after = sale.remainingAmt;
  assert.equal(after, Math.round((1000.555 - applied) * 1e6) / 1e6);
  returnDoc.remainingApplied = applied;
  calls = []; args = {}; rawSql = [];
  assert.equal((await cancelInvoice('ret-1')).status, 200);
  assert.equal(sale.remainingAmt, 1000.555);
});

// ═══ (٤) إعادة الرفع ═══

test('إعادة رفع المندوب لمرتجعٍ التُزم (clientRef قائم): يُعاد القائم ولا يُسقط من المتبقّي مرّةً ثانية', async () => {
  reset(REP_USER, { sale: { remainingAmt: 700 } });
  existingByRef = { id: 'ret-1', type: 'RETURN', customerId: 'c-1', remainingApplied: 300, items: [], customer: CUSTOMER };
  const r = await postInvoice(linkedReturn(3, { clientRef: '3f1c2b9e-6a1d-4c7e-9b2a-1d5e8f0a7c41' }), { 'X-FS-Replay': '1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.idempotent, true);
  assert.ok(!calls.includes('$transaction') && !calls.includes('invoice.create'), calls.join(' → '));
  assert.deepEqual(saleUpdates(), []);
  assert.equal(sale.remainingAmt, 700);
});

test('سباق رفعين بالـclientRef نفسه (P2002 عند الإنشاء): المعاملة تسقط قبل أي كتابة على فاتورة البيع، ويُعاد القائم', async () => {
  reset(ADMIN);
  let lookups = 0;
  scripted['invoice.findUnique'] = () => (++lookups === 1 ? null : { id: 'ret-1', type: 'RETURN', customerId: 'c-1', remainingApplied: 300, items: [], customer: CUSTOMER });
  scripted['invoice.create'] = () => { throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['tenantId', 'clientRef'] } }); };
  const r = await postInvoice(linkedReturn(3, { clientRef: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.idempotent, true);
  assert.deepEqual(saleUpdates(), [], 'الإسقاط بعد الإنشاء: سباقٌ يرمي عند الإنشاء لا يبلغه');
  assert.equal(sale.remainingAmt, 1000);
  assert.ok(!calls.includes('accountEntry.create'));
});

// ═══ (٥) المرحلة الثانية: الإشعار الدائن كما هو ═══

test('شركةٌ في المرحلة الثانية: المرتجع إشعارٌ دائن عبر issueReturnAsCreditNote — لا إنشاء ولا كتابة على المتبقّي من مسار المرحلة الأولى', async () => {
  reset(ADMIN, { settings: PHASE2_SETTINGS });
  const r = await postInvoice(linkedReturn(3));
  assert.equal(creditNoteCalls.length, 1, `لم يُسلَّم للإشعار الدائن: ${r.status} ${JSON.stringify(r.body)} — ${calls.join(' → ')}`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.documentKind, 'CREDIT_NOTE');
  assert.equal(creditNoteCalls[0].ctx.originalInvoiceId, 'sale-1');
  assert.equal(creditNoteCalls[0].deps, PHASE2_DEPS);
  assert.equal('remainingApplied' in creditNoteCalls[0].ctx, false);
  assert.ok(!calls.includes('invoice.create') && !calls.includes('invoice.update'), calls.join(' → '));
  assert.ok(!((args['invoice.findFirst'] ?? []) as Row[]).some(a => a?.select?.remainingAmt), 'لا قراءة متبقٍّ في فرع المرحلة الثانية');
  assert.equal(sale.remainingAmt, 1000);
});

test('حارس نصّي: إسقاط الإشعار الدائن وردّه عند إبطاله كما كانا، ولا يعرفان remainingApplied؛ والإلغاء اليدويّ للمرحلة الثانية مرفوضٌ قبل الردّ', () => {
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const notes = read('routes/invoicesNotes.ts');
  assert.ok(notes.includes('remaining = remainingAfterCreditNote(locked.original, total);'));
  assert.ok(notes.includes('await t.invoice.update({ where: { id: locked.original.id }, data: { remainingAmt: { decrement: remaining.decrement } } });'));
  assert.doesNotMatch(notes, /remainingApplied|restoreReturnRemaining/);
  const voidSrc = read('services/invoiceVoid.ts');
  assert.ok(voidSrc.includes('LEAST("total" - "paidAmt", "remainingAmt" + ${amount})'));
  assert.ok(voidSrc.includes("if (inv.documentKind === 'CREDIT_NOTE' && typeof inv.originalInvoiceId === 'string' && inv.originalInvoiceId !== '') {"));
  assert.doesNotMatch(voidSrc, /remainingApplied|restoreReturnRemaining/);

  const inv = read('routes/invoices.ts');
  const create = inv.slice(inv.indexOf("router.post('/', async"), inv.indexOf("router.patch('/:id/cancel'"));
  // الإسقاط في مسار المرحلة الأولى وحده: بعد فرع الإشعار الدائن (الذي يعود قبله) وداخل المعاملة بعد قفل فاتورة البيع
  const noteBranch = create.indexOf('const note = await issueReturnAsCreditNote({');
  const lock = create.indexOf('lines: saleLinkLines, lock: true });');
  const read11 = create.indexOf('remainingApplied = linkedReturnRemainingApplied(saleDue, priced.total);');
  const write11 = create.indexOf('await tx.invoice.update({ where: { id: saleForReturn }, data: { remainingAmt: saleRemainingAfter } });');
  const ledger = create.indexOf('await postReturnEntries(tx as never, tid, inv.id, customerId, priced.total, docDate);');
  assert.ok(noteBranch > 0 && lock > noteBranch && read11 > lock && write11 > read11 && ledger > write11, 'ترتيب الإسقاط');

  const cancel = inv.slice(inv.indexOf("router.patch('/:id/cancel'"), inv.indexOf('// ═══ ZATCA المرحلة الثانية (Z5.5): الإشعارات الدائنة والمدينة ═══'));
  const phase2Refusal = cancel.indexOf('if (invoice.zatcaPhase === 2) {');
  const restore = cancel.indexOf("if (invoice.type === 'RETURN') await restoreReturnRemaining(tx, tid, invoice.id, invoice.remainingApplied);");
  assert.ok(phase2Refusal > 0 && restore > phase2Refusal, 'الإشعار الدائن (zatcaPhase=2) يُرفض إلغاؤه قبل أي ردّ');
  assert.ok(restore > cancel.indexOf('await lockInvoiceForCancel(tx, tid, invoice.id);'), 'الردّ بعد قفل المرتجع');
  assert.ok(restore < cancel.indexOf('await reverseInvoiceInTx('), 'الردّ قبل عكس القيد (invoices ⇒ customers)');
});
