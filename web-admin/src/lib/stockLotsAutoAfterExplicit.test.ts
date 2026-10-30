// «تتبّع اللوط» — نموذج حركة المستودع في اللوحة: سطر النقص «التلقائي» يُحكم عليه مما بقي بعد صريح صنفه (D10)، مرآة
// planWarehouseEntryInTx في الخادم (withoutRows): [تشغيلة A −١٠ صريحة، تلقائي −٥] مقبولٌ في الخادم فلا تمنعه الواجهة،
// وما يرفضه الخادم (صريحٌ فوق صالحه، أو صريحٌ يصفّي كل المصادر) يبقى ممنوعاً كما كان.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { autoDecreaseSources, emptyEntryLot, entryLotProblem, type EntryLotDraft, type LotSource } from './stockLots';

const src = (lotId: string | null, usable: number): LotSource =>
  ({ lotId, lotNumber: lotId, expiryDate: null, status: lotId ? 'ACTIVE' : null, blockKind: null, usable, expired: false });
const d = (p: Partial<EntryLotDraft>): EntryLotDraft => ({ ...emptyEntryLot('AUTO'), ...p });
const existing = (lotId: string, baseQty: number) => ({ draft: d({ mode: 'EXISTING', lotId }), baseQty });
const auto = (baseQty: number) => ({ draft: d({ mode: 'AUTO' }), baseQty });
const autoProblem = (sources: LotSource[], lines: { draft: EntryLotDraft; baseQty: number }[]) =>
  entryLotProblem(d({ mode: 'AUTO' }), { kind: 'DECREASE', expiryRequired: false, sourcesCount: autoDecreaseSources(sources, lines).length });

const AB = [src('A', 10), src('B', 5)];

test('الطلب المختلط [A −١٠ صريح، تلقائي −٥]: A صُفّيت فالمصدر الباقي B وحده ⇒ لا يُمنع (الخادم يقبله)', () => {
  const lines = [existing('A', -10), auto(-5)];
  assert.deepEqual(autoDecreaseSources(AB, lines).map((s) => [s.lotId, s.usable]), [['B', 5]]);
  assert.equal(autoProblem(AB, lines), null);
});

test('صريحٌ لا يصفّي مصدره ⇒ مصدران باقيان ⇒ LOT_REQUIRED كما يردّه الخادم', () => {
  const lines = [existing('A', -4), auto(-1)];
  assert.deepEqual(autoDecreaseSources(AB, lines).map((s) => [s.lotId, s.usable]), [['A', 6], ['B', 5]]);
  assert.equal(autoProblem(AB, lines), 'LOT_REQUIRED');
});

test('«غير مسمّى» صريح يُطرح من غير المسمّى، وأسطر صريحة متعددة تُجمع لكل مصدر', () => {
  const s = [src('A', 10), src(null, 3)];
  assert.equal(autoProblem(s, [{ draft: d({ mode: 'UNKNOWN' }), baseQty: -3 }, auto(-2)]), null);
  assert.deepEqual(autoDecreaseSources(s, [{ draft: d({ mode: 'UNKNOWN' }), baseQty: -3 }, auto(-2)]).map((x) => x.lotId), ['A']);
  // سطران على A مجموعهما ١٠ (D26) يصفّيانها
  assert.equal(autoProblem(AB, [existing('A', -6), existing('A', -4), auto(-1)]), null);
  assert.equal(autoProblem(AB, [existing('A', -6), existing('A', -3), auto(-1)]), 'LOT_REQUIRED');
});

test('ما يرفضه الخادم قبل «التلقائي» لا يفتحه الطرح: صريحٌ فوق صالحه، أو على غير مصدر، أو يصفّي كل المصادر', () => {
  assert.equal(autoProblem(AB, [existing('A', -12), auto(-1)]), 'LOT_REQUIRED', 'A −١٢ فوق صالحها: LOT_STOCK_INSUFFICIENT في الخادم');
  assert.equal(autoProblem(AB, [existing('Z', -1), auto(-1)]), 'LOT_REQUIRED', 'تشغيلة ليست مصدراً');
  assert.equal(autoProblem(AB, [existing('A', -10), existing('B', -5), auto(-1)]), 'LOT_REQUIRED', 'لا مصدر باقٍ: نقصٌ في الخادم');
});

test('بلا صريح: المصادر كما هي (السلوك القائم حرفاً)، والمسوّدات غير الصريحة لا تُطرح', () => {
  assert.deepEqual(autoDecreaseSources(AB, [auto(-1)]), AB);
  assert.deepEqual(autoDecreaseSources(AB, []), AB);
  // تشغيلة قائمة لم تُختر بعد، و«رقم جديد» يُطبَّع في النقص إلى «تلقائي»، وكمية غير رقمية أو صفر — لا شيء منها صريح
  assert.deepEqual(autoDecreaseSources(AB, [existing('', -10), { draft: d({ mode: 'NEW', lotNumber: 'A' }), baseQty: -10 }, existing('A', Number.NaN), existing('A', 0)]), AB);
  assert.equal(autoProblem(AB, [auto(-1)]), 'LOT_REQUIRED');
  assert.equal(autoProblem([src('A', 10)], [auto(-1)]), null);
});

test('صفحة مخزون الشركة تحكم على «التلقائي» بمصادر ما بعد الصريح لا بالعرض كاملاً', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'CompanyWarehousePage.tsx'), 'utf8');
  assert.doesNotMatch(page, /sourcesCount:\s*sourcesOf\(/, 'العدّ من العرض كاملاً يمنع ما يقبله الخادم');
  assert.match(page, /sourcesCount:\s*autoSourcesOf\(/);
  assert.match(page, /autoDecreaseSources\(/);
  // تلميح «ينقص من المصدر الوحيد» يسمّي المصدر الباقي نفسه
  assert.match(page, /autoSources=\{kind === 'DECREASE' \? autoSourcesOf\(r\.productId\) : undefined\}/);
});
