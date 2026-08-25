import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERRIDE_CURRENCIES, currencyDecimalsOf, getCountryTax } from '../config/countries';

/**
 * حرّاس تجاوز العملة (دولار/يورو):
 * القائمة موثوقة ومغلقة، والخانات تُشتق من العملة الفعلية لا الدولة —
 * شركة كويتية (3 خانات) بعملة دولار تُفوتر بخانتين.
 */

test('قائمة التجاوز مغلقة على الدولار واليورو فقط', () => {
  assert.deepEqual(Object.keys(OVERRIDE_CURRENCIES).sort(), ['EUR', 'USD']);
  assert.equal(OVERRIDE_CURRENCIES.USD.currencyDecimals, 2);
  assert.equal(OVERRIDE_CURRENCIES.EUR.currencyDecimals, 2);
});

test('currencyDecimalsOf: الدولار واليورو بخانتين ولو كانت الدولة ثلاثية', () => {
  assert.equal(currencyDecimalsOf('USD'), 2);
  assert.equal(currencyDecimalsOf('EUR'), 2);
  // دولة كويتية بلا تجاوز تبقى ثلاثية
  assert.equal(currencyDecimalsOf(getCountryTax('KW').currency), 3);
});

test('currencyDecimalsOf: يطابق خانات سجل الدول لكل عملات الدول', () => {
  for (const c of ['SA', 'EG', 'KW', 'BH', 'OM', 'TN', 'JO', 'IQ', 'LB', 'TR']) {
    const ct = getCountryTax(c);
    assert.equal(currencyDecimalsOf(ct.currency), ct.currencyDecimals, `تعارض خانات ${c}/${ct.currency}`);
  }
});

test('currencyDecimalsOf: مجهولة او فارغة = خانتان (الافتراضي الامن)', () => {
  assert.equal(currencyDecimalsOf(null), 2);
  assert.equal(currencyDecimalsOf('XYZ'), 2);
});
