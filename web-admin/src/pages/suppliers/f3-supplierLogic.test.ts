import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  agingHasUnapplied, agingRows, amountInputText, balanceSide, defaultStatementPeriod, draftOfSupplier, draftPlan, emptyPaymentDraft,
  formulaSafe, isPaymentView, isValidDay, isValidIban, paymentIdOf, manualAllocationMilli, normalizeIban, normalizeNumberText, overdueSummary, parseAmount,
  parsePaymentDays, paymentActions, paymentBody, paymentDaysText, paymentProblem, periodInverted, planAllocations, safeFileName,
  statementKindLabel, statementRows, sumAmounts, supplierCreateBody, supplierErrorText, supplierProblem, supplierUpdateBody, toCsv,
  toMilli, voucherSplit, type PaymentDraft, type PlanBill,
} from './supplierLogic';
import type { Supplier, SupplierAging, SupplierStatement } from '../../api/suppliers';

/**
 * «ربط الدفاتر» L1 — منطق صفحة الموردين. أهمّ ما يُحرس: الدقّة المحاسبية (الحساب بالملّي الصحيح فلا غبار عائم، ومعاينة
 * التخصيص التلقائي تطابق خوارزمية الخادم)، وجسم السند والمورّد كما يتوقّعه العقد حرفاً.
 */

const tr = (s: string) => s;
const SUPPLIER: Supplier = {
  id: 'v1', name: 'مؤسسة الندى', nameEn: 'Al Nada Est', code: 'S-01', vatNumber: '300000000000003', crNumber: null, phone: '0550000000',
  email: null, address: null, city: 'الرياض', countryCode: 'SA', iban: null, bankName: null, paymentDays: 30, isActive: true,
  notes: null, createdAt: '2026-11-01T00:00:00.000Z', balance: 1500, openBillsCount: 2,
};

// ─── الملّي والمبالغ ───

test('toMilli مرآة toMilliAmount في الخادم على ٣٠٠٠ مبلغٍ عشوائي (منازل ٠ و٢ و٣)', async () => {
  const coreFile = path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'suppliers', 'core.ts');
  assert.ok(fs.existsSync(coreFile), 'services/suppliers/core.ts غائب');
  const core = await import(pathToFileURL(coreFile).href) as { toMilliAmount: (x: number, d: number) => bigint };
  let seed = 1113;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 3000; k++) {
    const x = Math.round(rnd() * 10_000_000) / 10_000;
    for (const d of [0, 2, 3]) assert.equal(BigInt(toMilli(x, d)), core.toMilliAmount(x, d), `x=${x} d=${d}`);
  }
  // أنصاف الهللة نصف-لأعلى رغم التمثيل الثنائي (1.005×100 = 100.49999…)
  assert.equal(toMilli(1.005, 2), 1010);
  assert.equal(toMilli(2.675, 2), 2680);
});

test('sumAmounts يجمع بالملّي — 0.1 + 0.2 = 0.3 تماماً', () => {
  assert.equal(sumAmounts([0.1, 0.2]), 0.3);
  assert.equal(sumAmounts([1000.115, 0.005, null, undefined]), 1000.12);
  assert.equal(sumAmounts([]), 0);
});

test('parseAmount: الأرقام العربية والفاصلة العربية، ورفض منازل أكثر من العملة لا تقريبها', () => {
  assert.deepEqual(parseAmount('١٢٣٫٤٥', 2), { ok: true, value: 123.45, milli: 123450 });
  assert.deepEqual(parseAmount('1,5', 2), { ok: true, value: 1.5, milli: 1500 });
  assert.deepEqual(parseAmount('  ', 2), { ok: false, reason: 'EMPTY' });
  assert.deepEqual(parseAmount('10.005', 2), { ok: false, reason: 'DECIMALS' });
  assert.deepEqual(parseAmount('10.005', 3), { ok: true, value: 10.005, milli: 10005 });
  assert.deepEqual(parseAmount('-5', 2), { ok: false, reason: 'INVALID' });
  assert.deepEqual(parseAmount('1e3', 2), { ok: false, reason: 'INVALID' });
  assert.deepEqual(parseAmount('12.', 2), { ok: false, reason: 'INVALID' });
  assert.deepEqual(parseAmount('0', 2), { ok: true, value: 0, milli: 0 });
  assert.equal(normalizeNumberText('١٬٢٣٤٫٥'), '1234.5');
  assert.equal(amountInputText(10, 2), '10.00');
  assert.equal(amountInputText(1.0005, 3), '1.001');
});

test('balanceSide: الموجب مستحقٌّ للمورّد، والسالب دفعة مقدّمة، وغبار ما دون الملّي صفر', () => {
  assert.equal(balanceSide(10), 'PAYABLE');
  assert.equal(balanceSide(-0.01), 'ADVANCE');
  assert.equal(balanceSide(0.0004), 'ZERO');
  assert.equal(balanceSide(null), 'ZERO');
});

// ─── الأيام ───

test('الأيام: صحّة تقويمية، والفترة الافتراضية من أول السنة، والفترة المقلوبة', () => {
  assert.equal(isValidDay('2026-02-29'), false);
  assert.equal(isValidDay('2028-02-29'), true);
  assert.equal(isValidDay('2026-1-01'), false);
  assert.deepEqual(defaultStatementPeriod('2026-11-13'), { from: '2026-01-01', to: '2026-11-13' });
  assert.equal(periodInverted('2026-11-14', '2026-11-13'), true);
  assert.equal(periodInverted('2026-11-13', '2026-11-13'), false);
  assert.equal(periodInverted('', '2026-11-13'), false);
});

// ─── نموذج المورّد ───

test('الآيبان: التطبيع وفحص باقي القسمة على ٩٧ وطول السعودي', () => {
  assert.equal(normalizeIban(' gb82 west 1234 5698 7654 32 '), 'GB82WEST12345698765432');
  assert.equal(isValidIban('GB82 WEST 1234 5698 7654 32'), true);
  assert.equal(isValidIban('DE89370400440532013000'), true);
  // رقمٌ واحد خاطئ يُمسك
  assert.equal(isValidIban('GB82WEST12345698765433'), false);
  // تبديل رقمين متجاورين يُمسك
  assert.equal(isValidIban('DE89370400440532010300'), false);
  // سعوديٌّ صالح البنية والمجموع (٢٤ خانة)، وقصيرٌ مرفوض
  const sa = saIban('80000000608010167519');
  assert.equal(sa.length, 24);
  assert.equal(isValidIban(sa), true);
  assert.equal(isValidIban(sa.slice(0, 22)), false);
  assert.equal(isValidIban('SA00'), false);
});

/** يبني آيبان سعودياً صالحاً من رقم الحساب البنكي (BBAN) بحساب خانتي التحقق */
function saIban(bban: string): string {
  const num = (bban + 'SA00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of num) rem = (rem * 10 + Number(d)) % 97;
  return `SA${String(98 - rem).padStart(2, '0')}${bban}`;
}

test('مدة السداد: فارغة null، وصحيحة ٠..٣٦٥، وغير ذلك غير صالحة', () => {
  assert.equal(parsePaymentDays(''), null);
  assert.equal(parsePaymentDays('٣٠'), 30);
  assert.equal(parsePaymentDays('0'), 0);
  assert.equal(parsePaymentDays('365'), 365);
  assert.equal(parsePaymentDays('366'), undefined);
  assert.equal(parsePaymentDays('2.5'), undefined);
  assert.equal(parsePaymentDays('-1'), undefined);
  assert.equal(paymentDaysText(null, tr), 'بلا مدة');
  assert.equal(paymentDaysText(0, tr), 'فوري');
  assert.equal(paymentDaysText(45, tr), '45 يوم');
});

test('supplierProblem: الاسم مطلوب و≤١٢٠، والمدة والبريد والآيبان', () => {
  const d = draftOfSupplier(null);
  assert.equal(supplierProblem(d), 'NAME_REQUIRED');
  assert.equal(supplierProblem({ ...d, name: 'x'.repeat(121) }), 'NAME_TOO_LONG');
  assert.equal(supplierProblem({ ...d, name: 'مورد', paymentDays: '400' }), 'PAYMENT_DAYS_INVALID');
  assert.equal(supplierProblem({ ...d, name: 'مورد', email: 'a@b' }), 'EMAIL_INVALID');
  assert.equal(supplierProblem({ ...d, name: 'مورد', iban: 'SA1234' }), 'IBAN_INVALID');
  assert.equal(supplierProblem({ ...d, name: 'مورد', email: 'buy@nada.sa', paymentDays: '30', iban: 'GB82WEST12345698765432' }), null);
});

test('supplierCreateBody: الاسم وما كُتب فقط — الفارغ لا يُرسل، والآيبان مطبَّعاً، والمدة رقماً', () => {
  const d = { ...draftOfSupplier(null), name: '  مؤسسة الندى ', phone: ' 055 ', iban: 'gb82 west 1234 5698 7654 32', paymentDays: '٣٠', notes: '   ' };
  assert.deepEqual(supplierCreateBody(d), { name: 'مؤسسة الندى', phone: '055', iban: 'GB82WEST12345698765432', paymentDays: 30 });
  // المدة الفارغة لا تُرسل (الخادم يفترض null)
  assert.deepEqual(supplierCreateBody({ ...draftOfSupplier(null), name: 'م' }), { name: 'م' });
});

test('supplierUpdateBody: ما تغيّر وحده، والممسوح null صريحاً، والخانة غير الملموسة لا تُرسل', () => {
  const d0 = draftOfSupplier(SUPPLIER);
  assert.deepEqual(supplierUpdateBody(d0, SUPPLIER), {}, 'بلا تغيير ⇒ جسمٌ فارغ');
  const d1 = { ...d0, phone: '', city: 'جدة', paymentDays: '' };
  assert.deepEqual(supplierUpdateBody(d1, SUPPLIER), { phone: null, city: 'جدة', paymentDays: null });
  // مسافةٌ زائدة ليست تغييراً
  assert.deepEqual(supplierUpdateBody({ ...d0, name: ` ${SUPPLIER.name} ` }, SUPPLIER), {});
  // الرقم الضريبي المخفيّ (شركة بلا ضريبة) يبقى في المسودة كما هو فلا يُرسل
  assert.equal('vatNumber' in supplierUpdateBody({ ...d0, code: 'S-02' }, SUPPLIER), false);
  // مدةٌ جديدة
  assert.deepEqual(supplierUpdateBody({ ...d0, paymentDays: '60' }, SUPPLIER), { paymentDays: 60 });
});

test('supplierErrorText: نصّ الرمز المعروف، وإلا رسالة الخادم، وإلا البديل', () => {
  const err = (code?: string, message?: string) => ({ response: { data: { code, message } } });
  assert.equal(supplierErrorText(err('SUPPLIER_HAS_HISTORY', 'x'), 'f'), 'للمورد حركات أو قيود أو دفعات فلا يحذف أرشفه بدلا من الحذف');
  assert.equal(supplierErrorText(err('SUPPLIER_PAYMENT_INVALID', 'الفاتورة لمورّد آخر'), 'f'), 'الفاتورة لمورّد آخر');
  assert.equal(supplierErrorText(err(undefined, ' '), 'تعذر الحفظ'), 'تعذر الحفظ');
  assert.equal(supplierErrorText(new Error('net'), 'تعذر الحفظ'), 'تعذر الحفظ');
});

// ─── التخصيص ───

const BILLS: PlanBill[] = [
  { warehouseEntryId: 'b1', outstanding: 100.1 },
  { warehouseEntryId: 'b2', outstanding: 0.2 },
  { warehouseEntryId: 'b3', outstanding: 50 },
];

test('planAllocations التلقائي: بترتيب الفواتير وبما لا يتجاوز متبقّيها والمبلغ — والزائد مقدَّم', () => {
  assert.deepEqual(planAllocations(100_300, BILLS, 'AUTO'), {
    lines: [{ warehouseEntryId: 'b1', milli: 100_100 }, { warehouseEntryId: 'b2', milli: 200 }],
    allocatedMilli: 100_300, unappliedMilli: 0,
  });
  assert.deepEqual(planAllocations(50_000, BILLS, 'AUTO').lines, [{ warehouseEntryId: 'b1', milli: 50_000 }]);
  const over = planAllocations(200_000, BILLS, 'AUTO');
  assert.equal(over.allocatedMilli, 150_300);
  assert.equal(over.unappliedMilli, 49_700);
  assert.deepEqual(planAllocations(10_000, BILLS, 'NONE'), { lines: [], allocatedMilli: 0, unappliedMilli: 10_000 });
});

test('planAllocations التلقائي — خواصّ على ٢٠٠٠ حالةٍ عشوائية: Σ = min(المبلغ، Σ المتبقّي)، وكلٌّ ≤ متبقّيه، وبلا قفز', () => {
  let seed = 77;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 2000; k++) {
    const bills: PlanBill[] = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => ({ warehouseEntryId: `b${i}`, outstanding: Math.round(rnd() * 100000) / 100 }));
    const amountMilli = Math.round(rnd() * 200000) * 10;
    const p = planAllocations(amountMilli, bills, 'AUTO');
    const totalOut = bills.reduce((s, b) => s + Math.round(b.outstanding * 1000), 0);
    assert.equal(p.allocatedMilli, Math.min(amountMilli, totalOut));
    assert.equal(p.allocatedMilli + p.unappliedMilli, amountMilli);
    for (const l of p.lines) {
      const b = bills.find((x) => x.warehouseEntryId === l.warehouseEntryId)!;
      assert.ok(l.milli > 0 && l.milli <= Math.round(b.outstanding * 1000));
    }
    // الأقدم أولاً: كل فاتورةٍ قبل آخر سطرٍ مخصَّص مسدَّدةٌ بالكامل
    const lastIdx = p.lines.length ? bills.findIndex((b) => b.warehouseEntryId === p.lines[p.lines.length - 1].warehouseEntryId) : -1;
    for (let i = 0; i < lastIdx; i++) {
      const line = p.lines.find((l) => l.warehouseEntryId === bills[i].warehouseEntryId);
      assert.equal(line?.milli ?? 0, Math.round(bills[i].outstanding * 1000));
    }
  }
});

const draft = (over: Partial<PaymentDraft> = {}): PaymentDraft => ({ ...emptyPaymentDraft('2026-11-13'), amount: '150.3', ...over });

test('paymentProblem: المبلغ والمندوب والتاريخ والتخصيص اليدوي', () => {
  assert.equal(paymentProblem(draft({ amount: '' }), BILLS, 2), 'AMOUNT_REQUIRED');
  assert.equal(paymentProblem(draft({ amount: '0' }), BILLS, 2), 'AMOUNT_INVALID');
  assert.equal(paymentProblem(draft({ amount: '1.234' }), BILLS, 2), 'AMOUNT_DECIMALS');
  assert.equal(paymentProblem(draft({ method: 'REP_CUSTODY' }), BILLS, 2), 'REP_REQUIRED');
  assert.equal(paymentProblem(draft({ method: 'REP_CUSTODY', salesRepId: 'r1' }), BILLS, 2), null);
  assert.equal(paymentProblem(draft({ paidAt: '2026-02-30' }), BILLS, 2), 'DATE_INVALID');
  assert.equal(paymentProblem(draft({ reference: 'x'.repeat(101) }), BILLS, 2), 'REFERENCE_TOO_LONG');
  // اليدوي: فوق متبقّي الفاتورة، وΣ فوق المبلغ، والمساوي تماماً مقبول (لا غبار عائم)
  assert.equal(paymentProblem(draft({ mode: 'MANUAL', manual: { b2: '0.21' } }), BILLS, 2), 'ALLOC_OVER_OUTSTANDING');
  assert.equal(paymentProblem(draft({ mode: 'MANUAL', amount: '100', manual: { b1: '100.1' } }), BILLS, 2), 'ALLOC_OVER_AMOUNT');
  assert.equal(paymentProblem(draft({ mode: 'MANUAL', amount: '100.3', manual: { b1: '100.1', b2: '0.2' } }), BILLS, 2), null);
  assert.equal(paymentProblem(draft({ mode: 'MANUAL', manual: { b1: 'abc' } }), BILLS, 2), 'ALLOC_INVALID');
  assert.equal(paymentProblem(draft({ mode: 'MANUAL', manual: { b1: '1.001' } }), BILLS, 2), 'ALLOC_DECIMALS');
  // التخصيص لفاتورةٍ لم تعد في القائمة يُتجاهل (لا يُرسل)
  const m = manualAllocationMilli({ manual: { gone: '5', b3: '' } }, BILLS, 2);
  assert.ok(m.ok && m.map.size === 0);
});

test('paymentBody: التلقائي autoAllocate، واليدوي بسطوره، وبلا تخصيص لا هذا ولا ذاك، والمندوب للعهدة وحدها', () => {
  assert.deepEqual(paymentBody(draft({ reference: ' CHQ-9 ', note: ' ' }), 'v1', BILLS, 2), {
    supplierId: 'v1', amount: 150.3, method: 'CASH', paidAt: '2026-11-13', reference: 'CHQ-9', autoAllocate: true,
  });
  assert.deepEqual(paymentBody(draft({ mode: 'MANUAL', amount: '١٠٠٫٣', manual: { b1: '100.1', b2: '0.2', b3: '0' }, salesRepId: 'r1' }), 'v1', BILLS, 2), {
    supplierId: 'v1', amount: 100.3, method: 'CASH', paidAt: '2026-11-13',
    allocations: [{ warehouseEntryId: 'b1', amount: 100.1 }, { warehouseEntryId: 'b2', amount: 0.2 }],
  });
  assert.deepEqual(paymentBody(draft({ mode: 'NONE', method: 'REP_CUSTODY', salesRepId: 'r1' }), 'v1', BILLS, 2), {
    supplierId: 'v1', amount: 150.3, method: 'REP_CUSTODY', salesRepId: 'r1', paidAt: '2026-11-13',
  });
  // يدويٌّ بلا سطور ⇒ لا allocations (دفعة مقدّمة صريحة)
  assert.equal('allocations' in paymentBody(draft({ mode: 'MANUAL' }), 'v1', BILLS, 2), false);
});

test('draftPlan: معاينة النموذج — اليدوي غير الصالح بلا سطور، والمبلغ غير الصالح صفر', () => {
  assert.equal(draftPlan(draft({ amount: 'x' }), BILLS, 2).unappliedMilli, 0);
  assert.equal(draftPlan(draft({ mode: 'MANUAL', manual: { b1: '200' } }), BILLS, 2).allocatedMilli, 0);
  assert.deepEqual(draftPlan(draft({ mode: 'MANUAL', manual: { b3: '50' } }), BILLS, 2), {
    lines: [{ warehouseEntryId: 'b3', milli: 50_000 }], allocatedMilli: 50_000, unappliedMilli: 100_300,
  });
});

test('voucherSplit وpaymentActions: الدفعة المقدّمة بالملّي، والآلي لا يُلغى من هنا', () => {
  assert.deepEqual(voucherSplit({ amount: 0.3, allocations: [{ warehouseEntryId: 'a', supplierRef: null, amount: 0.1 }, { warehouseEntryId: 'b', supplierRef: null, amount: 0.2 }] }), { allocated: 0.3, unapplied: 0 });
  assert.deepEqual(voucherSplit({ amount: 500, allocations: [] }), { allocated: 0, unapplied: 500 });
  assert.deepEqual(paymentActions({ status: 'POSTED', autoForEntryId: null }, true), { cancel: true, autoLocked: false });
  assert.deepEqual(paymentActions({ status: 'POSTED', autoForEntryId: 'e1' }, true), { cancel: false, autoLocked: true });
  assert.deepEqual(paymentActions({ status: 'CANCELLED', autoForEntryId: null }, true), { cancel: false, autoLocked: false });
  assert.deepEqual(paymentActions({ status: 'POSTED', autoForEntryId: null }, false), { cancel: false, autoLocked: false });
});

test('isPaymentView وpaymentIdOf: السند الكامل يُرسم، والردّ الأنحف يُجلب بمعرّفه', () => {
  const full = { id: 'p1', number: 1, displayNumber: 'SP-000001', amount: 10, allocations: [], status: 'POSTED' };
  assert.equal(isPaymentView(full), true);
  assert.equal(isPaymentView({ id: 'p1', number: 1 }), false);
  assert.equal(isPaymentView({ ...full, allocations: undefined }), false);
  assert.equal(isPaymentView(null), false);
  assert.equal(paymentIdOf({ id: 'p1', number: 1 }), 'p1');
  assert.equal(paymentIdOf({ id: '' }), null);
  assert.equal(paymentIdOf(undefined), null);
});

test('overdueSummary: المتأخّر وحده ومجموعه بالملّي', () => {
  assert.deepEqual(overdueSummary([{ daysOverdue: 3, outstanding: 0.1 }, { daysOverdue: 0, outstanding: 5 }, { daysOverdue: 40, outstanding: 0.2 }]), { count: 2, outstanding: 0.3, total: 5.3 });
});

// ─── التصدير ───

const STATEMENT: SupplierStatement = {
  supplier: SUPPLIER, currency: 'SAR', from: '2026-01-01', to: '2026-11-13', opening: 200, closing: 1500, totalDebit: 700, totalCredit: 2000,
  lines: [
    { id: 'l1', date: '2026-03-01', kind: 'BILL', ref: 'INV-77', description: null, debit: 0, credit: 2000, balance: 2200, dueDate: '2026-03-31', warehouseEntryId: 'e1', supplierPaymentId: null, attachmentsCount: 1 },
    { id: 'l2', date: '2026-04-01', kind: 'PAYMENT', ref: 'SP-000001', description: '=HYPERLINK("x")', debit: 700, credit: 0, balance: 1500, dueDate: null, warehouseEntryId: null, supplierPaymentId: 'p1', attachmentsCount: 0 },
  ],
};

test('statementRows: الافتتاحي ثم السطور ثم الإجمالي، والرصيد الجاري يطابق الافتتاحي + Σ(دائن − مدين)', () => {
  const rows = statementRows(STATEMENT, { tr, decimals: 2, dayText: (d) => d ?? '' });
  assert.equal(rows.length, 4);
  assert.equal(rows[0]['النوع'], 'رصيد افتتاحي');
  assert.equal(rows[0]['الرصيد'], 200);
  assert.equal(rows[1]['النوع'], 'فاتورة مورد');
  assert.equal(rows[1]['دائن'], 2000);
  assert.equal(rows[1]['مدين'], '');
  assert.equal(rows[2]['البيان'], `'=HYPERLINK("x")`, 'الصيغة محيَّدة');
  assert.deepEqual([rows[3]['مدين'], rows[3]['دائن'], rows[3]['الرصيد']], [700, 2000, 1500]);
  // الاتّساق المحاسبي: الإقفال = الافتتاحي + الدائن − المدين
  assert.equal(sumAmounts([STATEMENT.opening, STATEMENT.totalCredit, -STATEMENT.totalDebit]), STATEMENT.closing);
});

test('agingRows: الشرائح والإجمالي، وعمود «غير مخصص» حين في التقرير ما ليس على فاتورة وحده', () => {
  const base: SupplierAging = {
    asOf: '2026-11-13',
    rows: [{ supplierId: 'v1', name: 'الندى', code: 'S-01', current: 100, d1_30: 50, d31_60: 0, d61_90: 0, d90_plus: 25.5, total: 175.5, balance: 175.5, unapplied: 0 }],
    totals: { current: 100, d1_30: 50, d31_60: 0, d61_90: 0, d90_plus: 25.5, total: 175.5, balance: 175.5, unapplied: 0 },
  };
  assert.equal(agingHasUnapplied(base), false);
  const rows = agingRows(base, { tr, decimals: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['أكثر من 90 يوما'], 25.5);
  assert.equal(rows[1]['المورد'], 'الإجمالي');
  assert.equal('غير مخصص' in rows[0], false);
  const adv: SupplierAging = { ...base, rows: [{ ...base.rows[0], balance: 75.5, unapplied: -100 }], totals: { ...base.totals, balance: 75.5, unapplied: -100 } };
  assert.equal(agingHasUnapplied(adv), true);
  const r2 = agingRows(adv, { tr, decimals: 2 });
  assert.equal(r2[0]['غير مخصص'], -100);
  assert.equal(r2[0]['رصيد الحساب'], 75.5);
});

test('toCsv: BOM وCRLF واقتباس RFC 4180', () => {
  const csv = toCsv([{ a: 'x,y', b: 'قال "مرحبا"', c: 12.5 }, { a: 'سطر\nثان', b: '', c: 0 }]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv, '﻿a,b,c\r\n"x,y","قال ""مرحبا""",12.5\r\n"سطر\nثان",,0\r\n');
  assert.equal(toCsv([]), '﻿');
});

test('formulaSafe وsafeFileName وstatementKindLabel', () => {
  assert.equal(formulaSafe('  +966'), `'  +966`);
  assert.equal(formulaSafe('مورد'), 'مورد');
  assert.equal(safeFileName('كشف: مورد/ ١ *'), 'كشف- مورد- ١ -');
  assert.equal(statementKindLabel('REFUND_IN'), 'استرداد نقدي من المورد');
  assert.equal(statementKindLabel('FUTURE_KIND'), 'FUTURE_KIND');
});
