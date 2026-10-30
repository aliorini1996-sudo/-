// «تتبّع اللوط» — الحزمة B1 (التفعيل والأصناف): حرّاسٌ نصّية (§٨.٣) وتكاملٌ عبر الموجّهات الحقيقية بعميل Prisma مزيّف (بلا قاعدة):
//   • علم الشركة (PUT /api/tenants/:id): الحقبة عند كل انتقالٍ إلى المفعّل بعد انتظار عمليات اللوط الجارية، وTRACKING_ON/OFF.
//   • حذف الشركة: حارس الحفظ D31 (LOT_RECORDS_RETAINED) وحذف جداول اللوط قبل الأصناف بالترتيب.
//   • /api/company: lotTrackingEnabled وlotOnInvoice المشروط بالعلم، والحفظ لا يمسّه ولا يكشفه خاماً.
//   • علم الصنف (POST/PUT /api/products): FOR UPDATE ثم قفل اللوط، والحقبة، وD9 بالكمية الأساسية (سطر كرتون وسطر حبة للصنف
//     نفسه)، وLOTS_NOT_ALLOWED، والانشغال 503 — والمسار بلا انتقالٍ حرفياً كما كان (لا استعلام ولا معاملة جديدة).
//   • حذف الصنف (§٤.١٩): العدّ والحذف في معاملةٍ واحدة بقفل الصفّ، والتشغيلة تؤرشف ولا تُحذف.
//   • حمولة ERP بلا أي مفتاح لوط (R4) — وتفصيلها بالوحدات في erp-payload.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { lotLockKey } from '../services/lots';

process.env.JWT_SECRET = 'lots-b1-test-secret';
const SECRET = process.env.JWT_SECRET;
const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
/** يزيل التعليقات مع الحفاظ على المواضع (نمط lots-static.test.ts) */
const strip = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`])\/\/.*$/gm, (_m, p1: string) => p1);
/** جسم مسارٍ من رأسه حتى المسار التالي */
const routeBody = (src: string, head: string): string => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, head);
  const next = src.slice(i + head.length).search(/\nrouter\.(get|post|put|delete|patch)\(/);
  return next < 0 ? src.slice(i) : src.slice(i, i + head.length + next);
};
const fnBody = (src: string, head: string): string => {
  const i = src.indexOf(head);
  assert.ok(i >= 0, head);
  return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const ordered = (s: string, parts: string[], msg: string): void => {
  let at = -1;
  for (const p of parts) {
    const i = s.indexOf(p, at + 1);
    assert.ok(i > at, `${msg}: «${p}» غائب أو قبل سابقه`);
    at = i;
  }
};

// ═══ Prisma مزيّف: كل نداءٍ يُسجَّل بموضعه (داخل المعاملة أم خارجها)، والنصوص الخام تُركَّب بـPrisma.sql كما تصل القاعدة ═══

/* eslint-disable @typescript-eslint/no-explicit-any */
type Call = { op: string; args: any; inTx: boolean };
let calls: Call[] = [];
let inTx = false;
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (sql: string, values: unknown[], kind: string) => unknown = () => undefined;

function render(strings: TemplateStringsArray, values: unknown[]): { sql: string; values: unknown[] } {
  const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
  return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
}
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
        const r = render(strings, values);
        calls.push({ op: key, args: r, inTx });
        const out = rawScript(r.sql, r.values, key);
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
let currentUser: Record<string, unknown> = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
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
const { productPayloadRow, invoicePayloadRow } = require('../services/erpPayload') as typeof import('../services/erpPayload');
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
const idxOf = (pred: (c: Call) => boolean): number => calls.findIndex(pred);
const rawIdx = (frag: string): number => idxOf((c) => (c.op === '$queryRaw' || c.op === '$executeRaw') && String(c.args.sql).includes(frag));
const opIdx = (op: string): number => idxOf((c) => c.op === op);

function reset(): void {
  calls = [];
  inTx = false;
  currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT };
  rawScript = () => undefined;
  scripted = {
    'superAdmin.findUnique': () => ({ isActive: true }),
    'platformAuditLog.create': () => ({ id: 'pa1' }),
    'platformAuditLog.update': () => ({}),
  };
}

// ═══ تشغيلاتٌ مزيّفة بصفوفها المفردة — التجميع هنا كما يجمع SQL في lotsDb (الكميات بالأساس، D22) ═══

interface FxVan { productId: string; lotId: string | null; vanKey: string; moveType: string; viaWarehouse: boolean; qty: number; at: Date }
interface FxInv { productId: string; lotId: string | null; vanKey: string | null; type: string; qty: number; at: Date }
interface FxWh { productId: string; lotId: string; qty: number }
let fx: { van: FxVan[]; inv: FxInv[]; wh: FxWh[] } = { van: [], inv: [], wh: [] };
const LOT_META = (id: string, lotNumber: string) => ({
  id, productId: 'p1', lotNumber, productionDate: null, expiryDate: new Date('2027-06-30T00:00:00Z'), status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date('2026-10-01T00:00:00Z'),
});

function sumBy<T>(rows: T[], key: (r: T) => string, qty: (r: T) => number): Map<string, { first: T; qty: number }> {
  const m = new Map<string, { first: T; qty: number }>();
  for (const r of rows) {
    const k = key(r);
    const cur = m.get(k);
    if (cur) cur.qty += qty(r); else m.set(k, { first: r, qty: qty(r) });
  }
  return m;
}

/** يجيب استعلامات namedLotBalances وplaceViews من الصفوف المفردة */
function lotAggScript(sql: string): unknown {
  if (sql.includes('UNION SELECT "vanKey" FROM invoice_item_lots')) {
    return [...new Set([...fx.van.map((r) => r.vanKey), ...fx.inv.map((r) => r.vanKey).filter((k): k is string => !!k)])].map((vanKey) => ({ vanKey }));
  }
  if (sql.includes('FROM van_load_item_lots l')) {
    const wh = sql.includes(`l."viaWarehouse" = true`);
    const rows = fx.van.filter((r) => !wh || (r.viaWarehouse && (r.moveType === 'LOAD' || r.moveType === 'UNLOAD')));
    return [...sumBy(rows, (r) => [r.productId, r.lotId, r.vanKey, r.moveType, r.viaWarehouse].join('|'), (r) => r.qty).values()].map(({ first, qty }) => ({
      productId: first.productId, lotId: first.lotId, vanKey: first.vanKey, moveType: first.moveType, viaWarehouse: first.viaWarehouse, qty, firstInAt: first.at,
    }));
  }
  if (sql.includes('FROM invoice_item_lots il')) {
    return [...sumBy(fx.inv, (r) => [r.productId, r.lotId, r.vanKey, r.type].join('|'), (r) => r.qty).values()].map(({ first, qty }) => ({
      productId: first.productId, lotId: first.lotId, vanKey: first.vanKey, type: first.type, returnToStock: null, returnExpired: null,
      damaged: false, held: false, qty, firstAt: first.at, src: 'LOT',
    }));
  }
  if (sql.includes('FROM warehouse_entry_items wi')) {
    return [...sumBy(fx.wh, (r) => `${r.productId}|${r.lotId}`, (r) => r.qty).values()].map(({ first, qty }) => ({ productId: first.productId, lotId: first.lotId, qty }));
  }
  if (sql.includes('FROM lot_relabels r')) return [];
  return undefined;
}

// ═══ الصنف: حالةٌ مزيّفة لصفّه المقفل ═══

let productRow = { lotTracked: false, lotTrackedSince: null as Date | null };
function productsWorld(o: { tenantLots: boolean; tracked: boolean; underLock?: boolean; since?: Date | null }): void {
  productRow = { lotTracked: o.underLock ?? o.tracked, lotTrackedSince: o.since ?? null };
  scripted['product.findFirst'] = () => ({
    id: 'p1', shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
    returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, unit: 'حبة', units: [], lotTracked: o.tracked,
  });
  scripted['tenant.findUnique'] = () => ({ lotTrackingEnabled: o.tenantLots });
  scripted['product.update'] = (a) => ({ id: a.where.id, name: 'شاي', ...a.data, category: null, units: [] });
  scripted['productLot.findMany'] = (a) => (a.where.id?.in ?? []).map((id: string) => LOT_META(id, id === 'L1' ? 'B-001' : 'B-002'));
  rawScript = (sql) => {
    if (sql.includes('FROM products WHERE id =') && sql.includes('FOR UPDATE')) return [{ id: 'p1', name: 'شاي', ...productRow }];
    return lotAggScript(sql);
  };
}

// ═══ حمولة ERP (R4، §٥.٥) ═══

test('ERP: لا مفتاح يبدأ بـlot في المنتج ولا الفاتورة ولا بنودها — والعلم وحقبته وعلاقة التوزيع تسقط', () => {
  assert.deepEqual(productPayloadRow({ id: 'p', name: 'شاي', lotTracked: true, lotTrackedSince: new Date(), lots: [{ id: 'L1' }] }), { id: 'p', name: 'شاي' });
  const row = invoicePayloadRow({
    id: 'i', invoiceDate: '2026-10-07T10:00:00Z', total: 10, taxAmt: 0, lotSummary: 'x',
    items: [{ unitPrice: 10, taxPct: 0, taxAmt: 0, lineTotal: 10, qty: 1, lots: [{ lotId: 'L1', quantity: 1 }], product: { id: 'p', lotTracked: true } }],
  }, 'Asia/Riyadh');
  const keys: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object' && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
  };
  walk(row);
  assert.deepEqual(keys.filter((k) => /^lot/.test(k)), []);
  const erp = strip(read('services/erpPayload.ts'));
  for (const head of ['export function productPayloadRow', 'export function invoiceItemPayloadRow', 'export function invoicePayloadRow']) {
    assert.match(fnBody(erp, head), /withoutLotKeys\(/, `${head} لا يُسقط مفاتيح اللوط`);
  }
});

// ═══ علم الصنف — حرّاس نصّية ═══

test('حارس نصّي: lotTracked وconfirmLotBalances خارج productSchema فلا يمرّان في { ...data } — والانتقال وحده يقرأ علم الشركة', () => {
  const src = strip(read('routes/products.ts'));
  const schema = src.slice(src.indexOf('const productSchema'), src.indexOf('});', src.indexOf('const productSchema')));
  assert.doesNotMatch(schema, /lotTracked|confirmLotBalances/);
  // nullish لا optional (درس productSchema): null من نموذج RHF غيابٌ كما كان قبل الميزة، لا 400
  assert.match(src, /const productLotSchema = z\.object\(\{\n\s*lotTracked: z\.boolean\(\)\.nullish\(\),\n\s*confirmLotBalances: z\.boolean\(\)\.nullish\(\),/);
  assert.match(routeBody(src, "router.put('/:id', requireAdmin"), /const lotTo = lot\.lotTracked != null && lot\.lotTracked !== exists\.lotTracked \? lot\.lotTracked : null;/);
  // العلم يُقرأ لطلب التفعيل وحده (§١٠.١)، في الإنشاء والتعديل
  const reads = [...src.matchAll(/^.*await lotsAllowed\(tid\).*$/gm)].map((m) => m[0]);
  assert.equal(reads.length, 2);
  for (const l of reads) assert.match(l, /=== true && !\(await lotsAllowed\(tid\)\)/, l);
  const put = routeBody(src, "router.put('/:id', requireAdmin");
  assert.match(put, /lotTracked: true, \/\/|lotTracked: true,\s*\n/, 'العلم في قراءة التعديل القائمة');
  // R1: دوالّ اللوط في التعديل داخل شرط الانتقال وحده
  const branch = put.indexOf('if (lotTo !== null) {');
  assert.ok(branch > 0 && put.indexOf('setProductLotTracking(') > branch);
  assert.equal(put.split('setProductLotTracking(').length - 1, 1);
  const post = routeBody(src, "router.post('/', requireAdmin");
  assert.ok(post.indexOf('recordLotEvent(') > post.indexOf(': await prisma.$transaction(async (tx) => {'), 'الحدث في فرع الإنشاء المتتبَّع وحده');
});

test('حارس نصّي: تبديل العلم — الطابور ثم FOR UPDATE ثم قفل اللوط ثم الحقبة ثم الكتابة والحدث، والتحرير في finally', () => {
  const src = strip(read('routes/products.ts'));
  const fn = fnBody(src, 'async function setProductLotTracking(');
  ordered(fn, [
    'await acquireLotQueue(tid, [productId])', 'prisma.$transaction(async (tx) => {', 'FOR UPDATE',
    'await lockLotProducts(tx, tid, [productId], { lockedRows:', 'namedLotBalances(tx, tid, productId)', "throw lotErr('LOT_TRACKING_HAS_BALANCE'",
    'data.lotTrackedSince = new Date()', 'tx.product.update(', 'await recordLotEvent(tx,', '{ maxWait: 10_000, timeout: 20_000 }', 'finally {', 'release();',
  ], 'ترتيب التبديل');
  assert.match(fn, /lockedRows: \[\{ id: row\.id, lotTracked: true,/, 'القفل الاستشاري في الاتجاهين');
  // الأرصدة المسمّاة عند الانتقال إلى الإطفاء وحده (ن٢-١٤)
  assert.ok(fn.indexOf('if (!on) {') < fn.indexOf('namedLotBalances(tx'));
});

test('حارس نصّي: حذف الصنف — العدّ والحذف داخل معاملةٍ بقفل الصفّ FOR UPDATE، وproductLot.count يؤرشف (§٤.١٩)', () => {
  const src = strip(read('routes/products.ts'));
  const del = routeBody(src, "router.delete('/:id', requireAdmin");
  ordered(del, ['prisma.$transaction(async (tx) => {', 'FOR UPDATE', 'deleteOrArchiveLocked(tx, req)'], 'الحذف');
  // انتظار القفل بمهلةٍ محلية تُحفظ وتُستعاد (نمط lockLotProducts)، والانشغال 503 LOT_BUSY في catch المسار (D14، §٣.٣)
  ordered(del, [
    "current_setting('lock_timeout')", "set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)", 'FOR UPDATE', "set_config('lock_timeout', ${prev",
    'deleteOrArchiveLocked(tx, req)', 'catch (err) {', 'asLotBusy(err)', 'res.status(busy.status).json(lotErrorBody(busy))', 'next(err);',
  ], 'مهلة القفل والانشغال');
  assert.doesNotMatch(del, /SET LOCAL/);
  assert.doesNotMatch(del.slice(del.indexOf('=>'), del.indexOf('prisma.$transaction(')), /\.count\(|\.delete(Many)?\(|\.update\(/, 'لا عدّ ولا كتابة قبل القفل');
  const fn = fnBody(src, 'async function deleteOrArchiveLocked(');
  const firstWrite = fn.search(/\.delete(Many)?\(|\.update\(/);
  for (const c of ['invoiceItem.count(', 'vanLoadItem.count(', 'warehouseEntryItem.count(', 'productLot.count(']) {
    const i = fn.indexOf(c);
    assert.ok(i > 0 && i < firstWrite, `${c} قبل أول كتابة`);
  }
  assert.match(fn, /invoiceItems > 0 \|\| loadItems > 0 \|\| warehouseItems > 0 \|\| lots > 0/);
});

// ═══ علم الصنف — عبر الموجّه ═══

test('التعديل بلا انتقال: المسار حرفياً كما كان — لا قراءة علمٍ ولا معاملة ولا SQL خام، والعلم لا يُكتب', async () => {
  for (const body of [{ name: 'شاي' }, { name: 'شاي', lotTracked: false }, { name: 'شاي', lotTracked: false, confirmLotBalances: true }]) {
    reset();
    productsWorld({ tenantLots: true, tracked: false });
    const r = await call('PUT', '/api/products/p1', body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ops(), ['product.findFirst', 'product.update']);
    const upd = calls[1].args;
    assert.ok(!('lotTracked' in upd.data) && !('confirmLotBalances' in upd.data) && !('lotTrackedSince' in upd.data));
  }
  // والمتتبَّع يُرسل true كما هو: لا انتقال
  reset();
  productsWorld({ tenantLots: true, tracked: true });
  assert.equal((await call('PUT', '/api/products/p1', { name: 'شاي', lotTracked: true })).status, 200);
  assert.deepEqual(ops(), ['product.findFirst', 'product.update']);
});

test('null في lotTracked وconfirmLotBalances غيابٌ كما كان قبل الميزة (نماذج RHF، §١٠.١): لا رفض، ولا انتقال ولو كان الصنف متتبَّعاً', async () => {
  for (const tracked of [false, true]) {
    for (const body of [{ name: 'شاي', lotTracked: null }, { name: 'شاي', lotTracked: null, confirmLotBalances: null }, { name: 'شاي', confirmLotBalances: null }]) {
      reset();
      productsWorld({ tenantLots: false, tracked });
      const r = await call('PUT', '/api/products/p1', body);
      assert.equal(r.status, 200, `${tracked} ${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      // null ليس false: المتتبَّع لا يُطفأ، ولا قراءة علمٍ ولا معاملة
      assert.deepEqual(ops(), ['product.findFirst', 'product.update']);
      const data = calls[1].args.data;
      assert.ok(!('lotTracked' in data) && !('confirmLotBalances' in data) && !('lotTrackedSince' in data));
    }
  }
  reset();
  scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data });
  const c = await call('POST', '/api/products', { code: 'C1', name: 'شاي', unit: 'حبة', basePrice: 5, taxPct: 15, lotTracked: null, confirmLotBalances: null });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual(ops(), ['product.findFirst', 'product.create']);
  assert.ok(!Object.keys(calls[1].args.data).some((k) => /^lot|^confirmLot/.test(k)));
});

test('التفعيل والعلم مطفأ للشركة ⇒ 403 LOTS_NOT_ALLOWED بلا كتابة', async () => {
  reset();
  productsWorld({ tenantLots: false, tracked: false });
  const r = await call('PUT', '/api/products/p1', { name: 'شاي', lotTracked: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'LOTS_NOT_ALLOWED');
  assert.deepEqual(ops(), ['product.findFirst', 'tenant.findUnique']);
});

test('التفعيل: صفّ الصنف FOR UPDATE ← قفل اللوط ← lotTracked والحقبة الآن ← TRACKING_ON، كلها في معاملةٍ واحدة بمهل D13', async () => {
  reset();
  productsWorld({ tenantLots: true, tracked: false, since: new Date('2026-01-01T00:00:00Z') });
  const before = Date.now();
  const r = await call('PUT', '/api/products/p1', { name: 'شاي أخضر', lotTracked: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.lotTracked, true);
  const tx = opIdx('$transaction');
  const lockRow = rawIdx('FROM products WHERE id =');
  const adv = rawIdx('pg_advisory_xact_lock');
  const upd = opIdx('product.update');
  const ev = opIdx('lotEvent.create');
  assert.ok(tx >= 0 && tx < lockRow && lockRow < adv && adv < upd && upd < ev, ops().join(' → '));
  assert.deepEqual(calls[tx].args, { maxWait: 10_000, timeout: 20_000 });
  assert.ok(calls.slice(lockRow).every((c) => c.inTx), 'كل ما بعد القفل داخل المعاملة');
  assert.match(calls[lockRow].args.sql, /FOR UPDATE$/);
  assert.equal(calls[adv].args.values[0], lotLockKey(TENANT, 'p1'));
  assert.equal(rawIdx('FOR KEY SHARE'), -1, 'الصفّ المقفل يغني عن FOR KEY SHARE ثانية');
  const data = calls[upd].args.data;
  assert.equal(data.name, 'شاي أخضر', 'بقية الحقول في المعاملة نفسها');
  assert.equal(data.lotTracked, true);
  assert.ok(data.lotTrackedSince instanceof Date && data.lotTrackedSince.getTime() >= before, 'حقبةٌ جديدة الآن (إعادة التفعيل لا ترث القديمة)');
  const e = calls[ev].args.data;
  assert.deepEqual([e.tenantId, e.lotId, e.productId, e.kind, e.actorType, e.actorId], [TENANT, null, 'p1', 'TRACKING_ON', 'ADMIN', 'admin-1']);
  assert.deepEqual(e.before, { lotTracked: false, lotTrackedSince: '2026-01-01T00:00:00.000Z' });
  assert.equal(e.after.lotTracked, true);
});

test('تبديلٌ متزامن سبقنا: الحالة تحت القفل هي المرجع — لا حقبة جديدة ولا حدث، وبقية الحقول تُحفظ', async () => {
  reset();
  productsWorld({ tenantLots: true, tracked: false, underLock: true, since: new Date('2026-10-29T00:00:00Z') });
  const r = await call('PUT', '/api/products/p1', { name: 'شاي', lotTracked: true });
  assert.equal(r.status, 200);
  const data = calls[opIdx('product.update')].args.data;
  assert.ok(!('lotTracked' in data) && !('lotTrackedSince' in data), 'الحقبة القائمة لا تُمسّ');
  assert.equal(opIdx('lotEvent.create'), -1);
});

/** صنفٌ بوحدتين: كرتون (٢٤) وحبة — كل صفّ لوطٍ بالأساس (D22) */
function cartonAndPieceWorld(): void {
  const t = new Date('2026-10-20T08:00:00Z');
  fx = {
    // وارد L1: سطر «٤ كرتون» (٩٦) وسطر «٤ حبة» ⇒ ١٠٠؛ ووارد L2 كرتون واحد (٢٤)
    wh: [{ productId: 'p1', lotId: 'L1', qty: 96 }, { productId: 'p1', lotId: 'L1', qty: 4 }, { productId: 'p1', lotId: 'L2', qty: 24 }],
    // تحميل L1 إلى سيارة rep-1 بسطرين للصنف نفسه: «٢ كرتون» (٤٨) و«٥ حبة»؛ وL2 كرتون
    van: [
      { productId: 'p1', lotId: 'L1', vanKey: 'rep-1', moveType: 'LOAD', viaWarehouse: true, qty: 48, at: t },
      { productId: 'p1', lotId: 'L1', vanKey: 'rep-1', moveType: 'LOAD', viaWarehouse: true, qty: 5, at: t },
      { productId: 'p1', lotId: 'L2', vanKey: 'rep-1', moveType: 'LOAD', viaWarehouse: true, qty: 24, at: t },
    ],
    // بيع «١ كرتون + ٥ حبة» من L1 (٢٩)، وكرتون L2 كله
    inv: [
      { productId: 'p1', lotId: 'L1', vanKey: 'rep-1', type: 'CASH', qty: 24, at: t },
      { productId: 'p1', lotId: 'L1', vanKey: 'rep-1', type: 'CASH', qty: 5, at: t },
      { productId: 'p1', lotId: 'L2', vanKey: 'rep-1', type: 'CREDIT', qty: 24, at: t },
    ],
  };
}

test('الإطفاء بأرصدةٍ مسمّاة (D9) ⇒ 409 LOT_TRACKING_HAS_BALANCE بالأماكن والكمية الأساسية — سطر كرتون وسطر حبة للصنف نفسه', async () => {
  reset();
  productsWorld({ tenantLots: true, tracked: true, since: new Date('2026-10-01T00:00:00Z') });
  cartonAndPieceWorld();
  const r = await call('PUT', '/api/products/p1', { name: 'شاي', lotTracked: false });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LOT_TRACKING_HAS_BALANCE');
  const d = r.body.detail;
  assert.equal(d.productId, 'p1');
  assert.equal(d.count, 2);
  const by = Object.fromEntries(d.lots.map((b: any) => [`${b.place}:${b.salesRepId ?? ''}:${b.lotNumber}`, [b.qty, b.raw.SELLABLE]]));
  // المستودع: ١٠٠ − ٥٣ = ٤٧ (لا ٤ كراتين ناقص ٢)، والسيارة: ٥٣ − ٢٩ = ٢٤؛ وL2 صفرٌ في المكانين فلا يُسرد
  assert.deepEqual(by, { 'WAREHOUSE::B-001': [47, 47], 'VAN:rep-1:B-001': [24, 24] });
  // وشكل الإطفاء الجماعي نفسه (POST /api/lots/products/tracking) لعارضٍ واحد في الواجهة
  assert.deepEqual(d.products, [{ productId: 'p1', name: 'شاي', warehouse: 47, vans: [{ salesRepId: 'rep-1', qty: 24 }], qty: 71 }]);
  assert.equal(d.updated, 0);
  assert.equal(opIdx('product.update'), -1, 'لا كتابة');
  assert.equal(opIdx('lotEvent.create'), -1);
  assert.ok(rawIdx('pg_advisory_xact_lock') < rawIdx('UNION SELECT "vanKey"'), 'الأرصدة تُحسب بعد القفل');
});

test('الإطفاء بالتأكيد: lotTracked=false بلا مساس بالحقبة، وTRACKING_OFF بعدد الأرصدة — يُخفي ولا يحذف', async () => {
  reset();
  productsWorld({ tenantLots: false, tracked: true, since: new Date('2026-10-01T00:00:00Z') });
  cartonAndPieceWorld();
  const r = await call('PUT', '/api/products/p1', { name: 'شاي', lotTracked: false, confirmLotBalances: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(opIdx('tenant.findUnique'), -1, 'الإطفاء لا يقرأ علم الشركة (ولو كان مطفأً)');
  const data = calls[opIdx('product.update')].args.data;
  assert.equal(data.lotTracked, false);
  assert.ok(!('lotTrackedSince' in data));
  const e = calls[opIdx('lotEvent.create')].args.data;
  assert.equal(e.kind, 'TRACKING_OFF');
  assert.deepEqual([e.after.confirmLotBalances, e.after.namedBalances, e.after.lotTrackedSince], [true, 2, '2026-10-01T00:00:00.000Z']);
  assert.equal(calls.filter((c) => /\.(delete|deleteMany)$/.test(c.op)).length, 0, 'لا حذف لصفوف اللوط');
});

test('الإطفاء بلا رصيدٍ مسمّى موجب لا يحتاج تأكيداً — ومنه العجز (خامٌ سالب): «رصيد > EPS» حرفياً كالإطفاء الجماعي', async () => {
  reset();
  productsWorld({ tenantLots: true, tracked: true });
  cartonAndPieceWorld();
  fx = { wh: fx.wh.filter((r) => r.lotId === 'L2'), van: fx.van.filter((r) => r.lotId === 'L2'), inv: fx.inv.filter((r) => r.lotId === 'L2') };
  assert.equal((await call('PUT', '/api/products/p1', { lotTracked: false })).status, 200);
  assert.equal(calls[opIdx('lotEvent.create')].args.data.after.namedBalances, 0);

  reset();
  productsWorld({ tenantLots: true, tracked: true });
  const t = new Date('2026-10-20T08:00:00Z');
  fx = {
    wh: [],
    van: [
      { productId: 'p1', lotId: 'L1', vanKey: 'rep-1', moveType: 'LOAD', viaWarehouse: false, qty: 5, at: t },
      { productId: 'p1', lotId: 'L2', vanKey: 'rep-1', moveType: 'LOAD', viaWarehouse: false, qty: 0.0005, at: t },
    ],
    inv: [{ productId: 'p1', lotId: 'L1', vanKey: 'rep-1', type: 'CASH', qty: 10, at: t }],
  };
  // L1 عجزٌ (−٥)، وL2 رصيدٌ صغير بأربع خانات (٠٫٠٠٠٥ > EPS) — يُسرد ولو صغر
  const r = await call('PUT', '/api/products/p1', { lotTracked: false });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.detail.lots.map((b: any) => [b.place, b.lotNumber, b.qty]), [['VAN', 'B-002', 0.0005]], 'العجز لا يُسرد رصيداً');

  fx.van = fx.van.filter((r) => r.lotId === 'L1');
  reset();
  productsWorld({ tenantLots: true, tracked: true });
  assert.equal((await call('PUT', '/api/products/p1', { lotTracked: false })).status, 200, 'العجز وحده لا يمنع الإطفاء');
});

test('الانشغال: انتظار قفل اللوط (55P03) ⇒ 503 LOT_BUSY، والطابور يُحرَّر فيمرّ الطلب التالي', async () => {
  reset();
  productsWorld({ tenantLots: true, tracked: false });
  const base = rawScript;
  rawScript = (sql, values, kind) => {
    if (sql.includes('pg_advisory_xact_lock')) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    return base(sql, values, kind);
  };
  const r = await call('PUT', '/api/products/p1', { lotTracked: true });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'LOT_BUSY');
  reset();
  productsWorld({ tenantLots: true, tracked: false });
  assert.equal((await call('PUT', '/api/products/p1', { lotTracked: true })).status, 200, 'الطابور حُرّر في finally');
});

test('الإنشاء: بلا العلم كما كان (لا قراءة علم ولا معاملة)؛ ومتتبَّعاً يلزمه العلم، وحقبته وTRACKING_ON في معاملة الإنشاء', async () => {
  const body = { code: 'C1', name: 'شاي', unit: 'حبة', basePrice: 5, taxPct: 15 };
  reset();
  scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data });
  assert.equal((await call('POST', '/api/products', body)).status, 201);
  assert.deepEqual(ops(), ['product.findFirst', 'product.create']);
  assert.ok(!Object.keys(calls[1].args.data).some((k) => /^lot/.test(k)));

  reset();
  scripted['tenant.findUnique'] = () => ({ lotTrackingEnabled: false });
  const off = await call('POST', '/api/products', { ...body, lotTracked: true });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'LOTS_NOT_ALLOWED');
  assert.equal(opIdx('product.create'), -1);

  reset();
  scripted['tenant.findUnique'] = () => ({ lotTrackingEnabled: true });
  scripted['product.create'] = (a) => ({ id: 'p-new', ...a.data });
  const before = Date.now();
  const on = await call('POST', '/api/products', { ...body, lotTracked: true });
  assert.equal(on.status, 201, JSON.stringify(on.body));
  const create = calls[opIdx('product.create')];
  const ev = calls[opIdx('lotEvent.create')];
  assert.ok(create.inTx && ev.inTx && opIdx('product.create') < opIdx('lotEvent.create'));
  assert.equal(create.args.data.lotTracked, true);
  assert.ok(create.args.data.lotTrackedSince instanceof Date && create.args.data.lotTrackedSince.getTime() >= before);
  assert.deepEqual([ev.args.data.productId, ev.args.data.kind, ev.args.data.lotId], ['p-new', 'TRACKING_ON', null]);
});

test('حدث اللوط من جلسة «دخول» المالك موسومٌ بالمُصدِر لا بالمدير، ومن المفتاح بمعرّفه', async () => {
  reset();
  productsWorld({ tenantLots: true, tracked: false });
  currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مدير', tenantId: TENANT, impersonated: true, by: 'o1', byKind: 'OWNER' };
  await call('PUT', '/api/products/p1', { lotTracked: true });
  assert.deepEqual(['actorType', 'actorId', 'actorName'].map((k) => calls[opIdx('lotEvent.create')].args.data[k]), ['OWNER', 'o1', 'الدعم الفني']);
  reset();
  productsWorld({ tenantLots: true, tracked: false });
  currentUser = { id: 'admin-1', role: 'ADMIN', name: 'مفتاح الربط', tenantId: TENANT, apiKeyId: 'k1' };
  await call('PUT', '/api/products/p1', { lotTracked: true });
  assert.deepEqual(['actorType', 'actorId'].map((k) => calls[opIdx('lotEvent.create')].args.data[k]), ['API_KEY', 'k1']);
});

test('حذف الصنف: صنفٌ له تشغيلة وحدها يؤرشف (Restrict)، وبلا أثرٍ يُحذف، والعدّ كله بعد القفل داخل المعاملة', async () => {
  const world = (counts: { lots: number }) => {
    reset();
    scripted['product.findFirst'] = () => ({ id: 'p1' });
    scripted['productLot.count'] = () => counts.lots;
    rawScript = (sql) => (sql.includes('FROM products WHERE id =') && sql.includes('FOR UPDATE') ? [{ id: 'p1' }] : undefined);
  };
  world({ lots: 1 });
  const a = await call('DELETE', '/api/products/p1');
  assert.deepEqual([a.status, a.body.archived], [200, true]);
  const lock = rawIdx('FOR UPDATE');
  for (const c of ['invoiceItem.count', 'vanLoadItem.count', 'warehouseEntryItem.count', 'productLot.count', 'product.update']) {
    const i = opIdx(c);
    assert.ok(i > lock && calls[i].inTx, c);
  }
  assert.deepEqual(calls[opIdx('product.update')].args.data.status, 'INACTIVE');
  assert.equal(opIdx('product.delete'), -1);
  assert.deepEqual(calls[opIdx('$transaction')].args, { maxWait: 10_000, timeout: 20_000 });

  world({ lots: 0 });
  const b = await call('DELETE', '/api/products/p1');
  assert.deepEqual([b.status, b.body.archived], [200, false]);
  assert.ok(opIdx('product.delete') > opIdx('productLot.count'));

  reset();
  scripted['product.findFirst'] = () => ({ id: 'p1' });
  const gone = await call('DELETE', '/api/products/p1');
  assert.equal(gone.status, 404, 'حُذف بين القراءتين');
  assert.equal(opIdx('invoiceItem.count'), -1);
});

test('حذف الصنف وصفّه ممسوك (convert-base حتى ١٢٠ ثانية، أو عملية لوط): مهلة قفلٍ محلية تُستعاد، وتجاوزها أو مهلة المعاملة ⇒ 503 LOT_BUSY لا 500', async () => {
  const busyCases = [
    ['55P03', 'canceling statement due to lock timeout'],
    ['P2028', 'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 20000 ms'],
  ] as const;
  for (const [code, message] of busyCases) {
    reset();
    scripted['product.findFirst'] = () => ({ id: 'p1' });
    rawScript = (sql) => {
      if (sql.includes('FROM products WHERE id =') && sql.includes('FOR UPDATE')) throw Object.assign(new Error(message), { code });
      return undefined;
    };
    const r = await call('DELETE', '/api/products/p1');
    assert.equal(r.status, 503, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'LOT_BUSY');
    assert.doesNotMatch(String(r.body.message), /Transaction|timeout/i, 'لا رسالة داخلية');
    assert.equal(opIdx('invoiceItem.count'), -1);
    assert.equal(calls.filter((c) => /\.(delete|deleteMany|update)$/.test(c.op)).length, 0, 'لا كتابة');
  }
  // المهلة المحلية حول FOR UPDATE وحده: حفظٌ ثم ٥ ثوانٍ ثم القفل ثم الاستعادة، كلها داخل المعاملة وقبل العدّ
  reset();
  scripted['product.findFirst'] = () => ({ id: 'p1' });
  rawScript = (sql) => {
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '2s' }];
    if (sql.includes('FROM products WHERE id =') && sql.includes('FOR UPDATE')) return [{ id: 'p1' }];
    return undefined;
  };
  const ok = await call('DELETE', '/api/products/p1');
  assert.deepEqual([ok.status, ok.body.archived], [200, false]);
  const save = rawIdx("current_setting('lock_timeout')");
  const set = rawIdx("set_config('lock_timeout', $1, true)");
  const lock = rawIdx('FROM products WHERE id =');
  const restore = calls.findIndex((c, i) => i > lock && String(c.args?.sql ?? '').includes("set_config('lock_timeout'"));
  assert.ok(save >= 0 && save < set && set < lock && lock < restore && restore < opIdx('invoiceItem.count'), ops().join(' → '));
  assert.ok([save, set, lock, restore].every((i) => calls[i].inTx));
  assert.equal(calls[set].args.values[0], '5s');
  assert.equal(calls[restore].args.values[0], '2s', 'المهلة السابقة تُستعاد');
});

// ═══ /api/company (§٤.١ البند ٣، D15) ═══

test('حارس نصّي: /company — العلم في الـselect نفسه، وlotOnInvoice مشروطٌ به، ولا يكتبه PUT /company ولا يعيده خاماً', () => {
  const src = strip(read('routes/company.ts'));
  assert.match(src, /cardPayEnabled: true, lotTrackingEnabled: true, locationsEnabled: true, paymentMethodsEnabled: true \}/);
  assert.match(src, /lotTrackingEnabled: tenant\?\.lotTrackingEnabled === true, lotOnInvoice: company\?\.lotOnInvoice === true && tenant\?\.lotTrackingEnabled === true/);
  const schema = src.slice(src.indexOf('const companySchema'), src.indexOf('});', src.indexOf('const companySchema')));
  assert.doesNotMatch(schema, /lotOnInvoice/);
  assert.match(fnBody(src, 'function maskCompany'), /lotOnInvoice: _lotOnInvoice/);
});

test('/company: lotOnInvoice يصل مفعّلاً مع العلم وحده، والحفظ لا يكتبه ولا يعيده', async () => {
  for (const [lots, want] of [[true, true], [false, false]] as const) {
    reset();
    scripted['companySettings.findUnique'] = () => ({ tenantId: TENANT, name: 'ش', lotOnInvoice: true, einvoiceClientSecret: 's' });
    scripted['tenant.findUnique'] = () => ({ lotTrackingEnabled: lots });
    const r = await call('GET', '/api/company');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.data.lotTrackingEnabled, r.body.data.lotOnInvoice], [lots, want]);
    assert.equal(r.body.data.einvoiceClientSecret, undefined);
    assert.equal(calls.filter((c) => c.op === 'tenant.findUnique').length, 1, 'لا استعلام إضافي');
  }
  reset();
  scripted['companySettings.upsert'] = (a) => ({ tenantId: TENANT, ...a.update, lotOnInvoice: true });
  const put = await call('PUT', '/api/company', { name: 'ش', lotOnInvoice: false });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const up = calls[opIdx('companySettings.upsert')].args;
  assert.ok(!('lotOnInvoice' in up.update) && !('lotOnInvoice' in up.create), 'لا يمحوه حفظ النموذج');
  assert.ok(!('lotOnInvoice' in put.body.data), 'ردّ الحفظ كما كان قبل الميزة');
});

// ═══ علم الشركة (§٤.١، D25) ═══

test('حارس نصّي: العلم في سكيما التحديث وحده، والحقبة بعد انتظار عمليات اللوط وقبل كتابة الشركة', () => {
  const src = strip(read('routes/tenants.ts'));
  const create = src.slice(src.indexOf('const createTenantSchema'), src.indexOf('const updateTenantSchema'));
  const update = src.slice(src.indexOf('const updateTenantSchema'), src.indexOf('});', src.indexOf('const updateTenantSchema')));
  assert.doesNotMatch(create, /lotTracking/);
  assert.match(update, /lotTrackingEnabled: z\.boolean\(\)\.optional\(\)/);
  assert.doesNotMatch(update, /lotTrackingSince/, 'الحقبة لا تُرسل من الواجهة');
  const put = routeBody(src, "router.put('/:id'");
  // المرجع السابقُ تحت قفل صفّ الشركة بعد الانتظار (الأصناف قبل الشركة)، والقراءة الأولى بلا قفل تقرّر الانتظار وحده
  ordered(put, [
    'await waitLotOperations(tx, req.params.id);', 'await lockedTenantLotFlag(tx, req.params.id)', 'data.lotTrackingSince = new Date();',
    'await tx.tenant.update(', 'await recordLotEvent(tx,',
  ], 'PUT');
  assert.match(fnBody(src, 'async function lockedTenantLotFlag('), /SELECT "lotTrackingEnabled" FROM tenants WHERE id = \$\{tid\} FOR NO KEY UPDATE/);
  const wait = fnBody(src, 'async function waitLotOperations(');
  ordered(wait, ["current_setting('lock_timeout')", "set_config('lock_timeout', ${TENANT_LOT_WAIT_TIMEOUT}, true)", '"lotTracked" = true ORDER BY id FOR UPDATE', "set_config('lock_timeout', ${prev"], 'المهلة المحلية بالحفظ والاستعادة');
  assert.doesNotMatch(wait, /SET LOCAL/);
});

const tenantRow = (o: Record<string, unknown> = {}) => ({ id: TENANT, name: 'شركة', lotTrackingEnabled: false, lotTrackingSince: null, ...o });
const TENANT_LOCK = 'FROM tenants WHERE id = $1 FOR NO KEY UPDATE';

/** علم الشركة: القراءة الأولى بلا قفل ترى `hint`، والقراءة تحت قفل صفّها ترى `locked` (ما التزمه تبديلٌ متزامن قبلنا) */
function tenantLotWorld(hint: boolean, locked: boolean = hint, raw: (sql: string) => unknown = () => undefined): void {
  scripted['tenant.findUnique'] = () => ({ lotTrackingEnabled: hint });
  rawScript = (sql) => (sql.includes(TENANT_LOCK) ? [{ lotTrackingEnabled: locked }] : raw(sql));
}

test('تفعيل الشركة: السابق داخل المعاملة، وانتظار عمليات اللوط (FOR UPDATE بمهلةٍ محلية)، ثم حقبةٌ جديدة وTRACKING_ON', async () => {
  reset();
  tenantLotWorld(false, false, (sql) => (sql.includes("current_setting('lock_timeout')") ? [{ lock_timeout: '2s' }] : undefined));
  scripted['tenant.update'] = (a) => tenantRow(a.data);
  const before = Date.now();
  const r = await call('PUT', `/api/tenants/${TENANT}`, { lotTrackingEnabled: true }, ownerToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const tx = calls.find((c) => c.op === '$transaction')!;
  assert.deepEqual(tx.args, { maxWait: 10_000, timeout: 30_000 });
  const read0 = opIdx('tenant.findUnique');
  const save = rawIdx("current_setting('lock_timeout')");
  const set = rawIdx("set_config('lock_timeout', $1, true)");
  const lock = rawIdx('"lotTracked" = true ORDER BY id FOR UPDATE');
  const upd = opIdx('tenant.update');
  const ev = opIdx('lotEvent.create');
  assert.ok(read0 < save && save < set && set < lock && lock < upd && upd < ev, ops().join(' → '));
  assert.ok([read0, lock, upd, ev].every((i) => calls[i].inTx));
  assert.deepEqual(calls[lock].args.values, [TENANT]);
  assert.equal(calls[set].args.values[0], '25s');
  const restore = calls.findIndex((c, i) => i > lock && String(c.args?.sql ?? '').includes("set_config('lock_timeout'"));
  assert.ok(restore > lock && restore < upd && calls[restore].args.values[0] === '2s', 'المهلة السابقة تُستعاد');
  // المرجع تحت قفل صفّ الشركة: بعد صفوف الأصناف وقبل كتابتها
  const tLock = rawIdx(TENANT_LOCK);
  assert.ok(restore < tLock && tLock < upd && calls[tLock].inTx, ops().join(' → '));
  assert.deepEqual(calls[tLock].args.values, [TENANT]);
  const data = calls[upd].args.data;
  assert.equal(data.lotTrackingEnabled, true);
  assert.ok(data.lotTrackingSince instanceof Date && data.lotTrackingSince.getTime() >= before);
  const e = calls[ev].args.data;
  assert.deepEqual([e.tenantId, e.lotId, e.productId, e.kind, e.actorType, e.actorId], [TENANT, null, tenantsModule.TENANT_LOT_EVENT_PRODUCT, 'TRACKING_ON', 'OWNER', 'o1']);
  assert.deepEqual(e.before, { lotTrackingEnabled: false });
});

test('الشركة: مفعّلٌ يبقى مفعّلاً بلا حقبة ولا حدث؛ والإطفاء بلا انتظار ولا حقبة وTRACKING_OFF؛ والجسم بلا العلم كما كان', async () => {
  reset();
  tenantLotWorld(true);
  scripted['tenant.update'] = (a) => tenantRow({ lotTrackingEnabled: true, ...a.data });
  assert.equal((await call('PUT', `/api/tenants/${TENANT}`, { lotTrackingEnabled: true }, ownerToken())).status, 200);
  assert.ok(!('lotTrackingSince' in calls[opIdx('tenant.update')].args.data));
  assert.equal(rawIdx('FOR UPDATE'), -1);
  assert.equal(opIdx('lotEvent.create'), -1);

  reset();
  tenantLotWorld(true);
  scripted['tenant.update'] = (a) => tenantRow({ lotTrackingSince: new Date('2026-10-01T00:00:00Z'), ...a.data });
  assert.equal((await call('PUT', `/api/tenants/${TENANT}`, { lotTrackingEnabled: false }, ownerToken())).status, 200);
  assert.equal(rawIdx('FOR UPDATE'), -1);
  assert.ok(!('lotTrackingSince' in calls[opIdx('tenant.update')].args.data), 'الإطفاء يُخفي ولا يمسّ الحقبة (D8)');
  assert.equal(calls[opIdx('lotEvent.create')].args.data.kind, 'TRACKING_OFF');

  reset();
  scripted['tenant.update'] = (a) => tenantRow(a.data);
  assert.equal((await call('PUT', `/api/tenants/${TENANT}`, { notes: 'x' }, ownerToken())).status, 200);
  assert.deepEqual(ops().filter((o) => !o.startsWith('superAdmin') && !o.startsWith('platformAuditLog')), ['$transaction', 'tenant.update']);
  assert.equal(calls.find((c) => c.op === '$transaction')!.args, undefined, 'المعاملة بمهلها القديمة');
});

test('الشركة: انتظارٌ تجاوز المهلة (55P03) ⇒ 503 LOT_BUSY ولا كتابة', async () => {
  reset();
  scripted['tenant.findUnique'] = () => ({ lotTrackingEnabled: false });
  rawScript = (sql) => {
    if (sql.includes('"lotTracked" = true ORDER BY id FOR UPDATE')) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    return undefined;
  };
  const r = await call('PUT', `/api/tenants/${TENANT}`, { lotTrackingEnabled: true }, ownerToken());
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'LOT_BUSY');
  assert.equal(opIdx('tenant.update'), -1);
});

test('تبديلان متزامنان للشركة (نقرة حفظٍ مزدوجة): المرجع ما التزمه الأول تحت قفل صفّها — لا حقبة ثانية فوق الأولى ولا حدثٌ مكرّر', async () => {
  // تفعيلان: القراءة الأولى بلا قفل ترى «مطفأ» قبل التزام الأوّل، وتحت القفل نرى ما التزمه ⇒ لا انتقال
  reset();
  tenantLotWorld(false, true);
  scripted['tenant.update'] = (a) => tenantRow({ lotTrackingEnabled: true, lotTrackingSince: new Date('2026-10-30T08:00:00Z'), ...a.data });
  const r = await call('PUT', `/api/tenants/${TENANT}`, { lotTrackingEnabled: true }, ownerToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!('lotTrackingSince' in calls[opIdx('tenant.update')].args.data), 'حقبة الأوّل لا يُكتب فوقها');
  assert.equal(r.body.data.lotTrackingSince, '2026-10-30T08:00:00.000Z');
  assert.equal(opIdx('lotEvent.create'), -1, 'لا TRACKING_ON مكرّر');
  const tLock = rawIdx(TENANT_LOCK);
  assert.ok(tLock >= 0 && rawIdx('"lotTracked" = true ORDER BY id FOR UPDATE') < tLock && tLock < opIdx('tenant.update'), 'صفوف الأصناف قبل صفّ الشركة');

  // إطفاءان: TRACKING_OFF من الأوّل وحده
  reset();
  tenantLotWorld(true, false);
  scripted['tenant.update'] = (a) => tenantRow(a.data);
  assert.equal((await call('PUT', `/api/tenants/${TENANT}`, { lotTrackingEnabled: false }, ownerToken())).status, 200);
  assert.equal(opIdx('lotEvent.create'), -1, 'لا TRACKING_OFF مكرّر');

  // إطفاءٌ التزم بين القراءتين (الأولى «مفعّل»): تفعيلنا انتقالٌ حقيقي ⇒ ينتظر عمليات اللوط ثم حقبةٌ وTRACKING_ON
  reset();
  tenantLotWorld(true, false);
  scripted['tenant.update'] = (a) => tenantRow(a.data);
  const before = Date.now();
  assert.equal((await call('PUT', `/api/tenants/${TENANT}`, { lotTrackingEnabled: true }, ownerToken())).status, 200);
  const wait = rawIdx('"lotTracked" = true ORDER BY id FOR UPDATE');
  assert.ok(rawIdx(TENANT_LOCK) < wait && wait < opIdx('tenant.update'), ops().join(' → '));
  const since = calls[opIdx('tenant.update')].args.data.lotTrackingSince;
  assert.ok(since instanceof Date && since.getTime() >= before);
  const e = calls[opIdx('lotEvent.create')].args.data;
  assert.deepEqual([e.kind, e.before], ['TRACKING_ON', { lotTrackingEnabled: false }]);
});

// ═══ حذف الشركة (§٤.١٩، D31) ═══

test('D31 بحساب اليوم: أقدم انتهاءٍ محفوظ قبل ١٨٠ يوماً بتاريخ UTC، والتأكيد «1» وحده', () => {
  const { lotRecordsKeepFrom, isLotRecordsConfirmed, lotRecordsRetainedWhere, LOT_RECORDS_RETENTION_DAYS } = tenantsModule;
  assert.equal(LOT_RECORDS_RETENTION_DAYS, 180);
  assert.equal(lotRecordsKeepFrom(new Date('2026-10-30T23:30:00Z')).toISOString(), '2026-05-03T00:00:00.000Z');
  assert.equal(lotRecordsKeepFrom(new Date('2026-10-30T00:10:00Z')).toISOString(), '2026-05-03T00:00:00.000Z');
  for (const v of ['1', ['1']]) assert.equal(isLotRecordsConfirmed(v), true);
  for (const v of [undefined, '', '0', 'true', ['1', '1'], 1]) assert.equal(isLotRecordsConfirmed(v), false, String(v));
  const keep = new Date('2026-05-03T00:00:00Z');
  assert.deepEqual(lotRecordsRetainedWhere('T', keep), {
    tenantId: 'T',
    OR: [{ expiryDate: null }, { expiryDate: { gte: keep } }],
    AND: [{ OR: [{ vanLoadItemLots: { some: {} } }, { invoiceItemLots: { some: {} } }] }],
  });
});

test('حارس نصّي: D31 بعد حرّاس الفوترة والدفاتر وقبل المعاملة، وجداول اللوط تُحذف قبل الأصناف بالترتيب', () => {
  const src = strip(read('routes/tenants.ts'));
  const del = routeBody(src, "router.delete('/:id'");
  ordered(del, [
    'tenantDeleteArchiveBlock(', 'tenantDeleteRetentionGuard(', 'isLedgerDestroyConfirmed(req.query.confirmLedgerDestroy)',
    'if (!isLotRecordsConfirmed(req.query.confirmLotRecords)) {', 'prisma.productLot.count({ where: lotRecordsRetainedWhere(tid, keepFrom) })', "lotErr('LOT_RECORDS_RETAINED'",
    'await prisma.$transaction(async (tx) => {', 'await acquirePostLock(tx, tid);',
    'await tx.invoiceItem.deleteMany(', 'await tx.lotRelabel.deleteMany({ where: { tenantId: tid } });',
    'await tx.vanLoadItemLot.deleteMany({ where: { tenantId: tid } });',
    'await tx.warehouseEntryItem.updateMany({ where: { entry: { tenantId: tid }, lotId: { not: null } }, data: { lotId: null } });',
    'await tx.productLot.deleteMany({ where: { tenantId: tid } });', 'await tx.product.deleteMany(', 'await tx.tenant.delete(',
  ], 'حذف الشركة');
  assert.equal(del.split('productLot.count(').length - 1, 1, 'عدٌّ واحد');
});

test('حذف الشركة: سجلات تشغيلاتٍ حديثة ⇒ 409 LOT_RECORDS_RETAINED قبل أي حذف؛ وبالتأكيد لا عدّ، واللوط يُحذف قبل الأصناف', async () => {
  const world = (retained: number) => {
    reset();
    scripted['tenant.findUnique'] = () => tenantRow();
    scripted['productLot.count'] = () => retained;
  };
  world(3);
  const r = await call('DELETE', `/api/tenants/${TENANT}`, undefined, ownerToken());
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LOT_RECORDS_RETAINED');
  assert.equal(r.body.detail.lots, 3);
  assert.equal(r.body.detail.retentionDays, 180);
  assert.match(r.body.detail.expiryFrom, /^\d{4}-\d{2}-\d{2}$/);
  const where = calls[opIdx('productLot.count')].args.where;
  assert.equal(where.tenantId, TENANT);
  assert.ok(where.OR[1].expiryDate.gte instanceof Date);
  assert.equal(opIdx('$transaction'), -1, 'لا معاملة ولا حذف');
  assert.equal(calls.filter((c) => /\.(delete|deleteMany)$/.test(c.op)).length, 0);

  for (const [url, retained] of [[`/api/tenants/${TENANT}?confirmLotRecords=1`, 3], [`/api/tenants/${TENANT}`, 0]] as const) {
    world(retained);
    const ok = await call('DELETE', url, undefined, ownerToken());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    if (url.includes('confirmLotRecords')) assert.equal(opIdx('productLot.count'), -1, 'لا عدّ بعد التأكيد');
    const seq = ['invoiceItem.deleteMany', 'lotRelabel.deleteMany', 'vanLoadItemLot.deleteMany', 'warehouseEntryItem.updateMany', 'productLot.deleteMany', 'product.deleteMany', 'tenant.delete']
      .map((o) => opIdx(o));
    assert.ok(seq.every((i, k) => i >= 0 && (k === 0 || i > seq[k - 1])), ops().join(' → '));
    assert.ok(seq.every((i) => calls[i].inTx));
    for (const o of ['lotRelabel.deleteMany', 'vanLoadItemLot.deleteMany', 'productLot.deleteMany']) assert.deepEqual(calls[opIdx(o)].args, { where: { tenantId: TENANT } }, o);
    assert.deepEqual(calls[opIdx('warehouseEntryItem.updateMany')].args, { where: { entry: { tenantId: TENANT }, lotId: { not: null } }, data: { lotId: null } });
  }
});
