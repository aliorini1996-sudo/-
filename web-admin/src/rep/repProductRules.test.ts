// «قيود المندوب» على الصنف في تطبيق المندوب — يطابق حكم الخادم (backend services/repProductRules.ts)، والخادم المرجع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repAllows, repBlockKey, repDefaultChoice, repLineBlockKey, repUnitChoices, repUnitRuleOf } from './repProductRules';
import { fillLinkedQty, refreshLinkedLine, returnUnitChoices, toLinkedSale } from '../lib/returnInvoice';

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

// بند بيع: ٢ كرتون (٢٤ حبة) أُرجعت منه حبّة، فالمتاح ٢٣ حبة — والمندوب يرى قيد «الكبرى فقط» من /returnable
const saleDto = (repReturnUnit?: string) => ({
  id: 's1', number: 'S-1', lines: [{
    saleItemId: 'si', productId: 'p1', name: 'ماء', unit: 'حبة', sold: 24, returned: 1, returnable: 23, refundUnitPrice: 1,
    qty: 2, unitName: 'كرتون', unitFactor: 12, soldBase: 24, returnedBase: 1, returnableBase: 23, lineTotal: 24, refundPerBase: 1,
    product: { unit: 'حبة', units: [{ id: 'u-12', name: 'كرتون', factor: 12, isActive: true }], ...(repReturnUnit ? { repReturnUnit } : {}) },
    taxPct: 15,
  }],
});

test('«إرجاع كامل المتاح» تحت «الكبرى فقط»: كراتين كاملة لا كسر يرفضه الخادم — وبلا قيد كما كان (بالأساس)', () => {
  const free = fillLinkedQty(toLinkedSale(saleDto()).lines, true)[0];
  assert.deepEqual([free.qty, free.retUnitId], [23, null], 'بلا قيد: ٢٣ حبة كما قبل الميزة');
  const large = fillLinkedQty(toLinkedSale(saleDto('LARGE')).lines, true)[0];
  assert.deepEqual([large.qty, large.retUnitId], [1, 'u-12'], 'كرتونٌ كامل واحد لا ١٫٩١٧');
});

test('إعادة التحميل بعد قيدٍ جديد «الكبرى فقط»: «٣ حبات» لا تصير «٣ كراتين» صامتةً', () => {
  const before = toLinkedSale(saleDto()).lines[0];
  const typed = { ...before, retUnitId: null, retUnitName: null, retUnitFactor: 1, qty: 3 };
  const after = refreshLinkedLine(typed, toLinkedSale(saleDto('LARGE')).lines[0]);
  assert.equal(after.retUnitId, 'u-12');
  assert.equal(after.qty, 0, '٣ حبات أقل من كرتون: لا شيء بالكبرى (لا ٣٦ حبة)');
});
