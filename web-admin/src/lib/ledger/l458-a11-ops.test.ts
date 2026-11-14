import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ReceiptCancelOptions } from '../../api/ledgerOps';
import {
  adjustmentDraftCheck, adjustmentRequestBody, autoAllocationPreview, cancelRequestBody, clearingDraftCheck, clearingRequestBody,
  explainConsistency, explainEventKey, fitsCurrencyMilli, initialRefundChoice, methodAccountCandidates, methodJournalCandidates,
  methodMapRowLabel, milliWire, moveTypeLabels, numberMilli, opsErrorMessage, parseOpsAmount, receiptMayNeedRefundSource,
  refundChoiceComplete, refundPickerVisible, selectedResidualMilli, sourceDocumentHref, sourceTypeLabels, unitMilliOf,
  type AdjustmentCheckContext, type AdjustmentDraftInput, type ClearingCheckContext, type ClearingDraftInput,
} from './sync';
import {
  cancelRefundSourceLabels, clearingKindLabels, clearingReasonLabels, custodyExplainKindLabels, customerAdjustmentKindLabels,
  customerAdjustmentReasonLabels, ledgerLinkedReasonLabels, paymentMethodMapReasonLabels, receiptCancelCodeLabels,
  writeoffCounterLabels,
} from './labels';
import { ledgerReasonLabels } from './errors';

/**
 * «ربط الدفاتر» L4/L5 — منطق شاشات العمليات (A11، العقد §6.4): متى يظهر منتقي «من أين رُدّ المال؟» وجسم الإلغاء (لا جسم
 * لغير المربوطة)، وتحقّق مبالغ التسوية الموجّهة وتسويات الذمم بالملّي ومعاينة قيودها (أمثلة العقد E4.13/E4.14/E5.6/E5.14)،
 * وتفسير فرق العهدة، وخريطة الطرق، وتطابق التسميات مع قوائم الخادم (مسح نصّي — لا استيراد للخادم).
 */

const id = (s: string) => s;
const web = path.resolve(process.cwd(), 'src');
const backend = path.resolve(process.cwd(), '..', 'backend', 'src');
const readIf = (f: string): string | null => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null);
/** أعضاء مصفوفة `name = [...] as const` أو اتحاد `type name = 'A' | 'B'` في نصّ مصدر */
function constList(src: string, name: string): string[] {
  const arr = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  // الاتحاد حتى «;» — قد يبدأ باسم اتحادٍ آخر (ClearingRouteReason = ClearingProblemReason | 'A' | …) فتُؤخذ حرفياته وحدها
  const union = new RegExp(`type ${name}\\s*=\\s*([^;]*);`).exec(src);
  const body = arr?.[1] ?? union?.[1];
  assert.ok(body, `${name} غير موجود`);
  return [...body.matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
}

// ═══ حوار إلغاء السند (C11) ═══

const handedOver = (over: Partial<ReceiptCancelOptions> = {}): ReceiptCancelOptions => ({
  linked: true,
  custodyClass: 'CUSTODY',
  handedOver: true,
  suggested: 'USER_CUSTODY',
  suggestedUserId: 'u1',
  repOutstanding: 0,
  options: [
    { value: 'REP_CUSTODY' },
    { value: 'USER_CUSTODY', userId: 'u1', userName: 'أمين', userOutstanding: 800 },
    { value: 'MAIN_CASH' },
    { value: 'BANK' },
  ],
  ...over,
});

test('منتقي الردّ: يظهر للمربوطة وحدها، لسند عهدة سُلِّم ماله، وبخيارات', () => {
  assert.equal(refundPickerVisible(handedOver()), true);
  // غير المربوطة: لا منتقي ولا جسم — الإلغاء حرفياً كاليوم
  assert.equal(refundPickerVisible(handedOver({ linked: false })), false);
  assert.equal(cancelRequestBody(handedOver({ linked: false }), { refundFrom: 'MAIN_CASH', userId: null }), undefined);
  assert.equal(refundPickerVisible(handedOver({ custodyClass: 'ONLINE', options: [] })), false);
  assert.equal(refundPickerVisible(handedOver({ custodyClass: 'OUTSIDE', suggested: 'METHOD' })), false);
  assert.equal(refundPickerVisible(handedOver({ handedOver: false, suggested: 'REP_CUSTODY' })), false);
  assert.equal(refundPickerVisible(handedOver({ options: [] })), false);
  // الخيارات تعذّر جلبها أو لم تُطلب ⇒ بلا جسم
  assert.equal(refundPickerVisible(null), false);
  assert.equal(cancelRequestBody(null, null), undefined);
  assert.equal(cancelRequestBody(undefined, { refundFrom: 'BANK', userId: null }), undefined);
  assert.equal(initialRefundChoice(handedOver({ linked: false })), null);
});

test('منتقي الردّ: المقترح محدّد مسبقاً بمستخدمه، والجسم يحمل المستخدم لعهدة المستخدم وحدها', () => {
  const o = handedOver();
  const c = initialRefundChoice(o)!;
  assert.deepEqual(c, { refundFrom: 'USER_CUSTODY', userId: 'u1' });
  assert.deepEqual(cancelRequestBody(o, c), { refundFrom: 'USER_CUSTODY', refundFromUserId: 'u1' });
  assert.deepEqual(cancelRequestBody(o, { refundFrom: 'MAIN_CASH', userId: null }), { refundFrom: 'MAIN_CASH' });
  assert.deepEqual(cancelRequestBody(o, { refundFrom: 'BANK', userId: 'ignored' }), { refundFrom: 'BANK' });
  // مقترح MAIN_CASH (لا مستلِم يحمل ما يكفي) ⇒ الصندوق
  assert.deepEqual(initialRefundChoice(handedOver({ suggested: 'MAIN_CASH', suggestedUserId: null })), { refundFrom: 'MAIN_CASH', userId: null });
  // مقترح خارج الخيارات ⇒ أول خيار
  assert.deepEqual(initialRefundChoice(handedOver({ suggested: 'METHOD' })), { refundFrom: 'REP_CUSTODY', userId: null });
  // عهدة مستخدم بلا مستخدم، أو خيار لا يعرضه الخادم ⇒ غير مكتمل ولا جسم
  assert.equal(refundChoiceComplete(o, { refundFrom: 'USER_CUSTODY', userId: null }), false);
  assert.equal(cancelRequestBody(o, { refundFrom: 'USER_CUSTODY', userId: null }), undefined);
  assert.equal(refundChoiceComplete(o, { refundFrom: 'METHOD', userId: null }), false);
  assert.equal(cancelRequestBody(o, { refundFrom: 'METHOD', userId: null }), undefined);
  // بلا منتقي: التأكيد متاح دائماً
  assert.equal(refundChoiceComplete(handedOver({ linked: false }), null), true);
});

test('cancel-options يُطلب لسند نقد أو شيك بيد مندوب وحده — غيره بلا طلب إضافي', () => {
  const rep = { id: 'r1' };
  assert.equal(receiptMayNeedRefundSource({ paymentMethod: 'CASH', salesRep: rep, status: 'ACTIVE' }), true);
  assert.equal(receiptMayNeedRefundSource({ paymentMethod: 'CHEQUE', salesRep: rep }), true);
  for (const m of ['BANK_TRANSFER', 'POS', 'ONLINE']) assert.equal(receiptMayNeedRefundSource({ paymentMethod: m, salesRep: rep }), false, m);
  assert.equal(receiptMayNeedRefundSource({ paymentMethod: 'CASH', salesRep: null }), false);
  assert.equal(receiptMayNeedRefundSource({ paymentMethod: 'CASH', salesRep: rep, status: 'CANCELLED' }), false);
  assert.equal(receiptMayNeedRefundSource(undefined), false);
});

test('receiptApi.cancel: بلا جسم ⇒ PATCH بلا جسم حرفياً كاليوم، وReceiptsPage يمرّر cancelRequestBody وحده', () => {
  const client = readIf(path.join(web, 'api', 'client.ts'))!;
  const m = /cancel: \(id: string, body\?: [^)]*\) => \(body \? api\.patch\(`\/receipts\/\$\{id\}\/cancel`, body\) : api\.patch\(`\/receipts\/\$\{id\}\/cancel`\)\),/.exec(client);
  assert.ok(m, 'receiptApi.cancel يجب أن يرسل الجسم حين يوجد وحده');
  assert.match(client, /cancelOptions: \(id: string\) => api\.get\(`\/receipts\/\$\{id\}\/cancel-options`\),/);
  const page = readIf(path.join(web, 'pages', 'ReceiptsPage.tsx'))!;
  assert.match(page, /cancelMutation\.mutate\(\{ id: cancelId, body: cancelRequestBody\(cancelOptions, refundChoice\) \}/);
  assert.match(page, /enabled: optionsEnabled,/);
});

// ═══ المبالغ بالملّي ═══

test('parseOpsAmount: منازل العملة 0 و2 و3 بلا تقريب صامت، والأرقام العربية والفواصل', () => {
  assert.equal(unitMilliOf(2), 10n);
  assert.equal(unitMilliOf(3), 1n);
  assert.equal(unitMilliOf(0), 1000n);
  assert.deepEqual(parseOpsAmount('51.73', 2), { ok: true, milli: 51730n });
  assert.deepEqual(parseOpsAmount('10.005', 2), { ok: false, reason: 'PRECISION' });
  assert.deepEqual(parseOpsAmount('10.005', 3), { ok: true, milli: 10005n });
  assert.deepEqual(parseOpsAmount('10.0050', 3), { ok: true, milli: 10005n });
  assert.deepEqual(parseOpsAmount('1.0005', 3), { ok: false, reason: 'PRECISION' });
  assert.deepEqual(parseOpsAmount('1500.5', 0), { ok: false, reason: 'PRECISION' });
  assert.deepEqual(parseOpsAmount('1500', 0), { ok: true, milli: 1500000n });
  assert.deepEqual(parseOpsAmount('1500.00', 0), { ok: true, milli: 1500000n });
  assert.deepEqual(parseOpsAmount('٢٠٠٠٫٥٠', 2), { ok: true, milli: 2000500n });
  assert.deepEqual(parseOpsAmount('1,234.5', 2), { ok: true, milli: 1234500n });
  assert.deepEqual(parseOpsAmount('-5', 2), { ok: true, milli: -5000n });
  assert.deepEqual(parseOpsAmount('', 2), { ok: true, milli: 0n });
  assert.deepEqual(parseOpsAmount('', 2, { required: true }), { ok: false, reason: 'REQUIRED' });
  assert.deepEqual(parseOpsAmount('abc', 2), { ok: false, reason: 'INVALID_AMOUNT' });
  // أرقام الخادم: مقرَّبة لكل مستند، وغبار الطفو لا يتسرّب
  assert.equal(numberMilli(0.1 + 0.2), 300n);
  assert.equal(numberMilli(1940.5), 1940500n);
  assert.equal(numberMilli(null), 0n);
  assert.equal(milliWire(1940500n), '1940.500');
  assert.equal(milliWire(-5n), '-0.005');
  assert.equal(fitsCurrencyMilli(1940500n, 2), true);
  assert.equal(fitsCurrencyMilli(1940505n, 2), false);
});

// ═══ التسوية الموجّهة (§5.2) ═══

const clearingCtx = (over: Partial<ClearingCheckContext> = {}): ClearingCheckContext => ({
  decimals: 2,
  lines: [{ lineId: 'l1', residual: 1200 }, { lineId: 'l2', residual: 800 }, { lineId: 'l3', residual: 500.25 }],
  openTotal: 2500.25,
  balance: 2500.25,
  ...over,
});
const clearingDraft = (over: Partial<ClearingDraftInput> = {}): ClearingDraftInput => ({
  date: '2026-11-14', bankAccountId: 'bank', gross: '', fee: '', feeVat: '', selected: [], ...over,
});
const sumDebit = (lines: { debitMilli: bigint }[]) => lines.reduce((s, l) => s + l.debitMilli, 0n);
const sumCredit = (lines: { creditMilli: bigint }[]) => lines.reduce((s, l) => s + l.creditMilli, 0n);

test('E5.14 نقطة بيع: 2,000 بعمولة 51.73 وضريبتها 7.77 ⇒ Dr البنك 1,940.50 + 51.73 + 7.77 / Cr الوسيط 2,000 — متّزن', () => {
  const d = clearingDraft({ gross: '2000', fee: '51.73', feeVat: '7.77', selected: ['l1', 'l2'] });
  const c = clearingDraftCheck(d, clearingCtx());
  assert.deepEqual(c.problems, []);
  assert.equal(c.netMilli, 1940500n);
  assert.deepEqual(c.preview.map(l => [l.role, l.debitMilli, l.creditMilli]), [
    ['BANK', 1940500n, 0n], ['FEE', 51730n, 0n], ['FEE_VAT', 7770n, 0n], ['CLEARING', 0n, 2000000n],
  ]);
  assert.equal(sumDebit(c.preview), sumCredit(c.preview));
  assert.equal(c.availableMilli, 2000000n);
  assert.deepEqual(clearingRequestBody('POS_SETTLEMENT', d, c, { ref: ' 77 ', note: '' }), {
    kind: 'POS_SETTLEMENT', date: '2026-11-14', bankAccountId: 'bank', gross: '2000.000', fee: '51.730', feeVat: '7.770', ref: '77', lineIds: ['l1', 'l2'],
  });
});

test('E5.6 تحصيل شيك 700 بلا عمولة: Dr البنك 700 / Cr شيكات تحت التحصيل 700، وبلا اختيار يُرسل بلا lineIds', () => {
  const ctx = clearingCtx({ lines: [{ lineId: 'c1', residual: 700 }], openTotal: 700, balance: 700 });
  const d = clearingDraft({ gross: '700' });
  const c = clearingDraftCheck(d, ctx);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.preview.map(l => [l.role, l.debitMilli, l.creditMilli]), [['BANK', 700000n, 0n], ['CLEARING', 0n, 700000n]]);
  assert.deepEqual(clearingRequestBody('CHEQUE_CLEARANCE', d, c), { kind: 'CHEQUE_CLEARANCE', date: '2026-11-14', bankAccountId: 'bank', gross: '700.000' });
});

test('التسوية الموجّهة ترفض المبالغ غير المتّسقة بأسباب الخادم وترتيبه', () => {
  const reasons = (over: Partial<ClearingDraftInput>, ctx = clearingCtx()) => clearingDraftCheck(clearingDraft(over), ctx).problems.map(p => p.reason);
  assert.deepEqual(reasons({ gross: '' }), ['GROSS_REQUIRED']);
  assert.deepEqual(reasons({ gross: 'x' }), ['INVALID_AMOUNT']);
  assert.deepEqual(reasons({ gross: '0' }), ['GROSS_NOT_POSITIVE']);
  assert.deepEqual(reasons({ gross: '100', fee: '-1' }), ['FEE_NEGATIVE']);
  assert.deepEqual(reasons({ gross: '100', fee: '1', feeVat: '-1' }), ['FEE_VAT_NEGATIVE']);
  assert.deepEqual(reasons({ gross: '100', fee: '90', feeVat: '15' }), ['FEES_EXCEED_GROSS']);
  assert.deepEqual(reasons({ gross: '100', feeVat: '1' }), ['FEE_VAT_WITHOUT_FEE']);
  assert.deepEqual(reasons({ gross: '100.005' }), ['PRECISION']);
  assert.deepEqual(reasons({ gross: '100', bankAccountId: '' }), ['BANK_REQUIRED']);
  assert.deepEqual(reasons({ gross: '100', date: '2026-13-01' }), ['INVALID_DATE']);
  // المختار 800 والإجمالي 800.01 ⇒ فوق المفتوح؛ وبلا اختيار يُقاس على كل المفتوح
  assert.deepEqual(reasons({ gross: '800.01', selected: ['l2'] }), ['EXCEEDS_OPEN']);
  assert.deepEqual(reasons({ gross: '2500.25' }), []);
  assert.deepEqual(reasons({ gross: '2500.26' }), ['EXCEEDS_OPEN']);
  // رصيد الوسيط أقل من المفتوح (قيد يدوي دائن) ⇒ فوق الرصيد
  assert.deepEqual(reasons({ gross: '600' }, clearingCtx({ balance: 500 })), ['EXCEEDS_BALANCE']);
  assert.deepEqual(reasons({ gross: '1' }, clearingCtx({ lines: [], openTotal: 0, balance: 0 })), ['NO_OPEN_LINES']);
  // منازل 3 (دينار بحريني) ومنازل 0 (دينار عراقي)
  assert.deepEqual(reasons({ gross: '100.005' }, clearingCtx({ decimals: 3 })), []);
  assert.deepEqual(reasons({ gross: '100.5' }, clearingCtx({ decimals: 0 })), ['PRECISION']);
  // مسودة فيها مشكلة لا جسم لها
  const bad = clearingDraft({ gross: '0' });
  assert.equal(clearingRequestBody('POS_SETTLEMENT', bad, clearingDraftCheck(bad, clearingCtx())), null);
  assert.equal(selectedResidualMilli(clearingCtx().lines, ['l1', 'l3', 'nope']), 1700250n);
});

// ═══ تسويات ذمم العملاء (M4، §4.8) ═══

const adjCtx = (over: Partial<AdjustmentCheckContext> = {}): AdjustmentCheckContext => ({
  decimals: 2,
  today: '2026-11-14',
  linkedFrom: '2026-01-01',
  invoices: [{ invoiceId: 'inv77', remaining: 300 }],
  debitBalance: 300,
  creditBalance: 0,
  ...over,
});
const adjDraft = (over: Partial<AdjustmentDraftInput> = {}): AdjustmentDraftInput => ({
  customerId: 'c1', kind: 'BAD_DEBT_WRITEOFF', amount: '300', docDate: '2026-11-14', autoAllocate: false, allocations: {}, ...over,
});

test('E4.13 شطب دين معدوم 300 على INV-77: التخصيص اليدوي بالضبط ⇒ جسم بالتخصيص والمقابل الافتراضي (711005)', () => {
  const d = adjDraft({ allocations: { inv77: '300' } });
  const c = adjustmentDraftCheck(d, adjCtx());
  assert.deepEqual(c.problems, []);
  assert.equal(c.allocatedMilli, 300000n);
  assert.deepEqual(adjustmentRequestBody(d, c), {
    customerId: 'c1', kind: 'BAD_DEBT_WRITEOFF', amount: '300.000', docDate: '2026-11-14', counter: 'BAD_DEBT',
    allocations: [{ invoiceId: 'inv77', amount: '300.000' }],
  });
  // بالمخصص (113009)
  assert.equal(adjustmentRequestBody(d, c, { counter: 'ALLOWANCE' })!.counter, 'ALLOWANCE');
});

test('الشطب التلقائي: الأقدم فالأقدم بحدّ المتبقّي، ومتبقٍّ ناقص ⇒ AUTO_INSUFFICIENT، والجسم autoAllocate وحده', () => {
  const ctx = adjCtx({ invoices: [{ invoiceId: 'a', remaining: 100 }, { invoiceId: 'b', remaining: 250.5 }], debitBalance: 1000 });
  const d = adjDraft({ autoAllocate: true, amount: '300' });
  const c = adjustmentDraftCheck(d, ctx);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.allocations, [{ invoiceId: 'a', amountMilli: 100000n }, { invoiceId: 'b', amountMilli: 200000n }]);
  const body = adjustmentRequestBody(d, c)!;
  assert.equal(body.autoAllocate, true);
  assert.equal('allocations' in body, false);
  const short = adjustmentDraftCheck(adjDraft({ autoAllocate: true, amount: '350.51' }), ctx);
  assert.deepEqual(short.problems.map(p => p.reason), ['AUTO_INSUFFICIENT']);
  assert.deepEqual(autoAllocationPreview(ctx.invoices, 350500n), { allocations: [{ invoiceId: 'a', amountMilli: 100000n }, { invoiceId: 'b', amountMilli: 250500n }], leftMilli: 0n });
});

test('الشطب اليدوي: Σ ≠ المبلغ، وفوق متبقّي الفاتورة، وبلا تخصيص، وفوق الرصيد المدين', () => {
  const reasons = (over: Partial<AdjustmentDraftInput>, ctx = adjCtx()) => adjustmentDraftCheck(adjDraft(over), ctx).problems.map(p => p.reason);
  assert.deepEqual(reasons({ allocations: { inv77: '100' } }), ['SUM_MISMATCH']);
  assert.deepEqual(reasons({ amount: '300', allocations: { inv77: '300.01' } }, adjCtx({ debitBalance: 400 })), ['EXCEEDS_REMAINING', 'SUM_MISMATCH']);
  assert.deepEqual(reasons({ allocations: {} }), ['ALLOCATIONS_REQUIRED']);
  assert.deepEqual(reasons({ allocations: { inv77: '  ' } }), ['ALLOCATIONS_REQUIRED']);
  assert.deepEqual(reasons({ allocations: { inv77: '0' } }), ['AMOUNT_NOT_POSITIVE', 'ALLOCATIONS_REQUIRED']);
  assert.deepEqual(reasons({ allocations: { inv77: '300' } }, adjCtx({ debitBalance: 200 })), ['WRITEOFF_EXCEEDS_DEBIT_BALANCE']);
  assert.deepEqual(reasons({ allocations: { ghost: '300' } }), ['INVOICE_NOT_FOUND', 'ALLOCATIONS_REQUIRED']);
  const c = adjustmentDraftCheck(adjDraft({ allocations: { inv77: '300.01' } }), adjCtx());
  assert.equal(c.problems.find(p => p.reason === 'EXCEEDS_REMAINING')?.invoiceId, 'inv77');
  assert.equal(adjustmentRequestBody(adjDraft({ allocations: { inv77: '100' } }), adjustmentDraftCheck(adjDraft({ allocations: { inv77: '100' } }), adjCtx())), null);
});

test('E4.14 ردّ رصيد دائن 200: نقداً (الافتراضي) أو تحويلاً، بحدّ الرصيد الدائن وبلا تخصيص', () => {
  const ctx = adjCtx({ invoices: [], debitBalance: 0, creditBalance: 200 });
  const d = adjDraft({ kind: 'CREDIT_REFUND', amount: '200', allocations: { stale: '50' } });
  const c = adjustmentDraftCheck(d, ctx);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(adjustmentRequestBody(d, c), { customerId: 'c1', kind: 'CREDIT_REFUND', amount: '200.000', docDate: '2026-11-14', method: 'CASH' });
  assert.equal(adjustmentRequestBody(d, c, { method: 'BANK_TRANSFER', reference: ' T-9 ', note: ' ' })!.method, 'BANK_TRANSFER');
  assert.equal(adjustmentRequestBody(d, c, { reference: ' T-9 ' })!.reference, 'T-9');
  assert.deepEqual(adjustmentDraftCheck(adjDraft({ kind: 'CREDIT_REFUND', amount: '200.01' }), ctx).problems.map(p => p.reason), ['REFUND_EXCEEDS_CREDIT_BALANCE']);
});

test('التسوية: العميل والمبلغ والتاريخ بين بداية الربط واليوم، ومنازل العملة', () => {
  const reasons = (over: Partial<AdjustmentDraftInput>, ctx = adjCtx()) => adjustmentDraftCheck(adjDraft({ allocations: { inv77: '300' }, ...over }), ctx).problems.map(p => p.reason);
  assert.deepEqual(reasons({ customerId: null }), ['CUSTOMER_REQUIRED']);
  assert.deepEqual(reasons({ amount: '' }), ['AMOUNT_REQUIRED']);
  assert.deepEqual(reasons({ amount: '-3' }), ['AMOUNT_NOT_POSITIVE']);
  assert.deepEqual(reasons({ docDate: '2026-11-15' }), ['DOC_DATE_IN_FUTURE']);
  assert.deepEqual(reasons({ docDate: '2025-12-31' }), ['BEFORE_CUTOVER']);
  assert.deepEqual(reasons({ docDate: '2026-01-01' }), []);
  assert.deepEqual(reasons({ docDate: 'x' }), ['INVALID_DATE']);
  assert.deepEqual(reasons({ docDate: '2025-12-31' }, adjCtx({ linkedFrom: null })), []);
  // دينار بحريني (3 منازل): 0.333 ؛ دينار عراقي (صفر منازل): 1500.5 مرفوض
  const bhd = adjCtx({ decimals: 3, invoices: [{ invoiceId: 'inv77', remaining: 1.099 }], debitBalance: 1.099 });
  assert.deepEqual(reasons({ amount: '0.333', allocations: { inv77: '0.333' } }, bhd), []);
  const iqd = adjCtx({ decimals: 0, invoices: [{ invoiceId: 'inv77', remaining: 3000 }], debitBalance: 3000 });
  assert.deepEqual(reasons({ amount: '1500.5', allocations: { inv77: '1500' } }, iqd), ['PRECISION']);
  assert.deepEqual(reasons({ amount: '1500', allocations: { inv77: '1500' } }, iqd), []);
});

// ═══ تفسير فرق العهدة (OD3) ═══

test('تفسير الفرق: E5.7 إلغاء بعد التسليم بردٍّ من الصندوق ⇒ بند −500 يفسّر الفرق كاملاً، ومراجع الأحداث', () => {
  const ok = explainConsistency({
    opsMilli: '-500000', ledgerMilli: '0', totalMilli: '-500000', unexplainedMilli: '0',
    items: [{ kind: 'CANCEL_REFUND_OUTSIDE', refId: 'r1', at: '2026-11-14T08:00:00.000Z', amountMilli: '-500000' }],
  });
  assert.deepEqual(ok, { gapMilli: -500000n, itemsMilli: -500000n, unexplainedMilli: 0n, consistent: true });
  const bad = explainConsistency({ opsMilli: '1000', ledgerMilli: '0', totalMilli: '400', unexplainedMilli: '600', items: [{ kind: 'ONLINE', refId: 'x', at: '', amountMilli: '400' }] });
  assert.equal(bad.consistent, false);
  assert.equal(explainEventKey('ONLINE', 'r9', '5'), 'RECEIPT:r9');
  assert.equal(explainEventKey('CANCEL_REFUND_OUTSIDE', 'r9', '-5'), 'RECEIPT:r9');
  assert.equal(explainEventKey('STAMPED_OUTSIDE', 'i1', '115000'), 'INVOICE:i1');
  assert.equal(explainEventKey('CASH_INVOICE_CUSTODY', 'i1', '-115000'), 'INVOICE:i1');
  assert.equal(explainEventKey('SETTLEMENT_R', 's1', '-1'), 'SETTLEMENT:s1');
  assert.equal(explainEventKey('SHORTAGE', 's1', '-1'), 'SETTLEMENT:s1');
  assert.equal(explainEventKey('SHORTAGE', 'sh1', '1'), null);
  assert.equal(explainEventKey('OPENING', 'rep', '1'), null);
  assert.equal(explainEventKey('EXPENSE', 'e1', '1'), null);
});

// ═══ خريطة طرق الدفع (D3) ═══

test('خريطة الطرق: الاسم (البطاقة والتوريد بلا مزوّد، المخصّصة بكلماتها، المدمجة المسمّاة كما هي)، والحسابات والدفاتر المقبولة', () => {
  const T = (s: string) => `T(${s})`;
  assert.equal(methodMapRowLabel({ methodKey: 'CARD', label: 'x', custom: false }, T), 'T(الدفع بالبطاقة)');
  assert.equal(methodMapRowLabel({ methodKey: 'PAYOUT', label: 'x', custom: false }, T), 'T(توريد أمانات الدفع الإلكتروني)');
  assert.equal(methodMapRowLabel({ methodKey: 'c_stc1', label: 'STC Pay', custom: true }, T), 'STC Pay');
  assert.equal(methodMapRowLabel({ methodKey: 'CASH', label: 'نقدي', custom: false }, T), 'T(نقدي)');
  assert.equal(methodMapRowLabel({ methodKey: 'CASH', label: 'كاش', custom: false }, T), 'كاش');
  assert.equal(methodMapRowLabel({ methodKey: 'BANK_TRANSFER', label: 'تحويل بنكي', custom: false }, T), 'T(تحويل بنكي)');
  const acc = (code: string, type: string, controlKind: string | null = null, isActive = true) => ({ id: code, code, type, controlKind, isActive });
  const picked = methodAccountCandidates([
    acc('111001', 'asset_cash'), acc('111102', 'asset_cash'), acc('112004', 'asset_current'), acc('112005', 'asset_current'),
    acc('911001', 'asset_current'), acc('111003', 'asset_cash', 'CUSTODY'), acc('113001', 'asset_receivable', 'AR'),
    acc('111999', 'asset_cash', null, false), acc('611008', 'expense'),
  ]).map(a => a.code);
  assert.deepEqual(picked, ['111001', '111102', '112004']);
  const j = (code: string, type: string, isActive = true) => ({ code, type, isActive });
  assert.deepEqual(methodJournalCandidates([j('INV', 'SALE'), j('BILL', 'PURCHASE'), j('CSH1', 'CASH'), j('BNK1', 'BANK'), j('MISC', 'GENERAL'), j('OLD', 'BANK', false)]).map(x => x.code), ['CSH1', 'BNK1', 'MISC']);
});

// ═══ الأخطاء والتسميات ═══

test('opsErrorMessage: تسمية الشاشة للسبب ثم للرمز، ثم العامة — ولا رسالة خادم عربية', () => {
  const clr = clearingReasonLabels(id);
  assert.equal(opsErrorMessage(id, { code: 'LEDGER_CLEARING_INVALID', details: { reason: 'EXCEEDS_OPEN' }, status: 422 }, clr), clr.EXCEEDS_OPEN);
  assert.equal(opsErrorMessage(id, { code: 'LEDGER_CLEARING_INVALID', reason: 'INVALID_KIND', status: 400 }, clr), 'نوع التسوية غير معروف');
  // بلا تسمية شاشة: العامة (INVALID_KIND للمرفقات والتسوية معاً)
  assert.equal(opsErrorMessage(id, { reason: 'INVALID_KIND', status: 400 }), 'النوع المطلوب غير معروف');
  assert.equal(opsErrorMessage(id, { code: 'RECEIPT_CANCEL_REFUND_USER', status: 400 }, receiptCancelCodeLabels(id)), receiptCancelCodeLabels(id).RECEIPT_CANCEL_REFUND_USER);
  const pm = paymentMethodMapReasonLabels(id);
  assert.equal(opsErrorMessage(id, { code: 'LEDGER_METHOD_ACCOUNT_INVALID', details: { reason: 'CONTROL' }, status: 422 }, pm), pm.CONTROL);
  assert.equal(opsErrorMessage(id, { code: 'LEDGER_BOOKS_NOT_LINKED', details: { reason: 'MANUAL_BOOKS' }, status: 409 }, pm), pm.MANUAL_BOOKS);
  assert.equal(opsErrorMessage(id, { status: 400 }), 'بيانات غير صالحة');
  // أسباب «ربط الدفاتر» العامة تصل ledgerReasonLabels (حارس errors.test)
  const all = ledgerReasonLabels(id);
  for (const k of Object.keys(ledgerLinkedReasonLabels(id))) assert.ok(all[k], k);
});

test('التسميات تغطّي قوائم الخادم: المصادر وأنواع القيود والتسوية والتفسير ومصادر الردّ وأسباب الرفض', () => {
  const types = readIf(path.join(backend, 'services', 'gl', 'types.ts'));
  if (types) {
    assert.deepEqual(Object.keys(sourceTypeLabels(id)).sort(), constList(types, 'SOURCE_TYPES').sort());
    assert.deepEqual(Object.keys(moveTypeLabels(id)).sort(), constList(types, 'MOVE_TYPES').sort());
    assert.ok(constList(types, 'MOVE_TYPES').includes('CUSTOMER_REFUND'));
    assert.deepEqual(constList(types, 'PAYMENT_METHOD_MAP_KEYS'), ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'CARD', 'PAYOUT']);
  }
  const ops = readIf(path.join(web, 'api', 'ledgerOps.ts'))!;
  const clearing = readIf(path.join(backend, 'services', 'gl', 'builders', 'clearing.ts'));
  if (clearing) {
    assert.deepEqual(constList(ops, 'CLEARING_KINDS'), constList(clearing, 'CLEARING_KINDS'));
    assert.deepEqual(Object.keys(clearingKindLabels(id)), constList(clearing, 'CLEARING_KINDS'));
    const route = readIf(path.join(backend, 'routes', 'ledger', 'clearing.ts'));
    const reasons = [...constList(clearing, 'ClearingProblemReason'), ...(route ? constList(route, 'ClearingRouteReason') : [])];
    assert.ok(reasons.includes('EXCEEDS_OPEN') || !route, 'مسح أسباب مسار التسوية');
    const labels = clearingReasonLabels(id);
    assert.deepEqual(reasons.filter(r => !labels[r]), [], 'سبب تسوية بلا تسمية');
  }
  const custody = readIf(path.join(backend, 'services', 'gl', 'custody.ts'));
  if (custody) assert.deepEqual(Object.keys(custodyExplainKindLabels(id)).sort(), constList(custody, 'CustodyExplainKind').sort());
  const cancel = readIf(path.join(backend, 'services', 'receiptCancelSource.ts'));
  if (cancel) {
    assert.deepEqual(Object.keys(cancelRefundSourceLabels(id)), constList(cancel, 'CANCEL_REFUND_SOURCES'));
    assert.deepEqual(constList(ops, 'CANCEL_REFUND_SOURCES'), constList(cancel, 'CANCEL_REFUND_SOURCES'));
    for (const code of [...cancel.matchAll(/export const (RECEIPT_CANCEL_\w+) = '(\w+)'/g)].map(m => m[2])) assert.ok(receiptCancelCodeLabels(id)[code], code);
  }
  const adjBuilder = readIf(path.join(backend, 'services', 'gl', 'builders', 'customerAdjustment.ts'));
  if (adjBuilder) {
    for (const name of ['CUSTOMER_ADJUSTMENT_KINDS', 'WRITEOFF_COUNTERS', 'REFUND_METHODS', 'CUSTOMER_ADJUSTMENT_STATUSES']) {
      assert.deepEqual(constList(ops, name), constList(adjBuilder, name), name);
    }
    assert.deepEqual(Object.keys(customerAdjustmentKindLabels(id)), constList(adjBuilder, 'CUSTOMER_ADJUSTMENT_KINDS'));
    assert.deepEqual(Object.keys(writeoffCounterLabels(id)), constList(adjBuilder, 'WRITEOFF_COUNTERS'));
  }
  const adjRoute = readIf(path.join(backend, 'routes', 'ledger', 'customerAdjustments.ts'));
  if (adjRoute) {
    const labels = customerAdjustmentReasonLabels(id);
    const reasons = ['AdjustmentInvalidReason', 'AllocationInvalidReason', 'ExceedsBalanceReason'].flatMap(n => constList(adjRoute, n));
    assert.deepEqual(reasons.filter(r => !labels[r]), [], 'سبب تسوية ذمة بلا تسمية');
  }
  const pmRoute = readIf(path.join(backend, 'routes', 'ledger', 'paymentMethodMap.ts'));
  if (pmRoute) {
    const labels = paymentMethodMapReasonLabels(id);
    assert.deepEqual(constList(pmRoute, 'MethodAccountProblem').filter(r => !labels[r]), []);
  }
  assert.equal(sourceDocumentHref('USER_SETTLEMENT'), '/app/company-users');
  assert.equal(sourceDocumentHref('PAYLINK_REFUND'), '/app/paylink');
  assert.equal(sourceTypeLabels(id).USER_SETTLEMENT, 'توريد عهدة مستخدم');
  assert.equal(sourceTypeLabels(id).PAYLINK_REFUND, 'استرداد دفع إلكتروني');
  assert.equal(moveTypeLabels(id).CUSTOMER_REFUND, 'ردّ مبلغ لعميل');
});

test('الصفحات الجديدة: تصدير افتراضي بمساراتها في جدول العقد، ونصوصها عبر tr حرفياً بلا رسالة خادم', () => {
  for (const f of ['config/PaymentMethodMapPage', 'customers/CustomerAdjustmentsPage', 'customers/ClearingPage', 'customers/UserCustodyPage']) {
    const s = readIf(path.join(web, 'pages', 'ledger', `${f}.tsx`));
    assert.ok(s, f);
    assert.match(s!, /export default function \w+Page\(/, f);
    assert.ok(!/\.message\b/.test(s!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${f} يعرض message من الخادم`);
    assert.ok(!/tr\(\s*[a-zA-Z_`]/.test(s!), `${f} ينادي tr بمتغير`);
  }
});
