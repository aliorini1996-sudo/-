// «تتبّع اللوط» — الصريح الذي لا يكفي على مسارات الأخذ (explicitShort: 'SPILL'، طلب المالك ١٦ نوفمبر ٢٠٢٦):
// «لا مانع من أن يأخذ من LOT آخر في حال انتهت هذه التشغيلة». التشغيلة المسمّاة «خذ منها أولاً» لا «يجب منها»، والرفض الوحيد
// الباقي نقص الصنف كله. ويثبت هنا أن REJECT (الافتراضي) لم يتغيّر، وأن I1–I4 تصمد في اختبار خاصيّةٍ عشوائي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOT_EPS, LOT_ROW_FLAGS, allocateOut, allocateOutLines, buildPlaceView, isLotExpiredOn, isLotQty, zeroBuckets,
  type AllocResult, type AllocRow, type BucketQty, type LotMeta, type LotRaw, type LotRef, type OutLine, type OutLinesResult, type PlaceLotView,
} from '../services/lots';

const DAY = '2026-11-16';

interface LotSpec {
  id: string; s: number; status?: 'ACTIVE' | 'BLOCKED'; blockKind?: 'HOLD' | 'RECALL' | null; expiry?: string | null; productId?: string;
}

function metaOf(l: LotSpec): LotMeta {
  return {
    id: l.id, productId: l.productId ?? 'p', lotNumber: `N-${l.id}`, productionDate: null, expiryDate: l.expiry === undefined ? '2027-06-01' : l.expiry,
    status: l.status ?? 'ACTIVE', blockKind: l.blockKind ?? null, blockedAt: null, createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/** عرض مكانٍ: `unknown` رصيد غير المسمّى (total − Σ المسمّى)، وقد يكون سالباً */
function view(lots: LotSpec[], unknown = 0): PlaceLotView {
  const named = new Map<string, LotRaw>();
  const metas = new Map<string, LotMeta>();
  for (const l of lots) {
    named.set(l.id, { raw: { SELLABLE: l.s, EXPIRED: 0, DAMAGED: 0 }, held: zeroBuckets() });
    metas.set(l.id, metaOf(l));
  }
  const sum = lots.reduce((s, l) => s + l.s, 0);
  const total: BucketQty = { SELLABLE: sum + unknown, EXPIRED: 0, DAMAGED: 0 };
  return buildPlaceView({ productId: 'p', place: 'VAN', vanKey: 'r', total, named, heldUnknown: zeroBuckets(), metas });
}

/** مشهد الاستنساخ: A ‏3 (12-01)، B ‏20 (03-01)، X ‏2 منتهية، H موقوفة HOLD، R مسحوبة RECALL، وغير المسمّى 5 */
const SCENE: LotSpec[] = [
  { id: 'A', s: 3, expiry: '2026-12-01' },
  { id: 'B', s: 20, expiry: '2027-03-01' },
  { id: 'X', s: 2, expiry: '2026-11-10' },
  { id: 'H', s: 5, expiry: '2026-11-20', status: 'BLOCKED', blockKind: 'HOLD' },
  { id: 'R', s: 5, expiry: '2026-11-18', status: 'BLOCKED', blockKind: 'RECALL' },
];
const scene = (unknown = 5) => view(SCENE, unknown);

const outLines = (o: Partial<Parameters<typeof allocateOutLines>[0]> & { view: PlaceLotView; lines: OutLine[] }): OutLinesResult =>
  allocateOutLines({ productId: 'p', productName: 'حليب', day: DAY, mode: 'SALE', allowUnknown: true, explicitShort: 'SPILL', ...o });
const one = (o: Partial<Parameters<typeof allocateOut>[0]> & { view: PlaceLotView; qty: number }): AllocResult =>
  allocateOut({ productId: 'p', productName: 'حليب', unitFactor: 1, day: DAY, mode: 'SALE', allowUnknown: true, explicitShort: 'SPILL', ...o });

function okLines(r: OutLinesResult): Extract<OutLinesResult, { ok: true }> {
  if (!r.ok) assert.fail(`متوقَّع نجاح، وصل ${r.error.code}: ${r.error.message}`);
  return r;
}
function okRows(r: AllocResult): Extract<AllocResult, { ok: true }> {
  if (!r.ok) assert.fail(`متوقَّع نجاح، وصل ${r.error.code}: ${r.error.message}`);
  return r;
}
function errOf(r: AllocResult | OutLinesResult, code: string, status?: number) {
  assert.equal(r.ok, false, `متوقَّع ${code}`);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.error.code, code);
  if (status != null) assert.equal(r.error.status, status);
  return r.error;
}
const brief = (rows: AllocRow[]) => rows.map((r) => [r.lotId, +r.qty.toFixed(6), r.certainty, r.flags]);
const fallbacks = (w: { code: string; detail?: Record<string, unknown> }[]) => w.filter((x) => x.code === 'LOT_EXPLICIT_FALLBACK').map((x) => x.detail);

// ── الأساس: ما في التشغيلة ثم الأقرب انتهاءً ──
test('SPILL: تشغيلةٌ لا تكفي — يُؤخذ ما فيها CONFIRMED والباقي FEFO موسوماً EXPLICIT_FALLBACK، والتحذير يصف ما جرى', () => {
  const r = okRows(one({ view: scene(), qty: 10, explicit: [{ lotId: 'A', qty: 10 }] }));
  assert.deepEqual(brief(r.rows), [['A', 3, 'CONFIRMED', []], ['B', 7, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(fallbacks(r.warnings), [{ line: 0, lotId: 'A', lotNumber: 'N-A', reason: 'SHORT', requested: 10, taken: 3, spilled: [{ lotId: 'B', qty: 7 }] }]);
  assert.deepEqual(r.warnings.map((w) => w.code), ['LOT_EXPLICIT_FALLBACK']);
  // REJECT (الافتراضي) كما كان: 409 على التشغيلة نفسها
  const e = errOf(allocateOut({ productId: 'p', productName: 'حليب', unitFactor: 1, day: DAY, mode: 'SALE', allowUnknown: true, view: scene(), qty: 10, explicit: [{ lotId: 'A', qty: 10 }] }),
    'LOT_STOCK_INSUFFICIENT', 409);
  assert.equal(e.detail?.lotId, 'A');
});

test('SPILL: المنتهية لا يُؤخذ منها شيء (I4) والكمية كلها FEFO بسبب EXPIRED؛ ويوم الانتهاء نفسه ليس انتهاءً', () => {
  const r = okRows(one({ view: scene(), qty: 10, explicit: [{ lotId: 'X', qty: 10 }] }));
  assert.deepEqual(brief(r.rows), [['A', 3, 'ASSUMED', ['EXPLICIT_FALLBACK']], ['B', 7, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(fallbacks(r.warnings), [{ line: 0, lotId: 'X', lotNumber: 'N-X', reason: 'EXPIRED', requested: 10, taken: 0, spilled: [{ lotId: 'A', qty: 3 }, { lotId: 'B', qty: 7 }] }]);
  // تشغيلةٌ تنتهي يوم المستند: آخر يومٍ صالح ⇒ تُعطي كل ما طُلب بلا إكمال
  const v = view([{ id: 'E', s: 4, expiry: DAY }, { id: 'B', s: 20, expiry: '2027-03-01' }]);
  const e = okRows(one({ view: v, qty: 4, explicit: [{ lotId: 'E', qty: 4 }] }));
  assert.deepEqual(brief(e.rows), [['E', 4, 'CONFIRMED', []]]);
  assert.deepEqual(e.warnings, []);
  // REJECT كما كان
  errOf(allocateOut({ productId: 'p', productName: 'حليب', unitFactor: 1, day: DAY, mode: 'SALE', allowUnknown: true, view: scene(), qty: 2, explicit: [{ lotId: 'X', qty: 2 }] }), 'LOT_EXPIRED', 422);
});

test('SPILL: الموقوفة HOLD والمسحوبة RECALL لا يُؤخذ منهما (I4) — BLOCKED والباقي من المؤهَّلين بـFEFO', () => {
  for (const id of ['H', 'R']) {
    const r = okRows(one({ view: scene(), qty: 4, explicit: [{ lotId: id, qty: 4 }] }));
    assert.deepEqual(brief(r.rows), [['A', 3, 'ASSUMED', ['EXPLICIT_FALLBACK']], ['B', 1, 'ASSUMED', ['EXPLICIT_FALLBACK']]], id);
    assert.equal(r.rows.some((x) => x.lotId === 'H' || x.lotId === 'R'), false);
    assert.deepEqual(fallbacks(r.warnings), [{ line: 0, lotId: id, lotNumber: `N-${id}`, reason: 'BLOCKED', requested: 4, taken: 0, spilled: [{ lotId: 'A', qty: 3 }, { lotId: 'B', qty: 1 }] }]);
    errOf(allocateOut({ productId: 'p', productName: 'حليب', unitFactor: 1, day: DAY, mode: 'SALE', allowUnknown: true, view: scene(), qty: 1, explicit: [{ lotId: id, qty: 1 }] }), 'LOT_BLOCKED', 422);
  }
});

test('SPILL: الباقي بعد المسمّاة إلى غير المسمّى (LOT_FROM_UNKNOWN)، ونقص الصنف كله 409 بلا lotId ومعه أسطره؛ وallowUnknown=false لا يمسّ غير المسمّى', () => {
  // المؤهَّل: A 3 + B 20 = 23، وغير المسمّى 5
  const r = okRows(one({ view: scene(), qty: 26, explicit: [{ lotId: 'A', qty: 26 }] }));
  assert.deepEqual(brief(r.rows), [['A', 3, 'CONFIRMED', []], ['B', 20, 'ASSUMED', ['EXPLICIT_FALLBACK']], [null, 3, 'UNKNOWN', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(r.warnings.map((w) => w.code), ['LOT_EXPLICIT_FALLBACK', 'LOT_FROM_UNKNOWN']);
  assert.deepEqual(fallbacks(r.warnings)[0]?.spilled, [{ lotId: 'B', qty: 20 }, { lotId: null, qty: 3 }]);
  const e = errOf(outLines({ view: scene(), lines: [{ idx: 0, qty: 29, unitFactor: 1, explicit: [{ lotId: 'A', qty: 29 }] }, { idx: 1, qty: 1, unitFactor: 1 }] }), 'LOT_STOCK_INSUFFICIENT', 409);
  assert.equal(e.detail?.lotId, undefined);
  assert.equal(e.detail?.available, 28);
  assert.equal(e.detail?.wanted, 30);
  assert.deepEqual(e.detail?.lines, [0, 1]);
  // بلا غير المسمّى
  const n = okRows(one({ view: scene(), qty: 23, explicit: [{ lotId: 'A', qty: 23 }], allowUnknown: false }));
  assert.deepEqual(brief(n.rows), [['A', 3, 'CONFIRMED', []], ['B', 20, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  errOf(one({ view: scene(), qty: 24, explicit: [{ lotId: 'A', qty: 24 }], allowUnknown: false }), 'LOT_STOCK_INSUFFICIENT', 409);
});

test('SPILL D26: سطران على تشغيلةٍ واحدة يتتابعان على متاحها، وسطر الكرتون يُخدم أولاً', () => {
  const v = () => view([{ id: 'A', s: 10, expiry: '2026-12-01' }, { id: 'B', s: 20, expiry: '2027-03-01' }]);
  const r = okLines(outLines({ view: v(), lines: [
    { idx: 0, qty: 6, unitFactor: 1, explicit: [{ lotId: 'A', qty: 6 }] },
    { idx: 1, qty: 6, unitFactor: 1, explicit: [{ lotId: 'A', qty: 6 }] },
  ] }));
  assert.deepEqual(brief(r.lines.get(0)!), [['A', 6, 'CONFIRMED', []]]);
  assert.deepEqual(brief(r.lines.get(1)!), [['A', 4, 'CONFIRMED', []], ['B', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(fallbacks(r.warnings), [{ line: 1, lotId: 'A', lotNumber: 'N-A', reason: 'SHORT', requested: 6, taken: 4, spilled: [{ lotId: 'B', qty: 2 }] }]);
  // سطر الكرتون (F = 6) يأخذ أولاً ولو جاء ثانياً
  const c = okLines(outLines({ view: v(), lines: [
    { idx: 0, qty: 6, unitFactor: 1, explicit: [{ lotId: 'A', qty: 6 }] },
    { idx: 1, qty: 6, unitFactor: 6, explicit: [{ lotId: 'A', qty: 6 }] },
  ] }));
  assert.deepEqual(brief(c.lines.get(1)!), [['A', 6, 'CONFIRMED', []]]);
  assert.deepEqual(brief(c.lines.get(0)!), [['A', 4, 'CONFIRMED', []], ['B', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  // وسطرٌ بلا صريح يأخذ مما تركه الصريح وباقيه
  const m = okLines(outLines({ view: v(), lines: [
    { idx: 0, qty: 12, unitFactor: 1, explicit: [{ lotId: 'A', qty: 12 }] },
    { idx: 1, qty: 5, unitFactor: 1 },
  ] }));
  assert.deepEqual(brief(m.lines.get(0)!), [['A', 10, 'CONFIRMED', []], ['B', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(brief(m.lines.get(1)!), [['B', 5, 'ASSUMED', []]]);
});

test('SPILL D22: الوحدة المقسومة بين التشغيلة المختارة والباقي SPLIT_UNIT، ومرحلة الكراتين في الباقي', () => {
  const v = () => view([{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 100, expiry: '2027-03-01' }]);
  const r = okLines(outLines({ view: v(), lines: [{ idx: 4, qty: 48, unitFactor: 24, explicit: [{ lotId: 'A', qty: 48 }] }] }));
  assert.deepEqual(brief(r.lines.get(4)!), [['A', 30, 'CONFIRMED', ['SPLIT_UNIT']], ['B', 18, 'ASSUMED', ['SPLIT_UNIT', 'EXPLICIT_FALLBACK']]]);
  assert.deepEqual(r.warnings.map((w) => [w.code, w.detail?.idx ?? w.detail?.line]), [['LOT_EXPLICIT_FALLBACK', 4], ['LOT_SPLIT_UNIT', 4]]);
  assert.deepEqual(r.warnings.find((w) => w.code === 'LOT_SPLIT_UNIT')?.detail, { unitFactor: 24, idx: 4 });
  // 72 = A 30 + B (كرتون 24 + 18) — صفّ B واحد
  const k = okLines(outLines({ view: v(), lines: [{ idx: 0, qty: 72, unitFactor: 24, explicit: [{ lotId: 'A', qty: 72 }] }] }));
  assert.deepEqual(brief(k.lines.get(0)!), [['A', 30, 'CONFIRMED', ['SPLIT_UNIT']], ['B', 42, 'ASSUMED', ['SPLIT_UNIT', 'EXPLICIT_FALLBACK']]]);
  // حدّ وحدةٍ سليم: A 24 من 48 والباقي كرتونٌ كامل من B ⇒ بلا SPLIT_UNIT
  const w = view([{ id: 'A', s: 24, expiry: '2026-12-01' }, { id: 'B', s: 100, expiry: '2027-03-01' }]);
  const s = okLines(outLines({ view: w, lines: [{ idx: 0, qty: 48, unitFactor: 24, explicit: [{ lotId: 'A', qty: 48 }] }] }));
  assert.deepEqual(brief(s.lines.get(0)!), [['A', 24, 'CONFIRMED', []], ['B', 24, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.equal(s.warnings.some((x) => x.code === 'LOT_SPLIT_UNIT'), false);
});

test('SPILL: الصريح الكافي مطابقٌ لـREJECT حرفاً، وصفّا اللوط الواحد في السطر يُضمّان بأضعف يقين', () => {
  const cases: { qty: number; explicit: LotRef[] }[] = [
    { qty: 7, explicit: [{ lotId: 'A', qty: 2 }, { lotId: 'B', qty: 5 }] },
    { qty: 5, explicit: [{ lotId: null, qty: 2 }, { lotId: 'B', qty: 3 }] },
    { qty: 3, explicit: [{ lotId: 'A', qty: 1 }, { lotId: 'A', qty: 2 }] },
  ];
  for (const c of cases) {
    const base = { productId: 'p', productName: 'حليب', unitFactor: 1, day: DAY, mode: 'SALE' as const, allowUnknown: true, view: scene(), ...c };
    assert.deepEqual(allocateOut({ ...base, explicitShort: 'SPILL' }), allocateOut(base), JSON.stringify(c));
    assert.deepEqual(allocateOut({ ...base, explicitShort: 'SPILL' }), allocateOut({ ...base, explicitShort: 'REJECT' }));
  }
  // B 5 كافية وA 5 فيها 3 ⇒ الباقي 2 من B (الأقرب انتهاءً المؤهَّل بعد A) فصفّ B واحد: 7 ASSUMED
  const r = okRows(one({ view: scene(), qty: 10, explicit: [{ lotId: 'B', qty: 5 }, { lotId: 'A', qty: 5 }] }));
  assert.deepEqual(brief(r.rows), [['B', 7, 'ASSUMED', ['EXPLICIT_FALLBACK']], ['A', 3, 'CONFIRMED', []]]);
  assert.equal(new Set(r.rows.map((x) => x.lotId)).size, r.rows.length);
});

test('SPILL: أخطاء الطلب نفسه باقية — LOT_NOT_FOUND (تشغيلة شركةٍ أخرى)، LOT_PRODUCT_MISMATCH، LOT_QTY_INVALID', () => {
  const lookup = new Map<string, LotMeta>([['A', metaOf(SCENE[0])], ['O', metaOf({ id: 'O', s: 0, productId: 'other' })]]);
  errOf(one({ view: scene(), qty: 1, explicit: [{ lotId: 'foreign', qty: 1 }], lookup }), 'LOT_NOT_FOUND', 422);
  errOf(one({ view: scene(), qty: 1, explicit: [{ lotId: 'O', qty: 1 }], lookup }), 'LOT_PRODUCT_MISMATCH', 422);
  errOf(one({ view: scene(), qty: 6, explicit: [{ lotId: 'A', qty: 5 }] }), 'LOT_QTY_INVALID', 422);
  errOf(one({ view: scene(), qty: 1.00001, explicit: [{ lotId: 'A', qty: 1.00001 }] }), 'LOT_QTY_INVALID', 422);
  // تشغيلةٌ للصنف بلا رصيدٍ هنا (بلا lookup): صالحها صفر فتُكمَل كلها
  const r = okRows(one({ view: scene(), qty: 2, explicit: [{ lotId: 'missing', qty: 2 }] }));
  assert.deepEqual(brief(r.rows), [['A', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(fallbacks(r.warnings), [{ line: 0, lotId: 'missing', lotNumber: null, reason: 'SHORT', requested: 2, taken: 0, spilled: [{ lotId: 'A', qty: 2 }] }]);
});

test('SPILL: صريح غير المسمّى الناقص يُمنح ما فيه ويُكمل من المسمّاة؛ وغير المسمّى السالب لا يُمسّ (I2)', () => {
  const r = okRows(one({ view: scene(3), qty: 5, explicit: [{ lotId: null, qty: 5 }] }));
  assert.deepEqual(brief(r.rows), [[null, 3, 'UNKNOWN', []], ['A', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(fallbacks(r.warnings), [{ line: 0, lotId: null, lotNumber: null, reason: 'UNKNOWN_SHORT', requested: 5, taken: 3, spilled: [{ lotId: 'A', qty: 2 }] }]);
  const neg = okRows(one({ view: scene(-2), qty: 5, explicit: [{ lotId: null, qty: 5 }] }));
  assert.deepEqual(brief(neg.rows), [['A', 3, 'ASSUMED', ['EXPLICIT_FALLBACK']], ['B', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.equal(neg.rows.some((x) => x.lotId == null), false);
  // allowUnknown=false: الصريح الفارغ يُمنح صفراً
  const off = okRows(one({ view: scene(), qty: 2, explicit: [{ lotId: null, qty: 2 }], allowUnknown: false }));
  assert.deepEqual(brief(off.rows), [['A', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
});

test('SPILL: الكسور على شبكة الأربع خانات — الباقي 6.6667 بالضبط وكل صفٍّ isLotQty', () => {
  const v = view([{ id: 'A', s: 3.3333, expiry: '2026-12-01' }, { id: 'B', s: 20, expiry: '2027-03-01' }]);
  const r = okRows(one({ view: v, qty: 10, explicit: [{ lotId: 'A', qty: 10 }] }));
  assert.deepEqual(r.rows.map((x) => [x.lotId, x.qty]), [['A', 3.3333], ['B', 6.6667]]);
  for (const x of r.rows) assert.ok(isLotQty(x.qty), String(x.qty));
  assert.ok(Math.abs(r.rows.reduce((s, x) => s + x.qty, 0) - 10) <= LOT_EPS);
});

test('REJECT الافتراضي بلا تغيير: الأسطر بلا صريح مطابقةٌ في الوضعين، وSPILL لا يمسّ الإعادة', () => {
  const lines: OutLine[] = [{ idx: 0, qty: 30, unitFactor: 24 }, { idx: 1, qty: 5, unitFactor: 1 }];
  const v = view([{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 20, expiry: '2027-03-01' }], 2);
  const base = { productId: 'p', productName: 'حليب', day: DAY, mode: 'SALE' as const, allowUnknown: true, view: v, lines };
  assert.deepEqual(allocateOutLines({ ...base, explicitShort: 'SPILL' }), allocateOutLines(base));
  // نقص الأسطر بلا صريح: الرسالة والتفاصيل كما كانت (بلا lines)
  const short = { ...base, lines: [{ idx: 0, qty: 60, unitFactor: 1 }] };
  assert.deepEqual(allocateOutLines({ ...short, explicitShort: 'SPILL' }), allocateOutLines(short));
  // الإعادة بتلميح: لا صريح فيها فالوضعان سواء
  const rp = { ...base, replay: { at: new Date('2026-11-15T10:00:00Z'), clamped: false }, lines: [{ idx: 0, qty: 4, unitFactor: 1, hint: [{ lotId: 'B', qty: 4 }] }] };
  assert.deepEqual(allocateOutLines({ ...rp, explicitShort: 'SPILL' }), allocateOutLines(rp));
});

test('SPILL مع الإعادة (مفتاحٌ بلحظة جهاز): باقي الصريح من المؤهَّل وحده، والأسطر بلا صريح بالطبقات كما كانت', () => {
  const r = okLines(outLines({
    view: scene(), replay: { at: new Date('2026-11-15T10:00:00Z'), clamped: false },
    lines: [{ idx: 0, qty: 5, unitFactor: 1, explicit: [{ lotId: 'X', qty: 5 }] }, { idx: 1, qty: 2, unitFactor: 1 }],
  }));
  assert.deepEqual(brief(r.lines.get(0)!), [['A', 3, 'ASSUMED', ['EXPLICIT_FALLBACK']], ['B', 2, 'ASSUMED', ['EXPLICIT_FALLBACK']]]);
  assert.deepEqual(brief(r.lines.get(1)!), [['B', 2, 'ASSUMED', []]]);
});

// ── خاصيّة: I1–I4 والتطابق مع REJECT على مدخلاتٍ عشوائية ──

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

test('خاصيّة SPILL: I1 لا لوط سالب، I2 غير المسمّى ≥ min(0، قبله)، I3 Σ السطر = كميته، I4 لا شيء من موقوفٍ أو منتهٍ؛ والرفض نقص الصنف وحده؛ وREJECT الناجح = SPILL', () => {
  const rand = rng(20261116);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pickOne = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  const grid = (n: number) => Math.round(n * 10000) / 10000;
  let spilled = 0, rejected = 0, okCount = 0;
  for (let iter = 0; iter < 600; iter++) {
    const lots: LotSpec[] = [];
    const n = int(0, 5);
    for (let i = 0; i < n; i++) {
      const kind = int(0, 9);
      lots.push({
        id: `L${i}`, s: int(0, 4) === 0 ? grid(rand() * 7) : int(-2, 30),
        expiry: kind === 0 ? '2026-11-01' : kind === 1 ? DAY : kind === 2 ? null : `2027-0${int(1, 9)}-1${int(0, 9)}`,
        status: kind === 3 || kind === 4 ? 'BLOCKED' : 'ACTIVE', blockKind: kind === 3 ? 'HOLD' : kind === 4 ? 'RECALL' : null,
      });
    }
    const unknown = int(-3, 8);
    const v = view(lots, unknown);
    const allowUnknown = rand() < 0.7;
    const lines: OutLine[] = [];
    const nl = int(1, 3);
    for (let i = 0; i < nl; i++) {
      const F = pickOne([1, 1, 6, 24]);
      const qty = int(0, 4) === 0 ? grid(rand() * 9 + 0.0001) : int(1, 40);
      const line: OutLine = { idx: i, qty, unitFactor: F };
      if (rand() < 0.65) {
        const ids = [...lots.map((l) => l.id), null, 'ghost'];
        const k = rand() < 0.5 ? qty : grid(rand() * qty);
        const refs: LotRef[] = [];
        if (k > LOT_EPS) refs.push({ lotId: pickOne(ids), qty: k });
        if (qty - k > LOT_EPS) refs.push({ lotId: pickOne(ids), qty: grid(qty - k) });
        if (refs.length && Math.abs(refs.reduce((s, r) => s + r.qty, 0) - qty) <= LOT_EPS) line.explicit = refs;
      }
      lines.push(line);
    }
    const args = { productId: 'p', productName: 'حليب', day: DAY, mode: 'SALE' as const, allowUnknown, view: v, lines };
    const r = allocateOutLines({ ...args, explicitShort: 'SPILL' });
    const ctx = JSON.stringify({ lots, unknown, allowUnknown, lines });
    const total = lines.reduce((s, l) => s + l.qty, 0);
    const eligible = v.lots.filter((l) => l.meta.status === 'ACTIVE' && !isLotExpiredOn(l.meta, DAY) && l.usable.SELLABLE > LOT_EPS);
    const uu = v.unknownUsable!.SELLABLE;
    const available = eligible.reduce((s, l) => s + l.usable.SELLABLE, 0) + (allowUnknown && uu > LOT_EPS ? uu : 0);
    if (!r.ok) {
      rejected++;
      assert.equal(r.error.code, 'LOT_STOCK_INSUFFICIENT', ctx);
      assert.equal(r.error.detail?.lotId, undefined, ctx);
      assert.ok(total > available + LOT_EPS, `رفضٌ والصنف يكفي: ${ctx}`);
      continue;
    }
    okCount++;
    assert.ok(total <= available + LOT_EPS * 10, `قبولٌ والصنف ناقص: ${ctx}`);
    const byLot = new Map<string, number>();
    let unk = 0;
    for (const l of lines) {
      const rows = r.lines.get(l.idx)!;
      // I3
      assert.ok(Math.abs(rows.reduce((s, x) => s + x.qty, 0) - l.qty) <= LOT_EPS * 4, `I3: ${ctx}`);
      assert.equal(new Set(rows.map((x) => x.lotId)).size, rows.length, `صفّا لوطٍ في سطر: ${ctx}`);
      for (const x of rows) {
        assert.ok(x.qty > 0, ctx);
        if (x.flags.includes('EXPLICIT_FALLBACK')) { spilled++; assert.ok(l.explicit, `وسمٌ على سطرٍ بلا صريح: ${ctx}`); }
        for (const f of x.flags) assert.ok((LOT_ROW_FLAGS as readonly string[]).includes(f));
        if (x.lotId == null) { unk += x.qty; continue; }
        assert.ok(isLotQty(x.qty), `صفٌّ مسمّى خارج الشبكة ${x.qty}: ${ctx}`);
        byLot.set(x.lotId, (byLot.get(x.lotId) ?? 0) + x.qty);
      }
    }
    for (const [id, q] of byLot) {
      const b = v.lots.find((l) => l.lotId === id);
      assert.ok(b, `لوطٌ غائب عن العرض: ${id} ${ctx}`);
      // I4
      assert.equal(b!.meta.status, 'ACTIVE', `I4 موقوف: ${ctx}`);
      assert.equal(isLotExpiredOn(b!.meta, DAY), false, `I4 منتهٍ: ${ctx}`);
      // I1
      assert.ok(b!.usable.SELLABLE - q >= -LOT_EPS * 4, `I1 ${id}: ${ctx}`);
    }
    // I2
    if (unk > 0) assert.ok(allowUnknown, `غير المسمّى بلا إذن: ${ctx}`);
    assert.ok(uu - unk >= Math.min(0, uu) - LOT_EPS * 4, `I2: ${ctx}`);
    // REJECT الناجح ⇒ SPILL مطابقٌ له حرفاً
    const rj = allocateOutLines(args);
    if (rj.ok) assert.deepEqual(r, rj, ctx);
  }
  // المولِّد يغطّي الأوجه الثلاثة فعلاً
  assert.ok(spilled > 50 && rejected > 20 && okCount > 200, `${spilled}/${rejected}/${okCount}`);
});
