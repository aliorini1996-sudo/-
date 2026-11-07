import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initialRepPin, looksLikeLocationLink, repPinReducer, repPinPayload, repPinView, REP_PIN_TEXTS, REP_PIN_WARN_M, type RepPinState } from './repCustomerPin';
import { PIN_WARN_M } from './punchFix';
import { PRESENCE_AWAY_TEXTS } from './presenceRefusal';
import { PHRASES } from '../i18n/strings';

// تدقيق «لا يعمل إلا بـ٣٠٠» (٧ نوفمبر ٢٠٢٦) البنود R2/PIN-2/PIN-3 وR1/R5 في تطبيق المندوب — قرار المالك «أصلح الخلل فقط»:
// دبوس العميل كان يُلتقط بقراءةٍ مخبّأة وأوّل قراءة بلا دقّة، والرابط الملصوق يطغى على الالتقاط في الخادم.

const fix = (accuracy: number | null, lat = 24.71) => ({ lat, lng: 46.67, accuracy });
const run = (s: RepPinState, ...as: Parameters<typeof repPinReducer>[1][]) => as.reduce(repPinReducer, s);

test('الحالة الأولى: بلا prefill لا شيء، وموقع المندوب الذكي معبّأ بوسم مصدره', () => {
  const empty = initialRepPin(null);
  assert.deepEqual(empty, { coords: null, locUrl: '', gps: 'idle', seq: 0, fromMap: false, captured: false });
  const map = initialRepPin({ lat: 24.7, lng: 46.6, pinFromMap: true });
  assert.deepEqual(map.coords, { lat: 24.7, lng: 46.6, accuracy: null });
  assert.equal(map.gps, 'ok');
  assert.equal(map.fromMap, true);
  assert.equal(initialRepPin({ lat: 24.7, lng: 46.6 }).fromMap, false, 'GPS الباب من المندوب الذكي بلا وسم');
  assert.equal(initialRepPin({ lat: 24.7 }).coords, null, 'نصف إحداثية ليست موقعاً');
});

test('الالتقاط يمحو الرابط الملصوق ووسم الخريطة، ودقّته تبقى معه', () => {
  let s = run(initialRepPin({ lat: 24.7, lng: 46.6, pinFromMap: true }), { type: 'link', url: '' });
  s = { ...s, locUrl: 'https://maps.app.goo.gl/x' };
  s = run(s, { type: 'start' });
  assert.equal(s.gps, 'getting');
  s = run(s, { type: 'done', seq: s.seq, fix: fix(12), reason: 'ok' });
  assert.equal(s.locUrl, '', 'الالتقاط يمحو الرابط');
  assert.deepEqual(s.coords, fix(12));
  assert.equal(s.fromMap, false);
  assert.equal(s.captured, true);
  assert.deepEqual(repPinPayload(s), { lat: 24.71, lng: 46.67 });
});

test('لصق رابطٍ يمحو الالتقاط ويُبطل التقاطاً جارياً — فلا تعود قراءةٌ متأخّرة فتمحو الرابط', () => {
  let s = run(initialRepPin(null), { type: 'start' }, { type: 'done', seq: 1, fix: fix(8), reason: 'ok' });
  s = run(s, { type: 'link', url: ' https://maps.app.goo.gl/abc ' });
  assert.equal(s.coords, null);
  assert.equal(s.captured, false);
  assert.deepEqual(repPinPayload(s), { locationUrl: 'https://maps.app.goo.gl/abc' });
  // التقاطٌ جارٍ ثم لصق: القراءة المتأخّرة تُهمَل
  let t = run(initialRepPin(null), { type: 'start' });
  const pending = t.seq;
  t = run(t, { type: 'link', url: 'https://maps.app.goo.gl/q' });
  t = run(t, { type: 'done', seq: pending, fix: fix(5), reason: 'ok' });
  assert.equal(t.coords, null);
  assert.equal(t.locUrl, 'https://maps.app.goo.gl/q');
  assert.equal(t.gps, 'idle');
  // مسح الرابط لا يمحو شيئاً آخر
  const u = run(initialRepPin({ lat: 24.7, lng: 46.6 }), { type: 'link', url: '   ' });
  assert.deepEqual(u.coords, { lat: 24.7, lng: 46.6, accuracy: null });
});

test('ضغطةٌ ثانية أثناء الالتقاط لا تبدأ ثانيةً، والفشل يُبقي الالتقاط السابق بسببه', () => {
  const a = run(initialRepPin(null), { type: 'start' });
  assert.equal(run(a, { type: 'start' }), a);
  let s = run(a, { type: 'done', seq: a.seq, fix: fix(9), reason: 'ok' }, { type: 'start' });
  s = run(s, { type: 'done', seq: s.seq, fix: null, reason: 'timeout' });
  assert.deepEqual(s.coords, fix(9), 'إعادة التقاطٍ فاشلة لا تمحو دبوساً جيّداً');
  assert.equal(s.gps, 'failed');
  const d = run(initialRepPin(null), { type: 'start' }, { type: 'done', seq: 1, fix: null, reason: 'denied' });
  assert.equal(d.gps, 'denied');
  const n = run(initialRepPin(null), { type: 'start' }, { type: 'done', seq: 1, fix: null, reason: 'no-geo' });
  assert.equal(n.gps, 'denied');
  const u = run(initialRepPin(null), { type: 'start' }, { type: 'done', seq: 1, fix: null, reason: 'unavailable' });
  assert.equal(u.gps, 'failed');
});

test('حرفٌ عابر في خانة الرابط ليس رابطاً: لا يمحو التقاطاً ولا يُبطل التقاطاً جارياً — والرابط الحقيقي يحلّ محلّه', () => {
  for (const t of ['https://maps.app.goo.gl/abc', 'http://x.y', 'www.google.com/maps/place/x', 'maps.app.goo.gl/abc', 'goo.gl/maps/x',
    'https://maps.apple.com/?ll=24.7,46.6', '24.7136, 46.6753', '24.7136،46.6753', ' -33.86,151.2 ']) {
    assert.equal(looksLikeLocationLink(t), true, t);
  }
  for (const t of ['a', 'h', 'https:/', '24.71', 'بقالة النور', '0500000000']) assert.equal(looksLikeLocationLink(t), false, t);
  // التقاطٌ دقيق ثم لمسةٌ خاطئة: الالتقاط باقٍ ويُرسل وحده
  let s = run(initialRepPin(null), { type: 'start' }, { type: 'done', seq: 1, fix: fix(8), reason: 'ok' });
  s = run(s, { type: 'link', url: 'a' });
  assert.deepEqual(s.coords, fix(8));
  assert.equal(s.captured, true);
  assert.equal(s.locUrl, 'a');
  assert.deepEqual(repPinPayload(s), { lat: 24.71, lng: 46.67 });
  // ثم يكمل رابطاً: يحلّ محلّ الالتقاط
  s = run(s, { type: 'link', url: 'https://maps.app.goo.gl/z' });
  assert.equal(s.coords, null);
  assert.deepEqual(repPinPayload(s), { locationUrl: 'https://maps.app.goo.gl/z' });
  // التقاطٌ جارٍ ثم حرفٌ عابر: يُكمل الالتقاط
  let t = run(initialRepPin(null), { type: 'start' });
  t = run(t, { type: 'link', url: 'x' });
  assert.equal(t.gps, 'getting');
  t = run(t, { type: 'done', seq: t.seq, fix: fix(6), reason: 'ok' });
  assert.deepEqual(t.coords, fix(6));
  assert.equal(t.locUrl, '');
  // بلا التقاط: النصّ يبقى كما كُتب ويُرسل (الخادم يتجاهل ما لا يُحلّ — كما كان)
  assert.deepEqual(repPinPayload(run(initialRepPin(null), { type: 'link', url: 'a' })), { locationUrl: 'a' });
});

test('بلا اختيار لا يُرسل موقع — فتعديل الحقول الأخرى لا يحرّك الدبوس المحفوظ', () => {
  assert.deepEqual(repPinPayload(initialRepPin(null)), {});
  assert.deepEqual(repPinPayload({ coords: null, locUrl: '  ' }), {});
});

test('الدقّة «±N م» وتنبيهٌ لا منع فوق PIN_WARN_M، و«فعّل الموقع الدقيق» للتقريبي', () => {
  assert.equal(REP_PIN_WARN_M, PIN_WARN_M);
  const cap = (accuracy: number | null) => run(initialRepPin(null), { type: 'start' }, { type: 'done', seq: 1, fix: fix(accuracy), reason: 'ok' });
  assert.deepEqual(repPinView(cap(12.4)), { accM: 12, notice: 'none' });
  assert.deepEqual(repPinView(cap(0.2)), { accM: 1, notice: 'none' });
  assert.deepEqual(repPinView(cap(PIN_WARN_M)), { accM: PIN_WARN_M, notice: 'none' });
  assert.deepEqual(repPinView(cap(PIN_WARN_M + 1)), { accM: PIN_WARN_M + 1, notice: 'weak' });
  assert.deepEqual(repPinView(cap(65)), { accM: 65, notice: 'weak' });
  assert.deepEqual(repPinView(cap(2400)), { accM: 2400, notice: 'coarse' });
  assert.deepEqual(repPinView(cap(null)), { accM: null, notice: 'unknown' });
  // الدرجة على الرقم المعروض: «±30 م» بلا تنبيه، و«±31 م» بتنبيه، و«±1000 م» بنصّ التقريبي
  assert.deepEqual(repPinView(cap(30.3)), { accM: 30, notice: 'none' });
  assert.deepEqual(repPinView(cap(30.6)), { accM: 31, notice: 'weak' });
  assert.deepEqual(repPinView(cap(999.6)), { accM: 1000, notice: 'coarse' });
  assert.deepEqual(repPinView(cap(20.4)), { accM: 20, notice: 'none' });
  // المعبّأ من المندوب الذكي لا يُنبَّه عليه (له وسمه)، ولا شيء بلا موقع
  assert.deepEqual(repPinView(initialRepPin({ lat: 24.7, lng: 46.6, pinFromMap: true })), { accM: null, notice: 'none' });
  assert.deepEqual(repPinView(initialRepPin({ lat: 24.7, lng: 46.6 })), { accM: null, notice: 'none' });
  assert.deepEqual(repPinView(initialRepPin(null)), { accM: null, notice: 'none' });
});

test('نصوص الدبوس والبصمة مترجمة باللغات الخمس، و{m} محفوظٌ في كل ترجمة', () => {
  for (const k of Object.values(REP_PIN_TEXTS)) {
    const p = PHRASES[k];
    assert.ok(p, `نصٌّ بلا ترجمة: ${k}`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(p[l]?.trim(), `${k} بلا ${l}`);
  }
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES[REP_PIN_TEXTS.weak][l].includes('{m}'), `{m} غائبٌ عن ${l}`);
  // نصّ التقريبي لا يسمّي تطبيقاً (المندوب قد يعمل من المتصفّح)، ونصوص البصمة بدقّتها {acc} في كل ترجمة
  assert.ok(!REP_PIN_TEXTS.coarse.includes('فيلد سيلز'));
  const punchKeys = [
    'سجلت بصمتك بموقع تقريبي (±{acc} م) — فعّل الموقع الدقيق من إعدادات الموقع في جوالك',
    'موقعك غير دقيق الآن (±{acc} م) — انتظر لحظات أو اقترب من مكان مفتوح ثم أعد المحاولة',
    PRESENCE_AWAY_TEXTS.coarse,
  ];
  for (const k of punchKeys) {
    assert.ok(PHRASES[k], `نصٌّ بلا ترجمة: ${k}`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES[k][l].includes('{acc}'), `{acc} غائبٌ عن ${l}: ${k}`);
  }
});

const src = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
const between = (a: string, b: string) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `غائب: ${a}`);
  return src.slice(i, src.indexOf(b, i));
};

test('حارس الشاشتين: الإضافة والتعديل يلتقطان بالمراقبة الدقيقة لا بقراءةٍ مخبّأة، والرابط لا يجتمع مع الالتقاط', () => {
  const hook = between('function useRepPin(', 'function RepPinFields(');
  assert.match(hook, /const r = await precisePinFix\(\);/);
  const add = between('function AddCustomer(', 'function EditCustomer(');
  const edit = between('function EditCustomer(', '// ============ قائمة بسيطة');
  for (const [name, s] of [['AddCustomer', add], ['EditCustomer', edit]] as const) {
    assert.ok(!s.includes('getCurrentPosition'), `${name}: لا getCurrentPosition`);
    assert.ok(!s.includes('maximumAge'), `${name}: لا قراءة مخبّأة`);
    assert.match(s, /useRepPin\(/, `${name}: الدبوس من useRepPin`);
    assert.match(s, /<RepPinFields pin=\{pin\} onCapture=\{capturePin\} onLink=\{pastePinLink\} \/>/, `${name}: الحقول المشتركة`);
    assert.match(s, /repPinPayload\(pin\)/, `${name}: الحمولة من repPinPayload`);
    assert.match(s, /disabled=\{loading \|\| pin\.gps === 'getting'\}/, `${name}: لا حفظ أثناء الالتقاط`);
  }
  // التعديل: الموقع يُرسَل فقط إن غيّره المندوب ولم يُقفل
  assert.match(edit, /if \(!pinLocked\) Object\.assign\(payload, repPinPayload\(pin\)\);/);
  const fields = between('function RepPinFields(', '// ============ إضافة عميل جديد');
  // خانة الرابط لا تُعطَّل بعد الالتقاط: لصقها يمحوه (onLink → link)
  assert.match(fields, /value=\{pin\.locUrl\} onChange=\{e => onLink\(e\.target\.value\)\} \/>/);
  assert.ok(!/disabled=\{!!pin\.coords\}/.test(fields));
  // «±N م» في عزلٍ ثنائيّ الاتجاه (bdi) داخل سطر الإحداثيات LTR — فلا تقع «م» قبل الرقم لقارئ العربية
  assert.match(fields, /<bdi>±\{view\.accM\} \{tr\('م'\)\}<\/bdi>/, 'الدقّة «±N م» معروضة');
  assert.match(fields, /tr\(REP_PIN_TEXTS\.retake\)/, '«أعد الالتقاط»');
  // تحت الخانة ما دام التقاط: اللصق يلغيه — وفشل إعادة الالتقاط مع دبوسٍ باقٍ لا ينصح بلصق رابط
  assert.match(fields, /\{pin\.coords && <p data-rep-pin-link-hint [^>]*>\{tr\(REP_PIN_TEXTS\.linkReplaces\)\}<\/p>\}/);
  assert.match(fields, /tr\(pin\.coords \? REP_PIN_TEXTS\.deniedKept : REP_PIN_TEXTS\.denied\)/);
});

test('حارس البصمة: تسخين الـGPS ما دامت الشاشة ظاهرةً للمقيَّد ويتجدّد، و«فعّل الموقع الدقيق» للقراءة التقريبية، و«غير دقيق» بلغة المندوب', () => {
  const screen = between('function RepAttendance(', 'function RepWorkNumber()');
  // التسخين للصفحة الظاهرة، ويتجدّد بكل عودةٍ إلى المقدّمة وبعد كل بصمة (سقفه لا يُستهلك والتطبيق في الخلفية)
  assert.match(screen, /const visible = usePageVisible\(\);\s*const \[warmTick, setWarmTick\] = useState\(0\);\s*useEffect\(\(\) => \{\s*if \(!atCustomer \|\| !visible\) return;\s*const stop = startPunchWarmup\(\);\s*return \(\) => \{ stop\(\); \};\s*\}, \[atCustomer, visible, warmTick\]\);/);
  assert.match(screen, /\} finally \{\s*inFlight\.current = false; setBusy\(false\);[\s\S]{0,200}?if \(atCustomer\) setWarmTick\(\(t\) => t \+ 1\);\s*\}/);
  assert.match(screen, /noFix = !r\.fix && r\.reason !== 'denied';\s*coarse = fixIsCoarse\(r\.fix\);\s*sentAcc = /);
  assert.match(screen, /else if \(coarse && sentAcc != null && resp\?\.data\?\.code === 'PUNCH_AWAY_FROM_CUSTOMER' && resp\.data\.reason !== 'DEVICE'\) setErr\(withAcc\(tr\(PUNCH_COARSE_MSG\), sentAcc\)\);/);
  // المهلة بلا قراءة تبقى أولاً (VISIT_NOFIX_MSG)، والتقريبي بعدها، ثم «غير دقيق» مترجماً، ثم نصّ الخادم
  const noFixAt = screen.indexOf('setErr(tr(VISIT_NOFIX_MSG))');
  const coarseAt = screen.indexOf('setErr(withAcc(tr(PUNCH_COARSE_MSG), sentAcc))');
  const lowAt = screen.indexOf("resp.data.reason === 'LOW_ACCURACY'");
  const serverAt = screen.indexOf("else setErr(resp?.data?.message || tr('تعذّر التسجيل، حاول ثانية'))");
  assert.ok(noFixAt > 0 && noFixAt < coarseAt && coarseAt < lowAt && lowAt < serverAt);
  assert.match(screen, /setErr\(sentAcc != null \? withAcc\(tr\(PUNCH_LOW_ACCURACY_MSG\), sentAcc\) : tr\('موقعك غير دقيق الآن — انتظر لحظات ثم أعد المحاولة'\)\);/);
  // القبول بقراءةٍ تقريبية: تنبيهٌ بدقّتها أنها سُجّلت بموقعٍ تقريبي
  assert.match(screen, /if \(coarse && sentAcc != null\) setCoarseNote\(sentAcc\);/);
  assert.match(screen, /\{coarseNote != null && <p data-punch-coarse [^>]*>\{withAcc\(tr\(PUNCH_COARSE_ACCEPTED_MSG\), coarseNote\)\}<\/p>\}/);
  // الرفض التقريبي بنصّ «أثبت تواجدي» نفسه، و«غير دقيق» بنصّ الخادم حرفياً
  assert.match(src, /const PUNCH_COARSE_MSG = PRESENCE_AWAY_TEXTS\.coarse;/);
  const server = fs.readFileSync(path.join(process.cwd(), '..', 'backend', 'src', 'routes', 'tracking.ts'), 'utf8');
  const serverLow = /const lowAccuracyText = \(p: PunchPlace\): string => `([^`]+)`;/.exec(server)?.[1];
  assert.ok(serverLow, 'lowAccuracyText في الخادم');
  const lowKey = /const PUNCH_LOW_ACCURACY_MSG = '([^']+)';/.exec(src)?.[1];
  assert.equal(lowKey!.replace('{acc}', '45'), serverLow!.replace('${Math.round(p.accuracy!)}', '45'), 'نصّ الخادم حرفياً');
});
