// ZATCA المرحلة الثانية (Z5.2) — اختبارات سلوك POST /invoices وGET /invoices/:id عبر الموجّه الحقيقي.
//
// لا قاعدة بيانات ولا شبكة خارجية: عميل Prisma **مزيّف** يُحقن في ذاكرة الوحدات (require.cache) قبل تحميل الموجّه، ومعه
// مصادقةٌ مزيّفة واعتمادياتُ فرع المرحلة الثانية (مخزن وحدات في الذاكرة + محاكي المعاملة z5-locksim). المطلوب إثباته:
//   ١) **المرحلة الأولى كما هي حرفاً بحرف**: الردّ نفسه، وتسلسل الاستعلامات نفسه، وصفر استدعاءات لفرع المرحلة الثانية.
//   ٢) المرحلة الثانية (حيّة وبروفة): مستند SIGNED بسلسلة ICV/PIH متّصلة، ومرآة الفاتورة، وأعمدة البنود، بلا نداءٍ للهيئة.
//   ٣) حارس القدرات 426 (ونقد 2: قبل الحجب وقبل قاعدة الانتقال)، وإعادة الرفع بلا قدرات 409.
//   ٤) إعادة الرفع (clientRef) والقراءة GET /:id لصفّ مختوم: 426 لحزمة قديمة، وإسقاط المستند لمن يفهمه (نقد 6).
//   ٥) الحجب (وحدة غير مفعّلة، تغيّر الرقم الضريبي) 503، وبيانات المشتري الناقصة 422، والعملة 422، والمرتجع 422.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { computeInvoiceTotals } from '../lib/invoiceCalc';
import { encryptSecret, createKeyring, type SecretKeyring } from '../compliance/zatca/secrets';
import { memoryEgsUnitStore, type MemoryEgsUnitStore, type MemoryUnitRow } from '../compliance/zatca/onboardingStore';
import { buildCsidCert } from '../compliance/zatca/__fixtures__/z4-csidcert';
import { createLockSim, type LockSim, type SimTx } from '../compliance/zatca/__fixtures__/z5-locksim';
import { COMPANY_VAT, CUSTOMERS, PRODUCTS, Z5_TENANT, Z5_UNIT, Z5_VAT, sellerSettings } from '../compliance/zatca/__fixtures__/z5-sources';
import { gunzipXml } from '../compliance/zatca/documentStore';
import { verifyStampedXml } from '../compliance/zatca/stamp';
import { parseCsidToken } from '../compliance/zatca/cert';
import crypto from 'crypto';

// ═══ حقن البدائل قبل تحميل الموجّه ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/** كل نداء على العميل المزيّف يُسجَّل بـ«النموذج.العملية» — تسلسل الاستعلامات هو ما نثبته للمرحلة الأولى. */
let calls: string[] = [];
/** ردود مُبرمَجة بالمفتاح نفسه؛ ما لا رد له يعيد الافتراضي (null / [] / 0). */
let scripted: Record<string, (args: unknown) => unknown> = {};

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
        return typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prismaFake) : arg;
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async () => { calls.push(key); return key === '$queryRaw' ? [] : 0; };
    }
    if (key === 'then') return undefined; // لا يُعامَل كـPromise
    return modelProxy(key);
  },
});

/** المستخدم الحاليّ للطلب (مصادقة مزيّفة). */
let currentUser: { id: string; role: string; tenantId: string } = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };

const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass,
  requireAccounting: pass,
  requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});

/** اعتماديات فرع المرحلة الثانية تُبدَّل بالكامل — الفرع نفسه (routes/invoicesZatca.ts) يُنفَّذ حقيقةً. */
let phase2Deps: unknown = null;
let phase2DepsCalls = 0;
stub('routes/invoicesZatcaDeps', {
  productionPhase2Deps: () => {
    phase2DepsCalls++;
    if (!phase2Deps) throw new Error('اعتماديات المرحلة الثانية غير مهيّأة لهذا الاختبار');
    return phase2Deps;
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesRouter = require('../routes/invoices').default as express.Router;
import type { Phase2IssuanceDeps, Phase2Tx } from '../routes/invoicesZatca';
import type { DocumentProjection } from '../compliance/zatca/documentStore';

// ═══ العُدّة ═══

const LIVE_AT = new Date('2026-11-20T06:00:00.000Z');
const CERT_NOT_BEFORE = new Date('2026-01-01T00:00:00Z');
const CERT_NOT_AFTER = new Date('2031-01-01T00:00:00Z');
const START = new Date('2026-12-01T09:00:00.000Z');

interface Server {
  port: number;
  close: () => Promise<void>;
}

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

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

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

const CAPS = { 'X-FS-Caps': 'zatca2' };

// ─── بيانات المنصّة المزيّفة ───

const CUSTOMER_ROW = (base: Record<string, unknown>) => ({
  ...base, status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: Z5_TENANT, phone: '0500000000',
});

const PRODUCT_ROWS = PRODUCTS.map(p => ({
  id: p.id, name: p.name, basePrice: 1000, taxPct: null, damagedReturnToStock: true, priceTiers: [],
  vatCategory: p.vatCategory ?? null, vatExemptionCode: p.vatExemptionCode ?? null, vatExemptionReason: p.vatExemptionReason ?? null,
}));

/** جسم POST /invoices كما ترسله الواجهة (البنود بأسعار الطلب). */
function invoiceBody(o: { items: { productId: string; qty: number; unitPrice: number; discountPct?: number; taxPct?: number }[]; type?: string; pricesIncludeTax?: boolean; discountPct?: number; customerId: string; clientRef?: string | null; invoiceDate?: string }): Record<string, unknown> {
  return {
    customerId: o.customerId,
    salesRepId: 'rep-1',
    type: o.type ?? 'CASH',
    pricesIncludeTax: o.pricesIncludeTax ?? true,
    discountPct: o.discountPct ?? 0,
    items: o.items,
    ...(o.clientRef === null ? {} : { clientRef: o.clientRef ?? crypto.randomUUID() }),
    ...(o.invoiceDate ? { invoiceDate: o.invoiceDate } : {}),
  };
}

// ─── وحدة EGS في الذاكرة + محاكي المعاملة ───

interface Rig {
  units: MemoryEgsUnitStore;
  sim: LockSim;
  unitRow: MemoryUnitRow;
  keyring: SecretKeyring;
  certB64: string;
  notifications: Record<string, unknown>[];
  published: string[];
  alerts: string[];
  invoiceRows: Map<string, Record<string, unknown>>;
  now: () => Date;
}

function buildRig(o: { environment?: string; status?: string; startedAt?: Date | null; vatNumber?: string; certNotAfter?: Date } = {}): Rig {
  const keyring = createKeyring({ current: crypto.randomBytes(32) });
  const privateKey = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey;
  const cert = buildCsidCert({ subjectKey: privateKey, vatNumbers: [Z5_VAT], notBefore: CERT_NOT_BEFORE, notAfter: o.certNotAfter ?? CERT_NOT_AFTER });
  const units = memoryEgsUnitStore({ settings: [sellerSettings({ zatcaPhase2StartedAt: o.startedAt === undefined ? LIVE_AT : o.startedAt })] });
  const at = new Date('2026-10-01T00:00:00Z');
  const row: MemoryUnitRow = {
    id: Z5_UNIT, tenantId: Z5_TENANT, kind: 'SERVER', environment: o.environment ?? 'production', commonName: 'EGS-Z5',
    serialNumber: '1-FS|2-Z5|3-00000000-0000-4000-8000-000000000001', functionMap: '1100', orgName: 'org', orgUnit: 'Riyadh',
    vatNumber: o.vatNumber ?? Z5_VAT, locationAddress: 'Riyadh', industry: 'Wholesale', status: o.status ?? 'ACTIVE', keyVersion: 1,
    publicKeyPem: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string, csrPem: null,
    complianceRequestId: null, complianceSteps: null, certSerial: null, certNotBefore: CERT_NOT_BEFORE,
    certNotAfter: o.certNotAfter ?? CERT_NOT_AFTER, lastIcv: 0, lastInvoiceHash: null, activatedAt: at, revokedAt: null, lastError: null,
    createdAt: at, updatedAt: at,
    privateKeyEnc: encryptSecret(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer, { purpose: 'egs-key', ownerId: Z5_UNIT }, keyring),
    complianceToken: null, complianceSecretEnc: null, productionToken: cert.token, productionSecretEnc: null,
  };
  units.units.set(row.id, row);
  let t = START.getTime();
  const now = () => { const d = new Date(t); t += 1000; return d; };
  const sim = createLockSim({
    units: [{ id: row.id, tenantId: row.tenantId, status: row.status, environment: row.environment, keyVersion: row.keyVersion, vatNumber: row.vatNumber, lastIcv: 0, lastInvoiceHash: null, updatedAt: at }],
    now: () => new Date(t),
  });
  return { units, sim, unitRow: row, keyring, certB64: cert.certB64, notifications: [], published: [], alerts: [], invoiceRows: new Map(), now };
}

/** المقبض الذي يصل فرع المرحلة الثانية: معاملة المحاكي + جدولا الفواتير والإشعارات. */
interface TxAdapter { __sim: SimTx }
const unwrap = (tx: unknown): SimTx => (tx as TxAdapter).__sim;

function depsFor(rig: Rig): Phase2IssuanceDeps {
  const expand = (data: Record<string, unknown>, id: string): Record<string, unknown> => {
    const nested = data.items as { create?: Record<string, unknown>[] } | undefined;
    const inst = data.installments as { create?: Record<string, unknown>[] } | undefined;
    const sig = data.signature as { create?: Record<string, unknown> } | undefined;
    const row = { ...data, id };
    row.items = (nested?.create ?? []).map((i, k) => ({ ...i, id: `${id}-i${k}`, invoiceId: id }));
    row.installments = (inst?.create ?? []).map((i, k) => ({ ...i, id: `${id}-n${k}`, invoiceId: id }));
    row.signature = sig?.create ? { image: sig.create.image ?? null, repImage: sig.create.repImage ?? null } : null;
    row.customer = scripted['customer.findFirst'] ? scripted['customer.findFirst']({}) : null;
    row.status = 'CONFIRMED';
    return row;
  };
  return {
    db: prismaFake as unknown as Phase2IssuanceDeps['db'],
    units: rig.units,
    chain: {
      lockChainHead: (tx, unitId) => rig.sim.chain.lockChainHead(unwrap(tx), unitId),
      nextNumberInTx: (tx, tenantId, prefix) => rig.sim.nextNumber(unwrap(tx), tenantId, prefix),
    },
    documents: {
      insertSigned: (tx, doc) => rig.sim.documentStore.insertSigned(unwrap(tx), doc),
      advanceUnitChain: (tx, a) => rig.sim.documentStore.advanceUnitChain(unwrap(tx), a),
      loadProjection: async (tenantId: string, invoiceId: string): Promise<DocumentProjection | null> => {
        const d = [...rig.sim.documents.values()].filter(x => x.tenantId === tenantId && x.invoiceId === invoiceId).sort((a, b) => a.attemptNo - b.attemptNo).pop();
        if (!d) return null;
        return {
          id: d.id, egsUnitId: d.egsUnitId, environment: rig.unitRow.environment, attemptNo: d.attemptNo, icv: d.icv, uuid: d.uuid, pih: d.pih,
          invoiceHash: d.invoiceHash, typeCode: d.typeCode, typeName: d.typeName, issueDate: d.issueDate, issueTime: d.issueTime, flow: d.flow,
          qr: d.qr, clearedQr: null, status: d.status, httpStatus: null, validation: null, attempts: 0, nextAttemptAt: null, firstSubmitAt: null,
          finalizedAt: null, reportDeadline: d.reportDeadline, keyVersion: d.keyVersion, createdAt: d.createdAt, updatedAt: d.createdAt,
        };
      },
    },
    keyring: () => rig.keyring,
    ledger: {
      postCashInvoice: (tx, tenantId, invoiceId, _c, total) => rig.sim.postLedger(unwrap(tx), { tenantId, invoiceId, amount: total }),
      postCreditInvoice: (tx, tenantId, invoiceId, _c, total) => rig.sim.postLedger(unwrap(tx), { tenantId, invoiceId, amount: total }),
      creditLimitNotice: async (_tx, i) => { rig.notifications.push({ ...i }); },
    },
    transaction: <T>(fn: (tx: Phase2Tx) => Promise<T>): Promise<T> => rig.sim.transaction(async simTx => {
      const adapter = {
        __sim: simTx,
        invoice: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const { id } = await rig.sim.createInvoice(simTx, {
              tenantId: String(data.tenantId), number: String(data.number), clientRef: (data.clientRef as string | null) ?? null, data,
            });
            const row = expand(data, id);
            rig.invoiceRows.set(id, row);
            return row;
          },
        },
        notification: { create: async ({ data }: { data: Record<string, unknown> }) => { rig.notifications.push(data); return { id: 'n' }; } },
      };
      return fn(adapter as unknown as Phase2Tx);
    }),
    publish: tid => { rig.published.push(tid); },
    alert: err => { rig.alerts.push(err.code); },
    now: rig.now,
    env: process.env,
    mutex: null,
  };
}

/** يضبط ردود العميل المزيّف لمسار POST كامل. */
function scriptBase(o: { customer: Record<string, unknown>; startedAt?: Date | null; units?: unknown[]; tenantFlag?: boolean; replay?: Record<string, unknown> | null; lastNumber?: string }): void {
  const unitRows = o.units;
  scripted = {
    'invoice.findUnique': () => o.replay ?? null,
    'salesRep.findFirst': () => ({ id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true, canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, maxDiscountPct: 100 }),
    'customer.findFirst': () => o.customer,
    'product.findMany': (args: unknown) => {
      const where = (args as { where?: { id?: { in?: string[] } }; select?: Record<string, unknown> }).where;
      const ids: string[] = where?.id?.in ?? [];
      return PRODUCT_ROWS.filter(p => ids.includes(p.id));
    },
    'companySettings.findUnique': () => ({ defaultVatPct: COMPANY_VAT, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: o.startedAt === undefined ? LIVE_AT : o.startedAt }),
    'zatcaEgsUnit.findMany': (args: unknown) => {
      const env = (args as { where?: { environment?: string } }).where?.environment;
      return (unitRows ?? []).filter(u => (u as { environment: string }).environment === env);
    },
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: o.tenantFlag === true, invoiceSignatureEnabled: false }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => (o.lastNumber ? { number: o.lastNumber } : null),
    'invoice.create': (args: unknown) => ({ id: 'legacy-1', ...((args as { data?: Record<string, unknown> }).data ?? {}), items: [], customer: o.customer, installments: [], signature: null }),
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
}

function unitViewOf(rig: Rig): Record<string, unknown> {
  const u = rig.unitRow;
  return {
    id: u.id, tenantId: u.tenantId, environment: u.environment, status: u.status, keyVersion: u.keyVersion, vatNumber: u.vatNumber,
    certNotAfter: u.certNotAfter, lastIcv: rig.sim.units.get(u.id)?.lastIcv ?? 0, lastInvoiceHash: rig.sim.units.get(u.id)?.lastInvoiceHash ?? null,
  };
}

function reset(): void {
  calls = [];
  scripted = {};
  phase2Deps = null;
  phase2DepsCalls = 0;
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT };
  delete process.env.ZATCA_REHEARSAL_TENANT_IDS;
}

// ═══ (١) المرحلة الأولى — بلا أيّ تغيير ═══

/** تسلسل استعلامات POST /invoices للمرحلة الأولى: **لا يتغيّر**. أيّ زيادة هنا كسرٌ لعهد «المرحلة الأولى كما هي». */
const PHASE1_POST_CALLS = [
  'invoice.findUnique',   // idempotency (clientRef)
  'salesRep.findFirst',
  'admin.findUnique',     // نطاق مستخدم الشركة (canAccessRep)
  'customer.findFirst',
  'admin.findUnique',     // نطاق العميل (canAccessCustomer)
  'product.findMany',
  'companySettings.findUnique',
  'invoice.findFirst',    // توليد الرقم
  '$transaction',
  'invoice.create',
  'accountEntry.aggregate',
  'accountEntry.create',   // نقدية: مدين ثم دائن
  'accountEntry.create',
  'customer.update',
];

/**
 * جلسة أخرى تضيف قفل صفّ العميل (`SELECT … FOR UPDATE` في services/accounting.ts) قبل قيود الحساب.
 * كلا التسلسلين مقبول هنا: الثابت أعلاه، أو هو نفسه بقفل العميل بعد إنشاء الفاتورة — فلا يرتبط التزام
 * المرحلة الثانية بترتيب التزام تلك الجلسة، ويبقى أيّ تغيير آخر في التسلسل كسراً يُكشف.
 */
const PHASE1_POST_CALLS_WITH_CUSTOMER_LOCK = (() => {
  const withLock = [...PHASE1_POST_CALLS];
  withLock.splice(withLock.indexOf('invoice.create') + 1, 0, '$queryRaw');
  return withLock;
})();

function assertPhase1Calls(calls: string[]): void {
  const asJson = JSON.stringify(calls);
  const ok = asJson === JSON.stringify(PHASE1_POST_CALLS) || asJson === JSON.stringify(PHASE1_POST_CALLS_WITH_CUSTOMER_LOCK);
  assert.ok(ok, `تسلسل استعلامات المرحلة الأولى تغيّر:\n${calls.join('\n')}`);
}

test('المرحلة الأولى: الردّ 201 بالحرف نفسه، وتسلسل الاستعلامات نفسه، وصفر استدعاء لفرع المرحلة الثانية', async () => {
  reset();
  scriptBase({ customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>), startedAt: null });
  const body = invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 2, unitPrice: 5, discountPct: 0, taxPct: 15 }] });
  const r = await call('POST', '/api/invoices', { body });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['data', 'success']);
  assert.equal(r.body.success, true);
  const data = r.body.data as Record<string, unknown>;
  assert.equal(data.id, 'legacy-1');
  assert.equal(data.einvoice, undefined, 'المرحلة الأولى لا تحمل einvoice');
  assert.equal(data.zatcaPhase, undefined, 'لا أعمدة مرحلة ثانية على صفّ مرحلة أولى');
  assert.equal(data.einvoiceProvider, 'zatca'); // كما اليوم: مزوّد الدولة
  assert.equal(data.einvoiceStatus, 'generated');
  assertPhase1Calls(calls);
  assert.equal(phase2DepsCalls, 0, 'المرحلة الأولى لمست اعتماديات المرحلة الثانية');
});

test('المرحلة الأولى: ترويسة القدرات لا تغيّر شيئاً، والمرتجع يمرّ كما اليوم', async () => {
  reset();
  scriptBase({ customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>), startedAt: null });
  const r = await call('POST', '/api/invoices', {
    body: invoiceBody({ customerId: 'c-walkin', type: 'RETURN', items: [{ productId: 'p-water', qty: 1, unitPrice: 5, discountPct: 0, taxPct: 15 }] }),
    headers: CAPS,
  });
  assert.equal(r.status, 201);
  assert.equal(phase2DepsCalls, 0);
});

test('المرحلة الأولى: GET /:id وإعادة الرفع بلا استعلام إضافي ولا فرع', async () => {
  reset();
  const legacy = { id: 'inv-legacy', zatcaPhase: null, number: 'INV-2611-000009', customerId: 'c-walkin', salesRepId: 'rep-1', einvoiceStatus: 'generated', einvoiceQr: 'x', documentKind: null, invoiceSubtype: null, issuedAt: null, einvoiceWarnings: null };
  scripted = { 'invoice.findFirst': () => legacy, 'admin.findUnique': () => ({ scopeEnabled: false }), 'invoice.findUnique': () => legacy };
  const r = await call('GET', '/api/invoices/inv-legacy');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, legacy);
  assert.equal(phase2DepsCalls, 0);

  // إعادة الرفع لصفّ مرحلة أولى: الردّ القديم نفسه
  reset();
  scriptBase({ customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>), startedAt: null, replay: legacy });
  const rr = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 5 }] }) });
  assert.equal(rr.status, 200);
  assert.equal(rr.body.idempotent, true);
  assert.deepEqual(rr.body.data, legacy);
  assert.equal(phase2DepsCalls, 0);
});

// ═══ (٢) المرحلة الثانية — الإصدار ═══

async function issue(rig: Rig, o: { customer: Record<string, unknown>; body: Record<string, unknown>; headers?: Record<string, string>; tenantFlag?: boolean; startedAt?: Date | null }): Promise<Reply> {
  phase2Deps = depsFor(rig);
  scriptBase({ customer: o.customer, startedAt: o.startedAt, units: [unitViewOf(rig)], tenantFlag: o.tenantFlag });
  return call('POST', '/api/invoices', { body: o.body, headers: o.headers ?? CAPS });
}

test('حيّة: فاتورة مبسّطة نقدية ⇒ 201 بمستند SIGNED وسلسلة ICV/PIH ومرآة ومبالغ D6', async () => {
  reset();
  const rig = buildRig();
  const body = invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 25.8, discountPct: 0, taxPct: 15 }] });
  const r = await issue(rig, { customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>), body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const data = r.body.data as Record<string, unknown>;
  const ein = data.einvoice as Record<string, unknown>;
  assert.equal(ein.phase, 2);
  assert.equal(ein.mode, 'live');
  assert.equal(ein.environment, 'production');
  assert.equal(ein.status, 'signed');
  assert.equal(ein.documentStatus, 'SIGNED');
  assert.equal(ein.subtype, '02');
  assert.equal(ein.typeName, '0200000');
  assert.equal(ein.icv, 1);
  assert.equal(ein.printable, true);
  assert.equal(ein.overdue, false);
  assert.ok(typeof ein.qr === 'string' && (ein.qr as string).length > 40, 'رمز QR المبسّطة مفقود');
  assert.ok(ein.reportDeadline, 'مهلة الإبلاغ (٢٤ ساعة) مفقودة للمبسّطة');

  // أعمدة صفّ الفاتورة
  assert.equal(data.zatcaPhase, 2);
  assert.equal(data.documentKind, 'INVOICE');
  assert.equal(data.invoiceSubtype, '02');
  assert.equal(data.einvoiceProvider, 'zatca');
  assert.equal(data.einvoiceStatus, 'signed');
  assert.equal(data.einvoiceIcv, 1);
  assert.equal(data.einvoiceQr, ein.qr);
  assert.equal(data.einvoiceWarnings, null);
  assert.ok(data.einvoiceSnapshot, 'اللقطة مفقودة');
  assert.equal(String(data.issuedAt), String(data.invoiceDate), 'invoiceDate يجب أن يساوي لحظة الإصدار');
  // D6: السعر المعلن كما هو، والفرق في subtotal
  assert.equal(data.total, 25.8);
  assert.equal(data.paidAmt, 25.8);
  assert.equal(data.remainingAmt, 0);
  const items = data.items as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0].seq, 1);
  assert.equal(items[0].itemName, 'مياه معدنية 330 مل × 40');
  assert.equal(items[0].unitCode, 'PCE');
  assert.equal(items[0].vatCategory, 'S');

  // المستند في المخزن: البايتات تتحقّق بشهادة الوحدة، وPIH الأولى INITIAL
  assert.equal(rig.sim.documents.size, 1);
  const doc = [...rig.sim.documents.values()][0];
  assert.equal(doc.status, 'SIGNED');
  assert.equal(doc.icv, 1);
  assert.equal(doc.flow, 'REPORTING');
  assert.equal(doc.keyVersion, 1);
  // البايتات المخزَّنة تتحقّق بشهادة الوحدة نفسها، وتجزئتها ورمزها كما حُفظا (يرمي StampError عند أي اختلاف)
  const v = verifyStampedXml(gunzipXml(doc.xmlGz), parseCsidToken(rig.unitRow.productionToken as string), 'simplified', { invoiceHash: doc.invoiceHash, qr: doc.qr });
  assert.equal(v.invoiceHash, doc.invoiceHash);
  assert.equal(v.qr, doc.qr);
  assert.equal(v.qr, ein.qr, 'رمز الردّ ليس رمز البايتات المختومة');
  assert.equal(rig.sim.units.get(Z5_UNIT)!.lastIcv, 1);
  assert.equal(rig.sim.units.get(Z5_UNIT)!.lastInvoiceHash, doc.invoiceHash);
  assert.equal(rig.sim.ledger.length, 1, 'قيد دفتر العميل لم يُكتب');
  assert.deepEqual(rig.published, [Z5_TENANT], 'لا بثّ لحظي بعد الالتزام');
});

test('حيّة: فاتورتان متتاليتان ⇒ ICV متّصل وPIH = تجزئة السابقة، والترقيم بشهر الرياض', async () => {
  reset();
  const rig = buildRig();
  const c = CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>);
  const one = await issue(rig, { customer: c, body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }) });
  const two = await issue(rig, { customer: c, body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-juice', qty: 2, unitPrice: 11.5 }] }) });
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  const docs = [...rig.sim.documents.values()].sort((a, b) => a.icv - b.icv);
  assert.deepEqual(docs.map(d => d.icv), [1, 2]);
  assert.equal(docs[1].pih, docs[0].invoiceHash, 'PIH الثانية ليست تجزئة الأولى');
  const numbers = [...rig.sim.invoices.values()].map(i => i.number).sort();
  assert.deepEqual(numbers, ['INV-2612-000001', 'INV-2612-000002'], 'الترقيم بشهر الرياض لم يتسلسل');
});

test('بروفة: القائمة + العلم + وحدة simulation ⇒ إصدار كامل بلا نداء للهيئة', async () => {
  reset();
  process.env.ZATCA_REHEARSAL_TENANT_IDS = Z5_TENANT;
  const rig = buildRig({ environment: 'simulation', startedAt: null });
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
    tenantFlag: true, startedAt: null,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ein = (r.body.data as Record<string, unknown>).einvoice as Record<string, unknown>;
  assert.equal(ein.mode, 'rehearsal');
  assert.equal(ein.environment, 'simulation');
  assert.equal(rig.sim.documents.size, 1);
});

test('بروفة: القائمة بلا علم المالك ⇒ مرحلة أولى (يكمل المسار القديم)', async () => {
  reset();
  process.env.ZATCA_REHEARSAL_TENANT_IDS = Z5_TENANT;
  const rig = buildRig({ environment: 'simulation', startedAt: null });
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
    tenantFlag: false, startedAt: null,
  });
  assert.equal(r.status, 201);
  assert.equal((r.body.data as Record<string, unknown>).einvoice, undefined, 'صدرت على مسار المرحلة الثانية');
  assert.equal(rig.sim.documents.size, 0);
});

test('حيّة: فاتورة قياسية (منشأة مكتملة) ⇒ 202 بانتظار الاعتماد، ولا رمز QR يُكشف', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.b2bComplete as unknown as Record<string, unknown>),
    body: { ...invoiceBody({ customerId: 'c-b2b', type: 'CREDIT', pricesIncludeTax: false, items: [{ productId: 'p-rice', qty: 10, unitPrice: 45.5, discountPct: 10, taxPct: 15 }] }) },
  });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_CLEARANCE_PENDING');
  assert.match(String(r.body.message), /بانتظار اعتماد الهيئة/);
  const data = r.body.data as Record<string, unknown>;
  const ein = data.einvoice as Record<string, unknown>;
  assert.equal(ein.subtype, '01');
  assert.equal(ein.status, 'clearance_pending');
  assert.equal(ein.qr, null, 'رمز قياسية غير معتمدة كُشف');
  assert.equal(ein.printable, false);
  assert.equal(data.einvoiceQr, null);
  assert.equal([...rig.sim.documents.values()][0].flow, 'CLEARANCE');
});

// ═══ (٣) حارس القدرات ═══

test('حيّة: بلا ترويسة قدرات ⇒ 426 قبل أيّ إصدار (ولا مستند)', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
    headers: {},
  });
  assert.equal(r.status, 426);
  assert.equal(r.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
  assert.match(String(r.body.message), /حدّث التطبيق/);
  assert.equal(rig.sim.documents.size, 0);
  assert.equal(rig.sim.invoices.size, 0);
});

test('حيّة: إعادة رفع من حزمة قديمة (X-FS-Replay بلا قدرات) ⇒ 409 مراجعة الإدارة، لا مسار مرحلة أولى', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
    headers: { 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ZATCA_CUTOVER_REVIEW');
  assert.equal(rig.sim.invoices.size, 0, 'صدرت فاتورة مرحلة أولى بعد التفعيل');
});

test('نقد 2: الحارس يسبق الحجب — وحدة غير مفعّلة + حزمة قديمة ⇒ 426 لا 503', async () => {
  reset();
  const rig = buildRig({ status: 'AUTH_FAILED' });
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
    headers: {},
  });
  assert.equal(r.status, 426);
  assert.equal(r.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
});

test('نقد 1: طلب حيّ من اللوحة أو /m (قدرات بلا clientRef) يُصدر 201 — لا قفل على عميل أوّليّ', async () => {
  reset();
  const rig = buildRig();
  // شكل جسم لوحة الإدارة وMInvoiceCreate حرفياً: بلا clientRef وبلا clientCreatedAt
  const body = invoiceBody({ customerId: 'c-walkin', clientRef: null, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] });
  assert.equal('clientRef' in body, false, 'جسم الاختبار لا يمثّل اللوحة');
  const r = await issue(rig, { customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>), body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(rig.sim.invoices.size, 1, 'لم تصدر الفاتورة');
  assert.equal(rig.sim.documents.size, 1);
  const data = r.body.data as Record<string, unknown>;
  assert.equal((data.einvoice as Record<string, unknown>).icv, 1);
  assert.equal(data.clientRef, undefined, 'مفتاح مُختلَق من الخادم');
});

test('حيّة: رفعٌ من صندوق العمل دون اتصال (clientCreatedAt) بلا clientRef ⇒ 426 (لا حماية من الرفع المكرّر)', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: {
      ...invoiceBody({ customerId: 'c-walkin', clientRef: null, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
      clientCreatedAt: '2026-12-01T08:55:00.000Z',
    },
  });
  assert.equal(r.status, 426);
  assert.equal(r.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
  assert.equal(rig.sim.invoices.size, 0);
});

test('حيّة: إعادة رفع صريحة (X-FS-Replay مع قدرات) بلا clientRef ⇒ 426', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', clientRef: null, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
    headers: { ...CAPS, 'X-FS-Replay': '1' },
  });
  assert.equal(r.status, 426);
  assert.equal(r.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
  assert.equal(rig.sim.invoices.size, 0);
});

// ═══ (٤) القراءات: إعادة الرفع وGET /:id ═══

const PHASE2_ROW = {
  id: 'inv-p2', zatcaPhase: 2, number: 'INV-2612-000001', customerId: 'c-walkin', salesRepId: 'rep-1',
  einvoiceStatus: 'signed', einvoiceQr: 'Q-STAMPED', documentKind: 'INVOICE', invoiceSubtype: '02',
  issuedAt: new Date('2026-12-01T09:00:05.000Z'), einvoiceWarnings: null,
};

function scriptRead(rig: Rig, doc: { icv: number; uuid: string } | null): void {
  phase2Deps = depsFor(rig);
  scripted = {
    'invoice.findFirst': () => PHASE2_ROW,
    'invoice.findUnique': () => PHASE2_ROW,
    'admin.findUnique': () => ({ scopeEnabled: false }),
  };
  if (doc) {
    (phase2Deps as Phase2IssuanceDeps).documents.loadProjection = async () => ({
      id: 'doc-1', egsUnitId: Z5_UNIT, environment: 'production', attemptNo: 1, icv: doc.icv, uuid: doc.uuid, pih: 'p', invoiceHash: 'h',
      typeCode: '388', typeName: '0200000', issueDate: '2026-12-01', issueTime: '12:00:05', flow: 'REPORTING', qr: 'Q-STAMPED',
      clearedQr: null, status: 'SIGNED', httpStatus: null, validation: null, attempts: 0, nextAttemptAt: null, firstSubmitAt: null,
      finalizedAt: null, reportDeadline: new Date('2026-12-02T09:00:05.000Z'), keyVersion: 1, createdAt: new Date(), updatedAt: new Date(),
    });
  }
}

test('قائمة الفواتير لا تحمل لقطة الـXML (einvoiceSnapshot) — ولا تفقد شيئاً غيرها', async () => {
  reset();
  const row = {
    id: 'inv-p2', number: 'INV-2612-000001', total: 11.5, zatcaPhase: 2, einvoiceStatus: 'signed', einvoiceQr: 'Q',
    einvoiceSnapshot: { supplier: {}, customer: {}, lines: [{ name: 'مياه' }], totals: { payable: '11.50' } },
    customer: { id: 'c-walkin', name: 'زبون', phone: '0500000000' },
  };
  scripted = { 'invoice.findMany': () => [row], 'invoice.count': () => 1, 'admin.findUnique': () => ({ scopeEnabled: false }) };
  const r = await call('GET', '/api/invoices', { headers: CAPS });
  assert.equal(r.status, 200);
  const rows = r.body.data as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal('einvoiceSnapshot' in rows[0], false, 'اللقطة تُشحن في كل صفّ من صفوف القائمة');
  // بقيّة الصفّ كما هي حرفاً بحرف (المرحلة الأولى لا تفقد حقلاً)
  const { einvoiceSnapshot: _dropped, ...rest } = row;
  assert.deepEqual(rows[0], rest);
});

test('نقد 6: GET /:id لصفّ مختوم — 426 لحزمة قديمة، وإسقاط المستند لمن يعلن قدراته', async () => {
  reset();
  const rig = buildRig();
  scriptRead(rig, { icv: 7, uuid: 'u-7' });
  const old = await call('GET', '/api/invoices/inv-p2');
  assert.equal(old.status, 426);
  assert.equal(old.body.code, 'ZATCA_CLIENT_UPDATE_REQUIRED');
  assert.equal(old.body.data, undefined, 'صفّ مختوم تسرّب لحزمة قديمة');

  scriptRead(rig, { icv: 7, uuid: 'u-7' });
  const now = await call('GET', '/api/invoices/inv-p2', { headers: CAPS });
  assert.equal(now.status, 200);
  const ein = (now.body.data as Record<string, unknown>).einvoice as Record<string, unknown>;
  assert.equal(ein.icv, 7);
  assert.equal(ein.uuid, 'u-7');
  assert.equal(ein.qr, 'Q-STAMPED');
  assert.equal(ein.status, 'signed');
  assert.equal(ein.printable, true);
  assert.equal(ein.mode, 'live');
});

test('نقد 6: إعادة الرفع (clientRef) لصفّ مختوم — 426 لحزمة قديمة، وإسقاط لمن يعلن قدراته', async () => {
  reset();
  const rig = buildRig();
  scriptRead(rig, { icv: 3, uuid: 'u-3' });
  const body = invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }], clientRef: '11111111-1111-4111-8111-111111111111' });
  const old = await call('POST', '/api/invoices', { body });
  assert.equal(old.status, 426);

  scriptRead(rig, { icv: 3, uuid: 'u-3' });
  const now = await call('POST', '/api/invoices', { body, headers: CAPS });
  assert.equal(now.status, 200);
  assert.equal(now.body.idempotent, true);
  const data = now.body.data as Record<string, unknown>;
  assert.equal(data.id, 'inv-p2');
  assert.equal(((data.einvoice as Record<string, unknown>).icv), 3);
});

test('إعادة الرفع الحقيقية: الفاتورة نفسها ولا مستند ثانٍ', async () => {
  reset();
  const rig = buildRig();
  const ref = '22222222-2222-4222-8222-222222222222';
  const c = CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>);
  const first = await issue(rig, { customer: c, body: invoiceBody({ customerId: 'c-walkin', clientRef: ref, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }) });
  assert.equal(first.status, 201);
  const issuedId = (first.body.data as Record<string, unknown>).id as string;

  // الرفع الثاني يجد الصفّ القائم (idempotency) فلا يدخل الفرع أصلاً
  phase2Deps = depsFor(rig);
  scripted = {
    'invoice.findUnique': () => ({ ...rig.invoiceRows.get(issuedId), zatcaPhase: 2 }),
    'admin.findUnique': () => ({ scopeEnabled: false }),
  };
  (phase2Deps as Phase2IssuanceDeps).documents.loadProjection = depsFor(rig).documents.loadProjection;
  const second = await call('POST', '/api/invoices', { body: invoiceBody({ customerId: 'c-walkin', clientRef: ref, items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }), headers: CAPS });
  assert.equal(second.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(rig.sim.documents.size, 1, 'إعادة الرفع أنشأت مستنداً ثانياً');
});

// ═══ (٥) الحجب والرفض ═══

test('حجب: وحدة قيد التجديد ⇒ 503 برسالة عربية واضحة، بلا مستند', async () => {
  reset();
  const rig = buildRig({ status: 'RENEWING' });
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'ZATCA_UNIT_UNAVAILABLE');
  assert.equal(r.body.reason, 'RENEWING');
  assert.match(String(r.body.message), /يجري تجديد شهادة الفوترة/);
  assert.equal(rig.sim.documents.size, 0);
});

test('نقد 12: تغيّر الرقم الضريبي للمنشأة ⇒ 503 SELLER_VAT_CHANGED قبل أيّ ختم', async () => {
  reset();
  const rig = buildRig({ vatNumber: '300000000000003' });
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'SELLER_VAT_CHANGED');
  assert.match(String(r.body.message), /تغيّر الرقم الضريبي/);
  assert.equal(rig.sim.documents.size, 0);
});

test('D2: قياسية ببيانات مشترٍ ناقصة ⇒ 422 ZATCA_BUYER_INCOMPLETE بمعرّف العميل وحقوله، بلا ICV', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.b2bIncomplete as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-b2b-inc', type: 'CREDIT', pricesIncludeTax: false, items: [{ productId: 'p-rice', qty: 1, unitPrice: 45.5 }] }),
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_BUYER_INCOMPLETE');
  assert.equal(r.body.customerId, 'c-b2b-inc');
  assert.ok(Array.isArray(r.body.issues) && (r.body.issues as unknown[]).length > 0);
  assert.ok((r.body.data as { fields?: string[] })?.fields?.length, 'حقول الإكمال مفقودة');
  assert.equal(rig.sim.units.get(Z5_UNIT)!.lastIcv, 0, 'استُهلك ICV رغم الرفض');
});

test('D2: عميل غير مصنّف ⇒ مبسّطة (لا حجب)', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.unclassifiedChannel as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-uncl-ch', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(((r.body.data as Record<string, unknown>).einvoice as Record<string, unknown>).subtype, '02');
});

test('المرتجع في المرحلة الثانية ⇒ 422 يلزمه إشعار دائن على الأصل', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', type: 'RETURN', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'ZATCA_RETURN_NEEDS_ORIGINAL');
  assert.equal(rig.sim.invoices.size, 0);
});

test('D9: عملة غير الريال ⇒ 422 ZATCA_CURRENCY بلا إصدار', async () => {
  reset();
  const rig = buildRig();
  rig.units.settings.set(Z5_TENANT, { ...rig.units.settings.get(Z5_TENANT)!, currencyOverride: 'USD' });
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'ZATCA_CURRENCY');
  assert.equal(rig.sim.documents.size, 0);
});

test('عطل الختم (سلسلة فاسدة) ⇒ 503 بتنبيه الإدارة ولا فاتورة ولا ICV مستهلك', async () => {
  reset();
  const rig = buildRig();
  // رأس سلسلة فاسد: lastIcv > 0 بلا مستند ذيل
  rig.sim.units.get(Z5_UNIT)!.lastIcv = 5;
  rig.sim.units.get(Z5_UNIT)!.lastInvoiceHash = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9=';
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 11.5 }] }),
  });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'ZATCA_CHAIN_CONFLICT');
  assert.deepEqual(rig.alerts, ['ZATCA_CHAIN_CONFLICT'], 'لم تُبلَّغ الإدارة بعطل السلسلة');
  assert.equal(rig.sim.invoices.size, 0, 'بقيت فاتورة بعد فشل الختم');
  assert.equal(rig.sim.units.get(Z5_UNIT)!.lastIcv, 5, 'تقدّمت السلسلة رغم الفشل');
  assert.equal(rig.published.length, 0, 'بُثّ تغيّر رغم أن شيئاً لم يُصدر');
});

test('المحرّك والمستند: مبالغ D6 المخزَّنة = مبالغ الـXML (فرق التقريب في subtotal لا في الإجمالي)', async () => {
  reset();
  const rig = buildRig();
  const r = await issue(rig, {
    customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Record<string, unknown>),
    body: invoiceBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 25.8, taxPct: 15 }] }),
  });
  assert.equal(r.status, 201);
  const data = r.body.data as Record<string, unknown>;
  const engine = computeInvoiceTotals([{ qty: 1, unitPrice: 25.8, discountPct: 0, taxPct: 15 }], { companyVat: COMPANY_VAT, decimals: 2, invoiceDiscountPct: 0, pricesIncludeTax: true });
  assert.equal(data.total, engine.total, 'السعر المعلن تغيّر');
  const snap = data.einvoiceSnapshot as { totals: { payable: string; taxTotal: string; taxExclusive: string; payableRounding?: string } };
  assert.equal(Number(snap.totals.payable), Number(data.total));
  assert.equal(Number(snap.totals.taxTotal), Number(data.taxAmt));
  assert.equal(Number(snap.totals.taxExclusive), Number(data.subtotal) - Number(data.discountAmt));
  assert.equal(snap.totals.payableRounding, '0.01', 'فرق التقريب (D6) غائب عن اللقطة');
});
