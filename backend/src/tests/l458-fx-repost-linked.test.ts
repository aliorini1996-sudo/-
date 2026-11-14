// «ربط الدفاتر» — إصلاح «إعادة الترحيل من المصدر» في الدفاتر المربوطة (repostFromSource فوق المخزن المزيّف والمُرحِّل الحقيقي):
//  (١) السند يُعاد بحقول L5 (cardPaymentId ⇒ 112007، والطريقة المخصّصة ⇒ حساب خريطتها الحالي) لا إلى 112004/111101؛
//  (٢) العكس يفكّ المطابقة الجزئية والقيد الجديد يلتقطها (RI على القيد الحيّ، والأصل مطابَق بعكسه REV) — للمربوطة وحدها؛
//  (٣) P7 إلى مستخدم يُعاد بمعلّقه كما رُحّل (سطور 911001) لا بـ«Σ المدين» فلا ينتقل r من حساب الطريقة إلى 911001؛
//      ومعه إصلاح P7 نفسه: r الإلكتروني غير المسنود معلّق 911001، لا دائنٌ صامت لـ111001؛
//  (٤) قيد تسوية ذمم العميل (M4) يُرفض NO_RECIPE بمصدره وبحمولته، بلا أي كتابة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { SYSTEM_ACTOR } from '../services/gl/audit';
import { invoiceKey, receiptKey, settlementKey, arEntryKey } from '../services/gl/sync/keys';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { buildCustomerAdjustmentMove } from '../services/gl/builders/customerAdjustment';
import { buildSettlementMove, linkedSettlementRebuildFromLines } from '../services/gl/builders/custody';
import { createSyncBudget, runPoster, settlementRebuildInputs, debitTotalMilli } from '../services/gl/sync/poster';
import { RepostRejectedError, repostFromSource, repostPrecheck, type RepostMoveFacts } from '../services/gl/sync/repost';
import type { DesiredEvent, SourceEventPayload } from '../services/gl/sync/types';
import { isNoMove, type AccountRef, type MoveDraft } from '../services/gl/types';
import { resolveLineAccount } from '../services/gl/validate';
import { FakePostingStore, type FakeMove } from './gl-fake-posting-store';

const at = (iso: string) => new Date(iso);
const NOW = () => at('2027-03-01T10:00:00.000Z').getTime();
const A = (code: string) => accountIdOf(code);
const AR = A('113001');
const bank = (code: string, name: string): AccountRef => ({ id: A(code), code, name, type: 'asset_cash', isActive: true, reconcile: false, controlKind: null });
const BANK2 = bank('111102', 'بنك ثانٍ');
const BANK3 = bank('111103', 'بنك ثالث');

const pulse = (s: FakePostingStore) => runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 100 }), { log: () => undefined });

function factsOf(s: FakePostingStore, m: FakeMove, sourceType?: string): RepostMoveFacts {
  const sources = [...s.state.sources.entries()].filter(([, id]) => id === m.id).map(([sourceKey]) => ({
    sourceKey, sourceType: sourceType ?? m.sourceType ?? '', sourceId: m.sourceId ?? '', event: sourceKey.includes(':REPOST_REV:') ? 'REVERSE' : 'POST',
  }));
  return { id: m.id, number: m.number, state: 'POSTED', origin: 'AUTO', date: m.date, originalDate: m.originalDate, lateArrival: m.lateArrival, secureHash: null, sources };
}
const repost = (s: FakePostingStore, f: RepostMoveFacts) =>
  s.withPostLock('t1', (tx) => repostFromSource(tx, { move: f, actor: SYSTEM_ACTOR, timezone: 'Asia/Riyadh' }));
const moveOf = (s: FakePostingStore, key: string) => s.state.moves.get(s.event(key)!.moveId!)!;
const debitOn = (m: FakeMove, accountId: string) => m.lines.filter((l) => l.accountId === accountId).reduce((a, l) => a + l.debitMilli - l.creditMilli, 0n);
const lineIds = (m: FakeMove) => m.lines.map((l, i) => l.id ?? `${m.id}:${i}`);
const arLineIds = (m: FakeMove) => m.lines.map((l, i) => (l.accountId === AR ? l.id ?? `${m.id}:${i}` : null)).filter((x): x is string => !!x);

function receiptEvent(id: string, p: Record<string, unknown>): DesiredEvent {
  return {
    sourceKey: receiptKey(id, 'POST'), sourceType: 'RECEIPT', sourceId: id, event: 'POST', effectAt: at('2027-02-12T08:00:00.000Z'),
    payload: {
      receiptId: id, number: `R-${id}`, entryDate: '2027-02-12', salesRepId: null, paymentMethod: 'CASH', amount: '100.00', customerId: 'c1',
      paylinkId: null, customerName: 'عميل أول', salesRepName: null, sourceCreatedAt: '2027-02-12T08:00:00.000Z', ...p,
    } as SourceEventPayload,
  };
}

// ═══ (١) حقول L5 في وصفة السند ═══

test('سند بطاقة NearPay في المربوطة: إعادة ترحيله تبقى على 112007 (لا 112004)، فيجده CARD_SETTLEMENT', async () => {
  const s = new FakePostingStore({ linked: true, now: NOW });
  s.seedEvents([receiptEvent('r1', { paymentMethod: 'POS', amount: '230.00', salesRepId: 'rep1', salesRepName: 'مندوب', cardPaymentId: 'cp1' })]);
  await pulse(s);
  const live = moveOf(s, receiptKey('r1', 'POST'));
  assert.equal(debitOn(live, A('112007')), 230_000n);
  const r = await repost(s, factsOf(s, live));
  const reposted = s.state.moves.get(r.repost.id)!;
  assert.equal(debitOn(reposted, A('112007')), 230_000n, 'القيد المعاد على حساب تسوية البطاقة');
  assert.equal(debitOn(reposted, A('112004')), 0n);
  assert.equal(s.balance(A('112007')), 230_000n);
  assert.equal(s.balance(A('112004')), 0n, 'لا تضخّم لنقاط البيع');
});

test('طريقة مخصّصة c_stc: إعادة الترحيل بعد تعديل خريطتها تذهب إلى حسابها الجديد (لا إلى أساسها 111101)', async () => {
  const s = new FakePostingStore({
    linked: true, now: NOW, context: { extraAccounts: [BANK2, BANK3] },
    paymentMethodMaps: { c_stc: { accountId: BANK2.id, journalId: null } },
  });
  s.seedEvents([receiptEvent('r2', { paymentMethod: 'BANK_TRANSFER', amount: '50.00', paymentMethodKey: 'c_stc' })]);
  await pulse(s);
  const live = moveOf(s, receiptKey('r2', 'POST'));
  assert.equal(debitOn(live, BANK2.id), 50_000n);
  s.opts.paymentMethodMaps = { c_stc: { accountId: BANK3.id, journalId: null } };
  const reposted = s.state.moves.get((await repost(s, factsOf(s, live))).repost.id)!;
  assert.equal(debitOn(reposted, BANK3.id), 50_000n, 'الخريطة الحالية للمفتاح المخصّص');
  assert.equal(debitOn(reposted, A('111101')), 0n);
  assert.deepEqual([s.balance(BANK2.id), s.balance(BANK3.id), s.balance(A('111101'))], [0n, 50_000n, 0n]);
});

// ═══ (٢) المطابقة الجزئية مع إعادة الترحيل ═══

function creditInvoiceEvent(id: string): DesiredEvent {
  const payload = invoicePayloadFromRows({
    invoice: { id, number: `INV-${id}`, type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: 1000, discountAmt: 0, taxAmt: 150, total: 1150 },
    items: [{ qty: 1, unitPrice: 1000, taxPct: 15, taxAmt: 150, lineTotal: 1150 }],
    customerName: 'عميل أول', entryDate: '2027-02-10', currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: at('2027-02-10T08:00:00.000Z'),
    payload: { ...payload, sourceCreatedAt: '2027-02-10T08:00:00.000Z' } as SourceEventPayload,
  };
}

async function invoiceWithAllocatedReceipt(linked: boolean) {
  const s = new FakePostingStore({ linked, now: NOW });
  s.seedEvents([
    creditInvoiceEvent('i1'),
    receiptEvent('r1', { amount: '600.00', ...(linked ? { allocations: [{ id: 'ri1', invoiceId: 'i1', amount: '600.00' }] } : {}) }),
  ]);
  await pulse(s);
  return { s, inv: moveOf(s, invoiceKey('i1', 'POST')), rc: moveOf(s, receiptKey('r1', 'POST')) };
}

/** Σ متبقّي سطور الذمة المدينة لعميل (قاعدة openArByCustomer لـC16) */
const openArDebit = (s: FakePostingStore) => s.moves().reduce((t, m) => t + m.lines.reduce((a, l, i) =>
  (l.accountId === AR && l.debitMilli > 0n ? a + s.lineResidual(l.id ?? `${m.id}:${i}`) : a), 0n), 0n);

test('إعادة ترحيل فاتورة مطابَقة: العكس يفكّ RI ويطابق الأصل بعكسه (REV)، والقيد الجديد يلتقط RI — المتبقّي 550 لا 1,700', async () => {
  const { s, inv, rc } = await invoiceWithAllocatedReceipt(true);
  assert.deepEqual(s.partials().map((p) => [p.sourceRef, p.amountMilli]), [['RI:ri1', 600_000n]]);
  const r = await repost(s, factsOf(s, inv));
  const rev = s.state.moves.get(r.reversal.id)!;
  const fresh = s.state.moves.get(r.repost.id)!;

  const ri = s.partials().filter((p) => p.sourceRef === 'RI:ri1');
  assert.deepEqual([ri.reduce((a, p) => a + p.amountMilli, 0n), [...new Set(ri.map((p) => p.debitMoveId))]], [600_000n, [fresh.id]], 'RI على القيد الحيّ');
  assert.ok(s.partials().filter((p) => lineIds(inv).includes(p.debitLineId) || lineIds(inv).includes(p.creditLineId))
    .every((p) => p.sourceRef === `REV:${rev.id}`), 'لا مطابقة باقية على قيدٍ معكوس');
  for (const id of [...arLineIds(inv), ...arLineIds(rev)]) assert.equal(s.lineResidual(id), 0n, `${id}: الأصل وعكسه مطابَقان كلياً`);
  assert.equal(arLineIds(fresh).reduce((a, id) => a + s.lineResidual(id), 0n), 550_000n);
  assert.equal(arLineIds(rc).reduce((a, id) => a + s.lineResidual(id), 0n), 0n, 'دائن السند مخصّص بكامله');
  assert.equal(openArDebit(s), 550_000n, 'C16: الذمم المفتوحة = remainingAmt 550');

  // إعادة ترحيل السند نفسه: RI ينتقل إلى قيده الجديد ويبقى مدين الفاتورة 550
  const r2 = await repost(s, factsOf(s, rc));
  const rc2 = s.state.moves.get(r2.repost.id)!;
  assert.deepEqual([...new Set(s.partials().filter((p) => p.sourceRef === 'RI:ri1').map((p) => p.creditMoveId))], [rc2.id]);
  assert.equal(arLineIds(fresh).reduce((a, id) => a + s.lineResidual(id), 0n), 550_000n);
  assert.equal(openArDebit(s), 550_000n);
});

test('غير المربوطة: إعادة الترحيل لا تكتب مطابقة (السلوك القديم بايتاً)', async () => {
  const { s, inv } = await invoiceWithAllocatedReceipt(false);
  await repost(s, factsOf(s, inv));
  assert.deepEqual(s.partials(), []);
});

// ═══ (٣) P7 إلى مستخدم ═══

function settlementStore() {
  const settledAt = '2027-02-10T09:00:00.000Z';
  let s: FakePostingStore | null = null;
  // سند نقدي 700 في العهدة + تحويل 300 مباشر (خارج العهدة: 111101) ⇒ الشاشة 1,000؛ الأدمن U1 يستلم 1,000 «نقداً»
  const custody = () => ({
    receipts: [{ id: 'rc1', salesRepId: 'rep1', amountMilli: 700_000n, effectAt: '2027-02-10T07:00:00.000Z' }],
    onlineReceipts: [], outsideReceipts: [{ id: 'or1', salesRepId: 'rep1', amountMilli: 300_000n, effectAt: '2027-02-10T07:30:00.000Z' }],
    cashInvoices: [], shortages: [], custodyExpenses: [],
    settlements: [{
      id: 'st1', salesRepId: 'rep1', amountMilli: 1_000_000n, effectAt: settledAt, createdAt: settledAt,
      nonCustodyClearedMilli: s!.event(settlementKey('st1', 'POST'))?.nonCustodyClearedMilli ?? null,
      shortageRecoveredMilli: s!.event(settlementKey('st1', 'POST'))?.shortageRecoveredMilli ?? null,
    }],
    routing: { cashInvoice: 'MAIN_CASH' as const, receipt: { CASH: 'CUSTODY' as const } },
  });
  s = new FakePostingStore({ linked: true, now: NOW, custody });
  s.setCursor('ACCOUNT_ENTRY', at('2027-02-11T00:00:00.000Z'), 'z');
  s.setCursor('REP_SETTLEMENT', at('2027-02-11T00:00:00.000Z'), 'z');
  s.seedEvents([{
    sourceKey: settlementKey('st1', 'POST'), sourceType: 'SETTLEMENT', sourceId: 'st1', event: 'POST', effectAt: at(settledAt),
    payload: {
      settlementId: 'st1', amount: '1000.00', method: 'CASH', salesRepId: 'rep1', settledAt, createdAt: settledAt, salesRepName: 'مندوب',
      receivedByUserId: 'U1', receivedByName: 'سعد',
    } as SourceEventPayload,
  }]);
  return s;
}
const shape = (m: FakeMove) => m.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli] as const);
const byAccount = (m: FakeMove) => {
  const out = new Map<string, bigint>();
  for (const l of m.lines) out.set(l.accountId, (out.get(l.accountId) ?? 0n) + l.debitMilli - l.creditMilli);
  return [...out.entries()].sort();
};

test('P7 إلى مستخدم بـr إلكتروني: لا دائن صامت لـ111001 (يبقى صفراً) بل معلّق 911001 مع تنبيه؛ وإعادة الترحيل تعيده كما رُحّل', async () => {
  const s = settlementStore();
  await pulse(s);
  const ev = s.event(settlementKey('st1', 'POST'))!;
  assert.equal(ev.status, 'DONE');
  assert.equal(ev.nonCustodyClearedMilli, 300_000n, 'covered 700 وr 300');
  const live = s.state.moves.get(ev.moveId!)!;
  assert.deepEqual(shape(live), [
    [A('111004'), 1_000_000n, 0n], [A('111003'), 0n, 700_000n], [A('911001'), 0n, 300_000n],
  ]);
  assert.equal(live.needsAttention, true);
  assert.equal(s.balance(A('111001')), 0n, 'الصندوق لم يدخله مال ولم يخرج');
  assert.equal(s.balanceBy(A('111004'), 'adminUserId', 'U1'), 1_000_000n, 'R4: 111004 = طيّ OD5');

  const r = await repost(s, factsOf(s, live));
  assert.deepEqual(byAccount(s.state.moves.get(r.repost.id)!), byAccount(live), 'إعادة الترحيل بالأثر نفسه حساباً حساباً');
  assert.equal(s.balance(A('111001')), 0n);
  assert.equal(s.balance(A('911001')), -300_000n);
});

test('P7 إلى مستخدم بنقلٍ مسنود (Cr 111001 r): مدخلات إعادة البناء من سطور 911001 تعيده حرفاً — لا «Σ المدين» الذي يقلبه إلى 911001', async () => {
  const s = new FakePostingStore({ linked: true });
  await s.withPostLock('t1', async (tx) => tx.ensureLinkedAccounts?.()); // 111004 في السياق كما يُنشئه المُرحِّل
  const ctx = s.context().ctx;
  const payload = { amount: '1000.00', method: 'CASH', salesRepId: 'rep1', settledAt: '2027-02-10T09:00:00.000Z', receivedByUserId: 'U1', receivedByName: 'سعد' };
  // covered 700، r 300 مسنود بنقد فاتورة غير مختومة في 111001
  const original = buildSettlementMove({
    settlementId: 'st1', payload, salesRepName: 'مندوب', custodyBalanceMilli: 700_000n, cumulativeNonCustodyClearedMilli: 0n,
    nonCustodyAllowanceMilli: 300_000n, methodReclassAllowanceMilli: 300_000n,
  }, ctx);
  assert.ok(!isNoMove(original.result));
  const lines = (original.result as MoveDraft).lines.map((l) => ({ ...l, accountId: resolveLineAccount(l, ctx.accounts)!.id }));
  const sum = (ls: typeof lines) => {
    const out = new Map<string, bigint>();
    for (const l of ls) out.set(l.accountId, (out.get(l.accountId) ?? 0n) + l.debitMilli - l.creditMilli);
    return [...out.entries()].sort();
  };
  assert.deepEqual(sum(lines).find(([id]) => id === A('111001'))?.[1], -300_000n);
  const outcome = { amountMilli: 1_000_000n, coveredMilli: 700_000n, recoveredMilli: 0n, nonCustodyClearedMilli: 300_000n, suspenseMilli: 0n };
  const rebuild = (inputs: ReturnType<typeof settlementRebuildInputs> & { methodReclassAllowanceMilli?: bigint }) => {
    const b = buildSettlementMove({ settlementId: 'st1', payload, salesRepName: 'مندوب', date: '2027-02-10', ...inputs }, ctx).result as MoveDraft;
    return sum(b.lines.map((l) => ({ ...l, accountId: resolveLineAccount(l, ctx.accounts)!.id })));
  };
  const fixed = linkedSettlementRebuildFromLines(outcome, lines, ctx);
  assert.deepEqual(fixed, { postedDebitMilli: 700_000n, methodReclassAllowanceMilli: 300_000n });
  assert.deepEqual(rebuild({ ...settlementRebuildInputs(outcome, fixed.postedDebitMilli), methodReclassAllowanceMilli: fixed.methodReclassAllowanceMilli }), sum(lines));
  // الاشتقاق القديم من Σ المدين (= المبلغ كاملاً بسطر النقل) كان يجعل المعلّق r كلّه
  const old = rebuild(settlementRebuildInputs(outcome, debitTotalMilli(lines)));
  assert.deepEqual(old.find(([id]) => id === A('911001'))?.[1], -300_000n, 'العيب: 300 تنتقل إلى المعلّق');
});

// ═══ (٤) قيد تسوية ذمم العميل M4 ═══

test('قيد تسوية M4 (AR_ENTRY:<id>:POST بمصدر CUSTOMER_ADJUSTMENT) يُرفض NO_RECIPE بمصدره وبحمولته — بلا عكس ولا قيد', async () => {
  const s = new FakePostingStore({ linked: true, now: NOW });
  const ctx = s.context();
  const posted = await s.withPostLock('t1', (tx) => tx.postMove(buildCustomerAdjustmentMove({
    adjustmentId: 'adj1', kind: 'BAD_DEBT_WRITEOFF', customerId: 'c1', customerName: 'عميل أول', amount: '300.00',
    counterAccountCode: '711005', docDate: '2027-02-10',
  }, ctx.ctx) as MoveDraft, { actor: SYSTEM_ACTOR, context: ctx, validationMode: 'SYSTEM', lockPolicy: 'SHIFT' }));
  s.seedEvents([{
    sourceKey: arEntryKey('adj1', 'POST'), sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: 'adj1', event: 'POST', effectAt: at('2027-02-10T09:00:00.000Z'),
    status: 'DONE', payload: {
      origin: 'CUSTOMER_ADJUSTMENT', entryId: 'adj1', customerId: 'c1', customerName: 'عميل أول', debit: '0', credit: '300.00',
      entryDate: '2027-02-10T09:00:00.000Z', kind: 'BAD_DEBT_WRITEOFF',
    } as unknown as SourceEventPayload,
  }]);
  const move = s.state.moves.get(posted.id)!;
  const facts = factsOf(s, move);
  assert.equal(facts.sources[0].sourceKey, 'AR_ENTRY:adj1:POST');
  assert.throws(() => repostPrecheck(facts), (e: unknown) => e instanceof RepostRejectedError && e.reason === 'NO_RECIPE');
  const count = s.moves().length;
  await assert.rejects(repost(s, facts), (e: unknown) => e instanceof RepostRejectedError && e.reason === 'NO_RECIPE');
  // دفاعٌ بالحمولة: مصدرٌ مخزَّن بنوع AR_ENTRY وحمولته تسوية M4 ⇒ الرفض نفسه قبل أي عكس
  await assert.rejects(repost(s, factsOf(s, move, 'AR_ENTRY')), (e: unknown) => e instanceof RepostRejectedError && e.reason === 'NO_RECIPE');
  assert.equal(s.moves().length, count, 'لا قيد عكس ولا إعادة');
  assert.equal(move.reversalId, null);
});
