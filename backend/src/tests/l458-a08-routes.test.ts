// «ربط الدفاتر» L4+L5 — المنفّذ A8: المسارات التشغيلية الحقيقية (POST /api/invoices، POST /api/receipts، GET cancel-options،
// PATCH cancel) فوق عميل Prisma مزيّف (نمط tax-off-invoices.test.ts). لا قاعدة ولا شبكة. المطلوب إثباته:
//   • B1 (E4.4): الآجلة بلا أقساط ولا استحقاق في المربوطة ⇒ dueDate = بداية (يوم المستند + paymentDays) بتوقيت الشركة؛ وغير المربوطة
//     (لا دفاتر، يدوية، مربوطة غير مفعّلة، قديمة) ⇒ المستند نفسه حرفاً (dueDate غائب).
//   • B6 (E4.9): مرتجع مرتبط ببيعٍ خاضع في شركةٍ أزالت ضريبتها ودفاترها مربوطة ⇒ ضريبة البيع تُعكس (taxAmt>0) والختم taxFree باقٍ
//     ولا مزوّد فوترة؛ وغير المربوطة ⇒ صفرٌ كما اليوم.
//   • C6: ONLINE يدوي ⇒ 422 RECEIPT_ONLINE_MANUAL للمربوطة والقديمة؛ والإعادة ومفتاح API 201؛ وغيرها 201.
//   • C11: خيارات الإلغاء (E5.7)، وكتابة cancelRefundFrom داخل المعاملة قبل عكس القيود، والرفض 400 برمزه.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// صرفةٌ بلا قاعدة — للمطابقة وحدها (الملفات المحروسة لا تستوردها)
import { zonedStartOfDay } from '../services/gl/dates';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
let calls: string[] = [];
let args: Record<string, unknown[]> = {};
let scripted: Record<string, (a: any) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0, amount: 0, paidAmt: 0 } };
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
    if (key === '$queryRaw' || key === '$executeRaw') return async () => { calls.push(key); return key === '$queryRaw' ? [] : 0; };
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TID = 'tenant-a8';
type User = { id: string; role: string; tenantId: string; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: TID };
const REP_USER: User = { id: 'rep-1', role: 'SALES_REP', tenantId: TID };
const API_KEY: User = { id: 'admin-1', role: 'ADMIN', tenantId: TID, apiKeyId: 'key-1' };
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
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('فرع المرحلة الثانية لا يُبلغ في هذه الاختبارات'); } });
/* عهدة مستخدم الشركة (A5 — services/userCustody.ts): بديلٌ بأرقامٍ ثابتة لكل مستخدم، وقفلٌ يُسجَّل في التسلسل. الطيّ نفسه يختبره A5؛
 * وهنا ما يخصّ الإلغاء: متى يُقرأ، وأنّ القفل يسبق الكتابة. handoverAllowed بالهامش نفسه (نصف هللة) */
let custodyOf: Record<string, number> = {};
stub('services/userCustody', {
  CUSTODY_EPS: 0.005,
  userCustody: async (_db: unknown, _tid: string, uid: string) => {
    calls.push(`userCustody:${uid}`);
    const o = custodyOf[uid] ?? 0;
    return { received: o, delivered: 0, outstanding: o, nonCashReceived: 0, passThrough: 0 };
  },
  lockCustody: async (_tx: unknown, _tid: string, uid: string) => { calls.push(`lockCustody:${uid}`); },
  handoverAllowed: (outstanding: number, amount: number) => Number.isFinite(amount) && amount > 0 && amount <= outstanding + 0.005,
});

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesModule = require('../routes/invoices') as typeof import('../routes/invoices');
const receiptsRouter = (require('../routes/receipts') as typeof import('../routes/receipts')).default as express.Router;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
/* eslint-enable @typescript-eslint/no-var-requires */
const { creditDefaultDueDate, companyDayStart, returnKeepsSaleVat } = invoicesModule;

// ═══ الخادم ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesModule.default as express.Router);
  app.use('/api/receipts', receiptsRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Row };
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const s = await startServer();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: p, agent: false,
      headers: {
        connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...headers,
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b: Row = {}; try { b = t ? JSON.parse(t) : {}; } catch { b = { raw: t }; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function reset(user: User = ADMIN): void {
  calls = []; args = {}; scripted = {}; custodyOf = {};
  currentUser = user;
  delete process.env.ZATCA_REHEARSAL_TENANT_IDS;
}
const lastArg = (key: string): Row => {
  const a = (args[key] ?? []).slice(-1)[0] as Row | undefined;
  assert.ok(a, `لا نداء ${key}: ${calls.join(' → ')}`);
  return a!;
};

// ═══ صفوف gl_settings ═══

const ACTIVE = new Date('2026-01-01T00:00:00Z');
const GL = {
  NONE: null,
  CLEAN: { setupMethod: 'CLEAN', activatedAt: ACTIVE, timezone: 'Asia/Riyadh', receiptRouting: null },
  LINKED_UNACTIVATED: { setupMethod: 'LINKED', activatedAt: null, timezone: 'Asia/Riyadh', receiptRouting: null },
  LEGACY: { setupMethod: 'OPENING', activatedAt: ACTIVE, timezone: 'Asia/Riyadh', receiptRouting: { CASH: 'CUSTODY', CHEQUE: 'CUSTODY' } },
  LINKED: { setupMethod: 'LINKED', activatedAt: ACTIVE, timezone: 'Asia/Riyadh', receiptRouting: { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'DIRECT' } },
} as const;
type GlKey = keyof typeof GL;
const glRow = (k: GlKey, over: Row = {}): Row | null => (GL[k] ? { ...GL[k], ...over } : null);

// ═══ (أ) الفواتير: B1 وB6 ═══

const productRow = (id: string, name: string, basePrice: number): Row => ({
  id, name, unit: 'حبة', basePrice, taxPct: 15, damagedReturnToStock: true, priceTiers: [], units: [], teams: [], categoryId: null,
  lotTracked: false, repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: null, repReturnUnit: null, repRulesChangedAt: null,
  baseConvertedAt: null, primaryUnitId: null, shelfLifeEnabled: false, returnRuleEnabled: false,
});
const PRODUCT_ROWS = [productRow('p-a', 'صنف أ', 100), productRow('p-b', 'صنف ب', 40)];
const REP: Row = {
  id: 'rep-1', tenantId: TID, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, maxDiscountPct: 100,
  canCreateReceipt: true, canCancelReceipt: true, teamMemberships: [], tenant: { settings: { teamsEnabled: false, paymentMethodsConfig: null } },
};
const CUSTOMER: Row = { id: 'c-1', name: 'عميل', status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: TID, priceListId: null, paymentDays: 30 };
const BASE_SETTINGS: Row = {
  defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null,
  returnRequiresSaleInvoice: null, returnPolicyChangedAt: null, taxDisabled: false, taxModeChangedAt: null,
};
const TAX_OFF: Row = { ...BASE_SETTINGS, taxDisabled: true, taxModeChangedAt: new Date('2026-11-07T08:00:00.000Z') };

/** E4.9: البيع INV-900 كرتونٌ واحد بـ١١٥ شاملاً (١٠٠ + ١٥) — صدر بضريبته قبل الإزالة */
let saleLines: Row[] = [];
/** فاتورة البيع كما يقرؤها assertReturnLinks — بنودها من saleLines نفسها (s-1 للصنف أ، وs-2 للصنف ب) */
const saleOf = (): Row => ({
  customerId: 'c-1', type: 'CREDIT', status: 'CONFIRMED', documentKind: null, locationId: null,
  items: saleLines.map((l) => ({ id: l.id, productId: l.id === 's-1' ? 'p-a' : 'p-b', qty: l.qty, unitFactor: 1, baseQty: l.qty })),
});

function scriptInvoices(settings: Row, gl: Row | null, o: { customer?: Row; saleTaxFree?: boolean } = {}): void {
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => REP,
    'customer.findFirst': () => ({ ...CUSTOMER, ...(o.customer ?? {}) }),
    'product.findMany': (a: { where?: { id?: { in?: string[] } } }) => { const ids = a.where?.id?.in ?? []; return PRODUCT_ROWS.filter(p => ids.includes(p.id)); },
    'companySettings.findUnique': (a: { select?: Row }) => (a.select?.defaultVatPct ? { ...settings } : { customerIsolationEnabled: false }),
    'tenant.findUnique': () => ({ invoiceSignatureEnabled: false, lotTrackingEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'glSettings.findUnique': () => gl,
    'invoice.findFirst': (a: { select?: Row }) => {
      if (a.select?.items) return saleOf();
      if (a.select?.taxFree) return { taxFree: o.saleTaxFree ?? false };
      return null;
    },
    'invoiceItem.findMany': (a: { where?: Row }) => {
      const w = a.where ?? {};
      if (w.OR) return [];
      const ids: string[] = (w.id as { in?: string[] } | undefined)?.in ?? [];
      return saleLines.filter(l => ids.includes(l.id));
    },
    'invoice.create': (a: { data: Row }) => {
      const data = a.data;
      const items = ((data.items as { create?: Row[] } | undefined)?.create ?? []).map((i, k) => ({ id: `i${k}`, ...i }));
      return { id: 'inv-1', ...data, items, customer: CUSTOMER, installments: [], signature: null };
    },
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
}

const line = (over: Row = {}): Row => ({ productId: 'p-a', qty: 2, unitPrice: 100, discountPct: 0, taxPct: 15, ...over });
const creditBody = (over: Row = {}): Row => ({
  customerId: 'c-1', salesRepId: 'rep-1', type: 'CREDIT', pricesIncludeTax: false, discountPct: 0, items: [line()],
  invoiceDate: '2026-11-14T10:00:00+03:00', ...over,
});
const created = (): Row => lastArg('invoice.create').data as Row;

test('B1 صرفاً: بداية يوم الشركة تطابق zonedStartOfDay في الدفاتر لكل منطقة (ومنها قفزة منتصف الليل)، والاستحقاق = يوم المستند + المهلة', () => {
  const zones = ['Asia/Riyadh', 'America/New_York', 'Asia/Kolkata', 'Pacific/Apia', 'America/Santiago', 'Asia/Tehran', 'Europe/London', 'UTC', 'Pacific/Kiritimati', 'America/St_Johns'];
  const days = ['2026-01-01', '2026-03-08', '2026-03-29', '2026-04-05', '2026-09-06', '2026-10-25', '2026-11-01', '2026-12-14', '2027-02-28', '2024-02-29'];
  for (const tz of zones) for (const d of days) {
    assert.equal(companyDayStart(d, tz).toISOString(), zonedStartOfDay(d, tz).toISOString(), `${tz} ${d}`);
  }
  // E4.4: فاتورة ١٤ نوفمبر ٢٠٢٦ بمهلة ٣٠ ⇒ استحقاق ١٤ ديسمبر (بداية يومه بالرياض = 21:00Z من ١٣ ديسمبر)
  const at = new Date('2026-11-14T10:00:00+03:00');
  assert.equal(creditDefaultDueDate(at, 'Asia/Riyadh', 30)!.toISOString(), '2026-12-13T21:00:00.000Z');
  // يوم المستند بتوقيت الشركة لا بتوقيت UTC: ٠٠:٣٠ بالرياض = ٢١:٣٠Z من اليوم السابق
  assert.equal(creditDefaultDueDate(new Date('2026-11-14T00:30:00+03:00'), 'Asia/Riyadh', 30)!.toISOString(), '2026-12-13T21:00:00.000Z');
  assert.equal(creditDefaultDueDate(at, 'America/New_York', 30)!.toISOString(), '2026-12-14T05:00:00.000Z');
  assert.equal(creditDefaultDueDate(at, 'Asia/Riyadh', 0)!.toISOString(), '2026-11-13T21:00:00.000Z', 'مهلة صفر = يوم المستند');
  assert.equal(creditDefaultDueDate(at, 'Asia/Riyadh', -5)!.toISOString(), '2026-11-13T21:00:00.000Z', 'السالبة صفر');
  assert.equal(creditDefaultDueDate(at, 'Asia/Riyadh', 30.9)!.toISOString(), '2026-12-13T21:00:00.000Z', 'الكسر يُقطع');
  assert.equal(creditDefaultDueDate(new Date('2026-12-20T12:00:00Z'), 'Asia/Riyadh', 45)!.toISOString(), '2027-02-02T21:00:00.000Z', 'عبر السنة');
  assert.equal(creditDefaultDueDate(at, 'Asia/Riyadh', null), undefined);
  assert.equal(creditDefaultDueDate(at, 'Asia/Riyadh', Number.NaN), undefined);
  assert.equal(creditDefaultDueDate(new Date('not-a-date'), 'Asia/Riyadh', 30), undefined, 'تاريخٌ غير صالح لا يرمي');
});

test('B1: الآجلة بلا أقساط ولا استحقاق في المربوطة ⇒ dueDate = بداية (يوم المستند + paymentDays) بتوقيت الشركة — قراءة gl_settings واحدة', async () => {
  for (const [tz, want] of [['Asia/Riyadh', '2026-12-13T21:00:00.000Z'], ['America/New_York', '2026-12-14T05:00:00.000Z']] as const) {
    reset(ADMIN);
    scriptInvoices(BASE_SETTINGS, glRow('LINKED', { timezone: tz }));
    const r = await call('POST', '/api/invoices', creditBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((created().dueDate as Date).toISOString(), want, tz);
    assert.equal(r.body.data.dueDate, want);
    assert.equal(calls.filter(c => c === 'glSettings.findUnique').length, 1);
    assert.deepEqual(lastArg('glSettings.findUnique'), { where: { tenantId: TID }, select: { setupMethod: true, activatedAt: true, timezone: true } });
  }
  // منطقة الدفاتر غائبة ⇒ بلد الشركة (SA ⇒ الرياض)
  reset(ADMIN);
  scriptInvoices(BASE_SETTINGS, glRow('LINKED', { timezone: null }));
  await call('POST', '/api/invoices', creditBody());
  assert.equal((created().dueDate as Date).toISOString(), '2026-12-13T21:00:00.000Z');
  // مهلة العميل صفر ⇒ يوم المستند نفسه
  reset(ADMIN);
  scriptInvoices(BASE_SETTINGS, glRow('LINKED'), { customer: { paymentDays: 0 } });
  await call('POST', '/api/invoices', creditBody());
  assert.equal((created().dueDate as Date).toISOString(), '2026-11-13T21:00:00.000Z');
});

test('B1: الاستحقاق الصريح والأقساط والنقدية لا يمسّها شيء — ولا قراءة لـgl_settings', async () => {
  reset(ADMIN);
  scriptInvoices(BASE_SETTINGS, glRow('LINKED'));
  let r = await call('POST', '/api/invoices', creditBody({ dueDate: '2027-01-31' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((created().dueDate as Date).toISOString(), new Date('2027-01-31').toISOString());
  assert.ok(!calls.includes('glSettings.findUnique'));
  reset(ADMIN);
  scriptInvoices(BASE_SETTINGS, glRow('LINKED'));
  r = await call('POST', '/api/invoices', creditBody({ paymentPlan: 'INSTALLMENT', installmentPlan: { count: 2, firstDueDate: '2026-12-14', period: 'MONTHLY' } }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const inst = (created().installments as { create: Row[] }).create;
  assert.equal(inst.length, 2);
  assert.equal((created().dueDate as Date).toISOString(), (inst[1].dueDate as Date).toISOString(), 'الاستحقاق آخر قسط كما كان');
  assert.ok(!calls.includes('glSettings.findUnique'));
  reset(ADMIN);
  scriptInvoices(BASE_SETTINGS, glRow('LINKED'));
  r = await call('POST', '/api/invoices', creditBody({ type: 'CASH' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(created().dueDate, undefined);
  assert.ok(!calls.includes('glSettings.findUnique'));
});

test('B1: غير المربوطة (بلا دفاتر، يدوية CLEAN، مربوطة غير مفعّلة، قديمة OPENING) ⇒ المستند والردّ حرفاً كما اليوم (dueDate غائب)', async () => {
  const runs: Array<{ k: GlKey; create: Row; body: Row; calls: string[] }> = [];
  for (const k of ['NONE', 'CLEAN', 'LINKED_UNACTIVATED', 'LEGACY'] as GlKey[]) {
    reset(ADMIN);
    scriptInvoices(BASE_SETTINGS, glRow(k));
    const r = await call('POST', '/api/invoices', creditBody());
    assert.equal(r.status, 201, `${k}: ${JSON.stringify(r.body)}`);
    assert.equal(created().dueDate, undefined, k);
    assert.equal('dueDate' in r.body.data && r.body.data.dueDate !== undefined, false, `${k}: الردّ يحمل استحقاقاً`);
    runs.push({ k, create: created(), body: r.body, calls: [...calls] });
  }
  for (const x of runs.slice(1)) {
    assert.deepEqual(x.create, runs[0].create, `${x.k}: بيانات المستند تغيّرت`);
    assert.deepEqual(x.body, runs[0].body, `${x.k}: الردّ تغيّر`);
    assert.deepEqual(x.calls, runs[0].calls, `${x.k}: تسلسل الاستعلامات تغيّر`);
  }
  // الزائد الوحيد على مسار اليوم: قراءة gl_settings مرّة واحدة
  assert.equal(runs[0].calls.filter(c => c === 'glSettings.findUnique').length, 1);
});

// ── B6 ──

const returnBody = (over: Row = {}): Row => ({
  customerId: 'c-1', salesRepId: 'rep-1', type: 'RETURN', originalInvoiceId: 'sale-900', pricesIncludeTax: true, discountPct: 0,
  items: [{ productId: 'p-a', invoiceItemId: 's-1', qty: 1, unitPrice: 999, discountPct: 0, taxPct: 0 }], ...over,
});
const createdItems = (): Row[] => (created().items as { create: Row[] }).create;

test('B6 (E4.9): مرتجع مرتبط ببيعٍ خاضع في شركةٍ أزالت ضريبتها ودفاترها مربوطة ⇒ الصافي ١٠٠ والضريبة ١٥ والإجمالي ١١٥، والختم taxFree وبلا فوترة', async () => {
  saleLines = [{ id: 's-1', qty: 1, unitFactor: 1, lineTotal: 115, taxPct: 15 }, { id: 's-2', qty: 2, unitFactor: 1, lineTotal: 46, taxPct: 15 }];
  reset(ADMIN);
  scriptInvoices(TAX_OFF, glRow('LINKED'));
  const r = await call('POST', '/api/invoices', returnBody());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = created();
  assert.equal(d.taxFree, true, 'الختم باقٍ');
  assert.equal(d.einvoiceProvider, 'none');
  assert.equal(d.einvoiceStatus, null);
  assert.deepEqual([d.subtotal, d.taxAmt, d.total, d.pricesIncludeTax, d.discountAmt], [100, 15, 115, true, 0]);
  assert.deepEqual(createdItems().map(i => [i.taxPct, i.taxAmt, i.lineTotal, i.returnOfItemId]), [[15, 15, 115, 's-1']]);
  // القراءتان الزائدتان: gl_settings ثم ختم فاتورة البيع — للمربوطة
  assert.deepEqual(lastArg('glSettings.findUnique').select, { setupMethod: true, activatedAt: true });
  assert.ok((args['invoice.findFirst'] ?? []).some((a) => (a as Row).select?.taxFree === true));
  // ولا يدخل فرع المرحلة الثانية (لو دخل لرمى البديل أعلاه)
});

test('B6: بندان مختلطان بالدينار (ثلاث منازل) — المبلغ المسترد نفسه، والضريبة من نسبة البيع، والصافي + الضريبة = الإجمالي', async () => {
  saleLines = [{ id: 's-1', qty: 3, unitFactor: 1, lineTotal: 1.099, taxPct: 10 }, { id: 's-2', qty: 2, unitFactor: 1, lineTotal: 0.5, taxPct: 0 }];
  const body = returnBody({ items: [
    { productId: 'p-a', invoiceItemId: 's-1', qty: 3, unitPrice: 1, discountPct: 0, taxPct: 0 },
    { productId: 'p-b', invoiceItemId: 's-2', qty: 2, unitPrice: 1, discountPct: 0, taxPct: 0 },
  ] });
  const bhd = { ...TAX_OFF, countryCode: 'BH', currency: 'BHD' };
  reset(ADMIN);
  scriptInvoices(bhd, glRow('LINKED', { timezone: 'Asia/Bahrain' }));
  const on = await call('POST', '/api/invoices', body);
  assert.equal(on.status, 201, JSON.stringify(on.body));
  const d = created();
  reset(ADMIN);
  scriptInvoices(bhd, glRow('CLEAN'));
  await call('POST', '/api/invoices', body);
  const today = created();
  assert.equal(d.total, today.total, 'المبلغ المسترد تغيّر');
  assert.equal(d.total, 1.599);
  assert.equal(d.taxAmt, 0.1, 'ضريبة البند الخاضع: 1.099 × 10/110 = 0.0999… ⇒ 0.100');
  assert.equal(Math.round((d.subtotal + d.taxAmt) * 1000), Math.round(d.total * 1000));
  assert.deepEqual((d.items as { create: Row[] }).create.map(i => [i.taxPct, i.taxAmt, i.lineTotal]), [[10, 0.1, 1.099], [0, 0, 0.5]]);
  assert.equal(d.subtotal, 1.499);
  assert.equal(today.taxAmt, 0);
  assert.deepEqual((today.items as { create: Row[] }).create.map(i => i.lineTotal), [1.099, 0.5], 'البند نفسه بلا ضريبة');
  assert.equal(d.taxFree, true);
});

test('B6: غير المربوطة، والبيع المختوم taxFree، وبيعٌ بنوده صفر، والشركة بضريبتها ⇒ كما اليوم حرفاً (وبلا قراءة حيث لا يلزم)', async () => {
  saleLines = [{ id: 's-1', qty: 1, unitFactor: 1, lineTotal: 115, taxPct: 15 }];
  const zeroDoc = (d: Row): void => {
    assert.equal(d.taxFree, true);
    assert.deepEqual([d.subtotal, d.taxAmt, d.total], [115, 0, 115]);
    assert.deepEqual((d.items as { create: Row[] }).create.map(i => [i.taxPct, i.taxAmt, i.lineTotal]), [[0, 0, 115]]);
  };
  const docs: Row[] = [];
  for (const k of ['NONE', 'CLEAN', 'LINKED_UNACTIVATED', 'LEGACY'] as GlKey[]) {
    reset(ADMIN);
    scriptInvoices(TAX_OFF, glRow(k));
    const r = await call('POST', '/api/invoices', returnBody());
    assert.equal(r.status, 201, `${k}: ${JSON.stringify(r.body)}`);
    zeroDoc(created());
    docs.push(created());
    assert.ok(!(args['invoice.findFirst'] ?? []).some((a) => (a as Row).select?.taxFree), `${k}: قراءة ختم البيع لغير المربوطة`);
  }
  for (const d of docs.slice(1)) assert.deepEqual(d, docs[0]);
  // بيعٌ مختوم «بلا ضريبة» (بياناتٌ شاذّة ببندٍ خاضع): لا يُعكس ما لم يُفرض
  reset(ADMIN);
  scriptInvoices(TAX_OFF, glRow('LINKED'), { saleTaxFree: true });
  await call('POST', '/api/invoices', returnBody());
  zeroDoc(created());
  // بيعٌ بنوده صفر ⇒ لا قراءة أصلاً
  saleLines = [{ id: 's-1', qty: 1, unitFactor: 1, lineTotal: 115, taxPct: 0 }];
  reset(ADMIN);
  scriptInvoices(TAX_OFF, glRow('LINKED'));
  await call('POST', '/api/invoices', returnBody());
  zeroDoc(created());
  assert.ok(!calls.includes('glSettings.findUnique'));
  // الشركة بضريبتها: B6 لا ينطبق ولا قراءة (المرتجع بضريبته كما اليوم وبلا ختم)
  saleLines = [{ id: 's-1', qty: 1, unitFactor: 1, lineTotal: 115, taxPct: 15 }];
  reset(ADMIN);
  scriptInvoices(BASE_SETTINGS, glRow('LINKED'));
  await call('POST', '/api/invoices', returnBody());
  assert.equal('taxFree' in created(), false);
  assert.deepEqual([created().taxAmt, created().total], [15, 115]);
  assert.ok(!calls.includes('glSettings.findUnique'));
});

test('returnKeepsSaleVat صرفاً: الشروط الأربعة معاً', () => {
  const taxed = new Map([['s', { id: 's', qty: 1, unitFactor: 1, lineTotal: 115, taxPct: 15 }]]);
  const zero = new Map([['s', { id: 's', qty: 1, unitFactor: 1, lineTotal: 115, taxPct: 0 }]]);
  assert.equal(returnKeepsSaleVat({ linked: true, docTaxFree: true, saleTaxFree: false, saleLines: taxed }), true);
  assert.equal(returnKeepsSaleVat({ linked: true, docTaxFree: true, saleTaxFree: null, saleLines: taxed }), true);
  assert.equal(returnKeepsSaleVat({ linked: false, docTaxFree: true, saleTaxFree: false, saleLines: taxed }), false);
  assert.equal(returnKeepsSaleVat({ linked: true, docTaxFree: false, saleTaxFree: false, saleLines: taxed }), false);
  assert.equal(returnKeepsSaleVat({ linked: true, docTaxFree: true, saleTaxFree: true, saleLines: taxed }), false);
  assert.equal(returnKeepsSaleVat({ linked: true, docTaxFree: true, saleTaxFree: false, saleLines: zero }), false);
});

// ═══ (ب) السندات: C6 ═══

function scriptReceipts(gl: Row | null): void {
  scripted = {
    'receipt.findUnique': (a: Row) => (a.where?.id ? { id: a.where.id, number: 'RCP-2611-000001', invoiceItems: [] } : null),
    'salesRep.findFirst': () => REP,
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'customer.findFirst': () => CUSTOMER,
    'companySettings.findUnique': () => ({ customerIsolationEnabled: false }),
    'glSettings.findUnique': () => gl,
    'receipt.create': (a: { data: Row }) => ({ id: 'r-1', ...a.data }),
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
}
const receiptBody = (over: Row = {}): Row => ({ customerId: 'c-1', salesRepId: 'rep-1', amount: 100, paymentMethod: 'ONLINE', ...over });

test('C6: ONLINE يدويّ في المربوطة والقديمة ⇒ 422 RECEIPT_ONLINE_MANUAL بلا معاملة ولا سند', async () => {
  for (const k of ['LINKED', 'LEGACY'] as GlKey[]) {
    for (const user of [ADMIN, REP_USER]) {
      reset(user);
      scriptReceipts(glRow(k));
      const r = await call('POST', '/api/receipts', receiptBody());
      assert.equal(r.status, 422, `${k}/${user.role}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { success: false, code: 'RECEIPT_ONLINE_MANUAL', message: 'السند الإلكتروني يُنشأ من رابط الدفع وحده — سجّل الطريقة الفعلية للتحصيل' });
      assert.ok(!calls.includes('$transaction') && !calls.includes('receipt.create'), calls.join(' → '));
      assert.deepEqual(lastArg('glSettings.findUnique'), { where: { tenantId: TID }, select: { setupMethod: true, activatedAt: true } });
    }
  }
});

test('C6: الإعادة (X-FS-Replay) ومفتاح API لا يُرفضان أبداً، وغير المرحِّلة كما اليوم، وغير ONLINE بلا قراءة', async () => {
  const ok = async (user: User, gl: Row | null, body: Row, headers: Record<string, string> = {}): Promise<string[]> => {
    reset(user);
    scriptReceipts(gl);
    const r = await call('POST', '/api/receipts', body, headers);
    assert.equal(r.status, 201, `${user.role}/${JSON.stringify(gl)}: ${JSON.stringify(r.body)}`);
    assert.equal(lastArg('receipt.create').data.paymentMethod, body.paymentMethod);
    return [...calls];
  };
  await ok(REP_USER, glRow('LINKED'), receiptBody(), { 'X-FS-Replay': '1' });
  await ok(ADMIN, glRow('LINKED'), receiptBody(), { 'X-FS-Replay': '1' });
  const viaKey = await ok(API_KEY, glRow('LINKED'), receiptBody());
  assert.ok(!viaKey.includes('glSettings.findUnique'), 'المفتاح لا يدفع قراءة');
  for (const k of ['NONE', 'CLEAN', 'LINKED_UNACTIVATED'] as GlKey[]) await ok(ADMIN, glRow(k), receiptBody());
  for (const m of ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE']) {
    const c = await ok(ADMIN, glRow('LINKED'), receiptBody({ paymentMethod: m }));
    assert.ok(!c.includes('glSettings.findUnique'), `${m}: قراءة gl_settings`);
  }
});

// ═══ (ج) السندات: C11 — خيارات الإلغاء والكتابة ═══

const RECEIPT_DATE = new Date('2026-11-10T09:00:00Z');
const receiptRow = (over: Row = {}): Row => ({
  id: 'r-7', tenantId: TID, number: 'RCP-2611-000007', customerId: 'c-1', salesRepId: 'rep-1', amount: 500, paymentMethod: 'CASH',
  receiptDate: RECEIPT_DATE, status: 'ACTIVE', invoiceItems: [], ...over,
});

interface CancelScene {
  gl: Row | null;
  receipt?: Row;
  /** آخر استلامٍ بعد السند (null = لا استلام) */
  last?: Row | null;
  /** رصيد التحصيل: Σ السندات النشطة، Σ النقدية المحسوبة، Σ الاستلامات */
  sums?: { collected: number; cash: number; settled: number };
  admins?: Record<string, string>;
  custody?: Record<string, number>;
  card?: boolean;
  /** صفّ المُلغي (صلاحياته ونطاقه) فوق الافتراضي */
  caller?: Row;
}
function scriptCancel(s: CancelScene): void {
  const rcp = receiptRow(s.receipt);
  // صفّ السند حيّاً: ما تكتبه المعاملة يقرؤه findUniqueOrThrow بعدها (كالقاعدة)
  const state: Row = { ...rcp };
  scripted = {
    // المُلغي الافتراضي: مديرٌ غير مقيّد بصلاحية عهدة التحصيل (حارس الإسناد — مراجعة ١٤ نوفمبر)؛ s.caller يبدّله
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true, canManageCompanyUsers: true, canReceiveUserCollections: true, ...(s.caller ?? {}) }),
    'receipt.findFirst': () => rcp,
    'glSettings.findUnique': () => s.gl,
    'cardPayment.findFirst': () => (s.card ? { id: 'cp-1' } : null),
    'repSettlement.findFirst': () => s.last ?? null,
    'receipt.aggregate': () => ({ _sum: { amount: s.sums?.collected ?? 0 } }),
    'invoice.aggregate': () => ({ _sum: { paidAmt: s.sums?.cash ?? 0 } }),
    'repSettlement.aggregate': () => ({ _sum: { amount: s.sums?.settled ?? 0 } }),
    'admin.findFirst': (a: Row) => {
      const id = a.where?.id as string;
      return s.admins && id in s.admins ? { id, name: s.admins[id] } : null;
    },
    'salesRep.findFirst': () => ({ canCancelReceipt: true }),
    'receipt.updateMany': () => { state.status = 'CANCELLED'; return { count: 1 }; },
    'receipt.findUniqueOrThrow': () => ({ ...state }),
    'receipt.update': (a: Row) => { Object.assign(state, a.data); return { ...state }; },
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
  custodyOf = { ...(s.custody ?? {}) };
}
const opts = async (s: CancelScene, user: User = ADMIN): Promise<Reply> => {
  reset(user);
  scriptCancel(s);
  return call('GET', '/api/receipts/r-7/cancel-options');
};
const cancel = async (s: CancelScene, body?: unknown, user: User = ADMIN): Promise<Reply> => {
  reset(user);
  scriptCancel(s);
  return call('PATCH', '/api/receipts/r-7/cancel', body);
};
/** E5.7: سند ٥٠٠ نقداً بمندوب، ثم استلامٌ ٥٠٠ بعده — المعلَّق صفر */
const HANDED = { last: { receivedByUserId: null, method: 'CASH' }, sums: { collected: 500, cash: 0, settled: 500 } };
const HANDED_TO_U = { last: { receivedByUserId: 'u-1', method: 'CASH' }, sums: { collected: 500, cash: 0, settled: 500 }, admins: { 'u-1': 'سارة' } };

test('C11 cancel-options (E5.7): غير مسلَّم ⇒ REP_CUSTODY؛ مسلَّم بلا مستخدم ⇒ MAIN_CASH؛ لمستخدمٍ تكفي عهدته ⇒ USER_CUSTODY؛ تحويلٌ ⇒ BANK', async () => {
  let r = await opts({ gl: glRow('LINKED') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, {
    linked: true, custodyClass: 'CUSTODY', handedOver: false, suggestedUserId: null, repOutstanding: null, suggested: 'REP_CUSTODY',
    options: [
      { value: 'REP_CUSTODY', label: 'من عهدة المندوب' }, { value: 'MAIN_CASH', label: 'من الصندوق الرئيسي' }, { value: 'BANK', label: 'من الحساب البنكي' },
    ],
  });
  assert.ok(!calls.includes('receipt.aggregate'), 'لا استلام بعد السند ⇒ لا تجميع');
  // الاستلام بعد تاريخ السند تحديداً
  assert.deepEqual(lastArg('repSettlement.findFirst').where, { tenantId: TID, salesRepId: 'rep-1', settledAt: { gte: RECEIPT_DATE } });

  r = await opts({ gl: glRow('LINKED'), ...HANDED });
  assert.deepEqual([r.body.data.handedOver, r.body.data.repOutstanding, r.body.data.suggested], [true, 0, 'MAIN_CASH']);

  r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 800 } });
  assert.deepEqual([r.body.data.suggested, r.body.data.suggestedUserId], ['USER_CUSTODY', 'u-1']);
  assert.deepEqual(r.body.data.options[1], { value: 'USER_CUSTODY', label: 'من عهدة مستخدم الشركة', userId: 'u-1', userName: 'سارة', userOutstanding: 800 });

  r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 300 } });
  assert.deepEqual([r.body.data.suggested, r.body.data.suggestedUserId], ['MAIN_CASH', null], 'عهدةٌ لا تكفي');
  assert.equal(r.body.data.options[1].userOutstanding, 300);

  r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, last: { receivedByUserId: 'u-1', method: 'BANK_TRANSFER' }, custody: { 'u-1': 900 } });
  assert.equal(r.body.data.suggested, 'BANK');

  // ما في يد المندوب يكفي (استلامٌ جزئيّ من سنداتٍ أخرى) ⇒ غير مسلَّم
  r = await opts({ gl: glRow('LINKED'), last: { receivedByUserId: null, method: 'CASH' }, sums: { collected: 1200, cash: 115, settled: 700 } });
  assert.deepEqual([r.body.data.handedOver, r.body.data.repOutstanding, r.body.data.suggested], [false, 615, 'REP_CUSTODY']);
});

test('C11 cancel-options: الإلكتروني بلا خيارات، والبطاقة والتحويل خارج العهدة في المربوطة (D4) ⇒ METHOD، والمندوب عهدته وحدها', async () => {
  let r = await opts({ gl: glRow('LINKED'), receipt: { paymentMethod: 'ONLINE' } });
  assert.deepEqual([r.body.data.custodyClass, r.body.data.suggested, r.body.data.options], ['ONLINE', null, []]);
  r = await opts({ gl: glRow('LINKED'), card: true });
  assert.deepEqual([r.body.data.custodyClass, r.body.data.suggested], ['OUTSIDE', 'METHOD']);
  r = await opts({ gl: glRow('LINKED'), receipt: { paymentMethod: 'BANK_TRANSFER' } });
  assert.deepEqual([r.body.data.custodyClass, r.body.data.suggested], ['OUTSIDE', 'METHOD'], 'D4 يغلب التوجيه المخزَّن');
  assert.deepEqual(r.body.data.options.map((o: Row) => o.value), ['METHOD', 'MAIN_CASH', 'BANK']);
  assert.ok(!calls.includes('cardPayment.findFirst'), 'البطاقة تُقرأ لمرشّح العهدة وحده');
  // غير المربوطة: التصنيف كالمُرحِّل القديم (التحويل الموجّه للعهدة عهدة)، و linked=false
  r = await opts({ gl: glRow('LEGACY', { receiptRouting: { BANK_TRANSFER: 'CUSTODY' } }), receipt: { paymentMethod: 'BANK_TRANSFER' } });
  assert.deepEqual([r.body.data.linked, r.body.data.custodyClass, r.body.data.suggested], [false, 'CUSTODY', 'REP_CUSTODY']);
  r = await opts({ gl: null });
  assert.deepEqual([r.body.data.linked, r.body.data.custodyClass, r.body.data.suggested], [false, 'OUTSIDE', 'METHOD']);
  // المندوب: سنده وحده، وعهدته وحدها بلا قراءةٍ لعهد غيره
  r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 800 } }, REP_USER);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.suggested, r.body.data.options.map((o: Row) => o.value)], ['REP_CUSTODY', ['REP_CUSTODY']]);
  assert.ok(!calls.includes('repSettlement.findFirst') && !calls.some(c => c.startsWith('userCustody')));
  r = await opts({ gl: glRow('LINKED'), receipt: { salesRepId: 'rep-2' } }, REP_USER);
  assert.equal(r.status, 404);
  r = await opts({ gl: glRow('LINKED'), receipt: { status: 'CANCELLED' } });
  assert.equal(r.status, 400);
});

/** موضع أوّل نداءٍ بعد موضع */
const at = (name: string, from = 0): number => calls.indexOf(name, from);

test('C11 PATCH cancel: غير المربوطة بلا جسم ⇒ لا كتابة ولا قفل (الإلغاء كما اليوم)، والزائد قراءة gl_settings وحدها', async () => {
  const runs: Array<{ calls: string[]; body: Row }> = [];
  for (const k of ['NONE', 'CLEAN', 'LINKED_UNACTIVATED', 'LEGACY'] as GlKey[]) {
    const r = await cancel({ gl: glRow(k) });
    assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.body)}`);
    assert.ok(!calls.includes('receipt.update'), `${k}: كتابة مصدر الردّ`);
    assert.ok(!calls.some(c => c.startsWith('lockCustody') || c.startsWith('userCustody')));
    runs.push({ calls: [...calls], body: r.body });
  }
  for (const x of runs.slice(1)) {
    assert.deepEqual(x.calls, runs[0].calls);
    assert.deepEqual(x.body, runs[0].body);
  }
  // تسلسل اليوم حرفاً + قراءة gl_settings واحدة قبل المعاملة
  const today = runs[0].calls.filter(c => c !== 'glSettings.findUnique');
  assert.deepEqual(today, ['admin.findUnique', 'admin.findUnique', 'receipt.findFirst', '$transaction', 'receipt.updateMany', 'receipt.findUniqueOrThrow',
    '$queryRaw', 'accountEntry.aggregate', 'accountEntry.create', 'customer.update', 'notification.create'], runs[0].calls.join(' → '));
  assert.equal(runs[0].calls.filter(c => c === 'glSettings.findUnique').length, 1);
  assert.ok(runs[0].calls.indexOf('glSettings.findUnique') < runs[0].calls.indexOf('$transaction'));
  assert.equal(runs[0].body.data.cancelRefundFrom, undefined, 'لا حقل مكتوب');
  assert.ok(at('receipt.updateMany') < at('accountEntry.create'));
});

test('C11 PATCH cancel: الحقل الصريح يُكتب لكل شركة (الاستثناء ج) — داخل المعاملة بعد المطالبة وقبل عكس القيود', async () => {
  for (const k of ['NONE', 'LINKED'] as GlKey[]) {
    const r = await cancel({ gl: glRow(k) }, { refundFrom: 'MAIN_CASH' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(lastArg('receipt.update'), { where: { id: 'r-7' }, data: { cancelRefundFrom: 'MAIN_CASH', cancelRefundUserId: null } });
    const claim = at('receipt.updateMany'), write = at('receipt.update'), reverse = at('accountEntry.create');
    assert.ok(at('$transaction') < claim && claim < write && write < reverse, calls.join(' → '));
    assert.equal(r.body.data.cancelRefundFrom, 'MAIN_CASH', 'الردّ يحمل ما كُتب');
  }
});

test('C11 PATCH cancel (المربوطة بلا جسم): المقترح يُكتب — REP_CUSTODY، وMAIN_CASH بعد التسليم (E5.7)، وUSER_CUSTODY بقفل عهدته قبل الكتابة', async () => {
  let r = await cancel({ gl: glRow('LINKED') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'REP_CUSTODY', cancelRefundUserId: null });

  r = await cancel({ gl: glRow('LINKED'), ...HANDED });
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'MAIN_CASH', cancelRefundUserId: null });

  r = await cancel({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 800 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u-1' });
  const lock = at('lockCustody:u-1'), check = calls.lastIndexOf('userCustody:u-1'), write = at('receipt.update');
  assert.ok(at('receipt.updateMany') < lock && lock < check && check < write && write < at('accountEntry.create'), calls.join(' → '));
  // والسند الإلكتروني: لا شيء ولو مربوطاً وبجسم (ولا قراءة)
  r = await cancel({ gl: glRow('LINKED'), receipt: { paymentMethod: 'ONLINE' } }, { refundFrom: 'MAIN_CASH' });
  assert.equal(r.status, 200);
  assert.ok(!calls.includes('receipt.update') && !calls.includes('glSettings.findUnique'));
});

test('C11 PATCH cancel: المندوب REP_CUSTODY دائماً، والرفض 400 برمزه — بلا مستخدم، مستخدمٌ غريب، عهدةٌ لا تكفي، مصدرٌ مجهول', async () => {
  let r = await cancel({ gl: glRow('LINKED') }, { refundFrom: 'MAIN_CASH' }, REP_USER);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'REP_CUSTODY', cancelRefundUserId: null });

  r = await cancel({ gl: glRow('LINKED') }, { refundFrom: 'USER_CUSTODY' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'RECEIPT_CANCEL_REFUND_USER');
  assert.ok(!calls.includes('$transaction'), 'الرفض قبل المعاملة');

  r = await cancel({ gl: null, admins: {} }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u-x' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { success: false, code: 'RECEIPT_CANCEL_REFUND_USER', message: 'المستخدم المختار ليس من مستخدمي الشركة' });
  assert.deepEqual(lastArg('admin.findFirst').where, { id: 'u-x', tenantId: TID }, 'المستخدم من الشركة نفسها');
  assert.ok(!calls.includes('$transaction'));

  r = await cancel({ gl: null, admins: { 'u-1': 'سارة' }, custody: { 'u-1': 300 } }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u-1' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'RECEIPT_CANCEL_REFUND_USER');
  assert.match(r.body.message, /\(300\)/);
  assert.ok(!calls.includes('receipt.update') && !calls.includes('accountEntry.create'), 'لا كتابة ولا قيد قبل الرفض');

  r = await cancel({ gl: null, admins: { 'u-1': 'سارة' }, custody: { 'u-1': 500 } }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u-1' });
  assert.equal(r.status, 200, 'العهدة تساوي المبلغ تكفي');
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u-1' });

  r = await cancel({ gl: glRow('LINKED') }, { refundFrom: 'SAFE' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'RECEIPT_CANCEL_REFUND_INVALID');
});

test('C11 حارس عهدة المستخدم (مراجعة ١٤ نوفمبر): المقيّد ومن بلا صلاحية العهدة لا يرى عهدة غيره ولا رصيد المندوب، ولا يُسند الردّ إلا لنفسه أو للمقترح', async () => {
  const SCOPED = { scopeEnabled: true, scopeMode: 'LISTS' };
  // المقيّد بنطاق: القرار نفسه (USER_CUSTODY لآخر مستلِم)، بلا عهدته ولا رصيد المندوب
  let r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 800 }, caller: SCOPED });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.handedOver, r.body.data.repOutstanding, r.body.data.suggested, r.body.data.suggestedUserId], [true, null, 'USER_CUSTODY', 'u-1']);
  assert.deepEqual(r.body.data.options[1], { value: 'USER_CUSTODY', label: 'من عهدة مستخدم الشركة', userId: 'u-1', userName: 'سارة' });
  // عهدةٌ لا تكفي ⇒ لا مقترح لها ⇒ لا خيار لغير صاحب الصلاحية (ولا رقمها)
  r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 300 }, caller: SCOPED });
  assert.deepEqual(r.body.data.options.map((o: Row) => o.value), ['REP_CUSTODY', 'MAIN_CASH', 'BANK']);
  // غير مقيّد بلا إدارة المستخدمين: رصيد المندوب نعم، وعهدة غيره لا
  r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 800 }, caller: { canManageCompanyUsers: false } });
  assert.equal(r.body.data.repOutstanding, 0);
  assert.equal('userOutstanding' in r.body.data.options[1], false);
  // صاحب العهدة نفسه يرى عهدته
  r = await opts({ gl: glRow('LINKED'), ...HANDED_TO_U, last: { receivedByUserId: 'admin-1', method: 'CASH' }, admins: { 'admin-1': 'المدير' }, custody: { 'admin-1': 900 }, caller: SCOPED });
  assert.equal(r.body.data.options[1].userOutstanding, 900);

  // الكتابة: إسنادٌ إلى غير المقترح بلا صلاحية ⇒ 403 قبل المعاملة وقبل كشف وجود المستخدم
  for (const caller of [SCOPED, { canReceiveUserCollections: false }, { canManageCompanyUsers: false }, { isActive: false }]) {
    r = await cancel({ gl: glRow('LINKED'), ...HANDED_TO_U, admins: { 'u-1': 'سارة', 'u-2': 'المدير المالي' }, custody: { 'u-1': 800, 'u-2': 5000 }, caller }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u-2' });
    assert.equal(r.status, 403, `${JSON.stringify(caller)}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'RECEIPT_CANCEL_REFUND_USER_FORBIDDEN');
    assert.ok(!calls.includes('$transaction') && !calls.includes('receipt.update') && !calls.includes('userCustody:u-2'), calls.join(' → '));
    r = await cancel({ gl: null, admins: {}, caller }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u-x' });
    assert.equal(r.status, 403, 'مستخدمٌ غريب: الرفض نفسه لا «ليس من مستخدمي الشركة»');
  }
  // والمقترح نفسه (آخر مستلِم تكفي عهدته) مقبولٌ من أيٍّ كان — هو ما يكتبه المقترح بلا جسم
  r = await cancel({ gl: glRow('LINKED'), ...HANDED_TO_U, custody: { 'u-1': 800 }, caller: SCOPED }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u-1' });
  // ومن عهدته هو (غير المربوطة أيضاً — الاستثناء ج) بعهدةٍ تكفي
  r = await cancel({ gl: null, admins: { 'admin-1': 'المدير' }, custody: { 'admin-1': 500 }, caller: SCOPED }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'admin-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'admin-1' });
  // وصاحب الصلاحية غير المقيّد يُسند إلى أي مستخدمٍ تكفي عهدته (السلوك السابق)
  r = await cancel({ gl: glRow('LINKED'), ...HANDED_TO_U, admins: { 'u-1': 'سارة', 'u-2': 'المدير المالي' }, custody: { 'u-1': 800, 'u-2': 5000 } }, { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u-2' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lastArg('receipt.update').data, { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u-2' });
});
