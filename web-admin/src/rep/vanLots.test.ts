// «تتبّع اللوط» في تطبيق المندوب (W6، §٦.٣ و§٧): المتاح المحلي من لقطة السيارة، والمعلّق عليها، وتلميح التوزيع دون اتصال،
// ووسم «بانتظار الإدارة» — منطقٌ صرف (rep/vanLots.ts) وحرّاسٌ نصّية على مواضعه في التطبيق والصندوق.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOT_REPLAY_HELD_CODE, UNKNOWN_LOT_KEY, VANLOTS_KEY, VANLOTS_POSTED_KEY, VANLOTS_POSTED_MAX,
  addPending, capLineQty, cartBaseOf, cartHints, fitLineQty, hintDocLots, isVanLotSnapshot, localAvailable, localHint, localLotView,
  matchServerItemLots, offlineLotPlan, pendingOut, postedItemsFromServer, postedListOf, prunePosted, sellableLots, storedVanLotsOf,
  trackedIds, underLotReplayHeld, validLotRefs, vanLotsEntry, withPosted, withSentAt,
  type PendingOut, type PostedEntry, type SnapLot,
} from './vanLots';
import { CUTOVER_REVIEW_CODE, REVIEW_RECHECK_MS, reviewRecheckDue } from './outboxReview';
import type { OutboxDoc } from './offlineDb';
import { LOT_EPS, roundLot, type VanLotSnapshotDto } from '../lib/lots';

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const TODAY = '2026-11-10';
const FETCHED = Date.parse('2026-11-10T08:00:00.000Z');
const ME = 'rep-1';

const lot = (lotId: string, usable: number, over: Partial<SnapLot> = {}): SnapLot =>
  ({ lotId, lotNumber: lotId.toUpperCase(), expiryDate: '2026-12-31', status: 'ACTIVE', blockKind: null, usable, ...over });

/** لقطة: صنف P بثلاث تشغيلات بترتيب FEFO كما يرسلها الخادم (A ينتهي أولاً)، وغير مسمّى 2 */
function snapOf(over: Partial<VanLotSnapshotDto> = {}, products?: VanLotSnapshotDto['products']): VanLotSnapshotDto {
  return {
    serverTime: '2026-11-10T08:00:01.000Z', day: TODAY, tracked: ['P', 'Q', 'Z'], allowUnknown: true,
    products: products ?? [{
      productId: 'P', available: 17, availableNamed: 15, unknownUsable: 2, quarantined: 0, held: 0, expiredUnsold: 0, expiredReturned: 0, damaged: 0,
      lots: [lot('a', 5, { expiryDate: '2026-11-20' }), lot('b', 10, { expiryDate: '2026-12-31' })],
    }],
    ...over,
  };
}
const invoiceDoc = (over: Partial<OutboxDoc> & { items?: unknown[]; type?: string } = {}): OutboxDoc => {
  const { items, type, ...rest } = over;
  return {
    clientRef: `c-${Math.random()}`, repId: ME, kind: 'invoice', status: 'queued', clientCreatedAt: '2026-11-10T09:00:00.000Z',
    payload: { type: type ?? 'CASH', items: items ?? [{ productId: 'P', qty: 3 }] }, ...rest,
  };
};
const none: PendingOut = new Map();
const pend = (docs: OutboxDoc[], posted: PostedEntry[] = []) => pendingOut(docs, posted, FETCHED, ME);

// ─── اللقطة ───

test('المتاح بلا معلّق في يوم الخادم = available الخادم (Σ المؤهَّل + غير المسمّى)، ويوم الانتهاء نفسه صالح', () => {
  const s = snapOf();
  assert.equal(localAvailable(s, 'P', TODAY, none), 17);
  assert.equal(localAvailable(s, 'P', TODAY, none), s.products[0].available);
  assert.equal(localAvailable(s, 'P', '2026-11-20', none), 17, 'يوم الانتهاء آخر يوم صالح');
  assert.equal(localAvailable(s, 'P', '2026-11-21', none), 12, 'بعده تخرج التشغيلة a');
  assert.deepEqual(sellableLots(s, 'P', '2026-11-21').map((l) => l.lotId), ['b']);
});

test('الموقوف مستبعد، والمتتبَّع الغائب عن products متاحه صفر، وallowUnknown يحكم غير المسمّى', () => {
  const blocked = snapOf({}, [{ ...snapOf().products[0], lots: [lot('a', 5, { status: 'BLOCKED', blockKind: 'RECALL' }), lot('b', 10)] }]);
  assert.equal(localAvailable(blocked, 'P', TODAY, none), 12);
  assert.deepEqual(sellableLots(blocked, 'P', TODAY).map((l) => l.lotId), ['b']);
  assert.equal(localAvailable(snapOf(), 'Q', TODAY, none), 0, 'متتبَّع بلا رصيد');
  assert.equal(localAvailable(snapOf({ allowUnknown: false }), 'P', TODAY, none), 15);
  const v = localLotView(blocked, 'P', TODAY, none);
  assert.deepEqual(v.lots.map((x) => [x.lot.lotId, x.left, x.sellable]), [['a', 5, false], ['b', 10, true]]);
});

test('قائمة tracked هي المرجع، وبلا لقطة علم الصنف في الكتالوج', () => {
  assert.deepEqual([...trackedIds(snapOf(), [{ id: 'X', lotTracked: true }])].sort(), ['P', 'Q', 'Z']);
  assert.deepEqual([...trackedIds(null, [{ id: 'X', lotTracked: true }, { id: 'Y', lotTracked: false }, { id: 'W' }])], ['X']);
});

test('شكل اللقطة وسجلّها: المخالف مرفوض كله، والسجلّ لصاحب الجلسة وحده بختم بدء الطلب', () => {
  assert.equal(isVanLotSnapshot(snapOf()), true);
  assert.equal(isVanLotSnapshot({ ...snapOf(), tracked: 'P' }), false);
  assert.equal(isVanLotSnapshot({ ...snapOf(), allowUnknown: 1 }), false);
  assert.equal(isVanLotSnapshot(snapOf({}, [{ ...snapOf().products[0], lots: [{ ...lot('a', 1), status: 'GONE' as never }] }])), false);
  assert.equal(isVanLotSnapshot(snapOf({}, [{ ...snapOf().products[0], unknownUsable: Number.NaN }])), false);
  const e = vanLotsEntry(snapOf(), ME, FETCHED);
  assert.ok(e);
  assert.deepEqual(e, { v: 1, repId: ME, fetchedAt: FETCHED, snap: snapOf() });
  assert.equal(vanLotsEntry({ bad: true }, ME, FETCHED), null);
  assert.equal(vanLotsEntry(snapOf(), undefined, FETCHED), null);
  assert.deepEqual(storedVanLotsOf(e, ME), e);
  assert.equal(storedVanLotsOf(e, 'rep-2'), null, 'جهازٌ مشترك: لقطة الزميل لا تُقرأ');
  assert.equal(storedVanLotsOf(e, undefined), null);
  assert.equal(storedVanLotsOf({ ...e, v: 2 }, ME), null);
  assert.equal(VANLOTS_KEY, 'vanlots');
  assert.equal(VANLOTS_POSTED_KEY, 'vanlots:posted');
});

// ─── المعلّق ───

test('المرتجع المعلّق لا يزيد، والمنتظر والمرفوض والموسوم بالمراجعة يُطرحون', () => {
  const s = snapOf();
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ type: 'RETURN', items: [{ productId: 'P', qty: 50 }] })])), 17);
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({})])), 14, 'منتظر');
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ status: 'rejected' })])), 14, 'مرفوض: الورقة سُلّمت');
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ reviewCode: LOT_REPLAY_HELD_CODE })])), 14, 'بانتظار الإدارة');
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ reviewCode: CUTOVER_REVIEW_CODE })])), 14, 'مراجعة الفوترة');
});

test('المرسَل قبل بدء جلب اللقطة لا يُطرح (تعرفه)، وبعده يُطرح، وبلا ختمٍ لا يُطرح', () => {
  const s = snapOf();
  const before = invoiceDoc({ status: 'sent', sentAt: new Date(FETCHED - 1).toISOString() });
  const at = invoiceDoc({ status: 'sent', sentAt: new Date(FETCHED).toISOString() });
  const after = invoiceDoc({ status: 'sent', sentAt: new Date(FETCHED + 60_000).toISOString() });
  assert.equal(localAvailable(s, 'P', TODAY, pend([before])), 17);
  assert.equal(localAvailable(s, 'P', TODAY, pend([at])), 14);
  assert.equal(localAvailable(s, 'P', TODAY, pend([after])), 14);
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ status: 'sent' })])), 17, 'مرسَلٌ قديم بلا sentAt');
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ status: 'sent', sentAt: 'x' })])), 17);
});

test('مستندات صاحب الجلسة وحدها (والقديمة بلا repId له)، والفواتير وحدها، والكمية بوحدة الأساس', () => {
  const s = snapOf();
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ repId: 'rep-2' })])), 17, 'صفّ الزميل');
  assert.equal(localAvailable(s, 'P', TODAY, pend([invoiceDoc({ repId: undefined })])), 14);
  assert.equal(localAvailable(s, 'P', TODAY, pend([{ ...invoiceDoc({}), kind: 'receipt' }])), 17);
  const carton = pend([invoiceDoc({ items: [{ productId: 'P', qty: 2, unitFactor: 6 }] })]);
  assert.equal(carton.get('P')?.total, 12);
  assert.equal(localAvailable(s, 'P', TODAY, carton), 5);
});

test('التلميح يُطرح من تشغيلاته (ولو صارت موقوفة: الخادم يلتزم به)، وما بلا تلميح بـFEFO ثم غير المسمّى', () => {
  const s = snapOf({}, [{ ...snapOf().products[0], lots: [lot('a', 5), lot('b', 10, { status: 'BLOCKED', blockKind: 'HOLD' })] }]);
  // تلميحٌ على الموقوف b: لا يمسّ المتاح (a 5 + غير المسمّى 2)
  const onB = pend([invoiceDoc({ items: [{ productId: 'P', qty: 4, lots: [{ lotId: 'b', qty: 4 }] }] })]);
  assert.deepEqual([...onB.get('P')!.byLot], [['b', 4]]);
  assert.equal(localAvailable(s, 'P', TODAY, onB), 7);
  // بلا تلميح: FEFO من المؤهَّل a ثم غير المسمّى
  const v = localLotView(snapOf(), 'P', TODAY, pend([invoiceDoc({ items: [{ productId: 'P', qty: 16 }] })]));
  assert.deepEqual(v.lots.map((x) => x.left), [0, 0]);
  assert.equal(v.unknownLeft, 1);
  assert.equal(v.available, 1);
  // تلميح الفارغ يُطرح من غير المسمّى
  const unk = pend([invoiceDoc({ items: [{ productId: 'P', qty: 2, lots: [{ lotId: null, qty: 2 }] }] })]);
  assert.deepEqual([...unk.get('P')!.byLot], [[UNKNOWN_LOT_KEY, 2]]);
  assert.equal(localLotView(snapOf(), 'P', TODAY, unk).unknownLeft, 0);
  assert.equal(localAvailable(snapOf(), 'P', TODAY, unk), 15);
});

test('D16: تلميحٌ لا تسعه اللقطة، أو سطرٌ من الصنف بلا تلميح، يُطرح الصنف كله بالقاعدة — والعجز لا يجعل المتاح سالباً', () => {
  // a 5 تكفي 4، وb موقوفة 10 لا تكفي 12 ⇒ لا يُلتزم بالتلميح: 16 بـFEFO من a ثم غير المسمّى (المؤهَّل كله صفر)
  const s = snapOf({}, [{ ...snapOf().products[0], lots: [lot('a', 5), lot('b', 10, { status: 'BLOCKED', blockKind: 'HOLD' })] }]);
  const over = pend([invoiceDoc({ items: [{ productId: 'P', qty: 16, lots: [{ lotId: 'a', qty: 4 }, { lotId: 'b', qty: 12 }] }] })]);
  assert.equal(localAvailable(s, 'P', TODAY, over), 0);
  assert.equal(localLotView(s, 'P', TODAY, over).lots[1].left, 10, 'الموقوف لم يُمسّ');
  // سطران من الصنف: أحدهما بلا تلميح ⇒ الصنف كله بالقاعدة (لا byLot)
  const mixed = pend([invoiceDoc({ items: [{ productId: 'P', qty: 1, lots: [{ lotId: 'b', qty: 1 }] }, { productId: 'P', qty: 1 }] })]);
  assert.equal(mixed.get('P')!.byLot.size, 0);
  assert.equal(mixed.get('P')!.total, 2);
  // تلميحٌ مجموعه غير كمية السطر، أو كميةٌ سالبة: كأنه غائب
  assert.equal(pend([invoiceDoc({ items: [{ productId: 'P', qty: 3, lots: [{ lotId: 'a', qty: 2 }] }] })]).get('P')!.byLot.size, 0);
  assert.equal(validLotRefs([{ lotId: 'a', qty: -1 }]), null);
  assert.equal(validLotRefs([]), null);
  assert.equal(validLotRefs(Array.from({ length: 21 }, () => ({ lotId: 'a', qty: 1 }))), null);
  // عجزٌ يتجاوز كل شيء: صفرٌ لا سالب
  assert.equal(localAvailable(snapOf(), 'P', TODAY, pend([invoiceDoc({ items: [{ productId: 'P', qty: 100 }] })])), 0);
});

test('ما صدر متصلاً بعد بدء جلب اللقطة يُطرح بتشغيلات الخادم، وما قبله لا', () => {
  const s = snapOf();
  const posted: PostedEntry[] = [
    { clientRef: 'old', at: FETCHED - 1, items: [{ productId: 'P', qty: 9, lots: [{ lotId: 'b', qty: 9 }] }] },
    { clientRef: 'new', at: FETCHED + 5, items: [{ productId: 'P', qty: 4, lots: [{ lotId: 'b', qty: 4 }] }] },
  ];
  const v = localLotView(s, 'P', TODAY, pend([], posted));
  assert.deepEqual(v.lots.map((x) => x.left), [5, 6]);
  assert.equal(v.available, 13);
});

// ─── التلميح ───

test('localHint: FEFO بترتيب اللقطة بعد المعلّق، ثم غير المسمّى إن سُمح به؛ null حين لا يكفي و[] للصفر', () => {
  const s = snapOf();
  assert.deepEqual(localHint(s, 'P', 7, TODAY, none), [{ lotId: 'a', qty: 5 }, { lotId: 'b', qty: 2 }]);
  assert.deepEqual(localHint(s, 'P', 16, TODAY, none), [{ lotId: 'a', qty: 5 }, { lotId: 'b', qty: 10 }, { lotId: null, qty: 1 }]);
  assert.equal(localHint(s, 'P', 18, TODAY, none), null);
  assert.equal(localHint(snapOf({ allowUnknown: false }), 'P', 16, TODAY, none), null);
  assert.deepEqual(localHint(s, 'P', 0, TODAY, none), []);
  // المعلّق يُطرح أولاً
  assert.deepEqual(localHint(s, 'P', 3, TODAY, pend([invoiceDoc({ items: [{ productId: 'P', qty: 4 }] })])), [{ lotId: 'a', qty: 1 }, { lotId: 'b', qty: 2 }]);
  // المنتهي اليوم لا يُلمَّح منه
  assert.deepEqual(localHint(s, 'P', 3, '2026-11-21', none), [{ lotId: 'b', qty: 3 }]);
});

test('localHint: قاعدة الكرتون (D22) — مضاعفات المعامل كاملةً من تشغيلةٍ واحدة أولاً، وأربع خانات مجموعها كمية السطر', () => {
  const s = snapOf({}, [{ ...snapOf().products[0], unknownUsable: 0, lots: [lot('a', 30), lot('b', 48)] }]);
  // FEFO صرف كان يأخذ a 30 + b 18 فيشقّ كرتوناً؛ بالقاعدة a 24 + b 24
  assert.deepEqual(localHint(s, 'P', 48, TODAY, none, { unitFactor: 24 }), [{ lotId: 'a', qty: 24 }, { lotId: 'b', qty: 24 }]);
  assert.deepEqual(localHint(s, 'P', 48, TODAY, none), [{ lotId: 'a', qty: 30 }, { lotId: 'b', qty: 18 }]);
  const frac = snapOf({}, [{ ...snapOf().products[0], unknownUsable: 0, lots: [lot('a', 0.1), lot('b', 0.2)] }]);
  const h = localHint(frac, 'P', 0.3, TODAY, none)!;
  assert.deepEqual(h, [{ lotId: 'a', qty: 0.1 }, { lotId: 'b', qty: 0.2 }]);
  for (const r of h) assert.equal(Math.round(r.qty * 1e4) / 1e4, r.qty, 'أربع خانات (isLotQty)');
});

test('cartHints: أسطر الصنف على متاحٍ مشترك والكرتون أولاً، وغير المتتبَّع بلا تلميح، والناقص null', () => {
  const s = snapOf({}, [{ ...snapOf().products[0], unknownUsable: 0, lots: [lot('a', 30), lot('b', 48)] }]);
  // «٥ حبة» مذكورةٌ قبل «٢ كرتون»: الكرتون يُخدم أولاً كراتين كاملة (a 24، b 24)، والحبّات مما بقي
  const h = cartHints(s, [
    { productId: 'P', baseQty: 5, unitFactor: 1, tracked: true },
    { productId: 'X', baseQty: 3, unitFactor: 1, tracked: false },
    { productId: 'P', baseQty: 48, unitFactor: 24, tracked: true },
  ], TODAY, none);
  assert.deepEqual(h[2], [{ lotId: 'a', qty: 24 }, { lotId: 'b', qty: 24 }]);
  assert.deepEqual(h[0], [{ lotId: 'a', qty: 5 }]);
  assert.equal(h[1], undefined);
  const short = cartHints(s, [{ productId: 'P', baseQty: 70, unitFactor: 1, tracked: true }, { productId: 'P', baseQty: 10, unitFactor: 1, tracked: true }], TODAY, none);
  assert.ok(short[0]);
  assert.equal(short[1], null);
  // لا يغيّر المعلّق المعطى
  const p = pend([invoiceDoc({})]);
  const total = p.get('P')!.total;
  cartHints(snapOf(), [{ productId: 'P', baseQty: 2, unitFactor: 1, tracked: true }], TODAY, p);
  assert.equal(p.get('P')!.total, total);
});

test('hintDocLots: الورقة من التلميح برقم التشغيلة وانتهائها من اللقطة، وغير المسمّى بلا رقم', () => {
  assert.deepEqual(hintDocLots(snapOf(), 'P', [{ lotId: 'a', qty: 2 }, { lotId: null, qty: 1 }]), [
    { lotNumber: 'A', qty: 2, expiryDate: '2026-11-20' }, { lotNumber: null, qty: 1, expiryDate: null },
  ]);
  assert.equal(hintDocLots(snapOf(), 'P', []), undefined);
  assert.equal(hintDocLots(snapOf(), 'P', null), undefined);
});

// ─── السلّة ───

test('cartBaseOf وcapLineQty: مجموع أسطر الصنف بالأساس، والقصّ إلى المتاح بوحدة السطر بأربع خانات نزولاً', () => {
  const lines = [
    { productId: 'P', qty: 2, unitFactor: 24 }, { productId: 'P', qty: 5, unitFactor: 1 }, { productId: 'Q', qty: 9 },
    { productId: 'P', qty: 7, saleItemId: 's1' },
  ];
  assert.equal(cartBaseOf(lines, 'P'), 53);
  assert.equal(cartBaseOf(lines, 'P', 0), 5);
  assert.equal(capLineQty(3, 24, 30), 1.25);
  assert.equal(capLineQty(1, 24, 30), 1);
  assert.equal(capLineQty(5, 1, 0.30000000000000004), 0.3);
  assert.equal(capLineQty(5, 1, -2), 0);
  assert.equal(capLineQty(1.123456, 1, 10), 1.1235, 'الكمية بأربع خانات للصنف المتتبَّع');
  assert.equal(capLineQty(2, 0, 1), 1, 'معاملٌ تالف = 1');
});

test('capLineQty بوحدةٍ أكبر من الأساس: الكسر الذي يساوي المتّسع تماماً وحده، وإلا وحداتٌ كاملة — لا غبار من حبّة', () => {
  // كان: 10 حبات بمعامل 24 ⇒ 0.4166 كرتون = 9.9984 حبة («متاح 0.0016» باقٍ أبداً، والورقة «0.4166 كرتون»)
  assert.equal(capLineQty(1, 24, 10), 0);
  assert.equal(capLineQty(3, 24, 34), 1, 'كرتونٌ كامل، والعشر الباقية لسطر الحبّات');
  assert.equal(capLineQty(3, 24, 30), 1.25, 'الكسر الدقيق يبقى: 30 حبة');
  assert.equal(capLineQty(3, 4, 10.5), 2.625, 'وبأساسٍ كسري (كيلو) كذلك');
  assert.equal(capLineQty(5, 3, 10), 3, '3.3333 × 3 = 9.9999');
  for (const F of [2, 3, 6, 7, 12, 24, 48]) {
    for (let room = 0; room <= 100; room++) {
      const q = capLineQty(1000, F, room);
      assert.ok(q * F <= room + LOT_EPS, `F=${F} room=${room}: لا يتجاوز`);
      assert.ok(Math.abs(q * F - room) <= LOT_EPS || Number.isInteger(q), `F=${F} room=${room}: ${q} يترك غباراً`);
    }
  }
});

test('fitLineQty: ما وسعه المتّسع كما هو، والزائد يُقصّ، وبلا متّسعٍ أصلاً لا صفر صامت — يبقى ما كان ولا يكبر', () => {
  assert.deepEqual(fitLineQty(3, 2, 1, 5), { qty: 3, over: false });
  assert.deepEqual(fitLineQty(8, 2, 1, 5), { qty: 5, over: true });
  // سيناريو المراجعة: اللقطة صارت صفراً والمندوب كتب 3 — كان يُقصّ إلى 0 فيُصفّ ويُطبع ثم يرفضه الخادم (qty موجبة) بكل أصنافه
  assert.deepEqual(fitLineQty(3, 2, 1, 0), { qty: 2, over: true });
  assert.deepEqual(fitLineQty(1, 2, 1, 0), { qty: 1, over: true }, 'التخفيض يُقبل');
  assert.deepEqual(fitLineQty(3, 0, 1, 0), { qty: 3, over: true }, 'لا سابق موجب: تبقى المكتوبة والإصدار يمنعها');
  assert.deepEqual(fitLineQty(1, 1, 24, 10), { qty: 1, over: true }, 'كرتونٌ لا تسعه 10 حبات');
  assert.deepEqual(fitLineQty(0, 2, 1, 0), { qty: 0, over: false }, 'صفرٌ كتبه المندوب بيده — يمنعه الإصدار');
  assert.deepEqual(fitLineQty(2.123456, 0, 1, 10), { qty: 2.1235, over: false }, 'أربع خانات');
  for (const room of [-3, 0, 1e-7, 0.5, 3, 30]) {
    for (const prev of [0, 1, 2.5]) {
      for (const F of [1, 24]) {
        for (const want of [0.5, 1, 7]) {
          const r = fitLineQty(want, prev, F, room);
          assert.ok(r.qty > LOT_EPS, `want=${want} prev=${prev} F=${F} room=${room}: صفرٌ صامت`);
          assert.ok(r.qty <= Math.max(roundLot(want), 0) + LOT_EPS, 'لا يكبر عمّا كُتب');
        }
      }
    }
  }
});

test('offlineLotPlan: الفحص النهائي دون اتصال — بلا لقطة يُمنع المتتبَّع، والصفر يُمنع، وما فوق المتاح يُمنع بالمتاح، وضمنه تلميحٌ لكل سطر', () => {
  const s = snapOf(); // P: a 5، b 10، غير المسمّى 2 ⇒ 17
  const L = (productId: string, qty: unknown, unitFactor = 1, tracked = true) => ({ productId, qty, unitFactor, tracked });
  assert.deepEqual(offlineLotPlan(null, [L('X', 3, 1, false)], TODAY, none), { ok: true, hints: [undefined] }, 'بلا متتبَّع: لا شيء');
  assert.deepEqual(offlineLotPlan(null, [L('X', 3, 1, false), L('P', 1)], TODAY, none), { ok: false, block: { kind: 'noSnapshot' } });
  assert.deepEqual(offlineLotPlan(s, [L('P', 0)], TODAY, none), { ok: false, block: { kind: 'zeroQty', productId: 'P' } });
  assert.deepEqual(offlineLotPlan(s, [L('P', '')], TODAY, none), { ok: false, block: { kind: 'zeroQty', productId: 'P' } });
  assert.deepEqual(offlineLotPlan(s, [L('X', 0, 1, false)], TODAY, none), { ok: true, hints: [undefined] }, 'غير المتتبَّع لا يمسّه');
  // المجموع على أسطر الصنف: 10 + 8 > 17
  assert.deepEqual(offlineLotPlan(s, [L('P', 10), L('X', 1, 1, false), L('P', 8)], TODAY, none),
    { ok: false, block: { kind: 'over', productId: 'P', cap: 17 } });
  assert.deepEqual(offlineLotPlan(s, [L('P', 1, 24)], TODAY, none), { ok: false, block: { kind: 'over', productId: 'P', cap: 17 } }, 'بالأساس');
  assert.deepEqual(offlineLotPlan(s, [L('P', 15)], TODAY, pend([invoiceDoc({})])), { ok: false, block: { kind: 'over', productId: 'P', cap: 14 } }, 'بعد المعلّق');
  assert.deepEqual(offlineLotPlan(s, [L('Q', 1)], TODAY, none), { ok: false, block: { kind: 'over', productId: 'Q', cap: 0 } }, 'متتبَّعٌ غائب عن اللقطة');
  assert.deepEqual(offlineLotPlan(s, [L('P', 13)], '2026-11-21', none), { ok: false, block: { kind: 'over', productId: 'P', cap: 12 } }, 'بيوم الجهاز: a منتهية');
  assert.deepEqual(offlineLotPlan(s, [L('P', 7), L('X', 1, 1, false), L('P', 10)], TODAY, none), {
    ok: true, hints: [[{ lotId: 'a', qty: 5 }, { lotId: 'b', qty: 2 }], undefined, [{ lotId: 'b', qty: 8 }, { lotId: null, qty: 2 }]],
  });
  assert.deepEqual(offlineLotPlan(s, [L('P', 17)], TODAY, none).ok, true, 'المتاح كله');
  assert.deepEqual(offlineLotPlan(s, [L('P', 3)], TODAY, none), { ok: true, hints: [[{ lotId: 'a', qty: 3 }]] }, 'دون المتاح');
  assert.deepEqual(offlineLotPlan(s, [L('P', 0.5, 24)], TODAY, none).ok, true, 'نصف كرتون = 12 حبة ضمن 17');
});

// ─── ردّ الإصدار المتصل ───

test('matchServerItemLots: البيع بالصنف ولقطة الوحدة (وكل بندٍ مرة)، والمرتجع المرتبط ببند بيعه، والغائب undefined', () => {
  const items = [
    { productId: 'P', qty: 5, unitFactor: 1, lots: [{ lotId: 'a', quantity: 5, lot: { lotNumber: 'A', expiryDate: '2026-11-20T00:00:00.000Z' } }] },
    { productId: 'P', qty: 2, unitFactor: 24, lots: [{ lotId: 'b', quantity: 48, lot: { lotNumber: 'B', expiryDate: null } }] },
    { productId: 'R', qty: 1, unitFactor: 1, returnOfItemId: 'sale-1', lots: [{ lotId: null, quantity: 1 }] },
  ];
  const got = matchServerItemLots([
    { productId: 'P', unitFactor: 24, qty: 2 }, { productId: 'P', unitFactor: 1, qty: 5 }, { productId: 'R', saleItemId: 'sale-1', qty: 1 },
    { productId: 'Z', qty: 1 },
  ], items);
  assert.deepEqual(got[0], [{ lotNumber: 'B', qty: 48, expiryDate: null }]);
  assert.deepEqual(got[1], [{ lotNumber: 'A', qty: 5, expiryDate: '2026-11-20' }]);
  assert.deepEqual(got[2], [{ lotNumber: null, qty: 1, expiryDate: null }]);
  assert.equal(got[3], undefined);
  assert.deepEqual(matchServerItemLots([{ productId: 'P' }], undefined), [undefined]);
});

test('postedItemsFromServer: الأصناف المتتبَّعة وحدها بكميتها الأساسية وتشغيلاتها من quantity', () => {
  const got = postedItemsFromServer([
    { productId: 'P', qty: 2, unitFactor: 24, baseQty: 48, lots: [{ lotId: 'b', quantity: 48 }] },
    { productId: 'P', qty: 3, unitFactor: 1, lots: [{ lotId: null, quantity: 3 }] },
    { productId: 'X', qty: 1, lots: [] },
    { productId: 'P', qty: 0 },
  ], new Set(['P']));
  assert.deepEqual(got, [
    { productId: 'P', qty: 48, lots: [{ lotId: 'b', qty: 48 }] },
    { productId: 'P', qty: 3, lots: [{ lotId: null, qty: 3 }] },
  ]);
  assert.deepEqual(postedItemsFromServer(null, new Set(['P'])), []);
});

test('قائمة الصادر متصلاً: بديلٌ لمرجعه، مقلَّمةٌ بلقطة الجهاز وبسقف', () => {
  const e = (clientRef: string, at: number): PostedEntry => ({ clientRef, at, items: [] });
  assert.deepEqual(withPosted([e('x', 1), e('y', 5)], e('x', 9), 4), [e('y', 5), e('x', 9)]);
  assert.deepEqual(prunePosted([e('x', 1), e('y', 5)], null), [e('x', 1), e('y', 5)]);
  assert.deepEqual(prunePosted([e('x', 1), e('y', 5)], 5), [e('y', 5)]);
  const many = Array.from({ length: VANLOTS_POSTED_MAX + 5 }, (_, i) => e(`r${i}`, i));
  assert.equal(prunePosted(many, null).length, VANLOTS_POSTED_MAX);
  assert.equal(prunePosted(many, null)[0].clientRef, 'r5', 'الأحدث يبقى');
  assert.deepEqual(postedListOf([e('x', 1), { at: 1 }, null, 'z']), [e('x', 1)]);
  assert.deepEqual(postedListOf(undefined), []);
});

test('addPending يجمع الكمية والتشغيلات لكل صنف', () => {
  const p: PendingOut = new Map();
  addPending(p, 'P', 3, [{ lotId: 'a', qty: 3 }]);
  addPending(p, 'P', 2, null);
  addPending(p, 'P', 0, [{ lotId: 'a', qty: 9 }]);
  assert.deepEqual(p.get('P'), { total: 5, byLot: new Map([['a', 3]]) });
});

// ─── الصندوق ───

test('sentAt يُختم عند الانتقال إلى «مُرسَل» ولا يتغيّر بعده، ولا يُختم غيره', () => {
  const now = '2026-11-10T10:00:00.000Z';
  const doc = (status: string, sentAt?: string): { status: string; sentAt?: string } => ({ status, ...(sentAt && { sentAt }) });
  assert.equal(withSentAt(doc('sent'), now).sentAt, now);
  assert.equal(withSentAt(doc('sent', 'old'), now).sentAt, 'old');
  assert.equal(withSentAt(doc('queued'), now).sentAt, undefined);
  assert.equal(withSentAt(doc('rejected'), now).sentAt, undefined);
  const same = doc('queued');
  assert.equal(withSentAt(same, now), same, 'غير المرسَل يمرّ كما هو');
});

test('LOT_REPLAY_HELD: مصفوفٌ «بانتظار الإدارة» لا يُسأل قبل المهلة، ويخرج من الوسم إن رُفع أو رُفض', () => {
  const T = Date.parse('2026-11-10T10:00:00.000Z');
  const at = new Date(T).toISOString();
  assert.equal(reviewRecheckDue({ reviewCode: LOT_REPLAY_HELD_CODE, reviewCheckedAt: at }, T + REVIEW_RECHECK_MS - 1), false);
  assert.equal(reviewRecheckDue({ reviewCode: LOT_REPLAY_HELD_CODE, reviewCheckedAt: at }, T + REVIEW_RECHECK_MS), true);
  assert.equal(reviewRecheckDue({ reviewCode: 'OTHER', reviewCheckedAt: at }, T), true, 'وسمٌ مجهول لا يحبس');
  assert.equal(underLotReplayHeld({ reviewCode: LOT_REPLAY_HELD_CODE, status: 'queued' }), true);
  assert.equal(underLotReplayHeld({ reviewCode: LOT_REPLAY_HELD_CODE, status: 'rejected' }), false);
  assert.equal(underLotReplayHeld({ reviewCode: LOT_REPLAY_HELD_CODE, status: 'sent' }), false);
  assert.equal(underLotReplayHeld({ reviewCode: CUTOVER_REVIEW_CODE }), false);
});

// ─── حرّاس نصّية ───

test('المزامنة: LOT_REPLAY_HELD يبقى مصفوفاً بوسمه ورسالة الخادم ويتابع، قبل فرع الرفض — وLOT_BUSY 503 على فرع الإعادة', () => {
  const s = read('src', 'rep', 'offlineSync.ts');
  assert.ok(s.includes("import { LOT_REPLAY_HELD_CODE } from './vanLots';"));
  const i = s.indexOf('if (code === LOT_REPLAY_HELD_CODE) {');
  assert.ok(i > s.indexOf('if (code === CUTOVER_REVIEW_CODE) {'), 'بعد مراجعة الفوترة');
  assert.ok(i < s.indexOf("status: 'rejected'"), 'قبل فرع رفض الأعمال (4xx)');
  const block = s.slice(i, s.indexOf('\n        }', i));
  assert.match(block, /await outboxUpdate\(\{ \.\.\.doc, reviewCode: LOT_REPLAY_HELD_CODE, reviewCheckedAt: new Date\(\)\.toISOString\(\), error: msg \|\| undefined \}\);\s*continue;$/);
  assert.doesNotMatch(block, /stopped = true|break;|status: '/, 'لا توقّف ولا رفض ولا إعدام');
  // 5xx (ومنه 503 LOT_BUSY) يبقى مصفوفاً ويتوقّف — الفرع القائم
  assert.match(s, /\} else \{\s*\/\/ انقطاع أو خطأ خادم مؤقّت \(5xx\)[^\n]*\n\s*stopped = true;\s*break;/);
  // مزامنةٌ رفعت فاتورة تُعلم التطبيق ليجلب اللقطة
  assert.ok(s.includes("if (doc.kind === 'invoice') sentInvoices++;"));
  assert.ok(s.includes('if (sentInvoices > 0) invoiceListeners.forEach('));
});

test('الصندوق المحلي: sentAt يختمه outboxUpdate، ومفتاحا اللقطة بلا رفع نسخة القاعدة', () => {
  const db = read('src', 'rep', 'offlineDb.ts');
  assert.ok(db.includes('const DB_VERSION = 1;'), 'لا رفع لـDB_VERSION');
  assert.match(db, /export async function outboxUpdate\(doc: OutboxDoc\): Promise<void> \{[\s\S]*?s\.put\(withSentAt\(doc, new Date\(\)\.toISOString\(\)\)\)/);
  assert.match(db, /sentAt\?: string;/);
  assert.match(db, /export async function refClear\(\): Promise<void> \{\s*try \{ await tx\(STORE_REF, 'readwrite', \(s\) => s\.clear\(\)\); \}/, 'refClear يمسح المخزن كله ومعه vanlots');
});

test('التطبيق: اللقطة لا تُجلب مع دورة الخمس دقائق ولا بـfetchThenCache، والإصدار المتصل بلا تلميح', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.equal(app.split("'/van-stock/lot-balances'").length - 1, 1, 'نداء جلبٍ واحد (refreshVanLots)');
  const i = app.indexOf('let last = Date.now(); // الجلب الأول في المؤثّر أعلاه');
  const cycle = app.slice(i, app.indexOf('}, [token, refreshUser]);', i));
  assert.ok(i > 0 && cycle.length > 0);
  assert.doesNotMatch(cycle, /lot-balances|refreshVanLots|vanLots/i, 'دورة الخمس دقائق بلا لقطة');
  assert.doesNotMatch(app, /fetchThenCache\([^)]*VANLOTS_KEY/, 'fetchThenCache تختم بعد الردّ');
  // ختم بدء الطلب قبل النداء
  const r = app.indexOf('const refreshVanLots = useCallback(');
  const body = app.slice(r, app.indexOf('}, []);', r));
  assert.ok(body.indexOf('const fetchedAt = Date.now();') < body.indexOf("repApi.get('/van-stock/lot-balances'"));
  assert.match(body, /if \(!lotOnRef\.current \|\| !navigator\.onLine/, 'الميزة مطفأة: لا طلب');
  // الإصدار: النداء المتصل بالحمولة نفسها، والتلميح في فرع الانقطاع وحده قبل الصفّ
  const sub = app.slice(app.indexOf('const submit = async () => {'), app.indexOf('const refreshUnits = async () => {'));
  const post = sub.indexOf("const res = await repApi.post('/invoices', payload);");
  const offline = sub.indexOf('if (isNetworkError(err)) {');
  const plan = sub.indexOf('await lotOfflinePlan(payload.items, printItems);');
  const add = sub.indexOf('await outboxAdd(');
  assert.ok(post > 0 && offline > post && plan > offline && add > plan, 'التلميح بعد الانقطاع وقبل الصفّ');
  assert.ok(sub.includes('payload.items = lotPlan.payloadItems;'), 'التلميح في بنود الحمولة نفسها التي تُصفّ');
  assert.ok(sub.includes('items: offlineItems,'), 'والورقة دون اتصال بتشغيلات التلميح');
  assert.ok(app.indexOf("const res = await repApi.post('/invoices', payload);") === app.lastIndexOf("const res = await repApi.post('/invoices', payload);"));
  // الميزة مطفأة: الحمولة والورقة كما كانتا
  assert.match(sub, /let offlineItems = printItems;[^\n]*\n\s*if \(lotCapsOn\) \{/);
  // الصندوق يحفظ الحمولة نفسها (repUnits.test) — والتلميح فيها لا بديلٌ عنها
  assert.ok(sub.includes("await outboxAdd({ clientRef, repId: currentRepId(), kind: 'invoice', payload, status: 'queued'"));
});

test('التطبيق: المنع المحلي داخل المحدِّث الدالّي، والمرتجع خارج المتاح المحلي، والعلم من الشركة', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.ok(app.includes('setLines(prev => (lotOverflow(prev, p.id, c0.factor, stored, pend) != null ? prev : addLine(prev, p, c0)));'));
  assert.ok(app.includes('const lotCapsOn = lotOn && !isReturn;'));
  assert.ok(app.includes('const lotOn = lotFlagsOf(company).on;'));
  // القراءة من الكاش والجلب عند الفتح خلف العلم
  assert.match(app, /useEffect\(\(\) => \{\s*if \(!token \|\| !lotOn\) return;\s*let alive = true;\s*void \(async \(\) => \{\s*const hit = await cacheGet<unknown>\(VANLOTS_KEY\);/);
});

test('التطبيق: الفحص النهائي دون اتصال نداءٌ واحد للدالّة الصرفة، والكمية بلا صفرٍ صامت، والإصدار يمنع صفر المتتبَّع', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  // offlineLotPlan (المختبَرة أعلاه) هي الحَكَم الوحيد: نداءٌ واحد داخل lotOfflinePlan، وخطؤها يمنع الصفّ
  assert.equal(app.split('offlineLotPlan(').length - 1, 1, 'نداءٌ واحد');
  const fn = app.slice(app.indexOf('const lotOfflinePlan = async'), app.indexOf('const submit = async () => {'));
  assert.ok(fn.includes('const plan = offlineLotPlan('), 'داخل lotOfflinePlan');
  assert.ok(fn.includes('if (!plan.ok) return { error: lotBlockText(plan.block) };'));
  assert.doesNotMatch(fn, /localAvailable\(|cartHints\(/, 'لا فحصٌ ثانٍ مكرّر خارج الدالّة المختبَرة');
  // تعديل الكمية: fitLineQty (لا capLineQty المباشرة التي كانت تصفّر السطر بلا متّسع)
  const upd = app.slice(app.indexOf('const upd = (i: number, f: string, v: number) => {'), app.indexOf('// الشارة والعدّاد'));
  assert.ok(upd.includes('fitLineQty('));
  assert.doesNotMatch(upd, /capLineQty\(/);
  // تبديل الوحدة: بلا متّسعٍ بالوحدة الجديدة لا تُبدَّل (ولا صفر)
  const unit = app.slice(app.indexOf('const setLineUnit = ('), app.indexOf('// مسح باركود مستمرّ'));
  assert.ok(unit.includes('if (fit <= LOT_EPS) { lotSay(lotOverText(p, cap)); return; }'));
  // الإصدار: سطرٌ متتبَّع كميته صفر يُمنع قبل أي إرسال أو صفّ
  const sub = app.slice(app.indexOf('const submit = async () => {'), app.indexOf('const refreshUnits = async () => {'));
  const zero = sub.indexOf('const z = zeroQtyLine(lotPlanLines());');
  assert.ok(zero > 0 && zero < sub.indexOf("setLoading(true); setMsg('');"), 'قبل الإرسال');
  assert.match(sub, /if \(lotCapsOn\) \{\s*const z = zeroQtyLine\(lotPlanLines\(\)\);\s*if \(z >= 0\) \{ setMsg\(lotZeroText\(lines\[z\]\)\); return; \}/);
  // خطأ الفحص النهائي يمنع الصفّ فعلاً: قبل outboxAdd، وبرسالته
  const plan = sub.indexOf('const lotPlan = await lotOfflinePlan(payload.items, printItems);');
  const stop = sub.indexOf("if ('error' in lotPlan) { setMsg(lotPlan.error); setLoading(false); return; }");
  assert.ok(plan > 0 && stop > plan && stop < sub.indexOf('await outboxAdd('), 'الخطأ يوقف الصفّ قبل outboxAdd');
  // الإضافة دون اتصال بلا لقطة: المتتبَّع لا يدخل السلّة أصلاً (قبل فحص المتاح)
  const add = app.slice(app.indexOf('const addProduct = (p: any, scan = false)'), app.indexOf('// خانات عملة الشركة'));
  const noSnap = add.indexOf('if (!lotStored && lotTracks(p.id) && !navigator.onLine) {');
  assert.ok(noSnap > 0 && noSnap < add.indexOf('const cap = lotOverflow('), 'منع بلا لقطة دون اتصال');
  assert.match(add.slice(noSnap), /^if \(!lotStored && lotTracks\(p\.id\) && !navigator\.onLine\) \{\s*const text = tr\('اتصل مرة لتحديث أرصدة السيارة'\);\s*if \(!scan\) lotSay\(text\);\s*return \{ ok: false, label: text \};/);
});

test('التطبيق: المنع المحلي متصلاً يجلب اللقطة مرةً قبل الحكم في كل مساراته — النقر والماسح والكمية والوحدة (§٧.١)', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.doesNotMatch(app, /lotOverMsg/, 'لا رسالةٌ قبل اللقطة ثم جلبٌ في الخلفية');
  // النقر والماسح: حكمٌ مؤجّل بعد اللقطة الطازجة، والماسح يعرضه حين يصل (later)
  const add = app.slice(app.indexOf('const addProduct = (p: any, scan = false)'), app.indexOf('// خانات عملة الشركة'));
  assert.ok(add.includes("if (navigator.onLine && lots) return { ok: false, label: lotChecking, later: lotRecheckAdd(p, c0, cap) };"));
  const scanner = read('src', 'rep', 'BarcodeScanner.tsx');
  assert.match(scanner, /r\.later\?\.then\(show\)/, 'الماسح يعرض الحكم المؤجّل');
  // الكمية: متصلاً تبقى المكتوبة مؤقتاً ويُحكم عليها بعد اللقطة؛ ودون اتصال القصّ فوراً
  const upd = app.slice(app.indexOf('const upd = (i: number, f: string, v: number) => {'), app.indexOf('// الشارة والعدّاد'));
  assert.match(upd, /else if \(navigator\.onLine && lots\) lotRecheckQty\(key, prev\);\s*else \{ lotQtyDone\(key\); v = fit\.qty; lotSay\(/);
  const rq = app.slice(app.indexOf('const lotRecheckQty = ('), app.indexOf('const lotQtyDone = ('));
  assert.ok(rq.indexOf('await lotFresh()') > 0 && rq.indexOf('await lotFresh()') < rq.indexOf('lotSay(lotOverText('), 'اللقطة قبل الرسالة');
  assert.ok(rq.includes('if (!st || st.seq !== seq) return;'), 'التعديل الأحدث للسطر هو الذي يُحكم عليه');
  // الوحدة: متصلاً لا تُبدَّل ولا تُقصّ قبل اللقطة
  const unit = app.slice(app.indexOf('const setLineUnit = ('), app.indexOf('// مسح باركود مستمرّ'));
  assert.ok(unit.indexOf('if (!lotFreshSnap && navigator.onLine && lots) { void lotRecheckUnit(l, unitId); return; }') > 0);
  assert.ok(unit.indexOf('void lotRecheckUnit(') < unit.indexOf('if (fit <= LOT_EPS)'));
  // مهلة الخمس عشرة ثانية لجلبٍ أطلقه منعٌ سابق وحده — لا لجلب فتح البيع
  const r = app.indexOf('const refreshVanLots = useCallback(');
  const body = app.slice(r, app.indexOf('}, []);', r));
  assert.match(body, /if \(minGapMs > 0\) \{\s*if \(Date\.now\(\) - vanLotsBlockAt\.current < minGapMs\) return Promise\.resolve\(vanLotsRef\.current\);\s*vanLotsBlockAt\.current = Date\.now\(\);\s*\}/);
  assert.doesNotMatch(app, /vanLotsStartedAt/);
});

test('عبارات W6 تحت علامتها بالأربع', () => {
  const strings = read('src', 'i18n', 'strings.ts');
  const mark = strings.indexOf('// ═══ تتبّع اللوط — W6 ═══');
  assert.ok(mark > 0);
  for (const phrase of [
    'الكمية من «{name}» أكبر من المتاح في سيارتك ({n})', 'جار التحقق من رصيد السيارة', 'اتصل مرة لتحديث أرصدة السيارة', 'متاح في سيارتك',
    'فواتير صدرت دون اتصال لا يكفيها رصيد السيارة محجوزة حتى تسجل الإدارة التحميل الناقص ولن تضيع', 'بانتظار الإدارة: تحميل ناقص',
    'كمية «{name}» صفر أدخل كمية أو احذف الصنف من السلة',
  ]) {
    const at = strings.indexOf(`'${phrase}':`);
    assert.ok(at > mark, `غير مترجم تحت علامة W6: ${phrase}`);
    const entry = strings.slice(at, strings.indexOf('\n', at));
    for (const lang of ['en', 'fr', 'tr', 'zh']) assert.match(entry, new RegExp(`\\b${lang}:`), `${phrase} بلا ${lang}`);
    for (const ph of ['{name}', '{n}']) if (phrase.includes(ph)) assert.equal(entry.split(ph).length - 1, 5, `${ph} في كل لغة`);
  }
});

// ─── «الوحدة الرئيسية»: معلّقٌ صُفّ قبل «إضافة وحدة فرعية أصغر» ───

test('rep-offline-4 (I9): فاتورةٌ صُفّت بالكرتون أساساً ثم حُوِّل الصنف ⇒ المعلّق وتلميحاته × المعامل على لقطةٍ بعد التحويل', () => {
  // الصنف كان أساسه «كرتون»، فصار «قارورة» والكرتون وحدة ٢٤ — واللقطة بعد التحويل كمياتها بالقارورة
  const catalog = [{ id: 'P', unit: 'قارورة', units: [{ id: 'u-c', name: 'كرتون', factor: 24, isActive: true }] }];
  const s = snapOf({}, [{
    productId: 'P', available: 240, availableNamed: 240, unknownUsable: 0, quarantined: 0, held: 0, expiredUnsold: 0, expiredReturned: 0, damaged: 0,
    lots: [lot('a', 120, { expiryDate: '2026-11-20' }), lot('b', 120, { expiryDate: '2026-12-31' })],
  }]);
  const held = invoiceDoc({ status: 'rejected', reviewCode: LOT_REPLAY_HELD_CODE, items: [{ productId: 'P', qty: 3, unitName: 'كرتون', unitFactor: 1, baseUnitName: 'كرتون', lots: [{ lotId: 'a', qty: 3 }] }] });
  // ما كان قبل الإصلاح: يُطرح ٣ قوارير فقط فيبقى ٢٣٧ ويبيع المندوب ما ليس في السيارة
  assert.equal(localAvailable(s, 'P', TODAY, pendingOut([held], [], FETCHED, ME)), 237);
  const pend = pendingOut([held], [], FETCHED, ME, catalog);
  assert.equal(pend.get('P')?.total, 72);
  assert.equal(pend.get('P')?.byLot.get('a'), 72, 'التلميح × ٢٤ كـscaleLotHint');
  assert.equal(localAvailable(s, 'P', TODAY, pend), 168);
  // البند بأساسه الحالي (أو بلا لقطة أساس) كما كان حرفاً
  const same = invoiceDoc({ items: [{ productId: 'P', qty: 3, unitName: 'قارورة', unitFactor: 1, baseUnitName: 'قارورة' }] });
  assert.equal(pendingOut([same], [], FETCHED, ME, catalog).get('P')?.total, 3);
  assert.equal(pendingOut([invoiceDoc({ items: [{ productId: 'P', qty: 3 }] })], [], FETCHED, ME, catalog).get('P')?.total, 3);
  // أساسٌ قديم لا يعرفه الكتالوج ⇒ الكمية كما هي والتلميح يُسقط (يُطرح بالقاعدة FEFO)
  const lost = pendingOut([invoiceDoc({ items: [{ productId: 'P', qty: 3, baseUnitName: 'علبة', lots: [{ lotId: 'b', qty: 3 }] }] })], [], FETCHED, ME, catalog);
  assert.equal(lost.get('P')?.total, 3);
  assert.equal(lost.get('P')?.byLot.size, 0);
  // بلا كتالوج ⇒ كما كان حرفاً (I1)
  assert.equal(pendingOut([held], [], FETCHED, ME, null).get('P')?.total, 3);
});

test('RepApp: المعلّق يُحسب بكتالوج الجهاز (كاش products)', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
  assert.match(app, /cacheGet<unknown>\('products'\)\]\);/);
  assert.match(app, /pendingOut\(docs, postedListOf\(posted\?\.data\), stored\.fetchedAt, currentRepId\(\), Array\.isArray\(cat\?\.data\) \? cat\.data as PendingCatalogProduct\[\] : null\)/);
});
