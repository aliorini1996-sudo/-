// «تتبّع اللوط» — البوابة E (البند ١٦): تنزيل تشغيلةٍ موقوفة لصنفٍ أُطفئ تتبّعه يمرّ في الخادم بالمسار القديم
// (UNLOAD بلا صفوف لوط ولا فحص رصيد) فيُنقص السيارة ويبقى رصيد التشغيلة كما هو، ويتكرّر بلا نهاية.
// فالشاشتان (pages/LotsPage.tsx وm/MLots.tsx) لا تجلبان خطة التنزيل ولا ترسمان زرّها إلا لصنفٍ متتبَّع،
// وجسم التنزيل نفسه لا يُبنى لصنفٍ غير متتبَّع (حارسٌ ثانٍ لبطاقةٍ قديمة في الذاكرة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lotUnloadOn, unloadBody } from './lotsPage';
import type { BucketQty } from './lots';

const B = (SELLABLE = 0, EXPIRED = 0, DAMAGED = 0): BucketQty => ({ SELLABLE, EXPIRED, DAMAGED });
const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
const lotOf = (status: 'ACTIVE' | 'BLOCKED', lotTracked: boolean) => ({ status, product: { lotTracked } });

test('lotUnloadOn: خطة التنزيل للموقوفة من صنفٍ متتبَّع وحده', () => {
  assert.equal(lotUnloadOn(lotOf('BLOCKED', true)), true);
  assert.equal(lotUnloadOn(lotOf('BLOCKED', false)), false, 'التتبّع مطفأ: التشغيلة للسجل وحده');
  assert.equal(lotUnloadOn(lotOf('ACTIVE', true)), false);
  assert.equal(lotUnloadOn(null), false);
  assert.equal(lotUnloadOn(undefined), false);
});

test('unloadBody: لا جسم لتشغيلةٍ صنفها غير متتبَّع — والمتتبَّع كما كان', () => {
  const row = { salesRepId: 'r1', repName: 'أحمد', deleted: false, usable: B(10), held: B() };
  assert.equal(unloadBody({ id: 'L', productId: 'P', product: { lotTracked: false } }, row, 'x'), null);
  const ok = unloadBody({ id: 'L', productId: 'P', product: { lotTracked: true } }, row, 'x');
  assert.deepEqual(ok?.items, [{ productId: 'P', qty: 10, lots: [{ lotId: 'L', qty: 10 }] }]);
});

test('الشاشتان: الخطة وزرّ التنزيل وتأكيده خلف lotUnloadOn لا خلف «موقوفة» وحدها', () => {
  for (const [name, s] of [['LotsPage.tsx', src('pages', 'LotsPage.tsx')], ['MLots.tsx', src('m', 'MLots.tsx')]] as const) {
    assert.match(s, /const unloadOn = lotUnloadOn\(lot\);/, `${name}: lotUnloadOn مفقود`);
    assert.match(s, /enabled: unloadOn,/, `${name}: الخطة تُجلب لصنفٍ غير متتبَّع`);
    assert.match(s, /\{unloadOn && \(/, `${name}: قسم التنزيل يُرسم لصنفٍ غير متتبَّع`);
    assert.match(s, /\{unloadOn && unloadRow && /, `${name}: تأكيد التنزيل يبقى مفتوحاً بعد إطفاء التتبّع`);
    assert.ok(!/enabled: blocked,/.test(s), `${name}: الخطة ما زالت خلف «موقوفة» وحدها`);
  }
});
