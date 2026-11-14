// «ربط الدفاتر» L5 — العهد في الدفاتر المربوطة (العقد §3.5، §5.4، §5.5، OD2/OD3/OD5/OD14، الأمثلة E5.6 وE5.7 وE5.10–E5.13):
// P7 بالمستلِم، وتوريد المستخدم USER_SETTLEMENT، وC4b بالبناء = 0، وcustodyExplain بلا باقٍ، وR4 (111004 = طيّ العهدة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSettlementMove, buildSettlementReversalMove, settlementKey, type SettlementPayload, type SettlementPostInput,
} from '../services/gl/builders/custody';
import { buildUserSettlementMove, userSettlementKey, type UserSettlementPayload } from '../services/gl/builders/userCustody';
import { buildReceiptMove, buildReceiptReversalMove, type ReceiptPostPayload, type ReceiptReversePayload } from '../services/gl/builders/receipt';
import {
  custodyC4bGap, custodyComponentsForRep, custodyExplain, settlementInputsFrom,
  type CustodyComponentsInput, type CustodyItem, type CustodySettlementItem, type CustodyShortageItem,
} from '../services/gl/custody';
import { foldUserCustody, userDeliverySplitBefore, type UserCustodyInputs } from '../services/userCustodyCore';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, saContext, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import { toMilli } from '../services/gl/money';
import {
  createBuildContext, isNoMove,
  type AccountRef, type BuildContext, type BuildResult, type GlSettingsSnapshot, type LineDraft, type MethodAccountRef, type MoveDraft,
  type ReceiptRouting,
} from '../services/gl/types';

const ARABIC = /[؀-ۿ]/;
const REP = 'rep1';
const REP_NAME = 'أحمد';
// OD4: النقد والشيك إلى العهدة، والتحويل ونقطة البيع مباشرة
const LINKED_ROUTING: ReceiptRouting = { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' };
const BANK2: AccountRef = { id: accountIdOf('111102'), code: '111102', name: 'بنك ثانٍ', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null };

function linkedCtx(opts: { decimals?: number; maps?: Record<string, MethodAccountRef>; settings?: Partial<GlSettingsSnapshot> } = {}): BuildContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: {
      linkedPosting: true, receiptRouting: LINKED_ROUTING,
      ...(opts.decimals !== undefined ? { currencyDecimals: opts.decimals, currency: opts.decimals === 3 ? 'KWD' : opts.decimals === 0 ? 'IQD' : 'SAR' } : {}),
      ...opts.settings,
    },
    extraAccounts: [...linkedAccountRefs(accountIdOf), BANK2],
  });
  return createBuildContext({ ...input, ...(opts.maps ? { paymentMethodMaps: opts.maps } : {}) });
}

/** أستاذ صغير: رصيد مدين−دائن لكل رمز، ولكل (رمز، مندوب) و(رمز، مستخدم) */
class Ledger {
  bal = new Map<string, bigint>();
  constructor(private ctx: BuildContext) {}
  add(key: string, delta: bigint) { this.bal.set(key, (this.bal.get(key) ?? 0n) + delta); }
  get(key: string) { return this.bal.get(key) ?? 0n; }
  post(r: BuildResult): MoveDraft | null {
    if (isNoMove(r)) return null;
    const v = validateMove(r, this.ctx);
    assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'قيد متوازن');
    assert.match(r.narration, ARABIC);
    for (const l of r.lines) {
      assert.match(l.label, ARABIC, 'label عربي');
      const acc = resolveLineAccount(l, this.ctx.accounts)!;
      if (acc.controlKind === 'CUSTODY') {
        // ثابت D2: سطر العهدة لشريك واحد
        assert.ok(!!l.salesRepId !== !!l.adminUserId, `سطر ${acc.code} يحمل مندوباً أو مستخدماً لا كليهما ولا أياً منهما`);
        assert.ok(l.partnerName?.trim(), 'لقطة اسم الشريك');
      }
      if (acc.code === '111004') assert.ok(!l.salesRepId, 'لا salesRepId على 111004');
      const d = l.debitMilli - l.creditMilli;
      this.add(acc.code, d);
      if (l.salesRepId && acc.code === '111003') this.add(`111003|${l.salesRepId}`, d);
      if (l.adminUserId) this.add(`${acc.code}|${l.adminUserId}`, d);
    }
    return r;
  }
}

/** مرآة قيد (كـinvertDraft في المُرحِّل): حذف المصدر يعكس سطوره كما هي */
const invert = (m: MoveDraft): MoveDraft => ({
  ...m, lines: m.lines.map((l) => ({ ...l, label: `عكس: ${l.label}`, debitMilli: l.creditMilli, creditMilli: l.debitMilli })),
});

const codeOf = (ctx: BuildContext, l: LineDraft) => resolveLineAccount(l, ctx.accounts)!.code;
const shape = (ctx: BuildContext, m: MoveDraft) =>
  m.lines.map((l) => [codeOf(ctx, l), l.debitMilli, l.creditMilli, l.salesRepId ?? null, l.adminUserId ?? null] as const);

const settlePayload = (amount: string, method = 'CASH', extra: Partial<SettlementPayload> = {}): SettlementPayload => ({
  amount, method, salesRepId: REP, settledAt: '2026-09-05T09:00:00Z', ...extra,
});
const p7 = (id: string, payload: SettlementPayload, inputs: Omit<SettlementPostInput, 'settlementId' | 'payload'>, ctx: BuildContext) =>
  buildSettlementMove({ settlementId: id, payload, salesRepName: REP_NAME, ...inputs }, ctx);
const covered = (c: bigint) => ({ custodyBalanceMilli: c, cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 0n });

// ═══ الذهبي: بلا linkedPosting P7 حرفياً كاليوم ═══

test('ذهبي: بلا linkedPosting يبقى P7 حرفياً كما كان — والمستلِم في الحمولة لا يغيّر بايتاً', () => {
  const ctx = saContext({ settings: { receiptRouting: { CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' } } });
  const input = { custodyBalanceMilli: 300_000n, cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 200_000n };
  const plain = p7('s1', settlePayload('500'), input, ctx);
  assert.deepEqual(plain.result, {
    kind: 'MOVE', journalCode: 'CUST', journalSystemKey: 'CUSTODY', moveType: 'CUSTODY_SETTLEMENT', origin: 'AUTO',
    date: '2026-09-05', ref: null, narration: 'استلام تحصيل (نقداً) من المندوب أحمد', salesRepId: REP,
    sourceType: 'SETTLEMENT', sourceId: 's1', sourceKey: settlementKey('s1', 'POST'), sourceEvent: 'POST',
    currencyCode: 'SAR', currencyDecimals: 2, needsAttention: false, attentionReason: null,
    lines: [
      { accountKey: 'MAIN_CASH', label: 'استلام تحصيل نقداً من المندوب أحمد', debitMilli: 300_000n, creditMilli: 0n, salesRepId: REP, partnerName: REP_NAME },
      { accountKey: 'REP_CUSTODY', label: 'تصفية عهدة المندوب أحمد', debitMilli: 0n, creditMilli: 300_000n, salesRepId: REP, partnerName: REP_NAME },
    ],
  });
  for (const method of ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'WEIRD']) {
    const a = p7('s1', settlePayload('500', method), input, ctx);
    const b = p7('s1', settlePayload('500', method, { receivedByUserId: 'U1', receivedByName: 'سعد' }), input, ctx);
    assert.deepEqual(b, a, method);
  }
  // التحويل بلا ربط ما زال إلى 112001 (OUTSTANDING_RECEIPTS) — OD14 للمربوطة وحدها
  const bank = p7('s1', settlePayload('100', 'BANK_TRANSFER'), covered(100_000n), ctx).result as MoveDraft;
  assert.equal(bank.lines[0].accountKey, 'OUTSTANDING_RECEIPTS');
});

// ═══ P7 للمربوطة بالمستلِم (§5.4، C12، OD5، OD14) ═══

test('E5.10: نقد 800 من المندوب إلى المستخدم ⇒ Dr 111004 [U] 800 / Cr 111003 [R] 800 بلا salesRepId على 111004', () => {
  const ctx = linkedCtx();
  const L = new Ledger(ctx);
  const b = p7('s1', settlePayload('800', 'CASH', { receivedByUserId: 'U1', receivedByName: 'سعد' }), covered(800_000n), ctx);
  const m = L.post(b.result)!;
  assert.deepEqual(shape(ctx, m), [['111004', 800_000n, 0n, null, 'U1'], ['111003', 0n, 800_000n, REP, null]]);
  assert.equal(m.lines[0].partnerName, 'سعد');
  assert.equal(m.moveType, 'CUSTODY_SETTLEMENT');
  assert.equal(m.journalCode, 'CUST');
  assert.equal(m.sourceKey, settlementKey('s1', 'POST'));
  assert.deepEqual([b.split.coveredMilli, b.split.nonCustodyClearedMilli], [800_000n, 0n], 'التقسيم كما هو');
  assert.equal(L.get('111004|U1'), 800_000n);
  assert.equal(L.get('111003|rep1'), -800_000n);
  // E5.10 بتحويل: Dr 111101 800 / Cr 111003 [R] 800 (OD5: لا 111004)
  const t = p7('s2', settlePayload('800', 'BANK_TRANSFER', { receivedByUserId: 'U1' }), covered(800_000n), ctx);
  assert.deepEqual(shape(ctx, L.post(t.result)!), [['111101', 800_000n, 0n, REP, null], ['111003', 0n, 800_000n, REP, null]]);
});

test('جدول الطرف المدين للمربوطة: المستلِم × الطريقة (والمجهول نقد)، وخريطة الطرق، وبلا مستلِم إلى حساب الطريقة', () => {
  const cases: [string, string | null, string][] = [
    ['CASH', 'U1', '111004'], ['CHEQUE', 'U1', '111004'], ['WEIRD', 'U1', '111004'],
    ['BANK_TRANSFER', 'U1', '111101'], ['POS', 'U1', '112004'],
    ['CASH', null, '111001'], ['CHEQUE', null, '112003'], ['BANK_TRANSFER', null, '111101'], ['POS', null, '112004'], ['WEIRD', null, '111001'],
  ];
  const ctx = linkedCtx();
  for (const [method, user, code] of cases) {
    const L = new Ledger(ctx);
    const m = L.post(p7('s', settlePayload('100', method, user ? { receivedByUserId: user, receivedByName: 'سعد' } : {}), covered(100_000n), ctx).result)!;
    assert.equal(codeOf(ctx, m.lines[0]), code, `${method}/${user}`);
    assert.equal(m.lines[0].adminUserId ?? null, code === '111004' ? user : null);
    assert.equal(m.lines[0].salesRepId ?? null, code === '111004' ? null : REP);
    assert.ok(!m.lines.some((l) => codeOf(ctx, l) === '112001'), 'OD14: لا 112001');
  }
  // خريطة الطرق (D3): التحويل إلى بنك آخر، والمستلِم لا يغيّر ذلك
  const mapped = linkedCtx({ maps: { BANK_TRANSFER: { accountId: BANK2.id, journalId: null } } });
  const m = new Ledger(mapped).post(p7('s', settlePayload('100', 'BANK_TRANSFER', { receivedByUserId: 'U1' }), covered(100_000n), mapped).result)!;
  assert.equal(codeOf(mapped, m.lines[0]), '111102');
});

test('r في استلام نقدي إلى مستخدم ينتقل إلى عهدته (لا مضاعفة لـ111001): فاتورة نقدية غير مختومة 1000 ثم استلامها ثم توريدها', () => {
  const ctx = linkedCtx();
  const L = new Ledger(ctx);
  L.add('111001', 1_000_000n); // نقد الفاتورة غير المختومة (cashInvoiceRouting = MAIN_CASH)
  // نقد الفاتورة في حساب طريقة الاستلام نفسه (111001) ⇒ يُنقل (methodReclassAllowanceMilli، إصلاح P7 إلى مستخدم)
  const allow = { custodyBalanceMilli: 0n, cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 1_000_000n, methodReclassAllowanceMilli: 1_000_000n };
  const b = p7('s1', settlePayload('1000', 'CASH', { receivedByUserId: 'U1', receivedByName: 'سعد' }), allow, ctx);
  assert.deepEqual([b.split.coveredMilli, b.split.nonCustodyClearedMilli, b.split.suspenseMilli], [0n, 1_000_000n, 0n], 'التقسيم لا يتغيّر');
  assert.deepEqual(shape(ctx, L.post(b.result)!), [['111004', 1_000_000n, 0n, null, 'U1'], ['111001', 0n, 1_000_000n, REP, null]]);
  assert.equal(L.get('111001'), 0n, 'النقد انتقل من الصندوق إلى يد المستخدم');
  // المستخدم يورّده نقداً
  const fold: UserCustodyInputs = {
    userId: 'U1', refunds: [],
    received: [{ id: 's1', amountMilli: 1_000_000n, method: 'CASH', at: '2026-09-05T09:00:00Z', createdAt: '2026-09-05T09:00:00Z' }],
    delivered: [{ id: 'd1', amountMilli: 1_000_000n, method: 'CASH', at: '2026-09-06T09:00:00Z', createdAt: '2026-09-06T09:00:00Z' }],
  };
  const d = buildUserSettlementMove({ userSettlementId: 'd1', payload: usPayload('d1', '1000', 'CASH'), date: '2026-09-06', split: userDeliverySplitBefore(fold, 'd1') }, ctx);
  L.post(d.result);
  assert.equal(L.get('111001'), 1_000_000n, 'الصندوق = نقد الفاتورة مرة واحدة');
  assert.equal(L.get('111004|U1'), 0n);
  assert.equal(foldUserCustody(fold).outstandingMilli, L.get('111004|U1'), 'R4');
  // بلا مستلِم: كما كان (NETTED)، وبمستلِم وطريقة غير نقدية: لا سطر لـr
  assert.ok(isNoMove(p7('s2', settlePayload('1000', 'CASH'), allow, ctx).result));
  assert.ok(isNoMove(p7('s3', settlePayload('1000', 'BANK_TRANSFER', { receivedByUserId: 'U1' }), allow, ctx).result));
});

test('مستلِم ونقد: المعلّق والمسترد كما هما — Dr 111004 بالمبلغ كاملاً / Cr 111003 + 113003 + 911001، وr الإلكتروني غير المسنود معلّق لا من 111001', () => {
  const ctx = linkedCtx();
  // عهدة 300، عتبة 100 (إلكتروني)، استلام 500 ⇒ covered 300، r 200، المعلّق 100
  const b = p7('s1', settlePayload('500', 'CASH', { receivedByUserId: 'U1' }),
    { custodyBalanceMilli: 300_000n, cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 100_000n }, ctx);
  const m = new Ledger(ctx).post(b.result)!;
  assert.deepEqual(shape(ctx, m), [
    ['111004', 500_000n, 0n, null, 'U1'], ['111003', 0n, 300_000n, REP, null], ['911001', 0n, 100_000n, REP, null], ['911001', 0n, 100_000n, REP, null],
  ]);
  assert.equal(m.lines[0].partnerName, 'مستخدم', 'لقطة افتراضية حين يغيب الاسم');
  assert.equal(m.needsAttention, true);
  // العجز المسترد
  const r = p7('s2', settlePayload('300', 'CHEQUE', { receivedByUserId: 'U1', receivedByName: 'سعد' }),
    { custodyBalanceMilli: 200_000n, openShortageMilli: 100_000n, cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 0n }, ctx);
  assert.deepEqual(shape(ctx, new Ledger(ctx).post(r.result)!), [
    ['111004', 300_000n, 0n, null, 'U1'], ['111003', 0n, 200_000n, REP, null], ['113003', 0n, 100_000n, REP, null],
  ]);
});

test('P8 للمربوطة: حذف الاستلام يعكس سطوره ومنها سطر 111004 بمستخدمه', () => {
  const ctx = linkedCtx();
  const L = new Ledger(ctx);
  const b = p7('s1', settlePayload('800', 'CASH', { receivedByUserId: 'U1', receivedByName: 'سعد' }), covered(800_000n), ctx);
  const original = L.post(b.result)!;
  const rev = buildSettlementReversalMove({
    settlementId: 's1', payload: settlePayload('800', 'CASH', { receivedByUserId: 'U1' }), salesRepName: REP_NAME, date: '2026-09-07',
    originalLines: original.lines, nonCustodyClearedMilli: 0n, shortageRecoveredMilli: 0n,
  }, ctx);
  L.post(rev.result);
  assert.equal(L.get('111004|U1'), 0n);
  assert.equal(L.get('111003|rep1'), 0n);
});

// ═══ توريد المستخدم USER_SETTLEMENT (§5.5، E5.11، E5.6) ═══

function usPayload(id: string, amount: string, method: string, extra: Partial<UserSettlementPayload> = {}): UserSettlementPayload {
  return {
    userSettlementId: id, fromUserId: 'U1', fromUserName: 'سعد', amount, method,
    settledAt: '2026-09-06T21:30:00Z', createdAt: '2026-09-06T21:30:00Z', ...extra,
  };
}

test('E5.11: U يورّد 800 نقداً ⇒ Dr 111001 / Cr 111004 [U]؛ وتحويلاً (إيداع نقد) ⇒ Dr 111101؛ وشيكاً ⇒ Dr 112003 (E5.6)', () => {
  const ctx = linkedCtx();
  const expect: [string, string][] = [['CASH', '111001'], ['BANK_TRANSFER', '111101'], ['CHEQUE', '112003'], ['POS', '112004'], ['WEIRD', '111001']];
  for (const [method, code] of expect) {
    const b = buildUserSettlementMove({ userSettlementId: 'd1', payload: usPayload('d1', '800', method), split: { passThroughMilli: 0n, custodyMilli: 800_000n } }, ctx);
    const m = new Ledger(ctx).post(b.result)!;
    assert.deepEqual(shape(ctx, m), [[code, 800_000n, 0n, null, null], ['111004', 0n, 800_000n, null, 'U1']], method);
    assert.equal(m.lines[1].partnerName, 'سعد');
    assert.equal(m.moveType, 'CUSTODY_SETTLEMENT');
    assert.equal(m.journalCode, 'CUST');
    assert.equal(m.journalSystemKey, 'CUSTODY');
    assert.equal(m.sourceType, 'USER_SETTLEMENT');
    assert.equal(m.sourceKey, userSettlementKey('d1', 'POST'));
    assert.equal(m.sourceEvent, 'POST');
    // settledAt 21:30Z = 07 سبتمبر بتوقيت الرياض
    assert.equal(m.date, '2026-09-07', 'التاريخ المحلي من settledAt');
  }
  assert.equal(userSettlementKey('x', 'REVERSE'), 'USER_SETTLEMENT:x:REVERSE');
});

test('E5.11 مرور: تحويل 300 من الوعاء ⇒ NO_MOVE(NETTED) والتقسيم 300000 للمُرحِّل؛ والجزئي بالجزء النقدي وحده', () => {
  const ctx = linkedCtx();
  const n = buildUserSettlementMove({ userSettlementId: 'd1', payload: usPayload('d1', '300', 'BANK_TRANSFER'), split: { passThroughMilli: 300_000n, custodyMilli: 0n } }, ctx);
  assert.ok(isNoMove(n.result));
  assert.equal(n.result.kind === 'NO_MOVE' && n.result.reason, 'NETTED');
  assert.equal(n.split.passThroughMilli, 300_000n);
  const p = buildUserSettlementMove({ userSettlementId: 'd2', payload: usPayload('d2', '500', 'BANK_TRANSFER'), split: { passThroughMilli: 300_000n, custodyMilli: 200_000n } }, ctx);
  assert.deepEqual(shape(ctx, new Ledger(ctx).post(p.result)!), [['111101', 200_000n, 0n, null, null], ['111004', 0n, 200_000n, null, 'U1']]);
  const z = buildUserSettlementMove({ userSettlementId: 'd3', payload: usPayload('d3', '0', 'CASH'), split: { passThroughMilli: 0n, custodyMilli: 0n } }, ctx);
  assert.equal(z.result.kind === 'NO_MOVE' && z.result.reason, 'ZERO_VALUE');
  // خريطة الطرق والمستخدم بلا اسم
  const mapped = linkedCtx({ maps: { BANK_TRANSFER: { accountId: BANK2.id, journalId: null } } });
  const mm = buildUserSettlementMove({ userSettlementId: 'd4', payload: usPayload('d4', '50', 'BANK_TRANSFER', { fromUserName: null }), split: { passThroughMilli: 0n, custodyMilli: 50_000n } }, mapped);
  const mv = new Ledger(mapped).post(mm.result)!;
  assert.equal(codeOf(mapped, mv.lines[0]), '111102');
  assert.equal(mv.lines[1].partnerName, 'مستخدم');
});

test('التقسيم يجب أن يساوي المبلغ بالملّي تماماً — وإلا خطأ صريح لا قيد', () => {
  const ctx = linkedCtx();
  for (const split of [{ passThroughMilli: 0n, custodyMilli: 799_990n }, { passThroughMilli: -1n, custodyMilli: 800_001n }, { passThroughMilli: 100_000n, custodyMilli: 800_000n }]) {
    assert.throws(() => buildUserSettlementMove({ userSettlementId: 'd', payload: usPayload('d', '800', 'CASH'), split }, ctx), RangeError);
  }
});

test('منازل العملة 0 و2 و3: نصف-لأعلى لكل مستند، والقيد متوازن بالملّي', () => {
  for (const [dec, amount, milli] of [[0, '1500', 1_500_000n], [2, '10.25', 10_250n], [3, '1.234', 1_234n]] as const) {
    const ctx = linkedCtx({ decimals: dec });
    assert.equal(toMilli(amount, dec), milli);
    const L = new Ledger(ctx);
    const b = p7('s', settlePayload(amount, 'CASH', { receivedByUserId: 'U1' }), covered(milli), ctx);
    L.post(b.result);
    const d = buildUserSettlementMove({ userSettlementId: 'd', payload: usPayload('d', amount, 'CHEQUE'), split: { passThroughMilli: 0n, custodyMilli: milli } }, ctx);
    L.post(d.result);
    assert.equal(L.get('111004|U1'), 0n, `منازل ${dec}`);
    assert.equal(L.get('112003'), milli);
  }
});

// ═══ E5.6: شيك بمندوب ثم مستخدم ثم بنك ═══

const receiptPayload = (amount: string, method: string, extra: Partial<ReceiptPostPayload> = {}): ReceiptPostPayload =>
  ({ salesRepId: REP, paymentMethod: method, amount, customerId: 'cus1', ...extra });

test('E5.6: سند شيك 700 بمندوب ⇒ 111003، استلام بالمستخدم ⇒ 111004، توريد شيكاً ⇒ 112003 — والعهدتان صفر', () => {
  const ctx = linkedCtx();
  const L = new Ledger(ctx);
  const rc = L.post(buildReceiptMove({ receiptId: 'r1', date: '2026-09-01', customerName: 'بقالة النور', salesRepName: REP_NAME, payload: receiptPayload('700', 'CHEQUE') }, ctx))!;
  assert.deepEqual(shape(ctx, rc).map((x) => x[0]), ['111003', '113001']);
  L.post(p7('s1', settlePayload('700', 'CHEQUE', { receivedByUserId: 'U1', receivedByName: 'سعد' }), covered(700_000n), ctx).result);
  const inputs: UserCustodyInputs = {
    userId: 'U1', refunds: [],
    received: [{ id: 's1', amountMilli: 700_000n, method: 'CHEQUE', at: '2026-09-05T09:00:00Z', createdAt: '2026-09-05T09:00:00Z' }],
    delivered: [{ id: 'd1', amountMilli: 700_000n, method: 'CHEQUE', at: '2026-09-06T09:00:00Z', createdAt: '2026-09-06T09:00:00Z' }],
  };
  L.post(buildUserSettlementMove({ userSettlementId: 'd1', payload: usPayload('d1', '700', 'CHEQUE'), split: userDeliverySplitBefore(inputs, 'd1') }, ctx).result);
  assert.equal(L.get('111003|rep1'), 0n);
  assert.equal(L.get('111004|U1'), 0n);
  assert.equal(L.get('112003'), 700_000n, 'الشيك تحت التحصيل حتى التسوية الموجّهة');
  assert.equal(L.get('113001'), -700_000n);
});

// ═══ E5.7: الإلغاء بعد التسليم بكل مصدر ردّ (C11) — C4 وC4b وR4 ═══

const ci = (id: string, amountMilli: bigint, effectAt: string, extra: Partial<CustodyItem> = {}): CustodyItem =>
  ({ id, salesRepId: REP, amountMilli, effectAt, ...extra });

/** مدخلات المكوّنات بقوائم قابلة للإلحاق في الاختبار */
type MutableComponentsInput = Omit<CustodyComponentsInput,
  'receipts' | 'onlineReceipts' | 'outsideReceipts' | 'cashInvoices' | 'settlements' | 'shortages' | 'custodyExpenses'> & {
  receipts: CustodyItem[]; onlineReceipts: CustodyItem[]; outsideReceipts: CustodyItem[]; cashInvoices: CustodyItem[];
  settlements: CustodySettlementItem[]; shortages: CustodyShortageItem[]; custodyExpenses: CustodyItem[];
};

function emptyComponents(routing: CustodyComponentsInput['routing'] = { cashInvoice: 'MAIN_CASH', stampDrivesCustody: true }): MutableComponentsInput {
  return { receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [], routing };
}

test('E5.7: سند 500 بالعهدة ثم استلامه ثم إلغاؤه — لكل مصدر ردّ: 111003 لا يصير سالباً، وC4 = 0 وC4b = 0 (وR4 للمستخدم)', () => {
  const sources: (ReceiptReversePayload['cancelRefundFrom'])[] = ['MAIN_CASH', 'BANK', 'USER_CUSTODY', 'REP_CUSTODY'];
  for (const from of sources) {
    const ctx = linkedCtx();
    const L = new Ledger(ctx);
    const original = receiptPayload('500', 'CASH');
    const posted = L.post(buildReceiptMove({ receiptId: 'r1', date: '2026-09-01', customerName: 'بقالة النور', salesRepName: REP_NAME, payload: original }, ctx))!;
    const handedTo = from === 'USER_CUSTODY' ? 'U1' : null;
    const handedOver = from !== 'REP_CUSTODY';
    let split = { nonCustodyClearedMilli: 0n, recoveredMilli: 0n };
    if (handedOver) {
      const b = p7('s1', settlePayload('500', 'CASH', handedTo ? { receivedByUserId: handedTo, receivedByName: 'سعد' } : {}), covered(500_000n), ctx);
      L.post(b.result);
      split = b.split;
    }
    const reverse: ReceiptReversePayload = { cancelRefundFrom: from, ...(handedTo ? { cancelRefundUserId: handedTo, cancelRefundUserName: 'سعد' } : {}) };
    L.post(buildReceiptReversalMove({
      receiptId: 'r1', date: '2026-09-08', customerName: 'بقالة النور', salesRepName: REP_NAME, original, reverse,
      originalLines: posted.lines.filter((l) => !l.customerId),
    }, ctx));
    assert.equal(L.get('111003|rep1'), 0n, `${from}: 111003 لا −500`);
    assert.equal(L.get('113001'), 0n, `${from}: الذمة عادت`);

    // المكوّنات بما يكتبه A7: reversalOutsideCustody حين المصدر ∉ {null, REP_CUSTODY, METHOD}
    const input = emptyComponents();
    input.receipts = [ci('r1', 500_000n, '2026-09-01T08:00:00Z', {
      reversedAt: '2026-09-08T08:00:00Z', reversalOutsideCustody: from !== 'REP_CUSTODY',
    })];
    if (handedOver) {
      input.settlements = [{ ...ci('s1', 500_000n, '2026-09-05T09:00:00Z'), nonCustodyClearedMilli: split.nonCustodyClearedMilli, shortageRecoveredMilli: split.recoveredMilli } as CustodySettlementItem];
    }
    const c = custodyComponentsForRep(input, REP);
    assert.equal(c.ledgerCustody, L.get('111003|rep1'), `${from}: C4`);
    assert.equal(custodyC4bGap(c), 0n, `${from}: C4b`);
    if (handedOver) {
      assert.equal(c.opsOutstanding, -500_000n, `${from}: الشاشة −500`);
      assert.equal(c.cancelRefundOutside, 500_000n);
    }
    const ex = custodyExplain(input, REP);
    assert.equal(ex.unexplainedMilli, 0n, `${from}: تفسير بلا باقٍ`);
    if (handedOver) assert.deepEqual(ex.items.map((i) => [i.kind, i.amountMilli]), [['CANCEL_REFUND_OUTSIDE', -500_000n]]);
    if (handedTo) {
      const fold = foldUserCustody({
        userId: handedTo, delivered: [],
        received: [{ id: 's1', amountMilli: 500_000n, method: 'CASH', at: '2026-09-05T09:00:00Z', createdAt: '2026-09-05T09:00:00Z' }],
        refunds: [{ id: 'r1', amountMilli: 500_000n, at: '2026-09-08T08:00:00Z', createdAt: '2026-09-01T08:00:00Z' }],
      });
      assert.equal(fold.outstandingMilli, L.get(`111004|${handedTo}`), 'R4: 111004 = طيّ العهدة');
      assert.equal(fold.outstandingMilli, 0n);
    }
  }
});

// ═══ C4b بالبناء = 0: مختومة (مربوطة وقديمة) وأونلاين وخارج العهدة ومصروف ═══

test('OD2: فاتورة نقدية مختومة 115 — المربوطة إلى 111003، والقديمة خارج العهدة؛ وC4 وC4b = 0 قبل الاستلام وبعده (وE5.13 الإبطال يحتفظ بالنقد)', () => {
  for (const mode of ['linked', 'legacy-main', 'legacy-custody'] as const) {
    const routing = mode === 'linked' ? { cashInvoice: 'MAIN_CASH' as const, stampDrivesCustody: true }
      : { cashInvoice: (mode === 'legacy-custody' ? 'CUSTODY' : 'MAIN_CASH') as 'CUSTODY' | 'MAIN_CASH' };
    const ctx = mode === 'linked' ? linkedCtx() : saContext({ settings: { receiptRouting: LINKED_ROUTING, cashInvoiceRouting: routing.cashInvoice } });
    const L = new Ledger(ctx);
    // ساق النقد للفاتورة (A3): المختومة في المربوطة ⇒ 111003، وإلا بـcashInvoiceRouting
    if (mode === 'legacy-main') L.add('111001', 115_000n); else L.add('111003|rep1', 115_000n);
    const input = emptyComponents(routing);
    input.cashInvoices = [ci('inv', 115_000n, '2026-09-01T07:00:00Z', { stamped: true })];
    const before = custodyComponentsForRep(input, REP);
    assert.equal(before.ledgerCustody, L.get('111003|rep1'), `${mode}: C4 قبل`);
    assert.equal(before.opsOutstanding, 115_000n, `${mode}: الشاشة تعدّ المختومة`);
    assert.equal(custodyC4bGap(before), 0n, `${mode}: C4b قبل`);
    const b = p7('s1', settlePayload('115'), settlementInputsFrom(before), ctx);
    L.post(b.result);
    const after = custodyComponentsForRep({
      ...input, settlements: [{ ...ci('s1', 115_000n, '2026-09-05T09:00:00Z'), nonCustodyClearedMilli: b.split.nonCustodyClearedMilli, shortageRecoveredMilli: b.split.recoveredMilli }],
    }, REP);
    assert.equal(after.ledgerCustody, L.get('111003|rep1'), `${mode}: C4 بعد`);
    assert.equal(custodyC4bGap(after), 0n, `${mode}: C4b بعد`);
    assert.equal(after.opsOutstanding, 0n);
    assert.equal(b.split.suspenseMilli, 0n, `${mode}: لا 911001`);
    assert.equal(custodyExplain({ ...input, settlements: after.settlements.map((s) => ({ ...ci(s.id, s.amountMilli, '2026-09-05T09:00:00Z'), nonCustodyClearedMilli: s.nonCustodyClearedMilli })) }, REP).unexplainedMilli, 0n);
  }
});

test('مربوطة: أونلاين وخارج العهدة ومصروف وعجز وإلغاء من خارج العهدة معاً ⇒ C4b = 0 والتفسير بلا باقٍ', () => {
  const input = emptyComponents();
  input.receipts = [ci('rc', 900_000n, '2026-09-01T08:00:00Z'), ci('rx', 100_000n, '2026-09-01T08:30:00Z', { reversedAt: '2026-09-02T08:00:00Z', reversalOutsideCustody: true })];
  input.onlineReceipts = [ci('ro', 200_000n, '2026-09-01T09:00:00Z')];
  input.outsideReceipts = [ci('rb', 300_000n, '2026-09-01T09:30:00Z')];
  input.cashInvoices = [ci('i1', 115_000n, '2026-09-01T10:00:00Z', { stamped: true }), ci('i2', 50_000n, '2026-09-01T10:30:00Z')];
  input.custodyExpenses = [ci('fuel', 40_000n, '2026-09-02T10:00:00Z')];
  input.shortages = [ci('sh', 30_000n, '2026-09-02T11:00:00Z')];
  const before = custodyComponentsForRep(input, REP);
  assert.equal(custodyC4bGap(before), 0n);
  const split = (amount: bigint, c: ReturnType<typeof custodyComponentsForRep>) =>
    buildSettlementMove({ settlementId: 'x', payload: settlePayload(String(amount / 1000n)), ...settlementInputsFrom(c) }, linkedCtx()).split;
  const s1 = split(1_200_000n, before);
  const after = custodyComponentsForRep({
    ...input, settlements: [{ ...ci('s1', 1_200_000n, '2026-09-03T09:00:00Z'), nonCustodyClearedMilli: s1.nonCustodyClearedMilli, shortageRecoveredMilli: s1.recoveredMilli }],
  }, REP);
  assert.equal(custodyC4bGap(after), 0n);
  const ex = custodyExplain({ ...input, settlements: [{ ...ci('s1', 1_200_000n, '2026-09-03T09:00:00Z'), nonCustodyClearedMilli: s1.nonCustodyClearedMilli, shortageRecoveredMilli: s1.recoveredMilli }] }, REP);
  assert.equal(ex.unexplainedMilli, 0n);
  assert.equal(ex.opsMilli - ex.ledgerMilli, ex.totalMilli);
  assert.ok(ex.items.some((i) => i.kind === 'CANCEL_REFUND_OUTSIDE' && i.amountMilli === -100_000n));
  assert.ok(ex.items.some((i) => i.kind === 'ONLINE' && i.amountMilli === 200_000n));
  assert.ok(ex.items.some((i) => i.kind === 'OUTSIDE' && i.amountMilli === 300_000n));
  assert.ok(ex.items.some((i) => i.kind === 'EXPENSE' && i.amountMilli === 40_000n));
  assert.ok(!ex.items.some((i) => i.kind === 'STAMPED_OUTSIDE'), 'المختومة في المربوطة داخل العهدة');
  for (let k = 1; k < ex.items.length; k++) assert.ok(ex.items[k - 1].at <= ex.items[k].at, 'مرتبة زمنياً');
});

test('custodyExplain: المتجه الذهبي (فاتورة نقدية 1000 + سند 300 + أونلاين 200 ثم استلام 500) ⇒ ONLINE +200 وSETTLEMENT_R −200', () => {
  const input = emptyComponents({ cashInvoice: 'MAIN_CASH' });
  input.receipts = [ci('rc', 300_000n, '2026-09-01T08:00:00Z')];
  input.onlineReceipts = [ci('ro', 200_000n, '2026-09-01T08:10:00Z')];
  input.cashInvoices = [ci('inv', 1_000_000n, '2026-09-01T07:00:00Z')];
  input.settlements = [ci('s1', 500_000n, '2026-09-05T09:00:00Z')];
  const ex = custodyExplain(input, REP);
  assert.deepEqual(ex.items, [
    { kind: 'ONLINE', refId: 'ro', at: '2026-09-01T08:10:00.000Z', amountMilli: 200_000n },
    { kind: 'SETTLEMENT_R', refId: 's1', at: '2026-09-05T09:00:00.000Z', amountMilli: -200_000n },
  ]);
  assert.deepEqual([ex.opsMilli, ex.ledgerMilli, ex.totalMilli, ex.unexplainedMilli], [0n, 0n, 0n, 0n]);
  assert.deepEqual(custodyExplain(input, 'nobody'), { opsMilli: 0n, ledgerMilli: 0n, items: [], totalMilli: 0n, unexplainedMilli: 0n });
});

/** مولّد حتمي (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('custodyExplain: unexplainedMilli = 0 دائماً (200 سيناريو محكوم بكل الأنواع والعكس والافتتاح والتوجيهات)، وبلا افتتاح C4b = Σ CASH_INVOICE_CUSTODY', () => {
  const T = Date.parse('2026-09-01T00:00:00Z');
  const iso = (min: number) => new Date(T + min * 60_000).toISOString();
  for (let s = 1; s <= 200; s++) {
    const r = rng(s);
    const pick = <X>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)];
    const amt = () => BigInt(1 + Math.floor(r() * 500_000));
    const routing = {
      cashInvoice: pick(['MAIN_CASH', 'CUSTODY'] as const),
      ...(r() < 0.5 ? { stampDrivesCustody: true } : {}),
    };
    const input = emptyComponents(routing);
    const withOpening = r() < 0.3;
    if (withOpening) {
      input.opening = { [REP]: { ledgerCustodyMilli: amt(), activeReceiptsMilli: amt(), settledMilli: amt(), onlineActiveMilli: amt(), nonCustodyClearedMilli: amt() / 2n } };
    }
    let min = 0;
    for (let k = 0; k < 30; k++) {
      min += 1 + Math.floor(r() * 30);
      const rev = r() < 0.25 ? iso(min + 5 + Math.floor(r() * 60)) : null;
      const base = { id: `x${k}`, salesRepId: r() < 0.9 ? REP : 'rep2', amountMilli: amt(), effectAt: iso(min), reversedAt: rev };
      switch (Math.floor(r() * 7)) {
        case 0: input.receipts.push({ ...base, ...(rev && r() < 0.5 ? { reversalOutsideCustody: true } : {}) }); break;
        case 1: input.onlineReceipts.push(base); break;
        case 2: input.outsideReceipts.push(base); break;
        case 3: input.cashInvoices.push({ ...base, ...(r() < 0.5 ? { stamped: true } : {}) }); break;
        case 4: input.shortages.push({ ...base, ...(r() < 0.4 ? { chargedTo: 'EXPENSE' as const } : {}) }); break;
        case 5: input.custodyExpenses.push(base); break;
        default: input.settlements.push({
          ...base, ...(r() < 0.4 ? { nonCustodyClearedMilli: base.amountMilli / 3n, shortageRecoveredMilli: r() < 0.3 ? base.amountMilli / 5n : 0n } : {}),
        });
      }
    }
    for (const rep of [REP, 'rep2']) {
      const ex = custodyExplain(input, rep);
      assert.equal(ex.unexplainedMilli, 0n, `سيناريو ${s} (${rep}): باقٍ غير مفسَّر ${ex.unexplainedMilli}`);
      assert.equal(ex.totalMilli, ex.items.reduce((a, i) => a + i.amountMilli, 0n));
      assert.ok(ex.items.every((i) => i.amountMilli !== 0n));
      if (!withOpening || rep !== REP) {
        const c = custodyComponentsForRep(input, rep);
        const cashInvCustody = ex.items.filter((i) => i.kind === 'CASH_INVOICE_CUSTODY').reduce((a, i) => a + i.amountMilli, 0n);
        assert.equal(custodyC4bGap(c), cashInvCustody, `سيناريو ${s} (${rep}): C4b`);
      }
    }
  }
});

// ═══ R4: 111004 لكل مستخدم = طيّ العهدة — سيناريو كامل بكل الحركات ولكل منازل العملة ═══

test('R4: نقد بـr وتحويل للوعاء ومرور وإيداع وتوريد نقدي وردٌّ من العهدة وحذف توريد ⇒ 111004 لكل مستخدم = outstanding بالضبط (منازل 0 و2 و3)', () => {
  for (const dec of [0, 2, 3]) {
    const ctx = linkedCtx({ decimals: dec });
    const L = new Ledger(ctx);
    const k = dec === 0 ? 1 : dec === 2 ? 1.01 : 1.001; // مبالغ بكسور حقيقية بمنازل العملة
    const amount = (sar: number) => (Math.round(sar * k * 10 ** dec) / 10 ** dec).toFixed(dec);
    const mOf = (s: string) => toMilli(s, dec);
    const U: Record<string, UserCustodyInputs> = {
      U1: { userId: 'U1', received: [], delivered: [], refunds: [] },
      U2: { userId: 'U2', received: [], delivered: [], refunds: [] },
    };
    const comp = emptyComponents();
    let min = 0;
    const next = () => new Date(Date.parse('2026-09-01T06:00:00Z') + (min += 10) * 60_000).toISOString();
    const settle = (id: string, amt: string, method: string, user: string | null, methodReclassAllowanceMilli?: bigint) => {
      const t = next();
      const c = custodyComponentsForRep(comp, REP);
      const b = buildSettlementMove({
        settlementId: id, payload: settlePayload(amt, method, { settledAt: t, ...(user ? { receivedByUserId: user, receivedByName: user } : {}) }),
        salesRepName: REP_NAME, ...settlementInputsFrom(c), methodReclassAllowanceMilli,
      }, ctx);
      L.post(b.result);
      comp.settlements.push({ ...ci(id, mOf(amt), t), nonCustodyClearedMilli: b.split.nonCustodyClearedMilli, shortageRecoveredMilli: b.split.recoveredMilli });
      if (user) U[user].received.push({ id, amountMilli: mOf(amt), method, at: t, createdAt: t });
    };
    const deliver = (user: string, id: string, amt: string, method: string) => {
      const t = next();
      U[user].delivered.push({ id, amountMilli: mOf(amt), method, at: t, createdAt: t });
      const split = userDeliverySplitBefore(U[user], id);
      const b = buildUserSettlementMove({ userSettlementId: id, payload: { ...usPayload(id, amt, method), fromUserId: user, fromUserName: user, settledAt: t, createdAt: t }, split }, ctx);
      const m = L.post(b.result);
      U[user].delivered[U[user].delivered.length - 1].storedPassThroughMilli = b.split.passThroughMilli; // ما يحفظه المُرحِّل
      return m;
    };
    // 1) سند نقدي 1000 بالعهدة، وفاتورة نقدية غير مختومة 400 (ساقها 111001)، وتحويل 300 مباشر
    const r1 = receiptPayload(amount(1000), 'CASH');
    L.post(buildReceiptMove({ receiptId: 'rc1', date: '2026-09-01', customerName: 'عميل', salesRepName: REP_NAME, payload: r1 }, ctx));
    comp.receipts.push(ci('rc1', mOf(amount(1000)), next()));
    L.add('111001', mOf(amount(400)));
    comp.cashInvoices.push(ci('inv1', mOf(amount(400)), next()));
    L.post(buildReceiptMove({ receiptId: 'rb1', date: '2026-09-01', customerName: 'عميل', salesRepName: REP_NAME, payload: receiptPayload(amount(300), 'BANK_TRANSFER') }, ctx));
    comp.outsideReceipts.push(ci('rb1', mOf(amount(300)), next()));
    // 2) U1 يستلم نقداً 1200 (covered 1000 + r 200 منقول) وتحويلاً 300 (وعاء)
    settle('s1', amount(1200), 'CASH', 'U1', mOf(amount(400))); // r 200 مسنود بنقد الفاتورة غير المختومة في 111001
    settle('s2', amount(300), 'BANK_TRANSFER', 'U1');
    // 3) U1 يورّد تحويلاً 500 (300 مرور + 200 إيداع) ثم نقداً 600 ثم نقداً 100 يُحذف
    deliver('U1', 'd1', amount(500), 'BANK_TRANSFER');
    deliver('U1', 'd2', amount(600), 'CASH');
    const d3 = deliver('U1', 'd3', amount(100), 'CASH')!;
    L.post(invert(d3));
    U.U1.delivered.find((d) => d.id === 'd3')!.reversedAt = next();
    // 4) سند نقدي 500 يستلمه U2 ثم يُلغى بردٍّ من عهدته (C11)
    const r2 = receiptPayload(amount(500), 'CASH');
    const p2 = L.post(buildReceiptMove({ receiptId: 'rc2', date: '2026-09-02', customerName: 'عميل', salesRepName: REP_NAME, payload: r2 }, ctx))!;
    comp.receipts.push(ci('rc2', mOf(amount(500)), next()));
    settle('s3', amount(500), 'CASH', 'U2');
    const cancelAt = next();
    L.post(buildReceiptReversalMove({
      receiptId: 'rc2', date: '2026-09-03', customerName: 'عميل', salesRepName: REP_NAME, original: r2,
      reverse: { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'U2', cancelRefundUserName: 'U2' }, originalLines: p2.lines.filter((l) => !l.customerId),
    }, ctx));
    comp.receipts[1] = { ...comp.receipts[1], reversedAt: cancelAt, reversalOutsideCustody: true };
    U.U2.refunds.push({ id: 'rc2', amountMilli: mOf(amount(500)), at: cancelAt, createdAt: cancelAt });

    for (const u of ['U1', 'U2']) {
      const f = foldUserCustody(U[u]);
      assert.equal(L.get(`111004|${u}`), f.outstandingMilli, `منازل ${dec}: R4 للمستخدم ${u}`);
    }
    // U1: 1200 − (200 إيداع + 600) = 400 بالعملة
    assert.equal(foldUserCustody(U.U1).outstandingMilli, mOf(amount(1200)) - (mOf(amount(500)) - mOf(amount(300))) - mOf(amount(600)));
    assert.equal(foldUserCustody(U.U1).passThroughMilli, mOf(amount(300)));
    assert.equal(foldUserCustody(U.U2).outstandingMilli, 0n);
    assert.equal(L.get('111004'), L.get('111004|U1') + L.get('111004|U2'), 'كل سطر 111004 بمستخدم');
    // جانب المندوب: C4 وC4b
    const c = custodyComponentsForRep(comp, REP);
    assert.equal(c.ledgerCustody, L.get('111003|rep1'), `منازل ${dec}: C4`);
    assert.equal(custodyC4bGap(c), 0n, `منازل ${dec}: C4b`);
    assert.equal(L.get('911001'), 0n, 'لا معلّق');
  }
});
