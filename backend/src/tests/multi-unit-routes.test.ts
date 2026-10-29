// الوحدات المتعددة (docs/multi-unit/DESIGN.md) — مسارات الأصناف والفواتير عبر الموجّهين الحقيقيّين بعميل Prisma مزيّف
// (بلا قاعدة بيانات). يثبت:
//   • تحويل وحدة الأساس: داخل معاملةٍ بقفل صفّ الصنف، أرقام التاريخ المطبوعة لا تتغيّر والمعاملات تُضرب بـF، والأسعار
//     لوحدة الأساس تُقسم، والتحويل المزدوج يُردّ 409 — والشركة شرطٌ في كل جملة.
//   • وحدات الصنف: unitProblem والأساس بين «الأخريات»، وعزل الشركة في كل استعلام.
//   • المرتجع المرتبط يُسعَّر على الخادم من بند البيع (٢٤ حبّة فرادى = قيمة الكرتون)، ويُعاد تسعيره تحت القفل.
//   • لقطة الجهاز في إعادة الرفع (القاعدة ٧)، وكشف الكاش القديم في الإصدار الحيّ، وحارس السعر بسعر العميل × المعامل.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { formatQty, type UnitDef } from '../services/units';

// ═══ حقن البدائل قبل تحميل الموجّهات (كنمط invoices-arm-cutover-route.test.ts) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Raw = { kind: '$queryRaw' | '$executeRaw'; sql: string; values: unknown[]; inTx: boolean };
let calls: string[] = [];
let raws: Raw[] = [];
let inTx = false;
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (r: Raw) => unknown = () => undefined;

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
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(key);
        const r: Raw = { kind: key, sql: strings.join('?'), values, inTx };
        raws.push(r);
        const out = rawScript(r);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return modelProxy(key);
  },
});

const TENANT = 'T1';
let currentUser: { id: string; role: string; tenantId: string } = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();

stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا مرحلة ثانية في هذه الاختبارات'); } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const invoicesModule = require('../routes/invoices') as typeof import('../routes/invoices');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const productsModule = require('../routes/products') as typeof import('../routes/products');
const { resolveLineUnit } = invoicesModule;
const { baseConversionProblem } = productsModule;

// ═══ العُدّة ═══

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/invoices', invoicesModule.default);
  app.use('/api/products', productsModule.default);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ success: false, message: err.message });
  });
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'GET' | 'PUT' | 'DELETE', url: string, o: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const s = await startServer();
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: url, agent: false,
      headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...(o.headers ?? {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function reset(): void {
  calls = []; raws = []; inTx = false; scripted = {}; rawScript = () => undefined;
  currentUser = { id: 'admin-1', role: 'ADMIN', tenantId: TENANT };
}

/** إسنادات SET في جملة UPDATE (ما بين SET وFROM) — أسماء الأعمدة التي تُكتب. العمود المُسنَد غير مؤهَّل باسم الجدول،
 *  والمقارنات داخل CASE مؤهَّلة (t."baseMinQty" = 0) فلا تُعدّ */
function assignedColumns(sql: string): string[] {
  const set = sql.slice(sql.indexOf('SET'), sql.indexOf('FROM'));
  return [...set.matchAll(/(?<![.\w])"(\w+)"\s*=(?!=)/g)].map(m => m[1]);
}

// ═══ (١) تحويل وحدة الأساس ═══

type UnitRow = { id: string; tenantId: string; productId: string; name: string; factor: number; price: number | null; unitCode: string | null; isActive: boolean; sortOrder: number };
type ItemRow = {
  productId: string; qty: number; unitName: string | null; unitFactor: number; baseQty: number | null; unitPrice: number; lineTotal: number;
  unitCode?: string | null; suggestedQty?: number | null; expectedQty?: number | null;
};

/** صنفٌ بتاريخ: كرتون أساسٌ (٢٤ ريالاً) وطبليةٌ = ٥٠ كرتوناً، وصفوفٌ في الجداول الأربعة */
function productWorld() {
  const product = { id: 'p1', tenantId: TENANT, unit: 'كرتون', basePrice: 24, unitCode: 'CT', name: 'ماء' };
  const units: UnitRow[] = [{ id: 'u-pal', tenantId: TENANT, productId: 'p1', name: 'طبلية', factor: 50, price: 1000, unitCode: null, isActive: true, sortOrder: 0 }];
  const tables: Record<string, ItemRow[]> = {
    invoice_items: [
      { productId: 'p1', qty: 2, unitName: null, unitFactor: 1, baseQty: 2, unitPrice: 24, lineTotal: 48 },
      { productId: 'p1', qty: 1, unitName: 'طبلية', unitFactor: 50, baseQty: 50, unitPrice: 1000, lineTotal: 1000 },
      { productId: 'p1', qty: 3, unitName: null, unitFactor: 1, baseQty: null, unitPrice: 24, lineTotal: 72 }, // صفٌّ لم يملأه الترحيل
    ],
    van_load_items: [{ productId: 'p1', qty: 10, unitName: null, unitFactor: 1, baseQty: 10, unitPrice: 0, lineTotal: 0 }],
    warehouse_entry_items: [{ productId: 'p1', qty: 40, unitName: null, unitFactor: 1, baseQty: 40, unitPrice: 0, lineTotal: 0 }],
    rep_stock_request_items: [{ productId: 'p1', qty: 5, unitName: null, unitFactor: 1, baseQty: 5, unitPrice: 0, lineTotal: 0 }],
  };
  const tiers = [{ productId: 'p1', minQty: 10, maxQty: null as number | null, baseMinQty: 0, baseMaxQty: null as number | null, price: 22 }];
  const customerPriceUpdates: unknown[] = [];

  const view = () => ({ ...product, units: units.map(u => ({ ...u })) });
  scripted = {
    'product.findFirst': (args) => {
      if (args?.where?.id !== product.id || args?.where?.tenantId !== TENANT) return null;
      return view();
    },
    'product.updateMany': (args) => {
      if (args?.where?.id !== product.id || args?.where?.tenantId !== TENANT) return { count: 0 };
      const d = args.data ?? {};
      if (d.unit !== undefined) product.unit = d.unit;
      if (d.basePrice !== undefined) product.basePrice = d.basePrice;
      if (d.unitCode !== undefined) product.unitCode = d.unitCode;
      return { count: 1 };
    },
    'productUnit.updateMany': (args) => {
      const w = args?.where ?? {};
      const mine = units.filter(u => u.productId === w.productId && u.tenantId === w.tenantId && (!w.id || u.id === w.id));
      for (const u of mine) {
        const d = args.data;
        if (d.factor?.multiply) u.factor *= d.factor.multiply; else if (typeof d.factor === 'number') u.factor = d.factor;
        if (d.sortOrder?.increment) u.sortOrder += d.sortOrder.increment; else if (typeof d.sortOrder === 'number') u.sortOrder = d.sortOrder;
        if (d.isActive !== undefined) u.isActive = d.isActive;
        if (d.name !== undefined) u.name = d.name;
        if (d.price !== undefined) u.price = d.price;
      }
      return { count: mine.length };
    },
    'productUnit.create': (args) => { const u = { id: `u-${units.length + 1}`, ...args.data }; units.push(u); return u; },
    'productUnit.findFirst': (args) => units.find(u => u.id === args?.where?.id && u.tenantId === args?.where?.tenantId) ?? null,
    'productUnit.deleteMany': (args) => {
      const i = units.findIndex(u => u.id === args?.where?.id && u.productId === args?.where?.productId && u.tenantId === args?.where?.tenantId);
      if (i < 0) return { count: 0 };
      units.splice(i, 1);
      return { count: 1 };
    },
    'customerPrice.updateMany': (args) => { customerPriceUpdates.push(args); return { count: 2 }; },
  };
  // جمل الصفوف الأربعة وجملة الشرائح: تُنفَّذ على الذاكرة بالقيم التي مرّرها الموجّه (لا بأرقام الاختبار)
  rawScript = (r) => {
    if (r.kind !== '$executeRaw') return undefined;
    const table = /UPDATE "(\w+)"/.exec(r.sql)?.[1] ?? '';
    if (table === 'price_tiers') {
      const F = Number(r.values[0]);
      for (const t of tiers) {
        t.price = t.price / F;
        t.baseMinQty = (t.baseMinQty === 0 && t.minQty !== 0 ? t.minQty : t.baseMinQty) * F;
        t.baseMaxQty = (t.baseMaxQty ?? t.maxQty) == null ? null : (t.baseMaxQty ?? t.maxQty)! * F;
      }
      return tiers.length;
    }
    const rows = tables[table];
    if (!rows) return 0;
    // الاسم والمعامل (للمعامل وللأساس) أوّلاً، والشركة والصنف آخراً — وبينهما ما يخصّ الجدول:
    // رمز الوحدة الضريبي لبند الفاتورة (القاعدة ١٠)، والمعامل للاقتراح والتنبّؤ في بند التحميل (بالأساس دائماً)
    const v = r.values as unknown[];
    const [oldUnit, F, F2] = v as [string, number, number];
    const tid = v[v.length - 2] as string;
    const pid = v[v.length - 1] as string;
    assert.equal(F, F2, 'المعامل نفسه للمعامل والأساس');
    if (tid !== TENANT) return 0;
    const mine = rows.filter(x => x.productId === pid);
    for (const x of mine) {
      const f = x.unitFactor > 0 ? x.unitFactor : 1;
      x.unitName = x.unitName ?? oldUnit;
      x.unitFactor = f * F;
      x.baseQty = x.qty * f * F;
      if (table === 'invoice_items') x.unitCode = x.unitCode ?? (v[3] as string | null);
      if (table === 'van_load_items') {
        x.suggestedQty = x.suggestedQty == null ? x.suggestedQty : x.suggestedQty * (v[3] as number);
        x.expectedQty = x.expectedQty == null ? x.expectedQty : x.expectedQty * (v[4] as number);
      }
    }
    return mine.length;
  };
  return { product, units, tables, tiers, customerPriceUpdates };
}

const CONVERT = { newBaseName: 'حبة', factor: 24, expectedBaseName: 'كرتون' };

test('التحويل: أرقام التاريخ المطبوعة لا تتغيّر، والمعاملات تُضرب، والأساس من جديد — في الجداول الأربعة', async () => {
  reset();
  const w = productWorld();
  const before = JSON.parse(JSON.stringify(w.tables)) as typeof w.tables;
  const r = await call('POST', '/api/products/p1/convert-base', { body: CONVERT });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  for (const [table, rows] of Object.entries(w.tables)) {
    rows.forEach((x, i) => {
      const was = before[table][i];
      assert.equal(x.qty, was.qty, `${table}: الكمية المطبوعة`);
      assert.equal(x.unitPrice, was.unitPrice, `${table}: سعر الوحدة`);
      assert.equal(x.lineTotal, was.lineTotal, `${table}: إجمالي البند`);
      assert.equal(x.unitName, was.unitName ?? 'كرتون', `${table}: اللقطة تحمل الاسم القديم`);
      assert.equal(x.unitFactor, (was.unitFactor || 1) * 24, `${table}: المعامل × F`);
      assert.equal(x.baseQty, was.qty * (was.unitFactor || 1) * 24, `${table}: الأساس الجديد`);
    });
  }
  // العرض بالوحدات بعد التحويل: «٢ كرتون» تبقى ٢ كرتون، والطبلية طبلية
  const unitsAfter = w.units as UnitDef[];
  assert.equal(formatQty(w.tables.invoice_items[0].baseQty!, unitsAfter, 'حبة'), '2 كرتون');
  assert.equal(formatQty(w.tables.invoice_items[1].baseQty!, unitsAfter, 'حبة'), '1 طبلية');
  assert.equal(formatQty(w.tables.invoice_items[2].baseQty!, unitsAfter, 'حبة'), '3 كرتون', 'الصفّ بلا baseQty يُحسب من لقطته');

  // كل جملة: داخل المعاملة، تكتب اللقطة وحدها، ومقيّدة بالصنف والشركة عبر رأس مستندها
  const heads: Record<string, [string, string]> = {
    invoice_items: ['invoices', 'invoiceId'], van_load_items: ['van_loads', 'vanLoadId'],
    warehouse_entry_items: ['warehouse_entries', 'entryId'], rep_stock_request_items: ['rep_stock_requests', 'requestId'],
  };
  for (const [table, [head, fk]] of Object.entries(heads)) {
    const stmt = raws.find(x => x.kind === '$executeRaw' && x.sql.includes(`UPDATE "${table}"`));
    assert.ok(stmt, `لا جملة على ${table}`);
    assert.equal(stmt!.inTx, true, `${table} خارج المعاملة`);
    const cols: Record<string, string[]> = {
      invoice_items: ['unitName', 'unitFactor', 'baseQty', 'unitCode'],
      van_load_items: ['unitName', 'unitFactor', 'baseQty', 'suggestedQty', 'expectedQty'],
    };
    assert.deepEqual(assignedColumns(stmt!.sql), cols[table] ?? ['unitName', 'unitFactor', 'baseQty'], `${table}: يكتب اللقطة وحدها`);
    assert.ok(stmt!.sql.includes(`FROM "${head}" AS d`) && stmt!.sql.includes(`r."${fk}" = d.id`), `${table}: عبر رأس المستند`);
    assert.match(stmt!.sql, /d\."tenantId" = \?/, `${table}: قيد الشركة`);
    assert.match(stmt!.sql, /r\."productId" = \?/, `${table}: قيد الصنف`);
    assert.deepEqual(stmt!.values.slice(-2), [TENANT, 'p1'], `${table}: الشركة والصنف`);
  }
  // القفل أوّلاً: FOR UPDATE على صفّ الصنف قبل أيّ كتابة
  const lockAt = raws.findIndex(x => x.kind === '$queryRaw' && /FROM products WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(x.sql));
  const firstWrite = raws.findIndex(x => x.kind === '$executeRaw');
  assert.ok(lockAt >= 0 && lockAt < firstWrite, 'قفل صفّ الصنف قبل الكتابة');
  assert.deepEqual(raws[lockAt].values, ['p1', TENANT]);
});

test('التحويل: الوحدات تُضرب والقديمة وحدةٌ بسعرها، والأسعار لوحدة الأساس تُقسم، والأساس الجديد وسعره', async () => {
  reset();
  const w = productWorld();
  const r = await call('POST', '/api/products/p1/convert-base', { body: CONVERT });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pal = w.units.find(u => u.id === 'u-pal')!;
  assert.equal(pal.factor, 1200, 'الطبلية = ٥٠ كرتون = ١٢٠٠ حبة');
  assert.equal(pal.price, 1000, 'سعر الطبلية لا يتغيّر');
  const ct = w.units.find(u => u.name === 'كرتون')!;
  assert.deepEqual({ factor: ct.factor, price: ct.price, unitCode: ct.unitCode, isActive: ct.isActive, tenantId: ct.tenantId, productId: ct.productId },
    { factor: 24, price: 24, unitCode: 'CT', isActive: true, tenantId: TENANT, productId: 'p1' }, 'الكرتون بسعره القديم ورمز الصنف');
  assert.ok(ct.sortOrder < pal.sortOrder, 'الكرتون أوّلاً: وحدة البيع المعتادة');
  assert.equal(w.product.unit, 'حبة');
  assert.equal(w.product.basePrice, 1, '٢٤ ÷ ٢٤ بأربع منازل');
  assert.equal(w.product.unitCode, 'CT', 'رمز الصنف كما هو بلا baseUnitCode');
  // سعر العميل ÷ F مقيّداً بالصنف والشركة
  assert.deepEqual(w.customerPriceUpdates, [{ where: { productId: 'p1', product: { tenantId: TENANT } }, data: { price: { divide: 24 } } }]);
  // الشريحة: السعر ÷ F، والحدّ الذي لم يملأه الترحيل يُحسب من القديم × F
  assert.deepEqual(w.tiers[0], { productId: 'p1', minQty: 10, maxQty: null, baseMinQty: 240, baseMaxQty: null, price: 22 / 24 });
  const tierStmt = raws.find(x => x.sql.includes('UPDATE "price_tiers"'))!;
  assert.deepEqual(assignedColumns(tierStmt.sql), ['price', 'baseMinQty', 'baseMaxQty']);
  assert.match(tierStmt.sql, /p\."tenantId" = \?/);
  // الردّ: الصنف بوحداته وعدّاد ما حُوّل
  assert.equal(r.body.data.unit, 'حبة');
  assert.equal(r.body.converted.factor, 24);
  assert.equal(r.body.converted.invoiceItems, 3);
  assert.equal(r.body.converted.customerPrices, 2);
  // سعر الكرتون للعميل بعد التحويل = سعره قبله (السعر لوحدة الأساس × المعامل)
  assert.ok(Math.abs((18 / 24) * 24 - 18) < 1e-9);
});

test('التحويل المزدوج يُرفض 409 ولا يُضرب بـF ثانيةً، والسعر المرسل ورمز الأساس يُحترمان', async () => {
  reset();
  const w = productWorld();
  const first = await call('POST', '/api/products/p1/convert-base', { body: { ...CONVERT, basePrice: 1.1, baseUnitCode: 'PCE' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(w.product.basePrice, 1.1);
  assert.equal(w.product.unitCode, 'PCE');
  const writes = raws.filter(x => x.kind === '$executeRaw').length;
  const again = await call('POST', '/api/products/p1/convert-base', { body: { ...CONVERT, basePrice: 1.1 } });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'BASE_UNIT_CHANGED');
  assert.equal(raws.filter(x => x.kind === '$executeRaw').length, writes, 'كتابةٌ بعد الرفض');
  assert.equal(w.tables.invoice_items[0].unitFactor, 24, 'المعامل لم يُضرب مرّتين');
  assert.equal(w.units.find(u => u.id === 'u-pal')!.factor, 1200);
});

test('التحويل: المعامل صحيحٌ ≥ ٢ ولا يتجاوز الحدّ بعد الضرب، والاسم جديدٌ غير مكرّر، وصنف شركةٍ أخرى ٤٠٤', async () => {
  for (const [body, re] of [
    [{ ...CONVERT, factor: 1 }, /أكبر من ١/],
    [{ ...CONVERT, factor: 2.5 }, /عدد صحيح/],
    [{ ...CONVERT, newBaseName: 'طبلية' }, /مستخدم لوحدة أخرى/],
    [{ ...CONVERT, newBaseName: 'كرتون' }, /الحالية نفسها/],
    [{ ...CONVERT, newBaseName: '  ' }, /مطلوب/],
    [{ ...CONVERT, factor: 2001 }, /يتجاوز 100000 بعد التحويل/],
  ] as const) {
    reset();
    productWorld();
    const r = await call('POST', '/api/products/p1/convert-base', { body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} ⇒ ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.message), re);
    assert.equal(raws.some(x => x.kind === '$executeRaw'), false, 'كتابةٌ رغم الرفض');
  }
  reset();
  productWorld();
  const other = await call('POST', '/api/products/p-other/convert-base', { body: CONVERT });
  assert.equal(other.status, 404);
  // صرفةٌ: الحدّ بعد الضرب
  assert.equal(baseConversionProblem({ unit: 'كرتون', units: [] }, { newBaseName: 'حبة', factor: 100000 }), null);
  assert.match(String(baseConversionProblem({ unit: 'كرتون', units: [] }, { newBaseName: 'حبة', factor: 100001 })), /لا يتجاوز/);
});

// ═══ (٢) وحدات الصنف ═══

test('وحدات الصنف: الإضافة بـunitProblem والأساس بين «الأخريات»، وكل استعلامٍ بالشركة', async () => {
  reset();
  const w = productWorld();
  const ok = await call('POST', '/api/products/p1/units', { body: { name: ' شدة ', factor: 6, price: '' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const created = w.units.find(u => u.name === 'شدة')!;
  assert.deepEqual({ tenantId: created.tenantId, productId: created.productId, factor: created.factor, price: created.price },
    { tenantId: TENANT, productId: 'p1', factor: 6, price: null });
  assert.ok(calls.includes('product.updateMany'), 'طابع تعديل الصنف للمزامنة');
  assert.ok(raws.some(x => /FOR UPDATE/.test(x.sql)), 'قفل صفّ الصنف');

  for (const [body, re] of [
    [{ name: 'كرتون', factor: 12 }, /مكرر/], // اسم الأساس
    [{ name: 'علبة', factor: 1 }, /بالمعامل نفسه/], // معامل الأساس
    [{ name: 'علبة', factor: 2.5 }, /عدد صحيح/],
    [{ name: 'علبة', factor: 50 }, /بالمعامل نفسه/], // معامل الطبلية
    [{ name: '', factor: 4 }, /مطلوب/],
  ] as const) {
    reset();
    productWorld();
    const r = await call('POST', '/api/products/p1/units', { body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} ⇒ ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.message), re);
    assert.equal(calls.includes('productUnit.create'), false);
  }
  reset();
  productWorld();
  assert.equal((await call('POST', '/api/products/p-other/units', { body: { name: 'علبة', factor: 4 } })).status, 404);
});

test('وحدات الصنف: التعديل والإيقاف والحذف مقيّدة بالصنف والشركة، والمجهولة ٤٠٤', async () => {
  reset();
  const w = productWorld();
  let seen: any = null;
  const inner = scripted['productUnit.updateMany'];
  scripted['productUnit.updateMany'] = (args) => { seen = args; return inner(args); };
  const off = await call('PUT', '/api/products/p1/units/u-pal', { body: { isActive: false, price: 950 } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(seen.where, { id: 'u-pal', productId: 'p1', tenantId: TENANT });
  assert.equal(w.units[0].isActive, false);
  assert.equal(w.units[0].price, 950);
  assert.equal((await call('PUT', '/api/products/p1/units/u-x', { body: { isActive: false } })).status, 404);
  assert.equal((await call('PUT', '/api/products/p1/units/u-pal', { body: { factor: 1 } })).status, 400, 'معامل الأساس');

  let delWhere: any = null;
  const del = scripted['productUnit.deleteMany'];
  scripted['productUnit.deleteMany'] = (args) => { delWhere = args.where; return del(args); };
  assert.equal((await call('DELETE', '/api/products/p1/units/u-x')).status, 404);
  const gone = await call('DELETE', '/api/products/p1/units/u-pal');
  assert.equal(gone.status, 200);
  assert.deepEqual(delWhere, { id: 'u-pal', productId: 'p1', tenantId: TENANT });
  assert.equal(w.units.length, 0);
});

test('القائمة والتفصيل يُرفقان الوحدات مرتّبة، والشرائح تُكتب بعموديها', async () => {
  reset();
  const seen: any[] = [];
  scripted = {
    'product.findMany': (args) => { seen.push(args); return []; },
    'product.findFirst': (args) => { seen.push(args); return args?.select ? { id: 'p1' } : { id: 'p1', units: [] }; },
    'priceTier.create': (args) => { seen.push(args); return {}; },
    'product.update': () => ({}),
  };
  assert.equal((await call('GET', '/api/products')).status, 200);
  assert.equal((await call('GET', '/api/products/p1')).status, 200);
  const order = [{ sortOrder: 'asc' }, { factor: 'asc' }];
  assert.deepEqual(seen[0].include.units, { orderBy: order });
  assert.deepEqual(seen[1].include.units, { orderBy: order });
  const r = await call('PUT', '/api/products/p1/price-tiers', { body: { tiers: [{ minQty: 10, maxQty: 49, price: 9 }, { minQty: 50, price: 8, baseMinQty: 1200 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const tiers = seen.filter(a => a?.data?.price != null).map(a => a.data);
  assert.deepEqual(tiers, [
    { productId: 'p1', minQty: 10, maxQty: 49, price: 9, baseMinQty: 10, baseMaxQty: 49 },
    { productId: 'p1', minQty: 50, maxQty: null, price: 8, baseMinQty: 1200, baseMaxQty: null },
  ]);
});

// ═══ (٣) وحدة البند: لقطة الجهاز في إعادة الرفع والكاش القديم في الحيّ ═══

const CONVERTED = {
  name: 'ماء', unit: 'حبة',
  units: [
    { id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true },
    { id: 'u-sh', name: 'شدة', factor: 6, price: null, unitCode: null, isActive: false },
  ],
};
const never = async () => false;

test('إعادة الرفع: لقطة الجهاز تُكتب بعد التحقّق أنها للصنف — والأساس المحوَّل بعد الإصدار يُقرأ بمعامل وحدته', async () => {
  const replay = { replay: true, seenInHistory: never };
  const u = async (item: Record<string, unknown>, o = replay) => {
    const r = await resolveLineUnit(CONVERTED, item, o);
    assert.equal(r.ok, true, JSON.stringify(r));
    return (r as { unit: { unitName: string | null; unitFactor: number; unitCode: string | null } }).unit;
  };
  // «٢ كرتون» صدرت والكرتون أساس (معامل ١)، ثم حُوّل الصنف إلى حبة: تُكتب كرتوناً بمعامل ٢٤ لا حبّتين
  assert.deepEqual(await u({ unitName: 'كرتون', unitFactor: 1 }), { unitName: 'كرتون', unitFactor: 24, unitCode: 'CT', priceUnit: CONVERTED.units[0] });
  // تغيّر معامل الكرتون بعد الإصدار: معامل الجهاز يغلب، ولا يُسعَّر بسعر الوحدة المحدَّد لمعاملٍ آخر
  const changed = await u({ unitId: 'u-ct', unitName: 'كرتون', unitFactor: 12 });
  assert.equal(changed.unitFactor, 12);
  assert.equal((changed as { priceUnit: unknown }).priceUnit, null);
  // وحدةٌ أُوقفت بعد الإصدار: لا يُرفض بها المستند
  assert.equal((await u({ unitId: 'u-sh', unitName: 'شدة', unitFactor: 6 })).unitFactor, 6);
  assert.equal((await u({ unitId: 'u-sh' })).unitFactor, 6, 'بلا لقطة: معامل الوحدة الموقوفة');
  // وحدةٌ حُذفت: يشهد لها التاريخ وإلّا فلا
  assert.equal((await u({ unitName: 'علبة', unitFactor: 4 }, { replay: true, seenInHistory: async (n, f) => n === 'علبة' && f === 4 })).unitFactor, 4);
  // معاملٌ لا شاهد له لا يُكتب **ولا يُقيَّد بالأساس**: «٤ علب» حبّاتٍ أربعاً بدل ستّ عشرة خطأٌ ماليٌّ صامت.
  // يُرفض ظاهراً في صندوق الإرسال (القرار المدوّن في DESIGN.md) فيراجعه المشرف ولا يضيع المستند
  const gone = await resolveLineUnit(CONVERTED, { unitName: 'علبة', unitFactor: 4 }, replay);
  assert.deepEqual(((r: unknown) => [(r as { ok: boolean }).ok, (r as { status?: number }).status, (r as { code?: string }).code])(gone), [false, 400, 'UNIT_INVALID'], 'معاملٌ لا شاهد له لا يُكتب ولا يُقيَّد بالأساس');
  // لقطة تالفة تُهمل ولا تُرفض؛ ولقطة الأساس أساس
  assert.equal((await u({ unitId: 'u-ct', unitFactor: 0 })).unitFactor, 24);
  assert.equal((await u({ unitName: 'حبة', unitFactor: 1 })).unitFactor, 1);
  assert.equal((await u({})).unitFactor, 1, 'جسم ما قبل الميزة');
});

/**
 * الحيّ: وحدةٌ غير صالحة بأيّ وجه ⇒ 400 UNIT_INVALID موحّداً (القرار المدوّن في DESIGN.md).
 * والمعرّف الذي لا يخصّ الصنف لا يُقرأ أساساً: الصمت يحمّل كرتوناً على أنه حبّة.
 */
test('الإصدار الحيّ: الخادم يحلّ الوحدة، والموقوفة والكاش القديم ومعرّف صنفٍ آخر ٤٠٠ UNIT_INVALID', async () => {
  const live = { replay: false, seenInHistory: async () => { throw new Error('التاريخ لا يُقرأ في الحيّ'); } };
  const ok = await resolveLineUnit(CONVERTED, { unitId: 'u-ct' }, live);
  assert.deepEqual(ok, { ok: true, unit: { unitName: 'كرتون', unitFactor: 24, unitCode: 'CT', priceUnit: CONVERTED.units[0] } });
  assert.deepEqual(await resolveLineUnit(CONVERTED, { unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24 }, live), ok, 'لقطةٌ مطابقة');
  const off = await resolveLineUnit(CONVERTED, { unitId: 'u-sh' }, live);
  assert.deepEqual(((r: unknown) => [(r as { ok: boolean }).ok, (r as { status?: number }).status, (r as { code?: string }).code])(off), [false, 400, 'UNIT_INVALID'], 'الموقوفة');
  for (const stale of [
    { unitId: 'u-ct', unitName: 'كرتون', unitFactor: 12 }, // المعامل تغيّر
    { unitName: 'كرتون', unitFactor: 1 }, // يرى الكرتون أساساً — حُوّل الصنف بعد كاشه
    { unitId: 'u-gone', unitName: 'علبة', unitFactor: 4 }, // وحدةٌ حُذفت
  ]) {
    const r = await resolveLineUnit(CONVERTED, stale, live);
    assert.deepEqual(((r: unknown) => [(r as { ok: boolean }).ok, (r as { status?: number }).status, (r as { code?: string }).code])(r), [false, 400, 'UNIT_INVALID'], JSON.stringify(stale));
    // والرسالة تقول للمندوب ما يفعل: حدّث قائمة الأصناف
    assert.match(String((r as { message?: string }).message), /حدّث قائمة الأصناف/);
  }
  // المرتجع المرتبط بفاتورة بيع يقبل الوحدة الموقوفة: بيعت شِدّات ثم أُوقفت، فإرجاعها بوحدتها مشروع
  const returned = await resolveLineUnit(CONVERTED, { unitId: 'u-sh' }, { ...live, allowInactive: true });
  assert.equal(returned.ok, true, JSON.stringify(returned));
  assert.equal((returned as { unit: { unitFactor: number } }).unit.unitFactor, 6);
  const foreign = await resolveLineUnit(CONVERTED, { unitId: 'u-of-another-product' }, live);
  assert.deepEqual(((r: unknown) => [(r as { ok: boolean }).ok, (r as { status?: number }).status, (r as { code?: string }).code])(foreign), [false, 400, 'UNIT_INVALID'], 'معرّف صنفٍ آخر لا يُقرأ أساساً');
  assert.deepEqual(await resolveLineUnit({ name: 'x', unit: 'حبة' }, {}, live), { ok: true, unit: { unitName: null, unitFactor: 1, unitCode: null, priceUnit: null } }, 'صنفٌ بلا وحدات');
});

// ═══ (٤) مسار الإصدار ═══

const CUSTOMER = { id: 'c1', tenantId: TENANT, name: 'بقالة', status: 'ACTIVE', balance: 0, creditLimit: 0 };
const REP = {
  id: 'rep-1', tenantId: TENANT, canCreateInvoice: true, canSellOnCredit: true, canSellInCash: true, canSellOnInstallment: true,
  canChangePrice: false, canSellBelowPrice: false, canSellWithoutStock: true, maxDiscountPct: 0, locationId: null,
  tenant: { locationsEnabled: false, settings: { teamsEnabled: false } }, teamMemberships: [],
};
const PRODUCT = {
  id: 'p1', name: 'ماء', unit: 'حبة', basePrice: 10 / 24, taxPct: 15, damagedReturnToStock: true, priceTiers: [] as { price: number; baseMinQty: number }[],
  units: [{ id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true }],
  shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null, shelfLifeBasis: 'SALE', shelfLifeFromDate: null,
  returnRuleEnabled: false, returnRuleMode: null, returnRuleMetric: null, returnRuleValue: null, teams: [],
};

/** بيع كرتونٍ واحد بعشرة ريالات (بند si-1)، وما رُدّ منه بالحبة قبل المرتجع — وتحت القفل إن اختلف (مرتجعٌ متزامن) */
function issueWorld(o: { returnedBefore?: number; returnedUnderLock?: number; product?: typeof PRODUCT; cps?: { productId: string; price: number }[]; lockedUnit?: string } = {}) {
  const created: any[] = [];
  const product = o.product ?? PRODUCT;
  scripted = {
    'invoice.findUnique': () => null,
    'salesRep.findFirst': () => REP,
    'admin.findUnique': () => ({ scopeEnabled: false, isActive: true }),
    'customer.findFirst': () => CUSTOMER,
    'product.findMany': () => [product],
    'customerPrice.findMany': () => o.cps ?? [],
    'companySettings.findUnique': () => ({ defaultVatPct: 15, countryCode: 'SA', currency: 'SAR', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null }),
    'invoice.findFirst': (args) => (args?.select?.items
      ? { customerId: 'c1', type: 'CASH', status: 'CONFIRMED', documentKind: null, locationId: null, items: [{ id: 'si-1', productId: 'p1', qty: 1, unitFactor: 24, baseQty: 24 }] }
      : null),
    'invoiceItem.findMany': (args) => {
      if (args?.where?.OR) {
        const n = inTx && o.returnedUnderLock != null ? o.returnedUnderLock : (o.returnedBefore ?? 0);
        return n ? [{ qty: n, unitFactor: 1, baseQty: n, returnOfItemId: 'si-1', creditedItemId: null }] : [];
      }
      if (args?.where?.id?.in) return [{ id: 'si-1', qty: 1, unitFactor: 24, lineTotal: 10, taxPct: 15 }];
      return [];
    },
    'invoice.create': (args) => { created.push(args.data); return { id: `inv-${created.length}`, ...args.data, items: args.data.items.create, customer: CUSTOMER }; },
  };
  rawScript = (r) => (r.kind === '$queryRaw' && /FROM products WHERE id IN/.test(r.sql) && o.lockedUnit ? [{ id: 'p1', unit: o.lockedUnit }] : undefined);
  return { created };
}

const returnBody = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  customerId: 'c1', salesRepId: 'rep-1', type: 'RETURN', originalInvoiceId: 'sale-1',
  // ما يرسله عميلٌ مخطئ: سعر كرتونٍ لحبّة، وبلا pricesIncludeTax، وخصم فاتورة — كلّه لا يُقرأ للمرتجع المرتبط
  pricesIncludeTax: false, discountPct: 5, items, ...extra,
});

test('المرتجع المرتبط يُسعَّر على الخادم من بند البيع: حبّةٌ من كرتون بسعر الحبّة لا بسعر الكرتون', async () => {
  reset();
  const w = issueWorld();
  const r = await call('POST', '/api/invoices', { body: returnBody([{ productId: 'p1', invoiceItemId: 'si-1', qty: 1, unitPrice: 10, discountPct: 10, taxPct: 0 }]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = w.created[0];
  assert.equal(d.total, 0.42, '١٠ ÷ ٢٤ مقرَّبة');
  assert.equal(d.pricesIncludeTax, true);
  assert.equal(d.discountPct, 0);
  const it = d.items.create[0];
  assert.deepEqual({ lineTotal: it.lineTotal, taxPct: it.taxPct, discountPct: it.discountPct, unitFactor: it.unitFactor, baseQty: it.baseQty, unitName: it.unitName, returnOfItemId: it.returnOfItemId },
    { lineTotal: 0.42, taxPct: 15, discountPct: 0, unitFactor: 1, baseQty: 1, unitName: null, returnOfItemId: 'si-1' });
  assert.equal(it.taxAmt, 0.05, 'الضريبة من داخل المبلغ بنسبة بند البيع');

  // الكرتون كاملاً بوحدته: قيمة البند تماماً
  reset();
  const w2 = issueWorld();
  const r2 = await call('POST', '/api/invoices', { body: returnBody([{ productId: 'p1', invoiceItemId: 'si-1', unitId: 'u-ct', qty: 1, unitPrice: 0.01, discountPct: 0 }]) });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(w2.created[0].total, 10);
  assert.deepEqual([w2.created[0].items.create[0].unitFactor, w2.created[0].items.create[0].baseQty, w2.created[0].items.create[0].unitName], [24, 24, 'كرتون']);
});

test('٢٤ حبّة في ٢٤ مرتجعاً = قيمة الكرتون تماماً (١٠٫٠٠ لا ١٠٫٠٨)، والحبة الخامسة والعشرون تُرفض', async () => {
  let sum = 0;
  for (let i = 0; i < 24; i++) {
    reset();
    const w = issueWorld({ returnedBefore: i });
    const r = await call('POST', '/api/invoices', { body: returnBody([{ productId: 'p1', invoiceItemId: 'si-1', qty: 1, unitPrice: 0.4167, discountPct: 0 }], { pricesIncludeTax: true, discountPct: 0 }) });
    assert.equal(r.status, 201, `#${i + 1}: ${JSON.stringify(r.body)}`);
    sum = Math.round((sum + w.created[0].total) * 100) / 100;
  }
  assert.equal(sum, 10);
  reset();
  issueWorld({ returnedBefore: 24 });
  const over = await call('POST', '/api/invoices', { body: returnBody([{ productId: 'p1', invoiceItemId: 'si-1', qty: 1, unitPrice: 0.42, discountPct: 0 }]) });
  assert.equal(over.status, 422, JSON.stringify(over.body));
  assert.equal(calls.includes('invoice.create'), false);
  // بندان في المرتجع نفسه من بند البيع نفسه يتتابعان: ١٢ + ١٢ = الكرتون
  reset();
  const w = issueWorld();
  const two = await call('POST', '/api/invoices', { body: returnBody([
    { productId: 'p1', invoiceItemId: 'si-1', qty: 12, unitPrice: 1, discountPct: 0 },
    { productId: 'p1', invoiceItemId: 'si-1', qty: 12, unitPrice: 1, discountPct: 0 },
  ]) });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  assert.equal(w.created[0].total, 10);
});

test('مرتجعٌ متزامن التزم قبل القفل: يُعاد التسعير تحته على ما رُدّ فعلاً', async () => {
  reset();
  // قبل المعاملة: ٢٢ حبّة رُدّت (حصّة الحبّة ٠٫٤١)، وتحت القفل صارت ٢٣ فهذه آخر حبّة (٠٫٤٢)
  const w = issueWorld({ returnedBefore: 22, returnedUnderLock: 23 });
  const r = await call('POST', '/api/invoices', { body: returnBody([{ productId: 'p1', invoiceItemId: 'si-1', qty: 1, unitPrice: 1, discountPct: 0 }]) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].total, 0.42);
  assert.equal(w.created[0].items.create[0].lineTotal, 0.42);
});

test('المرتجع غير المرتبط والبيع كما كانا حرفياً: سعر العميل والخصم وpricesIncludeTax من الجسم', async () => {
  reset();
  const w = issueWorld();
  const r = await call('POST', '/api/invoices', { body: { customerId: 'c1', salesRepId: 'rep-1', type: 'RETURN', pricesIncludeTax: false, discountPct: 0, items: [{ productId: 'p1', qty: 2, unitPrice: 3, discountPct: 0, taxPct: 15 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(w.created[0].total, 6.9);
  assert.equal(w.created[0].pricesIncludeTax, false);
});

test('حارس السعر بوحدة البند: سعر العميل × المعامل يغلب سعر الوحدة المحدَّد، وبلاه سعر الوحدة', async () => {
  const sell = (items: Record<string, unknown>[]) => ({ customerId: 'c1', type: 'CASH', pricesIncludeTax: false, discountPct: 0, items });
  // بلا سعر عميل: الكرتون بسعره المحدَّد (١٠) — وسعر حبّته (٠٫٤٢) لكرتونٍ يُرفض
  reset(); currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT }; issueWorld();
  assert.equal((await call('POST', '/api/invoices', { body: sell([{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice: 10, discountPct: 0 }]) })).status, 201);
  reset(); currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT }; issueWorld();
  assert.equal((await call('POST', '/api/invoices', { body: sell([{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice: 0.42, discountPct: 0 }]) })).status, 403, 'كرتونٌ بسعر حبّة');
  // سعر العميل للحبّة ٠٫٣٧٥ (كرتونه ٩ بعد التحويل): الكرتون له بتسعة، وسعر الكرتون العامّ فوق سقفه
  reset(); currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT }; issueWorld({ cps: [{ productId: 'p1', price: 9 / 24 }] });
  assert.equal((await call('POST', '/api/invoices', { body: sell([{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice: 9, discountPct: 0 }]) })).status, 201);
  reset(); currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT }; issueWorld({ cps: [{ productId: 'p1', price: 9 / 24 }] });
  assert.equal((await call('POST', '/api/invoices', { body: sell([{ productId: 'p1', unitId: 'u-ct', qty: 1, unitPrice: 10, discountPct: 0 }]) })).status, 403);
  // الأساس كما قبل الميزة: سعر العميل نفسه
  reset(); currentUser = { id: 'rep-1', role: 'SALES_REP', tenantId: TENANT }; issueWorld({ cps: [{ productId: 'p1', price: 0.375 }] });
  assert.equal((await call('POST', '/api/invoices', { body: sell([{ productId: 'p1', qty: 2, unitPrice: 0.375, discountPct: 0 }]) })).status, 201);
});

test('إعادة الرفع تكتب لقطة الجهاز (الأساس المحوَّل بعد الإصدار)، والحيّ يُردّ ٤٠٠ بكاشٍ قديم ولا مستند', async () => {
  const body = { customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0, items: [{ productId: 'p1', qty: 2, unitPrice: 10, discountPct: 0, unitName: 'كرتون', unitFactor: 1 }] };
  reset();
  const w = issueWorld();
  const r = await call('POST', '/api/invoices', { body, headers: { 'X-FS-Replay': '1' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const it = w.created[0].items.create[0];
  assert.deepEqual([it.qty, it.unitName, it.unitFactor, it.baseQty, it.unitCode], [2, 'كرتون', 24, 48, 'CT']);
  reset();
  issueWorld();
  const live = await call('POST', '/api/invoices', { body });
  assert.equal(live.status, 400, JSON.stringify(live.body));
  assert.equal(live.body.code, 'UNIT_INVALID');
  assert.equal(calls.includes('invoice.create'), false);
});

test('تحويلٌ التزم بين حلّ اللقطات وقفل الأصناف: لا مستند — ٤٠٩ للحيّ و٥٠٣ لإعادة الرفع (يعيدها الصندوق)', async () => {
  const body = { customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', pricesIncludeTax: false, discountPct: 0, items: [{ productId: 'p1', qty: 1, unitPrice: 10 / 24, discountPct: 0 }] };
  reset();
  issueWorld({ lockedUnit: 'قطعة' });
  const live = await call('POST', '/api/invoices', { body });
  assert.equal(live.status, 409, JSON.stringify(live.body));
  assert.equal(live.body.code, 'PRODUCT_UNITS_CHANGED');
  assert.equal(calls.includes('invoice.create'), false);
  const lock = raws.find(x => /FROM products WHERE id IN/.test(x.sql))!;
  // FOR KEY SHARE لا FOR SHARE: يتسلسل مع FOR UPDATE الذي يأخذه التحويل، ولا يحبس تعديل سعر الصنف أو اسمه أثناء البيع
  assert.match(lock.sql, /FOR KEY SHARE/);
  assert.equal(lock.inTx, true);
  reset();
  issueWorld({ lockedUnit: 'قطعة' });
  const replay = await call('POST', '/api/invoices', { body, headers: { 'X-FS-Replay': '1' } });
  assert.equal(replay.status, 503);
  // والأساس كما قُرئ: يمرّ
  reset();
  issueWorld({ lockedUnit: 'حبة' });
  assert.equal((await call('POST', '/api/invoices', { body })).status, 201);
});

// ═══ (٥) القراءات ═══

test('GET /:id/returnable بالأساس حسب العقد: لقطة البند المباع وكمياته بالأساس ووحدات الصنف', async () => {
  reset();
  scripted = {
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findFirst': () => ({
      id: 'sale-1', number: 'INV-1', invoiceDate: new Date('2026-10-01T10:00:00Z'), customerId: 'c1', salesRepId: 'rep-1', type: 'CASH', status: 'CONFIRMED', documentKind: null,
      items: [{
        id: 'si-1', productId: 'p1', qty: 2, lineTotal: 20, taxPct: 15, expiresAt: null, unitName: 'كرتون', unitFactor: 24, baseQty: 48,
        product: { ...PRODUCT, code: 'W1', units: PRODUCT.units },
      }],
    }),
    'invoiceItem.findMany': () => [{ qty: 5, unitFactor: 1, baseQty: 5, returnOfItemId: 'si-1', creditedItemId: null }],
  };
  const r = await call('GET', '/api/invoices/sale-1/returnable');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const l = r.body.data.lines[0];
  assert.deepEqual(
    { unitName: l.unitName, unitFactor: l.unitFactor, soldBase: l.soldBase, returnedBase: l.returnedBase, returnableBase: l.returnableBase, lineTotal: l.lineTotal, qty: l.qty },
    { unitName: 'كرتون', unitFactor: 24, soldBase: 48, returnedBase: 5, returnableBase: 43, lineTotal: 20, qty: 2 },
  );
  assert.ok(Math.abs(l.refundPerBase - 20 / 48) < 1e-12);
  // الحقول القديمة بالأساس — عميلٌ لا يعرف الوحدات يرسل الكمية أساساً
  assert.deepEqual([l.sold, l.returned, l.returnable, l.refundUnitPrice, l.unit], [48, 5, 43, 0.4167, 'حبة']);
  assert.deepEqual(l.product, { unit: 'حبة', units: PRODUCT.units });
});

test('returnable-sales بالأساس، والتفصيل والكشف بلقطة وحدة البند', async () => {
  reset();
  scripted = {
    'admin.findUnique': () => ({ scopeEnabled: false }),
    'invoice.findMany': (args) => {
      if (args?.where?.type?.in) {
        assert.deepEqual(args.select.items.select, { id: true, productId: true, qty: true, unitFactor: true, baseQty: true });
        return [{ id: 'sale-1', number: 'INV-1', invoiceDate: new Date(), total: 30, type: 'CASH', items: [
          { id: 'si-1', productId: 'p1', qty: 1, unitFactor: 24, baseQty: 24 },
          { id: 'si-2', productId: 'p2', qty: 3, unitFactor: 1, baseQty: 3 },
        ] }];
      }
      return [{ id: 'inv-1', einvoiceSnapshot: 'x', items: [
        { id: 'a', unitName: 'كرتون', product: { name: 'ماء', unit: 'حبة' } },
        { id: 'b', unitName: null, product: { name: 'ماء', unit: 'حبة' } },
      ] }];
    },
    'invoiceItem.findMany': () => [{ qty: 3, unitFactor: 1, baseQty: 3, returnOfItemId: 'si-2', creditedItemId: null }],
    'invoice.findFirst': () => ({ id: 'inv-1', customerId: null, salesRepId: 'rep-1', zatcaPhase: null, items: [{ id: 'b', unitName: null, product: { unit: 'حبة' } }] }),
  };
  const s = await call('GET', '/api/invoices/returnable-sales?customerId=c1');
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.data[0].returnableQty, s.body.data[0].returnableLines, s.body.data[0].productIds], [24, 1, ['p1']]);

  const list = await call('GET', '/api/invoices?withItems=1');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data[0].items.map((i: { unitName: string }) => i.unitName), ['كرتون', 'حبة']);
  assert.equal('einvoiceSnapshot' in list.body.data[0], false);
  const one = await call('GET', '/api/invoices/inv-1');
  assert.equal(one.status, 200);
  assert.equal(one.body.data.items[0].unitName, 'حبة');
});
