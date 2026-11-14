// «ربط الدفاتر» L4+L5+L8 — اختبار التكامل للمُرحِّل (A6، عقد §8 A6): السيناريو الكامل l458-a06-scenario.ts عبر المُطابِق
// الحقيقي (deriveSourceEvents والـtombstone) والمُرحِّل الحقيقي (runPoster) والـbuilders الحقيقية على المخزن المزيّف، لكل
// منازل 0 و2 و3:
//   - المربوطة: فرق صفر في R1–R7 (التسامح صفر، تقريب نصف-لأعلى لكل مستند ثم الجمع بالملّي)، ولا سطر 911001 إلا لسند
//     إلكتروني بلا رابط من مفتاح API، وكل حدث نهائي (R13)، وأمثلة العقد §7 المحلولة بأرقامها.
//   - غير المربوطة (القديمة): مخرجات اليوم حرفاً — مقارنة ذهبية بلقطة التُقطت بتشغيل السيناريو نفسه على شجرة master
//     الأصلية (468ddff + eea1e69) قبل أي تعديل: القيود سطراً بسطر بأوصافها وأبعادها، والمصادر، وحالات الأحداث.
// وفوقها اختبارات وحدة لنقاط المُرحِّل الجديدة (البوابتان، والحسابات، والمؤشر الفعّال، وحقول السند، وسياق البدء).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { toMilli } from '../services/gl/money';
import { custodyC4bGap, custodyComponentsForRep } from '../services/gl/custody';
import { foldUserCustody } from '../services/userCustodyCore';
import { vatPeriodKey } from '../services/gl/vat/period';
import { DEFAULT_GL_SETTINGS } from '../services/gl/types';
import {
  AUTO_REVERSAL_REASONS, createSyncBudget, cutoverContextOf, effectiveRepSettlementWatermark, isLinkedPosting, laneOf,
  linkedReceiptFields, postSourceEvent, RECONCILE_AFTER_POST_SOURCE_TYPES, runPoster, userDeliveryRestored,
} from '../services/gl/sync/poster';
import type { DesiredEvent } from '../services/gl/sync/types';
import { FakePostingStore, type FakeMove } from './gl-fake-posting-store';
import { ledgerSnapshot, runScenario, t, type Dec, type Sim } from './l458-a06-scenario';

const A = accountIdOf;
const DECS: Dec[] = [0, 2, 3];
const HAS_RECONCILE = existsSync(path.join(__dirname, '../services/gl/reconcile/apply.ts'));
const GOLDEN = JSON.parse(readFileSync(path.join(__dirname, 'l458-a06-legacy-golden.json'), 'utf8')) as Record<string, unknown>;

// ═══ أدوات القراءة ═══

const moveOf = (store: FakePostingStore, key: string): FakeMove => {
  const id = store.state.sources.get(key);
  assert.ok(id, `لا قيد للمفتاح ${key}`);
  return store.state.moves.get(id)!;
};
const linesOn = (m: FakeMove, code: string) => m.lines.filter((l) => l.accountId === A(code));
const debitOn = (m: FakeMove, code: string) => linesOn(m, code).reduce((a, l) => a + l.debitMilli, 0n);
const creditOn = (m: FakeMove, code: string) => linesOn(m, code).reduce((a, l) => a + l.creditMilli, 0n);
const allLines = (store: FakePostingStore) => store.moves().flatMap((m) => m.lines.map((l) => ({ m, l })));
const monthOf = (d: Date | string) => (typeof d === 'string' ? d : new Date(d.getTime() + 3 * 3600_000).toISOString()).slice(0, 7);
const localDay = (d: Date) => new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

// ═══ R1–R7 ═══

function checkR1(store: FakePostingStore): void {
  let td = 0n, tc = 0n;
  for (const m of store.moves()) {
    const d = m.lines.reduce((a, l) => a + l.debitMilli, 0n);
    const c = m.lines.reduce((a, l) => a + l.creditMilli, 0n);
    assert.equal(d, c, `R1: القيد ${m.number} غير متّزن`);
    td += d; tc += c;
  }
  assert.equal(td, tc, 'R1: ميزان المراجعة');
}

function checkR2(sim: Sim, store: FakePostingStore): void {
  const ops = new Map<string, bigint>();
  for (const e of sim.entries) ops.set(e.customerId, (ops.get(e.customerId) ?? 0n) + sim.m(e.debit) - sim.m(e.credit));
  for (const c of ['c1', 'c2', 'c3']) assert.equal(store.balance(A('113001'), c), ops.get(c) ?? 0n, `R2: 113001 للعميل ${c} = Σ AccountEntry`);
}

function checkR3(sim: Sim, store: FakePostingStore): void {
  for (const rep of ['r1', 'r2']) {
    const c = custodyComponentsForRep(sim.custodyInputs(rep), rep);
    assert.equal(store.balanceBy(A('111003'), 'salesRepId', rep), c.ledgerCustody, `R3: 111003 للمندوب ${rep} = ledgerCustody`);
    assert.equal(custodyC4bGap(c), 0n, `R3: C4b للمندوب ${rep} = 0`);
  }
}

function checkR4(sim: Sim, store: FakePostingStore): void {
  for (const u of ['u1', 'u2']) {
    const fold = foldUserCustody(sim.userCustodyInputs(u) as never);
    assert.equal(store.balanceBy(A('111004'), 'adminUserId', u), fold.outstandingMilli, `R4: 111004 للمستخدم ${u} = fold.outstanding`);
  }
}

function checkR5(sim: Sim, store: FakePostingStore): void {
  const ops = sim.settlementEntries.reduce((a, e) => a + sim.m(e.amount), 0n);
  assert.equal(store.balance(A('112005')), ops, 'R5: 112005 = Σ SettlementEntry');
}

/**
 * R6: (411xxx + فئات الإيراد) − 412001 − 413001 لكل شهر = صافي المبيعات. الصيغة المكافئة لـservices/netSales.ts
 * (netOfInvoices: البيع موجب والمرتجع سالب) على أساس قبل الضريبة (subtotal − discountAmt، مقرَّباً لكل مستند)، والإلغاء
 * يُطرح في شهر إلغائه كما يعكسه الأستاذ بتاريخه (netSales.ts يعدّ المؤكَّد وحده فيتطابقان في الشهر نفسه).
 */
function checkR6(sim: Sim, store: FakePostingStore): void {
  const gl = new Map<string, bigint>();
  for (const { m, l } of allLines(store)) {
    const code = l.accountId.replace(/^acc_/, '');
    let v = 0n;
    if (code.startsWith('411')) v = l.creditMilli - l.debitMilli;
    else if (code === '412001' || code === '413001') v = -(l.debitMilli - l.creditMilli);
    else continue;
    gl.set(m.date.slice(0, 7), (gl.get(m.date.slice(0, 7)) ?? 0n) + v);
  }
  const ops = new Map<string, bigint>();
  const add = (month: string, v: bigint) => ops.set(month, (ops.get(month) ?? 0n) + v);
  for (const inv of sim.invoices.values()) {
    const net = sim.m(inv.subtotal) - sim.m(inv.discountAmt);
    const sign = inv.type === 'RETURN' ? -1n : 1n;
    add(monthOf(inv.at), sign * net);
    if (inv.status === 'CANCELLED') add(monthOf(inv.cancelledAt!), -sign * net);
  }
  for (const month of new Set([...gl.keys(), ...ops.keys()])) {
    assert.equal(gl.get(month) ?? 0n, ops.get(month) ?? 0n, `R6: صافي المبيعات لشهر ${month}`);
  }
}

/** R7: 212001 لكل (فترة إقرار، مربع، عمود التعديلات) = Σ ضريبة المستندات بقاعدة OD17 */
function checkR7(sim: Sim, store: FakePostingStore): void {
  const key = (d: string, box: string | null, adj: boolean) => `${vatPeriodKey(d, 'QUARTERLY')}|${box}|${adj}`;
  const gl = new Map<string, bigint>();
  for (const { m, l } of allLines(store)) {
    if (l.accountId !== A('212001')) continue;
    const k = key(m.date, l.vatBox ?? null, l.vatAdjustment === true);
    gl.set(k, (gl.get(k) ?? 0n) + l.creditMilli - l.debitMilli);
  }
  const ops = new Map<string, bigint>();
  const add = (k: string, v: bigint) => ops.set(k, (ops.get(k) ?? 0n) + v);
  for (const inv of sim.invoices.values()) {
    const tax = sim.m(inv.taxAmt);
    if (tax === 0n) continue;
    const day = localDay(inv.at);
    if (inv.type === 'RETURN') add(key(day, 'SA_1', true), -tax);
    else add(key(day, 'SA_1', false), tax);
    if (inv.status === 'CANCELLED') {
      const cday = localDay(inv.cancelledAt!);
      const crosses = vatPeriodKey(cday, 'QUARTERLY') !== vatPeriodKey(day, 'QUARTERLY');
      if (inv.type === 'RETURN') add(key(cday, 'SA_1', true), tax);
      else add(key(cday, 'SA_1', crosses), -tax);
    }
  }
  for (const k of new Set([...gl.keys(), ...ops.keys()])) assert.equal(gl.get(k) ?? 0n, ops.get(k) ?? 0n, `R7: 212001 للفترة والمربع ${k}`);
}

/** لا 911001 إلا لسند ONLINE بلا رابط من مفتاح API (R-13)؛ وR13: كل حدث نهائي */
function checkSuspenseAndFinal(store: FakePostingStore): void {
  for (const { m, l } of allLines(store)) {
    if (l.accountId === A('911001')) assert.equal(m.sourceId, 'R-13', `911001 خارج السند الإلكتروني بلا رابط: ${m.number} ${l.label}`);
  }
  for (const e of store.state.events.values()) {
    assert.ok(e.status === 'DONE' || e.status === 'SKIPPED', `R13: ${e.sourceKey} ${e.status} ${e.lastError ?? ''}`);
  }
}

// ═══ المربوطة: R1–R7 لكل منازل ═══

for (const dec of DECS) {
  test(`المربوطة (منازل ${dec}): R1–R7 فرق صفر، ولا 911001 إلا بلا رابط من API، وكل حدث نهائي`, async () => {
    const { sim, store } = await runScenario(dec, true, { reconcile: HAS_RECONCILE });
    checkSuspenseAndFinal(store);
    checkR1(store);
    checkR2(sim, store);
    checkR3(sim, store);
    checkR4(sim, store);
    checkR5(sim, store);
    checkR6(sim, store);
    checkR7(sim, store);
    // ثابت البُعد (D2): 111004 بالمستخدم وحده، و111003 بالمندوب وحده
    for (const { l } of allLines(store)) {
      if (l.accountId === A('111004')) assert.ok(l.adminUserId && !l.salesRepId, `111004 بلا مستخدم أو بمندوب: ${l.label}`);
      if (l.accountId === A('111003')) assert.ok(l.salesRepId && !l.adminUserId, `111003 بلا مندوب أو بمستخدم: ${l.label}`);
    }
    // الحسابات الثلاثة أُنشئت مرة واحدة ملتزمة (D2): استدعاء الإنشاء ثم تأكيد واحد في أول نبضة بعده
    assert.ok(store.state.extraAccounts.some((a) => a.code === '111004') && store.state.extraAccounts.some((a) => a.code === '214002'));
  });
}

// ═══ غير المربوطة: مخرجات اليوم حرفاً ═══

for (const dec of DECS) {
  test(`غير المربوطة (منازل ${dec}): مخرجات المُرحِّل = لقطة master الأصلية سطراً بسطر (ولا إنشاء حسابات ولا مطابقة)`, async () => {
    const { sim, store } = await runScenario(dec, false);
    assert.deepEqual(ledgerSnapshot(store), GOLDEN[`dec${dec}`]);
    assert.equal(store.ensureLinkedCalls, 0, 'لا ensureLinkedAccounts لغير المربوطة');
    assert.equal(store.state.partials.length, 0, 'لا مطابقة جزئية لغير المربوطة');
    assert.ok(![...store.state.events.keys()].some((k) => k.startsWith('USER_SETTLEMENT') || k.startsWith('PAYLINK_REFUND')));
    checkR1(store);
    checkR2(sim, store);
  });
}

// ═══ أمثلة العقد §7 بأرقامها (الريال، منزلتان) ═══

test('أمثلة L4 (E4.1–E4.12) على قيود المربوطة', async () => {
  const { store } = await runScenario(2, true, { reconcile: HAS_RECONCILE });
  // E4.1 آجل بقسطين: سطرا ذمة بالاستحقاقين، وإيراد الصنف بكمية الأساس 240
  const inv3 = moveOf(store, 'INVOICE:INV-3:POST');
  assert.deepEqual(linesOn(inv3, '113001').map((l) => [l.debitMilli, l.dueDate, l.customerId, l.salesRepId]),
    [[575_000n, '2026-10-21', 'c1', 'r1'], [575_000n, '2026-11-20', 'c1', 'r1']]);
  assert.deepEqual(linesOn(inv3, '411001').map((l) => [l.creditMilli, l.productId, l.quantity]), [[1_000_000n, 'P', 240]]);
  assert.equal(creditOn(inv3, '212001'), 150_000n);
  // E4.2 نقدي مختوم ⇒ 111003 (المندوب)؛ E4.3 غير مختوم ⇒ 111001
  const inv1 = moveOf(store, 'INVOICE:INV-1:POST');
  assert.deepEqual(linesOn(inv1, '111003').map((l) => [l.debitMilli, l.salesRepId]), [[115_000n, 'r1']]);
  assert.equal(debitOn(inv1, '111001'), 0n);
  assert.equal(debitOn(moveOf(store, 'INVOICE:INV-2:POST'), '111001'), 115_000n);
  // E4.4 (B1): استحقاق افتراضي = يوم الفاتورة + paymentDays (15)
  const inv4 = moveOf(store, 'INVOICE:INV-4:POST');
  assert.deepEqual(linesOn(inv4, '113001').map((l) => [l.debitMilli, l.dueDate]), [[207_000n, '2026-10-07']]);
  // E4.5 إيراد لكل صنف وخصم منفصل لكل صنف (والفئة إلى 411002)
  assert.deepEqual(linesOn(inv4, '413001').map((l) => [l.debitMilli, l.productId]).sort(), [[10_000n, 'P1'], [10_000n, 'P2']]);
  assert.deepEqual(linesOn(inv4, '411001').map((l) => [l.creditMilli, l.productId, l.quantity]), [[100_000n, 'P1', 2]]);
  assert.deepEqual(linesOn(inv4, '411002').map((l) => [l.creditMilli, l.productId, l.quantity]), [[100_000n, 'P2', 1]]);
  assert.equal(creditOn(inv4, '212001'), 27_000n);
  // E4.6 فاتورة قديمة غير متّزنة بهللة ⇒ 421009
  assert.equal(creditOn(moveOf(store, 'INVOICE:INV-9:POST'), '421009'), 10n);
  // E4.10 (OD17): إلغاء في فترة لاحقة ⇒ vatAdjustment، وفي الفترة نفسها ⇒ لا
  assert.deepEqual(linesOn(moveOf(store, 'INVOICE:INV-5:REVERSE'), '212001').map((l) => [l.debitMilli, l.vatAdjustment]), [[15_000n, true]]);
  assert.deepEqual(linesOn(moveOf(store, 'INVOICE:INV-6:REVERSE'), '212001').map((l) => l.vatAdjustment), [false]);
  // E4.11 إبطال يحتفظ بالنقد: لا ساق نقد في العكس، والعهدة باقية
  const void8 = moveOf(store, 'INVOICE:INV-8:REVERSE');
  assert.equal(linesOn(void8, '111003').length, 0);
  assert.equal(creditOn(void8, '113001'), 115_000n);
  // E4.12 (OD12): استيراد بعد البداية ⇒ 319002 مع تنبيه
  const imp = store.moves().find((m) => m.sourceType === 'AR_ENTRY')!;
  assert.equal(debitOn(imp, '113001'), 50_000n);
  assert.equal(creditOn(imp, '319002'), 50_000n);
  assert.equal(imp.needsAttention, true);
});

test('أمثلة L5 (E5.1–E5.12) على قيود المربوطة', async () => {
  const { store } = await runScenario(2, true, { reconcile: HAS_RECONCILE });
  // E5.1–E5.5 خريطة الطرق: عهدة، والبنك (OD14)، والمخصّصة 111102، والبطاقة 112007، ونقاط البيع 112004
  assert.deepEqual(linesOn(moveOf(store, 'RECEIPT:R-1:POST'), '111003').map((l) => [l.debitMilli, l.salesRepId]), [[500_000n, 'r1']]);
  assert.equal(debitOn(moveOf(store, 'RECEIPT:R-2:POST'), '111101'), 200_000n);
  assert.equal(debitOn(moveOf(store, 'RECEIPT:R-3:POST'), '111102'), 7_000n);
  assert.equal(debitOn(moveOf(store, 'RECEIPT:R-4:POST'), '112007'), 115_000n);
  assert.equal(debitOn(moveOf(store, 'RECEIPT:R-5:POST'), '112004'), 30_000n);
  // E5.6 الشيك: عهدة المندوب ⇒ عهدة المستخدم ⇒ 112003 (والحذف مرآة)
  assert.deepEqual(linesOn(moveOf(store, 'SETTLEMENT:S-1b:POST'), '111004').map((l) => [l.debitMilli, l.adminUserId]), [[100_000n, 'u1']]);
  const u1x = moveOf(store, 'USER_SETTLEMENT:U-1x:POST');
  assert.equal(debitOn(u1x, '112003'), 40_000n);
  assert.deepEqual(linesOn(u1x, '111004').map((l) => [l.creditMilli, l.adminUserId]), [[40_000n, 'u1']]);
  const u1xRev = moveOf(store, 'USER_SETTLEMENT:U-1x:REVERSE');
  assert.equal(u1xRev.reversedMoveId, u1x.id, 'E5.12: حذف التوريد مرآة قيده');
  // E5.7 الإلغاء بعد التسليم: من الصندوق ⇒ 111001، ومن عهدة مستخدم ⇒ 111004 [u1]، ولا يمسّ 111003
  const r12 = moveOf(store, 'RECEIPT:R-12:REVERSE');
  assert.equal(creditOn(r12, '111001'), 70_000n);
  assert.equal(linesOn(r12, '111003').length, 0);
  assert.deepEqual(linesOn(moveOf(store, 'RECEIPT:R-11:REVERSE'), '111004').map((l) => [l.creditMilli, l.adminUserId]), [[40_000n, 'u1']]);
  assert.equal(creditOn(moveOf(store, 'RECEIPT:R-10:REVERSE'), '111003'), 60_000n, 'قبل التسليم: مرآة');
  // E5.8 الإلغاء اليدوي ⇒ 214002، والاسترداد اللاحق ⇒ Dr 214002 / Cr 112005؛ والمسار العادي NETTED
  assert.equal(creditOn(moveOf(store, 'RECEIPT:R-9:REVERSE'), '214002'), 80_000n);
  const refund9 = store.moves().find((m) => m.sourceType === 'PAYLINK_REFUND')!;
  assert.equal(debitOn(refund9, '214002'), 80_000n);
  assert.equal(creditOn(refund9, '112005'), 80_000n);
  assert.equal(creditOn(moveOf(store, 'RECEIPT:R-8:REVERSE'), '112005'), 100_000n);
  const refundEvents = [...store.state.events.values()].filter((e) => e.sourceType === 'PAYLINK_REFUND');
  assert.deepEqual(refundEvents.map((e) => [e.status, e.skipReason]).sort(), [['DONE', null], ['SKIPPED', 'NETTED']]);
  assert.equal(store.balance(A('214002')), 0n);
  // E5.9 التوريد الأسبوعي إلى البنك (OD14)
  assert.equal(debitOn(store.moves().find((m) => m.sourceType === 'PAYOUT')!, '111101'), 223_100n);
  // E5.10 الاستلام: نقد بمستخدم ⇒ 111004، وتحويل بمستخدم ⇒ البنك لا 111004 (OD5)
  assert.deepEqual(linesOn(moveOf(store, 'SETTLEMENT:S-2:POST'), '111004').map((l) => [l.debitMilli, l.adminUserId, l.salesRepId]), [[40_000n, 'u1', null]]);
  const s3 = moveOf(store, 'SETTLEMENT:S-3:POST');
  assert.equal(linesOn(s3, '111004').length, 0);
  assert.equal(debitOn(s3, '111101'), 15_000n);
  // E5.11 توريد المستخدم: نقد ⇒ 111001، ومرور كامل NETTED بمخزَّنه، وإيداع نقد بتحويل ⇒ 111101
  assert.equal(debitOn(moveOf(store, 'USER_SETTLEMENT:U-1:POST'), '111001'), 60_000n);
  const u2 = store.event('USER_SETTLEMENT:U-2:POST')!;
  assert.deepEqual([u2.status, u2.skipReason, u2.nonCustodyClearedMilli], ['SKIPPED', 'NETTED', 200_000n]);
  const u3 = moveOf(store, 'USER_SETTLEMENT:U-3:POST');
  assert.equal(debitOn(u3, '111101'), 15_000n);
  assert.deepEqual(linesOn(u3, '111004').map((l) => [l.creditMilli, l.adminUserId]), [[15_000n, 'u2']]);
  // حذف الاستلام بعد ترحيله (P8): مرآة القيد الحيّ
  assert.equal(moveOf(store, 'SETTLEMENT:S-4:REVERSE').reversedMoveId, moveOf(store, 'SETTLEMENT:S-4:POST').id);
});

test('L8: المطابقة الجزئية داخل معاملة الترحيل — متبقّي الذمم = remainingAmt التشغيلي (E8.1، E8.3)', { skip: !HAS_RECONCILE && 'services/gl/reconcile (A10) غير موجود بعد' }, async () => {
  const { sim, store } = await runScenario(2, true);
  const arResidual = (key: string) => {
    const m = moveOf(store, key);
    return m.lines.reduce((a, l, i) => (l.accountId === A('113001') && l.debitMilli > 0n ? a + store.lineResidual(l.id ?? `${m.id}:${i}`) : a), 0n);
  };
  // INV-3: 1150 − سند 500 − مرتجع 115 − شيك 100 = 435، والقسط الأقدم استحقاقاً يُطابَق أولاً
  assert.equal(arResidual('INVOICE:INV-3:POST'), sim.m(435));
  const inv3 = moveOf(store, 'INVOICE:INV-3:POST');
  const [i1, i2] = inv3.lines.filter((l) => l.accountId === A('113001'));
  assert.deepEqual([store.lineResidual(i1.id!), store.lineResidual(i2.id!)], [0n, 435_000n]);
  // المرتجع (05/10) سبق السند (06/10): RET 115 من القسط الأول، ثم السند 460 على باقيه و40 على الثاني (الأقدم استحقاقاً أولاً)
  const ri1 = store.partials().filter((p) => p.sourceRef === 'RI:R-1-a1');
  assert.deepEqual(ri1.map((p) => [p.debitLineId, p.amountMilli]), [[i1.id, 460_000n], [i2.id, 40_000n]]);
  assert.deepEqual(store.partials().filter((p) => p.sourceRef === 'RET:RET-7').map((p) => [p.debitLineId, p.amountMilli]), [[i1.id, 115_000n]]);
  // INV-4 مسدَّدة بسندين (بنك ومخصّصة) ⇒ صفر؛ والملغاة مطابَقة بعكسها
  assert.equal(arResidual('INVOICE:INV-4:POST'), 0n);
  assert.equal(arResidual('INVOICE:INV-5:POST'), 0n);
  // E8.3: سند أُلغي ⇒ سطر دائنه مطابَق مع عكسه، فلا يبقى رصيد دائن مفتوح منه
  const r10 = moveOf(store, 'RECEIPT:R-10:POST');
  const r10Credit = r10.lines.findIndex((l) => l.accountId === A('113001'));
  assert.equal(store.lineResidual(r10.lines[r10Credit].id!), 0n);
});

// ═══ وحدات المُرحِّل الجديدة ═══

test('المصادر الجديدة في مسار المستندات الحية، وسبب العكس الآلي لحذف التوريد، ومصادر المطابقة', () => {
  assert.equal(laneOf({ sourceType: 'USER_SETTLEMENT' }), 'LIVE');
  assert.equal(laneOf({ sourceType: 'PAYLINK_REFUND' }), 'LIVE');
  assert.equal(AUTO_REVERSAL_REASONS.USER_SETTLEMENT, 'حذف توريد عهدة مستخدم الشركة');
  assert.deepEqual([...RECONCILE_AFTER_POST_SOURCE_TYPES], ['INVOICE', 'RECEIPT', 'AR_ENTRY', 'PAYLINK_REFUND']);
});

test('cutoverContextOf: المربوطة ⇒ skipImportedBalances=false (OD12)، وغيرها كائن اليوم حرفاً بلا المفتاح', () => {
  const base = { setupMethod: 'OPENING' as const, cutoverDate: '2026-07-01', openingSnapshotAt: new Date('2026-06-30T21:00:00Z'), timezone: 'Asia/Riyadh' };
  const legacy = cutoverContextOf({ ...base, snapshot: { ...DEFAULT_GL_SETTINGS } });
  assert.equal('skipImportedBalances' in legacy, false);
  assert.deepEqual(legacy, cutoverContextOf(base));
  assert.equal(cutoverContextOf({ ...base, snapshot: { ...DEFAULT_GL_SETTINGS, linkedPosting: true } }).skipImportedBalances, false);
  // CLEAN كما كان (cleanStart) ولا مفتاح جديد
  const clean = cutoverContextOf({ ...base, setupMethod: 'CLEAN' });
  assert.deepEqual([clean.cleanStart, 'skipImportedBalances' in clean], [true, false]);
});

test('linkedReceiptFields: حمولة غير المربوطة لا تضيف مفتاحاً، والمربوطة تمرّر الحقول الثلاثة حين تحمل قيمة', () => {
  assert.deepEqual(linkedReceiptFields({}), {});
  assert.deepEqual(linkedReceiptFields({ paymentMethodKey: null, cardPaymentId: null, allocations: [] }), {});
  const allocations = [{ id: 'a1', invoiceId: 'i1', amount: '10.00' }];
  assert.deepEqual(linkedReceiptFields({ paymentMethodKey: 'c_stc', cardPaymentId: 'cp1', allocations }), { paymentMethodKey: 'c_stc', cardPaymentId: 'cp1', allocations });
});

test('isLinkedPosting: من لقطة الإعدادات أو السياق المعاد قراءته، وغيرها false', () => {
  const s = new FakePostingStore();
  assert.equal(isLinkedPosting({ settings: s.settings, context: s.context() }), false);
  const l = new FakePostingStore({ linked: true });
  assert.equal(isLinkedPosting({ settings: l.settings }), true);
  assert.equal(isLinkedPosting({ context: l.context() }), true);
});

test('effectiveRepSettlementWatermark: بلا مؤشر null، وصفوف غير مقروءة ⇒ المؤشر كما هو، وإلا الأفق', async () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const s = new FakePostingStore({ unreadRepSettlements: () => false });
  assert.equal(await effectiveRepSettlementWatermark(s, 't1', now), null);
  s.setCursor('REP_SETTLEMENT', new Date('2026-10-20T09:00:00Z'), 'rs9');
  const w = await effectiveRepSettlementWatermark(s, 't1', now);
  assert.equal(w!.at.getTime(), now.getTime() - 10 * 60_000, 'لا صفوف غير مقروءة ⇒ الأفق (dbNow − 10 دقائق)');
  const busy = new FakePostingStore({ unreadRepSettlements: () => true });
  busy.setCursor('REP_SETTLEMENT', new Date('2026-10-20T09:00:00Z'), 'rs9');
  assert.deepEqual(await effectiveRepSettlementWatermark(busy, 't1', now), { at: new Date('2026-10-20T09:00:00Z'), id: 'rs9' });
});

test('userDeliveryRestored: التوريد المحذوف يُعاد من الحمولة بتقسيمه المخزَّن، والقائم يُعاد تفعيله للعكس', () => {
  const p = { amount: '15.00', method: 'BANK_TRANSFER', settledAt: '2026-10-25T07:00:00.000Z', createdAt: '2026-10-25T07:00:00.000Z' };
  const empty = { userId: 'u2', received: [], delivered: [], refunds: [] };
  const added = userDeliveryRestored(empty, 'U-3', p, 2, { reinstate: true, storedPassThroughMilli: 5_000n });
  assert.deepEqual(added.delivered, [{ id: 'U-3', amountMilli: 15_000n, method: 'BANK_TRANSFER', at: p.settledAt, createdAt: p.createdAt, reversedAt: null, storedPassThroughMilli: 5_000n }]);
  const existing = { ...empty, delivered: [{ id: 'U-3', amountMilli: 15_000n, method: 'BANK_TRANSFER', at: p.settledAt, createdAt: p.createdAt, reversedAt: new Date(), storedPassThroughMilli: null }] };
  const back = userDeliveryRestored(existing, 'U-3', p, 2, { reinstate: true, storedPassThroughMilli: 0n });
  assert.deepEqual([back.delivered[0].reversedAt, back.delivered[0].storedPassThroughMilli], [null, 0n]);
  const post = userDeliveryRestored(existing, 'U-3', p, 2, { reinstate: false });
  assert.notEqual(post.delivered[0].reversedAt, null, 'POST لا يمسّ reversedAt');
});

// ── البوابتان (§5.7) على مخزن صغير ──

const AT = new Date('2026-10-20T09:00:00.000Z');
function linkedStore(opts: ConstructorParameters<typeof FakePostingStore>[0] = {}): FakePostingStore {
  const s = new FakePostingStore({
    now: () => AT.getTime() + 3600_000, linked: true, reconcile: HAS_RECONCILE,
    settings: { activatedAt: new Date('2026-07-01T00:00:00Z'), openingSnapshotAt: new Date('2026-06-30T21:00:00Z'), cutoverDate: '2026-07-01' },
    ...opts,
  });
  s.setCursor('ACCOUNT_ENTRY', new Date('2099-01-01T00:00:00Z'));
  s.setCursor('REP_SETTLEMENT', new Date('2099-01-01T00:00:00Z'));
  return s;
}
const refundEvent = (receiptId: string | null): DesiredEvent => ({
  sourceKey: 'PAYLINK_REFUND:se1', sourceType: 'PAYLINK_REFUND', sourceId: 'se1', event: 'POST', effectAt: AT,
  payload: { entryId: 'se1', linkId: 'L1', receiptId, amount: '-80.00', createdAt: AT.toISOString(), customerId: 'c1', customerName: 'عميل', sourceCreatedAt: AT.toISOString() } as never,
});

test('PAYLINK_REFUND: بلا عكس السند ⇒ BLOCKED(SIBLING_NOT_FINAL)، وعكسه SKIPPED ⇒ NETTED، وبلا سند ⇒ HELD', async () => {
  const s = linkedStore();
  s.seedEvents([refundEvent('R-9')]);
  const out = await postSourceEvent(s, s.settings, s.event('PAYLINK_REFUND:se1')!);
  assert.deepEqual([out.status, (out as { reason?: string }).reason], ['BLOCKED', 'SIBLING_NOT_FINAL']);
  s.seedEvents([{ sourceKey: 'RECEIPT:R-9:REVERSE', sourceType: 'RECEIPT', sourceId: 'R-9', event: 'REVERSE', effectAt: AT, payload: null, status: 'SKIPPED', skipReason: 'OPENING' }]);
  const out2 = await postSourceEvent(s, s.settings, s.event('PAYLINK_REFUND:se1')!);
  assert.deepEqual([out2.status, (out2 as { skipReason?: string }).skipReason], ['SKIPPED', 'NETTED']);
  assert.equal(s.moves().length, 0);

  const h = linkedStore();
  h.seedEvents([refundEvent(null)]);
  const held = await postSourceEvent(h, h.settings, h.event('PAYLINK_REFUND:se1')!);
  assert.deepEqual([held.status, (held as { reason?: string }).reason], ['HELD', 'UNEXPECTED_ENTRY_SHAPE']);
});

test('PAYLINK_REFUND: عكس السند DONE بالاسترداد نفسه ⇒ NETTED، وبإلغاء يدوي ⇒ Dr 214002 / Cr 112005', async () => {
  for (const [refundEntryId, expect] of [['se1', 'SKIPPED'], [null, 'DONE']] as const) {
    const s = linkedStore();
    s.seedEvents([
      refundEvent('R-9'),
      { sourceKey: 'RECEIPT:R-9:REVERSE', sourceType: 'RECEIPT', sourceId: 'R-9', event: 'REVERSE', effectAt: AT, payload: { receiptId: 'R-9', entryDate: '2026-10-20', refundEntryId } as never },
    ]);
    s.state.events.get('RECEIPT:R-9:REVERSE')!.status = 'DONE';
    const out = await postSourceEvent(s, s.settings, s.event('PAYLINK_REFUND:se1')!);
    assert.equal(out.status, expect);
    if (expect === 'DONE') {
      const m = s.moves()[0];
      assert.deepEqual([debitOn(m, '214002'), creditOn(m, '112005')], [80_000n, 80_000n]);
      assert.equal(s.ensureLinkedCalls >= 1, true, 'الحسابات المربوطة تُنشأ قبل أول بناء');
    }
  }
});

test('USER_SETTLEMENT: استلامٌ للمستخدم غير نهائي ⇒ BLOCKED(SETTLEMENT_ORDER)، ومؤشر REP_SETTLEMENT متأخر ⇒ BLOCKED، ثم يُرحَّل', async () => {
  const payload = { userSettlementId: 'U-1', fromUserId: 'u1', fromUserName: 'مستخدم', amount: '60.00', method: 'CASH', settledAt: AT.toISOString(), createdAt: AT.toISOString(), sourceCreatedAt: AT.toISOString() };
  const inputs = {
    userId: 'u1', refunds: [],
    received: [{ id: 'S-2', amountMilli: 60_000n, method: 'CASH', at: new Date(AT.getTime() - 3600_000), createdAt: new Date(AT.getTime() - 3600_000), reversedAt: null }],
    delivered: [{ id: 'U-1', amountMilli: 60_000n, method: 'CASH', at: AT, createdAt: AT, reversedAt: null, storedPassThroughMilli: null }],
  };
  const s = linkedStore({ userCustody: () => inputs as never });
  s.seedEvents([
    { sourceKey: 'USER_SETTLEMENT:U-1:POST', sourceType: 'USER_SETTLEMENT', sourceId: 'U-1', event: 'POST', effectAt: AT, payload: payload as never },
    { sourceKey: 'SETTLEMENT:S-2:POST', sourceType: 'SETTLEMENT', sourceId: 'S-2', event: 'POST', effectAt: new Date(AT.getTime() - 3600_000), payload: { receivedByUserId: 'u1', salesRepId: 'r2' } as never },
  ]);
  const blocked = await postSourceEvent(s, s.settings, s.event('USER_SETTLEMENT:U-1:POST')!);
  assert.deepEqual([blocked.status, (blocked as { reason?: string }).reason], ['BLOCKED', 'SETTLEMENT_ORDER']);
  s.state.events.get('SETTLEMENT:S-2:POST')!.status = 'DONE';
  // مؤشر REP_SETTLEMENT لم يتجاوز إنشاء التوريد (صفوف غير مقروءة حتى الأفق) ⇒ محجوب
  s.setCursor('REP_SETTLEMENT', new Date(AT.getTime() - 60_000), 'x');
  const lag = await postSourceEvent(s, s.settings, s.event('USER_SETTLEMENT:U-1:POST')!);
  assert.equal(lag.status, 'BLOCKED');
  s.setCursor('REP_SETTLEMENT', new Date('2099-01-01T00:00:00Z'));
  const done = await postSourceEvent(s, s.settings, s.event('USER_SETTLEMENT:U-1:POST')!);
  assert.equal(done.status, 'DONE');
  const m = s.moves()[0];
  assert.deepEqual([debitOn(m, '111001'), linesOn(m, '111004').map((l) => [l.creditMilli, l.adminUserId])], [60_000n, [[60_000n, 'u1']]]);
  assert.equal(s.event('USER_SETTLEMENT:U-1:POST')!.nonCustodyClearedMilli, 0n, 'المرور المحفوظ على الحدث');
});

test('ensureLinkedAccounts: مرة للنبضة بعد الإنشاء الملتزم، ولا شيء لغير المربوطة (وOD14 للمربوطة وحدها)', async () => {
  const s = linkedStore();
  const ev = (id: string): DesiredEvent => ({
    sourceKey: `RECEIPT:${id}:POST`, sourceType: 'RECEIPT', sourceId: id, event: 'POST', effectAt: AT,
    payload: { receiptId: id, entryDate: '2026-10-20', salesRepId: null, paymentMethod: 'BANK_TRANSFER', amount: '10.00', customerId: 'c1', customerName: 'عميل', sourceCreatedAt: AT.toISOString() } as never,
  });
  s.seedEvents([ev('a'), ev('b'), ev('c')]);
  await runPoster(s, s.settings, createSyncBudget({ clock: () => AT.getTime(), timeMs: 1e12, events: 100 }), { log: () => undefined });
  assert.equal(s.moves().length, 3);
  // الأول أنشأ (created≠[]) فلم يُعلَّم، والثاني تحقّق (created=[]) فعُلِّم، والثالث بلا استدعاء
  assert.equal(s.ensureLinkedCalls, 2);
  assert.ok(s.state.extraAccounts.some((a) => a.code === '112007'));

  const legacy = new FakePostingStore({ now: () => AT.getTime(), settings: { activatedAt: new Date('2026-07-01T00:00:00Z'), openingSnapshotAt: new Date('2026-06-30T21:00:00Z'), cutoverDate: '2026-07-01' } });
  legacy.seedEvents([ev('a')]);
  await runPoster(legacy, legacy.settings, createSyncBudget({ clock: () => AT.getTime(), timeMs: 1e12, events: 100 }), { log: () => undefined });
  assert.deepEqual([legacy.moves().length, legacy.ensureLinkedCalls, legacy.state.extraAccounts.length], [1, 0, 0]);
  // OD14 للمربوطة وحدها: التحويل ⇒ 111101، وغير المربوطة ⇒ 112001 كاليوم
  assert.equal(debitOn(s.moves()[0], '111101'), 10_000n);
  assert.equal(debitOn(legacy.moves()[0], '112001'), 10_000n);
});

test('ensureLinkedAccounts: معاملة أنشأت الحسابات ثم تراجعت ⇒ يُعاد الإنشاء في الحدث التالي (لا HELD(MISSING_MAPPING))', async () => {
  const s = linkedStore();
  const rec = (id: string, at: Date, extra: Record<string, unknown>): DesiredEvent => ({
    sourceKey: `RECEIPT:${id}:POST`, sourceType: 'RECEIPT', sourceId: id, event: 'POST', effectAt: at,
    payload: { receiptId: id, entryDate: '2026-10-20', salesRepId: null, paymentMethod: 'POS', customerId: 'c1', customerName: 'عميل', sourceCreatedAt: at.toISOString(), ...extra } as never,
  });
  // الأول يُنشئ الحسابات ثم يفشل بناؤه (مبلغ سالب) فتتراجع معاملته كلها؛ الثاني بطاقة تحتاج 112007
  s.seedEvents([rec('bad', AT, { amount: '-5.00' }), rec('card', new Date(AT.getTime() + 1000), { amount: '23.00', cardPaymentId: 'cp1' })]);
  await runPoster(s, s.settings, createSyncBudget({ clock: () => AT.getTime(), timeMs: 1e12, events: 100 }), { log: () => undefined });
  assert.equal(s.event('RECEIPT:bad:POST')!.status, 'ERROR');
  assert.equal(s.event('RECEIPT:card:POST')!.status, 'DONE');
  assert.equal(debitOn(s.moves()[0], '112007'), 23_000n);
  assert.ok(s.ensureLinkedCalls >= 2, 'أُعيد التحقق بعد التراجع');
});

test('USER_SETTLEMENT REVERSE من المصدر (أصله مشمول بالافتتاح): البناء الأمامي بالتقسيم المخزَّن ثم القلب بتاريخ الحذف', async () => {
  const settled = new Date('2026-06-20T09:00:00.000Z');
  const deleted = new Date('2026-10-20T09:00:00.000Z');
  const payload = { userSettlementId: 'U-0', fromUserId: 'u1', fromUserName: 'مستخدم أ', amount: '60.00', method: 'CASH', settledAt: settled.toISOString(), createdAt: settled.toISOString(), sourceCreatedAt: settled.toISOString() };
  // الصف محذوف: المدخلات بلا التوريد (يُعاد من الحمولة) — واستلام نقدي سابق له
  const inputs = { userId: 'u1', refunds: [], delivered: [], received: [{ id: 'S-0', amountMilli: 100_000n, method: 'CASH', at: new Date('2026-06-10T09:00:00Z'), createdAt: new Date('2026-06-10T09:00:00Z'), reversedAt: null }] };
  const s = linkedStore({ userCustody: () => inputs as never });
  s.seedEvents([
    { sourceKey: 'USER_SETTLEMENT:U-0:POST', sourceType: 'USER_SETTLEMENT', sourceId: 'U-0', event: 'POST', effectAt: settled, payload: payload as never, status: 'SKIPPED', skipReason: 'OPENING' },
    { sourceKey: 'USER_SETTLEMENT:U-0:REVERSE', sourceType: 'USER_SETTLEMENT', sourceId: 'U-0', event: 'REVERSE', effectAt: deleted, payload: payload as never },
  ]);
  s.state.events.get('USER_SETTLEMENT:U-0:POST')!.nonCustodyClearedMilli = 0n;
  const out = await postSourceEvent(s, s.settings, s.event('USER_SETTLEMENT:U-0:REVERSE')!);
  assert.equal(out.status, 'DONE');
  const m = s.moves()[0];
  assert.equal(m.date, '2026-10-20');
  assert.deepEqual([linesOn(m, '111004').map((l) => [l.debitMilli, l.adminUserId]), creditOn(m, '111001')], [[[60_000n, 'u1']], 60_000n]);
  assert.equal(s.state.sources.has('USER_SETTLEMENT:U-0:REVERSE'), true, 'مفتاح العكس لا مفتاح POST');
});

test('الحمولة الثابتة: P7 بمستخدم مقروءة من حمولة الحدث، وعكس السند من خارج العهدة يُبنى لا يُعكس بالمرآة', async () => {
  const { store } = await runScenario(3, true, { reconcile: false });
  // دينار بثلاث منازل: 0.700 من الصندوق، و0.400 من عهدة المستخدم
  assert.equal(creditOn(moveOf(store, 'RECEIPT:R-12:REVERSE'), '111001'), 700n);
  assert.equal(moveOf(store, 'RECEIPT:R-12:REVERSE').reversedMoveId, moveOf(store, 'RECEIPT:R-12:POST').id);
  assert.deepEqual(linesOn(moveOf(store, 'RECEIPT:R-11:REVERSE'), '111004').map((l) => [l.creditMilli, l.adminUserId]), [[400n, 'u1']]);
  // بلا مطابقة (reconcile=false) لا partials، والترحيل نفسه كما هو
  assert.equal(store.state.partials.length, 0);
  void t;
});
