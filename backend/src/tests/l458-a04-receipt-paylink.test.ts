// «ربط الدفاتر» L5 — A4: سند القبض والدفع الإلكتروني في الدفاتر المربوطة (العقد §5.2، D3/D4، C2/C4/C8/C9/C10/C11، OD4/OD14).
// صرفة بلا قاعدة: جدول التوجيه (طريقة × مندوب × توجيه × مخصّص × بطاقة × مربوطة)، ومصدر الردّ عند الإلغاء، والاسترداد بعد
// الإلغاء اليدوي، والتوريد إلى البنك — مع أمثلة العقد المحلولة (E5.1–E5.9) وثابت ذهبي يثبت أن غير المربوطة كاليوم بايتاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  LINKED_METHOD_DEFAULTS, MANUAL_ONLINE_CANCEL_ATTENTION, NO_LINK_ATTENTION, buildReceiptMove, buildReceiptReversalMove,
  linkedMethodAccount, linkedReceiptCustodyClass, receiptReversalNeedsBuild,
  type AccountTarget, type ReceiptPostPayload, type ReceiptReversePayload,
} from '../services/gl/builders/receipt';
import {
  PAYLINK_CUSTOMER_CREDITS_CODE, buildPaylinkFeeMove, buildPaylinkRefundMove, buildPayoutMove, payoutDebitTarget, paylinkRefundKey,
} from '../services/gl/builders/paylink';
import { CARD_CLEARING_CODE, CUSTOMER_CREDITS_CODE, USER_CUSTODY_CODE, linkedAccountRefs } from '../services/gl/coa/linkedAccounts';
import { SA_6D_TEMPLATE } from '../services/gl/coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES } from '../services/gl/taxes/sa';
import { accountIdOf, taxIdOf, templateContextInput } from '../services/gl/testing/fixtures';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import {
  PAYMENT_METHOD_MAP_KEYS, createBuildContext, isNoMove,
  type AccountRef, type BuildContext, type BuildResult, type LineDraft, type MoveDraft, type ReceiptRouting,
} from '../services/gl/types';

// ═══ السياق ═══

/** حسابات إضافية: محفظة بنكية لطريقة مخصّصة (E5.3) وحساب مدى ثانٍ تحت التسوية */
const STC: AccountRef = { id: accountIdOf('111102'), code: '111102', name: 'محفظة STC Pay', type: 'asset_cash', isActive: true, reconcile: false, controlKind: null };
const MADA2: AccountRef = { id: accountIdOf('112008'), code: '112008', name: 'مدى البنك الثاني تحت التسوية', type: 'asset_current', isActive: true, reconcile: true, controlKind: null };

const ALL_CUSTODY: ReceiptRouting = { CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' };

interface CtxOpts { linked?: boolean; dec?: number; routing?: ReceiptRouting | null; maps?: Record<string, string> }

/** شجرة SA_6D + حسابات الربط الثلاثة (ensureLinkedAccounts) + الإضافيان؛ والخريطة رموزٌ تُحوَّل لمعرّفات */
function ctxOf(o: CtxOpts = {}): BuildContext {
  const input = templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, {
    settings: { currencyDecimals: o.dec ?? 2, receiptRouting: o.routing ?? null, ...(o.linked ? { linkedPosting: true as const } : {}) },
    extraAccounts: [...linkedAccountRefs(accountIdOf), STC, MADA2],
  });
  const maps = o.maps
    ? Object.fromEntries(Object.entries(o.maps).map(([k, code]) => [k, { accountId: accountIdOf(code), journalId: null }]))
    : undefined;
  return createBuildContext({ ...input, ...(maps ? { paymentMethodMaps: maps } : {}) });
}

const ARABIC = /[؀-ۿ]/;

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function asMove(r: BuildResult): MoveDraft {
  if (r.kind !== 'MOVE') assert.fail(`NO_MOVE غير متوقع: ${show(r)}`);
  return r as MoveDraft;
}

/** يتحقق بـvalidate.ts (SYSTEM) ويعيد {الرمز: [مدين، دائن]} — والتوازن والعربية واسم الشريك */
function sums(r: BuildResult, ctx: BuildContext): Record<string, [bigint, bigint]> {
  const move = asMove(r);
  const v = validateMove(move, ctx, { mode: 'SYSTEM' });
  assert.equal(v.totalDebitMilli, v.totalCreditMilli, 'القيد متّزن');
  assert.match(move.narration, ARABIC);
  const out: Record<string, [bigint, bigint]> = {};
  for (const l of move.lines) {
    assert.match(l.label, ARABIC, 'label عربي');
    if (l.customerId || l.vendorId || l.salesRepId || l.adminUserId) assert.ok(l.partnerName && l.partnerName.trim(), 'partnerName إلزامي');
    const acc = resolveLineAccount(l, ctx.accounts);
    assert.ok(acc, `حساب غير محلول: ${show(l)}`);
    const cur = out[acc.code] ?? [0n, 0n];
    out[acc.code] = [cur[0] + l.debitMilli, cur[1] + l.creditMilli];
  }
  return out;
}

const lineOn = (r: BuildResult, code: string, ctx: BuildContext): LineDraft => {
  const l = asMove(r).lines.find((x) => resolveLineAccount(x, ctx.accounts)?.code === code);
  assert.ok(l, `لا سطر على ${code}`);
  return l;
};

const payload = (p: Partial<ReceiptPostPayload>): ReceiptPostPayload => ({
  salesRepId: 'rep1', paymentMethod: 'CASH', amount: '500.00', customerId: 'cus1', ...p,
});

const post = (ctx: BuildContext, p: Partial<ReceiptPostPayload>) =>
  buildReceiptMove({ receiptId: 'r1', number: 'RC-1', date: '2026-11-10', payload: payload(p), customerName: 'بقالة النور', salesRepName: 'أحمد' }, ctx);

const reverse = (ctx: BuildContext, p: Partial<ReceiptPostPayload>, rev: ReceiptReversePayload | null, withLines = false) => {
  const original = payload(p);
  const originalLines = withLines ? asMove(post(ctx, p)).lines.filter((l) => !l.customerId) : null;
  return buildReceiptReversalMove({
    receiptId: 'r1', number: 'RC-1', date: '2026-11-12', original, reverse: rev, originalLines,
    customerName: 'بقالة النور', salesRepName: 'أحمد',
  }, ctx);
};

// ═══ الثابت الذهبي: غير المربوطة كاليوم بايتاً (مخرجات git HEAD قبل L5 على 2778 حالة) ═══

/** sha256 لـJSON مخرجات builders السند والدفع الإلكتروني في HEAD (468ddff+eea1e69) على المصفوفة أدناه بسياق saContext */
const GOLDEN_HEAD_SHA256 = 'ea4ffa0428852017f773d376a37936da28d81d50307627609d26df9a41023e03';
const GOLDEN_HEAD_COUNT = 2778;

/** المصفوفة نفسها التي ولّدت الثابت — بسياقٍ «مشوَّش» غير مربوط: خريطة طرق لكل مفتاح وحسابات الربط حاضرة، فلا يُقرأ منها شيء */
function goldenMatrix(ctxFor: (dec: number, routing: ReceiptRouting | null) => BuildContext): unknown[] {
  const out: unknown[] = [];
  const routings: (ReceiptRouting | null)[] = [null, ALL_CUSTODY, { CASH: 'CUSTODY', CHEQUE: 'DIRECT', POS: 'CUSTODY' }];
  const methods = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'ONLINE', 'WIRE'];
  const amounts: Record<number, string> = { 0: '1500', 2: '230.45', 3: '12.345' };
  for (const dec of [0, 2, 3]) {
    for (let ri = 0; ri < routings.length; ri++) {
      const ctx = ctxFor(dec, routings[ri]);
      for (const method of methods) {
        for (const rep of ['rep1', null]) {
          for (const extra of [{}, { paymentMethodKey: 'c_stcpay', cardPaymentId: 'cp1', allocations: [{ id: 'ri1', invoiceId: 'inv1', amount: '1.00' }] }]) {
            for (const paylinkId of method === 'ONLINE' ? ['lnk1', null] : [null]) {
              const p = { salesRepId: rep, paymentMethod: method, amount: amounts[dec], customerId: 'cus1', paylinkId, ...extra };
              const pst = buildReceiptMove({ receiptId: 'r1', number: 'RC-1', date: '2026-11-10', payload: p, customerName: 'بقالة النور', salesRepName: 'أحمد' }, ctx);
              out.push({ k: `POST d${dec} r${ri} ${method} ${rep} ${paylinkId} ${Object.keys(extra).length}`, v: pst });
              const reverses: (ReceiptReversePayload | null)[] = [
                null,
                { refundEntryId: 'se9', refundedAmount: `-${amounts[dec]}` },
                { cancelRefundFrom: 'MAIN_CASH' },
                { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u1', cancelRefundUserName: 'سالم' },
                { cancelRefundFrom: 'BANK' },
              ];
              for (let vi = 0; vi < reverses.length; vi++) {
                for (const withLines of [false, true]) {
                  const originalLines = withLines && pst.kind === 'MOVE' ? pst.lines.filter((l) => !l.customerId) : null;
                  const rev = buildReceiptReversalMove({
                    receiptId: 'r1', number: 'RC-1', date: '2026-11-12', original: p, reverse: reverses[vi], originalLines,
                    customerName: 'بقالة النور', salesRepName: 'أحمد',
                  }, ctx);
                  out.push({ k: `REV d${dec} r${ri} ${method} ${rep} ${paylinkId} ${Object.keys(extra).length} v${vi} l${withLines}`, v: rev });
                }
              }
            }
          }
        }
      }
      if (ri === 0) {
        out.push({ k: `PAYOUT d${dec}`, v: buildPayoutMove({ payoutId: 'po1', amount: `-${amounts[dec]}`, createdAt: '2026-11-10T09:00:00Z', bankReference: 'TRX-9' }, ctx) });
        out.push({ k: `FEE d${dec}`, v: buildPaylinkFeeMove({ entryId: 'f1', amount: '-5', feeNet: '4.35', feeVat: '0.65', createdAt: '2026-11-10T09:00:00Z', linkId: 'lnk1' }, ctx) });
      }
    }
  }
  return out;
}

const NOISY_MAPS = { CASH: '111102', BANK_TRANSFER: '111102', POS: '112008', CHEQUE: '111102', CARD: '112008', PAYOUT: '111102', c_stcpay: '111102' };

test('ذهبي: غير المربوطة (ولو حضرت خريطة الطرق وحسابات الربط ومصادر الردّ) = مخرجات HEAD بايتاً بايتاً', () => {
  const rows = goldenMatrix((dec, routing) => ctxOf({ linked: false, dec, routing, maps: NOISY_MAPS }));
  assert.equal(rows.length, GOLDEN_HEAD_COUNT);
  const json = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  assert.equal(crypto.createHash('sha256').update(json).digest('hex'), GOLDEN_HEAD_SHA256);
  // ومعه: سياقٌ بلا خريطة إطلاقاً (الشكل القديم) يعطي الشيء نفسه
  const plain = goldenMatrix((dec, routing) => ctxOf({ linked: false, dec, routing }));
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(plain, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).digest('hex'), GOLDEN_HEAD_SHA256);
});

// ═══ ثوابت العقد ═══

test('ثوابت: مفاتيح الخريطة = PAYMENT_METHOD_MAP_KEYS، ورمز 214002 في الدفع الإلكتروني = CUSTOMER_CREDITS_CODE، والمفتاح', () => {
  assert.deepEqual(Object.keys(LINKED_METHOD_DEFAULTS).sort(), [...PAYMENT_METHOD_MAP_KEYS].sort());
  assert.equal(PAYLINK_CUSTOMER_CREDITS_CODE, CUSTOMER_CREDITS_CODE);
  assert.deepEqual(LINKED_METHOD_DEFAULTS.CARD, { accountCode: CARD_CLEARING_CODE });
  assert.equal(paylinkRefundKey('se1'), 'PAYLINK_REFUND:se1');
});

// ═══ D3: خريطة الطرق ═══

const code = (t: AccountTarget | null, ctx: BuildContext): string | null => {
  if (!t) return null;
  const acc = 'accountId' in t ? ctx.accounts.byId(t.accountId) : 'accountCode' in t ? ctx.accounts.byCode(t.accountCode) : ctx.accounts.byKey(t.accountKey);
  return acc?.code ?? '??';
};

test('D3: الافتراضي بلا خريطة — النقد 111001، التحويل 111101 (OD14 لا 112001)، نقطة البيع 112004، الشيك 112003، البطاقة 112007، التوريد 111101', () => {
  const ctx = ctxOf({ linked: true });
  assert.equal(code(linkedMethodAccount({ method: 'CASH' }, ctx), ctx), '111001');
  assert.equal(code(linkedMethodAccount({ method: 'BANK_TRANSFER' }, ctx), ctx), '111101');
  assert.equal(code(linkedMethodAccount({ method: 'POS' }, ctx), ctx), '112004');
  assert.equal(code(linkedMethodAccount({ method: 'CHEQUE' }, ctx), ctx), '112003');
  assert.equal(code(linkedMethodAccount({ method: 'CARD' }, ctx), ctx), '112007');
  assert.equal(code(linkedMethodAccount({ method: 'POS', card: true }, ctx), ctx), '112007');
  assert.equal(code(linkedMethodAccount({ method: 'PAYOUT' }, ctx), ctx), '111101');
  // ONLINE غير قابل للربط، والمجهول null (911001 بتنبيه في السند)
  assert.equal(linkedMethodAccount({ method: 'ONLINE' }, ctx), null);
  assert.equal(linkedMethodAccount({ method: 'WIRE' }, ctx), null);
  assert.equal(linkedMethodAccount({ method: 'constructor' }, ctx), null, 'لا يُقرأ من سلسلة النموذج الأولي');
});

test('D3: المخصّص ثم الأساس ثم الافتراضي — وصفّ لحساب لا يُحلّ أو رقابي يُتخطّى، ومفتاح أساس في methodKey لا يقفز', () => {
  const ctx = ctxOf({ linked: true, maps: { c_stcpay: '111102', POS: '112008' } });
  assert.equal(code(linkedMethodAccount({ method: 'BANK_TRANSFER', methodKey: 'c_stcpay' }, ctx), ctx), '111102', 'صف المخصّص');
  assert.equal(code(linkedMethodAccount({ method: 'BANK_TRANSFER', methodKey: 'c_other1' }, ctx), ctx), '111101', 'مخصّص بلا صف ⇒ افتراضي الأساس');
  assert.equal(code(linkedMethodAccount({ method: 'POS', methodKey: 'c_other1' }, ctx), ctx), '112008', 'مخصّص بلا صف ⇒ صف الأساس');
  assert.equal(code(linkedMethodAccount({ method: 'POS' }, ctx), ctx), '112008');
  // صف المخصّص يعلو صف الأساس
  const both = ctxOf({ linked: true, maps: { c_mada2: '112008', POS: '112004' } });
  assert.equal(code(linkedMethodAccount({ method: 'POS', methodKey: 'c_mada2' }, both), both), '112008');
  // مفتاح أساس مخزَّن في paymentMethodKey (CARD/PAYOUT) لا يحوّل السند إلى صفّ ذلك الأساس
  const cardRow = ctxOf({ linked: true, maps: { CARD: '112008', PAYOUT: '111102' } });
  assert.equal(code(linkedMethodAccount({ method: 'CASH', methodKey: 'CARD' }, cardRow), cardRow), '111001');
  assert.equal(code(linkedMethodAccount({ method: 'CASH', methodKey: 'PAYOUT' }, cardRow), cardRow), '111001');
  assert.equal(code(linkedMethodAccount({ method: 'POS', card: true }, cardRow), cardRow), '112008', 'صف CARD');
  // صفّ تعلّق بحساب محذوف، أو صفّ لحساب رقابي (111003/112005/911001) ⇒ المستوى التالي
  const bad = createBuildContext({
    ...templateContextInput(SA_6D_TEMPLATE, SA_TAXES, {}, { settings: { linkedPosting: true }, extraAccounts: linkedAccountRefs(accountIdOf) }),
    paymentMethodMaps: {
      CASH: { accountId: 'acc_deleted', journalId: null },
      c_x1234: { accountId: accountIdOf('111003'), journalId: null },
      POS: { accountId: accountIdOf('112005'), journalId: null },
      CHEQUE: { accountId: accountIdOf('911001'), journalId: null },
    },
  });
  assert.equal(code(linkedMethodAccount({ method: 'CASH' }, bad), bad), '111001');
  assert.equal(code(linkedMethodAccount({ method: 'BANK_TRANSFER', methodKey: 'c_x1234' }, bad), bad), '111101');
  assert.equal(code(linkedMethodAccount({ method: 'POS' }, bad), bad), '112004');
  assert.equal(code(linkedMethodAccount({ method: 'CHEQUE' }, bad), bad), '112003');
});

// ═══ جدول التوجيه: P5 للمربوطة ═══

test('جدول التوجيه (مربوطة): طريقة × مندوب × توجيه × مخصّص × بطاقة × منازل 0/2/3 — كل قيد متّزن ودائنه 113001 بالعميل', () => {
  const routings: (ReceiptRouting | null)[] = [null, ALL_CUSTODY, { CASH: 'CUSTODY', CHEQUE: 'DIRECT' }];
  const amounts: Record<number, [string, bigint]> = { 0: ['1500', 1_500_000n], 2: ['230.45', 230_450n], 3: ['12.345', 12_345n] };
  let n = 0;
  for (const dec of [0, 2, 3]) {
    const [amt, milli] = amounts[dec];
    for (const routing of routings) {
      const ctx = ctxOf({ linked: true, dec, routing, maps: { c_stcpay: '111102' } });
      for (const method of ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'ONLINE', 'WIRE']) {
        for (const rep of ['rep1', null] as const) {
          for (const custom of [null, 'c_stcpay']) {
            for (const card of [null, 'cp1']) {
              for (const paylinkId of method === 'ONLINE' ? ['lnk1', null] : [null]) {
                const r = post(ctx, { paymentMethod: method, salesRepId: rep, amount: amt, paymentMethodKey: custom, cardPaymentId: card, paylinkId });
                const s = sums(r, ctx);
                assert.deepEqual(s['113001'], [0n, milli]);
                const m = asMove(r);
                const routedCustody = !!rep && !!routing && routing[method as 'CASH'] === 'CUSTODY';
                let expected: string;
                if (card) expected = '112007'; // C4: أبداً لا عهدة
                else if (method === 'ONLINE') expected = paylinkId ? '112005' : '911001';
                else if (method === 'WIRE') expected = '911001';
                else if (routedCustody && (method === 'CASH' || method === 'CHEQUE')) expected = '111003'; // D4
                else if (custom) expected = '111102';
                else expected = ({ CASH: '111001', BANK_TRANSFER: '111101', POS: '112004', CHEQUE: '112003' } as Record<string, string>)[method];
                assert.deepEqual(s[expected], [milli, 0n], `${dec} ${JSON.stringify(routing)} ${method} ${rep} ${custom} ${card} ${paylinkId}`);
                assert.equal(m.needsAttention, expected === '911001');
                assert.equal(s['112001'], undefined, 'OD14: لا 112001 في المربوطة');
                if (expected === '111003') assert.equal(lineOn(r, '111003', ctx).salesRepId, 'rep1');
                else for (const l of m.lines) assert.ok(!l.salesRepId, 'لا بُعد مندوب خارج العهدة');
                n++;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(n, 3 * 3 * (5 * 2 * 2 * 2 + 2 * 2 * 2 * 2));
});

test('أمثلة العقد E5.1–E5.5: نقدي بمندوب، تحويل، طريقة مخصّصة، بطاقة، نقطة بيع', () => {
  const ctx = ctxOf({ linked: true, routing: { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', POS: 'CUSTODY', BANK_TRANSFER: 'CUSTODY' }, maps: { c_stc: '111102' } });
  assert.deepEqual(sums(post(ctx, { paymentMethod: 'CASH', amount: '500' }), ctx), { '111003': [500_000n, 0n], '113001': [0n, 500_000n] }); // E5.1
  assert.deepEqual(sums(post(ctx, { paymentMethod: 'BANK_TRANSFER', amount: '500' }), ctx), { '111101': [500_000n, 0n], '113001': [0n, 500_000n] }); // E5.2 (+D4)
  assert.deepEqual(sums(post(ctx, { paymentMethod: 'BANK_TRANSFER', paymentMethodKey: 'c_stc', amount: '500' }), ctx), { '111102': [500_000n, 0n], '113001': [0n, 500_000n] }); // E5.3
  const card = post(ctx, { paymentMethod: 'POS', cardPaymentId: 'cp-9', amount: '230' });
  assert.deepEqual(sums(card, ctx), { '112007': [230_000n, 0n], '113001': [0n, 230_000n] }); // E5.4
  // E5.4: العكس بالمرآة (من سطور القيد الحيّ، ومن إعادة الاشتقاق)
  for (const withLines of [true, false]) {
    assert.deepEqual(sums(reverse(ctx, { paymentMethod: 'POS', cardPaymentId: 'cp-9', amount: '230' }, null, withLines), ctx), { '113001': [230_000n, 0n], '112007': [0n, 230_000n] });
  }
  assert.deepEqual(sums(post(ctx, { paymentMethod: 'POS', amount: '300' }), ctx), { '112004': [300_000n, 0n], '113001': [0n, 300_000n] }); // E5.5 (+D4)
  // E5.6 (ساق السند): شيك بمندوب إلى العهدة
  assert.deepEqual(sums(post(ctx, { paymentMethod: 'CHEQUE', amount: '700' }), ctx), { '111003': [700_000n, 0n], '113001': [0n, 700_000n] });
});

test('D4/C4: تصنيف العهدة للمربوطة — النقد والشيك وحدهما، والبطاقة خارجها؛ وغير المربوطة receiptCustodyClass كما هي', () => {
  const linked = ctxOf({ linked: true, routing: ALL_CUSTODY });
  const legacy = ctxOf({ linked: false, routing: ALL_CUSTODY });
  for (const [method, cls] of [['CASH', 'CUSTODY'], ['CHEQUE', 'CUSTODY'], ['BANK_TRANSFER', 'OUTSIDE'], ['POS', 'OUTSIDE'], ['ONLINE', 'ONLINE']] as const) {
    assert.equal(linkedReceiptCustodyClass({ paymentMethod: method, salesRepId: 'rep1' }, linked), cls, method);
    assert.equal(linkedReceiptCustodyClass({ paymentMethod: method, salesRepId: 'rep1' }, legacy), method === 'ONLINE' ? 'ONLINE' : 'CUSTODY');
  }
  assert.equal(linkedReceiptCustodyClass({ paymentMethod: 'CASH', salesRepId: 'rep1', cardPaymentId: 'cp1' }, linked), 'OUTSIDE');
  assert.equal(linkedReceiptCustodyClass({ paymentMethod: 'CASH', salesRepId: null }, linked), 'OUTSIDE');
});

// ═══ C11: مصدر الردّ عند الإلغاء ═══

test('E5.7: إلغاء بعد التسليم لكل مصدر — الصندوق 111001، المستخدم 111004 بلا مندوب، البنك 111101 أو صفّه، والمندوب والطريقة مرآة', () => {
  const ctx = ctxOf({ linked: true, routing: { CASH: 'CUSTODY' } });
  const p = { paymentMethod: 'CASH', amount: '500' };
  // السند: Dr 111003 [R] / Cr 113001
  assert.deepEqual(sums(post(ctx, p), ctx), { '111003': [500_000n, 0n], '113001': [0n, 500_000n] });
  for (const withLines of [false, true]) {
    const cash = reverse(ctx, p, { cancelRefundFrom: 'MAIN_CASH' }, withLines);
    assert.deepEqual(sums(cash, ctx), { '113001': [500_000n, 0n], '111001': [0n, 500_000n] }, 'MAIN_CASH: 111003 لا يُسلب');
    assert.equal(asMove(cash).needsAttention, false);

    const user = reverse(ctx, p, { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u1', cancelRefundUserName: 'سالم' }, withLines);
    assert.deepEqual(sums(user, ctx), { '113001': [500_000n, 0n], [USER_CUSTODY_CODE]: [0n, 500_000n] });
    const ul = lineOn(user, USER_CUSTODY_CODE, ctx);
    assert.equal(ul.adminUserId, 'u1');
    assert.equal(ul.salesRepId ?? null, null, 'D2: سطر 111004 بلا salesRepId');
    assert.equal(ul.partnerName, 'سالم');

    assert.deepEqual(sums(reverse(ctx, p, { cancelRefundFrom: 'BANK' }, withLines), ctx), { '113001': [500_000n, 0n], '111101': [0n, 500_000n] });

    // REP_CUSTODY وMETHOD وnull: مرآة الأصل (111003)
    for (const rev of [{ cancelRefundFrom: 'REP_CUSTODY' as const }, { cancelRefundFrom: 'METHOD' as const }, null]) {
      const r = reverse(ctx, p, rev, withLines);
      assert.deepEqual(sums(r, ctx), { '113001': [500_000n, 0n], '111003': [0n, 500_000n] });
      assert.equal(lineOn(r, '111003', ctx).salesRepId, 'rep1');
    }
  }
  // البنك بصفّ BANK_TRANSFER في الخريطة
  const mapped = ctxOf({ linked: true, routing: { CASH: 'CUSTODY' }, maps: { BANK_TRANSFER: '111102' } });
  assert.deepEqual(sums(reverse(mapped, p, { cancelRefundFrom: 'BANK' }), mapped), { '113001': [500_000n, 0n], '111102': [0n, 500_000n] });
  // دفاعي: USER_CUSTODY بلا مستخدم ⇒ معلّق بتنبيه لا سطر عهدة بلا بُعد
  const orphan = reverse(ctx, p, { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: '  ' });
  assert.deepEqual(sums(orphan, ctx), { '113001': [500_000n, 0n], '911001': [0n, 500_000n] });
  assert.equal(asMove(orphan).needsAttention, true);
});

test('C11: مصدر الردّ لا يمسّ السند الإلكتروني، وغير المربوطة تتجاهله (مرآة كاليوم)', () => {
  const linked = ctxOf({ linked: true });
  // سند إلكتروني برابط أُلغي يدوياً مع مصدر ردّ ⇒ ما زال 214002 (C9) لا الصندوق
  const online = reverse(linked, { paymentMethod: 'ONLINE', paylinkId: 'lnk1', salesRepId: null }, { cancelRefundFrom: 'MAIN_CASH' });
  assert.deepEqual(sums(online, linked), { '113001': [500_000n, 0n], [CUSTOMER_CREDITS_CODE]: [0n, 500_000n] });
  // إلكتروني بلا رابط (911001 أصلاً) مع مصدر ردّ ⇒ عكس المعلّق كاليوم
  const noLink = reverse(linked, { paymentMethod: 'ONLINE', paylinkId: null, salesRepId: null }, { cancelRefundFrom: 'MAIN_CASH' });
  assert.deepEqual(sums(noLink, linked), { '113001': [500_000n, 0n], '911001': [0n, 500_000n] });
  const legacy = ctxOf({ linked: false, routing: { CASH: 'CUSTODY' } });
  assert.deepEqual(sums(reverse(legacy, { paymentMethod: 'CASH' }, { cancelRefundFrom: 'MAIN_CASH' }), legacy), { '113001': [500_000n, 0n], '111003': [0n, 500_000n] });
});

test('receiptReversalNeedsBuild: الإلكتروني برابط دائماً، والمربوطة لمصادر المستخدم والصندوق والبنك وحدها', () => {
  const linked = ctxOf({ linked: true });
  const legacy = ctxOf({ linked: false });
  const cash = payload({ paymentMethod: 'CASH' });
  const online = payload({ paymentMethod: 'ONLINE', paylinkId: 'lnk1' });
  for (const ctx of [linked, legacy]) {
    assert.equal(receiptReversalNeedsBuild(online, null, ctx), true);
    assert.equal(receiptReversalNeedsBuild(online, { refundEntryId: 'se1' }, ctx), true);
  }
  for (const from of ['USER_CUSTODY', 'MAIN_CASH', 'BANK'] as const) {
    assert.equal(receiptReversalNeedsBuild(cash, { cancelRefundFrom: from }, linked), true, from);
    assert.equal(receiptReversalNeedsBuild(cash, { cancelRefundFrom: from }, legacy), false, `${from} legacy`);
    assert.equal(receiptReversalNeedsBuild(payload({ paymentMethod: 'ONLINE', paylinkId: null }), { cancelRefundFrom: from }, linked), false);
  }
  for (const rev of [null, undefined, {}, { cancelRefundFrom: 'REP_CUSTODY' as const }, { cancelRefundFrom: 'METHOD' as const }, { cancelRefundFrom: null }]) {
    assert.equal(receiptReversalNeedsBuild(cash, rev, linked), false, JSON.stringify(rev));
  }
});

// ═══ C9: الإلغاء اليدوي للسند الإلكتروني ثم الاسترداد ═══

/** دفتر أستاذ مصغّر: Σ (مدين − دائن) لكل رمز */
function ledger(ctx: BuildContext, ...moves: BuildResult[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const r of moves) {
    if (isNoMove(r)) continue;
    for (const [c, [d, cr]] of Object.entries(sums(r, ctx))) out[c] = (out[c] ?? 0n) + d - cr;
  }
  return out;
}

test('E5.8: الإلغاء اليدوي ⇒ 214002 بلا تنبيه، ثم الاسترداد Dr 214002 / Cr 112005 — والمسار العادي NETTED؛ الحسابات تُصفَّر', () => {
  for (const [dec, amt, milli] of [[0, '1000', 1_000_000n], [2, '1000.00', 1_000_000n], [3, '1000.125', 1_000_125n]] as const) {
    const ctx = ctxOf({ linked: true, dec });
    const p = { paymentMethod: 'ONLINE', paylinkId: 'lnk1', salesRepId: null, amount: amt };
    const rcpt = post(ctx, p);
    assert.deepEqual(sums(rcpt, ctx), { '112005': [milli, 0n], '113001': [0n, milli] });

    // الإلغاء اليدوي (لا refundEntryId)
    const manual = reverse(ctx, p, { paylinkId: 'lnk1' });
    assert.deepEqual(sums(manual, ctx), { '113001': [milli, 0n], [CUSTOMER_CREDITS_CODE]: [0n, milli] });
    assert.equal(asMove(manual).needsAttention, false);
    assert.equal(asMove(manual).attentionReason, null);
    assert.equal(lineOn(manual, CUSTOMER_CREDITS_CODE, ctx).customerId, 'cus1');

    // الاسترداد لاحقاً: العكس المرحَّل بلا refundEntryId
    const refund = buildPaylinkRefundMove({
      payload: { entryId: 'se1', linkId: 'lnk1', receiptId: 'r1', amount: `-${amt}`, createdAt: '2026-11-13T10:00:00Z', customerId: 'cus1', customerName: 'بقالة النور' },
      receiptReverseRefundEntryId: null, date: '2026-11-13',
    }, ctx);
    const m = asMove(refund);
    assert.equal(m.moveType, 'CUSTOMER_REFUND');
    assert.equal(m.journalCode, 'PLNK');
    assert.equal(m.journalSystemKey, 'PAYLINK');
    assert.equal(m.origin, 'AUTO');
    assert.equal(m.sourceType, 'PAYLINK_REFUND');
    assert.equal(m.sourceKey, 'PAYLINK_REFUND:se1');
    assert.equal(m.sourceEvent, 'POST');
    assert.equal(m.date, '2026-11-13');
    assert.equal(m.needsAttention, false);
    assert.deepEqual(sums(refund, ctx), { [CUSTOMER_CREDITS_CODE]: [milli, 0n], '112005': [0n, milli] });
    assert.equal(lineOn(refund, CUSTOMER_CREDITS_CODE, ctx).customerId, 'cus1');
    // السند ثم الإلغاء ثم الاسترداد: 112005 و214002 و113001 صفر
    assert.deepEqual(ledger(ctx, rcpt, manual, refund), { '112005': 0n, '113001': 0n, [CUSTOMER_CREDITS_CODE]: 0n });

    // المسار العادي: الاسترداد يلغي السند في المعاملة نفسها ⇒ العكس يدين 112005، والحدث NETTED
    const normal = reverse(ctx, p, { paylinkId: 'lnk1', refundEntryId: 'se2', refundedAmount: `-${amt}` });
    assert.deepEqual(sums(normal, ctx), { '113001': [milli, 0n], '112005': [0n, milli] });
    const netted = buildPaylinkRefundMove({
      payload: { entryId: 'se2', linkId: 'lnk1', receiptId: 'r1', amount: `-${amt}`, createdAt: '2026-11-13T10:00:00Z' },
      receiptReverseRefundEntryId: 'se2', date: '2026-11-13',
    }, ctx);
    assert.deepEqual(netted, { kind: 'NO_MOVE', reason: 'NETTED', note: 'عكس السند صفّى أمانات الدفع الإلكتروني بهذا الاسترداد' });
    assert.deepEqual(ledger(ctx, rcpt, normal, netted), { '112005': 0n, '113001': 0n });
  }
});

test('C9: غير المربوطة يبقى إلغاؤها اليدوي على 911001 بتنبيه كاليوم؛ والاسترداد صفري ZERO_VALUE، والموجب كالسالب، وبلا عميل بلا شريك', () => {
  const legacy = ctxOf({ linked: false });
  const manual = reverse(legacy, { paymentMethod: 'ONLINE', paylinkId: 'lnk1', salesRepId: null }, null);
  assert.deepEqual(sums(manual, legacy), { '113001': [500_000n, 0n], '911001': [0n, 500_000n] });
  assert.equal(asMove(manual).attentionReason, MANUAL_ONLINE_CANCEL_ATTENTION);
  assert.equal(asMove(post(legacy, { paymentMethod: 'ONLINE', paylinkId: null })).attentionReason, NO_LINK_ATTENTION);

  const ctx = ctxOf({ linked: true });
  const base = { entryId: 'se3', linkId: null, receiptId: null, createdAt: '2026-11-13T10:00:00Z' };
  assert.deepEqual(buildPaylinkRefundMove({ payload: { ...base, amount: '0' }, receiptReverseRefundEntryId: null, date: '2026-11-13' }, ctx), { kind: 'NO_MOVE', reason: 'ZERO_VALUE', note: 'استرداد صفري' });
  const pos = buildPaylinkRefundMove({ payload: { ...base, amount: '75.5' }, receiptReverseRefundEntryId: 'other', date: '2026-11-13' }, ctx);
  assert.deepEqual(sums(pos, ctx), { [CUSTOMER_CREDITS_CODE]: [75_500n, 0n], '112005': [0n, 75_500n] });
  assert.equal(lineOn(pos, CUSTOMER_CREDITS_CODE, ctx).customerId, undefined);
  assert.equal(asMove(pos).customerId, null);
});

// ═══ C8: توريد الأمانات ═══

test('E5.9: التوريد الأسبوعي للمربوطة Dr 111101 / Cr 112005 (لا 112001)، وبصفّ PAYOUT حسابُه؛ وغير المربوطة 112001 كاليوم', () => {
  const p = { payoutId: 'po1', amount: '-950', createdAt: '2026-11-13T09:00:00Z', bankReference: 'TRX-1' };
  const linked = ctxOf({ linked: true });
  const m = buildPayoutMove(p, linked);
  assert.deepEqual(sums(m, linked), { '111101': [950_000n, 0n], '112005': [0n, 950_000n] });
  assert.equal(asMove(m).moveType, 'PAYLINK_PAYOUT');
  const mapped = ctxOf({ linked: true, maps: { PAYOUT: '111102' } });
  assert.deepEqual(sums(buildPayoutMove(p, mapped), mapped), { '111102': [950_000n, 0n], '112005': [0n, 950_000n] });
  const legacy = ctxOf({ linked: false, maps: { PAYOUT: '111102' } });
  assert.deepEqual(sums(buildPayoutMove(p, legacy), legacy), { '112001': [950_000n, 0n], '112005': [0n, 950_000n] });
});

test('payoutDebitTarget ≡ linkedMethodAccount({method:"PAYOUT"}) — المنطق المكرَّر في paylink.ts لا ينحرف', () => {
  const scenarios: CtxOpts[] = [
    { linked: true }, { linked: true, maps: { PAYOUT: '111102' } }, { linked: true, maps: { PAYOUT: '112008' } },
    { linked: true, maps: { CASH: '111102' } },
  ];
  for (const o of scenarios) {
    const ctx = ctxOf(o);
    const a = payoutDebitTarget(ctx);
    assert.equal(code(a as AccountTarget, ctx), code(linkedMethodAccount({ method: 'PAYOUT' }, ctx), ctx), JSON.stringify(o));
  }
  // صفّ PAYOUT لحساب رقابي أو محذوف ⇒ البنك الرئيسي في الاثنين
  const bad = createBuildContext({
    ...templateContextInput(SA_6D_TEMPLATE, SA_TAXES, {}, { settings: { linkedPosting: true }, extraAccounts: linkedAccountRefs(accountIdOf) }),
    paymentMethodMaps: { PAYOUT: { accountId: accountIdOf('112005'), journalId: null } },
  });
  assert.deepEqual(payoutDebitTarget(bad), { accountKey: 'MAIN_BANK' });
  assert.deepEqual(linkedMethodAccount({ method: 'PAYOUT' }, bad), { accountKey: 'MAIN_BANK' });
  assert.deepEqual(payoutDebitTarget(ctxOf({ linked: false })), { accountKey: 'PAYLINK_PAYOUT_ACCOUNT' });
});

// ═══ حراس ثابتة ═══

test('حارس: builders السند والدفع الإلكتروني والتسوية صرفة — لا prisma ولا I/O، وpaylink.ts لا يستورد إلا types/money/dates', () => {
  const dir = path.join(__dirname, '../services/gl/builders');
  for (const f of ['receipt.ts', 'paylink.ts', 'clearing.ts']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) assert.doesNotMatch(s, /prisma|config\/database|express|node:/, `${f}: ${s}`);
    assert.doesNotMatch(src, /require\(|\$queryRaw|\$executeRaw|glSourceEvent/, f);
  }
  const paylinkSrc = fs.readFileSync(path.join(dir, 'paylink.ts'), 'utf8');
  for (const m of paylinkSrc.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.match(m[1], /^\.\.\/(types|money|dates)$/);
});
