import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { vanLeftover, fillVanLeft, REP_DELETE_VAN } from './repDeleteVan';
import { PHRASES } from '../i18n/strings';

test('الموجب وحده بضاعة في السيارة — السالب بيع بلا مخزون لا يُطرح ولا يُعد', () => {
  const left = vanLeftover([
    { productId: 'a', remaining: 12 },
    { productId: 'b', remaining: -4 },
    { productId: 'c', remaining: 0 },
    { productId: 'd', remaining: 3.5 },
  ]);
  assert.deepEqual(left, { products: 2, qty: 15.5 });
});

test('غبار الجمع لا يظهر رقما طويلا في التحذير', () => {
  assert.equal(vanLeftover([{ remaining: 0.1 }, { remaining: 0.2 }]).qty, 0.3);
});

test('شكل غير متوقع يعود صفرا — التحذير لا يُسقط حوار الحذف', () => {
  for (const bad of [undefined, null, {}, 'x', [null, { remaining: 'abc' }, { remaining: NaN }]]) {
    assert.deepEqual(vanLeftover(bad), { products: 0, qty: 0 });
  }
});

test('الأرقام تُملأ بعد الترجمة بالمنسّق الممرَّر', () => {
  const s = fillVanLeft('{qty} / {n}', { products: 3, qty: 1500 }, (n) => `#${n}`);
  assert.equal(s, '#1500 / #3');
});

test('نصوص التحذير مترجمة باللغات الأربع — وكل ترجمة تحمل {qty} و{n}', () => {
  for (const key of Object.values(REP_DELETE_VAN)) {
    const row = PHRASES[key];
    assert.ok(row, `لا ترجمة للنص: ${key}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(row[lang]?.trim(), `${lang} فارغة: ${key}`);
  }
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    const t = PHRASES[REP_DELETE_VAN.left][lang];
    assert.ok(t.includes('{qty}') && t.includes('{n}'), `ترجمة ${lang} تُسقط رقماً من التحذير`);
  }
});

test('حوارا الحذف (اللوحة والجوال) يعرضان التحذير، ونص اللوحة لم يعد يعد بحذف مخزون السيارة', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
  const page = read('pages', 'SalesRepsPage.tsx');
  assert.equal((page.match(/<RepVanStockNote repId=/g) || []).length, 2, 'حوارا اللوحة (العادي والدفاتر) يجب أن يعرضا التحذير');
  assert.doesNotMatch(page, /التشغيلية مخزون السيارة/, 'النص يقول إن مخزون السيارة يُحذف — لم يعد كذلك');
  const m = read('m', 'MSalesReps.tsx');
  assert.equal((m.match(/<RepVanStockNote repId=/g) || []).length, 2, 'ورقتا الجوال يجب أن تعرضا التحذير');
});
