// M3 — التصنيف بالنسبة لتاريخ البدء وبوابة الأشقاء (DESIGN.md §5.4، §5.6، §10.1 صف M3: gl-sync-classify.test.ts).
// صرف بلا قاعدة: classifyCutover وsiblingGate وplanEvent والبوابات المساعدة ومفاتيح المصادر.
// «C3 وC4 أخضران» في كل حالة تُثبت في gl-ar-parity/gl-checks بالمُرحِّل؛ هنا تُثبت القرارات التي تبني ذلك.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockedRetry, classifyCutover, compareEventsForPosting, currencyMismatch, decodeEventNote, encodeEventNote, errorRetry,
  initialWatermarkAt, inventoryGate, isIncludedInOpening, isStillActionable, planEvent, settlementOrderReady, siblingGate,
  tombstoneOrigin, type CutoverContext, type EventPlan, type SiblingState,
} from '../services/gl/sync/classify';
import {
  arEntryKey, invoiceKey, invoiceRestockKey, isUnderPostPattern, nextRepostIndex, parseSourceKey, payoutKey, paylinkFeeKey,
  postKeyOf, receiptKey, repostKey, repostRevKey, reverseKeyOf, settlementKey, siblingPostKey, vanLoadKey, whEntryKey,
} from '../services/gl/sync/keys';
import {
  ERROR_BACKOFF_MS, MAX_ERROR_ATTEMPTS, compareCompositeKey, isUniqueViolation, maxCompositeKey,
  type EventStatus, type SkipReason, type SourceEvent, type SourceType,
} from '../services/gl/sync/types';
import { receiptKey as builderReceiptKey } from '../services/gl/builders/receipt';
import { settlementKey as builderSettlementKey } from '../services/gl/builders/custody';
import { arEntryEventKey } from '../services/gl/builders/importEntry';
import { paylinkFeeKey as builderFeeKey, payoutKey as builderPayoutKey } from '../services/gl/builders/paylink';

const TZ = 'Asia/Riyadh';
const T0 = new Date('2027-01-15T09:00:00.000Z');
const C: CutoverContext = {
  cutoverDate: '2027-01-01',
  openingSnapshotAt: T0,
  timezone: TZ,
  initialWatermarkAt: initialWatermarkAt({ method: 'OPENING', cutoverDate: '2027-01-01', openingSnapshotAt: T0, timezone: TZ }),
};
/** ظهر بتوقيت الرياض (09:00Z = 12:00 محلياً) */
const at = (d: string) => new Date(`${d}T09:00:00.000Z`);

// ═══ التصنيف بالنسبة لتاريخ البدء ═══

test('المؤشر الابتدائي: min(بداية اليوم المحلي cutover − 1، T0) للطريقة (أ)، وepoch للطريقة (ب)', () => {
  assert.equal(C.initialWatermarkAt.toISOString(), '2026-12-30T21:00:00.000Z');
  const early = new Date('2026-12-30T10:00:00.000Z');
  assert.equal(initialWatermarkAt({ method: 'OPENING', cutoverDate: '2027-01-01', openingSnapshotAt: early, timezone: TZ }).getTime(), early.getTime());
  assert.equal(initialWatermarkAt({ method: 'FULL_HISTORY', cutoverDate: '2025-01-01', openingSnapshotAt: T0, timezone: TZ }).getTime(), 0);
});

test('مشمول بالافتتاح، لاحق، متأخر بتاريخ سابق، مؤرخ مستقبلاً', () => {
  // مشمول: effectDate < cutover وcreatedAt ≤ T0
  assert.deepEqual(classifyCutover({ effectAt: at('2026-12-20'), createdAt: at('2026-12-20') }, C), { kind: 'OPENING', effectDate: '2026-12-20' });
  // لاحق: بتاريخه
  assert.deepEqual(classifyCutover({ effectAt: at('2027-01-20'), createdAt: at('2027-01-20') }, C), {
    kind: 'POST_AT', date: '2027-01-20', effectDate: '2027-01-20', lateArrival: false, originalDate: null, futureDated: false,
  });
  // متأخر: رفع من وضع عدم الاتصال بتاريخ سابق بعد اللقطة ⇒ تاريخ البدء مع lateArrival
  assert.deepEqual(classifyCutover({ effectAt: at('2026-12-28'), createdAt: at('2027-01-16') }, C), {
    kind: 'POST_AT', date: '2027-01-01', effectDate: '2026-12-28', lateArrival: true, originalDate: '2026-12-28', futureDated: false,
  });
  // مؤرخ مستقبلاً: أُنشئ قبل البدء بتاريخ ≥ البدء ⇒ بتاريخه مع علم الفحص لمرة واحدة
  assert.deepEqual(classifyCutover({ effectAt: at('2027-01-05'), createdAt: at('2026-12-15') }, C), {
    kind: 'POST_AT', date: '2027-01-05', effectDate: '2027-01-05', lateArrival: false, originalDate: null, futureDated: true,
  });
  // حد اليوم بتوقيت الشركة: 2026-12-31T21:30Z = 2027-01-01 00:30 في الرياض ⇒ ليس قبل البدء
  assert.equal(classifyCutover({ effectAt: '2026-12-31T21:30:00.000Z', createdAt: at('2026-12-20') }, C).kind, 'POST_AT');
  assert.equal(classifyCutover({ effectAt: '2026-12-31T20:30:00.000Z', createdAt: at('2026-12-20') }, C).kind, 'OPENING');
  // effectDate صريح يتقدّم
  assert.equal(classifyCutover({ effectAt: at('2027-02-01'), effectDate: '2026-12-01', createdAt: at('2026-12-01') }, C).kind, 'OPENING');
});

test('صف createdAt في (T0, commit] وentryDate < cutover ⇒ POST_AT(cutover) مع lateArrival لا SKIPPED(OPENING)', () => {
  const justAfter = new Date(T0.getTime() + 1);
  assert.deepEqual(classifyCutover({ effectAt: at('2026-12-31'), createdAt: justAfter }, C), {
    kind: 'POST_AT', date: '2027-01-01', effectDate: '2026-12-31', lateArrival: true, originalDate: '2026-12-31', futureDated: false,
  });
  // T0 نفسه ضمن اللقطة (≤)
  assert.equal(classifyCutover({ effectAt: at('2026-12-31'), createdAt: T0 }, C).kind, 'OPENING');
  assert.equal(isIncludedInOpening({ effectAt: at('2026-12-31'), createdAt: T0 }, C), true);
  assert.equal(isIncludedInOpening({ effectAt: at('2026-12-31'), createdAt: justAfter }, C), false);
  // وplanEvent لحدث POST بالصف نفسه ⇒ ترحيل بتاريخ البدء
  const p = planEvent({ sourceType: 'INVOICE', event: 'POST', self: { effectAt: at('2026-12-31'), createdAt: justAfter }, cutover: C });
  assert.equal(p.action, 'POST');
  assert.ok(p.action === 'POST' && p.date === '2027-01-01' && p.lateArrival && p.originalDate === '2026-12-31' && p.mode === 'BUILD');
});

// ═══ بوابة الأشقاء ═══

const SKIPPED = (skipReason: SkipReason): SiblingState => ({ status: 'SKIPPED', skipReason, moveId: null });
const STATE = (status: EventStatus, moveId: string | null = null): SiblingState => ({ status, skipReason: null, moveId });

function expectPost(p: EventPlan, mode: 'BUILD' | 'REVERSE_LIVE' | 'BUILD_FROM_SOURCE', date: string) {
  assert.equal(p.action, 'POST', JSON.stringify(p));
  if (p.action !== 'POST') return;
  assert.equal(p.mode, mode);
  assert.equal(p.date, date);
}

test('فاتورة آجلة ونقدية (صفّان) وسند قبل تاريخ البدء أُلغيت بعد التفعيل ⇒ POST = SKIPPED(OPENING) والعكس مرحّل بتاريخ الإلغاء', () => {
  const cancel = { effectAt: at('2027-02-03'), createdAt: at('2027-02-03') };
  // آجلة: لا حدث POST (لم يقرأه المُطابِق)، الأصل من أقدم صف AccountEntry
  const credit = planEvent({
    sourceType: 'INVOICE', event: 'REVERSE', self: cancel, sibling: null, cutover: C,
    origin: { originEffectAt: at('2026-12-10'), originCreatedAt: at('2026-12-10'), sourceExists: true },
  });
  expectPost(credit, 'BUILD_FROM_SOURCE', '2027-02-03');
  assert.deepEqual(credit.action === 'POST' && credit.siblingWrite, { op: 'INSERT', status: 'SKIPPED', skipReason: 'OPENING' });
  // نقدية بصفّين يختلف createdAt بينهما بالمللي ثانية: الأصل = أقدم صف
  const cash = planEvent({
    sourceType: 'INVOICE', event: 'REVERSE', self: { effectAt: at('2027-02-03'), createdAt: new Date(at('2027-02-03').getTime() + 4) },
    sibling: null, cutover: C,
    origin: { originEffectAt: at('2026-12-11'), originCreatedAt: new Date(at('2026-12-11').getTime() + 3), sourceExists: true },
  });
  expectPost(cash, 'BUILD_FROM_SOURCE', '2027-02-03');
  // السند: بعد أن كُتب الشقيق SKIPPED(OPENING) ⇒ يُبنى من المستند بلا كتابة إضافية
  const receipt = planEvent({ sourceType: 'RECEIPT', event: 'REVERSE', self: cancel, sibling: SKIPPED('OPENING'), cutover: C });
  expectPost(receipt, 'BUILD_FROM_SOURCE', '2027-02-03');
  assert.equal(receipt.action === 'POST' && receipt.siblingWrite, null);
  // POST نفسه لو قرأه المُطابِق (مؤشر متداخل) ⇒ SKIPPED(OPENING) بتصنيفه الذاتي
  assert.deepEqual(
    planEvent({ sourceType: 'INVOICE', event: 'POST', self: { effectAt: at('2026-12-10'), createdAt: at('2026-12-10') }, cutover: C }),
    { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null },
  );
});

test('إلغاء بعد اللقطة لمستند مرحَّل: POST = DONE ⇒ عكس القيد الحيّ، أو DONE بالعكس القائم', () => {
  const self = { effectAt: at('2027-02-10'), createdAt: at('2027-02-10') };
  const live = planEvent({ sourceType: 'INVOICE', event: 'REVERSE', self, sibling: STATE('DONE', 'm1'), live: { liveMoveId: 'm1', existingReversalMoveId: null }, cutover: C });
  expectPost(live, 'REVERSE_LIVE', '2027-02-10');
  assert.equal(live.action === 'POST' && live.liveMoveId, 'm1');
  assert.deepEqual(
    planEvent({ sourceType: 'INVOICE', event: 'REVERSE', self, sibling: STATE('DONE', 'm1'), live: { liveMoveId: null, existingReversalMoveId: 'r1' }, cutover: C }),
    { action: 'DONE_EXISTING', moveId: 'r1' },
  );
  assert.deepEqual(
    siblingGate({ sourceType: 'INVOICE', event: 'REVERSE', sibling: STATE('DONE', 'm1'), live: { liveMoveId: null, existingReversalMoveId: null }, cutover: C }),
    { action: 'ERROR', error: 'LIVE_MOVE_NOT_FOUND' },
  );
  // إلغاء متأخر الوصول بتاريخ قبل البدء لمستند لاحق (نادر) ⇒ تاريخ البدء
  const late = planEvent({ sourceType: 'RECEIPT', event: 'REVERSE', self: { effectAt: at('2026-12-30'), createdAt: at('2027-02-01') }, sibling: STATE('DONE'), live: { liveMoveId: 'm2', existingReversalMoveId: null }, cutover: C });
  assert.ok(late.action === 'POST' && late.date === '2027-01-01' && late.lateArrival);
});

test('استلام settledAt < cutover حُذف بعد التفعيل ⇒ POST = SKIPPED(OPENING) والعكس مرحّل من الحمولة', () => {
  const payload = { settlementId: 's1', amount: '500', method: 'CASH', salesRepId: 'r1', settledAt: at('2026-12-20').toISOString(), createdAt: at('2026-12-20').toISOString() };
  const origin = tombstoneOrigin('SETTLEMENT', payload);
  assert.ok(origin && origin.sourceExists === false);
  // الـtombstone كتب المفتاحين PENDING. POST يُعالج أولاً (effectAt أبكر): تصنيفه الذاتي مشمول ⇒ SKIPPED(OPENING)
  assert.deepEqual(
    planEvent({ sourceType: 'SETTLEMENT', event: 'POST', self: { effectAt: payload.settledAt, createdAt: payload.createdAt }, sibling: STATE('PENDING'), sourceExists: false, cutover: C }),
    { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null },
  );
  const del = { effectAt: at('2027-02-05'), createdAt: at('2027-02-05') };
  expectPost(planEvent({ sourceType: 'SETTLEMENT', event: 'REVERSE', self: del, sibling: SKIPPED('OPENING'), origin, cutover: C }), 'BUILD_FROM_SOURCE', '2027-02-05');
  // ولو عولج REVERSE والشقيق ما زال PENDING (ترتيب معكوس) ⇒ تحديث الشقيق SKIPPED(OPENING) والبناء من الحمولة
  const rev = planEvent({ sourceType: 'SETTLEMENT', event: 'REVERSE', self: del, sibling: STATE('PENDING'), origin, cutover: C });
  expectPost(rev, 'BUILD_FROM_SOURCE', '2027-02-05');
  assert.deepEqual(rev.action === 'POST' && rev.siblingWrite, { op: 'UPDATE', status: 'SKIPPED', skipReason: 'OPENING' });
});

test('استلام أُنشئ وحُذف في نبضة واحدة، أو أثناء إطفاء العَلَم ثم أُعيد تشغيله ⇒ الحدثان SKIPPED', () => {
  const created = at('2027-03-01').toISOString();
  const payload = { settlementId: 's2', amount: '200', method: 'CASH', salesRepId: 'r1', settledAt: created, createdAt: created };
  const origin = tombstoneOrigin('SETTLEMENT', payload)!;
  const self = { effectAt: created, createdAt: created };
  // POST أولاً: شقيق REVERSE موجود والمصدر محذوف ⇒ NETTED للاثنين
  const post = planEvent({ sourceType: 'SETTLEMENT', event: 'POST', self, sibling: STATE('PENDING'), sourceExists: false, cutover: C });
  assert.deepEqual(post, { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } });
  // REVERSE بعدها: الشقيق SKIPPED(NETTED) ⇒ SKIPPED(NETTED) لا يُبنى من المستند
  assert.deepEqual(
    planEvent({ sourceType: 'SETTLEMENT', event: 'REVERSE', self: { effectAt: at('2027-03-01'), createdAt: at('2027-03-01') }, sibling: SKIPPED('NETTED'), origin, cutover: C }),
    { action: 'SKIP', skipReason: 'NETTED', siblingWrite: null },
  );
  // الترتيب المعكوس (REVERSE أولاً، POST PENDING أو ERROR أو HELD أو BLOCKED) ⇒ النتيجة نفسها
  for (const s of ['PENDING', 'ERROR', 'HELD', 'BLOCKED'] as EventStatus[]) {
    assert.deepEqual(
      planEvent({ sourceType: 'SETTLEMENT', event: 'REVERSE', self, sibling: STATE(s), origin, cutover: C }),
      { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } },
      s,
    );
  }
  // لا POST إطلاقاً والمصدر محذوف (ج) ⇒ إدراج SKIPPED(NEVER_MATERIALIZED) وإعادة الفحص ⇒ SKIPPED
  const c = planEvent({ sourceType: 'SETTLEMENT', event: 'REVERSE', self, sibling: null, origin, cutover: C });
  assert.deepEqual(c, { action: 'INSERT_SIBLING_AND_RECHECK', siblingWrite: { op: 'INSERT', status: 'SKIPPED', skipReason: 'NEVER_MATERIALIZED' } });
  assert.deepEqual(
    planEvent({ sourceType: 'SETTLEMENT', event: 'REVERSE', self, sibling: SKIPPED('NEVER_MATERIALIZED'), origin, cutover: C }),
    { action: 'SKIP', skipReason: 'NEVER_MATERIALIZED', siblingWrite: null },
  );
  // ولو سبقه المُطابِق بـPOST قائم (المصدر موجود فعلاً) ⇒ القاعدة العادية: BLOCKED حتى يُرحَّل POST
  assert.deepEqual(
    siblingGate({ sourceType: 'INVOICE', event: 'REVERSE', sibling: STATE('PENDING'), origin: { ...origin, sourceExists: true }, cutover: C }),
    { action: 'BLOCK', reason: 'SIBLING_NOT_FINAL', siblingWrite: null },
  );
});

test('استيراد مشمول بالافتتاح تُراجع عنه بعد التفعيل ⇒ العكس مرحّل؛ واستيراد بعد التفعيل تُراجع عنه قبل المُطابِق ⇒ الحدثان SKIPPED', () => {
  const opening = {
    entryId: 'e1', customerId: 'c1', customerName: 'عميل', debit: '300', credit: '0', description: 'رصيد',
    entryDate: at('2026-11-30').toISOString(), createdAt: at('2026-12-01').toISOString(),
  };
  const o1 = tombstoneOrigin('AR_ENTRY', opening)!;
  assert.deepEqual(
    planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self: { effectAt: opening.entryDate, createdAt: opening.createdAt }, sibling: STATE('PENDING'), sourceExists: false, cutover: C }),
    { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null },
  );
  expectPost(
    planEvent({ sourceType: 'AR_ENTRY', event: 'REVERSE', self: { effectAt: at('2027-02-02'), createdAt: at('2027-02-02') }, sibling: SKIPPED('OPENING'), origin: o1, cutover: C }),
    'BUILD_FROM_SOURCE', '2027-02-02',
  );

  const later = { ...opening, entryId: 'e2', entryDate: at('2027-02-01').toISOString(), createdAt: at('2027-02-01').toISOString() };
  const o2 = tombstoneOrigin('AR_ENTRY', later)!;
  assert.deepEqual(
    planEvent({ sourceType: 'AR_ENTRY', event: 'POST', self: { effectAt: later.entryDate, createdAt: later.createdAt }, sibling: STATE('PENDING'), sourceExists: false, cutover: C }),
    { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } },
  );
  assert.deepEqual(
    planEvent({ sourceType: 'AR_ENTRY', event: 'REVERSE', self: { effectAt: at('2027-02-01'), createdAt: at('2027-02-01') }, sibling: STATE('PENDING'), origin: o2, cutover: C }),
    { action: 'SKIP', skipReason: 'NETTED', siblingWrite: { op: 'UPDATE', status: 'SKIPPED', skipReason: 'NETTED' } },
  );
  // استيراد بتاريخ ماضٍ بعد اللقطة تُراجع عنه قبل المُطابِق: غير مشمول ⇒ NETTED (لا عكس لما لم يُرحَّل)
  const back = { ...opening, entryId: 'e3', entryDate: at('2026-11-15').toISOString(), createdAt: at('2027-02-01').toISOString() };
  assert.equal(planEvent({ sourceType: 'AR_ENTRY', event: 'REVERSE', self: { effectAt: at('2027-02-01'), createdAt: at('2027-02-01') }, sibling: STATE('PENDING'), origin: tombstoneOrigin('AR_ENTRY', back), cutover: C }).action, 'SKIP');
  // حمولة ناقصة ⇒ لا أصل
  assert.equal(tombstoneOrigin('AR_ENTRY', { entryId: 'x' }), null);
  assert.equal(tombstoneOrigin('INVOICE', opening), null);
});

test('بوابة الأشقاء: SKIPPED(NETTED|MANUAL|NEVER_MATERIALIZED) لا يُبنى، وZERO_VALUE لا يحبس العكس ولا COGS، وBLOCKED للمصدر القائم', () => {
  for (const r of ['NETTED', 'MANUAL', 'NEVER_MATERIALIZED'] as SkipReason[]) {
    assert.deepEqual(siblingGate({ sourceType: 'INVOICE', event: 'REVERSE', sibling: SKIPPED(r), cutover: C }), { action: 'SKIP', skipReason: r, siblingWrite: null });
    assert.deepEqual(siblingGate({ sourceType: 'INVOICE', event: 'COGS', sibling: SKIPPED(r), cutover: C }), { action: 'SKIP', skipReason: r, siblingWrite: null });
  }
  assert.deepEqual(siblingGate({ sourceType: 'INVOICE', event: 'REVERSE', sibling: SKIPPED('ZERO_VALUE'), cutover: C }), { action: 'SKIP', skipReason: 'ZERO_VALUE', siblingWrite: null });
  assert.deepEqual(siblingGate({ sourceType: 'INVOICE', event: 'COGS', sibling: SKIPPED('ZERO_VALUE'), cutover: C }), { action: 'PROCEED' });
  assert.deepEqual(siblingGate({ sourceType: 'INVOICE', event: 'RESTOCK', sibling: STATE('DONE', 'm'), cutover: C }), { action: 'PROCEED' });
  assert.deepEqual(siblingGate({ sourceType: 'INVOICE', event: 'COGS', sibling: SKIPPED('OPENING'), cutover: C }), { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null });
  for (const s of ['PENDING', 'BLOCKED', 'ERROR', 'HELD'] as EventStatus[]) {
    assert.deepEqual(siblingGate({ sourceType: 'RECEIPT', event: 'REVERSE', sibling: STATE(s), cutover: C }), { action: 'BLOCK', reason: 'SIBLING_NOT_FINAL', siblingWrite: null });
  }
  // (ب) لا POST والمصدر قائم غير مشمول: أقدم من المؤشر الابتدائي ⇒ شقيق PENDING، وإلا BLOCKED حتى يلتقطه المُطابِق
  const future = siblingGate({
    sourceType: 'INVOICE', event: 'REVERSE', sibling: null, cutover: C,
    origin: { originEffectAt: at('2027-01-10'), originCreatedAt: at('2026-12-01'), sourceExists: true },
  });
  assert.deepEqual(future, { action: 'BLOCK', reason: 'AWAITING_RECONCILER', siblingWrite: { op: 'INSERT', status: 'PENDING' } });
  const fresh = siblingGate({
    sourceType: 'INVOICE', event: 'REVERSE', sibling: null, cutover: C,
    origin: { originEffectAt: at('2027-02-01'), originCreatedAt: at('2027-02-01'), sourceExists: true },
  });
  assert.deepEqual(fresh, { action: 'BLOCK', reason: 'AWAITING_RECONCILER', siblingWrite: null });
  assert.deepEqual(siblingGate({ sourceType: 'INVOICE', event: 'REVERSE', sibling: null, cutover: C }), { action: 'BLOCK', reason: 'AWAITING_RECONCILER', siblingWrite: null });
  // حدث عكس مشمول بنفسه في الافتتاح ⇒ SKIPPED(OPENING) دون البوابة
  assert.deepEqual(
    planEvent({ sourceType: 'INVOICE', event: 'REVERSE', self: { effectAt: at('2026-12-15'), createdAt: at('2026-12-15') }, sibling: null, cutover: C }),
    { action: 'SKIP', skipReason: 'OPENING', siblingWrite: null },
  );
});

// ═══ السباق: tombstone يكتب شقيقي استلام بينما المُرحِّل يرحّل POST ═══

type Ev = { key: string; type: SourceType; event: SourceEvent; status: EventStatus; skipReason: SkipReason | null; moveId: string | null };

function simulate(order: 'POSTER_FIRST' | 'TOMBSTONE_FIRST') {
  const created = at('2027-03-05').toISOString();
  const payload = { settlementId: 's9', amount: '100', method: 'CASH', salesRepId: 'r1', settledAt: created, createdAt: created };
  const events = new Map<string, Ev>();
  const moves: { id: string; reverses: string | null }[] = [];
  let sourceExists = true;
  const pk = settlementKey('s9', 'POST');
  const rk = settlementKey('s9', 'REVERSE');
  // المُطابِق قرأ الاستلام قبل حذفه
  events.set(pk, { key: pk, type: 'SETTLEMENT', event: 'POST', status: 'PENDING', skipReason: null, moveId: null });

  const tombstone = () => {
    sourceExists = false;
    for (const [key, event] of [[pk, 'POST'], [rk, 'REVERSE']] as const) {
      if (!events.has(key)) events.set(key, { key, type: 'SETTLEMENT', event, status: 'PENDING', skipReason: null, moveId: null }); // skipDuplicates
    }
  };
  const apply = (target: string, w: { op: string; status: string; skipReason?: SkipReason }) => {
    const e = events.get(target)!;
    if (w.op === 'UPDATE' && isStillActionable(e.status)) { e.status = w.status as EventStatus; e.skipReason = w.skipReason ?? null; }
  };
  /** معالجة حدث تحت القفل: إعادة القراءة ثم planEvent ثم الكتابة */
  const processUnderLock = (key: string) => {
    const e = events.get(key);
    if (!e || !isStillActionable(e.status)) return;
    const other = events.get(e.event === 'POST' ? rk : pk) ?? null;
    const live = moves.find((m) => m.reverses === null && !moves.some((r) => r.reverses === m.id));
    const plan = planEvent({
      sourceType: 'SETTLEMENT', event: e.event, self: { effectAt: e.event === 'POST' ? created : at('2027-03-05'), createdAt: created },
      sibling: other ? { status: other.status, skipReason: other.skipReason, moveId: other.moveId } : null,
      sourceExists: e.event === 'POST' ? sourceExists : undefined,
      live: { liveMoveId: live?.id ?? null, existingReversalMoveId: null },
      origin: tombstoneOrigin('SETTLEMENT', payload), cutover: C,
    });
    if (plan.action === 'POST') {
      const id = `m${moves.length + 1}`;
      moves.push({ id, reverses: plan.mode === 'REVERSE_LIVE' ? plan.liveMoveId : null });
      e.status = 'DONE'; e.moveId = id;
    } else if (plan.action === 'SKIP') {
      e.status = 'SKIPPED'; e.skipReason = plan.skipReason;
      if (plan.siblingWrite) apply(e.event === 'POST' ? rk : pk, plan.siblingWrite);
    } else {
      assert.fail(`قرار غير متوقع: ${JSON.stringify(plan)}`);
    }
  };

  if (order === 'POSTER_FIRST') { processUnderLock(pk); tombstone(); }
  else { tombstone(); processUnderLock(pk); }
  processUnderLock(rk);
  processUnderLock(pk); // إعادة تشغيل النبضة: لا أثر
  return { events, moves };
}

test('سباق: tombstone والمُرحِّل على POST نفسه ⇒ نتيجة واحدة متسقة (DONE ثم عكس مرحّل، أو الحدثان SKIPPED(NETTED))', () => {
  const a = simulate('POSTER_FIRST');
  assert.deepEqual([...a.events.values()].map((e) => [e.event, e.status, e.skipReason]), [['POST', 'DONE', null], ['REVERSE', 'DONE', null]]);
  assert.deepEqual(a.moves, [{ id: 'm1', reverses: null }, { id: 'm2', reverses: 'm1' }]);

  const b = simulate('TOMBSTONE_FIRST');
  assert.deepEqual([...b.events.values()].map((e) => [e.event, e.status, e.skipReason]), [['POST', 'SKIPPED', 'NETTED'], ['REVERSE', 'SKIPPED', 'NETTED']]);
  assert.deepEqual(b.moves, []);
});

// ═══ بوابات مساعدة ═══

test('العملة والمخزون وترتيب P7 وترتيب المعالجة', () => {
  assert.equal(currencyMismatch('INVOICE', 'SAR', 'USD'), true);
  assert.equal(currencyMismatch('INVOICE', 'SAR', 'sar'), false);
  assert.equal(currencyMismatch('INVOICE', 'SAR', null), false);
  assert.equal(currencyMismatch('WH_ENTRY', 'SAR', 'USD'), false);

  const inv = { sourceType: 'INVOICE' as SourceType, event: 'COGS' as SourceEvent, effectAt: at('2027-02-01'), sourceKey: invoiceKey('i1', 'COGS') };
  assert.equal(inventoryGate({ ...inv, event: 'POST' }, null), null, 'ليس حدث مخزون');
  assert.equal(inventoryGate(inv, null), 'INVENTORY_HORIZON');
  assert.equal(inventoryGate(inv, at('2027-01-31')), 'INVENTORY_HORIZON');
  assert.equal(inventoryGate(inv, at('2027-02-01')), null);
  assert.equal(inventoryGate(inv, at('2027-03-01'), { effectAt: at('2027-01-20'), sourceKey: 'WH_ENTRY:w0' }), 'INVENTORY_HEAD_OF_LINE');

  const wm = (d: Date) => ({ at: d, id: 'z' });
  const s = { settlementCreatedAt: at('2027-02-01'), settledAt: at('2027-02-01') };
  assert.equal(settlementOrderReady({ ...s, accountEntryWatermark: null, repReceiptEvents: [] }), false);
  assert.equal(settlementOrderReady({ ...s, accountEntryWatermark: wm(at('2027-02-01')), repReceiptEvents: [] }), false, 'يتجاوز لا يساوي');
  assert.equal(settlementOrderReady({ ...s, accountEntryWatermark: wm(at('2027-02-02')), repReceiptEvents: [] }), true);
  assert.equal(settlementOrderReady({ ...s, accountEntryWatermark: wm(at('2027-02-02')), repReceiptEvents: [{ status: 'BLOCKED', effectAt: at('2027-01-31') }] }), false);
  assert.equal(settlementOrderReady({ ...s, accountEntryWatermark: wm(at('2027-02-02')), repReceiptEvents: [{ status: 'PENDING', effectAt: at('2027-02-03') }, { status: 'HELD', effectAt: at('2027-01-01') }] }), true);

  const evs = [
    { effectAt: at('2027-02-01'), event: 'REVERSE' as SourceEvent, sourceKey: 'INVOICE:a:REVERSE' },
    { effectAt: at('2027-02-01'), event: 'POST' as SourceEvent, sourceKey: 'INVOICE:b:POST' },
    { effectAt: at('2027-02-01'), event: 'COGS' as SourceEvent, sourceKey: 'INVOICE:b:COGS' },
    { effectAt: at('2027-01-01'), event: 'REVERSE' as SourceEvent, sourceKey: 'RECEIPT:z:REVERSE' },
    { effectAt: at('2027-02-01'), event: 'POST' as SourceEvent, sourceKey: 'INVOICE:a:POST' },
  ];
  assert.deepEqual(evs.sort(compareEventsForPosting).map((e) => e.sourceKey),
    ['RECEIPT:z:REVERSE', 'INVOICE:a:POST', 'INVOICE:b:POST', 'INVOICE:b:COGS', 'INVOICE:a:REVERSE']);
});

test('التراجع وملاحظات الحالة ومقارنة المؤشر وأخطاء P2002', () => {
  const now = new Date('2027-01-01T00:00:00Z');
  const r1 = errorRetry(0, now);
  assert.deepEqual([r1.attempts, r1.nextAttemptAt!.getTime() - now.getTime()], [1, ERROR_BACKOFF_MS[0]]);
  assert.equal(errorRetry(3, now).nextAttemptAt!.getTime() - now.getTime(), 2 * 60 * 60_000);
  assert.deepEqual(errorRetry(MAX_ERROR_ATTEMPTS - 1, now), { attempts: MAX_ERROR_ATTEMPTS, nextAttemptAt: null });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => blockedRetry(i === 0 ? null : i - 1, now).nextAttemptAt.getTime() - now.getTime()),
    [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 2 * 60 * 60_000]);

  for (const n of [
    { kind: 'HELD', reason: 'UNEXPECTED_ENTRY_SHAPE', detail: 'RECEIPT_CREDIT على فاتورة CREDIT' },
    { kind: 'HELD', reason: 'CURRENCY_MISMATCH', detail: null },
    { kind: 'BLOCKED', reason: 'SIBLING_NOT_FINAL', step: 2, detail: null },
    { kind: 'PENDING', reason: 'INVENTORY_HORIZON' },
    { kind: 'ERROR', message: 'P2002 on number' },
  ] as const) {
    assert.deepEqual(decodeEventNote(encodeEventNote(n)), n);
  }
  assert.equal(decodeEventNote(null), null);

  const a = { at: new Date(1000), id: 'b' };
  assert.equal(compareCompositeKey(a, { at: new Date(1000), id: 'a' }), 1);
  assert.equal(compareCompositeKey(a, { at: new Date(999), id: 'z' }), 1);
  assert.equal(maxCompositeKey(a, { at: new Date(1000), id: 'c' }).id, 'c');
  assert.equal(maxCompositeKey(a, { at: new Date(1000), id: 'a' }).id, 'b', 'لا يتراجع');

  assert.equal(isUniqueViolation({ code: 'P2002', meta: { target: ['tenantId', 'sourceKey'] } }, ['tenantId', 'sourceKey']), true);
  assert.equal(isUniqueViolation({ code: 'P2002', meta: { target: ['sourceKey', 'tenantId'] } }, ['tenantId', 'sourceKey']), true);
  assert.equal(isUniqueViolation({ code: 'P2002', meta: { target: ['tenantId', 'number'] } }, ['tenantId', 'sourceKey']), false);
  assert.equal(isUniqueViolation({ code: 'P2002', meta: { target: 'gl_move_sources_tenantId_sourceKey_key' } }, ['tenantId', 'sourceKey']), true);
  assert.equal(isUniqueViolation({ code: 'P2003' }), false);
});

// ═══ المفاتيح ═══

test('مفاتيح المصادر: مطابقة الـbuilders، والتحليل، والشقيق، وREPOST', () => {
  assert.equal(receiptKey('r', 'POST'), builderReceiptKey('r', 'POST'));
  assert.equal(settlementKey('s', 'REVERSE'), builderSettlementKey('s', 'REVERSE'));
  assert.equal(arEntryKey('e'), arEntryEventKey('e'));
  assert.equal(arEntryKey('e', 'REVERSE'), arEntryEventKey('e', 'REVERSE'));
  assert.equal(paylinkFeeKey('f'), builderFeeKey('f'));
  assert.equal(payoutKey('p'), builderPayoutKey('p'));

  assert.equal(invoiceKey('i', 'POST'), 'INVOICE:i:POST');
  assert.equal(invoiceRestockKey('i', 2), 'INVOICE:i:RESTOCK:2');
  assert.equal(whEntryKey('w'), 'WH_ENTRY:w');
  assert.equal(vanLoadKey('v'), 'VAN_LOAD:v:POST');
  assert.equal(postKeyOf('PAYOUT', 'p'), 'PAYOUT:p');
  assert.equal(reverseKeyOf('PAYOUT', 'p'), null);
  assert.equal(reverseKeyOf('AR_ENTRY', 'e'), 'AR_ENTRY:e:REVERSE');

  const id = '3f1c2a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b';
  assert.deepEqual(parseSourceKey(`INVOICE:${id}:REVERSE`), { sourceType: 'INVOICE', sourceId: id, event: 'REVERSE', baseKey: `INVOICE:${id}:POST`, repost: null, generation: null });
  assert.deepEqual(parseSourceKey(`AR_ENTRY:${id}:POST:REPOST:3`), { sourceType: 'AR_ENTRY', sourceId: id, event: 'POST', baseKey: `AR_ENTRY:${id}:POST`, repost: { kind: 'REPOST', n: 3 }, generation: null });
  assert.equal(parseSourceKey(`PAYLINK_FEE:${id}:REPOST_REV:1`)?.event, 'REVERSE');
  assert.equal(parseSourceKey(`INVOICE:${id}:RESTOCK:0`)?.generation, 0);
  assert.equal(parseSourceKey(`INVOICE:${id}:COGS`)?.baseKey, `INVOICE:${id}:POST`);
  assert.equal(parseSourceKey(`CUSTODY_SHORTAGE:${id}:POST`)?.sourceType, 'CUSTODY_SHORTAGE');
  for (const bad of ['INVOICE:x', 'INVOICE::POST', 'FOO:x:POST', 'INVOICE:x:POST:REPOST:0', 'RECEIPT:x:COGS']) assert.equal(parseSourceKey(bad), null, bad);

  assert.equal(siblingPostKey(`RECEIPT:${id}:REVERSE`), `RECEIPT:${id}:POST`);
  assert.equal(siblingPostKey(`INVOICE:${id}:RESTOCK:4`), `INVOICE:${id}:POST`);
  assert.equal(siblingPostKey(`INVOICE:${id}:POST`), null);

  const base = invoiceKey(id, 'POST');
  assert.equal(repostKey(base, 1), `${base}:REPOST:1`);
  assert.equal(repostRevKey(base, 1), `${base}:REPOST_REV:1`);
  assert.equal(nextRepostIndex([base, repostRevKey(base, 1), repostKey(base, 1), invoiceKey(id, 'REVERSE')], base), 2);
  assert.equal(isUnderPostPattern(repostRevKey(base, 1), base), true);
  assert.equal(isUnderPostPattern(invoiceKey(id, 'REVERSE'), base), false);
  assert.equal(isUnderPostPattern(`${base}X`, base), false);
});
