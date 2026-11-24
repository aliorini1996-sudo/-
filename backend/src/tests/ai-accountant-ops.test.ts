// «المحاسب الذكي AI» — أدوات القراءة التشغيلية (حزمة A2): الفترة بتوقيت الشركة، وتحويل الأرقام إلى AiReport، وإخفاء المال
// حين «النظام المحاسبي» مطفأ، ووسم تقدير الربح، وعزل الشركة عن وسائط النموذج. بلا قاعدة ولا شبكة (قراءات محقونة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PERIOD_DAYS, isPeriodError, parsePeriod, type AcctPeriod } from '../services/aiAccountant/period';
import {
  ESTIMATE_NOTE, MONEY_HIDDEN_NOTE, buildOpsTools, collectionsByMethod, collectionsReport, opsToolNames, partyNets, profitEstimateOf,
  profitEstimateReport, purchasesInventoryReport, receivablesReport, salesFigures, salesSummaryReport, stockSummaryOf, topReport,
} from '../services/aiAccountant/opsTools';
import type { AgingJson, OpsDeps, ReceivablesData, SaleItemRow, TypeTotals } from '../services/aiAccountant/opsQueries';
import { acctCtxFrom, type AcctCtx, type AiReport } from '../services/aiAccountant/context';
import { readPaymentMethodsConfig } from '../services/paymentMethodsCore';
import { runAdvisor, type AdvisorTool } from '../ai-rep/advisor';
import type { LlmRequest, LlmResult } from '../ai-rep/llm';
import type { WarehouseRow } from '../services/warehouseStock';

const TZ = 'Asia/Riyadh';
const TODAY = '2026-11-18';

const ctxOf = (o: Partial<AcctCtx> = {}): AcctCtx => ({
  tenantId: 'tenant-A', adminId: 'admin-1', adminName: 'مدير', impersonated: false, tz: TZ, todayLocal: TODAY, currency: 'SAR',
  accountingOn: true, booksMode: 'NONE', booksActivated: false, canViewLedger: false, canPost: false, warehouseOn: true, taxDisabled: false,
  userText: '', clientRef: '00000000-0000-4000-8000-000000000000', reports: [], posted: [], warnings: [], ...o,
});

const ok = (p: ReturnType<typeof parsePeriod>): AcctPeriod => {
  if (isPeriodError(p)) throw new Error(`expected a period, got error: ${p.error}`);
  return p;
};
const iso = (d: Date) => d.toISOString();
const allRows = (r: AiReport) => r.sections.flatMap((s) => s.rows);
const rowOf = (r: AiReport, label: string) => allRows(r).find((x) => x.label === label);

// ───────────── الفترة ─────────────

test('الفترة: «2026-11» شهرٌ كامل بأيام الرياض [١ نوفمبر، ١ ديسمبر)', () => {
  const p = ok(parsePeriod({ month: '2026-11' }, TZ, TODAY));
  assert.equal(p.fromLocal, '2026-11-01');
  assert.equal(p.toLocal, '2026-11-30');
  assert.equal(iso(p.gte), '2026-10-31T21:00:00.000Z');
  assert.equal(iso(p.lt), '2026-11-30T21:00:00.000Z');
});

test('الفترة: «شهر 11» رقماً وحده — والأرقام الهندية — شهر السنة الحالية للشركة', () => {
  for (const m of ['11', '١١', ' 11 ', '2026-١١', '11/2026']) {
    const p = ok(parsePeriod({ month: m }, TZ, TODAY));
    assert.deepEqual([p.fromLocal, p.toLocal], ['2026-11-01', '2026-11-30'], m);
  }
  const feb = ok(parsePeriod({ month: '2' }, TZ, TODAY));
  assert.deepEqual([feb.fromLocal, feb.toLocal], ['2026-02-01', '2026-02-28']);
});

test('الفترة: الشهر بلا سنة لا يقع في المستقبل — «شهر 12» في نوفمبر ويناير = ديسمبر الماضي', () => {
  assert.equal(ok(parsePeriod({ month: '12' }, TZ, TODAY)).fromLocal, '2025-12-01');
  assert.equal(ok(parsePeriod({ month: '12' }, TZ, '2027-01-05')).fromLocal, '2026-12-01');
  // والسنة الصريحة تُحترم ولو مستقبلاً
  assert.equal(ok(parsePeriod({ month: '2026-12' }, TZ, TODAY)).fromLocal, '2026-12-01');
});

test('الفترة: الشهر يغلب from/to إن جاءا معه', () => {
  const p = ok(parsePeriod({ month: '10', from: '2026-01-01', to: '2026-01-31' }, TZ, TODAY));
  assert.deepEqual([p.fromLocal, p.toLocal], ['2026-10-01', '2026-10-31']);
});

test('الفترة: from/to شاملان بحدود منتصف ليل الشركة، وصيغٌ مرنة', () => {
  const p = ok(parsePeriod({ from: '2026-11-01', to: '2026-11-15' }, TZ, TODAY));
  assert.equal(iso(p.gte), '2026-10-31T21:00:00.000Z');
  assert.equal(iso(p.lt), '2026-11-15T21:00:00.000Z');
  const q = ok(parsePeriod({ from: '2026/11/5', to: '٢٠٢٦-١١-٧' }, TZ, TODAY));
  assert.deepEqual([q.fromLocal, q.toLocal], ['2026-11-05', '2026-11-07']);
  // منطقةٌ أخرى: الحدّ منتصف ليلها هي
  const u = ok(parsePeriod({ from: '2026-11-01', to: '2026-11-01' }, 'UTC', TODAY));
  assert.deepEqual([iso(u.gte), iso(u.lt)], ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
});

test('الفترة: «من» وحده حتى اليوم، و«إلى» وحده من أول شهره، ولا شيء = الشهر الحالي حتى اليوم', () => {
  const a = ok(parsePeriod({ from: '2026-10-10' }, TZ, TODAY));
  assert.deepEqual([a.fromLocal, a.toLocal], ['2026-10-10', TODAY]);
  const b = ok(parsePeriod({ to: '2026-09-20' }, TZ, TODAY));
  assert.deepEqual([b.fromLocal, b.toLocal], ['2026-09-01', '2026-09-20']);
  const d = ok(parsePeriod({}, TZ, TODAY));
  assert.deepEqual([d.fromLocal, d.toLocal], ['2026-11-01', TODAY]);
  assert.equal(iso(d.lt), '2026-11-18T21:00:00.000Z');
  // النصّ الفارغ غيابٌ لا خطأ
  assert.deepEqual(ok(parsePeriod({ month: '', from: '', to: '' }, TZ, TODAY)).fromLocal, '2026-11-01');
});

test('الفترة: المدخل الفاسد خطأٌ صريح بالعربية لا «كل الفترات»', () => {
  for (const args of [
    { month: '13' }, { month: '0' }, { month: '2026-00' }, { month: 'نوفمبر' }, { month: '1899-05' },
    { from: '2026-02-30' }, { to: 'أمس' }, { from: '2026-11-10', to: '2026-11-01' },
    { from: '2020-01-01', to: '2026-11-01' },
  ]) {
    const p = parsePeriod(args, TZ, TODAY);
    assert.ok(isPeriodError(p), JSON.stringify(args));
    assert.match(p.error, /[؀-ۿ]/);
  }
  assert.ok(MAX_PERIOD_DAYS >= 366 * 3);
  assert.ok(!isPeriodError(parsePeriod({ from: '2024-01-01', to: '2026-11-18' }, TZ, TODAY)));
});

// ───────────── المبيعات ─────────────

const SALES: TypeTotals[] = [
  { type: 'CASH', total: 1150, taxAmt: 150, discountAmt: 10, count: 4 },
  { type: 'CREDIT', total: 2300, taxAmt: 300, discountAmt: 0, count: 3 },
  { type: 'RETURN', total: 230, taxAmt: 30, discountAmt: 5, count: 1 },
];
const NOV = ok(parsePeriod({ month: '11' }, TZ, TODAY));

test('المبيعات: صافيةٌ من المرتجع، والعدد لفواتير البيع، والنقدي/الآجل، والضريبة صافية', () => {
  const f = salesFigures(SALES);
  assert.deepEqual(
    [f.salesCount, f.salesTotal, f.cashTotal, f.creditTotal, f.returnsCount, f.returnsTotal, f.net, f.netTax, f.netExTax, f.netDiscount],
    [7, 3450, 1150, 2300, 1, 230, 3220, 420, 2800, 5],
  );
});

test('المبيعات ⇒ AiReport: صفوفٌ بمبالغ مقرّبة والأعداد نصّاً، والمرتجع سالب، ومدخل النموذج فيه كل رقم', () => {
  const ctx = ctxOf();
  const out = salesSummaryReport(ctx, NOV, salesFigures(SALES));
  assert.equal(out.report.kind, 'sales');
  assert.deepEqual(out.report.period, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(out.report.currency, 'SAR');
  assert.equal(rowOf(out.report, 'صافي المبيعات')?.amount, 3220);
  assert.equal(rowOf(out.report, 'صافي المبيعات')?.bold, true);
  assert.equal(rowOf(out.report, 'المرتجعات')?.amount, -230);
  assert.equal(rowOf(out.report, 'مبيعات نقدية')?.text, '4 فاتورة');
  assert.equal(rowOf(out.report, 'صافي المبيعات قبل الضريبة')?.amount, 2800);
  const d = out.data as Record<string, unknown>;
  assert.equal(d.net_sales, 3220);
  assert.equal(d.vat_net, 420);
  assert.equal(d.net_sales_before_vat, 2800);
  assert.match(out.summaryAr, /3220 SAR/);
});

test('المبيعات و«إزالة الضريبة»: لا سطر ولا مفتاح ولا ذكر للضريبة', () => {
  const out = salesSummaryReport(ctxOf({ taxDisabled: true }), NOV, salesFigures(SALES));
  const text = JSON.stringify(out.report) + JSON.stringify(out.data);
  assert.doesNotMatch(text, /ضريب|\bVAT\b/i);
  assert.equal(rowOf(out.report, 'صافي المبيعات')?.amount, 3220);
});

test('المبيعات والنظام المحاسبي مطفأ: الأعداد وحدها — لا مبلغ في التقرير ولا في مدخل النموذج', () => {
  const out = salesSummaryReport(ctxOf({ accountingOn: false }), NOV, salesFigures(SALES));
  assert.ok(allRows(out.report).every((r) => r.amount === null));
  assert.ok(out.report.notes.includes(MONEY_HIDDEN_NOTE));
  const text = JSON.stringify(out.data) + out.summaryAr + JSON.stringify(out.report);
  for (const money of ['3220', '1150', '2300', '230', '420']) assert.ok(!text.includes(money), money);
  assert.equal((out.data as { sales_invoices: number }).sales_invoices, 7);
});

// ───────────── التحصيل ─────────────

const METHODS_CONFIG = readPaymentMethodsConfig({
  version: 1,
  builtins: { POS: { label: 'مدى', active: true } },
  custom: [{ key: 'c_stcpay', label: 'STC Pay', base: 'BANK_TRANSFER', icon: 'wallet', active: true }],
});

test('التحصيل: الطرق بأسماء الشركة والمخصّصة جدولٌ مستقل، والعدد من التجميع لا من عدد الصفوف', () => {
  const methods = collectionsByMethod([
    { paymentMethod: 'CASH', paymentMethodKey: null, amount: 500, count: 5 },
    { paymentMethod: 'POS', paymentMethodKey: null, amount: 300.5, count: 2 },
    { paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_stcpay', amount: 200, count: 3 },
    { paymentMethod: 'BANK_TRANSFER', paymentMethodKey: null, amount: 100, count: 1 },
  ], METHODS_CONFIG);
  assert.deepEqual(methods.map((m) => [m.label, m.amount, m.count]), [
    ['نقدي', 500, 5], ['مدى', 300.5, 2], ['تحويل بنكي', 100, 1], ['STC Pay', 200, 3],
  ]);
  const out = collectionsReport(ctxOf(), NOV, methods, { amount: 1150, count: 4 });
  assert.equal(rowOf(out.report, 'إجمالي سندات القبض')?.amount, 1100.5);
  assert.equal(rowOf(out.report, 'إجمالي سندات القبض')?.text, '11 سند');
  assert.equal(rowOf(out.report, 'إجمالي المحصَّل')?.amount, 2250.5);
  assert.equal((out.data as { total_collected: number }).total_collected, 2250.5);
  const hidden = collectionsReport(ctxOf({ accountingOn: false }), NOV, methods, { amount: 1150, count: 4 });
  assert.ok(allRows(hidden.report).every((r) => r.amount === null));
  assert.ok(!JSON.stringify(hidden.data).includes('1150'));
});

// ───────────── ذمم العملاء ─────────────

const RECV: ReceivablesData = {
  debit: { total: 15000.456, count: 12 },
  credit: { total: 300, count: 2 },
  exceededCount: 3,
  top: [{ name: 'بقالة النور', balance: 5000, creditLimit: 4000, paymentDays: 30, status: 'BLOCKED' }, { name: 'تموينات الخير', balance: 2500, creditLimit: 0, paymentDays: 30, status: 'ACTIVE' }],
};

test('ذمم العملاء: كما في اليوم بلا فترة، والمحظور موسوم، والمبالغ بخانتي الريال', () => {
  const out = receivablesReport(ctxOf(), RECV);
  assert.equal(out.report.kind, 'receivables');
  assert.equal(out.report.period, null);
  assert.match(out.report.title, /2026-11-18/);
  assert.equal(rowOf(out.report, 'إجمالي مديونية العملاء')?.amount, 15000.46);
  assert.equal(rowOf(out.report, 'بقالة النور')?.text, 'محظور');
  assert.equal(rowOf(out.report, 'تموينات الخير')?.text, undefined);
  const hidden = receivablesReport(ctxOf({ accountingOn: false }), RECV);
  assert.ok(!JSON.stringify(hidden).includes('15000'));
  assert.ok(!JSON.stringify(hidden).includes('بقالة النور'));
});

// ───────────── المشتريات والمخزون ─────────────

const wh = (name: string, onHand: number, stockValue: number, uncostedQty = 0): WarehouseRow => ({
  productId: name, name, code: name, unit: 'حبة', received: onHand, adjusted: 0, loadedToVans: 0, returnedFromVans: 0, onHand,
  avgCost: onHand ? stockValue / onHand : 0, stockValue, costedQty: onHand - uncostedQty, uncostedQty,
});
const AGING: AgingJson = {
  asOf: '2026-11-18',
  rows: [
    { supplierId: 'v1', name: 'مورد أ', code: null, isActive: true, current: 1000, d1_30: 500, d31_60: 0, d61_90: 0, d90_plus: 250, total: 1750, balance: 1800, unapplied: 50, openBillsCount: 3 },
    { supplierId: 'v2', name: 'مورد ب', code: null, isActive: true, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0, balance: -20, unapplied: -20, openBillsCount: 0 },
  ],
  totals: { current: 1000, d1_30: 500, d31_60: 0, d61_90: 0, d90_plus: 250, total: 1750, balance: 1780, unapplied: 30 },
};

test('المشتريات والمخزون: الوارد صافٍ بلا الافتتاحي، وقيمة المستودع، والمستحق والمتأخر للموردين', () => {
  const st = stockSummaryOf([wh('أ', 10, 100), wh('ب', 5, 0, 5), wh('ج', -2, 0)]);
  assert.deepEqual([st.value, st.productsInStock, st.uncostedProducts, st.negativeProducts], [100, 2, 1, 1]);
  const out = purchasesInventoryReport(ctxOf(), NOV, {
    purchases: [
      { type: 'RECEIVE', status: 'POSTED', source: null, returnOfSource: null, value: 1000, entries: 2 },
      { type: 'RETURN', status: 'POSTED', source: null, returnOfSource: null, value: -100, entries: 1 },
      { type: 'RECEIVE', status: 'POSTED', source: 'OPENING_IMPORT', returnOfSource: null, value: 99999, entries: 1 },
    ],
    supplierPayments: { amount: 400, count: 2 },
    stock: [wh('أ', 10, 100), wh('ب', 5, 0, 5)],
    asOfLocal: TODAY,
    aging: AGING,
  });
  assert.equal(rowOf(out.report, 'صافي المشتريات (قبل الضريبة)')?.amount, 900);
  assert.equal(rowOf(out.report, 'صافي المشتريات (قبل الضريبة)')?.text, '2 حركة وارد');
  assert.equal(rowOf(out.report, 'المدفوع للموردين')?.amount, 400);
  assert.equal(rowOf(out.report, 'قيمة المخزون بتكلفة الشراء')?.amount, 100);
  assert.equal(rowOf(out.report, 'المستحق للموردين')?.amount, 1780);
  assert.equal(rowOf(out.report, 'منها متأخرة السداد')?.amount, 750);
  assert.equal(rowOf(out.report, 'مورد أ')?.amount, 1800);
  assert.equal(rowOf(out.report, 'مورد ب'), undefined); // رصيدٌ دائن للشركة ليس «مستحقاً للمورد»
  assert.ok(out.report.notes.some((n) => n.includes('سيارات المناديب')));
  assert.equal(out.report.sections[1].title, 'مخزون المستودع كما في 2026-11-18');
});

// ───────────── الأعلى مبيعاً ─────────────

test('الأعلى مبيعاً: صافي العميل بالمرتجع والعدد للبيع وحده، والترتيب بالمبلغ أو بالعدد حين يُخفى', () => {
  const nets = partyNets([
    { id: 'c1', type: 'CREDIT', total: 1000, count: 2 },
    { id: 'c1', type: 'RETURN', total: 300, count: 1 },
    { id: 'c2', type: 'CASH', total: 800, count: 5 },
    { id: null, type: 'CASH', total: 50, count: 1 },
  ]);
  assert.deepEqual(nets.map((x) => [x.id, x.total, x.count]), [['c1', 700, 2], ['c2', 800, 5]]);
  const customers = nets.map((x) => ({ ...x, name: x.id === 'c1' ? 'عميل ١' : 'عميل ٢' }));
  const products = [
    { productId: 'p1', name: 'مياه', code: 'W', qty: 100, baseQty: 100, unit: 'حبة', units: [], primaryUnitId: null, total: 300 },
    { productId: 'p2', name: 'عصير', code: 'J', qty: 10, baseQty: 10, unit: 'حبة', units: [], primaryUnitId: null, total: 900 },
  ];
  const reps = [{ id: 'r1', name: 'أحمد', salesTotal: 1500, invoicesCount: 3 }, { id: 'r2', name: 'سالم', salesTotal: 200, invoicesCount: 9 }];
  const out = topReport(ctxOf(), NOV, { customers, products, reps }, 5);
  assert.deepEqual(out.report.sections.map((s) => s.rows[0].label), ['عميل ٢', 'عصير', 'أحمد']);
  const hidden = topReport(ctxOf({ accountingOn: false }), NOV, { customers, products, reps }, 5);
  assert.deepEqual(hidden.report.sections.map((s) => s.rows[0].label), ['عميل ٢', 'مياه', 'سالم']);
  assert.ok(allRows(hidden.report).every((r) => r.amount === null));
  const noProducts = topReport(ctxOf(), NOV, { customers, products: null, reps }, 5);
  assert.equal(noProducts.report.sections.length, 2);
  assert.ok(noProducts.report.notes.some((n) => n.includes('قلّصها')));
});

// ───────────── تقدير الربح ─────────────

test('تقدير الربح: صافي المبيعات قبل الضريبة − الكمية × متوسّط التكلفة، والصنف بلا تكلفة معلَن، وموسومٌ «تقديري»', () => {
  const f = salesFigures(SALES); // صافٍ قبل الضريبة 2800
  const products = [
    { productId: 'p1', name: 'مياه', code: 'W', qty: 100, baseQty: 100, unit: 'حبة', units: [], primaryUnitId: null, total: 2000 },
    { productId: 'p2', name: 'عصير', code: 'J', qty: 10, baseQty: 10, unit: 'حبة', units: [], primaryUnitId: null, total: 1220 },
    { productId: null, name: 'صنف محذوف', code: '—', qty: 1, baseQty: 1, unit: '', units: [], primaryUnitId: null, total: 0 },
  ];
  const e = profitEstimateOf(f, products, new Map([['p1', 12.5], ['p2', 0]]));
  assert.equal(e.revenue, 2800);
  assert.equal(e.cogs, 1250);
  assert.equal(e.grossProfit, 1550);
  assert.equal(e.marginPct, 55.4);
  assert.equal(e.uncostedProducts, 2);
  assert.equal(e.uncostedSales, 1220);
  assert.equal(e.coveragePct, 62.1);
  const out = profitEstimateReport(ctxOf(), NOV, f, e);
  assert.equal(out.report.kind, 'profit-estimate');
  assert.equal(out.report.estimated, true);
  assert.equal(out.report.notes[0], ESTIMATE_NOTE);
  assert.ok(out.report.notes.some((n) => n.includes('أعلى من حقيقته')));
  assert.equal(rowOf(out.report, 'الربح الإجمالي التقديري')?.amount, 1550);
  assert.equal(rowOf(out.report, 'هامش الربح الإجمالي')?.text, '55.4%');
  const d = out.data as Record<string, unknown>;
  assert.equal(d.estimated, true);
  assert.equal(d.label, ESTIMATE_NOTE);
  assert.match(out.summaryAr, /^تقديري/);
});

test('تقدير الربح بلا أي تكلفة معروفة: لا ربح يُختلق — «غير متاح»؛ وفترةٌ بلا بيع ربحها صفر', () => {
  const f = salesFigures(SALES);
  const products = [{ productId: 'p1', name: 'مياه', code: 'W', qty: 1, baseQty: 1, unit: 'حبة', units: [], primaryUnitId: null, total: 100 }];
  const e = profitEstimateOf(f, products, new Map());
  assert.equal(e.cogs, null);
  assert.equal(e.grossProfit, null);
  const out = profitEstimateReport(ctxOf({ warehouseOn: false }), NOV, f, e);
  assert.equal(rowOf(out.report, 'الربح الإجمالي التقديري')?.amount, null);
  assert.ok(out.report.notes.some((n) => n.includes('مخزون الشركة غير مفعّل')));
  const empty = profitEstimateOf(salesFigures([]), [], new Map());
  assert.deepEqual([empty.cogs, empty.grossProfit, empty.marginPct], [0, 0, null]);
});

test('تقدير الربح و«إزالة الضريبة»: الإيراد سطرٌ واحد بلا ذكر للضريبة', () => {
  const f = salesFigures(SALES);
  const out = profitEstimateReport(ctxOf({ taxDisabled: true }), NOV, f, profitEstimateOf(f, [], new Map()));
  assert.doesNotMatch(JSON.stringify(out.report) + JSON.stringify(out.data), /ضريب|\bVAT\b/i);
});

// ───────────── الأدوات بقراءاتٍ محقونة ─────────────

interface Calls { [k: string]: unknown[][] }
function fakeDeps(over: Partial<OpsDeps> = {}): { deps: OpsDeps; calls: Calls } {
  const calls: Calls = {};
  const rec = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...a: A): R => { (calls[name] ??= []).push(a); return fn(...a); };
  const items: { sales: SaleItemRow[]; returns: SaleItemRow[] } = {
    sales: [{ qty: 2, unitFactor: 12, unitName: 'كرتون', baseQty: 24, lineTotal: 240, product: { id: 'p1', name: 'مياه', code: 'W', unit: 'حبة' } }],
    returns: [{ qty: 4, baseQty: 4, lineTotal: 40, product: { id: 'p1', name: 'مياه', code: 'W', unit: 'حبة' } }],
  };
  const base: OpsDeps = {
    salesByType: async () => SALES,
    receiptsByMethod: async () => [{ paymentMethod: 'CASH', paymentMethodKey: null, amount: 700, count: 3 }],
    cashSalesCollected: async () => ({ amount: 1150, count: 4 }),
    paymentMethodsConfig: async () => null,
    purchases: async () => [{ type: 'RECEIVE', status: 'POSTED', source: null, returnOfSource: null, value: 500, entries: 1 }],
    supplierPayments: async () => ({ amount: 0, count: 0 }),
    currencyDecimals: async () => 2,
    warehouseAsOf: async () => new Date('2026-11-01T00:00:00Z'),
    warehouseStock: async () => [wh('مياه', 10, 50)],
    supplierAging: async () => AGING,
    receivables: async () => RECV,
    customerGroups: async () => [{ id: 'c1', type: 'CASH', total: 500, count: 2 }],
    customerNames: async (_t, ids) => new Map(ids.map((id) => [id, `عميل ${id}`])),
    repGroups: async () => [{ salesRepId: 'r1', type: 'CASH', _sum: { total: 500 }, _count: { _all: 2 } }],
    activeReps: async () => [{ id: 'r1', name: 'أحمد' }],
    saleItems: async () => items,
    avgCosts: async () => new Map([['p1', 5]]),
  };
  const merged = { ...base, ...over } as OpsDeps;
  const deps = Object.fromEntries(Object.entries(merged).map(([k, fn]) => [k, rec(k, fn as (...a: unknown[]) => unknown)])) as unknown as OpsDeps;
  return { deps, calls };
}
const byName = (tools: AdvisorTool[], name: string): AdvisorTool => {
  const t = tools.find((x) => x.spec.function.name === name);
  assert.ok(t, `tool ${name}`);
  return t;
};

test('الأدوات حسب السياق: المستودع يضيف المشتريات، والدفاتر المفعّلة أو المحاسبة المطفأة تُسقط تقدير الربح', () => {
  assert.deepEqual(opsToolNames(ctxOf()), ['sales_summary', 'collections_summary', 'purchases_inventory', 'receivables', 'top_customers_products', 'profit_estimate']);
  assert.deepEqual(opsToolNames(ctxOf({ warehouseOn: false, booksActivated: true })), ['sales_summary', 'collections_summary', 'receivables', 'top_customers_products']);
  assert.ok(!opsToolNames(ctxOf({ accountingOn: false })).includes('profit_estimate'));
  for (const t of buildOpsTools(ctxOf())) {
    assert.equal(t.spec.type, 'function');
    assert.equal((t.spec.function.parameters as { additionalProperties: boolean }).additionalProperties, false);
  }
});

test('عزل الشركة: tenantId في وسائط النموذج لا يُقرأ — الاستعلام بشركة الجلسة وحدها، والحدود من الفترة', async () => {
  const ctx = ctxOf();
  const { deps, calls } = fakeDeps();
  const out = await byName(buildOpsTools(ctx, deps), 'sales_summary').run({ month: '11', tenantId: 'tenant-EVIL', tenant_id: 'tenant-EVIL' });
  assert.ok(!('error' in out));
  assert.equal(calls.salesByType.length, 1);
  const [tid, gte, lt] = calls.salesByType[0] as [string, Date, Date];
  assert.equal(tid, 'tenant-A');
  assert.equal(iso(gte), '2026-10-31T21:00:00.000Z');
  assert.equal(iso(lt), '2026-11-30T21:00:00.000Z');
  assert.equal(ctx.reports.length, 1);
  assert.equal(ctx.reports[0].kind, 'sales');
});

test('الأدوات: فترةٌ فاسدة أو قاعدةٌ متعثّرة ⇒ {error} بلا تقرير ولا نصّ الخطأ الداخلي', async () => {
  const ctx = ctxOf();
  const bad = await byName(buildOpsTools(ctx, fakeDeps().deps), 'collections_summary').run({ month: '13' });
  assert.ok('error' in bad);
  const { deps } = fakeDeps({ receivables: async () => { throw new Error('connection refused at 10.0.0.5'); } });
  const origError = console.error;
  console.error = () => {};
  try {
    const failed = await byName(buildOpsTools(ctx, deps), 'receivables').run({});
    assert.ok('error' in failed);
    assert.doesNotMatch(failed.error, /10\.0\.0\.5|connection/);
  } finally {
    console.error = origError;
  }
  assert.equal(ctx.reports.length, 0);
});

test('الأدوات: الشهر رقماً (11) والحدّ نصّاً مقبولان', async () => {
  const ctx = ctxOf();
  const { deps, calls } = fakeDeps();
  const out = await byName(buildOpsTools(ctx, deps), 'top_customers_products').run({ month: 11, limit: '3' });
  assert.ok(!('error' in out));
  assert.equal(iso((calls.customerGroups[0] as [string, Date])[1]), '2026-10-31T21:00:00.000Z');
  assert.equal(ctx.reports[0].kind, 'top');
  // الصنف: كرتونان (24 حبة) ناقص 4 حبات مرتجعة = 20 حبة بالأساس
  const products = ctx.reports[0].sections.find((s) => s.title === 'أعلى الأصناف')!;
  assert.deepEqual([products.rows[0].label, products.rows[0].text, products.rows[0].amount], ['مياه', '20 حبة', 200]);
  const bad = await byName(buildOpsTools(ctx, deps), 'top_customers_products').run({ limit: 50 });
  assert.ok('error' in bad);
});

test('المشتريات والمخزون: فترةٌ مضت تُقيَّم كما في نهايتها، والجارية بالرصيد الحالي', async () => {
  const past = fakeDeps();
  await byName(buildOpsTools(ctxOf(), past.deps), 'purchases_inventory').run({ month: '2026-10' });
  assert.deepEqual(past.calls.warehouseAsOf?.[0], ['tenant-A', '2026-10-31']);
  assert.ok(past.calls.warehouseStock[0][2] instanceof Date);
  assert.deepEqual(past.calls.supplierAging[0], ['tenant-A', '2026-10-31']);
  assert.deepEqual(past.calls.supplierPayments[0], ['tenant-A', '2026-10-01', '2026-10-31']);
  const now = fakeDeps();
  await byName(buildOpsTools(ctxOf(), now.deps), 'purchases_inventory').run({});
  assert.equal(now.calls.warehouseAsOf, undefined);
  assert.equal(now.calls.warehouseStock[0][2], undefined);
  assert.deepEqual(now.calls.supplierAging[0], ['tenant-A', TODAY]);
});

test('تقدير الربح بالأداة: الكمية الصافية × متوسّط التكلفة، وبلا مستودع لا يُستعلم عن التكلفة، والفترة الضخمة مرفوضة', async () => {
  const ctx = ctxOf();
  const { deps } = fakeDeps();
  const out = await byName(buildOpsTools(ctx, deps), 'profit_estimate').run({ month: '11' });
  assert.ok(!('error' in out));
  const d = out.data as Record<string, unknown>;
  assert.equal(d.estimated_cost_of_goods_sold, 100); // 20 حبة × 5
  assert.equal(d.estimated_gross_profit, 2700); // 2800 − 100
  assert.equal(ctx.reports[0].estimated, true);
  const noWh = fakeDeps();
  await byName(buildOpsTools(ctxOf({ warehouseOn: false }), noWh.deps), 'profit_estimate').run({});
  assert.equal(noWh.calls.avgCosts, undefined);
  const big = fakeDeps({ saleItems: async () => null });
  const r = await byName(buildOpsTools(ctxOf(), big.deps), 'profit_estimate').run({});
  assert.ok('error' in r);
});

test('صلاحية المخزون: مستخدمٌ يرى التقارير بلا «إدارة المخزون» لا يرى المشتريات والمخزون ولا تكاليف الأصناف (كحارس /api/warehouse)', async () => {
  const user = { id: 'admin-2', role: 'MANAGER', tenantId: 'tenant-A', name: 'منى' };
  const rows = (canManageVanStock: boolean | null) => ({
    tenant: { accountingEnabled: true, accountingSuiteEnabled: false, warehouseEnabled: true },
    admin: { name: 'منى', isActive: true, tenantId: 'tenant-A', role: 'MANAGER', canManageCompanyUsers: false, scopeEnabled: false, canManageVanStock },
    company: { name: 'شركة', currency: 'SAR', countryCode: 'SA', taxDisabled: false },
    gl: null,
  });
  const input = { userMessages: ['كم الربح هذا الشهر'], clientRef: 'c1', now: new Date('2026-11-18T09:00:00Z') };
  const denied = acctCtxFrom(user, rows(false), input);
  assert.equal(denied.warehouseOn, false);
  assert.ok(!opsToolNames(denied).includes('purchases_inventory'), 'لا أداة المشتريات والمخزون');
  const { deps, calls } = fakeDeps();
  const out = await byName(buildOpsTools(denied, deps), 'profit_estimate').run({ month: '11' });
  assert.ok(!('error' in out));
  assert.equal(calls.avgCosts, undefined, 'لا تُقرأ تكاليف المستودع');
  assert.equal(calls.currencyDecimals, undefined);
  const allowed = acctCtxFrom(user, rows(true), input);
  assert.ok(opsToolNames(allowed).includes('purchases_inventory'));
  const owner = acctCtxFrom({ ...user, impersonated: true }, rows(false), input);
  assert.ok(opsToolNames(owner).includes('purchases_inventory'), 'جلسة المالك تمرّ');
});

test('حلقة المستشار: أرقام الأداة تمرّ بحارس الأرقام كما هي، والتقرير يُدفع للسياق', async () => {
  const ctx = ctxOf();
  const tools = Object.fromEntries(buildOpsTools(ctx, fakeDeps().deps).map((t) => [t.spec.function.name, t]));
  const U = { promptTokens: 10, completionTokens: 5, cachedTokens: 0 };
  const steps: LlmResult[] = [
    { ok: true, content: '', toolCalls: [{ id: 'c1', name: 'sales_summary', arguments: JSON.stringify({ month: '11' }) }], usage: U, finishReason: 'tool_calls' },
    { ok: true, content: 'صافي مبيعات شهر 11 هو 3220 ريال من 7 فواتير، والمرتجع 230.', toolCalls: [], usage: U, finishReason: 'stop' },
  ];
  const res = await runAdvisor({
    system: 'محاسب', history: [{ role: 'user', text: 'كم مبيعات شهر 11؟' }], baseAllowed: new Set<number>(), tools,
    llm: async (_r: LlmRequest) => steps.shift()!,
  });
  assert.ok(!('error' in res));
  if ('error' in res) return;
  assert.equal(res.guard, 'PASS');
  assert.deepEqual(res.toolNames, ['sales_summary']);
  assert.equal(ctx.reports.length, 1);
});
