// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — نسخة الويب من lib/taxMode.ts مطابقة حرفاً لنسخة الخادم، والقواعد الصرفة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveTaxPct, isDocTaxFree, isTaxOff, TAX_MODE_MESSAGES } from './taxMode';

const here = path.dirname(fileURLToPath(import.meta.url));
const norm = (f: string) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

test('lib/taxMode.ts نسخة حرفية من backend/src/services/taxMode.ts', () => {
  assert.equal(norm(path.join(here, 'taxMode.ts')), norm(path.join(here, '..', '..', '..', 'backend', 'src', 'services', 'taxMode.ts')));
});

test('الوضع: صريحٌ true وحده، والنسبة الفعلية صفر حينها، والمستند بختمه وحده', () => {
  assert.equal(isTaxOff({ taxDisabled: true }), true);
  for (const c of [null, undefined, {}, { taxDisabled: false }, { taxDisabled: null }]) assert.equal(isTaxOff(c as never), false);
  assert.equal(effectiveTaxPct({ taxDisabled: true }, 15), 0);
  assert.equal(effectiveTaxPct({}, 15), 15);
  assert.equal(effectiveTaxPct(null, '5'), 5);
  assert.equal(effectiveTaxPct(null, 'x'), 0);
  assert.equal(isDocTaxFree({ taxFree: true }), true);
  assert.equal(isDocTaxFree({}), false);
  assert.equal(isDocTaxFree(null), false);
});

// E2: رسالة 409 TAX_MODE_CHANGED تظهر لشركةٍ أزالت ضريبتها (وللتي أعادتها) — محايدة بلا أي ذكرٍ للضريبة
test('رسالة TAX_MODE_CHANGED محايدة: «تغيرت إعدادات الشركة…» بلا ذكرٍ للضريبة في الاتجاهين', () => {
  assert.equal(TAX_MODE_MESSAGES.TAX_MODE_CHANGED, 'تغيرت إعدادات الشركة حدث الصفحة ثم أعد الإصدار');
  assert.doesNotMatch(TAX_MODE_MESSAGES.TAX_MODE_CHANGED, /ضريب|ض\.ق\.م|VAT|tax|أزيلت/i);
});
