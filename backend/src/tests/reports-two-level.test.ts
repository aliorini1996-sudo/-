// فلاتر التقارير وتجميعان متداخلان (طلب المالك ١٣ نوفمبر ٢٠٢٦: «لنقم بتطوير فلاتر التقارير داخل تطبيق الادارة»).
//
// ١) التجميع الصرف salesTwoLevel: المندوب ثم الصنف (كم باع كل مندوب من كل صنف) وأخواتها — صافٍ من المرتجع، والكمية بالأساس،
//    و«بلا مندوب» و«صنف محذوف»، وthenBy المطابق للأول أو الغريب يُهمل فيبقى الردّ القديم حرفاً.
// ٢) المسارات الحقيقية على Prisma مزيّف يسجّل الاستعلامات: الفلاتر الجديدة (مندوب/عميل/موقع) تبلغ شرط where في كل تقرير
//    بجانب مفتاح النطاق (AND) لا فوقه، والمعرّف الفاسد ٤٠٠، وبلا فلاتر لا مفتاح جديد. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// —— بيانات: صنفان (ببسي بوحدة كرتون رئيسية، وحليب) ومندوبان ومستندٌ بلا مندوب وبندٌ صنفه محذوف ——
const A = { id: 'pA', name: 'ببسي', code: 'A1', unit: 'حبة', primaryUnitId: 'uCarton' };
const B = { id: 'pB', name: 'حليب', code: 'B1', unit: 'كرتون', primaryUnitId: null };
const UNITS_A = [{ id: 'uCarton', name: 'كرتون', factor: 24 }];
const r1 = { id: 'r1', name: 'أحمد' };
const r2 = { id: 'r2', name: 'خالد' };
const c1 = { id: 'c1', name: 'بقالة', channel: 'TT', city: 'الرياض' };
const c2 = { id: 'c2', name: 'تموينات', channel: 'MT', city: 'جدة' };
const line = (product: Row | null, qty: number, lineTotal: number, unitFactor = 1, unitName: string | null = null) =>
  ({ qty, unitName, unitFactor, baseQty: qty * unitFactor, lineTotal, product });
const doc = (id: string, type: string, rep: Row | null, customer: Row, total: number, locationId: string | null, items: Row[]) => ({
  id, type, status: 'CONFIRMED', total, taxAmt: 0, discountAmt: 0, invoiceDate: new Date(), createdAt: new Date(),
  salesRepId: rep?.id ?? null, salesRep: rep, customerId: customer.id, customer, locationId, team: null, items,
});
const DOCS: Row[] = [
  // كرتونان (٤٨ حبة) وثلاث حبّات من ببسي، وأربعة حليب
  doc('s1', 'CASH', r1, c1, 1000, 'L1', [line(A, 2, 480, 24, 'كرتون'), line(B, 4, 400), line(A, 3, 30)]),
  doc('s2', 'CREDIT', r2, c2, 500, 'L2', [line(A, 10, 100), line(B, 2, 200), line(null, 1, 50)]),
  // مندوبٌ حُذف: salesRepId فارغ
  doc('s3', 'CASH', null, c1, 300, null, [line(B, 3, 300)]),
  doc('s4', 'CASH', r1, c2, 60, 'L1', [line(A, 5, 50)]),
  // مرتجع أحمد: كرتون ببسي (٢٤ حبة) بـ١٢٠
  doc('ret1', 'RETURN', r1, c1, 120, 'L1', [line(A, 1, 120, 24, 'كرتون')]),
];
const SALES = DOCS.filter((d) => d.type !== 'RETURN');
const RETURNS = DOCS.filter((d) => d.type === 'RETURN');
const UNITS = new Map([['pA', UNITS_A]]);

// —— Prisma مزيّف يسجّل كل استعلام ——
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let calls: { model: string; op: string; args: Row }[] = [];
const log = (model: string, op: string, args: Row) => { calls.push({ model, op, args }); };
/** المستند يطابق where كما يكتبه المسار: النوع والحالة النصّية وفلاتر المعرّفات (نصٌّ أو null) */
const matches = (d: Row, w: Row = {}): boolean => {
  const t = w.type;
  if (typeof t === 'string' && d.type !== t) return false;
  if (t && typeof t === 'object' && t.not !== undefined && d.type === t.not) return false;
  if (typeof w.status === 'string' && d.status !== w.status) return false;
  for (const k of ['salesRepId', 'customerId', 'locationId']) if (k in w && d[k] !== w[k]) return false;
  return true;
};
const REPS = [{ id: 'r1', name: 'أحمد', locationId: 'L1' }, { id: 'r2', name: 'خالد', locationId: null }];
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, aggregate: async () => ({ _sum: {}, _count: {} }) };
const db = new Proxy({
  invoice: {
    async findMany(a: Row) { log('invoice', 'findMany', a); return DOCS.filter((d) => matches(d, a.where)); },
    // ملخّصا الطلبات والمرتجع تجميعٌ في القاعدة (دقّة التقارير، البند ٧): العدد والمجاميع على المطابق كلّه
    async aggregate(a: Row) {
      log('invoice', 'aggregate', a);
      const ds = DOCS.filter((d) => matches(d, a.where));
      const sum = (k: string) => ds.reduce((s, d) => s + Number(d[k] ?? 0), 0);
      return { _count: { _all: ds.length }, _sum: { total: sum('total'), paidAmt: sum('paidAmt'), remainingAmt: sum('remainingAmt') } };
    },
    // أسباب المرتجع، والبيع النقدي المحصَّل لكل مندوب (البند ٦) — مجموعاتٌ بمفاتيح `by` على المطابق
    async groupBy(a: Row) {
      log('invoice', 'groupBy', a);
      const out = new Map<string, Row>();
      for (const d of DOCS.filter((x) => matches(x, a.where))) {
        const keys = Object.fromEntries((a.by as string[]).map((k) => [k, d[k] ?? null]));
        const id = JSON.stringify(keys);
        const g = out.get(id) ?? { ...keys, _count: { _all: 0 }, _sum: Object.fromEntries(Object.keys(a._sum ?? {}).map((k) => [k, 0])) };
        g._count._all += 1;
        for (const k of Object.keys(a._sum ?? {})) g._sum[k] += Number(d[k] ?? 0);
        out.set(id, g);
      }
      return [...out.values()];
    },
  },
  invoiceItem: {
    async findMany(a: Row) { log('invoiceItem', 'findMany', a); return []; },
    async count(a: Row) { log('invoiceItem', 'count', a); return 0; },
  },
  productUnit: {
    async findMany(a: Row) {
      log('productUnit', 'findMany', a);
      return (a.where.productId.in as string[]).includes('pA') ? UNITS_A.map((u) => ({ ...u, productId: 'pA' })) : [];
    },
  },
  receipt: { async findMany(a: Row) { log('receipt', 'findMany', a); return []; } },
  repVisit: { async findMany(a: Row) { log('repVisit', 'findMany', a); return []; } },
  repSession: { async findMany(a: Row) { log('repSession', 'findMany', a); return []; } },
  repAttendance: { async findMany(a: Row) { log('repAttendance', 'findMany', a); return []; } },
  salesRep: {
    async findMany(a: Row) {
      log('salesRep', 'findMany', a);
      const w = a.where ?? {};
      return REPS.filter((r) => (w.id === undefined || r.id === w.id) && (!('locationId' in w) || r.locationId === w.locationId))
        .map((r) => ({ id: r.id, name: r.name, invoices: [], receipts: [] }));
    },
  },
  async $queryRaw() { return []; },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });
// نطاق مستخدمٍ مقيَّد: مفتاح AND للمستندات والزيارات، وsalesRep لسجلّات المندوب — الفلاتر تُضاف بجانبه ولا تمحوه
const SCOPE = { AND: [{ scope: 'S' }] };
const REP_SCOPE = { adminScopes: { some: { adminId: 'a1' } } };
stub('services/adminScope', {
  scopedRecordWhere: async () => SCOPE, scopedRepRecordWhere: async () => ({ salesRep: REP_SCOPE }),
  adminCustomerFilter: async () => ({}), adminRepFilter: async () => REP_SCOPE,
  SHAPE_INVOICE_RECEIPT: {}, SHAPE_VISIT: {},
});

/* eslint-disable @typescript-eslint/no-var-requires */
const reports = require('../routes/reports') as typeof import('../routes/reports');
/* eslint-enable @typescript-eslint/no-var-requires */
const { salesTwoLevel, thenByOf, reportIdOf, reportIdFilters, salesByProduct } = reports;

/** معالج المسار الأخير وحده (المصادقة والصلاحية لهما اختباراتهما) — بحالة الردّ وجسمه */
async function call(routePath: string, query: Row = {}) {
  const layer = (reports.default as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  assert.ok(layer, `GET ${routePath} غير موجود`);
  const handler = layer.route.stack.slice(-1)[0].handle;
  const res = { statusCode: 200, body: null as Row | null, status(c: number) { this.statusCode = c; return this; }, json(b: Row) { this.body = b; return this; } };
  let err: unknown = null;
  calls = [];
  await handler({ query, params: {}, user: { id: 'a1', role: 'ADMIN', tenantId: 't1' } }, res, (e: unknown) => { err = e; });
  if (err) throw err;
  return res;
}
const whereOf = (model: string, op = 'findMany') => calls.filter((c) => c.model === model && c.op === op).map((c) => c.args.where as Row);
/** الزيارات تُقرأ دفعاتٍ (services/reportBatches.ts): شرط المسار العنصر الأول في AND بجانب مؤشّر الدفعة (فارغٌ للأولى) */
const visitWhereOf = (): Row[] => whereOf('repVisit').map((w) => {
  assert.equal(w.AND.length, 2, 'شرط المسار ومؤشّر الدفعة');
  return w.AND[0] as Row;
});
/** [المفتاح، الاسم، العدد، المبلغ] — والفرعية [المفتاح، الاسم، العدد/الكمية، المبلغ] */
const brief = (rows: Row[]) => rows.map((r) => [r.key, r.name, r.count ?? r.qty, r.total]);

// ═══ ١) التجميع الصرف ═══

test('thenByOf: المستويان من المندوب/العميل/الصنف ومختلفان — وإلا يُهمل فيبقى الردّ القديم', () => {
  assert.equal(thenByOf('rep', 'product'), 'product');
  assert.equal(thenByOf('product', 'rep'), 'rep');
  assert.equal(thenByOf('customer', 'rep'), 'rep');
  assert.equal(thenByOf('rep', 'rep'), undefined, 'المطابق للأول يُهمل');
  assert.equal(thenByOf('product', 'product'), undefined);
  assert.equal(thenByOf('channel', 'product'), undefined, 'تحت القناة لا تجميع ثانٍ');
  assert.equal(thenByOf('team', 'rep'), undefined);
  assert.equal(thenByOf(undefined, 'rep'), undefined, 'بلا تجميعٍ أول: الملخّص كما كان');
  assert.equal(thenByOf('rep', 'region'), undefined);
  assert.equal(thenByOf('rep', ['product']), undefined, 'كائن qs لا يصير تجميعاً');
  assert.equal(thenByOf('rep', undefined), undefined);
});

test('المندوب ثم الصنف: كم باع كل مندوب من كل صنف — بالأساس وصافياً من المرتجع، و«بلا مندوب» و«صنف محذوف» ظاهران', () => {
  const rows = salesTwoLevel('rep', 'product', SALES as never, RETURNS as never, UNITS);
  // أحمد: ١٠٠٠ + ٦٠ − ١٢٠ مرتجع، وفاتورتا بيع (المرتجع لا يُعدّ)
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.count, r.total]), [['r1', 'أحمد', 2, 940], ['r2', 'خالد', 1, 500], ['—', 'بلا مندوب', 1, 300]]);
  // ببسي عند أحمد: ٤٨ + ٣ + ٥ − ٢٤ = ٣٢ حبة، و٤٨٠ + ٣٠ + ٥٠ − ١٢٠ = ٤٤٠ — ووحداته ورئيسيته للعارض
  assert.deepEqual(rows[0].sub, [
    { key: 'pA', name: 'ببسي', code: 'A1', qty: 32, baseQty: 32, unit: 'حبة', units: UNITS_A, primaryUnitId: 'uCarton', total: 440 },
    { key: 'pB', name: 'حليب', code: 'B1', qty: 4, baseQty: 4, unit: 'كرتون', units: [], primaryUnitId: null, total: 400 },
  ]);
  assert.deepEqual(brief(rows[1].sub), [['pB', 'حليب', 2, 200], ['pA', 'ببسي', 10, 100], ['unknown', 'صنف محذوف', 1, 50]]);
  assert.deepEqual(rows[1].sub[2], { key: 'unknown', name: 'صنف محذوف', code: '—', qty: 1, baseQty: 1, unit: '', units: [], primaryUnitId: null, total: 50 });
  assert.deepEqual(brief(rows[2].sub), [['pB', 'حليب', 3, 300]]);
  // لا حقل عددٍ على مستوى الصنف، ولا مفتاح productId (المفتاح key)
  assert.ok(rows[0].sub.every((s) => !('count' in s) && !('productId' in s)));
});

test('الصنف ثم المندوب: لكل صنف كميةُ كل مندوبٍ منه ومبلغه وفواتير بيعه التي فيها الصنف — ووحدة الصنف الأب', () => {
  const rows = salesTwoLevel('product', 'rep', SALES as never, RETURNS as never, UNITS);
  // الآباء صفوف salesByProduct نفسها (المفتاح key بدل productId)
  const flat = salesByProduct(SALES as never, UNITS, RETURNS as never);
  assert.deepEqual(rows.map(({ sub: _s, key, ...r }) => ({ productId: key === 'unknown' ? null : key, ...r })), flat);
  assert.deepEqual(brief(rows), [['pB', 'حليب', 9, 900], ['pA', 'ببسي', 42, 540], ['unknown', 'صنف محذوف', 1, 50]]);
  // الحليب: أحمد ٤، وبلا مندوب ٣، وخالد ٢ — من الأكبر مبلغاً
  assert.deepEqual(rows[0].sub.map((s) => [s.key, s.name, s.count, s.qty, s.total]), [['r1', 'أحمد', 1, 4, 400], ['—', 'بلا مندوب', 1, 3, 300], ['r2', 'خالد', 1, 2, 200]]);
  // ببسي عند أحمد في فاتورتين (s1 بسطرين يُعدّ مرّة، وs4)، والمرتجع مطروح؛ والوحدة والوحدات والرئيسية من الأب
  assert.deepEqual(rows[1].sub, [
    { key: 'r1', name: 'أحمد', count: 2, qty: 32, baseQty: 32, unit: 'حبة', units: UNITS_A, primaryUnitId: 'uCarton', total: 440 },
    { key: 'r2', name: 'خالد', count: 1, qty: 10, baseQty: 10, unit: 'حبة', units: UNITS_A, primaryUnitId: 'uCarton', total: 100 },
  ]);
  assert.deepEqual(rows[2].sub.map((s) => [s.key, s.count, s.qty, s.total]), [['r2', 1, 1, 50]]);
  // مجموع الفرعية = الأب (كميةً ومبلغاً)
  for (const r of rows) {
    assert.equal(r.sub.reduce((t, s) => t + (s.qty ?? 0), 0), r.qty, r.name);
    assert.equal(r.sub.reduce((t, s) => t + s.total, 0), r.total, r.name);
  }
});

test('المندوب ثم العميل، والعميل ثم الصنف، والصنف ثم العميل', () => {
  const repCust = salesTwoLevel('rep', 'customer', SALES as never, RETURNS as never);
  assert.deepEqual(repCust.map((r) => [r.key, brief(r.sub)]), [
    ['r1', [['c1', 'بقالة', 1, 880], ['c2', 'تموينات', 1, 60]]],
    ['r2', [['c2', 'تموينات', 1, 500]]],
    ['—', [['c1', 'بقالة', 1, 300]]],
  ]);
  const custProd = salesTwoLevel('customer', 'product', SALES as never, RETURNS as never, UNITS);
  assert.deepEqual(custProd.map((r) => [r.key, r.name, r.count, r.total]), [['c1', 'بقالة', 2, 1180], ['c2', 'تموينات', 2, 560]]);
  assert.deepEqual(brief(custProd[0].sub), [['pB', 'حليب', 7, 700], ['pA', 'ببسي', 27, 390]]);
  assert.deepEqual(brief(custProd[1].sub), [['pB', 'حليب', 2, 200], ['pA', 'ببسي', 15, 150], ['unknown', 'صنف محذوف', 1, 50]]);
  const prodCust = salesTwoLevel('product', 'customer', SALES as never, RETURNS as never, UNITS);
  assert.deepEqual(prodCust.map((r) => [r.key, r.sub.map((s) => [s.key, s.count, s.qty, s.total])]), [
    ['pB', [['c1', 2, 7, 700], ['c2', 1, 2, 200]]],
    ['pA', [['c1', 1, 27, 390], ['c2', 2, 15, 150]]],
    ['unknown', [['c2', 1, 1, 50]]],
  ]);
});

test('المرتجع وحده يظهر سالباً صادقاً بعدد صفر، وبلا مستندات لا صفوف', () => {
  const rows = salesTwoLevel('rep', 'product', [], RETURNS as never, UNITS);
  assert.deepEqual(rows.map((r) => [r.key, r.count, r.total, brief(r.sub)]), [['r1', 0, -120, [['pA', 'ببسي', -24, -120]]]]);
  const piv = salesTwoLevel('product', 'rep', [], RETURNS as never, UNITS);
  assert.deepEqual(piv.map((r) => [r.key, r.sub.map((s) => [s.key, s.count, s.qty, s.total])]), [['pA', [['r1', 0, -24, -120]]]]);
  assert.deepEqual(salesTwoLevel('customer', 'rep', [], []), []);
});

test('معرّف الفلتر: نصٌّ مقصوص بحدّ ٦٤ — الغائب والفارغ بلا فلتر، والمصفوفة والكائن والأطول تُرفض', () => {
  assert.equal(reportIdOf(undefined), undefined);
  assert.equal(reportIdOf(''), undefined);
  assert.equal(reportIdOf('   '), undefined);
  assert.equal(reportIdOf('  r1 '), 'r1');
  assert.equal(reportIdOf('x'.repeat(64)), 'x'.repeat(64));
  assert.equal(reportIdOf('x'.repeat(65)), false);
  assert.equal(reportIdOf(['r1', 'r2']), false);
  assert.equal(reportIdOf({ not: 'r1' }), false);
  assert.deepEqual(reportIdFilters({ salesRepId: ' r1', customerId: '', locationId: 'L1', other: [1] }, ['salesRepId', 'customerId']), { salesRepId: 'r1' });
  assert.equal(reportIdFilters({ customerId: ['a'] }, ['salesRepId', 'customerId']), null);
});

// ═══ ٢) المسارات ═══

test('المبيعات بلا thenBy أو بـthenBy مُهمل: الردّ القديم حرفاً', async () => {
  for (const g of ['rep', 'customer', 'product', 'channel', 'region', 'team']) {
    const old = (await call('/sales', { groupBy: g })).body;
    for (const t of [g, 'region', ['product'], '']) {
      assert.deepEqual((await call('/sales', { groupBy: g, thenBy: t })).body, old, `${g} / ${JSON.stringify(t)}`);
    }
  }
  const plain = (await call('/sales', {})).body!.data;
  assert.equal(plain.summary.defaultRangeDays, 90, 'بلا مدى: ٩٠ يوماً مُعلنة كما كانت');
  assert.deepEqual((await call('/sales', { thenBy: 'product' })).body!.data.summary, plain.summary, 'thenBy بلا groupBy: الملخّص كما كان');
  // التجميع المفرد للمندوب كما كان: بلا مفتاح key
  assert.deepEqual((await call('/sales', { groupBy: 'rep' })).body!.data, [{ name: 'أحمد', count: 2, total: 940 }, { name: 'خالد', count: 1, total: 500 }, { name: 'بلا مندوب', count: 1, total: 300 }]);
});

test('المبيعات بـthenBy: الآباء أرقام التجميع المفرد نفسها، ووحدات الأصناف تُقرأ مرّةً بالشركة شرطاً', async () => {
  const single = (await call('/sales', { groupBy: 'rep' })).body!.data as Row[];
  const res = await call('/sales', { groupBy: 'rep', thenBy: 'product' });
  assert.equal(res.statusCode, 200);
  const rows = res.body!.data as Row[];
  assert.deepEqual(rows.map((r) => ({ name: r.name, count: r.count, total: r.total })), single);
  assert.deepEqual(rows[0].sub[0].units, UNITS_A, 'وحدات ببسي من القاعدة');
  const u = calls.filter((c) => c.model === 'productUnit');
  assert.equal(u.length, 1);
  assert.equal(u[0].args.where.tenantId, 't1');
  // المندوب ثم العميل: لا مستوى صنف ⇒ لا قراءة وحدات
  await call('/sales', { groupBy: 'rep', thenBy: 'customer' });
  assert.equal(calls.filter((c) => c.model === 'productUnit').length, 0);
  // الصنف ثم المندوب: الآباء صفوف التجميع المفرد للأصناف نفسها
  const prod = (await call('/sales', { groupBy: 'product' })).body!.data as Row[];
  const piv = (await call('/sales', { groupBy: 'product', thenBy: 'rep' })).body!.data as Row[];
  assert.deepEqual(piv.map(({ sub: _s, key, ...r }) => ({ productId: key === 'unknown' ? null : key, ...r })), prod);
  // المدى المطبَّق (دقّة التقارير، البند ٩) في ردّ التجميعين كالتجميع المفرد — كل فرعٍ من /sales يحمله
  const one = await call('/sales', { groupBy: 'rep' });
  const two = await call('/sales', { groupBy: 'rep', thenBy: 'product' });
  assert.ok(two.body!.meta?.appliedRange, 'meta.appliedRange');
  assert.deepEqual(two.body!.meta, one.body!.meta);
});

test('المبيعات: فلاتر المندوب والعميل والموقع تبلغ استعلامَي البيع والمرتجع بجانب النطاق — و`none` «بلا موقع»', async () => {
  const res = await call('/sales', { groupBy: 'rep', thenBy: 'product', salesRepId: ' r1 ', customerId: 'c1', locationId: 'L1' });
  const ws = whereOf('invoice');
  assert.equal(ws.length, 2, 'البيع والمرتجع');
  for (const w of ws) {
    assert.deepEqual([w.salesRepId, w.customerId, w.locationId, w.tenantId], ['r1', 'c1', 'L1', 't1']);
    assert.deepEqual(w.AND, SCOPE.AND, 'مفتاح النطاق باقٍ');
  }
  // أحمد عند بقالة في L1: s1 ومرتجعه
  assert.deepEqual((res.body!.data as Row[]).map((r) => [r.key, r.count, r.total, brief(r.sub)]), [['r1', 1, 880, [['pB', 'حليب', 4, 400], ['pA', 'ببسي', 27, 390]]]]);
  // الموقع وحده
  const byLoc = (await call('/sales', { groupBy: 'product', locationId: 'L2' })).body!.data as Row[];
  assert.deepEqual(byLoc.map((r) => [r.productId, r.total]), [['pB', 200], ['pA', 100], [null, 50]]);
  await call('/sales', { groupBy: 'rep', locationId: 'none' });
  assert.ok(whereOf('invoice').every((w) => w.locationId === null), 'none = بلا موقع');
  // بلا فلاتر: لا مفتاح جديد
  await call('/sales', { groupBy: 'rep' });
  for (const w of whereOf('invoice')) for (const k of ['salesRepId', 'customerId', 'locationId']) assert.ok(!(k in w), k);
});

test('معرّفٌ فاسد: ٤٠٠ بلا استعلام في كل تقريرٍ يقبله', async () => {
  const bad: [string, Row][] = [
    ['/sales', { salesRepId: ['r1', 'r2'] }], ['/sales', { locationId: 'x'.repeat(65) }], ['/sales', { customerId: { not: 'c1' } }],
    ['/orders', { locationId: ['L1'] }], ['/returns', { customerId: ['c1'] }], ['/collections', { customerId: ['c1'] }],
    ['/customer-visits', { salesRepId: ['r1'] }], ['/rep-performance', { locationId: ['L1'] }], ['/work-hours', { salesRepId: 'x'.repeat(65) }],
  ];
  for (const [p, q] of bad) {
    const res = await call(p, q);
    assert.equal(res.statusCode, 400, `${p} ${JSON.stringify(q)}`);
    assert.deepEqual(res.body, { success: false, message: 'معامل غير صالح' });
    assert.equal(calls.length, 0, `${p}: لا استعلام`);
  }
});

test('الطلبات والمرتجع: المندوب والعميل والموقع في الشرط — ونسبة المرتجع على مبيعات الفلاتر نفسها', async () => {
  await call('/orders', { salesRepId: 'r1', customerId: 'c2', locationId: 'L1' });
  const [o] = whereOf('invoice');
  assert.deepEqual([o.salesRepId, o.customerId, o.locationId, o.status, o.AND], ['r1', 'c2', 'L1', { not: 'CANCELLED' }, SCOPE.AND]);
  assert.ok(o.deliveryDate && o.deliveryDate.not === null, 'شرط التسليم باقٍ');
  // ملخّص الطلبات تجميعٌ في القاعدة بالشرط نفسه — الفلاتر فيه كما في القائمة (دقّة التقارير، البند ٧)
  assert.deepEqual(whereOf('invoice', 'aggregate'), [o], 'الملخّص على شرط القائمة نفسه');

  const res = await call('/returns', { salesRepId: 'r1', locationId: 'L1' });
  const [ret] = whereOf('invoice');
  const [agg] = whereOf('invoice', 'aggregate');
  for (const w of [ret, agg]) {
    assert.deepEqual([w.salesRepId, w.locationId, 'customerId' in w, w.AND], ['r1', 'L1', false, SCOPE.AND]);
  }
  assert.equal(ret.type, 'RETURN');
  // ملخّص المرتجع (الأسباب والبنود المنتهية) تجميعٌ في القاعدة على شرط القائمة نفسه — بفلاترها (دقّة التقارير، البند ٧)
  assert.deepEqual(whereOf('invoice', 'groupBy'), [ret], 'الأسباب على شرط القائمة');
  assert.deepEqual(whereOf('invoiceItem', 'count'), [{ returnExpired: true, invoice: ret }], 'البنود المنتهية على شرط القائمة');
  // ١٢٠ ÷ مبيعات أحمد في L1 (١٠٠٠ + ٦٠) = ١١٫٣٪
  assert.deepEqual([res.body!.data.summary.count, res.body!.data.summary.total], [1, 120]);
  assert.equal(res.body!.data.summary.salesTotal, 1060);
  assert.equal(res.body!.data.summary.returnRate, 11.3);
  await call('/returns', {});
  for (const k of ['salesRepId', 'customerId', 'locationId']) assert.ok(!(k in whereOf('invoice')[0]), k);
});

test('التحصيل: فلتر العميل بجانب المندوب — ولا فلتر موقع (السند بلا ختم موقع)', async () => {
  await call('/collections', { salesRepId: 'r1', customerId: 'c1', locationId: 'L1' });
  const [w] = whereOf('receipt');
  assert.deepEqual([w.salesRepId, w.customerId, 'locationId' in w, w.AND], ['r1', 'c1', false, SCOPE.AND]);
  await call('/collections', {});
  assert.ok(!('customerId' in whereOf('receipt')[0]));
});

test('زيارات العملاء: المندوب الزائر والعميل في الشرط بجانب النطاق', async () => {
  await call('/customer-visits', { salesRepId: 'r2', customerId: 'c2' });
  const [w] = visitWhereOf();
  assert.deepEqual([w.salesRepId, w.customerId, w.AND, w.tenantId], ['r2', 'c2', SCOPE.AND, 't1']);
  await call('/customer-visits', {});
  assert.ok(!('salesRepId' in visitWhereOf()[0]) && !('customerId' in visitWhereOf()[0]));
});

test('أداء المندوب وساعات العمل: المندوب صفّه وحده، والموقع مناديبه — داخل قيد المستخدم والفريق', async () => {
  for (const p of ['/rep-performance', '/work-hours']) {
    const one = await call(p, { salesRepId: 'r1' });
    const [rw] = whereOf('salesRep');
    assert.equal(rw.id, 'r1', p);
    assert.ok(!('locationId' in rw), p);
    assert.deepEqual(rw.AND[0], REP_SCOPE, `${p}: قيد المستخدم باقٍ في AND`);
    assert.deepEqual((one.body!.data as Row[]).map((r) => r.id), ['r1'], p);
    // جلساته وزياراته وحدها
    assert.equal(whereOf('repSession')[0].salesRepId, 'r1', p);
    assert.deepEqual(whereOf('repSession')[0].salesRep, REP_SCOPE, `${p}: نطاق سجلّات المندوب باقٍ`);
    assert.equal(visitWhereOf()[0].salesRepId, 'r1', p);
    // البيع النقدي المحصَّل (البند ٦) بمندوبه وحده كالجلسات والزيارات
    if (p === '/rep-performance') assert.equal(whereOf('invoice', 'groupBy')[0].salesRepId, 'r1', p);

    const loc = await call(p, { locationId: 'L1' });
    const [lw] = whereOf('salesRep');
    assert.deepEqual([lw.locationId, 'id' in lw], ['L1', false], p);
    assert.deepEqual((loc.body!.data as Row[]).map((r) => r.id), ['r1'], p);
    const none = await call(p, { locationId: 'none' });
    assert.deepEqual((none.body!.data as Row[]).map((r) => r.id), ['r2'], `${p}: none = بلا موقع`);

    // بلا فلاتر كما كان
    const all = await call(p, {});
    const [aw] = whereOf('salesRep');
    assert.ok(!('id' in aw) && !('locationId' in aw), p);
    assert.ok(!('salesRepId' in whereOf('repSession')[0]) && !('salesRepId' in visitWhereOf()[0]), p);
    if (p === '/rep-performance') assert.ok(!('salesRepId' in whereOf('invoice', 'groupBy')[0]), p);
    assert.equal((all.body!.data as Row[]).length, 2, p);
  }
});
