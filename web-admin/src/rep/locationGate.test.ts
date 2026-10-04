import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reduceGate, LOCATION_RECHECK_MS, UNAVAILABLE_STREAK_TO_BLOCK, type GateState } from './locationGate';

/**
 * «اشتراط تفعيل الموقع» (طلب المالك، ٤ أكتوبر ٢٠٢٦): والموقع مطفأ في جوال المندوب المقيَّد لا يقبل التطبيق منه
 * إجراءً ولا زيارةً ولا فتح عميل ولا بصمة حضور — ولا يُحجب مندوبٌ موقعه مفعّل بإشارةٍ ضعيفة.
 */
const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');
const S = (status: GateState['status'], unavailableStreak = 0): GateState => ({ status, unavailableStreak });

test('رفض الإذن (وبه يصل إطفاء الموقع على آيفون وكروم) يحجب فوراً، والقراءة الناجحة وحدها ترفع الحجب', () => {
  assert.deepEqual(reduceGate(S('on'), 1), S('off'));
  assert.deepEqual(reduceGate(S('checking'), 1), S('off'));
  assert.deepEqual(reduceGate(S('off'), 'ok'), S('on'));
  assert.deepEqual(reduceGate(S('off'), 3), S('off'), 'المهلة لا ترفع الحجب');
  assert.deepEqual(reduceGate(S('off'), 2), S('off', 1), 'التعذّر لا يرفع الحجب');
});

test('«تعذّر الموقع» يصل على آيفون والموقع مفعّل (مستودع، بلا تغطية): لا يحجب إلا متكرّراً ثلاثاً بلا نجاح بينها', () => {
  assert.equal(UNAVAILABLE_STREAK_TO_BLOCK, 3);
  let s = S('checking');
  s = reduceGate(s, 2); assert.deepEqual(s, S('on', 1), 'أول فحصٍ متعذّر لا يحجب');
  s = reduceGate(s, 2); assert.deepEqual(s, S('on', 2));
  s = reduceGate(s, 3); assert.deepEqual(s, S('on', 2), 'المهلة لا تعدّ ولا تصفّر');
  s = reduceGate(s, 2); assert.deepEqual(s, S('off', 3));
  assert.deepEqual(reduceGate(S('on', 2), 'ok'), S('on'), 'قراءةٌ ناجحة تصفّر العدّ');
});

test('انتهاء المهلة (إشارة ضعيفة) لا يحجب أبداً، والفحص كل دقيقة', () => {
  assert.deepEqual(reduceGate(S('checking'), 3), S('on'));
  assert.deepEqual(reduceGate(S('on'), 3), S('on'));
  assert.equal(LOCATION_RECHECK_MS, 60_000);
});

test('حارس ثابت: الحاجز طبقة فوق التطبيق كله، يُفحص فوراً عند أي إجراء أو شاشة، يعطّل الرجوع، ويجدّد القيد عند المحاولة', () => {
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /const locationRequired = user\?\.requireLocationOn === true;/, 'القيد يُقرأ بـ=== true');
  assert.match(app, /useLocationGate\(!!token && locationRequired\)/);
  assert.match(app, /if \(locationRequired && \(modal !== null \|\| docResult !== null \|\| screen !== 'home'\)\) void checkLocation\(\);/);
  assert.match(app, /const gateShown = !!token && !!user && locationRequired && locationStatus === 'off';/);
  assert.match(app, /\{gateShown && <LocationOffGate onRetry=\{async \(\) => \{ await refreshUser\(\); return checkLocation\(\); \}\} \/>\}/);
  const gate = app.slice(app.indexOf('function LocationOffGate('), app.indexOf('function GeoGate('));
  assert.match(gate, /className="absolute inset-0 z-\[60\]/, 'الحاجز لا يغطّي ما تحته');
  // زرّ الرجوع تحته لا يغلق ملف العميل ولا يرفع الزيارة
  for (const m of ["useBackClose(!gateShown && modal === 'customerDetail', closeCustomerDetail);", 'useBackClose(!gateShown && !!docResult, closeDocResult);']) {
    assert.ok(app.includes(m), m);
  }
  // القيد يتجدّد مع إعدادات الشركة الدورية
  assert.match(app, /void refreshUser\(\); \/\/ وصلاحيات المندوب وقيوده معها/);
});

test('حارس ثابت: بصمة المقيَّد لا تمضي بلا موقع — محاولةٌ ثانية أقوى، ثم رسالةٌ محلية تصف الحال', () => {
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /if \(fast \|\| !strict\) return fast;\s*return readLocation\(\{ enableHighAccuracy: false, timeout: 20_000, maximumAge: 120_000 \}\);/);
  assert.match(app, /const loc = await grabLocation\(locationRequired\);\s*\/\/[^\n]*\n\s*if \(!loc && locationRequired\) \{ setErr\(/);
  assert.match(app, /<RepAttendance locationRequired=\{locationRequired\} \/>/);
});

test('حارس ثابت: القيد في نافذة المندوب بلوحة الإدارة وفي تطبيق الجوال، و«تحديد الكل» لا يمسّه', () => {
  const modal = read('components', 'forms', 'SalesRepModal.tsx');
  assert.match(modal, /register\('requireLocationOn'\)/);
  assert.match(modal, /requireLocationOn: false,/, 'افتراض المندوب الجديد مطفأ');
  const m = read('m', 'MSalesReps.tsx');
  assert.match(m, /type PermKey = Grant \| 'requireCustomerProximity' \| 'requireLocationOn';/);
  assert.match(m, /requireLocationOn: false,/);
  assert.match(m, /onChange=\{v => set\('requireLocationOn', v\)\}/);
  const grants = m.slice(m.indexOf('const GRANTS = ['), m.indexOf('] as const;', m.indexOf('const GRANTS = [')));
  assert.doesNotMatch(grants, /requireLocationOn/, 'قيدٌ يسلب لا يُقلب مع «تحديد الكل»');
});
