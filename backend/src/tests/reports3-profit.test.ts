// «تقرير الربح» (GET /reports/profit — services/reports/profitReport.ts): مجمل الربح قبل المصروفات.
//
// ١) الصرف: المدى بأيام الشركة، صافي البند قبل الضريبة (وتوزيع صافي فاتورةٍ قديمة)، المتوسّط المرجّح لوحدة الأساس، أثر
//    لقطات التكلفة، والتجميع (الصنف/المندوب/العميل/الشهر) مع علَم «بلا تكلفة» — وعلى رأسها المثال المحلول:
//    بيع ٥٠ بـ٣٠ وتكلفة ٢٠ ⇒ مبيعات ١٥٠٠ تكلفة ١٠٠٠ ربح ٥٠٠ هامش ٣٣٫٣٣٪.
// ٢) المعالج على Prisma مزيّف يسجّل الاستعلامات: الشركة والنطاق والفلاتر في الشرط، والمحاسبة المطفأة ٤٠٣، والمعامل الفاسد
//    ٤٠٠، والدفاتر المربوطة تقرأ اللقطات وغيرها المتوسّط وحده، وكمية اللقطة بلا تكلفة تُكمَّل بالمتوسّط، والممنوع من تكلفة
//    الشراء (canManageVanStock) ٤٠٣ بلا قراءة، وسقف الفواتير المعلَن. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// —— Prisma مزيّف ——
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let calls: { model: string; op: string; args: Row }[] = [];
const log = (model: string, op: string, args: Row) => { calls.push({ model, op, args }); };

const state: {
  tenant: Row | null; company: Row | null; gl: Row | null; admin: Row | null;
  items: Row[]; snaps: Row[]; avg: Row[]; products: Row[]; units: Row[]; reps: Row[]; customers: Row[];
} = { tenant: null, company: null, gl: null, admin: null, items: [], snaps: [], avg: [], products: [], units: [], reps: [], customers: [] };
let rawCalls: unknown[][] = [];

const db = {
  tenant: { async findUnique(a: Row) { log('tenant', 'findUnique', a); return state.tenant; } },
  companySettings: { async findUnique(a: Row) { log('companySettings', 'findUnique', a); return state.company; } },
  glSettings: { async findUnique(a: Row) { log('glSettings', 'findUnique', a); return state.gl; } },
  admin: { async findUnique(a: Row) { log('admin', 'findUnique', a); return state.admin; } },
  // رؤوس الفواتير (معرّفاتها) من فواتير البنود المُعدّة: الأحدث أولاً ثم المعرّف تنازلياً، بـtake
  invoice: {
    async findMany(a: Row) {
      log('invoice', 'findMany', a);
      const docs = [...new Map(state.items.map((i) => [i.invoice.id, i.invoice])).values()]
        .sort((x, y) => y.invoiceDate.getTime() - x.invoiceDate.getTime() || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
      return docs.slice(0, a.take ?? Infinity).map((d) => ({ id: d.id }));
    },
  },
  invoiceItem: {
    async findMany(a: Row) {
      log('invoiceItem', 'findMany', a);
      const ids = new Set(a.where.invoiceId.in as string[]);
      return state.items.filter((i) => ids.has(i.invoiceId));
    },
  },
  glCostSnapshot: {
    async findMany(a: Row) {
      log('glCostSnapshot', 'findMany', a);
      const w = a.where;
      return state.snaps.filter((s) => s.refType === w.refType && (w.refId ? w.refId.in.includes(s.refId) : w.itemId.in.includes(s.itemId)));
    },
  },
  product: { async findMany(a: Row) { log('product', 'findMany', a); return state.products.filter((p) => a.where.id.in.includes(p.id)); } },
  productUnit: { async findMany(a: Row) { log('productUnit', 'findMany', a); return state.units.filter((u) => a.where.productId.in.includes(u.productId)); } },
  salesRep: { async findMany(a: Row) { log('salesRep', 'findMany', a); return state.reps; } },
  customer: { async findMany(a: Row) { log('customer', 'findMany', a); return state.customers; } },
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    rawCalls.push([strings.join('?'), ...values]);
    const ids = values[values.length - 1] as string[];
    return state.avg.filter((r) => ids.includes(r.productId));
  },
};
stub('config/database', { default: db });
const SCOPE = { AND: [{ scope: 'S' }] };
stub('services/adminScope', { scopedRecordWhere: async () => SCOPE, SHAPE_INVOICE_RECEIPT: {} });

/* eslint-disable @typescript-eslint/no-var-requires */
const P = require('../services/reports/profitReport') as typeof import('../services/reports/profitReport');
/* eslint-enable @typescript-eslint/no-var-requires */
const {
  profitRange, profitGroupOf, profitIdOf, lineNetsOf, averageCostMap, snapshotCostsByItem, lineCostOf, buildProfitReport,
  profitReportHandler,
} = P;

// —— بيانات ——
const RIYADH = 'Asia/Riyadh';
const doc = (id: string, type: string, total: number, taxAmt: number, rep: string | null, customer: string, date: string, documentKind: string | null = null) =>
  ({ id, type, documentKind, invoiceDate: new Date(date), total, taxAmt, salesRepId: rep, customerId: customer });
const item = (id: string, inv: Row, productId: string | null, qty: number, lineTotal: number, taxAmt = 0, unitFactor = 1, itemName: string | null = null) =>
  ({ id, invoiceId: inv.id, productId, itemName, qty, unitName: unitFactor === 1 ? null : 'كرتون', unitFactor, baseQty: qty * unitFactor, lineTotal, taxAmt, invoice: inv });
const NAMES = {
  products: new Map([
    ['pA', { name: 'ماء', code: 'A1', unit: 'حبة', primaryUnitId: null, units: [{ id: 'u1', name: 'كرتون', factor: 24 }] }],
    ['pB', { name: 'عصير', code: 'B1', unit: 'حبة', primaryUnitId: null, units: [] }],
  ]),
  reps: new Map([['r1', 'أحمد'], ['r2', 'خالد']]),
  customers: new Map([['c1', 'بقالة'], ['c2', 'تموينات']]),
};

// ═══ ١) الصرف ═══

test('المثال المحلول: بيع ٥٠ بـ٣٠ وتكلفة ٢٠ ⇒ مبيعات ١٥٠٠ تكلفة ١٠٠٠ ربح ٥٠٠ هامش ٣٣٫٣٣٪', () => {
  // فاتورةٌ بضريبة ١٥٪ حصرية: البند ١٧٢٥ شاملاً وضريبته ٢٢٥ ⇒ صافيه ١٥٠٠ (المبيعات قبل الضريبة)
  const inv = doc('s1', 'CASH', 1725, 225, 'r1', 'c1', '2026-11-10T09:00:00Z');
  const it = item('i1', inv, 'pA', 50, 1725, 225);
  const avg = averageCostMap([{ productId: 'pA', value: 2000, base: 100 }]); // وارد ١٠٠ بـ٢٠
  const nets = lineNetsOf([it], 2);
  assert.equal(nets.get('i1'), 1500);
  const cost = lineCostOf(it, false, new Map(), avg, 2);
  assert.deepEqual(cost, { cost: 1000, noCostQty: 0, source: 'AVERAGE' });
  const r = buildProfitReport([{ item: it, net: 1500, cost, month: '2026-11' }], 'product', NAMES, 2);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.deepEqual([row.qty, row.netSales, row.cost, row.grossProfit, row.marginPct, row.noCost, row.count], [50, 1500, 1000, 500, 33.33, false, 1]);
  assert.deepEqual([r.summary.netSales, r.summary.cost, r.summary.grossProfit, r.summary.marginPct], [1500, 1000, 500, 33.33]);
  assert.equal(r.summary.costSource, 'AVERAGE');
  assert.equal(r.summary.noCostProducts, 0);
});

test('المتوسّط المرجّح لوحدة الأساس: unitCost ÷ unitFactor مرجَّحاً بكمية الأساس، وبلا وارد مسعَّر غائب', () => {
  // ١٠٠ حبة بـ٢٠ + كرتونان (٤٨ حبة) بـ٧٢٠ للكرتون (٣٠ للحبة) ⇒ (٢٠٠٠ + ١٤٤٠) ÷ ١٤٨
  const m = averageCostMap([
    { productId: 'pA', value: 100 * 20 + 48 * (720 / 24), base: 148 },
    { productId: 'pZ', value: 0, base: 10 },
    { productId: 'pY', value: '50', base: '0' },
  ]);
  assert.equal(Number(m.get('pA')!.toFixed(6)), Number((3440 / 148).toFixed(6)));
  assert.equal(m.has('pZ'), false, 'وارد بقيمة صفرية ليس سعر شراء');
  assert.equal(m.has('pY'), false, 'لا قسمة على صفر');
});

test('صافي البند قبل الضريبة: lineTotal − taxAmt، وفاتورةٌ قديمة يخالف مجموعُ بنودها صافيَها يُوزَّع صافيها بأكبر الباقي', () => {
  const inv = doc('s1', 'CASH', 230, 30, null, 'c1', '2026-11-10T09:00:00Z');
  const a = item('a', inv, 'pA', 1, 115, 15);
  const b = item('b', inv, 'pB', 1, 115, 15);
  assert.deepEqual([...lineNetsOf([a, b], 2).values()], [100, 100]);
  // قديمة: خصمٌ كلّيّ بعد البنود — total − tax = ١٥٠ وصافي البنود ١٠٠ + ١٠٠ ⇒ ٧٥ و٧٥ (المجموع حرفاً)
  const old = doc('s2', 'CASH', 180, 30, null, 'c1', '2026-11-10T09:00:00Z');
  const nets = lineNetsOf([item('c', old, 'pA', 1, 115, 15), item('d', old, 'pB', 1, 115, 15)], 2);
  assert.deepEqual([nets.get('c'), nets.get('d')], [75, 75]);
  // ثلاث منازل (الدينار الكويتي): ١٠ ÷ ٣ تُوزَّع ٣٫٣٣٤ و٣٫٣٣٣ و٣٫٣٣٣
  const kw = doc('k', 'CASH', 10, 0, null, 'c1', '2026-11-10T09:00:00Z');
  const k = lineNetsOf([item('k1', kw, 'pA', 1, 4), item('k2', kw, 'pA', 1, 4), item('k3', kw, 'pA', 1, 4)], 3);
  assert.equal([...k.values()].reduce((s, v) => s + v, 0).toFixed(3), '10.000');
});

test('لقطات التكلفة: البيع موجب والمرتجع العائد أو المشطوب يعكسه، وكميتها بلا تكلفة تُكمَّل بالمتوسّط، وبندٌ بلا رجلٍ يسقط إليه', () => {
  const snaps = snapshotCostsByItem([
    { sourceKey: 'COST:INVOICE:i1:OUT', kind: 'VAN_SALE', itemId: 'i1', location: 'VAN:r1', toLocation: null, baseQty: -50, uncostedQty: 0, valueMilli: -1_000_000n, varianceMilli: 0n, memoMilli: 0n },
    { sourceKey: 'COST:INVOICE:i2:RET', kind: 'VAN_RETURN_RESTOCK', itemId: 'i2', location: 'VAN:r1', toLocation: null, baseQty: 5, uncostedQty: 0, valueMilli: 100_000n, varianceMilli: 0n, memoMilli: 0n },
    { sourceKey: 'COST:INVOICE:i3:RET', kind: 'RETURN_WRITE_OFF', itemId: 'i3', location: 'VAN:r1', toLocation: null, baseQty: 0, uncostedQty: 0, valueMilli: 0n, varianceMilli: 0n, memoMilli: 40_000n },
    // بيعٌ نصفه بلا تكلفة معروفة (دلو خارج التقييم)
    { sourceKey: 'COST:INVOICE:i4:OUT', kind: 'WAREHOUSE_SALE', itemId: 'i4', location: 'WH', toLocation: null, baseQty: -10, uncostedQty: 5, valueMilli: -50_000n, varianceMilli: 0n, memoMilli: 0n },
    // تبديلٌ وحده بلا رجل: لا يجعل البند «مُلقَطاً»
    { sourceKey: 'COST:RESTOCK_LOG:l1:i5', kind: 'RESTOCK_TOGGLE', itemId: 'i5', location: 'VAN:r1', toLocation: null, baseQty: 0, uncostedQty: 0, valueMilli: 0n, varianceMilli: 0n, memoMilli: 0n },
    { sourceKey: 'COST:INVOICE:i6:OUT', kind: 'UNKNOWN_KIND', itemId: 'i6', location: 'WH', toLocation: null, baseQty: -1, uncostedQty: 0, valueMilli: -1n, varianceMilli: 0n, memoMilli: 0n },
  ]);
  const inv = doc('s', 'CASH', 0, 0, 'r1', 'c1', '2026-11-10T09:00:00Z');
  const ret = doc('r', 'RETURN', 0, 0, 'r1', 'c1', '2026-11-10T09:00:00Z');
  const avg = new Map([['pA', 25]]);
  assert.deepEqual(lineCostOf(item('i1', inv, 'pA', 50, 0), false, snaps, avg, 2), { cost: 1000, noCostQty: 0, source: 'SNAPSHOT' });
  assert.deepEqual(lineCostOf(item('i2', ret, 'pA', 5, 0), true, snaps, avg, 2), { cost: -100, noCostQty: 0, source: 'SNAPSHOT' });
  assert.deepEqual(lineCostOf(item('i3', ret, 'pA', 2, 0), true, snaps, avg, 2), { cost: -40, noCostQty: 0, source: 'SNAPSHOT' });
  // نصف البيع بلا تكلفة في اللقطة: ٥٠ من اللقطة + ٥ × ٢٥ بالمتوسّط — لا «بلا تكلفة» والصنف له سعر شراء
  assert.deepEqual(lineCostOf(item('i4', inv, 'pA', 10, 0), false, snaps, avg, 2), { cost: 175, noCostQty: 0, source: 'SNAPSHOT', averagedQty: 5 });
  // ولا متوسّط للصنف: يبقى أثر اللقطة وحده والكمية «بلا تكلفة»
  assert.deepEqual(lineCostOf(item('i4', inv, 'pB', 10, 0), false, snaps, avg, 2), { cost: 50, noCostQty: 5, source: 'SNAPSHOT' });
  assert.deepEqual(lineCostOf(item('i5', ret, 'pA', 2, 0), true, snaps, avg, 2), { cost: -50, noCostQty: 0, source: 'AVERAGE' });
  assert.deepEqual(lineCostOf(item('i6', inv, 'pB', 3, 0), false, snaps, avg, 2), { cost: 0, noCostQty: 3, source: 'NONE' });
  // الإشعار المدين: بندٌ بلا صنف — إيرادٌ بلا تكلفة ولا عَلَم
  assert.deepEqual(lineCostOf(item('dn', inv, null, 1, 0), false, snaps, avg, 2, true), { cost: 0, noCostQty: 0, source: 'NONE' });
});

test('التجميع: المرتجع يُطرح مبيعاً وتكلفةً، و«بلا تكلفة» علَمٌ وعدد، والمندوب والعميل والشهر', () => {
  const s1 = doc('s1', 'CASH', 1500, 0, 'r1', 'c1', '2026-10-30T22:30:00Z'); // ٣١ أكتوبر ٠١:٣٠ بتوقيت الرياض ⇒ أكتوبر
  const s2 = doc('s2', 'CREDIT', 500, 0, 'r2', 'c2', '2026-11-05T10:00:00Z');
  const s3 = doc('s3', 'CASH', 200, 0, null, 'c2', '2026-11-06T10:00:00Z');
  const rt = doc('rt', 'RETURN', 300, 0, 'r1', 'c1', '2026-11-07T10:00:00Z');
  const avg = new Map([['pA', 20]]);
  const mk = (it: Row, month: string) => ({ item: it as never, net: Number(it.lineTotal) - Number(it.taxAmt), cost: lineCostOf(it as never, it.invoice.type === 'RETURN', new Map(), avg, 2), month });
  const lines = [
    mk(item('a1', s1, 'pA', 50, 1500), '2026-10'),
    mk(item('b1', s2, 'pB', 10, 500), '2026-11'), // عصير بلا سعر شراء
    mk(item('a2', s3, 'pA', 5, 200), '2026-11'),
    mk(item('a3', rt, 'pA', 10, 300), '2026-11'), // مرتجع ١٠ ماء ⇒ −٣٠٠ مبيعاً و−٢٠٠ تكلفة
  ];
  const byProduct = buildProfitReport(lines, 'product', NAMES, 2);
  const brief = (rows: Row[]) => rows.map((r) => [r.key, r.qty ?? r.count, r.netSales, r.cost, r.grossProfit, r.marginPct, r.noCost]);
  assert.deepEqual(brief(byProduct.rows), [
    ['pA', 45, 1400, 900, 500, 35.71, false],
    ['pB', 10, 500, 0, 500, 100, true],
  ]);
  assert.deepEqual([byProduct.summary.netSales, byProduct.summary.cost, byProduct.summary.grossProfit, byProduct.summary.marginPct], [1900, 900, 1000, 52.63]);
  assert.deepEqual([byProduct.summary.salesTotal, byProduct.summary.returnsTotal, byProduct.summary.invoicesCount, byProduct.summary.returnsCount], [2200, 300, 3, 1]);
  assert.equal(byProduct.summary.noCostProducts, 1);
  assert.deepEqual(byProduct.summary.noCostList, [{ key: 'pB', productId: 'pB', name: 'عصير', code: 'B1', qty: 10 }]);
  assert.equal(byProduct.rows[0].units?.length, 1, 'وحدات الصنف للعارض');

  const byRep = buildProfitReport(lines, 'rep', NAMES, 2);
  assert.deepEqual(byRep.rows.map((r) => [r.key, r.name, r.count, r.netSales, r.cost, r.grossProfit, r.noCost]), [
    ['r2', 'خالد', 1, 500, 0, 500, true],
    ['r1', 'أحمد', 1, 1200, 800, 400, false],
    ['—', 'بلا مندوب', 1, 200, 100, 100, false],
  ]);
  assert.equal(byRep.rows[0].qty, undefined, 'لا كمية تُجمع عبر الأصناف');
  // الإجمالي واحدٌ في كل تجميع
  assert.deepEqual([byRep.summary.netSales, byRep.summary.cost], [1900, 900]);

  const byCustomer = buildProfitReport(lines, 'customer', NAMES, 2);
  assert.deepEqual(byCustomer.rows.map((r) => [r.key, r.netSales, r.grossProfit]), [['c2', 700, 600], ['c1', 1200, 400]]);

  const byMonth = buildProfitReport(lines, 'month', NAMES, 2);
  assert.deepEqual(byMonth.rows.map((r) => [r.key, r.netSales, r.cost, r.grossProfit]), [['2026-10', 1500, 1000, 500], ['2026-11', 400, -100, 500]]);
});

test('الصنف المحذوف باسمه المحفوظ «بلا تكلفة»، والإشعار المدين صفٌّ واحد «تعديلات أسعار» بلا عَلَم، ولا هامش بلا مبيعات موجبة', () => {
  const s = doc('s', 'CASH', 300, 0, 'r1', 'c1', '2026-11-05T10:00:00Z');
  const dn = doc('dn', 'CREDIT', 50, 0, 'r1', 'c1', '2026-11-05T10:00:00Z', 'DEBIT_NOTE');
  const rt = doc('rt', 'RETURN', 90, 0, 'r1', 'c1', '2026-11-05T10:00:00Z');
  const lines = [
    { item: item('x', s, null, 3, 300, 0, 1, 'قديم') as never, net: 300, cost: lineCostOf(item('x', s, null, 3, 300) as never, false, new Map(), new Map(), 2), month: '2026-11' },
    { item: item('y', dn, null, 1, 50, 0, 1, 'فرق سعر') as never, net: 50, cost: lineCostOf(item('y', dn, null, 1, 50) as never, false, new Map(), new Map(), 2, true), month: '2026-11' },
    { item: item('z', rt, 'pB', 3, 90) as never, net: 90, cost: lineCostOf(item('z', rt, 'pB', 3, 90) as never, true, new Map(), new Map(), 2), month: '2026-11' },
  ];
  const r = buildProfitReport(lines, 'product', NAMES, 2);
  const by = new Map(r.rows.map((x) => [x.key, x]));
  assert.deepEqual([by.get('deleted:قديم')?.name, by.get('deleted:قديم')?.noCost], ['قديم', true]);
  assert.deepEqual([by.get('__adjustments')?.name, by.get('__adjustments')?.noCost, by.get('__adjustments')?.netSales], ['تعديلات أسعار', false, 50]);
  // صنفٌ مرتجعٌ وحده: مبيعاته سالبة صادقة، ولا هامش
  assert.deepEqual([by.get('pB')?.netSales, by.get('pB')?.marginPct], [-90, null]);
  assert.equal(r.summary.noCostProducts, 2, 'المحذوف والمرتجع بلا سعر شراء — لا الإشعار المدين');
});

test('المدى بأيام الشركة: «إلى» شاملٌ يومه حتى منتصف ليل الرياض، وبلا مدى آخر ٩٠ يوماً، والمقلوب والفاسد مرفوضان', () => {
  const now = new Date('2026-11-18T08:00:00Z');
  const r = profitRange('2026-11-01', '2026-11-30', RIYADH, now);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.gte?.toISOString(), '2026-10-31T21:00:00.000Z');
    assert.equal(r.lt.toISOString(), '2026-11-30T21:00:00.000Z');
    assert.equal(r.defaulted, false);
  }
  const d = profitRange(undefined, '', RIYADH, now);
  assert.ok(d.ok && d.defaulted && d.from === '2026-08-21' && d.to === '2026-11-18');
  const onlyTo = profitRange('', '2026-11-10', RIYADH, now);
  assert.ok(onlyTo.ok && onlyTo.from === null && onlyTo.gte === null);
  assert.deepEqual(profitRange('2026-11-30', '2026-11-01', RIYADH, now), { ok: false, message: 'تاريخ البداية بعد تاريخ النهاية' });
  assert.deepEqual(profitRange('2026-13-01', '', RIYADH, now), { ok: false, message: 'تاريخ غير صالح' });
  assert.equal(profitGroupOf(undefined), undefined);
  assert.equal(profitGroupOf('month'), 'month');
  assert.equal(profitGroupOf('channel'), null);
  assert.equal(profitIdOf(['a']), false);
  assert.equal(profitIdOf(' r1 '), 'r1');
});

// ═══ ٢) المعالج ═══

async function call(query: Row = {}, user: Row = { id: 'a1', role: 'ADMIN', tenantId: 't1' }) {
  const res = { statusCode: 200, body: null as Row | null, status(c: number) { this.statusCode = c; return this; }, json(b: Row) { this.body = b; return this; } };
  let err: unknown = null;
  calls = [];
  rawCalls = [];
  await profitReportHandler({ query, params: {}, user } as never, res as never, (e: unknown) => { err = e; });
  if (err) throw err;
  return res;
}
const reset = () => {
  const s1 = doc('s1', 'CASH', 1725, 225, 'r1', 'c1', '2026-11-10T09:00:00Z');
  Object.assign(state, {
    tenant: { accountingEnabled: true },
    company: { countryCode: 'SA', currency: 'SAR', taxDisabled: false },
    gl: null,
    admin: { isActive: true, canManageVanStock: true },
    items: [item('i1', s1, 'pA', 50, 1725, 225)],
    snaps: [],
    avg: [{ productId: 'pA', value: 2000, base: 100 }],
    products: [{ id: 'pA', name: 'ماء', code: 'A1', unit: 'حبة', primaryUnitId: null }],
    units: [],
    reps: [{ id: 'r1', name: 'أحمد' }],
    customers: [{ id: 'c1', name: 'بقالة' }],
  });
};

test('المعالج: المثال المحلول بالمتوسّط، والشركة والنطاق والحالة والمدى بتوقيتها في الشرط، ولا لقطات لغير المربوطة', async () => {
  reset();
  const res = await call({ from: '2026-11-01', to: '2026-11-30', groupBy: 'product', salesRepId: 'r1', teamId: 'none', locationId: 'L1' });
  assert.equal(res.statusCode, 200);
  const d = res.body!.data;
  assert.deepEqual([d.summary.netSales, d.summary.cost, d.summary.grossProfit, d.summary.marginPct], [1500, 1000, 500, 33.33]);
  assert.equal(d.taxOff, false);
  assert.equal(d.linked, false);
  assert.deepEqual(res.body!.meta, { appliedRange: { from: '2026-11-01', to: '2026-11-30', defaulted: false }, truncated: false, limit: 20_000 });
  const head = calls.find((c) => c.model === 'invoice')!.args;
  assert.equal(head.take, 20_001, 'السقف وصفٌّ زائد شاهد');
  assert.deepEqual(head.orderBy, [{ invoiceDate: 'desc' }, { id: 'desc' }]);
  const iw = calls.find((c) => c.model === 'invoiceItem')!.args.where;
  assert.deepEqual(iw, { invoiceId: { in: ['s1'] }, invoice: { tenantId: 't1' } }, 'البنود بمعرّفات الفواتير وبالشركة');
  const w = head.where;
  assert.equal(w.tenantId, 't1');
  assert.deepEqual(w.AND, SCOPE.AND, 'نطاق المستخدم بجانب الفلاتر');
  assert.equal(w.status, 'CONFIRMED');
  assert.equal(w.salesRepId, 'r1');
  assert.equal(w.teamId, null);
  assert.equal(w.locationId, 'L1');
  assert.equal(w.invoiceDate.gte.toISOString(), '2026-10-31T21:00:00.000Z');
  assert.equal(w.invoiceDate.lt.toISOString(), '2026-11-30T21:00:00.000Z');
  assert.equal(calls.filter((c) => c.model === 'glCostSnapshot').length, 0, 'غير المربوطة لا تقرأ اللقطات');
  // المتوسّط: تجميعٌ واحد بالشركة حتى نهاية الفترة
  assert.equal(rawCalls.length, 1);
  assert.ok(rawCalls[0].includes('t1'));
  assert.ok((rawCalls[0] as unknown[]).some((v) => v instanceof Date && v.toISOString() === '2026-11-30T21:00:00.000Z'));
  // الأسماء بالشركة شرطاً، ولا قراءة للمناديب والعملاء في تجميع الصنف
  for (const m of ['product', 'productUnit']) assert.equal(calls.find((c) => c.model === m)!.args.where.tenantId, 't1');
  assert.equal(calls.filter((c) => c.model === 'salesRep' || c.model === 'customer').length, 0);
});

test('المعالج: الدفاتر المربوطة تقرأ لقطات فواتير الفترة بالشركة، وبندها المُلقَط لا يدخل المتوسّط', async () => {
  reset();
  state.gl = { timezone: 'Asia/Riyadh', setupMethod: 'LINKED', activatedAt: new Date('2026-01-01') };
  state.snaps = [{ refType: 'INVOICE', refId: 's1', sourceKey: 'COST:INVOICE:i1:OUT', kind: 'VAN_SALE', itemId: 'i1', location: 'VAN:r1', toLocation: null, baseQty: -50, uncostedQty: 0, valueMilli: -1_100_000n, varianceMilli: 0n, memoMilli: 0n }];
  const res = await call({ from: '2026-11-01', to: '2026-11-30', groupBy: 'rep' });
  const d = res.body!.data;
  assert.deepEqual([d.summary.cost, d.summary.grossProfit, d.summary.costSource, d.linked], [1100, 400, 'SNAPSHOT', true]);
  assert.deepEqual(d.rows.map((r: Row) => [r.key, r.name]), [['r1', 'أحمد']]);
  const sw = calls.filter((c) => c.model === 'glCostSnapshot').map((c) => c.args.where);
  assert.ok(sw.every((w) => w.tenantId === 't1'));
  assert.deepEqual(sw[0].refId, { in: ['s1'] });
  assert.equal(rawCalls.length, 0, 'لا متوسّط لبندٍ مُلقَط');
  assert.equal(calls.find((c) => c.model === 'salesRep')!.args.where.tenantId, 't1');
});

test('المعالج: المحاسبة المطفأة ٤٠٣ والمعامل الفاسد ٤٠٠ بلا قراءة بنود، و«إزالة الضريبة» تُعلَن', async () => {
  reset();
  state.tenant = { accountingEnabled: false };
  const off = await call({});
  assert.equal(off.statusCode, 403);
  assert.equal(off.body!.code, 'ACCOUNTING_NOT_ALLOWED');
  assert.equal(calls.filter((c) => c.model === 'invoiceItem' || c.model === 'invoice').length, 0);

  reset();
  for (const q of [{ groupBy: 'channel' }, { salesRepId: ['x'] }, { from: '2026-02-30' }, { from: '2026-11-30', to: '2026-11-01' }]) {
    const r = await call(q);
    assert.equal(r.statusCode, 400, JSON.stringify(q));
    assert.equal(calls.filter((c) => c.model === 'invoiceItem').length, 0);
  }

  reset();
  state.company = { countryCode: 'SA', currency: 'SAR', taxDisabled: true };
  const taxOff = await call({});
  assert.equal(taxOff.body!.data.taxOff, true);
  assert.equal(taxOff.body!.data.groupBy, 'product', 'الافتراضي الصنف');
  assert.equal(taxOff.body!.meta.appliedRange.defaulted, true);
  assert.ok(!JSON.stringify(taxOff.body).includes('tax"'), 'لا حقل ضريبة في الردّ');
});

test('المعالج: الممنوع من تكلفة الشراء (canManageVanStock=false) أو غير النشط ٤٠٣ بلا قراءة — كتقرير المشتريات — وجلسة المالك تمرّ', async () => {
  for (const admin of [{ isActive: true, canManageVanStock: false }, { isActive: false, canManageVanStock: true }, null]) {
    reset();
    state.admin = admin;
    const r = await call({ groupBy: 'product' });
    assert.equal(r.statusCode, 403, JSON.stringify(admin));
    assert.equal(r.body!.success, false);
    assert.equal(r.body!.data, undefined, 'لا تكلفة ولا كمية في الردّ');
    assert.deepEqual(calls.map((c) => c.model), ['admin'], 'لا قراءة قبل الحارس');
  }
  // جلسة مالك المنصة (الانتحال) تمرّ بلا قراءة المستخدم
  reset();
  state.admin = { isActive: true, canManageVanStock: false };
  const owner = await call({ from: '2026-11-01', to: '2026-11-30' }, { id: 'a1', role: 'ADMIN', tenantId: 't1', impersonated: true });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body!.data.summary.cost, 1000);
  assert.equal(calls.filter((c) => c.model === 'admin').length, 0);
  // الافتراضي (canManageVanStock غير مضبوط) مسموح
  reset();
  state.admin = { isActive: true };
  assert.equal((await call({ from: '2026-11-01', to: '2026-11-30' })).statusCode, 200);
});

test('المعالج: الشركة المربوطة — بيعٌ بلا تكلفة معروفة لحظته (لقطة صفرية uncostedQty) يُكمَّل بمتوسّط الشراء فيطابق قائمة الدخل، ولا «بلا تكلفة»', async () => {
  reset();
  // المندوب باع ١٠ بصافٍ ١٥٠ من سيارةٍ بلا رصيد، ثم ورد الصنف بـ١٠ للحبة (الدفاتر تُثبت ١٠٠ فرقاً على تحميل السيارة)
  const s1 = doc('s1', 'CASH', 150, 0, 'r1', 'c1', '2026-11-10T09:00:00Z');
  state.gl = { timezone: 'Asia/Riyadh', setupMethod: 'LINKED', activatedAt: new Date('2026-01-01') };
  state.items = [item('i1', s1, 'pA', 10, 150)];
  state.snaps = [{ refType: 'INVOICE', refId: 's1', sourceKey: 'COST:INVOICE:i1:OUT', kind: 'VAN_SALE', itemId: 'i1', location: 'VAN:r1', toLocation: null, baseQty: -10, uncostedQty: 10, valueMilli: 0n, varianceMilli: 0n, memoMilli: 0n }];
  state.avg = [{ productId: 'pA', value: 1000, base: 100 }];
  const res = await call({ from: '2026-11-01', to: '2026-11-30', groupBy: 'product' });
  const d = res.body!.data;
  assert.deepEqual([d.summary.netSales, d.summary.cost, d.summary.grossProfit, d.summary.marginPct], [150, 100, 50, 33.33]);
  assert.deepEqual([d.rows[0].noCost, d.rows[0].noCostQty, d.summary.noCostProducts], [false, 0, 0]);
  assert.equal(d.summary.costSource, 'MIXED', 'اللقطة ومتوسّطٌ أكملها');
  assert.equal(rawCalls.length, 1, 'الصنف ذو الكمية بلا تكلفة يدخل المتوسّط');
  assert.deepEqual(rawCalls[0][rawCalls[0].length - 1], ['pA']);

  // ولا وارد مسعَّر للصنف: يبقى صفراً بعَلَم «بلا تكلفة» (لا سعر شراء فعلاً)
  reset();
  state.gl = { timezone: 'Asia/Riyadh', setupMethod: 'LINKED', activatedAt: new Date('2026-01-01') };
  state.items = [item('i1', s1, 'pA', 10, 150)];
  state.snaps = [{ refType: 'INVOICE', refId: 's1', sourceKey: 'COST:INVOICE:i1:OUT', kind: 'VAN_SALE', itemId: 'i1', location: 'VAN:r1', toLocation: null, baseQty: -10, uncostedQty: 10, valueMilli: 0n, varianceMilli: 0n, memoMilli: 0n }];
  state.avg = [];
  const none = (await call({ from: '2026-11-01', to: '2026-11-30', groupBy: 'product' })).body!.data;
  assert.deepEqual([none.summary.cost, none.rows[0].noCost, none.rows[0].noCostQty, none.summary.costSource], [0, true, 10, 'SNAPSHOT']);
});

test('المعالج: سقفٌ معلن — أحدث ٢٠٬٠٠٠ فاتورة وبنودها دفعاتٍ بالمعرّفات، وما زاد meta.truncated (و«إلى» وحده كذلك)', async () => {
  reset();
  const N = P.PROFIT_MAX_INVOICES + 3;
  state.items = Array.from({ length: N }, (_, k) => {
    const inv = doc(`s${String(k).padStart(6, '0')}`, 'CASH', 10, 0, 'r1', 'c1', new Date(Date.UTC(2026, 10, 1) + k * 60_000).toISOString());
    return item(`i${k}`, inv, 'pA', 1, 10);
  });
  const res = await call({ to: '2026-11-30' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body!.meta, { appliedRange: { from: null, to: '2026-11-30', defaulted: false }, truncated: true, limit: 20_000 });
  const d = res.body!.data;
  assert.equal(d.summary.invoicesCount, 20_000, 'الأحدث وحده');
  assert.equal(d.summary.netSales, 200_000);
  const head = calls.filter((c) => c.model === 'invoice');
  assert.equal(head.length, 1);
  assert.equal(head[0].args.where.invoiceDate.gte, undefined, '«إلى» وحده بلا حدٍّ أدنى — والسقف يحرسه');
  const itemCalls = calls.filter((c) => c.model === 'invoiceItem');
  assert.equal(itemCalls.length, 10, 'دفعات ٢٬٠٠٠ معرّف');
  assert.ok(itemCalls.every((c) => c.args.where.invoiceId.in.length <= 2000 && c.args.where.invoice.tenantId === 't1'));
  const read = new Set(itemCalls.flatMap((c) => c.args.where.invoiceId.in as string[]));
  assert.equal(read.has('s000000'), false, 'الأقدم خارج');
  assert.equal(read.has(`s${String(N - 1).padStart(6, '0')}`), true, 'الأحدث داخل');
});
