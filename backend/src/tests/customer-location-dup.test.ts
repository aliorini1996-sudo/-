import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { CUSTOMER_LOCATION_EXISTS, LOCATION_DUP_RADIUS_M, distanceM, locationDupBody, validPoint } from '../services/customerLocationDup';

// «منع تكرار موقع العميل داخل الشركة» — نصف قطر ٣٠ متراً (طلب المالك ١٣ نوفمبر ٢٠٢٦)

test('المسافة بالهافرسين: ٣٠ متراً الحدّ', () => {
  const a = { lat: 24.7136, lng: 46.6753 };
  // ~0.00027° عرضاً ≈ ٣٠ متراً
  assert.ok(Math.abs(distanceM(a, { lat: 24.7136 + 0.00027, lng: 46.6753 }) - 30) < 0.5);
  assert.ok(distanceM(a, { lat: 24.7136, lng: 46.6753 + 0.0002 }) < LOCATION_DUP_RADIUS_M, '~٢٠ متراً طولاً');
  assert.ok(distanceM(a, { lat: 24.7136 + 0.0005, lng: 46.6753 }) > LOCATION_DUP_RADIUS_M, '~٥٥ متراً');
  assert.equal(distanceM(a, a), 0);
});

test('النقطة الصالحة: لا فارغ ولا ٠،٠ ولا خارج النطاق', () => {
  assert.equal(validPoint(24.7, 46.6), true);
  for (const [la, ln] of [[null, 46], [24, undefined], [0, 0], [91, 10], [10, 181], [Number.NaN, 1]] as const) assert.equal(validPoint(la, ln), false, `${la},${ln}`);
});

test('ردّ 409: اسم العميل والمسافة لمن يراه وحده', () => {
  const seen = locationDupBody({ id: 'c1', name: 'سوبر ماركت الواحة', distanceM: 12 }, true);
  assert.equal(seen.code, CUSTOMER_LOCATION_EXISTS);
  assert.match(seen.message, /«سوبر ماركت الواحة»/);
  assert.match(seen.message, /12 متر/);
  const hidden = locationDupBody({ id: 'c1', name: 'سوبر ماركت الواحة', distanceM: 12 }, false);
  assert.doesNotMatch(hidden.message, /الواحة/);
  assert.equal((hidden as { existingId?: string }).existingId, undefined);
});

test('الحارس موصول بعَلَم المندوب وحده (طلب المالك ٢٥ نوفمبر ٢٠٢٦): الإنشاء قبل الكتابة، والتعديل حين يتحرّك الموقع وحده — والإدارة والمعفى لا يمسّهم', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'routes', 'customers.ts'), 'utf8').replace(/\r\n/g, '\n');
  const post = s.indexOf('const near = await findLocationDuplicate(tid, rest.lat, rest.lng);');
  const gate = s.indexOf('if (dedup?.location) {');
  assert.ok(gate > 0 && post > gate && post - gate < 200, 'داخل عَلَم المندوب مباشرةً');
  // «رقم العميل» (٢٣ نوفمبر ٢٠٢٦): الإنشاء عبر مساعد الترقيم داخل معاملة — والفحص قبله كما كان
  assert.ok(post < s.indexOf('const customer = await prisma.$transaction((tx) => createNumberedCustomer(tx, tid, {', post), 'قبل الإنشاء');
  assert.ok(s.includes('const near = await findLocationDuplicate(tid, data.lat, data.lng, req.params.id);'), 'التعديل يستثني العميل نفسه');
  assert.ok(s.includes('if (validPoint(data.lat, data.lng) && dedup?.location) {'));
  // لا قاعدة للشركة كلها بعد اليوم: لا فحص موقعٍ خارج عَلَم المندوب
  assert.doesNotMatch(s, /phoneDupExempt\(req\)\) \{\s*const near/);
  const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'customerLocationDup.ts'), 'utf8');
  assert.match(svc, /tenantId: tid, status: \{ not: 'DELETED' \}/, 'داخل الشركة، والمحذوف لا يُعدّ');
  assert.equal(LOCATION_DUP_RADIUS_M, 30);
});
