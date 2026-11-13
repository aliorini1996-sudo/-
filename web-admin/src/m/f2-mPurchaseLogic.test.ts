import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyItems, cancelEffects, entriesFilterOf, entryFacts, entryKindOf, invalidateKeys, knownPurchaseError, lineTaxText,
  mDraftBillLines, mDraftBillTotals, mEntryActions, paidOnCredit, problemLines, purchaseLineNet, receiptDayOf, returnDefaults, returnNoTax, rowTaxPct,
  unpricedItems, vanReasonLabel, withVendorSupplier, M_WH_KEYS, VAN_REASON_LABELS, type MPurchaseRow,
} from './MPurchaseLogic';
import {
  classifyPreview, draftBillOpts, emptyPurchaseDraft, entryBillTotals, purchaseBodyFields, purchaseProblem, returnPreview, type ClassifyPriceDraft,
} from '../components/purchases/purchaseCalc';
import type { PurchaseEntry, PurchaseEntryItem } from '../components/purchases/purchaseTypes';
import { LOT_CACHE_KEYS } from './mLotsLogic';

/**
 * «ربط الدفاتر» L1 على الجوال (/m) — وكيل F2. أهمّ ما يُحرس:
 *  ١) معاينة الشراء في نموذج الجوال (بخانة النسبة النصّية وافتراضها نسبة الصنف) تطابق ما يكتبه الخادم — أسطره كما يحفظها
 *     purchaseLineCols (السعر المُدخل ونسبة السطر المرسَلة) في مرآة entryBillTotals — بفرق صفر على آلاف المتجهات (ومطابقة المرآة
 *     لدالّة الخادم نفسها ومتجهاتها الذهبية في components/purchases/fix-purchasePreviewParity.test.ts)؛
 *  ٢) وقائع صفّ السجلّ وأفعاله (تصنيف/مرتجع/إلغاء) كما في اللوحة، وخادمٌ أقدم بلا حالة ⇒ لا شيء؛
 *  ٣) الشاشات موصولة: الجسم بلا حقلٍ جديد بلا نوع شراء، وتنبيه ATTACHMENTS_NOT_SAVED واللوط باقيان.
 */

const backendCore = path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'suppliers', 'core.ts');

const row = (qty: string, unitCost: string, taxPct: number, taxText: string): MPurchaseRow => ({ qty, unitCost, taxPct, taxText });

// ─── سطر النموذج ───

test('نسبة السطر: المكتوبة أولاً، وفارغةً نسبة الصنف، وصفرٌ مع «إزالة الضريبة»', () => {
  assert.equal(lineTaxText(row('1', '10', 15, '5')), '5');
  assert.equal(lineTaxText(row('1', '10', 15, '')), '15', 'سطر «تسوية» قُلب وارداً لا يُحسب بصفرٍ صامت');
  assert.equal(lineTaxText(row('1', '10', 15, '   ')), '15');
  assert.equal(lineTaxText(row('1', '10', 15, '0')), '0', 'الصفر المكتوب صفر لا افتراض');
  assert.equal(lineTaxText({ taxPct: NaN, taxText: '' }), '0');
  assert.equal(rowTaxPct(row('1', '10', 15, ''), false), 15);
  assert.equal(rowTaxPct(row('1', '10', 15, '5'), true), 0, 'إزالة الضريبة ⇒ النسبة المرسَلة صفر');
  assert.equal(rowTaxPct(row('1', '10', 15, '150'), false), 0, 'نسبة خارج المدى لا تُرسل (purchaseProblem يمنع الحفظ قبلها)');
  // purchaseProblem يقرأ النسبة الفعلية — الفارغة بافتراضها صالحة، وخارج المدى تمنع
  const d = { ...emptyPurchaseDraft('2026-11-13'), mode: 'CREDIT' as const };
  assert.equal(purchaseProblem(d, 'v1', problemLines([row('2', '10', 15, '')]), { taxOff: false }), null);
  assert.equal(purchaseProblem(d, 'v1', problemLines([row('2', '10', 15, '150')]), { taxOff: false }), 'TAX_INVALID');
  assert.equal(purchaseProblem(d, 'v1', problemLines([row('2', '', 15, '15')]), { taxOff: false }), 'PRICE_REQUIRED');
  assert.equal(purchaseProblem(d, null, problemLines([row('2', '10', 15, '15')]), { taxOff: false }), 'VENDOR_REQUIRED');
  assert.equal(purchaseProblem(d, 'v1', problemLines([row('2', '10', 15, '150')]), { taxOff: true }), null, 'لا خانة نسبة مع إزالة الضريبة');
});

test('معاينة الجوال = ما يكتبه الخادم (السعر المُدخل ونسبة السطر المرسَلة ⇐ entryBillTotals) على ٣٠٠٠ متجه — منازل ٠ و٢ و٣، شامل/صافٍ، وإزالة الضريبة', () => {
  let seed = 13112026;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const rates = [0, 5, 15, 15, 14, 10];
  for (let k = 0; k < 3000; k++) {
    const n = 1 + Math.floor(rnd() * 5);
    const rows: MPurchaseRow[] = Array.from({ length: n }, () => {
      const prodPct = rates[Math.floor(rnd() * rates.length)];
      const typed = rnd() < 0.35 ? '' : String(rates[Math.floor(rnd() * rates.length)]);
      const qty = Math.max(1, Math.round(rnd() * 500)) / (rnd() < 0.3 ? 4 : 1);
      // أسعارٌ بأربع منازل وأحياناً بست — الخادم يحسب الفاتورة بالسعر كما كُتب (لا بالتكلفة المخزَّنة بأربع منازل)
      const scale = rnd() < 0.25 ? 1_000_000 : 10_000;
      return row(String(qty), String(Math.round(rnd() * 100 * scale) / scale || 0.0001), prodPct, typed);
    });
    const inclusive = rnd() < 0.5;
    const taxOff = rnd() < 0.2;
    for (const dec of [0, 2, 3]) {
      const mine = mDraftBillTotals(rows, { inclusive, taxOff }, dec);
      // الخادم (purchaseLineCols): enteredUnitCost = السعر المكتوب، وtaxPct = النسبة المرسَلة (rowTaxPct)، وNONE مع إزالة الضريبة
      const srvLines = rows.map(r => ({ qty: Number(r.qty), unitCost: null, enteredUnitCost: Number(r.unitCost), taxPct: rowTaxPct(r, taxOff) }));
      assert.deepEqual(mine, entryBillTotals(srvLines, draftBillOpts({ inclusive, taxOff }, dec)),
        `انحراف عند ${JSON.stringify(rows)} inclusive=${inclusive} taxOff=${taxOff} dec=${dec}`);
    }
  }
  // الحالة التي كشفت العيب: ١٢ × ١٫٠٠ شاملة ١٥٪ (افتراض نسبة الصنف) ⇒ 12.00 كفاتورة المورّد — لا 12.01 من الصافي بأربع منازل
  assert.deepEqual(mDraftBillTotals([row('12', '1', 15, '')], { inclusive: true, taxOff: false }, 2), { net: 10.43, tax: 1.57, total: 12 });
});

const near = (a: number | null, b: number, msg?: string) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}${msg ? ` — ${msg}` : ''}`);

test('قيمة السطر في الشراء المصنَّف: حصّته الدقيقة من صافي الفاتورة (السعر كما كُتب، والشامل مردوداً بنسبته) — ومجموعها مقرَّباً = صافي الملخّص', () => {
  // 115 شامل 15٪ ⇒ 100 صافٍ؛ و10.01 شامل 15٪ ⇒ 8.70434… (بلا تقريب الوحدة لأربع منازل: الخادم لا يحسب الفاتورة به)
  near(purchaseLineNet(row('2', '115', 15, '15'), { inclusive: true, taxOff: false }), 200);
  near(purchaseLineNet(row('3', '10.01', 15, ''), { inclusive: true, taxOff: false }), 30.03 / 1.15);
  near(purchaseLineNet(row('3', '10.01', 15, ''), { inclusive: true, taxOff: true }), 30.03, 'إزالة الضريبة: لا استخراج');
  near(purchaseLineNet(row('1000', '1.23456', 0, '0'), { inclusive: false, taxOff: false }), 1234.56, 'السعر بخمس منازل كما كُتب');
  assert.equal(purchaseLineNet(row('3', '', 15, ''), { inclusive: false, taxOff: false }), null, 'بلا سعر');
  assert.equal(purchaseLineNet(row('-3', '10', 15, ''), { inclusive: false, taxOff: false }), null, 'كمية غير موجبة');
  const rows = [row('3', '10.01', 15, ''), row('7', '3.333', 5, '5'), row('1', '0.005', 15, '15')];
  const opts = { inclusive: true, taxOff: false };
  const sum = rows.reduce((s, r) => s + (purchaseLineNet(r, opts) ?? 0), 0);
  assert.equal(Math.round(sum * 100) / 100, mDraftBillTotals(rows, opts, 2).net);
  // ألف وحدة بسعر ١٠ شاملاً: السطر 8,695.65 كالملخّص والخادم — لا 8,695.70 (١٠٠٠ × 8.6957)
  assert.equal(Math.round((purchaseLineNet(row('1000', '10', 15, ''), opts) ?? 0) * 100) / 100, 8695.65);
  assert.equal(mDraftBillLines([row('1000', '10', 15, '')], opts)[0].enteredUnitCost, 10, 'السعر المُدخل يصل الحساب كما كُتب');
});

// ─── السجلّ ───

const item = (id: string, qty: number, unitCost: number | null, extra: Partial<PurchaseEntryItem> = {}): PurchaseEntryItem => ({
  id, productId: `p-${id}`, qty, unitCost, product: { name: `صنف ${id}`, unit: 'حبة' }, ...extra,
});
const entry = (over: Partial<PurchaseEntry> & { id: string }): PurchaseEntry => ({
  type: 'RECEIVE', supplier: null, note: null, createdAt: '2026-11-01T08:00:00.000Z', items: [], totalCost: 0, status: 'POSTED', ...over,
});

test('وقائع الصفّ: خادمٌ أقدم بلا حالة ⇒ null (الصفّ كما كان)، والآجل المتأخّر والملغى والمرتجع والنقدي من عهدة', () => {
  assert.equal(entryFacts(entry({ id: 'a', status: undefined }), [], '2026-11-13'), null);
  assert.equal(entryFacts(entry({ id: 'a', status: null }), [], '2026-11-13'), null);

  const credit = entry({ id: 'c', paymentMode: 'CREDIT', dueDate: '2026-11-10T00:00:00.000Z', billDate: '2026-10-11', supplierRef: 'INV-9', net: 100, tax: 15, total: 115, outstanding: 40, paid: 75 });
  const f = entryFacts(credit, [credit], '2026-11-13')!;
  assert.equal(f.kind, 'RECEIVE');
  assert.equal(f.mode, 'CREDIT');
  assert.equal(f.dueDay, '2026-11-10');
  assert.equal(f.billDay, '2026-10-11');
  assert.equal(f.supplierRef, 'INV-9');
  assert.equal(f.overdue, true, 'متبقٍّ بعد الاستحقاق');
  assert.equal(f.showTotals, true);
  assert.deepEqual([f.net, f.tax, f.total, f.outstanding], [100, 15, 115, 40]);
  assert.equal(entryFacts({ ...credit, dueDate: '2026-11-13' }, [], '2026-11-13')!.overdue, false, 'يوم الاستحقاق نفسه ليس تأخيراً');
  assert.equal(entryFacts({ ...credit, outstanding: 0 }, [], '2026-11-13')!.overdue, false, 'المسدَّدة لا تتأخّر');
  assert.equal(entryFacts({ ...credit, status: 'CANCELLED' }, [], '2026-11-13')!.overdue, false, 'الملغاة لا تتأخّر');
  assert.equal(entryFacts({ ...credit, status: 'CANCELLED' }, [], '2026-11-13')!.cancelled, true);

  const cash = entry({ id: 'k', paymentMode: 'CASH', paidAccountRef: 'REP_CUSTODY:rep-1', total: 50 });
  assert.deepEqual(entryFacts(cash, [], '2026-11-13')!.paidFrom, { kind: 'REP_CUSTODY', repId: 'rep-1' });
  assert.deepEqual(entryFacts({ ...cash, paidAccountRef: 'BANK' }, [], '2026-11-13')!.paidFrom, { kind: 'BANK' });

  // المرتجع: نوعه وقيمه المطلقة (تصل سالبة) ومبالغه ظاهرة بلا نوع شراء
  const ret = entry({ id: 'r', type: 'RETURN', returnOfEntryId: 'k', net: -20, tax: -3, total: -23, supplierRef: 'CN-1' });
  const rf = entryFacts(ret, [], '2026-11-13')!;
  assert.equal(rf.kind, 'RETURN');
  assert.equal(rf.mode, null);
  assert.equal(rf.showTotals, true);
  assert.deepEqual([rf.net, rf.tax, rf.total], [20, 3, 23]);
  assert.equal(entryFacts(cash, [cash, ret], '2026-11-13')!.returned, true, 'وسم «عليها مرتجع»');
  assert.equal(entryFacts(cash, [cash], '2026-11-13')!.returned, false);

  // غير المصنَّف والافتتاحي والربط البرمجي وسبب التسوية
  const un = entryFacts(entry({ id: 'u', source: 'API', totalCost: 30, total: null }), [], '2026-11-13')!;
  assert.equal(un.unclassified, true);
  assert.equal(un.api, true);
  assert.equal(un.showTotals, false, 'غير المصنَّف يبقى بقيمة البضاعة القائمة');
  const op = entryFacts(entry({ id: 'o', source: 'OPENING_IMPORT' }), [], '2026-11-13')!;
  assert.equal(op.unclassified, false);
  assert.equal(op.opening, true);
  assert.equal(entryFacts(entry({ id: 'd', type: 'ADJUST', reason: 'DAMAGE' }), [], '2026-11-13')!.reason, 'تالف');
  assert.equal(entryFacts(entry({ id: 'd', type: 'ADJUST', reason: 'WHATEVER' }), [], '2026-11-13')!.reason, null);
  assert.equal(entryFacts(entry({ id: 'd', type: 'RECEIVE', reason: 'DAMAGE' }), [], '2026-11-13')!.reason, null, 'السبب للتسوية وحدها');
  assert.equal(entryKindOf('SOMETHING'), 'ADJUST', 'نوعٌ مجهول يُعرض تسويةً كما كان');
});

test('أفعال الصفّ: تصنيف لغير المصنَّف، ومرتجع لمصنَّفٍ بقي منه شيء، وإلغاء لساري — ولا شيء لملغى/افتتاحي/تسوية/خادمٍ أقدم', () => {
  const un = entry({ id: 'u', items: [item('1', 10, null)] });
  assert.deepEqual(mEntryActions(un, [un]), { classify: true, ret: false, cancel: true });

  const cash = entry({ id: 'k', paymentMode: 'CASH', items: [item('1', 10, 5), item('2', 4, 2)] });
  assert.deepEqual(mEntryActions(cash, [cash]), { classify: false, ret: true, cancel: true });
  // مرتجعٌ كامل للسطرين (كمياته سالبة بالأساس) ⇒ لا مرتجع بعده، والإلغاء باقٍ للخادم أن يحكم
  const back = entry({ id: 'r', type: 'RETURN', returnOfEntryId: 'k', items: [item('r1', -10, 5, { productId: 'p-1' }), item('r2', -4, 2, { productId: 'p-2' })] });
  assert.deepEqual(mEntryActions(cash, [cash, back]), { classify: false, ret: false, cancel: true });
  // المتبقّي من الخادم يُقدَّم على الحساب من السجلّ
  const srvRem = entry({ id: 'k2', paymentMode: 'CREDIT', items: [item('1', 10, 5, { remainingQty: 0 })] });
  assert.equal(mEntryActions(srvRem, [srvRem]).ret, false);

  const none = { classify: false, ret: false, cancel: false };
  assert.deepEqual(mEntryActions({ ...cash, status: 'CANCELLED' }, []), none);
  assert.deepEqual(mEntryActions({ ...cash, status: undefined }, []), none, 'خادمٌ أقدم: المسارات غير موجودة');
  assert.deepEqual(mEntryActions(entry({ id: 'o', source: 'OPENING_IMPORT' }), []), none, 'الافتتاحي له تراجع الاستيراد');
  assert.deepEqual(mEntryActions(entry({ id: 'a', type: 'ADJUST' }), []), none);
  assert.deepEqual(mEntryActions(entry({ id: 'r', type: 'RETURN' }), []), none);
});

test('فلتر السجلّ واسم المورّد: بلا فلتر لا معاملات (الطلب كما كان)، والصفّ بلا مورّدٍ نصّي يأخذ اسم المسجَّل', () => {
  assert.equal(entriesFilterOf(null, ''), undefined);
  assert.equal(entriesFilterOf(undefined, ''), undefined);
  assert.deepEqual(entriesFilterOf('v1', ''), { vendorId: 'v1' });
  assert.deepEqual(entriesFilterOf(null, 'RETURN'), { type: 'RETURN' });
  assert.deepEqual(entriesFilterOf('v1', 'RECEIVE'), { vendorId: 'v1', type: 'RECEIVE' });

  const rows = [
    { id: '1', supplier: null, vendor: { id: 'v', name: 'مورد الربط' } },
    { id: '2', supplier: 'النص الحر', vendor: { id: 'v', name: 'المسجل' } },
    { id: '3', supplier: null, vendor: null },
  ];
  const out = withVendorSupplier(rows);
  assert.deepEqual(out.map(r => r.supplier), ['مورد الربط', 'النص الحر', null]);
  assert.equal(out[1], rows[1], 'الصفّ الذي له مورّد نصّي يبقى هو نفسه');
});

test('رموز الخادم: المعروفة بنصّها العربي وحدها — وغيرها null فتبقى رسالة الخادم كما كانت', () => {
  const err = (code?: unknown, message?: string) => ({ response: { data: { code, message } } });
  assert.equal(knownPurchaseError(err('PURCHASE_VENDOR_REQUIRED')), 'اختر المورد للشراء النقدي أو الآجل');
  assert.equal(knownPurchaseError(err('PURCHASE_PRICE_REQUIRED')), 'سعر الوحدة مطلوب لكل صنف في الشراء النقدي أو الآجل');
  assert.equal(knownPurchaseError(err('RETURN_EXCEEDS_RECEIVED')), 'كمية المرتجع أكبر من المتبقي من الوارد');
  assert.equal(knownPurchaseError(err('PRODUCT_ARCHIVED', 'الصنف محذوف')), null);
  assert.equal(knownPurchaseError(err('constructor')), null, 'لا مفاتيح النموذج الأصلي');
  assert.equal(knownPurchaseError(err(undefined, 'x')), null);
  assert.equal(knownPurchaseError(new Error('network')), null);
  assert.equal(knownPurchaseError(null), null);
});

// ─── التصنيف والمرتجع والإلغاء ───

test('ملخّص التصنيف = الخادم (classifyEntryTx): المسعَّر بسعره المُدخل ونسبته المحفوظة (أو نسبة صنفه)، والناقص من المكتوب', () => {
  const items = [
    item('a', 10, 4.5, { taxPct: 15 }),          // سطرٌ سبق الميزة: بلا سعرٍ مُدخل ⇒ تكلفته الصافية
    item('b', 3, 7, { taxPct: null }),           // سطرٌ سبق الميزة ⇒ نسبة الصنف
    item('c', 6, null),                          // ناقص ⇒ من المكتوب
    item('d', 2, 0),                             // الواجهة تطلب سعره، والخادم يعدّه مسعَّراً (unitCost ليس null) فلا يغيّره
    item('e', -1, 3),                            // ليس من الوارد
  ];
  assert.deepEqual(classifyItems(items).map(i => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(unpricedItems(items).map(i => i.id), ['c', 'd']);
  const prices: Record<string, ClassifyPriceDraft> = {
    c: { itemId: 'c', unitCost: '11.5', taxPct: '15' },
    d: { itemId: 'd', unitCost: '', taxPct: '5' },
  };
  const productPct = (pid?: string) => (pid === 'p-b' ? 5 : 15);
  const preview = (inclusive: boolean, taxOff: boolean, saved: { costsIncludeTax?: boolean; vatTreatment?: 'RECOVERABLE' | 'NON_RECOVERABLE' | 'NONE' } = {}) =>
    classifyPreview({
      items: classifyItems(items), saved, prices: unpricedItems(items).map(i => prices[i.id]), inclusive, taxOff, productPct, decimals: 2,
    }).totals;
  // صافٍ: 45 + 21 + 69 + 0 = 135؛ الضريبة 15٪ من 114 = 17.10 و5٪ من 21 = 1.05
  assert.deepEqual(preview(false, false), { net: 135, tax: 18.15, total: 153.15 });
  // شامل (مع الأسعار المرسلة): 6 × 11.5 = 69 شاملاً ⇒ 60 + 9، والقائمة بلا سعرٍ مُدخل صافيةٌ كما هي (66 ⇒ 6.75 + 1.05)
  assert.deepEqual(preview(true, false), { net: 126, tax: 16.8, total: 142.8 });
  // إزالة الضريبة: NONE ⇒ النسب صفر ولا استخراج من المكتوب
  assert.deepEqual(preview(true, true), { net: 135, tax: 0, total: 135 });
  // الحركة محفوظة «بلا ضريبة» (ربطٌ برمجي) ⇒ الخادم يصنّفها NONE ولو كانت الشركة بضريبة
  assert.deepEqual(preview(false, false, { vatTreatment: 'NONE' }), { net: 135, tax: 0, total: 135 });
});

test('ملخّص المرتجع = الخادم (reverseEntryTx): الكميات الموجبة بالسعر المُدخل للسطر الأصلي ونسبته — والسطر غير المسعَّر والغريب خارجه', () => {
  const items = [item('a', 10, 4.5, { taxPct: 15 }), item('b', 4, 2, { taxPct: null }), item('c', 5, null)];
  const e = entry({ id: 'E', paymentMode: 'CREDIT', vatTreatment: 'RECOVERABLE', items });
  const qtys = new Map([['a', '2'], ['b', ''], ['c', '1'], ['zz', '3']]);
  assert.deepEqual(returnPreview(e, [e], qtys, 2), { lines: 1, totals: { net: 9, tax: 1.35, total: 10.35 } });
  assert.equal(returnPreview(e, [e], new Map([['a', '-2'], ['b', 'x']]), 2).lines, 0);
  // «غير مستردة»: تكلفة المخزون 115 تشمل الضريبة، والمرتجع بالسعر المُدخل 100 + 15٪ = 115 — لا 132.25
  const nr = entry({ id: 'N', paymentMode: 'CREDIT', vatTreatment: 'NON_RECOVERABLE', net: 1000, tax: 150, total: 1150,
    items: [item('x', 10, 115, { enteredUnitCost: 100, taxPct: 15, remainingQty: 10 })] });
  assert.deepEqual(returnPreview(nr, [nr], new Map([['x', '1']]), 2).totals, { net: 100, tax: 15, total: 115 });
  assert.equal(returnNoTax({ vatTreatment: 'NONE' }, false), true);
  assert.equal(returnNoTax({ vatTreatment: 'RECOVERABLE' }, true), true);
  assert.equal(returnNoTax({ vatTreatment: null }, false), false);

  assert.deepEqual(returnDefaults({ paymentMode: 'CASH', paidAccountRef: 'BANK' }), { refundMode: 'CASH', refundTo: 'BANK' });
  assert.deepEqual(returnDefaults({ paymentMode: 'CASH', paidAccountRef: 'REP_CUSTODY:r1' }), { refundMode: 'CASH', refundTo: 'MAIN_CASH' });
  assert.deepEqual(returnDefaults({ paymentMode: 'CREDIT', paidAccountRef: null }), { refundMode: 'CREDIT', refundTo: 'MAIN_CASH' });
});

test('الإلغاء: الآجل الذي عليه دفعات سارية يُمنع قبل الإرسال، والآثار تُقال بحسب النوع', () => {
  assert.equal(paidOnCredit({ paymentMode: 'CREDIT', paid: 10 }), true);
  assert.equal(paidOnCredit({ paymentMode: 'CREDIT', paid: 0 }), false);
  assert.equal(paidOnCredit({ paymentMode: 'CREDIT', paid: null }), false);
  assert.equal(paidOnCredit({ paymentMode: 'CASH', paid: 100 }), false, 'سند النقدي الآلي يُلغى مع الحركة');
  const cash = cancelEffects({ paymentMode: 'CASH' });
  assert.equal(cash.length, 3);
  assert.ok(cash.some(t => t.includes('سند الصرف الآلي')));
  assert.ok(cancelEffects({ paymentMode: 'CREDIT' }).some(t => t.includes('يعكس المستحق')));
  assert.equal(cancelEffects({ paymentMode: null }).length, 2, 'غير المصنَّف: مرتجعٌ بلا قيود مورّد');
});

test('افتراض تاريخ فاتورة التصنيف: يوم الاستلام بتوقيت الجهاز — وتاريخٌ تالف ⇒ اليوم', () => {
  assert.match(receiptDayOf('2026-11-01T08:00:00.000Z'), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(receiptDayOf('not-a-date', () => new Date(2026, 10, 13, 12)), '2026-11-13');
});

test('الكاش: الجوال + اللوحة والموردون + التشغيلات حين الميزة وحدها — بلا تكرار', () => {
  const base = ['warehouse-stock', 'warehouse-entries', 'suppliers', 'supplier-payments', 'lot-balances-wh'];
  const off = invalidateKeys(base, false);
  assert.deepEqual(off, [...M_WH_KEYS, ...base]);
  const on = invalidateKeys(base, true);
  for (const k of LOT_CACHE_KEYS) assert.ok(on.includes(k), k);
  assert.equal(new Set(on).size, on.length, 'مفتاحٌ مكرَّر');
});

test('سبب تسوية السيارة: للحركة ADJUST وحدها بأسماء VAN_ADJUST_REASONS — وغائبٌ أو مجهول ⇒ لا وسم', () => {
  assert.deepEqual(Object.keys(VAN_REASON_LABELS), ['COUNT', 'DAMAGE', 'EXPIRY', 'SHORTAGE_REP', 'SAMPLE', 'OTHER']);
  // الأسماء نفسها في الخادم
  const core = fs.readFileSync(backendCore, 'utf8');
  assert.match(core, /VAN_ADJUST_REASONS = \['COUNT', 'DAMAGE', 'EXPIRY', 'SHORTAGE_REP', 'SAMPLE', 'OTHER'\] as const/);
  assert.equal(vanReasonLabel({ kind: 'ADJUST', reason: 'SHORTAGE_REP' }), 'عجز على المندوب');
  assert.equal(vanReasonLabel({ kind: 'ADJUST', reason: 'EXPIRY' }), 'منتهي الصلاحية');
  assert.equal(vanReasonLabel({ kind: 'LOAD', reason: 'COUNT' }), null);
  assert.equal(vanReasonLabel({ kind: 'ADJUST', reason: null }), null);
  assert.equal(vanReasonLabel({ kind: 'ADJUST' }), null);
  assert.equal(vanReasonLabel({ kind: 'ADJUST', reason: 'toString' }), null);
});

// ─── الشاشات موصولة (حرّاس نصّية على طريقة /m: الشاشات تستورد api/client فلا تُرسم في node) ───

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'm', f), 'utf8').replace(/\r\n/g, '\n');

test('نموذج الوارد: بلا نوع شراء لا حقل جديد — المورّد للوارد، وحقول الشراء من purchaseBodyFields، والنسبة للمصنَّف، والسبب للتسوية', () => {
  const s = read('MWarehouse.tsx');
  assert.ok(s.includes("supplier: type === 'RECEIVE' && vendor ? vendor.name : undefined,"));
  assert.ok(s.includes("...(type === 'RECEIVE' && vendor && { vendorId: vendor.id }),"));
  assert.ok(s.includes("...(type === 'RECEIVE' && purchaseBodyFields(purchase, { taxOff })),"));
  assert.ok(s.includes("...(type === 'ADJUST' && reason && { reason }),"));
  assert.ok(s.includes('if (purchaseMode) item.taxPct = rowTaxPct(r, taxOff);'));
  assert.ok(s.includes("const purchaseMode = type === 'RECEIVE' ? purchase.mode : null;"), 'التسوية لا تحمل نوع شراء');
  // بلا نوع شراء: purchaseBodyFields فارغ — فالجسم كما كان حرفاً (والمورّد اختياريّ)
  assert.deepEqual(purchaseBodyFields(emptyPurchaseDraft('2026-11-13'), { taxOff: false }), {});
  assert.deepEqual(purchaseBodyFields(emptyPurchaseDraft('2026-11-13'), { taxOff: true }), {});
  // ما يمنع الحفظ يُقال والزرّ يقرؤه — دون المساس بقاعدة valid القائمة
  assert.ok(s.includes('disabled={!valid || !!purchaseIssue || save.isPending || attBusy}'));
  assert.ok(s.includes('const valid = rows.length > 0 && rows.every(r => !qtyBad(r) && !costBad(r) && !lotBad(r) && !archivedReceive(r));'));
  // الملخّص بتقريب الخادم، و«قيمة البضاعة» القديمة لغير المصنَّف وحده
  assert.ok(s.includes('const bill = purchaseMode ? mDraftBillTotals(rows, { inclusive: costsIncludeTax, taxOff }, activeDecimals()) : null;'));
  assert.ok(s.includes('{receive && !purchaseMode && total > 0 && ('));
  // رموز الشراء بنصّها، وغيرها كما كان
  assert.ok(s.includes("toast.error(pe ? tr(pe) : errMsg(e, tr('تعذر الحفظ')));"));
  // الشراء المصنَّف يُبطل رصيد المورّد وسنداته
  assert.ok(s.includes('...(purchaseMode ? SUPPLIER_CACHE_KEYS : [])]'));
});

test('ما لا يجوز كسره: تنبيه ATTACHMENTS_NOT_SAVED، وتشغيلات اللوط، ومرجع المحاولة D8', () => {
  const s = read('MWarehouse.tsx');
  assert.ok(s.includes(".find(w => w?.code === 'ATTACHMENTS_NOT_SAVED');"));
  assert.ok(s.includes('if (lostAtts) toast.error(lostAtts);'));
  assert.ok(s.includes('...(r.tracked && entryLotFields(r.lot)),'));
  assert.ok(s.includes('[...new Set(warnings.map(w => w.code))].forEach(c => toast(tr(LOT_WARNING_LABELS[c])));'));
  assert.match(s, /attempt\.current = entryAttempt\(attempt\.current, body\);\n\s+const payload: EntryPayload = \{ \.\.\.body, clientRef: attempt\.current\.ref \};/);
  // نسبة السطر لا تمسّ الكمية ولا التشغيلة (patch القائم يصفّر التشغيلة حين ينقلب الاتجاه)
  assert.ok(s.includes('const patchTax = (key: string, v: string) => setRows(rs => rs.map(r => (r.rowId === key ? { ...r, taxText: v } : r)));'));
});

test('السجلّ موصول: الفلتر والوقائع والأفعال وطبقاتها، والإشعار بالصفّ نفسه', () => {
  const s = read('MWarehouse.tsx');
  assert.ok(s.includes("queryKey: ['m-wh-entries', fVendor?.id ?? '', fType],"), 'المفتاح يبدأ بـm-wh-entries فيُبطَل بالبادئة');
  assert.ok(s.includes('warehouseApi.entries(entriesFilterOf(fVendor?.id, fType))'));
  assert.ok(s.includes('facts={entryFacts(e, allEntries, today)} acts={mEntryActions(e, allEntries)}'));
  assert.ok(s.includes('if (classifyOf) return <MClassifyEntry entry={classifyOf} lotOn={lotOn} onClose={() => setClassifyOf(null)} />;'));
  assert.ok(s.includes('if (returnOf) return <MReturnEntry entry={returnOf} all={allEntries} lotOn={lotOn} onClose={() => setReturnOf(null)} />;'));
  assert.ok(s.includes('{cancelOf && <MCancelEntry entry={cancelOf} lotOn={lotOn} onClose={() => setCancelOf(null)} />}'));
  assert.ok(s.includes('useBackClose(!!classifyOf, () => setClassifyOf(null));'));
  assert.ok(s.includes('useBackClose(!!returnOf, () => setReturnOf(null));'));
  const a = read('MPurchaseActions.tsx');
  assert.ok(a.includes('warehouseApi.classifyEntry(entry.id, classifyBody({'));
  assert.ok(a.includes('warehouseApi.returnEntry(entry.id, returnBody({ qtys, note, supplierRef, billDate, refundMode, refundTo }))'));
  assert.ok(a.includes('warehouseApi.cancelEntry(entry.id, reason.slice(0, 300))'));
  assert.ok(a.includes('disabled={!sure || blocked || save.isPending}'), 'الإلغاء بتأكيدٍ صريح، والآجل المسدَّد ممنوع');
  // منتقي المورّد: البحث في الخادم والإضافة السريعة تختار الجديد
  const p = read('MPurchaseSupplier.tsx');
  assert.ok(p.includes('suppliersApi.list({ search: dq || undefined, status, limit: 30 })'));
  assert.ok(p.includes("if (s) { toast.success(tr('أضيف المورد')); onPick(s); }"));
  assert.ok(p.includes('...(!taxOff && d.vatNumber.trim() && { vatNumber: d.vatNumber.trim() }),'), 'لا رقم ضريبي يُرسل بعد إزالة الضريبة');
  // سيارة المندوب: سبب التسوية أمام مرجع الحركة
  const v = read('MRepLoad.tsx');
  assert.ok(v.includes('const why = vanReasonLabel(m);'));
  assert.ok(v.includes("subtitle={[why ? tr(why) : '', m.ref].filter(Boolean).join(' · ') || undefined}"));
});
