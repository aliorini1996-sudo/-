// «اشتراط اختيار فاتورة البيع للمرتجع» (قرار المالك ٣١ أكتوبر ٢٠٢٦) — القواعد النقيّة، ومسار الحفظ PUT /api/company/return-policy
// عبر موجّه الشركة الحقيقي، والإصدار عبر POST /invoices الحقيقي بمرحلتيه.
//
// لا قاعدة بيانات ولا شبكة: عميل Prisma مزيّف في ذاكرة الوحدات، ومصادقةٌ مزيّفة تضع المستخدم فقط — وحرّاس الدور والصلاحية
// والجلسة الحقيقية (middleware/auth) كما هي. والمرحلة الثانية بمخزن مستندات ومنصّة «فاتورة» مزيّفين (z5-submit). المطلوب إثباته:
//   ١) الافتراضي (null) سلوك اليوم حرفياً: المرحلة الأولى حرّ، والثانية 422 ZATCA_RETURN_NEEDS_ORIGINAL.
//   ٢) المرحلة الأولى والإعداد true: 422 RETURN_LINK_REQUIRED لكل مُصدِر قبل أيّ معاملة — إلا مستند صندوق المندوب المُنشأ قبل
//      التغيير (ضمن ٧ أيام)، والمفتاح لا يُتسامح معه أبداً.
//   ٣) المرحلة الثانية والإعداد false: إشعارٌ دائن 381 برقمٍ يدويّ (BT-25) وسبب (KSA-10) بلا أصلٍ في المنصّة، بعد رفض الرقم
//      الناقص أو الموجود في النظام، وقيد صلاحية المندوب، وسقف سعره.
//   ٤) الحفظ: لمدير الشركة وحده من القاعدة، بلا مفتاح API، والقيمة المساوية لافتراضيّ المرحلة null، وأثرٌ في سجلّ الفوترة.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';

import {
  RETURN_POLICY_REPLAY_MAX_AGE_MS, normalizeReturnPolicy, normalizeReturnRef, replayPredatesReturnPolicy, returnLinkRequired,
  returnPaymentTypeOf, returnPolicyOutcome, returnPolicyPhase2, returnRefProblem, storedReturnPolicy,
} from '../services/returnPolicy';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-return-policy';

// ═══ حقن البدائل قبل تحميل الموجّهات ═══

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

stub('config/database', { default: prismaFake });
// الحرّاس الحقيقية (requireAdmin وrequireAdminPermission وisOwnerSession وactorOf) — والمصادقة وحدها مزيّفة تضع المستخدم
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realAuth = require('../middleware/auth') as Record<string, unknown>;
type User = { id: string; role: string; tenantId: string; impersonated?: boolean; apiKeyId?: string };
let currentUser: User = { id: 'admin-1', role: 'ADMIN', tenantId: 'tenant-z5' };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { ...currentUser }; next(); },
  requireAccounting: pass,
});

let phase2Deps: unknown = null;
stub('routes/invoicesZatcaDeps', {
  productionPhase2Deps: () => {
    if (!phase2Deps) throw new Error('اعتماديات المرحلة الثانية غير مهيّأة لهذا الاختبار');
    return phase2Deps;
  },
});

/* eslint-disable @typescript-eslint/no-var-requires */
const invoicesRouter = require('../routes/invoices').default as express.Router;
const companyRouter = require('../routes/company').default as express.Router;
const { voidInvoiceInTx } = require('../services/invoiceVoid') as typeof import('../services/invoiceVoid');
/* eslint-enable @typescript-eslint/no-var-requires */

import { createSubmitHarness, type SubmitHarness } from '../compliance/zatca/__fixtures__/z5-submit';
import { FAKE_REPLIES } from '../compliance/zatca/__fixtures__/z5-fakezatca';
import { CUSTOMERS, PRODUCTS, Z5_TENANT } from '../compliance/zatca/__fixtures__/z5-sources';
import { submitDocument } from '../compliance/zatca/submit';
import { gunzipXml } from '../compliance/zatca/documentStore';
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
  app.use('/api/company', companyRouter);
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

async function call(method: 'POST' | 'GET' | 'PUT', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
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

// ═══ البيانات ═══

const PERMS = [
  'canAccessDashboard', 'canManageCustomers', 'canManageProducts', 'canManageSalesReps', 'canManageInvoices', 'canManageReceipts',
  'canViewReports', 'canManageVanStock', 'canManageTracking', 'canManageCompanySettings', 'canManageCompanyUsers', 'canManageDailyReport',
];
type Row = Record<string, unknown>;
const adminRow = (over: Row = {}): Row => ({
  id: 'admin-1', tenantId: Z5_TENANT, role: 'ADMIN', name: 'مدير', isActive: true, scopeEnabled: false, scopeMode: 'LISTS',
  ...Object.fromEntries(PERMS.map(p => [p, true])), ...over,
});
let admins: Map<string, Row> = new Map();

const PRODUCT_ROWS = PRODUCTS.map(p => ({
  id: p.id, name: p.name, unit: 'حبة', basePrice: 1000, taxPct: null, damagedReturnToStock: true, priceTiers: [],
  vatCategory: p.vatCategory ?? null, vatExemptionCode: p.vatExemptionCode ?? null, vatExemptionReason: p.vatExemptionReason ?? null,
}));

const CUSTOMER_ROW = (base: Record<string, unknown>) => ({
  ...base, status: 'ACTIVE', balance: 0, creditLimit: 0, totalSales: 0, tenantId: Z5_TENANT, phone: '0500000000',
});

const REP = (over: Row = {}): Row => ({
  id: 'rep-1', tenantId: Z5_TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: true, canSellBelowPrice: true, canSellWithoutStock: true, canCancelInvoice: true, maxDiscountPct: 100, ...over,
});

const num = (v: unknown): number => Number(v ?? 0);

// ─── منصّة المرحلة الثانية (مستندات في الذاكرة وفاتورة مزيّفة) ───

interface Rig {
  h: SubmitHarness;
  rows: Map<string, Row>;
  ledger: { kind: string; invoiceId: string; total: number }[];
  created: Row[];
}

function txAdapter(rig: Rig): Row {
  const invoice = {
    findFirst: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => rig.rows.get(where.id) ?? null,
    findMany: async () => [],
    create: async ({ data }: { data: Row }) => {
      const id = `note-${rig.created.length + 1}`;
      const nested = data.items as { create?: Row[] } | undefined;
      const row: Row = { ...data, id, status: 'CONFIRMED', items: nested?.create ?? [], customer: null };
      rig.rows.set(id, row);
      rig.created.push(row);
      rig.h.docs.invoices.set(id, {
        id, tenantId: String(data.tenantId), zatcaPhase: 2, einvoiceStatus: (data.einvoiceStatus as string) ?? null,
        einvoiceQr: (data.einvoiceQr as string) ?? null, einvoiceWarnings: null, einvoiceSubmittedAt: null,
      });
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = rig.rows.get(where.id);
      if (!row) return null;
      Object.assign(row, data);
      return row;
    },
  };
  return {
    invoice,
    notification: { create: async () => ({ id: 'n' }) },
    customer: { update: async () => ({}) },
    accountEntry: { create: async () => ({}), aggregate: async () => ({ _sum: { debit: 0, credit: 0 } }) },
  };
}

function buildRig(opts: Parameters<typeof createSubmitHarness>[0] = {}): Rig {
  const h = createSubmitHarness(opts);
  const rig: Rig = { h, rows: new Map(), ledger: [], created: [] };
  (h.deps as { onRejectedInTx?: unknown }).onRejectedInTx = async (_tx: unknown, info: {
    tenantId: string; invoiceId: string; documentId: string; subtype: '01' | '02'; errors: { code: string | null; message: string | null }[]; at: Date;
  }) => {
    await voidInvoiceInTx(txAdapter(rig) as never, {
      tenantId: info.tenantId, invoiceId: info.invoiceId, subtype: info.subtype, reason: 'REJECTED', documentId: info.documentId, errors: info.errors, at: info.at,
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
    publish: () => { /* لا بثّ */ },
    expireLinks: () => { /* لا روابط */ },
    now: () => h.clock.now(),
    env: {} as NodeJS.ProcessEnv,
    mutex: null,
    submitInline: (ref, o) => submitDocument(h.deps, ref, { inline: true, timeoutMs: o.timeoutMs }),
  };
  phase2Deps = deps;
  return rig;
}

/** القيم التي ترى بها الشركةُ الإعدادَ في صفّ إعداداتها */
interface Policy { stored?: boolean | null; changedAt?: Date | null }

interface ScriptOptions extends Policy {
  startedAt?: Date | null;
  customer?: Row;
  rep?: Row;
  products?: Row[];
  /** أرقام فواتير الشركة القائمة — لحارس «الرقم موجود في النظام» */
  numbers?: string[];
  rig?: Rig | null;
  /** «فك قيد الرقم الضريبي والعنوان الوطني» على صفّ البائع — غيابه = الإعدادات قبل الميزة */
  relaxed?: boolean;
}

function script(o: ScriptOptions = {}): void {
  const startedAt = o.startedAt === undefined ? LIVE_AT : o.startedAt;
  if (o.rig) {
    const seller = o.rig.h.units.settings.get(Z5_TENANT);
    if (seller) o.rig.h.units.settings.set(Z5_TENANT, { ...seller, zatcaPhase2StartedAt: startedAt, ...(o.relaxed !== undefined && { buyerVatAddressRelaxed: o.relaxed }) });
  }
  calls = [];
  const numbers = o.numbers ?? [];
  admins = new Map([['admin-1', adminRow()]]);
  scripted = {
    'invoice.findUnique': () => null,
    'invoice.findFirst': (args: unknown) => {
      const n = (args as { where?: { number?: { equals?: string; mode?: string } } }).where?.number;
      if (!n || typeof n.equals !== 'string') return null;
      const hit = numbers.find(x => (n.mode === 'insensitive' ? x.toLowerCase() === n.equals!.toLowerCase() : x === n.equals));
      return hit ? { id: `inv-${hit}` } : null;
    },
    'customer.findFirst': () => o.customer ?? CUSTOMER_ROW(CUSTOMERS.b2bComplete as unknown as Row),
    'salesRep.findFirst': () => o.rep ?? REP(),
    'product.findMany': (args: unknown) => {
      const ids: string[] = (args as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? [];
      return (o.products ?? PRODUCT_ROWS).filter(p => ids.includes(String(p.id)));
    },
    'companySettings.findUnique': () => ({
      defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: startedAt, zatcaGoLiveArmedAt: null,
      returnRequiresSaleInvoice: o.stored === undefined ? null : o.stored, returnPolicyChangedAt: o.changedAt ?? null,
    }),
    'zatcaEgsUnit.findMany': (args: unknown) => {
      if (!o.rig) return [];
      const env = (args as { where?: { environment?: string } }).where?.environment;
      const u = o.rig.h.units.units.get(o.rig.h.unitId);
      return env === 'production'
        ? [{ id: o.rig.h.unitId, tenantId: Z5_TENANT, environment: u?.environment, status: u?.status, keyVersion: u?.keyVersion, vatNumber: u?.vatNumber, certNotAfter: new Date('2031-01-01T00:00:00Z'), lastIcv: 0, lastInvoiceHash: null }]
        : [];
    },
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: false, invoiceSignatureEnabled: false }),
    'admin.findUnique': (args: unknown) => admins.get(String((args as { where?: { id?: string } }).where?.id)) ?? null,
    'invoice.create': (args: unknown) => ({ id: 'legacy-1', ...((args as { data?: Row }).data ?? {}), items: [], customer: null }),
    'accountEntry.aggregate': () => ({ _sum: { debit: 0, credit: 0 } }),
  };
}

const returnBody = (over: Row = {}): Row => ({
  customerId: 'c-b2b',
  salesRepId: 'rep-1',
  type: 'RETURN',
  pricesIncludeTax: false,
  discountPct: 0,
  items: [{ productId: 'p-rice', qty: 2, unitPrice: 45.5, discountPct: 0, taxPct: 15 }],
  clientRef: crypto.randomUUID(),
  ...over,
});

function asAdmin(): void { currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT }; }
function asRep(): void { currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: Z5_TENANT }; }

// ═══ (١) القواعد النقيّة ═══

test('القاعدة الفعّالة: null افتراضيّ المرحلة حرفياً، والصريح يغلب، والحفظ المساوي للافتراضي null', () => {
  assert.equal(returnLinkRequired(null, false), false);
  assert.equal(returnLinkRequired(null, true), true);
  assert.equal(returnLinkRequired(undefined, true), true, 'صفٌّ قديم بلا عمود = الافتراضي');
  assert.equal(returnLinkRequired(true, false), true);
  assert.equal(returnLinkRequired(false, true), false);
  assert.equal(returnLinkRequired('yes', false), false, 'قيمةٌ غير منطقية = الافتراضي');
  assert.equal(storedReturnPolicy(0), null);
  // لا تحمل شركةٌ «لا» من المرحلة الأولى إلى الثانية يوم الانطلاق
  assert.equal(normalizeReturnPolicy(false, false), null);
  assert.equal(normalizeReturnPolicy(true, false), true);
  assert.equal(normalizeReturnPolicy(true, true), null);
  assert.equal(normalizeReturnPolicy(false, true), false);
  assert.equal(normalizeReturnPolicy(null, true), null);
  assert.deepEqual([true, false, null].map(v => returnPolicyOutcome(v)), ['REQUIRED', 'OPTIONAL', 'DEFAULT']);
});

test('افتراضيّ المرحلة كما يقرّره الإصدار: المفعّلة حيّاً، أو البروفة بالعلم والسعودية والهيئة — والعلم وحده مرحلة أولى', () => {
  assert.equal(returnPolicyPhase2({ candidate: 'live', tenantFlag: false, countryCode: 'EG', einvoiceProvider: 'eta' }), true);
  assert.equal(returnPolicyPhase2({ candidate: 'rehearsal-candidate', tenantFlag: true, countryCode: 'SA', einvoiceProvider: 'zatca' }), true);
  assert.equal(returnPolicyPhase2({ candidate: 'rehearsal-candidate', tenantFlag: false, countryCode: 'SA', einvoiceProvider: 'zatca' }), false);
  assert.equal(returnPolicyPhase2({ candidate: 'rehearsal-candidate', tenantFlag: true, countryCode: 'AE', einvoiceProvider: 'zatca' }), false);
  assert.equal(returnPolicyPhase2({ candidate: 'phase1', tenantFlag: true, countryCode: 'SA', einvoiceProvider: 'zatca' }), false);
});

test('الرقم اليدويّ: سطرٌ واحد بلا محارف تحكّم أو اتجاه، من ٣ إلى ٦٠ وفيه رقم — مرآة الواجهة', () => {
  assert.equal(normalizeReturnRef('  INV‏-‪2024‬-17\t\n  '), 'INV-2024-17');
  assert.equal(normalizeReturnRef('A  B\u0000C'), 'A B C');
  assert.equal(normalizeReturnRef(null), '');
  assert.equal(returnRefProblem('INV-1'), null);
  // الأرقام العربية الهندية والفارسية تُطبَّع لاتينية (لوحة مفاتيح المندوب العربية) — فتُقبل ويُطابَق بها ويُبلَّغ
  assert.equal(normalizeReturnRef('فاتورة ١٢٣٤'), 'فاتورة 1234');
  assert.equal(normalizeReturnRef('۴۵۶'), '456');
  assert.equal(returnRefProblem('١٢٣٤'), null);
  const web = fs.readFileSync(path.join(SRC, '..', '..', 'web-admin', 'src', 'lib', 'returnPolicy.ts'), 'utf8');
  assert.ok(/\[(?:\\u0660|٠)-(?:\\u0669|٩)\]/.test(web) && /\[(?:\\u06f0|۰)-(?:\\u06f9|۹)\]/.test(web), 'مرآة الواجهة لا تطبّع الأرقام العربية');
  for (const bad of ['', '-', 'لا يوجد', '12', 'X'.repeat(59) + '1' + 'Y', '   ']) assert.ok(returnRefProblem(bad), `قُبل: ${JSON.stringify(bad)}`);
  assert.equal(returnRefProblem('1'.repeat(60)), null);
  // المرآة حرفياً: الرسالة وتعبير التطبيع في الواجهة هما هذان (web أعلاه)
  assert.ok(web.includes(`'${returnRefProblem('')}'`), 'رسالة الرفض تخالف مرآة الواجهة');
  assert.ok(web.includes('RETURN_REF_MIN = 3') && web.includes('RETURN_REF_MAX = 60'));
  assert.equal(returnPaymentTypeOf('CASH'), 'CASH');
  assert.equal(returnPaymentTypeOf('INSTALLMENT'), null, 'لا افتراضيّ صامت ولا تقسيط لأصلٍ مجهول');
  assert.equal(returnPaymentTypeOf(undefined), null);
});

test('تسامح الصندوق: مستند الجهاز قبل التغيير يُقبل ضمن ٧ أيام، والمفتاح وغير الإعادة واللحظة التالفة لا', () => {
  const now = new Date('2026-12-10T10:00:00Z');
  const changedAt = new Date('2026-12-10T08:00:00Z');
  const base = { replay: true, viaApiKey: false, deviceAt: '2026-12-10T07:00:00Z', changedAt, now };
  assert.equal(replayPredatesReturnPolicy(base), true);
  assert.equal(replayPredatesReturnPolicy({ ...base, deviceAt: '2026-12-10T09:00:00Z' }), false, 'بعد التغيير');
  assert.equal(replayPredatesReturnPolicy({ ...base, replay: false }), false, 'الطلب الحيّ');
  assert.equal(replayPredatesReturnPolicy({ ...base, viaApiKey: true }), false, 'المفتاح عميلٌ حيّ');
  assert.equal(replayPredatesReturnPolicy({ ...base, deviceAt: 'not-a-date' }), false);
  assert.equal(replayPredatesReturnPolicy({ ...base, deviceAt: undefined }), false);
  assert.equal(replayPredatesReturnPolicy({ ...base, changedAt: null }), false, 'لا تغيير مسجَّل');
  // تغييرٌ أقدم من النافذة: لحظة الجهاز المحصورة بعده دائماً — لا تسامح بساعةٍ مرجوعة
  const old = new Date(now.getTime() - RETURN_POLICY_REPLAY_MAX_AGE_MS - 60_000);
  assert.equal(replayPredatesReturnPolicy({ ...base, changedAt: old, deviceAt: '2020-01-01T00:00:00Z' }), false);
  const recent = new Date(now.getTime() - RETURN_POLICY_REPLAY_MAX_AGE_MS + 60 * 60_000);
  assert.equal(replayPredatesReturnPolicy({ ...base, changedAt: recent, deviceAt: '2020-01-01T00:00:00Z' }), true);
});

// ═══ (٢) الحفظ: PUT /api/company/return-policy ═══

interface SaveScript { settings?: Row | null; flag?: boolean; updateCount?: number }
interface SaveLog { updates: Row[]; logs: Row[] }

function scriptSave(o: SaveScript = {}): SaveLog {
  const log: SaveLog = { updates: [], logs: [] };
  calls = [];
  admins = new Map([['admin-1', adminRow()]]);
  const settings = o.settings === undefined
    ? { countryCode: 'SA', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, returnRequiresSaleInvoice: null, returnPolicyChangedAt: null }
    : o.settings;
  scripted = {
    'admin.findUnique': (args: unknown) => admins.get(String((args as { where?: { id?: string } }).where?.id)) ?? null,
    'companySettings.findUnique': () => settings,
    'tenant.findUnique': () => ({ zatcaPhase2Enabled: o.flag === true }),
    'companySettings.updateMany': (args: unknown) => { log.updates.push(args as Row); return { count: o.updateCount ?? 1 }; },
    'zatcaApiLog.create': (args: unknown) => { log.logs.push((args as { data: Row }).data); return { id: 'log-1' }; },
  };
  return log;
}

const put = (body: unknown) => call('PUT', '/api/company/return-policy', { body });

test('الحفظ: موصولٌ تحت /api/company بعد المصادقة وقبل GET، وPUT /api/company وcompanySchema لا يعرفانه', () => {
  const s = fs.readFileSync(path.join(SRC, 'routes', 'company.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(s.includes("import returnPolicyRouter from './returnPolicy';"));
  const mount = s.indexOf("router.use('/return-policy', returnPolicyRouter);");
  assert.ok(mount > s.indexOf('router.use(authenticate);'), 'التركيب قبل المصادقة');
  assert.ok(mount > s.indexOf("router.use('/print-texts', printTextsRouter);"), 'التركيب بجوار نصوص المطبوعات');
  assert.ok(mount < s.indexOf("router.get('/',"), 'التركيب بعد GET / — يبتلعه مسار الشركة');
  const schema = s.slice(s.indexOf('const companySchema = z.object({'), s.indexOf('});', s.indexOf('const companySchema = z.object({')));
  assert.doesNotMatch(schema, /returnRequiresSaleInvoice|returnPolicy/, 'الحفظ العام يمحو الإعداد');
  assert.doesNotMatch(s.slice(s.indexOf("router.put('/'")), /return-policy|returnRequiresSaleInvoice/);
  const r = fs.readFileSync(path.join(SRC, 'routes', 'returnPolicy.ts'), 'utf8');
  assert.doesNotMatch(r, /\.upsert\(/, 'الحفظ يُنشئ صفّ شركة');
  assert.doesNotMatch(r, /router\.(get|post|patch|delete)\(/, 'مسارٌ غير الحفظ');
});

test('الحفظ: مفتاح API يُرفض 403 API_KEY_FORBIDDEN، والمندوب «غير مسموح»، بلا كتابة', async () => {
  const log = scriptSave();
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT, apiKeyId: 'k1' };
  const k = await put({ requireSaleInvoice: true });
  assert.equal(k.status, 403);
  assert.equal(k.body.code, 'API_KEY_FORBIDDEN');
  asRep();
  const rep = await put({ requireSaleInvoice: true });
  assert.equal(rep.status, 403);
  assert.deepEqual(log.updates, []);
  asAdmin();
});

test('الحفظ: الدور من القاعدة — مشرفٌ بصلاحية الإعدادات، ومديرٌ معطّل أو من شركة أخرى أو مقيّد النطاق، كلّهم 403', async () => {
  const cases: Array<[string, User, Row]> = [
    ['مشرف', { id: 'm-1', role: 'MANAGER', tenantId: Z5_TENANT }, adminRow({ id: 'm-1', role: 'MANAGER' })],
    ['توكن مدير ودوره اليوم مشرف', { id: 'm-2', role: 'ADMIN', tenantId: Z5_TENANT }, adminRow({ id: 'm-2', role: 'MANAGER' })],
    ['مقيّد النطاق', { id: 'a-2', role: 'ADMIN', tenantId: Z5_TENANT }, adminRow({ id: 'a-2', scopeEnabled: true })],
    ['شركة أخرى', { id: 'a-3', role: 'ADMIN', tenantId: Z5_TENANT }, adminRow({ id: 'a-3', tenantId: 'other' })],
  ];
  for (const [label, user, row] of cases) {
    const log = scriptSave();
    admins.set(user.id, row);
    currentUser = user;
    const r = await put({ requireSaleInvoice: true });
    assert.equal(r.status, 403, label);
    assert.equal(r.body.code, 'RETURN_POLICY_ADMIN_ONLY', label);
    assert.deepEqual(log.updates, [], label);
  }
  // صلاحية «إعدادات الشركة» مسحوبة: حارسها قبل المعالج
  const log = scriptSave();
  admins.set('admin-1', adminRow({ canManageCompanySettings: false }));
  asAdmin();
  const denied = await put({ requireSaleInvoice: true });
  assert.equal(denied.status, 403);
  assert.deepEqual(log.updates, []);
});

test('الحفظ: الجسم صارم — قيمةٌ غير منطقية أو حقلٌ زائد أو غائب ⇒ 400 بلا كتابة', async () => {
  asAdmin();
  for (const body of [{ requireSaleInvoice: 'yes' }, { requireSaleInvoice: true, extra: 1 }, {}, { requireSaleInvoice: 1 }]) {
    const log = scriptSave();
    const r = await put(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'RETURN_POLICY_INVALID');
    assert.deepEqual(log.updates, []);
  }
});

test('الحفظ في المرحلة الأولى: true يُحفظ صريحاً، وfalse (الافتراضي) يُحفظ null — بلا سجلّ فوترة لشركةٍ لا تستعملها', async () => {
  asAdmin();
  let log = scriptSave();
  const on = await put({ requireSaleInvoice: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const data = on.body.data as Row;
  assert.deepEqual({ ...data, changedAt: typeof data.changedAt }, { requireSaleInvoice: true, effective: true, phaseDefault: false, changedAt: 'string' });
  assert.equal(log.updates.length, 1);
  const w = log.updates[0] as { where: Row; data: Row };
  assert.deepEqual(w.where, { tenantId: Z5_TENANT });
  assert.equal(w.data.returnRequiresSaleInvoice, true);
  assert.ok(w.data.returnPolicyChangedAt instanceof Date);
  assert.equal(w.data.returnPolicyChangedBy, 'admin-1');
  assert.deepEqual(log.logs, [], 'سجلّ فوترةٍ لشركةٍ بلا ZATCA');

  log = scriptSave({ settings: { countryCode: 'SA', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, returnRequiresSaleInvoice: true, returnPolicyChangedAt: new Date('2026-10-01T00:00:00Z') } });
  const off = await put({ requireSaleInvoice: false });
  assert.equal(off.status, 200);
  assert.deepEqual({ ...(off.body.data as Row), changedAt: null }, { requireSaleInvoice: null, effective: false, phaseDefault: false, changedAt: null });
  assert.equal((log.updates[0] as { data: Row }).data.returnRequiresSaleInvoice, null, 'false في المرحلة الأولى لا يُحفظ صريحاً');
});

test('الحفظ بلا تغيير: لا كتابة، ولحظة التغيير كما هي (لا تمدّ تسامح الصندوق)', async () => {
  asAdmin();
  const at = new Date('2026-10-05T00:00:00Z');
  const log = scriptSave({ settings: { countryCode: 'SA', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, returnRequiresSaleInvoice: true, returnPolicyChangedAt: at } });
  const r = await put({ requireSaleInvoice: true });
  assert.equal(r.status, 200);
  assert.equal((r.body.data as Row).changedAt, at.toISOString());
  assert.deepEqual(log.updates, []);
  assert.ok(!calls.includes('$transaction'));
});

test('الحفظ في المرحلة الثانية: false صريح بسجلّ OPTIONAL في المعاملة نفسها، وtrue = null، والاستعادة DEFAULT', async () => {
  asAdmin();
  const live = { countryCode: 'SA', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: LIVE_AT, returnRequiresSaleInvoice: null, returnPolicyChangedAt: null };
  let log = scriptSave({ settings: live });
  const off = await put({ requireSaleInvoice: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual({ ...(off.body.data as Row), changedAt: null }, { requireSaleInvoice: false, effective: false, phaseDefault: true, changedAt: null });
  assert.equal(log.logs.length, 1);
  assert.deepEqual(
    { tenantId: log.logs[0].tenantId, actorId: log.logs[0].actorId, endpoint: log.logs[0].endpoint, outcome: log.logs[0].outcome },
    { tenantId: Z5_TENANT, actorId: 'admin-1', endpoint: 'ui:return-policy', outcome: 'OPTIONAL' },
  );
  const tx = calls.indexOf('$transaction');
  assert.ok(tx >= 0 && calls.indexOf('companySettings.updateMany') > tx && calls.indexOf('zatcaApiLog.create') > calls.indexOf('companySettings.updateMany'), 'السجلّ خارج معاملة الكتابة');

  log = scriptSave({ settings: { ...live, returnRequiresSaleInvoice: false } });
  const on = await put({ requireSaleInvoice: true });
  assert.equal((on.body.data as Row).requireSaleInvoice, null, 'true في المرحلة الثانية هو الافتراضي');
  assert.equal((on.body.data as Row).effective, true);
  assert.equal(log.logs[0].outcome, 'DEFAULT');

  log = scriptSave({ settings: { ...live, returnRequiresSaleInvoice: false } });
  const reset = await put({ requireSaleInvoice: null });
  assert.equal((reset.body.data as Row).requireSaleInvoice, null);
  assert.equal(log.logs[0].outcome, 'DEFAULT');
});

test('الحفظ: علم المالك وحده (لا انطلاق ولا بروفة) مرحلة أولى — true يسري الآن، والسجلّ يُكتب لشركة الفوترة', async () => {
  asAdmin();
  const log = scriptSave({ flag: true });
  const r = await put({ requireSaleInvoice: true });
  assert.deepEqual({ ...(r.body.data as Row), changedAt: null }, { requireSaleInvoice: true, effective: true, phaseDefault: false, changedAt: null });
  assert.equal(log.logs[0]?.outcome, 'REQUIRED');
  // وشركة البروفة (قائمة البيئة + العلم) مرحلة ثانية: false صريح
  process.env.ZATCA_REHEARSAL_TENANT_IDS = Z5_TENANT;
  try {
    const log2 = scriptSave({ flag: true });
    const r2 = await put({ requireSaleInvoice: false });
    assert.deepEqual({ ...(r2.body.data as Row), changedAt: null }, { requireSaleInvoice: false, effective: false, phaseDefault: true, changedAt: null });
    assert.equal(log2.logs[0]?.outcome, 'OPTIONAL');
  } finally {
    delete process.env.ZATCA_REHEARSAL_TENANT_IDS;
  }
});

test('الحفظ بجلسة المالك: يتجاوز الدور والنطاق، ويُسجَّل OWNER: وowner-impersonation: وسطر تدقيق الجلسة', async () => {
  const log = scriptSave({ settings: { countryCode: 'SA', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: LIVE_AT, returnRequiresSaleInvoice: null, returnPolicyChangedAt: null } });
  admins.set('admin-1', adminRow({ scopeEnabled: true, role: 'MANAGER' }));
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT, impersonated: true };
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (l: unknown) => { lines.push(String(l)); };
  try {
    const r = await put({ requireSaleInvoice: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await new Promise(res => setTimeout(res, 20));
  } finally {
    console.warn = warn;
    asAdmin();
  }
  assert.equal((log.updates[0] as { data: Row }).data.returnPolicyChangedBy, 'OWNER:admin-1');
  assert.equal(log.logs[0].actorId, 'owner-impersonation:admin-1');
  const audit = lines.map(l => { try { return JSON.parse(l) as Row; } catch { return null; } }).find(x => x?.action === 'company.return-policy');
  assert.ok(audit, `لا سطر تدقيق: ${lines.join('\n')}`);
  assert.equal(audit!.status, 200);
  assert.equal(audit!.tenantId, Z5_TENANT);
});

test('الحفظ بلا صفّ إعدادات ⇒ 409 COMPANY_SETTINGS_MISSING بلا إنشاء، وكذلك صفٌّ حُذف بين القراءة والكتابة', async () => {
  asAdmin();
  let log = scriptSave({ settings: null });
  const r = await put({ requireSaleInvoice: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'COMPANY_SETTINGS_MISSING');
  assert.deepEqual(log.updates, []);
  log = scriptSave({ updateCount: 0, flag: true });
  const gone = await put({ requireSaleInvoice: true });
  assert.equal(gone.status, 409);
  assert.deepEqual(log.logs, [], 'سجلّ لكتابةٍ لم تقع');
});

// ═══ (٣) المرحلة الأولى: POST /invoices ═══

const phase1Body = (over: Row = {}) => returnBody({ customerId: 'c-walkin', items: [{ productId: 'p-water', qty: 1, unitPrice: 5, discountPct: 0, taxPct: 15 }], ...over });

test('المرحلة الأولى الافتراضية (null) وfalse: المرتجع الحرّ 201 كما اليوم', async () => {
  for (const stored of [null, false, undefined]) {
    asAdmin();
    script({ startedAt: null, stored, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null });
    const r = await call('POST', '/api/invoices', { body: phase1Body() });
    assert.equal(r.status, 201, `${String(stored)}: ${JSON.stringify(r.body)}`);
  }
});

test('المرحلة الأولى والإعداد true: 422 RETURN_LINK_REQUIRED لكل مُصدِر قبل أيّ معاملة — والمندوب بأصناف الصلاحية يبقى على رمزه', async () => {
  for (const who of [asAdmin, asRep]) {
    who();
    script({ startedAt: null, stored: true, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null });
    const r = await call('POST', '/api/invoices', { body: phase1Body() });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'RETURN_LINK_REQUIRED');
    assert.equal(r.body.message, 'الشركة تشترط اختيار فاتورة البيع للمرتجع — اختر الفاتورة أولا');
    assert.ok(!calls.includes('$transaction'), 'فُتحت معاملة رغم الرفض');
  }
  // قيد صلاحية المندوب كما هو (يسبق الإعداد)
  asRep();
  script({
    startedAt: null, stored: true, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null,
    products: PRODUCT_ROWS.map(p => ({ ...p, shelfLifeEnabled: true, shelfLifeValue: 12, shelfLifeUnit: 'MONTH' })),
  });
  const shelf = await call('POST', '/api/invoices', { body: phase1Body() });
  assert.equal(shelf.body.code, 'RETURN_NEEDS_SALE_INVOICE');
  // البيع لا يمسّه الإعداد
  asAdmin();
  script({ startedAt: null, stored: true, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null });
  const sale = await call('POST', '/api/invoices', { body: phase1Body({ type: 'CASH' }) });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
});

test('المرحلة الأولى والإعداد true: صندوق المندوب المُنشأ قبل التغيير يُقبل، وبعده يُرفض، والمفتاح لا يُتسامح معه أبداً', async () => {
  const changedAt = new Date(Date.now() - 60 * 60_000);
  const before = new Date(changedAt.getTime() - 10 * 60_000).toISOString();
  const afterIt = new Date(changedAt.getTime() + 10 * 60_000).toISOString();
  const replay = { 'X-FS-Replay': '1' };

  asRep();
  script({ startedAt: null, stored: true, changedAt, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null });
  const ok = await call('POST', '/api/invoices', { body: phase1Body({ clientCreatedAt: before }), headers: replay });
  assert.equal(ok.status, 201, `مستندٌ سُلّمت ورقته قبل التغيير أُعدم في الصندوق: ${JSON.stringify(ok.body)}`);

  script({ startedAt: null, stored: true, changedAt, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null });
  const late = await call('POST', '/api/invoices', { body: phase1Body({ clientCreatedAt: afterIt }), headers: replay });
  assert.equal(late.body.code, 'RETURN_LINK_REQUIRED');

  script({ startedAt: null, stored: true, changedAt, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null });
  const live = await call('POST', '/api/invoices', { body: phase1Body({ clientCreatedAt: before }) });
  assert.equal(live.body.code, 'RETURN_LINK_REQUIRED', 'الطلب الحيّ نال تسامح الصندوق');

  // المفتاح: ترويسته تُمحى في المصادقة الحقيقية — وحتى لو وصلت، لحظته لا تُقرأ والتسامح لا يناله
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: Z5_TENANT, apiKeyId: 'k1' };
  script({ startedAt: null, stored: true, changedAt, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row), rig: null });
  const key = await call('POST', '/api/invoices', { body: phase1Body({ clientCreatedAt: before }), headers: replay });
  assert.equal(key.body.code, 'RETURN_LINK_REQUIRED', 'المفتاح نال تسامح الصندوق');
  asAdmin();
});

// ═══ (٤) المرحلة الثانية ═══

test('المرحلة الثانية الافتراضية (null) أو true: المرتجع بلا أصل 422 ZATCA_RETURN_NEEDS_ORIGINAL ولو حمل رقماً يدوياً', async () => {
  for (const stored of [null, true]) {
    asAdmin();
    const rig = buildRig();
    script({ rig, stored });
    const r = await call('POST', '/api/invoices', {
      body: returnBody({ originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'بضاعة تالفة' }), headers: CAPS,
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'ZATCA_RETURN_NEEDS_ORIGINAL');
    assert.equal(rig.created.length, 0);
    assert.equal(rig.h.docs.documents.size, 0);
    assert.ok(!calls.some(c => c === 'invoice.findFirst'), 'سُئل عن الرقم اليدويّ والإعداد مشترط');
  }
});

test('المرحلة الثانية والإعداد false: الرقم الناقص أو بلا رقم أو بلا طريقة دفع أو بلا سبب ⇒ 422 قبل أيّ مستند', async () => {
  asAdmin();
  const cases: Array<[Row, string, string | null]> = [
    [{ originalPaymentType: 'CASH', noteReason: 'بضاعة تالفة' }, 'ZATCA_RETURN_REF_INVALID', 'REFERENCE'],
    [{ originalInvoiceRef: ' - ', originalPaymentType: 'CASH', noteReason: 'بضاعة تالفة' }, 'ZATCA_RETURN_REF_INVALID', 'REFERENCE'],
    [{ originalInvoiceRef: 'لا يوجد', originalPaymentType: 'CASH', noteReason: 'بضاعة تالفة' }, 'ZATCA_RETURN_REF_INVALID', 'REFERENCE'],
    [{ originalInvoiceRef: 'OLD-1001', noteReason: 'بضاعة تالفة' }, 'ZATCA_RETURN_REF_INVALID', 'PAYMENT_TYPE'],
    [{ originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH' }, 'ZATCA_NOTE_LINES_INVALID', null],
    [{ originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: ' ا ' }, 'ZATCA_NOTE_LINES_INVALID', null],
  ];
  for (const [extra, code, reason] of cases) {
    const rig = buildRig();
    script({ rig, stored: false });
    const r = await call('POST', '/api/invoices', { body: returnBody(extra), headers: CAPS });
    assert.equal(r.status, 422, `${JSON.stringify(extra)}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code, JSON.stringify(extra));
    if (reason) assert.equal(r.body.reason, reason);
    assert.equal(rig.created.length, 0);
    assert.equal(rig.h.docs.documents.size, 0, 'استُهلك ICV رغم الرفض');
  }
  // طريقة دفعٍ غير معروفة: المخطّط صارم
  const rig = buildRig();
  script({ rig, stored: false });
  const bad = await call('POST', '/api/invoices', { body: returnBody({ originalInvoiceRef: 'OLD-1001', originalPaymentType: 'INSTALLMENT', noteReason: 'بضاعة تالفة' }), headers: CAPS });
  assert.notEqual(bad.status, 201, 'طريقة دفع غير معروفة قُبلت');
  assert.equal(rig.created.length, 0);
});

test('المرحلة الثانية والإعداد false: رقمٌ يطابق فاتورةً في النظام (بلا حساسية حالة وبعد التطبيع) ⇒ 409 ZATCA_RETURN_REF_IN_SYSTEM', async () => {
  asAdmin();
  const rig = buildRig();
  script({ rig, stored: false, numbers: ['INV-2611-000009'] });
  const r = await call('POST', '/api/invoices', {
    body: returnBody({ originalInvoiceRef: '  inv-2611-000009 ', originalPaymentType: 'CREDIT', noteReason: 'بضاعة تالفة' }), headers: CAPS,
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'ZATCA_RETURN_REF_IN_SYSTEM');
  assert.equal(r.body.message, 'هذه الفاتورة موجودة في النظام — اخترها من قائمة فواتير العميل');
  assert.equal(rig.created.length, 0);
  assert.equal(rig.h.docs.documents.size, 0);
});

test('المرحلة الثانية والإعداد false: المندوب بأصناف الصلاحية ⇒ RETURN_NEEDS_SALE_INVOICE، وبلا «تغيير السعر» فوق سعر الصنف ⇒ 403', async () => {
  asRep();
  try {
    let rig = buildRig();
    script({
      rig, stored: false, rep: REP(),
      products: PRODUCT_ROWS.map(p => ({ ...p, shelfLifeEnabled: true, shelfLifeValue: 12, shelfLifeUnit: 'MONTH' })),
    });
    const shelf = await call('POST', '/api/invoices', {
      body: returnBody({ originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'بضاعة تالفة' }), headers: CAPS,
    });
    assert.equal(shelf.status, 422, JSON.stringify(shelf.body));
    assert.equal(shelf.body.code, 'RETURN_NEEDS_SALE_INVOICE');
    assert.equal(rig.created.length, 0);

    rig = buildRig();
    script({ rig, stored: false, rep: REP({ canChangePrice: false }) });
    const pricey = await call('POST', '/api/invoices', {
      body: returnBody({
        originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'بضاعة تالفة',
        items: [{ productId: 'p-rice', qty: 1, unitPrice: 1500, discountPct: 0, taxPct: 15 }],
      }),
      headers: CAPS,
    });
    assert.equal(pricey.status, 403, JSON.stringify(pricey.body));
    assert.equal(pricey.body.message, 'لا تملك صلاحية تغيير سعر البيع');
    assert.equal(rig.created.length, 0);
    assert.equal(rig.h.docs.documents.size, 0);

    // وبسعر الصنف أو دونه يمرّ (الشامل يُردّ إلى الصافي كحارس البيع)
    rig = buildRig();
    script({ rig, stored: false, rep: REP({ canChangePrice: false }), customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row) });
    const fine = await call('POST', '/api/invoices', {
      body: returnBody({
        customerId: 'c-walkin', originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'بضاعة تالفة', pricesIncludeTax: true,
        items: [{ productId: 'p-rice', qty: 1, unitPrice: 1150, discountPct: 0, taxPct: 15 }],
      }),
      headers: CAPS,
    });
    assert.equal(fine.status, 201, JSON.stringify(fine.body));
    assert.equal((fine.body.data as Row).salesRepId, 'rep-1');
  } finally {
    asAdmin();
  }
});

test('المرحلة الثانية والإعداد false: إشعار دائن 381 قياسيّ معتمد برقمٍ يدويّ — BT-25 وKSA-10 بلا أصل في المنصّة، وقيد مرتجع', async () => {
  asAdmin();
  const rig = buildRig();
  script({ rig, stored: false });
  const r = await call('POST', '/api/invoices', {
    body: returnBody({ originalInvoiceRef: ' OLD‏-1001 ', originalPaymentType: 'CREDIT', noteReason: '  بضاعة تالفة من فاتورة النظام السابق ', returnReason: 'DAMAGED' }),
    headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const note = r.body.data as Row;
  const e = note.einvoice as Row;
  assert.equal(e.typeCode, '381', 'ليس إشعاراً دائناً');
  assert.equal(e.documentKind, 'CREDIT_NOTE');
  assert.equal(e.subtype, '01', 'النوع الفرعي من تصنيف العميل الحيّ');
  assert.equal(e.status, 'cleared');
  assert.equal(note.type, 'RETURN');
  assert.equal(note.documentKind, 'CREDIT_NOTE');
  assert.equal(note.originalInvoiceId, null, 'رابطٌ بأصلٍ لا وجود له');
  assert.equal(note.billingReference, 'OLD-1001', 'BT-25 ليس الرقم المطبَّع');
  assert.equal(note.noteReason, 'بضاعة تالفة من فاتورة النظام السابق');
  assert.equal(note.returnReason, 'DAMAGED');
  assert.equal(note.returnToStock, true, 'التالف يعود لمخزون السيارة بسياسة أصنافه');
  assert.equal(note.zatcaPhase, 2);
  assert.ok(String(note.number).startsWith('RET-'), `رقم الإشعار بلا بادئة مرتجع: ${String(note.number)}`);
  assert.equal(num(note.paidAmt), 0);
  assert.equal(num(note.remainingAmt), 0, 'الإشعار يحمل مديونية');
  const items = note.items as Row[];
  assert.equal(items.length, 1);
  assert.equal(items[0].productId, 'p-rice');
  assert.equal(num(items[0].unitPrice), 45.5, 'السعر من الطلب');
  assert.equal(items[0].creditedItemId ?? null, null);
  assert.deepEqual(rig.ledger.map(l => [l.kind, Math.round(l.total * 100) / 100]), [['RETURN', Math.round(num(note.total) * 100) / 100]]);
  // المستند نفسه: 381 بمرجعه وسببه وطريقة دفع الأصل
  const docs = [...rig.h.docs.documents.values()];
  assert.equal(docs.length, 1);
  assert.equal(docs[0].typeCode, '381');
  const xml = gunzipXml(docs[0].xmlGz);
  assert.match(xml, /<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>OLD-1001<\/cbc:ID>/, 'BT-25 غائب عن الـXML');
  assert.match(xml, /<cbc:InstructionNote>بضاعة تالفة من فاتورة النظام السابق<\/cbc:InstructionNote>/, 'KSA-10 غائب');
  assert.match(xml, /<cbc:PaymentMeansCode>30<\/cbc:PaymentMeansCode>/, 'طريقة دفع الأصل الآجلة');
  assert.equal(rig.h.fake.violations.length, 0, `مخالفات ترويسة: ${rig.h.fake.violations.join(', ')}`);
});

test('المرحلة الثانية والإعداد false: المبسّط يُختم ويُبلَّغ لاحقاً، والقياسيّ المرفوض يُبطل بلا أصلٍ يُردّ', async () => {
  asAdmin();
  const rig = buildRig();
  script({ rig, stored: false, customer: CUSTOMER_ROW(CUSTOMERS.individual as unknown as Row) });
  const r = await call('POST', '/api/invoices', {
    body: returnBody({ customerId: 'c-walkin', originalInvoiceRef: 'OLD-77', originalPaymentType: 'CASH', noteReason: 'إرجاع' }), headers: CAPS,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = (r.body.data as Row).einvoice as Row;
  assert.equal(e.subtype, '02');
  assert.equal(e.documentStatus, 'SIGNED', 'المبسّط انتظر الهيئة في الطلب الحيّ');
  assert.equal(rig.h.fake.calls.length, 0);

  const rejecting = buildRig({ fake: { onClear: () => FAKE_REPLIES.reject400('BR-KSA-56', 'مرجع غير صحيح') } });
  script({ rig: rejecting, stored: false });
  const rej = await call('POST', '/api/invoices', {
    body: returnBody({ originalInvoiceRef: 'OLD-78', originalPaymentType: 'CASH', noteReason: 'إرجاع' }), headers: CAPS,
  });
  assert.equal(rej.status, 422, JSON.stringify(rej.body));
  assert.equal(rej.body.code, 'ZATCA_REJECTED');
  assert.equal(rejecting.rows.get('note-1')!.status, 'CANCELLED');
});

test('المرحلة الثانية والإعداد false مع فكّ قيد بيانات المشتري: منشأةٌ ناقصة ⇒ إشعار يدويّ مبسّط بإعلامٍ وسطر تدقيق — ومطفأً 422 بالرسالة العامة', async t => {
  asAdmin();
  const warn = t.mock.method(console, 'warn', () => undefined);
  const incomplete = CUSTOMER_ROW(CUSTOMERS.b2bIncomplete as unknown as Row);
  const body = () => returnBody({ customerId: 'c-b2b-inc', originalInvoiceRef: 'OLD-501', originalPaymentType: 'CASH', noteReason: 'إرجاع من فاتورة النظام السابق' });
  const rig = buildRig();
  script({ rig, stored: false, relaxed: true, customer: incomplete });
  const r = await call('POST', '/api/invoices', { body: body(), headers: CAPS });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const note = r.body.data as Row;
  const e = note.einvoice as Row;
  // كالإشعار على أصلٍ من المرحلة الأولى والفاتورة نفسها: لا «يتبع نوع فاتورته الأصلية» ولا أصل في المنصّة
  assert.deepEqual([e.typeCode, e.documentKind, e.subtype], ['381', 'CREDIT_NOTE', '02']);
  assert.equal(note.billingReference, 'OLD-501');
  const notice = r.body.notice as { code: string; fields: string[] };
  assert.equal(notice?.code, 'ZATCA_BUYER_SIMPLIFIED', 'الإعلام غائب عن ردّ الإشعار اليدويّ');
  assert.ok(notice.fields.length > 0);
  const lines = warn.mock.calls.map(c => String(c.arguments[0])).filter(l => l.includes('ZATCA_BUYER_SIMPLIFIED'));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).kind, 'CREDIT_NOTE', 'سطر التدقيق يسمّي الإشعار فاتورة');
  const xml = gunzipXml([...rig.h.docs.documents.values()][0].xmlGz);
  assert.doesNotMatch(xml.slice(xml.indexOf('<cac:AccountingCustomerParty>'), xml.indexOf('</cac:AccountingCustomerParty>')), /311111111111113|PostalAddress/, 'الطرف المبسّط يحمل بيانات ناقصة');

  for (const relaxed of [undefined, false]) {
    const off = buildRig();
    script({ rig: off, stored: false, relaxed, customer: incomplete });
    const x = await call('POST', '/api/invoices', { body: body(), headers: CAPS });
    assert.equal(x.status, 422, JSON.stringify(x.body));
    assert.equal(x.body.code, 'ZATCA_BUYER_INCOMPLETE');
    assert.match(String(x.body.message), /^بيانات العميل \(منشأة\) ناقصة للفاتورة الضريبية: /);
    assert.equal('notice' in x.body, false);
    assert.equal(off.h.docs.documents.size, 0, 'مستندٌ قبل الحجب');
  }
});

test('المرحلة الثانية والإعداد false: إعادة الرفع بلا clientRef ⇒ 426 كالفاتورة، وبلا قدرات ⇒ 426، قبل أيّ مستند', async () => {
  asAdmin();
  let rig = buildRig();
  script({ rig, stored: false });
  const noRef = await call('POST', '/api/invoices', {
    body: returnBody({ clientRef: undefined, clientCreatedAt: new Date().toISOString(), originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'إرجاع' }),
    headers: CAPS,
  });
  assert.equal(noRef.status, 426, JSON.stringify(noRef.body));
  assert.equal(rig.created.length, 0);
  rig = buildRig();
  script({ rig, stored: false });
  const noCaps = await call('POST', '/api/invoices', { body: returnBody({ originalInvoiceRef: 'OLD-1001', originalPaymentType: 'CASH', noteReason: 'إرجاع' }) });
  assert.equal(noCaps.status, 426);
  assert.equal(rig.created.length, 0);
});

test('نواة الإصدار: المرتجع لا يصلها فاتورةً سالبة أبداً — الحرّاس الثلاثة كما هي', () => {
  const issue = fs.readFileSync(path.join(SRC, 'compliance', 'zatca', 'issue.ts'), 'utf8');
  assert.match(issue, /if \(request\.type === 'RETURN'\) throw new ZatcaHttpError\('ZATCA_RETURN_NEEDS_ORIGINAL'\);/);
  assert.match(issue, /if \(kind === 'INVOICE' && input\.request\.type === 'RETURN'\) throw new ZatcaHttpError\('ZATCA_RETURN_NEEDS_ORIGINAL'\);/);
  const z = fs.readFileSync(path.join(SRC, 'routes', 'invoicesZatca.ts'), 'utf8');
  assert.match(z, /if \(ctx\.body\.type === 'RETURN' && !ctx\.manualNote\) return errorResult\(new ZatcaHttpError\('ZATCA_RETURN_NEEDS_ORIGINAL'\)\);/);
  // والإشعار اليدويّ نوعه CREDIT_NOTE بمرجعه — لا يملؤه إلا وصل الإشعارات بعد فحوصه
  assert.match(z, /kind: 'CREDIT_NOTE' as const,/);
  const notes = fs.readFileSync(path.join(SRC, 'routes', 'invoicesNotes.ts'), 'utf8');
  assert.equal(notes.split('manualNote: {').length - 1, 1, 'موضعٌ ثانٍ يملأ الإشعار اليدويّ');
  const inv = fs.readFileSync(path.join(SRC, 'routes', 'invoices.ts'), 'utf8');
  assert.doesNotMatch(inv, /manualNote:/, 'المسار يملأ الإشعار اليدويّ متجاوزاً فحوصه');
});
