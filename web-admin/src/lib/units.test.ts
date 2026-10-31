import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatQty, refundAmount, toBase, baseQtyOf, primaryUnitOf, productQtyText, primaryPriceOf, derivedBasePrice, baseNameKey } from './units';
import { roundHalfUp } from './money';

/**
 * نسخة الواجهة من قلب الحساب يجب أن تطابق نسخة الخادم حرفياً (بعد الترويسة).
 * تطبيق المندوب يطبع الفاتورة أوف‑لاين بهذه النسخة، والخادم يكتب السجلّ بتلك —
 * فاختلافهما يعني ورقةً في يد العميل تخالف ما في الدفاتر.
 */
test('حارس ثابت: lib/units.ts نسخة حرفية من backend/src/services/units.ts', () => {
  const body = (p: string) => {
    const s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    // الجسم بعد سطر «قلب الحساب» — الترويسة وحدها تختلف
    return s.slice(s.indexOf('/** الدقّة المخزَّنة'));
  };
  const web = body(path.join(process.cwd(), 'src', 'lib', 'units.ts'));
  const api = body(path.join(process.cwd(), '..', 'backend', 'src', 'services', 'units.ts'));
  assert.ok(web.length > 1000, 'لم يُعثر على جسم الملف');
  assert.equal(web, api, 'نسختا قلب الحساب افترقتا — انقل التعديل إلى الطرف الآخر');
});

test('الواجهة: العرض والتحويل والمرتجع كالخادم', () => {
  assert.equal(formatQty(51, [{ name: 'كرتون', factor: 24 }], 'حبة'), '2 كرتون و3 حبة');
  assert.equal(toBase(2, { unitFactor: 24 }), 48);
  assert.equal(baseQtyOf({ qty: 5, baseQty: null }), 5);
  let paid = 0;
  for (let i = 0; i < 24; i++) paid += refundAmount({ lineTotal: 10, qty: 1, unitFactor: 24 }, 1, i);
  assert.equal(Math.round(paid * 100) / 100, 10);
});

test('الواجهة: «الوحدة الرئيسية» كالخادم — العرض يقف عندها، والتالف null، والسعر المشتقّ = roundHalfUp في lib/money.ts', () => {
  const ctn = { id: 'u-ctn', name: 'كرتون', factor: 24, price: 48, isActive: true };
  const pal = { id: 'u-pal', name: 'طبلية', factor: 1200, price: null, isActive: true };
  const p = { unit: 'قارورة', basePrice: 2, units: [ctn, pal], primaryUnitId: 'u-ctn' };
  assert.equal(productQtyText(1250, p), '52 كرتون و2 قارورة');
  assert.equal(productQtyText(0, p), '0 كرتون');
  assert.equal(productQtyText(5, p), '5 قارورة');
  assert.equal(productQtyText(1250, { ...p, primaryUnitId: null }), formatQty(1250, [ctn, pal], 'قارورة'));
  assert.equal(formatQty(1250, [ctn, pal], 'قارورة', null), '1 طبلية و50 قارورة');
  assert.equal(primaryUnitOf({ ...p, primaryUnitId: 'u-gone' }), null);
  assert.equal(primaryUnitOf({ ...p, units: [{ ...ctn, isActive: false }] }), null);
  assert.equal(primaryPriceOf(p), 48);
  assert.equal(primaryPriceOf({ ...p, primaryUnitId: null }), null);
  assert.equal(derivedBasePrice(16.33, 8), 2.0413);
  for (const [price, f] of [[50, 24], [48, 24], [16.33, 8], [16.83, 8], [17.33, 8], [99.99, 7], [0.01, 3]]) {
    assert.equal(derivedBasePrice(price, f), roundHalfUp(price / f, 4), `${price} ÷ ${f}`);
  }
  assert.equal(baseNameKey(`  ${'ح'.repeat(70)} `), 'ح'.repeat(64));
  assert.equal(baseNameKey(null), '');
});
