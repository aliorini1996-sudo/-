// «تتبّع اللوط» — نموذج حركة المستودع في اللوحة: سطر النقص «التلقائي» يُسحب مما بقي بعد صريح صنفه، مرآة planWarehouseEntryInTx
// في الخادم (withoutRows ثم pickOutFefoLines — طلب المالك ١ نوفمبر ٢٠٢٦ بدل «المصدر الوحيد وإلا LOT_REQUIRED» في D10):
// [تشغيلة A −١٠ صريحة، تلقائي −٥] يُسحب من B، و«التلقائي» لا يلزمه اختيارٌ أيّاً كان عدد المصادر الباقية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { autoDecreaseOver, autoDecreasePreview, autoDecreaseSources, emptyEntryLot, entryLotProblem, explicitDecreaseOver, type EntryLotDraft, type LotSource } from './stockLots';

const src = (lotId: string | null, usable: number, expiryDate: string | null = null): LotSource =>
  ({ lotId, lotNumber: lotId, expiryDate, status: lotId ? 'ACTIVE' : null, blockKind: null, usable, expired: false });
const d = (p: Partial<EntryLotDraft>): EntryLotDraft => ({ ...emptyEntryLot('AUTO'), ...p });
const existing = (lotId: string, baseQty: number) => ({ draft: d({ mode: 'EXISTING', lotId }), baseQty });
const auto = (baseQty: number, unitFactor?: number) => ({ draft: d({ mode: 'AUTO' }), baseQty, unitFactor });
type L = { draft: EntryLotDraft; baseQty: number; unitFactor?: number };
const autoProblem = (sources: LotSource[], lines: L[]) =>
  entryLotProblem(d({ mode: 'AUTO' }), { kind: 'DECREASE', expiryRequired: false, autoOver: autoDecreaseOver(sources, lines) });

const AB = [src('A', 10), src('B', 5)];

test('الطلب المختلط [A −١٠ صريح، تلقائي −٥]: A صُفّيت فيُسحب من B وحدها (الخادم يقبله)', () => {
  const lines = [existing('A', -10), auto(-5)];
  assert.deepEqual(autoDecreaseSources(AB, lines).map((s) => [s.lotId, s.usable]), [['B', 5]]);
  assert.equal(autoProblem(AB, lines), null);
  assert.deepEqual(autoDecreasePreview(AB, lines), [null, [{ lotId: 'B', qty: 5 }]]);
});

test('صريحٌ لا يصفّي مصدره ⇒ مصدران باقيان ⇒ لا اختيار يلزم: التلقائي يُسحب من الباقي بالترتيب', () => {
  const lines = [existing('A', -4), auto(-8)];
  assert.deepEqual(autoDecreaseSources(AB, lines).map((s) => [s.lotId, s.usable]), [['A', 6], ['B', 5]]);
  assert.equal(autoProblem(AB, lines), null, 'كان LOT_REQUIRED (D10)');
  assert.deepEqual(autoDecreasePreview(AB, lines)[1], [{ lotId: 'A', qty: 6 }, { lotId: 'B', qty: 2 }]);
});

test('«غير مسمّى» صريح يُطرح من غير المسمّى، وأسطر صريحة متعددة تُجمع لكل مصدر', () => {
  const s = [src('A', 10), src(null, 3)];
  const unk = { draft: d({ mode: 'UNKNOWN' }), baseQty: -3 };
  assert.equal(autoProblem(s, [unk, auto(-2)]), null);
  assert.deepEqual(autoDecreaseSources(s, [unk, auto(-2)]).map((x) => x.lotId), ['A']);
  // سطران على A مجموعهما ١٠ (D26) يصفّيانها، وما بقي B
  assert.deepEqual(autoDecreaseSources(AB, [existing('A', -6), existing('A', -4), auto(-1)]).map((x) => x.lotId), ['B']);
  assert.equal(autoProblem(AB, [existing('A', -6), existing('A', -3), auto(-1)]), null);
});

test('صريحٌ فوق صالحه أو على غير مصدر يرفضه الخادم قبل «التلقائي»: لا طرح، والمصادر كاملة — لا يُمنع التلقائي على ظنّ', () => {
  assert.deepEqual(autoDecreaseSources(AB, [existing('A', -12), auto(-1)]), AB, 'A −١٢ فوق صالحها: LOT_STOCK_INSUFFICIENT للصريح');
  assert.deepEqual(autoDecreaseSources(AB, [existing('Z', -1), auto(-1)]), AB, 'تشغيلة ليست مصدراً');
  assert.equal(autoProblem(AB, [existing('A', -12), auto(-1)]), null);
});

test('صريحٌ يصفّي كل المصادر لا يُبقي شيئاً: تلقائيٌّ بعده فوق الرصيد (كان يُقرأ على المصادر كاملةً فيمرّ مع مصدرٍ وحيد)', () => {
  assert.deepEqual(autoDecreaseSources(AB, [existing('A', -10), existing('B', -5), auto(-1)]), []);
  assert.equal(autoProblem(AB, [existing('A', -10), existing('B', -5), auto(-1)]), 'LOT_STOCK_INSUFFICIENT');
  assert.equal(autoProblem([src('A', 10)], [existing('A', -10), auto(-1)]), 'LOT_STOCK_INSUFFICIENT');
});

test('بلا صريح: المصادر كما هي، والمسوّدات غير الصريحة لا تُطرح', () => {
  assert.deepEqual(autoDecreaseSources(AB, [auto(-1)]), AB);
  assert.deepEqual(autoDecreaseSources(AB, []), AB);
  // تشغيلة قائمة لم تُختر بعد، و«رقم جديد» يُطبَّع في النقص إلى «تلقائي»، وكمية غير رقمية أو صفر — لا شيء منها صريح
  assert.deepEqual(autoDecreaseSources(AB, [existing('', -10), { draft: d({ mode: 'NEW', lotNumber: 'A' }), baseQty: -10 }, existing('A', Number.NaN), existing('A', 0)]), AB);
  assert.equal(autoProblem(AB, [auto(-1)]), null, 'مصدران بلا صريح: سحبٌ تلقائي');
  assert.equal(autoProblem([src('A', 10)], [auto(-1)]), null);
});

test('الصريح مجموعاً لكل مصدر (D26) فوق صالحه يُمنع على كل سطرٍ يأخذ منه — مرآة pickOutSources بعد aggregateRequest وROW_OVER في الجوال', () => {
  const over = (sources: LotSource[] | null, lines: L[]) => explicitDecreaseOver(sources, lines);
  // [A −١٢، تلقائي −٢]: A فوق صالحها، والتلقائي لا يُحكم عليه هنا
  assert.deepEqual(over(AB, [existing('A', -12), auto(-2)]), [true, false]);
  // [A −٦، A −٦]: كلٌّ وحده ≤ ١٠ والمجموع ١٢ ⇒ كلاهما
  assert.deepEqual(over(AB, [existing('A', -6), existing('A', -6)]), [true, true]);
  // مصدرٌ آخر سليم لا يُوسَم معه
  assert.deepEqual(over(AB, [existing('A', -6), existing('B', -5), existing('A', -6)]), [true, false, true]);
  // الحدّ نفسه وكسور الأربع خانات مقبولة
  assert.deepEqual(over(AB, [existing('A', -6), existing('A', -4), existing('B', -5)]), [false, false, false]);
  assert.deepEqual(over([src('A', 10.0001)], [existing('A', -10.0001)]), [false]);
  // «غير مسمّى» حتى صالحه (I2)، وبلا صالحٍ غير مسمّى (غائبٌ عن المصادر) أيّ كميةٍ فوقه
  const un = (q: number) => ({ draft: d({ mode: 'UNKNOWN' }), baseQty: q });
  assert.deepEqual(over([src('A', 10), src(null, 3)], [un(-2), un(-2)]), [true, true]);
  assert.deepEqual(over([src('A', 10), src(null, 3)], [un(-3)]), [false]);
  assert.deepEqual(over(AB, [un(-1)]), [true], 'غير مسمّى بلا صالح');
  // تشغيلة ليست مصدراً (نفدت بعد الاختيار)
  assert.deepEqual(over(AB, [existing('Z', -1)]), [true]);
  // المصادر لم تصل (null) ⇒ لا حكم؛ ووصلت فارغةً ⇒ كل صريحٍ فوقها
  assert.deepEqual(over(null, [existing('A', -12), un(-1)]), [false, false]);
  assert.deepEqual(over([], [existing('A', -1), auto(-1)]), [true, false]);
  // ما ليس صريحاً لا يُوسَم: قائمة لم تُختر، وكمية صفر أو غير رقمية
  assert.deepEqual(over(AB, [existing('', -99), existing('A', 0), existing('A', Number.NaN)]), [false, false, false]);
});

test('entryLotProblem: sourceOver للنقص الصريح وحده ⇒ LOT_OVER_SOURCE، والتلقائي والزيادة لا يأخذانه', () => {
  const p = (draft: EntryLotDraft, kind: 'DECREASE' | 'INCREASE', sourceOver: boolean) => entryLotProblem(draft, { kind, expiryRequired: false, sourceOver });
  assert.equal(p(d({ mode: 'EXISTING', lotId: 'A' }), 'DECREASE', true), 'LOT_OVER_SOURCE');
  assert.equal(p(d({ mode: 'UNKNOWN' }), 'DECREASE', true), 'LOT_OVER_SOURCE');
  assert.equal(p(d({ mode: 'EXISTING', lotId: 'A' }), 'DECREASE', false), null);
  assert.equal(p(d({ mode: 'EXISTING' }), 'DECREASE', true), 'LOT_REQUIRED', 'لم تُختر بعد: الاختيار أولاً');
  assert.equal(p(d({ mode: 'AUTO' }), 'DECREASE', true), null);
  assert.equal(p(d({ mode: 'EXISTING', lotId: 'A' }), 'INCREASE', true), null, 'الزيادة لا رصيد يُفحص');
  assert.equal(p(d({ mode: 'UNKNOWN' }), 'INCREASE', true), null);
});

test('صريحٌ فوق مصدره ⇒ لا معاينة للتلقائي (الخادم يرفض الحركة قبله، ومعاينته من مصدرٍ مُستنفَد تضليل)', () => {
  assert.deepEqual(autoDecreasePreview(AB, [existing('A', -12), auto(-2)]), [null, null]);
  assert.deepEqual(autoDecreasePreview(AB, [existing('A', -6), existing('A', -6), auto(-2)]), [null, null, null]);
  // والسليم كما كان: ما بقي بعد الصريح
  assert.deepEqual(autoDecreasePreview(AB, [existing('A', -6), existing('A', -4), auto(-2)]), [null, null, [{ lotId: 'B', qty: 2 }]]);
});

test('صفحة مخزون الشركة: لا عدّ مصادر ولا LOT_REQUIRED للتلقائي، والمعاينة من أسطر النقص نفسها', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'CompanyWarehousePage.tsx'), 'utf8');
  assert.doesNotMatch(page, /sourcesCount/, 'عدّ المصادر كان مرآة D10 الملغاة');
  assert.match(page, /autoDecreasePreview\(sourcesOf\(r\.productId\), decLinesOf\(r\.productId\)\)\[at\]/);
  assert.match(page, /autoRows=\{kind === 'DECREASE' \? autoRowsOf\(r\) : undefined\}/);
  // المعامل لقاعدة الكرتون (D22) في أسطر النقص
  assert.match(page, /return \{ draft: x\.lot, baseQty: Number\(x\.qty\) \* factor, unitFactor: factor \};/);
  // الصريح مجموعاً لكل مصدر من أسطر النقص نفسها، والمصادر قبل وصولها null لا تمنع
  assert.match(page, /sourceOver: at >= 0 && explicitDecreaseOver\(srcQ\.isSuccess \? sourcesOf\(r\.productId\) : null, decLinesOf\(r\.productId\)\)\[at\]/);
  const fields = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'StockLotFields.tsx'), 'utf8');
  assert.match(fields, /p === 'LOT_OVER_SOURCE'\) return tr\('الكمية أكبر من المتاح في المصدر'\)/);
});
