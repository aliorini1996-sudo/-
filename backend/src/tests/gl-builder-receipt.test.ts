// M1 — builder سند القبض (DESIGN.md §5.5 P5 وP6، §5.2، §5.8، §10.1 gl-builder-receipt.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReceiptMove, buildReceiptReversalMove, MANUAL_ONLINE_CANCEL_ATTENTION, NO_LINK_ATTENTION, receiptKey,
  type ReceiptPostPayload,
} from '../services/gl/builders/receipt';
import { saContext, accountIdOf } from '../services/gl/testing/fixtures';
import { validateMove, resolveLineAccount } from '../services/gl/validate';
import { isNoMove, type BuildContext, type BuildResult, type MoveDraft, type ReceiptRouting } from '../services/gl/types';

const ALL_CUSTODY: ReceiptRouting = { CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' };

const ARABIC = /[؀-ۿ]/;

/** كل قيد يمر من هنا (مباشرة أو عبر checked): narration وlabel بالعربية (§10.1 M1، G7) */
function asMove(r: BuildResult): MoveDraft {
  assert.equal(r.kind, 'MOVE');
  const move = r as MoveDraft;
  assert.match(move.narration, ARABIC, 'narration عربي غير فارغ');
  for (const l of move.lines) assert.match(l.label, ARABIC, 'label عربي غير فارغ');
  return move;
}

/** يتحقق بـvalidate.ts ويعيد {code: [مدين، دائن]} */
function checked(r: BuildResult, ctx: BuildContext): Record<string, [bigint, bigint]> {
  const move = asMove(r);
  const v = validateMove(move, ctx);
  assert.equal(v.totalDebitMilli, v.totalCreditMilli);
  assert.match(move.narration, ARABIC, 'narration عربي غير فارغ');
  const out: Record<string, [bigint, bigint]> = {};
  for (const l of move.lines) {
    assert.match(l.label, ARABIC, 'label عربي غير فارغ');
    if (l.customerId || l.vendorId || l.salesRepId) assert.ok(l.partnerName && l.partnerName.trim(), 'partnerName إلزامي');
    const acc = resolveLineAccount(l, ctx.accounts)!;
    const cur = out[acc.code] ?? [0n, 0n];
    out[acc.code] = [cur[0] + l.debitMilli, cur[1] + l.creditMilli];
  }
  return out;
}

const base = (p: Partial<ReceiptPostPayload>): ReceiptPostPayload => ({
  salesRepId: 'rep1', paymentMethod: 'CASH', amount: '300.00', customerId: 'cus1', ...p,
});

const post = (ctx: BuildContext, p: Partial<ReceiptPostPayload>) =>
  buildReceiptMove({ receiptId: 'r1', number: 'RC-1', date: '2026-09-10', payload: base(p), customerName: 'بقالة النور', salesRepName: 'أحمد' }, ctx);

test('P5: بلا توجيه عهدة ⇒ الطرق المباشرة، ودائن 113001 بالعميل', () => {
  const ctx = saContext();
  const cases: [string, string][] = [['CASH', '111001'], ['BANK_TRANSFER', '112001'], ['POS', '112004'], ['CHEQUE', '112003']];
  for (const [method, code] of cases) {
    const r = post(ctx, { paymentMethod: method });
    const s = checked(r, ctx);
    assert.deepEqual(s[code], [300_000n, 0n], method);
    assert.deepEqual(s['113001'], [0n, 300_000n]);
    const m = asMove(r);
    assert.equal(m.journalCode, 'RCPT');
    assert.equal(m.moveType, 'CUST_RECEIPT');
    assert.equal(m.sourceKey, receiptKey('r1', 'POST'));
    assert.equal(m.needsAttention, false);
    const ar = m.lines.find((l) => l.accountKey === 'AR_CONTROL')!;
    assert.equal(ar.customerId, 'cus1');
    assert.equal(ar.partnerName, 'بقالة النور');
  }
});

test('P5: التوجيه للعهدة بوجود مندوب ⇒ 111003 بالمندوب، وبلا مندوب ⇒ الطريقة المباشرة', () => {
  const ctx = saContext({ settings: { receiptRouting: { CASH: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'CUSTODY' } } });
  const cash = post(ctx, { paymentMethod: 'CASH' });
  const s = checked(cash, ctx);
  assert.deepEqual(s['111003'], [300_000n, 0n]);
  const custodyLine = asMove(cash).lines.find((l) => l.accountKey === 'REP_CUSTODY')!;
  assert.equal(custodyLine.salesRepId, 'rep1');
  assert.equal(custodyLine.partnerName, 'أحمد');

  assert.deepEqual(checked(post(ctx, { paymentMethod: 'BANK_TRANSFER' }), ctx)['112001'], [300_000n, 0n]);
  assert.deepEqual(checked(post(ctx, { paymentMethod: 'POS' }), ctx)['111003'], [300_000n, 0n]);
  assert.deepEqual(checked(post(ctx, { paymentMethod: 'CHEQUE' }), ctx)['112003'], [300_000n, 0n], 'غير مذكور ⇒ مباشر');
  assert.deepEqual(checked(post(ctx, { paymentMethod: 'CASH', salesRepId: null }), ctx)['111001'], [300_000n, 0n]);
});

test('P5: ONLINE بـpaylinkId ⇒ 112005 حتى مع توجيه العهدة؛ وبلا رابط ⇒ 911001 مع needsAttention', () => {
  const ctx = saContext({ settings: { receiptRouting: ALL_CUSTODY } });
  const linked = post(ctx, { paymentMethod: 'ONLINE', amount: '200', paylinkId: 'pl1' });
  const s = checked(linked, ctx);
  assert.deepEqual(s['112005'], [200_000n, 0n]);
  assert.equal(s['111003'], undefined);
  assert.equal(asMove(linked).needsAttention, false);

  const unlinked = post(ctx, { paymentMethod: 'ONLINE', amount: '200', paylinkId: null });
  const u = checked(unlinked, ctx);
  assert.deepEqual(u['911001'], [200_000n, 0n]);
  assert.equal(u['112005'], undefined);
  assert.equal(asMove(unlinked).needsAttention, true);
  assert.equal(asMove(unlinked).attentionReason, NO_LINK_ATTENTION);
});

test('P5: مبلغ صفري ⇒ NO_MOVE، ومنازل العملة الكويتية بالملّي', () => {
  assert.ok(isNoMove(post(saContext(), { amount: '0' })));
  const kw = saContext({ settings: { currency: 'KWD', currencyDecimals: 3 } });
  const s = checked(post(kw, { amount: '12.345' }), kw);
  assert.deepEqual(s['111001'], [12_345n, 0n]);
  assert.equal(asMove(post(kw, { amount: '1' })).currencyCode, 'KWD');
});

test('P6: عكس ONLINE بحمولة فيها refundEntryId ⇒ دائن 112005 بالقيمة المطلقة لـrefund.amount', () => {
  const ctx = saContext();
  const r = buildReceiptReversalMove({
    receiptId: 'r1', date: '2026-09-12', customerName: 'بقالة النور',
    original: base({ paymentMethod: 'ONLINE', amount: '200.00', paylinkId: 'pl1' }),
    reverse: { paylinkId: 'pl1', refundEntryId: 'se9', refundedAmount: '-200.00' },
  }, ctx);
  const s = checked(r, ctx);
  assert.deepEqual(s['113001'], [200_000n, 0n]);
  assert.deepEqual(s['112005'], [0n, 200_000n]);
  assert.equal(s['911001'], undefined);
  const m = asMove(r);
  assert.equal(m.needsAttention, false);
  assert.equal(m.sourceKey, receiptKey('r1', 'REVERSE'));
  assert.equal(m.sourceEvent, 'REVERSE');
});

test('P6: عكس ONLINE بلا REFUND (إلغاء يدوي) ⇒ دائن 911001 مع needsAttention ولا يمس 112005', () => {
  const ctx = saContext();
  const r = buildReceiptReversalMove({
    receiptId: 'r1', date: '2026-09-12', customerName: 'بقالة النور',
    original: base({ paymentMethod: 'ONLINE', amount: '200', paylinkId: 'pl1' }),
    reverse: { paylinkId: 'pl1', refundEntryId: null, refundedAmount: null },
  }, ctx);
  const s = checked(r, ctx);
  assert.deepEqual(s['911001'], [0n, 200_000n]);
  assert.equal(s['112005'], undefined);
  assert.equal(asMove(r).needsAttention, true);
  assert.equal(asMove(r).attentionReason, MANUAL_ONLINE_CANCEL_ATTENTION);
});

test('P6: استرداد بمبلغ مختلف (دفاعي) ⇒ الفرق إلى 911001 مع needsAttention', () => {
  const ctx = saContext();
  const r = buildReceiptReversalMove({
    receiptId: 'r1', date: '2026-09-12',
    original: base({ paymentMethod: 'ONLINE', amount: '200', paylinkId: 'pl1' }),
    reverse: { refundEntryId: 'se9', refundedAmount: '-150' },
  }, ctx);
  const s = checked(r, ctx);
  assert.deepEqual(s['112005'], [0n, 150_000n]);
  assert.deepEqual(s['911001'], [0n, 50_000n]);
  assert.equal(asMove(r).needsAttention, true);
});

test('P6: عكس ONLINE بلا رابط يصفّي 911001 بلا تنبيه جديد', () => {
  const ctx = saContext();
  const r = buildReceiptReversalMove({
    receiptId: 'r1', date: '2026-09-12', original: base({ paymentMethod: 'ONLINE', amount: '200', paylinkId: null }),
  }, ctx);
  const s = checked(r, ctx);
  assert.deepEqual(s['911001'], [0n, 200_000n]);
  assert.equal(asMove(r).needsAttention, false);
});

test('P6: إلغاء سند عهدة يعكس سطور القيد الأصلي حرفياً وإن تغيّر التوجيه لاحقاً', () => {
  const ctxThen = saContext({ settings: { receiptRouting: ALL_CUSTODY } });
  const orig = asMove(post(ctxThen, { paymentMethod: 'CASH' }));
  const ctxNow = saContext(); // التوجيه أُطفئ بعد الترحيل
  const r = buildReceiptReversalMove({
    receiptId: 'r1', date: '2026-09-12', customerName: 'بقالة النور', salesRepName: 'أحمد',
    original: base({ paymentMethod: 'CASH' }), originalLines: orig.lines,
  }, ctxNow);
  const s = checked(r, ctxNow);
  assert.deepEqual(s['111003'], [0n, 300_000n]);
  assert.deepEqual(s['113001'], [300_000n, 0n]);
  assert.equal(s['111001'], undefined);

  // بلا سطور أصلية: إعادة اشتقاق من الإعدادات الحالية
  const r2 = buildReceiptReversalMove({ receiptId: 'r1', date: '2026-09-12', original: base({ paymentMethod: 'POS' }) }, ctxNow);
  assert.deepEqual(checked(r2, ctxNow)['112004'], [0n, 300_000n]);
});

test('P5: الحلّ عبر الربط — المعرّفات من القالب', () => {
  const ctx = saContext();
  const m = asMove(post(ctx, { paymentMethod: 'ONLINE', paylinkId: 'pl1' }));
  assert.equal(resolveLineAccount(m.lines[0], ctx.accounts)!.id, accountIdOf('112005'));
});
