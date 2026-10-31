// ZATCA المرحلة الثانية (Z5.5) — الإشعارات الدائنة والمدينة عبر الموجّه الحقيقي: POST /:id/credit-note وdebit-note
// وGET /:id/creditable ومرتجع POST /invoices بعد الربط.
//
// لا قاعدة بيانات ولا شبكة: عميل Prisma مزيّف، ومخزن مستندات في الذاكرة، ومنصّة «فاتورة» مزيّفة. وما يُثبَت هنا هو
// ما يقع فعلاً حين يُرجع العميلُ بضاعة أو يُلغى بيعٌ بعد أن استلمت الهيئة فاتورته:
//   ١) المرتجع صار **إشعاراً دائناً** يشير إلى فاتورته (BT-25) ويمرّ باعتماد الهيئة قبل تسليمه (01) — 201 أو 202.
//   ٢) متبقّي الأصل يُنقص **فرقاً نسبياً** بقدر الإشعار ولا ينزل تحت الصفر، وروابط الدفع القديمة تُمات (نقد 13).
//   ٣) الكميّات محروسة: لا يُرجَع أكثر ممّا بيع ناقصَ ما أُرجع قبله — ولا إشعار على إشعار ولا على فاتورة لم تُعتمد.
//   ٤) الصلاحيات (Q5): الكامل بديل الإلغاء فيلزمه إذن الإلغاء، والجزئيّ إذن الفاتورة، والمدين للإدارة وحدها.
//   ٥) رفض الهيئة للإشعار يُبطله **ويردّ متبقّي الأصل** — وإلّا سقط الدَّين بإشعارٍ لم تقبله الهيئة أصلاً.
//   ٦) المرحلة الأولى كما هي حرفاً بحرف: المرتجع مستندٌ عاديّ، والمسارات الجديدة مغلقة.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

// ═══ حقن البدائل قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let calls: string[] = [];
let scripted: Record<string, (args: unknown) => unknown> = {};

function defaultFor(method: string): unknown {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'aggregate') return { _sum: { debit: 0, credit: 0 } };
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}

const modelProxy = (model: string): unknown => new Proxy({}, {
  get: (_t, method: string) => async (args: unknown) => {
    calls.push(`${model}.${method}`);
    const fn = scripted[`${model}.${method}`];
    return fn ? fn(args) : defaultFor(method);
  },
});

const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown) => {
        calls.push('$transaction');
        return typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : arg;
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async () => { calls.push(key); return key === '$queryRaw' ? [] : 0; };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

let currentUser: { id: string; role: string; tenantId: string } = { id: 'admin-1', role: 'ADMIN', tenantId: 'tenant-z5' };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass,
  requireAccounting: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});

let phase2Deps: unknown = null;
stub('routes/invoicesZatcaDeps', {
  productionPhase2Deps: () => {
    if (!phase2Deps) throw new Error('اعتماديات المرحلة الثانية غير مهيّأة لهذا الاختبار');
    return phase2Deps;
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesRouter = require('../routes/invoices').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { voidInvoiceInTx } = require('../services/invoiceVoid') as typeof import('../services/invoiceVoid');

import { createSubmitHarness, type SubmitHarness } from '../compliance/zatca/__fixtures__/z5-submit';
import { FAKE_REPLIES } from '../compliance/zatca/__fixtures__/z5-fakezatca';
import { CUSTOMERS, PRODUCTS, REQ_SIMPLIFIED_Z1, Z5_TENANT, Z5_UNIT } from '../compliance/zatca/__fixtures__/z5-sources';
import { REQ_STANDARD_NO_HEAD_DISCOUNT, originalInvoice } from '../compliance/zatca/__fixtures__/z5-notes';
import type { NoteOriginalInvoice } from '../compliance/zatca/notes';
import { submitDocument } from '../compliance/zatca/submit';
import type { NoteIssuanceDeps } from '../routes/invoicesNotes';
import type { Phase2Tx } from '../routes/invoicesZatca';

const LIVE_AT = new Date('2026-11-20T06:00:00.000Z');
const CAPS = { 'X-FS-Caps': 'zatca2' };

// ═══ الخادم ═══

interface Server { port: number; close: () => Promise<void> }
let server: Server | null = null;

async function startServer(): Promise<Server> {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesRouter);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ success: false, message: err.message });
  });
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => s.close(() => r())) };
  return server;
}

after(async () => { await server?.close(); server = null; });

interface Reply { status: number; body: Record<string, unknown> }

async function call(method: 'POST' | 'GET' | 'PATCH', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const s = await startServer();
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...(o.headers ?? {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ═══ العُدّة ═══

const PRODUCT_ROWS = PRODUCTS.map(p => ({
  id: p.id, name: p.name, unit: 'حبة', basePrice: 1000, taxPct: null, damagedReturnToStock: true, priceTiers: [],
  vatCategory: p.vatCategory ?? null, vatExemptionCode: p.vatExemptionCode ?? null, vatExemptionReason: p.vatExemptionReason ?? null,
}));

const CUSTOMER_ROW = (base: Record<string, unknown>) => ({
  ...base, status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: Z5_TENANT, phone: '0500000000',
});

/** صفّ قاعدة البيانات لفاتورةٍ أصلية كما يقرؤه محمّل الإشعار (بند مع بطاقة صنفه). */
function dbRow(o: NoteOriginalInvoice): Record<string, unknown> {
  return {
    id: o.id, tenantId: o.tenantId, customerId: o.customerId, salesRepId: o.salesRepId, number: o.number, status: o.status,
    type: o.type, paymentPlan: o.paymentPlan, zatcaPhase: o.zatcaPhase, documentKind: o.documentKind,
    invoiceSubtype: o.invoiceSubtype, einvoiceStatus: o.einvoiceStatus, pricesIncludeTax: o.pricesIncludeTax,
    discountPct: o.discountPct, total: o.total, paidAmt: o.paidAmt, remainingAmt: o.remainingAmt, einvoiceSnapshot: null,
    // الصنف كما يقرؤه المحمّل: اسمه ووحدة أساسه ووحداته (الوحدات المتعددة)
    items: o.items.map(i => ({
      ...i, product: { name: i.itemName, unit: i.baseUnitName ?? 'حبة', damagedReturnToStock: i.damagedReturnToStock, units: i.units ?? [] },
    })),
  };
}

interface Rig {
  h: SubmitHarness;
  rows: Map<string, Record<string, unknown>>;
  priorNotes: Record<string, unknown>[];
  /** مرتجعات ما قبل الربط (صفوف RETURN قديمة بلا رابط) — تُقرأ لأصلٍ من المرحلة الأولى وحده. */
  legacyReturns: { items: { productId: string | null; qty: number }[] }[];
  ledger: { kind: string; invoiceId: string; total: number }[];
  expired: string[];
  notifications: Record<string, unknown>[];
  published: string[];
  created: Record<string, unknown>[];
}

const num = (v: unknown): number => Number(v ?? 0);

/** مقبض المعاملة: جدول فواتير في الذاكرة بلا `$queryRaw` (فيتخطّى القفل كما في بقيّة اختبارات المسار). */
function txAdapter(rig: Rig): Record<string, unknown> {
  const invoice = {
    findFirst: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
    findMany: async ({ where }: { where: { originalInvoiceId?: string | null; documentKind?: unknown } }) =>
      (where && 'documentKind' in where && where.documentKind === null
        ? rig.legacyReturns as unknown as Record<string, unknown>[]
        : rig.priorNotes.filter(n => !where?.originalInvoiceId || n.originalInvoiceId === where.originalInvoiceId)),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const id = `note-${rig.created.length + 1}`;
      const nested = data.items as { create?: Record<string, unknown>[] } | undefined;
      const row: Record<string, unknown> = { ...data, id, status: 'CONFIRMED', items: nested?.create ?? [], customer: null };
      rig.rows.set(id, row);
      rig.created.push(row);
      // إشعارٌ التزم يصير «إشعاراً سابقاً» يُنقص المتاح (كما تقرؤه القاعدة في الطلب التالي)
      if (data.documentKind === 'CREDIT_NOTE') {
        rig.priorNotes.push({
          id, status: 'CONFIRMED', documentKind: 'CREDIT_NOTE', total: num(data.total), originalInvoiceId: data.originalInvoiceId,
          // بلقطة الوحدة وما قُيِّد من البند كما يقرؤها loadPriorNotes من القاعدة (حبّةٌ من كرتون تُنقص حبّة)
          items: (nested?.create ?? []).map(i => ({
            creditedItemId: i.creditedItemId, qty: num(i.qty), unitFactor: i.unitFactor ?? null, baseQty: i.baseQty ?? null, lineTotal: i.lineTotal ?? null,
          })),
        });
      }
      rig.h.docs.invoices.set(id, {
        id, tenantId: String(data.tenantId), zatcaPhase: 2, einvoiceStatus: (data.einvoiceStatus as string) ?? null,
        einvoiceQr: (data.einvoiceQr as string) ?? null, einvoiceWarnings: null, einvoiceSubmittedAt: null,
      });
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rig.rows.get(where.id);
      if (!row) return null;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'decrement' in (v as Record<string, unknown>)) {
          row[k] = Math.round((num(row[k]) - num((v as { decrement: number }).decrement)) * 100) / 100;
        } else if (v && typeof v === 'object' && 'increment' in (v as Record<string, unknown>)) {
          row[k] = Math.round((num(row[k]) + num((v as { increment: number }).increment)) * 100) / 100;
        } else row[k] = v;
      }
      return row;
    },
  };
  return {
    invoice,
    notification: { create: async ({ data }: { data: Record<string, unknown> }) => { rig.notifications.push(data); return { id: 'n' }; } },
    customer: { update: async () => ({}) },
    accountEntry: { create: async () => ({}), aggregate: async () => ({ _sum: { debit: 0, credit: 0 } }) },
  };
}

function buildRig(opts: Parameters<typeof createSubmitHarness>[0] = {}): Rig {
  const h = createSubmitHarness(opts);
  const rig: Rig = { h, rows: new Map(), priorNotes: [], legacyReturns: [], ledger: [], expired: [], notifications: [], published: [], created: [] };

  // نقد 7: الإبطال الحقيقيّ داخل معاملة كتابة النتيجة نفسها (ومنه ردّ متبقّي الأصل — Z5.5)
  (h.deps as { onRejectedInTx?: unknown }).onRejectedInTx = async (_tx: unknown, info: {
    tenantId: string; invoiceId: string; documentId: string; subtype: '01' | '02'; errors: { code: string | null; message: string | null }[]; at: Date;
  }) => {
    await voidInvoiceInTx(txAdapter(rig) as never, {
      tenantId: info.tenantId, invoiceId: info.invoiceId, subtype: info.subtype, reason: 'REJECTED',
      documentId: info.documentId, errors: info.errors, at: info.at,
    });
  };

  const deps: NoteIssuanceDeps = {
    db: prismaFake as unknown as NoteIssuanceDeps['db'],
    units: h.units,
    documents: {
      insertSigned: (_tx, doc) => h.docs.insertSigned(null, doc),
      advanceUnitChain: (_tx, a) => h.docs.advanceUnitChain(null, a),
      loadProjection: (tenantId, invoiceId) => h.docs.loadProjection(tenantId, invoiceId),
    },
    chain: {
      lockChainHead: (_tx, unitId) => h.chain.lockChainHead(null, unitId),
      nextNumberInTx: async (_tx, _tenantId, prefix) => `${prefix}${String(rig.created.length + 1).padStart(6, '0')}`,
    },
    keyring: () => h.keyring,
    ledger: {
      postCashInvoice: async (_tx, _t, invoiceId, _c, total) => { rig.ledger.push({ kind: 'CASH', invoiceId, total }); },
      postCreditInvoice: async (_tx, _t, invoiceId, _c, total) => { rig.ledger.push({ kind: 'CREDIT', invoiceId, total }); },
      creditLimitNotice: async () => { /* لا حدّ ائتمانيّ هنا */ },
      postReturn: async (_tx, _t, invoiceId, _c, total) => { rig.ledger.push({ kind: 'RETURN', invoiceId, total }); },
      postDebitNote: async (_tx, _t, invoiceId, _c, total) => { rig.ledger.push({ kind: 'DEBIT', invoiceId, total }); },
    },
    transaction: <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => fn(txAdapter(rig) as unknown as Phase2Tx),
    publish: tid => { rig.published.push(tid); },
    expireLinks: (_tid, invoiceId) => { rig.expired.push(invoiceId); },
    now: () => h.clock.now(),
    env: {} as NodeJS.ProcessEnv,
    mutex: null,
    submitInline: (ref, o) => submitDocument(h.deps, ref, { inline: true, timeoutMs: o.timeoutMs }),
  };
  phase2Deps = deps;
  return rig;
}

interface ScriptOptions {
  original?: NoteOriginalInvoice | null;
  customer?: Record<string, unknown>;
  startedAt?: Date | null;
  replay?: Record<string, unknown> | null;
  rep?: Record<string, unknown> | null;
}

/** يُجهّز ردود القاعدة المزيّفة ويضع الأصل في جدول المعاملة. */
function script(rig: Rig, o: ScriptOptions = {}): NoteOriginalInvoice | null {
  const original = o.original === undefined ? originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, subtype: '01', einvoiceStatus: 'cleared' }) : o.original;
  if (original) rig.rows.set(original.id, dbRow(original));
  // صفّ إعدادات البائع في المخزن هو ما يقرؤه النظام الضريبي فعلاً (كما في الإنتاج: الصفّ نفسه)
  const seller = rig.h.units.settings.get(Z5_TENANT);
  if (seller) rig.h.units.settings.set(Z5_TENANT, { ...seller, zatcaPhase2StartedAt: o.startedAt === undefined ? LIVE_AT : o.startedAt });
  calls = [];
  scripted = {
    'invoice.findFirst': () => (original ? rig.rows.get(original.id) ?? null : null),
    'invoice.findUnique': () => o.replay ?? null,
    'invoice.findMany': (args: unknown) => {
      const w = (args as { where?: Record<string, unknown> }).where ?? {};
      return 'documentKind' in w && w.documentKind === null ? rig.legacyReturns : rig.priorNotes;
    },
    'customer.findFirst': () => o.customer ?? CUSTOMER_ROW(CUSTOMERS.b2bComplete as unknown as Record<string, unknown>),
    'salesRep.findFirst': () => o.rep ?? { id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true, canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, maxDiscountPct: 100 },
    'product.findMany': (args: unknown) => {
      const ids: string[] = (args as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? [];
      return PRODUCT_ROWS.filter(p => ids.includes(p.id));
    },
    'companySettings.findUnique': () => ({ defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: o.startedAt === undefined ? LIVE_AT : o.startedAt }),
    'zatcaEgsUnit.findMany': (args: unknown) => {
      const env = (args as { where?: { environment?: string } }).where?.environment;
      const u = rig.h.units.units.get(rig.h.unitId);
      return env === 'production'
        ? [{ id: rig.h.unitId, tenantId: Z5_TENANT, environment: u?.environment, status: u?.status, keyVersion: u?.keyVersion, vatNumber: u?.vatNumber, certNotAfter: new Date('2031-01-01T00:00:00Z'), lastIcv: 0, lastInvoiceHash: null }]
        : [];
    },
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, invoiceSignatureEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.create': (args: unknown) => ({ id: 'legacy-1', ...((args as { data?: Record<string, unknown> }).data ?? {}) }),
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
  return original;
}

const noteOf = (r: Reply): Record<string, unknown> => (r.body.data ?? {}) as Record<string, unknown>;
const einvoiceOf = (r: Reply): Record<string, unknown> => (noteOf(r).einvoice ?? {}) as Record<string, unknown>;

const creditBody = (over: Record<string, unknown> = {}) => ({
  reason: 'إرجاع بضاعة من العميل',
  lines: [{ invoiceItemId: 'it-1', qty: 2 }],
  clientRef: crypto.randomUUID(),
  ...over,
});

// ═══ (١) الإشعار الدائن الجزئيّ على فاتورة معتمدة ═══

test('إشعار دائن جزئيّ على قياسية معتمدة: 201 مستند 381 معتمد، ومتبقّي الأصل ينقص بقدره فرقاً نسبياً', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const before = num(rig.rows.get(original.id)!.remainingAmt);
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody(), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = einvoiceOf(r);
  assert.equal(e.typeCode, '381', 'المستند ليس إشعاراً دائناً');
  assert.equal(e.subtype, '01', 'النوع الفرعي لم يُورَث من الأصل');
  assert.equal(e.status, 'cleared');
  assert.equal(e.printable, true, 'إشعار معتمد غير قابل للطباعة');
  assert.equal(e.documentKind, 'CREDIT_NOTE');

  const note = noteOf(r);
  assert.equal(note.type, 'RETURN', 'صفّ الإشعار ليس مرتجعاً — مخزون السيارة والتقارير لن تقرأه');
  assert.equal(note.originalInvoiceId, original.id);
  assert.equal(note.billingReference, original.number, 'BT-25 لا يحمل رقم الأصل');
  assert.equal(note.noteReason, 'إرجاع بضاعة من العميل');
  assert.equal(note.zatcaPhase, 2);
  assert.equal(num(note.paidAmt), 0);
  assert.equal(num(note.remainingAmt), 0, 'صفّ الإشعار يحمل مديونية');
  assert.ok(String(note.number).startsWith('RET-'), `رقم الإشعار بلا بادئة مرتجع: ${String(note.number)}`);
  const items = note.items as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0].creditedItemId, 'it-1', 'البند غير مربوط ببند الأصل');
  assert.equal(num(items[0].qty), 2);
  assert.equal(items[0].productId, 'p-rice');

  // F1: النقص فرقٌ نسبيّ بقدر الإشعار (نقد 13)
  const after = num(rig.rows.get(original.id)!.remainingAmt);
  assert.equal(Math.round((before - after) * 100) / 100, num(note.total), 'متبقّي الأصل لم ينقص بقدر الإشعار');
  assert.deepEqual(rig.ledger.map(l => l.kind), ['RETURN'], 'قيود الإشعار ليست قيود مرتجع');
  assert.deepEqual(rig.expired, [original.id], 'روابط الدفع على الأصل لم تُمَت (نقد 13)');
  assert.equal(rig.h.fake.violations.length, 0, `مخالفات ترويسة: ${rig.h.fake.violations.join(', ')}`);
});

test('الإشعار الكامل (بديل الإلغاء): كل المتاح، ومتبقّي الأصل صفر ولا ينزل تحته', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: 'FULL' }), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const note = noteOf(r);
  assert.equal((note.items as unknown[]).length, original.items.length, 'الإشعار الكامل لا يشمل كل البنود');
  assert.equal(Math.round(num(note.total) * 100) / 100, Math.round(original.total * 100) / 100, 'الإشعار الكامل ≠ قيمة الأصل');
  assert.equal(num(rig.rows.get(original.id)!.remainingAmt), 0, 'متبقّي الأصل لم يُطفأ');
  assert.equal(num((r.body.data as { original: { remainingAmt: number } }).original.remainingAmt), 0);
});

test('الفاتورة النقدية: الإشعار كلّه رصيد دائن للعميل ولا يُنقص متبقّياً أصلاً صفراً', async () => {
  const rig = buildRig();
  const cash = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', einvoiceStatus: 'reported', customerId: 'c-walkin' });
  script(rig, { original: cash, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>) });
  const r = await call('POST', `/api/invoices/${cash.id}/credit-note`, { body: creditBody({ lines: 'FULL' }), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const data = r.body.data as { original: { remainingAmt: number; customerCredit: number } };
  assert.equal(data.original.remainingAmt, 0);
  assert.equal(Math.round(data.original.customerCredit * 100) / 100, Math.round(cash.total * 100) / 100, 'المحصَّل لم يتحوّل رصيداً دائناً');
  // المبسّطة تُبلَّغ خلال ٢٤ ساعة ولا تنتظر اعتماداً في الطلب الحيّ
  assert.equal(einvoiceOf(r).subtype, '02');
  assert.equal(einvoiceOf(r).documentStatus, 'SIGNED', 'المبسّطة انتظرت الهيئة في الطلب الحيّ');
  assert.equal(rig.h.fake.calls.length, 0, 'نداء للهيئة في إصدار إشعار مبسّط');
});

// ═══ (٢) الحرّاس ═══

test('الكمية المرتجعة تتجاوز المتاح ⇒ 422 ولا مستند ولا قيد', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 99 }] }), headers: CAPS });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CREDIT_QTY_EXCEEDED');
  assert.equal(rig.created.length, 0, 'أُنشئ إشعار رغم الرفض');
  assert.equal(rig.h.docs.documents.size, 0, 'استُهلك ICV رغم الرفض');
  assert.equal(rig.ledger.length, 0);
});

test('إشعار سابق يُنقص المتاح: الثاني على الكمية نفسها ⇒ 422 بالمتاح الصحيح', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  rig.priorNotes = [{
    id: 'note-prev', status: 'CONFIRMED', documentKind: 'CREDIT_NOTE', total: 100, originalInvoiceId: original.id,
    items: [{ creditedItemId: 'it-1', qty: 9 }],
  }];
  const ok = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const over = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 2 }] }), headers: CAPS });
  assert.equal(over.status, 422);
  assert.equal(over.body.code, 'ZATCA_CREDIT_QTY_EXCEEDED');
  // الرسالة تسمّي الصنف والمتاح منه (صفر بعد استيفائه) — لا رقم مجرّد بلا معنى
  assert.match(String(over.body.message), /أرز/, 'الرسالة لا تسمّي الصنف');
  assert.match(String(over.body.message), /\(0\)/, 'الرسالة لا تذكر المتاح');
});

test('لا إشعار على إشعار ⇒ 409، ولا على فاتورة لم تعتمدها الهيئة ⇒ 409', async () => {
  const rig = buildRig();
  const note = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, documentKind: 'CREDIT_NOTE', type: 'RETURN' });
  script(rig, { original: note });
  const onNote = await call('POST', `/api/invoices/${note.id}/credit-note`, { body: creditBody(), headers: CAPS });
  assert.equal(onNote.status, 409);
  assert.equal(onNote.body.code, 'ZATCA_NOTE_ON_NOTE');

  const rig2 = buildRig();
  const pending = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, subtype: '01', einvoiceStatus: 'clearance_pending' });
  script(rig2, { original: pending });
  const onPending = await call('POST', `/api/invoices/${pending.id}/credit-note`, { body: creditBody(), headers: CAPS });
  assert.equal(onPending.status, 409);
  assert.equal(onPending.body.code, 'ZATCA_ORIGINAL_NOT_CLEARED');
  assert.equal(rig2.created.length, 0);
});

test('فاتورة أُبطلت (رفضتها الهيئة) ⇒ 409 يشرح الرصيد الدائن (D4/Q1)', async () => {
  const rig = buildRig();
  const voided = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, subtype: '01', einvoiceStatus: 'rejected', status: 'CANCELLED' });
  script(rig, { original: voided });
  const r = await call('POST', `/api/invoices/${voided.id}/credit-note`, { body: creditBody(), headers: CAPS });
  assert.equal(r.status, 409);
  assert.match(String(r.body.message), /رصيداً دائناً/, 'الرسالة لا تشرح سبب المنع');
});

test('حزمة بلا قدرات ⇒ 426 قبل أيّ عمل', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody() });
  assert.equal(r.status, 426);
  assert.equal(r.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
  assert.equal(rig.created.length, 0);
});

// ═══ (٣) الصلاحيات (Q5) ═══

test('Q5: المندوب بلا «إلغاء الفاتورة» يُمنع من الإشعار الكامل ويُسمح له بالجزئيّ', async () => {
  const rig = buildRig();
  const original = script(rig, {
    rep: { id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canCancelInvoice: false },
  })!;
  currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: Z5_TENANT };
  try {
    const full = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: 'FULL' }), headers: CAPS });
    assert.equal(full.status, 403, JSON.stringify(full.body));
    assert.match(String(full.body.message), /إلغاء/);
    assert.equal(rig.created.length, 0);
    const partial = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody(), headers: CAPS });
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.equal(rig.created[0].salesRepId, 'rep-1', 'الإشعار لم يُنسب للمندوب المُصدِر');
  } finally {
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };
  }
});

test('Q5: المندوب بلا «إنشاء فاتورة» يُمنع من الجزئيّ، والمدين ممنوع على المندوب مطلقاً', async () => {
  const rig = buildRig();
  const original = script(rig, { rep: { id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: false, canCancelInvoice: true } })!;
  currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: Z5_TENANT };
  try {
    const partial = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody(), headers: CAPS });
    assert.equal(partial.status, 403);
    const debit = await call('POST', `/api/invoices/${original.id}/debit-note`, {
      body: { reason: 'فرق سعر', lines: [{ description: 'فرق سعر', qty: 1, unitPrice: 10, taxPct: 15 }] }, headers: CAPS,
    });
    assert.equal(debit.status, 403);
    assert.match(String(debit.body.message), /إدارة الشركة/);
  } finally {
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };
  }
});

// ═══ (٤) الإشعار المدين ═══

test('إشعار مدين للإدارة: 383 بصفّ آجل بلا أصناف (لا يمسّ مخزون السيارة) ومديونيته على نفسه', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const beforeRemaining = num(rig.rows.get(original.id)!.remainingAmt);
  const r = await call('POST', `/api/invoices/${original.id}/debit-note`, {
    body: { reason: 'فرق سعر على الفاتورة', lines: [{ description: 'فرق سعر أرز', qty: 1, unitPrice: 100, taxPct: 15 }], clientRef: crypto.randomUUID() },
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(einvoiceOf(r).typeCode, '383');
  const note = noteOf(r);
  assert.equal(note.type, 'CREDIT', 'الإشعار المدين ليس صفّاً آجلاً');
  assert.equal(num(note.remainingAmt), num(note.total), 'مديونية الإشعار المدين ليست عليه');
  assert.equal(note.salesRepId, original.salesRepId, 'المدين لم يُنسب لمندوب الأصل');
  const items = note.items as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0].productId, null, 'بند الإشعار المدين يحمل صنفاً — يخصم من مخزون السيارة');
  assert.equal(items[0].creditedItemId, null);
  assert.equal(items[0].itemName, 'فرق سعر أرز');
  assert.deepEqual(rig.ledger.map(l => l.kind), ['DEBIT'], 'قيود المدين ليست قيود فاتورة');
  assert.equal(num(rig.rows.get(original.id)!.remainingAmt), beforeRemaining, 'المدين غيّر متبقّي الأصل');
  assert.deepEqual(rig.expired, [], 'المدين أمات روابط دفع الأصل');
});

// ═══ (٥) رفض الهيئة للإشعار ═══

test('رفضت الهيئة الإشعار القياسيّ ⇒ 422، الإشعار مُبطل ومتبقّي الأصل عاد كما كان', async () => {
  const rig = buildRig({ fake: { onClear: () => FAKE_REPLIES.reject400('BR-KSA-17', 'سبب الإشعار مفقود') } });
  const original = script(rig)!;
  const before = num(rig.rows.get(original.id)!.remainingAmt);
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody(), headers: CAPS });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_REJECTED');
  const noteRow = rig.rows.get('note-1')!;
  assert.equal(noteRow.status, 'CANCELLED', 'إشعارٌ رفضته الهيئة بقي معتمداً');
  assert.equal(num(rig.rows.get(original.id)!.remainingAmt), before, 'متبقّي الأصل لم يعد بعد إبطال الإشعار');
  // والردّ يقول ذلك أيضاً: حقل الأصل في جسم الـ422 من قبل الإشعار لا من بعده (وإلّا عرضت الشاشة متبقّياً كاذباً)
  const rejected = (r.body.data ?? {}) as { status?: string; original?: Record<string, unknown> };
  assert.equal(rejected.status, 'CANCELLED');
  assert.equal(num(rejected.original?.remainingAmt), before, 'جسم الرفض يحمل متبقّياً عاد إلى ما كان');
  assert.equal(num(rejected.original?.creditedTotal), 0, 'جسم الرفض يعدّ إشعاراً مرفوضاً ضمن المُرجع');
  assert.equal(num(rejected.original?.customerCredit), 0);
});

test('Q5 بالأثر: مندوبٌ بلا «إلغاء الفاتورة» لا يتجاوزه بتعداد كل البنود بكامل كمّياتها', async () => {
  const rig = buildRig();
  const original = script(rig, { rep: { id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canCancelInvoice: false } })!;
  currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: Z5_TENANT };
  try {
    const all = original.items.map(i => ({ invoiceItemId: i.id, qty: i.qty }));
    const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: all }), headers: CAPS });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'ZATCA_NOTE_NOT_ALLOWED');
    assert.match(String(r.body.message), /إلغاء/);
    assert.equal(rig.created.length, 0, 'استُهلك ICV قبل فحص الصلاحية');
    assert.equal(rig.h.docs.documents.size, 0);
    // وبندٌ واحد يبقى جزئياً فيمرّ
    const partial = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody(), headers: CAPS });
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
  } finally {
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };
  }
});

test('رفعٌ مؤجَّل للإشعار بلا مفتاح منع تكرار ⇒ 426، ومعه ⇒ يمرّ', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const { clientRef: _drop, ...noKey } = creditBody();
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, {
    body: { ...noKey, clientCreatedAt: '2026-11-20T05:30:00.000Z' }, headers: CAPS,
  });
  assert.equal(r.status, 426, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
  assert.equal(rig.created.length, 0, 'أُنشئ إشعار من رفعٍ مؤجَّل بلا مفتاح');
  const ok = await call('POST', `/api/invoices/${original.id}/credit-note`, {
    body: { ...creditBody(), clientCreatedAt: '2026-11-20T05:30:00.000Z' }, headers: CAPS,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ═══ (٦) منع التكرار (clientRef) ═══

test('رفعٌ مكرَّر بنفس clientRef ⇒ الإشعار القائم بلا مستند ثانٍ', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const body = creditBody();
  const first = await call('POST', `/api/invoices/${original.id}/credit-note`, { body, headers: CAPS });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const docs = rig.h.docs.documents.size;
  // الرفع الثاني يجد الصفّ بمفتاحه
  scripted['invoice.findUnique'] = () => ({ ...rig.rows.get('note-1'), items: [], customer: null });
  const again = await call('POST', `/api/invoices/${original.id}/credit-note`, { body, headers: CAPS });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.idempotent, true);
  assert.equal(rig.h.docs.documents.size, docs, 'أُصدر مستند ثانٍ لنفس المفتاح');
  assert.equal(rig.created.length, 1);
});

// ═══ (٧) المعاينة والإلغاء ═══

test('GET /:id/creditable: المتاح لكل بند بعد إشعار سابق، وصلاحيات الطالب', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  rig.priorNotes = [{
    id: 'note-prev', status: 'CONFIRMED', documentKind: 'CREDIT_NOTE', total: 100, originalInvoiceId: original.id,
    items: [{ creditedItemId: 'it-1', qty: 4 }],
  }];
  const r = await call('GET', `/api/invoices/${original.id}/creditable`, { headers: CAPS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const data = r.body.data as { eligible: boolean; lines: Record<string, unknown>[]; permissions: Record<string, boolean>; creditedTotal: number };
  assert.equal(data.eligible, true);
  const first = data.lines.find(l => l.invoiceItemId === 'it-1')!;
  assert.equal(num(first.qty), 10);
  assert.equal(num(first.credited), 4);
  assert.equal(num(first.returnable), 6);
  assert.equal(data.creditedTotal, 100);
  assert.equal(data.permissions.full, true);
  assert.equal(data.permissions.debit, true);
});

test('إلغاء فاتورة مرتبطة ⇒ 409 يحمل ما يمكن إرجاعه (بديل الإلغاء)', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const r = await call('PATCH', `/api/invoices/${original.id}/cancel`, { body: {}, headers: CAPS });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CANCEL_NOT_ALLOWED');
  const data = r.body.data as { invoiceId: string; creditable: { lines: unknown[]; eligible: boolean } | null };
  assert.equal(data.invoiceId, original.id);
  assert.ok(data.creditable && data.creditable.eligible, 'الردّ بلا معاينة الإشعار البديل');
  assert.equal(data.creditable!.lines.length, original.items.length);
  assert.equal(rig.created.length, 0, 'الإلغاء كتب شيئاً');
});

test('فاتورة صدر عليها إشعار (أصلٌ من المرحلة الأولى) لا تُلغى ⇒ 409 يحمل ما تبقّى', async () => {
  const rig = buildRig();
  const p1 = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, phase: 1, number: 'INV-2509-000900' });
  script(rig, { original: p1 });
  // الحارس القديم (zatcaPhase === 2) لا يمسّ هذه الفاتورة — والجديد يعدّ إشعاراتها الملتزَمة
  scripted['invoice.count'] = () => 1;
  const r = await call('PATCH', `/api/invoices/${p1.id}/cancel`, { body: {}, headers: CAPS });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CANCEL_NOT_ALLOWED');
  assert.match(String(r.body.message), /إشعار دائن أو مدين/);
  assert.equal(rig.created.length, 0, 'الإلغاء كتب شيئاً');
  assert.equal(calls.includes('$transaction'), false, 'الإلغاء فتح معاملة رغم الحارس');
});

test('أصلٌ من المرحلة الأولى: مرتجعه القديم يُخصم من المتاح، فلا يُرجَع المباع مرّتين بعد التفعيل', async () => {
  const rig = buildRig();
  const p1 = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, phase: 1, number: 'INV-2509-000901' });
  script(rig, { original: p1 });
  rig.legacyReturns = [{ items: [{ productId: 'p-rice', qty: 4 }] }];

  const view = await call('GET', `/api/invoices/${p1.id}/creditable`, { headers: CAPS });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const data = view.body.data as { legacyReturnsApplied: boolean; lines: Record<string, unknown>[] };
  const rice = data.lines.find(l => l.invoiceItemId === 'it-1')!;
  assert.equal(num(rice.qty), 10);
  assert.equal(num(rice.credited), 0, 'المرتجع القديم عُدَّ إشعاراً');
  assert.equal(num(rice.legacyCredited), 4);
  assert.equal(num(rice.returnable), 6, 'المتاح يتجاهل المرتجع القديم');
  assert.equal(data.legacyReturnsApplied, true);

  // وإشعارٌ بكامل الكمّية المباعة يُرفض بحارس الكمية لا يمرّ صامتاً
  const over = await call('POST', `/api/invoices/${p1.id}/credit-note`, {
    body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 10 }] }), headers: CAPS,
  });
  assert.equal(over.status, 422, JSON.stringify(over.body));
  assert.equal(over.body.code, 'ZATCA_CREDIT_QTY_EXCEEDED');
  assert.equal(rig.created.length, 0);
  // وما بقي فعلاً يمرّ
  const ok = await call('POST', `/api/invoices/${p1.id}/credit-note`, {
    body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 6 }] }), headers: CAPS,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

// ═══ (٨) المرتجع في POST /invoices ═══

const returnBody = (over: Record<string, unknown> = {}) => ({
  customerId: 'c-b2b',
  salesRepId: 'rep-1',
  type: 'RETURN',
  pricesIncludeTax: false,
  discountPct: 0,
  items: [{ productId: 'p-rice', qty: 2, unitPrice: 45.5, discountPct: 0, taxPct: 15 }],
  clientRef: crypto.randomUUID(),
  ...over,
});

test('D3: مرتجع بلا فاتورة أصلية ⇒ 422 «اختر الفاتورة أولاً» ولا مستند', async () => {
  const rig = buildRig();
  script(rig);
  const r = await call('POST', '/api/invoices', { body: returnBody(), headers: CAPS });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_RETURN_NEEDS_ORIGINAL');
  assert.equal(rig.created.length, 0);
});

test('D3: مرتجع بأصلٍ وبند الأصل ⇒ إشعار دائن معتمد، وسعره من الأصل لا من الطلب', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const r = await call('POST', '/api/invoices', {
    body: returnBody({
      originalInvoiceId: original.id,
      noteReason: 'بضاعة تالفة',
      items: [{ productId: 'p-rice', qty: 2, unitPrice: 999, discountPct: 0, taxPct: 15 }],
    }),
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const note = noteOf(r);
  assert.equal(note.type, 'RETURN');
  assert.equal(note.originalInvoiceId, original.id);
  assert.equal(note.noteReason, 'بضاعة تالفة');
  const items = note.items as Record<string, unknown>[];
  assert.equal(num(items[0].unitPrice), 45.5, 'سعر الإشعار من الطلب لا من الأصل');
  assert.equal(items[0].creditedItemId, 'it-1', 'البند لم يُطابَق ببند الأصل بالصنف');
  assert.equal(einvoiceOf(r).typeCode, '381');
});

// ═══ الوحدات المتعددة: الإشعار بوحدة الإرجاع ولقطتها، والمتاح بالأساس ═══

const CARTON_UNIT = { id: 'u-ct', name: 'كرتون', factor: 24, unitCode: 'CT', isActive: true };

/** أصلٌ قياسيّ معتمد ببند كرتونين (٢٤ حبة) بسعر ١٠ للكرتون. */
function cartonOriginal(): NoteOriginalInvoice {
  const base = originalInvoice({
    request: {
      type: 'CREDIT', paymentPlan: null, pricesIncludeTax: false, discountPct: 0, supplyDate: null,
      items: [{ productId: 'p-water', qty: 2, unitPrice: 10, discountPct: 0, taxPct: 15 }],
    },
    subtype: '01', einvoiceStatus: 'cleared',
  });
  return {
    ...base,
    items: base.items.map(i => ({ ...i, unitCode: 'CT', unitName: 'كرتون', unitFactor: 24, baseQty: 48, units: [CARTON_UNIT], baseUnitName: 'حبة' })),
  };
}

test('الوحدات: إشعارٌ بحبّات من بند كرتون ⇒ بنده بوحدة الأساس ولقطتها وbaseQty وسعر حصّته، والمعاينة تقول المتاح بالأساس', async () => {
  const rig = buildRig();
  const original = script(rig, { original: cartonOriginal() })!;
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 3 }] }), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const item = (noteOf(r).items as Record<string, unknown>[])[0];
  assert.deepEqual(
    [num(item.qty), item.unitName, num(item.unitFactor), num(item.baseQty), item.unitCode, item.creditedItemId, item.productId],
    [3, null, 1, 3, 'PCE', 'it-1', 'p-water'],
    'بند الإشعار لا يحمل لقطة وحدة الحبّة — مخزون السيارة يقرأ baseQty',
  );
  // ٣ حبّات من كرتونين بـ٢٠: حصّةٌ تراكمية ١٫٢٥ لا ٣ × سعر الكرتون
  assert.equal(Math.round(num(item.qty) * num(item.unitPrice) * 100) / 100, 1.25);
  const view = await call('GET', `/api/invoices/${original.id}/creditable`, { headers: CAPS });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const line = (view.body.data as { lines: Record<string, unknown>[] }).lines[0];
  assert.deepEqual(
    [num(line.soldBase), num(line.creditedBase), num(line.returnableBase), num(line.returnable), line.unitName, num(line.unitFactor), num(line.lineQty)],
    [48, 3, 45, 45, 'كرتون', 24, 2],
  );
  // والباقي كلّه (FULL) بوحدة الأساس: ٤٥ حبّة تُكمل قيمة البند ولا تتجاوزه
  const rest = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: 'FULL' }), headers: CAPS });
  assert.equal(rest.status, 201, JSON.stringify(rest.body));
  const restItem = (noteOf(rest).items as Record<string, unknown>[])[0];
  assert.deepEqual([num(restItem.qty), num(restItem.unitFactor), num(restItem.baseQty)], [45, 1, 45]);
  assert.equal(Math.round((num(noteOf(r).total) + num(noteOf(rest).total)) * 100) / 100, original.total, 'الإشعاران ≠ قيمة الأصل');
});

test('الوحدات: مرتجع المندوب بكرتون (unitId) على فاتورة مربوطة ⇒ إشعارٌ بالكرتون: لقطته ومعامله ورمزه CT و٢٤ حبّة بالأساس', async () => {
  const rig = buildRig();
  const original = script(rig, { original: cartonOriginal() })!;
  scripted['product.findMany'] = (args: unknown) => {
    const ids: string[] = (args as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? [];
    return PRODUCT_ROWS.filter(p => ids.includes(p.id)).map(p => ({ ...p, units: p.id === 'p-water' ? [CARTON_UNIT] : [] }));
  };
  const r = await call('POST', '/api/invoices', {
    body: returnBody({
      originalInvoiceId: original.id, noteReason: 'إرجاع كرتون',
      items: [{ productId: 'p-water', invoiceItemId: 'it-1', unitId: 'u-ct', qty: 1, unitPrice: 999, discountPct: 0, taxPct: 15 }],
    }),
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const item = (noteOf(r).items as Record<string, unknown>[])[0];
  assert.deepEqual(
    [num(item.qty), item.unitName, num(item.unitFactor), num(item.baseQty), item.unitCode, num(item.unitPrice)],
    [1, 'كرتون', 24, 24, 'CT', 10],
    'الكرتون المرتجع لم يُكتب بلقطته: يعود إلى السيارة حبّةً بدل ٢٤',
  );
});

test('الوحدات: ٢٤ إشعاراً بحبّة من كرتونٍ بخصمَي البند والفاتورة ⇒ كلّها 201 ومجموعها صافي الكرتون تماماً، والخامس والعشرون لا متاح له', async () => {
  const rig = buildRig();
  // ٥٢٫٢٩ للكرتون بخصم ١٪ و٢٫٥٪: الحصّة من الأساس وحدها كانت تُقيِّد للعميل ٥٨٫٢٩ عن صافي ٥٨٫٠٥ ويرفض الحارس آخرها
  const base = originalInvoice({
    request: {
      type: 'CREDIT', paymentPlan: null, pricesIncludeTax: false, discountPct: 2.5, supplyDate: null,
      items: [{ productId: 'p-water', qty: 1, unitPrice: 52.29, discountPct: 1, taxPct: 15 }],
    },
    subtype: '01', einvoiceStatus: 'cleared',
  });
  const original = script(rig, {
    original: { ...base, items: base.items.map(i => ({ ...i, unitCode: 'CT', unitName: 'كرتون', unitFactor: 24, baseQty: 24, units: [CARTON_UNIT], baseUnitName: 'حبة' })) },
  })!;
  let sum = 0;
  for (let k = 0; k < 24; k++) {
    const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
    assert.equal(r.status, 201, `الحبّة ${k + 1}: ${JSON.stringify(r.body)}`);
    const item = (noteOf(r).items as Record<string, unknown>[])[0];
    assert.deepEqual([num(item.baseQty), num(item.unitFactor)], [1, 1]);
    sum += num(noteOf(r).total);
  }
  assert.equal(Math.round(sum * 100), Math.round(original.total * 100), `مجموع الإشعارات ${sum} ≠ صافي الكرتون ${original.total}`);
  const extra = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
  assert.equal(extra.body.code, 'ZATCA_NOTHING_TO_CREDIT', JSON.stringify(extra.body));
});

test('الوحدات: وحدة إرجاعٍ ليست من وحدات الصنف ⇒ 400 UNIT_INVALID بلا مستند — لا تُقرأ حبّةً بصمت', async () => {
  const rig = buildRig();
  const original = script(rig, { original: cartonOriginal() })!;
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, {
    body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1, unitId: 'u-other-product' }] }), headers: CAPS,
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'UNIT_INVALID');
  assert.equal(rig.created.length, 0, 'أُنشئ إشعار');
});

// ═══ (٩) المرحلة الأولى كما هي ═══

test('المرحلة الأولى: المرتجع مستندٌ عاديّ بالمسار القديم حرفاً بحرف', async () => {
  const rig = buildRig();
  script(rig, { startedAt: null });
  const r = await call('POST', '/api/invoices', { body: returnBody() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  const data = noteOf(r);
  assert.equal(data.id, 'legacy-1', 'المرتجع لم يمرّ بالمسار القديم');
  assert.equal(data.type, 'RETURN');
  assert.equal(data.originalInvoiceId, undefined, 'المسار القديم كتب رابط إشعار');
  assert.equal(rig.h.docs.documents.size, 0, 'أُصدر مستند ضريبي لشركة مرحلة أولى');
  // لا استعلام عن وحدات الفوترة ولا عن إعدادات البائع
  assert.equal(calls.filter(c => c.startsWith('zatcaEgsUnit')).length, 0, 'استعلام وحدات في المرحلة الأولى');
});

test('المرحلة الأولى: مسارات الإشعارات مغلقة بردٍّ يشرح (409) بلا أيّ كتابة', async () => {
  const rig = buildRig();
  const original = script(rig, { startedAt: null })!;
  for (const [method, url, body] of [
    ['POST', `/api/invoices/${original.id}/credit-note`, creditBody()],
    ['POST', `/api/invoices/${original.id}/debit-note`, { reason: 'فرق سعر', lines: [{ description: 'فرق', qty: 1, unitPrice: 5, taxPct: 15 }] }],
    ['GET', `/api/invoices/${original.id}/creditable`, undefined],
  ] as const) {
    const r = await call(method as 'POST' | 'GET', url, { ...(body ? { body } : {}), headers: CAPS });
    assert.equal(r.status, 409, `${url}: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.message), /المرحلة الثانية/);
  }
  assert.equal(rig.created.length, 0);
});

test('D5: لم تحسم الهيئة الإشعار في نافذة الطلب ⇒ 202 «بانتظار الاعتماد»، والإشعار قائم ومتبقّي الأصل منقوص', async () => {
  const rig = buildRig({ fake: { onClear: () => FAKE_REPLIES.timeout(90_000) } });
  const original = script(rig)!;
  const before = num(rig.rows.get(original.id)!.remainingAmt);
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody(), headers: CAPS });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CLEARANCE_PENDING');
  const data = r.body.data as Record<string, unknown>;
  assert.equal(data.einvoiceStatus, 'clearance_pending');
  assert.equal((data.einvoice as Record<string, unknown>).printable, false, 'إشعار غير معتمد قابل للطباعة');
  assert.equal(rig.rows.get('note-1')!.status, 'CONFIRMED', 'الإشعار أُلغي لأنّ الهيئة تأخّرت');
  assert.notEqual(num(rig.rows.get(original.id)!.remainingAmt), before, 'أثر الإشعار على الأصل تراجع مع تأخّر الهيئة');
});

test('المبسّط: مهلة الإبلاغ ٢٤ ساعة محسوبة من لحظة الإصدار', async () => {
  const rig = buildRig();
  const cash = originalInvoice({ request: REQ_SIMPLIFIED_Z1, subtype: '02', einvoiceStatus: 'reported', customerId: 'c-walkin' });
  script(rig, { original: cash, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>) });
  const r = await call('POST', `/api/invoices/${cash.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = einvoiceOf(r);
  const issued = new Date(String(e.issuedAt)).getTime();
  assert.equal(new Date(String(e.reportDeadline)).getTime() - issued, 24 * 60 * 60 * 1000, 'مهلة الإبلاغ ليست ٢٤ ساعة');
  assert.equal(e.overdue, false);
});

test('استُنفد المتاح: إشعارٌ كامل بعد كامل ⇒ 409، والمعاينة تقول ذلك', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const first = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: 'FULL' }), headers: CAPS });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: 'FULL' }), headers: CAPS });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'ZATCA_NOTHING_TO_CREDIT');
  const view = await call('GET', `/api/invoices/${original.id}/creditable`, { headers: CAPS });
  const data = view.body.data as { eligible: boolean; refusal: string; lines: { returnable: number }[] };
  assert.equal(data.eligible, false);
  assert.equal(data.refusal, 'NOTHING_TO_CREDIT');
  assert.ok(data.lines.every(l => l.returnable === 0), 'المعاينة تعرض متاحاً بعد استنفاده');
  assert.equal(rig.created.length, 1, 'أُصدر إشعار ثانٍ رغم استنفاد المتاح');
});

// ═══ (١٠) مفتاح API عميلٌ حيّ: لحظة الجهاز (clientCreatedAt) لا تصنع يومَ المرتجع ═══
//
// صندوق تطبيق المندوب يرفع لاحقاً ما سجّله دون اتصال، فيُقاس مرتجعه بلحظة إنشائه على الجهاز. أمّا المفتاح فيكتب جسمه كله:
// لحظةٌ يرسلها يومٌ يختاره — يمرّ به قيد المرتجع للصنف، ويُوسَم به المنتهي صالحاً. فلا تُقرأ له ولا تُخزَّن، ويومُه
// invoiceDate وإلا الآن. وما تُشدّد به اللحظة (حارس clientRef في المرحلة الثانية) يبقى عليه كما هو.

const API_KEY_ADMIN = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT, apiKeyId: 'key-1' } as typeof currentUser;
const SESSION_ADMIN = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };

/** صنفٌ بصلاحية ٣٠ يوماً وقيد «ما زال صالحاً» بعشرة أيام: المرتجع يُقبل إن بقي من صلاحية ما بيع ١٠ أيام أو أكثر */
const STILL_VALID_RICE = {
  ...PRODUCT_ROWS.find(p => p.id === 'p-rice')!, teams: [],
  shelfLifeEnabled: true, shelfLifeValue: 30, shelfLifeUnit: 'DAY', shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: true, returnRuleMode: 'STILL_VALID', returnRuleMetric: 'DAYS', returnRuleValue: 10,
};

test('مفتاح API: مرتجع المرحلة الأولى لا يُخزَّن عليه clientCreatedAt المرسَل — والجلسة (صندوق المندوب واللوحة) تخزّنه كما كانت', async () => {
  const rig = buildRig();
  script(rig, { startedAt: null });
  const created: Record<string, unknown>[] = [];
  scripted['invoice.create'] = (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data;
    created.push(data);
    return { id: `legacy-${created.length}`, ...data };
  };
  const at = '2026-10-01T08:00:00.000Z';
  currentUser = API_KEY_ADMIN;
  try {
    const r = await call('POST', '/api/invoices', { body: returnBody({ clientCreatedAt: at }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(created[0].clientCreatedAt, undefined, 'خُزّنت لحظة جهاز من مفتاح API');
  } finally {
    currentUser = SESSION_ADMIN;
  }
  const s = await call('POST', '/api/invoices', { body: returnBody({ clientCreatedAt: at }) });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal((created[1].clientCreatedAt as Date).toISOString(), at, 'الجلسة فقدت لحظة جهازها');
});

test('مفتاح API: قيد المرتجع للصنف يُقاس باليوم لا بـclientCreatedAt المرسَل (إرجاعٌ بيومٍ مختار يُرفض 422) — والجلسة تُقاس بلحظة جهازها كما كانت', async () => {
  const rig = buildRig();
  script(rig, { startedAt: null });
  scripted['product.findMany'] = () => [STILL_VALID_RICE];
  // آخر بيعٍ للصنف لهذا العميل ينتهي بعد ٥ أيام من اليوم: اليوم يبقى ٥ (< ١٠ ⇒ مرفوض)، وقبل ٣٠ يوماً بقي ٣٥ (مقبول)
  scripted['invoiceItem.findFirst'] = () => ({
    invoiceId: 'sale-1', expiresAt: new Date(Date.now() + 5 * 86_400_000), invoice: { invoiceDate: new Date(), salesRepId: 'rep-1' },
  });
  const created: Record<string, unknown>[] = [];
  scripted['invoice.create'] = (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data;
    created.push(data);
    return { id: `legacy-${created.length}`, ...data };
  };
  const backdated = new Date(Date.now() - 30 * 86_400_000).toISOString();
  currentUser = API_KEY_ADMIN;
  try {
    const r = await call('POST', '/api/invoices', { body: returnBody({ clientCreatedAt: backdated }) });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'RETURN_RULE_BLOCKED');
    assert.equal(created.length, 0, 'صدر مرتجعٌ بيومٍ اختاره المفتاح');
  } finally {
    currentUser = SESSION_ADMIN;
  }
  // الجلسة: رفعٌ مؤجَّل من الجهاز يُقاس بيوم إنشائه — كما كان حرفاً بحرف
  const s = await call('POST', '/api/invoices', { body: returnBody({ clientCreatedAt: backdated }) });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(created.length, 1);
});

test('مفتاح API: الإشعار الدائن والمدين لا يُخزَّن عليهما clientCreatedAt — وحارس clientRef (426) يبقى عليه، والجلسة تخزّنه كما كانت', async () => {
  const rig = buildRig();
  const original = script(rig)!;
  const at = '2026-11-20T05:30:00.000Z';
  currentUser = API_KEY_ADMIN;
  try {
    // ما تُشدّد به اللحظة باقٍ للمفتاح: رفعٌ «مؤجَّل» بلا مفتاح منع تكرار ⇒ 426 بلا مستند
    const { clientRef: _drop, ...noKey } = creditBody();
    const refused = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: { ...noKey, clientCreatedAt: at }, headers: CAPS });
    assert.equal(refused.status, 426, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
    assert.equal(rig.created.length, 0);
    const credit = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: { ...creditBody(), clientCreatedAt: at }, headers: CAPS });
    assert.equal(credit.status, 201, JSON.stringify(credit.body));
    assert.equal(rig.created[0].clientCreatedAt, undefined, 'خُزّنت لحظة جهاز من مفتاح API على الإشعار الدائن');
    const debit = await call('POST', `/api/invoices/${original.id}/debit-note`, {
      body: { reason: 'فرق سعر على الفاتورة', lines: [{ description: 'فرق سعر أرز', qty: 1, unitPrice: 100, taxPct: 15 }], clientRef: crypto.randomUUID(), clientCreatedAt: at },
      headers: CAPS,
    });
    assert.equal(debit.status, 201, JSON.stringify(debit.body));
    assert.equal(rig.created[1].clientCreatedAt, undefined, 'خُزّنت لحظة جهاز من مفتاح API على الإشعار المدين');
  } finally {
    currentUser = SESSION_ADMIN;
  }
  const s = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: { ...creditBody(), clientCreatedAt: at }, headers: CAPS });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal((rig.created[2].clientCreatedAt as Date).toISOString(), at, 'الجلسة فقدت لحظة جهازها');
});

// ═══ (١١) «الوحدة الرئيسية» §3-2/§3-3 وI10: الإشعار الدائن والتحويل المتزامن، وانقطاع إصدار المرحلة الثانية خلف تحويلٍ طويل ═══
//
// #8: بنود الإشعار حُلّت على أساس الصنف كما قُرئ قبل المعاملة، فتحويلٌ التزم بين المعاينة وقفل الأصناف يجعل «٢» حبّتين بدل كرتونين
// ⇒ 409 (503 لإعادة الرفع) قبل الترقيم وICV. ومرتجعٌ دون اتصال أُعيد أساسه لا تسقط لقطته في الإشعار. وI10: الإصدار يمسك رأس
// سلسلة الشركة وهو ينتظر قفل الأصناف — فالمهلة محدودة (55P03 ⇒ 503 PRODUCT_UNITS_BUSY)، وصنفٌ قيد التحويل يُردّ قبل الـmutex.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { markConverting, unmarkConverting } = require('../services/baseGuard') as typeof import('../services/baseGuard');

/** معاملةٌ بـ$queryRaw: صفوف الأصناف المقفلة بأساسٍ تختاره (أو خطأ انتظار)، وكل ما عداها فارغ */
function lockingTx(rig: Rig, locked: (sql: string) => Array<{ id: string; unit: string; lotTracked?: boolean }> | Error | null): string[] {
  const sqls: string[] = [];
  (phase2Deps as NoteIssuanceDeps).transaction = <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => fn({
    ...txAdapter(rig),
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      sqls.push(sql);
      if (sql.includes('FROM products') && sql.includes('FOR KEY SHARE')) {
        const out = locked(sql);
        if (out instanceof Error) throw out;
        if (out) return out;
      }
      return [];
    },
  } as unknown as Phase2Tx);
  return sqls;
}

/** mutex مزيّف يسجّل كل طلبٍ له — «لم يُطلب» = لم يبدأ runIssuance */
function mutexSpy(): string[] {
  const used: string[] = [];
  (phase2Deps as { mutex: unknown }).mutex = { runExclusive: async <T>(key: string, fn: () => Promise<T>) => { used.push(key); return fn(); } };
  return used;
}

const noTrace = (rig: Rig, before = 0): void => {
  assert.equal(rig.created.length, before, 'أُنشئ إشعار');
  assert.equal(rig.h.docs.documents.size, before, 'استُهلك ICV');
  assert.equal(rig.ledger.length, before, 'قُيِّد في الدفتر');
};

test('#8 (§3-2): تحويلٌ التزم بين المعاينة وقفل الأصناف ⇒ 409 PRODUCT_UNITS_CHANGED بلا صفّ ولا ICV، وإعادة الرفع 503، والأساس كما هو يمرّ', async () => {
  const rig = buildRig();
  const original = script(rig, { original: cartonOriginal() })!;
  const sqls = lockingTx(rig, () => [{ id: 'p-water', unit: 'قارورة' }]);
  const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 2 }] }), headers: CAPS });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PRODUCT_UNITS_CHANGED');
  noTrace(rig);
  // القفل يقرأ وحدة الأساس، ومهلته المحلية تسبقه
  const lock = sqls.findIndex(s => s.startsWith('SELECT p.id, p.unit FROM products p') && s.endsWith('FOR KEY SHARE'));
  assert.ok(lock > 0, sqls.join(' | '));
  assert.match(sqls[lock - 1], /set_config\('lock_timeout'/);
  const replay = await call('POST', `/api/invoices/${original.id}/credit-note`, {
    body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 2 }] }), headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(replay.status, 503, JSON.stringify(replay.body));
  assert.equal(replay.body.code, 'PRODUCT_UNITS_CHANGED');
  noTrace(rig);
  // الأساس تحت القفل كما قُرئ ⇒ الإشعار يصدر
  lockingTx(rig, () => [{ id: 'p-water', unit: 'حبة' }]);
  const ok = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 2 }] }), headers: CAPS });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // والإشعار الكامل يُبنى من الصفوف المقفلة فلا يحتاج مقارنة
  const rig2 = buildRig();
  const o2 = script(rig2, { original: cartonOriginal() })!;
  lockingTx(rig2, () => [{ id: 'p-water', unit: 'قارورة' }]);
  assert.equal((await call('POST', `/api/invoices/${o2.id}/credit-note`, { body: creditBody({ lines: 'FULL' }), headers: CAPS })).status, 201);
});

test('#8 (§3-2): مرتجعٌ دون اتصال أُعيد أساسه بعد التحويل (وحدته حُذفت) ⇒ إشعارٌ بالكرتون بمعامل ٢٤ لا حبّة', async () => {
  const rig = buildRig();
  const original = script(rig, { original: cartonOriginal() })!;
  // الكرتون كان أساساً ثم حُوِّل إلى حبة وحُذفت وحدته: لقطة الجهاز «١ كرتون» بأساسه القديم، والسجلّ شاهدها
  scripted['product.findMany'] = (args: unknown) => {
    const ids: string[] = (args as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? [];
    return PRODUCT_ROWS.filter(p => ids.includes(p.id)).map(p => ({ ...p, units: [], baseConvertedAt: new Date('2026-11-01T00:00:00Z') }));
  };
  scripted['productBaseConversion.findMany'] = () => [{ productId: 'p-water', fromUnit: 'كرتون', toUnit: 'حبة', factor: 24, fromUnitId: 'u-ct', convertedAt: new Date('2026-11-01T00:00:00Z') }];
  scripted['customerPrice.findMany'] = () => [];
  const r = await call('POST', '/api/invoices', {
    body: returnBody({
      originalInvoiceId: original.id, noteReason: 'إرجاع كرتون',
      items: [{ productId: 'p-water', invoiceItemId: 'it-1', qty: 1, unitPrice: 10, discountPct: 0, taxPct: 15, unitName: 'كرتون', unitFactor: 1, baseUnitName: 'كرتون' }],
    }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const item = (noteOf(r).items as Record<string, unknown>[])[0];
  assert.deepEqual([num(item.qty), item.unitName, num(item.unitFactor), num(item.baseQty), item.unitCode], [1, 'كرتون', 24, 24, 'CT'],
    'لقطة المرتجع سقطت: كرتونٌ قُيِّد حبّة');
});

test('§3-3: POST /:id/credit-note — baseUnitName يخالف الأساس ⇒ 400، ومفتاح API على صنفٍ محوَّل بلاه ⇒ 400 BASE_UNIT_REQUIRED، وغيابه للجلسة سلوك اليوم، وunitFactor في الجسم يُتجاهل', async () => {
  const rig = buildRig();
  const original = script(rig, { original: cartonOriginal() })!;
  const converted = (on: boolean) => () => [{ id: 'it-1', productId: 'p-water', product: { name: 'مياه', unit: 'حبة', baseConvertedAt: on ? new Date('2026-11-01T00:00:00Z') : null } }];
  scripted['invoiceItem.findMany'] = converted(true);
  // كاشٌ قديم
  const stale = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1, baseUnitName: 'كرتون' }] }), headers: CAPS });
  assert.deepEqual([stale.status, stale.body.code], [400, 'UNIT_INVALID'], JSON.stringify(stale.body));
  assert.equal(rig.created.length, 0);
  // الجلسة بلا الحقل: لا استعلام إضافي ولا رفض
  calls = [];
  const plain = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.ok(!calls.includes('invoiceItem.findMany'), 'استعلامٌ جديد في مسار الجلسة');
  // unitFactor من الجسم لا يُقرأ: «١» بلا وحدة حبّةٌ كما كانت
  const forged = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1, unitFactor: 24, unitName: 'كرتون' }] }), headers: CAPS });
  assert.equal(forged.status, 201, JSON.stringify(forged.body));
  const fi = (noteOf(forged).items as Record<string, unknown>[])[0];
  assert.deepEqual([num(fi.unitFactor), num(fi.baseQty)], [1, 1], 'معاملٌ من الجسم كُتب');
  try {
    currentUser = API_KEY_ADMIN;
    const nobase = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
    assert.deepEqual([nobase.status, nobase.body.code], [400, 'BASE_UNIT_REQUIRED'], JSON.stringify(nobase.body));
    const before = rig.created.length;
    const withBase = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1, baseUnitName: 'حبة' }] }), headers: CAPS });
    assert.equal(withBase.status, 201, JSON.stringify(withBase.body));
    assert.equal(rig.created.length, before + 1);
    // سباقٌ بعد الفحص المسبق: الأساس المرسَل يُقارَن تحت القفل ⇒ 409 بلا صفّ
    lockingTx(rig, () => [{ id: 'p-water', unit: 'قارورة' }]);
    const raced = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1, baseUnitName: 'حبة' }] }), headers: CAPS });
    assert.deepEqual([raced.status, raced.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(raced.body));
    assert.equal(rig.created.length, before + 1);
    // صنفٌ لم يُحوَّل: المفتاح كما كان
    (phase2Deps as NoteIssuanceDeps).transaction = <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => fn(txAdapter(rig) as unknown as Phase2Tx);
    scripted['invoiceItem.findMany'] = converted(false);
    assert.equal((await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS })).status, 201);
  } finally {
    currentUser = SESSION_ADMIN;
  }
});

test('I10 (§3-13ج): قفل الأصناف ينتظر تحويلاً طويلاً ⇒ 55P03 أو 40P01 ⇒ 503 PRODUCT_UNITS_BUSY للإشعار، بلا صفّ ولا ICV', async () => {
  for (const code of ['55P03', '40P01']) {
    const rig = buildRig();
    const original = script(rig, { original: cartonOriginal() })!;
    lockingTx(rig, () => Object.assign(new Error('canceling statement due to lock timeout'), { code }));
    const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRODUCT_UNITS_BUSY');
    noTrace(rig);
  }
});

test('I10: صنفٌ قيد التحويل في هذه العملية ⇒ 503 قبل الـmutex ورأس السلسلة — للإشعار وللفاتورة، وأصنافٌ أخرى لا تنتظر شيئاً', async () => {
  markConverting(Z5_TENANT, 'p-water');
  try {
    // الإشعار الدائن على صنف التحويل
    const rig = buildRig();
    const original = script(rig, { original: cartonOriginal() })!;
    const used = mutexSpy();
    const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody({ lines: [{ invoiceItemId: 'it-1', qty: 1 }] }), headers: CAPS });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRODUCT_UNITS_BUSY');
    assert.deepEqual(used, [], 'طُلب الـmutex (runIssuance) لصنفٍ قيد التحويل');
    noTrace(rig);
    // إشعارٌ على فاتورةٍ بصنفٍ آخر يمرّ
    const rig2 = buildRig();
    const o2 = script(rig2)!;
    const used2 = mutexSpy();
    const other = await call('POST', `/api/invoices/${o2.id}/credit-note`, { body: creditBody(), headers: CAPS });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal(used2.length, 1);
    // فاتورة مرحلة ثانية بصنف التحويل ⇒ 503 قبل الـmutex
    const rig3 = buildRig();
    script(rig3);
    const used3 = mutexSpy();
    const sale = { ...returnBody(), type: 'CASH', items: [{ productId: 'p-water', qty: 1, unitPrice: 10, discountPct: 0, taxPct: 15 }] };
    const inv = await call('POST', '/api/invoices', { body: sale, headers: CAPS });
    assert.equal(inv.status, 503, JSON.stringify(inv.body));
    assert.equal(inv.body.code, 'PRODUCT_UNITS_BUSY');
    assert.deepEqual(used3, []);
    assert.equal(rig3.h.docs.documents.size, 0);
    // وبصنفٍ آخر لا ينتظر
    const rig4 = buildRig();
    script(rig4);
    const used4 = mutexSpy();
    const inv2 = await call('POST', '/api/invoices', { body: { ...sale, items: [{ productId: 'p-rice', qty: 1, unitPrice: 10, discountPct: 0, taxPct: 15 }] }, headers: CAPS });
    assert.notEqual(inv2.status, 503, JSON.stringify(inv2.body));
    assert.equal(used4.length, 1);
  } finally {
    unmarkConverting(Z5_TENANT, 'p-water');
  }
});

test('I10: فاتورة المرحلة الثانية — قفل الأصناف بمهلة محلية، و55P03 ⇒ 503 PRODUCT_UNITS_BUSY بلا مستند ولا ICV', async () => {
  const rig = buildRig();
  script(rig);
  const sqls = lockingTx(rig, () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
  const sale = { ...returnBody(), type: 'CASH', items: [{ productId: 'p-water', qty: 1, unitPrice: 10, discountPct: 0, taxPct: 15 }] };
  const r = await call('POST', '/api/invoices', { body: sale, headers: CAPS });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PRODUCT_UNITS_BUSY');
  assert.equal(rig.h.docs.documents.size, 0, 'استُهلك ICV');
  const lock = sqls.findIndex(s => s.startsWith('SELECT id, unit, "lotTracked" FROM products') && s.endsWith('FOR KEY SHARE'));
  assert.ok(lock > 0, sqls.join(' | '));
  assert.match(sqls[lock - 1], /set_config\('lock_timeout'/);
  assert.match(sqls[lock - 2], /current_setting\('lock_timeout'\)/);
});

// ═══ «فك قيد الرقم الضريبي والعنوان الوطني» (طلب المالك ٣١ أكتوبر ٢٠٢٦) ═══

/** يفكّ القيد في صفّ إعدادات البائع نفسه الذي يقرؤه الإصدار (بعد script). */
const relaxSeller = (rig: Rig, on: boolean): void => {
  const seller = rig.h.units.settings.get(Z5_TENANT)!;
  rig.h.units.settings.set(Z5_TENANT, { ...seller, buyerVatAddressRelaxed: on });
};

test('فك القيد: إشعار على أصلٍ من المرحلة الأولى لمنشأة ناقصة ⇒ 201 مبسّط (381/0200000) بلا اعتماد، ومعه notice وسطر تدقيق — ومطفأً 422', async t => {
  const inc = CUSTOMER_ROW(CUSTOMERS.b2bIncomplete as unknown as Record<string, unknown>);
  const p1 = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, phase: 1, number: 'INV-2509-000950', customerId: CUSTOMERS.b2bIncomplete.id });
  {
    const rig = buildRig();
    script(rig, { original: p1, customer: inc });
    const off = await call('POST', `/api/invoices/${p1.id}/credit-note`, { body: creditBody(), headers: CAPS });
    assert.equal(off.status, 422, JSON.stringify(off.body));
    assert.equal(off.body.code, 'ZATCA_BUYER_INCOMPLETE');
    assert.match(String(off.body.message), /^بيانات العميل \(منشأة\) ناقصة للفاتورة الضريبية: /);
    assert.equal(rig.created.length, 0);
  }
  const rig = buildRig();
  script(rig, { original: p1, customer: inc });
  relaxSeller(rig, true);
  const warn = t.mock.method(console, 'warn', () => undefined);
  // المعاينة تقول النوع الذي سيصدر به
  const view = await call('GET', `/api/invoices/${p1.id}/creditable`, { headers: CAPS });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal((view.body.data as { subtype: string }).subtype, '02');
  const r = await call('POST', `/api/invoices/${p1.id}/credit-note`, { body: creditBody(), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ein = einvoiceOf(r);
  assert.deepEqual([noteOf(r).invoiceSubtype, ein.subtype, ein.typeName, ein.status], ['02', '02', '0200000', 'signed']);
  const notice = r.body.notice as { code: string; message: string; fields: string[] };
  assert.equal(notice.code, 'ZATCA_BUYER_SIMPLIFIED');
  assert.match(notice.message, /^صدر الإشعار مبسطاً لأن /);
  assert.deepEqual(notice.fields, ['addrStreet', 'addrBuildingNo', 'district', 'addrPostalCode']);
  const lines = warn.mock.calls.map(c => String(c.arguments[0])).filter(l => l.includes('"ZATCA_BUYER_SIMPLIFIED"'));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).kind, 'CREDIT_NOTE');
  assert.equal(rig.created.length, 1);
});

test('فك القيد: إشعار على فاتورة ضريبية (01) لعميلٍ صارت بياناته ناقصة ⇒ 422 يبقى (الإشعار يتبع أصله) برسالةٍ أوضح وحقول الإكمال', async () => {
  const inc = CUSTOMER_ROW(CUSTOMERS.b2bIncomplete as unknown as Record<string, unknown>);
  const original = originalInvoice({ request: REQ_STANDARD_NO_HEAD_DISCOUNT, subtype: '01', einvoiceStatus: 'cleared', customerId: CUSTOMERS.b2bIncomplete.id });
  const bodies: Record<string, unknown>[] = [];
  for (const on of [false, true]) {
    const rig = buildRig();
    script(rig, { original, customer: inc });
    relaxSeller(rig, on);
    const r = await call('POST', `/api/invoices/${original.id}/credit-note`, { body: creditBody(), headers: CAPS });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'ZATCA_BUYER_INCOMPLETE');
    assert.deepEqual((r.body.data as { fields: string[] }).fields, ['addrStreet', 'addrBuildingNo', 'district', 'addrPostalCode']);
    assert.equal('notice' in r.body, false);
    assert.equal(rig.created.length, 0);
    bodies.push(r.body);
  }
  assert.match(String(bodies[0].message), /^بيانات العميل \(منشأة\) ناقصة للفاتورة الضريبية: /);
  assert.match(String(bodies[1].message), /^بيانات العميل ناقصة للإشعار على فاتورة ضريبية — الإشعار يتبع نوع فاتورته الأصلية فلا يصدر مبسطاً حتى مع فك القيد: /);
  assert.deepEqual(bodies[1].issues, bodies[0].issues);
});
