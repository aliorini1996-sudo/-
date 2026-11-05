// «قوائم الأسعار» بقواعدها (طلب المالك ٥ نوفمبر ٢٠٢٦) — نسخة الويب من الحلّ مطابقة حرفاً لنسخة الخادم، وطبقة تسعير البند
// في الأجهزة (lib/priceListPricing.ts) تطابق حساب الخادم: سعر العميل يغلب، ثم القائمة بكمية الصنف كلّه ويومه، ثم سلّم اليوم.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseQtyByProduct, lineNetWithList, listDependsOnQty, pricingDayOf, ruleProductOf } from './priceListPricing';
import type { PriceRuleRow } from './priceRules';

const here = path.dirname(fileURLToPath(import.meta.url));
const norm = (f: string) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

test('lib/priceRules.ts نسخة حرفية من backend/src/services/priceRules.ts', () => {
  assert.equal(norm(path.join(here, 'priceRules.ts')), norm(path.join(here, '..', '..', '..', 'backend', 'src', 'services', 'priceRules.ts')));
});

const CARTON = { id: 'u-c', name: 'كرتون', factor: 24, price: null };
const BASE = { id: null, name: 'حبة', factor: 1, price: null };
const P = { id: 'p1', basePrice: 0.5, categoryId: 'c1', primaryUnitId: 'u-c', units: [{ id: 'u-c', name: 'كرتون', factor: 24, price: null, isActive: true }] };
const DAY = '2026-11-05';

test('ruleProductOf: الفئة ومعامل الرئيسية (1 بلاها)', () => {
  assert.deepEqual(ruleProductOf(P), { id: 'p1', categoryId: 'c1', primaryFactor: 24 });
  assert.deepEqual(ruleProductOf({ id: 'p2', basePrice: 1 }), { id: 'p2', categoryId: null, primaryFactor: 1 });
});

test('lineNetWithList: سعر العميل يغلب، ثم سعر القائمة الثابت، ثم القاعدة، ثم سلّم اليوم', () => {
  const pct: PriceRuleRow[] = [{ id: 'r', scope: 'category', categoryId: 'c1', kind: 'percent', percent: 10, minQty: 0 }];
  assert.equal(lineNetWithList(CARTON, P, 0.4, 0.45, pct, 24, DAY), 0.4 * 24, 'العميل');
  assert.equal(lineNetWithList(CARTON, P, null, 0.45, pct, 24, DAY), 0.45 * 24, 'الثابت يغلب الفئة');
  assert.equal(lineNetWithList(CARTON, P, null, null, pct, 24, DAY), 12 * 0.9, 'خصم الفئة من ١٢');
  assert.equal(lineNetWithList(BASE, P, null, null, pct, 1, DAY), 0.45);
  assert.equal(lineNetWithList(CARTON, P, null, null, [], 24, DAY), 12, 'بلا قائمة');
});

test('الحدّ الأدنى بكمية الصنف كلّه بالرئيسية', () => {
  const q: PriceRuleRow[] = [{ id: 'q', scope: 'product', productId: 'p1', kind: 'fixed', basePrice: 0.4, minQty: 10 }];
  const by = baseQtyByProduct([{ productId: 'p1', qty: 9, factor: 24 }, { productId: 'p1', qty: 24, factor: 1 }, { productId: 'p2', qty: 3 }]);
  assert.equal(by.get('p1'), 240);
  assert.equal(by.get('p2'), 3);
  assert.equal(lineNetWithList(CARTON, P, null, null, q, by.get('p1') as number, DAY), 0.4 * 24);
  assert.equal(lineNetWithList(CARTON, P, null, null, q, 216, DAY), 12, 'تسعة كراتين لا تكفي');
  assert.equal(listDependsOnQty(q), true);
});

test('pricingDayOf: التاريخ المختار وإلا اليوم المحلي', () => {
  assert.equal(pricingDayOf('2026-11-01T10:00'), '2026-11-01');
  assert.equal(pricingDayOf(null, new Date(2026, 10, 5, 23, 59)), '2026-11-05');
});
