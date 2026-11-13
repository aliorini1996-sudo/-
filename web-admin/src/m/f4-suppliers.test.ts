import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BALANCE_LABELS, DRAFT_PROBLEMS, LEDGER_KINDS, PAY_METHODS, PAY_METHOD_LABELS, SUPPLIER_ERROR_TEXT,
  agingSummary, autoAllocation, balanceState, canCancelPayment, checkManualAllocation, fromMilli, isDay, isPayMethod,
  ledgerKindOf, lineOpensPayment, localDay, openBillsTotals, parseAmount, payMethodLabel, paymentBody, paymentProblems,
  paymentUnapplied, referenceLabel, supplierErrorCode, supplierErrorMessage, toMilli, type PaymentDraft,
} from './MSuppliersLogic';

/**
 * «الموردون» في تطبيق الإدارة (/m) — منطق سند الصرف وكشف المورّد يُشغَّل هنا، وتوصيل القوقعة يُحرس نصّاً.
 *
 * ما يحرسه: كلّ قرارٍ رقميّ نسخةٌ من قاعدة الخادم (services/suppliers/payments.ts) — التقريب نصف-لأعلى بالملّي، والتخصيص
 * التلقائي على الأقدم بترتيب الخادم، وحدود التخصيص اليدوي. خطأٌ هنا يُرسل سنداً يردّه الخادم ٤٠٩ أو — أسوأ — يُعاين للمستخدم
 * تخصيصاً غير الذي يُكتب.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
/** المصدر بلا تعليقات — الحارس على الكود لا على شرحه */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const draft = (over: Partial<PaymentDraft> = {}): PaymentDraft => ({
  supplierId: 'v1', amountText: '100', method: 'CASH', salesRepId: '', paidAt: '2026-11-13',
  reference: '', note: '', mode: 'auto', alloc: {}, ...over,
});
const BILLS = [
  { warehouseEntryId: 'b-old', outstanding: 100 },
  { warehouseEntryId: 'b-mid', outstanding: 50.5 },
  { warehouseEntryId: 'b-new', outstanding: 30 },
];

// ═══ الملّي والإدخال ═══

test('toMilli: نصف-لأعلى إلى منازل العملة كـtoMilliAmount — لا ضوضاء العائمة', () => {
  assert.equal(toMilli(1.005, 2), 1010);
  assert.equal(toMilli(2.675, 2), 2680);
  assert.equal(toMilli(0.0005, 3), 1);
  assert.equal(toMilli(10.0004, 3), 10000);
  assert.equal(toMilli(-1.005, 2), -1010, 'السالب بعيداً عن الصفر');
  assert.equal(toMilli(5.5, 0), 6000, 'عملة بلا كسور');
  assert.ok(Number.isNaN(toMilli(Number.NaN, 2)));
  assert.ok(Number.isNaN(toMilli(Infinity, 2)));
  assert.equal(fromMilli(1010), 1.01);
});

test('parseAmount: رقمٌ مقرَّب أو null — بلا تخمين في المال', () => {
  assert.equal(parseAmount('100', 2), 100);
  assert.equal(parseAmount(' 100.005 ', 2), 100.01, 'يُرسل ما يُقرأ في الزرّ: مقرَّباً لمنازل العملة');
  assert.equal(parseAmount('100.0005', 3), 100.001);
  assert.equal(parseAmount('٣٥٫٥', 2), 35.5, 'أرقام هندية وفاصلتها');
  assert.equal(parseAmount('۱۲', 2), 12, 'أرقام فارسية');
  assert.equal(parseAmount('.5', 2), 0.5);
  assert.equal(parseAmount(250, 2), 250);
  assert.equal(parseAmount('0', 2), null, 'السند بصفر مرفوض');
  assert.equal(parseAmount('0.004', 2), null, 'ما دون أصغر وحدةٍ يصير صفراً بالتقريب — مرفوض كالخادم');
  assert.equal(parseAmount('0', 2, true), 0, 'التخصيص بصفر = لا تخصيص');
  for (const bad of ['', '  ', '-5', '1,5', '1.2.3', 'abc', '5e3', null, undefined]) {
    assert.equal(parseAmount(bad as string, 2), null, String(bad));
  }
});

test('balanceState: موجبٌ مستحقّ، وسالبٌ دفعة مقدّمة، وغبار التقريب مسدَّد', () => {
  assert.deepEqual(balanceState(500, 2), { state: 'owed', amount: 500 });
  assert.deepEqual(balanceState(-200.25, 2), { state: 'advance', amount: 200.25 });
  assert.deepEqual(balanceState(0.004, 2), { state: 'settled', amount: 0 });
  assert.deepEqual(balanceState(-0.0004, 3), { state: 'settled', amount: 0 });
  assert.deepEqual(balanceState(Number.NaN, 2), { state: 'settled', amount: 0 });
  for (const s of ['owed', 'advance', 'settled'] as const) assert.ok(BALANCE_LABELS[s]);
});

// ═══ التخصيص ═══

test('autoAllocation: على الفواتير بترتيب الخادم، لكلٍّ ≤ متبقّيها، والزائد دفعة مقدّمة', () => {
  assert.deepEqual(autoAllocation(BILLS, 120, 2), {
    allocations: [{ warehouseEntryId: 'b-old', amount: 100 }, { warehouseEntryId: 'b-mid', amount: 20 }],
    allocated: 120, unapplied: 0,
  });
  assert.deepEqual(autoAllocation(BILLS, 200, 2), {
    allocations: [{ warehouseEntryId: 'b-old', amount: 100 }, { warehouseEntryId: 'b-mid', amount: 50.5 }, { warehouseEntryId: 'b-new', amount: 30 }],
    allocated: 180.5, unapplied: 19.5,
  });
  // الترتيب ترتيب القائمة كما وصلت (compareByDue في الخادم) — لا يُعاد فرزها هنا
  const reversed = [...BILLS].reverse();
  assert.equal(autoAllocation(reversed, 40, 2).allocations[0].warehouseEntryId, 'b-new');
  // فاتورة بلا متبقٍّ تُتخطّى، والمبلغ صفر لا يخصّص شيئاً
  assert.deepEqual(autoAllocation([{ warehouseEntryId: 'z', outstanding: 0 }, ...BILLS], 10, 2).allocations, [{ warehouseEntryId: 'b-old', amount: 10 }]);
  assert.deepEqual(autoAllocation(BILLS, 0, 2), { allocations: [], allocated: 0, unapplied: 0 });
  assert.deepEqual(autoAllocation([], 75, 2), { allocations: [], allocated: 0, unapplied: 75 });
});

test('autoAllocation: بالملّي الصحيح — 0.1 + 0.2 تُغلق 0.3 بلا بقيّة غبار، والعملة الثلاثية بمنازلها', () => {
  const r = autoAllocation([{ warehouseEntryId: 'a', outstanding: 0.1 }, { warehouseEntryId: 'b', outstanding: 0.2 }], 0.3, 2);
  assert.deepEqual(r, { allocations: [{ warehouseEntryId: 'a', amount: 0.1 }, { warehouseEntryId: 'b', amount: 0.2 }], allocated: 0.3, unapplied: 0 });
  const kwd = autoAllocation([{ warehouseEntryId: 'a', outstanding: 0.875 }], 1.5, 3);
  assert.deepEqual(kwd, { allocations: [{ warehouseEntryId: 'a', amount: 0.875 }], allocated: 1.5 - 0.625, unapplied: 0.625 });
});

test('checkManualAllocation: حدود الخادم — لكل فاتورة ≤ متبقّيها وΣ ≤ المبلغ — والفارغ والصفر لا تخصيص', () => {
  const ok = checkManualAllocation(BILLS, { 'b-old': '60', 'b-mid': '', 'b-new': '0' }, 100, 2);
  assert.deepEqual(ok, { allocations: [{ warehouseEntryId: 'b-old', amount: 60 }], allocated: 60, unapplied: 40, invalid: [], overBill: [], overAmount: false });

  const overBill = checkManualAllocation(BILLS, { 'b-mid': '50.51' }, 100, 2);
  assert.deepEqual(overBill.overBill, ['b-mid']);
  assert.equal(overBill.overAmount, false);
  // ما يساوي المتبقّي بعد التقريب ليس زيادة (50.504 ⇒ 50.50)
  assert.deepEqual(checkManualAllocation(BILLS, { 'b-mid': '50.504' }, 100, 2).overBill, []);

  const overAmount = checkManualAllocation(BILLS, { 'b-old': '100', 'b-new': '1' }, 100, 2);
  assert.equal(overAmount.overAmount, true);
  assert.equal(overAmount.unapplied, 0);

  const invalid = checkManualAllocation(BILLS, { 'b-old': '-1', 'b-new': 'x' }, 100, 2);
  assert.deepEqual(invalid.invalid, ['b-old', 'b-new']);
  assert.deepEqual(invalid.allocations, []);

  // فاتورةٌ لم تعد في القائمة (سُدّدت من جهازٍ آخر) لا تُرسل
  assert.deepEqual(checkManualAllocation(BILLS, { gone: '10' }, 100, 2).allocations, []);
  // غبار العائمة لا يجعل Σ أكبر من المبلغ
  assert.equal(checkManualAllocation([{ warehouseEntryId: 'a', outstanding: 1 }, { warehouseEntryId: 'b', outstanding: 1 }], { a: '0.1', b: '0.2' }, 0.3, 2).overAmount, false);
  // مبلغ غير صالح بعد: كلّ تخصيصٍ موجب زيادة
  assert.equal(checkManualAllocation(BILLS, { 'b-old': '1' }, null, 2).overAmount, true);
});

// ═══ النموذج والجسم ═══

test('paymentProblems: المبلغ والطريقة والمندوب للعهدة والتاريخ، واليدويّ ينتظر الفواتير', () => {
  assert.deepEqual(paymentProblems(draft(), null, 2), [], 'التلقائي لا يحتاج الفواتير — الخادم يخصّص');
  assert.deepEqual(paymentProblems(draft({ amountText: '' }), [], 2), ['AMOUNT']);
  assert.deepEqual(paymentProblems(draft({ method: '' }), [], 2), ['METHOD'], 'لا طريقة افتراضية');
  assert.deepEqual(paymentProblems(draft({ method: 'REP_CUSTODY' }), [], 2), ['REP']);
  assert.deepEqual(paymentProblems(draft({ method: 'REP_CUSTODY', salesRepId: 'r1' }), [], 2), []);
  assert.deepEqual(paymentProblems(draft({ paidAt: '2026-02-31' }), [], 2), ['DATE']);
  assert.deepEqual(paymentProblems(draft({ mode: 'manual' }), null, 2), ['BILLS']);
  assert.deepEqual(paymentProblems(draft({ mode: 'manual', alloc: { 'b-old': '101' } }), BILLS, 2), ['ALLOC_OVER_BILL', 'ALLOC_OVER_AMOUNT']);
  assert.deepEqual(paymentProblems(draft({ mode: 'manual', alloc: { 'b-old': 'x' } }), BILLS, 2), ['ALLOC_INVALID']);
  for (const k of Object.keys(DRAFT_PROBLEMS)) assert.ok(DRAFT_PROBLEMS[k as keyof typeof DRAFT_PROBLEMS]);
});

test('paymentBody: التلقائي autoAllocate بلا تخصيص، واليدويّ تخصيصه وautoAllocate:false — والمندوب للعهدة وحدها', () => {
  assert.deepEqual(paymentBody(draft({ amountText: '100.005', reference: '  ', note: ' دفعة نوفمبر ' }), null, 2), {
    supplierId: 'v1', amount: 100.01, method: 'CASH', paidAt: '2026-11-13', note: 'دفعة نوفمبر', autoAllocate: true,
  });
  // مندوبٌ بقي مختاراً من طريقةٍ سابقة لا يُلصق بسندٍ نقديّ
  assert.equal(paymentBody(draft({ salesRepId: 'r1' }), null, 2)?.salesRepId, undefined);
  assert.deepEqual(paymentBody(draft({ method: 'REP_CUSTODY', salesRepId: 'r1', reference: ' CH-1 ' }), null, 2), {
    supplierId: 'v1', amount: 100, method: 'REP_CUSTODY', salesRepId: 'r1', paidAt: '2026-11-13', reference: 'CH-1', autoAllocate: true,
  });
  assert.deepEqual(paymentBody(draft({ mode: 'manual', alloc: { 'b-mid': '50.5', 'b-new': '0' } }), BILLS, 2), {
    supplierId: 'v1', amount: 100, method: 'CASH', paidAt: '2026-11-13',
    allocations: [{ warehouseEntryId: 'b-mid', amount: 50.5 }], autoAllocate: false,
  });
  // اليدويّ بلا تخصيص = السند كلّه دفعة مقدّمة صراحةً (لا يوزّعه الخادم على ما لم يُختر)
  assert.deepEqual(paymentBody(draft({ mode: 'manual' }), BILLS, 2)?.allocations, []);
  assert.equal(paymentBody(draft({ mode: 'manual' }), BILLS, 2)?.autoAllocate, false);
  assert.equal(paymentBody(draft({ amountText: '0' }), null, 2), null);
  assert.equal(paymentBody(draft({ mode: 'manual', alloc: { 'b-old': '100.01' } }), BILLS, 2), null);
});

// ═══ السند والكشف ═══

test('canCancelPayment: الساري اليدويّ وحده — والآلي يُلغى بإلغاء حركته', () => {
  assert.equal(canCancelPayment({ status: 'POSTED', autoForEntryId: null }), true);
  assert.equal(canCancelPayment({ status: 'CANCELLED', autoForEntryId: null }), false);
  assert.equal(canCancelPayment({ status: 'POSTED', autoForEntryId: 'e1' }), false);
});

test('paymentUnapplied: المبلغ − Σ التخصيص بالملّي، ولا يقلّ عن صفر', () => {
  assert.equal(paymentUnapplied({ amount: 100, allocations: [{ amount: 30 }, { amount: 50.005 }] }, 2), 19.99);
  assert.equal(paymentUnapplied({ amount: 0.3, allocations: [{ amount: 0.1 }, { amount: 0.2 }] }, 2), 0);
  assert.equal(paymentUnapplied({ amount: 10, allocations: [{ amount: 12 }] }, 2), 0);
  assert.equal(paymentUnapplied({ amount: 10, allocations: null }, 2), 10);
});

test('ledgerKindOf: الأنواع السبعة مسمّاة — والمجهول برمزه لا يُسقط', () => {
  for (const k of ['BILL', 'BILL_REV', 'PAYMENT', 'PAYMENT_REV', 'RETURN', 'REFUND_IN', 'OPENING']) {
    const v = ledgerKindOf(k);
    assert.notEqual(v.label, k, k);
    assert.notEqual(v.tone, 'other', k);
  }
  assert.deepEqual(ledgerKindOf('FUTURE_KIND'), { label: 'FUTURE_KIND', tone: 'other' });
  assert.equal(lineOpensPayment({ kind: 'PAYMENT', supplierPaymentId: 'p' }), true);
  assert.equal(lineOpensPayment({ kind: 'PAYMENT_REV', supplierPaymentId: 'p' }), true);
  assert.equal(lineOpensPayment({ kind: 'BILL', supplierPaymentId: 'p' }), false);
  assert.equal(lineOpensPayment({ kind: 'PAYMENT', supplierPaymentId: null }), false);
});

test('الطرق: أربعٌ بأسمائها، والمجهولة برمزها، وخانة المرجع باسم ما يُكتب فيها', () => {
  assert.deepEqual([...PAY_METHODS], ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'REP_CUSTODY']);
  for (const m of PAY_METHODS) assert.equal(payMethodLabel(m), PAY_METHOD_LABELS[m]);
  assert.equal(payMethodLabel('CRYPTO'), 'CRYPTO');
  assert.equal(payMethodLabel(null), '—');
  assert.equal(isPayMethod('CASH'), true);
  assert.equal(isPayMethod('POS'), false);
  assert.equal(referenceLabel('CHEQUE'), 'رقم الشيك');
  assert.equal(referenceLabel('BANK_TRANSFER'), 'مرجع التحويل');
  assert.equal(referenceLabel(''), 'المرجع');
});

test('agingSummary: الأرصدة لا تُصافى بين الموردين، والمتأخّر شرائح ما بعد الاستحقاق', () => {
  const s = agingSummary([
    { balance: 1000, total: 900, d1_30: 100, d31_60: 0, d61_90: 0, d90_plus: 50 },
    { balance: -250, total: 0 },
    { total: 300.005, d90_plus: 300.005 }, // خادمٌ بالعقد المختصر: بلا رصيد ⇒ متبقّي الفواتير
  ], 2);
  assert.deepEqual(s, { owed: 1300.01, advance: 250, overdue: 450.01 });
  assert.deepEqual(agingSummary([], 2), { owed: 0, advance: 0, overdue: 0 });
});

test('openBillsTotals: المتبقّي والمتأخّر وعدده', () => {
  assert.deepEqual(openBillsTotals([
    { warehouseEntryId: 'a', outstanding: 0.1, daysOverdue: 3 },
    { warehouseEntryId: 'b', outstanding: 0.2, daysOverdue: 0 },
  ], 2), { outstanding: 0.3, overdue: 0.1, overdueCount: 1 });
});

test('الأخطاء: الرمز المعروف يغلب، ثمّ رسالة الخادم، ثمّ البديل', () => {
  const err = (data: unknown) => ({ response: { data } });
  assert.equal(supplierErrorCode(err({ code: 'ALLOCATION_EXCEEDS_OUTSTANDING' })), 'ALLOCATION_EXCEEDS_OUTSTANDING');
  assert.equal(supplierErrorCode(new Error('x')), null);
  assert.equal(supplierErrorMessage(err({ code: 'AUTO_PAYMENT_CANCEL_VIA_ENTRY', message: 'نصّ الخادم' }), 'بديل'), SUPPLIER_ERROR_TEXT.AUTO_PAYMENT_CANCEL_VIA_ENTRY);
  assert.equal(supplierErrorMessage(err({ code: 'NEW_CODE', message: 'الفاتورة لمورّد آخر' }), 'بديل'), 'الفاتورة لمورّد آخر');
  assert.equal(supplierErrorMessage(err({ message: '  ' }), 'بديل'), 'بديل');
  assert.equal(supplierErrorMessage(undefined, 'بديل'), 'بديل');
});

test('isDay وlocalDay: يومٌ حقيقيّ بتقويم الجهاز', () => {
  assert.equal(isDay('2026-11-13'), true);
  assert.equal(isDay('2026-2-1'), false);
  assert.equal(isDay('2026-02-30'), false);
  assert.equal(isDay(20261113), false);
  assert.equal(localDay(new Date(2026, 0, 5, 1, 30)), '2026-01-05');
});

// ═══ القاموس: المفاتيح التي تمرّ إلى tr بمتغيّر (لا يلتقطها langs.test) ═══

test('كل نصٍّ يمرّ إلى tr بمتغيّر مترجَمٌ في القاموس (يُدمج من i18n/F4.json)', () => {
  const dict = read('i18n', 'strings.ts');
  const have = new Set([...dict.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:\s*\{/gm)].map(m => m[1]));
  const keys = [
    ...Object.values(PAY_METHOD_LABELS), ...Object.values(LEDGER_KINDS).map(k => k.label), ...Object.values(BALANCE_LABELS),
    ...Object.values(DRAFT_PROBLEMS), ...Object.values(SUPPLIER_ERROR_TEXT), referenceLabel('CHEQUE'), referenceLabel('BANK_TRANSFER'), referenceLabel(''),
  ];
  // تسميات الشاشات الثابتة التي تمرّ بمتغيّر (تبويبات البطاقة وشرائح الحالة وبلاطة الرئيسية)
  for (const f of ['MSuppliers.tsx', 'MSuppliersCard.tsx']) {
    for (const m of read('m', f).matchAll(/label: '([^']+)'/g)) keys.push(m[1]);
  }
  keys.push('الموردون');
  const missing = [...new Set(keys)].filter(k => /[؀-ۿ]/.test(k) && !have.has(k));
  assert.deepEqual(missing, [], 'نصوص بلا ترجمة: ' + missing.join(' | '));
});

// ═══ التوصيل (حرّاس نصّية) ═══

test('القوقعة: القسم بحارس «مخزون الشركة» حرفاً، كسولٌ، وبلا تبويبٍ سفلي', () => {
  const s = read('m', 'MobileApp.tsx');
  assert.match(s, /const MSuppliers = lazy\(\(\) => import\('\.\/MSuppliers'\)\)/, 'الشاشة يجب أن تكون كسولة');
  assert.doesNotMatch(s, /^import MSuppliers/m, 'استيرادٌ ثابت يُدخل الشاشة حزمة الإقلاع');
  // الحارس نفسه الذي يُظهر «مخزون الشركة» — الخادم يحرس /api/suppliers بحرّاس المستودع
  assert.match(s, /can\(user, 'canManageVanStock'\) && accountingOn && warehouseOn\) out\.push\('suppliers'\)/);
  assert.match(s, /section === 'suppliers' \? <MSuppliers company=\{company\} onBack=\{\(\) => setSection\(null\)\} \/>/, 'القسم غير موصول');
  const tabs = s.slice(s.indexOf('const TABS'), s.indexOf('/** حدث تثبيت PWA'));
  assert.doesNotMatch(tabs, /id: 'suppliers'/, 'المقاعد خمسة وقد امتلأت — الموردون قسمٌ لا تبويب');
  const home = read('m', 'MHome.tsx');
  assert.match(home, /export type HomeSection = [^;]*'suppliers'/);
  assert.match(home, /\{ id: 'suppliers', label: 'الموردون', icon: Truck \}/);
});

test('الشاشات على عقد api/suppliers بأسمائه — ولا مسار مكتوبٌ يدوياً', () => {
  const api = read('api', 'suppliers.ts');
  for (const fn of ['list', 'get', 'statement', 'openBills', 'aging', 'create', 'cancel']) {
    assert.match(api, new RegExp(`\\b${fn}: \\(`), `api/suppliers.ts بلا ${fn}`);
  }
  const all = ['MSuppliers.tsx', 'MSuppliersCard.tsx', 'MSuppliersPayForm.tsx', 'MSuppliersPaymentView.tsx'].map(f => read('m', f)).join('\n');
  for (const call of ['suppliersApi.list(', 'suppliersApi.get(', 'suppliersApi.statement(', 'suppliersApi.openBills(', 'suppliersApi.aging(',
    'supplierPaymentsApi.list(', 'supplierPaymentsApi.get(', 'supplierPaymentsApi.create(', 'supplierPaymentsApi.cancel(']) {
    assert.ok(all.includes(call), `غير مستعمل: ${call}`);
  }
  assert.doesNotMatch(all, /api\.(get|post)\('\/supplier/, 'نداءٌ مباشر يتجاوز api/suppliers');
});

test('سند الصرف: مفتاح المحاولة من المحتوى، والجسم من paymentBody وحدها، والإبطال يشمل سجلّ المستودع', () => {
  const s = read('m', 'MSuppliersPayForm.tsx');
  assert.match(s, /const body = paymentBody\(draft, settledBills, decimals\);/);
  assert.match(s, /const a = entryAttempt\(attempt\.current, body\);/, 'clientRef من المحتوى — الإعادة بعد ضياع الردّ تعيد السند نفسه');
  assert.match(s, /supplierPaymentsApi\.create\(\{ \.\.\.body, clientRef: a\.ref \}\)/);
  assert.match(s, /\['m-suppliers'\], \['m-wh-entries'\]/, 'مدفوع/متبقّي الوارد في سجلّ المستودع يتغيّر بالسند');
  assert.match(s, /method: '',/, 'لا طريقة افتراضية — الطريقة تقرّر من أين خرج المال');
  const v = read('m', 'MSuppliersPaymentView.tsx');
  assert.match(v, /const cancellable = canCancelPayment\(p\);/);
  assert.match(v, /\{cancellable && \(/, 'زرّ الإلغاء خلف القاعدة');
  assert.match(v, /supplierPaymentsApi\.cancel\(paymentId, reason\)/);
});

test('الورقة: كشف المورّد بعباراته لا بقالب العميل، ومن صفوف الشاشة', () => {
  const d = code(read('m', 'MSuppliersDocs.tsx'));
  assert.doesNotMatch(d, /PrintableStatement|statementDocFromData|DocumentResult/, 'قالب العميل يقول للمورّد إنّه مدين');
  assert.doesNotMatch(d, /suppliersApi|supplierPaymentsApi/, 'الورقة تُبنى من بيانات الشاشة لا بطلبٍ جديد');
  const c = read('m', 'MSuppliersCard.tsx');
  assert.match(c, /doc=\{\{ kind: 'statement', statement: statementQ\.data, from: from \|\| undefined, to: to \|\| undefined \}\}/);
});
