// «المحاسب الذكي AI» — بطاقة المستند: منطقها الصرف (docCardLogic.ts — لا docCard.ts: نظام ملفات ويندوز لا يفرّق حالة الحرف فيُحلّ ‎./DocCard‎ إليه) وتكامله مع نصّ التأكيد وجسم المحادثة (lib/aiAccountantDocs.ts
// و lib/aiAccountant.ts): متى يُتاح «سجّل القيد» ومتى يمنعه الأحمر، قواعد المعالجة (المقدّم 1..24 والأصل بحدّ الرسملة)،
// الشركة «بلا ضريبة»، جسم PATCH بالمتغيّر وحده، وأين تُرسم البطاقة ورفضها في المحادثة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_CLASS_ORDER, DOC_CATEGORY_CHIPS, accountsFor, activeRefusals, assetClassLabel, assetClassPatch, blockerText, cardOwners,
  categoryChipLabel, categoryChipOf, categoryChipPatch, chipSelected, choiceFromConfirm, choiceIsSuggestion, chosenVatMode,
  confirmBlocker, confirmChoiceOf, confirmingDocId, defaultChoice, docIdInUse, docReferral, docState, docStateLabel, docTypeChips,
  docTypeLabelFor, duplicateText, factsSourceLabel, formOf, lastConfirms, latestDocView, monthsInputShown, monthsPatch, patchOf,
  payOptionLabel, payOptionOf,
  payValue, pendingBusy, periodMonths, readyDocIds, reconcileChoice, refusalsByDoc, slotsLeft, sumMismatch, thresholdOf,
  treatmentLabel, treatmentReasonText, treatmentStates, vatModeText, vendorVatOdd, viewKindOf, visibleChecks, visiblePayOptions,
  withRefusalDuplicate, withTreatment, type DocChoice, type PendingDoc,
} from './docCardLogic';
import { docConfirmMessage, type AcctDocCheck, type AcctDocFacts, type AcctDocView } from '../../../lib/aiAccountantDocs';
import { buildChatBody, newClientRef, type ChatEntry } from '../../../lib/aiAccountant';

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const OPTS = { assetThreshold: 2000, decimals: 2, taxOff: false };

const facts = (over: Partial<AcctDocFacts> = {}): AcctDocFacts => ({
  docType: 'MAINTENANCE_INVOICE', vendorName: 'مؤسسة الإتقان', vendorVat: '300000000000003', buyerName: null, buyerVat: null,
  invoiceNo: '2231', issueDate: '2026-11-10', periodFrom: null, periodTo: null, currency: 'SAR',
  subtotal: '1000.00', vatAmount: '150.00', total: '1150.00', vatRatePct: 15, lines: [], lease: null, months: null,
  paymentHint: 'UNKNOWN', categoryHint: 'maintenance', assetClassHint: null,
  ...over,
});

const view = (over: Partial<AcctDocView> = {}): AcctDocView => ({
  id: DOC_ID, ref: 'D1', fileName: 'فاتورة.jpg', mimeType: 'image/jpeg', sizeBytes: 120_000, createdAt: '2026-11-18T10:00:00Z',
  status: 'EXTRACTED', manualEntry: false, factsSource: 'QR', facts: facts(), checks: [], qrVerified: true,
  suggestion: { treatment: 'EXPENSE', accountCode: '621010', accountName: 'الصيانة والإصلاحات', vatMode: 'DEDUCTIBLE', months: null, paidFrom: null },
  accountOptions: [
    { code: '621010', name: 'الصيانة والإصلاحات', treatment: 'EXPENSE' },
    { code: '621004', name: 'الإيجار', treatment: 'EXPENSE' },
    { code: '621004', name: 'الإيجار', treatment: 'PREPAID' },
    { code: '121005', name: 'الأثاث والتجهيزات', treatment: 'ASSET' },
  ],
  payOptions: [
    { paidFrom: 'cash', code: '111001', name: 'الصندوق الرئيسي' },
    { paidFrom: 'bank', code: '111101', name: 'البنك الرئيسي' },
    { paidFrom: 'payable', code: '213002', name: 'مصروفات مستحقة' },
  ],
  posted: null, duplicateOf: null,
  ...over,
});

const ready = (v: AcctDocView, over: Partial<DocChoice> = {}): DocChoice => ({ ...defaultChoice(v, OPTS), pay: 'bank:111101', ...over });

// ─── «سجّل القيد»: متاح أو ممنوع ───

test('«سجّل القيد» متاح بحقائق كاملة ومعالجةٍ وحسابٍ و«مدفوع من» — و«مدفوع من» إلزامي لا يُقترح', () => {
  const v = view();
  const d = defaultChoice(v, OPTS);
  assert.equal(d.pay, '', '«مدفوع من» فارغٌ حتى يختاره المستخدم (D1)');
  assert.equal(d.treatment, 'EXPENSE');
  assert.equal(d.accountCode, '621010', 'الحساب المقترح من الخادم');
  assert.equal(confirmBlocker(v, d, OPTS), 'PAID_FROM');
  assert.equal(confirmBlocker(v, ready(v), OPTS), null);
  // اقتراح الخادم «مدفوع» لا يملأ الخانة
  assert.equal(defaultChoice(view({ suggestion: { ...v.suggestion!, paidFrom: 'bank' } }), OPTS).pay, '');
});

test('الفحص الأحمر (block) يعطّل الزرّ والكهرماني (warn) لا يعطّله', () => {
  const warn = view({ status: 'NEEDS_REVIEW', checks: [{ code: 'VAT_RATE_ODD', severity: 'warn' }] });
  assert.equal(confirmBlocker(warn, ready(warn), OPTS), null, 'التنبيه يُسمح بالترحيل معه');
  const block = view({ status: 'NEEDS_REVIEW', checks: [{ code: 'SUM_MISMATCH', severity: 'block' }, { code: 'VAT_RATE_ODD', severity: 'warn' }] });
  assert.equal(confirmBlocker(block, ready(block), OPTS), 'CHECKS');
  assert.equal(docState(block), 'review');
});

test('بلا إجمالي أو تاريخ أو أثناء التعديل أو المرحَّل الحيّ أو الملف المفقود ⇒ ممنوع، والمعكوس يُسجَّل من جديد', () => {
  const noTotal = view({ status: 'NEEDS_REVIEW', manualEntry: true, factsSource: null, facts: facts({ total: null, subtotal: null, vatAmount: null }) });
  assert.equal(confirmBlocker(noTotal, ready(noTotal), OPTS), 'TOTAL');
  assert.equal(docState(noTotal), 'waiting');
  const noFacts = view({ status: 'NEEDS_REVIEW', manualEntry: true, factsSource: null, facts: null });
  assert.equal(confirmBlocker(noFacts, ready(noFacts), OPTS), 'TOTAL');
  const noDate = view({ facts: facts({ issueDate: null }) });
  assert.equal(confirmBlocker(noDate, ready(noDate), OPTS), 'DATE');
  assert.equal(confirmBlocker(view(), ready(view()), { ...OPTS, editing: true }), 'EDITING', 'تعديلٌ لم يُحفظ');
  const live = view({ posted: { moveId: 'm1', moveNumber: 'JV/7', live: true, kind: 'EXPENSE' } });
  assert.equal(confirmBlocker(live, ready(live), OPTS), 'POSTED');
  assert.equal(docState(live), 'posted');
  const reversed = view({ posted: { moveId: 'm1', moveNumber: 'JV/7', live: false, kind: 'EXPENSE' } });
  assert.equal(docState(reversed), 'reversed');
  assert.equal(confirmBlocker(reversed, ready(reversed), OPTS), null, 'المعكوس يُعاد ترحيله');
  const gone = view({ status: 'FAILED', checks: [{ code: 'FILE_GONE', severity: 'block' }] });
  assert.equal(confirmBlocker(gone, ready(gone), OPTS), 'GONE');
});

// ─── المعالجة: المقدّم والأصل ───

test('الأصل بحدّ الرسملة وحده (قبل الضريبة)، ودونه مصروف — والحدّ الغائب ٢٠٠٠', () => {
  const small = view(); // 1000 قبل الضريبة
  const st = treatmentStates(small, OPTS);
  assert.deepEqual(st.map(s => [s.treatment, s.allowed, s.reason]), [['EXPENSE', true, null], ['PREPAID', true, null], ['ASSET', false, 'BELOW_THRESHOLD']]);
  assert.equal(confirmBlocker(small, withTreatment(small, ready(small), 'ASSET'), OPTS), 'TREATMENT');
  // الحدّ بالضبط يُرسمَل، والإجمالي وحده (شامل الضريبة) لا يرفع ما دونه
  const atLine = view({ facts: facts({ subtotal: '2000.00', vatAmount: '300.00', total: '2300.00' }) });
  assert.equal(treatmentStates(atLine, OPTS)[2].allowed, true);
  const vatLifts = view({ facts: facts({ subtotal: '1900.00', vatAmount: '285.00', total: '2185.00' }) });
  assert.equal(treatmentStates(vatLifts, OPTS)[2].allowed, false, 'الوعاء قبل الضريبة لا الإجمالي');
  // بلا مبلغٍ قبل الضريبة: الإجمالي ناقص الضريبة
  const noSub = view({ facts: facts({ subtotal: null, vatAmount: '300.00', total: '2300.00' }) });
  assert.equal(treatmentStates(noSub, OPTS)[2].allowed, true);
  assert.equal(thresholdOf(undefined), 2000);
  assert.equal(thresholdOf(-5), 2000);
  assert.equal(thresholdOf(5000), 5000);
  assert.equal(treatmentStates(atLine, { ...OPTS, assetThreshold: 5000 })[2].allowed, false, 'حدّ الشركة من الحالة');
  assert.equal(treatmentReasonText('BELOW_THRESHOLD', '2,000.00', (s) => s), 'يسجل أصلاً ما بلغ 2,000.00 فأكثر — وما دونه مصروف');
  // اقتراح «أصل» لما دون الحدّ يرتدّ إلى المصروف
  const sugAsset = view({ suggestion: { treatment: 'ASSET', accountCode: '121005', accountName: 'الأثاث', vatMode: 'DEDUCTIBLE', months: null, paidFrom: null } });
  assert.equal(defaultChoice(sugAsset, OPTS).treatment, 'EXPENSE');
  const bigAsset = view({ facts: facts({ subtotal: '5000.00', vatAmount: '750.00', total: '5750.00' }), suggestion: sugAsset.suggestion });
  const c = defaultChoice(bigAsset, OPTS);
  assert.deepEqual([c.treatment, c.accountCode], ['ASSET', '121005']);
  assert.equal(confirmBlocker(bigAsset, { ...c, pay: 'cash:111001' }, OPTS), null);
});

test('معالجةٌ بلا حسابٍ في دليل الشركة معطّلة، والحساب من خياراتها وحدها', () => {
  const v = view({ accountOptions: [{ code: '621010', name: 'الصيانة', treatment: 'EXPENSE' }] });
  const st = treatmentStates(v, OPTS);
  assert.deepEqual(st.map(s => s.allowed), [true, false, false]);
  assert.equal(st[1].reason, 'NO_ACCOUNT');
  assert.equal(accountsFor(view(), 'PREPAID').map(a => a.code).join(), '621004');
  assert.equal(confirmBlocker(view(), ready(view(), { accountCode: '999999' }), OPTS), 'ACCOUNT', 'رمزٌ ليس من الخيارات');
  assert.equal(confirmBlocker(view(), ready(view(), { accountCode: '' }), OPTS), 'ACCOUNT');
});

test('المقدّم: الأشهر 1..24، والأطول يُحال للمحاسب البشري، والافتراض من الحقائق ثم الاقتراح ثم الفترة', () => {
  const v = view({ facts: facts({ docType: 'LEASE_CONTRACT', periodFrom: '2026-01-01', periodTo: '2026-12-31' }) });
  const pre = withTreatment(v, ready(v), 'PREPAID');
  assert.equal(pre.accountCode, '621004', 'الحساب يتبع المعالجة');
  assert.equal(pre.months, 12, 'من فترة الخدمة');
  assert.equal(confirmBlocker(v, pre, OPTS), null);
  assert.equal(confirmBlocker(v, { ...pre, months: null }, OPTS), 'MONTHS');
  assert.equal(confirmBlocker(v, { ...pre, months: 0 }, OPTS), 'MONTHS');
  assert.equal(confirmBlocker(v, { ...pre, months: 2.5 }, OPTS), 'MONTHS');
  assert.equal(confirmBlocker(v, { ...pre, months: 24 }, OPTS), null);
  assert.equal(confirmBlocker(v, { ...pre, months: 1 }, OPTS), null);
  assert.equal(confirmBlocker(v, { ...pre, months: 36 }, OPTS), 'REFERRED', 'أكثر من ٢٤ شهراً ⇒ المحاسب البشري (D2)');
  assert.equal(defaultChoice(view({ facts: facts({ months: 6 }) }), OPTS).months, 6, 'الحقائق أولاً');
  assert.equal(periodMonths('2026-01-15', '2026-02-14'), 1);
  assert.equal(periodMonths('2026-01-15', '2027-01-14'), 12);
  assert.equal(periodMonths('2026-01-15', '2026-02-15'), 2);
  assert.equal(periodMonths('2026-03-01', '2026-01-01'), null);
  assert.equal(periodMonths(null, '2026-01-01'), null);
});

test('مواءمة الاختيار مع عرضٍ جديد: ما بقي صالحاً يبقى، وما خرج من الخيارات يرتدّ', () => {
  const v = view();
  const c = ready(v, { treatment: 'EXPENSE', accountCode: '621004' });
  assert.deepEqual(reconcileChoice(v, c, OPTS), c, 'عرضٌ لم يتغيّر لا يمسّ الاختيار');
  const fewer = view({ payOptions: [{ paidFrom: 'cash', code: '111001', name: 'الصندوق' }] });
  assert.equal(reconcileChoice(fewer, c, OPTS).pay, '', '«مدفوع من» خرج من الخيارات ⇒ فارغ');
  const noRent = view({ accountOptions: v.accountOptions.filter(o => !(o.code === '621004' && o.treatment === 'EXPENSE')) });
  assert.equal(reconcileChoice(noRent, c, OPTS).accountCode, '621010', 'الحساب خرج ⇒ المقترح');
  const asset = ready(view({ facts: facts({ subtotal: '5000.00', vatAmount: '750.00', total: '5750.00' }) }), { treatment: 'ASSET', accountCode: '121005', months: 3 });
  const r = reconcileChoice(v, asset, OPTS);
  assert.equal(r.treatment, 'EXPENSE', 'صار دون الحدّ بعد التصحيح ⇒ المصروف');
  assert.equal(r.pay, 'bank:111101');
  assert.equal(r.months, 3);
});

// ─── التكامل مع نصّ التأكيد وجسم المحادثة ───

test('«سجّل القيد» ⇒ نصٌّ مرئي بالإجمالي والضريبة والحساب وحساب الدفع حرفياً، وdocConfirm بلا مبالغ، وجسمٌ يحملهما', () => {
  const v = view();
  const cc = confirmChoiceOf(v, ready(v))!;
  const msg = docConfirmMessage(v, cc, (s) => s, { decimals: 2 })!;
  assert.ok(msg, 'التأكيد صالح');
  assert.match(msg.text, /^سجّل/, 'نيّة التسجيل من نصّ المستخدم نفسه');
  for (const lit of ['1,150.00', '150.00', '621010', '111101']) assert.ok(msg.text.includes(lit), `${lit} في النصّ: ${msg.text}`);
  assert.deepEqual(msg.docIds, [DOC_ID]);
  assert.equal(msg.docConfirm.docId, DOC_ID);
  assert.equal(msg.docConfirm.treatment, 'EXPENSE');
  assert.equal(msg.docConfirm.accountCode, '621010');
  assert.equal(msg.docConfirm.paidFrom, 'bank');
  assert.ok(!('total' in msg.docConfirm) && !('amount' in msg.docConfirm), 'لا مبلغ في docConfirm — الخادم يقرأ الحقائق');

  // الرسالة كما يبنيها send في المحادثة ⇒ الجسم يحمل docIds على الرسالة وdocConfirm في أعلاه
  const user: ChatEntry = { id: 'u1', role: 'user', text: msg.text, clientRef: newClientRef(), docIds: msg.docIds, docConfirm: msg.docConfirm };
  const prior: ChatEntry[] = [
    { id: 'u0', role: 'user', text: 'اقرأ المستند المرفق ولخّص بياناته', clientRef: newClientRef(), docIds: [DOC_ID] },
    { id: 'a0', role: 'assistant', text: 'فاتورة صيانة', documents: [v] },
  ];
  const body = buildChatBody([...prior, user], user.clientRef!, user.id)!;
  assert.deepEqual(Object.keys(body).sort(), ['clientRef', 'docConfirm', 'messages']);
  assert.deepEqual(body.docConfirm, msg.docConfirm);
  assert.deepEqual(body.messages.map(m => m.docIds ?? null), [[DOC_ID], null, [DOC_ID]]);
  // ومحادثةٌ نصّية بلا مستند تبقى {clientRef, messages:[{role,text}]} حرفاً بحرف
  const plain = buildChatBody([{ id: 'p', role: 'user', text: 'كم بعنا؟', clientRef: newClientRef() }], newClientRef())!;
  assert.deepEqual(Object.keys(plain).sort(), ['clientRef', 'messages']);
  assert.deepEqual(Object.keys(plain.messages[0]).sort(), ['role', 'text']);
});

test('آجل ⇒ 213002 في النصّ، والمقدّم بأشهره، وبنكٌ بعينه برمزه', () => {
  const v = view();
  const payable = docConfirmMessage(v, confirmChoiceOf(v, ready(v, { pay: 'payable:213002' }))!, undefined, { decimals: 2 })!;
  assert.ok(payable.text.includes('213002'), payable.text);
  assert.equal(payable.docConfirm.paidFrom, 'payable');
  assert.equal(payable.docConfirm.paidFromAccountCode, undefined, 'الآجل بلا رمز حساب دفع');
  const lease = view({ facts: facts({ docType: 'LEASE_CONTRACT', periodFrom: '2026-01-01', periodTo: '2026-12-31' }) });
  const pre = withTreatment(lease, ready(lease), 'PREPAID');
  const m = docConfirmMessage(lease, confirmChoiceOf(lease, pre)!, undefined, { decimals: 2 })!;
  assert.equal(m.docConfirm.treatment, 'PREPAID');
  assert.equal(m.docConfirm.months, 12);
  assert.ok(m.text.includes('12'), m.text);
  assert.ok(m.text.includes('115002'), 'المدفوع مقدماً للإيجار في النصّ');
  // الأشهر لا تُرسَل لغير المقدّم
  assert.equal(confirmChoiceOf(v, ready(v, { months: 5 }))!.months, null);
  assert.equal(confirmChoiceOf(v, ready(v, { pay: '' })), null, 'بلا «مدفوع من» لا تأكيد');
  // بنكان ⇒ الرمز يفرّق بينهما
  const twoBanks = view({ payOptions: [...v.payOptions, { paidFrom: 'bank', code: '111102', name: 'بنك الراجحي' }] });
  const b2 = docConfirmMessage(twoBanks, confirmChoiceOf(twoBanks, ready(twoBanks, { pay: 'bank:111102' }))!, undefined, { decimals: 2 })!;
  assert.equal(b2.docConfirm.paidFromAccountCode, '111102');
  assert.ok(b2.text.includes('111102'));
});

test('الشركة «بلا ضريبة»: النصّ بلا ضريبة، والشرائح بلا «ضريبية»، ولا رمز QR ولا منبّهات الضريبة', () => {
  const v = view();
  const m = docConfirmMessage(v, confirmChoiceOf(v, ready(v))!, undefined, { taxOff: true, decimals: 2 })!;
  assert.doesNotMatch(m.text, /ضريبة/, m.text);
  // فاتورة QR (الخادم يسمّيها ضريبية) في الشركة «بلا ضريبة»: فقاعة «سجّل القيد» تقول «فاتورة» كالبطاقة
  const qrInv = view({ facts: facts({ docType: 'TAX_INVOICE' }) });
  const mq = docConfirmMessage(qrInv, confirmChoiceOf(qrInv, ready(qrInv))!, (x) => x, { taxOff: true, decimals: 2 })!;
  assert.doesNotMatch(mq.text, /ضريب/, mq.text);
  assert.match(mq.text, /^سجّل المستند: فاتورة بتاريخ /);
  assert.ok(m.text.includes('1,150.00'));
  assert.deepEqual(docTypeChips(true).includes('TAX_INVOICE'), false);
  assert.equal(docTypeChips(false).length, 7);
  assert.equal(docTypeLabelFor('TAX_INVOICE', true), 'فاتورة');
  assert.equal(docTypeLabelFor('SIMPLIFIED_INVOICE', true), 'فاتورة');
  assert.equal(docTypeLabelFor('MAINTENANCE_INVOICE', true), docTypeLabelFor('MAINTENANCE_INVOICE', false));
  assert.ok(chipSelected('SIMPLIFIED_INVOICE', 'TAX_INVOICE', true), 'شريحة «فاتورة» تضيء للضريبية المحفوظة');
  assert.ok(!chipSelected('SIMPLIFIED_INVOICE', 'TAX_INVOICE', false));
  assert.equal(factsSourceLabel('QR', true), null, 'رمز الهيئة لا يُذكر');
  assert.equal(factsSourceLabel('QR+USER', true), null);
  assert.equal(factsSourceLabel('USER', true), 'إدخال يدوي');
  assert.equal(factsSourceLabel('QR', false), 'من رمز QR');
  assert.equal(vatModeText('DEDUCTIBLE', true), null);
  assert.ok(vatModeText('NON_DEDUCTIBLE', false));
  const checks = visibleChecks([
    { code: 'VAT_RATE_ODD', severity: 'warn' }, { code: 'QR_INVALID', severity: 'warn' }, { code: 'DATE_FUTURE', severity: 'block' },
    { code: 'QR_MISMATCH', severity: 'block' },
  ], true);
  assert.deepEqual(checks.map(c => c.code), ['DATE_FUTURE', 'QR_MISMATCH'], 'المانع يبقى ظاهراً، والمنبّه الضريبي يُخفى');
  // الوعاء في الشركة «بلا ضريبة» إجماليها
  const gross = view({ facts: facts({ subtotal: '1800.00', vatAmount: '270.00', total: '2070.00' }) });
  assert.equal(treatmentStates(gross, { ...OPTS, taxOff: true })[2].allowed, true);
  assert.equal(treatmentStates(gross, OPTS)[2].allowed, false);
  // جسم PATCH لا يحمل خانات الضريبة ولا الرقم الضريبي
  const r = patchOf({ ...formOf(gross), vendorVat: '123', subtotal: '1', vatAmount: '2', total: '2100' }, gross, { decimals: 2, taxOff: true });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.patch, { total: '2100.00' });
});

test('التكرار: رقم الفاتورة يُتجاوز بـ«ليست مكررة»، والملف نفسه لا يُتجاوز، ورفض الخادم يَسِم البطاقة', () => {
  const dup = view({ duplicateOf: { moveNumber: 'JV/3', reason: 'INVOICE_NO' } });
  assert.equal(confirmBlocker(dup, ready(dup), OPTS), 'DUPLICATE');
  assert.equal(confirmBlocker(dup, ready(dup), { ...OPTS, notDuplicate: true }), null);
  const m = docConfirmMessage(dup, confirmChoiceOf(dup, ready(dup), true)!, undefined, { decimals: 2 })!;
  assert.ok(m.text.includes('ليست مكررة'), m.text);
  assert.equal(m.docConfirm.confirmedNotDuplicate, true);
  assert.equal(duplicateText(dup.duplicateOf), 'رقم الفاتورة نفسه مسجل في القيد JV/3');
  const sha = view({ duplicateOf: { moveNumber: 'JV/3', reason: 'SHA' } });
  assert.equal(confirmBlocker(sha, ready(sha), { ...OPTS, notDuplicate: true }), 'ALREADY_POSTED');
  // الخادم رفض DOC_POSSIBLE_DUPLICATE والعرض بلا duplicateOf ⇒ يُوسَم فيُتاح التجاوز ويحمله النصّ
  const plain = view();
  const refused = withRefusalDuplicate(plain, { code: 'DOC_POSSIBLE_DUPLICATE', message: '', details: { moveNumber: 'JV/9' } });
  assert.deepEqual(refused.duplicateOf, { moveNumber: 'JV/9', reason: 'SOFT' });
  assert.equal(confirmBlocker(refused, ready(refused), OPTS), 'DUPLICATE');
  const ok = docConfirmMessage(refused, confirmChoiceOf(refused, ready(refused), true)!, undefined, { decimals: 2 })!;
  assert.ok(ok.text.includes('ليست مكررة'));
  assert.equal(withRefusalDuplicate(plain, { code: 'DOC_NEEDS_REVIEW', message: '' }), plain, 'رفضٌ آخر لا يمسّ العرض');
  assert.equal(withRefusalDuplicate(plain, null), plain);
});

test('الأصل دون حدّ الرسملة: السبب «دون الحدّ» ولو لم يرسل الخادم حسابات الأصول (لا «لا حساب في دليلك»)', () => {
  // الخادم لا يرسل خيارات الأصول لما دون الحدّ (accountOptionsFor) — فالسبب الصادق هو الحدّ
  const noAssets = view({ accountOptions: view().accountOptions.filter(o => o.treatment !== 'ASSET') }); // صافي 1000
  assert.deepEqual(treatmentStates(noAssets, OPTS)[2], { treatment: 'ASSET', allowed: false, reason: 'BELOW_THRESHOLD' });
  assert.equal(treatmentReasonText(treatmentStates(noAssets, OPTS)[2].reason, '2,000.00'), 'يسجل أصلاً ما بلغ 2,000.00 فأكثر — وما دونه مصروف');
  const big = view({ accountOptions: noAssets.accountOptions, facts: facts({ subtotal: '5000.00', vatAmount: '750.00', total: '5750.00' }) });
  assert.equal(treatmentStates(big, OPTS)[2].reason, 'NO_ACCOUNT', 'فوق الحدّ بلا حساب أصلٍ في الدليل ⇒ لا حساب');
  assert.equal(treatmentStates(noAssets, OPTS)[1].reason, null, 'المقدّم لا يمسّه الحدّ');
});

test('ملاحظات الضريبة والإهلاك تتبع اختيار المستخدم لا الاقتراح وحده', () => {
  const checks: AcctDocCheck[] = [
    { code: 'NEEDS_DEPRECIATION', severity: 'warn' }, { code: 'VAT_BLOCKED_CATEGORY', severity: 'warn' }, { code: 'VAT_RATE_ODD', severity: 'warn' },
  ];
  assert.deepEqual(visibleChecks(checks, false).map(c => c.code), ['VAT_BLOCKED_CATEGORY', 'VAT_RATE_ODD'], '«يحتاج إهلاكاً» تحت «أصل» لا فحصاً مكرّراً');
  assert.deepEqual(visibleChecks(checks, false, { suggestionChosen: false }).map(c => c.code), ['VAT_RATE_ODD'], 'عدل عن الضيافة ⇒ لا «لا تُخصم»');
  assert.deepEqual(visibleChecks(checks, false, { suggestionChosen: true }).map(c => c.code), ['VAT_BLOCKED_CATEGORY', 'VAT_RATE_ODD']);
  const v = view(); // الاقتراح: مصروف 621010 تُخصم ضريبته
  assert.ok(choiceIsSuggestion(v, { treatment: 'EXPENSE', accountCode: '621010' }));
  assert.ok(!choiceIsSuggestion(view({ suggestion: null }), { treatment: 'EXPENSE', accountCode: '621010' }));
  assert.equal(chosenVatMode(v, { treatment: 'EXPENSE', accountCode: '621010' }), 'DEDUCTIBLE');
  assert.equal(chosenVatMode(v, { treatment: 'EXPENSE', accountCode: '621004' }), null, 'حسابٌ آخر بلا حكمٍ من الخادم ⇒ لا ملاحظة «تخصم»');
  assert.equal(vatModeText(chosenVatMode(v, { treatment: 'EXPENSE', accountCode: '621004' }), false), null);
  // الخادم يرسل حكم الحساب نفسه (الضيافة لا تُخصم) ⇒ يُعرض ولو لم يكن الاقتراح
  const vm = view({ accountOptions: [...v.accountOptions, { code: '621012', name: 'الضيافة', treatment: 'EXPENSE', vatMode: 'NON_DEDUCTIBLE' }] });
  assert.equal(chosenVatMode(vm, { treatment: 'EXPENSE', accountCode: '621012' }), 'NON_DEDUCTIBLE');
  assert.equal(vatModeText('NON_DEDUCTIBLE', false), 'الضريبة لا تخصم — تضاف إلى التكلفة');
});

test('عقد الإيجار: لا «آجل» في «مدفوع من» — العقد ليس فاتورة مستحقة (NOT_A_PAYMENT)', () => {
  const lease = view({ facts: facts({ docType: 'LEASE_CONTRACT', periodFrom: '2026-01-01', periodTo: '2026-12-31' }) });
  assert.deepEqual(visiblePayOptions(lease).map(o => o.paidFrom), ['cash', 'bank']);
  assert.deepEqual(visiblePayOptions(view()).map(o => o.paidFrom), ['cash', 'bank', 'payable'], 'الفاتورة غير المدفوعة ⇒ آجل (D6)');
  assert.equal(payOptionOf(lease, 'payable:213002'), null);
  const pre = withTreatment(lease, ready(lease, { pay: 'payable:213002' }), 'PREPAID');
  assert.equal(confirmBlocker(lease, pre, OPTS), 'PAID_FROM', 'لا خيار «آجل» ⇒ اختر صندوقاً أو بنكاً');
  assert.equal(reconcileChoice(lease, pre, OPTS).pay, '', 'اختيارٌ «آجل» قبل تغيير النوع إلى عقد يُفرَّغ');
  const back = choiceFromConfirm(lease, { docId: DOC_ID, treatment: 'PREPAID', accountCode: '621004', paidFrom: 'payable', paidFromAccountCode: null, months: 12 }, OPTS);
  assert.equal(back.pay, '');
  assert.equal(confirmBlocker(lease, { ...pre, pay: 'bank:111101' }, OPTS), null);
  assert.equal(blockerText('NOT_A_PAYMENT'), 'العقد وحده ليس دفعة — أدخل المبلغ المدفوع واختر من أي حساب دُفع');
});

test('تصنيف المستند (D3): الشرائح تُرسل categoryHint/assetClassHint، والبضاعة والأرض لا تُرحَّل من هنا', () => {
  const f0 = facts({ categoryHint: null });
  assert.equal(categoryChipOf(f0), 'EXPENSE');
  assert.equal(categoryChipOf(facts({ categoryHint: 'maintenance' })), 'EXPENSE', 'تصنيف مصروفٍ ⇒ «مصروف أو خدمة»');
  assert.equal(categoryChipOf(facts({ categoryHint: 'prepaid' })), 'EXPENSE');
  assert.equal(categoryChipOf(facts({ categoryHint: 'fixed_asset' })), 'FIXED_ASSET');
  assert.equal(categoryChipOf(facts({ categoryHint: null, assetClassHint: 'computers' })), 'FIXED_ASSET');
  assert.equal(categoryChipOf(facts({ categoryHint: 'inventory_goods' })), 'INVENTORY');
  assert.equal(categoryChipOf(null), 'EXPENSE');
  assert.deepEqual(categoryChipPatch('INVENTORY', f0), { categoryHint: 'inventory_goods', assetClassHint: null });
  assert.deepEqual(categoryChipPatch('FIXED_ASSET', f0), { categoryHint: 'fixed_asset' });
  assert.deepEqual(categoryChipPatch('EXPENSE', facts({ categoryHint: 'fixed_asset', assetClassHint: 'tools' })), { categoryHint: null, assetClassHint: null });
  assert.equal(categoryChipPatch('EXPENSE', f0), null, 'المضيئة لا طلب');
  assert.equal(categoryChipPatch('EXPENSE', facts({ categoryHint: 'maintenance' })), null, 'تصنيف المصروف القائم لا يُمحى بلا سبب');
  assert.deepEqual(assetClassPatch('land_buildings', f0), { categoryHint: 'fixed_asset', assetClassHint: 'land_buildings' });
  assert.equal(assetClassPatch('tools', facts({ assetClassHint: 'tools' })), null);
  assert.deepEqual([...DOC_CATEGORY_CHIPS], ['EXPENSE', 'FIXED_ASSET', 'INVENTORY']);
  assert.equal(ASSET_CLASS_ORDER.length, 8);
  assert.equal(ASSET_CLASS_ORDER[ASSET_CLASS_ORDER.length - 1], 'land_buildings');
  assert.equal(new Set(ASSET_CLASS_ORDER.map(a => assetClassLabel(a))).size, 8);
  assert.equal(assetClassLabel('land_buildings'), 'أراضٍ ومبانٍ');
  assert.deepEqual(DOC_CATEGORY_CHIPS.map(c => categoryChipLabel(c)), ['مصروف أو خدمة', 'أصل ثابت', 'بضاعة للبيع']);
  // البضاعة ⇒ مشتريات المستودع، والأرض والمبنى ⇒ المحاسب البشري: «سجّل القيد» ممنوعٌ بسببهما قبل «مدفوع من» وغيره
  const inv = view({ status: 'NEEDS_REVIEW', suggestion: null, facts: facts({ categoryHint: 'inventory_goods' }) });
  assert.equal(docReferral(inv.facts), 'INVENTORY');
  assert.equal(confirmBlocker(inv, ready(inv), OPTS), 'INVENTORY');
  assert.equal(confirmBlocker(inv, { ...ready(inv), pay: '' }, OPTS), 'INVENTORY');
  assert.equal(blockerText('INVENTORY'), 'هذه بضاعة للمخزون — سجّلها من مشتريات المستودع');
  const land = view({ status: 'NEEDS_REVIEW', suggestion: null, facts: facts({ categoryHint: 'fixed_asset', assetClassHint: 'land_buildings', subtotal: '500000.00', vatAmount: '0', total: '500000.00' }) });
  assert.equal(confirmBlocker(land, ready(land), OPTS), 'REFERRED');
  assert.equal(docReferral(facts({ categoryHint: 'fixed_asset', assetClassHint: 'computers' })), null);
  assert.equal(confirmBlocker(view(), ready(view()), OPTS), null, 'مصروفٌ عادي لا يمسّه');
});

test('أشهر الإطفاء تُحفظ (PATCH) فيعيد الخادم الفحص — وخانتها ظاهرة لفحص الأشهر المانع', () => {
  const lease = view({
    status: 'NEEDS_REVIEW', checks: [{ code: 'MONTHS_INVALID', severity: 'block', field: 'months', details: { reason: 'MISSING', max: '24' } }],
    suggestion: { treatment: 'PREPAID', accountCode: '621004', accountName: 'الإيجار', vatMode: 'NON_DEDUCTIBLE', months: null, paidFrom: null },
    facts: facts({ docType: 'LEASE_CONTRACT', months: null }),
  });
  assert.deepEqual(monthsPatch(lease, 12), { months: 12 });
  assert.deepEqual(monthsPatch(lease, 1), { months: 1 });
  assert.equal(monthsPatch(lease, null), null);
  assert.equal(monthsPatch(lease, 0), null);
  assert.equal(monthsPatch(lease, 36), null, 'الأطول للمحاسب البشري — يُقال ولا يُرسل');
  assert.equal(monthsPatch(lease, 2.5), null);
  assert.equal(monthsPatch(view({ facts: facts({ months: 12 }) }), 12), null, 'المخزّن نفسه لا طلب');
  assert.equal(monthsPatch(view({ posted: { moveId: 'm', moveNumber: 'J', live: true, kind: 'PREPAID' } }), 12), null);
  // قبل الحفظ يمنع فحص الخادم الأحمر، وبعده (الأشهر في الحقائق والفحص زال) يُتاح «سجّل القيد»
  const pre = withTreatment(lease, ready(lease, { months: 12 }), 'PREPAID');
  assert.equal(confirmBlocker(lease, pre, OPTS), 'CHECKS');
  const saved = view({ ...lease, status: 'EXTRACTED', checks: [], facts: facts({ docType: 'LEASE_CONTRACT', months: 12 }) });
  assert.equal(confirmBlocker(saved, pre, OPTS), null);
  assert.equal(defaultChoice(saved, OPTS).months, 12, 'والاختيار من الحقائق');
  // الخانة: للمقدّم، أو لفحص أشهرٍ مانع ولو اختار «مصروف» (الخادم يمنعه حتى تُدخل) — لا لما يُحال للمحاسب البشري
  assert.equal(monthsInputShown(lease, { treatment: 'EXPENSE' }), true);
  assert.equal(monthsInputShown(view(), { treatment: 'EXPENSE' }), false);
  assert.equal(monthsInputShown(view(), { treatment: 'PREPAID' }), true);
  assert.equal(monthsInputShown(view({ checks: [{ code: 'MONTHS_INVALID', severity: 'block', details: { reason: 'REFERRED' } }] }), { treatment: 'EXPENSE' }), false);
});

test('الرفض في المحادثة: محاولةٌ أحدث تطويه، وتصحيح الحقائق بعده يُسقطه ووسم التكرار معه', () => {
  const v = view();
  const confirm = { docId: DOC_ID };
  const refused = { id: 'a1', role: 'assistant', documents: [v], action: 'DOC_REFUSED', refusal: { code: 'DOC_POSSIBLE_DUPLICATE', message: '', details: { moveNumber: 'JV/9' } } };
  const base = [{ id: 'u1', role: 'user', docConfirm: confirm }, refused];
  assert.equal(refusalsByDoc(base)[DOC_ID]?.code, 'DOC_POSSIBLE_DUPLICATE');
  assert.deepEqual(refusalsByDoc([...base, { id: 'u2', role: 'user', docConfirm: confirm }]), {}, 'محاولةٌ جديدة تنتظر ردّها — لا الرفض القديم');
  // صُحّحت الحقائق بعد الرفض (رقم الفاتورة أو المبلغ) ⇒ لا صندوق رفض ولا «ليست مكررة — سجّلها» يتخطّى فحص التكرار الجديد
  const byDoc = refusalsByDoc(base);
  assert.equal(confirmBlocker(withRefusalDuplicate(v, byDoc[DOC_ID]), ready(v), OPTS), 'DUPLICATE', 'قبل التصحيح: التجاوز وحده');
  const act = activeRefusals(byDoc, { [DOC_ID]: true });
  assert.deepEqual(act, {});
  assert.equal(withRefusalDuplicate(v, act[DOC_ID]), v);
  assert.equal(confirmBlocker(withRefusalDuplicate(v, act[DOC_ID]), ready(v), OPTS), null, '«سجّل القيد» العادي فيحكم الخادم من جديد');
  assert.deepEqual(activeRefusals(byDoc, {}), byDoc);
  assert.deepEqual(activeRefusals(byDoc, { other: true }), byDoc);
  // أحدث بطاقة لمستند في المحادثة (لإشعار الخطأ)
  const newer = view({ facts: facts({ total: '999.00' }) });
  assert.equal(latestDocView([{ documents: [v] }, {}, { documents: [newer] }], DOC_ID), newer);
  assert.equal(latestDocView([{ documents: [v] }], 'x'), null);
});

test('الملف نفسه في شريحتين أو في رسالةٍ أُرسلت: حذف شريحةٍ لا يحذف مستنداً ما زال مستعملاً', () => {
  const chips = [{ key: 'a', docId: DOC_ID }, { key: 'b', docId: DOC_ID }, { key: 'c', docId: null }];
  assert.equal(docIdInUse(DOC_ID, chips, [], 'a'), true, 'شريحةٌ أخرى تحمله');
  assert.equal(docIdInUse(DOC_ID, chips.slice(0, 1), [], 'a'), false);
  assert.equal(docIdInUse(DOC_ID, chips.slice(0, 1), [{ docIds: [DOC_ID] }], 'a'), true, 'رسالةٌ أُرسلت به');
  assert.equal(docIdInUse(DOC_ID, [], [{}, { docIds: null }], 'a'), false);
});

// ─── الإدخال اليدوي ───

test('PATCH بالحقول المتغيّرة وحدها: الأرقام الهندية والفواصل تُوحَّد، والمحو null، والخطأ يسمّي خانته', () => {
  const v = view();
  const same = patchOf(formOf(v), v, { decimals: 2 });
  assert.deepEqual(same, { ok: true, patch: {} }, 'لا تغيير ⇒ لا طلب (لا يقلب المصدر إلى QR+USER)');
  const r = patchOf({ ...formOf(v), total: '١٬١٥٠٫٥', invoiceNo: '  2231-A ' }, v, { decimals: 2 });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.patch, { total: '1150.50', invoiceNo: '2231-A' });
  assert.deepEqual(patchOf({ ...formOf(v), total: '1,150.00' }, v, { decimals: 2 }), { ok: true, patch: {} }, 'المبلغ نفسه بفواصل لا يُعدّ تغييراً');
  const cleared = patchOf({ ...formOf(v), vendorName: '', subtotal: '' }, v, { decimals: 2 });
  assert.deepEqual(cleared.ok && cleared.patch, { vendorName: null, subtotal: null });
  const bad = patchOf({ ...formOf(v), total: '12abc' }, v, { decimals: 2 });
  assert.deepEqual(bad, { ok: false, field: 'total', problem: 'AMOUNT' });
  const badDay = patchOf({ ...formOf(v), issueDate: '2026-02-30' }, v, { decimals: 2 });
  assert.deepEqual(badDay, { ok: false, field: 'issueDate', problem: 'DATE' });
  const badVat = patchOf({ ...formOf(v), vendorVat: '30000*0003' }, v, { decimals: 2 });
  assert.equal(!badVat.ok && badVat.field, 'vendorVat');
  const order = patchOf({ ...formOf(v), periodFrom: '2026-12-01', periodTo: '2026-01-01' }, v, { decimals: 2 });
  assert.deepEqual(order, { ok: false, field: 'periodTo', problem: 'PERIOD' });
  // إدخالٌ يدوي من الصفر (بلا QR): كل ما كُتب يُرسَل
  const manual = view({ manualEntry: true, factsSource: null, facts: null, status: 'NEEDS_REVIEW' });
  const m = patchOf({ ...formOf(manual), vendorName: 'مكتب', issueDate: '2026-11-01', total: '500' }, manual, { decimals: 2 });
  assert.deepEqual(m.ok && m.patch, { vendorName: 'مكتب', issueDate: '2026-11-01', total: '500.00' });
});

test('تنبيهات النموذج الفورية: مجموعٌ لا يطابق، ورقمٌ ضريبي بغير صيغة الهيئة', () => {
  assert.equal(sumMismatch({ subtotal: '1000', vatAmount: '150', total: '1150' }, 2), false);
  assert.equal(sumMismatch({ subtotal: '1000', vatAmount: '150', total: '1150.01' }, 2), false, 'فرق وحدةٍ صغرى مقبول');
  assert.equal(sumMismatch({ subtotal: '1000', vatAmount: '150', total: '1150.02' }, 2), true);
  assert.equal(sumMismatch({ subtotal: '', vatAmount: '150', total: '1150' }, 2), false, 'خانةٌ فارغة لا تُحكم');
  assert.equal(vendorVatOdd('300000000000003'), false);
  assert.equal(vendorVatOdd('٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣'), false, 'الأرقام الهندية');
  assert.equal(vendorVatOdd('123'), true);
  assert.equal(vendorVatOdd(''), false);
});

// ─── العرض ───

test('الفحوص الظاهرة: المانع أولاً بلا تكرار، ونصوصها من مرآة العقد (docCheckText)', () => {
  const out = visibleChecks([
    { code: 'VAT_RATE_ODD', severity: 'warn' }, { code: 'TOTAL_MISSING', severity: 'block' }, { code: 'VAT_RATE_ODD', severity: 'warn' },
  ], false);
  assert.deepEqual(out.map(c => c.code), ['TOTAL_MISSING', 'VAT_RATE_ODD']);
  assert.deepEqual(visibleChecks(null, false), []);
  // سبب تعطيل «سجّل القيد» لكل مانع — بعبارات مرآة العقد حيث تقول الشيء نفسه
  const codes = ['POSTED', 'GONE', 'EDITING', 'INVENTORY', 'CHECKS', 'TOTAL', 'DATE', 'TREATMENT', 'ACCOUNT', 'PAID_FROM', 'NOT_A_PAYMENT', 'MONTHS', 'REFERRED', 'DUPLICATE', 'ALREADY_POSTED'] as const;
  for (const c of codes) assert.ok(blockerText(c).trim(), c);
  assert.equal(blockerText('PAID_FROM'), 'اختر «مدفوع من»');
  assert.ok(blockerText('DUPLICATE').includes('ليست مكررة — سجّلها'));
  assert.equal(treatmentLabel('PREPAID'), 'مقدّم يُوزَّع على أشهر');
  assert.equal(treatmentLabel('ASSET'), 'أصل');
  assert.equal(treatmentLabel('EXPENSE'), 'مصروف');
  assert.equal(docStateLabel('ready'), 'جاهز للتسجيل');
  assert.equal(payOptionLabel({ paidFrom: 'payable', code: '213002', name: 'مصروفات مستحقة' }), 'آجل — على الحساب (213002)');
  assert.equal(payOptionLabel({ paidFrom: 'bank', code: '111101', name: 'البنك الرئيسي' }), '111101 البنك الرئيسي');
  assert.equal(payValue({ paidFrom: 'bank', code: '111101' }), 'bank:111101');
  assert.equal(payOptionOf(view(), 'bank:111101')?.code, '111101');
  assert.equal(payOptionOf(view(), 'bank:999'), null);
  assert.equal(viewKindOf('application/pdf'), 'pdf');
  assert.equal(viewKindOf('image/png'), 'image');
  assert.equal(viewKindOf('text/html'), null);
  assert.equal(viewKindOf(''), null);
});

test('شرائح خانة الكتابة: الإرسال ينتظر الرفع، والجاهز وحده يُرسَل، والسقف ٣ لا تحجزه شريحة خاطئة', () => {
  const chip = (over: Partial<PendingDoc>): PendingDoc => ({
    key: Math.random().toString(36), fileName: 'f.jpg', mimeType: 'image/jpeg', sizeBytes: 1, phase: 'ready', progress: 100, error: null,
    docId: DOC_ID, deduped: false, localUrl: null, ...over,
  });
  const other = '22222222-2222-4222-8222-222222222222';
  assert.equal(pendingBusy([chip({}), chip({ phase: 'uploading' })]), true);
  assert.equal(pendingBusy([chip({}), chip({ phase: 'error', docId: null })]), false);
  assert.deepEqual(readyDocIds([chip({}), chip({ docId: other }), chip({ phase: 'error', docId: null }), chip({})]), [DOC_ID, other], 'بلا تكرار وبلا الخاطئ');
  assert.equal(readyDocIds([chip({}), chip({ docId: other })], 1).length, 1);
  assert.equal(slotsLeft([chip({}), chip({ phase: 'error' })]), 2);
  assert.equal(slotsLeft([chip({}), chip({}), chip({})]), 0);
  assert.equal(slotsLeft([], 3), 3);
});

test('في المحادثة: البطاقة الكاملة في أحدث ردٍّ يذكرها (لا ردّ «رُحّل»)، والرفض الأخير لكل مستند، وما يُرحَّل الآن', () => {
  const v = view();
  const confirm = { docId: DOC_ID };
  const entries = [
    { id: 'u0', role: 'user' },
    { id: 'a0', role: 'assistant', documents: [v] },
    { id: 'u1', role: 'user', docConfirm: confirm },
    { id: 'a1', role: 'assistant', documents: [v], action: 'DOC_REFUSED', refusal: { code: 'DOC_POSSIBLE_DUPLICATE', message: 'x' } },
  ];
  assert.deepEqual(cardOwners(entries), { [DOC_ID]: 'a1' }, 'الرفض يحمل البطاقة إلى أحدث ردّ');
  assert.equal(refusalsByDoc(entries)[DOC_ID]?.code, 'DOC_POSSIBLE_DUPLICATE');
  const posted = [...entries, { id: 'u2', role: 'user', docConfirm: confirm }, { id: 'a2', role: 'assistant', documents: [v], action: 'DOC_POSTED' }];
  assert.deepEqual(cardOwners(posted), { [DOC_ID]: 'a1' }, 'ردّ «رُحّل» لا يملك البطاقة — بطاقة القيد فيه');
  assert.deepEqual(refusalsByDoc(posted), {}, 'الترحيل يمحو الرفض');
  // إشعار خطأ (انقطاع) لا يُحتسب ردّاً — والإعادة تُحسب
  const failed = [...entries.slice(0, 2), { id: 'u1', role: 'user', docConfirm: confirm }, { id: 'e', role: 'assistant', error: 'شبكة' }];
  assert.deepEqual(refusalsByDoc(failed), {});
  // البطاقة المنتقلة إلى الردّ الأحدث تستعيد اختيار المستخدم من آخر docConfirm («مدفوع من» والمعالجة والأشهر)
  const lease = view({ facts: facts({ docType: 'LEASE_CONTRACT', periodFrom: '2026-01-01', periodTo: '2026-12-31' }) });
  const sent = { docId: DOC_ID, treatment: 'PREPAID' as const, accountCode: '621004', paidFrom: 'bank' as const, paidFromAccountCode: '111101', months: 6 };
  const older = { ...sent, months: 3 };
  const lc = lastConfirms([{ id: 'u', role: 'user', docConfirm: older }, { id: 'a', role: 'assistant' }, { id: 'u2', role: 'user', docConfirm: sent }]);
  assert.deepEqual(lc[DOC_ID], sent, 'الأحدث يغلب');
  const back = choiceFromConfirm(lease, sent, OPTS);
  assert.deepEqual([back.treatment, back.accountCode, back.pay, back.months, back.date], ['PREPAID', '621004', 'bank:111101', 6, null]);
  assert.equal(confirmBlocker(lease, back, OPTS), null, 'يُضغط فوراً بلا إعادة اختيار');
  const gonePay = choiceFromConfirm(view({ payOptions: [{ paidFrom: 'cash', code: '111001', name: 'الصندوق' }] }), sent, OPTS);
  assert.equal(gonePay.pay, '', 'خيارٌ لم يعد موجوداً ⇒ يُختار من جديد');
  assert.equal(confirmingDocId([...entries, { id: 'u3', role: 'user', docConfirm: confirm }], true), DOC_ID);
  assert.equal(confirmingDocId([...entries, { id: 'u3', role: 'user', docConfirm: confirm }], false), null);
  assert.equal(confirmingDocId([...entries, { id: 'u3', role: 'user' }], true), null);
});

// ─── التوصيل (حرّاسٌ نصّية على المكوّنات) ───

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('البطاقة: «سجّل القيد» يرسل docConfirmMessage، والأحمر يعطّله، والحذف لما لم يُرحَّل قط، والضريبة تُخفى بـtaxOff', () => {
  const card = read('components', 'aiAccountant', 'docs', 'DocCard.tsx');
  assert.match(card, /docConfirmMessage\(eff, cc, tr, \{ taxOff: env\.taxOff, decimals \}\)/);
  assert.match(card, /env\.onConfirm\(msg\)/);
  assert.match(card, /disabled=\{env\.busy \|\| blocker !== null\}/, '«سجّل القيد» معطّلٌ بأي مانع');
  assert.match(card, /\{tr\('ليست مكررة — سجّلها'\)\}/);
  assert.match(card, /\{tr\('سجّل بتاريخ اليوم'\)\}/);
  assert.match(card, /\{tr\('يحتاج إهلاكاً يسجّله المحاسب'\)\}/);
  assert.match(card, /\{!view\.posted && \(/, '«حذف» لما لم يُرحَّل قط');
  assert.match(card, /aiAccountantApi\.documents\.patch\(view\.id, body\)/);
  assert.match(card, /aiAccountantApi\.documents\.remove\(view\.id\)/);
  assert.equal((card.match(/!env\.taxOff && (field|<Fact)/g) ?? []).length, 6, 'صفوف الضريبة الثلاثة في العرض والإدخال');
  assert.match(card, /useState\(\(\) => view\.manualEntry === true && !live && !view\.factsSource\)/, 'بلا QR ⇒ وضع الإدخال');
  // لا تخزين على الجهاز في مكوّنات المستندات
  for (const f of ['AttachTray.tsx', 'DocChips.tsx', 'DocCard.tsx', 'DocViewer.tsx', 'docCardLogic.ts']) {
    assert.doesNotMatch(read('components', 'aiAccountant', 'docs', f), /localStorage|sessionStorage|indexedDB/, f);
  }
});

test('العارض: البايتات بتوقيعها، والرابط يُبطَل عند الإغلاق، والرابط المحلي لا يُبطله العارض', () => {
  const s = read('components', 'aiAccountant', 'docs', 'DocViewer.tsx');
  assert.match(s, /aiAccountantApi\.documents\.content\(doc\.id\)/);
  assert.match(s, /sniffDocMime\(/);
  assert.match(s, /new Blob\(\[blob\], \{ type: mime \}\)/, 'الـBlob بالنوع المفحوص');
  assert.match(s, /URL\.revokeObjectURL\(o\.url\)/);
  assert.match(s, /if \(src\) return;/, 'الرابط المحلي لا يُجلب ولا يُبطَل هنا');
  assert.match(s, /useBackClose\(true, onClose\)/);
});

test('البطاقة: شرائح التصنيف وفئة الأصل، والأشهر تُحفظ، و«مدفوع من» الظاهر، والإطفاء الشهري، والعارض باتجاه الواجهة', () => {
  const card = read('components', 'aiAccountant', 'docs', 'DocCard.tsx');
  assert.match(card, /DOC_CATEGORY_CHIPS\.map\(\(c\) => chip\(c, category === c, categoryChipLabel\(c, tr\), \(\) => pickHint\(categoryChipPatch\(c, f\)\)\)\)/);
  assert.match(card, /\{category === 'FIXED_ASSET' && \(/);
  assert.match(card, /pickHint\(assetClassPatch\(a, f\)\)/);
  assert.match(card, /\{tr\('تصنيف المستند'\)\}/);
  assert.match(card, /\{referral && !live && \(/, 'البضاعة والأرض يُقال سببهما تحت الشرائح');
  // الأشهر: PATCH بعد مهلة، ولا تُقلب المعالجة لأن المستخدم كتب عدداً
  assert.match(card, /const body = monthsPatch\(view, choice\.months\);/);
  assert.match(card, /patch\.mutate\(body, \{ onError: \(\) => \{ keepChoice\.current = false; \} \}\)/);
  assert.match(card, /if \(!changed \|\| keep\) return reconcileChoice\(view, c, o\);/);
  assert.match(card, /\{monthsShown && \(/);
  assert.match(card, /tr\('يُطفأ شهرياً على حساب \{account\}'\)/);
  // «مدفوع من» الظاهر (بلا آجل لعقد الإيجار)، والفحوص بتفاصيلها، والضريبة لحكم الحساب المختار
  assert.match(card, /\{payOptions\.map\(o => <option/);
  assert.doesNotMatch(card, /view\.payOptions\.map/);
  assert.match(card, /docCheckText\(c\.code, tr, c\.details\)/);
  assert.match(card, /const vatNote = vatModeText\(chosenVatMode\(view, choice\), env\.taxOff, tr\);/);
  assert.match(card, /visibleChecks\(view\.checks, env\.taxOff, \{ suggestionChosen: choiceIsSuggestion\(view, choice\) \}\)/);
  // العارضان (الويب والجوال) طبقةٌ في body باتجاه لغة الواجهة — لا RTL ثابت في الإنجليزية
  for (const f of [read('components', 'aiAccountant', 'docs', 'DocViewer.tsx'), read('m', 'MDocViewer.tsx')]) {
    assert.match(f, /const dir = useDir\(\);/);
    assert.match(f, /dir=\{dir\}/);
    assert.doesNotMatch(f, /dir="rtl"/);
  }
});
