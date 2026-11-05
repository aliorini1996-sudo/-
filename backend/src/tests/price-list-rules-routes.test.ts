// «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦ — على نسق Odoo): مسارات /api/price-lists الجديدة الحقيقية فوق Prisma مزيّف
// (بلا قاعدة بيانات)، بحرّاس middleware/auth الحقيقيين عدا authenticate. يثبت:
//   • الحرّاس: المندوب لا يكتب (requireAdmin)، ومستخدم الشركة بلا صلاحية الأصناف 403 قراءةً وكتابة، والمندوب يقرأ قوائمه وحدها.
//   • القواعد: التحقق بـpriceRuleProblem نفسه (400 PRICE_RULE_INVALID برسالته)، وعزل الشركة (القائمة 404، والصنف والفئة 400)، والمؤرشف
//     مرفوض، والسعر الثابت لصنفٍ من الرئيسية إلى الأساس بستّ منازل تحت قفل الصنف FOR KEY SHARE بالأساس والرئيسية كما رآهما المحرّر
//     (409)، ولفئةٍ للرئيسية بأربع منازل بلا قفل، والحدّ 2000 قاعدة (409)، والتعديل استبدالٌ كامل يقفل الصنفين ويلمسهما بالترتيب،
//     والحذف 404 لقاعدة شركةٍ أخرى.
//   • جدول القائمة: صفحاتٌ بالبحث والفئة والنطاق، وسعر القائمة بالرئيسية بأربع منازل، والحفظ الجماعي بحارس الأساس لكل سطر ومهلةٍ
//     تكبر بالسطور، وnull يحذف، والطابع للمتغيّر وحده بترتيب المعرّف.
//   • /rules و/prices: قواعد القوائم المرئية وحدها بشكل الأجهزة (unit وbaseConvertedAt لقاعدة الصنف)، وبلا قوائم استعلامٌ واحد.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { PRICE_RULE_MESSAGES } from '../services/priceRules';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = { kind: '$queryRaw' | '$executeRaw'; sql: string; values: unknown[]; inTx: boolean };
let calls: string[] = [];
let raws: Raw[] = [];
let inTx = false;
let txOpts: unknown[] = [];
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (r: Raw) => unknown = () => undefined;

function defaultFor(method: string): unknown {
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method === 'count') return 0;
  if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
  return null;
}
const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (arg: unknown, opts?: unknown) => {
        calls.push('$transaction');
        txOpts.push(opts);
        if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
        inTx = true;
        try { return await (arg as (tx: unknown) => Promise<unknown>)(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(key);
        const r: Raw = { kind: key, sql: strings.join('?').replace(/\s+/g, ' '), values, inTx };
        raws.push(r);
        const out = rawScript(r);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push(`${key}.${method}`);
        const fn = scripted[`${key}.${method}`];
        return fn ? fn(args) : defaultFor(method);
      },
    });
  },
});

const T = 'T1';
type User = { id: string; role: string; tenantId: string; apiKeyId?: string };
const ADMIN: User = { id: 'admin-1', role: 'ADMIN', tenantId: T };
const REP: User = { id: 'rep-1', role: 'SALES_REP', tenantId: T };
let currentUser: User = ADMIN;
/** صلاحية الأصناف لمستخدم الشركة الحالي (حارس requireAdminPermission الحقيقي يقرأ صفّه) */
let canManageProducts = true;

stub('config/database', { default: prismaFake });
/* eslint-disable @typescript-eslint/no-var-requires */
const realAuth = require('../middleware/auth') as Record<string, unknown>;
stub('middleware/auth', {
  ...realAuth,
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = currentUser; next(); },
  requireAccounting: (_req: unknown, _res: unknown, next: () => void) => next(),
});
const priceListsRouter = (require('../routes/priceLists') as typeof import('../routes/priceLists')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
const { BASE_GUARD_TX } = require('../services/baseGuard') as typeof import('../services/baseGuard');
const { PRICE_LIST_MESSAGES } = require('../services/priceLists') as typeof import('../services/priceLists');
/* eslint-enable @typescript-eslint/no-var-requires */

let server: { port: number; close: () => Promise<void> } | null = null;
async function startServer() {
  if (server) return server;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/price-lists', priceListsRouter);
  app.use(errorHandler);
  const s = http.createServer(app);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()); }) };
  return server;
}
after(async () => { await server?.close(); server = null; });

type Reply = { status: number; body: Record<string, any> };
async function call(method: 'POST' | 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Reply> {
  const s = await startServer();
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, method, path: encodeURI(url), agent: false,
      headers: { connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
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

// ═══ عالم الشركة ═══

type Unit = { id: string; name: string; factor: number; price: number | null; isActive: boolean };
type Product = {
  id: string; tenantId: string; name: string; code: string; unit: string; basePrice: number; status: string; categoryId: string | null;
  primaryUnitId: string | null; units: Unit[]; deletedAt: Date | null; baseConvertedAt: Date | null;
};
type Rule = {
  id: string; tenantId: string; priceListId: string; scope: string; productId: string | null; categoryId: string | null; kind: string;
  basePrice: number | null; primaryPrice: number | null; percent: number | null; minQty: number; startsOn: string | null; endsOn: string | null; updatedAt: Date;
};
const CARTON: Unit = { id: 'u-ct', name: 'كرتون', factor: 24, price: 10, isActive: true };
const STAMP = new Date('2026-11-05T08:00:00.000Z');
/** قوائم الشركة — L-X لشركةٍ أخرى */
const MY_LISTS = ['L-W', 'L-R'];
const CATEGORIES: Record<string, { id: string; tenantId: string; name: string }> = {
  'cat-j': { id: 'cat-j', tenantId: T, name: 'عصائر' },
  'cat-x': { id: 'cat-x', tenantId: 'T2', name: 'فئة غريبة' },
};

let W: {
  products: Record<string, Product>; rules: Record<string, Rule>; ruleCount: number;
  /** أساس الصنف كما يراه قفل FOR KEY SHARE (تحويلٌ التزم بين القراءة والقفل) */
  lockedUnit: Record<string, string>;
  seq: string[]; locks: Array<{ ids: string[]; inTx: boolean }>; created: any[]; updated: any[]; deleted: any[]; touches: Array<{ where: any; inTx: boolean }>;
  upserts: any[]; itemDeletes: any[]; itemDeleteCount: number;
  /** قفل صفّ القائمة في معاملة الإنشاء (FOR NO KEY UPDATE)، وقائمةٌ حُذفت بين قراءتها وقفلها */
  listLocks: Array<{ id: string; tid: string; inTx: boolean }>; listGone: boolean;
};

const product = (id: string, o: Partial<Product> = {}): Product => ({
  id, tenantId: T, name: id, code: id.toUpperCase(), unit: 'حبة', basePrice: 1, status: 'ACTIVE', categoryId: null,
  primaryUnitId: null, units: [], deletedAt: null, baseConvertedAt: null, ...o,
});
const display = (r: Rule) => {
  const p = r.productId ? W.products[r.productId] : null;
  return {
    ...r,
    product: p ? { id: p.id, name: p.name, code: p.code, unit: p.unit, baseConvertedAt: p.baseConvertedAt, deletedAt: p.deletedAt, primaryUnitId: p.primaryUnitId, units: p.units } : null,
    category: r.categoryId ? { name: CATEGORIES[r.categoryId]?.name ?? null } : null,
  };
};
const matchProduct = (where: any) => (p: Product) => {
  if (where?.tenantId !== undefined && p.tenantId !== where.tenantId) return false;
  if (where?.id !== undefined && (typeof where.id === 'string' ? p.id !== where.id : !(where.id.in as string[]).includes(p.id))) return false;
  if (where && 'deletedAt' in where && where.deletedAt === null && p.deletedAt !== null) return false;
  return true;
};

function reset(user: User = ADMIN): void {
  calls = []; raws = []; inTx = false; txOpts = []; currentUser = user; canManageProducts = true;
  W = {
    products: {
      // ماء: الحبة أساس والكرتون (٢٤) رئيسيّ بسعره عشرة، في فئة العصائر — وعصير بلا رئيسية، ومؤرشف، وصنف شركةٍ أخرى
      p1: product('p1', { name: 'ماء', code: 'W1', basePrice: 10 / 24, categoryId: 'cat-j', primaryUnitId: 'u-ct', units: [{ ...CARTON }] }),
      p2: product('p2', { name: 'عصير', code: 'J1', unit: 'علبة', basePrice: 2, categoryId: 'cat-j' }),
      pA: product('pA', { name: 'قديم', deletedAt: new Date('2026-10-01T00:00:00Z') }),
      pX: product('pX', { tenantId: 'T2', name: 'غريب' }),
    },
    rules: {
      R1: { id: 'R1', tenantId: T, priceListId: 'L-W', scope: 'product', productId: 'p1', categoryId: null, kind: 'fixed', basePrice: 0.375, primaryPrice: null, percent: null, minQty: 0, startsOn: null, endsOn: null, updatedAt: STAMP },
      R2: { id: 'R2', tenantId: T, priceListId: 'L-W', scope: 'category', productId: null, categoryId: 'cat-j', kind: 'percent', basePrice: null, primaryPrice: null, percent: 10, minQty: 5, startsOn: '2026-11-01', endsOn: '2026-11-30', updatedAt: STAMP },
      RX: { id: 'RX', tenantId: 'T2', priceListId: 'L-X', scope: 'all', productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: 5, minQty: 0, startsOn: null, endsOn: null, updatedAt: STAMP },
    },
    ruleCount: 2, lockedUnit: {}, seq: [], locks: [], created: [], updated: [], deleted: [], touches: [], upserts: [], itemDeletes: [], itemDeleteCount: 1,
    listLocks: [], listGone: false,
  };
  scripted = {
    'admin.findUnique': () => ({ id: currentUser.id, isActive: true, canManageProducts }),
    'priceList.findFirst': (a) => (MY_LISTS.includes(a?.where?.id) && a?.where?.tenantId === T ? { id: a.where.id } : null),
    'priceList.findMany': (a) => (a?.where?.tenantId === T ? MY_LISTS.map((id) => ({ id, name: id })) : []),
    'product.findFirst': (a) => Object.values(W.products).find(matchProduct(a?.where)) ?? null,
    'product.findMany': (a) => Object.values(W.products).filter(matchProduct(a?.where)),
    'product.updateMany': (a) => { W.seq.push(`touch:${a.where.id}`); W.touches.push({ where: a.where, inTx }); assert.ok(a.data.updatedAt instanceof Date); return { count: 1 }; },
    'productCategory.findFirst': (a) => { const c = CATEGORIES[a?.where?.id]; return c && c.tenantId === a.where.tenantId ? { id: c.id } : null; },
    'priceListRule.count': () => W.ruleCount,
    'priceListRule.create': (a) => {
      W.seq.push('create'); W.created.push({ data: a.data, inTx });
      return display({ id: 'R-NEW', updatedAt: STAMP, ...a.data });
    },
    'priceListRule.findFirst': (a) => { const r = W.rules[a?.where?.id]; return r && r.tenantId === a.where.tenantId ? display(r) : null; },
    'priceListRule.updateMany': (a) => {
      W.seq.push('update'); W.updated.push({ args: a, inTx });
      const r = W.rules[a.where.id];
      if (!r || r.tenantId !== a.where.tenantId) return { count: 0 };
      Object.assign(r, a.data);
      return { count: 1 };
    },
    'priceListRule.deleteMany': (a) => {
      W.seq.push('delete'); W.deleted.push({ args: a, inTx });
      const r = W.rules[a.where.id];
      return { count: r && r.tenantId === a.where.tenantId ? 1 : 0 };
    },
    'priceListItem.upsert': (a) => { W.seq.push(`upsert:${a.create.productId}`); W.upserts.push({ args: a, inTx }); return {}; },
    'priceListItem.deleteMany': (a) => { W.seq.push(`itemDelete:${a.where.productId}`); W.itemDeletes.push({ args: a, inTx }); return { count: W.itemDeleteCount }; },
  };
  rawScript = (r) => {
    if (r.sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    // قفل صفّ القائمة قبل عدّ قواعدها (حدّ ٢٠٠٠ تحت القفل) — القائمة المحذوفة بين القراءة والقفل لا صفّ لها
    if (r.sql.includes('FROM price_lists') && r.sql.includes('FOR NO KEY UPDATE')) {
      const [id, tid] = r.values as [string, string];
      W.seq.push(`listLock:${id}`);
      W.listLocks.push({ id, tid, inTx: r.inTx });
      return MY_LISTS.includes(id) && tid === T && !W.listGone ? [{ id }] : [];
    }
    if (r.sql.includes('FROM products') && r.sql.includes('FOR KEY SHARE')) {
      const [tid, ids] = r.values as [string, string[]];
      W.seq.push(`lock:${ids.join(',')}`);
      W.locks.push({ ids: [...ids], inTx: r.inTx });
      return Object.values(W.products).filter((p) => p.tenantId === tid && ids.includes(p.id))
        .map((p) => ({ id: p.id, unit: W.lockedUnit[p.id] ?? p.unit, lotTracked: false, lotTrackedSince: null }));
    }
    return undefined;
  };
}
const writes = () => W.created.length + W.updated.length + W.deleted.length + W.touches.length + W.upserts.length + W.itemDeletes.length;

// ═══ (١) الحرّاس ═══

test('الحرّاس: المندوب لا يكتب قاعدةً ولا سعراً (requireAdmin 403)، ومستخدم الشركة بلا صلاحية الأصناف 403 كتابةً وقراءة، بلا لمس القاعدة', async () => {
  const W_REQS: Array<[('POST' | 'PUT' | 'DELETE'), string, unknown]> = [
    ['POST', '/api/price-lists/L-W/rules', { scope: 'all', kind: 'percent', percent: 5 }],
    ['PUT', '/api/price-lists/rules/R1', { scope: 'all', kind: 'percent', percent: 5 }],
    ['DELETE', '/api/price-lists/rules/R1', undefined],
    ['PUT', '/api/price-lists/L-W/items', { items: [{ productId: 'p2', price: 1, expectedBaseName: 'علبة' }] }],
  ];
  for (const [method, url, body] of W_REQS) {
    reset(REP);
    const r = await call(method, url, body);
    assert.equal(r.status, 403, `${method} ${url}: ${JSON.stringify(r.body)}`);
    assert.equal(writes(), 0);
    assert.deepEqual(calls.filter((c) => c.startsWith('priceList')), [], 'لا قراءة ولا كتابة قوائم');
  }
  for (const [method, url, body] of [...W_REQS, ['GET', '/api/price-lists/rules', undefined], ['GET', '/api/price-lists/L-W/rules', undefined], ['GET', '/api/price-lists/L-W/items', undefined]] as const) {
    reset(ADMIN);
    canManageProducts = false;
    const r = await call(method, url, body);
    assert.equal(r.status, 403, `${method} ${url}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.message, 'لا تملك صلاحية الوصول لهذا القسم');
    assert.deepEqual(calls, ['admin.findUnique'], `${method} ${url}: الحارس وحده`);
  }
});

// ═══ (٢) القواعد: التحقق والعزل ═══

test('POST /:id/rules: التحقق بـpriceRuleProblem نفسه — 400 PRICE_RULE_INVALID برسالته العربية قبل أي قراءة', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{}, PRICE_RULE_MESSAGES.scope],
    [{ scope: 'everything', kind: 'percent', percent: 5 }, PRICE_RULE_MESSAGES.scope],
    [{ scope: 'product', kind: 'fixed', price: 5 }, PRICE_RULE_MESSAGES.product],
    [{ scope: 'category', kind: 'percent', percent: 5 }, PRICE_RULE_MESSAGES.category],
    [{ scope: 'all', kind: 'formula', percent: 5 }, PRICE_RULE_MESSAGES.kind],
    [{ scope: 'all', kind: 'fixed', price: 5 }, PRICE_RULE_MESSAGES.allFixed],
    [{ scope: 'product', productId: 'p1', kind: 'fixed', price: -1, expectedBaseName: 'حبة' }, PRICE_RULE_MESSAGES.price],
    [{ scope: 'all', kind: 'percent', percent: 0 }, PRICE_RULE_MESSAGES.percent],
    [{ scope: 'all', kind: 'percent', percent: 100.5 }, PRICE_RULE_MESSAGES.percent],
    [{ scope: 'all', kind: 'percent', percent: -501 }, PRICE_RULE_MESSAGES.percent],
    [{ scope: 'all', kind: 'percent', percent: 5, minQty: -1 }, PRICE_RULE_MESSAGES.minQty],
    [{ scope: 'all', kind: 'percent', percent: 5, startsOn: '2026-02-30' }, PRICE_RULE_MESSAGES.day],
    [{ scope: 'all', kind: 'percent', percent: 5, startsOn: '2026-11-30', endsOn: '2026-11-01' }, PRICE_RULE_MESSAGES.range],
  ];
  for (const [body, message] of cases) {
    reset();
    const r = await call('POST', '/api/price-lists/L-W/rules', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([r.body.code, r.body.message], ['PRICE_RULE_INVALID', message], JSON.stringify(body));
    assert.deepEqual(calls, ['admin.findUnique'], 'لا قراءة قبل التحقق');
  }
  // والتعديل بالتحقق نفسه
  reset();
  const put = await call('PUT', '/api/price-lists/rules/R1', { scope: 'all', kind: 'fixed', price: 3 });
  assert.deepEqual([put.status, put.body.code, put.body.message], [400, 'PRICE_RULE_INVALID', PRICE_RULE_MESSAGES.allFixed]);
  assert.equal(writes(), 0);
});

test('عزل الشركة: قائمة شركةٍ أخرى 404 PRICE_LIST_INVALID، وصنفها أو المؤرشف 400 PRODUCT_NOT_FOUND، وفئتها 400 CATEGORY_NOT_FOUND — بلا معاملة', async () => {
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ['L-X', { scope: 'all', kind: 'percent', percent: 5 }, 404, 'PRICE_LIST_INVALID'],
    ['L-W', { scope: 'product', productId: 'pX', kind: 'percent', percent: 5 }, 400, 'PRODUCT_NOT_FOUND'],
    ['L-W', { scope: 'product', productId: 'pA', kind: 'fixed', price: 1, expectedBaseName: 'حبة' }, 400, 'PRODUCT_NOT_FOUND'],
    ['L-W', { scope: 'product', productId: 'nope', kind: 'percent', percent: 5 }, 400, 'PRODUCT_NOT_FOUND'],
    ['L-W', { scope: 'category', categoryId: 'cat-x', kind: 'percent', percent: 5 }, 400, 'CATEGORY_NOT_FOUND'],
  ];
  for (const [list, body, status, code] of cases) {
    reset();
    const r = await call('POST', `/api/price-lists/${list}/rules`, body);
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([r.body.code, r.body.message], [code, (PRICE_LIST_MESSAGES as Record<string, string>)[code]]);
    assert.equal(calls.includes('$transaction'), false);
    assert.equal(writes(), 0);
  }
  // التعديل والحذف: قاعدة شركةٍ أخرى «غير موجودة» (البحث بالمعرّف والشركة معاً)
  for (const [method, body] of [['PUT', { scope: 'all', kind: 'percent', percent: 5 }], ['DELETE', undefined]] as const) {
    reset();
    const r = await call(method, '/api/price-lists/rules/RX', body);
    assert.equal(r.status, 404, `${method}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([r.body.code, r.body.message], ['PRICE_RULE_NOT_FOUND', 'القاعدة غير موجودة']);
    assert.equal(writes(), 0);
  }
});

// ═══ (٣) القواعد: الكتابة ═══

test('قاعدة صنفٍ بسعرٍ ثابت: سعر الكرتون الرئيسي ÷ ٢٤ لوحدة الأساس بستّ منازل تحت قفل الصنف في المعاملة، ثم الطابع — والردّ بحقول العرض', async () => {
  reset();
  const r = await call('POST', '/api/price-lists/L-W/rules', {
    scope: 'product', productId: 'p1', categoryId: 'cat-j', kind: 'fixed', price: 10, percent: 7, minQty: 5, startsOn: '2026-11-01', endsOn: '',
    expectedBaseName: 'حبة', expectedPrimary: { id: 'u-ct', factor: 24 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(W.created, [{
    data: {
      tenantId: T, priceListId: 'L-W', scope: 'product', productId: 'p1', categoryId: null, kind: 'fixed',
      basePrice: 0.416667, primaryPrice: null, percent: null, minQty: 5, startsOn: '2026-11-01', endsOn: null,
    },
    inTx: true,
  }], 'كل نطاقٍ بحقله، والنسبة لا تُخزَّن لسعرٍ ثابت، والفارغ مفتوح');
  // قفل صفّ القائمة (حدّ القواعد تحت القفل) ثم قفل الصنف، ثم الكتابة والطابع
  assert.deepEqual(W.seq, ['listLock:L-W', 'lock:p1', 'create', 'touch:p1'], 'القفل قبل الكتابة والطابع بعدها');
  assert.deepEqual(W.locks, [{ ids: ['p1'], inTx: true }]);
  assert.deepEqual(W.touches, [{ where: { id: 'p1', tenantId: T }, inTx: true }]);
  assert.deepEqual(txOpts, [BASE_GUARD_TX], 'مهلة الحارس (I10)');
  // مهلة القفل المحلية تُضبط قبله (lockBases)
  const at = raws.findIndex((x) => x.sql.includes('FOR KEY SHARE'));
  assert.ok(raws.slice(0, at).some((x) => x.sql.includes("set_config('lock_timeout'")));
  assert.deepEqual(r.body.data, {
    id: 'R-NEW', priceListId: 'L-W', scope: 'product', productId: 'p1', categoryId: null, kind: 'fixed', basePrice: 0.416667, primaryPrice: null,
    percent: null, minQty: 5, startsOn: '2026-11-01', endsOn: null, updatedAt: STAMP.toISOString(), unit: 'حبة', baseConvertedAt: null,
    productName: 'ماء', productCode: 'W1', categoryName: null, primaryUnit: { id: 'u-ct', name: 'كرتون', factor: 24 },
  });
  // ×٢٤ يعيد سعر الكرتون بالهللة
  assert.equal(Math.round(W.created[0].data.basePrice * 24 * 100) / 100, 10);
  // صنفٌ بلا رئيسية: السعر للأساس نفسه؛ والمفتاح الغائب ⇒ رئيسية الصنف الآن (٢٤)
  reset();
  assert.equal((await call('POST', '/api/price-lists/L-W/rules', { scope: 'product', productId: 'p2', kind: 'fixed', price: 2.5, expectedBaseName: 'علبة', expectedPrimary: null })).status, 201);
  assert.equal(W.created[0].data.basePrice, 2.5);
  reset();
  assert.equal((await call('POST', '/api/price-lists/L-W/rules', { scope: 'product', productId: 'p1', kind: 'fixed', price: 12, expectedBaseName: 'حبة' })).status, 201);
  assert.equal(W.created[0].data.basePrice, 0.5);
});

test('حارس الأساس لقاعدة الصنف الثابتة: بلا الأساس 400 BASE_UNIT_REQUIRED (ومفتاح API على صنفٍ حُوِّل كذلك)، وأساسٌ أو رئيسيةٌ غير ما رآه المحرّر 409، وانشغال القفل 503 — بلا كتابة', async () => {
  const base = { scope: 'product', productId: 'p1', kind: 'fixed', price: 10 };
  const cases: Array<[Record<string, unknown>, number, string, ((() => void) | null)?, User?]> = [
    [{ ...base }, 400, 'BASE_UNIT_REQUIRED'],
    [{ ...base, expectedBaseName: '   ' }, 400, 'BASE_UNIT_REQUIRED'],
    [{ ...base }, 400, 'BASE_UNIT_REQUIRED', () => { W.products.p1.baseConvertedAt = new Date('2026-10-30T00:00:00Z'); }, { ...ADMIN, apiKeyId: 'k1' }],
    // المحرّر فُتح على «كرتون» أساساً (قبل تحويلٍ إلى حبة): السعر محسوبٌ على أساسٍ آخر
    [{ ...base, expectedBaseName: 'كرتون' }, 409, 'BASE_UNIT_CHANGED'],
    // تحويلٌ التزم بين قراءة الصنف وقفله
    [{ ...base, expectedBaseName: 'حبة' }, 409, 'BASE_UNIT_CHANGED', () => { W.lockedUnit.p1 = 'قارورة'; }],
    [{ ...base, expectedBaseName: 'حبة', expectedPrimary: { id: 'u-ct', factor: 12 } }, 409, 'PRIMARY_UNIT_CHANGED'],
    [{ ...base, expectedBaseName: 'حبة', expectedPrimary: { id: 'u-other', factor: 24 } }, 409, 'PRIMARY_UNIT_CHANGED'],
    [{ ...base, expectedBaseName: 'حبة', expectedPrimary: null }, 409, 'PRIMARY_UNIT_CHANGED'],
    // صنفٌ أُرشف بين القراءة والقفل
    [{ ...base, expectedBaseName: 'حبة' }, 400, 'PRODUCT_NOT_FOUND', () => {
      const pre = scripted['product.findFirst'];
      scripted['product.findFirst'] = (a) => (inTx ? { ...W.products.p1, deletedAt: new Date() } : pre(a));
    }],
  ];
  for (const [body, status, code, setup, user] of cases) {
    reset(user);
    setup?.();
    const r = await call('POST', '/api/price-lists/L-W/rules', body);
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([r.body.code, r.body.message], [code, (PRICE_LIST_MESSAGES as Record<string, string>)[code]], code);
    assert.equal(W.created.length + W.touches.length, 0, `${code}: لا كتابة`);
  }
  // قفلٌ ينتظر تحويلاً طويلاً (55P03) ⇒ 503 PRODUCT_UNITS_BUSY لا 500
  reset();
  const pre = rawScript;
  rawScript = (r) => { if (r.sql.includes('FOR KEY SHARE')) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }); return pre(r); };
  const busy = await call('POST', '/api/price-lists/L-W/rules', { ...base, expectedBaseName: 'حبة' });
  assert.deepEqual([busy.status, busy.body.code], [503, 'PRODUCT_UNITS_BUSY']);
  assert.equal(W.created.length, 0);
});

test('قاعدة الفئة الثابتة للرئيسية بأربع منازل بلا قفل أصناف ولا طابع، والنسبة على الكل (السالبة زيادة)، ونسبة الصنف تقفله بأساسه وتلمسه', async () => {
  reset();
  const cat = await call('POST', '/api/price-lists/L-R/rules', { scope: 'category', categoryId: 'cat-j', productId: 'p1', kind: 'fixed', price: 12.34567, minQty: '' });
  assert.equal(cat.status, 201, JSON.stringify(cat.body));
  assert.deepEqual(W.created[0].data, {
    tenantId: T, priceListId: 'L-R', scope: 'category', productId: null, categoryId: 'cat-j', kind: 'fixed',
    basePrice: null, primaryPrice: 12.3457, percent: null, minQty: 0, startsOn: null, endsOn: null,
  });
  assert.equal(raws.some((x) => x.sql.includes('FOR KEY SHARE')), false, 'لا قفل أصناف');
  assert.equal(W.touches.length, 0, 'لا طابع لكل أصناف الفئة');
  assert.equal(cat.body.data.categoryName, 'عصائر');
  assert.equal('unit' in cat.body.data, false, 'unit لقاعدة الصنف وحدها');
  reset();
  const all = await call('POST', '/api/price-lists/L-W/rules', { scope: 'all', kind: 'percent', percent: -15, price: 9, categoryId: 'cat-j', startsOn: '2026-11-01', endsOn: '2026-11-30' });
  assert.equal(all.status, 201, JSON.stringify(all.body));
  assert.deepEqual(W.created[0].data, {
    tenantId: T, priceListId: 'L-W', scope: 'all', productId: null, categoryId: null, kind: 'percent',
    basePrice: null, primaryPrice: null, percent: -15, minQty: 0, startsOn: '2026-11-01', endsOn: '2026-11-30',
  });
  assert.equal(calls.includes('product.findFirst') || calls.includes('productCategory.findFirst'), false);
  // نسبة صنف: بلا expectedBaseName (لا سعر يُحوَّل)، والقفل بأساسه المقروء، والطابع بعد الكتابة — والرئيسية لا تُسأل
  reset();
  const pct = await call('POST', '/api/price-lists/L-W/rules', { scope: 'product', productId: 'p1', kind: 'percent', percent: '12.5', minQty: '10', expectedPrimary: { id: 'x', factor: 2 } });
  assert.equal(pct.status, 201, JSON.stringify(pct.body));
  assert.deepEqual([W.created[0].data.percent, W.created[0].data.minQty, W.created[0].data.basePrice], [12.5, 10, null]);
  assert.deepEqual(W.seq, ['listLock:L-W', 'lock:p1', 'create', 'touch:p1']);
});

test('حدّ القائمة: ٢٠٠٠ قاعدة ⇒ 409 PRICE_RULE_LIMIT بلا كتابة، و١٩٩٩ تمرّ — والعدّ بشرط الشركة والقائمة داخل المعاملة بعد قفل صفّ القائمة', async () => {
  reset();
  W.ruleCount = 2000;
  let where: unknown = null;
  let countInTx: boolean | null = null;
  scripted['priceListRule.count'] = (a) => { where = a.where; countInTx = inTx; W.seq.push('count'); return W.ruleCount; };
  const full = await call('POST', '/api/price-lists/L-W/rules', { scope: 'all', kind: 'percent', percent: 5 });
  assert.equal(full.status, 409, JSON.stringify(full.body));
  assert.deepEqual([full.body.code, full.body.message], ['PRICE_RULE_LIMIT', 'لا تتسع القائمة لأكثر من 2000 قاعدة']);
  assert.deepEqual(where, { tenantId: T, priceListId: 'L-W' });
  assert.equal(W.created.length, 0);
  // review 3.1: العدّ تحت قفل صفّ القائمة في معاملة الإنشاء نفسها — لا عدٌّ خارجها يقرؤه منشئان معاً ١٩٩٩ فتصير ٢٠٠١
  assert.equal(countInTx, true, 'العدّ داخل المعاملة');
  assert.deepEqual(W.seq, ['listLock:L-W', 'count'], 'القفل قبل العدّ، ولا قفل صنفٍ ولا كتابة بعد الرفض');
  assert.deepEqual(W.listLocks, [{ id: 'L-W', tid: T, inTx: true }]);
  assert.equal(calls.filter((c) => c === 'priceListRule.count').length, 1, 'عدٌّ واحد');
  W.ruleCount = 1999;
  W.seq = [];
  assert.equal((await call('POST', '/api/price-lists/L-W/rules', { scope: 'all', kind: 'percent', percent: 5 })).status, 201);
  assert.deepEqual(W.seq, ['listLock:L-W', 'count', 'create']);
});

test('حدّ القائمة تحت التزامن (review 3.1): قفل الصفّ FOR NO KEY UPDATE لا FOR UPDATE (لا يوقف مفاتيح العملاء والفواتير الأجنبية)، والمنشئ الثاني يعدّ ما التزمه الأول', async () => {
  reset();
  await call('POST', '/api/price-lists/L-W/rules', { scope: 'all', kind: 'percent', percent: 5 });
  const lock = raws.find((x) => x.sql.includes('FROM price_lists'))!;
  assert.match(lock.sql, /^SELECT id FROM price_lists WHERE id = \? AND "tenantId" = \? FOR NO KEY UPDATE$/);
  assert.deepEqual([lock.values, lock.inTx], [['L-W', T], true]);
  // منشئان على ١٩٩٩: القفل يرتّبهما فيعدّ الثاني بعد التزام الأول — يُرفض الثاني بلا كتابة (المزيّف يحاكي الترتيب: العدّ بعد كل إنشاء)
  reset();
  W.ruleCount = 1999;
  scripted['priceListRule.count'] = () => W.ruleCount;
  const pre = scripted['priceListRule.create'];
  scripted['priceListRule.create'] = (a) => { W.ruleCount += 1; return pre(a); };
  const firstReq = await call('POST', '/api/price-lists/L-W/rules', { scope: 'all', kind: 'percent', percent: 5 });
  const second = await call('POST', '/api/price-lists/L-W/rules', { scope: 'all', kind: 'percent', percent: 6 });
  assert.deepEqual([firstReq.status, second.status, second.body.code], [201, 409, 'PRICE_RULE_LIMIT']);
  assert.equal(W.created.length, 1);
  assert.equal(W.ruleCount, 2000, 'لا تتجاوز القائمة الحدّ');
  // قائمةٌ حُذفت بين القراءة والقفل ⇒ 404 PRICE_LIST_INVALID من داخل المعاملة، بلا عدٍّ ولا كتابة
  reset();
  W.listGone = true;
  const gone = await call('POST', '/api/price-lists/L-W/rules', { scope: 'category', categoryId: 'cat-j', kind: 'fixed', price: 5 });
  assert.deepEqual([gone.status, gone.body.code, gone.body.message], [404, 'PRICE_LIST_INVALID', PRICE_LIST_MESSAGES.PRICE_LIST_INVALID]);
  assert.equal(calls.includes('priceListRule.count'), false);
  assert.equal(writes(), 0);
});

test('مفتاحٌ أجنبيّ فشل في الكتابة (فئةٌ أو قائمةٌ حُذفت بين الفحص والكتابة) ⇒ رفضه لا 500', async () => {
  for (const [field, status, code] of [['price_list_rules_categoryId_fkey (index)', 400, 'CATEGORY_NOT_FOUND'], ['price_list_rules_priceListId_fkey (index)', 404, 'PRICE_LIST_INVALID'], ['price_list_rules_productId_fkey (index)', 400, 'PRODUCT_NOT_FOUND']] as const) {
    reset();
    scripted['priceListRule.create'] = () => { throw Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003', meta: { field_name: field } }); };
    const r = await call('POST', '/api/price-lists/L-W/rules', { scope: 'category', categoryId: 'cat-j', kind: 'percent', percent: 5 });
    assert.deepEqual([r.status, r.body.code], [status, code], field);
  }
});

test('PUT /rules/:ruleId استبدالٌ كامل: نقل قاعدة صنفٍ إلى صنفٍ آخر يقفل الاثنين بترتيب المعرّف ويلمسهما، وقاعدة الفئة إلى الكل بلا قفل، والمحذوفة أثناء الطلب 404', async () => {
  reset();
  const startedAt = Date.now();
  const r = await call('PUT', '/api/price-lists/rules/R1', { scope: 'product', productId: 'p2', kind: 'fixed', price: 3, minQty: 2, expectedBaseName: 'علبة' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(W.locks, [{ ids: ['p1', 'p2'], inTx: true }], 'القديم والجديد في قفلٍ واحد بالترتيب');
  assert.deepEqual(W.updated.map((u) => [u.args.where, u.inTx]), [[{ id: 'R1', tenantId: T }, true]]);
  // الطابع صريحاً (CONTRACT2 D3: إعادة رفع الصندوق تقيس ما عرفه الجهاز من القواعد بـupdatedAt) — والأعمدة استبدالٌ كامل
  const { updatedAt: stamped, ...columns } = W.updated[0].args.data;
  assert.ok(stamped instanceof Date && stamped.getTime() >= startedAt, 'التعديل يحرّك طابع القاعدة');
  assert.deepEqual(columns, {
    scope: 'product', productId: 'p2', categoryId: null, kind: 'fixed', basePrice: 3, primaryPrice: null, percent: null, minQty: 2, startsOn: null, endsOn: null,
  });
  assert.deepEqual(W.seq, ['lock:p1,p2', 'update', 'touch:p1', 'touch:p2']);
  assert.equal('priceListId' in W.updated[0].args.data, false, 'القاعدة تبقى في قائمتها');
  assert.deepEqual([r.body.data.id, r.body.data.productName, r.body.data.basePrice, r.body.data.unit, r.body.data.priceListId], ['R1', 'عصير', 3, 'علبة', 'L-W']);
  assert.deepEqual(txOpts, [BASE_GUARD_TX]);
  // الأساس الذي رآه المحرّر للصنف الجديد يُحرس كالإنشاء
  reset();
  const stale = await call('PUT', '/api/price-lists/rules/R1', { scope: 'product', productId: 'p2', kind: 'fixed', price: 3, expectedBaseName: 'كرتون' });
  assert.deepEqual([stale.status, stale.body.code], [409, 'BASE_UNIT_CHANGED']);
  assert.equal(W.updated.length + W.touches.length, 0);
  // قاعدة فئةٍ تصير نسبةً على الكل: لا أصناف تُقفل ولا تُلمس
  reset();
  const all = await call('PUT', '/api/price-lists/rules/R2', { scope: 'all', kind: 'percent', percent: 3 });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const { updatedAt: stampedAll, ...allColumns } = W.updated[0].args.data;
  assert.ok(stampedAll instanceof Date);
  assert.deepEqual(allColumns, { scope: 'all', productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: 3, minQty: 0, startsOn: null, endsOn: null });
  assert.equal(W.locks.length + W.touches.length, 0);
  // حُذفت بعد القراءة (أو حُذفت قائمتها): 404 لا 500
  reset();
  scripted['priceListRule.updateMany'] = () => ({ count: 0 });
  const gone = await call('PUT', '/api/price-lists/rules/R2', { scope: 'all', kind: 'percent', percent: 3 });
  assert.deepEqual([gone.status, gone.body.code], [404, 'PRICE_RULE_NOT_FOUND']);
});

test('DELETE /rules/:ruleId: قاعدة الصنف بقفله ثم الحذف بشرط الشركة ثم الطابع، وقاعدة الفئة بلا قفل ولا طابع، والمحذوفة أثناء الطلب 404', async () => {
  reset();
  const r = await call('DELETE', '/api/price-lists/rules/R1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true });
  assert.deepEqual(W.seq, ['lock:p1', 'delete', 'touch:p1']);
  assert.deepEqual(W.deleted.map((d) => [d.args.where, d.inTx]), [[{ id: 'R1', tenantId: T }, true]]);
  reset();
  assert.equal((await call('DELETE', '/api/price-lists/rules/R2')).status, 200);
  assert.deepEqual(W.seq, ['delete']);
  reset();
  scripted['priceListRule.deleteMany'] = () => ({ count: 0 });
  const gone = await call('DELETE', '/api/price-lists/rules/R2');
  assert.deepEqual([gone.status, gone.body.code], [404, 'PRICE_RULE_NOT_FOUND']);
});

// ═══ (٤) قراءة القواعد ═══

const RULE_ROWS = (): Rule[] => [
  { id: 'a-all', tenantId: T, priceListId: 'L-W', scope: 'all', productId: null, categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: 2, minQty: 0, startsOn: null, endsOn: null, updatedAt: STAMP },
  { id: 'b-cat', tenantId: T, priceListId: 'L-W', scope: 'category', productId: null, categoryId: 'cat-j', kind: 'fixed', basePrice: null, primaryPrice: 9, percent: null, minQty: 0, startsOn: null, endsOn: null, updatedAt: STAMP },
  { id: 'c-w10', tenantId: T, priceListId: 'L-W', scope: 'product', productId: 'p1', categoryId: null, kind: 'fixed', basePrice: 0.3, primaryPrice: null, percent: null, minQty: 10, startsOn: null, endsOn: null, updatedAt: STAMP },
  { id: 'd-w0', tenantId: T, priceListId: 'L-W', scope: 'product', productId: 'p1', categoryId: null, kind: 'percent', basePrice: null, primaryPrice: null, percent: 5, minQty: 0, startsOn: '2026-11-01', endsOn: '2026-11-30', updatedAt: STAMP },
  { id: 'e-j', tenantId: T, priceListId: 'L-W', scope: 'product', productId: 'p2', categoryId: null, kind: 'fixed', basePrice: 1.5, primaryPrice: null, percent: null, minQty: 0, startsOn: null, endsOn: null, updatedAt: STAMP },
  { id: 'f-old', tenantId: T, priceListId: 'L-W', scope: 'product', productId: 'pA', categoryId: null, kind: 'fixed', basePrice: 1, primaryPrice: null, percent: null, minQty: 0, startsOn: null, endsOn: null, updatedAt: STAMP },
];

test('GET /:id/rules: بحقول العرض وبترتيبه (صنف ثم فئة ثم الكل، فالاسم، فالحدّ الأدنى، فالبداية)، بشرط الشركة والقائمة، وقاعدة المؤرشف خارجها', async () => {
  reset();
  let where: unknown = null;
  scripted['priceListRule.findMany'] = (a) => { where = a.where; return RULE_ROWS().map(display); };
  const r = await call('GET', '/api/price-lists/L-W/rules');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(where, { tenantId: T, priceListId: 'L-W' });
  assert.deepEqual(r.body.data.map((x: { id: string }) => x.id), ['e-j', 'd-w0', 'c-w10', 'b-cat', 'a-all']);
  const water = r.body.data.find((x: { id: string }) => x.id === 'c-w10');
  assert.deepEqual(water, {
    id: 'c-w10', priceListId: 'L-W', scope: 'product', productId: 'p1', categoryId: null, kind: 'fixed', basePrice: 0.3, primaryPrice: null, percent: null,
    minQty: 10, startsOn: null, endsOn: null, updatedAt: STAMP.toISOString(), unit: 'حبة', baseConvertedAt: null,
    productName: 'ماء', productCode: 'W1', categoryName: null, primaryUnit: { id: 'u-ct', name: 'كرتون', factor: 24 },
  });
  const cat = r.body.data.find((x: { id: string }) => x.id === 'b-cat');
  assert.deepEqual([cat.categoryName, cat.productName, cat.primaryPrice, cat.primaryUnit, 'unit' in cat], ['عصائر', null, 9, null, false]);
  // قائمة شركةٍ أخرى
  reset();
  const x = await call('GET', '/api/price-lists/L-X/rules');
  assert.deepEqual([x.status, x.body.code], [404, 'PRICE_LIST_INVALID']);
  assert.equal(calls.includes('priceListRule.findMany'), false);
});

/** المندوب بلا «تبديل قائمة الأسعار» وعملاؤه على الجملة (L-W) وحدها */
function repWorld(canChangePriceList: boolean) {
  scripted['salesRep.findFirst'] = () => ({ canChangePriceList, defaultPriceListId: null });
  scripted['customer.findMany'] = () => [{ priceListId: 'L-W' }];
}
const RAW_RULES = () => RULE_ROWS().filter((r) => r.productId !== 'pA').map((r) => {
  const p = r.productId ? W.products[r.productId] : null;
  return { ...r, unit: p?.unit ?? null, baseConvertedAt: p?.baseConvertedAt ?? null };
});
const isRulesSql = (r: Raw) => r.sql.includes('FROM price_list_rules r');

test('GET /rules: قواعد القوائم المرئية بشكل الأجهزة في جملةٍ واحدة (الأساس بلقطة القاعدة، والمؤرشف خارجها) — والمندوب قوائمه وحدها، وبلا قوائم استعلامٌ واحد', async () => {
  reset();
  const seen: Raw[] = [];
  const pre = rawScript;
  rawScript = (r) => (isRulesSql(r) ? (seen.push(r), RAW_RULES()) : pre(r));
  const r = await call('GET', '/api/price-lists/rules');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /LEFT JOIN products p ON p\.id = r\."productId" AND p\."tenantId" = \?/);
  assert.match(seen[0].sql, /p\."deletedAt" IS NULL/);
  assert.deepEqual([seen[0].values[0], seen[0].values[1], (seen[0].values[2] as { values: string[] }).values], [T, T, ['L-W', 'L-R']]);
  assert.equal(r.body.data.length, 5);
  const product = r.body.data.find((x: { id: string }) => x.id === 'e-j');
  assert.deepEqual(product, {
    id: 'e-j', priceListId: 'L-W', scope: 'product', productId: 'p2', categoryId: null, kind: 'fixed', basePrice: 1.5, primaryPrice: null, percent: null,
    minQty: 0, startsOn: null, endsOn: null, updatedAt: STAMP.toISOString(), unit: 'علبة', baseConvertedAt: null,
  });
  assert.equal('unit' in r.body.data.find((x: { id: string }) => x.id === 'a-all'), false);
  assert.equal(calls.includes('salesRep.findFirst'), false, 'الإدارة بلا صفّ مندوب');
  // المندوب بلا التبديل: قوائم عملائه وحدها
  reset(REP);
  repWorld(false);
  const repSeen: Raw[] = [];
  const pre2 = rawScript;
  rawScript = (x) => (isRulesSql(x) ? (repSeen.push(x), []) : pre2(x));
  assert.equal((await call('GET', '/api/price-lists/rules')).status, 200);
  assert.deepEqual((repSeen[0].values[2] as { values: string[] }).values, ['L-W']);
  // وبالتبديل كلها
  reset(REP);
  repWorld(true);
  const all: Raw[] = [];
  const pre3 = rawScript;
  rawScript = (x) => (isRulesSql(x) ? (all.push(x), []) : pre3(x));
  await call('GET', '/api/price-lists/rules');
  assert.deepEqual((all[0].values[2] as { values: string[] }).values, ['L-W', 'L-R']);
  // شركةٌ بلا قوائم: استعلامٌ واحد ولا جملة
  reset();
  scripted['priceList.findMany'] = () => [];
  const none = await call('GET', '/api/price-lists/rules');
  assert.deepEqual(none.body, { success: true, data: [] });
  assert.deepEqual(calls.filter((c) => c !== 'admin.findUnique'), ['priceList.findMany']);
  assert.equal(raws.length, 0);
  // مندوبٌ لا قائمة له: لا جملة
  reset(REP);
  scripted['salesRep.findFirst'] = () => ({ canChangePriceList: false, defaultPriceListId: null });
  assert.deepEqual((await call('GET', '/api/price-lists/rules')).body.data, []);
  assert.equal(raws.length, 0);
});

test('GET /prices: لكل قائمةٍ قواعدها (rules) بجانب أسعارها — قاعدة الصنف بأساسه، وقائمةٌ بلا قواعد مصفوفةٌ فارغة', async () => {
  reset();
  const pre = rawScript;
  rawScript = (r) => {
    if (isRulesSql(r)) return RAW_RULES().slice(0, 2).concat([{ ...RAW_RULES()[4], id: 'r-retail', priceListId: 'L-R' }]);
    if (r.sql.includes('FROM price_list_items')) return [{ priceListId: 'L-W', productId: 'p1', price: 8 / 24, unit: 'حبة', baseConvertedAt: null }];
    return pre(r);
  };
  const r = await call('GET', '/api/price-lists/prices');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.map((l: { id: string; items: unknown[]; rules: Array<{ id: string }> }) => [l.id, l.items.length, l.rules.map((x) => x.id)]),
    [['L-W', 1, ['a-all', 'b-cat']], ['L-R', 0, ['r-retail']]]);
  assert.deepEqual(r.body.data[1].rules[0].unit, 'علبة', 'قاعدة الصنف الثابتة بأساس صنفها (rebase في التطبيق)');
  // المندوب بنطاقه: قواعد قائمته وحدها
  reset(REP);
  repWorld(false);
  const seen: Raw[] = [];
  const pre2 = rawScript;
  rawScript = (x) => (isRulesSql(x) ? (seen.push(x), []) : pre2(x));
  const rep = await call('GET', '/api/price-lists/prices');
  assert.deepEqual(rep.body.data, [{ id: 'L-W', name: 'L-W', items: [], rules: [] }]);
  assert.deepEqual((seen[0].values[2] as { values: string[] }).values, ['L-W']);
});

// ═══ (٥) جدول أسعار القائمة ═══

test('GET /:id/items: المسعّرة افتراضاً (كل الأصناف بـscope=all) غير المؤرشفة بالاسم، والبحث والفئة والصفحة (≤٢٠٠)، وسعر القائمة بالرئيسية بأربع منازل', async () => {
  reset();
  const seen: Record<string, any> = {};
  scripted['product.count'] = (a) => { seen.count = a.where; return 21; };
  scripted['product.findMany'] = (a) => {
    seen.find = a;
    return [
      { ...W.products.p1, category: { name: 'عصائر' }, priceListItems: [{ price: 0.416667 }] },
      { ...W.products.p2, category: { name: 'عصائر' }, priceListItems: [] },
    ];
  };
  scripted['priceListItem.count'] = (a) => { seen.priced = a.where; return 7; };
  const r = await call('GET', '/api/price-lists/L-W/items?page=2&limit=10');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(seen.count, { tenantId: T, deletedAt: null, priceListItems: { some: { priceListId: 'L-W' } } });
  assert.deepEqual(seen.find.where, seen.count);
  assert.deepEqual([seen.find.orderBy, seen.find.skip, seen.find.take], [[{ name: 'asc' }, { id: 'asc' }], 10, 10]);
  assert.deepEqual(seen.find.select.priceListItems, { where: { priceListId: 'L-W', tenantId: T }, select: { price: true } });
  assert.deepEqual(seen.priced, { tenantId: T, priceListId: 'L-W', product: { deletedAt: null } });
  assert.deepEqual(r.body.data, {
    rows: [
      { productId: 'p1', code: 'W1', name: 'ماء', categoryId: 'cat-j', categoryName: 'عصائر', unit: 'حبة', primaryUnit: { id: 'u-ct', name: 'كرتون', factor: 24 }, defaultPrice: 10, listPrice: 10, status: 'ACTIVE' },
      { productId: 'p2', code: 'J1', name: 'عصير', categoryId: 'cat-j', categoryName: 'عصائر', unit: 'علبة', primaryUnit: null, defaultPrice: 2, listPrice: null, status: 'ACTIVE' },
    ],
    pagination: { total: 21, page: 2, limit: 10, pages: 3 },
    pricedCount: 7,
  });
  // كل الأصناف، والبحث بالاسم أو الكود أو الباركود، والفئة، والحدّ ٢٠٠
  reset();
  scripted['product.findMany'] = (a) => { seen.find = a; return []; };
  await call('GET', '/api/price-lists/L-W/items?scope=all&search= ما &categoryId=cat-j&limit=5000');
  assert.deepEqual(seen.find.where, {
    tenantId: T, deletedAt: null, categoryId: 'cat-j',
    OR: [{ name: { contains: 'ما' } }, { code: { contains: 'ما' } }, { barcode: { contains: 'ما' } }],
  });
  assert.deepEqual([seen.find.skip, seen.find.take], [0, 200]);
  reset();
  scripted['product.findMany'] = (a) => { seen.find = a; return []; };
  const def = await call('GET', '/api/price-lists/L-W/items?limit=abc&page=-3');
  assert.deepEqual([seen.find.skip, seen.find.take, def.body.data.pagination.page, def.body.data.pagination.limit], [0, 50, 1, 50]);
  // قائمة شركةٍ أخرى
  reset();
  const x = await call('GET', '/api/price-lists/L-X/items');
  assert.deepEqual([x.status, x.body.code], [404, 'PRICE_LIST_INVALID']);
  assert.equal(calls.includes('product.findMany'), false);
});

test('المندوب يقرأ جدول قائمته وقواعدها وحدها: قائمةٌ ليست لعملائه ولا افتراضيّته ⇒ 404 كقائمة شركةٍ أخرى، وبـ«تبديل قائمة الأسعار» كلها', async () => {
  for (const url of ['/api/price-lists/L-R/items', '/api/price-lists/L-R/rules']) {
    reset(REP);
    repWorld(false);
    const r = await call('GET', url);
    assert.deepEqual([r.status, r.body.code], [404, 'PRICE_LIST_INVALID'], url);
    assert.equal(calls.some((c) => c === 'product.findMany' || c === 'priceListRule.findMany'), false);
  }
  for (const [url, can] of [['/api/price-lists/L-W/items', false], ['/api/price-lists/L-R/rules', true]] as const) {
    reset(REP);
    repWorld(can);
    assert.equal((await call('GET', url)).status, 200, url);
  }
});

const putItems = (items: unknown[], list = 'L-W') => call('PUT', `/api/price-lists/${list}/items`, { items });

test('PUT /:id/items: معاملةٌ واحدة — قفل الأصناف بترتيب المعرّف بأساس المحرّر، والرئيسية ÷ معاملها بستّ منازل، والمكرَّر الأخير يغلب، والطابع بالترتيب', async () => {
  reset();
  const r = await putItems([
    { productId: 'p2', price: 2.5, expectedBaseName: 'علبة' },
    { productId: 'p1', price: 10, expectedBaseName: 'حبة', expectedPrimary: { id: 'u-ct', factor: 24 } },
    { productId: 'p1', price: 12, expectedBaseName: 'حبة', expectedPrimary: { id: 'u-ct', factor: 24 } },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { rows: [{ productId: 'p2', listPrice: 2.5 }, { productId: 'p1', listPrice: 12 }] });
  assert.deepEqual(W.locks, [{ ids: ['p1', 'p2'], inTx: true }]);
  assert.deepEqual(W.upserts.map((u) => [u.args, u.inTx]), [
    [{ where: { priceListId_productId: { priceListId: 'L-W', productId: 'p2' } }, create: { tenantId: T, priceListId: 'L-W', productId: 'p2', price: 2.5 }, update: { price: 2.5 } }, true],
    [{ where: { priceListId_productId: { priceListId: 'L-W', productId: 'p1' } }, create: { tenantId: T, priceListId: 'L-W', productId: 'p1', price: 0.5 }, update: { price: 0.5 } }, true],
  ]);
  assert.deepEqual(W.seq, ['lock:p1,p2', 'upsert:p2', 'upsert:p1', 'touch:p1', 'touch:p2'], 'القفل أولاً والطابع بعد الكتابة بترتيب المعرّف');
  assert.deepEqual(txOpts, [{ ...BASE_GUARD_TX, timeout: BASE_GUARD_TX.timeout }]);
  // null يحذف (والطابع لمن حُذف له سعرٌ فعلاً)، وسطر الحذف لا يلزمه الأساس
  reset();
  const del = await putItems([{ productId: 'p1', price: null }]);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual(del.body.data.rows, [{ productId: 'p1', listPrice: null }]);
  assert.deepEqual(W.itemDeletes.map((d) => [d.args.where, d.inTx]), [[{ priceListId: 'L-W', productId: 'p1', tenantId: T }, true]]);
  assert.deepEqual(W.seq, ['lock:p1', 'itemDelete:p1', 'touch:p1']);
  reset();
  W.itemDeleteCount = 0;
  assert.equal((await putItems([{ productId: 'p1', price: null }])).status, 200);
  assert.equal(W.touches.length, 0, 'لا سعر حُذف ⇒ لا طابع');
});

test('PUT /:id/items: سطرٌ بسعر بلا الأساس 400 BASE_UNIT_REQUIRED، وصنفٌ غريب أو مؤرشف 400، وقائمةٌ غريبة 404، وأساسٌ أو رئيسيةٌ تغيّرت 409 — بلا أي كتابة', async () => {
  const ok = { productId: 'p1', price: 10, expectedBaseName: 'حبة' };
  const cases: Array<[unknown[], number, string, (() => void)?, string?]> = [
    [[ok, { productId: 'p2', price: 1 }], 400, 'BASE_UNIT_REQUIRED'],
    [[ok, { productId: 'pX', price: 1, expectedBaseName: 'حبة' }], 400, 'PRODUCT_NOT_FOUND'],
    [[ok, { productId: 'pA', price: null }], 400, 'PRODUCT_NOT_FOUND'],
    [[ok], 404, 'PRICE_LIST_INVALID', undefined, 'L-X'],
    [[{ productId: 'p2', price: 1, expectedBaseName: 'علبة' }, { ...ok, expectedBaseName: 'كرتون' }], 409, 'BASE_UNIT_CHANGED'],
    [[{ productId: 'p2', price: 1, expectedBaseName: 'علبة' }, ok], 409, 'BASE_UNIT_CHANGED', () => { W.lockedUnit.p1 = 'قارورة'; }],
    // السطر الأول صالح والثاني رئيسيّته تغيّرت: لا يُكتب الأول قبل فحص الثاني
    [[{ productId: 'p2', price: 1, expectedBaseName: 'علبة' }, { ...ok, expectedPrimary: { id: 'u-ct', factor: 12 } }], 409, 'PRIMARY_UNIT_CHANGED'],
    [[{ productId: 'p2', price: 1, expectedBaseName: 'علبة', expectedPrimary: { id: 'u-ct', factor: 24 } }], 409, 'PRIMARY_UNIT_CHANGED'],
    [[ok], 400, 'PRODUCT_NOT_FOUND', () => {
      const pre = scripted['product.findMany'];
      scripted['product.findMany'] = (a) => (inTx ? [{ ...W.products.p1, deletedAt: new Date() }] : pre(a));
    }],
  ];
  for (const [items, status, code, setup, list] of cases) {
    reset();
    setup?.();
    const r = await putItems(items, list);
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.deepEqual([r.body.code, r.body.message], [code, (PRICE_LIST_MESSAGES as Record<string, string>)[code]], code);
    assert.equal(W.upserts.length + W.itemDeletes.length + W.touches.length, 0, `${code}: لا كتابة`);
  }
  // الجسم: سطرٌ واحد على الأقل و٥٠٠ على الأكثر، والسعر رقمٌ غير سالب أو null صريحة
  for (const items of [[], Array.from({ length: 501 }, () => ok), [{ productId: 'p1', price: -1, expectedBaseName: 'حبة' }], [{ productId: 'p1', expectedBaseName: 'حبة' }]]) {
    reset();
    const r = await putItems(items);
    assert.equal(r.status, 400, `${items.length}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(calls.includes('$transaction'), false);
  }
});

test('PUT /:id/items: مهلة المعاملة تكبر بعدد السطور فوق مهلة الحارس (I10) — ٤٠٠ سطر ⇒ ٢٤ ثانية', async () => {
  reset();
  const items = Array.from({ length: 400 }, (_, i) => {
    const id = `q${String(i).padStart(3, '0')}`;
    W.products[id] = product(id);
    return { productId: id, price: 1, expectedBaseName: 'حبة' };
  });
  const r = await putItems(items);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual(txOpts, [{ maxWait: BASE_GUARD_TX.maxWait, timeout: 24_000 }]);
  assert.equal(W.locks.length, 1, 'قفلٌ واحد لكل الأصناف');
  assert.equal(W.touches.length, 400);
});
