// «سجلّ العميل» — اختبارات سلوكية (QA، ٢٦ نوفمبر ٢٠٢٦): نداءات حقيقية في المسارات والخدمات فوق Prisma مزيّف **بمعاملاتٍ تُتراجع**
// (ما كُتب في معاملةٍ فشلت أو فشل التزامها لا يبقى)، بلا قاعدة ولا شبكة ولا خادم. يثبت:
//   ١) كل إجراءٍ ممثَّل يكتب حدثاً واحداً بإجرائه وفاعله (نوعه واسمه) وعميله ومرجعه ورقمه ومبلغه — الفاتورة والمرتجع والإلغاء
//      والإبطال، السند وإلغاؤه، إضافة العميل (الإدارة والمندوب) وتعديله بفرقه (والرصيد وحده بلا حدث) وموقعه، الوثيقة رفعاً وحذفاً،
//      الزيارة، حفظ خطّ السير (لا حدث لمحطّةٍ بقيت)، الإسناد، سداد رابط الدفع (العميل فاعلاً)، طلب المنيو العام.
//   ٢) الذرّية: معاملة الإجراء التي ترمي بعد التسجيل (أو يفشل التزامها) لا تُبقي حدثاً.
//   ٣) تنظيف المُدخل: الكبير يُقصّ، وundefined يسقط، والأشكال الرديئة لا ترمي أبداً.
//   ٤) القراءة: عزل الشركة، المندوب خارج نطاقه ٤٠٤، المالك والموظف، الاشتقاق التاريخي والإسقاط بالسجلّ، الترتيب، الترقيم بلحظاتٍ
//      متساوية بلا تكرارٍ ولا فجوة، سقف الحدّ، ومرشّح القسم.
//   ٥) المُطلِق يمنع التعديل والحذف إلا بإذن fs.activity_purge='on'، وكل مسار حذفٍ للشركة كلها يأذن داخل معاملته.
// اختبارٌ اسمه يبدأ بـ«BUG» دليلُ خللٍ قائم — يفشل حتى يُصلَح (انظر نصّه لما يُتوقَّع).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';

const SRC = path.join(__dirname, '..');
const BACKEND = path.join(SRC, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
type Row = Record<string, any>;

// ═══════════════════ Prisma مزيّف بمعاملاتٍ تُلتزم أو تُتراجع ═══════════════════

type Call = { op: string; args: any; tx: number | null };
let calls: Call[] = [];
/** كل نداءات النماذج عبر الاختبارات كلها (لا تُصفَّر) — يفحصها اختبار المخطّط أدناه */
const allModelCalls: { model: string; method: string; args: any }[] = [];
let scripted: Record<string, (args: any, tx: number | null) => unknown> = {};
let raw: (sql: string, values: unknown[], tx: number | null) => unknown = () => [];
/** أسطر السجلّ الملتزمة — ومعها رقم المعاملة التي كتبتها (null = كتابةٌ مستقلّة خارج أي معاملة) */
let committed: { row: Row; tx: number | null }[] = [];
/** عدد المعاملات القادمة التي يفشل التزامها (بعد نجاح ردّ النداء — كفشل التسلسل أو انقطاع الاتصال عند COMMIT) */
let failCommits = 0;
let txSeq = 0;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0, amount: 0 }, _count: { _all: 0 }, _max: { date: null } };
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}

function delegate(model: string, tx: number | null, sink: { row: Row; tx: number | null }[] | null): unknown {
  return new Proxy({}, {
    get: (_t, method: string) => {
      if (method === 'then') return undefined;
      return async (args: any) => {
        calls.push({ op: `${model}.${method}`, args, tx });
        allModelCalls.push({ model, method, args });
        const fn = scripted[`${model}.${method}`];
        if (model === 'customerActivity' && method === 'createMany') {
          if (fn) await fn(args, tx); // قد يرمي (خطأ القاعدة)
          const rows = (args?.data ?? []).map((d: Row) => ({ row: { ...d }, tx }));
          (sink ?? committed).push(...rows);
          return { count: rows.length };
        }
        return fn ? fn(args, tx) : defaultFor(method);
      };
    },
  });
}

function sqlOf(strings: unknown): string {
  if (Array.isArray(strings)) return (strings as string[]).join('?');
  const s = strings as { sql?: string; strings?: string[] } | string;
  if (typeof s === 'string') return s;
  return s?.sql ?? (Array.isArray(s?.strings) ? s.strings.join('?') : String(s));
}

function client(tx: number | null, sink: { row: Row; tx: number | null }[] | null): Row {
  return new Proxy({}, {
    get: (_t, key: string) => {
      if (key === 'then') return undefined;
      if (key === '$transaction') {
        return async (arg: unknown, opts?: unknown) => {
          if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
          if (tx !== null) return (arg as (t: unknown) => Promise<unknown>)(client(tx, sink)); // لا معاملة متداخلة في Prisma
          const id = ++txSeq;
          const buf: { row: Row; tx: number | null }[] = [];
          calls.push({ op: '$transaction', args: opts ?? null, tx: id });
          try {
            const out = await (arg as (t: unknown) => Promise<unknown>)(client(id, buf));
            if (failCommits > 0) {
              failCommits--;
              throw Object.assign(new Error('simulated COMMIT failure'), { code: 'P2034' });
            }
            committed.push(...buf);
            calls.push({ op: '$commit', args: null, tx: id });
            return out;
          } catch (e) {
            calls.push({ op: '$rollback', args: (e as Error)?.message ?? null, tx: id });
            throw e;
          }
        };
      }
      if (key === '$queryRaw' || key === '$executeRaw' || key === '$queryRawUnsafe' || key === '$executeRawUnsafe') {
        return async (strings: unknown, ...values: unknown[]) => {
          const sql = sqlOf(strings).replace(/\s+/g, ' ');
          calls.push({ op: key, args: { sql, values }, tx });
          const out = raw(sql, values, tx);
          if (out !== undefined) return out;
          return key.startsWith('$query') ? [] : 0;
        };
      }
      return delegate(key, tx, sink);
    },
  });
}
const prismaFake = client(null, null);

function reset(): void {
  calls = []; scripted = {}; committed = []; failCommits = 0;
  raw = () => undefined;
}
const events = (): Row[] => committed.map((c) => c.row);
const eventsOf = (action: string): Row[] => events().filter((r) => r.action === action);
/** كل كتابات السجلّ (ملتزمةً أو متراجعة) مع معاملتها */
const activityWrites = (): Call[] => calls.filter((c) => c.op === 'customerActivity.createMany');

// ═══════════════════ الحقن قبل تحميل المسارات ═══════════════════

const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
const realAuth = require('../middleware/auth') as typeof import('../middleware/auth');
stub('middleware/auth', {
  ...realAuth,
  authenticate: pass, requireAdmin: pass, requireAdminPermission: () => pass, requireSalesRep: pass, requireSuperAdmin: pass,
  requireDailyReport: pass, requirePaymentMethods: pass, requireLocations: pass, requireLots: pass, requireAiAccountant: pass,
  requireAccounting: pass, requireAccountingSuite: pass, requireLedgerPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
const realAdminScope = require('../services/adminScope') as typeof import('../services/adminScope');
stub('services/adminScope', {
  ...realAdminScope,
  adminScopeEnabled: async () => false, adminCustomerFilter: async () => ({}), adminRepFilter: async () => ({}),
  scopedRecordWhere: async () => ({}), scopedRepRecordWhere: async () => ({}), canAccessRep: async () => true,
  canAccessCustomerAsAdmin: async () => true, existingInScope: async () => true,
});
const realPurge = require('../services/ownerPurge') as typeof import('../services/ownerPurge');
let purgeImpl: () => Promise<unknown> = async () => ({ counts: {}, nullCounts: {} });
stub('services/ownerPurge', { ...realPurge, purgeInTx: async () => { calls.push({ op: 'purgeInTx', args: null, tx: null }); return purgeImpl(); } });
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('phase-2 branch must not run in these tests'); } });
let moyasarInvoice: Row = { status: 'paid', amount: 11500, currency: 'SAR', payments: [{ id: 'pay-1', status: 'paid' }] };
stub('services/moyasar', {
  moyasarConfigured: () => true,
  fetchInvoice: async () => moyasarInvoice,
  fetchPayment: async () => ({}),
  createInvoice: async () => ({ id: 'moy-x', url: 'https://example.invalid/x' }),
  cancelInvoice: async () => ({}),
  sarToHalalas: (s: number) => Math.round(s * 100),
});
const realWebPush = require('../services/webPush') as Row;
stub('services/webPush', { ...realWebPush, sendPushToRep: async () => 0, sendPushToAdmins: async () => 0, sendPush: async () => 'sent' });

const invoicesRouter = require('../routes/invoices').default;
const receiptsRouter = require('../routes/receipts').default;
const customersRouter = require('../routes/customers').default;
const { customerStudioRouter } = require('../routes/customerStudio');
const visitsRouter = require('../routes/visits').default;
const repRoutesRouter = require('../routes/repRoutes').default;
const salesRepsRouter = require('../routes/salesReps').default;
const publicCatalogRouter = require('../routes/publicCatalog').default;
const { confirmLinkPayment } = require('../services/paylink') as typeof import('../services/paylink');
const { voidInvoiceInTx } = require('../services/invoiceVoid') as typeof import('../services/invoiceVoid');
const ca = require('../services/customerActivity') as typeof import('../services/customerActivity');
const guard = require('../services/customerActivityGuard') as typeof import('../services/customerActivityGuard');
const readApi = require('../routes/customerActivity') as typeof import('../routes/customerActivity');

// ═══════════════════ تشغيل مكدّس المسار ═══════════════════

type Reply = { status: number; body: any; error: unknown };
async function call(router: unknown, method: string, p: string, req: Row, opts: { lastOnly?: boolean } = {}): Promise<Reply> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} missing`);
  const res: Row = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: unknown) => { res.headers[k.toLowerCase()] = v; return res; };
  res.set = res.setHeader;
  res.end = () => res;
  const full = { method: method.toUpperCase(), url: p, query: {}, params: {}, body: {}, headers: {}, ip: '127.0.0.1', ...req };
  const stack: Row[] = opts.lastOnly ? [layer!.route.stack.at(-1)] : layer!.route.stack;
  for (const h of stack) {
    let passed = false;
    let err: unknown = null;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) return { status: 500, body: null, error: err };
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body, error: null };
}
const why = (r: Reply): string => (r.error ? String((r.error as Error)?.stack ?? r.error) : JSON.stringify(r.body));
const tick = () => new Promise((r) => setImmediate(r));
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = console.error; const w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
}

// ═══════════════════ بيانات مشتركة ═══════════════════

const T = 'T1';
const ADMIN = { id: 'admin-1', role: 'ADMIN', tenantId: T, name: 'سارة' };
const REP = { id: 'rep-1', role: 'SALES_REP', tenantId: T, name: 'خالد' };
const OWNER_SESSION = { id: 'admin-1', role: 'ADMIN', tenantId: T, name: 'مدير الشركة', impersonated: true, by: 'owner-1', byKind: 'OWNER' };
const CUSTOMER = { id: 'c-1', tenantId: T, name: 'بقالة الأمل', status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, priceListId: null, phone: '0501234567' };

/** حقول الحدث الأساسية للمقارنة */
const core = (r: Row) => ({
  action: r.action, tenantId: r.tenantId, customerId: r.customerId, actorKind: r.actorKind, actorId: r.actorId, actorName: r.actorName,
  refType: r.refType, refId: r.refId, refNo: r.refNo, amount: r.amount == null ? null : Number(r.amount),
});

// ─── إصدار الفاتورة (نمط tax-off-invoices.test.ts) ───

const productRow = (id: string, name: string, basePrice: number): Row => ({
  id, name, unit: 'حبة', basePrice, taxPct: 15, damagedReturnToStock: true, priceTiers: [], units: [], teams: [], categoryId: null,
  lotTracked: false, repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null, primaryUnitId: null, shelfLifeEnabled: false, returnRuleEnabled: false,
});
const PRODUCTS = [productRow('p-a', 'صنف أ', 100)];
const REP_ROW: Row = {
  id: 'rep-1', tenantId: T, name: 'خالد', canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, canCreateReceipt: true,
  canCancelReceipt: true, canAddCustomer: true, canEditCustomer: true, maxDiscountPct: 100, requireLocationOn: false,
  tenant: { settings: { teamsEnabled: false, paymentMethodsConfig: null } }, teamMemberships: [],
};
const SETTINGS: Row = {
  defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null,
  returnRequiresSaleInvoice: null, returnPolicyChangedAt: null,
};
let invoiceCreates = 0;
function scriptInvoicePost(o: { createError?: unknown } = {}): void {
  invoiceCreates = 0;
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => REP_ROW,
    'customer.findFirst': () => CUSTOMER,
    'product.findMany': (a: Row) => { const ids: string[] = a.where?.id?.in ?? []; return PRODUCTS.filter((p) => ids.includes(p.id)); },
    'companySettings.findUnique': (a: Row) => (a.select?.defaultVatPct ? { ...SETTINGS } : { customerIsolationEnabled: false }),
    'tenant.findUnique': () => ({ invoiceSignatureEnabled: false, lotTrackingEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => null,
    'invoice.create': (a: Row) => {
      invoiceCreates++;
      if (o.createError && invoiceCreates === 1) throw o.createError;
      const items = ((a.data.items as { create?: Row[] } | undefined)?.create ?? []).map((i, k) => ({ id: `it${k}`, ...i }));
      return { id: `inv-${invoiceCreates}`, ...a.data, items, customer: CUSTOMER, installments: [], signature: null };
    },
  };
}
const saleBody = (over: Row = {}): Row => ({
  customerId: 'c-1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: true, discountPct: 0,
  items: [{ productId: 'p-a', qty: 2, unitPrice: 115, discountPct: 0, taxPct: 15 }], ...over,
});
const createdInvoice = (): Row => calls.filter((c) => c.op === 'invoice.create').at(-1)!.args.data;

// ═══════════════════ ١) كل إجراء ⇒ حدثٌ واحد صحيح ═══════════════════

test('فاتورة البيع (مندوب): حدث INVOICE_ISSUED واحد بفاعل المندوب واسمه، ومرجع الفاتورة ورقمها وإجماليها — داخل معاملة الإصدار', async () => {
  reset();
  scriptInvoicePost();
  const r = await call(invoicesRouter, 'post', '/', { user: REP, body: saleBody() });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  const inv = createdInvoice();
  assert.deepEqual(core(events()[0]), {
    action: 'INVOICE_ISSUED', tenantId: T, customerId: 'c-1', actorKind: 'REP', actorId: 'rep-1', actorName: 'خالد',
    refType: 'INVOICE', refId: 'inv-1', refNo: inv.number, amount: Number(inv.total),
  });
  assert.equal(events()[0].source, 'rep');
  assert.equal(events()[0].data.paymentType, 'CASH');
  assert.notEqual(committed[0].tx, null, 'الحدث كُتب بمقبض المعاملة');
  assert.ok(typeof inv.number === 'string' && inv.number.length > 0);
});

test('المرتجع (إدارة): حدث RETURN_ISSUED واحد بفاعل الإدارة — لا INVOICE_ISSUED', async () => {
  reset();
  scriptInvoicePost();
  const r = await call(invoicesRouter, 'post', '/', { user: ADMIN, body: saleBody({ type: 'RETURN' }) });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  const e = events()[0];
  assert.deepEqual([e.action, e.actorKind, e.actorId, e.actorName, e.refType, e.refId, e.source], ['RETURN_ISSUED', 'ADMIN', 'admin-1', 'سارة', 'INVOICE', 'inv-1', 'web']);
  assert.equal(Number(e.amount), Number(createdInvoice().total));
  assert.equal(ca.categoryOfAction(e.action), 'returns');
});

test('الذرّية: تصادم رقم الفاتورة (P2002) يُعيد المعاملة — حدثٌ واحد للفاتورة التي التزمت لا اثنان', async () => {
  reset();
  scriptInvoicePost({ createError: Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: ['tenantId', 'number'] } }) });
  const r = await call(invoicesRouter, 'post', '/', { user: ADMIN, body: saleBody() });
  assert.equal(r.status, 201, why(r));
  assert.equal(invoiceCreates, 2, 'أُعيدت المحاولة');
  assert.equal(events().length, 1);
  assert.equal(events()[0].refId, 'inv-2', 'حدث الفاتورة الملتزمة');
});

test('الذرّية: فشل التزام معاملة الإصدار ⇒ لا حدث يبقى (والمسار يفشل)', async () => {
  reset();
  scriptInvoicePost();
  failCommits = 1;
  const r = await quiet(() => call(invoicesRouter, 'post', '/', { user: ADMIN, body: saleBody() }));
  assert.notEqual(r.status, 201);
  assert.ok(activityWrites().length >= 1, 'الحدث كُتب داخل المعاملة قبل فشلها');
  assert.equal(events().length, 0, 'لا حدث لفاتورةٍ لم تلتزم');
});

// ─── إلغاء الفاتورة ───

function scriptInvoiceCancel(): void {
  const inv = { id: 'inv-9', tenantId: T, number: 'INV-0009', status: 'CONFIRMED', type: 'CASH', customerId: 'c-1', salesRepId: 'rep-1', total: 230, paidAmt: 230, remainingAmt: 0, zatcaPhase: null, receiptItems: [], tenant: { lotTrackingEnabled: false }, remainingApplied: 0 };
  scripted = {
    'invoice.findFirst': () => ({ ...inv }),
    'invoice.count': () => 0,
    'invoice.update': (a: Row) => ({ ...inv, ...a.data }),
    'salesRep.findFirst': () => REP_ROW,
  };
  raw = (sql) => {
    if (/FROM invoices WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(sql)) return [{ status: 'CONFIRMED', type: 'CASH', paidAmt: 230 }];
    if (/COUNT\(\*\)::int AS n/.test(sql)) return [{ n: 0 }];
    return undefined;
  };
}

test('إلغاء الفاتورة: حدث INVOICE_CANCELLED واحد بسببه وفاعله ومرجعها — وفشل الالتزام لا يُبقيه', async () => {
  reset();
  scriptInvoiceCancel();
  const r = await call(invoicesRouter, 'patch', '/:id/cancel', { user: ADMIN, params: { id: 'inv-9' }, body: { reason: '  خطأ في الكمية  ' } });
  assert.equal(r.status, 200, why(r));
  await tick();
  assert.equal(events().length, 1, JSON.stringify(events()));
  const e = events()[0];
  assert.deepEqual(core(e), {
    action: 'INVOICE_CANCELLED', tenantId: T, customerId: 'c-1', actorKind: 'ADMIN', actorId: 'admin-1', actorName: 'سارة',
    refType: 'INVOICE', refId: 'inv-9', refNo: 'INV-0009', amount: 230,
  });
  assert.equal(e.data.reason, 'خطأ في الكمية');
  assert.notEqual(committed[0].tx, null);

  reset();
  scriptInvoiceCancel();
  failCommits = 1;
  const f = await quiet(() => call(invoicesRouter, 'patch', '/:id/cancel', { user: ADMIN, params: { id: 'inv-9' }, body: {} }));
  assert.equal(f.status, 500);
  assert.equal(events().length, 0);
});

// ─── إبطال الفاتورة (رفض الهيئة) ───

function voidTx(order: string[], opts: { throwAfter?: boolean } = {}) {
  const invoiceRow = {
    id: 'inv-v', tenantId: T, number: 'INV-0100', status: 'CONFIRMED', type: 'CREDIT', zatcaPhase: 2, invoiceSubtype: '01',
    einvoiceStatus: 'clearance_pending', customerId: 'c-1', total: 230, documentKind: 'INVOICE', originalInvoiceId: null,
  };
  return {
    $queryRaw: async (s: TemplateStringsArray) => {
      const sql = s.join('?');
      if (sql.includes('FROM invoices')) return [invoiceRow];
      return [];
    },
    $executeRaw: async () => 1,
    invoice: { update: async () => { order.push('invoice.update'); return invoiceRow; }, findUnique: async () => invoiceRow },
    notification: {
      create: async () => { order.push('notification.create'); return {}; },
    },
    customer: { update: async () => ({}), findUnique: async () => ({ balance: 230 }) },
    accountEntry: { create: async () => ({}), aggregate: async () => ({ _sum: { debit: 230, credit: 0 } }), findFirst: async () => ({ balance: 230 }) },
    customerActivity: {
      createMany: async (a: { data: Row[] }) => {
        order.push('activity');
        if (opts.throwAfter) throw Object.assign(new Error('could not serialize access'), { code: '40001' });
        return { count: a.data.length, rows: a.data };
      },
    },
  };
}

test('إبطال الفاتورة (رفض الهيئة): حدث INVOICE_VOIDED واحد بفاعل النظام داخل معاملة الإبطال — وخطأ الكتابة يُجهض الإبطال كلّه', async () => {
  reset();
  // معاملةٌ حقيقية الشكل من المزيّف: الحدث يلتزم مع الإبطال
  const order: string[] = [];
  const t = voidTx(order);
  const seen: Row[] = [];
  const wrapped = { ...t, customerActivity: { createMany: async (a: { data: Row[] }) => { seen.push(...a.data); return t.customerActivity.createMany(a); } } };
  const out = await voidInvoiceInTx(wrapped as never, {
    tenantId: T, invoiceId: 'inv-v', subtype: '01', reason: 'REJECTED', documentId: 'd-1', at: new Date(), errors: [{ code: 'BR-KSA-01', message: 'رفض' }],
  });
  assert.equal(out.voided, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(core(seen[0]), {
    action: 'INVOICE_VOIDED', tenantId: T, customerId: 'c-1', actorKind: 'SYSTEM', actorId: null, actorName: null,
    refType: 'INVOICE', refId: 'inv-v', refNo: 'INV-0100', amount: 230,
  });
  assert.deepEqual(seen[0].data.errors, [{ code: 'BR-KSA-01', message: 'رفض' }]);
  assert.ok(order.indexOf('activity') > order.indexOf('invoice.update'));
  // خطأ القاعدة في كتابة الحدث يصعد — فيُجهض معاملة الإبطال (لا إبطال بلا أثره)
  await assert.rejects(voidInvoiceInTx(voidTx([], { throwAfter: true }) as never, {
    tenantId: T, invoiceId: 'inv-v', subtype: '01', reason: 'REJECTED', documentId: 'd-1', at: new Date(),
  }), /serialize/);
});

// ─── سند القبض ───

function scriptReceiptPost(): void {
  scripted = {
    'receipt.findUnique': () => null,
    'salesRep.findFirst': () => REP_ROW,
    'customer.findFirst': () => CUSTOMER,
    'invoice.findMany': () => [{ id: 'inv-open', remainingAmt: 100, invoiceDate: new Date('2026-11-01T00:00:00Z') }],
    'receipt.create': (a: Row) => ({ id: 'rc-1', ...a.data }),
  };
  raw = (sql) => {
    if (/SELECT id, "remainingAmt", "paidAmt", "zatcaPhase", "einvoiceStatus" FROM invoices/.test(sql)) {
      return [{ id: 'inv-open', remainingAmt: 100, paidAmt: 0, zatcaPhase: null, einvoiceStatus: null }];
    }
    return undefined;
  };
}

test('سند القبض: حدث RECEIPT_ISSUED واحد بمبلغه ورقمه وتوزيعه (والفاتورة المسدّدة كاملاً settled) — وفشل الالتزام لا يُبقيه', async () => {
  reset();
  scriptReceiptPost();
  const r = await call(receiptsRouter, 'post', '/', { user: REP, body: { customerId: 'c-1', amount: 100, paymentMethod: 'CASH', invoiceAllocations: [{ invoiceId: 'inv-open', amount: 100 }] } });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  const e = events()[0];
  const rc = calls.find((c) => c.op === 'receipt.create')!.args.data;
  assert.deepEqual(core(e), {
    action: 'RECEIPT_ISSUED', tenantId: T, customerId: 'c-1', actorKind: 'REP', actorId: 'rep-1', actorName: 'خالد',
    refType: 'RECEIPT', refId: 'rc-1', refNo: rc.number, amount: 100,
  });
  assert.deepEqual(e.data.allocations, [{ invoiceId: 'inv-open', amount: 100, settled: true }]);
  assert.equal(e.data.paymentMethod, 'CASH');

  reset();
  scriptReceiptPost();
  failCommits = 1;
  const f = await quiet(() => call(receiptsRouter, 'post', '/', { user: REP, body: { customerId: 'c-1', amount: 100, paymentMethod: 'CASH' } }));
  assert.notEqual(f.status, 201);
  assert.equal(events().length, 0);
});

function scriptReceiptCancel(): void {
  const rc = { id: 'rc-7', tenantId: T, number: 'RCP-0007', status: 'ACTIVE', customerId: 'c-1', salesRepId: 'rep-1', amount: 80, paymentMethod: 'CASH', invoiceItems: [{ invoiceId: 'inv-a', amount: 80 }] };
  scripted = {
    'receipt.findFirst': () => ({ ...rc }),
    'receipt.updateMany': () => ({ count: 1 }),
    'receipt.findUniqueOrThrow': () => ({ ...rc, status: 'CANCELLED' }),
    'salesRep.findFirst': () => REP_ROW,
  };
  raw = (sql) => {
    if (/FROM invoices/.test(sql) && /FOR UPDATE/.test(sql)) return [{ id: 'inv-a', paidAmt: 80, remainingAmt: 0 }];
    return undefined;
  };
}

test('إلغاء السند: حدث RECEIPT_CANCELLED واحد بسببه وما أُعيد من توزيعه — وفشل الالتزام لا يُبقيه', async () => {
  reset();
  scriptReceiptCancel();
  const r = await call(receiptsRouter, 'patch', '/:id/cancel', { user: ADMIN, params: { id: 'rc-7' }, body: { reason: 'سند مكرر' } });
  assert.equal(r.status, 200, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  const e = events()[0];
  assert.deepEqual(core(e), {
    action: 'RECEIPT_CANCELLED', tenantId: T, customerId: 'c-1', actorKind: 'ADMIN', actorId: 'admin-1', actorName: 'سارة',
    refType: 'RECEIPT', refId: 'rc-7', refNo: 'RCP-0007', amount: 80,
  });
  assert.equal(e.data.reason, 'سند مكرر');
  assert.deepEqual(e.data.allocations, [{ invoiceId: 'inv-a', amount: 80 }]);

  reset();
  scriptReceiptCancel();
  failCommits = 1;
  const f = await quiet(() => call(receiptsRouter, 'patch', '/:id/cancel', { user: ADMIN, params: { id: 'rc-7' }, body: {} }));
  assert.notEqual(f.status, 200);
  assert.equal(events().length, 0);
});

// ─── العميل نفسه ───

function scriptCustomerCreate(o: { assignmentCreatedAt?: () => Date } = {}): void {
  let n = 0;
  scripted = {
    'salesRep.findUnique': () => ({ canAddCustomer: true }),
    'salesRep.findFirst': () => ({ name: 'خالد' }),
    'customer.create': (a: Row) => ({ id: `c-new-${++n}`, createdAt: new Date(), ...a.data }),
    'customerAssignment.upsert': () => ({ id: 'as-1', createdAt: (o.assignmentCreatedAt ?? (() => new Date()))() }),
    'customerDocument.findMany': (a: Row) => (a.where?.customerId ? [{ id: 'doc-a', kind: 'CR', sizeBytes: 64 }] : []),
  };
}
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]).toString('base64')}`;

test('إضافة العميل (إدارة): حدث CUSTOMER_CREATED واحد بفاعل الإدارة ومرجع العميل — داخل معاملة الإنشاء', async () => {
  reset();
  scriptCustomerCreate();
  const r = await call(customersRouter, 'post', '/', { user: ADMIN, body: { name: 'محل النور', phone: '0507777777' } });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  const e = events()[0];
  assert.deepEqual(core(e), {
    action: 'CUSTOMER_CREATED', tenantId: T, customerId: 'c-new-1', actorKind: 'ADMIN', actorId: 'admin-1', actorName: 'سارة',
    refType: 'CUSTOMER', refId: 'c-new-1', refNo: null, amount: null,
  });
  assert.equal(e.data.name, 'محل النور');
  assert.notEqual(committed[0].tx, null);
});

test('إضافة العميل (مندوب): CUSTOMER_CREATED في المعاملة ثم CUSTOMER_ASSIGNED بعد الالتزام — كلٌّ مرّةً واحدة بفاعل المندوب', async () => {
  reset();
  scriptCustomerCreate();
  const r = await call(customersRouter, 'post', '/', { user: REP, body: { name: 'كشك السلام' } });
  assert.equal(r.status, 201, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.actorKind, e.actorId, e.actorName, e.source]), [
    ['CUSTOMER_CREATED', 'c-new-1', 'REP', 'rep-1', 'خالد', 'rep'],
    ['CUSTOMER_ASSIGNED', 'c-new-1', 'REP', 'rep-1', 'خالد', 'rep'],
  ]);
  assert.deepEqual([eventsOf('CUSTOMER_ASSIGNED')[0].refType, eventsOf('CUSTOMER_ASSIGNED')[0].refId], ['ASSIGNMENT', 'rep-1']);
});

test('إضافة العميل بوثائقه: حدث إضافة + DOCUMENT_ADDED لكل وثيقة — وفشل التزام الإنشاء لا يُبقي شيئاً', async () => {
  reset();
  scriptCustomerCreate();
  const r = await call(customersRouter, 'post', '/', { user: ADMIN, body: { name: 'مؤسسة الفجر', documents: [{ kind: 'CR', data: JPEG }] } });
  assert.equal(r.status, 201, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.refType, e.refId]), [['CUSTOMER_CREATED', 'CUSTOMER', 'c-new-1'], ['DOCUMENT_ADDED', 'DOCUMENT', 'doc-a']]);
  assert.equal(JSON.stringify(events()).includes('base64'), false, 'لا صورة في السجلّ');

  reset();
  scriptCustomerCreate();
  failCommits = 1;
  const f = await quiet(() => call(customersRouter, 'post', '/', { user: ADMIN, body: { name: 'مؤسسة الفجر', documents: [{ kind: 'CR', data: JPEG }] } }));
  assert.notEqual(f.status, 201);
  assert.equal(activityWrites().length >= 1, true);
  assert.equal(events().length, 0);
});

test('BUG إعادة رفع العميل نفسه (clientRef) بعد ثوانٍ من إنشائه تُكرّر حدث CUSTOMER_ASSIGNED — services/customerScope.ts ensureAssignment', async () => {
  // المندوب يرفع العميل، ثم يعيد صندوقُه الطلبَ نفسه (انقطع الردّ) بعد ثانيتين: الإسناد قائمٌ لم يتغيّر، فلا حدث إسنادٍ ثانٍ متوقَّع.
  // الحكم بـ«جديد» من createdAt ≥ بدء الطلب − ٥ ثوانٍ يعدّ الإسناد القائم منذ ثانيتين جديداً فيُكرّره.
  reset();
  scriptCustomerCreate();
  const ref = '0b6d7a1e-6a1c-4f7e-9d2b-3c1a2b3c4d5e';
  const first = await call(customersRouter, 'post', '/', { user: REP, body: { name: 'كشك السلام', clientRef: ref } });
  assert.equal(first.status, 201, why(first));
  const created = calls.find((c) => c.op === 'customer.create')!.args.data;
  const assignedAt = new Date(Date.now() - 2000);
  scripted['customer.findFirst'] = (a: Row) => (a.where?.clientRef === ref ? { id: 'c-new-1', ...created, createdBySalesRepId: 'rep-1' } : null);
  scripted['customerAssignment.upsert'] = () => ({ id: 'as-1', createdAt: assignedAt });
  const replay = await call(customersRouter, 'post', '/', { user: REP, body: { name: 'كشك السلام', clientRef: ref } });
  assert.equal(replay.status, 200, why(replay));
  assert.equal(replay.body.idempotent, true);
  assert.equal(eventsOf('CUSTOMER_ASSIGNED').length, 1, `إسنادٌ واحد وقع — والسجلّ فيه ${eventsOf('CUSTOMER_ASSIGNED').length}`);
});

function scriptCustomerPut(stored: Row, after?: (data: Row) => Row): void {
  scripted = {
    'customer.findFirst': (a: Row) => (a?.where?.id === stored.id ? { ...stored } : null),
    'customer.update': (a: Row) => (after ? after(a.data) : { ...stored, ...a.data }),
    'priceList.findMany': () => [],
  };
}
const STORED = { id: 'c-1', tenantId: T, name: 'بقالة الأمل', phone: '0501234567', status: 'ACTIVE', city: 'جدة', lat: null, lng: null, priceListId: null, balance: 10, creditLimit: 0 };

test('تعديل العميل: فرقٌ بما تغيّر وحده (حدثٌ لكل نوع) بفاعل الطلب — وجلسة المالك تُنسب للمالك لا لمدير الشركة', async () => {
  reset();
  scriptCustomerPut(STORED);
  const r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { name: 'بقالة الأمل الجديدة', city: 'جدة' } });
  assert.equal(r.status, 200, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  assert.deepEqual(core(events()[0]), {
    action: 'CUSTOMER_UPDATED', tenantId: T, customerId: 'c-1', actorKind: 'ADMIN', actorId: 'admin-1', actorName: 'سارة',
    refType: 'CUSTOMER', refId: 'c-1', refNo: null, amount: null,
  });
  assert.deepEqual(events()[0].data.changes, [{ field: 'name', from: 'بقالة الأمل', to: 'بقالة الأمل الجديدة' }]);

  reset();
  scriptCustomerPut(STORED);
  const o = await call(customersRouter, 'put', '/:id', { user: OWNER_SESSION, params: { id: 'c-1' }, body: { status: 'INACTIVE' } });
  assert.equal(o.status, 200, why(o));
  assert.deepEqual(events().map((e) => [e.action, e.actorKind, e.actorId, e.actorName]), [['CUSTOMER_STATUS_CHANGED', 'OWNER', 'owner-1', null]]);
});

test('تعديل العميل: تغيّر الرصيد والعدّادات وحده (صدى النموذج) لا حدث له', async () => {
  reset();
  scriptCustomerPut(STORED, (data) => ({ ...STORED, ...data, balance: 999, totalSales: 5000, totalCollected: 10, updatedAt: new Date() }));
  const r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { name: 'بقالة الأمل', city: 'جدة', phone: '0501234567' } });
  assert.equal(r.status, 200, why(r));
  assert.equal(events().length, 0, JSON.stringify(events()));
});

test('تحديد الموقع: CUSTOMER_LOCATION_SET واحد بالإحداثيين قبل وبعد — لا «تعديل» عام معه', async () => {
  reset();
  scriptCustomerPut(STORED);
  const r = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, body: { lat: 24.7136, lng: 46.6753 } });
  assert.equal(r.status, 200, why(r));
  assert.equal(events().length, 1, JSON.stringify(events()));
  const e = events()[0];
  assert.deepEqual([e.action, e.refType, e.refId, e.actorKind], ['CUSTOMER_LOCATION_SET', 'CUSTOMER', 'c-1', 'ADMIN']);
  assert.deepEqual(e.data, { from: null, to: { lat: 24.7136, lng: 46.6753 } });
});

test('حذف العميل: لا حدث CUSTOMER_DELETED (قرار المالك ٢٧ نوفمبر: سجلّه يُحذف معه بالمحرّك) — ورميُ المحرّك لا يكتب شيئاً', async () => {
  reset();
  scripted['customer.findFirst'] = () => ({ id: 'c-1', name: 'بقالة', number: 12, code: 'X1' });
  const r = await call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c-1' } });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events(), [], 'لا حدث حذف — السجلّ يُحذف مع العميل (customer-activity-delete.test.ts)');
  assert.ok(calls.some((c) => c.op === 'purgeInTx'), 'الحذف بالمحرّك');

  reset();
  scripted['customer.findFirst'] = () => ({ id: 'c-1', name: 'بقالة', number: 12, code: 'X1' });
  purgeImpl = async () => { throw new Error('FK violation during purge'); };
  try {
    const f = await quiet(() => call(customersRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'c-1' } }));
    assert.notEqual(f.status, 200);
    assert.equal(activityWrites().length, 0, 'لا كتابة في السجلّ');
    assert.equal(events().length, 0);
  } finally { purgeImpl = async () => ({ counts: {}, nullCounts: {} }); }
});

// ─── الوثائق ───

test('رفع وثيقة من الأرشيف: DOCUMENT_ADDED واحد بمعرّفها ونوعها وحجمها (بلا الصورة) — وحذفها DOCUMENT_REMOVED واحد', async () => {
  reset();
  scripted = {
    'customer.findFirst': () => ({ id: 'c-1', name: 'بقالة', businessName: null }),
    'customerDocument.count': () => 0,
    'customerDocument.create': (a: Row) => ({ id: 'doc-1', kind: a.data.kind, sizeBytes: a.data.sizeBytes, uploadedByKind: a.data.uploadedByKind, uploadedByName: a.data.uploadedByName, createdAt: new Date() }),
  };
  const up = await call(customerStudioRouter, 'post', '/:id/documents', { user: ADMIN, params: { id: 'c-1' }, body: { documents: [{ kind: 'VAT', data: JPEG }] } });
  assert.equal(up.status, 201, why(up));
  assert.equal(events().length, 1);
  assert.deepEqual(core(events()[0]), {
    action: 'DOCUMENT_ADDED', tenantId: T, customerId: 'c-1', actorKind: 'ADMIN', actorId: 'admin-1', actorName: 'سارة',
    refType: 'DOCUMENT', refId: 'doc-1', refNo: null, amount: null,
  });
  assert.equal(events()[0].data.kind, 'VAT');
  assert.equal(JSON.stringify(events()).includes('base64'), false);

  reset();
  scripted = {
    'customer.findFirst': () => ({ id: 'c-1', name: 'بقالة', businessName: null }),
    'customerDocument.findFirst': () => ({ id: 'doc-1', kind: 'VAT', sizeBytes: 64, uploadedByName: 'سارة', createdAt: new Date('2026-11-20T00:00:00Z') }),
    'customerDocument.deleteMany': () => ({ count: 1 }),
  };
  const del = await call(customerStudioRouter, 'delete', '/:id/documents/:docId', { user: ADMIN, params: { id: 'c-1', docId: 'doc-1' } });
  assert.equal(del.status, 200, why(del));
  assert.deepEqual(events().map((e) => [e.action, e.refType, e.refId, e.actorKind]), [['DOCUMENT_REMOVED', 'DOCUMENT', 'doc-1', 'ADMIN']]);

  // وثيقةٌ غائبة (حُذفت قبلاً) ⇒ ٤٠٤ ولا حدث
  reset();
  scripted = { 'customer.findFirst': () => ({ id: 'c-1', name: 'بقالة', businessName: null }), 'customerDocument.deleteMany': () => ({ count: 0 }) };
  const gone = await call(customerStudioRouter, 'delete', '/:id/documents/:docId', { user: ADMIN, params: { id: 'c-1', docId: 'doc-x' } });
  assert.equal(gone.status, 404);
  assert.equal(events().length, 0);
});

// ─── الزيارة ───

test('الزيارة: VISIT_RECORDED واحد بمرجعها ولحظتها ومدّتها بفاعل المندوب — وإعادة الرفع (clientRef) بلا حدث ثانٍ', async () => {
  reset();
  const visitAt = new Date(Date.now() - 60_000);
  const stored: Row[] = [];
  scripted = {
    'salesRep.findFirst': () => REP_ROW,
    'customer.findFirst': () => ({ id: 'c-1' }),
    'repVisit.findFirst': (a: Row) => stored.find((v) => v.clientRef === a.where?.clientRef) ?? null,
    'repVisit.create': (a: Row) => { const v = { id: `v-${stored.length + 1}`, createdAt: visitAt, _count: { photos: 0 }, ...a.data }; stored.push(v); return v; },
  };
  const ref = '5d2f6a3b-1c4e-4f8a-9b7c-0a1b2c3d4e5f';
  const body = { customerId: 'c-1', note: 'الرف ممتلئ', lat: 24.7, lng: 46.7, clientRef: ref, startedAt: new Date(Date.now() - 600_000).toISOString(), endedAt: new Date(Date.now() - 300_000).toISOString() };
  const r = await call(visitsRouter, 'post', '/', { user: REP, body });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 1);
  const e = events()[0];
  assert.deepEqual(core(e), {
    action: 'VISIT_RECORDED', tenantId: T, customerId: 'c-1', actorKind: 'REP', actorId: 'rep-1', actorName: 'خالد',
    refType: 'VISIT', refId: 'v-1', refNo: null, amount: null,
  });
  assert.equal(e.data.durationSec, 300);
  assert.equal(e.data.note, 'الرف ممتلئ');
  const again = await call(visitsRouter, 'post', '/', { user: REP, body });
  assert.equal(again.status, 200, why(again));
  assert.equal(events().length, 1, 'إعادة الرفع لا تُكرّر الحدث');
});

// ─── خطّ السير ───

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REP_UUID = U(900);
const OLD_ROUTE = U(800);

test('حفظ خطّ السير: من دخل ومن خرج وحدهما حدثان — والعميل الباقي (ولو تغيّر ترتيبه) بلا حدث', async () => {
  reset();
  // الخطّ القديم: c1, c2 — والجديد c2 (صار أوّلاً), c3
  scripted = {
    'salesRep.findFirst': () => ({ id: REP_UUID }),
    'salesRep.findMany': () => [{ id: REP_UUID, name: 'خالد' }],
    'customer.findMany': (a: Row) => (a.where?.id?.in ?? []).map((id: string) => ({ id })),
    'repRoute.findFirst': () => ({ id: OLD_ROUTE, salesRepId: REP_UUID, isPermanent: true, weekdays: [], rotationOrder: 0, createdAt: new Date('2026-01-01') }),
    'repRouteSchedule.findFirst': () => null,
    'repRoute.findMany': (a: Row) => (a.where?.id === OLD_ROUTE || (a.where?.isPermanent === true && a.where?.salesRepId === REP_UUID && a.select?.name)
      ? [{ id: OLD_ROUTE, name: 'خط الأحد', salesRepId: REP_UUID, isActive: true }] : []),
    'repRouteStop.findMany': (a: Row) => ((a.where?.routeId?.in ?? []).includes(OLD_ROUTE) ? [{ customerId: U(1), routeId: OLD_ROUTE }, { customerId: U(2), routeId: OLD_ROUTE }] : []),
    'repRoute.deleteMany': () => ({ count: 1 }),
    'repRoute.create': (a: Row) => ({ id: U(801), ...a.data }),
    'repRouteStop.create': (a: Row) => ({ id: `s-${a.data.customerId}`, ...a.data }),
  };
  const r = await call(repRoutesRouter, 'post', '/', {
    user: ADMIN,
    body: { salesRepId: REP_UUID, name: 'خط الأحد', isPermanent: true, replacesId: OLD_ROUTE, stops: [{ customerId: U(2) }, { customerId: U(3) }] },
  });
  assert.equal(r.status === 200 || r.status === 201, true, why(r));
  const got = events().map((e) => [e.action, e.customerId, e.refType, e.refId]).sort();
  assert.deepEqual(got, [
    ['ROUTE_STOP_ADDED', U(3), 'ROUTE', U(801)],
    ['ROUTE_STOP_REMOVED', U(1), 'ROUTE', OLD_ROUTE],
  ].sort(), JSON.stringify(events()));
  assert.equal(events().filter((e) => e.customerId === U(2)).length, 0, 'الباقي في الخطّ لا حدث له');
  for (const e of events()) assert.deepEqual([e.actorKind, e.actorId, e.actorName], ['ADMIN', 'admin-1', 'سارة']);
  assert.ok(committed.every((c) => c.tx !== null), 'في معاملة الحفظ');
});

// ─── الإسناد ───

test('إسناد العملاء لمندوب: الجديد والمنزوع فعلاً حدثان — وما كان على حاله بلا حدث، وفشل الالتزام لا يُبقي شيئاً', async () => {
  const script = () => {
    scripted = {
      'salesRep.findFirst': () => ({ id: 'R1', name: 'خالد' }),
      'customer.findMany': () => [{ id: 'c2' }, { id: 'c3' }],
      'customerAssignment.findMany': () => [{ customerId: 'c1' }, { customerId: 'c3' }],
    };
  };
  reset();
  script();
  const r = await call(salesRepsRouter, 'put', '/:id/customers', { user: ADMIN, params: { id: 'R1' }, body: { add: ['c2', 'c3'], remove: ['c1', 'c9'] } });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.refType, e.refId, e.actorKind]), [
    ['CUSTOMER_UNASSIGNED', 'c1', 'ASSIGNMENT', 'R1', 'ADMIN'], ['CUSTOMER_ASSIGNED', 'c2', 'ASSIGNMENT', 'R1', 'ADMIN'],
  ]);
  reset();
  script();
  failCommits = 1;
  const f = await quiet(() => call(salesRepsRouter, 'put', '/:id/customers', { user: ADMIN, params: { id: 'R1' }, body: { add: ['c2'], remove: ['c1'] } }));
  assert.notEqual(f.status, 200);
  assert.equal(events().length, 0);
});

test('حذف المندوب: أثره على كل عميلٍ حدثٌ مجمَّع — ورميٌ بعد التسجيل (تفريغ الفواتير) لا يُبقي شيئاً', async () => {
  const script = (throwOnUpdate: boolean) => {
    scripted = {
      'salesRep.findFirst': () => ({ id: 'R1', name: 'خالد' }),
      'invoice.groupBy': () => [{ customerId: 'c1', _count: { _all: 4 } }],
      'invoice.updateMany': () => { if (throwOnUpdate) throw new Error('deadlock detected'); return { count: 4 }; },
    };
  };
  reset();
  script(false);
  const r = await call(salesRepsRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'R1' } });
  assert.equal(r.status, 200, why(r));
  assert.deepEqual(events().map((e) => [e.action, e.customerId, e.data.count]), [['INVOICE_REASSIGNED', 'c1', 4]]);
  reset();
  script(true);
  const f = await quiet(() => call(salesRepsRouter, 'delete', '/:id', { user: ADMIN, params: { id: 'R1' } }));
  assert.notEqual(f.status, 200);
  assert.equal(activityWrites().length, 1);
  assert.equal(events().length, 0);
});

// ─── سداد رابط الدفع (الويب هوك) ───

function scriptPaylink(status = 'initiated'): void {
  moyasarInvoice = { status: 'paid', amount: 11500, currency: 'SAR', payments: [{ id: 'pay-1', status: 'paid' }] };
  scripted = {
    'customerPaymentLink.findUnique': () => ({
      id: 'pl-1', tenantId: T, customerId: 'c-1', invoiceId: 'inv-1', amount: 115, status, moyasarInvoiceId: 'moy-1',
      receiptId: status === 'paid' ? 'rc-old' : null, salesRepId: 'rep-1',
      invoice: { id: 'inv-1', number: 'INV-0001', customerId: 'c-1', paidAmt: 0, remainingAmt: 115, teamId: null },
      tenant: { paylinkFeePct: 4, paylinkFeeFlat: 1 }, customer: { name: 'بقالة الأمل' },
    }),
    'receipt.create': (a: Row) => ({ id: 'rc-pl', ...a.data }),
    'receipt.findUnique': () => ({ id: 'rc-existing' }),
  };
  raw = (sql) => (/SELECT "paidAmt", "remainingAmt" FROM invoices/.test(sql) ? [{ paidAmt: 0, remainingAmt: 115 }] : undefined);
}

test('سداد رابط الدفع (الويب هوك): PAYLINK_PAID واحد بفاعل العميل نفسه باسمه (مصدر public) وسند قبضه — في معاملة القيد', async () => {
  reset();
  scriptPaylink();
  const out = await confirmLinkPayment('pl-1');
  assert.equal(out.state, 'paid');
  assert.equal(eventsOf('PAYLINK_PAID').length, 1);
  const p = eventsOf('PAYLINK_PAID')[0];
  assert.deepEqual(core(p), {
    action: 'PAYLINK_PAID', tenantId: T, customerId: 'c-1', actorKind: 'CUSTOMER', actorId: null, actorName: 'بقالة الأمل',
    refType: 'PAYLINK', refId: 'pl-1', refNo: 'INV-0001', amount: 115,
  });
  assert.equal(p.source, 'public');
  // والسند الذي أنشأه السداد حدثه — مرّةً واحدة
  assert.equal(eventsOf('RECEIPT_ISSUED').length, 1);
  assert.equal(eventsOf('RECEIPT_ISSUED')[0].refId, 'rc-pl');
  assert.equal(events().length, 2);
  assert.ok(committed.every((c) => c.tx !== null && c.tx === committed[0].tx), 'الحدثان في معاملة القيد نفسها');

  // الويب هوك المكرّر بعد السداد ⇒ «سُدّد سابقاً» ولا حدث
  reset();
  scriptPaylink('paid');
  assert.equal((await confirmLinkPayment('pl-1')).state, 'already-paid');
  assert.equal(events().length, 0);

  // فشل التزام معاملة القيد ⇒ لا سداد ولا حدث
  reset();
  scriptPaylink();
  failCommits = 1;
  await assert.rejects(quiet(() => confirmLinkPayment('pl-1')));
  assert.equal(events().length, 0);
});

test('انتهاء رابط الدفع لدى المزوّد: PAYLINK_EXPIRED واحد بفاعل النظام — لانتقالٍ من «بانتظار الدفع» وحده', async () => {
  reset();
  scriptPaylink();
  moyasarInvoice = { status: 'expired', amount: 11500, currency: 'SAR' };
  scripted['customerPaymentLink.updateMany'] = (a: Row) => ({ count: a.where?.status === 'initiated' ? 1 : 0 });
  await confirmLinkPayment('pl-1');
  assert.deepEqual(events().map((e) => [e.action, e.actorKind, e.refType, e.refId, e.source]), [['PAYLINK_EXPIRED', 'SYSTEM', 'PAYLINK', 'pl-1', 'system']]);
  // الميت أصلاً: لا انتقال ⇒ لا حدث
  reset();
  scriptPaylink();
  moyasarInvoice = { status: 'expired', amount: 11500, currency: 'SAR' };
  scripted['customerPaymentLink.updateMany'] = () => ({ count: 0 });
  await confirmLinkPayment('pl-1');
  assert.equal(events().length, 0);
});

// ─── طلب المنيو العام ───

const CT = '11111111-1111-4111-8111-111111111111';
const CR = '22222222-2222-4222-8222-222222222222';
const CP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

function scriptCatalog(candidates: Row[]): void {
  scripted = {
    'tenant.findUnique': () => ({ isActive: true, catalogEnabled: true }),
    'companySettings.findUnique': () => ({ taxDisabled: false }),
    'salesRep.findFirst': () => ({ id: CR, name: 'خالد', defaultPriceListId: null }),
    'product.findMany': () => [{ id: CP, name: 'ماء', basePrice: 10, taxPct: 15, categoryId: null, primaryUnitId: null, units: [] }],
    'catalogOrder.findUnique': () => null,
    'catalogOrder.count': () => 0,
    'catalogOrder.create': () => ({ id: 'O-NEW' }),
  };
  raw = (sql) => (/FROM customers/.test(sql) ? candidates : undefined);
}
const orderBody = { clientRef: '44444444-4444-4444-8444-444444444444', name: 'أبو محمد', phone: '0501234567', items: [{ productId: CP, unitId: null, qty: 2 }] };

test('طلب المنيو العام: CATALOG_ORDER_PLACED واحد على العميل المطابق بجواله بفاعل «العميل» باسمه — وبلا مطابق لا حدث', async () => {
  reset();
  scriptCatalog([{ id: 'c-1', name: 'بقالة الأمل', phone: '0501234567', createdAt: new Date('2026-06-01') }]);
  const r = await call(publicCatalogRouter, 'post', '/catalog/:tenantId/:repId/orders', { params: { tenantId: CT, repId: CR }, body: orderBody }, { lastOnly: true });
  assert.equal(r.status, 201, why(r));
  assert.equal(events().length, 1);
  const e = events()[0];
  assert.deepEqual(core(e), {
    action: 'CATALOG_ORDER_PLACED', tenantId: CT, customerId: 'c-1', actorKind: 'CUSTOMER', actorId: null, actorName: 'أبو محمد',
    refType: 'CATALOG_ORDER', refId: 'O-NEW', refNo: null, amount: 23,
  });
  assert.equal(e.source, 'public');
  assert.deepEqual(r.body, { success: true, data: { id: 'O-NEW', repName: 'خالد' } }, 'الردّ لا يكشف المطابقة');

  reset();
  scriptCatalog([]);
  const n = await call(publicCatalogRouter, 'post', '/catalog/:tenantId/:repId/orders', { params: { tenantId: CT, repId: CR }, body: orderBody }, { lastOnly: true });
  assert.equal(n.status, 201, why(n));
  assert.equal(events().length, 0);
});

// ─── إجراءٌ مرفوض لا حدث له، والفاعل والمصدر للمفتاح البرمجي وتطبيق الجوال ───

test('إلغاءٌ يرفضه القفل (الفاتورة أُلغيت في الأثناء) ⇒ ٤٠٠ ولا حدث؛ وإلغاء مندوبٍ بلا صلاحية ⇒ ٤٠٣ ولا حدث', async () => {
  reset();
  scriptInvoiceCancel();
  const base = raw;
  raw = (sql, v, tx) => (/FROM invoices WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(sql) ? [{ status: 'CANCELLED', type: 'CASH', paidAmt: 0 }] : base(sql, v, tx));
  const r = await call(invoicesRouter, 'patch', '/:id/cancel', { user: ADMIN, params: { id: 'inv-9' }, body: {} });
  assert.equal(r.status, 400, why(r));
  assert.equal(events().length, 0);
  reset();
  scriptInvoiceCancel();
  scripted['salesRep.findFirst'] = () => ({ ...REP_ROW, canCancelInvoice: false });
  const f = await call(invoicesRouter, 'patch', '/:id/cancel', { user: REP, params: { id: 'inv-9' }, body: {} });
  assert.equal(f.status, 403, why(f));
  assert.equal(activityWrites().length, 0);
});

test('الفاعل والمصدر: مفتاح الربط البرمجي API بمعرّف المفتاح ومصدر api، وتطبيق الإدارة على الجوال مصدر m', async () => {
  reset();
  scriptCustomerPut(STORED);
  const k = await call(customersRouter, 'put', '/:id', { user: { ...ADMIN, apiKeyId: 'key-1', apiKeyName: 'ERP' }, params: { id: 'c-1' }, body: { city: 'الرياض' } });
  assert.equal(k.status, 200, why(k));
  assert.deepEqual(events().map((e) => [e.action, e.actorKind, e.actorId, e.actorName, e.source]), [['CUSTOMER_UPDATED', 'API', 'key-1', 'ERP', 'api']]);
  reset();
  scriptCustomerPut(STORED);
  const m = await call(customersRouter, 'put', '/:id', { user: ADMIN, params: { id: 'c-1' }, headers: { 'x-fs-client': 'm' }, body: { city: 'الدمام' } });
  assert.equal(m.status, 200, why(m));
  assert.deepEqual(events().map((e) => [e.actorKind, e.source]), [['ADMIN', 'm']]);
});

// ─── المخطّط: كل ما يسأله الكود من حقولٍ موجودٌ في schema.prisma (المزيّف لا يرفض حقلاً مجهولاً — Prisma يرفضه وقت التشغيل) ───

type FieldInfo = { type: string; list: boolean; relation: boolean };
const SCHEMA: Map<string, Map<string, FieldInfo>> = (() => {
  const text = fs.readFileSync(path.join(BACKEND, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...text.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)];
  const names = new Set(blocks.map((b) => b[1]));
  const out = new Map<string, Map<string, FieldInfo>>();
  for (const [, name, body] of blocks) {
    const fields = new Map<string, FieldInfo>();
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(t);
      if (m) fields.set(m[1], { type: m[2], list: !!m[3], relation: names.has(m[2]) });
    }
    out.set(name, fields);
  }
  return out;
})();
const modelOf = (delegateName: string) => delegateName[0].toUpperCase() + delegateName.slice(1);
const SCALAR_OPS = new Set(['equals', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not', 'contains', 'startsWith', 'endsWith', 'mode', 'has', 'hasSome', 'hasEvery', 'isEmpty', 'path', 'string_contains', 'array_contains', 'search']);
const plainObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && typeof (v as { toNumber?: unknown }).toNumber !== 'function';

function vWhere(model: string, w: unknown, at: string, errs: string[]): void {
  if (!plainObj(w)) return;
  const fields = SCHEMA.get(model);
  if (!fields) return;
  for (const [k, v] of Object.entries(w)) {
    if (k === 'AND' || k === 'OR' || k === 'NOT') { for (const x of ([] as unknown[]).concat(v)) vWhere(model, x, `${at}.${k}`, errs); continue; }
    const f = fields.get(k);
    if (!f) {
      if (k.includes('_') && k.split('_').every((p) => fields.has(p))) continue; // مفتاحٌ مركّب فريد
      errs.push(`${at}: ${model}.${k} unknown`); continue;
    }
    if (f.relation) {
      if (v === null || !plainObj(v)) continue;
      if (f.list) {
        for (const [op, x] of Object.entries(v)) { if (!['some', 'every', 'none'].includes(op)) errs.push(`${at}: ${model}.${k} list op ${op}`); else vWhere(f.type, x, `${at}.${k}.${op}`, errs); }
      } else vWhere(f.type, (v.is ?? v.isNot ?? v) as Row, `${at}.${k}`, errs);
      continue;
    }
    if (plainObj(v)) for (const op of Object.keys(v)) if (!SCALAR_OPS.has(op)) errs.push(`${at}: ${model}.${k} op ${op}`);
  }
}
function vSelect(model: string, s: unknown, at: string, errs: string[], include = false): void {
  if (!plainObj(s)) return;
  const fields = SCHEMA.get(model);
  if (!fields) return;
  for (const [k, v] of Object.entries(s)) {
    if (k === '_count') {
      if (plainObj(v) && plainObj(v.select)) {
        for (const [r, rv] of Object.entries(v.select)) {
          const f = fields.get(r);
          if (!f?.relation || !f.list) errs.push(`${at}: ${model}._count.${r} not a list relation`);
          else if (plainObj(rv) && rv.where) vWhere(f.type, rv.where, `${at}._count.${r}`, errs);
        }
      }
      continue;
    }
    const f = fields.get(k);
    if (!f) { errs.push(`${at}: ${model}.${k} unknown`); continue; }
    if (include && !f.relation) errs.push(`${at}: include of scalar ${model}.${k}`);
    if (plainObj(v)) { if (!f.relation) errs.push(`${at}: nested args on scalar ${model}.${k}`); else vArgs(f.type, v, `${at}.${k}`, errs); }
  }
}
function vOrder(model: string, o: unknown, at: string, errs: string[]): void {
  const fields = SCHEMA.get(model);
  if (!fields) return;
  for (const x of ([] as unknown[]).concat(o)) {
    if (!plainObj(x)) continue;
    for (const [k, v] of Object.entries(x)) {
      if (k === '_count') continue;
      const f = fields.get(k);
      if (!f) errs.push(`${at}: orderBy ${model}.${k} unknown`);
      else if (f.relation && plainObj(v)) vOrder(f.type, v, `${at}.${k}`, errs);
    }
  }
}
function vArgs(model: string, a: unknown, at: string, errs: string[]): void {
  if (!plainObj(a)) return;
  if (a.where) vWhere(model, a.where, `${at}.where`, errs);
  if (a.select) vSelect(model, a.select, `${at}.select`, errs);
  if (a.include) vSelect(model, a.include, `${at}.include`, errs, true);
  if (a.orderBy) vOrder(model, a.orderBy, `${at}.orderBy`, errs);
}

test('المخطّط: كل نداءات Prisma في مسارات الكتابة المختبَرة أعلاه بحقولٍ موجودة، وصفّ السجلّ بأعمدته وحدها', () => {
  assert.ok(SCHEMA.get('CustomerActivity')?.has('actorKind'), 'محلّل المخطّط');
  const errs: string[] = [];
  let checked = 0;
  for (const c of allModelCalls) {
    const model = modelOf(c.model);
    if (!SCHEMA.has(model)) continue;
    checked++;
    vArgs(model, c.args, `${c.model}.${c.method}`, errs);
    if (c.model === 'customerActivity' && c.method === 'createMany') {
      const cols = SCHEMA.get('CustomerActivity')!;
      for (const row of c.args?.data ?? []) for (const k of Object.keys(row)) if (!cols.has(k) || cols.get(k)!.relation) errs.push(`customerActivity.createMany: column ${k}`);
    }
  }
  assert.ok(checked > 100, `checked ${checked}`);
  assert.deepEqual([...new Set(errs)], []);
  // ضابطٌ سلبيّ: المدقّق يلتقط الحقل المجهول فعلاً
  const neg: string[] = [];
  vArgs('Customer', { where: { tenantId: 'x', nope: 1, assignments: { some: { bogus: 1 } } }, select: { id: true, ghost: true, _count: { select: { name: true } } } }, 'neg', neg);
  assert.equal(neg.length, 4, neg.join(' | '));
});

// ═══════════════════ ٣) تنظيف المُدخل ═══════════════════

test('recordCustomerActivity: التفاصيل الضخمة والمتداخلة والدائرية تُقصّ تحت ٨ ك.ب، وundefined يسقط — ولا رمي لأي شكل', async () => {
  const rows: Row[] = [];
  const db = { customerActivity: { createMany: async (a: { data: Row[] }) => { rows.push(...a.data); return { count: a.data.length }; } } };
  const base = { tenantId: T, customerId: 'c-1', action: 'CUSTOMER_UPDATED' as const, actor: { kind: 'ADMIN' as const, id: 'a', name: 'س' } };
  const cyclic: Row = { name: 'x' }; cyclic.self = cyclic;
  const deep: Row = {}; let cur = deep; for (let i = 0; i < 50; i++) { cur.next = {}; cur = cur.next; }
  const throwing = Object.defineProperty({}, 'boom', { enumerable: true, get() { throw new Error('getter'); } });
  const inputs: Row[] = [
    { ...base, data: { blob: 'ع'.repeat(200_000), list: Array.from({ length: 5000 }, (_, i) => ({ i, s: 'x'.repeat(300) })), u: undefined, keep: 1 } },
    { ...base, data: cyclic },
    { ...base, data: deep },
    { ...base, data: throwing },
    { ...base, data: { big: 10n, sym: Symbol('s'), fn: () => 1, date: new Date('bad'), map: new Map([[1, 2]]), buf: Buffer.from('secret') } },
    { ...base, data: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])) },
  ];
  for (const i of inputs) await ca.recordCustomerActivity(db, i as never);
  assert.equal(rows.length, inputs.length);
  for (const r of rows) {
    if (r.data === undefined) continue;
    const bytes = Buffer.byteLength(JSON.stringify(r.data));
    assert.ok(bytes <= ca.ACTIVITY_DATA_MAX_BYTES, `data ${bytes} bytes`);
  }
  const d0 = rows[0].data;
  assert.equal('u' in d0, false, 'undefined يسقط');
  assert.equal(d0.keep, 1, 'الصغير يبقى بقيمته');
  assert.ok(d0.blob.length <= ca.ACTIVITY_STRING_MAX + 1 && d0.list.length <= 101, 'النصّ والقائمة مقصوصان');
  assert.equal(rows[3].data, undefined, 'getter يرمي ⇒ بلا تفاصيل لا رمي');
  assert.equal(rows[4].data.big, '10');
  assert.equal(rows[4].data.date, null);
  assert.equal(rows[4].data.buf, '[omitted]');
  assert.ok(Object.keys(rows[5].data).length <= 100, 'سقف المفاتيح');
  // أشكالٌ رديئة للمُدخل نفسه — بلا رمي وبلا كتابة
  const before = rows.length;
  for (const bad of [null, undefined, 42, 'x', [], [null, 1, 'y'], { tenantId: T }, { customerId: 'c' }, { ...base, tenantId: { evil: 1 } }]) {
    await ca.recordCustomerActivity(db, bad as never);
  }
  assert.equal(rows.length, before);
  // فاعلٌ ومبلغٌ ومرجعٌ ولحظةٌ رديئة ⇒ تُنظَّف ولا تُرفض
  await ca.recordCustomerActivity(db, { ...base, actor: 'ADMIN' as never, amount: { toString: () => 'NaN' } as never, refType: 'DROP TABLE' as never, at: 'yesterday' as never, refNo: 'R'.repeat(1000) });
  const last = rows.at(-1)!;
  assert.equal(last.actorKind, 'SYSTEM');
  assert.equal('amount' in last, false);
  assert.equal(last.refType, null);
  assert.equal('at' in last, false);
  assert.equal(last.refNo.length, 100);
});

test('BUG المبلغ خارج مدى العمود Decimal(18,4) يُكتب كما هو فيُفشل الإجراء كلّه في القاعدة — services/customerActivity.ts toDecimal', () => {
  // العقد: «لا يُرفض الإجراء بسبب تفاصيله أبداً». الفاتورة إجماليها Float بلا سقف، والسجلّ Decimal(18,4) (أقصاه < 10^14):
  // إجماليٌّ ضخم (تكاملٌ معيب أو كمية خاطئة) يُفشل إدراج الحدث ⇒ تُرفض الفاتورة نفسها بعد أن كانت تُقبل قبل الميزة.
  const row = ca.activityRow({ tenantId: T, customerId: 'c-1', action: 'INVOICE_ISSUED', actor: ca.SYSTEM_ACTOR, amount: 1e15 })!;
  const amt = row.amount as Prisma.Decimal | undefined;
  assert.ok(amt === undefined || amt.abs().lt(new Prisma.Decimal('1e14')), `amount ${String(amt)} لا يتّسع له Decimal(18,4)`);
});

// ═══════════════════ ٤) القراءة ═══════════════════

const isPlain = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !(v as { toNumber?: unknown }).toNumber;
const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
const same = (a: unknown, b: unknown) => (a == null && b == null) || val(a) === val(b);
const less = (a: unknown, b: unknown) => a != null && b != null && (val(a) as number) < (val(b) as number);

function matchOps(v: unknown, ops: Row): boolean {
  for (const [op, x] of Object.entries(ops)) {
    if (op === 'in') { if (!(x as unknown[]).some((y) => same(v, y))) return false; }
    else if (op === 'not') {
      if (x === null) { if (v == null) return false; }
      else if (isPlain(x)) { if (matchOps(v, x)) return false; }
      else if (v == null || same(v, x)) return false; // SQL: NULL <> x ليس صحيحاً
    }
    else if (op === 'lt') { if (!less(v, x)) return false; }
    else if (op === 'lte') { if (!(less(v, x) || (v != null && same(v, x)))) return false; }
    else if (op === 'gt') { if (!less(x, v)) return false; }
    else if (op === 'gte') { if (!(less(x, v) || (v != null && same(v, x)))) return false; }
    else if (op === 'some') { if (!((v as Row[] | undefined) ?? []).some((r) => matchWhere(r, x as Row))) return false; }
    else throw new Error(`unsupported op ${op}`);
  }
  return true;
}
function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, w] of Object.entries(where)) {
    if (k === 'AND') { if (!(w as Row[]).every((x) => matchWhere(row, x))) return false; continue; }
    if (k === 'OR') { if (!(w as Row[]).some((x) => matchWhere(row, x))) return false; continue; }
    if (isPlain(w)) { if (!matchOps(row[k], w)) return false; continue; }
    if (!same(row[k], w)) return false;
  }
  return true;
}
function sortRows(rows: Row[], orderBy: Row[] | Row | undefined): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0] as [string, string]);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = val(a[k]) as number | string; const y = val(b[k]) as number | string;
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function memDb(tables: Record<string, Row[]>, schemaErrs?: string[]) {
  const queries: { model: string; args: Row }[] = [];
  const db = new Proxy({}, {
    get(_t, model: string) {
      const rows = () => tables[model] ?? [];
      return {
        findMany: async (args: Row = {}) => {
          queries.push({ model, args });
          if (schemaErrs) { assert.ok(SCHEMA.has(modelOf(model)), `model ${model}`); vArgs(modelOf(model), args, `${model}.findMany`, schemaErrs); }
          const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
          return args.take ? hit.slice(0, args.take) : hit;
        },
        findFirst: async (args: Row = {}) => {
          queries.push({ model, args });
          if (schemaErrs) vArgs(modelOf(model), args, `${model}.findFirst`, schemaErrs);
          return rows().find((r) => matchWhere(r, args.where)) ?? null;
        },
      };
    },
  });
  return { db: db as any, queries };
}

const D = (s: string) => new Date(s);
const CUST = { id: 'c1', tenantId: T, name: 'محل النور', phone: '0501234567', number: 7, createdAt: D('2025-01-01T08:00:00Z'), assignments: [{ salesRepId: 'r1' }] };
const inv = (id: string, at: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', number: `INV-${id}`, type: 'CREDIT', status: 'CONFIRMED', documentKind: null, invoiceDate: D(at),
  total: 100, taxAmt: 15, paidAmt: 0, remainingAmt: 100, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 2 }, ...extra,
});
const logRow = (id: string, at: string, action: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', at: D(at), action, actorKind: 'ADMIN', actorId: 'a1', actorName: 'سارة', refType: null, refId: null,
  refNo: null, amount: null, data: null, ...extra,
});
const rcpt = (id: string, at: string, extra: Row = {}) => ({
  id, tenantId: T, customerId: 'c1', number: `RC-${id}`, amount: 50, paymentMethod: 'CASH', status: 'ACTIVE', receiptDate: D(at),
  notes: null, salesRepId: 'r1', deletedSalesRepId: null, salesRep: { name: 'أحمد' }, _count: { photos: 0 }, invoiceItems: [], ...extra,
});
const noScope = async () => ({});
const repScope = async (req: Row) => (req.user?.role === 'SALES_REP' ? { assignments: { some: { salesRepId: req.user.id } } } : {});
const asRep = (id = 'r1') => ({ user: { id, role: 'SALES_REP', name: 'أحمد', tenantId: T } } as any);
const asAdmin = (extra: Row = {}) => ({ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T, ...extra } } as any);

async function page(deps: any, req: any, q: Row = {}, id = 'c1') {
  return readApi.loadCustomerActivity(deps, req, T, id, readApi.parseActivityQuery(q));
}
async function allPages(deps: any, req: any, limit: number, category?: string): Promise<Row[]> {
  const out: Row[] = [];
  let before: string | undefined;
  for (let i = 0; i < 500; i++) {
    const p = (await page(deps, req, { limit, before, category }))!;
    out.push(...p.items);
    if (!p.nextBefore) return out;
    assert.notEqual(p.nextBefore, before, 'cursor must advance');
    before = p.nextBefore;
  }
  throw new Error('pagination never ends');
}

test('القراءة عبر المسار: المندوب خارج نطاقه ٤٠٤، وعميل شركةٍ أخرى ٤٠٤، والمالك وموظف المنصة يقرآن (وأسماؤهما لهما وحدهما)', async () => {
  const { db } = memDb({
    customer: [CUST, { ...CUST, id: 'c-other', tenantId: 'T2' }],
    customerActivity: [
      logRow('L1', '2026-11-26T10:00:00Z', 'CUSTOMER_UPDATED', { actorKind: 'STAFF', actorId: 's1', actorName: 'موظف الدعم' }),
      logRow('L2', '2026-11-26T09:00:00Z', 'CUSTOMER_UPDATED', { actorKind: 'OWNER', actorId: 'o1', actorName: 'المالك' }),
    ],
  });
  const router = readApi.createCustomerActivityRouter({ db, customerScope: repScope as any });
  const get = (user: Row, id = 'c1', query: Row = {}) => call(router, 'get', '/:id/activity', { user, params: { id }, query });
  const out = await get({ id: 'r2', role: 'SALES_REP', name: 'سالم', tenantId: T });
  assert.equal(out.status, 404, why(out));
  assert.equal(out.body.success, false);
  const other = await get({ id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T }, 'c-other');
  assert.equal(other.status, 404);
  const mine = await get({ id: 'r1', role: 'SALES_REP', name: 'أحمد', tenantId: T });
  assert.equal(mine.status, 200, why(mine));
  assert.deepEqual(mine.body.data.items.filter((x: Row) => !x.historical).map((x: Row) => [x.id, x.actor.kind, x.actor.name]), [['L1', 'STAFF', null], ['L2', 'OWNER', null]], 'الشركة لا ترى اسم الموظف ولا المالك');
  const owner = await get({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: T, impersonated: true, by: 'o1', byKind: 'OWNER' });
  assert.equal(owner.status, 200, why(owner));
  assert.deepEqual(owner.body.data.items.filter((x: Row) => !x.historical).map((x: Row) => x.actor.name), ['موظف الدعم', 'المالك']);
  const staff = await get({ id: 'a1', role: 'ADMIN', name: 'مدير', tenantId: T, impersonated: true, by: 's1', byKind: 'STAFF' });
  assert.equal(staff.status, 200);
});

test('عزل الشركة: أسطر السجلّ وصفوف المصادر لشركةٍ أخرى بالمعرّف نفسه للعميل لا تظهر — وكل استعلامٍ بشركة الطالب', async () => {
  const x = (r: Row) => ({ ...r, tenantId: 'T2' });
  const { db, queries } = memDb({
    customer: [CUST],
    customerActivity: [logRow('L1', '2026-11-26T10:00:00Z', 'CUSTOMER_UPDATED'), x(logRow('LX', '2026-11-26T11:00:00Z', 'CUSTOMER_UPDATED'))],
    invoice: [inv('i1', '2026-10-01T09:00:00Z'), x(inv('iX', '2026-10-02T09:00:00Z'))],
    receipt: [rcpt('r1', '2026-09-01T09:00:00Z'), x(rcpt('rX', '2026-09-02T09:00:00Z'))],
    customerDocument: [x({ id: 'dX', customerId: 'c1', kind: 'CR', sizeBytes: 1, uploadedByKind: 'ADMIN', createdAt: D('2026-08-01T00:00:00Z') })],
    callLog: [x({ id: 'kX', customerId: 'c1', direction: 'OUT', startedAt: D('2026-08-02T00:00:00Z') })],
    catalogOrder: [x({ id: 'oX', phoneKey: '966501234567', status: 'NEW', customerName: 'غريب', createdAt: D('2026-08-03T00:00:00Z') })],
    admin: [{ id: 'a1', tenantId: 'T2', name: 'مستخدم غريب' }],
  });
  const p = (await page({ db, customerScope: noScope }, asAdmin()))!;
  const ids = p.items.map((i) => i.id);
  assert.ok(ids.includes('L1') && ids.includes('h:invoice:i1') && ids.includes('h:receipt:r1'));
  for (const bad of ['LX', 'h:invoice:iX', 'h:receipt:rX', 'h:doc:dX', 'h:call:kX', 'h:order:oX']) assert.ok(!ids.includes(bad), bad);
  for (const q of queries) {
    if (q.model === 'customerPrice') { assert.equal(q.args.where.customerId, 'c1'); continue; }
    assert.equal(q.args.where?.tenantId, T, `${q.model} without tenant filter: ${JSON.stringify(q.args.where)}`);
  }
});

test('الاشتقاق التاريخي: كل مصدرٍ له سطر ميلاد بالمرجع نفسه يسقط — وسطرٌ غير ميلاديّ أو بنوع مرجعٍ آخر لا يُسقطه', async () => {
  const { db } = memDb({
    customer: [CUST],
    invoice: [inv('i-born', '2026-03-01T09:00:00Z'), inv('i-cancel-only', '2026-03-02T09:00:00Z', { status: 'CANCELLED' }), inv('i-other-type', '2026-03-03T09:00:00Z')],
    receipt: [rcpt('r-born', '2026-04-01T09:00:00Z')],
    customerDocument: [{ id: 'd-born', tenantId: T, customerId: 'c1', kind: 'CR', sizeBytes: 1, uploadedByKind: 'REP', uploadedById: 'r1', uploadedByName: 'أحمد', createdAt: D('2026-05-01T00:00:00Z') }],
    customerPaymentLink: [{ id: 'pl-born', tenantId: T, customerId: 'c1', amount: 40, status: 'paid', createdAt: D('2026-06-01T00:00:00Z'), paidAt: D('2026-06-02T00:00:00Z'), expiresAt: null, salesRepId: null, createdById: null, salesRep: null, invoice: { number: 'INV-9' } }],
    callLog: [{ id: 'k-born', tenantId: T, customerId: 'c1', direction: 'OUT', durationSec: 30, startedAt: D('2026-07-01T00:00:00Z'), salesRepId: 'r1' }],
    catalogOrder: [{ id: 'o-born', tenantId: T, phoneKey: '966501234567', status: 'NEW', customerName: 'زبون', note: null, createdAt: D('2026-07-05T00:00:00Z'), invoiceId: null, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 1 } }],
    customerAssignment: [{ id: 'as1', tenantId: T, customerId: 'c1', salesRepId: 'r1', source: 'AUTO', createdAt: D('2026-07-06T00:00:00Z'), salesRep: { name: 'أحمد' } }],
    customerActivity: [
      logRow('L-inv', '2026-11-20T09:00:00Z', 'INVOICE_ISSUED', { refType: 'INVOICE', refId: 'i-born' }),
      logRow('L-cancel', '2026-11-20T09:01:00Z', 'INVOICE_CANCELLED', { refType: 'INVOICE', refId: 'i-cancel-only' }),
      logRow('L-wrongtype', '2026-11-20T09:02:00Z', 'RECEIPT_ISSUED', { refType: 'RECEIPT', refId: 'i-other-type' }),
      logRow('L-rc', '2026-11-20T09:03:00Z', 'RECEIPT_ISSUED', { refType: 'RECEIPT', refId: 'r-born' }),
      logRow('L-doc', '2026-11-20T09:04:00Z', 'DOCUMENT_ADDED', { refType: 'DOCUMENT', refId: 'd-born' }),
      logRow('L-pl', '2026-11-20T09:05:00Z', 'PAYLINK_CREATED', { refType: 'PAYLINK', refId: 'pl-born' }),
      logRow('L-call', '2026-11-20T09:06:00Z', 'CALL_LOGGED', { refType: 'CALL', refId: 'k-born' }),
      logRow('L-order', '2026-11-20T09:07:00Z', 'CATALOG_ORDER_PLACED', { refType: 'CATALOG_ORDER', refId: 'o-born' }),
      logRow('L-assign', '2026-11-20T09:08:00Z', 'CUSTOMER_ASSIGNED', { refType: 'ASSIGNMENT', refId: 'r1' }),
      logRow('L-created', '2026-11-20T09:09:00Z', 'CUSTOMER_CREATED', { refType: 'CUSTOMER', refId: 'c1' }),
    ],
  });
  const p = (await page({ db, customerScope: noScope }, asAdmin(), { limit: 300 }))!;
  const hist = p.items.filter((i) => i.historical).map((i) => i.id).sort();
  assert.deepEqual(hist, [
    'h:invoice:i-cancel-only', // الإلغاء وحده لا يُسقط الإصدار
    'h:invoice:i-other-type', // سطرٌ بمرجع RECEIPT لا يُسقط فاتورةً بالمعرّف نفسه
    'h:paylinkPaid:pl-born', // السداد حدثٌ ثانٍ: لا يُسقطه إلا PAYLINK_PAID نفسه
  ].sort());
  assert.equal(p.items.filter((i) => !i.historical).length, 10);
  // ثم سطر PAYLINK_PAID يُسقط السداد المشتقّ أيضاً
  const { db: db2 } = memDb({
    customer: [CUST],
    customerPaymentLink: [{ id: 'pl-born', tenantId: T, customerId: 'c1', amount: 40, status: 'paid', createdAt: D('2026-06-01T00:00:00Z'), paidAt: D('2026-06-02T00:00:00Z'), expiresAt: null, salesRepId: null, createdById: null, salesRep: null, invoice: { number: 'INV-9' } }],
    customerActivity: [logRow('L-paid', '2026-11-20T09:05:00Z', 'PAYLINK_PAID', { refType: 'PAYLINK', refId: 'pl-born' })],
  });
  const q = (await page({ db: db2, customerScope: noScope }, asAdmin()))!;
  assert.deepEqual(q.items.map((i) => i.id), ['L-paid', 'h:paylink:pl-born', 'h:created:c1']);
});

test('الكتابة ثم القراءة: أحداث المسارات الحقيقية بمراجعها تُسقط الاشتقاق — كل إجراءٍ يظهر مرّةً واحدة', async () => {
  // فاتورة من المسار + سندٌ + عميلٌ أضافه المندوب + وثيقة — ثم القراءة على صفوفها وأسطرها معاً
  reset();
  scriptInvoicePost();
  assert.equal((await call(invoicesRouter, 'post', '/', { user: REP, body: saleBody() })).status, 201);
  const invRow = createdInvoice();
  const logged = events().map((e, i) => ({ id: `W${i}`, at: D('2026-11-26T10:00:00Z'), amount: null, data: null, refNo: null, ...e, customerId: 'c1' }));
  const { db } = memDb({
    customer: [CUST],
    invoice: [inv('inv-1', '2026-11-26T10:00:00Z', { number: invRow.number, total: invRow.total })],
    customerActivity: logged,
  });
  const p = (await page({ db, customerScope: noScope }, asAdmin()))!;
  assert.deepEqual(p.items.filter((i) => i.refId === 'inv-1').map((i) => [i.action, i.historical]), [['INVOICE_ISSUED', false]]);
});

test('الإشعار الدائن: حدث ختمه (كما يبنيه stampNote) يطابق صفّه في القراءة — بندٌ واحد في «المرتجعات» ولا شيء في «المبيعات»', async () => {
  const docs = require('../services/customerActivityDocs') as typeof import('../services/customerActivityDocs');
  const input = docs.invoiceIssuedInput({
    tenantId: T, meta: { actor: { kind: 'ADMIN', id: 'a1', name: 'سارة' }, source: 'web', action: 'CREDIT_NOTE_ISSUED' },
    invoice: { id: 'cn-1', number: 'CN-0001', customerId: 'c1', type: 'RETURN', documentKind: 'CREDIT_NOTE', total: 50, noteReason: 'تالف', billingReference: 'INV-7' },
    data: { documentKind: 'CREDIT_NOTE', originalInvoiceId: 'inv-7', originalInvoiceNo: 'INV-7' },
  });
  const row = ca.activityRow(input)!;
  assert.deepEqual([row.action, row.refType, row.refId, row.refNo, Number(row.amount)], ['CREDIT_NOTE_ISSUED', 'INVOICE', 'cn-1', 'CN-0001', 50]);
  const { db } = memDb({
    customer: [CUST],
    invoice: [inv('cn-1', '2026-11-25T10:00:00Z', { type: 'RETURN', documentKind: 'CREDIT_NOTE', number: 'CN-0001', total: 50 })],
    customerActivity: [{ id: 'L-cn', at: D('2026-11-25T10:00:00Z'), ...row }],
  });
  const deps = { db, customerScope: noScope };
  const ret = (await page(deps, asAdmin(), { category: 'returns' }))!;
  assert.deepEqual(ret.items.map((i) => [i.id, i.action, i.historical]), [['L-cn', 'CREDIT_NOTE_ISSUED', false]]);
  const sales = (await page(deps, asAdmin(), { category: 'sales' }))!;
  assert.deepEqual(sales.items, []);
});

test('الترتيب الأحدث أولاً، وسقف الحدّ ٣٠٠، والحدّ الفاسد افتراضيّ ٢٠٠', async () => {
  const logs = Array.from({ length: 350 }, (_, i) => logRow(`L${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString(), 'CUSTOMER_UPDATED'));
  const { db } = memDb({ customer: [CUST], customerActivity: logs });
  const deps = { db, customerScope: noScope };
  const big = (await page(deps, asAdmin(), { limit: 100000 }))!;
  assert.equal(big.items.length, readApi.ACTIVITY_MAX_LIMIT);
  assert.ok(big.nextBefore);
  for (let i = 1; i < big.items.length; i++) assert.ok(big.items[i - 1].at >= big.items[i].at, 'desc');
  assert.equal(big.items[0].id, 'L349');
  for (const bad of ['0', '-5', 'abc', '', undefined, ['7', '9']]) {
    const n = readApi.parseActivityQuery({ limit: bad as never }).limit;
    if (Array.isArray(bad)) assert.equal(n, 7); else assert.equal(n, readApi.ACTIVITY_DEFAULT_LIMIT, String(bad));
  }
  assert.equal(readApi.parseActivityQuery({ limit: '2.9' }).limit, 2);
});

/** مولّد عشوائيّ ثابت البذرة */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function randomWorld(seed: number) {
  const r = rng(seed);
  const pick = <X>(xs: X[]): X => xs[Math.floor(r() * xs.length)];
  // لحظاتٌ قليلة متكرّرة بكثافة: تصادمٌ واسع في اللحظة نفسها بين المصادر وداخلها
  const moments = ['2026-11-26T10:00:00.000Z', '2026-11-26T10:00:00.001Z', '2026-11-20T08:00:00.000Z', '2026-06-01T00:00:00.000Z', '2025-12-31T23:59:59.999Z'];
  const id = (p: string, i: number) => `${p}${String(Math.floor(r() * 1e6)).padStart(6, '0')}-${i}`;
  const invoices = Array.from({ length: 25 }, (_, i) => inv(id('i', i), pick(moments), { type: pick(['CREDIT', 'CASH', 'RETURN']), documentKind: pick([null, null, 'CREDIT_NOTE', 'DEBIT_NOTE']) }));
  const receipts = Array.from({ length: 15 }, (_, i) => rcpt(id('r', i), pick(moments)));
  const docs = Array.from({ length: 10 }, (_, i) => ({ id: id('d', i), tenantId: T, customerId: 'c1', kind: 'CR', sizeBytes: 10, uploadedByKind: 'REP', uploadedById: 'r1', uploadedByName: 'أحمد', createdAt: D(pick(moments)) }));
  const callsT = Array.from({ length: 8 }, (_, i) => ({ id: id('k', i), tenantId: T, customerId: 'c1', direction: 'OUT', durationSec: 10, startedAt: D(pick(moments)), salesRepId: 'r1', aiSummary: null }));
  const links = Array.from({ length: 6 }, (_, i) => ({ id: id('p', i), tenantId: T, customerId: 'c1', amount: 10, status: 'paid', createdAt: D(pick(moments)), paidAt: D(pick(moments)), expiresAt: null, salesRepId: 'r1', createdById: null, salesRep: { name: 'أحمد' }, invoice: { number: 'INV-x' } }));
  const orders = Array.from({ length: 6 }, (_, i) => ({ id: id('o', i), tenantId: T, phoneKey: '966501234567', status: 'NEW', customerName: 'زبون', note: null, createdAt: D(pick(moments)), invoiceId: null, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 1 } }));
  const entries = Array.from({ length: 5 }, (_, i) => ({ id: id('e', i), tenantId: T, customerId: 'c1', type: pick(['ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT']), debit: 5, credit: 0, description: 'قيد', entryDate: D('2026-01-01'), createdAt: D(pick(moments)), invoiceId: null, receiptId: null }));
  // أسطر السجلّ: مستقلّة، وميلادٌ لنصف الفواتير وبعض السندات، وإلغاءٌ لبعضها
  const born = new Set<string>();
  const logs: Row[] = [];
  let n = 0;
  for (let i = 0; i < 40; i++) logs.push(logRow(id('L', n++), pick(moments), pick(['CUSTOMER_UPDATED', 'VISIT_RECORDED', 'CALL_LOGGED', 'OTHER', 'CUSTOMER_LOCATION_SET'])));
  for (const x of invoices) {
    if (r() < 0.5) { born.add(`h:invoice:${x.id}`); logs.push(logRow(id('L', n++), pick(moments), x.documentKind === 'CREDIT_NOTE' ? 'CREDIT_NOTE_ISSUED' : x.type === 'RETURN' ? 'RETURN_ISSUED' : 'INVOICE_ISSUED', { refType: 'INVOICE', refId: x.id })); }
    else if (r() < 0.3) logs.push(logRow(id('L', n++), pick(moments), 'INVOICE_CANCELLED', { refType: 'INVOICE', refId: x.id }));
  }
  for (const x of receipts) if (r() < 0.4) { born.add(`h:receipt:${x.id}`); logs.push(logRow(id('L', n++), pick(moments), 'RECEIPT_ISSUED', { refType: 'RECEIPT', refId: x.id })); }
  for (const x of docs) if (r() < 0.4) { born.add(`h:doc:${x.id}`); logs.push(logRow(id('L', n++), pick(moments), 'DOCUMENT_ADDED', { refType: 'DOCUMENT', refId: x.id })); }
  const tables = {
    customer: [{ ...CUST, createdAt: D(pick(moments)) }], invoice: invoices, receipt: receipts, customerDocument: docs, callLog: callsT,
    customerPaymentLink: links, catalogOrder: orders, accountEntry: entries, customerActivity: logs,
  };
  const expected = new Set<string>([
    ...logs.map((l) => l.id),
    ...invoices.map((x) => `h:invoice:${x.id}`), ...receipts.map((x) => `h:receipt:${x.id}`), ...docs.map((x) => `h:doc:${x.id}`),
    ...callsT.map((x) => `h:call:${x.id}`), ...links.map((x) => `h:paylink:${x.id}`), ...links.map((x) => `h:paylinkPaid:${x.id}`),
    ...orders.map((x) => `h:order:${x.id}`), ...entries.map((x) => `h:adj:${x.id}`), 'h:created:c1',
  ].filter((x) => !born.has(x)));
  return { tables, expected };
}

test('الترقيم بلحظاتٍ متساوية بكثافة عبر المصادر: كل الصفحات معاً = القائمة الكاملة بترتيبها، بلا تكرارٍ ولا فجوة (بذورٌ وحدودٌ متعدّدة)', async () => {
  for (const seed of [1, 7, 42, 1337]) {
    const { tables, expected } = randomWorld(seed);
    const { db } = memDb(tables);
    const deps = { db, customerScope: noScope };
    const full = (await page(deps, asAdmin(), { limit: 300 }))!;
    assert.equal(full.nextBefore, null, `seed ${seed}: الكلّ في صفحة`);
    assert.deepEqual(new Set(full.items.map((i) => i.id)), expected, `seed ${seed}: القائمة الكاملة = المتوقَّع`);
    for (let i = 1; i < full.items.length; i++) assert.ok(full.items[i - 1].at >= full.items[i].at, `seed ${seed}: desc`);
    for (const limit of [1, 2, 3, 7, 13, 50]) {
      const got = await allPages(deps, asAdmin(), limit);
      const ids = got.map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length, `seed ${seed} limit ${limit}: تكرار`);
      assert.deepEqual(ids, full.items.map((i) => i.id), `seed ${seed} limit ${limit}: الترتيب/الفجوة`);
    }
  }
});

test('مرشّح القسم: كل قسمٍ بنوده وحدها، والأقسام معاً = الكلّ — وترقيمه بلا تكرارٍ ولا فجوة', async () => {
  const { tables, expected } = randomWorld(99);
  const { db } = memDb(tables);
  const deps = { db, customerScope: noScope };
  const union: string[] = [];
  for (const cat of ca.ACTIVITY_CATEGORIES) {
    const one = (await page(deps, asAdmin(), { limit: 300, category: cat }))!;
    for (const i of one.items) assert.equal(i.category, cat, `${i.id} (${i.action}) في ${cat}`);
    const paged = await allPages(deps, asAdmin(), 4, cat);
    assert.deepEqual(paged.map((i) => i.id), one.items.map((i) => i.id), `${cat}: الترقيم`);
    union.push(...one.items.map((i) => i.id));
  }
  assert.equal(new Set(union).size, union.length, 'بندٌ في قسمين');
  assert.deepEqual(new Set(union), expected, 'الأقسام معاً = الكلّ');
});

test('المخطّط: كل استعلامات القراءة (لكل مصدرٍ ولكل قسم، ومعها حلّ الأسماء) بحقولٍ موجودة في schema.prisma', async () => {
  const { tables } = randomWorld(5);
  const extra = {
    repVisit: [{ id: 'v1', tenantId: T, customerId: 'c1', salesRepId: 'r1', salesRep: { name: 'أحمد' }, note: 'n', durationSec: null, startedAt: null, endedAt: null, lat: null, lng: null, photos: [], createdAt: D('2026-02-01T00:00:00Z') }],
    repRouteStop: [{ id: 's1', tenantId: T, customerId: 'c1', routeId: 'rt1', seq: 1, createdAt: D('2026-02-02T00:00:00Z'), route: { name: 'خط', isActive: true, isPermanent: true, routeDate: null, salesRep: { name: 'أحمد' } } }],
    customerPrice: [{ id: 'cp1', customerId: 'c1', productId: 'p1', price: 3, updatedAt: D('2026-02-03T00:00:00Z'), product: { name: 'ماء' } }],
    customerAssignment: [{ id: 'as1', tenantId: T, customerId: 'c1', salesRepId: 'r9', source: 'MANUAL', createdAt: D('2026-02-04T00:00:00Z'), salesRep: { name: 'سالم' } }],
    cardPayment: [{ id: 'cd1', tenantId: T, customerId: 'c1', amount: 9, status: 'approved', statusDetail: null, createdAt: D('2026-02-05T00:00:00Z'), approvedAt: null, salesRepId: null, createdById: 'a9', cardScheme: 'MADA', salesRep: null, invoice: null }],
    customerAdjustment: [{ id: (tables.accountEntry as Row[])[0].id, tenantId: T, customerId: 'c1', kind: 'DISCOUNT', status: 'ACTIVE', note: null, reference: null, method: null, createdBy: 'a9', cancelledBy: null, cancelReason: null, reverseEntryId: null }],
  };
  const errs: string[] = [];
  const { db } = memDb({ ...tables, ...extra }, errs);
  for (const cat of ['all', ...ca.ACTIVITY_CATEGORIES]) await allPages({ db, customerScope: repScope }, asRep(), 7, cat === 'all' ? undefined : cat);
  assert.deepEqual([...new Set(errs)], []);
});

test('BUG الترقيم يكرّر سجلّ الزيارة المدموجة حين تقطع حدُّ الصفحة وقفتها — routes/customerActivity.ts (مصدر visits)', async () => {
  // وقفةٌ واحدة: مؤقّتٌ (١٠:٠٠–١٠:٣٠، سُجّل ١٠:٣٠) وملاحظتها (سُجّلت ١٠:٢٩). البند المدموج موضعه أحدث سجلّاته (١٠:٣٠) لكنه
  // «استهلك» سجلّ الملاحظة الأقدم — والمؤشّر التالي بعد ١٠:٣٠ يعيد قراءة الملاحظة فتظهر زيارةً ثانية في الصفحة التالية.
  const visit = (id: string, extra: Row) => ({ id, tenantId: T, customerId: 'c1', salesRepId: 'r1', salesRep: { name: 'أحمد' }, note: null, durationSec: null, startedAt: null, endedAt: null, lat: null, lng: null, photos: [], ...extra });
  // وبندٌ آخر بين سجلَّي الوقفة (تعديلٌ على العميل ١٠:٢٩:٣٠) — فيقع حدّ الصفحة بين البند المدموج وسجلّه الأقدم
  const { db } = memDb({
    customer: [CUST],
    repVisit: [
      visit('v-timer', { createdAt: D('2026-10-01T10:30:00Z'), startedAt: D('2026-10-01T10:00:00Z'), endedAt: D('2026-10-01T10:30:00Z'), durationSec: 1800 }),
      visit('v-note', { createdAt: D('2026-10-01T10:29:00Z'), note: 'الرف ممتلئ' }),
    ],
    customerActivity: [logRow('L-mid', '2026-10-01T10:29:30Z', 'CUSTOMER_UPDATED', { refType: 'CUSTOMER', refId: 'c1' })],
  });
  const deps = { db, customerScope: noScope };
  const full = (await page(deps, asAdmin(), { limit: 300 }))!;
  const visitIdsOf = (items: Row[]) => items.filter((i) => i.refType === 'VISIT').flatMap((i) => (i.data?.visitIds as string[] | undefined) ?? [i.refId]);
  assert.deepEqual(visitIdsOf(full.items).sort(), ['v-note', 'v-timer'], 'صفحةٌ واحدة: وقفةٌ واحدة');
  assert.equal(full.items.filter((i) => i.refType === 'VISIT').length, 1);
  for (const limit of [1, 2]) {
    const paged = await allPages(deps, asAdmin(), limit);
    const seen = visitIdsOf(paged);
    assert.deepEqual(paged.map((i) => i.id), full.items.map((i) => i.id), `limit ${limit}: الصفحات ≠ القائمة الكاملة — سجلّات الزيارة عبر الصفحات: ${JSON.stringify(seen)}`);
  }
});

test('BUG الزيارة الواحدة (مؤقّت + ملاحظة) بعد بدء السجلّ بندان في الخطّ الزمني، وقبله بندٌ واحد — الأسطر الحيّة لا تمرّ بدمج الوقفات (services/workDay.ts)', async () => {
  // تطبيق المندوب يرسل سجلَّين للوقفة الواحدة (المؤقّت، والملاحظة/الصورة) — و«mergeVisits المصدر الوحيد للدمج: كل شاشةٍ تعرض الزيارات
  // أو تعدّها تمرّ بها». المصدر المشتقّ يدمجهما وقفةً واحدة، لكنّ كل POST /visits يكتب سطر VISIT_RECORDED مستقلاً يُسقط اشتقاقه،
  // فتظهر الوقفة نفسها زيارتين بعد النشر وزيارةً واحدة قبله.
  reset();
  const stored: Row[] = [];
  const now = Date.now();
  scripted = {
    'salesRep.findFirst': () => REP_ROW,
    'customer.findFirst': () => ({ id: 'c1' }),
    'repVisit.findFirst': () => null,
    'repVisit.create': (a: Row) => {
      const v = { id: `v-${stored.length + 1}`, _count: { photos: 0 }, ...a.data, createdAt: a.data.createdAt ?? new Date() };
      stored.push(v);
      return v;
    },
  };
  // المؤقّت ١٢ دقيقة انتهى قبل دقيقة، والملاحظة الآن — داخل هامش الدمج (٥ دقائق بعد نهاية المؤقّت)
  const timer = await call(visitsRouter, 'post', '/', { user: { ...REP, id: 'r1' }, body: { customerId: 'c1', lat: 24.7, lng: 46.7, startedAt: new Date(now - 12 * 60_000).toISOString(), endedAt: new Date(now - 60_000).toISOString() } });
  assert.equal(timer.status, 201, why(timer));
  const note = await call(visitsRouter, 'post', '/', { user: { ...REP, id: 'r1' }, body: { customerId: 'c1', note: 'الرف ممتلئ' } });
  assert.equal(note.status, 201, why(note));
  const visitRows = stored.map((v) => ({ ...v, tenantId: T, salesRep: { name: 'خالد' }, photos: [] }));
  // قبل بدء السجلّ (الصفوف وحدها): وقفةٌ واحدة
  const before = (await page({ db: memDb({ customer: [CUST], repVisit: visitRows }).db, customerScope: noScope }, asAdmin()))!;
  assert.equal(before.items.filter((i) => i.category === 'visits').length, 1, 'المشتقّ: وقفةٌ واحدة');
  // بعده (الصفوف وأسطرها الحيّة): يجب أن تبقى وقفةً واحدة
  const logged = events().map((e, i) => ({ id: `LV${i}`, amount: null, refNo: null, ...e, at: e.at ?? new Date() }));
  const afterP = (await page({ db: memDb({ customer: [CUST], repVisit: visitRows, customerActivity: logged }).db, customerScope: noScope }, asAdmin()))!;
  assert.equal(afterP.items.filter((i) => i.category === 'visits').length, 1, `الوقفة الواحدة ظهرت ${afterP.items.filter((i) => i.category === 'visits').length} زيارات`);
});

test('BUG محطّة خطّ السير تُعاد كتابتها بكل حفظ فتظهر «أُضيف إلى خط السير» بتاريخ اليوم لعميلٍ لم يتغيّر — routes/customerActivity.ts (logStart لكل عميل)', async () => {
  // العميل c1 في الخطّ منذ يناير. بعد بدء السجلّ في الشركة (لعملاء آخرين أسطر)، حُفظ الخطّ لإعادة ترتيبه: c1 باقٍ فلا حدث (صحيح)، لكن
  // صفّ محطّته حُذف وأُنشئ من جديد بـcreatedAt اليوم — ولأن c1 بلا سطرٍ في السجلّ فـlogStart = null فيُشتقّ «أُضيف» بتاريخ اليوم:
  // إجراءٌ لم يقع. (المتوقَّع: بدء السجلّ على مستوى الشركة/النشر لا أوّل سطرٍ للعميل نفسه)
  const { db } = memDb({
    customer: [CUST, { ...CUST, id: 'c2' }],
    customerActivity: [{ ...logRow('L-other', '2026-11-26T08:00:00Z', 'ROUTE_STOP_ADDED', { refType: 'ROUTE', refId: 'rt-new' }), customerId: 'c2' }],
    repRouteStop: [{ id: 's-c1', tenantId: T, customerId: 'c1', routeId: 'rt-new', seq: 2, createdAt: D('2026-11-26T08:00:00Z'), route: { name: 'خط الأحد', isActive: true, isPermanent: true, routeDate: null, salesRep: { name: 'أحمد' } } }],
  });
  const p = (await page({ db, customerScope: noScope }, asAdmin()))!;
  const fake = p.items.filter((i) => i.action === 'ROUTE_STOP_ADDED' && i.at >= '2026-11-26');
  assert.deepEqual(fake.map((i) => i.id), [], 'لا «إضافة إلى الخط» بتاريخ إعادة الحفظ لعميلٍ لم يتغيّر حاله');
});

// ═══════════════════ ٥) الثبات في القاعدة ═══════════════════

test('المُطلِق (تقييمٌ لشرط الدالّة نفسه): التعديل والتفريغ مرفوضان دائماً، والحذف مرفوضٌ إلا بإذن fs.activity_purge = on حرفياً', () => {
  const fn = guard.ACTIVITY_GUARD_FUNCTION_SQL;
  const body = /BEGIN([\s\S]*?)\nEND;/.exec(fn)![1];
  const m = /^\s*IF ([\s\S]+?) THEN\s+RETURN OLD;\s+END IF;\s+RAISE EXCEPTION '[^']+'[\s\S]*;\s*$/.exec(body);
  assert.ok(m, `بنية الدالّة تغيّرت:\n${body}`);
  assert.equal((body.match(/\bRETURN\b/g) ?? []).length, 1, 'مخرجٌ واحد يسمح (RETURN OLD) — ولا RETURN NEW أبداً');
  const setting = `coalesce(current_setting('${guard.ACTIVITY_PURGE_SETTING}', true), '')`;
  assert.ok(m![1].includes(setting), m![1]);
  const js = m![1].split(setting).join('(SETTING ?? \'\')').replace(/\bTG_OP\b/g, 'OP').replace(/ AND /g, ' && ').replace(/ OR /g, ' || ').replace(/ = /g, ' === ');
  const allows = new Function('OP', 'SETTING', `return (${js});`) as (op: string, s: string | null) => boolean;
  for (const s of [null, '', 'off', 'ON', 'true', '1', ' on', 'on ']) {
    for (const op of ['UPDATE', 'DELETE', 'TRUNCATE']) assert.equal(allows(op, s), false, `${op} / ${JSON.stringify(s)}`);
  }
  assert.equal(allows('DELETE', 'on'), true);
  assert.equal(allows('UPDATE', 'on'), false, 'لا تعديل ولو بالإذن');
  assert.equal(allows('TRUNCATE', 'on'), false, 'ولا تفريغ');
  const trg = guard.ACTIVITY_GUARD_TRIGGERS_SQL;
  assert.match(trg, /CREATE TRIGGER fs_customer_activity_immutable BEFORE UPDATE OR DELETE ON customer_activities FOR EACH ROW EXECUTE FUNCTION fs_customer_activity_immutable\(\)/);
  assert.match(trg, /CREATE TRIGGER fs_customer_activity_no_truncate BEFORE TRUNCATE ON customer_activities FOR EACH STATEMENT EXECUTE FUNCTION fs_customer_activity_immutable\(\)/);
});

test('allowActivityPurge: الإعداد نفسه الذي يقرؤه المُطلِق، محليّاً للمعاملة (is_local = true) — لا للجلسة', async () => {
  const seen: string[] = [];
  await guard.allowActivityPurge({ $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => { seen.push(s.join('?') + (v.length ? `|${v.join(',')}` : '')); return []; } });
  assert.equal(seen.length, 1);
  const m = /set_config\('([^']+)', 'on', (true|false)\)/.exec(seen[0]);
  assert.ok(m, seen[0]);
  assert.equal(m![1], guard.ACTIVITY_PURGE_SETTING);
  assert.equal(m![2], 'true');
});

/** ملفّات المصدر (بلا الاختبارات) — و prisma وscripts إن وُجدا */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['tests', 'node_modules', 'dist', '__fixtures__'].includes(e.name)) walk(p, out); continue; }
    if (/\.(ts|js|mjs|cjs|sql)$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('كل مسار حذفٍ للشركة كلها (بحثاً في المصدر) يأذن بالحذف داخل معاملته قبل حذف صفّها — والمخطّط لا يُعاقب السجلّ إلا من الشركة', () => {
  const files = [...walk(SRC), ...walk(path.join(BACKEND, 'prisma')), ...walk(path.join(BACKEND, 'scripts'))];
  const DELETE_TENANT = /\b(\w+)\.tenant\.(delete|deleteMany)\(|DELETE\s+FROM\s+"?tenants"?\b|TRUNCATE[^;`]*\btenants\b/gi;
  const hits: string[] = [];
  for (const f of files) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of text.matchAll(DELETE_TENANT)) {
      const rel = path.relative(BACKEND, f).split(path.sep).join('/');
      hits.push(rel);
      const at = m.index!;
      const txStart = Math.max(text.lastIndexOf('$transaction(async (tx) =>', at), text.lastIndexOf('$transaction(async tx =>', at));
      assert.ok(txStart >= 0, `${rel}: حذف الشركة خارج معاملة`);
      assert.equal(m[1], 'tx', `${rel}: حذف الشركة بغير مقبض المعاملة (${m[0]})`);
      const between = text.slice(txStart, at);
      assert.match(between, /await allowActivityPurge\(tx\);/, `${rel}: لا إذن بحذف السجلّ داخل معاملة حذف الشركة`);
      // لا معاملة أخرى تبدأ بين الإذن والحذف (الإذن يموت بانتهاء معاملته)
      assert.equal(/\$transaction\(/.test(between.slice(between.lastIndexOf('allowActivityPurge'))), false, rel);
    }
  }
  assert.deepEqual([...new Set(hits)], ['src/routes/tenants.ts'], 'مسارات حذف الشركة المعروفة');

  const schema = fs.readFileSync(path.join(BACKEND, 'prisma', 'schema.prisma'), 'utf8');
  const block = schema.slice(schema.indexOf('model CustomerActivity {'), schema.indexOf('\n}', schema.indexOf('model CustomerActivity {')));
  const rels = block.split('\n').filter((l) => l.includes('@relation('));
  assert.equal(rels.length, 1, `علاقات السجلّ: ${rels.join(' | ')}`);
  assert.match(rels[0], /^\s*tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);
  // ولا نموذج آخر يشير إلى السجلّ (فلا يحذفه حذفُ غيره)
  const inbound = [...schema.matchAll(/^[ \t]*(?!model\b)\w+[ \t]+CustomerActivity\b[^\n]*$/gm)].map((x) => x[0].trim().replace(/\s+/g, ' '));
  assert.deepEqual(inbound, ['customerActivities CustomerActivity[]'], 'لا إشارة إلى السجلّ إلا القائمة العكسية في الشركة');
});

test('حذف الشركة (المسار الحقيقي): set_config داخل المعاملة نفسها قبل حذف صفّ الشركة — والإذن لا يُمنح خارجها', async () => {
  reset();
  scripted = {
    'tenant.findUnique': () => ({ id: T, name: 'شركة' }),
    'tenant.delete': () => ({ id: T }),
  };
  const tenantsRouter = require('../routes/tenants').default;
  const r = await quiet(() => call(tenantsRouter, 'delete', '/:id', { user: { id: 'owner-1', role: 'SUPER_ADMIN', tenantId: null, name: 'المالك' }, params: { id: T }, query: { confirmLotRecords: '1' } }));
  assert.equal(r.status, 200, why(r));
  const grant = calls.find((c) => c.op === '$queryRaw' && /set_config\('fs\.activity_purge', 'on', true\)/.test(c.args.sql));
  const del = calls.find((c) => c.op === 'tenant.delete');
  assert.ok(grant && del, calls.map((c) => c.op).join(' → '));
  assert.notEqual(grant!.tx, null, 'الإذن داخل معاملة');
  assert.equal(grant!.tx, del!.tx, 'في معاملة الحذف نفسها');
  assert.ok(calls.indexOf(grant!) < calls.indexOf(del!), 'قبل حذف صفّ الشركة');
  assert.equal(calls.filter((c) => /set_config\('fs\.activity_purge'/.test(c.args?.sql ?? '')).length, 1);
});
