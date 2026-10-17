import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSheetsByTeam } from './teamReport';

const T = 'الفريق';

test('ورقة لكل فريق: أوراق المستندات تُقسَم بعمود الفريق، والملخّص والموحّدة تبقى كما هي', () => {
  const out = splitSheetsByTeam([
    { name: 'الإجمالي', rows: [{ a: 1 }] },
    { name: 'المرتجعات', rows: [{ [T]: 'المكسرات', n: 1 }, { [T]: 'بلا فريق', n: 2 }, { [T]: 'المكسرات', n: 3 }] },
    { name: 'تفاصيل', rows: [{ [T]: 'المكسرات', n: 1 }], merges: [{ col: T, from: 0, to: 0, value: 'x' }] as never },
  ], T);
  assert.deepEqual(out.map((s) => s.name), ['الإجمالي', 'المكسرات · المرتجعات', 'بلا فريق · المرتجعات', 'تفاصيل']);
  assert.deepEqual(out[1].rows.map((r) => r.n), [1, 3]);
});

test('اسم الورقة: منقّى من محارف Excel الممنوعة، ولا يتجاوز ٣١ حرفاً، وفريدٌ بعد القصّ', () => {
  const long = 'فريق المكسرات والحلويات الشرقية الكبير';
  const out = splitSheetsByTeam([
    { name: 'المرتجعات', rows: [{ [T]: `${long} [أ]`, n: 1 }, { [T]: `${long} [ب]`, n: 2 }] },
  ], T);
  for (const s of out) {
    assert.ok(s.name.length <= 31, s.name);
    assert.ok(!/[\\/?*[\]:]/.test(s.name), s.name);
  }
  assert.equal(new Set(out.map((s) => s.name)).size, 2, 'اسمان متطابقان بعد القصّ');
});
