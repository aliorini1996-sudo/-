// «ربط الدفاتر» L4+L5 (A1، العقد §3.2 وD1): حمولة الاشتقاق — صرفة بلا قاعدة.
// 1) ذهبي: غير المربوطة (والقديمة) حمولتها **بايتاً** كما كانت قبل التعديل، ومعها REFUND بلا حدث ولا USER_SETTLEMENT.
// 2) المربوطة: كل حقل جديد حاضر بقيمه، ولا يُكتب إلا حين يحمل قيمة، والمبالغ نصوص بنصف-لأعلى لكل مستند بمنازل 0 و2 و3.
// 3) أمثلة العقد المحلولة التي تمسّ الحمولة: E4.1 وE4.2 وE4.4 وE5.3 وE5.4 وE5.7 وE5.8 وE5.10 وE5.11.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveAccountEntryEvents, deriveRepSettlementEvents, deriveSettlementEntryEvents, deriveSourceEvents, deriveUserSettlementEvents,
  factIdsForRows, invoicePostEventPayload, paylinkRefundPayload, receiptPostEventPayload, receiptReverseEventPayload,
  reconciledSourceEnabled, settlementPayload, userSettlementPayload, RECONCILED_SOURCES,
  type AccountEntrySourceRow, type DeriveContext, type InvoiceFacts, type ReceiptFacts, type RepSettlementSourceRow,
  type SettlementEntrySourceRow, type UserSettlementSourceRow,
} from '../services/gl/sync/desired';
import { decodeEventNote } from '../services/gl/sync/classify';
import { toMilli } from '../services/gl/money';
import type { DesiredEvent } from '../services/gl/sync/types';
import {
  ACCOUNT_ENTRY_ROWS, GOLDEN_DECIMALS, GOLDEN_SOURCES, INVOICES, RECEIPTS, REP_SETTLEMENT_ROWS, SETTLEMENT_ENTRY_ROWS,
  USER_SETTLEMENT_ROWS, at, deriveCtx, rowsOf, serializeEvents,
} from './l458-a1-fixtures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const GOLDEN: Record<string, unknown> = JSON.parse(readFileSync(join(__dirname, 'l458-a1-golden.json'), 'utf8'));
const linkedCtx = (dec = 2, extra: Record<string, unknown> = {}): DeriveContext => deriveCtx(dec, { linked: true, ...extra });
const byKey = (evs: readonly DesiredEvent[]) => new Map(evs.map((e) => [e.sourceKey, e]));
const payloadOf = (evs: readonly DesiredEvent[], key: string): Any => {
  const e = byKey(evs).get(key);
  assert.ok(e, `حدث مفقود ${key}`);
  return e.payload as Any;
};
const inv = (id: string): InvoiceFacts => INVOICES.find((i) => i.id === id) as InvoiceFacts;
const rec = (id: string): ReceiptFacts => RECEIPTS.find((r) => r.id === id) as ReceiptFacts;

// ═══ 1. الذهبي: غير المربوطة حرفاً كما كانت ═══

test('ذهبي: غير المربوطة (الغائب وlinked=false) ⇒ الأحداث والحمولات بايتاً كما قبل التعديل لكل مصدر ومنازل 0/2/3', () => {
  for (const dec of GOLDEN_DECIMALS) {
    for (const source of GOLDEN_SOURCES) {
      const want = JSON.stringify(GOLDEN[`${source}:${dec}`]);
      for (const extra of [{}, { linked: false }]) {
        // الحقائق تحمل الحقول الجديدة كلها (الختم والأقساط والتخصيصات…) والسياق يحمل الأسماء والروابط — كلها تُتجاهل
        const got = JSON.stringify(serializeEvents(deriveSourceEvents(source, rowsOf(source) as Any, deriveCtx(dec, extra)) as Any));
        assert.equal(got, want, `${source} dec=${dec} ${JSON.stringify(extra)}`);
      }
    }
  }
});

test('ذهبي: REFUND بلا حدث، وUSER_SETTLEMENT بلا حدث، وsettlementPayload بلا extra أو بـlinked=false كما كان', () => {
  for (const dec of GOLDEN_DECIMALS) {
    const ctx = deriveCtx(dec);
    assert.deepEqual(deriveSettlementEntryEvents(SETTLEMENT_ENTRY_ROWS.filter((r) => r.kind === 'REFUND' || r.kind === 'COLLECTED') as Any, ctx), []);
    assert.deepEqual(deriveUserSettlementEvents(USER_SETTLEMENT_ROWS as Any, ctx), []);
    assert.deepEqual(deriveSourceEvents('USER_SETTLEMENT', USER_SETTLEMENT_ROWS as Any, deriveCtx(dec, { linked: false })), []);
    const want = JSON.stringify(GOLDEN[`settlementPayload:${dec}`]);
    for (const extra of [undefined, { linked: false, receivedByName: 'سارة' }, { receivedByName: 'سارة' }]) {
      const got = JSON.stringify(REP_SETTLEMENT_ROWS.map((r) => settlementPayload(r as RepSettlementSourceRow, 'أحمد', dec, extra)));
      assert.equal(got, want, JSON.stringify(extra));
    }
  }
});

test('ذهبي: factIdsForRows يعيد المفاتيح القديمة كما كانت (والجديدة linkIds/userIds إضافة)', () => {
  for (const source of GOLDEN_SOURCES) {
    const got = factIdsForRows(source, rowsOf(source) as Any) as Any;
    const old = GOLDEN[`facts:${source}`] as Record<string, unknown>;
    for (const k of Object.keys(old)) assert.deepEqual(got[k], old[k], `${source}.${k}`);
  }
  assert.deepEqual(factIdsForRows('SETTLEMENT_ENTRY', SETTLEMENT_ENTRY_ROWS as Any).linkIds, ['L1', 'L9']);
  assert.deepEqual(factIdsForRows('REP_SETTLEMENT', REP_SETTLEMENT_ROWS as Any).userIds, ['u1', 'u2']);
  assert.deepEqual(factIdsForRows('USER_SETTLEMENT', USER_SETTLEMENT_ROWS as Any).userIds, ['u1', 'u2']);
  assert.deepEqual(factIdsForRows('USER_SETTLEMENT', USER_SETTLEMENT_ROWS as Any).invoiceIds, []);
});

test('المربوطة لا تمسّ حقلاً قائماً: كل مفتاح في حمولة اليوم بقيمته نفسها (إلا الاستحقاق المشتق والبنود الموسّعة)', () => {
  for (const dec of GOLDEN_DECIMALS) {
    for (const source of GOLDEN_SOURCES) {
      const old = byKey(deriveSourceEvents(source, rowsOf(source) as Any, deriveCtx(dec)));
      const now = deriveSourceEvents(source, rowsOf(source) as Any, linkedCtx(dec));
      for (const e of now) {
        const o = old.get(e.sourceKey);
        if (!o) { assert.equal(e.sourceType, 'PAYLINK_REFUND', `حدث جديد غير متوقع ${e.sourceKey}`); continue; }
        assert.equal(e.effectAt.getTime(), o.effectAt.getTime());
        assert.equal(e.status, o.status);
        const p = e.payload as Any;
        for (const [k, v] of Object.entries(o.payload as Any)) {
          if (k === 'items') {
            (v as Any[]).forEach((it, i) => { for (const [ik, iv] of Object.entries(it)) assert.deepEqual(p.items[i][ik], iv, `${e.sourceKey}.items[${i}].${ik}`); });
          } else if (k === 'dueDate' && p.dueDateDerived === true) {
            assert.equal(v, null, 'الاشتقاق لا يغطّي استحقاقاً قائماً');
          } else {
            assert.deepEqual(p[k], v, `${e.sourceKey}.${k}`);
          }
        }
        assert.doesNotThrow(() => JSON.stringify(e.payload)); // لا BigInt في الحمولة
      }
    }
  }
});

// ═══ 2. الفاتورة (L4) ═══

test('E4.1 آجلة بقسطين: الأقساط بالترتيب وباستحقاقها المحلي ومبلغها النصي، وbaseQty=240 وproductName — والاستحقاق الصريح كما هو', () => {
  const p = payloadOf(deriveAccountEntryEvents(ACCOUNT_ENTRY_ROWS as Any, linkedCtx()), 'INVOICE:cr1:POST');
  assert.deepEqual(p.installments, [
    { seq: 1, dueDate: '2026-12-14', amount: '575.00' },
    { seq: 2, dueDate: '2027-01-13', amount: '575.00' },
  ]);
  const sum = p.installments.reduce((s: bigint, i: Any) => s + toMilli(i.amount, 2), 0n);
  assert.equal(sum, toMilli(p.total, 2), 'Σ الأقساط = الإجمالي');
  assert.equal(p.dueDate, '2027-01-13'); // Invoice.dueDate الصريح (+60 يوماً) لا يُشتق
  assert.equal(p.dueDateDerived, undefined);
  assert.deepEqual(p.items[0], {
    productId: 'p1', categoryId: 'cat1', qty: 10, unitPrice: 100, taxPct: 15, taxAmt: '150.00', lineTotal: '1150.00', vatCategory: 'S',
    baseQty: 240, productName: 'كرتون ماء',
  });
  assert.equal(p.cashCollectedByRep, undefined, 'الختم لا يُكتب false');
  assert.equal(p.appliesTo, undefined);
});

test('E4.2 نقدية مختومة ⇒ cashCollectedByRep:true، وغير المختومة بلا المفتاح؛ والبند بلا اسم بلا productName وbaseQty = qty × المعامل', () => {
  const evs = deriveAccountEntryEvents(ACCOUNT_ENTRY_ROWS as Any, linkedCtx());
  const cash = payloadOf(evs, 'INVOICE:cash1:POST');
  assert.equal(cash.cashCollectedByRep, true);
  assert.equal(cash.items[0].baseQty, 1);
  assert.ok(!('productName' in cash.items[0]));
  // غير مختومة (cash2 لا POST في الصفوف، فنبنيها مباشرة)
  const plain = invoicePostEventPayload(inv('cash2'), '2026-11-14', linkedCtx(), null) as Any;
  assert.ok(!('cashCollectedByRep' in plain));
  // نقدية بلا أقساط ولا استحقاق: لا اشتقاق (D9 للآجلة وحدها)
  assert.equal(cash.dueDate, null);
  assert.ok(!('dueDateDerived' in cash));
});

test('E4.4 آجلة بلا استحقاق ولا أقساط ⇒ يوم الفاتورة + paymentDays مع dueDateDerived (وpaymentDays=0 ⇒ يومها)، والكسري بلا غبار', () => {
  const evs = deriveAccountEntryEvents(ACCOUNT_ENTRY_ROWS as Any, linkedCtx());
  const p = payloadOf(evs, 'INVOICE:cr2:POST');
  assert.equal(p.entryDate, '2026-11-13'); // صف الدفتر بتاريخ أمس
  assert.equal(p.dueDate, '2026-12-14'); // أساسه Invoice.invoiceDate (2026-11-14) + 30
  assert.equal(p.dueDateDerived, true);
  assert.equal(p.items[0].baseQty, 15); // 2.5 × 6
  const dn = payloadOf(evs, 'INVOICE:dn1:POST');
  assert.equal(dn.dueDate, '2026-11-14');
  assert.equal(dn.dueDateDerived, true);
  assert.equal(dn.appliesTo, undefined, 'الإشعار المدين لا يُسقط من أصله');
  // بلا invoiceDate ⇒ entryDate أساساً؛ وبلا paymentDays (حقائق ناقصة) ⇒ لا اشتقاق
  const noDate = invoicePostEventPayload({ ...inv('cr2'), invoiceDate: undefined }, '2026-11-20', linkedCtx(), null) as Any;
  assert.equal(noDate.dueDate, '2026-12-20');
  const noDays = invoicePostEventPayload({ ...inv('cr2'), customerPaymentDays: null }, '2026-11-20', linkedCtx(), null) as Any;
  assert.equal(noDays.dueDate, null);
  assert.ok(!('dueDateDerived' in noDays));
  // أقساط بلا استحقاق صريح ⇒ لا اشتقاق (الأقساط تحمل استحقاقاتها)
  const inst = invoicePostEventPayload({ ...inv('cr1'), dueDate: null }, '2026-11-14', linkedCtx(), null) as Any;
  assert.equal(inst.dueDate, null);
  assert.ok(!('dueDateDerived' in inst));
});

test('appliesTo: مرتجع مرتبط ⇒ {فاتورة البيع، المُسقَط}، وإشعار دائن ⇒ {الأصل، null}، والحرّ والصفري بلا المفتاح', () => {
  const evs = deriveAccountEntryEvents(ACCOUNT_ENTRY_ROWS as Any, linkedCtx());
  assert.deepEqual(payloadOf(evs, 'INVOICE:ret1:POST').appliesTo, { invoiceId: 'cr1', amount: '115.00' });
  assert.deepEqual(payloadOf(evs, 'INVOICE:cn1:POST').appliesTo, { invoiceId: 'cr3', amount: null });
  const free = invoicePostEventPayload({ ...inv('ret1'), remainingApplied: null, saleInvoiceId: null }, '2026-11-14', linkedCtx(), null) as Any;
  assert.ok(!('appliesTo' in free));
  const dust = invoicePostEventPayload({ ...inv('ret1'), remainingApplied: 0.004 }, '2026-11-14', linkedCtx(), null) as Any;
  assert.ok(!('appliesTo' in dust), 'ما يقرّب إلى صفر بمنازل العملة لا أثر له');
  const noSale = invoicePostEventPayload({ ...inv('ret1'), saleInvoiceId: null }, '2026-11-14', linkedCtx(), null) as Any;
  assert.ok(!('appliesTo' in noSale));
  // ثلاث منازل: نصف-لأعلى لكل مستند
  const bhd = invoicePostEventPayload({ ...inv('ret1'), remainingApplied: 0.0995 }, '2026-11-14', linkedCtx(3), null) as Any;
  assert.deepEqual(bhd.appliesTo, { invoiceId: 'cr1', amount: '0.100' });
});

test('منازل 0 و3: الأقساط والمبالغ بنصف-لأعلى لكل قسط، والاستحقاق بتوقيت الشركة', () => {
  const f: InvoiceFacts = {
    ...inv('cr1'), subtotal: 0.999, taxAmt: 0.1, total: 1.099,
    installments: [{ seq: 1, dueDate: new Date('2026-12-31T20:59:59.000Z'), amount: 0.5495 }, { seq: 2, dueDate: new Date('2026-12-31T21:00:00.000Z'), amount: 0.5495 }],
  };
  const p = invoicePostEventPayload(f, '2026-11-14', linkedCtx(3), 'x') as Any;
  assert.deepEqual(p.installments, [
    { seq: 1, dueDate: '2026-12-31', amount: '0.550' },
    { seq: 2, dueDate: '2027-01-01', amount: '0.550' },
  ]);
  assert.equal(p.total, '1.099');
  assert.equal(p.sourceCreatedAt, 'x');
  const iqd = invoicePostEventPayload({ ...f, total: 3000, installments: [{ seq: 1, dueDate: at(0), amount: 1500.5 }, { seq: 2, dueDate: at(1), amount: 1499.5 }] }, '2026-11-14', linkedCtx(0), null) as Any;
  assert.deepEqual(iqd.installments.map((i: Any) => i.amount), ['1501', '1500']);
});

test('حقائق ناقصة (مُطابِق قديم أو مُرحِّل بلا تحميل) ⇒ لا حقل جديد: لا baseQty بلا وحدة ولا اسم ولا ختم', () => {
  const bare: InvoiceFacts = {
    id: 'b1', number: 'B-1', type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false,
    subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115, dueDate: at(0), customerName: null, salesRepName: null,
    items: [{ productId: 'p', categoryId: null, qty: 2, unitPrice: 50, taxPct: 15, taxAmt: 15, lineTotal: 115, vatCategory: null }],
  };
  const linked = invoicePostEventPayload(bare, '2026-11-14', linkedCtx(), 's');
  const plain = invoicePostEventPayload(bare, '2026-11-14', deriveCtx(2), 's');
  assert.equal(JSON.stringify(linked), JSON.stringify(plain));
});

// ═══ 3. السند وعكسه (L5) ═══

test('E5.3/E5.4 السند للمربوطة: الطريقة المخصّصة، والبطاقة، والتخصيصات بترتيب المعرّف والصفرية مُسقطة', () => {
  const evs = deriveAccountEntryEvents(ACCOUNT_ENTRY_ROWS as Any, linkedCtx());
  const p1 = payloadOf(evs, 'RECEIPT:rc1:POST');
  assert.equal(p1.paymentMethod, 'BANK_TRANSFER');
  assert.equal(p1.paymentMethodKey, 'c_stcpay');
  assert.deepEqual(p1.allocations, [{ id: 'ri1', invoiceId: 'cr1', amount: '575.00' }, { id: 'ri2', invoiceId: 'cr2', amount: '25.00' }]);
  assert.ok(!('cardPaymentId' in p1));
  const p3 = payloadOf(evs, 'RECEIPT:rc3:POST');
  assert.equal(p3.cardPaymentId, 'cp1');
  assert.equal(p3.amount, '230.00');
  const p2 = payloadOf(evs, 'RECEIPT:rc2:POST');
  for (const k of ['paymentMethodKey', 'cardPaymentId', 'allocations']) assert.ok(!(k in p2), k);
  const zero = receiptPostEventPayload({ ...rec('rc1'), allocations: [{ id: 'z', invoiceId: 'i', amount: 0.004 }] }, '2026-11-14', linkedCtx(), null) as Any;
  assert.ok(!('allocations' in zero));
  // ثلاث منازل
  const bhd = receiptPostEventPayload({ ...rec('rc1'), amount: 0.0005, allocations: [{ id: 'a', invoiceId: 'i', amount: 0.0005 }] }, '2026-11-14', linkedCtx(3), null) as Any;
  assert.equal(bhd.amount, '0.001');
  assert.deepEqual(bhd.allocations, [{ id: 'a', invoiceId: 'i', amount: '0.001' }]);
});

test('E5.7 عكس السند: مصدر ردّ المال ومستخدمه ولقطة اسمه للمربوطة؛ والقيمة المجهولة لا تُكتب؛ والاسم من السياق احتياطاً', () => {
  const evs = deriveAccountEntryEvents(ACCOUNT_ENTRY_ROWS as Any, linkedCtx());
  const r2 = payloadOf(evs, 'RECEIPT:rc2:REVERSE');
  assert.deepEqual(
    { from: r2.cancelRefundFrom, user: r2.cancelRefundUserId, name: r2.cancelRefundUserName, pay: r2.paymentMethod },
    { from: 'USER_CUSTODY', user: 'u1', name: 'سارة', pay: 'CASH' },
  );
  const r4 = payloadOf(evs, 'RECEIPT:rc4:REVERSE');
  assert.equal(r4.cancelRefundFrom, 'MAIN_CASH');
  assert.equal(r4.refundEntryId, 'se-r1');
  assert.equal(r4.refundedAmount, '-1000.00');
  assert.ok(!('cancelRefundUserId' in r4));
  const r5 = payloadOf(evs, 'RECEIPT:rc5:REVERSE'); // إلغاء يدوي لسند ONLINE بلا استرداد
  for (const k of ['cancelRefundFrom', 'cancelRefundUserId', 'cancelRefundUserName']) assert.ok(!(k in r5), k);
  assert.equal(r5.refundEntryId, null);
  const odd = receiptReverseEventPayload({ ...rec('rc2'), cancelRefundFrom: 'SAFE_BOX' }, '2026-11-14', linkedCtx(), null) as Any;
  assert.ok(!('cancelRefundFrom' in odd));
  const fromCtx = receiptReverseEventPayload({ ...rec('rc2'), cancelRefundUserName: null }, '2026-11-14', linkedCtx(), null) as Any;
  assert.equal(fromCtx.cancelRefundUserName, 'سارة');
  const plain = receiptReverseEventPayload(rec('rc2'), '2026-11-14', deriveCtx(2), null) as Any;
  assert.ok(!('cancelRefundFrom' in plain));
});

// ═══ 4. الاستلام وتوريد المستخدم (L5) ═══

test('E5.10 الاستلام بمستخدم ⇒ receivedByUserId ولقطة اسمه للمربوطة؛ وبلا مستلِم بلا الحقلين', () => {
  const evs = deriveRepSettlementEvents(REP_SETTLEMENT_ROWS as Any, linkedCtx());
  const [s1, s2, s3] = evs.map((e) => e.payload as Any);
  assert.equal(s1.receivedByUserId, 'u1');
  assert.equal(s1.receivedByName, 'سارة');
  assert.equal(s1.amount, '800.00');
  assert.ok(!('receivedByUserId' in s2) && !('receivedByName' in s2));
  assert.equal(s2.amount, '700.01'); // 700.005 نصف-لأعلى
  assert.equal(s3.receivedByUserId, 'u2');
  assert.equal(s3.receivedByName, 'ليلى');
  // مستلِم بلا اسم معروف ⇒ المعرّف وحده (الـbuilder يكتب «مستخدم»)
  const noName = settlementPayload(REP_SETTLEMENT_ROWS[0] as RepSettlementSourceRow, null, 2, { linked: true, receivedByName: null }) as Any;
  assert.equal(noName.receivedByUserId, 'u1');
  assert.ok(!('receivedByName' in noName));
  // صفّ بلا العمود (tombstone قديم) ⇒ لا حقل
  const legacyRow = { ...REP_SETTLEMENT_ROWS[0] } as Any;
  delete legacyRow.receivedByUserId;
  assert.ok(!('receivedByUserId' in (settlementPayload(legacyRow, null, 2, { linked: true }) as Any)));
});

test('E5.11 توريد المستخدم ⇒ USER_SETTLEMENT:<id>:POST بـeffectAt=settledAt وحمولة نصية بمنازل العملة ولقطة الاسم', () => {
  for (const [dec, a1, a2] of [[2, '800.00', '300.00'], [3, '800.000', '300.005'], [0, '800', '300']] as const) {
    const evs = deriveUserSettlementEvents(USER_SETTLEMENT_ROWS as Any, linkedCtx(dec));
    assert.deepEqual(evs.map((e) => [e.sourceKey, e.sourceType, e.sourceId, e.event, e.effectAt.getTime()]), [
      ['USER_SETTLEMENT:us1:POST', 'USER_SETTLEMENT', 'us1', 'POST', USER_SETTLEMENT_ROWS[0].settledAt.getTime()],
      ['USER_SETTLEMENT:us2:POST', 'USER_SETTLEMENT', 'us2', 'POST', USER_SETTLEMENT_ROWS[1].settledAt.getTime()],
    ]);
    assert.deepEqual(evs[0].payload, {
      userSettlementId: 'us1', fromUserId: 'u1', fromUserName: 'سارة', amount: a1, method: 'CASH',
      settledAt: USER_SETTLEMENT_ROWS[0].settledAt.toISOString(), createdAt: USER_SETTLEMENT_ROWS[0].createdAt.toISOString(),
      note: null, receivedBy: 'المدير', sourceCreatedAt: USER_SETTLEMENT_ROWS[0].createdAt.toISOString(),
    });
    assert.equal((evs[1].payload as Any).amount, a2);
    assert.equal((evs[1].payload as Any).method, 'BANK_TRANSFER');
    assert.equal(evs.every((e) => e.status === undefined), true);
  }
  // deriveSourceEvents يوزّع، والـtombstone يبني الحمولة نفسها من صفّه (بلا receivedByUserId)
  assert.equal(deriveSourceEvents('USER_SETTLEMENT', USER_SETTLEMENT_ROWS as Any, linkedCtx()).length, 2);
  const row = USER_SETTLEMENT_ROWS[0] as UserSettlementSourceRow;
  const fromTomb = userSettlementPayload({ id: row.id, fromUserId: row.fromUserId, amount: row.amount, method: row.method, settledAt: row.settledAt, createdAt: row.createdAt, note: row.note, receivedBy: row.receivedBy }, 'سارة', 2);
  assert.deepEqual(fromTomb, deriveUserSettlementEvents([row], linkedCtx())[0].payload);
});

// ═══ 5. الاسترداد (C9) ═══

test('E5.8 REFUND للمربوطة ⇒ PAYLINK_REFUND:<entryId> بسند الرابط وعميله والمبلغ الموقَّع؛ ورابط مجهول أو بلا سند ⇒ HELD', () => {
  const evs = deriveSettlementEntryEvents(SETTLEMENT_ENTRY_ROWS as Any, linkedCtx());
  assert.deepEqual(evs.map((e) => e.sourceKey), ['PAYLINK_FEE:se-f1', 'PAYLINK_REFUND:se-r1', 'PAYOUT:po1', 'PAYLINK_REFUND:se-r2', 'PAYLINK_REFUND:se-r3']);
  const r1 = byKey(evs).get('PAYLINK_REFUND:se-r1')!;
  assert.deepEqual([r1.sourceType, r1.sourceId, r1.event, r1.effectAt.getTime(), r1.status], ['PAYLINK_REFUND', 'se-r1', 'POST', at(302).getTime(), undefined]);
  assert.deepEqual(r1.payload, {
    entryId: 'se-r1', linkId: 'L1', receiptId: 'rc4', amount: '-1000.00', createdAt: at(302).toISOString(),
    customerId: 'c1', customerName: 'عميل واحد', note: 'استرداد', sourceCreatedAt: at(302).toISOString(),
  });
  for (const k of ['PAYLINK_REFUND:se-r2', 'PAYLINK_REFUND:se-r3']) {
    const e = byKey(evs).get(k)!;
    assert.equal(e.status, 'HELD', k);
    const note = decodeEventNote(e.lastError ?? '');
    assert.ok(note && note.kind === 'HELD' && note.reason === 'UNEXPECTED_ENTRY_SHAPE', k);
  }
  // COLLECTED بلا حدث حتى للمربوطة، وFEE/PAYOUT كما كانا
  const old = byKey(deriveSettlementEntryEvents(SETTLEMENT_ENTRY_ROWS as Any, deriveCtx(2)));
  for (const k of ['PAYLINK_FEE:se-f1', 'PAYOUT:po1']) assert.equal(JSON.stringify(byKey(evs).get(k)), JSON.stringify(old.get(k)));
  // المبلغ بمنازل 3 و0
  assert.equal(paylinkRefundPayload(SETTLEMENT_ENTRY_ROWS[2] as SettlementEntrySourceRow, null, 3).amount, '-1000.000');
  assert.equal(paylinkRefundPayload({ ...(SETTLEMENT_ENTRY_ROWS[2] as SettlementEntrySourceRow), amount: -12.5 }, null, 0).amount, '-13');
  // إعادة الاشتقاق متساوية الأثر
  assert.deepEqual(serializeEvents(deriveSettlementEntryEvents(SETTLEMENT_ENTRY_ROWS as Any, linkedCtx()) as Any), serializeEvents(evs as Any));
});

// ═══ 6. المصادر ═══

test('USER_SETTLEMENT مصدر مُطابِق للمربوطة وحدها', () => {
  assert.deepEqual([...RECONCILED_SOURCES], ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY', 'USER_SETTLEMENT']);
  for (const s of ['ACCOUNT_ENTRY', 'REP_SETTLEMENT', 'SETTLEMENT_ENTRY'] as const) {
    assert.equal(reconciledSourceEnabled(s, {}), true);
    assert.equal(reconciledSourceEnabled(s, null), true);
  }
  assert.equal(reconciledSourceEnabled('USER_SETTLEMENT', {}), false);
  assert.equal(reconciledSourceEnabled('USER_SETTLEMENT', { linked: false }), false);
  assert.equal(reconciledSourceEnabled('USER_SETTLEMENT', { linked: true }), true);
});

test('إعادة اشتقاق صفحات متداخلة للمربوطة ⇒ مجموعة المفاتيح والحمولات نفسها (لقطة ثابتة)', () => {
  const rows = ACCOUNT_ENTRY_ROWS as AccountEntrySourceRow[];
  const whole = new Map(deriveAccountEntryEvents(rows, linkedCtx()).map((e) => [e.sourceKey, JSON.stringify(e.payload)]));
  for (const size of [1, 2, 3, 7]) {
    const seen = new Map<string, string>();
    for (let i = 0; i < rows.length; i += size) {
      for (const e of deriveAccountEntryEvents(rows.slice(i, i + size), linkedCtx())) if (!seen.has(e.sourceKey)) seen.set(e.sourceKey, JSON.stringify(e.payload));
    }
    assert.deepEqual([...seen.keys()].sort(), [...whole.keys()].sort(), `size=${size}`);
    // الحمولة نفسها إلا sourceCreatedAt (أكبر createdAt بين صفوف المفتاح في الصفحة) — نقارن بلا هذا الحقل
    for (const [k, v] of seen) {
      const strip = (s: string) => { const o = JSON.parse(s); delete o.sourceCreatedAt; return JSON.stringify(o); };
      assert.equal(strip(v), strip(whole.get(k)!), `${k} size=${size}`);
    }
  }
});
