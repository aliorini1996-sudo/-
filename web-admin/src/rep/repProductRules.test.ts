// «قيود المندوب» على الصنف في تطبيق المندوب — يطابق حكم الخادم (backend services/repProductRules.ts)، والخادم المرجع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repAllows, repBlockKey, repDefaultChoice, repLineBlockKey, repUnitChoices, repUnitRuleOf } from './repProductRules';
import { returnUnitChoices } from '../lib/returnInvoice';

const water = { unit: 'حبة', units: [{ id: 'u-6', name: 'علبة', factor: 6, isActive: true }, { id: 'u-24', name: 'كرتون', factor: 24, isActive: true }] };

test('بلا قيد (وكاشٌ قبل الميزة): كل الوحدات والافتراضي الأكبر كما كان', () => {
  assert.equal(repAllows(water, 'SALE'), true);
  assert.equal(repUnitRuleOf(water, 'RETURN'), 'ANY');
  assert.deepEqual(repUnitChoices(water, 'SALE').map((c) => c.name), ['حبة', 'علبة', 'كرتون']);
  assert.equal(repDefaultChoice(water, 'SALE')!.name, 'كرتون');
  assert.equal(repBlockKey(water, 'SALE'), null);
});

test('الصغرى فقط والكبرى فقط: الوحدات المعروضة والافتراضي بين المسموح', () => {
  const p = { ...water, repSaleUnit: 'LARGE', repReturnUnit: 'BASE' };
  assert.deepEqual(repUnitChoices(p, 'SALE').map((c) => c.name), ['علبة', 'كرتون']);
  assert.equal(repDefaultChoice(p, 'SALE')!.name, 'كرتون');
  assert.deepEqual(repUnitChoices(p, 'RETURN').map((c) => c.name), ['حبة']);
  assert.equal(repDefaultChoice(p, 'RETURN')!.name, 'حبة');
  assert.equal(repLineBlockKey(p, 'SALE', 1), 'يباع من المندوب بالوحدة الكبرى فقط');
  assert.equal(repLineBlockKey(p, 'RETURN', 24), 'يرجع من المندوب بالوحدة الصغرى فقط');
  assert.equal(repLineBlockKey(p, 'SALE', 24), null);
});

test('المنع الكامل، و«الكبرى فقط» بلا وحدة كبرى نشطة', () => {
  assert.equal(repBlockKey({ ...water, repSaleAllowed: false }, 'SALE'), 'هذا الصنف لا يبيعه المندوب');
  assert.equal(repBlockKey({ ...water, repSaleAllowed: false }, 'RETURN'), null);
  assert.equal(repBlockKey({ ...water, repReturnAllowed: false }, 'RETURN'), 'هذا الصنف لا يرجعه المندوب');
  const noBig = { unit: 'حبة', units: [{ id: 'u-24', name: 'كرتون', factor: 24, isActive: false }], repSaleUnit: 'LARGE' };
  assert.equal(repBlockKey(noBig, 'SALE'), 'لا وحدة مسموحة للمندوب في هذا الصنف');
  assert.equal(repDefaultChoice(noBig, 'SALE'), null);
});

test('المرتجع من فاتورة بيع: قيد الخادم للمندوب يقصر وحدات الإرجاع، وغيابه (الإدارة) كما كان، ولا منتقٍ فارغ', () => {
  const line = { baseUnit: 'حبة', units: water.units, saleUnitFactor: 24 };
  assert.deepEqual(returnUnitChoices(line).map((c) => c.name), ['حبة', 'علبة', 'كرتون']);
  assert.deepEqual(returnUnitChoices({ ...line, repReturnUnit: 'BASE' }).map((c) => c.name), ['حبة']);
  assert.deepEqual(returnUnitChoices({ ...line, repReturnUnit: 'LARGE' }).map((c) => c.name), ['علبة', 'كرتون']);
  // بيع بالحبة و«الكبرى فقط»: الخادم يحجب البند (returnBlocked)، والمنتقي لا يفرغ
  assert.deepEqual(returnUnitChoices({ ...line, saleUnitFactor: 1, repReturnUnit: 'LARGE' }).map((c) => c.name), ['حبة']);
});
