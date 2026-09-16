// M1 — وصفتا الدفع الإلكتروني P9 (العمولة وقرار D2) وP10 (التوريد) — DESIGN.md §5.5، §2.2، §10.1، §10.3 D2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPaylinkFeeMove, buildPayoutMove, isPaylinkFeeVatRecoverable, paylinkFeeKey, payoutKey,
  type PaylinkFeePayload,
} from '../services/gl/builders/paylink';
import { validateMove } from '../services/gl/validate';
import { saContext, accountIdOf, taxIdOf, type FixtureOverrides } from '../services/gl/testing/fixtures';
import { isNoMove, type BuildContext, type BuildResult, type MoveDraft } from '../services/gl/types';
import { applyAutoLockShift, lockScopeOfDraft } from '../services/gl/locks';

const ARABIC = /[؀-ۿ]/;

function asMove(r: BuildResult): MoveDraft {
  assert.equal(r.kind, 'MOVE');
  return r as MoveDraft;
}

/** تحقق G6 (ز)/G7 وvalidate.ts على كل قيد ناتج */
function checkMove(m: MoveDraft, ctx: BuildContext): void {
  assert.ok(m.narration.trim() && ARABIC.test(m.narration), 'narration عربي غير فارغ');
  for (const l of m.lines) {
    assert.ok(l.label.trim() && ARABIC.test(l.label), 'label عربي غير فارغ');
    if (l.customerId || l.vendorId || l.salesRepId) assert.ok(l.partnerName?.trim(), 'partnerName مملوء');
  }
  const v = validateMove(m, ctx);
  assert.equal(v.totalDebitMilli, v.totalCreditMilli);
}

function lineOn(m: MoveDraft, ctx: BuildContext, code: string) {
  return m.lines.filter(l => {
    const acc = l.accountId ? ctx.accounts.byId(l.accountId)
      : l.accountCode ? ctx.accounts.byCode(l.accountCode)
        : l.accountKey ? ctx.accounts.byKey(l.accountKey) : null;
    return acc?.code === code;
  });
}

const FEE_41 = (createdAt: string, extra: Partial<PaylinkFeePayload> = {}): PaylinkFeePayload => ({
  entryId: 'se-fee-1', amount: '-41.00', feeNet: '35.65', feeVat: '5.35', createdAt, linkId: 'link-1', ...extra,
});

function assertNonRecoverable(m: MoveDraft, ctx: BuildContext): void {
  assert.equal(m.lines.length, 2);
  const exp = lineOn(m, ctx, '611007');
  assert.equal(exp.length, 1);
  assert.equal(exp[0].debitMilli, 41_000n);
  assert.equal(exp[0].creditMilli, 0n);
  const plnk = lineOn(m, ctx, '112005');
  assert.equal(plnk.length, 1);
  assert.equal(plnk[0].creditMilli, 41_000n);
  assert.equal(lineOn(m, ctx, '116001').length, 0, 'لا سطر 116001');
  for (const l of m.lines) {
    assert.ok(!l.taxId && !l.taxCode && !l.vatBox && !l.taxRole, 'بلا taxId ولا taxCode ولا vatBox ولا علامة');
    assert.ok(l.taxBaseMilli === undefined || l.taxBaseMilli === null);
  }
}

test('D2: paylinkFeeTaxInvoiceFrom = null ⇒ 611007 = 41.00 و112005 = 41.00 بلا ضريبة', () => {
  const ctx = saContext();
  assert.equal(ctx.settings.paylinkFeeTaxInvoiceFrom, null);
  const m = asMove(buildPaylinkFeeMove(FEE_41('2027-06-15T10:00:00Z'), ctx));
  checkMove(m, ctx);
  assertNonRecoverable(m, ctx);
  assert.equal(m.needsAttention, false);
  assert.equal(m.journalCode, 'PLNK');
  assert.equal(m.journalSystemKey, 'PAYLINK');
  assert.equal(m.moveType, 'PAYLINK_FEE');
  assert.equal(m.origin, 'AUTO');
  assert.equal(m.sourceType, 'PAYLINK_FEE');
  assert.equal(m.sourceId, 'se-fee-1');
  assert.equal(m.sourceKey, paylinkFeeKey('se-fee-1'));
  assert.equal(m.sourceKey, 'PAYLINK_FEE:se-fee-1');
  assert.equal(m.date, '2027-06-15');
  assert.equal(m.currencyCode, 'SAR');
});

test('D2: التاريخ 2027-03-01 — 23:59:59 بالرياض قبله ⇒ غير مستردة', () => {
  const ctx = saContext({ settings: { paylinkFeeTaxInvoiceFrom: '2027-03-01' } });
  const createdAt = '2027-02-28T20:59:59Z';
  assert.equal(isPaylinkFeeVatRecoverable(createdAt, ctx.settings), false);
  const m = asMove(buildPaylinkFeeMove(FEE_41(createdAt), ctx));
  checkMove(m, ctx);
  assertNonRecoverable(m, ctx);
  assert.equal(m.date, '2027-02-28');
  assert.equal(m.needsAttention, false);
});

test('D2: التاريخ 2027-03-01 — 00:00 بالرياض ⇒ مستردة: 611007 = 35.65 و116001 = 5.35 (S15_PURCH، TAX، SA_7)', () => {
  const ctx = saContext({ settings: { paylinkFeeTaxInvoiceFrom: '2027-03-01' } });
  const createdAt = '2027-02-28T21:00:00Z';
  assert.equal(isPaylinkFeeVatRecoverable(createdAt, ctx.settings), true);
  const m = asMove(buildPaylinkFeeMove(FEE_41(createdAt), ctx));
  checkMove(m, ctx);
  assert.equal(m.date, '2027-03-01');
  assert.equal(m.lines.length, 3);
  const exp = lineOn(m, ctx, '611007');
  assert.equal(exp.length, 1);
  assert.equal(exp[0].debitMilli, 35_650n);
  assert.ok(!exp[0].taxId && !exp[0].vatBox);
  const vat = lineOn(m, ctx, '116001');
  assert.equal(vat.length, 1);
  assert.equal(vat[0].debitMilli, 5_350n);
  assert.equal(vat[0].creditMilli, 0n);
  assert.equal(vat[0].taxId, taxIdOf('S15_PURCH'));
  assert.equal(vat[0].taxCode, 'S15_PURCH');
  assert.equal(vat[0].taxRole, 'TAX');
  assert.equal(vat[0].taxBaseMilli, 35_650n);
  assert.equal(vat[0].vatBox, 'SA_7');
  assert.equal(vat[0].accountId, accountIdOf('116001'));
  const plnk = lineOn(m, ctx, '112005');
  assert.equal(plnk.length, 1);
  assert.equal(plnk[0].creditMilli, 41_000n);
  assert.equal(m.lines.filter(l => l.taxRole === 'MARKER').length, 0);
  assert.equal(m.needsAttention, false);
});

test('D2: القرار بتاريخ العمولة الأصلي لا بتاريخ القيد المُزاح', () => {
  // إقفال ضريبي/نهائي يزيح القيد إلى ما بعد تاريخ السريان، والعمولة نفسها قبله ⇒ تبقى غير مستردة
  const locks = { salesLockDate: null, purchaseLockDate: null, taxLockDate: null, hardLockDate: '2027-03-31' };
  const ctx = saContext({ settings: { paylinkFeeTaxInvoiceFrom: '2027-03-01', ...locks } });
  const before = asMove(buildPaylinkFeeMove(FEE_41('2027-02-28T20:59:59Z'), ctx));
  const shifted = applyAutoLockShift(before, ctx.settings, lockScopeOfDraft(before, ctx));
  assert.equal(shifted.date, '2027-04-01');
  assert.equal(shifted.lateArrival, true);
  assert.equal(shifted.originalDate, '2027-02-28');
  checkMove(shifted, ctx);
  assertNonRecoverable(shifted, ctx);

  // والعكس: عمولة بعد السريان تبقى مستردة وإن أُزيحت
  const after = asMove(buildPaylinkFeeMove(FEE_41('2027-03-10T09:00:00Z', { entryId: 'se-fee-2' }), ctx));
  const shifted2 = applyAutoLockShift(after, ctx.settings, lockScopeOfDraft(after, ctx));
  assert.equal(shifted2.date, '2027-04-01');
  assert.equal(lineOn(shifted2, ctx, '116001')[0].debitMilli, 5_350n);
  checkMove(shifted2, ctx);
});

test('P9: تفصيل ضريبة غير صالح أو ضريبة غير متاحة بعد السريان ⇒ كاملةً مصروفاً مع needsAttention', () => {
  const ctx = saContext({ settings: { paylinkFeeTaxInvoiceFrom: '2027-01-01' } });
  const noSplit = asMove(buildPaylinkFeeMove(FEE_41('2027-05-01T08:00:00Z', { feeNet: null, feeVat: null }), ctx));
  checkMove(noSplit, ctx);
  assertNonRecoverable(noSplit, ctx);
  assert.equal(noSplit.needsAttention, true);
  assert.ok(noSplit.attentionReason && ARABIC.test(noSplit.attentionReason));

  const badSum = asMove(buildPaylinkFeeMove(FEE_41('2027-05-01T08:00:00Z', { feeVat: '5.36' }), ctx));
  checkMove(badSum, ctx);
  assertNonRecoverable(badSum, ctx);
  assert.equal(badSum.needsAttention, true);

  const overrides: FixtureOverrides = { settings: { paylinkFeeTaxInvoiceFrom: '2027-01-01' }, taxes: { S15_PURCH: { isActive: false } } };
  const ctxNoTax = saContext(overrides);
  const noTax = asMove(buildPaylinkFeeMove(FEE_41('2027-05-01T08:00:00Z'), ctxNoTax));
  checkMove(noTax, ctxNoTax);
  assertNonRecoverable(noTax, ctxNoTax);
  assert.equal(noTax.needsAttention, true);

  // غير مستردة بالتاريخ: غياب التفصيل لا يستدعي تنبيهاً
  const plain = asMove(buildPaylinkFeeMove(FEE_41('2026-12-31T08:00:00Z', { feeNet: null, feeVat: null }), ctx));
  assert.equal(plain.needsAttention, false);
});

test('P9: عمولة صفرية ⇒ NO_MOVE(ZERO_VALUE)، وصف FEE موجب ⇒ خطأ', () => {
  const ctx = saContext();
  const r = buildPaylinkFeeMove({ entryId: 'z', amount: '0', feeNet: '0', feeVat: '0', createdAt: '2027-01-01T00:00:00Z' }, ctx);
  assert.ok(isNoMove(r));
  assert.equal(r.reason, 'ZERO_VALUE');
  assert.throws(() => buildPaylinkFeeMove(FEE_41('2027-01-01T00:00:00Z', { amount: '41.00' }), ctx), RangeError);
});

test('D2: isPaylinkFeeVatRecoverable يحترم منطقة الشركة', () => {
  const s = { paylinkFeeTaxInvoiceFrom: '2027-03-01', timezone: 'UTC' };
  assert.equal(isPaylinkFeeVatRecoverable('2027-02-28T21:00:00Z', s), false);
  assert.equal(isPaylinkFeeVatRecoverable('2027-03-01T00:00:00Z', s), true);
  assert.equal(isPaylinkFeeVatRecoverable(new Date('2027-03-01T00:00:00Z'), { ...s, paylinkFeeTaxInvoiceFrom: null }), false);
});

test('P10: التوريد ⇒ مدين 112001 (PAYLINK_PAYOUT_ACCOUNT) / دائن 112005', () => {
  const ctx = saContext();
  const m = asMove(buildPayoutMove({ payoutId: 'po-1', amount: '-1250.40', createdAt: '2027-04-08T22:30:00Z', bankReference: 'TRX-9' }, ctx));
  checkMove(m, ctx);
  assert.equal(m.date, '2027-04-09');
  assert.equal(m.moveType, 'PAYLINK_PAYOUT');
  assert.equal(m.journalCode, 'PLNK');
  assert.equal(m.sourceType, 'PAYOUT');
  assert.equal(m.sourceKey, payoutKey('po-1'));
  assert.equal(m.sourceKey, 'PAYOUT:po-1');
  assert.equal(m.ref, 'TRX-9');
  assert.equal(lineOn(m, ctx, '112001')[0].debitMilli, 1_250_400n);
  assert.equal(lineOn(m, ctx, '112005')[0].creditMilli, 1_250_400n);
  assert.equal(m.lines.length, 2);
  assert.ok(isNoMove(buildPayoutMove({ payoutId: 'po-0', amount: '0', createdAt: '2027-04-08T00:00:00Z' }, ctx)));
  assert.throws(() => buildPayoutMove({ payoutId: 'po-x', amount: '10', createdAt: '2027-04-08T00:00:00Z' }, ctx), RangeError);
});

test('مجموع العمولة والتوريد: أثر 112005 = Σ صفوف FEE وPAYOUT في دفتر الأمانات', () => {
  const ctx = saContext({ settings: { paylinkFeeTaxInvoiceFrom: '2027-03-01' } });
  // صفوف SettlementEntry كما تكتبها settlement.ts (computePaylinkFee: 4٪ + 1)
  const fees: PaylinkFeePayload[] = [
    { entryId: 'f1', amount: '-41.00', feeNet: '35.65', feeVat: '5.35', createdAt: '2027-02-20T10:00:00Z' },
    { entryId: 'f2', amount: '-5.00', feeNet: '4.35', feeVat: '0.65', createdAt: '2027-02-28T21:00:00Z' },
    { entryId: 'f3', amount: '-13.49', feeNet: '11.73', feeVat: '1.76', createdAt: '2027-03-05T12:00:00Z' },
  ];
  const payouts = [{ payoutId: 'p1', amount: '-900.51', createdAt: '2027-03-11T09:00:00Z' }];
  const moves = [
    ...fees.map(f => asMove(buildPaylinkFeeMove(f, ctx))),
    ...payouts.map(p => asMove(buildPayoutMove(p, ctx))),
  ];
  let plnkCredit = 0n; let expense = 0n; let inputVat = 0n; let bank = 0n;
  for (const m of moves) {
    checkMove(m, ctx);
    for (const l of lineOn(m, ctx, '112005')) plnkCredit += l.creditMilli - l.debitMilli;
    for (const l of lineOn(m, ctx, '611007')) expense += l.debitMilli - l.creditMilli;
    for (const l of lineOn(m, ctx, '116001')) inputVat += l.debitMilli - l.creditMilli;
    for (const l of lineOn(m, ctx, '112001')) bank += l.debitMilli - l.creditMilli;
  }
  // Σ الصفوف الموقَّعة = −(41 + 5 + 13.49 + 900.51) = −960.00
  assert.equal(plnkCredit, 960_000n);
  // f1 غير مستردة (41)، وf2 وf3 مستردتان
  assert.equal(expense, 41_000n + 4_350n + 11_730n);
  assert.equal(inputVat, 650n + 1_760n);
  assert.equal(expense + inputVat, 59_490n);
  assert.equal(bank, 900_510n);
});

test('الـbuilder صرف: لا prisma ولا I/O', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/gl/builders/paylink.ts'), 'utf8');
  const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(specs.length > 0);
  for (const spec of specs) assert.match(spec, /^\.\.\/(types|money|dates)$/);
  assert.doesNotMatch(src, /require\(/);
});
