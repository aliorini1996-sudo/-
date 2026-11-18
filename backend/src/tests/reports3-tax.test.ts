// «تقرير الضرائب» (services/reports/taxReport.ts، طلب المالك ١٨ نوفمبر ٢٠٢٦): المثال المحلول (مخرجات ٢٢٥ − مدخلات ٢٧٠ ⇒ صافي −٤٥)،
// وطرح المرتجع والإشعار الدائن وإضافة المدين، وغير المستردة منفصلة لا تُطرح، والصفرية/المعفاة وعاءٌ بلا ضريبة، والتجميع بالشهر والربع
// والنسبة، ومطابقة رؤوس الفواتير بالتوزيع، والمدى بأيام الشركة، والإلغاء مرتجعاً بتاريخه لا حذفاً، ونطاق المقيَّد، و«إزالة الضريبة» — فوق Prisma مزيّف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف: يسجّل الاستعلامات ويردّ صفوفاً مُعدّة ───
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const calls: { model: string; op: string; args: Row }[] = [];
const state = {
  taxDisabled: false,
  scopeEnabled: false,
  accountingEnabled: true as boolean | null,
  vanStock: true,
  invoices: [] as Row[],
  itemGroups: [] as Row[],
  entries: [] as Row[],
};

/**
 * شرط حركات المستودع كما يكتبه loadTaxDocs يُفسَّر على الصفوف: النوع والحالة (الصفّ بلا حالة POSTED) ويوم فاتورة المورّد
 * (gte/lte) أو لحظة الاستلام (gte/lt). المصنَّفة والمسعَّرة شرطاها يُفحصان على شكل الاستعلام في اختباره.
 */
const dateOk = (v: Date | null | undefined, c: Row | null | undefined): boolean => {
  if (c === undefined) return true;
  if (c === null) return v == null;
  if (v == null) return false;
  const t = v.getTime();
  return (!c.gte || t >= c.gte.getTime()) && (!c.lte || t <= c.lte.getTime()) && (!c.lt || t < c.lt.getTime());
};
const clauseOk = (row: Row, c: Row): boolean => Object.entries(c).every(([k, v]) => {
  if (k === 'OR') return (v as Row[]).some((x) => clauseOk(row, x));
  if (k === 'billDate' || k === 'createdAt') return dateOk(row[k], v as Row | null);
  const val = k === 'status' ? row.status ?? 'POSTED' : row[k];
  if (v && typeof v === 'object' && 'not' in v) return val !== v.not;
  return val === v;
});
const whMatch = (row: Row, where: Row): boolean => ((where.AND ?? []) as Row[]).every((c) => clauseOk(row, c));
const fake = {
  admin: { async findUnique() { return { scopeEnabled: state.scopeEnabled, scopeMode: 'LISTS', isActive: true, canManageVanStock: state.vanStock }; } },
  tenant: { async findUnique() { return { accountingEnabled: state.accountingEnabled }; } },
  glSettings: { async findUnique() { return { timezone: 'Asia/Riyadh', currencyDecimals: 2 }; } },
  companySettings: { async findUnique(a: Row) { calls.push({ model: 'companySettings', op: 'findUnique', args: a }); return { taxDisabled: state.taxDisabled, countryCode: 'SA', currency: 'SAR' }; } },
  invoice: { async findMany(a: Row) { calls.push({ model: 'invoice', op: 'findMany', args: a }); return state.invoices; } },
  invoiceItem: { async groupBy(a: Row) { calls.push({ model: 'invoiceItem', op: 'groupBy', args: a }); return state.itemGroups; } },
  warehouseEntry: {
    async findMany(a: Row) {
      calls.push({ model: 'warehouseEntry', op: 'findMany', args: a });
      return state.entries.filter((e) => whMatch(e, a.where ?? {}));
    },
  },
};
stub('config/database', { default: fake });

/* eslint-disable @typescript-eslint/no-var-requires */
const tax = require('../services/reports/taxReport') as typeof import('../services/reports/taxReport');
/* eslint-enable @typescript-eslint/no-var-requires */
const { buildTaxReport, taxReportRange, splitMinor, periodKeysBetween, saleBucketKey, loadTaxDocs, taxReportHandler, taxGroupByOf } = tax;
type SaleDoc = import('../services/reports/taxReport').TaxSaleDoc;
type PurchaseDoc = import('../services/reports/taxReport').TaxPurchaseDoc;

const sale = (o: Partial<SaleDoc> & { base: number; pct: number }): SaleDoc => {
  const t = Math.round(o.base * o.pct) / 100;
  return {
    id: o.id ?? `s${Math.random()}`, type: o.type ?? 'CREDIT', documentKind: o.documentKind ?? null, date: o.date ?? '2026-10-05',
    taxFree: o.taxFree ?? false, total: o.total ?? o.base + t, taxAmt: o.taxAmt ?? t,
    lines: o.lines ?? [{ taxPct: o.pct, vatCategory: null, lineTotal: o.base + t, taxAmt: t }],
  };
};
const bill = (o: Partial<PurchaseDoc> & { base: number; pct: number }): PurchaseDoc => ({
  id: o.id ?? `p${Math.random()}`, type: o.type ?? 'RECEIVE', date: o.date ?? '2026-10-07', vatTreatment: o.vatTreatment ?? 'RECOVERABLE',
  costsIncludeTax: false, netMilli: BigInt(Math.round(o.base * 1000)),
  taxMilli: BigInt(Math.round(o.base * o.pct * 10)),
  lines: o.lines ?? [{ taxPct: o.pct, qty: 1, unitCost: o.base, enteredUnitCost: o.base }],
});

// ═══ المثال المحلول ═══

test('المثال المحلول: مخرجات ٢٢٥ − مدخلات ٢٧٠ ⇒ صافي −٤٥ رصيدٌ مسترد', () => {
  const r = buildTaxReport({ sales: [sale({ base: 1500, pct: 15 })], purchases: [bill({ base: 1800, pct: 15 })], groupBy: 'quarter', decimals: 2 });
  assert.equal(r.summary!.output.tax, 225);
  assert.equal(r.summary!.output.base, 1500);
  assert.equal(r.summary!.input!.tax, 270);
  assert.equal(r.summary!.input!.base, 1800);
  assert.equal(r.summary!.net, -45);
  assert.equal(r.summary!.position, 'REFUNDABLE');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].key, '2026-Q4');
  assert.equal(r.rows[0].start, '2026-10-01');
  assert.equal(r.rows[0].end, '2026-12-31');
  assert.equal(r.rows[0].net, -45);
});

test('المرتجع والإشعار الدائن يُطرحان والإشعار المدين يُضاف، ومرتجع المورّد يطرح المدخلات', () => {
  const r = buildTaxReport({
    sales: [
      sale({ base: 1000, pct: 15 }),
      sale({ base: 200, pct: 15, type: 'RETURN' }),
      sale({ base: 100, pct: 15, type: 'RETURN', documentKind: 'CREDIT_NOTE' }),
      sale({ base: 40, pct: 15, type: 'CREDIT', documentKind: 'DEBIT_NOTE' }),
    ],
    purchases: [bill({ base: 600, pct: 15 }), bill({ base: 100, pct: 15, type: 'RETURN' })],
    groupBy: 'month', decimals: 2,
  });
  const s = r.summary!;
  assert.deepEqual([s.output.sales.count, s.output.returns.count, s.output.debitNotes.count], [1, 2, 1]);
  assert.equal(s.output.returns.tax, 45);
  assert.equal(s.output.base, 1000 - 300 + 40);
  assert.equal(s.output.tax, 150 - 45 + 6);
  assert.equal(s.input!.tax, 90 - 15);
  assert.equal(s.input!.returns.count, 1);
  assert.equal(s.net, 111 - 75);
  assert.equal(s.position, 'PAYABLE');
  const row = r.rows.find((x) => x.key === '2026-10')!;
  assert.equal(row.output.salesTax, 156);
  assert.equal(row.output.returnsTax, 45);
  assert.equal(row.input!.returnsTax, 15);
});

test('غير القابلة للاسترداد تُعرض منفصلة ولا تُطرح من المستحق، ومرتجعها يُنقصها', () => {
  const r = buildTaxReport({
    sales: [sale({ base: 1000, pct: 15 })],
    purchases: [
      bill({ base: 400, pct: 15, vatTreatment: 'NON_RECOVERABLE', lines: [{ taxPct: 15, qty: 1, unitCost: 460, enteredUnitCost: null }] }),
      bill({ base: 100, pct: 15, type: 'RETURN', vatTreatment: 'NON_RECOVERABLE' }),
      bill({ base: 200, pct: 15 }),
    ],
    groupBy: 'rate', decimals: 2,
  });
  const s = r.summary!;
  assert.equal(s.nonRecoverable!.tax, 60 - 15);
  assert.equal(s.nonRecoverable!.base, 300);
  assert.equal(s.nonRecoverable!.count, 1);
  assert.equal(s.input!.tax, 30, 'المستردة وحدها');
  assert.equal(s.net, 150 - 30, 'غير المستردة لا تُطرح');
  const r15 = r.rows.find((x) => x.key === '15')!;
  assert.deepEqual(r15.nonRecoverable, { base: 300, tax: 45 });
});

test('الصفرية والمعفاة وخارج النطاق وعاءٌ بلا ضريبة في سلالها، والمختوم «بلا ضريبة» خارج النطاق', () => {
  const r = buildTaxReport({
    sales: [
      sale({ base: 1000, pct: 15 }),
      sale({ base: 300, pct: 0, lines: [{ taxPct: 0, vatCategory: 'Z', lineTotal: 300, taxAmt: 0 }] }),
      sale({ base: 200, pct: 0, lines: [{ taxPct: 0, vatCategory: 'E', lineTotal: 200, taxAmt: 0 }] }),
      sale({ base: 50, pct: 0, taxFree: true, lines: [{ taxPct: 0, vatCategory: null, lineTotal: 50, taxAmt: 0 }] }),
      sale({ base: 70, pct: 0, lines: [{ taxPct: 0, vatCategory: null, lineTotal: 70, taxAmt: 0 }] }),
    ],
    purchases: [bill({ base: 80, pct: 15, vatTreatment: 'NONE' })],
    groupBy: 'rate', decimals: 2,
  });
  assert.deepEqual(r.rows.map((x) => x.key), ['15', '0', 'Z', 'E', 'O']);
  assert.deepEqual(r.rows.map((x) => x.category), ['S', '0', 'Z', 'E', 'O']);
  for (const k of ['0', 'Z', 'E', 'O']) assert.equal(r.rows.find((x) => x.key === k)!.output.tax, 0);
  assert.equal(r.summary!.output.zeroBase, 300 + 200 + 50 + 70);
  assert.equal(r.summary!.output.tax, 150);
  // الوارد NONE: وعاءٌ في سلّة ٠ بلا ضريبة ولو حملت أسطره نسبة
  assert.deepEqual([r.rows.find((x) => x.key === '0')!.input!.base, r.summary!.input!.tax], [80, 0]);
  assert.equal(saleBucketKey(0, 'z', false), 'Z');
  assert.equal(saleBucketKey(15, 'S', true), '15', 'نسبةٌ موجبة تبقى نسبتها');
});

test('المطابقة برأس الفاتورة: الوعاء والضريبة من الرأس موزّعَين على النسب بأوزان البنود بلا فقد', () => {
  // فاتورة قديمة: خصمٌ كلّي ٣٠ طُرح بعد الضريبة فالإجمالي أقلّ من مجموع البنود
  const doc: SaleDoc = {
    id: 'old', type: 'CASH', date: '2026-10-01', total: 1390, taxAmt: 120,
    lines: [{ taxPct: 15, lineTotal: 690, taxAmt: 90 }, { taxPct: 5, lineTotal: 630, taxAmt: 30 }, { taxPct: 0, lineTotal: 100, taxAmt: 0 }],
  };
  const r = buildTaxReport({ sales: [doc], purchases: [], groupBy: 'rate', decimals: 2 });
  const total = r.rows.reduce((s, x) => s + x.output.base, 0);
  assert.equal(Math.round(total * 100), 127000, 'Σ الوعاء = الإجمالي − الضريبة');
  assert.equal(r.summary!.output.base, 1270);
  assert.equal(r.summary!.output.tax, 120);
  assert.equal(r.rows.find((x) => x.key === '15')!.output.tax, 90);
  assert.equal(r.rows.find((x) => x.key === '5')!.output.tax, 30);
  assert.equal(r.rows.find((x) => x.key === '0')!.output.tax, 0);
});

test('التقريب نصف-لأعلى بمنازل العملة (٣ للدينار) ومجموع الصفوف يساوي الإجمالي', () => {
  const docs: SaleDoc[] = [1, 2, 3].map((i) => ({
    id: `k${i}`, type: 'CREDIT', date: `2026-0${i}-10`, total: 1.0005 + 0.15, taxAmt: 0.1505,
    lines: [{ taxPct: 15, lineTotal: 1.1505, taxAmt: 0.1505 }],
  }));
  const r = buildTaxReport({ sales: docs, purchases: [], groupBy: 'month', decimals: 3 });
  assert.equal(r.decimals, 3);
  assert.equal(r.rows[0].output.tax, 0.151, '0.1505 ⇒ 0.151 نصف-لأعلى');
  assert.equal(r.summary!.output.tax, 0.453);
  assert.equal(Math.round(r.rows.reduce((s, x) => s + x.output.tax, 0) * 1000), 453);
  assert.deepEqual(splitMinor(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(splitMinor(-10, [1, 1, 1]), [-4, -3, -3]);
  assert.deepEqual(splitMinor(7, [0, 0], 1), [0, 7]);
});

test('التجميع بالشهر والربع يملأ الفترات الخالية في مدىً محدود ويرتّب زمنياً', () => {
  const r = buildTaxReport({
    sales: [sale({ base: 100, pct: 15, date: '2026-03-31' }), sale({ base: 100, pct: 15, date: '2026-05-02' })],
    purchases: [], groupBy: 'month', decimals: 2, range: { from: '2026-03-01', to: '2026-06-15' },
  });
  assert.deepEqual(r.rows.map((x) => x.key), ['2026-03', '2026-04', '2026-05', '2026-06']);
  assert.equal(r.rows[1].output.tax, 0);
  const q = buildTaxReport({
    sales: [sale({ base: 100, pct: 15, date: '2026-03-31' }), sale({ base: 100, pct: 15, date: '2026-04-01' })],
    purchases: [], groupBy: 'quarter', decimals: 2, range: { from: '2025-12-15', to: '2026-04-30' },
  });
  assert.deepEqual(q.rows.map((x) => x.key), ['2025-Q4', '2026-Q1', '2026-Q2']);
  assert.deepEqual(periodKeysBetween('2026-11-20', '2027-02-01', 'quarter'), ['2026-Q4', '2027-Q1']);
  assert.equal(taxGroupByOf('rep'), 'month');
  assert.equal(taxGroupByOf('quarter'), 'quarter');
});

test('المدى بأيام الشركة: الافتراضي من أول الربع السابق حتى اليوم، والتاريخ الفاسد و«من» بعد «إلى» مرفوضان', () => {
  // ٢٢:٠٠ UTC يوم ٣١ ديسمبر = ١ يناير بتوقيت الرياض ⇒ الربع الجاري الأول والسابق الرابع
  const d = taxReportRange(undefined, '', 'Asia/Riyadh', new Date('2026-12-31T22:00:00Z'));
  assert.deepEqual(d, { ok: true, from: '2026-10-01', to: '2027-01-01', defaulted: true });
  assert.deepEqual(taxReportRange('2026-01-01', undefined, 'Asia/Riyadh'), { ok: true, from: '2026-01-01', to: null, defaulted: false });
  assert.equal(taxReportRange('2026-13-01', undefined, 'Asia/Riyadh').ok, false);
  assert.equal(taxReportRange(['2026-01-01'], undefined, 'Asia/Riyadh').ok, false, 'مصفوفة qs مرفوضة لا مُسقَطة');
  assert.equal(taxReportRange('0001-01-01', undefined, 'Asia/Riyadh').ok, false);
  assert.equal(taxReportRange('2026-05-01', '2026-04-01', 'Asia/Riyadh').ok, false);
});

// ═══ القراءة من القاعدة ═══

const reset = () => {
  calls.length = 0;
  Object.assign(state, { taxDisabled: false, scopeEnabled: false, accountingEnabled: true, vanStock: true, invoices: [], itemGroups: [], entries: [] });
};

test('القراءة: الشركة والحالة المؤكَّدة وحدود الأيام بتوقيت الشركة في كل استعلام، والوارد بأي حالة والمرتجع الملغى وحده خارج', async () => {
  reset();
  state.invoices = [{ id: 'i1', type: 'CREDIT', documentKind: null, invoiceDate: new Date('2026-09-30T21:30:00Z'), taxFree: false, total: 115, taxAmt: 15 }];
  state.itemGroups = [{ invoiceId: 'i1', taxPct: 15, vatCategory: null, _sum: { lineTotal: 115, taxAmt: 15 } }];
  const entry = (id: string, type: string, extra: Row = {}) => ({
    id, type, returnOfEntryId: null, billDate: new Date('2026-10-02T00:00:00Z'), createdAt: new Date('2026-10-02T08:00:00Z'),
    vatTreatment: 'RECOVERABLE', costsIncludeTax: false, netMilli: 100000n, taxMilli: 15000n,
    items: [{ taxPct: 15, qty: 1, unitCost: 100, enteredUnitCost: 100 }], ...extra,
  });
  state.entries = [
    entry('b1', 'RECEIVE'),
    entry('r1', 'RETURN', { returnOfEntryId: 'b1', netMilli: 20000n, taxMilli: 3000n }),
    // مرتجع إلغاء وارد سبتمبر (الأصل خارج المدى): عكسٌ في فترة الإلغاء كما في كشف المورّد والدفاتر
    entry('r2', 'RETURN', { returnOfEntryId: 'bx', netMilli: 50000n, taxMilli: 7500n }),
    // مرتجعٌ ملغى نفسه: خارج
    entry('r3', 'RETURN', { returnOfEntryId: 'b1', status: 'CANCELLED', netMilli: 10000n, taxMilli: 1500n }),
  ];
  const out = await loadTaxDocs(fake as never, { tenantId: 't1', tz: 'Asia/Riyadh', from: '2026-10-01', to: '2026-10-31', scope: {}, withPurchases: true });
  const inv = calls.find((c) => c.model === 'invoice')!.args;
  assert.equal(inv.where.tenantId, 't1');
  assert.equal(inv.where.status, 'CONFIRMED', 'الملغاة والمسودة خارجة');
  assert.equal((inv.where.invoiceDate.gte as Date).toISOString(), '2026-09-30T21:00:00.000Z', 'منتصف ليل الرياض');
  assert.equal((inv.where.invoiceDate.lt as Date).toISOString(), '2026-10-31T21:00:00.000Z');
  const grp = calls.find((c) => c.model === 'invoiceItem')!.args;
  assert.equal(grp.where.invoice.tenantId, 't1', 'البنود بشركة فاتورتها');
  assert.deepEqual(grp.by, ['invoiceId', 'taxPct', 'vatCategory']);
  const wh = calls.filter((c) => c.model === 'warehouseEntry');
  assert.equal(wh.length, 1, 'استعلامٌ واحد ثابت لا N+1 — لا قراءة لأصول المرتجعات');
  assert.equal(wh[0].args.where.tenantId, 't1');
  assert.deepEqual(wh[0].args.where.paymentMode, { not: null }, 'المصنَّفة وحدها');
  assert.deepEqual(wh[0].args.where.netMilli, { not: null }, 'المسعَّرة وحدها');
  assert.equal(wh[0].args.where.status, undefined, 'لا استبعاد للوارد بحالته');
  assert.deepEqual(wh[0].args.where.AND[0], { OR: [{ type: 'RECEIVE' }, { type: 'RETURN', status: { not: 'CANCELLED' } }] });
  assert.equal(out.sales[0].date, '2026-10-01', 'يوم الفاتورة بتوقيت الشركة');
  assert.deepEqual(out.purchases!.map((p) => p.id), ['b1', 'r1', 'r2'], 'مرتجع الإلغاء داخلٌ والمرتجع الملغى خارج');
  const r = buildTaxReport({ ...out, groupBy: 'month', decimals: 2 });
  assert.equal(r.summary!.input!.tax, 15 - 3 - 7.5);
  assert.equal(r.summary!.output.tax, 15);
});

test('فاتورة مورّد أُلغيت بعد فترتها: ضريبة فترتها الأصلية باقية كما قُدِّم إقرارها، والعكس في فترة الإلغاء، والمدى الشامل صفر — كالدفاتر وتقرير المشتريات', async () => {
  reset();
  // آجلة مستردة ١٠٠٠ + ١٥٠ بتاريخ ١٥ سبتمبر، أُلغيت ٥ أكتوبر (reverseEntryTx: RETURN كاملة بتاريخ الإلغاء، والأصل CANCELLED)
  const line = [{ taxPct: 15, qty: 10, unitCost: 100, enteredUnitCost: 100 }];
  state.entries = [
    { id: 'bx', type: 'RECEIVE', status: 'CANCELLED', returnOfEntryId: null, billDate: new Date('2026-09-15T00:00:00Z'), createdAt: new Date('2026-09-15T08:00:00Z'),
      vatTreatment: 'RECOVERABLE', costsIncludeTax: false, netMilli: 1000000n, taxMilli: 150000n, items: line },
    { id: 'rx', type: 'RETURN', status: 'POSTED', returnOfEntryId: 'bx', billDate: new Date('2026-10-05T00:00:00Z'), createdAt: new Date('2026-10-05T09:00:00Z'),
      vatTreatment: 'RECOVERABLE', costsIncludeTax: false, netMilli: 1000000n, taxMilli: 150000n, items: line.map((l) => ({ ...l, qty: -10 })) },
  ];
  const run = async (from: string, to: string) => {
    const docs = await loadTaxDocs(fake as never, { tenantId: 't1', tz: 'Asia/Riyadh', from, to, scope: {}, withPurchases: true });
    return buildTaxReport({ ...docs, groupBy: 'quarter', decimals: 2, range: { from, to } });
  };
  const q3 = await run('2026-07-01', '2026-09-30');
  assert.deepEqual([q3.summary!.input!.purchases.tax, q3.summary!.input!.returns.tax, q3.summary!.input!.tax], [150, 0, 150], 'إقرار الربع الثالث يُعاد إنتاجه بعد الإلغاء');
  assert.equal(q3.summary!.net, -150);
  const q4 = await run('2026-10-01', '2026-12-31');
  assert.deepEqual([q4.summary!.input!.purchases.tax, q4.summary!.input!.returns.tax, q4.summary!.input!.tax], [0, 150, -150], 'العكس في فترة الإلغاء');
  assert.equal(q4.summary!.input!.base, -1000);
  const both = await run('2026-07-01', '2026-12-31');
  assert.equal(both.summary!.input!.tax, 0, 'مدىً يشملهما يصفو صفراً');
  assert.deepEqual(both.rows.map((x) => [x.key, x.input!.tax]), [['2026-Q3', 150], ['2026-Q4', -150]]);
});

test('المقيَّد النطاق: قيده على الفاتورة وبنودها، ولا قراءة للمشتريات ولا صافٍ', async () => {
  reset();
  const scope = { AND: [{ customer: { adminScopes: { some: { adminId: 'a1' } } } }] };
  const out = await loadTaxDocs(fake as never, { tenantId: 't1', tz: 'Asia/Riyadh', from: '2026-10-01', to: '2026-10-31', scope, withPurchases: false });
  assert.equal(out.purchases, null);
  assert.equal(calls.filter((c) => c.model === 'warehouseEntry').length, 0);
  assert.deepEqual(calls.find((c) => c.model === 'invoice')!.args.where.AND, scope.AND);
  assert.deepEqual(calls.find((c) => c.model === 'invoiceItem')!.args.where.invoice.AND, scope.AND);
  const r = buildTaxReport({ sales: [sale({ base: 100, pct: 15 })], purchases: null, groupBy: 'month', decimals: 2 });
  assert.equal(r.scoped, true);
  assert.equal(r.inputHidden, 'SCOPE');
  const p = buildTaxReport({ sales: [], purchases: null, groupBy: 'month', decimals: 2, scoped: false });
  assert.deepEqual([p.scoped, p.inputHidden], [false, 'PERMISSION']);
  const full = buildTaxReport({ sales: [], purchases: [], groupBy: 'month', decimals: 2, scoped: false });
  assert.equal(full.inputHidden, null);
  assert.equal(r.summary!.input, null);
  assert.equal(r.summary!.net, null);
  assert.equal(r.rows[0].input, null);
});

// ═══ المعالج ═══

const call = async (query: Row, user: Row = { id: 'a1', tenantId: 't1', role: 'ADMIN' }) => {
  let status = 200;
  let body: Row | null = null;
  let err: unknown = null;
  const res = { status(s: number) { status = s; return this; }, json(b: Row) { body = b; return this; } };
  await taxReportHandler({ query, user } as never, res as never, (e?: unknown) => { err = e; });
  return { status, body: body as Row | null, err };
};

test('المعالج: «إزالة الضريبة» ⇒ بيانٌ فارغ صريح بلا أي رقم ولا قراءة مستندات', async () => {
  reset();
  state.taxDisabled = true;
  const r = await call({ groupBy: 'quarter' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body!.data, { taxDisabled: true, groupBy: 'quarter', decimals: 2, scoped: false, inputHidden: null, rows: [], summary: null });
  assert.equal(calls.filter((c) => c.model === 'invoice' || c.model === 'warehouseEntry').length, 0);
});

test('المعالج: المثال المحلول من طرفٍ لطرف، والمدى المطبَّق معلَن، والتاريخ الفاسد ٤٠٠', async () => {
  reset();
  state.invoices = [{ id: 'i1', type: 'CASH', documentKind: 'INVOICE', invoiceDate: new Date('2026-10-05T09:00:00Z'), taxFree: false, total: 1725, taxAmt: 225 }];
  state.itemGroups = [{ invoiceId: 'i1', taxPct: 15, vatCategory: 'S', _sum: { lineTotal: 1725, taxAmt: 225 } }];
  state.entries = [{
    id: 'b1', type: 'RECEIVE', returnOfEntryId: null, billDate: new Date('2026-10-06T00:00:00Z'), createdAt: new Date('2026-10-06T08:00:00Z'),
    vatTreatment: 'RECOVERABLE', costsIncludeTax: false, netMilli: 1800000n, taxMilli: 270000n,
    items: [{ taxPct: 15, qty: 10, unitCost: 180, enteredUnitCost: 180 }],
  }];
  const ok = await call({ from: '2026-10-01', to: '2026-12-31', groupBy: 'quarter' });
  assert.equal(ok.err, null);
  assert.equal(ok.body!.success, true);
  assert.equal(ok.body!.data.summary.net, -45);
  assert.equal(ok.body!.data.summary.position, 'REFUNDABLE');
  assert.equal(ok.body!.data.inputHidden, null);
  assert.deepEqual(ok.body!.meta, { appliedRange: { from: '2026-10-01', to: '2026-12-31', defaulted: false }, timezone: 'Asia/Riyadh' });
  const bad = await call({ from: '2026-02-30' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body!.success, false);
});

test('المعالج: المحاسبة المطفأة صراحةً ⇒ ٤٠٣ ACCOUNTING_NOT_ALLOWED بلا قراءة مستندات', async () => {
  reset();
  state.accountingEnabled = false;
  const r = await call({ groupBy: 'month' });
  assert.equal(r.status, 403);
  assert.equal(r.body!.code, 'ACCOUNTING_NOT_ALLOWED');
  assert.equal(calls.filter((c) => c.model === 'invoice' || c.model === 'warehouseEntry').length, 0);
});

test('المعالج: الممنوع من المشتريات (canManageVanStock=false) يرى المخرجات وحدها بلا قراءة فواتير الموردين', async () => {
  reset();
  state.vanStock = false;
  state.invoices = [{ id: 'i1', type: 'CASH', documentKind: null, invoiceDate: new Date('2026-10-05T09:00:00Z'), taxFree: false, total: 115, taxAmt: 15 }];
  state.itemGroups = [{ invoiceId: 'i1', taxPct: 15, vatCategory: null, _sum: { lineTotal: 115, taxAmt: 15 } }];
  const r = await call({ from: '2026-10-01', to: '2026-10-31', groupBy: 'month' });
  assert.equal(r.err, null);
  assert.equal(r.status, 200);
  assert.equal(r.body!.data.scoped, false);
  assert.equal(r.body!.data.inputHidden, 'PERMISSION');
  assert.equal(r.body!.data.summary.output.tax, 15);
  assert.equal(r.body!.data.summary.input, null);
  assert.equal(r.body!.data.summary.net, null);
  assert.equal(calls.filter((c) => c.model === 'warehouseEntry').length, 0);
});
