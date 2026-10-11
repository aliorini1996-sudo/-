// صلاحية الصنف (services/shelfLife.ts) — تاريخ الانتهاء من تاريخ التوريد بالأيام أو الأشهر أو السنوات.
// صرفٌ بلا قاعدة، ومعه حارسٌ نصّي على مساري الصنف والوارد.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addShelfLife, expiryDateFor, localDateIn, shelfLifeOf, shelfLifeProblem } from '../services/shelfLife';

test('الأيام: تعبر الشهر والسنة', () => {
  assert.equal(addShelfLife('2026-10-11', 30, 'DAY'), '2026-11-10');
  assert.equal(addShelfLife('2026-12-25', 10, 'DAY'), '2027-01-04');
  assert.equal(addShelfLife('2028-02-28', 1, 'DAY'), '2028-02-29', 'سنة كبيسة');
});

test('الأشهر بالتقويم وتُقصّ إلى آخر الشهر', () => {
  assert.equal(addShelfLife('2026-10-11', 6, 'MONTH'), '2027-04-11');
  assert.equal(addShelfLife('2026-01-31', 1, 'MONTH'), '2026-02-28', '٣١ يناير + شهر = آخر فبراير لا ٣ مارس');
  assert.equal(addShelfLife('2027-12-31', 2, 'MONTH'), '2028-02-29');
  assert.equal(addShelfLife('2026-10-11', 18, 'MONTH'), '2028-04-11');
});

test('السنوات، و٢٩ فبراير + سنة = ٢٨ فبراير', () => {
  assert.equal(addShelfLife('2026-10-11', 2, 'YEAR'), '2028-10-11');
  assert.equal(addShelfLife('2028-02-29', 1, 'YEAR'), '2029-02-28');
  assert.equal(addShelfLife('2028-02-29', 4, 'YEAR'), '2032-02-29');
});

test('تاريخ التوريد بتوقيت الشركة لا UTC', () => {
  // ١:٣٠ فجر ١٢ أكتوبر بالرياض = ٢٢:٣٠ يوم ١١ بتوقيت UTC
  const at = new Date('2026-10-11T22:30:00Z');
  assert.equal(localDateIn(at, 'Asia/Riyadh'), '2026-10-12');
  const p = { shelfLifeEnabled: true, shelfLifeValue: 10, shelfLifeUnit: 'DAY' };
  assert.equal(expiryDateFor(p, at, 'Asia/Riyadh')?.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(expiryDateFor(p, at, 'Africa/Casablanca')?.toISOString(), '2026-10-21T00:00:00.000Z');
});

test('صنفٌ بلا صلاحية مفعّلة أو بإعداد ناقص: لا تاريخ', () => {
  const at = new Date('2026-10-11T08:00:00Z');
  assert.equal(expiryDateFor({ shelfLifeEnabled: false, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }, at, 'Asia/Riyadh'), null);
  assert.equal(expiryDateFor({ shelfLifeEnabled: true, shelfLifeValue: null, shelfLifeUnit: 'MONTH' }, at, 'Asia/Riyadh'), null);
  assert.equal(shelfLifeOf({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'WEEK' }), null);
  assert.deepEqual(shelfLifeOf({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'YEAR' }), { value: 3, unit: 'YEAR' });
});

test('التحقّق: المفعّلة تلزمها مدةٌ صحيحة ووحدة، والمطفأة تُقبل', () => {
  assert.equal(shelfLifeProblem({ shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null }), null);
  assert.equal(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 12, shelfLifeUnit: 'MONTH' }), null);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: null, shelfLifeUnit: 'MONTH' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 0, shelfLifeUnit: 'DAY' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 2.5, shelfLifeUnit: 'DAY' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 5, shelfLifeUnit: null })), /وحدة/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 101, shelfLifeUnit: 'YEAR' })), /أطول من المعقول/);
});

test('حارس نصّي: الصنف يتحقّق من الصلاحية مدمجةً بالمحفوظ، والوارد وحده يحفظ تاريخ الانتهاء', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const products = read('routes/products.ts');
  assert.equal(products.split('shelfLifeProblem(').length - 1, 2, 'الإنشاء والتعديل كلاهما يتحقّقان');
  assert.match(products, /data\.shelfLifeEnabled \?\? exists\.shelfLifeEnabled/, 'التعديل يدمج مع المحفوظ');
  const wh = read('routes/warehouse.ts');
  assert.match(wh, /data\.type === 'RECEIVE' && products\.some\(\(p\) => shelfLifeOf\(p\)\)/, 'التسوية لا تحمل صلاحية');
  assert.match(wh, /createdAt: suppliedAt/, 'تاريخ التوريد هو لحظة الوارد نفسها');
  assert.match(wh, /expiresAt: timeZone \? expiryDateFor\(/);
});
