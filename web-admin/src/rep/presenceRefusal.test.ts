import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  presenceFailureOf, presenceAwayText, presenceAwaySoft, presenceAwayView, PRESENCE_AWAY_CODE, PRESENCE_AWAY_TEXTS, type PresenceAway,
} from './presenceRefusal';
import { PHRASES } from '../i18n/strings';

// «أثبت تواجدي» للمقيَّد بـ«بصمة الحضور بموقع عميل» لا يُقبل إلا عند أحد عملائه (طلب المالك ٧ نوفمبر ٢٠٢٦): رفض الخادم 409
// PRESENCE_AWAY_FROM_CUSTOMER يُبقي الطلب مفتوحاً — النافذة تقول السبب بلغة المندوب و«أعد المحاولة» حتى المهلة.

const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });
const away = (over: Partial<PresenceAway> = {}): PresenceAway =>
  ({ kind: 'away', reason: 'OUTSIDE', nearestM: null, radius: null, message: null, ...over });
const ar = (s: string) => s;
const en = (s: string) => PHRASES[s]?.en ?? `«${s}»`;

test('التصنيف: رفض المكان بأسبابه الثلاثة ومعه أقرب عميل والنطاق', () => {
  const outside = presenceFailureOf(err(409, {
    success: false, code: PRESENCE_AWAY_CODE, reason: 'OUTSIDE', message: 'خارج النطاق', nearestM: 412.6, radius: 150,
  }));
  assert.deepEqual(outside, { kind: 'away', reason: 'OUTSIDE', nearestM: 412.6, radius: 150, message: 'خارج النطاق' });
  assert.equal((presenceFailureOf(err(409, { code: PRESENCE_AWAY_CODE, reason: 'NO_FIX' })) as PresenceAway).reason, 'NO_FIX');
  assert.equal((presenceFailureOf(err(409, { code: PRESENCE_AWAY_CODE, reason: 'LOW_ACCURACY', radius: 100 })) as PresenceAway).reason, 'LOW_ACCURACY');
});

test('التصنيف: سببٌ مجهول أو حقولٌ تالفة — «خارج النطاق» بلا أرقام كاذبة', () => {
  const f = presenceFailureOf(err(409, { code: PRESENCE_AWAY_CODE, reason: 'SOMETHING_NEW', nearestM: '300', radius: -5, message: '   ' }));
  assert.deepEqual(f, { kind: 'away', reason: 'OUTSIDE', nearestM: null, radius: null, message: null });
  const nan = presenceFailureOf(err(409, { code: PRESENCE_AWAY_CODE, nearestM: Number.NaN, radius: Infinity }));
  assert.deepEqual(nan, { kind: 'away', reason: 'OUTSIDE', nearestM: null, radius: null, message: null });
  // صفرٌ مسافةٌ صحيحة لا «لا عميل»
  assert.equal((presenceFailureOf(err(409, { code: PRESENCE_AWAY_CODE, nearestM: 0, radius: 50 })) as PresenceAway).nearestM, 0);
});

test('التصنيف: رفض المكان ليس «انتهت المهلة» — والنهائيّ كما كان، والباقي يُعاد', () => {
  assert.equal(presenceFailureOf(err(409, { code: 'PRESENCE_EXPIRED' })).kind, 'expired');
  assert.equal(presenceFailureOf(err(409, { code: 'PRESENCE_CLOSED' })).kind, 'expired');
  assert.equal(presenceFailureOf(err(404, { success: false })).kind, 'expired');
  assert.equal(presenceFailureOf(err(403, { success: false })).kind, 'expired');
  // رفض المكان أولاً ولو جاء بحالةٍ أخرى
  assert.equal(presenceFailureOf(err(403, { code: PRESENCE_AWAY_CODE, reason: 'OUTSIDE' })).kind, 'away');
  // شبكة، مهلة، خادم، 409 آخر — يُعاد بـ«تعذر الارسال»
  for (const e of [new Error('Network Error'), { code: 'ECONNABORTED' }, err(500, {}), err(409, { code: 'OTHER' }), err(422, {}), null, undefined, 'x']) {
    assert.equal(presenceFailureOf(e).kind, 'error', JSON.stringify(e ?? null));
  }
});

test('النصّ: خارج النطاق يذكر النطاق وأقرب عميل مقرّبين — بالعربية وبلغة المندوب', () => {
  const a = away({ nearestM: 412.6, radius: 150 });
  assert.equal(presenceAwayText(a, ar), 'إثبات تواجدك مشروط بأن تكون داخل 150 مترا من موقع أحد عملائك — أقرب عملائك على بعد 413 مترا منك');
  assert.equal(presenceAwayText(a, en), 'Your presence can only be confirmed within 150 meters of one of your customers — your nearest customer is 413 meters away');
  const none = away({ nearestM: null, radius: 99.6 });
  assert.equal(presenceAwayText(none, ar), 'إثبات تواجدك مشروط بأن تكون داخل 100 مترا من موقع أحد عملائك — لا عميل لك قريب من موقعك الحالي');
  assert.doesNotMatch(presenceAwayText(none, en), /\{radius\}|\{m\}/);
});

test('النصّ: بلا نطاق — نصّ الخادم إن وُجد وإلّا العامّ المترجم', () => {
  assert.equal(presenceAwayText(away({ message: 'نص الخادم' }), ar), 'نص الخادم');
  assert.equal(presenceAwayText(away(), ar), PRESENCE_AWAY_TEXTS.outsideGeneric);
  assert.equal(presenceAwayText(away(), en), PHRASES[PRESENCE_AWAY_TEXTS.outsideGeneric].en);
});

test('النصّ: موقعٌ غير دقيق — «انتظر لحظات» لا «خارج النطاق»', () => {
  const t = presenceAwayText(away({ reason: 'LOW_ACCURACY', nearestM: 120, radius: 100 }), ar);
  assert.match(t, /^موقعك غير دقيق الآن — انتظر لحظات/);
  assert.doesNotMatch(t, /120|100/);
});

test('النصّ: بلا موقع — «فعّل الموقع» إلا إن كان مفعّلاً ولم تصل قراءة (مهلة/تعذّر): تُقال الحقيقة كالبصمة', () => {
  const a = away({ reason: 'NO_FIX' });
  assert.equal(presenceAwayText(a, ar), 'فعّل الموقع — إثبات تواجدك مشروط بأن تكون عند أحد عملائك');
  assert.equal(presenceAwayText(a, ar, 'denied'), 'فعّل الموقع — إثبات تواجدك مشروط بأن تكون عند أحد عملائك');
  assert.equal(presenceAwayText(a, ar, 'no-geo'), 'فعّل الموقع — إثبات تواجدك مشروط بأن تكون عند أحد عملائك');
  assert.equal(presenceAwayText(a, ar, 'ok'), 'فعّل الموقع — إثبات تواجدك مشروط بأن تكون عند أحد عملائك');
  assert.equal(presenceAwayText(a, ar, 'timeout'), PRESENCE_AWAY_TEXTS.noFixTimeout);
  assert.equal(presenceAwayText(a, ar, 'unavailable'), PRESENCE_AWAY_TEXTS.noFixTimeout);
  // نصّ البصمة نفسه
  const app = fs.readFileSync(path.resolve(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
  assert.ok(app.includes(`const VISIT_NOFIX_MSG = '${PRESENCE_AWAY_TEXTS.noFixTimeout}';`));
});

test('اللون: «انتظر وأعد» (موقعٌ غير دقيق، أو لم تصل قراءة والموقع مفعّل) ليّنٌ — والبُعد ورفض الإذن رفضٌ صريح', () => {
  assert.equal(presenceAwaySoft(away({ reason: 'LOW_ACCURACY' })), true);
  assert.equal(presenceAwaySoft(away({ reason: 'NO_FIX' }), 'timeout'), true);
  assert.equal(presenceAwaySoft(away({ reason: 'NO_FIX' }), 'unavailable'), true);
  for (const r of ['denied', 'no-geo', 'ok', null, undefined] as const) assert.equal(presenceAwaySoft(away({ reason: 'NO_FIX' }), r), false, String(r));
  assert.equal(presenceAwaySoft(away({ reason: 'OUTSIDE', nearestM: 300, radius: 50 }), 'ok'), false);
  // ما تحفظه النافذة وتعود به: النصّ واللون معاً
  assert.deepEqual(presenceAwayView(away({ reason: 'LOW_ACCURACY' }), ar), { text: PRESENCE_AWAY_TEXTS.lowAccuracy, soft: true });
  assert.deepEqual(presenceAwayView(away({ nearestM: 334, radius: 50 }), ar),
    { text: 'إثبات تواجدك مشروط بأن تكون داخل 50 مترا من موقع أحد عملائك — أقرب عملائك على بعد 334 مترا منك', soft: false });
});

test('القراءة التقريبية (الموقع الدقيق مطفأ): «فعّل الموقع الدقيق» بدقّتها — لا «انتظر» ولا مسافةٌ كاذبة، ورفضٌ صريح لا ليّن', () => {
  // ±2000 م عند نطاق 50: الخادم يقول «غير دقيق» ما دام أقرب عميل ضمن 2050 م، و«خارج النطاق» بعدها — والانتظار لا يُصلح أيّاً منهما
  for (const a of [away({ reason: 'LOW_ACCURACY', nearestM: 900, radius: 50 }), away({ nearestM: 3400, radius: 50 }), away(), away({ message: 'نص الخادم' })]) {
    assert.equal(presenceAwayText(a, ar, 'ok', 1999.6), 'موقع جوالك تقريبي (±2000 م) لا دقيق — فعّل الموقع الدقيق من إعدادات الموقع في جوالك ثم أعد المحاولة', a.reason);
    assert.equal(presenceAwayText(a, en, 'ok', 2000), PHRASES[PRESENCE_AWAY_TEXTS.coarse].en.replace('{acc}', '2000'));
    assert.doesNotMatch(presenceAwayText(a, en, 'ok', 2000), /\{acc\}|3400|900/);
    assert.equal(presenceAwaySoft(a, 'ok', 2000), false, 'إعدادٌ في الجوال لا انتظار');
    assert.deepEqual(presenceAwayView(a, ar, 'ok', 1500), { text: presenceAwayText(a, ar, 'ok', 1500), soft: false });
  }
  // بلا قراءة: الخادم لم يرَ موقعاً — نصّ «بلا موقع» كما هو ولو وصلت دقّةٌ ما
  const noFix = away({ reason: 'NO_FIX' });
  assert.equal(presenceAwayText(noFix, ar, 'timeout', 2000), PRESENCE_AWAY_TEXTS.noFixTimeout);
  assert.equal(presenceAwaySoft(noFix, 'timeout', 2000), true);
  // ليست تقريبية (null/غائبة/تالفة): كما كان حرفياً
  for (const c of [null, undefined, Number.NaN, -1, Infinity]) {
    assert.equal(presenceAwayText(away({ reason: 'LOW_ACCURACY' }), ar, 'ok', c), PRESENCE_AWAY_TEXTS.lowAccuracy, String(c));
    assert.equal(presenceAwaySoft(away({ reason: 'LOW_ACCURACY' }), 'ok', c), true, String(c));
    assert.equal(presenceAwayText(away({ nearestM: 334, radius: 50 }), ar, 'ok', c),
      'إثبات تواجدك مشروط بأن تكون داخل 50 مترا من موقع أحد عملائك — أقرب عملائك على بعد 334 مترا منك');
  }
});

test('التركية: «داخل N متراً» = «en fazla N metre uzaklıkta» لا «على مسافة N متر»', () => {
  for (const key of [PRESENCE_AWAY_TEXTS.outsideNear, PRESENCE_AWAY_TEXTS.outsideNone]) {
    assert.match(PHRASES[key].tr, /en fazla \{radius\} metre uzaklıktayken/);
    assert.doesNotMatch(PHRASES[key].tr, /mesafedeyken/);
  }
});

test('كل نصوص الرفض مترجمة بالخمس، والعناصر النائبة باقية في كل ترجمة', () => {
  for (const key of Object.values(PRESENCE_AWAY_TEXTS)) {
    const p = PHRASES[key];
    assert.ok(p, key);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(p[lang]?.trim(), `${key} ${lang}`);
      for (const ph of ['{radius}', '{m}', '{acc}']) assert.equal(p[lang].includes(ph), key.includes(ph), `${key} ${lang} ${ph}`);
    }
  }
  assert.ok(PHRASES['أعد المحاولة']?.en, 'زرّ الإعادة مترجم');
});

/* ─── حارس التوصيل ─────────────────────────────────────────────────────────── */

test('حارس ثابت: رفض المكان يُبقي النافذة مفتوحة بـ«أعد المحاولة» — لا onAnswered ولا «انتهت المهلة» ولا إغلاق', () => {
  const modal = fs.readFileSync(path.resolve(process.cwd(), 'src', 'rep', 'PresenceCheck.tsx'), 'utf8');
  assert.match(modal, /import \{ presenceFailureOf, presenceAwayView, type PresenceAwayView \} from '\.\/presenceRefusal';/);
  const c = modal.slice(modal.indexOf('const confirm = async () => {'), modal.indexOf('const color = '));
  const catchAt = c.indexOf('} catch (e) {');
  const handler = c.slice(catchAt, c.indexOf('} finally {', catchAt));
  assert.match(handler, /const f = presenceFailureOf\(e\);/);
  assert.match(handler, /if \(f\.kind === 'away'\) \{\n\s*const v = presenceAwayView\(f, tr, fixReason, coarseM\);\n\s*onAway\?\.\(v\);\n\s*setResult\(\{ kind: 'away', \.\.\.v \}\);\n\s*\}/);
  assert.equal(handler.match(/onAnswered\(\)/g)?.length, 1, 'onAnswered للنهائيّ وحده');
  assert.ok(handler.indexOf("f.kind === 'away'") < handler.indexOf('onAnswered()'));
  // بعد «إغلاق مؤقت» تعيده النبضة بسببه (لا بالسؤال الأول بلا إغلاق): التطبيق يحفظ آخر رفضٍ لكل طلب ويمرّره للنافذة الجديدة
  assert.match(modal, /useState<Result \| null>\(\(\) => \(lastAway \? \{ kind: 'away', \.\.\.lastAway \} : null\)\);/);
  const app = fs.readFileSync(path.resolve(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
  assert.match(app, /const awayPresence = useRef\(new Map<string, PresenceAwayView>\(\)\);/);
  assert.match(app, /lastAway=\{awayPresence\.current\.get\(presence\.id\) \?\? null\}\n\s*onAway=\{\(v\) => awayPresence\.current\.set\(presence\.id, v\)\}/);
  assert.match(app, /attemptedPresence\.current\.clear\(\); awayPresence\.current\.clear\(\);/, 'لا يرثه من يدخل بعده');
  // سبب غياب القراءة من القراءة الطازجة نفسها، والإعادة هي confirm نفسها (لمسةٌ جديدة وقراءةٌ طازجة)
  assert.match(c, /const r = await precisePunchFix\(\);\n\s*fixReason = r\.reason;/);
  assert.ok(c.indexOf('let fixReason') < c.indexOf('try {'));
  // القراءة التقريبية بحكم العقد المشترك (pinAccuracyLevel في punchFix.ts) من القراءة المرسلة نفسها — والمرسَل بلا تغيير
  assert.match(modal, /import \{ precisePunchFix, pinAccuracyLevel, startPunchWarmup, type PunchFixReason \} from '\.\/punchFix';/);
  assert.ok(c.indexOf('let coarseM: number | null = null;') > 0 && c.indexOf('let coarseM') < c.indexOf('try {'));
  assert.match(c, /fixReason = r\.reason;\n\s*const acc = r\.fix\?\.accuracy;\n\s*if \(typeof acc === 'number' && pinAccuracyLevel\(acc\) === 'coarse'\) coarseM = acc;\n\s*const body = \{ \.\.\.\(r\.fix \?\? \{\}\), deviceId/);
  // المهلة تنتهي والمحاولة لم يُحكم بها: لا «انتهت» ولا «تم» حتى يصل حكمها (لمستها سبقت المهلة)
  assert.match(modal, /const ended = phase === 'expired' && !busy;/);
  assert.match(modal, /const retryable = \(result\?\.kind === 'error' \|\| away\) && !ended;/);
  assert.match(modal, /\{away && ended \? tr\('انتهت مهلة التحقق'\) : result\.text\}/);
  assert.match(modal, /\) : ended \? \(\n\s*<>\n\s*<p className="text-sm text-\[#C0392B\] font-semibold">\{tr\('انتهت مهلة التحقق'\)\}<\/p>/);
  assert.doesNotMatch(modal, /phase === 'expired' \? \(/);
  // «انتظر وأعد» كهرمانيّ، والبُعد الصريح وانتهاء المهلة أحمران
  assert.match(modal, /result\.kind === 'error' \|\| \(away && \(ended \|\| !result\.soft\)\) \? 'text-\[#C0392B\]' : 'text-\[#B7791F\]'/);
  assert.match(modal, /\{busy \? busyText : away \? tr\('أعد المحاولة'\) : tr\('اثبت تواجدي'\)\}/);
  const retryBlock = modal.slice(modal.indexOf('{retryable ? ('), modal.indexOf(') : (', modal.indexOf('{retryable ? (')));
  assert.match(retryBlock, /<button onClick=\{confirm\} disabled=\{busy\}/);
  assert.match(retryBlock, /<button onClick=\{onDismiss\} disabled=\{busy\}/, 'إغلاقٌ مؤقت تعيده النبضة ليصل عميله بالتطبيق');
  assert.match(retryBlock, /\{away && countdown\}/, 'يرى ما بقي من المهلة');
  // الجرس كما هو: يسكت بالنتيجة، وأُسكت بالضغطة الأولى
  assert.match(modal, /const alarmOn = !result && !busy && phase !== 'expired';/);
});

test('حارس ثابت: تسخين GPS ما دامت النافذة تنتظر ضغطةً أو إعادة — يتوقّف بالحكم والمهلة والفكّ، ولا يُرسل شيئاً', () => {
  const modal = fs.readFileSync(path.resolve(process.cwd(), 'src', 'rep', 'PresenceCheck.tsx'), 'utf8');
  // شرط التسخين بعد تعريف ended وretryable، ودالة الإيقاف نفسها تنظيف الأثر (عند تغيّر الشرط وعند فكّ النافذة) — ويُجدَّد بدخول
  // «متأخر» وبعد كل نتيجة (رفض المكان): التسخين يقف وحده بعد سقفه، والإعادة تجد GPS دافئاً. وللصفحة الظاهرة وحدها (usePageVisible):
  // نافذةٌ فُتحت والتطبيق في الخلفية لا تستهلك سقف التسخين، ويُفتح من جديد بكل إظهار
  assert.match(modal, /import \{ usePageVisible \} from '\.\/usePageVisible';/);
  assert.match(modal, /const visible = usePageVisible\(\);\n\s*const warm = !ended && \(!result \|\| retryable\);\n\s*useEffect\(\(\) => \(warm && visible \? startPunchWarmup\(\) : undefined\), \[warm, visible, phase, result\]\);/);
  assert.ok(modal.indexOf('const retryable = ') < modal.indexOf('const warm = '));
  assert.equal(modal.match(/startPunchWarmup\(/g)?.length, 1, 'موضعٌ واحد للتسخين');
  // التسخين لا يردّ: الردّ في confirm وحده بقراءةٍ طازجة بعد الضغط
  const c = modal.slice(modal.indexOf('const confirm = async () => {'), modal.indexOf('const color = '));
  assert.doesNotMatch(c, /startPunchWarmup/);
  assert.equal(modal.match(/precisePunchFix\(\)/g)?.length, 1);
  assert.equal(modal.match(/\/respond`/g)?.length, 1);
});

/** محاكاة شرط التسخين بالحالات: ينتظر الضغط أو «أعد المحاولة» = يسخّن، والحكم النهائي أو انتهاء المهلة = يتوقّف */
test('شرط التسخين بالحالات — كما في PresenceCheck.tsx', () => {
  type K = 'ok' | 'late' | 'noFix' | 'expired' | 'error' | 'away';
  const warmOf = (kind: K | null, expired: boolean, busy: boolean) => {
    const ended = expired && !busy;
    const away = kind === 'away';
    const retryable = (kind === 'error' || away) && !ended;
    return !ended && (!kind || retryable);
  };
  assert.equal(warmOf(null, false, false), true, 'ينتظر الضغطة الأولى');
  assert.equal(warmOf(null, false, true), true, 'يقرأ بعد الضغط');
  assert.equal(warmOf('away', false, false), true, 'رُفض المكان: «أعد المحاولة»');
  assert.equal(warmOf('error', false, false), true, 'فشل الإرسال: يُعاد');
  for (const k of ['ok', 'late', 'noFix', 'expired'] as const) assert.equal(warmOf(k, false, false), false, k);
  assert.equal(warmOf(null, true, false), false, 'انتهت المهلة');
  assert.equal(warmOf('away', true, false), false, 'انتهت المهلة بعد الرفض');
  assert.equal(warmOf(null, true, true), true, 'محاولةٌ سبقت المهلة ما زالت تقرأ');
});
