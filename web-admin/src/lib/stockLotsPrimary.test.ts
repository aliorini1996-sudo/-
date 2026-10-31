import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lotRowEquivalent, lotSmallUnitOf } from './stockLots';
import { PHRASES } from '../i18n/strings';

// ux-8 (D21 وR8، ومراجعة B5b ٣): محرّر توزيع التشغيلات في مخزون السيارات — الكميات بالقارورة دائماً (D22)، فلصنفٍ رئيسيّه كرتون
// يُلصق اسم القارورة بالخانة بخطٍّ بارز ويظهر معادلها الحيّ تحتها، ورسالة المجموع ووسم الخانة بلا «الأساس». وبلا رئيسية كما كان.
const units = [{ id: 'u-c', name: 'كرتون', factor: 24, isActive: true }, { id: 'u-p', name: 'طبلية', factor: 1200, isActive: true }];
const bottleP = { unit: 'قارورة', units, primaryUnitId: 'u-c' };
const bottle = { unit: 'قارورة', units };
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');

test('lotSmallUnitOf: اسم الوحدة الصغرى لصنفٍ له رئيسية صالحة وحده، وnull لغيره (النصوص القائمة حرفاً)', () => {
  assert.equal(lotSmallUnitOf(bottleP), 'قارورة');
  assert.equal(lotSmallUnitOf(bottle), null);
  assert.equal(lotSmallUnitOf({ ...bottleP, primaryUnitId: 'غائب' }), null, 'معرّفٌ تالف ⇒ كأن لا رئيسية (I5)');
  assert.equal(lotSmallUnitOf({ ...bottleP, units: [{ ...units[0], isActive: false }] }), null, 'رئيسية موقوفة');
  assert.equal(lotSmallUnitOf(null), null);
  assert.equal(lotSmallUnitOf(undefined), null);
});

test('lotRowEquivalent: «= 2 كرتون و3 قارورة» تحت صفّ التشغيلة، ولا شيء بلا رئيسية أو لكميةٍ غير صالحة', () => {
  assert.equal(lotRowEquivalent('51', bottleP), '= 2 كرتون و3 قارورة');
  assert.equal(lotRowEquivalent(1250, bottleP), '= 52 كرتون و2 قارورة', 'يقف عند الرئيسية لا الطبلية (D4)');
  assert.equal(lotRowEquivalent('5', bottleP), '= 5 قارورة');
  for (const bad of ['', '0', '-3', 'x', null, undefined]) assert.equal(lotRowEquivalent(bad, bottleP), null, String(bad));
  assert.equal(lotRowEquivalent('51', bottle), null, 'I1');
});

test('LotRowsEditor ورسالة المجموع: بالوحدة الصغرى لصنفٍ له رئيسية، والنصّ القائم بلاها — ونافذتا التحميل والإزالة تمرّران الصنف', () => {
  const s = read('components', 'StockLotFields.tsx');
  assert.match(s, /export function draftProblemText\(p: DraftProblem \| null, tr: Tr, prod\?: LotUnitProd \| null\)/);
  assert.match(s, /if \(small\) return tr\('مجموع كميات التشغيلات يجب أن يساوي كمية السطر بـ\{unit\}'\)/);
  assert.match(s, /return tr\('مجموع كميات التشغيلات يجب أن يساوي كمية السطر بوحدة الأساس'\);/, 'I1');
  assert.match(s, /aria-label=\{small \? tr\('الكمية بـ\{unit\}'\)\.split\('\{unit\}'\)\.join\(small\) : tr\('الكمية بوحدة الأساس'\)\}/);
  assert.match(s, /\{small && <b className="[^"]*">\{small\}<\/b>\}/, 'اسم الوحدة لاصقٌ بارز (R8)');
  assert.match(s, /const eq = lotRowEquivalent\(r\.qty, prod\);/);
  assert.match(s, /draftProblemText\(problem, tr, prod\)/);
  const v = read('pages', 'VanStockPage.tsx');
  assert.equal((v.match(/<LotRowsEditor [^\n]*prod=\{prod\} \/>/g) || []).length, 2, 'نافذة التحميل');
  assert.match(v, /<LotRowsEditor rows=\{draft \?\? \[\]\} [^\n]*prod=\{row\}/, 'إزالة المنتهي والتالف');
  assert.equal((v.match(/draftProblemText\([^\n]*, tr, productOf\(r\.productId\)\)/g) || []).length, 2);
  for (const k of ['مجموع كميات التشغيلات يجب أن يساوي كمية السطر بـ{unit}', 'الكمية بـ{unit}']) {
    assert.ok(!k.includes('الأساس'), 'D21');
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES[k]?.[lang]?.includes('{unit}'), `${lang}: ${k}`);
  }
});
