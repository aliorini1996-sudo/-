import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  billTotals, classifyInclusiveLocked, classifyPreview, classifyVatTreatment, draftBillTotals, entryBillTotals, mergeEntries, returnPreview,
  type BillCostLine, type BillTotals, type ReturnBillEntry, type ReturnBillRow, type VatTreatment,
} from './purchaseCalc';

/**
 * معاينة فاتورة المورّد في الواجهة = ما يقيّده الخادم بفرق صفر («ربط الدفاتر» L1). العيب الذي يحرسه هذا الملف: كانت المعاينة تحوّل
 * كل سعرٍ إلى صافٍ بأربع منازل ثم تحسب الضريبة عليه (computeBillTotals على التكلفة المخزَّنة)، والخادم يحسب بـentryBillTotals على
 * السعر كما أُدخل ويجمع الشامل لكل نسبة — فرأى المستخدم 10,000.06 لألف وحدة بسعر ١٠ شاملاً وقُيّد 10,000.00، ومرتجع «غير
 * مستردة» 132.25 وقُيّد 115.
 *
 * ثلاث طبقات:
 *   ١) المتجهات الذهبية المشتركة (purchaseBillGolden.json، وُلّدت من دوال الخادم نفسها) — المرآة وكل معايناتها (النموذج والتصنيف
 *      والمرتجع) تطابقها. تعمل في كل مكان (CI الواجهة بلا اعتماديات الخادم).
 *   ٢) حارسٌ نصّي على قاعدة الخادم: تغيّرت ⇒ يفشل هنا فتُحدَّث المرآة والمتجهات معاً.
 *   ٣) دالّة الخادم نفسها (warehouseBills.ts) على آلاف المتجهات العشوائية، والمتجهات الذهبية ليست قديمة — حين يمكن استيرادها
 *      (اعتماديات backend مثبّتة)، وإلا تُتخطّى بسبب صريح.
 */

const backendRoot = path.resolve(process.cwd(), '..', 'backend', 'src');
const billsFile = path.join(backendRoot, 'services', 'suppliers', 'warehouseBills.ts');
const goldenFile = path.join(process.cwd(), 'src', 'components', 'purchases', 'purchaseBillGolden.json');

interface GoldenLine { qty: number; unitCost: number | null; enteredUnitCost: number | null; taxPct: number }
interface GoldenBill { name: string; decimals: number; costsIncludeTax: boolean; vatTreatment: VatTreatment; lines: GoldenLine[]; expect: BillTotals }
interface GoldenReturn {
  name: string; decimals: number; costsIncludeTax: boolean; vatTreatment: VatTreatment;
  bill: { lines: (GoldenLine & { id: string; productId: string })[]; totals: BillTotals };
  prior: { qty: Record<string, number>; totals: BillTotals }[];
  remaining: Record<string, number>;
  ret: Record<string, number>;
  exhausts: boolean;
  expect: BillTotals;
}
const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8')) as { bills: GoldenBill[]; returns: GoldenReturn[] };

// ─── ١) المتجهات الذهبية ───

test('المتجهات الذهبية: مرآة entryBillTotals تطابق كل فاتورة كما قيّدها الخادم', () => {
  assert.ok(golden.bills.length >= 10 && golden.returns.length >= 5, 'المتجهات الذهبية ناقصة');
  for (const g of golden.bills) {
    assert.deepEqual(entryBillTotals(g.lines, g), g.expect, g.name);
  }
});

test('المتجهات الذهبية: ملخّص نموذج الاستلام (draftBillTotals — الويب والجوال) = الخادم لكل فاتورة أسعارها مُدخلة', () => {
  let n = 0;
  for (const g of golden.bills) {
    // النموذج لا يرسل «غير مستردة» (المعاملة الافتراضية للشركة، وNONE مع «إزالة الضريبة»)، وكل سطرٍ فيه سعرٌ مكتوب
    if (g.vatTreatment === 'NON_RECOVERABLE' || g.lines.some(l => l.enteredUnitCost == null)) continue;
    const rows = g.lines.map(l => ({ qty: String(l.qty), unitCost: String(l.enteredUnitCost), taxPct: String(l.taxPct) }));
    assert.deepEqual(draftBillTotals(rows, { inclusive: g.costsIncludeTax, taxOff: g.vatTreatment === 'NONE' }, g.decimals), g.expect, g.name);
    n++;
  }
  assert.ok(n >= 8, `متجهات النموذج قليلة: ${n}`);
});

test('المتجهات الذهبية: ملخّص التصنيف (classifyPreview) = الخادم — أسعارٌ تُكتب في النافذة، أو أسعارٌ مُدخلة مسبقاً (ربطٌ برمجي)', () => {
  for (const g of golden.bills) {
    const items = g.lines.map((l, k) => ({ id: `i${k}`, productId: `p${k}`, qty: l.qty, unitCost: l.unitCost, enteredUnitCost: l.enteredUnitCost, taxPct: l.taxPct }));
    const productPct = () => 99; // لا يُستعمل: لكل سطرٍ نسبته
    // (أ) الأسطر ذات السعر المُدخل غير مسعَّرة بعد، وتُكتب أسعارها في نافذة التصنيف بالطريقة نفسها
    const typed = items.map(i => (i.enteredUnitCost == null ? i : { ...i, unitCost: null, enteredUnitCost: null }));
    const prices = items.filter(i => i.enteredUnitCost != null).map(i => ({ itemId: i.id, unitCost: String(i.enteredUnitCost), taxPct: String(i.taxPct) }));
    const a = classifyPreview({ items: typed, saved: { vatTreatment: g.vatTreatment }, prices, inclusive: g.costsIncludeTax, taxOff: false, productPct, decimals: g.decimals });
    assert.deepEqual(a.totals, g.expect, `(أ) ${g.name}`);
    // (ب) كلها مسعَّرة مسبقاً بأسعارها المُدخلة و«شاملة» المحفوظة: لا أسعار تُرسل فيأخذ الخادم ما على الحركة
    const b = classifyPreview({
      items, saved: { costsIncludeTax: g.costsIncludeTax, vatTreatment: g.vatTreatment }, prices: [], inclusive: !g.costsIncludeTax, taxOff: false, productPct, decimals: g.decimals,
    });
    assert.deepEqual(b.totals, g.expect, `(ب) ${g.name}`);
  }
});

/** الوارد وصفوف السجلّ من متجه مرتجعٍ ذهبي — بالمتبقّي من الخادم (remainingQty) أو بدونه (يُحسب من أسطر المرتجعات السابقة) */
function returnScenario(g: GoldenReturn, opts: { withRemaining: boolean; negativeRows?: boolean }) {
  const productOf = new Map(g.bill.lines.map(l => [l.id, l.productId]));
  const entry: ReturnBillEntry = {
    id: 'E', type: 'RECEIVE', status: 'POSTED', costsIncludeTax: g.costsIncludeTax, vatTreatment: g.vatTreatment,
    net: g.bill.totals.net, tax: g.bill.totals.tax, total: g.bill.totals.total,
    items: g.bill.lines.map(l => ({
      id: l.id, productId: l.productId, qty: l.qty, unitCost: l.unitCost, enteredUnitCost: l.enteredUnitCost, taxPct: l.taxPct,
      ...(opts.withRemaining && { remainingQty: g.remaining[l.id] ?? 0 }),
    })),
  };
  const sign = opts.negativeRows ? -1 : 1;
  const prior: ReturnBillRow[] = g.prior.map((p, k) => ({
    id: `R${k}`, type: 'RETURN', returnOfEntryId: 'E', status: 'POSTED', net: sign * p.totals.net, tax: sign * p.totals.tax,
    items: Object.entries(p.qty).map(([itemId, q]) => ({ id: `R${k}-${itemId}`, productId: productOf.get(itemId), qty: -q })),
  }));
  const qtys = new Map(Object.entries(g.ret).map(([id, q]) => [id, String(q)] as [string, string]));
  return { entry, prior, qtys };
}

test('المتجهات الذهبية: ملخّص «مرتجع للمورد» (returnPreview) = الخادم — المتبقّي من الفاتورة، والمستنفِد يأخذه حرفياً، والجزئي مقيَّدٌ به', () => {
  for (const g of golden.returns) {
    for (const withRemaining of [true, false]) {
      for (const negativeRows of [false, true]) {
        const { entry, prior, qtys } = returnScenario(g, { withRemaining, negativeRows });
        // صفّ الوارد نفسه وصفٌّ مكرّر ومرتجعٌ ملغى ومرتجع واردٍ آخر في السجلّ لا تغيّر شيئاً
        const noise: ReturnBillRow[] = [
          { id: 'X1', type: 'RETURN', returnOfEntryId: 'E', status: 'CANCELLED', net: 999, tax: 99, items: [{ id: 'x', productId: g.bill.lines[0].productId, qty: -1 }] },
          { id: 'X2', type: 'RETURN', returnOfEntryId: 'OTHER', status: 'POSTED', net: 999, tax: 99, items: [] },
        ];
        const all = mergeEntries<ReturnBillRow>([entry, ...prior, ...noise], prior);
        const p = returnPreview(entry, all, qtys, g.decimals);
        assert.equal(p.lines, Object.keys(g.ret).length, g.name);
        assert.deepEqual(p.totals, g.expect, `${g.name} (remainingQty=${withRemaining}, negative=${negativeRows})`);
      }
    }
  }
});

test('الحالات التي كشفت العيب بالأرقام (ما يُرى قبل الحفظ = ما يُقيَّد)', () => {
  // ألف وحدة بسعر ١٠ شاملاً ١٥٪: 8,695.65 + 1,304.35 = 10,000.00 — لا 8,695.70 + 1,304.36 = 10,000.06
  assert.deepEqual(draftBillTotals([{ qty: '1000', unitCost: '10', taxPct: '15' }], { inclusive: true, taxOff: false }, 2), { net: 8695.65, tax: 1304.35, total: 10000 });
  // والطريق القديم (computeBillTotals على التكلفة المخزَّنة بأربع منازل) هو ما أنتج الفرق — لا يعود إلى المعاينة
  assert.deepEqual(billTotals([{ qty: 1000, unitCost: 8.6957, taxPct: 15 }], 2), { net: 8695.7, tax: 1304.36, total: 10000.06 });
  // السعر بخمس منازل كما كُتب: 1,234.56 لا 1,234.60
  assert.deepEqual(draftBillTotals([{ qty: '1000', unitCost: '1.23456', taxPct: '0' }], { inclusive: false, taxOff: false }, 2), { net: 1234.56, tax: 0, total: 1234.56 });
  // ٢٤٠٠ × ٠٫٥٧ شاملاً: 1,368.00 لا 1,368.13
  assert.equal(draftBillTotals([{ qty: '2400', unitCost: '0.57', taxPct: '15' }], { inclusive: true, taxOff: false }, 2).total, 1368);
  // مرتجع «غير مستردة»: التكلفة المخزَّنة 115 تشمل الضريبة — المعاينة بالسعر المُدخل 100: 100 + 15 = 115 لا 132.25
  const nr: ReturnBillEntry = {
    id: 'N', type: 'RECEIVE', status: 'POSTED', costsIncludeTax: false, vatTreatment: 'NON_RECOVERABLE', net: 1000, tax: 150, total: 1150,
    items: [{ id: 'a', productId: 'p', qty: 10, unitCost: 115, enteredUnitCost: 100, taxPct: 15, remainingQty: 10 }],
  };
  assert.deepEqual(returnPreview(nr, [nr], new Map([['a', '1']]), 2).totals, { net: 100, tax: 15, total: 115 });
  // مرتجع كامل الوارد الشامل يأخذ المتبقّي حرفياً: 10,000.00
  const inc: ReturnBillEntry = {
    id: 'I', type: 'RECEIVE', status: 'POSTED', costsIncludeTax: true, vatTreatment: 'RECOVERABLE', net: 8695.65, tax: 1304.35, total: 10000,
    items: [{ id: 'a', productId: 'p', qty: 1000, unitCost: 8.6957, enteredUnitCost: 10, taxPct: 15, remainingQty: 1000 }],
  };
  assert.deepEqual(returnPreview(inc, [inc], new Map([['a', '1000']]), 2).totals, { net: 8695.65, tax: 1304.35, total: 10000 });
  // ١٢ × ١٫٠٠ شاملاً في التصنيف: 12.00 لا 12.01
  const t = classifyPreview({
    items: [{ id: 'a', productId: 'p', qty: 12, unitCost: null }], saved: {}, prices: [{ itemId: 'a', unitCost: '1', taxPct: '15' }],
    inclusive: true, taxOff: false, productPct: () => 15, decimals: 2,
  });
  assert.deepEqual(t.totals, { net: 10.43, tax: 1.57, total: 12 });
});

test('المرتجع: خادمٌ أقدم بلا إجماليات للوارد ⇒ الحساب بلا قيد المتبقّي؛ والمرتجعات السابقة من مرتجعات المورّد المجلوبة لا من السجلّ المفلتر وحده', () => {
  const base: ReturnBillEntry = {
    id: 'E', type: 'RECEIVE', status: 'POSTED', costsIncludeTax: true, vatTreatment: 'RECOVERABLE',
    items: [{ id: 'a', productId: 'p', qty: 12, unitCost: 0.8696, enteredUnitCost: 1, taxPct: 15, remainingQty: 7 }],
  };
  // بلا total: حساب السطر وحده (7 شاملاً ⇒ 6.09 + 0.91)
  assert.deepEqual(returnPreview(base, [base], new Map([['a', '7']]), 2).totals, { net: 6.09, tax: 0.91, total: 7 });
  // بإجماليات الفاتورة ومرتجعٍ سابق (5 ⇒ 4.35 + 0.65): الباقي يستنفد فيأخذ المتبقّي 6.08 + 0.92
  const withTotals = { ...base, net: 10.43, tax: 1.57, total: 12 };
  const priorRet: ReturnBillRow = { id: 'R', type: 'RETURN', returnOfEntryId: 'E', status: 'POSTED', net: 4.35, tax: 0.65, items: [{ id: 'r', productId: 'p', qty: -5 }] };
  // السجلّ مفلترٌ «وارد» (لا مرتجع فيه) + مرتجعات المورّد المجلوبة
  const pool = mergeEntries<ReturnBillRow>([withTotals], [priorRet]);
  assert.deepEqual(returnPreview(withTotals, pool, new Map([['a', '7']]), 2).totals, { net: 6.08, tax: 0.92, total: 7 });
  assert.deepEqual(mergeEntries([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'a', v: 2 }], null, undefined).map(e => `${e.id}${e.v}`), ['a1', 'b1'], 'الأول يغلب ولا تكرار');
});

test('التصنيف: معاملة الضريبة و«شاملة الضريبة» كما يحلّهما الخادم', () => {
  assert.equal(classifyVatTreatment(undefined, false), 'RECOVERABLE');
  assert.equal(classifyVatTreatment(null, true), 'NONE');
  assert.equal(classifyVatTreatment('NON_RECOVERABLE', false), 'NON_RECOVERABLE', 'وارد الربط البرمجي يُصنَّف بمعاملته المحفوظة');
  assert.equal(classifyVatTreatment('RECOVERABLE', true), 'NONE', 'إزالة الضريبة: الجسم يرسل NONE');
  // أسعارٌ مُدخلة قائمة ⇒ «شاملة» مقيَّدة بالحركة (الخادم يرفض الخلط)؛ التكلفة وحدها (سطرٌ سبق الميزة) لا تقيّد
  assert.equal(classifyInclusiveLocked([{ unitCost: 8.6957, enteredUnitCost: 10 }, { unitCost: null, enteredUnitCost: null }]), true);
  assert.equal(classifyInclusiveLocked([{ unitCost: 4.5, enteredUnitCost: null }, { unitCost: null }]), false);
  // بلا أسعارٍ مُرسلة: «شاملة» المحفوظة تحكم ولو اختلفت الخانة
  const items = [{ id: 'a', productId: 'p', qty: 1000, unitCost: 8.6957, enteredUnitCost: 10, taxPct: 15 }];
  const opts = { items, prices: [], taxOff: false, productPct: () => 15, decimals: 2 };
  assert.equal(classifyPreview({ ...opts, saved: { costsIncludeTax: true }, inclusive: false }).totals.total, 10000);
  assert.equal(classifyPreview({ ...opts, saved: { costsIncludeTax: false }, inclusive: true }).totals.total, 11500);
});

// ─── ٢) حارسٌ نصّي على قاعدة الخادم (يعمل بلا اعتماديات backend) ───

test('قاعدة الخادم التي تعكسها المرآة لم تتغيّر (entryBillTotals والتصنيف والمرتجع) — تغيّرت ⇒ حدّث purchaseCalc والمتجهات الذهبية', () => {
  assert.ok(fs.existsSync(billsFile), 'services/suppliers/warehouseBills.ts غائب');
  const src = fs.readFileSync(billsFile, 'utf8').replace(/\r\n/g, '\n');
  const must = [
    'if (entered != null && opts.costsIncludeTax) {',
    'grossByRate.set(pct, (grossByRate.get(pct) ?? 0) + qty * entered);',
    'const net = entered != null ? entered : l.unitCost;',
    'const ex = computeBillTotals(exclusive, opts.decimals, vt);',
    'const total = toMilliAmount(gross, opts.decimals);',
    'const n = pct > 0 ? toMilliAmount(gross / (1 + pct / 100), opts.decimals) : total;',
    // الوارد المصنَّف والتصنيف بها
    'const totalsOf = () => entryBillTotals(lines.map((l) => ({ qty: l.qty, ...purchaseLineCols(plan, l) })), plan);',
    'const t = entryBillTotals(lines, plan);',
    "const pct = plan.vatTreatment === 'NONE' ? 0 : price?.taxPct ?? i.taxPct ?? productTax.get(i.productId) ?? 0;",
    "costsIncludeTax: typeof body.costsIncludeTax === 'boolean' ? body.costsIncludeTax : e.costsIncludeTax,",
    // المرتجع: المتبقّي، والمستنفِد يأخذه، والجزئي بالسعر المُدخل ومعاملة الوارد مقيَّداً به
    'const exhausts = e.items.every((i) => Math.abs((left.get(i.id) ?? 0) - (want.get(i.id) ?? 0)) <= QTY_EPS);',
    'enteredUnitCost: r.orig.enteredUnitCost, taxPct: r.orig.taxPct })), {',
    "costsIncludeTax: e.costsIncludeTax, vatTreatment: (e.vatTreatment as VatTreatment | null) ?? 'RECOVERABLE', decimals: await tenantCurrencyDecimals(tid),",
  ];
  for (const m of must) assert.ok(src.includes(m), `تغيّرت قاعدة الخادم: ${m}`);
  assert.match(src, /totals = exhausts\n\s+\? residual\n\s+: capTotals\(entryBillTotals\(/, 'المرتجع المستنفِد يأخذ المتبقّي، والجزئي مقيَّدٌ به');
});

// ─── ٣) دالّة الخادم نفسها (حين تُستورد) ───

type Milli = { netMilli: bigint; taxMilli: bigint; totalMilli: bigint };
interface ServerBills {
  entryBillTotals: (l: readonly BillCostLine[], o: { costsIncludeTax: boolean; vatTreatment: VatTreatment; decimals: number }) => Milli;
  inventoryUnitCost: (entered: number, taxPct: number, cit: boolean, vt: VatTreatment) => number;
  remainingByItem: (orig: readonly object[], prior: readonly object[]) => Map<string, number>;
  residualTotals: (bill: Milli, prior: readonly Milli[]) => Milli;
  capTotals: (t: Milli, cap: Milli) => Milli;
}
let serverP: Promise<ServerBills | string> | null = null;
/** دالّة الخادم نفسها — أو سبب تعذّرها (CI الواجهة لا يثبّت اعتماديات backend: Prisma وغيرها) */
const loadServer = (): Promise<ServerBills | string> => (serverP ??= import(pathToFileURL(billsFile).href)
  .then((m: unknown) => m as ServerBills, (e: unknown) => `تعذّر استيراد warehouseBills.ts: ${(e as Error)?.message ?? e}`));
const num = (t: Milli): BillTotals => ({ net: Number(t.netMilli) / 1000, tax: Number(t.taxMilli) / 1000, total: Number(t.totalMilli) / 1000 });

const VTS: VatTreatment[] = ['RECOVERABLE', 'RECOVERABLE', 'NON_RECOVERABLE', 'NONE'];
const RATES = [0, 5, 15, 15, 14, 10];

test('دالّة الخادم entryBillTotals = المرآة على ٤٠٠٠ متجهٍ عشوائي (شامل/صافٍ، المعاملات الثلاث، أسطرٌ سبقت الميزة، منازل ٠ و٢ و٣)', async (t) => {
  const loaded = await loadServer();
  if (typeof loaded === 'string') { t.skip(loaded); return; }
  const srv: ServerBills = loaded;
  let seed = 20261114;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 4000; k++) {
    const vt = VTS[Math.floor(rnd() * VTS.length)];
    const cit = rnd() < 0.5;
    const lines: BillCostLine[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
      const taxPct = RATES[Math.floor(rnd() * RATES.length)];
      const qty = Math.max(1, Math.round(rnd() * 2500)) / (rnd() < 0.3 ? 4 : 1) * (rnd() < 0.1 ? -1 : 1);
      const scale = rnd() < 0.3 ? 1_000_000 : rnd() < 0.5 ? 10_000 : 100;
      const entered = Math.round(rnd() * 120 * scale) / scale || 0.01;
      if (rnd() < 0.15) return { qty, unitCost: Math.round(entered * 10_000) / 10_000, enteredUnitCost: null, taxPct };
      return { qty, unitCost: srv.inventoryUnitCost(entered, taxPct, cit, vt), enteredUnitCost: entered, taxPct };
    });
    for (const decimals of [0, 2, 3]) {
      const o = { costsIncludeTax: cit, vatTreatment: vt, decimals };
      assert.deepEqual(entryBillTotals(lines, o), num(srv.entryBillTotals(lines, o)), `انحراف عند ${JSON.stringify({ lines, o })}`);
    }
  }
});

test('دالّة الخادم = ملخّص النموذج على ٣٠٠٠ متجه (الأسطر كما يكتبها purchaseLineCols من جسم الويب والجوال)', async (t) => {
  const loaded = await loadServer();
  if (typeof loaded === 'string') { t.skip(loaded); return; }
  const srv: ServerBills = loaded;
  let seed = 1311;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 3000; k++) {
    const inclusive = rnd() < 0.5;
    const taxOff = rnd() < 0.2;
    const rows = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
      const scale = rnd() < 0.3 ? 1_000_000 : 10_000;
      return {
        qty: String(Math.max(1, Math.round(rnd() * 3000)) / (rnd() < 0.3 ? 4 : 1)),
        unitCost: String(Math.round(rnd() * 100 * scale) / scale || 0.0001),
        taxPct: String(RATES[Math.floor(rnd() * RATES.length)]),
      };
    });
    const vt: VatTreatment = taxOff ? 'NONE' : 'RECOVERABLE';
    // الخادم: النسبة المرسَلة (صفرٌ مع إزالة الضريبة)، و«شاملة» كما في الجسم (الجوال يرسل الخانة خاماً — بلا أثرٍ مع NONE)
    const srvLines = rows.map(r => {
      const pct = taxOff ? 0 : Number(r.taxPct);
      const entered = Number(r.unitCost);
      return { qty: Number(r.qty), unitCost: srv.inventoryUnitCost(entered, pct, inclusive, vt), enteredUnitCost: entered, taxPct: pct };
    });
    for (const decimals of [0, 2, 3]) {
      assert.deepEqual(draftBillTotals(rows, { inclusive, taxOff }, decimals), num(srv.entryBillTotals(srvLines, { costsIncludeTax: inclusive, vatTreatment: vt, decimals })),
        `انحراف عند ${JSON.stringify(rows)} inclusive=${inclusive} taxOff=${taxOff} dec=${decimals}`);
    }
  }
});

test('دالّة الخادم = معاينة المرتجع على ١٥٠٠ سلسلة مرتجعاتٍ عشوائية (جزئية ثم مستنفِدة)، والمتجهات الذهبية ليست قديمة', async (t) => {
  const loaded = await loadServer();
  if (typeof loaded === 'string') { t.skip(loaded); return; }
  const srv: ServerBills = loaded;
  // الذهبية تُعاد حسابها بالخادم الحالي: فاتورةً فاتورة
  for (const g of golden.bills) assert.deepEqual(num(srv.entryBillTotals(g.lines, g)), g.expect, `متجه ذهبي قديم: ${g.name}`);
  let seed = 777;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 1500; k++) {
    const vt = VTS[Math.floor(rnd() * VTS.length)];
    const cit = rnd() < 0.5;
    const decimals = rnd() < 0.8 ? 2 : 3;
    const orig = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => {
      const taxPct = vt === 'NONE' ? 0 : RATES[Math.floor(rnd() * RATES.length)];
      const entered = Math.round(rnd() * 50 * 10_000) / 10_000 || 0.01;
      return { id: `i${i}`, productId: `p${i}`, qty: 1 + Math.floor(rnd() * 40), unitCost: srv.inventoryUnitCost(entered, taxPct, cit, vt), enteredUnitCost: entered, taxPct };
    });
    const o = { costsIncludeTax: cit, vatTreatment: vt, decimals };
    const bill = srv.entryBillTotals(orig, o);
    const origLines = orig.map(x => ({ ...x, unitName: null, unitFactor: 1, lotId: null }));
    const priorLines: object[] = [];
    const priorTotals: Milli[] = [];
    const rows: ReturnBillRow[] = [];
    // مرتجعاتٌ متتالية حتى ينفد الوارد: كل خطوةٍ كمياتٌ عشوائية من المتبقّي (وأحياناً كله)
    for (let step = 0; step < 6; step++) {
      const left = srv.remainingByItem(origLines, priorLines);
      if ([...left.values()].every(q => q <= 1e-9)) break;
      const want: Record<string, number> = {};
      for (const x of orig) {
        const l = left.get(x.id) ?? 0;
        if (l <= 1e-9) continue;
        const q = rnd() < 0.35 ? l : Math.floor(rnd() * (l + 1));
        if (q > 0) want[x.id] = q;
      }
      if (!Object.keys(want).length) continue;
      const entry: ReturnBillEntry = {
        id: 'E', type: 'RECEIVE', status: 'POSTED', costsIncludeTax: cit, vatTreatment: vt, ...num(bill),
        items: orig.map(x => ({ ...x, remainingQty: left.get(x.id) ?? 0 })),
      };
      const preview = returnPreview(entry, [entry, ...rows], new Map(Object.entries(want).map(([id, q]) => [id, String(q)] as [string, string])), decimals);
      // الخادم: reverseEntryTx
      const residual = srv.residualTotals(bill, priorTotals);
      const exhausts = orig.every(x => Math.abs((left.get(x.id) ?? 0) - (want[x.id] ?? 0)) <= 1e-9);
      const items = orig.filter(x => want[x.id]).map(x => ({ qty: want[x.id], unitCost: x.unitCost, enteredUnitCost: x.enteredUnitCost, taxPct: x.taxPct }));
      const srvT = exhausts ? residual : srv.capTotals(srv.entryBillTotals(items, o), residual);
      assert.deepEqual(preview.totals, num(srvT), `انحراف عند ${JSON.stringify({ orig, o, want, step })}`);
      priorTotals.push(srvT);
      for (const x of orig) if (want[x.id]) priorLines.push({ productId: x.productId, qty: -want[x.id], unitName: null, unitFactor: 1, unitCost: x.unitCost, taxPct: x.taxPct, enteredUnitCost: x.enteredUnitCost, lotId: null });
      const written = num(srvT);
      rows.push({ id: `R${step}`, type: 'RETURN', returnOfEntryId: 'E', status: 'POSTED', net: written.net, tax: written.tax, items: [] });
    }
  }
});
