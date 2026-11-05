// قواعد قوائم الأسعار (طلب المالك ٥ نوفمبر ٢٠٢٦) — الحلّ النقيّ services/priceRules.ts ونسخة الويب المطابقة حرفاً.
// يثبت: الانطباق (صنف/فئة/الكل، الحدّ الأدنى بالرئيسية، الفترة شاملة الطرفين)، والأولوية (الأخصّ ثم الأعلى حدّاً ثم المؤقّتة
// ثم القاعدة قبل سعر الصنف الثابت ثم الأحدث)، والوحدات (الأساس للصنف، والرئيسية للفئة، والنسبة من سعر البند بلا قائمة)،
// وأنّ قائمةً بلا قواعد = سلوك اليوم حرفياً، وأنّ الصفّ التالف يُتجاهل، ورسائل الرفض.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRICE_RULE_MESSAGES, comparePriceRules, isPriceRuleDay, listLineRef, listPerBaseHint, listPriceOf, pickPriceRule,
  priceRuleMatches, priceRuleProblem, qtyPrimaryOf, roundPriceRule, rulesDependOnQty, type PriceRuleRow,
} from '../services/priceRules';

const P = { id: 'p1', categoryId: 'c1', primaryFactor: 24 };
const DAY = '2026-11-05';
const rule = (o: Partial<PriceRuleRow> & { id: string }): PriceRuleRow => ({ scope: 'product', productId: 'p1', kind: 'percent', percent: 10, minQty: 0, ...o });

test('نسخة الويب مطابقة حرفاً لنسخة الخادم (الملف كلّه)', () => {
  const here = path.resolve(__dirname, '..', 'services', 'priceRules.ts');
  const web = path.resolve(__dirname, '..', '..', '..', 'web-admin', 'src', 'lib', 'priceRules.ts');
  const norm = (f: string) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  assert.equal(norm(web), norm(here));
});

test('اليوم: تقويميٌّ صحيح فقط', () => {
  for (const ok of ['2026-11-05', '2028-02-29', '2026-12-31']) assert.ok(isPriceRuleDay(ok), ok);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-1-5', '', null, 20261105, '2026-11-05T00:00']) assert.ok(!isPriceRuleDay(bad), String(bad));
});

test('بلا قواعد: سلوك اليوم حرفياً — سعر الصنف الثابت أو null', () => {
  assert.deepEqual(listPriceOf(0.5, [], P, 1, DAY), { kind: 'base', perBase: 0.5, ruleId: null });
  assert.deepEqual(listPriceOf(0.5, null, P, 1, DAY), { kind: 'base', perBase: 0.5, ruleId: null });
  assert.equal(listPriceOf(null, [], P, 1, DAY), null);
  assert.equal(listPriceOf(undefined, undefined, P, 1, DAY), null);
  assert.deepEqual(listPriceOf(0, [], P, 1, DAY), { kind: 'base', perBase: 0, ruleId: null }, 'الصفر سعر');
});

test('الانطباق: النطاق والحدّ الأدنى بالرئيسية والفترة شاملة الطرفين', () => {
  assert.ok(priceRuleMatches(rule({ id: 'a' }), P, 0, DAY));
  assert.ok(!priceRuleMatches(rule({ id: 'a', productId: 'p2' }), P, 0, DAY));
  assert.ok(priceRuleMatches(rule({ id: 'a', scope: 'category', productId: null, categoryId: 'c1' }), P, 0, DAY));
  assert.ok(!priceRuleMatches(rule({ id: 'a', scope: 'category', productId: null, categoryId: 'c2' }), P, 0, DAY));
  assert.ok(!priceRuleMatches(rule({ id: 'a', scope: 'category', productId: null, categoryId: 'c1' }), { id: 'p1', primaryFactor: 1 }, 0, DAY), 'صنف بلا فئة');
  assert.ok(priceRuleMatches(rule({ id: 'a', scope: 'all', productId: null }), P, 0, DAY));
  // الحدّ الأدنى: ١٠ كراتين = ٢٤٠ حبة
  const q10 = rule({ id: 'a', minQty: 10 });
  assert.ok(!priceRuleMatches(q10, P, qtyPrimaryOf(239, P), DAY));
  assert.ok(priceRuleMatches(q10, P, qtyPrimaryOf(240, P), DAY));
  assert.equal(qtyPrimaryOf(48, { id: 'x' }), 48, 'بلا رئيسية = الأساس');
  // الفترة
  const w = rule({ id: 'a', startsOn: '2026-11-01', endsOn: '2026-11-05' });
  assert.ok(priceRuleMatches(w, P, 0, '2026-11-01'));
  assert.ok(priceRuleMatches(w, P, 0, '2026-11-05'));
  assert.ok(!priceRuleMatches(w, P, 0, '2026-10-31'));
  assert.ok(!priceRuleMatches(w, P, 0, '2026-11-06'));
  assert.ok(priceRuleMatches(rule({ id: 'a', startsOn: '2026-11-01' }), P, 0, '2030-01-01'), 'بلا نهاية');
  assert.ok(priceRuleMatches(rule({ id: 'a', endsOn: '2026-11-05' }), P, 0, '2020-01-01'), 'بلا بداية');
});

test('الصفّ التالف يُتجاهل: ثابتٌ لكل الأصناف، أو سعر سالب، أو يوم فاسد، أو نطاق مجهول', () => {
  for (const bad of [
    rule({ id: 'a', scope: 'all', productId: null, kind: 'fixed', basePrice: 1 }),
    rule({ id: 'a', kind: 'fixed', basePrice: -1 }),
    rule({ id: 'a', kind: 'fixed', basePrice: null }),
    rule({ id: 'a', kind: 'percent', percent: 101 }),
    rule({ id: 'a', startsOn: '2026-02-30' }),
    rule({ id: 'a', scope: 'brand' }),
    rule({ id: 'a', kind: 'formula' }),
    rule({ id: 'a', productId: null }),
    rule({ id: 'a', minQty: -1 }),
  ]) assert.ok(!priceRuleMatches(bad, P, 100, DAY), JSON.stringify(bad));
});

test('الأولوية: الأخصّ، ثم الأعلى حدّاً، ثم المؤقّتة، ثم القاعدة قبل سعر الصنف، ثم الأحدث، ثم المعرّف', () => {
  const all = rule({ id: 'all', scope: 'all', productId: null, percent: 50 });
  const cat = rule({ id: 'cat', scope: 'category', productId: null, categoryId: 'c1', percent: 40 });
  const prod = rule({ id: 'prod', percent: 5 });
  assert.equal(pickPriceRule([all, cat, prod], P, 0, DAY)?.id, 'prod', 'الصنف يغلب ولو كانت نسبته أقل');
  assert.equal(pickPriceRule([all, cat], P, 0, DAY)?.id, 'cat');
  const q1 = rule({ id: 'q1', minQty: 1 });
  const q10 = rule({ id: 'q10', minQty: 10 });
  assert.equal(pickPriceRule([q1, q10], P, 12, DAY)?.id, 'q10');
  assert.equal(pickPriceRule([q1, q10], P, 9, DAY)?.id, 'q1');
  assert.equal(pickPriceRule([q1, q10], P, 0.5, DAY), null);
  const promo = rule({ id: 'promo', startsOn: '2026-11-01', endsOn: '2026-11-30' });
  const plain = rule({ id: 'plain' });
  assert.equal(pickPriceRule([plain, promo], P, 0, DAY)?.id, 'promo');
  assert.equal(pickPriceRule([plain, promo], P, 0, '2026-12-01')?.id, 'plain', 'انتهى العرض');
  const older = rule({ id: 'z-old', updatedAt: '2026-11-01T00:00:00Z' });
  const newer = rule({ id: 'a-new', updatedAt: '2026-11-04T00:00:00Z' });
  assert.equal(pickPriceRule([older, newer], P, 0, DAY)?.id, 'a-new');
  assert.equal(pickPriceRule([rule({ id: 'b' }), rule({ id: 'a' })], P, 0, DAY)?.id, 'a', 'ثابت بالمعرّف');
  assert.ok(comparePriceRules(prod, all) < 0 && comparePriceRules(all, prod) > 0);
});

test('سعر الصنف الثابت في القائمة: قاعدة صنفٍ مفتوحة بلا حدّ — تغلبه قاعدة الصنف المساوية والأعلى حدّاً، ويغلب الفئة والكل', () => {
  const cat = rule({ id: 'cat', scope: 'category', productId: null, categoryId: 'c1', percent: 40 });
  assert.deepEqual(listPriceOf(0.5, [cat], P, 1, DAY), { kind: 'base', perBase: 0.5, ruleId: null });
  assert.deepEqual(listPriceOf(0.5, [rule({ id: 'r' })], P, 1, DAY), { kind: 'percent', percent: 10, ruleId: 'r' });
  const q10 = rule({ id: 'q10', kind: 'fixed', basePrice: 0.4, minQty: 10 });
  assert.deepEqual(listPriceOf(0.5, [q10], P, 9, DAY), { kind: 'base', perBase: 0.5, ruleId: null });
  assert.deepEqual(listPriceOf(0.5, [q10], P, 10, DAY), { kind: 'base', perBase: 0.4, ruleId: 'q10' });
});

test('الوحدات: ثابت الصنف للأساس، وثابت الفئة للرئيسية ÷ معاملها بستّ منازل، والنسبة من سعر البند بلا قائمة', () => {
  const fixedP = listPriceOf(null, [rule({ id: 'f', kind: 'fixed', basePrice: 0.416667 })], P, 1, DAY);
  assert.deepEqual(fixedP, { kind: 'base', perBase: 0.416667, ruleId: 'f' });
  assert.equal(roundPriceRule(listLineRef(fixedP, 24, 999) as number, 2), 10, 'كرتون ٢٤ بسعر ١٠ يعود ١٠');
  const fixedC = listPriceOf(null, [rule({ id: 'c', scope: 'category', productId: null, categoryId: 'c1', kind: 'fixed', primaryPrice: 10 })], P, 1, DAY);
  assert.deepEqual(fixedC, { kind: 'base', perBase: 0.416667, ruleId: 'c' });
  assert.equal(roundPriceRule(listLineRef(fixedC, 24, 999) as number, 2), 10);
  assert.equal(roundPriceRule(listLineRef(fixedC, 1, 999) as number, 6), 0.416667, 'الحبة');
  // صنف بلا رئيسية: سعر الفئة هو سعر الأساس
  assert.deepEqual(listPriceOf(null, [rule({ id: 'c', scope: 'category', productId: null, categoryId: 'c1', kind: 'fixed', primaryPrice: 3 })], { id: 'p1', categoryId: 'c1' }, 1, DAY),
    { kind: 'base', perBase: 3, ruleId: 'c' });
  // النسبة: من سعر البند بلا قائمة (كرتونٌ سعره المحدَّد ٢٠٠ ⇒ خصم ١٠٪ = ١٨٠، لا من الأساس × ٢٤)
  const pct = listPriceOf(null, [rule({ id: 'p', percent: 10 })], P, 1, DAY);
  assert.equal(listLineRef(pct, 24, 200), 180);
  assert.equal(roundPriceRule(listLineRef(listPriceOf(null, [rule({ id: 'm', percent: -15 })], P, 1, DAY), 1, 10) as number, 2), 11.5, 'زيادة ١٥٪');
  assert.equal(listLineRef(null, 24, 200), null);
  assert.equal(listPerBaseHint(pct, 10), 9);
  assert.equal(listPerBaseHint(fixedP, 10), 0.416667);
});

test('rulesDependOnQty: قاعدةٌ بحدٍّ أدنى فقط', () => {
  assert.equal(rulesDependOnQty([rule({ id: 'a' })]), false);
  assert.equal(rulesDependOnQty([rule({ id: 'a', minQty: 5 })]), true);
  assert.equal(rulesDependOnQty(null), false);
});

test('رسائل الرفض: النطاق والصنف والفئة والنوع والسعر والنسبة والحدّ والتاريخ', () => {
  const ok = { scope: 'product', productId: 'p1', kind: 'fixed', price: 10 };
  assert.equal(priceRuleProblem(ok), null);
  assert.equal(priceRuleProblem({ ...ok, scope: 'x' }), PRICE_RULE_MESSAGES.scope);
  assert.equal(priceRuleProblem({ ...ok, productId: ' ' }), PRICE_RULE_MESSAGES.product);
  assert.equal(priceRuleProblem({ scope: 'category', kind: 'percent', percent: 5 }), PRICE_RULE_MESSAGES.category);
  assert.equal(priceRuleProblem({ ...ok, kind: 'formula' }), PRICE_RULE_MESSAGES.kind);
  assert.equal(priceRuleProblem({ scope: 'all', kind: 'fixed', price: 1 }), PRICE_RULE_MESSAGES.allFixed);
  assert.equal(priceRuleProblem({ ...ok, price: -1 }), PRICE_RULE_MESSAGES.price);
  assert.equal(priceRuleProblem({ ...ok, price: '' }), PRICE_RULE_MESSAGES.price);
  for (const pct of [0, 101, -501, 'x', null]) assert.equal(priceRuleProblem({ scope: 'all', kind: 'percent', percent: pct }), PRICE_RULE_MESSAGES.percent, String(pct));
  assert.equal(priceRuleProblem({ scope: 'all', kind: 'percent', percent: -20 }), null, 'زيادة');
  assert.equal(priceRuleProblem({ ...ok, minQty: -1 }), PRICE_RULE_MESSAGES.minQty);
  assert.equal(priceRuleProblem({ ...ok, minQty: '' }), null);
  assert.equal(priceRuleProblem({ ...ok, startsOn: '2026-02-30' }), PRICE_RULE_MESSAGES.day);
  assert.equal(priceRuleProblem({ ...ok, startsOn: '2026-11-10', endsOn: '2026-11-01' }), PRICE_RULE_MESSAGES.range);
  assert.equal(priceRuleProblem({ ...ok, startsOn: '2026-11-01', endsOn: '2026-11-01' }), null, 'يوم واحد');
  assert.equal(priceRuleProblem({ ...ok, startsOn: '', endsOn: '' }), null);
});
