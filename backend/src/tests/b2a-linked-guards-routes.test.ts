// «ربط الدفاتر» L0 — حرّاس المسارات الهدّامة عبر الموجّهات الحقيقية بعميل Prisma مزيّف (بلا قاعدة):
//   • DELETE /api/products/:id — المربوطة وللصنف بند فاتورة أو حركة مستودع أو تحميل ⇒ 409 BOOKS_LINKED_NO_DELETE بعد قفل الصفّ
//     وبلا كتابة؛ والصنف بلا أثر يُحذف؛ واليدوية كما كانت (لا قراءة بنود).
//   • POST /api/products/:id/convert-base — المربوطة ⇒ 409 BOOKS_LINKED_BASE_LOCKED قبل الجسم والمعاملة (المعاينة كالتنفيذ).
//   • PUT /api/company — المربوطة وتغيّرت الدولة أو العملة الفعلية ⇒ 409 BOOKS_LINKED_CURRENCY_LOCKED بلا كتابة؛ والحفظ بلا
//     تغيير لا يقرأ وضع الدفاتر؛ واليدوية تغيّر كما كانت.
//   • DELETE /api/tenants/:id — توابع المورّد بالترتيب (التخصيصات ثم القيود ثم السندات) ثم فكّ مورّد الحركات ثم الموردون، قبل
//     جداول الدفاتر وقبل الأصناف، وبنود التحميل والحركات قبل الأصناف (Restrict)، وكله داخل المعاملة.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { GL_RESET_KEEP, GL_RESET_ORDER, resetDelegateName } from '../services/gl/reset';

process.env.JWT_SECRET = 'b2a-linked-guards-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { op: string; args: any; inTx: boolean };
let calls: Call[] = [];
let inTx = false;
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (sql: string) => unknown = () => undefined;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany' || method === 'createMany') return { count: 0 };
  return null;
}
const prismaFake: any = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown, opts?: unknown) => {
        calls.push({ op: '$transaction', args: opts, inTx });
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Prisma.sql(strings, ...(values as Prisma.Sql[])).text.replace(/\s+/g, ' ').trim();
        calls.push({ op: key, args: { sql }, inTx });
        const out = rawScript(sql);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push({ op: `${key}.${method}`, args, inTx });
        const fn = scripted[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: prismaFake });
stub('services/mailer', { async sendMail() { return true; }, mailLayout: () => '' });

const TENANT = 'T1';
let currentUser: Record<string, unknown> = {};
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
const productsModule = require('../routes/products') as typeof import('../routes/products');
const companyModule = require('../routes/company') as typeof import('../routes/company');
const tenantsModule = require('../routes/tenants') as typeof import('../routes/tenants');
/* eslint-enable @typescript-eslint/no-var-requires */

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });

async function call(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/products', productsModule.default);
    app.use('/api/company', companyModule.default);
    app.use('/api/tenants', tenantsModule.default);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ success: false, message: err.message }); });
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* نصّ */ }
  return { status: r.status, body: json };
}

const ownerToken = (): string => jwt.sign({ id: 'o1', role: 'SUPER_ADMIN', name: 'المالك' }, SECRET);
const ops = (): string[] => calls.map((c) => c.op);
const opIdx = (op: string): number => calls.findIndex((c) => c.op === op);
const rawIdx = (frag: string): number => calls.findIndex((c) => (c.op === '$queryRaw' || c.op === '$executeRaw') && String(c.args.sql).includes(frag));
const writes = (): string[] => ops().filter((o) => /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(o));

const LINKED = { setupMethod: 'LINKED', activatedAt: new Date('2026-11-01T00:00:00Z') };
const CLEAN = { setupMethod: 'CLEAN', activatedAt: new Date('2026-01-01T00:00:00Z') };

function reset(books: Record<string, unknown> | null = null): void {
  calls = [];
  inTx = false;
  currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
  rawScript = () => undefined;
  scripted = {
    'superAdmin.findUnique': () => ({ isActive: true }),
    'platformAuditLog.create': () => ({ id: 'pa1' }),
    'platformAuditLog.update': () => ({}),
    'glSettings.findUnique': () => books,
  };
}

// ═══ حذف الصنف ═══

function productDeleteWorld(books: Record<string, unknown> | null, history: { inv?: boolean; wh?: boolean; van?: boolean } = {}): void {
  reset(books);
  scripted['product.findFirst'] = () => ({ id: 'p1' });
  scripted['product.findUnique'] = () => ({ name: 'شاي' });
  scripted['product.findMany'] = (a) => ((a.where?.id?.in ?? []).includes('p1') ? [{ id: 'p1', name: 'شاي', unit: 'حبة' }] : []);
  scripted['invoiceItem.findFirst'] = () => (history.inv ? { id: 'ii1' } : null);
  scripted['warehouseEntryItem.findFirst'] = () => (history.wh ? { id: 'wi1' } : null);
  scripted['vanLoadItem.findFirst'] = () => (history.van ? { id: 'vi1' } : null);
  rawScript = (sql) => (sql.includes('FROM products WHERE id =') && sql.includes('FOR UPDATE') ? [{ id: 'p1' }] : undefined);
}

test('حذف الصنف — المربوطة وله بند فاتورة أو حركة مستودع أو تحميل ⇒ 409 بعد قفل الصفّ داخل المعاملة وبلا أي كتابة', async () => {
  for (const history of [{ inv: true }, { wh: true }, { van: true }]) {
    productDeleteWorld(LINKED, history);
    const r = await call('DELETE', '/api/products/p1');
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'BOOKS_LINKED_NO_DELETE');
    assert.equal(r.body.message, productsModule.LINKED_PRODUCT_DELETE_MESSAGE);
    assert.match(r.body.message, /أوقِفه بدلاً من الحذف/);
    const lock = rawIdx('FOR UPDATE');
    const books = opIdx('glSettings.findUnique');
    assert.ok(lock >= 0 && books > lock && calls[books].inTx, `الوضع يُقرأ بعد القفل داخل المعاملة: ${ops().join(' → ')}`);
    assert.deepEqual(calls[books].args, { where: { tenantId: TENANT }, select: { setupMethod: true, activatedAt: true } });
    assert.deepEqual(writes(), [], `لا كتابة: ${JSON.stringify(history)}`);
  }
});

test('حذف الصنف — المربوطة والصنف بلا أثر يُحذف كما كان؛ واليدوية تحذف ولو له حركات بلا قراءة بنوده', async () => {
  productDeleteWorld(LINKED, {});
  const a = await call('DELETE', '/api/products/p1');
  assert.deepEqual([a.status, a.body.archived], [200, false], JSON.stringify(a.body));
  for (const o of ['invoiceItem.findFirst', 'warehouseEntryItem.findFirst', 'vanLoadItem.findFirst']) assert.ok(opIdx(o) >= 0, o);
  assert.ok(opIdx('product.deleteMany') > opIdx('vanLoadItem.findFirst'));

  for (const books of [null, CLEAN]) {
    productDeleteWorld(books, { inv: true, wh: true, van: true });
    const m = await call('DELETE', '/api/products/p1');
    assert.deepEqual([m.status, m.body.archived], [200, false], JSON.stringify(m.body));
    assert.equal(opIdx('invoiceItem.findFirst'), -1, 'اليدوية لا تقرأ أثر الصنف');
    assert.ok(opIdx('product.deleteMany') > 0 && calls[opIdx('product.deleteMany')].inTx);
  }
});

test('linkedProductDeleteBlocked: اليدوية/غير المفعّلة false بلا قراءة بنود، والمربوطة تقف عند أول أثر', async () => {
  const mk = (books: unknown, hits: Record<string, boolean>) => {
    const seen: string[] = [];
    const delegate = (name: string) => ({ findFirst: async (a: any) => { seen.push(name); assert.deepEqual(a, { where: { productId: 'p1' }, select: { id: true } }); return hits[name] ? { id: 'x' } : null; } });
    return { seen, db: { glSettings: { findUnique: async () => books }, invoiceItem: delegate('inv'), warehouseEntryItem: delegate('wh'), vanLoadItem: delegate('van') } };
  };
  for (const books of [null, CLEAN, { ...LINKED, activatedAt: null }]) {
    const w = mk(books, { inv: true });
    assert.equal(await productsModule.linkedProductDeleteBlocked(w.db, TENANT, 'p1'), false);
    assert.deepEqual(w.seen, []);
  }
  const inv = mk(LINKED, { inv: true });
  assert.equal(await productsModule.linkedProductDeleteBlocked(inv.db, TENANT, 'p1'), true);
  assert.deepEqual(inv.seen, ['inv']);
  const van = mk(LINKED, { van: true });
  assert.equal(await productsModule.linkedProductDeleteBlocked(van.db, TENANT, 'p1'), true);
  assert.deepEqual(van.seen, ['inv', 'wh', 'van']);
  const none = mk(LINKED, {});
  assert.equal(await productsModule.linkedProductDeleteBlocked(none.db, TENANT, 'p1'), false);
});

// ═══ إضافة وحدة فرعية أصغر ═══

test('convert-base — المربوطة ⇒ 409 BOOKS_LINKED_BASE_LOCKED قبل الجسم والمعاملة (والمعاينة مثله)؛ واليدوية تمضي كما كانت', async () => {
  const body = { newBaseName: 'قارورة', factor: 24, expectedBaseName: 'كرتون' };
  for (const b of [body, { ...body, dryRun: true }, {}]) {
    reset(LINKED);
    currentUser = { id: 'admin-1', role: 'ADMIN', name: 'الدعم الفني', tenantId: TENANT, impersonated: true, byKind: 'OWNER' };
    const r = await call('POST', '/api/products/p1/convert-base', b);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual([r.body.code, r.body.message], [productsModule.BOOKS_LINKED_BASE_LOCKED_CODE, productsModule.BOOKS_LINKED_BASE_LOCKED_MESSAGE]);
    assert.equal(r.body.code, 'BOOKS_LINKED_BASE_LOCKED');
    assert.equal(opIdx('$transaction'), -1, 'لا معاملة');
    assert.deepEqual(writes(), []);
    assert.deepEqual(ops(), ['glSettings.findUnique'], 'لا قراءة أخرى قبل الرفض');
  }
  for (const books of [null, CLEAN]) {
    reset(books);
    currentUser = { id: 'admin-1', role: 'ADMIN', name: 'الدعم الفني', tenantId: TENANT, impersonated: true, byKind: 'OWNER' };
    const r = await call('POST', '/api/products/p1/convert-base', { ...body, dryRun: true });
    assert.notEqual(r.body.code, 'BOOKS_LINKED_BASE_LOCKED', JSON.stringify(r.body));
    assert.ok(opIdx('tenant.findUnique') > opIdx('glSettings.findUnique'), `المسار القائم بعد الحارس: ${ops().join(' → ')}`);
  }
  // مفتاح API يُرفض قبل الحارس كما كان (لا قراءة للدفاتر)
  reset(LINKED);
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT, apiKeyId: 'k1' };
  const k = await call('POST', '/api/products/p1/convert-base', body);
  assert.deepEqual([k.status, k.body.code], [403, 'CONVERT_BASE_INTERACTIVE_ONLY']);
  assert.equal(opIdx('glSettings.findUnique'), -1);
});

// ═══ قفل الدولة والعملة ═══

const EXISTING = { countryCode: 'SA', currency: 'SAR', currencyOverride: null, einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null };
function companyWorld(books: Record<string, unknown> | null): void {
  reset(books);
  scripted['tenant.findUnique'] = () => ({ zatcaPhase2Enabled: false });
  scripted['companySettings.findUnique'] = () => ({ ...EXISTING });
  scripted['companySettings.upsert'] = (a) => ({ tenantId: TENANT, ...a.update });
}

test('linkedCurrencyLockedChanges: القيم المشتقّة النهائية — الغائب لا يُقارن، والحالة والمسافات لا تهمّ، ولا صفّ ⇒ لا قفل', () => {
  const f = companyModule.linkedCurrencyLockedChanges;
  assert.deepEqual(f(EXISTING, {}), []);
  assert.deepEqual(f(EXISTING, { countryCode: undefined, currency: undefined }), []);
  assert.deepEqual(f(EXISTING, { countryCode: 'sa ', currency: 'SAR' }), []);
  assert.deepEqual(f(EXISTING, { countryCode: 'AE', currency: 'AED' }), ['countryCode', 'currency']);
  assert.deepEqual(f(EXISTING, { currency: 'USD' }), ['currency']);
  assert.deepEqual(f(EXISTING, { countryCode: 'KW' }), ['countryCode']);
  assert.deepEqual(f(null, { countryCode: 'AE', currency: 'AED' }), []);
  assert.deepEqual(companyModule.linkedCurrencyLockedBody(['currency']), {
    success: false, code: 'BOOKS_LINKED_CURRENCY_LOCKED', message: companyModule.BOOKS_LINKED_CURRENCY_LOCKED_MESSAGE, fields: ['currency'],
  });
});

test('PUT /api/company — المربوطة: تغيير الدولة أو تجاوز العملة ⇒ 409 بلا كتابة؛ والحفظ بالقيم نفسها يمرّ بلا قراءة الدفاتر', async () => {
  companyWorld(LINKED);
  const country = await call('PUT', '/api/company', { name: 'شركة', countryCode: 'AE' });
  assert.equal(country.status, 409, JSON.stringify(country.body));
  assert.deepEqual([country.body.code, country.body.fields], ['BOOKS_LINKED_CURRENCY_LOCKED', ['countryCode', 'currency']]);
  assert.equal(opIdx('companySettings.upsert'), -1);

  companyWorld(LINKED);
  const override = await call('PUT', '/api/company', { name: 'شركة', currencyOverride: 'USD' });
  assert.deepEqual([override.status, override.body.code, override.body.fields], [409, 'BOOKS_LINKED_CURRENCY_LOCKED', ['currency']]);
  assert.equal(opIdx('companySettings.upsert'), -1);

  companyWorld(LINKED);
  const same = await call('PUT', '/api/company', { name: 'شركة', countryCode: 'SA', currencyOverride: '' });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(opIdx('glSettings.findUnique'), -1, 'لا تغيير ⇒ لا قراءة لوضع الدفاتر');
  assert.equal(calls[opIdx('companySettings.upsert')].args.update.currency, 'SAR');

  companyWorld(LINKED);
  const plain = await call('PUT', '/api/company', { name: 'شركة جديدة' });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(opIdx('glSettings.findUnique'), -1);
});

test('PUT /api/company — اليدوية وبلا دفاتر: تغيير الدولة والعملة كما كان', async () => {
  for (const books of [null, CLEAN, { ...LINKED, activatedAt: null }]) {
    companyWorld(books);
    const r = await call('PUT', '/api/company', { name: 'شركة', countryCode: 'AE' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const up = calls[opIdx('companySettings.upsert')].args.update;
    assert.deepEqual([up.countryCode, up.currency], ['AE', 'AED']);
    assert.ok(opIdx('glSettings.findUnique') >= 0 && opIdx('glSettings.findUnique') < opIdx('companySettings.upsert'));
  }
});

// ═══ حذف الشركة: توابع المورّد ═══

function tenantDeleteWorld(ledger: boolean): void {
  reset(null);
  scripted['tenant.findUnique'] = () => ({ id: TENANT, name: 'شركة', lotTrackingEnabled: false, lotTrackingSince: null });
  if (ledger) {
    // دفاتر بقيود مرحّلة انقضت مدة حفظها ⇒ حذف الدفاتر بالتأكيد الثاني (جداول GL_RESET_ORDER صراحةً)
    scripted['glSettings.findUnique'] = () => ({ fiscalYearEndMonth: 12, fiscalYearEndDay: 31, timezone: 'Asia/Riyadh' });
    scripted['glMove.aggregate'] = () => ({ _count: { _all: 3 }, _max: { date: new Date('2008-06-01T00:00:00Z') } });
  }
}

const SUPPLIER_SEQ = [
  'supplierPaymentAllocation.deleteMany', 'supplierLedgerEntry.deleteMany', 'supplierPayment.deleteMany', 'warehouseEntry.updateMany', 'glVendor.deleteMany',
];

test('حذف الشركة: التخصيصات ثم قيود المورّد ثم السندات ثم فكّ مورّد الحركات ثم الموردون — داخل المعاملة وقبل جداول التشغيل', async () => {
  tenantDeleteWorld(false);
  const r = await call('DELETE', `/api/tenants/${TENANT}`, undefined, ownerToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const seq = SUPPLIER_SEQ.map(opIdx);
  assert.ok(seq.every((i, k) => i >= 0 && (k === 0 || i > seq[k - 1])), ops().join(' → '));
  for (const o of [...SUPPLIER_SEQ, 'invoiceRestockLog.deleteMany']) {
    const c = calls[opIdx(o)];
    assert.ok(c.inTx, `${o} خارج المعاملة`);
    if (o.endsWith('deleteMany')) assert.deepEqual(c.args, { where: { tenantId: TENANT } }, o);
  }
  assert.deepEqual(calls[opIdx('warehouseEntry.updateMany')].args, { where: { tenantId: TENANT, vendorId: { not: null } }, data: { vendorId: null } });
  assert.ok(opIdx('invoiceRestockLog.deleteMany') > opIdx('supplierPayment.deleteMany'));
  const lock = calls.findIndex((c) => (c.op === '$executeRaw' || c.op === '$queryRaw') && /pg_advisory_xact_lock/.test(c.args.sql));
  assert.ok(lock >= 0 && lock < seq[0], 'بعد قفل gl-post');
  // بنود التحميل والحركات (بنودها تعاقباً) قبل الأصناف — مفتاح الصنف فيها Restrict — وبعد فكّ اللوط عنها
  const vanItems = opIdx('vanLoadItem.deleteMany');
  const entries = opIdx('warehouseEntry.deleteMany');
  const products = opIdx('product.deleteMany');
  assert.ok(opIdx('productLot.deleteMany') < vanItems && vanItems < products && entries < products && entries > seq[4], ops().join(' → '));
  assert.deepEqual(calls[vanItems].args, { where: { vanLoad: { tenantId: TENANT } } });
  assert.deepEqual(calls[entries].args, { where: { tenantId: TENANT } });
  assert.ok(opIdx('tenant.delete') > products);
});

test('حذف الشركة بحذف الدفاتر (انقضت مدة الحفظ + التأكيد): توابع المورّد والموردون قبل أول جدول دفاتر أياً كان موضع GlVendor فيها', async () => {
  tenantDeleteWorld(true);
  const r = await call('DELETE', `/api/tenants/${TENANT}?confirmLedgerDestroy=1`, undefined, ownerToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ledgerOps = [...GL_RESET_ORDER, ...GL_RESET_KEEP].filter((m) => m !== 'GlVendor').map((m) => `${resetDelegateName(m)}.deleteMany`);
  const firstLedger = Math.min(...ledgerOps.map(opIdx).filter((i) => i >= 0));
  assert.ok(Number.isFinite(firstLedger), 'جداول الدفاتر حُذفت');
  const vendors = opIdx('glVendor.deleteMany');
  assert.ok(vendors > opIdx('warehouseEntry.updateMany') && vendors < firstLedger, ops().join(' → '));
  assert.ok(opIdx('supplierPaymentAllocation.deleteMany') < firstLedger);
});
