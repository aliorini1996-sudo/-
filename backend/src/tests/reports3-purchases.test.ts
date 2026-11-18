// «تقرير المشتريات» (services/reports/purchasesReport.ts) — الحساب الصرف، والقراءة على قاعدةٍ مزيّفة في الذاكرة بدلالة where في Prisma
// (matchWhere من مزيّف الموردين)، والمعالج بحرّاسه ومعاملاته. التسوية (المدفوع والمتبقّي) من loadBillSettlements الحقيقية. لا قاعدة ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { matchWhere } from './b3a-supplier-fake';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ═══ قاعدة مزيّفة: جداول صفوف، والعلاقات (vendor/items) مخزّنةٌ في الصفّ بشكلها المُختار ═══

const TID = 't1';
const tables: Record<string, Row[]> = {};
const T = (name: string): Row[] => (tables[name] ??= []);
const calls: string[] = [];

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? a[k].getTime() : a[k];
      const y = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
const project = (r: Row, select: Row | undefined): Row => {
  if (!select) return { ...r };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = r[k];
  return out;
};
const delegate = (name: string) => ({
  async findMany(a: Row = {}) {
    calls.push(`${name}.findMany`);
    let rows = sortRows(T(name).filter((r) => matchWhere(r, a.where)), a.orderBy);
    if (a.take) rows = rows.slice(0, a.take);
    return rows.map((r) => project(r, a.select));
  },
  async findUnique(a: Row = {}) {
    calls.push(`${name}.findUnique`);
    const r = T(name).find((x) => matchWhere(x, a.where));
    return r ? project(r, a.select) : null;
  },
  async findFirst(a: Row = {}) { return this.findUnique(a); },
});
const db = new Proxy({} as Row, { get: (_t, k: string) => (k === 'then' ? undefined : delegate(k)) });
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../services/reports/purchasesReport') as typeof import('../services/reports/purchasesReport');
const { buildPurchasesReport, loadPurchasesReport, purchasesRange, purchasesReportHandler, splitMilli, entryDay } = mod;

// ═══ البذور ═══

const M = (x: number): bigint => BigInt(Math.round(x * 1000));
let seq = 0;
interface Line { productId: string; qty: number; unitCost: number | null; taxPct?: number; unitFactor?: number; baseQty?: number | null; name?: string }
function entry(type: 'RECEIVE' | 'RETURN' | 'ADJUST', lines: Line[], o: Row = {}): Row {
  const id = o.id ?? `we-${++seq}`;
  const vendorName = o.vendorName as string | undefined;
  const row: Row = {
    id, tenantId: TID, type, status: 'POSTED', source: 'MANUAL', note: null, vendorId: null, supplier: null, paymentMode: null,
    supplierRef: null, billDate: null, dueDate: null, createdAt: new Date('2026-11-10T09:00:00Z'), netMilli: null, taxMilli: null, totalMilli: null,
    returnOfEntryId: null, ...o,
    vendor: o.vendorId ? { name: vendorName ?? 'مورّد' } : null,
    items: lines.map((l) => ({
      productId: l.productId, qty: l.qty, baseQty: l.baseQty ?? null, unitFactor: l.unitFactor ?? 1, unitName: null,
      unitCost: l.unitCost, taxPct: l.taxPct ?? null,
      product: { id: l.productId, name: l.name ?? `صنف ${l.productId}`, code: l.productId.toUpperCase(), unit: 'حبة', primaryUnitId: null },
    })),
  };
  delete row.vendorName;
  T('warehouseEntry').push(row);
  return row;
}
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

function reset(): void {
  for (const k of Object.keys(tables)) tables[k] = [];
  calls.length = 0;
  seq = 0;
  T('tenant').push({ id: TID, warehouseEnabled: true, accountingEnabled: true });
  T('glSettings').push({ tenantId: TID, timezone: 'Asia/Riyadh', currencyDecimals: 2 });
  T('companySettings').push({ tenantId: TID, countryCode: 'SA', currency: 'SAR', taxDisabled: false });
  T('admin').push({ id: 'a1', isActive: true, canManageVanStock: true, canViewReports: true });
}

/** المثال المحلول: وارد ١٠٠ × ٢٠ بضريبة ١٥٪ آجل + مرتجع ١٠ منه */
function workedExample(): { bill: Row; ret: Row } {
  const bill = entry('RECEIVE', [{ productId: 'p1', qty: 100, unitCost: 20, taxPct: 15 }], {
    vendorId: 'v1', vendorName: 'مورّد الأمل', paymentMode: 'CREDIT', billDate: day('2026-11-05'),
    netMilli: M(2000), taxMilli: M(300), totalMilli: M(2300), supplierRef: 'INV-1',
  });
  const ret = entry('RETURN', [{ productId: 'p1', qty: -10, unitCost: 20, taxPct: 15 }], {
    vendorId: 'v1', vendorName: 'مورّد الأمل', paymentMode: 'CREDIT', billDate: day('2026-11-08'), returnOfEntryId: bill.id,
    netMilli: M(200), taxMilli: M(30), totalMilli: M(230),
  });
  return { bill, ret };
}

const RANGE = { from: '2026-11-01', to: '2026-11-30', defaulted: false };
const load = (groupBy: 'vendor' | 'product' | 'day' | 'month', o: Partial<{ taxHidden: boolean; range: typeof RANGE }> = {}) =>
  loadPurchasesReport(db as never, TID, { groupBy, range: o.range ?? RANGE, timeZone: 'Asia/Riyadh', decimals: 2, taxHidden: o.taxHidden ?? false });

// ═══ الحساب ═══

test('المثال المحلول: وارد ١٠٠@٢٠ ضريبة ١٥٪ آجل + مرتجع ١٠ ⇒ صافي المشتريات ١٨٠٠ وضريبة ٢٧٠، والمتبقّي ٢٠٧٠', async () => {
  reset();
  workedExample();
  const { report, truncated } = await load('vendor');
  assert.equal(truncated, false);
  const s = report.summary;
  assert.deepEqual(
    [s.net, s.tax, s.total, s.returns, s.returnsTax, s.returnsTotal, s.netPurchases, s.netTax, s.netTotal],
    [2000, 300, 2300, 200, 30, 230, 1800, 270, 2070],
  );
  assert.deepEqual([s.cash, s.credit, s.unclassified, s.paid, s.remaining], [0, 2070, 0, 0, 2070]);
  assert.deepEqual([s.bills, s.returnsCount, s.vendors, s.products], [1, 1, 1, 1]);
  assert.equal(report.rows.length, 1);
  const r = report.rows[0];
  assert.deepEqual([r.key, r.name, r.netPurchases, r.netTax, r.netTotal, r.credit, r.remaining, r.qty], ['v:v1', 'مورّد الأمل', 1800, 270, 2070, 2070, 2070, null]);
});

test('المدفوع والمتبقّي من تسوية الفاتورة الحقيقية: سندٌ ساري يُعدّ والملغى لا', async () => {
  reset();
  const { bill } = workedExample();
  T('supplierPayment').push({ id: 'sp1', tenantId: TID, status: 'POSTED', paidAt: day('2026-11-09') }, { id: 'sp2', tenantId: TID, status: 'CANCELLED', paidAt: day('2026-11-09') });
  T('supplierPaymentAllocation').push(
    { id: 'al1', tenantId: TID, paymentId: 'sp1', warehouseEntryId: bill.id, amountMilli: M(500) },
    { id: 'al2', tenantId: TID, paymentId: 'sp2', warehouseEntryId: bill.id, amountMilli: M(900) },
  );
  const { report } = await load('month');
  assert.deepEqual([report.summary.paid, report.summary.remaining], [500, 1570]);
  assert.deepEqual(report.rows.map((r) => [r.key, r.paid, r.remaining, r.netTotal]), [['2026-11', 500, 1570, 2070]]);
});

test('تجميع الصنف: الكمية بالأساس، والمال موزَّعٌ على الأسطر فيطابق مجموعُها الإجمالي، والمدفوع null', async () => {
  reset();
  // كرتون (١٢) من A بـ٦٠ ضريبة ١٥٪ + ٣ من B بـ٧ بلا ضريبة — نقدي: صافٍ ٨١، ضريبة ٩، إجمالي ٩٠
  entry('RECEIVE', [
    { productId: 'a', qty: 1, unitCost: 60, taxPct: 15, unitFactor: 12, baseQty: 12, name: 'أرز' },
    { productId: 'b', qty: 3, unitCost: 7, taxPct: 0, name: 'سكر' },
  ], { vendorId: 'v1', paymentMode: 'CASH', billDate: day('2026-11-03'), netMilli: M(81), taxMilli: M(9), totalMilli: M(90) });
  workedExample();
  const { report } = await load('product');
  const by = new Map(report.rows.map((r) => [r.key, r]));
  const a = by.get('p:a')!;
  const b = by.get('p:b')!;
  const p1 = by.get('p:p1')!;
  assert.deepEqual([a.qty, a.net, a.tax, a.total, a.cash, a.paid, a.code], [12, 60, 9, 69, 69, null, 'A']);
  assert.deepEqual([b.qty, b.net, b.tax, b.total, b.cash], [3, 21, 0, 21, 21]);
  assert.deepEqual([p1.receivedQty, p1.returnedQty, p1.qty, p1.netPurchases, p1.netTax, p1.credit, p1.remaining], [100, 10, 90, 1800, 270, 2070, null]);
  const sum = (k: 'net' | 'tax' | 'netTotal' | 'cash' | 'credit') => report.rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  assert.deepEqual([sum('net'), sum('tax'), sum('netTotal'), sum('cash'), sum('credit')],
    [report.summary.net, report.summary.tax, report.summary.netTotal, report.summary.cash, report.summary.credit]);
  assert.equal(report.summary.paid, 0);
  assert.equal(report.summary.remaining, 2070);
  // الترتيب بالأعلى صافياً
  assert.deepEqual(report.rows.map((r) => r.key), ['p:p1', 'p:a', 'p:b']);
});

test('الوارد غير المصنَّف: Σ الكمية × التكلفة مقرَّبةً نصف-لأعلى بلا ضريبة، وبلا سعر ⇒ صفر يُعلَن unpricedEntries', async () => {
  reset();
  entry('RECEIVE', [{ productId: 'a', qty: 3, unitCost: 1.005 }], { supplier: 'محل الجملة', billDate: day('2026-11-02') });
  entry('RECEIVE', [{ productId: 'b', qty: 4, unitCost: null }], { billDate: day('2026-11-02') });
  const { report } = await load('vendor');
  assert.deepEqual([report.summary.net, report.summary.tax, report.summary.unclassified, report.summary.unpricedEntries, report.summary.bills], [3.02, 0, 3.02, 1, 2]);
  const keys = report.rows.map((r) => [r.key, r.name]);
  assert.deepEqual(keys, [['s:محل الجملة', 'محل الجملة'], ['none', null]]);
});

test('«إزالة الضريبة»: لا مفتاح ضريبة في الصفوف ولا الإجمالي، والمبلغ إجماليّ ما دُفع', async () => {
  reset();
  workedExample();
  const { report } = await load('vendor', { taxHidden: true });
  assert.equal(report.taxHidden, true);
  for (const o of [report.summary, ...report.rows]) {
    assert.ok(!('tax' in o) && !('returnsTax' in o) && !('netTax' in o), 'مفتاح ضريبة ظاهر');
  }
  const s = report.summary;
  assert.deepEqual([s.net, s.total, s.returns, s.netPurchases, s.netTotal, s.credit], [2300, 2300, 230, 2070, 2070, 2070]);
});

test('الاستبعاد: الافتتاحي بعموده وبدفعته القديمة ومرتجعه، والتسوية والتصفير، ومن شركةٍ أخرى', async () => {
  reset();
  workedExample();
  const opening = entry('RECEIVE', [{ productId: 'a', qty: 100, unitCost: 5 }], { source: 'OPENING_IMPORT', billDate: day('2026-11-02') });
  entry('RETURN', [{ productId: 'a', qty: -100, unitCost: 5 }], { returnOfEntryId: opening.id, billDate: day('2026-11-03') });
  const legacy = entry('RECEIVE', [{ productId: 'a', qty: 50, unitCost: 5 }], { note: 'مخزون افتتاحي (استيراد)', billDate: day('2026-11-02') });
  T('importBatch').push({ id: 'ib1', tenantId: TID, kind: 'opening_stock', recordIds: JSON.stringify([legacy.id]) });
  entry('RETURN', [{ productId: 'a', qty: -5, unitCost: 5 }], { returnOfEntryId: legacy.id, billDate: day('2026-11-04') });
  entry('ADJUST', [{ productId: 'a', qty: -6, unitCost: 3 }], { billDate: day('2026-11-04') });
  entry('ADJUST', [{ productId: 'a', qty: -6, unitCost: 3 }], { source: 'STOCK_ZERO', billDate: day('2026-11-04') });
  entry('RECEIVE', [{ productId: 'a', qty: 1, unitCost: 999 }], { tenantId: 'other', billDate: day('2026-11-04') });
  // نصّ الملاحظة وحده لا يكفي: وارد يدويّ بملاحظة الاستيراد بلا دفعة يبقى شراءً
  entry('RECEIVE', [{ productId: 'a', qty: 2, unitCost: 10 }], { note: 'مخزون افتتاحي (استيراد)', billDate: day('2026-11-06') });
  const { report } = await load('vendor');
  assert.deepEqual([report.summary.netPurchases, report.summary.bills, report.summary.returnsCount], [1820, 2, 1]);
});

test('الوارد الملغى وحركة إلغائه: يصفوان صفراً ولا يُعدّ الملغى فاتورة — والمرتجع النقدي ينقص نوع وارده', async () => {
  reset();
  const c = entry('RECEIVE', [{ productId: 'a', qty: 4, unitCost: 25 }], { vendorId: 'v2', status: 'CANCELLED', paymentMode: 'CASH', billDate: day('2026-11-02'), netMilli: M(100), taxMilli: M(15), totalMilli: M(115) });
  entry('RETURN', [{ productId: 'a', qty: -4, unitCost: 25 }], { vendorId: 'v2', returnOfEntryId: c.id, paymentMode: 'CASH', billDate: day('2026-11-07'), netMilli: M(100), taxMilli: M(15), totalMilli: M(115) });
  // مرتجعٌ مستردٌّ نقداً من فاتورة آجلة: ينقص «الآجل» (نوع وارده) لا «النقدي»
  const { bill } = workedExample();
  entry('RETURN', [{ productId: 'p1', qty: -5, unitCost: 20 }], { vendorId: 'v1', returnOfEntryId: bill.id, paymentMode: 'CASH', billDate: day('2026-11-09'), netMilli: M(100), taxMilli: M(15), totalMilli: M(115) });
  const { report } = await load('vendor');
  const s = report.summary;
  assert.deepEqual([s.bills, s.returnsCount, s.cash, s.credit, s.netTotal], [1, 3, 0, 1955, 1955]);
  const v2 = report.rows.find((r) => r.key === 'v:v2')!;
  assert.deepEqual([v2.bills, v2.net, v2.returns, v2.netTotal], [0, 100, 100, 0]);
});

test('التاريخ: تاريخ فاتورة المورّد أولاً، وبلاه يوم الاستلام بتوقيت الشركة لا UTC', async () => {
  reset();
  // ٢٢:٣٠ UTC في ١ نوفمبر = ٠١:٣٠ في ٢ نوفمبر بالرياض
  entry('RECEIVE', [{ productId: 'a', qty: 1, unitCost: 10 }], { createdAt: new Date('2026-11-01T22:30:00Z') });
  // استُلم في أكتوبر وفاتورته في نوفمبر ⇒ نوفمبر
  entry('RECEIVE', [{ productId: 'a', qty: 1, unitCost: 7 }], { createdAt: new Date('2026-10-20T10:00:00Z'), billDate: day('2026-11-15') });
  // فاتورته في أكتوبر ⇒ خارج نوفمبر ولو استُلم فيه
  entry('RECEIVE', [{ productId: 'a', qty: 1, unitCost: 1000 }], { createdAt: new Date('2026-11-12T10:00:00Z'), billDate: day('2026-10-31') });
  const { report } = await load('day');
  assert.deepEqual(report.rows.map((r) => [r.key, r.net]), [['2026-11-02', 10], ['2026-11-15', 7]]);
  const only1st = await load('day', { range: { from: '2026-11-01', to: '2026-11-01', defaulted: false } });
  assert.deepEqual(only1st.report.rows, []);
  assert.equal(entryDay({ billDate: null, createdAt: new Date('2026-11-01T22:30:00Z') }, 'Asia/Riyadh'), '2026-11-02');
});

test('splitMilli: Σ الحصص = المبلغ حرفياً بوحدة العملة، والأوزان الصفرية بالتساوي، والسالب بإشارته', () => {
  const parts = splitMilli(1000n * 100n, [1, 1, 1], 10n); // ١٠٠ على ثلاثة بالهللة
  assert.equal(parts.reduce((s, v) => s + v, 0n), 100_000n);
  assert.deepEqual(parts, [33_340n, 33_330n, 33_330n]);
  assert.deepEqual(splitMilli(9_000n, [0, 0, 0], 10n), [3_000n, 3_000n, 3_000n]);
  assert.deepEqual(splitMilli(-5_000n, [3, 1], 10n), [-3_750n, -1_250n]);
  assert.deepEqual(splitMilli(7n, [1, 3], 10n), [0n, 7n]);
});

test('المدى: بلا طرفين آخر ٩٠ يوماً حتى يوم الشركة معلَناً، وطرفٌ واحد مفتوح، وغير الصالح والمقلوب null', () => {
  const now = new Date('2026-11-17T22:00:00Z'); // ١٨ نوفمبر بالرياض
  assert.deepEqual(purchasesRange(undefined, undefined, 'Asia/Riyadh', now), { from: '2026-08-21', to: '2026-11-18', defaulted: true });
  assert.deepEqual(purchasesRange('2026-11-01', '', 'Asia/Riyadh', now), { from: '2026-11-01', to: null, defaulted: false });
  assert.equal(purchasesRange('2026-13-01', undefined, 'Asia/Riyadh', now), null);
  assert.equal(purchasesRange('2026-11-10', '2026-11-01', 'Asia/Riyadh', now), null);
  assert.equal(purchasesRange(['x'], undefined, 'Asia/Riyadh', now), null);
});

test('buildPurchasesReport صرفٌ: الشهر بالترتيب الزمني والمورّد بالأعلى صافياً', () => {
  const base = { status: 'POSTED', vendorId: null, supplier: null, paymentMode: null, netMilli: null, taxMilli: null, totalMilli: null, returnOfEntryId: null };
  const mk = (id: string, d: string, cost: number, supplier: string) => ({
    ...base, id, type: 'RECEIVE', supplier, billDate: day(d), createdAt: day(d), items: [{ productId: 'a', qty: 1, unitCost: cost }],
  });
  const entries = [mk('1', '2026-12-01', 5, 'ب'), mk('2', '2026-10-05', 50, 'أ'), mk('3', '2026-11-09', 20, 'ب')];
  const month = buildPurchasesReport(entries, { groupBy: 'month', timeZone: 'Asia/Riyadh', decimals: 2, taxHidden: false });
  assert.deepEqual(month.rows.map((r) => [r.key, r.net]), [['2026-10', 50], ['2026-11', 20], ['2026-12', 5]]);
  const vendor = buildPurchasesReport(entries, { groupBy: 'vendor', timeZone: 'Asia/Riyadh', decimals: 2, taxHidden: false });
  assert.deepEqual(vendor.rows.map((r) => [r.name, r.netTotal, r.bills]), [['أ', 50, 1], ['ب', 25, 2]]);
});

// ═══ المعالج ═══

async function call(query: Row, user: Row = { id: 'a1', role: 'ADMIN', tenantId: TID }): Promise<{ status: number; body: Row | null; err: unknown }> {
  let status = 200;
  let body: Row | null = null;
  let err: unknown = null;
  const res = { status(s: number) { status = s; return this; }, json(b: Row) { body = b; return this; } };
  await purchasesReportHandler({ query, params: {}, user } as never, res as never, ((e: unknown) => { err = e; }) as never);
  return { status, body, err };
}

test('المعالج: الردّ بشكله ومعه المدى المطبَّق ومنطقة الشركة', async () => {
  reset();
  workedExample();
  const r = await call({ from: '2026-11-01', to: '2026-11-30', groupBy: 'vendor' });
  assert.equal(r.err, null);
  assert.equal(r.status, 200);
  assert.equal(r.body!.success, true);
  assert.equal(r.body!.data.summary.netPurchases, 1800);
  assert.equal(r.body!.data.summary.netTax, 270);
  assert.deepEqual(r.body!.meta.appliedRange, { from: '2026-11-01', to: '2026-11-30', defaulted: false });
  assert.equal(r.body!.meta.timezone, 'Asia/Riyadh');
  assert.equal(r.body!.meta.truncated, false);
  // كل قراءة حركات بعزل الشركة
  assert.ok(calls.includes('warehouseEntry.findMany'));
  // JSON سليم: لا BigInt في الردّ
  assert.doesNotThrow(() => JSON.stringify(r.body));
});

test('المعالج: «إزالة الضريبة» من إعدادات الشركة تُخفي الضريبة', async () => {
  reset();
  T('companySettings')[0].taxDisabled = true;
  workedExample();
  const r = await call({ from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.body!.data.taxHidden, true);
  assert.ok(!('tax' in r.body!.data.summary));
  assert.equal(r.body!.data.groupBy, 'vendor');
});

test('المعالج: الحرّاس — المندوب، وبلا صلاحية المخزون، والمحاسبة المطفأة، والمستودع المطفأ، والمعاملات غير الصالحة', async () => {
  reset();
  assert.equal((await call({}, { id: 'r1', role: 'SALES_REP', tenantId: TID })).status, 403);
  T('admin')[0].canManageVanStock = false;
  const noPerm = await call({});
  assert.equal(noPerm.status, 403);
  T('admin')[0].canManageVanStock = true;
  T('tenant')[0].accountingEnabled = false;
  assert.equal((await call({})).body!.code, 'ACCOUNTING_NOT_ALLOWED');
  T('tenant')[0].accountingEnabled = true;
  T('tenant')[0].warehouseEnabled = false;
  assert.equal((await call({})).body!.code, 'WAREHOUSE_NOT_ENABLED');
  T('tenant')[0].warehouseEnabled = true;
  const badGroup = await call({ groupBy: 'rep' });
  assert.deepEqual([badGroup.status, badGroup.body!.code], [400, 'INVALID_GROUP_BY']);
  const badRange = await call({ from: '2026-11-30', to: '2026-11-01' });
  assert.deepEqual([badRange.status, badRange.body!.code], [400, 'INVALID_RANGE']);
  // بلا مدى: آخر ٩٠ يوماً معلَنة
  const def = await call({});
  assert.equal(def.status, 200);
  assert.equal(def.body!.meta.appliedRange.defaulted, true);
});
