// «تتبّع اللوط» — تشغيلة سطر البيع في نافذة «إنشاء فاتورة جديدة» (lib/saleLots.ts، طلب المالك ٢ نوفمبر ٢٠٢٦):
// الجسم (تلقائي بلا مفتاح، واحدة تتبع كمية السطر ووحدته، تقسيم)، وكشف الفرق، والمتاح بعد أسطر الصنف الأخرى، وخطأ الخادم
// على سطره — وحرّاسٌ نصّية على النافذة: جسم البيع بلا اختيارٍ هو جسم اليوم، والمرتجع بلا منتقي البيع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SALE_LOT_SPLIT, clearSaleLotPicks, initialSplitRows, lotErrorLineIdx, lotQtyInLineUnit, pickedByOtherLines, saleLineBaseQty,
  saleLotProblem, saleLotProblems, saleLotRefs, saleLotSources, saleLotView, withSaleLots, type SaleLotLine, type SaleLotPick,
  asDraftProblem, saleLotErrorText, saleLotPickable,
} from './saleLots';
import { lotErrorText } from './invoiceLots';
import type { LotErrorInfo, VanLotSnapshotDto } from './lots';

const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');

// سيارةٌ فيها للصنف p1 ثلاث تشغيلات نشطة (L1 ينتهي أولاً) وموقوفة ومنتهية، وغير مسمّى؛ وp2 غير متتبَّع
const snap = (): VanLotSnapshotDto => ({
  serverTime: '2026-11-02T08:00:00.000Z', day: '2026-11-02', tracked: ['p1', 'p3'], allowUnknown: false,
  products: [{
    productId: 'p1', available: 60, availableNamed: 60, unknownUsable: 4, quarantined: 5, held: 0,
    expiredUnsold: 3, expiredReturned: 0, damaged: 0,
    lots: [
      { lotId: 'L1', lotNumber: 'A-01', expiryDate: '2026-12-01', status: 'ACTIVE', blockKind: null, usable: 25 },
      { lotId: 'L2', lotNumber: 'A-02', expiryDate: '2027-01-15', status: 'ACTIVE', blockKind: null, usable: 30 },
      { lotId: 'L3', lotNumber: 'A-03', expiryDate: null, status: 'ACTIVE', blockKind: null, usable: 5 },
      { lotId: 'LB', lotNumber: 'B-09', expiryDate: '2027-02-01', status: 'BLOCKED', blockKind: 'HOLD', usable: 5 },
      { lotId: 'LX', lotNumber: 'X-77', expiryDate: '2026-10-01', status: 'ACTIVE', blockKind: null, usable: 3 },
    ],
  }],
});

// بند الجسم كما يبنيه handleSubmit قبل withSaleLots
const item = (l: SaleLotLine & { unitId?: string | null }) => ({
  productId: l.productId, qty: l.qty, unitPrice: 10, discountPct: 0, taxPct: 15,
  ...(l.unitId ? { unitId: l.unitId, unitName: 'كرتون', unitFactor: l.unitFactor, baseUnitName: 'حبة' } : {}),
});
const tracked = (pid: string) => pid === 'p1' || pid === 'p3';

test('withSaleLots: «تلقائي» في كل الأسطر ⇒ المصفوفة نفسها والبنود نفسها — لا مفتاح lots (جسم اليوم حرفاً)', () => {
  const lines: SaleLotLine[] = [{ productId: 'p1', qty: 2, unitFactor: 10 }, { productId: 'p2', qty: 3, unitFactor: 1 }];
  const items = lines.map(item);
  const out = withSaleLots(items, lines, tracked);
  assert.equal(out, items, 'المصفوفة نفسها');
  assert.equal(JSON.stringify(out), JSON.stringify(lines.map(item)));
  for (const it of out) assert.equal('lots' in it, false);
  // اختيارٌ null صراحةً مثل الغياب
  const nulled = lines.map((l) => ({ ...l, lotPick: null }));
  assert.equal(withSaleLots(items, nulled, tracked), items);
});

test('واحدة: السطر كله من التشغيلة بكميته الأساسية — وتتبع كمية السطر ووحدته بلا تخزين', () => {
  const l: SaleLotLine = { productId: 'p1', qty: 2, unitFactor: 10, lotPick: { mode: 'ONE', lotId: 'L2' } };
  assert.equal(saleLineBaseQty(l), 20);
  assert.deepEqual(saleLotRefs(l), [{ lotId: 'L2', qty: 20 }], 'كرتونان × ١٠ = ٢٠ حبة');
  assert.deepEqual(saleLotRefs({ ...l, qty: 3 }), [{ lotId: 'L2', qty: 30 }], 'الكمية تغيّرت فتبعتها');
  assert.deepEqual(saleLotRefs({ ...l, qty: 7, unitFactor: 1 }), [{ lotId: 'L2', qty: 7 }], 'الوحدة صارت الحبة فتبعتها');
  assert.equal(saleLotRefs({ ...l, qty: 0 }), null, 'سطرٌ بلا كمية لا صفوف له');
  const items = withSaleLots([item({ ...l, unitId: 'u-ctn' })], [l], tracked);
  assert.deepEqual(items[0], { ...item({ ...l, unitId: 'u-ctn' }), lots: [{ lotId: 'L2', qty: 20 }] });
  // الشكل الذي يقبله refsFrom/parseLotRefsStrict: مصفوفة {lotId نصّ، qty عدد} مجموعها = الأساس
  const lots = (items[0] as { lots: { lotId: unknown; qty: unknown }[] }).lots;
  assert.ok(lots.every((r) => typeof r.lotId === 'string' && typeof r.qty === 'number'));
});

test('تقسيم: الصفوف كما كُتبت (بالأساس) — والصنف غير المتتبَّع أو بندٌ لصنفٍ آخر لا يحمل شيئاً', () => {
  const l: SaleLotLine = {
    productId: 'p1', qty: 2, unitFactor: 10,
    lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: 'L1', qty: '15' }, { key: 'b', source: 'L2', qty: '5' }] },
  };
  assert.deepEqual(saleLotRefs(l), [{ lotId: 'L1', qty: 15 }, { lotId: 'L2', qty: 5 }]);
  const lines: SaleLotLine[] = [l, { productId: 'p2', qty: 1, unitFactor: 1, lotPick: { mode: 'ONE', lotId: 'L9' } }];
  const items = lines.map(item);
  const out = withSaleLots(items, lines, tracked);
  assert.deepEqual((out[0] as { lots?: unknown }).lots, [{ lotId: 'L1', qty: 15 }, { lotId: 'L2', qty: 5 }]);
  assert.equal(out[1], items[1], 'p2 غير متتبَّع: بنده كما هو');
  // عدد بنود مختلف أو صنفٌ لا يطابق: لا تُنسب تشغيلة
  const one = items.slice(0, 1);
  assert.equal(withSaleLots(one, lines, tracked), one);
  const swapped = [items[1], items[0]];
  assert.equal(withSaleLots(swapped, lines, tracked), swapped);
});

test('الفرق: تقسيمٌ تغيّرت كمية سطره أو وحدته يُكشف (LOT_QTY_INVALID) ولا يُعاد تحجيمه بصمت', () => {
  const s = saleLotSources(snap(), [{ productId: 'p1', qty: 2, unitFactor: 10 }], 0)!;
  const rows = [{ key: 'a', source: 'L1', qty: '15' }, { key: 'b', source: 'L2', qty: '5' }];
  const l: SaleLotLine = { productId: 'p1', qty: 2, unitFactor: 10, lotPick: { mode: 'SPLIT', rows } };
  assert.equal(saleLotProblem(l, s.eligible), null, 'المجموع ٢٠ = كرتونان');
  assert.equal(saleLotProblem({ ...l, qty: 3 }, s.eligible), 'LOT_QTY_INVALID', 'الكمية صارت ٣ كراتين');
  assert.equal(saleLotProblem({ ...l, unitFactor: 1 }, s.eligible), 'LOT_QTY_INVALID', 'الوحدة صارت الحبة');
  assert.deepEqual((l.lotPick as { rows: unknown }).rows, rows, 'الصفوف كما هي');
  // صفٌّ بلا تشغيلة، وتشغيلة مكرّرة، وفوق المتاح
  assert.equal(saleLotProblem({ ...l, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: '', qty: '20' }] } }, s.eligible), 'LOT_SOURCE_MISSING');
  assert.equal(saleLotProblem({ ...l, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: 'L1', qty: '10' }, { key: 'b', source: 'L1', qty: '10' }] } }, s.eligible), 'LOT_SOURCE_DUPLICATE');
  assert.equal(saleLotProblem({ ...l, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: 'L3', qty: '20' }] } }, s.eligible), 'LOT_OVER_SOURCE');
  // الواحدة فوق متاح تشغيلتها (L3 فيها ٥ والسطر ٢٠)، والموقوفة والمنتهية ليستا مصدراً يُختار
  assert.equal(saleLotProblem({ ...l, lotPick: { mode: 'ONE', lotId: 'L3' } }, s.eligible), 'LOT_OVER_SOURCE');
  assert.equal(saleLotProblem({ ...l, qty: 0.5, lotPick: { mode: 'ONE', lotId: 'L3' } }, s.eligible), null, 'نصف كرتون = ٥');
  assert.equal(saleLotProblem({ ...l, qty: 1, unitFactor: 1, lotPick: { mode: 'ONE', lotId: 'LB' } }, s.eligible), 'LOT_OVER_SOURCE');
  assert.equal(saleLotProblem({ ...l, qty: 1, unitFactor: 1, lotPick: { mode: 'ONE', lotId: 'LX' } }, s.eligible), 'LOT_OVER_SOURCE');
  // بلا لقطة: الشكل والمجموع وحدهما
  assert.equal(saleLotProblem({ ...l, lotPick: { mode: 'ONE', lotId: 'L3' } }, null), null);
  assert.equal(saleLotProblem({ ...l, qty: 3 }, null), 'LOT_QTY_INVALID');
  // «تلقائي» لا مشكلة له أبداً
  assert.equal(saleLotProblem({ productId: 'p1', qty: 999, unitFactor: 10 }, s.eligible), null);
});

test('المصادر: المسمّاة وحدها، الموقوفة والمنتهية للعرض لا للاختيار، والمتاح بعد اختيار أسطر الصنف الأخرى', () => {
  const lines: SaleLotLine[] = [
    { productId: 'p1', qty: 2, unitFactor: 10, lotPick: { mode: 'ONE', lotId: 'L1' } },         // كرتونان من L1 = ٢٠
    { productId: 'p1', qty: 3, unitFactor: 1 },                                                 // حبّات «تلقائي»
    { productId: 'p1', qty: 1, unitFactor: 6, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: 'L2', qty: '6' }] } },
    { productId: 'p3', qty: 1, unitFactor: 1, lotPick: { mode: 'ONE', lotId: 'L1' } },          // صنفٌ آخر لا يُحسب
  ];
  assert.deepEqual([...pickedByOtherLines(lines, 1)], [['L1', 20], ['L2', 6]]);
  assert.deepEqual([...pickedByOtherLines(lines, 0)], [['L2', 6]], 'السطر لا يُنقص من نفسه');
  const s1 = saleLotSources(snap(), lines, 1)!;
  assert.deepEqual(s1.all.map((s) => [s.lotId, s.usable]), [['L1', 5], ['L2', 24], ['L3', 5], ['LB', 5], ['LX', 3]], 'بلا غير المسمّى');
  assert.deepEqual(s1.eligible.map((s) => s.lotId), ['L1', 'L2', 'L3'], 'الموقوفة والمنتهية خارج الاختيار');
  const s0 = saleLotSources(snap(), lines, 0)!;
  assert.equal(s0.all.find((s) => s.lotId === 'L1')!.usable, 25, 'السطر الأول يرى L1 كاملة');
  // سطرٌ ثانٍ يختار من L1 فوق ما تركه الأول ⇒ فوق المتاح
  const both = [...lines.slice(0, 2), { ...lines[1], unitFactor: 2, qty: 4, lotPick: { mode: 'ONE' as const, lotId: 'L1' } }];
  const probs = saleLotProblems(both, snap(), tracked);
  assert.equal(probs[2], 'LOT_OVER_SOURCE', '٨ حبات من L1 وقد بقي فيها ٥ بعد كرتوني السطر الأول');
  assert.equal(probs[0], 'LOT_OVER_SOURCE', 'والأول يرى ما أخذه الثالث كذلك — الخادم يجمع الطلب لكل تشغيلة');
  assert.equal(probs[1], null);
  // مجموعٌ ضمن المتاح ⇒ لا مشكلة
  const ok = [lines[0], { ...lines[1], qty: 5, lotPick: { mode: 'ONE' as const, lotId: 'L1' } }];
  assert.deepEqual(saleLotProblems(ok, snap(), tracked), [null, null]);
  assert.equal(saleLotSources(null, lines, 0), null, 'بلا لقطة لا مصادر');
  assert.deepEqual(saleLotSources(snap(), [{ productId: 'p3', qty: 1 }], 0), { all: [], eligible: [] }, 'متتبَّعٌ بلا رصيد');
});

test('initialSplitRows: يبدأ بالمختارة ثم بالترتيب حتى تكتمل الكمية — وبلا مصادر صفٌّ فارغ بالكمية', () => {
  const el = saleLotSources(snap(), [{ productId: 'p1', qty: 40, unitFactor: 1 }], 0)!.eligible;
  const q = (rows: { source: string; qty: string }[]) => rows.map((r) => [r.source, r.qty]);
  assert.deepEqual(q(initialSplitRows(40, el)), [['L1', '25'], ['L2', '15']]);
  assert.deepEqual(q(initialSplitRows(40, el, 'L2')), [['L2', '30'], ['L1', '10']]);
  assert.deepEqual(q(initialSplitRows(100, el)), [['L1', '25'], ['L2', '30'], ['L3', '5']], 'لا تكفي: الفرق ظاهرٌ بعد');
  assert.deepEqual(q(initialSplitRows(7, [])), [['', '7']]);
});

test('clearSaleLotPicks: تغيّر المندوب يعيد الأسطر «تلقائي» — والأسطر بلا اختيار المصفوفة نفسها', () => {
  const lines: SaleLotLine[] = [{ productId: 'p1', qty: 1, lotPick: { mode: 'ONE', lotId: 'L1' } }, { productId: 'p2', qty: 1 }];
  const r = clearSaleLotPicks(lines);
  assert.equal(r.cleared, 1);
  assert.equal(r.lines[0].lotPick, undefined);
  assert.equal(r.lines[1], lines[1]);
  const none = [{ productId: 'p2', qty: 1 }];
  assert.equal(clearSaleLotPicks(none).lines, none);
});

test('lotErrorLineIdx: خطأ الخادم على سطره — line، أو lines مضيَّقةً بالتشغيلة، أو أسطر الصنف', () => {
  const lines: SaleLotLine[] = [
    { productId: 'p1', qty: 1, unitFactor: 10, lotPick: { mode: 'ONE', lotId: 'L1' } },
    { productId: 'p2', qty: 1 },
    { productId: 'p1', qty: 2, unitFactor: 1, lotPick: { mode: 'ONE', lotId: 'L2' } },
  ];
  const err = (detail: Record<string, unknown>): LotErrorInfo => ({ status: 422, code: 'LOT_STOCK_INSUFFICIENT', message: null, detail });
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', line: 2 }), lines), [2], 'الصرامة لكل سطر (parseLotRefsStrict)');
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', lotId: 'L2', lines: [0, 2] }), lines), [2], 'التشغيلة تضيّق');
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', lotId: 'LZ', lines: [0, 2] }), lines), [0, 2]);
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', lines: [0, 2, 9] }), lines), [0, 2], 'فهرسٌ خارج الأسطر يسقط');
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1' }), lines), [0, 2]);
  assert.deepEqual(lotErrorLineIdx(err({}), lines), []);
  assert.deepEqual(lotErrorLineIdx(null, lines), []);
});

test('lotQtyInLineUnit: المتاح بوحدة السطر حين تنقسم عليها، وإلا بالأساس', () => {
  assert.equal(lotQtyInLineUnit(30, { unitFactor: 10, unit: 'كرتون' }, 'حبة'), '3 كرتون');
  assert.equal(lotQtyInLineUnit(25, { unitFactor: 10, unit: 'كرتون' }, 'حبة'), '25 حبة');
  assert.equal(lotQtyInLineUnit(7.5, { unitFactor: 1, unit: 'كيلو' }, 'كيلو'), '7.5 كيلو');
  assert.equal(lotQtyInLineUnit(4, { unitFactor: null, unit: '' }, ''), '4');
});

// ─── حرّاسٌ نصّية على النافذة ───

test('النافذة: جسم البيع بنود اليوم نفسها ملفوفةً بـwithSaleLots، والمنتقي للبيع وحده على سطر الصنف المتتبَّع', () => {
  const m = src('components', 'forms', 'InvoiceModal.tsx').replace(/\r\n/g, '\n');
  // بنود اليوم كما هي حرفاً داخل اللفّ — بلا اختيار يعيد withSaleLots المصفوفة نفسها (الاختبار الأول)
  assert.match(m, /items: withSaleLots\(lines\.map\(l => \(\{\n\s*productId: l\.productId, qty: l\.qty, unitPrice: l\.unitPrice,\n\s*discountPct: l\.discountPct, taxPct: l\.taxPct,\n[\s\S]*?\.\.\.invoiceItemUnit\(\{ unit: l\.unit, unitId: l\.unitId, unitName: l\.unitId \? l\.unit : null, unitFactor: l\.unitFactor, baseUnit: l\.baseUnit \}\),\n\s*\}\)\), lines, pid => trackedIds\.has\(pid\)\),/);
  // المنتقي على السطر لا في الترويسة، للبيع وحده ولصنفٍ متتبَّع (trackedIds فارغةٌ والميزة مطفأة)
  assert.match(m, /\{!isReturn && trackedIds\.has\(l\.productId\) && \(\n\s*<SaleLotPicker line=\{l\}/);
  assert.match(m, /const trackedIds = new Set\(lotOn \?/);
  // اللقطة بمفتاح المندوب، ولا طلب بلا سطرٍ متتبَّع في البيع أو بلا مندوب أو بلا صلاحية مخزون السيارات
  assert.match(m, /queryKey: \['invoice-van-lots', salesRepId\],\n\s*enabled: hasSaleLotLine && !!salesRepId && canVanStock,/);
  assert.match(m, /const hasSaleLotLine = lotOn && !isReturn && lines\.some\(l => trackedIds\.has\(l\.productId\)\);/);
  // الإصدار يُحجب بمشكلة تشغيلة سطر قبل الطلب، وتغيير المندوب يمحو الاختيارات
  assert.ok(m.indexOf('const badLot = saleLotIssues.findIndex') < m.indexOf("items: withSaleLots("));
  assert.match(m, /onChange=\{e => changeRep\(e\.target\.value\)\}/);
  // المرتجع الحرّ جسمه كما كان (لا lotPick فيه — buildFreeReturnPayload ينتقي حقوله)
  assert.match(m, /mutation\.mutate\(lotOn \? withFreeReturnLots\(free, lines, l => \(trackedIds\.has\(l\.productId\) \? freeLots\[lineKey\(l\)\] : undefined\)\) : free\);/);
  assert.equal(SALE_LOT_SPLIT, '__split__');
});

// ─── المراجعة (٢ نوفمبر ٢٠٢٦): حرّاسٌ نجت من الطفرات ───

test('saleLotProblems: صنفٌ لم يعد متتبَّعاً لا يحجب الإصدار باختيارٍ بقي على سطره (withSaleLots لا يرسله أصلاً)', () => {
  const lines: SaleLotLine[] = [
    { productId: 'p2', qty: 3, unitFactor: 1, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: '', qty: '1' }] } },
    { productId: 'p1', qty: 1, unitFactor: 1, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: '', qty: '1' }] } },
  ];
  assert.deepEqual(saleLotProblems(lines, snap(), tracked), [null, 'LOT_SOURCE_MISSING']);
  assert.deepEqual(saleLotProblems(lines, snap(), () => false), [null, null], 'الميزة مطفأة: لا حجب');
});

test('saleLotView: بلا لقطة لا يُكتب «تلقائي» فوق اختيارٍ قائمٍ يُرسل', () => {
  const one: SaleLotPick = { mode: 'ONE', lotId: 'L1' };
  assert.equal(saleLotView(true, one), 'SELECT');
  assert.equal(saleLotView(true, null), 'SELECT');
  assert.equal(saleLotView(false, null), 'AUTO_ONLY');
  assert.equal(saleLotView(false, undefined), 'AUTO_ONLY');
  assert.equal(saleLotView(false, one), 'PICK_KEPT', 'اللقطة تُجلب أو تعذّرت والاختيار في الجسم');
  assert.equal(saleLotView(false, { mode: 'SPLIT', rows: [] }), 'PICK_KEPT');
});

test('النافذة: الحجب قبل الطلب، وتغيير المندوب يمحو، والخطأ على أسطر الجسم المرسل للبيع وحده، واللقطة تُبطَل بعد البيع', () => {
  const m = src('components', 'forms', 'InvoiceModal.tsx').replace(/\r\n/g, '\n');
  // مشكلة تشغيلة سطرٍ توقف الإصدار (return قبل mutate) — لا تحذيرٌ ثم إرسال
  assert.match(m, /const badLot = saleLotIssues\.findIndex\(p => p !== null\);\n\s*if \(badLot >= 0\) \{\n[^\n]*\n[^\n]*toast\.error\([^\n]*\n\s*return;\n\s*\}/);
  // المرتجع لا يحسب مشكلات البيع (ولا يمرّ بها: يتفرّع قبلها)
  assert.match(m, /const saleLotIssues = isReturn \? \[\] : saleLotProblems\(lines, vanLots, pid => trackedIds\.has\(pid\)\);/);
  // تغيير المندوب يمحو الاختيارات فعلاً ويقول ذلك
  assert.match(m, /const changeRep = \(id: string\) => \{[\s\S]*?const r = clearSaleLotPicks\(lines\);\n\s*if \(r\.cleared\) \{\n\s*setLines\(r\.lines\);/);
  // خطأ الخادم على أسطر البيع كما أُرسلت (فهارس الجسم)، والمرتجع رسالته وحدها
  assert.match(m, /sentLines\.current = lines;\n\s*mutation\.mutate\(\{/);
  assert.match(m, /if \(\(vars as \{ type\?: string \} \| undefined\)\?\.type !== 'RETURN'\) \{\n\s*const sent = sentLines\.current;\n\s*const keys = lotErrorLineIdx\(le, sent\)\.map\(i => lineKey\(sent\[i\]\)\);/);
  // البيع الناجح يُبطل لقطة السيارة: الفاتورة التالية لا تختار من متاحٍ قديم
  assert.match(m, /if \(lotOn\) qc\.invalidateQueries\(\{ queryKey: \['invoice-van-lots'\] \}\);\n\s*const doc: InvoiceDoc/);
});

test('المنتقي: الموقوفة والمنتهية معروضةٌ معطّلة، والاختيار القائم بلا لقطة يُقال ويُعاد إلى «تلقائي» بزرّ', () => {
  const p = src('components', 'SaleLotPicker.tsx');
  assert.match(p, /disabled=\{!saleLotPickable\(s\) && value !== s\.lotId\}/);
  assert.match(p, /const view = saleLotView\(state === 'READY' && !!sources, pick\);/);
  assert.match(p, /\{view === 'PICK_KEPT' && pick \? \(/);
  assert.match(p, /onClick=\{\(\) => onChange\(null\)\}/);
});

// ─── المراجعة العدائية (٢ نوفمبر ٢٠٢٦): D1–D9 وطفرةٌ بقيت في المنتقي ───

test('D1 initialSplitRows: سطر الكرتون يأخذ كراتين كاملة من كل تشغيلة أولاً كما يوزّع «تلقائي» (takeOrdered)', () => {
  const el = saleLotSources(snap(), [{ productId: 'p1', qty: 2, unitFactor: 24 }], 0)!.eligible;
  const q = (rows: { source: string; qty: string }[]) => rows.map((r) => [r.source, r.qty]);
  // كرتونان × ٢٤ = ٤٨، وL1 فيها ٢٥ وL2 فيها ٣٠: كرتونٌ من كلٍّ — لا ٢٥ + ٢٣ (كرتونٌ مشقوق)
  assert.deepEqual(q(initialSplitRows(48, el, null, 24)), [['L1', '24'], ['L2', '24']]);
  // كرتونان وحبّتان (٥٠): الكراتين أولاً ثم الباقي بالترتيب — صفٌّ واحد لكل تشغيلة
  assert.deepEqual(q(initialSplitRows(50, el, null, 24)), [['L1', '25'], ['L2', '25']]);
  // البدء بالمختارة: L2 تكفي كرتوناً واحداً، والثاني من L1
  assert.deepEqual(q(initialSplitRows(48, el, 'L2', 24)), [['L2', '24'], ['L1', '24']]);
  // الأساس (المعامل ١ أو غائب) كما كان
  assert.deepEqual(q(initialSplitRows(48, el, null, 1)), [['L1', '25'], ['L2', '23']]);
  assert.deepEqual(q(initialSplitRows(48, el)), [['L1', '25'], ['L2', '23']]);
  // والمجموع = الكمية دائماً حين يكفي المتاح
  const rows = initialSplitRows(60, el, null, 24);
  assert.equal(rows.reduce((s, r) => s + Number(r.qty), 0), 60);
  assert.equal(new Set(rows.map((r) => r.source)).size, rows.length, 'لا تشغيلة مكرّرة');
});

test('D2 lotErrorText: نقص تشغيلةٍ صريحة يذكر رقمها ومتاحها هي — لا «المتاح في السيارة»', () => {
  const tr = (s: string) => s;
  const t = lotErrorText({ status: 409, code: 'LOT_STOCK_INSUFFICIENT', message: 'x', detail: { productId: 'p1', lotId: 'L3', lotNumber: 'A-03', wanted: 20, usable: 5 } }, tr);
  assert.match(t, /الكمية أكبر من المتاح في التشغيلة A-03/);
  assert.match(t, /المتاح فيها 5/);
  assert.doesNotMatch(t, /المتاح في السيارة/);
  // رقمٌ غائب عن التفاصيل ⇒ من اللقطة
  const t2 = lotErrorText({ status: 409, code: 'LOT_STOCK_INSUFFICIENT', message: null, detail: { productId: 'p1', lotId: 'L3', lotNumber: null, wanted: 20, usable: 0 } }, tr, { lotNumberOf: () => 'A-03' });
  assert.match(t2, /التشغيلة A-03/);
  // نقص الصنف (بلا lotId) والإلغاء كما كانا حرفاً
  assert.equal(lotErrorText({ status: 409, code: 'LOT_STOCK_INSUFFICIENT', message: null, detail: { productId: 'p1', wanted: 9, available: 4 } }, tr),
    'الكمية أكبر من المتاح في تشغيلات سيارة المندوب · الكمية 9 · المتاح في السيارة 4');
  assert.equal(lotErrorText({ status: 409, code: 'LOT_STOCK_INSUFFICIENT', message: null, detail: { mode: 'CANCEL', lotId: 'L3', lotNumber: 'A-03' } }, tr),
    'لا يلغى المرتجع لأن بضاعته بيعت من: التشغيلة A-03');
});

test('D3 تشغيلةٌ مختارة صارت موقوفة أو منتهية: LOT_NOT_SELLABLE لا «أكبر من المتاح»', () => {
  const one = (lotId: string): SaleLotLine => ({ productId: 'p1', qty: 1, unitFactor: 1, lotPick: { mode: 'ONE', lotId } });
  assert.deepEqual(saleLotProblems([one('LB')], snap(), tracked), ['LOT_NOT_SELLABLE'], 'موقوفة');
  assert.deepEqual(saleLotProblems([one('LX')], snap(), tracked), ['LOT_NOT_SELLABLE'], 'منتهية');
  assert.deepEqual(saleLotProblems([one('L1')], snap(), tracked), [null]);
  const split: SaleLotLine = { productId: 'p1', qty: 2, unitFactor: 1, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: 'L1', qty: '1' }, { key: 'b', source: 'LB', qty: '1' }] } };
  assert.deepEqual(saleLotProblems([split], snap(), tracked), ['LOT_NOT_SELLABLE']);
  // رمز البيع لا يُمرَّر إلى محرّر الصفوف المشترك (يُعرض بنصّه خارجه)
  assert.equal(asDraftProblem('LOT_NOT_SELLABLE'), null);
  assert.equal(asDraftProblem('LOT_BASE_DECIMALS'), null);
  assert.equal(asDraftProblem('LOT_OVER_SOURCE'), 'LOT_OVER_SOURCE');
});

test('D4 saleLotErrorText: رموز الخادم للبيع الصريح بلغة الواجهة ورقم التشغيلة — لا رسالة الخادم العربية', () => {
  const tr = (s: string) => `[${s}]`;
  const e = (code: LotErrorInfo['code'], detail: Record<string, unknown>): LotErrorInfo => ({ status: 422, code, message: 'رسالة الخادم', detail });
  const num = { lotNumberOf: (id: string) => (id === 'LB' ? 'B-09' : null) };
  assert.equal(saleLotErrorText(e('LOT_BLOCKED', { productId: 'p1', lotId: 'LB', blockKind: 'HOLD', lines: [0] }), tr, num),
    '[التشغيلة موقوفة لا تباع]: B-09 · [إيقاف احترازي]');
  assert.equal(saleLotErrorText(e('LOT_BLOCKED', { productId: 'p1', lotId: 'LZ', blockKind: null }), tr, num), '[التشغيلة موقوفة لا تباع] · [تشغيلة موقوفة]');
  assert.equal(saleLotErrorText(e('LOT_EXPIRED', { productId: 'p1', lotId: 'LB', expiryDate: '2026-10-01' }), tr, num), '[التشغيلة منتهية لا تباع]: B-09');
  assert.equal(saleLotErrorText(e('LOT_NOT_FOUND', { productId: 'p1', lotId: 'LQ' }), tr), '[التشغيلة غير موجودة لهذا الصنف]');
  assert.equal(saleLotErrorText(e('LOT_PRODUCT_MISMATCH', { productId: 'p1', lotId: 'LB', lotProductId: 'p9' }), tr, num), '[التشغيلة غير موجودة لهذا الصنف]: B-09');
  assert.equal(saleLotErrorText(e('LOT_QTY_INVALID', { productId: 'p1', line: 0, wanted: 7.99992, decimals: 4 }), tr),
    '[كمية الصنف المتتبع بأربع خانات عشرية على الأكثر بوحدة الأساس]');
  assert.equal(saleLotErrorText(e('LOT_QTY_INVALID', { productId: 'p1', line: 0, wanted: 20, sum: 19 }), tr),
    '[مجموع كميات التشغيلات يجب أن يساوي كمية السطر بوحدة الأساس]');
  // ما سواها: النصّ المشترك (والنقص بالتشغيلة D2)
  assert.match(saleLotErrorText(e('LOT_STOCK_INSUFFICIENT', { productId: 'p1', lotId: 'L3', lotNumber: 'A-03', wanted: 6, usable: 5 }), tr), /\[الكمية أكبر من المتاح في التشغيلة\] A-03/);
  assert.equal(saleLotErrorText(e('LOT_BUSY', {}), tr), '[التشغيلة مشغولة بعملية أخرى أعد المحاولة بعد لحظات]');
  for (const c of ['LOT_BLOCKED', 'LOT_EXPIRED', 'LOT_NOT_FOUND'] as const) {
    assert.doesNotMatch(saleLotErrorText(e(c, { lotId: 'LB' }), tr), /رسالة الخادم/);
  }
});

test('D5 تشغيلةٌ استنفدتها أسطر الصنف الأخرى لا تُختار (متاح 0)', () => {
  const lines: SaleLotLine[] = [
    { productId: 'p1', qty: 5, unitFactor: 1, lotPick: { mode: 'ONE', lotId: 'L3' } },
    { productId: 'p1', qty: 1, unitFactor: 1 },
  ];
  const s1 = saleLotSources(snap(), lines, 1)!;
  const l3 = s1.eligible.find((s) => s.lotId === 'L3')!;
  assert.equal(l3.usable, 0);
  assert.equal(saleLotPickable(l3), false, 'صالحةٌ للبيع لكن لم يبق فيها شيء');
  assert.equal(saleLotPickable(s1.eligible.find((s) => s.lotId === 'L1')!), true);
  assert.equal(saleLotPickable(s1.all.find((s) => s.lotId === 'LB')!), false, 'الموقوفة');
  const p = src('components', 'SaleLotPicker.tsx');
  assert.match(p, /disabled=\{!sources\.eligible\.some\(saleLotPickable\) && pick\?\.mode !== 'SPLIT'\}/, '«تقسيم» مغلقٌ بلا متاح');
});

test('D6 كمية سطرٍ أساسية بأكثر من أربع خانات: LOT_BASE_DECIMALS للواحدة والتقسيم (لا «المجموع» ولا عبورٌ إلى الخادم)', () => {
  const el = saleLotSources(snap(), [{ productId: 'p1', qty: 1 }], 0)!.eligible;
  const base: SaleLotLine = { productId: 'p1', qty: 0.33333, unitFactor: 24 };
  assert.equal(saleLotProblem({ ...base, lotPick: { mode: 'ONE', lotId: 'L2' } }, el), 'LOT_BASE_DECIMALS');
  assert.equal(saleLotProblem({ ...base, lotPick: { mode: 'SPLIT', rows: [{ key: 'a', source: 'L2', qty: '7.9999' }] } }, el), 'LOT_BASE_DECIMALS');
  // أربع خانات بالضبط تمرّ
  assert.equal(saleLotProblem({ productId: 'p1', qty: 0.5, unitFactor: 1.5, lotPick: { mode: 'ONE', lotId: 'L2' } }, el), null);
  // «تلقائي» لا يُحجب هنا (الخادم يحكم كما اليوم)
  assert.equal(saleLotProblem(base, el), null);
});

test('D8 lotErrorLineIdx: نقص الصنف بلا تشغيلة يخصّ أسطر «تلقائي» لا السطر الصريح', () => {
  const lines: SaleLotLine[] = [
    { productId: 'p1', qty: 2, unitFactor: 1, lotPick: { mode: 'ONE', lotId: 'L1' } },
    { productId: 'p1', qty: 99, unitFactor: 1 },
  ];
  const err = (detail: Record<string, unknown>, code: LotErrorInfo['code'] = 'LOT_STOCK_INSUFFICIENT'): LotErrorInfo => ({ status: 409, code, message: null, detail });
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', wanted: 101, available: 60, lines: [0, 1] }), lines), [1]);
  // كل الأسطر صريحة ⇒ كلها؛ ورمزٌ آخر بلا تشغيلة لا يُضيَّق
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', lines: [0] }), lines.slice(0, 1)), [0]);
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', lines: [0, 1] }, 'LOT_BUSY'), lines), [0, 1]);
  // غير المسمّى الصريح (lotId: null) ليس نقص الصنف
  assert.deepEqual(lotErrorLineIdx(err({ productId: 'p1', lotId: null, lines: [0, 1] }), lines), [0, 1]);
});

test('D9 والخطأ والطفرة: الانتحال يرى المنتقي، وخطأ البيع بنصّ البيع، و«اختيارٌ قائم» لا يُكتب فوقه «تلقائي»', () => {
  const m = src('components', 'forms', 'InvoiceModal.tsx').replace(/\r\n/g, '\n');
  assert.match(m, /const canVanStock = useAuthStore\(s => s\.user\?\.canManageVanStock !== false \|\| !!s\.impersonating\);/);
  assert.match(m, /\?\.type !== 'RETURN' \? saleLotErrorText\(le, tr, ctx\) : lotErrorText\(le, tr, ctx\);/);
  assert.match(m, /lotNumberOf: \(lotId: string\) => vanLots\?\.products\.flatMap\(p => p\.lots\)\.find\(x => x\.lotId === lotId\)\?\.lotNumber,/);
  assert.match(m, /\$\{saleLotProblemText\(saleLotIssues\[badLot\], tr,/);
  const p = src('components', 'SaleLotPicker.tsx');
  assert.doesNotMatch(p, /\{false && /, 'طفرةٌ متروكة في المنتقي');
  assert.match(p, /initialSplitRows\(base, sources\.eligible, pick\?\.mode === 'ONE' \? pick\.lotId : null, line\.unitFactor\)/);
  assert.match(p, /problem=\{asDraftProblem\(problem\)\}/);
});
