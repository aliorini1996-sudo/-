// «ربط الدفاتر» L4+L5 (A1): أمثلة العقد المحلولة (§7) من **حمولة الاشتقاق** حتى القيد — صفوف مزيّفة ⇒ desired.ts (مربوطة)
// ⇒ builders (A3 الفاتورة، A4 السند والاسترداد، A5 الاستلام وتوريد المستخدم) ⇒ validateMove(SYSTEM). يثبت أن كل حقل حمولة
// جديد يصل الـbuilder بالشكل الذي يقرؤه، وأن القيود متّزنة بالملّي (التسامح صفر).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAccountEntryEvents, deriveRepSettlementEvents, deriveSettlementEntryEvents, deriveUserSettlementEvents,
  invoicePostEventPayload, receiptPostEventPayload, receiptReverseEventPayload,
  type AccountEntrySourceRow, type DeriveContext, type InvoiceFacts, type ReceiptFacts,
} from '../services/gl/sync/desired';
import { buildInvoiceMove } from '../services/gl/builders/invoice';
import { buildReceiptMove, buildReceiptReversalMove } from '../services/gl/builders/receipt';
import { buildPaylinkRefundMove } from '../services/gl/builders/paylink';
import { buildSettlementMove } from '../services/gl/builders/custody';
import { buildUserSettlementMove } from '../services/gl/builders/userCustody';
import { linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import { createBuildContext, type AccountRef, type BuildContext, type BuildResult, type LineDraft, type MoveDraft } from '../services/gl/types';
import type {
  InvoicePostEventPayload, PaylinkRefundEventPayload, ReceiptPostEventPayload, ReceiptReverseEventPayload,
  SettlementEventPayload, UserSettlementEventPayload,
} from '../services/gl/sync/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const TZ = 'Asia/Riyadh';
const AT = new Date('2026-11-14T09:00:00.000Z'); // 2026-11-14 بالرياض
const STC: AccountRef = { id: accountIdOf('111102'), code: '111102', name: 'محفظة STC Pay', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null };

function ctxOf(dec = 2, maps?: Record<string, string>): BuildContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { currencyDecimals: dec, receiptRouting: { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' }, cashInvoiceRouting: 'MAIN_CASH', linkedPosting: true },
    extraAccounts: [...linkedAccountRefs(accountIdOf), STC],
  } as Any);
  const pm = maps ? Object.fromEntries(Object.entries(maps).map(([k, code]) => [k, { accountId: accountIdOf(code), journalId: null }])) : undefined;
  return createBuildContext({ ...input, ...(pm ? { paymentMethodMaps: pm } : {}) });
}
const derive = (dec = 2, extra: Partial<DeriveContext> = {}): DeriveContext => ({ timezone: TZ, currency: 'SAR', currencyDecimals: dec, linked: true, ...extra });

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
function asMove(r: BuildResult): MoveDraft {
  if (r.kind !== 'MOVE') assert.fail(`NO_MOVE غير متوقع: ${show(r)}`);
  return r as MoveDraft;
}
interface L { code: string; dr: bigint; cr: bigint; line: LineDraft }
/** يتحقق بـvalidate (SYSTEM): متّزن ومحلول — ويعيد السطور برموز حساباتها */
function linesOf(r: BuildResult, ctx: BuildContext): L[] {
  const move = asMove(r);
  const v = validateMove(move, ctx, { mode: 'SYSTEM' });
  assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'القيد متّزن');
  return move.lines.map((line) => {
    const acc = resolveLineAccount(line, ctx.accounts);
    assert.ok(acc, `حساب غير محلول: ${show(line)}`);
    return { code: acc.code, dr: line.debitMilli, cr: line.creditMilli, line };
  });
}
const on = (ls: L[], code: string) => ls.filter((l) => l.code === code);
const total = (ls: L[], code: string, side: 'dr' | 'cr') => on(ls, code).reduce((s, l) => s + l[side], 0n);

function invoice(o: Partial<InvoiceFacts> & Pick<InvoiceFacts, 'id' | 'type'>): InvoiceFacts {
  return {
    number: `INV-${o.id}`, customerId: 'C', salesRepId: 'R', pricesIncludeTax: false, subtotal: 1000, discountAmt: 0, taxAmt: 150, total: 1150,
    dueDate: null, customerName: 'العميل C', salesRepName: 'المندوب R', invoiceDate: AT, customerPaymentDays: 30, cashCollectedByRep: false,
    installments: [], remainingApplied: null, saleInvoiceId: null, documentKind: null, originalInvoiceId: null,
    items: [{ productId: 'P', categoryId: null, qty: 10, unitPrice: 100, taxPct: 15, taxAmt: 150, lineTotal: 1150, vatCategory: 'S', baseQty: 240, unitFactor: 24, productName: 'كرتون P' }],
    ...o,
  };
}
const row = (id: string, type: string, o: Partial<AccountEntrySourceRow>): AccountEntrySourceRow => ({
  id, customerId: 'C', invoiceId: null, receiptId: null, type, debit: 0, credit: 0, description: null, entryDate: AT, createdAt: AT, ...o,
});

// ═══ L4 ═══

test('E4.1 آجل بقسطين: سطرا 113001 بمبلغ كل قسط واستحقاقه، والإيراد للصنف P بكمية الأساس 240، والضريبة 150', () => {
  const f = invoice({
    id: 'INV1001', type: 'CREDIT', dueDate: new Date('2027-01-12T21:00:00Z'),
    installments: [{ seq: 1, dueDate: new Date('2026-12-13T21:00:00Z'), amount: 575 }, { seq: 2, dueDate: new Date('2027-01-12T21:00:00Z'), amount: 575 }],
  });
  const [ev] = deriveAccountEntryEvents([row('a1', 'INVOICE_DEBIT', { invoiceId: f.id, debit: 1150 })], derive(2, { invoices: new Map([[f.id, f]]) }));
  const ctx = ctxOf();
  const ls = linesOf(buildInvoiceMove(ev.payload as InvoicePostEventPayload, ctx), ctx);
  const ar = on(ls, '113001');
  assert.deepEqual(ar.map((l) => [l.dr, l.line.dueDate, l.line.customerId, l.line.salesRepId]), [
    [575_000n, '2026-12-14', 'C', 'R'], [575_000n, '2027-01-13', 'C', 'R'],
  ]);
  const rev = on(ls, '411001');
  assert.equal(rev.length, 1);
  assert.deepEqual([rev[0].cr, rev[0].line.productId, rev[0].line.quantity], [1_000_000n, 'P', 240]);
  assert.equal(total(ls, '212001', 'cr'), 150_000n);
  assert.equal(on(ls, '911001').length, 0);
});

test('E4.2/E4.3 النقدية: المختومة ⇒ ساق النقد إلى 111003 بالمندوب، وغير المختومة ⇒ 111001 (cashInvoiceRouting)', () => {
  for (const [stamp, cashCode] of [[true, '111003'], [false, '111001']] as const) {
    const f = invoice({ id: `INV1002${stamp}`, type: 'CASH', subtotal: 100, taxAmt: 15, total: 115, cashCollectedByRep: stamp,
      items: [{ productId: 'P', categoryId: null, qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115, vatCategory: 'S', baseQty: null, unitFactor: 1, productName: null }] });
    const p = invoicePostEventPayload(f, '2026-11-14', derive(), null);
    assert.equal((p as Any).cashCollectedByRep, stamp ? true : undefined);
    const ctx = ctxOf();
    const ls = linesOf(buildInvoiceMove(p, ctx), ctx);
    assert.equal(total(ls, '113001', 'dr'), 115_000n);
    assert.equal(total(ls, '113001', 'cr'), 115_000n);
    assert.equal(total(ls, '411001', 'cr'), 100_000n);
    assert.equal(total(ls, '212001', 'cr'), 15_000n);
    const cash = on(ls, cashCode);
    assert.deepEqual(cash.map((l) => l.dr), [115_000n], `stamp=${stamp}`);
    if (stamp) assert.equal(cash[0].line.salesRepId, 'R');
  }
});

test('E4.4 استحقاق افتراضي: آجلة 2026-11-14 بلا استحقاق وpaymentDays 30 ⇒ سطر 113001 باستحقاق 2026-12-14', () => {
  const p = invoicePostEventPayload(invoice({ id: 'INV1004', type: 'CREDIT' }), '2026-11-14', derive(), null);
  const ctx = ctxOf();
  const ar = on(linesOf(buildInvoiceMove(p, ctx), ctx), '113001');
  assert.deepEqual(ar.map((l) => [l.dr, l.line.dueDate]), [[1_150_000n, '2026-12-14']]);
});

test('E4.7/E4.8 منازل 3 و0: الحمولة بنصوص منازلها والقيد متّزن بلا 911001', () => {
  const bhd = invoice({ id: 'B1', type: 'CREDIT', subtotal: 0.999, taxAmt: 0.1, total: 1.099,
    items: [{ productId: 'P', categoryId: null, qty: 3, unitPrice: 0.333, taxPct: 10, taxAmt: 0.1, lineTotal: 1.099, vatCategory: 'S', baseQty: 3, unitFactor: 1, productName: 'P' }] });
  const ctx3 = ctxOf(3);
  const p3 = invoicePostEventPayload(bhd, '2026-11-14', derive(3), null);
  assert.deepEqual([p3.subtotal, p3.taxAmt, p3.total], ['0.999', '0.100', '1.099']);
  const ls3 = linesOf(buildInvoiceMove(p3, ctx3), ctx3);
  assert.equal(total(ls3, '113001', 'dr'), 1_099n);
  assert.equal(total(ls3, '411001', 'cr'), 999n);
  assert.equal(on(ls3, '911001').length, 0);
  const iqd = invoice({ id: 'Q1', type: 'CREDIT', subtotal: 3000, taxAmt: 0, total: 3000,
    items: [{ productId: 'P', categoryId: null, qty: 2, unitPrice: 1500, taxPct: 0, taxAmt: 0, lineTotal: 3000, vatCategory: null, baseQty: 2, unitFactor: 1, productName: 'P' }] });
  const ctx0 = ctxOf(0);
  const p0 = invoicePostEventPayload(iqd, '2026-11-14', derive(0), null);
  assert.deepEqual([p0.subtotal, p0.total], ['3000', '3000']);
  const ls0 = linesOf(buildInvoiceMove(p0, ctx0), ctx0);
  assert.equal(total(ls0, '113001', 'dr'), 3_000_000n);
  assert.equal(on(ls0, '911001').length, 0);
});

// ═══ L5 ═══

function receipt(o: Partial<ReceiptFacts> & Pick<ReceiptFacts, 'id'>): ReceiptFacts {
  return {
    number: `RC-${o.id}`, customerId: 'C', salesRepId: 'R', paymentMethod: 'CASH', amount: 500, customerName: 'العميل C', salesRepName: 'المندوب R',
    paylinkId: null, refund: null, paymentMethodKey: null, cardPaymentId: null, allocations: [], cancelRefundFrom: null, cancelRefundUserId: null, cancelRefundUserName: null,
    ...o,
  };
}
const postInput = (p: ReceiptPostEventPayload) => ({ receiptId: p.receiptId, number: p.number, date: p.entryDate, payload: p, customerName: p.customerName, salesRepName: p.salesRepName });

test('E5.1/E5.2/E5.3/E5.4/E5.5 السند من الحمولة: عهدة المندوب، والبنك، والطريقة المخصّصة، والبطاقة، ونقطة البيع', () => {
  const ctx = ctxOf(2, { c_stcpay: '111102' });
  const cases: [Partial<ReceiptFacts>, string, string | null][] = [
    [{ paymentMethod: 'CASH' }, '111003', 'R'],
    [{ paymentMethod: 'BANK_TRANSFER' }, '111101', null],
    [{ paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_stcpay' }, '111102', null],
    [{ paymentMethod: 'POS', cardPaymentId: 'cp1', amount: 230 }, '112007', null],
    [{ paymentMethod: 'POS', amount: 300 }, '112004', null],
  ];
  for (const [o, code, rep] of cases) {
    const p = receiptPostEventPayload(receipt({ id: 'r', ...o }), '2026-11-14', derive(), null);
    const ls = linesOf(buildReceiptMove(postInput(p), ctx), ctx);
    const dr = ls.filter((l) => l.dr > 0n);
    assert.deepEqual(dr.map((l) => l.code), [code], show(o));
    assert.equal(dr[0].line.salesRepId ?? null, rep, show(o));
    assert.equal(total(ls, '113001', 'cr'), toAmt(Number(o.amount ?? 500)), show(o));
  }
});
const toAmt = (n: number): bigint => BigInt(Math.round(n * 1000));

test('E5.7 إلغاء بعد التسليم: مصدر الردّ من حمولة العكس ⇒ 111001 أو 111004 بالمستخدم (لا 111003)', () => {
  const ctx = ctxOf();
  const f = receipt({ id: 'r7' });
  const original = receiptPostEventPayload(f, '2026-11-10', derive(), null);
  for (const [from, code, user] of [['MAIN_CASH', '111001', null], ['USER_CUSTODY', '111004', 'U']] as const) {
    const rev = receiptReverseEventPayload({ ...f, cancelRefundFrom: from, cancelRefundUserId: user, cancelRefundUserName: user ? 'المستخدم U' : null }, '2026-11-12', derive(), null);
    const ls = linesOf(buildReceiptReversalMove({ receiptId: 'r7', number: 'RC-r7', date: rev.entryDate, original, reverse: rev, customerName: 'العميل C' }, ctx), ctx);
    assert.equal(total(ls, '113001', 'dr'), 500_000n, from);
    const cr = ls.filter((l) => l.cr > 0n);
    assert.deepEqual(cr.map((l) => l.code), [code], from);
    assert.equal(cr[0].line.adminUserId ?? null, user, from);
    assert.equal(cr[0].line.salesRepId ?? null, null, `${from}: لا بُعد مندوب`);
  }
});

test('E5.8 الاسترداد بعد إلغاء يدوي: حمولة PAYLINK_REFUND ⇒ Dr 214002 / Cr 112005؛ والمسار العادي ⇒ NETTED', () => {
  const ctx = ctxOf();
  const evs = deriveSettlementEntryEvents(
    [{ id: 'se1', kind: 'REFUND', amount: -1000, feeNet: null, feeVat: null, linkId: 'L1', payoutId: null, note: null, createdAt: AT }],
    derive(2, { refundLinks: new Map([['L1', { receiptId: 'rc1', customerId: 'C', customerName: 'العميل C' }]]) }),
  );
  const payload = evs[0].payload as PaylinkRefundEventPayload;
  const ls = linesOf(buildPaylinkRefundMove({ payload, receiptReverseRefundEntryId: null, date: '2026-11-14' }, ctx), ctx);
  assert.equal(total(ls, '214002', 'dr'), 1_000_000n);
  assert.equal(total(ls, '112005', 'cr'), 1_000_000n);
  const netted = buildPaylinkRefundMove({ payload, receiptReverseRefundEntryId: 'se1', date: '2026-11-14' }, ctx);
  assert.equal(netted.kind, 'NO_MOVE');
  assert.equal((netted as Any).reason, 'NETTED');
});

test('E5.10 الاستلام بمستخدم من حمولة الاستلام ⇒ Dr 111004 [U] بلا salesRepId / Cr 111003 [R]؛ والتحويل ⇒ 111101', () => {
  const ctx = ctxOf();
  for (const [method, code] of [['CASH', '111004'], ['BANK_TRANSFER', '111101']] as const) {
    const [ev] = deriveRepSettlementEvents(
      [{ id: 's1', salesRepId: 'R', amount: 800, method, note: null, settledAt: AT, createdAt: AT, receivedByUserId: 'U' }],
      derive(2, { salesRepNames: new Map([['R', 'المندوب R']]), userNames: new Map([['U', 'المستخدم U']]) }),
    );
    const payload = ev.payload as SettlementEventPayload;
    assert.deepEqual([payload.receivedByUserId, payload.receivedByName], ['U', 'المستخدم U']);
    const b = buildSettlementMove({
      settlementId: 's1', payload, salesRepName: 'المندوب R', custodyBalanceMilli: 800_000n,
      cumulativeNonCustodyClearedMilli: 0n, nonCustodyAllowanceMilli: 0n,
    }, ctx);
    const ls = linesOf(b.result, ctx);
    const dr = ls.filter((l) => l.dr > 0n);
    assert.deepEqual(dr.map((l) => [l.code, l.dr]), [[code, 800_000n]], method);
    if (code === '111004') {
      assert.equal(dr[0].line.adminUserId, 'U');
      assert.equal(dr[0].line.salesRepId ?? null, null, 'ثابت البُعد D2');
    }
    assert.equal(total(ls, '111003', 'cr'), 800_000n, method);
  }
});

test('E5.11 توريد المستخدم من حمولة USER_SETTLEMENT ⇒ Dr 111001 أو 111101 / Cr 111004 [U]؛ والمرور كله ⇒ NETTED', () => {
  const ctx = ctxOf();
  for (const [method, code] of [['CASH', '111001'], ['BANK_TRANSFER', '111101']] as const) {
    const [ev] = deriveUserSettlementEvents(
      [{ id: 'us1', fromUserId: 'U', amount: 800, method, note: null, receivedBy: 'المدير', receivedByUserId: 'boss', settledAt: AT, createdAt: AT }],
      derive(2, { userNames: new Map([['U', 'المستخدم U']]) }),
    );
    const payload = ev.payload as UserSettlementEventPayload;
    const b = buildUserSettlementMove({ userSettlementId: 'us1', payload, date: '2026-11-14', split: { passThroughMilli: 0n, custodyMilli: 800_000n } }, ctx);
    const ls = linesOf(b.result, ctx);
    assert.deepEqual(ls.filter((l) => l.dr > 0n).map((l) => [l.code, l.dr]), [[code, 800_000n]], method);
    const cr = on(ls, '111004');
    assert.deepEqual(cr.map((l) => [l.cr, l.line.adminUserId]), [[800_000n, 'U']], method);
  }
  const [ev] = deriveUserSettlementEvents(
    [{ id: 'us2', fromUserId: 'U', amount: 300, method: 'BANK_TRANSFER', note: null, receivedBy: null, receivedByUserId: null, settledAt: AT, createdAt: AT }], derive(),
  );
  const pass = buildUserSettlementMove({ userSettlementId: 'us2', payload: ev.payload as UserSettlementEventPayload, date: '2026-11-14', split: { passThroughMilli: 300_000n, custodyMilli: 0n } }, ctxOf());
  assert.equal(pass.result.kind, 'NO_MOVE');
});
