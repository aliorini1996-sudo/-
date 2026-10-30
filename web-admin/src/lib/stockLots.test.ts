// «تتبّع اللوط» — W2: منطق شاشتي المخزون الصرف (stockLots.ts) وحرّاس الصفحتين: مخزون الشركة ومخزون السيارات.
// الخادم صاحب القرار (I1/I2 وD10 وD27)، وهذه مرآته للتحقق المسبق والعرض — والقاعدة الحاكمة: الميزة المطفأة لا تغيّر شيئاً (§١٠.١)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  UNKNOWN_KEY, directLoadLotFields, draftFromRows, draftProblem, draftRefs, draftRemaining, emptyEntryLot, entryLotFields,
  entryLotModes, entryLotProblem, hasMultiLotWarning, isFourDecimals, keyLotId, loadSourcesOf, lotRowSummary, needsExplicitSource,
  normalizeEntryLot, outSourcesOf, shelfLifeOn, snapshotSourcesOf, sourceKey, splitDraft, withKnownLotDates,
  type LotRowDraft, type PlaceViewWithAvailability,
} from './stockLots';
import type { BucketQty, LotBalanceDto, LotStatus, VanLotSnapshotDto } from './lots';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
const b = (SELLABLE = 0, EXPIRED = 0, DAMAGED = 0): BucketQty => ({ SELLABLE, EXPIRED, DAMAGED });
const lot = (id: string, expiryDate: string | null, usable: BucketQty, o: { status?: LotStatus; raw?: BucketQty; held?: BucketQty } = {}): LotBalanceDto => ({
  lotId: id,
  meta: {
    id, productId: 'p1', lotNumber: `N-${id}`, productionDate: null, expiryDate,
    status: o.status ?? 'ACTIVE', blockKind: o.status === 'BLOCKED' ? 'RECALL' : null, blockedAt: null, createdAt: '2026-10-01T00:00:00.000Z',
  },
  raw: o.raw ?? usable, held: o.held ?? b(), usable,
});
const view = (lots: LotBalanceDto[], unknownUsable: BucketQty | null, extra: Partial<PlaceViewWithAvailability> = {}): PlaceViewWithAvailability => ({
  productId: 'p1', place: 'WAREHOUSE', vanKey: null, total: b(), lots, unknown: unknownUsable, unknownUsable, deficits: [], approximate: false, ...extra,
});
const DAY = '2026-10-30';

// ─── مصادر الإنقاص والتحميل ───

test('مصادر الإنقاص (D10): كل تشغيلة صالحها موجب أيّاً كانت حالتها، ثم غير المسمّى — والصفر والسالب لا مصدر', () => {
  const v = view([
    lot('a', '2026-11-01', b(5)),
    lot('blk', '2026-12-01', b(2), { status: 'BLOCKED' }),
    lot('old', '2026-10-29', b(1)),            // منتهية أمس
    lot('zero', '2027-01-01', b(0.0000004)),   // دون EPS
    lot('neg', '2027-02-01', b(-3)),
  ], b(4));
  const s = outSourcesOf(v, 'SELLABLE', DAY);
  assert.deepEqual(s.map((x) => [x.lotId, x.usable, x.expired, x.status]), [
    ['a', 5, false, 'ACTIVE'], ['blk', 2, false, 'BLOCKED'], ['old', 1, true, 'ACTIVE'], [null, 4, false, null],
  ]);
  assert.equal(s[0].lotNumber, 'N-a');
  // دلوٌ آخر: المنتهي في سيارة (EXPIRED) له مصادره وحده
  assert.deepEqual(outSourcesOf(view([lot('e', null, b(0, 3))], b(0, 1)), 'EXPIRED', DAY).map((x) => [x.lotId, x.usable]), [['e', 3], [null, 1]]);
  // غير مسمّى سالب أو بلا عرض: لا مصدر
  assert.deepEqual(outSourcesOf(view([], b(-2)), 'SELLABLE', DAY), []);
  assert.deepEqual(outSourcesOf(null, 'SELLABLE', DAY), []);
});

test('مصادر التحميل: النشطة غير المنتهية وحدها ثم غير المسمّى (D17، D27) — ويوم الانتهاء نفسه صالح', () => {
  const v = view([
    lot('a', DAY, b(5)),                                   // ينتهي اليوم: آخر يومٍ صالح
    lot('blk', '2027-01-01', b(2), { status: 'BLOCKED' }),
    lot('old', '2026-10-29', b(1)),
  ], b(3));
  assert.deepEqual(loadSourcesOf(v, DAY).map((x) => x.lotId), ['a', null]);
});

test('لقطة السيارة: المصادر من SELLABLE بيوم اللقطة، والصنف الغائب بلا مصادر', () => {
  const snap: VanLotSnapshotDto = {
    serverTime: '', day: DAY, tracked: ['p1', 'p2'], allowUnknown: true,
    products: [{
      productId: 'p1', available: 7, availableNamed: 5, unknownUsable: 2, quarantined: 0, held: 0, expiredUnsold: 1, expiredReturned: 0, damaged: 0,
      lots: [
        { lotId: 'a', lotNumber: 'A', expiryDate: '2026-12-01', status: 'ACTIVE', blockKind: null, usable: 5 },
        { lotId: 'x', lotNumber: 'X', expiryDate: '2026-10-01', status: 'ACTIVE', blockKind: null, usable: 1 },
        { lotId: 'z', lotNumber: 'Z', expiryDate: null, status: 'ACTIVE', blockKind: null, usable: 0 },
      ],
    }],
  };
  assert.deepEqual(snapshotSourcesOf(snap, 'p1').map((s) => [s.lotId, s.usable, s.expired]), [['a', 5, false], ['x', 1, true], [null, 2, false]]);
  assert.deepEqual(snapshotSourcesOf(snap, 'p2'), []);
  assert.deepEqual(snapshotSourcesOf(null, 'p1'), []);
});

test('مفتاح المصدر في المنتقي: «∅» لغير المسمّى و«» لما لم يُختر — ومصدرٌ واحد لا يلزمه اختيار', () => {
  assert.equal(sourceKey(null), UNKNOWN_KEY);
  assert.equal(sourceKey('l1'), 'l1');
  assert.equal(keyLotId(''), undefined);
  assert.equal(keyLotId(UNKNOWN_KEY), null);
  assert.equal(keyLotId('l1'), 'l1');
  const one = outSourcesOf(view([lot('a', null, b(2))], null), 'SELLABLE', DAY);
  assert.equal(needsExplicitSource(one), false);
  assert.equal(needsExplicitSource(outSourcesOf(view([lot('a', null, b(2))], b(1)), 'SELLABLE', DAY)), true);
});

// ─── مسوّدة صفوف التوزيع ───

test('المسوّدة من الاقتراح: الصفوف الصفرية تسقط والسالبة مطلقة، والصفوف تعود للطلب بالأساس', () => {
  const d = draftFromRows([{ lotId: 'a', qty: 3 }, { lotId: null, qty: -2 }, { lotId: 'b', qty: 0 }]);
  assert.deepEqual(d.map((r) => [r.source, r.qty]), [['a', '3'], [UNKNOWN_KEY, '2']]);
  assert.notEqual(d[0].key, d[1].key);
  assert.deepEqual(draftRefs(d), [{ lotId: 'a', qty: 3 }, { lotId: null, qty: 2 }]);
  // صفٌّ بلا مصدر أو بكمية غير رقمية يسقط من الطلب
  assert.deepEqual(draftRefs([{ key: 'k', source: '', qty: '1' }, { key: 'k2', source: 'a', qty: 'x' }]), []);
});

test('مشكلة المسوّدة: مصدرٌ لكل صف، ولا تكرار، وأربع خانات، والمجموع = كمية السطر، ولا تجاوز لصالح المصدر', () => {
  const sources = outSourcesOf(view([lot('a', null, b(5))], b(2)), 'SELLABLE', DAY);
  const r = (source: string, qty: string): LotRowDraft => ({ key: `${source}${qty}`, source, qty });
  assert.equal(draftProblem([], 3, sources), 'LOT_QTY_INVALID');
  assert.equal(draftProblem([r('', '3')], 3, sources), 'LOT_SOURCE_MISSING');
  assert.equal(draftProblem([r('a', '1'), r('a', '2')], 3, sources), 'LOT_SOURCE_DUPLICATE');
  assert.equal(draftProblem([r('a', '1.00001'), r(UNKNOWN_KEY, '1.99999')], 3, sources), 'LOT_QTY_INVALID', 'خمس خانات تُرفض قبل التقريب');
  assert.equal(draftProblem([r('a', '2')], 3, sources), 'LOT_QTY_INVALID', 'المجموع أقل من السطر');
  assert.equal(draftProblem([r('a', '')], 3, sources), 'LOT_QTY_INVALID');
  assert.equal(draftProblem([r('a', '1'), r(UNKNOWN_KEY, '2.5')], 3.5, sources), 'LOT_OVER_SOURCE', 'غير المسمّى صالحه ٢ (I2)');
  assert.equal(draftProblem([r('gone', '3')], 3, sources), 'LOT_OVER_SOURCE', 'مصدرٌ نفد بعد الاقتراح');
  assert.equal(draftProblem([r('a', '1'), r(UNKNOWN_KEY, '2')], 3, sources), null);
  // سطر التنزيل بإشارته السالبة: المقارنة بالقيمة المطلقة
  assert.equal(draftProblem([r('a', '3')], -3, sources), null);
  // بلا مصادر معروفة: الشكل وحده
  assert.equal(draftProblem([r('zz', '3')], 3, null), null);
});

test('المتبقي والتقسيم: صفٌّ جديد من أول مصدرٍ لم يُؤخذ بما بقي محدوداً بصالحه', () => {
  const sources = outSourcesOf(view([lot('a', '2026-11-01', b(2)), lot('b', '2026-12-01', b(10))], b(1)), 'SELLABLE', DAY);
  const one: LotRowDraft[] = [{ key: 'k1', source: 'a', qty: '2' }];
  assert.equal(draftRemaining(one, 6), 4);
  assert.equal(draftRemaining(one, -6), 4);
  const two = splitDraft(one, 6, sources);
  assert.deepEqual(two.map((x) => [x.source, x.qty]), [['a', '2'], ['b', '4']]);
  const capped = splitDraft([{ key: 'k1', source: 'b', qty: '10' }], 12, sources);
  assert.deepEqual(capped.map((x) => [x.source, x.qty]), [['b', '10'], ['a', '2']], 'الصالح سقف الصفّ الجديد');
  // لا مصدر باقٍ: صفٌّ بلا مصدر يملؤه المستخدم
  const all = splitDraft([{ key: 'k', source: 'a', qty: '1' }, { key: 'k2', source: 'b', qty: '1' }, { key: 'k3', source: UNKNOWN_KEY, qty: '1' }], 5, sources);
  const last = all[all.length - 1];
  assert.deepEqual([last.source, last.qty], ['', '2']);
  // زائدٌ عن السطر: الصفّ الجديد صفر لا سالب
  const over = splitDraft([{ key: 'k', source: 'a', qty: '9' }], 6, sources);
  assert.equal(over[over.length - 1].qty, '0');
});

// ─── تشغيلة سطر الوارد والتسوية والتحميل المباشر ───

test('أوضاع تشغيلة السطر: الوارد بلا «غير مسمّى»، والنقص بلا إنشاء، والوضع غير المسموح يأخذ أول المسموح', () => {
  assert.deepEqual(entryLotModes('RECEIVE'), ['NEW', 'EXISTING']);
  assert.deepEqual(entryLotModes('INCREASE'), ['NEW', 'EXISTING', 'UNKNOWN']);
  assert.deepEqual(entryLotModes('DECREASE'), ['AUTO', 'EXISTING', 'UNKNOWN']);
  assert.equal(normalizeEntryLot(emptyEntryLot('NEW'), 'DECREASE').mode, 'AUTO', 'تسويةٌ قُلبت إشارتها');
  assert.equal(normalizeEntryLot(emptyEntryLot('UNKNOWN'), 'RECEIVE').mode, 'NEW');
  assert.equal(normalizeEntryLot(emptyEntryLot('EXISTING'), 'DECREASE').mode, 'EXISTING');
});

test('مشكلة تشغيلة السطر: الرقم إلزامي، والتاريخان صالحان، والانتهاء مع الصلاحية، والنقص المتعدّد المصادر صريح', () => {
  const d = (p: Partial<ReturnType<typeof emptyEntryLot>>) => ({ ...emptyEntryLot(), ...p });
  assert.equal(entryLotProblem(d({ lotNumber: '  ' }), { kind: 'RECEIVE', expiryRequired: false }), 'LOT_REQUIRED');
  assert.equal(entryLotProblem(d({ lotNumber: 'x'.repeat(65) }), { kind: 'RECEIVE', expiryRequired: false }), 'LOT_REQUIRED', 'فوق ٦٤ حرفاً');
  assert.equal(entryLotProblem(d({ lotNumber: 'L1' }), { kind: 'RECEIVE', expiryRequired: false }), null);
  assert.equal(entryLotProblem(d({ lotNumber: 'L1' }), { kind: 'RECEIVE', expiryRequired: true }), 'LOT_EXPIRY_REQUIRED');
  assert.equal(entryLotProblem(d({ lotNumber: 'L1', productionDate: '2027-01-02', expiryDate: '2027-01-01' }), { kind: 'RECEIVE', expiryRequired: true }), 'LOT_DATES_INVALID');
  assert.equal(entryLotProblem(d({ lotNumber: 'L1', expiryDate: '2027-02-30' }), { kind: 'RECEIVE', expiryRequired: false }), 'LOT_DATES_INVALID');
  assert.equal(entryLotProblem(d({ mode: 'EXISTING' }), { kind: 'INCREASE', expiryRequired: true }), 'LOT_REQUIRED');
  assert.equal(entryLotProblem(d({ mode: 'EXISTING', lotId: 'l1' }), { kind: 'INCREASE', expiryRequired: true }), null, 'القائمة لا تُطلب تواريخها');
  assert.equal(entryLotProblem(d({ mode: 'UNKNOWN' }), { kind: 'INCREASE', expiryRequired: true }), null);
  assert.equal(entryLotProblem(d({ mode: 'AUTO' }), { kind: 'DECREASE', expiryRequired: false, sourcesCount: 2 }), 'LOT_REQUIRED', 'D10');
  assert.equal(entryLotProblem(d({ mode: 'AUTO' }), { kind: 'DECREASE', expiryRequired: false, sourcesCount: 1 }), null);
  // الوارد لا يقبل «غير مسمّى»: يُقرأ رقماً جديداً فيلزمه الرقم
  assert.equal(entryLotProblem(d({ mode: 'UNKNOWN' }), { kind: 'RECEIVE', expiryRequired: false }), 'LOT_REQUIRED');
});

test('حقول تشغيلة بند الوارد (عقد warehouse.ts): الرقم مطبَّعاً وتاريخاه، أو lotId، أو null صريح، والتلقائي بلا حقل', () => {
  assert.deepEqual(entryLotFields({ ...emptyEntryLot(), lotNumber: ' ab-1 ', expiryDate: '2027-01-01' }), { lotNumber: 'AB-1', productionDate: null, expiryDate: '2027-01-01' });
  assert.deepEqual(entryLotFields({ ...emptyEntryLot('EXISTING'), lotId: 'l1', lotNumber: 'ignored' }), { lotId: 'l1' });
  assert.deepEqual(entryLotFields(emptyEntryLot('UNKNOWN')), { lotId: null });
  assert.deepEqual(entryLotFields(emptyEntryLot('AUTO')), {});
});

test('التحميل المباشر بلا مستودع (D4): القائمة وغير المسمّى صفٌّ بكمية السطر الأساسية، والجديدة رقمٌ وتاريخان', () => {
  assert.deepEqual(directLoadLotFields({ ...emptyEntryLot('EXISTING'), lotId: 'l1' }, 48), { lots: [{ lotId: 'l1', qty: 48 }] });
  assert.deepEqual(directLoadLotFields({ ...emptyEntryLot('EXISTING'), lotId: '' }, 48), {}, 'بلا اختيار لا صفّ');
  assert.deepEqual(directLoadLotFields(emptyEntryLot('UNKNOWN'), -2.5), { lots: [{ lotId: null, qty: 2.5 }] });
  assert.deepEqual(directLoadLotFields({ ...emptyEntryLot('NEW'), lotNumber: 'x9', productionDate: '2026-10-01' }, 6), { lotNumber: 'X9', productionDate: '2026-10-01', expiryDate: null });
  // AUTO لا معنى له للزيادة: يُقرأ أول المسموح (رقم جديد)
  assert.deepEqual(directLoadLotFields({ ...emptyEntryLot('AUTO'), lotNumber: 'n1' }, 1), { lotNumber: 'N1', productionDate: null, expiryDate: null });
});

test('رقمٌ مسجَّل يأخذ تاريخيه ما دام حقلاهما فارغين — ولا يكتب فوق ما كتبه المستخدم', () => {
  const known = [{ lotNumber: 'L-7', productionDate: '2026-01-01T00:00:00.000Z', expiryDate: '2027-01-01' }];
  assert.deepEqual(withKnownLotDates({ ...emptyEntryLot(), lotNumber: 'l-7' }, known), { ...emptyEntryLot(), lotNumber: 'l-7', productionDate: '2026-01-01', expiryDate: '2027-01-01' });
  const typed = { ...emptyEntryLot(), lotNumber: 'L-7', expiryDate: '2027-06-01' };
  assert.equal(withKnownLotDates(typed, known).expiryDate, '2027-06-01');
  assert.deepEqual(withKnownLotDates({ ...emptyEntryLot(), lotNumber: 'L-8' }, known), { ...emptyEntryLot(), lotNumber: 'L-8' });
});

test('أربع خانات (isLotQty): ما فوقها يُرفض قبل الإرسال', () => {
  assert.equal(isFourDecimals(1.2345), true);
  assert.equal(isFourDecimals(48), true);
  assert.equal(isFourDecimals(1.23456), false);
  assert.equal(isFourDecimals(Number.NaN), false);
  assert.equal(isFourDecimals(0.1 + 0.2), true, 'ضجيج الفاصلة العائمة ليس خانةً خامسة');
});

test('الصلاحية مفعّلة (مرآة shelfLifeOf): مدةٌ صحيحة موجبة ووحدةٌ معروفة — فانتهاء التشغيلة إلزامي', () => {
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }), true);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 0, shelfLifeUnit: 'MONTH' }), false);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 1.5, shelfLifeUnit: 'DAY' }), false);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'WEEK' }), false);
  assert.equal(shelfLifeOn({ shelfLifeEnabled: false, shelfLifeValue: 3, shelfLifeUnit: 'YEAR' }), false);
  assert.equal(shelfLifeOn(null), false);
});

// ─── ملخّص صفّ الرصيد والتحذيرات ───

test('ملخّص صفّ الرصيد: التشغيلات ذات الخام، والمعزول (موقوف أو منتهٍ)، والمحجوز، وغير المسمّى، والعجز', () => {
  const v = view([
    lot('a', '2027-01-01', b(4), { held: b(1), raw: b(5) }),
    lot('blk', '2027-01-01', b(2), { status: 'BLOCKED' }),
    lot('old', '2026-10-01', b(3)),
    lot('none', '2027-01-01', b(0), { raw: b(0) }),
  ], b(-1), { unknown: b(-1), deficits: [{ lotId: null, bucket: 'SELLABLE', qty: -1 }] });
  assert.deepEqual(lotRowSummary(v, DAY), { lots: 3, quarantined: 5, held: 1, unknown: -1, deficit: true });
  const clean = view([lot('a', null, b(2))], b(0), { unknown: b(0) });
  assert.deepEqual(lotRowSummary(clean, DAY), { lots: 1, quarantined: 0, held: 0, unknown: 0, deficit: false });
  assert.equal(lotRowSummary(undefined, DAY), null);
  // تشغيلةٌ صالحها سالب (خلل) عجزٌ ولو كان غير المسمّى موجباً
  const neg = view([lot('n', null, b(-2))], b(1), { unknown: b(1), deficits: [{ lotId: 'n', bucket: 'SELLABLE', qty: -2 }] });
  assert.equal(lotRowSummary(neg, DAY)!.deficit, true);
});

test('تحذير اللوطين للصنف وحده', () => {
  const w = [{ code: 'LOT_MULTI_IN_VAN' as const, productId: 'p1' }, { code: 'LOT_FROM_UNKNOWN' as const, productId: 'p2' }];
  assert.equal(hasMultiLotWarning(w, 'p1'), true);
  assert.equal(hasMultiLotWarning(w, 'p2'), false);
  assert.equal(hasMultiLotWarning(undefined, 'p1'), false);
});

// ─── حرّاس الشاشات ───

test('مخزون الشركة: كل جلبٍ للتشغيلات خلف علم الشركة، والأسطر بـrowId، وتشغيلة البند للصنف المتتبَّع وحده', () => {
  const s = read('pages', 'CompanyWarehousePage.tsx');
  assert.match(s, /const lotOn = lotFlagsOf\(companyQ\.data as \{ lotTrackingEnabled\?: unknown \} \| null \| undefined\)\.on;/);
  assert.match(s, /queryKey: \['products-min'\],[\s\S]{0,200}?enabled: accountingReady && accountingOn && lotOn,/, 'الأصناف المتتبَّعة تُجلب والميزة مفعّلة وحدها');
  assert.match(s, /queryKey: \['lot-balances-wh', asOf, trackedIds\.join\(','\)\],[\s\S]{0,120}?enabled: lotOn && trackedIds\.length > 0,/);
  assert.match(s, /queryKey: \['lot-balances-wh', '', decIds\.join\(','\)\],[\s\S]{0,120}?enabled: lotOn && decIds\.length > 0,/);
  assert.match(s, /const isTracked = \(id: string\) => lotOn && productOf\(id\)\?\.lotTracked === true;/);
  assert.ok(s.includes('...(isTracked(r.productId) && entryLotFields(normalizeEntryLot(r.lot, lotKind(r)))),'), 'غير المتتبَّع بلا حقلٍ جديد');
  assert.ok(s.includes('<div key={r.rowId} className="px-3 py-2">'), 'الفهرسة بـrowId');
  assert.ok(!/r\.productId === id \? \{ \.\.\.r, qty/.test(s), 'لا تحديث للكمية بالصنف (سطران لصنفٍ متتبَّع)');
  // الصنف غير المتتبَّع: سطرٌ واحد كما كان
  assert.ok(s.includes('if (!id || (rows.some(r => r.productId === id) && !isTracked(id))) return;'));
  assert.ok(s.includes('doc={withEntryLots(warehouseNoticeDocFromEntry(noticeOf, companyQ.data ?? null), noticeOf, lotOn)}'));
  assert.match(s, /const vansLotUnsellable = lotOn \? roundLot\(/, 'المعزول والمحجوز في بطاقة السيارات خلف العلم');
  // D10: الحفظ ينتظر مصادر النقص — لا يُحكم على «التلقائي» قبل أن يُعرف أهو مصدرٌ وحيد
  assert.ok(s.includes('const srcPending = decIds.length > 0 && srcQ.isLoading;'));
  assert.match(s, /const valid = !srcPending && rows\.length > 0 && rows\.every\(/);
});

test('مخزون السيارات: لا window.prompt، والإتلاف تسوية نقص موسومة، والتحميل لا يُكرَّر، والجلب خلف العلم', () => {
  const s = read('pages', 'VanStockPage.tsx');
  assert.ok(!s.includes('window.prompt('), 'نافذة الإزالة بدل window.prompt');
  assert.ok(s.includes('<RemoveOutModal row={removing.row} kind={removing.kind} repId={selected} tracked={trackedSet.has(removing.row.productId)}'));
  assert.ok(s.includes("type: 'ADJUST', note: tr('إتلاف تشغيلة منتهية لم تبع'),"));
  assert.ok(s.includes("items: [{ productId: a.productId, qty: -a.qty, lots: [{ lotId: a.lotId, qty: a.qty }], lotReason: 'EXPIRED_UNSOLD_DESTROY' }],"));
  // إصلاح التكرار (نمط MRepLoad): أسطر التحميل تسقط بعد كتابة وثيقته وقبل التنزيل
  const save = s.slice(s.indexOf('const { out, back } = splitVanMovement('));
  const outAt = save.indexOf("type: 'LOAD', note: trimmed, items: out");
  const dropAt = save.indexOf('setRows(rs => rs.filter(r => !(Number(r.qty) > 0)));');
  const backAt = save.indexOf("type: 'UNLOAD', note: trimmed, items: back");
  assert.ok(outAt > 0 && dropAt > outAt && backAt > dropAt);
  assert.ok(s.includes('vanStockApi.movements(selected, lotOn ? { withLots: true } : undefined)'), 'withLots مع الميزة وحدها (D11)');
  assert.match(s, /queryKey: \['van-lot-balances', selected\],[\s\S]{0,160}?enabled: lotOn && !!selected && accountingReady && accountingOn,/);
  assert.match(s, /queryKey: \['lot-balances-load', trackedIds\.join\(','\)\],[\s\S]{0,120}?enabled: lotOn && trackedIds\.length > 0,/);
  assert.match(s, /const isTracked = \(id: string\) => lotOn && productOf\(id\)\?\.lotTracked === true;/);
  assert.match(s, /const lotFields = \(r: LoadRow\) => \{\r?\n\s*if \(!isTracked\(r\.productId\)\) return \{\};/, 'غير المتتبَّع بلا حقلٍ جديد');
  assert.ok(s.includes('{lotOn && reps.length > 0 && ('), 'تنبيه «المتتبَّعة ممنوعة دائماً» خلف العلم');
  assert.ok(s.includes("unitFactor: factor"), 'الاقتراح بقاعدة الكرتون (D22)');
});
