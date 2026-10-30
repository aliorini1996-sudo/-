// «إجمالي المبيعات» صافٍ من المرتجع (طلب المالك ٢٩ أكتوبر ٢٠٢٦: «في حال إصدار فاتورة إرجاع سواء من تطبيق المندوب أو من
// الإدارة فإن الفاتورة المرتجعة تنخصم من إجمالي المبيعات خلال تلك الفترة»).
//
// المساعد صرفاً، ثم المسارات الحقيقية — لوحة التحكم ومنحناها وتقرير المبيعات بتجميعاته وملخّصه — على Prisma مزيّف فيه بيعٌ
// ومرتجع: المرتجع يُطرح من المبلغ ولا يُعدّ فاتورة. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cleanMoney, isReturnInvoice, netOfInvoices, netSales, signedAmount } from '../services/netSales';

test('المساعد: الإشارة والطرح وضجيج الفاصلة و‎-0 وnull', () => {
  assert.equal(isReturnInvoice({ type: 'RETURN' }), true);
  assert.equal(isReturnInvoice({ type: 'CREDIT' }), false); // الإشعار المدين يُخزَّن CREDIT فيُجمع بيعاً
  assert.equal(signedAmount({ type: 'RETURN' }, 40), -40);
  assert.equal(signedAmount({ type: 'CASH' }, '12.5'), 12.5);
  assert.equal(netSales(1000, 250), 750);
  assert.equal(netSales(null, null), 0);
  assert.equal(netSales(100, null), 100);
  assert.equal(netSales(0.3, 0.1), 0.2); // لا 0.19999999999999998
  assert.equal(Object.is(cleanMoney(-1e-12), 0), true, '‎-0 صفرٌ موجب');
  assert.equal(netSales(50, 80), -30, 'يومٌ مرتجعه أكبر من بيعه سالبٌ صادق');
  assert.deepEqual(netOfInvoices([{ type: 'CREDIT', total: 100 }, { type: 'CASH', total: 50 }, { type: 'RETURN', total: 30 }]),
    { salesTotal: 120, invoicesCount: 2 });
});

// —— Prisma مزيّف: فاتورتا بيع ومرتجعٌ واحد لمندوبَين وعميلَين ——
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const today = new Date();
const prod = (id: string) => ({ id, name: `صنف ${id}`, code: id, unit: 'حبة' });
const DOCS: Row[] = [
  { id: 's1', type: 'CREDIT', status: 'CONFIRMED', total: 1000, taxAmt: 130.43, discountAmt: 20, invoiceDate: today, createdAt: today,
    salesRepId: 'r1', salesRep: { id: 'r1', name: 'أحمد' }, customer: { id: 'c1', name: 'بقالة', channel: 'TT', city: 'الرياض' }, team: null,
    items: [{ qty: 10, lineTotal: 600, product: prod('p1') }, { qty: 4, lineTotal: 400, product: prod('p2') }] },
  { id: 's2', type: 'CASH', status: 'CONFIRMED', total: 500, taxAmt: 65.22, discountAmt: 0, invoiceDate: today, createdAt: today,
    salesRepId: 'r2', salesRep: { id: 'r2', name: 'خالد' }, customer: { id: 'c2', name: 'تموينات', channel: 'MT', city: 'جدة' }, team: null,
    items: [{ qty: 5, lineTotal: 500, product: prod('p1') }] },
  // مرتجع من فاتورة أحمد: صنف p1 بثلاث وحدات (١٨٠)
  { id: 'ret1', type: 'RETURN', status: 'CONFIRMED', total: 180, taxAmt: 23.48, discountAmt: 0, invoiceDate: today, createdAt: today,
    salesRepId: 'r1', salesRep: { id: 'r1', name: 'أحمد' }, customer: { id: 'c1', name: 'بقالة', channel: 'TT', city: 'الرياض' }, team: null,
    items: [{ qty: 3, lineTotal: 180, product: prod('p1') }] },
];
/** مرشّح النوع كما يكتبه المسار: 'RETURN' أو { not: 'RETURN' } أو غائب */
const byType = (where: Row | undefined) => DOCS.filter((d) => {
  const t = where?.type;
  if (t === undefined) return true;
  if (typeof t === 'string') return d.type === t;
  return t.not !== undefined ? d.type !== t.not : true;
}).filter((d) => d.status === (where?.status ?? d.status));
const sum = (rows: Row[], f: string) => rows.reduce((s, r) => s + Number(r[f]), 0);
const empty = { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0, aggregate: async () => ({ _sum: {}, _count: {} }) };
const db = new Proxy({
  invoice: {
    async findMany(a: Row) { return byType(a.where); },
    async aggregate(a: Row) { const rows = byType(a.where); return { _sum: { total: sum(rows, 'total') }, _count: { id: rows.length } }; },
  },
  receipt: { async aggregate() { return { _sum: { amount: 0 }, _count: { id: 0 } }; } },
  // prisma.customer.fields.creditLimit: مقارنة عمودين في عدّ «تجاوز حدّ الائتمان»
  customer: { fields: { creditLimit: 'creditLimit' }, async count() { return 0; }, async findMany() { return []; } },
  salesRep: {
    async findMany(a: Row) {
      const iw = a.select?.invoices?.where;
      return ['r1', 'r2'].map((id) => ({ id, name: id, invoices: byType(iw).filter((d) => d.salesRepId === id) }));
    },
  },
  tenant: { async findUnique() { return { accountingEnabled: true, warehouseEnabled: false }; } },
} as Row, { get: (t, k: string) => (k in t ? t[k] : k === 'then' ? undefined : empty) });
stub('config/database', { default: db });
stub('services/adminScope', {
  scopedRecordWhere: async () => ({}), scopedRepRecordWhere: async () => ({}), adminCustomerFilter: async () => ({}), adminRepFilter: async () => ({}),
  SHAPE_INVOICE_RECEIPT: {}, SHAPE_VISIT: {},
});

/* eslint-disable @typescript-eslint/no-var-requires */
const dashboard = require('../routes/dashboard').default;
const reports = require('../routes/reports').default;
/* eslint-enable @typescript-eslint/no-var-requires */

/** معالج المسار الأخير وحده — المصادقة والصلاحية لهما اختباراتهما */
async function run(router: unknown, routePath: string, query: Row = {}) {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  assert.ok(layer, `GET ${routePath} غير موجود`);
  const handler = layer.route.stack.slice(-1)[0].handle;
  let body: Row | null = null;
  const res = { status() { return this; }, json(b: Row) { body = b; return this; } };
  let err: unknown = null;
  await handler({ query, params: {}, user: { id: 'a1', role: 'ADMIN', tenantId: 't1' } }, res, (e: unknown) => { err = e; });
  if (err) throw err;
  return body!.data;
}

test('لوحة التحكم: مبيعات اليوم والشهر صافية، والعدد فواتير البيع، وأفضل المناديب بصافيهم', async () => {
  const d = await run(dashboard, '/');
  assert.equal(d.today.salesTotal, 1320); // ١٥٠٠ − ١٨٠
  assert.equal(d.today.invoicesCount, 2);
  assert.equal(d.month.salesTotal, 1320);
  assert.equal(d.month.invoicesCount, 2);
  assert.deepEqual(d.topReps.map((r: Row) => [r.id, r.salesTotal, r.invoicesCount]), [['r1', 820, 1], ['r2', 500, 1]]);
});

test('منحنى المبيعات: المرتجع يُطرح من يومه', async () => {
  const d = await run(dashboard, '/sales-trend');
  assert.equal(d.length, 1);
  assert.equal(d[0].total, 1320);
});

test('تقرير المبيعات: كل تجميعٍ صافٍ والعدد للبيع وحده، والملخّص صافٍ ومعه المرتجع', async () => {
  const byRep = await run(reports, '/sales', { groupBy: 'rep' });
  assert.deepEqual(byRep.map((r: Row) => [r.name, r.total, r.count]), [['أحمد', 820, 1], ['خالد', 500, 1]]);
  const byCustomer = await run(reports, '/sales', { groupBy: 'customer' });
  assert.deepEqual(byCustomer.map((r: Row) => [r.name, r.total, r.count]), [['بقالة', 820, 1], ['تموينات', 500, 1]]);
  const byRegion = await run(reports, '/sales', { groupBy: 'region' });
  assert.deepEqual(byRegion.map((r: Row) => [r.name, r.total]), [['الرياض', 820], ['جدة', 500]]);
  const byChannel = await run(reports, '/sales', { groupBy: 'channel' });
  assert.deepEqual(byChannel.map((r: Row) => [r.name, r.total]), [['TT', 820], ['MT', 500]]);
  // الصنف: الكمية والمبلغ صافيان (p1: ١٥ مباعة − ٣ مرتجعة)
  const byProduct = await run(reports, '/sales', { groupBy: 'product' });
  assert.deepEqual(byProduct.map((r: Row) => [r.code, r.qty, r.total]), [['p1', 12, 920], ['p2', 4, 400]]);

  const plain = await run(reports, '/sales', {});
  assert.equal(plain.summary.total, 1320);
  assert.equal(plain.summary.count, 2);
  assert.equal(plain.summary.taxTotal, 172.17); // ١٩٥٫٦٥ − ٢٣٫٤٨
  assert.equal(plain.summary.discountTotal, 20);
  assert.equal(plain.summary.returnsTotal, 180);
  assert.equal(plain.summary.returnsCount, 1);
  assert.deepEqual(plain.invoices.map((i: Row) => i.id), ['s1', 's2'], 'قائمة الفواتير فواتير بيع بلا مرتجع');
});

test('تقرير المرتجع لم يتغيّر: نسبته على المبيعات الإجمالية (١٨٠ ÷ ١٥٠٠ = ١٢٪)', async () => {
  const r = await run(reports, '/returns', {});
  assert.equal(r.summary.salesTotal, 1500);
  assert.equal(r.summary.returnRate, 12);
});
