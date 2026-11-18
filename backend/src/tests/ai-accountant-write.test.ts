// «المحاسب الذكي AI» — أدوات الكتابة (الحزمة B، المواصفة §3.4): بناء القيود الصرف (التوازن، الحسابات لكل تصنيف وطريقة دفع،
// فصل الضريبة، الرواتب والتأمينات، سداد المستحق)، وحارس «المبلغ في رسالة المستخدم» (الأرقام الهندية والفواصل)، ورفض الحساب
// الرقابي والعهدة، ورسالة الحساب الغائب بمرشّحيه، وعدم التكرار بالمرجع AI-<clientRef>-n، ومفتاح الإطفاء، ولا أدوات بلا
// صلاحية — ثم التنفيذ كاملاً بمعاملة مزيّفة (القفل ⇒ السياق ⇒ المرجع ⇒ postMove ⇒ الصفّ)، وحراس ثابتة على المصدر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_POST_AUDIT_ACTION, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_KEYS, MAX_POSTS_PER_REQUEST,
  AiPostRefusal, aiRefOf, amountInUserText, amountsInText, buildExpensePlan, buildSalariesPlan, buildSettlePlan, cashCandidates,
  chooseAiRef, executeAiPost, expenseCandidates, linesFingerprint, listAiPostsWith, normalizeAmountText, parseAmountArg,
  postingDateProblem, refusalFromError, resolveSalaryMonth, vatOnTopProblem,
  type AiPostDeps, type AiPostPlan, type AiPostRow, type AiRefusal, type ExpenseInput, type PlanEnv, type PlanOutcome, type ResolvedMonth,
} from '../services/aiAccountant/posting';
import {
  AI_WRITE_TOOL_NAMES, amountGuardRefusal, buildWriteTools, salariesDate, writeGateRefusal, writeToolsAllowed,
  type WriteGateDb, type WriteToolDeps,
} from '../services/aiAccountant/writeTools';
import type { AcctCtx, Tool } from '../services/aiAccountant/context';
import type { ToolOutput } from '../ai-rep/advisor';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, journalIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import type { GlDb, GlSettingsRow, LedgerContext } from '../services/gl/resolve';
import type { PostedMove as GlPostedMove, PostMoveOptions } from '../services/gl/post';
import type { LedgerAdminRow } from '../services/gl/permissions';
import {
  LedgerError, createBuildContext,
  type AccountRef, type BuildContext, type GlSettingsSnapshot, type JournalRef, type MappingKey, type MoveDraft, type TaxRef,
} from '../services/gl/types';

// ═══ السياق ═══

const RAJHI: AccountRef = { id: accountIdOf('111102'), code: '111102', name: 'بنك الراجحي', type: 'asset_cash', isActive: true, reconcile: true, controlKind: null };
const SAFE2: AccountRef = { id: accountIdOf('111009'), code: '111009', name: 'خزنة الفرع', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null };
const RAJHI_JOURNAL: JournalRef = {
  id: journalIdOf('BNK2'), code: 'BNK2', name: 'بنك الراجحي', type: 'BANK', systemKey: null, defaultAccountId: RAJHI.id,
  suspenseAccountId: null, useOutstandingAccounts: false, sequenceReset: 'YEARLY', isActive: true,
};

interface Opts {
  dec?: number;
  settings?: Partial<GlSettingsSnapshot>;
  accounts?: Record<string, Partial<AccountRef> | null>;
  taxes?: Record<string, Partial<TaxRef> | null>;
  journals?: Record<string, Partial<JournalRef> | null>;
  mappings?: Partial<Record<MappingKey, string | null>>;
}

function ledgerContext(o: Opts = {}): LedgerContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { currencyDecimals: o.dec ?? 2, ...(o.settings ?? {}) },
    extraAccounts: [...linkedAccountRefs(accountIdOf), RAJHI, SAFE2],
    extraJournals: [RAJHI_JOURNAL],
    accounts: o.accounts,
    taxes: o.taxes,
    journals: o.journals,
    mappings: o.mappings,
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

const envOf = (o: Opts = {}, p: Partial<PlanEnv> = {}): PlanEnv => ({ lc: ledgerContext(o), booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false, ...p });

/** يتحقق في الوضع اليدوي (I1–I5 كما في postMove) ويعيد {الرمز: [مدين، دائن]} — والسطور بالعربية (G7) */
function manualSums(m: MoveDraft, ctx: BuildContext): Record<string, [bigint, bigint]> {
  const v = validateMove(m, ctx, { mode: 'MANUAL' });
  assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'متّزن');
  const out: Record<string, [bigint, bigint]> = {};
  for (const l of m.lines) {
    assert.match(l.label, /[؀-ۿ]/);
    const acc = resolveLineAccount(l, ctx.accounts)!;
    const cur = out[acc.code] ?? [0n, 0n];
    out[acc.code] = [cur[0] + l.debitMilli, cur[1] + l.creditMilli];
  }
  return out;
}

function planOf(o: PlanOutcome): AiPostPlan {
  if (!o.ok) assert.fail(`رُفض: ${o.refusal.code} ${o.refusal.message}`);
  return o.plan;
}
function refusalOf(o: PlanOutcome): AiRefusal {
  if (o.ok) assert.fail('كان يجب أن يُرفض');
  return o.refusal;
}

const expense = (p: Partial<ExpenseInput> = {}): ExpenseInput => ({
  amountMilli: 1_500_000n, category: 'rent', paidFrom: 'cash', date: '2026-11-18', description: 'إيجار المستودع', ...p,
});

const NOV: ResolvedMonth = { ym: '2026-11', firstDay: '2026-11-01', label: 'نوفمبر 2026' };

// ═══ قيد المصروف ═══

test('مصروف إيجار نقداً: Dr 621004 / Cr 111001 بدفتر الصندوق CSH1، EXPENSE يدوي بلا مصدر ولا مرجع قبل القفل', () => {
  const env = envOf();
  const plan = planOf(buildExpensePlan(env, expense()));
  assert.deepEqual(manualSums(plan.draft, env.lc.ctx), { '621004': [1_500_000n, 0n], '111001': [0n, 1_500_000n] });
  const d = plan.draft;
  assert.equal(plan.kind, 'EXPENSE');
  assert.equal(d.moveType, 'EXPENSE');
  assert.equal(d.origin, 'MANUAL');
  assert.equal(d.journalCode, 'CSH1');
  assert.equal(d.sourceType, null);
  assert.equal(d.sourceKey, null);
  assert.equal(d.sourceEvent, null);
  assert.equal(d.ref, null, 'المرجع يُختار تحت القفل');
  assert.equal(d.date, '2026-11-18');
  assert.equal(d.currencyCode, 'SAR');
  assert.equal(plan.totalMilli, 1_500_000n);
  assert.match(plan.summaryAr, /1,500\.00 SAR/);
  assert.deepEqual(plan.lines.map((l) => l.accountCode), ['621004', '111001']);
  for (const l of d.lines) assert.ok(l.accountId, 'كل سطر بمعرّف حسابه (لا مفتاح يُحلّ لاحقاً)');
});

test('طرق الدفع: البنك ⇒ 111101 بدفتر BNK1، النثريات ⇒ 111002 بدفتر MISC، الآجل ⇒ 213002 بدفتر MISC، ورمز بنك آخر ⇒ دفتره', () => {
  const env = envOf();
  const bank = planOf(buildExpensePlan(env, expense({ paidFrom: 'bank' })));
  assert.deepEqual(manualSums(bank.draft, env.lc.ctx), { '621004': [1_500_000n, 0n], '111101': [0n, 1_500_000n] });
  assert.equal(bank.draft.journalCode, 'BNK1');
  const petty = planOf(buildExpensePlan(env, expense({ paidFrom: 'petty_cash', category: 'hospitality' })));
  assert.deepEqual(manualSums(petty.draft, env.lc.ctx), { '621012': [1_500_000n, 0n], '111002': [0n, 1_500_000n] });
  assert.equal(petty.draft.journalCode, 'MISC');
  assert.equal(petty.draft.journalSystemKey, 'MISC');
  const payable = planOf(buildExpensePlan(env, expense({ paidFrom: 'payable', category: 'utilities', vendorName: 'شركة الكهرباء' })));
  assert.deepEqual(manualSums(payable.draft, env.lc.ctx), { '621006': [1_500_000n, 0n], '213002': [0n, 1_500_000n] });
  assert.equal(payable.draft.journalCode, 'MISC');
  assert.match(payable.draft.narration, /شركة الكهرباء/);
  const rajhi = planOf(buildExpensePlan(env, expense({ paidFrom: 'bank', paidFromAccountCode: '111102' })));
  assert.deepEqual(manualSums(rajhi.draft, env.lc.ctx), { '621004': [1_500_000n, 0n], '111102': [0n, 1_500_000n] });
  assert.equal(rajhi.draft.journalCode, 'BNK2');
});

test('كل تصنيف ⇐ حسابه في القالب، والوقود والرسوم البنكية بمفتاح الربط أولاً (FUEL/BANK_FEES)', () => {
  const env = envOf();
  for (const k of EXPENSE_CATEGORY_KEYS) {
    const plan = planOf(buildExpensePlan(env, expense({ category: k })));
    const sums = manualSums(plan.draft, env.lc.ctx);
    assert.deepEqual(sums[EXPENSE_CATEGORIES[k].code], [1_500_000n, 0n], k);
  }
  // إعادة ربط FUEL إلى 611004 ⇒ الوقود يتبع المفتاح لا الرمز
  const remapped = envOf({ mappings: { FUEL: '611004', BANK_FEES: '621016' } });
  assert.deepEqual(manualSums(planOf(buildExpensePlan(remapped, expense({ category: 'fuel' }))).draft, remapped.lc.ctx)['611004'], [1_500_000n, 0n]);
  assert.deepEqual(manualSums(planOf(buildExpensePlan(remapped, expense({ category: 'bank_fees' }))).draft, remapped.lc.ctx)['621016'], [1_500_000n, 0n]);
  // المفتاح على حساب مؤرشف ⇒ الرمز القالبي
  const archivedKey = envOf({ mappings: { FUEL: '611004' }, accounts: { '611004': { isActive: false } } });
  assert.deepEqual(manualSums(planOf(buildExpensePlan(archivedKey, expense({ category: 'fuel' }))).draft, archivedKey.lc.ctx)['611003'], [1_500_000n, 0n]);
});

test('الضريبة: الشامل 1,150 ⇒ وعاء 1,000 + ضريبة 150 [S15_PURCH، SA_7، BASE/TAX]؛ غير الشامل 1,000 ⇒ إجمالي 1,150؛ والصريحة كما ذُكرت', () => {
  const env = envOf();
  const inc = planOf(buildExpensePlan(env, expense({ amountMilli: 1_150_000n, vat: { included: true } })));
  assert.deepEqual(manualSums(inc.draft, env.lc.ctx), { '621004': [1_000_000n, 0n], '116001': [150_000n, 0n], '111001': [0n, 1_150_000n] });
  const vatLine = inc.draft.lines.find((l) => l.taxRole === 'TAX')!;
  assert.equal(vatLine.taxId, taxIdOf('S15_PURCH'));
  assert.equal(vatLine.vatBox, 'SA_7');
  assert.equal(vatLine.taxBaseMilli, 1_000_000n);
  const baseLine = inc.draft.lines.find((l) => l.taxRole === 'BASE')!;
  assert.equal(baseLine.taxId, taxIdOf('S15_PURCH'));
  assert.equal(inc.totalMilli, 1_150_000n);
  assert.match(inc.summaryAr, /منها ضريبة 150\.00/);

  const exc = planOf(buildExpensePlan(env, expense({ amountMilli: 1_000_000n, vat: { included: false } })));
  assert.deepEqual(manualSums(exc.draft, env.lc.ctx), { '621004': [1_000_000n, 0n], '116001': [150_000n, 0n], '111001': [0n, 1_150_000n] });
  assert.equal(exc.totalMilli, 1_150_000n);

  const explicit = planOf(buildExpensePlan(env, expense({ amountMilli: 1_150_000n, vat: { included: true, amountMilli: 150_000n, rate: 15 } })));
  assert.deepEqual(manualSums(explicit.draft, env.lc.ctx), { '621004': [1_000_000n, 0n], '116001': [150_000n, 0n], '111001': [0n, 1_150_000n] });
  // جزءٌ معفى: ضريبة صريحة أقل من النسبة مقبولة
  const partial = planOf(buildExpensePlan(env, expense({ amountMilli: 1_100_000n, vat: { included: true, amountMilli: 100_000n } })));
  assert.deepEqual(manualSums(partial.draft, env.lc.ctx), { '621004': [1_000_000n, 0n], '116001': [100_000n, 0n], '111001': [0n, 1_100_000n] });
  // منازل الريال والتقريب: 99.99 شاملة ⇒ وعاء 86.95 + 13.04
  const odd = planOf(buildExpensePlan(env, expense({ amountMilli: 99_990n, vat: { included: true } })));
  assert.deepEqual(manualSums(odd.draft, env.lc.ctx), { '621004': [86_950n, 0n], '116001': [13_040n, 0n], '111001': [0n, 99_990n] });
});

test('الضريبة المرفوضة: نسبة لا تطابق، ضريبة صريحة أكبر من نسبتها أو من المبلغ، ولا ضريبة مشتريات بمربّع ⇒ LEDGER_VAT_LINE_UNTAGGED', () => {
  const env = envOf();
  assert.equal(refusalOf(buildExpensePlan(env, expense({ vat: { included: true, rate: 5 } }))).code, 'VAT_RATE_MISMATCH');
  assert.equal(refusalOf(buildExpensePlan(env, expense({ amountMilli: 1_000_000n, vat: { included: true, amountMilli: 500_000n } }))).code, 'VAT_INVALID');
  assert.equal(refusalOf(buildExpensePlan(env, expense({ amountMilli: 1_000_000n, vat: { included: true, amountMilli: 1_000_000n } }))).code, 'VAT_INVALID');
  const untagged = envOf({ taxes: { S15_PURCH: { vatBox: null } } });
  assert.equal(refusalOf(buildExpensePlan(untagged, expense({ vat: { included: true } }))).code, 'LEDGER_VAT_LINE_UNTAGGED');
  const inactive = envOf({ taxes: { S15_PURCH: { isActive: false } } });
  assert.equal(refusalOf(buildExpensePlan(inactive, expense({ vat: { included: false } }))).code, 'LEDGER_VAT_LINE_UNTAGGED');
});

test('الضريبة المُزالة للشركة: لا سطر ضريبة، المبلغ كما ذُكر، وتنبيه للمستخدم', () => {
  const env = envOf({}, { taxDisabled: true });
  const plan = planOf(buildExpensePlan(env, expense({ amountMilli: 1_150_000n, vat: { included: true } })));
  assert.deepEqual(manualSums(plan.draft, env.lc.ctx), { '621004': [1_150_000n, 0n], '111001': [0n, 1_150_000n] });
  assert.ok(plan.draft.lines.every((l) => !l.taxId && !l.taxRole));
  assert.equal(plan.warnings.length, 1);
});

test('المبالغ والدقة: صفر وسالب ومنازل زائدة تُرفض، والدينار بثلاث منازل يُقبل', () => {
  const env = envOf();
  assert.equal(refusalOf(buildExpensePlan(env, expense({ amountMilli: 0n }))).code, 'AMOUNT_INVALID');
  assert.equal(refusalOf(buildExpensePlan(env, expense({ amountMilli: 1_500_005n }))).code, 'AMOUNT_PRECISION');
  const kwd = envOf({ dec: 3 });
  assert.deepEqual(manualSums(planOf(buildExpensePlan(kwd, expense({ amountMilli: 1_500_005n }))).draft, kwd.lc.ctx)['621004'], [1_500_005n, 0n]);
});

// ═══ الرواتب والسداد ═══

test('رواتب المناديب نقداً + تأمينات: Dr 611001 / Cr 111001 و Dr 621002 / Cr 213003 في قيد واحد متّزن', () => {
  const env = envOf();
  const plan = planOf(buildSalariesPlan(env, { month: NOV, amountMilli: 50_000_000n, group: 'reps', paidFrom: 'cash', gosiMilli: 5_000_000n, date: '2026-11-18' }));
  assert.deepEqual(manualSums(plan.draft, env.lc.ctx), {
    '611001': [50_000_000n, 0n], '111001': [0n, 50_000_000n], '621002': [5_000_000n, 0n], '213003': [0n, 5_000_000n],
  });
  assert.equal(plan.kind, 'SALARIES');
  assert.equal(plan.totalMilli, 55_000_000n);
  assert.equal(plan.draft.moveType, 'ENTRY');
  assert.equal(plan.draft.journalCode, 'CSH1');
  assert.match(plan.draft.narration, /نوفمبر 2026/);
});

test('رواتب الإداريين مستحقة: Dr 621001 / Cr 213001 بدفتر MISC؛ والبنك ⇒ BNK1', () => {
  const env = envOf();
  const accrue = planOf(buildSalariesPlan(env, { month: NOV, amountMilli: 20_000_000n, group: 'admin', paidFrom: 'accrue', date: '2026-11-30' }));
  assert.deepEqual(manualSums(accrue.draft, env.lc.ctx), { '621001': [20_000_000n, 0n], '213001': [0n, 20_000_000n] });
  assert.equal(accrue.draft.journalCode, 'MISC');
  const bank = planOf(buildSalariesPlan(env, { month: NOV, amountMilli: 20_000_000n, group: 'admin', paidFrom: 'bank', date: '2026-11-18' }));
  assert.deepEqual(manualSums(bank.draft, env.lc.ctx), { '621001': [20_000_000n, 0n], '111101': [0n, 20_000_000n] });
  assert.equal(bank.draft.journalCode, 'BNK1');
});

test('سداد رواتب مستحقة: Dr 213001 / Cr 111101 بفحص رصيد الالتزام', () => {
  const env = envOf();
  const plan = planOf(buildSettlePlan(env, { amountMilli: 30_000_000n, paidFrom: 'bank', month: NOV, date: '2026-11-18' }));
  assert.deepEqual(manualSums(plan.draft, env.lc.ctx), { '213001': [30_000_000n, 0n], '111101': [0n, 30_000_000n] });
  assert.equal(plan.kind, 'SALARIES_SETTLE');
  assert.deepEqual(plan.payableCheck, { accountId: accountIdOf('213001'), accountName: 'رواتب وأجور مستحقة', amountMilli: 30_000_000n });
  assert.equal(plan.draft.journalCode, 'BNK1');
});

test('شهر الرواتب: «11» = الشهر الحالي، «12» في يناير = ديسمبر الماضي، والمستقبل والصيغة الخاطئة تُرفض؛ وتاريخ الاستحقاق آخر الشهر', () => {
  assert.deepEqual(resolveSalaryMonth('11', '2026-11-18'), { ym: '2026-11', firstDay: '2026-11-01', label: 'نوفمبر 2026' });
  assert.deepEqual(resolveSalaryMonth('١١', '2026-11-18'), { ym: '2026-11', firstDay: '2026-11-01', label: 'نوفمبر 2026' });
  assert.equal((resolveSalaryMonth('12', '2026-01-05') as ResolvedMonth).ym, '2025-12');
  assert.equal((resolveSalaryMonth('10/2026', '2026-11-18') as ResolvedMonth).ym, '2026-10');
  assert.equal((resolveSalaryMonth('2026-10-31', '2026-11-18') as ResolvedMonth).ym, '2026-10');
  assert.equal((resolveSalaryMonth('2026-12', '2026-11-18') as AiRefusal).code, 'MONTH_FUTURE');
  assert.equal((resolveSalaryMonth('13', '2026-11-18') as AiRefusal).code, 'MONTH_INVALID');
  assert.equal((resolveSalaryMonth('نوفمبر', '2026-11-18') as AiRefusal).code, 'MONTH_INVALID');
  const oct: ResolvedMonth = { ym: '2026-10', firstDay: '2026-10-01', label: 'أكتوبر 2026' };
  assert.equal(salariesDate(oct, 'accrue', null, '2026-11-02'), '2026-10-31');
  assert.equal(salariesDate(oct, 'bank', null, '2026-11-02'), '2026-11-02');
  assert.equal(salariesDate(NOV, 'accrue', null, '2026-11-18'), '2026-11-18');
  assert.equal(salariesDate(oct, 'accrue', '2026-11-01', '2026-11-02'), '2026-11-01');
});

test('تاريخ القيد: لا مستقبل، ولا أقدم من سنة، ولا صيغة خاطئة', () => {
  assert.equal(postingDateProblem('2026-11-18', '2026-11-18'), null);
  assert.equal(postingDateProblem('2026-11-19', '2026-11-18')?.code, 'DATE_FUTURE');
  assert.equal(postingDateProblem('2025-11-01', '2026-11-18')?.code, 'DATE_TOO_OLD');
  assert.equal(postingDateProblem('18/11/2026', '2026-11-18')?.code, 'DATE_INVALID');
  assert.equal(postingDateProblem('2026-02-30', '2026-11-18')?.code, 'DATE_INVALID');
});

// ═══ حارس المبلغ ═══

test('حارس المبلغ: الأرقام الهندية والفاصلة العربية «٫» وفواصل الآلاف «٬» و«,» و«،» تُوحَّد؛ والمسافة والمبلغ الغائب لا', () => {
  assert.equal(normalizeAmountText('دفعنا ١٬٥٠٠ ريال'), 'دفعنا 1500 ريال');
  assert.ok(amountInUserText(1_500_000n, 'دفعنا ١٬٥٠٠ ريال إيجار نقداً'));
  assert.ok(amountInUserText(1_500_000n, 'دفعنا 1,500 ريال'));
  assert.ok(amountInUserText(1_500_000n, 'دفعنا ۱۵۰۰ ريال'));
  assert.ok(amountInUserText(1_500_000n, 'دفعنا 1،500 ريال'));
  assert.ok(amountInUserText(1_500_500n, 'المبلغ ١٥٠٠٫٥ ريال'));
  assert.ok(amountInUserText(1_500_500n, 'المبلغ 1,500.50'));
  assert.ok(amountInUserText(1_250_000_000n, 'رواتب 1,250,000 ريال'));
  assert.ok(amountInUserText(1_500_000n, 'دفعنا 1500ريال'));
  assert.ok(!amountInUserText(1_500_000n, 'دفعنا 1 500 ريال'), 'المسافة فاصلاً لا تُخمَّن');
  assert.ok(!amountInUserText(2_000_000n, 'دفعنا 1500 ريال إيجار'));
  assert.ok(!amountInUserText(1_500_000n, 'دفعنا ألف وخمسمية'), 'الأعداد بالكلمات تُسأل بالأرقام');
  assert.ok(!amountInUserText(1_500_000n, ''));
  // «500، 1000» قائمة لا ألف وخمسمية
  assert.deepEqual(amountsInText('دفعنا 500، 1000 للكهرباء'), [500_000n, 1_000_000n]);
  assert.equal(parseAmountArg('١٬٥٠٠'), 1_500_000n);
  assert.equal(parseAmountArg(1500.5), 1_500_500n);
  assert.equal(parseAmountArg('1,500.50'), 1_500_500n);
  assert.equal(parseAmountArg(-5), null);
  assert.equal(parseAmountArg(0), null);
  assert.equal(parseAmountArg('abc'), null);
  assert.equal(parseAmountArg(Number.NaN), null);
  assert.equal(parseAmountArg(1e21), null);
  const r = amountGuardRefusal([{ milli: 1_500_000n, what: 'مبلغ المصروف' }, { milli: 225_000n, what: 'مبلغ الضريبة' }], 'دفعنا 1500 إيجار شامل الضريبة');
  assert.equal(r?.code, 'AMOUNT_NOT_IN_MESSAGE');
  assert.match(r!.message, /مبلغ الضريبة/);
  assert.doesNotMatch(r!.message, /225/, 'المبلغ المرفوض لا يُعاد في الرسالة (فلا يصير «مسموحاً» للحارس)');
  assert.equal(amountGuardRefusal([{ milli: 1_500_000n, what: 'مبلغ المصروف' }], 'دفعنا ١٥٠٠ إيجار'), null);
});

// ═══ الحسابات المرفوضة والغائبة ═══

test('الحساب الرقابي والعهدة مرفوضة: ذمم العملاء/الموردين/المخزون مصروفاً، و111003/111004 مصدر دفع، والإيراد والإهلاك', () => {
  const env = envOf();
  for (const code of ['113001', '211001', '114001', '112005']) {
    const r = refusalOf(buildExpensePlan(env, expense({ category: null, accountCode: code })));
    assert.equal(r.code, 'ACCOUNT_NOT_ALLOWED', code);
    assert.ok(Array.isArray(r.details?.candidates) && (r.details!.candidates as unknown[]).length > 0, code);
  }
  for (const code of ['111003', '111004']) {
    const r = refusalOf(buildExpensePlan(env, expense({ paidFrom: 'cash', paidFromAccountCode: code })));
    assert.equal(r.code, 'ACCOUNT_NOT_ALLOWED', code);
    assert.equal(r.details?.problem, 'CUSTODY', code);
    const cands = (r.details?.candidates as { code: string }[]).map((c) => c.code);
    assert.ok(!cands.includes('111003') && !cands.includes('111004'), 'العهد ليست مرشّحة');
    assert.ok(cands.includes('111001') && cands.includes('111101') && cands.includes('111102'));
  }
  assert.equal(refusalOf(buildExpensePlan(env, expense({ category: null, accountCode: '411001' }))).details?.problem, 'WRONG_TYPE');
  for (const code of ['631001', '721001', '511001', '513001', '514002', '711003', '711005', '711006', '621003']) {
    assert.equal(refusalOf(buildExpensePlan(env, expense({ category: null, accountCode: code }))).details?.problem, 'REFERRED', code);
  }
  // المفتاح يعلو على الرمز: BAD_DEBT أُعيد ربطه إلى 711007 ⇒ الغرامات صارت «للمحاسب البشري» و711005 مقبول
  const rebound = envOf({ mappings: { BAD_DEBT: '711007' } });
  assert.equal(refusalOf(buildExpensePlan(rebound, expense({ category: null, accountCode: '711007' }))).details?.problem, 'REFERRED');
  assert.ok(buildExpensePlan(rebound, expense({ category: null, accountCode: '711005' })).ok);
  assert.ok(buildExpensePlan(env, expense({ category: null, accountCode: '711001' })).ok, 'فوائد بنكية تُدفع نقداً');
  assert.equal(refusalOf(buildExpensePlan(env, expense({ paidFrom: 'cash', paidFromAccountCode: '112004' }))).details?.problem, 'WRONG_TYPE');
  // رمز مصروف صالح يُقبل؛ والتكلفة المباشرة يدوية فقط في غير المربوطة
  assert.deepEqual(manualSums(planOf(buildExpensePlan(env, expense({ category: null, accountCode: '621018' }))).draft, env.lc.ctx)['621018'], [1_500_000n, 0n]);
  assert.ok(buildExpensePlan(env, expense({ category: null, accountCode: '512003' })).ok);
  const linked = envOf({}, { booksMode: 'LINKED' });
  assert.equal(refusalOf(buildExpensePlan(linked, expense({ category: null, accountCode: '512003' }))).details?.problem, 'LINKED_COST');
  // المرشّحون: مصروفات صالحة وحدها
  for (const c of expenseCandidates(env.lc, 'MANUAL')) assert.match(c.code, /^[567]/);
  for (const code of ['631001', '711005', '711006', '511001', '721001', '611001']) {
    if (code === '611001') assert.ok(expenseCandidates(env.lc, 'MANUAL').some((c) => c.code === code));
    else assert.ok(!expenseCandidates(env.lc, 'MANUAL').some((c) => c.code === code), code);
  }
  assert.ok(!cashCandidates(env.lc).some((c) => c.code === '111003' || c.code === '111004'));
});

test('الحساب الغائب: رسالة تطلب الاختيار بقائمة مرشّحين، والمؤرشف ACCOUNT_NOT_ALLOWED، والالتزام الغائب يطلب إنشاءه', () => {
  const missing = envOf({ accounts: { '621004': null } });
  const r = refusalOf(buildExpensePlan(missing, expense()));
  assert.equal(r.code, 'ACCOUNT_MISSING');
  assert.match(r.message, /الإيجار/);
  assert.match(r.message, /621004/);
  const cands = r.details?.candidates as { code: string; name: string }[];
  assert.ok(cands.some((c) => c.code === '621016'));
  assert.ok(!cands.some((c) => c.code === '621004'));
  const archived = refusalOf(buildExpensePlan(envOf({ accounts: { '621004': { isActive: false } } }), expense()));
  assert.equal(archived.code, 'ACCOUNT_NOT_ALLOWED');
  assert.equal(archived.details?.problem, 'ARCHIVED');
  assert.equal(refusalOf(buildExpensePlan(missing, expense({ category: null, accountCode: null }))).code, 'ACCOUNT_MISSING');
  const noPayable = envOf({ accounts: { '213001': null } });
  const s = refusalOf(buildSalariesPlan(noPayable, { month: NOV, amountMilli: 1_000_000n, group: 'admin', paidFrom: 'accrue', date: '2026-11-18' }));
  assert.equal(s.code, 'ACCOUNT_MISSING');
  assert.match(s.message, /213001/);
  assert.equal(refusalOf(buildSettlePlan(noPayable, { amountMilli: 1_000_000n, paidFrom: 'cash', date: '2026-11-18' })).code, 'ACCOUNT_MISSING');
  const noGosi = envOf({ accounts: { '213003': null } });
  assert.equal(refusalOf(buildSalariesPlan(noGosi, { month: NOV, amountMilli: 1_000_000n, group: 'reps', paidFrom: 'cash', gosiMilli: 100_000n, date: '2026-11-18' })).code, 'ACCOUNT_MISSING');
  // بلا تأمينات لا يُطلب حسابها
  assert.ok(buildSalariesPlan(noGosi, { month: NOV, amountMilli: 1_000_000n, group: 'reps', paidFrom: 'cash', date: '2026-11-18' }).ok);
});

test('حساب الدفع: المفتاح ثم الرمز ثم الحساب الافتراضي لدفتر CSH1/BNK1، والدفتر: النقد ثم MISC ثم EXP', () => {
  const noKey = envOf({ mappings: { MAIN_CASH: null } });
  assert.deepEqual(manualSums(planOf(buildExpensePlan(noKey, expense())).draft, noKey.lc.ctx)['111001'], [0n, 1_500_000n]);
  const viaJournal = envOf({ mappings: { MAIN_CASH: null }, accounts: { '111001': null }, journals: { CSH1: { defaultAccountId: SAFE2.id } } });
  const p = planOf(buildExpensePlan(viaJournal, expense()));
  assert.deepEqual(manualSums(p.draft, viaJournal.lc.ctx)['111009'], [0n, 1_500_000n]);
  assert.equal(p.draft.journalCode, 'CSH1');
  const none = envOf({ mappings: { MAIN_CASH: null }, accounts: { '111001': null } });
  const r = refusalOf(buildExpensePlan(none, expense()));
  assert.equal(r.code, 'ACCOUNT_MISSING');
  const noMisc = envOf({ journals: { MISC: null } });
  assert.equal(planOf(buildExpensePlan(noMisc, expense({ paidFrom: 'petty_cash' }))).draft.journalCode, 'EXP');
  const noJournals = envOf({ journals: { MISC: null, EXP: null } });
  assert.equal(refusalOf(buildExpensePlan(noJournals, expense({ paidFrom: 'petty_cash' }))).code, 'JOURNAL_MISSING');
  // دفتر الصندوق المؤرشف ⇒ MISC لا دفتر مؤرشف
  const archivedJ = envOf({ journals: { CSH1: { isActive: false } } });
  assert.equal(planOf(buildExpensePlan(archivedJ, expense())).draft.journalCode, 'MISC');
});

// ═══ عدم التكرار ═══

const CLIENT = '6f1c2b1e-0000-4000-8000-000000000001';

test('اختيار المرجع: الحرّ الأول، وما استعملته الدورة يُتخطّى، والمطابق بصمةً يُعاد، والمختلف يُتخطّى، والحدّ', () => {
  const plan = planOf(buildExpensePlan(envOf(), expense()));
  const lines = plan.lines.map((l) => ({ accountId: l.accountId, debitMilli: l.debitMilli, creditMilli: l.creditMilli }));
  assert.deepEqual(chooseAiRef(CLIENT, [], [], [], plan), { kind: 'new', ref: `AI-${CLIENT}-1` });
  assert.deepEqual(chooseAiRef(CLIENT, [aiRefOf(CLIENT, 1)], [], [], plan), { kind: 'new', ref: `AI-${CLIENT}-2` });
  const r1 = aiRefOf(CLIENT, 1);
  assert.deepEqual(
    chooseAiRef(CLIENT, [], [{ id: 'm1', ref: r1, lines: [...lines].reverse() }], [{ ref: r1, kind: 'EXPENSE', moveId: 'm1' }], plan),
    { kind: 'replay', ref: r1, moveId: 'm1' },
  );
  const other = [{ accountId: accountIdOf('621006'), debitMilli: 1_500_000n, creditMilli: 0n }, lines[1]];
  assert.deepEqual(
    chooseAiRef(CLIENT, [], [{ id: 'm1', ref: r1, lines: other }], [{ ref: r1, kind: 'EXPENSE', moveId: 'm1' }], plan),
    { kind: 'new', ref: aiRefOf(CLIENT, 2) },
  );
  assert.deepEqual(
    chooseAiRef(CLIENT, [], [{ id: 'm1', ref: r1, lines }], [{ ref: r1, kind: 'SALARIES', moveId: 'm1' }], plan),
    { kind: 'new', ref: aiRefOf(CLIENT, 2) },
  );
  // قيدٌ بالمرجع بلا صفّه (لا يحدث عادةً) يُعدّ مأخوذاً
  assert.deepEqual(chooseAiRef(CLIENT, [], [{ id: 'mX', ref: r1, lines }], [], plan), { kind: 'new', ref: aiRefOf(CLIENT, 2) });
  const all = Array.from({ length: MAX_POSTS_PER_REQUEST }, (_, i) => aiRefOf(CLIENT, i + 1));
  assert.deepEqual(chooseAiRef(CLIENT, all, [], [], plan), { kind: 'none' });
  assert.equal(linesFingerprint('EXPENSE', lines), linesFingerprint('EXPENSE', [...lines].reverse()));
  assert.notEqual(linesFingerprint('EXPENSE', lines), linesFingerprint('SALARIES', lines));
});

// ═══ التنفيذ بمعاملة مزيّفة ═══

interface StoreMove { id: string; tenantId: string; ref: string | null; reversedMoveId: string | null; state: string; lines: { accountId: string; debitMilli: bigint; creditMilli: bigint }[] }

/**
 * مخزن مزيّف للمعاملة: balance = رصيدٌ دائن افتتاحي لكل التزام (أو لكل حسابٍ بعينه في balances)، ويُضاف إليه أثر القيود
 * المرحّلة في المخزن نفسه — فإعادة سدادٍ بعد ترحيله ترى الرصيد المصفَّر كما في القاعدة.
 */
function store(o: { lc?: LedgerContext; balance?: bigint; balances?: Record<string, bigint>; postError?: unknown } = {}) {
  const lc = o.lc ?? ledgerContext();
  const log: string[] = [];
  const moves: StoreMove[] = [];
  const rows: (AiPostRow & { tenantId: string })[] = [];
  const posts: { draft: MoveDraft; opts: PostMoveOptions }[] = [];
  let clock = Date.parse('2026-11-18T10:00:00Z');
  type MoveWhere = { tenantId: string; ref?: { in: string[] }; reversedMoveId?: null | { in: string[] }; id?: { in: string[] }; state?: string };
  type RowWhere = {
    tenantId: string; ref?: { in: string[] }; adminId?: string; kind?: string; createdAt?: { gte: Date };
    summaryAr?: { startsWith: string }; NOT?: { ref: { startsWith: string } };
  };
  const tx = {
    glMove: {
      findMany: async (a: { where: MoveWhere }) => {
        const w = a.where;
        if (w.ref) {
          log.push('moves');
          assert.equal(w.reversedMoveId, null, 'القيود العكسية (بالمرجع نفسه) مستبعدة');
          return moves.filter((m) => m.tenantId === w.tenantId && m.ref !== null && w.ref!.in.includes(m.ref) && m.reversedMoveId === null)
            .map((m) => ({ id: m.id, ref: m.ref, lines: m.lines }));
        }
        if (w.id) {
          log.push('live');
          return moves.filter((m) => m.tenantId === w.tenantId && w.id!.in.includes(m.id) && (!w.state || m.state === w.state))
            .map((m) => ({ id: m.id, lines: m.lines }));
        }
        const rev = w.reversedMoveId as { in: string[] };
        return moves.filter((m) => m.tenantId === w.tenantId && m.reversedMoveId !== null && rev.in.includes(m.reversedMoveId))
          .map((m) => ({ reversedMoveId: m.reversedMoveId }));
      },
      findFirst: async (a: { where: { tenantId: string; reversedMoveId: string } }) =>
        moves.find((m) => m.tenantId === a.where.tenantId && m.reversedMoveId === a.where.reversedMoveId) ?? null,
    },
    aiAccountantPost: {
      findMany: async (a: { where: RowWhere }) => {
        const w = a.where;
        log.push(w.ref ? 'rows' : w.summaryAr ? 'accruals' : 'recent');
        return rows.filter((r) => r.tenantId === w.tenantId
          && (!w.ref || w.ref.in.includes(r.ref))
          && (!w.adminId || r.adminId === w.adminId)
          && (!w.kind || r.kind === w.kind)
          && (!w.createdAt || r.createdAt >= w.createdAt.gte)
          && (!w.summaryAr || r.summaryAr.startsWith(w.summaryAr.startsWith))
          && (!w.NOT || !r.ref.startsWith(w.NOT.ref.startsWith)));
      },
      create: async (a: { data: Omit<AiPostRow, 'id' | 'createdAt'> & { tenantId: string } }) => {
        log.push('row');
        const r = { id: `ap${rows.length + 1}`, createdAt: new Date(clock), ...a.data };
        clock += 60_000;
        rows.push(r);
        return r;
      },
    },
    glMoveLine: {
      aggregate: async (a: { where: { tenantId: string; accountId: string; posted: true } }) => {
        log.push(`balance:${a.where.accountId}`);
        const code = [...lc.accountById.values()].find((x) => x.id === a.where.accountId)?.code ?? '';
        let credit = o.balances?.[code] ?? o.balance ?? 0n;
        let debit = 0n;
        for (const m of moves) {
          if (m.tenantId !== a.where.tenantId || m.state !== 'POSTED') continue;
          for (const l of m.lines) if (l.accountId === a.where.accountId) { debit += l.debitMilli; credit += l.creditMilli; }
        }
        return { _sum: { debitMilli: debit, creditMilli: credit } };
      },
    },
  } as unknown as GlDb;
  const deps: AiPostDeps = {
    acquirePostLock: async () => { log.push('lock'); },
    loadBuildContext: async () => { log.push('context'); return lc; },
    postMove: (async (_tx: GlDb, draft: MoveDraft, opts: PostMoveOptions) => {
      // كما postMove: التحقق اليدوي (I4) والإقفال يرميان قبل أي كتابة
      validateMove(draft, lc.ctx, { mode: 'MANUAL' });
      if (o.postError) throw o.postError;
      log.push('post');
      posts.push({ draft, opts });
      const id = `mv${posts.length}`;
      moves.push({
        id, tenantId: opts.tenantId, ref: draft.ref ?? null, reversedMoveId: null, state: 'POSTED',
        lines: draft.lines.map((l) => ({ accountId: resolveLineAccount(l, lc.ctx.accounts)!.id, debitMilli: l.debitMilli, creditMilli: l.creditMilli })),
      });
      return { id, number: `CSH1/2026/0000${posts.length}`, date: draft.date } as GlPostedMove;
    }) as unknown as AiPostDeps['postMove'],
  };
  return { lc, tx, deps, log, moves, rows, posts };
}

const ACTOR = { actorType: 'ADMIN' as const, actorId: 'a1', actorName: 'المحاسب الذكي بطلب سارة', impersonated: false };

const request = (build: (lc: LedgerContext) => PlanOutcome, p: Partial<Parameters<typeof executeAiPost>[1]> = {}) => ({
  tenantId: 't1', actor: ACTOR, adminId: 'a1', adminName: 'سارة', clientRef: CLIENT, usedRefs: [] as string[], build, ...p,
});
const buildRent = (lc: LedgerContext) => buildExpensePlan({ lc, booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false }, expense());

test('executeAiPost: القفل ⇒ السياق ⇒ البحث بالمرجع ⇒ postMove (MANUAL، REJECT، EXPENSE_AI_POST) ⇒ صفّ AiAccountantPost', async () => {
  const s = store();
  const r = await executeAiPost(s.tx, request(buildRent), s.deps);
  assert.deepEqual(s.log, ['lock', 'context', 'moves', 'rows', 'post', 'row']);
  assert.equal(r.replayed, false);
  const { draft, opts } = s.posts[0];
  assert.equal(draft.ref, `AI-${CLIENT}-1`);
  assert.equal(draft.sourceType, null);
  assert.equal(draft.sourceKey, null);
  assert.equal(opts.tenantId, 't1');
  assert.equal(opts.validationMode, 'MANUAL');
  assert.equal(opts.lockPolicy, 'REJECT');
  assert.equal(opts.auditAction, AI_POST_AUDIT_ACTION);
  assert.equal(AI_POST_AUDIT_ACTION, 'EXPENSE_AI_POST');
  assert.deepEqual(opts.auditExtra, { aiAccountant: true, clientRef: CLIENT, ref: `AI-${CLIENT}-1`, kind: 'EXPENSE' });
  assert.equal(opts.actor, ACTOR);
  assert.equal(opts.context, s.lc);
  assert.equal(opts.createSource, undefined, 'لا GlMoveSource');
  const row = s.rows[0];
  assert.equal(row.tenantId, 't1');
  assert.equal(row.adminId, 'a1');
  assert.equal(row.moveId, 'mv1');
  assert.equal(row.moveNumber, 'CSH1/2026/00001');
  assert.equal(row.kind, 'EXPENSE');
  assert.equal(row.amountMilli, 1_500_000n);
  assert.equal(row.dateLocal, '2026-11-18');
  const m = r.move;
  assert.deepEqual(
    { id: m.id, moveId: m.moveId, moveNumber: m.moveNumber, ref: m.ref, kind: m.kind, amount: m.amount, date: m.date, reversed: m.reversed, adminName: m.adminName },
    { id: 'ap1', moveId: 'mv1', moveNumber: 'CSH1/2026/00001', ref: `AI-${CLIENT}-1`, kind: 'EXPENSE', amount: 1500, date: '2026-11-18', reversed: false, adminName: 'سارة' },
  );
  assert.deepEqual(m.lines, [
    { accountCode: '621004', accountName: 'الإيجار', debit: 1500, credit: 0 },
    { accountCode: '111001', accountName: 'الصندوق الرئيسي', debit: 0, credit: 1500 },
  ]);
  assert.equal(m.createdAt, '2026-11-18T10:00:00.000Z');
});

test('عدم التكرار: إعادة إرسال الطلب نفسه (clientRef نفسه) تعيد القيد بلا ترحيل ثانٍ؛ وطلبٌ ثانٍ في الدورة يأخذ -2', async () => {
  const s = store();
  const first = await executeAiPost(s.tx, request(buildRent), s.deps);
  const again = await executeAiPost(s.tx, request(buildRent), s.deps);
  assert.equal(s.posts.length, 1, 'لا قيد ثانٍ');
  assert.equal(again.replayed, true);
  assert.equal(again.move.id, first.move.id);
  assert.equal(again.move.moveId, 'mv1');
  assert.deepEqual(again.move.lines, first.move.lines);
  // داخل الدورة نفسها: المرجع المستعمل يُتخطّى فيُرحَّل طلبٌ مماثل ثانٍ بـ-2
  const second = await executeAiPost(s.tx, request(buildRent, { usedRefs: [first.move.ref] }), s.deps);
  assert.equal(second.replayed, false);
  assert.equal(second.move.ref, `AI-${CLIENT}-2`);
  assert.equal(s.posts.length, 2);
  // قيدٌ معكوس يُعاد بعلامته
  s.moves.push({ id: 'rv1', tenantId: 't1', ref: `AI-${CLIENT}-1`, reversedMoveId: 'mv1', state: 'POSTED', lines: [] });
  const replayReversed = await executeAiPost(s.tx, request(buildRent), s.deps);
  assert.equal(replayReversed.replayed, true);
  assert.equal(replayReversed.move.reversed, true);
  // شركة أخرى بالمرجع نفسه لا تُرى
  const other = await executeAiPost(s.tx, request(buildRent, { tenantId: 't2' }), s.deps);
  assert.equal(other.replayed, false);
  assert.equal(s.rows[s.rows.length - 1].tenantId, 't2');
});

test('الرفض داخل المعاملة يُرمى قبل الترحيل: حساب غائب، رصيد مستحق أقل، فترة مقفلة (أول تاريخ مفتوح)', async () => {
  const missing = store({ lc: ledgerContext({ accounts: { '621004': null } }) });
  await assert.rejects(executeAiPost(missing.tx, request(buildRent), missing.deps), (e: unknown) => e instanceof AiPostRefusal && e.refusal.code === 'ACCOUNT_MISSING');
  assert.deepEqual(missing.log, ['lock', 'context']);

  const settle = (lc: LedgerContext) => buildSettlePlan({ lc, booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false }, { amountMilli: 30_000_000n, paidFrom: 'cash', date: '2026-11-18' });
  const low = store({ balance: 10_000_000n });
  await assert.rejects(executeAiPost(low.tx, request(settle), low.deps), (e: unknown) => {
    assert.ok(e instanceof AiPostRefusal);
    assert.equal(e.refusal.code, 'EXCEEDS_PAYABLE');
    assert.equal(e.refusal.details?.balance, 10000);
    assert.match(e.refusal.message, /10,000\.00/);
    return true;
  });
  assert.equal(low.posts.length, 0);
  const enough = store({ balance: 30_000_000n });
  const ok = await executeAiPost(enough.tx, request(settle), enough.deps);
  assert.equal(ok.move.kind, 'SALARIES_SETTLE');
  assert.ok(enough.log.includes(`balance:${accountIdOf('213001')}`));

  const locked = store({ postError: new LedgerError('LEDGER_PERIOD_LOCKED', { date: '2026-10-15', lockDate: '2026-10-31', firstOpenDate: '2026-11-01' }) });
  await assert.rejects(executeAiPost(locked.tx, request(buildRent), locked.deps), (e: unknown) => {
    const r = refusalFromError(e);
    assert.equal(r.code, 'LEDGER_PERIOD_LOCKED');
    assert.match(r.message, /2026-11-01/);
    assert.equal(r.details?.firstOpenDate, '2026-11-01');
    return true;
  });
  assert.equal(locked.rows.length, 0, 'لا صفّ بلا قيده');
  assert.equal(refusalFromError(new Error('boom')).code, 'POST_FAILED');
  assert.equal(refusalFromError(new LedgerError('LEDGER_UNBALANCED', {})).code, 'LEDGER_ERROR');
});

const OTHER = '6f1c2b1e-0000-4000-8000-0000000000b2';
const settleOf = (amountMilli: bigint, payable: 'salaries' | 'gosi' | 'accrued_expenses' = 'salaries') => (lc: LedgerContext) =>
  buildSettlePlan({ lc, booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false }, { amountMilli, payable, paidFrom: 'bank', date: '2026-11-18' });

test('إعادة إرسال السداد بعد ترحيله (انقطع الرد ثم «إعادة المحاولة»): يُعاد القيد نفسه قبل فحص الرصيد الذي صفّره — والجزئي كذلك', async () => {
  const s = store({ balance: 10_000_000n });
  const first = await executeAiPost(s.tx, request(settleOf(10_000_000n)), s.deps);
  assert.equal(first.replayed, false);
  const again = await executeAiPost(s.tx, request(settleOf(10_000_000n)), s.deps);
  assert.equal(again.replayed, true, 'لا EXCEEDS_PAYABLE: القيد موجود');
  assert.equal(again.move.id, first.move.id);
  assert.equal(s.posts.length, 1);
  // الإعادة لا تقرأ الرصيد أصلاً: البحث بالمرجع أولاً
  const tail = s.log.slice(s.log.lastIndexOf('context'));
  assert.deepEqual(tail, ['context', 'moves', 'rows']);
  // طلبٌ جديد (clientRef آخر) بالمبلغ نفسه يُرفض: الرصيد صار صفراً
  await assert.rejects(executeAiPost(s.tx, request(settleOf(10_000_000n), { clientRef: OTHER }), s.deps),
    (e: unknown) => e instanceof AiPostRefusal && e.refusal.code === 'EXCEEDS_PAYABLE');
  // جزئي: 6,000 من 10,000 ثم الإعادة (6,000 > الباقي 4,000) ⇒ إعادة لا رفض
  const p = store({ balance: 10_000_000n });
  await executeAiPost(p.tx, request(settleOf(6_000_000n)), p.deps);
  const retry = await executeAiPost(p.tx, request(settleOf(6_000_000n)), p.deps);
  assert.equal(retry.replayed, true);
  assert.equal(p.posts.length, 1);
});

test('سداد المستحقات كلها: التأمينات Dr 213003 والمصروفات الآجلة Dr 213002 / Cr البنك، بحدّ رصيد كلٍّ منها وإرشادٍ يخصّه', async () => {
  const env = envOf();
  const gosi = planOf(buildSettlePlan(env, { amountMilli: 2_000_000n, payable: 'gosi', paidFrom: 'bank', month: NOV, date: '2026-11-18' }));
  assert.deepEqual(manualSums(gosi.draft, env.lc.ctx), { '213003': [2_000_000n, 0n], '111101': [0n, 2_000_000n] });
  assert.equal(gosi.kind, 'SALARIES_SETTLE');
  assert.match(gosi.summaryAr, /سداد التأمينات الاجتماعية المستحقة لشهر نوفمبر 2026/);
  assert.equal(gosi.payableCheck?.accountId, accountIdOf('213003'));
  assert.ok(gosi.payableCheck?.hint);
  const acc = planOf(buildSettlePlan(env, { amountMilli: 500_000n, payable: 'accrued_expenses', paidFrom: 'cash', month: NOV, note: 'فاتورة الكهرباء', date: '2026-11-18' }));
  assert.deepEqual(manualSums(acc.draft, env.lc.ctx), { '213002': [500_000n, 0n], '111001': [0n, 500_000n] });
  assert.match(acc.summaryAr, /^سداد مصروفات مستحقة — فاتورة الكهرباء:/, 'لا شهر للمصروفات الآجلة، والوصف يُذكر');
  // الرصيد لكل التزامٍ بحسابه: 213002 بلا رصيد ⇒ رفض بإرشاد «سجّله مصروفاً عادياً»
  const s = store({ balances: { '213001': 50_000_000n, '213003': 2_000_000n } });
  await assert.rejects(executeAiPost(s.tx, request(settleOf(500_000n, 'accrued_expenses')), s.deps), (e: unknown) => {
    assert.ok(e instanceof AiPostRefusal);
    assert.equal(e.refusal.code, 'EXCEEDS_PAYABLE');
    assert.match(e.refusal.message, /مصروفاً عادياً/);
    return true;
  });
  assert.ok(s.log.includes(`balance:${accountIdOf('213002')}`));
  const ok = await executeAiPost(s.tx, request(settleOf(2_000_000n, 'gosi'), { clientRef: OTHER }), s.deps);
  assert.equal(ok.move.lines[0].accountCode, '213003');
});

test('التأمينات مصروفاً والتزامها 213003 قائم ⇒ PAYABLE_OUTSTANDING (سدادٌ لا مصروف)، وبلا رصيد تُرحَّل مصروفاً', async () => {
  const gosiExpense = (lc: LedgerContext) => buildExpensePlan({ lc, booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false },
    expense({ category: null, accountCode: '621002', amountMilli: 2_000_000n, paidFrom: 'bank', description: 'التأمينات' }));
  const owed = store({ balances: { '213003': 2_000_000n } });
  await assert.rejects(executeAiPost(owed.tx, request(gosiExpense), owed.deps), (e: unknown) => {
    assert.ok(e instanceof AiPostRefusal);
    assert.equal(e.refusal.code, 'PAYABLE_OUTSTANDING');
    assert.match(e.refusal.message, /سداد التأمينات المستحقة/);
    return true;
  });
  assert.equal(owed.posts.length, 0);
  const clear = store();
  const r = await executeAiPost(clear.tx, request(gosiExpense), clear.deps);
  assert.equal(r.move.lines[0].accountCode, '621002');
  // مصروفٌ غير التأمينات لا يُفحص به التزام
  const rent = store({ balances: { '213003': 2_000_000n } });
  await executeAiPost(rent.tx, request(buildRent), rent.deps);
  assert.ok(!rent.log.some((l) => l.startsWith('balance:')));
});

test('رواتب شهرٍ مسجّلة مستحقة ثم «صرفناها» نقداً/بنكاً ⇒ SALARIES_ALREADY_ACCRUED لا مصروفٌ ثانٍ؛ والتأكيد يُسقط فحص الرصيد وحده', async () => {
  const OCT: ResolvedMonth = { ym: '2026-10', firstDay: '2026-10-01', label: 'أكتوبر 2026' };
  const salaries = (paidFrom: 'bank' | 'accrue', o: { group?: 'reps' | 'admin'; month?: ResolvedMonth; confirmed?: boolean; amount?: bigint } = {}) => (lc: LedgerContext) =>
    buildSalariesPlan({ lc, booksMode: 'MANUAL', currency: 'SAR', taxDisabled: false }, {
      month: o.month ?? OCT, amountMilli: o.amount ?? 45_000_000n, group: o.group ?? 'reps', paidFrom, date: paidFrom === 'accrue' ? '2026-10-31' : '2026-11-05',
      confirmedNotAccrued: o.confirmed,
    });
  const s = store();
  // ٣١ أكتوبر: الاستحقاق بطلبٍ أول
  await executeAiPost(s.tx, request(salaries('accrue')), s.deps);
  // ٥ نوفمبر محادثة جديدة: «صرفنا رواتب المناديب لشهر 10 بمبلغ 45000 تحويل بنكي»
  await assert.rejects(executeAiPost(s.tx, request(salaries('bank'), { clientRef: OTHER }), s.deps), (e: unknown) => {
    assert.ok(e instanceof AiPostRefusal);
    assert.equal(e.refusal.code, 'SALARIES_ALREADY_ACCRUED');
    assert.match(e.refusal.message, /سداد الرواتب المستحقة/);
    assert.equal(e.refusal.details?.accrued, true);
    return true;
  });
  // التأكيد لا يتجاوز استحقاقاً مطابقاً للشهر والمجموعة نفسيهما
  await assert.rejects(executeAiPost(s.tx, request(salaries('bank', { confirmed: true }), { clientRef: OTHER }), s.deps),
    (e: unknown) => e instanceof AiPostRefusal && e.refusal.code === 'SALARIES_ALREADY_ACCRUED');
  assert.equal(s.posts.length, 1);
  // مجموعة أخرى (الإداريون) والرصيد يغطيها ⇒ رفضٌ برصيد، والتأكيد يُسقطه
  const admin = salaries('bank', { group: 'admin', amount: 20_000_000n });
  await assert.rejects(executeAiPost(s.tx, request(admin, { clientRef: OTHER }), s.deps), (e: unknown) => {
    assert.ok(e instanceof AiPostRefusal);
    assert.equal(e.refusal.code, 'SALARIES_ALREADY_ACCRUED');
    assert.equal(e.refusal.details?.balance, 45000);
    return true;
  });
  const confirmed = await executeAiPost(s.tx, request(salaries('bank', { group: 'admin', amount: 20_000_000n, confirmed: true }), { clientRef: OTHER }), s.deps);
  assert.equal(confirmed.replayed, false);
  // الاستحقاق المعكوس لا يُعدّ، ورصيدٌ أقل من المبلغ لا يمنع
  const r = store();
  const acc = await executeAiPost(r.tx, request(salaries('accrue')), r.deps);
  r.moves.push({ id: 'rv1', tenantId: 't1', ref: acc.move.ref, reversedMoveId: acc.move.moveId, state: 'POSTED', lines: [
    { accountId: accountIdOf('213001'), debitMilli: 45_000_000n, creditMilli: 0n }, { accountId: accountIdOf('611001'), debitMilli: 0n, creditMilli: 45_000_000n },
  ] });
  const paid = await executeAiPost(r.tx, request(salaries('bank'), { clientRef: OTHER }), r.deps);
  assert.equal(paid.move.kind, 'SALARIES');
  // الاستحقاق نفسه لا يُفحص (لا accruedCheck)، ولا الصرف بلا 213001 في الدليل
  assert.equal(planOf(salaries('accrue')(ledgerContext())).accruedCheck, undefined);
  assert.equal(planOf(salaries('bank')(ledgerContext({ accounts: { '213001': null } }))).accruedCheck, undefined);
});

test('تكرار الطلب بدورة أخرى: مبلغٌ ورثته الرسالة من سابقتها لا يكرّر قيداً مطابقاً رحّله الفاعل نفسه — وكتابته من جديد ترحّله', async () => {
  const s = store();
  const ctx1 = acctCtx({ userText: 'دفعنا 1500 إيجار نقداً', latestUserText: 'دفعنا 1500 إيجار نقداً' });
  const t1 = toolsFor(ctx1, { s });
  assert.equal(dataOf(await t1.run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار' })).posted, true);
  // الدورة التالية: «وسجّل الكهرباء» بلا مبلغ ⇒ النص يشمل الرسالة السابقة، والنموذج يعيد نداء الإيجار
  const ctx2 = acctCtx({ clientRef: OTHER, userText: 'دفعنا 1500 إيجار نقداً\nوسجّل الكهرباء', latestUserText: 'وسجّل الكهرباء' });
  const t2 = toolsFor(ctx2, { s });
  const dup = dataOf(await t2.run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار' }));
  assert.equal(dup.posted, false);
  assert.equal(dup.reason, 'DUPLICATE_RECENT');
  assert.equal(dup.move_number, 'CSH1/2026/00001');
  assert.equal(s.posts.length, 1);
  // مصروفٌ آخر من الرسالة السابقة نفسها (لم يُرحَّل) يمرّ
  const ctx3 = acctCtx({ clientRef: OTHER, userText: 'دفعنا 1500 إيجار و1500 صيانة\nنقداً', latestUserText: 'نقداً' });
  assert.equal(dataOf(await toolsFor(ctx3, { s }).run('post_expense', { amount: 1500, category: 'maintenance', paidFrom: 'cash', description: 'صيانة' })).posted, true);
  // المستخدم يكتب المبلغ في رسالته الجديدة ⇒ قيدٌ جديد مقصود
  const ctx4 = acctCtx({ clientRef: '6f1c2b1e-0000-4000-8000-0000000000c3', userText: 'دفعنا 1500 إيجار المعرض نقداً', latestUserText: 'دفعنا 1500 إيجار المعرض نقداً' });
  assert.equal(dataOf(await toolsFor(ctx4, { s }).run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار المعرض' })).posted, true);
  assert.equal(s.posts.length, 3);
});

test('الضريبة فوق المبلغ بلا إجماليٍّ كتبه المستخدم ⇒ VAT_BASIS_UNCLEAR؛ و«قبل الضريبة» أو الإجمالي بالأرقام يُرحَّلان', async () => {
  assert.equal(vatOnTopProblem('دفعنا فاتورة كهرباء 1150 نقداً وعليها ضريبة', 1_150_000n, 1_322_500n)?.code, 'VAT_BASIS_UNCLEAR');
  assert.doesNotMatch(vatOnTopProblem('x', 1_150_000n, 1_322_500n)!.message, /\d/, 'لا رقم محسوب في الرسالة');
  assert.equal(vatOnTopProblem('دفعنا 1000 قبل الضريبة', 1_000_000n, 1_150_000n), null);
  assert.equal(vatOnTopProblem('دفعنا 1000 + الضريبة', 1_000_000n, 1_150_000n), null);
  assert.equal(vatOnTopProblem('دفعنا 1000 غير شامل', 1_000_000n, 1_150_000n), null);
  assert.equal(vatOnTopProblem('دفعنا 1000 والإجمالي 1,150', 1_000_000n, 1_150_000n), null);
  assert.equal(vatOnTopProblem('دفعنا 1000', 1_000_000n, 1_000_000n), null, 'إجماليٌّ = المبلغ (ضريبة مُزالة)');

  const ctx = acctCtx({ userText: 'دفعنا فاتورة كهرباء 1150 نقداً وعليها ضريبة' });
  const { run, s } = toolsFor(ctx);
  const out = dataOf(await run('post_expense', { amount: 1150, category: 'utilities', paidFrom: 'cash', description: 'كهرباء', vat: { included: false } }));
  assert.equal(out.posted, false);
  assert.equal(out.reason, 'VAT_BASIS_UNCLEAR');
  assert.equal(s.posts.length, 0);
  // الشامل يُرحَّل كما ذُكر
  assert.equal(dataOf(await run('post_expense', { amount: 1150, category: 'utilities', paidFrom: 'cash', description: 'كهرباء', vat: { included: true } })).posted, true);
  const before = acctCtx({ userText: 'دفعنا 1000 كهرباء نقداً قبل الضريبة' });
  const okBefore = dataOf(await toolsFor(before).run('post_expense', { amount: 1000, category: 'utilities', paidFrom: 'cash', description: 'كهرباء', vat: { included: false } }));
  assert.equal(okBefore.posted, true);
  assert.equal(okBefore.amount, 1150);
  // وصف الأداة: الافتراض شامل عند الشك
  const spec = JSON.stringify(toolsFor(acctCtx()).tools[0].spec);
  assert.match(spec, /use true when unsure/);
});

test('حارس المبلغ: التواريخ وأرقام الأشهر ليست مبالغ — «رواتب شهر 11» بلا مبلغ لا يقبل 11، و«من 2026-10-01» لا يقبل 2026', async () => {
  assert.ok(!amountInUserText(11_000n, 'رواتب شهر 11 تحويل بنكي'));
  assert.ok(!amountInUserText(11_000n, 'رواتب شهر ١١ تحويل بنكي'));
  assert.ok(!amountInUserText(2_026_000n, 'قائمة دخل من 2026-10-01 إلى 2026-10-31'));
  assert.ok(!amountInUserText(10_000n, 'قائمة دخل من 2026-10-01 إلى 2026-10-31'));
  assert.ok(!amountInUserText(1_000n, 'من 2026-10-01'));
  assert.ok(!amountInUserText(31_000n, 'بتاريخ 31/10/2026'));
  assert.ok(!amountInUserText(10_000n, 'رواتب 10/2026'));
  assert.ok(!amountInUserText(18_000n, 'بتاريخ 18/11'));
  assert.ok(!amountInUserText(2_026_000n, 'ميزانية سنة 2026'));
  assert.deepEqual(amountsInText('رواتب شهر 11 مبلغ 45000 تحويل بنكي'), [45_000_000n]);
  assert.deepEqual(amountsInText('دفعنا 1,500 إيجار شهر 11 بتاريخ 2026-11-05'), [1_500_000n]);
  // بالأداة: «رواتب شهر 11 … تحويل بنكي» بلا مبلغ والنموذج يمرّر 11
  const ctx = acctCtx({ userText: 'رواتب شهر 11 للمناديب تحويل بنكي' });
  const { run, s } = toolsFor(ctx);
  const out = dataOf(await run('post_salaries', { month: '11', amount: 11, group: 'reps', paidFrom: 'bank' }));
  assert.equal(out.reason, 'AMOUNT_NOT_IN_MESSAGE');
  assert.equal(s.posts.length, 0);
});

// ═══ الأدوات: البوابات والتنفيذ ═══

function acctCtx(p: Partial<AcctCtx> = {}): AcctCtx {
  return {
    tenantId: 't1', adminId: 'a1', adminName: 'سارة', impersonated: false, tz: 'Asia/Riyadh', todayLocal: '2026-11-18', currency: 'SAR',
    accountingOn: true, booksMode: 'MANUAL', booksActivated: true, canViewLedger: true, canPost: true, warehouseOn: false, taxDisabled: false,
    userText: 'دفعنا ١٬٥٠٠ ريال إيجار المستودع نقداً', clientRef: CLIENT, reports: [], posted: [], warnings: [], ...p,
  };
}

function gateDb(o: { suite?: boolean; acct?: boolean; ai?: boolean; activated?: boolean; admin?: Partial<LedgerAdminRow> | null } = {}): WriteGateDb & { adminCalls: number } {
  const db = {
    adminCalls: 0,
    tenant: { findUnique: async () => ({ accountingSuiteEnabled: o.suite ?? true, accountingEnabled: o.acct ?? true, aiAccountantEnabled: o.ai ?? true }) },
    glSettings: { findUnique: async () => ({ activatedAt: o.activated === false ? null : new Date('2026-10-01T00:00:00Z') }) },
    admin: {
      findUnique: async () => {
        db.adminCalls++;
        return o.admin === null ? null : { isActive: true, tenantId: 't1', role: 'ADMIN', canManageCompanyUsers: false, scopeEnabled: false, canPostJournals: true, ...(o.admin ?? {}) };
      },
    },
  };
  return db;
}

function toolsFor(ctx: AcctCtx, o: { env?: NodeJS.ProcessEnv; gate?: WriteGateDb; s?: ReturnType<typeof store> } = {}) {
  const s = o.s ?? store();
  const deps: Partial<WriteToolDeps> = {
    env: o.env ?? {},
    gateDb: o.gate ?? gateDb(),
    runTx: (fn) => fn(s.tx),
    post: s.deps,
    now: () => new Date('2026-11-18T09:00:00Z'),
    log: () => undefined,
  };
  const tools = buildWriteTools(ctx, deps);
  const byName = new Map(tools.map((t: Tool) => [t.spec.function.name, t]));
  const run = async (name: string, args: Record<string, unknown>) => {
    const t = byName.get(name);
    assert.ok(t, `الأداة ${name}`);
    return t!.run(args) as Promise<ToolOutput | { error: string }>;
  };
  return { tools, run, s, deps };
}

const dataOf = (o: ToolOutput | { error: string }): Record<string, unknown> => {
  assert.ok(!('error' in o), `خطأ وسائط: ${'error' in o ? o.error : ''}`);
  return (o as ToolOutput).data as Record<string, unknown>;
};

test('لا أدوات كتابة بلا صلاحية الترحيل أو بلا دفاتر مفعّلة أو بمفتاح AI_ACCOUNTANT_WRITE=0؛ وإلا الثلاث بأسمائها', () => {
  assert.deepEqual(toolsFor(acctCtx({ canPost: false })).tools, []);
  assert.deepEqual(toolsFor(acctCtx({ booksActivated: false })).tools, []);
  assert.deepEqual(toolsFor(acctCtx({ accountingOn: false })).tools, []);
  assert.deepEqual(toolsFor(acctCtx(), { env: { AI_ACCOUNTANT_WRITE: '0' } }).tools, []);
  assert.deepEqual(toolsFor(acctCtx(), { env: { AI_ACCOUNTANT_WRITE: ' 0 ' } }).tools, []);
  assert.deepEqual(toolsFor(acctCtx(), { env: { AI_ACCOUNTANT_WRITE: '1' } }).tools.map((t) => t.spec.function.name), [...AI_WRITE_TOOL_NAMES]);
  assert.deepEqual(toolsFor(acctCtx()).tools.map((t) => t.spec.function.name), ['post_expense', 'post_salaries', 'settle_payable']);
  assert.equal(writeToolsAllowed(acctCtx(), {}), true);
  assert.equal(writeToolsAllowed(acctCtx({ canPost: false }), {}), false);
  // لا وسيط للشركة في أي أداة
  for (const t of toolsFor(acctCtx()).tools) assert.doesNotMatch(JSON.stringify(t.spec), /tenant/i);
});

test('post_expense كاملاً: المبلغ بأرقام هندية في الرسالة ⇒ قيد في ctx.posted بمرجعه وسطوره، وtenantId من السياق لا من الوسائط', async () => {
  const ctx = acctCtx();
  const { run, s } = toolsFor(ctx);
  const out = await run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار المستودع', tenantId: 't-evil' });
  const data = dataOf(out);
  assert.equal(data.posted, true);
  assert.equal(data.move_number, 'CSH1/2026/00001');
  assert.equal(data.amount, 1500);
  assert.equal(ctx.posted.length, 1);
  assert.equal(ctx.posted[0].ref, `AI-${CLIENT}-1`);
  assert.equal(ctx.posted[0].kind, 'EXPENSE');
  assert.equal(s.rows[0].tenantId, 't1');
  assert.equal(s.posts[0].opts.tenantId, 't1');
  assert.equal(s.posts[0].opts.actor.actorId, 'a1');
  assert.equal(s.posts[0].opts.actor.actorName, 'المحاسب الذكي بطلب سارة');
  assert.equal(s.posts[0].opts.actor.actorType, 'ADMIN');
  assert.match((out as ToolOutput).summaryAr, /رُحّل القيد CSH1\/2026\/00001/);
  // الإعادة في الدورة نفسها بوسائط مختلفة الوصف: قيد ثانٍ -2 (طلبان)
  const out2 = await run('post_expense', { amount: '١٬٥٠٠', category: 'rent', paidFrom: 'cash', description: 'إيجار المعرض' });
  assert.equal(dataOf(out2).posted, true);
  assert.equal(ctx.posted[1].ref, `AI-${CLIENT}-2`);
});

test('post_expense: مبلغ ليس في رسالة المستخدم ⇒ لم يُرحَّل ولا يُذكر المبلغ؛ وضريبة صريحة غائبة عن الرسالة كذلك', async () => {
  const ctx = acctCtx({ userText: 'دفعنا 1150 ريال إيجار نقداً شامل الضريبة' });
  const { run, s } = toolsFor(ctx);
  const out = await run('post_expense', { amount: 2000, category: 'rent', paidFrom: 'cash', description: 'إيجار' });
  const data = dataOf(out);
  assert.equal(data.posted, false);
  assert.equal(data.reason, 'AMOUNT_NOT_IN_MESSAGE');
  assert.doesNotMatch(JSON.stringify(data), /2000/);
  const vat = await run('post_expense', { amount: 1150, category: 'rent', paidFrom: 'cash', description: 'إيجار', vat: { included: true, amount: 172.5 } });
  assert.equal(dataOf(vat).reason, 'AMOUNT_NOT_IN_MESSAGE');
  assert.equal(s.posts.length, 0);
  assert.equal(ctx.posted.length, 0);
  const ok = await run('post_expense', { amount: 1150, category: 'rent', paidFrom: 'cash', description: 'إيجار', vat: { included: true } });
  assert.equal(dataOf(ok).posted, true);
  assert.deepEqual(ctx.posted[0].lines.map((l) => [l.accountCode, l.debit, l.credit]), [['621004', 1000, 0], ['116001', 150, 0], ['111001', 0, 1150]]);
});

test('الوسائط: الخاطئة ⇒ {error} لتصحيح الاستدعاء؛ والتاريخ المستقبلي والشهر المستقبلي والمبلغ غير الصالح ⇒ لم يُرحَّل', async () => {
  const ctx = acctCtx({ userText: 'رواتب المناديب 50000 وتأمينات 5000 نقداً' });
  const { run, s } = toolsFor(ctx);
  assert.ok('error' in await run('post_expense', { amount: 1500, paidFrom: 'cash', description: 'x' }), 'بلا تصنيف ولا رمز');
  assert.ok('error' in await run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'credit_card', description: 'x' }));
  assert.ok('error' in await run('post_salaries', { amount: 50000, group: 'reps', paidFrom: 'cash' }), 'بلا شهر');
  assert.equal(dataOf(await run('post_expense', { amount: -5, category: 'rent', paidFrom: 'cash', description: 'x' })).reason, 'AMOUNT_INVALID');
  assert.equal(dataOf(await run('post_salaries', { month: '2026-12', amount: 50000, group: 'reps', paidFrom: 'cash' })).reason, 'MONTH_FUTURE');
  assert.equal(dataOf(await run('post_salaries', { month: '11', amount: 50000, group: 'reps', paidFrom: 'cash', date: '2026-11-20' })).reason, 'DATE_FUTURE');
  assert.equal(s.posts.length, 0);
  const out = await run('post_salaries', { month: '11', amount: 50000, group: 'reps', paidFrom: 'cash', gosi: 5000 });
  assert.equal(dataOf(out).posted, true);
  assert.equal(ctx.posted[0].kind, 'SALARIES');
  assert.equal(ctx.posted[0].amount, 55000);
  assert.equal(s.posts[0].draft.date, '2026-11-18');
  // تأمينات «0» كأنها لم تُذكر، والتاريخ بأرقام هندية يُوحَّد
  const zero = await run('post_salaries', { month: 11, amount: '٥٠٠٠٠', group: 'admin', paidFrom: 'accrue', gosi: '0', date: '٢٠٢٦-١١-١٥' });
  assert.equal(dataOf(zero).posted, true);
  assert.equal(ctx.posted[1].amount, 50000);
  assert.equal(s.posts[1].draft.date, '2026-11-15');
  assert.equal(s.posts[1].draft.lines.length, 2);
});

test('مفتاح الإطفاء وقت التنفيذ وبوابات القاعدة: AI_ACCOUNTANT_WRITE=0 بعد البناء، النظام المتكامل، المحاسب الذكي، التفعيل، الصلاحية', async () => {
  const env: NodeJS.ProcessEnv = {};
  const killed = toolsFor(acctCtx(), { env });
  env.AI_ACCOUNTANT_WRITE = '0';
  assert.equal(dataOf(await killed.run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار' })).reason, 'WRITE_DISABLED');
  assert.equal(killed.s.posts.length, 0);

  const cases: [Parameters<typeof gateDb>[0], string][] = [
    [{ suite: false }, 'NOT_ACTIVATED'],
    [{ acct: false }, 'NOT_ACTIVATED'],
    [{ ai: false }, 'NOT_ALLOWED'],
    [{ activated: false }, 'NOT_ACTIVATED'],
    [{ admin: { canPostJournals: false } }, 'NOT_ALLOWED'],
    [{ admin: { scopeEnabled: true } }, 'NOT_ALLOWED'],
    [{ admin: { tenantId: 't2' } }, 'NOT_ALLOWED'],
    [{ admin: null }, 'NOT_ALLOWED'],
  ];
  for (const [g, code] of cases) {
    const t = toolsFor(acctCtx(), { gate: gateDb(g) });
    const data = dataOf(await t.run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار' }));
    assert.equal(data.posted, false, JSON.stringify(g));
    assert.equal(data.reason, code, JSON.stringify(g));
    assert.equal(t.s.posts.length, 0);
  }
  // مالك الشركة ضمناً، وجلسة المالك تتجاوز صلاحية المستخدم (لا قراءة له) — لا علم الشركة
  const owner = gateDb({ admin: { canPostJournals: false, canManageCompanyUsers: true } });
  assert.equal(await writeGateRefusal(owner, acctCtx()), null);
  const imp = gateDb({ admin: null });
  assert.equal(await writeGateRefusal(imp, acctCtx({ impersonated: true })), null);
  assert.equal(imp.adminCalls, 0);
  assert.equal((await writeGateRefusal(gateDb({ ai: false }), acctCtx({ impersonated: true })))?.code, 'NOT_ALLOWED');
});

test('جلسة المالك وعنوان الطلب: صفّ القيد OWNER:<id> كـactorOf وسجلّ الدفاتر بعنوان الطلب؛ ولا أدوات كتابة لسؤال تقرير', async () => {
  const imp = acctCtx({ impersonated: true, adminName: 'الدعم الفني', requestIp: '10.0.0.9' });
  const { run, s } = toolsFor(imp, { gate: gateDb({ admin: null }) });
  assert.equal(dataOf(await run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار' })).posted, true);
  assert.equal(s.rows[0].adminId, 'OWNER:a1', 'لا يُنسب القيد لمدير الشركة الذي دخل الدعم باسمه');
  assert.equal(s.rows[0].adminName, 'الدعم الفني');
  const actor = s.posts[0].opts.actor;
  assert.deepEqual([actor.actorType, actor.actorId, actor.impersonated, actor.requestIp], ['IMPERSONATION', 'a1', true, '10.0.0.9']);
  const plain = toolsFor(acctCtx());
  await plain.run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار' });
  assert.equal(plain.s.rows[0].adminId, 'a1');
  assert.equal(plain.s.posts[0].opts.actor.requestIp, null);
  // نيّة التسجيل: سؤال تقرير لا تُعرض فيه أدوات الترحيل (ولو كان الترحيل مسموحاً)، والردّ القصير على سؤالٍ يرث نيّة سابقته
  assert.deepEqual(toolsFor(acctCtx({ userText: 'قائمة دخل هذا الشهر' })).tools, []);
  assert.deepEqual(toolsFor(acctCtx({ userText: 'مصروفات هذا الشهر' })).tools, []);
  assert.deepEqual(toolsFor(acctCtx({ userText: 'قائمة دخل من 2026-10-01 إلى 2026-10-31' })).tools, []);
  assert.equal(toolsFor(acctCtx({ userText: 'دفعنا 1500 إيجار\nنقداً' })).tools.length, 3);
  // نيّة الدورة من السياق (writeIntentOf) تغلب نصّ الحارس: «1500» ردّاً على «كم المبلغ؟» بعد «سجّل مصروف إيجار»
  assert.equal(toolsFor(acctCtx({ userText: '1500', writeIntent: true })).tools.length, 3);
  assert.deepEqual(toolsFor(acctCtx({ writeIntent: false })).tools, []);
});

test('سداد المستحق فوق الرصيد ⇒ لم يُرحَّل برصيده المتاح؛ وخطأ غير متوقع ⇒ POST_FAILED بلا قيد', async () => {
  const ctx = acctCtx({ userText: 'سددنا رواتب مستحقة 30000 تحويل بنكي' });
  const { run, s } = toolsFor(ctx, { s: store({ balance: 12_500_000n }) });
  const data = dataOf(await run('settle_payable', { amount: 30000, payable: 'salaries', paidFrom: 'bank' }));
  assert.equal(data.reason, 'EXCEEDS_PAYABLE');
  assert.equal(data.balance, 12500);
  assert.equal(s.posts.length, 0);
  const broken = toolsFor(acctCtx(), { s: store({ postError: new Error('db down') }) });
  const out = dataOf(await broken.run('post_expense', { amount: 1500, category: 'rent', paidFrom: 'cash', description: 'إيجار' }));
  assert.equal(out.reason, 'POST_FAILED');
});

// ═══ قائمة «قيود المحاسب الذكي» ═══

test('listAiPosts: الأحدث بحدّ 1..200، السطور بأرقام ورموز، المعكوس من reversedMoveId، والمحذوف/المسودة معكوس', async () => {
  const calls: { model: string; args: { where: Record<string, unknown>; take?: number } }[] = [];
  const row = (id: string, moveId: string, kind: string): AiPostRow & { tenantId: string } => ({
    id, tenantId: 't1', adminId: 'a1', adminName: 'سارة', moveId, moveNumber: `MISC/${id}`, ref: `AI-x-${id}`, kind, amountMilli: 1_500_000n,
    dateLocal: '2026-11-18', summaryAr: 'مصروف', createdAt: new Date('2026-11-18T10:00:00Z'),
  });
  const db = {
    aiAccountantPost: { findMany: async (args: { where: Record<string, unknown>; take?: number }) => { calls.push({ model: 'post', args }); return [row('p1', 'm1', 'EXPENSE'), row('p2', 'm2', 'SALARIES'), row('p3', 'm3', 'SALARIES_SETTLE'), row('p4', 'm4', 'EXPENSE')]; } },
    glMove: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.push({ model: 'move', args });
        if ('reversedMoveId' in args.where) return [{ reversedMoveId: 'm2' }];
        return [
          { id: 'm1', state: 'POSTED', lines: [{ accountId: 'acc_621004', debitMilli: 1_500_000n, creditMilli: 0n }, { accountId: 'acc_111001', debitMilli: 0n, creditMilli: 1_500_000n }] },
          { id: 'm2', state: 'POSTED', lines: [] },
          { id: 'm4', state: 'DRAFT', lines: [] },
        ];
      },
    },
    glAccount: { findMany: async () => [{ id: 'acc_621004', code: '621004', name: 'الإيجار' }, { id: 'acc_111001', code: '111001', name: 'الصندوق الرئيسي' }] },
  };
  const out = await listAiPostsWith(db as never, 't1', 500);
  assert.equal(calls[0].args.take, 200);
  assert.deepEqual(calls[0].args.where, { tenantId: 't1' });
  for (const c of calls) assert.equal(c.args.where.tenantId, 't1', 'كل استعلام مقيّد بالشركة');
  assert.deepEqual(out.map((p) => [p.id, p.kind, p.reversed]), [['p1', 'EXPENSE', false], ['p2', 'SALARIES', true], ['p3', 'SALARIES_SETTLE', true], ['p4', 'EXPENSE', true]]);
  assert.deepEqual(out[0].lines, [
    { accountCode: '621004', accountName: 'الإيجار', debit: 1500, credit: 0 },
    { accountCode: '111001', accountName: 'الصندوق الرئيسي', debit: 0, credit: 1500 },
  ]);
  assert.equal(out[0].amount, 1500);
  assert.equal(typeof out[0].amount, 'number');
  assert.equal(out[0].createdAt, '2026-11-18T10:00:00.000Z');
  assert.deepEqual(await listAiPostsWith(db as never, '', 10), []);
  calls.length = 0;
  await listAiPostsWith(db as never, 't1', 0);
  assert.equal(calls[0].args.take, 50);
});

// ═══ حراس ثابتة على المصدر ═══

const SRC = path.join(__dirname, '..', 'services', 'aiAccountant');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('المصدر: المعاملة كـPOST /clearing (prisma.$transaction + POST_TX_OPTIONS)، القفل قبل البحث، لا GlMoveSource، والفاعل والتدقيق', () => {
  const w = read('writeTools.ts');
  const p = read('posting.ts');
  assert.match(w, /prisma\.\$transaction\(\(tx\) => fn\(tx as GlDb\), POST_TX_OPTIONS\)/);
  assert.match(w, /ledgerActor\(\s*\{ actorId: ctx\.adminId, impersonated: ctx\.impersonated \}/);
  assert.match(w, /المحاسب الذكي بطلب /);
  assert.match(w, /requestIp: ctx\.requestIp \?\? null/, 'عنوان الطلب في سجلّ تدقيق الدفاتر');
  assert.match(w, /adminId: actorRef,/, 'صاحب الصفّ كـactorOf');
  assert.match(w, /aiWriteEnabled\(env\)/);
  assert.doesNotMatch(w, /args\.tenantId|a\.tenantId/, 'tenantId من السياق وحده');
  const exec = p.slice(p.indexOf('export async function executeAiPost'), p.indexOf('// ═══ الأخطاء'));
  const lock = exec.indexOf('deps.acquirePostLock(tx, tenantId)');
  const lookup = exec.indexOf('tx.glMove.findMany');
  const post = exec.indexOf('deps.postMove(tx, draft');
  const row = exec.indexOf('tx.aiAccountantPost.create');
  assert.ok(lock > 0 && lock < lookup && lookup < post && post < row, 'القفل ⇒ البحث ⇒ الترحيل ⇒ الصفّ');
  assert.match(exec, /reversedMoveId: null/);
  assert.match(exec, /validationMode: 'MANUAL'/);
  assert.match(exec, /lockPolicy: 'REJECT'/);
  assert.match(exec, /auditAction: AI_POST_AUDIT_ACTION/);
  assert.match(exec, /aiAccountant: true, clientRef: req\.clientRef/);
  assert.doesNotMatch(p, /glMoveSource|createSource: true/);
  assert.doesNotMatch(p, /sourceType: '[A-Z_]+'/, 'لا sourceType: القيد يدويّ يعكسه المستخدم');
  assert.doesNotMatch(p + w, /from '\.\.\/\.\.\/config\/database'[\s\S]*executeAiPost\(prisma/, 'المعاملة تُمرَّر لا prisma العام');
  assert.doesNotMatch(p, /config\/database/, 'posting.ts بلا prisma العام (تُحقن القاعدة)');
});
