// «تتبّع اللوط» — /m: سطر إنقاصٍ بلا صريح يُحكم عليه مما بقي بعد أسطر صنفه الصريحة (D10)، مرآة planWarehouseEntryInTx
// (withoutRows) في المستودع وpickPlan في السيارة: [تشغيلة A −١٠ صريحة، بلا اختيار −٥] مقبولٌ في الخادم فلا يُمنع هنا.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outGroupProblems, whOutRows, emptyLotDraft, type OutSourceQty } from './mLotsLogic';

const AB: OutSourceQty[] = [{ lotId: 'A', usable: 10 }, { lotId: 'B', usable: 5 }];
const pick = (p: string, base: number) => whOutRows({ ...emptyLotDraft(), pick: p }, base);
const probs = (sources: OutSourceQty[], ls: [string, string, number][]) =>
  outGroupProblems(sources, ls.map(([key, p, base]) => ({ key, base, rows: pick(p, base) })), { loaded: true });

test('الطلب المختلط [A −١٠، بلا اختيار −٥]: المصدر الباقي B وحده ⇒ لا PICK (الخادم يقبله)', () => {
  assert.equal(probs(AB, [['x', 'A', 10], ['y', '', 5]]).size, 0);
  assert.equal(probs([{ lotId: 'A', usable: 10 }, { lotId: null, usable: 3 }], [['x', 'UNNAMED', 3], ['y', '', 2]]).size, 0);
});

test('الباقي بعد الصريح يحكم الكمية أيضاً: بلا اختيار يُحسب على المصدر الباقي وحده', () => {
  assert.equal(probs(AB, [['x', 'A', 10], ['y', '', 4]]).size, 0);
  // صريحٌ على B نفسها: الباقي B:3، والسطر بلا اختيار ٣ يكفيه
  assert.equal(probs(AB, [['x', 'A', 10], ['z', 'B', 2], ['y', '', 3]]).size, 0);
  // B:5 والسطر ٦ (مجموع الصنف ١٦ > ١٥ ⇒ OVER على أول سطر — الخادم: LOT_STOCK_INSUFFICIENT)
  assert.equal(probs(AB, [['x', 'A', 10], ['y', '', 6]]).get('x'), 'OVER');
});

test('صريحٌ لا يصفّي مصدره ⇒ مصدران باقيان ⇒ PICK كما يردّه الخادم (LOT_REQUIRED)', () => {
  assert.equal(probs(AB, [['x', 'A', 4], ['y', '', 1]]).get('y'), 'PICK');
});

test('ما يرفضه الخادم قبل «التلقائي» يبقى ممنوعاً: صريحٌ فوق صالحه، أو يصفّي كل المصادر', () => {
  const over = probs(AB, [['x', 'A', 11], ['y', '', 1]]);
  assert.equal(over.get('x'), 'ROW_OVER');
  assert.equal(over.get('y'), 'PICK');
  const all = probs(AB, [['x', 'A', 10], ['z', 'B', 5], ['y', '', 1]]);
  assert.ok(all.size > 0);
  // سطران بلا صريح فقط: كما كان حرفاً
  assert.equal(probs(AB, [['y', '', 1]]).get('y'), 'PICK');
  assert.equal(probs([{ lotId: 'A', usable: 10 }], [['y', '', 1], ['w', '', 2]]).size, 0);
});
