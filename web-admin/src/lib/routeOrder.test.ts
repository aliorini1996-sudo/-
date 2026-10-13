import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderByDistance, haversineKm, pathKm } from './routeOrder';

/**
 * «ترتيب خط السير حسب المسافة» (طلب المالك، ١٣ أكتوبر ٢٠٢٦): العملاء متتابعين حسب مواقعهم —
 * بلا موقع المندوب ولا عميلٍ مثبَّت في البداية.
 */

// نقاط على خطّ شرق-غرب تقريباً: كل ٠٫٠١ درجة طول ≈ ١ كم
const P = (id: string, lngOff: number, latOff = 0) => ({ id, lat: 24.7 + latOff, lng: 46.6 + lngOff });
const ids = (r: { ordered: { id: string }[] }) => r.ordered.map(s => s.id);

test('haversine: درجة عرض ≈ ١١١ كم، والنقطة ونفسها صفر', () => {
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.1);
  assert.equal(haversineKm({ lat: 24.7, lng: 46.6 }, { lat: 24.7, lng: 46.6 }), 0);
});

test('العملاء متتابعون حسب مواقعهم — والأول في القائمة لا يُثبَّت بداية', () => {
  // «b» أول القائمة لكنه ليس طرف المجموعة: المسار يبدأ من الطرف الأقرب إليه (a) ويمضي متتابعاً
  const stops = [P('b', 0.02), P('e', 0.05), P('a', 0.01), P('d', 0.04), P('c', 0.03)];
  const r = orderByDistance(stops);
  assert.deepEqual(ids(r), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(Math.abs(r.afterKm - 4.04) < 0.1, String(r.afterKm));
  assert.ok(r.afterKm < r.beforeKm);
  assert.equal(r.changed, true);
});

test('الاتجاه يتبع أول القائمة: إن كان قرب الطرف الآخر بدأ المسار من هناك', () => {
  const stops = [P('d', 0.04), P('a', 0.01), P('c', 0.03), P('e', 0.05), P('b', 0.02)];
  assert.deepEqual(ids(orderByDistance(stops)), ['e', 'd', 'c', 'b', 'a']);
});

test('مجموعتان متباعدتان: يُنهي المندوب الأولى كلها ثم ينتقل للثانية — لا ذهاب وإياب', () => {
  const west = [P('w1', 0), P('w2', 0.005, 0.004), P('w3', 0.01, 0)];
  const east = [P('e1', 0.2), P('e2', 0.205, 0.004), P('e3', 0.21, 0)];
  const stops = [west[0], east[0], west[1], east[1], west[2], east[2]];
  const order = ids(orderByDistance(stops)).map(id => id[0]).join('');
  assert.ok(order === 'wwweee' || order === 'eeewww', order);
});

test('مربّعٌ يُزار قطرياً يصير ثلاثة أضلاع متتابعة بلا تقاطع', () => {
  const stops = [P('A', 0, 0), P('C', 0.02, 0.018), P('B', 0.02, 0), P('D', 0, 0.018)];
  const r = orderByDistance(stops);
  assert.ok(r.afterKm < r.beforeKm);
  // ثلاثة أضلاع ≈ ٢ + ٢ + ٢ كم تقريباً، لا قُطر (≈ ٢٫٧ كم) فيها
  assert.ok(r.afterKm < 6.2, String(r.afterKm));
});

test('العميل بلا موقع يبقى آخر القائمة بترتيبه، وصفر الإحداثيات يُعدّ بلا موقع', () => {
  const stops = [P('start', 0), { id: 'x', lat: null, lng: null }, P('far', 0.05), { id: 'zero', lat: 0, lng: 0 }, P('near', 0.01), { id: 'y' }];
  const r = orderByDistance(stops);
  assert.deepEqual(ids(r), ['start', 'near', 'far', 'x', 'zero', 'y']);
  assert.equal(r.missing, 3);
});

test('أقل من ثلاثة بموقع: لا شيء يُحسَّن، والدالّة لا تغيّر المصفوفة المعطاة', () => {
  const stops = [P('a', 0), { id: 'x' }, P('b', 0.01)];
  const copy = JSON.stringify(stops);
  const r = orderByDistance(stops);
  assert.equal(r.changed, false);
  assert.deepEqual(ids(r), ['a', 'x', 'b']);
  assert.equal(JSON.stringify(stops), copy);
  assert.equal(orderByDistance([]).ordered.length, 0);
});

test('لا يطول المسار أبداً، والمرتّب أصلاً يبقى كما هو بعملائه بلا موقع في أماكنهم', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const stops = Array.from({ length: 9 }, (_, i) => P(`s${seed}-${i}`, ((i * seed * 7) % 13) / 100, ((i * seed * 11) % 17) / 100));
    const r = orderByDistance(stops);
    assert.ok(r.afterKm <= r.beforeKm + 1e-9, `seed ${seed}`);
    if (!r.changed) assert.deepEqual(ids(r), stops.map(s => s.id));
  }
  const sorted = [P('a', 0), { id: 'x' }, P('b', 0.01), P('c', 0.02), P('d', 0.03)];
  const r = orderByDistance(sorted);
  assert.equal(r.changed, false);
  assert.deepEqual(ids(r), ['a', 'x', 'b', 'c', 'd']);
  assert.ok(pathKm([P('a', 0), { id: 'x' }, P('b', 0.01)]) > 0, 'بلا-موقع يُتخطّى في الطول');
});

test('ثابت بين ضغطتين: ترتيب الناتج مرّةً ثانية لا يغيّره', () => {
  const stops = [P('b', 0.02), P('e', 0.05, 0.01), P('a', 0.01, 0.02), P('d', 0.04), P('c', 0.03, 0.015)];
  const first = orderByDistance(stops);
  assert.deepEqual(ids(orderByDistance(first.ordered)), ids(first));
});

test('خطٌّ كبير (٢٠٠ عميل) يُرتَّب سريعاً بلا تكرار ولا ضياع ولا إطالة', () => {
  const stops = Array.from({ length: 200 }, (_, i) => P(`c${i}`, ((i * 37) % 200) / 1000, ((i * 53) % 200) / 1000));
  const t0 = Date.now();
  const r = orderByDistance(stops);
  assert.ok(Date.now() - t0 < 3000, `بطيء: ${Date.now() - t0}ms`);
  assert.equal(r.ordered.length, 200);
  assert.equal(new Set(ids(r)).size, 200);
  assert.ok(r.afterKm <= r.beforeKm);
});
