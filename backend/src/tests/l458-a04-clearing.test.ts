// «ربط الدفاتر» L5 — A4: مستندات التسوية الموجّهة للحسابات الوسيطة (العقد §5.2، C3/C5، E5.14).
// صرفة بلا قاعدة: الـbuilder (متّزن، والتحقق اليدوي I4 يقبله)، ورفض المبالغ غير المتّسقة، والمتبقّي المفتوح بعد المطابقات
// وزوج العكس، وخطة المطابقة بالأقدم فالأقدم، ومسار POST /clearing كاملاً بمعاملة مزيّفة (قيد ⇒ مطابقات CLR ⇒ تدقيق RECONCILE)
// — وحراس ثابتة على المسار (الصلاحيات، والعزل بالشركة في SQL، ولا يمسّ المسارات التشغيلية).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLEARING_KINDS, buildClearingMove, clearingAccountOf, clearingFeeTax, clearingInputProblems, clearingSourceRef,
  openClearingLines, openResidualTotal, planClearingMatches,
  type ClearingInput, type ClearingLineRow, type ClearingOpenLine,
} from '../services/gl/builders/clearing';
import {
  amountMilliOf, bankJournalCodeFor, clearingBodySchema, clearingInvalid, executeClearing,
  type ClearingBody, type ClearingDeps,
} from '../routes/ledger/clearing';
import { ledgerErrorResponse, LedgerHttpError } from '../routes/ledger/errors';
import { CARD_CLEARING_CODE, linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, genericContext, journalIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import { GlNotFoundError, type GlDb, type GlSettingsRow, type LedgerContext } from '../services/gl/resolve';
import type { GlActor } from '../services/gl/audit';
import type { PostedMove } from '../services/gl/post';
import {
  createBuildContext, isLedgerError,
  type AccountRef, type BuildContext, type JournalRef, type LineDraft, type MoveDraft, type TaxRef,
} from '../services/gl/types';

// ═══ السياق ═══

const RAJHI: AccountRef = { id: accountIdOf('111102'), code: '111102', name: 'بنك الراجحي', type: 'asset_cash', isActive: true, reconcile: true, controlKind: null };
const MADA2: AccountRef = { id: accountIdOf('112008'), code: '112008', name: 'مدى البنك الثاني تحت التسوية', type: 'asset_current', isActive: true, reconcile: true, controlKind: null };
const RAJHI_JOURNAL: JournalRef = {
  id: journalIdOf('BNK2'), code: 'BNK2', name: 'بنك الراجحي', type: 'BANK', systemKey: null, defaultAccountId: RAJHI.id,
  suspenseAccountId: null, useOutstandingAccounts: false, sequenceReset: 'YEARLY', isActive: true,
};

interface Opts { linked?: boolean; dec?: number; maps?: Record<string, string>; accounts?: Record<string, Partial<AccountRef> | null>; taxes?: Record<string, Partial<TaxRef> | null> }

function ledgerContext(o: Opts = {}): LedgerContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { currencyDecimals: o.dec ?? 2, ...(o.linked === false ? {} : { linkedPosting: true as const }) },
    extraAccounts: [...linkedAccountRefs(accountIdOf), RAJHI, MADA2],
    extraJournals: [RAJHI_JOURNAL],
    accounts: o.accounts,
    taxes: o.taxes,
  });
  const maps = o.maps
    ? Object.fromEntries(Object.entries(o.maps).map(([k, code]) => [k, { accountId: accountIdOf(code), journalId: null }]))
    : undefined;
  const ctx = createBuildContext({ ...input, ...(maps ? { paymentMethodMaps: maps } : {}) });
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
const ctxOf = (o: Opts = {}): BuildContext => ledgerContext(o).ctx;

const input = (p: Partial<ClearingInput> = {}): ClearingInput => ({
  kind: 'POS_SETTLEMENT', date: '2026-11-13', bankAccountId: accountIdOf('111101'),
  grossMilli: 2_000_000n, feeMilli: 51_730n, feeVatMilli: 7_770n, ref: 'STL-778', note: null, ...p,
});

/** يتحقق في الوضع اليدوي (I4 كما في postMove) ويعيد {الرمز: [مدين، دائن]} */
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

// ═══ الـbuilder ═══

test('E5.14 نقطة بيع: Dr 111101 1,940.50 / Dr 611008 51.73 / Dr 116001 7.77 [S15_PURCH، SA_7، وعاء 51.73] / Cr 112004 2,000.00', () => {
  const ctx = ctxOf();
  const m = buildClearingMove(input(), ctx);
  assert.deepEqual(manualSums(m, ctx), {
    '111101': [1_940_500n, 0n], '611008': [51_730n, 0n], '116001': [7_770n, 0n], '112004': [0n, 2_000_000n],
  });
  const vat = m.lines.find((l) => l.taxRole === 'TAX') as LineDraft;
  assert.equal(vat.taxId, taxIdOf('S15_PURCH'));
  assert.equal(vat.vatBox, 'SA_7');
  assert.equal(vat.taxBaseMilli, 51_730n);
  assert.equal(m.origin, 'MANUAL');
  assert.equal(m.moveType, 'RECONCILE');
  assert.equal(m.journalSystemKey, 'BANK_MAIN');
  assert.equal(m.journalCode, 'BNK1');
  assert.equal(m.ref, 'STL-778');
  assert.equal(m.sourceKey, null);
  assert.equal(m.needsAttention, false);
  for (const l of m.lines) assert.ok(!l.customerId && !l.salesRepId && !l.adminUserId, 'لا شريك على سطور التسوية');
});

test('E5.14: البطاقة الشكل نفسه على 112007، والشيكات 112003، والمقبوضات القديمة 112001 — كلها متّزنة ويقبلها التحقق اليدوي', () => {
  const ctx = ctxOf();
  const expected: Record<string, string> = {
    POS_SETTLEMENT: '112004', CARD_SETTLEMENT: CARD_CLEARING_CODE, CHEQUE_CLEARANCE: '112003', DEPOSIT_CLEARANCE: '112001',
  };
  for (const kind of CLEARING_KINDS) {
    const s = manualSums(buildClearingMove(input({ kind }), ctx), ctx);
    assert.deepEqual(s[expected[kind]], [0n, 2_000_000n], kind);
    assert.deepEqual(s['111101'], [1_940_500n, 0n], kind);
  }
  // الشيك بلا عمولة: Dr 111101 700 / Cr 112003 700 (E5.6 الخطوة الأخيرة)
  assert.deepEqual(
    manualSums(buildClearingMove(input({ kind: 'CHEQUE_CLEARANCE', grossMilli: 700_000n, feeMilli: 0n, feeVatMilli: 0n }), ctx), ctx),
    { '111101': [700_000n, 0n], '112003': [0n, 700_000n] },
  );
});

test('المنازل 0 و3، والصافي صفر (العمولة تستغرق الإجمالي) ⇒ لا سطر بنك والقيد متّزن', () => {
  const jod = ctxOf({ dec: 3 });
  assert.deepEqual(manualSums(buildClearingMove(input({ grossMilli: 1_234_567n, feeMilli: 12_345n, feeVatMilli: 1_852n }), jod), jod), {
    '111101': [1_220_370n, 0n], '611008': [12_345n, 0n], '116001': [1_852n, 0n], '112004': [0n, 1_234_567n],
  });
  const iqd = ctxOf({ dec: 0 });
  assert.deepEqual(manualSums(buildClearingMove(input({ grossMilli: 250_000_000n, feeMilli: 3_000_000n, feeVatMilli: 0n }), iqd), iqd), {
    '111101': [247_000_000n, 0n], '611008': [3_000_000n, 0n], '112004': [0n, 250_000_000n],
  });
  const ctx = ctxOf();
  const all = buildClearingMove(input({ grossMilli: 10_000n, feeMilli: 8_700n, feeVatMilli: 1_300n }), ctx);
  assert.deepEqual(manualSums(all, ctx), { '611008': [8_700n, 0n], '116001': [1_300n, 0n], '112004': [0n, 10_000n] });
});

test('المبالغ غير المتّسقة تُرفض: سالب، صفر، العمولة فوق الإجمالي، ضريبة بلا عمولة، منازل زائدة — والـbuilder يرمي LEDGER_CLEARING_INVALID', () => {
  const ctx = ctxOf();
  const reasons = (p: Partial<ClearingInput>) => clearingInputProblems(input(p), ctx).map((x) => x.reason);
  assert.deepEqual(reasons({}), []);
  assert.deepEqual(reasons({ grossMilli: -1_000n }), ['GROSS_NOT_POSITIVE']);
  assert.deepEqual(reasons({ grossMilli: 0n, feeMilli: 0n, feeVatMilli: 0n }), ['GROSS_NOT_POSITIVE']);
  assert.ok(reasons({ feeMilli: -10n }).includes('FEE_NEGATIVE'));
  assert.ok(reasons({ feeVatMilli: -10n }).includes('FEE_VAT_NEGATIVE'));
  assert.deepEqual(reasons({ grossMilli: 50_000n, feeMilli: 45_000n, feeVatMilli: 6_750n }), ['FEES_EXCEED_GROSS']);
  assert.deepEqual(reasons({ feeMilli: 0n, feeVatMilli: 7_770n }), ['FEE_VAT_WITHOUT_FEE']);
  assert.deepEqual(reasons({ grossMilli: 2_000_005n }), ['PRECISION'], 'ريال: 2000.005 ليس هللة');
  assert.deepEqual(clearingInputProblems(input({ grossMilli: 2_000_005n, feeMilli: 51_731n, feeVatMilli: 7_770n }), ctxOf({ dec: 3 })), []);
  assert.deepEqual(clearingInputProblems(input({ grossMilli: 2_000_500n }), ctxOf({ dec: 0 })).map((x) => x.field), ['gross', 'fee', 'feeVat']);
  assert.deepEqual(reasons({ date: '2026-02-30' }), ['INVALID_DATE']);
  try {
    buildClearingMove(input({ grossMilli: -5n }), ctx);
    assert.fail('يجب أن يرمي');
  } catch (e) {
    assert.ok(isLedgerError(e, 'LEDGER_CLEARING_INVALID'));
    assert.equal(e.details.reason, 'GROSS_NOT_POSITIVE');
    assert.equal(e.httpStatus, 422);
  }
});

test('حساب البنك: غير موجود، مؤرشف، ليس نقدياً، رقابي (عهدة المندوب/المستخدم) ⇒ مرفوض؛ والوسيط المفقود أو المؤرشف كذلك', () => {
  const ctx = ctxOf();
  const reasons = (p: Partial<ClearingInput>, c = ctx) => clearingInputProblems(input(p), c).map((x) => x.reason);
  assert.deepEqual(reasons({ bankAccountId: 'acc_nope' }), ['BANK_ACCOUNT_NOT_FOUND']);
  assert.deepEqual(reasons({ bankAccountId: accountIdOf('112003') }), ['BANK_ACCOUNT_NOT_CASH']);
  assert.deepEqual(reasons({ bankAccountId: accountIdOf('112004') }), ['BANK_ACCOUNT_NOT_CASH', 'BANK_IS_CLEARING']);
  assert.deepEqual(reasons({ bankAccountId: accountIdOf('111003') }), ['BANK_ACCOUNT_CONTROL']);
  assert.deepEqual(reasons({ bankAccountId: accountIdOf('111004') }), ['BANK_ACCOUNT_CONTROL']);
  assert.deepEqual(reasons({ bankAccountId: RAJHI.id }), []);
  assert.deepEqual(reasons({ bankAccountId: accountIdOf('111001') }), [], 'الصندوق مقبول (شيك صُرف نقداً)');
  assert.deepEqual(reasons({}, ctxOf({ accounts: { '111101': { isActive: false } } })), ['BANK_ACCOUNT_INACTIVE']);
  // البطاقة في شركة بلا 112007 (لم تُنشأ حسابات الربط) ⇒ الوسيط مفقود
  const noLinked = createBuildContext(templateContextInput(SA_6D_TEMPLATE, SA_TAXES, {}, {}));
  assert.deepEqual(clearingInputProblems(input({ kind: 'CARD_SETTLEMENT' }), noLinked).map((x) => x.reason), ['CLEARING_ACCOUNT_MISSING']);
  assert.deepEqual(reasons({}, ctxOf({ accounts: { '112004': { isActive: false } } })), ['CLEARING_ACCOUNT_INACTIVE']);
  assert.deepEqual(reasons({}, ctxOf({ accounts: { '611008': { isActive: false } } })), ['FEE_ACCOUNT_MISSING']);
});

test('ضريبة العمولة: الافتراضية للشركة ثم S15_PURCH؛ وبلا ضريبة صالحة (غير مفعّلة أو القالب العام بلا مربّع) ⇒ VAT_TAX_UNAVAILABLE، وبلا ضريبة عمولة تمرّ', () => {
  assert.equal(clearingFeeTax(ctxOf())?.key, 'S15_PURCH');
  const off = ctxOf({ taxes: { S15_PURCH: { isActive: false } } });
  assert.equal(clearingFeeTax(off), null);
  assert.deepEqual(clearingInputProblems(input(), off).map((x) => x.reason), ['VAT_TAX_UNAVAILABLE']);
  assert.deepEqual(clearingInputProblems(input({ feeMilli: 59_500n, feeVatMilli: 0n }), off), []);
  // القالب العام: ضريبة المشتريات بلا مربّع إقرار وحسابها VAT_IN ⇒ لا تصلح لقيد يدوي (I4)
  const eg = genericContext('EG');
  assert.equal(clearingFeeTax(eg), null);
});

test('المربوطة: الوسيط هو حساب الطريقة في خريطة الطرق إن كان وسيطاً، وإلا القالب؛ والإيداع دائماً 112001', () => {
  assert.equal(clearingAccountOf('POS_SETTLEMENT', ctxOf({ maps: { POS: '112008' } }))?.code, '112008');
  assert.equal(clearingAccountOf('POS_SETTLEMENT', ctxOf({ maps: { POS: '111102' } }))?.code, '112004', 'خريطة إلى البنك مباشرة ⇒ لا وسيط لها');
  assert.equal(clearingAccountOf('CARD_SETTLEMENT', ctxOf({ maps: { CARD: '112008' } }))?.code, '112008');
  assert.equal(clearingAccountOf('CHEQUE_CLEARANCE', ctxOf({ maps: { CHEQUE: '112008' } }))?.code, '112008');
  assert.equal(clearingAccountOf('DEPOSIT_CLEARANCE', ctxOf({ maps: { BANK_TRANSFER: '112008' } }))?.code, '112001');
  // غير المربوطة: القالب دائماً
  assert.equal(clearingAccountOf('POS_SETTLEMENT', ctxOf({ linked: false, maps: { POS: '112008' } }))?.code, '112004');
});

test('دفتر البنك المستلِم: دفتر BANK حسابه الافتراضي هو المختار، وإلا البنك الرئيسي؛ والرمز يعلو على المفتاح', () => {
  const lc = ledgerContext();
  assert.equal(bankJournalCodeFor(lc, RAJHI.id), 'BNK2');
  assert.equal(bankJournalCodeFor(lc, accountIdOf('111101')), 'BNK1');
  assert.equal(bankJournalCodeFor(lc, accountIdOf('111001')), 'CSH1');
  assert.equal(bankJournalCodeFor({ journals: lc.journals.map((j) => (j.code === 'BNK2' ? { ...j, isActive: false } : j)) }, RAJHI.id), null);
  const m = buildClearingMove(input({ bankAccountId: RAJHI.id, journalCode: 'BNK2' }), lc.ctx);
  assert.equal(m.journalCode, 'BNK2');
  assert.equal(m.journalSystemKey, undefined);
});

// ═══ المتبقّي المفتوح والمطابقة ═══

const row = (p: Partial<ClearingLineRow> & Pick<ClearingLineRow, 'lineId' | 'moveId'>): ClearingLineRow => ({
  moveNumber: `RCPT/2026/${p.moveId}`, date: '2026-11-01', label: 'تحصيل نقطة بيع', seq: 0, debitMilli: 300_000n, matchedMilli: 0n, ...p,
});

test('المتبقّي المفتوح: بعد المطابقات، وزوج العكس (مرآة تُغلق وردٌّ من الصندوق لا يُغلق)، والأقدم أولاً', () => {
  const rows: ClearingLineRow[] = [
    row({ lineId: 'l3', moveId: 'm3', date: '2026-11-03' }),
    row({ lineId: 'l1', moveId: 'm1', date: '2026-11-01', matchedMilli: 100_000n }), // مطابَق جزئياً بتسوية سابقة
    row({ lineId: 'l2', moveId: 'm2', date: '2026-11-02' }), // سند أُلغي بمرآته: دائن 112004 300 في عكسه
    row({ lineId: 'l4', moveId: 'm4', date: '2026-11-02' }), // سند أُلغي بردٍّ من الصندوق (C11): عكسه لا يمسّ 112004
    row({ lineId: 'l5', moveId: 'm5', date: '2026-11-04', debitMilli: 200_000n, seq: 0 }), // قيد بسطرين على الوسيط وعكس جزئي
    row({ lineId: 'l6', moveId: 'm5', date: '2026-11-04', debitMilli: 100_000n, seq: 1 }),
    row({ lineId: 'l7', moveId: 'm7', date: '2026-11-05', matchedMilli: 400_000n }), // مطابقة فوق المبلغ (بيانات شاذة) ⇒ صفر لا سالب
  ];
  const pair = new Map<string, bigint>([['m2', 300_000n], ['m5', 250_000n]]);
  const open = openClearingLines(rows, pair);
  assert.deepEqual(open.map((l) => [l.lineId, l.residualMilli]), [
    ['l1', 200_000n], ['l4', 300_000n], ['l3', 300_000n], ['l6', 50_000n],
  ]);
  assert.equal(openResidualTotal(open), 850_000n);
  assert.equal(open[0].amountMilli, 300_000n);
});

test('خطة المطابقة: الأقدم فالأقدم بحدّ المتبقّي، والأخير جزئياً، ومرجع CLR:<moveId>، ومجموعها = الإجمالي', () => {
  const open: ClearingOpenLine[] = openClearingLines([
    row({ lineId: 'b', moveId: 'mb', date: '2026-11-02' }),
    row({ lineId: 'a', moveId: 'ma', date: '2026-11-01' }),
    row({ lineId: 'c', moveId: 'mc', date: '2026-11-03' }),
  ], new Map());
  const plan = planClearingMatches(open, { lineId: 'cr', moveId: 'mv' }, 450_000n, clearingSourceRef('mv'));
  assert.deepEqual(plan, [
    { debitLineId: 'a', debitMoveId: 'ma', creditLineId: 'cr', creditMoveId: 'mv', amountMilli: 300_000n, sourceRef: 'CLR:mv' },
    { debitLineId: 'b', debitMoveId: 'mb', creditLineId: 'cr', creditMoveId: 'mv', amountMilli: 150_000n, sourceRef: 'CLR:mv' },
  ]);
  assert.equal(plan.reduce((s, m) => s + m.amountMilli, 0n), 450_000n);
  assert.deepEqual(planClearingMatches(open, { lineId: 'cr', moveId: 'mv' }, 0n, 'CLR:mv'), []);
  assert.equal(planClearingMatches(open, { lineId: 'cr', moveId: 'mv' }, 900_000n, 'CLR:mv').length, 3);
});

// ═══ POST /clearing: المعاملة كاملةً بمخزن مزيّف ═══

const ACTOR: GlActor = { actorType: 'ADMIN', actorId: 'adm1', actorName: 'المحاسب', impersonated: false };

interface FakeLine { id: string; tenantId: string; moveId: string; accountId: string; debitMilli: bigint; creditMilli: bigint }

function harness(o: { lc?: LedgerContext; open?: ClearingLineRow[]; pair?: Map<string, bigint>; balance?: bigint; lines?: FakeLine[] } = {}) {
  const lc = o.lc ?? ledgerContext();
  const log: string[] = [];
  const lines: FakeLine[] = [...(o.lines ?? [])];
  const partials: Record<string, unknown>[] = [];
  const posted: MoveDraft[] = [];
  const audits: { action: string; entityId?: string | null; after?: unknown }[] = [];
  const tx = {
    glMoveLine: {
      findMany: async (a: { where: { tenantId: string; id: { in: string[] } } }) =>
        lines.filter((l) => l.tenantId === a.where.tenantId && a.where.id.in.includes(l.id)).map((l) => ({ id: l.id, accountId: l.accountId })),
      findFirst: async (a: { where: { tenantId: string; moveId: string; accountId: string; creditMilli: { gt: bigint } } }) =>
        lines.find((l) => l.tenantId === a.where.tenantId && l.moveId === a.where.moveId && l.accountId === a.where.accountId && l.creditMilli > a.where.creditMilli.gt) ?? null,
    },
    glPartialReconcile: {
      createMany: async (a: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        assert.equal(a.skipDuplicates, true);
        partials.push(...a.data);
        log.push('partials');
        return { count: a.data.length };
      },
    },
  } as unknown as GlDb;
  const deps: ClearingDeps = {
    acquirePostLock: async () => { log.push('lock'); },
    loadBuildContext: async () => { log.push('context'); return lc; },
    loadOpenLines: async (_tx, tenantId, accountId) => {
      log.push(`open:${tenantId}:${accountId}`);
      return { lines: openClearingLines(o.open ?? [], o.pair ?? new Map()), truncated: false };
    },
    loadAccountBalance: async () => o.balance ?? 10_000_000n,
    postMove: (async (_tx: GlDb, draft: MoveDraft, opts: { tenantId: string; validationMode?: 'MANUAL' | 'SYSTEM'; lockPolicy?: string }) => {
      // كما postMove: التحقق بالوضع المطلوب (I4 اليدوي) — ثم سطور مرحّلة بمعرّفات
      assert.equal(opts.validationMode, 'MANUAL');
      assert.equal(opts.lockPolicy, 'REJECT');
      validateMove(draft, lc.ctx, { mode: 'MANUAL' });
      posted.push(draft);
      log.push('post');
      const id = 'mv-clr';
      draft.lines.forEach((l, i) => {
        const acc = resolveLineAccount(l, lc.ctx.accounts)!;
        lines.push({ id: `${id}:${i}`, tenantId: opts.tenantId, moveId: id, accountId: acc.id, debitMilli: l.debitMilli, creditMilli: l.creditMilli });
      });
      return { id, number: 'BNK1/2026/00007', date: draft.date } as PostedMove;
    }) as unknown as ClearingDeps['postMove'],
    appendAudit: (async (_tx: GlDb, a: { action: string; entityId?: string | null; after?: unknown }) => {
      audits.push(a);
      log.push(`audit:${a.action}`);
      return { id: 'au1', seq: 1, hash: 'h', prevHash: null };
    }) as unknown as ClearingDeps['appendAudit'],
  };
  return { lc, tx, deps, log, lines, partials, posted, audits };
}

const body = (p: Partial<ClearingBody> = {}): ClearingBody => clearingBodySchema.parse({
  kind: 'POS_SETTLEMENT', date: '2026-11-13', bankAccountId: accountIdOf('111101'), gross: 2000, fee: '51.73', feeVat: 7.77, ref: 'STL-778', ...p,
});

const POS_OPEN: ClearingLineRow[] = [
  row({ lineId: 'p1', moveId: 'r1', date: '2026-11-01', debitMilli: 1_200_000n }),
  row({ lineId: 'p2', moveId: 'r2', date: '2026-11-02', debitMilli: 500_000n }),
  row({ lineId: 'p3', moveId: 'r3', date: '2026-11-03', debitMilli: 600_000n }),
];

test('POST /clearing: القفل ⇒ السياق ⇒ المفتوح ⇒ القيد ⇒ مطابقات CLR ⇒ تدقيق RECONCILE — والردّ أرقام لا BigInt', async () => {
  const h = harness({ open: POS_OPEN });
  const r = await executeClearing(h.tx, { tenantId: 't1', actor: ACTOR, body: body() }, h.deps);
  assert.deepEqual(h.log, ['lock', 'context', `open:t1:${accountIdOf('112004')}`, 'post', 'partials', 'audit:RECONCILE']);
  assert.equal(h.posted.length, 1);
  assert.deepEqual(manualSums(h.posted[0], h.lc.ctx), {
    '111101': [1_940_500n, 0n], '611008': [51_730n, 0n], '116001': [7_770n, 0n], '112004': [0n, 2_000_000n],
  });
  // الأقدم فالأقدم: 1,200 + 500 + 300 من الثالث = 2,000
  const credit = h.lines.find((l) => l.moveId === 'mv-clr' && l.creditMilli > 0n)!;
  assert.deepEqual(h.partials, [
    { tenantId: 't1', debitLineId: 'p1', creditLineId: credit.id, amountMilli: 1_200_000n, sourceRef: 'CLR:mv-clr', debitMoveId: 'r1', creditMoveId: 'mv-clr', createdBy: 'adm1' },
    { tenantId: 't1', debitLineId: 'p2', creditLineId: credit.id, amountMilli: 500_000n, sourceRef: 'CLR:mv-clr', debitMoveId: 'r2', creditMoveId: 'mv-clr', createdBy: 'adm1' },
    { tenantId: 't1', debitLineId: 'p3', creditLineId: credit.id, amountMilli: 300_000n, sourceRef: 'CLR:mv-clr', debitMoveId: 'r3', creditMoveId: 'mv-clr', createdBy: 'adm1' },
  ]);
  assert.equal(h.audits[0].entityId, 'mv-clr');
  assert.deepEqual(r, {
    moveId: 'mv-clr', moveNumber: 'BNK1/2026/00007', date: '2026-11-13', kind: 'POS_SETTLEMENT',
    clearingAccount: { id: accountIdOf('112004'), code: '112004', name: 'مدى ونقاط البيع تحت التسوية' },
    bankAccountId: accountIdOf('111101'), gross: 2000, fee: 51.73, feeVat: 7.77, net: 1940.5, sourceRef: 'CLR:mv-clr',
    matched: [{ lineId: 'p1', moveId: 'r1', amount: 1200 }, { lineId: 'p2', moveId: 'r2', amount: 500 }, { lineId: 'p3', moveId: 'r3', amount: 300 }],
    matchedTotal: 2000,
  });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('POST /clearing: السطور المختارة وحدها (لا الأقدم)، ودفتر البنك المستلِم من حسابه', async () => {
  const h = harness({ open: POS_OPEN });
  const r = await executeClearing(h.tx, {
    tenantId: 't1', actor: ACTOR,
    body: body({ bankAccountId: RAJHI.id, gross: 1100, fee: 0, feeVat: 0, lineIds: ['p3', 'p2', 'p3'] }),
  }, h.deps);
  assert.equal(h.posted[0].journalCode, 'BNK2');
  assert.deepEqual(r.matched, [{ lineId: 'p2', moveId: 'r2', amount: 500 }, { lineId: 'p3', moveId: 'r3', amount: 600 }]);
  assert.deepEqual(manualSums(h.posted[0], h.lc.ctx), { '111102': [1_100_000n, 0n], '112004': [0n, 1_100_000n] });
});

async function rejects(p: Promise<unknown>, check: (e: unknown) => void): Promise<void> {
  try {
    await p;
  } catch (e) {
    check(e);
    return;
  }
  assert.fail('يجب أن يُرفض');
}

const isClearing422 = (reason: string) => (e: unknown) => {
  assert.ok(e instanceof LedgerHttpError, String(e));
  assert.equal(e.status, 422);
  assert.equal(e.code, 'LEDGER_CLEARING_INVALID');
  assert.equal(e.details.reason, reason);
  const res = ledgerErrorResponse(e)!;
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'LEDGER_CLEARING_INVALID');
  assert.match(String(res.body.message), /[؀-ۿ]/);
};

test('POST /clearing يرفض (422) قبل أي ترحيل: مبالغ غير متّسقة، سطر من حساب آخر، سطر غير مفتوح، إجمالي فوق المفتوح أو فوق الرصيد', async () => {
  const other: FakeLine = { id: 'x-bank', tenantId: 't1', moveId: 'mx', accountId: accountIdOf('111101'), debitMilli: 50_000n, creditMilli: 0n };
  const closed: FakeLine = { id: 'p-closed', tenantId: 't1', moveId: 'mc', accountId: accountIdOf('112004'), debitMilli: 50_000n, creditMilli: 0n };
  const foreign: FakeLine = { id: 'p-foreign', tenantId: 't2', moveId: 'mf', accountId: accountIdOf('112004'), debitMilli: 50_000n, creditMilli: 0n };
  const cases: [Partial<ClearingBody>, (e: unknown) => void, { balance?: bigint }?][] = [
    [{ gross: -10, fee: 0, feeVat: 0 }, isClearing422('GROSS_NOT_POSITIVE')],
    [{ gross: 100, fee: 90, feeVat: 13.5 }, isClearing422('FEES_EXCEED_GROSS')],
    [{ fee: 0, feeVat: 7.77 }, isClearing422('FEE_VAT_WITHOUT_FEE')],
    [{ gross: '2000.005' }, isClearing422('PRECISION')],
    [{ bankAccountId: accountIdOf('111003') }, isClearing422('BANK_ACCOUNT_CONTROL')],
    [{ lineIds: ['p1', 'x-bank'] }, isClearing422('LINE_OTHER_ACCOUNT')],
    [{ lineIds: ['p-closed'] }, isClearing422('LINE_NOT_OPEN')],
    [{ lineIds: ['p-foreign'] }, (e) => { assert.ok(e instanceof GlNotFoundError); assert.equal(ledgerErrorResponse(e)!.status, 404); }],
    [{ gross: 2400, fee: 0, feeVat: 0 }, isClearing422('EXCEEDS_OPEN')],
    [{ gross: 600, fee: 0, feeVat: 0, lineIds: ['p2'] }, isClearing422('EXCEEDS_OPEN')],
    [{ gross: 2000 }, isClearing422('EXCEEDS_BALANCE'), { balance: 1_999_990n }],
  ];
  for (const [b, check, extra] of cases) {
    const h = harness({ open: POS_OPEN, lines: [other, closed, foreign], balance: extra?.balance });
    await rejects(executeClearing(h.tx, { tenantId: 't1', actor: ACTOR, body: body(b) }, h.deps), check);
    assert.equal(h.posted.length, 0, `لا قيد: ${JSON.stringify(b)}`);
    assert.equal(h.partials.length, 0);
    assert.equal(h.audits.length, 0);
  }
});

test('مدخلات المسار: المبلغ النصّي والرقمي بدقة الألف بلا تقريب صامت، والنصّ غير الرقمي 400', () => {
  assert.equal(amountMilliOf(2000, 'gross'), 2_000_000n);
  assert.equal(amountMilliOf('1940.5', 'gross'), 1_940_500n);
  assert.equal(amountMilliOf(0.1 + 0.2, 'gross'), 300n);
  assert.equal(amountMilliOf(null, 'fee'), 0n);
  assert.throws(() => amountMilliOf('12abc', 'gross'), (e: unknown) => e instanceof LedgerHttpError && e.status === 400);
  assert.throws(() => clearingBodySchema.parse({ kind: 'NOPE', date: '2026-11-13', bankAccountId: 'a', gross: 1 }));
  const e = clearingInvalid('EXCEEDS_OPEN', { available: 10 });
  assert.equal(ledgerErrorResponse(e)!.body.available, 10);
});

// ═══ حراس ثابتة على المسار ═══

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const ROUTES = path.join(__dirname, '../routes');

test('حارس ثابت: GET /clearing/open بـcanViewLedger وPOST /clearing بـcanPostJournals، وكل SQL معزول بالشركة، ولا أحداث مزامنة', () => {
  const src = stripComments(fs.readFileSync(path.join(ROUTES, 'ledger/clearing.ts'), 'utf8'));
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(\w+)/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  assert.deepEqual(routes, ['get /clearing/open VIEW', 'post /clearing POST']);
  assert.match(src, /const VIEW = requireLedgerPermission\('canViewLedger'\);/);
  assert.match(src, /const POST = requireLedgerPermission\('canPostJournals'\);/);
  // كل جدول في الاستعلام الخام مقيَّد بـtenantId
  const sql = /\$queryRaw<[^>]+>`([\s\S]*?)`;/.exec(src)?.[1] ?? '';
  assert.ok(sql.length > 0);
  const aliases = [...sql.matchAll(/(?:FROM|JOIN)\s+"(gl_[a-z_]+)"\s+(\w+)/g)].map((m) => m[2]);
  assert.ok(aliases.length >= 5);
  for (const a of aliases) assert.match(sql, new RegExp(`\\b${a}\\."tenantId" = \\$\\{tenantId\\}`), `الاسم ${a} بلا tenantId`);
  assert.doesNotMatch(src, /glSourceEvent|glMove\.(create|update|delete)|glMoveLine\.(create|update|delete)/);
  assert.match(src, /prisma\.\$transaction\(\(tx\) => executeClearing\(/);
});

test('حارس ثابت: المسارات التشغيلية لا تستورد التسوية الموجّهة', () => {
  for (const f of ['invoices.ts', 'receipts.ts', 'paylink.ts', 'settlement.ts', 'accounting.ts']) {
    const p = path.join(ROUTES, f);
    if (!fs.existsSync(p)) continue;
    assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /ledger\/clearing|builders\/clearing/, f);
  }
});
