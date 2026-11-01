// رسائل الطباعة المباشرة على تطبيق الآيفون: لكل صنفٍ جديد رسالته وترجماته الأربع، ولا سببٌ تقنيّ (اسم متصفح أو BLE أو
// Bluetooth LE أو اسم مزوّد) في أيّ رسالةٍ قد يراها المندوب على الآيفون — وما يذكر الإقران من الإعدادات أو Chrome لا يخرج من الجسر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_PRINT_MESSAGES, DirectPrintError, type DirectPrintFailure } from './printErrors';
import { failureForCode } from './transport/iosBridge';
import { PHRASES } from '../../i18n/strings';

const IOS_NEW: readonly DirectPrintFailure[] = ['appUpdateIos', 'btOff', 'btDenied', 'pickPrinter', 'interrupted', 'printing'];
/** كل صنفٍ قد يخرج على الآيفون (failureForCode + appUpdateIos من المصافحة + tooLarge قبل الإرسال) */
const IOS_KINDS: readonly DirectPrintFailure[] = [...IOS_NEW, 'busy', 'disconnected', 'tooLarge', 'failed'];
const TECH = /Chrome|Samsung|WebView|Serial|Bluetooth LE|Low Energy|CoreBluetooth|near[\s\-_]*pay|نير\s*باي|Google Play/i;
/** «BLE» كلمةً بحروفها الكبيرة — لا «enable» ولا «available» */
const BLE = /\bBLE\b/;

test('الأصناف الستة الجديدة لها رسائلها (§C.5) وتُبنى بها DirectPrintError', () => {
  assert.deepEqual(
    Object.fromEntries(IOS_NEW.map((k) => [k, DIRECT_PRINT_MESSAGES[k]])),
    {
      appUpdateIos: 'لتفعيل الطباعة المباشرة حدث تطبيق فيلد سيلز من App Store',
      btOff: 'البلوتوث مطفأ في الجوال — شغله ثم أعد الطباعة',
      btDenied: 'اسمح لتطبيق فيلد سيلز باستخدام البلوتوث من إعدادات الجوال ثم أعد الطباعة',
      pickPrinter: 'لم تربط طابعة — اضغط ربط الطابعة واختر طابعتك',
      interrupted: 'توقفت الطباعة قبل أن تكتمل — أعد الطباعة',
      printing: 'طباعة جارية — انتظر حتى تنتهي ثم أعد الطباعة',
    },
  );
  for (const k of IOS_NEW) {
    const e = new DirectPrintError(k);
    assert.equal(e.kind, k);
    assert.equal(e.message, DIRECT_PRINT_MESSAGES[k]);
  }
});

test('لا سبب تقنيّاً ولا اسم مزوّد في رسائل الآيفون — بالعربية وبالترجمات الأربع', () => {
  for (const k of IOS_KINDS) {
    const ar = DIRECT_PRINT_MESSAGES[k];
    assert.doesNotMatch(ar, TECH, `${k}: ${ar}`);
    assert.doesNotMatch(ar, BLE, `${k}: ${ar}`);
    const p = PHRASES[ar];
    assert.ok(p, `${k}: لا ترجمة`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(p[lang] && p[lang].trim(), `${k}.${lang}`);
      assert.doesNotMatch(p[lang], TECH, `${k}.${lang}: ${p[lang]}`);
      assert.doesNotMatch(p[lang], BLE, `${k}.${lang}: ${p[lang]}`);
    }
    assert.ok(!/['’]/.test(p.fr), `${k}.fr فيه فاصلة عليا`);
  }
});

test('الجسر لا يُخرج notChosen (الإقران من الإعدادات) ولا unsupported (Chrome 138) ولا security ولا appUpdate (Google Play) لأيّ رمز', () => {
  const codes = ['bt_off', 'bt_denied', 'bt_unsupported', 'no_printer', 'picker_cancelled', 'not_found', 'connect', 'disconnected',
    'interrupted', 'busy', 'too_large', 'bad_payload', 'print_unavailable', 'failed', 'forbidden', 'bad_request', '', 'x', undefined, null, 1];
  const kinds = new Set(codes.map((c) => failureForCode(c)));
  for (const k of kinds) assert.ok(IOS_KINDS.includes(k), `${k} ليس من أصناف الآيفون`);
  for (const k of ['notChosen', 'unsupported', 'security', 'appUpdate'] as const) assert.ok(!kinds.has(k), k);
});
