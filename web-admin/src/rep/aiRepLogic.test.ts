// المندوب الذكي — منطق شاشة المندوب: ترتيب المسار، الأزمنة التقديرية، روابط الملاحة، والتنسيق.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distKm, fmtDistance, fmtRange, multiStopUrl, navUrl, orderRoute, routeLegs, OUTLET_TYPE_OPTIONS, OUTCOMES } from './aiRepLogic';
import { AI_REP_PHRASES, aiRepTranslate } from '../i18n/aiRepPhrases';

const O = { lat: 24.7, lng: 46.7 };
const at = (id: string, kmEast: number, kmNorth = 0) => ({ placeId: id, name: id, lat: O.lat + kmNorth / 111, lng: O.lng + kmEast / 101 });

test('ترتيب المسار: من الأقرب ولا تقاطع (2‑opt)، وحتمي', () => {
  const stops = [at('c', 3), at('a', 1), at('b', 2)];
  assert.deepEqual(orderRoute(O, stops).map(s => s.placeId), ['a', 'b', 'c']);
  // مربّع: الترتيب الأمثل يدور حوله لا يقطعه قطرياً
  const sq = [at('p1', 1, 0), at('p3', 1, 1), at('p2', 0, 1), at('p4', 2, 0.5)];
  const r1 = orderRoute(O, sq).map(s => s.placeId), r2 = orderRoute(O, [...sq].reverse()).map(s => s.placeId);
  const len = (ids: string[]) => { let d = 0, prev = O as { lat: number; lng: number }; for (const id of ids) { const s = sq.find(x => x.placeId === id)!; d += distKm(prev, s); prev = s; } return d; };
  assert.ok(Math.abs(len(r1) - len(r2)) < 1e-9, 'الطول نفسه مهما كان ترتيب الإدخال');
  assert.equal(orderRoute(O, []).length, 0);
});

test('الأزمنة التقديرية: تعرّج ١٫٣ وسرعة ٢٥ كم/س تراكمياً', () => {
  const legs = routeLegs(O, [at('a', 5)]);
  assert.ok(Math.abs(legs[0].legKm - 5 * 1.3) < 0.1);
  assert.equal(legs[0].etaMin, Math.round((legs[0].cumKm / 25) * 60));
});

test('روابط الملاحة: معرّف المكان، وحدّ ٣ نقاط وسيطة للجوال', () => {
  const u = new URL(navUrl({ lat: 24.7, lng: 46.7, placeId: 'ChIJ1' }));
  assert.equal(u.searchParams.get('destination_place_id'), 'ChIJ1');
  assert.equal(u.searchParams.get('dir_action'), 'navigate');
  const m = new URL(multiStopUrl([at('a', 1), at('b', 2), at('c', 3), at('d', 4), at('e', 5)])!);
  assert.equal(m.searchParams.get('destination_place_id'), 'd', 'الوجهة هي الرابعة');
  assert.equal(m.searchParams.get('waypoints')!.split('|').length, 3);
  assert.equal(m.searchParams.get('waypoint_place_ids'), 'a|b|c');
  assert.equal(multiStopUrl([]), null);
});

test('التنسيق: المسافة والمدى', () => {
  assert.equal(fmtDistance(437), '440 م');
  assert.equal(fmtDistance(2350), '2.4 كم');
  assert.equal(fmtRange({ low: 6, high: 12 }), '6–12');
  assert.equal(fmtRange({ low: 5, high: 5 }), '5');
  assert.equal(fmtRange(null), '—');
});

test('كل تسمية ثابتة (الأنواع والنتائج) لها ترجمة', () => {
  for (const lang of ['en', 'fr', 'tr', 'zh']) {
    for (const t of OUTLET_TYPE_OPTIONS) assert.notEqual(aiRepTranslate(lang, t.label), t.label, `بلا ترجمة ${lang}: ${t.label}`);
    for (const o of OUTCOMES) assert.notEqual(aiRepTranslate(lang, o.label), o.label, `بلا ترجمة ${lang}: ${o.label}`);
  }
  assert.equal(aiRepTranslate('ar', 'مهتم'), 'مهتم');
  for (const [k, v] of Object.entries(AI_REP_PHRASES)) assert.ok(v.en && v.fr && v.tr && v.zh, `ترجمة ناقصة: ${k}`);
});

import { refsFor, renderRefs } from './aiRepLogic';

test('سياق المستشار: مراجع P بترتيب القائمة، وعرض الأسماء مكانها', () => {
  const items = [
    { outletType: 'GROCERY', lat: 1, lng: 2, distanceM: 400, relation: 'NEW', lastOutcome: null, customerId: null, name: 'بقالة الخير' },
    { outletType: 'PHARMACY', lat: 1, lng: 3, distanceM: 900, relation: 'CUSTOMER', lastOutcome: 'INTERESTED', customerId: 'c1', name: 'صيدلية' },
  ];
  const refs = refsFor(items);
  assert.deepEqual(refs.map(r => r.ref), ['P1', 'P2']);
  assert.equal((refs[0] as Record<string, unknown>).name, undefined, 'الاسم لا يُرسل');
  assert.equal(renderRefs('ابدأ بـ P1 ثم P2 وليس P10', [{ ref: 'P1', label: 'بقالة الخير' }, { ref: 'P2', label: 'صيدلية' }]), 'ابدأ بـ «بقالة الخير» ثم «صيدلية» وليس P10');
});
