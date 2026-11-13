import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  billTotals, classifyBody, dayOf, draftBillLines, draftBillTotals, dueDateOf, emptyPurchaseDraft, entryActions, filterEntries, hasReturns, isValidDay,
  lineTaxPct, netUnitCost, paidFromOf, parsePositive, parseTaxPct, purchaseBodyFields, purchaseErrorText, purchaseProblem, remainingByItem,
  returnBody, returnProblem, adjustReasonLabel, WAREHOUSE_ADJUST_REASONS, type PurchaseDraft,
} from './purchaseCalc';

/**
 * «ربط الدفاتر» L1 — منطق واجهة الشراء النقدي/الآجل ومرتجع المورّد. أهمّ ما يُحرس: المعاينة الحيّة تطابق حساب الخادم
 * (computeBillTotals وnetUnitCost) بفرق صفر، وبلا نوع شراء يبقى الجسم كما كان حرفاً.
 */

// ─── مرآة الخادم: الدالّة نفسها من backend تُقارَن بمرآتها هنا على متجهاتٍ كثيرة ───
const backendRoot = path.resolve(process.cwd(), '..', 'backend', 'src');
const coreFile = path.join(backendRoot, 'services', 'suppliers', 'core.ts');

test('الإجماليات: مثالٌ يدوي — الصافي مقرَّب، والضريبة لكل نسبة على مجموع صافي سطورها، والإجمالي جمعٌ بالملّي', () => {
  // 3 × 10.005 = 30.015 ⇒ 30.02؛ و2 × 7.333 = 14.666 ⇒ مع الأول 44.681 ⇒ 44.68
  const t = billTotals([{ qty: 3, unitCost: 10.005, taxPct: 15 }, { qty: 2, unitCost: 7.333, taxPct: 5 }], 2);
  assert.equal(t.net, 44.68);
  // 15٪ من 30.015 = 4.50225 ⇒ 4.50؛ و5٪ من 14.666 = 0.7333 ⇒ 0.73
  assert.equal(t.tax, 5.23);
  assert.equal(t.total, 49.91);
  // بلا ضريبة (NONE / إزالة الضريبة)
  assert.deepEqual(billTotals([{ qty: 3, unitCost: 10.005, taxPct: 15 }], 2, true), { net: 30.02, tax: 0, total: 30.02 });
  // ثلاث منازل (الدينار الكويتي) — 1.0005 × 1 ⇒ 1.001 (نصف لأعلى)، والضريبة 0.150075 ⇒ 0.150
  assert.deepEqual(billTotals([{ qty: 1, unitCost: 1.0005, taxPct: 15 }], 3), { net: 1.001, tax: 0.15, total: 1.151 });
  // الكمية مطلقة (أسطر المرتجع السالبة)، والسطر غير الصالح لا يُحسب
  assert.deepEqual(billTotals([{ qty: -2, unitCost: 5, taxPct: 15 }, { qty: NaN, unitCost: 5, taxPct: 15 }], 2), { net: 10, tax: 1.5, total: 11.5 });
});

test('الإجماليات تطابق computeBillTotals في الخادم حرفاً على ٢٠٠٠ متجهٍ عشوائي (منازل ٠ و٢ و٣)', async () => {
  assert.ok(fs.existsSync(coreFile), 'services/suppliers/core.ts غائب');
  const core = await import(pathToFileURL(coreFile).href) as {
    computeBillTotals: (l: { qty: number; unitCost: number; taxPct: number }[], d: number, v: string | null) => { netMilli: bigint; taxMilli: bigint; totalMilli: bigint };
    milliToNumber: (m: bigint) => number;
  };
  let seed = 20261113;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const rates = [0, 5, 15, 15, 14, 10];
  for (let k = 0; k < 2000; k++) {
    const n = 1 + Math.floor(rnd() * 5);
    const lines = Array.from({ length: n }, () => ({
      qty: Math.round(rnd() * 500) / (rnd() < 0.3 ? 4 : 1) || 1,
      unitCost: Math.round(rnd() * 1_000_000) / 10_000,
      taxPct: rates[Math.floor(rnd() * rates.length)],
    }));
    for (const dec of [0, 2, 3]) {
      for (const none of [false, true]) {
        const mine = billTotals(lines, dec, none);
        const srv = core.computeBillTotals(lines, dec, none ? 'NONE' : 'RECOVERABLE');
        assert.deepEqual(mine, { net: core.milliToNumber(srv.netMilli), tax: core.milliToNumber(srv.taxMilli), total: core.milliToNumber(srv.totalMilli) },
          `انحراف عند ${JSON.stringify(lines)} dec=${dec} none=${none}`);
      }
    }
  }
});

test('تكلفة الوحدة الصافية تطابق netUnitCost في الخادم (netFromInclusive ثم أربع منازل)', async () => {
  const money = await import(pathToFileURL(path.join(backendRoot, 'lib', 'money.ts')).href) as { netFromInclusive: (p: number, t: number) => number; roundHalfUp: (v: number, d?: number) => number };
  // مرآة warehouseCost.netUnitCost (لا يُستورد: يجرّ prisma عبر utils/helpers)
  const srv = (entered: number, pct: number, inclusive: boolean) => {
    if (!Number.isFinite(entered) || entered < 0) return 0;
    return money.roundHalfUp(inclusive ? money.netFromInclusive(entered, pct) : entered, 4);
  };
  const src = fs.readFileSync(path.join(backendRoot, 'services', 'warehouseCost.ts'), 'utf8');
  assert.match(src, /const net = inclusive \? netFromInclusive\(entered, taxPct\) : entered;\n\s+return roundDecimal\(net, COST_DECIMALS\);/, 'تغيّرت قاعدة الخادم — حدّث المرآة');
  for (const entered of [0, 1, 11.5, 115, 99.99, 3.333333, 1e6 + 0.0049]) {
    for (const pct of [0, 5, 15, 14.5, -3]) {
      for (const inc of [false, true]) assert.equal(netUnitCost(entered, pct, inc), srv(entered, pct, inc), `${entered} ${pct} ${inc}`);
    }
  }
  assert.equal(netUnitCost(115, 15, true), 100);
  assert.equal(netUnitCost(10, 15, true), 8.6957);
  assert.equal(netUnitCost(-1, 15, false), 0);
});

test('معاينة النموذج: السعر كما كُتب مع تكلفته المخزَّنة، والسطر بلا سعر أو بكمية غير موجبة خارجها، و«إزالة الضريبة» بلا خصم ولا ضريبة', () => {
  const rows = [
    { qty: '10', unitCost: '115', taxPct: '15' },
    { qty: '2', unitCost: '', taxPct: '15' },
    { qty: '-1', unitCost: '50', taxPct: '15' },
    { qty: '4', unitCost: '21', taxPct: '5' },
  ];
  // السعر المُدخل (enteredUnitCost) هو ما يحسب به الخادم الفاتورة؛ unitCost تكلفة المخزون المخزَّنة (الصافي بأربع منازل) للعرض
  const inc = draftBillLines(rows, { inclusive: true, taxOff: false });
  assert.deepEqual(inc, [{ qty: 10, unitCost: 100, enteredUnitCost: 115, taxPct: 15 }, { qty: 4, unitCost: 20, enteredUnitCost: 21, taxPct: 5 }]);
  // الشامل يُجمع لكل نسبة ثم يُفصل: 1150 ⇒ 1000 + 150، و84 ⇒ 80 + 4
  assert.deepEqual(draftBillTotals(rows, { inclusive: true, taxOff: false }, 2), { net: 1080, tax: 154, total: 1234 });
  const off = draftBillLines(rows, { inclusive: true, taxOff: true });
  assert.deepEqual(off, [{ qty: 10, unitCost: 115, enteredUnitCost: 115, taxPct: 0 }, { qty: 4, unitCost: 21, enteredUnitCost: 21, taxPct: 0 }]);
  assert.deepEqual(draftBillTotals(rows, { inclusive: true, taxOff: true }, 2), { net: 1234, tax: 0, total: 1234 });
});

test('قراءة الخانات: الصفر والفارغ ليسا سعراً، والنسبة بين ٠ و١٠٠، والأيام تقويمية', () => {
  assert.equal(parsePositive(''), null);
  assert.equal(parsePositive('0'), null);
  assert.equal(parsePositive('-2'), null);
  assert.equal(parsePositive('abc'), null);
  assert.equal(parsePositive(' 4.5 '), 4.5);
  assert.equal(parseTaxPct(''), null);
  assert.equal(parseTaxPct('0'), 0);
  assert.equal(parseTaxPct('15'), 15);
  assert.equal(parseTaxPct('101'), null);
  assert.equal(parseTaxPct('-1'), null);
  assert.equal(isValidDay('2026-02-29'), false);
  assert.equal(isValidDay('2028-02-29'), true);
  assert.equal(dayOf('2026-11-13T00:00:00.000Z'), '2026-11-13');
  assert.equal(dayOf(null), null);
  assert.equal(lineTaxPct('15', true), 0);
  assert.equal(lineTaxPct('x', false), 0);
});

test('الاستحقاق = تاريخ الفاتورة + مدة المورّد (computeDueDate)، وبلا مدة يومها', () => {
  assert.equal(dueDateOf('2026-11-13', 30), '2026-12-13');
  assert.equal(dueDateOf('2026-12-31', 1), '2027-01-01');
  assert.equal(dueDateOf('2026-11-13', null), '2026-11-13');
  assert.equal(dueDateOf('2026-11-13', 0), '2026-11-13');
  assert.equal(dueDateOf('2026-11-13', 2.5), '2026-11-13', 'مدةٌ غير صحيحة كالخادم: بلا مدة');
  assert.equal(dueDateOf('bad', 30), null);
});

const draft = (p: Partial<PurchaseDraft>): PurchaseDraft => ({ ...emptyPurchaseDraft('2026-11-13'), ...p });

test('بلا نوع شراء: لا مشكلة ولا حقل — الجسم كما كان حرفاً', () => {
  assert.equal(purchaseProblem(draft({}), null, [{ unitCost: '', taxPct: '' }], { taxOff: false }), null);
  assert.deepEqual(purchaseBodyFields(draft({ supplierRef: 'INV-1' }), { taxOff: false }), {});
});

test('الشراء المصنَّف: المورّد ثم المندوب ثم رقم الفاتورة والتاريخ ثم السعر لكل سطر ثم النسبة', () => {
  const lines = [{ unitCost: '10', taxPct: '15' }];
  assert.equal(purchaseProblem(draft({ mode: 'CREDIT' }), null, lines, { taxOff: false }), 'VENDOR_REQUIRED');
  assert.equal(purchaseProblem(draft({ mode: 'CASH', paidFrom: 'REP_CUSTODY' }), 'v1', lines, { taxOff: false }), 'REP_REQUIRED');
  assert.equal(purchaseProblem(draft({ mode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'r1' }), 'v1', lines, { taxOff: false }), null);
  assert.equal(purchaseProblem(draft({ mode: 'CREDIT', paidFrom: 'REP_CUSTODY' }), 'v1', lines, { taxOff: false }), null, 'العهدة للنقدي وحده');
  assert.equal(purchaseProblem(draft({ mode: 'CREDIT', supplierRef: 'x'.repeat(61) }), 'v1', lines, { taxOff: false }), 'SUPPLIER_REF_TOO_LONG');
  assert.equal(purchaseProblem(draft({ mode: 'CREDIT', billDate: '2026-13-01' }), 'v1', lines, { taxOff: false }), 'BILL_DATE_INVALID');
  assert.equal(purchaseProblem(draft({ mode: 'CREDIT' }), 'v1', [...lines, { unitCost: '0', taxPct: '15' }], { taxOff: false }), 'PRICE_REQUIRED');
  assert.equal(purchaseProblem(draft({ mode: 'CREDIT' }), 'v1', [{ unitCost: '5', taxPct: '' }], { taxOff: false }), 'TAX_INVALID');
  assert.equal(purchaseProblem(draft({ mode: 'CREDIT' }), 'v1', [{ unitCost: '5', taxPct: '' }], { taxOff: true }), null, 'لا خانة نسبة مع إزالة الضريبة');
});

test('جسم الشراء: النقدي بمصدره (والعهدة بمندوبها)، والآجل بلا مصدر، و«إزالة الضريبة» NONE', () => {
  assert.deepEqual(purchaseBodyFields(draft({ mode: 'CASH', paidFrom: 'BANK', supplierRef: ' F-77 ', paidFromRepId: 'r1' }), { taxOff: false }),
    { paymentMode: 'CASH', paidFrom: 'BANK', supplierRef: 'F-77', billDate: '2026-11-13' });
  assert.deepEqual(purchaseBodyFields(draft({ mode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'r1' }), { taxOff: false }),
    { paymentMode: 'CASH', paidFrom: 'REP_CUSTODY', paidFromRepId: 'r1', billDate: '2026-11-13' });
  assert.deepEqual(purchaseBodyFields(draft({ mode: 'CREDIT', paidFrom: 'BANK', billDate: '' }), { taxOff: true }),
    { paymentMode: 'CREDIT', vatTreatment: 'NONE' });
});

test('مصدر الدفع المحفوظ يُقرأ كـparsePaidAccountRef', () => {
  assert.deepEqual(paidFromOf('MAIN_CASH'), { kind: 'MAIN_CASH' });
  assert.deepEqual(paidFromOf('BANK'), { kind: 'BANK' });
  assert.deepEqual(paidFromOf('REP_CUSTODY:abc'), { kind: 'REP_CUSTODY', repId: 'abc' });
  assert.equal(paidFromOf('REP_CUSTODY:'), null);
  assert.equal(paidFromOf(null), null);
});

test('رسائل الخادم: الرمز المعروف بنصّه العربي، وإلا رسالة الخادم، وإلا null', () => {
  const err = (data: unknown) => ({ response: { data } });
  assert.equal(purchaseErrorText(err({ code: 'RETURN_EXCEEDS_RECEIVED', message: 'x' })), 'كمية المرتجع أكبر من المتبقي من الوارد');
  assert.equal(purchaseErrorText(err({ code: 'BILL_HAS_PAYMENTS' })), 'على هذه الفاتورة دفعات سارية ألغ سندات الصرف المخصصة لها أولا');
  assert.equal(purchaseErrorText(err({ code: 'OTHER', message: 'رسالة الخادم' })), 'رسالة الخادم');
  assert.equal(purchaseErrorText(new Error('net')), null);
  // كل رمزٍ في العقد له نصّ
  for (const c of ['PURCHASE_VENDOR_REQUIRED', 'PURCHASE_PRICE_REQUIRED', 'ENTRY_ALREADY_CLASSIFIED', 'SUPPLIER_CODE_EXISTS', 'SUPPLIER_VAT_EXISTS']) {
    assert.notEqual(purchaseErrorText(err({ code: c })), null, c);
  }
});

// ─── المرتجع ───
const receive = {
  id: 'E1', type: 'RECEIVE',
  items: [
    { id: 'i1', productId: 'p1', qty: 10, unitFactor: 24, baseQty: 240, lot: { lotNumber: 'L1' } },
    { id: 'i2', productId: 'p1', qty: 5, unitFactor: 24, baseQty: 120, lot: { lotNumber: 'L2' } },
    { id: 'i3', productId: 'p2', qty: 7, unitFactor: 1, baseQty: 7, lot: null },
  ],
};
const ret = (id: string, items: { productId: string; qty: number; unitFactor?: number; baseQty?: number; lot?: { lotNumber: string } | null }[], of = 'E1') =>
  ({ id, type: 'RETURN', returnOfEntryId: of, items: items.map((x, k) => ({ id: `${id}-${k}`, ...x })) });

test('المتبقّي للإرجاع: كل سطرٍ بصنفه وتشغيلته، والمرتجع بالأساس يُعاد إلى وحدة السطر', () => {
  const all = [receive, ret('R1', [{ productId: 'p1', qty: -3, unitFactor: 24, baseQty: -72, lot: { lotNumber: 'L1' } }]),
    ret('R2', [{ productId: 'p2', qty: -2.5, unitFactor: 1, baseQty: -2.5 }]),
    // مرتجعٌ لحركةٍ أخرى لا يُحسب
    ret('R3', [{ productId: 'p1', qty: -10, unitFactor: 24, baseQty: -240, lot: { lotNumber: 'L1' } }], 'E2'),
    // سطرٌ قسّمه الخادم بالأساس (حبّات): 12 حبة = نصف كرتون من L2
    ret('R4', [{ productId: 'p1', qty: -12, unitFactor: 1, baseQty: -12, lot: { lotNumber: 'L2' } }])];
  const m = remainingByItem(receive, all);
  assert.equal(m.get('i1'), 7);
  assert.equal(m.get('i2'), 4.5);
  assert.equal(m.get('i3'), 4.5);
  assert.equal(hasReturns('E1', all), true);
  assert.equal(hasReturns('E9', all), false);
  // المتبقّي من الخادم يُقدَّم متى وصل لكل سطر
  const srv = { ...receive, items: receive.items.map(i => ({ ...i, remainingQty: 1 })) };
  assert.deepEqual([...remainingByItem(srv, all).values()], [1, 1, 1]);
  // مرتجعٌ أكبر من سطرٍ واحد للصنف والتشغيلة نفسيهما يُوزَّع على أسطرهما بترتيبها ولا يقلّ عن صفر
  const twin = { id: 'E3', type: 'RECEIVE', items: [{ id: 'a', productId: 'p', qty: 2 }, { id: 'b', productId: 'p', qty: 3 }] };
  const m2 = remainingByItem(twin, [ret('R5', [{ productId: 'p', qty: -4 }], 'E3')]);
  assert.deepEqual([m2.get('a'), m2.get('b')], [0, 1]);
});

test('مشكلة المرتجع: لا شيء، أو كمية سالبة، أو فوق المتبقّي', () => {
  const rem = new Map([['i1', 7], ['i3', 4.5]]);
  const o = { supplierRef: '', billDate: '' };
  assert.equal(returnProblem(new Map([['i1', ''], ['i3', '0']]), rem, o), 'NOTHING');
  assert.equal(returnProblem(new Map([['i1', '-1']]), rem, o), 'QTY_INVALID');
  assert.equal(returnProblem(new Map([['i1', 'x']]), rem, o), 'QTY_INVALID');
  assert.equal(returnProblem(new Map([['i3', '4.6']]), rem, o), 'OVER_REMAINING');
  assert.equal(returnProblem(new Map([['i3', '4.5'], ['i1', '7']]), rem, o), null);
  assert.equal(returnProblem(new Map([['i9', '1']]), rem, o), 'OVER_REMAINING', 'سطرٌ لا متبقّي له');
  assert.equal(returnProblem(new Map([['i1', '1']]), rem, { supplierRef: '', billDate: '2026-02-30' }), 'BILL_DATE_INVALID');
});

test('جسم المرتجع: الكميات الموجبة وحدها، والاسترداد النقدي بوجهته، والآجل بلا وجهة', () => {
  const qtys = new Map([['i1', '2'], ['i2', ''], ['i3', '0']]);
  assert.deepEqual(returnBody({ qtys, note: ' تالف ', supplierRef: 'CN-1', billDate: '2026-11-13', refundMode: 'CASH', refundTo: 'BANK' }),
    { items: [{ itemId: 'i1', qty: 2 }], note: 'تالف', supplierRef: 'CN-1', billDate: '2026-11-13', refundMode: 'CASH', refundTo: 'BANK' });
  assert.deepEqual(returnBody({ qtys, note: '', supplierRef: '', billDate: '', refundMode: 'CREDIT', refundTo: 'BANK' }),
    { items: [{ itemId: 'i1', qty: 2 }], refundMode: 'CREDIT' });
});

test('جسم التصنيف: الأسعار للأسطر غير المسعَّرة المكتوبة وحدها، و«شاملة الضريبة» معها وحدها', () => {
  const d = { ...draft({ mode: 'CASH', paidFrom: 'MAIN_CASH', supplierRef: 'F-9' }), mode: 'CASH' as const };
  assert.deepEqual(classifyBody({ vendorId: 'v1', draft: d, costsIncludeTax: true, taxOff: false, prices: [{ itemId: 'i1', unitCost: '11.5', taxPct: '15' }, { itemId: 'i2', unitCost: '', taxPct: '15' }] }), {
    vendorId: 'v1', paymentMode: 'CASH', paidFrom: 'MAIN_CASH', supplierRef: 'F-9', billDate: '2026-11-13', costsIncludeTax: true,
    prices: [{ itemId: 'i1', unitCost: 11.5, taxPct: 15 }],
  });
  const c = { ...draft({ mode: 'CREDIT' }), mode: 'CREDIT' as const };
  assert.deepEqual(classifyBody({ vendorId: 'v1', draft: c, costsIncludeTax: true, taxOff: true, prices: [{ itemId: 'i1', unitCost: '8', taxPct: '15' }] }), {
    vendorId: 'v1', paymentMode: 'CREDIT', billDate: '2026-11-13', costsIncludeTax: false, vatTreatment: 'NONE', prices: [{ itemId: 'i1', unitCost: 8, taxPct: 0 }],
  });
  assert.deepEqual(classifyBody({ vendorId: 'v1', draft: c, costsIncludeTax: true, taxOff: false, prices: [] }), { vendorId: 'v1', paymentMode: 'CREDIT', billDate: '2026-11-13' });
});

test('أفعال السجلّ: التصنيف لغير المصنَّف، والمرتجع للمصنَّف ببقية، والإلغاء لوارد سارٍ — ولا شيء لخادمٍ أقدم أو بلا صلاحية', () => {
  const on = { canEdit: true, anyRemaining: true };
  assert.deepEqual(entryActions({ type: 'RECEIVE', status: 'POSTED', paymentMode: null }, on), { classify: true, ret: false, cancel: true });
  assert.deepEqual(entryActions({ type: 'RECEIVE', status: 'POSTED', paymentMode: 'CREDIT' }, on), { classify: false, ret: true, cancel: true });
  assert.deepEqual(entryActions({ type: 'RECEIVE', status: 'POSTED', paymentMode: 'CASH' }, { canEdit: true, anyRemaining: false }), { classify: false, ret: false, cancel: true });
  const none = { classify: false, ret: false, cancel: false };
  assert.deepEqual(entryActions({ type: 'RECEIVE', status: 'CANCELLED', paymentMode: 'CASH' }, on), none);
  assert.deepEqual(entryActions({ type: 'RECEIVE', paymentMode: null }, on), none, 'خادمٌ أقدم بلا status');
  assert.deepEqual(entryActions({ type: 'ADJUST', status: 'POSTED' }, on), none);
  assert.deepEqual(entryActions({ type: 'RETURN', status: 'POSTED' }, on), none);
  assert.deepEqual(entryActions({ type: 'RECEIVE', status: 'POSTED', source: 'OPENING_IMPORT' }, on), none, 'الافتتاحي ليس شراءً');
  assert.deepEqual(entryActions({ type: 'RECEIVE', status: 'POSTED' }, { canEdit: false, anyRemaining: true }), none);
});

test('فلتر السجلّ على الصفوف يكرّر فلتر الخادم', () => {
  const rows = [{ id: '1', type: 'RECEIVE', vendorId: 'v1' }, { id: '2', type: 'RETURN', vendorId: 'v1' }, { id: '3', type: 'ADJUST', vendorId: null }];
  assert.deepEqual(filterEntries(rows, {}).map(r => r.id), ['1', '2', '3']);
  assert.deepEqual(filterEntries(rows, { type: 'RETURN' }).map(r => r.id), ['2']);
  assert.deepEqual(filterEntries(rows, { vendorId: 'v1' }).map(r => r.id), ['1', '2']);
});

test('أسباب التسوية مرآة WAREHOUSE_ADJUST_REASONS في الخادم بترتيبها', () => {
  const src = fs.readFileSync(coreFile, 'utf8');
  const m = /export const WAREHOUSE_ADJUST_REASONS = \[([^\]]*)\] as const;/.exec(src);
  assert.ok(m, 'الثابت غائب من الخادم');
  assert.deepEqual([...WAREHOUSE_ADJUST_REASONS], [...m[1].matchAll(/'([A-Z_]+)'/g)].map(x => x[1]));
  assert.equal(adjustReasonLabel('DAMAGE'), 'تالف');
  assert.equal(adjustReasonLabel('NOPE'), null);
  assert.equal(adjustReasonLabel(null), null);
});
