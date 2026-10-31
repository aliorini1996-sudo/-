import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeUnitParams } from './unitParams';

// «الوحدة الرئيسية» §4.2: حذف الوحدة يحمل expectedBaseName كبقية كتابات الوحدات — والخادم يقرؤه من الاستعلام
// (products.ts DELETE: assertExpectedBase … req.query.expectedBaseName) فنموذجٌ فُتح قبل «إضافة وحدة فرعية أصغر» يُردّ 409
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');

test('removeUnitParams: clearPrimary وexpectedBaseName في الاستعلام، وبلا خيار ⇒ undefined (الطلب كما كان)', () => {
  assert.equal(removeUnitParams(), undefined);
  assert.equal(removeUnitParams({}), undefined);
  assert.equal(removeUnitParams({ expectedBaseName: '' }), undefined, 'اسمٌ فارغ لا يُرسل');
  assert.deepEqual(removeUnitParams({ clearPrimary: true }), { clearPrimary: 1 });
  assert.deepEqual(removeUnitParams({ expectedBaseName: 'قارورة' }), { expectedBaseName: 'قارورة' });
  assert.deepEqual(removeUnitParams({ clearPrimary: true, expectedBaseName: 'قارورة' }), { clearPrimary: 1, expectedBaseName: 'قارورة' });
  assert.deepEqual(removeUnitParams({ clearPrimary: false, expectedBaseName: 'حبة' }), { expectedBaseName: 'حبة' });
});

test('removeUnit يمرّ من removeUnitParams، ونافذة الصنف و/m يرسلان الأساس الذي رآه النموذج', () => {
  const client = read('api', 'client.ts');
  assert.match(client, /removeUnit: \(id: string, unitId: string, opts\?: \{ clearPrimary\?: boolean; expectedBaseName\?: string \}\) =>\s*api\.delete\(`\/products\/\$\{id\}\/units\/\$\{unitId\}`, \{ params: removeUnitParams\(opts\) \}\)/);
  const modal = read('components', 'forms', 'ProductModal.tsx');
  assert.match(modal, /productApi\.removeUnit\(productId, u\.id, \{ clearPrimary: true, expectedBaseName: baseUnit \}\)/);
  assert.match(modal, /productApi\.removeUnit\(productId, u\.id, \{ expectedBaseName: baseUnit \}\)/);
  assert.doesNotMatch(modal, /productApi\.removeUnit\(productId, u\.id\)/, 'لا حذف بلا الأساس المتوقَّع');
  const m = read('m', 'MProducts.tsx');
  assert.match(m, /productApi\.removeUnit\(product\.id, u\.id, \{ \.\.\.\(u\.id === p\.primaryUnitId && \{ clearPrimary: true \}\), expectedBaseName: p\.unit \}\)/);
});
