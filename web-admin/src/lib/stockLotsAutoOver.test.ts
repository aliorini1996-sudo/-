// «تتبّع اللوط» — نموذج حركة المستودع في اللوحة: سطر النقص «التلقائي» على المصدر الوحيد الباقي بعد صريح صنفه (D10) لا يتجاوز
// صالح ذلك المصدر — مرآة pickOutSources على العرض بعد withoutRows في planWarehouseEntryInTx: [A −١٠ صريحة، تلقائي −٨] مع A:10
// وB:5 يردّه الخادم LOT_STOCK_INSUFFICIENT (B:5 < ٨)، فلا تفتحه الواجهة بعد أن صار عدّ المصادر مما بقي (كان يُمنع LOT_REQUIRED).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { autoDecreaseOver, autoDecreaseSources, emptyEntryLot, entryLotProblem, type EntryLotDraft, type LotSource } from './stockLots';

const src = (lotId: string | null, usable: number): LotSource =>
  ({ lotId, lotNumber: lotId, expiryDate: null, status: lotId ? 'ACTIVE' : null, blockKind: null, usable, expired: false });
const d = (p: Partial<EntryLotDraft>): EntryLotDraft => ({ ...emptyEntryLot('AUTO'), ...p });
const existing = (lotId: string, baseQty: number) => ({ draft: d({ mode: 'EXISTING', lotId }), baseQty });
const auto = (baseQty: number) => ({ draft: d({ mode: 'AUTO' }), baseQty });
type L = { draft: EntryLotDraft; baseQty: number };
const autoProblem = (sources: LotSource[], lines: L[]) => entryLotProblem(d({ mode: 'AUTO' }), {
  kind: 'DECREASE', expiryRequired: false, sourcesCount: autoDecreaseSources(sources, lines).length, autoOver: autoDecreaseOver(sources, lines),
});

const AB = [src('A', 10), src('B', 5)];

test('التلقائي فوق المصدر الباقي بعد الصريح ⇒ LOT_OVER_SOURCE (الخادم: LOT_STOCK_INSUFFICIENT)', () => {
  assert.equal(autoDecreaseOver(AB, [existing('A', -10), auto(-8)]), true);
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-8)]), 'LOT_OVER_SOURCE');
  // سطران تلقائيان يُجمعان (D26): ٣ + ٣ > B:5
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-3), auto(-3)]), 'LOT_OVER_SOURCE');
  // «غير مسمّى» باقٍ وحده بعد صريح A
  assert.equal(autoProblem([src('A', 10), src(null, 2)], [existing('A', -10), auto(-3)]), 'LOT_OVER_SOURCE');
  // مصدرٌ وحيد بلا صريح: التلقائي فوقه نقصٌ في الخادم أيضاً
  assert.equal(autoProblem([src('A', 10)], [auto(-11)]), 'LOT_OVER_SOURCE');
});

test('ما يقبله الخادم لا يُمنع: التلقائي ≤ المصدر الباقي، والحدّ نفسه، وكسور الأربع خانات', () => {
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-5)]), null);
  assert.equal(autoProblem(AB, [existing('A', -10), auto(-2), auto(-3)]), null);
  assert.equal(autoProblem([src('A', 10.0001)], [auto(-10.0001)]), null);
  assert.equal(autoProblem([src('A', 10)], [auto(-10)]), null);
});

test('بلا تلقائي أو بأكثر من مصدر باقٍ: لا حكم كمية هنا (LOT_REQUIRED يسبق)', () => {
  assert.equal(autoDecreaseOver(AB, [existing('A', -10)]), false);
  assert.equal(autoDecreaseOver(AB, [auto(-100)]), false, 'مصدران: الخادم يردّ LOT_REQUIRED');
  assert.equal(autoProblem(AB, [auto(-100)]), 'LOT_REQUIRED');
  assert.equal(autoDecreaseOver([], [auto(-1)]), false, 'المصادر لم تصل أو تعذّر جلبها: لا يُمنع على ظنّ');
  // EXISTING وUNKNOWN لا يأخذان autoOver
  assert.equal(entryLotProblem(d({ mode: 'EXISTING', lotId: 'A' }), { kind: 'DECREASE', expiryRequired: false, autoOver: true }), null);
  assert.equal(entryLotProblem(d({ mode: 'UNKNOWN' }), { kind: 'DECREASE', expiryRequired: false, autoOver: true }), null);
});

test('صفحة مخزون الشركة تمرّر autoOver من أسطر النقص نفسها', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'CompanyWarehousePage.tsx'), 'utf8');
  assert.match(page, /autoOver:\s*autoDecreaseOver\(sourcesOf\(r\.productId\),\s*decLinesOf\(r\.productId\)\)/);
  const fields = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'StockLotFields.tsx'), 'utf8');
  assert.match(fields, /p === 'LOT_OVER_SOURCE'\) return tr\('الكمية أكبر من المتاح في التشغيلة'\)/);
});
