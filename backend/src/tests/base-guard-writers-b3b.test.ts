// «الوحدة الرئيسية» §2.9 و§2.10 و§2.11ب (الحزمة B3b) — حارس وحدة الأساس في كتّاب: طلب البضاعة (المندوب وتعديل الإدارة)، وأسعار
// العميل الخاصة، وإعادة وسم LOT. المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة، والقفل FOR KEY SHARE يجيبه المزيّف بأساس الصنف
// «تحت القفل» (lockedUnit) فيُحاكى تحويلٌ التزم بين القراءة والكتابة. لكل كاتب: كاشٌ قديم ⇒ 400 UNIT_INVALID بلا كتابة، وسباق ⇒ 409
// (503 لإعادة الرفع)، وجسمٌ بلا الحقل ⇒ مسار اليوم، ومفتاح API على صنفٍ محوَّل بلا الحقل ⇒ 400 BASE_UNIT_REQUIRED، وI3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

type Row = Record<string, any>;
const T = 'T1';
const CONVERTED = new Date('2026-10-30T10:00:00.000Z');

let PRODUCTS: Row[] = [];
let st: { upserts: Row[]; created: Row[]; updatedItems: Row[]; txOpts: unknown[]; sql: string[]; productQueries: number };
/** أساس الصنف كما يراه القفل (تحويلٌ التزم بعد القراءة): غائبٌ ⇒ أساسه في PRODUCTS */
let lockedUnit: Record<string, string> = {};
let pending: Row | null = null;

const reset = () => {
  PRODUCTS = [
    // P1 قارورة بكرتونٍ رئيسي (عرضٌ فقط)، وP2 حُوِّل أساسه من كرتون إلى قارورة، وP3 صنفٌ قديم بلا وحدات
    { id: 'P1', tenantId: T, name: 'ماء', code: 'W', unit: 'قارورة', primaryUnitId: 'U-CT', baseConvertedAt: null, deletedAt: null, lotTracked: false, lotTrackedSince: null },
    { id: 'P2', tenantId: T, name: 'عصير', code: 'J', unit: 'قارورة', primaryUnitId: null, baseConvertedAt: CONVERTED, deletedAt: null, lotTracked: false, lotTrackedSince: null },
    { id: 'P3', tenantId: T, name: 'سكر', code: 'S', unit: 'كيس', primaryUnitId: null, baseConvertedAt: null, deletedAt: null, lotTracked: false, lotTrackedSince: null },
  ];
  st = { upserts: [], created: [], updatedItems: [], txOpts: [], sql: [], productQueries: 0 };
  lockedUnit = {};
  pending = null;
};
reset();

const inIds = (v: any, x: unknown) => (v === undefined ? true : v && typeof v === 'object' && 'in' in v ? (v.in as unknown[]).includes(x) : v === x);
const sqlOf = (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('$')).replace(/\s+/g, ' ').trim();

const db: Row = {
  admin: { async findUnique() { return { isActive: true, scopeEnabled: false, scopeMode: 'LISTS' }; } },
  glSettings: { async findUnique() { return null; } },
  companySettings: { async findUnique() { return { countryCode: 'SA', currency: 'SAR' }; } },
  tenant: { async findUnique() { return { warehouseEnabled: true, lotTrackingEnabled: true }; } },
  customer: { async findFirst(a: Row) { return a.where.id === 'C1' ? { id: 'C1' } : null; } },
  customerPrice: { async upsert(a: Row) { st.upserts.push(a); return { id: 'CP' }; } },
  product: {
    async findMany(a: Row) {
      st.productQueries++;
      return PRODUCTS.filter((p) => inIds(a.where?.id, p.id) && p.tenantId === a.where?.tenantId && (a.where?.deletedAt !== null || p.deletedAt === null));
    },
    async findFirst(a: Row) {
      st.productQueries++;
      return PRODUCTS.find((p) => p.id === a.where?.id && p.tenantId === a.where?.tenantId) ?? null;
    },
  },
  productUnit: {
    async findMany(a: Row) {
      const units = [{ id: 'U-CT', productId: 'P1', name: 'كرتون', factor: 24, isActive: true }];
      return units.filter((u) => inIds(a.where?.id, u.id));
    },
  },
  repStockRequest: {
    async findFirst() { return pending; },
    async create(a: Row) {
      const items = (a.data.items.create as Row[]).map((i) => ({ ...i, product: { ...PRODUCTS.find((p) => p.id === i.productId)!, units: [] } }));
      st.created.push({ ...a.data, items });
      return { id: 'Q1', status: 'PENDING', note: a.data.note, createdAt: new Date(), updatedAt: new Date(), decidedAt: null, sentRef: null, items };
    },
    async update() {
      return { id: 'Q1', status: 'PENDING', note: null, createdAt: new Date(), updatedAt: new Date(), decidedAt: null, sentRef: null, items: [] };
    },
  },
  repStockRequestItem: { async update(a: Row) { st.updatedItems.push(a); return {}; } },
  lotRelabel: { async create() { throw new Error('لا كتابة في هذه الاختبارات'); } },
};
// المعاملة تمرّر المزيّف نفسه بأقفاله الخام: FOR KEY SHARE يجيب بأساس الصنف «تحت القفل»
const tx: Row = Object.assign(Object.create(db), {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = sqlOf(strings);
    st.sql.push(sql);
    if (sql.includes('FOR KEY SHARE')) {
      const ids = values.find((v): v is string[] => Array.isArray(v)) ?? [];
      return PRODUCTS.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, unit: lockedUnit[p.id] ?? p.unit, lotTracked: p.lotTracked, lotTrackedSince: p.lotTrackedSince }));
    }
    if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
    return [];
  },
  async $executeRaw(strings: TemplateStringsArray) { st.sql.push(sqlOf(strings)); return 1; },
});
db.$transaction = async (fn: unknown, opts?: unknown) => {
  st.txOpts.push(opts);
  if (Array.isArray(fn)) return Promise.all(fn);
  return (fn as (t: Row) => Promise<unknown>)(tx);
};
stub('config/database', { default: db });

/* eslint-disable @typescript-eslint/no-var-requires */
const requestsRouter = (require('../routes/repStockRequests') as typeof import('../routes/repStockRequests')).default;
const customersRouter = (require('../routes/customers') as typeof import('../routes/customers')).default;
const lotsRouter = (require('../routes/lots') as typeof import('../routes/lots')).default;
const { errorHandler } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
const { BASE_GUARD_TX } = require('../services/baseGuard') as typeof import('../services/baseGuard');
/* eslint-enable @typescript-eslint/no-var-requires */

const ADMIN = { id: 'ADM', role: 'ADMIN', tenantId: T, name: 'المدير' };
const KEY = { ...ADMIN, apiKeyId: 'k1' };
const REP = { id: 'R1', role: 'SALES_REP', tenantId: T, name: 'أحمد' };

/** مكدّس المسار وحده (حرّاسه المحلية ثم معالجه)؛ والخطأ يمرّ بمعالج الموجّه (إن وُجد) ثم المعالج العام */
async function call(router: unknown, method: string, p: string, req: Row, opts: { skipGuards?: boolean } = {}): Promise<{ status: number; body: Row }> {
  const stack = (router as { stack: Row[] }).stack;
  const layer = stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: ADMIN, ...req };
  const handlers = (layer.route.stack as Row[]).map((h) => h.handle);
  let err: unknown = null;
  for (const h of opts.skipGuards ? handlers.slice(-1) : handlers) {
    let passed = false;
    await h(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err || !passed) break;
  }
  if (err) {
    const onErr = stack.filter((l) => !l.route && l.handle.length === 4).map((l) => l.handle);
    let rest: unknown = err;
    for (const h of onErr) { const e0 = rest; rest = null; await h(e0, full, res, (e?: unknown) => { rest = e ?? null; }); if (!rest) break; }
    if (rest) errorHandler(rest, full as never, res as never, () => undefined);
  }
  return { status: res.statusCode, body: res.body };
}

// ═══ طلب البضاعة: المندوب (PUT /mine) ═══

const putMine = (items: Row[], extra: Row = {}) => call(requestsRouter, 'put', '/mine', { user: REP, body: { items }, ...extra });

test('طلب المندوب: كاشٌ قديم (baseUnitName ≠ أساس الصنف) ⇒ 400 UNIT_INVALID بلا معاملة ولا كتابة', async () => {
  reset();
  const r = await putMine([{ productId: 'P2', qty: 5, baseUnitName: 'كرتون' }]);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'UNIT_INVALID');
  assert.match(r.body.message, /عصير/);
  assert.equal(st.txOpts.length, 0);
  assert.equal(st.created.length, 0);
  // ولإعادة الرفع أيضاً: الطلب لا يمرّ بصندوق الأوف‑لاين، فلا «٥ كرتون» تُقرأ قوارير
  const replay = await putMine([{ productId: 'P2', qty: 5, baseUnitName: 'كرتون' }], { headers: { 'x-fs-replay': '1' } });
  assert.deepEqual([replay.status, replay.body.code], [400, 'UNIT_INVALID']);
});

test('طلب المندوب: تحويلٌ التزم بين القراءة والقفل ⇒ 409 PRODUCT_UNITS_CHANGED حيّاً و503 لإعادة الرفع، بلا كتابة', async () => {
  reset();
  lockedUnit = { P1: 'كرتون' };
  const r = await putMine([{ productId: 'P1', qty: 5, baseUnitName: 'قارورة' }]);
  assert.deepEqual([r.status, r.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
  assert.equal(st.created.length, 0);
  const replay = await putMine([{ productId: 'P1', qty: 5 }], { headers: { 'x-fs-replay': '1' } });
  assert.deepEqual([replay.status, replay.body.code], [503, 'PRODUCT_UNITS_CHANGED']);
  assert.equal(st.created.length, 0);
  // القفل بعد قفل الشركة الاستشاري وبمهلة محلية تُستعاد (I10)
  const lockAt = st.sql.findIndex((s) => s.includes('FOR KEY SHARE'));
  assert.ok(st.sql.findIndex((s) => s.includes('pg_advisory_xact_lock')) < lockAt && lockAt > 0);
  assert.ok(st.sql.slice(0, lockAt).some((s) => s.includes("set_config('lock_timeout'")));
});

test('طلب المندوب: جسمٌ بلا baseUnitName ⇒ مسار اليوم (200)، وI3: بندٌ بلا unitId لصنفٍ رئيسيّه كرتون يُكتب بالقارورة بمعامل ١', async () => {
  reset();
  const r = await putMine([{ productId: 'P1', qty: 7 }, { productId: 'P3', qty: 2 }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const items = st.created[0].items as Row[];
  const p1 = items.find((i) => i.productId === 'P1')!;
  assert.deepEqual([p1.qty, p1.unitName, p1.unitFactor, p1.baseQty], [7, null, 1, 7], 'غياب unitId = الأساس ولو كانت الرئيسية كرتوناً (D3)');
  assert.deepEqual(st.txOpts, [BASE_GUARD_TX], 'المعاملة بمهلة الحارس (I10)');
  // والردّ يحمل الرئيسية للعرض وحده
  assert.equal((r.body.data.items as Row[]).find((i) => i.productId === 'P1')!.primaryUnitId, 'U-CT');
  // والأساس المطابق مقبول
  reset();
  const ok = await putMine([{ productId: 'P2', qty: 1, baseUnitName: ' قارورة ' }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('طلب المندوب: تحويلٌ التزم بين حلّ الوحدة وقراءة الأصناف (بندٌ بوحدةٍ بلا baseUnitName) ⇒ 409 لا معامل وحدةٍ حُلّ على الأساس القديم', async () => {
  reset();
  // P3 أساسه «كيس» ووحدته «شوال» ×٥٠ كيساً. حلّ الوحدة يقرأ المعامل القديم، ثم يلتزم تحويلٌ (كيس ⇒ حبة، ×٢٠) قبل أي قراءةٍ تالية:
  // قراءة الأساس بعد الحلّ كانت ترى «حبة» فيوافقها القفل، ويُكتب «شوال» ×٥٠ حبّةً بدل ×١٠٠٠
  const origUnits = db.productUnit.findMany;
  db.productUnit.findMany = async (a: Row) => {
    const rows = [{ id: 'U-SH', productId: 'P3', name: 'شوال', factor: 50, isActive: true }].filter((u) => inIds(a.where?.id, u.id));
    PRODUCTS = PRODUCTS.map((p) => (p.id === 'P3' ? { ...p, unit: 'حبة', baseConvertedAt: CONVERTED } : p));
    return rows;
  };
  try {
    const r = await putMine([{ productId: 'P3', qty: 2, unitId: 'U-SH' }]);
    assert.deepEqual([r.status, r.body?.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
    assert.equal(st.created.length, 0);
  } finally {
    db.productUnit.findMany = origUnits;
  }
});

test('طلب المندوب: مفتاح API على صنفٍ محوَّل بلا baseUnitName ⇒ 400 BASE_UNIT_REQUIRED، وغير المحوَّل كما كان', async () => {
  reset();
  const r = await putMine([{ productId: 'P2', qty: 1 }], { user: { ...REP, apiKeyId: 'k1' } });
  assert.deepEqual([r.status, r.body.code], [400, 'BASE_UNIT_REQUIRED'], JSON.stringify(r.body));
  assert.equal(st.txOpts.length, 0);
  const old = await putMine([{ productId: 'P3', qty: 1 }], { user: { ...REP, apiKeyId: 'k1' } });
  assert.equal(old.status, 200, JSON.stringify(old.body));
});

// ═══ طلب البضاعة: تعديل الإدارة (PUT /:id) ═══

const putEdit = (items: Row[], user: Row = ADMIN) => {
  pending = { id: 'Q1', updatedAt: new Date('2026-10-31T08:00:00.000Z'), items: [{ productId: 'P2', requestedQty: 3, qty: 3, unitName: null, unitFactor: 1 }] };
  return call(requestsRouter, 'put', '/:id', { user, params: { id: 'Q1' }, body: { updatedAt: '2026-10-31T08:00:00.000Z', items } });
};

test('تعديل الإدارة: سطرٌ بلا baseUnitName ⇒ الحكم كما كان (200) تحت قفل الأصناف، وبأساسٍ قديم ⇒ 400، وبسباق ⇒ 409 بلا كتابة', async () => {
  reset();
  let r = await putEdit([{ productId: 'P2', qty: 2, unitId: null }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(st.updatedItems.map((u) => [u.data.qty, u.data.unitName, u.data.unitFactor]), [[2, null, 1]], 'بلا الحقل: الكتابة كما كانت');
  // القفل FOR KEY SHARE بعد قفل الشركة وبمعاملة الحارس — يُقفل الصنف ولو لم يُرسَل baseUnitName (convert-base-1)
  assert.ok(st.sql.some((s) => s.includes('FOR KEY SHARE')));
  assert.deepEqual(st.txOpts, [BASE_GUARD_TX]);
  reset();
  r = await putEdit([{ productId: 'P2', qty: 2, unitId: null, baseUnitName: 'كرتون' }]);
  assert.deepEqual([r.status, r.body.code], [400, 'UNIT_INVALID']);
  assert.equal(st.updatedItems.length, 0);
  reset();
  lockedUnit = { P2: 'كرتون' };
  r = await putEdit([{ productId: 'P2', qty: 2, unitId: null, baseUnitName: 'قارورة' }]);
  assert.deepEqual([r.status, r.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
  assert.equal(st.updatedItems.length, 0);
  reset();
  r = await putEdit([{ productId: 'P2', qty: 2, unitId: null }], KEY);
  assert.deepEqual([r.status, r.body.code], [400, 'BASE_UNIT_REQUIRED']);
});

test('تعديل الإدارة: تحويلٌ التزم على صنف سطرٍ **لم يُعدَّل** بعد قراءة الأصناف ⇒ 409 بلا كتابة (لا تُكتب لقطة «٥ كيس» القديمة فوق وسم التحويل)', async () => {
  // الطلب فيه سطران: P2 (يُعدَّل) وP3 «٥» بالأساس «كيس». تحويل P3 (كيس ⇒ حبة ×٢٠) يعيد وسم سطره «٥ كيس» ×٢٠ ويلتزم بعد قراءتنا.
  // كانت الحلقة تعيد كتابة كل سطرٍ بلقطته المقروءة بلا قفل، فيعود سطر P3 «٥» بمعامل ١ = ٥ حبّات بدل ١٠٠
  reset();
  lockedUnit = { P3: 'حبة' };
  pending = {
    id: 'Q1', updatedAt: new Date('2026-10-31T08:00:00.000Z'),
    items: [{ productId: 'P2', requestedQty: 3, qty: 3, unitName: null, unitFactor: 1 }, { productId: 'P3', requestedQty: 5, qty: 5, unitName: null, unitFactor: 1 }],
  };
  const r = await call(requestsRouter, 'put', '/:id', { params: { id: 'Q1' }, body: { updatedAt: '2026-10-31T08:00:00.000Z', items: [{ productId: 'P2', qty: 2 }] } });
  assert.deepEqual([r.status, r.body?.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
  assert.match(r.body.message, /سكر/);
  assert.equal(st.updatedItems.length, 0);
});

test('تعديل الإدارة: قفل الأصناف يسبق قراءة الطلب في المعاملة — فلقطة كل سطرٍ تُقرأ بعد أي تحويلٍ التزم', async () => {
  reset();
  pending = {
    id: 'Q1', updatedAt: new Date('2026-10-31T08:00:00.000Z'),
    items: [{ productId: 'P2', requestedQty: 3, qty: 3, unitName: null, unitFactor: 1 }, { productId: 'P3', requestedQty: 5, qty: 5, unitName: null, unitFactor: 1 }],
  };
  const orig = db.repStockRequest.findFirst;
  db.repStockRequest.findFirst = async () => { st.sql.push('#REQUEST_READ'); return pending; };
  try {
    const r = await call(requestsRouter, 'put', '/:id', { params: { id: 'Q1' }, body: { updatedAt: '2026-10-31T08:00:00.000Z', items: [{ productId: 'P2', qty: 2 }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    db.repStockRequest.findFirst = orig;
  }
  const lock = st.sql.findIndex((s) => s.includes('FOR KEY SHARE'));
  assert.ok(lock > st.sql.findIndex((s) => s.includes('pg_advisory_xact_lock')), 'بعد قفل الشركة');
  assert.ok(st.sql.lastIndexOf('#REQUEST_READ') > lock, 'قراءة الطلب (pendingForEdit) بعد قفل الأصناف');
  // والصنفان مقفلان: المعدَّل وصنف السطر الباقي
  const ids = st.sql.filter((s) => s.includes('FOR KEY SHARE')).length;
  assert.equal(ids, 1, 'قفلٌ واحد مرتّب لكل الأصناف');
  assert.deepEqual(st.updatedItems.map((u) => u.where.requestId_productId.productId), ['P2', 'P3']);
});

test('تعديل الإدارة: وحدةٌ صريحة حُلّت ثم التزم تحويلٌ قبل القفل (بلا baseUnitName) ⇒ 409 لا «شوال» ×٥٠ حبّة', async () => {
  reset();
  pending = { id: 'Q1', updatedAt: new Date('2026-10-31T08:00:00.000Z'), items: [{ productId: 'P3', requestedQty: 3, qty: 3, unitName: null, unitFactor: 1 }] };
  const origUnits = db.productUnit.findMany;
  db.productUnit.findMany = async (a: Row) => {
    const rows = [{ id: 'U-SH', productId: 'P3', name: 'شوال', factor: 50, isActive: true }].filter((u) => inIds(a.where?.id, u.id));
    PRODUCTS = PRODUCTS.map((p) => (p.id === 'P3' ? { ...p, unit: 'حبة', baseConvertedAt: CONVERTED } : p));
    return rows;
  };
  try {
    const r = await call(requestsRouter, 'put', '/:id', { params: { id: 'Q1' }, body: { updatedAt: '2026-10-31T08:00:00.000Z', items: [{ productId: 'P3', qty: 2, unitId: 'U-SH' }] } });
    assert.deepEqual([r.status, r.body?.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
    assert.equal(st.updatedItems.length, 0);
  } finally {
    db.productUnit.findMany = origUnits;
  }
});

test('تعديل الإدارة: D19 كبقية الكتّاب — مفتاح API بسطرٍ بوحدةٍ صريحة على صنفٍ محوَّل بلا baseUnitName ⇒ 400 BASE_UNIT_REQUIRED', async () => {
  reset();
  const origUnits = db.productUnit.findMany;
  db.productUnit.findMany = async (a: Row) => [{ id: 'U-P2', productId: 'P2', name: 'كرتون', factor: 24, isActive: true }].filter((u) => inIds(a.where?.id, u.id));
  try {
    let r = await putEdit([{ productId: 'P2', qty: 1, unitId: 'U-P2' }], KEY);
    assert.deepEqual([r.status, r.body?.code], [400, 'BASE_UNIT_REQUIRED'], JSON.stringify(r.body));
    assert.equal(st.txOpts.length, 0);
    // مع الاسم الصحيح يمرّ، وبجلسة لوحة الإدارة بلاه يمرّ (D19 للمفتاح وحده)
    r = await putEdit([{ productId: 'P2', qty: 1, unitId: 'U-P2', baseUnitName: 'قارورة' }], KEY);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await putEdit([{ productId: 'P2', qty: 1, unitId: 'U-P2' }]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    db.productUnit.findMany = origUnits;
  }
});

test('fail(): الرمز يبقى في كل ردّ 4xx يحمله الخطأ (فلا يضيع رمزٌ تعيد به الواجهة جلب الأصناف)', async () => {
  reset();
  pending = null;
  const r = await call(requestsRouter, 'put', '/:id', { params: { id: 'Q9' }, body: { updatedAt: 'x', items: [{ productId: 'P3', qty: 1 }] } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, undefined, 'خطأٌ بلا رمز يبقى بلا رمز (الشكل القائم)');
});

// ═══ أسعار العميل الخاصة (PUT /customers/:id/prices) ═══

const putPrices = (prices: Row[], user: Row = ADMIN) => call(customersRouter, 'put', '/:id/prices', { user, params: { id: 'C1' }, body: { prices } }, { skipGuards: true });

test('أسعار العميل: بلا baseUnitName ⇒ مسار اليوم تحت قفل الأصناف بمعاملة تفاعلية بمهلتها، وبأساسٍ قديم ⇒ 400 بلا upsert', async () => {
  reset();
  let r = await putPrices([{ productId: 'P1', price: 2 }, { productId: 'P3', price: 5 }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(st.upserts.map((u) => [u.where.customerId_productId.productId, u.update.price]), [['P1', 2], ['P3', 5]]);
  assert.deepEqual(st.txOpts, [{ maxWait: 10_000, timeout: 30_000 }]);
  assert.ok(st.sql.some((s) => s.includes('FOR KEY SHARE')));
  reset();
  r = await putPrices([{ productId: 'P2', price: 48, baseUnitName: 'كرتون' }]);
  assert.deepEqual([r.status, r.body.code], [400, 'UNIT_INVALID'], JSON.stringify(r.body));
  assert.equal(st.upserts.length, 0);
});

test('أسعار العميل: المصفوفة القديمة كانت بلا مهلة — قائمة ٥٠٠٠ صفّ تأخذ مهلةً تكبر بعددها (٦٠ ثانية) لا ٣٠ ثانية ثابتة', async () => {
  reset();
  const prices = Array.from({ length: 5000 }, (_, i) => ({ productId: ['P1', 'P3'][i % 2], price: i % 7 }));
  const r = await putPrices(prices);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(st.upserts.length, 5000);
  assert.deepEqual(st.txOpts, [{ maxWait: 10_000, timeout: 60_000 }]);
});

test('أسعار العميل: سباق مع تحويل ⇒ 409 PRODUCT_UNITS_CHANGED بلا upsert، ومفتاح API على صنفٍ محوَّل بلا الحقل ⇒ 400', async () => {
  reset();
  lockedUnit = { P1: 'كرتون' };
  let r = await putPrices([{ productId: 'P1', price: 2, baseUnitName: 'قارورة' }]);
  assert.deepEqual([r.status, r.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
  assert.equal(st.upserts.length, 0);
  reset();
  r = await putPrices([{ productId: 'P2', price: 2 }], KEY);
  assert.deepEqual([r.status, r.body.code], [400, 'BASE_UNIT_REQUIRED']);
  r = await putPrices([{ productId: 'P2', price: 2, baseUnitName: 'قارورة' }], KEY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await putPrices([{ productId: 'P3', price: 2 }], KEY);
  assert.equal(r.status, 200, 'صنفٌ لم يُحوَّل لا يتأثّر (D19)');
});

// ═══ إعادة وسم LOT (POST /lots/relabel) ═══

const relabel = (body: Row, user: Row = ADMIN) => call(lotsRouter, 'post', '/relabel', {
  user, body: { productId: 'P1', place: 'WAREHOUSE', fromLotId: null, reason: 'LABEL_EXISTING', lines: [{ lotNumber: 'L-1', qty: 5 }], ...body },
});

test('إعادة الوسم: أساسٌ قديم ⇒ 400 UNIT_INVALID قبل الطابور، ومفتاح API على صنفٍ محوَّل بلا الحقل ⇒ 400 BASE_UNIT_REQUIRED', async () => {
  reset();
  let r = await relabel({ baseUnitName: 'كرتون' });
  assert.deepEqual([r.status, r.body.code], [400, 'UNIT_INVALID'], JSON.stringify(r.body));
  assert.equal(st.txOpts.length, 0);
  r = await relabel({ productId: 'P2' }, KEY);
  assert.deepEqual([r.status, r.body.code], [400, 'BASE_UNIT_REQUIRED'], JSON.stringify(r.body));
  assert.equal(st.txOpts.length, 0);
});

test('إعادة الوسم: تحويلٌ التزم قبل القفل ⇒ 409 PRODUCT_UNITS_CHANGED (لا LOT_BUSY ولا 500)، وبلا تغيّر ⇒ المسار كما كان', async () => {
  reset();
  lockedUnit = { P1: 'كرتون' };
  let r = await relabel({ baseUnitName: 'قارورة' });
  assert.deepEqual([r.status, r.body.code], [409, 'PRODUCT_UNITS_CHANGED'], JSON.stringify(r.body));
  assert.match(r.body.message, /ماء/);
  // بلا الحقل أيضاً: الأساس المقروء قبل المعاملة هو المرجع تحت القفل
  r = await relabel({});
  assert.deepEqual([r.status, r.body.code], [409, 'PRODUCT_UNITS_CHANGED']);
  // بلا تحويل: الحارس يمرّ، والمسار القائم يحكم (الصنف غير متتبَّع ⇒ رفضه المعتاد)
  reset();
  r = await relabel({ baseUnitName: 'قارورة' });
  assert.deepEqual([r.status, r.body.code], [422, 'LOT_RELABEL_INVALID'], JSON.stringify(r.body));
});
