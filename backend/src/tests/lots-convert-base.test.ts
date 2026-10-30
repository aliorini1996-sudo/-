// «تتبّع اللوط» × الوحدات المتعددة (D19، D22) — تحويل وحدة الأساس (POST /api/products/:id/convert-base) يضرب كميات جداول
// اللوط بـF كما يضرب لقطات البنود، داخل معاملته وبعد قفل اللوط للصنف. عبر الموجّه الحقيقي بعميل Prisma مزيّف (بلا قاعدة):
//   • van_load_item_lots.qty وinvoice_item_lots.quantity وlot_relabels.qty للصنف × F، والشركة والصنف شرطٌ في كل جملة.
//   • الترتيب: صفّ الصنف FOR UPDATE ← قفل اللوط (pg_advisory_xact_lock للمتتبَّع) ← أوّل كتابة. وكلها داخل المعاملة.
//   • صفوف اللوط تُضرب ولو لم يكن الصنف متتبَّعاً الآن (حقبةٌ سابقة)، بلا قفلٍ استشاري؛ وشكل الردّ كما كان حين لا صفوف.
//   • انتظار قفل اللوط وحده (55P03، 40P01) يصير 503 LOT_BUSY؛ ومهلة المعاملة بعده (P2028) خطأٌ عادي كغير المتتبَّع.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { lotLockKey } from '../services/lots';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Raw = { kind: '$queryRaw' | '$executeRaw'; sql: string; values: unknown[]; inTx: boolean };
let raws: Raw[] = [];
let inTx = false;
let scripted: Record<string, (args: any) => unknown> = {};
let rawScript: (r: Raw) => unknown = () => undefined;

const prismaFake: Record<string, unknown> = new Proxy({}, {
  get: (_t, key: string) => {
    if (key === '$transaction') {
      return async (fn: (tx: unknown) => Promise<unknown>) => {
        inTx = true;
        try { return await fn(prismaFake); } finally { inTx = false; }
      };
    }
    if (key === '$queryRaw' || key === '$executeRaw') {
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const r: Raw = { kind: key, sql: strings.join('?'), values, inTx };
        raws.push(r);
        const out = rawScript(r);
        return out !== undefined ? out : (key === '$queryRaw' ? [] : 0);
      };
    }
    if (key === 'then') return undefined;
    return new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        const fn = scripted[`${key}.${method}`];
        if (fn) return fn(args);
        if (method === 'findMany') return [];
        if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
        return null;
      },
    });
  },
});

const TENANT = 'T1';
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'owner', role: 'ADMIN', tenantId: TENANT, impersonated: true }; next(); },
  requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: (req: { user?: { tenantId?: string } }) => req.user?.tenantId ?? '',
  isOwnerSession: () => true, // التحويل بجلسة المالك (قرار المالك ٣٠ أكتوبر)
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const productsModule = require('../routes/products') as typeof import('../routes/products');

let server: { port: number; close: () => Promise<void> } | null = null;
after(async () => { await server?.close(); server = null; });

async function convert(body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use('/api/products', productsModule.default);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ success: false, message: err.message }); });
    const s = http.createServer(app);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    server = { port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server!.port, method: 'POST', path: '/api/products/p1/convert-base', agent: false,
      headers: { connection: 'close', 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : {} }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

type LotRow = { tenantId: string; productId: string; qty: number };
const LOT_TABLES = { van_load_item_lots: 'qty', invoice_item_lots: 'quantity', lot_relabels: 'qty' } as const;

/** صنفٌ كرتونه أساسٌ (٢٤ حبة بعد التحويل)، وصفوف لوطٍ له ولصنفٍ آخر ولشركةٍ أخرى بالمعرّف نفسه */
function world(lotTracked: boolean, withLots = true) {
  raws = []; inTx = false;
  const product = { id: 'p1', tenantId: TENANT, unit: 'كرتون', basePrice: 24, unitCode: 'CT', units: [] as unknown[], lotTracked, lotTrackedSince: null };
  const lots: Record<keyof typeof LOT_TABLES, LotRow[]> = withLots
    ? {
      van_load_item_lots: [{ tenantId: TENANT, productId: 'p1', qty: 10 }, { tenantId: TENANT, productId: 'p1', qty: -2 }, { tenantId: TENANT, productId: 'p2', qty: 3 }, { tenantId: 'T2', productId: 'p1', qty: 5 }],
      invoice_item_lots: [{ tenantId: TENANT, productId: 'p1', qty: 4 }, { tenantId: TENANT, productId: 'p2', qty: 1 }],
      lot_relabels: [{ tenantId: TENANT, productId: 'p1', qty: 0.5 }, { tenantId: 'T2', productId: 'p1', qty: 7 }],
    }
    : { van_load_item_lots: [], invoice_item_lots: [], lot_relabels: [] };
  scripted = {
    'product.findFirst': (args) => (args?.where?.id === 'p1' && args?.where?.tenantId === TENANT ? { ...product } : null),
    'product.updateMany': () => ({ count: 1 }),
    'productUnit.create': (args) => ({ id: 'u-new', ...args.data }),
    'customerPrice.updateMany': () => ({ count: 0 }),
  };
  // جمل اللوط تُنفَّذ على الذاكرة بالقيم التي مرّرها الموجّه: F ثم الشركة ثم الصنف
  rawScript = (r) => {
    if (r.kind !== '$executeRaw') return undefined;
    const m = /UPDATE "(\w+)" SET "(\w+)" = "(\w+)" \* \?::float8\s+WHERE "tenantId" = \? AND "productId" = \?\s*$/.exec(r.sql);
    if (!m || !(m[1] in LOT_TABLES)) return undefined;
    const table = m[1] as keyof typeof LOT_TABLES;
    assert.equal(m[2], LOT_TABLES[table], `${table}: العمود المضروب`);
    assert.equal(m[3], m[2], `${table}: يُضرب العمود في نفسه`);
    const [F, tid, pid] = r.values as [number, string, string];
    const mine = lots[table].filter((x) => x.tenantId === tid && x.productId === pid);
    for (const x of mine) x.qty *= F;
    return mine.length;
  };
  return { lots };
}

const CONVERT = { newBaseName: 'حبة', factor: 24, expectedBaseName: 'كرتون' };
const firstIdx = (pred: (r: Raw) => boolean) => raws.findIndex(pred);

test('convert-base لصنفٍ متتبَّع: كميات جداول اللوط × F للصنف والشركة وحدهما، بعد FOR UPDATE ثم قفل اللوط وقبل أي كتابة', async () => {
  const { lots } = world(true);
  const r = await convert(CONVERT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lots.van_load_item_lots.map((x) => x.qty), [240, -48, 3, 5], 'صفوف الصنف (بإشارتها) × ٢٤، وصنفٌ آخر وشركةٌ أخرى كما هما');
  assert.deepEqual(lots.invoice_item_lots.map((x) => x.qty), [96, 1]);
  assert.deepEqual(lots.lot_relabels.map((x) => x.qty), [12, 7]);
  assert.deepEqual({ v: r.body.converted.vanLoadItemLots, i: r.body.converted.invoiceItemLots, l: r.body.converted.lotRelabels }, { v: 2, i: 1, l: 1 });

  const lockRow = firstIdx((x) => x.kind === '$queryRaw' && /FROM products WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(x.sql));
  const advisory = firstIdx((x) => x.kind === '$executeRaw' && /pg_advisory_xact_lock/.test(x.sql));
  const firstWrite = firstIdx((x) => x.kind === '$executeRaw' && /^\s*UPDATE /.test(x.sql));
  const lotWrites = raws.filter((x) => x.kind === '$executeRaw' && /UPDATE "(van_load_item_lots|invoice_item_lots|lot_relabels)"/.test(x.sql));
  assert.ok(lockRow >= 0 && advisory > lockRow && firstWrite > advisory, `الترتيب: صفّ الصنف ${lockRow} ← قفل اللوط ${advisory} ← أوّل كتابة ${firstWrite}`);
  assert.deepEqual(raws[advisory].values, [lotLockKey(TENANT, 'p1')], 'مفتاح قفل (الشركة، الصنف)');
  assert.equal(lotWrites.length, 3, 'جملةٌ لكل جدول لوط');
  for (const w of [...lotWrites, raws[advisory]]) assert.equal(w.inTx, true, 'داخل معاملة التحويل');
  for (const w of lotWrites) assert.deepEqual(w.values, [24, TENANT, 'p1'], 'F ثم الشركة ثم الصنف');
  // lock_timeout يُضبط ويُستعاد حول القفل (lockLotProducts)، ولا FOR KEY SHARE ثانٍ على الصفّ المقفل سلفاً
  assert.ok(raws.some((x) => /set_config\('lock_timeout'/.test(x.sql)));
  assert.ok(!raws.some((x) => /FOR KEY SHARE/.test(x.sql)), 'الصفّ المقفل FOR UPDATE يُمرَّر (lockedRows)');
});

test('convert-base لصنفٍ غير متتبَّع الآن: صفوف لوطه (حقبةٌ سابقة) تُضرب أيضاً بلا قفلٍ استشاري، وبلا صفوفٍ شكلُ الردّ كما كان', async () => {
  const { lots } = world(false);
  const r = await convert(CONVERT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(lots.van_load_item_lots.map((x) => x.qty), [240, -48, 3, 5]);
  assert.deepEqual(lots.invoice_item_lots.map((x) => x.qty), [96, 1]);
  assert.deepEqual(lots.lot_relabels.map((x) => x.qty), [12, 7]);
  assert.ok(!raws.some((x) => /pg_advisory_xact_lock|lock_timeout/.test(x.sql)), 'غير المتتبَّع بلا قفل لوط (§١٠.٢)');

  world(false, false);
  const r2 = await convert(CONVERT);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  for (const k of ['vanLoadItemLots', 'invoiceItemLots', 'lotRelabels']) assert.ok(!(k in r2.body.converted), `${k} في ردّ صنفٍ بلا لوط (§١٠.١)`);
  assert.equal(r2.body.converted.factor, 24);
});

test('convert-base: انشغال قفل اللوط لصنفٍ متتبَّع ⇒ 503 LOT_BUSY ولا كتابة، والرفض قبله بلا قفل', async () => {
  world(true);
  const base = rawScript;
  rawScript = (r) => {
    if (/pg_advisory_xact_lock/.test(r.sql)) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } });
    return base(r);
  };
  const r = await convert(CONVERT);
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'LOT_BUSY');
  assert.ok(!raws.some((x) => x.kind === '$executeRaw' && /^\s*UPDATE /.test(x.sql)), 'لا كتابة قبل القفل');

  world(true);
  const bad = await convert({ ...CONVERT, expectedBaseName: 'علبة' });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'BASE_UNIT_CHANGED');
  assert.ok(!raws.some((x) => /pg_advisory_xact_lock/.test(x.sql)), 'الرفض البنيوي قبل قفل اللوط');

  // والتعطّل المتبادل (40P01) على القفل نفسه انشغالٌ كذلك
  world(true);
  const base2 = rawScript;
  rawScript = (r) => {
    if (/pg_advisory_xact_lock/.test(r.sql)) throw Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } });
    return base2(r);
  };
  const dl = await convert(CONVERT);
  assert.equal(dl.status, 503, JSON.stringify(dl.body));
  assert.equal(dl.body.code, 'LOT_BUSY');
});

test('convert-base لصنفٍ متتبَّع: مهلة المعاملة (P2028، ١٢٠ ثانية) بعد قفل اللوط ليست انشغالاً — تمضي إلى معالج الأخطاء كغير المتتبَّع لا 503 LOT_BUSY', async () => {
  for (const tracked of [true, false]) {
    world(tracked);
    const base = rawScript;
    rawScript = (r) => {
      if (/UPDATE "invoice_item_lots"/.test(r.sql)) {
        throw Object.assign(new Error('Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.'), { code: 'P2028' });
      }
      return base(r);
    };
    const r = await convert(CONVERT);
    assert.equal(r.status, 500, `${tracked ? 'متتبَّع' : 'غير متتبَّع'}: ${JSON.stringify(r.body)}`);
    assert.notEqual(r.body.code, 'LOT_BUSY', '«أعد المحاولة» تنتهي إلى المهلة نفسها');
    assert.equal(raws.some((x) => /pg_advisory_xact_lock/.test(x.sql)), tracked, 'المهلة بعد قفل اللوط للمتتبَّع');
  }
});
