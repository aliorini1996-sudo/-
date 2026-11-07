import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PHRASES } from '../i18n/strings';
import { precisePinFix } from '../rep/punchFix';
import { REP_PIN_TEXTS } from '../rep/repCustomerPin';
import {
  PIN_WARN_M, mPinAccuracyM, mPinFailText, mPinFromFix, mPinLevel, mPinPayload, mPinWarnText, mPinWarns, type MPin,
} from './mCustomerPin';

/**
 * دبوس العميل في تطبيق الإدارة على الجوال (/m) — تدقيق «لا يعمل إلا بـ٣٠٠» البند PIN-6 (٧ نوفمبر ٢٠٢٦، «أصلح الخلل فقط»).
 * ما يحرسه هذا الملف:
 * - القراءة الفاسدة لا تصير دبوساً، والدقّة المعروضة هي نفسها التي يُحكم بها (لا «±30» مع تنبيه).
 * - الدرجات من pinAccuracyLevel المشتركة: ضمن ٣٠ م بلا تنبيه، وما أضعف أو بلا دقّة أو بالكيلومترات يُنبَّه عليه — تنبيهٌ لا منع.
 * - الحمولة إحداثيات صريحة وحدها، وبلا التقاط لا شيء — فتعديل بيانات العميل الأخرى لا يحرّك دبوسه المحفوظ.
 * - الشاشة بلا getCurrentPosition ولا رابط: الالتقاط بـprecisePinFix هو المصدر الوحيد، ونصوصها في القاموس.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, 'src', ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};
const pin = (accuracy: number | null): MPin => ({ lat: 24.7136, lng: 46.6753, accuracy });

test('mPinFromFix: القراءة الصحيحة دبوسٌ بدقّتها، والفاسدة لا تُحفظ', () => {
  assert.deepEqual(mPinFromFix({ lat: 24.7, lng: 46.6, accuracy: 12 }), { lat: 24.7, lng: 46.6, accuracy: 12 });
  assert.equal(mPinFromFix(null), null);
  assert.equal(mPinFromFix(undefined), null);
  assert.equal(mPinFromFix({ lat: NaN, lng: 46.6, accuracy: 5 }), null);
  assert.equal(mPinFromFix({ lat: 24.7, lng: Infinity, accuracy: 5 }), null);
  assert.equal(mPinFromFix({ lat: 91, lng: 46.6, accuracy: 5 }), null);
  assert.equal(mPinFromFix({ lat: 24.7, lng: -181, accuracy: 5 }), null);
  assert.equal(mPinFromFix({ lat: 0, lng: 0, accuracy: 5 }), null, '(0،0) قراءةٌ عبثية لا موقع محلّ');
  // دقّةٌ غائبة أو سالبة أو غير عددية = غير معلومة
  assert.equal(mPinFromFix({ lat: 24.7, lng: 46.6 })?.accuracy, null);
  assert.equal(mPinFromFix({ lat: 24.7, lng: 46.6, accuracy: null })?.accuracy, null);
  assert.equal(mPinFromFix({ lat: 24.7, lng: 46.6, accuracy: -5 })?.accuracy, null);
  assert.equal(mPinFromFix({ lat: 24.7, lng: 46.6, accuracy: NaN })?.accuracy, null);
});

test('mPinAccuracyM: مقرّبة ولا تقلّ عن ١، وnull لغير المعلومة', () => {
  assert.equal(mPinAccuracyM(pin(12.4)), 12);
  assert.equal(mPinAccuracyM(pin(12.5)), 13);
  assert.equal(mPinAccuracyM(pin(0)), 1);
  assert.equal(mPinAccuracyM(pin(0.3)), 1);
  assert.equal(mPinAccuracyM(pin(null)), null);
  assert.equal(mPinAccuracyM(null), null);
  assert.equal(mPinAccuracyM(undefined), null);
});

test('mPinLevel: درجات pinAccuracyLevel المشتركة على الرقم المعروض نفسه، وunknown بلا دقّة', () => {
  assert.equal(PIN_WARN_M, 30);
  assert.equal(mPinLevel(pin(5)), 'good');
  assert.equal(mPinLevel(pin(20)), 'good');
  assert.equal(mPinLevel(pin(20.4)), 'good', 'يُعرض ±20 فدرجته good');
  assert.equal(mPinLevel(pin(25)), 'fair');
  assert.equal(mPinLevel(pin(30)), 'fair');
  assert.equal(mPinLevel(pin(30.4)), 'fair', 'يُعرض ±30 فلا يُنبَّه عليه');
  assert.equal(mPinLevel(pin(30.6)), 'poor', 'يُعرض ±31 فيُنبَّه');
  assert.equal(mPinLevel(pin(150)), 'poor');
  assert.equal(mPinLevel(pin(1000)), 'coarse');
  assert.equal(mPinLevel(pin(3000)), 'coarse');
  assert.equal(mPinLevel(pin(null)), 'unknown');
});

test('mPinWarns/mPinWarnText: ضمن ٣٠ م بلا تنبيه، وما سواه بنصّه — وكل نصّ في القاموس بلغاته الأربع', () => {
  assert.equal(mPinWarns('good'), false);
  assert.equal(mPinWarns('fair'), false);
  assert.equal(mPinWarns('poor'), true);
  assert.equal(mPinWarns('coarse'), true);
  assert.equal(mPinWarns('unknown'), true);
  assert.equal(mPinWarnText('good'), null);
  assert.equal(mPinWarnText('fair'), null);
  for (const level of ['poor', 'coarse', 'unknown'] as const) {
    const key = mPinWarnText(level);
    assert.ok(key, level);
    const t = PHRASES[key!];
    assert.ok(t, `نصّ غير مترجم: ${key}`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[l]?.trim(), `${key} بلا ${l}`);
  }
  // {m} يُملأ بعد الترجمة في كل لغة
  const poor = PHRASES[mPinWarnText('poor')!];
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.match(poor[l], /\{m\}/, l);
  assert.match(mPinWarnText('coarse')!, /الموقع الدقيق/, 'الخشنة بالكيلومترات = «موقع تقريبي»: فعّل الدقيق لا «انتظر»');
  // صياغة تطبيق المندوب نفسها، والحدّ رقمٌ لا قياس (بلا «±» قبل {m})
  assert.deepEqual([mPinWarnText('poor'), mPinWarnText('unknown'), mPinWarnText('coarse')], [REP_PIN_TEXTS.weak, REP_PIN_TEXTS.unknown, REP_PIN_TEXTS.coarse]);
  assert.ok(!mPinWarnText('poor')!.includes('±'));
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(!poor[l].includes('±{m}'), l);
});

test('mPinPayload: الإحداثيات صريحةً وحدها، وبلا التقاطٍ لا شيء فيبقى المحفوظ', () => {
  assert.deepEqual(mPinPayload(null), {});
  assert.deepEqual(mPinPayload(undefined), {});
  const p = mPinPayload(pin(8));
  assert.deepEqual(p, { lat: 24.7136, lng: 46.6753 });
  assert.equal('locationUrl' in p, false, 'لا رابط يحلّه الخادم');
  assert.equal('accuracy' in p, false, 'لا حقل غير معروف للخادم');
  // ولا null يمسح الدبوس المحفوظ
  assert.equal(Object.values(mPinPayload(null)).some(v => v === null), false);
});

test('mPinFailText: لكل سبب نصّه — وكلها في القاموس', () => {
  assert.equal(mPinFailText('no-geo'), 'جهازك لا يدعم تحديد الموقع');
  assert.equal(mPinFailText('denied'), 'تعذر تحديد الموقع فعل الإذن');
  assert.equal(mPinFailText('timeout'), mPinFailText('unavailable'));
  for (const r of ['no-geo', 'denied', 'timeout', 'unavailable']) assert.ok(PHRASES[mPinFailText(r)], r);
});

test('precisePinFix ← mPinFromFix: قراءةٌ طازجة دقيقة تصير دبوساً بدرجة good، وبلا تحديد موقعٍ سببُ no-geo', async () => {
  const geo = {
    watchPosition(ok: PositionCallback) {
      ok({ coords: { latitude: 24.71, longitude: 46.67, accuracy: 9 }, timestamp: Date.now() } as unknown as GeolocationPosition);
      return 1;
    },
    clearWatch() {},
  } as unknown as Geolocation;
  const r = await precisePinFix({ geolocation: geo, waitMs: 50, refineMs: 50, capMs: 200 });
  const p = mPinFromFix(r.fix);
  assert.ok(p);
  assert.equal(mPinAccuracyM(p), 9);
  assert.equal(mPinLevel(p!), 'good');
  const none = await precisePinFix({ geolocation: undefined });
  assert.equal(none.fix, null);
  assert.equal(none.reason, 'no-geo');
  assert.equal(mPinFailText(none.reason), 'جهازك لا يدعم تحديد الموقع');
});

test('MCustomerForm: الالتقاط بـprecisePinFix وحده — لا getCurrentPosition ولا رابط، والحفظ موقوفٌ أثناءه، ونصوصه مترجمة', () => {
  const src = read('m', 'MCustomerForm.tsx');
  assert.doesNotMatch(src, /getCurrentPosition\s*\(/, 'أوّل قراءةٍ أيّاً كانت دقّتها هي الخلل نفسه (PIN-6)');
  assert.doesNotMatch(src, /locationUrl/, 'لا رابط يطغى على الالتقاط أو يُبنى منه');
  assert.match(src, /await precisePinFix\(\)/);
  assert.match(src, /Object\.assign\(payload, mPinPayload\(pin\)\)/);
  assert.match(src, /disabled=\{!valid \|\| save\.isPending \|\| geoBusy\}/, 'لا حفظ قبل وصول الالتقاط المنتظَر');
  assert.match(src, /onClick=\{\(\) => setPin\(null\)\}/, 'إلغاء الالتقاط يُبقي المحفوظ');
  // كل tr('…') حرفيّة في الشاشة الخاصة بالموقع مترجمة
  for (const key of ['دقة الموقع الملتقط ±{n} م', 'تم التقاط الموقع بدقة ضعيفة', 'إلغاء الموقع الملتقط', 'جارٍ تحديد موقعك بدقة…',
    'تم التقاط الموقع', 'تم التقاط الموقع أعد الالتقاط', 'التقط موقعي الحالي', 'لهذا العميل موقع محفوظ']) {
    assert.ok(src.includes(`tr('${key}')`), `الشاشة لا تستعمل: ${key}`);
    assert.ok(PHRASES[key], `نصّ غير مترجم: ${key}`);
  }
});
