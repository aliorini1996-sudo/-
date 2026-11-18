// «المحاسب الذكي AI» — عقد المستندات بين الحزم (اختبار التكامل، طلب المالك ١٨ نوفمبر ٢٠٢٦): ما يحسبه الخادم للبطاقة يمرّ كما
// يمرّ في الإنتاج إلى مرآة الويب ثم يعود رسالةَ «سجّل القيد» يقبلها حارس الترحيل ويرحّلها متّزنة:
//   حقائق الخادم (QR الزكوي أو إدخال المستخدم — facts.ts/defaultDocEngine) ⇒ العرض (view.ts toView، عبر JSON)
//   ⇒ الويب: normalizeDocView وdocConfirmMessage (lib/aiAccountantDocs.ts)، واختيار البطاقة الافتراضي ثم اختيار المستخدم
//     (defaultChoice وconfirmChoiceOf في components/aiAccountant/docs/docCardLogic.ts — منطق البطاقة نفسه)، وbuildChatBody (lib/aiAccountant.ts)
//   ⇒ جسم POST /chat (chatBodySchema) ⇒ الحرّاس ٤–٧ والخطة (documents/post.ts planDocumentPost) بدليل SA_6D.
// كل حزمة اختُبرت بمزدوجاتها؛ هنا تلتقي الحقيقيات معاً — فافتراقُ نصّ البطاقة عن حارس المبلغ أو رمز الحساب يُكتشف هنا.
// بلا قاعدة ولا شبكة ولا نموذج: ملفات الويب صرفة بلا تبعيات (تُستورد مباشرة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tlv } from '../compliance/zatca/qr';
import { chatBodySchema } from '../services/aiAccountant/chat';
import { planDocumentPost } from '../services/aiAccountant/documents/post';
import { defaultDocEngine } from '../services/aiAccountant/documents/store';
import { toView, type DocRow } from '../services/aiAccountant/documents/view';
import { emptyFacts, type AcctDocConfirm, type AcctDocEnv, type AcctDocFacts, type AcctDocPatch, type AcctPaidFrom } from '../services/aiAccountant/documents/types';
import type { AiPostPlan, PlanEnv, PlanOutcome } from '../services/aiAccountant/posting';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import type { GlSettingsRow, LedgerContext } from '../services/gl/resolve';
import { createBuildContext, type MoveDraft } from '../services/gl/types';
// مرآة الويب (الواجهة نفسها تستوردها) — صرفة بلا React ولا شبكة
import * as web from '../../../web-admin/src/lib/aiAccountantDocs';
import * as card from '../../../web-admin/src/components/aiAccountant/docs/docCardLogic';
import { buildChatBody, type ChatEntry } from '../../../web-admin/src/lib/aiAccountant';

const DOC = 'd0c00000-0000-4000-8000-0000000000c1';
const REF1 = '6f1c2b1e-0000-4000-8000-0000000000e1';
const REF2 = '6f1c2b1e-0000-4000-8000-0000000000e2';
const TODAY = '2026-11-18';
const VENDOR_VAT = '310123456700003';

// ═══ دليل الشركة (SA_6D) كما يقرؤه الخادم ═══

function ledgerContext(dec = 2): LedgerContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { currencyDecimals: dec }, extraAccounts: [...linkedAccountRefs(accountIdOf)],
  });
  const ctx = createBuildContext(input);
  const accounts = [...input.accounts];
  const taxes = [...(input.taxes ?? [])];
  const journals = [...(input.journals ?? [])];
  return {
    ctx, settings: {} as GlSettingsRow, accounts, taxes, journals,
    accountById: new Map(accounts.map((a) => [a.id, a])),
    taxById: new Map(taxes.map((t) => [t.id, t])),
    journalById: new Map(journals.map((j) => [j.id, j])),
  };
}

/** سياق المستندات كما يبنيه loadDocEnv (store.ts): حسابات المصروفات والنقد ورموز المستندات من الدليل نفسه */
function docEnvOf(lc: LedgerContext, p: Partial<AcctDocEnv> = {}): AcctDocEnv {
  const want = new Set(['111001', '111002', '111101', '213002', '115001', '115002', '116001', '121001', '121002',
    '121003', '121004', '121005', '121006', '121007', '121008', '124001']);
  return {
    tenantId: 't1', currency: 'SAR', currencyDecimals: lc.ctx.settings.currencyDecimals, taxDisabled: false, companyVat: '300000000000003',
    todayLocal: TODAY, tz: 'Asia/Riyadh', vatBox: true, assetThresholdMilli: 2_000_000n,
    accounts: lc.accounts
      .filter((a) => want.has(a.code) || a.type.startsWith('expense') || a.type === 'asset_cash')
      .map((a) => ({ code: a.code, name: a.name, type: a.type, isActive: a.isActive, controlKind: a.controlKind ?? null })),
    ...p,
  };
}

interface DocState { facts: AcctDocFacts; qrRaw: string | null; qrVerified: boolean; manualEntry: boolean; factsSource: string }

/** صفّ المستند بعد إعادة الفحص (كـuploadDocument/patchDocument) ⇒ عرضه كما يصل الويب (JSON حرفياً) */
function wireView(s: DocState, env: AcctDocEnv): unknown {
  const r = defaultDocEngine.recheck(s.facts, env, { mimeType: 'image/jpeg', qrVerified: s.qrVerified, manualEntry: s.manualEntry, qrRaw: s.qrRaw });
  const o = defaultDocEngine.options(s.facts, env);
  const row: DocRow = {
    id: DOC, tenantId: 't1', actorRef: 'a1', attachmentId: 'att-1', sha256: 'sha-1', fileName: 'invoice.jpg', mimeType: 'image/jpeg',
    sizeBytes: 120_000, status: r.status, manualEntry: s.manualEntry, factsSource: s.factsSource, facts: s.facts, qrRaw: s.qrRaw,
    qrVerified: s.qrVerified, checks: r.checks, suggestion: r.suggestion, moveId: null, postId: null,
    createdAt: new Date('2026-11-18T08:00:00Z'), updatedAt: new Date('2026-11-18T08:00:00Z'),
  };
  return JSON.parse(JSON.stringify(toView(row, { ref: 'D1', accountOptions: o.accountOptions, payOptions: o.payOptions })));
}

/** إدخال يدوي (PDF أو صورة بلا QR) بتصحيح PATCH كما يرسله الويب (buildDocPatch ⇐ نصوص عشرية) */
function manual(patch: AcctDocPatch, env: AcctDocEnv): DocState {
  const facts = defaultDocEngine.applyPatch(emptyFacts(), patch, env);
  return { facts, qrRaw: null, qrVerified: false, manualEntry: true, factsSource: 'USER' };
}

/** «سجّل القيد» من البطاقة كما يبنيه الويب: الاختيار ⇒ الرسالة ⇒ جسم المحادثة (رسالة الرفع ثم ردّ ثم التأكيد) */
function confirmBody(viewWire: unknown, choice: Partial<web.DocConfirmChoice> & { paidFrom: AcctPaidFrom }, opts: web.DocConfirmOptions = {}) {
  const v = web.normalizeDocView(viewWire);
  assert.ok(v, 'عرض الخادم يجتاز تطبيع الويب');
  // البطاقة: الاختيار الافتراضي من اقتراح الخادم وخياراته، ثم ما يغيّره المستخدم، و«مدفوع من» يختاره بنفسه (D1)
  const d = card.defaultChoice(v, { assetThreshold: 2000, taxOff: opts.taxOff === true });
  const payOpt = v.payOptions.find((o) => o.paidFrom === choice.paidFrom && (!choice.paidFromAccountCode || o.code === choice.paidFromAccountCode));
  assert.ok(payOpt, `«مدفوع من» ${choice.paidFrom} من خيارات الخادم`);
  const picked: card.DocChoice = {
    ...d, pay: card.payValue(payOpt),
    ...(choice.treatment ? { treatment: choice.treatment } : {}),
    ...(choice.accountCode ? { accountCode: choice.accountCode } : {}),
    ...(choice.months !== undefined ? { months: choice.months ?? null } : {}),
    ...(choice.date !== undefined ? { date: choice.date ?? null } : {}),
  };
  const c = card.confirmChoiceOf(v, picked, choice.confirmedNotDuplicate === true);
  assert.ok(c, 'اختيار البطاقة بلغة العقد');
  assert.equal(web.docConfirmProblem(v, c), null, 'البطاقة تسمح بالتأكيد');
  const m = web.docConfirmMessage(v, c, undefined, opts);
  assert.ok(m, 'رسالة التأكيد');
  const entries: ChatEntry[] = [
    { id: 'u1', role: 'user', text: web.docDefaultText(), clientRef: REF1, docIds: [v.id] },
    { id: 'a1', role: 'assistant', text: 'هذه بيانات المستند.', documents: [v] },
    { id: 'u2', role: 'user', text: m.text, clientRef: REF2, docIds: m.docIds, docConfirm: m.docConfirm },
  ];
  const body = buildChatBody(entries, REF2, 'u2');
  assert.ok(body, 'جسمٌ يُرسَل');
  // ما يصل الخادم فعلاً (JSON) يجتاز مخطط المسار
  return { view: v, text: m.text, body: chatBodySchema.parse(JSON.parse(JSON.stringify(body))) };
}

function plan(s: DocState, b: ReturnType<typeof confirmBody>, p: Partial<PlanEnv> = {}, lc = ledgerContext()): { out: PlanOutcome; lc: LedgerContext } {
  const env: PlanEnv = { lc, booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false, ...p };
  const last = b.body.messages[b.body.messages.length - 1];
  const out = planDocumentPost(env, {
    doc: { docId: DOC, facts: JSON.parse(JSON.stringify(s.facts)), factsSource: s.factsSource },
    // ما اجتاز مخطط المسار (zod: الاختياري nullish) كما يمرّره chat.ts إلى الترحيل
    confirm: b.body.docConfirm! as AcctDocConfirm, lastText: last.text, todayLocal: TODAY, assetThresholdMilli: 2_000_000n,
  });
  return { out, lc };
}

/** المسودة متّزنة ⇐ {الرمز: [مدين، دائن]} */
function sums(m: MoveDraft, lc: LedgerContext): Record<string, [bigint, bigint]> {
  const v = validateMove(m, lc.ctx, { mode: 'MANUAL' });
  assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'متّزن');
  const out: Record<string, [bigint, bigint]> = {};
  for (const l of m.lines) {
    const acc = resolveLineAccount(l, lc.ctx.accounts)!;
    const cur = out[acc.code] ?? [0n, 0n];
    out[acc.code] = [cur[0] + l.debitMilli, cur[1] + l.creditMilli];
  }
  return out;
}

const planOf = (o: PlanOutcome): AiPostPlan => { if (!o.ok) assert.fail(`رُفض: ${o.refusal.code} ${o.refusal.message}`); return o.plan; };

const enc = (s: string) => Buffer.from(s, 'utf8');
const qrOf = (total: string, vat: string, when = '2026-11-10T10:30:00Z') =>
  Buffer.from(tlv([[1, enc('مؤسسة الإتقان للصيانة')], [2, enc(VENDOR_VAT)], [3, enc(when)], [4, enc(total)], [5, enc(vat)]])).toString('base64');

// ═══ السيناريوهات ═══

test('العقد: فاتورة برمز QR الزكوي ⇒ بطاقة ⇒ «سجّل القيد» من البنك ⇒ مصروف + ضريبة مدخلات / البنك، متّزن', () => {
  const lc = ledgerContext();
  const env = docEnvOf(lc);
  const qr = qrOf('1150.00', '150.00');
  const q = defaultDocEngine.fromQr(qr, env);
  assert.equal(q.qrVerified, true);
  // المستخدم يختار نوع المستند «فاتورة صيانة» في الشرائح (PATCH docType) ⇒ QR+USER
  const facts = defaultDocEngine.applyPatch(q.facts, { docType: 'MAINTENANCE_INVOICE' }, env);
  const s: DocState = { facts, qrRaw: qr, qrVerified: true, manualEntry: false, factsSource: 'QR+USER' };
  const b = confirmBody(wireView(s, env), { paidFrom: 'bank' });
  assert.equal(b.view.status, 'EXTRACTED');
  assert.equal(b.view.suggestion?.accountCode, '621010', 'الاقتراح الحتمي من نوع المستند');
  assert.match(b.text, /1,150\.00/);
  assert.match(b.text, /150\.00/);
  assert.match(b.text, /621010/);
  assert.match(b.text, /111101/);
  assert.equal(b.body.docConfirm?.paidFromAccountCode, '111101');
  assert.equal('total' in (b.body.docConfirm as object), false, 'docConfirm بلا مبالغ — المبالغ من الخادم');
  const { out } = plan(s, b);
  const p = planOf(out);
  assert.equal(p.kind, 'EXPENSE');
  assert.deepEqual(sums(p.draft, lc), { '621010': [1_000_000n, 0n], '116001': [150_000n, 0n], '111101': [0n, 1_150_000n] });
});

test('العقد: إدخال يدوي بأرقام هندية وفواصل ⇒ آجل على 213002 (D6)، والصندوق برمزه', () => {
  const lc = ledgerContext();
  const env = docEnvOf(lc);
  const s = manual({
    docType: 'UTILITY_BILL', vendorName: 'شركة الكهرباء', vendorVat: VENDOR_VAT, invoiceNo: '77', issueDate: '2026-11-05',
    subtotal: '١٬٠٠٠٫٠٠', vatAmount: '150', total: '1150.00',
  }, env);
  assert.equal(s.facts.total, '1150.00');
  const payable = confirmBody(wireView(s, env), { paidFrom: 'payable' });
  assert.match(payable.text, /213002/);
  assert.equal(payable.body.docConfirm?.paidFromAccountCode, undefined);
  assert.deepEqual(sums(planOf(plan(s, payable).out).draft, lc), { '621006': [1_000_000n, 0n], '116001': [150_000n, 0n], '213002': [0n, 1_150_000n] });
  const cash = confirmBody(wireView(s, env), { paidFrom: 'cash' });
  assert.deepEqual(sums(planOf(plan(s, cash).out).draft, lc), { '621006': [1_000_000n, 0n], '116001': [150_000n, 0n], '111001': [0n, 1_150_000n] });
});

test('العقد: إيجار سنوي مدفوع مقدماً (D2) ⇒ 115002 + ضريبة مدخلات، ومصروف الإطفاء يراه المستخدم ويختاره — والأشهر والحسابان في النصّ', () => {
  const lc = ledgerContext();
  const env = docEnvOf(lc);
  const s = manual({
    docType: 'TAX_INVOICE', vendorName: 'شركة العقار — إيجار المعرض', vendorVat: VENDOR_VAT, invoiceNo: 'R-12', issueDate: '2026-11-01',
    periodFrom: '2026-11-01', periodTo: '2027-10-31', subtotal: '12000.00', vatAmount: '1800.00', total: '13800.00',
  }, env);
  const wire = wireView(s, env);
  const v = web.normalizeDocView(wire)!;
  assert.equal(v.suggestion?.treatment, 'PREPAID');
  // الاقتراح مصروف الإطفاء (ما ترسله البطاقة)، وخيارات المدفوع مقدماً مصروفاتٌ يُطفأ عليها — لا 115001/115002 (يُشتقّان)
  assert.deepEqual([v.suggestion?.accountCode, v.suggestion?.amortizationCode], ['621004', '621004']);
  assert.equal(v.suggestion?.months, 12);
  const prepaidOpts = v.accountOptions.filter((o) => o.treatment === 'PREPAID').map((o) => o.code);
  for (const c of ['621004', '621005', '621008', '621015']) assert.ok(prepaidOpts.includes(c), c);
  assert.equal(prepaidOpts.some((c) => c === '115001' || c === '115002'), false);
  // اختيار البطاقة الافتراضي ⇒ النصّ يذكر 115002 و621004 والأشهر، والقيد على 115002 بجدولٍ على 621004
  const def = confirmBody(wire, { paidFrom: 'bank' });
  assert.equal(def.body.docConfirm?.treatment, 'PREPAID');
  assert.equal(def.body.docConfirm?.accountCode, '621004');
  assert.equal(def.body.docConfirm?.months, 12);
  assert.match(def.text, /115002/);
  assert.match(def.text, /621004/);
  assert.match(def.text, /12 شهراً/);
  const p1 = planOf(plan(s, def).out);
  assert.equal(p1.kind, 'PREPAID');
  assert.deepEqual([p1.meta?.prepaidCode, p1.meta?.expenseCode], ['115002', '621004']);
  assert.deepEqual(sums(p1.draft, lc), { '115002': [12_000_000n, 0n], '116001': [1_800_000n, 0n], '111101': [0n, 13_800_000n] });
  // المستخدم يختار سكن الموظفين ⇒ يُطفأ على 621005 والضريبة على التكلفة (D7) — ما في النصّ هو ما يُرحَّل
  const staff = confirmBody(wire, { paidFrom: 'bank', accountCode: '621005' });
  assert.match(staff.text, /115002/);
  assert.match(staff.text, /621005/);
  const p2 = planOf(plan(s, staff).out);
  assert.equal(p2.meta?.expenseCode, '621005');
  assert.deepEqual(sums(p2.draft, lc), { '115002': [13_800_000n, 0n], '111101': [0n, 13_800_000n] });
  // نصٌّ حُذف منه مصروف الإطفاء ⇒ الخادم يرفض (لا تخمين من اسم المورد)
  const tamper = { ...def, body: { ...def.body, messages: [...def.body.messages.slice(0, -1), { ...def.body.messages[def.body.messages.length - 1], text: def.text.replace(/621004/g, '') }] } };
  const r = plan(s, tamper).out;
  assert.equal(r.ok ? '' : r.refusal.code, 'ACCOUNT_NOT_IN_MESSAGE');
});

test('العقد: أصل فوق حدّ الرسملة (D3) ⇒ 121006 + ضريبة، و«يحتاج إهلاكاً» في النصّ؛ ودون الحدّ لا خيار أصل في البطاقة', () => {
  const lc = ledgerContext();
  const env = docEnvOf(lc);
  const s = manual({
    docType: 'TAX_INVOICE', vendorName: 'متجر الحاسبات', vendorVat: VENDOR_VAT, invoiceNo: 'PC-9', issueDate: '2026-11-12',
    subtotal: '5000.00', vatAmount: '750.00', total: '5750.00', assetClassHint: 'computers',
  }, env);
  const b = confirmBody(wireView(s, env), { paidFrom: 'bank' });
  assert.equal(b.view.suggestion?.treatment, 'ASSET');
  assert.equal(b.view.suggestion?.accountCode, '121006');
  assert.match(b.text, /يحتاج إهلاكاً يسجّله المحاسب/);
  const p = planOf(plan(s, b).out);
  assert.equal(p.kind, 'ASSET');
  assert.deepEqual(sums(p.draft, lc), { '121006': [5_000_000n, 0n], '116001': [750_000n, 0n], '111101': [0n, 5_750_000n] });

  const small = manual({ docType: 'TAX_INVOICE', vendorName: 'متجر', vendorVat: VENDOR_VAT, issueDate: '2026-11-12', subtotal: '1500.00', vatAmount: '225.00', total: '1725.00', assetClassHint: 'computers' }, env);
  const sv = web.normalizeDocView(wireView(small, env))!;
  assert.equal(sv.accountOptions.some((o) => o.treatment === 'ASSET'), false, 'دون الحدّ: لا حساب أصل في الخيارات');
  assert.equal(sv.suggestion?.treatment, 'EXPENSE');
});

test('العقد: الضريبة غير القابلة للخصم (D7) تدخل التكلفة، والشركة «بلا ضريبة» ترحّل الإجمالي بلا ذكر للضريبة', () => {
  const lc = ledgerContext();
  // مورد بلا رقم ضريبي صحيح ⇒ تُحمَّل على المصروف (النصّ يذكرها والحارس لا يشترطها)
  const env = docEnvOf(lc);
  const s = manual({ docType: 'MAINTENANCE_INVOICE', vendorName: 'مؤسسة الصيانة', vendorVat: null, issueDate: '2026-11-10', subtotal: '1000.00', vatAmount: '150.00', total: '1150.00' }, env);
  const b = confirmBody(wireView(s, env), { paidFrom: 'cash' });
  assert.equal(b.view.suggestion?.vatMode, 'NON_DEDUCTIBLE');
  assert.deepEqual(sums(planOf(plan(s, b).out).draft, lc), { '621010': [1_150_000n, 0n], '111001': [0n, 1_150_000n] });

  const off = docEnvOf(lc, { taxDisabled: true });
  const so = manual({ docType: 'MAINTENANCE_INVOICE', vendorName: 'مؤسسة الصيانة', issueDate: '2026-11-10', total: '1150.00' }, off);
  const bo = confirmBody(wireView(so, off), { paidFrom: 'cash' }, { taxOff: true });
  assert.doesNotMatch(bo.text, /ضريبة/);
  assert.deepEqual(sums(planOf(plan(so, bo, { taxDisabled: true }).out).draft, lc), { '621010': [1_150_000n, 0n], '111001': [0n, 1_150_000n] });
});

test('العقد: «سجّل بتاريخ اليوم» بعد فترة مقفلة ⇒ التاريخ المختار في النصّ والجسم ويُرحَّل به', () => {
  const lc = ledgerContext();
  const env = docEnvOf(lc);
  const s = manual({ docType: 'MAINTENANCE_INVOICE', vendorName: 'مؤسسة الصيانة', vendorVat: VENDOR_VAT, issueDate: '2026-10-02', subtotal: '100.00', vatAmount: '15.00', total: '115.00' }, env);
  const b = confirmBody(wireView(s, env), { paidFrom: 'cash', date: TODAY });
  assert.equal(b.body.docConfirm?.date, TODAY);
  assert.match(b.text, new RegExp(TODAY));
  const p = planOf(plan(s, b).out);
  assert.equal(p.draft.date, TODAY);
});

test('العقد: نصّ البطاقة المحرَّر يدوياً (حُذف الإجمالي أو بُدّل الحساب) يرفضه حارس الخادم', () => {
  const lc = ledgerContext();
  const env = docEnvOf(lc);
  const s = manual({ docType: 'MAINTENANCE_INVOICE', vendorName: 'مؤسسة الصيانة', vendorVat: VENDOR_VAT, issueDate: '2026-11-10', subtotal: '1000.00', vatAmount: '150.00', total: '1150.00' }, env);
  const b = confirmBody(wireView(s, env), { paidFrom: 'cash' });
  const tamper = (text: string) => ({ ...b, body: { ...b.body, messages: [...b.body.messages.slice(0, -1), { ...b.body.messages[b.body.messages.length - 1], text }] } });
  const r1 = plan(s, tamper(b.text.replace('1,150.00', '1,050.00'))).out;
  assert.equal(r1.ok ? '' : r1.refusal.code, 'DOC_TOTAL_NOT_CONFIRMED');
  const r2 = plan(s, tamper(b.text.replace(/621010/g, '621016'))).out;
  assert.equal(r2.ok ? '' : r2.refusal.code, 'ACCOUNT_NOT_IN_MESSAGE');
  const r3 = plan(s, tamper(b.text.replace(/111001/g, ''))).out;
  assert.equal(r3.ok ? '' : r3.refusal.code, 'PAYMENT_SOURCE_NOT_IN_MESSAGE');
});

test('العقد: رفض الخادم ورقم القيد يصلان البطاقة بالمفتاحين (move_number في الرفض، وmoveNumber في ٤٠٩ المسارات)', () => {
  assert.equal(web.refusalMoveNumber({ move_number: 'JV-12' }), 'JV-12');
  assert.equal(web.refusalMoveNumber({ moveNumber: 'JV-13' }), 'JV-13');
  assert.match(web.docRefusalText({ code: 'DOC_ALREADY_POSTED', message: '', details: { move_number: 'JV-12' } }), /JV-12/);
});
