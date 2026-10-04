import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRuns } from './mergeRuns';

const rows = [
  { rep: 'أحمد', day: '2026-09-12', c: 'أ', total: '11 س' },
  { rep: 'أحمد', day: '2026-09-12', c: 'ب', total: '11 س' },
  { rep: 'أحمد', day: '2026-09-14', c: 'ج', total: '9 س' },
  { rep: 'سالم', day: '2026-09-14', c: 'د', total: '7 س' },
];
const keys = rows.map(r => ({ rep: r.rep, day: `${r.rep}|${r.day}` }));

test('المندوب مرّةً لكل مندوب، والتاريخ وإجمالي اليوم مرّةً لكل يوم', () => {
  const m = mergeRuns(rows, [
    { cols: ['rep'], keyOf: i => keys[i].rep },
    { cols: ['day', 'total'], keyOf: i => keys[i].day },
  ]);
  assert.deepEqual(m.rows.map(r => r.rep), ['أحمد', '', '', 'سالم']);
  assert.deepEqual(m.rows.map(r => r.day), ['2026-09-12', '', '2026-09-14', '2026-09-14']);
  assert.deepEqual(m.rows.map(r => r.total), ['11 س', '', '9 س', '7 س']);
  assert.deepEqual(m.rows.map(r => r.c), ['أ', 'ب', 'ج', 'د']);
  assert.deepEqual(m.merges, [
    { col: 'rep', from: 0, to: 2, value: 'أحمد' },
    { col: 'day', from: 0, to: 1, value: '2026-09-12' },
    { col: 'total', from: 0, to: 1, value: '11 س' },
  ]);
});

test('اليوم نفسه لمندوبَين لا يُدمج، والمدخلات لا تتغيّر، والفراغ بلا دمج', () => {
  const m = mergeRuns(rows, [{ cols: ['day'], keyOf: i => keys[i].day }]);
  assert.equal(m.rows[3].day, '2026-09-14');
  assert.equal(rows[1].rep, 'أحمد');
  assert.deepEqual(mergeRuns([], [{ cols: ['x'], keyOf: () => 'k' }]), { rows: [], merges: [] });
  assert.deepEqual(mergeRuns([{ x: 1 }], [{ cols: ['x'], keyOf: () => 'k' }]).merges, []);
});
