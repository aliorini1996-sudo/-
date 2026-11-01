// «تتبّع اللوط» — نموذج حركة المستودع في اللوحة: أسطر النقص «التلقائية» لا تتجاوز **مجموع** ما بقي بعد صريح صنفها أيّاً كان عدد
// المصادر — مرآة pickOutFefoLines على العرض بعد withoutRows في planWarehouseEntryInTx (طلب المالك ١ نوفمبر ٢٠٢٦): [A −١٠ صريحة،
// تلقائي −٨] مع A:10 وB:5 يردّه الخادم LOT_STOCK_INSUFFICIENT (B:5 < ٨)، و[تلقائي −١٤] يُسحب من A ثم B فيُقبل.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { autoDecreaseOver, autoDecreasePreview, emptyEntryLot, entryLotProblem, type EntryLotDraft, type LotSource } from './stockLots';
import { fefoAutoPull } from './lots';

const src = (lotId: string | null, usable: number, expiryDate: string | null = null, o: Partial<LotSource> = {}): LotSource =>
  ({ lotId, lotNumber: lotId, expiryDate, status: lotId ? 'ACTIVE' : null, blockKind: null, usable, expired: false, ...o });
const d = (p: Partial<EntryLotDraft>): EntryLotDraft => ({ ...emptyEntryLot('AUTO'), ...p });
const existing = (lotId: string, baseQty: number) => ({ draft: d({ mode: 'EXISTING', lotId }), baseQty });
const auto = (baseQty: number, unitFactor?: number) => ({ draft: d({ mode: 'AUTO' }), baseQty, unitFactor });
type L = { draft: EntryLotDraft; baseQty: number; unitFactor?: number };
const autoProblem = (sources: LotSource[], lines: L[]) => entryLotProblem(d({ mode: 'AUTO' }), {
  kind: 'DECREASE', expiryRequired: false, autoOver: autoDecreaseOver(sources, lines),
});

const AB = [src('A', 10), src('B', 5)];

test('التلقائي فوق مجموع الباقي بعد الصريح ⇒ LOT_STOCK_INSUFFICIENT كما يردّه الخادم', () => {
  assert.equal(autoDecreaseOver(AB, [existing('A', -10), auto(-8)]), true);
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-8)]), 'LOT_STOCK_INSUFFICIENT');
  // سطران تلقائيان يُجمعان (D26): ٣ + ٣ > B:5
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-3), auto(-3)]), 'LOT_STOCK_INSUFFICIENT');
  // «غير مسمّى» باقٍ وحده بعد صريح A
  assert.equal(autoProblem([src('A', 10), src(null, 2)], [existing('A', -10), auto(-3)]), 'LOT_STOCK_INSUFFICIENT');
  // مصادر متعددة بلا صريح: فوق مجموعها نقصٌ في الخادم
  assert.equal(autoProblem(AB, [auto(-16)]), 'LOT_STOCK_INSUFFICIENT');
  assert.equal(autoProblem([src('A', 10)], [auto(-11)]), 'LOT_STOCK_INSUFFICIENT');
});

test('ما يقبله الخادم لا يُمنع: التلقائي ≤ مجموع الباقي من أي عدد مصادر، والحدّ نفسه، وكسور الأربع خانات', () => {
  assert.equal(autoProblem(AB, [auto(-14)]), null, 'كان LOT_REQUIRED (D10): يُسحب من A ثم B');
  assert.equal(autoProblem(AB, [auto(-15)]), null);
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-5)]), null);
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-2), auto(-3)]), null);
  assert.equal(autoProblem(AB, [existing('A', -4), auto(-11)]), null, 'الباقي A:6 وB:5');
  assert.equal(autoProblem([src('A', 10.0001)], [auto(-10.0001)]), null);
  assert.equal(autoProblem([src('A', 10)], [auto(-10)]), null);
});

test('بلا تلقائي أو بلا مصادر معروفة: لا حكم كمية هنا (لا يُمنع على ظنّ)', () => {
  assert.equal(autoDecreaseOver(AB, [existing('A', -10)]), false);
  assert.equal(autoDecreaseOver([], [auto(-1)]), false, 'المصادر لم تصل أو تعذّر جلبها');
  assert.equal(autoDecreaseOver(AB, [auto(0)]), false);
  // EXISTING وUNKNOWN لا يأخذان autoOver
  assert.equal(entryLotProblem(d({ mode: 'EXISTING', lotId: 'A' }), { kind: 'DECREASE', expiryRequired: false, autoOver: true }), null);
  assert.equal(entryLotProblem(d({ mode: 'UNKNOWN' }), { kind: 'DECREASE', expiryRequired: false, autoOver: true }), null);
});

test('fefoAutoPull (مرآة pickOutFefoLines): الأقرب انتهاءً أولاً، وبلا انتهاء آخر المسمّاة، وغير المسمّى آخراً — والموقوفة والمنتهية منها', () => {
  const s = [
    src(null, 4),
    src('N', 3),                                    // بلا انتهاء
    src('L', 2, '2027-03-01'),
    src('X', 1, '2026-10-01', { expired: true }),   // منتهية — تخرج أولاً
    src('K', 2, '2026-12-01', { status: 'BLOCKED', blockKind: 'HOLD' }),
  ];
  assert.deepEqual(fefoAutoPull(s, [{ qty: 7 }]).rows[0], [{ lotId: 'X', qty: 1 }, { lotId: 'K', qty: 2 }, { lotId: 'L', qty: 2 }, { lotId: 'N', qty: 2 }]);
  assert.deepEqual(fefoAutoPull(s, [{ qty: 10 }]).rows[0].slice(-1)[0], { lotId: null, qty: 2 }, 'غير المسمّى بعد نفاد المسمّاة');
  // التعادل بترتيب المصادر كما وصلت (العرض مرتّبٌ بـfefoCompare كاملاً في الخادم)
  assert.deepEqual(fefoAutoPull([src('B2', 5, '2027-01-01'), src('B1', 5, '2027-01-01')], [{ qty: 6 }]).rows[0], [{ lotId: 'B2', qty: 5 }, { lotId: 'B1', qty: 1 }]);
  // فوق المتاح: short وصفوفٌ فارغة، والمتاح المجموع
  const over = fefoAutoPull(s, [{ qty: 13 }]);
  assert.equal(over.short, true);
  assert.deepEqual(over.rows, [[]]);
  assert.equal(over.available, 12);
  assert.equal(fefoAutoPull([], [{ qty: 1 }]).short, true);
});

test('fefoAutoPull: قاعدة الكرتون لكل سطر (D22) ومتاحٌ مشترك بين الأسطر بترتيب الخدمة (D26)', () => {
  // A:30 وB:24 — كرتونٌ (٢٤) كاملاً من تشغيلةٍ واحدة أولاً: A تكفي كرتوناً، فالباقي (٦ لا يكمل كرتوناً) يُكمَل بالترتيب
  const s = [src('A', 30, '2026-12-01'), src('B', 24, '2027-01-01')];
  assert.deepEqual(fefoAutoPull(s, [{ qty: 48, unitFactor: 24 }]).rows[0], [{ lotId: 'A', qty: 24 }, { lotId: 'B', qty: 24 }]);
  // بلا معامل: الأقرب انتهاءً حتى ينفد
  assert.deepEqual(fefoAutoPull(s, [{ qty: 48 }]).rows[0], [{ lotId: 'A', qty: 30 }, { lotId: 'B', qty: 18 }]);
  // A:20 وB:24 وكرتونٌ واحد: A لا تكفي كرتوناً فيؤخذ من B كاملاً، لا ٢٠ من A و٤ من B
  assert.deepEqual(fefoAutoPull([src('A', 20, '2026-12-01'), src('B', 24, '2027-01-01')], [{ qty: 24, unitFactor: 24 }]).rows[0], [{ lotId: 'B', qty: 24 }]);
  // سطران: الكرتون يُخدم أولاً (cartonRank) فيأخذ كرتونه كاملاً من A، والحبّات مما ترك — والصفوف بترتيب الأسطر كما دخلت
  const two = fefoAutoPull(s, [{ qty: 10 }, { qty: 24, unitFactor: 24 }]);
  assert.deepEqual(two.rows, [[{ lotId: 'A', qty: 6 }, { lotId: 'B', qty: 4 }], [{ lotId: 'A', qty: 24 }]]);
  // سطران بلا كرتون: بترتيبهما، الثاني مما ترك الأول
  assert.deepEqual(fefoAutoPull(s, [{ qty: 10 }, { qty: 24 }]).rows, [[{ lotId: 'A', qty: 10 }], [{ lotId: 'A', qty: 20 }, { lotId: 'B', qty: 4 }]]);
});

test('fefoAutoPull: الكرتون أولاً (D22) — مرآة cartonRank في pickOutFefoLines: الأكبر معاملاً تنازلياً، والتعادل بترتيب الأسطر', () => {
  // A أقرب انتهاءً ١٢ وB ٥ — [٥ حبّات، كرتون ١٢]: الكرتون يأخذ A كاملةً قبل أن تقتطع الحبّات منها، فالحبّات من B
  const s = [src('A', 12, '2026-12-01'), src('B', 5, '2027-01-01')];
  const r = fefoAutoPull(s, [{ qty: 5, unitFactor: 1 }, { qty: 12, unitFactor: 12 }]);
  assert.equal(r.short, false);
  assert.deepEqual(r.rows[0], [{ lotId: 'B', qty: 5 }]);
  assert.deepEqual(r.rows[1], [{ lotId: 'A', qty: 12 }]);
  // الأكبر قبل الأصغر: طبليةٌ (٤٨) قبل كرتون (١٢) أيّاً كان ترتيبهما
  const big = [src('A', 48, '2026-12-01'), src('B', 12, '2027-01-01')];
  assert.deepEqual(fefoAutoPull(big, [{ qty: 12, unitFactor: 12 }, { qty: 48, unitFactor: 48 }]).rows, [[{ lotId: 'B', qty: 12 }], [{ lotId: 'A', qty: 48 }]]);
  // التعادل بترتيب الأسطر، والمعامل التالف أو ≤ ١ رتبته رتبة الأساس
  assert.deepEqual(fefoAutoPull(s, [{ qty: 3, unitFactor: 0.5 }, { qty: 2, unitFactor: Number.NaN }, { qty: 12, unitFactor: null }]).rows,
    [[{ lotId: 'A', qty: 3 }], [{ lotId: 'A', qty: 2 }], [{ lotId: 'A', qty: 7 }, { lotId: 'B', qty: 5 }]]);
  // سطرٌ صفري يبقى في مكانه بلا صفوف
  assert.deepEqual(fefoAutoPull(s, [{ qty: 0 }, { qty: 12, unitFactor: 12 }]).rows, [[], [{ lotId: 'A', qty: 12 }]]);
});

test('معاينة الصفحة (autoDecreasePreview): صفوف كل سطرٍ تلقائي بمعامله، وnull لغيره أو فوق المتاح أو بلا مصادر', () => {
  const s = [src('A', 30, '2026-12-01'), src('B', 24, '2027-01-01')];
  assert.deepEqual(autoDecreasePreview(s, [auto(-2 * 24, 24)]), [[{ lotId: 'A', qty: 24 }, { lotId: 'B', qty: 24 }]]);
  assert.deepEqual(autoDecreasePreview(s, [existing('A', -30), auto(-5)]), [null, [{ lotId: 'B', qty: 5 }]]);
  assert.deepEqual(autoDecreasePreview(s, [auto(-60)]), [null], 'فوق المتاح: لا معاينة');
  assert.deepEqual(autoDecreasePreview([], [auto(-1)]), [null], 'المصادر لم تصل');
});

test('صفحة مخزون الشركة تمرّر autoOver من أسطر النقص نفسها، والنصّ يقول رصيد التشغيلات لا تشغيلةً واحدة', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'CompanyWarehousePage.tsx'), 'utf8');
  assert.match(page, /autoOver:\s*autoDecreaseOver\(sourcesOf\(r\.productId\),\s*decLinesOf\(r\.productId\)\)/);
  const fields = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'StockLotFields.tsx'), 'utf8');
  assert.match(fields, /p === 'LOT_STOCK_INSUFFICIENT'\) return tr\('الكمية أكبر من رصيد تشغيلات الصنف في المستودع'\)/);
  // «التلقائي» يعرض معاينة السحب لا «المصدر الوحيد»
  assert.match(fields, /\{mode === 'AUTO' && <AutoPullPreview rows=\{autoRows\} sources=\{sources \?\? \[\]\} \/>\}/);
  assert.doesNotMatch(fields, /المصدر الوحيد|أكثر من تشغيلة حدد/);
});
