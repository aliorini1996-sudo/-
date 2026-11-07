// خطوط السير (routes/repRoutes.ts): الحذف والاستبدال **حذفٌ فعليّ** للخطّ ومحطّاته — لا تعطيل isActive:false ولا نسخةٌ مخفيّة
// (أمر المالك ٧ نوفمبر ٢٠٢٦: «أي حذف حذفٌ نهائي»). حارسٌ نصّيّ أولاً، ثم المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

test('لا تعطيل في خطوط السير: لا isActive:false يُكتب، ولا update/updateMany على الخطّ — الحذف بمحرّكٍ واحد يحذف المحطّات ثم الرأس', () => {
  const s = read('routes', 'repRoutes.ts');
  assert.doesNotMatch(s, /data:\s*\{\s*isActive:\s*false/, 'خطّ السير ما زال يُعطَّل بدل أن يُحذف');
  assert.doesNotMatch(s, /repRoute\.(update|updateMany)\(/, 'كتابة تعديلٍ على رأس الخطّ — الاستبدال والحذف حذفٌ فعليّ');
  const fn = s.slice(s.indexOf('async function deleteRoutes('), s.indexOf('function dayBounds('));
  const stops = fn.indexOf('tx.repRouteStop.deleteMany(');
  const head = fn.indexOf('tx.repRoute.deleteMany(');
  assert.ok(stops > 0 && head > stops, 'المحطّات قبل الرأس');
  assert.match(fn, /where: \{ \.\.\.where, tenantId: tid \}/, 'الشركة تُفرض على كل شرط');
  // DELETE والاستبدال داخل معاملة
  const del = s.slice(s.indexOf("router.delete('/:id'"));
  assert.match(del, /prisma\.\$transaction\(tx => deleteRoutes\(tx, tid,/);
  const post = s.slice(s.indexOf("router.post('/'"), s.indexOf("router.delete('/:id'"));
  assert.ok(post.indexOf('canAccessRep(req, tid, replaced.salesRepId)') < post.indexOf('prisma.$transaction('), 'نطاق الخطّ المُحرَّر قبل حذفه');
});

// ═══ المعالجات الحقيقية فوق Prisma مزيّف ═══

type Row = Record<string, any>;
const T = 'T1';
const REP1 = '11111111-1111-4111-8111-111111111111';
const REP2 = '22222222-2222-4222-8222-222222222222';
const REPX = '99999999-9999-4999-8999-999999999999'; // مندوب شركةٍ أخرى
const C1 = 'c1111111-1111-4111-8111-111111111111';
const C2 = 'c2222222-2222-4222-8222-222222222222';
const R_PERM = 'a1111111-1111-4111-8111-111111111111'; // دائمٌ لـREP1
const R_DAY = 'a2222222-2222-4222-8222-222222222222'; // مؤقّت REP1 ليوم 2026-11-07
const R_DAY2 = 'a3333333-3333-4333-8333-333333333333'; // مؤقّت REP1 ليوم 2026-11-08
const R_OLD = 'a4444444-4444-4444-8444-444444444444'; // بقيّة تعطيلٍ قديم لـREP1
const R_REP2 = 'a5555555-5555-4555-8555-555555555555'; // دائمٌ لـREP2
const R_REP2_OLD = 'a6666666-6666-4666-8666-666666666666'; // بقيّة تعطيلٍ قديم لـREP2
const R_X = 'a7777777-7777-4777-8777-777777777777'; // خطّ شركةٍ أخرى

const stub = (r: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, r));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let st: { routes: Row[]; stops: Row[]; reps: Row[]; customers: Row[] };
let scope: Set<string> | null = null; // null = مستخدمٌ بلا نطاق
let n = 0;
function reset(): void {
  n = 0;
  scope = null;
  const route = (id: string, tenantId: string, salesRepId: string, isPermanent: boolean, routeDate: string | null, isActive = true) =>
    ({ id, tenantId, salesRepId, name: id.slice(0, 4), isPermanent, routeDate, isActive, createdAt: new Date('2026-11-01T00:00:00Z') });
  st = {
    reps: [{ id: REP1, tenantId: T }, { id: REP2, tenantId: T }, { id: REPX, tenantId: 'OTHER' }],
    customers: [{ id: C1, tenantId: T }, { id: C2, tenantId: T }],
    routes: [
      route(R_PERM, T, REP1, true, null),
      route(R_DAY, T, REP1, false, '2026-11-07'),
      route(R_DAY2, T, REP1, false, '2026-11-08'),
      route(R_OLD, T, REP1, false, '2026-10-01', false),
      route(R_REP2, T, REP2, true, null),
      route(R_REP2_OLD, T, REP2, true, null, false),
      route(R_X, 'OTHER', REPX, true, null),
    ],
    stops: [],
  };
  for (const r of st.routes) {
    st.stops.push({ id: `s-${r.id}-1`, tenantId: r.tenantId, routeId: r.id, customerId: C1, seq: 1, note: null });
    st.stops.push({ id: `s-${r.id}-2`, tenantId: r.tenantId, routeId: r.id, customerId: C2, seq: 2, note: null });
  }
}
reset();

const match = (row: Row, w: Row): boolean => Object.entries(w).every(([k, v]) => {
  if (k === 'OR') return (v as Row[]).some((x) => match(row, x));
  if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
  return row[k] === v;
});

const db: Row = {
  salesRep: { async findFirst(a: Row) { return st.reps.find((r) => match(r, a.where)) ?? null; } },
  customer: { async findMany(a: Row) { return st.customers.filter((c) => match(c, a.where)).map((c) => ({ id: c.id })); } },
  repRoute: {
    async findFirst(a: Row) { const r = st.routes.find((x) => match(x, a.where)); return r ? { ...r } : null; },
    async findMany(a: Row) { return st.routes.filter((x) => match(x, a.where)).map((x) => ({ ...x })); },
    async create(a: Row) {
      const row = { id: `NEW-${++n}`, isActive: true, createdAt: new Date(), ...a.data };
      st.routes.push(row);
      return { ...row };
    },
    async deleteMany(a: Row) {
      const before = st.routes.length;
      st.routes = st.routes.filter((x) => !match(x, a.where));
      return { count: before - st.routes.length };
    },
    async update() { throw new Error('repRoute.update ممنوع — الحذف فعليّ'); },
    async updateMany() { throw new Error('repRoute.updateMany ممنوع — الحذف فعليّ'); },
  },
  repRouteStop: {
    async create(a: Row) { const row = { id: `NS-${++n}`, ...a.data }; st.stops.push(row); return row; },
    async deleteMany(a: Row) {
      const before = st.stops.length;
      st.stops = st.stops.filter((x) => !match(x, a.where));
      return { count: before - st.stops.length };
    },
  },
};
// معاملةٌ ذرّية: فشلٌ في أثنائها يعيد الحالة كما كانت
db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
  const snap = { routes: st.routes.map((r) => ({ ...r })), stops: st.stops.map((s) => ({ ...s })) };
  try { return await fn(db); } catch (e) { st.routes = snap.routes; st.stops = snap.stops; throw e; }
};
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realScope = require('../services/adminScope') as typeof import('../services/adminScope');
stub('services/adminScope', {
  ...realScope,
  canAccessRep: async (_req: unknown, _tid: string, id: string) => scope === null || scope.has(id),
  canAccessCustomerAsAdmin: async () => true,
  adminRepFilter: async () => ({}),
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require('../routes/repRoutes') as typeof import('../routes/repRoutes')).default;

/** يشغّل مكدّس المسار نفسه (معالجه) — حرّاس الراوتر العامة (المصادقة وصلاحية التتبّع) خارج هذا الاختبار */
async function call(method: string, p: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: { id: 'ADM', role: 'ADMIN', tenantId: T }, ...req };
  for (const h of layer.route.stack as Row[]) {
    let passed = false;
    let err: unknown;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}

const ids = () => st.routes.map((r) => r.id).sort();
const stopsOf = (id: string) => st.stops.filter((s) => s.routeId === id).length;
const noHidden = () => assert.deepEqual(st.routes.filter((r) => r.tenantId === T && r.isActive === false && r.salesRepId === REP1).map((r) => r.id), [], 'لا نسخة موقوفة مخفيّة');

test('DELETE: الخطّ ومحطّاته يُحذفان فعلياً مع بقايا التعطيل القديم لمندوبه — لا صفّ موقوف، وغيره كما هو', async () => {
  reset();
  const r = await call('delete', '/:id', { params: { id: R_DAY } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true });
  assert.ok(!st.routes.some((x) => x.id === R_DAY), 'الخطّ باقٍ');
  assert.equal(stopsOf(R_DAY), 0, 'محطّاتٌ يتيمة');
  assert.ok(!st.routes.some((x) => x.id === R_OLD), 'بقيّة التعطيل القديم لمندوبه باقية');
  assert.equal(stopsOf(R_OLD), 0);
  noHidden();
  // خطوط المندوب الأخرى النشطة، والمندوب الآخر (ولو بقيّته الموقوفة)، والشركة الأخرى — لا تُمسّ
  assert.deepEqual(ids(), [R_PERM, R_DAY2, R_REP2, R_REP2_OLD, R_X].sort());
  for (const id of [R_PERM, R_DAY2, R_REP2, R_REP2_OLD, R_X]) assert.equal(stopsOf(id), 2, id);
});

test('DELETE: خطٌّ خارج النطاق أو لشركةٍ أخرى أو غائب ⇒ 404 ولا يُحذف شيء', async () => {
  reset();
  scope = new Set([REP2]);
  const out = await call('delete', '/:id', { params: { id: R_PERM } });
  assert.equal(out.status, 404);
  scope = null;
  assert.equal((await call('delete', '/:id', { params: { id: R_X } })).status, 404, 'شركةٌ أخرى');
  assert.equal((await call('delete', '/:id', { params: { id: 'nope' } })).status, 404);
  assert.equal(st.routes.length, 7, 'لا حذف');
  assert.equal(st.stops.length, 14);
});

test('POST بـreplacesId (تغيير التاريخ): القديم يُحذف فعلياً بمحطّاته، والجديد نشطٌ وحده — بلا نسخةٍ مخفيّة', async () => {
  reset();
  const r = await call('post', '/', {
    body: { salesRepId: REP1, name: 'خطّ معدَّل', isPermanent: false, routeDate: '2026-11-09', replacesId: R_DAY, stops: [{ customerId: C2 }, { customerId: C1 }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const newId = r.body.data.id;
  assert.ok(!st.routes.some((x) => x.id === R_DAY), 'المُحرَّر باقٍ');
  assert.equal(stopsOf(R_DAY), 0);
  noHidden();
  const nw = st.routes.find((x) => x.id === newId)!;
  assert.deepEqual([nw.isActive, nw.isPermanent, nw.routeDate, nw.salesRepId], [true, false, '2026-11-09', REP1]);
  assert.deepEqual(st.stops.filter((s) => s.routeId === newId).map((s) => [s.customerId, s.seq]), [[C2, 1], [C1, 2]]);
  // الدائم وخطّ اليوم الآخر لا يُمسّان
  assert.deepEqual(ids(), [R_PERM, R_DAY2, R_REP2, R_REP2_OLD, R_X, newId].sort());
});

test('POST دائم: الدائم السابق للمندوب يُحذف فعلياً (لا يُعطَّل)، وخطوطه المؤقّتة والمندوب الآخر كما هي', async () => {
  reset();
  const r = await call('post', '/', { body: { salesRepId: REP1, name: 'دائم جديد', isPermanent: true, stops: [{ customerId: C1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(!st.routes.some((x) => x.id === R_PERM), 'الدائم السابق باقٍ');
  assert.equal(stopsOf(R_PERM), 0);
  noHidden();
  assert.deepEqual(ids(), [R_DAY, R_DAY2, R_REP2, R_REP2_OLD, R_X, r.body.data.id].sort());
  assert.equal(st.routes.filter((x) => x.salesRepId === REP1 && x.isPermanent).length, 1, 'دائمٌ واحد للمندوب');
});

test('POST مؤقّت: مؤقّت اليوم نفسه يُحذف فعلياً، ومؤقّت يومٍ آخر والدائم باقيان', async () => {
  reset();
  const r = await call('post', '/', { body: { salesRepId: REP1, name: 'اليوم', routeDate: '2026-11-07', stops: [{ customerId: C1 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(!st.routes.some((x) => x.id === R_DAY));
  assert.equal(stopsOf(R_DAY), 0);
  noHidden();
  assert.deepEqual(ids(), [R_PERM, R_DAY2, R_REP2, R_REP2_OLD, R_X, r.body.data.id].sort());
});

test('POST بـreplacesId خارج النطاق أو لشركةٍ أخرى أو محذوفٍ في الأثناء: لا يُمسّ شيءٌ منها، ويُحفظ الجديد', async () => {
  reset();
  scope = new Set([REP1]);
  // خطّ REP2 خارج نطاق المستخدم — كان يُعطَّل بمعرّفه كتابةً عمياء
  const a = await call('post', '/', { body: { salesRepId: REP1, name: 'أ', routeDate: '2026-12-01', replacesId: R_REP2, stops: [{ customerId: C1 }] } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.ok(st.routes.some((x) => x.id === R_REP2 && x.isActive) && stopsOf(R_REP2) === 2, 'خطّ خارج النطاق حُذف');
  scope = null;
  const b = await call('post', '/', { body: { salesRepId: REP1, name: 'ب', routeDate: '2026-12-02', replacesId: R_X, stops: [{ customerId: C1 }] } });
  assert.equal(b.status, 201);
  assert.ok(st.routes.some((x) => x.id === R_X) && stopsOf(R_X) === 2, 'خطّ شركةٍ أخرى حُذف');
  const c = await call('post', '/', { body: { salesRepId: REP1, name: 'ج', routeDate: '2026-12-03', replacesId: 'b0000000-0000-4000-8000-000000000000', stops: [{ customerId: C1 }] } });
  assert.equal(c.status, 201, 'المُحرَّر حذفه غيرُه أثناء التحرير ⇒ يُحفظ الجديد كما كان');
});

test('POST: فشلٌ أثناء الإنشاء يُرجع الحذف كلّه (معاملةٌ واحدة) — لا يضيع القديم بلا بديل', async () => {
  reset();
  const orig = db.repRouteStop.create;
  db.repRouteStop.create = async () => { throw new Error('boom'); };
  try {
    await assert.rejects(() => call('post', '/', { body: { salesRepId: REP1, name: 'x', isPermanent: true, replacesId: R_DAY, stops: [{ customerId: C1 }] } }), /boom/);
  } finally { db.repRouteStop.create = orig; }
  assert.equal(st.routes.length, 7);
  assert.equal(st.stops.length, 14);
  assert.ok(st.routes.some((x) => x.id === R_PERM) && st.routes.some((x) => x.id === R_DAY));
});
