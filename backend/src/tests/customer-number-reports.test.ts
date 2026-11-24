// «رقم العميل» في حمولات التقارير (طلب المالك ٢٣ نوفمبر ٢٠٢٦: «… سيريل نمبر يمكن استخدامه في بحث التقارير …»).
//
// كل صفٍّ يحمل عميلاً يحمل رقمه ليطابقه بحث الواجهة و/m تماماً: `number` حين الصفّ هو العميل (أو العميل المعشَّش
// customer.number)، و`customerNumber` حين الصفّ زيارة. null لعميلٍ لم يُرقَّم بعد. والإضافة حقولٌ وحدها:
// المجاميع والترتيب والشروط كما كانت حرفاً، وصفوف المندوب والصنف والشهر بلا مفتاح number.
//
// ١) الدوالّ الصرفة: salesTwoLevel وmergeVisits وbuildUnvisitedRows وbuildProfitReport.
// ٢) المسارات الحقيقية على Prisma مزيّف يسجّل الاستعلامات: كل select للعميل يطلب number، وكل ردٍّ يحمله. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// —— بيانات: ثلاثة عملاء (#12 و#112 وقديمٌ لم يُرقَّم) ومندوبان ومستندٌ بلا مندوب ——
const A = { id: 'pA', name: 'ببسي', code: 'A1', unit: 'حبة', primaryUnitId: null };
const B = { id: 'pB', name: 'حليب', code: 'B1', unit: 'كرتون', primaryUnitId: null };
const r1 = { id: 'r1', name: 'أحمد' };
const r2 = { id: 'r2', name: 'خالد' };
const c1 = { id: 'c1', name: 'بقالة النور', number: 12, phone: '0501111111', channel: 'TT', city: 'الرياض', businessName: null };
const c2 = { id: 'c2', name: 'أسواق الخير', number: 112, phone: '0502222222', channel: 'MT', city: 'جدة', businessName: 'الخير' };
const c3 = { id: 'c3', name: 'عميل قديم', number: null, phone: '0503333333', channel: 'TT', city: null, businessName: null };
const CUSTS = [c1, c2, c3];
const line = (product: Row | null, qty: number, lineTotal: number) =>
  ({ id: `i-${Math.random()}`, qty, unitName: null, unitFactor: 1, baseQty: qty, lineTotal, product, returnOfItemId: null });
const doc = (id: string, type: string, rep: Row | null, customer: Row, total: number, items: Row[]) => ({
  id, number: `INV-${id}`, type, status: 'CONFIRMED', total, taxAmt: 0, discountAmt: 0, paidAmt: 0, remainingAmt: total,
  invoiceDate: new Date('2026-11-20T10:00:00Z'), deliveryDate: new Date('2026-11-25T10:00:00Z'), createdAt: new Date('2026-11-20T10:00:00Z'),
  returnReason: null, returnToStock: true, documentKind: null, notes: null, originalInvoice: null,
  salesRepId: rep?.id ?? null, salesRep: rep, customerId: customer.id, customer, locationId: null, team: null, items,
});
const DOCS: Row[] = [
  doc('s1', 'CASH', r1, c1, 1000, [line(A, 10, 600), line(B, 4, 400)]),
  doc('s2', 'CREDIT', r2, c2, 500, [line(A, 5, 300), line(B, 2, 200)]),
  doc('s3', 'CASH', null, c3, 300, [line(B, 3, 300)]),
  doc('s4', 'CASH', r1, c2, 60, [line(A, 1, 60)]),
  doc('ret1', 'RETURN', r1, c1, 120, [line(A, 2, 120)]),
];
const SALES = DOCS.filter((d) => d.type !== 'RETURN');
const RETURNS = DOCS.filter((d) => d.type === 'RETURN');
/** المستندات نفسها بلا «رقم العميل» — كما كانت قبل الميزة، لمقارنة المجاميع والترتيب */
const stripNo = (ds: Row[]) => ds.map((d) => ({ ...d, customer: { ...d.customer, number: undefined } }));

const RECEIPTS = [
  { id: 'rc1', receiptNumber: 'RC-1', amount: 400, paymentMethod: 'CASH', paymentMethodKey: null, receiptDate: new Date('2026-11-21T09:00:00Z'), status: 'ACTIVE', salesRepId: 'r1', customer: { id: 'c1', name: c1.name, number: 12 }, salesRep: r1, team: null },
  { id: 'rc2', receiptNumber: 'RC-2', amount: 100, paymentMethod: 'CASH', paymentMethodKey: null, receiptDate: new Date('2026-11-21T10:00:00Z'), status: 'ACTIVE', salesRepId: 'r2', customer: { id: 'c3', name: c3.name, number: null }, salesRep: r2, team: null },
];
const T0 = new Date('2026-11-22T08:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * 60000);
/** زيارة أحمد لـ#12: مؤقّتٌ ١٠ دقائق وملاحظةٌ بعده (وقفةٌ واحدة)، وزيارة خالد للقديم بلا رقم — الأحدث أولاً كما تقرأ الدفعات */
const VISITS = [
  { id: 'v3', salesRepId: 'r2', customerId: 'c3', createdAt: at(60), startedAt: at(60), durationSec: 300, lat: 24.7, lng: 46.7, note: '', customer: { name: c3.name, number: null }, salesRep: { name: r2.name }, team: null },
  { id: 'v2', salesRepId: 'r1', customerId: 'c1', createdAt: at(11), startedAt: null, durationSec: null, lat: null, lng: null, note: 'طلب عرض', customer: { name: c1.name, number: 12 }, salesRep: { name: r1.name }, team: null },
  { id: 'v1', salesRepId: 'r1', customerId: 'c1', createdAt: at(0), startedAt: at(0), durationSec: 600, lat: 24.6, lng: 46.6, note: '', customer: { name: c1.name, number: 12 }, salesRep: { name: r1.name }, team: null },
];

// —— Prisma مزيّف يسجّل كل استعلام ——
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let calls: { model: string; op: string; args: Row }[] = [];
const log = (model: string, op: string, args: Row) => { calls.push({ model, op, args }); };
const matches = (d: Row, w: Row = {}): boolean => {
  const t = w.type;
  if (typeof t === 'string' && d.type !== t) return false;
  if (t && typeof t === 'object' && t.not !== undefined && d.type === t.not) return false;
  if (typeof w.status === 'string' && d.status !== w.status) return false;
  return true;
};
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, aggregate: async () => ({ _sum: {}, _count: {} }), groupBy: async () => [] };
const db = new Proxy({
  invoice: {
    async findMany(a: Row) { log('invoice', 'findMany', a); return DOCS.filter((d) => matches(d, a.where)); },
    async aggregate(a: Row) {
      log('invoice', 'aggregate', a);
      const ds = DOCS.filter((d) => matches(d, a.where));
      const sum = (k: string) => ds.reduce((s, d) => s + Number(d[k] ?? 0), 0);
      return { _count: { _all: ds.length }, _sum: { total: sum('total'), paidAmt: sum('paidAmt'), remainingAmt: sum('remainingAmt') } };
    },
    async groupBy(a: Row) { log('invoice', 'groupBy', a); return []; },
  },
  invoiceItem: {
    async findMany(a: Row) { log('invoiceItem', 'findMany', a); return []; },
    async count(a: Row) { log('invoiceItem', 'count', a); return 0; },
  },
  productUnit: { async findMany(a: Row) { log('productUnit', 'findMany', a); return []; } },
  receipt: { async findMany(a: Row) { log('receipt', 'findMany', a); return RECEIPTS; } },
  customer: {
    async findMany(a: Row) {
      log('customer', 'findMany', a);
      return CUSTS.map((c, i) => ({
        ...c, status: 'ACTIVE', balance: 900 - i * 300, creditLimit: 0, paymentDays: 0, totalSales: 0, totalCollected: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'), assignments: [{ salesRep: i === 0 ? { id: 'r1', name: r1.name } : { id: 'r2', name: r2.name } }],
      }));
    },
  },
  customerAssignment: {
    async findMany(a: Row) {
      log('customerAssignment', 'findMany', a);
      return [{ salesRepId: 'r1', customer: c1 }, { salesRepId: 'r1', customer: c2 }, { salesRepId: 'r2', customer: c3 }]
        .map(({ salesRepId, customer: { channel: _ch, ...customer } }) => ({ salesRepId, customer }));
    },
  },
  accountEntry: {
    // «عمر الدين» في /balances (services/customerAgingDb.ts): قيود التسوية المدينة — لا شيء هنا
    async findMany(a: Row) { log('accountEntry', 'findMany', a); return []; },
    async groupBy(a: Row) {
      log('accountEntry', 'groupBy', a);
      if (a._max) return [];
      return [{ customerId: 'c1', _sum: { debit: 1000, credit: 400 } }, { customerId: 'c2', _sum: { debit: 560, credit: 0 } }, { customerId: 'c3', _sum: { debit: 300, credit: 100 } }];
    },
  },
  repVisit: {
    async findMany(a: Row) {
      log('repVisit', 'findMany', a);
      // الدفعة الأولى وحدها (مؤشّرٌ فارغ) — أقلّ من take فتتوقّف القراءة
      const cursor = a.where?.AND?.[1] ?? {};
      return Object.keys(cursor).length ? [] : VISITS;
    },
  },
  // «عمر الدين» في /balances (services/customerAgingDb.ts): التسويات اليدوية — لا شيء هنا
  customerAdjustment: { ...empty, async findMany(a: Row) { log('customerAdjustment', 'findMany', a); return []; } },
  repSession: { async findMany(a: Row) { log('repSession', 'findMany', a); return []; } },
  repAttendance: { async findMany(a: Row) { log('repAttendance', 'findMany', a); return []; } },
  salesRep: {
    async findMany(a: Row) {
      log('salesRep', 'findMany', a);
      return [r1, r2].map((r) => ({ ...r, invoices: [], receipts: [] }));
    },
  },
  async $queryRaw() { return []; },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });
stub('services/adminScope', {
  scopedRecordWhere: async () => ({}), scopedRepRecordWhere: async () => ({}),
  adminCustomerFilter: async () => ({}), adminRepFilter: async () => ({}),
  SHAPE_INVOICE_RECEIPT: {}, SHAPE_VISIT: {},
});
// «من زِير في الفترة» وآخر زيارة وفواتير الفترة — خدماتٌ تقرأ القاعدة؛ هنا: زِير #112 وحده
stub('services/unvisitedCustomersDb', {
  visitedCustomerIds: async () => new Set(['c2']),
  lastVisitBeforeMap: async () => new Map(),
});
stub('services/unvisitedInvoicesDb', { saleInvoiceStatsMap: async () => new Map() });

/* eslint-disable @typescript-eslint/no-var-requires */
const reports = require('../routes/reports') as typeof import('../routes/reports');
const { mergeVisits } = require('../services/workDay') as typeof import('../services/workDay');
const { buildUnvisitedRows } = require('../services/unvisitedCustomers') as typeof import('../services/unvisitedCustomers');
const { buildProfitReport } = require('../services/reports/profitReport') as typeof import('../services/reports/profitReport');
/* eslint-enable @typescript-eslint/no-var-requires */
const { salesTwoLevel } = reports;

async function call(routePath: string, query: Row = {}) {
  const layer = (reports.default as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  assert.ok(layer, `GET ${routePath} غير موجود`);
  const handler = layer.route.stack.slice(-1)[0].handle;
  const res = { statusCode: 200, body: null as Row | null, status(c: number) { this.statusCode = c; return this; }, json(b: Row) { this.body = b; return this; } };
  let err: unknown = null;
  calls = [];
  await handler({ query, params: {}, user: { id: 'a1', role: 'ADMIN', tenantId: 't1' } }, res, (e: unknown) => { err = e; });
  if (err) throw err;
  assert.equal(res.statusCode, 200, routePath);
  return res;
}
const argsOf = (model: string, op = 'findMany') => calls.filter((c) => c.model === model && c.op === op).map((c) => c.args);
/** صفّ بلا «رقم العميل» — ما كان قبل الميزة */
const omitNo = <T extends Row>(r: T): Row => { const { number: _n, customerNumber: _cn, ...rest } = r; return rest; };

// ═══ ١) الدوالّ الصرفة ═══

test('التجميعان المتداخلان: مستوى العميل يحمل رقمه (أباً وفرعاً)، والمندوب والصنف بلا مفتاح number', () => {
  const custProd = salesTwoLevel('customer', 'product', SALES as never, RETURNS as never);
  assert.deepEqual(custProd.map((r) => [r.key, r.number]), [['c1', 12], ['c2', 112], ['c3', null]]);
  assert.ok(custProd.every((r) => r.sub.every((s) => !('number' in s))), 'فروع الصنف بلا number');

  const repCust = salesTwoLevel('rep', 'customer', SALES as never, RETURNS as never);
  assert.ok(repCust.every((r) => !('number' in r)), 'صفّ المندوب بلا number');
  assert.deepEqual(repCust.map((r) => [r.key, r.sub.map((s) => [s.key, s.number])]), [
    ['r1', [['c1', 12], ['c2', 112]]],
    ['r2', [['c2', 112]]],
    ['—', [['c3', null]]],
  ]);

  const prodCust = salesTwoLevel('product', 'customer', SALES as never, RETURNS as never);
  assert.ok(prodCust.every((r) => !('number' in r)), 'صفّ الصنف بلا number');
  assert.deepEqual(prodCust.find((r) => r.key === 'pA')!.sub.map((s) => [s.key, s.number]), [['c1', 12], ['c2', 112]]);

  const custRep = salesTwoLevel('customer', 'rep', SALES as never, RETURNS as never);
  assert.ok(custRep.every((r) => r.sub.every((s) => !('number' in s))), 'فروع المندوب تحت العميل بلا number');
  assert.ok(salesTwoLevel('rep', 'product', SALES as never, RETURNS as never).every((r) => !('number' in r) && r.sub.every((s) => !('number' in s))));
});

test('التجميعان المتداخلان: المجاميع والترتيب كما كانا قبل الرقم حرفاً', () => {
  for (const [g, t] of [['customer', 'product'], ['rep', 'customer'], ['product', 'customer'], ['customer', 'rep']] as const) {
    const now = salesTwoLevel(g, t, SALES as never, RETURNS as never);
    const before = salesTwoLevel(g, t, stripNo(SALES) as never, stripNo(RETURNS) as never);
    const strip = (rows: Row[]) => rows.map((r) => ({ ...omitNo(r), sub: (r.sub as Row[]).map(omitNo) }));
    assert.deepEqual(strip(now), strip(before), `${g}/${t}`);
  }
  // بقالة النور: ١٠٠٠ − ١٢٠ مرتجع، بفاتورة بيعٍ واحدة
  const custProd = salesTwoLevel('customer', 'product', SALES as never, RETURNS as never);
  assert.deepEqual(custProd.map((r) => [r.key, r.count, r.total]), [['c1', 1, 880], ['c2', 2, 560], ['c3', 1, 300]]);
});

test('دمج الوقفة: الرقم يرافقها متى مُرِّر (وملاحظةٌ تسدّ غيابه من المؤقّت)، وغائبٌ تماماً لمن لا يمرّره', () => {
  const v = (min: number, durationSec: number | null, customerNumber?: number | null) =>
    ({ customerName: 'بقالة النور', customerId: 'c1', at: at(min), durationSec, ...(customerNumber !== undefined && { customerNumber }) });
  const [one] = mergeVisits([v(0, 600, 12), v(11, null, 12)]);
  assert.equal(one.customerNumber, 12);
  assert.equal(one.parts, 2, 'وقفةٌ واحدة كما كانت');
  const [filled] = mergeVisits([v(0, 600, null), v(11, null, 12)]);
  assert.equal(filled.customerNumber, 12, 'رقم الملاحظة يسدّ غيابه');
  const [plain] = mergeVisits([v(0, 600), v(11, null)]);
  assert.ok(!('customerNumber' in plain), 'من لا يمرّر الرقم: شكل الوقفة كما كان');
  const [lone] = mergeVisits([v(30, null, 12)]);
  assert.equal(lone.customerNumber, 12, 'ملاحظةٌ بلا مؤقّت');
});

test('«لم تتم زيارتهم»: الصفّ يحمل رقم العميل (null قبل ترقيمه أو من مُدخلٍ أقدم)، والترتيب كما كان', () => {
  const inp = CUSTS.map((c) => ({ ...c, createdAt: new Date('2026-01-01'), assignments: [] }));
  // كلاهما لم يُزر قط ⇒ بالاسم كما كان (لا بالرقم)
  const rows = buildUnvisitedRows(inp, ['c2'], new Map());
  assert.deepEqual(rows.map((r) => [r.id, r.number]), [['c1', 12], ['c3', null]]);
  const old = buildUnvisitedRows(inp.map(({ number: _n, ...c }) => c), ['c2'], new Map());
  assert.deepEqual(old.map((r) => [r.id, r.number]), [['c1', null], ['c3', null]], 'مُدخلٌ بلا رقم ⇒ null');
  assert.deepEqual(old.map(omitNo), rows.map(omitNo), 'باقي الصفّ حرفاً');
});

test('الربح بتجميع العميل: الصفّ يحمل رقمه من خريطةٍ موازية، وغيره بلا number، والأرقام كما كانت', () => {
  const inv = (id: string, type: string, customerId: string) =>
    ({ id, type, documentKind: null, invoiceDate: new Date('2026-11-10T09:00:00Z'), total: 0, taxAmt: 0, salesRepId: 'r1', customerId });
  const it = (id: string, i: Row, lineTotal: number) =>
    ({ id, invoiceId: i.id, productId: 'pA', itemName: null, qty: 1, unitName: null, unitFactor: 1, baseQty: 1, lineTotal, taxAmt: 0, invoice: i });
  const cost = { cost: 10, noCostQty: 0, source: 'AVERAGE' as const };
  const lines = [
    { item: it('a', inv('s1', 'CASH', 'c1'), 100) as never, net: 100, cost, month: '2026-11' },
    { item: it('b', inv('s2', 'CASH', 'c3'), 50) as never, net: 50, cost, month: '2026-11' },
  ];
  const names = {
    products: new Map([['pA', { name: 'ببسي', code: 'A1', unit: 'حبة', primaryUnitId: null, units: [] }]]),
    reps: new Map([['r1', 'أحمد']]),
    customers: new Map([['c1', c1.name], ['c3', c3.name]]),
  };
  const withNo = buildProfitReport(lines, 'customer', { ...names, customerNumbers: new Map([['c1', 12], ['c3', null]]) }, 2);
  assert.deepEqual(withNo.rows.map((r) => [r.key, r.name, r.number, r.netSales, r.grossProfit]), [['c1', c1.name, 12, 100, 90], ['c3', c3.name, null, 50, 40]]);
  // بلا الخريطة (مُستدعٍ أقدم): null — والصفوف والملخّص حرفاً
  const noMap = buildProfitReport(lines, 'customer', names, 2);
  assert.deepEqual(noMap.rows.map((r) => r.number), [null, null]);
  assert.deepEqual(noMap.rows.map(omitNo), withNo.rows.map(omitNo));
  assert.deepEqual(noMap.summary, withNo.summary);
  for (const g of ['product', 'rep', 'month'] as const) {
    assert.ok(buildProfitReport(lines, g, { ...names, customerNumbers: new Map([['c1', 12]]) }, 2).rows.every((r) => !('number' in r)), g);
  }
});

test('الربح: المعالج يقرأ رقم العميل مع اسمه ويمرّره خريطةً موازية', () => {
  const s = fs.readFileSync(path.join(SRC, 'services', 'reports', 'profitReport.ts'), 'utf8');
  assert.match(s, /prisma\.customer\.findMany\(\{ where: \{ tenantId: tid, id: \{ in: customerIds \} \}, select: \{ id: true, name: true, number: true \} \}\)/);
  assert.match(s, /customerNumbers: new Map\(customerRows\.map\(\(c\) => \[c\.id, c\.number \?\? null\]\)\)/);
});

// ═══ ٢) المسارات ═══

test('/sales بتجميع العميل: {name,count,total,number} — والمجاميع والترتيب كما كانت، والعميل في الاستعلام يطلب number', async () => {
  const res = await call('/sales', { groupBy: 'customer' });
  assert.deepEqual(res.body!.data, [
    { name: c1.name, count: 1, total: 880, number: 12 },
    { name: c2.name, count: 2, total: 560, number: 112 },
    { name: c3.name, count: 1, total: 300, number: null },
  ]);
  for (const a of argsOf('invoice')) assert.equal(a.include.customer.select.number, true);
  // التجميعات الأخرى بلا number كما كانت
  for (const g of ['rep', 'product', 'channel']) {
    const rows = (await call('/sales', { groupBy: g })).body!.data as Row[];
    assert.ok(rows.every((r) => !('number' in r)), g);
  }
  // والمتداخل: مستوى العميل برقمه
  const two = (await call('/sales', { groupBy: 'rep', thenBy: 'customer' })).body!.data as Row[];
  assert.deepEqual(two[0].sub.map((s: Row) => [s.name, s.number]), [[c1.name, 12], [c2.name, 112]]);
});

test('/orders و/returns: العميل المعشَّش يحمل number، والملخّص كما كان', async () => {
  const o = await call('/orders', {});
  assert.equal(argsOf('invoice')[0].select.customer.select.number, true);
  const orders = o.body!.data.orders as Row[];
  assert.ok(orders.length > 0);
  // رقم كل عميلٍ معشَّش هو رقمه هو (null لغير المرقَّم) — المزيّف لا يصفّي بالنوع، فالعبرة بالمطابقة لا بالعدد
  for (const r of orders) assert.equal(r.customer.number, CUSTS.find((c) => c.id === r.customer.id)!.number, r.id);
  assert.deepEqual([...new Set(orders.map((r) => r.customer.number))], [12, 112, null]);
  assert.equal(o.body!.data.summary.count, orders.length, 'الملخّص على الشرط نفسه');

  const r = await call('/returns', {});
  assert.equal(argsOf('invoice')[0].select.customer.select.number, true);
  assert.deepEqual((r.body!.data.returns as Row[]).map((x) => [x.number, x.customer.number]), [['INV-ret1', 12]]);
});

test('/collections: سندات القبض بعميلٍ يحمل number (null لغير المرقَّم)', async () => {
  const res = await call('/collections', {});
  assert.equal(argsOf('receipt')[0].include.customer.select.number, true);
  assert.deepEqual((res.body!.data.receipts as Row[]).map((r) => r.customer.number), [12, null]);
  assert.equal(res.body!.data.summary.total, 500);
});

test('/balances: الصفّ (العميل نفسه) يحمل number والترتيب كما هو', async () => {
  const res = await call('/balances', {});
  assert.equal(argsOf('customer')[0].select.number, true);
  assert.deepEqual((res.body!.data as Row[]).map((c) => [c.id, c.number]), [['c1', 12], ['c2', 112], ['c3', null]]);
});

test('/customer-visits: الصفّ زيارةٌ فيحمل customerNumber — والدمج كما كان (وقفتان لا ثلاث)', async () => {
  const res = await call('/customer-visits', {});
  assert.equal(argsOf('repVisit')[0].select.customer.select.number, true);
  const rows = res.body!.data.visits as Row[];
  assert.equal(res.body!.data.count, 2);
  assert.deepEqual(rows.map((v) => [v.customerName, v.customerNumber, v.note]), [[c3.name, null, ''], [c1.name, 12, 'طلب عرض']]);
  assert.ok(rows.every((v) => !('number' in v)), 'صفّ الزيارة ليس العميل');
});

test('/unvisited-customers: الصفّ يحمل number ومن زِير مستبعدٌ كما كان', async () => {
  const res = await call('/unvisited-customers', {});
  assert.equal(argsOf('customer')[0].select.number, true);
  const d = res.body!.data;
  assert.equal(d.totalCustomers, 3);
  assert.deepEqual((d.customers as Row[]).map((c) => [c.id, c.number]), [['c1', 12], ['c3', null]]);
});

test('/rep-receivables: عملاء المندوب يحملون number، والمجاميع والترتيب كما كانت', async () => {
  const res = await call('/rep-receivables', {});
  assert.equal(argsOf('customerAssignment')[0].select.customer.select.number, true);
  const rows = res.body!.data as Row[];
  assert.deepEqual(rows.map((r) => [r.id, r.totalBalance, r.customers.map((c: Row) => [c.id, c.number, c.balance])]), [
    ['r1', 1160, [['c1', 12, 600], ['c2', 112, 560]]],
    ['r2', 200, [['c3', null, 200]]],
  ]);
});

test('/rep-performance: روابط الزيارات visits[] تحمل customerNumber، والعدّ وقفاتٌ كما كان', async () => {
  const res = await call('/rep-performance', {});
  assert.equal(argsOf('repVisit')[0].select.customer.select.number, true);
  const byId = new Map((res.body!.data as Row[]).map((r) => [r.id, r]));
  assert.equal(byId.get('r1')!.visitsCount, 1, 'المؤقّت وملاحظته وقفةٌ واحدة');
  assert.deepEqual(byId.get('r1')!.visits.map((v: Row) => [v.customerName, v.customerNumber]), [[c1.name, 12]]);
  assert.deepEqual(byId.get('r2')!.visits.map((v: Row) => [v.customerName, v.customerNumber]), [[c3.name, null]]);
});

test('/work-hours: وقفات اليوم days[].visits[] تحمل customerNumber، وعدد الوقفات كما كان', async () => {
  const res = await call('/work-hours', { from: '2026-11-22', to: '2026-11-22', tz: '180' });
  assert.equal(argsOf('repVisit')[0].select.customer.select.number, true);
  const byId = new Map((res.body!.data as Row[]).map((r) => [r.id, r]));
  const visitsOf = (id: string) => (byId.get(id)!.days as Row[]).flatMap((d) => d.visits as Row[]);
  assert.deepEqual(visitsOf('r1').map((v) => [v.customerName, v.customerNumber, v.parts]), [[c1.name, 12, 2]]);
  assert.deepEqual(visitsOf('r2').map((v) => [v.customerName, v.customerNumber]), [[c3.name, null]]);
  assert.equal(byId.get('r1')!.visitsTotal, 1);
});

test('حارس: «رقم العميل» حقلٌ للقراءة وحده في التقارير — البحث به في الواجهة، فلا شرط ولا ترتيب به في الخادم', () => {
  for (const rel of [['routes', 'reports.ts'], ['services', 'reports', 'profitReport.ts']]) {
    const s = fs.readFileSync(path.join(SRC, ...rel), 'utf8');
    // كل «number» داخل كائن العميل طلبُ قراءة (number: true) لا شرط
    assert.doesNotMatch(s, /customer:\s*\{[^{}]*\bnumber:\s*(?!true\b)/, `${rel.join('/')}: لا شرط على رقم العميل`);
    assert.doesNotMatch(s, /customerNumberOr|customerRelNumberOr|customerNumberQuery/, `${rel.join('/')}: لا بحث خادمٍ بالرقم`);
    assert.doesNotMatch(s, /orderBy:[^\n]*\bnumber\b/, `${rel.join('/')}: لا ترتيب بالرقم`);
  }
});
