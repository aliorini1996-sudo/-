import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { vanLeftover, fillVanLeft, vanLeftText, REP_DELETE_VAN, toolsLeftover, vanIsEmpty, fillVanUnsellable, fillTools } from './repDeleteVan';
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

test('rep-offline-8 (R3): صنفٌ له رئيسية في المجموع ⇒ «بالوحدات الصغرى» لا «وحدة»، وبلاه الشكل والنصّ كما كانا', () => {
  const rows = [
    { productId: 'a', remaining: 48, primaryUnitId: 'u-c' },
    { productId: 'b', remaining: 5, primaryUnitId: null },
  ];
  const left = vanLeftover(rows);
  assert.deepEqual(left, { products: 2, qty: 53, anyPrimary: true });
  assert.equal(vanLeftText(left), REP_DELETE_VAN.leftSmallest);
  assert.match(fillVanLeft(vanLeftText(left), left), /^في سيارته الآن 53 بالوحدات الصغرى من 2 صنف/);
  // الرئيسية على صفٍّ صفريّ أو سالب لا تدخل المجموع فلا توسمه
  assert.deepEqual(vanLeftover([{ remaining: 0, primaryUnitId: 'u-c' }, { remaining: -3, primaryUnitId: 'u-c' }, { remaining: 4, primaryUnitId: null }]), { products: 1, qty: 4 });
  // I1: بلا رئيسية ⇒ لا مفتاح ولا نصّ جديد
  const plain = vanLeftover([{ remaining: 48, primaryUnitId: null }, { remaining: 5 }]);
  assert.deepEqual(plain, { products: 2, qty: 53 });
  assert.equal(vanLeftText(plain), REP_DELETE_VAN.left);
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    const t = PHRASES[REP_DELETE_VAN.leftSmallest]?.[lang] ?? '';
    assert.ok(t.includes('{qty}') && t.includes('{n}'), `ترجمة ${lang} تُسقط رقماً من التحذير`);
  }
  const note = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'RepVanStockNote.tsx'), 'utf8');
  assert.match(note, /fillVanLeft\(tr\(vanLeftText\(left\)\), left, formatNumber\)/);
});

test('D9: التالف والمنتهي في السيارة يُعدّان وحدهما — «لا بضاعة» لا تُقال وفيها تالف أو أدوات', () => {
  const left = vanLeftover([
    { productId: 'a', remaining: 0, damaged: 6 },
    { productId: 'b', remaining: 0, expired: 2, damaged: -1 },
    { productId: 'c', remaining: 4 },
  ]);
  assert.deepEqual(left, { products: 1, qty: 4, unsellable: 8, unsellableProducts: 2 });
  assert.equal(fillVanUnsellable('{qty}/{n}', left), '8/2');
  const onlyBad = vanLeftover([{ remaining: 0, damaged: 6 }]);
  assert.equal(vanIsEmpty(onlyBad, null), false, 'كان يقول «لا بضاعة في سيارته» وفيها ٦ تالفة');
  const tools = toolsLeftover({ balances: [{ toolName: 'عربة تحميل', qty: 3 }, { toolName: 'سلة', qty: 1 }, { toolName: ' ', qty: 2 }, { toolName: 'x', qty: 0 }], total: 4 });
  assert.deepEqual(tools, { total: 4, names: ['عربة تحميل ×3', 'سلة'] });
  assert.equal(fillTools('{qty}: {names}', tools), '4: عربة تحميل ×3، سلة');
  assert.equal(vanIsEmpty(vanLeftover([]), tools), false, 'العهدة تُذكر قبل الحذف');
  assert.equal(vanIsEmpty(vanLeftover([]), toolsLeftover(null)), true);
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    assert.ok(PHRASES[REP_DELETE_VAN.unsellable]?.[lang]?.includes('{qty}') && PHRASES[REP_DELETE_VAN.unsellable][lang].includes('{n}'), `${lang} تُسقط رقماً من التالف`);
    assert.ok(PHRASES[REP_DELETE_VAN.tools]?.[lang]?.includes('{qty}') && PHRASES[REP_DELETE_VAN.tools][lang].includes('{names}'), `${lang} تُسقط الأدوات`);
  }
  const note = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'RepVanStockNote.tsx'), 'utf8');
  assert.match(note, /vanStockApi\.tools\(repId\)/, 'العهدة لا تُقرأ قبل الحذف');
  assert.match(note, /vanIsEmpty\(left, tools\)/);
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

test('شركة النظام المحاسبي مطفأ لها لا ترى سطر المستودع في حوار الحذف', () => {
  const note = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'RepVanStockNote.tsx'), 'utf8');
  assert.match(note, /if \(ready && !on\) return null;/, 'سطر «رصيد المستودع لا يتغير» يظهر لشركة لا مستودع لها');
});
