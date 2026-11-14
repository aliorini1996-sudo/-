// «ربط الدفاتر» L2/L3 — ملخّص محرّك التكلفة (services/costing/summary.ts، العقد §7 ومعيار القبول C2-5):
// openingByLocation بقاعدة المشمول (ومنها المؤرَّخ مستقبلاً المسجَّل قبل T0 ⇒ خارج الافتتاح، والمتأخر ⇒ خارجه)،
// وfyCogs = Σ cogsImpact لغير المشمول، وuncostedAtCutover/negativeAtCutover من الحالة الملتقطة، والحُفر والتحذيرات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { includedInCostOpening, summarizeCosting, HOLES_SAMPLE } from '../services/costing/summary';
import { replay, stateTotals } from '../services/costing/stepper';
import { cogsImpactMilli, glImpactOf } from '../services/costing/accounts';
import { toQtyU, fromQtyU } from '../services/costing/math';
import { loadMoves, type CostingDb } from '../services/costing/streams';
import { saleOutKey, whItemKey } from '../services/costing/keys';
import type { LocationKey, LocationTotals, Move, StepOutput, SummarizeOptions } from '../services/costing/types';
import { zonedStartOfDay } from '../services/gl/dates';
import { isIncludedInOpening } from '../services/gl/sync/classify';
import { CostingFakeDb, asPrisma } from './costing-fake-db';

const TZ = 'Asia/Riyadh';
const CUT = '2026-01-01';
const CUT_START = zonedStartOfDay(CUT, TZ); // 2025-12-31T21:00:00Z
const T0 = new Date('2026-03-15T09:00:00.000Z');

function opts(over: Partial<SummarizeOptions> = {}): SummarizeOptions {
  return { cutoverDate: CUT, cutoverStart: CUT_START, openingSnapshotAt: T0, timezone: TZ, atCutover: null, ...over };
}

test('includedInCostOpening = isIncludedInOpening (بلا cleanStart) — حدود اليوم المحلي وT0', () => {
  const cases: { effectAt: string; srcCreatedAt: string; expected: boolean; why: string }[] = [
    { effectAt: '2025-12-31T20:59:59.999Z', srcCreatedAt: '2025-12-31T20:59:59.999Z', expected: true, why: 'آخر لحظة قبل البدء محلياً' },
    { effectAt: '2025-12-31T21:00:00.000Z', srcCreatedAt: '2025-12-31T21:00:00.000Z', expected: false, why: 'أول لحظة من يوم البدء (الرياض +3)' },
    { effectAt: '2025-12-20T10:00:00.000Z', srcCreatedAt: '2026-03-15T09:00:00.000Z', expected: true, why: 'تسجيل = T0 شامل' },
    { effectAt: '2025-12-20T10:00:00.000Z', srcCreatedAt: '2026-03-15T09:00:00.001Z', expected: false, why: 'وصول متأخر بعد T0' },
    { effectAt: '2026-02-01T00:00:00.000Z', srcCreatedAt: '2025-11-01T00:00:00.000Z', expected: false, why: 'مؤرّخ مستقبلاً مسجَّل قبل T0' },
  ];
  for (const c of cases) {
    const o = { effectAt: new Date(c.effectAt), srcCreatedAt: new Date(c.srcCreatedAt) };
    assert.equal(includedInCostOpening(o, opts()), c.expected, c.why);
    assert.equal(
      isIncludedInOpening({ effectAt: o.effectAt, createdAt: o.srcCreatedAt }, { cutoverDate: CUT, openingSnapshotAt: T0, timezone: TZ, cleanStart: false }),
      c.expected, `مرآة classify: ${c.why}`,
    );
  }
});

/** سنةٌ حول البدء: ما قبل البدء (مشمول)، ومؤرّخ مستقبلاً قبل T0، ووصول متأخر، ونشاط السنة، وحفرة تُسدّ في السنة */
function yearDb(): { db: CostingFakeDb; ids: Record<string, string> } {
  const db = new CostingFakeDb();
  const ids: Record<string, string> = {};
  db.clock = new Date('2025-12-01T08:00:00.000Z').getTime();
  ids.rec1 = db.addReceipt('A', 100, 20).itemIds[0];                                  // مشمول: WH 100 @ 2,000,000
  ids.recFree = db.addReceipt('C', 6, null).itemIds[0];                               // مشمول: 6 خارج التقييم
  db.addVanLoad({ salesRepId: 'R1', items: [{ productId: 'A', qty: 30 }] });         // مشمول: VAN 30 @ 600,000
  ids.saleBefore = db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', items: [{ productId: 'A', qty: 10 }] }).itemIds[0]; // مشمول: −200,000
  ids.hole = db.addInvoice({ type: 'CASH', salesRepId: 'R2', items: [{ productId: 'B', qty: 4 }] }).itemIds[0]; // مشمول: سيارة R2 −4 بلا قيمة
  // مؤرّخ مستقبلاً: فاتورة مسجَّلة في ديسمبر بتاريخ فبراير ⇒ خارج الافتتاح
  ids.future = db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', entryDate: '2026-02-10T00:00:00.000Z', items: [{ productId: 'A', qty: 5 }] }).itemIds[0];
  // السنة
  db.clock = new Date('2026-01-05T08:00:00.000Z').getTime();
  ids.rec2 = db.addReceipt('B', 10, 8).itemIds[0];
  db.addVanLoad({ salesRepId: 'R2', items: [{ productId: 'B', qty: 10 }] });         // يسدّ حفرة R2: بلا قيمة ⇒ فرق؟ الحفرة صفرية القيمة
  ids.saleFy = db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', items: [{ productId: 'A', qty: 3 }] }).itemIds[0];
  // وصول متأخر: أثره ديسمبر، وتسجيله بعد T0
  db.clock = new Date('2026-03-20T08:00:00.000Z').getTime();
  ids.late = db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', entryDate: '2025-12-28T00:00:00.000Z', items: [{ productId: 'A', qty: 2 }] }).itemIds[0];
  return { db, ids };
}

async function yearRun() {
  const { db, ids } = yearDb();
  const lm = await loadMoves(asPrisma<CostingDb>(db), 't1', { until: new Date('2030-01-01'), currencyDecimals: 2 });
  const rr = replay(lm.moves, { currencyDecimals: 2 }, { captureAt: [CUT_START] });
  return { db, ids, lm, rr };
}

function totalsMap(ts: readonly LocationTotals[]): Map<LocationKey, LocationTotals> {
  return new Map(ts.map((t) => [t.location, t]));
}

test('summarizeCosting: الافتتاح = Σ مساهمات المشمول وحده (المؤرّخ مستقبلاً والمتأخر خارجه)، والآن = الحالة، وΣ الافتتاح + السنة = الآن', async () => {
  const { ids, lm, rr } = await yearRun();
  const s = summarizeCosting(rr.outputs, rr.state, opts({ atCutover: rr.captured[0], streamWarnings: lm.warnings }));
  const byKey = new Map(rr.outputs.map((o) => [o.key, o]));
  assert.equal(includedInCostOpening(byKey.get(saleOutKey(ids.future))!, opts()), false, 'مؤرّخ مستقبلاً');
  assert.equal(includedInCostOpening(byKey.get(saleOutKey(ids.late))!, opts()), false, 'متأخر');
  assert.equal(includedInCostOpening(byKey.get(saleOutKey(ids.saleBefore))!, opts()), true);
  const open = totalsMap(s.openingByLocation);
  // WH: 100 @ 2,000,000 − 30 (600,000) = 70 @ 1,400,000 + C: 6 خارج التقييم
  assert.deepEqual(open.get('WH'), { location: 'WH', qtyBase: 76, uncostedQty: 6, valueMilli: 1_400_000n });
  // R1: 30 @ 600,000 − 10 (200,000) = 20 @ 400,000 — والمؤرّخ مستقبلاً (5) غير مطروح
  assert.deepEqual(open.get('VAN:R1'), { location: 'VAN:R1', qtyBase: 20, uncostedQty: 0, valueMilli: 400_000n });
  assert.deepEqual(open.get('VAN:R2'), { location: 'VAN:R2', qtyBase: -4, uncostedQty: -4, valueMilli: 0n });
  assert.deepEqual(s.openingByLocation.map((t) => t.location), ['WH', 'VAN:R1', 'VAN:R2'], 'المستودع أولاً ثم السيارات');
  assert.deepEqual(s.nowByLocation, stateTotals(rr.state));
  // Σ الافتتاح + مساهمات غير المشمول = الآن (القيمة والكمية) لكل موقع
  const sum = new Map<string, { qU: number; v: bigint }>();
  const add = (loc: string, qU: number, v: bigint) => { const a = sum.get(loc) ?? { qU: 0, v: 0n }; a.qU += qU; a.v += v; sum.set(loc, a); };
  for (const t of s.openingByLocation) add(t.location, toQtyU(t.qtyBase), t.valueMilli);
  for (const o of rr.outputs) {
    if (includedInCostOpening(o, opts())) continue;
    add(o.location, toQtyU(o.baseQty), o.valueMilli);
    if (o.toLocation) add(o.toLocation, -toQtyU(o.baseQty), -o.valueMilli - o.varianceMilli);
  }
  for (const n of s.nowByLocation) {
    const a = sum.get(n.location)!;
    assert.equal(a.v, n.valueMilli, `القيمة ${n.location}`);
    assert.equal(fromQtyU(a.qU), n.qtyBase, `الكمية ${n.location}`);
  }
  // تكلفة السنة = Σ cogsImpact لغير المشمول
  const fy = rr.outputs.filter((o) => !includedInCostOpening(o, opts()));
  assert.equal(s.fyCogsMilli, fy.reduce((a, o) => a + cogsImpactMilli(o), 0n));
  assert.equal(s.fyWriteOffMilli, fy.reduce((a, o) => a + glImpactOf(o).writeOffMilli, 0n));
  assert.equal(s.fyVarianceMilli, fy.reduce((a, o) => a + o.varianceMilli, 0n));
  // المؤرّخ مستقبلاً (5 @ 20) + بيع السنة (3) + المتأخر (2) من R1 بمتوسّطها 20 = 10 × 20 = 200,000
  // + سدّ حفرة R2 في يناير: 4 بيعت قبل البدء بلا تكلفة (لا متوسّط يومها) سُدّت بتحميلٍ @ 8 ⇒ فرق 32,000 تكلفة مبيعات السنة
  assert.equal(s.fyVarianceMilli, 32_000n);
  assert.equal(s.fyCogsMilli, 232_000n);
  assert.equal(s.holesFy.count, 1);
  assert.equal(s.moveCount, rr.outputs.length);
  assert.equal(s.productCount, 3);
});

test('summarizeCosting: الرصيد بلا تكلفة والسالب عند بداية السنة من الحالة الملتقطة (لا من التدفّق)، مرتّبةً بالكمية تنازلياً', async () => {
  const { rr } = await yearRun();
  const s = summarizeCosting(rr.outputs, rr.state, opts({ atCutover: rr.captured[0] }));
  assert.deepEqual(s.uncostedAtCutover, [{ productId: 'C', location: 'WH', uncostedQty: 6 }]);
  assert.equal(s.uncostedAtCutoverTotalQty, 6);
  assert.deepEqual(s.negativeAtCutover, [{ productId: 'B', location: 'VAN:R2', qtyBase: -4 }]);
  // بلا حالة ملتقطة ⇒ فارغة
  const none = summarizeCosting(rr.outputs, rr.state, opts());
  assert.deepEqual([none.uncostedAtCutover, none.negativeAtCutover, none.uncostedAtCutoverTotalQty], [[], [], 0]);
  // الترتيب: كمية تنازلياً ثم الصنف ثم الموقع (المستودع أولاً)
  const st = rr.captured[0];
  const fake = { ...st, locs: new Map(st.locs) };
  fake.locs.set('A|VAN:Z', { costedQtyU: 0, uncostedQtyU: 9_000_000, valueMilli: 0n, lastAvg: null });
  fake.locs.set('A|WH', { costedQtyU: 1_000_000, uncostedQtyU: 6_000_000, valueMilli: 5n, lastAvg: null });
  fake.locs.set('D|WH', { costedQtyU: -9_000_000, uncostedQtyU: 0, valueMilli: 0n, lastAvg: null });
  const s2 = summarizeCosting(rr.outputs, rr.state, opts({ atCutover: fake }));
  assert.deepEqual(s2.uncostedAtCutover.map((u) => `${u.productId}|${u.location}|${u.uncostedQty}`), ['A|VAN:Z|9', 'A|WH|6', 'C|WH|6']);
  assert.equal(s2.uncostedAtCutoverTotalQty, 21);
  assert.deepEqual(s2.negativeAtCutover.map((n) => `${n.productId}|${n.qtyBase}`), ['D|-9', 'B|-4']);
});

test('summarizeCosting: حُفر السنة (فرق ≠ 0 لغير المشمول) — العدد والمجموع وعيّنة بالأكبر |فرق| على الموقع المستقبِل', async () => {
  // المثال ب (§5): بيع من سيارة لم تُحمَّل ثم تحميل يسدّ الحفرة بفرق 6,000 — كله في السنة
  const db = new CostingFakeDb();
  db.clock = new Date('2026-02-01T08:00:00.000Z').getTime();
  db.addReceipt('B', 10, 8);
  db.addInvoice({ type: 'CREDIT', salesRepId: 'R2', items: [{ productId: 'B', qty: 4 }] });
  db.addReceipt('B', 10, 11);
  db.addVanLoad({ salesRepId: 'R2', items: [{ productId: 'B', qty: 10 }] });
  // وحفرة مستودع أصغر: مكشوف ثم وارد بسعر أعلى
  db.addInvoice({ type: 'CREDIT', salesRepId: null, items: [{ productId: 'Q', qty: 1 }] });
  db.addReceipt('Q', 5, 3);
  const lm = await loadMoves(asPrisma<CostingDb>(db), 't1', { until: new Date('2030-01-01'), currencyDecimals: 2 });
  const rr = replay(lm.moves, { currencyDecimals: 2 });
  const s = summarizeCosting(rr.outputs, rr.state, opts());
  const holes = rr.outputs.filter((o) => o.varianceMilli !== 0n);
  assert.equal(s.holesFy.count, holes.length);
  assert.equal(s.holesFy.varianceMilli, holes.reduce((a, o) => a + o.varianceMilli, 0n));
  assert.equal(s.holesFy.sample[0].varianceMilli, 6_000n);
  assert.equal(s.holesFy.sample[0].location, 'VAN:R2', 'التحويل: الفرق على الهدف');
  assert.ok(s.holesFy.sample.length <= HOLES_SAMPLE);
  for (let i = 1; i < s.holesFy.sample.length; i++) {
    const a = s.holesFy.sample[i - 1].varianceMilli;
    const b = s.holesFy.sample[i].varianceMilli;
    assert.ok((a < 0n ? -a : a) >= (b < 0n ? -b : b));
  }
});

test('summarizeCosting: التحذيرات — كل رمز خطوة بعدده وعيّنة 20 مفتاحاً بترتيب الطيّ، ثم تحذيرات المصادر كما هي', () => {
  const moves: Move[] = [];
  for (let i = 0; i < 25; i++) {
    // سيارة لم تُحمَّل والمستودع فارغ ⇒ ZERO_RATE_DEFICIT وNEGATIVE_STOCK وUNCOSTED_OUT
    moves.push({
      key: saleOutKey(`it${String(i).padStart(2, '0')}`), kind: 'VAN_SALE', effectAt: new Date('2026-02-01'),
      cursor: { createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)), id: `ae${i}` }, productId: 'P', location: 'VAN:R1', baseQty: -1,
      refType: 'INVOICE', refId: `in${i}`, itemId: `it${i}`,
    });
  }
  const rr = replay(moves, { currencyDecimals: 2 });
  const s = summarizeCosting(rr.outputs, rr.state, opts({ streamWarnings: [{ code: 'DUPLICATE_PRIMARY_ROW', count: 2, sample: ['x', 'y'] }, { code: 'NEGATIVE_RECEIVE', count: 0, sample: [] }] }));
  const neg = s.warnings.find((w) => w.code === 'NEGATIVE_STOCK')!;
  assert.equal(neg.count, 25);
  assert.equal(neg.sample.length, 20);
  assert.equal(neg.sample[0], saleOutKey('it00'));
  assert.deepEqual(s.warnings.map((w) => w.code), ['NEGATIVE_STOCK', 'UNCOSTED_OUT', 'ZERO_RATE_DEFICIT', 'DUPLICATE_PRIMARY_ROW']);
  assert.deepEqual(s.warnings[3], { code: 'DUPLICATE_PRIMARY_ROW', count: 2, sample: ['x', 'y'] });
});

test('summarizeCosting: الافتتاح لا يخلط مواقع الحالة — مرتجعٌ مشطوب قبل البدء مذكِّرةٌ بلا أثر مخزني، وشطبه في السنة يدخل fyWriteOff', async () => {
  const db = new CostingFakeDb();
  db.clock = new Date('2025-12-10T08:00:00.000Z').getTime();
  db.addReceipt('A', 10, 21);
  db.addVanLoad({ salesRepId: 'R1', items: [{ productId: 'A', qty: 10 }] });
  const sale = db.addInvoice({ type: 'CREDIT', salesRepId: 'R1', items: [{ productId: 'A', qty: 10 }] });
  db.clock = new Date('2026-01-10T08:00:00.000Z').getTime();
  // المثال هـ: مرتجع 3 تالف مرتبط ⇒ شطب 63,000 في السنة
  db.addInvoice({ type: 'RETURN', salesRepId: 'R1', returnToStock: false, items: [{ productId: 'A', qty: 3, returnOfItemId: sale.itemIds[0] }] });
  const lm = await loadMoves(asPrisma<CostingDb>(db), 't1', { until: new Date('2030-01-01'), currencyDecimals: 2 });
  const rr = replay(lm.moves, { currencyDecimals: 2 }, { captureAt: [CUT_START] });
  const s = summarizeCosting(rr.outputs, rr.state, opts({ atCutover: rr.captured[0] }));
  assert.equal(s.fyWriteOffMilli, 63_000n);
  assert.equal(s.fyCogsMilli, -63_000n, 'الشطب يُخرج تكلفته من 511001 إلى 514001');
  assert.deepEqual(s.openingByLocation, [], 'كل شيء بيع قبل البدء: لا رصيد افتتاحي');
  assert.equal(whItemKey('x').startsWith('COST:WH_ENTRY:'), true);
});

test('summarizeCosting صرفة: لا تعدّل مدخلاتها، وحتمية (نتيجتان متطابقتان)', async () => {
  const { rr } = await yearRun();
  const before = JSON.stringify(rr.outputs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const a = summarizeCosting(rr.outputs, rr.state, opts({ atCutover: rr.captured[0] }));
  const b = summarizeCosting([...rr.outputs] as StepOutput[], rr.state, opts({ atCutover: rr.captured[0] }));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(rr.outputs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
});
