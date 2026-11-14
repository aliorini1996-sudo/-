// «ربط الدفاتر» L5 — الطيّ الصرف لعهدة مستخدم الشركة (العقد §3.4، D6، OD5): النقد، والمرور، والإيداع، والحذف،
// والاسترداد، والقيم المخزّنة، والترتيب، والتاريخ القديم بلا سالب، وحرّاس الحذف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_CUSTODY_CASHLIKE_METHODS, deliveryRemovalKeepsSplits, foldUserCustody, isCashLikeMethod, receivedRemovalKeepsCustodySane,
  userDeliverySplitBefore, userHandoverCapMilli,
  type UserCustodyDeliveredRow, type UserCustodyInputs, type UserCustodyReceivedRow, type UserCustodyRefundRow,
} from '../services/userCustodyCore';

const T0 = Date.parse('2026-09-01T08:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const m = (sar: number) => BigInt(Math.round(sar * 1000));

const R = (id: string, sar: number, method: string, min: number, extra: Partial<UserCustodyReceivedRow> = {}): UserCustodyReceivedRow =>
  ({ id, amountMilli: m(sar), method, at: at(min), createdAt: at(min), ...extra });
const D = (id: string, sar: number, method: string, min: number, extra: Partial<UserCustodyDeliveredRow> = {}): UserCustodyDeliveredRow =>
  ({ id, amountMilli: m(sar), method, at: at(min), createdAt: at(min), ...extra });
const F = (id: string, sar: number, min: number): UserCustodyRefundRow => ({ id, amountMilli: m(sar), at: at(min), createdAt: at(min) });
const inputs = (received: UserCustodyReceivedRow[], delivered: UserCustodyDeliveredRow[] = [], refunds: UserCustodyRefundRow[] = []): UserCustodyInputs =>
  ({ userId: 'U', received, delivered, refunds });

test('isCashLikeMethod: النقد والشيك (والمجهول والفارغ) عهدة، والتحويل ونقطة البيع والإلكتروني والبطاقة لا', () => {
  assert.deepEqual([...USER_CUSTODY_CASHLIKE_METHODS], ['CASH', 'CHEQUE']);
  for (const x of ['CASH', 'CHEQUE', null, undefined, '', 'WEIRD']) assert.equal(isCashLikeMethod(x), true, String(x));
  for (const x of ['BANK_TRANSFER', 'POS', 'ONLINE', 'CARD']) assert.equal(isCashLikeMethod(x), false, x);
});

test('نقد: استلم 800 وورّد 500 ⇒ العهدة 300، والتوريد كلّه من العهدة', () => {
  const f = foldUserCustody(inputs([R('r', 800, 'CASH', 0)], [D('d', 500, 'CASH', 5)]));
  assert.equal(f.receivedCashMilli, 800_000n);
  assert.equal(f.outstandingMilli, 300_000n);
  assert.equal(f.deliveredMilli, 500_000n);
  assert.equal(f.passThroughMilli, 0n);
  assert.deepEqual(f.deliveries, [{ id: 'd', amountMilli: 500_000n, passThroughMilli: 0n, custodyMilli: 500_000n, stored: false, reversed: false }]);
});

test('E5.11 مرور: استلم تحويلاً 300 قديماً ثم ورّده تحويلاً 300 ⇒ لا أثر على العهدة (300000 مرور) ولا سالب', () => {
  const x = inputs([R('b', 300, 'BANK_TRANSFER', 0)], [D('d', 300, 'BANK_TRANSFER', 5)]);
  const f = foldUserCustody(x);
  assert.equal(f.outstandingMilli, 0n);
  assert.equal(f.passThroughMilli, 300_000n);
  assert.equal(f.nonCashPoolMilli, 0n);
  assert.deepEqual(userDeliverySplitBefore(x, 'd'), { passThroughMilli: 300_000n, custodyMilli: 0n });
  // التعريف القديم (المستلَم كله − المورَّد كله) كان يعطي صفراً كذلك — والجديد لا يُدخل التحويل في العهدة أصلاً
  assert.equal(f.receivedNonCashMilli, 300_000n);
});

test('E5.11 إيداع: استلم نقداً 800 وورّده تحويلاً 800 ⇒ نقدٌ أُودع البنك: custody 800 والعهدة صفر', () => {
  const x = inputs([R('c', 800, 'CASH', 0)], [D('d', 800, 'BANK_TRANSFER', 5)]);
  assert.deepEqual(userDeliverySplitBefore(x, 'd'), { passThroughMilli: 0n, custodyMilli: 800_000n });
  assert.equal(foldUserCustody(x).outstandingMilli, 0n);
});

test('مختلط: الوعاء 300 ونقد 500، ثم تحويل 500 (300 مرور + 200 إيداع) ثم نقد 300 ⇒ العهدة صفر بالضبط', () => {
  const x = inputs([R('b', 300, 'POS', 0), R('c', 500, 'CASH', 1)], [D('d1', 500, 'BANK_TRANSFER', 5), D('d2', 300, 'CASH', 6)]);
  const f = foldUserCustody(x);
  assert.deepEqual(f.deliveries.map((d) => [d.id, d.passThroughMilli, d.custodyMilli]), [['d1', 300_000n, 200_000n], ['d2', 0n, 300_000n]]);
  assert.equal(f.outstandingMilli, 0n);
  assert.equal(f.nonCashPoolMilli, 0n);
  assert.equal(f.deliveredMilli, 800_000n);
});

test('الشيك عهدة: استلم شيكاً 700 وورّده شيكاً 700 ⇒ لا مرور، custody 700 (E5.6)', () => {
  const x = inputs([R('q', 700, 'CHEQUE', 0)], [D('d', 700, 'CHEQUE', 5)]);
  assert.deepEqual(userDeliverySplitBefore(x, 'd'), { passThroughMilli: 0n, custodyMilli: 700_000n });
});

test('E5.12 حذف التوريد (العكس): تعود العهدة 800، ويعود المرور إلى الوعاء', () => {
  const f = foldUserCustody(inputs(
    [R('c', 800, 'CASH', 0), R('b', 300, 'BANK_TRANSFER', 1)],
    [D('d1', 800, 'CASH', 5, { reversedAt: at(9) }), D('d2', 300, 'BANK_TRANSFER', 6, { reversedAt: at(9) })],
  ));
  assert.equal(f.outstandingMilli, 800_000n);
  assert.equal(f.nonCashPoolMilli, 300_000n);
  assert.equal(f.deliveredMilli, 0n);
  assert.ok(f.deliveries.every((d) => d.reversed));
});

test('حذف الاستلام (العكس) يُسقط أثره، والاسترداد من العهدة ينقصها', () => {
  const f = foldUserCustody(inputs(
    [R('c1', 800, 'CASH', 0), R('c2', 200, 'CASH', 1, { reversedAt: at(3) })], [], [F('rc', 500, 4)],
  ));
  assert.equal(f.receivedCashMilli, 800_000n);
  assert.equal(f.refundsMilli, 500_000n);
  assert.equal(f.outstandingMilli, 300_000n);
});

test('القيم المخزّنة تُقرأ ولا يُعاد اشتقاقها، والمخزَّن خارج حدود المبلغ خطأ صريح', () => {
  // الاشتقاق كان سيعطي مروراً 300 — المخزَّن صفر (رُحّل قبل وصول الاستلام غير النقدي المتأخر)
  const x = inputs([R('b', 300, 'BANK_TRANSFER', 0)], [D('d', 300, 'BANK_TRANSFER', 5, { storedPassThroughMilli: 0n })]);
  const f = foldUserCustody(x);
  assert.deepEqual([f.deliveries[0].stored, f.deliveries[0].custodyMilli, f.outstandingMilli, f.nonCashPoolMilli], [true, 300_000n, -300_000n, 300_000n]);
  assert.throws(() => foldUserCustody(inputs([], [D('d', 300, 'BANK_TRANSFER', 5, { storedPassThroughMilli: 301_000n })])), RangeError);
  assert.throws(() => foldUserCustody(inputs([], [D('d', 300, 'BANK_TRANSFER', 5, { storedPassThroughMilli: -1n })])), RangeError);
  assert.throws(() => foldUserCustody(inputs([R('x', -1, 'CASH', 0)])), RangeError);
  assert.throws(() => foldUserCustody(inputs([{ ...R('x', 1, 'CASH', 0), at: 'ليس تاريخاً' }])), RangeError);
});

test('الترتيب: تساوي اللحظة ⇒ الاستلام قبل التوريد؛ والتوريد قبل الاستلام زمناً لا يمرّ منه؛ وcreatedAt يفصل', () => {
  // اللحظة نفسها: الاستلام غير النقدي يسبق التوريد فيمرّ منه
  const same = inputs([R('b', 300, 'BANK_TRANSFER', 5)], [D('d', 300, 'BANK_TRANSFER', 5)]);
  assert.equal(userDeliverySplitBefore(same, 'd').passThroughMilli, 300_000n);
  // التوريد أسبق زمناً: لا وعاء بعد ⇒ إيداع نقد
  const early = inputs([R('c', 500, 'CASH', 0), R('b', 300, 'BANK_TRANSFER', 6)], [D('d', 300, 'BANK_TRANSFER', 5)]);
  assert.deepEqual(userDeliverySplitBefore(early, 'd'), { passThroughMilli: 0n, custodyMilli: 300_000n });
  // اللحظة نفسها وcreatedAt يفصل: التوريد أُنشئ قبل الاستلام
  const created = inputs([{ ...R('b', 300, 'BANK_TRANSFER', 5), createdAt: at(7) }], [{ ...D('d', 300, 'BANK_TRANSFER', 5), createdAt: at(6) }]);
  assert.equal(userDeliverySplitBefore(created, 'd').passThroughMilli, 0n);
  // ترتيب المصفوفة لا يغيّر شيئاً
  const a = inputs([R('b', 100, 'POS', 0), R('c', 400, 'CASH', 1)], [D('d1', 250, 'BANK_TRANSFER', 2), D('d2', 100, 'POS', 3)]);
  const b = inputs([...a.received].reverse(), [...a.delivered].reverse());
  const byId = (f: ReturnType<typeof foldUserCustody>) => ({ ...f, deliveries: [...f.deliveries].sort((p, q) => (p.id < q.id ? -1 : 1)) });
  assert.deepEqual(byId(foldUserCustody(a)), byId(foldUserCustody(b)));
  assert.deepEqual(foldUserCustody(a).deliveries.map((d) => [d.id, d.passThroughMilli]), [['d1', 100_000n], ['d2', 0n]]);
});

test('صفّ توريد مكرّر بالمعرّف يُطوى مرة واحدة، والتوريد الغائب عن المدخلات خطأ صريح', () => {
  const f = foldUserCustody(inputs([R('c', 500, 'CASH', 0)], [D('d', 100, 'CASH', 1), D('d', 100, 'CASH', 1)]));
  assert.equal(f.outstandingMilli, 400_000n);
  assert.throws(() => userDeliverySplitBefore(inputs([]), 'nope'), RangeError);
});

test('السقف: نقدي ⇒ العهدة، وغير نقدي ⇒ العهدة + الوعاء الموجب (والوعاء السالب لا يرفعه)', () => {
  const f = foldUserCustody(inputs([R('c', 500, 'CASH', 0), R('b', 300, 'BANK_TRANSFER', 1)], [D('d', 100, 'POS', 2)]));
  assert.equal(userHandoverCapMilli(f, 'CASH'), 500_000n);
  assert.equal(userHandoverCapMilli(f, 'CHEQUE'), 500_000n);
  assert.equal(userHandoverCapMilli(f, 'BANK_TRANSFER'), 700_000n);
  const neg = foldUserCustody(inputs([R('c', 500, 'CASH', 0)], [D('d', 300, 'BANK_TRANSFER', 1, { storedPassThroughMilli: 300_000n })]));
  assert.equal(neg.nonCashPoolMilli, -300_000n);
  assert.equal(userHandoverCapMilli(neg, 'POS'), 500_000n);
});

test('حارس حذف التوريد: حذفٌ يغيّر تقسيم توريدٍ لاحق مرفوض، وحذف اللاحق أو النقدي مقبول', () => {
  // d1 تحويل 300 مرّ كله من الوعاء، d2 تحويل 200 بعده صار إيداع نقد — حذف d1 يجعل d2 مروراً في الشاشة وحدها
  const x = inputs([R('c', 500, 'CASH', 0), R('b', 300, 'BANK_TRANSFER', 1)], [D('d1', 300, 'BANK_TRANSFER', 5), D('d2', 200, 'BANK_TRANSFER', 6)]);
  assert.equal(deliveryRemovalKeepsSplits(x, 'd1'), false);
  assert.equal(deliveryRemovalKeepsSplits(x, 'd2'), true);
  // بعد حذف d2 أولاً يصير حذف d1 آمناً
  assert.equal(deliveryRemovalKeepsSplits({ ...x, delivered: x.delivered.filter((d) => d.id !== 'd2') }, 'd1'), true);
  // توريدات نقدية لا تتأثر بحذف أيٍّ منها
  const cash = inputs([R('c', 900, 'CASH', 0)], [D('a', 300, 'CASH', 1), D('b', 300, 'CHEQUE', 2), D('c2', 300, 'CASH', 3)]);
  for (const id of ['a', 'b', 'c2']) assert.equal(deliveryRemovalKeepsSplits(cash, id), true, id);
  assert.equal(deliveryRemovalKeepsSplits(cash, 'missing'), true);
});

test('حارس حذف الاستلام: لا عهدة سالبة، ولا تغيّر تقسيم توريد مرّ من الاستلام غير النقدي', () => {
  const x = inputs([R('c', 500, 'CASH', 0), R('b', 300, 'BANK_TRANSFER', 1)], [D('d', 300, 'BANK_TRANSFER', 5)]);
  assert.equal(receivedRemovalKeepsCustodySane(x, 'b'), false, 'التوريد مرّ منه: حذفه يجعله إيداع نقد في الشاشة وحدها');
  assert.equal(receivedRemovalKeepsCustodySane(x, 'c'), true, 'العهدة النقدية 500 لم يورَّد منها شيء');
  const y = inputs([R('c', 500, 'CASH', 0)], [D('d', 400, 'CASH', 5)]);
  assert.equal(receivedRemovalKeepsCustodySane(y, 'c'), false, 'ورّد 400 منه');
  assert.equal(receivedRemovalKeepsCustodySane(inputs([R('c', 500, 'CASH', 0)], [D('d', 500.004, 'CASH', 1)]), 'missing', 5n), true, 'ضمن الهامش');
});

/** مولّد حتمي (mulberry32) — السيناريوهات تتكرر بالبذرة نفسها */
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

test('التاريخ القديم بلا سالب (200 سيناريو محكوم): توريدات ضمن السقف ⇒ العهدة والوعاء ≥ 0 دائماً، والمعادلات تتحقق', () => {
  const methods = ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'POS'];
  for (let s = 1; s <= 200; s++) {
    const r = rng(s);
    const x = inputs([]);
    let min = 0;
    for (let k = 0; k < 25; k++) {
      min += 1 + Math.floor(r() * 3);
      const roll = r();
      const method = methods[Math.floor(r() * methods.length)];
      if (roll < 0.5) {
        x.received.push(R(`r${k}`, Math.floor(r() * 100_000) / 100, method, min));
      } else if (roll < 0.9) {
        const cap = userHandoverCapMilli(foldUserCustody(x), method);
        if (cap <= 0n) continue;
        const amt = BigInt(Math.floor(r() * Number(cap))) + 1n;
        x.delivered.push({ id: `d${k}`, amountMilli: amt, method, at: at(min), createdAt: at(min) });
      } else {
        const f = foldUserCustody(x);
        if (f.outstandingMilli <= 0n) continue;
        x.refunds.push({ id: `f${k}`, amountMilli: f.outstandingMilli / 2n, at: at(min), createdAt: at(min) });
      }
      const f = foldUserCustody(x);
      assert.ok(f.outstandingMilli >= 0n, `سيناريو ${s}: عهدة سالبة ${f.outstandingMilli}`);
      assert.ok(f.nonCashPoolMilli >= 0n, `سيناريو ${s}: وعاء سالب`);
      const custody = f.deliveries.reduce((a, d) => a + d.custodyMilli, 0n);
      assert.equal(f.passThroughMilli + custody, f.deliveredMilli, `سيناريو ${s}: المرور + العهدة = المورَّد`);
      assert.equal(f.outstandingMilli, f.receivedCashMilli - custody - f.refundsMilli, `سيناريو ${s}`);
      for (const d of f.deliveries) {
        assert.equal(d.passThroughMilli + d.custodyMilli, d.amountMilli);
        if (isCashLikeMethod(x.delivered.find((y) => y.id === d.id)!.method)) assert.equal(d.passThroughMilli, 0n);
      }
    }
  }
});
