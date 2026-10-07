import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * زيارة المندوب المقيَّد بـ«اشتراط تفعيل الموقع» (أمر المالك، ٦ أكتوبر ٢٠٢٦): لا تُقبل أبداً دون اتصال ولا دون موقع،
 * ويتّضح على الخريطة أين سُجّلت بالضبط. وكل مندوب: زيارة المؤقّت تحمل موقع الوصول (كانت تُرفع بلا إحداثيات إطلاقاً).
 */

// مخزون وهميّ يحاكي localStorage قبل استيراد الوحدات
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const {
  isGeoFix, toGeoFix, attachFix, fixCoords, visitGate, planFinalize, visitFailure, isFinalVisitRejection, MIN_VISIT_SEC,
} = await import('./visitLocation');
const { getVisitTimer, setVisitTimer } = await import('./visitTimer');
const {
  getPendingVisits, putPendingVisit, removePendingVisit, ownPendingVisits, pendingRetryOutcome, postResultOf, retryPendingVisits,
  beginEnding, endEnding, orphanEnding, orphanFate,
} = await import('./visitPending');
const { PHRASES } = await import('../i18n/strings');

const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const FIX = { lat: 24.7136, lng: 46.6753, accuracy: 12, at: '2026-10-06T08:00:00.000Z' };

beforeEach(() => store.clear());

// ───────── القرارات الصرفة ─────────

test('بوّابة المقيَّد: متصلٌ أولاً ثم قراءة — وغير المقيَّد يمضي دائماً', () => {
  assert.equal(visitGate(true, true, true), 'ok');
  assert.equal(visitGate(true, false, true), 'offline', 'بقراءة ودون اتصال: لا');
  assert.equal(visitGate(true, false, false), 'offline', 'الاتصال يُقال أولاً');
  assert.equal(visitGate(true, true, false), 'noFix');
  for (const online of [true, false]) for (const fix of [true, false]) assert.equal(visitGate(false, online, fix), 'ok');
});

test('انتهاء المؤقّت: ضغطة خاطئة لا زيارة، وبموقعٍ تُرفع به، والمقيَّد بلا موقعٍ لا يُرسل، وغيره كما كان', () => {
  assert.equal(MIN_VISIT_SEC, 2);
  assert.equal(planFinalize(1, true, true), 'skip');
  assert.equal(planFinalize(600, true, true), 'send');
  assert.equal(planFinalize(600, true, false), 'send');
  assert.equal(planFinalize(600, false, true), 'drop');
  assert.equal(planFinalize(600, false, false), 'sendBare');
});

test('لا صفّ دون اتصال للمقيَّد أبداً: مؤقّته يُحفظ على الجهاز (بانتظار الاتصال أو لم تُسجَّل)، وانقطاع الملاحظة ⇒ اطلب الاتصال', () => {
  assert.equal(visitFailure('timer', true, true), 'held');
  assert.equal(visitFailure('timer', true, false), 'held', 'ورفض الخادم يُحفظ ليُعرض بسببه');
  assert.equal(visitFailure('timer', false, true), 'outbox');
  assert.equal(visitFailure('timer', false, false), 'ignore', 'وغيره صامتٌ كما كان');
  assert.equal(visitFailure('note', true, true), 'needOnline');
  assert.equal(visitFailure('note', false, true), 'outbox');
  assert.equal(visitFailure('note', true, false), 'showError');
  for (const kind of ['timer', 'note'] as const) for (const net of [true, false]) {
    assert.notEqual(visitFailure(kind, true, net), 'outbox', `${kind}: المقيَّد لا يدخل الصفّ`);
  }
});

test('رفضٌ نهائيّ لزيارةٍ في الصفّ: LOCATION_REQUIRED وVISIT_NEEDS_CONNECTION — لا «إعادة محاولة» وتبقى ظاهرة', () => {
  assert.equal(isFinalVisitRejection({ kind: 'visit', status: 'rejected', rejectCode: 'LOCATION_REQUIRED' }), true);
  assert.equal(isFinalVisitRejection({ kind: 'visit', status: 'rejected', rejectCode: 'VISIT_NEEDS_CONNECTION' }), true);
  assert.equal(isFinalVisitRejection({ kind: 'visit', status: 'rejected' }), false, 'رفضٌ آخر يُعاد');
  assert.equal(isFinalVisitRejection({ kind: 'visit', status: 'queued', rejectCode: 'LOCATION_REQUIRED' }), false);
  assert.equal(isFinalVisitRejection({ kind: 'invoice', status: 'rejected', rejectCode: 'LOCATION_REQUIRED' }), false);
});

test('القراءة: سليمةٌ أو لا شيء — (0،0) والمدى الفاسد والنصّ لا تُرسل', () => {
  assert.equal(isGeoFix(FIX), true);
  assert.equal(isGeoFix({ ...FIX, lat: 0, lng: 0 }), false);
  assert.equal(isGeoFix({ ...FIX, lat: 91 }), false);
  assert.equal(isGeoFix({ ...FIX, lng: '46' }), false);
  assert.equal(isGeoFix({ lat: 24, lng: 46 }), false, 'بلا لحظة قراءة');
  assert.equal(isGeoFix(null), false);
  assert.deepEqual(fixCoords(FIX), { lat: 24.7136, lng: 46.6753 }, 'الدقّة واللحظة لا تُرسلان');
  assert.deepEqual(fixCoords(null), {});
  assert.deepEqual(fixCoords({ ...FIX, lat: 0, lng: 0 }), {});
  const g = toGeoFix({ coords: { latitude: 24.5, longitude: 46.5, accuracy: 18.6 }, timestamp: Date.parse('2026-10-06T09:00:00Z') });
  assert.deepEqual(g, { lat: 24.5, lng: 46.5, accuracy: 19, at: '2026-10-06T09:00:00.000Z' });
});

test('إلحاق القراءة بالمؤقّت: أول قراءة تبقى، ولا تُلصق قراءةٌ متأخّرة بزيارةٍ أخرى', () => {
  const t = { customerId: 'c1', startedAt: '2026-10-06T08:00:00.000Z' };
  assert.deepEqual(attachFix({ ...t }, t, FIX), { ...t, fix: FIX });
  assert.equal(attachFix({ ...t, fix: FIX }, t, { ...FIX, lat: 25 }), null, 'مكان الوصول لا آخر مكان');
  assert.equal(attachFix({ customerId: 'c2', startedAt: t.startedAt }, t, FIX), null);
  assert.equal(attachFix({ customerId: 'c1', startedAt: '2026-10-06T09:00:00.000Z' }, t, FIX), null, 'زيارةٌ تالية للعميل نفسه');
  assert.equal(attachFix(null, t, FIX), null);
  assert.equal(attachFix({ ...t }, t, null), null);
});

test('موقع الوصول يُحفظ مع المؤقّت فينجو من إعادة التحميل، وقراءةٌ تالفة تسقط وحدها ويبقى المؤقّت', () => {
  setVisitTimer({ customerId: 'c1', customerName: 'بقالة النور', startedAt: '2026-10-06T08:00:00.000Z', fix: FIX });
  assert.deepEqual(getVisitTimer()?.fix, FIX);
  store.set('rep_visit_timer', JSON.stringify({ customerId: 'c1', customerName: 'ن', startedAt: '2026-10-06T08:00:00.000Z', fix: { lat: 'x' } }));
  const t = getVisitTimer();
  assert.equal(t?.customerId, 'c1');
  assert.equal(t?.fix, undefined);
});

// ───────── «بانتظار الاتصال لتسجيلها» ─────────

const held = (clientRef: string, over: Record<string, unknown> = {}) => ({
  clientRef, repId: 'rep1', customerName: 'بقالة', endedAt: '2026-10-06T08:10:00.000Z', status: 'waiting' as const,
  payload: { customerId: 'c1', lat: 24.7, lng: 46.6, clientRef }, ...over,
});

test('مخزن الانتظار: إضافة واستبدال بالمفتاح وإزالة، وزيارات صاحب الجلسة وحده، والتالف لا يُقرأ', () => {
  putPendingVisit(held('a'));
  putPendingVisit(held('b', { repId: 'rep2' }));
  putPendingVisit(held('a', { status: 'failed', error: 'x' }));
  assert.equal(getPendingVisits().length, 2);
  assert.equal(getPendingVisits().find(v => v.clientRef === 'a')?.status, 'failed');
  assert.deepEqual(ownPendingVisits('rep1').map(v => v.clientRef), ['a']);
  removePendingVisit('a');
  assert.deepEqual(getPendingVisits().map(v => v.clientRef), ['b']);
  store.set('rep_visits_awaiting_net', JSON.stringify([{ clientRef: 'z' }, 'نص', held('c')]));
  assert.deepEqual(getPendingVisits().map(v => v.clientRef), ['c']);
  store.set('rep_visits_awaiting_net', 'ليس JSON');
  assert.deepEqual(getPendingVisits(), []);
});

test('نتيجة المحاولة: نجاحٌ يُزال، وانقطاع/5xx/جلسة/عميلٌ لم يُرفع تنتظر، ورفض الأعمال «لم تُسجَّل»', () => {
  assert.equal(pendingRetryOutcome({ ok: true }), 'done');
  assert.equal(pendingRetryOutcome({ ok: false }), 'keep');
  assert.equal(pendingRetryOutcome({ ok: false, status: 503 }), 'keep');
  assert.equal(pendingRetryOutcome({ ok: false, status: 401 }), 'keep');
  assert.equal(pendingRetryOutcome({ ok: false, status: 400, code: 'CUSTOMER_REF_PENDING' }), 'keep');
  assert.equal(pendingRetryOutcome({ ok: false, status: 409, code: 'LOCATION_REQUIRED' }), 'failed');
  assert.equal(pendingRetryOutcome({ ok: false, status: 403 }), 'failed');
  assert.deepEqual(postResultOf({ response: { status: 409, data: { code: 'X', message: 'م' } } }), { ok: false, status: 409, code: 'X', message: 'م' });
  assert.deepEqual(postResultOf(new Error('Network Error')), { ok: false, status: undefined, code: undefined, message: undefined });
});

test('إعادة الرفع: حيّةً واحدةً واحدة — المسجَّلة تُزال، والمردودة تبقى ظاهرةً بسببها، والانقطاع يوقف البقية، ولا تُمسّ زيارات غيره', async () => {
  putPendingVisit(held('1', { endedAt: '2026-10-06T08:01:00.000Z' }));
  putPendingVisit(held('2', { endedAt: '2026-10-06T08:02:00.000Z' }));
  putPendingVisit(held('3', { endedAt: '2026-10-06T08:03:00.000Z' }));
  putPendingVisit(held('4', { endedAt: '2026-10-06T08:04:00.000Z' }));
  putPendingVisit(held('old', { status: 'failed', error: 'سابق' }));
  putPendingVisit(held('other', { repId: 'rep2' }));
  const sent: string[] = [];
  const res = await retryPendingVisits(async (p) => {
    const ref = String(p.clientRef);
    sent.push(ref);
    if (ref === '2') throw { response: { status: 409, data: { code: 'LOCATION_REQUIRED', message: 'لا تُقبل الزيارة بلا موقعك' } } };
    if (ref === '3') throw new Error('Network Error');
  }, 'rep1');
  assert.deepEqual(sent, ['1', '2', '3'], 'بالترتيب الزمني، ويتوقّف عند الانقطاع، و«لم تُسجَّل» وزيارات غيره لا تُرسل');
  assert.deepEqual(res, { done: 1, kept: 2, failed: 1 });
  const by = Object.fromEntries(getPendingVisits().map(v => [v.clientRef, v]));
  assert.equal(by['1'], undefined, 'سُجّلت فأُزيلت');
  assert.equal(by['2'].status, 'failed');
  assert.equal(by['2'].error, 'لا تُقبل الزيارة بلا موقعك', 'سببها ظاهر لا تسقط بلا أثر');
  assert.equal(by['3'].status, 'waiting');
  assert.equal(by['4'].status, 'waiting');
  assert.equal(by['old'].status, 'failed');
  assert.equal(by['other'].status, 'waiting');
  // الحمولة تُرسل كما بُنيت عند الانتهاء: موقع البدء نفسه
  assert.deepEqual(by['3'].payload, { customerId: 'c1', lat: 24.7, lng: 46.6, clientRef: '3' });
});

test('«تُنهى الآن»: زيارة المؤقّت محفوظةٌ حتى تستقرّ — لا تُعرض ولا تُعاد ولا تُعدّ يتيمةً ما دامت الصفحة تُنهيها', () => {
  const rec = { clientRef: 'e1', repId: 'rep1', customerName: 'بقالة', endedAt: '2026-10-06T08:10:00.000Z', payload: { customerId: 'c1', clientRef: 'e1' } };
  beginEnding(rec);
  assert.equal(getPendingVisits()[0].status, 'ending', 'محفوظةٌ قبل القراءة');
  assert.deepEqual(orphanEnding('rep1'), [], 'تُنهيها هذه الصفحة: ليست يتيمة');
  beginEnding({ ...rec, payload: { ...rec.payload, lat: 24.7, lng: 46.6 } });
  assert.equal(getPendingVisits().length, 1, 'إعادة الحفظ بإحداثياتها تستبدل لا تكرّر');
  endEnding('e1');
  assert.deepEqual(getPendingVisits(), [], 'استقرّت فأُزيل سجلّها');
  // صارت حالةً أخرى بالمفتاح نفسه (بانتظار الاتصال / لم تُسجَّل): لا يمسحها الختام
  beginEnding(rec);
  putPendingVisit({ ...rec, status: 'waiting' });
  endEnding('e1');
  assert.equal(getPendingVisits()[0].status, 'waiting');
});

test('يتيمة «تُنهى الآن» (أُغلق التطبيق أثناء القراءة/الرفع): غير المقيَّد ⇒ الصفّ، والمقيَّد بموقع ⇒ بانتظار الاتصال، وبلا موقع ⇒ لم تُسجَّل', async () => {
  const orphan = (clientRef: string, payload: Record<string, unknown>, repId = 'rep1') =>
    ({ clientRef, repId, customerName: 'بقالة', endedAt: '2026-10-06T08:10:00.000Z', status: 'ending' as const, payload });
  // من صفحةٍ سابقة: في المخزن وليست في ذاكرة هذه الصفحة
  store.set('rep_visits_awaiting_net', JSON.stringify([
    orphan('o1', { customerId: 'c1' }), orphan('o2', { customerId: 'c1', lat: 24.7, lng: 46.6 }), orphan('o3', { customerId: 'c1' }, 'rep2'),
  ]));
  assert.deepEqual(orphanEnding('rep1').map(v => v.clientRef), ['o1', 'o2'], 'زيارات صاحب الجلسة وحده');
  const [o1, o2] = orphanEnding('rep1');
  assert.equal(orphanFate(o1, false), 'outbox');
  assert.equal(orphanFate(o2, false), 'outbox');
  assert.equal(orphanFate(o2, true), 'waiting', 'بدأت متصلةً بقراءة: تُرفع حيّةً');
  assert.equal(orphanFate(o1, true), 'failed', 'المقيَّد بلا موقع لا يُرسل');
  assert.equal(orphanFate({ ...o2, payload: { lat: 0, lng: 0 } }, true), 'failed', '(0،0) ليست موقعاً');
  // ويتيمةٌ لا تُعاد بإعادة الرفع (ليست waiting) حتى تُحسم
  const sent: string[] = [];
  await retryPendingVisits(async (p) => { sent.push(String(p.clientRef)); }, 'rep1');
  assert.deepEqual(sent, []);
});

// ───────── حرّاس ثابتون على التنفيذ ─────────

test('حارس ثابت: المقيَّد لا يبدأ مؤقّته إلا متصلاً فعلاً وبقراءة، وغيره يبدأ فوراً والقراءة تلحق', () => {
  const app = read('rep', 'RepApp.tsx');
  const start = app.slice(app.indexOf('const startVisit = async ('), app.indexOf('// نجاة الأيتام'));
  assert.match(start, /if \(strictRef\.current\) \{/);
  assert.match(start, /navigator\.onLine \? await Promise\.all\(\[probeOnline\(\), grabLocation\(true\)\]\) : \[false, null\]/);
  assert.match(start, /const gate = visitGate\(true, online, !!fix\);\s*if \(gate !== 'ok'\) \{ setVisitStart\(\{ customerId: c\.id, state: gate \}\); return; \}/);
  assert.match(start, /begin\(fix\);/);
  assert.match(start, /void grabLocation\(false\)\.then\(\(fix\) => \{\s*const next = attachFix\(getVisitTimer\(\), t, fix\);/);
  assert.match(app, /const strictRef = useRef\(locationRequired\);\s*strictRef\.current = locationRequired;/);
});

test('حارس ثابت: انتهاء المؤقّت يرسل موقع الوصول، والمقيَّد لا يدخل الصفّ ولا يُرسل بلا موقع', () => {
  const app = read('rep', 'RepApp.tsx');
  const fin = app.slice(app.indexOf('const finalizeVisit = async ('), app.indexOf('const closeCustomerDetail'));
  assert.match(fin, /const fix = isGeoFix\(t\.fix\) \? t\.fix : await grabLocation\(strict\);/);
  assert.match(fin, /const payload: Record<string, unknown> = \{ \.\.\.base, \.\.\.fixCoords\(fix\) \};/);
  assert.match(fin, /const base: Record<string, unknown> = \{ \.\.\.custRef, startedAt: t\.startedAt, endedAt, clientDurationSec, clientRef, createdAt: endedAt \};/);
  // محفوظةٌ «تُنهى الآن» قبل أول انتظار، وتُحسم في finally — فلا يُضيعها إغلاق التطبيق أثناء القراءة
  assert.ok(fin.indexOf('beginEnding({ clientRef, repId') < fin.indexOf('await grabLocation(strict)'), 'الحفظ قبل القراءة');
  assert.match(fin, /\} finally \{\s*endEnding\(clientRef\);\s*refreshPendingVisits\(\);\s*\}\s*\};/);
  assert.match(fin, /if \(plan === 'drop'\) \{[\s\S]*?status: 'failed'[\s\S]*?return;\s*\}/);
  assert.match(fin, /const f = visitFailure\('timer', strict, isNetworkError\(err\)\);\s*if \(f === 'outbox'\) \{\s*await outboxAdd\(/);
  assert.match(fin, /else if \(f === 'held'\) \{[\s\S]*?const r = postResultOf\(err\);\s*putPendingVisit\(pendingRetryOutcome\(r\) === 'keep' \? \{ \.\.\.held, status: 'waiting', \.\.\.\(!r\.ok && r\.live \? \{ waitFor: 'location' as const \} : \{\}\) \}/);
  assert.equal((fin.match(/outboxAdd\(/g) || []).length, 1, 'الصفّ من فرع outbox وحده');
  // تُعاد حيّةً: بلا ترويسة إعادة الرفع (الخادم يردّها للمقيَّد)
  assert.match(app, /await retryPendingVisits\(async \(p\) => \{ await repApi\.post\('\/visits', p, \{ background: true \}\); \}, currentRepId\(\)\);/);
  assert.match(app, /: tr\('الزيارة بانتظار الاتصال لتسجيلها'\)\}/);
  // يتامى «تُنهى الآن» تُحسم عند الإقلاع وعودة الشبكة — ولو دون اتصال — قبل إعادة الرفع
  const flush = app.slice(app.indexOf('const flushPendingVisits = useCallback('), app.indexOf('const finalizeVisit = async ('));
  assert.ok(flush.indexOf('orphanEnding(currentRepId())') < flush.indexOf("!navigator.onLine) return;"), 'الحسم قبل شرط الاتصال');
  assert.match(flush, /const fate = orphanFate\(v, strictRef\.current\);/);
  assert.match(flush, /kind: 'visit', payload: v\.payload, status: 'queued'/);
});

test('حارس ثابت: الملاحظة/الصور للمقيَّد — لا حفظ بلا اتصال أو قراءة، ولا صفّ عند الانقطاع', () => {
  const app = read('rep', 'RepApp.tsx');
  const lv = app.slice(app.indexOf('function LogVisit('), app.indexOf('// ============ إنشاء فاتورة'));
  assert.match(lv, /const gate = visitGate\(strict, navigator\.onLine, !!fix\);\s*if \(gate !== 'ok'\) \{ setMsg\(/);
  assert.match(lv, /const f = visitFailure\('note', strict, isNetworkError\(err\)\);\s*if \(f === 'outbox'\) \{/);
  assert.match(lv, /disabled=\{busy \|\| strictGate !== 'ok'\}/);
  // المقيَّد: موقع الملاحظة قراءةٌ حيّة لحظة الحفظ (القفل الكامل)، وغيره قراءة فتح النافذة كما كانت
  assert.match(lv, /const at = strict \? await grabLocation\(true\) : fix;/);
  assert.match(lv, /\.\.\.fixCoords\(at\),/);
  // مفتاحٌ واحد لكل محاولات النموذج: إعادة الحفظ بعد انقطاعٍ بلغ فيه الأولُ الخادمَ لا تكرّر الزيارة
  assert.match(lv, /const clientRefRef = useRef\(newClientRef\(\)\);/);
  assert.match(lv, /const clientRef = clientRefRef\.current;/);
  assert.doesNotMatch(lv, /const clientRef = newClientRef\(\);/);
  assert.match(app, /<LogVisit customer=\{selectedCustomer\} strict=\{locationRequired\}/);
});

test('حارس ثابت: صفّ العمل دون اتصال — رفض الزيارة نهائيّ بلا حلقة، برمزه، بلا «إعادة المحاولة»، ولا حالة «بانتظار الموقع»', () => {
  const sync = read('rep', 'offlineSync.ts');
  assert.ok(sync.includes("status: 'rejected', error: msg || 'رفضه الخادم', rejectCode: code || undefined"));
  assert.doesNotMatch(sync, /awaitLocation|releaseAwaitingVisits/, 'زيارة المقيَّد لا تُحبس لتُطلق لاحقاً من الصفّ');
  assert.doesNotMatch(read('rep', 'offlineDb.ts'), /awaitLocation/);
  const panel = read('rep', 'RepApp.tsx');
  assert.match(panel, /\{!isFinalVisitRejection\(d\) && \(\s*<button onClick=\{\(\) => requeue\(d\.clientRef\)\}/);
});

test('حارس ثابت: الإدارة ترى أين سُجّلت الزيارة — «عرض على الخريطة» يطير إلى الدبّوس، وGoogle، و«بلا موقع» صريحة', () => {
  const t = read('pages', 'TrackingPage.tsx');
  assert.match(t, /<FlyTo target=\{focusVisit\?\.at \?\? null\} \/>/);
  assert.match(t, /map\.flyTo\(target, 17/);
  assert.match(t, /showVisitOnMap\(openVisit, visitDetailQ\.data!\.lat!, visitDetailQ\.data!\.lng!\)/);
  assert.match(t, /href=\{visitMapsUrl\(visitDetailQ\.data\.lat, visitDetailQ\.data\.lng\)\}/);
  assert.match(t, /tr\('موقع تسجيل الزيارة'\)/);
  assert.match(t, /tr\('بلا موقع'\)/);
  assert.match(t, /icon=\{visitIcon\(visitNo\.get\(v\.id\) \?\? 0, focusVisit\?\.id === v\.id\)\}/);
  assert.match(read('m', 'MTracking.tsx'), /tr\('لا موقع مسجل لهذه الزيارة'\)/);
});

test('الترجمة: نصوص الزيارة الجديدة بلغاتها الأربع', () => {
  const keys = [
    'لا تُسجَّل الزيارة دون اتصال بالإنترنت — اتصل ثم أعد المحاولة',
    'تعذر تحديد موقعك اقترب من نافذة او مكان مفتوح ثم اعد المحاولة',
    'موقع الزيارة محفوظ', 'الزيارة بانتظار الاتصال لتسجيلها', 'لم تسجل زيارة', 'لم تسجل الزيارة لتعذر تحديد موقعك', 'رفضها الخادم',
    'فعّل الموقع المباشر وانتظر تحديد موقعك ثم سجّل الزيارة وأنت متصل بالإنترنت',
    'لا تُقبل زيارةٌ سُجّلت دون اتصال بالإنترنت — سجّلها عند العميل وأنت متصل وموقعك مفعّل',
    'عرض على الخريطة', 'خرائط Google', 'موقع تسجيل الزيارة', 'سجلت الزيارة هنا', 'بلا موقع', 'لا موقع مسجل لهذه الزيارة',
  ];
  for (const k of keys) {
    const row = PHRASES[k];
    assert.ok(row, `بلا ترجمة: ${k}`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(row[l] && !/[؀-ۿ]/.test(row[l]), `${k} ← ${l}`);
  }
  // رسائل الخادم كما يرسلها (تُعرض بـtr في شريط «لم تُسجَّل»)
  const server = fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', 'routes', 'visits.ts'), 'utf8');
  for (const k of keys.slice(7, 9)) assert.ok(server.includes(`'${k}'`), `رسالة الخادم تغيّرت: ${k}`);
  // رسالتا الواجهة هما ثابتا RepApp
  const app = read('rep', 'RepApp.tsx');
  assert.ok(app.includes(`const VISIT_OFFLINE_MSG = '${keys[0]}';`));
  assert.ok(app.includes(`const VISIT_NOFIX_MSG = '${keys[1]}';`));
});
