import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEngineCountryMatrix, UNKNOWN_COUNTRY, OTHER_COUNTRIES } from './aiEngineCountry';

test('مصفوفة المحرّك × الدولة: صفوف بترتيب المجموع وأعمدة أعلى الدول ولا يضيع عدد', () => {
  const m = buildEngineCountryMatrix([
    { engine: 'ChatGPT', country: 'Saudi Arabia', countryCode: 'SA', count: 5 },
    { engine: 'ChatGPT', country: 'Egypt', countryCode: 'EG', count: 2 },
    { engine: 'DeepSeek', country: 'Egypt', countryCode: 'EG', count: 4 },
    { engine: 'Gemini', country: null, countryCode: null, count: 1 },
  ]);
  assert.deepEqual(m.rows.map((r) => r.engine), ['ChatGPT', 'DeepSeek', 'Gemini']);
  assert.deepEqual(m.columns.map((c) => c.label), ['Egypt', 'Saudi Arabia', UNKNOWN_COUNTRY]);
  assert.deepEqual(m.rows[0].cells, [2, 5, 0]);
  assert.deepEqual(m.rows[1].cells, [4, 0, 0]);
  assert.deepEqual(m.rows[2].cells, [0, 0, 1]);
  assert.equal(m.total, 12);
  for (const r of m.rows) assert.equal(r.cells.reduce((s, n) => s + n, 0), r.total);
});

test('الدول الزائدة تُجمع في «دول أخرى»، ودولة زائدة واحدة تُعرض باسمها', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ engine: 'ChatGPT', country: `C${i}`, countryCode: null, count: 10 - i }));
  const m = buildEngineCountryMatrix(items, 6);
  assert.equal(m.columns.length, 7);
  assert.equal(m.columns[6].label, OTHER_COUNTRIES);
  assert.equal(m.rows[0].cells[6], 4 + 3 + 2); // C6..C8
  assert.equal(m.rows[0].cells.reduce((s, n) => s + n, 0), m.total);

  const seven = buildEngineCountryMatrix(items.slice(0, 7), 6);
  assert.equal(seven.columns.length, 7);
  assert.ok(!seven.columns.some((c) => c.label === OTHER_COUNTRIES));
});

test('ردّ خادم أقدم بلا الحقل أو بقيم فارغة ⇒ مصفوفة فارغة لا خطأ', () => {
  for (const v of [undefined, null, [], [{ engine: '', country: 'X', countryCode: null, count: 3 }]]) {
    const m = buildEngineCountryMatrix(v as never);
    assert.equal(m.rows.length, 0);
    assert.equal(m.total, 0);
  }
});
