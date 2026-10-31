// «الوحدة الرئيسية» §2.7 و§2.8 (B3a) — حارس الأساس في كاتبَي المخزون: تحميل السيارة (POST /van-stock/loads، ومنه إزالة المنتهي
// والتالف) ووارد المستودع وتسويته (POST /warehouse/entries) — المعالجات الحقيقية فوق Prisma مزيّف يجيب SQL الأقفال.
//
// لكل كاتب: كاشٌ قديم (baseUnitName ≠ أساس الصنف الآن) ⇒ 400 UNIT_INVALID بلا إنشاء ولا معاملة؛ سباقٌ مع تحويلٍ التزم بين القراءة
// والقفل ⇒ 409 PRODUCT_UNITS_CHANGED حيّاً و503 لإعادة الرفع بلا إنشاء؛ انتظار قفل تحويلٍ طويل ⇒ 503 PRODUCT_UNITS_BUSY؛ جسمٌ بلا
// الحقل ⇒ مسار اليوم وتُحرس السباقات؛ I3 لصنفٍ رئيسيّه كرتون (بندٌ بلا unitId ⇒ معامل ١)؛ مفتاح API على صنفٍ محوَّل بلا الحقل ⇒
// 400 BASE_UNIT_REQUIRED (D19)؛ والفرع المطفأ صار معاملةً بـBASE_GUARD_TX.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const T = 'T1';
const BG = { maxWait: 10_000, timeout: 20_000 };
const LONG = 'ع'.repeat(70); // اسم أساسٍ أطول من ٦٤ حرفاً (D20-أ)

let st: {
  products: Row[]; units: Row[]; loadItems: Row[]; invItems: Row[];
  createdLoads: Row[]; createdEntries: Row[]; sql: { op: string; sql: string; values: unknown[] }[]; txOpts: unknown[];
  /** أساس الصنف كما يراه القفل — تحويلٌ التزم بين القراءة المسبقة والقفل */
  unitAtLock: Record<string, string>;
  lockFail: unknown; lotsEnabled: boolean;
  /** يُستدعى بعد قراءة وحدات البنود (productUnit.findMany) — تحويلٌ يلتزم بين حلّ الوحدات وبقية القراءات */
  afterUnitRead?: () => void;
};
const reset = () => {
  st = {
    products: [
      { id: 'P1', tenantId: T, name: 'ماء', code: 'W', unit: 'قارورة', taxPct: 0, status: 'ACTIVE', primaryUnitId: null, baseConvertedAt: null, lotTracked: false },
      { id: 'P2', tenantId: T, name: 'عصير', code: 'J', unit: 'علبة', taxPct: 0, status: 'ACTIVE', primaryUnitId: null, baseConvertedAt: null, lotTracked: false },
      { id: 'PL', tenantId: T, name: 'طويل', code: 'L', unit: LONG, taxPct: 0, status: 'ACTIVE', primaryUnitId: null, baseConvertedAt: null, lotTracked: false },
    ],
    units: [{ id: 'U-CT', tenantId: T, productId: 'P1', name: 'كرتون', factor: 24, isActive: true, sortOrder: 0 }],
    loadItems: [], invItems: [], createdLoads: [], createdEntries: [], sql: [], txOpts: [], unitAtLock: {}, lockFail: null, lotsEnabled: false,
  };
};
reset();

const inIds = (v: unknown, x: unknown) => v === undefined || (v && typeof v === 'object' && 'in' in v ? (v as { in: unknown[] }).in.includes(x) : v === x);
const render = (strings: TemplateStringsArray, values: unknown[]) => ({
  sql: strings.reduce((s, p, i) => s + p + (i < values.length ? `$${i + 1}` : ''), '').replace(/\s+/g, ' ').trim(), values,
});
const withTrigger = (r: Row): Row => ({ unitFactor: 1, unitName: null, ...r, baseQty: r.baseQty ?? r.qty * (r.unitFactor || 1) });
const unitsOf = (pid: string) => st.units.filter((u) => u.productId === pid).map(({ id, name, factor, isActive }) => ({ id, name, factor, isActive }));

const db: Row = {
  admin: { async findUnique() { return { scopeEnabled: false }; } },
  glSettings: { async findUnique() { return null; } },
  companySettings: { async findUnique() { return { currency: 'SAR', countryCode: 'SA' }; } },
  salesRep: {
    async findFirst(a: Row) {
      return a.where.id === 'R1' ? { id: 'R1', name: 'أحمد', tenantId: T, canManageVanStock: true, locationId: null, tenant: { locationsEnabled: false, lotTrackingEnabled: st.lotsEnabled, warehouseEnabled: false } } : null;
    },
  },
  product: {
    async findMany(a: Row) {
      return st.products.filter((p) => p.tenantId === (a.where?.tenantId ?? T) && inIds(a.where?.id, p.id))
        .map((p) => ({ ...p, ...(a.select?.units && { units: unitsOf(p.id) }) }));
    },
  },
  productUnit: {
    async findMany(a: Row) {
      const out = st.units.filter((u) => u.tenantId === a.where.tenantId && inIds(a.where.id, u.id) && inIds(a.where.productId, u.productId))
        .map((u) => ({ id: u.id, productId: u.productId, name: u.name, factor: u.factor, isActive: u.isActive }));
      st.afterUnitRead?.();
      return out;
    },
  },
  vanLoad: {
    async create(a: Row) {
      const items = (a.data.items.create as Row[]).map(withTrigger);
      st.createdLoads.push({ ...a.data, items, include: a.include });
      return { id: 'VNEW', ...a.data, items };
    },
  },
  vanLoadItem: { async findMany() { return st.loadItems; } },
  invoiceItem: { async findMany() { return st.invItems; } },
  warehouseEntry: {
    async create(a: Row) {
      const items = (a.data.items.create as Row[]).map(withTrigger);
      st.createdEntries.push({ ...a.data, items, include: a.include });
      return { id: 'ENEW', ...a.data, items };
    },
  },
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const r = render(strings, values);
    st.sql.push({ op: 'query', ...r });
    if (r.sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    if (r.sql.includes('FOR KEY SHARE')) {
      if (st.lockFail) throw st.lockFail;
      const ids = values[1] as string[];
      return st.products.filter((p) => ids.includes(p.id)).sort((x, y) => (x.id < y.id ? -1 : 1))
        .map((p) => ({ id: p.id, ...(/\bunit\b/.test(r.sql) && { unit: st.unitAtLock[p.id] ?? p.unit }), lotTracked: false, lotTrackedSince: null }));
    }
    return [];
  },
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) { st.sql.push({ op: 'exec', ...render(strings, values) }); return 1; },
};
db.$transaction = async (fn: (tx: Row) => Promise<unknown>, opts?: unknown) => { st.txOpts.push(opts); return fn(db); };
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const vanRouter = (require('../routes/vanStock') as typeof import('../routes/vanStock')).default;
const warehouseRouter = (require('../routes/warehouse') as typeof import('../routes/warehouse')).default;
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'المدير' };
const API = { id: 'KEY', role: 'ADMIN', tenantId: T, name: 'ERP', apiKeyId: 'k1' };

/** مكدّس المسار وحده، والخطأ ذو الحالة كمعالج الأخطاء العام (UNIT_INVALID برمزه) */
async function call(router: unknown, p: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.post);
  assert.ok(layer, `POST ${p} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  for (const h of layer.route.stack as Row[]) {
    let passed = false;
    let err: Row | undefined;
    await h.handle(full, res, (e?: Row) => { if (e) err = e; else passed = true; });
    if (err) {
      if (typeof err.status === 'number') return { status: err.status, body: { success: false, message: err.message, ...(err.code && { code: err.code }) } };
      throw err;
    }
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}
const load = (body: Row, extra: Row = {}) => call(vanRouter, '/loads', { body: { salesRepId: 'R1', type: 'LOAD', ...body }, ...extra });
const entry = (body: Row, extra: Row = {}) => call(warehouseRouter, '/entries', { body: { type: 'RECEIVE', ...body }, ...extra });
const baseLocks = () => st.sql.filter((c) => c.op === 'query' && /^SELECT id, unit, "lotTracked", "lotTrackedSince" FROM products .*FOR KEY SHARE$/.test(c.sql));
const created = () => st.createdLoads.length + st.createdEntries.length;

/** مرتجعٌ منتهٍ أو تالف في سيارة R1 — رصيد الإزالة بالأساس */
const seedUnsellable = (productId: string, qty: number, kind: 'expired' | 'damaged') => {
  const at = new Date('2026-10-25T10:00:00.000Z'); // بعد DAMAGED_VAN_SINCE
  st.invItems.push({
    productId, qty, unitFactor: 1, baseQty: qty, returnExpired: kind === 'expired',
    invoice: { type: 'RETURN', returnToStock: false, invoiceDate: at, returnReason: kind === 'damaged' ? 'DAMAGED' : null, createdAt: at },
  });
};

const WRITERS = [
  { name: 'تحميل السيارة', post: load, body: (items: Row[]) => ({ items }) },
  { name: 'إزالة المنتهي', post: load, body: (items: Row[]) => ({ type: 'EXPIRED_OUT', items }), seed: 'expired' as const },
  { name: 'إزالة التالف', post: load, body: (items: Row[]) => ({ type: 'DAMAGED_OUT', items }), seed: 'damaged' as const },
  { name: 'وارد المستودع', post: entry, body: (items: Row[]) => ({ items }) },
  { name: 'تسوية المستودع', post: entry, body: (items: Row[]) => ({ type: 'ADJUST', items }) },
];
const fresh = (w: (typeof WRITERS)[number]) => { reset(); if (w.seed) { seedUnsellable('P1', 50, w.seed); seedUnsellable('P2', 50, w.seed); } };

test('كاشٌ قديم: baseUnitName ≠ أساس الصنف الآن ⇒ 400 UNIT_INVALID «تغيّرت وحدات» بلا معاملة ولا إنشاء — لكل كاتب', async () => {
  for (const w of WRITERS) {
    fresh(w);
    const r = await w.post(w.body([{ productId: 'P2', qty: 2, baseUnitName: 'علبة' }, { productId: 'P1', qty: 2, baseUnitName: 'كرتون' }]));
    assert.deepEqual([r.status, r.body?.code], [400, 'UNIT_INVALID'], `${w.name}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, /تغيّرت وحدات «ماء» — حدّث قائمة الأصناف/, w.name);
    assert.doesNotMatch(r.body.message, /الأساس/, 'D21');
    assert.deepEqual([created(), st.txOpts.length], [0, 0], w.name);
  }
});

test('السباق: تحويلٌ التزم بين القراءة والقفل ⇒ 409 PRODUCT_UNITS_CHANGED حيّاً بلا إنشاء — ولو بلا baseUnitName (الأساس من القراءة المسبقة)', async () => {
  for (const w of WRITERS) {
    for (const items of [[{ productId: 'P1', qty: 3, baseUnitName: 'قارورة' }], [{ productId: 'P1', qty: 3 }]]) {
      fresh(w);
      st.unitAtLock.P1 = 'قطعة';
      const r = await w.post(w.body(items));
      assert.deepEqual([r.status, r.body?.code], [409, 'PRODUCT_UNITS_CHANGED'], `${w.name}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.message, /«ماء»/);
      assert.equal(created(), 0, w.name);
      assert.equal(baseLocks().length, 1, `${w.name}: قفل الأساس داخل المعاملة`);
    }
  }
});

test('إعادة الرفع أوف‑لاين (X-FS-Replay): السباق ⇒ 503 لا 409 فيعيد الصندوق، والمقارنة الحيّة لا تُعدم مستنداً سُجّل على الجهاز', async () => {
  for (const type of ['LOAD', 'EXPIRED_OUT']) {
    reset();
    seedUnsellable('P1', 50, 'expired');
    st.unitAtLock.P1 = 'قطعة';
    const r = await load({ type, items: [{ productId: 'P1', qty: 1 }] }, { headers: { 'x-fs-replay': '1' } });
    assert.deepEqual([r.status, r.body?.code], [503, 'PRODUCT_UNITS_CHANGED'], `${type}: ${JSON.stringify(r.body)}`);
    assert.equal(created(), 0);
  }
  // كاشٌ قديم في إعادة الرفع: لا 400 (لا يُعدم مستندٌ سُجّل على الجهاز)، ولا كتابةٌ صامتة بأساسٍ يعرف الخادم أنه غير أساس العميل
  // (كمية كرتونٍ تُكتب قوارير) ⇒ 503 PRODUCT_UNITS_CHANGED كالسباق، بلا معاملة ولا إنشاء
  for (const type of ['LOAD', 'EXPIRED_OUT']) {
    reset();
    seedUnsellable('P1', 50, 'expired');
    const r = await load({ type, items: [{ productId: 'P1', qty: 1, baseUnitName: 'كرتون' }] }, { headers: { 'x-fs-replay': '1' } });
    assert.deepEqual([r.status, r.body?.code], [503, 'PRODUCT_UNITS_CHANGED'], `${type}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, /«ماء»/);
    assert.deepEqual([created(), st.txOpts.length], [0, 0]);
  }
  // وبالأساس الصحيح في إعادة الرفع ⇒ مسار اليوم
  reset();
  const ok = await load({ items: [{ productId: 'P1', qty: 1, baseUnitName: 'قارورة' }] }, { headers: { 'x-fs-replay': '1' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('السباق بين حلّ وحدات البنود وقراءة الأصناف: تحويلٌ يلتزم بعد قراءة الوحدة ⇒ 409 بلا إنشاء (الأساس المتوقَّع يُقرأ قبل الوحدات) — لكل كاتب', async () => {
  for (const w of WRITERS) {
    fresh(w);
    // البند بالكرتون (×24 على «قارورة»)، والتحويل يلتزم لحظة قراءة وحدته: الأساس صار «قطعة» في القاعدة وتحت القفل
    st.afterUnitRead = () => { st.products[0].unit = 'قطعة'; };
    const r = await w.post(w.body([{ productId: 'P1', qty: 2, unitId: 'U-CT' }]));
    assert.deepEqual([r.status, r.body?.code], [409, 'PRODUCT_UNITS_CHANGED'], `${w.name}: ${JSON.stringify(r.body)}`);
    assert.equal(created(), 0, `${w.name}: لا يُكتب معامل ما قبل التحويل على الأساس الجديد`);
  }
});

test('انتظار قفل تحويلٍ طويل (55P03 / 40P01 / P2028) ⇒ 503 PRODUCT_UNITS_BUSY بلا إنشاء — لكل كاتب', async () => {
  for (const w of WRITERS) {
    for (const fail of [
      Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }),
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      Object.assign(new Error('Transaction already closed'), { code: 'P2028' }),
    ]) {
      fresh(w);
      st.lockFail = fail;
      const r = await w.post(w.body([{ productId: 'P1', qty: 1 }]));
      assert.deepEqual([r.status, r.body?.code], [503, 'PRODUCT_UNITS_BUSY'], `${w.name}: ${JSON.stringify(r.body)}`);
      assert.equal(created(), 0);
    }
  }
});

test('parity-4: انشغالٌ خارج قفل الأصناف (P2028 أو تعطّلٌ متبادل عند الإنشاء، والميزة مطفأة) ليس PRODUCT_UNITS_BUSY — يمرّ إلى المعالج العام كما كان', async () => {
  for (const w of WRITERS) {
    for (const fail of [
      Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction.'), { code: 'P2028' }),
      Object.assign(new Error('deadlock detected'), { code: 'P2010', meta: { code: '40P01' } }),
    ]) {
      fresh(w);
      const orig = { load: db.vanLoad.create, entry: db.warehouseEntry.create };
      db.vanLoad.create = async () => { throw fail; };
      db.warehouseEntry.create = async () => { throw fail; };
      try {
        await assert.rejects(w.post(w.body([{ productId: 'P1', qty: 1 }])), (e: unknown) => e === fail, `${w.name}: ردٌّ برمزٍ بدل المعالج العام`);
      } finally {
        db.vanLoad.create = orig.load;
        db.warehouseEntry.create = orig.entry;
      }
    }
  }
});

test('بلا baseUnitName ومع الأساس الصحيح ⇒ مسار اليوم (201)، والفرع المطفأ معاملةٌ بـBASE_GUARD_TX فيها قفل الأساس بمهلته المحلية', async () => {
  for (const w of WRITERS) {
    for (const items of [[{ productId: 'P1', qty: 2 }], [{ productId: 'P1', qty: 2, baseUnitName: ' قارورة ' }]]) {
      fresh(w);
      const r = await w.post(w.body(items));
      assert.equal(r.status, 201, `${w.name}: ${JSON.stringify(r.body)}`);
      assert.equal(created(), 1);
      assert.deepEqual(st.txOpts, [BG], `${w.name}: BASE_GUARD_TX (I10)`);
      // حفظ المهلة ثم ضبطها ثم القفل ثم الاستعادة
      const i = st.sql.findIndex((c) => baseLocks().includes(c));
      assert.ok(i >= 2, w.name);
      assert.match(st.sql[i - 1].sql, /set_config\('lock_timeout'/);
      assert.match(st.sql[i - 2].sql, /current_setting\('lock_timeout'\)/);
      assert.match(st.sql[i + 1].sql, /set_config\('lock_timeout'/);
      assert.deepEqual(baseLocks()[0].values, [T, ['P1']]);
    }
  }
});

test('I3: صنفٌ رئيسيّه كرتون — بندٌ بلا unitId يُكتب بالأساس بمعامل ١ (D3)، وبالكرتون صراحةً ×٢٤ — في التحميل والوارد', async () => {
  for (const post of [load, entry]) {
    reset();
    st.products[0].primaryUnitId = 'U-CT';
    const r = await post({ items: [{ productId: 'P1', qty: 5 }, { productId: 'P1', qty: 2, unitId: 'U-CT' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const items = (st.createdLoads[0] ?? st.createdEntries[0]).items;
    assert.deepEqual(items.map((i: Row) => [i.qty, i.unitFactor, i.baseQty, i.unitName]), [[5, 1, 5, null], [2, 24, 48, 'كرتون']]);
  }
});

test('D19: مفتاح API على صنفٍ محوَّل بلا baseUnitName ⇒ 400 BASE_UNIT_REQUIRED بلا معاملة؛ وبالأساس يمرّ؛ وغير المحوَّل واللوحة كما اليوم', async () => {
  for (const w of WRITERS) {
    fresh(w);
    st.products[0].baseConvertedAt = new Date('2026-10-30T09:00:00.000Z');
    const r = await w.post(w.body([{ productId: 'P2', qty: 1 }, { productId: 'P1', qty: 1 }]), { user: API });
    assert.deepEqual([r.status, r.body?.code], [400, 'BASE_UNIT_REQUIRED'], `${w.name}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, /«ماء»/);
    assert.deepEqual([created(), st.txOpts.length], [0, 0]);
    const ok = await w.post(w.body([{ productId: 'P2', qty: 1 }, { productId: 'P1', qty: 1, baseUnitName: 'قارورة' }]), { user: API });
    assert.equal(ok.status, 201, `${w.name}: ${JSON.stringify(ok.body)}`);
    const stale = await w.post(w.body([{ productId: 'P1', qty: 1, baseUnitName: 'كرتون' }]), { user: API });
    assert.deepEqual([stale.status, stale.body?.code], [400, 'UNIT_INVALID'], 'أساسٌ مختلف من المفتاح كاشٌ قديم');
    const panel = await w.post(w.body([{ productId: 'P1', qty: 1 }]));
    assert.equal(panel.status, 201, `${w.name}: اللوحة لا تتأثّر بـD19`);
  }
  reset();
  const untouched = await load({ items: [{ productId: 'P1', qty: 1 }] }, { user: API });
  assert.equal(untouched.status, 201, 'صنفٌ لم يُحوَّل ⇒ مسار اليوم للمفتاح');
});

test('D20-أ: اسم أساسٍ أطول من ٦٤ حرفاً يُرسَل كاملاً ⇒ لا UNIT_INVALID كاذب (المخطّط يقصّه، والمقارنة بـbaseNameKey)', async () => {
  for (const post of [load, entry]) {
    reset();
    const r = await post({ items: [{ productId: 'PL', qty: 1, baseUnitName: LONG }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});

test('الإزالة: رسالة تجاوز الرصيد بالوحدة الرئيسية لصنفٍ له رئيسية، والنص القائم حرفياً لصنفٍ بلاها (I1)', async () => {
  reset();
  seedUnsellable('P1', 26, 'damaged');
  seedUnsellable('P2', 26, 'damaged');
  const plain = await load({ type: 'DAMAGED_OUT', items: [{ productId: 'P2', qty: 30 }] });
  assert.deepEqual([plain.status, plain.body?.message], [400, 'الكمية أكبر من التالف في السيارة (26)']);
  st.products[0].primaryUnitId = 'U-CT';
  const prim = await load({ type: 'DAMAGED_OUT', items: [{ productId: 'P1', qty: 2, unitId: 'U-CT' }] });
  assert.deepEqual([prim.status, prim.body?.message], [400, 'الكمية أكبر من التالف في السيارة (1 كرتون و2 قارورة)']);
  st.products[0].primaryUnitId = 'GONE';
  const broken = await load({ type: 'DAMAGED_OUT', items: [{ productId: 'P1', qty: 30 }] });
  assert.equal(broken.body?.message, 'الكمية أكبر من التالف في السيارة (26)', 'معرّفٌ تالف ⇒ النص القائم');
  assert.equal(created(), 0);
});

test('العرض: ردّ الإنشاء يحمل primaryUnitId في صنف كل بند (فخّ «×5»)، والكميات بالأساس كما هي', async () => {
  reset();
  await load({ items: [{ productId: 'P1', qty: 1 }] });
  await entry({ items: [{ productId: 'P1', qty: 1 }] });
  assert.equal(st.createdLoads[0].include.items.include.product.select.primaryUnitId, true);
  assert.equal(st.createdEntries[0].include.items.include.product.select.primaryUnitId, true);
});

test('فخّ «×5» نصّاً (§10): selects العرض في vanStock.ts وwarehouse.ts تحمل primaryUnitId، وحركات السيارة تُلحقه لكل بند (null بلا رئيسية، D18)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const van = read('routes/vanStock.ts');
  const wh = read('routes/warehouse.ts');
  const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a) + a.length));
  assert.ok(between(van, "router.get('/loads'", "router.get('/movements'").includes('product: { select: { id: true, name: true, unit: true, primaryUnitId: true } }'));
  const mv = between(van, "router.get('/movements'", "router.get('/tools'");
  assert.equal((mv.match(/product: \{ select: \{ name: true, unit: true, primaryUnitId: true \} \}/g) ?? []).length, 2, 'التحميلات والفواتير');
  assert.ok(mv.includes('({ primaryUnitId: p?.primaryUnitId || null })'), 'المفتاح حاضرٌ دائماً: المعرّف أو null (D18)');
  assert.ok(van.includes('select: { id: true, name: true, unit: true, code: true, primaryUnitId: true } }'), 'computeStock (GET /current)');
  assert.ok(between(wh, "router.get('/entries'", 'export default router').includes('product: { select: { name: true, unit: true, primaryUnitId: true } }'));
  assert.ok(read('services/warehouseStock.ts').includes('units: { select: UNIT_SELECT }, primaryUnitId: true },'), 'loadWarehouseInputs');
  // I2: الحساب لا يقرأ الرئيسية
  for (const f of ['services/warehouseCost.ts', 'services/lotsDb.ts']) assert.doesNotMatch(read(f), /primaryUnitId/, f);
});
