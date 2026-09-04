import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceM, judgeProximity, GEOFENCE_RADIUS_M } from './geofence';

// نقطة مرجعية: محلّ في الرياض
const SHOP = { lat: 24.7136, lng: 46.6753 };

/** نقطة تبعد `m` متراً شمال المرجع (درجة العرض ≈ 111320 متراً). */
const northOf = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / 111320, lng: p.lng });

test('المسافة صفر للنقطة مع نفسها', () => {
  assert.equal(Math.round(distanceM(SHOP, SHOP)), 0);
});

test('المسافة تطابق الإزاحة المعروفة بهامش متر', () => {
  assert.ok(Math.abs(distanceM(SHOP, northOf(SHOP, 100)) - 100) < 1);
  assert.ok(Math.abs(distanceM(SHOP, northOf(SHOP, 1000)) - 1000) < 5);
});

test('النطاق ٥٠ متراً لا ٣٠ — لاستيعاب هامش خطأ الجوّال', () => {
  assert.equal(GEOFENCE_RADIUS_M, 50);
});

test('الصلاحية مطفأة ⇒ يمرّ كل شيء بلا قيد ولو بلا موقع ولا إحداثيات', () => {
  assert.equal(judgeProximity(false, null, null).allowed, true);
  assert.equal(judgeProximity(false, { lat: null, lng: null }, null).allowed, true);
  // غياب العَلَم يعني غير مقيَّد — عَلَمٌ تقييديّ يُقرأ بـ=== true
  assert.equal(judgeProximity(undefined as unknown as boolean, null, null).allowed, true);
});

test('داخل النطاق ⇒ يُسمح، وخارجه ⇒ يُمنع مع ذكر المسافة', () => {
  const inside = judgeProximity(true, SHOP, northOf(SHOP, 40));
  assert.equal(inside.allowed, true);

  const outside = judgeProximity(true, SHOP, northOf(SHOP, 120));
  assert.equal(outside.allowed, false);
  assert.equal(outside.reason, 'too_far');
  assert.ok(outside.distanceM !== null && outside.distanceM > 100, 'المسافة تُعرض للمندوب');
});

test('الحدّ نفسه مسموح — ٥٠ متراً بالضبط ليست خارجاً', () => {
  assert.equal(judgeProximity(true, SHOP, northOf(SHOP, 49.5)).allowed, true);
});

test('عميل بلا إحداثيات ⇒ منع باتّ بسبب صريح', () => {
  const v = judgeProximity(true, { lat: null, lng: null }, SHOP);
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'no_customer_pin');
  assert.equal(judgeProximity(true, null, SHOP).reason, 'no_customer_pin');
  assert.equal(judgeProximity(true, {}, SHOP).reason, 'no_customer_pin');
});

test('خط الاستواء وغرينتش إحداثيتان صالحتان لا «غياب موقع»', () => {
  // الفحص الساذج `!lat` كان سيعدّ الصفر غياباً فيمنع عميلاً موقعه سليم
  const v = judgeProximity(true, { lat: 0, lng: 0 }, { lat: 0, lng: 0 });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'ok');
});

test('تعذّر تحديد موقع المندوب ⇒ منع بسبب مستقلّ عن «بعيد»', () => {
  const v = judgeProximity(true, SHOP, null);
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'no_fix');
  assert.equal(v.distanceM, null);
});

test('غياب الإحداثيات يسبق غياب الموقع في الترتيب — الرسالة الأدقّ تفوز', () => {
  // مندوب بلا موقع أمام عميل بلا نقطة: السبب المعروض «العميل بلا موقع»
  // لأنه القابل للإصلاح من الإدارة، لا «أعد المحاولة» التي لن تنفع أبداً.
  assert.equal(judgeProximity(true, null, null).reason, 'no_customer_pin');
});

test('إحداثيات فاسدة (NaN) تُعامل كغياب لا كصفر', () => {
  assert.equal(judgeProximity(true, { lat: NaN, lng: 10 }, SHOP).reason, 'no_customer_pin');
});
