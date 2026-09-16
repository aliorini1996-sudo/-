// M1 — التحقق من القيد قبل الترحيل (DESIGN.md §2.1 I1–I5 وI8، قاعدة سطر MARKER، §5.9 CONTROL_ADJUSTMENT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectMoveIssues, isValidMove, resolveLineAccount, validateMove, validationModeOf,
  type ValidationMode,
} from '../services/gl/validate';
import {
  createBuildContext, isLedgerError, LedgerError,
  type AccountRef, type AccountType, type BuildContext, type ControlKind, type LineDraft,
  type MoveDraft, type MoveType, type TaxRef,
} from '../services/gl/types';

function acc(id: string, code: string, type: AccountType, controlKind: ControlKind | null = null, isActive = true): AccountRef {
  return { id, code, name: `حساب ${code}`, type, isActive, reconcile: false, controlKind };
}

function tax(id: string, key: string, use: 'SALE' | 'PURCHASE', rate: number, vatBox: string | null, isActive = true): TaxRef {
  return {
    id, key, name: `ضريبة ${key}`, use, rate, vatCategory: rate === 0 ? 'Z' : 'S', priceInclude: false,
    accountId: null, rcOutputAccountId: null, deductible: true, vatBox, isActive,
  };
}

const ACCOUNTS: AccountRef[] = [
  acc('a-cash', '111001', 'asset_cash'),
  acc('a-custody', '111003', 'asset_cash', 'CUSTODY'),
  acc('a-plnk', '112005', 'asset_current', 'PAYLINK'),
  acc('a-ar', '113001', 'asset_receivable', 'AR'),
  acc('a-other-ar', '113004', 'asset_current'),
  acc('a-inv', '114001', 'asset_current', 'INVENTORY'),
  acc('a-vat-in', '116001', 'asset_current', 'VAT_IN'),
  acc('a-ap', '211001', 'liability_payable', 'AP'),
  acc('a-vat-out', '212001', 'liability_current', 'VAT_OUT'),
  acc('a-vat-old', '212099', 'liability_current', 'VAT_OUT', false),
  acc('a-cye', '319001', 'equity_unaffected'),
  acc('a-rev', '411001', 'income'),
  acc('a-exp', '611001', 'expense'),
  acc('a-exp-old', '611099', 'expense', null, false),
  acc('a-susp', '911001', 'asset_current', 'SUSPENSE'),
  acc('a-guar', '991001', 'off_balance'),
  acc('a-guar-c', '991002', 'off_balance'),
];

const TAXES: TaxRef[] = [
  tax('t-s15', 'S15_SALE', 'SALE', 15, 'SA_1'),
  tax('t-z', 'Z_SALE', 'SALE', 0, 'SA_3'),
  tax('t-p15', 'S15_PURCH', 'PURCHASE', 15, 'SA_7'),
  tax('t-cit', 'CIT_SALE', 'SALE', 0, null),
];

const ctx: BuildContext = createBuildContext({
  accounts: ACCOUNTS,
  mappings: { MAIN_CASH: 'a-cash', OUTPUT_VAT: 'a-vat-out', SALES_REVENUE: 'a-rev', AR_CONTROL: 'a-ar' },
  taxes: TAXES,
});

function ln(accountCode: string, debit: bigint, credit: bigint, extra: Partial<LineDraft> = {}): LineDraft {
  return { accountCode, label: 'سطر', debitMilli: debit, creditMilli: credit, ...extra };
}

function mv(lines: LineDraft[], over: Partial<MoveDraft> = {}): MoveDraft {
  return {
    kind: 'MOVE', journalCode: 'MISC', moveType: 'ENTRY', origin: 'MANUAL', date: '2027-03-01',
    narration: 'قيد اختبار', needsAttention: false, currencyCode: 'SAR', currencyDecimals: 2, lines, ...over,
  };
}

function expectCode(move: MoveDraft, code: string, reason?: string, mode?: ValidationMode): LedgerError {
  let caught: unknown;
  try {
    validateMove(move, ctx, mode ? { mode } : {});
  } catch (e) {
    caught = e;
  }
  assert.ok(isLedgerError(caught), `متوقع LedgerError ${code}`);
  const err = caught as LedgerError;
  assert.equal(err.code, code);
  if (reason) assert.equal(err.details.reason, reason);
  return err;
}

function reasons(move: MoveDraft, mode?: ValidationMode): string[] {
  return collectMoveIssues(move, ctx, mode ? { mode } : {}).issues.map((i) => i.reason);
}

// ═══ الأساس ═══

test('قيد يدوي متوازن بسطرين يُقبل ويعيد المجاميع والسطور المحلولة', () => {
  const r = validateMove(mv([ln('611001', 100_000n, 0n), ln('111001', 0n, 100_000n)]), ctx);
  assert.equal(r.mode, 'MANUAL');
  assert.equal(r.totalDebitMilli, 100_000n);
  assert.equal(r.totalCreditMilli, 100_000n);
  assert.deepEqual(r.lines.map((l) => l.account.code), ['611001', '111001']);
});

test('الوضع يُشتق من origin: MANUAL ⇒ MANUAL، وAUTO ⇒ SYSTEM، والخيار يتجاوزه', () => {
  assert.equal(validationModeOf({ origin: 'MANUAL' }), 'MANUAL');
  assert.equal(validationModeOf({ origin: 'AUTO' }), 'SYSTEM');
  const m = mv([ln('113001', 50_000n, 0n, { customerId: 'c1' }), ln('411001', 0n, 50_000n)], { origin: 'AUTO' });
  assert.doesNotThrow(() => validateMove(m, ctx));
  expectCode(m, 'LEDGER_CONTROL_ACCOUNT_MANUAL', 'CONTROL_ACCOUNT_MANUAL', 'MANUAL');
});

test('حل الحساب: id ثم code ثم key، وغير المحلول ⇒ LEDGER_ACCOUNT_NOT_FOUND', () => {
  assert.equal(resolveLineAccount({ accountId: 'a-cash', accountCode: '411001', accountKey: 'SALES_REVENUE', label: '', debitMilli: 0n, creditMilli: 0n }, ctx.accounts)?.code, '111001');
  assert.equal(resolveLineAccount({ accountCode: '411001', accountKey: 'MAIN_CASH', label: '', debitMilli: 0n, creditMilli: 0n }, ctx.accounts)?.code, '411001');
  assert.equal(resolveLineAccount({ accountKey: 'MAIN_CASH', label: '', debitMilli: 0n, creditMilli: 0n }, ctx.accounts)?.code, '111001');
  assert.equal(resolveLineAccount({ label: '', debitMilli: 0n, creditMilli: 0n }, ctx.accounts), null);
  // مفتاح بلا ربط
  expectCode(mv([ln('611001', 10n, 0n), { accountKey: 'BANK_FEES', label: 'x', debitMilli: 0n, creditMilli: 10n }]), 'LEDGER_ACCOUNT_NOT_FOUND', 'ACCOUNT_NOT_FOUND');
  expectCode(mv([ln('611001', 10n, 0n), ln('999999', 0n, 10n)]), 'LEDGER_ACCOUNT_NOT_FOUND');
});

// ═══ I1 ═══

test('I1: غير متوازن ⇒ LEDGER_UNBALANCED بفرق ملّي واحد وتفاصيل نصية', () => {
  const err = expectCode(mv([ln('611001', 100_001n, 0n), ln('111001', 0n, 100_000n)]), 'LEDGER_UNBALANCED', 'UNBALANCED');
  assert.equal(err.details.debitMilli, '100001');
  assert.equal(err.details.creditMilli, '100000');
  assert.equal(err.httpStatus, 422);
  assert.doesNotThrow(() => JSON.stringify(err.details)); // لا BigInt في التفاصيل
});

test('I1: سطر واحد غير صفري أو قيد فارغ ⇒ TOO_FEW_LINES', () => {
  expectCode(mv([]), 'LEDGER_UNBALANCED', 'TOO_FEW_LINES');
  expectCode(mv([ln('611001', 0n, 0n), ln('111001', 0n, 0n)]), 'LEDGER_UNBALANCED', 'ZERO_LINE_NOT_MARKER');
  assert.ok(reasons(mv([ln('611001', 0n, 0n), ln('111001', 0n, 0n)])).includes('TOO_FEW_LINES'));
});

test('I1: سطر 0/0 غير MARKER يُرفض ولو كان القيد متوازناً (ومنه سطر TAX أو BASE)', () => {
  const base = [ln('611001', 100n, 0n), ln('111001', 0n, 100n)];
  expectCode(mv([...base, ln('411001', 0n, 0n)]), 'LEDGER_UNBALANCED', 'ZERO_LINE_NOT_MARKER');
  expectCode(mv([...base, ln('212001', 0n, 0n, { taxRole: 'TAX', taxCode: 'S15_SALE', vatBox: 'SA_1', taxBaseMilli: 0n })]), 'LEDGER_UNBALANCED', 'ZERO_LINE_NOT_MARKER', 'SYSTEM');
  expectCode(mv([...base, ln('411001', 0n, 0n, { taxRole: 'BASE' })]), 'LEDGER_UNBALANCED', 'ZERO_LINE_NOT_MARKER', 'SYSTEM');
});

// ═══ I2 ═══

test('I2: مدين ودائن معاً على سطر واحد ⇒ DEBIT_AND_CREDIT', () => {
  expectCode(mv([ln('611001', 100n, 50n), ln('111001', 0n, 50n)]), 'LEDGER_UNBALANCED', 'DEBIT_AND_CREDIT');
});

test('I2: مبلغ سالب يُرفض ولو توازن القيد', () => {
  expectCode(mv([ln('611001', -100n, 0n), ln('111001', -100n, 0n), ln('411001', 0n, -200n)]), 'LEDGER_UNBALANCED', 'NEGATIVE_AMOUNT');
});

// ═══ قاعدة MARKER ═══

const saleZero = (extra: Partial<LineDraft> = {}) =>
  ln('212001', 0n, 0n, { taxRole: 'MARKER', taxCode: 'Z_SALE', taxBaseMilli: 500_000n, vatBox: 'SA_3', ...extra });

test('MARKER: علامة 0/0 على 212001 بجوار سطرين تُقبل آلياً ويدوياً (بضريبة ومربع)', () => {
  const lines = [ln('113001', 500_000n, 0n, { customerId: 'c1' }), ln('411001', 0n, 500_000n, { taxRole: 'BASE', taxCode: 'Z_SALE' }), saleZero()];
  assert.doesNotThrow(() => validateMove(mv(lines, { origin: 'AUTO', moveType: 'OUT_INVOICE' }), ctx));
  const manual = [ln('113004', 500_000n, 0n), ln('411001', 0n, 500_000n), saleZero()];
  const r = validateMove(mv(manual), ctx);
  assert.equal(r.lines[2].isMarker, true);
  assert.equal(r.lines[2].tax?.key, 'Z_SALE');
});

test('MARKER: علامة بمبلغ مدين أو دائن تُرفض', () => {
  expectCode(mv([ln('113004', 1000n, 0n), ln('411001', 0n, 990n), saleZero({ creditMilli: 10n })]), 'LEDGER_UNBALANCED', 'MARKER_WITH_AMOUNT');
  expectCode(mv([ln('113004', 1000n, 0n), ln('411001', 0n, 1010n), saleZero({ debitMilli: 10n })]), 'LEDGER_UNBALANCED', 'MARKER_WITH_AMOUNT');
});

test('MARKER: على حساب مؤرشف ⇒ LEDGER_ACCOUNT_ARCHIVED (آلياً ويدوياً)', () => {
  const lines = [ln('113001', 1000n, 0n, { customerId: 'c1' }), ln('411001', 0n, 1000n), saleZero({ accountCode: '212099' })];
  const err = expectCode(mv(lines, { origin: 'AUTO' }), 'LEDGER_ACCOUNT_ARCHIVED', 'ACCOUNT_ARCHIVED');
  assert.equal(err.details.lineIndex, 2);
  assert.equal(err.details.accountCode, '212099');
  expectCode(mv([ln('113004', 1000n, 0n), ln('411001', 0n, 1000n), saleZero({ accountCode: '212099' })]), 'LEDGER_ACCOUNT_ARCHIVED');
});

test('MARKER: سطور العلامة لا تُحتسب في حد السطرين', () => {
  const oneLine = mv([ln('611001', 1000n, 0n), saleZero(), saleZero({ taxCode: 'CIT_SALE', vatBox: null })], { origin: 'AUTO' });
  const report = collectMoveIssues(oneLine, ctx);
  assert.equal(report.nonZeroLineCount, 1);
  assert.ok(report.issues.some((i) => i.reason === 'TOO_FEW_LINES'));
  const onlyMarkers = mv([saleZero(), saleZero()], { origin: 'AUTO' });
  expectCode(onlyMarkers, 'LEDGER_UNBALANCED', 'TOO_FEW_LINES');
  const ok = mv([ln('113001', 1000n, 0n, { customerId: 'c1' }), ln('411001', 0n, 1000n), saleZero(), saleZero({ taxCode: 'CIT_SALE', vatBox: null })], { origin: 'AUTO' });
  assert.equal(collectMoveIssues(ok, ctx).nonZeroLineCount, 2);
  assert.ok(isValidMove(ok, ctx));
});

test('MARKER: بلا ضريبة محلولة، أو بضريبة غير صفرية، أو بلا وعاء ⇒ يُرفض', () => {
  const pre = [ln('113001', 1000n, 0n, { customerId: 'c1' }), ln('411001', 0n, 1000n)];
  const auto = { origin: 'AUTO' as const };
  expectCode(mv([...pre, saleZero({ taxCode: null })], auto), 'LEDGER_UNBALANCED', 'MARKER_WITHOUT_TAX');
  expectCode(mv([...pre, saleZero({ taxCode: 'NOPE' })], auto), 'LEDGER_UNBALANCED', 'MARKER_WITHOUT_TAX');
  expectCode(mv([...pre, saleZero({ taxCode: 'S15_SALE' })], auto), 'LEDGER_UNBALANCED', 'MARKER_NONZERO_RATE');
  expectCode(mv([...pre, saleZero({ taxBaseMilli: null })], auto), 'LEDGER_UNBALANCED', 'MARKER_WITHOUT_BASE');
  // taxId يُقدَّم على taxCode، والوعاء السالب مع vatAdjustment مقبول (مرتجع صفري)
  assert.ok(isValidMove(mv([ln('411001', 1000n, 0n), ln('113001', 0n, 1000n, { customerId: 'c1' }),
    saleZero({ taxId: 't-z', taxCode: 'S15_SALE', taxBaseMilli: -1000n, vatAdjustment: true })], { origin: 'AUTO', moveType: 'OUT_REFUND' }), ctx));
  // علامة بلا مربع (دولة بلا مربعات ZATCA) مقبولة في القيد الآلي
  assert.ok(isValidMove(mv([...pre, saleZero({ taxCode: 'CIT_SALE', vatBox: null })], auto), ctx));
});

// ═══ I3 ═══

test('I3: حساب مؤرشف ⇒ LEDGER_ACCOUNT_ARCHIVED في الوضعين', () => {
  const m = mv([ln('611099', 100n, 0n), ln('111001', 0n, 100n)]);
  expectCode(m, 'LEDGER_ACCOUNT_ARCHIVED', 'ACCOUNT_ARCHIVED');
  expectCode(m, 'LEDGER_ACCOUNT_ARCHIVED', 'ACCOUNT_ARCHIVED', 'SYSTEM');
});

test('I3: equity_unaffected (319001) لا يُقيد عليه في أي وضع', () => {
  const m = mv([ln('319001', 100n, 0n), ln('111001', 0n, 100n)]);
  expectCode(m, 'LEDGER_ACCOUNT_ARCHIVED', 'EQUITY_UNAFFECTED');
  expectCode(m, 'LEDGER_ACCOUNT_ARCHIVED', 'EQUITY_UNAFFECTED', 'SYSTEM');
  expectCode(mv([ln('319001', 100n, 0n), ln('911001', 0n, 100n)], { moveType: 'CONTROL_ADJUSTMENT', needsAttention: true }), 'LEDGER_ACCOUNT_ARCHIVED', 'EQUITY_UNAFFECTED');
});

// ═══ I4 ═══

for (const code of ['113001', '211001', '111003', '112005', '114001']) {
  test(`I4: الحساب الرئيسي ${code} ممنوع يدوياً ومسموح آلياً`, () => {
    const partner = code === '113001' ? { customerId: 'c1' } : code === '211001' ? { vendorId: 'v1' } : { salesRepId: 'r1' };
    const m = mv([ln(code, 100n, 0n, partner), ln('911001', 0n, 100n)]);
    expectCode(m, 'LEDGER_CONTROL_ACCOUNT_MANUAL', 'CONTROL_ACCOUNT_MANUAL');
    assert.ok(isValidMove(m, ctx, { mode: 'SYSTEM' }));
  });
}

test('I4: CONTROL_ADJUSTMENT يُعفى بنوع القيد وحده، ولا يُعفى من I1–I3 وI5 وI8', () => {
  const adj = { moveType: 'CONTROL_ADJUSTMENT' as MoveType, needsAttention: true };
  assert.ok(isValidMove(mv([ln('113001', 100n, 0n, { customerId: 'c1' }), ln('911001', 0n, 100n)], adj), ctx));
  assert.ok(isValidMove(mv([ln('911001', 100n, 0n), ln('111003', 0n, 100n, { salesRepId: 'r1' })], adj), ctx));
  // أنواع أخرى يدوية لا تُعفى
  for (const moveType of ['ENTRY', 'CUSTOMER_ADJUSTMENT', 'OPENING'] as MoveType[]) {
    expectCode(mv([ln('113001', 100n, 0n, { customerId: 'c1' }), ln('911001', 0n, 100n)], { moveType }), 'LEDGER_CONTROL_ACCOUNT_MANUAL');
  }
  expectCode(mv([ln('113001', 100n, 0n, { customerId: 'c1' }), ln('911001', 0n, 90n)], adj), 'LEDGER_UNBALANCED', 'UNBALANCED');
  expectCode(mv([ln('113001', 100n, 0n), ln('911001', 0n, 100n)], adj), 'LEDGER_PARTNER_REQUIRED', 'CUSTOMER_REQUIRED');
  expectCode(mv([ln('113001', 100n, 0n, { customerId: 'c1' }), ln('991001', 0n, 100n)], adj), 'LEDGER_OFF_BALANCE_MIXED');
});

test('I4: 911001 (SUSPENSE) خارج المنع اليدوي', () => {
  assert.ok(isValidMove(mv([ln('911001', 100n, 0n), ln('611001', 0n, 100n)]), ctx));
});

test('LEDGER_VAT_LINE_UNTAGGED: سطر يدوي على VAT_OUT/VAT_IN بلا ضريبة أو بلا مربع', () => {
  // بلا ضريبة
  expectCode(mv([ln('212001', 1500n, 0n, { vatBox: 'SA_1' }), ln('111001', 0n, 1500n)]), 'LEDGER_VAT_LINE_UNTAGGED', 'VAT_LINE_UNTAGGED');
  // بلا مربع
  expectCode(mv([ln('212001', 1500n, 0n, { taxCode: 'S15_SALE' }), ln('111001', 0n, 1500n)]), 'LEDGER_VAT_LINE_UNTAGGED');
  expectCode(mv([ln('116001', 1500n, 0n, { taxId: 't-p15', vatBox: '  ' }), ln('111001', 0n, 1500n)]), 'LEDGER_VAT_LINE_UNTAGGED');
  // taxId لا يُحلّ
  expectCode(mv([ln('116001', 1500n, 0n, { taxId: 'ghost', vatBox: 'SA_7' }), ln('111001', 0n, 1500n)]), 'LEDGER_VAT_LINE_UNTAGGED');
  // بلا الاثنين على VAT_IN
  expectCode(mv([ln('116001', 1500n, 0n), ln('111001', 0n, 1500n)]), 'LEDGER_VAT_LINE_UNTAGGED');
  // موسوم ⇒ مقبول
  assert.ok(isValidMove(mv([ln('116001', 1500n, 0n, { taxId: 't-p15', vatBox: 'SA_7', taxRole: 'TAX', taxBaseMilli: 10_000n }), ln('111001', 0n, 1500n)]), ctx));
  assert.ok(isValidMove(mv([ln('111001', 1500n, 0n), ln('212001', 0n, 1500n, { taxCode: 'S15_SALE', vatBox: 'SA_1' })]), ctx));
  // آلياً لا يُطبَّق (عمولة D2 قبل الفاتورة الضريبية لا تمسّ 116001 أصلاً، والسطور الآلية موسومة من الـbuilder)
  assert.ok(isValidMove(mv([ln('116001', 1500n, 0n), ln('111001', 0n, 1500n)], { origin: 'AUTO' }), ctx));
});

// ═══ I5 ═══

test('I5: سطر 113001 بلا customerId وسطر 211001 بلا vendorId ⇒ LEDGER_PARTNER_REQUIRED (آلياً أيضاً)', () => {
  const auto = { origin: 'AUTO' as const };
  expectCode(mv([ln('113001', 100n, 0n), ln('411001', 0n, 100n)], auto), 'LEDGER_PARTNER_REQUIRED', 'CUSTOMER_REQUIRED');
  expectCode(mv([ln('113001', 100n, 0n, { customerId: '' }), ln('411001', 0n, 100n)], auto), 'LEDGER_PARTNER_REQUIRED', 'CUSTOMER_REQUIRED');
  expectCode(mv([ln('611001', 100n, 0n), ln('211001', 0n, 100n)], auto), 'LEDGER_PARTNER_REQUIRED', 'VENDOR_REQUIRED');
  // vendorId لا يغني عن customerId على AR
  expectCode(mv([ln('113001', 100n, 0n, { vendorId: 'v1' }), ln('411001', 0n, 100n)], auto), 'LEDGER_PARTNER_REQUIRED', 'CUSTOMER_REQUIRED');
  assert.equal(new LedgerError('LEDGER_PARTNER_REQUIRED').httpStatus, 422);
  // ذمم مدينة أخرى (113004) ليست حساباً رئيسياً ⇒ بلا شرط شريك
  assert.ok(isValidMove(mv([ln('113004', 100n, 0n), ln('411001', 0n, 100n)]), ctx));
});

// ═══ I8 ═══

test('I8: قيد يخلط 991001 بـ111001 يُرفض يدوياً وآلياً', () => {
  const m = mv([ln('991001', 100n, 0n), ln('111001', 0n, 100n)]);
  const err = expectCode(m, 'LEDGER_OFF_BALANCE_MIXED', 'OFF_BALANCE_MIXED');
  assert.equal(err.httpStatus, 422);
  expectCode(m, 'LEDGER_OFF_BALANCE_MIXED', 'OFF_BALANCE_MIXED', 'SYSTEM');
  // خلط متوازن داخل كل جانب لا يغني
  expectCode(mv([ln('991001', 100n, 0n), ln('991002', 0n, 100n), ln('611001', 50n, 0n), ln('111001', 0n, 50n)]), 'LEDGER_OFF_BALANCE_MIXED');
});

test('I8: قيد 991001/991002 وحده يُقبل', () => {
  assert.ok(isValidMove(mv([ln('991001', 250_000n, 0n), ln('991002', 0n, 250_000n)]), ctx));
  assert.ok(isValidMove(mv([ln('991002', 250_000n, 0n), ln('991001', 0n, 250_000n)], { origin: 'AUTO' }), ctx));
});

test('I8: علامة على حساب ضريبة داخل قيد خارج الميزانية تُعدّ خلطاً', () => {
  expectCode(mv([ln('991001', 100n, 0n), ln('991002', 0n, 100n), saleZero()], { origin: 'AUTO' }), 'LEDGER_OFF_BALANCE_MIXED');
});

// ═══ التجميع والتفاصيل ═══

test('collectMoveIssues يجمع كل المخالفات، وvalidateMove يرمي أولاها مع القائمة كاملة', () => {
  const m = mv([ln('113001', 100n, 0n), ln('611099', 0n, 90n), ln('411001', 0n, 0n)]);
  const report = collectMoveIssues(m, ctx);
  assert.deepEqual(report.issues.map((i) => i.reason), [
    'CONTROL_ACCOUNT_MANUAL', 'CUSTOMER_REQUIRED', 'ACCOUNT_ARCHIVED', 'ZERO_LINE_NOT_MARKER', 'UNBALANCED',
  ]);
  const err = expectCode(m, 'LEDGER_CONTROL_ACCOUNT_MANUAL');
  assert.equal(err.details.invariant, 'I4');
  assert.equal(err.details.lineIndex, 0);
  assert.equal((err.details.issues as unknown[]).length, 5);
});

test('متجهات عشوائية: القيد المتوازن الصحيح يُقبل دائماً، وأي إزاحة ملّي واحد تُرفض', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const debitSide = ['611001', '111001', '113004', '911001'];
  const creditSide = ['411001', '111001', '911001'];
  for (let k = 0; k < 500; k++) {
    const n = 1 + Math.floor(rnd() * 4);
    const lines: LineDraft[] = [];
    let total = 0n;
    for (let i = 0; i < n; i++) {
      const a = BigInt(1 + Math.floor(rnd() * 1_000_000)) * 10n;
      total += a;
      lines.push(ln(debitSide[Math.floor(rnd() * debitSide.length)], a, 0n));
    }
    lines.push(ln(creditSide[Math.floor(rnd() * creditSide.length)], 0n, total));
    assert.ok(isValidMove(mv(lines), ctx), `حالة ${k}`);
    const bad = lines.map((l, i) => (i === 0 ? { ...l, debitMilli: l.debitMilli + 1n } : l));
    assert.equal(isValidMove(mv(bad), ctx), false);
  }
});

test('validate.ts صرف: لا prisma ولا I/O', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/gl/validate.ts'), 'utf8');
  assert.doesNotMatch(src, /prisma|@prisma\/client|from ['"](node:)?(fs|http|https|net|child_process)['"]/);
});
