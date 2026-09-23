// ZATCA المرحلة الثانية (Z5.4) — «الاعتماد قبل المشاركة» عبر الموجّه الحقيقي: POST /api/invoices وGET /by-client-ref.
//
// لا قاعدة بيانات ولا شبكة: عميل Prisma مزيّف، ومخزن مستندات في الذاكرة، ومنصّة «فاتورة» مزيّفة يُحقن fetchها في
// عميل Z3 الحقيقي. ما يُثبَت هنا هو **ما يراه المندوب في يده**:
//   ١) اعتمدت الهيئة ⇒ 201 بفاتورة ضريبية قابلة للطباعة برمز الهيئة (لا رمزنا).
//   ٢) رفضت ⇒ 422، والفاتورة **مُبطلة فعلاً** في المعاملة نفسها (نقد 7): صفّها CANCELLED وقيودها معكوسة، ورسالة
//      الهيئة بالعربية في الردّ.
//   ٣) الهيئة بطيئة أو ساقطة (قرار المالك D5) ⇒ 202 «بانتظار الاعتماد»: لا فاتورة ضريبية تُسلَّم، والفاتورة قائمة،
//      والمسح الدوري يُكمل فتصير معتمدة بعد حين.
//   ٤) أوقفت الهيئة الاعتماد (303، نقد 10) ⇒ 201 مُبلَّغة قابلة للطباعة — لا معلّقة إلى الأبد.
//   ٥) اعتمدت بلا نسخة معتمدة (U8) ⇒ 202 برمز خاصّ ينهى عن التسليم.
//   ٦) المبسّطة لا تنتظر شيئاً: 201 فوراً وبلا أيّ نداء للهيئة في الطلب الحيّ.
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
      return async (strings: TemplateStringsArray) => {
        const sql = [...strings].join('?').replace(/\s+/g, ' ').trim();
        calls.push(key);
        const fn = scripted[`${key}:${sql.includes('FROM invoices') ? 'invoice' : sql.includes('zatca_documents') ? 'document' : 'other'}`];
        return fn ? fn(sql) : (key === '$queryRaw' ? [] : 0);
      };
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
import { COMPANY_VAT, CUSTOMERS, PRODUCTS, Z5_TENANT, Z5_UNIT } from '../compliance/zatca/__fixtures__/z5-sources';
import { submitDocument } from '../compliance/zatca/submit';
import type { Phase2IssuanceDeps, Phase2Tx } from '../routes/invoicesZatca';

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

async function call(method: 'POST' | 'GET', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
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

// ═══ العُدّة: تجهيزة الإرسال نفسها تخدم الإصدار الحيّ ═══

const PRODUCT_ROWS = PRODUCTS.map(p => ({
  id: p.id, name: p.name, basePrice: 1000, taxPct: null, damagedReturnToStock: true, priceTiers: [],
  vatCategory: p.vatCategory ?? null, vatExemptionCode: p.vatExemptionCode ?? null, vatExemptionReason: p.vatExemptionReason ?? null,
}));

const CUSTOMER_ROW = (base: Record<string, unknown>) => ({
  ...base, status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: Z5_TENANT, phone: '0500000000',
});

interface Rig {
  h: SubmitHarness;
  invoices: Map<string, Record<string, unknown>>;
  notifications: Record<string, unknown>[];
  entries: Record<string, unknown>[];
  published: string[];
}

/** مقبض المعاملة الذي يصل الفرع وخطّاف الإبطال: جدول فواتير في الذاكرة بلا $queryRaw (فيتخطّى القفل). */
function txAdapter(rig: Rig): Record<string, unknown> {
  return {
    invoice: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `inv-${rig.invoices.size + 1}`;
        const nested = data.items as { create?: Record<string, unknown>[] } | undefined;
        const row: Record<string, unknown> = { ...data, id, status: 'CONFIRMED', items: nested?.create ?? [], installments: [], signature: null };
        rig.invoices.set(id, row);
        rig.h.docs.invoices.set(id, {
          id, tenantId: String(data.tenantId), zatcaPhase: 2, einvoiceStatus: (data.einvoiceStatus as string) ?? null,
          einvoiceQr: (data.einvoiceQr as string) ?? null, einvoiceWarnings: null, einvoiceSubmittedAt: null,
        });
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rig.invoices.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rig.invoices.get(where.id);
        if (row) Object.assign(row, data);
        return row ?? null;
      },
    },
    notification: { create: async ({ data }: { data: Record<string, unknown> }) => { rig.notifications.push(data); return { id: 'n' }; } },
    customer: { update: async ({ data }: { data: Record<string, unknown> }) => { rig.entries.push({ customer: data }); return {}; } },
    accountEntry: {
      create: async ({ data }: { data: Record<string, unknown> }) => { rig.entries.push(data); return {}; },
      aggregate: async () => ({ _sum: { debit: 0, credit: 0 } }),
    },
  };
}

function buildRig(opts: Parameters<typeof createSubmitHarness>[0] = {}): Rig {
  const h = createSubmitHarness(opts);
  const rig: Rig = { h, invoices: new Map(), notifications: [], entries: [], published: [] };

  // نقد 7: الإبطال الحقيقيّ داخل معاملة كتابة النتيجة نفسها
  (h.deps as { onRejectedInTx?: unknown }).onRejectedInTx = async (_tx: unknown, info: {
    tenantId: string; invoiceId: string; documentId: string; subtype: '01' | '02'; errors: { code: string | null; message: string | null }[]; at: Date;
  }) => {
    await voidInvoiceInTx(txAdapter(rig) as never, {
      tenantId: info.tenantId, invoiceId: info.invoiceId, subtype: info.subtype, reason: 'REJECTED',
      documentId: info.documentId, errors: info.errors, at: info.at,
    });
  };

  const deps: Phase2IssuanceDeps = {
    db: prismaFake as unknown as Phase2IssuanceDeps['db'],
    units: h.units,
    documents: {
      insertSigned: (_tx, doc) => h.docs.insertSigned(null, doc),
      advanceUnitChain: (_tx, a) => h.docs.advanceUnitChain(null, a),
      loadProjection: (tenantId, invoiceId) => h.docs.loadProjection(tenantId, invoiceId),
    },
    chain: {
      lockChainHead: (_tx, unitId) => h.chain.lockChainHead(null, unitId),
      nextNumberInTx: async (_tx, _tenantId, prefix) => `${prefix}${String(rig.invoices.size + 1).padStart(6, '0')}`,
    },
    keyring: () => h.keyring,
    ledger: {
      postCashInvoice: async (_tx, tenantId, invoiceId, _c, total) => { rig.entries.push({ kind: 'CASH', tenantId, invoiceId, total }); },
      postCreditInvoice: async (_tx, tenantId, invoiceId, _c, total) => { rig.entries.push({ kind: 'CREDIT', tenantId, invoiceId, total }); },
      creditLimitNotice: async () => { /* لا حدّ ائتمانيّ في هذه الاختبارات */ },
    },
    transaction: <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => fn(txAdapter(rig) as unknown as Phase2Tx),
    publish: tid => { rig.published.push(tid); },
    now: () => h.clock.now(),
    env: {} as NodeJS.ProcessEnv,
    mutex: null,
    // الاعتماد الحيّ: محرّك الإرسال نفسه على المنصّة المزيّفة (المقعد المحجوز للطلب الحيّ)
    submitInline: (ref, o) => submitDocument(h.deps, ref, { inline: true, timeoutMs: o.timeoutMs }),
  };
  phase2Deps = deps;
  return rig;
}

function scriptBase(customer: Record<string, unknown>, o: { startedAt?: Date | null; replay?: Record<string, unknown> | null } = {}): void {
  calls = [];
  scripted = {
    'invoice.findUnique': () => o.replay ?? null,
    'salesRep.findFirst': () => ({ id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true, canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, maxDiscountPct: 100 }),
    'customer.findFirst': () => customer,
    'product.findMany': (args: unknown) => {
      const ids: string[] = (args as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? [];
      return PRODUCT_ROWS.filter(p => ids.includes(p.id));
    },
    'companySettings.findUnique': () => ({ defaultVatPct: COMPANY_VAT, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: o.startedAt === undefined ? LIVE_AT : o.startedAt }),
    'zatcaEgsUnit.findMany': (args: unknown) => {
      const env = (args as { where?: { environment?: string } }).where?.environment;
      return env === 'production'
        ? [{ id: Z5_UNIT, tenantId: Z5_TENANT, environment: 'production', status: 'ACTIVE', keyVersion: 1, vatNumber: (CUSTOMERS.b2bComplete as { taxNumber?: string }).taxNumber ?? '', certNotAfter: new Date('2031-01-01T00:00:00Z'), lastIcv: 0, lastInvoiceHash: null }]
        : [];
    },
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, invoiceSignatureEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => null,
    'invoice.create': (args: unknown) => ({ id: 'legacy-1', ...((args as { data?: Record<string, unknown> }).data ?? {}) }),
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
}

/** الوحدة الحقيقية تأتي من مخزن الذاكرة — نصحّح رقمها الضريبيّ في ردّ القاعدة المزيّفة. */
function fixUnitVat(h: SubmitHarness): void {
  const u = h.units.units.get(h.unitId);
  const prev = scripted['zatcaEgsUnit.findMany'];
  scripted['zatcaEgsUnit.findMany'] = (args: unknown) => {
    const rows = prev(args) as Record<string, unknown>[];
    return rows.map(r => ({ ...r, id: h.unitId, vatNumber: u?.vatNumber, environment: u?.environment, status: u?.status }));
  };
}

const b2bBody = (o: { clientRef?: string } = {}) => ({
  customerId: 'c-b2b',
  salesRepId: 'rep-1',
  type: 'CREDIT',
  pricesIncludeTax: false,
  discountPct: 0,
  items: [{ productId: 'p-rice', qty: 10, unitPrice: 45.5, discountPct: 0, taxPct: 15 }],
  clientRef: o.clientRef ?? crypto.randomUUID(),
});

const b2cBody = () => ({
  customerId: 'c-walkin',
  salesRepId: 'rep-1',
  type: 'CASH',
  pricesIncludeTax: true,
  discountPct: 0,
  items: [{ productId: 'p-water', qty: 2, unitPrice: 5, discountPct: 0, taxPct: 15 }],
  clientRef: crypto.randomUUID(),
});

async function postB2B(rig: Rig, body = b2bBody()): Promise<Reply> {
  scriptBase(CUSTOMER_ROW(CUSTOMERS.b2bComplete as unknown as Record<string, unknown>));
  fixUnitVat(rig.h);
  return call('POST', '/api/invoices', { body, headers: CAPS });
}

const einvoiceOf = (r: Reply): Record<string, unknown> =>
  ((r.body.data as Record<string, unknown>).einvoice ?? {}) as Record<string, unknown>;

// ═══ (١) الاعتماد ═══

test('اعتمدت الهيئة ⇒ 201 بفاتورة قابلة للطباعة برمز الهيئة لا برمزنا', async () => {
  const rig = buildRig();
  const r = await postB2B(rig);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  const e = einvoiceOf(r);
  assert.equal(e.status, 'cleared');
  assert.equal(e.documentStatus, 'CLEARED');
  assert.equal(e.printable, true, 'فاتورة معتمدة غير قابلة للطباعة');
  assert.equal(e.subtype, '01');
  const data = r.body.data as Record<string, unknown>;
  assert.equal(data.status, 'CONFIRMED');
  assert.equal(data.einvoiceStatus, 'cleared');
  assert.ok(typeof e.qr === 'string' && (e.qr as string).length > 0, 'بلا رمز في الردّ');
  const doc = [...rig.h.docs.documents.values()][0];
  assert.notEqual(e.qr, doc.qr, 'الرمز المعروض ختمُنا لا رمز الهيئة المعتمد');
  assert.equal(e.qr, rig.h.docs.documents.get(doc.id)?.clearedQr);
  assert.equal(rig.h.fake.violations.length, 0, `مخالفات ترويسة: ${rig.h.fake.violations.join(', ')}`);
  assert.equal(rig.h.fake.calls.filter(c => c.endpoint === 'clearance').length, 1, 'عدد نداءات الاعتماد ليس واحداً');
});

test('نقد 10: أوقفت الهيئة الاعتماد (303) ⇒ 201 مُبلَّغة قابلة للطباعة برمز ختمنا لا معلّقة للأبد', async () => {
  let clears = 0;
  const rig = buildRig({ fake: { onClear: () => { clears++; return FAKE_REPLIES.clearanceOff303(); } } });
  const r = await postB2B(rig);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = einvoiceOf(r);
  assert.equal(e.status, 'reported');
  assert.equal(e.printable, true, 'بعد 303 بقيت غير قابلة للطباعة — الفاتورة معلّقة إلى الأبد');
  assert.equal(clears, 1);
  const doc = [...rig.h.docs.documents.values()][0];
  assert.equal(e.qr, doc.qr, 'رمز المُبلَّغة يجب أن يكون ختمنا');
  assert.ok(e.reportDeadline, 'بلا مهلة إبلاغ بعد تحوّل التدفّق');
});

// ═══ (٢) الرفض والإبطال الذرّي ═══

test('رفضت الهيئة ⇒ 422 برسالتها، والفاتورة مُبطلة فعلاً وقيودها معكوسة (نقد 7)', async () => {
  const rig = buildRig({ fake: { onClear: () => FAKE_REPLIES.reject400('BR-KSA-14', 'معرّف المشتري غير صالح') } });
  const r = await postB2B(rig);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'ZATCA_REJECTED');
  assert.ok(String(r.body.message).includes('معرّف المشتري غير صالح'), 'رسالة الهيئة لم تصل المستخدم');
  assert.ok(String(r.body.message).includes('أصدر فاتورة جديدة'));

  const data = r.body.data as Record<string, unknown>;
  assert.equal(data.status, 'CANCELLED', 'الردّ يقول إنّ الفاتورة قائمة وهي مُبطلة');
  assert.equal(data.einvoiceStatus, 'rejected');
  assert.equal((data.einvoice as Record<string, unknown>).printable, false);

  const row = [...rig.invoices.values()][0];
  assert.equal(row.status, 'CANCELLED', 'صفّ الفاتورة لم يُبطل');
  assert.ok(rig.entries.some(e => e.type === 'INVOICE_CREDIT'), 'قيود الفاتورة لم تُعكس');
  assert.ok(rig.notifications.some(n => n.type === 'ZATCA_INVOICE_REJECTED'), 'الإدارة لم تُبلَّغ بالرفض');
  assert.equal(rig.h.invoice(String(row.id)).einvoiceStatus, 'rejected');
});

test('الرفض لا يُبطل مبسّطة: الورقة مع المشتري فتبقى الفاتورة قائمة', async () => {
  const rig = buildRig({ fake: { onReport: () => FAKE_REPLIES.reject400() } });
  scriptBase(CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>));
  fixUnitVat(rig.h);
  const r = await call('POST', '/api/invoices', { body: b2cBody(), headers: CAPS });
  assert.equal(r.status, 201, 'المبسّطة انتظرت الهيئة — وهي لا تنتظر');
  const id = String((r.body.data as Record<string, unknown>).id);
  // الإبلاغ يأتي لاحقاً من المسح: نُشغّله يدوياً ونتأكّد أنّ الفاتورة لم تُبطل
  const doc = [...rig.h.docs.documents.values()][0];
  await submitDocument(rig.h.deps, { documentId: doc.id, tenantId: Z5_TENANT });
  assert.equal(rig.h.doc(doc.id).status, 'REJECTED');
  assert.equal(rig.invoices.get(id)?.status, 'CONFIRMED', 'أُبطلت مبسّطة ورقتُها عند المشتري');
});

// ═══ (٣) قرار المالك D5: الهيئة بطيئة أو ساقطة ═══

test('الهيئة ساقطة (عطل شبكة) ⇒ 202 «بانتظار الاعتماد»، والفاتورة قائمة وغير قابلة للطباعة', async () => {
  const rig = buildRig({ fake: { onClear: () => FAKE_REPLIES.network() } });
  const r = await postB2B(rig);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.success, true, '202 ليست خطأً: الفاتورة صدرت فعلاً');
  assert.equal(r.body.code, 'ZATCA_CLEARANCE_PENDING');
  assert.equal(r.body.reason, 'RETRY');
  assert.ok(String(r.body.message).includes('مذكرة التسليم'), 'الرسالة لا ترشد المندوب إلى ما يسلّمه');
  const e = einvoiceOf(r);
  assert.equal(e.status, 'clearance_pending');
  assert.equal(e.printable, false);
  assert.equal(e.qr, null, 'رمز فاتورة لم تُعتمد ظهر في الردّ');
  const row = [...rig.invoices.values()][0];
  assert.equal(row.status, 'CONFIRMED', 'أُبطلت فاتورة لمجرّد أنّ الهيئة لم تردّ');
});

test('المسح الدوري يُكمل ما لم يُحسم: المحاولة التالية تعتمدها فتصير قابلة للطباعة', async () => {
  let n = 0;
  const rig = buildRig({ fake: { onClear: () => (++n === 1 ? FAKE_REPLIES.server503() : undefined) } });
  const r = await postB2B(rig);
  assert.equal(r.status, 202);
  const doc = [...rig.h.docs.documents.values()][0];
  rig.h.clock.advance(10 * 60 * 1000);
  const after2 = await submitDocument(rig.h.deps, { documentId: doc.id, tenantId: Z5_TENANT });
  assert.equal((after2 as { status?: string }).status, 'CLEARED');
  assert.equal(rig.h.invoice(String([...rig.invoices.keys()][0])).einvoiceStatus, 'cleared');
});

test('انقضت مهلتنا والهيئة لم تردّ ⇒ 202 بلا انتظارٍ طويل، والعمل يكمل في الخلفية', async () => {
  const rig = buildRig({ fake: { onClear: () => FAKE_REPLIES.timeout(90_000) } });
  const started = Date.now();
  const r = await postB2B(rig);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.ok(Date.now() - started < 60_000, 'الطلب انتظر أطول من نافذة الاعتماد');
  assert.equal(r.body.code, 'ZATCA_CLEARANCE_PENDING');
});

// ═══ (٤) اعتمادٌ بلا نسخة معتمدة (U8) ═══

test('اعتماد بلا نسخة معتمدة ⇒ 202 برمز خاصّ ينهى عن التسليم، وتنبيه المالك', async () => {
  const rig = buildRig({ fake: { onClear: () => FAKE_REPLIES.duplicateNoXml208() } });
  const r = await postB2B(rig);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CLEARED_NO_XML');
  assert.ok(String(r.body.message).includes('لا تُسلِّم'));
  assert.equal(einvoiceOf(r).printable, false);
  assert.ok(rig.h.notifications.some(n => n.kind === 'CLEARED_NO_XML'), 'المالك لم يُنبَّه');
});

// ═══ (٥) المبسّطة والمرحلة الأولى لا تنتظران شيئاً ═══

test('المبسّطة: 201 فوراً بلا أيّ نداء للهيئة في الطلب الحيّ', async () => {
  const rig = buildRig();
  scriptBase(CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>));
  fixUnitVat(rig.h);
  const r = await call('POST', '/api/invoices', { body: b2cBody(), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(rig.h.fake.calls.length, 0, 'المبسّطة نادت الهيئة في الطلب الحيّ');
  const e = einvoiceOf(r);
  assert.equal(e.status, 'signed');
  assert.equal(e.printable, true, 'المبسّطة تُطبع فور ختمها');
});

test('المرحلة الأولى: لا اعتماد ولا نداء ولا إسقاط مستند', async () => {
  const rig = buildRig();
  scriptBase(CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>), { startedAt: null });
  const r = await call('POST', '/api/invoices', { body: b2cBody(), headers: CAPS });
  assert.equal(r.status, 201);
  assert.equal((r.body.data as Record<string, unknown>).einvoice, undefined);
  assert.equal(rig.h.fake.calls.length, 0);
  assert.equal(rig.h.docs.documents.size, 0);
});

// ═══ (٦) القراءة بالمرجع (by-client-ref) ═══

test('القراءة بالمرجع تُعيد الفاتورة وإسقاط مستندها بلا أيّ نداء للهيئة', async () => {
  const rig = buildRig();
  const ref = crypto.randomUUID();
  const r = await postB2B(rig, b2bBody({ clientRef: ref }));
  assert.equal(r.status, 201);
  const created = r.body.data as Record<string, unknown>;

  const before = rig.h.fake.calls.length;
  scripted['invoice.findFirst'] = () => ({ ...created, einvoice: undefined, zatcaPhase: 2, einvoiceStatus: 'cleared', einvoiceQr: 'Q', documentKind: 'INVOICE', invoiceSubtype: '01', issuedAt: new Date(), einvoiceWarnings: null });
  const read = await call('GET', `/api/invoices/by-client-ref/${ref}`, { headers: CAPS });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const e = (read.body.data as Record<string, unknown>).einvoice as Record<string, unknown>;
  assert.equal(e.documentStatus, 'CLEARED');
  assert.equal(rig.h.fake.calls.length, before, 'القراءة بالمرجع نادت الهيئة');
});

test('القراءة بالمرجع: حزمة بلا قدرات ⇒ 426، ومرجع مجهول ⇒ 404', async () => {
  const rig = buildRig();
  const ref = crypto.randomUUID();
  await postB2B(rig, b2bBody({ clientRef: ref }));
  const created = [...rig.invoices.values()][0];

  scripted['invoice.findFirst'] = () => ({ ...created, zatcaPhase: 2, einvoiceStatus: 'cleared', einvoiceQr: 'Q', documentKind: 'INVOICE', invoiceSubtype: '01', issuedAt: new Date(), einvoiceWarnings: null });
  const old = await call('GET', `/api/invoices/by-client-ref/${ref}`);
  assert.equal(old.status, 426, 'صفّ مختوم وصل حزمةً لا تفهمه');
  assert.equal(old.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');

  scripted['invoice.findFirst'] = () => null;
  const missing = await call('GET', `/api/invoices/by-client-ref/${crypto.randomUUID()}`, { headers: CAPS });
  assert.equal(missing.status, 404);
});

/* مراجعة عدائية: الردّ على إعادة الرفع كان 200 «تمّ» دائماً — فحزمةٌ أضاعت ردّ الرفع الأول (وهو ما وُضع له
 * clientRef) تعلّم فاتورةً مُبطلةً «تمّت المزامنة». الردّ الآن هو ردّ الرفع الأوّل نفسه. */
test('إعادة الرفع بالمرجع لفاتورة رفضتها الهيئة ⇒ 422 كالرفع الأوّل لا 200، وبلا نداء جديد', async () => {
  const rig = buildRig({ fake: { onClear: () => FAKE_REPLIES.reject400('BR-KSA-14', 'معرّف المشتري غير صالح') } });
  const ref = crypto.randomUUID();
  const body = b2bBody({ clientRef: ref });
  const first = await postB2B(rig, body);
  assert.equal(first.status, 422, JSON.stringify(first.body));
  const created = [...rig.invoices.values()][0];
  assert.equal(created.status, 'CANCELLED');

  scriptBase(CUSTOMER_ROW(CUSTOMERS.b2bComplete as unknown as Record<string, unknown>), {
    replay: {
      ...created, zatcaPhase: 2, invoiceSubtype: '01', einvoiceStatus: 'rejected', documentKind: 'INVOICE',
      issuedAt: new Date(), einvoiceWarnings: null, items: [], customer: null,
    },
  });
  fixUnitVat(rig.h);
  const before = rig.h.fake.calls.length;
  const again = await call('POST', '/api/invoices', { body, headers: CAPS });
  assert.equal(again.status, 422, JSON.stringify(again.body));
  assert.equal(again.body.code, 'ZATCA_REJECTED');
  assert.equal(again.body.success, false);
  assert.equal((again.body.data as Record<string, unknown>).status, 'CANCELLED', 'الصفّ المُعاد يقول إنّها قائمة');
  assert.equal(rig.h.fake.calls.length, before, 'نودِيت الهيئة من جديد لمستند حُسم');
});

test('القراءة بالمرجع تنثر نطاق مستخدم الشركة كاملاً (العميل **والمندوب**) كـGET /:id', async () => {
  const rig = buildRig();
  const ref = crypto.randomUUID();
  await postB2B(rig, b2bBody({ clientRef: ref }));
  const created = [...rig.invoices.values()][0];
  const wheres: unknown[] = [];
  scripted['admin.findUnique'] = () => ({ scopeEnabled: true });
  scripted['invoice.findFirst'] = (args: unknown) => {
    wheres.push((args as { where?: unknown }).where);
    return { ...created, zatcaPhase: 2, invoiceSubtype: '01' };
  };
  await call('GET', `/api/invoices/by-client-ref/${ref}`, { headers: CAPS });
  const text = JSON.stringify(wheres);
  assert.ok(text.includes('clientRef'), 'القراءة لم تعد بالمرجع');
  assert.ok(text.includes('salesRep'), 'قيد نطاق المندوب لم يُنثر — فاتورة مندوبٍ مخفيّ تُقرأ بمرجعها');
  assert.ok(text.includes('customer'), 'قيد نطاق العملاء لم يُنثر');
});

test('القراءة بالمرجع محروسة بنطاق المندوب: فاتورة مندوب آخر ⇒ 404 لا تسريب', async () => {
  const rig = buildRig();
  const ref = crypto.randomUUID();
  await postB2B(rig, b2bBody({ clientRef: ref }));
  const created = [...rig.invoices.values()][0];
  scripted['invoice.findFirst'] = () => ({ ...created, salesRepId: 'rep-other', zatcaPhase: 2, invoiceSubtype: '01' });
  currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: Z5_TENANT };
  try {
    const r = await call('GET', `/api/invoices/by-client-ref/${ref}`, { headers: CAPS });
    assert.equal(r.status, 404);
  } finally {
    currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };
  }
});

// ═══ (٧) السحب وإعادة الإصدار عبر الموجّه (نقد 11 وdesign Z5.9) ═══

const WITHDRAWABLE_ROW = {
  id: 'inv-w', tenantId: Z5_TENANT, number: 'INV-2612-000099', status: 'CONFIRMED', type: 'CREDIT', zatcaPhase: 2,
  invoiceSubtype: '01', einvoiceStatus: 'clearance_blocked', customerId: 'c-b2b', total: 523.25,
};

const WITHDRAW_DOC = {
  id: 'doc-w', egsUnitId: Z5_UNIT, attemptNo: 1, icv: 7, uuid: 'U', pih: 'P', invoiceHash: 'H', typeCode: '388',
  typeName: '0100000', issueDate: '2026-12-01', issueTime: '12:00:00', flow: 'CLEARANCE', qr: 'Q', clearedQr: null,
  status: 'CONFIG_ERROR', httpStatus: null, validation: null, attempts: 0, nextAttemptAt: null, leaseUntil: null, firstSubmitAt: null,
  finalizedAt: null, reportDeadline: null, keyVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  egsUnit: { environment: 'production' },
};

function scriptWithdraw(o: { delivered?: number; cas?: number; row?: Record<string, unknown> } = {}): void {
  calls = [];
  const row = o.row ?? WITHDRAWABLE_ROW;
  scripted = {
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => row,
    'zatcaDocument.findFirst': () => WITHDRAW_DOC,
    'zatcaApiLog.count': () => o.delivered ?? 0,
    '$executeRaw:document': () => o.cas ?? 1,
    '$queryRaw:invoice': () => [row],
    'accountEntry.aggregate': () => ({ _sum: { debit: 523.25, credit: 0 } }),
    'invoice.update': () => ({ ...row, status: 'CANCELLED' }),
  };
}

test('السحب: فاتورة لم تصل الهيئة ⇒ 200 مُبطلة بمرآة withdrawn ودليل', async () => {
  buildRig();
  scriptWithdraw();
  const r = await call('POST', '/api/invoices/inv-w/einvoice/withdraw', { headers: CAPS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data as Record<string, unknown>;
  assert.equal(d.status, 'CANCELLED');
  assert.equal(d.einvoiceStatus, 'withdrawn');
  assert.equal(d.proof, 'NEVER_SENT');
  assert.ok(calls.includes('notification.create'), 'الإدارة لم تُبلَّغ بالسحب');
});

test('السحب: محاولةٌ قد تكون وصلت ⇒ 409 برسالة عربية تشرح المنع، وبلا أيّ كتابة', async () => {
  buildRig();
  scriptWithdraw({ delivered: 3 });
  const r = await call('POST', '/api/invoices/inv-w/einvoice/withdraw', { headers: CAPS });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_WITHDRAW_NOT_ALLOWED');
  assert.equal(r.body.reason, 'MAY_HAVE_BEEN_RECEIVED');
  assert.ok(/[\u0600-\u06FF]/.test(String(r.body.message)));
  assert.equal(calls.includes('invoice.update'), false, 'كُتب شيء رغم منع السحب');
});

test('السحب: فاتورة خارج نطاق المستخدم ⇒ 404 بلا كشف', async () => {
  buildRig();
  scriptWithdraw();
  scripted['invoice.findFirst'] = () => null;
  const r = await call('POST', '/api/invoices/inv-x/einvoice/withdraw', { headers: CAPS });
  assert.equal(r.status, 404);
  assert.equal(calls.includes('zatcaDocument.findFirst'), false, 'قُرئ المستند لفاتورة خارج النطاق');
});

/* الإعادة اليدوية: المخرج الذي كان ينقص المستند المحجوب (401 أو عطل إعداد) — بلا مسارٍ له كانت مهلة الإبلاغ
 * تفوت بلا محاولة واحدة. الحرّاس أولاً: خارج النطاق ⇒ 404 بلا قراءة مستند، ومحسومٌ عند الهيئة ⇒ 409. */
test('الإعادة اليدوية: فاتورة خارج النطاق ⇒ 404 بلا قراءة المستند، ومستندٌ حسمته الهيئة ⇒ 409', async () => {
  buildRig();
  scriptWithdraw();
  scripted['invoice.findFirst'] = () => null;
  const out = await call('POST', '/api/invoices/inv-w/einvoice/retry', { headers: CAPS });
  assert.equal(out.status, 404);
  assert.equal(calls.includes('zatcaDocument.findFirst'), false, 'قُرئ المستند لفاتورة خارج النطاق');

  scriptWithdraw({ row: WITHDRAWABLE_ROW });
  scripted['zatcaDocument.findFirst'] = () => ({ ...WITHDRAW_DOC, status: 'CLEARED' });
  const done = await call('POST', '/api/invoices/inv-w/einvoice/retry', { headers: CAPS });
  assert.equal(done.status, 409, JSON.stringify(done.body));
  assert.equal(done.body.code, 'ZATCA_RETRY_NOT_ALLOWED');
  assert.equal(done.body.reason, 'DOCUMENT_FINAL');
  assert.ok(/[؀-ۿ]/.test(String(done.body.message)));
});

test('إعادة الإصدار: حزمة بلا قدرات ⇒ 426 قبل أيّ عمل', async () => {
  buildRig();
  scriptWithdraw();
  const r = await call('POST', '/api/invoices/inv-w/einvoice/reissue');
  assert.equal(r.status, 426);
  assert.equal(r.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
  assert.equal(calls.includes('invoice.findFirst'), false, 'قُرئت الفاتورة قبل حارس القدرات');
});

test('إعادة الإصدار: قياسية مرفوضة ⇒ 409 (تُبطل وتُصدر جديدة، لا تُعاد)', async () => {
  buildRig();
  scriptWithdraw({ row: { ...WITHDRAWABLE_ROW, einvoiceStatus: 'rejected', invoiceSubtype: '01', einvoiceSnapshot: { v: 1 }, issuedAt: new Date() } });
  const r = await call('POST', '/api/invoices/inv-w/einvoice/reissue', { headers: CAPS });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_REISSUE_NOT_ALLOWED');
  assert.equal(r.body.reason, 'NOT_SIMPLIFIED');
  assert.ok(String(r.body.message).includes('المبسّطة'));
});
