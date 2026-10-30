// «تتبّع اللوط» (P0) — خوارزميات التوزيع والقواعد الصرفة والأقفال والأخطاء (المواصفة §٨.١ lots-allocate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNumberRetry } from '../utils/helpers';
import { factorOf, unitFields } from '../services/units';
import {
  ClientRefRace, LOT_EPS, LotError, aggregateRequest, allocateOut, allocateOutLines, allocateReturnFromSale, asLockBusy, asLotBusy, buildPlaceView,
  distributeToLines, fefoCompare, foldVanLots, heldUnknownOf, invoiceItemLotColumns, isLotExpiredOn, isLotQty, lotBaseQty, lotDatesProblem, lotErr,
  lotErrorBody, lotHttpError, lotLockKey, lotRemovalsOf, multiLotWarning, normalizeLotNumber, parseLotHint, parseLotRefsStrict,
  pickOutSources, refsOfByLot, removalKeepsLots, replayMoment, roundLot, sortedLockKeys, splitAvailability, stampFromRows, zeroBuckets,
  type AllocResult, type AllocRow, type BucketQty, type LotMeta, type LotRaw, type LotRemovalItem, type OutLine, type PlaceLotView, type SaleLotRow,
} from '../services/lots';

const DAY = '2026-11-10';
/** لحظة البيع دون اتصال في اختبارات الإعادة */
const AT = new Date('2026-11-09T10:00:00Z');

interface LotSpec {
  id: string; s?: number; e?: number; d?: number; held?: number;
  status?: 'ACTIVE' | 'BLOCKED'; blockKind?: 'HOLD' | 'RECALL' | null; blockedAt?: string | null;
  expiry?: string | null; production?: string | null; createdAt?: string; productId?: string; firstIn?: string;
}

function view(opts: { lots?: LotSpec[]; total?: Partial<BucketQty> | null; heldUnknown?: Partial<BucketQty>; place?: 'WAREHOUSE' | 'VAN' }): PlaceLotView {
  const lots = opts.lots ?? [];
  const named = new Map<string, LotRaw>();
  const metas = new Map<string, LotMeta>();
  const firstInAt = new Map<string, Date>();
  for (const l of lots) {
    named.set(l.id, { raw: { SELLABLE: l.s ?? 0, EXPIRED: l.e ?? 0, DAMAGED: l.d ?? 0 }, held: { SELLABLE: l.held ?? 0, EXPIRED: 0, DAMAGED: 0 } });
    metas.set(l.id, {
      id: l.id, productId: l.productId ?? 'p', lotNumber: `N-${l.id}`, productionDate: l.production ?? null, expiryDate: l.expiry === undefined ? '2027-06-01' : l.expiry,
      status: l.status ?? 'ACTIVE', blockKind: l.blockKind ?? null, blockedAt: l.blockedAt ? new Date(l.blockedAt) : null,
      createdAt: new Date(l.createdAt ?? '2026-01-01T00:00:00Z'),
    });
    if (l.firstIn) firstInAt.set(l.id, new Date(l.firstIn));
  }
  const sumS = lots.reduce((s, l) => s + (l.s ?? 0), 0);
  const total = opts.total === null ? null : { SELLABLE: sumS, EXPIRED: 0, DAMAGED: 0, ...(opts.total ?? {}) };
  return buildPlaceView({
    productId: 'p', place: opts.place ?? 'VAN', vanKey: opts.place === 'WAREHOUSE' ? null : 'r', total, named,
    heldUnknown: { ...zeroBuckets(), ...(opts.heldUnknown ?? {}) }, metas, firstInAt,
  });
}

const out = (o: Partial<Parameters<typeof allocateOut>[0]> & { view: PlaceLotView; qty: number }) =>
  allocateOut({ productId: 'p', productName: 'حليب', unitFactor: 1, day: DAY, mode: 'SALE', allowUnknown: true, ...o });
const outLines = (o: Partial<Parameters<typeof allocateOutLines>[0]> & { view: PlaceLotView; lines: OutLine[] }) =>
  allocateOutLines({ productId: 'p', productName: 'حليب', day: DAY, mode: 'SALE', allowUnknown: true, ...o });

function ok(r: AllocResult): AllocRow[] {
  if (!r.ok) assert.fail(`متوقَّع نجاح، وصل ${r.error.code}: ${r.error.message}`);
  return r.rows;
}
function err(r: AllocResult, code: string, status?: number): LotError {
  assert.equal(r.ok, false, `متوقَّع ${code}`);
  if (r.ok) throw new Error('unreachable');
  assert.equal(r.error.code, code);
  if (status != null) assert.equal(r.error.status, status);
  return r.error;
}
const brief = (rows: AllocRow[]) => rows.map((r) => [r.lotId, +r.qty.toFixed(6), r.certainty]);

// ── FEFO ──
test('fefoCompare: الانتهاء تصاعدياً (null آخراً)، ثم الإنتاج، ثم الإنشاء، ثم الرقم، ثم المعرّف', () => {
  const m = (id: string, o: Partial<LotMeta>): LotMeta => ({ id, productId: 'p', lotNumber: id, productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0), ...o });
  const xs = [
    m('z', { expiryDate: null }),
    m('e2', { expiryDate: '2027-02-01' }),
    m('e1p2', { expiryDate: '2027-01-01', productionDate: '2026-05-01' }),
    m('e1p1', { expiryDate: '2027-01-01', productionDate: '2026-04-01' }),
    m('e1pn-late', { expiryDate: '2027-01-01', createdAt: new Date(5) }),
    m('e1pn-b', { expiryDate: '2027-01-01', lotNumber: 'B' }),
    m('e1pn-a', { expiryDate: '2027-01-01', lotNumber: 'A' }),
  ];
  assert.deepEqual(xs.sort(fefoCompare).map((x) => x.id), ['e1p1', 'e1p2', 'e1pn-a', 'e1pn-b', 'e1pn-late', 'e2', 'z']);
});

test('isLotExpiredOn: يوم الانتهاء نفسه آخر يومٍ صالح، وبلا انتهاء لا ينتهي', () => {
  assert.equal(isLotExpiredOn({ expiryDate: DAY }, DAY), false);
  assert.equal(isLotExpiredOn({ expiryDate: '2026-11-09' }, DAY), true);
  assert.equal(isLotExpiredOn({ expiryDate: null }, '2099-01-01'), false);
});

// ── الصريح ──
test('allocateOut الصريح: CONFIRMED، وأخطاؤه الستة بالترتيب', () => {
  const v = view({ lots: [{ id: 'A', s: 10 }, { id: 'B', s: 4, status: 'BLOCKED', blockKind: 'HOLD' }, { id: 'X', s: 3, expiry: '2026-11-01' }, { id: 'O', s: 5, productId: 'other' }], total: { SELLABLE: 25 } });
  assert.deepEqual(brief(ok(out({ view: v, qty: 7, explicit: [{ lotId: 'A', qty: 5 }, { lotId: null, qty: 2 }] }))), [['A', 5, 'CONFIRMED'], [null, 2, 'UNKNOWN']]);
  err(out({ view: v, qty: 2, explicit: [{ lotId: 'O', qty: 2 }] }), 'LOT_PRODUCT_MISMATCH', 422);
  err(out({ view: v, qty: 2, explicit: [{ lotId: 'B', qty: 2 }] }), 'LOT_BLOCKED', 422);
  const ex = err(out({ view: v, qty: 2, explicit: [{ lotId: 'X', qty: 2 }] }), 'LOT_EXPIRED', 422);
  assert.match(ex.message, /2026-11-01/);
  err(out({ view: v, qty: 11, explicit: [{ lotId: 'A', qty: 11 }] }), 'LOT_STOCK_INSUFFICIENT', 409);
  err(out({ view: v, qty: 2, explicit: [{ lotId: null, qty: 2 }], allowUnknown: false }), 'LOT_STOCK_INSUFFICIENT', 409);
  err(out({ view: v, qty: 4, explicit: [{ lotId: null, qty: 4 }] }), 'LOT_STOCK_INSUFFICIENT', 409); // غير المسمّى = 25 − 22 = 3
  err(out({ view: v, qty: 6, explicit: [{ lotId: 'A', qty: 5 }] }), 'LOT_QTY_INVALID', 422);
  err(out({ view: v, qty: 1, explicit: [{ lotId: 'missing', qty: 1 }] }), 'LOT_STOCK_INSUFFICIENT'); // الغائب عن العرض صالحه صفر
});

test('allocateOut الصريح بـlookup: لوط صنفٍ آخر أو موقوفٌ أو منتهٍ بلا رصيدٍ في المكان يأخذ رمزه، والغائب عن الشركة LOT_NOT_FOUND', () => {
  const v = view({ lots: [{ id: 'A', s: 10 }], total: { SELLABLE: 10 } });
  const m = (id: string, o: Partial<LotMeta>): LotMeta => ({ id, productId: 'p', lotNumber: `N-${id}`, productionDate: null, expiryDate: null, status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0), ...o });
  const lookup = new Map<string, LotMeta>([
    ['A', m('A', {})], ['O', m('O', { productId: 'other' })], ['B', m('B', { status: 'BLOCKED', blockKind: 'RECALL' })], ['X', m('X', { expiryDate: '2026-11-01' })], ['Z', m('Z', {})],
  ]);
  // بلا lookup: لوط صنفٍ آخر غائبٌ عن عرض الصنف فصالحه صفر — الرمز مضلِّل
  err(out({ view: v, qty: 1, explicit: [{ lotId: 'O', qty: 1 }] }), 'LOT_STOCK_INSUFFICIENT');
  const mis = err(out({ view: v, qty: 1, explicit: [{ lotId: 'O', qty: 1 }], lookup }), 'LOT_PRODUCT_MISMATCH', 422);
  assert.match(mis.message, /N-O/);
  err(out({ view: v, qty: 1, explicit: [{ lotId: 'B', qty: 1 }], lookup }), 'LOT_BLOCKED', 422);
  err(out({ view: v, qty: 1, explicit: [{ lotId: 'X', qty: 1 }], lookup }), 'LOT_EXPIRED', 422);
  err(out({ view: v, qty: 1, explicit: [{ lotId: 'missing', qty: 1 }], lookup }), 'LOT_NOT_FOUND', 422);
  err(out({ view: v, qty: 1, explicit: [{ lotId: 'Z', qty: 1 }], lookup }), 'LOT_STOCK_INSUFFICIENT', 409); // مؤهَّل بلا رصيدٍ هنا
  assert.deepEqual(brief(ok(out({ view: v, qty: 2, explicit: [{ lotId: 'A', qty: 2 }], lookup }))), [['A', 2, 'CONFIRMED']]);
  // pickOutSources: الموقوف والمنتهي يخرجان (لا فحص حالة)، لكن الصنف والوجود يُفحصان
  const pv = view({ lots: [{ id: 'A', s: 3 }, { id: 'B', s: 2, status: 'BLOCKED', blockKind: 'RECALL' }], total: { SELLABLE: 5 } });
  err(pickOutSources(pv, 'SELLABLE', 1, [{ lotId: 'O', qty: 1 }], lookup), 'LOT_PRODUCT_MISMATCH', 422);
  err(pickOutSources(pv, 'SELLABLE', 1, [{ lotId: 'missing', qty: 1 }], lookup), 'LOT_NOT_FOUND', 422);
  err(pickOutSources(pv, 'SELLABLE', 1, [{ lotId: 'O', qty: 1 }]), 'LOT_STOCK_INSUFFICIENT'); // بلا lookup كما كان
  assert.deepEqual(brief(ok(pickOutSources(pv, 'SELLABLE', 2, [{ lotId: 'B', qty: 2 }], lookup))), [['B', 2, 'CONFIRMED']]);
});

test('D26: صفّان على لوطٍ واحد يُجمعان قبل الفحص فيتجاوزان معاً', () => {
  const v = view({ lots: [{ id: 'A', s: 10 }] });
  const agg = aggregateRequest([
    { idx: 0, productId: 'p', qty: 6, refs: [{ lotId: 'A', qty: 6 }] },
    { idx: 1, productId: 'p', qty: 6, refs: [{ lotId: 'A', qty: 6 }] },
  ]).get('p')!;
  assert.equal(agg.qty, 12);
  assert.deepEqual([...agg.byLot], [['A', 12]]);
  err(out({ view: v, qty: agg.qty, explicit: refsOfByLot(agg.byLot) }), 'LOT_STOCK_INSUFFICIENT');
  // وكذا لو مُرِّرا غير مجمَّعَين
  err(out({ view: v, qty: 12, explicit: [{ lotId: 'A', qty: 6 }, { lotId: 'A', qty: 6 }] }), 'LOT_STOCK_INSUFFICIENT');
});

// ── التلقائي ──
test('FEFO تلقائي: المؤهَّلون وحدهم (الموقوف والمنتهي والمحجوز خارجهم)، واليقين بعدد المصادر المادية', () => {
  const v = view({
    lots: [
      { id: 'late', s: 5, expiry: '2027-03-01' }, { id: 'early', s: 2, expiry: '2026-12-01' },
      { id: 'blk', s: 9, expiry: '2026-11-15', status: 'BLOCKED', blockKind: 'RECALL' }, { id: 'old', s: 9, expiry: '2026-11-09' },
      { id: 'held', s: 4, held: 4, expiry: '2026-11-11' },
    ],
  });
  assert.deepEqual(brief(ok(out({ view: v, qty: 4 }))), [['early', 2, 'ASSUMED'], ['late', 2, 'ASSUMED']]);
  err(out({ view: v, qty: 8, allowUnknown: false }), 'LOT_STOCK_INSUFFICIENT', 409);
  const single = view({ lots: [{ id: 'A', s: 5 }, { id: 'Z', s: 0 }] });
  assert.deepEqual(brief(ok(out({ view: single, qty: 3 }))), [['A', 3, 'CONFIRMED']], 'المصدر الوحيد مؤكَّد');
  const withUnknown = view({ lots: [{ id: 'A', s: 5 }], total: { SELLABLE: 6 } });
  assert.deepEqual(brief(ok(out({ view: withUnknown, qty: 3 }))), [['A', 3, 'ASSUMED']], 'غير المسمّى مصدرٌ مادي ثانٍ');
  const withBlocked = view({ lots: [{ id: 'A', s: 5 }, { id: 'B', s: 1, status: 'BLOCKED', blockKind: 'HOLD' }] });
  assert.deepEqual(brief(ok(out({ view: withBlocked, qty: 3 }))), [['A', 3, 'ASSUMED']], 'الموقوف موجودٌ مادياً');
});

test('D17: غير المسمّى بعد نفاد المسمّى المؤهَّل بيقين UNKNOWN وتحذير، ومطفأً ⇒ نقص بالتفاصيل', () => {
  const v = view({ lots: [{ id: 'A', s: 3 }], total: { SELLABLE: 10 } });
  const r = out({ view: v, qty: 8 });
  assert.deepEqual(brief(ok(r)), [['A', 3, 'ASSUMED'], [null, 5, 'UNKNOWN']]);
  assert.ok(r.ok && r.warnings.some((w) => w.code === 'LOT_FROM_UNKNOWN'));
  const e = err(out({ view: v, qty: 8, allowUnknown: false }), 'LOT_STOCK_INSUFFICIENT');
  assert.equal(e.detail!.available, 3);
  assert.equal(e.detail!.unknownUsable, 7);
  assert.equal((e.detail!.byLot as unknown[]).length, 1);
  assert.match(e.message, /«حليب»/);
  err(out({ view: v, qty: 10.5 }), 'LOT_STOCK_INSUFFICIENT');
});

test('I2 مع السالب التاريخي: غير المسمّى السالب لا يُصرف منه، والمسمّى يُصرف بخامه', () => {
  const v = view({ lots: [{ id: 'A', s: 8 }], total: { SELLABLE: 5 } }); // غير المسمّى −3
  assert.equal(v.unknown!.SELLABLE, -3);
  assert.deepEqual(brief(ok(out({ view: v, qty: 8 }))), [['A', 8, 'CONFIRMED']]);
  err(out({ view: v, qty: 9 }), 'LOT_STOCK_INSUFFICIENT');
  err(out({ view: v, qty: 1, explicit: [{ lotId: null, qty: 1 }] }), 'LOT_STOCK_INSUFFICIENT');
});

test('قاعدة الكرتون (D22): مضاعفات F من لوطٍ واحد أولاً، ثم الباقي مع SPLIT_UNIT حين يتوزّع', () => {
  const v1 = view({ lots: [{ id: 'A', s: 5, expiry: '2026-12-01' }, { id: 'B', s: 12, expiry: '2027-01-01' }] });
  const r1 = out({ view: v1, qty: 12, unitFactor: 6 });
  assert.deepEqual(brief(ok(r1)), [['B', 12, 'ASSUMED']], 'كرتونان كاملان من B بدل تقسيم A');
  assert.ok(r1.ok && !r1.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT'));
  const v2 = view({ lots: [{ id: 'A', s: 5, expiry: '2026-12-01' }, { id: 'B', s: 7, expiry: '2027-01-01' }] });
  const r2 = out({ view: v2, qty: 12, unitFactor: 6 });
  assert.deepEqual(brief(ok(r2)), [['A', 5, 'ASSUMED'], ['B', 7, 'ASSUMED']]);
  assert.ok(r2.ok && r2.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT'));
  assert.ok(r2.ok && r2.rows.every((r) => r.flags.includes('SPLIT_UNIT')));
  const r3 = out({ view: v2, qty: 7, unitFactor: 6 });
  assert.deepEqual(brief(ok(r3)), [['A', 1, 'ASSUMED'], ['B', 6, 'ASSUMED']], 'كرتونٌ كامل من B، والحبة الباقية بـFEFO من A');
  assert.ok(r3.ok && !r3.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT'), 'باقٍ من لوطٍ واحد ليس تقسيماً');
  assert.deepEqual(brief(ok(out({ view: v2, qty: 7, unitFactor: 1 }))), [['A', 5, 'ASSUMED'], ['B', 2, 'ASSUMED']], 'الوحدة الأساسية: FEFO صرف');
});

test('قاعدة الكرتون بمعامل الوحدة الحقيقي (D19، D22): سطر «٢ كرتون» كما يكتبه المسار = ٤٨ حبة بمعامل ٢٤', () => {
  const line = unitFields(2, { name: 'كرتون', factor: 24 }); // qty 2 بوحدة السطر، unitFactor 24، baseQty 48
  const base = lotBaseQty(line);
  assert.equal(base, 48, 'الكمية الأساسية للسطر');
  const v = view({ lots: [{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 40, expiry: '2027-01-01' }] });
  const r = out({ view: v, qty: base, unitFactor: factorOf(line) });
  assert.deepEqual(brief(ok(r)), [['A', 24, 'ASSUMED'], ['B', 24, 'ASSUMED']], 'كرتونٌ كامل من كلٍّ بترتيب FEFO — لا ٣٠ من A و١٨ من B');
  assert.ok(r.ok && !r.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT'));
  assert.equal(ok(r).reduce((s, x) => s + x.qty, 0), base, 'I3: Σ الصفوف = الكمية الأساسية لا كمية السطر');
  // كرتونٌ لا يتّسع له لوطٌ واحد ⇒ يُقسَّم بتحذيرٍ يحمل المعامل
  const v2 = view({ lots: [{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 20, expiry: '2027-01-01' }] });
  const r2 = out({ view: v2, qty: base, unitFactor: factorOf(line) });
  assert.deepEqual(brief(ok(r2)), [['A', 30, 'ASSUMED'], ['B', 18, 'ASSUMED']]);
  assert.ok(r2.ok && r2.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT' && w.detail?.unitFactor === 24));
  // سطر الأساس (بلا وحدة) والمعامل التالف يُقرآن ١ كـfactorOf: FEFO صرف بلا قاعدة كرتون
  for (const snap of [unitFields(48), { qty: 48, unitFactor: 0 }, { qty: 48, unitFactor: Number.NaN }]) {
    assert.deepEqual(brief(ok(out({ view: v, qty: lotBaseQty(snap), unitFactor: factorOf(snap) }))), [['A', 30, 'ASSUMED'], ['B', 18, 'ASSUMED']], JSON.stringify(snap));
  }
});

// مراجعة الوحدات: الصنف في سطرين بوحدتين (InvoiceModal بـlineKey، و«الصنف بوحدتين في حركة واحدة»). المجموع بمعاملٍ واحد ثم
// distributeToLines بترتيب الأسطر كان يشقّ كرتوناً بلا وسم: «كرتونان ثم ٥ حبات» ⇒ سطر الكرتونين A:29 + B:19.
test('قاعدة الكرتون لكل سطر (D22): «٢ كرتون + ٥ حبة» بالترتيبين — كرتونٌ كامل من لوطٍ واحد، والحبّات مما بقي، بلا تقسيم', () => {
  const v = view({ lots: [{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 40, expiry: '2027-01-01' }] });
  const carton = unitFields(2, { name: 'كرتون', factor: 24 });
  const piece = unitFields(5);
  const lineOf = (idx: number, snap: { qty: number; unitFactor?: number | null; baseQty?: number | null }): OutLine =>
    ({ idx, qty: lotBaseQty(snap), unitFactor: factorOf(snap) });
  for (const [lines, cIdx, pIdx] of [[[lineOf(0, carton), lineOf(1, piece)], 0, 1], [[lineOf(0, piece), lineOf(1, carton)], 1, 0]] as [OutLine[], number, number][]) {
    const r = outLines({ view: v, lines });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(brief(r.lines.get(cIdx)!), [['A', 24, 'ASSUMED'], ['B', 24, 'ASSUMED']], 'كرتونٌ كامل من كلٍّ بترتيب FEFO');
    assert.deepEqual(brief(r.lines.get(pIdx)!), [['A', 5, 'ASSUMED']], 'الحبّات بـFEFO مما تركه الكرتون');
    assert.ok(r.rows.every((x) => !x.flags.includes('SPLIT_UNIT')) && !r.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT'));
    assert.deepEqual([...r.lines.keys()], [0, 1], 'الأسطر بترتيب الإدخال');
    assert.equal(r.rows.reduce((s, x) => s + x.qty, 0), 53, 'I3 على المجموع');
  }
  // كرتونٌ لا مفرّ من شقّه يُوسَم على سطره وحده، والتحذير بفهرسه
  const tight = view({ lots: [{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 20, expiry: '2027-01-01' }] });
  const r2 = outLines({ view: tight, lines: [{ idx: 3, qty: 2, unitFactor: 1 }, { idx: 7, qty: 48, unitFactor: 24 }] });
  assert.ok(r2.ok);
  assert.deepEqual(brief(r2.lines.get(7)!), [['A', 30, 'ASSUMED'], ['B', 18, 'ASSUMED']]);
  assert.ok(r2.lines.get(7)!.every((x) => x.flags.includes('SPLIT_UNIT')));
  assert.deepEqual(brief(r2.lines.get(3)!), [['B', 2, 'ASSUMED']]);
  assert.ok(r2.lines.get(3)!.every((x) => !x.flags.includes('SPLIT_UNIT')), 'سطر الحبّات لا يُوسَم');
  assert.deepEqual(r2.warnings.filter((w) => w.code === 'LOT_SPLIT_UNIT').map((w) => w.detail), [{ unitFactor: 24, idx: 7 }]);
  // سطرٌ صفري بلا صفوف، والنقص على المجموع
  const z = outLines({ view: v, lines: [{ idx: 0, qty: 0, unitFactor: 24 }, { idx: 1, qty: 5, unitFactor: 1 }] });
  assert.ok(z.ok && z.lines.get(0)!.length === 0);
  const short = err(outLines({ view: v, allowUnknown: false, lines: [{ idx: 0, qty: 48, unitFactor: 24 }, { idx: 1, qty: 30, unitFactor: 1 }] }), 'LOT_STOCK_INSUFFICIENT', 409);
  assert.equal(short.detail!.wanted, 78);
});

test('allocateOutLines بالصريح لكل سطر: يُجمع ويُفحص على الأسطر (D26)، وسطرٌ بلا صريح يُوزَّع مما بقي بعده', () => {
  const v = view({ lots: [{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 40, expiry: '2027-01-01' }] });
  const r = outLines({ view: v, allowUnknown: false, lines: [
    { idx: 0, qty: 5, unitFactor: 1, explicit: [{ lotId: 'A', qty: 5 }] },
    { idx: 1, qty: 48, unitFactor: 24 },
  ] });
  assert.ok(r.ok);
  assert.deepEqual(brief(r.lines.get(0)!), [['A', 5, 'CONFIRMED']]);
  assert.deepEqual(brief(r.lines.get(1)!), [['A', 24, 'ASSUMED'], ['B', 24, 'ASSUMED']], 'بقي من A ٢٥: كرتونٌ منه');
  err(outLines({ view: v, lines: [
    { idx: 0, qty: 20, unitFactor: 1, explicit: [{ lotId: 'A', qty: 20 }] }, { idx: 1, qty: 20, unitFactor: 1, explicit: [{ lotId: 'A', qty: 20 }] },
  ] }), 'LOT_STOCK_INSUFFICIENT', 409);
  err(outLines({ view: view({ lots: [{ id: 'A', s: 30 }] }), allowUnknown: false, lines: [
    { idx: 0, qty: 20, unitFactor: 1, explicit: [{ lotId: 'A', qty: 20 }] }, { idx: 1, qty: 15, unitFactor: 1 },
  ] }), 'LOT_STOCK_INSUFFICIENT', 409);
  err(outLines({ view: v, lines: [{ idx: 0, qty: 6, unitFactor: 1, explicit: [{ lotId: 'A', qty: 5 }] }] }), 'LOT_QTY_INVALID', 422);
});

test('الإعادة (D16) لكل سطر: تلميح كل سطرٍ يُكتب كما طُبع، وتلميحٌ لبعض الأسطر أو بمجموعٍ غير كمية سطره يُرفض للصنف كله', () => {
  const v = view({ lots: [{ id: 'A', s: 30, expiry: '2026-12-01' }, { id: 'B', s: 40, expiry: '2027-01-01' }] });
  const replay = { at: AT, clamped: false };
  const r = outLines({ view: v, replay, lines: [
    { idx: 0, qty: 48, unitFactor: 24, hint: [{ lotId: 'B', qty: 24 }, { lotId: 'A', qty: 24 }] },
    { idx: 1, qty: 5, unitFactor: 1, hint: [{ lotId: 'B', qty: 5 }] },
  ] });
  assert.ok(r.ok);
  assert.deepEqual(brief(r.lines.get(0)!), [['B', 24, 'ASSUMED'], ['A', 24, 'ASSUMED']]);
  assert.deepEqual(brief(r.lines.get(1)!), [['B', 5, 'ASSUMED']], 'لا يُعاد توزيع المجموع B:29 على الأسطر بترتيبها');
  assert.ok(!r.warnings.some((w) => w.code === 'LOT_HINT_REJECTED'));
  for (const lines of [
    [{ idx: 0, qty: 48, unitFactor: 24, hint: [{ lotId: 'B', qty: 48 }] }, { idx: 1, qty: 5, unitFactor: 1 }],
    [{ idx: 0, qty: 48, unitFactor: 24, hint: [{ lotId: 'B', qty: 40 }] }, { idx: 1, qty: 5, unitFactor: 1, hint: [{ lotId: 'A', qty: 13 }] }],
  ] as OutLine[][]) {
    const rej = outLines({ view: v, replay, lines });
    assert.ok(rej.ok);
    assert.ok(rej.rows.every((x) => x.flags.includes('HINT_REJECTED')), JSON.stringify(lines));
    assert.ok(rej.warnings.some((w) => w.code === 'LOT_HINT_REJECTED'));
    assert.deepEqual(brief(rej.lines.get(0)!), [['A', 24, 'ASSUMED'], ['B', 24, 'ASSUMED']], 'والطبقات بقاعدة الكرتون لكل سطر');
  }
});

test('D22 مع غير المسمّى: كرتونٌ يكمله غير المسمّى بعد لوطٍ مسمّى يُوسَم SPLIT_UNIT بتحذيره — حيّاً وإعادةً، وعبر الطبقة ٣', () => {
  const v = view({ lots: [{ id: 'A', s: 10 }], total: { SELLABLE: 110 } }); // غير المسمّى ١٠٠
  for (const replay of [null, { at: AT, clamped: false }]) {
    const r = out({ view: v, qty: 24, unitFactor: 24, replay });
    assert.deepEqual(brief(ok(r)), [['A', 10, 'ASSUMED'], [null, 14, 'UNKNOWN']]);
    assert.ok(ok(r).every((x) => x.flags.includes('SPLIT_UNIT')), JSON.stringify(ok(r)));
    assert.ok(r.ok && r.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT' && w.detail?.unitFactor === 24));
    assert.ok(r.ok && r.warnings.some((w) => w.code === 'LOT_FROM_UNKNOWN'));
  }
  // كرتونٌ كامل من المسمّى ثم كرتونٌ كامل من غير المسمّى: لا تقسيم
  const whole = out({ view: view({ lots: [{ id: 'A', s: 24 }], total: { SELLABLE: 124 } }), qty: 48, unitFactor: 24 });
  assert.deepEqual(brief(ok(whole)), [['A', 24, 'ASSUMED'], [null, 24, 'UNKNOWN']]);
  assert.ok(whole.ok && whole.rows.every((x) => !x.flags.includes('SPLIT_UNIT')) && !whole.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT'));
  // الإعادة: الطبقة ١ ثم الطبقة ٣ (موقوفٌ قبل البيع) تشقّان كرتوناً
  const h = view({ lots: [{ id: 'A', s: 10 }, { id: 'H', s: 100, status: 'BLOCKED', blockKind: 'HOLD', blockedAt: '2026-11-01T00:00:00Z' }] });
  const r3 = out({ view: h, qty: 24, unitFactor: 24, replay: { at: AT, clamped: false } });
  assert.deepEqual(brief(ok(r3)), [['A', 10, 'ASSUMED'], ['H', 14, 'ASSUMED']]);
  assert.ok(ok(r3).every((x) => x.flags.includes('SPLIT_UNIT')));
  assert.ok(r3.ok && r3.warnings.some((w) => w.code === 'LOT_SPLIT_UNIT'));
});

test('مجموع الصفوف = الكمية بالضبط (I3) ولو بكسور عائمة', () => {
  const v = view({ lots: [{ id: 'A', s: 0.1 }, { id: 'B', s: 0.2, expiry: '2027-07-01' }] });
  const rows = ok(out({ view: v, qty: 0.3 }));
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.qty, 0) - 0.3) < 1e-12);
  assert.equal(ok(out({ view: v, qty: 0 })).length, 0);
  err(out({ view: v, qty: -1 }), 'LOT_QTY_INVALID');
});

test('isLotQty: الكمية بأربع خانات (دقّة الطيّ) — أدقّ منها يُرفض في الحيّ والصريح والإزالة، والتلميح يُتجاهل، والإعادة لا تُرفض (R6)', () => {
  for (const q of [1, 0.5, 0.0001, 1.0011, 12345.6789, 0.1 + 0.2, 1.1 * 3]) assert.equal(isLotQty(q), true, String(q));
  for (const q of [0, -1, 1e-7, 1.00105, 0.00005, 2.12345, NaN, Infinity]) assert.equal(isLotQty(q), false, String(q));
  // مسبار المراجعة: وارد 1.00105 يُعرض 1.0011 بالتقريب فيُصرف 1.0011 كله والخام −0.00005 ⇒ −0.0001 (I1). الحارس عند الكتابة:
  assert.equal(roundLot(1.00105), 1.0011);
  assert.equal(isLotQty(1.00105), false, 'الزيادة بخمس خانات تُرفض في كل حزمةٍ تكتبها (isLotQty)');
  const v = view({ lots: [{ id: 'A', s: 5 }], total: { SELLABLE: 6 } });
  err(out({ view: v, qty: 1.00105 }), 'LOT_QTY_INVALID', 422);
  err(out({ view: v, qty: 1.00105, explicit: [{ lotId: 'A', qty: 1.00105 }] }), 'LOT_QTY_INVALID', 422);
  err(pickOutSources(v, 'SELLABLE', 1.00105, [{ lotId: 'A', qty: 1.00105 }]), 'LOT_QTY_INVALID', 422);
  err(pickOutSources(v, 'SELLABLE', 0.00005), 'LOT_QTY_INVALID', 422);
  const strict = parseLotRefsStrict([{ lotId: 'A', qty: 1.00105 }], 1.00105);
  assert.ok(strict instanceof LotError && strict.code === 'LOT_QTY_INVALID');
  assert.equal(parseLotHint([{ lotId: 'A', qty: 1.00105 }]), null, 'تلميحٌ بخمس خانات يُتجاهل فيوزّع الخادم بالطبقات');
  // الإعادة لا تُرفض (R6)، لكن صفّ اللوط المسمّى بأربع خانات والغبار لغير المسمّى (gate 0: وإلا يُصرف ما لا يوجد بعدها)
  const rr = ok(out({ view: v, qty: 1.00105, replay: { at: new Date('2026-11-09T10:00:00Z'), clamped: false } }));
  assert.deepEqual(rr.map((x) => [x.lotId, x.lotId == null ? 'dust' : x.qty, x.certainty]), [['A', 1.001, 'ASSUMED'], [null, 'dust', 'UNKNOWN']], 'الإعادة لا تُرفض (R6)');
  assert.ok(Math.abs(rr[1].qty - 0.00005) < 1e-12 && Math.abs(rr[0].qty + rr[1].qty - 1.00105) < 1e-12, 'Σ = الكمية (I3)');
});

// ── الإعادة (R6) ──
test('الإعادة الطبقة ١: ما دخل السيارة قبل البيع يتقدّم على FEFO، والموقوف بعد البيع مؤهَّلٌ بوسمه', () => {
  const v = view({
    lots: [
      { id: 'fefo', s: 3, expiry: '2027-01-01', firstIn: '2026-11-09T12:00:00Z' }, // دخل بعد البيع
      { id: 'before', s: 3, expiry: '2027-05-01', firstIn: '2026-11-08T08:00:00Z' },
      { id: 'blkAfter', s: 2, expiry: '2027-09-01', status: 'BLOCKED', blockKind: 'RECALL', blockedAt: '2026-11-09T11:00:00Z', firstIn: '2026-11-01T00:00:00Z' },
    ],
  });
  const r = out({ view: v, qty: 4, replay: { at: AT, clamped: false } });
  // fefo أقرب انتهاءً لكنه دخل بعد البيع فيتأخر؛ والداخلان قبله بـFEFO بينهما
  assert.deepEqual(brief(ok(r)), [['before', 3, 'ASSUMED'], ['blkAfter', 1, 'ASSUMED']]);
  assert.deepEqual(brief(ok(out({ view: v, qty: 7, replay: { at: AT, clamped: false } }))), [['before', 3, 'ASSUMED'], ['blkAfter', 2, 'ASSUMED'], ['fefo', 2, 'ASSUMED']]);
  assert.deepEqual(ok(r).find((x) => x.lotId === 'blkAfter')!.flags, ['REPLAY_RECALLED']);
  assert.ok(r.ok && r.warnings.some((w) => w.code === 'LOT_REPLAY_FLAGGED'), 'صرفٌ من مسحوب يُشعر الإدارة');
});

test('الإعادة الطبقة ١: لوطٌ سُمّي في السيارة قبل البيع يتقدّم على لوطٍ حُمّل بعده ولو كان أقرب انتهاءً (firstInAt من التسمية)', () => {
  const tRel = new Date('2026-11-09T06:00:00Z'), tLoad = new Date('2026-11-09T11:00:00Z'); // البيع دون اتصال 10:00
  const vf = foldVanLots(
    [{ productId: 'p', lotId: 'B', vanKey: 'r', moveType: 'LOAD', viaWarehouse: true, qty: 20, firstInAt: tLoad }],
    [],
    [{ productId: 'p', place: 'VAN', vanKey: 'r', bucket: 'SELLABLE', fromLotId: null, toLotId: 'A', qty: 50, firstAt: tRel }],
    'r',
  );
  const metas = new Map<string, LotMeta>([
    ['A', { id: 'A', productId: 'p', lotNumber: 'A', productionDate: null, expiryDate: '2027-06-01', status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0) }],
    ['B', { id: 'B', productId: 'p', lotNumber: 'B', productionDate: null, expiryDate: '2027-01-01', status: 'ACTIVE', blockKind: null, blockedAt: null, createdAt: new Date(0) }],
  ]);
  const named = vf.named.get('p')!;
  const v = buildPlaceView({ productId: 'p', place: 'VAN', vanKey: 'r', total: { SELLABLE: 70, EXPIRED: 0, DAMAGED: 0 }, named, heldUnknown: heldUnknownOf(zeroBuckets(), named), metas, firstInAt: vf.firstInAt.get('p') });
  assert.deepEqual(brief(ok(out({ view: v, qty: 10, replay: { at: AT, clamped: false } }))), [['A', 10, 'ASSUMED']], 'A كان في السيارة لحظة البيع، وB لم يكن');
  assert.deepEqual(brief(ok(out({ view: v, qty: 10 }))), [['B', 10, 'ASSUMED']], 'المسار الحيّ FEFO صرف');
});

test('الإعادة الطبقات ٢ و٣: غير المسمّى ثم HOLD ثم المنتهي ثم RECALL، مفترَضةً بوسمها، و REPLAY_CLAMPED على كل صف', () => {
  const v = view({
    lots: [
      { id: 'ok', s: 1 },
      { id: 'recall', s: 2, status: 'BLOCKED', blockKind: 'RECALL', blockedAt: '2026-11-01T00:00:00Z' },
      { id: 'exp', s: 2, expiry: '2026-11-08' },
      { id: 'hold', s: 2, status: 'BLOCKED', blockKind: 'HOLD', blockedAt: '2026-11-01T00:00:00Z', expiry: '2027-12-01' },
    ],
    total: { SELLABLE: 9 },
  });
  const r = out({ view: v, qty: 8, allowUnknown: false, replay: { at: AT, clamped: true } });
  const rows = ok(r);
  assert.deepEqual(brief(rows), [['ok', 1, 'ASSUMED'], [null, 2, 'UNKNOWN'], ['hold', 2, 'ASSUMED'], ['exp', 2, 'ASSUMED'], ['recall', 1, 'ASSUMED']]);
  assert.ok(rows.every((x) => x.flags.includes('REPLAY_CLAMPED')));
  assert.deepEqual(rows.find((x) => x.lotId === 'hold')!.flags, ['REPLAY_BLOCKED', 'REPLAY_CLAMPED']);
  assert.deepEqual(rows.find((x) => x.lotId === 'exp')!.flags, ['REPLAY_EXPIRED', 'REPLAY_CLAMPED']);
  assert.deepEqual(rows.find((x) => x.lotId === 'recall')!.flags, ['REPLAY_RECALLED', 'REPLAY_CLAMPED']);
});

test('الإعادة: الحجز للمراجعة (409 LOT_REPLAY_HELD) حين لا يكفي رصيد الصنف الصالح — والمحجوز لا يُصرف', () => {
  const v = view({ lots: [{ id: 'A', s: 5, held: 2 }], total: { SELLABLE: 5 } });
  const e = err(out({ view: v, qty: 4, replay: { at: AT, clamped: false } }), 'LOT_REPLAY_HELD', 409);
  assert.equal(e.detail!.missing, 1);
  assert.deepEqual(brief(ok(out({ view: v, qty: 3, replay: { at: AT, clamped: false } }))), [['A', 3, 'CONFIRMED']]);
});

test('التلميح (D16): مقبولٌ من لوطٍ موقوف أو منتهٍ بوسمه، ومرفوضٌ بالزيادة أو بمجموعٍ مختلف ⇒ HINT_REJECTED والطبقات', () => {
  const v = view({ lots: [{ id: 'A', s: 5 }, { id: 'H', s: 2, status: 'BLOCKED', blockKind: 'HOLD', blockedAt: '2026-11-01T00:00:00Z', expiry: '2026-11-01' }] });
  const acc = out({ view: v, qty: 3, replay: { at: AT, clamped: false }, hint: [{ lotId: 'H', qty: 2 }, { lotId: 'A', qty: 1 }] });
  assert.deepEqual(brief(ok(acc)), [['H', 2, 'ASSUMED'], ['A', 1, 'ASSUMED']]);
  assert.deepEqual(ok(acc)[0].flags, ['REPLAY_BLOCKED', 'REPLAY_EXPIRED']);
  assert.ok(acc.ok && acc.warnings.some((w) => w.code === 'LOT_REPLAY_FLAGGED'));
  const rej = out({ view: v, qty: 3, replay: { at: AT, clamped: false }, hint: [{ lotId: 'H', qty: 3 }] });
  assert.deepEqual(brief(ok(rej)), [['A', 3, 'ASSUMED']]);
  assert.ok(ok(rej).every((x) => x.flags.includes('HINT_REJECTED')));
  assert.ok(rej.ok && rej.warnings.some((w) => w.code === 'LOT_HINT_REJECTED'));
  const partial = out({ view: v, qty: 3, replay: { at: AT, clamped: false }, hint: [{ lotId: 'A', qty: 1 }] });
  assert.ok(ok(partial).every((x) => x.flags.includes('HINT_REJECTED')), 'تلميحٌ لا يغطي الكمية مرفوض');
  const unknownHint = out({ view: view({ lots: [{ id: 'A', s: 1 }], total: { SELLABLE: 4 } }), qty: 2, allowUnknown: false, replay: { at: AT, clamped: false }, hint: [{ lotId: null, qty: 2 }] });
  assert.deepEqual(brief(ok(unknownHint)), [[null, 2, 'UNKNOWN']], 'allowUnknown لا يقيّد الإعادة');
});

// ── مصادر الإنقاص (D10) ──
test('pickOutSources: المصدر الوحيد تلقائي، وأكثر من مصدر LOT_REQUIRED بالقائمة، والموقوف والمنتهي يخرجان صراحةً', () => {
  const one = view({ lots: [{ id: 'A', s: 4 }] });
  assert.deepEqual(brief(ok(pickOutSources(one, 'SELLABLE', 3))), [['A', 3, 'CONFIRMED']]);
  err(pickOutSources(one, 'SELLABLE', 5), 'LOT_STOCK_INSUFFICIENT', 409);
  const onlyUnknown = view({ lots: [], total: { SELLABLE: 6 } });
  assert.deepEqual(brief(ok(pickOutSources(onlyUnknown, 'SELLABLE', 6))), [[null, 6, 'UNKNOWN']]);
  const two = view({ lots: [{ id: 'A', s: 4 }, { id: 'R', s: 2, status: 'BLOCKED', blockKind: 'RECALL', expiry: '2026-01-01' }], total: { SELLABLE: 7 } });
  const e = err(pickOutSources(two, 'SELLABLE', 1), 'LOT_REQUIRED', 422);
  assert.equal((e.detail!.sources as unknown[]).length, 3);
  assert.deepEqual(brief(ok(pickOutSources(two, 'SELLABLE', 3, [{ lotId: 'R', qty: 2 }, { lotId: null, qty: 1 }]))), [['R', 2, 'CONFIRMED'], [null, 1, 'UNKNOWN']]);
  err(pickOutSources(two, 'SELLABLE', 3, [{ lotId: 'R', qty: 3 }]), 'LOT_STOCK_INSUFFICIENT'); // I1
  err(pickOutSources(two, 'SELLABLE', 2, [{ lotId: null, qty: 2 }]), 'LOT_STOCK_INSUFFICIENT'); // I2
  err(pickOutSources(two, 'SELLABLE', 3, [{ lotId: 'A', qty: 2 }]), 'LOT_QTY_INVALID');
  const zero = view({ lots: [] , total: { SELLABLE: 0 } });
  err(pickOutSources(zero, 'SELLABLE', 1), 'LOT_STOCK_INSUFFICIENT');
});

test('pickOutSources: I2 مع غير المسمّى السالب تاريخياً، ودلو المنتهي، والسيارة المحذوفة بلا غير مسمّى', () => {
  const neg = view({ lots: [{ id: 'A', s: 2 }], total: { SELLABLE: -1 } });
  assert.equal(neg.unknownUsable!.SELLABLE, -3);
  assert.deepEqual(brief(ok(pickOutSources(neg, 'SELLABLE', 2))), [['A', 2, 'CONFIRMED']], 'المصدر المادي الوحيد A');
  err(pickOutSources(neg, 'SELLABLE', 0.5, [{ lotId: null, qty: 0.5 }]), 'LOT_STOCK_INSUFFICIENT');
  const exp = view({ lots: [{ id: 'A', e: 3 }, { id: 'B', s: 9 }], total: { EXPIRED: 3 } });
  assert.deepEqual(brief(ok(pickOutSources(exp, 'EXPIRED', 3))), [['A', 3, 'CONFIRMED']]);
  const gone = view({ lots: [{ id: 'A', s: 2 }, { id: 'B', s: 1 }], total: null });
  err(pickOutSources(gone, 'SELLABLE', 1, [{ lotId: null, qty: 1 }]), 'LOT_STOCK_INSUFFICIENT');
  assert.deepEqual(brief(ok(pickOutSources(gone, 'SELLABLE', 2, [{ lotId: 'A', qty: 2 }]))), [['A', 2, 'CONFIRMED']]);
});

// ── المرتجع المرتبط ──
const sr = (id: string, lotId: string | null, quantity: number, expiryDate: string | null, certainty: SaleLotRow['certainty'] = 'ASSUMED'): SaleLotRow => ({ id, lotId, quantity, certainty, expiryDate });
test('allocateReturnFromSale: بلا صفوف ⇒ غير معروف؛ الهجين: منتهٍ متاح ⇒ الأقرب أولاً، وإلا الأبعد أولاً', () => {
  assert.deepEqual(brief(allocateReturnFromSale({ qty: 2, returnDay: DAY, saleRows: [], returnedBySource: new Map() })), [[null, 2, 'UNKNOWN']]);
  const rows = [sr('s1', 'NEAR', 3, '2026-11-05'), sr('s2', 'FAR', 3, '2027-05-01'), sr('s3', null, 3, null, 'UNKNOWN')];
  assert.deepEqual(brief(allocateReturnFromSale({ qty: 4, returnDay: DAY, saleRows: rows, returnedBySource: new Map() })),
    [['NEAR', 3, 'ASSUMED'], ['FAR', 1, 'ASSUMED']], 'المنتهي يرجع أولاً');
  assert.deepEqual(brief(allocateReturnFromSale({ qty: 4, returnDay: '2026-11-01', saleRows: rows, returnedBySource: new Map() })),
    [['FAR', 3, 'ASSUMED'], ['NEAR', 1, 'ASSUMED']], 'لا منتهٍ يومها: الأبعد أولاً');
  assert.deepEqual(brief(allocateReturnFromSale({ qty: 4, returnDay: DAY, saleRows: rows, returnedBySource: new Map([['s1', 3]]) })),
    [['FAR', 3, 'ASSUMED'], [null, 1, 'UNKNOWN']], 'المنتهي أُرجع كله: الأبعد، ثم غير المعروف آخراً');
  const r = allocateReturnFromSale({ qty: 10, returnDay: DAY, saleRows: rows, returnedBySource: new Map() });
  assert.deepEqual(brief(r).slice(-1), [[null, 1, 'UNKNOWN']], 'الفائض صفٌّ غير معروف');
  assert.equal(r[r.length - 1].sourceItemLotId, null);
  assert.equal(r[0].sourceItemLotId, 's1');
  assert.deepEqual(brief(allocateReturnFromSale({ qty: 1, returnDay: DAY, saleRows: [sr('s9', 'L', 2, null, 'CONFIRMED')], returnedBySource: new Map() })),
    [['L', 1, 'CONFIRMED']], 'صفٌّ واحد يورث يقينه');
});

test('allocateReturnFromSale: المرتجع الثاني من بيعٍ بلوطين يبقى مفترَضاً ولو بقي مصدرٌ واحد (قسمة الأول افتراض)', () => {
  const sale = [sr('a', 'A', 2, '2027-01-01', 'CONFIRMED'), sr('b', 'B', 3, '2027-06-01', 'CONFIRMED')];
  const first = allocateReturnFromSale({ qty: 3, returnDay: DAY, saleRows: sale, returnedBySource: new Map() });
  assert.deepEqual(brief(first), [['B', 3, 'ASSUMED']], 'الأبعد انتهاءً أولاً');
  const returned = new Map(first.map((r) => [r.sourceItemLotId!, r.qty]));
  assert.deepEqual(brief(allocateReturnFromSale({ qty: 2, returnDay: DAY, saleRows: sale, returnedBySource: returned })), [['A', 2, 'ASSUMED']],
    'ربما كان الأول A:2 وB:1 فعلاً — لا CONFIRMED');
  const single = [sr('s', 'S', 5, null, 'CONFIRMED')];
  const r1 = allocateReturnFromSale({ qty: 2, returnDay: DAY, saleRows: single, returnedBySource: new Map() });
  assert.deepEqual(brief(allocateReturnFromSale({ qty: 3, returnDay: DAY, saleRows: single, returnedBySource: new Map([['s', r1[0].qty]]) })), [['S', 3, 'CONFIRMED']], 'بيعٌ بصفٍّ واحد يورث يقينه دائماً');
});

// ── حارس الإزالة: إلغاء المرتجع وإطفاء عودته (§٤.١٢–٤.١٣) ──
test('lotRemovalsOf: البند بلا صفوف والصفّ قبل الحقبة على غير المسمّى، والمحجوز وغير المتتبَّع بلا فحص', () => {
  const since = new Map<string, Date | null>([['p', new Date('2026-11-05T00:00:00Z')], ['q', null]]);
  const items: LotRemovalItem[] = [
    { productId: 'p', qty: 5, bucket: 'SELLABLE', held: false, rows: null },                                                            // كُتب قبل تتبّع الصنف
    { productId: 'p', qty: 3, bucket: 'SELLABLE', held: false, rows: [{ lotId: 'A', quantity: 3, createdAt: new Date('2026-11-01T00:00:00Z') }] }, // حقبةٌ سابقة
    { productId: 'p', qty: 4, bucket: 'EXPIRED', held: false, rows: [{ lotId: 'A', quantity: 1, createdAt: new Date('2026-11-06T00:00:00Z') }, { lotId: null, quantity: 3, createdAt: new Date('2026-11-06T00:00:00Z') }] },
    { productId: 'p', qty: 9, bucket: 'SELLABLE', held: true, rows: null },                                                             // محجوز (D24)
    { productId: 'p', qty: 9, bucket: null, held: false, rows: null },                                                                  // لا أثر
    { productId: 'u', qty: 9, bucket: 'SELLABLE', held: false, rows: null },                                                            // غير متتبَّع
    { productId: 'q', qty: 2, bucket: 'DAMAGED', held: false, rows: [{ lotId: 'Q', quantity: 2, createdAt: new Date(0) }] },             // بلا حقبة
  ];
  assert.deepEqual(lotRemovalsOf(items, since, new Set(['p', 'q'])), [
    { productId: 'p', lotId: null, bucket: 'SELLABLE', qty: 5 },
    { productId: 'p', lotId: null, bucket: 'SELLABLE', qty: 3 },
    { productId: 'p', lotId: 'A', bucket: 'EXPIRED', qty: 1 },
    { productId: 'p', lotId: null, bucket: 'EXPIRED', qty: 3 },
    { productId: 'q', lotId: 'Q', bucket: 'DAMAGED', qty: 2 },
  ]);
});

test('removalKeepsLots: I1 للمسمّى وI2 لغير المسمّى بعد التجميع، والسيارة المحذوفة لا تُزال من غير مسمّاها — وسيناريو المراجعة', () => {
  // مرتجعٌ حرّ بخمس والصنف غير متتبَّع ⇒ يُفعَّل ⇒ تُباع الخمس من غير المسمّى ⇒ يُلغى المرتجع: بلا صفوف، فـ«∅» يُفحص ويُرفض
  const sold = view({ lots: [], total: { SELLABLE: 0 } });
  const rm = lotRemovalsOf([{ productId: 'p', qty: 5, bucket: 'SELLABLE', held: false, rows: null }], new Map([['p', new Date('2026-11-05')]]), new Set(['p']));
  const e = removalKeepsLots(sold, rm);
  assert.ok(e instanceof LotError && e.code === 'LOT_STOCK_INSUFFICIENT' && e.status === 409 && e.detail!.lotId === null && e.detail!.reason === 'REMOVAL');
  assert.equal(removalKeepsLots(view({ lots: [], total: { SELLABLE: 5 } }), rm), null, 'لم يُبع شيء ⇒ يُلغى');
  // التجميع قبل المقارنة (D26): صفّان على اللوط نفسه يتجاوزان معاً
  const v = view({ lots: [{ id: 'A', s: 4 }], total: { SELLABLE: 6 } });
  const two = [{ productId: 'p', lotId: 'A', bucket: 'SELLABLE' as const, qty: 3 }, { productId: 'p', lotId: 'A', bucket: 'SELLABLE' as const, qty: 2 }];
  assert.equal(removalKeepsLots(v, two)!.detail!.lotId, 'A');
  assert.equal(removalKeepsLots(v, two.slice(0, 1)), null);
  // I2 مع السالب التاريخي: لا يُنقص دون min(0, قبله)
  const neg = view({ lots: [{ id: 'A', s: 4 }], total: { SELLABLE: 3 } }); // غير المسمّى −1
  assert.ok(removalKeepsLots(neg, [{ productId: 'p', lotId: null, bucket: 'SELLABLE', qty: 0.5 }]));
  assert.equal(removalKeepsLots(neg, [{ productId: 'other', lotId: null, bucket: 'SELLABLE', qty: 99 }]), null, 'صنفٌ آخر لا يخصّ هذا العرض');
  const gone = view({ lots: [{ id: 'A', s: 4 }], total: null });
  assert.ok(removalKeepsLots(gone, [{ productId: 'p', lotId: null, bucket: 'SELLABLE', qty: 1 }]), 'غير المسمّى مجهول ⇒ لا يُتحقَّق منه');
  assert.equal(removalKeepsLots(gone, [{ productId: 'p', lotId: 'A', bucket: 'SELLABLE', qty: 4 }]), null);
});

test('stampFromRows: null بلا صفّ مسمّى مؤرَّخ، والأقرب انتهاءً، ويوم الانتهاء صالح', () => {
  assert.equal(stampFromRows([{ lotId: null, expiryDate: '2026-01-01' }, { lotId: 'A', expiryDate: null }]), null);
  assert.deepEqual(stampFromRows([{ lotId: 'A', expiryDate: '2027-01-01' }, { lotId: 'B', expiryDate: '2026-12-01' }]), { expiresAt: '2026-12-01', returnExpired: null });
  assert.deepEqual(stampFromRows([{ lotId: 'A', expiryDate: DAY }], DAY), { expiresAt: DAY, returnExpired: false });
  assert.deepEqual(stampFromRows([{ lotId: 'A', expiryDate: '2027-01-01' }, { lotId: 'B', expiryDate: '2026-11-09' }], DAY), { expiresAt: '2026-11-09', returnExpired: true }, 'D6: المختلط كله منتهٍ');
});

// ── القواعد الصرفة ──
test('normalizeLotNumber: قصّ ودمج وأرقام عربية وفارسية وحروف كبيرة وحدّ الطول وحذف محارف الاتجاه', () => {
  assert.equal(normalizeLotNumber('  ab-١٢٣   x  '), 'AB-123 X');
  assert.equal(normalizeLotNumber('lot۴۵۶'), 'LOT456');
  assert.equal(normalizeLotNumber('‏a1‎'), 'A1');
  assert.equal(normalizeLotNumber('دفعة a'), 'دفعة A');
  assert.equal(normalizeLotNumber(2026), '2026');
  for (const bad of ['', '   ', null, undefined, {}, NaN, 'x'.repeat(65)]) assert.equal(normalizeLotNumber(bad), null, String(bad));
  assert.equal(normalizeLotNumber('x'.repeat(64)), 'X'.repeat(64));
});

test('lotDatesProblem: الصيغة والترتيب وإلزام الانتهاء', () => {
  assert.equal(lotDatesProblem(null, null, { expiryRequired: false }), null);
  assert.equal(lotDatesProblem(null, null, { expiryRequired: true }), 'LOT_EXPIRY_REQUIRED');
  assert.equal(lotDatesProblem('2026-01-01', '', { expiryRequired: true }), 'LOT_EXPIRY_REQUIRED');
  assert.equal(lotDatesProblem('2026-02-30', '2027-01-01', { expiryRequired: false }), 'LOT_DATES_INVALID');
  assert.equal(lotDatesProblem(null, '01/02/2027', { expiryRequired: false }), 'LOT_DATES_INVALID');
  assert.equal(lotDatesProblem('2027-02-01', '2027-01-01', { expiryRequired: true }), 'LOT_DATES_INVALID');
  assert.equal(lotDatesProblem('2027-01-01', '2027-01-01', { expiryRequired: true }), null);
});

test('replayMoment: الحصر بسبعة أيام وبالآن، ويوم الشركة بمنطقتها، وغير الصالح null', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const inside = replayMoment('2026-11-18T22:30:00Z', now, 'Asia/Riyadh')!;
  assert.deepEqual([inside.day, inside.clamped], ['2026-11-19', false]);
  const old = replayMoment('2026-10-01T00:00:00Z', now, 'Asia/Riyadh')!;
  assert.equal(old.clamped, true);
  assert.equal(old.at.getTime(), now.getTime() - 7 * 86_400_000);
  const future = replayMoment(new Date('2026-12-01T00:00:00Z'), now, 'UTC')!;
  assert.deepEqual([future.at.getTime(), future.clamped, future.day], [now.getTime(), true, '2026-11-20']);
  for (const bad of [null, undefined, '', 'أمس', {}, NaN]) assert.equal(replayMoment(bad, now, 'UTC'), null);
});

test('parseLotRefsStrict وparseLotHint: الصارم يرفض أي خلل بـLOT_QTY_INVALID، والتلميح يتسامح بـnull', () => {
  assert.deepEqual(parseLotRefsStrict(undefined, 5), []);
  assert.deepEqual(parseLotRefsStrict([], 5), []);
  assert.deepEqual(parseLotRefsStrict([{ lotId: 'A', qty: 3 }, { lotId: null, qty: 2 }], 5), [{ lotId: 'A', qty: 3 }, { lotId: null, qty: 2 }]);
  for (const bad of [[{ lotId: 'A', qty: 4 }], [{ lotId: 'A', qty: -5 }, { lotId: 'B', qty: 10 }], [{ qty: 5 }], [{ lotId: '', qty: 5 }], 'A', [{ lotId: 'A', qty: '5' }],
    Array.from({ length: 21 }, () => ({ lotId: 'A', qty: 5 / 21 }))]) {
    const r = parseLotRefsStrict(bad, 5);
    assert.ok(r instanceof LotError && r.code === 'LOT_QTY_INVALID' && r.status === 422, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(parseLotHint(undefined), null);
  assert.equal(parseLotHint([{ lotId: 'A', qty: 0 }]), null);
  assert.equal(parseLotHint({ lotId: 'A' }), null);
  assert.deepEqual(parseLotHint([{ lotId: 'A', qty: 1 }, { lotId: 'A', qty: 2 }]), [{ lotId: 'A', qty: 1 }, { lotId: 'A', qty: 2 }]);
});

test('distributeToLines: الصفوف بالترتيب على الأسطر، والصف يُقسم بين سطرين، وΣ كل سطر = كميته', () => {
  const rows: AllocRow[] = [
    { lotId: 'A', qty: 5, certainty: 'ASSUMED', flags: [], expiryDate: '2027-01-01' },
    { lotId: null, qty: 3, certainty: 'UNKNOWN', flags: [], expiryDate: null },
  ];
  const m = distributeToLines(rows, [{ idx: 2, qty: 4 }, { idx: 7, qty: 4 }]);
  assert.deepEqual(m.get(2)!.map((r) => [r.lotId, r.qty]), [['A', 4]]);
  assert.deepEqual(m.get(7)!.map((r) => [r.lotId, r.qty]), [['A', 1], [null, 3]]);
  const dust = distributeToLines([{ lotId: 'A', qty: 0.1 + 0.2, certainty: 'CONFIRMED', flags: [], expiryDate: null }], [{ idx: 0, qty: 0.1 }, { idx: 1, qty: 0.2 }]);
  assert.equal(dust.get(0)![0].qty, 0.1);
  assert.equal(dust.get(1)![0].qty, 0.2);
  assert.throws(() => distributeToLines(rows, [{ idx: 0, qty: 9 }]), /LOT_DISTRIBUTE_MISMATCH/);
});

test('invoiceItemLotColumns: صفوف متداخلة وأعمدة الصلاحية من الختم، وسطرٌ بلا توزيع ⇒ {}', () => {
  const stamp = { expiresAt: new Date('2026-12-01T00:00:00Z'), returnExpired: true, expirySaleInvoiceId: 'sale1' };
  const lines = new Map([[0, { rows: [{ lotId: 'A', qty: 2, certainty: 'CONFIRMED' as const, flags: ['REPLAY_CLAMPED' as const, 'HINT_REJECTED' as const], expiryDate: '2026-12-01', sourceItemLotId: 'x' }], stamp }]]);
  const cols = invoiceItemLotColumns(lines, 0, { tenantId: 't', invoiceId: 'i', productId: 'p', vanKey: 'r' });
  assert.deepEqual(cols, {
    lots: { create: [{ tenantId: 't', invoiceId: 'i', productId: 'p', vanKey: 'r', lotId: 'A', quantity: 2, certainty: 'CONFIRMED', expiryDate: new Date('2026-12-01T00:00:00.000Z'), sourceItemLotId: 'x', flags: 'REPLAY_CLAMPED,HINT_REJECTED' }] },
    expiresAt: stamp.expiresAt, returnExpired: true, expirySaleInvoiceId: 'sale1',
  });
  assert.deepEqual(invoiceItemLotColumns(lines, 1, { tenantId: 't', invoiceId: 'i', productId: 'p', vanKey: null }), {});
  assert.deepEqual(invoiceItemLotColumns(null, 0, { tenantId: 't', invoiceId: 'i', productId: 'p', vanKey: null }), {});
});

test('splitAvailability وmultiLotWarning', () => {
  const v = view({
    lots: [
      { id: 'A', s: 4, held: 1 }, { id: 'B', s: 2, status: 'BLOCKED', blockKind: 'HOLD' }, { id: 'X', s: 3, expiry: '2026-11-01' }, { id: 'C', s: 1, e: 2 },
    ],
    total: { SELLABLE: 12, EXPIRED: 5, DAMAGED: 1 }, heldUnknown: { SELLABLE: 0.5 },
  });
  assert.deepEqual(splitAvailability(v, DAY, { allowUnknown: true }), {
    available: 3 + 1 + 1.5, availableNamed: 4, availableUnknown: 1.5, quarantined: 2, expiredUnsold: 3, held: 1.5, expiredReturned: 5, damaged: 1, unknownDeficit: 0,
  });
  assert.equal(splitAvailability(v, DAY, { allowUnknown: false }).available, 4);
  assert.equal(multiLotWarning(v)!.code, 'LOT_MULTI_IN_VAN');
  assert.equal(multiLotWarning(view({ lots: [{ id: 'A', s: 4 }, { id: 'B', s: 0 }] })), null);
  const neg = view({ lots: [{ id: 'A', s: 4 }], total: { SELLABLE: 1 } });
  assert.equal(splitAvailability(neg, DAY, { allowUnknown: true }).unknownDeficit, 3);
});

// ── الأقفال والأخطاء ──
test('lotLockKey ثابت وموقَّع ٦٤ بت، وsortedLockKeys فريدة مرتّبة بالمفتاح', () => {
  const k = lotLockKey('t1', 'p1');
  assert.equal(typeof k, 'bigint');
  assert.equal(k, lotLockKey('t1', 'p1'));
  assert.notEqual(k, lotLockKey('t2', 'p1'));
  assert.ok(k >= -(2n ** 63n) && k < 2n ** 63n);
  const ids = Array.from({ length: 40 }, (_, i) => `p${i}`);
  const keys = sortedLockKeys('t1', [...ids, ...ids, '']);
  assert.equal(keys.length, 40);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1].key < keys[i].key);
  assert.deepEqual(sortedLockKeys('t1', [...ids].reverse()).map((x) => x.productId), keys.map((x) => x.productId), 'الترتيب لا يتبع ترتيب الإدخال');
});

test('asLotBusy: 55P03 و40P01 وP2028 ⇒ 503 LOT_BUSY، وغيرها null؛ lotHttpError يحوّل LotError والانشغال', () => {
  const busy = [
    { code: 'P2010', meta: { code: '55P03' }, message: 'Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`' },
    { code: 'P2010', meta: { code: '40P01' }, message: 'deadlock detected' },
    { code: 'P2028', message: 'Transaction API error: Transaction already closed' },
    new Error('ERROR: canceling statement due to lock timeout'),
    lotErr('LOT_BUSY'),
  ];
  for (const e of busy) {
    const r = asLotBusy(e);
    assert.ok(r && r.code === 'LOT_BUSY' && r.status === 503, JSON.stringify(e));
  }
  for (const e of [{ code: 'P2002', meta: { target: ['tenantId', 'number'] } }, new Error('boom'), null, undefined, lotErr('LOT_BLOCKED', { lot: 'X' })]) {
    assert.equal(asLotBusy(e), null);
  }
  const blocked = lotErr('LOT_BLOCKED', { lot: 'L-1' });
  assert.deepEqual(lotHttpError(blocked), { status: 422, body: { success: false, code: 'LOT_BLOCKED', message: blocked.message } });
  assert.deepEqual(lotHttpError({ code: 'P2028' })?.status, 503);
  assert.equal(lotHttpError(new Error('x')), null);
  const withDetail = lotErr('LOT_STOCK_INSUFFICIENT', { name: 'X', place: 'المستودع', available: 2 }, { wanted: 3 });
  assert.deepEqual(lotErrorBody(withDetail).detail, { wanted: 3 });
  assert.match(withDetail.message, /الكمية من «X» أكبر من المتاح في تشغيلات المستودع \(2\)/);
});

test('asLockBusy: انتظار القفل وحده (55P03، 40P01) ⇒ LOT_BUSY، ومهلة المعاملة (P2028) والتعارض (P2034) ليسا انشغالاً هنا', () => {
  for (const e of [
    { code: 'P2010', meta: { code: '55P03' }, message: 'canceling statement due to lock timeout' }, { code: 'P2010', meta: { code: '40P01' } },
    new Error('ERROR: deadlock detected'), lotErr('LOT_BUSY'),
  ]) {
    const r = asLockBusy(e);
    assert.ok(r && r.code === 'LOT_BUSY' && r.status === 503, JSON.stringify(e));
  }
  for (const e of [
    { code: 'P2028', message: 'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.' },
    { code: 'P2034' }, new Error('boom'), null, lotErr('LOT_BLOCKED', { lot: 'X' }),
  ]) {
    assert.equal(asLockBusy(e), null, JSON.stringify(e));
  }
  assert.ok(asLotBusy({ code: 'P2028' }), 'ومسارات اللوط بمهلة ٢٠ ثانية (D13، D14) يبقى فيها P2028 انشغالاً');
});

test('ClientRefRace يحاكي P2002 على clientRef فلا تبتلعه إعادة محاولة الرقم', async () => {
  const e = new ClientRefRace();
  assert.equal(e.code, 'P2002');
  assert.ok(!String(e.meta.target).includes('number'));
  let calls = 0;
  await assert.rejects(withNumberRetry(async () => { calls++; throw e; }), (x) => x === e);
  assert.equal(calls, 1, 'لا إعادة محاولة');
  assert.ok(LOT_EPS < 1e-4, 'التسامح أدقّ من خانة التقريب');
});
