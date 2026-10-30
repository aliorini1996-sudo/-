// «تتبّع اللوط» — W3: منطق صفحة «التشغيلات» الصرف (lib/lotsPage.ts) وحرّاسٌ نصّية على الصفحة والتنقّل (App.tsx وMainLayout.tsx).
// القاعدة الحاكمة: الخادم صاحب القرار (D27 وI1 وI2)، وهذه مراياه للعرض والتحقق المسبق؛ والميزة المطفأة لا بند ولا مسار ولا جلب (§١٠.١)
// أيام التصدير وساعاته بتوقيت المتصفّح (كصفحة الفواتير) — تُثبَّت المنطقة كي لا تتبدّل النتيجة بجهاز التشغيل
process.env.TZ = 'Asia/Riyadh';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  autoBroad, defaultRelabelPlace, eventKindLabel, expiryState, extendsExpiry, healthByProduct, lotQtyOk, lotStatusLabel,
  originKindLabel, placeName, relabelProblem, relabelReasonOf, relabelSources, statusActions, traceSheets, traceTotals, unloadBody,
  LOT_REP_GONE_NAME, TRACE_PLACE_COLUMNS, localStamp, vanName,
  type LotDeficitRow, type RelabelLineForm, type RelabelSource,
} from './lotsPage';
import { LOT_BLOCK_KIND_LABELS, LOT_STATUS_LABELS, type LotTraceDto, type PlaceLotViewDto } from './lots';
import { PHRASES } from '../i18n/strings';

const tr = (s: string) => s;
const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
const B = (SELLABLE = 0, EXPIRED = 0, DAMAGED = 0) => ({ SELLABLE, EXPIRED, DAMAGED });

const meta = (id: string, over: Partial<PlaceLotViewDto['lots'][number]['meta']> = {}) => ({
  id, productId: 'p1', lotNumber: id.toUpperCase(), productionDate: null, expiryDate: null,
  status: 'ACTIVE' as const, blockKind: null, blockedAt: null, createdAt: '2026-10-01T00:00:00.000Z', ...over,
});
const view = (lots: PlaceLotViewDto['lots'], unknownUsable: number | null, place: 'WAREHOUSE' | 'VAN' = 'WAREHOUSE'): PlaceLotViewDto => ({
  productId: 'p1', place, vanKey: place === 'VAN' ? 'r1' : null, total: null, lots,
  unknown: unknownUsable == null ? null : B(unknownUsable), unknownUsable: unknownUsable == null ? null : B(unknownUsable),
  deficits: [], approximate: false,
});
const bal = (id: string, usable: number, over: Partial<PlaceLotViewDto['lots'][number]['meta']> = {}) =>
  ({ lotId: id, meta: meta(id, over), raw: B(usable), held: B(), usable: B(usable) });

// ─── الحالة والإيقاف والسحب (§٤.١٦) ───

test('statusActions: النشطة تُوقف أو تُسحب، والموقوفة تُصعَّد أو تُعاد، والمسحوبة تُعاد وحدها', () => {
  const kinds = (l: Parameters<typeof statusActions>[0]) => statusActions(l).map((a) => `${a.status}:${a.blockKind ?? ''}`);
  assert.deepEqual(kinds({ status: 'ACTIVE', blockKind: null }), ['BLOCKED:HOLD', 'BLOCKED:RECALL']);
  assert.deepEqual(kinds({ status: 'BLOCKED', blockKind: 'HOLD' }), ['BLOCKED:RECALL', 'ACTIVE:']);
  assert.deepEqual(kinds({ status: 'BLOCKED', blockKind: 'RECALL' }), ['ACTIVE:']);
  // موقوفةٌ بلا نوع (صفٌّ قديم) تُعامل كالإيقاف الاحترازي: يُصعَّد أو يُعاد
  assert.deepEqual(kinds({ status: 'BLOCKED', blockKind: null }), ['BLOCKED:RECALL', 'ACTIVE:']);
  assert.equal(statusActions({ status: 'ACTIVE', blockKind: null }).find((a) => a.blockKind === 'RECALL')?.danger, true, 'السحب فعلٌ خطِر');
});

test('autoBroad: النطاق الموسّع تلقائيٌّ في السحب وحده', () => {
  assert.equal(autoBroad({ status: 'BLOCKED', blockKind: 'RECALL' }), true);
  assert.equal(autoBroad({ status: 'BLOCKED', blockKind: 'HOLD' }), false);
  assert.equal(autoBroad({ status: 'ACTIVE', blockKind: null }), false);
  assert.equal(autoBroad(null), false);
  assert.equal(autoBroad(undefined), false);
});

test('lotStatusLabel: النشطة، ونوع الإيقاف، والموقوفة بلا نوع', () => {
  assert.equal(lotStatusLabel({ status: 'ACTIVE', blockKind: null }), LOT_STATUS_LABELS.ACTIVE);
  assert.equal(lotStatusLabel({ status: 'BLOCKED', blockKind: 'RECALL' }), LOT_BLOCK_KIND_LABELS.RECALL);
  assert.equal(lotStatusLabel({ status: 'BLOCKED', blockKind: 'HOLD' }), LOT_BLOCK_KIND_LABELS.HOLD);
  assert.equal(lotStatusLabel({ status: 'BLOCKED', blockKind: null }), LOT_STATUS_LABELS.BLOCKED);
});

test('expiryState: يوم الانتهاء نفسه آخر يوم صالح، والقريب ضمن النافذة، ولحظة ISO تُقرأ يوماً', () => {
  assert.equal(expiryState('2026-10-30', '2026-10-30'), 'soon', 'يوم الانتهاء صالح');
  assert.equal(expiryState('2026-10-29', '2026-10-30'), 'expired');
  assert.equal(expiryState('2026-11-29', '2026-10-30', 30), 'soon', 'اليوم الثلاثون داخل النافذة');
  assert.equal(expiryState('2026-11-30', '2026-10-30', 30), 'ok');
  assert.equal(expiryState('2026-12-31T00:00:00.000Z', '2026-12-31'), 'soon', 'عمود @db.Date يصل لحظةً');
  assert.equal(expiryState(null, '2026-10-30'), 'none');
  assert.equal(expiryState('ليس تاريخاً', '2026-10-30'), 'none');
  // نافذةٌ تعبر السنة والشهر القصير
  assert.equal(expiryState('2027-01-29', '2026-12-31', 30), 'soon');
  assert.equal(expiryState('2027-03-02', '2027-02-28', 1), 'ok', 'فبراير ٢٨ يوماً: +١ = ١ مارس');
  assert.equal(expiryState('2027-03-02', '2027-02-28', 2), 'soon');
});

test('extendsExpiry: المدّ والمحو مدٌّ، والتقصير والإضافة لتشغيلةٍ بلا انتهاء ليسا مدّاً (مرآة PATCH /lots/:id)', () => {
  assert.equal(extendsExpiry('2026-10-30', '2026-11-30'), true);
  assert.equal(extendsExpiry('2026-10-30', null), true, 'محو الانتهاء يعيد المنتهي إلى البيع');
  assert.equal(extendsExpiry('2026-10-30', ''), true);
  assert.equal(extendsExpiry('2026-10-30', '2026-10-30'), false);
  assert.equal(extendsExpiry('2026-10-30', '2026-10-01'), false, 'التقصير حرّ');
  assert.equal(extendsExpiry(null, '2027-01-01'), false, 'بلا انتهاءٍ قبله لا مدّ');
  assert.equal(extendsExpiry('2026-10-30T00:00:00.000Z', '2026-10-31'), true);
});

test('unloadBody: صالح «صالح للبيع» بلوطٍ صريح، والمحذوفة بـdeletedSalesRepId (D30)، والصفر لا جسم له', () => {
  const lot = { id: 'L1', productId: 'p1' };
  const live = unloadBody(lot, { salesRepId: 'r1', repName: 'أحمد', deleted: false, usable: B(12.34567, 3, 1), held: B(2) }, 'ملاحظة');
  assert.deepEqual(live, {
    type: 'UNLOAD', salesRepId: 'r1', note: 'ملاحظة',
    items: [{ productId: 'p1', qty: 12.3457, lots: [{ lotId: 'L1', qty: 12.3457 }] }],
  }, 'الصالح للبيع وحده مقرَّباً لأربع خانات — والمنتهي والتالف والمحجوز لا يُنزَّلون هنا');
  const gone = unloadBody(lot, { salesRepId: 'old-rep', repName: 'مندوب محذوف', deleted: true, usable: B(5), held: B() }, 'x');
  assert.equal(gone?.deletedSalesRepId, 'old-rep');
  assert.equal('salesRepId' in (gone ?? {}), false, 'المحذوفة بلا salesRepId (يُتخطّى resolveRep)');
  assert.equal(unloadBody(lot, { salesRepId: 'r1', repName: null, deleted: false, usable: B(0, 4), held: B(3) }, 'x'), null);
  assert.equal(unloadBody(lot, { salesRepId: 'r1', repName: null, deleted: false, usable: B(-2), held: B() }, 'x'), null, 'العجز لا يُنزَّل');
  assert.equal(unloadBody(lot, { salesRepId: 'r1', repName: null, deleted: false, usable: B(1e-8), held: B() }, 'x'), null);
});

// ─── التسمية وإعادة التصنيف (§٤.٦، D27) ───

test('relabelSources: غير المسمّى الصالح أولاً ثم كل تشغيلة لها صالح — الموقوفة والمنتهية ممنوعتان بسببهما', () => {
  const v = view([
    bal('a', 5, { expiryDate: '2026-10-30' }),
    bal('b', 3, { status: 'BLOCKED', blockKind: 'HOLD' }),
    bal('c', 2, { expiryDate: '2026-10-29' }),
    bal('d', 0),
  ], 4);
  const s = relabelSources(v, 'SELLABLE', '2026-10-30');
  assert.deepEqual(s.map((x) => [x.lotId, x.usable, x.blockedWhy]), [
    [null, 4, null],
    ['a', 5, null],
    ['b', 3, 'التشغيلة موقوفة لا يعاد تصنيفها'],
    ['c', 2, 'التشغيلة منتهية لا يعاد تصنيفها'],
  ], 'يوم الانتهاء صالح، والصفر لا يظهر');
  assert.deepEqual(relabelSources(view([bal('a', 5)], -3), 'SELLABLE', '2026-10-30').map((x) => x.lotId), ['a'], 'غير المسمّى السالب ليس مصدراً');
  assert.deepEqual(relabelSources(view([bal('a', 5)], null, 'VAN'), 'SELLABLE', '2026-10-30').map((x) => x.lotId), ['a'], 'سيارة المحذوف: غير المسمّى مجهول');
  assert.deepEqual(relabelSources(view([bal('a', 5)], 4), 'EXPIRED', '2026-10-30'), [], 'الدلو المطلوب وحده');
  assert.deepEqual(relabelSources(null, 'SELLABLE', '2026-10-30'), []);
});

test('defaultRelabelPlace: يُفتح حيث المصدر الافتراضي صالح، وإلا أول الأماكن', () => {
  const places = [
    { key: 'WAREHOUSE', view: view([bal('x', 9)], 0) },
    { key: 'VAN:r1', view: view([bal('L1', 4)], 6, 'VAN') },
    { key: 'VAN:r2', view: view([bal('L1', 2, { status: 'BLOCKED' })], 0, 'VAN') },
  ];
  assert.equal(defaultRelabelPlace(places, 'L1', '2026-10-30')?.key, 'VAN:r1', 'إعادة التصنيف: التشغيلة في سيارة');
  assert.equal(defaultRelabelPlace(places, null, '2026-10-30')?.key, 'VAN:r1', 'التسمية: أول مكانٍ فيه غير مسمّى صالح');
  assert.equal(defaultRelabelPlace(places.slice(2), 'L1', '2026-10-30')?.key, 'VAN:r2', 'الموقوفة ليست مصدراً — فالأول');
  assert.equal(defaultRelabelPlace([], null, '2026-10-30'), null);
});

test('relabelReasonOf: من غير المسمّى تسمية، وإلى غير المسمّى تصحيح، وبين تشغيلتين إعادة تصنيف', () => {
  assert.equal(relabelReasonOf(null, false), 'LABEL_EXISTING');
  assert.equal(relabelReasonOf('L1', false), 'RECLASSIFY');
  assert.equal(relabelReasonOf('L1', true), 'CORRECTION');
});

test('lotQtyOk: موجبة بأربع خانات على الأكثر (isLotQty)', () => {
  for (const ok of ['1', '0.0001', '12.3456', 5, ' 7 ']) assert.equal(lotQtyOk(ok), true, String(ok));
  for (const bad of ['0', '-1', '1.23456', 'abc', '', 0, Number.NaN, Infinity]) assert.equal(lotQtyOk(bad), false, String(bad));
});

test('relabelProblem: المصدر والأسطر والوجهة والملاحظة والتواريخ والمجموع — بمفاتيح القاموس', () => {
  const unk: RelabelSource = { lotId: null, lotNumber: null, usable: 10, blockedWhy: null, expiryDate: null };
  const fromA: RelabelSource = { lotId: 'A', lotNumber: 'A', usable: 4, blockedWhy: null, expiryDate: null };
  const line = (p: Partial<RelabelLineForm>): RelabelLineForm => ({ mode: 'EXISTING', toLotId: 'B', lotNumber: '', productionDate: '', expiryDate: '', qty: '1', ...p });
  const ok = (source: RelabelSource | null, lines: RelabelLineForm[], note = '', expiryRequired = false) => relabelProblem({ source, lines, note, expiryRequired });
  assert.equal(ok(null, [line({})]), 'اختر مصدر الكمية');
  assert.equal(ok({ ...fromA, blockedWhy: 'التشغيلة موقوفة لا يعاد تصنيفها' }, [line({})]), 'التشغيلة موقوفة لا يعاد تصنيفها', 'D27');
  assert.equal(ok(unk, []), 'أضف سطرا واحدا على الأقل');
  assert.equal(ok(unk, [line({ qty: '1.23456' })]), 'كمية غير صالحة');
  assert.equal(ok(unk, [line({ toLotId: null })]), 'اختر التشغيلة');
  assert.equal(ok(fromA, [line({ toLotId: 'A' })]), 'التسمية من التشغيلة إليها نفسها أو بلا طرفين', 'from == to');
  assert.equal(ok(unk, [line({ mode: 'NEW', lotNumber: '  ' })]), 'اكتب رقم التشغيلة');
  assert.equal(ok(unk, [line({ mode: 'NEW', lotNumber: 'n1' })], '', true), 'تاريخ انتهاء التشغيلة إلزامي لصنف صلاحيته مفعلة');
  assert.equal(ok(unk, [line({ mode: 'NEW', lotNumber: 'n1', productionDate: '2026-12-01', expiryDate: '2026-11-01' })]), 'تاريخ الإنتاج بعد تاريخ الانتهاء أو تاريخ غير صالح');
  assert.equal(ok(unk, [line({ mode: 'UNKNOWN', toLotId: null })]), 'التسمية من التشغيلة إليها نفسها أو بلا طرفين', 'من غير المسمّى إليه');
  assert.equal(ok(fromA, [line({ mode: 'UNKNOWN', toLotId: null })], '  '), 'التصحيح إلى غير المسمى يحتاج ملاحظة');
  assert.equal(ok(fromA, [line({ mode: 'UNKNOWN', toLotId: null })], 'عدّ فعلي'), null);
  // المجموع عبر الأسطر (D26): كلٌّ ضمن المتاح ومجموعهما فوقه
  assert.equal(ok(fromA, [line({ qty: '2.5' }), line({ mode: 'NEW', lotNumber: 'n2', qty: '1.5' })]), null, 'المجموع = المتاح');
  assert.equal(ok(fromA, [line({ qty: '2.5' }), line({ mode: 'NEW', lotNumber: 'n2', qty: '1.5001' })]), 'الكمية أكبر من المتاح في المصدر');
  assert.equal(ok(unk, [line({ mode: 'NEW', lotNumber: 'n1', expiryDate: '2027-01-01', qty: '10' })], '', true), null);
});

test('كل ما تعيده lotsPage.ts نصّاً للعرض مترجمٌ بالأربع (يمرّ إلى tr بمتغيّر فلا يلتقطه جرد tr(…))', () => {
  const keys = new Set<string>([
    ...statusActions({ status: 'ACTIVE', blockKind: null }).map((a) => a.label),
    ...statusActions({ status: 'BLOCKED', blockKind: 'HOLD' }).map((a) => a.label),
    lotStatusLabel({ status: 'ACTIVE', blockKind: null }), lotStatusLabel({ status: 'BLOCKED', blockKind: null }),
    lotStatusLabel({ status: 'BLOCKED', blockKind: 'HOLD' }), lotStatusLabel({ status: 'BLOCKED', blockKind: 'RECALL' }),
    ...relabelSources(view([bal('b', 3, { status: 'BLOCKED' }), bal('c', 2, { expiryDate: '2020-01-01' })], 0), 'SELLABLE', '2026-10-30')
      .map((s) => s.blockedWhy!),
  ]);
  // كل مسارات relabelProblem
  const unk: RelabelSource = { lotId: null, lotNumber: null, usable: 1, blockedWhy: null, expiryDate: null };
  const A: RelabelSource = { ...unk, lotId: 'A' };
  const L = (p: Partial<RelabelLineForm>): RelabelLineForm => ({ mode: 'EXISTING', toLotId: 'B', lotNumber: '', productionDate: '', expiryDate: '', qty: '1', ...p });
  for (const [source, lines, note, req] of [
    [null, [L({})], '', false], [unk, [], '', false], [unk, [L({ qty: 'x' })], '', false], [unk, [L({ toLotId: null })], '', false],
    [A, [L({ toLotId: 'A' })], '', false], [unk, [L({ mode: 'NEW' })], '', false], [unk, [L({ mode: 'NEW', lotNumber: 'n' })], '', true],
    [unk, [L({ mode: 'NEW', lotNumber: 'n', expiryDate: 'x' })], '', false], [A, [L({ mode: 'UNKNOWN' })], '', false], [unk, [L({ qty: '2' })], '', false],
  ] as [RelabelSource | null, RelabelLineForm[], string, boolean][]) {
    const p = relabelProblem({ source, lines, note, expiryRequired: req });
    assert.ok(p, 'كل حالةٍ هنا مرفوضة');
    keys.add(p!);
  }
  for (const k of ['ADJUST', 'LOAD', 'RELABEL', 'RETURN', 'RECEIVE', 'OPENING_IMPORT', 'MANUAL']) keys.add(originKindLabel(k, tr));
  for (const k of ['CREATE', 'BLOCK', 'UNBLOCK', 'RELABEL', 'TRACKING_OFF']) keys.add(eventKindLabel(k, tr));
  for (const k of keys) {
    const row = PHRASES[k];
    assert.ok(row, `«${k}» غائب عن القاموس`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(row[lang]?.trim(), `«${k}» بلا ${lang}`);
  }
});

// ─── سلامة الأرصدة والتتبّع ───

test('healthByProduct: العجوزات بالصنف بترتيب أول ظهور', () => {
  const r = (productId: string, lotId: string | null, qty: number): LotDeficitRow => ({
    productId, productName: productId.toUpperCase(), place: 'VAN', salesRepId: 'r1', repName: 'أحمد', lotId, lotNumber: lotId, bucket: 'SELLABLE', qty,
  });
  const g = healthByProduct([r('p2', 'L1', -1), r('p1', null, -2), r('p2', null, -3)]);
  assert.deepEqual(g.map((x) => [x.productId, x.rows.map((y) => y.qty)]), [['p2', [-1, -3]], ['p1', [-2]]]);
  assert.deepEqual(healthByProduct([]), []);
});

const trace = (over: Partial<LotTraceDto> = {}): LotTraceDto => ({
  lot: { ...meta('L1', { lotNumber: 'A-12', expiryDate: '2027-01-01', productionDate: '2026-01-01' }), productName: 'حليب', source: 'RECEIVE', note: null },
  origin: [{ kind: 'RECEIVE', at: '2026-09-01T08:00:00.000Z', ref: 'e1', qty: 100 }, { kind: 'RELABEL', at: '2026-09-02T08:00:00.000Z', ref: 'x', qty: -4 }],
  places: [
    { place: 'WAREHOUSE', salesRepId: null, repName: null, raw: B(40), usable: B(40), held: B(), approximate: false, loaded: 60, unloaded: 0, sold: 0, returned: 0 },
    { place: 'VAN', salesRepId: 'gone', repName: 'مندوب محذوف', raw: B(3, 1), usable: B(2, 1), held: B(1), approximate: true, loaded: 60, unloaded: 0, sold: 57.12345, returned: 1 },
  ],
  customers: [
    { customerId: 'c1', name: 'بقالة', phone: '050', address: null, city: 'الرياض', invoices: [
      { invoiceId: 'i1', number: 'INV-1', date: '2026-09-03T00:00:00.000Z', sold: 5, returned: 5, net: 0, weakest: 'CONFIRMED', flags: [], broad: false },
      { invoiceId: 'i2', number: 'INV-2', date: '2026-09-04T00:00:00.000Z', sold: 2.5, returned: 0, net: 2.5, weakest: 'ASSUMED', flags: ['SPLIT_UNIT'], broad: true },
    ] },
    { customerId: 'c2', name: 'تموينات', phone: null, address: null, city: null, invoices: [
      { invoiceId: 'i3', number: 'INV-3', date: '2026-09-05T00:00:00.000Z', sold: 0.33333, returned: 0, net: 0.33333, weakest: 'UNKNOWN', flags: [], broad: false },
    ] },
  ],
  customersHidden: false, scoped: false, scope: 'BROAD',
  events: [{ kind: 'BLOCK', at: '2026-09-10T10:20:30.000Z', actorName: 'مدير', reason: 'شكوى' }],
  ...over,
});

test('traceTotals: صافي الصفر يُعدّ عميلاً وفاتورة (ن١-٢)، والموسّع يُحصى، والمجموع بأربع خانات', () => {
  assert.deepEqual(traceTotals(trace()), { sold: 7.8333, returned: 5, net: 2.8333, customers: 2, invoices: 3, broad: 1 });
  assert.deepEqual(traceTotals(trace({ customers: null })), { sold: 0, returned: 0, net: 0, customers: 0, invoices: 0, broad: 0 });
});

test('placeName والتسميات: المستودع مترجم، والمحذوف مترجماً لا باسم الخادم العربي، والنوع المجهول كما هو', () => {
  const br = (s: string) => `[${s}]`;
  assert.equal(placeName({ place: 'WAREHOUSE', salesRepId: null, repName: null }, br), '[المستودع]');
  assert.equal(placeName({ place: 'VAN', salesRepId: 'r1', repName: 'أحمد' }, br), 'أحمد');
  assert.equal(placeName({ place: 'VAN', salesRepId: 'r1', repName: null }, br), '[سيارة المندوب]');
  // سيارة المندوب المحذوف: الخادم يرسل «مندوب محذوف» نصّاً عربياً — العرض بـtr مع ذيلٍ من معرّفها يميّز المحذوفات
  assert.equal(placeName({ place: 'VAN', salesRepId: 'gone-1234-x', repName: LOT_REP_GONE_NAME, approximate: true }, br), '[مندوب محذوف] · gone-1');
  assert.notEqual(
    vanName({ salesRepId: 'aaaaaa11', repName: LOT_REP_GONE_NAME, deleted: true }, br),
    vanName({ salesRepId: 'bbbbbb22', repName: LOT_REP_GONE_NAME, deleted: true }, br),
    'محذوفتان لا تتطابقان',
  );
  assert.equal(vanName({ salesRepId: 'r1', repName: 'أحمد', deleted: false }, br), 'أحمد');
  // /lots/health بلا علم: اسم الخادم البديل علامة المحذوف
  assert.equal(vanName({ salesRepId: 'old-rep', repName: LOT_REP_GONE_NAME }, br), '[مندوب محذوف] · old-re');
  // الصفحة: خطة التنزيل وتأكيدها وأماكن التسمية والسلامة كلها بـvanName/placeName — لا اسم خادمٍ معروضاً كما هو
  const page = src('pages', 'LotsPage.tsx');
  assert.ok(!/repName \|\|/.test(page), 'لا repName || … في الصفحة');
  assert.ok((page.match(/vanName\((r|unloadRow|v), tr\)/g) ?? []).length >= 3, 'التنزيل وتأكيده وأماكن التسمية');
  assert.equal(LOT_REP_GONE_NAME, /export const LOT_REP_GONE_NAME = '([^']+)'/.exec(fs.readFileSync(path.join(process.cwd(), '..', 'backend', 'src', 'services', 'lotsTrace.ts'), 'utf8'))?.[1], 'مرآة الخادم');
  assert.equal(originKindLabel('OPENING_IMPORT', br), '[مخزون افتتاحي]');
  assert.equal(originKindLabel('ADJUST', br), '[تسوية]');
  assert.equal(originKindLabel('WHATEVER', br), 'WHATEVER');
  assert.equal(eventKindLabel('BLOCK', br), '[إيقاف التشغيلة]');
  assert.equal(eventKindLabel('NEW_KIND', br), 'NEW_KIND');
});

test('traceSheets: البطاقة والمصدر والأماكن والعملاء والسجل — أرقامٌ بأربع خانات، والعملاء المحجوبون بلا ورقة', () => {
  const br = (s: string) => `[${s}]`;
  const sheets = traceSheets(trace(), br);
  assert.deepEqual(sheets.map((s) => s.name), ['[التشغيلة]', '[المصدر]', '[الأماكن]', '[العملاء]', '[السجل]']);
  const card = sheets[0].rows as Record<string, unknown>[];
  const val = (k: string) => card.find((r) => r['[البيان]'] === k)?.['[القيمة]'];
  assert.equal(val('[رقم التشغيلة]'), 'A-12');
  assert.equal(val('[تاريخ الانتهاء]'), '2027-01-01');
  assert.equal(val('[النطاق]'), '[النطاق الموسع]');
  assert.equal(val('[الصافي]'), 2.8333);
  assert.equal(val('[ملاحظة]'), undefined, 'غير المقيّد بلا ملاحظة النطاق');
  const places = sheets[2].rows as Record<string, unknown>[];
  assert.equal(places[1]['[المكان]'], '[مندوب محذوف] · gone ([تقريبي])');
  assert.equal(places[1]['[المباع]'], 57.1235);
  assert.equal(typeof places[1]['[محجوز]'], 'number', 'الكميات أرقامٌ تُجمع في Excel');
  const cust = sheets[3].rows as Record<string, unknown>[];
  assert.equal(cust.length, 3, 'فاتورةً فاتورة');
  assert.equal(cust[1]['[النطاق]'], '[النطاق الموسع]');
  assert.equal(cust[1]['[الوسوم]'], '[وحدة موزعة على أكثر من تشغيلة]');
  assert.equal(cust[1]['[اليقين]'], '[مفترض]');
  assert.equal(cust[0]['[التاريخ]'], '2026-09-03', 'يومٌ لا لحظة');
  assert.equal((sheets[4].rows as Record<string, unknown>[])[0]['[التاريخ]'], '2026-09-10 13:20', 'بتوقيت المتصفّح كالشاشة');
  // المحجوب والمقيّد
  const hidden = traceSheets(trace({ customers: null, customersHidden: true, scoped: true }), br);
  assert.deepEqual(hidden.map((s) => s.name), ['[التشغيلة]', '[المصدر]', '[الأماكن]', '[السجل]']);
  const cardRows = hidden[0].rows as Record<string, unknown>[];
  assert.equal(cardRows[cardRows.length - 1]?.['[القيمة]'], '[النتيجة مقيدة بنطاقك]');
  for (const s of sheets) assert.ok(s.name.length <= 31 + 2, `اسم ورقة Excel طويل: ${s.name}`);
});

test('traceSheets: تاريخ الفاتورة يومها بتوقيت المتصفّح لا يوم UTC — فاتورة ١:٣٠ فجراً بالرياض في يومها (قائمة إشعار السحب)', () => {
  const t = trace({
    origin: [{ kind: 'RECEIVE', at: '2026-10-29T21:15:00.000Z', ref: 'e1', qty: 10 }],
    customers: [{ customerId: 'c1', name: 'بقالة', phone: null, address: null, city: null, invoices: [
      { invoiceId: 'i1', number: 'INV-9', date: '2026-10-29T22:30:00.000Z', sold: 1, returned: 0, net: 1, weakest: 'CONFIRMED', flags: [], broad: false },
    ] }],
    events: [{ kind: 'RECALL', at: '2026-10-29T22:30:00.000Z', actorName: null, reason: null }],
  });
  const sheets = traceSheets(t, tr);
  const at = (name: string) => (sheets.find((s) => s.name === name)!.rows as Record<string, unknown>[])[0]['التاريخ'];
  assert.equal(at('العملاء'), '2026-10-30');
  assert.equal(at('المصدر'), '2026-10-30');
  assert.equal(at('السجل'), '2026-10-30 01:30');
  assert.equal(localStamp('2026-10-29T22:30:00.000Z'), '2026-10-30');
  assert.equal(localStamp('2026-10-29T22:30:00.000Z', true), '2026-10-30 01:30');
  assert.equal(localStamp('2026-10-29'), '2026-10-29', 'اليوم الخالص كما هو بلا إزاحة');
  assert.equal(localStamp('غير صالح'), 'غير صالح');
  // الشاشة وPDF: formatDate (لحظةً بتوقيت المتصفّح كصفحة الفواتير) لا formatDayOnly/dayText على يوم UTC
  const page = src('pages', 'LotsPage.tsx');
  assert.ok(!/formatDayOnly\(lotDay\(inv\.date\)/.test(page) && !/dayText\(inv\.date\)/.test(page), 'لا يوم UTC لتاريخ الفاتورة');
  assert.equal((page.match(/formatDate\(inv\.date\)/g) ?? []).length, 2, 'الشاشة وورقة PDF');
});

test('أعمدة «الأماكن» مصدرٌ واحد للشاشة وPDF وExcel: الخام والصالح للإنقاص والمحجوز والمنتهي والتالف ومجاميع الحركة (§٤.١٧)', () => {
  assert.deepEqual(TRACE_PLACE_COLUMNS.map((c) => c.label),
    ['صالح للبيع', 'الصالح للإنقاص', 'محجوز', 'منتهي الصلاحية', 'تالف', 'المحمل', 'المنزل', 'المباع', 'المرتجع']);
  const p = trace().places[1];
  assert.deepEqual(TRACE_PLACE_COLUMNS.map((c) => c.qty(p)), [3, 2, 1, 1, 0, 60, 0, 57.12345, 1]);
  // ورقة Excel بالأعمدة نفسها وبترتيبها
  const row = (traceSheets(trace(), tr)[2].rows as Record<string, unknown>[])[1];
  assert.deepEqual(Object.keys(row), ['المكان', ...TRACE_PLACE_COLUMNS.map((c) => c.label)]);
  assert.equal(row['منتهي الصلاحية'], 1, 'المنتهي في سيارة المحذوف يظهر');
  // ورقة PDF وجدول الشاشة يرسمان القائمة نفسها — لا انتقاءٌ يُسقط المنتهي والتالف من ورقة السحب
  const page = src('pages', 'LotsPage.tsx');
  const pdf = page.slice(page.indexOf('const LotTraceDoc'));
  const screen = page.slice(page.indexOf("{tr('الأماكن')}</h3>"), page.indexOf("{tr('مصدر التشغيلة')}"));
  for (const [name, s] of [['PDF', pdf], ['الشاشة', screen]] as const) {
    assert.match(s, /TRACE_PLACE_COLUMNS\.map\(/, `${name}: الأعمدة من TRACE_PLACE_COLUMNS`);
    assert.ok(!/p\.raw\.SELLABLE|p\.held\.SELLABLE/.test(s), `${name}: لا عمود مكتوبٌ باليد`);
  }
});

// ─── حرّاسٌ نصّية: الصفحة والتنقّل ───

test('App.tsx: «التشغيلات» كسولة خلف صلاحية مخزون السيارات كموجّه /api/lots', () => {
  const s = src('App.tsx');
  assert.match(s, /const LotsPage = lazy\(\(\) => import\('\.\/pages\/LotsPage'\)\);/);
  assert.match(s, /<Route path="lots" element=\{<PermissionRoute permission="canManageVanStock"><LotsPage \/><\/PermissionRoute>\} \/>/);
});

test('MainLayout: البند بعد المستودع، وخلف عَلَم الشركة (true صريحة) والمحاسبة والصلاحية', () => {
  const s = src('layouts', 'MainLayout.tsx');
  const pages = /const ACCOUNTING_PAGES = \[([^\]]*)\];/.exec(s)?.[1] ?? '';
  assert.ok(pages.includes("'/app/lots'"), 'المحاسبة المطفأة تُخفي البند');
  const wh = s.indexOf("{ to: '/app/warehouse'");
  const lots = s.indexOf("{ to: '/app/lots', icon: Layers, label: 'nav.lots', permission: 'canManageVanStock' }");
  assert.ok(wh > 0 && lots > wh, 'البند بعد المستودع بصلاحية مخزون السيارات');
  assert.ok(!s.slice(wh + 1, lots).includes("{ to: '"), 'مباشرةً بعد المستودع');
  assert.match(s, /\(item\.to !== '\/app\/lots' \|\| companyCfg\?\.lotTrackingEnabled === true\)/, 'الميزة المطفأة بلا بند (§١٠.١)');
  assert.match(s, /lotTrackingEnabled\?: boolean/);
});

test('LotsPage: لا جلب قبل العَلَم والمحاسبة، والإيقاف بسببٍ إلزامي، والتنزيل بجسم unloadBody، والتصدير من ردّ التتبّع نفسه', () => {
  const s = src('pages', 'LotsPage.tsx');
  const gate = s.indexOf('if (!featureOn) return <FeatureOff />;');
  assert.ok(gate > 0 && s.indexOf('if (!accountingOn) return <AccountingOffNotice />;') < gate, 'المحاسبة ثم العَلَم');
  assert.match(s, /const featureOn = companyQ\.data\?\.lotTrackingEnabled === true;/, 'غيابه من ردٍّ قديم = مطفأة');
  // القائمة والسلامة والبطاقة مكوّناتٌ لا تُرسم قبل البوّابة — فلا طلب /lots والميزة مطفأة
  const root = s.slice(s.indexOf('export default function LotsPage'), s.indexOf('function FeatureOff'));
  for (const c of ['<LotsList', '<HealthPanel', '<LotDetail']) {
    assert.ok(root.indexOf('if (!featureOn)') < root.indexOf(c), `${c} يُرسم قبل البوّابة`);
  }
  assert.ok(!/lotsApi\./.test(root), 'لا نداء lotsApi في الجذر قبل البوّابة');
  // الإيقاف والسحب وإعادة التنشيط: ConfirmDialog بسببٍ إلزامي، ثم خطة التنزيل للموقوفة
  assert.match(s, /onConfirm=\{\(\) => \{ if \(!reason\.trim\(\)\) \{ toast\.error\(tr\('اكتب سبب هذا التعديل على التشغيلة'\)\); return; \} save\.mutate\(\); \}\}/);
  assert.match(s, /enabled: blocked,/, 'خطة التنزيل للموقوفة وحدها');
  assert.match(s, /unloadBody\(lot, row, /);
  assert.match(s, /vanStockApi\.createLoad\(body\)/);
  // النطاق: الموسّع تلقائيٌّ في السحب، وشريط «النتيجة مقيدة بنطاقك» من الخادم
  assert.match(s, /const scope = scopeSel \?\? \(autoBroad\(lot\) \? 'BROAD' : 'STRICT'\);/);
  assert.match(s, /\(lot\.scoped \|\| trace\?\.scoped\) && <ScopedBanner \/>/);
  assert.match(s, /const scopedUser = lot \? lot\.scoped === true :/, 'حكم الخادم في النطاق أولاً');
  // Excel وPDF من ردّ التتبّع نفسه بلا طلبٍ ثانٍ
  assert.match(s, /shareOrDownloadExcel\(traceSheets\(traceQ\.data, tr\)/);
  assert.match(s, /<LotTraceDoc ref=\{pdfRef\} trace=\{trace\}/);
  assert.match(s, /elementToPdfBlob\(pdfRef\.current\)/);
  // التسمية بقيود D27 قبل الإرسال
  assert.match(s, /relabelProblem\(\{ source, lines, note, expiryRequired: lot\.product\.shelfLifeOn \}\)/);
  assert.match(s, /lotsApi\.health\(\)/);
});
