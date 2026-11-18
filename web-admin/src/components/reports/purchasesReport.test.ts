// «تقرير المشتريات» في الواجهة (منطق components/reports/PurchasesReport.tsx في purchasesReportLogic.ts): الإجماليات مع البحث، وأوراق التصدير بأعمدة الشاشة
// (ولا ضريبة مع «إزالة الضريبة»)، واسم الصفّ. على ردّ المثال المحلول: وارد ١٠٠@٢٠ ضريبة ١٥٪ آجل + مرتجع ١٠.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PurchaseRow, PurchaseSummary, PurchasesData } from './purchasesReportLogic';

// ── بيئة متصفّحٍ دنيا قبل الاستيراد: مخزن اللغة (utils/format) قد يقرأ localStorage لحظة تحميله ──
const ls = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
for (const [k, v] of Object.entries({
  window: { location: { pathname: '/app/reports' } },
  localStorage: {
    getItem: (key: string) => ls.get(key) ?? null,
    setItem: (key: string, val: string) => { ls.set(key, String(val)); },
    removeItem: (key: string) => { ls.delete(key); },
  },
})) if (!(k in g)) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
const { purchasesTotals, purchasesSheets, purchaseRowName } = await import('./purchasesReportLogic');

const tr = (s: string) => s;

const row = (o: Partial<PurchaseRow>): PurchaseRow => ({
  key: 'v:v1', name: 'مورّد الأمل', net: 2000, tax: 300, total: 2300, returns: 200, returnsTax: 30, returnsTotal: 230,
  netPurchases: 1800, netTax: 270, netTotal: 2070, cash: 0, credit: 2070, unclassified: 0, paid: 0, remaining: 2070,
  bills: 1, returnsCount: 1, qty: null, receivedQty: null, returnedQty: null, ...o,
});
/** إجماليُّ خادمٍ من الصفوف: مفاتيح المال نفسها (والضريبة غائبة حيث غابت عن الصفّ الأول) */
const summaryOf = (rows: PurchaseRow[], o: Partial<PurchaseSummary> = {}): PurchaseSummary => {
  const keys = ['net', 'tax', 'total', 'returns', 'returnsTax', 'returnsTotal', 'netPurchases', 'netTax', 'netTotal', 'cash', 'credit', 'unclassified', 'paid', 'remaining'] as const;
  const s: Record<string, number | null> = {};
  for (const k of keys) if (k in rows[0]) s[k] = rows.some(r => r[k] === null) ? null : rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  return { ...(s as unknown as PurchaseSummary), bills: rows.reduce((a, r) => a + r.bills, 0), returnsCount: 1, vendors: rows.length, products: 1, unpricedEntries: 0, ...o };
};

test('الإجماليات: بلا بحث إجماليُّ الخادم كما هو، ومع البحث مجموعُ الظاهر — والمدفوع null في تجميع الصنف', () => {
  const a = row({});
  const b = row({ key: 'v:v2', name: 'مورّد النور', net: 100, tax: 15, total: 115, returns: 0, returnsTax: 0, returnsTotal: 0, netPurchases: 100, netTax: 15, netTotal: 115, cash: 115, credit: 0, paid: 0, remaining: 0, returnsCount: 0 });
  const summary = summaryOf([a, b]);
  assert.equal(summary.netTotal, 2185);
  assert.equal(purchasesTotals([a], summary, false, 'vendor'), summary);
  const t = purchasesTotals([a], summary, true, 'vendor');
  assert.deepEqual([t.netPurchases, t.netTax, t.netTotal, t.credit, t.paid, t.remaining], [1800, 270, 2070, 2070, 0, 2070]);
  const p = purchasesTotals([row({ key: 'p:p1', paid: null, remaining: null })], summary, true, 'product');
  assert.deepEqual([p.paid, p.remaining], [null, null]);
});

test('أوراق التصدير: الإجماليات ثم الصفوف بأعمدة الشاشة أرقاماً — ومع «إزالة الضريبة» لا عمود ضريبة', () => {
  const r = row({});
  const data: PurchasesData = { groupBy: 'vendor', taxHidden: false, rows: [r], summary: summaryOf([r]) };
  const [tot, rows] = purchasesSheets(data, data.rows, data.summary, tr);
  assert.equal(tot.name, 'الإجماليات');
  assert.equal(tot.rows[0]['صافي المشتريات'], 1800);
  assert.equal(tot.rows[0]['الضريبة'], 270);
  assert.equal(tot.rows[0]['المتبقي'], 2070);
  assert.equal(rows.rows[0]['المورّد'], 'مورّد الأمل');
  assert.equal(rows.rows[0]['عدد الفواتير'], 1);
  assert.ok(!('غير مصنف' in rows.rows[0]), 'عمود «غير مصنف» بلا قيمة');

  const hidden = row({ net: 2300, total: 2300, returns: 230, returnsTotal: 230, netPurchases: 2070, netTotal: 2070 });
  delete hidden.tax; delete hidden.returnsTax; delete hidden.netTax;
  const dh: PurchasesData = { groupBy: 'vendor', taxHidden: true, rows: [hidden], summary: summaryOf([hidden]) };
  for (const sh of purchasesSheets(dh, dh.rows, dh.summary, tr)) {
    for (const k of Object.keys(sh.rows[0])) assert.doesNotMatch(k, /ضريب|الإجمالي$/, `عمود ضريبة ظاهر: ${k}`);
  }
});

test('تجميع الصنف: الرمز والكمية بالأساس، ولا مدفوع ولا متبقٍّ', () => {
  const r = row({ key: 'p:p1', name: 'أرز', code: 'P1', unit: 'حبة', units: [], qty: 90, receivedQty: 100, returnedQty: 10, paid: null, remaining: null });
  const data: PurchasesData = { groupBy: 'product', taxHidden: false, rows: [r], summary: summaryOf([r]) };
  const [tot, rows] = purchasesSheets(data, data.rows, data.summary, tr);
  assert.deepEqual([rows.rows[0]['الصنف'], rows.rows[0]['الرمز'], rows.rows[0]['الكمية']], ['أرز', 'P1', 90]);
  assert.ok(!('المدفوع' in rows.rows[0]) && !('المتبقي' in tot.rows[0]));
});

test('اسم الصفّ: «بلا مورّد» للمورّد الغائب، والشهر باسمه الميلادي', () => {
  assert.equal(purchaseRowName({ key: 'none', name: null }, 'vendor', tr), 'بلا مورّد');
  assert.equal(purchaseRowName({ key: 'p:x', name: null }, 'product', tr), 'صنف محذوف');
  assert.doesNotMatch(purchaseRowName({ key: '2026-11', name: '2026-11' }, 'month', tr), /١٤٤٨|1448|هـ/);
  assert.equal(purchaseRowName({ key: 'bad', name: 'bad' }, 'month', tr), 'bad');
});
